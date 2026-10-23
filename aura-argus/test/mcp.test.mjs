import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import http from 'node:http';

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
  input.write(rpc(3, 'tools/call', { name: 'aura_argus_sources', arguments: {} }));
  input.write(rpc(5, 'tools/call', { name: 'sources', arguments: {} }));
  input.write(rpc(4, 'does/not/exist'));
  await waitFor(lines, 5);
  input.end();
  await done;

  const byId = new Map(lines().map((message) => [message.id, message]));
  assert.equal(byId.get(1).result.serverInfo.name, 'aura-argus');
  assert.equal(byId.get(1).result.protocolVersion, '2024-11-05');
  assert.match(byId.get(1).result.instructions, /AuraArgus/);
  assert.doesNotMatch(byId.get(1).result.instructions, /mcp__/, 'instructions must stay client-agnostic');
  assert.ok(byId.get(2).result.tools.some((tool) => tool.name === 'aura_argus_search'));
  const batchTool = byId.get(2).result.tools.find((tool) => tool.name === 'aura_argus_search_batch');
  assert.equal(batchTool.inputSchema.properties.questions.maxItems, 20);
  assert.ok(byId.get(2).result.tools.some((tool) => tool.name === 'aura_argus_fetch'));
  const searchTool = byId.get(2).result.tools.find((tool) => tool.name === 'aura_argus_search');
  assert.equal(searchTool.annotations.readOnlyHint, true);
  assert.ok(searchTool.inputSchema.properties.multi);
  assert.ok(searchTool.inputSchema.properties.followLinks);
  assert.ok(searchTool.outputSchema.required.includes('evidence'));
  const sources = JSON.parse(byId.get(3).result.content[0].text);
  assert.ok(sources.entities.length >= 10);
  assert.match(sources.coverageVersion, /^[0-9a-f]{12}-/);
  assert.ok(sources.entities.some((entity) => entity.origin === 'default'));
  assert.equal(byId.get(3).result.structuredContent.entities.length, sources.entities.length);
  const legacySources = JSON.parse(byId.get(5).result.content[0].text);
  assert.equal(legacySources.entities.length, sources.entities.length);
  assert.equal(byId.get(4).error.code, -32601);
});

test('mcp exposes coverage and entity resources', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  const messages = () => buffer.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const done = runMcp({ input, output });

  input.write(rpc(41, 'initialize', { protocolVersion: '2025-06-18' }));
  input.write(rpc(42, 'resources/list'));
  input.write(rpc(43, 'resources/templates/list'));
  input.write(rpc(44, 'resources/read', { uri: 'argus://coverage' }));
  input.write(rpc(45, 'resources/read', { uri: 'argus://entity/react' }));
  input.write(rpc(46, 'resources/read', { uri: 'argus://missing' }));
  await waitFor(messages, 6);
  input.end();
  await done;

  const byId = new Map(messages().map((message) => [message.id, message]));
  assert.ok(byId.get(41).result.capabilities.resources);
  assert.ok(byId.get(42).result.resources.some((resource) => resource.uri === 'argus://coverage'));
  assert.equal(byId.get(43).result.resourceTemplates[0].uriTemplate, 'argus://entity/{id}');
  const coverage = JSON.parse(byId.get(44).result.contents[0].text);
  assert.ok(coverage.entities.some((entity) => entity.id === 'react'));
  assert.ok(coverage.sourceCount > 100);
  const entity = JSON.parse(byId.get(45).result.contents[0].text);
  assert.equal(entity.id, 'react');
  assert.ok(entity.sources.length > 0);
  assert.equal(byId.get(46).error.code, -32602);
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

test('mcp emits progress notifications and accepts cancellation notifications', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  const messages = () => buffer.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const done = runMcp({ input, output });

  input.write(rpc(21, 'initialize', { protocolVersion: '2025-06-18' }));
  input.write(rpc(22, 'tools/call', {
    name: 'aura_argus_search_batch',
    arguments: { questions: ['量子计算机的退相干时间是多少？'], sites: false, fallback: false },
    _meta: { progressToken: 'p1' },
  }));
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } }) + '\n');
  input.write(rpc(23, 'ping'));
  await waitFor(messages, 5);
  input.end();
  await done;

  const progress = messages().filter((message) => message.method === 'notifications/progress');
  assert.equal(progress.length, 2);
  assert.ok(progress.every((message) => message.params.progressToken === 'p1'));
  assert.deepEqual(progress.map((message) => message.params.progress), [0, 1]);
  const byId = new Map(messages().map((message) => [message.id, message]));
  assert.equal(byId.get(22).result.structuredContent.results.length, 1);
  assert.deepEqual(byId.get(23).result, {});
});

test('mcp cancels an in-flight fetch without sending a response', async () => {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><p>slow</p></body></html>');
    }, 600);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const previous = process.env.AURA_ARGUS_ALLOW_PRIVATE;
  process.env.AURA_ARGUS_ALLOW_PRIVATE = '1';
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  const messages = () => buffer.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const done = runMcp({ input, output });
  try {
    input.write(rpc(31, 'initialize', { protocolVersion: '2025-06-18' }));
    input.write(rpc(32, 'tools/call', { name: 'aura_argus_fetch', arguments: { url: `http://127.0.0.1:${port}/slow` } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 32 } }) + '\n');
    input.write(rpc(33, 'ping'));
    await waitFor(messages, 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    input.end();
    await done;
    const byId = new Map(messages().map((message) => [message.id, message]));
    assert.ok(byId.has(31));
    assert.ok(byId.has(33));
    assert.equal(byId.has(32), false);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.AURA_ARGUS_ALLOW_PRIVATE;
    else process.env.AURA_ARGUS_ALLOW_PRIVATE = previous;
  }
});
