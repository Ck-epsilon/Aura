import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createClient, ArgusClientError } from '../src/client.mjs';
import { startServer } from '../src/lib/server.mjs';

async function fixture() {
  const docs = http.createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>Slow page</h1><p>slow content</p></body></html>');
      }, 300);
      return;
    }
    if (req.url === '/docs') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Fixture docs</title></head><body><h1>Deploy guide</h1><p>fixture deploy steps alpha beta gamma for the release.</p></body></html>');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });
  await new Promise((resolve) => docs.listen(0, '127.0.0.1', resolve));
  const docsPort = docs.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-client-'));
  const sitesFile = path.join(dir, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({
    sites: {
      fixtureclient: {
        aliases: ['fixtureclient'],
        sources: [{
          url: `http://127.0.0.1:${docsPort}/docs`,
          title: 'Fixture docs',
          covers: ['fixtureclient', 'deploy', 'alpha', 'beta', 'gamma'],
        }],
      },
    },
  }), 'utf8');
  const argus = await startServer({ port: 0, allowPrivate: true, sitesFile });
  return { docs, argus, dir, docsUrl: `http://127.0.0.1:${docsPort}/docs` };
}

test('client covers health, search, batch, fetch and bearer auth', async () => {
  const { docs, argus, dir, docsUrl } = await fixture();
  try {
    const client = createClient({ baseUrl: argus.url, timeoutMs: 15_000 });
    const health = await client.aura_argus_health();
    assert.equal(health.ok, true);
    assert.equal(health.name, 'aura-argus');

    const result = await client.aura_argus_search('fixtureclient deploy', { maxSources: 1, fallback: false });
    assert.equal(result.entity, 'fixtureclient');
    assert.ok(result.evidence.length > 0);
    assert.match(result.evidence[0].passages[0].citation, /#deploy-guide$/);

    const batch = await client.aura_argus_search_batch(['fixtureclient deploy', 'fixtureclient alpha'], {
      maxSources: 1,
      fallback: false,
    });
    assert.equal(batch.results.length, 2);
    assert.equal(batch.results[0].entity, 'fixtureclient');

    const doc = await client.aura_argus_fetch(docsUrl);
    assert.match(doc.text, /Deploy guide/);

    const impatient = createClient({ baseUrl: argus.url, timeoutMs: 20 });
    await assert.rejects(
      impatient.aura_argus_fetch(docsUrl.replace('/docs', '/slow')),
      (error) => error instanceof ArgusClientError && error.code === 'TIMEOUT',
    );
  } finally {
    argus.server.close();
    docs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('client surfaces HTTP errors with code and status', async () => {
  const { docs, argus, dir } = await fixture();
  try {
    const authed = await startServer({ port: 0, allowPrivate: true, sitesFile: path.join(dir, 'sites.json'), token: 'secret' });
    try {
      const client = createClient({ baseUrl: authed.url, token: 'wrong' });
      await assert.rejects(
        client.aura_argus_sources(),
        (error) => error instanceof ArgusClientError && error.status === 401 && error.code === 'UNAUTHORIZED',
      );
    } finally {
      authed.server.close();
    }
  } finally {
    argus.server.close();
    docs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
