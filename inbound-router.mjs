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

export class DiscordInboundRouter {
  // options:
  //   findChannelSession  async (channelID) => { session_id } | null
  //   bindChannelSession  async ({ channelID, sessionID }) => void
  //   recordFrame         async ({ messageID, sessionID, frameID, text }) => void
  //   seenMessage         async (messageID) => boolean   — dedupe across reconnects
  //   appendToSession     async (sessionID, input) => frame   (waking)
  //   log                 (level, message) => void
  //   botUserID           () => string | null   — read lazily; READY arrives after start
  //   autoBindChannelID   string | null — optional channel to bind to `autoBindSessionID`
  //   autoBindSessionID   string | null
  constructor(options = {}) {
    this.findChannelSession = options.findChannelSession;
    this.bindChannelSession = options.bindChannelSession || (async () => {});
    this.recordFrame = options.recordFrame || (async () => {});
    this.seenMessage = options.seenMessage || (async () => false);
    this.appendToSession = options.appendToSession;
    this.log = options.log || (() => {});
    this.botUserID = options.botUserID || (() => null);
    this.autoBindChannelID = options.autoBindChannelID || null;
    this.autoBindSessionID = options.autoBindSessionID || null;

    if (typeof this.appendToSession !== 'function')
      throw new Error('DiscordInboundRouter requires appendToSession');
    if (typeof this.findChannelSession !== 'function')
      throw new Error('DiscordInboundRouter requires findChannelSession');
  }

  // Route one dispatch event. Returns a result object describing what happened, which
  // is what the tests assert on — a boolean would lose the reason.
  async handle(eventType, data) {
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

    let frame = await this.appendToSession(sessionID, {
      text,
      source: 'discord',
      // The message id travels with the frame so an edit can find it again, and so a
      // reconnect replay can be recognised as the same frame rather than a new one.
      content: { discord: { messageID, channelID, authorName } },
    });

    // appendToSession returns { session, frame, commit, wakePending }: the frame id is
    // one level down. Reading frame.id directly silently records no mapping at all.
    let frameID = frame?.frame?.id || frame?.id || null;
    await this.recordFrame({ messageID, sessionID, frameID, text });
    return { handled: true, sessionID, frameID, messageID };
  }
}
