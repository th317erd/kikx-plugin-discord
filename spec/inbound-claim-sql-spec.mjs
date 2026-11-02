'use strict';

// The claim/rescue SQL the plugin actually ships, asserted through setup().
//
// WHY THIS FILE EXISTS
//
// inbound-poisoned-claim-spec.mjs proves the ROUTER recovers a message when the store
// lets it. It cannot prove the store does: it supplies its own in-memory double, so it
// keeps passing if index.mjs is reverted to the broken DO NOTHING. That was checked, not
// assumed - with claimMessage reverted, all three of those tests still passed. A test
// that passes both ways is not evidence.
//
// So this file builds the real plugin, delivers a real gateway MESSAGE_CREATE, and
// asserts the statement actually issued to the database. It fails on revert.
//
// What the statement must do:
//   * take over a claim ONLY when the row has no frame (frame_id IS NULL) - a row with a
//     frame must never be re-claimed, or one Discord message becomes two frames;
//   * and only when the row is older than the grace window - a concurrent handler's
//     claim-to-write window ALSO has frame_id NULL, so age is the only thing that
//     distinguishes "abandoned" from "in flight". Without it this reopens the exact
//     duplicate-frame race the claim was introduced to close.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../index.mjs';

class FakePluginInterface {}

class FakeSocket {
  static instances = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  async deliver(payload) {
    for (let fn of this.listeners.get('message') || []) fn({ data: JSON.stringify(payload) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function buildPlugin() {
  let captured = { queries: [], tools: [], classes: [], migrations: [], mounts: [], frames: [] };

  let db = () => ({
    async one(sql, params) {
      captured.queries.push({ sql, params });
      // The channel must resolve to a session, or the router stops at unbound_channel
      // and never reaches the claim.
      if (/discord_channel_session/.test(sql)) return { session_id: 'session-1' };
      return null;
    },
    async query(sql, params) {
      captured.queries.push({ sql, params });
      return { rowCount: 1 };
    },
  });

  let context = {
    registry: {
      getClass: () => FakePluginInterface,
      registerTool: (name) => captured.tools.push(name),
      registerClass: (key, ClassRef) => captured.classes.push({ key, ClassRef }),
    },
    registerMigrations: (options) => captured.migrations.push(options),
    mountHttp: (handler, options) => {
      captured.mounts.push({ handler, options });
      return '/api/plugins/discord/';
    },
    authorize: async () => ({ allowed: true }),
    db,
    appendFrame: async (sessionID) => {
      captured.frames.push(sessionID);
      return { session: { id: sessionID }, frame: { id: 'frame-1' } };
    },
    appendToSessionQuietly: async () => ({ frame: { id: 'frame-1' } }),
    readConfig: async (path) => (path === '/kikx/discord/bot/token' ? 'bot-token' : null),
  };

  let provide = (factory) => factory({
    context,
    registry: context.registry,
    mountHttp: context.mountHttp,
    authorize: context.authorize,
    db,
    registerMigrations: context.registerMigrations,
    appendToSession: async () => ({ frame: { id: 'frame-1' } }),
    appendFrame: context.appendFrame,
    appendToSessionQuietly: context.appendToSessionQuietly,
    readConfig: context.readConfig,
  });

  return { plugin: setup(provide), captured };
}

// Drive one real inbound message so the claim path actually executes, then return the
// claim statement it issued.
async function claimStatementForOneMessage() {
  FakeSocket.instances.length = 0;
  let saved = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    let { plugin, captured } = buildPlugin();
    await plugin.onInit?.();

    let socket = FakeSocket.instances[0];
    assert.ok(socket, 'onInit must dial the gateway');

    await socket.deliver({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 1,
      d: {
        id: 'msg-1',
        channel_id: 'chan-1',
        guild_id: 'guild-1',
        content: 'are you there',
        author: { id: 'user-1', username: 'th317erd', bot: false },
      },
    });

    assert.equal(captured.frames.length, 1, 'the message should have been framed once');

    let hits = captured.queries.filter((q) =>
      /INSERT INTO discord_message_frame/.test(q.sql) && /VALUES \(\$1,'',NULL,''\)/.test(q.sql));
    assert.equal(hits.length, 1,
      "expected exactly one claim INSERT ... VALUES ($1,'',NULL,'') while handling one message");

    return { sql: hits[0].sql.replace(/\s+/g, ' ').trim(), params: hits[0].params };
  } finally {
    globalThis.WebSocket = saved;
  }
}

test('the shipped claim takes over an abandoned claim, not only a brand-new message id', async () => {
  let { sql } = await claimStatementForOneMessage();

  assert.match(sql, /ON CONFLICT \(message_id\) DO UPDATE/,
    'a claim that only inserts can never rescue a message stranded by a dead handler');
  assert.doesNotMatch(sql, /ON CONFLICT \(message_id\) DO NOTHING/,
    'DO NOTHING is the defect: it poisons the message id permanently');
  assert.match(sql, /RETURNING message_id/,
    'the claim must report whether it won, or every caller believes it failed');
});

test('the takeover is bounded so a live claim is never stolen', async () => {
  let { sql, params } = await claimStatementForOneMessage();

  // A row with a frame belongs to a delivered message. Re-claiming it would produce a
  // second frame for one Discord message.
  assert.match(sql, /discord_message_frame\.frame_id IS NULL/,
    'a row that already has a frame must never be re-claimed');

  // The age bound is what separates "abandoned" from "another handler is mid-flight".
  assert.match(sql, /discord_message_frame\.created_at < now\(\) - \(\$2::int \* interval '1 second'\)/,
    "without an age bound, a concurrent handler's live claim would be stolen and the message framed twice");

  assert.equal(params[1], 120, 'the grace window is passed as the second parameter');
});

test('claiming also refreshes created_at, so a claim cannot be stolen in a tight loop', async () => {
  let { sql } = await claimStatementForOneMessage();

  assert.match(sql, /SET session_id = EXCLUDED\.session_id/,
    'the takeover must adopt the new session binding');
  assert.match(sql, /created_at = now\(\)/,
    'without refreshing created_at, successive redeliveries could steal the claim forever');
});
