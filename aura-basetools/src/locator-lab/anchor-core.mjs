/**
 * anchor-core —— 框架无关的锚点定位引擎。
 *
 * 命题：定位一个改动点，不该要求模型**逐字节复现**原文，而该允许它给一段有偏差的锚点。
 * 匹配、消歧、回报由引擎承担。相对逐字节匹配的变化：
 *   1. 五级降级匹配（exact → 空白折叠 → 行 strip → 相似度 → 行级序列对齐），
 *      容错缩进/空白/改词/重排/增删行；
 *   2. `near` 位置提示把歧义锚点收敛为确定命中（grep 早就知道行号，逐字节匹配却只认内容）；
 *   3. 降级命中时把"实际命中的那段原文"作为回执带回，把不可见的错配变成可见。
 *
 * 本文件**不认识任何 agent 框架**：无依赖、无 I/O。输入源码字符串，输出行区间。
 * 唯一的内部状态是 `indexFile` 手里那层**内容派生的记忆化缓存**（见该函数上方注释）：
 * 同一份内容不再被重复建索引，返回值不变。
 * 文件读写、沙箱、观察策略、审批都归调用方——那是各框架自己的事，引擎不该知道。
 * DSH 的 `aura_basetools_edit` 工具是本引擎的一个适配器，见 `../aura-edit/index.js`。
 *
 * @module anchor-core
 */


/**
 * 额度的**唯一实现**在 `struct-core.mjs`（`indexCacheBudget`）：本文件一行都不算内存。
 * 这里只消费它的只读读数，把“读可用内存 / 环境变量覆写 / 上下限”三件事留在那一个地方——
 * 判据是 `anchor-cache-test.mjs` 段E 的源码扫描（全仓只有一处额度计算），不靠这句注释。
 */
import { indexCacheStats } from './struct-core.mjs'


// ── 归一化层 ────────────────────────────────────────────────────────────────

const collapse = (s) => s.replace(/\s+/g, ' ').trim()
const strip = (s) => s.trim()
/**
 * 行内空白折叠 + 行间保留换行的归一化。**导出**给 `locator-api` 的内容校验用——
 * 校验"这一行是不是我以为的那行"必须与锚点匹配用同一套归一化，否则两处判断会不一致，
 * 而那种不一致极难发现。
 */
export const normSpace = (t) => t.split('\n').map(collapse).join('\n')
const normTrim = (t) => t.split('\n').map(strip).join('\n')

/**
 * 行 → 字符 bigram 集合。这是相似度的**度量基底**：它在"改了标识符"这种漂移下仍然高度重叠
 * （改一个词只动了几个 bigram），而词令牌基底会把一个词变成零重叠，逼着阈值去做不该它做的事。
 * 索引时对每行只算一次，因此这里不需要任何缓存。
 */
function bigrams(line) {
  const t = collapse(line)
  if (t.length === 0) return EMPTY_SET
  if (t.length === 1) return new Set([t])
  const out = new Set()
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
  return out
}

const EMPTY_SET = new Set()

/** bigram 集合的 Jaccard 相似度。空集合与空集合视为全同。 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const g of small) if (big.has(g)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * 从一行的 bigram 集合里挑出最具定位价值的那个桶：出现行数最少的 bigram。
 *
 * 文件侧与锚点侧用同一个函数，因为它们是同一个问题——"这一行能把我带到哪儿去"。
 *
 * **只跳过纯空白 bigram，不设出现次数上限。** 这里曾经有个 `COMMON_BIGRAM_CUTOFF = 8`：
 * 出现超过 8 次的 bigram 一律不索引。它看起来是个性能阈值，实际是错的结构——缩进 bigram
 * （`'  '`、`'    '`）在深缩进文件里天然出现在上千行上，没有上限会让"最稀有 bigram"
 * 退化成空白 bigram、候选集爆炸。但用次数上限去解决它，会连带把"出现 9 次的普通代码 bigram"
 * 也踢出去，于是那一行就彻底无法定位。真正的区分不是"常见/罕见"，而是**它是否携带信息**：
 * 纯空白无论出现几次都不携带信息，非空白 bigram 携带的信息随出现次数平滑下降，交给
 * "取最小桶"这个规则自己处理即可。
 *
 * @param set - 该行的 bigram 集合
 * @param lookup - bigram → 行号数组
 * @returns 最稀有的那个桶，或 null 表示这行没有任何可定位的 bigram
 */
function rarestBucket(set, lookup) {
  let best = null
  let bestLen = Infinity
  for (const g of set) {
    if (g.trim().length === 0) continue // 纯空白不携带信息，永不入选
    const bucket = lookup(g)
    if (bucket !== undefined && bucket.length < bestLen) {
      bestLen = bucket.length
      best = bucket
    }
  }
  return best
}

// ── 行级索引的记忆化 ───────────────────────────────────────────────────────
/**
 * `indexFile` 是热路径：`locateAnchor` 每次定位都现建一份（`locateWith(indexFile(content), …)`），
 * 而**同一份内容**在一轮里会被问好几次（一次编辑的前后两次校验、同一文件的多个锚点、
 * read 与 edit 各一次）。实测本仓最大的引擎文件（`struct-core.mjs`，97 KB / 2573 行）
 * 建一次 **28.1 ms**，而定位本身只要几百微秒——重建索引就是全部成本。这一层把它记住。
 *
 * 判据与 `struct-core.mjs` 里 `indexStructure` 的记忆化是同一套（那边有完整论证）：
 *   · **键就是内容字符串本身**（JS 字符串相等是逐字符的，命中即“一字不差”，不存在哈希碰撞
 *     这种会让“改了内容却拿到旧索引”成真的路径）；同路径内容变了必然重算，
 *     不同路径内容相同则命中；
 *   · `indexFile` 没有语言参数，因此不存在语言维度：输入只有内容；
 *   · **有界**：条目数与估算字节双上限 + LRU；额度**消费** struct-core 那一份（见下方额度块）；
 *   · 命中时返回**浅拷贝**（顶层是自己的一份，载荷共享且须当只读——本仓消费者只用它读行）。
 */

/**
 * ── 额度：不在本文件里算，消费 struct-core 的那一份（全仓一处实现）──────────────
 *
 * **额度怎么算**（读可用内存 / 环境变量覆写 / 上下限 / 进程内定一次）全仓只有一处实现：
 * `struct-core.mjs` 的 `indexCacheBudget()`。本文件不读 `process.env`、不读 `process.availableMemory()`、
 * 不写 clamp——那三样只出现在 struct-core（判据是 `anchor-cache-test.mjs` 段E 的源码扫描 + 运行期读数）。
 *
 * **但额度本身不能直接搬那个数**：同一份内容，行级索引比结构索引重得多。实测（本机，同一份
 * 100000 行档；两次都是 gc 后量，由 `anchor-cache-test.mjs` 段B 现测现断言）：
 *
 *     索引形态             建索引        估算 est      实测常驻     est/real
 *     结构（struct-core）  3247.7 ms     51.91 MiB     41.06 MiB    1.26
 *     行级（本文件）        400.6 ms    208.19 MiB    141.71 MiB    1.47
 *
 * 比值 4.01×（est）/ 3.45×（常驻）——这就是「一个数换个另一个数」不成立的理由：**重量级不同**。
 * 沿用结构索引的额度（那一跑本机 158.54 MiB，可用内存 2643 MiB），这一档的 est 永远 > 额度
 * ⇒ 一次都进不了缓存 ⇒ 每次定位都重建（改动前实测：同一份内容 `indexFile` 第一次 459.3 ms、
 * 第二次 496.8 ms 且载荷不同一）。所以锚点这边的额度取：
 *
 *     额度 = max( 结构额度 , min( 定盘星档单份 est 的两倍 = 416 MiB , 可用内存/4 ) )
 *
 *   · **至少与结构索引同额**：两处共用同一个基线（同一台机器上锚点缓存不会比结构缓存更小）；
 *   · **定盘星档两倍**：与 struct-core 的 floor 同一口径——那边 96 MiB ≈ 它的 100000 行档 est
 *     51.91 MiB 的 1.85 倍；锚点同档 est 208.19 MiB，取整到 MiB 的两倍 = 416 MiB（≈2.00 倍）。
 *     “定盘星档必须进得去”就是这条额度的**目的**，也是上面那条 bug 的根因；
 *   · **可用内存/4**：份额沿用 struct-core 自己就允许的最坏比例（那边的 floor 夹子正是 `可用内存/4`）——
 *     单份重 4 倍，若沿用结构的 1/16 连一份定盘星档都放不进去。被 416 MiB 压住之后本机实测
 *     416 MiB（那一跑可用内存的 15.7%），任何机器上都不超过可用内存/4；读数取不到（非 node 宿主）
 *     时退回 416 MiB——没有读数就没有夹子，与 struct-core 的 `floor(no-available-memory)` 同一条路；
 *   · **条目 16** 与结构索引同源（同一个读数里的 `maxEntries`）：一轮对话里被锚点定位的文件是个位数
 *     （编辑目标 + 少数邻居），两倍余量。
 * 上限不是给正常使用准备的，是给“某个调用方循环索引上千个文件”准备的：没有它，
 * 缓存就是用内存换速度的无界泄漏。
 */
const SHARED_INDEX_BUDGET = indexCacheStats()
/** 报给观测/测试的读数：额度定一次，**这份可用内存读数也跟着定**（否则“上限怎么来的”复现不了）。 */
const FILE_INDEX_CACHE_AVAILABLE_BYTES = SHARED_INDEX_BUDGET.availableBytes
/** 定盘星档（100000 行）单份 est 208.19 MiB 的两倍，取整到 MiB。理由见上。 */
const FILE_INDEX_CACHE_ALLOWANCE_BYTES = 416 * 1024 * 1024
/** 条目上限与结构索引同源（同一个读数）。 */
const FILE_INDEX_CACHE_MAX_ENTRIES = SHARED_INDEX_BUDGET.maxEntries
const FILE_INDEX_CACHE_MAX_BYTES = Math.max(
  SHARED_INDEX_BUDGET.maxBytes,
  Math.min(
    FILE_INDEX_CACHE_ALLOWANCE_BYTES,
    FILE_INDEX_CACHE_AVAILABLE_BYTES === null ? FILE_INDEX_CACHE_ALLOWANCE_BYTES : FILE_INDEX_CACHE_AVAILABLE_BYTES / 4,
  ),
)
/** 这个数**在这台机器上是怎么来的**（给观测与测试用）：共享那一份 + 锚点这一层。 */
const FILE_INDEX_CACHE_BUDGET_SOURCE = `shared:${SHARED_INDEX_BUDGET.budgetSource} ⊕ anchor:max(2×定盘星档est, 可用内存/4)`

/** `Map<内容字符串, {index, bytes}>`；插入序即 LRU 序（队首最旧）。 */
const FILE_INDEX_CACHE = new Map()
let FILE_INDEX_CACHE_BYTES = 0

/**
 * 一份行级索引的常驻字节**粗估**。大头是 `lineBigrams`：每行一个 Set，每个 bigram 还要在
 * `buckets` 里占一个数组槽；`lines` 与两份归一化行数组又各是一份内容量级的拷贝。
 * 同样是估算不是账本，宁可偏大（偏大只会更早淘汰）。
 *
 * 实测它**盖得住**（本机，100000 行档）：est 208.19 MiB vs gc 后常驻 141.71 MiB ⇒ est/real 1.47
 * （结构索引在同一份内容上是 1.26）。这一条由 `anchor-cache-test.mjs` 段B 在目标档上现测现断言。
 */
function fileIndexBytes(content, index) {
  let bigrams = 0
  for (const set of index.lineBigrams) bigrams += set.size
  return content.length * 6 + index.lines.length * 64 + bigrams * 96 + index.buckets.size * 48
}

/** 淘汰到预算以内；队首（最近最少用）先走。 */
function evictFileIndexCache() {
  while (FILE_INDEX_CACHE.size > FILE_INDEX_CACHE_MAX_ENTRIES || FILE_INDEX_CACHE_BYTES > FILE_INDEX_CACHE_MAX_BYTES) {
    const oldest = FILE_INDEX_CACHE.keys().next()
    if (oldest.done === true) return
    const entry = FILE_INDEX_CACHE.get(oldest.value)
    FILE_INDEX_CACHE.delete(oldest.value)
    FILE_INDEX_CACHE_BYTES -= entry.bytes
  }
}

/**
 * 为一份文件内容建一次行级索引。
 *
 * 这是相似度匹配的**模型替换**，不是优化。旧模型对每个起始位置算一次整块相似度，
 * 是 O(文件行数 × 锚点行数)，只能靠魔数闸门才跑得动。新模型"所有窗口同时打分"：
 * 锚点每行用自己最稀有的 bigram 去倒排索引取候选行，只在候选窗口上贡献分数，
 * 累加后取最大。复杂度 O(文件行数 + 锚点行数 × 候选数)，没有前置筛、没有兜底分支、
 * 没有需要标定的门槛——`SIM_THRESHOLD` 只回答"这算不算同一段"，不参与性能决策。
 *
 * **同一份内容重复调用不再重复解析**：命中判据、上限与透明性见上方记忆化说明。签名、返回形状
 * 与语义都没有变——缓存只在“这份内容刚算过”时生效。
 *
 * @param content - 文件全文
 * @returns 供 {@link locateWith} 与 {@link scoreWindows} 使用的索引
 */
export function indexFile(content) {
  /**
   * 非字符串不进缓存：Map 对非字符串键按**对象身份**比对，而复用同一个 Buffer 反复装填内容
   * （读文件循环里的常见写法）会让“改了内容却命中旧索引”真的发生。不缓存 = 与改动前逐字一致。
   */
  if (typeof content !== 'string') return buildFileIndex(content)

  const hit = FILE_INDEX_CACHE.get(content)
  if (hit !== undefined) {
    // LRU：命中即刷新访问序（Map 保持插入序，先删再插 = 挪到队尾）。
    FILE_INDEX_CACHE.delete(content)
    FILE_INDEX_CACHE.set(content, hit)
    return { ...hit.index }
  }
  const index = buildFileIndex(content)
  const bytes = fileIndexBytes(content, index)
  // 单条就超预算：宁可它每次重算，也不让一条挤掉整个缓存。
  if (bytes > FILE_INDEX_CACHE_MAX_BYTES) return index
  FILE_INDEX_CACHE.set(content, { index, bytes })
  FILE_INDEX_CACHE_BYTES += bytes
  evictFileIndexCache()
  return index
}

/**
 * 缓存现状快照（**只读观测**：不改任何行为、不动缓存、不影响命中）。
 *
 * 存在的理由与 struct-core 的 `indexCacheStats()` 同一条：额度是从**可用内存**算出来的数
 * （见上方额度块），“上限是多少、现在用了多少”必须是能在外部复核的事实——测试要断言
 * 「实际字节 ≤ 上限」，运维要知道这份索引吃了多少内存。没有这个口子，判据只能去读源码里的常数。
 *
 * `bytes` 是 {@link fileIndexBytes} 的**估算**合计（不是精确账本）；`availableBytes` 与
 * `budgetSource` 都是**定额度时**那一份读数（额度定一次，读数不复读，否则“上限是怎么来的”复现不了）。
 * 返回的是每次新建的普通对象，不冻结：它是给人看的读数，不是内部状态本身。
 *
 * 额度本身不在这里算——这里只是把它报出来（{@link SHARED_INDEX_BUDGET} 那一份）。
 *
 * @returns {{entries: number, bytes: number, maxBytes: number, maxEntries: number, budgetSource: string, availableBytes: number|null}}
 */
export function indexFileCacheStats() {
  return {
    entries: FILE_INDEX_CACHE.size,
    bytes: FILE_INDEX_CACHE_BYTES,
    maxBytes: FILE_INDEX_CACHE_MAX_BYTES,
    maxEntries: FILE_INDEX_CACHE_MAX_ENTRIES,
    budgetSource: FILE_INDEX_CACHE_BUDGET_SOURCE,
    availableBytes: FILE_INDEX_CACHE_AVAILABLE_BYTES,
  }
}

/**
 * 真正的建索引。**不缓存**——`indexFile` 是它的记忆化外壳：拆成两个名字，是为了让“缓存”
 * 这件事只出现在一个地方（这里一行都不谈命中与淘汰）。
 */
function buildFileIndex(content) {
  const lines = content.split(/\r?\n/)
  const lineBigrams = lines.map(bigrams)
  const buckets = new Map() // bigram -> 行号数组
  for (let i = 0; i < lineBigrams.length; i += 1) {
    for (const g of lineBigrams[i]) {
      const bucket = buckets.get(g)
      if (bucket === undefined) buckets.set(g, [i])
      else bucket.push(i)
    }
  }
  return {
    lines,
    lineBigrams,
    // T2/T3 要按行归一化后再比，且每个文件只该算一次。之前是在 locateWith 里按层现算，
    // 同一个文件被 map 两遍——挪到建索引的时候一次算好，顺带让 `lineBigrams` 与它同源。
    spaceNormalized: lines.map(normSpace),
    trimNormalized: lines.map(normTrim),
    buckets,
    flat: lines.join('\n'),
  }
}

/**
 * 一次遍历同时产出两样东西，因为它们来自同一份工作：
 *   - `windows`：每个可能起始行的逐行最佳匹配均分（定长窗口的打分，用于 T4）；
 *   - `anchors`：由"锚点第 j 行命中了文件第 i 行"投影出的**候选起点 i-j**（去重）。
 *
 * 必须同时产出候选起点，是因为定长窗口有个固有盲区：被删掉的那一行若正好是锚点首行，
 * 窗口分数和候选池都会一起塌掉。而投影起点不依赖任何一行匹配成功——只要**某一行**命中，
 * 它就能给出"真实区域大概从哪开始"，交给 T5 对齐去裁定。
 *
 * @returns {{windows: Array<{start, score}>, anchors: number[]}}
 */
function scoreWindows(index, anchorBigrams, n) {
  const { lines, lineBigrams, buckets } = index
  const limit = Math.max(0, lines.length - n + 1)
  const raw = new Map()
  const anchors = new Set()
  for (let j = 0; j < anchorBigrams.length; j += 1) {
    const aw = anchorBigrams[j]
    const bucket = rarestBucket(aw, (g) => buckets.get(g))
    if (bucket === null) continue // 这行在文件里没有可定位的 bigram
    const add = bucket.map((line) => ({ line, score: jaccard(aw, lineBigrams[line]) }))
    for (const { line, score } of add) {
      const start = line - j
      if (start >= 0) anchors.add(start)
      if (limit <= 0) continue
      const lo = Math.max(0, start)
      const hi = Math.min(start, limit - 1)
      for (let s = lo; s <= hi; s += 1) {
        const cur = raw.get(s)
        if (cur === undefined) raw.set(s, score)
        else raw.set(s, cur + score)
      }
    }
  }
  const windows = [...raw.entries()]
    .map(([start, sum]) => ({ start, score: sum / n }))
    .sort((a, b) => b.score - a.score)
  return { windows, anchors: [...anchors] }
}

// ── 行级序列对齐（完整 DP 表 + 回溯）──────────────────────────────────────
//
// 定长窗口有一个固有边界：它假设"改完之后行数不变"。只要锚点相对文件里的真实区域多了或少了
// 一整行，窗口内的逐行最佳匹配就会被行数惩罚压到阈值以下。这不是参数调不好，是模型选错了——
// 增删行是序列问题，得用序列对齐解决。
//
// 这里用最直白的 O(A×W) 表加回溯。锚点与窗口都在几十行量级（实测 A≤16、W≤24），表的代价
// 可以忽略；线性内存的 Hirschberg 分治能省内存，但省下的内存换不来任何东西，反而多了一处
// 容易写错的边界。可读、可测、显然正确，在这里比省几 KB 值钱。

/**
 * 两行的替换代价，与"不相似度"成比例：`2 × (1 - 相似度)`。
 *
 * 必须是比例的，不能是分段式（"相同→0，否则整额"）。分段式会让一个字符的笔误与整行重写等价，
 * 于是"锚点少一行 + 一个标识符记错"这种完全正常的漂移会被算成两次整额代价而落到阈值之下——
 * 实测 0.631 vs 阈值 0.7。比例式下，一个词写错只损失该行相似度的一小部分。
 * 顺带一个好处：它与"删一整行"的代价同为 2 的上界，两类漂移在分数上可比。
 */
function subCost(a, b) {
  return 2 * (1 - jaccard(a, b))
}

/**
 * 建一张编辑距离表。`D[i][j]` = 锚点前 i 行 对 文件前 j 行 的最小代价。
 * 删除（锚点多一行）与插入（文件多一行）代价都是 2，替换用 {@link subCost}。
 */
function distanceTable(anchorBigrams, fileBigrams) {
  const A = anchorBigrams.length
  const W = fileBigrams.length
  const D = Array.from({ length: A + 1 }, () => new Float64Array(W + 1))
  for (let j = 1; j <= W; j += 1) D[0][j] = D[0][j - 1] + 2
  for (let i = 1; i <= A; i += 1) {
    D[i][0] = D[i - 1][0] + 2
    for (let j = 1; j <= W; j += 1) {
      D[i][j] = Math.min(
        D[i - 1][j] + 2, // 锚点第 i 行没配上
        D[i][j - 1] + 2, // 文件第 j 行没配上
        D[i - 1][j - 1] + subCost(anchorBigrams[i - 1], fileBigrams[j - 1]),
      )
    }
  }
  return D
}

/**
 * 用对齐给一个候选起点打分。
 *
 * 块大小是**扫描**出来的，不是猜的：真实区域可能是 A-1 行，固定成 A 或 A+A/2 都会把正确答案
 * 挤出去——撑大了，多出的填充行会被当成删除计费（实测把 0.667 压成 0.333）。
 * 一次 DP 就够：`D[A][W]` 对每个前缀宽度 W 都是"锚点对齐到该宽度"的最小代价，
 * 因此扫描 W 只是读表的一列，不必对每个 W 重建表。
 *
 * 归一化用标准 Levenshtein：`1 - 编辑距离 / (锚点行数 + 窗口行数)`。它对增删行天然宽容——
 * 删掉一行只让分母加 1、分子加 2，而**不是**像定长窗口那样把整块分数按行数比例打折。
 *
 * @returns {{score, windowLines}} 分数，以及该候选实际覆盖的窗口行数
 */
function alignmentScore(anchorBigrams, fileLineBigrams, start) {
  const A = anchorBigrams.length
  if (A === 0) return { score: 0, windowLines: 0 }
  const minW = Math.max(1, A - 2)
  const maxW = Math.min(fileLineBigrams.length - start, A + Math.max(2, Math.ceil(A / 2)))
  if (maxW < minW) return { score: 0, windowLines: 0 }
  const file = fileLineBigrams.slice(start, start + maxW)
  const D = distanceTable(anchorBigrams, file)
  let best = null
  for (let W = minW; W <= maxW; W += 1) {
    const score = Math.max(0, 1 - D[A][W] / (A + W))
    // 严格大于才替换：并列时保留先扫到的更紧窗口——同样的分数，跨度小的答案更精确
    if (best === null || score > best.score + 1e-9) best = { score, windowLines: W }
  }
  return best ?? { score: 0, windowLines: 0 }
}

const SIM_THRESHOLD = 0.82
const NEAR_TIE = 0.02
/**
 * 行级对齐的相似度下限。比 SIM_THRESHOLD 松，因为对齐衡量的是"这一整段是不是同一段代码"，
 * 而它已经过了一次"最佳窗口"筛选。删掉一行注释这种 1 增删 / 7 总长的情形得分为 0.857，
 * 恰好落在两个阈值之间 —— 这正是它该在的位置：定长窗口处理不了增删行，对齐可以。
 */
const ALIGN_THRESHOLD = 0.7
/** 只有快速打分够不到阈值时才做对齐，且只对最佳的几个候选做。 */
const ALIGN_CANDIDATES = 5

/** 补丁自身的错误类型，带稳定 code 与可回报的候选行号。 */
class PatchError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 用 `near` 行号提示从多个候选里收敛出一个。
 *
 * **等距时返回 null 而不是挑一个。** 那正是本工具存在的理由：`edit` 的子串搜索会在多个位置里
 * 静默选中第一个，然后不报错地改错地方。既然 `near` 无法区分，就应当是歧义、应当被拒绝，
 * 而不是由宿主替模型掷一次骰子。
 *
 * @param starts - 0-based 候选起始行
 * @param near - 1-based 行号提示
 * @returns 唯一的最近候选，或 null（无提示 / 存在并列最近）
 */
function pickNear(starts, near) {
  if (near === null || near === undefined || starts.length === 0) return null
  let best = null
  let bestD = Infinity
  let ties = 0
  for (const s of starts) {
    const d = Math.abs(s + 1 - near)
    if (d < bestD) {
      bestD = d
      best = s
      ties = 1
    } else if (d === bestD) {
      ties += 1
    }
  }
  return ties === 1 ? best : null
}

/**
 * 在已建索引的文件里定位 anchor。返回 0-based 的 [start, end) 行区间。
 *
 * 四级匹配由严到松：exact → 空白折叠 → 行 strip → 词相似度。前三级的失败原因与第四级
 * 无关，因此第四级只负责"内容真的被改写过"这一种情况。
 *
 * @param index - {@link indexFile} 的结果
 * @throws PatchError，code 为 PATCH_AMBIGUOUS / PATCH_NOT_FOUND / PATCH_EMPTY_ANCHOR
 */
export function locateWith(index, anchor, near = null) {
  if (typeof anchor !== 'string' || anchor.length === 0) {
    throw new PatchError('anchor must be a non-empty string', 'PATCH_EMPTY_ANCHOR')
  }
  const anchorText = anchor.replace(/\r\n/g, '\n')
  const anchorLines = anchorText.split('\n')
  if (anchorLines.length > 1 && anchorLines[anchorLines.length - 1] === '') anchorLines.pop()
  const { flat } = index

  // T1 exact
  const hits = []
  let idx = flat.indexOf(anchorText)
  while (idx !== -1) {
    hits.push(idx)
    idx = flat.indexOf(anchorText, idx + 1)
  }
  if (hits.length === 1) {
    const start = flat.slice(0, hits[0]).split('\n').length - 1
    return { tier: 'exact', start, end: start + anchorLines.length, line: start + 1 }
  }
  if (hits.length > 1) {
    const starts = hits.map((i) => flat.slice(0, i).split('\n').length - 1)
    const chosen = pickNear(starts, near)
    if (chosen !== null) {
      return { tier: 'exact', start: chosen, end: chosen + anchorLines.length, line: chosen + 1, byNear: true }
    }
    throw new PatchError(`anchor matched ${hits.length} times verbatim`, 'PATCH_AMBIGUOUS', {
      candidates: starts.map((i) => i + 1),
    })
  }

  // T2/T3 按行归一化后比对
  const n = anchorLines.length
  for (const tier of ['norm-space', 'trim-line']) {
    const norm = tier === 'norm-space' ? normSpace : normTrim
    const target = anchorLines.map(norm).join('\n')
    const win = tier === 'norm-space' ? index.spaceNormalized : index.trimNormalized
    const found = []
    for (let i = 0; i + n <= win.length; i += 1) {
      if (win.slice(i, i + n).join('\n') === target) found.push(i)
    }
    if (found.length === 1) return { tier, start: found[0], end: found[0] + n, line: found[0] + 1 }
    if (found.length > 1) {
      const chosen = pickNear(found, near)
      if (chosen !== null) return { tier, start: chosen, end: chosen + n, line: chosen + 1, byNear: true }
      throw new PatchError(`anchor matched ${found.length} windows at ${tier}`, 'PATCH_AMBIGUOUS', {
        candidates: found.map((i) => i + 1),
      })
    }
  }

  // T4 字符 bigram 相似度：一次遍历给所有窗口打分（见 scoreWindows），无前置筛、无兜底分支。
  const anchorBigrams = anchorLines.map(bigrams)
  const { windows: scored, anchors: projected } = scoreWindows(index, anchorBigrams, n)
  const top = scored[0]
  if (top && top.score >= SIM_THRESHOLD) {
    const tied = scored.filter((s) => s.score >= top.score - NEAR_TIE)
    if (tied.length > 1) {
      const chosen = pickNear(tied.map((t) => t.start), near)
      if (chosen !== null) return { tier: 'similarity', start: chosen, end: chosen + n, line: chosen + 1, byNear: true }
      throw new PatchError(`anchor matched ${tied.length} windows at similarity ~${top.score.toFixed(3)}`, 'PATCH_AMBIGUOUS', {
        candidates: tied.map((t) => t.start + 1),
      })
    }
    return { tier: 'similarity', start: top.start, end: top.start + n, line: top.start + 1, score: top.score }
  }

  // T5 行级对齐：定长窗口够不到阈值时的兜底路径，专门处理"锚点相对真实区域多/少了一整行"。
  // 候选起点取"每一行命中位置的投影"并集——它不要求任何特定行匹配成功，
  // 因此即便被删掉的正是锚点首行，也仍能找到真实区域。跨度由对齐结果给出，不假设行数不变。
  //
  // 池子可能很大（重复度高的文件会给出许多投影起点），因此要**按便宜的窗口分数排序后再截断**，
  // 而不是按投影出现的先后顺序截断——后者会把真正的最佳候选排除在外，凭空造出 PATCH_NOT_FOUND。
  const fileLineBigrams = index.lineBigrams
  const cheapScore = new Map(scored.map((s) => [s.start, s.score]))
  const pool = [...new Set([...projected, ...scored.map((s) => s.start)])]
    .sort((a, b) => (cheapScore.get(b) ?? 0) - (cheapScore.get(a) ?? 0))
    .slice(0, ALIGN_CANDIDATES)
  const aligned = pool.map((start) => {
    const r = alignmentScore(anchorBigrams, fileLineBigrams, start)
    return { start, score: r.score, span: r.windowLines }
  })
  aligned.sort((a, b) => b.score - a.score)
  const bestAlign = aligned[0]
  if (bestAlign && bestAlign.score >= ALIGN_THRESHOLD) {
    const tied = aligned.filter((s) => s.score >= bestAlign.score - NEAR_TIE)
    if (tied.length > 1) {
      const chosen = pickNear(tied.map((t) => t.start), near)
      if (chosen !== null) {
        const span = tied.find((t) => t.start === chosen).span
        return { tier: 'aligned', start: chosen, end: chosen + span, line: chosen + 1, byNear: true }
      }
      throw new PatchError(`anchor aligned to ${tied.length} windows at ~${bestAlign.score.toFixed(3)}`, 'PATCH_AMBIGUOUS', {
        candidates: tied.map((t) => t.start + 1),
      })
    }
    return {
      tier: 'aligned',
      start: bestAlign.start,
      end: bestAlign.start + bestAlign.span,
      line: bestAlign.start + 1,
      span: bestAlign.span,
      score: bestAlign.score,
    }
  }

  throw new PatchError(
    `anchor not found (best similarity ${top ? top.score.toFixed(3) : 'n/a'} < ${SIM_THRESHOLD}, ` +
      `best alignment ${bestAlign ? bestAlign.score.toFixed(3) : 'n/a'} < ${ALIGN_THRESHOLD})`,
    'PATCH_NOT_FOUND',
    { bestScore: top ? top.score : 0, bestAlignment: bestAlign ? bestAlign.score : 0 },
  )
}
/**
 * 锚点定位的便捷入口：对单次定位建一次索引再定位。
 * 批量场景应自行调用 {@link indexFile} 与 {@link locateWith}，让一次索引服务全部定位。
 *
 * 名字里带 `Anchor` 是刻意的：`locator-api.mjs` 里已经有一个 `locate`，那才是统一门面
 * （按 `target` 或 `anchor` 分流）。两个同名函数会让调用方看不出自己走的是哪条路，
 * 而本文件只做文本锚点这一条。
 *
 * @param content - 文件全文
 * @param anchor - 记得的原文
 * @param near - 可选 1-based 行号提示
 * @returns 与 {@link locateWith} 相同
 */
export function locateAnchor(content, anchor, near = null) {
  return locateWith(indexFile(content), anchor, near)
}