// Aura-only 215-question evaluation. Does not call Tavily.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { search } from '../src/lib/router.mjs';

const caseFile = process.env.PK_FILE
  ? path.resolve(process.cwd(), process.env.PK_FILE)
  : fileURLToPath(new URL('./pk215.json', import.meta.url));
const CASES = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
const limit = Number(process.env.PK_LIMIT || 0);
const selected = limit > 0 ? CASES.slice(0, limit) : CASES;

function pct(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function evaluate(text, item) {
  const checks = (item.checks || []).map(([name, pattern]) => [name, new RegExp(pattern, 'i').test(text)]);
  return {
    full: checks.length > 0 && checks.every(([, ok]) => ok),
    partial: checks.some(([, ok]) => ok),
    passed: checks.filter(([, ok]) => ok).length,
    total: checks.length,
  };
}

const rows = [];
for (let index = 0; index < selected.length; index += 1) {
  const item = selected[index];
  const started = Date.now();
  let result;
  let error = null;
  try {
    result = await search(item.q, {
      deepIndex: true,
      fallback: item.kind === 'coverage' ? false : 'auto',
      recursive: item.kind !== 'coverage',
      cache: false,
      maxSources: 3,
    });
  } catch (caught) {
    error = caught;
    result = { entity: null, mode: 'error', evidence: [], attempts: [], facts: [], facets: {} };
  }
  const text = result.evidence.flatMap((entry) => entry.passages.map((passage) => passage.text)).join('\n');
  const checks = [];
  if (item.entity) checks.push(['entity', result.entity === item.entity]);
  checks.push(['evidence', result.evidence.length > 0]);
  checks.push(['mode', item.kind === 'coverage' ? result.mode === 'registry' : ['registry', 'web-fallback'].includes(result.mode)]);
  for (const [name, pattern] of item.checks || []) checks.push([name, new RegExp(pattern, 'i').test(text)]);
  const passages = result.evidence.flatMap((entry) => entry.passages || []);
  checks.push(['citations', passages.length > 0 && passages.every((passage) => passage.citation && passage.id)]);
  const passed = checks.filter(([, ok]) => ok).length;
  rows.push({
    id: item.id,
    kind: item.kind,
    category: item.category,
    q: item.q,
    entity: item.entity || null,
    ms: Date.now() - started,
    mode: result.mode,
    note: result.note || null,
    fallback: result.fallback || null,
    sources: result.evidence.length,
    chars: text.length,
    answerable: result.answerable,
    checks: checks.map(([name, ok]) => ({ name, ok })),
    error: error ? String(error.message) : null,
  });
  const mark = checks.every(([, ok]) => ok) ? 'FULL' : checks.some(([, ok]) => ok) ? 'PART' : 'MISS';
  if ((index + 1) % 20 === 0 || index === selected.length - 1) console.error(`[${index + 1}/${selected.length}] ${item.category} ${mark}`);
}

function summarize(subset) {
  const times = subset.map((row) => row.ms);
  const full = subset.filter((row) => row.checks.every((check) => check.ok)).length;
  const partial = subset.filter((row) => row.checks.some((check) => check.ok)).length;
  return {
    n: subset.length,
    full,
    partial,
    rate: Number((full / Math.max(1, subset.length)).toFixed(3)),
    p50: pct(times, 0.5),
    p95: pct(times, 0.95),
    fallback: subset.filter((row) => row.fallback).length,
    none: subset.filter((row) => row.mode === 'none').length,
    errors: subset.filter((row) => row.mode === 'error').length,
    avgSources: Number((subset.reduce((sum, row) => sum + row.sources, 0) / Math.max(1, subset.length)).toFixed(2)),
  };
}

const categories = [...new Set(rows.map((row) => row.category))];
const report = {
  at: new Date().toISOString(),
  questions: rows.length,
  all: summarize(rows),
  core: summarize(rows.filter((row) => row.kind === 'core')),
  coverage: summarize(rows.filter((row) => row.kind === 'coverage')),
  byCategory: Object.fromEntries(categories.map((category) => [category, summarize(rows.filter((row) => row.category === category))])),
  failures: rows.filter((row) => row.checks.some((check) => !check.ok)).map((row) => ({
    id: row.id,
    kind: row.kind,
    category: row.category,
    missed: row.checks.filter((check) => !check.ok).map((check) => check.name),
    mode: row.mode,
  })),
  rows,
};
fs.writeFileSync(new URL('../.tmp/pk215-results.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  questions: report.questions,
  all: report.all,
  core: report.core,
  coverage: report.coverage,
  byCategory: report.byCategory,
  failures: report.failures.slice(0, 30),
}, null, 2));
