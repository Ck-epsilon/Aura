// 50-question, five-category PK: AuraArgus (deep index + official-first fallback) vs Tavily.
import fs from 'node:fs';

import { search } from '../src/lib/router.mjs';
import { getCoverage } from '../src/lib/registry.mjs';

const CASES = JSON.parse(fs.readFileSync(new URL('./pk50.json', import.meta.url), 'utf8'));
const COVERAGE = getCoverage();
const key = process.env.TAVILY_API_KEY;
if (!key) throw new Error('TAVILY_API_KEY is not set');
const depth = process.env.TAVILY_DEPTH || 'basic';
const maxResults = Number(process.env.PK_MAX_RESULTS || 3);

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

function officialRoots(item) {
  const entity = item.entity ? COVERAGE.entities[item.entity] : null;
  if (!entity) return { hosts: new Set(), roots: new Set() };
  const hosts = new Set();
  for (const source of entity.sources || []) {
    try { hosts.add(new URL(source.url).hostname.toLowerCase()); } catch { /* ignore */ }
  }
  return { hosts, roots: new Set([...hosts].map((host) => host.split('.').slice(-2).join('.'))) };
}

function authority(urls, item) {
  const { hosts, roots } = officialRoots(item);
  if (!roots.size || !urls.length) return null;
  let official = 0;
  for (const value of urls) {
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (hosts.has(host) || [...roots].some((root) => host === root || host.endsWith(`.${root}`))) official += 1;
    } catch { /* ignore */ }
  }
  return official / urls.length;
}

async function runAura(item) {
  const started = Date.now();
  try {
    const result = await search(item.q, {
      deepIndex: true,
      fallback: 'auto',
      cache: false,
      maxSources: 3,
    });
    const entries = result.evidence || [];
    const textOf = (entry) => (entry.passages || []).map((passage) => passage.text || '').join('\n');
    return {
      ok: true,
      ms: Date.now() - started,
      mode: result.mode,
      note: result.note || null,
      fallback: result.fallback || null,
      sources: entries.map((entry) => entry.url),
      text: entries.map(textOf).join('\n'),
      top3Text: entries.slice(0, 3).map(textOf).join('\n'),
      top1Text: entries[0] ? textOf(entries[0]) : '',
      chars: entries.reduce((sum, entry) => sum + (entry.passages || []).reduce((n, passage) => n + String(passage.text || '').length, 0), 0),
    };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, mode: 'error', error: error?.code || String(error?.message || error), sources: [], text: '', top3Text: '', top1Text: '', chars: 0 };
  }
}

async function runTavily(item) {
  const started = Date.now();
  let response;
  let data;
  try {
    response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: item.q,
        search_depth: depth,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: true,
      }),
    });
    data = await response.json();
    if (!response.ok) throw new Error(data?.detail || data?.error || `HTTP ${response.status}`);
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error?.message || error), status: response?.status || 0, results: [], content: '', raw: '' };
  }
  const results = Array.isArray(data.results) ? data.results.slice(0, maxResults) : [];
  return {
    ok: true,
    ms: Date.now() - started,
    status: response.status,
    responseTime: data.response_time ?? null,
    results: results.map((entry) => ({ url: entry.url, score: entry.score })),
    content: results.map((entry) => entry.content || '').join('\n'),
    raw: results.map((entry) => entry.raw_content || entry.content || '').join('\n'),
  };
}

function summarize(rows, tool) {
  const categories = [...new Set(rows.map((row) => row.item.category))];
  const categorySummary = {};
  for (const category of categories) {
    const subset = rows.filter((row) => row.item.category === category);
    categorySummary[category] = summarizeRows(subset, tool);
  }
  return { all: summarizeRows(rows, tool), categories: categorySummary };
}

function summarizeRows(rows, tool) {
  const ok = rows.filter((row) => row[tool].ok !== false);
  const textKey = tool === 'aura' ? 'text' : 'raw';
  const top3Key = tool === 'aura' ? 'top3Text' : 'raw';
  const urlsOf = (row) => tool === 'aura' ? row.aura.sources : row.tavily.results.map((entry) => entry.url);
  const evaluations = ok.map((row) => ({ row, full: evaluate(row[tool][top3Key] || '', row.item), partial: evaluate(row[tool][top3Key] || '', row.item) }));
  const allEvaluations = ok.map((row) => evaluate(row[tool][textKey] || '', row.item));
  return {
    n: rows.length,
    full3: evaluations.filter((evaluation) => evaluation.full.full).length,
    partial3: evaluations.filter((evaluation) => evaluation.partial.partial).length,
    fullAll: allEvaluations.filter((evaluation) => evaluation.full).length,
    authority: ok.length ? Number((ok.reduce((sum, row) => sum + (authority(urlsOf(row), row.item) ?? 0), 0) / ok.length).toFixed(3)) : null,
    p50: pct(ok.map((row) => row[tool].ms), 0.5),
    p95: pct(ok.map((row) => row[tool].ms), 0.95),
    errors: rows.filter((row) => row[tool].ok === false).length,
    fallback: tool === 'aura' ? ok.filter((row) => row.aura.fallback).length : null,
  };
}

const selected = Number(process.env.PK_LIMIT || 0) > 0 ? CASES.slice(0, Number(process.env.PK_LIMIT)) : CASES;
const rows = [];
for (let index = 0; index < selected.length; index += 1) {
  const item = selected[index];
  const aura = await runAura(item);
  const tavily = await runTavily(item);
  rows.push({ id: item.id, category: item.category, item, aura, tavily });
  const auraEval = evaluate(aura.top3Text || '', item);
  const tavilyEval = evaluate(tavily.raw || '', item);
  console.error(`[${index + 1}/${CASES.length}] ${item.category.padEnd(8)} ${item.id.padEnd(24)} aura ${auraEval.full ? 'FULL' : auraEval.partial ? 'PART' : 'MISS'} ${aura.ms}ms | tavily ${tavilyEval.full ? 'FULL' : tavilyEval.partial ? 'PART' : 'MISS'} ${tavily.ms}ms`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const report = {
  at: new Date().toISOString(),
  depth,
  maxResults,
  questions: rows.length,
  aura: summarize(rows, 'aura'),
  tavily: summarize(rows, 'tavily'),
  rows,
};
const out = new URL(`../.tmp/pk50-results-${depth}.json`, import.meta.url);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  at: report.at,
  depth: report.depth,
  questions: report.questions,
  aura: report.aura,
  tavily: report.tavily,
  failures: rows.filter((row) => {
    const auraEval = evaluate(row.aura.top3Text || '', row.item);
    const tavilyEval = evaluate(row.tavily.raw || '', row.item);
    return !auraEval.full || !tavilyEval.full;
  }).map((row) => ({
    id: row.id,
    category: row.category,
    aura: evaluate(row.aura.top3Text || '', row.item),
    tavily: evaluate(row.tavily.raw || '', row.item),
    auraMode: row.aura.mode,
    auraFallback: row.aura.fallback,
    tavilyUrls: row.tavily.results.map((entry) => entry.url),
  })),
}, null, 2));
