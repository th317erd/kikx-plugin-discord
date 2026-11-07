'use strict';

// =============================================================================
// Per-channel bot identity: each bound channel speaks with ITS bot's token.
// =============================================================================
// What this proves, from the REAL setup() entry point:
//   1. The compose env key for a per-bot token is what core's envKeyFor actually
//      derives — the case-join (KIKX_DISCORD_BOTS_AURI_TOKEN) was an unverified
//      assumption until this test ran the real function.
//   2. discord:send to a channel bound to bot_key 'squeak' leaves with
//      `Authorization: Bot <squeak's token>` — and NOT with the legacy token,
//      which is deliberately configured too. That is the negative control: a
//      single-token implementation (the pre-multi-bot wiring, readConfig(tokenPath)
//      straight through) would pass the legacy token and fail these assertions.
//   3. Channels with no bot_key, and bot keys with no configured token, fall back
//      to the legacy token: an instance that configures nothing keeps its old
//      behaviour byte for byte.
//   4. An inbound message driven through the real gateway path records the
//      binding and scopes the typing subscription to exactly that session.
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { setup } from '../index.mjs';

const LEGACY_TOKEN = 'legacy-bot-token';
const SQUEAK_TOKEN = 'squeak-bot-token';
const CHANNEL = '1563247178565029988';   // the fleet's #squeak channel
const ACTOR = 'discord:255524600249581568';

// --- envKeyFor proof ---------------------------------------------------------

const CORE_PROPERTY_PATH = fileURLToPath(
  new URL('../../wt-parity/src/core/config/property-path.mjs', import.meta.url));

test('envKeyFor derives the compose env key for a per-bot token path (case-join proof)', async (t) => {
  if (!existsSync(CORE_PROPERTY_PATH)) {
    t.skip('wt-parity checkout not present beside the plugin repo; run from kikx-workspace');
    return;
  }
  let { envKeyFor } = await import(CORE_PROPERTY_PATH);

  // THE mapping compose must carry. If core's derivation ever changes, this test
  // fails before an operator writes an .env key the process cannot see.
  assert.equal(envKeyFor('/kikx/discord/bots/auri/token'), 'KIKX_DISCORD_BOTS_AURI_TOKEN');
  assert.equal(envKeyFor('/kikx/discord/bots/squeak/token'), 'KIKX_DISCORD_BOTS_SQUEAK_TOKEN');
  assert.equal(envKeyFor('/kikx/discord/bots/sans/token'), 'KIKX_DISCORD_BOTS_SANS_TOKEN');
  assert.equal(envKeyFor('/kikx/discord/bots/miri/token'), 'KIKX_DISCORD_BOTS_MIRI_TOKEN');
  // And the legacy key stays what the deployed atlas compose already carries.
  assert.equal(envKeyFor('/kikx/discord/bot/token'), 'KIKX_DISCORD_BOT_TOKEN');
});

// --- harness -----------------------------------------------------------------

class FakePluginInterface {
  static pluginID = 'unknown';
  static riskLevel = 'none';
  constructor(context) { this.context = context; }
  async execute(params = {}) { return await this._execute(params); }
}

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
}

function buildPlugin({
  grants = new Set(['discord.send', 'discord.read', 'discord.inbound', 'discord.react']),
  config = {},
  bindings = [],
  bindingRow = { session_id: 'session-1' },
  gatewayEnabled = false,
  dbReadyGate = null,                // () => bool; false reproduces the pool-not-ready startup window
  hasPluginMigrations = false,       // expose the plugin-migrations context the real create-server sets
  pluginMigrationsPool = null,       // () => pool|null — null reproduces a pool migrations have not created yet
} = {}) {
  let registry = { tools: new Map() };
  registry.registerTool = (name, cls) => registry.tools.set(name, cls);
  registry.getTool = (name) => registry.tools.get(name) || null;
  registry.getClass = (name) => (name === 'PluginInterface'
    ? FakePluginInterface
    : name === 'FrameTypeUserMessage'
      ? class FrameTypeUserMessage {}
      : null);
  registry.registerClass = () => {};
  registry.registerFrameComponent = () => {};

  let captured = {
    authorizations: [], configReads: [], queries: [], frames: [],
    subscribes: [],
  };

  let db = () => ({
    async one(sql, params) {
      if (dbReadyGate && !dbReadyGate())
        throw new Error(`Cannot read properties of null (reading 'query')`);
      captured.queries.push({ sql, params });
      if (/discord_channel_session/.test(sql)) return bindingRow;
      if (/FROM discord_message_frame/.test(sql)) return null;
      return null;
    },
    async query(sql, params) {
      if (dbReadyGate && !dbReadyGate())
        throw new Error(`Cannot read properties of null (reading 'query')`);
      captured.queries.push({ sql, params });
      if (/SELECT channel_id, session_id, bot_key/.test(sql))
        return { rows: bindings };
      if (/INSERT INTO discord_message_frame/.test(sql)) return { rowCount: 1 };
      return { rowCount: 1 };
    },
  });

  let configValues = {
    '/kikx/discord/bot/token': LEGACY_TOKEN,
    '/kikx/discord/bots/squeak/token': SQUEAK_TOKEN,
    '/kikx/discord/gateway/enabled': gatewayEnabled,
    ...config,
  };

  let context = {
    context: {
      has: (name) => (name === 'pluginMigrations' && hasPluginMigrations),
      require: (name) => (name === 'pluginMigrations' && pluginMigrationsPool
        ? { pool: pluginMigrationsPool() }
        : null),
    },
    registry,
    mountHttp: () => {},
    authorize: async (request) => {
      captured.authorizations.push(request);
      return grants.has(request?.action)
        ? { allowed: true }
        : { allowed: false, reason: `no grant for ${request?.action}` };
    },
    db,
    registerMigrations: () => {},
    appendToSession: async () => ({}),
    appendFrame: async (sessionID, input) => {
      captured.frames.push({ sessionID, input });
      return { session: { id: sessionID }, frame: { id: 'frame-1' } };
    },
    appendToSessionQuietly: async () => ({}),
    readConfig: async (path) => {
      captured.configReads.push(path);
      return configValues[path] ?? null;
    },
    subscribe: (handler, options) => {
      captured.subscribes.push({ handler, options });
      return true;
    },
  };

  let plugin = null;
  setup((provide) => { plugin = provide(context); });
  return { registry, captured, plugin };
}

// Loads the binding maps the way the real entry does: onInit with the gateway
// off-switch on (refreshInboundConfig runs, then gatewayLoop returns before any
// socket — order proved in index.mjs gatewayLoop: token -> refresh -> enabled).
async function primed(options = {}) {
  let built = buildPlugin(options);
  await built.plugin.onInit();
  return built;
}

async function runTool(ToolClass, params, fetchImpl) {
  let tool = new ToolClass({});
  let original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await tool.execute(params);
  } finally {
    globalThis.fetch = original;
  }
}

function recorder(responder = () => ({ ok: true, status: 200, json: async () => ({ id: 'm1' }) })) {
  let requests = [];
  let fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
    return responder(String(url), init);
  };
  return { fetchImpl, requests };
}

// --- the identity tests ------------------------------------------------------

test('a channel bound to bot_key answers as THAT bot — never as the legacy token', async () => {
  // Both tokens are configured. If tokenForChannel were bypassed (the single-token
  // wiring this feature replaces), the Authorization header would read the legacy
  // token and this assertion would fail. That IS the negative control.
  let { registry } = await primed({
    bindings: [{ channel_id: CHANNEL, session_id: 'session-1', bot_key: 'squeak' }],
  });
  let { fetchImpl, requests } = recorder();

  let result = await runTool(registry.getTool('discord:send'),
    { actor: ACTOR, channel: CHANNEL, content: 'squeak says hi' }, fetchImpl);

  assert.equal(result.sent, true, JSON.stringify(result));
  let post = requests.find((r) => r.method === 'POST');
  assert.ok(post, 'a send must POST a message');
  assert.equal(post.headers.Authorization, `Bot ${SQUEAK_TOKEN}`);
  assert.notEqual(post.headers.Authorization, `Bot ${LEGACY_TOKEN}`,
    'a single-token implementation would put the legacy identity here');
});

test('a channel with no bot_key binding answers with the legacy token (legacy-safe default)', async () => {
  let { registry } = await primed({ bindings: [] });   // migration default 'default'
  let { fetchImpl, requests } = recorder();

  let result = await runTool(registry.getTool('discord:send'),
    { actor: ACTOR, channel: '1471361561955143773', content: 'hello' }, fetchImpl);

  assert.equal(result.sent, true, JSON.stringify(result));
  let post = requests.find((r) => r.method === 'POST');
  assert.equal(post.headers.Authorization, `Bot ${LEGACY_TOKEN}`);
});

test('a bot key with no configured token falls back to the legacy token, honestly labelled', async () => {
  let { registry } = await primed({
    config: { '/kikx/discord/bots/squeak/token': null },
    bindings: [{ channel_id: CHANNEL, session_id: 'session-1', bot_key: 'squeak' }],
  });
  let { fetchImpl, requests } = recorder();

  let result = await runTool(registry.getTool('discord:send'),
    { actor: ACTOR, channel: CHANNEL, content: 'hi' }, fetchImpl);

  assert.equal(result.sent, true, JSON.stringify(result));
  assert.equal(requests.find((r) => r.method === 'POST').headers.Authorization,
    `Bot ${LEGACY_TOKEN}`);
});

test('no token anywhere is reported, not faked as a send', async () => {
  let { registry } = await primed({
    config: { '/kikx/discord/bot/token': null, '/kikx/discord/bots/squeak/token': null },
    bindings: [{ channel_id: CHANNEL, session_id: 'session-1', bot_key: 'squeak' }],
  });
  let { fetchImpl, requests } = recorder();

  let result = await runTool(registry.getTool('discord:send'),
    { actor: ACTOR, channel: CHANNEL, content: 'hi' }, fetchImpl);

  assert.equal(result.sent, false);
  assert.equal(result.pending, 'no-bot-token');
  assert.match(result.note, /channel/);
  assert.equal(requests.length, 0, 'nothing may leave the machine without a token');
});

test('channel-scoped reads use the channel\u2019s token; guild-scoped reads use the default', async () => {
  let { registry } = await primed({
    bindings: [{ channel_id: CHANNEL, session_id: 'session-1', bot_key: 'squeak' }],
  });

  // Channel-scoped: the bound bot reads its own channel.
  let channelRead = recorder(() => ({ ok: true, status: 200, json: async () => [] }));
  await runTool(registry.getTool('discord:list_messages'),
    { actor: ACTOR, channel: CHANNEL }, channelRead.fetchImpl);
  assert.equal(channelRead.requests[0].headers.Authorization, `Bot ${SQUEAK_TOKEN}`);

  // Guild-scoped: no channel key exists, so the default (legacy) token answers —
  // all fleet bots share one guild today.
  let guildRead = recorder(() => ({ ok: true, status: 200, json: async () => [] }));
  await runTool(registry.getTool('discord:list_channels'),
    { actor: ACTOR, guild: '255525418558291969' }, guildRead.fetchImpl);
  assert.equal(guildRead.requests[0].headers.Authorization, `Bot ${LEGACY_TOKEN}`);
});

test('a reaction is placed by the bot that owns the channel', async () => {
  let { registry } = await primed({
    bindings: [{ channel_id: CHANNEL, session_id: 'session-1', bot_key: 'squeak' }],
  });
  let { fetchImpl, requests } = recorder(() => ({ ok: true, status: 204 }));

  let result = await runTool(registry.getTool('discord:react'),
    { actor: ACTOR, channel: CHANNEL, message_id: '42', emoji: '\u{1F44D}' }, fetchImpl);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests[0].headers.Authorization, `Bot ${SQUEAK_TOKEN}`);
});

// --- the typing subscription, reached from the real gateway path --------------

test('an inbound message records the binding and scopes the typing subscription to that session', async () => {
  let { captured, plugin } = buildPlugin({
    gatewayEnabled: true,
    config: { '/kikx/discord/bot/token': LEGACY_TOKEN },
    bindings: [{ channel_id: CHANNEL, session_id: 'session-1', bot_key: 'squeak' }],
  });

  let savedWebSocket = globalThis.WebSocket;
  let savedFetch = globalThis.fetch;
  FakeSocket.instances = [];
  globalThis.WebSocket = class extends FakeSocket {};
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ url: 'wss://gateway.test' }) });
  try {
    await plugin.onInit();
    let socket = FakeSocket.instances[0];
    assert.ok(socket, 'onInit must dial the gateway');
    await socket.deliver({ op: 10, d: { heartbeat_interval: 41250 } });
    await socket.deliver({
      op: 0, t: 'READY', s: 1,
      d: { user: { id: 'bot-9', username: 'fleet' }, session_id: 'gw' },
    });
    await socket.deliver({
      op: 0, t: 'MESSAGE_CREATE', s: 2,
      d: {
        id: 'msg-token-1', channel_id: CHANNEL, content: 'anyone there?', type: 0,
        author: { id: 'u1', username: 'wyatt', bot: false },
      },
    });
  } finally {
    globalThis.WebSocket = savedWebSocket;
    globalThis.fetch = savedFetch;
  }

  assert.equal(captured.frames.length, 1, 'the message must be framed');
  // THE typing wiring: one subscription, scoped to exactly the bound session.
  // An unscoped or missing subscription receives nothing at all
  // (plugin-events.mjs #dispatch: allowed === null continues past every event).
  assert.equal(captured.subscribes.length, 1,
    'the typing indicator must subscribe exactly once per bound session');
  assert.deepEqual(captured.subscribes[0].options.sessions, ['session-1'],
    'the subscription must be scoped to the bound session');

  // The reply-hint gate ran through the same authorize() the send tool uses.
  let sendChecks = captured.authorizations.filter((a) => a.action === 'discord.send');
  assert.equal(sendChecks.length, 1, 'the hint gate must be consulted once per frame');
  assert.deepEqual(sendChecks[0].scope, { channel: CHANNEL });
  assert.equal(sendChecks[0].actor, 'discord:u1');

  // The hint rode in the framed text — the only place the model can see it.
  let [first, ...rest] = captured.frames[0].input.text.split('\n');
  assert.equal(first, '[discord:wyatt] anyone there?');
  assert.match(rest.join('\n'), /^\[kikx:reply-hint\]/);
  assert.match(rest.join('\n'), /discord_send/);
  assert.match(rest.join('\n'), new RegExp(CHANNEL));
});

// --- ordering reproduction: onInit ran before the pool existed ---------------
// The atlas defect, end to end, from the real setup() entry point: startup
// refreshInboundConfig() ran while the plugin DB pool was still null (migrations
// applied AFTER it), nothing on the gateway path reloaded the maps, and every
// fleet channel would have resolved the LEGACY token. Freshness now lives in
// tokenForChannel(), so a binding row that exists only after that failed startup
// load is still believed — no restart and no inbound message required.
test('recovers when the startup binding load ran before the database was ready (ordering reproduction)', async () => {
  let dbReady = false;               // production at 03:18:16: pool still null
  let built = buildPlugin({
    bindings: [{ channel_id: CHANNEL, session_id: 'session-1', bot_key: 'squeak' }],
    dbReadyGate: () => dbReady,
  });

  // Prove the reproduction actually happened: startup load FAILED, maps empty.
  let warnings = [];
  let savedWarn = console.warn;
  console.warn = (msg) => { warnings.push(String(msg)); };
  try {
    await built.plugin.onInit();     // gateway off: refresh runs, load FAILS, no socket
  } finally {
    console.warn = savedWarn;
  }
  assert.ok(warnings.some((w) => /could not load channel-to-bot bindings/.test(w)),
    'the startup load must fail exactly like production: ' + JSON.stringify(warnings));

  dbReady = true;                    // migrations + pool ready — atlas after 03:18:16

  // No refreshInboundConfig() runs on the ordinary send path — the exact
  // condition the fix must survive. The send itself performs the reload.
  let { fetchImpl, requests } = recorder();
  let result = await runTool(built.registry.getTool('discord:send'),
    { actor: ACTOR, channel: CHANNEL, content: 'after pool ready' }, fetchImpl);

  assert.equal(result.sent, true, JSON.stringify(result));
  let post = requests.find((r) => r.method === 'POST');
  assert.ok(post, 'a send must POST a message');
  assert.equal(post.headers.Authorization, `Bot ${SQUEAK_TOKEN}`,
    'the channel must answer as ITS bot even though the startup load failed — '
    + 'a legacy token here means the maps were never reloaded (the atlas defect)');
  assert.notEqual(post.headers.Authorization, `Bot ${LEGACY_TOKEN}`,
    'legacy here means identity resolved from the stale, never-loaded map');
});


// --- boot ordering: the first load ran before the migration pool existed -------
// Kink 2 (Avatar, 2026-11-07): every boot logs
// "[discord] could not load channel-to-bot bindings: Cannot read properties of
// null (reading 'query')" — create-server wraps the plugin database as
// { query: (...a) => pluginMigrations.pool.query(...) }, and pool is created
// lazily by migrations run(), so the handle EXISTS while dereferencing it throws
// until boot passes that point. The 0cb2fdd retry guard contains this (warn once,
// recover at the next identity decision); this test pins the source fix: the
// first load WAITS for the migration pool, so boot neither fails nor warns.
test('the startup load waits for the migration pool — no failure, no warning', async () => {
  let dbReady = false;
  let built = buildPlugin({
    bindings: [{ channel_id: CHANNEL, session_id: 'session-1', bot_key: 'squeak' }],
    dbReadyGate: () => dbReady,
    hasPluginMigrations: true,
    pluginMigrationsPool: () => (dbReady ? {} : null),
  });

  let warnings = [];
  let savedWarn = console.warn;
  console.warn = (msg) => { warnings.push(String(msg)); };
  let initDone = false;
  try {
    let init = built.plugin.onInit().then(() => { initDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(initDone, false,
      'onInit must WAIT for the pool — returning first is how boot lost the load');
    assert.ok(!warnings.some((w) => /could not load channel-to-bot bindings|not loaded yet/.test(w)),
      'nothing may warn while the pool is about to exist: ' + JSON.stringify(warnings));
    dbReady = true;
    await init;
  } finally {
    console.warn = savedWarn;
  }

  // The maps were loaded on that first, waited-for attempt — the answer is the
  // channel's own bot with no reload required along the way.
  let { fetchImpl, requests } = recorder();
  let result = await runTool(built.registry.getTool('discord:send'),
    { actor: ACTOR, channel: CHANNEL, content: 'first load waited' }, fetchImpl);
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.equal(requests.find((r) => r.method === 'POST').headers.Authorization, `Bot ${SQUEAK_TOKEN}`,
    'the waited-for first load must have populated the maps with the real bot_key');
});
