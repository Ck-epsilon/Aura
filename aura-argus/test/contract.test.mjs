import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { search } from '../src/lib/router.mjs';
import { CODES } from '../src/lib/errors.mjs';

test('search result preserves the stable schemaVersion 1 contract', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
    res.end('<html><head><title>Contract fixture</title></head><body><h1>Contract fixture</h1><p>fixturecontract release checklist and rollout steps for the contract test.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-contract-'));
  const sitesFile = path.join(dir, 'sites.json');
  fs.writeFileSync(sitesFile, JSON.stringify({
    sites: {
      fixturecontract: {
        aliases: ['fixturecontract'],
        sources: [{
          url: `http://127.0.0.1:${port}/docs`,
          title: 'Contract fixture',
          covers: ['fixturecontract', 'release', 'checklist'],
        }],
      },
    },
  }), 'utf8');
  try {
    const result = await search('fixturecontract release checklist', {
      cache: false,
      fallback: false,
      sitesFile,
      allowPrivate: true,
      maxSources: 1,
    });
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.question, 'fixturecontract release checklist');
    assert.equal(result.entity, 'fixturecontract');
    assert.ok(Array.isArray(result.entities));
    assert.equal(result.entities[0].id, 'fixturecontract');
    assert.equal(result.mode, 'registry');
    assert.ok(result.evidence.length > 0);
    const evidence = result.evidence[0];
    for (const field of ['url', 'title', 'site', 'origin', 'passages']) assert.ok(field in evidence, `missing evidence.${field}`);
    assert.ok(evidence.passages.length > 0);
    assert.equal(typeof evidence.passages[0].text, 'string');
    assert.equal(typeof evidence.passages[0].score, 'number');
    assert.equal(evidence.updated, 'Wed, 21 Oct 2026 07:28:00 GMT');
    assert.ok(result.attempts.length > 0);
    assert.equal(result.attempts[0].ok, true);
    assert.ok('cache' in result.attempts[0]);
    assert.equal(typeof result.confidence.score, 'number');
    assert.equal(typeof result.facets.ratio, 'number');
    assert.equal(typeof result.timings.totalMs, 'number');
    assert.equal(result.version, null);
    assert.equal(typeof result.tookMs, 'number');
    assert.equal(result.cached, false);
    assert.equal(result.cache, 'none');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-coverage results keep the contract and ABORTED is a stable code', async () => {
  const result = await search('量子计算机的退相干时间是多少？', { cache: false, fallback: false, sites: false });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.entity, null);
  assert.equal(result.mode, 'none');
  assert.deepEqual(result.evidence, []);
  assert.equal(result.version, null);
  assert.equal(result.confidence.score, 0);
  assert.equal(CODES.ABORTED, 'ABORTED');
});
