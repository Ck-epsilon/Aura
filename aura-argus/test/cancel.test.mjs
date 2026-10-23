import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchRaw } from '../src/lib/fetch.mjs';
import { search, searchBatch } from '../src/lib/router.mjs';

function slowServer(delayMs = 2000) {
  return http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><p>slow response</p></body></html>');
    }, delayMs);
  });
}

test('fetchRaw aborts on an external signal without retrying', async () => {
  const server = slowServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('test abort')), 50);
  const started = Date.now();
  try {
    await assert.rejects(
      fetchRaw(`http://127.0.0.1:${port}/slow`, {
        allowPrivate: true,
        retries: 0,
        timeoutMs: 5000,
        signal: controller.signal,
      }),
      (error) => error.code === 'ABORTED',
    );
    assert.ok(Date.now() - started < 1000);
  } finally {
    server.close();
  }
});

test('search and searchBatch honor an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    search('量子计算机的退相干时间是多少？', { signal: controller.signal, fallback: false, cache: false }),
    (error) => error.code === 'ABORTED',
  );
  const results = await searchBatch(['q1', 'q2'], {
    signal: controller.signal,
    fallback: false,
    sites: false,
    cache: false,
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.error?.code === 'ABORTED'));
});

test('searchBatch reports progress for every completed item', async () => {
  const events = [];
  const results = await searchBatch(['q1', 'q2'], {
    fallback: false,
    sites: false,
    cache: false,
    concurrency: 2,
    onProgress: (event) => events.push({ index: event.index, total: event.total }),
  });
  assert.equal(results.length, 2);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.total), [2, 2]);
});
