/**
 * indent-loss-census.mjs —— 缩进吞噬普查：`old` 省掉行首空白时被**整行替换**吃掉的缩进，
 * 在真实会话里到底发生多少次？
 *
 * 运行：
 *   node aura-tools/probes/indent-loss-census.mjs                     # 全量（默认；660MB 语料，~40s + 对账 ~40s）
 *   node aura-tools/probes/indent-loss-census.mjs --sessions=200      # 只扫路径序前 200 个（那是最老的一批）
 *   node aura-tools/probes/indent-loss-census.mjs --tail=200          # 只扫 mtime 最新的 200 个（开发用）
 *   node aura-tools/probes/indent-loss-census.mjs --until=<ms|ISO> --stale-minutes=20
 *   node aura-tools/probes/indent-loss-census.mjs --show=10 --json
 *   node aura-tools/probes/indent-loss-census.mjs --no-upstream       # 跳过上游口径对账（省一遍扫描）
 *
 * 任一子集都不改**选择规则**：文件集始终是 `success-regression.mjs` 的 `selectCorpusFiles()`
 * 选出来的那一批，探针只是在上面再取一段来开发。
 *
 * ## 要回答的那个机制
 *
 * `old` 只写了行内正文（没写行首那两个空格）时，引擎照样命中：归一化层
 * （`anchor-core.mjs` 的 `normSpace = 逐行折叠空白 + trim`）把「  return c - 3」与
 * 「return c - 3」看成同一行，于是 `applied[].tier` 报 `old~norm-space`。**但落盘的是整行**：
 * 那一行的原文（含缩进）被调用方给的 `replace` 整段顶替。调用方若也没在 `replace` 里补回缩进
 * （它只想改行内某个词），这一行的缩进就**没了** —— 而它从未被调用方引用过。
 *
 *   ​原文：  export function gamma (c) {\n  return c - 3\n}\n
 *   ​调用：  hunks=[{ old: 'return c - 3', replace: 'return c - 30' }]
 *   ​结果：  export function gamma (c) {\nreturn c - 30\n}\n     ← 两个空格没了
 *   ​回执：  applied: [{ line: 2, tier: 'old~norm-space', actual: '  return c - 3' }]
 *
 * 回执**披露了**这件事（`actual` 与 `replaced` 逐字不同），所以它不是"静默"的；但它确实改了
 * 调用方没引用的字节。值不值得改引擎，取决于它**在真实会话里有多频繁** —— 本探针只量这个。
 *
 * ## 人口（用 success-regression.mjs 的语料构造，不另写一份）
 *
 *   · **同一批会话文件**：`selectCorpusFiles()`（从 `success-regression.mjs` **导出**的那一份）
 *     —— 同一个会话根、同一套「排除正在写的会话 + mtime ≤ until − staleMinutes」窗口规则；
 *   · **同一套解析**：`tool/call` → `tool/result` 按 `callId` 配对、同一 `callId` 的重复结果事件
 *     只算一次（`claimed` 规则与上游逐条同形）；
 *   · **同一层成功口径**：`isError === false`（上游 `tally.editOk` 就是它，本探针现场对账）；
 *   · **再紧一层**：`isError=false` 还包含干跑 / 已落地 / 如实拒绝（它们一个字节都没写），
 *     所以人口 = 回执**给出落盘标志**（`N hunk(s) applied`）且**不带** `nothing was written`
 *     的那些调用。这一层比上游严，两侧条数都印出来（`editOk` 与人口的差就是这一层）。
 *     单位 = **一次调用**（"an edit"），与上游 `aura_edit` 调用同粒度。
 *
 * ## 分类（单位 = 回执报出来的**落点**：`applied[].line / actual / replaced`）
 *
 * 回执正文里落点只有三种形状（`aura-edit/index.js` 的 `renderResult`）：
 *   · `  line N [tier] "改前" → "改后"`        —— 单行换单行：`actual` 与 `replaced` **都在**；
 *   · `  line N [tier] now: "改后" +K more line(s)` —— 其它：**只印改后**，`actual` 没进回执；
 *   · `  line N [tier] "改前"`（更早的渲染）—— **只印改前**，`replaced` 没进回执。
 * 于是「这一行的行首空白变了吗」只在第一种形状上可观测；后两种**如实记 unobservable**，
 * 不折进任何别的桶。桶（互斥、每个落点恰好一个）：
 *   · `indent-lost`   —— 原文有行首空白，写回的那份没有、或更短；
 *   · `indent-added`  —— 原文没有行首空白，写回的那份有；
 *   · `indent-other`  —— 两段空白都在，但既不是"丢"也不是"新加"（更深了 / 等长不同字符）；
 *   · `indent-same`   —— 行首空白逐字符相同；
 *   · `unobservable`  —— 回执没同时带上 `actual` 与 `replaced`（原因再分：只印改后 / 只印改前 /
 *     形状认不出）。**单独一桶、单独印原因**：把它折进"没变"就是拿不可观测冒充读数。
 *
 * 调用级（= 人口单位）也各进一个桶，优先级 lost > added > other > same > unobservable
 * —— 于是「这个桶之和 = 人口」这句话是可核的。两张表都印。
 *
 * 每个可观测落点还带一个**可核性**标记（`verified`）：回执那份 `replaced` 能不能**对回**
 * 调用方自己的某一条 hunk 的 `replace`（回执的 clip 规则：单行、>64 字符截 `…`）。
 * 为什么要它：`planHunks` 拼回执时用的是 `out.slice(m.start, …)`，`m.start` 是**改动前**的
 * 行号索引 ---- 同一次调用里有更低的 hunk 增删了行时，高位 hunk 的 `replaced` 会指到**别的行**
 * 上去（已用 `planHunks` 现场复现，见“已知盲区”）。`actual` 不受影响。所以：
 *   · 分类照任务口径做在回执值上（两张桶表就是它）；
 *   · **判决**只数 `verified` 的那些 —— 否则拿邻居行的缩进去比，会凭空造出"缩进丢了"。
 *
 * ## indent-lost 的细分
 *
 *   · **按 tier**：命中层族与层名（`applied[].tier` 去掉 `, by near` 与 `(…)` 披露段）的分布；
 *   · **两档**：`replaced` 是空串（**整行删掉**，行都没了谈不上缩进被吞）vs 非空但缩进变浅
 *     （**真去缩进**）—— 任务口径把两者都归 `indent-lost`，这里分开印，读的人自己决定算不算；
 *   · **按调用方的 `old`**：用落点的 `replaced` 令牌回查这次调用的 hunk —— **恰好一条命中**
 *     才算取回，取不回就逐条说明原因（`not-matched` / `ambiguous` / 参数里根本没有 `old` /
 *     参数解析不了），**不猜**；
 *   · **机制核对**：`old` 取回且未被截断的那些落点，逐条核 `normSpace(old) === normSpace(actual)`
 *     —— 这一条是**引擎自己的命中条件**，所以它必须恒成立；不成立就说明回执解析错了。
 *
 * ## 判决（本探针的全部意义）
 *
 * 问题：**若引擎改成「空白折叠命中的 `old` 保留行首前缀」（只替换被引用的那一段），
 * 或改成直接拒（第四态），有多少条编辑会写出不同的字节？**
 * 口径：落点的命中层是**空白折叠且整行对齐**（层名含 `norm-space` / `trim-line`，且不含
 * `fragment`）**且**行首空白变了**且** `replaced` 可核（见上）。理由：只有这一档是"调用方
 * 没引用缩进、引擎却把整行换掉"；片段层（`fragment`）本来就只替换被引用那一处跨度，改规则
 * 也换不出不同字节；逐字命中（`exact` / `lines` / `symbol` / `old`）时调用方**自己**在
 * `old`/`anchor` 里引用了缩进，改规则同样不影响它（那一类另外单独印出来，见"调用方自己丢的缩进"）。
 * 判决数**从「桶 × 命中层 × 可核性」交叉表重算**（不是另外断言一个数），并同时给**调用**口径
 * （含 ≥1 个这样的落点的调用数）——那才是"人口的百分之多少"。
 *
 * 报告里还有一条**机会分母**：全语料里用 `old` 寻址的调用有多少条。机制没被用上时，"它没咬人"
 * 这句话与"它没被试用过"是一回事，两个数必须一起看。
 *
 * ## 判据与退出码
 *
 * 判据见文末 `── 判据 ──` 段：人口非空、上游五项口径逐一相等、人口 = `isError=false` − 无落盘标志、
 * 两个单位的桶之和各自等于分母、调用级桶能由落点级桶按优先级逐条推出、判决数可由交叉表重算、
 * 合成自检（题面那个复现样例 + 四类合成回执分进四个不同的桶）、机制核对恒成立。
 * 退出码：0 = 全绿；1 = 有判据红；2 = 用法错。
 *
 * ## 已知盲区（写给读这个数的人）
 *
 *   · `now:` 形状的落点（改后是多行、或改前是多行）**观测不到** `actual` —— 真实会话里这一类
 *     占比不小，所以"缩进被吞"的真值只会**大于等于**本探针报出的数，不会更小；
 *   · 回执里的引用是**显示形态**（>64 字符截断加 `…`）：行首空白在最前面，截断不影响前缀比对；
 *     但 `old` 回查在正文超 64 字符时依赖那条 clip 规则，规则漂了就回查不到（记 `not-matched`，不猜）；
 *   · 前缀比对按**长度**判"更短"（制表符与空格不折算视觉宽度）：`  ` → `\t` 会被记成 lost。
 *     带制表符的前缀有多少条单独印出来，供读者自己扣；
 *   · **回执自己会串行**（实测，不是推测）：两次以上 hunk 的调用里，只要低位的 hunk 增删了行，
 *     高位那条 `replaced` 就会指到别的行上去。`planHunks` 现场复现：
 *     把 `a2` 换成两行、把 `a6` 换成 `A6\\nA6b` ⇒ 回执给第 6 行报的 `replaced` 是 `a5\\nA6`。
 *     这是引擎侧的回执缺陷（不在本单要改的范围），但它会**污染**前缀比对 ⇒ 判决只数可核的
 *     那些，并把不可核的条数单独印出来（语料越大这个数越大：全量实测 1,263/5,533）；
 *   · 收进来的只是**回执报出来的**落点：回执被截断 / 换了渲染形状的会话，其落点根本不会出现
 *     在这里（`unobservable` 里那个 `unparsed` 档就是它的下限）；
 *   · 只读会话日志与引擎源码：不写盘、不进 `~/.aura`、不改任何字节。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SESSIONS_ROOT, selectCorpusFiles, receiptTextOf, tallyCorpusEdits, hunksOf } from './success-regression.mjs'
import { decompressAll } from './session-log.mjs'
import { normSpace } from '../src/locator-lab/anchor-core.mjs'
/** 合成自检②要跑**真引擎**：`planHunks` 是纯函数，不落盘、不改任何字节。 */
import { planHunks } from '../src/locator-lab/write-path.mjs'

// ── 0. 常量与纯函数（分类、回执解析、回查 —— 合成自检与真语料走同一条路） ────────────

/** 桶名：**唯一一份**（分类、两张表、判决重算都读它）。顺序 = 调用级的优先级。 */
const BUCKETS = ['indent-lost', 'indent-added', 'indent-other', 'indent-same', 'unobservable']
/** 前缀**变了**的桶（判决的候选集就是它 × 空白折叠整行层）。 */
const PREFIX_CHANGED = ['indent-lost', 'indent-added', 'indent-other']

/** 行首空白：空格 / 制表符 / 全角空格 / NBSP 都算（`\s` 里去掉换行）。 */
const LEAD_WS = /^[^\S\r\n]*/
const leadWs = (s) => LEAD_WS.exec(String(s))[0]

/**
 * 落点分类：**只比行首空白这一段**，不比正文。
 * "更短"按字符数判（制表符不折算视觉宽度）—— 口径写在文件头的盲区里。
 */
function bucketOf(actual, replaced) {
  const a = leadWs(actual)
  const r = leadWs(replaced)
  if (a === r) return 'indent-same'
  if (a.length > 0 && (r.length === 0 || r.length < a.length)) return 'indent-lost'
  if (a.length === 0 && r.length > 0) return 'indent-added'
  return 'indent-other'
}

/** 回执里那个引号 token 的形状（`"(?:[^"\\]|\\.)*"`）——两处复用，写一份。 */
const STR = '"(?:[^"\\\\]|\\\\.)*"'
const ENTRY_RE = new RegExp(`^ {2}line (\\d+) \\[([^\\]]+)\\] (.*)$`)
const SWAP_RE = new RegExp(`^(${STR}) → (${STR})$`)
const NOW_RE = new RegExp(`^now: (${STR})(?: \\+(\\d+) more line\\(s\\))?$`)
const ACTUAL_ONLY_RE = new RegExp(`^(${STR})$`)

const unquote = (token) => {
  try {
    const v = JSON.parse(token)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}
/** 引用被截断（壳层 clip 的 `…`）。前缀比对不受影响，但机制核对必须排除它。 */
const isClipped = (token) => token.endsWith('…"')

/**
 * 成功回执正文 → 逐条落点。**只认上述三种形状**，认不出的行不当落点
 * （宁可少收，不可收错：把信封行当落点会凭空造出数据）。
 */
function parseApplied(receiptBody) {
  const out = []
  for (const row of String(receiptBody).split('\n')) {
    const m = ENTRY_RE.exec(row)
    if (!m) continue
    const rec = { line: Number(m[1]), tier: m[2].trim(), shape: null, actual: null, replaced: null, rawActual: null, rawReplaced: null, clipped: false }
    const swap = SWAP_RE.exec(m[3])
    if (swap !== null) {
      rec.shape = 'swap'
      rec.rawActual = swap[1]
      rec.rawReplaced = swap[2]
      rec.actual = unquote(swap[1])
      rec.replaced = unquote(swap[2])
      rec.clipped = isClipped(swap[1]) || isClipped(swap[2])
      if (rec.actual === null || rec.replaced === null) rec.shape = 'swap-unparsed'
      out.push(rec)
      continue
    }
    const now = NOW_RE.exec(m[3])
    if (now !== null) {
      rec.shape = 'now'
      rec.rawReplaced = now[1]
      rec.replaced = unquote(now[1])
      rec.clipped = isClipped(now[1])
      rec.moreLines = now[2] === undefined ? 0 : Number(now[2])
      if (rec.replaced === null) rec.shape = 'now-unparsed'
      out.push(rec)
      continue
    }
    const only = ACTUAL_ONLY_RE.exec(m[3])
    if (only !== null) {
      rec.shape = 'actual-only'
      rec.rawActual = only[1]
      rec.actual = unquote(only[1])
      rec.clipped = isClipped(only[1])
      out.push(rec)
      continue
    }
    rec.shape = 'unparsed'
    out.push(rec)
  }
  return out
}

/** 回执里那个 token 是不是 `text` 的**显示形态**（引擎 clip：单行、>64 字符截 `…`）。 */
function tokenIsClipOf(token, text) {
  if (typeof text !== 'string' || text.includes('\n')) return false
  if (token === JSON.stringify(text)) return true
  return token === JSON.stringify(`${text.slice(0, 64)}…`)
}

/** 一次调用的全部 hunk：单目标 `hunks`（走上游那份 `hunksOf`）优先，其次多目标 `targets[].hunks`。 */
function allHunksOf(args) {
  const flat = hunksOf(args)
  if (flat.length > 0) return flat
  const out = []
  if (args !== null && typeof args === 'object' && Array.isArray(args.targets)) {
    for (const t of args.targets) if (Array.isArray(t?.hunks)) out.push(...t.hunks.filter((h) => h !== null && typeof h === 'object'))
  }
  return out
}

/**
 * 把落点的 `replaced` 对回这次调用的某一个 hunk —— **两件事一次做掉**：
 *
 *   ① 取回调用方原来的 `old`（`recovered`）；
 *   ② 判「回执这份 `replaced` 是不是调用方真写的那份」——**恰好一条** hunk 的 `replace`
 *      显示形态等于它，才算**对得上**（`verified`）。
 *
 * ②为什么要单独判：`planHunks` 拼回执时用的是 `out.slice(m.start, …)`，而 `m.start` 是
 * **改动前**的行号索引 —— 同一次调用里有更低的 hunk 增删了行时，高位 hunk 的 `replaced`
 * 会指到**别的行**上去（已用 `planHunks` 现场复现：替换 `a6`→`A6\nA6b` 而低位的 `a2`→两行时，
 * 回执报的 `replaced` 是 `a5\nA6`）。`actual` 不受影响（它是命中时当场记下的）。
 * 所以前缀比对只在 `verified` 的那些上做：否则拿一行它邻居的缩进去比，会凭空造出「缩进丢了」。
 * 对不上的一律记原因（`not-matched` / `ambiguous` / `args-unparsed`），**不猜**。
 */
function tieToHunk(hunks, rawReplacedToken) {
  if (hunks === null) return { how: 'args-unparsed', hunk: null }
  if (rawReplacedToken === null) return { how: 'no-replace-token', hunk: null }
  const hits = hunks.filter((h) => tokenIsClipOf(rawReplacedToken, h?.replace))
  if (hits.length !== 1) return { how: hits.length === 0 ? 'not-matched' : 'ambiguous', hunk: null }
  const h = hits[0]
  if (typeof h.old !== 'string' || h.old.length === 0) return { how: 'no-old-key', hunk: h }
  return { how: 'recovered', hunk: h }
}

/** `verified` = 回执那份 `replaced` 确实来自调用方自己的 hunk（见 {@link tieToHunk}）。 */
const VERIFIED_TIES = new Set(['recovered', 'no-old-key'])

/** `applied[].tier` 的**层名**：去掉 `, by near` 尾巴与 `(…)` 披露段。 */
const tierKeyOf = (tier) => String(tier).split(' (')[0].split(', by near')[0].trim()

/** 命中层的族：判决只看 `norm-space-wholeline`（口径见文件头）。 */
function tierFamilyOf(tierKey) {
  if (/\bfragment\b/.test(tierKey)) return /norm-space|trim-line/.test(tierKey) ? 'norm-space-fragment' : 'fragment'
  if (/norm-space|trim-line/.test(tierKey)) return 'norm-space-wholeline'
  if (/\bsimilarity\b|\baligned\b/.test(tierKey)) return 'similarity/aligned'
  if (tierKey === 'create') return 'create'
  if (tierKey === 'old' || tierKey === 'exact' || tierKey === 'lines' || tierKey === 'symbol' || tierKey === 'lineCue' || tierKey === 'anchor') return 'verbatim'
  return 'other'
}

/** 落盘标志 / 没写盘的措辞（引擎 `renderResult` / `renderAlreadyApplied` / 干跑那三句）。 */
const WROTE_RE = /\b\d+ hunk\(s\) applied\./
const NO_WRITE_RE = /nothing was written/i

/** `isError=false` 却没写盘的那些，分个原因（只印，不进人口）。 */
function noWriteReasonOf(body) {
  if (/dry run/i.test(body)) return 'dry-run'
  if (/already_applied|already in the state/i.test(body)) return 'already-applied'
  if (NO_WRITE_RE.test(body)) return 'refused'
  return 'no-marker'
}

// ── 1. 扫描（一次一个会话文件；窗口与文件集全交给上游那份选择） ─────────────────────

/** 参数：日志里是**字符串化的 JSON**，解析不了就记 null（与上游 `argsOf` 同一条规矩）。 */
function argsOf(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

function newAgg() {
  return {
    editCalls: 0,
    editOk: 0,
    editErr: 0,
    notWritten: 0,
    noWriteReason: new Map(),
    population: 0,
    landings: 0,
    bucketLandings: new Map(),
    unobservableShape: new Map(),
    bucketCalls: new Map(),
    crossTab: new Map(), // `${bucket}|${tierFamily}|${verified}` -> n（判决从它重算）
    tierKeys: new Map(),
    oldPrefix: new Map(),
    oldRecovery: new Map(), // 仅 indent-lost：`old` 取回的结果（recovered / not-matched / …）
    tie: new Map(), // 可观测落点的 `replaced` 对回 hunk 的结果（verified / not-matched / …）
    verifiedObservable: 0,
    unverifiedObservable: 0,
    mechanism: { checked: 0, ok: 0, bad: [] },
    /** 逐条谓词数出来的判决数（与交叉表那条算路**独立**，两条必须同数）。 */
    verdictRecords: 0,
    /** 有 ≥1 个可观测落点的调用数（用来核 `unobservable` 那一桶是不是「真没有」）。 */
    callsWithObservable: 0,
    /** 人口里用 `old` 寻址的调用数（机制的机会分母），以及 `isError=false` 全体里的同一个数。 */
    callsWithOld: 0,
    callsWithOldAll: 0,
    /** indent-lost 再分两档：`replaced` 是空串（整行删掉）/ 非空但缩进变浅了。 */
    lostByDelete: 0,
    lostByDedent: 0,
    verbatimDrop: 0, // 逐字命中层上的"丢缩进"：调用方自己在 old 里引了缩进 —— 改规则也换不出不同字节
    tabPrefix: 0,
    argsUnparsed: 0,
    tierMissing: 0,
    readFailed: 0,
    examples: [],
    /** 判决集里的每一条（留样，最多 8 条）：判决数小时，这几行就是它的全部依据。 */
    verdictExamples: [],
  }
}

/**
 * 扫一个会话文件：`tool/call` 建表，`tool/result` 配对（同一 `callId` 的重复结果只算一次
 * —— 与上游 `scanSession` 的 `claimed` 规则同形，不然两侧条数对不上）。
 */
function scanFile(file, agg, opts) {
  let text
  try {
    text = decompressAll(fs.readFileSync(file))
  } catch {
    agg.readFailed += 1
    return
  }
  const session = path.basename(path.dirname(file))
  const byId = new Map()
  const claimed = new Set()
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/')) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'tool/call') {
      const name = ev.data?.name
      if (typeof name !== 'string') continue
      const callId = ev.data?.callId
      if (typeof callId === 'string') byId.set(callId, { name, args: argsOf(ev.data?.arguments) })
      continue
    }
    if (ev.type !== 'tool/result') continue
    const callId = ev.data?.message?.source?.callId
    if (typeof callId !== 'string' || claimed.has(callId)) continue
    const call = byId.get(callId)
    if (call === undefined) continue
    claimed.add(callId)
    if (call.name !== 'aura_edit') continue
    agg.editCalls += 1
    const parts = ev.data?.message?.content ?? []
    const isError = parts.some((part) => part?.isError === true)
    if (isError) {
      agg.editErr += 1
      continue
    }
    agg.editOk += 1
    const args = call.args
    const hunks = args === null || typeof args !== 'object' ? null : allHunksOf(args)
    /** 这次调用**用没用 `old`**：它是那个机制的**机会分母**（没用它，就谈不上被它咬）。 */
    const hasOld = hunks !== null && hunks.some((h) => typeof h?.old === 'string' && h.old.length > 0)
    if (hasOld) agg.callsWithOldAll += 1
    const body = receiptTextOf(parts)
    // ── 第二层：`isError=false` 里只有带落盘标志的才算"真写盘" ──
    if (!WROTE_RE.test(body) || NO_WRITE_RE.test(body)) {
      agg.notWritten += 1
      bump(agg.noWriteReason, noWriteReasonOf(body))
      continue
    }
    agg.population += 1
    if (hasOld) agg.callsWithOld += 1
    if (args === null) agg.argsUnparsed += 1

    const landings = parseApplied(body)
    const callBuckets = new Set()
    const verdictLandings = []
    let callHasObservable = false

    for (const rec of landings) {
      agg.landings += 1
      const tierKey = tierKeyOf(rec.tier)
      if (tierKey.length === 0) agg.tierMissing += 1
      const family = tierFamilyOf(tierKey)
      bump(agg.tierKeys, tierKey)
      const observable = rec.actual !== null && rec.replaced !== null
      if (observable) callHasObservable = true
      const bucket = observable ? bucketOf(rec.actual, rec.replaced) : 'unobservable'
      /** 回执那份 `replaced` 到底是不是调用方真写的那份（多 hunk 时 `planHunks` 的回执会串行）。 */
      const tie = observable ? tieToHunk(hunks, rec.rawReplaced) : { how: 'n/a', hunk: null }
      const verified = observable && VERIFIED_TIES.has(tie.how)
      if (!observable) bump(agg.unobservableShape, rec.shape)
      else {
        bump(agg.tie, tie.how)
        if (verified) agg.verifiedObservable += 1
        else agg.unverifiedObservable += 1
      }
      if (leadWs(rec.actual ?? '').includes('\t') || leadWs(rec.replaced ?? '').includes('\t')) agg.tabPrefix += 1
      bump(agg.bucketLandings, bucket)
      bump(agg.crossTab, `${bucket}|${family}|${observable ? (verified ? 'verified' : 'unverified') : 'n/a'}`)
      callBuckets.add(bucket)

      if (PREFIX_CHANGED.includes(bucket)) {
        if (family === 'verbatim' && verified) agg.verbatimDrop += 1
        if (family === 'norm-space-wholeline' && verified) {
          verdictLandings.push(rec)
          agg.verdictRecords += 1
          /** 判决内的每一条都留样 —— 判决数小的时候，这几行就是它的全部依据。 */
          if (agg.verdictExamples.length < 8) {
            agg.verdictExamples.push({
              session,
              file: typeof args?.file_path === 'string' ? args.file_path : '(多目标)',
              line: rec.line,
              tier: rec.tier,
              actual: rec.actual,
              replaced: rec.replaced,
              old: tie.how === 'recovered' ? tie.hunk.old : null,
              oldHow: tie.how,
              bucket,
            })
          }
        }
      }

      // ── indent-lost 的细分 ──
      if (bucket === 'indent-lost') {
        const rec0 = tie.how === 'recovered' ? { how: 'recovered', old: tie.hunk.old } : { how: tie.how, old: null }
        bump(agg.oldRecovery, rec0.how)
        /** 「整行删掉」与「真去缩进」不是一回事：`replaced` 是空串时行都没了，谈不上缩进被吞。 */
        if (rec.replaced === '') agg.lostByDelete += 1
        else agg.lostByDedent += 1
        const started = rec0.old === null ? `(${rec0.how})` : leadWs(rec0.old).length > 0 ? 'old 以空白开头' : 'old 不以空白开头'
        bump(agg.oldPrefix, started)
        if (rec0.how === 'recovered' && !rec.clipped) {
          agg.mechanism.checked += 1
          if (normSpace(rec0.old) === normSpace(rec.actual)) agg.mechanism.ok += 1
          else if (agg.mechanism.bad.length < 5) agg.mechanism.bad.push({ session, line: rec.line, tier: rec.tier, old: rec0.old, actual: rec.actual })
        }
        if (agg.examples.length < opts.show) {
          agg.examples.push({
            session,
            file: typeof call.args?.file_path === 'string' ? call.args.file_path : '(多目标)',
            line: rec.line,
            tier: rec.tier,
            actual: rec.actual,
            replaced: rec.replaced,
            old: rec0.old,
            oldHow: rec0.how,
            verdict: family === 'norm-space-wholeline',
          })
        }
      }
    }

    const callBucket = BUCKETS.find((b) => callBuckets.has(b)) ?? 'unobservable'
    if (callHasObservable) agg.callsWithObservable += 1
    bump(agg.bucketCalls, callBucket)
    if (verdictLandings.length > 0) agg.verdictCalls = (agg.verdictCalls ?? 0) + 1
  }
}

function scanAll(sessionsRoot, limit, cutoffMs, opts) {
  const sel = selectCorpusFiles(sessionsRoot, limit, { cutoffMs })
  /**
   * `--tail=N`：只扫选中集里 **mtime 最新的** N 个（开发用）。
   * `--sessions=N` 取的是路径序前 N 个 —— 那是最老的一批（`old` 契约之前的老会话居多），
   * 拿它开发会看不到本探针要量的那一档。两条都只是**取子集**，选择规则本身没动。
   */
  const use =
    opts.tail === null
      ? sel.use
      : [...sel.use]
          .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
          .sort((a, b) => b.m - a.m)
          .slice(0, opts.tail)
          .map((x) => x.f)
  const { files, skippedLive, writing, cutoff } = sel
  const agg = newAgg()
  agg.verdictCalls = 0
  const t0 = Date.now()
  for (const file of use) {
    try {
      agg.bytes = (agg.bytes ?? 0) + fs.statSync(file).size
    } catch {
      continue
    }
    agg.scanned = (agg.scanned ?? 0) + 1
    scanFile(file, agg, opts)
  }
  return { agg, files, use, skippedLive, writing, cutoff, ms: Date.now() - t0 }
}

// ── 2. 合成自检（分类器与回执解析器：真语料与合成件走同一条路） ─────────────────────

/** 合成回执：形状逐字照 `aura-edit/index.js` 的 `renderResult`（两条分支都造）。 */
function syntheticCases() {
  const body = (rows) => `E:\\tmp\\demo.mjs: ${rows.length} hunk(s) applied.\n${rows.join('\n')}`
  return [
    {
      name: '题面复现：old 省缩进 + replace 省缩进 ⇒ 缩进被吞',
      body: body([`  line 2 [old~norm-space] ${JSON.stringify('  return c - 3')} → ${JSON.stringify('return c - 30')}`]),
      want: ['indent-lost'],
      wantVerdict: 1,
    },
    {
      name: '原文没缩进、写回加了缩进 ⇒ 新加',
      body: body([`  line 4 [old~norm-space] ${JSON.stringify('return a')} → ${JSON.stringify('    return b')}`]),
      want: ['indent-added'],
      wantVerdict: 1,
    },
    {
      name: '两边缩进一致 ⇒ 没变',
      body: body([`  line 6 [old] ${JSON.stringify('  keep me')} → ${JSON.stringify('  keep you')}`]),
      want: ['indent-same'],
      wantVerdict: 0,
    },
    {
      name: '只印改后（多行）⇒ 不可观测',
      body: body([`  line 8 [old~norm-space] now: ${JSON.stringify('  first line')} +2 more line(s)`]),
      want: ['unobservable'],
      wantVerdict: 0,
    },
    {
      name: '逐字命中层上调用方自己丢缩进 ⇒ lost，但**不进判决**（改规则也换不出不同字节）',
      body: body([`  line 9 [old] ${JSON.stringify('    deep')} → ${JSON.stringify('deep')}`]),
      want: ['indent-lost'],
      wantVerdict: 0,
    },
  ]
}

function runSelftest() {
  const items = []
  const bucketsSeen = new Set()
  for (const c of syntheticCases()) {
    const landings = parseApplied(c.body)
    const got = landings.map((rec) => (rec.actual === null || rec.replaced === null ? 'unobservable' : bucketOf(rec.actual, rec.replaced)))
    const callBucket = BUCKETS.find((b) => got.includes(b)) ?? 'unobservable'
    bucketsSeen.add(callBucket)
    const verdict = landings.filter((rec) => {
      const b = rec.actual === null || rec.replaced === null ? 'unobservable' : bucketOf(rec.actual, rec.replaced)
      return PREFIX_CHANGED.includes(b) && tierFamilyOf(tierKeyOf(rec.tier)) === 'norm-space-wholeline'
    }).length
    items.push({
      name: `合成：${c.name}`,
      ok: landings.length === c.want.length && callBucket === c.want[0] && verdict === c.wantVerdict,
      detail: `落点 ${landings.length} 条 → 桶 ${callBucket}（期望 ${c.want[0]}）；判决计数 ${verdict}（期望 ${c.wantVerdict}）`,
    })
  }
  items.push({
    name: '合成：四类落点分进四个不同的桶（分类器没退化成一个桶）',
    ok: ['indent-lost', 'indent-added', 'indent-same', 'unobservable'].every((b) => bucketsSeen.has(b)),
    detail: `合成件落到的桶：${[...bucketsSeen].join(', ')}`,
  })
  items.push(engineReproCase())
  return items
}

/**
 * 合成自检②：**拿真引擎的 `applied[]` 过一遍分类器** —— 题面那个复现的可执行版。
 *
 * `planHunks` 是纯函数（不落盘），所以这里跑的是**仓里这一份引擎**，不是手抄的期望值：
 * 它当场答三件事 —— 缩进是不是真被吞了、`tier` 报的是不是 `old~norm-space`、
 * 分类器把这份 `actual/replaced` 判成什么。引擎改了口径（保留前缀 / 换成拒）这一条当场变红。
 */
function engineReproCase() {
  const content = 'export function gamma (c) {\n  return c - 3\n}\n'
  let bucket = '(抛错)'
  let family = '(抛错)'
  let tier = '(抛错)'
  let eaten = false
  try {
    const out = planHunks(content, [{ old: 'return c - 3', replace: 'return c - 30' }], 'demo.mjs')
    const a = out.applied[0] ?? {}
    tier = String(a.tier)
    bucket = typeof a.actual === 'string' && typeof a.replaced === 'string' ? bucketOf(a.actual, a.replaced) : 'unobservable'
    family = tierFamilyOf(tierKeyOf(tier))
    eaten = out.content === 'export function gamma (c) {\nreturn c - 30\n}\n'
  } catch (error) {
    tier = String(error?.code ?? error)
  }
  return {
    name: '合成：真引擎（planHunks）复现题面样例 ⇒ 缩进真被吞，且分类器判 indent-lost × norm-space-wholeline',
    ok: eaten && bucket === 'indent-lost' && family === 'norm-space-wholeline',
    detail: `落盘文本 ${eaten ? '缩进被吞（题面复现成立）' : '与题面不符'}；tier=${JSON.stringify(tier)} ⇒ ${family}；actual/replaced ⇒ ${bucket}`,
  }
}

// ── 3. 显示与小工具 ────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))
const padL = (s, n) => ' '.repeat(Math.max(0, n - String(s).length)) + String(s)
const pct = (a, b) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(2)}%`)
const num = (n) => Number(n ?? 0).toLocaleString('en-US')
const get = (map, k) => map.get(k) ?? 0
const sortedEntries = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
const shortText = (s, n = 48) => {
  const one = String(s).split('\n')[0]
  return one.length <= n ? JSON.stringify(one) : `${JSON.stringify(one.slice(0, n))}…`
}

function parseArgv(argv) {
  const opts = { sessions: null, tail: null, until: 0, staleMinutes: 20, show: 0, json: false, upstream: true, root: SESSIONS_ROOT }
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const k = m[1]
    const v = m[2]
    if (k === 'sessions') opts.sessions = Number(v)
    else if (k === 'tail') opts.tail = Number(v)
    else if (k === 'until') opts.until = Number.isFinite(Number(v)) ? Number(v) : Date.parse(v)
    else if (k === 'stale-minutes') opts.staleMinutes = Number(v)
    else if (k === 'show') opts.show = Number(v)
    else if (k === 'json') opts.json = true
    else if (k === 'no-upstream') opts.upstream = false
    else if (k === 'root') opts.root = v
  }
  return opts
}

// ── 4. 主流程 ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgv(process.argv.slice(2))
  if (!Number.isFinite(opts.staleMinutes) || (opts.sessions !== null && !Number.isFinite(opts.sessions)) || (opts.tail !== null && !Number.isFinite(opts.tail))) {
    console.error('用法错：--sessions / --tail / --stale-minutes 要数字')
    process.exit(2)
  }
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })

  console.log('=== 缩进吞噬普查：`old` 省掉行首空白时被整行替换吃掉的缩进，在真实会话里有多少 ===')
  console.log(`会话根：${opts.root}`)

  const t0 = Date.now()
  const until = opts.until > 0 ? opts.until : t0
  const cutoffMs = until - opts.staleMinutes * 60000
  const { agg, files, use, skippedLive, writing, ms } = scanAll(opts.root, opts.sessions, cutoffMs, opts)

  console.log('')
  console.log('── ① 语料与人口（文件集与时间窗来自 success-regression.mjs 的 selectCorpusFiles）──')
  console.log(`会话文件：${num(agg.scanned)}/${num(files.length)} 个（截取前口径），${((agg.bytes ?? 0) / 1048576).toFixed(1)} MB，用时 ${(ms / 1000).toFixed(1)}s`)
  console.log(
    skippedLive.length > 0
      ? `排除「正在写日志的那个会话」${skippedLive.length} 个：${skippedLive.map((f) => path.basename(path.dirname(f))).join(', ')}（它还在写，会让分母随本探针自己的运行而变）`
      : '未排除任何会话（环境里没有 DSH_SESSION_ID，或它的目录还没落盘）',
  )
  console.log(
    `时间窗：mtime ≤ ${new Date(cutoffMs).toISOString()}（--until=${new Date(until).toISOString()} --stale-minutes=${opts.staleMinutes}）；` +
      `因「最近 ${opts.staleMinutes} 分钟内还在写」排除 ${writing.length} 个会话文件`,
  )
  if (use.length !== files.length) {
    console.log(`  （${opts.tail === null ? `--sessions=${opts.sessions}：只扫了前 ${use.length} 个文件` : `--tail=${opts.tail}：只扫了后 ${use.length} 个文件`}）`)
  }
  if (agg.readFailed > 0) console.log(`  读失败 ${agg.readFailed} 个会话文件（已跳过）`)

  // ── 上游口径对账：同一批文件、同一个窗口，另一份解析器数一遍 ──
  let up = null
  if (opts.upstream) {
    const ut0 = Date.now()
    up = tallyCorpusEdits(opts.root, opts.sessions, { cutoffMs })
    console.log(
      `上游口径（success-regression.mjs 的解析器，同一批文件同一窗口）：aura_edit ${num(up.editCalls)} 次` +
        `（成功 ${num(up.editOk)} / 失败 ${num(up.editErr)}）、扫了 ${num(up.scanned)}/${num(up.sessionFiles)} 个文件，用时 ${((Date.now() - ut0) / 1000).toFixed(1)}s`,
    )
  }
  console.log(`aura_edit 结果事件（本探针）：${num(agg.editCalls)} 次（isError=false ${num(agg.editOk)} / isError=true ${num(agg.editErr)}）`)
  console.log(
    `isError=false 但回执**不给落盘标志**的：${num(agg.notWritten)} 条 —— ` +
      sortedEntries(agg.noWriteReason)
        .map(([k, v]) => `${k} ${v}`)
        .join(' / ') +
      '（干跑 / 已落地 / 如实拒绝：一个字节都没写，不进人口）',
  )
  console.log(`**人口 = 真写盘的 aura_edit 调用：${num(agg.population)} 条**（= isError=false ${num(agg.editOk)} − 没写盘 ${num(agg.notWritten)}；占 isError=false 的 ${pct(agg.population, agg.editOk)}）`)
  if (agg.argsUnparsed > 0) console.log(`  其中参数解析不了（\`old\` 无从回查）的调用：${num(agg.argsUnparsed)} 条`)
  console.log(
    `  **机会分母**：全语料用 \`old\` 寻址的调用 ${num(agg.callsWithOldAll)} 条（占 isError=false 的 ${pct(agg.callsWithOldAll, agg.editOk)}）` +
      `，其中真写盘的 ${num(agg.callsWithOld)} 条 —— 其余 ${num(agg.callsWithOldAll - agg.callsWithOld)} 条一个字节都没写，谈不上缩进被吞`,
  )

  // ── 分类 ──
  console.log('')
  console.log('── ② 分类 ──')
  const unobsLandings = get(agg.bucketLandings, 'unobservable')
  const observableLandings = agg.landings - unobsLandings
  console.log(
    `落点（回执报出来的 applied 行）：${num(agg.landings)} 条 —— 可观测 ${num(observableLandings)}` +
      `（其中回执那份 \`replaced\` 能对上调用方 hunk 的 ${num(agg.verifiedObservable)} / 对不上的 ${num(agg.unverifiedObservable)}）/ 不可观测 ${num(unobsLandings)}`,
  )
  console.log(`  不可观测的原因：${sortedEntries(agg.unobservableShape).map(([k, v]) => `${k} ${v}`).join(' / ') || '(无)'}`)
  console.log(`  可观测落点的 \`replaced\` 对回 hunk 的结果：${sortedEntries(agg.tie).map(([k, v]) => `${k} ${v}`).join(' / ') || '(无)'}`)
  console.log('  落点级：')
  for (const b of BUCKETS) console.log(`    ${pad(b, 16)} ${padL(num(get(agg.bucketLandings, b)), 6)}  ${pct(get(agg.bucketLandings, b), agg.landings)}`)
  console.log('  调用级（= 人口单位；优先级 lost > added > other > same > unobservable）：')
  for (const b of BUCKETS) console.log(`    ${pad(b, 16)} ${padL(num(get(agg.bucketCalls, b)), 6)}  ${pct(get(agg.bucketCalls, b), agg.population)}`)

  // ── indent-lost 细分 ──
  console.log('')
  console.log('── ③ indent-lost 的细分（落点级）──')
  const lostRows = new Map()
  for (const row of crossTabRows(agg)) {
    if (row.bucket !== 'indent-lost') continue
    lostRows.set(row.family, (lostRows.get(row.family) ?? 0) + row.n)
  }
  console.log(`  按命中层族：${sortedEntries(lostRows).map(([k, v]) => `${k} ${v}`).join(' / ') || '(无)'}`)
  console.log(`  按命中层名：${sortedEntries(agg.tierKeys).map(([k, v]) => `${k} ${v}`).join(' / ') || '(无)'}`)
  console.log(`  按调用方的 \`old\`：${sortedEntries(agg.oldPrefix).map(([k, v]) => `${k} ${v}`).join(' / ') || '(无)'}`)
  console.log(`  \`old\` 回查结果：${sortedEntries(agg.oldRecovery).map(([k, v]) => `${k} ${v}`).join(' / ') || '(无)'}`)
  console.log(
    `  机制核对（\`old\` 取回且未截断）：${num(agg.mechanism.ok)}/${num(agg.mechanism.checked)} 条满足 normSpace(old) === normSpace(actual)` +
      (agg.mechanism.bad.length > 0 ? `；反例：${agg.mechanism.bad.map((b) => `${b.tier} old=${shortText(b.old, 24)} actual=${shortText(b.actual, 24)}`).join(' | ')}` : ''),
  )
  console.log(
    `  indent-lost 再分两档：\`replaced\` 是空串（**整行删掉**，行都没了谈不上缩进被吞）${num(agg.lostByDelete)} 条 / 非空但缩进变浅（**真去缩进**）${num(agg.lostByDedent)} 条`,
  )
  console.log(`  旁证：带制表符的行首空白 ${num(agg.tabPrefix)} 条（"更短"按字符数判，制表符不折算视觉宽度）`)
  console.log(`  另计：**逐字命中层**（exact/lines/symbol/old）上调用方自己丢缩进 ${num(agg.verbatimDrop)} 条 —— 调用方在 \`old\` 里引用了缩进，改规则也换不出不同字节`)

  if (opts.show > 0 && agg.examples.length > 0) {
    console.log('')
    console.log(`── ③b indent-lost 样例（前 ${agg.examples.length} 条）──`)
    for (const e of agg.examples) {
      console.log(`    ${e.session}  ${shortText(e.file, 56)}`)
      console.log(
        `      line ${e.line} [${e.tier}]${e.verdict ? ' ★判决内' : ''} ${shortText(e.actual, 40)} → ${shortText(e.replaced, 40)}` +
          `  old=${e.old === null ? `(取不回：${e.oldHow})` : shortText(e.old, 40)}`,
      )
    }
  }

  // ── 判决 ──
  const verdictRows = crossTabRows(agg)
  /** 判决集 = 前缀变了 × 空白折叠整行层 × **`verified`**（回执那份 `replaced` 确实是调用方写的）。 */
  const isVerdictRow = (r) => PREFIX_CHANGED.includes(r.bucket) && r.family === 'norm-space-wholeline' && r.trust === 'verified'
  const verdictLandingN = verdictRows.filter(isVerdictRow).reduce((a, r) => a + r.n, 0)
  const verdictCallN = agg.verdictCalls
  /** 敏感性：不受 `verified` 限制的同层计数（回执可能串行，所以只会更大）。 */
  const verdictAsReportedN = verdictRows
    .filter((r) => PREFIX_CHANGED.includes(r.bucket) && r.family === 'norm-space-wholeline')
    .reduce((a, r) => a + r.n, 0)
  const sensitivityN = verdictRows
    .filter((r) => PREFIX_CHANGED.includes(r.bucket) && r.family !== 'verbatim' && r.family !== 'create' && r.trust === 'verified')
    .reduce((a, r) => a + r.n, 0)

  console.log('')
  console.log('── ④ 判决：改成「保留行首前缀」或「直接拒」，会写出不同字节的编辑有多少 ──')
  console.log(
    `  判据口径 = 空白折叠 + **整行对齐**层（层名含 norm-space/trim-line 且不含 fragment）+ 行首空白变了 + \`replaced\` 能对回调用方的 hunk：` +
      `**${num(verdictLandingN)} 个落点 / ${num(verdictCallN)} 条调用 = 人口的 ${pct(verdictCallN, agg.population)}**（落点占 ${pct(verdictLandingN, agg.landings)}）`,
  )
  console.log(`  （同层但不要求 \`replaced\` 能对回 hunk：${num(verdictAsReportedN)} 个落点；把任何降级层都算进来：${num(sensitivityN)} 个落点 —— 两个都只印不判）`)
  console.log(`  前缀变了但不在判决内的：逐字命中层 ${num(agg.verbatimDrop)} 条（调用方自己在 \`old\`/\`anchor\` 里引了缩进又没写回，改规则也换不出不同字节）`)
  if (agg.verdictExamples.length > 0) {
    console.log('  判决内的每一条（全量列出）：')
    for (const e of agg.verdictExamples) {
      console.log(`    ${pad(e.bucket, 13)} ${e.session}  ${shortText(e.file, 48)}`)
      console.log(
        `      line ${e.line} [${e.tier}] ${shortText(e.actual, 36)} → ${shortText(e.replaced, 36)}` +
          `  old=${e.old === null ? `(取不回：${e.oldHow})` : shortText(e.old, 36)}`,
      )
    }
  }

  // ── 判据 ──
  console.log('')
  console.log('── 判据 ──')
  check('人口非空', agg.population > 0, `人口 ${num(agg.population)} 条（isError=false ${num(agg.editOk)}）`)
  check(
    '人口 = isError=false − 无落盘标志（逐条可复算）',
    agg.population + agg.notWritten === agg.editOk && agg.editOk + agg.editErr === agg.editCalls,
    `${num(agg.population)} + ${num(agg.notWritten)} = ${num(agg.editOk)}；${num(agg.editOk)} + ${num(agg.editErr)} = ${num(agg.editCalls)}`,
  )
  if (up !== null) {
    check(
      '上游口径对账：同一批文件、同一窗口，五项逐一相等',
      up.editCalls === agg.editCalls && up.editOk === agg.editOk && up.editErr === agg.editErr && up.scanned === agg.scanned && up.sessionFiles === files.length,
      `editCalls ${num(up.editCalls)}=${num(agg.editCalls)} / editOk ${num(up.editOk)}=${num(agg.editOk)} / editErr ${num(up.editErr)}=${num(agg.editErr)} / scanned ${num(up.scanned)}=${num(agg.scanned)} / sessionFiles ${num(up.sessionFiles)}=${num(files.length)}`,
    )
  } else {
    check('上游口径对账（--no-upstream 跳过了）', true, '跳过：本次没有第二份读数可对')
  }
  const landingSum = BUCKETS.reduce((a, b) => a + get(agg.bucketLandings, b), 0)
  check('落点级：每个落点恰好进一个桶（桶之和 = 落点总数）', landingSum === agg.landings, `${num(landingSum)} = ${num(agg.landings)}`)
  const callSum = BUCKETS.reduce((a, b) => a + get(agg.bucketCalls, b), 0)
  check('调用级：每个人口调用恰好进一个桶（桶之和 = 人口）', callSum === agg.population, `${num(callSum)} = ${num(agg.population)}`)
  const crossRows = crossTabRows(agg)
  const crossLandingSum = crossRows.reduce((a, r) => a + r.n, 0)
  const crossBucketSum = new Map()
  for (const r of crossRows) crossBucketSum.set(r.bucket, (crossBucketSum.get(r.bucket) ?? 0) + r.n)
  check(
    '交叉表「桶 × 命中层 × 可核性」逐格自洽：行和 = 落点级桶、总和 = 落点总数',
    crossLandingSum === agg.landings && BUCKETS.every((b) => get(crossBucketSum, b) === get(agg.bucketLandings, b)),
    `总 ${num(crossLandingSum)} = ${num(agg.landings)}；${BUCKETS.map((b) => `${b} ${num(get(crossBucketSum, b))}=${num(get(agg.bucketLandings, b))}`).join(' / ')}`,
  )
  check(
    '可核性记账：verified + unverified = 可观测落点（合起来 + 不可观测 = 落点总数）',
    agg.verifiedObservable + agg.unverifiedObservable === observableLandings && observableLandings + unobsLandings === agg.landings,
    `${num(agg.verifiedObservable)} + ${num(agg.unverifiedObservable)} = ${num(observableLandings)}；+ ${num(unobsLandings)} = ${num(agg.landings)}`,
  )
  check(
    '判决数由「桶 × 命中层 × 可核性」交叉表重算，且与逐条谓词数出来的同数',
    verdictLandingN === agg.verdictRecords,
    `交叉表重算 ${num(verdictLandingN)} = 逐条谓词 ${num(agg.verdictRecords)}；→ ${num(verdictCallN)} 条调用`,
  )
  check(
    '判决集单调：它 ⊆ 「同层但不要求可核」的计数，且 ⊆ 「任何降级层」的计数',
    verdictLandingN <= verdictAsReportedN && verdictLandingN <= sensitivityN,
    `判决 ${num(verdictLandingN)} ≤ 同层 ${num(verdictAsReportedN)}；判决 ${num(verdictLandingN)} ≤ 任何降级层 ${num(sensitivityN)}`,
  )
  check(
    '调用级结构：进 unobservable 桶的调用数 = 人口 − 有可观测落点的调用数',
    get(agg.bucketCalls, 'unobservable') === agg.population - agg.callsWithObservable,
    `${num(get(agg.bucketCalls, 'unobservable'))} = ${num(agg.population)} − ${num(agg.callsWithObservable)}`,
  )
  check(
    '机制核对：可核的 indent-lost 落点里 normSpace(old) === normSpace(actual) 恒成立',
    agg.mechanism.checked > 0 ? agg.mechanism.ok === agg.mechanism.checked : true,
    agg.mechanism.checked === 0
      ? '0/0 —— **本次一条都没核上**（语料里 `old` 几乎没被用，见上面「机会分母」）：这一格绿不等于核过，要读那个分母'
      : `${num(agg.mechanism.ok)}/${num(agg.mechanism.checked)}（未截断且 old 取回的那些）`,
  )
  check(
    'indent-lost 的两档之和 = 该桶（整行删除 / 真去缩进，逐条可复算）',
    agg.lostByDelete + agg.lostByDedent === get(agg.bucketLandings, 'indent-lost'),
    `${num(agg.lostByDelete)} + ${num(agg.lostByDedent)} = ${num(get(agg.bucketLandings, 'indent-lost'))}`,
  )
  check('每条落点都带非空 tier（回执形状没变）', agg.tierMissing === 0, `tier 为空的落点 ${num(agg.tierMissing)} 条`)
  for (const item of runSelftest()) check(item.name, item.ok, item.detail)

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`)
  console.log(`\n--- ${checks.length - failed.length}/${checks.length} 通过 ---`)

  if (opts.json) {
    console.log('')
    console.log('---JSON---')
    console.log(
      JSON.stringify(
        {
          window: { until: new Date(until).toISOString(), cutoff: new Date(cutoffMs).toISOString(), staleMinutes: opts.staleMinutes, sessionsRoot: opts.root },
          corpus: { sessionFiles: files.length, scanned: agg.scanned, bytes: agg.bytes ?? 0, readFailed: agg.readFailed },
          upstream: up === null ? null : { editCalls: up.editCalls, editOk: up.editOk, editErr: up.editErr, scanned: up.scanned, sessionFiles: up.sessionFiles },
          editCalls: agg.editCalls,
          editOk: agg.editOk,
          editErr: agg.editErr,
          notWritten: agg.notWritten,
          callsWithOldAll: agg.callsWithOldAll,
          callsWithOld: agg.callsWithOld,
          lostByDelete: agg.lostByDelete,
          lostByDedent: agg.lostByDedent,
          noWriteReason: Object.fromEntries(agg.noWriteReason),
          population: agg.population,
          landings: agg.landings,
          bucketsLandings: Object.fromEntries(BUCKETS.map((b) => [b, get(agg.bucketLandings, b)])),
          bucketsCalls: Object.fromEntries(BUCKETS.map((b) => [b, get(agg.bucketCalls, b)])),
          unobservableShape: Object.fromEntries(agg.unobservableShape),
          observableLandings,
          verifiedObservable: agg.verifiedObservable,
          unverifiedObservable: agg.unverifiedObservable,
          tie: Object.fromEntries(sortedEntries(agg.tie)),
          crossTab: Object.fromEntries(crossRows.map((r) => [`${r.bucket}|${r.family}|${r.trust}`, r.n])),
          tierKeys: Object.fromEntries(sortedEntries(agg.tierKeys)),
          oldPrefix: Object.fromEntries(agg.oldPrefix),
          oldRecovery: Object.fromEntries(agg.oldRecovery),
          mechanism: { checked: agg.mechanism.checked, ok: agg.mechanism.ok },
          verbatimDrop: agg.verbatimDrop,
          verdict: {
            landings: verdictLandingN,
            calls: verdictCallN,
            population: agg.population,
            asReportedLandings: verdictAsReportedN,
            sensitivityLandings: sensitivityN,
          },
          checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
          ms: Date.now() - t0,
        },
        null,
        1,
      ),
    )
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

/** 交叉表 → `{ bucket, family, trust, n }[]`（三个维度从 key 里拆回来）。 */
function crossTabRows(agg) {
  return [...agg.crossTab.entries()].map(([key, n]) => {
    const [bucket, family, trust] = key.split('|')
    return { bucket, family, trust, n }
  })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) main()
