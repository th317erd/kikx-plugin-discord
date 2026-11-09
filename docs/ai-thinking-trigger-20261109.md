# ai.thinking — generic AI-thinking trigger contract (design note, 2026-11-09)

Status: design for review (Avatar/Wyatt); implementation follows on this branch.
Owner decision: authoritative typing = this plugin, built on a generic trigger ANY plugin
may subscribe to. The miri-framework `typingTick` becomes non-authoritative (Wyatt owns
that side; framework repo untouched here). No laptop-hosted dependencies: the trigger is
in-process — no timers, sockets, or files on wyatt-laptop (atlas-only mandate).

## 1. Event contract

Event name: `ai.thinking` — one event type; `phase` distinguishes transitions.

```js
{
  type: 'ai.thinking',
  sessionID,                          // REQUIRED — bus scoping key (see §2)
  phase: 'start' | 'idle' | 'end',
  reason?: 'complete' | 'abort' | 'error',   // end only
  channelID?: string,                 // optional; consumer may resolve from its binding map
  botKey?: string,                    // optional bot identity (miri/auri/squeak/sans)
  at: number                          // epoch ms at emission
}
```

Phases:
- `start` — generation/assistant run began for `sessionID`.
- `idle` — heartbeat: still thinking, emitted at most every 5s while active; renews
  consumer state and cadences ongoing effects (Discord typing re-arm).
- `end` — run finished (`complete`), aborted (`abort`), or failed (`error`).

## 2. Subscription API (existing — measured)

Plugins subscribe via the loader-provided `subscribe(handler, {sessions})`
(`plugin-loader.mjs:524`) onto `PluginEventBus` (`src/core/plugins/plugin-events.mjs`).
Bus semantics that bind this contract:

- **Unscoped subscriptions receive NOTHING** — `#dispatch` drops `allowed === null`.
  Every `ai.thinking` subscriber MUST pass `{sessions:[...]}`; subscribe only once the
  session set is known, and re-subscribe (`unsubscribe` + `subscribe`) when it changes.
- Delivery is per-subscription-entry scoped; `unsubscribe(pluginId)` on unload is automatic.
- Handlers may return promises; failures are warned, never thrown.

## 3. Emission points

Candidate anchors (exact sites verified during Step 2): this plugin observes generation
lifecycle through the frame-commit events it already receives — thinking/delta/streaming
frames → final frame. Mapping:

| core signal (candidate)                | phase emitted        |
|----------------------------------------|----------------------|
| first thinking/delta frame for session | `start`              |
| ongoing deltas / assistant active      | `idle` (≤5s cadence) |
| final non-streaming message frame      | `end{complete}`      |
| aborted run / no final frame           | `end{abort}`         |

### Platform gap — reported, not implemented here

`emitRuntimeEvent(type, payload)` exists only in core (`frame-runtime.mjs:712`) and the
loader provides **no `emit`** to plugins; today's emitted vocabulary is `session.saved`,
`frame.phantom`, `commit`, `tokens.updated` — no generation lifecycle. Truly cross-plugin
emission needs a core change: (a) provide `emit` in `plugin-loader`, or (b) call
`emitRuntimeEvent('ai.thinking', …)` at core generation anchors. Recommend (b) as the
platform final form. Until authorized, this plugin ships an in-plugin adapter deriving
`ai.thinking` from the frame events it already receives — consumers see the identical
payload, so the later swap is transparent. Core stays read-only: reported, not made.

## 4. Idle / stuck-state self-clear (consumer-side, mandatory)

Consumer keeps `lastPhaseAt` per session; with no `ai.thinking` event (`start`/`idle`) for
`thinkingIdleMs` (default 15_000; > 2× heartbeat) it synthesizes `end{error}` locally:
clears open typing, records `lastTypingOutcome`, logs once. A crashed or absent emitter
can never leave a stuck "thinking" state. Emitter-side `idle` ≤5s feeds re-arm cadence.

## 5. First consumer — Discord typing (the root-cause fix)

Today's only subscribe hook, `noteSessionBound` (`index.mjs:174`), runs on the inbound
path — inbound saw only denials/skips, so no subscription was ever created and zero typing
POSTs were ever attempted. New wiring, independent of inbound:

1. After every successful `loadChannelBindings()` (session→channel is already filled from
   DB rows at `index.mjs:123`), subscribe the typing indicator to `ai.thinking` scoped to
   those sessions; re-subscribe on later loads. Boot ordering rides the existing
   pool-readiness wait (kink-2 fix).
2. `typing.mjs onEvent` on `ai.thinking`: `start` → arm (keeps the rate-limited
   `typing armed in channel <id>` info log); `idle` → re-arm per Discord cadence;
   `end` (event or watchdog) → clear open state. The old `AgentMessage`-keyed path is
   dropped or kept as fallback — decided at Step 2 against measured frame traffic.
3. `noteSessionBound` stays as the incremental path for newly auto-bound sessions, not
   the only path.

Observability (folds in `d6fc22b` unchanged): `/status` exposes `typingSubscribedSessions`,
`sessionChannelIDSize`, `typingOpenCount`, `lastTypingOutcome` —
`typingSubscribedSessions` now goes non-zero at boot, itself the live signal that the root
cause is fixed.

## 6. Gates (Steps 4–5)

Full suite baseline 205/0 (keep ≥205; direct invocations only — no AeorDB wrapper).
New specs: (1) regression — zero inbound traffic, generation event → typing POST attempted
(the exact production failure); (2) `end` clears + watchdog self-clear (fake timers);
(3) negative control — before binding-load success, subscription and `/status` typing
fields empty/null. Branch `feat/discord-ai-thinking-trigger` from `d6fc22b`
(observability folded in). Push + PR only; no merge, no deploy
(PR #1 `8f20ebf`, PR #2 `e675d7f` untouched).
