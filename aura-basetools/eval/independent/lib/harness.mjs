// Independent evaluation harness for the published npm package `aura-basetools@0.19.0`.
//
// Ground rules enforced here:
//   * the subject under test is a package installed from https://registry.npmjs.org into
//     `eval/independent/.vendor` (never the repository `src/` or `dist/`);
//   * every expectation is computed by this file / the suites with plain Node
//     fs/Buffer/string operations; no receipt from the tool under test is ever used as
//     an expected value;
//   * every case gets its own workspace directory and its own AURA_CACHE_DIR so the
//     observation cache, lock directory and transaction log cannot leak between cases.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const PKG_NAME = 'aura-basetools';
export const PKG_VERSION = '0.19.0';
export const REGISTRY = 'https://registry.npmjs.org';

// ---------------------------------------------------------------------------
// package resolution (npm-published artifact only)
// ---------------------------------------------------------------------------

export function packageCandidates(evalDir) {
  const out = [];
  if (process.env.AURA_EVAL_PKG) {
    out.push({ root: resolve(process.env.AURA_EVAL_PKG), origin: 'env:AURA_EVAL_PKG' });
  }
  out.push({ root: join(evalDir, '.vendor', 'node_modules', PKG_NAME), origin: 'npm-install' });
  return out;
}

export async function ensurePackage(evalDir) {
  for (const cand of packageCandidates(evalDir)) {
    const manifest = join(cand.root, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.version !== PKG_VERSION) {
        throw new Error(
          `resolved ${cand.root} is ${PKG_NAME}@${pkg.version}, expected ${PKG_VERSION}; ` +
            `remove it or point AURA_EVAL_PKG at the published ${PKG_VERSION}`,
        );
      }
      return { ...cand, manifest: pkg, provenance: readProvenance(evalDir, cand) };
    }
  }

  const vendor = join(evalDir, '.vendor');
  mkdirSync(vendor, { recursive: true });
  // Pin npm's project root to `.vendor`: without its own package.json npm walks up and
  // would install into the repository root (a side effect this harness must never cause).
  const vendorManifest = join(vendor, 'package.json');
  if (!existsSync(vendorManifest)) {
    writeFileSync(
      vendorManifest,
      JSON.stringify({ name: 'aura-basetools-eval-vendor', private: true, description: 'isolated install target for the published package under test' }, null, 2) + '\n',
      'utf8',
    );
  }
  const args = [
    'install',
    '--prefix',
    vendor,
    '--no-audit',
    '--no-fund',
    '--save-exact',
    `--registry=${REGISTRY}`,
    `${PKG_NAME}@${PKG_VERSION}`,
  ];
  // Spawn npm the portable way: node <npm-cli.js>. `spawn('npm.cmd')` without a shell is
  // EINVAL on Node >=20 for Windows, and shell:true would re-quote our argv.
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCmd = existsSync(npmCli) ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmArgs = existsSync(npmCli) ? [npmCli, ...args] : args;
  const res = await runProcess(npmCmd, npmArgs, { cwd: vendor, timeoutMs: 240000 });
  if (res.code !== 0) {
    throw new Error(
      `npm install ${PKG_NAME}@${PKG_VERSION} failed (exit ${res.code}):\n${res.stderr.slice(-2000)}`,
    );
  }
  const root = join(vendor, 'node_modules', PKG_NAME);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== PKG_VERSION) {
    throw new Error(`npm installed ${manifest.version}, expected ${PKG_VERSION}`);
  }
  return { root, origin: 'npm-install', manifest, provenance: readProvenance(evalDir, { root }) };
}

function readProvenance(evalDir, cand) {
  const lockCandidates = [
    join(evalDir, '.vendor', 'node_modules', '.package-lock.json'),
    join(evalDir, '.vendor', 'package-lock.json'),
  ];
  for (const f of lockCandidates) {
    if (!existsSync(f)) continue;
    try {
      const lock = JSON.parse(readFileSync(f, 'utf8'));
      const entry = lock.packages?.['node_modules/' + PKG_NAME];
      if (entry) {
        return {
          lockfile: f,
          resolved: entry.resolved ?? null,
          integrity: entry.integrity ?? null,
          version: entry.version ?? null,
        };
      }
    } catch {
      /* ignore malformed lockfile; provenance is evidence, not a gate */
    }
  }
  return { lockfile: null, resolved: null, integrity: null, version: cand.root ? null : null };
}

export function binPath(pkgRoot) {
  const bin = join(pkgRoot, 'bin', 'aura.mjs');
  if (!existsSync(bin)) throw new Error(`missing CLI entrypoint: ${bin}`);
  return bin;
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

export function runProcess(cmd, args, { cwd, env, timeoutMs = 90000, input } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolvePromise({ code: -1, stdout: '', stderr: String(err), durationMs: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    if (input != null) child.stdin.end(input);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: stderr + String(err), durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? -1,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

// A clean env: caller-set AURA_* knobs would silently change engine behaviour.
function baseEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('AURA_')) delete env[k];
  }
  delete env.NODE_OPTIONS;
  return env;
}
export const CLEAN_ENV = baseEnv();

// ---------------------------------------------------------------------------
// independent byte model (the oracle lives here, not in the tool)
// ---------------------------------------------------------------------------

const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Split a file buffer into BOM + lines, independently of the tool.
 * A trailing terminator produces a final empty "phantom" line (same model the tool's
 * receipts expose: "a\nb\n" is 3 lines, the last one empty and unaddressed by our cases).
 */
export function inspectBuffer(buf) {
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = hasBom ? buf.subarray(3) : buf;
  const lines = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0a) {
      const crlf = i > start && body[i - 1] === 0x0d;
      const contentEnd = crlf ? i - 1 : i;
      lines.push({ content: body.subarray(start, contentEnd), eol: body.subarray(contentEnd, i + 1) });
      start = i + 1;
    }
  }
  if (start < body.length) {
    lines.push({ content: body.subarray(start), eol: Buffer.alloc(0) });
  } else if (lines.length === 0 || start === body.length) {
    lines.push({ content: Buffer.alloc(0), eol: Buffer.alloc(0) });
  }
  return { hasBom, bom: hasBom ? buf.subarray(0, 3) : null, body, lines };
}

export function joinLines(parts, { bom, lines }) {
  const chunks = [];
  if (bom) chunks.push(BOM_BYTES);
  for (const line of lines) {
    chunks.push(line.content);
    if (line.eol && line.eol.length) chunks.push(line.eol);
  }
  return Buffer.concat(chunks);
}

/** Rebuild the buffer with line `oneBased`'s content replaced; terminator + BOM kept. */
export function replaceLineBuffer(buf, oneBased, nextContent) {
  const insp = inspectBuffer(buf);
  if (oneBased < 1 || oneBased > insp.lines.length) {
    throw new Error(`oracle: line ${oneBased} outside 1..${insp.lines.length}`);
  }
  const lines = insp.lines.map((line, i) =>
    i === oneBased - 1 ? { content: Buffer.from(nextContent, 'utf8'), eol: line.eol } : line,
  );
  return joinLines(null, { bom: insp.hasBom, lines });
}

/**
 * Rebuild the buffer with lines [startOneBased, endOneBased] replaced by `text`.
 * The block's own trailing terminator is kept; extra lines created by `text` adopt the
 * block's eol style (the `eol: auto` contract).
 */
export function replaceRangeBuffer(buf, startOneBased, endOneBased, text) {
  const insp = inspectBuffer(buf);
  const blockEol = insp.lines[endOneBased - 1].eol;
  const style = blockEol[0] === 0x0d ? '\r\n' : '\n';
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const inserted = raw.map((content, i) => ({
    content: Buffer.from(content, 'utf8'),
    eol: Buffer.from(i === raw.length - 1 ? (blockEol.length ? style : '') : style, 'utf8'),
  }));
  const lines = [...insp.lines.slice(0, startOneBased - 1), ...inserted, ...insp.lines.slice(endOneBased)];
  return joinLines(null, { bom: insp.hasBom, lines });
}

/** Number of lines a fuzz case may address: excludes the phantom empty line after a final EOL. */
export function editableLineCount(buf) {
  const insp = inspectBuffer(buf);
  const last = insp.lines[insp.lines.length - 1];
  if (insp.lines.length > 1 && last.content.length === 0 && last.eol.length === 0) {
    return insp.lines.length - 1;
  }
  return insp.lines.length;
}

/** Replace the single unique occurrence of `needle` in the byte stream (splice, not decode). */
export function spliceUniqueBytes(buf, needle, replacement) {
  const n = Buffer.from(needle, 'utf8');
  const first = buf.indexOf(n);
  if (first < 0) throw new Error('oracle: needle not present');
  if (buf.indexOf(n, first + 1) >= 0) throw new Error('oracle: needle is not unique');
  return Buffer.concat([buf.subarray(0, first), Buffer.from(replacement, 'utf8'), buf.subarray(first + n.length)]);
}

/** Model of `eol: auto` for a replacement string: adopt CRLF when the addressed region is CRLF. */
export function adaptEol(text, style) {
  const normalized = text.replace(/\r\n/g, '\n');
  return style === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

export function hex(buf, limit = 160) {
  const shown = buf.subarray(0, limit);
  const s = [...shown].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return buf.length > limit ? `${s} … (${buf.length} bytes)` : s;
}

export function escapeText(s) {
  return JSON.stringify(s.length > 400 ? `${s.slice(0, 400)}…` : s);
}

export function bufferDiff(expected, actual) {
  if (expected.equals(actual)) return null;
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
  const lo = Math.max(0, i - 24);
  return {
    firstDiffOffset: i,
    expectedLength: expected.length,
    actualLength: actual.length,
    expected: `${hex(expected.subarray(lo, i + 48))} @${lo}`,
    actual: `${hex(actual.subarray(lo, i + 48))} @${lo}`,
    expectedText: escapeText(expected.toString('utf8')),
    actualText: escapeText(actual.toString('utf8')),
  };
}

// ---------------------------------------------------------------------------
// case context
// ---------------------------------------------------------------------------

let caseSeq = 0;

export class CaseContext {
  constructor({ id, bin, workRoot }) {
    this.id = id;
    this.bin = bin;
    this.dir = join(workRoot, String(++caseSeq).padStart(3, '0'), id.replace(/[^a-zA-Z0-9_.-]+/g, '_'));
    this.cacheDir = join(this.dir, '.aura-cache');
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.cacheDir, { recursive: true });
    this.checks = [];
    this.commands = [];
    this.input = null;
    this.expectedSummary = null;
  }

  path(name) {
    return join(this.dir, name);
  }

  write(name, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    writeFileSync(this.path(name), buf);
    return buf;
  }

  read(name) {
    return readFileSync(this.path(name));
  }

  exists(name) {
    return existsSync(this.path(name));
  }

  /** Run `aura basetools <args>` in this case's workspace with a clean, isolated env. */
  async cli(args, opts = {}) {
    const argv = [this.bin, 'basetools', ...args];
    const res = await runProcess(process.execPath, argv, {
      cwd: opts.cwd ?? this.dir,
      env: { ...CLEAN_ENV, AURA_CACHE_DIR: opts.cacheDir ?? this.cacheDir },
      timeoutMs: opts.timeoutMs ?? 90000,
    });
    const record = {
      argv: ['aura', 'basetools', ...args],
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: res.durationMs,
    };
    let json = null;
    try {
      json = JSON.parse(res.stdout.trim());
    } catch {
      json = null;
    }
    record.json = json;
    record.parseFailed = json === null;
    this.commands.push(record);
    return record;
  }

  async cliOk(args, opts) {
    const r = await this.cli(args, opts);
    this.check(`cli exit=0 (${args[0]})`, r.code === 0, { expected: 0, actual: r.code });
    this.check(`cli receipt ok=true (${args[0]})`, r.json?.ok === true, {
      expected: true,
      actual: r.parseFailed ? '<stdout not JSON>' : r.json?.ok,
    });
    return r;
  }

  check(name, ok, detail = {}) {
    this.checks.push({
      name,
      ok: Boolean(ok),
      expected: detail.expected === undefined ? null : detail.expected,
      actual: detail.actual === undefined ? null : detail.actual,
    });
    return Boolean(ok);
  }

  eq(name, expected, actual) {
    return this.check(name, Object.is(expected, actual), { expected, actual });
  }

  deepEq(name, expected, actual) {
    const e = JSON.stringify(expected);
    const a = JSON.stringify(actual);
    return this.check(name, e === a, { expected: e, actual: a });
  }

  eqBytes(name, expected, actual) {
    const diff = bufferDiff(expected, actual);
    return this.check(name, diff === null, {
      expected: diff ? diff.expected : hex(expected),
      actual: diff ? diff.actual : hex(actual),
    });
  }

  setInput(summary) {
    this.input = summary;
  }

  setExpected(summary) {
    this.expectedSummary = summary;
  }

  /** Compact repro for the report: the workspace is a temp dir created by run.mjs. */
  repro() {
    const failing = this.commands.find((c) => c.code !== 0);
    const cmd = failing ?? this.commands[this.commands.length - 1];
    if (!cmd) return null;
    return `cd <case-workspace> && node <pkg>/bin/aura.mjs ${cmd.argv.slice(1).map(shellish).join(' ')}`;
  }
}

function shellish(a) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(a)) return a;
  return `"${a.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// MCP client (stdio, newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

export class McpClient {
  constructor({ bin, cwd, cacheDir, timeoutMs = 30000 }) {
    this.child = spawn(process.execPath, [bin, 'basetools', 'mcp'], {
      cwd,
      env: { ...CLEAN_ENV, AURA_CACHE_DIR: cacheDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pending = new Map();
    this.nextId = 0;
    this.junk = [];
    this.stderr = '';
    this.buf = '';
    this.closed = false;
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => (this.stderr += d.toString('utf8')));
    this.child.on('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('MCP server closed'));
      }
      this.pending.clear();
    });
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.junk.push(line.slice(0, 200));
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  }

  rpc(method, params, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout on ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args) {
    const msg = await this.rpc('tools/call', { name, arguments: args });
    const result = msg.result ?? {};
    const text = result.content?.[0]?.text ?? '';
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { msg, result, text, json, isError: result.isError === true };
  }

  async close() {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise((r) => {
      const t = setTimeout(() => {
        this.child.kill('SIGKILL');
        r();
      }, 2000);
      this.child.on('close', () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// naive baseline (explicitly NOT the DSH built-in tools; labelled in the report)
// ---------------------------------------------------------------------------

export const naiveBaseline = {
  label: 'naive-whole-file-read + exact-string-replace + whole-file-write (this eval writes it; not DSH)',
  /** The literal required baseline: read whole file as text, replace a substring, write it back. */
  exactReplace(file, needle, replacement) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(needle)) throw new Error('baseline: needle not found');
    writeFileSync(file, text.replace(needle, replacement), 'utf8');
  },
  /** The way naive tools do a line-addressed edit: split on newlines, join back with "\n". */
  lineReplace(file, oneBased, nextLineText) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    lines[oneBased - 1] = nextLineText;
    writeFileSync(file, lines.join('\n'), 'utf8');
  },
  /** Read-modify-write with no staleness check at all. */
  staleOverwrite(file, needle, replacement) {
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace(needle, replacement), 'utf8');
  },
};

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export function makeWorkRoot() {
  const root = join(tmpdir(), `aura-basetools-eval-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

export function cleanupWorkRoot(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort; /tmp gets cleaned by the OS */
  }
}

export function findingCounts(cases) {
  const total = cases.length;
  const passed = cases.filter((c) => c.pass).length;
  return { total, passed, failed: total - passed };
}

export function dirOf(p) {
  return dirname(p);
}

export { BOM_BYTES };
