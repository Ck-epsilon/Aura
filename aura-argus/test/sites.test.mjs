import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { getCoverage, listEntities, matchEntity } from '../src/lib/registry.mjs';
import { loadSites } from '../src/lib/sites.mjs';
import { search } from '../src/lib/router.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sites-'));
}

function writeSites(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}

test('default site pack adds mainland-direct entities and CN fallback sources', () => {
  const coverage = getCoverage();
  assert.ok(coverage.entities.aliyun, 'expected aliyun');
  assert.ok(coverage.entities['wechat-miniprogram'], 'expected wechat-miniprogram');
  assert.ok(coverage.entities.qwen, 'expected qwen');
  assert.equal(matchEntity('阿里云 ECS 实例规格', coverage)?.id, 'aliyun');
  assert.equal(matchEntity('微信小程序怎么获取手机号', coverage)?.id, 'wechat-miniprogram');
  assert.equal(matchEntity('Kimi API 价格', coverage)?.id, 'moonshot');

  const go = coverage.entities.go;
  const mirror = go.sources.find((source) => source.url === 'https://golang.google.cn/doc/');
  assert.ok(mirror, 'expected Go CN mirror');
  assert.equal(mirror.fallback, true);
  assert.equal(mirror.origin, 'default');
  assert.equal(go.origin, 'registry+default');

  const strict = getCoverage({ sites: false });
  assert.equal(strict.entities.aliyun, undefined);
  assert.equal(strict.entities.go.sources.length, 1);
  assert.ok(listEntities({ sites: false }).length >= 49);
});

test('user sites merge sources, add entities and disable defaults', () => {
  const dir = tempDir();
  try {
    const file = writeSites(dir, 'sites.json', {
      sites: {
        'team-wiki': {
          aliases: ['团队 wiki', 'team wiki'],
          sources: [{ url: 'https://wiki.example.test/docs', title: 'Team Wiki', covers: ['deploy', '发布'] }],
        },
        go: {
          sources: [{ url: 'https://example.test/go', title: 'Custom Go notes', covers: ['goroutine'], fallback: true }],
        },
        aliyun: { disabled: true },
      },
    });
    const coverage = getCoverage({ sitesFile: file });
    assert.equal(matchEntity('团队 wiki 怎么发布', coverage)?.id, 'team-wiki');
    assert.equal(coverage.entities.aliyun, undefined);
    assert.equal(coverage.entities['team-wiki'].origin, 'user');
    assert.deepEqual(coverage.entities['team-wiki'].sources.map((source) => source.url), ['https://wiki.example.test/docs']);

    const goUrls = coverage.entities.go.sources.map((source) => source.url);
    assert.ok(goUrls.includes('https://go.dev/doc/'));
    assert.ok(goUrls.includes('https://golang.google.cn/doc/'));
    assert.ok(goUrls.includes('https://example.test/go/') || goUrls.includes('https://example.test/go'));
    assert.equal(coverage.entities.go.origin, 'registry+default+user');
    assert.notEqual(coverage.version, getCoverage({ sites: false }).version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('user sites accept the entities key and env-provided path', () => {
  const dir = tempDir();
  try {
    const file = writeSites(dir, 'entities.json', {
      entities: {
        'internal-docs': {
          aliases: ['内部文档'],
          sources: [{ url: 'https://docs.example.test/', covers: ['deploy'] }],
        },
      },
    });
    const coverage = getCoverage({ env: { AURA_ARGUS_SITES: file } });
    assert.ok(coverage.entities['internal-docs']);
    assert.equal(matchEntity('内部文档在哪', coverage)?.id, 'internal-docs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit missing or invalid sites files are rejected', () => {
  const dir = tempDir();
  try {
    const missing = path.join(dir, 'missing.json');
    assert.throws(() => loadSites({ file: missing }), (error) => error.code === 'BAD_REQUEST');

    const badJson = writeSites(dir, 'bad.json', '{ nope');
    assert.throws(() => loadSites({ file: badJson }), (error) => error.code === 'BAD_REQUEST');

    const emptySources = writeSites(dir, 'empty.json', { sites: { empty: { aliases: ['empty'], sources: [] } } });
    assert.throws(() => loadSites({ file: emptySources }), (error) => error.code === 'BAD_REQUEST');

    const badScheme = writeSites(dir, 'scheme.json', {
      sites: { bad: { aliases: ['bad'], sources: [{ url: 'ftp://example.test/doc' }] } },
    });
    assert.throws(() => loadSites({ file: badScheme }), (error) => error.code === 'BAD_REQUEST');

    const duplicate = writeSites(dir, 'duplicate.json', {
      sites: {
        one: { aliases: ['one'], sources: [{ url: 'https://dup.example.test/doc' }] },
        two: { aliases: ['two'], sources: [{ url: 'https://dup.example.test/doc' }] },
      },
    });
    assert.throws(() => loadSites({ file: duplicate }), (error) => error.code === 'BAD_REQUEST');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AURA_ARGUS_NO_SITES disables built-in and user sites', () => {
  const coverage = getCoverage({ env: { AURA_ARGUS_NO_SITES: '1' } });
  assert.equal(coverage.entities.aliyun, undefined);
  assert.equal(coverage.entities.go.sources.length, 1);
  assert.equal(coverage.sitesVersion, 'disabled');
});

test('fallback source is tried only after primary evidence is empty', async () => {
  const originalFetch = globalThis.fetch;
  const html = `<html><head><title>Goroutines</title></head><body><h1>Goroutine scheduling</h1><p>${'The Go runtime schedules goroutines on operating-system threads and multiplexes many goroutines onto a small number of threads. '.repeat(3)}</p></body></html>`;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('go.dev')) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    if (String(url).includes('golang.google.cn')) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('unexpected', { status: 500, headers: { 'content-type': 'text/plain' } });
  };
  try {
    const result = await search('Go 的 goroutine 调度模型', { cache: false });
    assert.equal(result.entity, 'go');
    assert.ok(result.evidence.length > 0, 'expected fallback evidence');
    assert.equal(result.note, 'fallback-source');
    assert.ok(calls.some((url) => url.includes('go.dev')));
    assert.ok(calls.some((url) => url.includes('golang.google.cn')));
    const failed = result.attempts.find((attempt) => attempt.url.includes('go.dev'));
    const used = result.attempts.find((attempt) => attempt.url.includes('golang.google.cn'));
    assert.equal(failed.ok, false);
    assert.equal(failed.fallback, undefined);
    assert.equal(used.ok, true);
    assert.equal(used.fallback, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('primary evidence skips fallback sources', async () => {
  const originalFetch = globalThis.fetch;
  const html = `<html><head><title>Go docs</title></head><body><h1>Goroutine scheduling</h1><p>${'The Go runtime schedules goroutines on operating-system threads. '.repeat(4)}</p></body></html>`;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  try {
    const result = await search('Go 的 goroutine 调度模型', { cache: false });
    assert.ok(result.evidence.length > 0);
    assert.equal(result.note, undefined);
    assert.ok(calls.every((url) => !url.includes('golang.google.cn')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('custom private sites require allowPrivate opt-in', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Internal Deploy</title></head><body><h1>Internal Deploy Checklist</h1><p>Use the internal deploy checklist before promoting a release to production.</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const dir = tempDir();
  try {
    const file = writeSites(dir, 'sites.json', {
      sites: {
        'fixture-private': {
          aliases: ['fixtureprivate'],
          sources: [{ url: `http://127.0.0.1:${port}/docs`, title: 'Internal', covers: ['deploy', 'checklist'] }],
        },
      },
    });
    const blocked = await search('fixtureprivate internal deploy checklist', { sitesFile: file, cache: false });
    assert.equal(blocked.evidence.length, 0);
    assert.equal(blocked.error?.code, 'ALL_SOURCES_FAILED');
    assert.equal(blocked.attempts[0].error, 'PRIVATE_ADDRESS');

    const allowed = await search('fixtureprivate internal deploy checklist', { sitesFile: file, cache: false, allowPrivate: true });
    assert.ok(allowed.evidence.length > 0);
    assert.equal(allowed.entity, 'fixture-private');
    assert.equal(allowed.entityOrigin, 'user');
    assert.equal(allowed.evidence[0].origin, 'user');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('site pack version is stable across CRLF and LF', () => {
  const json = JSON.stringify({ sites: { fixture: { aliases: ['fixture'], sources: [{ url: 'https://example.com/docs', covers: ['docs'] }] } } }, null, 2);
  const dir = tempDir();
  try {
    const lf = writeSites(dir, 'lf.json', json);
    const crlf = writeSites(dir, 'crlf.json', json.replace(/\n/g, '\r\n'));
    assert.equal(loadSites({ file: lf, env: {} }).version, loadSites({ file: crlf, env: {} }).version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
