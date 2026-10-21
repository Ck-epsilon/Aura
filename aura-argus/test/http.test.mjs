import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchDocument, fetchRaw } from '../src/lib/fetch.mjs';
import { startServer } from '../src/lib/server.mjs';
import { CODES } from '../src/lib/errors.mjs';

async function fixtureServer() {
  let flaky = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Fixture Page</title></head><body><h1>Hello</h1><p>World paragraph.</p><ul><li>One</li></ul></body></html>');
      return;
    }
    if (url.pathname === '/long') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<p>${'x'.repeat(5000)}</p>`);
      return;
    }
    if (url.pathname === '/binary') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('PDF');
      return;
    }
    if (url.pathname === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":1}');
      return;
    }
    if (url.pathname === '/flaky') {
      flaky += 1;
      if (flaky <= 2) {
        res.writeHead(503, { 'retry-after': '0', 'content-type': 'text/plain' });
        res.end('busy');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>ok</p>');
      return;
    }
    if (url.pathname === '/always-503') {
      res.writeHead(503, { 'retry-after': '0', 'content-type': 'text/plain' });
      res.end('busy');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

test('fetchDocument extracts title and markdown', async () => {
  const { server, base } = await fixtureServer();
  try {
    const doc = await fetchDocument(`${base}/page`, { allowPrivate: true });
    assert.equal(doc.title, 'Fixture Page');
    assert.match(doc.text, /^# Hello/m);
    assert.match(doc.text, /World paragraph/);
    assert.match(doc.text, /- One/);
    assert.equal(doc.truncated, false);
  } finally {
    server.close();
  }
});

test('fetchDocument truncates and flags it', async () => {
  const { server, base } = await fixtureServer();
  try {
    const doc = await fetchDocument(`${base}/long`, { maxChars: 100, allowPrivate: true });
    assert.equal(doc.truncated, true);
    assert.equal(doc.chars, 100);
  } finally {
    server.close();
  }
});

test('fetchRaw retries transient 503 and reports tries', async () => {
  const { server, base } = await fixtureServer();
  try {
    const page = await fetchRaw(`${base}/flaky`, { retries: 2, retryBaseMs: 10, retryMaxMs: 20, totalTimeoutMs: 5000, allowPrivate: true });
    assert.equal(page.status, 200);
    assert.equal(page.tries, 3);
  } finally {
    server.close();
  }
});

test('fetchRaw does not retry a 404', async () => {
  const { server, base } = await fixtureServer();
  try {
    await assert.rejects(
      fetchRaw(`${base}/missing`, { retries: 2, retryBaseMs: 10, totalTimeoutMs: 5000, allowPrivate: true }),
      (error) => error.code === CODES.HTTP_ERROR && error.details.status === 404 && error.details.tries === 1,
    );
  } finally {
    server.close();
  }
});

test('fetchRaw exhausts retries and reports tries', async () => {
  const { server, base } = await fixtureServer();
  try {
    await assert.rejects(
      fetchRaw(`${base}/always-503`, { retries: 2, retryBaseMs: 10, retryMaxMs: 20, totalTimeoutMs: 5000, allowPrivate: true }),
      (error) => error.code === CODES.HTTP_ERROR && error.details.status === 503 && error.details.tries === 3,
    );
  } finally {
    server.close();
  }
});

test('fetchDocument rejects binary and 404', async () => {
  const { server, base } = await fixtureServer();
  try {
    await assert.rejects(fetchDocument(`${base}/binary`, { allowPrivate: true }), (error) => error.code === CODES.UNSUPPORTED_CONTENT_TYPE);
    await assert.rejects(fetchDocument(`${base}/missing`, { allowPrivate: true }), (error) => error.code === CODES.HTTP_ERROR);
  } finally {
    server.close();
  }
});

test('fetchDocument returns raw JSON text', async () => {
  const { server, base } = await fixtureServer();
  try {
    const doc = await fetchDocument(`${base}/json`, { format: 'text', allowPrivate: true });
    assert.equal(doc.text, '{"a":1}');
  } finally {
    server.close();
  }
});

test('http server: health, auth, sources, fetch, 400 and 404', async () => {
  const fixture = await fixtureServer();
  const { server, url } = await startServer({ port: 0, host: '127.0.0.1', token: 'secret', allowPrivate: true });
  try {
    const health = await fetch(`${url}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.name, 'aura-argus');

    const unauthorized = await fetch(`${url}/sources`);
    assert.equal(unauthorized.status, 401);

    const sources = await fetch(`${url}/sources`, { headers: { authorization: 'Bearer secret' } }).then((r) => r.json());
    assert.ok(sources.entities.length >= 10);

    const fetched = await fetch(`${url}/fetch?url=${encodeURIComponent(`${fixture.base}/page`)}`, {
      headers: { authorization: 'Bearer secret' },
    }).then((r) => r.json());
    assert.equal(fetched.ok, true);
    assert.equal(fetched.title, 'Fixture Page');

    const missingQuestion = await fetch(`${url}/search`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(missingQuestion.status, 400);

    const emptyBatch = await fetch(`${url}/search/batch`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(emptyBatch.status, 400);

    const batch = await fetch(`${url}/search/batch`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ questions: ['量子计算机 A', '量子计算机 B'], fallback: false, cache: false }),
    }).then((response) => response.json());
    assert.equal(batch.ok, true);
    assert.equal(batch.results.length, 2);
    assert.deepEqual(batch.results.map((result) => result.mode), ['none', 'none']);

    const notFound = await fetch(`${url}/nope`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(notFound.status, 404);
  } finally {
    server.close();
    fixture.server.close();
  }
});
