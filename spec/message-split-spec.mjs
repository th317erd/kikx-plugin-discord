'use strict';

// A long reply must arrive WHOLE, in pieces, not silently halved.
//
// MEASURED DEFECT. Both send paths in index.mjs did
//   JSON.stringify({ content: String(x).slice(0, 2000) })
// so anything past Discord's 2000-character limit was discarded while the call
// still reported success. The agent believed it had answered; the human received
// a reply that stopped mid-thought with no marker. That is worse than a failure,
// because nothing anywhere reports it.
//
// The spec for the new behaviour has to prove the property that actually matters:
// the pieces together carry the whole message. Counting chunks alone would pass
// on an implementation that splits and still drops the tail.
//
// It also pins the two ordering claims, because a splitter that ignores them is
// technically lossless and still unpleasant to read: break at a paragraph before
// a line, a line before a sentence, a sentence before a word.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCORD_MESSAGE_LIMIT, splitDiscordMessage } from '../message-split.mjs';

function contentOf(text) {
  // Everything that is not whitespace, so a consumed break separator does not
  // read as lost content. This is the honest definition of "nothing was dropped":
  // whitespace at a break is the split, not the message.
  return text.replace(/\s+/g, '');
}

test('text within the limit is returned as exactly one unchanged chunk', () => {
  let text = 'short reply';
  assert.deepEqual(splitDiscordMessage(text, 2000), [ text ]);
});

test('empty input produces no chunks at all, not one empty message', () => {
  assert.deepEqual(splitDiscordMessage('', 2000), []);
  assert.deepEqual(splitDiscordMessage(null, 2000), []);
  assert.deepEqual(splitDiscordMessage(undefined, 2000), []);
});

test('a long reply is split with NOTHING dropped', () => {
  // 60 paragraphs of ~200 characters: comfortably past the limit at limit=500.
  let paragraphs = [];
  for (let i = 0; i < 60; i += 1)
    paragraphs.push(`Paragraph ${i} ` + 'x'.repeat(180));
  let text = paragraphs.join('\n\n');

  assert.ok(text.length > 4000, 'fixture must exceed the limit');

  let chunks = splitDiscordMessage(text, 500);

  assert.ok(chunks.length > 1, 'an over-limit message must produce more than one chunk');

  for (let chunk of chunks) {
    assert.ok(chunk.length > 0, 'no chunk may be empty');
    assert.ok(chunk.length <= 500, `chunk of ${chunk.length} exceeds the limit`);
  }

  // The property that separates splitting from truncation.
  assert.equal(
    contentOf(chunks.join('')),
    contentOf(text),
    'the chunks together must carry every content character of the original',
  );
});

test('it breaks at a paragraph boundary when one fits', () => {
  let first = 'a'.repeat(200);
  let second = 'b'.repeat(200);
  let text = first + '\n\n' + second;

  let chunks = splitDiscordMessage(text, 300);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], first, 'the first chunk must end at the paragraph break');
  assert.equal(chunks[1], second, 'the second chunk must start after the paragraph break');
});

test('it prefers a line break over a sentence break, and a sentence over a word', () => {
  // One paragraph, no blank line, but a line break that fits.
  let lineBreakText = 'a'.repeat(100) + '\n' + 'b'.repeat(100);
  let lineChunks = splitDiscordMessage(lineBreakText, 150);
  assert.equal(lineChunks[0], 'a'.repeat(100),
    'a line break must be preferred to splitting mid-word');

  // No line break; sentence breaks only.
  let sentenceText = 'a'.repeat(80) + '. ' + 'b'.repeat(80);
  let sentenceChunks = splitDiscordMessage(sentenceText, 120);
  assert.equal(sentenceChunks[0], 'a'.repeat(80) + '.',
    'a sentence break must be preferred to splitting mid-word');

  // No punctuation at all: the only usable break is a space.
  let wordText = 'word '.repeat(40).trim();
  let wordChunks = splitDiscordMessage(wordText, 100);
  for (let chunk of wordChunks)
    assert.ok(!/^\s|\s$/.test(chunk), 'a word split must not leave ragged whitespace');
});

test('a single unbroken token longer than the limit is cut, not dropped', () => {
  // An over-long URL or base64 blob has no break to use. Losing it would be the
  // original defect; hard-cutting keeps every character.
  let text = 'z'.repeat(1000);
  let chunks = splitDiscordMessage(text, 300);

  assert.equal(chunks.length, 4);
  for (let chunk of chunks)
    assert.ok(chunk.length <= 300);
  assert.equal(chunks.join(''), text, 'a hard cut must still lose nothing');
});

test('the shipped default limit is Discord\'s 2000 characters', () => {
  assert.equal(DISCORD_MESSAGE_LIMIT, 2000);
  let text = 'q'.repeat(2001);
  let chunks = splitDiscordMessage(text);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 2000));
  assert.equal(chunks.join(''), text);
});

test('a nonsense limit falls back to the real default instead of looping', () => {
  for (let bad of [ 0, -5, NaN, Infinity, 'lots' ]) {
    let text = 'k'.repeat(2001);
    let chunks = splitDiscordMessage(text, bad);
    assert.equal(chunks.join(''), text, `limit ${String(bad)} must not lose content`);
    assert.ok(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT));
  }
});
