import test from 'node:test';
import assert from 'node:assert/strict';

import { search } from '../src/lib/router.mjs';

test('all sources failing yields ALL_SOURCES_FAILED with per-source attempts', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error('network down');
    error.cause = { code: 'ECONNRESET' };
    throw error;
  };
  try {
    const result = await search('SearXNG 对 429 的冷却时间是多少秒？', { cache: false });
    assert.equal(result.error?.code, 'ALL_SOURCES_FAILED');
    assert.equal(result.evidence.length, 0);
    assert.ok(result.attempts.length >= 2, 'expected every source to be attempted');
    assert.ok(result.attempts.every((attempt) => attempt.ok === false));
    assert.ok(result.attempts.every((attempt) => attempt.tries === 3), 'expected 3 tries per source');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
