// Independent evaluation entrypoint.
//
//   node eval/independent/run.mjs                 # run everything
//   node eval/independent/run.mjs --suite bytes   # one suite (repeatable)
//   node eval/independent/run.mjs --list          # list case ids
//
// Exit code: 0 when the harness itself completed (case failures are recorded as data),
// 1 only when the harness could not run (package missing/install failed/suite crashed).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CaseContext, PKG_NAME, PKG_VERSION, REGISTRY, binPath, cleanupWorkRoot, ensurePackage, makeWorkRoot } from './lib/harness.mjs';
import { buildReport, writeResults } from './lib/report.mjs';
import { suites as allSuites } from './suites/index.mjs';

const evalDir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const picked = [];
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') list = true;
    else if (a === '--suite') picked.push(argv[++i]);
    else if (a.startsWith('--suite=')) picked.push(a.slice('--suite='.length));
    else if (a === '--help' || a === '-h') {
      console.log('usage: node eval/independent/run.mjs [--suite <id>]... [--list]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { picked, list };
}

const { picked, list } = parseArgs(process.argv.slice(2));

if (list) {
  for (const s of allSuites) for (const c of s.cases) console.log(`${s.id}\t${c.id}`);
  process.exit(0);
}

const selected = picked.length ? allSuites.filter((s) => picked.includes(s.id)) : allSuites;
if (picked.length && selected.length !== new Set(picked).size) {
  console.error(`unknown suite; known: ${allSuites.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const startedAt = new Date();
const startedMs = Date.now();

let pkg;
try {
  pkg = await ensurePackage(evalDir);
} catch (err) {
  console.error(`harness error: ${err.message}`);
  process.exit(1);
}

const bin = binPath(pkg.root);
const workRoot = makeWorkRoot();
const binSha256 = createHash('sha256').update(readFileSync(bin)).digest('hex');

const meta = {
  subject: `${PKG_NAME}@${PKG_VERSION}`,
  packageRoot: pkg.root,
  packageOrigin: pkg.origin,
  registryRequested: REGISTRY,
  provenance: pkg.provenance,
  packageJson: {
    name: pkg.manifest.name,
    version: pkg.manifest.version,
    engines: pkg.manifest.engines ?? null,
    dependencies: pkg.manifest.dependencies ?? null,
    bin: pkg.manifest.bin ?? null,
  },
  artifacts: { bin: 'bin/aura.mjs', binSha256 },
  node: process.version,
  platform: `${process.platform} ${process.arch} ${process.getSystemVersion?.() ?? ''}`.trim(),
  startedAt: startedAt.toISOString(),
  workRoot,
  seed: null,
  subset: picked.length ? picked : null,
};

const results = [];
const suiteResults = [];

for (const suite of selected) {
  process.stdout.write(`\n[suite] ${suite.id} — ${suite.title}\n`);
  const caseResults = [];
  for (const c of suite.cases) {
    const ctx = new CaseContext({ id: c.id, bin, workRoot });
    let error = null;
    const t0 = Date.now();
    try {
      await c.run(ctx);
    } catch (err) {
      error = err && err.stack ? err.stack : String(err);
      ctx.check('case completed without throwing', false, { expected: 'no throw', actual: String(err).slice(0, 500) });
    }
    const durationMs = Date.now() - t0;
    const failedChecks = ctx.checks.filter((x) => !x.ok);
    const pass = failedChecks.length === 0 && !error;
    const caseResult = {
      id: c.id,
      suite: suite.id,
      purpose: c.purpose,
      input: c.input ?? null,
      expected: c.expected ?? ctx.expectedSummary ?? null,
      pass,
      durationMs,
      checks: ctx.checks,
      failedChecks: failedChecks.length,
      error,
      repro: pass ? null : ctx.repro(),
      workspace: ctx.dir,
      // suite-authoritative metadata (e.g. fuzz seed/parameters) unless the case set its own
      data: ctx.data ?? c.data ?? null,
      commands: ctx.commands.map((cmd) => ({
        argv: cmd.argv,
        code: cmd.code,
        stdout: pass ? head(cmd.stdout, 500) : head(cmd.stdout, 4000),
        stderr: head(cmd.stderr, pass ? 300 : 2000),
      })),
    };
    caseResults.push(caseResult);
    results.push(caseResult);
    const mark = pass ? '  ok ' : ' FAIL';
    process.stdout.write(`${mark} ${c.id} (${durationMs} ms)${pass ? '' : `  -> ${failedChecks.map((x) => x.name).join('; ')}`}\n`);
  }
  const s = summarize(suite, caseResults);
  suiteResults.push(s);
  process.stdout.write(`[suite] ${suite.id}: ${s.passed}/${s.total} passed${s.failed ? `, ${s.failed} failed` : ''}\n`);
}

function summarize(suite, cases) {
  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  return {
    id: suite.id,
    title: suite.title,
    total,
    passed,
    failed: total - passed,
    cases,
  };
}

const durationMs = Date.now() - startedMs;
// Record the fuzz seed in the machine-readable header too (it lives on every fuzz case).
meta.seed = results.find((c) => c.data && Object.prototype.hasOwnProperty.call(c.data, 'seed'))?.data?.seed ?? null;
const totals = {
  total: results.length,
  passed: results.filter((c) => c.pass).length,
  failed: results.filter((c) => !c.pass).length,
};
const failures = results.filter((c) => !c.pass).map((c) => ({
  id: c.id,
  suite: c.suite,
  purpose: c.purpose,
  failedChecks: c.checks.filter((x) => !x.ok),
  repro: c.repro,
}));

const output = {
  meta: { ...meta, durationMs, finishedAt: new Date().toISOString(), totals, harnessVersion: 1 },
  suites: suiteResults,
  failures,
};

mkdirSync(evalDir, { recursive: true });
writeResults(evalDir, output);
const reportPath = join(evalDir, 'REPORT.md');
writeFileSync(reportPath, buildReport(output), 'utf8');

process.stdout.write(`\n${totals.passed}/${totals.total} passed, ${totals.failed} failed (${Math.round(durationMs / 1000)}s)\n`);
process.stdout.write(`results: ${join(evalDir, 'results.json')}\nreport:  ${reportPath}\n`);
if (totals.failed) {
  process.stdout.write(`failed ids:\n${results.filter((c) => !c.pass).map((c) => '  - ' + c.id).join('\n')}\n`);
}

cleanupWorkRoot(workRoot);

function head(s, n) {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim();
  return trimmed.length > n ? `${trimmed.slice(0, n)}…` : trimmed;
}
