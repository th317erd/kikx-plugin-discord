'use strict';

// The Discord reply must be READABLE in the session thread.
//
// The problem this spec guards, measured on live 3003 (session 54e1c081):
//   - 4 DiscordFrame rows exist, all agentOnly:true, and `isThreadVisibleFrame()`
//     returns false for them by design. The spec's own second question is "is it
//     absent from the session thread", so hiding inbound is a requirement, not a bug.
//   - The agent's reply exists as DiscordSendToolFrame rows in that same thread.
//     They are visible, but rendered by the generic tool card, so the thread reads
//     as an agent talking to itself.
//
// The fix is presentation only: teach the client to render DiscordSendToolFrame as
// a card that names the Discord recipient and quotes what was sent. No filter is
// changed, no frame type is invented, and no core module is touched.
//
// What makes this spec worth having rather than decorative: it asserts the wiring
// that is invisible at runtime until it silently fails.
//   1. registerTool() must actually produce a FRAME component for the send tool.
//      PluginRegistry only does that when a tool declares BOTH `frameType` and
//      `clientComponent`; declare one and the descriptor is never created, with no
//      error anywhere. The card would then never render and nothing would say so.
//   2. The descriptor's moduleURL must sit inside the plugin's own mount prefix,
//      because a URL outside it can never be served by the plugin that ships it.
//   3. The module it points at must exist and must define the element it names.
//   4. The frameType the component is keyed on must be the type core actually
//      writes for this tool. A typo here fails only in the browser, months later.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { setup, pluginName } from '../index.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOUNT_ROOT = '/api/plugins/';

function fakeRegistry() {
  let tools = new Map();
  let frameComponents = new Map();
  let toolComponents = new Map();
  let classes = new Map();

  class PluginInterface {
    static pluginID = 'unknown';
    constructor(context) { this.context = context; }
  }

  // Mirrors the real PluginRegistry.registerTool contract for exactly the part
  // that matters here: a tool with frameType + clientComponent yields a frame
  // component keyed on frameType.
  let registry = {
    registerTool(name, ToolClass, options = {}) {
      tools.set(name, ToolClass);
      if (ToolClass.clientComponent) {
        toolComponents.set(name, ToolClass.clientComponent);
        if (ToolClass.frameType) {
          frameComponents.set(ToolClass.frameType, {
            ...ToolClass.clientComponent,
            frameType: ToolClass.frameType,
          });
        }
      }
      return ToolClass;
    },
    getTool: (name) => tools.get(name) || null,
    getTools: () => new Map(tools),
    getFrameComponents: () => new Map(frameComponents),
    getToolComponents: () => new Map(toolComponents),
    registerClass(name, Class) { classes.set(name, Class); return Class; },
    getClass: (name) => classes.get(name) || null,
    registerAgentProvider() {},
  };

  classes.set('PluginInterface', PluginInterface);
  classes.set('FrameTypeUserMessage', class FrameTypeUserMessage {});
  return registry;
}

// A minimal host that satisfies setup() without a database, a Discord socket, or
// HTTP: everything the wiring under test does not need is a no-op, and anything
// that would silently do nothing important is recorded instead.
function runSetup() {
  let registry = fakeRegistry();
  let mounts = [];
  let migrations = [];
  let configReads = [];

  let provide = (callback) => callback({
    context: { has: () => false, require: () => null },
    registry,
    mountHttp: (handler, options) => { mounts.push({ handler, options }); },
    authorize: async () => ({ allowed: false, reason: 'not authorised in this fixture' }),
    db: () => ({ one: async () => null, query: async () => ({ rows: [] }) }),
    registerMigrations: (spec) => { migrations.push(spec); },
    appendToSession: async () => ({}),
    appendFrame: async () => ({}),
    appendToSessionQuietly: async () => ({}),
    readConfig: async (path, fallback) => { configReads.push(path); return fallback; },
  });

  setup(provide);
  return { registry, mounts, migrations, configReads };
}

test('the send tool produces a FRAME component, not just a tool component', () => {
  let { registry } = runSetup();

  let tool = registry.getTool('discord:send');
  assert.ok(tool, 'discord:send must be registered');

  // This is the assertion that fails if `frameType` or `clientComponent` is
  // dropped from the tool: both registries stay empty and nothing errors.
  let frameComponents = registry.getFrameComponents();
  assert.equal(frameComponents.size, 1, 'exactly one frame component must be registered');

  let descriptor = frameComponents.get('DiscordSendToolFrame');
  assert.ok(descriptor, 'the component must be keyed on DiscordSendToolFrame');
  assert.equal(descriptor.tagName, 'kikx-discord-send-card');
  assert.equal(descriptor.kind, undefined, 'the raw descriptor is keyed by frameType');

  // The type must be the one core derives for this tool, or the card never shows.
  // Core takes an explicit `frameType` first; with none it derives from the tool
  // name. Assert the explicit value matches the derived one so this stays honest
  // even if someone removes the explicit declaration.
  let derived = 'DiscordSendToolFrame';
  assert.equal(tool.frameType, derived);
});

test('the module URL is inside the plugin mount prefix and the file exists', async () => {
  let { registry } = runSetup();
  let descriptor = registry.getFrameComponents().get('DiscordSendToolFrame');

  assert.ok(
    descriptor.moduleURL.startsWith(`${MOUNT_ROOT}${pluginName}/`),
    `moduleURL ${descriptor.moduleURL} must live under ${MOUNT_ROOT}${pluginName}/ to be servable`,
  );

  let relative = descriptor.moduleURL.slice(`${MOUNT_ROOT}${pluginName}/`.length);
  let source = await readFile(`${PLUGIN_ROOT}${relative}`, 'utf8');

  assert.match(source, /customElements/, 'the module must register a custom element');
  assert.ok(
    source.includes(descriptor.tagName),
    `the module must define ${descriptor.tagName}`,
  );
});

test('the plugin serves exactly that module URL, publicly', async () => {
  let { mounts } = runSetup();
  assert.equal(mounts.length, 1, 'one mount');
  assert.equal(mounts[0].options?.auth, 'public');

  let moduleURL = `${MOUNT_ROOT}${pluginName}/client/discord-send-card.mjs`;
  let subPath = moduleURL.slice(`${MOUNT_ROOT}${pluginName}`.length);

  let written = null;
  let response = {
    writeHead(status, headers) { written = { status, headers }; },
    end(body) { written.body = body ? Buffer.from(body) : null; },
  };

  await mounts[0].handler({
    request: { method: 'GET', headers: {} },
    response,
    rawBody: Buffer.alloc(0),
    json: () => null,
    subPath,
    context: { has: () => false, require: () => null },
    identity: null,
  });

  assert.ok(written, 'the handler must respond');
  assert.equal(written.status, 200, 'the renderer module must be served without an identity');
  assert.match(written.headers['Content-Type'], /javascript/);
  assert.ok(written.body.length > 0);
  assert.match(written.body.toString('utf8'), /kikx-discord-send-card/);

  // Negative control: the same mount must NOT serve arbitrary files.
  let missing = null;
  await mounts[0].handler({
    request: { method: 'GET', headers: {} },
    response: { writeHead(status) { missing = status; }, end() {} },
    rawBody: Buffer.alloc(0),
    json: () => null,
    subPath: '/client/does-not-exist.mjs',
    context: { has: () => false, require: () => null },
    identity: null,
  });
  assert.equal(missing, 404, 'only the shipped renderer is served');
});

test('the renderer module is loadable without a DOM and describes a real frame', async () => {
  let { registry } = runSetup();
  let descriptor = registry.getFrameComponents().get('DiscordSendToolFrame');
  let relative = descriptor.moduleURL.slice(`${MOUNT_ROOT}${pluginName}/`.length);

  let module = await import(`${PLUGIN_ROOT}${relative}`);

  assert.equal(typeof module.describeDiscordSend, 'function');
  assert.equal(typeof module.discordSendSummary, 'function');

  // Built from the frame shape MEASURED on 3003:
  // /kikx/sessions/54e1c081-.../frames/0000000000098155-DiscordSendToolFrame-5ec808f8-....json
  let delivered = module.describeDiscordSend({
    type: 'DiscordSendToolFrame',
    content: {
      phase: 'result',
      input: { actor: 'discord:255524600249581568', channel: '1471361561955143773', content: 'hello from Miri' },
      preview: JSON.stringify({ sent: true, delivered: true, channel: '1471361561955143773', messageID: '1566603219407339671' }),
    },
  });

  assert.equal(delivered.outcome, 'sent');
  assert.equal(delivered.recipient, '255524600249581568');
  assert.equal(delivered.channelKnown, true);
  assert.equal(delivered.body, 'hello from Miri');
  assert.equal(delivered.messageID, '1566603219407339671');
  assert.equal(module.discordSendSummary(delivered), 'Discord · 255524600249581568 — sent');

  // The refusal case is the one an operator must never mistake for delivery.
  let denied = module.describeDiscordSend({
    content: {
      input: { actor: 'discord:255524600249581568', channel: '000000000000000000', content: 'NEGATIVE CONTROL' },
      preview: JSON.stringify({ sent: false, denied: true, reason: 'grant exists for discord.send but its scope does not match the request' }),
    },
  });
  assert.equal(denied.outcome, 'denied');
  assert.equal(denied.channelKnown, false, 'the all-zero placeholder is not a channel');
  assert.match(module.discordSendSummary(denied), /refused by policy/);

  // A call frame with no result yet must not claim to have sent anything.
  let pending = module.describeDiscordSend({
    content: { phase: 'call', input: { actor: 'discord:255524600249581568', channel: '1471361561955143773', content: 'x' } },
  });
  assert.equal(pending.outcome, 'pending');
  assert.equal(pending.messageID, '');
});
