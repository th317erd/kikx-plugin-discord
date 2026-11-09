'use strict';

// =============================================================================
// Discord typing indicator — "the bot is working on an answer", driven by the
// plugin's ai.thinking trigger (docs/ai-thinking-trigger-20261109.md).
// =============================================================================
// Discord's typing state is a REST call, not a gateway opcode:
//   POST /channels/{id}/typing   (no body, Authorization: Bot <token>)
// 204 = accepted; the state then lives ~10 seconds in the client that receives it.
// So "show typing while the agent works" means re-arming that call every few
// seconds until the work ends.
//
// The signal is now one thing: the ai.thinking contract, phase 'start' → arm,
// 'idle' → re-arm, 'end' → stop. thinking.mjs derives those phases from the
// frame events core already emits (its own event classification lives there,
// not here), and index.mjs subscribes the indicator at boot from the DB bindings
// — never on inbound traffic, which is how zero typing POSTs were ever attempted
// before this branch (the root-cause fix).
//
// Everything here is fire-and-forget. A typing indicator must never delay or fail
// a send, and a 403/429 is reported (that is a real permission/ratelimit fact the
// operator needs) while every other outcome is swallowed: Discord owes us nothing
// for an indicator. Swallowed, however, must not mean invisible: lastTypingOutcome
// records what happened so /status can answer "is typing actually working?"
// without guessing (a successful 204 logs nothing).
// =============================================================================

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'Kikx-Discord (https://github.com/th317erd/kikx, 0.1.0)';

// How long one posting window lasts. Discord's own state expires around 10s, so a
// re-arm must land comfortably before that — and every ai.thinking heartbeat
// extends the window instead of posting again, so a token-by-token stream costs
// one POST per armMs, not one per idle.
const DEFAULT_ARM_MS = 8000;

// Hard ceiling from the FIRST post of a window. Without it, a session that keeps
// emitting hearts forever (a stuck agent, a hot loop) would show "typing..." until
// the end of time. 60s says "working on it"; an hour says "broken".
const DEFAULT_CAP_MS = 60000;

// Minimum spacing for the 'typing armed' info log, per channel: first arm logs,
// then at most once per interval — a hot session must not flood the journal, but
// an operator can still see typing arming during a long turn.
const ARMED_LOG_MS = 60000;

// Watchdog: no ai.thinking start/idle for a session for this long means the
// trigger is silent — emitter crashed, only /ToolFrame$/ traffic was flowing, or
// the run vanished without an end. 15s > 2× the 3s idle cadence (the 2026-11-09
// ruling), so a healthy stream can never trip it. LOG-ONLY: it clears the open
// window (a stuck "typing..." is worse than a stopped one) and writes a
// rate-limited warn — it must NOT touch lastTypingOutcome, which stays
// contractually "the last DISCORD POST outcome" (the d6fc22b contract).
const DEFAULT_THINKING_IDLE_MS = 15000;

// Tool-call frames (DiscordSendToolFrame and core's own tool frames) must not arm
// the indicator: right after noteSent() stops it, the send tool frame must never
// restart it — thinking.mjs never emits a phase for /ToolFrame$/. Kept and
// re-exported as the single source of that predicate (the adapter imports it).
export const TOOL_FRAME_RE = /ToolFrame$/;

export function createTypingIndicator({
  resolveChannel,
  tokenForChannel,
  log = () => {},
  fetchImpl = null,
  armMs = DEFAULT_ARM_MS,
  capMs = DEFAULT_CAP_MS,
  thinkingIdleMs = DEFAULT_THINKING_IDLE_MS,
  nowImpl = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  // channelID -> { startedAt, timer } while a window is open; absent = idle.
  const open = new Map();
  // sessionID -> timer of the self-clear watchdog while thinking is presumed on.
  const watchdogs = new Map();
  // channelID -> ts of the last 'typing armed' info log (rate limiter).
  const armedLoggedAt = new Map();
  // channelID -> ts of the last watchdog warn (so silence reports at most once
  // per thinkingIdleMs instead of once per stray frame).
  const watchdogLoggedAt = new Map();
  // Injectable so the cap and the watchdog are testable without sleeping.
  const now = () => nowImpl();

  // Last POST outcome for /status: Discord's own answer ('204'|'403'|'429') or
  // the reason no answer exists ('no-token'|'no-channel'|'error'). null = no POST
  // has ever been attempted (the honest "typing never ran" state).
  let lastOutcome = null;
  const record = (channelID, result) => {
    lastOutcome = { at: now(), channelID, result };
  };

  const getFetch = () => fetchImpl || globalThis.fetch;

  async function post(channelID) {
    if (!channelID) {
      record(null, 'no-channel');
      return;
    }
    try {
      let token = tokenForChannel ? await tokenForChannel(channelID) : null;
      if (!token) {
        record(channelID, 'no-token');
        return;
      }
      let res = await getFetch()(
        `${DISCORD_API}/channels/${encodeURIComponent(channelID)}/typing`,
        {
          method: 'POST',
          headers: { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT },
        },
      );
      let status = res && typeof res.status === 'number' ? res.status : null;
      record(
        channelID,
        status === 204 || status === 403 || status === 429 ? String(status) : 'error',
      );
      // Only the outcomes that mean something are reported: 403 (this bot may not
      // speak here) and 429 (we are re-arming too fast). Anything else — a 204, a
      // dropped socket — is an indicator nobody is owed (it lives in lastOutcome).
      if (status === 403 || status === 429)
        log('warn', `typing indicator refused in channel ${channelID} (HTTP ${status})`);
    } catch (error) {
      record(channelID, 'error');
      log('warn', `typing indicator failed in channel ${channelID}: ${String(error?.message || error)}`);
    }
  }

  function tick(channelID) {
    let state = open.get(channelID);
    if (!state) return;
    state.timer = null;
    // Cap reached: the window closes for good. New heartbeats may open another
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
      // the cap. Replacing one timer with one timer is why duplicate heartbeats
      // cannot multiply the POSTs.
      if (nowMs - state.startedAt < capMs) {
        clearTimeoutImpl(state.timer);
        state.timer = setTimeoutImpl(() => tick(channelID), armMs);
      }
      return;
    }
    open.set(channelID, { startedAt: nowMs, timer: setTimeoutImpl(() => tick(channelID), armMs) });
    // Rate-limited live signal: the first arm per channel logs, then at most once
    // per ARMED_LOG_MS — enough to prove typing is armed in production without
    // guessing, without journaling every window.
    if (nowMs - (armedLoggedAt.get(channelID) || 0) >= ARMED_LOG_MS) {
      armedLoggedAt.set(channelID, nowMs);
      log('info', `[discord] typing armed in channel ${channelID}`);
    }
    post(channelID);
  }

  function stop(channelID) {
    if (!channelID) return;
    let state = open.get(channelID);
    if (state && state.timer) clearTimeoutImpl(state.timer);
    open.delete(channelID);
  }

  function clearWatchdog(sessionID) {
    let timer = watchdogs.get(sessionID);
    if (timer !== undefined) clearTimeoutImpl(timer);
    watchdogs.delete(sessionID);
  }

  // Self-clear: with no ai.thinking start/idle for thinkingIdleMs the trigger is
  // silent (§4 of the design note — a crashed or absent emitter can never leave a
  // stuck state). LOG-ONLY by the 2026-11-09 ruling: it clears the window and
  // warns, rate-limited per channel, and never records an outcome — recording
  // would overwrite a real '204' with a trigger fact and corrupt the d6fc22b
  // contract, where lastTypingOutcome means "the last POST outcome".
  function fireWatchdog(sessionID, channelID) {
    watchdogs.delete(sessionID);
    let state = open.get(channelID);
    if (!state) return;                       // nothing open: nothing stuck to clear
    stop(channelID);
    let at = now();
    if (at - (watchdogLoggedAt.get(channelID) || 0) >= thinkingIdleMs) {
      watchdogLoggedAt.set(channelID, at);
      log('warn', `typing trigger silent in channel ${channelID} (watchdog)`);
    }
  }

  function armWatchdog(sessionID, channelID) {
    clearWatchdog(sessionID);
    watchdogs.set(sessionID, setTimeoutImpl(() => fireWatchdog(sessionID, channelID), thinkingIdleMs));
  }

  // One ai.thinking event in. Which sessions are visible here is decided by the
  // subscription scope in index.mjs; which channel that session answers in is
  // resolveChannel's job. An unbound session resolves to null and costs nothing —
  // that is the unbound-session negative control.
  function onThinking({ sessionID, phase, channelID } = {}) {
    if (!sessionID || (phase !== 'start' && phase !== 'idle' && phase !== 'end')) return;
    let resolved = (channelID && String(channelID))
      || (resolveChannel ? resolveChannel(sessionID) : null);
    if (!resolved) return;
    if (phase === 'end') {
      stop(resolved);
      clearWatchdog(sessionID);
      return;
    }
    // start AND idle both arm: each one pushes the window's due time out (arm()
    // replaces the single timer), so the ≤3s heartbeats keep one 8s timer alive
    // for the whole run — rate-limit rule 2 under heartbeat cadence.
    arm(resolved);
    armWatchdog(sessionID, resolved);
  }

  // Called by discord:send once a chunk has actually landed in the channel.
  function noteSent(channelID) {
    stop(channelID);
  }

  // Everything, at once: onShutdown must not leave re-armed timers posting to
  // Discord for the life of the process after the plugin is unloaded.
  function stopAll() {
    for (let channelID of [...open.keys()]) stop(channelID);
    for (let sessionID of [...watchdogs.keys()]) clearWatchdog(sessionID);
  }

  return {
    onThinking,
    arm,
    stop,
    stopAll,
    noteSent,
    // Test seams: how many channels currently show as typing, and how many
    // session watchdogs are armed (a stuck trigger must be countable).
    openCount: () => open.size,
    watchdogCount: () => watchdogs.size,
    // Status seam: last POST outcome { at, channelID, result }, or null if no
    // POST was ever attempted.
    lastTypingOutcome: () => lastOutcome,
  };
}
