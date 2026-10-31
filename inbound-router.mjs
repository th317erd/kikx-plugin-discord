'use strict';

// =============================================================================
// Inbound message routing — gateway events into Kikx sessions
// =============================================================================
// The gateway delivers events; this decides which of them become Kikx frames. It is a
// separate module for one reason: routing policy (dedupe, self-filtering, binding
// lookup) is where a transport quietly goes wrong, and it must be testable without a
// socket, a database, or a session runtime.
//
// All effects are injected, so the tests drive it with plain fakes.
// =============================================================================

// Discord's own message type. 0 is a normal user message; 19 is a reply. Anything else
// (joins, pins, boosts, calls) has no text worth framing.
const FRAMEABLE_MESSAGE_TYPES = new Set([0, 19]);

// The frame type this plugin writes into a session.
//
// It is registered as a frame-type class in index.mjs with `static agentOnly`,
// which is what makes the frame hidden from the transcript while the agent still
// receives it. `hidden: true` cannot do that: it removes the frame from model
// context, so the bot never reads the message.
const DISCORD_FRAME_TYPE = 'DiscordFrame';

// A newline, named rather than written as an escape inline. The diff below splits
// message text on it, and an inline escape is exactly what got mis-quoted twice.
const NEWLINE = String.fromCharCode(10);

export class DiscordInboundRouter {
  // options:
  //   findChannelSession  async (channelID) => { session_id } | null
  //   bindChannelSession  async ({ channelID, sessionID }) => void
  //   recordFrame         async ({ messageID, sessionID, frameID, text }) => void
  //   seenMessage         async (messageID) => boolean   — dedupe across reconnects
  //   appendFrame         async (sessionID, input) => frame   (waking, typed)
  //   log                 (level, message) => void
  //   botUserID           () => string | null   — read lazily; READY arrives after start
  //   autoBindChannelID   string | null — optional channel to bind to `autoBindSessionID`
  //   autoBindSessionID   string | null
  constructor(options = {}) {
    this.findChannelSession = options.findChannelSession;
    this.bindChannelSession = options.bindChannelSession || (async () => {});
    this.recordFrame = options.recordFrame || (async () => {});
    this.seenMessage = options.seenMessage || (async () => false);
    // The edit path updates the frame a message already became, so the mapping row
    // has to be readable and writable from here rather than from the caller.
    this.findFrame = options.findFrame || (async () => null);
    this.updateFrameAudit = options.updateFrameAudit || (async () => {});
    this.appendFrame = options.appendFrame;
    this.log = options.log || (() => {});
    this.botUserID = options.botUserID || (() => null);
    // Required, not optional. A router that silently skips authorization when none is
    // supplied is an injection path that passes every test that does not look for it.
    this.authorizeInbound = options.authorizeInbound;
    this.autoBindChannelID = options.autoBindChannelID || null;
    this.autoBindSessionID = options.autoBindSessionID || null;

    if (typeof this.appendFrame !== 'function')
      throw new Error('DiscordInboundRouter requires appendFrame');
    if (typeof this.findChannelSession !== 'function')
      throw new Error('DiscordInboundRouter requires findChannelSession');
    if (typeof this.authorizeInbound !== 'function')
      throw new Error('DiscordInboundRouter requires authorizeInbound; inbound without an authorization check is an injection path');
  }


  // An edit never creates a frame and never rewrites the text the bot first read: it
  // appends to that frame's content and keeps the original. Edits do not wake the
  // session - the bot sees the change in its context when it next runs.
  async handleEdit(data) {
    if (!data || typeof data !== 'object') return { handled: false, reason: 'no_payload' };

    let botID = this.botUserID();
    let author = data.author || data.member?.user || data.user || null;
    if (botID && author?.id === botID) return { handled: false, reason: 'own_message' };
    if (author?.bot === true) return { handled: false, reason: 'bot_author' };

    let messageID = data.id || data.message?.id || null;
    let channelID = data.channel_id || data.channel?.id || null;
    let newContent = data.content ?? data.message?.content ?? null;

    // Discord posts MESSAGE_UPDATE for embed unfurls and link previews with no content
    // field at all. Those carry nothing to record, and treating them as an error would
    // log noise every time someone pastes a link.
    if (newContent === null || newContent === undefined)
      return { handled: false, reason: 'edit_without_content' };
    if (!messageID || !channelID) return { handled: false, reason: 'no_ids' };

    let row = await this.findFrame(messageID);
    if (!row || !row.frame_id) {
      // An edit for a message this transport never framed: nothing to update, and
      // guessing which frame it meant would be worse than ignoring it.
      return { handled: false, reason: 'unframed_message', channelID, messageID };
    }

    // An edit is a write. It is authorized against the same action and channel the
    // original message was, because the mapping row only exists for a message that
    // already passed the gate. Skipping it here is how the old inline HTTP copy let an
    // edit land with no capability check at all.
    let actorID = author?.id || null;
    if (!actorID) return { handled: false, reason: 'no_author', channelID, messageID };

    {
      let verdict = await this.authorizeInbound({ actorID, authorName: author.username || 'discord', channelID });
      if (!verdict || verdict.allowed !== true) {
        this.log('warn',
          'discord: denied edit from ' + (author.username || 'discord') + ' (' + actorID
          + ') in channel ' + channelID + ': ' + (verdict?.reason || 'no verdict'));
        return {
          handled: false,
          reason: 'not_authorized',
          channelID,
          actorID,
          messageID,
          detail: verdict?.reason || null,
        };
      }
    }

    let editedAt = data.edited_timestamp || new Date().toISOString();

    // original_text is the prefixed text as framed, so the diff keeps the speaker
    // attribution instead of comparing against raw Discord content.
    let before = String(row.original_text).split(NEWLINE);
    let after = String(newContent).split(NEWLINE);
    let diff = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if ((before[i] ?? '') === (after[i] ?? '')) continue;
      if (before[i] !== undefined) diff.push('- ' + before[i]);
      if (after[i] !== undefined) diff.push('+ ' + after[i]);
    }

    let entry = { editedAt, diff: diff.join(NEWLINE) || '(no textual change)' };
    let existingAudit = Array.isArray(row.audit) ? row.audit : [];
    let audit = [...existingAudit, entry];

    await this.appendFrame(row.session_id, {
      id: row.frame_id,
      text: row.original_text,
      source: 'discord',
      // Re-sent on an edit for the same reason as the first append: core honours
      // these fields, and an edit that omitted them would present the message as
      // the owner's and redraw it in the transcript.
      type: DISCORD_FRAME_TYPE,
      authorID: `discord:${actorID}`,
      authorDisplayName: data.author?.username || 'discord',
      // The audit tail must ride inside content: buildUserMessageContent keeps extra
      // fields from input.content, so a top-level audit was silently dropped.
      content: { audit },
    });

    await this.updateFrameAudit({ messageID, audit, edits: (row.edits || 0) + 1 });

    return {
      handled: true,
      edited: true,
      sessionID: row.session_id,
      frameID: row.frame_id,
      messageID,
      channelID,
      edits: (row.edits || 0) + 1,
    };
  }

  // Route one dispatch event. Returns a result object describing what happened, which
  // is what the tests assert on — a boolean would lose the reason.
  async handle(eventType, data) {
    // MESSAGE_UPDATE is a real event with a real handler. Until this branch existed the
    // router answered 'not_a_message' for it, so over the gateway an edit was silently
    // dropped, and the inline copy of edit handling in the HTTP path was not only a
    // second implementation but never consulted the authorization gate.
    if (eventType === 'MESSAGE_UPDATE') return this.handleEdit(data);
    if (eventType !== 'MESSAGE_CREATE') return { handled: false, reason: 'not_a_message' };
    if (!data || typeof data !== 'object') return { handled: false, reason: 'no_payload' };

    // A bot's own messages come back over the gateway. Framing them would make every
    // reply an input, which is an infinite loop with extra steps.
    let botID = this.botUserID();
    if (botID && data.author && data.author.id === botID)
      return { handled: false, reason: 'own_message' };
    if (data.author && data.author.bot === true)
      return { handled: false, reason: 'bot_author' };

    // The type gate is about Discord guild message types. An interaction envelope has its
    // own type namespace (1 = PING, 2 = APPLICATION_COMMAND), so applying the message set
    // to it would reject every slash command as an unsupported message.
    let isInteraction = Boolean(data.data || data.member || data.user);
    if (!isInteraction && !FRAMEABLE_MESSAGE_TYPES.has(data.type ?? 0))
      return { handled: false, reason: 'unsupported_type' };

    // MESSAGE_CONTENT is privileged. When it is off, Discord sends the message anyway
    // with empty content — so this is the only signal that the intent is missing, and
    // it must be reported rather than dropped silently.
    let content = (typeof data.content === 'string' ? data.content : '')
      || (typeof data.data?.content === 'string' ? data.data.content : '')
      || String(data.data?.options?.find?.((o) => o.name === 'message')?.value ?? '');
    content = content.trim();
    if (!content) return { handled: false, reason: 'empty_content_missing_intent' };

    let messageID = data.id;
    let channelID = data.channel_id || data.channel?.id || null;
    if (!messageID || !channelID) return { handled: false, reason: 'no_ids' };

    // An interaction carries the speaker and the text in different places than a gateway
    // message: the invoking user is under member/user, and the text is a command option
    // or data.content. Without this the HTTP path cannot reuse the policy below.
    let author = data.author || data.member?.user || data.user || null;
    let authorID = author?.id || null;
    let authorName = author?.username || data.author?.username || 'discord';
    if (!authorID) return { handled: false, reason: 'no_author' };
    if (botID && authorID === botID) return { handled: false, reason: 'own_message' };
    if (author?.bot === true) return { handled: false, reason: 'bot_author' };

    if (await this.seenMessage(messageID))
      return { handled: false, reason: 'duplicate' };

    // -----------------------------------------------------------------------
    // Inbound is not trusted merely because it arrived over TLS from Discord.
    // Anyone who can type in a subscribed channel would otherwise write straight
    // into a Kikx session, which is a prompt-injection path wearing a feature's
    // clothes. The gate runs BEFORE the binding lookup and before any write, so a
    // denied sender cannot claim a channel by speaking in it first.
    // -----------------------------------------------------------------------
    {
      let verdict = await this.authorizeInbound({ actorID: authorID, authorName, channelID });
      if (!verdict || verdict.allowed !== true) {
        this.log('warn',
          'discord: denied inbound from ' + authorName + ' (' + authorID
          + ') in channel ' + channelID + ': ' + (verdict?.reason || 'no verdict'));
        return {
          handled: false,
          reason: 'not_authorized',
          channelID,
          actorID: authorID,
          detail: verdict?.reason || null,
        };
      }
    }

    let binding = await this.findChannelSession(channelID);
    if (!binding && this.autoBindChannelID && this.autoBindSessionID && channelID === this.autoBindChannelID) {
      await this.bindChannelSession({ channelID, sessionID: this.autoBindSessionID });
      binding = { session_id: this.autoBindSessionID };
      this.log('info', `discord: auto-bound channel ${channelID} to session ${this.autoBindSessionID}`);
    }
    if (!binding || !binding.session_id)
      return { handled: false, reason: 'unbound_channel', channelID };

    let sessionID = binding.session_id;
    let text = `[discord:${authorName}] ${content}`;

    let frame = await this.appendFrame(sessionID, {
      text,
      source: 'discord',
      // The frame is not the owner speaking. Without the author fields it is
      // presented as the owner's own message, which is both wrong and
      // untraceable; core attributes the turn from these
      // (FrameTypeUserMessage.getAuthorDisplayName).
      type: DISCORD_FRAME_TYPE,
      authorID: `discord:${authorID}`,
      // The bare Discord handle, with no " (Discord)" suffix. The type says where
      // the message came from; decorating the display name made the owner's own
      // name look like a different person and was the wrong fix for the wrong
      // mechanism.
      authorDisplayName: authorName,
      // The message id travels with the frame so an edit can find it again, and so a
      // reconnect replay can be recognised as the same frame rather than a new one.
      content: { discord: { messageID, channelID, authorName, authorID } },
    });

    // appendFrame returns { session, frame, commit, wakePending }: the frame id is one
    // level down. Reading frame.id directly silently records no mapping at all.
    let frameID = frame?.frame?.id || frame?.id || null;
    await this.recordFrame({ messageID, sessionID, frameID, text });
    return { handled: true, sessionID, frameID, messageID };
  }
}
