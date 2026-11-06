'use strict';

// =============================================================================
// The reply hint — promoted from spec/inbound-reply-hint-spec.mjs.draft
// =============================================================================
// WHY THIS SPEC EXISTS
//
// Two real #miri messages were delivered correctly on 2026-11-02 (frames e0df1e69 at
// order 37734 and 96de9614 at order 29825). Miri woke, ran a genuine turn in session
// 54e1c081, and reached order 49065. Across that entire session the store contains
// ZERO DiscordSendToolFrame rows: the send tool has never been invoked, not once.
//
// The grant was present the whole time, the bot token works, and the bot can read
// the channel. Nothing was denied. The message simply arrived with no statement that
// a reply was expected, no way to address the channel it came from, and no mention
// that the send tool exists or what it is called. So the turn ended in the session
// and the human in Discord heard nothing back.
//
// A capability that nobody tells the agent about is a capability that does not exist.
// The hint is computed from a real authorizeReply() call — the SAME gate
// discord:send runs — rather than assumed, because advertising a reply the gate
// would refuse is worse than silence: it turns a policy boundary into a loop of
// confident refusals.
//
// DRAFT ADAPTATIONS (reported to the coordinator): the draft targeted
// handleMessage()/authorizeReply-as-constructor-option names the router never had;
// the real API is handle('MESSAGE_CREATE', …) with authorizeReply as an injected
// option. The draft's "hint carries the content" assertion now checks the framed
// TEXT (message line + hint line together) — the hint itself is a fixed
// instruction; the content it answers sits directly above it in the same text,
// which is exactly what the model reads.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordInboundRouter, REPLY_HINT_MARKER } from '../inbound-router.mjs';

function message(overrides = {}) {
  return {
    id: 'msg_1',
    channel_id: 'chan_1',
    guild_id: 'guild_1',
    content: 'are you there',
    author: { id: 'user_1', username: 'th317erd', bot: false },
    member: { nick: null },
    ...overrides,
  };
}

function makeRouter(options = {}) {
  let calls = { appendFrame: [], log: [] };
  let instance = new DiscordInboundRouter({
    findChannelSession: async () => ({ session_id: 'ses_1' }),
    bindChannelSession: async () => {},
    recordFrame: async () => {},
    seenMessage: async () => false,
    findFrame: async () => null,
    updateFrameAudit: async () => {},
    appendFrame: async (sessionID, input) => {
      calls.appendFrame.push({ sessionID, input });
      return { frame: { id: 'frame_1' } };
    },
    authorizeInbound: async () => ({ allowed: true }),
    botUserID: () => 'bot_1',
    log: (level, text) => calls.log.push({ level, text }),
    ...options,
  });
  return { instance, calls };
}

// The hint as data (content.discord.replyHint) — and the frame text must carry a
// copy, because the model sees ONLY the text.
function hintOf(calls) {
  return calls.appendFrame[0]?.input?.content?.discord?.replyHint || null;
}
function textOf(calls) {
  return calls.appendFrame[0]?.input?.text || '';
}

test('an authorized reply is advertised in the frame, by name, with the channel to answer', async () => {
  let { instance, calls } = makeRouter({
    authorizeReply: async ({ channelID }) => ({ allowed: true, channelID }),
  });

  await instance.handle('MESSAGE_CREATE', message());

  let hint = hintOf(calls);
  assert.ok(hint, 'a sendable message must carry a reply hint');
  // The registry registers 'discord:send' but the model is shown 'discord__send'.
  // Both are named because a hint that names only one of them produces an agent
  // that asks for a tool nobody has, which is indistinguishable from no tool.
  assert.match(hint, /discord_send/, 'the hint must name the tool the model calls');
  assert.match(hint, /discord:send/, '…and the tool the registry actually holds');
  assert.match(hint, /chan_1/, 'the hint must name the channel to answer in');
  // And it must be IN THE TEXT: toAgentMessage builds the model turn from
  // input.text alone; a hint that existed only as data would reach nobody.
  assert.match(textOf(calls), /^\[discord:th317erd\] are you there\n\[kikx:reply-hint\]/,
    'the framed text is message line, then hint line');
});

test('the hint is asked as the speaker, in their channel — the gate the send will run', async () => {
  let asked = [];
  let { instance, calls } = makeRouter({
    authorizeReply: async (args) => { asked.push(args); return { allowed: true }; },
  });

  await instance.handle('MESSAGE_CREATE', message());

  assert.deepEqual(asked, [{ channelID: 'chan_1', actorID: 'user_1' }],
    'the hint must be authorized for THIS speaker in THIS channel, or it advertises someone else\u2019s grant');
  assert.ok(hintOf(calls));
});

test('the hint sits beside the content it answers (message line + hint line, one text)', async () => {
  let { instance, calls } = makeRouter({
    authorizeReply: async () => ({ allowed: true }),
  });

  await instance.handle('MESSAGE_CREATE', message({ content: 'what is the disk usage' }));

  let text = textOf(calls);
  assert.match(text, /what is the disk usage/, 'the message the agent replies to');
  assert.match(text, /\[kikx:reply-hint\]/, '…immediately followed by the hint');
});

test('no hint is written when the send gate would refuse', async () => {
  let { instance, calls } = makeRouter({
    authorizeReply: async () => ({ allowed: false, reason: 'no grant for discord.send' }),
  });

  await instance.handle('MESSAGE_CREATE', message());

  assert.equal(hintOf(calls), null, 'an unanswerable message must not advertise a reply');
  assert.doesNotMatch(textOf(calls), /\[kikx:reply-hint\]/,
    '…and the text must not carry one either');
});

test('a failing send-authorization check costs the message nothing', async () => {
  let { instance, calls } = makeRouter({
    authorizeReply: async () => { throw new Error('db down'); },
  });

  let result = await instance.handle('MESSAGE_CREATE', message());

  assert.equal(result.handled, true, 'the frame must still be written');
  assert.equal(calls.appendFrame.length, 1);
  assert.equal(hintOf(calls), null);
  assert.doesNotMatch(textOf(calls), /\[kikx:reply-hint\]/);
  assert.ok(calls.log.some((entry) => entry.level === 'warn'),
    'the failure must be reported, not silently swallowed');
});

test('a host that wires no reply check gets no hint and no crash', async () => {
  let { instance, calls } = makeRouter();

  let result = await instance.handle('MESSAGE_CREATE', message());

  assert.equal(result.handled, true);
  assert.equal(hintOf(calls), null);
  assert.doesNotMatch(textOf(calls), /\[kikx:reply-hint\]/);
});

test('a bot-authored message never invites a reply', async () => {
  let { instance, calls } = makeRouter({
    authorizeReply: async () => ({ allowed: true }),
  });

  let result = await instance.handle('MESSAGE_CREATE', message({
    author: { id: 'bot_1', username: 'Miri', bot: true },
  }));

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'own_message');
  assert.equal(calls.appendFrame.length, 0, 'bot messages are not framed at all');
});

test('an unbound channel never reaches the hint gate', async () => {
  let asked = [];
  let { instance, calls } = makeRouter({
    findChannelSession: async () => null,
    authorizeReply: async (args) => { asked.push(args); return { allowed: true }; },
  });

  let result = await instance.handle('MESSAGE_CREATE', message());

  assert.equal(result.reason, 'unbound_channel');
  assert.equal(calls.appendFrame.length, 0);
  assert.deepEqual(asked, [], 'nothing is advertised for a channel that frames nowhere');
});
