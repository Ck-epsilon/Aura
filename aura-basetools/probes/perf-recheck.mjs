/**
 * perf-recheck.mjs —— fs-contract-v2 / R3 的**独立复算**探针（复算方自写，不 import perf-baseline.mjs）。
 *
 * 目的不是把 R3 再量一遍，而是用**另一套语料 + 另一条编排 + 另一些判据**去撞 R3 自报里
 * 那几个具体数字与结论。凡与 perf-baseline.mjs 相同的地方只有两处，且都是被引擎 API 逼出来的：
 *   · 冷启动必须换新进程（进程内缓存是内容键记忆化，同内容第二次必命中）；
 *   · 写侧编排顺序照 DSH 壳 `aura-edit/index.js`（stat → readText → bom → planHunks →
 *     regionGate → writeText → verifyWriteBack → rememberRead）。
 *
 * 复算什么（每一项都能单独判对错）：
 *   P1 记忆化悬崖：自己的 7 行块语料，est = src*4 + tokens*64 + symbols*192 + pairs*48，
 *      看「第 2 次 indexStructure 是否 ≈ 0」与「est 是否跨过 32 MiB」是否同步翻转。
 *   P2 读侧矩阵：1000 / 10000 / 30000 / 90000 行全模式冷+热；100000 行只量 lines（该档每次调用都是重建）。
 *   P3 外层固定税：裸 node / node+引擎 / 裸 pwsh / pwsh→node / pwsh→node→引擎 /
 *      pwsh→node→引擎→**真 map 读**（虚拟路径带 .mjs）、以及同一条链**不带扩展名**的对照。
 *      C6 的对照项是 R3 自报里最可疑的一格（自报 map 冷读 8.40ms，而 90001 行档 map 冷是秒级）。
 *   P4 写侧：1001 / 10001 / 90001 行两行改动，①读+BOM ②planHunks ③regionGate ④落盘 ⑤回读校验 + 端到端，
 *      外加 applyEditToProvider（引擎自带的一次性入口，另一条编排）的端到端做旁证。
 *
 * 用法：node aura-tools/probes/perf-recheck.mjs [--reps=3] [--outer-reps=9] [--write-reps=5]
 * 退出码恒 0（探针不是判据；取不到就报 n/a 与原因）。只读：不改引擎、不写仓库（语料在系统临时目录）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pkgPath } from '../build/pkg-root.mjs'

const say = (m = '') => fs.writeSync(1, `${m}\n`)
const now = () => performance.now()
const SELF = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SELF), '..', '..')
const CORE = pkgPath('src', 'locator-lab')
const url = (f) => pathToFileURL(path.join(CORE, f)).href


// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--reps', '--outer-reps', '--write-reps', '--input-type'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/perf-recheck.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit === undefined ? d : hit.slice(n.length + 3)
}
const num = (s, d) => (Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : d)
const REPS = Math.round(num(argOf('reps', '3'), 3))
const OUTER_REPS = Math.round(num(argOf('outer-reps', '9'), 9))
const WRITE_REPS = Math.round(num(argOf('write-reps', '5'), 5))
const MREPS = 20
const SIZES = String(argOf('sizes', '1000,10000,30000,90000,100000')).split(',').map(Number)
const WRITE_SIZES = String(argOf('write-sizes', '1000,10000,90000')).split(',').map(Number)
const TMP = path.join(os.tmpdir(), 'r3-recheck')
const OUT = argOf('out', null)

const sorted = (xs) => [...xs].sort((a, b) => a - b)
const pct = (xs, p) => (xs.length === 0 ? null : sorted(xs)[Math.min(xs.length - 1, Math.max(0, Math.floor(xs.length * p)))])
const stat = (xs) => (xs.length === 0 ? null : { n: xs.length, min: Math.min(...xs), p50: pct(xs, 0.5), p90: pct(xs, 0.9), max: Math.max(...xs), all: xs })
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : (Math.round(v * 100) / 100).toFixed(2))
const padR = (s, n) => String(s ?? '').padEnd(n)
const padL = (s, n) => String(s ?? '').padStart(n)
const fmtS = (s, w = 22) => (s === null ? padL('n/a', w) : padL(`${r2(s.p50)} [${r2(s.min)}..${r2(s.max)}] n=${s.n}`, w))

// ══════════════════════════════════════════════════════════════════════════════
//  自己的语料：7 行一块（与 R3 的 11 行块形状不同，故意）
// ══════════════════════════════════════════════════════════════════════════════
const BLOCK = 7
const HEADS = {
  unit: ['/** rc 头 */', 'export function rootPick(value) {', '  return value % 4096', '}', 'export class RootHolder {', '  constructor(seed) { this.seed = seed }', '  next() { return rootPick(this.seed) }', '}'],
  node: ['/** rc 头 n */', 'export function basePick(value) {', '  return value % 4096', '}', 'export class BaseHolder {', '  constructor(seed) { this.seed = seed }', '  next() { return basePick(this.seed) }', '}'],
  item: ['/** rc 头 i */', 'export function corePick(value) {', '  return value % 4096', '}', 'export class CoreHolder {', '  constructor(seed) { this.seed = seed }', '  next() { return corePick(this.seed) }', '}'],
}
const TAILS = {
  unit: ['export function finish(value) {', '  return value % 11', '}'],
  node: ['export function tailFn(value) {', '  return value % 13', '}'],
  item: ['export function endFn(value) {', '  return value % 17', '}'],
}
/** 第 b 块（prefix 决定块内名字，两行体里文本全文件唯一）。 */
function block(prefix, b) {
  const k = (b % 89) + 2
  return [
    `/** ${prefix} ${b} */`,
    `export function ${prefix}${b}(value) {`,
    `  const scaled${prefix}${b} = value * ${k}`,
    `  if (scaled${prefix}${b} > 4096) return scaled${prefix}${b} - 1`,
    `  return scaled${prefix}${b} % 4096`,
    `}`,
    ``,
  ]
}
/** 行数**正好** n（split(/\n/).length === n+1）。 */
function writeCorpus(file, prefix, n) {
  const head = HEADS[prefix]
  const tail = TAILS[prefix]
  const full = Math.max(1, Math.floor((n - head.length - tail.length) / BLOCK))
  const used = head.length + full * BLOCK + tail.length
  const pad = n - used
  let body = `${[...head, ...Array.from({ length: full }, (_, b) => block(prefix, b)).flat(), ...tail].join('\n')}\n`
  if (pad > 0) body += '\n'.repeat(pad)
  fs.writeFileSync(file, body)
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).length - 1
  return { file, prefix, n, full, lines, ok: lines === n }
}
/** 第 b 块的函数签名行（1-based）与体内两行。 */
function blockAt(prefix, n, b) {
  const head = HEADS[prefix].length
  const decl = head + b * BLOCK + 2
  return { name: `${prefix}${b}`, decl, bodyA: decl + 1, bodyB: decl + 3 }
}
function pickBlock(n) {
  return Math.max(1, Math.floor(n / 3 / BLOCK))
}

// ── 进程/负载快照（自己的实现；与 R3 无关，只为「计时单前提」） ────────────────
const PS = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
function procCounts() {
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="SilentlyContinue"; "$(@(Get-Process node).Count) $(@(Get-Process pwsh).Count)"'], { encoding: 'utf8', windowsHide: true })
  const m = String(r.stdout ?? '').trim().match(/^(\d+)\s+(\d+)$/)
  return m === null ? { node: null, pwsh: null } : { node: Number(m[1]), pwsh: Number(m[2]) }
}
function counters() {
  const ps = '$ErrorActionPreference="SilentlyContinue"; try { $s=(Get-Counter "\\Memory\\Available MBytes","\\Processor(_Total)\\% Processor Time" -ErrorAction Stop).CounterSamples; ($s | ForEach-Object { "{0}={1:N1}" -f $_.Path.Split("\\")[-1], $_.CookedValue }) -join " " } catch { "counter-unavailable" }'
  const r = spawnSync(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  return String(r.stdout ?? '').trim() || 'counter-unavailable'
}

const shapeOf = (env) => {
  const text = typeof env?.text === 'string' ? env.text : ''
  let json = 0
  try {
    json = Buffer.byteLength(JSON.stringify(env), 'utf8')
  } catch {
    json = -1
  }
  return { ok: env?.ok === true, code: env?.code ?? null, textChars: text.length, jsonBytes: json, truncated: env?.truncated === undefined ? null : env.truncated, auto: env?.auto ?? null, version: typeof env?.version === 'string' ? env.version : null }
}

// ══════════════════════════════════════════════════════════════════════════════
//  子进程：RC_JOB=read | write | one
// ══════════════════════════════════════════════════════════════════════════════
const JOB = process.env.RC_JOB
const T0 = now()

async function childRead() {
  const cfg = JSON.parse(fs.readFileSync(process.env.RC_CFG, 'utf8'))
  const tImport = now()
  const { readWith, contentToken } = await import(url('read-core.mjs'))
  const { indexStructure, langOf } = await import(url('struct-core.mjs'))
  const importMs = now() - tImport
  const out = { job: 'read', n: cfg.n, importMs, phases: {} }

  // ── P2 读侧矩阵：语料 A（这份内容在本进程里第一次被索引 = 冷） ──────────────
  const srcA = fs.readFileSync(cfg.fileA, 'utf8')
  const totalLines = srcA.split(/\r?\n/).length - 1
  const mid = Math.max(2, Math.floor(totalLines / 2))
  const blk = blockAt(cfg.prefixA, cfg.n, pickBlock(cfg.n))
  const vpathA = `E:\\r3rc\\A-${cfg.n}.mjs`
  const plan = {
    map: {},
    digest: {},
    around: { around: blk.name },
    lines: { lines: [mid, mid + 39] },
    search: { search: `scaled${cfg.prefixA}${pickBlock(cfg.n)}` },
    full: {},
    changed: { since: null },
  }
  const seed = (() => {
    const a = now()
    const env = readWith(srcA, { mode: 'lines', filePath: `${vpathA}#seed`, lines: [1, 5] })
    return { ms: now() - a, shape: shapeOf(env) }
  })()
  out.phases.seed = seed
  const token = seed.shape.version
  const modes = cfg.modes
  const matrix = {}
  for (const mode of modes) {
    const req = { mode, filePath: vpathA, ...plan[mode] }
    if (mode === 'changed') req.since = token
    const a = now()
    const env = readWith(srcA, req)
    const coldMs = now() - a
    const cshape = shapeOf(env)
    if (cshape.ok !== true) {
      matrix[mode] = { error: `${cshape.code}`, coldMs }
      continue
    }
    const hot = []
    for (let i = 0; i < cfg.reps; i += 1) {
      const b = now()
      const e2 = readWith(srcA, req)
      hot.push(now() - b)
      if (e2.ok !== true) break
    }
    matrix[mode] = { coldMs, hotMs: hot, coldShape: cshape, hotShape: shapeOf(readWith(srcA, req)) }
  }
  out.phases.matrix = { totalLines, target: blk.name, vpath: vpathA, matrix }

  // ── P1 记忆化悬崖：语料 B（全新内容 ⇒ 本进程第一次索引必然是冷） ────────────
  const srcB = fs.readFileSync(cfg.fileB, 'utf8')
  const langB = langOf(`E:\\r3rc\\B-${cfg.n}.mjs`)
  const a1 = now()
  const idx1 = indexStructure(srcB, langB)
  const build1 = now() - a1
  const a2 = now()
  const idx2 = indexStructure(srcB, langB)
  const build2 = now() - a2
  const a3 = now()
  const idx3 = indexStructure(srcB, langB)
  const build3 = now() - a3
  const est = srcB.length * 4 + idx1.tokens.length * 64 + idx1.symbols.length * 192 + idx1.pairs.size * 48
  out.phases.cliff = {
    chars: srcB.length,
    tokens: idx1.tokens.length,
    symbols: idx1.symbols.length,
    pairs: idx1.pairs.size,
    estBytes: est,
    estMiB: Number((est / 2 ** 20).toFixed(2)),
    capMiB: 32,
    build1,
    build2,
    build3,
    sameSymbols: idx2.symbols.length === idx1.symbols.length && idx3.symbols.length === idx1.symbols.length,
    verdict: build2 < build1 * 0.05 ? 'HIT(memoized)' : 'MISS(rebuilt)',
    vpathB: `E:\\r3rc\\B-${cfg.n}.mjs`,
  }
  // 同一份内容（语料 B）：两次 readWith(lines)，看记忆化是否让第 2 次变快
  const bReq = { mode: 'lines', filePath: out.phases.cliff.vpathB, lines: [mid, mid + 39] }
  const c1 = now()
  const e1 = readWith(srcB, bReq)
  const read1 = now() - c1
  const c2 = now()
  const e2r = readWith(srcB, bReq)
  const read2 = now() - c2
  out.phases.cliff.readWith1 = read1
  out.phases.cliff.readWith2 = read2
  out.phases.cliff.readWithOk = [e1.ok === true, e2r.ok === true]

  // ── P3 对照：同内容、同模式，只把虚拟路径的扩展名去掉 ───────────────────────
  const srcC = fs.readFileSync(cfg.fileC, 'utf8')
  const d1 = now()
  const noext = readWith(srcC, { mode: 'map', filePath: 'E:\\r3rc\\outer' })
  const noextMs = now() - d1
  const d2 = now()
  const withext = readWith(srcC, { mode: 'map', filePath: `E:\\r3rc\\C-${cfg.n}.mjs` })
  const extMs = now() - d2
  out.phases.noext = {
    noextMs,
    noextShape: shapeOf(noext),
    extMs,
    extShape: shapeOf(withext),
    langNullForNoExt: langOf('E:\\r3rc\\outer') === null,
  }

  // ── 交付体量：digest 在最大档（不受内容预算约束的那一格） ───────────────────
  const g = readWith(srcC, { mode: 'digest', filePath: `E:\\r3rc\\C-${cfg.n}.mjs` })
  out.phases.digest = shapeOf(g)
  fs.writeSync(1, `\n@@RC@@${JSON.stringify(out)}\n`)
}

async function childWrite() {
  const cfg = JSON.parse(fs.readFileSync(process.env.RC_CFG, 'utf8'))
  const tImport = now()
  const { rememberRead, contentToken, BYTE_ORDER_MARK } = await import(url('read-core.mjs'))
  const {
    planHunks, regionGate, fileByteOrderMarkCount, carryingByteOrderMarks,
    verifyWriteBack, providerView, applyEditToProvider,
  } = await import(url('write-path.mjs'))
  const importMs = now() - tImport

  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8', { fatal: true })
  const versionOf = (p) => `v${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`
  /** 与 DSH 壳 ctx.fs（dsh-fs-local）同形状：target 对象、readText 剥一个前导 BOM、writeText 整份写。 */
  const provider = {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version: versionOf(t.targetKey), type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
    readText: async (t) => {
      if (!fs.existsSync(t.targetKey)) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' })
      return dec.decode(fs.readFileSync(t.targetKey))
    },
    readByteRange: async (t, range) => fs.readFileSync(t.targetKey).subarray(range.offset, range.offset + range.length),
    writeText: async (t, content, expected) => {
      if (expected?.kind === 'replaceIfVersion' && versionOf(t.targetKey) !== expected.version) {
        throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
      }
      fs.writeFileSync(t.targetKey, Buffer.from(enc.encode(content)))
      return { version: versionOf(t.targetKey), operation: 'update', after: content }
    },
  }

  const target = { displayPath: cfg.work, targetKey: cfg.work }
  const blk = blockAt(cfg.prefix, cfg.n, pickBlock(cfg.n))
  const mk = (src, round) => {
    const rows = src.split(/\r?\n/)
    return [blk.bodyA, blk.bodyB].map((ln, i) => ({
      line: ln,
      old: rows[ln - 1],
      replace: `  const rc${round}_${i} = ${round} // ${i}`,
    }))
  }

  const stage = { read: [], bom: [], plan: [], gate: [], disk: [], verify: [], e2e: [] }
  let boms = 0
  const edit = async (round) => {
    const t0 = now()
    const a1 = now()
    const content = await provider.readText(target)
    stage.read.push(now() - a1)
    const a2 = now()
    boms = await fileByteOrderMarkCount(provider, target, undefined)
    const info = await provider.stat(target)
    stage.bom.push(now() - a2)
    const hunks = mk(content, round)
    const a3 = now()
    const planned = planHunks(content, hunks, cfg.work)
    stage.plan.push(now() - a3)
    const a4 = now()
    const gate = regionGate(hunks, content, planned, cfg.work, { byteOrderMark: boms > 0 })
    stage.gate.push(now() - a4)
    if (gate.clean !== true) throw new Error(`gate refused: ${gate.message}`)
    const next = carryingByteOrderMarks(planned.content, boms)
    const a5 = now()
    await provider.writeText(target, next, { kind: 'replaceIfVersion', version: info.version })
    stage.disk.push(now() - a5)
    const a6 = now()
    await verifyWriteBack(provider, target, next, cfg.work)
    stage.verify.push(now() - a6)
    const view = providerView(next)
    rememberRead(cfg.work, contentToken(view, next.startsWith(BYTE_ORDER_MARK)), view, next.startsWith(BYTE_ORDER_MARK))
    stage.e2e.push(now() - t0)
  }

  // 预热文件系统缓存（真调用里「刚被读过」是常态）
  fs.statSync(cfg.work)
  fs.readFileSync(cfg.work)
  for (let r = 0; r < cfg.reps; r += 1) await edit(r + 1)

  // 微基准（µs/次）：同一份「已含本轮改动」的内容
  const finalText = dec.decode(fs.readFileSync(cfg.work))
  const finalRows = finalText.split(/\r?\n/)
  const microHunks = [blk.bodyA, blk.bodyB].map((ln, i) => ({ old: finalRows[ln - 1], replace: `  const micro_${i} = 1 // ${i}` }))
  const microPlanned = planHunks(finalText, microHunks, cfg.work)
  const micro = { _n: MREPS }
  const loop = (label, fn) => {
    const t = now()
    for (let i = 0; i < MREPS; i += 1) fn()
    micro[label] = ((now() - t) / MREPS) * 1000
  }
  loop('planHunks', () => planHunks(finalText, microHunks, cfg.work))
  loop('regionGate(ledger=empty)', () => regionGate(microHunks, finalText, microPlanned, `${cfg.work}#none`, { byteOrderMark: false }))
  loop('regionGate(ledger=set)', () => regionGate(microHunks, finalText, microPlanned, cfg.work, { byteOrderMark: false }))
  loop('verifyWriteBack', () => verifyWriteBack(provider, target, finalText, cfg.work))
  loop('contentToken', () => contentToken(finalText, false))
  loop('CTRL fs.writeFileSync+readFileSync', () => {
    fs.writeFileSync(cfg.work, Buffer.from(enc.encode(finalText)))
    fs.readFileSync(cfg.work)
  })
  loop('CTRL fs.writeFileSync only', () => fs.writeFileSync(cfg.work, Buffer.from(enc.encode(finalText))))
  loop('CTRL fs.readFileSync only', () => fs.readFileSync(cfg.work))

  // 旁证：引擎自带的一次性入口（另一条编排）
  const apath = `${cfg.work}.apply`
  fs.copyFileSync(cfg.work, apath)
  const ap = {
    resolve: async (p) => p,
    stat: async (p) => (fs.existsSync(p) ? { version: `v${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`, type: 'file', size: fs.statSync(p).size } : undefined),
    readText: async (p) => dec.decode(fs.readFileSync(p)),
    readByteRange: async (p, range) => fs.readFileSync(p).subarray(range.offset, range.offset + range.length),
    writeText: async (p, content) => {
      fs.writeFileSync(p, Buffer.from(enc.encode(content)))
      return { version: `v${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}`, operation: 'update', after: content }
    },
  }
  const applyE2E = []
  for (let r = 0; r < cfg.reps; r += 1) {
    const cur = dec.decode(fs.readFileSync(apath))
    const rows = cur.split(/\r?\n/)
    const hs = [blk.bodyA, blk.bodyB].map((ln, i) => ({ line: ln, old: rows[ln - 1], replace: `  const ap${r}_${i} = ${r} // ${i}` }))
    const t = now()
    await applyEditToProvider(ap, { displayPath: apath, hunks: hs })
    applyE2E.push(now() - t)
  }

  fs.writeSync(1, `\n@@RC@@${JSON.stringify({
    job: 'write', n: cfg.n, importMs, stage, micro,
    applyE2E,
    finalLines: finalText.split(/\r?\n/).length,
    gateClean: true,
    applied: 1,
  })}\n`)
}

async function childOne() {
  const cfg = JSON.parse(fs.readFileSync(process.env.RC_CFG, 'utf8'))
  const tImport = now()
  const { readWith } = await import(url('read-core.mjs'))
  const importMs = now() - tImport
  const src = fs.readFileSync(cfg.file, 'utf8')
  const a = now()
  const env = readWith(src, { mode: 'map', filePath: cfg.vpath })
  const mapMs = now() - a
  fs.writeSync(1, `\n@@RC@@${JSON.stringify({ job: 'one', importMs, mapMs, totalMs: now() - T0, shape: shapeOf(env), n: cfg.n })}\n`)
}

function spawnChild(job, cfg) {
  const f = path.join(TMP, `cfg-${job}-${cfg.tag}.json`)
  fs.writeFileSync(f, JSON.stringify(cfg))
  const r = spawnSync(process.execPath, [SELF], {
    encoding: 'utf8', windowsHide: true, cwd: REPO, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, RC_JOB: job, RC_CFG: f },
  })
  const body = String(r.stdout ?? '')
  const at = body.lastIndexOf('@@RC@@')
  let data = null
  if (at !== -1) {
    try {
      data = JSON.parse(body.slice(at + 6).trim())
    } catch {
      data = null
    }
  }
  return { ok: data !== null, data, status: r.status, stderr: String(r.stderr ?? '').slice(-600) }
}

function spawnMs(exe, args, env = {}) {
  const a = now()
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, cwd: REPO, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } })
  return { ms: now() - a, status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '').slice(-300) }
}

// ══════════════════════════════════════════════════════════════════════════════
//  父进程
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  const tStart = now()
  fs.mkdirSync(TMP, { recursive: true })
  say('='.repeat(100))
  say(' R3 独立复算（perf-recheck）—— 自写语料 / 自写编排，不 import 被测探针')
  say('='.repeat(100))
  const live = procCounts()
  say(`  时间=${new Date().toISOString()}  node=${process.version}  核=${os.cpus().length}  内存=${(os.totalmem() / 2 ** 30).toFixed(1)} GiB`)
  say(`  跑前进程数：node.exe=${live.node}  pwsh.exe=${live.pwsh}   性能计数器：${counters()}`)
  say(`  重复：热=${REPS} 外层税=${OUTER_REPS} 写侧=${WRITE_REPS} 微基准=${MREPS} 尺寸=${SIZES.join('/')}`)
  say(`  临时目录=${TMP}`)

  // 语料：每个尺寸三份不同内容（A 读矩阵 / B 记忆化悬崖 / C 扩展名对照 + digest 体量）
  const corpus = {}
  say('')
  say('【语料】自写 7 行块（每块一个可寻址导出函数 + 空行分隔）')
  for (const n of SIZES) {
    corpus[n] = {}
    for (const [prefix, key] of [['unit', 'A'], ['node', 'B'], ['item', 'C']]) {
      const f = path.join(TMP, `rc-${key}-${n}.mjs`)
      const info = writeCorpus(f, prefix, n)
      corpus[n][key] = { ...info, prefix, size: fs.statSync(f).size }
    }
    const c = corpus[n].A
    say(`  n=${padL(n, 7)}  ${c.lines} 行  ${padL(c.size, 9)} B/份  三份合计 ${padL(corpus[n].A.size + corpus[n].B.size + corpus[n].C.size, 9)} B  目标函数=${blockAt('unit', n, pickBlock(n)).name}@${blockAt('unit', n, pickBlock(n)).decl}`)
  }

  // ── P2/P1/P3(扩展名对照) 读侧 ──────────────────────────────────────────────
  say('')
  say('─'.repeat(100))
  say(' P2 读侧矩阵（冷=新进程里对这份内容的第一次调用；热=同进程第 2..N 次）')
  say('─'.repeat(100))
  const readRuns = []
  for (const n of SIZES) {
    const modes = n >= 100000 ? ['lines'] : ['map', 'digest', 'around', 'lines', 'search', 'full', 'changed']
    const cfg = {
      tag: `r-${n}`, n,
      fileA: corpus[n].A.file, prefixA: corpus[n].A.prefix,
      fileB: corpus[n].B.file, fileC: corpus[n].C.file,
      modes, reps: REPS,
    }
    const before = procCounts()
    process.stderr.write(`  [read] n=${n} …`)
    const r = spawnChild('read', cfg)
    const after = procCounts()
    process.stderr.write(r.ok ? ' ok\n' : ` 失败 status=${r.status} ${r.stderr.slice(-200)}\n`)
    readRuns.push({ n, r, before, after })
  }
  const cRun = readRuns.find((x) => x.n === SIZES[SIZES.length - 1])
  const sizeCols = readRuns.map((x) => x.n)
  say('')
  say(`  ${padR('mode', 9)}${sizeCols.map((s) => padL(`冷 n=${s}`, 22)).join('')}`)
  for (const mode of ['map', 'digest', 'around', 'lines', 'search', 'full', 'changed']) {
    const cells = readRuns.map((x) => {
      const m = x.r.data?.phases?.matrix?.matrix?.[mode]
      if (m === undefined) return padL('-', 22)
      if (m.error !== undefined) return padL(`ERR ${m.error}`, 22)
      return padL(`${r2(m.coldMs)}`, 22)
    })
    say(`  ${padR(mode, 9)}${cells.join('')}`)
  }
  say('')
  say(`  ${padR('mode', 9)}${sizeCols.map((s) => padL(`热 p50[min..max] n=${s}`, 34)).join('')}`)
  for (const mode of ['map', 'digest', 'around', 'lines', 'search', 'full', 'changed']) {
    const cells = readRuns.map((x) => {
      const m = x.r.data?.phases?.matrix?.matrix?.[mode]
      if (m === undefined) return padL('-', 34)
      if (m.error !== undefined) return padL(`ERR ${m.error}`, 34)
      return padL(fmtS(stat(m.hotMs), 34), 34)
    })
    say(`  ${padR(mode, 9)}${cells.join('')}`)
  }
  say('')
  say('  P2b 交付体量（text 字符 / 回执 JSON 字节，冷调用）与 digest 体量')
  for (const x of readRuns) {
    const mm = x.r.data?.phases?.matrix?.matrix ?? {}
    const parts = Object.entries(mm).map(([k, v]) => `${k}:text=${v.coldShape?.textChars ?? 'n/a'} json=${v.coldShape?.jsonBytes ?? 'n/a'}`)
    const dg = x.r.data?.phases?.digest
    say(`    n=${padL(x.n, 7)} ${parts.join('  ')}`)
    say(`    ${' '.repeat(9)}digest: text=${dg?.textChars} json=${dg?.jsonBytes}`)
  }
  say('')
  say('  P1 记忆化悬崖（语料 B，本进程全新内容：第 1 次 indexStructure 必是冷建）')
  say(`    ${padR('n', 8)}${padL('chars', 10)}${padL('tokens', 9)}${padL('symbols', 9)}${padL('pairs', 8)}${padL('est MiB', 10)}${padL('build1 ms', 11)}${padL('build2 ms', 11)}${padL('build3 ms', 11)}${padL('第2次/第1次', 12)}  判据`)
  for (const x of readRuns) {
    const c = x.r.data?.phases?.cliff
    if (c === undefined) continue
    say(`    ${padL(x.n, 8)}${padL(c.chars, 10)}${padL(c.tokens, 9)}${padL(c.symbols, 9)}${padL(c.pairs, 8)}${padL(c.estMiB, 10)}${padL(r2(c.build1), 11)}${padL(r2(c.build2), 11)}${padL(r2(c.build3), 11)}${padL(r2(c.build2 / c.build1), 12)}  ${c.verdict}${c.estMiB > c.capMiB ? '  est>32MiB' : ''}`)
  }
  say('')
  say('  P1b 同内容两次 readWith(lines)（记忆化是否让第 2 次变快）')
  for (const x of readRuns) {
    const c = x.r.data?.phases?.cliff
    if (c === undefined) continue
    say(`    n=${padL(x.n, 7)}  第1次=${padL(r2(c.readWith1), 10)}ms  第2次=${padL(r2(c.readWith2), 10)}ms  倍率=${r2(c.readWith2 / c.readWith1)}  ok=${JSON.stringify(c.readWithOk)}`)
  }
  say('')
  say('  P3 扩展名对照（语料 C，同一份内容、同一模式 map，只换虚拟路径）')
  say(`    ${padR('n', 8)}${padL('无扩展名 ms', 14)}${padL('text/json', 14)}${padL('带 .mjs ms', 14)}${padL('text/json', 14)}  倍数`)
  for (const x of readRuns) {
    const e = x.r.data?.phases?.noext
    if (e === undefined) continue
    say(`    ${padL(x.n, 8)}${padL(r2(e.noextMs), 14)}${padL(`${e.noextShape.textChars}/${e.noextShape.jsonBytes}`, 14)}${padL(r2(e.extMs), 14)}${padL(`${e.extShape.textChars}/${e.extShape.jsonBytes}`, 14)}  ${r2(e.extMs / e.noextMs)}×`)
  }
  say('')

  // ── P4 写侧 ─────────────────────────────────────────────────────────────────
  say('─'.repeat(100))
  say(' P4 写侧：一次「两行改动」（①读+BOM ②planHunks ③regionGate ④落盘 ⑤回读校验 + 端到端）')
  say('─'.repeat(100))
  const writeRuns = []
  for (const n of WRITE_SIZES) {
    const master = path.join(TMP, `rc-master-${n}.mjs`)
    fs.copyFileSync(corpus[n].A.file, master)
    const work = path.join(TMP, `rc-work-${n}.mjs`)
    fs.copyFileSync(master, work)
    const blk = blockAt('unit', n, pickBlock(n))
    const cfg = { tag: `w-${n}`, n, prefix: 'unit', work, reps: WRITE_REPS }
    const before = procCounts()
    process.stderr.write(`  [write] n=${n} …`)
    const r = spawnChild('write', cfg)
    const after = procCounts()
    process.stderr.write(r.ok ? ' ok\n' : ` 失败 status=${r.status} ${r.stderr.slice(-200)}\n`)
    writeRuns.push({ n, r, before, after, blk })
  }
  const fmtStage = (st) => fmtS(stat(st), 20)
  say('')
  say(`  ${padR('行数', 9)}${padL('①读+BOM', 21)}${padL('②定位+计划', 21)}${padL('③闸门', 21)}${padL('④落盘', 21)}${padL('⑤回读校验', 21)}${padL('端到端', 21)}${padL('③占比', 9)}`)
  for (const w of writeRuns) {
    const s = w.r.data?.stage
    if (s === undefined) {
      say(`  ${padL(w.n, 9)}  运行失败：${w.r.stderr.slice(-120)}`)
      continue
    }
    const e2e = stat(s.e2e).p50
    const share = (stat(s.gate).p50 / e2e) * 100
    say(`  ${padL(w.n, 9)}${fmtStage(s.read)}${fmtStage(s.plan)}${fmtStage(s.gate)}${fmtStage(s.disk)}${fmtStage(s.verify)}${fmtStage(s.e2e)}${padL(`${r2(share)}%`, 9)}`)
  }
  say('')
  say('  微基准（µs/次，N=' + MREPS + '）与裸 fs 对照')
  for (const w of writeRuns) {
    const m = w.r.data?.micro
    if (m === undefined) continue
    say(`    n=${w.n}`)
    for (const k of Object.keys(m)) {
      if (k.startsWith('_')) continue
      say(`      ${padR(k, 30)}${padL(r2(m[k]), 12)} µs`)
    }
  }
  say('')
  say('  旁证：applyEditToProvider（引擎自带入口）端到端')
  for (const w of writeRuns) {
    const a = w.r.data?.applyE2E
    if (a === undefined) continue
    say(`    n=${padL(w.n, 7)}  ${w.r.data.applyE2E.map(r2).join(', ')}  p50=${r2(stat(a).p50)} ms`)
  }
  say('')
  say('  写侧原始样本（全部）')
  for (const w of writeRuns) {
    const s = w.r.data?.stage
    if (s === undefined) continue
    say(`    n=${w.n} hunks=line${w.blk.bodyA},line${w.blk.bodyB} (${w.blk.name})`)
    for (const k of ['read', 'bom', 'plan', 'gate', 'disk', 'verify', 'e2e']) say(`      ${padR(k, 8)}${s[k].map(r2).join(', ')}`)
  }
  say('')

  // ── P3 外层固定税 ───────────────────────────────────────────────────────────
  say('─'.repeat(100))
  say(' P3 外层固定税（自写口径：同一台机器、同一个 spawnSync 形状）')
  say('─'.repeat(100))
  const outerBefore = procCounts()
  const pwshExe = (() => {
    const cand = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    return fs.existsSync(cand) ? cand : 'pwsh.exe'
  })()
  const nodeQ = `& '${process.execPath.replace(/'/g, "''")}'`
  const importStub = 'const t=performance.now(); await Promise.all([' +
    ['read-core.mjs', 'struct-core.mjs', 'locator-api.mjs', 'write-path.mjs'].map((f) => JSON.stringify(url(f))).join(', ') +
    '].map(u=>import(u))); process.stdout.write("import ms=" + (performance.now()-t).toFixed(2));'

  const nBig = 90000
  const oneCfgExt = { tag: 'one-ext', file: corpus[nBig].C.file, vpath: `E:\\r3rc\\C-${nBig}.mjs`, n: nBig }
  const oneCfgNoExt = { tag: 'one-noext', file: corpus[nBig].C.file, vpath: 'E:\\r3rc\\outer', n: nBig }
  const oneCfgFile = path.join(TMP, 'cfg-one.json')
  const chainRead = (cfgObj) => {
    fs.writeFileSync(oneCfgFile, JSON.stringify(cfgObj))
    return spawnMs(pwshExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$env:RC_JOB='one'; $env:RC_CFG='${oneCfgFile}'; ${nodeQ} '${SELF}'`])
  }
  const parseOne = (s) => {
    const at = s.lastIndexOf('@@RC@@')
    if (at === -1) return null
    try {
      return JSON.parse(s.slice(at + 6).trim())
    } catch {
      return null
    }
  }

  const scenarios = [
    { id: 'C1', label: '裸 node（node -e ""）', n: OUTER_REPS, run: () => spawnMs(process.execPath, ['-e', '']) },
    { id: 'C2', label: 'node + 引擎四文件 import', n: OUTER_REPS, run: () => spawnMs(process.execPath, ['--input-type=module', '-e', importStub]) },
    { id: 'C3', label: '裸 pwsh（pwsh -NoProfile -Command ""）', n: OUTER_REPS, run: () => spawnMs(pwshExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '']) },
    { id: 'C4', label: 'pwsh → node（-e ""）', n: OUTER_REPS, run: () => spawnMs(pwshExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${nodeQ} -e ""`]) },
    { id: 'C5', label: 'pwsh → node → 引擎 import', n: OUTER_REPS, run: () => spawnMs(pwshExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${nodeQ} --input-type=module -e "${importStub.replace(/"/g, '""')}"`]) },
    { id: 'C6e', label: `pwsh → node → 引擎 → 真 map 读（90000 行，路径带 .mjs）`, n: Math.max(3, Math.round(OUTER_REPS / 3)), run: () => chainRead(oneCfgExt), parse: parseOne },
    {
      id: 'C6n', label: `同上但路径不带扩展名（R3 自报 C6 用的形状）`, n: Math.max(3, Math.round(OUTER_REPS / 3)), run: () => chainRead(oneCfgNoExt), parse: parseOne,
    },
  ]
  const outer = []
  for (const s of scenarios) {
    const samples = []
    const extra = []
    for (let i = 0; i < s.n; i += 1) {
      const r = s.run()
      samples.push(r.ms)
      if (s.parse) extra.push(s.parse(r.stdout))
    }
    outer.push({ id: s.id, label: s.label, stat: stat(samples), samples, extra: extra.filter(Boolean) })
  }
  const outerAfter = procCounts()
  say('')
  say(`  ${padR('段', 5)}${padR('场景', 52)}${padL('p50', 10)}${padL('min', 10)}${padL('p90', 10)}${padL('max', 10)}${padL('n', 4)}`)
  for (const s of outer) say(`  ${padR(s.id, 5)}${padR(s.label, 52)}${padL(r2(s.stat.p50), 10)}${padL(r2(s.stat.min), 10)}${padL(r2(s.stat.p90), 10)}${padL(r2(s.stat.max), 10)}${padL(s.stat.n, 4)}`)
  say('')
  const get = (id) => outer.find((s) => s.id === id)
  say('  构成分解（p50）')
  say(`    OS 拉起 node                              C1  = ${r2(get('C1').stat.p50)} ms`)
  say(`    node + 引擎模块图                          C2−C1 = ${r2(get('C2').stat.p50 - get('C1').stat.p50)} ms`)
  say(`    pwsh 进程本身                              C3  = ${r2(get('C3').stat.p50)} ms`)
  say(`    pwsh 拉起 node（含 node 自身）              C4−C3 = ${r2(get('C4').stat.p50 - get('C3').stat.p50)} ms`)
  say(`    整链 pwsh→node→引擎                        C5  = ${r2(get('C5').stat.p50)} ms`)
  say(`    整链 + 一次真 map 读（带 .mjs，90000 行）    C6e = ${r2(get('C6e').stat.p50)} ms`)
  say(`    整链 + 一次 map 读（无扩展名，同内容同档）    C6n = ${r2(get('C6n').stat.p50)} ms`)
  const med = (xs) => (xs.length === 0 ? null : pct(xs, 0.5))
  for (const id of ['C6e', 'C6n']) {
    const s = get(id)
    if (s.extra.length === 0) continue
    say(`    ${id} 链内自报：import p50=${r2(med(s.extra.map((d) => d.importMs)))}ms  map 冷读 p50=${r2(med(s.extra.map((d) => d.mapMs)))}ms  map 回执 text/json=${s.extra[0].shape.textChars}/${s.extra[0].shape.jsonBytes}`)
  }
  say('')
  say('  原始样本')
  for (const s of outer) say(`    ${padR(s.id, 5)} ${s.samples.map(r2).join(', ')}`)
  say('')
  say(`  外层税段前后进程数：node.exe ${outerBefore.node}→${outerAfter.node}  pwsh.exe ${outerBefore.pwsh}→${outerAfter.pwsh}`)
  say('')

  // ── 增长最快的格子（自算） ──────────────────────────────────────────────────
  say('─'.repeat(100))
  say(' 增长斜率（自算 log-log，ms ∝ n^slope）')
  say('─'.repeat(100))
  const slope = (pts) => {
    const xs = pts.map((p) => Math.log(p.n))
    const ys = pts.map((p) => Math.log(p.v))
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = ys.reduce((a, b) => a + b, 0) / ys.length
    let num = 0
    let den = 0
    for (let i = 0; i < xs.length; i += 1) {
      num += (xs[i] - mx) * (ys[i] - my)
      den += (xs[i] - mx) ** 2
    }
    return den === 0 ? 0 : num / den
  }
  const growth = []
  for (const mode of ['map', 'digest', 'around', 'lines', 'search', 'full', 'changed']) {
    const pts = readRuns.map((x) => ({ n: x.n, v: x.r.data?.phases?.matrix?.matrix?.[mode]?.coldMs })).filter((p) => Number.isFinite(p.v) && p.v > 0)
    if (pts.length >= 3) growth.push({ what: `read/${mode}（冷）`, s: slope(pts), pts })
  }
  const cliffPts = readRuns.map((x) => ({ n: x.n, v: x.r.data?.phases?.cliff?.build1 })).filter((p) => Number.isFinite(p.v) && p.v > 0)
  if (cliffPts.length >= 3) growth.push({ what: 'indexStructure 建索引（冷）', s: slope(cliffPts), pts: cliffPts })
  for (const [key, label] of [['plan', '写/②planHunks'], ['gate', '写/③regionGate'], ['read', '写/①读'], ['verify', '写/⑤回读校验'], ['e2e', '写/端到端']]) {
    const pts = writeRuns.map((w) => ({ n: w.n, v: stat(w.r.data?.stage?.[key])?.p50 })).filter((p) => Number.isFinite(p.v) && p.v > 0)
    if (pts.length >= 2) growth.push({ what: label, s: slope(pts), pts })
  }
  for (const k of ['planHunks', 'regionGate(ledger=set)', 'regionGate(ledger=empty)', 'verifyWriteBack', 'contentToken', 'CTRL fs.writeFileSync+readFileSync']) {
    const pts = writeRuns.map((w) => ({ n: w.n, v: w.r.data?.micro?.[k] / 1000 })).filter((p) => Number.isFinite(p.v) && p.v > 0)
    if (pts.length >= 2) growth.push({ what: `micro/${k}`, s: slope(pts), pts })
  }
  growth.sort((a, b) => b.s - a.s)
  for (const g of growth) say(`    ${padR(g.what, 26)} slope=${padL(r2(g.s), 6)}   ${g.pts.map((p) => `${p.n}:${r2(p.v)}ms`).join('  ')}`)
  say('')

  const result = {
    unit: 'R3-recheck',
    at: new Date().toISOString(),
    machine: { node: process.version, cpus: os.cpus().length, totalMemGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)) },
    procBefore: live,
    procAfterOuter: outerAfter,
    countersAtStart: counters(),
    reps: { hot: REPS, outer: OUTER_REPS, write: WRITE_REPS, micro: MREPS },
    corpus: Object.fromEntries(Object.entries(corpus).map(([n, v]) => [n, Object.fromEntries(Object.entries(v).map(([k, c]) => [k, { file: c.file, lines: c.lines, bytes: c.size }]))])),
    readMatrix: readRuns.map((x) => ({ n: x.n, proc: { before: x.before, after: x.after }, data: x.r.data })),
    writeMatrix: writeRuns.map((w) => ({ n: w.n, proc: { before: w.before, after: w.after }, data: w.r.data })),
    outerTax: Object.fromEntries(outer.map((s) => [s.id, { label: s.label, stat: s.stat, samples: s.samples, extra: s.extra }])),
    growth: growth.map((g) => ({ what: g.what, slope: g.s, pts: g.pts })),
    elapsedMs: now() - tStart,
  }
  if (OUT !== null) fs.writeFileSync(OUT, `${JSON.stringify(result)}\n`)
  say('')
  say(`  总耗时 ${r2(result.elapsedMs / 1000)} s`)
}

if (JOB === 'read') await childRead()
else if (JOB === 'write') await childWrite()
else if (JOB === 'one') await childOne()
else await main()
