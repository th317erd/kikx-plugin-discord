// dogfood-3003 reply-leg: drive the REAL SendTool through the REAL PluginAuthority
// and the REAL PluginDatabase on the live server DB (:5434).
//
// This exists because the agent loop cannot reach `discord:send`: core's
// AGENT_TOOL_NAME_PATTERN (/^[A-Za-z0-9_-]+$/) rejects the colon, so the tool is
// registered but never exposed to any agent. This harness is NOT a substitute for that
// path — it exercises the send half only, with the authorization boundary left exactly
// where it is.
//
// Nothing here fakes a grant. authorize() reads the live table. Absent or
// wrongly-scoped, the send cannot happen, and the negative control below asserts the
// scope is actually enforced before any network call is made.

import pg from '/home/wyatt/Projects/kikx-workspace/kikx/node_modules/pg/lib/index.js';
import { createConfigStore } from '../kikx/src/core/config/index.mjs';
import { PluginAuthority } from '../kikx/src/core/plugins/plugin-authority.mjs';
import { PluginDatabase } from '../kikx/src/core/plugins/plugin-database.mjs';
import { PluginInterface } from '../kikx/src/core/plugins/plugin-interface.mjs';
import { FrameTypeUserMessage } from '../kikx/src/core/frames/frame-types/frame-type-user-message.mjs';
import { setup as discordSetup } from './index.mjs';

const DATABASE_URL = process.env.ORG_AEOR_KIKX_DATABASE_URL;
const CHANNEL = '1471361561955143773';
const ACTOR = 'discord:255524600249581568';
const CONTENT = process.argv[2] || '';

if (!DATABASE_URL) throw new Error('ORG_AEOR_KIKX_DATABASE_URL is required');
if (!CONTENT) throw new Error('usage: node .dogfood-reply-leg.mjs <content>');

let config = await createConfigStore();
console.log('bot token resolvable from config store: %s',
  Boolean(await config.get('/kikx/discord/bot/token')));

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const db = new PluginDatabase({ pluginId: 'discord', pool });
const authority = new PluginAuthority({ pluginId: 'discord', db });

// --- 1. what the authorization boundary actually says, before any send -------------
let verdict = await authority.authorize({
  actor: ACTOR,
  action: 'discord.send',
  scope: { channel: CHANNEL },
});
console.log('authorize(%s, discord.send, channel=%s) = %j', ACTOR, CHANNEL, verdict);

// Negative control: same actor, same action, a channel the grant does not cover. A
// boundary that allowed every channel would make both the grant's scope and this test
// meaningless, so a permissive answer aborts before the network.
let control = await authority.authorize({
  actor: ACTOR,
  action: 'discord.send',
  scope: { channel: '000000000000000000' },
});
console.log('negative control (wrong channel) = %j', control);

if (!verdict.allowed) {
  console.log('RESULT: denied by the real authority; nothing sent');
  await pool.end();
  process.exit(1);
}
if (control.allowed) {
  console.log('RESULT: ABORT - scope is not enforced; refusing to send');
  await pool.end();
  process.exit(2);
}

// --- 2. capture the plugin's real registrations without running the gateway --------
// setup() takes provide(cb); provide calls cb synchronously with the plugin context.
// Only what SendTool and FrameTypeDiscordFrame touch is supplied. mountHttp and the
// lifecycle hooks are captured but never invoked, so no socket is opened and no second
// process touches the bot token's gateway connection.
const registeredTools = new Map();
const registeredClasses = new Map();
let httpMount = null;
let hooks = null;

const registryStub = {
  getClass(name) {
    if (name === 'PluginInterface') return PluginInterface;
    if (name === 'FrameTypeUserMessage') return FrameTypeUserMessage;
    return null;
  },
  registerTool(name, ToolClass) { registeredTools.set(name, ToolClass); },
  registerClass(name, ClassRef) { registeredClasses.set(name, ClassRef); },
};
const noop = () => {};
const asyncNoop = async () => {};

discordSetup((callback) => {
  hooks = callback({
    context: { has: () => false, require: () => null },
    registry: registryStub,
    mountHttp: (handler, opts) => { httpMount = { handler, opts }; },
    authorize: (request) => authority.authorize(request),
    db,
    registerMigrations: noop,
    appendToSession: asyncNoop,
    appendFrame: asyncNoop,
    appendToSessionQuietly: asyncNoop,
    readConfig: (path, fallback = null) =>
      Promise.resolve(config.get(path)).then((v) => (v == null ? fallback : v)),
  });
  return null;
});

const SendTool = registeredTools.get('discord:send');
if (typeof SendTool !== 'function') throw new Error('discord:send did not register');

// --- 3. the real tool, through the real public execute() path ----------------------
const tool = new SendTool({});
const result = await tool.execute({ actor: ACTOR, channel: CHANNEL, content: CONTENT });
console.log('SendTool.execute => %j', result);

console.log('registered tools:   %j', [...registeredTools.keys()]);
console.log('registered classes: %j', [...registeredClasses.keys()]);
console.log('http mount recorded: %s (public=%s)',
  httpMount ? 'yes' : 'no', httpMount?.opts?.auth ?? 'n/a');
console.log('lifecycle hooks:    %j', hooks ? Object.keys(hooks) : null);

await pool.end();
process.exit(result?.delivered === true ? 0 : 3);
