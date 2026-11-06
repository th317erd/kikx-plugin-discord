'use strict';

// =============================================================================
// The Discord typing indicator: POST /channels/{id}/typing, re-armed while the
// agent works, stopped the moment the answer exists.
// =============================================================================
// Deterministic on purpose: a fake clock and fake timers replace the real ones,
// so the 8s re-arm and the 60s hard cap are asserted without sleeping for either.
//
// What must hold:
//   1. a frame event in a bound session arms typing ONCE, with THAT channel's
//      token (the same identity the reply will carry);
//   2. more frame events inside the window EXTEND it — they never multiply the
//      POSTs (a token-by-token stream must not be a rate-limit incident);
//   3. AgentMessage / a landed send / stopAll() end the window for good;
//   4. tool-call frames never arm it (typing after the answer is a lie);
//   5. the 60s cap closes even a forever-working agent's window;
//   6. NEGATIVE CONTROL: an unbound session resolves to no channel and performs
//      ZERO typing calls — no token read, no fetch, no timer.
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTypingIndicator } from '../typing.mjs';

// Fake clock + timers. advance() runs every task due at or before the new now,
// in due order, including tasks those runs schedule while still due.
function fakeClock() {
  let nextID = 1;
  let now = 1_000_000;
  let tasks = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { let id = nextID++; tasks.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { tasks.delete(id); },
    pending: () => tasks.size,
    // Runs due timers AT THEIR DUE TIME, not at the final time: real timers fire
    // when they come due, and a cap check that saw only the end of a 70s jump
    // would model a clock no process has.
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let nextID = null;
        let nextAt = Infinity;
        for (let [id, task] of tasks) {
          if (task.at <= target && task.at < nextAt) { nextID = id; nextAt = task.at; }
        }
        if (nextID === null) break;
        now = tasks.get(nextID).at;
        let fn = tasks.get(nextID).fn;
        tasks.delete(nextID);
        fn();
      }
      now = target;
    },
  };
}

function harness({ bindings = { ses_1: 'chan_1' }, token = 'squeak-token', status = 204, armMs = 8000, capMs = 60000 } = {}) {
  let clock = fakeClock();
  let posts = [];
  let logs = [];
  let tokenReads = [];

  let indicator = createTypingIndicator({
    resolveChannel: (sessionID) => bindings[sessionID] || null,
    tokenForChannel: async (channelID) => { tokenReads.push(channelID); return token; },
    log: (level, message) => logs.push({ level, message }),
    fetchImpl: async (url, init) => {
      posts.push({ url: String(url), auth: init.headers.Authorization });
      return { status };
    },
    armMs,
    capMs,
    nowImpl: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  });

  let frameEvent = (type, sessionID = 'ses_1') => ({ type: 'frame.added', sessionID, frame: { id: 'f1', type } });

  return { indicator, clock, posts, logs, tokenReads, frameEvent };
}

test('a frame event in a bound session arms typing once, with the channel\u2019s token', async () => {
  let { indicator, posts, tokenReads, frameEvent } = harness();

  indicator.onEvent(frameEvent('BeginTyping'));
  await new Promise((resolve) => setImmediate(resolve));   // let the POST settle

  assert.equal(posts.length, 1, 'arming posts exactly once');
  assert.equal(posts[0].url, 'https://discord.com/api/v10/channels/chan_1/typing');
  assert.equal(posts[0].auth, 'Bot squeak-token');
  assert.deepEqual(tokenReads, ['chan_1'], 'the token is resolved FOR the channel');
});

test('frame events inside the window extend it without multiplying the POSTs', async () => {
  let { indicator, clock, posts, frameEvent } = harness();

  indicator.onEvent(frameEvent('BeginTyping'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1);

  // A token-by-token stream: deltas every second. Each extends the 8s timer, so
  // nothing re-posts while the window stays open.
  for (let i = 0; i < 7; i++) {
    indicator.onEvent(frameEvent('AgentDelta'));
    clock.advance(1000);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1, 'deltas may not multiply typing POSTs');

  // Without the last extension the window would have closed at t+8s; the stream
  // pushed the due time to t+7s+8s, so advancing to just before that stays quiet…
  clock.advance(7000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 2, 'the extended window re-arms exactly once more');
  assert.equal(clock.pending(), 1, 'exactly one live timer per channel');
});

test('AgentMessage — the turn answered — stops the window for good', async () => {
  let { indicator, clock, posts, frameEvent } = harness();

  indicator.onEvent(frameEvent('BeginTyping'));
  await new Promise((resolve) => setImmediate(resolve));
  indicator.onEvent(frameEvent('AgentMessage'));
  assert.equal(clock.pending(), 0, 'the terminal frame must clear the timer');

  clock.advance(120_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1, 'no re-arm may follow the final answer');
});

test('a landed send stops the window (noteSent), and tool frames never arm it', async () => {
  let { indicator, clock, posts, frameEvent } = harness();

  indicator.onEvent(frameEvent('BeginTyping'));
  await new Promise((resolve) => setImmediate(resolve));
  indicator.noteSent('chan_1');
  assert.equal(clock.pending(), 0, 'noteSent must clear the timer');

  // The tool frame that RECORDS the send arrives right after: it must not restart
  // typing over the reply that was just delivered.
  indicator.onEvent(frameEvent('DiscordSendToolFrame'));
  indicator.onEvent(frameEvent('ExampleToolFrame'));   // core's convention: /ToolFrame$/ (frame-engine.mjs:624)
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1, 'tool frames must never arm typing');

  clock.advance(120_000);
  assert.equal(posts.length, 1);
});

test('the hard cap closes a forever-working agent\u2019s window', async () => {
  let { indicator, clock, posts, frameEvent } = harness();   // arm 8000, cap 60000

  indicator.onEvent(frameEvent('BeginTyping'));
  await new Promise((resolve) => setImmediate(resolve));

  // One advance past the cap: ticks fire at 8s..56s (re-posts), and the tick that
  // lands at >=60s must close without posting again.
  clock.advance(70_000);
  await new Promise((resolve) => setImmediate(resolve));

  // 1 initial + re-arms at 8,16,24,32,40,48,56s = 8; the >=60s tick posts nothing.
  assert.equal(posts.length, 8, 'typing must stop at the cap, not keep re-arming');
  assert.equal(clock.pending(), 0, 'no timer may outlive the cap');
  clock.advance(300_000);
  assert.equal(posts.length, 8, 'closed means closed until a new frame event opens it');
});

test('NEGATIVE CONTROL: an unbound session performs ZERO typing calls', async () => {
  let { indicator, clock, posts, tokenReads, logs, frameEvent } = harness({
    bindings: {},                       // no session resolves to a channel
  });

  indicator.onEvent(frameEvent('BeginTyping', 'ses_unbound'));
  indicator.onEvent(frameEvent('AgentDelta', 'ses_unbound'));
  clock.advance(120_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(posts.length, 0, 'an unbound session must never reach the typing endpoint');
  assert.equal(tokenReads.length, 0, 'nor may it read a token');
  assert.equal(logs.length, 0, 'nor log anything');
  assert.equal(clock.pending(), 0, 'nor arm a timer');
});

test('a 403 is reported (a real permission fact); a 204 is silent; neither throws', async () => {
  let refused = harness({ status: 403 });
  refused.indicator.onEvent(refused.frameEvent('BeginTyping'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refused.posts.length, 1, 'a refused POST is fire-and-forget, not a throw');
  assert.equal(refused.logs.length, 1);
  assert.equal(refused.logs[0].level, 'warn');
  assert.match(refused.logs[0].message, /chan_1.*403/);

  let ok = harness({ status: 204 });
  ok.indicator.onEvent(ok.frameEvent('BeginTyping'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ok.logs.length, 0, 'success owes no log line');
});

test('no token for the channel means no fetch at all', async () => {
  let clock = fakeClock();
  let posts = [];
  let indicator = createTypingIndicator({
    resolveChannel: () => 'chan_1',
    tokenForChannel: async () => null,
    log: () => {},
    fetchImpl: async (...args) => { posts.push(args); return { status: 204 }; },
    nowImpl: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  });

  indicator.onEvent({ type: 'frame.added', sessionID: 'ses_1', frame: { id: 'f', type: 'BeginTyping' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 0, 'an unauthenticated typing call must not be attempted');
});

test('stopAll clears every open channel (onShutdown path)', async () => {
  let { indicator, frameEvent } = harness({ bindings: { a: 'chan_a', b: 'chan_b' } });

  indicator.onEvent(frameEvent('BeginTyping', 'a'));
  indicator.onEvent(frameEvent('BeginTyping', 'b'));
  assert.equal(indicator.openCount(), 2);

  indicator.stopAll();
  assert.equal(indicator.openCount(), 0, 'shutdown must not leave timers posting');
});
