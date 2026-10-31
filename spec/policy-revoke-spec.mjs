'use strict';

// =============================================================================
// discord:policy_revoke — the mirror of policy_grant
// =============================================================================
// The grant tool made the strict inbound gate satisfiable. Without a revoke tool the
// only way to take a grant away is hand-written SQL, which is a workaround rather than
// a security posture. These tests pin the properties that make the tool safe to expose:
// it cannot reach outside its own namespace, it removes exactly the scope it names, and
// it reports what actually happened instead of what was asked for.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../index.mjs';

// Minimal in-memory stand-in for the capability table plus the authorize() the tool
// reads back through. Deliberately not a fake that always agrees: `allowed` is computed
// from the rows that survive, so a tool that claims success without deleting fails here.
function buildHarness({ grants = [] } = {}) {
  let rows = grants.map((g) => ({ ...g, scope_json: g.scope_json ?? null }));
  let captured = { tools: [], deletes: [] };

  let matches = (row, actor, action, scope) => {
    if (row.actor !== actor || row.action !== action) return false;
    let required = row.scope_json || null;
    if (!required) return true;
    return Object.entries(required).every(([k, v]) => String(scope[k]) === String(v));
  };

  let db = {
    query: async (sql, params) => {
      captured.deletes.push({ sql, params });
      let [actor, action, scopeJson] = params;
      let before = rows.length;
      if (/scope_json IS NOT DISTINCT FROM/.test(sql)) {
        let scope = scopeJson === null ? null : JSON.parse(scopeJson);
        rows = rows.filter((r) => !(r.actor === actor && r.action === action
          && JSON.stringify(r.scope_json ?? null) === JSON.stringify(scope)));
      } else {
        rows = rows.filter((r) => !(r.actor === actor && r.action === action));
      }
      return { rowCount: before - rows.length };
    },
    one: async () => null,
    many: async () => rows,
  };

  setup((fn) => fn({
    registry: {
      getClass: () => class { },
      registerTool: (name, cls) => captured.tools.push({ name, cls }),
      registerClass: () => {},
    },
    mountHttp: () => { },
    registerMigrations: () => { },
    readConfig: async () => null,
    appendFrame: async () => ({}),
    appendToSessionQuietly: async () => ({}),
    db: () => db,
    authorize: async ({ actor, action, scope = {} }) => {
      let found = rows.filter((r) => matches(r, actor, action, scope));
      return found.length ? { allowed: true, grant: found[0] } : { allowed: false, reason: 'no grant' };
    },
  }));

  let entry = captured.tools.find((t) => t.name === 'discord:policy_revoke');
  return { tool: entry && new entry.cls(), rows: () => rows, captured };
}

const ACTOR = 'discord:42';
const CHANNEL = 'chan-1';

test('the revoke tool is registered alongside the grant tool', () => {
  let { tool } = buildHarness();
  assert.ok(tool, 'discord:policy_revoke must be registered');
  assert.equal(tool.constructor.riskLevel, 'high', 'granting and revoking authority both need a human');
});

test('a scoped revoke removes the grant and the gate stops allowing', async () => {
  let { tool, rows } = buildHarness({
    grants: [{ actor: ACTOR, action: 'discord.inbound', scope_json: { channel: CHANNEL } }],
  });

  let result = await tool._execute({ actor: ACTOR, action: 'discord.inbound', channel: CHANNEL });

  assert.equal(result.revoked, true);
  assert.equal(result.deleted, 1);
  assert.equal(result.verified, true, 'nothing should remain authorizing this action');
  assert.equal(result.stillAllowed, false);
  assert.deepEqual(rows(), []);
});

test('a scoped revoke leaves an unscoped grant alone and says so', async () => {
  // The dangerous case: the caller revokes one channel, and a broader grant quietly
  // keeps the door open. Reporting `revoked: true` here without qualification would be
  // the silent-success shape this codebase keeps producing.
  let { tool, rows } = buildHarness({
    grants: [{ actor: ACTOR, action: 'discord.inbound', scope_json: null }],
  });

  let result = await tool._execute({ actor: ACTOR, action: 'discord.inbound', channel: CHANNEL });

  assert.equal(result.revoked, false, 'nothing matched the named scope');
  assert.equal(result.stillAllowed, true, 'the unscoped grant still authorizes this action');
  assert.match(result.note, /No matching grant existed/);
  assert.equal(rows().length, 1, 'the unscoped grant must survive');
});

test('allScopes removes the broader grant too, and then reports it verified', async () => {
  let { tool, rows } = buildHarness({
    grants: [{ actor: ACTOR, action: 'discord.inbound', scope_json: null }],
  });

  let result = await tool._execute({
    actor: ACTOR, action: 'discord.inbound', channel: CHANNEL, allScopes: true,
  });

  assert.equal(result.revoked, true);
  assert.equal(result.stillAllowed, false);
  assert.equal(result.verified, true);
  assert.deepEqual(rows(), []);
});

test('a revoke that matches nothing is reported as a no-op, not as success', async () => {
  let { tool } = buildHarness({ grants: [] });

  let result = await tool._execute({ actor: ACTOR, action: 'discord.inbound', channel: CHANNEL });

  assert.equal(result.revoked, false);
  assert.equal(result.deleted, 0);
  assert.match(result.note, /nothing was revoked/);
});

test('it refuses actors outside the Discord namespace', async () => {
  let { tool, rows, captured } = buildHarness({
    grants: [{ actor: 'someone-else', action: 'discord.inbound', scope_json: null }],
  });

  for (let actor of ['someone-else', 'discord:', 'discord:abc', '']) {
    let result = await tool._execute({ actor, action: 'discord.inbound', channel: CHANNEL });
    assert.equal(result.revoked, false, `actor ${JSON.stringify(actor)} must be refused`);
    assert.match(result.reason, /discord:<numeric user id>/);
  }

  assert.equal(captured.deletes.length, 0, 'a refused call must never reach the database');
  assert.equal(rows().length, 1);
});

test('it refuses actions this plugin does not manage', async () => {
  for (let action of ['miri.notes_write', 'discord.something_else', '']) {
    let { tool, captured } = buildHarness({
      grants: [{ actor: ACTOR, action, scope_json: null }],
    });
    let result = await tool._execute({ actor: ACTOR, action, channel: CHANNEL });
    assert.equal(result.revoked, false, `action ${JSON.stringify(action)} must be refused`);
    assert.match(result.reason, /not managed by this plugin/);
    assert.equal(captured.deletes.length, 0);
  }
});

test('an unscoped revoke without allScopes targets the null scope exactly', async () => {
  // Guard against a revoke that degenerates into "delete everything for this actor"
  // when no channel is supplied.
  let { tool, rows, captured } = buildHarness({
    grants: [
      { actor: ACTOR, action: 'discord.inbound', scope_json: { channel: CHANNEL } },
      { actor: ACTOR, action: 'discord.inbound', scope_json: null },
    ],
  });

  let result = await tool._execute({ actor: ACTOR, action: 'discord.inbound' });

  assert.equal(result.revoked, true);
  assert.equal(captured.deletes.length, 1);
  assert.match(captured.deletes[0].sql, /IS NOT DISTINCT FROM/, 'must be scope-exact, not a wildcard delete');
  assert.equal(rows().length, 1, 'the channel-scoped grant must survive');
  assert.deepEqual(rows()[0].scope_json, { channel: CHANNEL });
});
