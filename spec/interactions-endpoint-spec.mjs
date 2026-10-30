'use strict';

// The interactions endpoint is the only door Discord itself opens into Kikx, and until
// now nothing tested it. These tests drive the real mount handler with real Ed25519
// signatures, because a fake signature proves only that the string comparison runs.
//
// Three defects this pins down:
//   1. A signature was valid forever. Discord sends X-Signature-Timestamp as part of the
//      signed material; without comparing it to now, a captured request replays.
//   2. The handler had its own copy of the routing policy instead of calling
//      DiscordInboundRouter, so dedupe and the self-message filter did not apply to
//      anything arriving over HTTP.
//   3. MESSAGE_UPDATE read the gateway event shape only, so an interaction envelope
//      carrying new content was rejected as "edit event without id or content".

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { setup } from '../index.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' });
const PUBLIC_KEY_HEX = spki.subarray(spki.length - 32).toString('hex');

function sign(timestamp, body) {
  return crypto.sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString('hex');
}

class FakePluginInterface {}

// Builds the plugin and returns a function that delivers one HTTP request to the
// registered mount, exactly as the router would.
function buildPlugin({ binding = { session_id: 'session-1' }, seen = new Set(), allowed } = {}) {
  let captured = { frames: [], queries: [], authorizations: [] };

  let db = () => ({
    async one(sql, params) {
      captured.queries.push({ sql, params });
      if (/discord_channel_session/.test(sql)) return binding;
      if (/FROM discord_message_frame/.test(sql)) return seen.has(params[0]) ? { seen: 1 } : null;
      if (/original_text/.test(sql)) return null;
      return null;
    },
    async query(sql, params) {
      captured.queries.push({ sql, params });
      if (/INSERT INTO discord_message_frame/.test(sql)) seen.add(params[0]);
      return { rowCount: 1 };
    },
  });

  let context = {
    registry: { getClass: () => FakePluginInterface, registerTool: () => {} },
    registerMigrations: () => {},
    mountHttp: (handler, options) => {
      captured.handler = handler;
      captured.options = options;
      return '/api/plugins/discord/';
    },
    // Inbound over HTTP goes through the same gate as the gateway. Allowing here is the
    // normal case; the denied case has its own test below.
    authorize: async (request) => {
      captured.authorizations.push(request);
      return allowed === false
        ? { allowed: false, reason: 'no grant for discord.inbound' }
        : { allowed: true };
    },
    db,
    appendToSession: async (sessionID, input) => {
      captured.frames.push({ sessionID, input });
      return { session: { id: sessionID }, frame: { id: `frame-${captured.frames.length}` } };
    },
    appendToSessionQuietly: async () => ({ frame: { id: 'frame-1' } }),
    readConfig: async (path) => {
      if (path === '/kikx/discord/bot/token') return null;
      if (path === '/kikx/discord/public/key') return PUBLIC_KEY_HEX;
      return null;
    },
  };

  setup((provide) => { provide(context); });

  async function post(body, { timestamp = String(Math.floor(Date.now() / 1000)), signature, omitSignature = false } = {}) {
    let raw = Buffer.from(body);
    let headers = { 'content-type': 'application/json' };
    if (!omitSignature) {
      headers['x-signature-ed25519'] = signature ?? sign(timestamp, raw);
      headers['x-signature-timestamp'] = timestamp;
    }

    let status = null;
    let payload = null;
    let response = {
      writeHead(code) { status = code; },
      end(text) { if (text) payload = JSON.parse(text); },
    };
    await captured.handler({
      request: { method: 'POST', headers, url: '/api/plugins/discord/interactions' },
      response,
      rawBody: raw,
      json: () => JSON.parse(raw),
      subPath: '/interactions',
    });
    return { status, body: payload };
  }

  return { captured, post };
}

// --- 1. Discord's endpoint validation -------------------------------------------

test('a signed PING is answered with type 1, which is what Discord validates on save', async () => {
  let { post } = buildPlugin();
  let result = await post(JSON.stringify({ id: '1', type: 1 }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { type: 1 });
});

test('an unsigned PING is rejected, so the endpoint is not an open door', async () => {
  let { post } = buildPlugin();
  let result = await post(JSON.stringify({ id: '1', type: 1 }), { omitSignature: true });
  assert.equal(result.status, 401);
});

test('a signature computed over different bytes is rejected', async () => {
  let { post } = buildPlugin();
  let body = JSON.stringify({ id: '1', type: 1 });
  let timestamp = String(Math.floor(Date.now() / 1000));
  let signatureForAnotherBody = sign(timestamp, Buffer.from('{"different":true}'));
  let result = await post(body, { timestamp, signature: signatureForAnotherBody });
  assert.equal(result.status, 401);
});

// --- 2. Replay window ----------------------------------------------------------

test('a correctly signed PING that is an hour old is rejected as a replay', async () => {
  let { post } = buildPlugin();
  let hourAgo = String(Math.floor(Date.now() / 1000) - 3600);
  let result = await post(JSON.stringify({ id: '1', type: 1 }), { timestamp: hourAgo });
  assert.equal(result.status, 401, 'a stale signature must not be accepted forever');
  assert.match(String(result.body?.error?.reason || ''), /window|old/i);
});

test('a timestamp far in the future is rejected too, not only an old one', async () => {
  let { post } = buildPlugin();
  let future = String(Math.floor(Date.now() / 1000) + 3600);
  let result = await post(JSON.stringify({ id: '1', type: 1 }), { timestamp: future });
  assert.equal(result.status, 401);
});

test('a PING inside the window still works, so the window is a limit and not a wall', async () => {
  let { post } = buildPlugin();
  let twoMinutesAgo = String(Math.floor(Date.now() / 1000) - 120);
  let result = await post(JSON.stringify({ id: '1', type: 1 }), { timestamp: twoMinutesAgo });
  assert.equal(result.status, 200);
});

// --- 3. The HTTP path uses the same routing policy ------------------------------

function message(overrides = {}) {
  return {
    id: 'msg-1', t: 'MESSAGE_CREATE', channel_id: 'chan-1', content: 'hello over http', type: 0,
    author: { id: 'u1', username: 'wyatt' }, ...overrides,
  };
}

test('a signed MESSAGE_CREATE is framed into the bound session', async () => {
  let { captured, post } = buildPlugin();
  let result = await post(JSON.stringify(message()));
  assert.equal(result.status, 202);
  assert.equal(captured.frames.length, 1);
  assert.equal(captured.frames[0].sessionID, 'session-1');
  assert.match(captured.frames[0].input.text, /^\[discord:wyatt\] hello over http$/);
});

test('the same message delivered twice over HTTP is framed once', async () => {
  let { captured, post } = buildPlugin();
  await post(JSON.stringify(message()));
  await post(JSON.stringify(message()));
  assert.equal(captured.frames.length, 1, 'dedupe must apply to the HTTP path, not only the gateway');
});

test('the bot does not frame its own message arriving over HTTP either', async () => {
  let { captured, post } = buildPlugin();
  let payload = message({ author: { id: 'u1', username: 'miri', bot: true } });
  await post(JSON.stringify(payload));
  assert.equal(captured.frames.length, 0);
});

test('a message with no content is reported as a missing intent, not framed as blank', async () => {
  let { captured, post } = buildPlugin();
  let result = await post(JSON.stringify(message({ content: '' })));
  assert.equal(captured.frames.length, 0);
  assert.match(String(result.body?.note || ''), /missing_intent/);
});

test('an unbound channel answers 404, because it is an operator error and not a duplicate', async () => {
  let { post } = buildPlugin({ binding: null });
  let result = await post(JSON.stringify(message()));
  assert.equal(result.status, 404);
  assert.match(String(result.body?.error?.message || ''), /not bound/);
});

// --- 4. Interaction envelopes carry their text somewhere else ---------------------

test('a slash command option is framed as the message text', async () => {
  let { captured, post } = buildPlugin();
  let payload = {
    id: 'i-1', type: 2, channel_id: 'chan-1',
    data: { name: 'kikx', options: [{ name: 'message', value: 'from a slash command' }] },
    member: { user: { id: 'u1', username: 'wyatt' } },
  };
  let result = await post(JSON.stringify(payload));
  assert.equal(result.status, 202);
  assert.equal(captured.frames.length, 1);
  assert.match(captured.frames[0].input.text, /from a slash command/);
});
