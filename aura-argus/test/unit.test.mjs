import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeEntities, collapse, htmlToLines, htmlToMarkdown, extractTitle, extractLinks, extractXmlLocs } from '../src/lib/text.mjs';
import { mergeBlocks, selectPassages } from '../src/lib/extract.mjs';
import { validateUrl } from '../src/lib/fetch.mjs';
import { ArgusError, CODES } from '../src/lib/errors.mjs';
import { matchEntity, expandTerms, listEntities, registryVersion, rankSources } from '../src/lib/registry.mjs';
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
  const entities = listEntities();
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
