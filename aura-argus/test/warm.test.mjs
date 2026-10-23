import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { warmSources } from '../src/lib/warm.mjs';
import { search } from '../src/lib/router.mjs';

test('warmSources fills the persistent page cache for later searches', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"w1"' });
    res.end('<html><head><title>Warm fixture</title></head><body><h1>Warm deploy guide</h1><p>The warm deploy guide covers deploy steps and rollout checks for the release.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-warm-'));
  const sitesFile = path.join(dir, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({
    sites: {
      fixturewarm: {
        aliases: ['fixturewarm'],
        sources: [{
          url: `http://127.0.0.1:${port}/docs`,
          title: 'Warm fixture',
          covers: ['fixturewarm', 'deploy', 'rollout'],
        }],
      },
    },
  }), 'utf8');

  try {
    const warmed = await warmSources({
      entities: ['fixturewarm'],
      maxSources: 1,
      allowPrivate: true,
      sitesFile,
      pageCacheDir: dir,
      pageCacheTtlMs: 60_000,
    });
    assert.equal(warmed.entities, 1);
    assert.equal(warmed.rows[0].ok, 1);
    assert.equal(hits, 1);

    const result = await search('fixturewarm deploy rollout', {
      cache: true,
      pageCacheDir: dir,
      pageCacheTtlMs: 60_000,
      memoryPageCache: false,
      allowPrivate: true,
      sitesFile,
      fallback: false,
      maxSources: 1,
    });
    assert.ok(result.evidence.length > 0);
    assert.equal(hits, 1, 'search should use the warmed page cache');
    assert.equal(result.attempts[0].cache, 'page');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
