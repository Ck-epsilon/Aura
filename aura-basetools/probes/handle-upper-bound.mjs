#!/usr/bin/env node
/**
 * handle-upper-bound.mjs —— H0b：**句柄化到底能救回多少条？**给一个能被证伪的上界。
 *
 * ## 这件事在问什么
 * 「句柄化」= 读侧发一个**不透明区间句柄**（工具自己账本里那段区间的令牌），编辑时用
 * 「句柄 + 相对定位」寻址。它成立的机制只有一条：**引用的字节不再由模型转述**，而是账本里
 * 那份**逐字节副本**。于是「模型把原文抄错了」这一类失败（本项目残余 147 条的**全部**，
 * 失败码清一色 `PATCH_NOT_FOUND`）从源头消失。
 *
 * ## 为什么今天就能量（本单的前提，已逐条核对语料）
 * 一个句柄的作用，等价于「把账本里那份逐字节正确的区间文本当作 `old` 来寻址」。语料里
 * **恰好有这份字节**：`source.text` 是重放原文快照（`stageCopy` 摊到临时目录的就是它），
 * 而「调用方本来想改的那一段」有**两个互相制约的候选口径**：
 *   · **严格口径**：那条历史调用**自己给出的坐标**（`start_line`/`end_line`/`lines`）覆盖的行，
 *     逐字节从快照里切出来。**不含任何"事后挑一段能匹配的文本"的自由** —— 坐标是调用方当时
 *     就写下的，不是看着答案挑的。
 *   · **宽松口径**：语料自带的 `evidence.actual`（= 语料构建期用**同一套坐标**在快照上
 *     `locate` 出来的那段区域原文）。它比严格口径宽的地方只有一处：`anchor`/`line_cue`/`target`
 *     这类**非坐标寻址**的条目也能圈出区域（严格口径把它们排除）。
 * 两个口径都报，就是为了让「偷偷把区间取成刚好能匹配上的那一段」这一手无处可藏：严格口径
 * **结构上**不许有那一手；宽松口径的每一处判断都写在下面 `LOOSE_FREEDOMS` 里，逐条可查。
 *
 * ## 最关键的假设（上界的边界，必须与读数一起读）
 * **这条数假设调用方手里恰好有一个覆盖它想改那一段的句柄**；真实会话里这个假设成不成立，
 * 要等句柄化落地后用真会话读数回答。本探针量的是**机制的容量**，不是**交付后的效果**。
 * 换句话说：它回答"句柄化之后，这 147 条里最多有多少条具备被救回的**字节条件**"，
 * 不回答"模型会不会去要那个句柄、要到的句柄覆不覆盖它想改的地方"。
 *
 * ## 证伪条件（出现哪条读数就说明"句柄化救得回 147"是错的）
 *   ① 严格口径的 ok 数远小于 147（比如个位数）：说明多数残余条目**连坐标都指不对/指不到**
 *      —— 那 147 条的病因就不是"引文抄错"，而是"地址本身就落在覆盖范围外或空行占位上"，
 *      句柄化按本口径救不回它们（要救得改的是**读侧覆盖**，不是引用机制）。
 *   ② 退化对照（`old` 换回调用方原引文）**没有**掉回 0：说明本探针量到的"救回"里混着
 *      与句柄化无关的成分（那口数就不能记在句柄化账上）。
 *   ③ 宽松口径的 ok 集合**不**包含严格口径的 ok 集合：说明两个口径量的不是同一种东西，
 *      上界这个说法本身失效（判据 J1 当场红）。
 *   ④ 判 ok 的条目**没有**落盘（`writeText` 调用 0 次 / 副本 sha256 没变）：那"救回"只是
 *      回执上的字面，不是磁盘上的结果（判据 J2 当场红）。
 *
 * ## 与上游的关系（不许复刻判定层）
 * 重放**只走** `failure-replay.mjs` 导出的 `replayNewContract`（走编排层 `applyEditToProvider`
 * + `createNodeFsProvider`，与 CLI/MCP 同一条路）。本探针自己只做三件事：摊副本（三行，
 * 与上游 `stageCopy` 同形）、选 `old` 的字节、记账。**没有**第二份判定层 —— 本项目反复治过
 * 「复刻走样」（`residual-census` 删掉四个复刻件的理由）。
 *
 * ## 用法
 *   node aura-tools/probes/handle-upper-bound.mjs              # 跑判据（含现场起上游 --json 取活读数）
 *   node aura-tools/probes/handle-upper-bound.mjs --json       # 附机器可读统计（回执就是它）
 *   node aura-tools/probes/handle-upper-bound.mjs --no-upstream  # 不起上游子进程（判据 J4 记「本次没判」）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pkgPath } from '../build/pkg-root.mjs'

// `replayNewContract` = 「现树·新契约」列**那一处实现**。本探针不碰判定层（见文件头「与上游的关系」）。
import { probeEngineOldContract, replayNewContract } from '../src/locator-lab/failure-replay.mjs'
// 坐标解析也走上游同一份（`lineRangeOf` 就是 `failure-replay` 自己用的那把尺子）。
// 自己再写一份 `{start_line, end_line, lines}` 的解析 = 另一条复刻走样的路。
import { lineRangeOf, asLinePair } from '../src/locator-lab/args.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const CORPUS_PATH = pkgPath('src', 'locator-lab', 'failure-corpus.json')
const UPSTREAM = pkgPath('src', 'locator-lab', 'failure-replay.mjs')
const UPSTREAM_TIMEOUT_MS = 20 * 60 * 1000
const UPSTREAM_MAX_BUFFER = 1 << 26

/** 上游 `clip()` 的截断尾巴：带它的文本**不是**区间原文的逐字节副本（句柄不会这么发）。 */
const CLIPPED = /…\(\+\d+ chars\)$/

/**
 * 宽松口径的**每一步自由度**（逐条列出来，因为它是乐观的那一侧）。
 * 机器可读的同一份就在 --json 的 `loose.freedoms` 里 —— 两处只有一处是判据，另一处是打印。
 */
const LOOSE_FREEDOMS = [
  '自由度①「区间由谁圈」：用 `evidence.actual`（语料构建期用**同一条历史寻址参数**在 source.text 上 locate 出来的区域）。这不是"事后挑一段能匹配的"，但也**不是调用方写的坐标** —— 它是引擎自己的坐标解析结果。取它的理由：句柄本来就是**读侧**发的，句柄覆盖哪个区间正是由读侧（引擎）解析出来的，所以"引擎解析出的区域"恰好是句柄语义的那一段。',
  '自由度②「非坐标寻址也算」：`anchor`/`line_cue`/`target` 这类没有行号的条目，严格口径一律排除；宽松口径用 evidence.actual 把它们的区域也圈进来。这一条是宽松口径比严格口径**多出来的全部**。',
  '自由度③「落在空行占位上的算不算」：重放原文有两条来源是**脚手架**（log/receipt），受寻址区间外的行是空行占位。宽松口径对"切出来是空白"的区间一律**排除**（不去邻近行凑一段），所以这一条自由度是**收紧**而不是放松。',
  '自由度④「截断的实证原文」：evidence.actual 是 `clip(actual, 2400)` 存下来的，带截断尾巴的（`…(+N chars)`）**排除** —— 截过的字节不是区间原文的逐字节副本，句柄不会这么发。',
  '自由度⑤「多候选取最好」：一条条目可能同时给出 evidence.actual 与严格坐标区间两份候选字节。宽松口径**两份都试**，任一份寻到址并落盘就计入（哪一份挣来的如实记在逐条证据里）。不这么做，"严格 ⊆ 宽松"就只是运气而不是结构（判据 J1 要求它是结构）。',
]

// ── 账目与工具 ──────────────────────────────────────────────────────────────
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const sha256File = (p) => {
  try {
    return sha256(fs.readFileSync(p))
  } catch {
    return null
  }
}
const u8 = (s) => Buffer.from(String(s), 'utf8')

/** 探针跑前跑后都要对一遍的只读件：引擎与语料。**本探针一个字节都不许改它们。** */
const GUARDED = [
  'src/locator-lab/failure-replay.mjs',
  'src/locator-lab/write-path.mjs',
  'src/locator-lab/locator-api.mjs',
  'src/locator-lab/read-core.mjs',
  'src/locator-lab/args.mjs',
  'src/locator-lab/anchor-core.mjs',
  'src/locator-lab/failure-corpus.json',
]

function focusHunkOf(entry) {
  return entry.hunks?.[entry.focus ?? 0] ?? null
}

/**
 * 摊一份**可写**副本（三行，与上游 `stageCopy` / `stageToolCopy` 同形：内容只有一个来源
 * `entry.source.text`）。每次重放都摊一份新的 —— 上一次 ok 已经把副本改过了，复用它
 * 第二次就是在改后文本上寻址（那是另一件事）。
 */
function stage(entry, tmpDir, label) {
  const ext = path.extname(entry.file) || '.txt'
  const toolPath = path.join(tmpDir, `${entry.id}.${label}${ext}`)
  fs.writeFileSync(toolPath, entry.source.text, 'utf8')
  const content = fs.readFileSync(toolPath, 'utf8')
  const inside = path.relative(tmpDir, toolPath)
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`副本跑到临时目录外：${toolPath}`)
  return { content, toolPath }
}

/** 一次「真入口」重放（编排层会真落盘）；抛错也是一条读数，不外泄。 */
async function replayOld(entry, content, old, toolPath) {
  try {
    return await replayNewContract({ entry, content, old, toolPath })
  } catch (error) {
    return {
      outcome: 'fail',
      code: 'THROW',
      detail: String(error?.message ?? error).slice(0, 200),
      address: null,
      writes: 0,
      diskChanged: false,
      attempts: [],
    }
  }
}

// ── 两个口径：「区间原文」到底取哪一段字节 ─────────────────────────────────

/**
 * 口径①（严格）：**那条历史调用自己给出的坐标**覆盖的行，逐字节从快照里切。
 *
 * 坐标只从两处取：聚焦 hunk 自己，或平铺在 `args` 上的同一批键（`flatHunk` 的地址键）。
 * 两处都用上游 `lineRangeOf` 解析 —— 坐标怎么读，与 `failure-replay` 是同一份实现。
 * 切不出字节的一律**排除**（不猜、不缩、不往邻近行凑）。
 */
function strictSpan(entry, content) {
  const fh = focusHunkOf(entry)
  let range = lineRangeOf(fh)
  let from = 'hunk'
  if (range === undefined) {
    range = lineRangeOf(entry.args ?? {})
    from = 'args'
  }
  if (range === undefined) return { determinate: false, reason: 'no_coordinate', detail: '这条调用没有任何坐标（anchor/line_cue/target 不算）：想改哪一段无法从语料确定' }
  const [start, end] = asLinePair(range)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { determinate: false, reason: 'bad_range', detail: `坐标不成区间：${start}-${end}` }
  }
  // 行切分用 '\n'（不在 '\r' 上切）：切出来的字节要**逐字节**等于文件里那一段，
  // 包括行尾的 CRLF。末尾那个空元素是"文件以换行收尾"造成的，不算一行。
  const lines = content.split('\n')
  const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length
  if (end > lineCount) {
    return { determinate: false, reason: 'beyond_eof', detail: `坐标 ${start}-${end} 超出重放原文（${lineCount} 行）：地址落在覆盖范围外`, start, end, lineCount }
  }
  const text = lines.slice(start - 1, end).join('\n')
  if (text.trim().length === 0) {
    return { determinate: false, reason: 'blank_span', detail: `坐标 ${start}-${end} 落在脚手架的空行占位上：那几行不是历史原文的字节，句柄不会持有它`, start, end }
  }
  return { determinate: true, text, start, end, from, lines: end - start + 1, field: from === 'hunk' ? `hunks[${entry.focus ?? 0}].start_line/end_line/lines` : 'args.start_line/end_line/lines' }
}

/** 口径②（宽松）的候选字节，按优先级：evidence.actual → 严格坐标区间。 */
function looseCandidates(entry, content, strict) {
  const out = []
  const dropped = []
  const ev = entry.evidence?.actual
  if (typeof ev === 'string' && ev.length > 0) {
    if (CLIPPED.test(ev)) dropped.push({ origin: 'evidence_actual', reason: 'clipped', detail: '实证原文被 clip 截断过，不是区间原文的逐字节副本' })
    else if (ev.trim().length === 0) dropped.push({ origin: 'evidence_actual', reason: 'blank_span', detail: '实证原文是空白' })
    else out.push({ origin: 'evidence_actual', text: ev, field: 'evidence.actual' })
  }
  if (strict.determinate) out.push({ origin: 'coordinate_span', text: strict.text, field: strict.field })
  return { candidates: out, dropped }
}

// ── 一条条目的重放结果怎么读（本探针的记账，不是引擎的判断）───────────────
const saved = (res) => res.outcome === 'ok' && (res.writes ?? 0) >= 1 && res.diskChanged === true

/**
 * 从上游 stdout 里抠出 `=== JSON ===` 之后那个**缩进多行** JSON 对象。
 *
 * 不能按行找：上游是 `JSON.stringify(…, null, 1)` 打出来的多行文本，按行找会在第一个 `{` 上炸。
 * 也不能光数括号配平：那份 JSON 的**正文里就有花括号**（`probeEngineOldContract` 的 how 里那句
 * `planHunks 接受 {old}`），串内的花括号不参与配平 —— 串里出现**不成对**的花括号时，硬数会把
 * 对象切早或切晚，而切出来的东西多半还能 `JSON.parse` 成功，只是少了几格。
 * 所以扫描要带上"此刻在不在串里"这个状态（含反斜杠转义）。
 */
function parseJsonBlock(text) {
  const lines = String(text).split(/\r?\n/)
  const marker = lines.map((l, n) => [l, n]).filter(([l]) => l.includes('=== JSON ===')).pop()
  if (!marker) return null
  let depth = 0
  let started = false
  let inString = false
  let escaped = false
  const buf = []
  for (let i = marker[1]; i < lines.length; i += 1) {
    const line = lines[i]
    if (!started && line.trim().startsWith('{')) started = true
    if (!started) continue
    buf.push(line)
    for (const ch of line) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        if (inString) escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (depth === 0) break
  }
  try {
    return JSON.parse(buf.join('\n'))
  } catch {
    return null
  }
}

// ── 上游活读数（只读子进程；判据 J4 拿它对账）───────────────────────────────
function readUpstreamLive() {
  const up = spawnSync(process.execPath, [UPSTREAM, '--json'], {
    encoding: 'utf8',
    cwd: REPO,
    timeout: UPSTREAM_TIMEOUT_MS,
    maxBuffer: UPSTREAM_MAX_BUFFER,
    windowsHide: true,
  })
  if (up.error) return { ok: false, why: `起子进程失败：${String(up.error.message).slice(0, 140)}` }
  if (up.status !== 0) return { ok: false, why: `上游 exit ${up.status}：${String(up.stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' ｜ ').slice(0, 200)}` }
  const json = parseJsonBlock(up.stdout)
  if (json === null) return { ok: false, why: '上游 --json 里没有可解析的 "=== JSON ===" 块（标记或形状变了）' }
  const treeNew = json?.columns?.treeNew ?? null
  const codes = json?.totals?.neuCodes ?? null
  if (treeNew === null || codes === null) return { ok: false, why: '上游 --json 里没有 columns.treeNew / totals.neuCodes（形状变了）' }
  return {
    ok: true,
    how: `上游 failure-replay.mjs --json（exit 0）`,
    replayable: json.columns.replayable,
    treeNew,
    notFound: Number(codes.PATCH_NOT_FOUND ?? 0),
    needsChoiceIds: [...(json?.pairs?.needsChoiceIds ?? [])].sort(),
    alreadyAppliedIds: [...(json?.pairs?.alreadyApplied?.ids ?? [])].sort(),
    okWithoutWrite: [...(json?.pairs?.okWithoutWrite ?? [])],
    quotePresentYetNotFound: Number(json?.totals?.neuQuotePresentButNotFound ?? -1),
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--json', '--no-assert', '--no-upstream'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/handle-upper-bound.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const assertMode = !argv.includes('--no-assert')
  const wantUpstream = !argv.includes('--no-upstream')

  const guardedBefore = Object.fromEntries(GUARDED.map((rel) => [rel, sha256File(pkgPath(rel))]))
  const corpusBytes = fs.readFileSync(CORPUS_PATH)

  const corpusDigest = sha256(corpusBytes)
  const corpus = JSON.parse(corpusBytes.toString('utf8'))
  const engine = probeEngineOldContract()

  const upstream = wantUpstream ? readUpstreamLive() : { ok: false, why: '--no-upstream：本次没起上游子进程' }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-h0b-'))
  const facts = []
  let failIds = []
  let handleInputShaBefore = null
  let degradedInputSha = null
  let handleInputShaAfter = null
  try {
    // ── 第 0 趟（退化对照 / 基线）：**句柄化没发生** —— `old` 用调用方自己那段引文。
    //    这一趟同时把上游的活读数在现场重算一遍（分母 + 147 + 需选择集 + 已落地集）。──
    for (const [index, entry] of corpus.entries.entries()) {
      if (!entry.replayable || !entry.source) continue
      if (entry.tool !== 'aura_edit') {
        facts.push({ id: entry.id, tool: entry.tool, outcome: 'na', code: 'READ_PATH', writes: 0, diskChanged: false, attempts: [] })
        continue
      }
      const old = entry.quote?.text ?? null
      if (!old) {
        // 与上游同一条记账：读路径没有 old/context 入口；没有引文的无处可引。
        facts.push({ id: entry.id, tool: entry.tool, outcome: 'unrepresentable', code: 'NO_QUOTE', writes: 0, diskChanged: false, attempts: [] })
        continue
      }
      const { content, toolPath } = stage(entry, tmpDir, `base${index}`)
      const res = await replayOld(entry, content, old, toolPath)
      // 「引文就在原文里、只是寻不到址」与「引文根本不在原文里」是两件事（上游同一道分桶）。
      // 这一格顺带回答了题面提到的**另一条宽松构造**为什么在这批上取不到字节：
      // 若这项为 0，说明这 147 条的引文**连子串都不是**，拿它与快照比对圈不出任何区间。
      facts.push({ id: entry.id, tool: entry.tool, old, oldSha: sha256(u8(old)), quoteInSource: content.includes(old), ...res })
    }

    const replayable = facts.length
    const degradedFail = facts.filter((f) => f.outcome === 'fail')
    failIds = degradedFail.filter((f) => f.code === 'PATCH_NOT_FOUND').map((f) => f.id)
    const degradedSavedIds = facts.filter(saved).map((f) => f.id)
    const degradedBy = {}
    for (const f of facts) degradedBy[f.outcome] = (degradedBy[f.outcome] ?? 0) + 1
    /**
     * 基线趟里两类**看着像 ok、其实没落地**的条目，分开数，一条都不许混进"救回"里：
     *   · `writes = 0` —— 一次盘都没落（与上游 `pairs.okWithoutWrite` 同一判据，应为 0）；
     *   · `writes ≥ 1` 但副本 sha256 没变 —— 真的调了 `writeText`，写回去的却是同样的字节。
     *     它**不是**救回（磁盘上什么都没发生），也不能当成错误：引擎行为如实记账。
     */
    const baseOkNoWrite = facts.filter((f) => f.outcome === 'ok' && (f.writes ?? 0) === 0).map((f) => f.id)
    const baseOkUnchanged = facts.filter((f) => f.outcome === 'ok' && (f.writes ?? 0) >= 1 && f.diskChanged !== true).map((f) => f.id)
    /**
     * 残余里「引文在原文里成子串、却报 PATCH_NOT_FOUND」的条数（上游同一格）。
     * 它现场回答题面提到的那条宽松构造（用旧引文与快照比对圈最小包住区间）能不能取到字节：
     * 这项为 0 ⇒ 这 147 条的引文**连子串都不是**，比对不出任何区间，那条构造在本批上是空的。
     */
    const quotePresentYetNotFound = facts.filter((f) => f.code === 'PATCH_NOT_FOUND' && f.quoteInSource === true).length

    // ── 第 1 趟（严格口径）：坐标覆盖的行，逐字节。──
    const byId = new Map(corpus.entries.map((e) => [e.id, e]))
    const rows = []
    /** 用**现场重新推导**（不读缓存）把某一趟的输入字节打成一个摘要 —— 用作"按字节还原"的凭据。 */
    const inputDigest = (kind) => {
      const h = crypto.createHash('sha256')
      for (const id of failIds) {
        const entry = byId.get(id)
        const { content } = { content: entry.source.text }
        const strict = strictSpan(entry, content)
        const pick =
          kind === 'strict'
            ? strict.determinate
              ? strict.text
              : null
            : kind === 'degraded'
              ? (entry.quote?.text ?? null)
              : looseCandidates(entry, content, strict).candidates[0]?.text ?? null
        h.update(u8(`${id}\u0000`))
        h.update(pick === null ? u8('(不可确定)') : u8(pick))
        h.update(u8('\n'))
      }
      return h.digest('hex')
    }

    handleInputShaBefore = inputDigest('strict')
    degradedInputSha = inputDigest('degraded')

    for (const [index, id] of failIds.entries()) {
      const entry = byId.get(id)
      const { content, toolPath } = stage(entry, tmpDir, `strict${index}`)
      const strict = strictSpan(entry, content)
      const loose = looseCandidates(entry, content, strict)
      let strictRes = null
      if (strict.determinate) {
        strictRes = await replayOld(entry, content, strict.text, toolPath)
      }
      // ── 第 2 趟（宽松口径）：候选逐个试，任一份寻到址并落盘就计入 —— 于是
      //    「严格 ⊆ 宽松」是**结构**而不是运气（判据 J1 读的就是这个包含关系）。
      let looseRes = null
      let looseOrigin = null
      const attempts = []
      for (const cand of loose.candidates) {
        // 与严格口径**同一份字节** ⇒ 同一个结果，不必再重放一遍（判据 J1 要的正是这个同一性）。
        const byteEqual = strictRes !== null && strict.determinate && cand.text === strict.text
        let res = strictRes
        if (!byteEqual) {
          const staged = stage(entry, tmpDir, `loose${index}_${cand.origin}`)
          res = await replayOld(entry, staged.content, cand.text, staged.toolPath)
        }
        attempts.push({ origin: cand.origin, field: cand.field, reusedStrict: byteEqual, outcome: res.outcome, code: res.code, address: res.address ?? null, writes: res.writes ?? 0, diskChanged: res.diskChanged === true })
        if (looseRes === null || (saved(res) && !saved(looseRes))) {
          looseRes = res
          looseOrigin = cand.origin
        }
        if (saved(res)) break
      }
      rows.push({
        id,
        klass: entry.klass,
        source: `${entry.source.kind}/${entry.source.fidelity}`,
        degraded: { code: degradedFail.find((f) => f.id === id)?.code ?? null, quoteKind: entry.quote?.kind ?? null, quoteSha: sha256(u8(entry.quote?.text ?? '')).slice(0, 16) },
        strict: {
          determinate: strict.determinate,
          reason: strict.reason ?? null,
          detail: strict.detail ?? null,
          field: strict.field ?? null,
          span: strict.determinate ? `${strict.start}-${strict.end}（${strict.lines} 行）` : null,
          text: strict.determinate ? strict.text : null,
          outcome: strictRes?.outcome ?? null,
          code: strictRes?.code ?? null,
          address: strictRes?.address ?? null,
          writes: strictRes?.writes ?? 0,
          diskChanged: strictRes?.diskChanged === true,
          saved: strictRes !== null && saved(strictRes),
        },
        loose: {
          determinate: loose.candidates.length > 0,
          origins: loose.candidates.map((c) => c.origin),
          dropped: loose.dropped,
          origin: looseOrigin,
          field: loose.candidates.find((c) => c.origin === looseOrigin)?.field ?? null,
          outcome: looseRes?.outcome ?? null,
          code: looseRes?.code ?? null,
          address: looseRes?.address ?? null,
          writes: looseRes?.writes ?? 0,
          diskChanged: looseRes?.diskChanged === true,
          saved: looseRes !== null && saved(looseRes),
          attempts,
        },
      })
    }
    handleInputShaAfter = inputDigest('strict')

    // ── 判据 ──
    const strictIds = rows.filter((r) => r.strict.saved).map((r) => r.id)
    const looseIds = rows.filter((r) => r.loose.saved).map((r) => r.id)
    const strictExcluded = rows.filter((r) => !r.strict.determinate)
    const looseExcluded = rows.filter((r) => !r.loose.determinate)
    const strictReasons = {}
    for (const r of strictExcluded) strictReasons[r.strict.reason] = (strictReasons[r.strict.reason] ?? 0) + 1
    const looseReasons = {}
    for (const r of looseExcluded) {
      const key = r.strict.reason ?? 'no_candidate'
      looseReasons[key] = (looseReasons[key] ?? 0) + 1
    }
    // 每条条目的三格账：**计入**（真落盘）/ **排除**（字节不可确定）/ **量了但没救回**
    // （区间字节确定、引擎也跑了，但结果是 `needs_choice` / `already_applied` / `fail`）。
    // 第三格是必需的：少了它，「句子化救不回那几条」就只能默不作声地漏掉 ——
    // 而「既没计入也没说明」正是本单要禁的那一手（判据③）。
    const cellsOf = (pick) => {
      const counted = rows.filter((r) => pick(r).saved)
      const excluded = rows.filter((r) => !pick(r).determinate)
      const measured = rows.filter((r) => pick(r).determinate && !pick(r).saved)
      const by = {}
      for (const r of measured) by[`${pick(r).outcome}/${pick(r).code}`] = (by[`${pick(r).outcome}/${pick(r).code}`] ?? 0) + 1
      return { counted, excluded, measured, by }
    }
    const strictCells = cellsOf((r) => r.strict)
    const looseCells = cellsOf((r) => r.loose)
    // `saved()` 是进计入集的**唯一**入口，所以这一条按构造为空；写出来是因为它是判据读了
    // **计入集的字节**再验一遍磁盘读数，而不是引用 `saved()` 的定义自证。
    const countedUnlanded = [...strictCells.counted, ...looseCells.counted].filter((r) => !(saved(r.strict) || saved(r.loose)))
    const alreadyAppliedAmongThem = rows.filter((r) => r.strict.outcome === 'already_applied' || r.loose.outcome === 'already_applied').map((r) => r.id)

    const judgements = []
    const J = (desc, pass, detail) => judgements.push({ desc, pass, detail })

    const looseSet = new Set(looseIds)
    const notSubset = strictIds.filter((id) => !looseSet.has(id))
    J(
      `① 严格口径 ⊆ 宽松口径：严格救回的 ${strictIds.length} 条必须条条都在宽松救回集里`,
      notSubset.length === 0,
      notSubset.length === 0 ? `${strictIds.length} 条全部被宽松口径包含` : `不在宽松集里的：${notSubset.join(', ')}`,
    )
    J(
      '② 每条计进上界的都真的落过盘（writeText ≥ 1 且副本 sha256 变了）；基线趟里 writes = 0 的 ok 必须为 0',
      countedUnlanded.length === 0 && baseOkNoWrite.length === 0,
      `计入集里没落盘的 ${countedUnlanded.length} 条（按构造为 0：saved() 是进计入集的唯一入口，本条是再拿磁盘读数验一遍）；` +
        `基线趟 writes=0 的 ok ${baseOkNoWrite.length} 条；另：基线趟 ok 但副本 sha256 未变的 ${baseOkUnchanged.length} 条 —— 写了同样的字节，看着像 ok，**不计入**任何救回数：${baseOkUnchanged.join(', ') || '（无）'}`,
    )
    const covered = new Set([...strictIds, ...strictCells.excluded.map((r) => r.id), ...strictCells.measured.map((r) => r.id)])
    const looseCovered = new Set([...looseIds, ...looseCells.excluded.map((r) => r.id), ...looseCells.measured.map((r) => r.id)])
    const accountingOk =
      strictCells.counted.length + strictCells.excluded.length + strictCells.measured.length === failIds.length &&
      looseCells.counted.length + looseCells.excluded.length + looseCells.measured.length === failIds.length &&
      covered.size === failIds.length &&
      looseCovered.size === failIds.length &&
      rows.length === failIds.length
    const cellLine = (name, c) =>
      `${name} ${c.counted.length} 计入 + ${c.excluded.length} 排除 + ${c.measured.length} 量了没救回 = ${c.counted.length + c.excluded.length + c.measured.length}`
    J(
      '③ 记账闭合：计入 + 排除 + 量了没救回 = 残余分母，每一条都落在三格之一里（不许有既没计入也没说明的条目）',
      accountingOk,
      `${cellLine('严格', strictCells)}；${cellLine('宽松', looseCells)}；分母 ${failIds.length}（三格去重后 ${covered.size} / ${looseCovered.size}，逐条记录 ${rows.length}）；` +
        `量了没救回的分布：严格 ${Object.entries(strictCells.by).map(([k, v]) => `${k}×${v}`).join('／') || '（无）'}；宽松 ${Object.entries(looseCells.by).map(([k, v]) => `${k}×${v}`).join('／') || '（无）'}`,
    )
    const myNeedsChoice = facts.filter((f) => f.outcome === 'needs_choice').map((f) => f.id).sort()
    const myAlreadyApplied = facts.filter((f) => f.outcome === 'already_applied').map((f) => f.id).sort()
    const setEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
    const upOk = upstream.ok
    const denominatorOk = upOk && upstream.replayable === replayable
    const notFoundOk = upOk && upstream.notFound === failIds.length
    const choiceOk = upOk && setEq(upstream.needsChoiceIds, myNeedsChoice)
    const landedOk = upOk && setEq(upstream.alreadyAppliedIds, myAlreadyApplied)
    const quoteOk = upOk && upstream.quotePresentYetNotFound === quotePresentYetNotFound
    J(
      '④ 与上游活读数一致：可重放分母 / PATCH_NOT_FOUND 条数 / 需选择编号集 / 已落地编号集（现场起上游只读子进程读，不写死）',
      upOk ? denominatorOk && notFoundOk && choiceOk && landedOk && quoteOk : null,
      upOk
        ? `可重放 ${replayable} vs 上游 ${upstream.replayable}；PATCH_NOT_FOUND ${failIds.length} vs 上游 ${upstream.notFound}；需选择集逐条 ${choiceOk ? '一致' : '不一致'}（${myNeedsChoice.length}）；已落地集逐条 ${landedOk ? '一致' : '不一致'}（${myAlreadyApplied.length}）；引文其实在原文里却报 PATCH_NOT_FOUND 的 ${quotePresentYetNotFound} vs 上游 ${upstream.quotePresentYetNotFound}`
        : `—（本次没判：${upstream.why}）`,
    )
    J(
      '⑤ 反向证伪·退化读数掉回去：`old` 换回调用方原引文（句柄化没发生）时，这 147 条救回数必须是 0',
      degradedSavedIds.filter((id) => failIds.includes(id)).length === 0,
      `退化口径（调用方原引文）在残余 ${failIds.length} 条上救回 ${degradedSavedIds.filter((id) => failIds.includes(id)).length} 条；全语料退化口径救回 ${degradedSavedIds.length} 条`,
    )
    J(
      '⑥ 反向证伪·替换真的发生了：句柄口径与退化口径的输入字节摘要必须不同（相同则这一趟对照是空的、等于没替换）',
      degradedInputSha !== handleInputShaBefore,
      `句柄（严格）输入 sha256 ${handleInputShaBefore?.slice(0, 16)}… vs 退化输入 sha256 ${degradedInputSha?.slice(0, 16)}…`,
    )
    J(
      '⑦ 替换按字节还原：退化趟跑完后，重新从语料现场推导一遍句柄口径输入，摘要必须与前一份逐字节相同',
      handleInputShaAfter === handleInputShaBefore,
      `还原前 ${handleInputShaBefore?.slice(0, 16)}… / 还原后 ${handleInputShaAfter?.slice(0, 16)}…`,
    )
    const guardedAfter = Object.fromEntries(GUARDED.map((rel) => [rel, sha256File(pkgPath(rel))]))
    const drifted = GUARDED.filter((rel) => guardedBefore[rel] !== guardedAfter[rel])

    J(
      '⑧ 探针没动引擎/语料：重放前后被守护的只读件 sha256 逐件相同',
      drifted.length === 0,
      drifted.length === 0 ? `${GUARDED.length} 件逐件相同` : `变了的：${drifted.join(', ')}`,
    )

    // ── 打印 ──
    console.log('=== H0b：句柄化上界测量 ===')
    console.log(`  语料 ${path.relative(REPO, CORPUS_PATH)} ｜ sha256:16=${corpusDigest.slice(0, 16)} ｜ builtAt=${corpus.builtAt} ｜ schema=${corpus.schema}`)
    console.log(`  引擎 ${engine.ready ? '就绪' : '未就绪'}：${engine.how}`)
    console.log(
      `  现场读数：可重放 ${replayable} ｜ 残余 PATCH_NOT_FOUND ${failIds.length} ｜ 分桶 ${Object.entries(degradedBy)
        .map(([k, v]) => `${k}=${v}`)
        .join(' / ')}`,
    )
    console.log('')
    console.log(`  ── 口径① 严格（坐标覆盖的行，零自由度）──`)
    console.log(`     救回 ${strictIds.length} 条 ｜ 不可确定排除 ${strictExcluded.length} 条 ｜ 分母 ${failIds.length}`)
    console.log(`     排除理由：${Object.entries(strictReasons).map(([k, v]) => `${k} ${v}`).join(' ｜ ') || '（无）'}`)
    console.log(`     量了没救回 ${strictCells.measured.length} 条（区间字节确定，但引擎没寻到唯一落点）：${Object.entries(strictCells.by).map(([k, v]) => `${k}×${v}`).join(' ｜ ') || '（无）'}`)
    console.log(`     ${strictIds.join(', ') || '（空）'}`)
    console.log(`  ── 口径② 宽松（语料能确定的最小包住区间；自由度逐条列在文件头）──`)
    console.log(`     救回 ${looseIds.length} 条 ｜ 不可确定排除 ${looseExcluded.length} 条 ｜ 量了没救回 ${looseCells.measured.length} 条 ｜ 分母 ${failIds.length}`)
    console.log(`     排除理由：${Object.entries(looseReasons).map(([k, v]) => `${k} ${v}`).join(' ｜ ') || '（无）'}`)
    console.log(`     量了没救回：${Object.entries(looseCells.by).map(([k, v]) => `${k}×${v}`).join(' ｜ ') || '（无）'} —— ${looseCells.measured.map((r) => r.id).join(', ') || '（无）'}`)
    console.log(`     ${looseIds.join(', ') || '（空）'}`)
    console.log(`     这 ${failIds.length} 条里落在第四态 already_applied 的 ${alreadyAppliedAmongThem.length} 条（**不计**入救回）：${alreadyAppliedAmongThem.join(', ') || '（无）'}`)
    console.log('')
    console.log('  ── 逐条一行证据（严格 / 宽松 / 退化对照）──')
    for (const r of rows) {
      const s = r.strict.determinate ? `严格[${r.strict.field} ${r.strict.span}] ${r.strict.outcome}${r.strict.address ? `(${r.strict.address})` : ''}` : `严格[排除 ${r.strict.reason}]`
      const l = r.loose.determinate ? `宽松[${r.loose.origin}] ${r.loose.outcome}${r.loose.address ? `(${r.loose.address})` : ''}` : `宽松[排除]`
      console.log(`   ${r.id} ${String(r.klass).padEnd(10)} ${r.source.padEnd(12)} ${s.padEnd(46)} ${l.padEnd(30)} 退化[引文 ${r.degraded.quoteKind} ${r.degraded.quoteSha}] ${r.degraded.code}`)
    }
    console.log('')
    console.log(`  ── 反向证伪（句柄化没发生）──`)
    console.log(`     退化口径（old = 调用方原引文）：全语料救回 ${degradedSavedIds.length} 条，残余 ${failIds.length} 条里救回 ${degradedSavedIds.filter((id) => failIds.includes(id)).length} 条`)
    console.log(`     句柄(严格)输入 sha256 = ${handleInputShaBefore}`)
    console.log(`     退化输入   sha256 = ${degradedInputSha}`)
    console.log(`     还原后     sha256 = ${handleInputShaAfter}`)
    console.log('')
    console.log('  ── 判据 ──')
    for (const j of judgements) console.log(`   ${j.pass === true ? '✓' : j.pass === null ? '—' : '✗'} ${j.desc}\n       ${j.detail}`)
    const failed = judgements.filter((j) => j.pass === false)
    const judged = judgements.filter((j) => j.pass !== null)
    console.log('')
    console.log(`  判据 ${judged.filter((j) => j.pass).length}/${judged.length} 通过${judgements.length > judged.length ? `（${judgements.length - judged.length} 条本次没判）` : ''}`)

    // 假设与证伪条件随读数一起印 —— 上界最容易的误读就是把它当成"交付后能救回这么多"。
    console.log('')
    console.log('  假设：这条数假设调用方手里恰好有一个覆盖它想改那一段的句柄；真实会话里这个假设成不成立，')
    console.log('        要等句柄化落地后用真会话读数回答。本探针量的是**机制的容量**，不是交付后的效果。')
    console.log('  证伪：① 严格口径远小于 147 ⇒ 病因是坐标/覆盖而不是引文转述；② 退化对照没掉回 0 ⇒ 计入口径混了别的成分；')
    console.log('        ③ 严格 ⊄ 宽松 ⇒ 两个口径量的不是同一种东西；④ 判 ok 的没落盘 ⇒ "救回"只是回执上的字面。')

    if (json) {
      const receipt = {
        unit: 'h0b-upper-bound',
        probe: 'aura-tools/probes/handle-upper-bound.mjs',
        corpus: { path: 'aura-tools/src/locator-lab/failure-corpus.json', sha256: corpusDigest, builtAt: corpus.builtAt, schema: corpus.schema },
        engine: { ready: engine.ready, how: engine.how, guarded: guardedAfter },
        upstream: upstream.ok
          ? { ok: true, how: upstream.how, replayable: upstream.replayable, notFound: upstream.notFound, needsChoiceIds: upstream.needsChoiceIds, alreadyAppliedIds: upstream.alreadyAppliedIds }
          : { ok: false, why: upstream.why },
        replayable,
        notFoundTotal: failIds.length,
        buckets: degradedBy,
        strict: {
          count: strictIds.length,
          ids: strictIds,
          excluded: strictExcluded.length,
          excludedReason: Object.entries(strictReasons).map(([k, v]) => `${k}×${v}`).join('；') || '（无）',
          excludedIds: strictExcluded.map((r) => `${r.id}(${r.strict.reason})`),
          measuredNotSaved: strictCells.measured.length,
          measuredByCode: strictCells.by,
          measuredIds: strictCells.measured.map((r) => `${r.id}(${r.strict.outcome}/${r.strict.code})`),
        },
        loose: {
          count: looseIds.length,
          ids: looseIds,
          excluded: looseExcluded.length,
          excludedReason: Object.entries(looseReasons).map(([k, v]) => `${k}×${v}`).join('；') || '（无）',
          excludedIds: looseExcluded.map((r) => `${r.id}(${r.strict.reason ?? 'no_candidate'})`),
          measuredNotSaved: looseCells.measured.length,
          measuredByCode: looseCells.by,
          measuredIds: looseCells.measured.map((r) => `${r.id}(${r.loose.outcome}/${r.loose.code})`),
          freedoms: LOOSE_FREEDOMS,
        },
        alreadyAppliedAmongThem: { count: alreadyAppliedAmongThem.length, ids: alreadyAppliedAmongThem, note: '第四态不计入救回：它一个字节都没写（写盘次数 0、副本 sha256 未变）' },
        baseline: {
          what: '基线趟 = 现树·新契约列（old 取调用方自带引文 entry.quote.text），在本探针里现场重算一遍上游读数',
          buckets: degradedBy,
          okWithoutWrite: baseOkNoWrite,
          okButDiskUnchanged: baseOkUnchanged,
        },
        diskEvidence: { rule: '每条计进上界的都要求 writeText 调用 ≥ 1 且可写副本 sha256 变了', countableUnlanded: countedUnlanded.length, okIds: [...strictIds, ...looseIds] },
        /**
         * 排除项的边界（不许猜，所以也不许把"今天磁盘上有这个文件"当成字节来源）：
         * `drift.fileExistsToday` 是语料自己的记录。今天那份文件即使还在，也可能已经漂移过 ——
         * 拿今天的字节去当"调用方想改的那一段"，正是这 147 条失败的成因本身。
         */
        excludedBoundary: {
          note: '排除项 = 从语料确定不出"想改那一段"的字节：坐标越界 / 落在脚手架空行占位上 / 根本没有坐标；这些条目一律不猜、不计入上界',
          strictFileExistsToday: strictExcluded.filter((r) => byId.get(r.id)?.drift?.fileExistsToday === true).length,
          looseFileExistsToday: looseExcluded.filter((r) => byId.get(r.id)?.drift?.fileExistsToday === true).length,
          quotePresentYetNotFound,
          quotePresentYetNotFoundNote: '残余里引文其实在原文里成子串、却报 PATCH_NOT_FOUND 的条数。为 0 ⇒ 题面另一条宽松构造（拿旧引文与快照比对圈最小包住区间）在这 147 条上取不到任何字节，它的候选集是空的。',
        },
        degraded: {
          what: '把"用逐字区间当 old"退化成"用调用方原来那段引文当 old"（即句柄化没发生）',
          count: degradedSavedIds.filter((id) => failIds.includes(id)).length,
          countWholeCorpus: degradedSavedIds.length,
          shaHandleStrictInput: handleInputShaBefore,
          shaDegradedInput: degradedInputSha,
          shaBefore: handleInputShaBefore,
          shaAfterRestore: handleInputShaAfter,
        },
        rows,
        assumptions: [
          '这条数假设调用方手里恰好有一个覆盖它想改那一段的句柄；真实会话里这个假设成不成立，要等句柄化落地后用真会话读数回答。',
          '严格口径把"想改的那一段"等同于"那条历史调用自己给出的坐标覆盖的行"——调用方当时的坐标就是它想改的地方，这一点不由本探针担保。',
          '宽松口径把"想改的那一段"取成语料能确定的区域原文（evidence.actual / 坐标区间），其每一步自由度逐条列在 loose.freedoms 与文件头 LOOSE_FREEDOMS 里。',
          '两个口径量的都是「字节条件」：句柄里的字节能否寻到址并落盘。模型会不会去要句柄、要到的句柄覆不覆盖目标，不在本探针的测量范围内。',
          '排除项不猜：坐标落在覆盖范围外/空行占位上、实证原文被截断的，一律排除在上界之外（它们连"句柄里该有什么字节"都无法从语料确定）。',
        ],
        falsification: [
          '严格口径救回数远小于残余分母（个位数级）⇒「句柄化救得回 147」是错的：病因是坐标/读侧覆盖，不是引文转述。',
          '退化对照（old = 调用方原引文）没有掉回 0 ⇒ 本探针量到的"救回"混着与句柄化无关的成分，不能记在句柄化账上。',
          '严格口径的 ok 集合不包含于宽松口径的 ok 集合 ⇒ 两个口径量的不是同一种东西，"上界"这个说法本身失效。',
          '判 ok 的条目里出现 writes = 0 或副本 sha256 未变 ⇒ 那不是救回，只是回执上的字面。',
          '上游 failure-replay --json 的可重放分母或 PATCH_NOT_FOUND 条数与本探针现场读数不一致 ⇒ 本探针的分母或重放入口与上游分叉了（先修入口，再谈上界）。',
        ],
        judgements,
        exit: assertMode && failed.length > 0 ? 1 : 0,
      }
      console.log('')
      console.log('=== JSON ===')
      console.log(JSON.stringify(receipt, null, 1))
    }

    if (assertMode && failed.length > 0) process.exitCode = 1
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响读数 */
    }
  }
}

main().catch((error) => {
  console.error(`✗ handle-upper-bound 自身抛错：${String(error?.stack ?? error)}`)
  process.exitCode = 1
})
