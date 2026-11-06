'use strict';

// =============================================================================
// Discord read + write tools
// =============================================================================
// list_servers, list_channels, list_threads, list_messages, participants,
// react (add/remove emoji), post_file (files + images).
//
// Every tool here asks authorize() BEFORE any network call — deny-by-default is
// the whole point of the capability boundary, and a read that fetches first and
// checks after has already leaked what it was supposed to protect. Two new
// grantable actions carry them: discord.read (the five reads) and discord.react
// (the reaction tool). post_file rides discord.send, like discord:send itself.
//
// These are registered from index.mjs setup() — a correct module nothing enters
// is the defect shape this plugin keeps producing, so registration is asserted
// from the REAL entry point in spec/plugin-entry-spec.mjs.
//
// Honest limits, stated in the tool descriptions so a caller is never surprised:
//   - threads: ACTIVE threads only (archived need a per-channel route + intent).
//   - participants: derived from recent messages; the guild-members list needs
//     the privileged GUILD_MEMBERS intent, which this bot does not have.
//   - post_file: bytes as base64 only. Fetching a caller-supplied URL to post it
//     would be an SSRF surface on the transport; not built, on purpose.
// =============================================================================

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'Kikx-Discord (https://github.com/th317erd/kikx, 0.1.0)';

// Discord channel type codes -> names, for readable listings.
const CHANNEL_TYPE_NAMES = {
  0: 'text', 1: 'dm', 2: 'voice', 3: 'group_dm', 4: 'category',
  5: 'announcement', 10: 'announcement_thread', 11: 'public_thread',
  12: 'private_thread', 13: 'stage', 14: 'directory', 15: 'forum', 16: 'media'
};

function stripHash(value) {
  return String(value ?? '').replace(/^#/, '');
}

// Scope for authorize(): the request narrows on whatever resource it names.
// An unscoped grant (no scope_json) allows any scope; a channel-scoped grant
// only matches when this produces the same key/value (core PluginAuthority).
function scopeFrom(params) {
  let scope = {};
  if (params.channel !== undefined && params.channel !== null && params.channel !== '')
    scope.channel = stripHash(params.channel);
  if (params.guild !== undefined && params.guild !== null && params.guild !== '')
    scope.guild = stripHash(params.guild);
  return scope;
}

function botHeaders(token) {
  return { Authorization: `Bot ${token}`, 'User-Agent': USER_AGENT };
}

function jsonHeaders(token) {
  return { ...botHeaders(token), 'Content-Type': 'application/json' };
}

// One GET, same honest error shape everywhere: {ok:false, status, discordError}
// never throws — a transport that throws loses the status code that would have
// said WHY (403 vs 429 vs 404 are different answers to different questions).
async function discordGET(token, path, query = {}) {
  let url = DISCORD_API + path;
  let qs = new URLSearchParams();
  for (let [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '')
      qs.set(key, String(value));
  }
  let search = qs.toString();
  if (search) url += `?${search}`;

  try {
    let res = await fetch(url, { method: 'GET', headers: botHeaders(token) });
    if (res.status === 204)
      return { ok: true, status: 204, data: null };
    if (!res.ok) {
      let detail = await res.text().catch(() => '');
      return { ok: false, status: res.status, discordError: detail.slice(0, 300) };
    }
    let data = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message || error) };
  }
}

function mapAuthor(author) {
  if (!author) return null;
  return {
    id: author.id || null,
    username: author.username || null,
    globalName: author.global_name || author.globalName || null,
    bot: author.bot === true,
  };
}

function mapMessage(message) {
  if (!message) return null;
  return {
    id: message.id,
    channelID: message.channel_id || null,
    author: mapAuthor(message.author),
    content: typeof message.content === 'string' ? message.content : '',
    timestamp: message.timestamp || null,
    editedTimestamp: message.edited_timestamp || null,
    pinned: message.pinned === true,
    // The id this message replies to, when Discord recorded one — this is how
    // list_messages proves reply structure without fetching the parent.
    replyToMessageID: message.referenced_message?.id || null,
    // Reaction state, so discord:react can be verified by discord:list_messages
    // - the tool's own read path, not a side-channel probe.
    reactions: Array.isArray(message.reactions)
      ? message.reactions.map((r) => ({
        name: r.emoji?.name || null,
        emojiID: r.emoji?.id || null,
        animated: r.emoji?.animated === true,
        count: r.count || 0,
        me: r.me === true,
      }))
      : [],
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map((a) => ({ filename: a.filename, url: a.url, contentType: a.content_type || null }))
      : [],
  };
}

function mapChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    name: channel.name || null,
    type: channel.type,
    typeName: CHANNEL_TYPE_NAMES[channel.type] || `type_${channel.type}`,
    parentID: channel.parent_id || null,
    position: typeof channel.position === 'number' ? channel.position : null,
    topic: channel.topic || null,
    nsfw: channel.nsfw === true,
    archived: channel.thread_metadata?.archived === true,
  };
}

// The factory that gives every read tool the same spine: authorise, get token,
// run, return {ok:...}. The only thing that varies is the actual REST call.
function makeReadTool({ PluginInterface, authorize, readConfig, tokenPath, tokenForChannel, spec }) {
  class DiscordReadTool extends PluginInterface {
    static pluginID = 'discord';
    static featureName = spec.featureName;
    static displayName = spec.displayName;
    static description = spec.description;
    static version = '0.1.0';
    static riskLevel = 'none';   // authorization is explicit below, not via a UI prompt
    static inputSchema = {
      type: 'object',
      required: ['actor', ...spec.required],
      properties: {
        actor: { type: 'string', description: 'Who is reading' },
        ...spec.properties,
      },
    };

    async _execute(params = {}) {
      let verdict = await authorize({ actor: params.actor, action: 'discord.read', scope: scopeFrom(params) });
      if (!verdict.allowed)
        return { ok: false, denied: true, reason: verdict.reason };

      // A channel-scoped read answers with the token THAT channel's bot holds: in a
      // multi-bot instance, reading #squeak as the legacy bot shows the wrong
      // identity and fails where only Squeak may read. Reads that name no channel
      // (guild listings, list_servers) fall back to the legacy token — every fleet
      // bot shares one guild today, so guild scope has no per-channel key.
      let token = params.channel !== undefined && params.channel !== null && params.channel !== ''
        ? await (tokenForChannel || (() => readConfig(tokenPath, null)))(stripHash(params.channel))
        : await readConfig(tokenPath, null);
      if (!token)
        return { ok: false, denied: false, authorized: true, pending: 'no-bot-token', note: 'no bot token configured (per-channel /kikx/discord/bots/<key>/token or the legacy KIKX_DISCORD_BOT_TOKEN)' };

      return { ok: true, tool: `discord:${spec.featureName}`, ...(await spec.run(token, params)) };
    }
  }

  return DiscordReadTool;
}

// registerDiscordTools is called from index.mjs setup() with the real closures
// (registry, PluginInterface, authorize, readConfig) — that call site IS the
// reachability proof; this function never runs in any other path.
export function registerDiscordTools({ registry, PluginInterface, authorize, readConfig, tokenPath, tokenForChannel }) {
  if (!PluginInterface)
    throw new Error('kikx-plugin-discord discord-tools requires PluginInterface in plugin context');

  // --- discord:list_servers ---------------------------------------------------
  // GET /users/@me/guilds — the servers this bot is in. No pagination param:
  // Discord returns up to 200 with a bearer, which is the whole membership.
  registry.registerTool('discord:list_servers', makeReadTool({
    PluginInterface, authorize, readConfig, tokenPath, tokenForChannel,
    spec: {
      featureName: 'list_servers',
      displayName: 'Discord list servers',
      description: 'List the Discord servers (guilds) this bot is a member of. Requires a discord.read grant.',
      required: [],
      properties: {},
      async run(token) {
        let res = await discordGET(token, '/users/@me/guilds');
        if (!res.ok) return res;
        let servers = (res.data || []).map((guild) => ({
          id: guild.id,
          name: guild.name,
          owner: guild.owner === true,
          iconURL: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png` : null,
        }));
        return { servers, count: servers.length };
      },
    },
  }));

  // --- discord:list_channels --------------------------------------------------
  // GET /guilds/{id}/channels — every channel in a server, including active
  // threads (Discord folds them into this listing).
  registry.registerTool('discord:list_channels', makeReadTool({
    PluginInterface, authorize, readConfig, tokenPath, tokenForChannel,
    spec: {
      featureName: 'list_channels',
      displayName: 'Discord list channels',
      description: 'List the channels of a Discord server. Requires a discord.read grant.',
      required: ['guild'],
      properties: {
        guild: { type: 'string', description: 'Server (guild) id' },
        kind: { type: 'string', description: 'Optional type filter: text, voice, category, forum, announcement, public_thread, ...' },
      },
      async run(token, params) {
        let res = await discordGET(token, `/guilds/${encodeURIComponent(stripHash(params.guild))}/channels`);
        if (!res.ok) return res;
        let channels = (res.data || []).map(mapChannel);
        let filtered = params.kind
          ? channels.filter((c) => c.typeName === String(params.kind).toLowerCase())
          : channels;
        return { guild: stripHash(params.guild), channels: filtered, count: filtered.length };
      },
    },
  }));

  // --- discord:list_threads ---------------------------------------------------
  // GET /guilds/{id}/threads/active — ACTIVE threads only. Archived threads are
  // a different, per-channel route; not claimed here.
  registry.registerTool('discord:list_threads', makeReadTool({
    PluginInterface, authorize, readConfig, tokenPath, tokenForChannel,
    spec: {
      featureName: 'list_threads',
      displayName: 'Discord list threads',
      description: 'List the ACTIVE threads of a Discord server (archived threads are not included). Requires a discord.read grant.',
      required: ['guild'],
      properties: {
        guild: { type: 'string', description: 'Server (guild) id' },
      },
      async run(token, params) {
        let res = await discordGET(token, `/guilds/${encodeURIComponent(stripHash(params.guild))}/threads/active`);
        if (!res.ok) return res;
        let threads = (res.data?.threads || []).map(mapChannel);
        return {
          guild: stripHash(params.guild),
          threads,
          count: threads.length,
          note: 'active threads only; archived threads need a separate per-channel route',
        };
      },
    },
  }));

  // --- discord:list_messages --------------------------------------------------
  // GET /channels/{id}/messages — newest first. This is the ONLY read path a
  // bot has: Discord offers no cross-guild search, so "search" means paging
  // this endpoint. before/after/around are Discord's own cursors.
  registry.registerTool('discord:list_messages', makeReadTool({
    PluginInterface, authorize, readConfig, tokenPath, tokenForChannel,
    spec: {
      featureName: 'list_messages',
      displayName: 'Discord list messages',
      description: 'Read recent messages of a Discord channel (newest first; use before/after/around to page). Requires a discord.read grant.',
      required: ['channel'],
      properties: {
        channel: { type: 'string', description: 'Channel id' },
        limit: { type: 'number', description: 'How many (1-100, default 20)' },
        before: { type: 'string', description: 'Page: messages older than this message id' },
        after: { type: 'string', description: 'Page: messages newer than this message id' },
        around: { type: 'string', description: 'Page: messages around this message id' },
      },
      async run(token, params) {
        let limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
        let res = await discordGET(token, `/channels/${encodeURIComponent(stripHash(params.channel))}/messages`, {
          limit,
          before: params.before,
          after: params.after,
          around: params.around,
        });
        if (!res.ok) return res;
        let messages = (res.data || []).map(mapMessage);
        return { channel: stripHash(params.channel), messages, count: messages.length };
      },
    },
  }));

  // --- discord:participants ---------------------------------------------------
  // Derived from recent messages, NOT from GET /guilds/{id}/members: that route
  // needs the privileged GUILD_MEMBERS intent. Saying so beats returning an
  // empty list and letting a caller conclude the channel has no members.
  registry.registerTool('discord:participants', makeReadTool({
    PluginInterface, authorize, readConfig, tokenPath, tokenForChannel,
    spec: {
      featureName: 'participants',
      displayName: 'Discord participants',
      description: 'Who has spoken recently in a channel, derived from its messages (the full member list needs a privileged intent this bot does not have). Requires a discord.read grant.',
      required: ['channel'],
      properties: {
        channel: { type: 'string', description: 'Channel id' },
        limit: { type: 'number', description: 'How many messages to sample (1-100, default 100)' },
      },
      async run(token, params) {
        let limit = Math.min(100, Math.max(1, Number(params.limit) || 100));
        let res = await discordGET(token, `/channels/${encodeURIComponent(stripHash(params.channel))}/messages`, { limit });
        if (!res.ok) return res;
        let byID = new Map();
        for (let message of res.data || []) {
          let author = message.author;
          if (!author || byID.has(author.id)) continue;
          byID.set(author.id, { ...mapAuthor(author), lastSeenAt: message.timestamp || null });
        }
        let participants = [...byID.values()];
        return {
          channel: stripHash(params.channel),
          participants,
          count: participants.length,
          sampledMessages: (res.data || []).length,
          note: 'derived from the most recent messages; the full member list needs the privileged GUILD_MEMBERS intent',
        };
      },
    },
  }));

  // --- discord:react ----------------------------------------------------------
  // PUT/DELETE /channels/{c}/messages/{m}/reactions/{emoji}/@me — add or remove
  // the BOT's own reaction. A 204 with an empty body IS Discord's success.
  class DiscordReactTool extends PluginInterface {
    static pluginID = 'discord';
    static featureName = 'react';
    static displayName = 'Discord react';
    static description = 'Add or remove this bot\'s emoji reaction on a message. Requires a discord.react capability grant.';
    static version = '0.1.0';
    static riskLevel = 'none';   // authorization is explicit below, not via a UI prompt
    static inputSchema = {
      type: 'object',
      required: ['actor', 'channel', 'message_id', 'emoji'],
      properties: {
        actor: { type: 'string', description: 'Who is reacting' },
        channel: { type: 'string', description: 'Channel the grant must cover' },
        message_id: { type: 'string', description: 'Message to react to' },
        emoji: { type: 'string', description: 'Emoji, unicode (👍) or custom (:name: / <a:name:id>)' },
        op: { type: 'string', enum: ['add', 'remove'], description: 'add (default) or remove' },
      },
    };

    async _execute(params = {}) {
      let verdict = await authorize({ actor: params.actor, action: 'discord.react', scope: scopeFrom(params) });
      if (!verdict.allowed)
        return { ok: false, denied: true, reason: verdict.reason };

      let channelID = stripHash(params.channel);
      // The reaction is placed by the bot that owns this channel, so a multi-bot
      // instance reacts as the right identity — and a channel none of us may read
      // fails here with its real 403 instead of the wrong bot's.
      let token = await (tokenForChannel || (() => readConfig(tokenPath, null)))(channelID);
      if (!token)
        return { ok: false, denied: false, authorized: true, pending: 'no-bot-token', note: `no bot token configured for channel ${channelID}` };

      let messageID = String(params.message_id || '').trim();
      let emoji = String(params.emoji || '').trim();
      if (!messageID || !emoji)
        return { ok: false, denied: false, authorized: true, error: 'message_id and emoji are required' };

      // Custom reactions travel as "name:id", not "<a:name:id>" — normalize
      // before percent-encoding, or Discord 404s on the brackets.
      let custom = /^<a?:([^:]+):(\d+)>$/.exec(emoji);
      let emojiPath = custom ? `${custom[1]}:${custom[2]}` : emoji;

      let remove = String(params.op || 'add').toLowerCase() === 'remove';
      let method = remove ? 'DELETE' : 'PUT';
      let url = `${DISCORD_API}/channels/${encodeURIComponent(channelID)}/messages/${encodeURIComponent(messageID)}/reactions/${encodeURIComponent(emojiPath)}/@me`;

      try {
        let res = await fetch(url, { method, headers: botHeaders(token) });
        if (res.status === 204)
          return { ok: true, tool: 'discord:react', op: remove ? 'remove' : 'add', channel: channelID, messageID, emoji, reacted: !remove };
        let detail = await res.text().catch(() => '');
        return { ok: false, tool: 'discord:react', status: res.status, discordError: detail.slice(0, 300), reacted: false };
      } catch (error) {
        return { ok: false, tool: 'discord:react', error: String(error?.message || error), reacted: false };
      }
    }
  }

  registry.registerTool('discord:react', DiscordReactTool);

  // --- discord:post_file ------------------------------------------------------
  // POST /channels/{id}/messages as multipart: payload_json carries the caption,
  // files[0] carries the bytes. Same discord.send grant as discord:send — it is
  // the same act (putting content in a channel), wearing a different Encoding.
  class DiscordPostFileTool extends PluginInterface {
    static pluginID = 'discord';
    static featureName = 'post_file';
    static displayName = 'Discord post file';
    static description = 'Post a file or image to a Discord channel from base64 bytes (no URL fetching, by design). Requires a discord.send capability grant.';
    static version = '0.1.0';
    static riskLevel = 'none';   // authorization is explicit below, not via a UI prompt
    static inputSchema = {
      type: 'object',
      required: ['actor', 'channel', 'filename', 'bytes_base64'],
      properties: {
        actor: { type: 'string', description: 'Who is posting' },
        channel: { type: 'string', description: 'Channel the grant must cover' },
        filename: { type: 'string', description: 'Filename with extension, e.g. shot.png' },
        bytes_base64: { type: 'string', description: 'File contents, base64' },
        content: { type: 'string', description: 'Optional caption posted with the file' },
        spoiler: { type: 'boolean', description: 'Mark the attachment as a spoiler (default false)' },
      },
    };

    async _execute(params = {}) {
      let verdict = await authorize({ actor: params.actor, action: 'discord.send', scope: scopeFrom(params) });
      if (!verdict.allowed)
        return { ok: false, denied: true, reason: verdict.reason };

      let channelID = stripHash(params.channel);
      // A file lands in the channel through the bot that owns the channel: same
      // per-channel identity rule as discord:send, same honest fallback.
      let token = await (tokenForChannel || (() => readConfig(tokenPath, null)))(channelID);
      if (!token)
        return { ok: false, denied: false, authorized: true, pending: 'no-bot-token', note: `no bot token configured for channel ${channelID}` };

      let filename = String(params.filename || '').trim();
      let base64 = String(params.bytes_base64 || '').trim();
      if (!filename || !base64)
        return { ok: false, denied: false, authorized: true, error: 'filename and bytes_base64 are required' };

      let bytes;
      try {
        bytes = Buffer.from(base64, 'base64');
      } catch {
        return { ok: false, denied: false, authorized: true, error: 'bytes_base64 is not valid base64' };
      }
      if (bytes.length === 0)
        return { ok: false, denied: false, authorized: true, error: 'bytes_base64 decoded to zero bytes' };

      // Discord convention: a "SPOILER_" prefix marks the attachment spoiler.
      let uploadName = params.spoiler === true && !/^SPOILER_/i.test(filename)
        ? `SPOILER_${filename}`
        : filename;

      let form = new FormData();
      let payload = { content: typeof params.content === 'string' && params.content !== '' ? params.content : undefined };
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', new Blob([bytes]), uploadName);

      try {
        let res = await fetch(`${DISCORD_API}/channels/${encodeURIComponent(channelID)}/messages`, {
          method: 'POST',
          headers: botHeaders(token),   // no Content-Type: fetch sets the multipart boundary
          body: form,
        });
        if (!res.ok) {
          let detail = await res.text().catch(() => '');
          return { ok: false, tool: 'discord:post_file', status: res.status, discordError: detail.slice(0, 300), posted: false };
        }
        let posted = await res.json().catch(() => null);
        return {
          ok: true,
          tool: 'discord:post_file',
          posted: true,
          channel: channelID,
          messageID: posted?.id || null,
          filename,
          bytes: bytes.length,
          attachmentURL: posted?.attachments?.[0]?.url || null,
        };
      } catch (error) {
        return { ok: false, tool: 'discord:post_file', error: String(error?.message || error), posted: false };
      }
    }
  }

  registry.registerTool('discord:post_file', DiscordPostFileTool);
}
