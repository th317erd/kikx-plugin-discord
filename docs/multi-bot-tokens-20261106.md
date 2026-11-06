# Per-channel bot identity: N bot tokens, typing indicator, reply hint

Status: implemented — plugin commit `287724c8` (code + specs), this doc committed on
`feat/discord-per-channel-bot-identity`. Design: rev-1 "Option B" (single inbound
gateway + per-channel token selection for all REST outbound). The official-app /
webhook-persona tier ("rev 2") is explicitly deferred to a later design; nothing in
this change depends on fleet-specific config.

## What changed

- **`sql/005-channel-bot-key.sql`** — adds `bot_key TEXT NOT NULL DEFAULT 'default'`
  to `discord_channel_session` (schema only, no channel-id seeds). Applied
  automatically through `registerMigrations` on first start of an image containing
  this plugin; visible in `plugin_migrations`. Legacy rows keep working untouched:
  `bot_key='default'` resolves through the fallback below.
- **`tokenForChannel(channelID)`** (`index.mjs`) — resolves the channel's binding
  `bot_key` → `readConfig('/kikx/discord/bots/<key>/token')` → falls back to the
  legacy `/kikx/discord/bot/token` when the key is absent/empty or the token is
  unset. Bindings are cached in memory and refreshed by `refreshInboundConfig()`,
  which every inbound path runs — a cut-over `UPDATE` takes effect on the next
  message, no restart required. On any binding-load error the maps stay empty and
  everything degrades silently to the legacy token (fail-safe to current behavior,
  never to a broken send).
- Wired into: `discord:send` (channel resolved first), interaction follow-up
  (`updateInteractionOriginal`, channel from the interaction payload), and
  channel-scoped `discord-tools` reads / react / post_file. **Guild-scoped** reads
  (`list_servers`, `list_channels`, `list_threads`) have no channel key and keep
  the default token — correct while all bots share one guild (assumption, labeled).
- **Typing indicator** (`typing.mjs`) — `POST /channels/{id}/typing` with the
  channel's own token, armed by `frame.added` / `frame.phantom` via
  `subscribe('discord', …, {sessions: [boundSession]})` (an unscoped subscribe is a
  silent no-op in core). Re-arms every 8s while the agent streams, hard cap 60s,
  stops on a terminal `AgentMessage`, on the first landed send (`noteSent`), and at
  plugin shutdown (`stopAll`). Tool frames (`/ToolFrame$/`, frame-engine
  convention) never arm it. Fire-and-forget: only 403/429 are logged.
- **Reply hint** — `spec/inbound-reply-hint-spec.mjs.draft` promoted to a real
  spec. A sendable inbound frame's TEXT carries
  `[kikx:reply-hint] … call discord_send (registered as discord:send) with channel "<id>"`,
  gated through the same `authorize()`/actor the send tool runs; refused or failed
  gate = no hint, never a lost message. `findReplyTarget` strips the marker before
  quoting a human.

## Env keys (compose / .env)

Kikx derives env names mechanically from config paths (`envKeyFor`, core
`property-path.mjs`): path segment → uppercased, `/` → `_`. Proven by a unit test
importing core's real `envKeyFor`:

| Config path                         | Env key                          |
|-------------------------------------|----------------------------------|
| `/kikx/discord/bot/token`           | `KIKX_DISCORD_BOT_TOKEN`         |
| `/kikx/discord/bots/auri/token`     | `KIKX_DISCORD_BOTS_AURI_TOKEN`   |
| `/kikx/discord/bots/squeak/token`   | `KIKX_DISCORD_BOTS_SQUEAK_TOKEN` |
| `/kikx/discord/bots/sans/token`     | `KIKX_DISCORD_BOTS_SANS_TOKEN`   |
| `/kikx/discord/bots/miri/token`     | `KIKX_DISCORD_BOTS_MIRI_TOKEN`   |

- Any `<key>` works (`/kikx/discord/bots/<key>/token`) — zero fleet hardcodes; the
  four names above are this fleet's choices, not requirements.
- `KIKX_DISCORD_BOT_TOKEN` remains required: it is the **listener** token (the one
  gateway connection) and the fallback for unbound channels and guild-scoped reads.
  Removing it disables inbound entirely.
- Each app must have the privileged **MESSAGE_CONTENT** intent enabled in the
  Discord developer portal, or inbound arrives with empty content and the router
  declines it (`empty_content_missing_intent`). Portal-side per app — not a code
  or env setting.

Secrets flow: `.env` → container env → core process-env config provider →
`readConfig` inside the plugin only. Tokens are never logged, never returned by
`/health` or `/status`, never written to frames.

## Migration / cut-over notes (operator)

1. Deploy an image containing this plugin → migration `005` applies on start
   (`SELECT * FROM plugin_migrations` shows it); all existing bindings keep
   `bot_key='default'` = legacy token = current behavior. No restart churn needed
   before tokens exist.
2. Add the `KIKX_DISCORD_BOTS_<KEY>_TOKEN` keys to the host `.env` (mode 600).
3. Bind each channel to its identity (takes effect next message, no restart):
   `UPDATE discord_channel_session SET bot_key='squeak' WHERE channel_id='<id>';`
4. Recreate the container (`docker compose up -d`) so the new env keys load.
5. Live proof: for each bound channel, post a message and confirm the reply's
   author id equals that bot's `GET /users/@me` id (4 distinct ids), typing
   appears before the reply.
6. Rollback: `bot_key` back to `'default'` (or drop the new env keys) and/or
   recreate on the previous image tag — legacy token path alone reproduces the old
   single-identity behavior.

## Tests

`node --test spec/*.mjs` → **202 tests, 202 pass, 0 fail** (baseline before this
feature: 173). New specs:

- `spec/channel-bot-token-spec.mjs` — per-channel identity: send/read/react/file
  calls carry the owning bot's token; **negative control: bypassing
  `tokenForChannel` in `discord:send` makes the identity spec fail** ("answers as
  THAT bot — never as the legacy token"); unknown/absent `bot_key` falls back to
  the legacy token; `envKeyFor` case-join proof.
- `spec/inbound-reply-hint-spec.mjs` — hint present with grant, absent when
  authorize refuses, marker stripped before reply-quoting; typing specs incl.
  **negative control: unbound session → zero typing POSTs/token reads/timers**.
- Two anchored framed-text assertions updated for the hint line
  (`plugin-entry-spec.mjs`, `interactions-endpoint-spec.mjs`) — sanctioned; no
  other spec weakened.

## Unverified / labeled

- Live Discord typing endpoint behavior (unit-tested with fake fetch only).
- `loadChannelBindings` against a live migrated DB (fail-safe verified: error →
  legacy token).
- Live 4-identity proof — operator's cut-over step 5.
- Slash-command usage under multiple apps: interaction follow-up identity is now
  channel-derived, but only one `/kikx/discord/public/key` exists (single
  application) — per-bot public keys only matter if slash commands are adopted.
