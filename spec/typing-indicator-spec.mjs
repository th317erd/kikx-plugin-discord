'use strict';

// =============================================================================
// The Discord typing indicator: POST /channels/{id}/typing, re-armed while the
// ai.thinking trigger says the agent works, stopped the moment it ends.
// =============================================================================
// Deterministic on purpose: a fake clock and fake timers replace the real ones,
// so the 8s re-arm, the 60s hard cap and the 15s watchdog are asserted without
// sleeping for any of them. The adapter's event CLASSIFICATION (tool frames,
// open-vs-closed AgentMessage, the 3s idle throttle) lives in
// spec/thinking-adapter-spec.mjs — this spec drives the consumer side through
// onThinking({ sessionID, phase }).
//
// What must hold:
//   1. an ai.thinking start in a bound session arms typing ONCE, with THAT
//      channel's token (the same identity the reply will carry);
//   2. more phases inside the window EXTEND it — they never multiply the POSTs
//      (rate-limit rule 2, proven at the 3s heartbeat cadence);
//   3. 'end' / a landed send / stopAll() end the window for good;
//   4. [tool frames never reach here — the adapter drops them; proven in the
//      adapter spec as rule 4];
//   5. the 60s cap closes even a forever-working agent's window;
//   6. NEGATIVE CONTROL: an unbound session resolves to no channel and performs
//      ZERO typing calls — no token read, no fetch, no timer;
//   7. the 15s watchdog self-clears a silent trigger, LOG-ONLY: it must never
//      mutate lastTypingOutcome (the d6fc22b "last POST outcome" contract), and
//      it reports at most once per channel.
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

function harness({ bindings = { ses_1: 'chan_1' }, token = 'squeak-token', status = 204, armMs = 8000, capMs = 60000, thinkingIdleMs } = {}) {
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
    ...(thinkingIdleMs === undefined ? {} : { thinkingIdleMs }),
    nowImpl: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  });

  // One ai.thinking phase in — the ONLY signal the indicator consumes now.
  const think = (sessionID, phase, channelID = undefined) =>
    indicator.onThinking({ sessionID, phase, ...(channelID ? { channelID } : {}) });

  return { indicator, clock, posts, logs, tokenReads, think };
}

test('a thinking start arms typing once, with the channel\u2019s token', async () => {
  let { indicator, posts, tokenReads, think } = harness();

  think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));   // let the POST settle

  assert.equal(posts.length, 1, 'arming posts exactly once');
  assert.equal(posts[0].url, 'https://discord.com/api/v10/channels/chan_1/typing');
  assert.equal(posts[0].auth, 'Bot squeak-token');
  assert.deepEqual(tokenReads, ['chan_1'], 'the token is resolved FOR the channel');
  assert.equal(indicator.openCount(), 1, 'one window is open');
  assert.equal(indicator.watchdogCount(), 1, 'one session watchdog guards it');
});

test('heartbeats inside the window extend it without multiplying the POSTs', async () => {
  let { indicator, clock, posts, logs, think } = harness();

  think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1);

  // A token-by-token stream: idles every second. Each extends the 8s timer, so
  // nothing re-posts while the window stays open — rate-limit rule 2.
  for (let i = 0; i < 7; i++) {
    think('ses_1', 'idle');
    clock.advance(1000);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1, 'heartbeats may not multiply typing POSTs');

  // Without the last extension the window would have closed at t+8s; the stream
  // pushed the due time to t+7s+8s, so advancing to just before that stays quiet…
  clock.advance(7000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 2, 'the extended window re-arms exactly once more');
  assert.equal(indicator.openCount(), 1, 'exactly one live window');
  assert.equal(indicator.watchdogCount(), 1, 'and one watchdog (renewed by the heartbeats)');
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, 0, 'a healthy stream trips no watchdog');
});

test('an end phase stops the window for good', async () => {
  let { indicator, clock, posts, think } = harness();

  think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));
  think('ses_1', 'end');
  assert.equal(indicator.openCount(), 0, 'the end must close the window');
  assert.equal(indicator.watchdogCount(), 0, 'and disarm the session watchdog');

  clock.advance(120_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1, 'no re-arm may follow the end');
});

test('a landed send stops the window (noteSent); tool frames are proven at the adapter', async () => {
  let { indicator, clock, posts, think } = harness();

  think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));
  indicator.noteSent('chan_1');
  assert.equal(indicator.openCount(), 0, 'noteSent must close the window');

  // The /ToolFrame$/ frames that record the send arrive right after — they never
  // reach the indicator at all (thinking.mjs never emits a phase for them; rule 4
  // is proven in spec/thinking-adapter-spec.mjs), so nothing restarts typing here.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1, 'no phase may restart typing over the delivered reply');

  clock.advance(120_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1);
  indicator.stopAll();   // disarm the leftover watchdog from the start phase
});

test('the hard cap closes a forever-working agent\u2019s window', async () => {
  // thinkingIdleMs is set far past the run so this isolates the CAP alone: the
  // watchdog's own behaviour has its own tests below. With no heartbeats the
  // window behaves exactly as the cap contract says — ticks every 8s until 60s.
  let { indicator, clock, posts, think } = harness({ armMs: 8000, capMs: 60000, thinkingIdleMs: 600_000 });

  think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));

  // One advance past the cap: ticks fire at 8s..56s (re-posts), and the tick that
  // lands at >=60s must close without posting again.
  clock.advance(70_000);
  await new Promise((resolve) => setImmediate(resolve));

  // 1 initial + re-arms at 8,16,24,32,40,48,56s = 8; the >=60s tick posts nothing.
  assert.equal(posts.length, 8, 'typing must stop at the cap, not keep re-arming');
  assert.equal(indicator.openCount(), 0, 'no window may outlive the cap');
  clock.advance(300_000);
  assert.equal(posts.length, 8, 'closed means closed until a new phase opens it');
  indicator.stopAll();
  assert.equal(clock.pending(), 0, 'stopAll clears the leftover long-idle watchdog');
});

test('NEGATIVE CONTROL: an unbound session performs ZERO typing calls', async () => {
  let { indicator, clock, posts, tokenReads, logs, think } = harness({
    bindings: {},                       // no session resolves to a channel
  });

  think('ses_unbound', 'start');
  think('ses_unbound', 'idle');
  clock.advance(120_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(posts.length, 0, 'an unbound session must never reach the typing endpoint');
  assert.equal(tokenReads.length, 0, 'nor may it read a token');
  assert.equal(logs.length, 0, 'nor log anything');
  assert.equal(indicator.openCount(), 0, 'nor open a window');
  assert.equal(indicator.watchdogCount(), 0, 'nor arm a watchdog');
});

test('a 403 is reported (a real permission fact); a 204 owes no WARN; neither throws', async () => {
  let refused = harness({ status: 403 });
  refused.think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refused.posts.length, 1, 'a refused POST is fire-and-forget, not a throw');

  // Level-filtered, never positional: arming also emits exactly one info line,
  // so each level is counted on its own instead of by index into a shared array.
  let warns = refused.logs.filter((entry) => entry.level === 'warn');
  assert.equal(warns.length, 1, 'exactly one warn: the refusal fact is owed');
  assert.match(warns[0].message, /chan_1.*403/);
  let infos = refused.logs.filter((entry) => entry.level === 'info');
  assert.equal(infos.length, 1, 'exactly one arm line: arming is observable too');
  assert.match(infos[0].message, /typing armed in channel chan_1/);
  assert.equal(refused.indicator.lastTypingOutcome().result, '403', 'the outcome is recorded for /status');

  let ok = harness({ status: 204 });
  ok.think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ok.logs.filter((entry) => entry.level === 'warn').length, 0, 'success owes no WARN');
  assert.equal(ok.logs.filter((entry) => entry.level === 'info').length, 1, 'the arm info line is expected on success too');
  assert.equal(ok.indicator.lastTypingOutcome().result, '204', 'success is silent in the journal, visible in /status');
  ok.indicator.stopAll();
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

  indicator.onThinking({ sessionID: 'ses_1', phase: 'start' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 0, 'an unauthenticated typing call must not be attempted');
});

test('stopAll clears every open window and watchdog (onShutdown path)', async () => {
  let { indicator, think } = harness({ bindings: { a: 'chan_a', b: 'chan_b' } });

  think('a', 'start');
  think('b', 'start');
  assert.equal(indicator.openCount(), 2);
  assert.equal(indicator.watchdogCount(), 2);

  indicator.stopAll();
  assert.equal(indicator.openCount(), 0, 'shutdown must not leave timers posting');
  assert.equal(indicator.watchdogCount(), 0, 'nor a watchdog to fire later');
});

test('rate-limit rule 2 at the 3s heartbeat cadence: no multiplied POSTs, no false watchdog', async () => {
  // The exact cadence the contract allows (idle ≤5s; we emit at most every 3s).
  // Ten idles spanning 30s: the window must extend throughout (one POST), the
  // watchdog must never trip (it only fires after 15s of SILENCE), and when the
  // heartbeats stop the system must settle honestly (one re-arm, then the
  // watchdog clears the silent window).
  let { indicator, clock, posts, logs, think } = harness();

  think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1);

  for (let i = 0; i < 10; i++) {
    think('ses_1', 'idle');          // exactly the 3s throttle cadence
    clock.advance(3000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(posts.length, 1, '3s heartbeats may not multiply POSTs (rule 2)');
  assert.equal(indicator.openCount(), 1, 'window alive throughout the stream');
  assert.equal(indicator.watchdogCount(), 1, 'watchdog renewed by every heartbeat');
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, 0, 'a healthy cadence trips no watchdog');

  // Heartbeats stop at t≈30s: the window's tick lands 8s after the last extend,
  // then the watchdog clears the silent window 15s after the last heartbeat.
  clock.advance(8000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 2, 'the final extension re-arms exactly once');
  clock.advance(7000);               // last heartbeat + 15s watchdog boundary
  await new Promise((resolve) => setImmediate(resolve));
  let warns = logs.filter((entry) => entry.level === 'warn');
  assert.equal(warns.length, 1, 'exactly one watchdog report for the silence');
  assert.match(warns[0].message, /typing trigger silent in channel chan_1.*watchdog/);
  assert.equal(indicator.openCount(), 0, 'the silent window is cleared');
  assert.equal(indicator.watchdogCount(), 0, 'and the watchdog disarmed');
  clock.advance(60_000);
  assert.equal(posts.length, 2, 'nothing may re-arm without a heartbeat');
});

test('WATCHDOG IS LOG-ONLY: firing never mutates lastTypingOutcome', async () => {
  // The d6fc22b contract: lastTypingOutcome is "the last DISCORD POST outcome".
  // The watchdog is a TRIGGER fact — if it recorded, it would overwrite a real
  // '204' with 'error' and destroy the observability this branch exists to keep.
  let { indicator, clock, posts, logs, think } = harness();

  think('ses_1', 'start');
  await new Promise((resolve) => setImmediate(resolve));   // POST #1 -> '204'
  assert.equal(indicator.lastTypingOutcome().result, '204');

  // The 8s tick posts once more and SETTLES first, so the outcome in hand when
  // the watchdog fires is a real, fully-recorded POST outcome.
  clock.advance(8000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 2, 'the tick posted once before the silence');
  assert.equal(indicator.lastTypingOutcome().result, '204');
  let outcomeRef = indicator.lastTypingOutcome();

  clock.advance(7000);               // last heartbeat + 15s: watchdog fires
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(indicator.lastTypingOutcome(), outcomeRef,
    'the watchdog must NOT replace the recorded POST outcome (same object)');
  assert.equal(indicator.lastTypingOutcome().result, '204');
  let warns = logs.filter((entry) => entry.level === 'warn');
  assert.equal(warns.length, 1, 'the watchdog reports exactly once — as a log line');
  assert.match(warns[0].message, /typing trigger silent in channel chan_1.*watchdog/);
  assert.equal(indicator.openCount(), 0, 'but it still clears the stuck window');
  assert.equal(posts.length, 2, 'and posts nothing itself (t0 arm + the 8s tick only)');
});

test('two sessions on ONE channel: the watchdog reports silence at most once', async () => {
  let { indicator, clock, posts, logs, think } = harness({
    bindings: { ses_a: 'chan_shared', ses_b: 'chan_shared' },
  });

  think('ses_a', 'start');
  think('ses_b', 'start');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1, 'both sessions share one window, one POST');

  clock.advance(15_000);             // both watchdogs come due
  await new Promise((resolve) => setImmediate(resolve));

  let warns = logs.filter((entry) => entry.level === 'warn');
  assert.equal(warns.length, 1, 'one channel, one silence report — never a duplicate');
  assert.match(warns[0].message, /typing trigger silent in channel chan_shared.*watchdog/);
  assert.equal(indicator.openCount(), 0, 'the shared window is cleared');
});
