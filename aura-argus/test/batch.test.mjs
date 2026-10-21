import test from 'node:test';
import assert from 'node:assert/strict';

import { searchBatch } from '../src/lib/router.mjs';

test('searchBatch preserves input order and isolates bad items', async () => {
  const results = await searchBatch(['量子计算机 A', '', '量子计算机 C'], { cache: false, fallback: false, concurrency: 2 });
  assert.equal(results.length, 3);
  assert.equal(results[0].mode, 'none');
  assert.equal(results[2].mode, 'none');
  assert.equal(results[1].mode, 'error');
  assert.equal(results[1].error.code, 'BAD_REQUEST');
});

test('searchBatch accepts a single string', async () => {
  const results = await searchBatch('量子计算机', { cache: false, fallback: false });
  assert.equal(results.length, 1);
  assert.equal(results[0].mode, 'none');
});

test('searchBatch runs all items with bounded concurrency', async () => {
  const results = await searchBatch(['A', 'B', 'C', 'D'], { cache: false, fallback: false, concurrency: 3 });
  assert.deepEqual(results.map((result) => result.mode), ['none', 'none', 'none', 'none']);
});
