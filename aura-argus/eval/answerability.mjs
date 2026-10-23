// Answerability 报告：把评测结果转成“证据是否回答了问题”的可比较指标。
import fs from 'node:fs';

const resultsPath = process.argv.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
  || new URL('./results.json', import.meta.url);
const thresholdArg = process.argv.find((arg) => arg.startsWith('--min='))?.slice('--min='.length);
const threshold = Number(thresholdArg ?? process.env.AURA_ARGUS_MIN_ANSWERABILITY ?? 0.9);
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

const rows = results.rows.filter((row) => !row.soft).map((row) => {
  const checks = Array.isArray(row.checks) ? row.checks : [];
  const passed = checks.filter((check) => check.ok).length;
  return {
    id: row.id,
    entity: row.entity,
    mode: row.mode,
    answerable: row.mode !== 'error' && passed === checks.length,
    checksPassed: passed,
    checksTotal: checks.length,
    confidence: row.confidence?.score ?? null,
    facetRatio: row.facets?.ratio ?? null,
    sources: row.sources?.length ?? 0,
    ms: row.ms ?? 0,
  };
});

const answerable = rows.filter((row) => row.answerable).length;
const rate = Number((answerable / Math.max(1, rows.length)).toFixed(3));
const times = rows.map((row) => row.ms).sort((a, b) => a - b);
const percentile = (p) => (times.length ? times[Math.min(times.length - 1, Math.max(0, Math.ceil(p * times.length) - 1))] : 0);
const avg = (pick) => Number((rows.reduce((sum, row) => sum + pick(row), 0) / Math.max(1, rows.length)).toFixed(2));

const summary = {
  at: new Date().toISOString(),
  source: String(resultsPath),
  questions: rows.length,
  answerable,
  rate,
  threshold,
  avgConfidence: avg((row) => row.confidence ?? 0),
  avgFacetRatio: avg((row) => row.facetRatio ?? 0),
  avgSources: avg((row) => row.sources),
  p50: percentile(0.5),
  p95: percentile(0.95),
  failures: rows.filter((row) => !row.answerable),
  rows,
};

const output = new URL('./answerability.json', import.meta.url);
fs.writeFileSync(output, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  questions: summary.questions,
  answerable: summary.answerable,
  rate: summary.rate,
  threshold: summary.threshold,
  avgConfidence: summary.avgConfidence,
  avgFacetRatio: summary.avgFacetRatio,
  p50: summary.p50,
  p95: summary.p95,
  failures: summary.failures.map((row) => row.id),
}, null, 2));
process.exitCode = rate < threshold ? 2 : 0;
