import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  aura_argus_fetch_document,
  aura_argus_search,
  aura_argus_search_batch,
  aura_argus_sources,
  fetchDocument,
  search,
  searchBatch,
} from '../src/core.mjs';
import { API_NAMES } from '../src/lib/api-names.mjs';
import { createClient } from '../src/client.mjs';

test('canonical aura_argus API names are exported', () => {
  assert.equal(typeof aura_argus_search, 'function');
  assert.equal(typeof aura_argus_search_batch, 'function');
  assert.equal(typeof aura_argus_fetch_document, 'function');
  assert.equal(typeof aura_argus_sources, 'function');
  assert.deepEqual(API_NAMES, {
    search: 'aura_argus_search',
    searchBatch: 'aura_argus_search_batch',
    fetch: 'aura_argus_fetch',
    sources: 'aura_argus_sources',
    health: 'aura_argus_health',
  });
});

test('function schemas use canonical names', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../schema/tools.json', import.meta.url), 'utf8'));
  const names = Object.values(schema.tools).flat().map((tool) => tool.function?.name || tool.name);
  for (const name of names) assert.match(name, /^aura_argus_/);
});

test('client exposes canonical aura_argus methods', () => {
  const client = createClient({ baseUrl: 'http://127.0.0.1:1', fetch: async () => new Response('{}') });
  for (const name of Object.values(API_NAMES)) {
    assert.equal(typeof client[name], 'function', `${name} should be a function`);
  }
  assert.equal(client.aura_argus_search, client.search);
  assert.equal(client.aura_argus_fetch, client.fetch);
});

test('legacy library names remain aliases, not a second implementation', () => {
  assert.equal(search, aura_argus_search);
  assert.equal(searchBatch, aura_argus_search_batch);
  assert.equal(fetchDocument, aura_argus_fetch_document);
});
