import test from 'node:test';
import assert from 'node:assert/strict';

import { buildConsensus } from '../src/lib/consensus.mjs';

const evidence = [
  { id: 's1', url: 'https://a.test/pricing' },
  { id: 's2', url: 'https://b.test/pricing' },
];

function fact(sourceId, type, value, unit, extra = {}) {
  return {
    id: `${sourceId}-${type}-${value}`,
    type,
    value,
    unit,
    sourceId,
    url: `https://${sourceId}.test/pricing`,
    citation: `https://${sourceId}.test/pricing#pricing`,
    passageId: `${sourceId}-p`,
    ...extra,
  };
}

test('buildConsensus reports agreement across sources', () => {
  const result = buildConsensus(evidence, [
    fact('a', 'price', 0.008, 'credit', { currency: 'USD' }),
    fact('b', 'price', 0.008, 'credit', { currency: 'USD' }),
  ]);
  assert.equal(result.sourceCount, 2);
  assert.equal(result.agreementRatio, 1);
  assert.equal(result.agreements.length, 1);
  assert.equal(result.agreements[0].value, '0.008');
  assert.equal(result.agreements[0].sources.length, 2);
  assert.equal(result.conflicts.length, 0);
});

test('buildConsensus reports a conflict when sources disagree', () => {
  const result = buildConsensus(evidence, [
    fact('a', 'limit', 60, 'requests'),
    fact('b', 'limit', 100, 'requests'),
  ]);
  assert.equal(result.agreementRatio, 0);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].values.map((entry) => entry.value).sort(), ['100', '60']);
});

test('buildConsensus reports shared values in multi-value groups without conflicts', () => {
  const facts = [
    fact('a', 'price', 0.008, 'credit', { currency: 'USD' }),
    fact('a', 'price', 0.012, 'credit', { currency: 'USD' }),
    fact('b', 'price', 0.008, 'credit', { currency: 'USD' }),
    fact('a', 'version', '20.11.1'),
    fact('b', 'version', '22.0.0'),
  ];
  const result = buildConsensus(evidence, facts);
  assert.equal(result.agreements.length, 1);
  assert.equal(result.agreements[0].value, '0.008');
  assert.equal(result.agreements[0].sources.length, 2);
  assert.equal(result.conflicts.length, 0);
});

test('buildConsensus does not duplicate a source in agreement lists', () => {
  const result = buildConsensus(evidence, [
    fact('a', 'price', 0.008, 'credit', { currency: 'USD' }),
    fact('a', 'price', 0.008, 'credit', { currency: 'USD' }),
    fact('b', 'price', 0.008, 'credit', { currency: 'USD' }),
  ]);
  assert.equal(result.agreements.length, 1);
  assert.deepEqual(result.agreements[0].sources.map((source) => source.source), ['a', 'b']);
});

test('buildConsensus returns null for a single source', () => {
  assert.equal(buildConsensus([{ url: 'https://a.test' }], [fact('a', 'price', 1, 'credit')]), null);
});
