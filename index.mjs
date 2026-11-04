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
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DiscordGateway, DEFAULT_INTENTS } from './gateway.mjs';
import { DiscordInboundRouter } from './inbound-router.mjs';
import { DISCORD_MESSAGE_LIMIT, splitDiscordMessage } from './message-split.mjs';
import { registerDiscordTools } from './discord-tools.mjs';

export const pluginName = 'discord';

// The card the client draws for an outbound reply. Registered by declaring it on
// the tool: PluginRegistry.registerTool() turns `frameType` + `clientComponent`
// into a frame component, which is how the client learns to render
// DiscordSendToolFrame instead of the generic tool card. No core change.
const SEND_CARD_TAG = 'kikx-discord-send-card';
const SEND_CARD_URL = '/api/plugins/discord/client/discord-send-card.mjs';
const SEND_CARD_FILE = fileURLToPath(new URL('./client/discord-send-card.mjs', import.meta.url));
// The INBOUND half. The type class below makes an inbound message a real
// DiscordFrame server-side; this is what makes it legible client-side. Without
// it the frame had no registered renderer at all and an operator saw a bare
// "Message" chip with no author and no body.
const MESSAGE_CARD_TAG = 'kikx-discord-message-card';
const MESSAGE_CARD_URL = '/api/plugins/discord/client/discord-message-card.mjs';
const MESSAGE_CARD_FILE = fileURLToPath(new URL('./client/discord-message-card.mjs', import.meta.url));

// subPath -> file on disk. The mount is public because a browser imports these
// with no Kikx session attached; it serves exactly these files and nothing else.
const CLIENT_MODULES = new Map([
  ['/client/discord-send-card.mjs', SEND_CARD_FILE],
  ['/client/discord-message-card.mjs', MESSAGE_CARD_FILE],
]);

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
    // The gateway off-switch. Named once so gatewayLoop and any status/health
    // surface agree on the same key. Env form: KIKX_DISCORD_GATEWAY_ENABLED.
    const GATEWAY_ENABLED_PATH = '/kikx/discord/gateway/enabled';

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
    async function updateInteractionOriginal({ applicationID, interactionToken, channelID, content }) {
      let token = await readConfig(KIKX_DISCORD_BOT_TOKEN_PATH, null);
      if (!token) return { ok: false, pending: 'no-bot-token' };

      // An interaction has exactly ONE @original message, so the first chunk edits
      // the deferred placeholder and any remainder is posted as follow-up channel
      // messages, in order. This used to be slice(0, 2000): everything past the
      // limit was discarded while the call still reported success. A truncated
      // reply is worse than a split one because it looks complete. See
      // message-split.mjs.
      let chunks = splitDiscordMessage(content, DISCORD_MESSAGE_LIMIT);
      if (chunks.length === 0) chunks = [ '' ];

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
            body: JSON.stringify({ content: chunks[0] }),
          },
        );
        if (!res.ok)
          return { ok: false, status: res.status, error: (await res.text().catch(() => '')).slice(0, 300) };

        let overflow = chunks.length - 1;
        if (overflow === 0)
          return { ok: true, chunks: 1, overflow: 0 };

        // The remainder needs a real channel. Without one the first chunk still
        // reached the user, so this is reported rather than thrown.
        if (!channelID) {
          console.warn(
            '[discord] reply split into ' + chunks.length + ' parts but the interaction carried no channel id; only the first was delivered',
          );
          return { ok: true, chunks: 1, overflow, truncated: true };
        }

        let delivered = 1;
        for (let chunk of chunks.slice(1)) {
          let posted = await fetch(
            'https://discord.com/api/v10/channels/' + encodeURIComponent(channelID) + '/messages',
            {
              method: 'POST',
              headers: {
                Authorization: 'Bot ' + token,
                'Content-Type': 'application/json',
                'User-Agent': 'Kikx-Discord (https://github.com/th317erd/kikx, 0.1.0)',
              },
              body: JSON.stringify({ content: chunk }),
            },
          );
          if (!posted.ok)
            return { ok: false, chunks: delivered, overflow, status: posted.status,
              error: (await posted.text().catch(() => '')).slice(0, 300) };
          delivered += 1;
        }

        return { ok: true, chunks: delivered, overflow: 0 };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }

    // Which inbound Discord message this send is answering.
    //
    // The transport already owns the mapping table: discord_message_frame holds the
    // session, the message id the message arrived as, and the exact text the agent was
    // shown ('[discord:<name>] <body>'). Quoting from it means the reply card can show
    // the conversation without depending on a core frame-read API a plugin may not
    // assume, and without inventing a message that was never sent. If the lookup finds
    // nothing, the card simply renders as it did before.
    //
    // Best effort on purpose: a transcript read must never fail or delay a send. The
    // send is what the caller asked for; the quote is documentation of it.
    async function findReplyTarget(sessionID) {
      if (typeof sessionID !== 'string' || sessionID === '')
        return null;

      let row = null;
      try {
        row = await db().one(
          `SELECT message_id, created_at, original_text
             FROM discord_message_frame
            WHERE session_id = $1
              AND frame_id IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1`,
          [sessionID],
        );
      } catch (error) {
        console.warn('[discord] could not look up the message being answered: ' + String(error?.message || error));
        return null;
      }

      if (!row || typeof row.original_text !== 'string')
        return null;

      // original_text is the framed text, prefix included. Strip our own annotation so
      // the card quotes what the person wrote rather than how we labelled them.
      let match = /^\[discord:([^\]]*)\] ?/.exec(row.original_text);
      let author = match ? match[1] : '';
      let text = match ? row.original_text.slice(match[0].length) : row.original_text;

      if (text === '')
        return null;

      return {
        messageID: typeof row.message_id === 'string' ? row.message_id : String(row.message_id ?? ''),
        author,
        text,
        at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
      };
    }

    class SendTool extends PluginInterface {
      static pluginID = 'discord';
      static featureName = 'send';
      static displayName = 'Discord send';
      static description = 'Send a message to a Discord channel. Requires a capability grant.';
      static version = '0.1.0';
      static riskLevel = 'none';   // authorization is explicit below, not via a UI prompt
      // Derived by core when a tool does not name one; named here so the client
      // component below is attached to the type that is actually written.
      static frameType = 'DiscordSendToolFrame';
      static clientComponent = { tagName: SEND_CARD_TAG, moduleURL: SEND_CARD_URL };
      static inputSchema = {
        type: 'object',
        required: ['actor', 'channel', 'content'],
        properties: {
          actor: { type: 'string', description: 'Who is sending' },
          channel: { type: 'string', description: 'Channel the grant must cover' },
          content: { type: 'string' },
          replyToMessageID: { type: 'string', description: 'Optional: make this a TRUE reply to that message id' },
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

        // Computed here rather than passed in by the caller: the agent knows what it
        // wants to say, not which frame woke it. Core injects _sessionID into every
        // tool call (enrichToolInput), so the transport can answer that itself.
        let replyTo = await findReplyTarget(params._sessionID);
        let replyToField = replyTo ? { replyTo } : {};
        // A reply longer than one Discord message is sent as several, in order.
        // This used to be slice(0, 2000): the tail was discarded and the call still
        // reported success, so an agent believed it had answered fully and the human
        // received a reply that stopped mid-sentence with no marker anywhere. See
        // message-split.mjs.
        let chunks = splitDiscordMessage(params.content, DISCORD_MESSAGE_LIMIT);
        if (chunks.length === 0)
          return { sent: false, authorized: true, error: 'content is empty', ...replyToField };

        let messageIDs = [];
        let firstResponse = null;
        for (let [chunkIndex, chunk] of chunks.entries()) {
          let res;
          try {
            res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
              method: 'POST',
              headers: {
                Authorization: `Bot ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Kikx-Discord (https://github.com/th317erd/kikx, 0.1.0)',
              },
              body: JSON.stringify({
                content: chunk,
                // A TRUE Discord reply. Only the FIRST chunk carries the
                // reference: a split reply that quoted the parent on every part
                // would draw the same reply quote above each message.
                ...(chunkIndex === 0 && params.replyToMessageID
                  ? { message_reference: { message_id: String(params.replyToMessageID), fail_if_not_exists: false } }
                  : {}),
              }),
            });
          } catch (error) {
            return {
              sent: messageIDs.length > 0,
              authorized: true,
              channel: channelId,
              messageID: messageIDs[0] || null,
              messageIDs,
              chunks: chunks.length,
              deliveredChunks: messageIDs.length,
              error: String(error?.message || error),
              ...replyToField,
            };
          }

          if (!res.ok) {
            let detail = await res.text().catch(() => '');
            // A partial send is reported as such: some text DID land, so saying
            // "not sent" would be false, and saying "sent" would hide the gap.
            return {
              sent: messageIDs.length > 0,
              authorized: true,
              channel: channelId,
              status: res.status,
              messageID: messageIDs[0] || null,
              messageIDs,
              chunks: chunks.length,
              deliveredChunks: messageIDs.length,
              error: detail.slice(0, 300),
              ...replyToField,
            };
          }

          firstResponse = firstResponse || res;
          let posted = await res.json().catch(() => null);
          if (posted?.id)
            messageIDs.push(posted.id);
        }

        return {
          sent: messageIDs.length > 0,
          authorized: true,
          channel: channelId,
          messageID: messageIDs[0] || null,
          // Every id, so a caller can see the split rather than guessing from a count.
          messageIDs,
          chunks: chunks.length,
          deliveredChunks: messageIDs.length,
          // Discord returns 200; a message id is the only proof it existed.
          delivered: messageIDs.length === chunks.length && messageIDs.length > 0,
          // What this message answers, so the session thread reads as a conversation
          // instead of an agent talking to itself. Inbound DiscordFrame rows are
          // agentOnly and hidden by design; the reply carries the other half.
          // The explicit parent id, when the caller asked for a true reply.
          ...(params.replyToMessageID ? { replyToMessageID: String(params.replyToMessageID) } : {}),
          ...replyToField,
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
    const GRANTABLE_ACTIONS = new Set(['discord.inbound', 'discord.send', 'discord.read', 'discord.react']);

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

    // Read + reaction + file tools (7 more, 10 registered in total). Registered
    // HERE, from the entry point: a correct module nothing enters is the defect
    // shape this plugin keeps producing, so spec/plugin-entry-spec.mjs asserts
    // the full tool list comes out of this exact call path, not merely out of
    // discord-tools.mjs's own spec.
    registerDiscordTools({ registry, PluginInterface, authorize, readConfig, tokenPath: KIKX_DISCORD_BOT_TOKEN_PATH });

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
      // null until gatewayLoop evaluates the off-switch; then true/false.
      gatewayEnabled: null,
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
        gatewayEnabled: observed.gatewayEnabled,
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

    // Server class alone is not enough. Registering it makes the frame typed,
    // agentOnly and attributed - but 'client-components' then advertised ZERO
    // renderers for 'DiscordFrame' (measured on the live instance: 123
    // descriptors, 2 of them Discord, both for the outbound tool frame), so the
    // frame fell through core's generic path and rendered as an anonymous
    // "Message" chip. A transport that can write a frame type has to be able to
    // say what it looks like.
    //
    // registerFrameComponent rather than registerComponent('frame', ...): the
    // kind is not an enumeration here, it is a dispatch, and this is the
    // registrar that owns the frame map.
    registry.registerFrameComponent('DiscordFrame', {
      tagName: MESSAGE_CARD_TAG,
      moduleURL: MESSAGE_CARD_URL,
      // Read by core's compact-header path to label a collapsed frame. Falls
      // back to the generic type name when a plugin does not declare one, so
      // declaring it is the difference between "Discord Message" and
      // "DiscordFrame".
      label: 'Discord Message',
      icon: 'chat',
    });

    // Routing policy lives in inbound-router.mjs so it can be tested without a socket,
    // a database, or a session runtime. Every effect it needs is bound here.
    // How long a claim may sit unfilled before a redelivery is allowed to take it
    // over. Discord redelivers promptly, so this only has to exceed one handler's
    // claim-to-write gap (milliseconds) without making a lost message wait forever.
    const CLAIM_GRACE_SECONDS = 120;

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
      // A claim that is abandoned must be releasable, or the message id is poisoned:
      // claimMessage() answers 'duplicate' forever and recordFrame()'s own self-heal
      // (WHERE frame_id IS NULL) becomes unreachable by construction.
      //
      // Only rows with no frame behind them are deleted. Once a frame exists the
      // mapping may be incomplete, but re-framing would duplicate the message, which
      // is strictly worse than a missing mapping row.
      releaseClaim: ({ messageID }) => db().query(
        'DELETE FROM discord_message_frame WHERE message_id = $1 AND frame_id IS NULL',
        [messageID],
      ),
      claimMessage: async ({ messageID }) => {
        // One statement, so there is no window between deciding and claiming.
        //
        // DO NOTHING was the original rule, and it had a failure mode: a handler that
        // died between the claim and the frame write left a row with frame_id NULL
        // that nothing could reach again. Every redelivery read it as an already-
        // claimed duplicate, so the message was lost permanently and silently, and
        // recordFrame()'s own self-heal (WHERE frame_id IS NULL) was unreachable.
        //
        // DO UPDATE takes such a row over, but only when it is provably abandoned:
        //   * frame_id IS NULL      - no frame was ever written for it, and
        //   * older than the grace window - so a handler that is merely between
        //     claim and write is not robbed of its own claim.
        //
        // That second condition is what keeps this from reopening the duplicate-frame
        // race the claim was introduced to close. A concurrent handler's claim-to-
        // write window also has frame_id NULL, so "unfilled" alone is not evidence of
        // abandonment. A row that already has a frame is never taken over: the mapping
        // may be incomplete, but re-framing would duplicate the message.
        //
        // created_at is reset on takeover so a claim that keeps being abandoned cannot
        // be stolen in a tight loop by successive redeliveries.
        let row = await db().one(
          `INSERT INTO discord_message_frame (message_id, session_id, frame_id, original_text)
           VALUES ($1,'',NULL,'')
           ON CONFLICT (message_id) DO UPDATE
             SET session_id = EXCLUDED.session_id,
                 created_at = now()
             WHERE discord_message_frame.frame_id IS NULL
               AND discord_message_frame.created_at
                 < now() - ($2::int * interval '1 second')
           RETURNING message_id`,
          [messageID, CLAIM_GRACE_SECONDS],
        );
        if (row) return true;


        // No row came back: the message id already existed and was not reclaimable
        // (either a live claim, or a frame already exists). A driver or test double
        // that reports "no rows" without distinguishing "conflicted" from "inserted,
        // nothing returned" would be read as a race we lost, and we would drop every
        // inbound message. Dropping a message we could have framed is far worse than
        // framing one twice, so confirm before deciding: only a row we can actually
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

      // Explicit off-switch, checked AFTER the token, deliberately. A token is not
      // enough to justify a socket: this instance may be the REST-only twin of a
      // live gateway on another server (3003's test rig beside 3098's real gateway),
      // and a second IDENTIFY on the same bot token evicts the first session -
      // Discord's "session invalidated" storm. Ordering it after the token check
      // makes the disabled log line PROOF that a token was present (a token-less
      // instance still says "no bot token configured" instead). Absent or truthy =
      // enabled, so every existing deployment keeps its behaviour byte-for-byte;
      // only an explicit false/0/"false" silences THIS gateway.
      let enabledRaw = await readConfig(GATEWAY_ENABLED_PATH, null);
      let enabled = !(enabledRaw === false || enabledRaw === 0 || String(enabledRaw).toLowerCase() === 'false');
      observed.gatewayEnabled = enabled;
      if (!enabled) {
        console.warn('[discord] gateway not started: gateway disabled by config (REST-only mode; /kikx/discord/gateway/enabled is off)');
        return;
      }

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
      // --- health ----------------------------------------------------------------
      // Anonymous, deliberately. The deploy gate (kikx-docker/deploy.sh) and any
      // uptime monitor must read this without a Kikx session, and unlike /status it
      // exposes no dispatch history, no outcomes, no authorizations - only the
      // failure surface of the transport, nothing about who spoke in it. The token
      // never appears in the body. A token-less or disabled gateway answers with
      // ok:true but its state NAMED: /health says "the route is served", the state
      // says whether the transport can deliver, and deploy.sh asserts the state
      // separately so a healthy Kikx with a dead Discord fails the deploy instead
      // of reporting full success (3098 ran 5h token-less with one buried log line).
      if (request.method === 'GET' && subPath === '/health') {
        let snap = gatewaySnapshot();
        let state = 'down';
        if (snap.connected === true) state = 'ready';
        else if (!snap.tokenPresent) state = 'no-token';
        else if (snap.gatewayEnabled === false) state = 'disabled';
        else if (snap.gateway) state = 'connecting';

        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          gatewayState: state,
          tokenPresent: snap.tokenPresent,
          gatewayEnabled: snap.gatewayEnabled,
          connected: snap.connected,
          botUserId: snap.gateway?.userId ?? null,
          inboundChannelID: snap.inboundChannelID,
          inboundSessionID: snap.inboundSessionID,
          startedAt: snap.startedAt,
          lastDispatchAt: snap.lastDispatchAt,
          lastError: snap.gateway?.fatal ?? null,
          at: new Date().toISOString(),
        }));
        return;
      }

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

      // --- client renderer ------------------------------------------------------
      // A browser imports this module with no Kikx session attached, so the route
      // cannot be identity-gated: a 401 here would leave DiscordSendToolFrame
      // with no renderer and the card would fall back to a generic tool frame.
      // It serves one static file this plugin already ships, and nothing else.
      // Both renderer modules, from one table: the outbound send card and the
      // inbound message card. A new card added to CLIENT_MODULES is served here
      // with no further edit, which is what keeps "register a renderer" and
      // "the browser can fetch it" from drifting apart.
      let clientModule = CLIENT_MODULES.get(subPath);
      if (request.method === 'GET' && clientModule) {
        let body;
        try { body = await readFile(clientModule); }
        catch (error) {
          response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { message: 'discord client module not found' } }));
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        response.end(body);
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

        // channelID is required for the overflow path: an interaction has one
        // @original message, so a long reply needs a real channel for the rest.
        let updated = await updateInteractionOriginal({
          applicationID,
          interactionToken,
          channelID: payload.channel_id || null,
          content: reply,
        });
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
