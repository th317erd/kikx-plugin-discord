'use strict';

// The INBOUND Discord message must be legible in the session thread.
//
// The problem this spec guards, measured on live 3098 rather than guessed:
// `GET /api/v1/client-components` returned 123 descriptors, of which exactly two
// were Discord — both for the OUTBOUND tool frame. `frameType:'DiscordFrame'`
// count was 0. So an inbound message was correctly typed, correctly agentOnly and
// correctly attributed on the server, and still rendered client-side as a bare
// chip reading "Message" with no author and no body. An operator could not tell a
// message from a Discord user apart from their own turn.
//
// The asymmetry is the whole defect: the plugin registered the frame type but
// never registered a renderer for it. This spec asserts the wiring that stays
// invisible until it silently fails:
//   1. a FRAME component must exist, keyed on the exact type the router writes;
//   2. its moduleURL must sit inside this plugin's own mount prefix, or the
//      plugin cannot serve the file it advertises;
//   3. the module must exist and define the element the descriptor names;
//   4. the plugin's public mount must actually serve that module;
//   5. the label and author must come from frame content, never be invented.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { setup, pluginName } from '../index.mjs';
import { describeDiscordMessage, discordMessageSummary } from '../client/discord-message-card.mjs';

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

  let registry = {
    registerTool(name, ToolClass) {
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
    // Mirrors PluginRegistry.registerFrameComponent: the descriptor is stored
    // keyed by frameType, and extra fields on the descriptor survive. That is the
    // property the label/icon assertion below depends on.
    registerFrameComponent(frameType, descriptor = {}) {
      let normalized = { ...descriptor, kind: 'frame', frameType };
      frameComponents.set(frameType, normalized);
      return normalized;
    },
    getTool: (name) => tools.get(name) || null,
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

function runSetup() {
  let registry = fakeRegistry();
  let mounts = [];

  let provide = (callback) => callback({
    context: { has: () => false, require: () => null },
    registry,
    mountHttp: (handler, options) => { mounts.push({ handler, options }); },
    authorize: async () => ({ allowed: false, reason: 'not authorised in this fixture' }),
    db: () => ({ one: async () => null, query: async () => ({ rows: [] }) }),
    registerMigrations: () => {},
    appendToSession: async () => ({}),
    appendFrame: async () => ({}),
    appendToSessionQuietly: async () => ({}),
    readConfig: async (path, fallback) => fallback,
  });

  setup(provide);
  return { registry, mounts };
}

test('the inbound frame type has a FRAME component, keyed on the type the router writes', () => {
  let { registry } = runSetup();

  let descriptor = registry.getFrameComponents().get('DiscordFrame');
  assert.ok(descriptor, 'DiscordFrame must have a registered frame component; without one the frame falls through to the generic text path');

  assert.equal(descriptor.kind, 'frame');
  assert.equal(descriptor.tagName, 'kikx-discord-message-card');
});

test('the router still writes the type the component is keyed on', async () => {
  // A typo here fails only in a browser, much later, so read the constant the
  // router actually uses rather than restating it.
  let source = await readFile(new URL('../inbound-router.mjs', import.meta.url), 'utf8');
  let match = /const DISCORD_FRAME_TYPE = '([^']+)'/.exec(source);
  assert.ok(match, 'inbound-router.mjs must declare DISCORD_FRAME_TYPE');
  assert.equal(match[1], 'DiscordFrame', 'the component is keyed on DiscordFrame; the router must write that exact type');
});

test('the descriptor carries a label and an icon so a collapsed frame is not named after its type', () => {
  let { registry } = runSetup();
  let descriptor = registry.getFrameComponents().get('DiscordFrame');

  assert.equal(descriptor.label, 'Discord Message');
  assert.equal(descriptor.icon, 'chat');
});

test('the module URL is inside the plugin mount prefix and the file exists', async () => {
  let { registry } = runSetup();
  let descriptor = registry.getFrameComponents().get('DiscordFrame');

  assert.ok(
    descriptor.moduleURL.startsWith(`${MOUNT_ROOT}${pluginName}/`),
    `moduleURL ${descriptor.moduleURL} must live under ${MOUNT_ROOT}${pluginName}/ to be servable`,
  );

  let relative = descriptor.moduleURL.slice(`${MOUNT_ROOT}${pluginName}/`.length);
  let source = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
  assert.ok(source.includes(descriptor.tagName), `the served module must define ${descriptor.tagName}`);
});

test('the plugin mount serves the inbound card module', async () => {
  let { mounts } = runSetup();
  assert.ok(mounts.length > 0, 'the plugin must mount HTTP');

  let handler = mounts[0].handler;
  let captured = null;

  let response = {
    writeHead(status, headers) { captured = { status, headers, body: null }; },
    end(body) { if (captured) captured.body = body; },
  };

  await handler({
    request: { method: 'GET', url: '/client/discord-message-card.mjs', headers: {} },
    response,
    subPath: '/client/discord-message-card.mjs',
    rawBody: Buffer.alloc(0),
    json: async () => ({}),
    context: { has: () => false, require: () => null },
    identity: null,
  });

  assert.ok(captured, 'the mount must respond to GET /client/discord-message-card.mjs');
  assert.equal(captured.status, 200, 'the module must be served, not 404');
  assert.match(String(captured.headers['Content-Type']), /javascript/);
  assert.ok(String(captured.body).includes('kikx-discord-message-card'));
});

// --- the pure description rules -------------------------------------------

// Exactly what inbound-router.mjs writes for a message with an attachment.
function framedFrame({ text, authorName = 'th317erd', authorID = '255524600249581568', channelID = '1471361561955143773', messageID = '1566932373428506725' } = {}) {
  return {
    type: 'DiscordFrame',
    authorDisplayName: authorName,
    content: {
      text,
      discord: { messageID, channelID, authorName, authorID },
    },
  };
}

test('the card names the Discord author and shows the body, not a bare "Message"', () => {
  let frame = framedFrame({ text: '[discord:th317erd] Hello! Are you getting this message Miri?' });
  let description = describeDiscordMessage(frame);

  assert.equal(description.author, 'th317erd');
  assert.equal(description.body, 'Hello! Are you getting this message Miri?');
  assert.equal(description.messageID, '1566932373428506725');
  assert.equal(description.channel, '1471361561955143773');
  assert.equal(description.channelKnown, true);

  assert.equal(discordMessageSummary(frame), 'Discord Message · th317erd');
});

test('the speaker prefix is stripped from the body but the author is kept', () => {
  // The prefix exists so the agent can tell who is talking. On a card it is
  // redundant: the author is shown, so repeating it in the body is noise.
  let frame = framedFrame({ text: '[discord:cliff7121] shipping it now', authorName: 'cliff7121' });
  let description = describeDiscordMessage(frame);
  assert.equal(description.body, 'shipping it now');
  assert.equal(description.author, 'cliff7121');

  // The structured discord block wins over the text prefix when they disagree:
  // the block is what this plugin wrote, the prefix is a rendering of it.
  let disagreeing = framedFrame({ text: '[discord:cliff7121] hi', authorName: 'th317erd' });
  assert.equal(describeDiscordMessage(disagreeing).author, 'th317erd');
});

test('a bracketed prefix appearing later in the message is not stripped', () => {
  let frame = framedFrame({ text: '[discord:th317erd] reply quoting [discord:someone] inline' });
  assert.equal(describeDiscordMessage(frame).body, 'reply quoting [discord:someone] inline');
});

test('media lines are surfaced separately from the caption', () => {
  let frame = framedFrame({
    text: '[discord:th317erd] look at this\n[attachment: 3098-media-proof.png (image/png, 70 bytes, 1x1) https://cdn.discordapp.com/x.png]',
  });
  let description = describeDiscordMessage(frame);

  assert.equal(description.body, 'look at this');
  assert.deepEqual(description.media, [ '[attachment: 3098-media-proof.png (image/png, 70 bytes, 1x1) https://cdn.discordapp.com/x.png]' ]);
});

test('an attachment-only message has no body and still shows its media', () => {
  let frame = framedFrame({ text: '[discord:th317erd] [attachment: shot.png (image/png, 70 bytes) https://cdn.discordapp.com/y.png]' });
  let description = describeDiscordMessage(frame);
  assert.equal(description.body, '');
  assert.equal(description.media.length, 1);
});

test('a missing name is reported as missing, never invented', () => {
  // The failure mode being fixed is a frame presented as if the owner said it.
  // So with nothing to go on the card must say "Discord Message" and no author —
  // it must NOT fall back to "You" or to a placeholder handle.
  let bare = { type: 'DiscordFrame', content: { text: 'no metadata here' } };
  let description = describeDiscordMessage(bare);

  assert.equal(description.author, null);
  assert.equal(description.channelKnown, false);
  assert.equal(description.messageID, '');
  assert.equal(discordMessageSummary(bare), 'Discord Message');
});

test('a prefixed actor id is not shown as a handle', () => {
  let frame = { type: 'DiscordFrame', authorDisplayName: 'discord:255524600249581568', content: { text: 'x' } };
  assert.equal(describeDiscordMessage(frame).author, '255524600249581568');
});
