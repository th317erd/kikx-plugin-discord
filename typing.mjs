'use strict';

// =============================================================================
// Discord typing indicator — "the bot is working on an answer", driven by Kikx's
// own frame events.
// =============================================================================
// Discord's typing state is a REST call, not a gateway opcode:
//   POST /channels/{id}/typing   (no body, Authorization: Bot <token>)
// 204 = accepted; the state then lives ~10 seconds in the client that receives it.
// So "show typing while the agent works" means re-arming that call every few
// seconds until the work ends.
//
// The signals, all of them already emitted by core as frame events:
//   frame.added / frame.phantom  — the agent began or is still producing
//                                  (BeginTyping, deltas, progress, the inbound
//                                  frame itself: typing may start the moment the
//                                  message is framed, before the model wakes).
//   AgentMessage                 — the turn's final answer: work is over.
//   a successful discord:send    — the answer landed in the channel; the caller
//                                  invokes noteSent() from the send path.
//
// Everything here is fire-and-forget. A typing indicator must never delay or fail
// a send, and a 403/429 is reported (that is a real permission/ratelimit fact the
// operator needs) while every other outcome is swallowed: Discord owes us nothing
// for an indicator.
// =============================================================================

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'Kikx-Discord (https://github.com/th317erd/kikx, 0.1.0)';

// How long one posting window lasts. Discord's own state expires around 10s, so a
// re-arm must land comfortably before that — and every fresh frame event extends
// the window instead of posting again, so a token-by-token stream costs one POST
// per armMs, not one per delta.
const DEFAULT_ARM_MS = 8000;

// Hard ceiling from the FIRST post of a window. Without it, a session that keeps
// emitting frames forever (a stuck agent, a hot loop) would show "typing..." until
// the end of time. 60s says "working on it"; an hour says "broken".
const DEFAULT_CAP_MS = 60000;

// Tool-call frames (DiscordSendToolFrame and core's own tool frames) must not arm
// the indicator: right after noteSent() stops it, the tool frame's own
// frame.added would immediately restart it and Discord would show typing AFTER the
// answer was already delivered.
const TOOL_FRAME_RE = /ToolFrame$/;

export function createTypingIndicator({
  resolveChannel,
  tokenForChannel,
  log = () => {},
  fetchImpl = null,
  armMs = DEFAULT_ARM_MS,
  capMs = DEFAULT_CAP_MS,
  nowImpl = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  // channelID -> { startedAt, timer } while a window is open; absent = idle.
  const open = new Map();
  // Injectable so the cap is testable without sleeping a real minute.
  const now = () => nowImpl();

  const getFetch = () => fetchImpl || globalThis.fetch;

  async function post(channelID) {
    try {
      let token = tokenForChannel ? await tokenForChannel(channelID) : null;
      if (!token) return;
      let res = await getFetch()(
        `${DISCORD_API}/channels/${encodeURIComponent(channelID)}/typing`,
        {
          method: 'POST',
          headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT },
        },
      );
      // Only the outcomes that mean something are reported: 403 (this bot may not
      // speak here) and 429 (we are re-arming too fast). Anything else — a 204, a
      // dropped socket — is an indicator nobody is owed.
      if (res && (res.status === 403 || res.status === 429))
        log('warn', `typing indicator refused in channel ${channelID} (HTTP ${res.status})`);
    } catch (error) {
      log('warn', `typing indicator failed in channel ${channelID}: ${String(error?.message || error)}`);
    }
  }

  function tick(channelID) {
    let state = open.get(channelID);
    if (!state) return;
    state.timer = null;
    // Cap reached: the window closes for good. New frame events may open another
    // one — an agent that pauses and resumes deserves a fresh indicator — but this
    // window will not renew itself again.
    if (now() - state.startedAt >= capMs) {
      open.delete(channelID);
      return;
    }
    post(channelID);
    state.timer = setTimeoutImpl(() => tick(channelID), armMs);
  }

  function arm(channelID) {
    if (!channelID) return;
    let nowMs = now();
    let state = open.get(channelID);
    if (state && state.timer) {
      // Already showing: extend the window (replacing the timer) — but never past
      // the cap. Replacing one timer with one timer is why a duplicate subscription
      // or a flood of deltas cannot multiply the POSTs.
      if (nowMs - state.startedAt < capMs) {
        clearTimeoutImpl(state.timer);
        state.timer = setTimeoutImpl(() => tick(channelID), armMs);
      }
      return;
    }
    open.set(channelID, { startedAt: nowMs, timer: setTimeoutImpl(() => tick(channelID), armMs) });
    post(channelID);
  }

  function stop(channelID) {
    if (!channelID) return;
    let state = open.get(channelID);
    if (state && state.timer) clearTimeoutImpl(state.timer);
    open.delete(channelID);
  }

  // One event in. Which sessions are visible here is decided by the subscription
  // scope in index.mjs; which channel that session answers in is resolveChannel's
  // job. An unbound session resolves to null and costs nothing — that is the
  // unbound-session negative control.
  function onEvent(event) {
    let frame = event && event.frame;
    let type = (frame && frame.type) || '';
    let sessionID = (event && event.sessionID) || (frame && frame.sessionID) || null;
    if (!sessionID) return;
    let channelID = resolveChannel ? resolveChannel(sessionID) : null;
    if (!channelID) return;
    if (type === 'AgentMessage') {
      // The turn answered. Anything still open is over-staying.
      stop(channelID);
      return;
    }
    if (TOOL_FRAME_RE.test(type)) return;
    arm(channelID);
  }

  // Called by discord:send once a chunk has actually landed in the channel.
  function noteSent(channelID) {
    stop(channelID);
  }

  // Everything, at once: onShutdown must not leave re-armed timers posting to
  // Discord for the life of the process after the plugin is unloaded.
  function stopAll() {
    for (let channelID of [...open.keys()]) stop(channelID);
  }

  return {
    onEvent,
    arm,
    stop,
    stopAll,
    noteSent,
    // Test seam: how many channels currently show as typing.
    openCount: () => open.size,
  };
}
