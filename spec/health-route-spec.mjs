'use strict';

// The gateway reported only through console.warn, and /status answers only an
// authenticated caller - so a deploy that shipped a token-less transport passed
// every gate and announced success. 3098 ran five hours without a bot, the only
// evidence one buried startup log line.
//
// This spec pins the deploy-gate contract:
//   1. GET /health answers an ANONYMOUS caller (a monitor holds no Kikx session).
//   2. No token -> ok:true with gatewayState 'no-token': route alive, transport not.
//   3. After READY -> 'ready' plus the bot user id.
//   4. The gateway off-switch -> 'disabled', not a mystery.
//   5. The bot token never appears in the body.

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

function buildPlugin({ token = null, enabled = undefined } = {}) {
  let state = { handler: null, mountOptions: null, frames: [] };

  let db = () => ({
    async one(sql) {
      if (/discord_channel_session/.test(sql)) return { session_id: 'session-1' };
      return null;
    },
    async query() { return { rowCount: 1 }; },
  });

  let context = {
    registry: { getClass: () => FakePluginInterface, registerTool: () => {}, registerClass: () => {}, registerFrameComponent: () => {} },
    registerMigrations: () => {},
    mountHttp: (handler, options) => {
      state.handler = handler;
      state.mountOptions = options;
      return '/api/plugins/discord/';
    },
    authorize: async () => ({ allowed: true }),
    db,
    appendFrame: async (sessionID, input) => {
      state.frames.push({ sessionID, input });
      return { session: { id: sessionID }, frame: { id: 'frame-1' } };
    },
    appendToSessionQuietly: async () => ({ frame: { id: 'frame-1' } }),
    readConfig: async (path) => {
      if (path === '/kikx/discord/bot/token') return token;
      if (path === '/kikx/discord/public/key') return null;
      if (path === '/kikx/discord/gateway/enabled') return enabled;
      return null;
    },
    // resolveIdentity always returns null: if the health route ever consults
    // identity the way /status does, it 401s and test 1 fails.
    accountStore: { resolveIdentity: async () => null },
  };

  let plugin = null;
  setup((provide) => { plugin = provide(context); });

  async function getHealth() {
    let code = null;
    let payload = null;
    let response = {
      writeHead(c) { code = c; },
      end(t) { payload = t ? JSON.parse(t) : null; },
      get headersSent() { return code !== null; },
    };

    await state.handler({
      request: { method: 'GET', headers: {}, url: '/api/plugins/discord/health' },
      response,
      rawBody: Buffer.alloc(0),
      json: () => null,
      subPath: '/health',
      context,
      identity: undefined,
    });

    return { status: code, body: payload };
  }

  return { state, plugin, getHealth };
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

async function withQuietWarnings(fn) {
  let warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

test('GET /health answers an anonymous caller - a monitor holds no Kikx session', async () => {
  let { plugin, getHealth } = buildPlugin({ token: null });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let { status, body } = await getHealth();
    assert.equal(status, 200, 'no identity may be required to read transport health');
    assert.equal(body.ok, true);
    assert.equal(body.gatewayState, 'no-token');
    assert.equal(body.tokenPresent, false, 'a token-less transport must be NAMED, not look healthy');
    assert.equal(body.connected, false);
  });
});

test('after READY the health route reports ready with the bot user id', async () => {
  let { plugin, getHealth } = buildPlugin({ token: TOKEN });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let socket = FakeSocket.instances[0];
    await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
    await socket.deliver({ op: OP.DISPATCH, t: 'READY', s: 1, d: { user: { id: 'bot-9', username: 'miri' }, session_id: 'gw-1' } });

    let { status, body } = await getHealth();
    assert.equal(status, 200);
    assert.equal(body.gatewayState, 'ready');
    assert.equal(body.connected, true);
    assert.equal(body.botUserId, 'bot-9');
    plugin.onShutdown();
  });
});

test('the gateway off-switch is reported as disabled, not as a mystery', async () => {
  let { plugin, getHealth } = buildPlugin({ token: TOKEN, enabled: false });
  await withFakeNetwork(async () => {
    await withQuietWarnings(() => plugin.onInit());
    let { body } = await getHealth();
    assert.equal(body.gatewayState, 'disabled');
    assert.equal(body.connected, false);
    assert.equal(body.tokenPresent, true, 'the token exists; it is the switch that is off');
  });
});

test('the bot token never appears in the health body', async () => {
  let { plugin, getHealth } = buildPlugin({ token: TOKEN });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let { body } = await getHealth();
    assert.ok(!JSON.stringify(body).includes(TOKEN), 'a token in a health body is a token in a log');
    plugin.onShutdown();
  });
});
