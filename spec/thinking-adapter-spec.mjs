'use strict';

// =============================================================================
// The ai.thinking trigger adapter (thinking.mjs): core's frame events IN, the
// contract's start / idle / end phases OUT — the layer that makes typing, and
// any future subscriber, independent of inbound traffic.
// =============================================================================
// Measured inputs (frame-runtime.mjs): frame.added / frame.updated /
// frame.phantom / commit all arrive as { type, sessionID, frame }, and
// 'tokens.updated' spreads an ARBITRARY payload — so the type gate must run
// before any frame access.
//
// What must hold:
//   1. a non-tool frame in a scoped session derives 'start', then 'idle' for
//      later frames — never more than one phase per idleThrottleMs (3s);
//   2. an OPEN AgentMessage (streaming target) derives start/idle, NEVER 'end'
//      — the frame closes (content.status 'complete' or lifecycle.status
//      'closed', frame-engine.mjs:572) when the answer is done; ending on the
//      open frame is the flicker failure mode;
//   3. a CLOSED AgentMessage derives 'end{complete}' and resets the throttle;
//   4. /ToolFrame$/ frames derive NOTHING (rule 4: typing after the answer is
//      a lie) — proven on the frames the send path really emits;
//   5. a payload shaped like a frame but typed otherwise (tokens.updated) is
//      ignored — the gate precedes the shape;
//   6. NEGATIVE CONTROL: an unscoped subscriber receives nothing (bus parity,
//      plugin-events.mjs drops allowed===null), and a session outside a scoped
//      subscription's set receives nothing;
//   7. the emitted payload carries the contract fields: type, sessionID, phase,
//      at, and channelID/botKey when the binding maps answer them.
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';

import { createThinkingAdapter } from '../thinking.mjs';

function collect({ bindings = { ses_1: 'chan_1' }, botKeys = { chan_1: 'squeak' }, now = 1_000_000, idleThrottleMs = 3000, sessions = ['ses_1'] } = {}) {
  let events = [];
  let clock = { t: now };
  let adapter = createThinkingAdapter({
    resolveChannel: (sessionID) => bindings[sessionID] || null,
    botKeyForChannel: (channelID) => botKeys[channelID] || null,
    nowImpl: () => clock.t,
    idleThrottleMs,
  });
  adapter.subscribe((event) => { events.push(event); }, { sessions });
  return { adapter, events, clock };
}

// The exact shape the bus delivers a committed frame in (top-level type).
const frameEvent = (type, sessionID = 'ses_1', frame = { id: 'f1', type }) =>
  ({ type, sessionID, frame });

test('a non-tool frame derives start, then idles at the 3s throttle', () => {
  let { adapter, events, clock } = collect();

  adapter.onEvent(frameEvent('frame.added', 'ses_1', { id: 'f1', type: 'BeginTyping' }));
  assert.equal(events.length, 1, 'the first frame is a start');
  assert.equal(events[0].type, 'ai.thinking');
  assert.equal(events[0].phase, 'start');
  assert.equal(events[0].sessionID, 'ses_1');
  assert.equal(typeof events[0].at, 'number');
  // Contract optional fields resolved from the binding maps:
  assert.equal(events[0].channelID, 'chan_1');
  assert.equal(events[0].botKey, 'squeak');

  // Inside the throttle window: suppressed (at most one idle per 3s).
  clock.t += 1000;
  adapter.onEvent(frameEvent('frame.updated', 'ses_1', { id: 'f1', type: 'AgentDelta' }));
  assert.equal(events.length, 1, 'a frame 1s after start is throttled');

  // Past the window: an idle.
  clock.t += 3000;
  adapter.onEvent(frameEvent('frame.updated', 'ses_1', { id: 'f2', type: 'AgentDelta' }));
  assert.equal(events.length, 2, 'the next frame past 3s is an idle');
  assert.equal(events[1].phase, 'idle');
});

test('an OPEN AgentMessage never derives end — ending on the open frame is the flicker', () => {
  let { adapter, events, clock } = collect();

  adapter.onEvent(frameEvent('frame.added', 'ses_1', { id: 'f1', type: 'BeginTyping' }));
  // The streaming target: the engine keeps ONE AgentMessage frame open while
  // generating (content.status is not yet 'complete').
  clock.t += 4000;
  adapter.onEvent(frameEvent('frame.updated', 'ses_1',
    { id: 'am1', type: 'AgentMessage', content: { status: 'streaming' } }));
  assert.equal(events.length, 2);
  assert.notEqual(events.at(-1).phase, 'end', 'an open AgentMessage must NOT end the run');
  assert.equal(events.at(-1).phase, 'idle', 'it is still thinking');
});

test('a CLOSED AgentMessage derives end{complete} and resets the throttle', () => {
  let { adapter, events, clock } = collect();

  adapter.onEvent(frameEvent('frame.added', 'ses_1', { id: 'f1', type: 'BeginTyping' }));
  clock.t += 4000;
  adapter.onEvent(frameEvent('frame.updated', 'ses_1',
    { id: 'am1', type: 'AgentMessage', content: { status: 'complete' } }));
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).phase, 'end');
  assert.equal(events.at(-1).reason, 'complete');

  // Throttle reset: the very next run's first frame is a start again (a stale
  // lastPhaseAt would turn it into a throttled idle and delay typing).
  clock.t += 100;
  adapter.onEvent(frameEvent('frame.added', 'ses_1', { id: 'f2', type: 'BeginTyping' }));
  assert.equal(events.length, 3, 'immediately after end, no throttle holds the next run back');
  assert.equal(events.at(-1).phase, 'start');
});

test('the lifecycle-closed form ends too (state.lifecycle.status, the other close path)', () => {
  let { adapter, events } = collect();
  adapter.onEvent(frameEvent('frame.added', 'ses_1',
    { id: 'am1', type: 'AgentMessage', state: { lifecycle: { status: 'closed' } } }));
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'end');
  assert.equal(events[0].reason, 'complete');
});

test('rule 4: the send path\u2019s tool frames derive NOTHING', () => {
  let { adapter, events, clock } = collect();

  adapter.onEvent(frameEvent('frame.added', 'ses_1', { id: 'f1', type: 'BeginTyping' }));
  assert.equal(events.length, 1);

  // Exactly the frames discord:send's tool emits, right after noteSent stops
  // the window (typing.mjs:53 is this same /ToolFrame$/ predicate).
  clock.t += 4000;
  adapter.onEvent(frameEvent('frame.added', 'ses_1', { id: 't1', type: 'DiscordSendToolFrame' }));
  adapter.onEvent(frameEvent('frame.updated', 'ses_1', { id: 't2', type: 'ExampleToolFrame' }));
  adapter.onEvent(frameEvent('frame.phantom', 'ses_1', { id: 't3', type: 'ToolFrame' }));
  assert.equal(events.length, 1, 'no phase may restart typing over the delivered reply');
});

test('the type gate precedes the shape: a tokens.updated payload shaped like a frame is ignored', () => {
  let { adapter, events } = collect();

  // tokens.updated spreads its payload (frame-runtime.mjs:767): a stray `frame`
  // key and even a `sessionID` must not be read as a committed frame.
  adapter.onEvent({
    type: 'tokens.updated',
    sessionID: 'ses_1',
    frame: { id: 'x', type: 'AgentMessage', content: { status: 'complete' } },
  });
  adapter.onEvent({ type: 'commit', sessionID: 'ses_1', frame: { id: 'y', type: 'BeginTyping' } });
  adapter.onEvent({ type: 'session.saved', sessionID: 'ses_1', frame: { id: 'z', type: 'BeginTyping' } });
  assert.equal(events.length, 0, 'non-frame event types never derive a phase');

  // And a frame event WITHOUT a frame is inert.
  adapter.onEvent({ type: 'frame.added', sessionID: 'ses_1' });
  assert.equal(events.length, 0);
});

test('NEGATIVE CONTROL: an unscoped subscriber receives nothing (bus parity)', () => {
  let events = [];
  let adapter = createThinkingAdapter({ resolveChannel: () => 'chan_1' });
  adapter.subscribe((event) => { events.push(event); });            // sessions: null
  adapter.onEvent(frameEvent('frame.added', 'ses_1'));
  assert.equal(events.length, 0, 'allowed===null must receive nothing, exactly like the bus');
  assert.equal(adapter.subscriberCount(), 1, 'the subscription exists; it is simply never dispatched to');
});

test('a session outside a scoped subscription\u2019s set receives nothing', () => {
  let { adapter, events } = collect({ sessions: ['ses_1'] });
  adapter.onEvent(frameEvent('frame.added', 'ses_other'));
  assert.equal(events.length, 0, 'scoping is per session, deny by default');
  adapter.onEvent(frameEvent('frame.added', 'ses_1'));
  assert.equal(events.length, 1, 'the scoped session does receive');
});

test('subscribe requires a handler; unsubscribe clears every subscriber', () => {
  let { adapter, events } = collect();
  assert.throws(() => adapter.subscribe('not-a-function'), /handler/);
  adapter.unsubscribe();
  assert.equal(adapter.subscriberCount(), 0);
  adapter.onEvent(frameEvent('frame.added', 'ses_1'));
  assert.equal(events.length, 0, 'no subscriber, no delivery');
});
