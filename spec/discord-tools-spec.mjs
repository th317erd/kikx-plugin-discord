'use strict';

// The read / react / file tools must be REACHABLE from the real entry point,
// not merely correct in isolation — the defect shape this plugin keeps
// producing. So this file drives setup() and executes the registered classes
// through execute(), the same entry core uses, asserting on the HTTP that
// actually leaves and on the authority calls that must happen BEFORE it.
//
// What must hold:
//   1. Deny-by-default: no grant -> {denied:true} and ZERO fetches. A read that
//      fetches before checking has already leaked what the check protected.
//   2. The scope the tool hands authorize() carries the resource it names
//      (# stripped), so a channel-scoped grant can actually match.
//   3. The requests that leave are the right METHOD/URL/body (limit clamped,
//      custom emoji normalized to name:id, multipart has payload_json+files[0],
//      a TRUE reply references the parent on the FIRST chunk only).
//   4. discord:send with replyToMessageID reports replyToMessageID back.

import assert from 'node:assert/strict';
import test from 'node:test';

import { setup } from '../index.mjs';

const TOKEN = 'fake-bot-token';
const CHANNEL = '1471361561955143773';
const ACTOR = 'discord:255524600249581568';

function fakeRegistry() {
  let tools = new Map();

  class PluginInterface {
    static pluginID = 'unknown';
    static riskLevel = 'none';
    constructor(context) { this.context = context; }
    async execute(params = {}) { return await this._execute(params); }
  }

  return {
    registerTool(name, ToolClass) { tools.set(name, ToolClass); return ToolClass; },
    getTool: (name) => tools.get(name) || null,
    getTools: () => new Map(tools),
    getFrameComponents: () => new Map(),
    getToolComponents: () => new Map(),
    registerClass() {},
    registerFrameComponent() {},
    getClass: (name) => (name === 'PluginInterface'
      ? PluginInterface
      : name === 'FrameTypeUserMessage'
        ? class FrameTypeUserMessage {}
        : null),
    registerAgentProvider() {},
  };
}

// grants: a Set of ACTION names the fake authority allows (scope ignored here —
// the scope's CONTENT is asserted separately from the captured authorize call).
function buildTools({ grants = new Set(), enabled = undefined, config = {} } = {}) {
  let registry = fakeRegistry();
  let captured = { authorizations: [], configReads: [] };

  let provide = (callback) => callback({
    context: { has: () => false, require: () => null },
    registry,
    mountHttp: () => {},
    authorize: async (request) => {
      captured.authorizations.push(request);
      if (grants.has(request?.action)) return { allowed: true };
      return { allowed: false, reason: `no grant for ${request?.action}` };
    },
    db: () => ({ one: async () => null, query: async () => ({ rows: [] }) }),
    registerMigrations: () => {},
    appendToSession: async () => ({}),
    appendFrame: async () => ({}),
    appendToSessionQuietly: async () => ({}),
    readConfig: async (path) => {
      captured.configReads.push(path);
      if (path === '/kikx/discord/bot/token') return TOKEN;
      if (path === '/kikx/discord/gateway/enabled') return enabled;
      return config[path] ?? null;
    },
  });

  setup(provide);
  return { registry, captured };
}

async function runTool(ToolClass, params, fetchImpl) {
  let tool = new ToolClass({});
  let originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await tool.execute(params);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function recorder(responder) {
  let requests = [];
  let fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ?? null });
    return responder(String(url), init);
  };
  return { fetchImpl, requests };
}

const okJSON = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const noContent = () => ({ ok: true, status: 204, json: async () => null, text: async () => '' });

// --- reachability ------------------------------------------------------------

test('all seven new tools are registered by the REAL setup()', () => {
  let { registry } = buildTools();
  for (let name of [
    'discord:list_servers', 'discord:list_channels', 'discord:list_threads',
    'discord:list_messages', 'discord:participants', 'discord:react', 'discord:post_file',
  ]) {
    assert.ok(registry.getTool(name), `${name} must be registered from setup()`);
  }
});

// --- deny-by-default ---------------------------------------------------------

test('a read with no grant is denied and performs ZERO fetches', async () => {
  let { registry } = buildTools({ grants: new Set() });   // deny everything
  let { fetchImpl, requests } = recorder(() => okJSON([]));

  let result = await runTool(registry.getTool('discord:list_messages'),
    { actor: ACTOR, channel: CHANNEL }, fetchImpl);

  assert.equal(result.denied, true);
  assert.match(result.reason, /no grant for discord\.read/);
  assert.equal(requests.length, 0, 'nothing may leave the machine before authorization');
});

test('react with no grant is denied and performs ZERO fetches', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.read']) });  // react NOT granted
  let { fetchImpl, requests } = recorder(() => noContent());

  let result = await runTool(registry.getTool('discord:react'),
    { actor: ACTOR, channel: CHANNEL, message_id: '1', emoji: '👍' }, fetchImpl);

  assert.equal(result.denied, true);
  assert.equal(requests.length, 0);
});

test('post_file rides the discord.send grant: read grant alone does NOT let it post', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.read']) });
  let { fetchImpl, requests } = recorder(() => okJSON({ id: 'x' }));

  let result = await runTool(registry.getTool('discord:post_file'),
    { actor: ACTOR, channel: CHANNEL, filename: 'a.png', bytes_base64: 'aGVsbG8=' }, fetchImpl);

  assert.equal(result.denied, true);
  assert.match(result.reason, /no grant for discord\.send/);
  assert.equal(requests.length, 0);
});

test('post_file refuses zero-byte payloads even when granted', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.send']) });
  let { fetchImpl, requests } = recorder(() => okJSON({ id: 'x' }));

  // Buffer.from('', 'base64') decodes to zero bytes — the honest guard.
  let result = await runTool(registry.getTool('discord:post_file'),
    { actor: ACTOR, channel: CHANNEL, filename: 'empty.png', bytes_base64: '' }, fetchImpl);

  assert.ok(result.ok === false && /bytes_base64|required/.test(result.error || ''), JSON.stringify(result));
  assert.equal(requests.length, 0);
});

// --- the scope authorize() receives -----------------------------------------

test('the read scope carries the channel the request names, # stripped', async () => {
  let { registry, captured } = buildTools({ grants: new Set(['discord.read']) });
  let { fetchImpl } = recorder(() => okJSON([]));

  await runTool(registry.getTool('discord:list_messages'),
    { actor: ACTOR, channel: `#${CHANNEL}` }, fetchImpl);

  let last = captured.authorizations.at(-1);
  assert.deepEqual(last, { actor: ACTOR, action: 'discord.read', scope: { channel: CHANNEL } });
});

test('a guild-level read scopes on the guild it names', async () => {
  let { registry, captured } = buildTools({ grants: new Set(['discord.read']) });
  let { fetchImpl } = recorder(() => okJSON([]));

  await runTool(registry.getTool('discord:list_channels'),
    { actor: ACTOR, guild: '255525418558291969' }, fetchImpl);

  let last = captured.authorizations.at(-1);
  assert.deepEqual(last, { actor: ACTOR, action: 'discord.read', scope: { guild: '255525418558291969' } });
});

test('react authorises as discord.react, not discord.read or discord.send', async () => {
  let { registry, captured } = buildTools({ grants: new Set(['discord.react']) });
  let { fetchImpl } = recorder(() => noContent());

  await runTool(registry.getTool('discord:react'),
    { actor: ACTOR, channel: CHANNEL, message_id: '42', emoji: '👍' }, fetchImpl);

  let last = captured.authorizations.at(-1);
  assert.equal(last.action, 'discord.react');
  assert.deepEqual(last.scope, { channel: CHANNEL });
});

// --- the HTTP that actually leaves ------------------------------------------

test('list_messages GETs with a clamped limit and maps authors', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.read']) });
  let { fetchImpl, requests } = recorder(() => okJSON([
    { id: '9', channel_id: CHANNEL, author: { id: '1', username: 'th317erd', global_name: 'Wyatt' }, content: 'hi', timestamp: '2026-11-02T23:00:00Z',
      reactions: [{ emoji: { name: '\u{1F44D}', id: null }, count: 2, me: true }] },
  ]));

  let result = await runTool(registry.getTool('discord:list_messages'),
    { actor: ACTOR, channel: CHANNEL, limit: 500 }, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].url, new RegExp(`/channels/${CHANNEL}/messages\\?limit=100$`), 'limit must clamp to 100');
  assert.equal(result.messages[0].author.username, 'th317erd');
  assert.equal(result.count, 1);
  assert.deepEqual(result.messages[0].reactions[0], { name: '\u{1F44D}', emojiID: null, animated: false, count: 2, me: true });
});

test('list_servers maps the guild listing', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.read']) });
  let { fetchImpl, requests } = recorder(() => okJSON([
    { id: '255525418558291969', name: "Miri's Den", owner: true, icon: 'abc' },
  ]));

  let result = await runTool(registry.getTool('discord:list_servers'), { actor: ACTOR }, fetchImpl);

  assert.equal(result.ok, true);
  assert.match(requests[0].url, /\/users\/@me\/guilds$/);
  assert.equal(result.servers[0].name, "Miri's Den");
  assert.ok(result.servers[0].iconURL.includes('255525418558291969'));
});

test('participants derives unique speakers and admits the intent limit', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.read']) });
  let { fetchImpl } = recorder(() => okJSON([
    { id: '1', author: { id: 'a', username: 'alice' }, content: 'x' },
    { id: '2', author: { id: 'a', username: 'alice' }, content: 'y' },
    { id: '3', author: { id: 'b', username: 'bob' }, content: 'z' },
  ]));

  let result = await runTool(registry.getTool('discord:participants'),
    { actor: ACTOR, channel: CHANNEL }, fetchImpl);

  assert.equal(result.count, 2, 'same author twice must not count twice');
  assert.match(result.note, /GUILD_MEMBERS/);
});

test('list_threads says active-only when the route answers', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.read']) });
  let { fetchImpl, requests } = recorder(() => okJSON({ threads: [
    { id: 't1', name: 'topic', type: 11, thread_metadata: { archived: false } },
  ] }));

  let result = await runTool(registry.getTool('discord:list_threads'),
    { actor: ACTOR, guild: '255525418558291969' }, fetchImpl);

  assert.equal(requests[0].url.includes('/threads/active'), true);
  assert.equal(result.threads[0].typeName, 'public_thread');
  assert.match(result.note, /active threads only/);
});

test('react ADD is a PUT and custom emoji normalize to name:id', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.react']) });
  let { fetchImpl, requests } = recorder(() => noContent());

  let result = await runTool(registry.getTool('discord:react'),
    { actor: ACTOR, channel: CHANNEL, message_id: '777', emoji: '<a:wave:123456>' }, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.reacted, true);
  assert.equal(requests[0].method, 'PUT');
  assert.match(requests[0].url, /\/messages\/777\/reactions\/wave%3A123456\/@me$/, 'brackets must be normalized away');
});

test('react REMOVE is a DELETE; a 204 is Discord success', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.react']) });
  let { fetchImpl, requests } = recorder(() => noContent());

  let result = await runTool(registry.getTool('discord:react'),
    { actor: ACTOR, channel: CHANNEL, message_id: '777', emoji: '👍', op: 'remove' }, fetchImpl);

  assert.equal(requests[0].method, 'DELETE');
  assert.equal(result.ok, true);
  assert.equal(result.reacted, false);
  assert.match(requests[0].url, /\/reactions\/%F0%9F%91%8D\/@me$/);
});

test('post_file sends multipart payload_json + files[0], spoiler prefix honoured', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.send']) });
  let { fetchImpl, requests } = recorder(() => okJSON({
    id: 'msg-9', attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/shot.png' }],
  }));

  let result = await runTool(registry.getTool('discord:post_file'), {
    actor: ACTOR, channel: CHANNEL, filename: 'shot.png',
    bytes_base64: Buffer.from('PNGDATA').toString('base64'),
    content: 'a caption', spoiler: true,
  }, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.posted, true);
  assert.equal(result.attachmentURL, 'https://cdn.discordapp.com/attachments/1/2/shot.png');

  let sent = requests[0];
  assert.equal(sent.method, 'POST');
  assert.match(sent.url, new RegExp(`/channels/${CHANNEL}/messages$`));
  assert.ok(sent.body instanceof FormData, 'body must be multipart FormData');
  assert.ok(!sent.headers['Content-Type'], 'fetch must own the multipart boundary');
  let payload = JSON.parse(sent.body.get('payload_json'));
  assert.equal(payload.content, 'a caption');
  let file = sent.body.get('files[0]');
  assert.equal(file.name, 'SPOILER_shot.png');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'PNGDATA');
});

// --- true reply --------------------------------------------------------------

test('discord:send with replyToMessageID references the parent on the FIRST chunk only', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.send']) });
  let parent = '1566935464332501102';
  let { fetchImpl, requests } = recorder(() => okJSON({ id: 'msg-0' }));

  let paragraphs = [];
  for (let i = 0; i < 40; i += 1) paragraphs.push(`Part ${i} ` + 'w'.repeat(150));
  let longText = paragraphs.join('\n\n');
  assert.ok(longText.length > 2000, 'fixture must split');

  let result = await runTool(registry.getTool('discord:send'),
    { actor: ACTOR, channel: CHANNEL, content: longText, replyToMessageID: parent }, fetchImpl);

  assert.ok(requests.length > 1, 'must split');
  let firstBody = JSON.parse(requests[0].body);
  assert.equal(firstBody.message_reference.message_id, parent, 'first chunk is the true reply');
  assert.equal(firstBody.message_reference.fail_if_not_exists, false);
  for (let i = 1; i < requests.length; i++) {
    let body = JSON.parse(requests[i].body);
    assert.equal(body.message_reference, undefined, `chunk ${i} must NOT repeat the reference`);
  }
  assert.equal(result.replyToMessageID, parent, 'the result echoes the parent id');
});

test('discord:send without replyToMessageID sends NO message_reference (unchanged behaviour)', async () => {
  let { registry } = buildTools({ grants: new Set(['discord.send']) });
  let { fetchImpl, requests } = recorder(() => okJSON({ id: 'msg-0' }));

  await runTool(registry.getTool('discord:send'),
    { actor: ACTOR, channel: CHANNEL, content: 'plain' }, fetchImpl);

  let body = JSON.parse(requests[0].body);
  assert.equal(body.message_reference, undefined);
});
