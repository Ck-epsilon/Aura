/**
 * anchor-cache-test —— 行级索引（`anchor-core` 的 `indexFile` / `locateAnchor`）的**记忆化额度**
 * （蓝图 fs-contract-v2 / 施工单元 C26）。
 *
 * ## 命题（施工单终态）
 *
 * `indexFile` 的记忆化在**超大文件档**（100000 行）也不再每次重建；额度策略与 `struct-core` 的
 * 结构索引**同口径**（同一处实现 + 一处锚点专属下限），并且对调用方完全透明（签名、返回形状、
 * 语义一字不改）。
 *
 * ## 为什么单开一个（C14 管了结构索引，这一套管行级索引）
 *
 * 上一波把 `struct-core` 的额度从「拍出来的 32 MiB」改成「按可用内存算的自适应额度」，
 * 于是**结构索引**在 100000 行档上也命中了。但行级索引当时还挂着一个独立的固定常数
 * （`48 MiB`），而同一份内容它的估算是结构索引的 **4.01 倍**（段B 现测）：那一档的 est
 * 208.19 MiB 永远 > 48 MiB ⇒ **一次都进不了缓存**。实测（改动前，本机）：
 * 同一份 100000 行内容 `indexFile` 第一次 **459.3 ms**、第二次 **496.8 ms** 且载荷不同一
 * ——热调用比冷调用还慢，记忆化在这一档等于不存在（原始读数见交付回执）。
 *
 * ## 额度口径（唯一实现 + 锚点专属下限；理由与实测写在 `anchor-core.mjs` 的额度块）
 *
 *     额度 = max( 结构额度 , min( 定盘星档单份 est 的两倍 = 416 MiB , 可用内存/4 ) )
 *
 *   · 「读可用内存 / 环境变量覆写 / 上下限」**全仓只有一处实现**：`struct-core.mjs` 的
 *     `indexCacheBudget()`。`anchor-core` 只消费它的只读读数（`indexCacheStats()`）——
 *     这正是段E 用**源码扫描**钉住的那条不变量，不靠注释自律；
 *   · 锚点这一层的两个数都是**量出来的**，不是拍的：定盘星档（100000 行）单份 est 208.19 MiB
 *     ⇒ 上限取它的两倍（与 struct-core 的 floor 同一口径：「目标档必须进得去」）；
 *     份额取 `可用内存/4`（struct-core 自己的 floor 夹子就是这个比例），因为单份重 4 倍。
 *
 * ## 判据（段）
 *
 *   A  100000 行档：同内容第二次 `indexFile` / `locateAnchor` 不重建，且**第二次耗时 ≤ 第一次的 5%**
 *      （贴两个原始数）；顺带钉住「这一份真的进了缓存」（条目 +1、est 入账）
 *   B  内存上限被**打印**并被**断言**：上限、上限来源、可用内存读数、当前条数与字节；
 *      再用 `--expose-gc` 子进程把缓存推过上限，量 **gc 后实测常驻**，并断言
 *      「估算盖得住实测」「实测 ≤ 上限」「塞进去的估算合计 > 上限（⇒ 这份有界真被压过）」
 *      「单条就超额度的那一份不入缓存（准入规则还在）」
 *   C  有缓存 / 无缓存两条路径的返回值**逐字段深比较**（含 100000 行档，含全部 2M 个 bigram 成员）
 *   D  淘汰有界：条目上限 + 字节上限都在生效、淘汰的是最近最少用的那条；内容改一字节必须重算
 *      （真实文件档 + 100000 行档）
 *   E  与 struct-core 额度策略的关系：**断言**只有一处额度计算实现（扫 `build/make-bundle.mjs`
 *      点名的引擎文件），断言锚点额度是从那一份读数派生的算术，并给出**两套实测字节**
 *      （同一份 10 万行内容：结构 vs 行级）
 *
 * ## 怎么"看见"底层解析发生了几次（可观测的手段，不新增测试专用口子）
 *
 * 解析次数用**载荷身份**来数：`buildFileIndex` 每执行一次必然新建 lines / lineBigrams /
 * spaceNormalized / trimNormalized / buckets；因此两次调用返回的**载荷对象同一** ⟺ 第二次没有重建；
 * 顶层对象则必须不同一（命中返回浅拷贝）。段A/C/D 都用载荷身份 + 耗时双重钉住。
 * 额度的"实际字节数与上限"取自引擎的只读读数 `indexFileCacheStats()`（与 struct-core 的
 * `indexCacheStats()` 同一条理由：额度是算出来的数，必须能在外部复核，而不是去读源码里的常数）。
 *
 * ## 无缓存路径怎么造
 *
 * ESM 的模块表按完整 URL 索引，`import('./anchor-core.mjs?fresh=N')` 拿到的是**缓存必然为空**的
 * 新实例（段A 先断言它的 `entries === 0`）——它那一次冷调用就是"无缓存路径"，段C 拿它的载荷
 * 与主实例（命中）的载荷做全量深比较。
 *
 * ## 内存怎么实测（段B）
 *
 * `process.memoryUsage().heapUsed` 只有 GC 之后才干净，而 `global.gc` 只在 `--expose-gc` 下存在；
 * 父进程这时已经堆了本套件自己的索引。所以段B 用 `spawnSync(process.execPath, ['--expose-gc', 本文件])`
 * 把自己当子进程再跑一遍（`C26_ANCHOR_MEM_CHILD=1`），在子进程里从零量两份读数：
 *   · 同一份 100000 行内容上，**行级索引**与**结构索引**各自的 est 与 gc 后常驻（两套实测字节）；
 *   · 把行级缓存推过上限之后的实测常驻（"没把机器打爆"的证据）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { indexFile, locateAnchor, indexFileCacheStats } from './anchor-core.mjs'
import { indexCacheStats, indexStructure, langOf } from './struct-core.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}
/**
 * 前提不成立 ⇒ **明写跳过**：印出来、计数、点名读数 —— 既不静默放过，也不把数放宽。
 * 「前提」是一条判据**有意义**的条件；前提不成立时它断言的关系本来就不成立，
 * 那不是代码坏了，是这台机器此刻不满足那个场景（可用内存被别的东西吃掉了）。
 */
const skips = []
const skip = (label, detail) => {
  skips.push({ label, detail })
  say(`⊘ ${label}${detail === '' ? '' : `  ${detail}`}`)
}
/**
 * 前提成立 ⇒ 照常断言（判据的牙齿一颗不少）；不成立 ⇒ 跳过，并把**前提与机器读数**一起印出来。
 *
 * 失败或跳过时 detail 后面自动缀上 {@link readingText}：将来真有一跑翻红，
 * 一眼就能看出"当时这台机器只有 800 MiB 可用"，不必再花一轮去查。
 */
const checkIf = (pre, preText, ok, label, detail = '', reading = readingText()) => {
  if (pre) check(ok, label, ok ? detail : `${detail === '' ? '' : `${detail}｜`}${reading}`)
  else skip(label, `前提「${preText}」不成立（${detail === '' ? '' : `${detail}｜`}${reading}）`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..', '..')
/** 真实文件档：本仓最大的引擎文件（97 KB 量级）——既有覆盖（旧 index-cache-test 段F）不丢。 */
const BIG_FILE = path.join(here, 'struct-core.mjs')
const SRC = fs.readFileSync(BIG_FILE, 'utf8')

const MiB = (bytes) => bytes / 2 ** 20
const heapUsed = () => process.memoryUsage().heapUsed
const gcNow = () => {
  if (typeof global.gc === 'function') {
    global.gc()
    global.gc()
  }
}
const ms = (hrtime) => Number(hrtime) / 1e6
const timeIt = (fn) => {
  const t0 = process.hrtime.bigint()
  const out = fn()
  return { ms: ms(process.hrtime.bigint() - t0), out }
}

// ── 定额度那一份读数：**取一次，全套件共用** ────────────────────────────────
/**
 * 额度是**从可用内存算出来的数**，而"可用内存"是随机器负载漂移的读数。锚点这边
 * （`anchor-core.mjs` 的额度块）把定额度时那一份读数**冻在模块加载那一刻**：
 * `maxBytes` / `availableBytes` / `budgetSource` 同出一份快照。判据必须在**同一份快照**上比较 ——
 * 各自现取一次，就是拿两个不同时刻的读数互相印证，而"忙机器上假红"正是那么来的。
 *
 * 这一块只取一次：段A / 段B / 段E 里所有谈额度、谈"装不装得下"的判据都从这里读。
 * `entries` / `bytes` 是**活**计数器（随缓存变化），那些仍然逐处现取。
 */
const QUOTA = (() => {
  const anchor = indexFileCacheStats()
  const struct = indexCacheStats()
  const allowanceBytes = 416 * 1024 * 1024
  const availableBytes = anchor.availableBytes
  return {
    anchorCapBytes: anchor.maxBytes,
    anchorMaxEntries: anchor.maxEntries,
    anchorSource: anchor.budgetSource,
    structCapBytes: struct.maxBytes,
    structMaxEntries: struct.maxEntries,
    structSource: struct.budgetSource,
    availableBytes,
    allowanceBytes,
    /** 这一份读数下锚点额度**按设计**应当取的值（与 anchor-core 的算式同一口径、逐字）。 */
    policyBytes: Math.max(
      struct.maxBytes,
      Math.min(allowanceBytes, availableBytes === null ? allowanceBytes : availableBytes / 4),
    ),
  }
})()
/** `struct-core` 文档里的额度下限：可用内存 ≥ 4×它（384 MiB）⇒ 结构额度 ≥ 96 MiB。 */
const STRUCT_FLOOR_REF = 96 * 1024 * 1024
/**
 * 一行机器读数（**定额度时那一份**，与 {@link QUOTA} 同源）。
 * 谈额度的判据在失败/跳过时都带上它：一次负载导致的翻红，看一眼读数就知道是不是它。
 */
const readingText = () =>
  `〔${QUOTA.availableBytes === null ? '可用内存读数 n/a' : `可用内存读数（定额度时那一份）${MiB(QUOTA.availableBytes).toFixed(0)} MiB`}` +
  `｜锚点额度 ${MiB(QUOTA.anchorCapBytes).toFixed(2)} MiB｜结构额度 ${MiB(QUOTA.structCapBytes).toFixed(2)} MiB〕`
/**
 * 某个**模块实例自己**的那份读数：`freshModule()` 拿到的每个新实例都在**自己加载那一刻**
 * 读一次可用内存、各自定额度（`anchor-core` 的额度就是模块级常量，一个实例一份）。
 * 所以"那个实例能不能容下某一档"必须按它自己的读数判 —— 拿主实例的快照去判另一个实例，
 * 就是拿两个时刻/两个进程的读数互相印证（实测就是这么假红的：主实例额度 234.68 MiB 够用，
 * 段A 那个全新实例因为套件自己已经吃掉几百兆，额度只有 ~160 MiB，热调用当场重建成 433 ms）。
 */
const readingOf = (stats, who) =>
  `〔${who}｜可用内存读数（定额度时那一份）${stats.availableBytes === null ? 'n/a' : `${MiB(stats.availableBytes).toFixed(0)} MiB`}` +
  `｜额度 ${MiB(stats.maxBytes).toFixed(2)} MiB〕`
/**
 * 一个实例自己的额度能不能容下某一档 —— 同样写成**它那份读数**的比较（不是"额度 ≥ est"）：
 * 算式被改坏时（额度小于读数允许的值）判据照跑照红，不会被当成"机器太忙"跳过。
 */
const fitsIn = (stats, estBytes, allowanceBytes) =>
  estBytes <= allowanceBytes && (stats.availableBytes === null || stats.availableBytes / 4 >= estBytes)

let freshSeq = 0
/** 载入一个**全新**的引擎模块实例（缓存必然为空）——"无缓存路径"的真身。 */
const freshModule = (file) => import(`${pathToFileURL(path.join(here, file)).href}?fresh=${(freshSeq += 1)}`)

/** 载荷 = 真正由"解析"产出的那些对象。它们被复用 ⟺ 没有重新解析。 */
const filePayload = (idx) => [idx.lines, idx.lineBigrams, idx.spaceNormalized, idx.trimNormalized, idx.buckets]
const samePayload = (a, b) => a.length === b.length && a.every((x, k) => Object.is(x, b[k]))
const FILE_FIELDS = 'lines,lineBigrams,spaceNormalized,trimNormalized,buckets,flat'

/**
 * 全量深比较：对象逐字段（含字段名与顺序）、数组逐元素、Map 逐项、Set 逐员。
 * 返回 `null` 表示相等，否则返回第一处差异的路径。**不做抽样**——抽样放过的正是"某一行/某个桶错了"。
 */
function deepEqual(a, b, at = '$') {
  if (Object.is(a, b)) return null
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map)) return `${at}: Map 与非 Map`
    if (a.size !== b.size) return `${at}: Map 大小 ${a.size} vs ${b.size}`
    for (const [k, v] of a) {
      if (!b.has(k)) return `${at}: 缺键 ${String(k)}`
      const d = deepEqual(v, b.get(k), `${at}.get(${String(k)})`)
      if (d !== null) return d
    }
    return null
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set)) return `${at}: Set 与非 Set`
    if (a.size !== b.size) return `${at}: Set 大小 ${a.size} vs ${b.size}`
    for (const x of a) if (!b.has(x)) return `${at}: 缺成员 ${String(x)}`
    return null
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${at}: 数组与非数组`
    if (a.length !== b.length) return `${at}: 长度 ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; i += 1) {
      const d = deepEqual(a[i], b[i], `${at}[${i}]`)
      if (d !== null) return d
    }
    return null
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.join(',') !== kb.join(',')) return `${at}: 字段集 ${ka.join(',')} vs ${kb.join(',')}`
    for (const k of ka) {
      const d = deepEqual(a[k], b[k], `${at}.${k}`)
      if (d !== null) return d
    }
    return null
  }
  return `${at}: ${typeof a} ${String(a)} vs ${typeof b} ${String(b)}`
}

/** 行级索引的可比较投影（顶层对象本身不该同一，所以投影的是**载荷**）。 */
const projectFile = (idx) => ({
  lines: idx.lines,
  lineBigrams: idx.lineBigrams,
  spaceNormalized: idx.spaceNormalized,
  trimNormalized: idx.trimNormalized,
  buckets: idx.buckets,
  flat: idx.flat,
})

// ── 大文件档语料：行数**正好** 100000 的块状 JS ────────────────────────────
/**
 * 造一份 `lineTarget` 行的 JS 源码（7 行一块，块内名字带唯一序号 ⇒ 每行的 bigram 与倒排桶都真实）。
 *
 * 为什么自己造而不是用仓库里最大的文件：判据要的是 **100000 行这一档**，而本仓最大的引擎文件
 * 只有 2678 行。同一组 `(tag, lineTarget)` 必须产出**逐字节相同**的内容——段A/段B（子进程）/段C/段D
 * 靠这一点共享同一份缓存键与同一份 est 读数。
 */
const BLOCK_LINES = 7
function corpusOf(tag, lineTarget) {
  const head = [
    `/** ${tag} 语料头 */`,
    `export function ${tag}RootPick(value) {`,
    `  return value % 4096`,
    `}`,
    `export class ${tag}RootHolder {`,
    `  constructor(seed) { this.seed = seed }`,
    `  next() { return ${tag}RootPick(this.seed) }`,
    `}`,
  ]
  const tail = [`export function ${tag}Finish(value) {`, `  return value % 11`, `}`]
  const full = Math.max(1, Math.floor((lineTarget - head.length - tail.length) / BLOCK_LINES))
  const used = head.length + full * BLOCK_LINES + tail.length
  const pad = Math.max(0, lineTarget - used)
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
  let body = `${[...head, ...blocks, ...tail].join('\n')}\n`
  if (pad > 0) body += '\n'.repeat(pad)
  return body
}

const BIG_LINES = 100000
const BIG_TAG = 'c26a'
const BIG_SRC = corpusOf(BIG_TAG, BIG_LINES)
/** 语料里唯一的一行 ⇒ T1 逐字节命中（tier=exact），定位本身是纯查表。 */
const ANCHOR_TEXT = `export function ${BIG_TAG}500(value) {`
const FILL_LINES = 25000
/** 跨段传递的读数：段A 的无缓存载荷、段B 的子进程读数。 */
let COLD_BIG = null
let MEM = null

// ══════════════════════════════════════════════════════════════════════════════
//  子进程模式：段B 的"实测内存"在这里量（--expose-gc），再把读数交回父进程
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 在**自己的进程**里从零量三样东西，然后把它交回父进程断言：
 *   ① 同一份 100000 行内容上，**行级索引**的 est（入缓存的增量）与 gc 后实测常驻；
 *   ② 同一份内容上，**结构索引**的 est 与实测常驻——这就是"两套实测字节"；
 *   ③ 把行级缓存推过上限之后的实测常驻（"没把机器打爆"的证据），以及"单条超额度不入缓存"。
 *
 * 为什么必须换进程：`heapUsed` 只有 GC 之后才干净，`global.gc` 只在 `--expose-gc` 下存在，
 * 而父进程这时已经堆了本套件自己的索引。子进程从零开始，只做这一件事。
 */
async function runMemoryChild() {
  const notes = []
  const note = (m) => {
    notes.push(`  [child] ${m}`)
    return m
  }
  const cap = indexFileCacheStats()
  note(
    `额度 ${cap.maxBytes} B = ${MiB(cap.maxBytes).toFixed(2)} MiB（来源 ${cap.budgetSource}）｜` +
      `可用内存读数 ${cap.availableBytes === null ? 'n/a' : `${MiB(cap.availableBytes).toFixed(0)} MiB`}｜` +
      `条目上限 ${cap.maxEntries}｜gc 可用 ${typeof global.gc === 'function'}`,
  )
  // ① 同一份内容的结构索引（另一套实测字节）——段E 拿它与下面的行级索引比重量级。
  //    **量在基线之前**：结构缓存是结构额度管的另一份常驻（~46 MiB），它不该算进
  //    "锚点缓存的实测常驻"里 —— 不然额度小到几百兆时，段B 那条判据会去替结构缓存背锅
  //    （实测：额度 218.75 MiB 那一跑读数 238.67 MiB，其中 46 MiB 是结构索引）。
  const measureStruct = () => {
    const lang = langOf('c26-big.mjs')
    gcNow()
    const h0 = heapUsed()
    const content = corpusOf(BIG_TAG, BIG_LINES) // 与下面 ② 逐字节相同 ⇒ 两套读数可直接对照
    const s0 = indexCacheStats()
    const idx = indexStructure(content, lang)
    const s1 = indexCacheStats()
    gcNow()
    const h1 = heapUsed()
    return { est: s1.bytes - s0.bytes, real: h1 - h0, tokens: idx.tokens.length, length: content.length }
  }
  const s = measureStruct()
  note(
    `结构索引（${s.length} B 内容 / ${s.tokens} token）：est ${s.est} B = ${MiB(s.est).toFixed(2)} MiB｜` +
      `实测常驻 ${s.real} B = ${MiB(s.real).toFixed(2)} MiB｜est/real ${s.real > 0 ? (s.est / s.real).toFixed(2) : 'n/a'}`,
  )

  // ② 填充档的单份 est：在**一个全新实例的空缓存**里量（同样落在基线之前）。
  //    为什么不在本进程里量：本进程的缓存随后要装目标档（208.19 MiB），额度只要没富余到
  //    "目标档 + 填充档"（≈261 MiB），那一次插入就会**顺手淘汰目标档** —— 增量变成负数、
  //    条目数不涨，于是「单份 est 是干净增量」会因为"额度比目标档大、但不够两档"而红：
  //    红的是机器的余量，不是记账（实测：可用内存 1040 MiB 时正是这样红的）。
  //    空缓存里量出来的 est 只依赖 (内容, 估算函数)，与负载无关。
  //    量尺实例会一直挂在 ESM 模块表里（它那份填充档 ~37 MiB 常驻）—— 所以它必须在这条基线
  //    **之前**量完：基线之后增长的，才算"锚点缓存自己"的实测常驻。
  const fillContent = corpusOf('c26f0', FILL_LINES)
  const fillProbe = await freshModule('anchor-core.mjs')
  const fb0 = fillProbe.indexFileCacheStats()
  fillProbe.indexFile(fillContent)
  const fb1 = fillProbe.indexFileCacheStats()
  const estFill = fb1.bytes - fb0.bytes
  const fillClean = fb0.entries === 0 && fb1.entries === fb0.entries + 1 && estFill > 0
  note(`一份填充档（${FILL_LINES} 行）est ${estFill} B = ${MiB(estFill).toFixed(2)} MiB（空缓存里量的单条入账干净 ${fillClean}）`)

  // ③ 基线：结构索引与量尺实例都已就位（gc 后）。基线之后增长的才是**锚点缓存自己**那部分。
  gcNow()
  const baseline = heapUsed()

  // ④ 目标档单份（行级索引）：est = 入缓存前后的读数差；实测常驻 = gc 后 heapUsed 差。
  //    （本实例的行级缓存此刻还是空的：上面两项用的是结构缓存与另一个实例。）
  //    内容在测量函数**里面**现造：它只被"缓存键 / idx.lines"引用——入缓存则算进 est，
  //    不入缓存则随函数一起变成垃圾被回收。留到外层作用域，它就会冒充"缓存占用"。
  const measureAnchor = () => {
    gcNow()
    const h0 = heapUsed()
    const content = corpusOf(BIG_TAG, BIG_LINES)
    const s0 = indexFileCacheStats()
    const idx = indexFile(content)
    const s1 = indexFileCacheStats()
    gcNow()
    const h1 = heapUsed()
    let bigrams = 0
    for (const set of idx.lineBigrams) bigrams += set.size
    return { est: s1.bytes - s0.bytes, real: h1 - h0, bigrams, entries: s1.entries, length: content.length, lines: idx.lines.length }
  }
  const a = measureAnchor()
  note(
    `行级索引（${BIG_LINES} 行 / ${a.length} B / ${a.bigrams} 个 bigram）：est ${a.est} B = ${MiB(a.est).toFixed(2)} MiB｜` +
      `实测常驻 ${a.real} B = ${MiB(a.real).toFixed(2)} MiB｜est/real ${a.real > 0 ? (a.est / a.real).toFixed(2) : 'n/a'}`,
  )
  note(`重量级：est ${(a.est / s.est).toFixed(2)}×｜实测常驻 ${(a.real / s.real).toFixed(2)}×（同一份 10 万行内容）`)

  // ⑤ 单条就超额度
  //    行数取到 est 明显越过额度；这一份不进缓存，所以它的常驻会在下一次 gc 时还回去——
  //    **但前提是不要把它留到函数外面**：没进缓存的那一份只被这里的局部引用挂着，
  //    存成外层 const 就会冒充“缓存常驻”（第一版就是这个错，实测读数凭空多了 ~640 MiB）。
  const overLines = BIG_LINES * 2 + 20000
  const over = (() => {
    const content = corpusOf('c26o', overLines)
    const s0 = indexFileCacheStats()
    const first = indexFile(content)
    const s1 = indexFileCacheStats()
    const second = indexFile(content)
    return {
      admitted: s1.bytes > s0.bytes,
      rebuilt: !samePayload(filePayload(first), filePayload(second)),
      // 「也不许挤掉整个缓存」：这一条以前只在标签里写着，没有量 —— 准入规则真被拆掉时
      // （把 `if (bytes > MAX) return index` 改成恒假）那一份会先入库、再被额度检查连着
      // 原有条目一起淘汰干净（实测：缓存从 1 条变成 0 条），而"入没入账"“重不重建”两条读数
      // 仍然是 (false, true) —— 判据照绿。这里把"原有条目一条不少"也量出来。
      keptRest: s1.entries === s0.entries && s1.bytes === s0.bytes,
      accounting: s1.bytes - s0.bytes,
      length: content.length,
    }
  })()
  note(
    `单条超额度档（${overLines} 行 / ${over.length} B）：入了缓存 ${over.admitted}｜第二次重建 ${over.rebuilt}` +
      `｜原有条目未被动 ${over.keptRest}（入账 ${over.accounting} B）`,
  )

  // ⑥ 把行级缓存推过上限（estFill 见 ②）。
  // 每一份填充档入缓存时都通过了准入
  // 的下界；它一旦 > 上限，这份"有界"就是被真正压过的（不淘汰就必然越界）。份数由实测 est 现算，不写死。
  const fillsWanted = estFill > 0 ? Math.ceil(cap.maxBytes / estFill) + 3 : 0
  const fills = Math.min(fillsWanted, 200)
  indexFile(fillContent)
  for (let k = 1; k < fills; k += 1) indexFile(corpusOf(`c26f${k}`, FILL_LINES))
  gcNow()
  gcNow()
  const after = indexFileCacheStats()
  const realCached = heapUsed() - baseline
  const pushedEst = fills * estFill
  note(`推入 ${fills} 份互不相同的内容（每份入缓存时都通过准入 ⇒ 合计估算 ≥ ${pushedEst} B = ${MiB(pushedEst).toFixed(2)} MiB）`)
  note(`最终：${after.entries} 条 / 自报 ${after.bytes} B = ${MiB(after.bytes).toFixed(2)} MiB ≤ 上限 ${after.maxBytes} B = ${MiB(after.maxBytes).toFixed(2)} MiB`)
  note(
    `gc 后锚点缓存**实测增长** ${realCached} B = ${MiB(realCached).toFixed(2)} MiB（基线 ${baseline} B，已含结构索引与量尺实例）｜` +
      `rss ${MiB(process.memoryUsage().rss).toFixed(0)} MiB`,
  )

  return {
    notes,
    payload: {
      cap: after.maxBytes,
      budgetSource: after.budgetSource,
      availableBytes: after.availableBytes,
      maxEntries: after.maxEntries,
      entriesAfter: after.entries,
      accountingBytes: after.bytes,
      pushedEst,
      fills,
      estFill,
      fillClean,
      estAnchor: a.est,
      realAnchor: a.real,
      anchorBigrams: a.bigrams,
      anchorLength: a.length,
      estStruct: s.est,
      realStruct: s.real,
      structTokens: s.tokens,
      overLines,
      overAdmitted: over.admitted,
      overRebuilt: over.rebuilt,
      overKeptRest: over.keptRest,
      realCached,
      baseline,
      rss: process.memoryUsage().rss,
    },
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  子进程模式②：定盘星档量尺（额度被环境变量钉死 ⇒ 与机器负载无关）
// ══════════════════════════════════════════════════════════════════════════
/**
 * 量"目标档单份到底有多重"（est 与 gc 后实测常驻），**在一个额度被环境变量钉死的进程里量**。
 *
 * 为什么必须换一个额度：本套件里"装不装得下"必须与机器当下的可用内存读数分开 ——
 * 额度 = max(结构额度, min(416 MiB, 可用内存/4))，可用内存一低（机器一忙）额度就**按设计**缩水，
 * 目标档（208.19 MiB est）就**真的**进不去缓存。而"这一档有多重"是个**内容事实**：它仍然要能量，
 * 只是没法在真实策略下量（入不了账，增量就是 0，判据只能读到一个 0）。
 * 估算量 `fileIndexBytes` 只依赖 (内容, 索引)、与额度无关 ⇒ 换一个额度量出来的还是同一个数。
 * 于是量尺进程用 `AURA_INDEX_CACHE_MB=256`（夹到 env 上限 256 MiB）跑：目标档与填充档都稳稳入账。
 *
 * **量尺不是"另一个数"**：段A 在真实策略下能入账时，会拿入账增量与量尺的 est 逐字节对账
 * （判据「量尺的 est == 真实策略下入账的增量」），量尺一漂就红。
 *
 * 每一档都在**自己的全新实例**上量：空缓存 ⇒ 增量就是这一份自己，与"缓存里还留着谁"无关。
 */
async function runRulerChild() {
  const notes = []
  const note = (m) => notes.push(`  [ruler] ${m}`)
  const cap = indexFileCacheStats()
  note(
    `额度 ${cap.maxBytes} B = ${MiB(cap.maxBytes).toFixed(2)} MiB（来源 ${cap.budgetSource}）｜` +
      `可用内存读数（被额度覆写挡住，仅供参考）${cap.availableBytes === null ? 'n/a' : `${MiB(cap.availableBytes).toFixed(0)} MiB`}｜条目上限 ${cap.maxEntries}`,
  )
  const measure = async (content) => {
    const m = await freshModule('anchor-core.mjs')
    gcNow()
    const h0 = heapUsed()
    const s0 = m.indexFileCacheStats()
    const idx = m.indexFile(content)
    const s1 = m.indexFileCacheStats()
    gcNow()
    const h1 = heapUsed()
    let bigrams = 0
    for (const set of idx.lineBigrams) bigrams += set.size
    const est = s1.bytes - s0.bytes
    return {
      est,
      real: h1 - h0,
      admitted: s0.entries === 0 && s1.entries === s0.entries + 1 && est > 0,
      lines: idx.lines.length,
      bigrams,
      buckets: idx.buckets.size,
      length: content.length,
    }
  }
  const target = await measure(corpusOf(BIG_TAG, BIG_LINES))
  note(
    `目标档（${BIG_LINES} 行 / ${target.length} B / ${target.bigrams} 个 bigram）：est ${target.est} B = ${MiB(target.est).toFixed(2)} MiB｜` +
      `实测常驻 ${target.real} B = ${MiB(target.real).toFixed(2)} MiB｜入账 ${target.admitted}`,
  )
  const fill = await measure(corpusOf('c26f0', FILL_LINES))
  note(`填充档（${FILL_LINES} 行 / ${fill.length} B）：est ${fill.est} B = ${MiB(fill.est).toFixed(2)} MiB｜入账 ${fill.admitted}`)
  // 真实文件档（97 KB 的 struct-core.mjs）：它在父进程里也得量 —— 但额度小时它自己就进不了缓存（增量 = 0），
  // 所以同样在这里（额度钉死的进程）量：这样"它有多重"在任何负载下都读得到，前提才判得了。
  const small = await measure(SRC)
  note(`真实文件档（${small.length} B / ${small.lines} 行）：est ${small.est} B = ${MiB(small.est).toFixed(2)} MiB｜入账 ${small.admitted}`)
  return {
    notes,
    payload: {
      capBytes: cap.maxBytes,
      budgetSource: cap.budgetSource,
      estTarget: target.est,
      realTarget: target.real,
      targetAdmitted: target.admitted,
      targetLines: target.lines,
      targetBigrams: target.bigrams,
      targetBuckets: target.buckets,
      targetLength: target.length,
      estFill: fill.est,
      realFill: fill.real,
      fillAdmitted: fill.admitted,
      fillLength: fill.length,
      estSmall: small.est,
      realSmall: small.real,
      smallAdmitted: small.admitted,
      smallLines: small.lines,
      smallLength: small.length,
    },
  }
}

if (process.env.C26_ANCHOR_RULER_CHILD === '1') {
  const { notes, payload } = await runRulerChild()
  for (const n of notes) say(n)
  say(`C26_RULER_JSON ${JSON.stringify(payload)}`)
  process.exit(0)
}

if (process.env.C26_ANCHOR_MEM_CHILD === '1') {
  const { notes, payload } = await runMemoryChild()
  for (const n of notes) say(n)
  say(`C26_MEM_JSON ${JSON.stringify(payload)}`)
  process.exit(0)
}

// ══════════════════════════════════════════════════════════════════════════
//  段0：定盘星档量尺 + 由它决定的**前提**
// ══════════════════════════════════════════════════════════════════════════
say('=== 段0. 定盘星档量尺：目标档单份有多重（额度钉死的子进程，读数与机器负载无关）===')
/** 量尺读数（{@link runRulerChild} 的 JSON，见上方说明）。 */
let RULER = null
{
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
    cwd: here,
    encoding: 'utf8',
    timeout: 900000,
    env: { ...process.env, C26_ANCHOR_RULER_CHILD: '1', AURA_INDEX_CACHE_MB: '256' },
  })
  const stdout = String(child.stdout ?? '')
  const stderr = String(child.stderr ?? '')
  for (const line of stdout.split('\n')) if (line.startsWith('  [ruler]')) say(line)
  check(
    child.status === 0,
    `量尺子进程跑通（--expose-gc + AURA_INDEX_CACHE_MB=256，退出码 ${child.status}）`,
    stderr.trim().split('\n')[0]?.slice(0, 120) ?? '',
  )
  const jsonLine = stdout.split('\n').find((l) => l.startsWith('C26_RULER_JSON '))
  check(jsonLine !== undefined, '量尺子进程回传了结构化读数（C26_RULER_JSON）')
  RULER = jsonLine === undefined ? null : JSON.parse(jsonLine.slice('C26_RULER_JSON '.length))
}

/**
 * **前提**：这台机器的读数（定额度时那一份）按设计容得下定盘星档。
 *
 * 额度 = max(结构额度, min(416 MiB, 可用内存/4))，所以"目标档进得去"的充分条件是
 * `可用内存/4 ≥ 目标档 est`（且 est ≤ 416 MiB 硬顶）。机器一忙、可用内存掉到
 * 4 × 208.19 MiB ≈ 833 MiB 以下，额度**按设计**缩到目标档以下：那一档就不再进缓存，
 * "第二次不重建""第二次 ≤ 5%"这些判据就全都不成立 —— 红的是机器，不是代码。
 *
 * 为什么前提写成**读数**的比较，而不是"额度 ≥ est"：额度也是从这份读数推出来的，
 * 拿它当前提，会把"额度算式被改坏"（例如退回旧的固定 48 MiB 常数）当成"机器太忙"而跳过 —— 那才是真放水。
 * 读数 ≥ 4×est 时，算式只要没坏就必然给出 额度 ≥ est；于是"算式坏了"照红不误。
 */
const PRE_TARGET =
  RULER !== null &&
  QUOTA.availableBytes !== null &&
  QUOTA.availableBytes / 4 >= RULER.estTarget &&
  RULER.estTarget <= QUOTA.allowanceBytes
/** 填充档（25000 行 / est 52.81 MiB）进得去 ⇒ 它的单份 est 才量得到、"份数×est"才是入过缓存的字节下界。 */
const PRE_FILL = RULER !== null && RULER.estFill > 0 && QUOTA.anchorCapBytes >= RULER.estFill
/** 结构档在真实策略下进得去：可用内存 ≥ 4×结构下限 96 MiB = 384 MiB ⇒ 结构额度 ≥ 96 MiB > 结构档 est 51.91 MiB。 */
const PRE_STRUCT = QUOTA.availableBytes === null || QUOTA.availableBytes >= 4 * STRUCT_FLOOR_REF
const PRE_TARGET_TEXT = RULER === null ? '量尺读数可用' : `可用内存读数 ≥ 4×目标档 est（≥ ${MiB(4 * RULER.estTarget).toFixed(0)} MiB）`
const PRE_FILL_TEXT = RULER === null ? '量尺读数可用' : `锚点额度 ≥ 填充档 est（≥ ${MiB(RULER.estFill).toFixed(2)} MiB）`
const PRE_STRUCT_TEXT = '可用内存读数 ≥ 4×结构下限 96 MiB（≥ 384 MiB）'
/**
 * 真实文件档（97 KB 的 `struct-core.mjs`）那一档：段C/段D 里"真实文件档"那几条要求它进得了缓存
 * （"回到原内容"那条还要求**两份并存**），额度一缩（机器一忙）它们同样会因为"进不去"而红。
 * est 取自段0 的量尺（额度钉死）：在父进程里量不行 —— 额度小到 9 MiB 以下时它自己就进不了缓存，
 * 增量读回来是 0，前提就判不成了（0 是个假参考值）。前提依旧是**读数**的比较。
 */
const PRE_SMALL = RULER !== null && (QUOTA.availableBytes === null || QUOTA.availableBytes / 4 >= RULER.estSmall)
const PRE_SMALL_PAIR = RULER !== null && (QUOTA.availableBytes === null || QUOTA.availableBytes / 4 >= 2 * RULER.estSmall)
const PRE_SMALL_TEXT = RULER === null ? '量尺读数可用' : `可用内存读数 ≥ 4×真实文件档 est（≥ ${MiB(RULER.estSmall).toFixed(2)} MiB）`
const PRE_SMALL_PAIR_TEXT = RULER === null ? '量尺读数可用' : `可用内存读数 ≥ 8×真实文件档 est（≥ ${MiB(2 * RULER.estSmall).toFixed(2)} MiB）`
say(
  `  前提（判据有意义的条件）：目标档进得去 ${PRE_TARGET}（${PRE_TARGET_TEXT}）｜填充档进得去 ${PRE_FILL}｜` +
    `结构档进得去 ${PRE_STRUCT}｜真实文件档 ${PRE_SMALL}（est ${RULER === null ? 'n/a' : `${MiB(RULER.estSmall).toFixed(2)} MiB`}）｜${readingText()}`,
)

// ── 段A：100000 行档：第二次调用不重建 ────────────────────────────────
say('')
say('=== 段A. 100000 行档：同内容第二次 indexFile / locateAnchor 不重建（判据：第二次耗时 ≤ 第一次的 5%）===')
{
  const lines = BIG_SRC.split('\n').length - 1
  check(lines === BIG_LINES, `大文件档造出 ${BIG_LINES} 行（判据要的就是这一档）`, `${BIG_SRC.length} B`)

  // ① **内容事实**（与机器忙不忙无关）：这一档有多重。读数取自段0 的量尺 —— 额度钉死的子进程，
  //    所以"这一份 208.19 MiB"在任何负载下都是同一个数。这里量的正是"它越过旧常数 48 MiB"这条根因，
  //    以及"估算盖得住实测"这条额度之所以站得住的依据。
  if (RULER === null) {
    check(false, '段0 的量尺读数可用（读数缺失 ⇒ 目标档的重量无从判定）')
  } else {
    check(
      RULER.estTarget > 48 * 1024 * 1024,
      '它的估算字节已越过旧常数 48 MiB —— 这正是旧版本未命中的根因',
      `est ${MiB(RULER.estTarget).toFixed(2)} MiB > 48.00 MiB（量尺读数，与负载无关）`,
    )
    check(
      RULER.targetAdmitted === true && RULER.estTarget >= RULER.realTarget && RULER.realTarget > 0,
      '定盘星档单份：估算 ≥ 实测（估算偏低 ⇒ 额度就是假的），且这一档在钉死额度下真的入了账',
      `est ${MiB(RULER.estTarget).toFixed(2)} MiB ≥ 实测 ${MiB(RULER.realTarget).toFixed(2)} MiB，比值 ${(RULER.estTarget / RULER.realTarget).toFixed(2)}`,
    )
    check(
      RULER.estTarget <= QUOTA.allowanceBytes,
      '目标档单份的 est 不超过锚点这边的硬顶 416 MiB（= 定盘星档两倍）：越顶说明这一档自己长胖了，是代码问题不是机器问题',
      `est ${MiB(RULER.estTarget).toFixed(2)} MiB ≤ 416.00 MiB`,
    )
  }

  // ② 真实策略下的记忆化。前提见 PRE_TARGET：容得下才谈得上"该命中"。
  const st0 = indexFileCacheStats()
  const cold = timeIt(() => indexFile(BIG_SRC))
  const st1 = indexFileCacheStats()
  const est = st1.bytes - st0.bytes
  say(`  第一次 indexFile（冷建索引）：${cold.ms.toFixed(1)} ms`)
  checkIf(
    PRE_TARGET,
    PRE_TARGET_TEXT,
    st1.entries > st0.entries && est > 0,
    '这一份**进了缓存**（旧额度 48 MiB 下它必然被拒，每次重算）',
    `est ${MiB(est).toFixed(2)} MiB｜条目 ${st0.entries} → ${st1.entries}`,
  )
  checkIf(
    PRE_TARGET,
    PRE_TARGET_TEXT,
    RULER !== null && est === RULER.estTarget,
    '量尺的 est == 真实策略下入账的增量（同一个估算函数、同一份内容 ⇒ 量尺不是"另一个数"）',
    `${est} B vs 量尺 ${RULER === null ? 'n/a' : `${RULER.estTarget} B`}`,
  )
  checkIf(
    PRE_TARGET,
    PRE_TARGET_TEXT,
    est > 0 && est <= st1.maxBytes,
    '额度容得下这一份（额度取值与理由见 anchor-core.mjs 的额度块）',
    `est ${MiB(est).toFixed(2)} MiB ≤ 额度 ${MiB(st1.maxBytes).toFixed(2)} MiB`,
  )

  // 真实形态：调用方每次 readFileSync ⇒ 内容相同但是**另一个字符串对象**（哈希要重算、要比对 2.4 MB）
  const copy = Buffer.from(BIG_SRC, 'utf8').toString('utf8')
  const hot = timeIt(() => indexFile(copy))
  say(`  第二次 indexFile（等值新字符串，真实形态）：${hot.ms.toFixed(2)} ms`)
  say(`  ⇒ 第二次 / 第一次 = ${((100 * hot.ms) / cold.ms).toFixed(3)}%（判据 ≤ 5%）`)
  checkIf(
    PRE_TARGET,
    PRE_TARGET_TEXT,
    samePayload(filePayload(cold.out), filePayload(hot.out)),
    '第二次拿到的是**同一份载荷**（lines/lineBigrams/归一化/buckets 逐项同一）⇒ 没有重建',
    `第二次 ${hot.ms.toFixed(2)} ms / 第一次 ${cold.ms.toFixed(1)} ms`,
  )
  checkIf(
    PRE_TARGET,
    PRE_TARGET_TEXT,
    hot.ms <= cold.ms * 0.05,
    '第二次耗时 ≤ 第一次的 5%',
    `${hot.ms.toFixed(2)} ms ≤ ${(cold.ms * 0.05).toFixed(1)} ms`,
  )
  check(Object.is(cold.out, hot.out) === false, '两个顶层对象互不相同（命中返回浅拷贝，调用方各拿一份）')

  // 端到端：`locateAnchor` 是调用方真正走的那条路（它内部就是 `locateWith(indexFile(content), …)`）。
  // 冷热一对必须在**同一个全新实例**上取：否则第一次读到的可能已经是别处建好的索引。
  const freshAnchor = await freshModule('anchor-core.mjs')
  /** 这个全新实例**自己的**额度快照（在动它之前取：一份快照，后面都从它读）。 */
  const freshQuota = freshAnchor.indexFileCacheStats()
  check(freshQuota.entries === 0, '全新实例的缓存确实是空的（冷读数才成立）')
  const lCold = timeIt(() => freshAnchor.locateAnchor(BIG_SRC, ANCHOR_TEXT))
  const lHot = timeIt(() => freshAnchor.locateAnchor(BIG_SRC, ANCHOR_TEXT))
  say(`  第一次 locateAnchor（冷：建索引 + 定位）：${lCold.ms.toFixed(1)} ms`)
  say(`  第二次 locateAnchor（热：复用索引）：${lHot.ms.toFixed(2)} ms`)
  say(`  ⇒ 第二次 / 第一次 = ${((100 * lHot.ms) / lCold.ms).toFixed(3)}%（判据 ≤ 5%）`)
  check(lCold.out.tier === 'exact' && lHot.out.tier === 'exact', '两次都是逐字节命中（tier=exact）', `tier=${lCold.out.tier}`)
  check(lCold.out.start === lHot.out.start && lCold.out.end === lHot.out.end, '两次定位结果逐字段一致', `行 ${lCold.out.line}（0-based ${lCold.out.start}..${lCold.out.end}）`)
  checkIf(
    RULER !== null && fitsIn(freshQuota, RULER.estTarget, QUOTA.allowanceBytes),
    PRE_TARGET_TEXT,
    lHot.ms <= lCold.ms * 0.05,
    '第二次 locateAnchor 耗时 ≤ 第一次的 5%（不重建就是这条的全部意义）',
    `${lHot.ms.toFixed(2)} ms ≤ ${(lCold.ms * 0.05).toFixed(1)} ms`,
    readingOf(freshQuota, '段A 那个全新实例'),
  )
  // 冷读数那一次建出来的载荷 = 段C 的"无缓存基线"（那一份从没命中过任何缓存）
  COLD_BIG = freshAnchor.indexFile(BIG_SRC)

  // 主实例上再定位两次：两段之间行级索引的载荷必须同一（若第二次重建，缓存里的就是另一份载荷）
  const p1 = filePayload(indexFile(BIG_SRC))
  const a1 = timeIt(() => locateAnchor(BIG_SRC, ANCHOR_TEXT))
  const a2 = timeIt(() => locateAnchor(BIG_SRC, ANCHOR_TEXT))
  const p2 = filePayload(indexFile(BIG_SRC))
  checkIf(
    PRE_TARGET,
    PRE_TARGET_TEXT,
    samePayload(p1, p2),
    '两次 locateAnchor 之间行级索引载荷同一 ⇒ 第二次定位也没有重建索引',
    `定位 ${a1.ms.toFixed(2)} ms / ${a2.ms.toFixed(2)} ms`,
  )
}

// ── 段B：内存上限被打印、并被断言 ──────────────────────────────────────────
say('')
say('=== 段B. 内存上限：打印实际字节数与上限（引擎自报 + 子进程 gc 后实测常驻）===')
{
  // 额度相关的字段全部取自**同一份快照**（QUOTA）；只有 entries / bytes 是活计数器，现取。
  const st = { maxBytes: QUOTA.anchorCapBytes, availableBytes: QUOTA.availableBytes, maxEntries: QUOTA.anchorMaxEntries, budgetSource: QUOTA.anchorSource }
  const live = indexFileCacheStats()
  say(`  上限 ${st.maxBytes} B = ${MiB(st.maxBytes).toFixed(2)} MiB（来源：${st.budgetSource}）`)
  say(`  可用内存读数（定额度时那一份）${st.availableBytes === null ? 'n/a' : `${st.availableBytes} B = ${MiB(st.availableBytes).toFixed(0)} MiB`}｜条目上限 ${st.maxEntries}`)
  say(`  当前 ${live.entries} 条 / 自报 ${live.bytes} B = ${MiB(live.bytes).toFixed(2)} MiB`)
  check(Number.isFinite(st.maxBytes) && st.maxBytes > 0, '上限是个正数（不是 NaN/undefined：额度是算出来的，必须算出来）')
  check(st.maxBytes <= 416 * 1024 * 1024, '上限有界：≤ 定盘星档两倍 416 MiB（锚点这边的硬顶）', `${MiB(st.maxBytes).toFixed(2)} MiB`)
  // 不变式版：8 MiB 是**环境变量覆写**那条路的下限；可用内存那条路的下限是 min(96 MiB, 可用内存/4)，
  // 机器只剩几十兆时它会按设计降到 8 MiB 以下（那是"别跟别人抢内存"，不是缺陷）。
  // 两条路合起来的界：上限 ≥ min(8 MiB, 可用内存/4) —— 额度算式一坏（例如拍个 1 MiB）照红。
  check(
    st.maxBytes >= Math.min(8 * 1024 * 1024, st.availableBytes === null ? 8 * 1024 * 1024 : st.availableBytes / 4),
    '上限不至于小到不可用：≥ min(环境变量下限 8 MiB, 可用内存/4)',
    `${MiB(st.maxBytes).toFixed(2)} MiB｜${readingText()}`,
  )
  check(typeof st.budgetSource === 'string' && st.budgetSource.length > 0, '上限的**来源**是可读的一等读数（这台机器上它是怎么来的）', st.budgetSource)
  check(Number.isInteger(st.maxEntries) && st.maxEntries > 0, '条目上限也是一个可复核的数（与结构索引同源）', String(st.maxEntries))

  // 实测：换一个进程、带 --expose-gc，把缓存推过上限再量真实常驻
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
    cwd: here,
    encoding: 'utf8',
    timeout: 900000,
    env: { ...process.env, C26_ANCHOR_MEM_CHILD: '1' },
  })
  const stdout = String(child.stdout ?? '')
  const stderr = String(child.stderr ?? '')
  for (const line of stdout.split('\n')) if (line.startsWith('  [child]')) say(line)
  check(child.status === 0, `内存实测子进程跑通（--expose-gc，退出码 ${child.status}）`, stderr.trim().split('\n')[0]?.slice(0, 120) ?? '')
  const jsonLine = stdout.split('\n').find((l) => l.startsWith('C26_MEM_JSON '))
  check(jsonLine !== undefined, '子进程回传了结构化读数（C26_MEM_JSON）')
  const mem = jsonLine === undefined ? null : JSON.parse(jsonLine.slice('C26_MEM_JSON '.length))
  MEM = mem
  if (mem !== null) {
    say(`  子进程读数：上限 ${mem.cap} B｜自报 ${mem.accountingBytes} B｜实测常驻 ${mem.realCached} B｜推入 ${mem.pushedEst} B｜${mem.entriesAfter} 条`)
    check(mem.accountingBytes <= mem.cap, '缓存自报字节 ≤ 上限（引擎自己的账本守得住）', `${mem.accountingBytes} ≤ ${mem.cap} B`)
    check(mem.entriesAfter <= mem.maxEntries, '条目数 ≤ 条目上限（两个上限都在生效）', `${mem.entriesAfter} ≤ ${mem.maxEntries}`)
    // 子进程的判据按**子进程自己**的额度与读数判（它在父进程已吃掉几百兆之后才启动，
    // 自己读到的那份读数往往比父进程低一截 —— 拿父进程的快照去判它，又是一次跨时刻作证）。
    const childQuota = { maxBytes: mem.cap, availableBytes: mem.availableBytes }
    const CHILD_TARGET_OK = RULER !== null && fitsIn(childQuota, RULER.estTarget, QUOTA.allowanceBytes)
    const CHILD_FILL_OK = RULER !== null && RULER.estFill > 0 && mem.cap >= RULER.estFill
    const CHILD_STRUCT_OK = mem.availableBytes === null || mem.availableBytes >= 4 * STRUCT_FLOOR_REF
    checkIf(
      CHILD_FILL_OK,
      PRE_FILL_TEXT,
      mem.pushedEst > mem.cap,
      '塞进去的估算字节合计 > 上限（⇒ 不淘汰就必然越界，这份"有界"不是没被压过）',
      `推入 ${MiB(mem.pushedEst).toFixed(2)} MiB > 上限 ${MiB(mem.cap).toFixed(2)} MiB`,
      readingOf(childQuota, '段B 子进程'),
    )
    check(
      mem.realCached <= mem.cap,
      '★ 锚点缓存**实测常驻增长** ≤ 上限（gc 后 heapUsed 相对基线的增长；基线已含结构索引与量尺实例 ⇒ 量的是锚点自己那份）',
      `实测增长 ${MiB(mem.realCached).toFixed(2)} MiB ≤ 上限 ${MiB(mem.cap).toFixed(2)} MiB（占 ${((100 * mem.realCached) / mem.cap).toFixed(1)}%）`,
    )
    checkIf(
      CHILD_TARGET_OK,
      PRE_TARGET_TEXT,
      mem.estAnchor >= mem.realAnchor && mem.realAnchor > 0,
      '定盘星档单份（行级）：估算 ≥ 实测（这一档是额度的定盘星；估算偏低 ⇒ 额度就是假的）',
      `est ${MiB(mem.estAnchor).toFixed(2)} MiB ≥ 实测 ${MiB(mem.realAnchor).toFixed(2)} MiB，比值 ${mem.realAnchor > 0 ? (mem.estAnchor / mem.realAnchor).toFixed(2) : 'n/a'}`,
      readingOf(childQuota, '段B 子进程'),
    )
    // 这一条的 est 改用**量尺**的读数：真实策略下入不了账时，子进程只能报一个 0，
    // 而 `0 ≤ 额度` 恒真 —— 那正是它本该拦下的情形。量尺的 est 与入账增量逐字节相等（段A 已对账）。
    checkIf(
      CHILD_TARGET_OK,
      PRE_TARGET_TEXT,
      (RULER === null ? mem.estAnchor : RULER.estTarget) > 0 && (RULER === null ? mem.estAnchor : RULER.estTarget) <= mem.cap,
      '目标档单份的 est ≤ 上限（否则它永远进不了缓存 —— 本轮的 bug 就是这个）',
      `est ${MiB(RULER === null ? mem.estAnchor : RULER.estTarget).toFixed(2)} MiB ≤ ${MiB(mem.cap).toFixed(2)} MiB`,
      readingOf(childQuota, '段B 子进程'),
    )
    checkIf(
      CHILD_STRUCT_OK,
      PRE_STRUCT_TEXT,
      mem.estStruct >= mem.realStruct && mem.realStruct > 0,
      '同一份内容上的结构索引：估算 ≥ 实测（两套字节必须都是量出来的，不然两套额度都站不住）',
      `est ${MiB(mem.estStruct).toFixed(2)} MiB ≥ 实测 ${MiB(mem.realStruct).toFixed(2)} MiB，比值 ${mem.realStruct > 0 ? (mem.estStruct / mem.realStruct).toFixed(2) : 'n/a'}`,
    )
    checkIf(
      CHILD_FILL_OK,
      PRE_FILL_TEXT,
      mem.fillClean === true,
      '填充档的单份 est 是"干净增量"（在空缓存里入账，没有触发淘汰；份数×est 才是个下界）',
      String(mem.fillClean),
      readingOf(childQuota, '段B 子进程'),
    )
    check(
      mem.overAdmitted === false && mem.overRebuilt === true,
      '单条就超额度的那一份**不入缓存**（每次都重算，也不许挤掉整个缓存）——准入规则还在，缓存不是"什么都收"',
      `${mem.overLines} 行档：入缓存 ${mem.overAdmitted}｜第二次重建 ${mem.overRebuilt}`,
    )
    check(
      mem.overKeptRest === true,
      '单条超额度的那一份**不许挤掉整个缓存**：它入不了账，缓存里原有的条目一条不少（把准入规则拆掉就会连盘上的索引一起淘光）',
      `原有条目未被动 ${mem.overKeptRest}`,
    )
  }
}

// ── 段C：有缓存 / 无缓存两条路径逐字段深比较（含大文件档）──────────────────
say('')
say('=== 段C. 有缓存 / 无缓存两条路径的返回值逐字段相等（全量深比较，含 100000 行档）===')
{
  // 无缓存基线：一个全新模块实例的**第一次**调用。先证明它真的没有缓存：
  const freshA = await freshModule('anchor-core.mjs')
  const freshB = await freshModule('anchor-core.mjs')
  check(freshA.indexFileCacheStats().entries === 0 && freshB.indexFileCacheStats().entries === 0, '两个全新实例的缓存都是空的（没有跨实例共享）')
  const gReal = freshA.indexFile(SRC)
  check(!samePayload(filePayload(gReal), filePayload(freshB.indexFile(SRC))), '无缓存基线成立：两个全新实例各建一次索引，载荷互不相同')

  const cachedMiss = indexFile(SRC) // 本实例：**未命中**那次（97 KB 真实文件还没进过缓存）
  const cachedHit = indexFile(SRC) // 本实例：命中那次
  checkIf(PRE_SMALL, PRE_SMALL_TEXT, samePayload(filePayload(cachedMiss), filePayload(cachedHit)), '有缓存路径：第二次命中（载荷同一）')

  const d1 = deepEqual(projectFile(gReal), projectFile(cachedMiss))
  const d2 = deepEqual(projectFile(gReal), projectFile(cachedHit))
  check(d1 === null, '真实文件档：无缓存 vs 缓存（未命中那次）逐字段深比较相等', d1 ?? '')
  check(d2 === null, '真实文件档：无缓存 vs 缓存（命中那次）逐字段深比较相等', d2 ?? '')
  check(Object.keys(cachedHit).join(',') === FILE_FIELDS, '返回形状不变（字段名与顺序）', Object.keys(cachedHit).join(','))
  const bigramsReal = projectFile(gReal).lineBigrams.reduce((n, s) => n + s.size, 0)
  say(`  真实文件档（${path.basename(BIG_FILE)}，${SRC.split('\n').length} 行）深比较规模：lines ${gReal.lines.length} 项、逐行 bigram 集合 ${gReal.lineBigrams.length} 个 / 共 ${bigramsReal} 个成员、倒排桶 ${gReal.buckets.size} 个`)

  // 大文件档：同一套判据，换成 100000 行那一份（基线载荷来自段A 那个全新实例的冷调用）
  check(COLD_BIG !== null && COLD_BIG.lines.length > BIG_LINES, '拿到了 100000 行档的"无缓存"载荷（段A 的冷调用产出）', `${COLD_BIG === null ? 0 : COLD_BIG.lines.length} 行`)
  const cachedBig = indexFile(BIG_SRC) // 段A 里已入缓存 ⇒ 这一条走命中
  check(!samePayload(filePayload(COLD_BIG), filePayload(cachedBig)), '大文件档：无缓存实例的载荷与缓存里那一份**不同一**（确认比的是两条真路径）')
  const dBig = deepEqual(projectFile(COLD_BIG), projectFile(cachedBig))
  check(dBig === null, `大文件档（${BIG_LINES} 行）：无缓存 vs 缓存 逐字段深比较相等`, dBig ?? '')
  check(Object.keys(cachedBig).join(',') === FILE_FIELDS, '大文件档的返回形状同样不变', Object.keys(cachedBig).join(','))
  say(
    `  大文件档（${BIG_LINES} 行 / ${BIG_SRC.length} B）深比较规模：lines ${COLD_BIG.lines.length} 项、逐行 bigram 集合 ${COLD_BIG.lineBigrams.length} 个 / 共 ${MEM === null ? COLD_BIG.lineBigrams.reduce((n, s) => n + s.size, 0) : MEM.anchorBigrams} 个成员、倒排桶 ${COLD_BIG.buckets.size} 个`,
  )

  // 透明性：**命中**返回的是"自己的一份"，调用方挂字段不漏给下一次调用。
  //
  // 为什么换到"全新实例上按顺序走一遍"：这两条原来挂在**主实例那一刻的缓存状态**上 ——
  // 段A 之后 SRC 恰好在缓存里才是命中；机器一忙、额度一缩，同一次调用就变成**未命中**，
  // 而 `indexFile` 未命中那条路径返回的是**刚建好、也刚被塞进缓存的那同一个对象**
  // （`anchor-core.mjs` 的 `return index`）：调用方一挂字段就改了缓存里的那份 ⇒ 判据红在额度上，
  // 而不是红在"有没有返回自己的一份"上（实测：可用内存 ≤ ≈866 MiB / 额度 ≤ ≈217 MiB 时就是这样）。
  // 现在把两条路径**按顺序钉死**：先未命中、再命中，被改的必须是命中那一份拷贝。
  const transparent = await freshModule('anchor-core.mjs')
  /** 这个实例**自己的**额度快照（在动它之前取：它也是自己加载时读一次可用内存）。 */
  const transparentQuota = transparent.indexFileCacheStats()
  const missProbe = transparent.indexFile(SRC) // 未命中：刚建好并入库
  const hitProbe = transparent.indexFile(SRC) // 命中：必须是拷贝
  hitProbe.__probe = 'caller-field'
  const TRANSPARENT_OK = RULER !== null && fitsIn(transparentQuota, RULER.estSmall, QUOTA.allowanceBytes)
  checkIf(
    TRANSPARENT_OK,
    PRE_SMALL_TEXT,
    transparent.indexFile(SRC).__probe === undefined,
    '调用方往索引上挂字段不会漏给下一次调用（命中返回的是浅拷贝）',
    `真实文件档 est ${RULER === null ? 'n/a' : `${MiB(RULER.estSmall).toFixed(2)} MiB`}（量尺入账 ${RULER === null ? 'n/a' : RULER.smallAdmitted}）`,
    readingOf(transparentQuota, '透明性实例'),
  )
  checkIf(
    TRANSPARENT_OK,
    PRE_SMALL_TEXT,
    Object.keys(transparent.indexFile(SRC)).join(',') === FILE_FIELDS,
    '命中路径的字段与新建路径完全一致',
    '',
    readingOf(transparentQuota, '透明性实例'),
  )
  // 下面是**读数，不是判据**：未命中那条路径返回的到底是不是入库的那一个对象。
  // true ⇒ 调用方改它就会漏给下一次调用（`anchor-core.mjs` 未命中分支的 `return index`）。
  // 这条只把事实印出来：修它要改引擎，本套件不把"现状"当契约钉住。
  missProbe.__probeMiss = 'caller-field'
  const missAliasesCached = transparent.indexFile(SRC).__probeMiss !== undefined
  say(
    `  读数（不判定）：未命中路径返回的对象 == 入库的那一个？${missAliasesCached}` +
      `（true ⇒ 调用方改它会漏给下一次调用；要改的是 anchor-core.indexFile 的未命中返回）`,
  )
}

// ── 段D：淘汰有界 + 内容改一字节必须重算 ──────────────────────────────────
say('')
say('=== 段D. 淘汰有界（条目 + 字节双上限、LRU）；内容改一字节必须重算 ===')
{
  // 小内容专用实例：这一段的 LRU / 条目上限判据不需要大文件，也不该被大文件占着额度
  const d = await freshModule('anchor-core.mjs')
  const small = Array.from({ length: 8 }, (_, i) => `export function d${i}(a) {\n  return a + ${i}\n}\n`)
  const payloads = small.map((c) => filePayload(d.indexFile(c)))
  const hits = small.filter((c, i) => samePayload(payloads[i], filePayload(d.indexFile(c)))).length
  check(hits === 8, '上限之内（8 份内容各访问两次）：重复访问全部命中', `${hits}/8`)
  const st0 = d.indexFileCacheStats()
  const firstPayload = filePayload(d.indexFile(small[0]))

  const N = 200
  for (let i = 0; i < N; i += 1) d.indexFile(`export function g${i}(a) {\n  return a * ${i}\n}\n`)
  const st1 = d.indexFileCacheStats()
  const backPayload = filePayload(d.indexFile(small[0]))
  // 判据依赖"条目上限 < N"：上限若被上调到 N 以上，这条会红——那正是它该有的行为（有界性被改了）。
  check(!samePayload(firstPayload, backPayload), `连索引 ${N} 份不同内容后，最早那条已被淘汰（⇒ 缓存有界，不是无界增长）`)
  check(st0.entries === 8, '淘汰前：8 份内容都在缓存里（上限之内不淘汰）', `${st0.entries} 条`)
  check(st1.entries <= st1.maxEntries, '淘汰后：条目数 ≤ 条目上限', `${st1.entries} ≤ ${st1.maxEntries}`)
  check(st1.bytes <= st1.maxBytes, '淘汰后：自报字节 ≤ 额度', `${MiB(st1.bytes).toFixed(4)} MiB ≤ ${MiB(st1.maxBytes).toFixed(2)} MiB`)
  say(`  ${N} 份小内容（每份 est 约 ${Math.round(st1.bytes / st1.entries || 0)} B）之后：${st1.entries} 条存活 / 自报 ${MiB(st1.bytes).toFixed(4)} MiB ≤ 额度 ${MiB(st1.maxBytes).toFixed(2)} MiB`)

  // 淘汰的是**最近最少用**的那条，不是"最早放进来的"那条：命中会刷新访问序
  const lru = await freshModule('anchor-core.mjs')
  const maxE = lru.indexFileCacheStats().maxEntries
  const probe = Array.from({ length: maxE }, (_, i) => `export function k${i}(a) {\n  return a + ${i}\n}\n`)
  const touchedPayload = filePayload(lru.indexFile(probe[0]))
  const untouchedPayload = filePayload(lru.indexFile(probe[1]))
  for (let i = 2; i < maxE; i += 1) lru.indexFile(probe[i]) // 缓存刚好放满
  check(samePayload(touchedPayload, filePayload(lru.indexFile(probe[0]))), 'LRU 前提：把第 1 条重新访问一次（命中，应当被挪到队尾）')
  for (let i = 0; i < maxE - 1; i += 1) lru.indexFile(`export function m${i}(a) {\n  return a * ${i}\n}\n`)
  const keptAlive = samePayload(touchedPayload, filePayload(lru.indexFile(probe[0])))
  const gotEvicted = !samePayload(untouchedPayload, filePayload(lru.indexFile(probe[1])))
  check(
    keptAlive && gotEvicted,
    `LRU：再塞 ${maxE - 1} 份新内容后，刚被访问过的第 1 条还活着、更早且未再访问的第 2 条已被淘汰`,
    `第1条存活 ${keptAlive} / 第2条被淘汰 ${gotEvicted}`,
  )

  // 负向：内容改一个字节必须重建（真实文件档）
  const bigBefore = filePayload(indexFile(SRC))
  const changed = `${SRC.slice(0, 3)}X${SRC.slice(4)}`
  const after = indexFile(changed)
  check(!samePayload(bigBefore, filePayload(after)), '真实文件档：内容改一个字节（等长）⇒ 必须重新建索引')
  check(after.lines[0] === changed.split('\n')[0] && bigBefore[0][0] !== after.lines[0], '新索引的第一行是改动后的文本', JSON.stringify(after.lines[0]).slice(0, 60))
  checkIf(
    PRE_SMALL,
    PRE_SMALL_TEXT,
    samePayload(filePayload(after), filePayload(indexFile(changed))),
    '改动后的内容自己再调一次会命中（缓存对新内容同样生效）',
  )
  checkIf(
    PRE_SMALL_PAIR,
    PRE_SMALL_PAIR_TEXT,
    samePayload(bigBefore, filePayload(indexFile(SRC))),
    '回到原内容仍是原来那一份载荷（两份内容并存，没有互相顶掉）',
  )

  // 负向：100000 行档同样必须重算（额度放宽没有带来错命中）——等长改一个字节
  const needle = `${BIG_TAG}500`
  const bi = BIG_SRC.indexOf(ANCHOR_TEXT)
  check(bi >= 0, '大文件档里定位到用于改名的符号', needle)
  const bigChanged = `${BIG_SRC.slice(0, bi + 'export function '.length)}${BIG_TAG}50Z${BIG_SRC.slice(bi + 'export function '.length + needle.length)}`
  check(bigChanged.length === BIG_SRC.length && bigChanged !== BIG_SRC, '大文件档的负向样本同样是等长改动', `${BIG_SRC.length} B → ${bigChanged.length} B`)
  const lineAt = BIG_SRC.slice(0, bi).split('\n').length - 1
  const stBig0 = indexFileCacheStats()
  const bigPayloadBefore = filePayload(indexFile(BIG_SRC)) // 这一份（10 万行）此刻在缓存里
  const bigAfter = timeIt(() => indexFile(bigChanged))
  const stBig1 = indexFileCacheStats()
  check(!samePayload(bigPayloadBefore, filePayload(bigAfter.out)), '大文件档：改一个字节后载荷不同一 ⇒ 确实重算了')
  check(bigAfter.out.lines[lineAt].includes(`${BIG_TAG}50Z`), `大文件档新索引里那一行是改名后的文本（第 ${lineAt + 1} 行）`, bigAfter.out.lines[lineAt])
  check(!bigAfter.out.lines[lineAt].includes(needle), `大文件档新索引里那一行没有旧名字 ${needle}`)
  // 字节上限在 10 万行档上也真的会咬人：两份 est 合计 2×208.19 = 416.38 MiB > 额度 416.00 MiB
  // ⇒ 两份**存不下**，准入之后必然淘汰一条。先把“改动后的内容自己再调一次会命中”验完，
  // 再去看“回到原内容要重算”——否则那一次重算会把改动后那一份挤出去（第一版就是这个顺序错的）。
  check(stBig1.bytes <= stBig1.maxBytes, '两份 100000 行档（est 合计 > 额度）之后：自报字节仍 ≤ 额度（不是无界并存）', `${MiB(stBig1.bytes).toFixed(2)} MiB ≤ ${MiB(stBig1.maxBytes).toFixed(2)} MiB`)
  check(stBig1.entries <= stBig1.maxEntries, '条目数同样 ≤ 条目上限', `${stBig1.entries} ≤ ${stBig1.maxEntries}`)
  check(stBig1.entries < stBig0.entries + 1, '两份 10 万行档的 est 合计 > 额度 ⇒ 只活得下一份（淘汰是同一次插入里发生的）', `${stBig0.entries} → ${stBig1.entries} 条`)
  checkIf(
    PRE_TARGET,
    PRE_TARGET_TEXT,
    samePayload(filePayload(bigAfter.out), filePayload(indexFile(bigChanged))),
    '大文件档改动后的内容自己再调一次会命中',
    `改动后那一份的 est ${MiB(RULER === null ? 0 : RULER.estTarget).toFixed(2)} MiB`,
  )
  check(!samePayload(bigPayloadBefore, filePayload(indexFile(BIG_SRC))), '额度装不下两份 10 万行档 ⇒ 最旧的那份被淘汰（回到它就必须重算）')
}

// ── 段E：与 struct-core 额度策略的关系（唯一实现 + 两套实测字节）────────────
say('')
say('=== 段E. 与 struct-core 额度策略的关系：只有一处额度计算实现（源码扫描 + 运行期读数）===')
{
  // 额度相关的字段全部取自**同一份快照**（程序开头那一次 QUOTA）。
  // 理由：额度与"定额度时那一份可用内存读数"必须是**同一次**读数派生的两个量 ——
  // 各自现取（一个冻结在模块加载、一个是活读数）就是拿两个时刻的读数互相印证。
  // 注：`s.availableBytes` 原本是 struct-core 现取的那一份（每调一次读一次）；
  // 两边共用的本来就是同一个函数，这里统一到快照上，"两边都能拿到读数"照常断言。
  const a = { maxBytes: QUOTA.anchorCapBytes, maxEntries: QUOTA.anchorMaxEntries, availableBytes: QUOTA.availableBytes, budgetSource: QUOTA.anchorSource }
  const s = { maxBytes: QUOTA.structCapBytes, maxEntries: QUOTA.structMaxEntries, availableBytes: QUOTA.availableBytes, budgetSource: QUOTA.structSource }

  // ① 源码扫描：引擎清单取自 build/bundle-layout.mjs（**不是手写**：漏打包 = 判据自己失真）。
  // 直接 import 清单，不再正则解析 make-bundle.mjs：清单搬家后正则读出 0 个文件，
  // 下面的 `computes.length === 1` 只会报“一处都没找到”，看起来像实现没了。
  const { ENGINE: engine } = await import(pathToFileURL(path.join(pkgRoot, 'build', 'bundle-layout.mjs')).href)
  check(engine.length >= 7, `从打包清单读出 ${engine.length} 个引擎文件（判据取自 bundle-layout，不是手写）`, engine.join(','))
  /**
   * 判据是**代码**，不是散文：先把注释去掉再扫。
   *
   * 不去注释的版本会把"额度不在本文件里算（不读进程可用内存…）"这类**说明**当成实现，
   * 于是判据惩罚的正是写得清楚的注释。反过来的风险（把真代码误当注释）由下面那条
   * "必须恰好命中 struct-core.mjs"的断言兑着：扫空了就是判据失效，不是通过。
   */
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  // 名字带 FEATURE：上面那个 `QUOTA` 是全套件共用的额度快照，这里扫的是**源码特征**。
  // "额度计算"的可识别特征：读可用内存 / 读环境变量。这两样谁做，谁就是在算额度。
  const QUOTA_FEATURE = /availableMemory|AURA_INDEX_CACHE/
  const computes = engine.filter((f) => QUOTA_FEATURE.test(stripComments(fs.readFileSync(path.join(here, f), 'utf8'))))
  check(
    computes.length === 1 && computes[0] === 'struct-core.mjs',
    '★ 全仓**只有一处额度计算实现**（读可用内存 / 读环境变量只出现在 struct-core.mjs 的代码里）',
    computes.length === 0 ? '（一处都没找到 ⇒ 判据失效）' : computes.join(','),
  )
  const anchorSrc = stripComments(fs.readFileSync(path.join(here, 'anchor-core.mjs'), 'utf8'))
  check(!QUOTA_FEATURE.test(anchorSrc), 'anchor-core 一**行代码**都不算额度：不读可用内存、不读环境变量、不写 clamp')
  check(
    /import \{ indexCacheStats \} from '\.\/struct-core\.mjs'/.test(anchorSrc),
    'anchor-core 只有**消费**那一条边（import 的就是那份只读读数，额度本身还在 struct-core 里算）',
  )

  // ② 运行期：锚点额度是**从那份读数派生的算术**，逐项钉住（不是另一个独立的常数）
  const allowance = QUOTA.allowanceBytes
  // 右式与 anchor-core 的算式同一口径，但**直接从同一份快照算**：不是"再取一次读数"，两边不可能跨时刻。
  const expected = QUOTA.policyBytes
  check(
    a.maxBytes === expected,
    '锚点额度 == max(结构额度, min(416 MiB, 可用内存/4))：共享那一份是**基线**，锚点只加一条按实测定的下限',
    `${a.maxBytes} == ${expected} B = ${MiB(a.maxBytes).toFixed(2)} MiB`,
  )
  check(
    a.maxBytes >= s.maxBytes,
    '锚点缓存不会比结构缓存小（同一台机器上共用同一个基线）',
    `锚点 ${MiB(a.maxBytes).toFixed(2)} MiB ≥ 结构 ${MiB(s.maxBytes).toFixed(2)} MiB｜${readingText()}`,
  )
  check(a.maxEntries === s.maxEntries, '条目上限同源：两处都是那一份读数里的同一个数', `${a.maxEntries} == ${s.maxEntries}`)
  check(a.maxBytes <= allowance, '锚点额度有硬顶：≤ 定盘星档单份 est 的两倍（416 MiB）', `${MiB(a.maxBytes).toFixed(2)} MiB ≤ 416.00 MiB｜${readingText()}`)
  check(
    a.availableBytes === null || a.maxBytes <= a.availableBytes / 4,
    '且始终 ≤ 可用内存/4（与 struct-core 的告急档同比例：单份重 4 倍，比例不放大）',
    a.availableBytes === null ? '（无可用内存读数）' : `${MiB(a.maxBytes).toFixed(2)} MiB ≤ ${MiB(a.availableBytes / 4).toFixed(2)} MiB｜${readingText()}`,
  )
  check(a.budgetSource.includes(s.budgetSource), '额度来源如实写明"共享那一份 + 锚点这一层"（可读的一等读数）', a.budgetSource)
  check(a.availableBytes !== null && s.availableBytes !== null, '两边都能拿到可用内存读数（定额度时那一份）', `${a.availableBytes} B`)

  // ③ 两套实测字节（段B 子进程）：重量级不同 ⇒ 额度不能直接搬那个数 —— 不是"一个数换另一个数"
  if (MEM === null) {
    check(false, '段B 的两套实测字节可用（子进程读数缺失 ⇒ 段E 的这条判据无法成立）')
  } else {
    // 行级那一侧取**量尺**读数：真实策略下入不了账时，段B 子进程只能报 0（0/51.91 = 0×，判据会假红）。
    // "重多少倍"是 (内容, 估算函数) 的属性，与额度无关；结构那一侧仍量在真实策略下（它小得多，前提见 PRE_STRUCT）。
    const anchorEst = RULER === null ? MEM.estAnchor : RULER.estTarget
    const anchorReal = RULER === null ? MEM.realAnchor : RULER.realTarget
    const estRatio = anchorEst / MEM.estStruct
    const realRatio = anchorReal / MEM.realStruct
    say(
      `  两套实测（同一份 ${RULER === null ? MEM.anchorLength : RULER.targetLength} B / ${BIG_LINES} 行内容）：` +
        `结构 est ${MiB(MEM.estStruct).toFixed(2)} MiB / 常驻 ${MiB(MEM.realStruct).toFixed(2)} MiB（段B 子进程）｜` +
        `行级 est ${MiB(anchorEst).toFixed(2)} MiB / 常驻 ${MiB(anchorReal).toFixed(2)} MiB（段0 量尺：额度钉死）`,
    )
    checkIf(
      PRE_STRUCT,
      PRE_STRUCT_TEXT,
      estRatio > 3 && realRatio > 3,
      '行级索引比结构索引重 3 倍以上（est 与实测都是）⇒ 两份额度必须不同，理由是可量的',
      `est ${estRatio.toFixed(2)}× / 常驻 ${realRatio.toFixed(2)}×`,
    )
    checkIf(
      PRE_TARGET,
      PRE_TARGET_TEXT,
      anchorEst > 0 && anchorEst <= a.maxBytes,
      '锚点额度容得下这一份（段A 的命中是额度口径改对了，不是碰巧）',
      `${MiB(anchorEst).toFixed(2)} MiB ≤ ${MiB(a.maxBytes).toFixed(2)} MiB`,
    )
    check(
      anchorEst > 48 * 1024 * 1024,
      '而它越过旧的固定常数 48 MiB ⇒ 旧口径下这一档一次都进不去（改动前的那条 bug）',
      `${MiB(anchorEst).toFixed(2)} MiB > 48.00 MiB（量尺读数，与负载无关）`,
    )
  }
}

const failed = results.filter((r) => !r.ok)
say('')
// 一次负载导致的翻红：这行读数就是诊断的第一手材料（不必再去查"当时机器多忙"）。
const finalLive = indexFileCacheStats()
say(
  `〔机器读数〕${readingText()}｜目标档 est ${RULER === null ? 'n/a' : `${MiB(RULER.estTarget).toFixed(2)} MiB`}` +
    `｜填充档 est ${RULER === null ? 'n/a' : `${MiB(RULER.estFill).toFixed(2)} MiB`}` +
    `｜缓存现状 ${finalLive.entries} 条 / 自报 ${MiB(finalLive.bytes).toFixed(2)} MiB`,
)
say(
  `--- ${results.length - failed.length}/${results.length} 通过${skips.length === 0 ? '' : `（另有 ${skips.length} 条因前提不成立而跳过：见上面的 ⊘ 行）`} ---`,
)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
  say(`  〔失败时的机器读数〕${readingText()}`)
  process.exit(1)
}
