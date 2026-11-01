'use strict';

// One Discord message must become one frame, even when two handlers see it at once.
//
// THE DEFECT, measured on the live 3003 store:
//   order 4 | msg 1566145914500812811   and   order 5 | msg 1566145914500812811
//   order 7 | msg 1566146189043433596   and   order 8 | msg 1566146189043433596
// Six DiscordFrame rows, four distinct Discord message ids. The duplicate pairs are
// milliseconds apart with different interaction ids, i.e. two handlers acting on the
// same MESSAGE_CREATE.
//
// Why the old code allowed it: handle() did `if (await seenMessage(id)) return` near the
// top and then called recordFrame() only after appending the frame - roughly seventy
// lines and an await-heavy route later. Two handlers both read "not seen", both appended,
// and recordFrame()'s `ON CONFLICT (message_id) DO NOTHING` silently dropped the second
// mapping row. The table looked consistent, which is why the duplication hid.
//
// claimMessage() replaces that read with an atomic INSERT ... ON CONFLICT DO NOTHING
// RETURNING: the database decides the winner, so the window closes.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordInboundRouter } from '../inbound-router.mjs';

function baseOptions(overrides = {}) {
  return {
    findChannelSession: async () => ({ session_id: 'session-1' }),
    recordFrame: async () => {},
    appendFrame: async () => ({ frame: { id: 'frame-1' }, commit: null, wakePending: false }),
    authorizeInbound: async () => ({ allowed: true }),
    botUserID: () => 'bot-1',
    log: () => {},
    ...overrides,
  };
}

function messageEvent(id, content = 'hello') {
  return {
    id,
    channel_id: 'chan-1',
    content,
    author: { id: 'user-1', username: 'th317erd' },
  };
}

test('two concurrent handlers frame a message exactly once', async () => {
  // A faithful stand-in for INSERT ... ON CONFLICT DO NOTHING RETURNING: the first
  // caller gets the row back, every later caller gets nothing.
  let claimed = new Set();
  let frames = [];
  let router = new DiscordInboundRouter(baseOptions({
    claimMessage: async ({ messageID }) => {
      // Yield between the check and the insert, which is exactly the interleaving the
      // real defect needed.
      await new Promise((resolve) => setImmediate(resolve));
      if (claimed.has(messageID)) return false;
      claimed.add(messageID);
      return true;
    },
    appendFrame: async (sessionID, input) => {
      await new Promise((resolve) => setImmediate(resolve));
      frames.push({ sessionID, type: input.type, messageID: input.content?.discord?.messageID });
      return { frame: { id: 'frame-' + frames.length }, commit: null, wakePending: false };
    },
  }));

  let data = messageEvent('msg-dupe');
  let results = await Promise.all([router.handle('MESSAGE_CREATE', data), router.handle('MESSAGE_CREATE', data)]);

  assert.equal(frames.length, 1, 'one Discord message must produce one frame, not ' + frames.length);
  let handled = results.filter((r) => r.handled === true).length;
  let dupes = results.filter((r) => r.reason === 'duplicate').length;
  assert.equal(handled, 1, 'exactly one handler should report it framed the message');
  assert.equal(dupes, 1, 'the other handler should be told it was a duplicate');
});

test('without claimMessage the router still dedupes a sequential redelivery', async () => {
  // The fallback path. A gateway RESUME replay arrives after the first one finished, so
  // the read-based check is sufficient there; it is only concurrent delivery it cannot
  // handle. This guards against the change breaking the common case.
  let frames = [];
  let store = new Set();
  let router = new DiscordInboundRouter(baseOptions({
    seenMessage: async (id) => store.has(id),
    recordFrame: async ({ messageID }) => { store.add(messageID); },
    appendFrame: async (sessionID, input) => {
      frames.push(input.content?.discord?.messageID);
      return { frame: { id: 'frame-' + frames.length }, commit: null, wakePending: false };
    },
  }));

  let data = messageEvent('msg-replay');
  let first = await router.handle('MESSAGE_CREATE', data);
  let second = await router.handle('MESSAGE_CREATE', data);

  assert.equal(first.handled, true);
  assert.equal(second.handled, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(frames.length, 1, 'a replay must not add a second frame');
});

test('a claim that is lost does not frame, and does not touch the session', async () => {
  let frames = [];
  let router = new DiscordInboundRouter(baseOptions({
    claimMessage: async () => false,
    appendFrame: async () => { frames.push('x'); return { frame: { id: 'f' } }; },
  }));

  let result = await router.handle('MESSAGE_CREATE', messageEvent('msg-already-claimed'));

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'duplicate');
  assert.equal(frames.length, 0, 'a message another handler already claimed must not be framed again');
});
