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
  return provide(({ registry, mountHttp, authorize, db, registerMigrations, appendToSession, appendToSessionQuietly, readConfig }) => {
    registerMigrations({ directory: 'sql' });
    let PluginInterface = registry.getClass('PluginInterface');
    if (!PluginInterface)
      throw new Error('kikx-plugin-discord requires PluginInterface in plugin context');

    // Ed25519 verification of X-Signature-Ed25519 over timestamp+body.
    function verifySignature({ publicKey, signature, timestamp, rawBody }) {
      if (!publicKey) return { ok: false, reason: 'no public key configured' };
      if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };
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

        let token = await readConfig('/kikx/discord/bot/token', null);
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

    async function gatewayLoop() {
      let token = await readConfig('/kikx/discord/bot/token', null);
      if (!token) {
        // No token: say so once and stop. Reconnect-spinning on a missing credential is
        // how a plugin becomes a log flood.
        console.warn('[discord] gateway not started: no bot token configured');
        return;
      }

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
        recordFrame: ({ messageID, sessionID, frameID, text }) => db().query(
          'INSERT INTO discord_message_frame (message_id, session_id, frame_id, original_text) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id) DO NOTHING',
          [messageID, sessionID, frameID, text],
        ),
        // Dedupe against the mapping table the transport already owns: a RESUME replay
        // redelivers events, and framing one twice would duplicate the message.
        seenMessage: async (messageID) => Boolean(await db().one(
          'SELECT 1 AS seen FROM discord_message_frame WHERE message_id = $1',
          [messageID],
        )),
        appendToSession: (sessionID, input) => appendToSession(sessionID, input),
        log: (level, message) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[discord] ${message}`),
        botUserID: () => gateway?.status?.().userId || gateway?.userId || null,
      });

      gateway = new DiscordGateway({
        token,
        intents: DEFAULT_INTENTS,
        onDispatch: async (eventType, data) => {
          let result = await inbound.handle(eventType, data);
          // Everything the router declines to frame is worth one line, except the
          // high-frequency cases: silence there would hide a missing intent.
          if (!result.handled && result.reason !== 'not_a_message' && result.reason !== 'own_message')
            console.warn(`[discord] not framed: ${result.reason}${result.channelID ? ` (channel ${result.channelID})` : ''}`);
        },
        log: (level, message) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[discord] ${message}`),
      });

      await gateway.start();
    }

    mountHttp(async ({ request, response, rawBody, json, subPath }) => {
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

      // --- message edits -------------------------------------------------------
      // An edit UPDATES the original frame: same id, original text untouched, an audit
      // tail added to its content. It never creates a second frame and never rewrites the
      // text the bot first saw. Edits do not wake the session - a quiet append, because
      // the bot reads the change in its context when it next runs.
      if (payload?.t === 'MESSAGE_UPDATE') {
        let messageID = payload?.id || payload?.message?.id || null;
        let newContent = payload?.content ?? payload?.message?.content ?? null;
        let editedAt = payload?.edited_timestamp || new Date().toISOString();

        if (!messageID || newContent === null) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { message: 'edit event without id or content' } }));
          return;
        }

        let row = await db().one(
          'SELECT session_id, frame_id, original_text, edits, audit FROM discord_message_frame WHERE message_id = $1',
          [messageID],
        );
        let existingAudit = Array.isArray(row?.audit) ? row.audit : [];
        if (!row || !row.frame_id) {
          // An edit for a message we never stored: nothing to update, and guessing would
          // be worse than ignoring it.
          response.writeHead(204);
          response.end();
          return;
        }

        // original_text is the prefixed text as framed, so the update keeps the speaker
        // attribution instead of replacing it with the raw Discord content.
        let before = String(row.original_text).split('\n');
        let after = String(newContent).split('\n');
        let diff = [];
        for (let i = 0; i < Math.max(before.length, after.length); i++) {
          if ((before[i] ?? '') === (after[i] ?? '')) continue;
          if (before[i] !== undefined) diff.push(`- ${before[i]}`);
          if (after[i] !== undefined) diff.push(`+ ${after[i]}`);
        }

        let entry = {
          editedAt,
          diff: diff.join('\n') || '(no textual change)',
        };

        // Accumulate: the tail grows with every edit. There is no frame reader on the
        // plugin context, so the transport keeps its own record in the mapping table -
        // it owns that row and reading it back is unambiguous.

        await appendToSessionQuietly(row.session_id, {
          id: row.frame_id,
          text: row.original_text,
          source: 'discord',
          // The audit tail must ride inside content: buildUserMessageContent only keeps
          // extra fields from input.content, so a top-level audit was silently dropped.
          content: { audit: [...existingAudit, entry] },
        });

        await db().query(
          'UPDATE discord_message_frame SET edits = edits + 1, audit = $2::jsonb WHERE message_id = $1',
          [messageID, JSON.stringify([...existingAudit, entry])],
        );

        response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, updated: row.frame_id, edit: row.edits + 1 }));
        return;
      }

      // Real time, no debounce: the message goes straight into the session the channel
      // is bound to. Kikx is a chat, so there is nothing to debounce - Discord's event
      // is already the message.
      let channelId = payload?.channel_id || payload?.channel?.id || null;
      let content = payload?.data?.options?.find?.((o) => o.name === 'message')?.value
        || payload?.data?.content || payload?.content || null;
      let authorName = payload?.member?.user?.username || payload?.author?.username || 'discord';

      if (!channelId) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: 'no channel_id in payload' } }));
        return;
      }

      let binding = await db().one(
        'SELECT session_id FROM discord_channel_session WHERE channel_id = $1',
        [channelId],
      );
      if (!binding) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: { message: `channel ${channelId} is not bound to a session` } }));
        return;
      }

      if (!content) {
        response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, note: 'no message content to append' }));
        return;
      }

      let messageID = payload?.id || payload?.message?.id || null;
      let frame = await appendToSession(binding.session_id, {
        text: `[discord:${authorName}] ${content}`,
        source: 'discord',
        channelID: channelId,
        discordMessageID: messageID,
      });

      // Remember which frame this message became, so an edit can find it later. Written
      // after the frame exists; an edit for a message with no row is ignored rather than
      // guessed at.
      // appendToSession returns { session, frame, commit, wakePending } - the frame id is
      // one level down, and reading it as frame.id silently produced no mapping at all.
      let frameID = frame?.frame?.id || frame?.id || null;
      if (messageID && frameID) {
        await db().query(
          'INSERT INTO discord_message_frame (message_id, session_id, frame_id, original_text) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id) DO NOTHING',
          [messageID, binding.session_id, frameID, `[discord:${authorName}] ${content}`],
        );
      }
      response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, sessionID: binding.session_id }));
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
