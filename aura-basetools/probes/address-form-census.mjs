#!/usr/bin/env node
/**
 * C34 —— 旧地址形态在新契约下的口径（fs-contract-v2 波 10）
 *
 * ## 要回答的问题
 *
 * 残余普查（`residual-census.mjs`）把新契约下仍失败的 147 条归了类，其中
 * **B01 = 11 条**，标签「引文不是文本（target/anchor/line_cue 被当字面量）」。
 * （C51 之前是 174 归出 12 条：新契约列改走真工具入口之后，F0040 从 fail 变成
 *  `already_applied`（这次不用改），残余少了一条，B01 跟着 12 → 11。）
 * 判据只有一行（`classify()`）：`entry.quote.kind !== 'expect'`。
 *
 * 而新契约**仍然支持** `target` / `anchor` / `line_cue` 三种地址形态
 * （`write-path.mjs:1646` 的 `PATCH_NO_ADDRESS` 白名单、`1660-1669` 把三者原样转发给
 * `locate()` 的 1/2/3/4 层）。所以「B01 = 旧地址形态无从表达」这句注释要先被量一遍：
 *
 *   (a) 语料伪影 —— 重放器把**地址**文本当成了 `old`（换了问题），引擎入口本来就在；
 *   (b) 真缺口   —— 新契约在这三种形态上确实没有入口。
 *
 * ## 做法（三件，逐条都留原始读数）
 *
 * ① 按 residual-census 的**同一把阶梯**重新推出这批 B01（阶梯逐字照抄，不走近路），
 *    并与手抄的编号对账 —— 对不上就红。
 * ② 对每条量三样：原始 hunk 参数长什么样 / 那段地址文本在**重放原文**里在不在（逐字、
 *    整行、归一化、最长逐字连续行段）/ 重放器把它改造成 `old` 之后报什么码。
 * ③ **直接实验**：把**原始 hunk 参数**（而不是被改造成 `old` 的形态）喂给现树的 `planHunks`。
 *    三个变体：A 焦点 hunk 逐字 ｜ B 只留那一种形态（`{anchor|line_cue|target, replace}`）｜
 *    C 整个调用的 hunks 逐字。
 *
 * ## 归因口径（写死在 `VERDICT` 里，逐条可复算）
 *
 *   X 语料伪影   —— A/B/C 任一**成功** ⇒ 入口在且给出了落点，B01 的失败是重放改造出来的。
 *                   ⚠ 「成功」只说「引擎进了那一层并给了落点」，**不说落点就是调用方想要的那一处**：
 *                   地址层（尤其 anchor 的容错层）本来就不拿原文核对落点，除非调用方给了 `expect`。
 *                   落点原文逐条打出来，且标出「与地址文本逐字相同 yes/no」，让人自己判。
 *   Y 真缺口     —— A/B/C 全失败，且**每一个**失败码都是**分派码**
 *                   （`PATCH_NO_ADDRESS` / `LOCATOR_NO_REQUEST` / `ARGS_UNKNOWN_KEY`）
 *                   ⇒ 引擎连「这是哪一种地址形态」都没认出来，那才是真的没入口。
 *   Z 入口在、地址解不开 —— 全失败但报的是层内码（`LOCATOR_CUE_NOT_FOUND` / `PATCH_NOT_FOUND` /
 *                   `PATCH_AMBIGUOUS`）：引擎已经进了那一层才发现这段地址与重放原文对不上。
 *                   不是形态缺口，是夹具/语料账（与 C01「语料过期」、B03「引文不在原文里」同族）。
 *   W 按设计拒绝 —— 全失败但报的是 `LOCATOR_NO_LANGUAGE`：进了 target 层，但这个文件类型
 *                   没有可识别的符号语言（如 `.md`）。
 *
 * X + Y + Z + W = B01 条数，互斥且穷尽（任何一条落不进四格、或出现无 code 的 THROW，都判红）。
 *
 * ## 本探针**不做**什么
 *
 * · 不改语料、不改 `residual-census.mjs`、不改引擎；只 import 引擎现成的导出。
 * · 不写语料里的任何路径：重放原文一律摊到临时目录的副本上（与 failure-replay 同一手法）。
 * · 不重跑「旧入参列 / 冻结基准列」——那两个口径各有自己的单元，这里只量新契约下的地址形态。
 *
 * ## ④ 载体自证（C35 新增；正常运行时也跑，并计入退出码）
 *
 * 「B01 全部归因、Y（真缺口）= 0 ⇒ 三种形态入口齐备」这句结论，靠的是**本探针自己那条判据**。
 * 判据要是判不了它自己的结论，就会出现「印出 Y = 3 仍有入口缺口、退出码却还是 0」这种自相矛盾。
 * 所以每一趟都把**入口被砍掉的合成引擎副本**现跑一遍：把 `write-path.mjs` 里某一种形态转发给
 * `locate()` 的**那一行**整行删掉，拷进临时目录、动态 import，再用**同一把归因判据 + 同一张退出
 * 规则表**重跑这批 B01。三种形态各砍一次 ⇒ 三次都必须变红（R12）并点名那一种形态；
 * 另有一个**逐字拷贝的 control**（一个字节不改）⇒ 必须不红、且与现树读数逐格一致（R11），
 * 用来证明「红」来自被删的那一行、不是来自副本装置本身；变异也必须真的落在副本里（R13）。
 *
 * 用法：`node aura-tools/probes/address-form-census.mjs [--json] [--show=<n>]`
 * 退出码：0 = B01 全部归因 + 对账通过 + **Y（真缺口）= 0** + 载体自证通过；
 *         1 = 上述任一条不成立（读数照常打印）。
 * 判据表：见文件尾部 `EXIT_RULES`（本波只加不减：原 7 条 → 11 条）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { planHunks } from '../src/locator-lab/write-path.mjs'
import { locate } from '../src/locator-lab/locator-api.mjs'
import { lineRangeOf } from '../src/locator-lab/args.mjs'
import { normSpace } from '../src/locator-lab/anchor-core.mjs'
// `replayNewContract` = 上游「现树·新契约」列**那一处实现**（走编排层 `applyEditToProvider`）。
// 本探针不再复刻它（C51）：B01 是残余 fail 的一个子集，残余集合变了 B01 就跟着变 ——
// 两边各跑一份实现时，「名单对不上」与「引擎真改了」在屏幕上长得一模一样。
import { probeEngineOldContract, replayNewContract } from '../src/locator-lab/failure-replay.mjs'
import { pkgRoot } from '../build/pkg-root.mjs'

// 包根从文件位置推导（`build/pkg-root.mjs`）：目录名不参与路径。
const REPO = pkgRoot
const CORPUS_PATH = path.join(REPO, 'src/locator-lab/failure-corpus.json')
const ENGINE_MODULES = ['write-path.mjs', 'locator-api.mjs', 'read-core.mjs', 'anchor-core.mjs', 'args.mjs']
const LOCATOR_DIR = path.join(REPO, 'src/locator-lab')
const ENGINE_ENTRY = 'write-path.mjs'
const RELAX_MIN_CHARS = 12

/**
 * 三种形态各自在 `planHunks` 里**转发给 `locate()` 的那一行**（用片段认，不锁行号）。
 * 「砍掉形态入口」= 把那一行整行删掉：入口守卫还认这个键，但 `locate()` 再也收不到它
 * ⇒ 该形态的单形态 hunk 落进 `LOCATOR_NO_REQUEST`（分派码）⇒ 判 Y 真缺口。
 */
const DISPATCH_SNIPPETS = {
  anchor: '{ anchor: hunk.anchor }',
  line_cue: '{ lineCue: hunk.line_cue }',
  target: '{ target: hunk.target }',
}

/**
 * **手抄自 `residual-census.mjs` 的读数**（C51，2026-10-15 那一趟）——用来对账，
 * 不是从它那里算出来的。它与 residual-census 内部那两组手抄期望是同一类东西：
 * 引擎/语料一动它们就过期，过期时**先查上游**，不要为了让本探针变绿而改这里。
 *
 * **什么时候必须跟着上游更新（写在这里，免得下一次又靠人记）**：
 *   · 只要 `failure-replay.mjs` 那一列（它现在跑的是真工具入口）的分桶或残余集合变了，
 *     `EXPECTED_BUCKETS` 与 `EXPECTED_B01_IDS` **必须同时**重抄 —— 两个常量是一个整体：
 *     B01 = 残余 fail 里 `quote.kind !== 'expect'` 的那一批，残余集合一动，名单就可能少人；
 *   · 更新时机：只有当上游那两件（`failure-replay.mjs` 与 `residual-census.mjs`）都自己
 *     跑绿（exit 0）之后，再把它俩的分桶行 / B01 编号原样抄过来 —— 只改数字，不碰判据；
 *   · **C51 那一次就是活例**：新契约列改走编排层（`applyEditToProvider`）之后，
 *     F0040 从 fail 变成 `already_applied` ⇒ 分桶多一格 `already_applied: 27`、fail 174 → 147，
 *     而 B01 跟着 **12 → 11**（少的就是 F0040）。它不是「引擎少认了一条」，
 *     是「这条调用本来就不需要改」。
 */
const EXPECTED_BUCKETS = { ok: 143, fail: 147, needs_choice: 15, already_applied: 27, unrepresentable: 17, na: 4 }
const EXPECTED_B01_TOTAL = 11
const EXPECTED_B01_IDS = [
  'F0017', 'F0021', 'F0059', 'F0060', 'F0073',
  'F0091', 'F0121', 'F0134', 'F0166', 'F0171', 'F0352',
]

/** 新契约里仍然被 `planHunks` 接受的三种**非文本**地址形态（键名逐字取自语料）。 */
const ADDRESS_FORMS = ['anchor', 'line_cue', 'target']

/**
 * **分派码**：引擎连「这是哪一种地址形态」都没认出来时才会报的码。
 * 只有三个变体**全都**报这一组码，才算 Y 真缺口（缺入口）。
 * 反过来，`LOCATOR_CUE_NOT_FOUND` / `PATCH_NOT_FOUND` / `PATCH_AMBIGUOUS` / `LOCATOR_NO_LANGUAGE`
 * 都是**层内码**——引擎已经进了那一层（`locate()` 的 1/2/3/4 层）才发现地址解不开，
 * 那就证明入口在。码的出处：`locator-api.mjs:505-508`（target 层的前置条件）、`553-590`
 * （lineCue 层的唯一性）、`anchor-core`（anchor 层的相似度/对齐阈值）、`write-path.mjs:1646`。
 */
const DISPATCH_CODES = new Set(['PATCH_NO_ADDRESS', 'LOCATOR_NO_REQUEST', 'ARGS_UNKNOWN_KEY'])

/** 「形态进了层，但该文件类型根本没有符号语言」——按设计拒绝，不是缺入口。 */
const INAPPLICABLE_CODES = new Set(['LOCATOR_NO_LANGUAGE'])

const VERDICT = {
  artifact: 'X 语料伪影（原形态能命中 ⇒ 入口在，失败是重放改造出来的）',
  entryGap: 'Y 真缺口（引擎连形态都没认出来）',
  payload: 'Z 入口在、但这段地址在重放原文里找不到 / 不唯一（夹具与语料账）',
  inapplicable: 'W 入口在、按设计拒绝（形态不适用于该文件类型：没有可识别的符号语言）',
}

const OUTCOME = {
  ok: 'ok',
  fail: 'fail',
  needsChoice: 'needs_choice',
  /** 编排层的第四态（C49）：old 找不到、而 replace 已整行唯一存在 —— 它**不是 fail**，B01 不收它。 */
  alreadyApplied: 'already_applied',
  unrepresentable: 'unrepresentable',
  na: 'na',
}

/**
 * **退出规则表**：一条判据一条规则，逐条独立成句（`C35` 本波只加不减）。
 *   · `scope: 'full'` —— 只有真跑量得到（语料对账 / 引擎摘要漂移）；合成副本那几趟不拿它记分。
 *   · `scope: 'both'` —— 真跑与合成副本共用，是自证要证的那一批。
 *   · `scope: 'proof'` —— 自证装置自己的规矩（R11 不许误红、R12 必须会红、R13 变异必须落实）。
 * R08（Y > 0 ⇒ 非 0）是本波补的那个口子：在这之前，探针会印出「Y = 3：这三种形态上仍有入口缺口」
 * 而退出码仍是 0 —— 结论与退出码各说各话。
 */
const EXIT_RULES = [
  { id: 'R01', scope: 'full', what: 'B01 编号与 residual-census 手抄读数逐字一致' },
  { id: 'R02', scope: 'full', what: '分桶与 residual-census 手抄读数逐格一致' },
  { id: 'R03', scope: 'both', what: `B01 条数 = ${EXPECTED_B01_TOTAL}` },
  { id: 'R04', scope: 'both', what: '归因互斥且穷尽（X + Y + Z + W = 条数）' },
  { id: 'R05', scope: 'both', what: '引文形态都在 {anchor, line_cue, target} 之内' },
  { id: 'R06', scope: 'both', what: '没有无 code 的 THROW（每一次尝试都拿到了引擎的码）' },
  { id: 'R07', scope: 'full', what: '引擎文件在本次测量期间逐项未变' },
  { id: 'R08', scope: 'both', what: 'Y（真缺口）= 0 —— 结论与退出码必须一致' },
  { id: 'R11', scope: 'proof', what: '自证 control（逐字拷贝、一个字节不改）不误红，且与现树读数逐格一致' },
  { id: 'R12', scope: 'proof', what: '三种形态各自的合成缺口副本都判红，且点名那一种形态' },
  { id: 'R13', scope: 'proof', what: '自证变异真的落在副本里（片段唯一且已消失）' },
]

/** `scope: 'both'` 的那几条 —— 合成副本量得到的，也就只有这几条。 */
const BOTH_SCOPE_IDS = new Set(EXIT_RULES.filter((r) => r.scope === 'both').map((r) => r.id))

// ── 复刻 residual-census 的判据阶梯（逐字照抄；本单不改 src/**，也不改那个探针） ──────

/** 与 `residual-census.stageCopy` 同一件事：只读地把重放原文摊到临时目录的副本上。 */
function stageCopy(entry, tmpDir, index) {
  const ext = path.extname(entry.file) || '.txt'
  const copyPath = path.join(tmpDir, `${entry.id}_${index}${ext}`)
  fs.writeFileSync(copyPath, entry.source.text, 'utf8')
  const content = fs.readFileSync(copyPath, 'utf8')
  return { copyPath, content }
}

/**
 * 与 `failure-replay.stageToolCopy` 同一件事：新契约列踩的那份**可写**副本。
 * 它必须与上面那份只读副本分开 —— 编排层在成功那一步会真的写盘，
 * 而本探针后面还要拿 `copyPath` 把原文喂给三个变体做实验（那些实验用的必须是没被动过的原文）。
 */
function stageToolCopy(entry, tmpDir, label) {
  const ext = path.extname(entry.file) || '.txt'
  const toolPath = path.join(tmpDir, `${entry.id}.${label}${ext}`)
  fs.writeFileSync(toolPath, entry.source.text, 'utf8')
  return toolPath
}

/**
 * （C51 删了这里的四个复刻件：`toContentAddress` / `locateQuiet` / `legacyRequest` /
 *  `neighbourContext` —— 它们是上游 `failure-replay.replayNew` 的逐字副本。）
 *
 * 为什么删：B01 这个桶的定义是「残余 fail 里引文取自地址形态的那些」，而**残余集合本身**
 * 由上游那一列决定。上游已经把新契约列接到真工具入口（编排层 `applyEditToProvider`），
 * 本地再复刻一份旧形态就会当场分叉：F0040 在上游已经从 fail 变成 `already_applied`
 * （B01 因此 12 → 11），而本地那份还会把它当 fail 算进 B01 —— 屏幕上只会报一句
 * 「B01 编号与 residual-census 手抄读数不一致」，指不到真正的原因。
 * 现在两边跑的是**同一个导出** `replayNewContract`（见下面那个薄适配层）。
 */

/**
 * 一条条目在本探针里的归属：**与上游同一个函数**（`replayNewContract`）。
 *
 * 本函数只补两种**本探针的记账**（读路径没有 old/context 入口、没有引文可引）；
 * 重放本身、以及第四态（`already_applied`）的判定，都归上游那一个导出 ——
 * B01 的名单因此不会与残余集合分叉。
 */
async function replayNew(entry, content, copyPath, old, ready, toolPath) {
  if (!ready) return { outcome: OUTCOME.unrepresentable, code: 'NOT_READY', detail: 'engine not ready', attempts: [] }
  if (entry.tool === 'aura_read') return { outcome: OUTCOME.na, code: 'READ_PATH', detail: '读路径没有 old/context 入口', attempts: [] }
  if (!old) return { outcome: OUTCOME.unrepresentable, code: 'NO_QUOTE', detail: '该条目没有可引用的原文', attempts: [] }
  return replayNewContract({ entry, content, old, toolPath })
}

// ── 取证工具（与 residual-census 同一把尺子） ─────────────────────────────────

/** 整篇按行 `normSpace` 后用 `\n` 拼起来（换行不能被折成空格，否则没有行了）。 */
function normaliseContent(content) {
  return content.split(/\r?\n/).map((l) => normSpace(l)).join('\n')
}

/** `want` 在 `hay` 里的每一处出现，映射成 `{start, end}`（1-based 行号）。 */
function occurrenceSpans(hay, want) {
  const out = []
  if (!want) return out
  const lines = hay.split('\n')
  const offsets = []
  for (let i = 0, off = 0; i < lines.length; i += 1) {
    offsets.push(off)
    off += lines[i].length + 1
  }
  const lineAt = (offset) => {
    let i = offsets.length - 1
    while (i > 0 && offsets[i] > offset) i -= 1
    return i + 1
  }
  const seen = new Set()
  for (let p = hay.indexOf(want); p !== -1; p = hay.indexOf(want, p + 1)) {
    const start = lineAt(p)
    const end = lineAt(p + want.length - 1)
    const key = `${start}-${end}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ start, end })
  }
  return out
}

/** `want` **整行对齐**出现在 `hay` 里的每一处（不是行内片段）。 */
function wholeLineSpans(hay, want) {
  const rows = want.split('\n')
  const lines = hay.split('\n')
  const out = []
  for (let i = 0; i + rows.length <= lines.length; i += 1) {
    if (lines.slice(i, i + rows.length).join('\n') === want) out.push({ start: i + 1, end: i + rows.length })
  }
  return out
}

/** `old` 的最长逐字连续行段：old 的第 i..i+k-1 行在原文里连续出现（逐字相等）的最大 k。 */
function longestExactRowRun(content, old) {
  const srcRows = content.split('\n')
  const rows = old.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '').split('\n')
  let best = { len: 0, oldRow: -1, srcLine: -1 }
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < srcRows.length; j += 1) {
      let k = 0
      while (i + k < rows.length && j + k < srcRows.length && srcRows[j + k] === rows[i + k]) k += 1
      if (k > best.len) best = { len: k, oldRow: i, srcLine: j + 1 }
    }
  }
  return { ...best, rows: rows.length }
}

function readTodayText(fp) {
  if (!fp) return null
  try {
    const st = fs.statSync(fp)
    if (!st.isFile()) return null
    return fs.readFileSync(fp, 'utf8')
  } catch {
    return null
  }
}

/** 一页取证：与 `residual-census.evidenceOf` 同形（够跑那把阶梯即可）。 */
function evidenceOf(entry, content, res) {
  const old = entry.quote?.text ?? null
  const trimmed = old === null ? null : old.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')
  const hayNorm = normaliseContent(content)
  const today = readTodayText(entry.file)
  const replaceHints = (entry.hunks ?? []).map((h) => ({
    replace: typeof h?.replace === 'string' ? h.replace : null,
    replaceTruncatedAt: h?.replaceTruncatedAt ?? null,
    keys: Object.keys(h ?? {}),
  }))
  const ev = {
    tool: entry.tool,
    file: entry.file,
    quoteKind: entry.quote?.kind ?? null,
    sourceKind: entry.source.kind,
    fidelity: entry.source.fidelity,
    sourceChars: content.length,
    sourceLines: content.split('\n').length,
    oldChars: old === null ? null : old.length,
    oldRows: trimmed === null ? null : trimmed.split('\n').length,
    literalSpans: old === null ? [] : occurrenceSpans(content, old),
    literalWholeLineSpans: old === null ? [] : wholeLineSpans(content, old),
    normSpans: trimmed === null ? [] : occurrenceSpans(hayNorm, trimmed),
    normWholeLineSpans: trimmed === null ? [] : wholeLineSpans(hayNorm, trimmed),
    normSpaceSpans: trimmed === null ? [] : occurrenceSpans(hayNorm, normSpace(trimmed)),
    longestExactRowRun: old === null ? null : longestExactRowRun(content, old),
    shortQuote: trimmed === null ? null : trimmed.length < RELAX_MIN_CHARS,
    oldInReplace: old === null ? null : replaceHints.some((h) => h.replace !== null && h.replace.includes(old)),
    replaceTruncated: replaceHints.some((h) => h.replaceTruncatedAt !== null),
    todayExists: today !== null,
    todayHasOld: today === null || old === null ? null : today.includes(old),
    outcome: res.outcome,
    code: res.code,
    attempts: res.attempts,
  }
  ev.class = classify(entry, ev)
  return ev
}

/** 有序阶梯：每条恰好落在第一个命中项上（与 residual-census 逐字同形）。 */
function classify(entry, f) {
  if (f.tool === 'aura_read') return 'na_read'
  if (f.oldChars === null) return 'no_quote'
  if (f.quoteKind !== 'expect') return 'not_text_quote'
  if (!f.replaceTruncated && f.oldInReplace === true) return 'post_edit_quote'
  if (f.literalSpans.length === 0) {
    if (f.todayHasOld === true) return 'stale_source'
    const run = f.longestExactRowRun
    if (run && run.len > 0) return 'partial_row_block'
    return 'absent_from_source'
  }
  if (f.literalWholeLineSpans.length === 1) return 'defect_whole_line_unique'
  if (f.literalSpans.length === 1) return 'defect_fragment_unique'
  if (f.literalWholeLineSpans.length > 1 || f.literalSpans.length > 1) return 'ambiguous_in_source'
  if (f.normWholeLineSpans.length === 1 || f.normSpans.length === 1 || f.normSpaceSpans.length === 1) return 'defect_norm_unique'
  return 'other'
}

// ── ③ 直接实验：原始 hunk 参数 → planHunks ───────────────────────────────────

function flat(s, cap = 200) {
  const t = String(s).replace(/\r?\n/g, '\u23ce')
  return t.length <= cap ? t : `${t.slice(0, cap)}…(+${t.length - cap})`
}

function clip(s, cap) {
  const t = String(s)
  return t.length <= cap ? t : `${t.slice(0, cap)}…(+${t.length - cap})`
}

/**
 * 把一组 hunk 喂给某一棵引擎的 `planHunks`；成功报落点与层，失败报码与原文。
 * `plan` 显式传入（而不是直接闭包现树那个）：真跑与载体自证必须**同一个函数形状**，
 * 否则自证证的就不是真跑用的那条判据。
 */
function tryPlan(plan, content, hunks, copyPath) {
  try {
    const out = plan(content, hunks, copyPath)
    const m = Array.isArray(out.matches) ? out.matches : []
    return {
      ok: true,
      code: 'OK',
      hits: m.map((x) => ({ hunk: x.hunk, tier: x.tier, line: x.line, endLine: x.endLine })),
      tiers: [...new Set(m.map((x) => x.tier))],
      message: '',
      extras: Object.keys(out.matches?.[0] ?? {}).filter((k) => ['fragment', 'fragmentNote', 'coordinateNote', 'byNear'].includes(k)),
      landed: m.map((x) => clip(String(x.actual ?? '').replace(/\r?\n/g, '\u23ce'), 90)),
    }
  } catch (error) {
    return {
      ok: false,
      code: String(error?.code ?? 'THROW'),
      hits: [],
      tiers: [],
      candidates: Array.isArray(error?.candidates) ? error.candidates.length : 0,
      message: flat(error?.message ?? error, 220),
    }
  }
}

function formOnlyHunk(form, focusHunk) {
  return { [form]: focusHunk[form], replace: typeof focusHunk.replace === 'string' ? focusHunk.replace : '' }
}

function sha256File(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex').slice(0, 12)
}

function pad(s, n) {
  const t = String(s)
  let w = 0
  for (const ch of t) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return t + ' '.repeat(Math.max(0, n - w))
}

function listIds(ids) {
  return ids.join(' ')
}

function bumpTally(t, k) {
  t[k] = (t[k] ?? 0) + 1
}

function sha256Text(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
}

// ── 共用判据：真跑与载体自证走同一段代码 ──────────────────────────────────────

/**
 * 归因（**纯函数**）：三个变体的读数 ⇒ X / Y / Z / W。
 * 阈值与口径逐字同文件头；抽成函数就是为了让载体自证能对合成引擎重跑它。
 */
function attribute(variants, addressText) {
  const anyOk = variants.some((v) => v.ok)
  const landing = variants.find((v) => v.ok) ?? null
  const landedExact = landing === null ? null : normSpace(landing.landed.join('\n')) === normSpace(addressText)
  const allInapplicable = !anyOk && variants.length > 0 && variants.every((v) => INAPPLICABLE_CODES.has(v.code))
  const allDispatch = !anyOk && variants.length > 0 && variants.every((v) => DISPATCH_CODES.has(v.code))
  const verdict = anyOk ? 'artifact' : allInapplicable ? 'inapplicable' : allDispatch ? 'entryGap' : 'payload'
  return { anyOk, landing, landedExact, allInapplicable, allDispatch, verdict }
}

/** 拿某一棵引擎（`plan`）把每个 spec 的三个变体重跑一遍，并按同一把归因判据落格。 */
function census(specs, plan) {
  return specs.map((s) => {
    const variantA = s.focusHunk === null ? null : tryPlan(plan, s.content, [s.focusHunk], s.copyPath)
    const variantB =
      s.focusHunk === null || typeof s.focusHunk[s.form] !== 'string'
        ? null
        : tryPlan(plan, s.content, [formOnlyHunk(s.form, s.focusHunk)], s.copyPath)
    const variantC = tryPlan(plan, s.content, s.entry.hunks ?? [], s.copyPath)
    // C 失败时，逐个 hunk 单独喂一遍，指出是哪一个 hunk 拖住了整组调用。
    // （`planHunks` 对每个 hunk 都是在**同一份原文**上定位的，所以单独喂的结果能预测 C 的失败点；
    //   重叠检查是唯一的例外，故标签上写「提示」不写「就是它」。）
    const cPerHunk = variantC.ok ? [] : (s.entry.hunks ?? []).map((h) => tryPlan(plan, s.content, [h], s.copyPath))
    const cFailHint = variantC.ok ? -1 : cPerHunk.findIndex((v) => !v.ok)
    const variants = [variantA, variantB, variantC].filter((v) => v !== null)
    const { landing, landedExact, verdict } = attribute(variants, s.addressText)
    return {
      ...s.row,
      experiment: { A: variantA, B: variantB, C: variantC },
      landing: landing === null ? null : { tiers: landing.tiers, hits: landing.hits, landed: landing.landed, exact: landedExact },
      cFailHint,
      cPerHunk,
      verdict,
    }
  })
}

/** 一组 rows 的合计（归因分桶 / 码总账 / 无 code THROW / 形态 / X 的命中层）。 */
function tally(rows) {
  const byVerdict = { artifact: [], entryGap: [], payload: [], inapplicable: [] }
  for (const r of rows) byVerdict[r.verdict].push(r.id)
  const unclassified = rows.length - Object.values(byVerdict).reduce((a, b) => a + b.length, 0)
  /** 失败码总账：分派码出现 0 次，就是「入口齐备」这句话的原始凭据。 */
  const codeTally = {}
  for (const r of rows) {
    for (const v of Object.values(r.experiment)) {
      if (v === null) continue
      bumpTally(codeTally, v.ok ? 'OK' : v.code)
    }
  }
  /** 无 code 的抛错：出现了就说明「入口在不在」这件事本探针量不到，判红而不是默认它不存在。 */
  const threwIds = rows.filter((r) => Object.values(r.experiment).some((v) => v !== null && v.code === 'THROW')).map((r) => r.id)
  /** B01 这个桶的定义就是「引文是这三种地址形态之一」——出现第四种就说明桶的定义变了，判红。 */
  const unknownForms = rows.filter((r) => !ADDRESS_FORMS.includes(r.form)).map((r) => r.id)
  /** X 的构成：按**命中层**分组 —— 「成功」的含金量依层而不同，分开报。 */
  const xByTier = {}
  for (const r of rows) {
    if (r.verdict !== 'artifact' || r.landing === null) continue
    bumpTally(xByTier, r.landing.tiers.join('+'))
  }
  return { byVerdict, unclassified, codeTally, threwIds, unknownForms, xByTier }
}

/** 退出码规则表实算：返回 `[{ id, text }]`，空数组 = 全绿。 */
function baseProblems(ctx) {
  const { scope, idSetEqual, bucketMismatch, rows, unclassified, unknownForms, threwIds, digestDrift, byVerdict } = ctx
  const out = []
  if (scope === 'full') {
    if (!idSetEqual) out.push({ id: 'R01', text: 'B01 编号与 residual-census 手抄读数不一致' })
    if (bucketMismatch.length) out.push({ id: 'R02', text: '分桶与 residual-census 手抄读数不一致' })
    if (digestDrift.length) out.push({ id: 'R07', text: '引擎文件在本次测量期间发生变化' })
  }
  if (rows.length !== EXPECTED_B01_TOTAL) out.push({ id: 'R03', text: `B01 条数 ${rows.length} ≠ ${EXPECTED_B01_TOTAL}` })
  if (unclassified !== 0) out.push({ id: 'R04', text: '归因没穷尽' })
  if (unknownForms.length) out.push({ id: 'R05', text: 'B01 里出现了三种地址形态之外的引文类型' })
  if (threwIds.length) out.push({ id: 'R06', text: `有 ${threwIds.length} 条出现无 code 的 THROW，「入口在不在」量不到` })
  /**
   * R08（本波新增）：Y（真缺口）> 0 ⇒ **必须**非 0 退出，并点名是哪几条、哪种形态。
   * 在这之前这一段只会按 Y 分叉印两种结论（见下文打印），却没收进 problems。
   */
  if (byVerdict.entryGap.length) {
    const named = byVerdict.entryGap.map((id) => {
      const r = rows.find((x) => x.id === id)
      if (r === undefined) return id
      const codes = [...new Set(Object.values(r.experiment).filter((v) => v !== null).map((v) => (v.ok ? 'OK' : v.code)))]
      return `${id}[形态=${r.form}；三个变体报码 ${codes.join(',')}]`
    })
    out.push({ id: 'R08', text: `Y（真缺口）= ${byVerdict.entryGap.length}：${named.join(' ')} —— 引擎连这些形态都没认出来，退出码不能再是 0` })
  }
  return out
}

// ── ④ 载体自证：把某一种形态的入口从**合成引擎副本**里砍掉，看本探针自己会不会红 ──────

/** `write-path.mjs` 的相对 import 闭包（合成副本只拷这几个；漏拷会让动态 import 直接报错 ⇒ 判红）。 */
function engineClosure(entryName) {
  const seen = new Set()
  const queue = [entryName]
  const escaping = new Set()
  const bare = new Set()
  while (queue.length) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    const src = fs.readFileSync(path.join(LOCATOR_DIR, rel), 'utf8')
    for (const m of src.matchAll(/from\s*'([^']+)'|import\s*'([^']+)'/g)) {
      const spec = m[1] ?? m[2]
      if (/[\s,]/.test(spec)) continue // 多说明符字符串里的 `", "` 之类，不是模块名
      if (spec.startsWith('./')) {
        const next = spec.slice(2)
        if (!seen.has(next)) queue.push(next)
      } else if (spec.startsWith('../')) escaping.add(spec)
      else bare.add(spec) // node: 内建与裸包名：副本不拷，交给 Node 自己解析
    }
  }
  return { files: [...seen], escaping: [...escaping], bare: [...bare] }
}

/**
 * 合成一棵引擎副本：`rootDir/<label>/` 下逐字拷入闭包，再把 `write-path.mjs` 里
 * `cutForm` 那一种形态的转发行**整行删掉**。`cutForm === null` ⇒ 逐字拷贝（control）。
 * 变异结果逐项记账：`landed` / `missing`（片段不在）/ `ambiguous`（片段不唯一）——
 * 后两种都不允许静默当成「砍掉了」，否则自证会变成空放。
 */
function syntheticEngine(rootDir, label, cutForm) {
  const dir = path.join(rootDir, label)
  fs.mkdirSync(dir, { recursive: true })
  const closure = engineClosure(ENGINE_ENTRY)
  for (const rel of closure.files) fs.copyFileSync(path.join(LOCATOR_DIR, rel), path.join(dir, rel))
  const entry = path.join(dir, ENGINE_ENTRY)
  const before = fs.readFileSync(entry, 'utf8')
  const info = {
    label, cutForm, dir, entry,
    files: closure.files.length, escaping: closure.escaping, bare: closure.bare,
    digestSource: sha256File(path.join(LOCATOR_DIR, ENGINE_ENTRY)),
    digestCopy: sha256Text(before),
    marker: null, mutation: 'verbatim', line: null, removed: null,
  }
  if (cutForm === null) return info
  const marker = DISPATCH_SNIPPETS[cutForm]
  info.marker = marker
  const lines = before.split('\n')
  const hits = lines.map((l, i) => (l.includes(marker) ? i : -1)).filter((i) => i >= 0)
  if (hits.length === 0) { info.mutation = 'missing'; return info }
  if (hits.length > 1) { info.mutation = `ambiguous×${hits.length}`; info.line = hits.map((i) => i + 1); return info }
  info.line = hits[0] + 1
  info.removed = lines[hits[0]].trim()
  lines.splice(hits[0], 1)
  const after = lines.join('\n')
  fs.writeFileSync(entry, after, 'utf8')
  info.mutation = after.includes(marker) ? 'stuck' : 'landed'
  info.digestMutated = sha256Text(after)
  return info
}

/**
 * 载体自证（**正常运行时也跑**，且计入退出码）：
 * control（逐字拷贝）+ 三种形态各砍一次，每次都用同一把 `census` / `baseProblems` 重跑这批 B01。
 * 每条记下：变异落没落实 / 动态 import 成不成 / Y 几条 / 退出规则表红不红 / 点名的形态。
 * 断言（R11/R12/R13 在 `proofProblems` 里）：
 *   · control 必须与现树读数**逐格一致**，且在「合成副本量得到的那几条规则」上与现树红成同一批
 *     （现树自己就因为语料/引擎对账而红时，control 跟着红是对的；它多红出别的才算副本装置的毛病）；
 *   · 每一个 cut 都必须因 **R08** 变红，且点名的形态里含被砍的那一种。
 */
async function judgementPowerProof(specs, rootDir, realRows, real, realProblems) {
  const labels = [['control-verbatim', null], ...Object.keys(DISPATCH_SNIPPETS).map((f) => [`cut-${f}`, f])]
  const variants = []
  for (const [label, cutForm] of labels) {
    const eng = syntheticEngine(rootDir, label, cutForm)
    const rec = {
      ...eng, imported: false, error: null,
      yCount: null, yIds: [], yForms: [], verdicts: null, codeTally: null,
      problems: [], redIds: [], redOk: false, sameAsReal: false, why: '',
    }
    try {
      const mod = await import(pathToFileURL(eng.entry).href)
      if (typeof mod.planHunks !== 'function') throw new Error('合成副本没有导出 planHunks')
      rec.imported = true
      const rows = census(specs, mod.planHunks)
      const t = tally(rows)
      rec.yCount = t.byVerdict.entryGap.length
      rec.yIds = t.byVerdict.entryGap
      rec.yForms = [...new Set(t.byVerdict.entryGap.map((id) => rows.find((r) => r.id === id)?.form).filter(Boolean))]
      rec.verdicts = { ...t.byVerdict }
      rec.codeTally = t.codeTally
      // 合成副本只重跑 ③ 三个变体（① 的 B01 判定与语料对账固定用现树读数），故 scope='variants'
      rec.problems = baseProblems({
        scope: 'variants', rows,
        unclassified: t.unclassified, unknownForms: t.unknownForms, threwIds: t.threwIds,
        byVerdict: t.byVerdict,
      })
      rec.redIds = rec.problems.map((p) => p.id)
      rec.sameAsReal = JSON.stringify(rec.verdicts) === JSON.stringify(real.byVerdict)
      rec.redOk = cutForm !== null && rec.redIds.includes('R08') && rec.yCount > 0 && rec.yForms.includes(cutForm)
      rec.why = rec.problems.length === 0 ? '没红' : rec.problems.map((p) => `${p.id}: ${p.text}`).join(' ｜ ')
    } catch (error) {
      rec.error = String(error?.stack ?? error?.message ?? error)
      rec.why = `量不到：${rec.error.split('\n')[0]}`
    }
    variants.push(rec)
  }
  const control = variants.find((v) => v.cutForm === null)
  const cuts = variants.filter((v) => v.cutForm !== null)
  return {
    variants, control, cuts,
    closure: engineClosure(ENGINE_ENTRY),
    realVerdicts: real.byVerdict, realRowCount: realRows.length,
    /** 现树那趟红出来的批数（全量，只给 JSON / 打印看）。 */
    realProblemIds: realProblems.map((p) => p.id),
    /** R11 拿它与 control 对账：只算合成副本量得到的那几条（`scope: 'both'`），不吃 scope 差的红。 */
    realProblemIdsBoth: realProblems.map((p) => p.id).filter((id) => BOTH_SCOPE_IDS.has(id)),
  }
}

/** R11 / R12 / R13：自证装置自己的三条规矩（真跑与自证共用的退出码一分子）。 */
function proofProblems(proof) {
  const out = []
  const c = proof.control
  const realIds = [...proof.realProblemIdsBoth].sort()
  const controlIds = c === undefined ? [] : [...c.redIds].sort()
  /**
   * control 的规矩（三样都要）：① 跑得起来；② 与现树读数逐格一致；
   * ③ 它红出来的那几条与现树**同一批，不多不少**。
   * 第③条是这样写的：现树自己就是红的（例如拿一棵外面已被砍过的引擎跑本探针）时，
   * control 忠于现树、跟着红——那正是「副本装置不引入额外噪音」的证据；
   * 只有当 control 红出**现树没有的那几条**时，才算副本装置自己的毛病。
   * 参与对账的只有 `scope: 'both'` 那几条：R01/R02/R07 只有真跑量得到，不该算在 control 头上。
   */
  const sameRed = JSON.stringify(controlIds) === JSON.stringify(realIds)
  const controlOk = c !== undefined && c.imported && c.sameAsReal && sameRed
  if (!controlOk) {
    out.push({
      id: 'R11',
      text: `自证 control（逐字拷贝、一个字节不改）本应与现树逐格一致、且红的批数与现树相同，实得：${c === undefined ? '没跑起来' : `import=${c.imported} 与现树一致=${c.sameAsReal ? 'yes' : 'NO'} 红的批数 [${c.redIds.join(',') || '无'}] vs 现树 [${realIds.join(',') || '无'}]｜${c.why}`}`,
    })
  }
  const notLanded = proof.cuts.filter((v) => v.mutation !== 'landed')
  if (notLanded.length) {
    out.push({ id: 'R13', text: `自证变异没落到副本里：${notLanded.map((v) => `${v.label}=${v.mutation}`).join(' ')}` })
  }
  const notRed = proof.cuts.filter((v) => !v.redOk)
  if (notRed.length) {
    out.push({
      id: 'R12',
      text: `合成缺口副本没有判红/没点名形态：${notRed.map((v) => `${v.label}（Y=${v.yCount}，点名形态 ${v.yForms.join('/') || '无'}，红 ${v.redIds.join(',') || '无'}）`).join('；')}`,
    })
  }
  return out
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--json', '--show'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/address-form-census.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const show = Number((argv.find((a) => a.startsWith('--show=')) ?? '--show=0').slice(7)) || 0

  const digestsBefore = Object.fromEntries(ENGINE_MODULES.map((m) => [m, sha256File(path.join(REPO, 'src/locator-lab', m))]))
  const corpusBytes = fs.readFileSync(CORPUS_PATH)
  const corpusDigest = crypto.createHash('sha256').update(corpusBytes).digest('hex').slice(0, 12)
  const corpus = JSON.parse(corpusBytes.toString('utf8'))
  const engine = probeEngineOldContract()

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-c34-address-'))
  /** 载体自证的合成引擎副本根（每次运行现建现删；与重放副本同住一个临时区）。 */
  const synthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-c35-synth-'))
  const facts = []
  const staged = new Map()
  try {
    // C51：`forEach` 换成 `for … of` + await —— 新契约列走的是**真写路径**（异步）。
    // `forEach` 不接 promise：漏掉这个 await，B01 会在半数条目还没跑完时就被挑出来。
    for (const [index, entry] of corpus.entries.entries()) {
      if (!entry.replayable || !entry.source) continue
      const { copyPath, content } = stageCopy(entry, tmpDir, index)
      // 可写副本与只读副本分开：编排层在成功那一步会真的写盘，而下面的三个变体实验
      // 用的必须还是**没被动过**的那份原文（`copyPath` / `content`）。
      const toolPath = stageToolCopy(entry, tmpDir, 'tool')
      const res = await replayNew(entry, content, copyPath, entry.quote?.text ?? null, engine.ready, toolPath)
      staged.set(entry.id, { copyPath, content })
      facts.push({ id: entry.id, ...evidenceOf(entry, content, res) })
    }
  } finally {
    // 读数已全部在内存里（content/copyPath 都还用得着实验），临时目录在本函数尾部删。
  }

  // ── ① 按同一把阶梯推出 B01，并与手抄编号对账 ──
  const buckets = {}
  for (const f of facts) buckets[f.outcome] = (buckets[f.outcome] ?? 0) + 1
  const fails = facts.filter((f) => f.outcome === OUTCOME.fail)
  const b01 = fails.filter((f) => f.class === 'not_text_quote')
  const bucketMismatch = Object.entries(EXPECTED_BUCKETS).filter(([k, v]) => (buckets[k] ?? 0) !== v)
  const idsNow = b01.map((f) => f.id)
  const idSetEqual =
    idsNow.length === EXPECTED_B01_IDS.length && idsNow.every((id) => EXPECTED_B01_IDS.includes(id))

  // ── ②③ 逐条取证（原料）+ 直接实验（判定） ──
  /**
   * 每条 B01 的**实验原料**。真跑与载体自证共用同一份 `specs` —— 自证要量的正是同一条判据，
   * 换一份原料就变成了在量别的东西。原料与判定分开：原料只量一次，判定可以被多棵引擎重跑。
   */
  const specs = b01.map((f) => {
    const entry = corpus.entries.find((e) => e.id === f.id)
    const { copyPath, content } = staged.get(f.id)
    const focusIndex = entry.focus ?? 0
    const focusHunk = entry.hunks?.[focusIndex] ?? null
    const form = f.quoteKind
    const addressText = entry.quote?.text ?? ''
    const today = readTodayText(entry.file)

    const literal = occurrenceSpans(content, addressText)
    const wholeLine = wholeLineSpans(content, addressText)
    const run = longestExactRowRun(content, addressText)
    return {
      f, entry, copyPath, content, focusIndex, focusHunk, form, addressText, today,
      row: {
        id: f.id,
        klass: entry.klass,
        file: entry.file,
        source: `${f.sourceKind}/${f.fidelity}`,
        sourceChars: f.sourceChars,
        hunkCount: (entry.hunks ?? []).length,
        focusIndex,
        focusKeys: Object.keys(focusHunk ?? {}),
        form,
        quoteKind: f.quoteKind,
        quoteEqualsFocusForm: focusHunk !== null && focusHunk[form] === addressText,
        addressChars: addressText.length,
        addressRows: addressText.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '').split('\n').length,
        addressPreview: clip(addressText.replace(/\r?\n/g, '\u23ce'), 140),
        inSource: { literal, wholeLine, run, norm: occurrenceSpans(normaliseContent(content), addressText.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')) },
        rangeOfFocus: lineRangeOf(focusHunk ?? {}),
        todayExists: f.todayExists,
        todayHasAddress: today === null ? null : today.includes(addressText),
        oldFormAttempts: f.attempts,
        oldFormCode: f.code,
      },
    }
  })

  /**
   * 归因（互斥且穷尽，见文件头；实现见 `attribute()`，真跑与自证共用）：
   *   X = 三个变体**任一成功** —— 入口在且走通了。
   *   W = 全都失败，且失败码全是 `LOCATOR_NO_LANGUAGE` —— 进了 target 层，
   *       但这个文件类型没有可识别的符号语言（`.md`），按设计拒绝。
   *   Y = 全都失败，且失败码全是**分派码** —— 引擎连形态都没认出来。
   *   Z = 其余（层内码：找不到 / 不唯一 / 相似度不够）。
   */
  const rows = census(specs, planHunks)
  const real = tally(rows)
  const { byVerdict, unclassified, codeTally, threwIds, unknownForms, xByTier } = real

const digestsAfter = Object.fromEntries(ENGINE_MODULES.map((m) => [m, sha256File(path.join(REPO, 'src/locator-lab', m))]))
  const digestDrift = ENGINE_MODULES.filter((m) => digestsBefore[m] !== digestsAfter[m])
  /**
   * 退出码 = 真跑那批规则（R01…R08，`scope: 'full'`）+ 载体自证那批（R11/R12/R13，见下）。
   * R08 是本波补的那个口子：`Y > 0` 以前只影响打印，不影响退出码。
   */
  const realProblems = baseProblems({ scope: 'full', idSetEqual, bucketMismatch, rows, unclassified, unknownForms, threwIds, digestDrift, byVerdict })

  // ── 打印 ──
  console.log('')
  console.log(`=== C34 旧地址形态在新契约下的口径（B01 × ${rows.length} 逐条归因） ===`)
  console.log(`  语料 ${path.relative(REPO, CORPUS_PATH)} ｜ sha256:12=${corpusDigest} ｜ builtAt=${corpus.builtAt}`)
  console.log(`  条目 ${corpus.entries.length} ｜ 可重放 ${facts.length} ｜ 新契约分桶 ok ${buckets.ok ?? 0} / fail ${fails.length} / 需选择 ${buckets.needs_choice ?? 0} / 已落地 ${buckets.already_applied ?? 0} / 无从表达 ${buckets.unrepresentable ?? 0} / 无入口 ${buckets.na ?? 0}`)
  console.log(`  引擎（现树） ${ENGINE_MODULES.map((m) => `${m}=${digestsBefore[m]}`).join('  ')}`)
  /** 分派码在本趟出现过几次 —— 0 次就是「入口齐备」这句话的原始凭据。 */
  const dispatchSeen = Object.entries(codeTally).filter(([c]) => DISPATCH_CODES.has(c))
  console.log('  ── ① B01 是怎么被挑出来的（同一把阶梯，逐字照抄） ──')
  console.log(`     fail ${fails.length} 条里，\`quote.kind !== 'expect'\` 的：${b01.length} 条`)
  console.log(`     手抄期望：${EXPECTED_B01_TOTAL} 条 ｜ 编号逐字一致：${idSetEqual ? '✓' : '✗'}`)
  console.log(`     期望编号：${listIds(EXPECTED_B01_IDS)}`)
  console.log(`     实得编号：${listIds(idsNow)}`)
  console.log(`     分桶对账 vs 手抄 ${JSON.stringify(EXPECTED_BUCKETS)}：${bucketMismatch.length === 0 ? '逐格一致 ✓' : `不一致 ✗ ${bucketMismatch.map(([k, v]) => `${k} 期望 ${v} 实得 ${buckets[k] ?? 0}`).join('；')}`}`)
  console.log('')

  for (const [i, r] of rows.entries()) {
    console.log(`  ── [${String(i + 1).padStart(2, '0')}/${rows.length}] ${r.id}  klass=${r.klass}  源=${r.source}（${r.sourceChars} 字符）`)
    console.log(`     文件=${r.file}`)
    console.log(`     原始调用：${r.hunkCount} 个 hunk，焦点 hunk#${r.focusIndex}（0-based） 键=[${r.focusKeys.join(', ')}]`)
    console.log(`     地址形态=${r.form} ｜ 地址文本 ${r.addressChars} 字符 / ${r.addressRows} 行 ｜ 与焦点 hunk 的 ${r.form} 逐字相同：${r.quoteEqualsFocusForm ? 'yes' : 'NO'}`)
    console.log(`       原文：${r.addressPreview}`)
    if (r.rangeOfFocus !== undefined) console.log(`     焦点 hunk 同时带坐标 ${JSON.stringify(r.rangeOfFocus)}（引擎优先级 target > lines > lineCue > anchor ⇒ 原调用实际按坐标走）`)
    console.log(`     ② 重放原文里有没有它：literalSpans=${JSON.stringify(r.inSource.literal)} 整行=${JSON.stringify(r.inSource.wholeLine)} 归一化=${JSON.stringify(r.inSource.norm)} 最长逐字连续 ${r.inSource.run.len}/${r.inSource.run.rows} 行`)
    console.log(`        今天的磁盘上：文件${r.todayExists ? '在' : '不在'} ｜ 今天还有这段地址文本：${r.todayHasAddress === null ? '(不可判)' : r.todayHasAddress ? 'yes' : 'no'}`)
    for (const a of r.oldFormAttempts) console.log(`     ② 重放器改造后 try[${a.address}] ${a.code} cands=${a.candidates} msg=${flat(a.message, 160)}`)
    for (const [name, v] of Object.entries(r.experiment)) {
      if (v === null) {
        console.log(`     ③ 变体 ${name}：跳过（焦点 hunk 没有那种形态 / 没有焦点 hunk）`)
        continue
      }
      const what = name === 'A' ? '焦点 hunk 逐字' : name === 'B' ? `只留形态 {${r.form}, replace}` : '整组 hunks 逐字'
      console.log(
        v.ok
          ? `     ③ 变体 ${name}（${what}）：OK tier=${JSON.stringify(v.tiers)} 落点=${v.hits.map((h) => `hunk#${h.hunk}→L${h.line}`).join(' ')}${v.extras.length ? ` 附加字段=[${v.extras.join(', ')}]` : ''}`
          : `     ③ 变体 ${name}（${what}）：FAIL ${v.code} cands=${v.candidates ?? 0} msg=${v.message}`,
      )
      if (v.ok) {
        for (const [k, text] of v.landed.entries()) console.log(`         落点原文：${text}`)
        /**
         * 「命中」的含金量依层而不同，分开说，不把三种层混成一句：
         *   · `symbol` / `lines` 两层的落点是**算出来**的，本就不拿地址文本核对；
         *   · `anchor` / `lineCue` 两层要拿文本比：逐字相同才算“同址”，否则只是**近似落点**
         *     （引擎的容错阈值内命中，可能与调用方想改的那一处不是同一块）。
         */
        const layer = v.tiers.join('+')
        const note = /symbol/.test(layer)
          ? '按符号层命中（落点由符号表算，引擎不拿地址文本核对）'
          : /lines/.test(layer)
            ? '按坐标层命中（落点由坐标直接决定，引擎不拿地址文本核对）'
            : r.landing && r.landing.exact
              ? '落点与地址文本逐字相同（空白折叠后）—— 同址'
              : '⚠ 近似落点：在容错阈值内命中，但与地址文本不逐字相同 ⇒ 是不是调用方想改的那一处，本探针量不出来'
        console.log(`         ${note}`)
      }
    }
    if (r.cFailHint >= 0) {
      console.log(`     ③ 整组变体 C 失败点提示：hunk#${r.cFailHint}（逐个单独喂的读数）：${r.cPerHunk[r.cFailHint].ok ? 'OK' : `${r.cPerHunk[r.cFailHint].code} ${flat(r.cPerHunk[r.cFailHint].message, 130)}`}`)
    }
    console.log(`     ⇒ 归因：${VERDICT[r.verdict]}`)
    console.log('')
  }

  console.log('=== 失败码总账（三个变体的每一次尝试） ===')
  for (const [code, n] of Object.entries(codeTally).sort((a, b) => b[1] - a[1])) {
    const kind = DISPATCH_CODES.has(code) ? '分派码（引擎连形态都没认出来）' : INAPPLICABLE_CODES.has(code) ? '层内码（进了 target 层，该文件类型没有符号语言）' : code === 'OK' ? '成功' : '层内码（进了那一层，地址解不开）'
    console.log(`  ${pad(code, 30)} ${pad(n, 3)}  ${kind}`)
  }
  console.log(`  ⇒ 分派码出现次数：${dispatchSeen.length === 0 ? `0 ✓（${rows.length}/${rows.length} 都进了对应的地址层 ⇒ 三种形态都有入口）` : `✗ ${dispatchSeen.map(([c, n]) => `${c}×${n}`).join(' ')}`}`)
  console.log('')
  console.log(`=== 归因合计（互斥且穷尽，X + Y + Z + W = ${rows.length}） ===`)
  console.log(`  ${pad('X 语料伪影（原形态能命中）', 46)} ${pad(byVerdict.artifact.length, 3)}  ${listIds(byVerdict.artifact)}`)
  console.log(`  ${pad('Y 真缺口（引擎连形态都没认出来）', 46)} ${pad(byVerdict.entryGap.length, 3)}  ${listIds(byVerdict.entryGap)}`)
  console.log(`  ${pad('Z 入口在、地址在重放原文里找不到/不唯一', 46)} ${pad(byVerdict.payload.length, 3)}  ${listIds(byVerdict.payload)}`)
  console.log(`  ${pad('W 入口在、按设计拒绝（形态不适用该文件类型）', 46)} ${pad(byVerdict.inapplicable.length, 3)}  ${listIds(byVerdict.inapplicable)}`)
  console.log(`  ${pad('合计', 46)} ${pad(rows.length, 3)}  ${rows.length === EXPECTED_B01_TOTAL ? `= B01 ${EXPECTED_B01_TOTAL} ✓` : `≠ B01 期望 ${EXPECTED_B01_TOTAL} ✗`}`)
  console.log('')
  console.log(`  ⇒ **${rows.length} 条里 X（语料伪影）= ${byVerdict.artifact.length}、Y（真缺口）= ${byVerdict.entryGap.length}**`)
  console.log(`     另 ${byVerdict.payload.length + byVerdict.inapplicable.length} 条（Z ${byVerdict.payload.length} + W ${byVerdict.inapplicable.length}）原形态同样失败，但**不是缺入口**：`)
  console.log('     引擎已经进了那一层，失败的是「这段地址与重放原文对不上」/「这个文件类型没有符号语言」——夹具与语料账。')
  console.log('')
  console.log(`  X 的 ${byVerdict.artifact.length} 条分别靠哪一层成功（含金量不一样，分开报）：`)
  for (const [layer, n] of Object.entries(xByTier).sort((a, b) => b[1] - a[1])) {
    const ids = rows.filter((r) => r.verdict === 'artifact' && r.landing !== null && r.landing.tiers.join('+') === layer).map((r) => r.id)
    const fuzzy = ids.filter((id) => {
      const r = rows.find((x) => x.id === id)
      return !/symbol|lines/.test(layer) && !(r.landing && r.landing.exact)
    })
    console.log(`    ${pad(`tier=${layer}`, 22)} ${pad(n, 3)}  ${listIds(ids)}${fuzzy.length ? `  ⚠ 其中 ${fuzzy.length} 条是近似落点：${listIds(fuzzy)}` : ''}`)
  }
  console.log('    （`symbol` / `lines` 两层不拿地址文本核对落点；`anchor` / `lineCue` 两层靠容错阈值，')
  console.log('     近似落点只能说「引擎进了那一层并给了一个落点」，**不说落点就是调用方想改的那一处**。）')
  if (byVerdict.entryGap.length === 0) {
    console.log('  ⇒ Y = 0：新契约在 anchor / line_cue / target 三种形态上**入口齐备**')
    console.log('     （write-path.mjs:1646 的地址白名单 + 1660-1669 把三者转发给 locate() 的 1/3/4 层），')
    console.log(`     ${rows.length}/${rows.length} 条的失败码都是**层内码**，没有一个是分派码。`)
    console.log('  ⇒ 因此 B01 的机制注释「这几类的失败说明的是『旧地址形态无从表达』」是**反的**：')
    console.log('     入口在，缺的是「拿原参数重放」这个动作。该修的是 residual-census 的归因，不是引擎。')
  } else {
    console.log(`  ⇒ Y = ${byVerdict.entryGap.length}：这三种形态上仍有入口缺口（该补 write-path.mjs 的地址分派层），见上逐条读数。`)
    console.log('  ⇒ 点名（R08 会把这几条收进 problems ⇒ 非 0 退出）：')
    for (const p of realProblems.filter((x) => x.id === 'R08')) console.log(`     ✗ ${p.id}：${p.text}`)
  }
  console.log('')

  // ── ④ 载体自证：把某一种形态的入口从合成副本里砍掉，看本探针自己会不会红 ──
  const proof = await judgementPowerProof(specs, synthDir, rows, real, realProblems)
  console.log('=== ④ 载体自证：这条判据真的会红吗（合成引擎副本，现跑） ===')
  console.log(`  合成副本：把 write-path.mjs 里某一种形态转发给 locate() 的**那一行整行删掉**，`)
  console.log(`  拷入临时目录（闭包 ${proof.closure.files.length} 个文件：${proof.closure.files.join(' ')}${proof.closure.escaping.length ? `；⚠ 跳出 locator-lab 的 import：${proof.closure.escaping.join(' ')}` : ''}）后动态 import。`)
  console.log(`  ${pad('副本', 44)} ${pad('变异', 10)} ${pad('Y', 3)} ${pad('对账表', 8)} 点名形态 / 结论`)
  for (const v of proof.variants) {
    const red = v.problems.map((p) => p.id).join(',') || '—'
    const sameRed = JSON.stringify([...v.redIds].sort()) === JSON.stringify([...proof.realProblemIdsBoth].sort())
    const note = v.cutForm === null
      ? (v.sameAsReal && sameRed
          ? `与现树读数逐格一致 ✓、可对比的规则上红的批数也与现树相同 [${proof.realProblemIdsBoth.join(',') || '无'}]（副本装置不引入额外红）`
          : `✗ 与现树不一致=${v.sameAsReal ? 'yes' : 'NO'} 红的批数 [${v.redIds.join(',') || '无'}] vs 现树 [${proof.realProblemIdsBoth.join(',') || '无'}]；${v.why}`)
      : v.error !== null
        ? `✗ 量不到：${v.error.split('\n')[0]}`
        : `${v.redOk ? '✓' : '✗'} Y=${v.yCount} 点名 ${listIds(v.yIds)}（形态 ${v.yForms.join('/') || '无'}）｜${v.redIds.includes('R08') ? 'R08 收进 problems' : 'R08 没收'} ⇒ 退出码 ${v.problems.length ? 1 : 0}`
    console.log(`  ${pad(v.label, 44)} ${pad(v.mutation === 'landed' ? `删 L${v.line}` : v.mutation, 10)} ${pad(v.yCount === null ? '—' : v.yCount, 3)} ${pad(red, 8)} ${note}`)
    if (v.mutation === 'landed') console.log(`  ${pad('', 44)} 删掉那一行：${v.removed}`)
    if (v.error !== null) console.log(`  ${pad('', 44)} ${v.error.split('\n').slice(0, 3).join(' ｜ ')}`)
  }
  const proofProblemsList = proofProblems(proof)
  console.log(`  ⇒ 判定力：control ${proofProblemsList.some((p) => p.id === 'R11') ? '✗' : '不误红 ✓'}；`)
  console.log(`     ${proof.cuts.filter((v) => v.redOk).length}/${proof.cuts.length} 个形态缺口副本都判红并点名了形态（R12）；变异落实 ${proof.cuts.filter((v) => v.mutation === 'landed').length}/${proof.cuts.length}（R13）`)
  console.log('')

  console.log('=== 对账 ===')
  console.log(`  引擎文件跑前/跑后摘要：${digestDrift.length === 0 ? '逐项未变 ✓' : `变了 ✗ ${digestDrift.map((m) => `${m}: ${digestsBefore[m]}→${digestsAfter[m]}`).join('；')}`}`)
  console.log(`  B01 编号 vs residual-census 手抄：${idSetEqual ? '逐字一致 ✓' : '不一致 ✗'}`)
  console.log(`  分桶 vs residual-census 手抄：${bucketMismatch.length === 0 ? '逐格一致 ✓' : '不一致 ✗'}`)
  console.log(`  归因穷尽性：${unclassified === 0 ? `${rows.length} 条全部落格 ✓` : `有 ${unclassified} 条没落格 ✗`}`)
  console.log(`  地址形态都在 {anchor, line_cue, target} 之内：${unknownForms.length === 0 ? '✓' : `✗ 出现了 ${listIds(unknownForms)}`}`)
  console.log(`  无 code 的 THROW：${threwIds.length === 0 ? '0 次 ✓（每一次尝试都拿到了引擎的码）' : `✗ ${listIds(threwIds)}`}`)

  const proofProblemsListFinal = proofProblems(proof)
  const problems = [...realProblems, ...proofProblemsListFinal]
  /**
   * 自证期间引擎又动过没有：合成副本是**拷贝**，引擎拷到一半被人改会读成「副本装置有问题」。
   * 这一条把那种情形归到正确的靶子上（引擎在跑的时候动了），而不是让它伪装成 R11/R12 的自证失败。
   * （本仓是多单并行的施工现场，「跑到一半引擎被改」是实测过的情形，不是假想。）
   */
const digestsEnd = Object.fromEntries(ENGINE_MODULES.map((m) => [m, sha256File(path.join(REPO, 'src/locator-lab', m))]))
  const driftInProof = ENGINE_MODULES.filter((m) => digestsAfter[m] !== digestsEnd[m])
  if (driftInProof.length) {
    problems.push({
      id: 'R07',
      text: `跑载体自证期间引擎文件发生变化（${driftInProof.map((m) => `${m}: ${digestsAfter[m]}→${digestsEnd[m]}`).join('；')}）⇒ 合成副本可能是拷到一半的中间态，R11/R12 的读数不作数`,
    })
  }
  const exitCode = problems.length ? 1 : 0
  console.log(`  自证期间引擎摘要：${driftInProof.length === 0 ? '逐项未变 ✓（副本是从稳定的树上拷的）' : `变了 ✗ ${driftInProof.map((m) => `${m}: ${digestsAfter[m]}→${digestsEnd[m]}`).join('；')}`}`)
  console.log(`  归因结论与退出码是否一致：Y = ${byVerdict.entryGap.length} ⇒ R08 ${byVerdict.entryGap.length ? '已在 problems 里（非 0）✓' : '无需触发 ✓'}`)
  console.log(`  载体自证计入退出码：R11/R12/R13 ${proofProblemsListFinal.length === 0 ? '全部通过 ✓' : `✗ ${proofProblemsListFinal.map((p) => p.id).join(',')}`}`)
  console.log(`  判据条数：${EXIT_RULES.length} 条（${EXIT_RULES.map((r) => r.id).join(' ')}；本波只加不减：原 7 条 → ${EXIT_RULES.length} 条）`)
  if (problems.length) {
    for (const p of problems) console.log(`✗ ${p.id}：${p.text}`)
  } else {
    console.log('✓ 全部对账通过（含 Y = 0 与载体自证）')
  }

  if (json) {
    console.log('=== JSON ===')
    console.log(JSON.stringify({
      unit: 'C34',
      corpus: { path: path.relative(REPO, CORPUS_PATH), sha256_12: corpusDigest, builtAt: corpus.builtAt, entries: corpus.entries.length, replayable: facts.length },
      engine: { digests: digestsBefore, ready: engine.ready, how: engine.how },
      buckets,
      expectedBuckets: EXPECTED_BUCKETS,
      b01: { ids: idsNow, expectedIds: EXPECTED_B01_IDS, idSetEqual },
      verdict: { x_artifact: byVerdict.artifact, y_entryGap: byVerdict.entryGap, z_payload: byVerdict.payload, w_inapplicable: byVerdict.inapplicable },
      codeTally,
      dispatchCodesSeen: dispatchSeen.map(([c, n]) => ({ code: c, n })),
      unknownForms,
      exit: {
        code: exitCode,
        rules: EXIT_RULES.map((r) => ({ id: r.id, scope: r.scope, what: r.what })),
        problems: problems.map((p) => ({ id: p.id, text: p.text })),
      },
      selfProof: {
        closure: proof.closure,
        variants: proof.variants.map((v) => ({
          label: v.label, cutForm: v.cutForm, mutation: v.mutation, line: v.line, removed: v.removed,
          marker: v.marker, imported: v.imported, sameAsReal: v.sameAsReal,
          yCount: v.yCount, yIds: v.yIds, yForms: v.yForms, redIds: v.redIds, redOk: v.redOk,
          problems: v.problems.map((p) => ({ id: p.id, text: p.text })), error: v.error,
        })),
      },
      entries: show > 0 ? rows.slice(0, show) : rows.map((r) => ({
        id: r.id, form: r.form, klass: r.klass, source: r.source,
        addressChars: r.addressChars, addressRows: r.addressRows,
        literalSpans: r.inSource.literal, wholeLineSpans: r.inSource.wholeLine,
        longestExactRowRun: r.inSource.run, todayHasAddress: r.todayHasAddress,
        oldFormCode: r.oldFormCode,
        experiment: Object.fromEntries(Object.entries(r.experiment).map(([k, v]) => [k, v === null ? null : { ok: v.ok, code: v.code, tiers: v.tiers, hits: v.hits, message: v.message }])),
        verdict: r.verdict,
      })),
    }, null, 1))
  }

  for (const dir of [tmpDir, synthDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响读数 */
    }
  }
  process.exit(exitCode)
}

main().catch((error) => {
  console.error(`✗ 探针自身出错（读数不完整）：${error?.stack ?? error}`)
  process.exit(1)
})
