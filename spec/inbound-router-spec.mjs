'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordInboundRouter } from '../inbound-router.mjs';

function makeRouter(overrides = {}) {
  let calls = { appended: [], recorded: [], bound: [] };
  let router = new DiscordInboundRouter({
    findChannelSession: async () => ({ session_id: 'sess-1' }),
    bindChannelSession: async (input) => { calls.bound.push(input); },
    recordFrame: async (input) => { calls.recorded.push(input); },
    seenMessage: async () => false,
    appendToSession: async (sessionID, input) => {
      calls.appended.push({ sessionID, input });
      return { session: { id: sessionID }, frame: { id: 'frame-1' } };
    },
    botUserID: () => 'bot-1',
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

test('a bound channel message becomes a frame in that session', async () => {
  let { router, calls } = makeRouter();
  let result = await router.handle('MESSAGE_CREATE', message());

  assert.equal(result.handled, true);
  assert.equal(result.sessionID, 'sess-1');
  assert.equal(calls.appended.length, 1);
  let appended = calls.appended[0];
  assert.equal(appended.sessionID, 'sess-1');
  assert.equal(appended.input.text, '[discord:wyatt] hello there');
  assert.equal(appended.input.source, 'discord');
  // The message id must ride along so an edit can find the frame again.
  assert.equal(appended.input.content.discord.messageID, 'msg-1');
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.recorded[0].frameID, 'frame-1');
  assert.equal(calls.recorded[0].messageID, 'msg-1');
  assert.equal(calls.recorded[0].sessionID, 'sess-1');
});

test("the bot's own message is not framed, so a reply cannot become its own input", async () => {
  let { router, calls } = makeRouter({ botUserID: () => 'bot-1' });
  let result = await router.handle('MESSAGE_CREATE', message({ author: { id: 'bot-1', username: 'kikx', bot: true } }));

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'own_message');
  assert.equal(calls.appended.length, 0, 'this is the loop guard: no frame may be created');
});

test('other bots are ignored, but a human with no bot flag is framed', async () => {
  let { router, calls } = makeRouter();
  let otherBot = await router.handle('MESSAGE_CREATE', message({ id: 'm-bot', author: { id: 'bot-2', username: 'other', bot: true } }));
  assert.equal(otherBot.reason, 'bot_author');

  let human = await router.handle('MESSAGE_CREATE', message({ id: 'm-human', author: { id: 'user-9', username: 'miri', bot: false } }));
  assert.equal(human.handled, true);
  assert.equal(calls.appended.length, 1);
});

test('a duplicate message is not framed twice (gateway replays after RESUME)', async () => {
  let { router, calls } = makeRouter({ seenMessage: async (id) => id === 'msg-1' });
  let result = await router.handle('MESSAGE_CREATE', message());

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'duplicate');
  assert.equal(calls.appended.length, 0);
});

test('an unbound channel reports the channel instead of inventing a session', async () => {
  let { router, calls } = makeRouter({ findChannelSession: async () => null });
  let result = await router.handle('MESSAGE_CREATE', message({ channel_id: 'chan-unknown' }));

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'unbound_channel');
  assert.equal(result.channelID, 'chan-unknown');
  assert.equal(calls.appended.length, 0);
});

test('an explicitly configured channel is auto-bound once, then found by lookup', async () => {
  let bindings = new Map();
  let { router, calls } = makeRouter({
    autoBindChannelID: 'chan-1',
    autoBindSessionID: 'sess-auto',
    findChannelSession: async (id) => (bindings.has(id) ? { session_id: bindings.get(id) } : null),
    bindChannelSession: async ({ channelID, sessionID }) => {
      bindings.set(channelID, sessionID);
      calls.bound.push({ channelID, sessionID });
    },
  });

  let first = await router.handle('MESSAGE_CREATE', message());
  assert.equal(first.handled, true);
  assert.equal(first.sessionID, 'sess-auto');
  assert.deepEqual(calls.bound, [{ channelID: 'chan-1', sessionID: 'sess-auto' }]);

  let second = await router.handle('MESSAGE_CREATE', message({ id: 'msg-2' }));
  assert.equal(second.handled, true);
  assert.equal(calls.bound.length, 1, 'the binding is written once, not on every message');
});

test('a message with empty content is reported as a missing MESSAGE_CONTENT intent', async () => {
  let { router, calls } = makeRouter();
  let result = await router.handle('MESSAGE_CREATE', message({ content: '' }));

  assert.equal(result.handled, false);
  // This is the only observable signal that the privileged intent is off: Discord
  // delivers the message anyway, with empty content and no error.
  assert.equal(result.reason, 'empty_content_missing_intent');
  assert.equal(calls.appended.length, 0);
});

test('non-message events and non-message types are not framed', async () => {
  let { router, calls } = makeRouter();

  assert.equal((await router.handle('MESSAGE_UPDATE', message())).reason, 'not_a_message');
  assert.equal((await router.handle('GUILD_CREATE', { id: 'g1' })).reason, 'not_a_message');
  // Type 7 is a guild member join; there is no text to frame.
  assert.equal((await router.handle('MESSAGE_CREATE', message({ type: 7 }))).reason, 'unsupported_type');
  assert.equal(calls.appended.length, 0);
});

test('a reply (type 19) is framed like a normal message', async () => {
  let { router, calls } = makeRouter();
  let result = await router.handle('MESSAGE_CREATE', message({ type: 19 }));
  assert.equal(result.handled, true);
  assert.equal(calls.appended.length, 1);
});

test('a failing append propagates, so the caller sees the failure rather than a silent drop', async () => {
  let { router } = makeRouter({
    appendToSession: async () => { throw new Error('frame runtime unavailable'); },
  });
  await assert.rejects(
    () => router.handle('MESSAGE_CREATE', message()),
    /frame runtime unavailable/,
  );
});

test('construction refuses without the two dependencies that make routing meaningful', () => {
  assert.throws(() => new DiscordInboundRouter({}), /appendToSession/);
  assert.throws(() => new DiscordInboundRouter({ appendToSession: async () => {} }), /findChannelSession/);
});
