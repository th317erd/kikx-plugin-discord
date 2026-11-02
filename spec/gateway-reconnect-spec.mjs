'use strict';

// One close must cost ONE reconnect attempt.
//
// MEASURED ON LIVE 3003 (pid 1518958, ~22 minutes): 81 "gateway reconnecting"
// against 19 "gateway ready", with the attempt counter reaching 23 and the delay
// pinned at the 30s cap (MAX_RECONNECT_DELAY_MS). A bot that spends minutes in
// backoff is a bot that misses messages, which is exactly the "good enough to
// limp along" bar the owner asked about.
//
// CAUSE, READ FROM SOURCE. closeAndReconnect() does both of these:
//
//       this.socket = null;
//       socket?.close(4000, 'reconnect');   // -> the close listener runs
//       this.scheduleReconnect();           // -> and then this runs again
//
// The close listener has no identity check, so a close from a socket that is no
// longer `this.socket` still schedules. The comment in the code claimed
// "scheduleReconnect clears any pending timer first, so a double schedule
// collapses into one" -- and the TIMER does collapse, but scheduleReconnect
// increments `attempt` before setting it, so the collapse is only of the timer.
// Two calls burn two backoff steps: attempt goes 1 -> 3, delay 4x. That is the
// doubling.
//
// WHAT THIS FILE ASSERTS:
//   1. An operator reconnect produces exactly ONE connect attempt.
//   2. It advances the backoff counter by exactly one, not two.
//   3. A close from a SUPERSEDED socket is ignored. This is the same bug wearing
//      its other hat: a late close event from an old socket must not reconnect
//      into the socket that replaced it, or one outage spawns a storm.
//   4. A genuine close still reconnects -- the fix must not silence reconnection.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordGateway, OP } from '../gateway.mjs';

class FakeSocket {
  static instances = [];
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  send(raw) { this.sent.push(JSON.parse(raw)); }

  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
    // A real WebSocket fires 'close' asynchronously after close() is called. The
    // production path depends on that ordering, so the fake reproduces it: here it
    // fires SYNCHRONOUSLY, which is the harsher case for the fix under test.
    this.fire('close', { code, reason });
  }

  fire(type, event) {
    for (let fn of this.listeners.get(type) || []) fn(event);
  }

  async deliver(payload) {
    this.fire('message', { data: JSON.stringify(payload) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeTimers() {
  let timers = [];
  return {
    timers,
    setTimeoutImpl: (fn, ms) => {
      let handle = { fn, ms, cleared: false, ran: false };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { if (handle) handle.cleared = true; },
    pending() { return timers.filter((handle) => !handle.cleared && !handle.ran); },
    async runAll() {
      let ran = 0;
      for (let handle of timers) {
        if (handle.cleared || handle.ran) continue;
        handle.ran = true;
        handle.fn();
        ran += 1;
      }
      // The timer callback calls start(), which resolves the gateway URL over fetch
      // before constructing a socket. Without letting those microtasks settle, a
      // caller reads FakeSocket.instances before the socket exists and sees 0.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return ran;
    },
  };
}

function makeGateway(overrides = {}) {
  let timers = makeTimers();
  let logs = [];
  FakeSocket.instances = [];

  let gateway = new DiscordGateway({
    token: 'test-token',
    WebSocketImpl: FakeSocket,
    fetchImpl: async () => ({ ok: true, json: async () => ({ url: 'wss://gateway.example' }) }),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    random: () => 0,
    log: (level, message) => logs.push({ level, message }),
    ...overrides,
  });

  return { gateway, timers, logs };
}

function reconnectLogs(logs) {
  return logs.filter((entry) => /gateway reconnecting/.test(entry.message));
}

test('an operator reconnect produces exactly ONE connect attempt', async () => {
  let { gateway, timers, logs } = makeGateway();

  await gateway.start();
  let socket = gateway.socket;
  await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });

  let socketsBefore = FakeSocket.instances.length;

  // The exact call Discord's OP 7 RECONNECT takes through this client.
  gateway.closeAndReconnect();

  let scheduled = reconnectLogs(logs);
  assert.equal(scheduled.length, 1,
    'one reconnect must be scheduled once; got ' + scheduled.length + ' schedules: '
    + scheduled.map((entry) => entry.message).join(' | '));

  assert.equal(timers.pending().length, 1, 'exactly one reconnect timer may be pending');

  // Fire it: this is the connect attempt.
  await timers.runAll();
  let created = FakeSocket.instances.length - socketsBefore;
  assert.equal(created, 1,
    'one reconnect must create exactly one socket attempt; got ' + created);
});

test('one reconnect advances the backoff counter by exactly one step', async () => {
  let { gateway, timers, logs } = makeGateway();

  await gateway.start();
  await gateway.socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });

  let attemptBefore = gateway.attempt;
  gateway.closeAndReconnect();

  let after = reconnectLogs(logs);
  assert.equal(after.length, 1, 'expected a single reconnect schedule');

  // The logged attempt number is the observable the owner saw climb to 23.
  let loggedAttempt = Number((after[0].message.match(/attempt (\d+)/) || [])[1]);
  assert.equal(loggedAttempt, attemptBefore + 1,
    'the first reconnect after a session must be attempt ' + (attemptBefore + 1)
    + ', got ' + loggedAttempt + ' (a two-step jump means the close was double-counted)');

  assert.equal(gateway.attempt, attemptBefore + 1,
    'the counter must advance once per close, not once per scheduleReconnect call');
});

test('a close from a superseded socket does not trigger a reconnect', async () => {
  let { gateway, timers, logs } = makeGateway();

  await gateway.start();
  let first = gateway.socket;
  await first.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });

  // Replace the socket the way a successful reconnect would.
  gateway.closeAndReconnect();
  await timers.runAll();
  let second = gateway.socket;
  assert.ok(second, 'the reconnect must have produced a new socket');
  assert.notEqual(second, first);

  logs.length = 0;
  let schedulesBefore = reconnectLogs(logs).length;
  assert.equal(schedulesBefore, 0);

  // Now the OLD socket reports its close late. It is no longer the live socket, so
  // it must be ignored -- reconnecting here would tear down the socket that just
  // came up, which is how one error becomes a storm.
  first.fire('close', { code: 1006 });

  assert.equal(reconnectLogs(logs).length, 0,
    'a close from a superseded socket must not schedule a reconnect');
  assert.equal(timers.pending().length, 0,
    'a superseded socket must not leave a reconnect timer behind');
  assert.equal(gateway.socket, second, 'the live socket must be untouched');
});

test('a genuine close of the CURRENT socket still reconnects', async () => {
  // The regression guard for the fix itself: an identity check that is too eager
  // would make the gateway silently stop reconnecting, which is worse than a
  // doubled backoff because nothing retries at all.
  let { gateway, timers, logs } = makeGateway();

  await gateway.start();
  let socket = gateway.socket;
  await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });

  socket.fire('close', { code: 1006 });

  let scheduled = reconnectLogs(logs);
  assert.equal(scheduled.length, 1, 'a real close must schedule exactly one reconnect');
  assert.equal(timers.pending().length, 1);
});
