/**
 * already-applied-census —— fs-contract-v2 波15 / C45 建线，波18 / C52 收口。
 *
 * ## 要回答的问题
 *
 * `failure-replay` 的「现树·新契约」列今天读：
 *   ok 143 / fail 147 / 需选择 15 / **已落地 27** / 无从表达 17 / 无入口 4。
 * 本探针把**第四态那一格**（编排层回的 `already_applied`）逐条摊开：
 *
 *   · 是哪 27 条（编号集），上游 `--json` 的 `pairs.alreadyApplied.ids` 与它逐条对账；
 *   · 每一条带**可核对的落点**（`line` + `tier`，由 `alreadyAppliedHits` 原样给出，不是只有布尔结论）；
 *   · 「一个字节都没写」这句话由**本探针自己量到的数**撑着（写盘次数 + 磁盘 sha256 前后比较），
 *     不引用上游的结论；上游那一次重放自己报的 `writes` / `diskChanged` 另记一条；
 *   · 残余那 147 条里**还有没有**能被第四态消掉的 —— 读数 `可消 X`，本期 0。
 *
 * ## 这条线曾经是红的（C52 治的就是这个）
 *
 * C45 建线时上游还没导出重放器，本探针**逐字复刻**了一份判据层重放
 * （`toContentAddress` / `neighbourContext` / `replayNew`）。C51 把上游那一列接到真实工具入口
 * （编排层 `applyEditToProvider`）之后，上游读 **147**、本地复刻仍按判据层读 **174**，
 * 于是本探针 exit 1，唯一的红是：
 *
 *     ✗ 本探针重放的残余集合 == 上游 failure-replay 的活读数  ✗ fail 期望 147 实得 174
 *
 * 那一句指不到真正的原因：**复刻走样与引擎真改过，在屏幕上长得一模一样**。
 *
 * C52 的做法与 `residual-census` / `address-form-census` 上一波同形：删掉本地复刻件，
 * 改 import 上游导出的 {@link replayNewContract}，本探针只留一层**记账**适配
 * （读路径没有 old/context 入口、没有引文可引 —— 这两件事是探针自己的账，不是引擎的判断）。
 * 结构上不再可能分叉之后，另加两条判据把这条缝钉死：
 *   · 判据③：本地算出的已落地**编号集**与上游 `pairs.alreadyApplied.ids` 逐条一致（差了就点名是哪几条）；
 *   · 判据⑧：本文件自己那份源码里**没有**复刻件声明、且确实 import 并调用了上游导出。
 *
 * ## 判断口径（只对「残余」那 147 条做三档归类；第四态那 27 条不再经过这里）
 *
 * 1. **引擎第四态（强）**：编排层 `applyEditToProvider` 在 `old` 两层都找不到、
 *    而 `replace` 已整行唯一存在时回的 `already_applied`（判据三条写在 `alreadyAppliedHits` 上）。
 *    **它由上游那一个导出给，本探针不另判一份** —— 本探针只用同一个 `alreadyAppliedHits`
 *    把它在原文里的**落点**取出来核对（`line` / `tier`），并量写盘与磁盘。
 * 2. **宽松口径（弱）**：`old` 不在，`replace` 作为**子串**出现在原文里（哪怕只是行内一截、
 *    哪怕出现多次）。它只作**不确定标注**用：宽松口径命中而引擎口径不认的，逐条写明原因。
 *    **不**把它算进任何一格的计数。
 * 3. **归一化口径（更弱）**：`replace` 逐行折叠空白后才出现（`normSpace` 那一层）。同上，只作标注。
 *
 * 空 `replace` 与缺失 `replace` 一律不进第四态：删除类编辑的“结果已经在文件里”不可判
 * （空串到处都是），如实记进「其他」。
 *
 * ## 读什么、不写什么
 *
 * 只读：`src/locator-lab/failure-corpus.json`（语料）、`failure-replay.mjs` 的导出
 * （`probeEngineOldContract`：引擎就绪闸门；`replayNewContract`：那一列的实现本身）、
 * 以及一次**只读子进程** `failure-replay.mjs --json`（拿现场读数与已落地编号集做对账）。
 * 落盘只在 `%TEMP%` 下的临时目录里（跑完即删），仓内一个字节都不动。
 *
 * ## 对账（判红就退出 1，不是只打印）
 *
 *   · 本探针自己重放的**分桶**必须与上游 `columns.treeNew` 逐格一致（六格：ok / fail /
 *     需选择 / 已落地 / 无从表达 / 无入口）；
 *   · 已落地的**编号集**必须与上游 `pairs.alreadyApplied.ids` 逐条一致（判据③，差异点名）；
 *   · 残余三格计数之和必须等于残余条数（分类互斥且穷尽）；
 *   · `可消 X` 必须为 0：残余里不许有一条是引擎自己会判 `already_applied` 的；
 *   · 第四态的每一条都必须在真写路径上**实测**一遍：结果态 = `already_applied`、
 *     写盘 0 次、磁盘 sha256 不变、第二次再打仍然幂等；且上游那一次重放的 `writes` = 0。
 *
 * ## 内嵌期望值：pin（手抄快照）+ live（现场向上游要）
 *
 * 手抄的期望值会随引擎 / 语料演进而过期，而过期的期望值会让本探针**常态红** ——
 * 那种红不是读数出了问题，是常量旧了。规矩（与 `residual-census` 同一套）：
 *
 *   1. 现场向上游 `failure-replay.mjs --json` 取**活读数**（`columns.treeNew` 六格 +
 *      `pairs.alreadyApplied.ids`），它才是本次对账的参照；
 *   2. {@link PINNED} 只作**带日期的快照**（来源、抄写日期、更新规矩写在它上面），
 *      用来发现「上游自己变了」；
 *   3. pin 与活读数不符 ⇒ 打 `⚠ 内嵌 pin 已过期`，并给出**可原样粘贴的替换文本**
 *      （**不判红**：此时本探针的读数与活读数逐格一致，读数本身可信，旧的只是那个常量）；
 *   4. 取不到活读数（`--no-upstream` / 子进程起不来 / `--json` 里那两段没了）⇒ 退回以 pin 为
 *      参照，这时 pin 不符**判红** —— 没有活参照时，陈旧常量就是唯一参照，不能装作没看见。
 *
 * 跑法：`node aura-tools/probes/already-applied-census.mjs`（exit 0）
 *       `node aura-tools/probes/already-applied-census.mjs --json`（附机器可读统计）
 *       `node aura-tools/probes/already-applied-census.mjs --no-upstream`（不起上游子进程）
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pkgPath } from '../build/pkg-root.mjs'
import { normSpace } from '../src/locator-lab/anchor-core.mjs'
import { alreadyAppliedHits, applyEditToProvider } from '../src/locator-lab/write-path.mjs'
// `replayNewContract` = 上游「现树·新契约」列**那一处实现**（走编排层 `applyEditToProvider`）。
// 本探针不再复刻它（C52）：复刻件只要与上游差半点，第四态那一格就会分叉，
// 而屏幕上只会报一句「fail 期望 147 实得 174」—— 复刻走样与引擎真改过长得一模一样。
import { probeEngineOldContract, replayNewContract } from '../src/locator-lab/failure-replay.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF_PATH = fileURLToPath(import.meta.url)
const REPO = path.resolve(HERE, '../..')
const CORPUS_PATH = pkgPath('src', 'locator-lab', 'failure-corpus.json')
const FAILURE_REPLAY = pkgPath('src', 'locator-lab', 'failure-replay.mjs')
const ENGINE_MODULES = ['write-path.mjs', 'locator-api.mjs', 'read-core.mjs', 'anchor-core.mjs', 'args.mjs']


// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--json', '--no-upstream'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/already-applied-census.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const useUpstream = !argv.includes('--no-upstream')

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const clip12 = (hex) => hex.slice(0, 12)

/** 六格分桶的取值域（与上游 `columns.treeNew` 的键名一一对应，上游用驼峰、这里用下划线）。 */
const OUTCOME = {
  ok: 'ok',
  fail: 'fail',
  needsChoice: 'needs_choice',
  /**
   * 编排层的第四态（C49）：`old` 两层都找不到、而 `replace` 已整行唯一存在 ⇒
   * 「你要的结果已经是文件现在的样子，这次不用改」，**一个字节都不写**。
   * 它**不是** fail —— 从前计在残余里的那 27 条已经从残余里出去了，所以这一格自己占一行。
   */
  alreadyApplied: 'already_applied',
  unrepresentable: 'unrepresentable',
  na: 'na',
}
/** 六个格子（顺序固定：打印与对账都按它走）。 */
const COLUMN_KEYS = ['ok', 'fail', 'needs_choice', 'already_applied', 'unrepresentable', 'na']
const COLUMN_LABEL = { ok: 'ok', fail: 'fail', needs_choice: '需选择', already_applied: '已落地', unrepresentable: '无从表达', na: '无入口' }
const columnLine = (c) => COLUMN_KEYS.map((k) => `${COLUMN_LABEL[k]} ${c[k] ?? 0}`).join(' / ')
const columnSum = (c) => COLUMN_KEYS.reduce((n, k) => n + (c[k] ?? 0), 0)
/** 上游 `columns.treeNew`（驼峰）→ 本探针的分桶键（下划线）。只映射，不重判。 */
const upstreamCounts = (t) => ({
  ok: t.ok ?? 0,
  fail: t.fail ?? 0,
  needs_choice: t.needsChoice ?? 0,
  already_applied: t.alreadyApplied ?? 0,
  unrepresentable: t.unrepresentable ?? 0,
  na: t.na ?? 0,
})

/**
 * PINNED —— 手抄自 `failure-replay.mjs --json` 的**带日期快照**（不是从它那里算出来的）。
 *
 * 它现在**不是**判绿的参照：参照是现场向上游要的活读数（`columns.treeNew`）。取不到活读数时
 * 才退回以它为准 —— 那时它不符**判红**（没有活参照，陈旧常量就是唯一参照）。
 *
 * ## 什么时候必须更新（写在这里，免得下一次又靠人记）
 *
 *   · 只要 `failure-replay.mjs` 那一列的分桶变了 —— 引擎、语料、那一列的接线，任一改动；
 *   · 更新时机：**只有**在上游 `node aura-tools/src/locator-lab/failure-replay.mjs` 自己
 *     exit 0 之后，再读它的 `--json`，把 `columns.treeNew` 六格**原样**抄过来（只改数字，
 *     不碰判据），并把 `at:` 改成今天日期；
 *   · 不符时本探针会直接把**可粘贴的替换文本**印在屏幕上（见 §打印），照它换掉即可。
 */
const PINNED = {
  at: '2026-10-15',
  source: 'node aura-tools/src/locator-lab/failure-replay.mjs --json → columns.treeNew / pairs.alreadyApplied.ids',
  treeNew: { ok: 143, fail: 147, needs_choice: 15, already_applied: 27, unrepresentable: 17, na: 4 },
  /** 第四态那一格的逐条展开（C52 抄；上游 `--json` 的 `pairs.alreadyApplied.ids` 原样）。 */
  landedIds: [
    'F0020', 'F0026', 'F0027', 'F0040', 'F0085', 'F0088', 'F0098', 'F0112', 'F0116',
    'F0120', 'F0123', 'F0173', 'F0186', 'F0193', 'F0194', 'F0195', 'F0205', 'F0243',
    'F0265', 'F0266', 'F0287', 'F0297', 'F0306', 'F0314', 'F0320', 'F0408', 'F0410',
  ],
}

// ── 1. 现场读数（只读子进程） ─────────────────────────────────────────────────
/**
 * 取 `from` 之后的**第一个完整 JSON 对象**（按括号配对，跳过字符串里的括号与转义）。
 * 上游那段 JSON 后面还跟着汇总行，这里只截到配对的那个 `}`。
 */
function jsonObjectAfter(text, from) {
  const start = text.indexOf('{', from)
  if (start < 0) throw new Error('上游 --json 段里没有 `{`')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error('上游 --json 段里的对象没有收尾（被截断了？）')
}

/**
 * 上游 `failure-replay.mjs --json`：本探针的分桶必须与它逐格对得上，
 * 已落地编号集必须与它的 `pairs.alreadyApplied.ids` 逐条对得上。
 */
function liveUpstream() {
  if (!useUpstream) return { ok: false, why: '--no-upstream：本次不起子进程，不做活读数对账' }
  try {
    const out = execFileSync(process.execPath, [FAILURE_REPLAY, '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      timeout: 900000,
    })
    const marker = out.lastIndexOf('=== JSON ===')
    if (marker < 0) return { ok: false, why: '上游 --json 里没有 `=== JSON ===` 段（形状变了）' }
    // JSON 一段**后面还有**汇总行（`N/M 判据通过`），所以只能按括号配对取那一个对象，
    // 不能把 `slice(marker)` 整段喂给 `JSON.parse` —— 那样永远报 “after JSON at position …”。
    const json = JSON.parse(jsonObjectAfter(out, marker + '=== JSON ==='.length))
    const c = json?.columns
    if (c?.treeNew === undefined || c?.treeOld === undefined) return { ok: false, why: '上游 --json 里没有 columns.treeNew / columns.treeOld' }
    // `pairs.alreadyApplied` 是判据③（同一份实现）的对照物：编号集缺了就是形状变了，如实记 null。
    const landed = json?.pairs?.alreadyApplied ?? null
    return {
      ok: true,
      treeNew: c.treeNew,
      treeOld: c.treeOld,
      replayable: c.replayable,
      landed: landed === null
        ? null
        : {
            count: landed.count ?? null,
            ids: Array.isArray(landed.ids) ? landed.ids : null,
            wroteOrChangedDisk: Array.isArray(landed.wroteOrChangedDisk) ? landed.wroteOrChangedDisk : null,
          },
      how: 'node src/locator-lab/failure-replay.mjs --json（只读）',
    }
  } catch (error) {
    return { ok: false, why: `上游子进程失败：${String(error?.message ?? error).slice(0, 200)}` }
  }
}

// ── 2. 记账适配层：重放本身走**上游那一个导出**（C52 起不再复刻） ───────────────
/**
 * 与 `failure-replay.stageCopy` 同一件事：只读地把重放原文摊到临时目录的副本上。
 * 「写 + 读回」这一步是有意的：引擎入口拿到的是**副本路径**，读回来的字节才是引擎
 * 真正看到的字节（BOM / 行尾的差别都在这一步定形）。
 */
function stageCopy(entry, tmpDir, index) {
  const ext = path.extname(entry.file) || '.txt'
  const copyPath = path.join(tmpDir, `${entry.id}_${index}${ext}`)
  fs.writeFileSync(copyPath, entry.source.text, 'utf8')
  return { copyPath, content: fs.readFileSync(copyPath, 'utf8') }
}

/**
 * 与 `failure-replay.stageToolCopy` 同一件事：新契约列踩的那份**可写**副本。
 * 必须与上面那份分开 —— 编排层在成功那一步会真的写盘，而上面那份还要用来核对落点。
 */
function stageToolCopy(entry, tmpDir, label) {
  const ext = path.extname(entry.file) || '.txt'
  const toolPath = path.join(tmpDir, `${entry.id}.${label}${ext}`)
  fs.writeFileSync(toolPath, entry.source.text, 'utf8')
  return toolPath
}

/**
 * 一条条目在本探针里的归属：**与上游同一个函数**（`replayNewContract`）。
 *
 * 本函数只补两种**本探针的记账**（读路径没有 old/context 入口、没有引文可引）；
 * 重放本身、以及第四态（`already_applied`）的判定，都归上游那一个导出 ——
 * 于是「本探针的第四态集合」与「上游那一格的集合」在结构上不可能分叉。
 */
async function replayNew(entry, content, old, ready, toolPath) {
  const idle = { attempts: [], writes: 0, diskChanged: false }
  if (!ready) return { outcome: OUTCOME.unrepresentable, code: 'NOT_READY', detail: 'engine not ready', ...idle }
  if (entry.tool === 'aura_read') return { outcome: OUTCOME.na, code: 'READ_PATH', detail: '读路径没有 old/context 入口', ...idle }
  if (!old) return { outcome: OUTCOME.unrepresentable, code: 'NO_QUOTE', detail: '该条目没有可引用的原文', ...idle }
  return replayNewContract({ entry, content, old, toolPath })
}

/** 逐行折叠空白后拼回来（`normSpace` 那一层：换行不能被折成空格，否则没有行了）。 */
function normSpaceAll(text) {
  return text.split(/\r?\n/).map((l) => normSpace(l)).join('\n')
}

/** 一条条目要在真写路径上跑一次所需要的 provider（全部在临时目录里，仓内不动）。 */
function makeProvider(file) {
  const state = { writes: 0, version: 1 }
  return {
    state,
    provider: {
      stat: async (target) => (fs.existsSync(target) ? { version: `v${state.version}`, type: 'file', size: fs.statSync(target).size } : undefined),
      readText: async (target) => fs.readFileSync(target, 'utf8'),
      readByteRange: async (target, range) => fs.readFileSync(target).subarray(range.offset, range.offset + range.length),
      writeText: async (target, content, expected) => {
        if (expected?.kind === 'replaceIfVersion' && `v${state.version}` !== expected.version) {
          throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
        }
        state.writes += 1
        fs.writeFileSync(target, content)
        state.version += 1
        return { version: `v${state.version}`, operation: 'update', after: content }
      },
    },
  }
}

// ── 3. 主流程 ────────────────────────────────────────────────────────────────
const corpusBytes = fs.readFileSync(CORPUS_PATH)
const corpus = JSON.parse(corpusBytes.toString('utf8'))
const corpusDigest = clip12(sha256(corpusBytes))
const engineDigests = Object.fromEntries(
  ENGINE_MODULES.map((m) => [m, clip12(sha256File(pkgPath('src', 'locator-lab', m)))]),
)
const engine = probeEngineOldContract()
const upstream = liveUpstream()
const liveNew = upstream.ok ? upstreamCounts(upstream.treeNew) : null
/** 本次对账的参照：活读数优先；取不到才退回 pin（那时 pin 不符判红，见文件头）。 */
const reference = liveNew === null
  ? { from: 'pin', at: PINNED.at, values: PINNED.treeNew, how: `活读数取不到（${upstream.why}），退回 pin：${PINNED.at}` }
  : { from: 'live', at: '现场', values: liveNew, how: upstream.how }

say('=== C45 已落地普查（第四态 already_applied 逐条摊开）===')
say(`  语料 aura-tools/src/locator-lab/failure-corpus.json ｜ sha256:12=${corpusDigest} ｜ builtAt=${corpus.builtAt} ｜ schema=${corpus.schema}`)
say(`  引擎（现树） ${ENGINE_MODULES.map((m) => `${m}=${engineDigests[m]}`).join('  ')}`)
say(`  引擎就绪：${engine.ready ? '就绪' : '未就绪'}（${engine.how}）`)
say(`  上游活读数：${liveNew === null ? `未取（${upstream.why}）` : `node src/locator-lab/failure-replay.mjs --json（只读）⇒ ${columnLine(liveNew)}`}`)
say(
  `  上游已落地编号集（pairs.alreadyApplied.ids）：${
    !upstream.ok ? '未取' : upstream.landed?.ids ? `${upstream.landed.ids.length} 条` : '**--json 里没有这一段（形状变了）**'
  }`,
)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-c45-census-'))
const replayable = corpus.entries.filter((e) => e.replayable && e.source)
const tally = { ok: 0, fail: 0, needs_choice: 0, already_applied: 0, unrepresentable: 0, na: 0 }
const residual = []
const landed = []
for (const [index, entry] of replayable.entries()) {
  const { content } = stageCopy(entry, tmp, index)
  const toolPath = stageToolCopy(entry, tmp, 'tool')
  const old = entry.quote?.text ?? null
  const res = await replayNew(entry, content, old, engine.ready, toolPath)
  tally[res.outcome] = (tally[res.outcome] ?? 0) + 1
  const focusHunk = entry.hunks?.[entry.focus ?? 0] ?? null
  const replace = typeof focusHunk?.replace === 'string' ? focusHunk.replace : null
  const item = {
    entry,
    content,
    old,
    replace,
    focusHunk,
    code: res.code ?? null,
    detail: res.detail ?? null,
    address: res.address ?? null,
    attempts: res.attempts ?? [],
    /** 上游那一次重放自己报的两条凭据（写盘次数 / 磁盘是否变过）。 */
    upstreamWrites: res.writes ?? 0,
    upstreamDiskChanged: res.diskChanged === true,
  }
  if (res.outcome === OUTCOME.fail) residual.push(item)
  else if (res.outcome === OUTCOME.alreadyApplied) landed.push(item)
}

// ── 4. 逐条归类 ──────────────────────────────────────────────────────────────
/**
 * 一条条目在本探针眼里的现场：第四态的**落点**（`alreadyAppliedHits`，与引擎同一把尺子）、
 * 宽松口径与归一化口径的命中情况（只作标注）。判定本体不在这里 —— 它是上游给的。
 */
function rowOf(item) {
  const { entry, content, old, replace } = item
  const hasReplace = typeof replace === 'string' && replace.trim().length > 0
  const hasOld = typeof old === 'string' && old.length > 0
  const strict = hasReplace && hasOld ? alreadyAppliedHits(content, [{ old, replace }]) : null
  const loose = hasReplace ? content.includes(replace) : false
  const normalized = hasReplace && !loose ? normSpaceAll(content).includes(normSpaceAll(replace)) : false
  return {
    id: entry.id,
    klass: entry.klass,
    quoteKind: entry.quote?.kind ?? null,
    source: `${entry.source.kind}/${entry.source.fidelity}`,
    truncated: entry.source.truncated === true,
    hunks: entry.hunks?.length ?? 0,
    hasReplace,
    replaceRows: hasReplace ? replace.replace(/\r\n/g, '\n').split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === '')).length : 0,
    replaceChars: hasReplace ? replace.length : 0,
    code: item.code,
    address: item.address,
    strict: strict !== null,
    strictLine: strict?.[0]?.line ?? null,
    strictTier: strict?.[0]?.tier ?? null,
    loose,
    normalized,
    oldInSource: hasOld && content.includes(old),
  }
}

const landedRows = landed.map(rowOf)
const residualRows = residual.map(rowOf)
const buckets = { trulyAbsent: [], looseOnly: [], other: [], residualApplied: [] }
for (const row of residualRows) {
  const item = residual.find((r) => r.entry.id === row.id)
  if (row.strict) buckets.residualApplied.push(row)
  else if (!row.hasReplace) buckets.other.push({ ...row, why: item.replace === null ? 'hunk 没有 `replace`' : '`replace` 为空（删除类编辑，“结果已在”不可判）' })
  else if (row.oldInSource) buckets.other.push({ ...row, why: '`old` 其实在原文里（这一条不属于“引文不在”那一族）' })
  else if (row.loose || row.normalized) buckets.looseOnly.push({ ...row, why: row.loose ? '宽松口径命中（子串）但引擎口径不认' : '只在空白折叠后才出现（归一化口径）' })
  else buckets.trulyAbsent.push(row)
}

// ── 5. 引擎口径实测：第四态逐条走一次真写路径 ─────────────────────────────────
let appliedOk = 0
let zeroWrites = 0
let diskSame = 0
let idempotent = 0
const appliedEvidence = []
for (const item of landed) {
  const file = path.join(tmp, `run-${item.entry.id}${path.extname(item.entry.file) || '.txt'}`)
  fs.writeFileSync(file, item.content, 'utf8')
  const before = sha256File(file)
  const { provider, state } = makeProvider(file)
  const hunks = [{ old: item.old, replace: item.replace }]
  let out = null
  let error = null
  try {
    out = await applyEditToProvider(provider, { displayPath: file, hunks })
  } catch (thrown) {
    error = thrown
  }
  const firstWrites = state.writes
  const { provider: provider2, state: state2 } = makeProvider(file)
  let out2 = null
  try {
    out2 = await applyEditToProvider(provider2, { displayPath: file, hunks })
  } catch {
    out2 = null
  }
  const ok = error === null && out?.outcome === OUTCOME.alreadyApplied
  if (ok) appliedOk += 1
  if (firstWrites === 0 && state2.writes === 0) zeroWrites += 1
  if (sha256File(file) === before) diskSame += 1
  if (out2?.outcome === OUTCOME.alreadyApplied) idempotent += 1
  appliedEvidence.push({
    id: item.entry.id,
    line: out?.already_applied?.[0]?.line ?? null,
    tier: out?.already_applied?.[0]?.tier ?? null,
    outcome: out?.outcome ?? null,
    code: error?.code ?? null,
    writes: firstWrites + state2.writes,
    upstreamWrites: item.upstreamWrites,
    upstreamAddress: item.attempts.find((a) => a.outcome === OUTCOME.alreadyApplied)?.address ?? null,
  })
}
fs.rmSync(tmp, { recursive: true, force: true })

// ── 6. 打印 ──────────────────────────────────────────────────────────────────
const residualSum = buckets.trulyAbsent.length + buckets.looseOnly.length + buckets.other.length + buckets.residualApplied.length
say('')
say(`  可重放 ${replayable.length} 条（漂移 ${corpus.entries.length - replayable.length} 条不计入）｜ 现树·新契约分桶 ${columnLine(tally)}`)
say('')
say(`  ── ① 已落地（编排层第四态 already_applied，从残余里出去的那一批）：${landedRows.length} 条 ──`)
for (const r of landedRows) {
  const flags = [r.replaceRows > 1 ? `${r.replaceRows} 行 replace` : '单行 replace', r.truncated ? '原文被截断' : null, r.source.startsWith('disk') ? '源=今日磁盘' : null, r.hunks > 1 ? `${r.hunks} 个 hunk` : null].filter(Boolean).join('；')
  say(`     ${r.id}  ${r.klass}  ${r.quoteKind}  源=${r.source}  落点 line ${r.strictLine}  [${r.strictTier}]  replace ${r.replaceChars} 字符（${flags}）`)
}
say(`     编号集：${landedRows.map((r) => r.id).join(' ')}`)
say('')
say(`  ── ② 真找不到（\`old\` 不在、\`replace\` 也不在）：${buckets.trulyAbsent.length} 条 ──`)
say(`     编号集：${buckets.trulyAbsent.map((r) => r.id).join(' ')}`)
say('')
say(`  ── ③ 其他：${buckets.other.length} 条 ──`)
for (const r of buckets.other) say(`     ${r.id}  ${r.why}`)
if (buckets.looseOnly.length > 0) {
  say('')
  say(`  ── 宽松口径命中而引擎口径不认（**不计入**任何一格，只作不确定标注）：${buckets.looseOnly.length} 条 ──`)
  for (const r of buckets.looseOnly) {
    say(`     ${r.id}  ${r.why}  replace ${r.replaceChars} 字符/${r.replaceRows} 行  ｜ 归一化口径：${r.normalized ? '在' : '不在'}`)
  }
}
if (buckets.residualApplied.length > 0) {
  say('')
  say(`  ── ⚠ 残余里仍有能被第四态消掉的（可消 X ≠ 0）：${buckets.residualApplied.length} 条 ──`)
  for (const r of buckets.residualApplied) say(`     ${r.id}  落点 line ${r.strictLine}  [${r.strictTier}]  —— 上游那一列却把它记成了 fail，两边不是同一份实现`)
}
say('')
say(`  ── 不确定标注（① 那 ${landedRows.length} 条里逐项计数）──`)
say(`     replace 多行的：${landedRows.filter((r) => r.replaceRows > 1).length} 条（多行 replace 的“已经在原文里”只保证整块对上，不保证落在同一处）`)
say(`     重放原文被语料截断的：${landedRows.filter((r) => r.truncated).length} 条（截断只影响“能不能再核对一次”，不影响判定本体）`)
say(`     重放原文取自**今日磁盘**（不是当时那份原文）的：${landedRows.filter((r) => r.source.startsWith('disk')).length} 条`)
say(`     多 hunk 调用（focus hunk 的 replace 不是整次编辑的全部）：${landedRows.filter((r) => r.hunks > 1).length} 条`)
say('')
say('  ── 引擎口径实测（① 逐条走真写路径 applyEditToProvider，副本在临时目录）──')
say(`     结果态 = already_applied：${appliedOk}/${landedRows.length}`)
say(`     两次调用写盘 0 次：${zeroWrites}/${landedRows.length} ｜ 磁盘 sha256 不变：${diskSame}/${landedRows.length} ｜ 第二次再打仍 already_applied（幂等）：${idempotent}/${landedRows.length}`)
say(`     上游那一次重放自报的写盘次数：${landed.filter((it) => it.upstreamWrites === 0).length}/${landed.length} 条为 0 ｜ 磁盘未变：${landed.filter((it) => !it.upstreamDiskChanged).length}/${landed.length} 条`)
say(`     可消 X：残余 ${residual.length} 条里能被第四态消掉的 ${buckets.residualApplied.length} 条`)
say(`     （逐条落点见 --json 的 landed / engineRun）`)

// ── 7. 判据（只增不减；任一条不成立 ⇒ exit 1） ────────────────────────────────
say('')
say('=== 对账 ===')
say(`  参照 = ${reference.from === 'live' ? '上游活读数' : '内嵌 pin'}（${reference.how}）`)
const refMismatch = COLUMN_KEYS.filter((k) => (tally[k] ?? 0) !== (reference.values[k] ?? 0))
check(
  refMismatch.length === 0,
  `本探针重放的分桶 == ${reference.from === 'live' ? '上游 failure-replay 的活读数' : `内嵌 pin（${PINNED.at}）`}（${columnLine(reference.values)}）`,
  refMismatch.length === 0 ? '逐格一致 ✓' : `✗ ${refMismatch.map((k) => `${COLUMN_LABEL[k]} 期望 ${reference.values[k] ?? 0} 实得 ${tally[k] ?? 0}`).join('；')}`,
)
check(residualSum === residual.length, `残余三格之和 ${residualSum} = 残余 ${residual.length}（分类互斥且穷尽）`, residualSum === residual.length ? '✓' : `✗ ${residualSum} ≠ ${residual.length}`)

/**
 * 判据③（C52 加）：**同一份实现的逐条版本**。
 *
 * 判据①只比六个计数：复刻件与上游分叉时它会红，但只红成一个数（「已落地 27 → 0」）。
 * 真正的病是**集合**换了人 —— 所以这里拿上游 `pairs.alreadyApplied.ids` 逐条对：
 * 少一条、多一条都点名到编号。上游 `--json` 里没有这一段（形状变了）同样判红，
 * 不能因为「拿不到对照物」就悄悄少一条判据。
 */
const landedIdsMine = landedRows.map((r) => r.id)
/**
 * 对照物：活读数优先；取不到活读数（`--no-upstream` / 子进程起不来）就退回 pin 的那份编号集
 * —— 参照没了不等于判据没了：那时 pin 不符**判红**（与判据①同一套 fallback 规矩）。
 */
const landedIdsRef = upstream.ok ? 'live' : 'pin'
const landedIdsTheirs = upstream.ok ? upstream.landed?.ids ?? null : PINNED.landedIds
const landedIdsLabel = landedIdsRef === 'live' ? '上游 pairs.alreadyApplied.ids' : `内嵌 pin 的编号集（${PINNED.at}）`
if (landedIdsTheirs === null) {
  // 只剩「上游子进程跑绿了、但 --json 里没有这一段」这一种：形状变了 ⇒ 判红，不许悄悄少一条判据。
  check(false, `本探针算出的已落地编号集 == ${landedIdsLabel}（逐条点名）`, '✗ 上游 --json 里没有 pairs.alreadyApplied.ids（形状变了）—— 逐条对账做不了')
} else {
  const mineSet = new Set(landedIdsMine)
  const theirsSet = new Set(landedIdsTheirs)
  const missing = landedIdsTheirs.filter((id) => !mineSet.has(id))
  const extra = landedIdsMine.filter((id) => !theirsSet.has(id))
  const brief = (ids) => `${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ` …（共 ${ids.length}）` : ''}`
  check(
    missing.length === 0 && extra.length === 0,
    `本探针算出的已落地编号集 == ${landedIdsLabel}（逐条点名）`,
    missing.length === 0 && extra.length === 0
      ? `${landedIdsTheirs.length} 条逐条一致 ✓`
      : `✗ 上游有、本探针缺 ${missing.length} 条${missing.length ? `：${brief(missing)}` : ''}；本探针有、上游无 ${extra.length} 条${extra.length ? `：${brief(extra)}` : ''} ⇒ 两边跑的不是同一份实现`,
  )
}
check(
  buckets.residualApplied.length === 0,
  `可消 X = 0：残余 ${residual.length} 条里没有一条会被第四态 already_applied 消掉`,
  buckets.residualApplied.length === 0 ? '✓' : `✗ ${buckets.residualApplied.length} 条仍可消：${buckets.residualApplied.map((r) => r.id).slice(0, 8).join(' ')}`,
)
check(
  landed.length > 0 && landed.every((it) => it.upstreamWrites === 0 && !it.upstreamDiskChanged),
  '第四态的原始凭据（上游那一次重放）：已落地逐条写盘 0 次、磁盘 sha256 未变',
  `${landed.filter((it) => it.upstreamWrites === 0 && !it.upstreamDiskChanged).length}/${landed.length}`,
)
check(
  // `landedRows.length > 0` 是**防空集假绿**：下面三句在空集上恒真，而「第四态一条都没有」
  // 恰恰是复刻件回来的形状（变异实测：这一格原会印 「✓ 0 条」，判据总数却只少了两条）。
  landedRows.length > 0 && landedRows.length === appliedOk && landedRows.length === zeroWrites && landedRows.length === diskSame && landedRows.length === idempotent,
  `① 的每一条在真写路径上都实测过：already_applied ${appliedOk} ｜ 写盘 0 次 ${zeroWrites} ｜ 磁盘不变 ${diskSame} ｜ 幂等 ${idempotent}`,
  `${landedRows.length} 条`,
)
check(
  // 同样防空集假绿：空集的 `every` 恒真。
  landedRows.length > 0 && landedRows.every((r) => r.strict === true && r.strictLine !== null),
  '① 的每一条都带**可核对的落点**（line + tier），不是只有布尔结论',
  `${landedRows.filter((r) => r.strictLine !== null).length}/${landedRows.length}`,
)

/**
 * 判据⑧（C52 加）：**入口同一性的静态自检**。
 *
 * 判据③用的是读数（集合逐条对账），它只在「复刻件被真的用上」时才红。这一条管的是
 * **缝本身有没有重新长出来**：只要本文件里重新声明了复刻件（哪怕当下没被调用），
 * 或者重放不再走 import 进来的上游导出，就当场红并点名那个符号。
 *
 * 认的是**声明形态**（`function` / `const` / `let` / `var` + 名字），不是随便提到名字 ——
 * 上面的文件头注释里就写着这几个名字（说明它们为什么被删），那不该算数。
 */
/** 判据⑧ 的名单：C52 从本文件里删掉的那几个复刻件 —— 它们只要以**声明形态**回来就点名。 */
const REPLICA_NAMES = ['toContentAddress', 'neighbourContext', 'locateQuiet', 'legacyRequest']
const selfSource = fs.readFileSync(SELF_PATH, 'utf8')
const replicaDecls = [...selfSource.matchAll(new RegExp(`(?:function|const|let|var)\\s+(${REPLICA_NAMES.join('|')})\\b`, 'g'))].map((m) => m[1])
const importsUpstream = /import\s*\{[^}]*\breplayNewContract\b[^}]*\}\s*from\s*['"][^'"]*locator-lab\/failure-replay\.mjs['"]/.test(selfSource)
const callsUpstream = /return\s+replayNewContract\s*\(\s*\{/.test(selfSource)
check(
  replicaDecls.length === 0 && importsUpstream && callsUpstream,
  '入口同一性：本探针没有本地复刻件，重放确实走 import 的上游导出 replayNewContract',
  replicaDecls.length > 0
    ? `✗ 本地又出现了复刻件声明：${[...new Set(replicaDecls)].join(' / ')}（那就是 C52 删掉的那类东西：它一回来，第四态那一格就会与上游分叉）`
    : importsUpstream && callsUpstream
      ? '✓ 无复刻件声明 ｜ import 上游导出 ✓ ｜ 调用上游导出 ✓'
      : `✗ ${importsUpstream ? '' : '没有从 failure-replay.mjs import replayNewContract；'}${callsUpstream ? '' : '没有一处 `return replayNewContract({…})`（重放不再走上游导出）'}`,
)

/**
 * 判据⑨（C52 加）：**分桶穷尽** —— 六格之和必须等于可重放条数。
 *
 * 每一条可重放条目都往 `tally[res.outcome]` 记一次；引擎要是回了一个**六格之外**的态
 * （上游将来新加一态而这里没跟上），它会记进一个新键，而 `columnSum` 只数六格 ⇒ 之和变小。
 * 判据①比的是「与上游那一列逐格一致」，上游那一侧同形漏掉时它看不出来 —— 这条是它的内证。
 */
check(
  columnSum(tally) === replayable.length,
  `六格之和 ${columnSum(tally)} = 可重放 ${replayable.length}（分桶穷尽：没有条目落在六格之外）`,
  columnSum(tally) === replayable.length ? '✓' : `✗ ${columnSum(tally)} ≠ ${replayable.length}`,
)

say('')
say(`  门槛（施工单 ②）：疑似「已落地」≥ 5 条 ⇒ 实现。本次读数 ${landedRows.length} 条 ⇒ ${landedRows.length >= 5 ? '实现（write-path.mjs 的 alreadyAppliedHits + applyEditToProvider 的 already_applied 结果态，由 already-applied-test.mjs 钉住）' : '不实现，只交测量结论'}`)

// ── 8. pin 体检 + 机器可读输出 ───────────────────────────────────────────────
const pinMismatch = liveNew === null ? [] : COLUMN_KEYS.filter((k) => (liveNew[k] ?? 0) !== (PINNED.treeNew[k] ?? 0))
const pinIdMissing = liveNew === null ? [] : PINNED.landedIds.filter((id) => !landedIdsMine.includes(id))
const pinIdExtra = liveNew === null ? [] : landedIdsMine.filter((id) => !PINNED.landedIds.includes(id))
if (pinMismatch.length > 0 || pinIdMissing.length > 0 || pinIdExtra.length > 0) {
  const today = new Date().toISOString().slice(0, 10)
  /** 把编号集会成可直接粘贴的几行（每行 9 条，与 PINNED 里当前的排法一致）。 */
  const idLines = (ids) => {
    const rows = []
    for (let i = 0; i < ids.length; i += 9) rows.push(`    ${ids.slice(i, i + 9).map((id) => `'${id}',`).join(' ')}`)
    return `[\n${rows.join('\n')}\n  ]`
  }
  say('')
  say(`  ⚠ 内嵌 pin 已过期（对照的是${PINNED.at}那份快照）—— 不判红：本次对账的参照是上游活读数，读数本身可信，旧的只是这个常量。`)
  if (pinMismatch.length > 0) say(`     不符的格：${pinMismatch.map((k) => `${COLUMN_LABEL[k]} pin ${PINNED.treeNew[k] ?? 0} → 现场 ${liveNew[k] ?? 0}`).join('；')}`)
  if (pinIdMissing.length > 0 || pinIdExtra.length > 0) {
    say(`     编号集：pin ${PINNED.landedIds.length} 条 vs 现场 ${landedIdsMine.length} 条（pin 有、现场无 ${pinIdMissing.length} 条；现场有、pin 无 ${pinIdExtra.length} 条）`)
  }
  say('     更新规矩：**只有**上游 failure-replay 自己 exit 0 之后才抄；把下面这段原样换掉 PINNED：')
  say('     ┌────────────────────────────────────────────────────────────────')
  say(`       const PINNED = {`)
  say(`         at: '${today}',`)
  say(`         source: '${PINNED.source}',`)
  say(`         treeNew: { ok: ${liveNew.ok}, fail: ${liveNew.fail}, needs_choice: ${liveNew.needs_choice}, already_applied: ${liveNew.already_applied}, unrepresentable: ${liveNew.unrepresentable}, na: ${liveNew.na} },`)
  say(`         landedIds: ${idLines(landedIdsMine)},`)
  say(`       }`)
  say('     └────────────────────────────────────────────────────────────────')
}

if (asJson) {
  say('')
  say('=== JSON ===')
  say(
    JSON.stringify(
      {
        corpus: { path: 'aura-tools/src/locator-lab/failure-corpus.json', sha256_12: corpusDigest, builtAt: corpus.builtAt, entries: corpus.entries.length, replayable: replayable.length },
        engine: { ready: engine.ready, how: engine.how, modules: engineDigests },
        upstream: upstream.ok
          ? {
              how: upstream.how,
              treeNew: upstream.treeNew,
              treeOld: upstream.treeOld,
              replayable: upstream.replayable,
              landedIds: upstream.landed?.ids ?? null,
              landedCount: upstream.landed?.count ?? null,
              wroteOrChangedDisk: upstream.landed?.wroteOrChangedDisk ?? null,
            }
          : { ok: false, why: upstream.why },
        pinned: {
          at: PINNED.at,
          source: PINNED.source,
          treeNew: PINNED.treeNew,
          landedIds: PINNED.landedIds,
          /** pin 与活读数不符的格与编号（不判红，只让人看见「上游自己变了」）。 */
          drift: { treeNew: pinMismatch, idsMissingFromPin: pinIdMissing, idsExtraInPin: pinIdExtra },
        },
        reference: { from: reference.from, values: reference.values },
        tally,
        counts: {
          landed: landedRows.length,
          trulyAbsent: buckets.trulyAbsent.length,
          other: buckets.other.length,
          looseOnly: buckets.looseOnly.length,
          residualApplied: buckets.residualApplied.length,
          residualSum,
          residual: residual.length,
        },
        landed: landedRows,
        /** 旧键名（波15–17 那一版的读法）：与 `landed` 同一份数据，不另算一格。 */
        applied: landedRows,
        landedIds: landedIdsMine,
        /** 本次判据③实际用的对照物（活读数，或退回的那份 pin）与其来源。 */
        landedIdsRef,
        landedIdsUpstream: landedIdsTheirs,
        residualApplied: buckets.residualApplied,
        looseOnly: buckets.looseOnly,
        trulyAbsentIds: buckets.trulyAbsent.map((r) => r.id),
        other: buckets.other,
        engineRun: appliedEvidence,
        problems: results.filter((r) => !r.ok).map((r) => r.label),
      },
      null,
      1,
    ),
  )
}

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 判据通过 ---`)
if (failed.length > 0) process.exitCode = 1
