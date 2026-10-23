import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { buildIndex, buildDeepIndex, searchIndex } from '../src/lib/index-store.mjs';
import { search } from '../src/lib/router.mjs';

test('buildIndex creates sections and fast search reuses them without network', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Fixture deploy</title></head><body><h1>Fixture deploy guide</h1><p>fixtureindex release production: the deploy checklist and rollout steps are required before promoting a release to production.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-index-'));
  const sitesFile = path.join(dir, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({
    sites: {
      fixtureindex: {
        aliases: ['fixtureindex'],
        sources: [{
          url: `http://127.0.0.1:${port}/docs`,
          title: 'Fixture deploy',
          covers: ['fixtureindex', 'deploy', 'rollout'],
        }],
      },
    },
  }), 'utf8');

  try {
    const built = await buildIndex({
      entities: ['fixtureindex'],
      maxSources: 1,
      allowPrivate: true,
      sitesFile,
      indexDir: dir,
      pageCacheDir: dir,
      env: {},
    });
    assert.equal(built.entities, 1);
    assert.ok(built.sections > 0);
    assert.equal(hits, 1);

    const indexed = searchIndex({
      entity: { id: 'fixtureindex' },
      terms: new Set(['fixtureindex', 'deploy', 'rollout']),
      indexDir: dir,
    });
    assert.ok(indexed.evidence.length > 0);
    assert.match(indexed.evidence[0].passages[0].text, /deploy checklist|rollout/);
    assert.match(indexed.evidence[0].updated, /^\d{4}-\d{2}-\d{2}T/);

    const fast = await search('fixtureindex release production', {
      fast: true,
      indexDir: dir,
      cache: false,
      sitesFile,
      allowPrivate: true,
      fallback: false,
      maxSources: 1,
    });
    assert.equal(fast.cache, 'index');
    assert.ok(fast.evidence.length > 0);
    assert.equal(hits, 1, 'fast search must not fetch pages');

    const misses = path.join(dir, 'empty-index');
    const live = await search('fixtureindex release production', {
      fast: true,
      indexDir: misses,
      cache: false,
      sitesFile,
      allowPrivate: true,
      fallback: false,
      maxSources: 1,
    });
    assert.notEqual(live.cache, 'index');
    assert.ok(live.evidence.length > 0);
    assert.equal(hits, 2, 'missing index should fall back to live retrieval');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildIndex reuses a fresh index and revalidates changed sources with ETag', async () => {
  let hits = 0;
  let notModified = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.headers['if-none-match'] === '"v1"') {
      notModified += 1;
      res.writeHead(304, { etag: '"v1"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' });
    res.end('<html><head><title>Fixture incremental</title></head><body><h1>Incremental guide</h1><p>incrementalindex deploy checklist and rollout steps for production releases.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-index-incremental-'));
  const sitesFile = path.join(dir, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({
    sites: {
      incrementalindex: {
        aliases: ['incrementalindex'],
        sources: [{
          url: `http://127.0.0.1:${port}/docs`,
          title: 'Fixture incremental',
          covers: ['incrementalindex', 'deploy', 'rollout'],
        }],
      },
    },
  }), 'utf8');
  const base = {
    entities: ['incrementalindex'],
    maxSources: 1,
    allowPrivate: true,
    sitesFile,
    indexDir: dir,
    env: {},
  };
  try {
    const first = await buildIndex({ ...base, pageCacheDir: dir });
    assert.equal(hits, 1);
    const entityFile = path.join(dir, 'entities', 'incrementalindex.json');
    const record = JSON.parse(fs.readFileSync(entityFile, 'utf8'));
    record.builtAt = Date.now() - 48 * 60 * 60_000;
    fs.writeFileSync(entityFile, JSON.stringify(record), 'utf8');

    const second = await buildIndex({ ...base, pageCacheDir: path.join(dir, 'cache2') });
    assert.equal(hits, 2, 'stale index should revalidate the source');
    assert.equal(notModified, 1);
    assert.equal(second.notModifiedSources, 1);
    assert.equal(second.updatedSources, 0);
    assert.ok(second.sections > 0);

    const third = await buildIndex({ ...base, pageCacheDir: path.join(dir, 'cache3') });
    assert.equal(hits, 2, 'fresh rebuilt index should be reused without a request');
    assert.equal(third.reused, 1);
    assert.equal(third.notModifiedSources, 0, 'a reused index makes no conditional requests');
    assert.equal(first.sections, third.sections);

    const forced = await buildIndex({
      ...base,
      pageCacheDir: path.join(dir, 'cache4'),
      incremental: false,
    });
    assert.equal(hits, 3, '--no-incremental must fetch instead of reusing the previous index');
    assert.equal(notModified, 1, '--no-incremental must not send previous validators');
    assert.equal(forced.updatedSources, 1);
    assert.equal(forced.reused, 0);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildDeepIndex follows same-host links when no sitemap exists', async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/deep') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Deep guide</title></head><body><h1>Deep fixture</h1><p>fixturedeep satisfies operator usage is documented here with the exact syntax.</p></body></html>');
      return;
    }
    if (url.pathname === '/docs') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Fixture home</title></head><body><h1>Fixture docs</h1><a href="/deep">Deep fixture guide</a><p>fixturedeep documentation index.</p></body></html>');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-index-deep-'));
  const sitesFile = path.join(dir, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({
    sites: {
      fixturedeep: {
        aliases: ['fixturedeep'],
        sources: [{ url: `http://127.0.0.1:${port}/docs`, title: 'Fixture docs', covers: ['fixturedeep', 'satisfies'] }],
      },
    },
  }), 'utf8');
  try {
    const built = await buildDeepIndex({
      entities: ['fixturedeep'],
      maxPages: 5,
      maxDepth: 1,
      allowPrivate: true,
      sitesFile,
      indexDir: dir,
      pageCacheDir: dir,
      env: {},
    });
    assert.equal(built.deep, true);
    assert.ok(built.sections > 0);
    const indexed = searchIndex({
      entity: { id: 'fixturedeep' },
      terms: new Set(['fixturedeep', 'satisfies', 'operator']),
      indexDir: dir,
    });
    assert.ok(indexed.evidence.length > 0);
    assert.match(indexed.evidence[0].passages[0].text, /satisfies/);

    const second = await buildDeepIndex({
      entities: ['fixturedeep'],
      maxPages: 5,
      maxDepth: 1,
      allowPrivate: true,
      sitesFile,
      indexDir: dir,
      pageCacheDir: dir,
      env: {},
    });
    assert.equal(second.reused, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('searchIndex returns null when the entity has no index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-index-empty-'));
  try {
    assert.equal(searchIndex({ entity: { id: 'missing' }, terms: ['x'], indexDir: dir }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
