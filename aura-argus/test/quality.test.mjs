import test from 'node:test';
import assert from 'node:assert/strict';

import { confidenceFor, facetTerms, qualityFor, scoreFacets } from '../src/lib/quality.mjs';

test('facetTerms keeps specific Latin terms and entity ids', () => {
  const terms = new Set(['mysql', 'innodb', 'transaction', 'isolation', 'level', 'what', 'module', '事务', '隔离']);
  const facets = facetTerms(terms, { entity: { id: 'mysql', aliases: ['mysql 8'] } });
  assert.ok(facets.includes('mysql'));
  assert.ok(facets.includes('innodb'));
  assert.ok(facets.includes('isolation'));
  assert.ok(!facets.includes('module'));
  assert.ok(!facets.includes('what'));
});

test('scoreFacets separates covered and missing facets', () => {
  const evidence = [{ passages: [{ text: 'MySQL InnoDB uses transaction isolation levels.' }] }];
  const result = scoreFacets(evidence, ['mysql', 'innodb', 'isolation', 'replication']);
  assert.deepEqual(result.covered, ['mysql', 'innodb', 'isolation']);
  assert.deepEqual(result.missing, ['replication']);
  assert.equal(result.ratio, 0.75);
});

test('confidenceFor returns none without evidence', () => {
  assert.deepEqual(confidenceFor({ evidence: [], facets: { ratio: 0 } }), {
    score: 0,
    label: 'none',
    reason: 'no-evidence',
  });
  assert.equal(confidenceFor({ evidence: [], facets: { ratio: 0 }, allFailed: true }).reason, 'all-sources-failed');
});

test('confidenceFor cannot label high when a critical facet is missing', () => {
  const evidence = [
    { passages: [{ text: 'nginx configuration directives', score: 30 }] },
    { passages: [{ text: 'nginx configure settings', score: 20 }] },
  ];
  const confidence = confidenceFor({
    evidence,
    facets: { terms: ['nginx', 'configure', 'proxy_pass'], covered: ['nginx', 'configure'], missing: ['proxy_pass'], ratio: 0.67 },
  });
  assert.ok(confidence.score <= 0.74);
  assert.notEqual(confidence.label, 'high');
});

test('qualityFor returns next when a facet is missing', () => {
  const evidence = [{ passages: [{ text: 'PostgreSQL CREATE TABLE syntax.', score: 20 }] }];
  const quality = qualityFor({
    terms: new Set(['postgresql', 'create table', 'partition']),
    entity: { id: 'postgres', aliases: ['postgresql'] },
    evidence,
  });
  assert.ok(quality.facets.covered.includes('postgresql'));
  assert.ok(quality.facets.missing.includes('partition'));
  assert.ok(quality.next.missingFacets.includes('partition'));
  assert.ok(['low', 'medium', 'high'].includes(quality.confidence.label));
});
