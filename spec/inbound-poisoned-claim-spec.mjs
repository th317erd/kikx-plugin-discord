'use strict';

// A claim that is taken but never filled used to poison the message id forever.
//
// The contradiction this file pins:
//
//   claimMessage()  inserted (message_id, '', NULL, '') with DO NOTHING, so a
//                   second delivery conflicted and returned false -> 'duplicate'.
//   recordFrame()   is deliberately written to FILL such a row:
//                     ON CONFLICT (message_id) DO UPDATE ... WHERE frame_id IS NULL
//                   with the comment "a row whose frame_id is still NULL is an
//                   unfilled claim and may be completed".
//
// So the self-heal in recordFrame() was unreachable by construction: claimMessage()
// refused the message before handle() ever got back to recordFrame(). A row was left
// NULL whenever anything between the claim and recordFrame() failed - appendFrame()
// threw, or the process died mid-handle. The message was then lost permanently and
// silently, and edit tracking no-opped for it.
//
// WHAT CHANGED
//
// Two things, because one was not enough:
//
//   1. inbound-router.mjs releases the claim when appendFrame throws. Nothing was
//      written, so the claim protects nothing. This is the common case.
//   2. claimMessage() is now a single upsert (ON CONFLICT DO UPDATE ... RETURNING)
//      that may TAKE OVER a row only when it is provably abandoned: frame_id IS NULL
//      AND older than CLAIM_GRACE_SECONDS. This covers the case release can never
//      reach - the process died between claim and write, so no code ran at all.
//
// Condition 2 needs the time bound. "frame_id IS NULL" alone is not evidence of
// abandonment: a concurrent handler's claim-to-write window also has frame_id NULL,
// and reclaiming those is exactly the duplicate-frame race that claimMessage() was
// introduced to close (six DiscordFrame rows for four message ids, orders 4+5 and
// 7+8). A row that already has a frame is never taken over either - the mapping may
// be incomplete, but re-framing would duplicate the message.
//
// The predicate was verified against the live 3003 database in a rolled-back
// transaction: fresh id -> claimed; live claim -> not claimed; abandoned 10-minute
// claim -> claimed; already-framed row -> not claimed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordInboundRouter } from '../inbound-router.mjs';

const CLAIM_GRACE_SECONDS = 120;

// A faithful stand-in for discord_message_frame, including the exact semantics of the
// shipped upsert: the message id is the primary key, so the placeholder claim and the
// real record are the SAME row, and frame_id stays NULL until filled.
function makeStore({ now = () => Date.now() } = {}) {
  let rows = new Map();
  return {
    rows,
    // INSERT ... ON CONFLICT (message_id) DO UPDATE SET ... WHERE frame_id IS NULL
    // AND created_at < now() - grace RETURNING message_id
    claimMessage: async ({ messageID, sessionID }) => {
      let row = rows.get(messageID);
      if (!row) {
        rows.set(messageID, {
          message_id: messageID, session_id: sessionID, frame_id: null,
          original_text: '', created_at: now(),
        });
        return true;
      }
      let abandoned = row.frame_id === null
        && (now() - row.created_at) > CLAIM_GRACE_SECONDS * 1000;
      if (!abandoned) return false;
      // The takeover refreshes created_at, so a claim that keeps being abandoned
      // cannot be stolen in a tight loop by successive redeliveries.
      row.session_id = sessionID;
      row.created_at = now();
      return true;
    },
    // DELETE ... WHERE message_id = $1 AND frame_id IS NULL
    releaseClaim: async ({ messageID }) => {
      let row = rows.get(messageID);
      if (row && row.frame_id === null) rows.delete(messageID);
    },
    recordFrame: async ({ messageID, sessionID, frameID, text }) => {
      let row = rows.get(messageID);
      if (!row) {
        rows.set(messageID, {
          message_id: messageID, session_id: sessionID, frame_id: frameID,
          original_text: text, created_at: now(),
        });
        return;
      }
      // ... WHERE discord_message_frame.frame_id IS NULL
      if (row.frame_id === null) {
        row.session_id = sessionID;
        row.frame_id = frameID;
        row.original_text = text;
      }
    },
  };
}

function messageEvent(id, content = 'hello from the new Miri bot test') {
  return {
    id,
    channel_id: 'chan-1',
    content,
    author: { id: 'user-1', username: 'th317erd' },
  };
}

function makeRouter(store, overrides = {}) {
  let append = async () => ({ frame: { id: 'frame-1' }, commit: null, wakePending: false });
  let router = new DiscordInboundRouter({
    findChannelSession: async () => ({ session_id: 'session-1' }),
    claimMessage: store.claimMessage,
    releaseClaim: store.releaseClaim,
    recordFrame: store.recordFrame,
    appendFrame: (...args) => append(...args),
    authorizeInbound: async () => ({ allowed: true }),
    botUserID: () => 'bot-1',
    log: () => {},
    ...overrides,
  });
  return { router, failAppendWith: (f) => { append = f; } };
}

test('a failed appendFrame releases the claim, so the redelivery is framed', async () => {
  let store = makeStore();
  let { router, failAppendWith } = makeRouter(store);

  // First delivery: the append fails after the claim was taken.
  failAppendWith(async () => { throw new Error('appendFrame failed'); });
  await assert.rejects(() => router.handle('MESSAGE_CREATE', messageEvent('msg-1')), /appendFrame failed/);

  // The release means no stranded row survives to masquerade as a duplicate.
  assert.equal(store.rows.has('msg-1'), false,
    'a claim whose appendFrame threw must not be left behind');

  failAppendWith(async () => ({ frame: { id: 'frame-1' }, commit: null, wakePending: false }));
  let result = await router.handle('MESSAGE_CREATE', messageEvent('msg-1'));

  assert.equal(result.handled, true, 'the redelivery must be framed, not dropped as a duplicate');
  assert.equal(store.rows.get('msg-1').frame_id, 'frame-1', 'and the frame must be recorded');
});

// The case releaseClaim can never cover: the process died between claim and write, so
// no catch block ran and the row is still there. Only the SQL takeover can recover it -
// but only after the grace window, or it would steal a live handler's claim.
test('an abandoned claim is taken over by a later delivery, after the grace window', async () => {
  let clock = 1_000_000;
  let now = () => clock;
  let store = makeStore({ now });

  // Simulate a row left by a process that died: claim taken, no frame, no release.
  await store.claimMessage({ messageID: 'msg-1', sessionID: 'session-1' });
  assert.equal(store.rows.get('msg-1').frame_id, null);

  let { router } = makeRouter(store);

  // Inside the grace window the row is still assumed to belong to a live handler.
  clock += 30 * 1000;
  assert.equal((await router.handle('MESSAGE_CREATE', messageEvent('msg-1'))).handled, false,
    'a claim younger than the grace window must not be taken over');

  // Past the window the message is recovered rather than lost forever.
  clock += CLAIM_GRACE_SECONDS * 1000;
  let result = await router.handle('MESSAGE_CREATE', messageEvent('msg-1'));
  assert.equal(result.handled, true, 'an abandoned claim must not lose the message permanently');
  assert.equal(store.rows.get('msg-1').frame_id, 'frame-1');
});

// The regression that the time bound exists to protect. Two handlers for one message
// id, as two live gateways or a RESUME replay overlapping a create would produce.
test('two concurrent handlers for one message id produce exactly one frame', async () => {
  let store = makeStore();
  let frames = [];
  let append = async (sessionID, input) => {
    frames.push(input.content.discord.messageID);
    // Give the other handler time to run while this one is between claim and write,
    // which is precisely the window in which frame_id is still NULL.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { frame: { id: 'frame-' + frames.length }, commit: null, wakePending: false };
  };

  let { router } = makeRouter(store, { appendFrame: append });

  let results = await Promise.all([
    router.handle('MESSAGE_CREATE', messageEvent('msg-1')),
    router.handle('MESSAGE_CREATE', messageEvent('msg-1')),
  ]);

  assert.equal(frames.length, 1, 'exactly one frame must be written for one Discord message');
  assert.equal(results.filter((r) => r.handled === true).length, 1,
    'exactly one handler may report that it handled the message');
});
