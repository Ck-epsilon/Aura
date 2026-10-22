#!/usr/bin/env node
// AuraArgus CLI：search / fetch / sources / doctor / serve / mcp
import { search, searchBatch, fetchDocument, listEntities, version, ArgusError, CODES, toErrorPayload } from './core.mjs';
import { checkSources } from './lib/doctor.mjs';
import { startServer } from './lib/server.mjs';
import { runMcp } from './lib/mcp.mjs';

const USAGE = `aura-argus ${version}

Usage:
  aura-argus search <question...> [--max-sources 3] [--json|--text] [--no-cache] [--fallback] [--site domain] [--timeout ms]
  echo '["q1","q2"]' | aura-argus search --batch [--concurrency 3]
  aura-argus fetch <url> [--max-chars 20000] [--format markdown|text] [--json] [--allow-private]
  aura-argus sources
  aura-argus doctor [--json]
  aura-argus serve [--port 8787] [--host 127.0.0.1] [--token <t>] [--allow-private]
  aura-argus mcp [--allow-private]

Exit codes:
  0 ok   2 no evidence   3 bad args   4 network/fetch failure   130 interrupted`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const boolean = new Set(['json', 'text', 'no-cache', 'no-fallback', 'fallback', 'explain', 'help', 'version', 'batch', 'allow-private']);
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function searchText(result) {
  const lines = [`? ${result.question}`, `entity: ${result.entity ?? '(none)'} · mode: ${result.mode} · ${result.tookMs}ms${result.cached ? ' · cached' : ''}`];
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

  if (flags.version || command === 'version') { console.log(version); return 0; }
  if (flags.help || command === 'help') { console.log(USAGE); return 0; }

  if (command === 'search') {
    if (flags.batch) {
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
        maxSources: Number(flags['max-sources'] ?? flags.maxSources ?? 3),
        cache: !flags['no-cache'],
        fallback: flags.fallback === true && flags['no-fallback'] !== true,
        site: typeof flags.site === 'string' ? flags.site : undefined,
        timeoutMs: Number(flags.timeout ?? 12_000),
        budgetMs: Number(flags.budget ?? 0),
      });
      if (flags.text) results.forEach((result) => console.log(searchText(result) + '\n'));
      else jsonOut(results);
      if (results.some((result) => result.evidence?.length)) return 0;
      if (results.some((result) => result.error)) return 4;
      return 2;
    }
    const question = positional.join(' ').trim();
    if (!question) { console.error(USAGE); return 3; }
    const result = await search(question, {
      maxSources: Number(flags['max-sources'] ?? flags.maxSources ?? 3),
      cache: !flags['no-cache'],
      fallback: flags.fallback === true && flags['no-fallback'] !== true,
      site: typeof flags.site === 'string' ? flags.site : undefined,
      timeoutMs: Number(flags.timeout ?? 12_000),
    });
    if (flags.text) console.log(searchText(result));
    else jsonOut(result);
    if (result.error) return 4;
    return result.evidence.length ? 0 : 2;
  }

  if (command === 'fetch') {
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

  if (command === 'sources') {
    jsonOut({ version, entities: listEntities() });
    return 0;
  }

  if (command === 'doctor') {
    const rows = await checkSources({ timeoutMs: Number(flags.timeout ?? 12_000) });
    const failed = rows.filter((row) => !row.ok);
    if (flags.json) jsonOut({ ok: failed.length === 0, total: rows.length, failed: failed.length, rows });
    else {
      for (const row of rows) {
        console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${String(row.entity).padEnd(12)} ${String(row.status ?? row.code).padEnd(6)} ${String(row.bytes ?? '').padStart(8)}B ${String(row.ms).padStart(6)}ms ${row.url}`);
      }
      console.log(`\n${rows.length - failed.length}/${rows.length} sources reachable`);
    }
    return failed.length ? 2 : 0;
  }

  if (command === 'serve') {
    const { server, url } = await startServer({
      port: Number(flags.port ?? 8787),
      host: String(flags.host ?? '127.0.0.1'),
      token: flags.token ? String(flags.token) : null,
      allowPrivate: Boolean(flags['allow-private']),
    });
    jsonOut({ ok: true, url });
    const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return null;
  }

  if (command === 'mcp') {
    if (flags['allow-private']) process.env.AURA_ARGUS_ALLOW_PRIVATE = '1';
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
