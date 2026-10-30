'use strict';

// Integration proof for the plugin ENTRY POINT.
//
// gateway-spec.mjs and inbound-router-spec.mjs prove those modules work. They do not
// prove the plugin ever calls them: for a while index.mjs imported neither, shipped a
// stub that logged "implementation pending", and 24 green tests said nothing about it.
//
// This spec drives setup() -> onInit() for real, with a fake socket installed as
// globalThis.WebSocket so no network is touched, and asserts three things a user can
// observe: the mount is public (Discord can reach it), onInit dials the gateway and
// IDENTIFYs, and an inbound MESSAGE_CREATE becomes a frame in the bound session.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../index.mjs';
import { OP } from '../gateway.mjs';

class FakeSocket {
  static instances = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
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
  payloads(op) { return this.sent.filter((p) => p.op === op); }
}

// A PluginInterface stand-in: the plugin only subclasses it and registers a tool.
class FakePluginInterface {}

function buildPlugin({ token = null, binding = { session_id: 'session-1' } } = {}) {
  let captured = { mounts: [], migrations: [], tools: [], frames: [], queries: [] };

  let db = () => ({
    async one(sql, params) {
      captured.queries.push({ sql, params });
      if (/discord_channel_session/.test(sql)) return binding;
      if (/FROM discord_message_frame/.test(sql)) return null;   // nothing seen yet
      return null;
    },
    async query(sql, params) { captured.queries.push({ sql, params }); return { rowCount: 1 }; },
  });

  let context = {
    registry: {
      getClass: () => FakePluginInterface,
      registerTool: (name) => captured.tools.push(name),
    },
    registerMigrations: (options) => captured.migrations.push(options),
    mountHttp: (handler, options) => {
      captured.mounts.push({ handler, options });
      return '/api/plugins/discord/';
    },
    authorize: async () => ({ allowed: false, reason: 'not used in this spec' }),
    db,
    appendToSession: async (sessionID, input) => {
      captured.frames.push({ sessionID, input });
      return { session: { id: sessionID }, frame: { id: 'frame-1' } };
    },
    appendToSessionQuietly: async () => ({ frame: { id: 'frame-1' } }),
    readConfig: async (path) => {
      if (path === '/kikx/discord/bot/token') return token;
      if (path === '/kikx/discord/public/key') return null;
      return null;
    },
  };

  let plugin = null;
  setup((provide) => { plugin = provide(context); });
  return { plugin, captured };
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

test('the interactions mount is public, because Discord cannot hold a Kikx session', () => {
  let { captured } = buildPlugin();
  assert.equal(captured.mounts.length, 1, 'expected exactly one HTTP mount');
  // Default is 'required'; a signed webhook with no cookie would get 401 forever.
  assert.equal(captured.mounts[0].options?.auth, 'public');
});

test('the plugin still registers its tool and migrations', () => {
  let { captured } = buildPlugin();
  assert.deepEqual(captured.tools, ['discord:send']);
  assert.equal(captured.migrations.length, 1);
});

test('onInit refuses honestly and dials nothing when there is no bot token', async () => {
  let { plugin } = buildPlugin({ token: null });
  let warnings = [];
  let log = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await withFakeNetwork(async () => {
      await plugin.onInit();
      assert.equal(FakeSocket.instances.length, 0, 'no socket may be opened without a token');
    });
  } finally {
    console.warn = log;
  }
  assert.ok(
    warnings.some((w) => /no bot token configured/.test(w)),
    `expected an honest refusal, got ${JSON.stringify(warnings)}`,
  );
});

test('onInit dials the gateway and IDENTIFYs with a token', async () => {
  let { plugin } = buildPlugin({ token: 'bot-token-123' });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    assert.equal(FakeSocket.instances.length, 1, 'onInit must open exactly one socket');
    let socket = FakeSocket.instances[0];
    await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
    let identify = socket.payloads(OP.IDENTIFY);
    assert.equal(identify.length, 1, 'HELLO must be answered with IDENTIFY');
    assert.equal(identify[0].d.token, 'bot-token-123');
    plugin.onShutdown();
  });
});

test('an inbound MESSAGE_CREATE is framed into the bound session', async () => {
  let { plugin, captured } = buildPlugin({ token: 'bot-token-123' });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let socket = FakeSocket.instances[0];
    await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
    await socket.deliver({ op: OP.DISPATCH, t: 'READY', s: 1, d: { user: { id: 'bot-9', username: 'miri' }, session_id: 'gw-session' } });
    await socket.deliver({
      op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2,
      d: { id: 'msg-1', channel_id: 'chan-1', content: 'hello miri', type: 0, author: { id: 'u1', username: 'wyatt' } },
    });
    assert.equal(captured.frames.length, 1, 'the message must reach appendToSession');
    assert.equal(captured.frames[0].sessionID, 'session-1');
    assert.match(captured.frames[0].input.text, /^\[discord:wyatt\] hello miri$/);
    // And the mapping row is written so an edit can find the frame later.
    assert.ok(captured.queries.some((q) => /INSERT INTO discord_message_frame/.test(q.sql)));
    plugin.onShutdown();
  });
});

test('the bot does not frame its own messages, so a reply cannot become its own input', async () => {
  let { plugin, captured } = buildPlugin({ token: 'bot-token-123' });
  await withFakeNetwork(async () => {
    await plugin.onInit();
    let socket = FakeSocket.instances[0];
    await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
    await socket.deliver({ op: OP.DISPATCH, t: 'READY', s: 1, d: { user: { id: 'bot-9', username: 'miri' }, session_id: 'gw-session' } });
    await socket.deliver({
      op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2,
      d: { id: 'msg-2', channel_id: 'chan-1', content: 'my own reply', type: 0, author: { id: 'bot-9', username: 'miri' } },
    });
    assert.equal(captured.frames.length, 0, 'own messages must not be framed');
    plugin.onShutdown();
  });
});
