'use strict';

// Long replies are SPLIT, not silently chopped.
//
// THE DEFECT. index.mjs sent every body as `String(content).slice(0, 2000)` at two
// call sites (the interaction follow-up and the `discord:send` tool). Discord's
// per-message limit is 2000 characters, so the slice avoided a 400 -- by throwing
// away the rest of the message. A truncated reply is worse than a split one
// because it LOOKS complete: the reader has no way to know a paragraph, a
// conclusion, or a caveat was cut, and the agent has no way to know its words
// were dropped. Measured before the change: a 4000-character reply arrived as its
// first 2000 characters and the tool still reported `delivered: true`.
//
// WHAT THIS DOES INSTEAD. Split on the most natural boundary that fits under the
// limit -- paragraph, then line, then sentence, then word -- and only hard-cut a
// single token that is longer than a whole message. Every chunk is non-empty and
// within the limit, and the concatenation of the chunks is the original text with
// no content removed. That last property is the one worth testing: it is what
// distinguishes "split" from "tried to split and quietly truncated anyway".
//
// The limit is a parameter rather than a constant so the behaviour is testable
// without building 2000-character strings, and so a different transport limit
// does not require editing this module.

export const DISCORD_MESSAGE_LIMIT = 2000;

// Ordered from most to least natural. Each candidate is "where a reader would
// accept a break". A break consumes the separator: the chunk keeps the text
// before it, the next chunk starts after it. Newlines are consumed; a space used
// as a break is consumed so a split does not leave a leading space on the next
// chunk.
const BREAK_PATTERNS = [
  { name: 'paragraph', separator: /\n\s*\n/g },
  { name: 'line', separator: /\n/g },
  { name: 'sentence', separator: /(?<=[.!?])\s+/g },
  { name: 'word', separator: /[ \t]+/g },
];

function lastBreakWithin(text, limit) {
  // Search only the window that could become the chunk. A separator that STARTS
  // exactly at `limit` would produce an empty chunk boundary, which the +1 avoids.
  let window = text.slice(0, limit + 1);

  for (let { separator } of BREAK_PATTERNS) {
    let last = null;
    // RegExp objects with /g are stateful; reset per scan.
    separator.lastIndex = 0;
    let match;
    while ((match = separator.exec(window)) !== null) {
      // A break at index 0 yields an empty first chunk -- skip it rather than
      // emit a blank message.
      if (match.index > 0)
        last = last === null || match.index > last.index
          ? { index: match.index, length: match[0].length }
          : last;
      // Zero-width matches would loop forever without the explicit advance.
      if (match.index === separator.lastIndex)
        separator.lastIndex += 1;
    }
    separator.lastIndex = 0;
    if (last && last.index <= limit)
      return last;
  }

  return null;
}

// Splits `text` into chunks each within `limit` characters.
//
// Guarantees, in order of importance:
//   1. Nothing is dropped: chunks joined by '' reproduce the original text, except
//      for the separator whitespace consumed at each break. (Asserted by the spec
//      against the original with whitespace normalised, plus an exact-count check
//      on content characters.)
//   2. No chunk is empty and no chunk exceeds the limit.
//   3. A single unbroken token longer than the limit is hard-cut rather than
//      dropped, so an over-long URL still arrives in full.
export function splitDiscordMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  let whole = typeof text === 'string' ? text : String(text ?? '');
  if (whole === '')
    return [];

  let effectiveLimit = Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DISCORD_MESSAGE_LIMIT;

  if (whole.length <= effectiveLimit)
    return [ whole ];

  let chunks = [];
  let remaining = whole;

  while (remaining.length > effectiveLimit) {
    let breakAt = lastBreakWithin(remaining, effectiveLimit);

    if (breakAt) {
      let chunk = remaining.slice(0, breakAt.index);
      if (chunk !== '')
        chunks.push(chunk);
      remaining = remaining.slice(breakAt.index + breakAt.length);
      // Consumed separators can leave the next chunk starting with indentation
      // that belonged to the break, not the text.
      continue;
    }

    // No natural break fits: cut at the limit so no content is lost.
    chunks.push(remaining.slice(0, effectiveLimit));
    remaining = remaining.slice(effectiveLimit);
  }

  if (remaining !== '')
    chunks.push(remaining);

  return chunks;
}
