'use strict';

// =============================================================================
// kikx-plugin-discord — Discord as a transport, not as part of a bot
// =============================================================================
// Receives Discord's interaction endpoint at /api/plugins/discord/interactions and
// exposes discord:send as a tool. Every send asks authorize() first: moving Discord out
// of Miri would otherwise delete the capability boundary that lived there.
//
// The raw request body is preserved for signature verification. Discord signs the bytes,
// so parsing them first would make verification impossible.
// =============================================================================

import crypto from 'node:crypto';
import { DiscordGateway, DEFAULT_INTENTS } from './gateway.mjs';
import { DiscordInboundRouter } from './inbound-router.mjs';

export const pluginName = 'discord';

export function setup(provide) {
  return provide(({ context, registry, mountHttp, authorize, db, registerMigrations, appendToSession, appendFrame, appendToSessionQuietly, readConfig }) => {
    registerMigrations({ directory: 'sql' });
    let PluginInterface = registry.getClass('PluginInterface');
    if (!PluginInterface)
      throw new Error('kikx-plugin-discord requires PluginInterface in plugin context');

    // Discord's documented replay window. A signature is valid forever over the same
    // bytes, so without this comparison a captured request can be replayed indefinitely.
    const MAX_SIGNATURE_AGE_SECONDS = 300;

    // The bot token lives under one config path; naming it once keeps the gateway, the
    // send tool and the interaction follow-up from drifting to different keys.
    const KIKX_DISCORD_BOT_TOKEN_PATH = '/kikx/discord/bot/token';

    // Ed25519 verification of X-Signature-Ed25519 over timestamp+body.
    function verifySignature({ publicKey, signature, timestamp, rawBody, now = Date.now() }) {
      if (!publicKey) return { ok: false, reason: 'no public key configured' };
      if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };

      // The timestamp is part of the signed material, so a stale one cannot be
      // rewritten by an attacker - but it is only binding if we compare it to now.
      let sentAt = Number(timestamp);
      if (!Number.isFinite(sentAt)) return { ok: false, reason: 'unreadable signature timestamp' };
      let ageSeconds = Math.abs(now / 1000 - sentAt);
      if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS)
        return { ok: false, reason: `signature timestamp is ${Math.round(ageSeconds)}s old, outside the ${MAX_SIGNATURE_AGE_SECONDS}s window` };
      try {
        // Discord supplies the raw 32-byte Ed25519 key. Node needs a complete SPKI
        // structure, so the key is wrapped in the fixed Ed25519 SPKI prefix first.
        let raw = Buffer.from(publicKey, 'hex');
        let spki = raw.length === 32
          ? Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
          : raw;
        let key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        let ok = crypto.verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, 'hex'));
        return { ok };
      } catch (error) {
        return { ok: false, reason: String(error.message) };
      }
    }

    // Interaction callback types we answer. A slash command (2) and a component click (3)
    // both expect a callback within three seconds; a guild message event, which is the
    // shape the gateway delivers, does not.
    const ACKABLE_INTERACTION_TYPES = new Set([ 2, 3 ]);

    // Components defer differently (type 6) than commands (type 5), and Discord rejects
    // the wrong one for the interaction kind.
    function deferTypeFor(interactionType) {
      return interactionType === 3 ? 6 : 5;
    }

    // The real answer goes to the interaction webhook, addressed by @original so it edits
    // the deferred placeholder instead of posting a second message. This runs after the
    // HTTP response has been sent, so a failure here has no status code left to occupy:
    // it is logged, and the placeholder is what the user is left looking at.
    async function updateInteractionOriginal({ applicationID, interactionToken, content }) {
      let token = await readConfig(KIKX_DISCORD_BOT_TOKEN_PATH, null);
      if (!token) return { ok: false, pending: 'no-bot-token' };

      try {
        let res = await fetch(
          'https://discord.com/api/v10/webhooks/' + encodeURIComponent(applicationID)
            + '/' + encodeURIComponent(interactionToken) + '/messages/@original',
          {
            method: 'PATCH',
            headers: {
              Authorization: 'Bot ' + token,
              'Content-Type': 'application/json',
              'User-Agent': 'Kikx-Discord (https://github.com/th317erd/kikx, 0.1.0)',
            },
            body: JSON.stringify({ content: String(content).slice(0, 2000) }),
          },
        );
        if (!res.ok)
          return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 300) };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }

    class SendTool extends PluginInterface {
      static pluginID = 'discord';
      static featureName = 'send';
      static displayName = 'Discord send';
      static description = 'Send a message to a Discord channel. Requires a capability grant.';
      static version = '0.1.0';
      static riskLevel = 'none';   // authorization is explicit below, not via a UI prompt
      static inputSchema = {
        type: 'object',
        required: ['actor', 'channel', 'content'],
        properties: {
          actor: { type: 'string', description: 'Who is sending' },
          channel: { type: 'string', description: 'Channel the grant must cover' },
          content: { type: 'string' },
        },
      };

      async _execute(params = {}) {
        let verdict = await authorize({
          actor: params.actor,
          action: 'discord.send',
          scope: { channel: params.channel },
        });
        if (!verdict.allowed)
          return { sent: false, denied: true, reason: verdict.reason };

        let token = await readConfig(KIKX_DISCORD_BOT_TOKEN_PATH, null);
        if (!token) {
          // Authorised but unable to deliver. Saying so is the only honest answer: a
          // "sent" that did not send is worse than a refusal.
          return {
            sent: false,
            denied: false,
            authorized: true,
            pending: 'no-bot-token',
            note: 'KIKX_DISCORD_BOT_TOKEN is not configured',
          };
        }

        let channelId = String(params.channel).replace(/^#/, '');
        let res;
        try {
          res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
            method: 'POST',
            headers: {
              Authorization: `Bot ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Kikx-Discord (https://github.com/th317erd/kikx, 0.1.0)',
            },
            body: JSON.stringify({ content: String(params.content).slice(0, 2000) }),
          });
        } catch (error) {
          return { sent: false, authorized: true, error: String(error?.message || error) };
        }

        if (!res.ok) {
          let detail = await res.text().catch(() => '');
          return { sent: false, authorized: true, status: res.status, error: detail.slice(0, 300) };
        }

        let body = await res.json().catch(() => null);
        return {
          sent: true,
          authorized: true,
          channel: channelId,
          messageID: body?.id || null,
          // Discord returns 200; a message id is the only proof it existed.
          delivered: Boolean(body?.id),
        };
      }
    }

    registry.registerTool('discord:send', SendTool);

    // The inbound gate needs a table that did not previously exist, and a way to put a
    // row in it. Without this tool the strict gate would be strict and unusable: every
    // message would be denied and the only fix would be hand-written SQL.
    //
    // Deliberately narrow: it may only grant actions that belong to this plugin, and only
    // to actors in the discord: namespace. A general capability-granting tool living
    // inside a transport plugin would be a backdoor, so this one cannot grant authority
    // it could not itself use.
    const GRANTABLE_ACTIONS = new Set(['discord.inbound', 'discord.send']);

    class PolicyGrantTool extends PluginInterface {
      static pluginID = 'discord';
      static featureName = 'policy_grant';
      static displayName = 'Discord capability grant';
      static description = 'Grant a Discord user the right to feed a channel into a session, or to send from it.';
      // high means the platform asks a human before the call runs. Granting authority is
      // exactly the class of action that should require that.
      static riskLevel = 'high';
      static inputSchema = {
        type: 'object',
        required: ['actor', 'action'],
        properties: {
          actor: { type: 'string', description: 'Discord user, as discord:<snowflake>' },
          action: { type: 'string', enum: [...GRANTABLE_ACTIONS] },
          channel: { type: 'string', description: 'Narrow the grant to one channel id' },
          grantedBy: { type: 'string', description: 'Who is granting' },
        },
      };

      async _execute(params = {}) {
        let actor = String(params.actor || '').trim();
        let action = String(params.action || '').trim();

        if (!/^discord:\d+$/.test(actor)) {
          return {
            granted: false,
            reason: 'actor must look like discord:<numeric user id>; this tool cannot grant '
              + 'authority to anything outside the Discord namespace',
          };
        }
        if (!GRANTABLE_ACTIONS.has(action)) {
          return { granted: false, reason: 'action "' + action + '" is not granted by this plugin' };
        }

        let scope = params.channel ? { channel: String(params.channel) } : null;
        await db().query(
          `INSERT INTO discord_capability (actor, action, scope_json, granted_by) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (actor, action, COALESCE(scope_json::text, '')) DO UPDATE SET granted_at = now(), granted_by = EXCLUDED.granted_by`,
          [actor, action, scope === null ? null : JSON.stringify(scope), params.grantedBy || null],
        );

        // A grant that is written but not in effect is the silent-success shape this
        // codebase keeps producing, so it is read back through the same authorize() the
        // gate uses, and the result is reported rather than assumed.
        let check = await authorize({ actor, action, scope: scope || {} });
        return {
          granted: check.allowed === true,
          verified: check.allowed === true,
          actor,
          action,
          scope,
          reason: check.allowed ? null : check.reason,
        };
      }
    }

    registry.registerTool('discord:policy_grant', PolicyGrantTool);

    // The grant tool without its mirror would leave revocation as hand-written SQL, so
    // a grant could only be taken away by someone with database access. Same narrow
    // remit as the grant: Discord-namespace actors, this plugin's own actions only.
    class PolicyRevokeTool extends PluginInterface {
      static pluginID = 'discord';
      static featureName = 'policy_revoke';
      static displayName = 'Discord capability revoke';
      static description = 'Remove a Discord user\'s right to feed a channel into a session, or to send from it.';
      static riskLevel = 'high';
      static inputSchema = {
        type: 'object',
        required: ['actor', 'action'],
        properties: {
          actor: { type: 'string', description: 'Discord user, as discord:<snowflake>' },
          action: { type: 'string', enum: [...GRANTABLE_ACTIONS] },
          channel: { type: 'string', description: 'Remove only the grant narrowed to this channel id' },
          allScopes: {
            type: 'boolean',
            description: 'Also remove the unscoped grant. Without it only the named scope goes.',
          },
        },
      };

      async _execute(params = {}) {
        let actor = String(params.actor || '').trim();
        let action = String(params.action || '').trim();

        if (!/^discord:\d+$/.test(actor)) {
          return {
            revoked: false,
            reason: 'actor must look like discord:<numeric user id>; this tool cannot touch '
              + 'authority outside the Discord namespace',
          };
        }
        if (!GRANTABLE_ACTIONS.has(action)) {
          return { revoked: false, reason: 'action "' + action + '" is not managed by this plugin' };
        }

        // Scope is named explicitly rather than inferred, because deleting "whatever
        // matches" is how a revoke removes a grant the caller did not mean to touch.
        let scope = params.channel ? { channel: String(params.channel) } : null;
        let allScopes = params.allScopes === true;

        let result = allScopes
          ? await db().query(
            'DELETE FROM discord_capability WHERE actor = $1 AND action = $2',
            [actor, action],
          )
          : await db().query(
            'DELETE FROM discord_capability WHERE actor = $1 AND action = $2 '
              + 'AND scope_json IS NOT DISTINCT FROM $3::jsonb',
            [actor, action, scope === null ? null : JSON.stringify(scope)],
          );

        let deleted = result?.rowCount ?? 0;

        // Report the effect, not the intent. A delete that matched nothing, or one that
        // left a broader grant in place, must not read as success - the same silent
        // success this codebase keeps producing elsewhere.
        let check = await authorize({ actor, action, scope: scope || {} });
        return {
          revoked: deleted > 0,
          deleted,
          verified: check.allowed !== true,
          stillAllowed: check.allowed === true,
          actor,
          action,
          scope,
          allScopes,
          note: deleted === 0
            ? 'No matching grant existed; nothing was revoked.'
            : check.allowed === true
              ? 'Deleted ' + deleted + ' grant(s), but a broader grant still authorizes this action. '
                + 'Repeat with allScopes: true to remove it.'
              : 'Grant removed and no grant remains for this action.',
        };
      }
    }

    registry.registerTool('discord:policy_revoke', PolicyRevokeTool);

    // --- gateway -------------------------------------------------------------
    // Interactions arrive over HTTP, but ordinary channel messages only arrive over the
    // gateway websocket. Without it, a Discord channel is a one-way transport: replies
    // reach Discord, messages from Discord do not reach the session.
    let socket = null;
    let heartbeat = null;
    let sequence = null;
    let stopped = false;

    // The gateway is the only path by which an ordinary channel message reaches a
    // session; interactions are slash commands and buttons only. Keeping this wiring in
    // onInit is what makes gateway.mjs reachable from the plugin rather than a module
    // only its own spec imports.
    let gateway = null;

    // The gateway reports through console.warn and nothing else can see it, so
    // "is the bot connected, and why did my message not appear?" was answerable only
    // from a shell on the host. These are the facts that answer it, exposed at
    // GET /api/plugins/discord/status. No credential is ever included: a token in a
    // status body is a token in a log.
    let observed = {
      startedAt: Date.now(),
      tokenPresent: false,
      lastDispatchAt: null,
      lastDispatchType: null,
      recentOutcomes: [],
    };

    // Every dispatch decision is recorded, not just the handled ones. A denial that is
    // only a log line is indistinguishable from a gateway that never delivered anything.
    function noteOutcome(eventType, result) {
      observed.lastDispatchAt = Date.now();
      observed.lastDispatchType = eventType;
      observed.recentOutcomes.push({
        at: new Date().toISOString(),
        eventType,
        handled: result?.handled === true,
        reason: result?.reason || null,
        channelID: result?.channelID || null,
        actorID: result?.actorID || null,
        detail: result?.detail || null,
      });
      if (observed.recentOutcomes.length > 20) observed.recentOutcomes.shift();
    }

    function gatewaySnapshot() {
      let status = typeof gateway?.status === 'function' ? gateway.status() : null;
      return {
        tokenPresent: observed.tokenPresent,
        connected: status?.ready === true,
        gateway: status,
        startedAt: new Date(observed.startedAt).toISOString(),
        lastDispatchAt: observed.lastDispatchAt ? new Date(observed.lastDispatchAt).toISOString() : null,
        lastDispatchType: observed.lastDispatchType,
        recentOutcomes: observed.recentOutcomes.slice(-10),
        inboundChannelID: inbound.autoBindChannelID,
        inboundSessionID: inbound.autoBindSessionID,
      };
    }

    // The frame type this transport writes into a session.
    //
    // Extends the core UserMessage class resolved through the registry rather than
    // importing it, so this plugin declares its own behaviour without depending on a
    // core module path. `static agentOnly = true` is the whole point: core stamps
    // `agentOnly` on every frame written with this type, which keeps the frame out of
    // the session transcript while still delivering it to the agent. The alternative,
    // `hidden: true`, is filtered out of model context and would leave the bot deaf.
    //
    // `getAuthorDisplayName` returns the Discord handle: a Discord message is neither
    // the owner speaking nor an agent, and saying so on the card is what makes the
    // frame traceable when it is revealed.
    let UserMessageBase = registry.getClass('FrameTypeUserMessage');
    if (typeof UserMessageBase !== 'function')
      throw new Error('kikx-plugin-discord requires FrameTypeUserMessage in the class registry');

    class FrameTypeDiscordFrame extends UserMessageBase {
      static agentOnly = true;

      getAuthorDisplayName() {
        let name = this._frameData?.content?.discord?.authorName
          || this._frameData?.authorDisplayName
          || 'Discord';
        return `${name} (Discord)`;
      }
    }

    registry.registerClass('FrameTypeDiscordFrame', FrameTypeDiscordFrame);

    // Routing policy lives in inbound-router.mjs so it can be tested without a socket,
    // a database, or a session runtime. Every effect it needs is bound here.
    let inbound = new DiscordInboundRouter({
      findChannelSession: (channelID) => db().one(
        'SELECT session_id FROM discord_channel_session WHERE channel_id = $1',
        [channelID],
      ),
      bindChannelSession: ({ channelID, sessionID }) => db().query(
        'INSERT INTO discord_channel_session (channel_id, session_id) VALUES ($1,$2) ON CONFLICT (channel_id) DO NOTHING',
        [channelID, sessionID],
      ),
      // Fills in the row claimMessage() reserved. The WHERE guard is the point: a row
      // whose frame_id is still NULL is an unfilled claim and may be completed, while a
      // real record (frame_id already set) is never overwritten - that row owns the
      // original text and the edit history accumulated against it.
      recordFrame: ({ messageID, sessionID, frameID, text }) => db().query(
        `INSERT INTO discord_message_frame (message_id, session_id, frame_id, original_text)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (message_id) DO UPDATE
           SET session_id = EXCLUDED.session_id,
               frame_id = EXCLUDED.frame_id,
               original_text = EXCLUDED.original_text
           WHERE discord_message_frame.frame_id IS NULL`,
        [messageID, sessionID, frameID, text],
      ),
      // The exclusive claim. INSERT ... ON CONFLICT DO NOTHING RETURNING is atomic:
      // exactly one racing caller gets a row back and the others get none, so two live
      // gateways cannot both frame the same Discord message. seenMessage() alone was a
      // read followed much later by a write, and on 3003 that gap produced frames 4+5
      // and 7+8 from single messages.
      claimMessage: async ({ messageID }) => {
        let row = await db().one(
          `INSERT INTO discord_message_frame (message_id, session_id, frame_id, original_text)
           VALUES ($1,'',NULL,'')
           ON CONFLICT (message_id) DO NOTHING
           RETURNING message_id`,
          [messageID],
        );
        if (row) return true;
        // No row came back. That means the message id already existed - but a driver or
        // a test double that reports "no rows" without distinguishing "conflicted" from
        // "inserted, nothing returned" would be read as a race we lost, and we would drop
        // every inbound message. Dropping a message we could have framed is far worse
        // than framing one twice, so confirm before deciding: only a row we can actually
        // see counts as already-claimed.
        let existing = await db().one(
          'SELECT 1 AS present FROM discord_message_frame WHERE message_id = $1',
          [messageID],
        );
        return !existing;
      },
      // Dedupe against the mapping table the transport already owns: a RESUME replay
      // redelivers events, and framing one twice would duplicate the message.
      seenMessage: async (messageID) => Boolean(await db().one(
        'SELECT 1 AS seen FROM discord_message_frame WHERE message_id = $1',
        [messageID],
      )),
      appendToSession: (sessionID, input) => appendToSession(sessionID, input),
      // A typed write: the frame is a DiscordFrame, not a UserMessage pretending to
      // be one. appendToSession cannot express that - it hardcodes the type.
      appendFrame: (sessionID, input) => appendFrame(sessionID, input),
      // Whoever receives the frame is decided by core from the session's coordinator.
      // This only makes sure the session has one.
      ensureSessionRecipient: (args) => ensureSessionRecipient(args),
      // Both live in the mapping table this transport owns.
      findFrame: (messageID) => db().one(
        'SELECT session_id, frame_id, original_text, edits, audit FROM discord_message_frame WHERE message_id = $1',
        [messageID],
      ),
      updateFrameAudit: ({ messageID, audit, edits }) => db().query(
        'UPDATE discord_message_frame SET edits = $2, audit = $3::jsonb WHERE message_id = $1',
        [messageID, edits, JSON.stringify(audit)],
      ),
      log: (level, message) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[discord] ${message}`),
      botUserID: () => gateway?.status?.().userId || gateway?.userId || null,
      // Deny by default, from the same authority table the send path uses. A Discord
      // user is a distinct actor from any Kikx user, so it is namespaced rather than
      // mapped onto one: no Discord id can ever collide with a Kikx user id.
      authorizeInbound: async ({ actorID, channelID }) => {
        if (!actorID) return { allowed: false, reason: 'no actor id' };
        return authorize({
          actor: 'discord:' + actorID,
          action: 'discord.inbound',
          scope: { channel: channelID },
        });
      },
    });

    // Binding config is read at delivery time rather than setup time: a reload has no
    // config store yet, and an operator changing the target channel should not have to
    // wait for a process restart to be believed.
    async function refreshInboundConfig() {
      inbound.autoBindChannelID = await readConfig('/kikx/discord/inbound/channel', null);
      inbound.autoBindSessionID = await readConfig('/kikx/discord/inbound/session', null);
    }

    // Give the inbound session somebody to route to.
    //
    // The inbound session comes from configuration rather than from a human creating
    // it, so it can exist with `participantAgentIDs: []` and `coordinatorAgentID: null`.
    // Core routes every frame to the session coordinator and `AgentRouteFramePlugin`
    // returns early when there is none, so in that state an inbound Discord message is
    // written, is readable, and wakes nobody: accepted and silently unrouted.
    //
    // `inviteAgentToSession` is the supported path out of that state. It adds the
    // participant AND re-resolves the session tree, which force-promotes a coordinator
    // for a root session that has just gained its first bot. That promotion is core's
    // rule, not ours; this transport only supplies the missing member.
    //
    // Resolved lazily rather than at setup time: plugins are loaded before the frame
    // runtime exists in the container (create-server sets it after loadPlugins), so a
    // captured reference here would be null for the life of the process.
    async function ensureSessionRecipient({ sessionID }) {
      let runtime = context?.has?.('frameRuntime') ? context.require('frameRuntime') : null;
      let agentManager = context?.has?.('agentManager') ? context.require('agentManager') : null;
      if (typeof runtime?.inviteAgentToSession !== 'function') return;
      if (typeof agentManager?.resolveAgent !== 'function') return;

      // Never second-guess a session that already has members: a human may have
      // curated the participant list, and adding to it would be our policy, not theirs.
      let session = runtime.getSession?.(sessionID) || null;
      if (Array.isArray(session?.participantAgentIDs) && session.participantAgentIDs.length > 0)
        return;

      let agent = await resolveInboundAgent(agentManager);
      if (!agent) return;

      let result = await runtime.inviteAgentToSession(sessionID, agent, { invitedByAgentID: null });
      if (result?.alreadyParticipant === true) return;
      console.log(`[discord] invited ${agent.name || agent.id} into ${sessionID} so inbound messages have a coordinator to route to`);
    }

    // Which agent should own inbound traffic here.
    //
    // Explicit configuration wins. Falling back to "the only enabled agent" is
    // deliberately narrow: on an instance with exactly one bot there is no ambiguity
    // about who the operator means, and doing nothing quietly would leave messages on
    // the floor, which is the defect. With two or more agents it declines rather than
    // guessing - picking one of several is a policy decision this transport has no
    // standing to make.
    async function resolveInboundAgent(agentManager) {
      let configured = await readConfig('/kikx/discord/inbound/agent', null);
      if (typeof configured === 'string' && configured.trim() !== '')
        return await agentManager.resolveAgent(configured.trim());

      let listing = await agentManager.listAgents({ limit: 100 });
      let agents = Array.isArray(listing) ? listing : (listing?.agents || []);
      let enabled = agents.filter((entry) => entry && entry.enabled !== false && entry.id);
      return enabled.length === 1 ? enabled[0] : null;
    }

    async function gatewayLoop() {
      // Never run two gateways from one plugin instance.
      //
      // Core's reload path now calls onShutdown (which sets stopped and retires the
      // gateway), but that hook was skipped for a long time and cost real damage: on
      // 3003 four gateways ended up live against one bot token, Discord closed the
      // duplicates with code 4000, and one channel message was framed twice because two
      // gateways both handled it. A transport must not depend on the host getting the
      // lifecycle exactly right, so this refuses to open a second connection and says so.
      if (stopped) {
        console.warn('[discord] gateway not started: plugin instance has been shut down');
        return;
      }
      if (gateway) {
        console.warn('[discord] gateway already running for this plugin instance; not starting another');
        return;
      }

      let token = await readConfig(KIKX_DISCORD_BOT_TOKEN_PATH, null);
      if (!token) {
        // No token: say so once and stop. Reconnect-spinning on a missing credential is
        // how a plugin becomes a log flood.
        observed.tokenPresent = false;
        console.warn('[discord] gateway not started: no bot token configured');
        return;
      }

      await refreshInboundConfig();
      observed.tokenPresent = true;

      gateway = new DiscordGateway({
        token,
        intents: DEFAULT_INTENTS,
        onDispatch: async (eventType, data) => {
          let result = await inbound.handle(eventType, data);
          noteOutcome(eventType, result);
          // Everything the router declines to frame is worth one line, except the
          // high-frequency cases: silence there would hide a missing intent.
          if (!result.handled && result.reason !== 'not_a_message' && result.reason !== 'own_message')
            console.warn(`[discord] not framed: ${result.reason}${result.channelID ? ` (channel ${result.channelID})` : ''}`);
        },
        log: (level, message) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[discord] ${message}`),
      });

      await gateway.start();
    }

    mountHttp(async ({ request, response, rawBody, json, subPath, context, identity }) => {
      // --- status --------------------------------------------------------------
      // The mount is public because Discord cannot hold a Kikx session; that must not
      // make the status readable anonymously, so identity is resolved here. Core only
      // resolves identity for non-public mounts, which is why this asks the account
      // store directly rather than assuming identity arrived.
      if (request.method === 'GET' && subPath === '/status') {
        let viewer = identity;
        if (!viewer) {
          let accountStore = context?.has?.('accountStore')
            ? context.require('accountStore')
            : context?.accountStore || null;
          if (accountStore && typeof accountStore.resolveIdentity === 'function') {
            try { viewer = await accountStore.resolveIdentity(request); }
            catch (_e) { viewer = null; }
          }
        }

        if (!viewer) {
          response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { message: 'Sign in required to read Discord plugin status' } }));
          return;
        }

        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, ...gatewaySnapshot() }));
        return;
      }

      if (request.method !== 'POST' || subPath !== '/interactions') {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      // Discord's PING handshake: type 1 must be answered with type 1, and it is how
      // Discord validates the endpoint before any signature is useful.
      let payload = null;
      try { payload = json(); } catch (_e) { payload = null; }

      let verdict = verifySignature({
        publicKey: await readConfig('/kikx/discord/public/key', null),
        signature: request.headers['x-signature-ed25519'],
        timestamp: request.headers['x-signature-timestamp'],
        rawBody,
      });

      if (!verdict.ok) {
        response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'invalid request signature', reason: verdict.reason } }));
        return;
      }

      if (payload && payload.type === 1) {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ type: 1 }));
        return;
      }

      // --- interaction callbacks -------------------------------------------------
      // Discord parses this response body as an interaction callback; it does not care
      // about the status code. Answering 202 with a Kikx-shaped body therefore looked
      // successful here and to every test, while Discord told the user "The application
      // did not respond": a slash command was being served a message-event contract.
      // The callback is now the deferral Discord expects, and the outcome is delivered
      // on the interaction webhook, because framing needs the database and cannot be
      // guaranteed inside the three-second window.
      if (payload && ACKABLE_INTERACTION_TYPES.has(payload.type)) {
        let applicationID = payload.application_id || await readConfig('/kikx/discord/application/id', null);
        let interactionToken = payload.token || null;

        // Without credentials there is no webhook to correct a deferral on, so deferring
        // would strand the user on a permanent "thinking...". An immediate ephemeral
        // answer is in-window and true.
        if (!applicationID || !interactionToken) {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({
            type: 4,
            data: {
              content: 'Kikx has no Discord application credential configured, so this interaction was not processed.',
              flags: 64,
            },
          }));
          return;
        }

        // Acknowledge BEFORE any work: dedupe, authorization and the session write all
        // happen below and any of them can outlast the window. Ephemeral keeps the
        // channel quiet while the outcome is still unknown.
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ type: deferTypeFor(payload.type), data: { flags: 64 } }));

        // The interaction id is unique per invocation, so it stands in for a message id
        // and dedupe, recordFrame and the edit mapping keep working unchanged.
        await refreshInboundConfig();
        let routed = await inbound.handle('MESSAGE_CREATE', payload);

        let reply;
        if (routed.handled)
          reply = 'Received - framed into session ' + routed.sessionID
            + (routed.frameID ? ' (frame ' + routed.frameID + ')' : '') + '.';
        else if (routed.reason === 'duplicate')
          reply = 'Already received - this interaction was framed earlier.';
        else if (routed.reason === 'not_authorized')
          reply = 'Not authorized: your Discord account has no grant to send into this channel.';
        else if (routed.reason === 'unbound_channel')
          reply = 'This channel is not bound to a Kikx session, so nothing was framed.';
        else
          reply = 'Not framed: ' + routed.reason + '.';

        let updated = await updateInteractionOriginal({ applicationID, interactionToken, content: reply });
        if (!updated.ok)
          console.warn('[discord] interaction follow-up failed'
            + (updated.status ? ' (HTTP ' + updated.status + ')' : '')
            + ': ' + (updated.error || updated.pending || 'unknown'));
        return;
      }

      // --- message edits -------------------------------------------------------
      // An edit UPDATES the original frame: same id, original text untouched, an audit
      // tail added to its content. It never creates a second frame and never rewrites the
      // text the bot first saw. Edits do not wake the session - a quiet append, because
      // the bot reads the change in its context when it next runs.

      // Edits go through the same policy object that frames messages, so the
      // authorization gate, the self-message filter and the audit format have exactly
      // one definition. The inline copy that used to live here was a second
      // implementation, and it never consulted the gate at all.
      if (payload?.t === 'MESSAGE_UPDATE') {
        let edited = await inbound.handle('MESSAGE_UPDATE', payload);
        if (edited.handled) {
          response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: true, updated: edited.frameID, edit: edited.edits }));
          return;
        }
        if (edited.reason === 'unframed_message') {
          // An edit for a message we never stored: nothing to update, and guessing would
          // be worse than ignoring it.
          response.writeHead(204);
          response.end();
          return;
        }
        if (edited.reason === 'not_authorized') {
          response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { message: 'Not authorized', reason: edited.detail } }));
          return;
        }
        response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, note: 'not updated: ' + edited.reason }));
        return;
      }

      // Ordinary messages and slash commands go through the SAME policy object the
      // gateway uses above. An inline second copy here is how dedupe, the self-message
      // filter, and the missing-intent diagnostic silently stopped applying to anything
      // that arrived over HTTP - the two paths had already drifted apart.
      let channelId = payload?.channel_id || payload?.channel?.id || null;
      if (!channelId) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'no channel_id in payload' } }));
        return;
      }

      await refreshInboundConfig();
      let routed = await inbound.handle('MESSAGE_CREATE', payload);
      if (routed.handled) {
        response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, sessionID: routed.sessionID, frameID: routed.frameID }));
        return;
      }

      // An unbound channel is an operator error the caller can act on; a duplicate or a
      // message with no text is not, and answering "not bound" for those would send
      // whoever reads it chasing a binding that is already correct.
      if (routed.reason === 'unbound_channel') {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: `channel ${channelId} is not bound to a session` } }));
        return;
      }

      response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, note: `not framed: ${routed.reason}` }));
    }, { auth: 'public' });

    // Returned as an object, not a function: loadPlugins treats a returned function as a
    // teardown and would silently skip onInit and onShutdown.
    return {
      onInit() { return gatewayLoop(); },
      onShutdown() {
        stopped = true;
        if (heartbeat) clearInterval(heartbeat);
        if (socket && typeof socket.close === 'function') socket.close();
        socket = null;
        // The gateway owns its own reconnect timers; leaving them armed would keep
        // dialling Discord for a plugin that has been unloaded.
        if (gateway) gateway.stop();
        gateway = null;
      },
    };
  });
}
