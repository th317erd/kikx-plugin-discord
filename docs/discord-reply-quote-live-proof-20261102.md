# Discord reply quote — live proof on 3003 (2026-11-02)

Status: **reply-quote card proven server-side and end-to-end on the wire**. The
session-header "via Discord" affordance approved alongside it is **not built**; the
reason is a core gap recorded at the bottom, not an omission.

Commits: `0d31466` (the card), `711076f` (the quote). Both pushed; `origin/master`
is level with local `HEAD` (`git rev-list --left-right --count origin/master...HEAD`
= `0 0`).

## What was measured

| Check | Result | Command / source |
|---|---|---|
| Push landed | `0 0` vs `origin/master` | `git rev-list --left-right --count` |
| Inbound rows | **16**, all with non-null `frame_id` | `select count(*), count(*) filter (where frame_id is not null) from discord_message_frame` |
| Newest inbound | `1566671773422846023` — `[discord:th317erd] Miri, reply via discord:send with the single word: cardproof` at `04:34:18.229Z` | same table |
| Send frame after the wake | order **118223**, `DiscordSendToolFrame`, `status: success` | `/kikx/sessions/54e1c081-…/interactions/0a1a6c18-…/frames/0000000000118223-…json` |
| That frame's result carries `replyTo` | `{messageID: "1566671773422846023", author: "th317erd", text: "Miri, reply via discord:send with the single word: cardproof", at: "2026-11-02T04:34:18.229Z"}` | `result.preview` in the frame above |
| Delivered to Discord | `1566673197062037525` / author `Miri` / `"quote-check ok"`, directly under th317erd's message | `GET /channels/1471361561955143773/messages?limit=3` (returns 3: Miri, Miri `cardproof`, th317erd) |
| Client module served | `200`, `9307` bytes, `text/javascript` | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3003/api/plugins/discord/client/discord-send-card.mjs` |
| Descriptor reaches the client | `{tagName: "kikx-discord-send-card", moduleURL: "/api/plugins/discord/client/discord-send-card.mjs", frameType: "DiscordSendToolFrame", kind: "frame"}` present among 63 frame components | `GET /api/v1/client-components` |
| No restart | still pid **1518958**, same process, plugin dir at `711076f` | `ss -ltnp \| grep 3003` + `git log` on host |
| Suite, committed tree | **120 pass / 0 fail** (126 tests / 6 fail when the untracked broken draft `spec/inbound-reply-hint-spec.mjs` is included) | `node --test $(find spec -name '*.mjs' ! -name 'inbound-reply-hint-spec.mjs')` |

The negative control for the quote is in the commit: removing the tool-side change
fails 6 of 10 spec tests in `spec/discord-reply-quote-spec.mjs`.

## Reached only after two measurement errors in this session

1. `/tmp/miri-3003.log` "not found" — `exec` runs **inside the 3098 container**, where
   the host's log does not exist. Not a lost log.
2. `discord_message_frame` has **no `id` column** (primary key is `message_id`), so the
   first ordering query errored. Order by `created_at`.

## Known limit, stated plainly

`replyTo` is the **most recent inbound row for the session**, not Discord's
reply-thread id. Discord's send API records nothing about which message a bot reply
answers, so the plugin cannot know a true parent without keeping its own state.
Consequence: two replies to two different messages arriving inside one agent turn
would both quote the newer one. Acceptable for a dogfooding bot; it is a real
limitation, not a finished correlation.

## Not built: the "via Discord" session-header chip

`registerClientSurface('toolbar-action', …)` is **accepted by core and advertised to
the client**, but `setClientComponents` (`src/client/state/kikx-state.mjs:509-526`)
only stores `frame`, `tool`, `agent-config-form`, `view` and `sidebar-item`. A
`toolbar-action` descriptor is dropped on arrival — the same class of silent drop as
the namespaced-tool bug fixed in `b79888f6`. Verified by reading the dispatcher, not
inferred: no client file references `toolbar-action` at all.

So the header chip needs either
- a **core** change: give `toolbar-action` a client consumer, or
- a **plugin-side** substitute on a surface that *is* consumed (`sidebar-item`, which
  renders a session-row badge, not a header chip).

Which of those to do is an owner decision; both are outside the "plugin-side, no core
change" constraint the owner set for this feature.
