import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { parseBing, parseDuckDuckGo, parse360, webSearch } from '../src/lib/web-search.mjs';
import { webFallback } from '../src/lib/fallback.mjs';
import { search as auraSearch } from '../src/lib/router.mjs';

function base64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('web search parsers extract URLs and snippets', () => {
  const target = 'https://docs.docker.com/reference/compose-file/services/';
  const bing = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${base64Url(target)}">Docker services</a></h2><p class="b_lineclamp4">healthcheck test</p></li>`;
  assert.equal(parseBing(bing)[0].url, target);
  assert.match(parseBing(bing)[0].snippet, /healthcheck/);

  const ddg = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}">Docker</a><a class="result__snippet">healthcheck snippet</a></div>`;
  assert.equal(parseDuckDuckGo(ddg)[0].url, target);

  const so360 = `<li class="res-list"><h3 class="res-title"><a data-mdurl="${target}">Docker services</a></h3><p class="res-desc">healthcheck test</p></li>`;
  assert.equal(parse360(so360)[0].url, target);
});

async function fixture() {
  const docs = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Widget docs</title></head><body><h1>Widget deploy</h1><p>Use the widget deploy checklist before shipping to production.</p></body></html>');
  });
  await new Promise((resolve) => docs.listen(0, '127.0.0.1', resolve));
  const docsUrl = `http://127.0.0.1:${docs.address().port}/docs`;
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('format'), 'json');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ url: docsUrl, title: 'Widget docs', content: 'Widget deploy checklist' }] }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  return { docs, docsUrl, provider };
}

test('webFallback uses a self-hosted SearXNG provider and fetches page evidence', async () => {
  const { docs, docsUrl, provider } = await fixture();
  const previous = process.env.AURA_ARGUS_SEARXNG_URL;
  process.env.AURA_ARGUS_SEARXNG_URL = `http://127.0.0.1:${provider.address().port}`;
  try {
    const found = await webSearch('widget deploy', { allowPrivate: true });
    assert.equal(found.provider, 'searxng');
    assert.equal(found.results[0].url, docsUrl);

    const evidence = await webFallback('widget deploy', { allowPrivate: true, timeoutMs: 5000 });
    assert.ok(evidence.length > 0);
    assert.equal(evidence[0].origin, 'web-fallback');
    assert.equal(evidence[0].provider, 'searxng');
    assert.match(evidence[0].passages.map((passage) => passage.text).join(' '), /deploy checklist/);
    assert.match(evidence[0].passages[0].citation, /#widget-deploy$/);
  } finally {
    if (previous === undefined) delete process.env.AURA_ARGUS_SEARXNG_URL;
    else process.env.AURA_ARGUS_SEARXNG_URL = previous;
    provider.close();
    docs.close();
  }
});

test('search uses the web fallback when explicitly requested for an uncovered question', async () => {
  const { docs, provider } = await fixture();
  const previous = process.env.AURA_ARGUS_SEARXNG_URL;
  process.env.AURA_ARGUS_SEARXNG_URL = `http://127.0.0.1:${provider.address().port}`;
  try {
    const result = await auraSearch('widget deploy', {
      fallback: true,
      allowPrivate: true,
      sites: false,
      cache: false,
    });
    assert.equal(result.mode, 'web-fallback');
    assert.ok(result.evidence.length > 0);
    assert.equal(result.evidence[0].origin, 'web-fallback');
    assert.equal(result.fallback.officialSources, 0);
    assert.equal(result.fallback.webSources, result.evidence.length);
  } finally {
    if (previous === undefined) delete process.env.AURA_ARGUS_SEARXNG_URL;
    else process.env.AURA_ARGUS_SEARXNG_URL = previous;
    provider.close();
    docs.close();
  }
});
