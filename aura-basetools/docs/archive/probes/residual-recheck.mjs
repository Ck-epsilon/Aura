/**
 * residual-recheck.mjs —— R1 的**独立复算器**（复算代理自己写的，不 import 被复算的探针）。
 *
 * ## 它与 `residual-census.mjs` 的关系
 *
 * `residual-census.mjs` 是**测量方**的探针。本文件是**复算方**的探针：从零重写同一条流水线
 * （语料 → 重放原文 → 三态路由 → 机制阶梯 → X），只共用两样东西：
 *   · 语料 `failure-corpus.json`（被测量的对象，不是量具）；
 *   · 引擎导出 `planHunks` / `locate` / `expectVerdict`（**被测物**，不是量具）。
 *
 * 它**不 import** `residual-census.mjs`，也不 import `failure-replay.mjs`。读到测量方产出的
 * `--json` 是为了**对账**（比 id 集合与逐格计数），不是为了取数。
 *
 * ## 它多加的三件测量
 *
 *   1. **第二把尺子**：对每条 fail 直接问 `expectVerdict`（判据的单源实现，与 `planHunks`
 *      是两条路径）——`null` 表示「判据认为这段引文在全文里成立」。这是对
 *      「存在且唯一、工具没找到」那一问的**独立**问法。
 *   2. **顺序不变量**：hunk 变体按 `[old, old+context]` 与 `[old+context, old]` 各跑一遍分桶；
 *      两遍读数不同 ⇒ 三态分桶依赖尝试顺序（本身就是个发现）。
 *   3. **第四个 X 口径**（`X_firstline`：引文首行逐字、整行、全文唯一），外加**按标签直算**
 *      的 `X_norm_true`（逐字缺席但归一化后恰好一处）——测量方报的 `X_norm` 走的是分类桶，
 *      本文件直接算它标签所指的那个量。
 *
 * 用法：
 *   node aura-tools/probes/residual-recheck.mjs                 # 复算 + 对账
 *   node aura-tools/probes/residual-recheck.mjs --probe-json=<p># 指定测量方 JSON（默认 tmp/recheck-r1-json.txt）
 *   node aura-tools/probes/residual-recheck.mjs --json          # 附机器可读读数
 *   node aura-tools/probes/residual-recheck.mjs --no-assert     # 不因对账不过而 exit 1
 *
 * 退休（2026-10-16，用户裁定）：判定挂在 tmp/recheck-r1-json.txt 这份一次性产物上，产物缺席时它自己印「未做逐格对账」仍 exit 0 ⇒ 空判；保留只为可回溯，不再进闸、不再维护。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { planHunks } from '../src/locator-lab/write-path.mjs'
import { locate, expectVerdict } from '../src/locator-lab/locator-api.mjs'
import { normSpace } from '../src/locator-lab/anchor-core.mjs'
import { lineRangeOf } from '../src/locator-lab/args.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const CORPUS = path.join(REPO, 'aura-tools/src/locator-lab/failure-corpus.json')
const ENGINE_FILES = ['write-path.mjs', 'locator-api.mjs', 'read-core.mjs', 'anchor-core.mjs', 'args.mjs']
const SHORT = 12

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const assertMode = !argv.includes('--no-assert')
const probeJsonPath = path.resolve(REPO, (argv.find((a) => a.startsWith('--probe-json=')) ?? '--probe-json=tmp/recheck-r1-json.txt').slice(13))

// ── 我自己的尺子 ────────────────────────────────────────────────────────────

/** 逐字出现次数（不做任何归一化）。 */
function tally(hay, needle) {
  if (needle === null || needle === '') return 0
  let n = 0
  for (let p = hay.indexOf(needle); p !== -1; p = hay.indexOf(needle, p + 1)) n += 1
  return n
}

/** 整行对齐出现的次数。 */
function wholeLineTally(hay, needle) {
  const rows = needle.replace(/\r\n/g, '\n').split('\n')
  const src = hay.split('\n')
  let n = 0
  for (let i = 0; i + rows.length <= src.length; i += 1) {
    if (src.slice(i, i + rows.length).join('\n') === needle) n += 1
  }
  return n
}

/** 引文里最长的一段「连续且逐字相等的行」。 */
function longestRun(hay, needle) {
  const rows = needle.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '').split('\n')
  const src = hay.split('\n')
  let best = 0
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < src.length; j += 1) {
      let k = 0
      while (i + k < rows.length && j + k < src.length && src[j + k] === rows[i + k]) k += 1
      if (k > best) best = k
    }
  }
  return best
}

function trimQuote(s) {
  return s === null ? null : s.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

function foldPerLine(text) {
  return text.split(/\r?\n/).map((l) => normSpace(l)).join('\n')
}

function sha(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12)
  } catch {
    return 'missing'
  }
}

// ── 重放：我自己的驱动器 ────────────────────────────────────────────────────

/** 把语料里的路径当只读，原文摊到我自己的临时副本上（写+读回，字节才是引擎看到的）。 */
function stage(entry, dir) {
  const ext = path.extname(entry.file) || '.txt'
  const p = path.join(dir, `${entry.id}${ext}`)
  fs.writeFileSync(p, entry.source.text, 'utf8')
  return { copyPath: p, content: fs.readFileSync(p, 'utf8') }
}

/** 旧地址形态（target / lines / line_cue / anchor / near）翻成 locate 的请求。 */
function hintRequest(entry) {
  const h = entry.hunks?.[entry.focus ?? 0] ?? null
  if (!h || typeof h !== 'object') return null
  const req = {}
  if (typeof h.target === 'string' && h.target.trim().length > 0) req.target = h.target
  const range = lineRangeOf(h)
  if (range !== undefined) req.lines = range
  if (typeof h.line_cue === 'string' && h.line_cue.trim().length > 0) req.lineCue = h.line_cue
  if (!req.target && range === undefined && !req.lineCue && typeof h.anchor === 'string' && h.anchor.length > 0) req.anchor = h.anchor
  if (h.near !== undefined) req.near = h.near
  return Object.keys(req).length > 0 ? req : null
}

function quietLocate(text, request) {
  try {
    const r = locate(text, request)
    return r?.ok ? r : null
  } catch {
    return null
  }
}

/** 被寻址那一带的上下行（不含引文自己）——`old+context` 变体要用。 */
function aroundContext(entry, content, copyPath, old) {
  const lines = content.split(/\r?\n/)
  const req = hintRequest(entry)
  let at = -1
  if (req) {
    const r = quietLocate(content, { ...req, filePath: copyPath })
    if (r) at = r.startLine - 1
  }
  if (at < 0) at = lines.findIndex((l) => (old ?? '').length > 0 && l.includes(old))
  if (at < 0) return null
  const ctx = [at - 1 >= 0 ? lines[at - 1] : '', at + 1 < lines.length ? lines[at + 1] : '']
    .filter((l) => l.trim().length > 0)
    .join('\n')
  return ctx.length > 0 ? ctx : null
}

function variantsFor(entry, content, copyPath, old, contextFirst) {
  const hunk = entry.hunks?.[entry.focus ?? 0] ?? null
  const replace = typeof hunk?.replace === 'string' ? hunk.replace : ''
  const ctx = aroundContext(entry, content, copyPath, old)
  const withCtx = ctx ? { old, context: ctx, replace } : null
  const bare = { old, replace }
  if (contextFirst) return withCtx ? [withCtx, bare] : [bare]
  return withCtx ? [bare, withCtx] : [bare]
}

/** 三态路由：ok / needs_choice / fail（我自己的判据：码，或候选清单非空）。 */
function drive(entry, content, copyPath, old, contextFirst) {
  if (entry.tool === 'aura_read') return { outcome: 'na', code: 'READ_PATH', tries: [] }
  if (old === null || old === '') return { outcome: 'unrepresentable', code: 'NO_QUOTE', tries: [] }
  const tries = []
  let sawChoice = false
  let lastCode = 'THROW'
  for (const hunk of variantsFor(entry, content, copyPath, old, contextFirst)) {
    try {
      planHunks(content, [hunk], copyPath)
      return { outcome: 'ok', code: 'OK', tries, via: hunk.context ? 'old+context' : 'old' }
    } catch (error) {
      const code = String(error?.code ?? 'THROW')
      const cands = Array.isArray(error?.candidates) ? error.candidates.length : 0
      lastCode = code
      tries.push({ code, cands, msg: String(error?.message ?? error).slice(0, 200) })
      if (code === 'PATCH_AMBIGUOUS' || cands > 0) sawChoice = true
    }
  }
  return sawChoice
    ? { outcome: 'needs_choice', code: lastCode, tries }
    : { outcome: 'fail', code: lastCode, tries }
}

// ── 我自己的机制阶梯（语义由任务规定，实现独立） ─────────────────────────────

const CLASSES = [
  ['R_read', 'R1 读路径（没有 old/context 入口）'],
  ['R_noquote', 'R2 条目没有引文'],
  ['R_address', 'R3 引文是地址不是文本（quote.kind ≠ expect）'],
  ['R_post_edit', 'R4 引文是改后文本（出现在自己的 replace 里）'],
  ['R_stale', 'R5 引文在今天的磁盘上（重放副本过期）'],
  ['R_partial', 'R6 引文只有部分相邻行在原文里'],
  ['R_absent', 'R7 引文整块都不在原文里'],
  ['R_defect_line', 'R8 引文逐字+整行+唯一，工具仍没找到（缺陷）'],
  ['R_defect_frag', 'R9 引文逐字+片段+唯一，工具仍没找到（缺陷）'],
  ['R_ambiguous', 'R10 引文在原文里多处出现（本该需选择）'],
  ['R_other', 'R11 未归类'],
]

function classOf(entry, f) {
  if (f.tool === 'aura_read') return 'R_read'
  if (f.old === null) return 'R_noquote'
  if (f.quoteKind !== 'expect') return 'R_address'
  // 与测量方同一道闸：`replace` 一旦被语料截断，就不拿它判「引文是改后文本」。
  // 这道闸对读数有影响（见 ③ 的敏感性一行）：守卫关掉时 B02 由 14 涨到 32。
  if (f.oldInReplace && !f.replaceTruncated) return 'R_post_edit'
  if (f.lit === 0) {
    if (f.todayHasOld === true) return 'R_stale'
    return f.longestRun > 0 ? 'R_partial' : 'R_absent'
  }
  if (f.wholeLine === 1) return 'R_defect_line'
  if (f.lit === 1) return 'R_defect_frag'
  return 'R_ambiguous'
}

/** 测量方类目 → 复算方类目的语义映射（只用于对账）。 */
const MIRROR = {
  na_read: ['R_read'],
  no_quote: ['R_noquote'],
  not_text_quote: ['R_address'],
  post_edit_quote: ['R_post_edit'],
  stale_source: ['R_stale'],
  partial_row_block: ['R_partial'],
  absent_from_source: ['R_absent'],
  defect_whole_line_unique: ['R_defect_line'],
  defect_fragment_unique: ['R_defect_frag'],
  ambiguous_in_source: ['R_ambiguous'],
  scaffold_gap: ['R_stale'],
  other: ['R_other'],
}

function readTodayText(fp) {
  try {
    return fs.statSync(fp).isFile() ? fs.readFileSync(fp, 'utf8') : null
  } catch {
    return null
  }
}

function bump(o, k) {
  o[k] = (o[k] ?? 0) + 1
}

function pad(s, n) {
  let w = 0
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  const t = String(s)
  return t + ' '.repeat(Math.max(0, n - w))
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  const digestsBefore = Object.fromEntries(ENGINE_FILES.map((m) => [m, sha(path.join(REPO, 'aura-tools/src/locator-lab', m))]))
  const corpusBytes = fs.readFileSync(CORPUS)
  const corpusDigest = crypto.createHash('sha256').update(corpusBytes).digest('hex').slice(0, 12)
  const corpus = JSON.parse(corpusBytes.toString('utf8'))

  // ── 对账用的测量方读数：先读进来（③b 的落点对照要用），逐格对账在 ⑧ ──
  let probe = null
  let probeErr = null
  try {
    const raw = fs.readFileSync(probeJsonPath, 'utf8')
    probe = JSON.parse(raw.slice(raw.indexOf('=== JSON ===') + '=== JSON ==='.length))
  } catch (e) {
    probeErr = String(e.message ?? e)
  }
  const probeClassById0 = new Map((probe?.fails ?? []).map((f) => [f.id, f.class]))

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-r1-recheck-'))
  const rows = []
  try {
    for (const entry of corpus.entries) {
      if (!entry.replayable || !entry.source) continue
      const { copyPath, content } = stage(entry, tmpDir)
      const old = entry.quote?.text ?? null
      const trimmed = trimQuote(old)

      // 两条尝试顺序各跑一遍（顺序不变量）
      const first = drive(entry, content, copyPath, old, false)
      const alt = drive(entry, content, copyPath, old, true)

      const hay = foldPerLine(content)
      const today = readTodayText(entry.file)
      const focusHunk = entry.hunks?.[entry.focus ?? 0] ?? null
      const replaceHints = (entry.hunks ?? []).map((h) => ({
        replace: typeof h?.replace === 'string' ? h.replace : null,
        truncated: h?.replaceTruncatedAt !== null && h?.replaceTruncatedAt !== undefined,
      }))

      const f = {
        id: entry.id,
        klass: entry.klass,
        at: entry.at,
        tool: entry.tool,
        file: entry.file,
        sourceKind: entry.source.kind,
        fidelity: entry.source.fidelity,
        quoteKind: entry.quote?.kind ?? null,
        old,
        oldChars: old === null ? null : old.length,
        oldRows: trimmed === null ? null : trimmed.split('\n').length,
        // 逐字 / 整行 / 归一化 —— 三把尺子
        lit: old === null ? 0 : tally(content, old),
        wholeLine: old === null ? 0 : wholeLineTally(content, old),
        norm: trimmed === null ? 0 : tally(hay, trimmed),
        normWholeLine: trimmed === null ? 0 : wholeLineTally(hay, trimmed),
        foldSpace: trimmed === null ? 0 : tally(hay, normSpace(trimmed)),
        longestRun: old === null ? 0 : longestRun(content, old),
        firstLineLit: trimmed === null || trimmed.split('\n')[0].trim() === '' ? 0 : tally(content, trimmed.split('\n')[0]),
        firstLineWhole: trimmed === null || trimmed.split('\n')[0].trim() === '' ? 0 : wholeLineTally(content, trimmed.split('\n')[0]),
        oldInReplace: old === null ? false : replaceHints.some((h) => h.replace !== null && h.replace.includes(old)),
        replaceTruncated: replaceHints.some((h) => h.truncated),
        todayExists: today !== null,
        todayHasOld: today === null || old === null ? null : today.includes(old),
        outcome: first.outcome,
        altOutcome: alt.outcome,
        code: first.code,
        tries: first.tries,
        // 第二把尺子：判据单源实现（全文件当区间）
        verdict: null,
      }
      if (old !== null && trimmed !== null) {
        const lines = content.split(/\r?\n/)
        const v = expectVerdict(lines, 1, lines.length, content, old)
        f.verdict = v === null ? 'PASS' : v.kind
      }
      f.class = classOf(entry, f)
      rows.push(f)
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响读数 */
    }
  }
  const digestsAfter = Object.fromEntries(ENGINE_FILES.map((m) => [m, sha(path.join(REPO, 'aura-tools/src/locator-lab', m))]))

  // ── 我的分桶 ──
  const mine = {}
  for (const r of rows) bump(mine, r.outcome)
  const myFails = rows.filter((r) => r.outcome === 'fail')
  const myChoices = rows.filter((r) => r.outcome === 'needs_choice')
  const myUnrep = rows.filter((r) => r.outcome === 'unrepresentable')
  const myNa = rows.filter((r) => r.outcome === 'na')
  const orderFlips = rows.filter((r) => r.outcome !== r.altOutcome)

  const perClass = {}
  for (const f of myFails) bump(perClass, f.class)

  const bySource = {}
  for (const r of rows) bump(bySource, `${r.sourceKind}|${r.outcome}`)
  const strata = {}
  for (const r of rows) bump(strata, r.sourceKind)

  const nonDisk = rows.filter((r) => r.sourceKind !== 'disk')
  const nonDiskBuckets = {}
  for (const r of nonDisk) bump(nonDiskBuckets, r.outcome)
  const nonDiskFails = nonDisk.filter((r) => r.outcome === 'fail')
  const nonDiskByClass = {}
  for (const f of nonDiskFails) bump(nonDiskByClass, f.class)

  // ── 我的 X（四个口径） ──
  const xStrict = myFails.filter((f) => f.lit === 1 && f.wholeLine === 1)
  const xBroad = myFails.filter((f) => f.lit === 1)
  const xNormTrue = myFails.filter((f) => f.lit === 0 && f.norm === 1)
  const xFirstLine = myFails.filter((f) => f.firstLineWhole === 1)
  const normOnlyAnywhere = rows.filter((r) => r.lit === 0 && r.norm === 1 && r.old !== null)

  const differ = []
  const line = (label, a, b) => `${pad(label, 34)} 我=${pad(a, 6)} 测量方=${pad(b, 6)} ${String(a) === String(b) ? '✓' : '✗'}`

  console.log('')
  console.log('=== R1 独立复算（residual-recheck） ===')
  console.log(`  语料 ${path.relative(REPO, CORPUS)} ｜ sha256:12=${corpusDigest} ｜ builtAt=${corpus.builtAt}`)
  console.log(`  引擎 ${ENGINE_FILES.map((m) => `${m}=${digestsBefore[m]}`).join('  ')}`)
  console.log(`  我加载的可重放条目 ${rows.length} 条（replayable && source）`)
  console.log('')
  console.log('── ① 三态分桶（我自己的驱动器；测量方期望 143/174/15/17/4） ──')
  const bExpect = probe?.buckets ?? { ok: 143, fail: 174, needs_choice: 15, unrepresentable: 17, na: 4 }
  for (const k of ['ok', 'fail', 'needs_choice', 'unrepresentable', 'na']) {
    const a = mine[k] ?? 0
    const b = bExpect[k] ?? 0
    if (a !== b) differ.push(`分桶 ${k}`)
    console.log(`    ${line(k, a, b)}`)
  }
  const mySum = Object.values(mine).reduce((x, y) => x + y, 0)
  console.log(`    合计 我=${mySum} ｜ 测量方分母=${probe?.corpus?.replayable ?? 353} ${mySum === (probe?.corpus?.replayable ?? 353) ? '✓' : '✗'}`)
  console.log('')
  console.log('── ② 尝试顺序不变量（[old, old+context] vs [old+context, old]） ──')
  console.log(`    分桶翻转的条目：${orderFlips.length} 条 ${orderFlips.length ? '✗ ' + orderFlips.map((r) => `${r.id}:${r.outcome}→${r.altOutcome}`).slice(0, 20).join(' ') : '✓'}`)
  console.log('')
  console.log('── ③ 机制分布（分母 = 我的 fail） ──')
  const mirrorCount = {}
  if (probe) for (const f of probe.fails) bump(mirrorCount, f.class)
  for (const [k, label] of CLASSES) {
    const a = perClass[k] ?? 0
    const b = Object.entries(mirrorCount).filter(([pk]) => (MIRROR[pk] ?? []).includes(k)).reduce((s, [, v]) => s + v, 0)
    const mark = probe ? (a === b ? '✓' : '✗') : ''
    if (probe && a !== b) differ.push(`机制 ${k}`)
    if (a === 0 && b === 0) continue
    console.log(`    ${pad(label, 44)} 我=${pad(a, 4)} 测量方=${pad(b, 4)} ${mark}`)
  }
  console.log(`    合计 我=${myFails.length} ${myFails.length === (probe?.failTotal ?? 174) ? '✓' : '✗'}`)
  const loosePostEdit = myFails.filter((f) => f.oldInReplace)
  const gatedPostEdit = myFails.filter((f) => f.oldInReplace && f.replaceTruncated)
  console.log(`    ③b 敏感性：old 出现在自己的 replace 里（不看截断守卫） = ${loosePostEdit.length} 条；`)
  console.log(`        其中 replace 被截断、测量方因此不判改后文本的 ${gatedPostEdit.length} 条：${gatedPostEdit.map((f) => f.id).join(',') || '(无)'}`)
  console.log(`        这 ${gatedPostEdit.length} 条测量方落点：${Object.entries(gatedPostEdit.reduce((a, f) => { const pc = probeClassById0.get(f.id) ?? 'n/a'; a[pc] = (a[pc] ?? 0) + 1; return a }, {})).map(([k, v]) => `${k}×${v}`).join(' ') || '(无)'}`)
  console.log('')
  console.log('── ④ 来源分层（分母 = 可重放） ──')
  for (const k of ['log', 'receipt', 'disk']) {
    const tot = strata[k] ?? 0
    const bTot = probe?.strata?.[k]?.entries ?? probe?.strata?.[k]?.total ?? null
    const cells = ['ok', 'fail', 'needs_choice', 'unrepresentable', 'na'].map((o) => `${o} ${bySource[`${k}|${o}`] ?? 0}`).join(' ｜ ')
    console.log(`    ${pad(k, 9)} 条目 我=${pad(tot, 4)}${bTot === null ? '' : ` 测量方=${bTot}`} ｜ ${cells}`)
  }
  console.log(`    剔除 disk：分母 我=${nonDisk.length} ｜ ${['ok', 'fail', 'needs_choice', 'unrepresentable', 'na'].map((o) => `${o} ${nonDiskBuckets[o] ?? 0}`).join(' ｜ ')}`)
  console.log(`    非 disk 的 fail 构成：${Object.entries(nonDiskByClass).map(([k, v]) => `${k}×${v}`).join(' ')}`)
  console.log('')
  console.log('── ⑤ X：四个口径（我的 fail 集合上直算） ──')
  console.log(`    X_strict   引文逐字 + 整行对齐 + 全文唯一   = ${xStrict.length} 条 ${xStrict.length ? xStrict.map((f) => f.id).join(',') : '(无)'}`)
  console.log(`    X_broad    + 行内片段唯一                   = ${xBroad.length} 条 ${xBroad.length ? xBroad.map((f) => f.id).join(',') : '(无)'}`)
  console.log(`    X_norm_true 逐字缺席 + 归一化后恰好一处（测量方 X_norm 标签所指的量） = ${xNormTrue.length} 条 ${xNormTrue.length ? xNormTrue.map((f) => f.id).join(',') : '(无)'}`)
  console.log(`    X_firstline 引文首行逐字 + 整行 + 全文唯一（我加的粗口径） = ${xFirstLine.length} 条 ${xFirstLine.length ? xFirstLine.map((f) => f.id).slice(0, 30).join(',') : '(无)'}`)
  console.log(`    （X_norm_true 的全语料对照：可重放 ${rows.length} 条里，逐字缺席而归一化恰好一处的共 ${normOnlyAnywhere.length} 条：${normOnlyAnywhere.map((r) => `${r.id}/${r.outcome}`).join(',') || '(无)'}）`)
  console.log('')
  console.log('── ⑥ 第二把尺子：expectVerdict（全文件当区间）对每条 fail 的结论 ──')
  const verdicts = {}
  for (const f of myFails) bump(verdicts, f.verdict ?? 'n/a')
  for (const [k, v] of Object.entries(verdicts).sort((a, b) => b[1] - a[1])) console.log(`    ${pad(k, 18)} ${v} 条`)
  const verdictPass = myFails.filter((f) => f.verdict === 'PASS')
  const verdictUnique = myFails.filter((f) => f.verdict === 'not_unique')
  console.log(`    ⇒ 判据认为「成立」的 fail：${verdictPass.length} 条 ${verdictPass.length ? verdictPass.map((f) => f.id).join(',') : '(无)'}`)
  console.log(`    ⇒ 判据认为「多处出现、本该需选择」的 fail：${verdictUnique.length} 条 ${verdictUnique.length ? verdictUnique.map((f) => f.id).join(',') : '(无)'}`)
  console.log('')
  console.log('── ⑦ 三态路由的旁证 ──')
  console.log(`    需选择 ${myChoices.length} 条：有引文 ${myChoices.filter((r) => r.old !== null).length} ｜ 逐字出现 ≥1 ${myChoices.filter((r) => r.lit > 0).length} ｜ 归一化后 ≥1 ${myChoices.filter((r) => r.norm > 0).length}`)
  console.log(`    无从表达 ${myUnrep.length} 条：没有引文 ${myUnrep.filter((r) => r.old === null).length} ｜ 有引文 ${myUnrep.filter((r) => r.old !== null).length}`)
  console.log(`    无对应入口 ${myNa.length} 条：${myNa.map((r) => `${r.id}/${r.tool}`).join(',') || '(无)'}`)
  console.log(`    fail 里引文逐字 ≥2 处：${myFails.filter((f) => f.lit > 1).length} 条 ｜ 逐字 ≥1 处：${myFails.filter((f) => f.lit > 0).length} 条`)
  console.log(`    fail 里引文单行 ${myFails.filter((f) => f.oldRows === 1).length} 条 ｜ 多行 ${myFails.filter((f) => f.oldRows > 1).length} 条 ｜ 无引文 ${myFails.filter((f) => f.old === null).length} 条`)
  console.log(`    fail 里路径今天已不存在：${myFails.filter((f) => f.todayExists === false).length} 条`)
  console.log(`    引文有 ≥1 行逐字连续命中：${myFails.filter((f) => f.longestRun > 0).length} 条 ｜ 全部行都命中：${myFails.filter((f) => f.longestRun > 0 && f.longestRun === f.oldRows).length} 条`)

  // ── 逐条集合对账 ──
  if (probe) {
    const probeFailIds = probe.fails.map((f) => f.id)
    const myFailIds = myFails.map((f) => f.id)
    const setProbe = new Set(probeFailIds)
    const setMine = new Set(myFailIds)
    const onlyProbe = probeFailIds.filter((id) => !setMine.has(id))
    const onlyMine = myFailIds.filter((id) => !setProbe.has(id))
    console.log('')
    console.log('── ⑧ fail 集合逐条对账（测量方 --json 的 fails[] vs 我的 fails） ──')
    console.log(`    测量方 ${probeFailIds.length} 条 ｜ 我 ${myFailIds.length} 条 ｜ 只在测量方 ${onlyProbe.length} 条 ${onlyProbe.join(',') || '(无)'} ｜ 只在我 ${onlyMine.length} 条 ${onlyMine.join(',') || '(无)'}`)
    if (onlyProbe.length || onlyMine.length) differ.push('fail 集合')

    // 逐条机制一致性
    const probeClassById = new Map(probe.fails.map((f) => [f.id, f.class]))
    let same = 0
    const mismatch = []
    for (const f of myFails) {
      const pc = probeClassById.get(f.id)
      if (pc === undefined) continue
      if ((MIRROR[pc] ?? []).includes(f.class)) same += 1
      else mismatch.push(`${f.id}: 我=${f.class} 测量方=${pc}`)
    }
    console.log(`    逐条机制一致 ${same}/${myFails.length} ｜ 不一致 ${mismatch.length} 条 ${mismatch.slice(0, 20).join(' ; ') || '(无)'}`)
    if (mismatch.length) differ.push('逐条机制')

    // 测量方报的 X 编号集合
    const px = probe.X ?? {}
    console.log(`    测量方 X：strict=${px.strict} broad=${px.broad} norm=${px.norm} ｜ 我注：X_norm 走分类桶，见下`)
    // 测量方报的机制桶里 defect_norm_unique 是否出现过
    console.log(`    测量方机制桶 defect_norm_unique = ${probe.mechanism?.defect_norm_unique ?? 0}（我这一侧 R_defect_norm 类目不存在）`)
    console.log(`    测量方 nearMiss 条数 = ${(probe.nearMiss ?? []).length} ｜ 我算「≥1 行逐字连续命中」 = ${myFails.filter((f) => f.longestRun > 0).length}`)
  } else {
    console.log('')
    console.log(`  （没读到测量方 JSON：${probeErr} —— 只报我自己的读数，不做逐格对账）`)
  }

  console.log('')
  console.log('── ⑨ 引擎文件跑前/跑后 ──')
  const drift = ENGINE_FILES.filter((m) => digestsBefore[m] !== digestsAfter[m])
  console.log(`    ${drift.length === 0 ? '逐项未变 ✓' : '变了 ✗ ' + drift.join(',')}`)
  if (drift.length) differ.push('引擎摘要')

  console.log('')
  console.log('=== 对账结论 ===')
  if (!probe) {
    console.log('  测量方 JSON 缺席，未做逐格对账')
  } else if (differ.length === 0) {
    console.log('  与测量方读数逐格一致 ✓')
  } else {
    console.log(`  有 ${differ.length} 格对不上：${differ.join('、')} ✗`)
  }

  if (wantJson) {
    console.log('')
    console.log('=== JSON ===')
    console.log(JSON.stringify({
      unit: 'R1-recheck',
      corpus: { sha256_12: corpusDigest, builtAt: corpus.builtAt, entries: corpus.entries.length, replayable: rows.length },
      engine: { before: digestsBefore, after: digestsAfter, drift },
      buckets: mine,
      orderFlips: orderFlips.map((r) => ({ id: r.id, a: r.outcome, b: r.altOutcome })),
      mechanism: perClass,
      strata,
      bySource,
      nonDisk: { denominator: nonDisk.length, buckets: nonDiskBuckets, byClass: nonDiskByClass },
      X: {
        strict: xStrict.map((f) => f.id),
        broad: xBroad.map((f) => f.id),
        normTrue: xNormTrue.map((f) => f.id),
        firstLine: xFirstLine.map((f) => f.id),
        normOnlyAnywhere: normOnlyAnywhere.map((r) => ({ id: r.id, outcome: r.outcome })),
      },
      verdicts,
      verdictPassIds: verdictPass.map((f) => f.id),
      verdictNotUniqueIds: verdictUnique.map((f) => f.id),
      failIds: myFails.map((f) => f.id),
      fails: myFails.map((f) => ({
        id: f.id, klass: f.klass, class: f.class, source: `${f.sourceKind}/${f.fidelity}`, quoteKind: f.quoteKind,
        oldChars: f.oldChars, oldRows: f.oldRows, lit: f.lit, wholeLine: f.wholeLine, norm: f.norm,
        normWholeLine: f.normWholeLine, foldSpace: f.foldSpace, longestRun: f.longestRun,
        firstLineWhole: f.firstLineWhole, oldInReplace: f.oldInReplace, replaceTruncated: f.replaceTruncated,
        todayExists: f.todayExists, todayHasOld: f.todayHasOld, verdict: f.verdict, tries: f.tries,
      })),
      differ,
    }, null, 1))
  }

  process.exit(assertMode && differ.length > 0 ? 1 : 0)
}

main()
