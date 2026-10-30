'use strict';

// Edits used to have two paths and neither was right.
//
// Over HTTP there was an inline copy of the edit handling that re-implemented the diff
// and never called authorizeInbound at all, so an edit was a write with no capability
// check. Over the gateway there was no edit path at all: `handle()` answered
// `not_a_message` for MESSAGE_UPDATE, so an edit was silently dropped. Two paths, one
// missing a gate and the other missing the feature.
//
// These tests pin the single path that replaced them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordInboundRouter } from '../inbound-router.mjs';

const NEWLINE = String.fromCharCode(10);

function makeRouter(overrides = {}) {
  let calls = { appended: [], auditUpdates: [], authorizations: [], logs: [] };
  let router = new DiscordInboundRouter({
    findChannelSession: async () => ({ session_id: 'sess-1' }),
    findFrame: async () => ({
      session_id: 'sess-1',
      frame_id: 'frame-1',
      original_text: '[discord:wyatt] hello there',
      edits: 0,
      audit: [],
    }),
    updateFrameAudit: async (input) => { calls.auditUpdates.push(input); },
    appendToSession: async (sessionID, input) => {
      calls.appended.push({ sessionID, input });
      return { session: { id: sessionID }, frame: { id: 'frame-1' } };
    },
    botUserID: () => 'bot-1',
    authorizeInbound: async (request) => {
      calls.authorizations.push(request);
      return { allowed: true };
    },
    log: (level, message) => { calls.logs.push({ level, message }); },
    ...overrides,
  });
  return { router, calls };
}

function edit(overrides = {}) {
  return {
    id: 'msg-1',
    channel_id: 'chan-1',
    content: 'hello there, edited',
    edited_timestamp: '2026-10-30T18:00:00.000Z',
    author: { id: 'user-1', username: 'wyatt', bot: false },
    ...overrides,
  };
}

test('an authorized edit updates the frame it became, and records a diff', async () => {
  let { router, calls } = makeRouter();
  let result = await router.handle('MESSAGE_UPDATE', edit());

  assert.equal(result.handled, true);
  assert.equal(result.edited, true);
  assert.equal(result.frameID, 'frame-1');
  assert.equal(result.sessionID, 'sess-1');

  // An edit must never create a second frame.
  assert.equal(calls.appended.length, 1, 'exactly one append, and it is an update');
  assert.equal(calls.appended[0].input.id, 'frame-1', 'the append targets the existing frame');

  // The original text is preserved; the change rides in content.audit.
  let audit = calls.appended[0].input.content.audit;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].editedAt, '2026-10-30T18:00:00.000Z');
  assert.match(audit[0].diff, /- \[discord:wyatt\] hello there/);
  assert.match(audit[0].diff, /\+ hello there, edited/);

  assert.equal(calls.auditUpdates.length, 1);
  assert.equal(calls.auditUpdates[0].messageID, 'msg-1');
  assert.equal(calls.auditUpdates[0].edits, 1);
});

test('repeated edits accumulate instead of replacing the earlier audit', async () => {
  let first = { editedAt: '2026-10-30T17:00:00.000Z', diff: '+ first edit' };
  let { router, calls } = makeRouter({
    findFrame: async () => ({
      session_id: 'sess-1',
      frame_id: 'frame-1',
      original_text: '[discord:wyatt] hello there',
      edits: 1,
      audit: [ first ],
    }),
  });

  await router.handle('MESSAGE_UPDATE', edit());

  let audit = calls.appended[0].input.content.audit;
  assert.equal(audit.length, 2, 'the tail grows; it does not replace');
  assert.deepEqual(audit[0], first);
  assert.equal(calls.auditUpdates[0].edits, 2, 'the counter reflects the second edit');
});

test('an UNAUTHORIZED edit writes nothing at all', async () => {
  // The defect this guards: the old inline HTTP path never consulted the gate, so an
  // actor with no grant could rewrite a frame's record just by editing the message.
  let { router, calls } = makeRouter({
    authorizeInbound: async (request) => {
      calls.authorizations.push(request);
      return { allowed: false, reason: 'no grant for discord.inbound' };
    },
  });

  let result = await router.handle('MESSAGE_UPDATE', edit());

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not_authorized');
  assert.equal(calls.appended.length, 0, 'a denied edit must not touch the session');
  assert.equal(calls.auditUpdates.length, 0, 'a denied edit must not touch the mapping row');
  assert.ok(calls.logs.some((l) => /denied edit/.test(l.message)));
});

test('the edit is authorized for the same actor and channel as the message', async () => {
  let { router, calls } = makeRouter();
  await router.handle('MESSAGE_UPDATE', edit());

  assert.equal(calls.authorizations.length, 1);
  assert.equal(calls.authorizations[0].actorID, 'user-1');
  assert.equal(calls.authorizations[0].channelID, 'chan-1');
});

test('an edit for a message that was never framed is reported, not guessed at', async () => {
  let { router, calls } = makeRouter({ findFrame: async () => null });
  let result = await router.handle('MESSAGE_UPDATE', edit());

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'unframed_message');
  assert.equal(calls.appended.length, 0);
});

test('an embed unfurl carrying no content is ignored rather than logged as an error', async () => {
  // Discord sends MESSAGE_UPDATE with no content field when it expands a link preview.
  // There is nothing to record, and treating it as a failure would log noise every time
  // somebody pastes a URL.
  let { router, calls } = makeRouter();
  let noContent = edit();
  delete noContent.content;

  let result = await router.handle('MESSAGE_UPDATE', noContent);
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'edit_without_content');
  assert.equal(calls.appended.length, 0);
});

test("the bot's own edit is not written back, so an edit cannot become new input", async () => {
  let { router, calls } = makeRouter();
  let result = await router.handle('MESSAGE_UPDATE', edit({ author: { id: 'bot-1', username: 'kikx', bot: true } }));

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'own_message');
  assert.equal(calls.appended.length, 0);
});

test('a non-message, non-edit event is still not a message', async () => {
  let { router } = makeRouter();
  assert.equal((await router.handle('GUILD_CREATE', { id: 'g1' })).reason, 'not_a_message');
});

test('an edit whose author cannot be attributed is denied, not inherited on faith', async () => {
  // The mapping row proves the *original* was allowed, not that this writer is.
  let { router, calls } = makeRouter();
  let anonymous = edit();
  delete anonymous.author;

  let result = await router.handle('MESSAGE_UPDATE', anonymous);
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'no_author');
  assert.equal(calls.appended.length, 0);
});
