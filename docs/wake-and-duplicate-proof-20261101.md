# Wake + single-frame proof — 2026-11-01 03:20Z probes

Verification of @th317erd's two live probes against the running Kikx dev server:
`wake-proof-032027` (a wake actually reaches the agent) and the
"post-fix single-frame" checks (one Discord message produces one DiscordFrame).

Status: **both hold on the evidence below, with one measurement caveat and one
open security item (see §5, §6).**

## 1. What was measured

Session `3d573682-5955-474e-877b-1944555a6dfb` ("Discord #miri inbound"),
channel `1471361561955143773`, read via `session-frames` and cross-checked
against the AeorDB file store (`database-search` /kikx). 25 frames total.

Distinct Discord `messageID`s: **9**. DiscordFrame rows per messageID:

| messageID | content | frame rows |
| --- | --- | --- |
| 1565810474459594823 | "Miri probe: positive-branch …" (garbled) | 1 |
| 1565811179316715564 | "Miri test: typed with delay…" | 1 |
| 1565943462963183807 | "Miri seamless test 0421Z" | 1 |
| 1566145914500812811 | "coordinator routing check 1745Z" | **2** |
| 1566146065130983446 | "coordinator routing check 1746Z" | 1 |
| 1566146189043433596 | "coordinator routing check 1745Z" | **2** |
| 1566289733946966067 | "Miri post-fix single-frame check 0316Z" | 1 |
| 1566290039300948159 | "Miri routing check two 0318Z" | 1 |
| 1566290804111048816 | "wake-proof-032027" | **1** |

The two duplicated ids are both from the 17:44–17:45Z batch on 2026-10-31, and
each pair sits in a *different* `interactionID` (742b6d09… order 4 vs 6b1e401e…
order 5 for the first; the second pair likewise) — two independent ingest
handlers for one MESSAGE_CREATE, not a doubled frame within one interaction.

Every message after the fix (`0316Z`, `0318Z`, `032027`) produced **exactly one**
frame. `wake-proof-032027` did not duplicate.

## 2. Wake delivery

- Discord message persisted by the gateway: `2026-11-01T03:20:28.108Z`
- First agent frame of the turn: `2026-11-01T03:20:28.143Z`
- Delta: **~35 ms**. The agent woke with the message in context and acted; it did
  not wait for a poll.

## 3. The fix, and that it is the fix

`kikx-plugin-discord` @ `ee43960` (2026-11-01T03:11:41Z), *"Claim a Discord message
atomically, so concurrent handlers frame it once"*.

Defect (as recorded in the commit and independently reproduced by §1): `handle()`
read `seenMessage(id)` near the top and appended the frame ~70 lines and several
awaits later. Two handlers both read "not seen", both appended;
`recordFrame()`'s `ON CONFLICT (message_id) DO NOTHING` then silently dropped the
second mapping row, so the table *looked* consistent while the session held the
message twice.

Fix: `claimMessage()` — `INSERT … ON CONFLICT (message_id) DO NOTHING RETURNING`
(`index.mjs:444-451`), immediately before the write. `recordFrame()` changed to a
guarded `DO UPDATE … WHERE discord_message_frame.frame_id IS NULL`
(`index.mjs:429-437`) so it fills the reserved row without ever overwriting a row
that already owns a frame and its edit history.

## 4. Evidence

Reachability (a source file does not prove a running server):

- Serving process: **pid 568002**, `node src/server/index.mjs`, cwd
  `/home/wyatt/Projects/kikx-workspace/kikx`, listening `127.0.0.1:3003`
  (`KIKX_PORT=3003`).
- Process start **20:19:50 local = 03:19:50Z**, i.e. *after* the 03:11:41Z commit.
  (Host local time is UTC-7; file mtimes and `ps` output are local, git is +00:00.)
- `KIKX_PLUGIN_PATHS` in that process's environ ends with
  `…/kikx-workspace/kikx-plugin-discord` — the live server loads this checkout
  (re-verified 2026-11-01T03:23Z: pid 568002 still owns `127.0.0.1:3003`, and
  `KIKX_DISCORD_INBOUND_CHANNEL`/`_SESSION` name this channel and session).
- At probe time the checkout was clean at `ee43960` = `origin/master`. It has
  since advanced by the commit that adds this document, which is **local only and
  not yet pushed**, so `origin/master` still points at `ee43960`.

Tests:

- `node --test spec/*.mjs` → **100 pass, 0 fail** (`spec/` has 11 files).
- `spec/inbound-claim-spec.mjs` test 1 is a genuine concurrency test: two
  `router.handle()` calls under `Promise.all`, both yielding via `setImmediate`
  so the interleaving the defect needed is forced.

Negative control (needed, because the post-fix probes were *sequential* — a single
frame from sequential sends is consistent with both fixed and unfixed code):

| path | frames for one message delivered twice concurrently |
| --- | --- |
| without `claimMessage` (pre-fix read-then-write) | **2** |
| with atomic `claimMessage` (post-fix) | **1** |

So the check discriminates. The single frames observed at 0316Z/0318Z/032027
are evidence of the fix, not merely absence of noise.

## 5. Caveats / what is not proven

1. **The SQL itself is not directly exercised.** `inbound-claim-spec.mjs` stubs
   `claimMessage` with a `Set`; it proves the *router* consumes the claim
   correctly, not that PostgreSQL's `ON CONFLICT … RETURNING` is atomic under
   real contention. That property is a database guarantee, but it is not
   demonstrated here against the live 3003 store.
2. **No concurrent live reproduction was run.** I did not fire two simultaneous
   messages at the gateway. The live evidence is (a) the historical duplicate
   pairs, (b) three post-fix single frames including a *repeated identical
   payload* ("routing check 1745Z" sent four times), which is suggestive but
   sequential.
3. **The duplicate rows are still in the store.** `ee43960` prevents new
   duplicates; it does not clean up the two historical pairs. Whether they
   should be merged/deleted is an operator call, not something I did.
4. I did not run the wider Kikx core suite — only the discord plugin's own specs.

## 6. Incidental finding worth an operator decision

While reading `/proc/568002/environ` for plugin paths, the live server's
environment exposed, in cleartext: `KIKX_DISCORD_BOT_TOKEN` and
`KIKX_DISCORD_PUBLIC_KEY`. Any process running as `wyatt` can read another's
environ on this host (`/proc/<pid>/environ` is 0400-owner-only, but same-uid
reads succeed). That is ordinary Linux behaviour, not a Kikx bug — flagging it
because the token was surfaced incidentally and the owner may want it rotated
or moved to a file-based secret, per the project's own credential workflow.

## 7. How to close caveat 1–2, if wanted

Send **two identical messages in the same second** to channel
`1471361561955143773` (or drive two `MESSAGE_CREATE` payloads at the gateway
concurrently), then re-run the per-messageID count in §1 and confirm the new id
has exactly one DiscordFrame. A `DELETE`+replay of an event id would exercise the
resume path too.
