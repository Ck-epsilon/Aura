/**
 * multi-target-adoption.mjs —— M0 量具：给两个工具装上"一次调用多目标"之后，agent 到底会不会用它？
 *
 *   node aura-tools/probes/multi-target-adoption.mjs [--workspaces=a,b] [--include-meta]
 *        [--max-files=N] [--since=ISO] [--until=ISO] [--json] [--expect-baseline] [--root=DIR]
 *   node aura-tools/probes/multi-target-adoption.mjs --capture-baseline [--out=PATH] [同样的取样旋钮]
 *
 * ## 预注册的判据口径（**已定死；量具只负责把它做成量具，不许改它**）
 *
 *   ① 每回合调用数       = 工具调用数 / 含调用的回合数
 *   ② 跨文件回合占比     = 一次回合里触及 ≥2 个不同 file_path 的回合 / 含调用的回合
 *   ③ 每次调用携带目标数 = 文件目标总数 / 带目标的文件工具调用数（今天恒为 1.00）
 *      附：每次编辑的 hunk 数分布 —— 今天"一次调用带多个目标"的唯一形态是多 hunk 编辑，
 *      所以③若恒为 1，必须靠这份分布才读得出"有没有在往一次调用里塞东西"。
 *   参考读数：调用构成（各工具调用数占比）、编辑调用里 aura_edit vs 内置 edit 的比例。
 *
 * ## 取样口径（**这是本文件唯一的口径，不许为了让数字好看而动它**）
 *
 *   · 真实任务人群 = `--E-workspaces-agent-browser-bridge--` + `--E-workspaces-AuraPolaris--`（单子点名）；
 *     元会话（造工具的那个工作区）默认**排除**，`--include-meta` 才纳入做对照。
 *   · **不按 mtime 取样**：那正是已经犯过的采样错误（最新的会话恰恰是造工具的元会话）。
 *     每工作区按**体积从大到小**取 N 个（N = `--max-files`，默认 10）—— 两个工作区**同一个 N**。
 *   · `--since` / `--until` 按**会话文件 mtime** 过滤 —— 这就是"装上多目标之前 vs 之后"的切分口径。
 *     `--since=<T>` 时本命令**自产镜像窗**（`--until=<T>`）并把两窗并排印出来：采用对照是**一次调用**的
 *     产物，不是两次调用让人去对齐。
 *   · 有界：只读被选中的文件，且**一次只读一个、读完即丢文本**。会话库 700 MB 级、zstd 多帧，
 *     整库进内存会把 node 读爆（`--max-old-space-size` 不是办法，**取样上界**才是），
 *     所以 `--max-files` 是硬上界，峰值内存 ≈ 被选中的最大单个会话文件。
 *
 * ## 基线从哪来（**本文件被修过的地方：基线必须由本量具自己采，不许第二个实现**）
 *
 *   · `--capture-baseline` 跑**本量具自己的计数路径**（就是下面 `measure()` 这条路），把数字连同
 *     **口径**（root / 工作区集 / 每工作区 N / since / until / 人群 / 样本清单 + 指纹）就地写回本文件
 *     基线区（两行标记 CAPTURED-BASELINE-BEGIN / CAPTURED-BASELINE-END 之间的那一段；`--out=PATH` 改落点）。
 *     说明里不写带 `// ==` 前缀的**完整**标记行 —— 早先捕获器按 `indexOf` 裸找标记，就在这行说明里
 *     先撞上了那一对名字，把基线块插进了注释中间（内容没丢，但文件当场解析不了）。现在只认整行标记，
 *     而且写完当场 `node --check` 自查、过不了就回滚。
 *     存进去的口径**完整到能让后一次跑自己判断"口径同不同"**，不必靠人记。
 *   · 旧版 BASELINE 是"先前用手写脚本量到的"—— 那是**第二个实现**：它自己的注释写着"每工作区 N=10"，
 *     却给 ws1 存了 16 个文件，于是写回合那几格差了 +400%。差的不是漂移，是**定义**。手抄数字已全部删掉。
 *   · M0 装上多目标**之前**的 headline（区里的 `headline` 钉住的就是它）：
 *     **多目标调用数 = 0 / 每次调用目标数 = 1.00** —— 装上之后这两格该动，所以只作对照印出，
 *     **不进 ±20% 对账**（拿 0 当分母算不出容差）。
 *
 * ## 判定力（退出码，0 绿 / 1 红 / 2 用法错）
 *
 *   · 记账自洽：三个数的分子分母必须自洽（跨文件回合 ≤ 含调用回合、hunk 分布之和 = aura_edit
 *     调用数、逐工作区汇总 = 全局汇总 …）；任一条不成立 ⇒ 红。
 *   · 人群口径自检：点名人群里"元会话文件数 > 真实任务文件数"，或**扫到的文件里元会话占比 > 50%**
 *     ⇒ 红并提示 —— 防的就是"用最近修改取样、结果取到造工具的元会话"那个错。
 *   · 镜像窗（`--since=<T>` 时自动算的那一窗）同样过上面两类自检：并排印出来的对照不许是坏账。
 *   · `--expect-baseline`（容差 **±20%**，一格都没放宽）分三步：
 *     ① 基线**自己的口径**要完整且自洽（workspaces × N = 取样文件数、样本清单条数对得上、
 *        指纹是 64 位十六进制、对账的五格字段都在）—— 缺字段或算术不成立 ⇒ 红，逐条点名；
 *     ② 本次调用的口径要与基线**逐字段相同**（root / 工作区集 / N / includeMeta / since / until / 样本指纹）。
 *        不同 ⇒ 印 `⊘ 口径不符：<字段> 基线 X vs 本次 Y`，**这一节不判**（既不计通过也不计失败，
 *        退出码不受本节影响）—— 与 `src/locator-lab/anchor-cache-test.mjs` 的 ⊘ 同一形态：
 *        前提不成立时明写跳过，既不静默放过、也不把数放宽；
 *     ③ 口径一致才逐格对账，±20% 不变；对不上 ⇒ 红。它证的是"量具没走样"，不是"引擎没回归"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { decompressAll } from './session-log.mjs'

const SESSION_FILE = 'session.v3.jsonl.zstd'
/** 本文件自己的路径：`--capture-baseline` 默认就地重写下面那一段（只改两行标记之间）。 */
const SELF_FILE = fileURLToPath(import.meta.url)
/** 基线区标记（采样器按这两行定位；标记本身不许删、不许改）。 */
const BASELINE_BEGIN = '// == CAPTURED-BASELINE-BEGIN =='
const BASELINE_END = '// == CAPTURED-BASELINE-END =='

/** 单子点名的真实任务人群（默认取样集）。 */
export const REAL_WORKSPACES = ['--E-workspaces-agent-browser-bridge--', '--E-workspaces-AuraPolaris--']
/** 单子点名的元会话工作区（默认排除，`--include-meta` 纳入）。 */
export const META_WORKSPACE = '--E-workspaces-deepseekharness--'

/**
 * 参考基线（**由本量具自己的计数路径采到，不是第二个实现**）：
 * `node aura-tools/probes/multi-target-adoption.mjs --capture-baseline` 就地重写下面这一段。
 *
 * 每一格数字都连同**取样口径**存在一起（root / 工作区集 / 每工作区 N / since / until / 人群 /
 * 样本清单 + 样本指纹）—— 存得够全，后一次跑才能**自己判断"口径同不同"**，不必靠人记：
 *   · 口径逐字段相同 ⇒ 才逐格对账（容差 ±20%）；
 *   · 不同 ⇒ 印 `⊘ 口径不符：<字段> 基线 X vs 本次 Y`，**这一节不判**（退出码不受它影响）；
 *   · 这一段自己的口径缺字段 / 算术不自洽 ⇒ 红（逐条点名），因为那样的基线判不了任何东西。
 * 未显式给旋钮时，`--expect-baseline` 按这一段的 `until`（= 采样那一刻）取样 —— 这就是"人口冻结"的落点。
 *
 * M0 装上多目标**之前**的 headline（本段 `headline` 钉住的就是它）：
 *   **多目标调用数 = 0 / 每次调用目标数 = 1.00**。装上之后这两格应当动起来，
 * 所以只作对照印出，**不进 ±20% 对账**（拿 0 当分母算不出容差）。
 */
// == CAPTURED-BASELINE-BEGIN ==
export const BASELINE = {
  capturedAt: "2026-10-15T19:30:44.880Z",
  capturedBy: "node aura-tools/probes/multi-target-adoption.mjs --capture-baseline",
  instrument: "本量具自己的计数路径（measure）；不是第二个实现",
  scope: {
    root: "C:\\Users\\cxk\\.dsh\\sessions",
    workspaces: ["--E-workspaces-agent-browser-bridge--", "--E-workspaces-AuraPolaris--"],
    maxFiles: 10,
    sampledFiles: 20,
    includeMeta: false,
    since: null,
    until: "2026-10-15T19:30:37.928Z",
    populationSha256: "59a201906a1b0f7e4c4f81f38c436814b71cdb0acbba80ebc7b9e2d2c96b3dcd",
    // 基线取样清单（逐文件的证据；口径一致时本次取样应与它逐条相同）
    sample: [
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-614f227f-8e00-4e29-9265-56eb4bd17259", bytes: 29669726, mtime: "2026-09-26T06:56:31.326Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-df69c82b-dbc0-4b3a-9a2b-e39dbef6fc5c", bytes: 14272831, mtime: "2026-10-13T23:17:13.257Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-a7751452-5efb-430d-a9e5-1ae56883ccce", bytes: 14106276, mtime: "2026-09-20T23:24:13.046Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-8de441cd-14d9-422f-941e-23e57d0ca29b", bytes: 11252323, mtime: "2026-09-24T03:20:52.919Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-cecf0973-7e00-4c81-826f-56d8f04cfc7a", bytes: 9068001, mtime: "2026-10-13T23:17:12.380Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-58107562-1378-4f1d-a31b-35a51770830a", bytes: 7934578, mtime: "2026-09-27T14:51:26.682Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-ed7194b2-65a3-400b-8975-c7bb808c24e9", bytes: 7143482, mtime: "2026-09-24T03:20:52.605Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "18ab2eac-a4b1-480f-81c9-a095c09dc5f2", bytes: 3826480, mtime: "2026-09-21T14:43:44.287Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-5ab3e608-9e52-4378-b7a8-5e90c5941935", bytes: 3686030, mtime: "2026-10-13T23:17:09.567Z" },
      { workspace: "--E-workspaces-agent-browser-bridge--", name: "session-8b30fccd-0795-4d1a-b450-04e2a716b613", bytes: 2947313, mtime: "2026-10-15T14:47:22.074Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "session-0db90cf5-6358-4ebc-94dd-fd8666b210be", bytes: 22935269, mtime: "2026-10-13T23:19:20.092Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "session-cade46e7-dcde-4bb5-ab42-2a890934f2d7", bytes: 15638752, mtime: "2026-09-28T14:07:12.579Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "129dea4d-fe0f-4aee-bfe1-003915c0135a", bytes: 1990419, mtime: "2026-09-29T17:56:53.415Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "aee3ab5d-ff74-45ed-8835-42b1d70dd496", bytes: 1896014, mtime: "2026-09-29T15:07:30.702Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "3309033e-5f80-42a8-b771-c752c96e0b7b", bytes: 1681101, mtime: "2026-09-28T02:28:18.112Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "8d40758e-c00d-4f18-b4cf-b936b2852f23", bytes: 1614180, mtime: "2026-10-07T19:32:59.107Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "b65c1b1b-af82-42bc-bceb-a998bc57b9f0", bytes: 1527878, mtime: "2026-09-29T04:30:31.717Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "a4e68c22-b565-4f64-b753-959c5c66f3b5", bytes: 1512983, mtime: "2026-09-27T18:23:44.531Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "faeaf38b-fd6e-4cd7-9226-2e2092097f4f", bytes: 1479008, mtime: "2026-09-29T08:35:15.552Z" },
      { workspace: "--E-workspaces-AuraPolaris--", name: "c70bc607-1012-44ed-9eb5-920b7437f0bb", bytes: 1458800, mtime: "2026-09-27T15:35:47.948Z" },
    ],
  },
  // headline = 装上多目标**之前**的对照读数（多目标调用数 = 0 / 每次调用目标数 = 1.00）：
  // 只印不判 —— 装上之后这两格本来就该动，拿 0 当分母也算不出 ±20%。
  headline: {
    "--E-workspaces-agent-browser-bridge--": { multiTargetCalls: 0, targetsPerCall: 1, callsWithTargets: 10114, totalTargets: 10114 },
    "--E-workspaces-AuraPolaris--": { multiTargetCalls: 0, targetsPerCall: 1, callsWithTargets: 2265, totalTargets: 2265 },
  },
  cells: {
    "--E-workspaces-agent-browser-bridge--": {
      files: 10, auraEditCalls: 2114, distinctAuraEditFiles: 331,
      writeTurns: 174, crossFileWriteTurns: 108, meanHunksPerEdit: 1.484863,
    },
    "--E-workspaces-AuraPolaris--": {
      files: 10, auraEditCalls: 827, distinctAuraEditFiles: 154,
      writeTurns: 128, crossFileWriteTurns: 56, meanHunksPerEdit: 1.5526,
    },
  },
}
// == CAPTURED-BASELINE-END ==
export const BASELINE_TOLERANCE = 0.2

/** 对账的五格（对账名 — `cells` 里的键）；这一串是**既有判据**，不许删、不许放宽。 */
export const RECONCILE_CELLS = [
  ['aura_edit 调用数', 'auraEditCalls'],
  ['aura_edit 触及的不同文件数', 'distinctAuraEditFiles'],
  ['写回合数（含 aura_edit 的回合）', 'writeTurns'],
  ['写回合里跨 ≥2 文件的回合数', 'crossFileWriteTurns'],
  ['平均 hunk 数 / 次编辑', 'meanHunksPerEdit'],
]

/** 会带文件目标的工具（"读写"人群）。`present` 的 `files` 是交付物、不是读写目标，故意不收。 */
export const FILE_TOOLS = new Set(['aura_read', 'aura_edit', 'read', 'edit', 'write'])
const PATH_KEYS = new Set(['file_path', 'filePath', 'path'])

const say = (m) => process.stdout.write(`${m}\n`)
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n))
const pct = (part, whole) => (whole === 0 ? '—（分母 0）' : `${((100 * part) / whole).toFixed(1)}%`)
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const round6 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null)
const fix2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : '—')
/** 相对变化（之后 vs 之前）；分母 0 或任一侧缺 ⇒ '—'（不编数）。 */
const relDelta = (before, after) => (typeof before !== 'number' || typeof after !== 'number' || before === 0 ? '—' : `${after >= before ? '+' : ''}${((100 * (after - before)) / before).toFixed(1)}%`)
/** 占比的变化按**百分点**（pp）读，比"相对变化 +x%"不易误读。 */
const ppDelta = (before, after) => (typeof before !== 'number' || typeof after !== 'number' ? '—' : `${after >= before ? '+' : ''}${(100 * (after - before)).toFixed(1)}pp`)
const CJK = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/
const wide = (s) => [...String(s)].reduce((a, ch) => a + (CJK.test(ch) ? 2 : 1), 0)
/** 按**显示列宽**补空格：`padEnd` 按码元算，中文一多并排表就错位。 */
const col = (s, w) => { const t = String(s); return `${t}${' '.repeat(Math.max(0, w - wide(t)))}` }

/**
 * 一次调用带了哪些文件目标。
 *
 * 递归收集**路径类键**的字符串值（深度 ≤ 4）——今天单目标形状只有 `file_path`（=1）；
 * 装上多目标之后，无论未来长成 `{targets:[{file_path},{file_path}]}` 还是
 * `{hunks:[{file_path},…]}`，这里都自然读成 2、3…，不必改量具。
 * 只认路径类键，所以 `replace` / `old` / `line_cue` 这些正文键不会被误当成目标。
 */
export function pathsOf(args) {
  const out = new Set()
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 4) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (PATH_KEYS.has(key) && typeof value === 'string' && value.length > 0) out.add(value)
      else if (value !== null && typeof value === 'object') walk(value, depth + 1)
    }
  }
  walk(args, 0)
  return [...out]
}

/** 解压后的会话正文 → `{ turnsStarted, calls }`；每次调用只留**紧凑记录**（正文不留，省内存）。 */
export function parseSessionText(text) {
  let turnsStarted = 0
  const calls = []
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/call"') && !line.includes('"turn/start"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // 坏行忽略（与 session-log 同口径）
    }
    if (event?.type === 'turn/start') {
      turnsStarted += 1
      continue
    }
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (typeof name !== 'string') continue
    let args = event.data?.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = null
      }
    }
    calls.push({
      turn: typeof event.data?.turn === 'number' ? event.data.turn : null,
      name,
      paths: pathsOf(args),
      hunks: name === 'aura_edit' && Array.isArray(args?.hunks) ? args.hunks.length : null,
    })
  }
  return { turnsStarted, calls }
}

/**
 * 计数器：喂紧凑调用记录，产出这一格的**全部数字（含每个分母）**。
 * 逐工作区一个 + 全局一个（两个独立实例，用来互相对账 —— 那个自洽判据才不空转）。
 */
export function counters() {
  const turns = new Map() // 回合键 → 该回合的累积
  const hunkBuckets = new Map()
  const callMix = new Map()
  const auraEditFiles = new Set()
  const stat = { filesRead: 0, sessions: 0, turnsStarted: 0, calls: 0, callsWithoutTurn: 0, fileToolCalls: 0, callsWithTargets: 0, totalTargets: 0, multiTargetCalls: 0, auraEditCalls: 0, builtinEditCalls: 0, totalHunks: 0, auraEditWithHunks: 0 }
  let normalize = (p) => p

  return {
    /** @param file - `{ key, cwd, turnsStarted, calls }` */
    add(file) {
      stat.filesRead += 1
      if (file.calls.length > 0) stat.sessions += 1
      stat.turnsStarted += file.turnsStarted
      normalize = (p) => (file.cwd === null ? path.normalize(p) : path.resolve(file.cwd, p)).toLowerCase()
      for (const call of file.calls) {
        stat.calls += 1
        bump(callMix, call.name)
        const turnKey = `${file.key}\u0000${call.turn === null ? '(无turn)' : call.turn}`
        if (call.turn === null) stat.callsWithoutTurn += 1
        let bucket = turns.get(turnKey)
        if (bucket === undefined) {
          bucket = { calls: 0, allPaths: new Set(), editPaths: new Set(), auraEdits: 0 }
          turns.set(turnKey, bucket)
        }
        bucket.calls += 1

        const paths = call.paths.map(normalize)
        for (const p of paths) bucket.allPaths.add(p)
        if (FILE_TOOLS.has(call.name)) {
          stat.fileToolCalls += 1
          if (paths.length > 0) {
            stat.callsWithTargets += 1
            stat.totalTargets += paths.length
            if (paths.length >= 2) stat.multiTargetCalls += 1
          }
        }
        if (call.name === 'aura_edit') {
          stat.auraEditCalls += 1
          for (const p of paths) auraEditFiles.add(p)
          bucket.auraEdits += 1
          for (const p of paths) bucket.editPaths.add(p)
          if (call.hunks === null) bump(hunkBuckets, 'create/无 hunks')
          else {
            stat.totalHunks += call.hunks
            stat.auraEditWithHunks += 1
            bump(hunkBuckets, String(call.hunks))
          }
        } else if (call.name === 'edit') {
          stat.builtinEditCalls += 1
        }
      }
    },
    /** @returns 这一格的全部读数；每个比值都自带分子分母 */
    figures() {
      let turnsWithCalls = 0
      let crossFileTurns = 0
      let writeTurns = 0
      let crossFileWriteTurns = 0
      let crossFileWriteTurnsAnyTool = 0
      for (const bucket of turns.values()) {
        turnsWithCalls += 1
        const allCross = bucket.allPaths.size >= 2
        if (allCross) crossFileTurns += 1
        if (bucket.auraEdits > 0) {
          writeTurns += 1
          if (bucket.editPaths.size >= 2) crossFileWriteTurns += 1
          if (allCross) crossFileWriteTurnsAnyTool += 1
        }
      }
      const hunkDistribution = {}
      for (const [key, count] of [...hunkBuckets].sort((a, b) => (a[0] === 'create/无 hunks' ? 1 : b[0] === 'create/无 hunks' ? -1 : Number(a[0]) - Number(b[0])))) hunkDistribution[key] = count
      const hunkBucketsTotal = [...hunkBuckets.values()].reduce((a, b) => a + b, 0)
      const editCallsTotal = stat.auraEditCalls + stat.builtinEditCalls
      return {
        filesRead: stat.filesRead,
        sessions: stat.sessions,
        turnsStarted: stat.turnsStarted,
        calls: stat.calls,
        callsWithoutTurn: stat.callsWithoutTurn,
        turnsWithCalls,
        callsPerTurn: turnsWithCalls === 0 ? null : stat.calls / turnsWithCalls,
        crossFileTurns,
        crossFileTurnShare: turnsWithCalls === 0 ? null : crossFileTurns / turnsWithCalls,
        writeTurns,
        crossFileWriteTurns,
        crossFileWriteTurnsAnyTool,
        crossFileWriteTurnShare: writeTurns === 0 ? null : crossFileWriteTurns / writeTurns,
        fileToolCalls: stat.fileToolCalls,
        callsWithTargets: stat.callsWithTargets,
        totalTargets: stat.totalTargets,
        targetsPerCall: stat.callsWithTargets === 0 ? null : stat.totalTargets / stat.callsWithTargets,
        multiTargetCalls: stat.multiTargetCalls,
        multiTargetShare: stat.callsWithTargets === 0 ? null : stat.multiTargetCalls / stat.callsWithTargets,
        auraEditCalls: stat.auraEditCalls,
        builtinEditCalls: stat.builtinEditCalls,
        editCallsTotal,
        auraEditShare: editCallsTotal === 0 ? null : stat.auraEditCalls / editCallsTotal,
        totalHunks: stat.totalHunks,
        auraEditWithHunks: stat.auraEditWithHunks,
        hunkDistribution,
        hunkBucketsTotal,
        meanHunksPerEdit: stat.auraEditCalls === 0 ? null : stat.totalHunks / stat.auraEditCalls,
        meanHunksPerHunkedEdit: stat.auraEditWithHunks === 0 ? null : stat.totalHunks / stat.auraEditWithHunks,
        distinctAuraEditFiles: auraEditFiles.size,
        callMix: Object.fromEntries([...callMix].sort((a, b) => b[1] - a[1])),
        callMixTotal: [...callMix.values()].reduce((a, b) => a + b, 0),
      }
    },
  }
}

/** 记账自洽：三条"分子分母必须自洽"的不变式（逐工作区 + 全局都查）。 */
export function consistencyChecks(label, f) {
  const items = []
  const add = (name, ok, detail) => items.push({ name, ok, detail })
  add('跨文件回合数 ≤ 含调用回合数', f.crossFileTurns <= f.turnsWithCalls, `${f.crossFileTurns} ≤ ${f.turnsWithCalls}`)
  add('写回合跨文件数 ≤ 写回合数', f.crossFileWriteTurns <= f.writeTurns, `${f.crossFileWriteTurns} ≤ ${f.writeTurns}`)
  add('hunk 分布之和 = aura_edit 调用数', f.hunkBucketsTotal === f.auraEditCalls, `${f.hunkBucketsTotal} = ${f.auraEditCalls}`)
  add('带目标调用数 ≤ 文件工具调用数 ≤ 全部调用数', f.callsWithTargets <= f.fileToolCalls && f.fileToolCalls <= f.calls, `${f.callsWithTargets} ≤ ${f.fileToolCalls} ≤ ${f.calls}`)
  add('目标总数 ≥ 带目标调用数（每次至少 1 个）', f.totalTargets >= f.callsWithTargets, `${f.totalTargets} ≥ ${f.callsWithTargets}`)
  add('多目标调用数 ≤ 带目标调用数', f.multiTargetCalls <= f.callsWithTargets, `${f.multiTargetCalls} ≤ ${f.callsWithTargets}`)
  add('含调用回合数 ≤ turn/start 数', f.turnsStarted === 0 || f.turnsWithCalls <= f.turnsStarted, `${f.turnsWithCalls} ≤ ${f.turnsStarted}`)
  add('调用构成合计 = 调用总数', f.callMixTotal === f.calls, `${f.callMixTotal} = ${f.calls}`)
  add('编辑调用 = aura_edit + 内置 edit', f.editCallsTotal === f.auraEditCalls + f.builtinEditCalls, `${f.editCallsTotal} = ${f.auraEditCalls} + ${f.builtinEditCalls}`)
  return { label, ok: items.every((i) => i.ok), items }
}

/** 会话文件枚举（与 session-log 同深度上限，避免两处口径漂移）。 */
function sessionFilesIn(dir, depth = 0) {
  if (depth > 5) return []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sessionFilesIn(full, depth + 1))
    else if (entry.name === SESSION_FILE) out.push(full)
  }
  return out
}

/** 会话文件清单（带体积与 mtime），**不解压**；体积降序 —— 取样口径的落点。 */
function candidatesOf(workspaceDir) {
  const files = sessionFilesIn(workspaceDir)
  return files.map((file) => {
    const stat = fs.statSync(file)
    return { file, bytes: stat.size, mtimeMs: stat.mtimeMs }
  })
}

/**
 * 取**一个时间窗**的样本（主窗与镜像窗共用这一条路径 —— "之前 vs 之后"两个数必须出自同一份代码，
 * 否则那份对照又变成两个实现）。有界：只读被选中的文件，一次一个、读完即丢正文。
 */
function sampleWindow({ root, workspaces, sinceMs, untilMs, maxFiles }) {
  const scope = []
  const rows = []
  const readFailures = []
  let decompressedBytes = 0
  for (const workspace of workspaces) {
    const dirPath = path.join(root, workspace)
    const all = candidatesOf(dirPath)
    const inWindow = all.filter((f) => f.mtimeMs >= sinceMs && f.mtimeMs <= untilMs)
    const picked = [...inWindow].sort((a, b) => b.bytes - a.bytes).slice(0, maxFiles)
    const meta = workspace === META_WORKSPACE
    for (const item of picked) {
      // 逐文件解压 → 解析 → **立刻丢掉正文**：峰值内存 ≈ 被选中的最大单个文件，与文件数无关。
      // （整库读爆 node 那一次就是因为把正文留在了内存里；--max-old-space-size 治不了它，取样上界才是。）
      let text = ''
      try {
        text = decompressAll(fs.readFileSync(item.file))
      } catch (error) {
        readFailures.push({ file: item.file, error: String(error?.message ?? error) })
        continue
      }
      decompressedBytes += Buffer.byteLength(text, 'utf8')
      const parsed = parseSessionText(text)
      rows.push({ workspace, file: item.file, key: item.file, bytes: item.bytes, mtimeMs: item.mtimeMs, cwd: cwdOf(text), turnsStarted: parsed.turnsStarted, calls: parsed.calls })
    }
    const mtimes = picked.map((p) => p.mtimeMs)
    scope.push({
      workspace,
      meta,
      candidateFiles: all.length,
      candidateBytes: all.reduce((a, f) => a + f.bytes, 0),
      excludedByTime: all.length - inWindow.length,
      pickedFiles: picked.length,
      pickedBytes: picked.reduce((a, f) => a + f.bytes, 0),
      mtimeMin: mtimes.length === 0 ? null : stamp(Math.min(...mtimes)),
      mtimeMax: mtimes.length === 0 ? null : stamp(Math.max(...mtimes)),
      files: picked.map((p) => ({ name: path.basename(path.dirname(p.file)), bytes: p.bytes, mtime: stamp(p.mtimeMs) })),
      allCandidatesSortedBySize: [...inWindow].sort((a, b) => b.bytes - a.bytes).map((p) => path.basename(path.dirname(p.file))),
    })
  }
  const scannedMeta = scope.filter((s) => s.meta).reduce((a, s) => a + s.pickedFiles, 0)
  const scannedTotal = scope.reduce((a, s) => a + s.pickedFiles, 0)
  return { scope, rows, readFailures, decompressedBytes, scannedMeta, scannedTotal, populationSha256: fingerprint(rows) }
}

/** 样本集指纹：**逐文件**（绝对路径 + mtime + 体积）的 sha256 —— "口径同不同"最硬的一条证据。 */
function fingerprint(rows) {
  const h = createHash('sha256')
  for (const r of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) h.update(`${r.key}\u0000${Math.round(r.mtimeMs)}\u0000${r.bytes}\n`)
  return h.digest('hex')
}

/** 人群口径自检的两条（防"取样取到造工具的元会话"那个错）——每个窗各查一遍。 */
function populationItems(census, scannedMeta, scannedTotal) {
  return [
    { name: '点名人群普查：元会话文件数 ≤ 真实任务文件数', ok: census.meta.files <= census.real.files, detail: `元 ${census.meta.files} 个 / ${mb(census.meta.bytes)} ≤ 真实 ${census.real.files} 个 / ${mb(census.real.bytes)}` },
    { name: '扫到的文件里元会话占比 ≤ 50%', ok: scannedMeta * 2 <= scannedTotal, detail: `元 ${scannedMeta} / 扫到 ${scannedTotal} = ${pct(scannedMeta, scannedTotal)}` },
  ]
}

/** 逐工作区汇总 = 全局（两个窗共用；`label` 为空时条目名与原先逐字相同）。 */
function crossChecksOf(label, result, scannedTotal) {
  const g = result.global
  return [
    { name: `${label}调用数：逐工作区汇总 = 全局`, ok: result.bySum.calls === g.calls, detail: `${result.bySum.calls} = ${g.calls}` },
    { name: `${label}含调用回合数：逐工作区汇总 = 全局`, ok: result.bySum.turnsWithCalls === g.turnsWithCalls, detail: `${result.bySum.turnsWithCalls} = ${g.turnsWithCalls}` },
    { name: `${label}跨文件回合数：逐工作区汇总 = 全局`, ok: result.bySum.crossFileTurns === g.crossFileTurns, detail: `${result.bySum.crossFileTurns} = ${g.crossFileTurns}` },
    { name: `${label}aura_edit 调用数：逐工作区汇总 = 全局`, ok: result.bySum.auraEditCalls === g.auraEditCalls, detail: `${result.bySum.auraEditCalls} = ${g.auraEditCalls}` },
    { name: `${label}读取文件数：逐工作区汇总 + 解压失败 = 取样文件数`, ok: result.bySum.filesRead + result.readFailures.length === scannedTotal, detail: `${result.bySum.filesRead} + 失败 ${result.readFailures.length} = ${scannedTotal}` },
    { name: `${label}含调用会话数 ≤ 读取文件数`, ok: result.bySum.sessions <= result.bySum.filesRead, detail: `${result.bySum.sessions} ≤ ${result.bySum.filesRead}` },
  ]
}

/** json 里的 `numbers` 段（主窗与镜像窗共用，形状不变）。 */
function numbersOf(g) {
  return {
    callsPerTurn: { value: g.callsPerTurn, calls: g.calls, turnsWithCalls: g.turnsWithCalls, sessions: g.sessions, turnsStarted: g.turnsStarted },
    crossFileTurnShare: {
      value: g.crossFileTurnShare,
      crossFileTurns: g.crossFileTurns,
      turnsWithCalls: g.turnsWithCalls,
      writeTurnVariant: { value: g.crossFileWriteTurnShare, crossFileWriteTurns: g.crossFileWriteTurns, writeTurns: g.writeTurns, anyToolVariant: g.crossFileWriteTurnsAnyTool },
    },
    targetsPerCall: { value: g.targetsPerCall, totalTargets: g.totalTargets, callsWithTargets: g.callsWithTargets, fileToolCalls: g.fileToolCalls, multiTargetCalls: g.multiTargetCalls, multiTargetShare: g.multiTargetShare },
    hunksPerEdit: { mean: g.meanHunksPerEdit, meanOverHunkedEdits: g.meanHunksPerHunkedEdit, auraEditCalls: g.auraEditCalls, totalHunks: g.totalHunks, distribution: g.hunkDistribution },
    callMix: { total: g.calls, byTool: g.callMix },
    auraEditShare: { value: g.auraEditShare, auraEdit: g.auraEditCalls, builtinEdit: g.builtinEditCalls, denominator: g.editCallsTotal },
  }
}

/** json 里的 `sampleScope` 段（自报范围；两个窗共用）。 */
function sampleScopeOf({ root, sinceRaw, untilRaw, window: w, census, result }) {
  return {
    root,
    timeWindow: { since: sinceRaw, until: untilRaw },
    scannedMetaFiles: w.scannedMeta,
    scannedTotalFiles: w.scannedTotal,
    workspaces: w.scope.map(({ files, allCandidatesSortedBySize, ...rest }) => rest),
    census,
    decompressedBytes: result === null ? w.decompressedBytes : result.decompressedBytes,
    readFailures: result === null ? w.readFailures : result.readFailures,
    populationSha256: w.populationSha256,
  }
}

/** 口径一行摘要（基线与本次都印这一行 ⇒ 不同之处一眼能对上）。 */
function scopeText(s) {
  if (s === null || typeof s !== 'object') return '—'
  return `root=${s.root ?? '—'} ｜ 工作区 ${Array.isArray(s.workspaces) ? s.workspaces.length : '?'} 个 ｜ N=${s.maxFiles ?? '—'} ｜ 样本 ${s.sampledFiles ?? '—'} 个 ｜ since=${s.since ?? '（无下界）'} ｜ until=${s.until ?? '—'} ｜ 元会话${s.includeMeta === true ? '纳入' : s.includeMeta === false ? '不纳入' : '—'} ｜ 指纹 ${typeof s.populationSha256 === 'string' ? `${s.populationSha256.slice(0, 16)}…` : '—'}`
}

const brief1 = (v, n = 120) => { const t = v === null || v === undefined ? '（无）' : String(v); return t.length > n ? `${t.slice(0, n)}…` : t }

/** 口径里的路径按"大小写不敏感 + 绝对化"比（Windows 上同一个根不止一种写法）。 */
const normRoot = (p) => { try { return path.resolve(String(p)).toLowerCase() } catch { return String(p).toLowerCase() } }

/**
 * 基线**自己**的完整性与自洽（与本次调用的口径无关）：缺字段 / 算术不成立 ⇒ 逐条点名 ⇒ 红。
 * 这条与 ⊘ 分开：口径"不同"是 ⊘（不判），基线"坏了"是红（要判）—— 坏基线判不了任何东西。
 */
export function baselineScopeIssues(base) {
  const issues = []
  const need = (ok, name, detail) => { if (!ok) issues.push({ name, detail }) }
  const holder = base !== null && typeof base === 'object' ? base : {}
  const scope = holder.scope !== null && typeof holder.scope === 'object' ? holder.scope : null
  need(scope !== null, 'scope 段存在', `scope=${brief1(JSON.stringify(holder.scope ?? null))}`)
  if (scope === null) return issues
  const ws = Array.isArray(scope.workspaces) ? scope.workspaces.filter((w) => typeof w === 'string' && w.length > 0) : null
  need(ws !== null && ws.length > 0, 'workspaces 是非空字符串数组', `workspaces=${brief1(JSON.stringify(scope.workspaces ?? null))}`)
  need(typeof scope.root === 'string' && scope.root.length > 0, 'root 是非空字符串', `root=${brief1(JSON.stringify(scope.root ?? null), 60)}`)
  need(Number.isInteger(scope.maxFiles) && scope.maxFiles >= 1, 'maxFiles（每工作区取样数 N）是正整数', `maxFiles=${JSON.stringify(scope.maxFiles ?? null)}`)
  need(scope.since === null || (typeof scope.since === 'string' && !Number.isNaN(Date.parse(scope.since))), 'since 是 null 或可解析的时间', `since=${JSON.stringify(scope.since ?? null)}`)
  need(typeof scope.until === 'string' && !Number.isNaN(Date.parse(scope.until)), 'until（冻结人口的那个时刻）是可解析的时间', `until=${JSON.stringify(scope.until ?? null)}`)
  need(typeof scope.includeMeta === 'boolean', 'includeMeta 是布尔', `includeMeta=${JSON.stringify(scope.includeMeta ?? null)}`)
  need(typeof scope.populationSha256 === 'string' && /^[0-9a-f]{64}$/.test(scope.populationSha256), 'populationSha256 是 64 位十六进制（样本集指纹）', `populationSha256=${JSON.stringify(scope.populationSha256 ?? null)}`)
  const sample = Array.isArray(scope.sample) ? scope.sample : null
  need(sample !== null, '样本清单 scope.sample 是数组', `sample=${brief1(JSON.stringify(scope.sample ?? null))}`)
  const cells = holder.cells !== null && typeof holder.cells === 'object' ? holder.cells : {}
  if (ws !== null && ws.length > 0 && Number.isInteger(scope.maxFiles) && scope.maxFiles >= 1) {
    need(scope.sampledFiles === scope.maxFiles * ws.length, 'workspaces × N = sampledFiles（口径自洽）', `${ws.length} 个工作区 × N=${scope.maxFiles} = ${scope.maxFiles * ws.length} vs sampledFiles=${JSON.stringify(scope.sampledFiles ?? null)}`)
    if (sample !== null) {
      need(sample.length === scope.sampledFiles, '样本清单条数 = sampledFiles', `${sample.length} = ${JSON.stringify(scope.sampledFiles ?? null)}`)
      const outside = sample.filter((s) => s === null || typeof s !== 'object' || !ws.includes(s.workspace)).length
      need(outside === 0, '样本清单里的工作区都在 workspaces 里', `${outside} 条越界`)
      for (const w of ws) {
        const got = sample.filter((s) => s !== null && typeof s === 'object' && s.workspace === w).length
        need(got === scope.maxFiles, `${w}：样本清单里恰好 N 个文件`, `${got} vs N=${scope.maxFiles}`)
      }
    }
    for (const w of ws) {
      const cell = cells[w]
      need(cell !== null && typeof cell === 'object', `cells 里有 ${w}`, `cells=${brief1(JSON.stringify(Object.keys(cells)))}`)
      if (cell !== null && typeof cell === 'object') {
        need(cell.files === scope.maxFiles, `${w}：cells.files = N`, `${JSON.stringify(cell.files ?? null)} = ${scope.maxFiles}`)
        for (const [name, key] of RECONCILE_CELLS) need(key in cell, `${w}：cells.${key} 存在（${name}）`, `缺 ${key}`)
      }
    }
  }
  return issues
}

/**
 * 本次调用的口径 vs 基线**逐字段**比；返回差异清单（空 = 同一口径 ⇒ 逐格对账才有定义）。
 * 每个字段都比"值"，所以 ⊘ 行能直接印出"基线 X vs 本次 Y"，不必让人再去猜哪里不一样。
 */
export function compareScope(stored, current) {
  const diffs = []
  const cmp = (field, a, b) => { if (a !== b) diffs.push({ field, stored: a, current: b }) }
  cmp('root（会话库根目录）', normRoot(stored.root), normRoot(current.root))
  cmp('workspaces（工作区集）', JSON.stringify([...stored.workspaces].sort()), JSON.stringify([...current.workspaces].sort()))
  cmp('maxFiles（每工作区取样数 N）', stored.maxFiles, current.maxFiles)
  cmp('includeMeta（元会话是否纳入人群）', stored.includeMeta, current.includeMeta)
  cmp('since（时间窗下界）', stored.since, current.since)
  cmp('until（冻结人口的那个时刻）', stored.until, current.until)
  cmp('populationSha256（样本集指纹）', stored.populationSha256, current.populationSha256)
  return diffs
}

/** 样本集差异：⊘ 时点名"到底换了哪几个文件"，不让人去猜。 */
function sampleDiff(storedSample, currentSample) {
  const keyOf = (s) => `${s !== null && typeof s === 'object' ? s.workspace : '?'}/${s !== null && typeof s === 'object' ? s.name : '?'}`
  const a = new Set((Array.isArray(storedSample) ? storedSample : []).map(keyOf))
  const b = new Set((Array.isArray(currentSample) ? currentSample : []).map(keyOf))
  const onlyStored = [...a].filter((k) => !b.has(k))
  const onlyCurrent = [...b].filter((k) => !a.has(k))
  const brief = (keys) => (keys.length === 0 ? '—' : keys.length <= 3 ? keys.join('、') : `${keys.slice(0, 3).join('、')} …（共 ${keys.length} 个）`)
  return { onlyStored, onlyCurrent, text: `基线有本次没有 ${onlyStored.length} 个（${brief(onlyStored)}）、本次有基线没有 ${onlyCurrent.length} 个（${brief(onlyCurrent)}）` }
}

/** 把这一次取样 + 计数**原样**做成基线段：数字与口径一起，缺一不可。 */
function buildBaselineObject({ window: w, result, root, resolved, maxFiles, sinceRaw, untilRaw }) {
  const pickedBy = new Map(w.scope.map((s) => [s.workspace, s.pickedFiles]))
  const cells = {}
  const headline = {}
  for (const item of result.perWorkspace) {
    const f = item.figures
    cells[item.workspace] = {
      files: pickedBy.get(item.workspace) ?? f.filesRead,
      auraEditCalls: f.auraEditCalls,
      distinctAuraEditFiles: f.distinctAuraEditFiles,
      writeTurns: f.writeTurns,
      crossFileWriteTurns: f.crossFileWriteTurns,
      meanHunksPerEdit: round6(f.meanHunksPerEdit),
    }
    headline[item.workspace] = { multiTargetCalls: f.multiTargetCalls, targetsPerCall: round6(f.targetsPerCall), callsWithTargets: f.callsWithTargets, totalTargets: f.totalTargets }
  }
  return {
    capturedAt: new Date().toISOString(),
    capturedBy: 'node aura-tools/probes/multi-target-adoption.mjs --capture-baseline',
    instrument: '本量具自己的计数路径（measure）；不是第二个实现',
    scope: {
      root,
      workspaces: [...resolved],
      maxFiles,
      sampledFiles: w.scannedTotal,
      includeMeta: resolved.includes(META_WORKSPACE),
      since: sinceRaw,
      until: untilRaw,
      populationSha256: w.populationSha256,
      sample: w.rows.map((r) => ({ workspace: r.workspace, name: path.basename(path.dirname(r.file)), bytes: r.bytes, mtime: new Date(r.mtimeMs).toISOString() })),
    },
    headline,
    cells,
  }
}

/** 基线段 → 可直接写回源码的文本（字段顺序固定 ⇒ 同一批语料重采两次逐字节相同）。 */
function renderBaseline(base) {
  const q = (s) => JSON.stringify(s)
  const scope = base.scope
  const out = []
  out.push('export const BASELINE = {')
  out.push(`  capturedAt: ${q(base.capturedAt)},`)
  out.push(`  capturedBy: ${q(base.capturedBy)},`)
  out.push(`  instrument: ${q(base.instrument)},`)
  out.push('  scope: {')
  out.push(`    root: ${q(scope.root)},`)
  out.push(`    workspaces: [${scope.workspaces.map(q).join(', ')}],`)
  out.push(`    maxFiles: ${scope.maxFiles},`)
  out.push(`    sampledFiles: ${scope.sampledFiles},`)
  out.push(`    includeMeta: ${scope.includeMeta},`)
  out.push(`    since: ${scope.since === null ? 'null' : q(scope.since)},`)
  out.push(`    until: ${q(scope.until)},`)
  out.push(`    populationSha256: ${q(scope.populationSha256)},`)
  out.push('    // 基线取样清单（逐文件的证据；口径一致时本次取样应与它逐条相同）')
  out.push('    sample: [')
  for (const s of scope.sample) out.push(`      { workspace: ${q(s.workspace)}, name: ${q(s.name)}, bytes: ${s.bytes}, mtime: ${q(s.mtime)} },`)
  out.push('    ],')
  out.push('  },')
  out.push('  // headline = 装上多目标**之前**的对照读数（多目标调用数 = 0 / 每次调用目标数 = 1.00）：')
  out.push('  // 只印不判 —— 装上之后这两格本来就该动，拿 0 当分母也算不出 ±20%。')
  out.push('  headline: {')
  for (const w of scope.workspaces) {
    const h = base.headline[w] ?? {}
    out.push(`    ${q(w)}: { multiTargetCalls: ${h.multiTargetCalls ?? 'null'}, targetsPerCall: ${h.targetsPerCall ?? 'null'}, callsWithTargets: ${h.callsWithTargets ?? 'null'}, totalTargets: ${h.totalTargets ?? 'null'} },`)
  }
  out.push('  },')
  out.push('  cells: {')
  for (const w of scope.workspaces) {
    const c = base.cells[w] ?? {}
    out.push(`    ${q(w)}: {`)
    out.push(`      files: ${c.files ?? 'null'}, auraEditCalls: ${c.auraEditCalls ?? 'null'}, distinctAuraEditFiles: ${c.distinctAuraEditFiles ?? 'null'},`)
    out.push(`      writeTurns: ${c.writeTurns ?? 'null'}, crossFileWriteTurns: ${c.crossFileWriteTurns ?? 'null'}, meanHunksPerEdit: ${c.meanHunksPerEdit ?? 'null'},`)
    out.push('    },')
  }
  out.push('  },')
  out.push('}')
  return out.join('\n')
}

/**
 * 就地重写本文件两行标记之间的那一段。**只动标记之间**，而且要求两行标记在全文里各自
 * **恰好出现一次、且独占一行** —— 这一条是必须的：文件头那段说明里也提到了这两个标记的名字，
 * 早先按 `indexOf` 裸找，结果把基线块插进了说明文字中间（内容没丢，但整段注释被切开、文件解析不了）。
 * 所以这里按"整行 token"找、并数一数：不是各一次就返回 null，宁可不写。
 */
function writeBaselineIntoSource(source, text) {
  const beginToken = `\n${BASELINE_BEGIN}\n`
  const endToken = `\n${BASELINE_END}\n`
  const occurrences = (hay, needle) => hay.split(needle).length - 1
  if (occurrences(source, beginToken) !== 1 || occurrences(source, endToken) !== 1) return null
  const begin = source.indexOf(beginToken) + 1
  const end = source.indexOf(endToken) + 1
  if (end < begin) return null
  return `${source.slice(0, begin)}${BASELINE_BEGIN}\n${text}\n${source.slice(end)}`
}

/**
 * 自改之后的自查：本文件还得能被 node 解析。
 * `stdio: 'ignore'` 是故意的 —— 不建管道（受限沙箱里管道会 EPERM），只要退出码。
 */
function parsesAsNodeSource() {
  return spawnSync(process.execPath, ['--check', SELF_FILE], { stdio: 'ignore' }).status === 0
}

function usage(message) {
  process.stderr.write(`${message}\n\n用法：node aura-tools/probes/multi-target-adoption.mjs [--workspaces=a,b] [--include-meta] [--max-files=N] [--since=ISO] [--until=ISO] [--json] [--expect-baseline] [--root=DIR]\n      node aura-tools/probes/multi-target-adoption.mjs --capture-baseline [--out=PATH] [--workspaces=a,b] [--include-meta] [--max-files=N] [--since=ISO] [--until=ISO] [--root=DIR]\n`)
  process.exit(2)
}

/**
 * 纯统计入口（可被单测直接喂）：`{ files: [{ workspace, file, bytes, mtimeMs, cwd, turnsStarted, calls }], decompressedBytes, readFailures }`
 * → 全部读数 + 自检。**入参里没有任何会话正文** —— 正文在解析完那一刻就被丢掉了。
 * 为什么这样切：会话正文是 GB 级的，若把 20 个文件的正文一起留在内存里，量具自己就先炸了
 * （整库读爆 node 就是这么来的）。所以解压与解析在读取循环里**逐文件**做，只留紧凑记录。
 */
export function measure(input) {
  const { files, decompressedBytes = 0, readFailures = [] } = input
  const globalDirect = counters()
  const byWorkspace = new Map()
  for (const row of files) {
    const { key, cwd, turnsStarted, calls } = row
    globalDirect.add({ key, cwd, turnsStarted, calls })
    if (!byWorkspace.has(row.workspace)) byWorkspace.set(row.workspace, counters())
    byWorkspace.get(row.workspace).add({ key, cwd, turnsStarted, calls })
  }
  const global = globalDirect.figures()
  const perWorkspace = [...byWorkspace].map(([workspace, counter]) => ({ workspace, figures: counter.figures() }))
  const bySum = {
    calls: perWorkspace.reduce((a, w) => a + w.figures.calls, 0),
    turnsWithCalls: perWorkspace.reduce((a, w) => a + w.figures.turnsWithCalls, 0),
    crossFileTurns: perWorkspace.reduce((a, w) => a + w.figures.crossFileTurns, 0),
    auraEditCalls: perWorkspace.reduce((a, w) => a + w.figures.auraEditCalls, 0),
    sessions: perWorkspace.reduce((a, w) => a + w.figures.sessions, 0),
    filesRead: perWorkspace.reduce((a, w) => a + w.figures.filesRead, 0),
  }
  return { global, perWorkspace, bySum, decompressedBytes, readFailures }
}

function main() {
  const argv = process.argv.slice(2)
  const valueOf = (flag) => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`))
    return hit === undefined ? null : hit.slice(flag.length + 1)
  }
  const includeMeta = argv.includes('--include-meta')
  const json = argv.includes('--json')
  const expectBaseline = argv.includes('--expect-baseline')
  const captureBaseline = argv.includes('--capture-baseline')
  const outPath = valueOf('--out')
  if (captureBaseline && expectBaseline) usage('--capture-baseline（采一份）与 --expect-baseline（对一份）是两条路，不要同时给')
  if (captureBaseline && json) usage('--capture-baseline 写的是 BASELINE 常量本身的文本（--out 可改落点）；要 json 读数请分两次跑')
  if (outPath !== null && !captureBaseline) usage('--out 只在 --capture-baseline 下有定义（默认就地重写本文件的基线区）')
  const root = valueOf('--root') ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')

  // ── 口径：`--expect-baseline` 时，**调用方没显式给的旋钮一律按基线补齐** ──────────────
  // 这就是"人口冻结"的落点：基线把采样那一刻（until）连同工作区集与 N 一起钉住了，
  // 于是"隔几小时再跑就换了一批文件"不会悄悄发生。
  // 显式给了、且与基线不一致 ⇒ **既不静默换成基线的值、也不硬判**：下一节印 ⊘ 并拒绝对账。
  const storedScope = expectBaseline && BASELINE !== null && typeof BASELINE === 'object' && BASELINE.scope !== null && typeof BASELINE.scope === 'object' ? BASELINE.scope : null
  const asTime = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
  const adopted = []
  const sinceGiven = valueOf('--since')
  const untilGiven = valueOf('--until')
  let sinceRaw = sinceGiven
  let untilRaw = untilGiven
  if (expectBaseline && sinceRaw === null && asTime(storedScope?.since) !== null) { sinceRaw = asTime(storedScope.since); adopted.push(`since=${sinceRaw}`) }
  if (expectBaseline && untilRaw === null && asTime(storedScope?.until) !== null) { untilRaw = asTime(storedScope.until); adopted.push(`until=${untilRaw}`) }
  if (captureBaseline && untilRaw === null) untilRaw = new Date().toISOString() // 采样那一刻 = 冻结人口的那个时刻
  const since = sinceRaw === null ? 0 : Date.parse(sinceRaw)
  const until = untilRaw === null ? Number.POSITIVE_INFINITY : Date.parse(untilRaw)
  if (Number.isNaN(since)) usage(`--since 解析不了：${sinceRaw}（要 ISO 时间，如 2026-01-05T00:00）`)
  if (Number.isNaN(until)) usage(`--until 解析不了：${untilRaw}（要 ISO 时间，如 2026-01-05T00:00）`)
  const maxFilesRaw = valueOf('--max-files')
  const maxFiles = maxFilesRaw !== null ? Number(maxFilesRaw)
    : expectBaseline && Number.isInteger(storedScope?.maxFiles) && storedScope.maxFiles >= 1 ? storedScope.maxFiles
      : 10
  if (!Number.isInteger(maxFiles) || maxFiles < 1) usage(`--max-files 要正整数：${maxFilesRaw}`)
  if (expectBaseline && maxFilesRaw === null && Number.isInteger(storedScope?.maxFiles)) adopted.push(`maxFiles=${maxFiles}`)

  // ── 取样集：默认真实任务人群；--workspaces 可指到别处（含元会话做对照） ──────────────
  const wanted = valueOf('--workspaces')
  const storedWs = expectBaseline && Array.isArray(storedScope?.workspaces) ? storedScope.workspaces.filter((w) => typeof w === 'string' && w.length > 0) : []
  if (expectBaseline && wanted === null && !includeMeta && storedWs.length > 0) adopted.push(`workspaces=${storedWs.join(',')}`)
  const selected = wanted !== null ? wanted.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : expectBaseline && !includeMeta && storedWs.length > 0 ? [...storedWs]
      : [...REAL_WORKSPACES]
  if (includeMeta && !selected.includes(META_WORKSPACE)) selected.push(META_WORKSPACE)
  const allDirs = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []
  // 去重：`--workspaces=deepseekharness --include-meta` 这种写法会让同一个目录被模糊匹配 + 精确匹配各命中一次，
  // 不去重就会把同一个会话文件读两遍、把所有计数（和分母）一起放大 —— 记账自洽查不出来，因为是均匀放大。
  // （基线里存的 workdir 是**已解析**的名字；若那个目录已经不在了，这里仍旧按"工作区不存在"报用法错退出 2 ——
  //   宁可不跑，也不悄悄缩小人口去凑一个能跑的口径。）
  const resolved = [...new Set(selected.map((want) => {
    if (allDirs.includes(want)) return want
    const fuzzy = allDirs.filter((d) => d.toLowerCase().includes(want.toLowerCase()))
    if (fuzzy.length === 0) usage(`工作区不存在：${want}（${root} 下没有这个名字，也没有包含它的目录）`)
    return fuzzy
  }).flat())]
  if (resolved.length === 0) usage(`取样集为空（root=${root}）`)

  // ── 人群口径自检的人口普查：点名人群 vs 元会话 vs 其余（只 stat，不解压） ────────────
  const census = { real: { files: 0, bytes: 0 }, meta: { files: 0, bytes: 0 }, other: { files: 0, bytes: 0 }, dirs: [] }
  for (const dir of allDirs) {
    const files = candidatesOf(path.join(root, dir))
    const bytes = files.reduce((a, f) => a + f.bytes, 0)
    const bucket = dir === META_WORKSPACE ? 'meta' : REAL_WORKSPACES.includes(dir) ? 'real' : 'other'
    census[bucket].files += files.length
    census[bucket].bytes += bytes
    census.dirs.push({ dir, files: files.length, bytes, bucket, sampled: resolved.includes(dir) })
  }
  census.dirs.sort((a, b) => b.bytes - a.bytes)

  // ── 取样：时间窗（按文件 mtime）→ 体积降序 → 取前 N（**有界**，别整库读） ───────────
  const window = sampleWindow({ root, workspaces: resolved, sinceMs: since, untilMs: until, maxFiles })
  const rows = window.rows
  const readFailures = window.readFailures
  const scannedMeta = window.scannedMeta
  const scannedTotal = window.scannedTotal

  if (scannedTotal === 0) {

    say(`样本为空：${resolved.join(', ')} 在时间窗 ${sinceRaw ?? '—'} ~ ${untilRaw ?? '—'} 下一个会话文件都没取到 ⇒ 分母为 0，读数无意义`)
    process.exitCode = 1
    return
  }

  const result = measure({ files: rows, decompressedBytes: window.decompressedBytes, readFailures })
  const g = result.global

  // 本次调用**实际用的**口径（= 上面那些旋钮的值）—— 与基线逐字段比的就是这一份。
  const currentScope = {
    root,
    workspaces: resolved,
    maxFiles,
    includeMeta: resolved.includes(META_WORKSPACE),
    since: sinceRaw === null ? null : new Date(since).toISOString(),
    until: Number.isFinite(until) ? new Date(until).toISOString() : null,
    sampledFiles: scannedTotal,
    populationSha256: window.populationSha256,
    sample: rows.map((r) => ({ workspace: r.workspace, name: path.basename(path.dirname(r.file)), bytes: r.bytes, mtime: new Date(r.mtimeMs).toISOString() })),
  }

  // ── 人群口径自检（两条，防"取样取到造工具的元会话"那个错） ──────────────────────
  const population = populationItems(census, scannedMeta, scannedTotal)
  const populationCheck = { label: '人群口径', ok: population.every((i) => i.ok), items: population }

  // ── 记账自洽（逐工作区 + 全局；再加一条"逐工作区汇总 = 全局"） ──────────────────
  const accounting = [consistencyChecks('全局', g), ...result.perWorkspace.map((w) => consistencyChecks(w.workspace, w.figures))]
  const crossChecks = crossChecksOf('', result, scannedTotal)
  const accountingCheck = {
    label: '记账自洽',
    ok: accounting.every((a) => a.ok) && crossChecks.every((c) => c.ok),
    items: [...accounting.flatMap((a) => a.items.map((i) => ({ ...i, name: `${a.label}·${i.name}` }))), ...crossChecks],
  }

  // ── 采基线（--capture-baseline）：跑的就是上面这条计数路径，把数字连同口径写下来 ────────
  if (captureBaseline) {
    const captured = buildBaselineObject({ window, result, root, resolved, maxFiles, sinceRaw: currentScope.since, untilRaw: new Date(until).toISOString() })
    const issues = baselineScopeIssues(captured)
    const broken = [...populationCheck.items, ...accountingCheck.items].filter((i) => !i.ok)
    say('--- 采基线（--capture-baseline）：跑本量具自己的计数路径，数字与口径一起写下来 ---')
    say(`  取样口径    : ${scopeText(captured.scope)}`)
    say(`  取样文件    : ${num(captured.scope.sampledFiles)} 个（工作区数 × N = ${captured.scope.workspaces.length} × ${captured.scope.maxFiles}）；解压后正文 ${mb(result.decompressedBytes)}；样本指纹 ${captured.scope.populationSha256.slice(0, 16)}…`)
    for (const w of captured.scope.workspaces) {
      const c = captured.cells[w]
      say(`  · ${w}：aura_edit ${num(c.auraEditCalls)} 次 / 触及不同文件 ${num(c.distinctAuraEditFiles)} / 写回合 ${num(c.writeTurns)} / 跨文件写回合 ${num(c.crossFileWriteTurns)} / 平均 hunk ${fix2(c.meanHunksPerEdit)}`)
    }
    say(`  headline    : 多目标调用数 ${captured.scope.workspaces.map((w) => num(captured.headline[w].multiTargetCalls)).join(' + ')} ｜ 每次调用目标数 ${captured.scope.workspaces.map((w) => fix2(captured.headline[w].targetsPerCall)).join(' + ')}（装上多目标之前的样子；只印不判）`)
    for (const i of issues) say(`  ✗ 基线口径不自洽：${i.name} —— ${i.detail}`)
    for (const i of broken) say(`  ✗ 这一次的读数没自洽：${i.name} —— ${i.detail}`)
    if (issues.length > 0 || broken.length > 0) {
      say('  ✗ 采到的这份基线判不了自己（上面逐条点名）⇒ **一个字都不写**（宁可不写，也不留一份坏基线）')
      process.exitCode = 1
      return
    }
    const text = renderBaseline(captured)
    if (outPath === null) {
      const before = fs.readFileSync(SELF_FILE, 'utf8')
      const after = writeBaselineIntoSource(before, text)
      if (after === null) {
        say(`  ✗ 本文件里找不到独占一行的基线区标记（${BASELINE_BEGIN} / ${BASELINE_END}）—— 要么被删了，要么全文里不是各一次 ⇒ 一个字都不写`)
        process.exitCode = 1
        return
      }
      fs.writeFileSync(SELF_FILE, after)
      if (!parsesAsNodeSource()) {
        // 宁可不采，也不留一个自己都解析不了的文件：回滚成写前那一份（字节原样）。
        fs.writeFileSync(SELF_FILE, before)
        say('  ✗ 写回之后本文件过不了 `node --check` ⇒ 已**回滚**成写前那一份（内容一字未动）')
        process.exitCode = 1
        return
      }
      say(`  已就地重写  : ${SELF_FILE}（只改了两行标记之间的那一段；写完当场 node --check 自查通过）`)
      say(`  本文件 sha256: 写前 ${sha256(before)} → 写后 ${sha256(after)}`)
    } else {
      fs.writeFileSync(outPath, `${text}\n`)
      say(`  已写出      : ${outPath}`)
    }
    say(`  基线段 sha256: ${sha256(text)}`)
    say('  下一步      : `--expect-baseline`（不带旋钮）会按这份基线的口径复采并逐格对账（±20%）。')
    process.exitCode = 0
    return
  }

  // ── 镜像窗：`--since=<T>` 时自动算 `--until=<T>` 那一窗，把"之前 vs 之后"并排印出来 ──────
  // 采用对照因此是**一次调用**的产物：两个窗走同一条取样/计数/自检路径，不需要人去对齐两次运行。
  let mirror = null
  if (sinceGiven !== null) {
    const before = sampleWindow({ root, workspaces: resolved, sinceMs: 0, untilMs: since, maxFiles })
    if (before.scannedTotal === 0) {
      mirror = { cutAt: new Date(since).toISOString(), window: before, result: null, checks: [], ok: true }
    } else {
      const beforeResult = measure({ files: before.rows, decompressedBytes: before.decompressedBytes, readFailures: before.readFailures })
      const items = [
        ...consistencyChecks('镜像窗·全局', beforeResult.global).items,
        ...beforeResult.perWorkspace.flatMap((w) => consistencyChecks(`镜像窗·${w.workspace}`, w.figures).items),
        ...crossChecksOf('镜像窗·', beforeResult, before.scannedTotal),
        ...populationItems(census, before.scannedMeta, before.scannedTotal),
      ]
      mirror = { cutAt: new Date(since).toISOString(), window: before, result: beforeResult, checks: items, ok: items.every((i) => i.ok) }
    }
  }

  // ── 基线：先查基线自己，再比口径；口径一致才逐格对账 ─────────────────────────────
  let baseline = null
  if (expectBaseline) {
    const scopeIssues = baselineScopeIssues(BASELINE)
    const mismatches = scopeIssues.length === 0 ? compareScope(BASELINE.scope, currentScope) : []
    const usable = scopeIssues.length === 0 && mismatches.length === 0
    const cells = []
    const reference = []
    for (const w of result.perWorkspace) {
      const cellsIn = BASELINE !== null && typeof BASELINE === 'object' && BASELINE.cells !== null && typeof BASELINE.cells === 'object' ? BASELINE.cells : {}
      const headIn = BASELINE !== null && typeof BASELINE === 'object' && BASELINE.headline !== null && typeof BASELINE.headline === 'object' ? BASELINE.headline : {}
      const baseHead = headIn[w.workspace]
      if (baseHead !== null && baseHead !== undefined) {
        reference.push({ workspace: w.workspace, name: '多目标调用数', baseline: baseHead.multiTargetCalls, measured: w.figures.multiTargetCalls })
        reference.push({ workspace: w.workspace, name: '每次调用目标数', baseline: baseHead.targetsPerCall, measured: w.figures.targetsPerCall })
      }
      if (!usable) continue
      const baseCell = cellsIn[w.workspace]
      if (baseCell === null || baseCell === undefined) continue
      for (const [name, key] of RECONCILE_CELLS) {
        const want = baseCell[key]
        if (want === null || want === undefined) continue
        const got = w.figures[key]
        const deviation = got === null ? null : (got - want) / want
        cells.push({ workspace: w.workspace, name, baseline: want, measured: got, deviation, ok: deviation !== null && Math.abs(deviation) <= BASELINE_TOLERANCE })
      }
    }
    const status = scopeIssues.length > 0 ? 'malformed' : mismatches.length > 0 ? 'scope-mismatch' : 'reconciled'
    baseline = {
      status,
      tolerance: BASELINE_TOLERANCE,
      capturedAt: BASELINE !== null && typeof BASELINE === 'object' ? BASELINE.capturedAt ?? null : null,
      capturedBy: BASELINE !== null && typeof BASELINE === 'object' ? BASELINE.capturedBy ?? null : null,
      scopeIssues,
      storedScope: BASELINE !== null && typeof BASELINE === 'object' ? BASELINE.scope ?? null : null,
      currentScope,
      mismatches,
      sampleDiff: mismatches.some((m) => String(m.field).startsWith('populationSha256')) ? sampleDiff(storedScope?.sample, currentScope.sample) : null,
      reference,
      cells,
      ok: status === 'malformed' ? false : status === 'reconciled' ? cells.every((c) => c.ok) : null,
    }
  }

  const red = !accountingCheck.ok || !populationCheck.ok || (mirror !== null && !mirror.ok) || (baseline !== null && baseline.ok === false)
  const verdict = red ? '失败' : '通过'
  const baselineVerdict = baseline === null ? '未要求'
    : baseline.status === 'reconciled' ? (baseline.ok ? '通过' : '失败')
      : baseline.status === 'scope-mismatch' ? '口径不符（⊘ 本节未判）'
        : '基线口径不自洽（失败）'

  if (json) {
    const out = {
      cmd: process.argv.slice(1).join(' '),
      generatedAt: new Date().toISOString(),
      sampleScope: sampleScopeOf({ root, sinceRaw, untilRaw, window, census, result }),
      numbers: numbersOf(g),
      perWorkspace: result.perWorkspace.map((w) => ({ workspace: w.workspace, ...w.figures })),
      selfChecks: [accountingCheck, populationCheck],
      adoptedScopeKnobs: adopted,
      windows: mirror === null ? null : {
        cutAt: mirror.cutAt,
        labels: { before: `--until=${mirror.cutAt}（镜像窗，无下界）`, after: `--since=${mirror.cutAt}${untilGiven === null ? '（无上界）' : ` --until=${untilRaw}`}` },
        before: mirror.result === null
          ? { empty: true, sampleScope: sampleScopeOf({ root, sinceRaw: null, untilRaw: mirror.cutAt, window: mirror.window, census, result: null }) }
          : { empty: false, sampleScope: sampleScopeOf({ root, sinceRaw: null, untilRaw: mirror.cutAt, window: mirror.window, census, result: mirror.result }), numbers: numbersOf(mirror.result.global), perWorkspace: mirror.result.perWorkspace.map((w) => ({ workspace: w.workspace, ...w.figures })), selfChecks: mirror.checks },
        after: { empty: false, numbers: numbersOf(g) },
        ok: mirror.ok,
      },
      baselineReconcile: baseline,
      exit: red ? 1 : 0,
    }
    process.stdout.write(`${JSON.stringify(out, null, 1)}\n`)
    process.exitCode = red ? 1 : 0
    return
  }

  // ── 人读输出 ────────────────────────────────────────────────────────────────
  say('=== 多目标采用量具（M0）：装上"一次调用多目标"之后 agent 会不会用它 ===')
  say('口径：会话日志的 tool/call 事件；回合 = data.turn（同一会话文件内）；文件路径按会话 cwd 归一化后去重')

  say('\n--- 样本范围（自报；不许只印数字不印范围）---')
  say(`  会话库根目录        : ${root}`)
  say(`  时间窗（文件 mtime）: ${sinceRaw ?? '（无下界）'} ~ ${untilRaw ?? '（无上界）'}（--since/--until 就是"装多目标之前 vs 之后"的切分口径）`)
  for (const s of window.scope) {
    say(`  · ${s.workspace}${s.meta ? '（元会话，对照用）' : ''}`)
    say(`      候选会话文件 ${num(s.candidateFiles)} 个 / ${mb(s.candidateBytes)}；被时间窗滤掉 ${num(s.excludedByTime)} 个`)
    say(`      本次取样 ${num(s.pickedFiles)} 个（按体积从大到小）/ ${mb(s.pickedBytes)}；样本 mtime ${s.mtimeMin ?? '—'} → ${s.mtimeMax ?? '—'}`)
  }
  say(`  合计取样文件        : ${num(scannedTotal)} 个（其中元会话 ${num(scannedMeta)} 个）；解压后正文 ${mb(result.decompressedBytes)}`)
  say(`  样本集指纹          : ${window.populationSha256}`)
  if (result.readFailures.length > 0) say(`  解压失败            : ${num(result.readFailures.length)} 个文件（已从读数里剔除，见 --json）`)
  say(`  全库人口普查        : 点名真实 ${num(census.real.files)} 个 / ${mb(census.real.bytes)} ｜ 点名元会话 ${num(census.meta.files)} 个 / ${mb(census.meta.bytes)} ｜ 其余目录 ${num(census.other.files)} 个 / ${mb(census.other.bytes)}（默认不取样、不进闸）`)
  if (adopted.length > 0) say(`  基线补齐的旋钮      : ${adopted.join(' ｜ ')}（--expect-baseline 未显式给的旋钮按基线钉住的值取样 —— 这就是人口冻结的落点）`)

  say('\n--- 三个数（每条带分母）---')
  say(`  ① 每回合调用数      : ${g.callsPerTurn === null ? '—' : g.callsPerTurn.toFixed(2)}  （调用 ${num(g.calls)} / 含调用回合 ${num(g.turnsWithCalls)}；会话 ${num(g.sessions)} 个；turn/start ${num(g.turnsStarted)} 个）`)
  say(`  ② 跨文件回合占比    : ${pct(g.crossFileTurns, g.turnsWithCalls)}  （跨 ≥2 文件的回合 ${num(g.crossFileTurns)} / 含调用回合 ${num(g.turnsWithCalls)}）`)
  say(`      写回合口径        : ${pct(g.crossFileWriteTurns, g.writeTurns)}  （跨 ≥2 文件的写回合 ${num(g.crossFileWriteTurns)} / 含 aura_edit 的回合 ${num(g.writeTurns)}）← 与参考基线同口径；同一批写回合若按"全部文件工具"算则 ${num(g.crossFileWriteTurnsAnyTool)} 个`)
  say(`  ③ 每次调用携带目标数: ${g.targetsPerCall === null ? '—' : g.targetsPerCall.toFixed(2)}  （文件目标 ${num(g.totalTargets)} / 带目标的文件工具调用 ${num(g.callsWithTargets)}；文件工具调用共 ${num(g.fileToolCalls)}）`)
  say(`      多目标调用        : ${num(g.multiTargetCalls)} 次（占带目标调用 ${pct(g.multiTargetCalls, g.callsWithTargets)}）——今天只可能是模型把多目标塞进一次调用`)
  say(`  附 每次编辑的 hunk 数分布（aura_edit ${num(g.auraEditCalls)} 次 = 各桶之和 ${num(g.hunkBucketsTotal)}）：`)
  for (const [key, count] of Object.entries(g.hunkDistribution)) say(`      ${String(key).padStart(14)} hunk : ${num(count)} 次  ${pct(count, g.auraEditCalls)}`)
  say(`      平均 hunk/次编辑  : ${g.meanHunksPerEdit === null ? '—' : g.meanHunksPerEdit.toFixed(2)}（分母 ${num(g.auraEditCalls)} 次 aura_edit；只算带 hunks 的 ${num(g.auraEditWithHunks)} 次则 ${g.meanHunksPerHunkedEdit === null ? '—' : g.meanHunksPerHunkedEdit.toFixed(2)}）`)

  // ── 采用对照（--since=T 时本命令自产的两窗并排） ─────────────────────────────────
  if (mirror !== null) {
    const cut = mirror.cutAt
    say('\n--- 采用对照：装多目标「之前」vs「之后」（本命令自产；之前窗 = 镜像的 --until=T）---')
    say(`  切分点 T            : ${cut}（就是你给的 --since；之前窗把这个 T 当上界，之后窗当下界）`)
    say(`  两窗的口径          : 同 root / 同工作区集（${resolved.length} 个）/ 同 N=${maxFiles}；**只有时间窗不同** ⇒ 差异只能是采用度，不是取样`)
    say(`  之前窗              : --until=${cut}（无下界）`)
    say(`  之后窗              : --since=${cut}${untilGiven === null ? '（无上界）' : ` --until=${untilRaw}`}`)
    if (mirror.result === null) {
      say('  ⊘ 之前窗样本为空（mtime ≤ T 的会话文件一个都没取到）⇒ 这一节给不出对照，不进判决')
    } else {
      const B = mirror.result.global
      const table = [
        ['样本文件数', num(mirror.window.scannedTotal), num(scannedTotal), relDelta(mirror.window.scannedTotal, scannedTotal)],
        ['① 每回合调用数', fix2(B.callsPerTurn), fix2(g.callsPerTurn), relDelta(B.callsPerTurn, g.callsPerTurn)],
        ['② 跨文件回合占比', pct(B.crossFileTurns, B.turnsWithCalls), pct(g.crossFileTurns, g.turnsWithCalls), ppDelta(B.crossFileTurnShare, g.crossFileTurnShare)],
        ['③ 每次调用携带目标数', fix2(B.targetsPerCall), fix2(g.targetsPerCall), relDelta(B.targetsPerCall, g.targetsPerCall)],
        ['多目标调用数', num(B.multiTargetCalls), num(g.multiTargetCalls), relDelta(B.multiTargetCalls, g.multiTargetCalls)],
        ['跨文件回合数', num(B.crossFileTurns), num(g.crossFileTurns), relDelta(B.crossFileTurns, g.crossFileTurns)],
        ['写回合数（含 aura_edit）', num(B.writeTurns), num(g.writeTurns), relDelta(B.writeTurns, g.writeTurns)],
        ['写回合里跨 ≥2 文件', num(B.crossFileWriteTurns), num(g.crossFileWriteTurns), relDelta(B.crossFileWriteTurns, g.crossFileWriteTurns)],
        ['aura_edit 调用数', num(B.auraEditCalls), num(g.auraEditCalls), relDelta(B.auraEditCalls, g.auraEditCalls)],
        ['平均 hunk 数 / 次编辑', fix2(B.meanHunksPerEdit), fix2(g.meanHunksPerEdit), relDelta(B.meanHunksPerEdit, g.meanHunksPerEdit)],
      ]
      say(`  ${col('读数', 26)}${col('之前窗（--until=T）', 22)}${col('之后窗（--since=T）', 22)}变化（之后 vs 之前）`)
      for (const [name, b, a, d] of table) say(`  ${col(name, 26)}${col(b, 22)}${col(a, 22)}${d}`)
      for (const s of mirror.window.scope) say(`  · 之前窗取样：${s.workspace} 候选 ${num(s.candidateFiles)} 个 → 取 ${num(s.pickedFiles)} 个 / ${mb(s.pickedBytes)}；样本 mtime ${s.mtimeMin ?? '—'} → ${s.mtimeMax ?? '—'}`)
      say(`  之前窗样本指纹      : ${mirror.window.populationSha256}`)
      const bad = mirror.checks.filter((i) => !i.ok)
      if (bad.length === 0) say(`  ✓ 镜像窗自检        : 记账自洽 + 人群口径 共 ${mirror.checks.length} 条全部成立（明细见 --json）`)
      else for (const i of bad) say(`  ✗ 镜像窗自检·${i.name}：${i.detail}`)
    }
  }

  say('\n--- 参考读数 ---')
  say(`  调用构成（分母 ${num(g.callMixTotal)} 次调用，= 调用总数 ${num(g.calls)}）：`)
  for (const [name, count] of Object.entries(g.callMix)) say(`      ${String(name).padEnd(18)} ${num(count).padStart(7)}  ${pct(count, g.callMixTotal)}`)
  say(`  编辑调用构成        : aura_edit ${num(g.auraEditCalls)} vs 内置 edit ${num(g.builtinEditCalls)} ⇒ aura_edit 占 ${pct(g.auraEditCalls, g.editCallsTotal)}（分母 ${num(g.editCallsTotal)} = 两者之和；write ${num(g.callMix.write ?? 0)} 次不计入编辑）`)
  say(`  aura_edit 触及的不同文件数: ${num(g.distinctAuraEditFiles)} 个`)

  if (result.perWorkspace.length > 1) {
    say('\n--- 逐工作区 ---')
    for (const w of result.perWorkspace) {
      const f = w.figures
      say(`  · ${w.workspace}：调用 ${num(f.calls)} / 含调用回合 ${num(f.turnsWithCalls)} = ${f.callsPerTurn === null ? '—' : f.callsPerTurn.toFixed(2)}；跨文件回合 ${pct(f.crossFileTurns, f.turnsWithCalls)}；aura_edit ${num(f.auraEditCalls)}（写回合 ${num(f.writeTurns)}，跨文件 ${num(f.crossFileWriteTurns)} = ${pct(f.crossFileWriteTurns, f.writeTurns)}）；平均 hunk ${f.meanHunksPerEdit === null ? '—' : f.meanHunksPerEdit.toFixed(2)}；不同文件 ${num(f.distinctAuraEditFiles)}；多目标调用 ${num(f.multiTargetCalls)}；每次调用目标数 ${f.targetsPerCall === null ? '—' : f.targetsPerCall.toFixed(2)}`)
    }
  }

  // ── 基线对账（口径自检 → 口径比对 → 一致才逐格±20%） ──────────────────────────────
  if (baseline !== null) {
    say('\n--- 参考基线对账（容差 ±20%；基线由本量具 --capture-baseline 自采，取样口径逐字段钉在基线里）---')
    say(`  基线采样时刻        : ${baseline.capturedAt ?? '—'}（${baseline.capturedBy ?? '—'}）`)
    say(`  基线口径（文件里那份）: ${scopeText(baseline.storedScope)}`)
    say(`  本次口径（这次跑用的）: ${scopeText(baseline.currentScope)}`)
    for (const i of baseline.scopeIssues) say(`  ✗ 基线自身口径不完整/不自洽：${i.name} —— ${i.detail}`)
    for (const m of baseline.mismatches) say(`  ⊘ 口径不符：${m.field} —— 基线 ${brief1(m.stored)} vs 本次 ${brief1(m.current)}${String(m.field).startsWith('populationSha256') && baseline.sampleDiff !== null ? `；样本集差异：${baseline.sampleDiff.text}` : ''}`)
    if (baseline.status === 'reconciled') {
      say(`  ✓ 口径一致（root / 工作区集 / N / includeMeta / since / until / 样本指纹 逐字段相同；样本 ${num(baseline.currentScope.sampledFiles)} 个）⇒ 逐格对账有定义`)
      for (const c of baseline.cells) {
        const dev = c.deviation === null ? '—' : `${c.deviation >= 0 ? '+' : ''}${(100 * c.deviation).toFixed(1)}%`
        say(`  ${c.ok ? '✓' : '✗'} ${c.workspace} · ${c.name}：基线 ${typeof c.baseline === 'number' ? c.baseline.toFixed(2) : c.baseline} vs 实测 ${c.measured === null ? '—' : c.measured.toFixed(2)}（偏差 ${dev}）`)
      }
      for (const r of baseline.reference) say(`  · 参考（不对账）：${r.workspace} · ${r.name}：基线 ${fix2(r.baseline)} vs 实测 ${fix2(r.measured)} —— 装上多目标之前是 0 / 1.00，之后本来就该动，所以不进 ±20%`)
    } else if (baseline.status === 'scope-mismatch') {
      say('  ⊘ 本节不判：口径不一致时两边数的不是同一批文件 —— 既不计通过、也不计失败（退出码不受本节影响）')
      say('     （要重新钉一份同口径的基线：--capture-baseline；要看"之前 vs 之后"：--since=T 会自动并排印出两个窗）')
    } else {
      say('  ✗ 基线自身口径不完整/不自洽 ⇒ 这一节判红（上面逐条点名；修法：--capture-baseline 重采一份）')
    }
  }

  say('\n--- 自检 ---')
  for (const item of accountingCheck.items) say(`  ${item.ok ? '✓' : '✗'} 记账自洽·${item.name}：${item.detail}`)
  for (const item of populationCheck.items) say(`  ${item.ok ? '✓' : '✗'} 人群口径·${item.name}：${item.detail}`)
  const metaDirs = census.dirs.filter((d) => d.bucket === 'meta').map((d) => d.dir)
  say(`  说明：本闸把"元会话"定义为单子点名的 ${metaDirs.join(' / ') || META_WORKSPACE}；其余目录（如 exp-* 实验目录）单列在上述人口普查里，默认既不取样也不进闸。`)

  say(`\n=== 判定：${verdict}（记账自洽 ${accountingCheck.ok ? '通过' : '失败'}、人群口径 ${populationCheck.ok ? '通过' : '失败'}${mirror === null ? '' : `、镜像窗自检 ${mirror.ok ? '通过' : '失败'}`}${baseline === null ? '、基线对账 未要求' : `、基线对账 ${baselineVerdict}`}）===`)
  process.exitCode = red ? 1 : 0
}

/** 会话头里的 cwd（相对路径归一化要用它；取不到就退回 path.normalize）。 */
function cwdOf(text) {
  const m = String(text).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (m === null) return null
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return null
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
