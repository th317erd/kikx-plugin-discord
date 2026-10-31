'use strict';

// WHY THIS SPEC EXISTS
//
// Session 3d573682 on the dev instance had `participantAgentIDs: []` and
// `coordinatorAgentID: null`. A real Discord message arrived, `appendFrame` wrote a
// DiscordFrame, and nothing ran: `AgentRouteFramePlugin` returns early when there is
// no coordinator (agent-route-frame-plugin.mjs:40-42), and `resolveRouteTargets`
// filters its output through `participantAgentIDs.includes(...)`, which is empty.
// The message was accepted, stored, readable, and silently unrouted.
//
// The transport is the only party that knows the session it writes into was created
// for it, so the transport is where "make sure somebody is there" belongs. Core still
// decides WHO that is (coordinator rule 3) and whether to run them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordInboundRouter } from '../inbound-router.mjs';

const DISCORD_FRAME_TYPE = 'DiscordFrame';

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
  let calls = { appendFrame: [], ensure: [], log: [] };
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

test('the recipient is ensured before the frame is written', async () => {
  let order = [];
  let { instance } = makeRouter({
    ensureSessionRecipient: async ({ sessionID }) => { order.push('ensure:' + sessionID); },
    appendFrame: async () => { order.push('append'); return { frame: { id: 'frame_1' } }; },
  });

  await instance.handle('MESSAGE_CREATE', message());

  // Order matters. Ensuring afterwards would let the first message on a freshly bound
  // channel be written into a coordinator-less session and dropped, which is exactly
  // the original defect.
  assert.deepEqual(order, ['ensure:ses_1', 'append']);
});

test('it is told which session the message is going into', async () => {
  let { instance, calls } = makeRouter({
    ensureSessionRecipient: async (args) => calls.ensure.push(args),
  });

  await instance.handle('MESSAGE_CREATE', message());

  assert.deepEqual(calls.ensure, [{ sessionID: 'ses_1', channelID: 'chan_1' }]);
});

test('a recipient failure still records the message', async () => {
  let { instance, calls } = makeRouter({
    ensureSessionRecipient: async () => { throw new Error('no such agent'); },
  });

  let result = await instance.handle('MESSAGE_CREATE', message());

  // Losing the message because we could not provision a listener would be worse than
  // the defect being fixed. The frame is still a DiscordFrame.
  assert.equal(result.handled, true);
  assert.equal(calls.appendFrame.length, 1);
  assert.equal(calls.appendFrame[0].input.type, DISCORD_FRAME_TYPE);
  assert.equal(calls.log.some((entry) => entry.level === 'warn'), true);
});

test('an absent hook leaves the router working unchanged', async () => {
  let { instance, calls } = makeRouter();

  let result = await instance.handle('MESSAGE_CREATE', message());

  assert.equal(result.handled, true);
  assert.equal(calls.appendFrame.length, 1);
});

test('an unbound channel is refused before any provisioning is attempted', async () => {
  let { instance, calls } = makeRouter({ findChannelSession: async () => null });

  let result = await instance.handle('MESSAGE_CREATE', message({ channel_id: 'other' }));

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'unbound_channel');
  assert.equal(calls.ensure.length, 0);
});

test('a denied message is refused before any provisioning is attempted', async () => {
  let { instance, calls } = makeRouter({
    authorizeInbound: async () => ({ allowed: false, reason: 'no grant' }),
  });

  let result = await instance.handle('MESSAGE_CREATE', message());

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not_authorized');
  // A refused message must not be able to mutate the session it was refused for.
  assert.equal(calls.ensure.length, 0);
});

test('the bot and other bots never reach the provisioning step', async () => {
  let { instance, calls } = makeRouter();

  let own = await instance.handle('MESSAGE_CREATE', message({ author: { id: 'bot_1', username: 'miri', bot: true } }));
  let other = await instance.handle('MESSAGE_CREATE', message({
    id: 'msg_2',
    author: { id: 'bot_2', username: 'someone', bot: true },
  }));

  assert.equal(own.reason, 'own_message');
  assert.equal(other.reason, 'bot_author');
  assert.equal(calls.ensure.length, 0);
  assert.equal(calls.appendFrame.length, 0);
});
