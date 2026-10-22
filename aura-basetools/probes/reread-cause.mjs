/**
 * reread-cause.mjs —— 同一会话里同一个文件为什么被反复读？模型在找什么？
 *
 * ## 它从哪来
 *
 * 历史读数说：`aura_read` 里 **63.8%** 是同一会话内对**已读文件**的重复读。
 * 已经做了同会话增量读（第二次读只回差量，6829 → 766 字符），但**重复读这个行为本身没变**。
 * 这句话把问题拆成了两半，而它们要的改法完全不同：
 *
 *   · 如果重复读是因为「第一次回的东西不是模型要的」——增量读只是把浪费变小，没消除它；
 *     该改的是**第一次的取景**（一次给够），不是第二次的传输量。
 *   · 如果重复读是因为「模型自己不记得读过」——那才轮到去重/记忆这一层。
 *
 * 所以要量的不是"重复了多少次"，而是**每次重复读要的那一段，是不是本会话此前已经给过的**。
 *
 * ## 判据（全部可从会话日志直接读出，不猜）
 *
 * 对每个会话、每个文件，按**调用顺序**取它的读操作，维护一个"**此前真正交付过**的行区间并集"
 * （`g.seenLines`，取每次读的**交付区间**；交付行号测不出时才退回请求区间，实测这种情况 0.2%）：
 *
 *   · 首次读         = 本会话对该文件的第 1 次成功读
 *   · 重复读         = 之后每一次成功读（与历史 63.8% 同口径：[tool,path] 二元组已出现过）
 *   · 重叠率 r       = |本次请求 ∩ 已交付并集| / |本次请求|   ← 进 ① 的分布
 *   · 完全重叠 r=1   = 这次要的东西此前**逐行都给过**
 *   · 全新区间 r=0   = 这次要的东西此前一行都没给过
 *
 * **为什么分母是"已交付"而不是"已请求"**：模型手里能用的只有工具真给过的行。
 * 一次 `lines=[1,321]` 被预算截到 1..166 之后，模型手上没有 167..321；
 * 拿"已请求"当分母会把"再要一次那 155 行"算成浪费，而它其实是上次没给够。
 * 两个口径都给：`【全走请求侧】`是"已请求并集"口径；`【第二本账】`只认参数里写出来的区间，
 * 不碰任何回执解析，可以脱离本探针独立复算。
 *
 * **交付区间从哪来**：从回执正文的行号前缀数最长连续段（`start`/`end` 都在里面），
 * **不用 `omitted:` 推**——那个字段的起点是"这次请求里第一行没给的"，不是"最后交付行+1"
 * （`mode=lines lines=[145,283]` 被截断时它照样写 `omitted: lines 145-283`；两个实例见 `deliveredOf`）。
 *
 * **行号语义出处**（不是猜的）：
 *   · `aura_read` 只吃 `lines` / `start_line`+`end_line` / `mode=full|map|digest|changed|search|around`
 *     （见 `src/aura-read/index.js` 的 `READ_ARG_KEYS`，**没有** limit/offset）；
 *   · 内置 `read` 吃 `offset`+`limit`（省略 offset=1、省略 limit=2000，从回执 `Showing lines a-b of N` 反推 N）；
 *   · `[full file]` / `[requested range]` / `omitted: lines a-b` / `next: mode=lines lines=[a,b]`
 *     是 `src/locator-lab/read-core.mjs` 里的固定标记，回执里逐字可见；
 *   · 增量读回执（`... unchanged line(s) withheld — byte-identical to baseline`）**没给行号**，
 *     它省掉的行就在基线读的区间里——所以请求区间取"基线那次要的"，正好是模型手里的东西。
 *
 * ## 三个问题对应三段输出
 *
 *   ① 重叠率分布：完全重叠 / 部分重叠 / 全新区间各占多少，再按"中间有没有写过"拆开
 *   ② 完全重叠那一批：前 1-3 次调用是什么工具、是不是刚写过/刚失败过
 *   ③ 全新区间那一批：是不是顺着文件往下扫（区间单调递进）
 *   ④ 一句可核的结论 + 交付覆盖（上次是不是没给够）
 *
 * ## 用法
 *
 *   node aura-tools/probes/reread-cause.mjs                 # 全量扫描 + 报告
 *   node aura-tools/probes/reread-cause.mjs --json out.jsonl  # 另存逐次重复读证据（供独立复算）
 *   node aura-tools/probes/reread-cause.mjs --session <子串>   # 只扫匹配的会话
 *   node aura-tools/probes/reread-cause.mjs --root <目录>      # 指定会话根（默认 ~/.dsh/sessions）
 *   node aura-tools/probes/reread-cause.mjs --split-at=2026-10-01T00:00:00Z   # 按时刻切两窗，做部署前后对照（R5-B）
 *
 * ## 退出码（C48 接线：判据只增不减）
 *
 *   R5-B2 的守恒自检从前只**打印**（`main()` 自然结束 ⇒ 恒 exit 0），于是「守恒」与
 *   「守恒被破」两种结局在退出码上完全同形 —— 读数能不能信这唯一一道闸门，问不出来。C48 接上：
 *
 *     · `--split-at` ⇒ 守恒自检不符 ⇒ 退出码 1，并在末行**点名是哪几项**（逐项带差值）；
 *       屏幕上的 ⚠ 与进程的退出码从此是同一件事。
 *     · 不带 `--split-at` ⇒ 退出码仍是 0，stdout / `--json` 产物逐字节不变（切窗那段不执行，
 *       守恒自检根本不在场，本次不判）。
 *
 *   两条早退分支（`no session logs under …` / `没有量到任何重复读。`）本来就是 exit 0，没动：
 *   它们说的是「本次没有读数可判」，不是「判过且通过」。
 *
 * 与 `session-log.mjs` 同源（同一批 `session.v3.jsonl.zstd`），但**不共用**它的解析：
 * 那一层丢掉了调用顺序里的 `time`/`seq`、也丢掉了 `tool/call` 与 `tool/result` 的配对关系，
 * 而"上一次调用是什么"正是本探针要量的东西。解压那一段照抄 `tmp/session-log-scan/zstd-read.mjs`
 * 与 `session-log.mjs` 的做法（按 magic 28 B5 2F FD 切帧逐帧解），没有第三份实现。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const SKIP_BASE = 0x184d2a50
const SESSION_FILE = 'session.v3.jsonl.zstd'

/** 读工具。两个都算：历史 63.8% 那句话说的是 aura_read，但内置 read 是同一件事的另一半。 */
const READ_TOOLS = /^(aura_read|read)$/
/** 写工具。判"白读"要看两次读之间有没有落过笔。 */
const WRITE_TOOLS = /^(aura_edit|edit|write|patch)$/
/** 完全重叠的判定阈值。99.9% 而不是 100%：区间长度是整数，浮点只在这里出错。 */
const FULL = 0.999
/** 全新区间的判定阈值：一点都没碰过。 */
const NONE = 0.001
/** 扫掠判定里，两次读之间允许多大的跳跃还算"顺着往下扫"。 */
const SWEEP_MAX_GAP = 200
/** 扫掠至少要有几段才算"在遍历"（两段太常见，不构成形态）。 */
const SWEEP_MIN_RUN = 3
/** 增量读回执的指纹（`read-core.mjs` 里的固定措辞）。 */
const DELTA_MARK = /unchanged line\(s\) withheld|byte-identical to baseline/

/* ------------------------------------------------------------------ 解压 */

/**
 * 逐帧解压。会话日志是 zstd **多帧流**，整体解压只能拿到会话头，所以必须按 magic 切。
 * 坏帧忽略（日志尾部可能是半帧）——与 `session-log.mjs` 同一处置。
 */
export function decompressAll(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  // 有些帧之间有 skippable frame（magic 0x184d2a5?），它没有 zstd 头，直接跳过
  for (let k = 0; k + 8 <= buf.length; k += 1) {
    if ((buf.readUInt32LE(k) & 0xfffffff0) === SKIP_BASE) break
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k]
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      /* 坏帧忽略 */
    }
  }
  return text
}

function* sessionFiles(dir, depth = 0) {
  if (depth > 5) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sessionFiles(full, depth + 1)
    else if (entry.name === SESSION_FILE) yield full
  }
}

/* ------------------------------------------------------- 参数与文件的规范化 */

/** 日志里参数是**字符串化的 JSON**；解析不了就记 null（不猜）。 */
function argsOf(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 区间规范化：接受 `[a,b]` / `"a,b"` / 单个数 / `{start,end}`——声明面就这么宽。 */
function asPair(v) {
  if (Array.isArray(v) && v.length >= 2 && v.slice(0, 2).every(Number.isFinite)) {
    return [Number(v[0]), Number(v[1])]
  }
  if (typeof v === 'string') {
    const m = v.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/)
    if (m !== null) return [Number(m[1]), Number(m[2])]
  }
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v]
  if (v !== null && typeof v === 'object') {
    const a = v.start ?? v.start_line ?? v.from
    const b = v.end ?? v.end_line ?? v.to
    if (Number.isFinite(a) && Number.isFinite(b)) return [Number(a), Number(b)]
  }
  return null
}

function normPair(p) {
  if (p === null) return null
  const a = Math.max(1, Math.min(p[0], p[1]))
  const b = Math.max(1, Math.max(p[0], p[1]))
  return [a, b]
}

/** 路径规范化：相对路径按会话 cwd 展开，小写化（Windows 不区分大小写），去掉 `.`/`..` 与尾斜杠。 */
function normPath(file, cwd) {
  if (typeof file !== 'string' || file.length === 0) return null
  let s = file.replace(/\//g, '\\')
  const isAbs = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\')
  if (!isAbs) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    s = `${cwd.replace(/[\\/]+$/, '')}\\${s}`
  }
  const out = []
  for (const seg of s.split('\\')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('\\').toLowerCase()
}

/* --------------------------------------------------------------- 区间代数 */

/** `[[s,e]…]` → 规范化（升序、去退化、合并相邻/重叠）。 */
function mergeRanges(rs) {
  const good = rs.filter((r) => Array.isArray(r) && r[0] <= r[1]).sort((a, b) => a[0] - b[0])
  const out = []
  for (const r of good) {
    const last = out[out.length - 1]
    if (last !== undefined && r[0] <= last[1] + 1) {
      if (r[1] > last[1]) last[1] = r[1]
    } else out.push([r[0], r[1]])
  }
  return out
}

/** 求并：把 `add` 并进已合并的 `set`，返回新数组（不改入参）。 */
function unionInto(set, add) {
  return mergeRanges([...set, ...add])
}

function lenOf(rs) {
  let n = 0
  for (const r of rs) n += r[1] - r[0] + 1
  return n
}

function capRanges(rs, cap) {
  return rs.map((r) => [r[0], cap === null ? r[1] : Math.min(r[1], cap)]).filter((r) => r[0] <= r[1])
}

/** 与集合的交集总长（集合已规范化、升序、互不相交）。 */
function intersectLen(set, iv) {
  let n = 0
  for (const r of set) {
    if (r[1] < iv[0]) continue
    if (r[0] > iv[1]) break
    n += Math.min(r[1], iv[1]) - Math.max(r[0], iv[0]) + 1
  }
  return n
}

/**
 * 回执里"这次给到哪一段"的三种标记。
 *
 * ⚠️ `omitted: lines a-b` 的 `a` **不是**"最后交付行+1"，而是"这次请求里第一行没给的"。
 * 实测两例：
 *   `mode=lines lines=[145,283]`（请求 145-283）→ `omitted: lines 145-283`，正文给的是 145..283（整个请求）；
 *   `mode=lines lines=[1,321]`（请求 1-321）→ `omitted: lines 167-321`，正文给的是 1..166。
 * 所以交付区间只能从正文行号前缀里数出来（见下）；`omitted` 只说明"被预算截断了"与文件总行数。
 */
const OMIT_BUDGET = /omitted: lines (\d+)-(\d+) \(content budget/
const OMIT_PAST_END = /omitted: requested to (\d+), file ends at (\d+)/
const OMIT_PAST_END_ALT = /omitted: requested to line (\d+), file ends at (\d+)/
const SHOWING = /Showing lines (\d+)-(\d+) of (\d+)/
const NEXT_LINES = /next: mode=lines lines=\[(\d+),(\d+)\]/
const TAIL_FULL = '[full file]'
const TAIL_RANGE = '[requested range]'
/** 回执"说到头了"的收尾标记。有它 ⇒ 正文完整；没有 ⇒ 正文被工具层截断，只到截断处为止。 */
const END_MARK = /\[full file\]|\[requested range\]|\(End of file - total \d+ lines\)|\(Showing lines \d+-\d+ of \d+\)|No matches found/
/** 正文行号前缀（`145: ...`）。行本身可以以任何东西开头，前缀只认行首。 */
const PREFIX = /^(\d+): /

/* --------------------------------------------------- 回执 → 交付区间（取行号） */

/**
 * 从回执正文里取**实际交付**的行区间 `[start, end]`。
 *
 * 取法：扫正文的 `N: ` 行号前缀，取**最长的一段连续递增**。
 *   · `start` = 那一段的第一个行号（窗口读时是 145，不是 1——第一版把它写成 1，
 *     于是每一次窗口重读都被算成"从第 1 行起"，重叠率全错）；
 *   · `end`   = 那一段的最后一个行号，与 `omitted` / `next` / `Showing … of N` 里的
 *     总数取一致（有收尾标记时以标记为准，因为那是工具自己说的）。
 *
 * `complete` 表示回执带收尾标记（正文没被工具层截断）。带 `omitted:` 的回执是"完整但内容被
 * 预算砍过"，也算 `complete`——这两个概念不能混：前者是传输截断，后者是取景截断。
 */
export function deliveredOf(text) {
  const out = { start: null, end: null, total: null, run: 0, complete: false, delta: false }
  if (typeof text !== 'string' || text.length === 0) return out
  out.delta = DELTA_MARK.test(text)
  out.complete = END_MARK.test(text) || OMIT_BUDGET.test(text) || OMIT_PAST_END.test(text) || OMIT_PAST_END_ALT.test(text)

  let m = text.match(OMIT_BUDGET)
  if (m !== null) out.total = Number(m[2])
  m = text.match(OMIT_PAST_END) ?? text.match(OMIT_PAST_END_ALT)
  if (m !== null) out.total = Number(m[2])
  m = text.match(SHOWING)
  if (m !== null) {
    out.start = Number(m[1])
    out.end = Number(m[2])
    out.total = Number(m[3])
  }
  if (out.total === null && text.includes(TAIL_FULL) && out.end === null) {
    // `[full file]` 且没有 omitted ⇒ 整份文件都在正文里，最后一行号就是总数（下面数出来）
    out.fullFlag = true
  }

  // 正文行号前缀：取最长连续段。只扫前 400 行——回执可能几万字符，全扫不值得，
  // 而"从哪一行开始"只取决于开头。
  let runStart = null
  let runEnd = null
  let runLen = 0
  let prev = null
  for (const line of text.split('\n', 400)) {
    const mm = line.match(PREFIX)
    if (mm === null) continue
    const n = Number(mm[1])
    if (prev !== null && n === prev + 1) {
      runEnd = n
      runLen += 1
    } else {
      runStart = n
      runEnd = n
      runLen = 1
    }
    prev = n
  }
  if (runStart !== null) {
    out.run = runLen
    if (out.start === null) out.start = runStart
    if (out.end === null) out.end = runEnd
  }
  if (out.fullFlag === true && out.total === null && out.end !== null) out.total = out.end
  if (out.start !== null && out.end !== null && out.end < out.start) out.end = out.start
  return out
}

/**
 * 一次读的**请求区间**（模型的选择）+ **交付区间**（工具真给了哪一段）。
 *
 * `req` 是模型说的"我要这段"；`deliv` 是回执证明的"我给到这一行"。
 * 两者必须分开记：重叠率是拿 `req` 去比历史（"模型是不是又点了一遍已经点过的位置"），
 * 而"上次没给够"是拿 `deliv ÷ req` 算的。混成一个数就分不清是谁的问题。
 *
 * `cover` 是**计算重叠率时该拿哪个区间**：`req` 与 `deliv` 都是区间时优先 `deliv`
 * ——交付过的行才是模型真拿到手的行。交付区间是从回执正文里数出来的，
 * 在两种情形下会**窄于**请求：(a) 内容预算截断，(b) 读的范围被工具层裁剪。
 * 只有 `req` 时才退回 `req`。
 *
 * 交不出区间的（参数缺失、回执里没有行号、`mode=lines` 没给区间）返回 `req: null`，
 * 由调用方单独计数——**不塞进分布里充数**。
 *
 * @returns `{ req, deliv, cover, why }`；`deliv.end` 是交付到的最后一行行号。
 */
export function requestedOf(name, args, text) {
  const del = deliveredOf(text)
  const deliv = del.start === null || del.end === null ? null : [del.start, del.end]
  let req = null
  let why = ''
  let whole = false
  /**
   * `explicit` = 这次的区间是**模型在参数里写出来的**，不是为了补全而从回执反推的。
   * 它决定这次读能不能进"只靠参数就能复算"的那一本账（见 `byBucketExp`）——
   * 那一本账不依赖任何回执解析，是给独立复算用的最小假设口径。
   */
  let explicit = false
  if (name === 'read') {
    // 内置 read：offset/limit 语义从回执反推（省略 offset=1、省略 limit=2000）
    const ex = asPair([args?.start_line, args?.end_line])
    const hasOffset = Number.isFinite(args?.offset)
    const hasLimit = Number.isFinite(args?.limit)
    if (ex !== null && Number.isFinite(args?.start_line)) {
      req = normPair(ex)
      why = 'read:explicit-range'
      explicit = true
    } else if (!hasOffset && !hasLimit) {
      // 只给 file_path = "把整个文件给我"。文件多长**不知道**（回执被字符上限砍掉，
      // `(End of file - total N lines)` 常常不在），所以请求只能记成"全文"，
      // 重叠率按交付算——并标 `whole=true`，让分类口径显式走交付侧。
      req = del.total !== null ? [1, del.total] : deliv ?? [1, 2000]
      whole = true
      why = 'read:whole-file'
    } else {
      const off = hasOffset ? Number(args.offset) : 1
      const lim = hasLimit ? Number(args.limit) : 2000
      let end = off + lim - 1
      if (del.total !== null) end = Math.min(end, del.total)
      req = [off, end]
      why = 'read:offset+limit'
      explicit = true
    }
  } else {
    const ls = asPair(args?.lines)
    const mode = typeof args?.mode === 'string' ? args.mode : null
    if (ls !== null) {
      req = normPair(ls)
      why = 'lines'
      explicit = true
    } else if (Number.isFinite(args?.start_line)) {
      const a = Math.max(1, Number(args.start_line))
      const b = Number.isFinite(args?.end_line) ? Math.max(a, Number(args.end_line)) : a
      req = [a, b]
      why = 'start_line+end_line'
      explicit = true
    } else if (mode === 'full') {
      // full 的请求就是整个文件；文件多长由回执告诉我们（omitted/Showing 会给总数）
      if (del.total !== null) {
        req = [1, del.total]
        why = 'full'
      } else if (del.end !== null) {
        req = [1, del.end]
        why = 'full:delivered-only'
      } else why = 'full:no-length'
      whole = true
    } else if (mode === null || mode === 'auto') {
      // **不假设 auto 会给全文**：auto 可能给 map/digest（那是一种结构取景，不是行区间）。
      // 回执里有行号就按交付算，并标出来源；没有就测不出。
      if (del.end !== null) {
        req = [1, del.end]
        why = 'auto:delivered'
        whole = true
      } else why = 'auto:no-lines'
    } else if (mode === 'lines') {
      why = 'mode=lines-without-range'
    } else if (del.end !== null) {
      // search / around / changed：区间由工具选，回执里有行号就按交付算
      req = [del.start ?? 1, del.end]
      why = `mode=${mode}:delivered`
      whole = true
    } else why = `mode=${mode}:no-range`
  }
  return { req, deliv, whole, explicit, why, delta: del.delta, total: del.total }
}

/* ------------------------------------------------------------ 写操作的落点 */

/**
 * 一次写**动了哪几行**（只在参数里明确写出来时才算）。
 *
 * 为什么需要它：判"白读"的第一版只问"两次读之间有没有写过"。可写了不代表**读的那段**变了——
 * 模型改了第 900 行的 `catch`，却回头重读第 30 行的常量，那次重读依然是白读。
 * 参数里有坐标就直接用（`aura_edit` 的 `hunks[].lines`、顶层 `start_line`/`end_line`），
 * 没有就返回 `null`（`old_string` 这种内容锚点在这里量不出落点，不猜）。
 *
 * @returns `[[s,e]…] | null`；`null` = 落点不可知
 */
export function writeRangesOf(args) {
  const out = []
  const hunks = Array.isArray(args?.hunks) ? args.hunks : []
  for (const h of hunks) {
    const p = asPair(h?.lines ?? h?.line ?? [h?.start_line, h?.end_line])
    if (p !== null) {
      out.push(normPair(p))
      continue
    }
    if (Number.isFinite(h?.start_line)) {
      const a = Math.max(1, Number(h.start_line))
      const b = Number.isFinite(h?.end_line) ? Math.max(a, Number(h.end_line)) : a
      out.push([a, b])
    }
  }
  const top = asPair(args?.lines)
  if (top !== null) out.push(normPair(top))
  else if (Number.isFinite(args?.start_line)) {
    const a = Math.max(1, Number(args.start_line))
    const b = Number.isFinite(args?.end_line) ? Math.max(a, Number(args.end_line)) : a
    out.push([a, b])
  }
  return out.length === 0 ? null : mergeRanges(out)
}

/*
 * `write`（整文件重写）与 `edit`（old_string 锚点）在这里**落点不可知**：
 * 前者改了全文，任何区域都可能变（保守起见按"可能相关"处理），
 * 后者要拿 old_string 去文件里找位置，而文件当时的内容已经不在日志里了。
 * 这两类计进 `unknown`，**不算进 sharpened 白读**——sharpened 只收
 * "落点明确、且与本次重读区间不相交"的那些，宁可低估。
 */
function isFullRewrite(name, args) {
  return name === 'write' || typeof args?.content === 'string' || typeof args?.create === 'string'
}

/* ------------------------------------------------------------ 事件流重建 */

/**
 * 把一个会话的日志行重建成**有序调用表**。
 *
 * 顺序用 `seq`（事件序号，日志里单调），配对用 `callId`——
 * `tool/call` 给参数、`tool/result` 给成败与正文，两者在日志里是分开的事件。
 * 结果正文在**嵌套两层**的 `part.content[].text`（实测形状，见 `session-log.mjs` 的同一处注释），
 * 顶层 `part.text` 也收，以防形状再变。
 */
export function callsOf(text) {
  const calls = []
  const byId = new Map()
  let seq = 0
  for (const line of text.split('\n')) {
    if (line.length < 40) continue
    if (!line.includes('"tool/call"') && !line.includes('"tool/result"')) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const at = typeof ev.seq === 'number' ? ev.seq : seq
    seq = at + 1
    if (ev.type === 'tool/call') {
      const name = ev.data?.name ?? ev.data?.tool
      if (typeof name !== 'string') continue
      const call = { i: calls.length, at, time: typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : null, name, args: argsOf(ev.data?.arguments), text: '', isError: false }
      calls.push(call)
      if (typeof ev.data?.callId === 'string') byId.set(ev.data.callId, call)
    } else if (ev.type === 'tool/result') {
      const id = ev.data?.message?.source?.callId
      const call = typeof id === 'string' ? byId.get(id) : undefined
      if (call === undefined) continue
      const parts = ev.data?.message?.content ?? []
      const texts = []
      let isError = false
      for (const part of parts) {
        if (part?.isError === true) isError = true
        if (typeof part?.text === 'string' && part.text.length > 0) texts.push(part.text)
        if (Array.isArray(part?.content)) {
          for (const inner of part.content) if (typeof inner?.text === 'string' && inner.text.length > 0) texts.push(inner.text)
        }
      }
      call.isError = isError
      call.text = texts.join('\n')
    }
  }
  return calls
}

/* ------------------------------------------------------------------ 主扫描 */

const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`)
const n1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a')
const n2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a')

/** 固定宽度的直方图行。 */
function histLine(label, counts, total, width = 26) {
  const max = Math.max(1, ...counts.map((c) => c[1]))
  const parts = counts.map(([k, v]) => `${k}=${v}(${pct(v, total)})`)
  return `  ${label.padEnd(width)}${parts.join('  ')}`
}

function bucketOf(r) {
  if (r >= FULL) return 'full'
  if (r <= NONE) return 'new'
  if (r < 0.33) return 'mostly-new'
  if (r < 0.67) return 'half'
  if (r < FULL) return 'mostly-old'
  return '?'
}

/** 分位数（线性插值，最近邻也够用；这里给的是"第 p 个样本"）。 */
function quantile(sorted, q) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

/* ------------------------------------------- 计数桶与部署切窗（--split-at） */

/** 整数格式化（空值不打 0）。 */
const n0 = (x) => (x === null || !Number.isFinite(x) ? 'n/a' : String(Math.round(x)))

/** 百分比格式化（空值不打 0）。 */
const pctShare = (x) => (x === null || !Number.isFinite(x) ? 'n/a' : `${(100 * x).toFixed(1)}%`)

/** 每窗最少要多少次读调用 / 多少次进入分布的重复读，低于此不给结论。 */
const SPLIT_MIN_CALLS = 30
const SPLIT_MIN_READS = 30
/** 触发格判定的「没动」带：两窗相对变化落在这个带内算没动。 */
const TRIGGER_TOL = 0.05

/**
 * 一份计数桶 = 一整套口径的全部累加器。
 *
 * 默认只建一个（全部语料）。`--split-at` 时另建两个（切点前 / 切点后），每场会话
 * **既进全量桶、又进它所属的那一窗**，三次记的都是同一个 `scanSession`。于是：
 *   · 「两窗口径一致」不是靠对齐两份代码，而是同一段代码；
 *   · 「两窗相加 == 全量」也不是靠事后检查，而是同一份输入按会话被分进不同桶
 *     （R5-B2 的守恒自检就是验这一条）。
 */
function mkAgg() {
  return {
    sessions: 0,
    sessionsScanned: 0,
    readCalls: 0,
    auraRead: 0,
    builtinRead: 0,
    readResults: 0,
    readErrors: 0,
    repeatAll: 0, // 纯计数口径（与历史 63.8% 对齐）：[tool,path] 已出现过
    repeatOk: 0, // 只数成功读
    measured: 0,
    byBucket: { full: 0, 'mostly-old': 0, half: 0, 'mostly-new': 0, new: 0 },
    byBucketReq: { full: 0, 'mostly-old': 0, half: 0, 'mostly-new': 0, new: 0 },
    byBucketDel: { full: 0, 'mostly-old': 0, half: 0, 'mostly-new': 0, new: 0 },
    byBucketExp: { full: 0, 'mostly-old': 0, half: 0, 'mostly-new': 0, new: 0 },
    expN: 0,
    byTool: { aura_read: 0, read: 0 },
    byToolFull: { aura_read: 0, read: 0 },
    byToolNew: { aura_read: 0, read: 0 },
    byToolWhite: { aura_read: 0, read: 0 },
    unmeasured: new Map(), // why -> n
    fullNoWrite: 0,
    fullWrite: 0,
    fullWriteHit: 0,
    fullWriteElsewhere: 0,
    fullWriteUnknown: 0,
    fullAfterTrunc: 0,
    fullSameFile: 0, // 本次读的区间，与上一次成功读的区间完全相同
    deltaServed: 0,
    deltaServedWithRange: 0,
    basisFromDeliv: 0,
    basisFromReq: 0,
    wholeReq: 0,
    sweepReads: 0,
    noBudgetTrunc: 0,
    truncReads: 0,
    weirdPairwise: 0, // 与紧邻上一次读**不重叠**（pairwise）——“我到底读过没读过”的判据松一档
    overlaps: [],
    overlapsDel: [],
    deliverySame: 0,
    deliveryOlder: 0,
    deliveryNewer: 0,
    // ② 的三个分布**只在「完全重叠」那一批里累加**，直方图分母是 full —— 不跨批混用分母
    preFull: new Map(),
    pre2Full: new Map(), // 前两次调用拼成的链条
    preDirFull: new Map(),
    gapCounts: new Map(),
    eventsSinceWriteFull: new Map(),
    sweepRuns: [],
    sweepChars: 0,
    sweepBaselineChars: 0,
    newRangeRereads: 0,
    sampleSweeps: [],
    /** 日志文件总数（不随窗口变，外层赋值：它是“扫了多少个文件”，不是“用到了几个”）。 */
    sessionFiles: 0,
    fileReads: new Map(),
  }
}

/**
 * `--split-at` 的取值：纯数字当 epoch 毫秒，其余交给 `Date.parse`（ISO 串等）。
 *
 * 认不出就**报错退出**，不猜。切点猜错一整天，两窗读数会整体错一窗，而错出来的数
 * 长得很像对的（两窗都非空、加总也守恒）—— 守恒只能证明分桶没丢会话，证不了切点对不对。
 */
function splitStamp(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '') return null
  if (/^\d+$/.test(s)) return Number(s)
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) {
    fs.writeSync(2, `--split-at 认不出这个时刻：${JSON.stringify(raw)}（要 ISO 时刻串，或 epoch 毫秒）\n`)
    process.exit(1)
  }
  return ms
}

/** 调用时间戳（`callsOf` 记下的 `ev.time`）：epoch 毫秒；认不出记 null。 */
function stampOf(call) {
  const t = call.time
  return typeof t === 'number' && Number.isFinite(t) ? t : null
}

/**
 * 一场会话落在哪一窗 —— 按**会话内最早一次调用**的时刻定，不按文件 mtime。
 *
 * 为什么不是 mtime：mtime 是“最后一次写”。一场部署前开的会话，只要它一直跑到部署后，
 * mtime 就落在切点之后，于是它整场（包括部署前那段）会被算进后窗 —— 而后窗正是用来
 * 判断“新工具做了什么”的那一格，混进旧行为等于把结论往“没动”的方向拽。
 * 一个时间戳都没有的会话才退回 mtime，并单独计数（`split.byMtime`），不静默。
 *
 * 跨切点的会话（起点在切点前、末尾在切点后）整场归**前窗**，并把“切点后的调用次数”
 * 单独记出来打印 —— 归哪边都有偏，但把偏差写在报告里比把它藏进某一窗强。
 * （判据与 `change-cost.mjs` 的同名函数一致，两探针的窗是同一个窗。）
 *
 * @returns `'before' | 'after'`
 */
function classifySession(sp, calls, mtime) {
  let first = null
  let last = null
  let afterCalls = 0
  for (const c of calls) {
    const t = stampOf(c)
    if (t === null) continue
    if (first === null || t < first) first = t
    if (last === null || t > last) last = t
    if (t >= sp.cut) afterCalls += 1
  }
  if (first === null) {
    sp.byMtime += 1
    return mtime < sp.cut ? 'before' : 'after'
  }
  if (first < sp.cut && last >= sp.cut) {
    sp.straddleSessions += 1
    sp.straddleCalls += afterCalls
  }
  return first < sp.cut ? 'before' : 'after'
}

/** 「前 → 后」并以绝对差 + 相对差（分母是前窗）收尾；任一侧量不出就不给差。 */
function arrowOf(before, after, fmt) {
  if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) {
    return `${fmt(before)} → ${fmt(after)}（有一窗量不出，不给差）`
  }
  const d = after - before
  const rel = before === 0 ? null : d / before
  return `${fmt(before)} → ${fmt(after)}（${d >= 0 ? '+' : ''}${fmt(d)}${rel === null ? '' : `，${rel >= 0 ? '+' : ''}${(100 * rel).toFixed(1)}%`}）`
}

function main() {

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--json', '--root', '--session', '--split-at'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/reread-cause.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
  const argv = process.argv.slice(2)
  const argOf = (flag) => {
    const i = argv.indexOf(flag)
    return i > -1 ? argv[i + 1] : undefined
  }
  /** `--split-at=<值>` 与 `--split-at <值>` 两种写法都收（题面写的是前者）。 */
  const argEqOf = (flag) => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`))
    return hit === undefined ? argOf(flag) : hit.slice(flag.length + 1)
  }
  const only = argOf('--session')
  const jsonOut = argOf('--json')
  const root = argOf('--root') ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
  const splitAt = splitStamp(argEqOf('--split-at'))
  const say = (m) => fs.writeSync(1, `${m}\n`)

  const files = [...sessionFiles(root)]
  if (files.length === 0) {
    say(`no session logs under ${root}`)
    process.exit(0)
  }

  /** 全量桶：不切窗时它是唯一的口径（下面报告段沿用 `agg` 这个名字）。 */
  const aggAll = mkAgg()
  aggAll.sessionFiles = files.length
  const agg = aggAll
  /** 切窗（`--split-at`）；不切窗时 null —— 默认路径不建桶、不定窗、不多打一个字。 */
  const split =
    splitAt === null
      ? null
      : { cut: splitAt, before: mkAgg(), after: mkAgg(), byMtime: 0, straddleSessions: 0, straddleCalls: 0 }
  const jsonLines = []
  /**
   * 守恒自检的逐项点名（C48：判据接退出码）。在 `main()` 作用域上声明，而不是在
   * `if (split !== null)` 块里 —— 汇总与退出码那一段在切窗块之外（它还要给案例印“—（本次没判）”），
   * 块内 `const` 外层看不见。不切窗时它保持空数组，也就永远不会被读。
   */
  const splitViolations = []

  for (const file of files) {
    const dir = path.basename(path.dirname(file))
    if (only !== undefined && !dir.includes(only)) continue
    let text
    try {
      text = decompressAll(fs.readFileSync(file))
    } catch {
      continue
    }

    // cwd：会话头里有；取第一个出现的（`session-log.mjs` 同法）
    let cwd = null
    const head = text.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (head !== null) {
      try {
        cwd = JSON.parse(`"${head[1]}"`)
      } catch {
        cwd = null
      }
    }

    const calls = callsOf(text)
    /* 不切窗：只有一个桶。切窗：这场会话既进全量桶、又进它所属的那一窗。 */
    let winLabel = null
    let mtime = 0
    if (split !== null) {
      try {
        mtime = fs.statSync(file).mtimeMs
      } catch {
        mtime = 0
      }
      winLabel = classifySession(split, calls, mtime)
    }
    const targets = split === null ? [aggAll] : [aggAll, split[winLabel]]
    for (const T of targets) scanSession(T, dir, cwd, calls, winLabel)
  }

  /**
   * 扫一场会话：日志只解一次（`calls`/`cwd` 在外层算好），记进**每一个**目标桶。
   *
   * 桶是参数 `T`，函数体第一行把它绑成 `agg`，于是下面三百多行记账代码**一个字没动**。
   * 「两窗口径一致」由此是构造：两窗跑的是同一段代码、同一份解析结果，只有桶不同。
   */
  function scanSession(T, dir, cwd, calls, winLabel) {
    const agg = T
    agg.sessionsScanned += 1
    if (calls.length === 0) return
    agg.sessions += 1

    const seenKeys = new Set()
    const groups = new Map() // pathKey -> {last, seen:[], prior:[], lastWriteAt, lastWriteIdx, lastReadChars}
    const readSeq = [] // 该会话内所有成功读（用于扫掠检测），元素带 file/path/req/deliv

    for (const call of calls) {
      if (READ_TOOLS.test(call.name)) {
        agg.readCalls += 1
        if (call.name === 'aura_read') agg.auraRead += 1
        else agg.builtinRead += 1
        if (call.isError === true) {
          agg.readErrors += 1
          continue
        }
        agg.readResults += 1
        const pkey = normPath(call.args?.file_path, cwd)
        if (pkey === null) {
          agg.unmeasured.set('no-resolvable-path', (agg.unmeasured.get('no-resolvable-path') ?? 0) + 1)
          continue
        }
        const got = requestedOf(call.name, call.args, call.text)
        if (got.req === null) {
          agg.unmeasured.set(got.why, (agg.unmeasured.get(got.why) ?? 0) + 1)
          continue
        }
        const total = got.total
        const cap = total ?? null
        const req = cap === null ? got.req : normPair([Math.min(got.req[0], cap), Math.min(got.req[1], cap)])
        // 没测到文件总行数时**不要**把交付区间上限偷偷缩到交付末行：`[1,delivered]` 当"已交付集合"
        // 会把"请求了但没交付的尾巴"也算成已交付，于是下一次请求重叠率被高估。
        const deliv = got.deliv === null ? null : got.deliv
        // 已交付集合取**交付区间**（那是模型真拿到手的行）。交付测不出时退回请求区间。
        const basis = deliv ?? req

        const key = `${call.name}\u0000${pkey}`
        const isRepeatCount = seenKeys.has(key)
        if (isRepeatCount) agg.repeatAll += 1
        else seenKeys.add(key)

        let g = groups.get(pkey)
        if (g === undefined) {
          g = {
            seen: 0,
            seenLines: [],
            explicitLines: [],
            last: null,
            lastWriteIdx: -1,
            lastWriteAt: -1,
            lastWriteRanges: undefined,
            lastTruncated: false,
            lastReadIdx: -1,
            lastReadAt: -1,
            chars: 0,
          }
          groups.set(pkey, g)
        }
        if (g.seen > 0) agg.repeatOk += 1
        const rep = g.seen > 0
        g.seen += 1

        if (rep) {
          agg.measured += 1
          agg.byTool[call.name] = (agg.byTool[call.name] ?? 0) + 1
          const reqLen = req[1] - req[0] + 1
          /**
           * 两个重叠率，分母都是**已交付集合**（历史上真正给过模型的行），分子不同：
           *   · `rReq` —— 分子是**请求区间**与它的交：模型这次想要的位置，有多少已经给过。
           *     这是验收口径里的"重叠率分布"，也是判断"白读/取景错"的依据。
           *   · `rDel` —— 分子是**本次交付区间**与它的交：这次真送出去的内容里，有多少是重复的。
           *     它衡量的是**浪费掉的字符**，不是模型的选择。
           * 两个都报：只有它们分开，才能分清"模型又点了一遍"和"工具又发了一遍"。
           */
          const reqInter = intersectLen(g.seenLines, req)
          const rReq = reqInter / Math.max(1, reqLen)
          const delInter = deliv === null ? reqInter : intersectLen(g.seenLines, deliv)
          const delLen = deliv === null ? reqLen : deliv[1] - deliv[0] + 1
          const rDel = delInter / Math.max(1, delLen)
          /**
           * 进分布的是哪个 r：**请求是"整份文件"时用交付侧**。
           * 整份请求的区间是 [1, 文件长度] 或 [1, 交付末行]，拿它当分母会得到
           * "任何一次全文重读都是 100% 重叠"这种没信息量的结论；而那个文件的长度
           * 在回执里常常测不到。全文重读的浪费由交付侧如实反映。
           * 定向请求（lines / start_line+end_line / offset+limit）用请求侧——那才是模型的选择。
           */
          const rMain = got.whole ? rDel : rReq
          const bucket = bucketOf(rMain)
          if (got.whole) agg.wholeReq += 1
          if (deliv === null) agg.basisFromReq += 1
          else agg.basisFromDeliv += 1
          agg.byBucket[bucket] = (agg.byBucket[bucket] ?? 0) + 1
          agg.byBucketReq[bucketOf(rReq)] = (agg.byBucketReq[bucketOf(rReq)] ?? 0) + 1
          agg.byBucketDel[bucketOf(rDel)] = (agg.byBucketDel[bucketOf(rDel)] ?? 0) + 1
          // 第二本账：只认**参数里写出来的**区间（不碰回执）。独立复算用它对齐。
          if (got.explicit) {
            agg.expN += 1
            const exInter = intersectLen(g.explicitLines, req)
            agg.byBucketExp[bucketOf(exInter / Math.max(1, reqLen))] = (agg.byBucketExp[bucketOf(exInter / Math.max(1, reqLen))] ?? 0) + 1
          }
          if (bucket === 'full') agg.byToolFull[call.name] = (agg.byToolFull[call.name] ?? 0) + 1
          if (bucket === 'new') agg.byToolNew[call.name] = (agg.byToolNew[call.name] ?? 0) + 1
          agg.overlaps.push(rReq)
          agg.overlapsDel.push(rDel)

          // 也按"与上一次读"的成对重叠算一档（判据松一档，见 --json 里的 pairwise）
          let pairwise = null
          if (g.last !== null) {
            const li = intersectLen([g.last], req)
            pairwise = li / Math.max(1, reqLen)
            if (li === 0) agg.weirdPairwise += 1
          }
          const sameAsLast = pairwise !== null && pairwise >= FULL

          /**
           * 「两次读之间写过吗」只看**调用序号**，不看时间戳。
           *
           * 第一版用 `time` 比大小（`lastReadAt < lastWriteAt`），那是错的：
           * 同一毫秒内的调用会打平，而写事件只在该文件**已经进过组**时才被记录，
           * 于是 `lastWriteIdx > -1` 与时间戳判据会给出两套不同的答案（实测 957 vs 289，
           * 差在"第一次读之前就写过"那批：那种写法下上次读的内容已经是写后的，
           * 之后的重复读照样是白读）。这里统一成一条：**本的读序号 < 最近一次写的序号**。
           */
          const wroteSince = g.lastWriteIdx > -1 && g.lastReadIdx > -1 && g.lastReadIdx < g.lastWriteIdx
          if (bucket === 'full') {
            if (g.lastTruncated) agg.fullAfterTrunc += 1
            if (!wroteSince) {
              agg.fullNoWrite += 1
              agg.byToolWhite[call.name] = (agg.byToolWhite[call.name] ?? 0) + 1
            } else {
              agg.fullWrite += 1
              /**
               * 写过 ≠ 读的那段变过。第二次判据：
               *   · 落点明确且与本次请求**不相交** ⇒ 照样是白读（`fullWriteElsewhere`）
               *   · 落点明确且相交            ⇒ 该重读，不算浪费（`fullWriteHit`）
               *   · 落点不可知（整文件重写 / old_string 锚点）⇒ 不猜，记 `fullWriteUnknown`
               */
              const wr = g.lastWriteRanges
              // 比的是**本次交付区间**（模型实际又收到的那几行），不是请求区间——
              // 请求 1-321 而只交付 1-166 时，写在第 300 行不影响这次重读的结论。
              if (wr === null) agg.fullWriteUnknown += 1
              else if (intersectLen(wr, deliv ?? req) > 0) agg.fullWriteHit += 1
              else {
                agg.fullWriteElsewhere += 1
                agg.byToolWhite[call.name] = (agg.byToolWhite[call.name] ?? 0) + 1
              }
            }
            if (sameAsLast) agg.fullSameFile += 1
          }
          if (bucket === 'new') agg.newRangeRereads += 1

          // 交付覆盖：模型请求的这段，工具实际给了多少（用行数估，回执行号是唯一可用尺度）
          let dcov = null
          if (deliv !== null) {
            const dl = deliv[1] - deliv[0] + 1
            dcov = Math.min(1, dl / Math.max(1, reqLen))
          }
          if (dcov !== null) {
            if (dcov >= FULL) agg.deliverySame += 1
            else if (dcov < 0.5) agg.deliveryOlder += 1
            else agg.deliveryNewer += 1
          }
          if (got.total !== null && deliv !== null && deliv[1] < got.total) agg.truncReads += 1
          if (got.delta) {
            agg.deltaServed += 1
            if (got.why === 'lines' || got.why === 'start_line+end_line') agg.deltaServedWithRange += 1
          }

          // ② 前 1-3 次调用是什么。**只统计「完全重叠」那一批**——这一节每个直方图的分母
          // 都是 full；把部分重叠/全新区间也塞进来，百分比就会加起来不等于 100%，
          // 而那种"看起来像分布"的数字比缺字段更难发现。
          const idx = call.i
          const prev1 = calls[idx - 1]
          if (bucket === 'full') {
            const tag = prev1 === undefined ? '(无前序)' : `${prev1.name}${prev1.isError === true ? '✗' : ''}`
            agg.preFull.set(tag, (agg.preFull.get(tag) ?? 0) + 1)
            const sameFile =
              prev1 !== undefined &&
              (READ_TOOLS.test(prev1.name) || WRITE_TOOLS.test(prev1.name)) &&
              normPath(prev1.args?.file_path, cwd) === pkey
            const kind = WRITE_TOOLS.test(prev1?.name ?? '') ? 'write' : READ_TOOLS.test(prev1?.name ?? '') ? 'read' : 'other'
            const dirKey = `${kind}:${prev1?.isError === true ? 'err' : 'ok'}${sameFile ? ':samefile' : ''}`
            agg.preDirFull.set(dirKey, (agg.preDirFull.get(dirKey) ?? 0) + 1)
            const p2 = calls[idx - 2]
            const chain = `${prev1 === undefined ? '(无)' : `${prev1.name}${prev1.isError === true ? '✗' : ''}`}${sameFile ? '·' : ''} → ${p2 === undefined ? '(无)' : `${p2.name}${p2.isError === true ? '✗' : ''}`}`
            agg.pre2Full.set(chain, (agg.pre2Full.get(chain) ?? 0) + 1)

            // 距上一次对该文件的写，中间隔了几次调用
            if (g.lastWriteIdx > -1) {
              const gap = idx - g.lastWriteIdx
              const b = gap <= 1 ? '0-1' : gap <= 3 ? '2-3' : gap <= 10 ? '4-10' : gap <= 30 ? '11-30' : '>30'
              agg.eventsSinceWriteFull.set(b, (agg.eventsSinceWriteFull.get(b) ?? 0) + 1)
            }
          }

          // 间隔：这次请求的起点 - 上次交付的终点（>0 是断档，<=0 是重叠）
          if (g.last !== null && deliv !== null) {
            const gap = req[0] - g.last[1]
            const b = gap <= 0 ? '<=0(重叠)' : gap <= 5 ? '1-5' : gap <= 20 ? '6-20' : gap <= 100 ? '21-100' : '>100'
            agg.gapCounts.set(b, (agg.gapCounts.get(b) ?? 0) + 1)
          }

          if (jsonOut !== undefined && T === aggAll) {
            /* 每条只推一次（推的是全量桶那一趟）；`window` 只在切窗时加，
             * 不加 --split-at 的 JSONL 与改造前逐字节相同。 */
            const rec = {
              session: dir,
              i: idx,
              name: call.name,
              file: pkey,
              why: got.why,
              req,
              deliv,
              total,
              rReq: Number(rReq.toFixed(4)),
              rDel: Number(rDel.toFixed(4)),
              bucket,
              pairwise: pairwise === null ? null : Number(pairwise.toFixed(4)),
              wroteSince,
              prev1: prev1 === undefined ? null : { name: prev1.name, isError: prev1.isError === true, path: normPath(prev1.args?.file_path, cwd) },
              delta: got.delta,
              chars: call.text.length,
            }
            if (winLabel !== null) rec.window = winLabel
            jsonLines.push(JSON.stringify(rec))
          }

          readSeq.push({ file: pkey, req, deliv, rReq: rMain, chars: call.text.length })
        }

        // 更新状态：`g.seen` 是**交付过的行**的并集（交付测不出时才退回请求区间）——
        // 重叠率就是拿它比的，所以它只能是"模型真拿到手的"，不能是"模型说想要的"。
        g.seenLines = unionInto(g.seenLines, [basis])
        if (got.explicit) g.explicitLines = unionInto(g.explicitLines, [req])
        // 这次的回执被内容预算砍过没有？下一次读要看它（"上次没给够"的直接证据）
        g.lastTruncated = OMIT_BUDGET.test(call.text) || OMIT_PAST_END.test(call.text) || OMIT_PAST_END_ALT.test(call.text)
        g.last = req
        g.lastReadIdx = call.i
        g.lastReadAt = call.at
        continue
      }

      if (WRITE_TOOLS.test(call.name)) {
        const pkey = normPath(call.args?.file_path, cwd)
        if (pkey === null) continue
        // 写事件**允许建组**：只记"已经进过组的文件"会漏掉"先写、后读、再读"这一串里
        // 的第一笔写，于是后面的重复读被误判成"没写过"。
        let g = groups.get(pkey)
        if (g === undefined) {
          g = {
            seen: 0,
            seenLines: [],
            explicitLines: [],
            last: null,
            lastWriteIdx: -1,
            lastWriteAt: -1,
            lastWriteRanges: undefined,
            lastTruncated: false,
            lastReadIdx: -1,
            lastReadAt: -1,
            chars: 0,
          }
          groups.set(pkey, g)
        }
        g.lastWriteIdx = call.i
        g.lastWriteAt = call.at
        g.lastWriteRanges = isFullRewrite(call.name, call.args) ? null : writeRangesOf(call.args)
      }
    }

    /**
     * ③ 扫掠检测：模型是不是在**顺着文件往下翻**。
     *
     * 一段"扫掠"要同时满足三件事，缺一不算：
     *   1. 相邻两次读的**请求起点**递进（0 < 步长 ≤ SWEEP_MAX_GAP）——这是"往下翻"的动作；
     *   2. 本次请求与"已交付集合"的重叠 < 50%——**这次是真去拿新内容**，不是把同一段再点一遍；
     *      没有这一条，任何"小步右移的重复窗口"都会被误判成扫掠（第一版就栽在这：1914 段里
     *      大多数是重复窗口，真实的"往下扫"反而被淹掉）。
     *   3. 连续 ≥ SWEEP_MIN_RUN 段。
     *
     * 步长用**请求起点之差**，不用"上次交付终点"——交付被预算截断时，后者会把
     * 一步跨 800 行的跳读算成"紧挨着"。
     */
    let run = null
    const flush = () => {
      if (run !== null && run.items.length >= SWEEP_MIN_RUN) {
        agg.sweepRuns.push({ session: dir, file: run.file, n: run.items.length, chars: run.chars, span: run.span, maxGap: run.maxGap })
        agg.sweepReads += run.items.length
        agg.sweepChars += run.chars
        agg.sweepBaselineChars += run.span
        if (agg.sampleSweeps.length < 5) {
          agg.sampleSweeps.push({
            session: dir,
            file: run.file,
            n: run.items.length,
            spanLines: run.span,
            chars: run.chars,
            firstReq: run.items[0].req,
            lastReq: run.items[run.items.length - 1].req,
          })
        }
      }
      run = null
    }
    for (let k = 1; k < readSeq.length; k += 1) {
      const cur = readSeq[k]
      const prev = readSeq[k - 1]
      const advance = cur.file === prev.file ? cur.req[0] - prev.req[0] : null
      if (advance === null || !(advance > 0 && advance <= SWEEP_MAX_GAP) || cur.rReq >= 0.5) {
        flush()
        continue
      }
      if (run === null) {
        run = { file: cur.file, items: [prev, cur], chars: prev.chars + cur.chars, span: 0, maxGap: advance }
      } else {
        run.items.push(cur)
        run.chars += cur.chars
        run.maxGap = Math.max(run.maxGap, advance)
      }
      const first = run.items[0]
      const last = run.items[run.items.length - 1]
      run.span = Math.max(1, last.req[1] - first.req[0] + 1)
    }
    flush()
  }

  /* ------------------------------------------------------------------ 报告 */

  const measured = agg.measured
  if (measured === 0) {
    say('没有量到任何重复读。')
    process.exit(0)
  }

  const full = agg.byBucket.full
  const white = agg.fullNoWrite
  const overlaps = agg.overlaps.slice().sort((a, b) => a - b)
  const overlapsDel = agg.overlapsDel.slice().sort((a, b) => a - b)

  say('=== R5 · 重复读的成因：模型在找什么？===')
  say(`  会话根        ${root}`)
  say(`  日志文件      ${agg.sessionFiles} 个，解出会话 ${agg.sessions} 个（含工具调用）`)
  say(`  读调用        ${agg.readCalls} 次（aura_read ${agg.auraRead} / read ${agg.builtinRead}）`)
  say(`  读非成功      ${agg.readErrors} 次（失败不算"读过"——它没交付任何内容）`)
  say(`  成功读        ${agg.readResults} 次`)
  say('')
  say('--- 口径校准（先对历史数，再谈成因）---')
  say(`  [tool,path] 二元组已出现过 = ${agg.repeatAll} / ${agg.readCalls} = ${pct(agg.repeatAll, agg.readCalls)}   ← 历史口径 63.8% 是这一条`)
  say(`  只数成功读、且能定出请求区间的重复读 = ${agg.repeatOk} 次（其中 ${measured} 次区间可测，进入下面的分布）`)
  say(`  ${agg.repeatOk - measured} 次区间测不出（原因见"量不到"一节），**不塞进分布充数**`)
  say('')

  say('--- ① 重叠率分布：这次要的区间，此前点过多少 ---')
  say(`  总体（n=${measured}）。分母是**已交付集合**（历史读里真正给过模型的行并集）：`)
  say(`    请求侧 r = |本次请求 ∩ 已交付| / |本次请求|   —— 模型的选择：是不是又点了已经给过的地方`)
  say(`    交付侧 r = |本次交付 ∩ 已交付| / |本次交付|   —— 工具的浪费：这次真发出去的内容里有多少是重复的`)
  say(`  已交付集合来自回执交付行号的 ${agg.basisFromDeliv} 次 = ${pct(agg.basisFromDeliv, measured)}；`)
  say(`  交付行号测不出、退回请求区间的 ${agg.basisFromReq} 次 = ${pct(agg.basisFromReq, measured)}`)
  say(`  请求本身是"整份文件"的 ${agg.wholeReq} 次 = ${pct(agg.wholeReq, measured)}：这些的分类口径走交付侧`)
  say('    （整份请求的分母是文件长度，而文件长度在回执里常常测不到；拿它当分母会把每次全文重读都算成 100% 重叠，等于没量）')
  say('')
  say(`  【进分布的口径】完全重叠 r≈1 ${String(full).padStart(6)}  ${pct(full, measured).padStart(7)}   ← 要的东西逐行都点过`)
  say(`            部分重叠        ${String(measured - full - agg.byBucket.new).padStart(6)}  ${pct(measured - full - agg.byBucket.new, measured).padStart(7)}`)
  say(`              其中 r≥2/3    ${String(agg.byBucket['mostly-old']).padStart(6)}  ${pct(agg.byBucket['mostly-old'], measured).padStart(7)}   （大部分点过）`)
  say(`              其中 1/3≤r<2/3 ${String(agg.byBucket.half).padStart(5)}  ${pct(agg.byBucket.half, measured).padStart(7)}`)
  say(`              其中 r<1/3    ${String(agg.byBucket['mostly-new']).padStart(6)}  ${pct(agg.byBucket['mostly-new'], measured).padStart(7)}   （大部分是新的）`)
  say(`            全新区间 r≈0    ${String(agg.byBucket.new).padStart(6)}  ${pct(agg.byBucket.new, measured).padStart(7)}   ← 一行都没点过，不算浪费`)
  say(`  【全走请求侧】完全重叠    ${String(agg.byBucketReq.full).padStart(6)}  ${pct(agg.byBucketReq.full, measured).padStart(7)}（定向重读的独立口径）`)
  say(`                全新区间    ${String(agg.byBucketReq.new).padStart(6)}  ${pct(agg.byBucketReq.new, measured).padStart(7)}`)
  say(`  【全走交付侧】完全重叠    ${String(agg.byBucketDel.full).padStart(6)}  ${pct(agg.byBucketDel.full, measured).padStart(7)}（"这次发出去的字符里有多少是重复的"）`)
  say('')
  say(`  【第二本账】只认**参数里写出来的**区间（已读集合也只用那些区间构成，完全不碰回执解析）：`)
  say(`               n=${agg.expN}（占全部重复读 ${pct(agg.expN, measured)}）`)
  say(`               完全重叠 ${String(agg.byBucketExp.full).padStart(6)}  ${pct(agg.byBucketExp.full, agg.expN).padStart(7)}   全新区间 ${String(agg.byBucketExp.new).padStart(6)}  ${pct(agg.byBucketExp.new, agg.expN).padStart(7)}`)
  say(`               这一列**可以脱离本探针独立复算**：只用 tool/call 的参数与顺序，不需要解任何回执`)
  say(`               两本账若接近，说明"交付集合"没有把结论撑大；差得远则说明全文读的交付被算成了已读`)
  say('')
  say('  按工具拆（两把读工具是不同的调用面，混在一起看不出该改哪一层）：')
  for (const tool of ['aura_read', 'read']) {
    const n = agg.byTool[tool] ?? 0
    if (n === 0) continue
    say(
      `    ${tool.padEnd(10)} n=${String(n).padStart(6)}  完全重叠 ${String(agg.byToolFull[tool] ?? 0).padStart(6)} (${pct(agg.byToolFull[tool] ?? 0, n)})  全新区间 ${String(agg.byToolNew[tool] ?? 0).padStart(6)} (${pct(agg.byToolNew[tool] ?? 0, n)})  其中白读 ${String(agg.byToolWhite[tool] ?? 0).padStart(6)}`,
    )
  }
  say(`  请求侧重叠率分位：p10=${n2(quantile(overlaps, 0.1))}  p25=${n2(quantile(overlaps, 0.25))}  p50=${n2(quantile(overlaps, 0.5))}  p75=${n2(quantile(overlaps, 0.75))}  p90=${n2(quantile(overlaps, 0.9))}`)
  say(`  交付侧重叠率分位：p10=${n2(quantile(overlapsDel, 0.1))}  p25=${n2(quantile(overlapsDel, 0.25))}  p50=${n2(quantile(overlapsDel, 0.5))}  p75=${n2(quantile(overlapsDel, 0.75))}  p90=${n2(quantile(overlapsDel, 0.9))}`)
  say(`  完全重叠里，本次请求与**上一次读**的请求完全相同的 ${agg.fullSameFile} 次 = ${pct(agg.fullSameFile, Math.max(1, full))}（连窗口都没换）`)
  say('')
  say('--- ①b 交付覆盖：请求的这段，工具实际给了多少 ---')
  say(`  交付≈请求（一次给够）  ${agg.deliverySame}  ${pct(agg.deliverySame, measured)}`)
  say(`  交付 50%-99%           ${agg.deliveryNewer}  ${pct(agg.deliveryNewer, measured)}`)
  say(`  交付 <50%（只给了头）  ${agg.deliveryOlder}  ${pct(agg.deliveryOlder, measured)}`)
  say(`  回执带"数据被预算截断"标记的读：${agg.truncReads} 次 = ${pct(agg.truncReads, agg.readResults)}（占全部成功读）`)
  say(`  回执是**增量差量**（"unchanged line(s) withheld"）的重复读：${agg.deltaServed} 次 = ${pct(agg.deltaServed, measured)}`)
  say(`    其中 ${agg.deltaServedWithRange} 次要的是**明确行区间**（不是全文）——增量层对"定向重读"不生效，它只省全文那一档`)
  say('')

  say('--- ② 完全重叠那一批：前面发生了什么 ---')
  say(`  n=${full}；其中**两次读之间没有对该文件写过**的 ${white} 次 = ${pct(white, full)}（白读，最硬的一档）`)
  say(`  两次读之间**写过**该文件的 ${agg.fullWrite} 次 = ${pct(agg.fullWrite, full)}（文件变过，重读不全是浪费）`)
  say(`    其中落点与本次重读区间**不相交**（写了别处，却回头重读这一段）：${agg.fullWriteElsewhere} 次 = ${pct(agg.fullWriteElsewhere, full)}`)
  say(`    其中落点**相交**（这一段真被改过，重读是对的）：${agg.fullWriteHit} 次 = ${pct(agg.fullWriteHit, full)}`)
  say(`    其中落点不可知（整文件重写 / old_string 锚点，量不出落点，不猜）：${agg.fullWriteUnknown} 次 = ${pct(agg.fullWriteUnknown, full)}`)
  say(`  ⇒ **白读 = ${white + agg.fullWriteElsewhere} 次 = ${pct(white + agg.fullWriteElsewhere, measured)} 的重复读**（没有写过 + 写了但没碰这一段）`)
  say(`  另一条独立线索：**上一次对同一文件的读被内容预算截断过**的完全重叠 ${agg.fullAfterTrunc} 次 = ${pct(agg.fullAfterTrunc, full)}`)
  say(`    （它说明这批重复读的前一次本来就没给全——"上次没给够"是能直接观测到的，不用靠推理）`)
  say('')
  say('  紧邻的**上一次调用**是什么工具（✗ = 那次失败）：')
  const preArr = [...agg.preFull.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  for (const [k, v] of preArr) say(`    ${k.padEnd(22)} ${String(v).padStart(7)}  ${pct(v, full).padStart(7)}`)
  say('')
  say('  前两次调用拼成的链条（最常见的 10 种；「·」表示前一次就是本文件的读/写）：')
  for (const [k, v] of [...agg.pre2Full.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    say(`    ${k.padEnd(30)} ${String(v).padStart(7)}  ${pct(v, full).padStart(7)}`)
  }
  say('')
  say('  上一次调用与本文件的关系：')
  for (const [k, v] of [...agg.preDirFull.entries()].sort((a, b) => b[1] - a[1])) {
    say(`    ${k.padEnd(22)} ${String(v).padStart(7)}  ${pct(v, full).padStart(7)}`)
  }
  say('')
  say('  距上一次对该文件的写，中间隔了几次调用：')
  for (const k of ['0-1', '2-3', '4-10', '11-30', '>30']) {
    const v = agg.eventsSinceWriteFull.get(k) ?? 0
    if (v > 0) say(`    ${k.padEnd(10)} ${String(v).padStart(7)}  ${pct(v, full).padStart(7)}`)
  }
  say('')
  say('  本次请求起点 − 上次交付终点（**断档大小**，正数=隔着一段没读过）：')
  for (const k of ['<=0(重叠)', '1-5', '6-20', '21-100', '>100']) {
    const v = agg.gapCounts.get(k) ?? 0
    if (v > 0) say(`    ${k.padEnd(12)} ${String(v).padStart(7)}  ${pct(v, measured).padStart(7)}`)
  }
  say(`  与**紧邻上一次读**完全不重叠的重复读：${agg.weirdPairwise} 次 = ${pct(agg.weirdPairwise, measured)}（"我到底读过没读过"判据松一档时的可回收量）`)
  say('')

  say('--- ③ 全新区间那一批：是不是在顺着文件往下扫 ---')
  say(`  全新区间的重复读 ${agg.newRangeRereads} 次 = ${pct(agg.newRangeRereads, measured)}`)
  say(`  其中落在"单调递进、断档≤${SWEEP_MAX_GAP} 行、连续≥${SWEEP_MIN_RUN} 段"的扫掠里：${agg.sweepReads} 次 = ${pct(agg.sweepReads, agg.newRangeRereads)}（占全新区间）`)
  say(`  扫掠段数（run）${agg.sweepRuns.length} 条；最长一条 ${agg.sweepRuns.length === 0 ? 0 : Math.max(...agg.sweepRuns.map((r) => r.n))} 段`)
  say(`  扫掠读回的字符合计 ${agg.sweepChars}；若一次把整个 span 给全，同 span 字符估算 ${agg.sweepBaselineChars} → 分次搬运是它的 ${n2(agg.sweepChars / Math.max(1, agg.sweepBaselineChars))}×`)
  agg.sweepRuns.sort((a, b) => b.n - a.n)
  for (const r of agg.sweepRuns.slice(0, 6)) {
    say(`    ${String(r.n).padStart(3)} 段  span ${String(r.span).padStart(6)} 行  ${r.chars} 字符  最大断档 ${r.maxGap}  ${r.file}`)
    say(`         session ${r.session}`)
  }
  say('')

  say('--- ④ 结论 ---')
  const whiteAll = white + agg.fullWriteElsewhere
  say(`  重复读里 ${pct(whiteAll, measured)} 是「白读」（要的区间此前逐行给过，且中间**没有改动过那一段**）`)
  say(`  （拆分：两次读之间根本没写过 ${white} 次 + 写了但落点在别处 ${agg.fullWriteElsewhere} 次；`)
  say(`    另外 ${agg.fullWriteUnknown} 次落点不可知，**没算进白读**——宁可低估）`)
  say(`  重复读里 ${pct(agg.deliveryOlder + agg.deliveryNewer, measured)} 是「上次没给够」（交付不足请求的一半，只能再来一次）——`)
  say(`  ${pct(agg.byBucketReq.new, measured)} 是「上次压根没给过这一段」（请求区间与已给过的完全不相交）`)
  say('')
  say('  这三个数指向**不同的层**，改法也不同：')
  say(`    · 白读 ${whiteAll} 次（${pct(whiteAll, measured)}）：模型手里已经有这段，还是再要了一遍，`)
  say('      而这一遍既不是文件变了、也不是上次没给够。→ 改**取景记忆**这一层：')
  say('      同一个会话里"这段给过、内容没变"应当被工具自己记住，而不是靠模型记得。')
  say(`    · 没给够 ${agg.deliveryOlder + agg.deliveryNewer} 次（${pct(agg.deliveryOlder + agg.deliveryNewer, measured)}）：第一次的**取景尺度**就错了。`)
  say('      → 改**一次给够**：预算随请求走，或在截断时直接给一条能把剩余部分一次取完的路径。')
  say(`    · 真新区间 ${agg.byBucketReq.new} 次（${pct(agg.byBucketReq.new, measured)}）：不是浪费，是正常往下读。`)
  say('      其中落在"顺扫"里的见 ③——那一批该由"一次给足一整段"解决，增量读救不了。')
  say('')
  say(`  增量读的实际覆盖面：回执是差量的重复读只有 ${agg.deltaServed} 次 = ${pct(agg.deltaServed, measured)}。`)
  say('  也就是说"同会话增量读"这一层**几乎没被走到**——重复读的大头既不是全文重读，也不是差量能省掉的。')
  say('')

  /* ── R5-B. 部署切窗对照（--split-at）──────────────────────────────────────
   * 触发条件里属于本探针的那一格是「重复读里全新区间占比」。历史值 51.7% 里**不含新工
   * 具的行为**，拿它当对照没有意义 —— 要的是「部署后新会话 vs 部署前会话」的同口径切窗。
   * 这一节把那次切窗做成现成能力：重启后一条命令就能回答触发条件里的这一格。
   * 两窗与全量桶跑的是同一个 `scanSession`，所以“口径一致”是构造，不是承诺。
   * ────────────────────────────────────────────────────────────────────── */
  if (split !== null) {
    say('')
    say('════════════════════════════════════════════════════════════════════════')
    say('  R5-B. 部署切窗对照 —— 切点前窗 vs 切点后窗（同一段代码、同一套判据）')
    say('════════════════════════════════════════════════════════════════════════')
    say(`  切点 --split-at   : ${new Date(split.cut).toISOString()}（epoch ${split.cut} ms，上面按 UTC 打印）`)
    say('  定窗判据          : 会话内**最早一次调用**的时刻 < 切点 ⇒ 前窗，≥ 切点 ⇒ 后窗（不按文件 mtime）')
    say(`  退回文件 mtime 的 : ${split.byMtime} 个会话（没有带时间戳的调用，多为零调用会话；按文件 mtime 定窗）`)
    say(`  跨切点的会话      : ${split.straddleSessions} 个，其中落在切点之后的调用 ${split.straddleCalls} 次 —— 整场归前窗`)
    say('    为什么这么归：跨切点的会话身上一定带着旧工具的行为，放进**后窗**正好污染')
    say('    「新工具做了什么」那一格；放前窗只会稀释前窗。偏差写在这里，不藏进某一窗。')

    /** 一个桶的核心读数 —— 与上面 ①②③④ 同一批字段、同一段代码，只是换了桶。 */
    const coreOf = (T) => {
      const m = T.measured
      const fullN = T.byBucket.full
      const partN = m - fullN - T.byBucket.new
      const whiteN = T.fullNoWrite + T.fullWriteElsewhere
      return {
        scanned: T.sessionsScanned,
        sessions: T.sessions,
        readCalls: T.readCalls,
        auraRead: T.auraRead,
        builtinRead: T.builtinRead,
        readResults: T.readResults,
        readErrors: T.readErrors,
        repeatAll: T.repeatAll,
        repeatOk: T.repeatOk,
        measured: m,
        unmeasuredN: [...T.unmeasured.values()].reduce((a, b) => a + b, 0),
        fullN,
        partN,
        newN: T.byBucket.new,
        whiteN,
        fullShare: m === 0 ? null : fullN / m,
        partShare: m === 0 ? null : partN / m,
        newShare: m === 0 ? null : T.byBucket.new / m,
        whiteShare: m === 0 ? null : whiteN / m,
        sweepReads: T.sweepReads,
        enough: T.readCalls >= SPLIT_MIN_CALLS && m >= SPLIT_MIN_READS,
      }
    }

    const wBlock = (label, c) => {
      say('')
      say(`  ── ${label} ──`)
      say(`    日志文件 / 解出会话      : 成功解开 ${c.scanned} 个 / 含工具调用的 ${c.sessions} 个（扫到的日志文件共 ${agg.sessionFiles} 个，不随窗分）`)
      say(`    读调用                   : ${c.readCalls} 次（aura_read ${c.auraRead} / read ${c.builtinRead}）；成功读 ${c.readResults} 次，失败 ${c.readErrors} 次`)
      say(`    [tool,path] 已出现过的读  : ${c.repeatAll} 次 = ${pct(c.repeatAll, c.readCalls)}（历史口径 63.8% 是这一条）`)
      say(`    进入分布的重复读 n        : ${c.measured} 次（只数成功读、且能定出区间的）`)
      say(`    完全重叠 r≈1             : ${c.fullN} 次 = ${pct(c.fullN, c.measured)}`)
      say(`    部分重叠                 : ${c.partN} 次 = ${pct(c.partN, c.measured)}`)
      say(`    全新区间 r≈0             : ${c.newN} 次 = ${pct(c.newN, c.measured)}`)
      say(`    白读（没写过 + 写了没碰这段）: ${c.whiteN} 次 = ${pct(c.whiteN, c.measured)}（占重复读）`)
      say(`    区间测不出、没塞进分布的  : ${c.unmeasuredN} 次`)
      say(
        `    样本判据                 : 读调用 ${c.readCalls} ${c.readCalls >= SPLIT_MIN_CALLS ? '≥' : '<'} ${SPLIT_MIN_CALLS} 且 进入分布的重复读 ${c.measured} ${c.measured >= SPLIT_MIN_READS ? '≥' : '<'} ${SPLIT_MIN_READS}` +
          ` ⇒ ${c.enough ? '样本充足，可读' : '**样本不足：上面这些数只当记账，不当读数、不给结论**'}`,
      )
    }

    const bc = coreOf(split.before)
    const ac = coreOf(split.after)
    wBlock('前窗（< 切点）', bc)
    wBlock('后窗（≥ 切点）', ac)

    say('')
    say('  同口径对照（前窗 → 后窗；两窗同代码、同判据，只有会话集合不同）：')
    say(`    完全重叠占比   ${arrowOf(bc.fullShare, ac.fullShare, pctShare)}`)
    say(`    部分重叠占比   ${arrowOf(bc.partShare, ac.partShare, pctShare)}`)
    say(`    全新区间占比   ${arrowOf(bc.newShare, ac.newShare, pctShare)}`)
    say(`    白读占比       ${arrowOf(bc.whiteShare, ac.whiteShare, pctShare)}`)
    say(`    完全重叠次数   ${arrowOf(bc.fullN, ac.fullN, n0)}`)
    say(`    全新区间次数   ${arrowOf(bc.newN, ac.newN, n0)}`)
    say(`    （两窗读调用 ${bc.readCalls} → ${ac.readCalls}；进入分布的重复读 ${bc.measured} → ${ac.measured}）`)

    say('')
    say('  触发格判定（本探针负责的那一格：「重复读里全新区间占比」）')
    if (!bc.enough || !ac.enough) {
      say(`    **样本不足，不给结论**：判这一格要求两窗都「读调用 ≥ ${SPLIT_MIN_CALLS} 且 进入分布的重复读 ≥ ${SPLIT_MIN_READS}」，`)
      say(`    现在是 前窗 ${bc.readCalls} 次读 / ${bc.measured} 次重复读，后窗 ${ac.readCalls} 次读 / ${ac.measured} 次重复读。`)
      say('    样本不够时唯一诚实的话是「再跑一段」——小样本的「没动」和真的没动长得一模一样。')
    } else {
      const rel = bc.newShare === 0 ? null : (ac.newShare - bc.newShare) / bc.newShare
      const moved = rel === null || Math.abs(rel) > TRIGGER_TOL
      say(`    前窗 ${pctShare(bc.newShare)} → 后窗 ${pctShare(ac.newShare)}，相对变化 ${rel === null ? '—（前窗为 0）' : `${rel >= 0 ? '+' : ''}${(100 * rel).toFixed(1)}%`}；「没动」的带是 ±${(TRIGGER_TOL * 100).toFixed(0)}%`)
      say(`    ⇒ 这一格【${moved ? '动了' : '未动'}】`)
    }
    say('    注：换「读侧取景形状」要求**两格都没动**。本探针只答「全新区间占比」这一格；')
    say('        另一格「一次逻辑改动的均摊调用次数」在 `change-cost.mjs --split-at=<同一时刻>`。')

    say('')
    say('  R5-B2. 守恒自检：两窗计数之和 == 不切窗的总计数')
    const cons = [
      ['解开的会话文件', split.before.sessionsScanned, split.after.sessionsScanned, aggAll.sessionsScanned],
      ['读调用', split.before.readCalls, split.after.readCalls, aggAll.readCalls],
      ['成功读', split.before.readResults, split.after.readResults, aggAll.readResults],
      ['[tool,path] 已出现过的读', split.before.repeatAll, split.after.repeatAll, aggAll.repeatAll],
      ['进入分布的重复读 n', split.before.measured, split.after.measured, aggAll.measured],
      ['完全重叠 r≈1', split.before.byBucket.full, split.after.byBucket.full, aggAll.byBucket.full],
      ['全新区间 r≈0', split.before.byBucket.new, split.after.byBucket.new, aggAll.byBucket.new],
      ['白读（没写过 + 写了没碰）', bc.whiteN, ac.whiteN, aggAll.fullNoWrite + aggAll.fullWriteElsewhere],
      ['扫掠读次数', split.before.sweepReads, split.after.sweepReads, aggAll.sweepReads],
      ['区间测不出（未入分布）', bc.unmeasuredN, ac.unmeasuredN, [...aggAll.unmeasured.values()].reduce((a, b) => a + b, 0)],
    ]
    let consOk = true
    for (const [name, b, a, t] of cons) {
      const ok = b + a === t
      if (!ok) consOk = false
      say(`    ${name.padEnd(24)}前 ${String(b).padStart(8)} + 后 ${String(a).padStart(8)} = ${String(b + a).padStart(8)}   总 ${String(t).padStart(8)}   ${ok ? '✓' : `⚠ 差 ${t - b - a}`}`)
    }
    say('    这一条只能证「分桶没丢会话、没记重」，**证不了切点选得对** —— 切点错了，这里照样全绿。')
    say(`    ⇒ 守恒判据：${consOk ? '✓ 全部一致' : '⚠ 有不一致项（定窗丢会话或记重了，先修这个再看读数）'}`)
    if (!consOk) {
      const bad = cons.filter(([n, b, a, t]) => b + a !== t).map(([n, b, a, t]) => `${n}（前 ${b} + 后 ${a} = ${b + a} ≠ 总 ${t}，差 ${t - b - a}）`)
      splitViolations.push({ name: '守恒自检（R5-B2）', detail: `${bad.length} 项：${bad.join('；')}` })
    }
  }

  /* ── 判据 → 退出码（C48）──────────────────────────────────────────────────
   * 判据只增不减：R5-B2 的守恒自检照旧在它原来的位置上印（逐项 ✓ / ⚠），这里只把它接上退出码，
   * 并在末行点名是哪几项不符 —— 屏幕上变红与进程表态从此同一件事（从前 main() 自然结束，恒 0）。
   *
   * 为什么整段包在 `if (split !== null)` 里：硬约束是「不带 `--split-at` ⇒ stdout 与 `--json`
   * 产物逐字节不变」。默认路径上多印一个「判据汇总」标题就算改行为（C48 实测：第一版就是这么
   * 栽的，两份默认路径 stdout 当场与改动前不同）。判据不因此变少 —— 不带开关时切窗那段根本不
   * 执行，守恒自检不在场，「没判」与「判过且通过」在默认路径上本来就是同一件事；切窗路径上
   * 它照旧逐条判定、逐项点名。
   * ────────────────────────────────────────────────────────────────────────── */
  if (split !== null) {
    const violations = splitViolations
    const gate = violations.length === 0 ? 'ok' : 'violated'
    say('')
    say('── 判据汇总（退出码按这一行表态）──')
    say(`  守恒自检（R5-B2）    : ${gate === 'ok' ? '✓ 通过' : '⚠ 不符'}`)
    say(`  ⇒ 判据：${gate === 'ok' ? '✓ 全部通过（退出码 0）' : `⚠ ${violations.length} 项判据不符 ⇒ 退出码 1：${violations.map((v) => v.name).join('；')}`}`)
    if (gate !== 'ok') {
      for (const v of violations) {
        fs.writeSync(2, `判据不符：${v.name}\n`)
        fs.writeSync(2, `判据明细：${v.name} ${v.detail}\n`)
      }
      process.exitCode = 1
    }
  }

  const un = [...agg.unmeasured.entries()].sort((a, b) => b[1] - a[1])
  say('--- 量不到的部分（不塞进分布）---')
  for (const [why, n] of un) say(`    ${why.padEnd(30)} ${String(n).padStart(7)}`)
  say('')

  if (jsonOut !== undefined) {
    fs.writeFileSync(jsonOut, `${jsonLines.join('\n')}\n`)
    say(`逐次重复读证据 → ${jsonOut}（${jsonLines.length} 行 JSONL，可独立复算）`)
  }
}

export { mergeRanges, unionInto, intersectLen, bucketOf, normPath }

const invoked = process.argv[1] ?? ''
if (invoked.endsWith('reread-cause.mjs')) main()
