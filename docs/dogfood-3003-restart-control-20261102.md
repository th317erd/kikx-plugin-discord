# dogfood-3003 — post-restart control run (2026-11-02T16:27Z)

Serving process at measurement time: pid 2299863 (`node src/server/index.mjs`), cwd
`/home/wyatt/Projects/kikx-workspace/kikx`, bound `127.0.0.1:3003`, plugin HEAD `17b05bd`.
DB: `postgres://miri-kikx-dev@127.0.0.1:5434/miri-kikx-dev` (5433 is a different store —
that port has burned this investigation before).

## What the control exercised

Three inbound messages after the `c4ded08e` restart at 09:24:03 local:

| # | Message id | Kind | Row state |
|---|---|---|---|
| 1 | `1566850645330239678` | attachment only (+1x1 png) | **session_id `''`, frame_id NULL, original_text `''`** |
| 2 | `1566851079487103007` | plain text (`[ctrl-plain]`) | complete, frame `3b30e560` |
| 3 | `1566851196382093494` | attachment only | complete, frame `45307fcf` |

Store totals: 19 rows, 1 stranded.

## Attachments: reachable, and the reader is wired

`describeMessageMedia()` is exported at `inbound-router.mjs:46` and **called** at
`inbound-router.mjs:286` — reachability is source-proven, and observed, because the frame
text carried filename + content type + byte size + dimensions.

Both signed CDN URLs fetched without auth:

```
http=200 bytes=70 type=image/png   PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced
```

Negative control that matters more than the positive: `ex=0x6aea0ae0` decodes to
**2026-11-03T16:25:04Z** — a ~24h expiry — and the frame *stores that signed URL as its
text*. A frame replays for as long as the session lives. So a replayed attachment frame
will describe a file the agent can no longer open. The comment at the call site states the
intent ("Without a URL the agent is told an image exists and is given no way to reach it"),
and an expired URL reproduces exactly that failure one day later.

## The stranded row is a recordFrame miss, not an appendFrame failure

`recordFrame` is called unconditionally at `inbound-router.mjs:425`, outside the try/catch
that guards `appendFrame`. So two shapes are possible, and the store now says which:

- A frame **exists** for `1566850645330239678`: `interactions/fbfadc50-…/frames/…-DiscordFrame-5721f75b-c81f-4a77-a325-f800cf5e859f.json`,
  `content.discord.messageID = 1566850645330239678`.
- The mapping row has empty `original_text`, so the upsert's `DO UPDATE` never ran.

Conclusion: `appendFrame` succeeded, the frame is durable, and only the mapping row is
unfilled. The message was delivered correctly to the agent; the loss is the edit mapping.

`recordFrame`'s upsert is `ON CONFLICT … DO UPDATE … WHERE frame_id IS NULL`; a row that
already exists with `frame_id IS NULL` satisfies that WHERE, so a *successful* execution
would have filled `session_id` and `original_text`. Both are empty. Therefore the statement
did not apply live — it either threw or never reached the connection pool. Nothing logs it
on any path, so from the outside the two are indistinguishable. **Root cause remains
unproven; only its consequence is measured.** Instrumenting `recordFrame` needs a restart
of :3003 on the live checkout, which is the owner's call.

## Corrections made during this run

1. I previously reported the stranded-claim defect as "recurred" only on the old row set
   and left its trigger unproven. It **did recur after the restart**, on the first
   attachment message — so it is live behaviour, not history.
2. `KIKX_DISCORD_BOT_TOKEN` and friends are in `KIKX_ENV_FILE_OWNED_KEYS`, and
   `KIKX_DISCORD_INBOUND_SESSION=3d573682-…` is still present but loses to the DB binding;
   the older rows still carry `3d573682`, which is why the stale key is worth deleting
   rather than leaving as a decoy.
3. Frames are not in `/home/wyatt/.local/share/kikx` on disk for this store; searching
   there returned zero and was a dead end. AeorDB path
   `/kikx/sessions/<id>/interactions/...` is the working locator.

## Not verified

- Why `recordFrame` did not apply (no log line; instrumentation not added).
- No outbound send was made in this run, so the reply leg is untouched by this evidence.
- The `discord:send` split/reply commits (`711076f`, `fa81dd7`, `17b05bd`) were not
  re-exercised here.
