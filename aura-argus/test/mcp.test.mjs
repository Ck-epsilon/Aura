import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { runMcp } from '../src/lib/mcp.mjs';

function rpc(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

async function waitFor(lines, count, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (lines().length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${count} responses (got ${lines().length})`);
}

test('mcp handshake, tools/list, tools/call, unknown method', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  const lines = () => buffer.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const done = runMcp({ input, output });

  input.write(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }));
  input.write(rpc(2, 'tools/list'));
  input.write(rpc(3, 'tools/call', { name: 'sources', arguments: {} }));
  input.write(rpc(4, 'does/not/exist'));
  await waitFor(lines, 4);
  input.end();
  await done;

  const byId = new Map(lines().map((message) => [message.id, message]));
  assert.equal(byId.get(1).result.serverInfo.name, 'aura-argus');
  assert.equal(byId.get(1).result.protocolVersion, '2024-11-05');
  assert.match(byId.get(1).result.instructions, /AuraArgus/);
  assert.doesNotMatch(byId.get(1).result.instructions, /mcp__/, 'instructions must stay client-agnostic');
  assert.ok(byId.get(2).result.tools.some((tool) => tool.name === 'search'));
  const batchTool = byId.get(2).result.tools.find((tool) => tool.name === 'search_batch');
  assert.equal(batchTool.inputSchema.properties.questions.maxItems, 20);
  assert.ok(byId.get(2).result.tools.some((tool) => tool.name === 'fetch'));
  const sources = JSON.parse(byId.get(3).result.content[0].text);
  assert.ok(sources.entities.length >= 10);
  assert.equal(byId.get(4).error.code, -32601);
});

test('mcp negotiates the requested protocol version and answers parse errors', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  const messages = () => buffer.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const done = runMcp({ input, output });

  input.write(rpc(11, 'initialize', { protocolVersion: '2025-06-18' }));
  input.write('this is not json\n');
  input.write(rpc(12, 'ping'));
  await waitFor(messages, 3);
  input.end();
  await done;

  const byId = new Map(messages().map((message) => [message.id, message]));
  assert.equal(byId.get(11).result.protocolVersion, '2025-06-18');
  const parseError = messages().find((message) => message.id === null && message.error?.code === -32700);
  assert.ok(parseError, 'expected a -32700 parse error with id null');
  assert.deepEqual(byId.get(12).result, {});
});
