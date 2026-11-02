'use strict';

// The Discord reply must say WHAT it is answering.
//
// Inbound Discord messages arrive as DiscordFrame with agentOnly:true, and that
// frame is deliberately absent from the session thread (the agent-only spec's
// second question is literally "is it absent from the session thread"). The
// outbound DiscordSendToolFrame is visible. So on live 3003, session 54e1c081,
// the owner reads an agent replying to nothing: four of his own messages are
// hidden by design, and the replies to them are all the thread shows.
//
// The fix is not to unhide anything. The transport already owns the mapping
// table (discord_message_frame: session_id, message_id, original_text), so the
// send can quote the message it answers and the card can render the pair.
//
// What this spec is for, rather than decoration:
//   1. The quote must come from the real row, with our own "[discord:<name>] "
//      annotation stripped. Quoting the prefix back at the owner is a visible lie
//      about what he typed.
//   2. It must never invent a quote. No row, an unusable row, or a failed lookup
//      must leave the result exactly as it was before this feature, so the card
//      renders bare instead of fabricating a conversation.
//   3. A transcript read must never fail or delay a send, and must not happen at
//      all for a send we are about to refuse.
//
// The lookup is keyed on _sessionID, which core injects into every tool call
// (enrichToolInput in tool-execution-service.mjs). The agent does not and should
// not pass it: it knows what it wants to say, not which frame woke it. The
// passthrough that carries it (execute -> _execute) is exercised, not assumed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { setup } from '../index.mjs';

const TOKEN = 'fake-bot-token';

// ---------------------------------------------------------------------------
// DOM globals must exist BEFORE the card module is evaluated.
//
// The card binds `ElementBase` at module scope:
//   const ElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {}
// Installing HTMLElement after the import is too late and the element silently
// extends a bare class, so render() throws "appendChild is not a function". That
// is the trap the module's own comment warns about, hit from the test side.
// ---------------------------------------------------------------------------

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.className = '';
    this._text = '';
  }
  appendChild(child) { this.childNodes.push(child); return child; }
  set textContent(value) { this._text = value; this.childNodes = []; }
  get textContent() {
    if (this.childNodes.length === 0)
      return this._text;
    return this.childNodes.map((child) => child.textContent).join('');
  }
}

globalThis.HTMLElement = class FakeHTMLElement extends FakeNode {};
globalThis.document = { createElement: (tag) => new FakeNode(tag) };
// Deliberately NOT defining customElements: the module then skips definition,
// which is what a test host wants, and keeps defineDiscordSendCard callable.

const { describeDiscordSend, DiscordSendCard } = await import('../client/discord-send-card.mjs');

// ---------------------------------------------------------------------------
// Host fixture
// ---------------------------------------------------------------------------

// setup() resolves PluginInterface from the registry, so the fake base has to be
// reachable there. It reproduces the one behaviour this spec depends on: execute()
// passes params through to _execute() untouched (plugin-interface.mjs:28-37).
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
    getClass: (name) => (name === 'PluginInterface'
      ? PluginInterface
      : name === 'FrameTypeUserMessage'
        ? class FrameTypeUserMessage {}
        : null),
    registerAgentProvider() {},
  };
}

function buildTool({ rows = [], dbError = null, allowed = true } = {}) {
  let registry = fakeRegistry();
  let issuedSql = [];

  let provide = (callback) => callback({
    context: { has: () => false, require: () => null },
    registry,
    mountHttp: () => {},
    authorize: async () => (allowed ? { allowed: true } : { allowed: false, reason: 'no grant for discord.send' }),
    db: () => ({
      one: async (sql, params) => {
        issuedSql.push({ sql, params });
        if (dbError) throw dbError;
        return rows.shift() ?? null;
      },
      query: async () => ({ rows: [] }),
    }),
    registerMigrations: () => {},
    appendToSession: async () => ({}),
    appendFrame: async () => ({}),
    appendToSessionQuietly: async () => ({}),
    readConfig: async () => TOKEN,
  });

  setup(provide);

  let ToolClass = registry.getTool('discord:send');
  assert.ok(ToolClass, 'discord:send must be registered');
  return { ToolClass, issuedSql };
}

function okFetch(messageID = '999000111') {
  return async () => ({ ok: true, status: 200, json: async () => ({ id: messageID }) });
}

// Drive the same entry point core uses: execute(params), which applies the
// passthrough carrying _sessionID.
async function runTool(ToolClass, params, fetchImpl = okFetch()) {
  let tool = new ToolClass({});
  let originalFetch = globalThis.fetch;
  let originalWarn = console.warn;
  let warnings = [];
  globalThis.fetch = fetchImpl;
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    let result = await tool.execute(params);
    return { result, warnings };
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
}

const SESSION = '54e1c081-b4fc-46bf-ae9a-c82e19784a19';
const CHANNEL = '1471361561955143773';
const ACTOR = 'discord:255524600249581568';

function inboundRow(overrides = {}) {
  return {
    message_id: '1566671773422846023',
    created_at: new Date('2026-11-02T01:23:26.000Z'),
    original_text: '[discord:th317erd] Miri, are you getting this message?',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

test('a send quotes the Discord message it answers, prefix stripped', async () => {
  let { ToolClass } = buildTool({ rows: [inboundRow()] });

  let { result } = await runTool(ToolClass, {
    actor: ACTOR,
    channel: CHANNEL,
    content: 'yes, receiving you',
    _sessionID: SESSION,
  });

  assert.equal(result.sent, true);
  assert.ok(result.replyTo, 'the result must carry the message being answered');

  // The body must be what he wrote, not our annotation around it.
  assert.equal(result.replyTo.text, 'Miri, are you getting this message?');
  assert.equal(result.replyTo.author, 'th317erd');
  assert.equal(result.replyTo.messageID, '1566671773422846023');
  assert.equal(result.replyTo.at, '2026-11-02T01:23:26.000Z');
});

test('the lookup is scoped to the calling session and to landed rows', async () => {
  let { ToolClass, issuedSql } = buildTool({ rows: [null] });

  await runTool(ToolClass, { actor: ACTOR, channel: CHANNEL, content: 'hello', _sessionID: SESSION });

  assert.equal(issuedSql.length, 1, 'exactly one lookup per send');
  assert.match(issuedSql[0].sql, /session_id\s*=\s*\$1/, 'must be scoped to the session');
  // A claim row (frame_id NULL) is a message that has not landed yet; quoting it
  // would show the owner a message the agent never received.
  assert.match(issuedSql[0].sql, /frame_id\s+IS\s+NOT\s+NULL/i);
  assert.deepEqual(issuedSql[0].params, [SESSION]);
});

test('no inbound message means no quote, and never a placeholder', async () => {
  let { ToolClass } = buildTool({ rows: [null] });

  let { result } = await runTool(ToolClass, {
    actor: ACTOR,
    channel: CHANNEL,
    content: 'unprompted broadcast',
    _sessionID: SESSION,
  });

  assert.equal(result.sent, true);
  assert.equal('replyTo' in result, false, 'absent must stay absent, not null');
  assert.equal(
    describeDiscordSend({ content: { preview: JSON.stringify(result) } }).replyTo,
    null,
  );
});

test('a failed transcript lookup does not fail the send', async () => {
  let { ToolClass } = buildTool({ dbError: new Error('relation does not exist') });

  let { result, warnings } = await runTool(ToolClass, {
    actor: ACTOR,
    channel: CHANNEL,
    content: 'still sends',
    _sessionID: SESSION,
  });

  assert.equal(result.sent, true, 'the send must succeed regardless');
  assert.equal(result.delivered, true);
  assert.equal('replyTo' in result, false);
  assert.equal(warnings.length, 1, 'the failure must be visible in the log, not silent');
  assert.match(warnings[0], /could not look up the message being answered/);
});

test('a send with no session id does not query at all', async () => {
  let { ToolClass, issuedSql } = buildTool({ rows: [null] });

  let { result } = await runTool(ToolClass, {
    actor: ACTOR,
    channel: CHANNEL,
    content: 'manual send',
  });

  assert.equal(result.sent, true);
  assert.equal(issuedSql.length, 0, 'no session means nothing to look up');
});

test('a refused send performs no transcript read', async () => {
  let { ToolClass, issuedSql } = buildTool({ rows: [inboundRow()], allowed: false });

  let { result } = await runTool(ToolClass, {
    actor: 'discord:nobody',
    channel: CHANNEL,
    content: 'denied',
    _sessionID: SESSION,
  });

  assert.equal(result.sent, false);
  assert.equal(result.denied, true);
  assert.equal('replyTo' in result, false, 'a refused send must not claim a quote');
  assert.equal(issuedSql.length, 0, 'a send we refuse must not read the transcript');
});

test('the quote travels in the preview the card parses', async () => {
  // The card reads content.preview, which core fills with JSON.stringify(result).
  // If the field were nested somewhere preview does not carry, the card would show
  // nothing and every other test here would still pass.
  let { ToolClass } = buildTool({ rows: [inboundRow()] });
  let { result } = await runTool(ToolClass, {
    actor: ACTOR,
    channel: CHANNEL,
    content: 'reply',
    _sessionID: SESSION,
  });

  let description = describeDiscordSend({
    content: {
      input: { actor: ACTOR, channel: CHANNEL, content: 'reply' },
      preview: JSON.stringify(result),
    },
  });

  assert.ok(description.replyTo, 'the card must be able to read the quote');
  assert.equal(description.replyTo.author, 'th317erd');
});

// ---------------------------------------------------------------------------
// Rendering: the card is what the owner actually sees.
// ---------------------------------------------------------------------------

function renderCard(frame) {
  let card = new DiscordSendCard();
  card.updateFrame(frame, {});
  return card.textContent;
}

test('the card reads as a conversation: what they said, then what was sent', () => {
  let text = renderCard({
    type: 'DiscordSendToolFrame',
    content: {
      input: { actor: ACTOR, channel: CHANNEL, content: 'yes, receiving you' },
      preview: JSON.stringify({
        sent: true,
        authorized: true,
        channel: CHANNEL,
        messageID: '999000111',
        delivered: true,
        replyTo: {
          messageID: '1566671773422846023',
          author: 'th317erd',
          text: 'Miri, are you getting this message?',
          at: '2026-11-02T01:23:26.000Z',
        },
      }),
    },
  });

  assert.match(text, /replying to th317erd/, 'the reader must see who was answered');
  assert.match(text, /Miri, are you getting this message\?/, 'and what they said');
  assert.match(text, /yes, receiving you/, 'and what we sent');
});

test('the card invents no quote when the send carries none', () => {
  let text = renderCard({
    type: 'DiscordSendToolFrame',
    content: {
      input: { actor: ACTOR, channel: CHANNEL, content: 'standalone message' },
      preview: JSON.stringify({
        sent: true, delivered: true, messageID: '42', channel: CHANNEL,
      }),
    },
  });

  assert.doesNotMatch(text, /replying to/, 'no quote may be fabricated');
  assert.match(text, /standalone message/);
});

test('an unusable quote degrades to no quote rather than rendering blank', () => {
  let description = describeDiscordSend({
    content: {
      input: { actor: ACTOR, channel: CHANNEL, content: 'x' },
      preview: JSON.stringify({ sent: true, delivered: true, replyTo: { text: '   ' } }),
    },
  });

  assert.equal(description.replyTo, null);
});
