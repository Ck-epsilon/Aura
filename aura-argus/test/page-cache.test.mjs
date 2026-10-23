import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { PageCache } from '../src/lib/page-cache.mjs';
import { fetchRaw } from '../src/lib/fetch.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pages-'));
}

function page(overrides = {}) {
  return {
    url: 'https://example.com/docs',
    finalUrl: 'https://example.com/docs',
    status: 200,
    contentType: 'text/html',
    text: '<p>hello</p>',
    bytes: 12,
    etag: '"v1"',
    lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    ...overrides,
  };
}

test('page cache stores, expires, touches and separates private pages', async () => {
  const dir = tempDir();
  try {
    const cache = new PageCache({ dir, ttlMs: 60_000 });
    assert.equal(cache.get('https://example.com/docs'), null);
    cache.set('https://example.com/docs', page());
    const hit = cache.get('https://example.com/docs');
    assert.equal(hit.fresh, true);
    assert.equal(hit.etag, '"v1"');
    assert.match(hit.page.text, /hello/);

    assert.equal(cache.get('https://example.com/docs', { allowPrivate: true }), null);
    cache.set('https://example.com/docs', page({ text: '<p>private</p>' }), { allowPrivate: true });
    assert.match(cache.get('https://example.com/docs', { allowPrivate: true }).page.text, /private/);
    assert.match(cache.get('https://example.com/docs').page.text, /hello/);

    const short = new PageCache({ dir, ttlMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(short.get('https://example.com/docs').fresh, false);
    short.touch('https://example.com/docs');
    assert.equal(short.get('https://example.com/docs').fresh, true);
    cache.clear();
    assert.equal(cache.get('https://example.com/docs'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchRaw sends validators and reports 304', async () => {
  const server = http.createServer((req, res) => {
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' });
    res.end('<html><body><p>hello</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const url = `http://127.0.0.1:${port}/docs`;
    const first = await fetchRaw(url, { allowPrivate: true, retries: 0 });
    assert.equal(first.status, 200);
    assert.equal(first.etag, '"v1"');
    assert.match(first.text, /hello/);

    const second = await fetchRaw(url, { allowPrivate: true, retries: 0, validators: { etag: first.etag } });
    assert.equal(second.notModified, true);
    assert.equal(second.status, 304);
    assert.equal(second.text, '');
  } finally {
    server.close();
  }
});
