'use strict';

// =============================================================================
// kikx-discord-send-card — the visible half of a Discord reply
// =============================================================================
// A Discord conversation is two halves with different visibility:
//
//   inbound  DiscordFrame, agentOnly=true  — hidden from the thread BY DESIGN.
//            The spec's second question is literally "is it absent from the
//            session thread", and routing keys on agentOnly, so flipping the
//            flag would also make the bot deaf. That rule stays.
//
//   outbound DiscordSendToolFrame           — an ordinary tool frame. It is
//            already in the thread; it just renders as a generic tool card, so
//            the thread reads as an agent talking to itself.
//
// This element is the outbound half made legible: it says who in Discord is
// being answered, and with what. It changes no filter, no core module, and no
// frame type — it is a renderer registered by the plugin that owns the tool.
//
// Deliberately dependency-free: it is served as a static module by the plugin's
// own mount and must not import core client paths that a plugin cannot rely on.
// =============================================================================

const PLACEHOLDER_CHANNEL = '000000000000000000';

// Discord snowflakes are 17-20 digits. A channel id that is an empty string or
// the all-zero placeholder is not a channel, and printing it as one would be a
// lie about where the message went.
function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value) && value !== PLACEHOLDER_CHANNEL;
}

// `discord:255524600249581568` is a Kikx actor id, not a Discord handle. The
// handle is only recoverable from the frame when the transport recorded it, so
// the card shows the best true label available and never invents one.
function actorLabel(actor) {
  let text = typeof actor === 'string' ? actor.trim() : '';
  if (text === '')
    return 'Discord';

  let match = /^discord:(.+)$/.exec(text);
  if (match)
    return match[1];

  return text;
}

function parseResult(preview) {
  if (typeof preview !== 'string' || preview.trim() === '')
    return null;

  try {
    let parsed = JSON.parse(preview);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

// The visible truth about one send, derived only from what the frame actually
// carries. Kept as a pure function so it can be tested without a DOM.
export function describeDiscordSend(frame) {
  let content = frame?.content || {};
  let input = content.input && typeof content.input === 'object' ? content.input : {};
  let result = parseResult(content.preview);

  let body = typeof input.content === 'string' ? input.content : '';
  let who = actorLabel(input.actor);
  let channel = typeof input.channel === 'string' ? input.channel.trim() : '';
  let channelKnown = isSnowflake(channel);

  // Three outcomes the operator must be able to tell apart at a glance:
  // delivered, refused by policy, and authorised-but-undeliverable.
  let outcome = 'unknown';
  if (result) {
    if (result.sent === true && result.delivered === true)
      outcome = 'sent';
    else if (result.denied === true)
      outcome = 'denied';
    else if (result.sent === false)
      outcome = 'failed';
  } else if (content.phase === 'call') {
    // No result yet: this is the call half of the pair.
    outcome = 'pending';
  }

  // The message this reply answers. Inbound Discord messages are framed as
  // agentOnly and are deliberately absent from the thread, so without this the
  // reader sees replies to nothing. Absent or unreadable means "no quote", never a
  // placeholder: a card that invented a quotation would be worse than a bare one.
  let replyTo = null;
  let inbound = result?.replyTo;
  if (inbound && typeof inbound === 'object') {
    let quoted = typeof inbound.text === 'string' ? inbound.text.trim() : '';
    if (quoted !== '')
      replyTo = {
        author: typeof inbound.author === 'string' && inbound.author.trim() !== ''
          ? inbound.author.trim()
          : 'Discord',
        text: quoted,
        messageID: typeof inbound.messageID === 'string' ? inbound.messageID : '',
      };
  }

  return {
    outcome,
    replyTo,
    recipient: who,
    actor: typeof input.actor === 'string' ? input.actor : '',
    channel,
    channelKnown,
    body,
    messageID: typeof result?.messageID === 'string' ? result.messageID : '',
    reason: typeof result?.reason === 'string' ? result.reason : '',
    error: typeof result?.error === 'string' ? result.error : '',
  };
}

// One line for the collapsed card. Named separately from the element so the
// summary rules can be asserted in a plain unit test.
export function discordSendSummary(description) {
  if (!description)
    return 'Discord';

  let target = `Discord · ${description.recipient}`;

  switch (description.outcome) {
    case 'sent':
      return `${target} — sent`;
    case 'denied':
      return `${target} — refused by policy`;
    case 'failed':
      return `${target} — not delivered`;
    case 'pending':
      return `${target} — sending`;
    default:
      return target;
  }
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
// there keeps the pure helpers (describeDiscordSend / discordSendSummary) testable,
// and the element is only ever defined when customElements exists. Without this
// guard, importing the module throws ReferenceError: HTMLElement is not defined,
// which is the same trap todo-summary.mjs was split out to avoid.
const ElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

export class DiscordSendCard extends ElementBase {
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

    let description = describeDiscordSend(this._frame);
    let root = el(doc, 'div', `kikx-discord-send kikx-discord-send--${description.outcome}`);

    let head = el(doc, 'div', 'kikx-discord-send__head');
    head.appendChild(el(doc, 'span', 'kikx-discord-send__badge', 'Discord'));
    head.appendChild(el(doc, 'span', 'kikx-discord-send__recipient', description.recipient));
    if (description.channelKnown)
      head.appendChild(el(doc, 'span', 'kikx-discord-send__channel', `#${description.channel}`));
    root.appendChild(head);

    // Reads top-down as the conversation did: what they said, then what we sent.
    if (description.replyTo) {
      let reply = el(doc, 'div', 'kikx-discord-send__inbound');
      reply.appendChild(
        el(doc, 'span', 'kikx-discord-send__inbound-who', `replying to ${description.replyTo.author}`),
      );
      let quote = el(doc, 'blockquote', 'kikx-discord-send__inbound-text');
      quote.appendChild(el(doc, 'p', null, description.replyTo.text));
      reply.appendChild(quote);
      root.appendChild(reply);
    }

    // The quoted body is the point: the thread now shows WHAT was said to
    // Discord, and to whom, in the place where the reader is already looking.
    if (description.body !== '') {
      let quote = el(doc, 'blockquote', 'kikx-discord-send__quote');
      quote.appendChild(el(doc, 'p', null, description.body));
      root.appendChild(quote);
    }

    let note = '';
    if (description.outcome === 'denied')
      note = description.reason || 'The send was refused by policy.';
    else if (description.outcome === 'failed')
      note = description.error || 'Discord accepted the request but did not return a message id.';
    else if (description.outcome === 'sent' && description.messageID !== '')
      note = `message ${description.messageID}`;

    if (note !== '')
      root.appendChild(el(doc, 'div', 'kikx-discord-send__note', note));

    this.textContent = '';
    this.appendChild(root);
  }
}

// Registering twice is a no-op; registering the same constructor under two tag
// names is a hard error, and that error would abort evaluation of the whole
// module the client imports. Stay defensive, exactly as built-in-tool-uses.mjs
// documents the hazard.
export function defineDiscordSendCard(tagName = 'kikx-discord-send-card', registry = globalThis.customElements) {
  if (!registry)
    return null;
  if (registry.get(tagName))
    return registry.get(tagName);
  registry.define(tagName, DiscordSendCard);
  return DiscordSendCard;
}

if (typeof globalThis.customElements !== 'undefined')
  defineDiscordSendCard();
