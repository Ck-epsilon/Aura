import test from 'node:test';
import assert from 'node:assert/strict';

import { modePreset, search } from '../src/lib/router.mjs';

test('modePreset exposes fast, balanced and deep presets', () => {
  const fast = modePreset('fast');
  assert.equal(fast.mode, 'fast');
  assert.equal(fast.maxSources, 2);
  assert.equal(fast.followLinks, false);
  assert.equal(fast.fast, true);
  const deep = modePreset('deep');
  assert.equal(deep.maxSources, 6);
  assert.equal(deep.adaptive, false);
  assert.equal(deep.decompose, true);
  assert.equal(deep.maxFollowLinks, 2);
  assert.equal(modePreset('unknown'), null);
});

test('search returns partial evidence when the wall-clock budget is exhausted', async () => {
  const result = await search('Redis 默认端口是多少？', {
    cache: false,
    fallback: false,
    budgetMs: 1,
  });
  assert.equal(result.partial, true);
  assert.equal(result.budget.limitMs, 1);
  assert.equal(result.budget.exhausted, true);
  assert.ok(result.budget.usedMs >= 1);
  assert.equal(result.evidence.length, 0);
  assert.match(result.note, /budget-exhausted/);
  assert.match(result.next.hint, /budget exhausted/);
});

test('balanced mode is reported on the result', async () => {
  const result = await search('Redis 默认端口是多少？', {
    mode: 'balanced',
    cache: false,
    fallback: false,
    budgetMs: 1,
  });
  assert.equal(result.searchMode, 'balanced');
  assert.equal(result.partial, true);
});

test('decomposition shares the parent wall-clock budget', async () => {
  const result = await search('DeepSeek 的 API 多少钱？QPS 上限是多少？', {
    decompose: true,
    cache: false,
    fallback: false,
    budgetMs: 1,
  });
  assert.equal(result.partial, true);
  assert.equal(result.budget.exhausted, true);
  assert.ok(result.tookMs < 1000);
});

test('unknown modes are rejected', async () => {
  await assert.rejects(
    search('Redis 默认端口是多少？', { mode: 'turbo', cache: false }),
    /unknown mode/,
  );
});
