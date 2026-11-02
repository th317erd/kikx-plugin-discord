'use strict';

// =============================================================================
// kikx-discord-message-card — the visible half of an INBOUND Discord message
// =============================================================================
// The plugin already registered `FrameTypeDiscordFrame` as a server class, and
// that half works: the frame is typed, agentOnly, and attributed to the Discord
// handle. What was never registered is a RENDERER for that type. Measured on the
// live instance, `GET /api/v1/client-components` advertised 123 descriptors and
// exactly two Discord entries, both for the OUTBOUND tool frame:
//
//   {kind:'frame', frameType:'DiscordSendToolFrame', tagName:'kikx-discord-send-card'}
//   {kind:'tool',  toolName:'discord:send',          tagName:'kikx-discord-send-card'}
//
// `frameType:'DiscordFrame'` count: 0. So an inbound message fell through core's
// generic path and an operator saw a collapsed chip reading "Message" with no
// author and no body — a Discord message indistinguishable from their own turn.
//
// This element closes that asymmetry. It is the inbound counterpart to
// discord-send-card.mjs and follows the same rules: dependency-free (served as a
// static module by this plugin's own mount), pure describe/summary helpers
// exported for tests, and the custom element only defined when a DOM exists.
//
// Nothing here is invented. Every field comes from content this plugin wrote
// itself in inbound-router.mjs, which frames:
//
//   text    = `[discord:${authorName}] ${content}`      // content = caption + media lines
//   content = { discord: { messageID, channelID, authorName, authorID } }
//
// A field that is missing is shown as missing, never as a plausible-looking
// placeholder.

const PLACEHOLDER_CHANNEL = '000000000000000000';

// Discord snowflakes are 17-20 digits. The all-zero placeholder is not a channel
// and printing it as one would be a lie about where the message came from.
function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value) && value !== PLACEHOLDER_CHANNEL;
}

// `inbound-router.mjs` prefixes framed text with the speaker so the agent can
// tell who is talking. On a card that prefix is redundant — the body is the
// caption, the prefix is the attribution, and we already show it as an author.
// Anchored and bracket-bounded so a message whose own text contains
// "[discord:...]" later in the body is left alone.
function stripSpeakerPrefix(text) {
  if (typeof text !== 'string')
    return '';
  return text.replace(/^\s*\[discord:[^\]\n]*\]\s?/, '');
}

// describeMessageMedia() emits one bracketed line per attachment, embed or
// sticker, appended to the caption. A card should not render those as prose —
// they are a distinct kind of thing. Split them back out, keeping order.
const MEDIA_PREFIXES = [ '[attachment:', '[embed:', '[sticker:' ];

function splitMedia(lines) {
  let media = [];
  let body = [];

  for (let line of lines) {
    let trimmed = line.trim();
    if (trimmed === '')
      continue;
    if (MEDIA_PREFIXES.some((prefix) => trimmed.startsWith(prefix)))
      media.push(trimmed);
    else
      body.push(line);
  }

  return { body: body.join('\n').trim(), media };
}

// The visible truth about one inbound Discord message, derived only from what the
// frame actually carries. Pure, so it is testable without a DOM.
export function describeDiscordMessage(frame) {
  let content = frame?.content || {};
  let discord = content.discord && typeof content.discord === 'object' ? content.discord : {};

  // The author is the Discord handle as framed. `authorDisplayName` is the same
  // value one level up; prefer the discord block because it is what this plugin
  // wrote, and fall back so older rows (framed before the block existed) still
  // show a name. Never fall back to "You": that is the bug being fixed.
  let author = '';
  for (let candidate of [ discord.authorName, frame?.authorDisplayName, content.authorName ]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      author = candidate.trim();
      break;
    }
  }

  // `discord:255524600249581568` is a Kikx actor id, not a Discord handle.
  if (/^discord:/i.test(author))
    author = author.replace(/^discord:/i, '');

  let channel = typeof discord.channelID === 'string' ? discord.channelID.trim() : '';
  let messageID = typeof discord.messageID === 'string' ? discord.messageID.trim() : '';

  let rawText = typeof content.text === 'string' ? content.text : '';
  let body = stripSpeakerPrefix(rawText);
  let split = splitMedia(body.split('\n'));

  return {
    author: author !== '' ? author : null,
    authorID: typeof discord.authorID === 'string' ? discord.authorID : '',
    channel,
    channelKnown: isSnowflake(channel),
    messageID,
    body: split.body,
    media: split.media,
  };
}

// One line for the collapsed card. Named separately from the element so the
// summary rules can be asserted in a plain unit test. "Discord Message" is the
// literal the owner asked for: the chip should say what it is.
export function discordMessageSummary(frame) {
  let description = describeDiscordMessage(frame);
  return description.author === null
    ? 'Discord Message'
    : `Discord Message · ${description.author}`;
}

function el(doc, tag, className, text) {
  let node = doc.createElement(tag);
  if (className)
    node.className = className;
  if (text !== undefined && text !== null)
    node.textContent = String(text);
  return node;
}

// A custom element can only extend the real HTMLElement, but this module must also
// be importable by the test runner, which has no DOM. Extending a bare placeholder
// there keeps the pure helpers testable, and the element is only defined when
// customElements exists — the same guard discord-send-card.mjs documents.
const ElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

export class DiscordMessageCard extends ElementBase {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
  }

  set frame(frame) {
    this.updateFrame(frame);
  }

  get frame() {
    return this._frame;
  }

  updateFrame(frame, appState = {}) {
    this._frame = frame || null;
    this._appState = appState || {};
    this.render();
  }

  connectedCallback() {
    if (this._frame && this.childNodes.length === 0)
      this.render();
  }

  render() {
    let doc = this.ownerDocument || globalThis.document;
    if (!doc)
      return;

    let description = describeDiscordMessage(this._frame);
    let root = el(doc, 'div', 'kikx-discord-message');

    let head = el(doc, 'div', 'kikx-discord-message__head');
    head.appendChild(el(doc, 'span', 'kikx-discord-message__badge', 'Discord Message'));
    if (description.author !== null)
      head.appendChild(el(doc, 'span', 'kikx-discord-message__author', description.author));
    if (description.channelKnown)
      head.appendChild(el(doc, 'span', 'kikx-discord-message__channel', `#${description.channel}`));
    root.appendChild(head);

    // The body is the point: an operator should read what was said without
    // opening anything. Absent text is not rendered as an empty box.
    if (description.body !== '') {
      let quote = el(doc, 'blockquote', 'kikx-discord-message__body');
      for (let line of description.body.split('\n'))
        quote.appendChild(el(doc, 'p', null, line));
      root.appendChild(quote);
    }

    if (description.media.length > 0) {
      let list = el(doc, 'ul', 'kikx-discord-message__media');
      for (let entry of description.media)
        list.appendChild(el(doc, 'li', null, entry));
      root.appendChild(list);
    }

    // Traceability: the Discord message this frame mirrors. Without it the card
    // cannot be checked against Discord itself.
    let note = description.messageID !== '' ? `message ${description.messageID}` : '';
    if (note !== '')
      root.appendChild(el(doc, 'div', 'kikx-discord-message__note', note));

    this.textContent = '';
    this.appendChild(root);
  }
}

// Registering twice is a no-op; registering the same constructor under two tag
// names is a hard error, and that error would abort evaluation of the whole
// module the client imports. Stay defensive, exactly as the send card does.
export function defineDiscordMessageCard(tagName = 'kikx-discord-message-card', registry = globalThis.customElements) {
  if (!registry)
    return null;
  if (registry.get(tagName))
    return registry.get(tagName);
  registry.define(tagName, DiscordMessageCard);
  return DiscordMessageCard;
}

if (typeof globalThis.customElements !== 'undefined')
  defineDiscordMessageCard();
