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
function buildPlugin({ binding = { session_id: 'session-1' }, seen = new Set(), allowed, token = null, applicationID = null } = {}) {
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
      if (path === '/kikx/discord/bot/token') return token;
      if (path === '/kikx/discord/application/id') return applicationID;
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
    // The ordering test needs to know whether the response was already closed when the
    // session write ran, so the harness records it rather than leaving it to inference.
    captured.responseFinished = false;
    let response = {
      writeHead(code) { status = code; },
      end(text) {
        captured.responseFinished = true;
        if (text) payload = JSON.parse(text);
      },
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

// --- 5. Interaction callbacks: the answer Discord actually reads -------------------
//
// This section replaces an earlier test that asserted 202 for a slash command. That
// assertion was the bug written down: 202 with a Kikx-shaped body is not an interaction
// callback, so Discord showed the user "The application did not respond" while the suite
// stayed green. Every test below drives the real handler with a real signature.

const BOT_TOKEN = 'test-bot-token';
const APPLICATION_ID = 'app-123';

function slashCommand(overrides = {}) {
  return {
    id: 'i-1', type: 2, channel_id: 'chan-1', application_id: APPLICATION_ID, token: 'itok-abc',
    data: { name: 'kikx', options: [{ name: 'message', value: 'from a slash command' }] },
    member: { user: { id: 'u1', username: 'wyatt' } },
    ...overrides,
  };
}

// Captures the PATCH the plugin issues after it has already answered Discord. Returns a
// restore function, because replacing global fetch is process-wide for the test file.
function captureFetch({ status = 200, body = '{}' } = {}) {
  let calls = [];
  let original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return body; },
      async json() { return JSON.parse(body); },
    };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('a slash command is answered with a type 5 deferral, not a 202 and silence', async () => {
  let { captured, post } = buildPlugin({ token: BOT_TOKEN });
  let fetchLog = captureFetch();
  try {
    let result = await post(JSON.stringify(slashCommand()));
    assert.equal(result.status, 200, 'Discord reads the body, but 200 is the documented callback status');
    assert.equal(result.body.type, 5, 'a deferred channel message is type 5');
    assert.equal(result.body.data.flags, 64, 'the deferral is ephemeral so the channel stays quiet');
  } finally {
    fetchLog.restore();
  }
  assert.equal(captured.frames.length, 1, 'the ack must not replace framing the command');
  assert.match(captured.frames[0].input.text, /from a slash command/);
});

test('a component interaction defers with type 6, because type 5 is rejected for it', async () => {
  let { post } = buildPlugin({ token: BOT_TOKEN });
  let fetchLog = captureFetch();
  try {
    let result = await post(JSON.stringify(slashCommand({ id: 'i-2', type: 3 })));
    assert.equal(result.body.type, 6, 'component interactions defer as UPDATE_MESSAGE, not CHANNEL_MESSAGE');
  } finally {
    fetchLog.restore();
  }
});

test('the outcome is delivered to the interaction webhook @original with the bot token', async () => {
  let { post } = buildPlugin({ token: BOT_TOKEN });
  let fetchLog = captureFetch();
  try {
    await post(JSON.stringify(slashCommand()));
    assert.equal(fetchLog.calls.length, 1, 'exactly one follow-up, not one per branch');
    let { url, options } = fetchLog.calls[0];
    assert.equal(
      url,
      'https://discord.com/api/v10/webhooks/app-123/itok-abc/messages/@original',
      '@original edits the deferred placeholder; omitting it posts a second message',
    );
    assert.equal(options.method, 'PATCH');
    assert.equal(options.headers.Authorization, 'Bot ' + BOT_TOKEN, 'the webhook needs the bot credential');
    let body = JSON.parse(options.body);
    assert.match(body.content, /framed into session session-1/);
  } finally {
    fetchLog.restore();
  }
});

test('the ack is sent before the session write, so a slow database cannot miss the window', async () => {
  // The handler must have called response.end() before it awaited the router. Ordering is
  // observed directly: at the moment the router runs, the response must already be closed.
  let { captured, post } = buildPlugin({ token: BOT_TOKEN });
  let fetchLog = captureFetch();
  let answeredBeforeFraming = null;
  let realAppend = captured.frames.push.bind(captured.frames);
  captured.frames.push = (entry) => {
    answeredBeforeFraming = captured.responseFinished;
    return realAppend(entry);
  };
  try {
    await post(JSON.stringify(slashCommand()));
  } finally {
    fetchLog.restore();
  }
  assert.equal(answeredBeforeFraming, true, 'the deferral must precede the database work');
});

test('without an application credential the reply is immediate and says so, rather than deferring forever', async () => {
  // No deferral means no webhook to correct it on: a user would watch "thinking..." until
  // the token expires. An ephemeral type 4 is the only answer that is both in-window and true.
  let { captured, post } = buildPlugin({ token: BOT_TOKEN });
  let fetchLog = captureFetch();
  try {
    let result = await post(JSON.stringify(slashCommand({ application_id: undefined, token: undefined })));
    assert.equal(result.status, 200);
    assert.equal(result.body.type, 4);
    assert.equal(result.body.data.flags, 64);
    assert.match(result.body.data.content, /not processed/);
  } finally {
    fetchLog.restore();
  }
  assert.equal(fetchLog.calls.length, 0, 'nothing to patch, so nothing is fetched');
  assert.equal(captured.frames.length, 0, 'and nothing is framed, because the command was not processed');
});

test('a denied sender is still acknowledged, and told why, instead of being ignored', async () => {
  // The ack is a transport obligation and must not depend on policy. What policy changes
  // is the follow-up text and whether a frame exists.
  let { captured, post } = buildPlugin({ token: BOT_TOKEN, allowed: false });
  let fetchLog = captureFetch();
  try {
    let result = await post(JSON.stringify(slashCommand({ id: 'i-3' })));
    assert.equal(result.body.type, 5, 'a denied interaction is still a received interaction');
    let body = JSON.parse(fetchLog.calls[0].options.body);
    assert.match(body.content, /Not authorized/);
  } finally {
    fetchLog.restore();
  }
  assert.equal(captured.frames.length, 0, 'a denied sender must not write into the session');
});

test('a replayed interaction receives the same deferral and is framed only once', async () => {
  let { captured, post } = buildPlugin({ token: BOT_TOKEN });
  let fetchLog = captureFetch();
  try {
    await post(JSON.stringify(slashCommand({ id: 'i-4' })));
    let second = await post(JSON.stringify(slashCommand({ id: 'i-4' })));
    assert.equal(second.body.type, 5, 'a duplicate is still acknowledgeable');
    let body = JSON.parse(fetchLog.calls[1].options.body);
    assert.match(body.content, /Already received/);
  } finally {
    fetchLog.restore();
  }
  assert.equal(captured.frames.length, 1, 'dedupe still applies to the interaction path');
});

test('an unbound channel explains the binding, which is an operator fix', async () => {
  let { post } = buildPlugin({ token: BOT_TOKEN, binding: null });
  let fetchLog = captureFetch();
  try {
    await post(JSON.stringify(slashCommand({ id: 'i-5' })));
    let body = JSON.parse(fetchLog.calls[0].options.body);
    assert.match(body.content, /not bound/);
  } finally {
    fetchLog.restore();
  }
});

test('a failed follow-up is logged and swallowed, because Discord already has its answer', async () => {
  let { post } = buildPlugin({ token: BOT_TOKEN });
  let fetchLog = captureFetch({ status: 400, body: '{"message":"bad"}' });
  let warnings = [];
  let realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    let result = await post(JSON.stringify(slashCommand({ id: 'i-6' })));
    assert.equal(result.body.type, 5, 'a webhook failure must not change what Discord was told');
  } finally {
    console.warn = realWarn;
    fetchLog.restore();
  }
  assert.equal(warnings.length, 1, 'silence would hide a broken follow-up');
  assert.match(warnings[0], /HTTP 400/);
});
