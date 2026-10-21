// 性能基准：串行 vs 批量（冷/温）。
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { search, searchBatch } from '../src/lib/router.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./questions.json', import.meta.url), 'utf8')).filter((item) => !item.soft);
const questions = cases.map((item) => item.q);

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
  for (const question of questions) results.push(await search(question, { cache: false }));
  return results;
});

const batchCold = await timed('batch c=3 (cold)', () => searchBatch(questions, { cache: false, concurrency: 3 }));
const batchWarmFill = await timed('batch c=3 (cache fill)', () => searchBatch(questions, { cache: true, concurrency: 3 }));
const batchWarmHit = await timed('batch c=3 (cache hit)', () => searchBatch(questions, { cache: true, concurrency: 3 }));

const summary = {
  questions: questions.length,
  sequentialMs: Math.round(sequential.ms),
  batchColdMs: Math.round(batchCold.ms),
  batchWarmFillMs: Math.round(batchWarmFill.ms),
  batchWarmHitMs: Math.round(batchWarmHit.ms),
  coldSpeedup: Number((sequential.ms / batchCold.ms).toFixed(2)),
  warmHitSpeedup: Number((sequential.ms / batchWarmHit.ms).toFixed(1)),
};
console.log(JSON.stringify(summary, null, 2));
