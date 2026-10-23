#!/usr/bin/env node
// AuraArgus CLI：search / fetch / sources / doctor / serve / mcp
import { search, searchBatch, fetchDocument, getCoverage, listEntities, version, ArgusError, CODES, toErrorPayload } from './core.mjs';
import { checkSources } from './lib/doctor.mjs';
import { startServer } from './lib/server.mjs';
import { runMcp } from './lib/mcp.mjs';
import { warmSources } from './lib/warm.mjs';
import { queryLogFile, readQueryLog } from './lib/query-log.mjs';
import { summarizeQueries } from './lib/gaps.mjs';
import { buildIndex } from './lib/index-store.mjs';

const USAGE = `aura-argus ${version}

Usage:
  aura-argus aura_argus_search <question...> [--max-sources 3] [--json|--text] [--no-cache] [--fallback] [--site domain]
                   [--mode fast|balanced|deep] [--budget-ms 5000]
                   [--multi|--no-multi] [--follow-links|--no-follow-links] [--max-follow-links 1] [--fast] [--deep-index] [--decompose] [--doc-version 20]
                   [--sites-file path] [--no-sites] [--allow-private] [--timeout ms]
  echo '["q1","q2"]' | aura-argus aura_argus_search_batch [--concurrency 3] [--json]
  aura-argus aura_argus_fetch <url> [--max-chars 20000] [--format markdown|text] [--json] [--allow-private]
  aura-argus aura_argus_sources
  aura-argus aura_argus_doctor [--json] [--sites-file path] [--no-sites] [--allow-private]
  aura-argus aura_argus_warm [--top 20] [--entity id[,id]] [--max-sources 2] [--concurrency 4] [--json]
  aura-argus aura_argus_gaps [--file path] [--json]
  aura-argus aura_argus_index [--top 20] [--all] [--entity id[,id]] [--max-sources 2] [--deep] [--max-pages 80] [--max-depth 2] [--concurrency 4] [--no-incremental] [--json]
  aura-argus aura_argus_serve [--port 8787] [--host 127.0.0.1] [--token <t>] [--allow-private] [--sites-file path] [--no-sites]
  aura-argus aura_argus_mcp [--allow-private] [--sites-file path] [--no-sites]

Legacy aliases: search, search --batch, fetch, sources, doctor, warm, gaps, index, serve, mcp.

Exit codes:
  0 ok   2 no evidence   3 bad args   4 network/fetch failure   130 interrupted`;

const COMMAND_ALIASES = {
  aura_argus_search: 'aura_argus_search',
  search: 'aura_argus_search',
  aura_argus_search_batch: 'aura_argus_search_batch',
  aura_argus_fetch: 'aura_argus_fetch',
  fetch: 'aura_argus_fetch',
  aura_argus_sources: 'aura_argus_sources',
  sources: 'aura_argus_sources',
  aura_argus_doctor: 'aura_argus_doctor',
  doctor: 'aura_argus_doctor',
  aura_argus_warm: 'aura_argus_warm',
  warm: 'aura_argus_warm',
  aura_argus_gaps: 'aura_argus_gaps',
  gaps: 'aura_argus_gaps',
  aura_argus_index: 'aura_argus_index',
  index: 'aura_argus_index',
  aura_argus_serve: 'aura_argus_serve',
  serve: 'aura_argus_serve',
  aura_argus_mcp: 'aura_argus_mcp',
  mcp: 'aura_argus_mcp',
  aura_argus_version: 'version',
  version: 'version',
  aura_argus_help: 'help',
  help: 'help',
};

function parseArgs(argv) {
  const flags = {};
  const boolean = new Set(['json', 'text', 'no-cache', 'no-fallback', 'fallback', 'explain', 'help', 'version', 'batch', 'allow-private', 'no-sites', 'multi', 'no-multi', 'follow-links', 'no-follow-links', 'fast', 'decompose', 'no-incremental', 'deep', 'deep-index', 'all']);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
      const name = arg.slice(2);
      if (boolean.has(name)) { flags[name] = true; continue; }
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { flags[name] = argv[++i]; continue; }
      flags[name] = true;
    } else if (arg === '-v') {
      flags.version = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const jsonOut = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

function coverageOptions(flags) {
  if (flags['sites-file'] === true) throw new ArgusError(CODES.BAD_REQUEST, '--sites-file expects a path');
  return {
    sites: flags['no-sites'] ? false : undefined,
    sitesFile: typeof flags['sites-file'] === 'string' ? flags['sites-file'] : undefined,
    allowPrivate: Boolean(flags['allow-private']),
  };
}

function searchOptions(flags) {
  return {
    maxSources: Number(flags['max-sources'] ?? flags.maxSources ?? 3),
    cache: !flags['no-cache'],
    fallback: flags['no-fallback'] ? false : flags.fallback === true ? true : 'auto',
    site: typeof flags.site === 'string' ? flags.site : undefined,
    timeoutMs: Number(flags.timeout ?? 12_000),
    multi: flags['no-multi'] ? false : flags.multi ? true : undefined,
    maxFollowLinks: flags['max-follow-links'] !== undefined ? Number(flags['max-follow-links']) : undefined,
    fast: Boolean(flags.fast),
    deepIndex: flags['deep-index'] === true,
    decompose: Boolean(flags.decompose),
    mode: typeof flags.mode === 'string' ? flags.mode : undefined,
    budgetMs: flags['budget-ms'] !== undefined ? Number(flags['budget-ms']) : undefined,
    indexDir: typeof flags['index-dir'] === 'string' ? flags['index-dir'] : undefined,
    indexTtlMs: flags['index-ttl'] !== undefined ? Number(flags['index-ttl']) : undefined,
    docVersion: flags['doc-version'] !== undefined ? String(flags['doc-version']) : undefined,
    ...coverageOptions(flags),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function searchText(result) {
  const origin = result.entityOrigin && result.entityOrigin !== 'registry' ? ` (${result.entityOrigin})` : '';
  const lines = [`? ${result.question}`, `entity: ${result.entity ?? '(none)'}${origin} · mode: ${result.mode} · ${result.tookMs}ms${result.cached ? ' · cached' : ''}`];
  (result.evidence ?? []).forEach((entry, index) => {
    lines.push('', `${index + 1}. ${entry.title || entry.url}`, `   ${entry.url}`);
    for (const passage of entry.passages.slice(0, 2)) lines.push(`   ${passage.text.slice(0, 240)}`);
  });
  if (!(result.evidence ?? []).length) lines.push('', result.error ? `error: ${result.error.code} ${result.error.message}` : 'no evidence');
  return lines.join('\n');
}

function exitCodeFor(error) {
  if (!(error instanceof ArgusError)) return 1;
  if (error.code === CODES.BAD_REQUEST || error.code === CODES.BAD_URL || error.code === CODES.PRIVATE_ADDRESS) return 3;
  if (error.code === CODES.NO_EVIDENCE) return 2;
  return 4;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { console.log(USAGE); return 0; }
  const { flags, positional } = parseArgs(argv);
  const command = positional.shift();
  const canonical = COMMAND_ALIASES[command] || command;

  if (flags.version || canonical === 'version') { console.log(version); return 0; }
  if (flags.help || canonical === 'help') { console.log(USAGE); return 0; }

  if (canonical === 'aura_argus_search' || canonical === 'aura_argus_search_batch') {
    if (canonical === 'aura_argus_search_batch' || flags.batch) {
      if (process.stdin.isTTY) { console.error('--batch expects a JSON array of questions on stdin'); return 3; }
      const raw = await readStdin();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new ArgusError(CODES.BAD_REQUEST, '--batch expects JSON on stdin'); }
      const questions = (Array.isArray(parsed) ? parsed : [parsed])
        .map((item) => (typeof item === 'string' ? item : item?.question ?? item?.q))
        .filter(Boolean);
      if (!questions.length) throw new ArgusError(CODES.BAD_REQUEST, 'batch has no questions');
      const results = await searchBatch(questions, {
        concurrency: Number(flags.concurrency ?? 3),
        ...searchOptions(flags),
        budgetMs: Number(flags.budget ?? flags['budget-ms'] ?? 35_000),
      });
      if (flags.text) results.forEach((result) => console.log(searchText(result) + '\n'));
      else jsonOut(results);
      if (results.some((result) => result.evidence?.length)) return 0;
      if (results.some((result) => result.error)) return 4;
      return 2;
    }
    const question = positional.join(' ').trim();
    if (!question) { console.error(USAGE); return 3; }
    const result = await search(question, searchOptions(flags));
    if (flags.text) console.log(searchText(result));
    else jsonOut(result);
    if (result.error) return 4;
    return result.evidence.length ? 0 : 2;
  }

  if (canonical === 'aura_argus_fetch') {
    const target = positional[0];
    if (!target) { console.error(USAGE); return 3; }
    const doc = await fetchDocument(target, {
      maxChars: Number(flags['max-chars'] ?? 20_000),
      format: flags.format === 'text' ? 'text' : 'markdown',
      timeoutMs: Number(flags.timeout ?? 12_000),
      allowPrivate: Boolean(flags['allow-private']),
    });
    if (flags.text) process.stdout.write(doc.text + '\n');
    else jsonOut(doc);
    return 0;
  }

  if (canonical === 'aura_argus_sources') {
    const options = coverageOptions(flags);
    const coverage = getCoverage(options);
    jsonOut({ version, coverageVersion: coverage.version, sites: coverage.files, entities: listEntities(options) });
    return 0;
  }

  if (canonical === 'aura_argus_doctor') {
    const options = coverageOptions(flags);
    const coverage = getCoverage(options);
    const rows = await checkSources({ timeoutMs: Number(flags.timeout ?? 12_000), ...options });
    const failed = rows.filter((row) => !row.ok);
    if (flags.json) jsonOut({ ok: failed.length === 0, total: rows.length, failed: failed.length, coverageVersion: coverage.version, rows });
    else {
      for (const row of rows) {
        console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${String(row.entity).padEnd(12)} ${String(row.status ?? row.code).padEnd(6)} ${String(row.bytes ?? '').padStart(8)}B ${String(row.ms).padStart(6)}ms ${row.url}`);
      }
      console.log(`\n${rows.length - failed.length}/${rows.length} sources reachable`);
    }
    return failed.length ? 2 : 0;
  }

  if (canonical === 'aura_argus_index') {
    const ids = typeof flags.entity === 'string' ? flags.entity.split(',').map((id) => id.trim()).filter(Boolean) : null;
    const result = await buildIndex({
      entities: ids,
      top: Number(flags.top ?? 20),
      maxSources: Number(flags['max-sources'] ?? 2),
      concurrency: Number(flags.concurrency ?? 4),
      timeoutMs: Number(flags.timeout ?? 15_000),
      incremental: flags['no-incremental'] !== true,
      deep: flags.deep === true,
      all: flags.all === true,
      deepMaxPages: Number(flags['max-pages'] ?? 80),
      deepMaxDepth: Number(flags['max-depth'] ?? 2),
      ...coverageOptions(flags),
      indexDir: typeof flags['index-dir'] === 'string' ? flags['index-dir'] : undefined,
    });
    if (flags.json) jsonOut(result);
    else {
      for (const row of result.rows) {
        const state = row.reused ? 'REUSE' : row.notModified ? `304×${row.notModified}` : `upd ${row.updated}`;
        console.log(`${row.failed ? 'WARN' : 'OK  '} ${row.entity.padEnd(18)} ${row.sources} sources ${String(row.sections).padStart(4)} sections ${state.padEnd(7)} ${String(row.ms).padStart(5)}ms`);
      }
      console.log(`\nindexed ${result.entities} entities / ${result.sections} sections into ${result.indexDir} (reused ${result.reused}, 304 ${result.notModifiedSources}, updated ${result.updatedSources})`);
    }
    return result.rows.some((row) => row.failed) ? 2 : 0;
  }

  if (canonical === 'aura_argus_gaps') {
    const file = typeof flags.file === 'string' ? flags.file : queryLogFile();
    if (!file) {
      console.error('no query log; set AURA_ARGUS_QUERY_LOG=1 or pass --file <path>');
      return 3;
    }
    const summary = summarizeQueries(readQueryLog(file));
    if (flags.json) jsonOut(summary);
    else {
      console.log(`queries: ${summary.total} · no evidence: ${summary.noEvidence} · low confidence: ${summary.lowConfidence}`);
      console.log('modes:', Object.entries(summary.modes).map(([key, value]) => `${key}=${value}`).join(' '));
      if (summary.topEntities.length) console.log('entities:', summary.topEntities.map((item) => `${item.id}(${item.count})`).join(' '));
      if (summary.topMissing.length) console.log('missing:', summary.topMissing.map((item) => `${item.id}(${item.count})`).join(' '));
    }
    return 0;
  }

  if (canonical === 'aura_argus_warm') {
    const ids = typeof flags.entity === 'string' ? flags.entity.split(',').map((id) => id.trim()).filter(Boolean) : null;
    const result = await warmSources({
      entities: ids,
      top: Number(flags.top ?? 20),
      maxSources: Number(flags['max-sources'] ?? 2),
      concurrency: Number(flags.concurrency ?? 4),
      timeoutMs: Number(flags.timeout ?? 12_000),
      ...coverageOptions(flags),
      pageCacheDir: typeof flags['cache-dir'] === 'string' ? flags['cache-dir'] : undefined,
    });
    if (flags.json) jsonOut(result);
    else {
      for (const row of result.rows) {
        console.log(`${row.failed ? 'WARN' : 'OK  '} ${row.entity.padEnd(18)} ${row.ok}/${row.sources} sources ${String(row.bytes).padStart(8)}B ${String(row.ms).padStart(6)}ms`);
      }
      console.log(`\nwarmed ${result.entities} entities into ${result.cacheDir}`);
    }
    return result.rows.some((row) => row.failed) ? 2 : 0;
  }

  if (canonical === 'aura_argus_serve') {
    const { server, url } = await startServer({
      port: Number(flags.port ?? 8787),
      host: String(flags.host ?? '127.0.0.1'),
      token: flags.token ? String(flags.token) : null,
      allowPrivate: Boolean(flags['allow-private']),
      ...coverageOptions(flags),
    });
    jsonOut({ ok: true, url });
    const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return null;
  }

  if (canonical === 'aura_argus_mcp') {
    if (flags['allow-private']) process.env.AURA_ARGUS_ALLOW_PRIVATE = '1';
    if (flags['no-sites']) process.env.AURA_ARGUS_NO_SITES = '1';
    if (flags['sites-file'] === true) throw new ArgusError(CODES.BAD_REQUEST, '--sites-file expects a path');
    if (typeof flags['sites-file'] === 'string') process.env.AURA_ARGUS_SITES = flags['sites-file'];
    await runMcp();
    return 0;
  }

  console.error(`unknown command: ${command}\n\n${USAGE}`);
  return 3;
}

main()
  .then((code) => { if (code !== null) process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(JSON.stringify(toErrorPayload(error)) + '\n');
    process.exitCode = exitCodeFor(error);
  });
