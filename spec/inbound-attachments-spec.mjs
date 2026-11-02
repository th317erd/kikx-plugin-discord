'use strict';

// A pasted screenshot with no caption must not vanish.
//
// MEASURED DEFECT (inbound-router.mjs:220):
//
//     content = content.trim();
//     if (!content) return { handled: false, reason: 'empty_content_missing_intent' };
//
// `grep -n 'attachments\|embeds' inbound-router.mjs index.mjs` returns ZERO hits.
// The router never looks at data.attachments. So:
//
//   * An image-only message (the common case: drag a screenshot in, hit enter, add
//     no text) has empty content and is dropped at that line with a reason that
//     says "missing intent" -- blaming the MESSAGE_CONTENT intent for what is
//     actually a missing attachment reader. The owner will hit this the first day
//     he pastes a screenshot into #miri.
//   * A CAPTIONED image is worse in a quieter way: it IS delivered, but the frame
//     text is only the caption, so a message that says "see above" with a screenshot
//     attached reaches the agent as "see above" and nothing else. The agent is told
//     an image exists without being given any access to it.
//
// WHAT THIS FILE LOCKS DOWN:
//   1. An image-only message is DELIVERED, not dropped.
//   2. The frame text names the attachment, with its URL, so the agent can fetch it.
//   3. A captioned message keeps its caption AND gains the attachment line.
//   4. The missing-intent reason survives for a message that genuinely has nothing
//      -- no text and no attachments -- because that is still the honest answer.
//   5. Stickers/embeds are named too, for the same reason as attachments: an embed
//      the agent cannot see is a message half-delivered.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordInboundRouter } from '../inbound-router.mjs';

const BOT_ID = '255524600249581568';
const CHANNEL = '1471361561955143773';
const SESSION = '54e1c081-b4fc-46bf-ae9a-c82e19784a19';
const AUTHOR = { id: '255524600249581569', username: 'th317erd' };

// A router with everything the MESSAGE_CREATE path touches satisfied, and an
// appendFrame that records what would have been written.
function makeRouter() {
  let frames = [];

  // appendFrame, findChannelSession and authorizeInbound are CONSTRUCTOR
  // requirements (inbound-router.mjs:51-55) -- deliberately not assignable after
  // construction, so this fixture must supply them here.
  let router = new DiscordInboundRouter({
    botToken: 'test-token',
    log: () => {},
    db: () => ({ one: async () => null, query: async () => ({ rows: [] }) }),
    appendFrame: async (sessionID, payload) => {
      frames.push({ sessionID, ...payload });
      return { id: 'frame-1' };
    },
    findChannelSession: async () => ({ session_id: SESSION }),
    // Authorization is not the subject here; the deny path has its own spec.
    authorizeInbound: async () => ({ allowed: true }),
  });

  router.botUserID = () => BOT_ID;
  router.seenMessage = async () => false;

  return { router, frames };
}

function message(overrides = {}) {
  return {
    id: '1567000000000000001',
    channel_id: CHANNEL,
    author: AUTHOR,
    type: 0,
    content: '',
    ...overrides,
  };
}

async function deliver(router, data) {
  return await router.handle('MESSAGE_CREATE', data);
}

function textOf(frames) {
  return frames.map((frame) => frame.text).join('\n');
}

test('an image-only message is delivered instead of dropped', async () => {
  let { router, frames } = makeRouter();

  let result = await deliver(router, message({
    content: '',
    attachments: [ {
      id: '1',
      filename: 'screenshot.png',
      content_type: 'image/png',
      size: 184320,
      url: 'https://cdn.discordapp.com/attachments/1/2/screenshot.png',
      width: 1280,
      height: 720,
    } ],
  }));

  assert.equal(result.handled, true,
    'an image-only message must be framed; got reason: ' + result.reason);
  assert.equal(frames.length, 1);

  let text = textOf(frames);
  assert.match(text, /screenshot\.png/, 'the frame text must name the attachment');
  assert.match(text, /https:\/\/cdn\.discordapp\.com\/attachments\//,
    'the frame text must carry the URL so the agent can fetch the file');
});

test('a captioned image keeps the caption and gains the attachment line', async () => {
  let { router, frames } = makeRouter();

  let result = await deliver(router, message({
    content: 'what is wrong with this layout?',
    attachments: [ {
      filename: 'layout.png',
      content_type: 'image/png',
      url: 'https://cdn.discordapp.com/attachments/3/4/layout.png',
    } ],
  }));

  assert.equal(result.handled, true);

  let text = textOf(frames);
  assert.match(text, /what is wrong with this layout\?/, 'the caption must survive');
  assert.match(text, /layout\.png/, 'the attachment must be named as well');
  // The caption comes first: the human's words are the message, the file is context.
  assert.ok(text.indexOf('what is wrong') < text.indexOf('layout.png'),
    'the caption must precede the attachment description');
});

test('a message with neither text nor attachments still reports the honest reason', async () => {
  // The regression guard: the fix must not turn "nothing to frame" into "frame an
  // empty message", which would be a different silent failure.
  let { router, frames } = makeRouter();

  let result = await deliver(router, message({ content: '   ', attachments: [] }));

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'empty_content_missing_intent');
  assert.equal(frames.length, 0, 'nothing may be framed when there is nothing to frame');
});

test('an embed the agent cannot see is named rather than silently dropped', async () => {
  let { router, frames } = makeRouter();

  let result = await deliver(router, message({
    content: '',
    embeds: [ { title: 'Deploy failed', description: 'build 1291 exited 1', url: 'https://ci.example/1291' } ],
  }));

  assert.equal(result.handled, true,
    'an embed-only message must be framed; got reason: ' + result.reason);

  let text = textOf(frames);
  assert.match(text, /Deploy failed/, 'the embed title must reach the frame text');
  assert.match(text, /https:\/\/ci\.example\/1291/, 'the embed url must reach the frame text');
});

test('a sticker-only message is delivered', async () => {
  let { router, frames } = makeRouter();

  let result = await deliver(router, message({
    content: '',
    sticker_items: [ { id: '7', name: 'thumbsup', format_type: 1 } ],
  }));

  assert.equal(result.handled, true,
    'a sticker-only message must be framed; got reason: ' + result.reason);
  assert.match(textOf(frames), /thumbsup/, 'the sticker name must reach the frame text');
});

test('several attachments are all named, in order', async () => {
  let { router, frames } = makeRouter();

  await deliver(router, message({
    content: 'two shots',
    attachments: [
      { filename: 'first.png', url: 'https://cdn.example/first.png' },
      { filename: 'second.png', url: 'https://cdn.example/second.png' },
    ],
  }));

  let text = textOf(frames);
  assert.ok(text.indexOf('first.png') < text.indexOf('second.png'),
    'attachments must be listed in the order Discord sent them');
});
