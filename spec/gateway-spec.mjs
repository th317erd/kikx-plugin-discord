'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { DiscordGateway, OP, INTENTS, DEFAULT_INTENTS, GATEWAY_REST_URL } from '../gateway.mjs';

// A socket that records what was sent and lets the test drive inbound frames.
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
  }

  fire(type, event) {
    for (let fn of this.listeners.get(type) || []) fn(event);
  }

  async deliver(payload) {
    this.fire('message', { data: JSON.stringify(payload) });
    // handleMessage is async; let its microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  payloads(op) { return this.sent.filter((p) => p.op === op); }
}

function makeTimers() {
  let timers = [];
  return {
    timers,
    setTimeoutImpl: (fn, ms) => {
      let handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { if (handle) handle.cleared = true; },
    // Run the most recently scheduled, still-pending timer.
    runLast() {
      let pending = timers.filter((t) => !t.cleared && !t.ran);
      let handle = pending[pending.length - 1];
      assert.ok(handle, 'expected a pending timer');
      handle.ran = true;
      handle.fn();
      return handle;
    },
    pending() { return timers.filter((t) => !t.cleared && !t.ran); },
  };
}

function makeGateway(overrides = {}) {
  let timers = makeTimers();
  let logs = [];
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

// Bring a gateway up to the point where HELLO has arrived and IDENTIFY/RESUME was sent.
async function establish(gateway, helloInterval = 41250) {
  await gateway.start();
  let socket = gateway.socket;
  await socket.deliver({ op: OP.HELLO, d: { heartbeat_interval: helloInterval } });
  return socket;
}

test('start resolves the gateway URL over REST with a Bot authorization header', async () => {
  let seen = null;
  let { gateway, timers } = makeGateway({
    fetchImpl: async (url, init) => {
      seen = { url, auth: init?.headers?.Authorization };
      return { ok: true, json: async () => ({ url: 'wss://gateway.example' }) };
    },
  });
  await gateway.start();
  assert.equal(seen.url, GATEWAY_REST_URL);
  assert.equal(seen.auth, 'Bot test-token');
  // The REST url is a bare host; the client must add the version and encoding.
  assert.match(gateway.socket.url, /^wss:\/\/gateway\.example\/\?v=10&encoding=json$/);
  assert.equal(timers.pending().length, 0);
});

test('a bad token fails the REST call and reports the HTTP status instead of pretending to connect', async () => {
  let { gateway, timers, logs } = makeGateway({
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"401: Unauthorized"}' }),
  });
  await gateway.start();
  assert.equal(gateway.socket, null, 'no socket may be opened when the token is rejected');
  assert.equal(gateway.status().ready, false);
  let errorLog = logs.find((l) => l.level === 'error');
  assert.ok(errorLog, 'a rejected token must be logged as an error');
  assert.match(errorLog.message, /401/);
  assert.equal(timers.pending().length, 1, 'a transient REST failure still schedules a retry');
});

test('HELLO starts heartbeating and sends IDENTIFY with the configured intents', async () => {
  let { gateway, timers } = makeGateway();
  let socket = await establish(gateway);

  let identify = socket.payloads(OP.IDENTIFY);
  assert.equal(identify.length, 1);
  assert.equal(identify[0].d.token, 'test-token');
  assert.equal(identify[0].d.intents, DEFAULT_INTENTS);
  // MESSAGE_CONTENT must be in the default set; without it every message arrives empty.
  assert.ok(identify[0].d.intents & INTENTS.MESSAGE_CONTENT);

  // First heartbeat is jittered: random() is 0 here, so the jitter delay is 0.
  assert.equal(timers.pending().length, 1);
  assert.equal(socket.payloads(OP.HEARTBEAT).length, 0, 'no heartbeat before the timer fires');
  timers.runLast();
  let beats = socket.payloads(OP.HEARTBEAT);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].d, null, 'first heartbeat carries the sequence, which is still null');
});

test('heartbeat carries the latest sequence number', async () => {
  let { gateway, timers } = makeGateway();
  let socket = await establish(gateway);
  await socket.deliver({ op: OP.DISPATCH, t: 'READY', s: 7, d: { session_id: 'sess-1', user: { id: 'bot-1' } } });
  timers.runLast();
  let beats = socket.payloads(OP.HEARTBEAT);
  assert.equal(beats[beats.length - 1].d, 7);
});

test('an unacknowledged heartbeat reconnects rather than sitting on a zombie socket', async () => {
  let { gateway, timers, logs } = makeGateway();
  let socket = await establish(gateway);
  let first = gateway.socket;

  timers.runLast();                        // beat 1 sent, no ACK
  assert.equal(gateway.awaitingHeartbeatAck, true);
  timers.runLast();                        // beat 2 due while still unacked

  assert.ok(first.closed, 'the zombie socket must be closed');
  assert.equal(gateway.socket, null);
  assert.ok(logs.some((l) => /not acknowledged/.test(l.message)));
  assert.equal(timers.pending().length, 1, 'a reconnect is scheduled');
});

test('HEARTBEAT_ACK clears the pending flag so the next beat is sent', async () => {
  let { gateway, timers } = makeGateway();
  let socket = await establish(gateway);
  timers.runLast();
  assert.equal(gateway.awaitingHeartbeatAck, true);
  await socket.deliver({ op: OP.HEARTBEAT_ACK });
  assert.equal(gateway.awaitingHeartbeatAck, false);
  timers.runLast();
  assert.equal(socket.payloads(OP.HEARTBEAT).length, 2);
});

test('READY is the only thing that sets ready, and it records the session for resume', async () => {
  let { gateway } = makeGateway();
  let readyCalls = [];
  gateway.onReady = async (info) => readyCalls.push(info);
  let socket = await establish(gateway);

  assert.equal(gateway.status().ready, false, 'an open socket is not a session');
  await socket.deliver({
    op: OP.DISPATCH, t: 'READY', s: 1,
    d: { session_id: 'sess-abc', resume_gateway_url: 'wss://resume.example', user: { id: 'bot-9', username: 'kikx' } },
  });

  let status = gateway.status();
  assert.equal(status.ready, true);
  assert.equal(status.sessionID, 'sess-abc');
  assert.equal(status.userId, 'bot-9');
  assert.equal(readyCalls.length, 1);
  assert.equal(readyCalls[0].user.username, 'kikx');
});

test('a reconnect after READY RESUMEs against the resume url instead of re-identifying', async () => {
  let { gateway, timers } = makeGateway();
  let socket = await establish(gateway);
  await socket.deliver({
    op: OP.DISPATCH, t: 'READY', s: 42,
    d: { session_id: 'sess-abc', resume_gateway_url: 'wss://resume.example', user: { id: 'bot-9' } },
  });

  // Discord asks for a reconnect.
  await socket.deliver({ op: OP.RECONNECT });
  assert.equal(gateway.socket, null);

  // Advance the backoff timer: start() must build the resume URL, not call REST again.
  let before = FakeSocket.instances.length;
  timers.runLast();
  assert.equal(FakeSocket.instances.length, before + 1);
  let resumed = FakeSocket.instances[FakeSocket.instances.length - 1];
  assert.match(resumed.url, /^wss:\/\/resume\.example\/\?v=10&encoding=json$/);

  await resumed.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
  let resume = resumed.payloads(OP.RESUME);
  assert.equal(resume.length, 1);
  assert.equal(resume[0].d.session_id, 'sess-abc');
  assert.equal(resume[0].d.seq, 42);
  assert.equal(resumed.payloads(OP.IDENTIFY).length, 0, 'a live session must not be re-identified');
});

test('INVALID_SESSION with d=false clears the session so the next attempt identifies fresh', async () => {
  let { gateway, timers } = makeGateway();
  let socket = await establish(gateway);
  await socket.deliver({
    op: OP.DISPATCH, t: 'READY', s: 5,
    d: { session_id: 'sess-abc', resume_gateway_url: 'wss://resume.example', user: { id: 'bot-9' } },
  });
  await socket.deliver({ op: OP.INVALID_SESSION, d: false });

  assert.equal(gateway.sessionID, null);
  assert.equal(gateway.sequence, null);

  timers.runLast();
  let fresh = FakeSocket.instances[FakeSocket.instances.length - 1];
  assert.equal(fresh.url, 'wss://gateway.example/?v=10&encoding=json', 'must go back to the REST-provided host');
  await fresh.deliver({ op: OP.HELLO, d: { heartbeat_interval: 41250 } });
  assert.equal(fresh.payloads(OP.IDENTIFY).length, 1);
  assert.equal(fresh.payloads(OP.RESUME).length, 0);
});

test('dispatch events reach the handler, and one failing handler does not kill the transport', async () => {
  let { gateway, logs } = makeGateway();
  let received = [];
  gateway.onDispatch = async (type, data) => {
    if (type === 'MESSAGE_CREATE' && data.id === 'boom') throw new Error('handler exploded');
    received.push({ type, id: data.id });
  };
  let socket = await establish(gateway);

  await socket.deliver({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm1' } });
  await socket.deliver({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 3, d: { id: 'boom' } });
  await socket.deliver({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 4, d: { id: 'm2' } });

  assert.deepEqual(received.map((r) => r.id), ['m1', 'm2']);
  assert.ok(logs.some((l) => /handler failed for MESSAGE_CREATE/.test(l.message)));
  assert.equal(gateway.socket, socket, 'the socket must survive a handler error');
});

test('stop() closes the socket and stops reconnecting', async () => {
  let { gateway, timers } = makeGateway();
  let socket = await establish(gateway);
  gateway.stop();

  assert.equal(socket.closed.code, 1000);
  assert.equal(gateway.status().ready, false);
  assert.equal(timers.pending().length, 0, 'no timer may survive a deliberate stop');

  // A close event after stop must not schedule a reconnect.
  socket.fire('close', { code: 1000 });
  assert.equal(timers.pending().length, 0);
});

test('backoff grows and is capped so a long outage does not turn into hour-long gaps', async () => {
  let { gateway, timers } = makeGateway({ random: () => 1 });
  // Schedule repeatedly without connecting, and record the delays.
  let delays = [];
  for (let i = 0; i < 8; i++) {
    gateway.scheduleReconnect();
    let pending = timers.pending();
    delays.push(pending[pending.length - 1].ms);
  }
  assert.ok(delays[0] <= delays[1], 'delay must not shrink as attempts accumulate');
  assert.ok(Math.max(...delays) <= 30_000, `delays must stay capped, saw ${Math.max(...delays)}`);
});

test('construction refuses without a token or without a WebSocket implementation', () => {
  assert.throws(() => new DiscordGateway({}), /bot token/);
  let original = globalThis.WebSocket;
  try {
    // Simulate a runtime with no global WebSocket.
    let saved = globalThis.WebSocket;
    delete globalThis.WebSocket;
    assert.throws(
      () => new DiscordGateway({ token: 't', fetchImpl: async () => ({}) }),
      /WebSocket implementation/,
    );
    globalThis.WebSocket = saved;
  } finally {
    globalThis.WebSocket = original;
  }
});
