// 检索评测：注册表覆盖 + 别名 + 英文/中文 + 未知实体 + 兜底。
// 每条问题同时检查结构（entity/mode/minSources）与金标准事实。
import fs from 'node:fs';
import { search } from '../src/lib/router.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const selected = only ? cases.filter((item) => item.id === only) : cases;
const fast = process.argv.includes('--fast');

const rows = [];
let hardPassed = 0;
let hardTotal = 0;
let softPassed = 0;
let softTotal = 0;

for (const item of selected) {
  const started = Date.now();
  let result;
  let error = null;
  try {
    result = await search(item.q, {
      cache: false,
      fallback: item.options?.fallback !== false,
      maxSources: item.options?.maxSources ?? 3,
      sites: item.options?.sites !== false,
      fast,
      decompose: item.options?.decompose === true,
    });
  } catch (caught) {
    error = caught;
    result = { entity: null, mode: 'error', evidence: [], attempts: [] };
  }
  const evidenceText = result.evidence.flatMap((entry) => entry.passages.map((p) => p.text)).join('\n');

  const structural = [];
  if ('entity' in item) structural.push(['entity', result.entity === item.entity, `got ${result.entity}`]);
  if (item.mode) structural.push(['mode', result.mode === item.mode, `got ${result.mode}`]);
  if (item.minSources !== undefined) structural.push(['sources', result.evidence.length >= item.minSources, `got ${result.evidence.length}`]);
  if (item.version) structural.push(['version', result.version === item.version, `got ${result.version}`]);
  if (item.planClauses) structural.push(['plan', result.plan?.clauses?.length === item.planClauses, `got ${result.plan?.clauses?.length}`]);
  if (item.entities) {
    const got = (result.entities || []).map((entry) => entry.id).sort();
    const want = [...item.entities].sort();
    structural.push(['entities', JSON.stringify(got) === JSON.stringify(want), `got ${got.join(',')}`]);
  }
  if (item.minConfidence !== undefined) {
    structural.push(['confidence', (result.confidence?.score ?? 0) >= item.minConfidence, `got ${result.confidence?.score}`]);
  }
  if (item.minFacetRatio !== undefined) {
    structural.push(['facets', (result.facets?.ratio ?? 0) >= item.minFacetRatio, `got ${result.facets?.ratio}`]);
  }

  const facts = (item.checks || []).map(([name, pattern]) => [name, new RegExp(pattern, 'i').test(evidenceText), pattern]);
  const checks = [...structural, ...facts];
  const passed = checks.filter(([, ok]) => ok).length;
  const soft = item.soft === true;
  if (soft) { softPassed += passed; softTotal += checks.length; }
  else { hardPassed += passed; hardTotal += checks.length; }

  rows.push({
    id: item.id,
    q: item.q,
    soft,
    entity: result.entity,
    ...(result.entities ? { entities: result.entities.map((entry) => entry.id) } : {}),
    mode: result.mode,
    sources: result.evidence.map((entry) => entry.url),
    ms: Date.now() - started,
    chars: evidenceText.length,
    confidence: result.confidence || null,
    facets: result.facets || null,
    timings: result.timings || null,
    version: result.version || null,
    cache: result.cache || null,
    checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
    error: error ? String(error.message) : null,
  });

  const misses = checks.filter(([, ok]) => !ok).map(([name]) => name);
  console.error(
    `${item.id.padEnd(18)} ${String(result.mode).padEnd(13)} ${String(result.evidence.length).padStart(2)}src ${String(Date.now() - started).padStart(5)}ms ${passed}/${checks.length} ${misses.length ? 'MISS:' + misses.join(',') : ''}${soft ? ' (soft)' : ''}`,
  );
}

const sortedMs = rows.map((row) => row.ms).sort((a, b) => a - b);
const pct = (p) => (sortedMs.length ? sortedMs[Math.min(sortedMs.length - 1, Math.max(0, Math.ceil(p * sortedMs.length) - 1))] : 0);
const avg = (pick) => (rows.length ? Number((rows.reduce((sum, row) => sum + pick(row), 0) / rows.length).toFixed(2)) : 0);
const summary = {
  at: new Date().toISOString(),
  questions: rows.length,
  hard: { passed: hardPassed, total: hardTotal },
  soft: { passed: softPassed, total: softTotal },
  latency: {
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    mean: Math.round(sortedMs.reduce((sum, value) => sum + value, 0) / Math.max(1, sortedMs.length)),
  },
  avgChars: Math.round(avg((row) => row.chars)),
  avgSources: avg((row) => row.sources.length),
  avgConfidence: avg((row) => row.confidence?.score ?? 0),
  avgFacetRatio: avg((row) => row.facets?.ratio ?? 0),
  indexHits: rows.filter((row) => row.cache === 'index').length,
  failures: rows.filter((row) => !row.soft && row.checks.some((check) => !check.ok)).map((row) => ({
    id: row.id,
    entity: row.entity,
    mode: row.mode,
    misses: row.checks.filter((check) => !check.ok).map((check) => check.name),
  })),
  rows,
};

fs.writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ questions: summary.questions, hard: summary.hard, soft: summary.soft, latency: summary.latency, avgChars: summary.avgChars, avgSources: summary.avgSources, avgConfidence: summary.avgConfidence, avgFacetRatio: summary.avgFacetRatio, indexHits: summary.indexHits, failures: summary.failures }, null, 2));
process.exitCode = summary.failures.length ? 2 : 0;
