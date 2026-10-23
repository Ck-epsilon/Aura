// Agent 基准：同时衡量答案可验证性、引用完整性、事实可追溯性和尾延迟。
import fs from 'node:fs';

import { search } from '../src/lib/router.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));
const heldout = JSON.parse(fs.readFileSync(new URL('./heldout.json', import.meta.url), 'utf8'));
const allCases = [...cases.filter((item) => item.soft !== true), ...heldout];
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
const limit = limitArg ? Number(limitArg) : 0;
let selected = allCases;
if (only) selected = selected.filter((item) => item.id === only);
if (limit > 0) selected = selected.slice(0, limit);

const rows = [];
for (const item of selected) {
  const started = Date.now();
  let result;
  let error = null;
  try {
    result = await search(item.q, {
      cache: false,
      fallback: process.env.AURA_ARGUS_BENCH_FALLBACK === 'auto' ? 'auto' : false,
      maxSources: item.options?.maxSources ?? 3,
      sites: item.options?.sites !== false,
      decompose: item.options?.decompose === true,
      deepIndex: true,
      mode: 'balanced',
      budgetMs: 8000,
    });
  } catch (caught) {
    error = caught;
    result = { entity: null, mode: 'error', evidence: [], attempts: [], facts: [] };
  }
  const ms = Date.now() - started;
  const evidenceText = result.evidence.flatMap((entry) => entry.passages.map((passage) => passage.text)).join('\n');
  const checks = [];
  if ('entity' in item) checks.push(['entity', result.entity === item.entity]);
  if (item.mode) checks.push(['mode', result.mode === item.mode]);
  if (item.minSources !== undefined) checks.push(['sources', result.evidence.length >= item.minSources]);
  if (item.version) checks.push(['version', result.version === item.version]);
  if (item.planClauses) checks.push(['plan', result.plan?.clauses?.length === item.planClauses]);
  if (item.entities) {
    const got = (result.entities || []).map((entry) => entry.id).sort();
    const want = [...item.entities].sort();
    checks.push(['entities', JSON.stringify(got) === JSON.stringify(want)]);
  }
  if (item.minConfidence !== undefined) checks.push(['confidence', (result.confidence?.score ?? 0) >= item.minConfidence]);
  if (item.minFacetRatio !== undefined) checks.push(['facets', (result.facets?.ratio ?? 0) >= item.minFacetRatio]);
  for (const [name, pattern] of item.checks || []) checks.push([name, new RegExp(pattern, 'i').test(evidenceText)]);

  const passages = result.evidence.flatMap((entry) => entry.passages.map((passage) => ({ entry, passage })));
  const passageIds = new Set(passages.map(({ passage }) => passage.id));
  const citationOk = passages.filter(({ entry, passage }) => {
    if (!passage.id || passage.id.length !== 12) return false;
    if (!passage.citation) return false;
    return passage.citation === entry.url || passage.citation.startsWith(`${entry.url}#`);
  }).length;
  const facts = result.facts || [];
  const factsLinked = facts.filter((fact) => {
    if (!passageIds.has(fact.passageId)) return false;
    return fact.citation && (!fact.url || fact.citation === fact.url || fact.citation.startsWith(`${fact.url}#`));
  }).length;

  rows.push({
    id: item.id,
    ms,
    mode: result.mode,
    sources: result.evidence.length,
    chars: evidenceText.length,
    checks: checks.length,
    passed: checks.filter(([, ok]) => ok).length,
    failed: checks.filter(([, ok]) => !ok).map(([name]) => name),
    citations: { total: passages.length, valid: citationOk },
    facts: { total: facts.length, linked: factsLinked },
    error: error ? String(error.message) : null,
  });
  console.error(`${item.id.padEnd(18)} ${String(result.mode).padEnd(13)} ${String(passages.length).padStart(3)} passages ${String(ms).padStart(5)}ms ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
}

const times = rows.map((row) => row.ms).sort((a, b) => a - b);
const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.max(0, Math.ceil(p * times.length) - 1))] : 0);
const success = rows.filter((row) => row.checks > 0 && row.passed === row.checks).length;
const citationTotal = rows.reduce((sum, row) => sum + row.citations.total, 0);
const citationValid = rows.reduce((sum, row) => sum + row.citations.valid, 0);
const factTotal = rows.reduce((sum, row) => sum + row.facts.total, 0);
const factLinked = rows.reduce((sum, row) => sum + row.facts.linked, 0);
const successRate = Number((success / Math.max(1, rows.length)).toFixed(3));
const citationRate = citationTotal ? Number((citationValid / citationTotal).toFixed(3)) : 1;
const factLinkRate = factTotal ? Number((factLinked / factTotal).toFixed(3)) : 1;
const p95 = pct(0.95);
const latencyScore = p95 <= 2500 ? 1 : Number((2500 / p95).toFixed(3));
const score = Number((0.5 * successRate + 0.25 * citationRate + 0.15 * factLinkRate + 0.1 * latencyScore).toFixed(3));
const failures = rows.filter((row) => row.checks > 0 && row.passed !== row.checks).map((row) => ({ id: row.id, failed: row.failed }));
const summary = {
  at: new Date().toISOString(),
  tasks: rows.length,
  success,
  successRate,
  citationRate,
  factLinkRate,
  latency: { p50: pct(0.5), p95, p99: pct(0.99) },
  score,
  failures,
  rows,
};
fs.writeFileSync(new URL('./agent-bench.json', import.meta.url), JSON.stringify(summary, null, 2));

const thresholds = { successRate: 0.9, citationRate: 0.98, p95: 2500, score: 0.85 };
const gateFailures = [];
if (summary.successRate < thresholds.successRate) gateFailures.push(`successRate ${summary.successRate} < ${thresholds.successRate}`);
if (summary.citationRate < thresholds.citationRate) gateFailures.push(`citationRate ${summary.citationRate} < ${thresholds.citationRate}`);
if (summary.p95 > thresholds.p95) gateFailures.push(`p95 ${summary.p95}ms > ${thresholds.p95}ms`);
if (summary.score < thresholds.score) gateFailures.push(`score ${summary.score} < ${thresholds.score}`);

console.log(JSON.stringify({
  tasks: summary.tasks,
  success: summary.success,
  successRate: summary.successRate,
  citationRate: summary.citationRate,
  factLinkRate: summary.factLinkRate,
  latency: summary.latency,
  score: summary.score,
  thresholds,
  gate: gateFailures.length ? 'fail' : 'pass',
  gateFailures,
  failures,
}, null, 2));
process.exitCode = gateFailures.length ? 2 : 0;
