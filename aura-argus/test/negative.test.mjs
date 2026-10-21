import test from 'node:test';
import assert from 'node:assert/strict';

import { matchEntity, expandTerms, rankSources, listEntities } from '../src/lib/registry.mjs';

test('unknown entity does not match', () => {
  assert.equal(matchEntity('量子计算机的退相干时间是多少？'), null);
  assert.equal(matchEntity('best pizza in town'), null);
});

test('aliases resolve across languages', () => {
  assert.equal(matchEntity('DeepSeek 的搜索 API 多少钱')?.id, 'deepseek');
  assert.equal(matchEntity('深度求索 的价格')?.id, 'deepseek');
  assert.equal(matchEntity('SearXNG 429 冷却')?.id, 'searxng');
  assert.equal(matchEntity('Google Custom Search 还能用吗')?.id, 'google-cse');
  assert.equal(matchEntity('postgres 怎么装')?.id, 'postgres');
});

test('unknown entity ranks no sources', () => {
  const entity = matchEntity('量子计算机退相干');
  assert.equal(entity, null);
});

test('anti-collision: golang does not match google', () => {
  assert.equal(matchEntity('golang 的 module 怎么用')?.id, 'go');
});

test('every entity resolves through a Chinese alias or its id', () => {
  for (const entity of listEntities()) {
    const question = `${entity.aliases[0]} 的文档在哪`;
    assert.ok(matchEntity(question), `${entity.id} should match its first alias`);
  }
});

test('rankSources is sorted by cover score', () => {
  const entity = matchEntity('SearXNG 429 冷却');
  const ranked = rankSources(entity, expandTerms('SearXNG 429 冷却'));
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
});
