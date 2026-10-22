/**
 * perf-baseline.mjs —— fs-contract-v2 / R3：**当前树性能底**（计时单）。
 *
 * 要回答的一件事：经过「结构索引按内容令牌记忆化」「同会话重复读只回差量」两轮优化之后，
 * 一次 aura_read / aura_edit 到底花多长时间、花在哪一格、离「快」还有多远。
 * 历史日志里的数（aura_read e2e p50=200ms / p90=826ms、aura_edit p50=252ms）是**改动前**的数；
 * 本探针只在**现树现机**上重新量，不从日志里翻。
 *
 * ── 量什么（四段，互不混） ─────────────────────────────────────────────────────
 * A 读侧矩阵：7 个模式 × 尺寸档 × { 冷, 热 }
 *     「冷」= 新进程里的**第一次**调用（结构索引缓存必空）
 *     「热」= 同进程内对**同一份内容**的第 2..N 次调用（记忆化命中）
 *     `full` 的冷/热还叠了增量读那一层，因此额外把第 2 次单独列出来（第 3 次起才是纯全量收敛）。
 *     `changed` 一行是 steady-state 热点：先喂一次首读建立账本，再计时「无变化」判定。
 * B 写侧四格：一次「两行改动」的编辑，拆成
 *     ① 读+BOM 探测（冷路径必付） ② 定位+计划（planHunks） ③ 落盘（writeText） ④ 回读校验
 *     外加「闸门」一格的**分摊估计**（它本身小于单次计时分辨率：用 200 次紧循环测均值，标注 notPerCall）。
 *     编排顺序逐字复刻 DSH 壳 `aura-tools/src/aura-edit/index.js`（readText → fileByteOrderMarkCount →
 *     planHunks → regionGate → carryingByteOrderMarks → writeText → verifyWriteBack → rememberRead），
 *     不是另写一条编排。
 * C 外层固定税：每次工具调用都要付、但和引擎无关的那一段。
 *     裸 node 启动 / node+引擎模块图 / 裸 pwsh 启动 / pwsh→node 整链 / pwsh→node→引擎整链，
 *     再与「引擎操作本身」相除给出占比。
 * D 增长最快的格子：对 A/B 的每一格按 log(耗时)~log(行数) 拟合幂次，指出斜率最大的那格。
 *
 * ── 计时纪律 ─────────────────────────────────────────────────────────────────
 *   · 每段测量前记录当前 node.exe / pwsh.exe 进程数（写进输出与回执）。
 *   · 全部读数给 **min / p50 / p90 / max 与全部原始样本**，不只报一次。
 *   · 「冷」一律取**新进程首调**；进程内第一次另记 `inproc-first`，两者分开列（新进程首调含 V8 预热差异）。
 *   · 量不到的格子如实标 `n/a` + 原因，不用估算顶替。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   node aura-tools/probes/perf-baseline.mjs                       # 默认档（约 1–3 分钟）
 *   node aura-tools/probes/perf-baseline.mjs --quick               # 最小档：只验通路
 *   node aura-tools/probes/perf-baseline.mjs --reps=11             # 热启动重复次数
 *   node aura-tools/probes/perf-baseline.mjs --cold-reps=3         # 每格冷启动样本次数（每次一个新进程）
 *   node aura-tools/probes/perf-baseline.mjs --outer-reps=21       # 外层固定税重复次数
 *   node aura-tools/probes/perf-baseline.mjs --sizes=100,1000,10000,100000
 *   node aura-tools/probes/perf-baseline.mjs --out=C:\tmp\perf.json   # 落全量原始读数
 * 退出码：恒 0（探针不是判据；取不到的那一格标 n/a 并继续）。
 *
 * 只读：不改引擎、不写仓库（合成大文件写在系统临时目录，测完删除）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pkgPath } from '../build/pkg-root.mjs'

/** 本进程模块求值的第一行时间点（以后算「node 启动 + 模块图 + 到 main() 的延迟」）。 */
const PRE_MAIN_AT = performance.now()
const say = (m = '') => fs.writeSync(1, `${m}\n`)
const SELF = fileURLToPath(import.meta.url)
const PROBES_DIR = path.dirname(SELF)
const REPO = path.resolve(PROBES_DIR, '..', '..')
const CORE = pkgPath('src', 'locator-lab')

// ── 参数 ─────────────────────────────────────────────────────────────────────

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--quick', '--reps', '--cold-reps', '--outer-reps', '--sizes', '--input-type', '--out'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/perf-baseline.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const argv = process.argv.slice(2)
const hasFlag = (n) => argv.includes(`--${n}`)
const argOf = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit === undefined ? d : hit.slice(n.length + 3)
}
const num = (s, d) => (Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : d)

const QUICK = hasFlag('quick')
const REPS = Math.round(num(argOf('reps', QUICK ? '5' : '11'), 11))
const COLD_REPS = Math.round(num(argOf('cold-reps', QUICK ? '2' : '3'), 3))
const OUTER_REPS = Math.round(num(argOf('outer-reps', QUICK ? '9' : '21'), 21))
const WRITE_REPS = Math.round(num(argOf('write-reps', QUICK ? '5' : '9'), 9))
const GATE_ITERS = Math.round(num(argOf('gate-iters', '200'), 200))
const OUT = argOf('out', null)
const SEED = Math.round(num(argOf('seed', '20261013'), 20261013))
const SIZES = String(argOf('sizes', QUICK ? '100,1000' : '100,1000,10000,100000'))
  .split(',')
  .map((s) => Math.round(Number(s)))
  .filter((n) => Number.isFinite(n) && n >= 20)

const NODE_EXE = process.execPath
const TMP_ROOT = path.join(os.tmpdir(), `r3-perf-baseline-${SEED}`)

// ── 小工具 ───────────────────────────────────────────────────────────────────
const sorted = (xs) => [...xs].sort((a, b) => a - b)
const pct = (xs, p) => (xs.length === 0 ? null : sorted(xs)[Math.min(xs.length - 1, Math.max(0, Math.floor(xs.length * p)))])
const med = (xs) => pct(xs, 0.5)
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : (Math.round(v * 100) / 100).toFixed(2))
const r1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : (Math.round(v * 10) / 10).toFixed(1))
const padR = (s, n) => String(s ?? '').padEnd(n)
const padL = (s, n) => String(s ?? '').padStart(n)
const now = () => performance.now()

/** 过程快照：当前机器上有多少 node.exe / pwsh.exe（计时单的前提，必须记进读数）。 */
function procCounts() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$n=@(Get-Process node).Count',
    '$p=@(Get-Process pwsh).Count',
    '"$n $p"',
  ].join('; ')
  const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const m = String(r.stdout ?? '').trim().match(/^(\d+)\s+(\d+)$/)
  return m === null ? { node: null, pwsh: null, error: String(r.stderr ?? '').trim() || 'snapshot failed' } : { node: Number(m[1]), pwsh: Number(m[2]) }
}

function pressCounters() {
  const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  const ps = [
    '$ErrorActionPreference="SilentlyContinue"',
    'try { $s=(Get-Counter "\\Memory\\Available MBytes","\\Processor(_Total)\\% Processor Time" -ErrorAction Stop).CounterSamples; ($s | ForEach-Object { "{0}={1:N1}" -f $_.Path.Split("\\")[-1], $_.CookedValue }) -join " " } catch { "counter-unavailable" }',
  ].join('; ')
  const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  return String(r.stdout ?? '').trim() || 'counter-unavailable'
}

function statOf(xs) {
  if (xs.length === 0) return null
  return { n: xs.length, min: Math.min(...xs), p50: pct(xs, 0.5), p90: pct(xs, 0.9), max: Math.max(...xs), all: xs }
}

/** envelope 体量：模型真正要收下的字符数（text 字段）与整个回执的 JSON 字节数。 */
function shapeOf(env) {
  const text = typeof env.text === 'string' ? env.text : ''
  let json = 0
  try {
    json = Buffer.byteLength(JSON.stringify(env), 'utf8')
  } catch {
    json = -1
  }
  return {
    textChars: text.length,
    jsonBytes: json,
    truncated: env.truncated === undefined ? null : env.truncated,
    note: typeof env.note === 'string' ? env.note.slice(0, 90) : null,
    auto: typeof env.auto === 'string' ? env.auto : null,
  }
}

/**
 * 合成语料的**块结构**：每 11 行一个可独立寻址的导出函数。
 *
 *   +0 `/**`   +1 ` * alpha<b> …`   +2 ` * @param value`   +3 ` */`
 *   +4 export function alpha&lt;b&gt;(value) {   +5 const   +6 return   +7 }
 *   +8 const beta&lt;b&gt; = (input) => alpha&lt;b&gt;(input) + (…)
 *   +9 （空行 —— **必须有**：符号索引会把相邻的 JSDoc 与声明合成**一个**跨度，
 *          没有空行时整条链会变成一个巨大符号，按名字寻址就找不到目标）
 *   +10 `/**`（下一块的开头）…
 *
 * 块号 b 让体里两行**全文件唯一**（写侧 `old` 用它）；`alpha<b>` 在文件里出现 3 次
 * （JSDoc 行、签名行、`beta` 行）——那是故意的，用来同时给 `search` 一个多命中场景。
 */
const BLOCK = 11

/** 合成体头部：一个完整可寻址的导出函数 + 一个类（不参与块排布）。 */
const SYNTH_HEAD = [
  `/**`,
  ` * alpha0 —— 合成体第 0 号单元（真头部）。`,
  ` * @param value - 输入值`,
  ` */`,
  `export function alpha0(value) {`,
  `  return value % 4096`,
  `}`,
  `export class Gamma0 {`,
  `  constructor(seed) { this.seed = seed }`,
  `  next() { return alpha0(this.seed) }`,
  `}`,
  `export function main0() {`,
  `  const g = new Gamma0(1)`,
  `  return g.next()`,
  `}`,
]

/** 尾部：两个真函数，最后一行为空（文件以 `}\n` 收尾，行数与文件的行数组一致）。 */
const SYNTH_TAIL = [
  `export function alphaTail(value) {`,
  `  return value % 7`,
  `}`,
  `export function betaTail(value) {`,
  `  return value % 11`,
  `}`,
]

/** 第 b 个块的 `old` 候选：体里两行的**唯一**文本。 */
function synthBodyLines(b) {
  return [`  const scaled${b} = value * ${(b % 97) + 1} + alpha0(value)`, `  return scaled${b} % 4096`]
}


/** 第 b 个块的 11 行。 */
function synthBlockLines(b) {
  const t = (b % 97) + 1
  return [
    `/**`,
    ` * alpha${b} —— 合成体第 ${b} 号单元的说明（固定形状，逐行确定）。`,
    ` * @param value - 输入值`,
    ` */`,
    `export function alpha${b}(value) {`,
    `  const scaled${b} = value * ${t} + alpha0(value)`,
    `  return scaled${b} % 4096`,
    `}`,
    `const beta${b} = (input) => alpha${b}(input) + ${b % 31}`,
    ``, // 空行：让下一个函数的 JSDoc 不沾上一个声明（否则符号跨度会合并）
    `/**`,
  ]
}

function synthPlan(n) {
  const head = SYNTH_HEAD.length
  const tail = SYNTH_TAIL.length
  // 抬到至少一个块：n 小到放不下「头 + 一个块 + 尾」时，向下取整会得到 0 块，
  // 补空行无从补起（文件会比声明的行数短）——那一档就不该生成，直接说出来而不是交一份坏语料。
  const full = Math.max(1, Math.floor((n - head - tail) / BLOCK))
  const used = head + full * BLOCK + tail
  return { head, tail, full, pad: n - used, total: n }
}

/**
 * 合成体：头部 + `full` 个 11 行块 + 尾部 + **尾部补空行**，行数**正好**等于 n。
 *
 * 补空行而不是截断最后一个块：截块会把一个函数砍成半截（JSDoc 有、签名没有），
 * 那在各模式里是另一种输入形状，量出来的就不是同一个语料了。
 */
function writeSynthFile(file, n) {
  const plan = synthPlan(n)
  const fd = fs.openSync(file, 'w')
  try {
    fs.writeSync(fd, `${SYNTH_HEAD.join('\n')}\n`)
    for (let b = 0; b < plan.full; b += 1) fs.writeSync(fd, `${synthBlockLines(b).join('\n')}\n`)
    fs.writeSync(fd, `${SYNTH_TAIL.join('\n')}\n`)
    if (plan.pad > 0) fs.writeSync(fd, '\n'.repeat(plan.pad))
  } finally {
    fs.closeSync(fd)
  }
  return plan.total
}

/**
 * 第 b 个块的 JSDoc 首行（1-based）。
 *
 * 块排布见 {@link BLOCK} 的注释；空行（块内第 9 行）保证每个函数是**独立**符号 ——
 * 第一版没有空行，符号索引把相邻块合成一个巨大跨度，`around <名字>` 全格报 READ_NOT_FOUND。
 */
function synthFuncAt(b) {
  const startLine = SYNTH_HEAD.length + 1 + b * BLOCK
  return { name: `alpha${b}`, startLine, endLine: startLine + 7 }
}

// ── 读取任务定义（每个尺寸档一套） ───────────────────────────────────────────
const MODES = ['map', 'digest', 'around', 'lines', 'search', 'full', 'changed']
/** 只在外层税那段用的几个模式（进程级冷启动抓采样）。 */
const OUTER_MODES = ['map', 'digest', 'full']

function readPlan(totalLines, targetName, searchToken) {
  const mid = Math.max(2, Math.floor(totalLines / 2))
  return {
    map: {},
    digest: {},
    around: { around: targetName },
    // `readWith` 认的是 `[start, end]` 数值区间（字符串 "a,b" 是写侧 hunk 的便利形式，读侧不认）。
    lines: { lines: [mid, mid + 39] },
    search: { search: searchToken },
    full: {},
    changed: { since: null }, // 运行时用首读拿到的令牌填
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  子进程：read-job / write-job
// ══════════════════════════════════════════════════════════════════════════════
const JOB = process.env.R3_JOB

async function childMain() {
  const t0 = now()
  // `bootMs` 由**本进程**在模块求值的第一行记下（见文件顶部 PRE_MAIN_AT）。
  // 不能用宿主经 env 递进来的时间戳：那是父进程的时钟点，与子进程的 performance
  // 时间轴不可比（第一版就是这么错的，报出 −1.79e12 这种绝对值）。
  const bootMs = PRE_MAIN_AT
  const cfg = JSON.parse(fs.readFileSync(process.env.R3_CFG, 'utf8'))
  const coreUrl = (name) => pathToFileURL(path.join(cfg.core, name)).href

  const readCore = await import(coreUrl('read-core.mjs'))
  const structCore = await import(coreUrl('struct-core.mjs'))
  if (JOB === 'write') await import(coreUrl('write-path.mjs'))
  else await import(coreUrl('locator-api.mjs'))
  const importMs = now() - t0

  const out = { job: JOB, importMs, bootToMainMs: bootMs === null ? null : t0 - bootMs }
  if (JOB === 'read') Object.assign(out, await readJob(cfg, readCore, structCore))
  else Object.assign(out, await writeJob(cfg, readCore))
  fs.writeSync(1, `\n@@R3@@${JSON.stringify(out)}\n`)
}

async function readJob(cfg, readCore, structCore) {
  const { readWith } = readCore
  const file = cfg.file
  const src = fs.readFileSync(file, 'utf8')
  const filePath = cfg.filePath
  const plan = readPlan(src.split(/\r?\n/).length, cfg.targetName, cfg.searchToken)
  const results = {}

  /** 一次调用；返回 { ms, env }。`sinceRef` 是可变引用（changed 用它拿首读令牌）。 */
  const call = (mode, sinceRef) => {
    const req = { mode, filePath, ...plan[mode] }
    if (mode === 'changed') req.since = sinceRef.value
    const a = now()
    const env = readWith(src, req)
    return { ms: now() - a, env }
  }

  // 首读：只为建立 changed 的基准令牌与观测账本；不计入任何一格的读数。
  // 用**独立的 work 路径**：若用 filePath 本身，这笔观测会进入各模式自己的账本，
  // 把「这一次是该模式的第一次调用」这个前提搅浑。
  const seedPath = `${filePath}#seed`
  const seed = (() => {
    const a = now()
    const env = readWith(src, { mode: 'lines', filePath: seedPath, lines: [1, 5] })
    return { ms: now() - a, env }
  })()
  if (seed.env.ok !== true) return { error: `seed lines failed: ${seed.env.code} ${seed.env.message}`, results }
  const seedShape = shapeOf(seed.env)
  const token = typeof seed.env.version === 'string' ? seed.env.version : null
  if (token === null) return { error: 'seed read returned no version token', results }

  for (const mode of MODES) {
    // 账本重置：changed 的基准令牌是在"当前有效状态"下用 `since` 重读；
    // 其余模式第一格固定 `since=<哨兵>` ⇒ 引擎在**找到账本前**就跳过比对（seed 已先把账本建好）。
    const sinceRef = mode === 'changed' ? { value: token } : { value: '<first>' }
    const first = call(mode, sinceRef)
    if (first.env.ok !== true) {
      results[mode] = { error: `${first.env.code}: ${String(first.env.message).slice(0, 160)}` }
      continue
    }
    const hot = []
    let incrementalShape = null
    for (let r = 1; r < cfg.reps; r += 1) {
      const c = call(mode, sinceRef)
      if (c.env.ok !== true) break
      if (mode === 'full' && r === 1) incrementalShape = shapeOf(c.env)
      hot.push(c.ms)
    }
    // `full` 的第 3 次起才是"全量收敛"那一段（第 2 次被增量层接管）——分开列。
    const tail = []
    if (mode === 'full' && hot.length > 1) {
      for (let r = 0; r < 4; r += 1) {
        const c = call(mode, sinceRef)
        if (c.env.ok !== true) break
        tail.push(c.ms)
      }
    }
    results[mode] = {
      coldMs: first.ms,
      firstShape: shapeOf(first.env),
      coldNote: typeof first.env.note === 'string' ? first.env.note.slice(0, 200) : null,
      hotMs: hot,
      incrementalShape,
      tailMs: tail,
    }
  }
  return { results, seedShape, token, totalLines: src.split(/\r?\n/).length, srcChars: src.length }
}

async function writeJob(cfg, readCore) {
  const { rememberRead, contentToken, BYTE_ORDER_MARK, latestObservation } = readCore
  const wp = await import(pathToFileURL(path.join(cfg.core, 'write-path.mjs')).href)
  const { planHunks, regionGate, fileByteOrderMarkCount, carryingByteOrderMarks, verifyWriteBack, providerView } = wp

  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8', { fatal: true })
  const versionOf = (p) => {
    const st = fs.statSync(p)
    return `v${st.size}:${st.mtimeMs}`
  }

  /** 逐字复刻 dsh-fs-local 的 provider 形状（readText 剥一个前导 BOM、readByteRange 给原始字节、writeText 整份写）。 */
  const provider = {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version: versionOf(t.targetKey), type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
    readText: async (t) => {
      if (!fs.existsSync(t.targetKey)) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' })
      return dec.decode(fs.readFileSync(t.targetKey))
    },
    readByteRange: async (t, range) => {
      if (!fs.existsSync(t.targetKey)) throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' })
      return fs.readFileSync(t.targetKey).subarray(range.offset, range.offset + range.length)
    },
    writeText: async (t, content, expected) => {
      const p = t.targetKey
      if (expected?.kind === 'replaceIfVersion' && versionOf(p) !== expected.version) {
        throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      fs.writeFileSync(p, Buffer.from(enc.encode(content)))
      return { version: versionOf(p), operation: 'update', after: content }
    },
  }

  const target = { displayPath: cfg.displayPath, targetKey: cfg.work }
  const baseHunks = cfg.hunks
  /**
   * 每一轮用**全新的替换文本**，并且从「当轮的行」里取 `old`。
   *
   * 为什么不能反复用同一对 hunk：闸门会把“被寻址区域在**上次观测**里长什么样”与
   * “现在长什么样”比一下（`staleConflicts` 里 `observed !== match.actual` 那一路）。
   * 重复用同一对时，上一轮已经把该区域改过了 —— 观测里是旧文本、现在是新文本，
   * 于是第 2 轮起被判 “lines 263-263 were not present in the last observation”（真实拒绝，不是探针 bug）。
   * 每轮换文本，量到的就是「对当前内容做一次两行改动」这同一种工作，而且每轮都是真改动。
   */
  let round = 0
  const hunksFor = (src) => {
    const rows = src.split(/\r?\n/)
    round += 1
    return baseHunks.map((h, i) => ({
      line: h.line,
      old: rows[h.line - 1],
      replace: `${h.prefix} #[${round}.${i}]`,
    }))
  }
  /**
   * 四格 + 端到端。四格各自分开计时，但 **`e2e` 才是墙钟真相**：
   * Windows 上 `writeFileSync` 的落盘与杀毒扫描可能落在计时区间之外，也可能在
   * `readText` 之前就静默吃掉几百毫秒（第一次试验里就是这么被污染的：
   * read+bom+plan+disk+verify 加起来 ~22ms，而 e2e 是 ~554ms，差额全在 copyFileSync 之后的第一次 fs 调用上）。
   * 因此两趟都测，并预先 `statSync + readFileSync` 预热文件系统缓存：
   *   · pass A 冷文件：每轮从全新拷贝开始 —— 贴近“改一个刚被写过的文件”；
   *   · pass B 热文件：同一份文件上连续编辑 —— 每格可归因，且给 `e2e` 做对账。
   */
  const one = { read: [], bom: [], plan: [], gate: [], disk: [], verify: [], e2e: [] }
  const warm = { read: [], bom: [], plan: [], gate: [], disk: [], verify: [], e2e: [] }
  let next = null
  let content = null
  let planned = null
  let boms = 0

  const editOnce = async (bucket, total0, where = target) => {
    const a1 = now()
    content = await provider.readText(where)
    bucket.read.push(now() - a1)

    const a2 = now()
    boms = await fileByteOrderMarkCount(provider, where, undefined)
    // `stat` 收的是 **target 对象**，不是路径字符串（provider 契约）：传字符串会让它将到 undefined。
    const info = await provider.stat(where)
    bucket.bom.push(now() - a2)

    const hunks = hunksFor(content)
    const latestObs = latestObservation(where.displayPath)?.source ?? null

    const a3 = now()
    planned = planHunks(content, hunks, where.displayPath)
    bucket.plan.push(now() - a3)

    // 闸门这一格是**单次**计时，不是紧循环：它在真实路径里就在这条时间线上。
    // 紧循环均值另列（见下面 micro 表），用来把“单次计时分辨率不够”这件事量出来。
    const a4 = now()
    const gateResult = regionGate(hunks, content, planned, where.displayPath, { byteOrderMark: boms > 0 })
    bucket.gate.push(now() - a4)
    if (gateResult.clean !== true) {
      // 拒绝时把**当时的实情**落盘：闸门的判据涉及两份内容，报错文本只给行号，
      // 而“我以为的行”与“实际的行”差在哪里，只有把两边都打出来才能判。
      const rows = content.split(/\r?\n/)
      const obsRows = latestObs === null ? [] : latestObs.split(/\r?\n/)
      fs.writeFileSync(
        `${where.targetKey}.refuse.txt`,
        [
          `round=${round}`,
          `baseLines=${baseHunks.map((h) => h.line).join(',')}`,
          `hunks=${JSON.stringify(hunks)}`,
          `contentLines=${rows.length} obsLines=${obsRows.length}`,
          ...baseHunks.flatMap((h, i) => [
            `hunk${i} line${h.line}: current=${JSON.stringify(rows[h.line - 1])}`,
            `hunk${i} line${h.line}: observed=${JSON.stringify(obsRows[h.line - 1])}`,
          ]),
        ].join('\n'),
      )
      throw new Error(`gate refused: ${gateResult.message}`)
    }

    next = carryingByteOrderMarks(planned.content, boms)
    const a5 = now()
    await provider.writeText(where, next, { kind: 'replaceIfVersion', version: info.version })
    bucket.disk.push(now() - a5)

    const a6 = now()
    await verifyWriteBack(provider, where, next, where.displayPath)
    bucket.verify.push(now() - a6)

    const view = providerView(next)
    rememberRead(where.displayPath, contentToken(view, next.startsWith(BYTE_ORDER_MARK)), view, next.startsWith(BYTE_ORDER_MARK))
    if (total0 !== null) bucket.e2e.push(now() - total0)
  }

  /**
   * pass A 「这份文件在本会话里没被观测过」：每轮换一个**新路径**（内容仍是全新拷贝）。
   *
   * 为什么不能在同一路径上反复 `copyFileSync(master)`：那等于“同一个路径下的内容又变回旧版”，
   * 而区域级新鲜度闸门正是要拦这件事 —— 它会报 `absent-in-observation`（这是**正确行为**，不是引擎缺陷）。
   * 第一版就是这么写的，结果 5 轮里有 4 轮被闸门拒掉；换成每轮一个新路径，量到的才是
   * “首次编辑一个刚被读过的文件”。
   */
  for (let r = 0; r < cfg.writeReps; r += 1) {
    const pathR = `${cfg.work}.cold${r}`
    fs.copyFileSync(cfg.master, pathR)
    // 预热：真调用里“刚被读过/刚被写过”是常态。不预热，第一次 fs 调用会把冷盘延迟算进引擎。
    fs.statSync(pathR)
    fs.readFileSync(pathR)
    await editOnce(one, now(), { targetKey: pathR, displayPath: pathR })
  }
  /**
   * pass B 「同一路径上的连续编辑」：这一趟才会真正撞上闸门的热路径 ——
   * 账本里已有一条观测（上一轮写回时 `rememberRead` 记的），闸门要拿它与当前内容比。
   */
  for (let r = 0; r < cfg.writeReps; r += 1) await editOnce(warm, now(), target)

  // ── 引擎微基准：每格独立重复 MREPS 次，取每调用均值（µs）——避开文件系统噪声，给各格一个可归因的数 ──
  const finalText = dec.decode(fs.readFileSync(cfg.work))
  // 微基准的基准内容：**已含本轮改动**，所以把两个 hunk 的 old/replace 对调，用可命中的原文。
  const finalRows = finalText.split(/\r?\n/)
  const microHunks = baseHunks.map((h) => ({ old: finalRows[h.line - 1], replace: `${h.prefix} #[micro]` }))
  const microPlanned = planHunks(finalText, microHunks, cfg.displayPath)
  const MREPS = 50
  const micro = { _n: MREPS }
  const loop = (label, fn) => {
    const t = now()
    for (let i = 0; i < MREPS; i += 1) fn()
    micro[label] = ((now() - t) / MREPS) * 1000
  }
  loop('splitLines(src.split)', () => finalText.split(/\r?\n/))
  loop('contentToken', () => contentToken(finalText, false))
  loop('readText(provider)', () => dec.decode(fs.readFileSync(cfg.work)))
  loop('statSync', () => fs.statSync(cfg.work))
  loop('fileByteOrderMarkCount', () => fileByteOrderMarkCount(provider, target, undefined))
  loop('planHunks', () => planHunks(finalText, microHunks, cfg.displayPath))
  // 闸门两条路：账本为空（首次编辑）与账本已有一条观测（第二次起的真实路径）。
  loop('regionGate(ledger=empty)', () => regionGate(microHunks, finalText, microPlanned, `${cfg.displayPath}#nogate`, { byteOrderMark: false }))
  loop('regionGate(ledger=set)', () => regionGate(microHunks, finalText, microPlanned, cfg.displayPath, { byteOrderMark: false }))
  loop('verifyWriteBack', () => verifyWriteBack(provider, target, finalText, cfg.displayPath))
  loop('readByteRange(window)', () => provider.readByteRange(target, { offset: 0, length: 100 }))
  /**
   * **对照组**：完全不经过引擎的裸文件系统动作，用同一份内容、同一个路径。
   *
   * 为什么必须有：实测「落盘」格只有 ~0.7ms，而紧随其后的「回读校验」格是 ~8-10ms。
   * 单独测 `verifyWriteBack`（没有刚写过的脏页）只有 ~0.17ms —— 差额不是引擎算的，
   * 是 Windows 上“刚写完就立刻读回来”这件事本身的代价（延迟写/缓存对账）。
   * 没有这组对照，读这份读数的人会把它当成“回读校验很贵”而去优化错的那一层。
   */
  const buf = Buffer.from(enc.encode(finalText))
  loop('CTRL bare write+read', () => {
    fs.writeFileSync(cfg.work, buf)
    fs.readFileSync(cfg.work)
  })
  loop('CTRL bare write only', () => fs.writeFileSync(cfg.work, buf))
  loop('CTRL bare read only', () => fs.readFileSync(cfg.work))
  loop('empty-await', () => undefined)

  return {
    results: one,
    warmResults: warm,
    micro,
    applied: 1,
    finalChars: finalText.length,
    finalLines: finalText.split(/\r?\n/).length,
    expectedChars: typeof cfg.expectedChars === 'number' ? cfg.expectedChars : null,
    boms,
    gateClean: true,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  父进程
// ══════════════════════════════════════════════════════════════════════════════
function spawnProbe(job, cfg, extraEnv = {}) {
  const cfgFile = path.join(TMP_ROOT, `cfg-${job}-${cfg.tag}.json`)
  fs.writeFileSync(cfgFile, JSON.stringify(cfg))
  const r = spawnSync(NODE_EXE, [SELF], {
    encoding: 'utf8',
    windowsHide: true,
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      R3_JOB: job,
      R3_CFG: cfgFile,
      R3_HOST_AT_MS: String(performance.timeOrigin + performance.now()), // 仅供对账，不参与任何读数计算
      ...extraEnv,
    },
  })
  const body = String(r.stdout ?? '')
  const at = body.lastIndexOf('@@R3@@')
  const parsed = at === -1 ? null : (() => {
    try {
      return JSON.parse(body.slice(at + 6).trim())
    } catch {
      return null
    }
  })()
  return { ok: parsed !== null, data: parsed, status: r.status, stderr: String(r.stderr ?? '').slice(-1200), stdoutTail: body.slice(-400) }
}

/** data:URI 预载：在**用户代码之前**拿一个时间戳，用来把「node 启动」与「引擎模块图」两段分开。 */

async function main() {
  const tStart = now()
  fs.mkdirSync(TMP_ROOT, { recursive: true })

  say('='.repeat(100))
  say(' R3 perf-baseline —— 当前树性能底（现机现树实测，不从日志翻）')
  say('='.repeat(100))
  say('')
  say('【计时单前提】')
  const live = procCounts()
  say(`  时间=${new Date().toISOString()}  仓库=${REPO}`)
  say(`  node=${process.version}  平台=${process.platform}/${process.arch}  逻辑核=${os.cpus().length}  内存=${(os.totalmem() / 2 ** 30).toFixed(1)} GiB`)
  say(`  开始测量前的进程数：node.exe=${live.node}  pwsh.exe=${live.pwsh}${live.error ? `  （快照错误：${live.error}）` : ''}`)
  say(`  性能计数器：${pressCounters()}`)
  say(`  重复：热=${REPS} 冷=${COLD_REPS}×新进程 外层税=${OUTER_REPS} 写侧=${WRITE_REPS} 闸门均值=${GATE_ITERS} 次`)
  say(`  尺寸档=${SIZES.join(' / ')} 行   临时目录=${TMP_ROOT}`)
  say(`  被测实现的最近修改时间（证明量的是改后树）：`)
  for (const f of ['read-core.mjs', 'write-path.mjs', 'struct-core.mjs', 'locator-api.mjs']) {
    const st = fs.statSync(path.join(CORE, f))
    say(`    ${padR(f, 20)} ${new Date(st.mtimeMs).toISOString()}  ${padL(st.size, 8)} B`)
  }
  say('')

  // ── 语料 ────────────────────────────────────────────────────────────────────
  const corpus = []
  const realSmall = path.join(CORE, 'bench.mjs')
  if (fs.existsSync(realSmall)) corpus.push({ tag: 'real-397', kind: 'real', file: realSmall, lines: null })
  const synthDir = path.join(TMP_ROOT, 'corpus')
  fs.mkdirSync(synthDir, { recursive: true })
  for (const n of SIZES) {
    const file = path.join(synthDir, `synth-${n}.mjs`)
    // 行数必须**正好**等于目标：文件以 `}\n` 收尾，`split(/\r?\n/)` 会多出一个空尾元素，
    // 因此“文件里的行数”= 元素数 − 1。这里生成后直接复量，不符就说出来。
    const lineCount = () => fs.readFileSync(file, 'utf8').split(/\r?\n/).length - 1
    if (n < SYNTH_HEAD.length + BLOCK + SYNTH_TAIL.length) {
      say(`  ! 尺寸档 ${n} 太小：合成体最小需要 ${SYNTH_HEAD.length + BLOCK + SYNTH_TAIL.length} 行（头 ${SYNTH_HEAD.length} + 一个块 ${BLOCK} + 尾 ${SYNTH_TAIL.length}），已跳过`)
      continue
    }
    if (!fs.existsSync(file) || fs.statSync(file).size === 0 || lineCount() !== n) writeSynthFile(file, n)
    if (lineCount() !== n) say(`  ! 合成体行数不符：要 ${n} 实得 ${lineCount()}`)
    else say(`  合成体 synth-${n}.mjs 行数核对：${lineCount()} = ${n}`)
  }
  for (const n of SIZES) corpus.push({ tag: `synth-${n}`, kind: 'synth', file: path.join(synthDir, `synth-${n}.mjs`), lines: n })

  say('【语料】')
  for (const c of corpus) {
    const st = fs.statSync(c.file)
    const lines = c.lines ?? fs.readFileSync(c.file, 'utf8').split(/\r?\n/).length
    c.lines = lines
    say(`  ${padR(c.tag, 14)} ${padL(lines, 7)} 行 ${padL(st.size, 9)} B  ${c.kind === 'real' ? '真仓内文件' : '合成（真实 ESM 形状，确定性）'}`)
  }
  say('')

  // ── A 读侧矩阵 ──────────────────────────────────────────────────────────────
  say('─'.repeat(100))
  say(' A 读侧矩阵（冷 = 新进程首调；热 = 同进程同内容第 2..N 次）')
  say('─'.repeat(100))
  const readRows = []
  for (const c of corpus) {
    const src = fs.readFileSync(c.file, 'utf8')
    const total = src.split(/\r?\n/).length
    // 寻址目标取**中间偏后**的一个块：不在文件首尾，避免量到边界特例。
    const blockNo = Math.max(1, Math.min(500, Math.floor(c.lines / 4 / BLOCK)))
    const fi = synthFuncAt(blockNo)
    const targetName = c.kind === 'real' ? 'buildTasks' : fi.name
    const searchToken = c.kind === 'real' ? 'const CORPUS' : fi.name
    const baseCfg = {
      tag: `${c.tag}`,
      core: CORE,
      file: c.file,
      // 路径**必须带扩展名**：`langOf` 按扩展名判定语言，无扩展名 ⇒ 无符号表 ⇒
      // map/digest 退化、around 无目标可用（第一版就踩了这个，全部格子都是 n/a）。
      filePath: `E:\\r3\\${c.tag}.mjs`,
      targetName,
      searchToken,
      reps: REPS,
      totalLines: total,
    }
    const before = procCounts()
    process.stderr.write(`  [A] ${c.tag} ${total} 行 …`)
    const runs = []
    for (let k = 0; k < COLD_REPS; k += 1) {
      const r = spawnProbe('read', { ...baseCfg, tag: `${c.tag}-${k}` })
      if (r.ok) runs.push(r.data)
      else process.stderr.write(`\n  ! ${c.tag} run#${k} 失败 status=${r.status} ${r.stderr.slice(-300)}\n`)
    }
    process.stderr.write(` ${runs.length}/${COLD_REPS} 次新进程\n`)
    const after = procCounts()
    readRows.push({ corpus: c, total, before, after, runs, baseCfg })
  }

  // ── 汇总 A ─────────────────────────────────────────────────────────────────
  const modeRows = []
  for (const row of readRows) {
    for (const mode of MODES) {
      const colds = []
      const inprocFirst = []
      const hots = []
      const tails = []
      let shape = null
      let incShape = null
      let note = null
      let err = null
      const imports = []
      const boots = []
      for (const run of row.runs) {
        if (typeof run.importMs === 'number') imports.push(run.importMs)
        if (typeof run.bootToMainMs === 'number') boots.push(run.bootToMainMs)
        const res = run.results?.[mode]
        if (res === undefined) continue
        if (res.error !== undefined) {
          err = res.error
          continue
        }
        colds.push(res.coldMs)
        if (Array.isArray(res.hotMs) && res.hotMs.length > 0) {
          inprocFirst.push(res.hotMs[0])
          hots.push(...res.hotMs.slice(1))
          if (mode === 'full' && res.hotMs.length > 1) hots.push(res.hotMs[1])
        }
        if (Array.isArray(res.tailMs)) tails.push(...res.tailMs)
        shape = shape ?? res.firstShape
        incShape = incShape ?? res.incrementalShape
        note = note ?? res.coldNote
      }
      modeRows.push({
        size: row.total,
        corpus: row.corpus.tag,
        kind: row.corpus.kind,
        mode,
        cold: statOf(colds),
        inprocFirst: statOf(inprocFirst),
        hot: statOf(hots),
        tail: statOf(tails),
        shape,
        incShape,
        note,
        err,
        imports: statOf(imports),
        boots: statOf(boots),
        before: row.before,
        after: row.after,
      })
    }
  }

  const tags = readRows.map((r) => r.corpus.tag)
  const sizeOf = new Map(readRows.map((r) => [r.corpus.tag, r.total]))
  const cell = (mode, tag) => modeRows.find((m) => m.mode === mode && m.corpus === tag)

  say('')
  say('  A1 冷启动（新进程首调）ms —— 每格样本 = 新进程次数')
  say(`  ${padR('mode', 9)}${tags.map((t) => padL(`${t} (${sizeOf.get(t)})`, 22)).join('')}`)
  for (const mode of MODES) {
    const cells = tags.map((t) => {
      const m = cell(mode, t)
      if (m === undefined || m.cold === null) return padL('n/a', 22)
      return padL(`${r2(m.cold.p50)} [${r2(m.cold.min)}..${r2(m.cold.max)}] n=${m.cold.n}`, 22)
    })
    say(`  ${padR(mode, 9)}${cells.join('')}`)
  }
  say('')
  say('  A2 热启动（同进程同内容，第 3 次起；`full` 另见 A2b）ms')
  say(`  ${padR('mode', 9)}${tags.map((t) => padL(`${t} (${sizeOf.get(t)})`, 22)).join('')}`)
  for (const mode of MODES) {
    const cells = tags.map((t) => {
      const m = cell(mode, t)
      if (m === undefined || m.hot === null) return padL('n/a', 22)
      return padL(`${r2(m.hot.p50)} [${r2(m.hot.min)}..${r2(m.hot.max)}] n=${m.hot.n}`, 22)
    })
    say(`  ${padR(mode, 9)}${cells.join('')}`)
  }
  say('')
  say('  A2b `full` 的第二、三次（第 2 次被增量层接管，第 3 次起才是全量收敛）ms')
  for (const t of tags) {
    const m = cell('full', t)
    if (m === undefined) continue
    say(`    ${padR(t, 14)} 第2次(进程内首调) p50=${r2(m.inprocFirst?.p50)}  第3次起 p50=${r2(m.tail?.p50)}  第3..N 全样本=[${(m.tail?.all ?? []).map(r2).join(', ')}]`)
  }
  say('')
  say('  A3 交付体量（模型真正收下的 text 字符数 / 整个回执 JSON 字节）与冷回执的 note')
  say(`  ${padR('mode', 9)}${tags.map((t) => padL(t, 34)).join('')}`)
  for (const mode of MODES) {
    const cells = tags.map((t) => {
      const m = cell(mode, t)
      if (m === undefined) return padL('n/a', 34)
      if (m.shape === null) return padL('n/a', 34)
      return padL(`text=${m.shape.textChars} json=${m.shape.jsonBytes}${m.shape.truncated === null ? '' : ` trunc@${m.shape.truncated.line}`}`, 34)
    })
    say(`  ${padR(mode, 9)}${cells.join('')}`)
  }
  say('')
  say('  A4 冷回执 note（证明"这一格真的是冷"/跑的是哪条路）')
  for (const t of tags) {
    const su = []
      for (const mode of MODES) {
        const m = cell(mode, t)
        if (m === undefined) continue
        su.push(`${mode}=${m.err !== null && m.err !== undefined ? `ERROR(${m.err})` : m.note === null ? '(none)' : m.note}`)
    }
    say(`    ${t}: ${su.join(' | ')}`)
  }
  say('')
  say('  A5 引擎模块图（子进程 import 段）与外层启动段')
  for (const t of tags) {
    const m = cell('map', t)
    if (m === undefined) continue
    say(`    ${padR(t, 14)} bootToMain p50=${r2(m.boots?.p50)}ms  import p50=${r2(m.imports?.p50)}ms  (n=${m.imports?.n})`)
  }
  say('')

  // ── B 写侧四格 ──────────────────────────────────────────────────────────────
  say('─'.repeat(100))
  say(' B 写侧四格：一次「两行改动」的编辑（编排逐字复刻 DSH 壳 aura-edit/index.js）')
  say('─'.repeat(100))
  const writeCorpus = corpus.filter((c) => c.lines >= 1000)
  const writeRows = []
  for (const c of writeCorpus) {
    const master = path.join(TMP_ROOT, `write-master-${c.tag}.mjs`)
    fs.copyFileSync(c.file, master)
    const work = path.join(TMP_ROOT, `write-work-${c.tag}.mjs`)
    fs.copyFileSync(master, work)
    const src = fs.readFileSync(c.file, 'utf8')
    const lines = src.split(/\r?\n/)
    const total = lines.length
    let hunkLines
    let hunks
    if (c.kind === 'real') {
      // 取前两条**非空且唯一**的行：真文件里空行/`/**` 都可能重复，重复了就是歧义而不是定位。
      const pick = []
      for (let i = 0; i < lines.length && pick.length < 2; i += 1) {
        if (lines[i].trim().length >= 8 && src.split(lines[i]).length - 1 === 1) pick.push(i)
      }
      hunkLines = pick.map((i) => i + 1)
      hunks = pick.map((i, k) => ({ line: i + 1, prefix: lines[i], replace: `${lines[i]} /* r3-${k} */` }))
    } else {
      // `old` 一律取**函数体里**那两行：块里 `/**`、` * @param value` 这类行会重复出现
      // （歧义），而体里的行按块号编号、全文件唯一。
      const b = Math.max(1, Math.min(500, Math.floor(c.lines / 4 / BLOCK)))
      const a = synthFuncAt(b)
      const [bodyA, bodyB] = synthBodyLines(b)
      hunkLines = [a.startLine + 5, a.startLine + 6]
      hunks = [
        { line: hunkLines[0], prefix: '  const scaledR3 = 4096', replace: '  const scaledR3 = 4096' },
        { line: hunkLines[1], prefix: '  return 8192', replace: '  return 8192' },
      ]
    }
    // 每个 hunk 的 `old` 都从**当前行**取（不写死）：这才是“按原文改这两行”。
    hunks = hunks.map((h) => ({ ...h, old: lines[h.line - 1] }))
    // 自检：每个 `old` 必须真的在文件里且只出现一次，否则量到的是歧义报错而不是定位。
    for (const h of hunks) {
      const hits = src.split(h.old).length - 1
      if (hits !== 1) say(`  ! 写侧 old 文本唯一性不成立（命中 ${hits} 次）：${h.old}`)
    }
    const before = procCounts()
    process.stderr.write(`  [B] ${c.tag} ${total} 行 … `)
    const cfg = {
      tag: `w-${c.tag}`,
      core: CORE,
      master,
      work,
      // 同上：写侧的寻址/闸门也按扩展名判语言（`work` 已经带 .mjs，不再拼一次）。
      displayPath: work,
      hunks,
      writeReps: WRITE_REPS,
      gateIters: GATE_ITERS,
    }
    const r = spawnProbe('write', cfg)
    process.stderr.write(r.ok ? 'ok\n' : `失败 status=${r.status}\n${r.stderr.slice(-400)}\n`)
    const after = procCounts()
    // 自检在子进程里做（落盘字符数 = 预期字符数），这里不再重算一遍。
    writeRows.push({ corpus: c, total, hunks, hunkLines, proc: { before, after }, run: r.data, raw: r })
  }

  const fmt = (xs) => {
    const s = statOf(xs)
    return s === null ? 'n/a' : `${r2(s.p50)} [${r2(s.min)}..${r2(s.max)}]`
  }
  const writeHead = `  ${padR('语料', 14)}${padL('行数', 8)}${padL('①读+BOM', 17)}${padL('②定位+计划', 17)}${padL('③闸门', 15)}${padL('④落盘', 15)}${padL('⑤回读校验', 17)}${padL('端到端', 17)}`
  for (const [label, key] of [['A 冷文件（每轮从全新拷贝开始）', 'results'], ['B 热文件（同一路径连续编辑）', 'warmResults']]) {
    say('')
    say(`  pass ${label}（ms；每格 p50 [min..max]；N=${WRITE_REPS}）`)
    say(writeHead)
    for (const w of writeRows) {
      if (w.run === null) {
        say(`  ${padR(w.corpus.tag, 14)} ${padL(w.total, 7)}  运行失败：${String(w.raw.stderr).slice(-160)}`)
        continue
      }
      const R = w.run[key]
      say(`  ${padR(w.corpus.tag, 14)}${padL(w.total, 8)}${padL(fmt(R.read), 17)}${padL(fmt(R.plan), 17)}${padL(fmt(R.gate), 15)}${padL(fmt(R.disk), 15)}${padL(fmt(R.verify), 17)}${padL(fmt(R.e2e), 17)}`)
    }
  }
  say('')
  say('  引擎微基准（µs/次；每格独立重复 N 次，取每调用均值 —— 避开文件系统噪声后的可归因数）')
  for (const w of writeRows) {
    if (w.run === null) continue
    const m = w.run.micro
    say(`    ${w.corpus.tag}（${w.total} 行，N=${m._n}）`)
    for (const k of Object.keys(m)) {
      if (k.startsWith('_')) continue
      say(`      ${padR(k, 26)}${padL(r1(m[k]), 12)} µs`)
    }
  }
  say('')
  say('  写侧原始样本（全部，不省略）')
  for (const w of writeRows) {
    if (w.run === null) continue
    say(`    ${w.corpus.tag} hunks=${JSON.stringify(w.hunks)}`)
    for (const [label, key] of [['A', 'results'], ['B', 'warmResults']]) {
      say(`      pass ${label}`)
      for (const k of ['read', 'bom', 'plan', 'gate', 'disk', 'verify', 'e2e']) {
        say(`        ${padR(k, 8)}${w.run[key][k].map(r2).join(', ')}`)
      }
    }
    say(`      自检（落盘后字符数 = 预期）：${w.run.expectedChars === w.run.finalChars ? `ok（${w.run.finalChars}）` : `不符 final=${w.run.finalChars} expected=${w.run.expectedChars}`}`)
  }
  say('')

  // ── C 外层固定税 ────────────────────────────────────────────────────────────
  say('─'.repeat(100))
  say(' C 外层固定税（与引擎无关、但每次调用都付）')
  say('─'.repeat(100))
  const outerBefore = procCounts()
  const spawnSyncMs = (exe, args, extraEnv) => {
    const a = now()
    const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, cwd: REPO, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...extraEnv } })
    return { ms: now() - a, status: r.status, stdout: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '').slice(-200) }
  }

  const shellExe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  const pwshExe = (() => {
    const cand = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
    return fs.existsSync(cand) ? cand : 'pwsh.exe'
  })()
  const nodeQuote = `& '${NODE_EXE.replace(/'/g, "''")}'`

  const PROBE_CFG = path.join(TMP_ROOT, 'cfg-outer.json')
  const outerReadTag = corpus[corpus.length - 1].tag
  const outerC = corpus[corpus.length - 1]
  fs.writeFileSync(
    PROBE_CFG,
    JSON.stringify({
      tag: 'outer',
      core: CORE,
      file: outerC.file,
      filePath: 'E:\\r3\\outer',
      targetName: outerC.kind === 'real' ? 'buildTasks' : synthFuncAt(Math.max(1, Math.min(500, Math.floor(outerC.lines / 4 / BLOCK)))).name,
      searchToken: outerC.kind === 'real' ? 'const CORPUS' : synthFuncAt(Math.max(1, Math.min(500, Math.floor(outerC.lines / 4 / BLOCK)))).name,
      reps: 2,
      totalLines: outerC.lines,
    }),
  )
  const importList = ['read-core.mjs', 'struct-core.mjs', 'locator-api.mjs', 'write-path.mjs']
    .map((f) => pathToFileURL(path.join(CORE, f)).href)
    .map((u) => JSON.stringify(u))
    .join(', ')
  const IMPORT_STUB = [
    'const t = performance.now();',
    `await Promise.all([${importList}].map((u) => import(u)));`,
    "process.stdout.write('engine-import ms=' + (performance.now() - t).toFixed(2));",
  ].join(' ')

  const scenarios = [
    { id: 'C1', label: `裸 node 进程（node -e ""）`, run: () => spawnSyncMs(NODE_EXE, ['-e', '']) },
    { id: 'C2', label: 'node + 引擎四文件 import', run: () => spawnSyncMs(NODE_EXE, ['--input-type=module', '-e', IMPORT_STUB]) },
    { id: 'C3', label: '裸 pwsh 进程（pwsh -NoProfile -Command ""）', run: () => spawnSyncMs(pwshExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '']) },
    { id: 'C4', label: 'pwsh → node（-Command "& node -e \\"\\""）', run: () => spawnSyncMs(pwshExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${nodeQuote} -e ""`]) },
    {
      id: 'C5',
      label: 'pwsh → node → 引擎 import（= 实际钩子那条链的形状）',
      run: () => spawnSyncMs(pwshExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${nodeQuote} --input-type=module -e "${IMPORT_STUB.replace(/"/g, '""')}"`]),
    },
    {
      id: 'C6',
      label: `pwsh → node → 引擎 → 一次 map（真读 ${outerReadTag}）`,
      run: () => spawnSyncMs(pwshExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$env:R3_JOB='read'; $env:R3_CFG='${PROBE_CFG}'; ${nodeQuote} '${SELF}'`]),
      parse: (s) => {
        const at = s.lastIndexOf('@@R3@@')
        if (at === -1) return null
        try {
          const d = JSON.parse(s.slice(at + 6).trim())
          return { importMs: d.importMs, mapColdMs: d.results?.map?.coldMs, bootToMainMs: d.bootToMainMs }
        } catch {
          return null
        }
      },
    },
  ]

  const outer = []
  for (const s of scenarios) {
    const samples = []
    const extra = []
    for (let i = 0; i < OUTER_REPS; i += 1) {
      const r = s.run()
      samples.push(r.ms)
      if (s.parse) extra.push(s.parse(r.stdout))
    }
    outer.push({ ...s, samples, extra, stat: statOf(samples) })
  }
  const outerAfter = procCounts()

  say('')
  say(`  ${padR('段', 5)}${padR('场景', 46)}${padL('p50', 10)}${padL('min', 10)}${padL('p90', 10)}${padL('max', 10)}${padL('n', 4)}`)
  for (const s of outer) {
    say(`  ${padR(s.id, 5)}${padR(s.label, 46)}${padL(r2(s.stat.p50), 10)}${padL(r2(s.stat.min), 10)}${padL(r2(s.stat.p90), 10)}${padL(r2(s.stat.max), 10)}${padL(s.stat.n, 4)}`)
  }
  say('')
  const c1 = outer.find((s) => s.id === 'C1').stat.p50
  const c3 = outer.find((s) => s.id === 'C3').stat.p50
  const c4 = outer.find((s) => s.id === 'C4').stat.p50
  const c5 = outer.find((s) => s.id === 'C5').stat.p50
  const c2 = outer.find((s) => s.id === 'C2').stat.p50
  const c6 = outer.find((s) => s.id === 'C6').stat.p50
  say('  构成分解（p50，全部以"单个新进程走完"为口径）')
  say(`    OS 拉起 node                               ≈ C1                         = ${r2(c1)} ms`)
  say(`    node + 引擎模块图（C2 − C1）                ≈                          = ${r2(c2 - c1)} ms   （引擎 import 段实测：${outer.find((s) => s.id === 'C2').samples.length} 次）`)
  say(`    pwsh 进程本身（C3）                         = ${r2(c3)} ms`)
  say(`    pwsh 拉起并等 node 收尾（C4 − C3 − C1）      = ${r2(c4 - c3 - c1)} ms`)
  say(`    整链 pwsh→node→引擎（C5）                    = ${r2(c5)} ms`)
  say(`      ↳ 其中与工具无关的固定税（C5 − 引擎 import 段）：见下）`)
  say(`    pwsh→node→引擎→一次 map 读（C6）             = ${r2(c6)} ms`)
  const c6d = outer.find((s) => s.id === 'C6').extra.filter(Boolean)
  if (c6d.length > 0) {
    say(`      ↳ 该链内引擎自报：import p50=${r2(med(c6d.map((d) => d.importMs)))}ms  map 冷读 p50=${r2(med(c6d.map((d) => d.mapColdMs).filter((v) => typeof v === 'number')))}ms`)
  }
  say('')
  say('  原始样本')
  for (const s of outer) say(`    ${padR(s.id, 4)}${padR(s.label, 46)} ${s.samples.map(r2).join(', ')}`)
  say('')
  say(`  C 段测量前后进程数：node.exe ${outerBefore.node}→${outerAfter.node}  pwsh.exe ${outerBefore.pwsh}→${outerAfter.pwsh}`)

  // ── D 增长最快的一格 ────────────────────────────────────────────────────────
  say('')
  say('─'.repeat(100))
  say(' D 随体量增长最快的一格（log-log 幂次拟合：ms ∝ lines^slope）')
  say('─'.repeat(100))
  const growth = []
  for (const mode of MODES) {
    const pts = tags.map((t) => ({ n: sizeOf.get(t), v: cell(mode, t)?.cold?.p50 })).filter((p) => Number.isFinite(p.v) && p.v > 0)
    if (pts.length >= 2) growth.push({ what: `read/${mode}（冷）`, slope: slopeOf(pts), pts })
  }
  // 写侧：冷 / 热两趟的每一格各拟合一次
  for (const [passLabel, key] of [['A冷', 'results'], ['B热', 'warmResults']]) {
    for (const k of ['read', 'bom', 'plan', 'gate', 'disk', 'verify', 'e2e']) {
      const xs = writeRows
        .filter((x) => x.run !== null)
        .map((x) => ({ n: x.total, v: statOf(x.run[key][k])?.p50 }))
        .filter((p) => Number.isFinite(p.v) && p.v > 0)
      if (xs.length >= 2) growth.push({ what: `write/${passLabel}/${k}`, slope: slopeOf(xs), pts: xs })
    }
  }
  // 引擎微基准（µs → ms 后再拟合；尺度不影响斜率）
  for (const k of ['splitLines(src.split)', 'contentToken', 'readText(provider)', 'statSync', 'fileByteOrderMarkCount', 'planHunks', 'regionGate(ledger=set)', 'regionGate(ledger=empty)', 'verifyWriteBack', 'readByteRange(window)', 'CTRL bare write+read', 'CTRL bare write only', 'CTRL bare read only']) {
    const xs = writeRows
      .filter((x) => x.run !== null)
      .map((x) => ({ n: x.total, v: x.run.micro[k] / 1000 }))
      .filter((p) => Number.isFinite(p.v) && p.v > 0)
    if (xs.length >= 2) growth.push({ what: `micro/${k}`, slope: slopeOf(xs), pts: xs })
  }
  growth.sort((a, b) => b.slope - a.slope)
  for (const g of growth) {
    say(`    ${padR(g.what, 22)} slope=${padL(r2(g.slope), 6)}   ${g.pts.map((p) => `${p.n}行:${r2(p.v)}ms`).join('  ')}`)
  }
  say('')

  // ── 结果 JSON ──────────────────────────────────────────────────────────────
  const result = {
    unit: 'R3',
    at: new Date().toISOString(),
    repo: REPO,
    machine: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, totalMemGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)) },
    timingContract: {
      procBefore: live,
      procAfterOuter: outerAfter,
      counters: pressCounters(),
      reps: { hot: REPS, cold: COLD_REPS, outer: OUTER_REPS, write: WRITE_REPS, gateIters: GATE_ITERS },
      definition: {
        cold: '新进程里的第一次调用（结构索引缓存必空）',
        inprocFirst: '同进程内该模式的第一次调用（与 cold 分开列）',
        hot: '同进程、同内容、同 filePath 的第 3..N 次调用（记忆化命中）',
      },
    },
    corpus: corpus.map((c) => ({ tag: c.tag, kind: c.kind, file: c.file, lines: c.lines, bytes: fs.statSync(c.file).size })),
    readMatrix: modeRows.map((m) => ({ ...m, imports: m.imports === null ? null : { n: m.imports.n, p50: m.imports.p50, min: m.imports.min, max: m.imports.max }, boots: m.boots === null ? null : { n: m.boots.n, p50: m.boots.p50, min: m.boots.min, max: m.boots.max } })),
    writeMatrix: writeRows.map((w) => ({
      corpus: w.corpus.tag,
      lines: w.total,
      hunks: w.hunks,
      hunkLines: w.hunkLines,
      proc: w.proc,
      selfCheck: w.run?.selfCheck ?? null,
      passA: w.run === null ? null : Object.fromEntries(Object.entries(w.run.results).map(([k, v]) => [k, statOf(v)])),
      passB: w.run === null ? null : Object.fromEntries(Object.entries(w.run.warmResults).map(([k, v]) => [k, statOf(v)])),
      micro: w.run?.micro ?? null,
      rawA: w.run?.results ?? null,
      rawB: w.run?.warmResults ?? null,
      selfCheck: w.run === null ? null : w.run.expectedChars === w.run.finalChars,
      failed: w.run === null ? w.raw.stderr : null,
    })),
    outerTax: Object.fromEntries(outer.map((s) => [s.id, { label: s.label, stat: s.stat, samples: s.samples, extra: s.extra.filter(Boolean) }])),
    growth,
    elapsedMs: now() - tStart,
  }
  if (OUT !== null) {
    // **追加**而不是覆盖：尺寸档要分批跑（100k 档每次调用就是秒级，得单独跑），
    // 三次运行的读数必须落进同一份回执，而不是后一次把前一次抹掉。JSONL：一行一次运行。
    const existed = fs.existsSync(OUT)
    fs.appendFileSync(OUT, `${JSON.stringify(result)}\n`)
    say(`  全量原始读数已${existed ? '追加' : '落盘'}（JSONL，一行一次运行）：${OUT}`)
  }
  say('')
  say(`  总耗时 ${r2(result.elapsedMs / 1000)} s`)
  return result
}

/** 最小二乘拟合 log(v) = a + slope·log(n)。 */
function slopeOf(pts) {
  const xs = pts.map((p) => Math.log(p.n))
  const ys = pts.map((p) => Math.log(p.v))
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

if (JOB === 'read' || JOB === 'write') await childMain()
else await main()
