# dogfood-3003 — reply-leg test (2026-11-02T00:02Z)

Request: "Miri, please reply here in #miri using discord:send and say which tool
and grant you used."

Outcome: **no send performed.** Not a refusal and not a failure of the grant —
the tool is unreachable from an agent loop. Evidence below.

## 1. The grant exists (owner did this 25s before the request)

Live server DB is `postgres://miri-kikx-dev@127.0.0.1:5434/miri-kikx-dev`
(from `/proc/1234854/environ`, `ORG_AEOR_KIKX_DATABASE_URL`).

    actor                     | action         | scope_json                          | granted_by                 | granted_at
    discord:255524600249581568| discord.inbound| {"channel": "1471361561955143773"}   | miri-agent                 | 2026-10-30 11:04:45.608-07
    discord:255524600249581568| discord.send   | {"channel": "1471361561955143773"}   | miri-dogfood-owner-request | 2026-11-01 17:01:28.888-07

`granted_at` 17:01:28-07 == 2026-11-02T00:01:28Z, i.e. ~25s before the 00:01:53Z message.

Earlier in the same dogfood, my first attempt queried port 5433 / db `kikx` and
found no `discord.send` row. That was the wrong database, not a missing grant.

## 2. SendTool itself is correct and does its own authorization

`index.mjs:145` `discord:send` → `authorize({ actor, action:'discord.send',
scope:{channel} })` before any network call; returns `{sent:false, denied:true}`
when the grant is absent, and `{sent:false, pending:'no-bot-token'}` rather than
claiming a send it could not make. It returns `delivered: Boolean(body?.id)`.
No defect found in the tool.

## 3. Bot identity and channel verified at the Discord API (read-only GETs)

    GET /users/@me        -> {"id":"1471348366305923102","username":"Miri","bot":true}
    GET /channels/1471... -> {"id":"1471361561955143773","name":"miri",
                              "guild_id":"255525418558291969","type":0}

So the target channel and the bot credentials are both live and correct.

## 4. THE BLOCKER: colon-named tools are filtered out of the agent toolset

`src/core/plugins/agent-tool-definitions.mjs:253`

    export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

`src/core/plugins/agent-loop-tools.mjs:243` `shouldExposeRegisteredTool()` requires
that pattern to match; `createRegisteredToolDefinitions()` (l.157) and
`createRegisteredToolHandlers()` (l.219) both use it to build what an agent can see
and call. `discord:send` contains `:`.

Executed against the real imported function (not inferred from the regex):

    FILTERED  discord:send
    FILTERED  discord.send
    EXPOSED   discord_send
    EXPOSED   discord
    FILTERED  discord:policy_grant

Consequence: `discord:send`, `discord:policy_grant`, `discord:policy_revoke` and
`puppeteer:render_page|screenshot|evaluate` are registered but never reachable by
any agent. `discord:send` is absent from my runtime toolset, consistent with this.

Not a test artifact: `spec/plugin-entry-spec.mjs:127` asserts
`captured.tools == ['discord:send', 'discord:policy_grant', 'discord:policy_revoke']`.
That spec checks registration only, and never checks exposure, which is why the
suite is green while the tool is unreachable.

## 5. No alternate invocation route exists

- `plugin-routes.mjs`: zero occurrences of "tool".
- Only tool-related HTTP route: `/api/v1/tool-outputs/:id` (reads stored tool output).
- `.executeTool(` call sites: `agent-loop-tools.mjs:224` (the filtered path) and
  `pending-tool-recovery.mjs:129` (replays a call already recorded in a session).
- Plugin `mountHttp` serves only `GET /status` and `POST /interactions`.

## 6. What was deliberately NOT done

No curl POST to `discord.com/api/v10/channels/.../messages` using
`KIKX_DISCORD_BOT_TOKEN`. It would have worked, but it would be indistinguishable
from a real send while bypassing the `authorize()` gate that is the plugin's reason
for existing, and it would leave no `discord.send` audit of my own. The owner asked
for the tool and the grant, and this note says plainly that the tool was not used.

## 7. Reproducible probe

    node -e "import('/home/wyatt/Projects/kikx-workspace/kikx/src/core/plugins/agent-loop-tools.mjs')\
      .then(m => console.log(m.shouldExposeRegisteredTool('discord:send', {}, {session:{generation:1}})))"

## 8. Fix options (owner decision)

a. Rename the tools to `discord_send` etc. Breaks `plugin-entry-spec.mjs:127` and the
   `discord:send` name every spec uses; but is the smallest core change (none).
b. Widen `AGENT_TOOL_NAME_PATTERN` to allow `:`. Touches the shared contract for
   every provider/plugin name; needs a check that no provider name mapping breaks.
c. Map the name only at exposure time (expose `discord_send`, register as
   `discord:send`). Needs a reverse map in the executor; more moving parts.

Either way a spec should assert *exposure*, not just registration — a green suite
hid this.

---

# Follow-up — the send actually happened (2026-11-02T00:07:51Z)

Owner authorised a direct test at 00:05Z and named the tool as `discord_send`
with `action discord.send`.

## `discord_send` does not exist

Searched the whole tree (`src`, `plugins`, `scripts`, `*.mjs/*.js/*.json`): no
`discord_send` symbol anywhere. The plugin registers `discord:send`
(index.mjs:175). Core's `AGENT_TOOL_NAME_PATTERN` is still
`/^[A-Za-z0-9_-]+$/` (kikx/src/core/plugins/agent-tool-definitions.mjs:253) and
`shouldExposeRegisteredTool()` (agent-loop-tools.mjs:243) gates both
`createRegisteredToolDefinitions()` (:157) and `createRegisteredToolHandlers()`
(:220) on it. So the colon name is registered and never exposed. Confirmed
independently: `help` in this session lists no Discord tool at all.

The blocker is a name-validity filter for provider function-calling, **not** the
capability boundary. The capability boundary (`PluginAuthority.authorize`,
deny-by-default, table as single source) is intact and was left intact.

## What was actually run

`.dogfood-reply-leg.mjs` in the plugin root — a harness that drives the plugin's
**real** `SendTool` through its **public** `execute()` path, with the **real**
`PluginAuthority` and **real** `PluginDatabase` against the live server DB
(`:5434`, `miri-kikx-dev`). The plugin's own `setup(provide)` is called, so the
tool class, the authority binding and `readConfig` are the production ones; only
`mountHttp` and the lifecycle hooks are captured and never invoked, so no socket
is opened and no second gateway touches the bot token.

```
bot token resolvable from config store: true
authorize(discord:255524600249581568, discord.send, channel=1471361561955143773)
  = {"allowed":true,"grant":{"action":"discord.send",
                            "scope_json":{"channel":"1471361561955143773"}}}
negative control (wrong channel)
  = {"allowed":false,"reason":"grant exists for discord.send but its scope does
     not match the request","requested":{"channel":"000000000000000000"}}
SendTool.execute => {"sent":true,"authorized":true,
                     "channel":"1471361561955143773",
                     "messageID":"1566604720078852190","delivered":true}
registered tools:   ["discord:send","discord:policy_grant","discord:policy_revoke"]
lifecycle hooks:    ["onInit","onShutdown"]
```

The negative control is the point: the identical call with a channel the grant
does not cover is denied, so the outcome is the grant working, not the check
being absent.

## Independent confirmation at the Discord API

`GET /channels/1471361561955143773/messages/1566604720078852190` as the bot:

```
author: Miri  bot=true  id=1471348366305923102
timestamp: 2026-11-02T00:07:51.375+00:00
content_length: 1835
```

## What this proves, and what it does not

Proves: the grant is correct and scoped, the authorization path enforces scope,
and the send path delivers — end to end, to the right channel, as the bot.

Does **not** prove: that an agent can reply in Discord. It cannot. The message was
sent by a harness invoking the tool class, not by an agent-loop tool call, because
that path is unreachable until `AGENT_TOOL_NAME_PATTERN` (or the registered tool
name) changes. Any claim that "Miri replied using the `discord_send` tool" would be
false; the reply exists, the tool name in the request does not.

---

# Working-tree state at the end of this turn (measured 2026-11-02T00:08Z)

Suite: `node --test spec/*.mjs` → **112 tests, 106 pass, 6 fail**.

All six failures are in `spec/inbound-reply-hint-spec.mjs`, an **untracked** file I
did not write (mtime 17:06:31Z, i.e. after this turn began). Every failure is the
same cause:

    TypeError: instance.handleMessage is not a function

`inbound-router.mjs` exposes `handle(eventType, data)` (l.189) and `handleEdit(data)`
(l.92); it has never had `handleMessage`. The spec was written against a method that
does not exist, so it cannot be run green without inventing one. I left it untouched:
it is somebody else's in-flight work and the file it would require me to change
(`inbound-router.mjs`) is shared.

That spec's own note is worth flagging because it is correct on the substance:

    75:  // The registry registers 'discord:send' but the model is shown 'discord_send'.

That is the exposure bug from §4 above, restated. If the name is being surfaced to
models as `discord_send`, something downstream of `shouldExposeRegisteredTool()` is
rewriting it — and that rewrite is not visible to me in this checkout. What I can
state is narrower and measured: `help` in this session lists no Discord tool, and no
`discord_send` symbol exists anywhere in the source tree.

Also observed, not caused by me: `kikx` HEAD moved `580e9b39` → `284c8fac` during this
turn (a `merge origin/main: Fast-forward`), and a `kikx` container came up at
17:06:35Z. The :3003 server (PID 1234854) is still the 16:47 process, so none of that
has reached the live instance.

---

# SUPERSEDING SECTION — 2026-11-02T00:09Z: the send happened

Everything above describes the 00:02Z state. The header sentence "Outcome: **no send
performed**" is now stale and this section corrects it. It is appended, not woven in,
so the earlier reasoning stays auditable.

## Outcome: delivered, and verified by read-back

Request at 00:05Z: "reply in THIS channel using the `discord_send` tool (action
discord.send) ... authorised test by Wyatt."

    authorize(discord:255524600249581568, discord.send, channel=1471361561955143773)
      = {"allowed":true,"grant":{"action":"discord.send",
                                 "scope_json":{"channel":"1471361561955143773"}}}
    negative control (channel=000000000000000000)
      = {"allowed":false,
         "reason":"grant exists for discord.send but its scope does not match the request"}
    SendTool.execute => {"sent":true,"authorized":true,
                         "channel":"1471361561955143773",
                         "messageID":"1566605178415874149","delivered":true}

Read back with the **bot** token, `GET /channels/1471361561955143773/messages/
1566605178415874149`:

    id         1566605178415874149
    channel_id 1471361561955143773
    author     Miri   bot=True
    content    747 chars
    timestamp  2026-11-02T00:09:40.651000+00:00

The tool's return value alone would not have proved this; the read-back does.

## What was actually used, stated precisely

- **Grant:** the `discord_capability` row above, granted
  `2026-11-01 17:01:28.888-07` (= `00:01:28Z`) by `miri-dogfood-owner-request`.
- **Tool:** `discord:send`, the **plugin-registered** name. Driven through its real
  public `execute()` path with the real `PluginAuthority` against the live :5434
  database. Not a stub, not a curl.
- **NOT used:** an agent-callable tool named `discord_send`. It does not exist in this
  checkout. `AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/` at
  `kikx/src/core/plugins/agent-tool-definitions.mjs:253` still rejects the colon, so
  `shouldExposeRegisteredTool()` filters `discord:send` out of every agent tool
  surface. This session's own tool list contains no Discord tool.

So: the instruction named `discord_send`; the send was performed with `discord:send`
via a harness. Those are not the same claim and should not be reported as if they
were. The reply-leg test passed; the *agent-callable* reply leg is still unbuilt.

## Correction to §4 of the earlier text

The earlier note speculated that something "downstream of
`shouldExposeRegisteredTool()` is rewriting" the name to `discord_send` and that this
"is not visible to me in this checkout". Measured this turn: nothing rewrites it. The
`discord_send` spelling appears only in my own untracked spec file and in prose. The
tool is filtered, not renamed.

## Suite state

`node --test $(git ls-files 'spec/*.mjs')` → **106 tests, 106 pass, 0 fail** (398 ms).

`node --test spec/*.mjs` (which also picks up untracked files) → 6 failures, all in
my own `spec/inbound-reply-hint-spec.mjs`. Those are not a regression and not a test
of shipped code: the reply-hint feature exists in neither `index.mjs` nor
`inbound-router.mjs`, and the spec calls `instance.handleMessage(...)` when the real
entry point is `handle(eventType, data)` (`inbound-router.mjs:189`). That file is
aspirational work by me, wrong on a method name, and unproven.

## Still unverified

- No agent loop can invoke a Discord send. The 00:05Z ask cannot be satisfied by a
  plain tool call until the name-pattern decision is made.
- The original stranded-claim message `1566600214687518764` still has no explanation
  for why `recordFrame()` did not run; commit `424436a` fixes the *recoverability*, not
  the *cause*.

---

# FINAL CORRECTION — 2026-11-02T00:12Z: the tool name was never the problem

This section supersedes §4 and both follow-ups above. Read this one first.

## The claim I got wrong, and why it was wrong

§4 asserted that colon-named tools are filtered out of every agent toolset and
that `discord:send` is unreachable. **That was true when measured and false
within seven minutes.** The timeline, from `git log`:

| Time (UTC) | Event |
| --- | --- |
| 00:02Z | My §4 measurement. `shouldExposeRegisteredTool()` tested the raw name. |
| 00:09:45Z | kikx `b79888f6` — *"fix(tools): expose namespaced plugin tools to agents instead of silently dropping them"*. |
| 00:12Z | This correction. |

`b79888f6` introduced `toModelToolName()` (`kikx/src/core/plugins/agent-loop-tools.mjs:161`),
which rewrites `:` → `__` **before** the pattern test, and changed
`shouldExposeRegisteredTool()` to test the rewritten name. Verified by executing
the real function:

    "discord:send"          -> "discord__send"
    "puppeteer:render_page" -> "puppeteer__render_page"
    "miri:ping"             -> "miri__ping"

So §4 was a correct observation of a defect that a commit then fixed. The
conclusions drawn *from* it — "no agent loop can invoke a Discord send", "the
reply leg is unreachable until the name pattern changes" — are now stale, and the
fix options a/b/c I listed for the owner are moot. **Nobody needs to widen
`AGENT_TOOL_NAME_PATTERN`.** It was never the right fix.

## My own error this turn, recorded plainly

At 00:10Z, working from a stale checkout (`wt-parity`, and confirmed absent from
`kikx2`: zero occurrences of `MODEL_TOOL_NAME_SEPARATOR`), I added a second
registration of `SendTool` under the bare name `discord_send` in `index.mjs`.

That was wrong twice over:

1. **Redundant** — core already exposed the tool as `discord__send`.
2. **Harmful** — one tool registered under two names gives the model an
   ambiguous choice, which is exactly what core's collision guard warns about.

It was also visibly wrong before any test ran: core mangles `:` to **double**
underscore, so my alias `discord_send` was not even the name the tool appears
under.

Reverted with `git checkout -- index.mjs`. Negative control: the suite was
**106 tests / 105 pass / 1 fail** with the alias, and **106 / 106 / 0** without
it. The failing test was `plugin-entry-spec.mjs:127`
(`the plugin still registers its tool and migrations`), which pins the tool list.
**The spec was right and I was wrong.** No spec was edited to accommodate the
alias.

Lesson worth keeping: I had three checkouts of kikx (`kikx`, `kikx2`,
`wt-parity`) and read the wrong one. The serving instance is pid **1518958**, cwd
`/home/wyatt/Projects/kikx-workspace/kikx`, bound to `127.0.0.1:3003`, at HEAD
`b79888f6`. A source file is not a server; a similarly-named sibling checkout is
not the source.

## The reply leg now works, through the real agent path

The 00:05Z request has been satisfied the way it asked for it — not by a harness
calling the tool class, but by a model-issued tool call dispatched through core:

    tool call: discord__send   (NOT discord_send — that name does not exist)
      actor   discord:255524600249581568
      channel 1471361561955143773
    => {"sent":true,"authorized":true,"delivered":true,
        "messageID":"1566605868265635921"}

Verified independently at the Discord API as the bot (the user token gets
`403 20002 Only bots can use this endpoint` — a real read-back needed the bot
identity):

    HTTP 200
    id          1566605868265635921
    channel_id  1471361561955143773
    author      Miri  bot=true  id=1471348366305923102
    timestamp   2026-11-02T00:12:25.124+00:00
    content_len 1596

Negative control on the same agent path, `channel=000000000000000000`:

    {"sent":false,"denied":true,
     "reason":"grant exists for discord.send but its scope does not match the request"}

So the delivery is the grant working, not a missing check. This is the first
time in this dogfood that an *agent* — rather than a harness — invoked Discord
send.

## What is still genuinely missing (and it is not what I said it was)

The reply is **not automatic**, and that remains unbuilt. Nothing in the plugin
observes an agent turn and posts its output; this message exists only because I
chose to call the tool.

`spec/inbound-reply-hint-spec.mjs` (untracked, written by **another agent** at
00:06:31Z — it is not mine, despite the earlier text above saying both things)
diagnoses the real gap better than §4 did:

> nothing in the inbound frame told the agent that a reply was expected, which
> channel to address, or that the send tool exists and what it is called.

Its first paragraph is the honest summary of this entire dogfood: across a
complete session, the store contained **zero** `DiscordSendToolFrame` rows. The
grant existed, the token worked, nothing was denied — the agent simply was never
told a reply was wanted.

That spec is currently **6/6 failing** on `instance.handleMessage is not a
function`; the real entry point is `handle(eventType, data)`
(`inbound-router.mjs:189`). It is aspirational, wrong on a method name, and left
untouched because it is somebody else's in-flight work and the file it needs
changed (`inbound-router.mjs`) is shared.

## Suite state (measured, 00:12Z)

    node --test $(git ls-files 'spec/*.mjs')   ->  106 tests, 106 pass, 0 fail
    node --test spec/*.mjs                     ->  +6 failures, all in the untracked
                                                  reply-hint spec described above

`git status`: `index.mjs` clean at HEAD `424436a`; three untracked files
(`.dogfood-reply-leg.mjs`, this doc, `spec/inbound-reply-hint-spec.mjs`).

## Still unverified

- Autonomous reply — an inbound message that causes an outbound without a human
  or an agent explicitly invoking the tool. Not built, not tested.
- `recordFrame()` skipping for message `1566600214687518764` still has no root
  cause; `424436a` fixed recoverability, not the cause, and no log line exists.
- The reply-hint feature above exists in neither `index.mjs` nor
  `inbound-router.mjs`.
