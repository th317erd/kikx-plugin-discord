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


// Kink 4bb55fb993b92ea07f26380b (Avatar, 2026-11-07), reproduced at the route
// boundary: atlas booted 2026-11-06T14:11:50Z, its last "gateway ready as" log
// line predates the 06:06Z sample by hours, reconnect attempts reached 9 — yet
// lastDispatchAt read 05:02:07Z. /health answered connecting/connected:false the
// whole time. Cause: a close clears `ready`, the RESUME path never restores it
// (Discord answers RESUMED, not a second READY), and status() did not expose the
// socket. This test drives that exact sequence through the real route.
test('after a close and a RESUME the health route reports ready again — not a frozen connecting', async () => {
  let { plugin, getHealth } = buildPlugin({ token: TOKEN });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let first = FakeSocket.instances[0];
    await first.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
    await first.deliver({ op: OP.DISPATCH, t: 'READY', s: 1, d: { user: { id: 'bot-9', username: 'miri' }, session_id: 'gw-1', resume_gateway_url: 'wss://resume.test' } });

    // The atlas event: an abnormal close clears the session flag. The fake has no
    // fire() helper, so the registered close listener is driven directly — exactly
    // what the real socket would do.
    let savedWarn = console.warn;
    console.warn = () => {};
    try {
      for (let fn of first.listeners.get('close') || []) fn({ code: 1006 });
    } finally {
      console.warn = savedWarn;
    }
    let mid = await getHealth();
    assert.equal(mid.body.connected, false, 'a closed socket must not read as connected');

    // Backoff elapses (real timers here: [500,1000]ms at attempt 0) and the client
    // redials, resumes, and Discord answers RESUMED.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    let second = FakeSocket.instances[FakeSocket.instances.length - 1];
    assert.ok(second && second !== first, 'the reconnect must have produced a new socket');
    await second.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
    let resume = second.sent.filter((p) => p.op === OP.RESUME);
    assert.equal(resume.length, 1, 'the session must be resumed, not re-identified');
    await second.deliver({ op: OP.DISPATCH, t: 'RESUMED', s: 43, d: {} });

    let { body } = await getHealth();
    assert.equal(body.gatewayState, 'ready',
      'a resumed session is a ready session — connecting here is the frozen-flag bug');
    assert.equal(body.connected, true);
    assert.equal(body.socketOpen, true, 'the live socket must be re-read at poll time');
    assert.equal(body.reconnectAttempt, 0, 'a successful resume resets the backoff');
    plugin.onShutdown();
  });
});
