'use strict';

// =============================================================================
// ai.thinking trigger adapter — derives the generic "AI thinking" lifecycle
// (docs/ai-thinking-trigger-20261109.md §3) from the frame events core already
// emits on the plugin bus, until core emits 'ai.thinking' itself (the platform
// gap — reported in the PR, never made here; wt-parity is read-only).
// =============================================================================
// This adapter is the plugin's ONE bus handler: classification lives HERE so
// every consumer (today: the Discord typing indicator; tomorrow: any plugin)
// sees the identical payload shape, and the later swap to a core-emitted
// ai.thinking is transparent to them.
//
// Derivation (measured: frame-runtime.mjs commitHandler emits frame.phantom
// :720, frame.added|updated :732 — top-level { type, sessionID, frame }):
//   non-tool frame (added / updated / phantom) ...... start (first) / idle (≤3s)
//   AgentMessage still OPEN (streaming target) ...... start / idle — NEVER end:
//     frame-engine (src/core/frames/frame-engine.mjs:572) keeps ONE AgentMessage
//     frame open while streaming and closes it (content.status 'complete' or
//     state.lifecycle.status 'closed') when the answer is done. Ending on the
//     open frame would kill typing on the first streamed delta (the flicker
//     failure mode the Step-2a map was ruled against).
//   AgentMessage CLOSED ............................. end{reason:'complete'}
//   /ToolFrame$/ (core's convention, typing.mjs:53) . nothing at all — rule 4:
//     typing after the answer is a lie, so the post-send DiscordSendToolFrame
//     must not restart it. Tool frames also never heartbeat (known edge: a
//     >15s run whose only traffic is /ToolFrame$/ frames will self-clear via
//     the consumer watchdog and re-arm when non-tool frames return).
//   everything else ('commit', 'session.saved', and especially
//   'tokens.updated', whose payload SPREADS arbitrary fields into the event)
//   ................................................ nothing — the type gate
//   runs BEFORE any frame access, so a spread payload can never be misread.
//
// Local subscription mirrors the bus contract (plugin-events.mjs #dispatch):
// an unscoped subscriber receives NOTHING — deny by default, opened explicitly.
// Idle is throttled to at most one emission per 3s (the 2026-11-09 ruling;
// contract max is 5s, so 3s keeps consumer re-arm cadence comfortably inside it).
// =============================================================================

import { TOOL_FRAME_RE } from './typing.mjs';

// Only these event types carry a committable frame worth classifying.
const FRAME_EVENTS = new Set(['frame.added', 'frame.updated', 'frame.phantom']);

// Idle emission throttle. 3s = ruled cadence; every passed idle reaches the
// consumer, which extends its 8s typing window — so ≤3s heartbeats can never
// let the window lapse while frames are flowing (rate-limit rule 2).
const IDLE_THROTTLE_MS = 3000;

// The same predicate core sorts by (frame-engine.mjs:572): an AgentMessage is
// finished only when closed, not merely because it exists.
function isClosedAgentMessage(frame) {
  return frame?.type === 'AgentMessage'
    && (
      frame?.state?.lifecycle?.status === 'closed'
      || frame?.content?.status === 'complete'
    );
}

export function createThinkingAdapter({
  resolveChannel = null,
  botKeyForChannel = null,
  nowImpl = Date.now,
  idleThrottleMs = IDLE_THROTTLE_MS,
} = {}) {
  // Local subscribers: { handler, allowed }. allowed === null = unscoped =
  // receives nothing (bus parity — plugin-events.mjs drops allowed===null).
  const subs = [];
  // sessionID -> ms of the last EMITTED phase (the idle throttle's clock).
  const lastPhaseAt = new Map();
  const now = () => nowImpl();

  function subscribe(handler, { sessions = null } = {}) {
    if (typeof handler !== 'function')
      throw new TypeError('thinking adapter subscribe requires a handler function');
    subs.push({
      handler,
      allowed: sessions === null ? null : new Set([].concat(sessions).filter(Boolean)),
    });
    return true;
  }

  // Mirrors PluginEventBus.unsubscribe(pluginId): one call clears every local
  // entry. Nothing in the plugin calls this at runtime — subscriptions die with
  // the plugin instance — it exists so the API shape matches the bus contract.
  function unsubscribe() {
    subs.length = 0;
  }

  function emit(event, phase, reason = null) {
    let sessionID = event.sessionID || event.frame?.sessionID || null;
    if (!sessionID) return;
    let at = now();
    lastPhaseAt.set(sessionID, at);
    let payload = { type: 'ai.thinking', sessionID, phase, at };
    if (reason) payload.reason = reason;
    // Optional contract fields: present when the consumer's binding maps can
    // answer them, absent otherwise (docs §1: optional, consumer may resolve).
    let channelID = resolveChannel ? resolveChannel(sessionID) : null;
    if (channelID) {
      payload.channelID = channelID;
      if (botKeyForChannel) {
        let botKey = botKeyForChannel(channelID);
        if (botKey) payload.botKey = botKey;
      }
    }
    for (let { handler, allowed } of subs) {
      if (allowed === null || !allowed.has(sessionID)) continue;
      try {
        let result = handler(payload);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        // A consumer failure is the consumer's; the trigger never breaks the bus
        // (the real bus warns-and-continues the same way).
      }
    }
  }

  // The bus handler: subscribe THIS, scoped per session, at every load.
  function onEvent(event) {
    // Type gate FIRST — 'tokens.updated' spreads an arbitrary payload that may
    // contain a stray `frame` key; nothing below may trust the shape of a
    // non-frame event.
    if (!event || !FRAME_EVENTS.has(event.type)) return;
    let frame = event.frame;
    if (!frame) return;
    let type = String(frame.type || '');
    if (TOOL_FRAME_RE.test(type)) return;          // rule 4: no phase at all
    let sessionID = event.sessionID || frame.sessionID || null;
    if (!sessionID) return;

    if (isClosedAgentMessage(frame)) {
      emit(event, 'end', 'complete');
      lastPhaseAt.delete(sessionID);               // next run starts fresh
      return;
    }
    let at = now();
    let last = lastPhaseAt.get(sessionID);
    if (last !== undefined && at - last < idleThrottleMs) return;  // throttle idles
    emit(event, last === undefined ? 'start' : 'idle');
  }

  return {
    onEvent,
    subscribe,
    unsubscribe,
    // Test seams.
    subscriberCount: () => subs.length,
    isClosedAgentMessage,
  };
}
