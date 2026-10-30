'use strict';

// The gateway reports only through console.warn. Its state was therefore readable
// nowhere except a shell on the host that runs the process, which is exactly the
// position an operator is in when a Discord message silently does not appear.
//
// These tests pin the observability contract:
//   1. GET /status refuses an anonymous caller. The mount is public because Discord
//      cannot hold a Kikx session; that must not make internal state readable.
//   2. An authenticated caller learns whether a token was found and whether the
//      socket is ready - the two different reasons a message is not delivered.
//   3. Every dispatch decision, INCLUDING a denial, is visible. A denial that exists
//      only as a log line looks identical to a gateway that never delivered anything.
//   4. The bot token never appears in the response body.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../index.mjs';
import { OP } from '../gateway.mjs';

const TOKEN = 'bot-token-secret-value';

class FakeSocket {
  static instances = [];
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  async deliver(payload) {
    for (let fn of this.listeners.get('message') || []) fn({ data: JSON.stringify(payload) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

class FakePluginInterface {}

function buildPlugin({ token = null, allowed = true, viewer = null } = {}) {
  let state = { authorizations: [], frames: [], handler: null, mountOptions: null };

  let db = () => ({
    async one(sql) {
      if (/discord_channel_session/.test(sql)) return { session_id: 'session-1' };
      return null;
    },
    async query() { return { rowCount: 1 }; },
  });

  let context = {
    registry: { getClass: () => FakePluginInterface, registerTool: () => {} },
    registerMigrations: () => {},
    mountHttp: (handler, options) => {
      state.handler = handler;
      state.mountOptions = options;
      return '/api/plugins/discord/';
    },
    authorize: async (request) => {
      state.authorizations.push(request);
      return allowed
        ? { allowed: true }
        : { allowed: false, reason: 'no grant for discord.inbound' };
    },
    db,
    appendToSession: async (sessionID, input) => {
      state.frames.push({ sessionID, input });
      return { session: { id: sessionID }, frame: { id: 'frame-1' } };
    },
    appendToSessionQuietly: async () => ({ frame: { id: 'frame-1' } }),
    readConfig: async (path) => {
      if (path === '/kikx/discord/bot/token') return token;
      return null;
    },
    // Core resolves identity only for non-public mounts, so the route asks the account
    // store directly. A null viewer models a request with no session cookie.
    accountStore: { resolveIdentity: async () => viewer },
  };

  let plugin = null;
  setup((provide) => { plugin = provide(context); });

  async function getStatus(options = {}) {
    let status = null;
    let payload = null;
    let response = {
      writeHead(code) { status = code; },
      end(text) { payload = text ? JSON.parse(text) : null; },
      get headersSent() { return status !== null; },
    };

    await state.handler({
      request: { method: options.method || 'GET', headers: {}, url: '/api/plugins/discord/status' },
      response,
      rawBody: Buffer.alloc(0),
      json: () => null,
      subPath: '/status',
      context,
      identity: options.identity,
    });

    return { status, body: payload };
  }

  return { state, plugin, getStatus };
}

async function withFakeNetwork(fn) {
  let savedWebSocket = globalThis.WebSocket;
  let savedFetch = globalThis.fetch;
  FakeSocket.instances = [];
  globalThis.WebSocket = class extends FakeSocket {};
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ url: 'wss://gateway.test' }) });
  try {
    return await fn();
  } finally {
    globalThis.WebSocket = savedWebSocket;
    globalThis.fetch = savedFetch;
  }
}

test('GET /status refuses an anonymous caller', async () => {
  let { getStatus } = buildPlugin({ token: TOKEN, viewer: null });
  let { status, body } = await getStatus();
  assert.equal(status, 401, 'a public mount must not expose gateway state anonymously');
  assert.match(body.error.message, /sign in required/i);
});

test('an authenticated caller sees that no token was configured, and that it is not connected', async () => {
  let { plugin, getStatus } = buildPlugin({ token: null, viewer: { id: 'admin' } });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let { status, body } = await getStatus({ identity: { id: 'admin' } });
    assert.equal(status, 200);
    // The two distinct reasons a Discord message does not arrive must be distinguishable.
    assert.equal(body.tokenPresent, false, 'no token is a configuration problem');
    assert.equal(body.connected, false);
  });
});

test('after READY it reports connected, the bot user id, and the token presence', async () => {
  let { plugin, getStatus } = buildPlugin({ token: TOKEN, viewer: { id: 'admin' } });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let socket = FakeSocket.instances[0];
    await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
    await socket.deliver({ op: OP.DISPATCH, t: 'READY', s: 1, d: { user: { id: 'bot-9', username: 'miri' }, session_id: 'gw-1' } });

    let { status, body } = await getStatus({ identity: { id: 'admin' } });
    assert.equal(status, 200);
    assert.equal(body.tokenPresent, true);
    assert.equal(body.connected, true, 'a READY socket must be reported as connected');
    assert.equal(body.gateway.userId, 'bot-9');
    plugin.onShutdown();
  });
});

test('a DENIED inbound message is visible in the status, with its reason', async () => {
  // This is the case that motivated the route: a real message arrived, the gate said no,
  // and the only trace was a console.warn nobody could reach.
  let { plugin, getStatus } = buildPlugin({ token: TOKEN, allowed: false, viewer: { id: 'admin' } });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let socket = FakeSocket.instances[0];
    await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
    await socket.deliver({ op: OP.DISPATCH, t: 'READY', s: 1, d: { user: { id: 'bot-9' }, session_id: 'gw-1' } });

    let warn = console.warn;
    console.warn = () => {};
    try {
      await socket.deliver({
        op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2,
        d: { id: 'msg-9', channel_id: 'chan-1', content: 'hello', type: 0, author: { id: 'u1', username: 'wyatt' } },
      });
    } finally {
      console.warn = warn;
    }

    let { body } = await getStatus({ identity: { id: 'admin' } });
    assert.equal(body.lastDispatchType, 'MESSAGE_CREATE', 'the dispatch must be recorded');
    let last = body.recentOutcomes.at(-1);
    assert.equal(last.handled, false);
    assert.equal(last.reason, 'not_authorized');
    assert.equal(last.channelID, 'chan-1');
    assert.equal(last.actorID, 'u1');
    assert.match(last.detail, /no grant for discord.inbound/);
    plugin.onShutdown();
  });
});

test('the bot token never appears in the status body', async () => {
  let { plugin, getStatus } = buildPlugin({ token: TOKEN, viewer: { id: 'admin' } });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let { body } = await getStatus({ identity: { id: 'admin' } });
    assert.ok(!JSON.stringify(body).includes(TOKEN), 'a token in a status body is a token in a log');
    plugin.onShutdown();
  });
});

test('the interactions mount stays public, because Discord cannot hold a Kikx session', async () => {
  // Guards the opposite mistake: locking the whole mount down would 401 Discord itself.
  let { state } = buildPlugin({ token: TOKEN });
  assert.equal(state.mountOptions?.auth, 'public');
});
