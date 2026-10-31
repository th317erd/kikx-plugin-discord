'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordInboundRouter } from '../inbound-router.mjs';

// The inbound frame is written on behalf of a Discord user. Three properties make
// it correct, and none of them are visible without asserting them here:
//
//   1. attribution - the frame must not claim the Kikx owner wrote it;
//   2. a type of its own - the frame is written through appendFrame as
//      'DiscordFrame', which is what keeps it out of the session transcript
//      (the type's class declares `static agentOnly` in index.mjs) while still
//      delivering it to the agent;
//   3. never `hidden: true` - hidden is a different axis. It nulls
//      toAgentMessage() in frame-type-base, so the frame would vanish from the
//      model context and the bot would go deaf to Discord while every test here
//      still passed.
//
// An earlier version of this spec asserted `display: 'seamless'`. That field was
// never honoured: the frame is built as a closed object literal in
// frame-runtime and `display` was not in it, so it was discarded at write time.

function makeRouter(overrides = {}) {
  let calls = { appended: [] };
  let router = new DiscordInboundRouter({
    findChannelSession: async () => ({ session_id: 'sess-1' }),
    bindChannelSession: async () => {},
    recordFrame: async () => {},
    seenMessage: async () => false,
    appendFrame: async (sessionID, input) => {
      calls.appended.push({ sessionID, input });
      return { session: { id: sessionID }, frame: { id: 'frame-1' } };
    },
    botUserID: () => 'bot-1',
    authorizeInbound: async () => ({ allowed: true }),
    ...overrides,
  });
  return { router, calls };
}

function message(overrides = {}) {
  return {
    id: 'msg-1',
    channel_id: 'chan-1',
    content: 'hello there',
    type: 0,
    author: { id: 'user-1', username: 'wyatt', bot: false },
    ...overrides,
  };
}

test('an inbound message is written as its own frame type, not a UserMessage', async () => {
  // appendToSession hardcodes 'UserMessage', which is what made a Discord message
  // indistinguishable from the owner typing. appendFrame is the typed write.
  let { router, calls } = makeRouter();
  await router.handle('MESSAGE_CREATE', message());

  let input = calls.appended[0].input;
  assert.equal(input.type, 'DiscordFrame');
});

test('an inbound message is attributed to the Discord author, not the owner', async () => {
  let { router, calls } = makeRouter();
  await router.handle('MESSAGE_CREATE', message());

  let input = calls.appended[0].input;
  // Namespaced so a Discord id can never collide with a Kikx user id.
  assert.equal(input.authorID, 'discord:user-1');
  // The bare handle. The frame type says where it came from; a " (Discord)" suffix
  // decorating the name was the wrong fix for the wrong mechanism.
  assert.equal(input.authorDisplayName, 'wyatt');
});

test('the frame is never hidden: hidden is not the seamlessness axis', async () => {
  // If this ever sends `hidden: true`, core drops the frame from the model's
  // context (frame-type-base.mjs:118) and the bot goes deaf to Discord while
  // everything still looks green.
  let { router, calls } = makeRouter();
  await router.handle('MESSAGE_CREATE', message());

  let input = calls.appended[0].input;
  assert.notEqual(input.hidden, true);
  assert.equal(input.hidden, undefined);
  assert.equal(input.agentOnly, undefined, 'agentOnly must come from the registered class, never the caller');
});

test('an edited message keeps the type and the attribution on the re-append', async () => {
  // handleEdit re-appends the same frame id with only text and audit. Omitting the
  // marker there would redraw the message as the owner's.
  let { router, calls } = makeRouter({
    findFrame: async () => ({ session_id: 'sess-1', frame_id: 'frame-1', original_text: '[discord:wyatt] hello there', edits: 0, audit: [] }),
    updateFrameAudit: async () => {},
  });

  await router.handle('MESSAGE_UPDATE', {
    id: 'msg-1',
    channel_id: 'chan-1',
    content: 'hello there (edited)',
    author: { id: 'user-1', username: 'wyatt', bot: false },
  });

  assert.equal(calls.appended.length, 1);
  let input = calls.appended[0].input;
  assert.equal(input.type, 'DiscordFrame');
  assert.equal(input.authorID, 'discord:user-1');
  assert.notEqual(input.hidden, true);
});
