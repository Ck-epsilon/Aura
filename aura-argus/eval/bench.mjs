// 性能基准：串行 vs 批量（冷/温）。
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { search, searchBatch } from '../src/lib/router.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./questions.json', import.meta.url), 'utf8')).filter((item) => !item.soft);
const questions = cases.map((item) => item.q);
const fast = process.argv.includes('--fast');

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : 0;
};

const latencyOf = (results) => {
  const values = results.map((result) => result?.tookMs ?? 0);
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
};

const qualityOf = (results) => {
  const rows = results.filter(Boolean);
  const avg = (pick) => (rows.length ? Number((rows.reduce((sum, row) => sum + pick(row), 0) / rows.length).toFixed(2)) : 0);
  return {
    avgConfidence: avg((row) => row.confidence?.score ?? 0),
    avgFacetRatio: avg((row) => row.facets?.ratio ?? 0),
    avgSources: avg((row) => row.evidence?.length ?? 0),
    indexHits: rows.filter((row) => row.cache === 'index').length,
  };
};

const timed = async (label, fn) => {
  const started = performance.now();
  const value = await fn();
  const ms = performance.now() - started;
  const evidence = Array.isArray(value) ? value.reduce((sum, item) => sum + (item.evidence?.length ?? 0), 0) : 0;
  console.error(`${label.padEnd(28)} ${(ms / 1000).toFixed(2).padStart(7)} s   avg ${(ms / questions.length).toFixed(0).padStart(5)} ms/q   evidence ${evidence}`);
  return { ms, value };
};

console.error(`questions: ${questions.length}\n`);

const sequential = await timed('sequential (cold)', async () => {
  const results = [];
  for (const question of questions) results.push(await search(question, { cache: false, ...(fast ? { fast: true } : {}) }));
  return results;
});

const batchCold = await timed('batch c=3 (cold)', () => searchBatch(questions, { cache: false, concurrency: 3, ...(fast ? { fast: true } : {}) }));
const batchWarmFill = await timed('batch c=3 (cache fill)', () => searchBatch(questions, { cache: true, concurrency: 3, ...(fast ? { fast: true } : {}) }));
const batchWarmHit = await timed('batch c=3 (cache hit)', () => searchBatch(questions, { cache: true, concurrency: 3, ...(fast ? { fast: true } : {}) }));

const summary = {
  questions: questions.length,
  fast,
  sequentialMs: Math.round(sequential.ms),
  batchColdMs: Math.round(batchCold.ms),
  batchWarmFillMs: Math.round(batchWarmFill.ms),
  batchWarmHitMs: Math.round(batchWarmHit.ms),
  coldSpeedup: Number((sequential.ms / batchCold.ms).toFixed(2)),
  warmHitSpeedup: Number((sequential.ms / batchWarmHit.ms).toFixed(1)),
  latency: {
    sequential: latencyOf(sequential.value),
    batchCold: latencyOf(batchCold.value),
  },
  quality: qualityOf(batchCold.value),
};
console.log(JSON.stringify(summary, null, 2));
