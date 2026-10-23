import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { search } from '../src/lib/router.mjs';

test('search reuses the persistent page cache and revalidates with ETag', async () => {
  let hits = 0;
  const html = `<html><head><title>Fixture docs</title></head><body>
    <h1>Fixture deploy guide</h1>
    <p>${'The fixture deploy guide covers alpha, beta and gamma steps for a release. '.repeat(3)}</p>
  </body></html>`;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"', 'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-router-cache-'));
  const sitesFile = path.join(dir, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({
    sites: {
      fixturelocal: {
        aliases: ['fixturelocal'],
        sources: [{
          url: `http://127.0.0.1:${port}/docs`,
          title: 'Fixture docs',
          covers: ['fixturelocal', 'alpha', 'beta', 'gamma', 'deploy'],
        }],
      },
    },
  }), 'utf8');

  const options = {
    cache: true,
    pageCacheDir: dir,
    pageCacheTtlMs: 60_000,
    memoryPageCache: false,
    allowPrivate: true,
    sitesFile,
    fallback: false,
    maxSources: 1,
  };

  try {
    const first = await search('fixturelocal alpha deploy', options);
    assert.ok(first.evidence.length > 0);
    assert.equal(hits, 1);
    assert.equal(first.attempts[0].cache, 'miss');
    assert.equal(first.evidence[0].updated, 'Wed, 21 Oct 2026 07:28:00 GMT');
    const citation = first.evidence[0].passages[0];
    assert.equal(citation.id.length, 12);
    assert.equal(citation.sourceId, first.evidence[0].id);
    assert.match(citation.citation, /#fixture-deploy-guide$/);
    assert.equal(citation.anchorType, 'heading-slug');

    const second = await search('fixturelocal beta deploy', { ...options, cache: true });
    assert.ok(second.evidence.length > 0);
    assert.equal(hits, 1, 'fresh disk page should avoid a second request');
    assert.equal(second.attempts[0].cache, 'page');

    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = await search('fixturelocal gamma deploy', {
      ...options,
      pageCacheTtlMs: 1,
      cache: true,
    });
    assert.ok(third.evidence.length > 0);
    assert.equal(hits, 2, 'stale page should revalidate with ETag');
    assert.equal(third.attempts[0].cache, 'page-revalidated');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
