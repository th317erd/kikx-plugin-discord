# Dogfood probe `dogfood-3003` — inbound works, outbound does not

Probe: owner posted to Discord channel **#miri** (`1471361561955143773`) at
`2026-11-01T23:49:56.557Z`:

> `dogfood-3003 hello from the new Miri bot test 2026-11-01T23:49:56.557Z`

Measured on the live dev stack by the receiving agent (Miri), 23:50–23:53Z.
Status: **inbound verified end-to-end; three defects found, one of them new.**

## 1. Identities and serving process (established, not assumed)

| Item | Value | How |
| --- | --- | --- |
| Serving process | pid **1234854**, `node src/server/index.mjs`, cwd `/home/wyatt/Projects/kikx-workspace/kikx` | `ss -ltnp` owner of `127.0.0.1:3003`; `readlink /proc/1234854/cwd` |
| Checkout | `0dea2793` | `git log --oneline -1` in that cwd |
| Runtime log | `/tmp/miri-3003.log` | `ls -l /proc/1234854/fd/1 /fd/2` — both point there |
| Plugin loaded | yes — `KIKX_PLUGIN_PATHS` ends with `…/kikx-plugin-discord` | `/proc/1234854/environ` |
| Bot identity | **Miri**, id `1471348366305923102`, `bot=true` | `GET /users/@me` with the plugin's own `KIKX_DISCORD_BOT_TOKEN` |
| Database | PostgreSQL `127.0.0.1:5434/miri-kikx-dev` | `ORG_AEOR_KIKX_DATABASE_URL` in that environ |

The token in the Kikx process **is** the Miri bot that posted the older replies
in this channel, so identity is not the cause of anything below.

## 2. Inbound: PASS

- `discord_message_frame` row for `1566600214687518764` created
  `16:49:57.31954-07` (= `23:49:57.319Z`), claim won.
- The `DiscordFrame` was persisted with `startedProcessingAt` `…997337`
  (`23:49:57.337Z`) — **18 ms** after the claim.
- Exactly **one** frame for that `messageID` (`count(*)` = 1).
- The frame landed in session `54e1c081-b4fc-46bf-ae9a-c82e19784a19`
  ("Miri — Discord dogfood"), `agentOnly: true`, and **woke the agent** — this
  document exists because the turn ran.
- `[discord] gateway ready as Miri` is in the log for this process start.

Channel → session binding is from `discord_channel_session`:
`1471361561955143773 → 54e1c081-…`. Note the env still carries
`KIKX_DISCORD_INBOUND_SESSION=3d573682-…` (the older session); the binding row
won, so the env key is **stale but currently harmless**. Worth deleting so it
cannot mislead the next reader.

## 3. DEFECT — the audit row is left as an unfilled claim

`discord_message_frame` for this message, re-read twice minutes apart:

```
message_id=1566600214687518764  session_id=[]  frame_id=<NULL>  edits=0
```

By contrast, earlier messages that worked carry both values:

```
1566302420722786415 | 3d573682-… | 3f30f278-…
1566290804111048816 | 3d573682-… | 24b7e7ca-…
```

`session_id=''` is the placeholder from `claimMessage()`
(`index.mjs:444-451`: `VALUES ($1,'',NULL,'')`). So the claim ran, the frame was
written, and **`recordFrame()` never completed**.

Not bad SQL — I replayed the exact `recordFrame` statement against the live row
in a transaction and rolled it back:

```
BEGIN; INSERT … ON CONFLICT (message_id) DO UPDATE … WHERE frame_id IS NULL;
INSERT 0 1
after_update|[54e1c081-…]|probe-frame-id
ROLLBACK
```

The statement succeeds. So the call was skipped or threw *before* reaching the
database, and nothing was logged: `/tmp/miri-3003.log` has **no** discord line
for this message at all. That silence is the actionable part — a transport that
persists a message and then fails to record where it went, without a log line,
is undiagnosable from the outside.

Consequences: edit-tracking (`findFrame` needs `frame_id`) silently no-ops for
this message, and a redelivery of the same id would be read as `duplicate` and
dropped even though the row is incomplete. Needs a fix + a spec that asserts
`session_id`/`frame_id` are populated after `handle()` returns.

## 4. Outbound: NO automatic path, by design — and nothing is wired for it

This is the finding that matters for "dogfood the new Miri bot":

- The plugin's **only** channel write is the `discord:send` tool
  (`index.mjs:145`, `POST /channels/{id}/messages`), and it calls `authorize()`
  first.
- There is **no** hook by which the plugin can observe an agent turn. It injects
  `appendFrame` to write *in*; nothing reads agent output back out. `grep` for
  `onOutbound|AgentMessage|sessionBus` in the plugin: nothing.
- Kikx core has **no** delivery path either — no `channels/…/messages`, no
  outbound hook. Core hook set is `onInit`, `onProvide`, `onShutdown`.
- `discord_capability` holds exactly one grant:
  `discord:255524600249581568 | discord.inbound | {"channel":"1471361561955143773"} | granted_by=miri-agent`.
  **No `discord.send` grant exists for anyone**, and `discord:send` is not in the
  receiving agent's toolset.

So an agent reply stays in the Kikx session. The bot-authored messages visible in
the channel up to `2026-10-30T22:24Z` came from Miri's **own** integration
(`~/Projects/miri/src/ingest/discord.js`), a separate codebase — not from this
plugin. That integration has posted nothing since 2026-10-30T22:24Z.

**Net:** the new Miri bot *receives* in Discord and *cannot answer* there yet.
If "dogfood" means a two-way conversation, this is the gap; if it means inbound
plumbing, it passes.

## 5. DEFECT (pre-existing) — gateway reconnect storm, code 4000

`/tmp/miri-3003.log` for the run before this restart records reconnect attempts
**17 → 23** with `[discord] gateway socket closed (code 4000)` interleaved, i.e.
Discord closing duplicate/competing gateway sessions. The plugin's own guard
(`index.mjs` `gatewayLoop`, refusing a second gateway per instance) is present,
so this was most likely two *processes* with the same token rather than two
gateways in one process. Current run: single `gateway ready`, no reconnects yet.
Worth watching; not proven either way.

## 6. Observation — inbound denials from a third party

The same log shows repeated, correctly-refused traffic:

```
[discord] discord: denied inbound from arabella.skydancer (373308409115705345)
          in channel 1563247178565029988: no grant for discord.inbound
```

The authority check works and the denial is logged with actor and channel. Good.

## 7. What I did with the owner credential

To answer "did the bot ever speak here", I read channel history with
`~/.bot-common/tools/discord` — that credential turns out to be the owner's
**user** token (`th317erd`, id `255524600249581568`), not the bot's. The calls
were read-only (`GET /channels/…/messages`, `GET /channels/…`, `GET /users/@me`).
No message was sent, edited or deleted. Stating it because the audit log will
attribute them to the owner.

## 8. Not proven / open

1. *Why* `recordFrame()` didn't run — no log line exists. Needs instrumentation,
   not inference. I did not restart the server to add it.
2. No live reproduction of the code-4000 storm (§5) — the earlier run is the only
   evidence.
3. Whether outbound is *wanted* for the dogfood is an owner decision, not a bug
   I should silently "fix" by granting `discord.send`.
