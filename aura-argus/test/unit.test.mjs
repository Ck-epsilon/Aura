import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeEntities, collapse, htmlToLines, htmlToMarkdown, extractTitle, extractLinks, extractXmlLocs } from '../src/lib/text.mjs';
import { buildChunks, mergeBlocks, selectPassages, slugifyHeading } from '../src/lib/extract.mjs';
import { validateUrl } from '../src/lib/fetch.mjs';
import { ArgusError, CODES } from '../src/lib/errors.mjs';
import { matchEntity, expandTerms, listEntities, registryVersion, rankSources } from '../src/lib/registry.mjs';
import { normalizeSite } from '../src/lib/fallback.mjs';
import { isHubSource } from '../src/lib/router.mjs';
import { Cache } from '../src/lib/cache.mjs';

test('entity decoding and collapse', () => {
  assert.equal(decodeEntities('a&amp;b&#39;c&#x4e2d;'), "a&b'c中");
  assert.equal(collapse('  a \n\t b  '), 'a b');
});

test('html to lines keeps block boundaries', () => {
  const lines = htmlToLines('<h1>Title</h1><p>One</p><p>Two</p>');
  assert.deepEqual(lines, ['Title', 'One', 'Two']);
});

test('html to markdown emits headings and lists', () => {
  const md = htmlToMarkdown('<h2>Sub</h2><p>Body <a href="https://x.test">link</a></p><ul><li>item</li></ul>');
  assert.match(md, /^## Sub/m);
  assert.match(md, /\[link\]\(https:\/\/x\.test\)/);
  assert.match(md, /- item/);
});

test('markdown preserves code indentation and table cell boundaries', () => {
  const md = htmlToMarkdown('<pre><code>if (x) {\n  y()\n}</code></pre><table><tr><td>QPS</td><td>100</td></tr></table>');
  assert.match(md, /```\nif \(x\) \{\n  y\(\)\n\}/);
  assert.match(md, /QPS \| 100 \|/);
});

test('site scope normalizes domains and rejects invalid values', () => {
  assert.equal(normalizeSite('https://www.docs.example.com/path'), 'docs.example.com');
  assert.equal(normalizeSite('docs.example.com'), 'docs.example.com');
  assert.equal(normalizeSite(null), null);
  assert.throws(() => normalizeSite('not a domain'), (error) => error.code === 'BAD_REQUEST');
});

test('expanded registry routes new official entities', () => {
  assert.equal(matchEntity('TypeScript 泛型')?.id, 'typescript');
  assert.equal(matchEntity('Next.js app router')?.id, 'nextjs');
  assert.equal(matchEntity('Stripe webhook')?.id, 'stripe');
  assert.equal(matchEntity('Git rebase')?.id, 'git');
  assert.ok(listEntities({ sites: false }).length >= 40);
  assert.ok(listEntities().length > listEntities({ sites: false }).length);
});

test('title, links and sitemap locs', () => {
  assert.equal(extractTitle('<title>  Hello &amp; World </title>'), 'Hello & World');
  const links = extractLinks('<a href="/a">A</a><a href="javascript:void(0)">B</a>', 'https://x.test/root');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://x.test/a');
  assert.deepEqual(extractXmlLocs('<url><loc>https://a</loc></url><url><loc>https://b</loc></url>'), ['https://a', 'https://b']);
});

test('mergeBlocks joins tables and key/list blocks', () => {
  const blocks = mergeBlocks(['API QPS Limit', 'Search', '100', 'Fetch', '25']);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /100/);
  const list = mergeBlocks(['formats :', '- html', '- json']);
  assert.match(list[0], /formats/);
  assert.match(list[0], /json/);
});

test('selectPassages finds the numeric row', () => {
  const lines = ['intro', 'API QPS Limit', 'Search', '100', 'Fetch', '25', 'more text'];
  const passages = selectPassages(lines, new Set(['qps', 'limit']));
  assert.ok(passages.length > 0);
  assert.match(passages.map((p) => p.text).join(' '), /100/);
});
test('buildChunks keeps code lines addressable', () => {
  const chunks = buildChunks(['Intro text', '```', 'fs.readFile(path, cb)', '```']);
  assert.ok(chunks.some((chunk) => chunk.text.includes('fs.readFile')));
});

test('buildChunks tracks headings and chunk kinds', () => {
  const chunks = buildChunks(['# Install', 'Run this command to install the package.', '```', 'npm i pkg', '```', '| a | b |', '| 1 | 2 |']);
  assert.equal(chunks.find((chunk) => chunk.kind === 'heading').text, '# Install');
  assert.equal(chunks.find((chunk) => chunk.kind === 'code').heading, 'Install');
  assert.ok(chunks.some((chunk) => chunk.kind === 'table'));
});

test('buildChunks exposes heading paths, anchors and source lines', () => {
  assert.equal(slugifyHeading('Chained Promises (then/catch)'), 'chained-promises-thencatch');
  const chunks = buildChunks([
    '# Using promises',
    '## Chained Promises',
    'Returning a value from then() lets the chain continue with the next handler.',
    '## Chained Promises',
    'A second section with the same heading gets a numeric anchor.',
  ]);
  const prose = chunks.filter((chunk) => chunk.kind === 'prose');
  assert.equal(prose[0].headingPath, 'Using promises > Chained Promises');
  assert.equal(prose[0].anchor, 'chained-promises');
  assert.equal(prose[0].startLine, 3);
  assert.equal(prose[1].anchor, 'chained-promises-2');
});

test('expandTerms adds intent phrases for Chinese questions', () => {
  const postgres = expandTerms('PostgreSQL 怎么创建表？');
  assert.ok(postgres.has('create table'));
  const mysql = expandTerms('MySQL InnoDB 的事务隔离级别有哪些？');
  assert.ok(mysql.has('transaction isolation level'));
  assert.ok(mysql.has('isolation'));
  const node = expandTerms('Node.js fs 模块怎么读文件？');
  assert.ok([...node].some((term) => term.toLowerCase() === 'readfile'));
  const cypress = expandTerms('Cypress 怎么等待元素出现？');
  assert.ok(cypress.has('wait'));
  assert.ok(cypress.has('element'));
  const pytest = expandTerms('pytest 怎么参数化测试？');
  const istio = expandTerms('Istio 怎么配置流量路由？');
  assert.ok(istio.has('traffic'));
  const actions = expandTerms('GitHub Actions 的 workflow 文件放在哪里？');
  assert.ok(actions.has('path'));
  const mongo = expandTerms('MongoDB 怎么创建索引？');
  assert.ok(mongo.has('collection'));
  const sqlite = expandTerms('SQLite 的 WAL 模式怎么开启？');
  assert.ok(sqlite.has('pragma'));
  const retirement = expandTerms('必应搜索 API 退役时间');
  assert.ok(retirement.has('2025'));
});

test('selectPassages keeps specific API terms in evidence', () => {
  const lines = [
    'This module section documents the general module behavior for every caller in the system.',
    'The module supports many file related options and flags for advanced users of the library.',
    'fs.readFile(path, options, callback) reads the entire file asynchronously and calls back.',
    'Another module paragraph explains how the module is loaded and configured by the runtime.',
    'The module documentation lists every exported function and option in a long table.',
  ];
  const passages = selectPassages(lines, new Set(['fs', 'readfile', 'module', 'file']));
  assert.match(passages.map((passage) => passage.text).join(' '), /readFile/);
});

test('selectPassages keeps the matched sentence in a long paragraph', () => {
  const filler = 'Filler sentence without any answer. '.repeat(30);
  const line = `${filler}The API QPS limit is 100 requests per second.`;
  const passages = selectPassages([line], new Set(['qps', 'limit']));
  assert.match(passages.map((passage) => passage.text).join(' '), /100 requests per second/);
});

test('selectPassages does not repeat an overlapping window', () => {
  const repeated = 'The deployment checklist requires two approvals before a release is promoted.';
  const lines = [repeated, repeated, repeated, 'Unrelated notes about something else entirely. '.repeat(2)];
  const passages = selectPassages(lines, new Set(['deployment', 'checklist']));
  assert.equal(passages.filter((passage) => /deployment checklist/.test(passage.text)).length, 1);
});

test('validateUrl rejects non-http and credentials', () => {
  assert.equal(validateUrl('https://example.com/a').hostname, 'example.com');
  for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'https://user:pass@example.com', 'not a url']) {
    assert.throws(() => validateUrl(bad), (error) => error instanceof ArgusError && error.code === CODES.BAD_URL);
  }
});

test('registry matches aliases and expands terms', () => {
  assert.equal(matchEntity('DeepSeek 的搜索 API 多少钱')?.id, 'deepseek');
  assert.equal(matchEntity('深度求索 的价格')?.id, 'deepseek');
  assert.equal(matchEntity('SearXNG 429')?.id, 'searxng');
  assert.equal(matchEntity('量子计算机退相干') , null);
  const terms = expandTerms('SearXNG 冷却 时间 429');
  assert.ok(terms.has('suspended'));
  assert.ok(terms.has('429'));
  assert.ok(terms.has('冷却'));
});

test('registry shape is valid', () => {
  const entities = listEntities({ sites: false });
  assert.ok(entities.length >= 10, 'expected at least 10 entities');
  assert.match(registryVersion, /^[0-9a-f]{12}$/);
  const seen = new Set();
  for (const entity of entities) {
    assert.ok(entity.aliases.length > 0, `${entity.id} has aliases`);
    assert.ok(entity.sources.length > 0, `${entity.id} has sources`);
    for (const url of entity.sources) {
      assert.match(url, /^https:\/\//, `${entity.id} source is https`);
      assert.ok(!seen.has(url), `duplicate source ${url}`);
      seen.add(url);
    }
  }
});

test('rankSources puts better cover matches first', () => {
  const entity = matchEntity('SearXNG 429 冷却') ;
  const ranked = rankSources(entity, expandTerms('SearXNG 429 冷却'));
  assert.ok(ranked[0].score >= ranked[ranked.length - 1].score);
});

test('rankSources rewards an authored URL for a specific facet', () => {
  const entity = matchEntity('Ollama 怎么拉取模型？');
  const ranked = rankSources(entity, expandTerms('Ollama 怎么拉取模型？'));
  assert.match(ranked[0].url, /\/api\/pull/);
  const mistral = matchEntity('Mistral API 怎么计费？');
  const pricing = rankSources(mistral, expandTerms('Mistral API 怎么计费？'))
    .find((source) => source.url.includes('pricing'));
  if (pricing) assert.ok(pricing.score >= 2);
});

test('cache respects ttl and disk round-trip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cache-'));
  try {
    const cache = new Cache({ dir, ttlMs: 60_000 });
    assert.equal(cache.get('a'), undefined);
    cache.set('a', { value: 1 });
    assert.deepEqual(cache.get('a'), { value: 1 });
    const reloaded = new Cache({ dir, ttlMs: 60_000 });
    assert.deepEqual(reloaded.get('a'), { value: 1 });
    const short = new Cache({ dir, ttlMs: 1 });
    short.set('b', { value: 2 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(short.get('b'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cache key is stable and collision-free', () => {
  assert.equal(Cache.key(['a', 1]), Cache.key(['a', 1]));
  assert.notEqual(Cache.key(['a', 1]), Cache.key(['a', 2]));
});

test('selectPassages prefers currency amounts for price questions', () => {
  const lines = [
    'Get started for free with 1,000 API credits every month and no credit card required.',
    '## Pay As You Go',
    '$0.008 / credit for flexible usage and pay only for what you use.',
  ];
  const passages = selectPassages(lines, new Set(['pricing', 'price', 'credit']));
  assert.match(passages.map((passage) => passage.text).join(' '), /\$0\.008/);
});

test('isHubSource detects parent-path index pages only', () => {
  const sources = [
    { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference' },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise' },
    { url: 'https://example.test/guide' },
  ];
  assert.equal(isHubSource(sources[0], sources), true);
  assert.equal(isHubSource(sources[1], sources), false);
  assert.equal(isHubSource(sources[2], sources), false);
  assert.equal(isHubSource({ url: 'https://example.test/' }, sources), true);
});
