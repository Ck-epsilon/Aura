import test from 'node:test';
import assert from 'node:assert/strict';

import { detectIntent, planQuery, splitClauses } from '../src/lib/plan.mjs';

test('detectIntent classifies common agent intents', () => {
  assert.equal(detectIntent('DeepSeek 的 API 多少钱？').intent, 'pricing');
  assert.equal(detectIntent('Node.js 20 什么时候退役？').intent, 'version');
  assert.equal(detectIntent('Redis 报错 CONNECTION REFUSED 怎么办？').intent, 'error');
  assert.equal(detectIntent('PostgreSQL 和 MySQL 的区别？').intent, 'compare');
  assert.equal(detectIntent('Flask 怎么定义路由？').intent, 'howto');
  assert.equal(detectIntent('PyPI 怎么发布 Python 包？').intent, 'howto');
  assert.equal(detectIntent('Redis 默认端口是多少？').intent, 'fact');
});

test('splitClauses splits compound questions but not comparisons', () => {
  assert.deepEqual(splitClauses('DeepSeek 的 API 多少钱？QPS 上限是多少？'), ['DeepSeek 的 API 多少钱', 'QPS 上限是多少']);
  assert.deepEqual(splitClauses('How do I install X and configure Y?'), ['How do I install X', 'configure Y']);
  assert.deepEqual(splitClauses('PostgreSQL 和 MySQL 的区别？'), ['PostgreSQL 和 MySQL 的区别？']);
  assert.deepEqual(splitClauses('Redis 默认端口是多少？'), ['Redis 默认端口是多少？']);
});

test('planQuery exposes intent, clauses and compound', () => {
  const plan = planQuery('DeepSeek 的 API 多少钱？QPS 上限是多少？');
  assert.equal(plan.intent, 'pricing');
  assert.equal(plan.compound, true);
  assert.equal(plan.clauses.length, 2);
  const single = planQuery('Flask 怎么定义路由？');
  assert.equal(single.compound, false);
  assert.equal(single.intent, 'howto');
});
