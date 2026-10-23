import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logQuery, queryLogFile, readQueryLog } from '../src/lib/query-log.mjs';
import { summarizeQueries } from '../src/lib/gaps.mjs';
import { search } from '../src/lib/router.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-query-log-'));
}

test('queryLogFile is opt-in and accepts a custom path', () => {
  assert.equal(queryLogFile({}), null);
  assert.equal(queryLogFile({ AURA_ARGUS_QUERY_LOG: '0' }), null);
  assert.match(queryLogFile({ AURA_ARGUS_QUERY_LOG: '1', AURA_ARGUS_CACHE_DIR: '/tmp/argus' }), /queries\.jsonl$/);
  assert.equal(queryLogFile({ AURA_ARGUS_QUERY_LOG: 'logs/q.jsonl' }), path.resolve('logs/q.jsonl'));
});

test('logQuery writes a local JSONL record and summarizeQueries aggregates gaps', () => {
  const dir = tempDir();
  const file = path.join(dir, 'queries.jsonl');
  try {
    logQuery({
      question: 'q1',
      entity: 'redis',
      mode: 'registry',
      confidence: { score: 0.9, label: 'high' },
      facets: { ratio: 1, missing: [] },
      evidence: [{ passages: [{ text: '6379' }] }],
      tookMs: 12,
    }, { file });
    logQuery({
      question: 'q2',
      entity: null,
      mode: 'none',
      confidence: { score: 0, label: 'none' },
      facets: { ratio: 0, missing: ['deploy', 'deploy', 'quota'] },
      evidence: [],
      tookMs: 1,
    }, { file });

    const records = readQueryLog(file);
    assert.equal(records.length, 2);
    assert.equal(records[0].entity, 'redis');
    assert.equal(records[1].mode, 'none');

    const summary = summarizeQueries(records);
    assert.equal(summary.total, 2);
    assert.equal(summary.noEvidence, 1);
    assert.equal(summary.lowConfidence, 1);
    assert.equal(summary.highConfidence, 1);
    assert.deepEqual(summary.topMissing.slice(0, 2).map((item) => item.id).sort(), ['deploy', 'quota']);
    assert.equal(summary.modes.none, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search writes the opt-in log for a no-evidence query', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'queries.jsonl');
  const previous = process.env.AURA_ARGUS_QUERY_LOG;
  process.env.AURA_ARGUS_QUERY_LOG = file;
  try {
    const result = await search('量子计算机的退相干时间是多少？', { cache: false, fallback: false });
    assert.equal(result.mode, 'none');
    const records = readQueryLog(file);
    assert.equal(records.length, 1);
    assert.equal(records[0].mode, 'none');
    assert.equal(records[0].question, '量子计算机的退相干时间是多少？');
  } finally {
    if (previous === undefined) delete process.env.AURA_ARGUS_QUERY_LOG;
    else process.env.AURA_ARGUS_QUERY_LOG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
