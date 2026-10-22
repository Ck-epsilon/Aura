/**
 * rework-rate.mjs —— 「一次就改好」量具：编辑要返工几次，错了还能不能自己修回来。
 *
 * 运行：
 *   node aura-tools/probes/rework-rate.mjs [--workspaces=a,b] [--include-meta]
 *        [--max-files=N] [--since=ISO] [--until=ISO] [--json] [--selftest] [--root=DIR]
 *
 * ── 口径（**写死在这里，没有"更宽松也算成功"之类的开关**）────────────────────────────
 *
 * 三元组 = `(会话, 回合, 文件)`：
 *   · 会话 = 一个 `session.v3.jsonl.zstd`（按会话目录名去重）；
 *   · 回合 = `tool/call.data.turn`（同一会话文件内），取不到就归 `(无turn)` 并单列计数；
 *   · 文件 = 该次编辑调用点名的路径（`file_path`；多目标则 `targets[].file_path` 逐个数；反斜杠归一
 *     成 `/`、小写）。一次调用点名 N 个文件 ⇒ 它对这 N 个三元组各算**一次**编辑调用。
 *   · 只认编辑调用：`aura_edit` 与内置 `edit`（本量具只量写侧；别的工具不进分母，只进"全部调用"对账）。
 *
 * 四个指标：
 *   ① **一次成功率** = 每个三元组里**第一次**编辑调用"真落盘"的三元组数 / 全部三元组数。
 *   ② **返工次数**   = Σ(每个三元组的编辑调用数 − 1)；同时报"有返工的三元组 / 全部三元组"。
 *   ③ **自我修正率** = 某次编辑"没落盘"之后、**同一会话内紧接着**的那次编辑"真落盘"的条数 /
 *                      编辑"没落盘"且后面还有一次编辑的条数（分子分母都报）。
 *   ④ **返工后是否落到同一文件** = 返工调用里"该会话上一次编辑点的还是这个文件"的条数 / 返工调用条数
 *                      （衡量"在同一个地方反复磨"的强度）。附带第二个口径（标签写明）：
 *                      上一次编辑**没落盘**时仍回到同一文件的条数 / 返工条数。
 *
 * ── 两层成功判据（最容易量歪的一条，写死在这里）────────────────────────────────────
 *   **第一层**（结构化字段）：`tool/result` 的 content 里 `isError === false`。它是必要条件、
 *   **不是**充分条件：写路径现在把"找不到 / 要你挑 / 已落地 / 干跑"也当**正常结果**返回
 *   （`isError=false`），所以这一层会把"如实拒绝"算成成功。
 *   **第二层**（回执正文分层，与第一层**同时**报），桶相互排斥、判定顺序即优先级：
 *     · `isError === true` ⇒ `not_found`（工具报错 = 这次没落地）；没有 `isError` 字段 ⇒ 同样不算落地；
 *     · 正文含 `nothing was written`（写路径拒绝/干跑的固定措辞，干跑形如
 *       `Dry run for … — every hunk matched; nothing was written.`）⇒ 没落盘；
 *       其中再按 `candidates:` / `cannot tell which one you meant` / `appears on N lines` 分 `needs_choice`，
 *       按 `do not match assert` / `not found` / `no line contains` 分 `not_found`，
 *       其余（干跑、参数错等）分 `refused_other`；
 *     · 正文说"改动已经在里面了"（`outcome: already_applied` / `already in the state`）⇒ `already_applied`
 *       —— 幂等命中，**本次调用没写盘**（它是"已经对了"，不是"这次改对了"）；
 *     · 否则看落盘标志：`aura_edit` 每次目标一条 `N hunk(s) applied`；内置 `edit` 是
 *       `The file <path> has been updated successfully.` ⇒ `wrote`；
 *     · 都没有 ⇒ 兜底按 `wrote` 计（一支，**要把这一支看成已知盲区**：引擎换文案的话它会落到这里，
 *       所以上面那条干跑分支特意排在落盘标志之前）。
 *   于是 **真落盘 = 第一层为假 + 正文既无拒绝/候选/已落地措辞、又给出落盘标志（或落进兜底支）**。
 *   两层各占一格都印出来；`--json` 里每条读数自带 `{ value, num, den }`。
 *
 * ── 样本范围（本仓纪律：窗口读数必须自报边界与样本数）──────────────────────────────
 *   · 人群：真实任务人群 = `--E-workspaces-agent-browser-bridge--` + `--E-workspaces-AuraPolaris--`
 *     （单子点名，**不是**"最近修改"那套取样）；元会话 `--E-workspaces-deepseekharness--` 默认
 *     **排除**，`--include-meta` 才纳入作对照。
 *   · `--since` / `--until` 按**会话文件 mtime** 过滤 —— 这是"改动之前 vs 之后"的切分口径。
 *   · **有界取样**：每个工作区按**文件字节降序**取至多 `--max-files=` 个（默认 6）⇒ 大文件里编辑密度
 *     最高，同样的内存换到最多的编辑调用。读法是**一次一个文件**：解压 → 抽事件 → 只留紧凑记录
 *     （`回合/文件/两个布尔`）→ 立刻丢掉正文与参数，峰值内存 ≈ 被选中的最大单个会话文件
 *     （**不靠 `--max-old-space-size`**）。语料 700MB 级 ⇒ 全量读会把 node 读爆，取样上界才是解法。
 *   · 报告里"全库人口普查"给点名工作区的**全部**文件数与字节数（取样前）；"采样"逐条给真读进来的
 *     文件、字节、mtime —— 两者都印，免得窗口读数没有边界。
 *
 * ── 判定力（退出码挂钩判据）────────────────────────────────────────────────────────
 *   ① **记账自洽**：编辑调用总数 = 首次 + 返工；自我修正率分子 ≤ 分母；有返工三元组 ≤ 全部三元组；
 *      两层：真落盘 ≤ `isError=false`（三层桶之和 = 编辑总数）；逐工作区汇总 = 全局；
 *      本量具只读语料（不写盘）；
 *   ② **人群口径**：默认运行时 deepseekharness 会话占比 > 50% ⇒ 红（防"只按最近修改取样"那次错）；
 *   ③ **分层自检**：`--selftest` 把**合成回执**（真落盘的 / 找不到的 / 需选择的 / 已落地的 / 干跑的 /
 *      `isError=true` 的 / 内置 edit 的）喂给同一个分层函数，"真落盘 / 找不到 / 需选择 / 已落地"
 *      **四条必须分到四个不同的桶**，并断言干跑那条 `isError=false` 却不算真落盘（证明两层没退化）。
 *   退出码：0 = 全绿（含 `--selftest`）；1 = 有判据红；2 = 用法错。
 *
 * ── 与参考读数的对账（**只对账，不进判据**）────────────────────────────────────────
 *   先前手写脚本量到真实任务人群里 `aura_edit` 占全部调用 ≈ 20%、平均 1.67 hunk/次。本探针把这两个数
 *   一起算出来印在报告里做对照 —— 语料一变该改的是那份读数，所以它**不**是判据（红了不动）。
 *   实测对账（本波现场，两个口径分开了算，因为参考那两个数的分母不是同一个）：
 *     · **平均 hunk / aura_edit 调用**（与参考同分母）= **1.68** vs 参考 1.67 ⇒ 这一条对上了；
 *     · 全部编辑调用（含内置 `edit`）的均值只有 1.24 ⇒ 因为内置 `edit` 的参数里没有 hunks 概念
 *       （3709 次调用贡献 0 个 hunk）；把参考那个 1.67 放在“全部编辑”这个分母上会得 0.58。
 *     · **占全部调用** = 10.6%（10425 / 98229，全库 662 个文件实测）vs 参考 ≈ 20%。分母已分摊：
 *       本波语料里内置 `edit` 自己就占了 3.8% 的调用，而 `aura_edit` 只占 10.6% —— 工具构成变了。
 *       这一条差异如实报进回执的 `openQuestions`，**不靠调口径拉平**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompressAll } from './session-log.mjs'

/** 真实任务人群（单子点名）。 */
export const REAL_WORKSPACES = ['--E-workspaces-agent-browser-bridge--', '--E-workspaces-AuraPolaris--']
/** 元会话工作区（造工具的那个工作区；默认排除，`--include-meta` 纳入作对照）。 */
export const META_WORKSPACE = '--E-workspaces-deepseekharness--'
/** 先前手写脚本量到的参考读数（只对账）。 */
export const REFERENCE = { auraEditShare: 0.2, meanHunks: 1.67, auraEditHunks: 1.67 }

const EDIT_TOOLS = new Set(['aura_edit', 'edit'])
const SESSION_FILE = 'session.v3.jsonl.zstd'

// ── 分层函数（**纯函数**：合成回执与真回执走同一条路；`--selftest` 直接喂它）────────────

/** 落盘标志：`aura_edit` 每次目标一条 `N hunk(s) applied`；内置 `edit` 是 `has been updated successfully`。 */
const APPLIED_RE = /\d+\s+hunk\(s\) applied\b|has been updated successfully/i
const DRY_RUN_RE = /dry run/i
const CHOICE_RE = /candidates:|cannot tell which one you meant|appears on \d+ lines?/i
const NOT_FOUND_RE = /do not match assert|no line contains|\bnot found\b|PATCH_NOT_FOUND/i
const ALREADY_RE = /already_applied|already in the state|nothing to change/i

/**
 * 回执 → 落盘层级。返回 `{ reallyWrote, isErrorFalse, bucket, why }`。
 * 桶（相互排斥）：`wrote` / `not_found` / `needs_choice` / `already_applied` / `refused_other`。
 * @param {{ name?: string, isError?: boolean|null, text?: string }} receipt
 */
export function classifyReceipt(receipt) {
  const body = String(receipt?.text ?? '')
  const isError = receipt?.isError
  const isErrorFalse = isError === false
  const noWrite = /nothing was written/i.test(body)
  const applied = APPLIED_RE.test(body)
  const choice = CHOICE_RE.test(body)
  const decision = (reallyWrote, bucket, why) => ({ reallyWrote, isErrorFalse, bucket, why })

  if (isError === true) return decision(false, 'not_found', 'isError=true（工具报了错 ⇒ 这次编辑没落地）')
  if (!isErrorFalse) return decision(false, 'not_found', '回执没有 isError 字段（不成对的结果事件，不算落地）')
  // 幂等命中要排在 "nothing was written" 之前：真是那条回执（实测形状）**也**带 `nothing was written`，
  // 它在语义上是第三种东西（"已经改好了"，不是"没找到"也不是"要你挑"）—— 排在后面就会被归成 refused_other。
  if (ALREADY_RE.test(body)) return decision(false, 'already_applied', '正文说"改动已经在文件里了"（幂等）⇒ 本次调用没写盘')
  // "如实拒绝"这一支必须排在落盘标志之前：干跑的回执会**同时**带 `every hunk matched` 与 `N hunk(s) applied` 那句预告。
  if (noWrite) {
    if (choice) return decision(false, 'needs_choice', '正文含 `nothing was written` + 候选措辞 ⇒ 需选择、没写盘')
    if (NOT_FOUND_RE.test(body)) return decision(false, 'not_found', '正文含 `nothing was written` + 找不到措辞 ⇒ 没写盘')
    return decision(false, 'refused_other', `正文含 \`nothing was written\`（${DRY_RUN_RE.test(body) ? '干跑' : '其他如实拒绝'}）⇒ isError=false 但**没写盘**`)
  }
  if (choice) return decision(false, 'needs_choice', '正文是候选清单（引文不唯一）⇒ 需选择、没写盘')
  if (NOT_FOUND_RE.test(body))
  if (applied) return decision(true, 'wrote', '正文给出落盘标志（`N hunk(s) applied` / `has been updated successfully`）⇒ 真落盘')
  return decision(true, 'wrote', '既无报错、也无任何拒绝/候选/已落地措辞，且无落盘标志 ⇒ 兜底按真落盘计（见文件头）')
}

// ── 取样与解析（有界：字节降序 + 硬上界 + 一次一个文件）──────────────────────────────

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

const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)}MB`
const num = (n) => n.toLocaleString('en-US')
const pct = (n, d) => (d === 0 || d === undefined || d === null ? '—' : `${((n / d) * 100).toFixed(1)}%`)
const rate = (n, d) => (d === 0 || d === undefined || d === null ? null : n / d)

const normPath = (p) => String(p).replace(/\\/g, '/').toLowerCase()

/** 一次编辑调用点名的文件：`file_path` 优先，其次 `targets[].file_path`（多目标逐个数）。 */
function targetPathsOf(args) {
  const out = []
  if (args !== null && typeof args === 'object') {
    if (typeof args.file_path === 'string') out.push(args.file_path)
    if (Array.isArray(args.targets)) {
      for (const t of args.targets) if (t !== null && typeof t === 'object' && typeof t.file_path === 'string') out.push(t.file_path)
    }
  }
  return [...new Set(out)].map(normPath)
}

function hunkCountOf(args) {
  if (args === null || typeof args !== 'object') return 0
  if (Array.isArray(args.hunks)) return args.hunks.length
  if (Array.isArray(args.targets)) return args.targets.reduce((a, t) => a + (Array.isArray(t?.hunks) ? t.hunks.length : 0), 0)
  return 0
}

const safeJson = (raw) => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 一个会话文件的正文 → 紧凑记录（**不保留正文与参数** ⇒ 有界）。
 *
 * 配对上用 `callId`（`tool/call` 记在 `byId` 里、`tool/result` 用 `source.callId` 取回），
 * **不**用 (回合,工具,文件) 猜：同一回合里对同一个文件的两次编辑是常事。
 * 一次调用点了 N 个目标 ⇒ N 条记录共用这一次调用的回执（落盘是**整体**判定的）。
 *
 * @param text - 解压后的日志（调用方读完即弃）
 * @param session - 会话目录名
 * @returns `{ edits, calls, hunks, noTurn }`；
 *   `edits[i] = { turn, tool, file, order, isError, reallyWrote, bucket }`
 */
export function parseSession(text, session) {
  const byId = new Map() // callId → { 紧凑调用记录 }
  const edits = []
  const counters = { calls: 0, hunks: 0, noTurn: 0, auraEditCalls: 0, builtinEditCalls: 0 }
  let order = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event === undefined) continue
    if (event.type === 'tool/call') {
      const name = event.data?.name
      if (typeof name !== 'string') continue
      counters.calls += 1
      const turn = typeof event.data?.turn === 'number' ? event.data.turn : null
      const args = typeof event.data?.arguments === 'string' ? safeJson(event.data.arguments) : (event.data?.arguments ?? null)
      const isEdit = EDIT_TOOLS.has(name)
      const targets = isEdit ? targetPathsOf(args) : []
      const call = { name, turn, isEdit, targetsCount: targets.length, isError: null, text: '' }
      if (typeof event.data?.callId === 'string') byId.set(event.data.callId, call)
      if (!isEdit) continue
      if (name === 'aura_edit') counters.auraEditCalls += 1
      else counters.builtinEditCalls += 1
      counters.hunks += hunkCountOf(args)
      if (turn === null) counters.noTurn += 1
      for (const file of targets) {
        edits.push({ turn: turn === null ? '(无turn)' : String(turn), tool: name, file, order: (order += 1), isError: null, reallyWrote: null, bucket: null })
      }
    } else if (event.type === 'tool/result') {
      const id = event.data?.message?.source?.callId
      const call = typeof id === 'string' ? byId.get(id) : undefined
      if (call === undefined) continue
      const parts = event.data?.message?.content ?? []
      call.isError = parts.some((part) => part?.isError === true)
      const textOf = (part) => {
        const own = typeof part?.text === 'string' ? part.text : ''
        const nested = Array.isArray(part?.content)
          ? part.content.map((inner) => (typeof inner?.text === 'string' ? inner.text : '')).filter((t) => t.length > 0)
          : []
        return [own, ...nested].filter((t) => t.length > 0).join('\n')
      }
      call.text = parts.map(textOf).filter((t) => t.length > 0).join('\n')
      if (!call.isEdit || call.isError === null) continue
      call.verdict = classifyReceipt({ name: call.name, isError: call.isError, text: call.text })
    }
  }
  // 回执在调用之后到达是日志的既有顺序；这里把每条编辑记录挂到它自己那次调用上（`order` 升序、单调配对）。
  const byCallOrder = [...byId.values()].filter((c) => c.isEdit)
  let cursor = 0
  for (const call of byCallOrder) {
    if (call.verdict === undefined) continue
    const turnKey = call.turn === null ? '(无turn)' : String(call.turn)
    let matched = 0
    while (cursor < edits.length && matched < call.targetsCount) {
      const edit = edits[cursor]
      cursor += 1
      if (edit.isError !== null) continue
      if (edit.turn !== turnKey || edit.tool !== call.name) continue
      edit.isError = call.isError
      edit.reallyWrote = call.verdict.reallyWrote
      edit.bucket = call.verdict.bucket
      matched += 1
    }
  }
  return { edits, ...counters }
}

// ── 聚合（**只有这一段实现口径**；判据只读它，取样器不许碰它）────────────────────────

const EMPTY = () => ({
  calls: 0,
  editCalls: 0,
  auraEditCalls: 0,
  builtinEditCalls: 0,
  hunks: 0,
  noTurn: 0,
  unpaired: 0,
  edits: 0,
  isErrorFalse: 0,
  reallyWrote: 0,
  buckets: {},
})

const bump = (map, key) => {
  map[key] = (map[key] ?? 0) + 1
}

/**
 * 紧凑记录 → 四个指标 + 两层判据读数。
 * @param files - `[{ workspace, session, edits, calls, hunks, noTurn }]`
 */
export function aggregate(files) {
  const global = EMPTY()
  const byWorkspace = new Map()
  const timelines = new Map() // 会话 → 该会话的编辑序列（按日志顺序）
  const tuplesAll = new Map() // `${会话}\u0000${回合}\u0000${文件}` → 记录
  for (const file of files) {
    const bucket = byWorkspace.get(file.workspace) ?? EMPTY()
    if (!byWorkspace.has(file.workspace)) byWorkspace.set(file.workspace, bucket)
    const timeline = [] // 该会话的编辑序列（`file` 用于指标④；`order` 保证日志顺序）
    for (const edit of file.edits) {
      global.edits += 1
      bucket.edits += 1
      timeline.push(edit)
      const key = `${file.session}\u0000${edit.turn}\u0000${edit.file}`
      const row = tuplesAll.get(key) ?? { key, session: file.session, turn: edit.turn, file: edit.file, calls: 0, first: null }
      row.calls += 1
      if (row.first === null) row.first = edit
      tuplesAll.set(key, row)
      // 两层各数各的：第一层 = `isError=false`（**不管有没有落盘**）；第二层 = 真落盘。
      if (edit.isError === false) {
        global.isErrorFalse += 1
        bucket.isErrorFalse += 1
      }
      if (edit.reallyWrote === true) {
        global.reallyWrote += 1
        bucket.reallyWrote += 1
      }
      if (edit.reallyWrote === null) {
        global.unpaired += 1
        bucket.unpaired += 1
      }
      bump(global.buckets, edit.bucket ?? '(未配对)')
      bump(bucket.buckets, edit.bucket ?? '(未配对)')
    }
    for (const counter of [
      ['calls', file.calls],
      ['auraEditCalls', file.auraEditCalls],
      ['builtinEditCalls', file.builtinEditCalls],
      ['hunks', file.hunks],
      ['noTurn', file.noTurn],
    ]) {
      global[counter[0]] += counter[1]
      bucket[counter[0]] += counter[1]
    }
    global.editCalls += file.auraEditCalls + file.builtinEditCalls
    bucket.editCalls += file.auraEditCalls + file.builtinEditCalls
    timelines.set(file.session, [...(timelines.get(file.session) ?? []), ...timeline])
  }

  // ① 一次成功率 / ② 返工次数（按三元组）
  const tuples = [...tuplesAll.values()].sort((a, b) => a.key.localeCompare(b.key))
  let firstWrote = 0
  let reworkCalls = 0
  let tuplesWithRework = 0
  for (const tuple of tuples) {
    if (tuple.first.reallyWrote === true) firstWrote += 1
    const extra = tuple.calls - 1
    if (extra > 0) {
      tuplesWithRework += 1
      reworkCalls += extra
    }
  }
  // ③ 自我修正率 / ④ 返工是否落在同一文件（按**同一会话内的编辑序列**）
  let prevFailed = 0
  let fixedNext = 0
  let reworkHandoffs = 0
  let sameFileHandoffs = 0
  let sameFileAfterFailure = 0
  for (const timeline of timelines.values()) {
    for (let i = 1; i < timeline.length; i += 1) {
      const prev = timeline[i - 1]
      const cur = timeline[i]
      reworkHandoffs += 1
      if (cur.file === prev.file) sameFileHandoffs += 1
      if (prev.reallyWrote !== true) {
        prevFailed += 1
        if (cur.reallyWrote === true) fixedNext += 1
        if (cur.file === prev.file) sameFileAfterFailure += 1
      }
    }
  }

  const metrics = {
    oneShotRate: { value: rate(firstWrote, tuples.length), num: firstWrote, den: tuples.length },
    // `value` = 返工次数 / 编辑调用总数；`num`/`den` = 返工次数 / 三元组数（口径表里两个数都要报）。
    reworkCalls: { value: rate(reworkCalls, global.editCalls), num: reworkCalls, den: tuples.length, tuplesWithRework },
    selfCorrectRate: { value: rate(fixedNext, prevFailed), num: fixedNext, den: prevFailed },
    reworkSameFile: { value: rate(sameFileHandoffs, reworkHandoffs), num: sameFileHandoffs, den: reworkHandoffs },
  }
  const perWorkspace = [...byWorkspace].map(([workspace, figures]) => ({ workspace, ...figures }))
  const sum = (pick) => perWorkspace.reduce((a, w) => a + pick(w), 0)
  return {
    global,
    perWorkspace,
    metrics,
    extra: { tuplesWithRework, sameFileAfterFailure, reworkHandoffs, prevFailed },
    bySum: {
      edits: sum((w) => w.edits),
      isErrorFalse: sum((w) => w.isErrorFalse),
      reallyWrote: sum((w) => w.reallyWrote),
      calls: sum((w) => w.calls),
      auraEditCalls: sum((w) => w.auraEditCalls),
      hunks: sum((w) => w.hunks),
    },
  }
}

// ── 判据（退出码挂钩）────────────────────────────────────────────────────────────────

/**
 * 记账自洽 + 人群口径。返回 `{ label, ok, items: [{ name, ok, detail }] }`。
 * @param scope - `{ corpus, metaShare, includeMeta, sampled }`（人群口径那一组要它）
 */
export function consistencyChecks(result, scope) {
  const g = result.global
  const m = result.metrics
  const items = []
  const add = (name, ok, detail) => items.push({ name, ok, detail })
  add('编辑调用总数 = 首次调用数 + 返工次数', g.edits === m.oneShotRate.den + m.reworkCalls.num, `${g.edits} = ${m.oneShotRate.den} + ${m.reworkCalls.num}`)
  add('自我修正率分子 ≤ 分母', m.selfCorrectRate.num <= m.selfCorrectRate.den, `${m.selfCorrectRate.num} ≤ ${m.selfCorrectRate.den}`)
  add('有返工的三元组数 ≤ 全部三元组数', m.reworkCalls.tuplesWithRework <= m.reworkCalls.den, `${m.reworkCalls.tuplesWithRework} ≤ ${m.reworkCalls.den}`)
  add('两层：真落盘 ≤ isError=false ≤ 编辑调用总数', g.reallyWrote <= g.isErrorFalse && g.isErrorFalse <= g.edits, `${g.reallyWrote} ≤ ${g.isErrorFalse} ≤ ${g.edits}`)
  add('三层桶之和 = 编辑调用总数', Object.values(g.buckets).reduce((a, n) => a + n, 0) === g.edits, `${Object.values(g.buckets).reduce((a, n) => a + n, 0)} = ${g.edits}`)
  add(
    '三元组数 = 首次调用数（每个三元组恰好有一次首次调用），且一次成功 ≤ 三元组数',
    m.oneShotRate.den === m.reworkCalls.den && m.oneShotRate.num <= m.oneShotRate.den,
    `${m.oneShotRate.den} = ${m.reworkCalls.den}（三元组/首次）；一次成功 ${m.oneShotRate.num} ≤ ${m.oneShotRate.den}`,
  )
  add('逐工作区汇总 = 全局', result.bySum.edits === g.edits && result.bySum.reallyWrote === g.reallyWrote, `编辑 ${result.bySum.edits} = ${g.edits}；真落盘 ${result.bySum.reallyWrote} = ${g.reallyWrote}`)
  add('返工同一文件分子 ≤ 返工条数', m.reworkSameFile.num <= m.reworkSameFile.den, `${m.reworkSameFile.num} ≤ ${m.reworkSameFile.den}`)
  add('未配对回执的记录数 = 0', g.unpaired === 0, `${g.unpaired}（>0 说明有编辑调用没等到结果事件，指标按"没落盘"计）`)
  // 人群口径用**采样集合里真实出现的会话目录名**算（分母 = 采样到的会话数，不是“全库文件数”，
  // 也不是“取样文件数”）—— 后两个都会让这个比值算成一个假数（前者恒 >100%、后者把同一会话重复计）。
  const metaSessions = scope.sampledSessions.filter((s) => s.meta).length
  const metaSampled = scope.corpus.some((c) => c.workspace === META_WORKSPACE && c.sampled)
  add(
    '人群口径：默认运行时 deepseekharness（元）会话占比 ≤ 50%',
    scope.includeMeta || !metaSampled || scope.sampledSessions.length === 0 || metaSessions / scope.sampledSessions.length <= 0.5,
    !metaSampled
      ? '元会话未纳入取样（默认即如此）'
      : `${metaSessions}/${scope.sampledSessions.length} = ${pct(metaSessions, scope.sampledSessions.length)}`,
  )
  return { label: '记账自洽 + 人群口径', ok: items.every((i) => i.ok), items }
}

/**
 * 分层自检：**合成回执**喂 `classifyReceipt`，四类必须分到四个不同的桶。
 * 回执原文按会话日志里实测的形状写（各条都注明现实来源）。
 */
export function layeringSelftest() {
  const receipt = (name, isError, text) => ({ name, isError, text })
  const cases = [
    {
      label: '真落盘（aura_edit 实测形状：`<path>: N hunk(s) applied.` + 逐行 now）',
      receipt: receipt('aura_edit', false, 'E:\\ws\\audit\\human.md: 1 hunk(s) applied.\n  line 20 [exact] now: "  菜单是 \\"[1] 专用浏览器…\\"" +1 more line(s)'),
      wantBucket: 'wrote',
      wantWrote: true,
    },
    {
      label: '找不到（`isError=true` + 结构化目录回执）',
      receipt: receipt('aura_edit', true, 'Error: lines 425-432 via lines do not match assert\n\nThis file\'s structural directory — locate by name instead of guessing text:\n  function red_ink (lines 121-131)'),
      wantBucket: 'not_found',
      wantWrote: false,
    },
    {
      label: '需选择（引文不唯一 ⇒ 候选清单，且如实说没写盘）',
      receipt: receipt('aura_edit', false, '"main()" appears on 2 lines — cannot tell which one you meant; candidates: line 110 = "def main()", line 155 = "def main()"; nothing was written'),
      wantBucket: 'needs_choice',
      wantWrote: false,
    },
    {
      label: '已落地（幂等命中，`isError=false` 但本次调用没写盘）',
      receipt: receipt('aura_edit', false, 'E:\\ws\\bridge.py: outcome: already_applied — the file already holds the text you gave; nothing was written'),
      wantBucket: 'already_applied',
      wantWrote: false,
    },
    {
      label: '干跑（`Dry run for … — every hunk matched; nothing was written.` **同时**带 `N hunk(s) applied` 预告）',
      receipt: receipt('aura_edit', false, 'Dry run for E:\\ws\\bridge.py — every hunk matched; nothing was written.\nE:\\ws\\bridge.py: 1 hunk(s) applied.\n  line 579 [lines] now: "    # …and an entry whose fingerprint…"'),
      wantBucket: 'refused_other',
      wantWrote: false,
    },
    {
      label: '内置 edit 落盘（`The file … has been updated successfully.`）',
      receipt: receipt('edit', false, 'The file E:\\ws\\tmp\\c_gates_probe.py has been updated successfully.'),
      wantBucket: 'wrote',
      wantWrote: true,
    },
    {
      label: '参数错（无 isError、无落盘标志）',
      receipt: receipt('aura_edit', false, 'each hunk needs one of target / lines / anchor — pass `lines` as [a, b]; nothing was written'),
      wantBucket: 'refused_other',
      wantWrote: false,
    },
    {
      label: '没有 isError 字段（不成对的结果事件）',
      receipt: receipt('aura_edit', null, 'E:\\ws\\a.md: 1 hunk(s) applied.'),
      wantBucket: 'not_found',
      wantWrote: false,
    },
  ]
  const items = []
  const buckets = new Map()
  for (const c of cases) {
    const got = classifyReceipt(c.receipt)
    buckets.set(c.wantBucket, [...(buckets.get(c.wantBucket) ?? []), got.bucket])
    items.push({ name: c.label, ok: got.bucket === c.wantBucket && got.reallyWrote === c.wantWrote, detail: `桶=${got.bucket}（要 ${c.wantBucket}）/ 真落盘=${got.reallyWrote}（要 ${c.wantWrote}）` })
  }
  const four = ['wrote', 'not_found', 'needs_choice', 'already_applied']
  const distinct = new Set(four.map((b) => classifyReceipt(cases.find((c) => c.wantBucket === b).receipt).bucket))
  items.push({
    name: '分层自检：真落盘/找不到/需选择/已落地**四条分到四个不同的桶**',
    ok: distinct.size === 4,
    detail: `${[...distinct].join(' / ')}（不同桶数 ${distinct.size}，要 4）`,
  })
  const dry = classifyReceipt(cases.find((c) => c.wantBucket === 'refused_other' && /Dry run/.test(c.label)).receipt)
  items.push({
    name: '两层判据没退化：干跑那条 isError=false 却不算真落盘',
    ok: dry.isErrorFalse === true && dry.reallyWrote === false,
    detail: `isError=false ⇒ ${dry.isErrorFalse}；真落盘 ⇒ ${dry.reallyWrote}`,
  })
  return { label: '分层自检（合成回执）', ok: items.every((i) => i.ok), items }
}

// ── 用法 / 取样 / 报告 ───────────────────────────────────────────────────────────────

const DEFAULT_ROOT = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')

function usage(message) {
  process.stderr.write(`${message}\n\n用法：node aura-tools/probes/rework-rate.mjs [--workspaces=a,b] [--include-meta] [--max-files=N] [--since=ISO] [--until=ISO] [--json] [--selftest] [--root=DIR]\n`)
  process.exit(2)
}

function parseArgv(argv) {
  const valueOf = (flag) => {
    const hit = argv.find((a) => a === flag || a.startsWith(`${flag}=`))
    return hit === undefined ? null : hit.includes('=') ? hit.slice(flag.length + 1) : ''
  }
  const includeMeta = argv.includes('--include-meta')
  const json = argv.includes('--json')
  const selftest = argv.includes('--selftest')
  const workspacesRaw = valueOf('--workspaces')
  const sinceRaw = valueOf('--since')
  const untilRaw = valueOf('--until')
  const maxFilesRaw = valueOf('--max-files')
  const root = valueOf('--root') === null || valueOf('--root') === '' ? DEFAULT_ROOT : valueOf('--root')
  const since = sinceRaw === null || sinceRaw === '' ? 0 : Date.parse(sinceRaw)
  if (Number.isNaN(since)) usage(`--since 解析不了：${sinceRaw}（要 ISO 时间，如 2026-01-05T00:00）`)
  const until = untilRaw === null || untilRaw === '' ? Infinity : Date.parse(untilRaw)
  if (Number.isNaN(until)) usage(`--until 解析不了：${untilRaw}（要 ISO 时间）`)
  const maxFiles = maxFilesRaw === null || maxFilesRaw === '' ? 6 : Number(maxFilesRaw)
  if (!Number.isInteger(maxFiles) || maxFiles < 1) usage(`--max-files 要正整数：${maxFilesRaw}`)
  return { includeMeta, json, selftest, workspacesRaw, sinceRaw, untilRaw, since, until, maxFiles, root }
}

/** 点名工作区 → 目录名（精确优先，其次唯一模糊匹配）；去重后返回。 */
function resolveWorkspaces(workspacesRaw, includeMeta, root) {
  let all = []
  try {
    all = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    usage(`会话根目录读不了：${root}`)
  }
  const wanted = workspacesRaw === null || workspacesRaw === '' ? [...REAL_WORKSPACES] : workspacesRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  if (includeMeta && !wanted.includes(META_WORKSPACE)) wanted.push(META_WORKSPACE)
  const resolved = []
  for (const want of wanted) {
    const hit = all.includes(want) ? want : all.filter((d) => d.includes(want))
    if (hit === undefined || (Array.isArray(hit) && hit.length === 0)) usage(`点名的会话工作区不存在：${want}`)
    const dir = Array.isArray(hit) ? hit[0] : hit
    if (Array.isArray(hit) && hit.length > 1) process.stderr.write(`注意：\`${want}\` 模糊匹配到 ${hit.length} 个目录，取第一个 ${dir}\n`)
    if (!resolved.includes(dir)) resolved.push(dir)
  }
  return resolved
}

function candidatesOf(workspaceDir) {
  return [...sessionFiles(workspaceDir)].map((file) => {
    const stat = fs.statSync(file)
    return { file, bytes: stat.size, mtimeMs: stat.mtimeMs }
  })
}

const say = (text) => process.stdout.write(`${text}\n`)
const show = (value) => (value === null ? '—（分母为 0）' : value.toFixed(3))

const args = parseArgv(process.argv.slice(2))

if (args.selftest) {
  // `--selftest` 整轮可跑且 exit 0：只跑判据自检，不碰语料（语料无关 ⇒ 恒可复现）。
  const layering = layeringSelftest()
  say('=== 分层自检：合成回执 → 分桶（四类必须四个不同的桶）===')
  say('  判据原文：真落盘 =（isError=false）∧ 正文无 `nothing was written`/候选/已落地 ∧（落盘标志 ∨ 兜底）')
  for (const item of layering.items) say(`  ${item.ok ? '✓' : '✗'} ${item.name}：${item.detail}`)
  const synthetic = aggregate([
    { workspace: 'synthetic', session: 's1', calls: 4, auraEditCalls: 3, builtinEditCalls: 1, hunks: 4, noTurn: 0, edits: [
      { turn: '1', tool: 'aura_edit', file: 'a.md', order: 1, isError: false, reallyWrote: true, bucket: 'wrote' },
      { turn: '1', tool: 'aura_edit', file: 'a.md', order: 2, isError: true, reallyWrote: false, bucket: 'not_found' },
      { turn: '1', tool: 'aura_edit', file: 'a.md', order: 3, isError: false, reallyWrote: true, bucket: 'wrote' },
      { turn: '2', tool: 'edit', file: 'b.md', order: 4, isError: false, reallyWrote: true, bucket: 'wrote' },
    ] },
  ])
  const m = synthetic.metrics
  const accounting = [
    { name: '合成集的记账闭合（编辑 4 = 首次 2 + 返工 2）', ok: synthetic.global.edits === 4 && m.oneShotRate.den === 2 && m.reworkCalls.num === 2, detail: `编辑 ${synthetic.global.edits} = 首次 ${m.oneShotRate.den} + 返工 ${m.reworkCalls.num}` },
    { name: '合成集：自我修正率 1/1（a.md 上先失败后成功）', ok: m.selfCorrectRate.num === 1 && m.selfCorrectRate.den === 1, detail: `${m.selfCorrectRate.num}/${m.selfCorrectRate.den}` },
    { name: '合成集：返工后同一文件 2/3（a.md→a.md→a.md 两次同文件，a.md→b.md 一次换文件）', ok: m.reworkSameFile.num === 2 && m.reworkSameFile.den === 3, detail: `${m.reworkSameFile.num}/${m.reworkSameFile.den}` },
  ]
  for (const item of accounting) say(`  ${item.ok ? '✓' : '✗'} ${item.name}：${item.detail}`)
  const ok = layering.ok && accounting.every((i) => i.ok)
  say(`\n--- ${layering.items.length + accounting.length} 条判据：${layering.items.filter((i) => i.ok).length + accounting.filter((i) => i.ok).length} 通过 / ${(layering.ok ? 0 : layering.items.filter((i) => !i.ok).length) + accounting.filter((i) => !i.ok).length} 失败 ---`)
  say(`\n--selftest 结果：${ok ? '通过' : '失败'}（exit ${ok ? 0 : 1}）`)
  process.exit(ok ? 0 : 1)
}

// ── 默认路径：取样 → 读 → 聚合 → 报告 ────────────────────────────────────────────────

const workspaces = resolveWorkspaces(args.workspacesRaw, args.includeMeta, args.root)
const corpus = []
const files = []
const failures = []
for (const workspace of workspaces) {
  const dirPath = path.join(args.root, workspace)
  const all = candidatesOf(dirPath)
  const inWindow = all.filter((f) => f.mtimeMs >= args.since && f.mtimeMs <= args.until)
  const picked = [...inWindow].sort((a, b) => b.bytes - a.bytes).slice(0, args.maxFiles)
  corpus.push({
    workspace,
    meta: workspace === META_WORKSPACE,
    files: all.length,
    bytes: all.reduce((a, f) => a + f.bytes, 0),
    inWindow: inWindow.length,
    inWindowBytes: inWindow.reduce((a, f) => a + f.bytes, 0),
    sampled: picked.length > 0,
    sampledFiles: picked.length,
    sampledBytes: picked.reduce((a, f) => a + f.bytes, 0),
    picked: picked.map((p) => ({ name: path.basename(path.dirname(p.file)), bytes: p.bytes, mtime: stamp(p.mtimeMs), mtimeMs: p.mtimeMs })),
  })
  for (const item of picked) {
    let parsed
    try {
      const text = decompressAll(fs.readFileSync(item.file))
      parsed = parseSession(text, path.basename(path.dirname(item.file)))
    } catch (error) {
      failures.push(`${path.basename(path.dirname(item.file))}: ${String(error?.message ?? error).slice(0, 80)}`)
      continue
    }
    // 正文与参数在这里就没了：下面进 `files` 的只有紧凑记录（有界）。
    files.push({ workspace, bytes: item.bytes, mtimeMs: item.mtimeMs, ...parsed })
  }
}

const sampledTotal = corpus.reduce((a, c) => a + c.sampledFiles, 0)
const result = aggregate(files)
const sampledSessions = corpus.flatMap((c) => c.picked.map((p) => ({ session: p.name, workspace: c.workspace, meta: c.meta })))
const scope = { corpus, includeMeta: args.includeMeta, sampledTotal, sampledSessions, failures, window: { since: args.sinceRaw, until: args.untilRaw } }
const accounting = consistencyChecks(result, scope)
const layer = layeringSelftest()

const g = result.global
const m = result.metrics
const share = rate(g.auraEditCalls, g.calls)
const auraHunks = rate(g.hunks, g.auraEditCalls)
const meanHunks = rate(g.hunks, g.editCalls)
const bucketList = Object.entries(g.buckets).sort((a, b) => b[1] - a[1])
const sampledWindow = corpus.flatMap((c) => c.picked.map((p) => p.mtimeMs)).sort((a, b) => a - b)
const sampledBytes = corpus.reduce((a, c) => a + c.sampledBytes, 0)
const corpusBytes = corpus.reduce((a, c) => a + c.bytes, 0)

if (args.json) {
  const payload = {
    metrics: {
      oneShotRate: { value: m.oneShotRate.value, num: m.oneShotRate.num, den: m.oneShotRate.den },
      reworkCalls: { value: m.reworkCalls.value, num: m.reworkCalls.num, den: m.reworkCalls.den, tuplesWithRework: m.reworkCalls.tuplesWithRework, editCalls: g.edits },
      selfCorrectRate: { value: m.selfCorrectRate.value, num: m.selfCorrectRate.num, den: m.selfCorrectRate.den },
      reworkSameFile: { value: m.reworkSameFile.value, num: m.reworkSameFile.num, den: m.reworkSameFile.den, sameFileAfterFailure: result.extra.sameFileAfterFailure },
    },
    twoLayer: {
      isErrorFalseRate: rate(g.isErrorFalse, g.edits),
      isErrorFalse: { num: g.isErrorFalse, den: g.edits },
      reallyWroteRate: rate(g.reallyWrote, g.edits),
      reallyWrote: { num: g.reallyWrote, den: g.edits },
      buckets: g.buckets,
      howYouTellThem: '第一层 = tool/result content 的 isError===false；第二层 = 回执正文：含 `nothing was written`/候选/已落地措辞 ⇒ 没写盘，给出落盘标志（`N hunk(s) applied` / `has been updated successfully`）⇒ 真落盘，两者皆无 ⇒ 兜底按真落盘计。桶：wrote/not_found/needs_choice/already_applied/refused_other。',
    },
    extra: { tuplesWithRework: m.reworkCalls.tuplesWithRework, reworkHandoffs: result.extra.reworkHandoffs, prevFailed: result.extra.prevFailed, sameFileAfterFailure: result.extra.sameFileAfterFailure, noTurnEditCalls: g.noTurn, unpairedEdits: g.unpaired },
    sampleScope: {
      root: args.root,
      workspaces: corpus.map((c) => ({ workspace: c.workspace, meta: c.meta, files: c.files, bytes: c.bytes, inWindow: c.inWindow, inWindowBytes: c.inWindowBytes, sampledFiles: c.sampledFiles, sampledBytes: c.sampledBytes, picked: c.picked })),
      sampledTotal,
      sampledBytes,
      corpusBytes,
      sampledSessions,
      timeWindow: { since: args.sinceRaw, until: args.untilRaw, by: '会话文件 mtime' },
      sampledMtimeRange: sampledWindow.length === 0 ? null : [stamp(sampledWindow[0]), stamp(sampledWindow[sampledWindow.length - 1])],
      maxFilesPerWorkspace: args.maxFiles,
      readFailures: failures,
    },
    perWorkspace: result.perWorkspace.map((w) => ({ workspace: w.workspace, ...w })),
    reconcile: {
      auraEditShare: share,
      auraEditCalls: g.auraEditCalls,
      allCalls: g.calls,
      referenceAuraEditShare: REFERENCE.auraEditShare,
      meanHunksPerEdit: meanHunks,
      hunks: g.hunks,
      edits: g.editCalls,
      referenceMeanHunks: REFERENCE.auraEditHunks,
      // 参考读数那两个数**分两个口径**：占比的分母是全部调用，hunk 均值的分母是 aura_edit 调用（不含内置 edit，
      // 内置 edit 的参数里没有 hunks 这个概念）。两条都印，才看得出参考读数落在哪一格。
      auraEditMeanHunksPerCall: auraHunks,
      note: '只对账，不进判据：语料一变该改的是参考读数。',
    },
    selfChecks: [
      { name: accounting.label, ok: accounting.ok, items: accounting.items.map((i) => ({ name: i.name, ok: i.ok, detail: i.detail })) },
      { name: layer.label, ok: layer.ok, items: layer.items.map((i) => ({ name: i.name, ok: i.ok, detail: i.detail })) },
    ],
    exitCode: accounting.ok && layer.ok ? 0 : 1,
  }
  say(JSON.stringify(payload, null, 2))
  process.exit(payload.exitCode)
}

say('=== rework-rate：编辑返工与自我修正（「一次就改好」量具）===')
say('口径：三元组 = (会话, 回合=tool/call.data.turn, 文件)；只认编辑工具 aura_edit/edit；返工 = 同一三元组里第 2 次起的编辑调用')
say('')
say('── 四个指标 ─────────────────────────────────────────────────────────────')
say(`  ① 一次成功率        : ${show(m.oneShotRate.value)}   （首次就真落盘 ${num(m.oneShotRate.num)} / 三元组 ${num(m.oneShotRate.den)}）`)
say(`  ② 返工次数          : ${num(m.reworkCalls.num)} 次（占编辑调用 ${show(m.reworkCalls.value)}；有返工的三元组 ${num(m.reworkCalls.tuplesWithRework)} / ${num(m.reworkCalls.den)} = ${pct(m.reworkCalls.tuplesWithRework, m.reworkCalls.den)}）`)
say(`  ③ 自我修正率        : ${show(m.selfCorrectRate.value)}   （失败后紧接着成功 ${num(m.selfCorrectRate.num)} / 失败且后面还有编辑 ${num(m.selfCorrectRate.den)}）`)
say(`  ④ 返工后同一文件    : ${show(m.reworkSameFile.value)}   （上一次编辑还是同一文件 ${num(m.reworkSameFile.num)} / 返工条数 ${num(m.reworkSameFile.den)}；其中"上一次失败"的 ${num(result.extra.sameFileAfterFailure)}/${num(m.reworkSameFile.den)}）`)
say('')
say('── 两层成功判据（第一层 = isError=false；第二层 = 从回执正文分层）──────────────')
say(`  第一层 isError=false : ${pct(g.isErrorFalse, g.edits)}  （${num(g.isErrorFalse)} / 编辑调用 ${num(g.edits)}）`)
say(`  其中真的落盘         : ${pct(g.reallyWrote, g.edits)}  （${num(g.reallyWrote)} / ${num(g.edits)}）⇒ 第一层里有 ${num(g.isErrorFalse - g.reallyWrote)} 次是"如实拒绝/干跑/已落地"，被第一层算成了成功`)
say(`  真落盘占 isError=false: ${pct(g.reallyWrote, g.isErrorFalse)}`)
say(`  第二层分桶           : ${bucketList.length === 0 ? '—' : bucketList.map(([k, n]) => `${k} ${num(n)}（${pct(n, g.edits)}）`).join(' · ')}`)
say('  判据原文             : 真落盘 =（isError=false）∧ 正文无 `nothing was written`/候选/已落地 ∧（有落盘标志 ∨ 兜底支）')
say('')
say('── 样本范围（窗口读数必须自报边界与样本数）────────────────────────────────')
say(`  会话根               : ${args.root}`)
say(`  时间窗（文件 mtime） : ${args.sinceRaw ?? '(无下界)'} ~ ${args.untilRaw ?? '(无上界)'}${args.sinceRaw === null && args.untilRaw === null ? '（未设 ⇒ 全时段）' : ''}`)
say(`  取样上界             : 每工作区按字节降序取 ${args.maxFiles} 个（--max-files；有界读法：一次一个文件，峰值内存 ≈ 最大单文件）`)
say(`  全库人口普查         : 点名工作区合计 ${num(corpus.reduce((a, c) => a + c.files, 0))} 个会话文件 / ${mb(corpusBytes)}`)
for (const c of corpus) {
  say(`    · ${c.workspace}${c.meta ? '（元会话，对照）' : ''}：全部 ${num(c.files)} 个 / ${mb(c.bytes)} ｜ 窗内 ${num(c.inWindow)} 个 / ${mb(c.inWindowBytes)} ｜ **取样 ${num(c.sampledFiles)} 个 / ${mb(c.sampledBytes)}**`)
}
say(`  采样合计             : ${num(sampledTotal)} 个 / ${mb(sampledBytes)}（占点名语料 ${pct(sampledBytes, corpusBytes)} 字节）`)
say(`  采样 mtime 范围      : ${sampledWindow.length === 0 ? '—' : `${stamp(sampledWindow[0])} ~ ${stamp(sampledWindow[sampledWindow.length - 1])}`}`)
say(`  读失败 / 没等到回执  : ${failures.length} 个文件读失败；${num(g.unpaired)} 条编辑记录没等到结果事件；${num(g.noTurn)} 次编辑调用没有 turn 字段（归 (无turn)）`)
say('  （逐条样本清单在 --json 的 sampleScope.workspaces[].picked 里）')
say('')
say('── 逐工作区 ─────────────────────────────────────────────────────────────')
for (const workspace of new Set(files.map((f) => f.workspace))) {
  const sub = aggregate(files.filter((f) => f.workspace === workspace))
  const w = sub.global
  say(`  · ${workspace}：编辑调用 ${num(w.edits)}（aura_edit ${num(w.auraEditCalls)} / 内置 edit ${num(w.builtinEditCalls)}）｜ 真落盘 ${pct(w.reallyWrote, w.edits)} ｜ isError=false ${pct(w.isErrorFalse, w.edits)} ｜ 一次成功率 ${show(sub.metrics.oneShotRate.value)}（${num(sub.metrics.oneShotRate.num)}/${num(sub.metrics.oneShotRate.den)}）｜ 返工 ${num(sub.metrics.reworkCalls.num)} 次 ｜ 自我修正 ${num(sub.metrics.selfCorrectRate.num)}/${num(sub.metrics.selfCorrectRate.den)}`)
}
if (result.bySum.edits !== g.edits) say('  ✗ 逐工作区汇总 ≠ 全局')
say('')
say('── 与参考读数对账（只对账，不进判据）──────────────────────────────────────')
say(`  aura_edit 占全部调用 : ${pct(g.auraEditCalls, g.calls)}（${num(g.auraEditCalls)} / ${num(g.calls)}；参考 ≈ ${(REFERENCE.auraEditShare * 100).toFixed(0)}%）`)
say(`  平均 hunk / aura_edit: ${auraHunks === null ? '—' : auraHunks.toFixed(2)}（hunk ${num(g.hunks)} / aura_edit 调用 ${num(g.auraEditCalls)}；参考 ${REFERENCE.auraEditHunks}）← 参考那个 1.67 的分母是 aura_edit，不是全部编辑`)
say(`  平均 hunk / 次编辑   : ${meanHunks === null ? '—' : meanHunks.toFixed(2)}（hunk ${num(g.hunks)} / 全部编辑调用 ${num(g.edits)}，含内置 edit ${num(g.builtinEditCalls)} 次 —— 它的参数里没有 hunks 概念）`)
say('')
say('── 判定力（退出码挂钩）──────────────────────────────────────────────────')
for (const item of accounting.items) say(`  ${item.ok ? '✓' : '✗'} ${item.name}：${item.detail}`)
for (const item of layer.items) say(`  ${item.ok ? '✓' : '✗'} ${item.name}：${item.detail}`)
const total = accounting.items.length + layer.items.length
const passed = accounting.items.filter((i) => i.ok).length + layer.items.filter((i) => i.ok).length
say(`\n--- ${total} 条判据：${passed} 通过 / ${total - passed} 失败 ---`)
const exitCode = accounting.ok && layer.ok ? 0 : 1
say(`\n结果：${exitCode === 0 ? '通过' : '失败'}（exit ${exitCode}；2 = 用法错）`)
process.exit(exitCode)

