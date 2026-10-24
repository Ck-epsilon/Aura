/**
 * index-cache-test —— 结构索引与行级索引的**记忆化**（蓝图 fs-contract-v2 / 施工单元 C4；
 * C14 把额度从「拍出来的 32 MiB」改成「按可用内存算出来的有界预算」，大文件档因此也命中）。
 *
 * ## 命题（施工单终态）
 *
 * 同一份内容重复调用 `indexStructure()`（struct-core）与 `indexFile()`（anchor-core）**不再重复解析**；
 * 键是**内容派生**的（不许用路径或 mtime：同路径内容变了必须重算）；缓存**有界**；
 * 且对调用方**完全透明**（签名、返回形状、语义都不变）。
 * **95000 行以上的大文件档也必须命中**——这是 C14 补的那一条。
 *
 * ## 为什么值得做（施工前实测）
 *
 * `locator-api.mjs` 每次 `locate()` 都现算 `indexStructure`，`locateAnchor()` 每次都现建 `indexFile`，
 * 而同一份内容在一轮里会被问好几次（read 的 map→digest→target、edit 的 plan→verify）。
 * 本仓最大的引擎文件（本目录的 `struct-core.mjs`）实测：`indexStructure` **15.8 ms/次**，
 * `indexFile` **28.1 ms/次** —— 这就是 aura_basetools_read 端到端时延随文件体量上升的那部分。
 *
 * ## C14：大文件档为什么曾经不命中，这一条怎么验
 *
 * 旧额度是一个拍出来的常数（32 MiB），而单份索引的估算字节随行数线性涨：**90000 行档
 * est 36.8 MiB 起，每一份都超限 ⇒ 不入缓存 ⇒ 每次调用都重建**（本机复现读数，同一份内容：
 * `readWith(mode=lines)` 90000 行冷 5.5 s / 热 5.8 s，95000 行冷 7.1 s / 热 8.2 s —— 热 ≈ 冷，
 * 记忆化在这一档等于不存在）。现在额度 =
 * `clamp(可用内存/16, min(96 MiB, 可用内存/4), 256 MiB)`（三个输入的来源与为什么本机安全，
 * 都写在 `struct-core.mjs` 的额度块里），本机实测 170～222 MiB（本次交付跑出 **182.55 MiB**，
 * 可用内存 2.74 GiB），而一份 100000 行档（est 51.91 MiB / 实测常驻 40.91 MiB）稳进。判据就是**段A**。
 *
 * 想确认这条判据**真的会红**（而不是恰好在别的路上命中）：把额度按旧常数压回 32 MiB 再跑一次——
 * `AURA_INDEX_CACHE_MB=32 node index-cache-test.mjs`（环境变量是同一个额度的可配入口），
 * 段A/段E 会当场红。交付读数里有这一格的原始输出。
 *
 * 另一格反证（量的是**段A 那条重标定后的判据**）：把 `indexStructure` 的命中分支短路
 * （让它每次都真重建），热读数会跳到 300 ms 级，四条上界判据同时红。见下方
 * 「段A 那条比例判据为什么要重标定」一节。
 *
 * ## 怎么"看见"底层解析发生了几次（可观测的手段，不新增导出）
 *
 * 引擎的对外面不该为测试开口子，因此解析次数用**载荷身份**来数：
 *   · `buildStructure` / `buildFileIndex` 每执行一次，必然新建 tokens / symbols / pairs / lineAt
 *     （行级那边是 lines / lineBigrams / spaceNormalized / trimNormalized / buckets）；
 *   · 因此两次调用返回的**载荷对象同一**（`Object.is(a.tokens, b.tokens)`）⟺ 第二次没有重新构建；
 *   · 顶层对象则**必须不同一**（命中返回浅拷贝）——"每次调用都拿到自己的一份"是改动前就有的性质。
 * 段A/段C/段D 都用载荷身份 + 耗时双重钉住（若真解析了 100 次，两条都不可能成立）。
 *
 * ## 无缓存路径怎么造
 *
 * ESM 的模块表按完整 URL 索引，因此 `import('./struct-core.mjs?fresh=N')` 拿到的是一个缓存
 * 必然为空的新实例——段C 拿它的**第一次**调用当“无缓存路径”，对返回值做全量深比较；
 * 段C 会先证明这个基线真的无缓存（两个全新实例各解析一次的载荷互不相同，且它的第一次
 * 调用比同一份内容 100 次命中调用还慢）。
 *
 * ## 内存怎么实测（段B）
 *
 * 额度是个估算字节数，所以"上限是多少"必须能在外部复核——那是 `indexCacheStats()`（引擎的只读读数）。
 * 而"估算盖不盖得住真实内存"必须**用进程读数说话**：`process.memoryUsage().heapUsed` 要 GC 后才干净，
 * 因此段B 用 `spawnSync(process.execPath, ['--expose-gc', 本文件])` 把自己当子进程再跑一遍
 * （`C14_INDEX_CACHE_MEM_CHILD=1`），在子进程里把缓存推过上限、`gc()` 后量真实常驻，
 * 再把读数用一行 `C14_MEM_JSON {...}` 交回父进程断言。留在**同一进程**里量会被上一段的垃圾污染。
 *
 * ## 判据（段）
 *
 *   A  100000 行档：第二次调用不重建，且**第二次耗时 ≤ max(第一次的 5%, 25 ms)**（贴两个原始数）；
 *      顺带钉住"这一份的 est 已越过旧的 32 MiB 常数"（旧版本必然拒绝它）。
 *      `readWith(mode=lines)` 的热读数被**三条互相独立、且都不随冷索引变快而缩小的闸门**钉住：
 *      `≤ max(冷建索引 × 25%, 100 ms)`、`≤ 100 ms`（绝对上界）、`≤ 地板 × 4 + 40 ms`
 *      （地板标定上界，另有一条"地板标定上界不松于 100 ms"）
 *      ——**取宽形式的来由、取值理由与失效地平线见下方专节**
 *      读数拆解（本机实测）：热读数 = 命中 + 先生成行数组 + 其余，命中是小数、地板是毫秒级
 *   B  内存上限被**打印**并被**断言**：给出实际字节数（引擎自报 + 进程 gc 后实测）与上限，
 *      并验证"估算 ≥ 实测"（估算不许低于真实占用，否则额度就是假的）
 *   C  有缓存 / 无缓存两条路径的返回值**逐字段深比较**（符号、token、配平表、逐偏移 lineAt
 *      ——全量，不是抽样），**含 100000 行大文件档**
 *   D  淘汰行为：连续索引 N 份不同内容后，最早的已被淘汰，且条目数/字节都被钉在上限内（有界证据）
 *   E  负向不变量：内容改一个字节必须重算（**大文件档同样**）、同内容不同语言不得互相返回、
 *      顶层对象互不影响；末尾另有一条**端到端对照**：同一 `readWith` 入口跑一份没进过缓存的
 *      等长内容（真付一次冷建索引），段A 的热读数必须 ≤ 它的 25% —— 这条对照的分子分母是同一条
 *      入口、分母永远要真付一次冷建索引，**它是段A 判据判定力的锚**（不随冷索引变快而失效）
 *   F  行级索引 `indexFile`（anchor-core）：记忆化同样成立、同样透明（旧 A2/B2 的覆盖不丢）
 *
 * ## 段A 的比例判据为什么要"取宽"（波24/C60 重标定，波28 去耦合）
 *
 * 旧判据是 `warm ≤ first × 5%`（`first` = 冷建索引）。它本来是拿"冷索引 ~67579 ms"
 * 标定出来的；上一波把结构索引的归属归因从 O(n²) 改成 O(n log n)，`first` 掉到 ~340 ms
 * —— 阈值跟着掉到 ~17 ms，而 `readWith` 的热读数里有一笔**与索引无关**的固定开销：
 * `read-core.mjs` 每次都要 `source.split(/\r?\n/)` 把 100000 行变成行数组。
 * 本机实测：热读数 19～26 ms，其中 `indexStructure` 命中只有 **0.02 ms 量级**、
 * 行数组 ~7 ms，其余 ~12 ms 是 `readWith` 自己那条路的固有代价。
 * ⇒ 那次红不是语义回归，而是**按已消失的旧冷代价标定的比例常数**：冷索引越快，
 * `first × 5%` 越小，这条越必然不可满足。
 *
 * C60 把它重标定成 `25%` + `100 ms` + `地板 × 4 + 40 ms`，但**相对比例项本身没被拆掉**：
 * `first × 25%` 仍随 `first` 一起缩小。本机实测 `first ≈ 349 ms`、`warm ≈ 19.5 ms`、
 * 阈值 `first × 25% ≈ 87 ms` —— 只要冷建索引再快 ~3.4 倍（`first ≈ 103 ms`），阈值就掉到
 * 26 ms、贴上热读数（19.5 ms），再快一点就**无关于缺陷地变红**。同一条判据、同一个机制，
 * 只是地平线从"已经发生"挪到了"还差 3.4 倍"。波28 就地把它拆掉：
 *
 *   · 比例项与绝对项**取宽**：`warm ≤ max(first × 25%, 100 ms)`，第二条 `indexStructure`
 *     同理 `second ≤ max(first × 5%, 25 ms)`。取宽不是放水：比例项只在它**比绝对项更宽**
 *     （冷索引还慢）时才成为实际生效的那一侧；冷索引一旦变快，绝对项接管，阈值不再跟着
 *     `first` 往下掉。这就是"去掉随冷索引变快而必然失效的耦合"。
 *     诚实标注：`first ≈ 349 ms` 的今天，比例项 87 ms 已经比绝对项 100 ms 更严，
 *     所以今天实际生效的是绝对项 —— 这正说明耦合已经到了该拆的时候。
 *   · **绝对上界仍然单独断言**（`warm ≤ 100 ms`、命中 `≤ 25 ms`），取宽没有把上界抬上去：
 *     热路径真去付一次冷索引（今天 ~350 ms；假想的"再快 3.4 倍"也还有 ~102 ms）离 25/100 ms
 *     还有 4 倍以上距离；命中本身（0.02 ms）与地板（~7 ms）则远在 25/100 ms 之下。
 *   · `warm ≤ 地板 × 4 + 40 ms`（地板 = 当场实测的 `BIG_SRC.split(/\r?\n/)`）—— 与机器无关的
 *     表述：被量的这次热读数的开销不许离"不可避免的那笔"太远（本机 7.3×4+40 = 69 ms，
 *     是今天最紧的一条活闸门）。`地板 × 4 + 40 ≤ 100` 防的正是"把上界抬上去换绿"：
 *     地板涨了也不许把标定上界抬到绝对上界之上。
 *
 * **判定力不来自比例项，而来自两条不随 `first` 缩小的对照**：
 *   1. 绝对上界 25 / 100 ms 对"每次都重建"的区分度：一次真建索引今天 ~349 ms、
 *      假想的 3.4 倍未来 ~102 ms，都在上界之上（4 倍以上）；
 *   2. 段E 的端到端对照 `warm ≤ 未命中读数 × 25%`（`endToEndMiss`）：分子分母是**同一条**
 *      `readWith` 入口，分母永远要真付一次冷建索引，两侧共享那笔与索引无关的地板。
 *      实测未命中 415 ms vs 热读数 19.5 ms（21 倍）；即便冷索引再快 3.4 倍，未命中仍有
 *      ~122 ms（地板 7.3 + 冷建索引 102.3 + 其余 12.5）、约为热读数的 6 倍 ⇒ 这条锚不会
 *      因为冷索引变快而失效。
 *
 * 反证怎么做：把 `indexStructure` 的缓存命中分支短路（强制每次重建），`warm` 跳到 300 ms 级，
 * 上面各条**同时**变红并点名（"热读数里的那一份确实是命中"那条也会红）。波28 的交付读数是在
 * `%TEMP%` 的**隔离副本**上做的 mutation（共享树里的 `struct-core.mjs` 由并行单元持有写权，
 * 全程 sha256 未变），红/绿两组原始输出与 sha256 三元组见回执。
 * 这条判据只增不减：**7 条**（原 1 条 → 现 4 条 + 端到端 4 条）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { indexStructure, indexCacheStats, langOf } from './struct-core.mjs'
import { readWith } from './read-core.mjs'
import { indexFile, locateAnchor } from './anchor-core.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const BIG_FILE = path.join(here, 'struct-core.mjs')
/** 真实文件档：本仓最大的引擎文件（97 KB 量级）。 */
const SRC = fs.readFileSync(BIG_FILE, 'utf8')
const SRC_LANG = langOf(BIG_FILE)
const BIG_NAME = path.basename(BIG_FILE)

const MiB = (bytes) => bytes / 2 ** 20
const heapUsed = () => process.memoryUsage().heapUsed
const gcNow = () => {
  if (typeof global.gc === 'function') {
    global.gc()
    global.gc()
  }
}

let freshSeq = 0
/**
 * 载入一个**全新**的引擎模块实例（缓存必然为空）——"无缓存路径"的真身。
 * 查询串让 ESM 的模块表把它与主实例当成两个模块。
 */
const freshModule = (file) => import(`${pathToFileURL(path.join(here, file)).href}?fresh=${(freshSeq += 1)}`)

/** 载荷 = 真正由"解析"产出的那些对象。它们被复用 ⟺ 没有重新解析。 */
const structPayload = (idx) => [idx.tokens, idx.symbols, idx.pairs, idx.lineAt]
const filePayload = (idx) => [idx.lines, idx.lineBigrams, idx.spaceNormalized, idx.trimNormalized, idx.buckets]
const samePayload = (a, b) => a.length === b.length && a.every((x, k) => Object.is(x, b[k]))

const ms = (hrtime) => Number(hrtime) / 1e6
const timeIt = (fn) => {
  const t0 = process.hrtime.bigint()
  const out = fn()
  return { ms: ms(process.hrtime.bigint() - t0), out }
}

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

/**
 * 结构的可比较投影。`lineAt` 是函数，不能按值比——**逐偏移穷举**它的输出，
 * 这就等价于把函数也比完了（0..length 每一个偏移都问过）。
 */
const projectStruct = (idx) => ({
  symbols: idx.symbols,
  tokens: idx.tokens,
  pairs: idx.pairs,
  src: idx.src,
  lineAt: Array.from({ length: idx.src.length + 1 }, (_, o) => idx.lineAt(o)),
})
const projectFile = (idx) => ({
  lines: idx.lines,
  lineBigrams: idx.lineBigrams,
  spaceNormalized: idx.spaceNormalized,
  trimNormalized: idx.trimNormalized,
  buckets: idx.buckets,
  flat: idx.flat,
})
const STRUCT_FIELDS = 'symbols,tokens,pairs,lineAt,src'
const FILE_FIELDS = 'lines,lineBigrams,spaceNormalized,trimNormalized,buckets,flat'

// ── 大文件档语料：行数**正好** N 的块状 JS ────────────────────────────────
/**
 * 造一份 `lineTarget` 行的 JS 源码（7 行一块，块内名字带唯一序号 ⇒ 符号、token、配对都真实）。
 *
 * 为什么自己造而不是用仓库里最大的文件：判据要的是 **100000 行这一档**，而本仓最大的引擎文件
 * 只有 2678 行。语料必须由**行数**参数化，否则"95000 行以上"这条根本没法验。
 *
 * 同一组 `(tag, lineTarget)` 必须产出**逐字节相同**的内容——段A/段C/段E 靠这一点共享同一份缓存键。
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
const BIG_TAG = 'c14a'
const BIG_SRC = corpusOf(BIG_TAG, BIG_LINES)
const BIG_LANG = langOf('c14-big.mjs')
const FILL_LINES = 25000

// ══════════════════════════════════════════════════════════════════════════════
//  子进程模式：段B 的"实测内存"在这里量（--expose-gc），再把读数交回父进程
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 在**自己的进程**里把缓存推过上限，然后量真实常驻。
 *
 * 为什么必须换进程：`heapUsed` 只有 GC 之后才是干净的，而 `global.gc` 只在 `--expose-gc` 下存在；
 * 就算有 `gc`，父进程里前面几段已经堆了垃圾与别的模块实例的缓存，读数会被污染。
 * 子进程从零开始，只做这一件事。
 */
function runMemoryChild() {
  const notes = []
  const note = (m) => {
    notes.push(`  [child] ${m}`)
    return m
  }
  const lang = langOf('x.mjs')
  const cap = indexCacheStats()
  note(
    `额度 ${cap.maxBytes} B = ${MiB(cap.maxBytes).toFixed(2)} MiB（来源 ${cap.budgetSource}）｜可用内存 ${
      cap.availableBytes === null ? 'n/a' : `${MiB(cap.availableBytes).toFixed(0)} MiB`
    }｜条目上限 ${cap.maxEntries}｜gc 可用 ${typeof global.gc === 'function'}`,
  )
  gcNow()
  const baseline = heapUsed()

  // ① 先量"一份填充档"的估算字节：空缓存里只放这一条，`stats.bytes` 就是它自己的 est。
  indexStructure(corpusOf('c14f0', FILL_LINES), lang)
  const estFill = indexCacheStats().bytes
  note(`一份填充档（${FILL_LINES} 行）est ${estFill} B = ${MiB(estFill).toFixed(2)} MiB`)

  // ② 目标档单份：est（入缓存的增量）与**实测常驻**（gc 后 heapUsed 差，那一份留活口）。
  //    内容就在这个函数里现造：它只被"缓存键 / idx.src"引用——入缓存则算进 est，不入缓存则随函数
  //    一起变成垃圾被回收。若把内容留到外层作用域，它就会在后面的读数里冒充"缓存占用"。
  //    用的就是段A 那一份内容（同一个 tag ⇒ 逐字节相同），两处的 est 因此可以直接对照。
  const measureTarget = () => {
    gcNow()
    const h0 = heapUsed()
    const content = corpusOf(BIG_TAG, BIG_LINES)
    const s0 = indexCacheStats()
    const idx = indexStructure(content, lang)
    const s1 = indexCacheStats()
    gcNow()
    const h1 = heapUsed()
    return { est: s1.bytes - s0.bytes, real: h1 - h0, tokens: idx.tokens.length, entries: s1.entries, length: content.length }
  }
  const t = measureTarget()
  note(
    `目标档单份（${BIG_LINES} 行 / ${t.length} B）：est ${t.est} B = ${MiB(t.est).toFixed(2)} MiB｜实测常驻 ${t.real} B = ${MiB(t.real).toFixed(2)} MiB｜est/real ${t.real > 0 ? (t.est / t.real).toFixed(2) : 'n/a'}｜tokens ${t.tokens}`,
  )

  // ③ 把缓存推过上限：填到"入过缓存的估算字节合计 > 上限"为止
  //   每一份填充档入缓存时都通过了准入，因此 "份数 × 单份 est" 是**入过缓存的估算字节**的下界；
  //   它一旦 > 上限，这份"有界"就是被真正压过的（不淘汰就必然越界）。
  //   份数由**实测的 est** 现算，不写死；estFill 取不到（连一份都放不进去）时不去硬推。
  const fillsWanted = estFill > 0 ? Math.ceil(cap.maxBytes / estFill) + 3 : 0
  const fills = Math.min(fillsWanted, 200)
  for (let k = 1; k < fills; k += 1) indexStructure(corpusOf(`c14f${k}`, FILL_LINES), lang)
  gcNow()
  gcNow()
  const after = indexCacheStats()
  const realCached = heapUsed() - baseline
  const pushedEst = fills * estFill
  note(`推入 ${fills} 份互不相同的内容（每份入缓存时都通过准入 ⇒ 合计估算 ≥ ${pushedEst} B = ${MiB(pushedEst).toFixed(2)} MiB > 上限）`)
  note(`最终：${after.entries} 条 / 自报 ${after.bytes} B = ${MiB(after.bytes).toFixed(2)} MiB ≤ 上限 ${after.maxBytes} B = ${MiB(after.maxBytes).toFixed(2)} MiB`)
  note(`gc 后实测常驻 ${realCached} B = ${MiB(realCached).toFixed(2)} MiB（基线 heapUsed ${baseline} B）｜rss ${MiB(process.memoryUsage().rss).toFixed(0)} MiB`)

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
      estTarget: t.est,
      realTarget: t.real,
      targetTokens: t.tokens,
      realCached,
      baseline,
      rss: process.memoryUsage().rss,
    },
  }
}

if (process.env.C14_INDEX_CACHE_MEM_CHILD === '1') {
  const { notes, payload } = runMemoryChild()
  for (const n of notes) say(n)
  say(`C14_MEM_JSON ${JSON.stringify(payload)}`)
  process.exit(0)
}

// ── 段A：100000 行档：第二次调用不重建 ────────────────────────────────
say('=== 段A. 100000 行档：同内容第二次调用不重建（判据：第二次耗时 ≤ max(第一次的 5%, 25 ms)）===')
/**
 * 段A 的两个读数**跨段**要用（段E 的端到端对照把同一个 readWith 入口的冷读数当分母），
 * 因此提到段外。提出来而不是在段E 重算：重算会把“这次到底命中没有”搅进对照里。
 */
let coldIndexMs = NaN
let warmReadMs = NaN
{
  /**
   * 三条上界的取值（来由与失效地平线见文件头"段A 的比例判据为什么要取宽"专节）：
   *   · `HIT_ABS_MS` —— 命中本身（indexStructure 命中 + 2.4 MB 哈希比对）的绝对上界。
   *   · `WARM_ABS_MS` —— 整次 `readWith(mode=lines)` 热读数的绝对上界。两者都远严于
   *     "每次都重建"：真建索引今天 ~349 ms，假想的再快 3.4 倍也还有 ~102 ms。
   *   · `FLOOR_SLACK_MS` —— 地板标定式的余量（地板 = 当场实测的"先生成行数组"）。
   * 比例项与绝对项用 **max 取宽**：比例项只在它比绝对项更宽（冷索引还慢）时才成为实际生效的
   * 那一侧；冷索引变快后绝对项接管，于是"阈值随冷索引缩小到地板以下、无关于缺陷地变红"
   * 这条耦合被去掉。绝对上界仍**各自单独断言**，取宽没有把任何上界抬上去。
   */
  const HIT_ABS_MS = 25
  const WARM_ABS_MS = 100
  const FLOOR_SLACK_MS = 40

  const lines = BIG_SRC.split('\n').length - 1
  check(lines === BIG_LINES, `大文件档造出 ${BIG_LINES} 行（判据要的就是这一档）`, `${BIG_SRC.length} B`)

  const s0 = indexCacheStats()
  const first = timeIt(() => indexStructure(BIG_SRC, BIG_LANG))
  coldIndexMs = first.ms
  const s1 = indexCacheStats()
  const est = s1.bytes - s0.bytes
  check(s1.entries > s0.entries && est > 0, '这一份**进了缓存**（旧额度 32 MiB 下它必然被拒，每次重算）', `est ${MiB(est).toFixed(2)} MiB`)
  check(est > 32 * 1024 * 1024, '它的估算字节已越过旧常数 32 MiB —— 这正是旧版本未命中的根因', `est ${MiB(est).toFixed(2)} MiB > 32.00 MiB`)
  check(est <= s1.maxBytes, '额度容得下这一份（额度取值与理由见 struct-core.mjs 的额度块）', `est ${MiB(est).toFixed(2)} MiB ≤ 额度 ${MiB(s1.maxBytes).toFixed(2)} MiB`)
  say(`  第一次 indexStructure（冷建索引）：${first.ms.toFixed(1)} ms`)

  // 真实形态：调用方每次 readFileSync ⇒ 内容相同但是**另一个字符串对象**（哈希要重算、要比对 2.4 MB）
  const copy = Buffer.from(BIG_SRC, 'utf8').toString('utf8')
  const second = timeIt(() => indexStructure(copy, BIG_LANG))
  say(`  第二次 indexStructure（等值新字符串，真实形态）：${second.ms.toFixed(2)} ms`)
  say(`  ⇒ 第二次 / 第一次 = ${((100 * second.ms) / first.ms).toFixed(3)}%（比例项：5% ⇒ ${(first.ms * 0.05).toFixed(1)} ms；生效中的判据是 max(比例项, 25 ms)）`)
  check(
    samePayload(structPayload(first.out), structPayload(second.out)),
    '第二次拿到的是**同一份载荷**（tokens/symbols/pairs/lineAt 逐项同一）⇒ 没有重建',
  )
  /**
   * 相对比例项**取宽**成 `max(第一次 × 5%, HIT_ABS_MS)`：比例项在冷索引快于 500 ms 时
   * 就小于 25 ms（今天 first ~349 ms ⇒ 比例项 17.5 ms，已经比绝对项更严）。一次**真**建索引
   * 今天 ~349 ms、假想的再快 3.4 倍也有 ~102 ms，都在 25 ms 之上 4 倍以上 ⇒ 短路缓存命中
   * 分支仍然必红；而冷索引越快、比例项越小，绝对项接管，判据不因引擎变快而假红。
   */
  const secondBound = Math.max(first.ms * 0.05, HIT_ABS_MS)
  check(
    second.ms <= secondBound,
    '第二次耗时 ≤ max(第一次的 5%, 绝对上界 25 ms)（取宽：比例项只在它更宽时生效）',
    `${second.ms.toFixed(2)} ms ≤ ${secondBound.toFixed(1)} ms（比例项 ${(first.ms * 0.05).toFixed(1)} ms｜绝对项 ${HIT_ABS_MS.toFixed(1)} ms）`,
  )

  // 端到端：用户真正走的那条路（readWith 的 lines 模式内部就是 indexStructure）
  const mid = Math.max(2, Math.floor(BIG_LINES / 2))
  const warm = timeIt(() => readWith(BIG_SRC, { mode: 'lines', filePath: 'E:\\c14\\big.mjs', lines: [mid, mid + 39] }))
  warmReadMs = warm.ms
  check(warm.out.ok === true, 'readWith(mode=lines) 在这份 100000 行档上正常返回', `${warm.out.mode ?? '?'} ok=${warm.out.ok}`)
  // 温读数不动；地板放在它**之后**量，免得判据自己造的垃圾挤进被量的那一次
  const floor = timeIt(() => BIG_SRC.split(/\r?\n/))
  const hit = timeIt(() => indexStructure(BIG_SRC, BIG_LANG))
  say(`  热读数拆开：readWith ${warm.ms.toFixed(1)} ms = 命中 ${hit.ms.toFixed(2)} ms + 先生成行数组 ${floor.ms.toFixed(1)} ms + 其余 ${(warm.ms - hit.ms - floor.ms).toFixed(1)} ms`)
  /**
   * 相对比例项**取宽**成 `max(冷建索引 × 25%, WARM_ABS_MS)`：
   * 冷索引 ~349 ms 时比例项 ~87 ms 比绝对项 100 ms 更严（所以今天生效的是绝对项 ——
   * 耦合已经到了该拆的时候）；冷索引一旦快过 400 ms，比例项会一路掉到地板以下，
   * 那时绝对项接管，判据不再"随冷索引变快而必然失效"。
   * 绝对项仍有判定力：短路命中分支后热读数 ~350 ms（今天）/ ~102 ms（再快 3.4 倍）都在它之上。
   */
  const warmBound = Math.max(first.ms * 0.25, WARM_ABS_MS)
  // 地板标定是“本机行数组生成有多快”的读数；慢 runner 上 4×地板+40ms 可能超过绝对上界。
  // 绝对上界仍是硬约束，所以把地板项**封顶**在绝对上界，而不是让慢机器把门槛抬过 100ms。
  const floorBound = Math.min(floor.ms * 4 + FLOOR_SLACK_MS, WARM_ABS_MS)
  say(`  上界：max(冷建索引 × 25% = ${(first.ms * 0.25).toFixed(1)} ms, 绝对上界 ${WARM_ABS_MS.toFixed(1)} ms) = ${warmBound.toFixed(1)} ms（地板标定封顶 ${floorBound.toFixed(1)} ms，原始 ${(floor.ms * 4 + FLOOR_SLACK_MS).toFixed(1)} ms）`)
  check(
    hit.ms <= HIT_ABS_MS,
    '热读数里的那一份确实是**命中**（indexStructure 命中读数是个小数，不是又建了一次索引）',
    `${hit.ms.toFixed(2)} ms ≤ ${HIT_ABS_MS.toFixed(1)} ms`,
  )
  check(
    warm.ms <= warmBound,
    'readWith(mode=lines) 的热读数 ≤ max(冷建索引 × 25%, 绝对上界 100 ms)（取宽：比例项只在它更宽时生效）',
    `${warm.ms.toFixed(1)} ms ≤ ${warmBound.toFixed(1)} ms`,
  )
  check(
    warm.ms <= WARM_ABS_MS,
    'readWith(mode=lines) 的热读数 ≤ 绝对上界 100 ms（这条不随冷索引变快而失效：冷索引再快，上界也还在）',
    `${warm.ms.toFixed(1)} ms ≤ ${WARM_ABS_MS.toFixed(1)} ms`,
  )
  check(
    floorBound <= WARM_ABS_MS,
    '地板标定的上界不松于绝对上界（封顶后不会把门槛抬到 100 ms 以上）',
    `${floorBound.toFixed(1)} ms ≤ ${WARM_ABS_MS.toFixed(1)} ms`,
  )
  check(
    warm.ms <= floorBound,
    `热读数 ≤ min(地板 × 4 + ${FLOOR_SLACK_MS} ms, 绝对上界)（地板 = 先生成行数组；慢机器不抬高门槛）`,
    `${warm.ms.toFixed(1)} ms ≤ ${floorBound.toFixed(1)} ms（地板 ${floor.ms.toFixed(2)} ms）`,
  )

}

// ── 段B：内存上限被打印、并被断言 ──────────────────────────────────────────
say('')
say('=== 段B. 内存上限：打印实际字节数与上限（引擎自报 + 进程 gc 后实测）===')
{
  const st = indexCacheStats()
  say(`  上限 ${st.maxBytes} B = ${MiB(st.maxBytes).toFixed(2)} MiB（来源：${st.budgetSource}）`)
  say(`  可用内存读数 ${st.availableBytes} B = ${MiB(st.availableBytes ?? 0).toFixed(0)} MiB｜条目上限 ${st.maxEntries}`)
  say(`  当前 ${st.entries} 条 / ${st.bytes} B = ${MiB(st.bytes).toFixed(2)} MiB`)
  check(Number.isFinite(st.maxBytes) && st.maxBytes > 0, '上限是个正数（不是 NaN/undefined：额度是算出来的，必须算出来）')
  check(st.maxBytes <= 256 * 1024 * 1024, '上限有界：≤ 绝对上限 256 MiB（环境变量可配也不许越过）', `${MiB(st.maxBytes).toFixed(2)} MiB`)
  check(st.maxBytes >= 8 * 1024 * 1024, '上限不至于小到不可用：≥ 环境变量下限 8 MiB', `${MiB(st.maxBytes).toFixed(2)} MiB`)
  check(typeof st.budgetSource === 'string' && st.budgetSource.length > 0, '上限的**来源**是可读的一等读数（这台机器上它是怎么来的）', st.budgetSource)

  // 实测：换一个进程、带 --expose-gc，把缓存推过上限再量真实常驻
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
    cwd: here,
    encoding: 'utf8',
    timeout: 900000,
    env: { ...process.env, C14_INDEX_CACHE_MEM_CHILD: '1' },
  })
  const stdout = String(child.stdout ?? '')
  const stderr = String(child.stderr ?? '')
  for (const line of stdout.split('\n')) if (line.startsWith('  [child]')) say(line)
  check(child.status === 0, `内存实测子进程跑通（--expose-gc，退出码 ${child.status}）`, stderr.trim().split('\n')[0]?.slice(0, 100) ?? '')
  const jsonLine = stdout.split('\n').find((l) => l.startsWith('C14_MEM_JSON '))
  check(jsonLine !== undefined, '子进程回传了结构化读数（C14_MEM_JSON）')
  const mem = jsonLine === undefined ? null : JSON.parse(jsonLine.slice('C14_MEM_JSON '.length))
  if (mem !== null) {
    say(`  子进程读数：上限 ${mem.cap} B｜自报 ${mem.accountingBytes} B｜实测常驻 ${mem.realCached} B｜推入 ${mem.pushedEst} B｜${mem.entriesAfter} 条`)
    check(mem.accountingBytes <= mem.cap, '缓存自报字节 ≤ 上限（引擎自己的账本守得住）', `${mem.accountingBytes} ≤ ${mem.cap} B`)
    check(mem.entriesAfter <= mem.maxEntries, '条目数 ≤ 条目上限（两个上限都在生效）', `${mem.entriesAfter} ≤ ${mem.maxEntries}`)
    check(
      mem.pushedEst > mem.cap,
      '塞进去的估算字节合计 > 上限（⇒ 不淘汰就必然越界，这份"有界"不是没被压过）',
      `推入 ${MiB(mem.pushedEst).toFixed(2)} MiB > 上限 ${MiB(mem.cap).toFixed(2)} MiB`,
    )
    check(
      mem.realCached <= mem.cap,
      '★ 进程**实测常驻** ≤ 上限（gc 后 heapUsed，这才是"没把机器打爆"的证据）',
      `实测 ${MiB(mem.realCached).toFixed(2)} MiB ≤ 上限 ${MiB(mem.cap).toFixed(2)} MiB（占 ${((100 * mem.realCached) / mem.cap).toFixed(1)}%）`,
    )
    check(
      mem.accountingBytes >= mem.realCached,
      '估算**盖得住**实测（额度是按估算记账的；估算偏低 ⇒ 额度就是假的）',
      `估算 ${MiB(mem.accountingBytes).toFixed(2)} MiB ≥ 实测 ${MiB(mem.realCached).toFixed(2)} MiB`,
    )
    check(
      mem.estTarget >= mem.realTarget && mem.realTarget > 0,
      '目标档单份：估算 ≥ 实测（这一档是额度的定盘星）',
      `est ${MiB(mem.estTarget).toFixed(2)} MiB ≥ 实测 ${MiB(mem.realTarget).toFixed(2)} MiB，比值 ${(mem.estTarget / mem.realTarget).toFixed(2)}`,
    )
    check(mem.estTarget <= mem.cap, '目标档单份的估算 ≤ 上限（否则它永远进不了缓存 —— 本轮的 bug 就是这个）', `${MiB(mem.estTarget).toFixed(2)} MiB ≤ ${MiB(mem.cap).toFixed(2)} MiB`)
  }
}

// ── 段C：有缓存 / 无缓存两条路径逐字段深比较（含大文件档）──────────────────
say('')
say('=== 段C. 有缓存 / 无缓存两条路径的返回值逐字段相等（全量深比较，含大文件档）===')
{
  // 无缓存基线：全新模块实例
  // 基线的第一次调用必然是真解析。先证明它真的“无缓存”（而不是命中了别处的缓存）：
  //   · 两个各自全新的实例各解析一次 ⇒ 载荷互不相同（没有跨实例共享）；
  //   · 全新实例的第一次调用比 100 次命中调用还慢 ⇒ 那一次确实做了整份工作。
  const fresh = await freshModule('struct-core.mjs')
  const freshLang = fresh.langOf(BIG_FILE)
  const f1 = fresh.indexStructure(SRC, freshLang)
  const freshB = await freshModule('struct-core.mjs')
  check(
    !samePayload(structPayload(f1), structPayload(freshB.indexStructure(SRC, freshB.langOf(BIG_FILE)))),
    '无缓存基线成立：两个全新实例各解析一次，载荷互不相同（没有跨实例共享）',
  )
  const freshC = await freshModule('struct-core.mjs')
  const freshCold1 = timeIt(() => freshC.indexStructure(SRC, freshC.langOf(BIG_FILE))).ms

  const cachedMiss = indexStructure(SRC, SRC_LANG) // 本实例：**未命中**那次（真实文件档还没进过缓存）
  const cachedHit = indexStructure(SRC, SRC_LANG) // 本实例：命中那次
  check(samePayload(structPayload(cachedMiss), structPayload(cachedHit)), '有缓存路径：第二次命中（载荷同一）')
  // 预热过后再量 100 次：否则循环的第一次会把"冷建"混进来，读数就不再是"100 次命中"
  const mainWarm100 = timeIt(() => {
    for (let i = 0; i < 100; i += 1) indexStructure(SRC, SRC_LANG)
  }).ms
  check(
    freshCold1 > mainWarm100 * 10,
    '无缓存基线成立：全新实例的第一次调用 ≫ 100 次命中调用（差一个数量级以上 ⇒ 那一次确实做了整份解析）',
    `cold×1 ${freshCold1.toFixed(1)}ms vs warm×100 ${mainWarm100.toFixed(3)}ms`,
  )

  const base = projectStruct(f1)
  const d1 = deepEqual(base, projectStruct(cachedMiss))
  const d2 = deepEqual(base, projectStruct(cachedHit))
  check(d1 === null, '无缓存 vs 缓存（未命中那次）：逐字段深比较相等', d1 ?? '')
  check(d2 === null, '无缓存 vs 缓存（命中那次）：逐字段深比较相等', d2 ?? '')
  check(Object.keys(cachedHit).join(',') === STRUCT_FIELDS, '返回形状不变（字段名与顺序）', Object.keys(cachedHit).join(','))
  say(
    `  真实文件档（${BIG_NAME}，${SRC.split('\n').length} 行）深比较规模：symbols ${base.symbols.length} 项、tokens ${base.tokens.length} 项、pairs ${base.pairs.size} 项、lineAt 逐偏移 ${base.lineAt.length} 点`,
  )

  // 大文件档：同一套判据，换成 100000 行那一份
  const bigLines = BIG_SRC.split('\n').length - 1
  const freshBig = await freshModule('struct-core.mjs')
  const g1 = freshBig.indexStructure(BIG_SRC, freshBig.langOf('c14-big.mjs'))
  const cachedBig = indexStructure(BIG_SRC, BIG_LANG) // 段A 里已入缓存 ⇒ 这一条走命中
  check(
    !samePayload(structPayload(g1), structPayload(cachedBig)),
    '大文件档：无缓存实例的载荷与缓存里那一份**不同一**（确认比的是两条真路径）',
  )
  const dBig = deepEqual(projectStruct(g1), projectStruct(cachedBig))
  check(dBig === null, '大文件档（100000 行）：无缓存 vs 缓存 逐字段深比较相等', dBig ?? '')
  const bigBase = projectStruct(g1)
  say(
    `  大文件档（${bigLines} 行 / ${BIG_SRC.length} B）深比较规模：symbols ${bigBase.symbols.length} 项、tokens ${bigBase.tokens.length} 项、pairs ${bigBase.pairs.size} 项、lineAt 逐偏移 ${bigBase.lineAt.length} 点`,
  )
}

// ── 段D：淘汰行为（有界证据）──────────────────────────────────────────────
say('')
say('=== 段D. 淘汰行为：连续索引 N 份不同内容后，最早的已被淘汰（有界证据）===')
{
  const bmod = await freshModule('struct-core.mjs')
  const blang = bmod.langOf('x.mjs')
  const small = Array.from({ length: 8 }, (_, i) => `export function f${i}(a) {\n  return a + ${i}\n}\n`)
  const payloads = small.map((c) => structPayload(bmod.indexStructure(c, blang)))
  const hits = small.filter((c, i) => samePayload(payloads[i], structPayload(bmod.indexStructure(c, blang)))).length
  check(hits === 8, '上限之内（8 份内容各访问两次）：重复访问全部命中', `${hits}/8`)
  const st0 = bmod.indexCacheStats()
  const firstPayload = structPayload(bmod.indexStructure(small[0], blang))

  const N = 200
  for (let i = 0; i < N; i += 1) bmod.indexStructure(`export function g${i}(a) {\n  return a * ${i}\n}\n`, blang)
  const st1 = bmod.indexCacheStats()
  const backPayload = structPayload(bmod.indexStructure(small[0], blang))
  // 判据依赖"条目上限 < N"：上限若被上调到 N 以上，这条会红——那正是它该有的行为（有界性被改了）。
  check(!samePayload(firstPayload, backPayload), `连索引 ${N} 份不同内容后，最早那条已被淘汰（⇒ 缓存有界，不是无界增长）`)
  check(st0.entries === 8, '淘汰前：8 份内容都在缓存里（上限之内不淘汰）', `${st0.entries} 条`)
  check(st1.entries <= st1.maxEntries, '淘汰后：条目数 ≤ 条目上限', `${st1.entries} ≤ ${st1.maxEntries}`)
  check(st1.bytes <= st1.maxBytes, '淘汰后：自报字节 ≤ 额度', `${MiB(st1.bytes).toFixed(4)} MiB ≤ ${MiB(st1.maxBytes).toFixed(2)} MiB`)
  say(
    `  ${N} 份小内容（每份 est 约 ${Math.round((st1.bytes / st1.entries) || 0)} B）之后：${st1.entries} 条存活 / 自报 ${MiB(st1.bytes).toFixed(4)} MiB ≤ 额度 ${MiB(st1.maxBytes).toFixed(2)} MiB`,
  )

  // 淘汰的是**最近最少用**的那条，不是"最早放进来的"那条：命中会刷新访问序
  // （indexStructure 命中时 delete+set 把它挪到队尾）。这条不验，"LRU"就只是注释里的一个词。
  const lru = await freshModule('struct-core.mjs')
  const llang = lru.langOf('x.mjs')
  const maxE = lru.indexCacheStats().maxEntries
  const probe = Array.from({ length: maxE }, (_, i) => `export function k${i}(a) {\n  return a + ${i}\n}\n`)
  const touchedPayload = structPayload(lru.indexStructure(probe[0], llang))
  const untouchedPayload = structPayload(lru.indexStructure(probe[1], llang))
  for (let i = 2; i < maxE; i += 1) lru.indexStructure(probe[i], llang) // 缓存刚好放满
  check(samePayload(touchedPayload, structPayload(lru.indexStructure(probe[0], llang))), 'LRU 前提：把第 1 条重新访问一次（命中，应当被挪到队尾）')
  for (let i = 0; i < maxE - 1; i += 1) lru.indexStructure(`export function m${i}(a) {\n  return a * ${i}\n}\n`, llang)
  const keptAlive = samePayload(touchedPayload, structPayload(lru.indexStructure(probe[0], llang)))
  const gotEvicted = !samePayload(untouchedPayload, structPayload(lru.indexStructure(probe[1], llang)))
  check(
    keptAlive && gotEvicted,
    `LRU：再塞 ${maxE - 1} 份新内容后，刚被访问过的第 1 条还活着、更早且未再访问的第 2 条已被淘汰`,
    `第1条存活 ${keptAlive} / 第2条被淘汰 ${gotEvicted}`,
  )
}

// ── 段E：负向不变量 ────────────────────────────────────────────────────────
say('')
say('=== 段E. 负向不变量：改一个字节必须重算（大文件档同样）===')
{
  // 真实文件档：等长改一个字节
  const before = indexStructure(SRC, SRC_LANG)
  const at = SRC.indexOf('export function listSymbols(') + 'export function '.length
  const changed = `${SRC.slice(0, at)}listSymbolZ${SRC.slice(at + 'listSymbols'.length)}`
  check(changed !== SRC && changed.length === SRC.length, '负向样本是等长改动（一个字节换成另一个字节，长度不变）', `${SRC.length} B → ${changed.length} B`)
  const after = indexStructure(changed, SRC_LANG)
  check(!samePayload(structPayload(before), structPayload(after)), '等长改动后载荷不同一 ⇒ 真的重新解析了')
  check(after.symbols.some((s) => s.name === 'listSymbolZ'), '新索引里有改名后的符号 listSymbolZ')
  check(!after.symbols.some((s) => s.name === 'listSymbols'), '新索引里没有旧名字 listSymbols')
  const again = indexStructure(changed, SRC_LANG)
  check(samePayload(structPayload(after), structPayload(again)), '改动后的内容自己再调一次会命中（缓存对新内容同样生效）')
  const back = indexStructure(SRC, SRC_LANG)
  check(samePayload(structPayload(before), structPayload(back)), '回到原内容仍是原来那一份载荷（两份内容并存，没有互相顶掉）')

  // 交错调用：每次都返回与"当前内容"一致的符号表
  const v1 = SRC
  const v2 = SRC.replace('export function listSymbols(', 'export function listSymbolZ(')
  const marks = []
  let ok = true
  for (const content of [v1, v2, v1, v2, v2, v1]) {
    const names = indexStructure(content, SRC_LANG).symbols.map((s) => s.name)
    const wantsZ = content.includes('listSymbolZ')
    const good = names.includes(wantsZ ? 'listSymbolZ' : 'listSymbols') && !names.includes(wantsZ ? 'listSymbols' : 'listSymbolZ')
    if (!good) ok = false
    marks.push(`${wantsZ ? 'Z' : 's'}${good ? '' : '✗'}`)
  }
  check(ok, '等长改字节后交错调用 6 次，每次都返回与"当前内容"一致的符号表', marks.join(' '))

  // **大文件档**：同一个改动，在 100000 行那一份上同样必须重算
  const bigBefore = indexStructure(BIG_SRC, BIG_LANG)
  const needle = `${BIG_TAG}500`
  const bi = BIG_SRC.indexOf(`export function ${needle}(value) {`)
  check(bi >= 0, '大文件档里定位到用于改名的符号', needle)
  const bigChanged = `${BIG_SRC.slice(0, bi)}${'export function '}${`${BIG_TAG}50Z`}${BIG_SRC.slice(bi + 'export function '.length + needle.length)}`
  check(bigChanged.length === BIG_SRC.length && bigChanged !== BIG_SRC, '大文件档的负向样本同样是等长改动', `${BIG_SRC.length} B → ${bigChanged.length} B`)
  const st0 = indexCacheStats()
  /**
   * 端到端对照：同一入口 readWith 跑这一份**没进过缓存**的内容 —— 它必然真付一次冷建索引。
   * 与段A 那条比例判据**不同**：`first` 是 indexStructure 的口径，cold-only 优化会让它越小、
   * 阈值跟着变小（那条红就是这么来的）；这一条的分子分母都是 readWith，两侧共享那笔与索引
   * 无关的地板，所以它不会因为冷索引变快而失准。放在段E 而不是段A："没进过缓存的大内容"
   * 正是段E 本来就要造的（段A 里再造一份 51.91 MiB 会挤掉旧条目，见额度）。
   */
  const endToEndMiss = timeIt(() => readWith(bigChanged, { mode: 'lines', filePath: 'E:\\c14\\big.mjs', lines: [Math.max(2, Math.floor(BIG_LINES / 2)), Math.max(2, Math.floor(BIG_LINES / 2)) + 39] }))
  const st1 = indexCacheStats()
  // 同一份内容紧接着走 indexStructure：上一次 readWith 已经付过冷代价，所以这一次是命中（下面两条据此）
  const bigAfter = timeIt(() => indexStructure(bigChanged, BIG_LANG))
  // 缓存是**有界**的：100000 行新内容入缓存时可能连淘汰多条旧条目（实测 macOS runner 3→1）。
  // 条目数由额度决定，不是正确性判据；真正要守的是“另建了一份索引、没有错命中”，
  // 下面三条载荷判据负责。这里只把读数打出来，不让额度细节变成跨平台契约。
  say(`  改一字节后缓存条目 ${st0.entries} → ${st1.entries} 条（有界缓存可淘汰；载荷判据见下）`)
  check(!samePayload(structPayload(bigBefore), structPayload(bigAfter.out)), '100000 行档：改一个字节后载荷不同一 ⇒ 必须重算（额度放宽没有带来错命中）')
  check(bigAfter.out.symbols.some((s) => s.name === `${BIG_TAG}50Z`), `大文件档新索引里有改名后的符号 ${BIG_TAG}50Z`)
  check(!bigAfter.out.symbols.some((s) => s.name === needle), `大文件档新索引里没有旧名字 ${needle}`)
  // 端到端对照（分母是同一条 readWith 入口的冷读数，不是 `first`）：
  say(`  端到端对照：同一入口 readWith 跑没进过缓存的等长内容 ${endToEndMiss.ms.toFixed(1)} ms；段A 的热读数 ${warmReadMs.toFixed(1)} ms`)
  say(`  ⇒ 未命中／热读数 = ${(endToEndMiss.ms / warmReadMs).toFixed(1)} 倍（这条对照是段A 判据判定力的锚：它的分母永远要真付一次冷建索引，不随冷索引变快而失效）`)
  check(endToEndMiss.out.ok === true, '对照那次（未缓存内容，同一 readWith 入口）正常返回', `${endToEndMiss.out.mode ?? '?'} ok=${endToEndMiss.out.ok}`)
  check(
    endToEndMiss.ms >= coldIndexMs * 0.5,
    '对照成立：未缓存内容走 readWith 确实付了整份冷建索引（≥ 段A 那次冷建索引的一半）',
    `${endToEndMiss.ms.toFixed(1)} ms ≥ ${(coldIndexMs * 0.5).toFixed(1)} ms`,
  )
  check(
    warmReadMs <= endToEndMiss.ms * 0.25,
    '段A 的热读数 ≤ 同一入口「真付一次冷建索引」那个读数的 25%（端到端口径：真重建就红）',
    `${warmReadMs.toFixed(1)} ms ≤ ${(endToEndMiss.ms * 0.25).toFixed(1)} ms`,
  )
  check(
    samePayload(structPayload(bigAfter.out), structPayload(indexStructure(bigChanged, BIG_LANG))),
    '大文件档改动后的内容自己再调一次会命中',
  )

  // 语言维度必须参与命中判据：同内容不同语言对象不得互相返回
  const jsSrc = 'export function alpha(a) {\n  return a + 1\n}\nfunction beta() {\n  return 2\n}\n'
  const jsIndex = indexStructure(jsSrc, langOf('x.js'))
  const pyIndex = indexStructure(jsSrc, langOf('x.py'))
  check(!samePayload(structPayload(jsIndex), structPayload(pyIndex)), '同内容不同语言：两份索引不得互相返回（载荷不同一）')
  const freshPy = await freshModule('struct-core.mjs')
  const expectPy = freshPy.indexStructure(jsSrc, freshPy.langOf('x.py'))
  const dPy = deepEqual(projectStruct(pyIndex), projectStruct(expectPy))
  check(dPy === null, '语言维度的返回与无缓存路径逐字段相等', dPy ?? '')
  const jsAgain = indexStructure(jsSrc, langOf('x.js'))
  const dJs = deepEqual(projectStruct(jsAgain), projectStruct(jsIndex))
  check(dJs === null, '同内容同语言再调仍是正确那一份（语言维度的替换没有破坏结果）', dJs ?? '')

  // 透明性：命中返回的是"自己的一份"，调用方挂字段不漏给下一次调用
  const tmod = await freshModule('struct-core.mjs')
  const tlang = tmod.langOf(BIG_FILE)
  const missIdx = tmod.indexStructure(SRC, tlang)
  missIdx.__probe = 'caller-field'
  const hitIdx = tmod.indexStructure(SRC, tlang)
  check(hitIdx.__probe === undefined, '调用方往索引上挂字段不会漏给下一次调用（两条路径都返回浅拷贝）')
  check(Object.keys(hitIdx).join(',') === STRUCT_FIELDS, '命中路径的字段与新建路径完全一致', Object.keys(hitIdx).join(','))
}

// ── 段F：行级索引 indexFile（anchor-core）──────────────────────────────────
say('')
say('=== 段F. 行级索引 indexFile（anchor-core）：记忆化同样成立、同样透明 ===')
{
  const first = indexFile(SRC)
  const posts = new Set()
  const tops = new Set()
  let sameAsFirst = 0
  for (let i = 0; i < 100; i += 1) {
    const idx = indexFile(SRC)
    posts.add(idx.lines)
    tops.add(idx)
    if (samePayload(filePayload(first), filePayload(idx))) sameAsFirst += 1
  }
  check(posts.size === 1, '100 次调用拿到的是同一个 lines 数组（⇒ buildFileIndex 只执行了一次）', `不同载荷 ${posts.size} 个`)
  check(sameAsFirst === 100, '100 次调用的载荷（lines/lineBigrams/归一化/buckets）逐项同一', `${sameAsFirst}/100`)
  check(tops.size === 100, '100 个顶层对象互不相同（命中返回浅拷贝）', `不同顶层对象 ${tops.size} 个`)

  const freshAnchor = await freshModule('anchor-core.mjs')
  const g1 = freshAnchor.indexFile(SRC)
  const freshAnchorB = await freshModule('anchor-core.mjs')
  check(
    !samePayload(filePayload(g1), filePayload(freshAnchorB.indexFile(SRC))),
    '无缓存基线成立（anchor-core）：两个全新实例各建一次索引，载荷互不相同',
  )
  const d3 = deepEqual(projectFile(g1), projectFile(first))
  check(d3 === null, 'indexFile：无缓存 vs 缓存 逐字段深比较相等', d3 ?? '')
  check(Object.keys(first).join(',') === FILE_FIELDS, 'indexFile 返回形状不变（字段名与顺序）', Object.keys(first).join(','))
  const bigramsTotal = projectFile(g1).lineBigrams.reduce((n, s) => n + s.size, 0)
  say(`  深比较规模：lines ${g1.lines.length} 项、逐行 bigram 集合 ${g1.lineBigrams.length} 个 / 共 ${bigramsTotal} 个成员、倒排桶 ${g1.buckets.size} 个`)

  // 负向：内容改一个字节必须重建
  const changed = `${SRC.slice(0, 3)}X${SRC.slice(4)}`
  const after = indexFile(changed)
  check(!samePayload(filePayload(indexFile(SRC)), filePayload(after)), 'indexFile：内容改一个字节（等长）⇒ 必须重新建索引')
  check(after.lines[0] === changed.split('\n')[0] && first.lines[0] !== after.lines[0], '新索引的第一行是改动后的文本', JSON.stringify(after.lines[0]).slice(0, 60))

  // 端到端：locateAnchor 两次定位结果一致，且第二次确实走在缓存上（载荷同一，不靠耗时猜）
  const aMod = await freshModule('anchor-core.mjs')
  const anchorText = 'export function resolveTarget(index, target, near = null) {'
  const a1 = aMod.locateAnchor(SRC, anchorText) // 冷：这一次现建行级索引
  const p1 = aMod.indexFile(SRC) // 命中（a1 刚建过）
  const a2 = timeIt(() => aMod.locateAnchor(SRC, anchorText)) // 热：应直接复用
  const p2 = aMod.indexFile(SRC)
  check(
    samePayload(filePayload(p1), filePayload(p2)),
    '两次定位之间行级索引的载荷同一 ⇒ 第二次定位没有重建索引',
  )
  check(
    a1.tier === 'exact' && a2.out.tier === 'exact' && a1.start === a2.out.start && a1.end === a2.out.end,
    'locateAnchor 端到端：两次定位结果逐字段一致',
    `tier=${a1.tier} 行 ${a1.line}／第二次 ${a2.ms.toFixed(2)} ms`,
  )
}

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
  process.exit(1)
}
