#!/usr/bin/env node
/**
 * single-target-nonregression-test —— **单目标不许回归**的红线（fs-contract-v2 / mt1）。
 *
 * ## 它是干什么的
 *
 * 接下来的改造是"一次调用多目标 + 调用内并发池"。那三件事的**全部风险**都压在同一个方向上：
 * 为了多目标把单目标那条路重写一遍（多跑一次、多读一次、多建一次索引、回执里多一个字段），
 * 而验收又只看新功能通不通 —— 于是"单目标悄悄变慢/变大/变了形状"没有一台机器会发现。
 * 这一件就是那台机器：它把 0.6.9 的单目标行为**采成黄金集**，之后每次跑都现场重算并逐字节比对。
 *
 * ## 四类判据（前两类字节级，后两类结构级；**一个 wall-clock 阈值都没有**）
 *
 *   ① `read-bytes`    单目标读回执逐字节不变：3 份仓内固定夹具 × `lines`/`search`/`digest`/`map` 四模式，
 *                     `readWith` 的**整个信封** `JSON.stringify` 后与黄金集逐字节比。
 *   ② `edit-bytes`    单目标编辑回执逐字节不变 + **落盘字节** + 写次数：
 *                     `applyEditToProvider`（与 CLI/MCP 同一个编排入口）+ `createNodeFsProvider`，
 *                     在临时副本上做一个单 hunk 编辑；回执、写后的文件字节、写入次数三者一起钉。
 *   ③ `provider-calls` N=1 时 provider 调用**序列**不变：计数 provider（包住真 provider，逐方法记账）
 *                     跑一次单目标读、一次单目标写；调用序列与次数逐项比对。
 *                     这一条是"多目标改造不许在 N=1 上偷偷多跑一遍"的把柄。
 *   ④ `index-builds` 索引构建次数不变：100k 行的档单目标读一遍，`indexCacheStats()` 只多**一条**索引
 *                     且被准入（`bytes` 增长）；再读一遍不新增条目；用**内层数组身份**
 *                     （命中时 `indexStructure` 返回浅拷贝 ⇒ `tokens` 是同一个对象）证明第二遍**没有重建**。
 *
 * ## 为什么"没有计时"反而是更强的判据
 *
 * 本仓被"按可用内存估额度"的计时判据咬过两次。这里一条时间都不测：判的是**字节与调用形状**，
 * 而这两样不随负载漂移。第④类唯一一处与内存有关的地方（索引缓存额度）被**钉死在进程里**
 * （`AURA_INDEX_CACHE_MB`，见下面 `CACHE_MB`），于是连它也不随可用内存漂移。
 *
 * ## 规范化：怎么做的、为什么这么做还抓得住真变化
 *
 * 三处**机器相关**的东西被归一，别的一个字节都不动：
 *   · 夹具路径 —— 读用例把 `filePath` 固定成**仓内相对写法**（`aura-tools/fixtures/…`），
 *     回执里因此**从来没有绝对路径**（实测：整份回执里扫不到任何盘符绝对路径，也扫不到时间戳）。
 *     句柄里的身份标签是按账本键算的 ⇒ 键固定则句柄固定 ⇒ 可跨进程、跨目录比对。
 *   · 临时目录 —— 写用例在 `os.tmpdir()` 下的**新建临时目录**里跑，回执里的 `path` 用相对名
 *     （`target.mjs`），所以回执本身不含临时路径；只有 provider 调用序列里的 `stat` 目标带绝对路径，
 *     那里把工作目录、`os.tmpdir()`、仓根三个前缀分别换成 `<WORK>` / `<TMP>` / `<ROOT>`，并把分隔符统一成 `/`。
 *   · 索引额度 —— 见 `CACHE_MB`（进程内固定 128 MiB）。
 * 为什么这样仍抓得住真变化：被抹掉的只有"这台机器把它放在哪个目录"和"额度是多少"，
 * 而**方法名、参数形状、调用次数、调用顺序、字段集合、字段顺序、每一个字符**都还在比对里。
 * 多一次 `stat`、少一次 `readText`、回执多一个字段、少一个字段、改一个字符 —— 全部照红。
 *
 * ## 判定力是自证的（段E）
 *
 * 段E 对**内存里**的黄金回执做两次合成变异（改一个字符 / 多一个字段），断言比较器必须判红。
 * 这一条不替代"真变异反证"，它防的是另一种失效：比较器被写空（永远返回相等）而套件照印全绿。
 *
 * ## 怎么重新采（黄金集不许手写，只能由脚本生成）
 *
 * 一句话：**这套件自己带采集模式，采集与比对走同一份用例定义，因此不可能漂移**。
 * 可复制命令（在工作树仍等于黄金集所记指纹时跑；它会覆盖下面的 `GOLDEN`）：
 *
 *     node src/locator-lab/single-target-nonregression-test.mjs --capture
 *
 * 采完必须 `git diff` 看一眼 `aura-tools/fixtures/golden-single-target-0.6.9.json`：
 * 重新采一遍应当**零 diff**（黄金集里没有任何时间戳/随机量）。
 *
 * ## 退出码
 *
 * 判据全部接在退出码上（末行 `--- N/N 通过 ---`，有任何一条 ✗ 就 `exit 1`）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pkgRoot, pkgPath } from '../../build/pkg-root.mjs'

/**
 * 索引缓存额度**钉在进程里**（引擎支持的覆写：`AURA_INDEX_CACHE_MB`，被 [8, 256] MiB 夹住）。
 *
 * 为什么必须钉：不钉的话额度 = `clamp(可用内存/16, …)`，机器一忙就可能小到"100k 行的索引进不了缓存"，
 * 而第④类的判据（只多一条索引）在"没进缓存"时根本无法成立 —— 那就会变成一条随负载漂移的红，
 * 正是本仓被咬过两次的那种假红。钉死之后这一条的读数是**结构性的**，与可用内存无关。
 * 它必须在 `struct-core.mjs` 被 import **之前**设置（额度是模块初始化时定一次的），
 * 所以下面全部用动态 `import()`。
 */
const CACHE_MB = 128
process.env.AURA_INDEX_CACHE_MB = String(CACHE_MB)

const here = path.dirname(fileURLToPath(import.meta.url))
/** 包根从文件位置推导（`build/pkg-root.mjs`）：目录名不参与路径。旧写法是 `path.join(ROOT, 'aura-tools', …)`。 */
const ROOT = pkgRoot
const FIXTURES = pkgPath('fixtures')
const GOLDEN = path.join(FIXTURES, 'golden-single-target-0.6.9.json')
const CAPTURE = process.argv.includes('--capture')

const { readWith } = await import('./read-core.mjs')
const { indexStructure, indexCacheStats, langOf } = await import('./struct-core.mjs')
const { applyEditToProvider } = await import('./write-path.mjs')
const { createNodeFsProvider } = await import('../aura-standalone/lib/fs-provider.mjs')
const { readEnvelope, readFileBytes } = await import('../aura-standalone/lib/ops.mjs')

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  return ok
}

// ── 指纹：黄金集采自哪棵树 ────────────────────────────────────────────────
const FINGERPRINT_FILES = ['read-core.mjs', 'write-path.mjs', 'handle-core.mjs', 'args.mjs']
const sha16 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
const treeFilesSha = () =>
  Object.fromEntries(FINGERPRINT_FILES.map((name) => [name, sha16(path.join(here, name))]))
/** 夹具指纹（sha256:16）：用来把"夹具被改"与"引擎被改"分开 —— 两者都会让回执变，处置却完全不同。 */
const credentialsSha = (name) =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURES, name))).digest('hex').slice(0, 16)

const installedState = () => {
  for (const candidate of [path.join(os.homedir(), '.aura', 'pkg', 'install.json')]) {
    try {
      const state = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      return { version: state.version ?? null, buildStamp: state.buildStamp ?? null }
    } catch {
      /* 没装过就没有，不当作判据 */
    }
  }
  return { version: null, buildStamp: null }
}

// ── 规范化（只有这三样被抹掉，理由见文件头） ──────────────────────────────
const POSIX = (p) => String(p).split(path.sep).join('/')
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-single-target-nr-'))
const tempPosix = POSIX(tempHome)
const tmpPosix = POSIX(os.tmpdir())
const rootPosix = POSIX(ROOT)
/** 把回执/调用序列里"这台机器把它放在哪"抹成固定记号；别的字符一个都不动。 */
const normalizeText = (text) =>
  String(text)
    .split(path.sep).join('/')
    .split(tempPosix).join('<WORK>')
    .split(tmpPosix).join('<TMP>')
    .split(rootPosix).join('<ROOT>')

/**
 * 夹具的仓内相对写法（**就是它进了请求**，所以回执里没有绝对路径，见文件头）。
 *
 * 注意：这里的 `aura-tools/` 是**黄金集钉住的历史显示路径**，不是磁盘定位 —— `readWith` 拿到的
 * 是夹具正文（`readFileBytes` 直读），`filePath` 只进回执。改它等于改期望读数，所以保持原样；
 * 真正读盘的那一侧走 `FIXTURES`（= 包根，由文件位置推导）。
 */
const fixtureRel = (name) => `aura-tools/fixtures/${name}`
const fixtureAbs = (name) => path.join(FIXTURES, name)

// ── 计数 provider：包住真 provider，逐方法记一条 `方法:目标` ────────────────
const COUNTED_METHODS = ['resolve', 'stat', 'readText', 'readByteRange', 'listDir', 'writeText']
function countingProvider(inner) {
  const calls = []
  const out = {}
  for (const method of COUNTED_METHODS) {
    const fn = inner[method]
    if (typeof fn !== 'function') continue
    out[method] = (...args) => {
      calls.push(`${method}:${normalizeText(args[0])}`)
      return fn.apply(inner, args)
    }
  }
  out.calls = calls
  return out
}
const countOf = (calls, method) => calls.filter((line) => line.startsWith(`${method}:`)).length

// ── 夹具与请求：**用例定义只有这一份**，采集与比对共用 ─────────────────────
const FIXTURE_NAMES = ['golden-target-small.mjs', 'golden-target-large.mjs', 'golden-target-crlf-bom.mjs']
const READ_MODES = [
  ['lines', (name) => (name === 'golden-target-small.mjs' ? { mode: 'lines', lines: [10, 30] }
    : name === 'golden-target-large.mjs' ? { mode: 'lines', lines: [400, 460] }
      : { mode: 'lines', lines: [5, 20] })],
  ['search', (name) => (name === 'golden-target-small.mjs' ? { mode: 'search', search: 'items' }
    : name === 'golden-target-large.mjs' ? { mode: 'search', search: 'CONFIG_07' }
      : { mode: 'search', search: 'lines' })],
  ['digest', () => ({ mode: 'digest' })],
  ['map', () => ({ mode: 'map' })],
]

/** 单 hunk 编辑：把 `VERSION` 那一行改成一个固定串（符号寻址，与真工具同形）。 */
const EDIT_HUNKS = [{ target: 'VERSION', replace: "export const VERSION = '0.6.9-nr'" }]
const EDIT_LINE = "export const VERSION = '0.6.9'"
const EDIT_LINE_AFTER = "export const VERSION = '0.6.9-nr'"

/** 100k 行档：内容在内存里现造（与 `index-cache-test.mjs` 同一口径 —— 那件也是现造的）。 */
const BIG_LINES = 100000
const BIG_BLOCK = 7
function corpusOf(tag, lineTarget) {
  const head = [
    `/** ${tag} 语料头 */`,
    `export function ${tag}RootPick(value) {`,
    `  return value % 4096`,
    `}`,
  ]
  const tail = [`export function ${tag}Finish(value) {`, `  return value % 11`, `}`]
  const full = Math.max(1, Math.floor((lineTarget - head.length - tail.length) / BIG_BLOCK))
  const blocks = []
  for (let b = 0; b < full; b += 1) {
    const k = (b % 89) + 2
    blocks.push(
      `/** ${tag} ${b} */`,
      `export function ${tag}${b}(value) {`,
      `  const scaled${tag}${b} = value * ${k}`,
      `  if (scaled${tag}${b} > 4096) return scaled${tag}${b} - 1`,
      `  return scaled${tag}${b} % 4096`,
      `}`,
      ``,
    )
  }
  const used = head.length + full * BIG_BLOCK + tail.length
  const pad = Math.max(0, lineTarget - used)
  return [...head, ...blocks, ...tail, ...Array.from({ length: pad }, (_, i) => `// ${tag} 填充 ${i}`)].join('\n')
}
const BIG_SRC = corpusOf('nr1a', BIG_LINES)
const BIG_REL = 'aura-tools/fixtures/generated/golden-target-100k.mjs'
const bigRequest = () => ({ mode: 'map', filePath: BIG_REL })

// ── 现场重算：每一个 case 一条，返回与黄金集同形的记录 ─────────────────────
const cases = []

function readBytesCases() {
  for (const name of FIXTURE_NAMES) {
    const got = readFileBytes(fixtureAbs(name))
    if (got.error !== undefined) throw new Error(`${name}: ${got.error.error}`)
    for (const [mode, build] of READ_MODES) {
      const rel = fixtureRel(name)
      const request = { ...build(name), filePath: rel, byteOrderMark: got.byteOrderMark }
      const env = readWith(got.source, request)
      cases.push({
        name: `read-bytes/${name.replace('golden-target-', '').replace('.mjs', '')}-${mode}`,
        kind: 'read-bytes',
        request: { entry: 'readWith', fixture: rel, ...request },
        receipt: JSON.stringify(env),
        providerCalls: null,
      })
    }
  }
}

async function editBytesCases() {
  const target = path.join(tempHome, 'target.mjs')
  fs.copyFileSync(fixtureAbs('golden-target-small.mjs'), target)
  const provider = countingProvider(createNodeFsProvider({ resolveRoot: tempHome }))
  const receipt = await applyEditToProvider(provider, { displayPath: 'target.mjs', hunks: EDIT_HUNKS })
  const after = fs.readFileSync(target)
  cases.push({
    name: 'edit-bytes/single-hunk',
    kind: 'edit-bytes',
    request: { entry: 'applyEditToProvider', fixture: fixtureRel('golden-target-small.mjs'), displayPath: 'target.mjs', hunks: EDIT_HUNKS },
    receipt: normalizeText(JSON.stringify(receipt)),
    providerCalls: provider.calls,
  })
  return { receipt, after, calls: provider.calls.slice() }
}

async function providerCallCases() {
  // 读两次（大档与小档各一次）——写的那一次就是 ②，这里只钉它的调用序列。
  const small = path.join(tempHome, 'small.mjs')
  fs.copyFileSync(fixtureAbs('golden-target-small.mjs'), small)
  const readSmall = countingProvider(createNodeFsProvider({ resolveRoot: tempHome }))
  await readEnvelope(readSmall, { file: 'small.mjs', lines: '10,20' })
  cases.push({
    name: 'provider-calls/read-lines-small',
    kind: 'provider-calls',
    request: { entry: 'readEnvelope', file: 'small.mjs', lines: '10,20' },
    receipt: null,
    providerCalls: readSmall.calls,
  })

  const big = path.join(tempHome, 'big.mjs')
  fs.copyFileSync(fixtureAbs('golden-target-large.mjs'), big)
  const readBig = countingProvider(createNodeFsProvider({ resolveRoot: tempHome }))
  await readEnvelope(readBig, { file: 'big.mjs', search: 'CONFIG_07' })
  cases.push({
    name: 'provider-calls/read-search-large',
    kind: 'provider-calls',
    request: { entry: 'readEnvelope', file: 'big.mjs', search: 'CONFIG_07' },
    receipt: null,
    providerCalls: readBig.calls,
  })

  const second = path.join(tempHome, 'second.mjs')
  fs.copyFileSync(fixtureAbs('golden-target-small.mjs'), second)
  const write = countingProvider(createNodeFsProvider({ resolveRoot: tempHome }))
  await applyEditToProvider(write, { displayPath: 'second.mjs', hunks: EDIT_HUNKS })
  cases.push({
    name: 'provider-calls/edit-single-hunk',
    kind: 'provider-calls',
    request: { entry: 'applyEditToProvider', displayPath: 'second.mjs', hunks: EDIT_HUNKS },
    receipt: null,
    providerCalls: write.calls,
  })
  return { readSmall: readSmall.calls, readBig: readBig.calls, write: write.calls }
}

/**
 * ④ 索引构建次数：单目标读一遍 100k 行只建**一条**索引，第二遍**不重建**。
 *
 * 观测手段两样，都不含时间：
 *   · `indexCacheStats()` 的 `entries` / `bytes` 增量（口径取自 `index-cache-test.mjs`）；
 *   · **内层数组身份**：`indexStructure` 命中时返回 `{...hit.index}`（浅拷贝 ⇒ `tokens` 还是缓存里那一批对象），
 *     未命中则整批重建 ⇒ 换对象。于是"第二遍读有没有重建"变成一次 `===` 比对，
 *     而不是一次计时。
 */
function indexBuildCases() {
  const stats0 = indexCacheStats()
  const first = readWith(BIG_SRC, bigRequest())
  const stats1 = indexCacheStats()
  const BIG_LANG = langOf(BIG_REL)
  const witness1 = indexStructure(BIG_SRC, BIG_LANG)
  const stats2 = indexCacheStats()
  const second = readWith(BIG_SRC, bigRequest())
  const stats3 = indexCacheStats()
  const witness2 = indexStructure(BIG_SRC, BIG_LANG)
  const readings = {
    budgetSource: stats0.budgetSource,
    maxBytes: stats0.maxBytes,
    firstReadOk: first.ok === true,
    entriesDelta: stats1.entries - stats0.entries,
    bytesGrew: stats1.bytes > stats0.bytes,
    witnessIsHit: stats2.entries === stats1.entries,
    secondReadNewEntries: stats3.entries - stats2.entries,
    secondReadBytesDelta: stats3.bytes - stats2.bytes,
    secondReadKeptIndexObjects: witness1.tokens === witness2.tokens,
    secondReadReceiptIdentical: JSON.stringify(first) === JSON.stringify(second),
    totalLines: first.totalLines,
  }
  cases.push({
    name: 'index-builds/read-map-100k',
    kind: 'index-builds',
    request: { entry: 'readWith', filePath: BIG_REL, mode: 'map', sourceLines: BIG_LINES, cacheMb: CACHE_MB },
    receipt: JSON.stringify(readings),
    providerCalls: null,
  })
  return readings
}

// ── 比对：逐字节（字符串全等）＋ 点名是哪一类哪一条 ────────────────────────
const RED = Symbol('red')
function compare(kind, name, actual, expected, what, record = true) {
  if (actual === expected) return true
  const detail = (() => {
    const a = String(actual)
    const b = String(expected)
    if (a.length !== b.length) return `长度 ${b.length} → ${a.length}`
    let i = 0
    while (i < a.length && a[i] === b[i]) i += 1
    return `首个不同字符在第 ${i} 位：采自 ${JSON.stringify(b.slice(Math.max(0, i - 20), i + 20))}，现算 ${JSON.stringify(a.slice(Math.max(0, i - 20), i + 20))}`
  })()
  if (record) check(false, `[${name}] ${what}逐字节不变`, detail)
  return RED
}

say(`靶子：单目标读/写（fs-contract-v2 / mt1 红线）｜夹具目录 ${POSIX(path.relative(ROOT, FIXTURES))}`)
say(`规范化：夹具路径用仓内相对写法（回执里无绝对路径）；临时目录前缀 → <WORK>/<TMP>/<ROOT>；索引额度钉死 ${CACHE_MB} MiB`)
say('')

readBytesCases()
const editRun = await editBytesCases()
const providerRuns = await providerCallCases()
const indexReadings = indexBuildCases()

if (CAPTURE) {
  const state = installedState()
  const golden = {
    suite: 'single-target-nonregression-test',
    unit: 'mt1-redline',
    capturedFrom: { version: state.version, buildStamp: state.buildStamp, filesSha: treeFilesSha() },
    normalization: {
      'read-bytes': '夹具路径用仓内相对写法进请求 ⇒ 回执里没有绝对路径（实测扫不到盘符绝对路径与时间戳）⇒ 恒等比对，零改写',
      'edit-bytes': '临时目录前缀 → <WORK>；路径分隔符 → /；其余（含字段集合、字段顺序、每个字符）逐字节比',
      'provider-calls': '调用序列逐项比；目标里的临时目录/系统临时根/仓根前缀 → <WORK>/<TMP>/<ROOT>，分隔符 → /',
      'index-builds': '结构读数（条目/字节增量、内层数组身份、两次读回执是否全等、额度来源与上限）逐字节比；不记任何绝对字节数中的内存相关量',
    },
    fixtures: FIXTURE_NAMES.map(fixtureRel),
    /** 夹具指纹：红了的时候用它把"夹具被改"与"引擎被改"分开（两者都会让回执变，但处置完全不同）。 */
    fixturesSha: Object.fromEntries(FIXTURE_NAMES.map((name) => [name, credentialsSha(name)])),
    howToRecapture: 'node src/locator-lab/single-target-nonregression-test.mjs --capture',
    cases,
  }
  fs.writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`, 'utf8')
  say(`✓ 已采集黄金集：${POSIX(path.relative(ROOT, GOLDEN))}（${cases.length} 个 case，指纹 ${JSON.stringify(golden.capturedFrom.filesSha)}）`)
  say(`--- ${results.length}/${results.length} 通过 ---`)
  fs.rmSync(tempHome, { recursive: true, force: true })
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

if (!fs.existsSync(GOLDEN)) {
  check(false, '黄金集存在', `缺 ${POSIX(path.relative(ROOT, GOLDEN))} —— 用 \`node ${POSIX(path.relative(ROOT, fileURLToPath(import.meta.url)))} --capture\` 现采（不许手写）`)
  say(`--- ${results.filter((r) => r.ok).length}/${results.length} 通过 ---`)
  process.exit(1)
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
const byName = new Map(golden.cases.map((c) => [c.name, c]))
const live = new Map(cases.map((c) => [c.name, c]))

say('=== ① 单目标读回执逐字节不变（readWith × 3 夹具 × lines/search/digest/map） ===')
const readBytesFailures = []
for (const record of cases.filter((c) => c.kind === 'read-bytes')) {
  const pinned = byName.get(record.name)
  if (pinned === undefined) {
    check(false, `[${record.kind}/${record.name}] 黄金集里有这一条`, '黄金集缺这一条 ⇒ 夹具或模式表变了，重采前先确认这是有意的')
    continue
  }
  if (compare(record.kind, record.name, record.receipt, pinned.receipt, '回执') === RED) readBytesFailures.push(record.name)
}
check(
  readBytesFailures.length === 0,
  '[read-bytes] 12 条回执（3 夹具 × lines/search/digest/map）逐字节等于黄金集',
  readBytesFailures.length === 0 ? 'small/large/crlf-bom 三份，含 BOM+CRLF 那份' : `红的：${readBytesFailures.join('；')}`,
)
check(
  cases.filter((c) => c.kind === 'read-bytes').every((c) => !/[A-Za-z]:\//.test(c.receipt) && !c.receipt.includes(rootPosix)),
  '[read-bytes/*] 回执里没有绝对路径（规范化=恒等的前提）',
  '扫的是盘符绝对路径与仓根前缀',
)

say('')
say('=== ② 单目标编辑回执逐字节不变 + 落盘字节 + 写次数（applyEditToProvider + 真 provider） ===')
{
  const pinned = byName.get('edit-bytes/single-hunk')
  const liveRecord = live.get('edit-bytes/single-hunk')
  if (pinned === undefined) {
    check(false, '[edit-bytes/single-hunk] 黄金集里有这一条', '黄金集缺这一条 ⇒ 重采前先确认这是有意的')
  } else {
    const receiptRed = compare('edit-bytes', 'single-hunk', liveRecord.receipt, pinned.receipt, '回执') === RED
    const callsRed = compare('edit-bytes', 'single-hunk', JSON.stringify(liveRecord.providerCalls), JSON.stringify(pinned.providerCalls), 'provider 调用序列') === RED
    check(!receiptRed && !callsRed, '[edit-bytes/single-hunk] 回执与 provider 调用序列逐字节等于黄金集', receiptRed ? '回执红了' : callsRed ? '调用序列红了' : '')
    const expectedBytes = fs.readFileSync(fixtureAbs('golden-target-small.mjs'), 'utf8')
    check(expectedBytes.includes(EDIT_LINE), '[edit-bytes/single-hunk] 夹具里确有要被替换的那一行', EDIT_LINE)
    const want = Buffer.from(expectedBytes.split(EDIT_LINE).join(EDIT_LINE_AFTER), 'utf8')
    check(
      editRun.after.equals(want),
      '[edit-bytes/single-hunk] 落盘字节逐字节等于"夹具替换那一行"',
      `${editRun.after.length} B，差 ${editRun.after.length - want.length} B`,
    )
    check(countOf(editRun.calls, 'writeText') === 1, '[edit-bytes/single-hunk] 写盘次数 = 1', `实际 ${countOf(editRun.calls, 'writeText')} 次`)
    check(
      JSON.stringify(JSON.parse(pinned.receipt)) === pinned.receipt,
      '[edit-bytes/single-hunk] 黄金集里存的就是规范化后的确定性形式（重采零 diff 的前提）',
      '解析再序列化必须逐字节相同：任何字段顺序漂移都会被这一条抓住',
    )
  }
}

say('')
say('=== ③ N=1 时 provider 调用序列不变（计数 provider 包住真 provider） ===')
const providerCallFailures = []
for (const record of cases.filter((c) => c.kind === 'provider-calls')) {
  const pinned = byName.get(record.name)
  if (pinned === undefined) {
    check(false, `[${record.kind}/${record.name}] 黄金集里有这一条`, '黄金集缺这一条 ⇒ 重采前先确认这是有意的')
    continue
  }
  if (compare(record.kind, record.name, JSON.stringify(record.providerCalls), JSON.stringify(pinned.providerCalls), '调用序列') === RED) providerCallFailures.push(record.name)
}
check(
  providerCallFailures.length === 0,
  '[provider-calls] 3 条 N=1 调用序列逐字节等于黄金集（读两形状 + 写一形状）',
  providerCallFailures.length === 0 ? '序列与次数都没变' : `红的：${providerCallFailures.join('；')}`,
)
check(countOf(providerRuns.readSmall, 'stat') === 1 && countOf(providerRuns.readSmall, 'readText') === 0, '[provider-calls/read-lines-small] 单目标读只探一次、不经 provider 重复读文本', `stat=${countOf(providerRuns.readSmall, 'stat')} readText=${countOf(providerRuns.readSmall, 'readText')}`)
check(countOf(providerRuns.readBig, 'stat') === 1 && countOf(providerRuns.readBig, 'listDir') === 0, '[provider-calls/read-search-large] 大档读同样只探一次、不去列目录', `stat=${countOf(providerRuns.readBig, 'stat')} listDir=${countOf(providerRuns.readBig, 'listDir')}`)
check(countOf(providerRuns.write, 'writeText') === 1, '[provider-calls/edit-single-hunk] 单 hunk 编辑只写一次盘', `writeText=${countOf(providerRuns.write, 'writeText')}`)

say('')
say('=== ④ 索引构建次数不变（100k 行档：读一遍只建一条，第二遍不重建） ===')
{
  const pinned = byName.get('index-builds/read-map-100k')
  const liveRecord = live.get('index-builds/read-map-100k')
  if (pinned === undefined) {
    check(false, '[index-builds/read-map-100k] 黄金集里有这一条', '黄金集缺这一条 ⇒ 重采前先确认这是有意的')
  } else {
    check(indexReadings.totalLines === BIG_LINES, '[index-builds/read-map-100k] 读的就是 100k 行档', `${indexReadings.totalLines} 行（源 ${BIG_SRC.length} 字符）`)
    check(indexReadings.budgetSource === 'env(AURA_INDEX_CACHE_*)', '[index-builds/read-map-100k] 额度被钉死（判据因此与可用内存无关）', indexReadings.budgetSource)
    check(indexReadings.entriesDelta === 1, '[index-builds/read-map-100k] 第一遍读**只**多一条索引（不是 0 条也不是 2 条）', `entries +${indexReadings.entriesDelta}`)
    check(indexReadings.bytesGrew, '[index-builds/read-map-100k] 那一条被准入（缓存字节增长 ⇒ 缓存本身是有效观测）', `bytes +…`)
    check(indexReadings.witnessIsHit, '[index-builds/read-map-100k] 读完之后同一份内容已在缓存里（键就是源本身）', `entries 不变`)
    check(indexReadings.secondReadNewEntries === 0 && indexReadings.secondReadBytesDelta === 0, '[index-builds/read-map-100k] 第二遍读不新增条目、不动缓存字节', `entries +${indexReadings.secondReadNewEntries} bytes +${indexReadings.secondReadBytesDelta}`)
    check(indexReadings.secondReadKeptIndexObjects, '[index-builds/read-map-100k] 第二遍读**没有重建**索引（内层数组还是同一批对象）', 'indexStructure 命中 ⇒ 浅拷贝共享 tokens')
    check(indexReadings.secondReadReceiptIdentical, '[index-builds/read-map-100k] 两遍读的回执全等（单目标读是幂等的）', '')
    compare('index-builds', 'read-map-100k', liveRecord.receipt, pinned.receipt, '结构读数')
  }
}

say('')
say('=== 段E 判定力自证：比较器不能被写空（对内存里的黄金回执做合成变异） ===')
{
  const sampleName = cases.find((c) => c.kind === 'read-bytes').name
  const sample = byName.get(sampleName)
  if (sample === undefined) {
    check(false, '[self-check] 黄金集里有可用的读回执样本', '黄金集缺读用例 ⇒ 无法自证比较器')
  } else {
    const mutated = sample.receipt.replace('"ok":true', '"ok":truE')
    check(mutated !== sample.receipt, '[self-check] 合成变异①确实改到了一个字符', '把 "ok":true 改成 "ok":truE')
    check(compare('self-check', sampleName, mutated, sample.receipt, '【合成变异①·改一个字符】回执', false) === RED, '[self-check] 比较器把"改一个字符"判红（判定力①）', '')
    const parsed = JSON.parse(sample.receipt)
    const withExtra = JSON.stringify({ ...parsed, mt1_extra_field: 1 })
    check(withExtra !== sample.receipt, '[self-check] 合成变异②确实多了一个字段', '多一个 mt1_extra_field')
    check(compare('self-check', sampleName, withExtra, sample.receipt, '【合成变异②·多一个字段】回执', false) === RED, '[self-check] 比较器把"多一个字段"判红（判定力②）', '')
    check(live.has(sampleName) && live.get(sampleName).receipt.length > 40, '[self-check] 自证用的样本确实是一份真回执（不是空串）', `${sampleName} 长度 ${sample.receipt.length}`)
  }
}

// ── 指纹：只印不判（引擎一改指纹必变，但"变了"不等于"回归"——回归由上面的字节比对表态） ──
const harvested = golden.capturedFrom.filesSha
const liveSha = treeFilesSha()
const sameTree = FINGERPRINT_FILES.every((name) => harvested?.[name] === liveSha[name])
say('')
say(`[指纹] 黄金集采自 v${golden.capturedFrom.version} / ${golden.capturedFrom.buildStamp}`)
for (const name of FINGERPRINT_FILES) {
  say(`  ${name}: 采自 ${harvested?.[name] ?? '(没记)'}｜现树 ${liveSha[name]}${harvested?.[name] === liveSha[name] ? '' : '  ⚠ 不同'}`)
}
say(`  ⇒ ${sameTree ? '源树指纹一致（黄金集与现树同源）' : '源树指纹不同（引擎已被改过）—— 这不是判据：回归与否由上面的逐字节比对表态'}`)
for (const name of FIXTURE_NAMES) {
  const live = credentialsSha(name)
  say(`  [夹具] ${name}: 采自 ${golden.fixturesSha?.[name] ?? '(没记)'}｜现盘 ${live}${golden.fixturesSha?.[name] === live ? '' : '  ⚠ 夹具被改过（这时回执红是夹具漂移，不是引擎回归）'}`)
}
check(golden.cases.length === cases.length, '[golden] case 数与现场重算的 case 数相同', `黄金集 ${golden.cases.length}｜现场 ${cases.length}`)
check(
  golden.cases.map((c) => c.name).join(',') === cases.map((c) => c.name).join(','),
  '[golden] case 名单与顺序未被改动',
  '多一条、少一条、换顺序都会在这里被点名',
)

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
say('')
if (failed > 0) say(`✗ 失败 ${failed} 条：${results.filter((r) => !r.ok).map((r) => r.label).join('；')}`)
say(`--- ${passed}/${results.length} 通过 ---`)
fs.rmSync(tempHome, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
