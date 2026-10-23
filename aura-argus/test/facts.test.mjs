import test from 'node:test';
import assert from 'node:assert/strict';

import { extractFacts } from '../src/lib/facts.mjs';

const evidence = [{
  id: 'src-1',
  url: 'https://example.test/pricing',
  passages: [{
    id: 'passage-1',
    sourceId: 'src-1',
    url: 'https://example.test/pricing',
    citation: 'https://example.test/pricing#pricing',
    text: 'Free tier includes 1,000 credits per month. Pay as you go is $0.008 per credit, with a 20% discount. Effective 2024-01-15. Rate limit 60 requests per minute.',
  }],
}];

test('extractFacts extracts price, percent, limit and date with citations', () => {
  const facts = extractFacts(evidence, { intent: 'fact' });
  const price = facts.find((fact) => fact.type === 'price');
  assert.deepEqual(
    { value: price.value, currency: price.currency, unit: price.unit },
    { value: 0.008, currency: 'USD', unit: 'credit' },
  );
  assert.equal(price.citation, 'https://example.test/pricing#pricing');
  assert.equal(price.passageId, 'passage-1');
  assert.ok(facts.some((fact) => fact.type === 'percent' && fact.value === 20));
  assert.ok(facts.some((fact) => fact.type === 'limit' && fact.value === 1000 && fact.unit === 'credits'));
  assert.ok(facts.some((fact) => fact.type === 'date' && fact.value === '2024-01-15'));
  assert.ok(facts.every((fact) => fact.id.length === 12 && fact.confidence > 0));
});

test('extractFacts filters by intent and does not return prices for version questions', () => {
  const versionEvidence = [{
    id: 'src-3',
    url: 'https://example.test/releases',
    passages: [{
      id: 'passage-3',
      text: 'Node.js 20.11.1 requires TLS 1.2. It was released on 2024-01-15 and costs $0.00 to install.',
    }],
  }];
  const facts = extractFacts(versionEvidence, { intent: 'version' });
  assert.ok(facts.some((fact) => fact.type === 'version' && fact.value === '20.11.1'));
  assert.ok(facts.some((fact) => fact.type === 'date' && fact.value === '2024-01-15'));
  assert.ok(!facts.some((fact) => fact.type === 'price'));
});

test('extractFacts keeps identical text from different sources', () => {
  const text = 'The API costs $0.008 per credit.';
  const shared = [{
    id: 'src-a',
    url: 'https://a.test/pricing',
    passages: [{ id: 'same', sourceId: 'src-a', url: 'https://a.test/pricing', citation: 'https://a.test/pricing#pricing', text }],
  }, {
    id: 'src-b',
    url: 'https://b.test/pricing',
    passages: [{ id: 'same', sourceId: 'src-b', url: 'https://b.test/pricing', citation: 'https://b.test/pricing#pricing', text }],
  }];
  const facts = extractFacts(shared, { intent: 'pricing' });
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((fact) => fact.sourceId).sort(), ['src-a', 'src-b']);
});

test('extractFacts deduplicates identical facts in one passage', () => {
  const duplicated = [{
    id: 'src-2',
    url: 'https://example.test/limits',
    passages: [{
      id: 'passage-2',
      text: 'The limit is 60 requests per minute; another line also says 60 requests per minute.',
    }],
  }];
  const facts = extractFacts(duplicated, { intent: 'fact' }).filter((fact) => fact.type === 'limit');
  assert.equal(facts.length, 1);
});
