# dogfood-3003 — "are you getting this message?" reply-leg + delivery proof

Measured 2026-11-02 01:22–01:25Z by the receiving agent (Miri) on the live dev stack.
Requester: Wyatt (`th317erd`), Discord user id `255524600249581568`, channel `1471361561955143773` (#miri).

## 1. Answer to the question asked

**Yes.** The message reached me. Evidence, not assertion:

| Item | Measured value |
|---|---|
| Message id | `1566623523475165287` |
| Author | `th317erd` / `255524600249581568` |
| Text | `Miri, are you getting this message?` |
| Claim row created | `2026-11-02 01:22:34.679406Z` (13 ms before the turn context) |
| Frame written | `0000000000101585-DiscordFrame-12b00da2-8908-4ace-a8e3-b27eb49cad1e.json` |
| Frame `updated_at` | `1793582554695` ms = `2026-11-02T01:22:34.695Z` |
| Frame `agentOnly` | `true` |
| Frame content | `{text: "[discord:th317erd] Miri, are you getting this message?", discord: {messageID, channelID, authorName, authorID}}` |

The frame exists in AeorDB and is the frame that woke this turn. `appendFrame` ran.

## 2. The defect that is real, and what it is not

NOT "delivery is broken" and NOT "the record is half-written" in the sense of data loss.
The frame is durable. What is wrong is only the Postgres mapping row:

```
message_id            | session_id | frame_id | created_at
1566623523475165287   | ''         | NULL     | 2026-11-01 18:22:34.679406-07
```

- Observed empty at `01:22:59Z` (25 s) and again at `01:23:45Z` (~71 s). Not async lag.
- Consequence: **edit tracking only**. An edit to this message cannot be matched back to its frame.
  It is not a lost message.
- Incidence: **1 stranded row of 15** in `discord_message_frame`.

### Replay check (negative-control discipline)

The `recordFrame` upsert was replayed against the live row inside a rolled-back transaction in an
earlier turn: `UPDATE 1`, row completed. So the SQL is correct and reachable; the write simply
never happened. `recordFrame` has no try/catch and no log line on any path, so its failure leaves
no trace but the empty row. **Root cause remains unproven** — that is the honest state.

### The poison mechanism and its 120 s window

| Path | Code | Behaviour |
|---|---|---|
| Claim | `claimMessage` — `DO UPDATE … WHERE frame_id IS NULL AND created_at < now() - 120s` | reclaims only provably-abandoned claims |
| Release | `releaseClaim` — `DELETE … WHERE frame_id IS NULL` | called **only** when `appendFrame` throws |
| Fill | `recordFrame` — `ON CONFLICT DO UPDATE … WHERE frame_id IS NULL` | no error handling |

Because `appendFrame` succeeded, the `releaseClaim` path did not fire. The row therefore sits
poisoned until `created_at + 120 s` = **01:24:34Z**, after which a redelivery may reclaim it.
Inside that window a redelivery is answered `duplicate`.

## 3. Correction to earlier reporting

I reported the 23:49Z message (`1566600214687518764`) as permanently stranded. **It is not.**
It now reads `session_id = 54e1c081…`, `frame_id = e5ff31eb-5a28-4cd5-8f0b-f9eadb94a85f`.

Checked for the failure mode the reclaim rule was written to avoid: **exactly one** DiscordFrame
carries that messageID in AeorDB. No duplicate. So the grace-window reclaim does *not* appear to
reopen the duplicate-framing race — at least not in this instance.

## 4. Send-leg evidence (this turn)

Grant row (`discord_capability`):

```
actor                        | action        | scope_json                              | granted_by
discord:255524600249581568   | discord.send  | {"channel": "1471361561955143773"}      | miri-dogfood-owner-request
discord:255524600249581568   | discord.inbound | {"channel": "1471361561955143773"}    | miri-agent
```

| Attempt | Actor passed | Result |
|---|---|---|
| 1 | `miri` | `{sent:false, denied:true, reason:"no grant for discord.send"}` |
| 2 | `discord:255524600249581568` | `{sent:true, delivered:true, messageID:1566623741939814421}` |
| 3 | `discord:255524600249581568` | `{sent:true, delivered:true, messageID:1566623971271778416}` |

**Finding:** the grant is keyed to the owner's Discord identity, not to the agent. Anything the
agent originates as actor `miri` is denied by design. That is a second, independent blocker for
autonomous replies, separate from the missing frame-observer hook.

## 5. Corrections to my own earlier claims this turn

1. **"The plugin logged nothing for this inbound."** Based on a timestamp regex
   (`^\[?YYYY-MM-DDTHH:MM:SS`) applied to `/tmp/miri-3003.log`, which contains **no timestamps at
   all**. The grep was vacuous. The log does carry **306** `[discord]` lines, including
   `[discord] not framed: bot_author` and gateway `code 4000` reconnect attempts 21–23.
   Withdrawn. The residual, defensible statement is narrower: the log has **no success-path
   logging and no timestamps**, so it cannot distinguish "claimed and framed" from "claimed and
   not recorded".
2. **"I don't yet know what distinguishes the cases."** Partly resolved: the earlier case healed
   via the grace-window reclaim and produced no duplicate; this case had not yet passed its own
   120 s window at the time of measurement. What remains unexplained is why this row's
   `recordFrame` did not apply at all.

## 6. Environment identity

- Serving process: pid **1518946** (`node scripts/start-kikx-dev.mjs`), parent 1518945, cwd
  `/home/wyatt/Projects/kikx-workspace/kikx`, listening `127.0.0.1:3003`.
- Gateway log: `/tmp/miri-3003.log`, fd 1 and fd 2 of pid 1518945. No timestamps.
- Database: `postgres://miri-kikx-dev@127.0.0.1:5434/miri-kikx-dev` (password from the serving
  process environment). Note this is **not** the `kikx` db on 5433 that I queried in an earlier
  turn — that was a measurement-identity error on my part.
- Frames live in **AeorDB** (`/kikx/...`), not in the Postgres `frames` table — the Postgres
  schema has no `frames` relation at all.
- Single gateway instance confirmed (`pgrep -af start-kikx-dev` → only 1518945/1518946), so the
  earlier code-4000 reconnect storm is not explained by a second live instance *now*.

## 7. Still open

- **Root cause of the empty `recordFrame`.** Needs a log line, which needs a restart of :3003 —
  the owner's call, not mine.
- **Autonomous reply remains unbuilt.** Both sends this turn were explicit tool calls. There is no
  hook by which the transport observes an agent turn and posts its output, and no `discord.send`
  grant for actor `miri`.
- Untracked files from earlier turns still uncommitted.
