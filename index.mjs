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

export const pluginName = 'discord';

export function setup(provide) {
  return provide(({ registry, mountHttp, authorize, db, registerMigrations, appendToSession, readConfig }) => {
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

      await appendToSession(binding.session_id, {
        text: `[discord:${authorName}] ${content}`,
        source: 'discord',
        channelID: channelId,
      });

      response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, sessionID: binding.session_id }));
    });
  });
}
