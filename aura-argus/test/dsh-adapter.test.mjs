import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, createProviders, SEARCH_ID, FETCH_ID } from '../adapters/dsh/index.mjs';

const evidence = {
  evidence: [
    { url: 'https://docs.example/page', title: 'Example', passages: [{ text: 'a'.repeat(800), score: 9 }] },
  ],
};

test('search provider maps evidence to sources', async () => {
  const { searchProvider } = createProviders({ searchImpl: async () => evidence });
  assert.equal(searchProvider.id, SEARCH_ID);
  assert.equal(searchProvider.available(), true);
  const result = await searchProvider.search({ query: 'q', maxResults: 3 });
  assert.equal(result.truncated, false);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'https://docs.example/page');
  assert.equal(result.sources[0].title, 'Example');
  assert.equal(result.sources[0].snippet.length, 600);
});

test('search provider can mark snippets for verification', async () => {
  const { searchProvider } = createProviders({ config: { marker: true }, searchImpl: async () => evidence });
  const result = await searchProvider.search({ query: 'q' });
  assert.match(result.sources[0].snippet, /^\[aura-argus\] /);
});

test('search provider respects maxResults cap', async () => {
  let asked;
  const { searchProvider } = createProviders({
    config: { maxSources: 3 },
    searchImpl: async (query, options) => { asked = options.maxSources; return evidence; },
  });
  await searchProvider.search({ query: 'q', maxResults: 2 });
  assert.equal(asked, 2);
});

test('search provider surfaces ALL_SOURCES_FAILED as a web error', async () => {
  const { searchProvider } = createProviders({
    searchImpl: async () => ({ error: { code: 'ALL_SOURCES_FAILED', attempts: 2 }, evidence: [] }),
  });
  await assert.rejects(searchProvider.search({ query: 'q' }), (error) => error.code === 'WEB_PROVIDER_ERROR');
});

test('search provider wraps failures with a web code', async () => {
  const { searchProvider } = createProviders({ searchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(searchProvider.search({ query: 'q' }), (error) => error.code === 'WEB_PROVIDER_ERROR');
});

test('fetch provider maps a document to a DSH result', async () => {
  const { fetchProvider } = createProviders({
    fetchImpl: async () => ({ url: 'https://docs.example/page', finalUrl: 'https://docs.example/page', status: 200, text: '# Title', truncated: true }),
  });
  assert.equal(fetchProvider.id, FETCH_ID);
  const result = await fetchProvider.fetch({ url: 'https://docs.example/page' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.kind, 'text');
  assert.equal(result.body.content, '# Title');
  assert.equal(result.truncated, true);
});

test('fetch provider returns non-2xx as a result, not a throw', async () => {
  const { fetchProvider } = createProviders({
    fetchImpl: async () => {
      const error = new Error('HTTP 404');
      error.code = 'HTTP_ERROR';
      error.details = { status: 404 };
      throw error;
    },
  });
  const result = await fetchProvider.fetch({ url: 'https://docs.example/missing' });
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.content, '');
});

test('apply registers both providers on ctx.web', () => {
  const registered = [];
  const ctx = {
    web: {
      registerSearchProvider: (provider) => registered.push(['search', provider.id]),
      registerFetchProvider: (provider) => registered.push(['fetch', provider.id]),
    },
  };
  apply(ctx, {});
  assert.deepEqual(registered, [['search', SEARCH_ID], ['fetch', FETCH_ID]]);
});
