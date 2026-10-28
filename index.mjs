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
  return provide(({ registry, mountHttp, authorize }) => {
    let PluginInterface = registry.getClass('PluginInterface');
    if (!PluginInterface)
      throw new Error('kikx-plugin-discord requires PluginInterface in plugin context');

    // Ed25519 verification of X-Signature-Ed25519 over timestamp+body.
    function verifySignature({ publicKey, signature, timestamp, rawBody }) {
      if (!publicKey) return { ok: false, reason: 'no public key configured' };
      if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };
      try {
        let key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'hex'), format: 'der', type: 'spki' });
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

        // No gateway credentials yet: this reports the decision rather than pretending
        // to deliver. Wiring Discord's REST API is the next step, and it must not be
        // faked - a "sent" that did not send is worse than a refusal.
        return {
          sent: false,
          denied: false,
          authorized: true,
          pending: 'transport-not-wired',
          note: 'capability check passed; Discord API delivery is not implemented yet',
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
        publicKey: process.env.KIKX_DISCORD_PUBLIC_KEY || null,
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

      response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
}
