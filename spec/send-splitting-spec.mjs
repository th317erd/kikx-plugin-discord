'use strict';

// The split must be REACHABLE from the real tool, not merely correct in isolation.
//
// message-split-spec.mjs proves the splitter itself. That would still pass if
// index.mjs forgot to call it -- which is exactly the shape of defect this whole
// session keeps finding: a correct piece nobody enters. So this file drives the
// registered `discord:send` tool through execute(), the same entry point core
// uses, and asserts on the requests that actually leave.
//
// What must hold:
//   1. Every chunk is under Discord's limit and they arrive in order, so the whole
//      reply lands.
//   2. Nothing is dropped across the requests: the posted bodies together carry the
//      original content.
//   3. A partial send is not reported as success. If the third message 400s, the
//      result must say sent-with-a-gap rather than `delivered: true`.
//   4. A short reply is still exactly one request -- the fix must not spam a
//      one-line answer as several messages.

import assert from 'node:assert/strict';
import test from 'node:test';

import { setup } from '../index.mjs';

const TOKEN = 'fake-bot-token';
const CHANNEL = '1471361561955143773';

function fakeRegistry() {
  let tools = new Map();

  class PluginInterface {
    static pluginID = 'unknown';
    static riskLevel = 'none';
    constructor(context) { this.context = context; }
    async execute(params = {}) { return await this._execute(params); }
  }

  return {
    registerTool(name, ToolClass) { tools.set(name, ToolClass); return ToolClass; },
    getTool: (name) => tools.get(name) || null,
    getTools: () => new Map(tools),
    getFrameComponents: () => new Map(),
    getToolComponents: () => new Map(),
    registerClass() {},
    getClass: (name) => (name === 'PluginInterface'
      ? PluginInterface
      : name === 'FrameTypeUserMessage'
        ? class FrameTypeUserMessage {}
        : null),
    registerAgentProvider() {},
  };
}

function buildTool() {
  let registry = fakeRegistry();

  let provide = (callback) => callback({
    context: { has: () => false, require: () => null },
    registry,
    mountHttp: () => {},
    authorize: async () => ({ allowed: true }),
    db: () => ({
      one: async () => null,
      query: async () => ({ rows: [] }),
    }),
    registerMigrations: () => {},
    appendToSession: async () => ({}),
    appendFrame: async () => ({}),
    appendToSessionQuietly: async () => ({}),
    readConfig: async () => TOKEN,
  });

  setup(provide);

  let ToolClass = registry.getTool('discord:send');
  assert.ok(ToolClass, 'discord:send must be registered');
  return ToolClass;
}

// Records every outgoing request and replies with a synthetic message id.
// `failOnIndex` makes one request fail, to prove a partial send is reported.
function recordingFetch({ failOnIndex = null } = {}) {
  let requests = [];
  let fetchImpl = async (url, init = {}) => {
    let index = requests.length;
    let body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method: init.method, body });

    if (failOnIndex !== null && index === failOnIndex)
      return {
        ok: false,
        status: 400,
        text: async () => '{"message":"Bad Request","code":50035}',
        json: async () => ({}),
      };

    return { ok: true, status: 200, json: async () => ({ id: `msg-${index}` }) };
  };
  return { fetchImpl, requests };
}

async function runTool(ToolClass, params, fetchImpl) {
  let tool = new ToolClass({});
  let originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await tool.execute(params);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function contentOf(text) {
  return text.replace(/\s+/g, '');
}

test('a short reply makes exactly ONE request, unchanged', async () => {
  let ToolClass = buildTool();
  let { fetchImpl, requests } = recordingFetch();

  let result = await runTool(ToolClass, { channel: CHANNEL, content: 'one short line' }, fetchImpl);

  assert.equal(requests.length, 1, 'a short reply must not be split');
  assert.equal(requests[0].body.content, 'one short line');
  assert.equal(result.sent, true);
  assert.equal(result.delivered, true);
  assert.equal(result.chunks, 1);
  assert.equal(result.messageID, 'msg-0');
});

test('a long reply is posted in order, every part under the limit, nothing dropped', async () => {
  let ToolClass = buildTool();
  let { fetchImpl, requests } = recordingFetch();

  // Paragraphs, so the splitter has natural breaks to use.
  let paragraphs = [];
  for (let i = 0; i < 40; i += 1)
    paragraphs.push(`Part ${i} ` + 'w'.repeat(150));
  let text = paragraphs.join('\n\n');
  assert.ok(text.length > 2000, 'fixture must exceed one Discord message');

  let result = await runTool(ToolClass, { channel: CHANNEL, content: text }, fetchImpl);

  assert.ok(requests.length > 1, 'an over-limit reply must be split across requests');
  assert.equal(requests[0].method, 'POST');

  for (let request of requests) {
    assert.ok(request.body.content.length > 0, 'no request may carry an empty body');
    assert.ok(request.body.content.length <= 2000,
      `a request carried ${request.body.content.length} characters, over Discord's limit`);
  }

  // Order is preserved, which is what makes the pieces readable in the channel.
  assert.equal(contentOf(requests.map((request) => request.body.content).join('')), contentOf(text),
    'the posted bodies must together carry the whole reply');

  assert.equal(result.sent, true);
  assert.equal(result.delivered, true);
  assert.equal(result.chunks, requests.length);
  assert.equal(result.deliveredChunks, requests.length);
  assert.equal(result.messageIDs.length, requests.length,
    'every posted message id must be reported, so a caller can see the split');
});

test('a partial send reports the gap instead of claiming success', async () => {
  let ToolClass = buildTool();
  // Fail the SECOND request: the first message did land.
  let { fetchImpl, requests } = recordingFetch({ failOnIndex: 1 });

  let paragraphs = [];
  for (let i = 0; i < 40; i += 1)
    paragraphs.push(`Part ${i} ` + 'v'.repeat(150));
  let text = paragraphs.join('\n\n');

  let result = await runTool(ToolClass, { channel: CHANNEL, content: text }, fetchImpl);

  assert.equal(requests.length, 2, 'the send must stop at the failed request');
  assert.equal(result.status, 400);
  assert.equal(result.delivered, undefined, 'a partial send must not report delivered: true');
  assert.equal(result.sent, true, 'some text did land, so sent is true');
  assert.equal(result.deliveredChunks, 1);
  assert.ok(result.chunks > 1);
  assert.match(result.error, /Bad Request|50035/);
});

test('an empty reply is refused rather than posting a blank message', async () => {
  let ToolClass = buildTool();
  let { fetchImpl, requests } = recordingFetch();

  let result = await runTool(ToolClass, { channel: CHANNEL, content: '' }, fetchImpl);

  assert.equal(requests.length, 0, 'nothing may be posted for empty content');
  assert.equal(result.sent, false);
  assert.match(result.error, /empty/);
});
