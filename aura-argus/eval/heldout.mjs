// Held-out 发布门：用 deep index 回答未进入主评测集的主题题。
import fs from 'node:fs';

import { search } from '../src/lib/router.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('./heldout.json', import.meta.url), 'utf8'));
const rows = [];
for (const item of cases) {
  const started = Date.now();
  let result;
  let error = null;
  try {
    result = await search(item.q, {
      deepIndex: true,
      cache: false,
      fallback: false,
      maxSources: 3,
    });
  } catch (caught) {
    error = caught;
    result = { entity: null, mode: 'error', evidence: [], attempts: [], facts: [] };
  }
  const evidenceText = result.evidence.flatMap((entry) => entry.passages.map((passage) => passage.text)).join('\n');
  const checks = [];
  if (item.entity) checks.push(['entity', result.entity === item.entity]);
  checks.push(['mode', result.mode === 'registry']);
  checks.push(['sources', result.evidence.length > 0]);
  for (const [name, pattern] of item.checks || []) checks.push([name, new RegExp(pattern, 'i').test(evidenceText)]);
  const passages = result.evidence.flatMap((entry) => entry.passages || []);
  const citationOk = passages.length > 0 && passages.every((passage) => passage.citation && passage.id);
  checks.push(['citations', citationOk]);
  const passed = checks.filter(([, ok]) => ok).length;
  rows.push({
    id: item.id,
    q: item.q,
    ms: Date.now() - started,
    mode: result.mode,
    entity: result.entity,
    note: result.note || null,
    sources: result.evidence.length,
    checks: checks.map(([name, ok]) => ({ name, ok })),
    error: error ? String(error.message) : null,
  });
  console.error(`${item.id.padEnd(26)} ${String(result.mode).padEnd(10)} ${String(result.evidence.length).padStart(2)}src ${String(Date.now() - started).padStart(5)}ms ${passed}/${checks.length} ${result.note || ''}`);
}

const passed = rows.filter((row) => row.checks.every((check) => check.ok)).length;
const rate = Number((passed / Math.max(1, rows.length)).toFixed(3));
const times = rows.map((row) => row.ms).sort((a, b) => a - b);
const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.max(0, Math.ceil(p * times.length) - 1))] : 0);
const report = {
  at: new Date().toISOString(),
  questions: rows.length,
  passed,
  rate,
  minRate: 0.9,
  p50: pct(0.5),
  p95: pct(0.95),
  failures: rows.filter((row) => row.checks.some((check) => !check.ok)).map((row) => ({
    id: row.id,
    missed: row.checks.filter((check) => !check.ok).map((check) => check.name),
  })),
  rows,
};
fs.writeFileSync(new URL('./heldout-results.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ questions: report.questions, passed: report.passed, rate: report.rate, p50: report.p50, p95: report.p95, failures: report.failures }, null, 2));
process.exitCode = rate < report.minRate ? 2 : 0;
