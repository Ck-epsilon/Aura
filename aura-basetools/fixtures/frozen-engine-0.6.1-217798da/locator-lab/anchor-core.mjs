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
 * 本文件**不认识任何 agent 框架**：无依赖、无 I/O、无状态。输入源码字符串，输出行区间。
 * 文件读写、沙箱、观察策略、审批都归调用方——那是各框架自己的事，引擎不该知道。
 * DSH 的 `aura_edit` 工具是本引擎的一个适配器，见 `../aura-edit/index.js`。
 *
 * @module anchor-core
 */


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

/**
 * 为一份文件内容建一次行级索引。
 *
 * 这是相似度匹配的**模型替换**，不是优化。旧模型对每个起始位置算一次整块相似度，
 * 是 O(文件行数 × 锚点行数)，只能靠魔数闸门才跑得动。新模型"所有窗口同时打分"：
 * 锚点每行用自己最稀有的 bigram 去倒排索引取候选行，只在候选窗口上贡献分数，
 * 累加后取最大。复杂度 O(文件行数 + 锚点行数 × 候选数)，没有前置筛、没有兜底分支、
 * 没有需要标定的门槛——`SIM_THRESHOLD` 只回答"这算不算同一段"，不参与性能决策。
 *
 * @param content - 文件全文
 * @returns 供 {@link locateWith} 与 {@link scoreWindows} 使用的索引
 */
export function indexFile(content) {
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