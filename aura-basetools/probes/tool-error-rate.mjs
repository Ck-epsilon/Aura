#!/usr/bin/env node
/**
 * tool-error-rate.mjs —— 「工具级报错率」的可复现读数（fs-contract-v2 波29）。
 *
 * ## 它回答什么问题
 *
 * fs-contract-v2 的赌注是「判定不出意图 ⇒ 回一条**正常结果**，而不是抛错」。这条边界由壳层
 * `src/aura-edit/index.js` 的 `OUTCOME_BY_CODE` 一张白名单定义：`code` 在表里 ⇒ 壳层把它转成
 * 带 `outcome` 的正常结果（`isError=false`）；不在表里 ⇒ 壳层原样抛（`isError=true`）。
 *
 * 失败语料上此前的读数只印「失败码分布」，**没有把「引擎抛错（真报错）」与「如实返回回执
 * （不是报错）」这一格单独算出来**——两者在码分布里长得一样，却是性质相反的两件事。本探针
 * 把那一格单独钉住：它是一条**回归线**，不是审计件（登记在 `build/release-check.mjs` 的
 * `SUITES` 里，理由写在那边）。
 *
 * ## 判定用的入口与规则
 *
 *   · 重放走的是 `src/locator-lab/failure-replay.mjs` 导出的 `replayNewContract` ——
 *     **同一个入口**、与「现树·新契约」那一列同一份实现。这里**没有**第二份判定层：
 *     本仓被"复刻走样"咬过多次，量具自己再造一份谓词，量到的就只是它自己。
 *   · 分类只依赖**一件事**：`code ∈ INTENT_CODES`（壳层那张表的派生导出面）⇒ 正常结果；
 *     `code ∉ INTENT_CODES` ⇒ 工具级报错。**不**在这里复刻 `candidates.length > 1` 那类细分
 *     —— 它只决定"转成哪一种结果"，不决定"转不转"。
 *
 *     **但"码"只在引擎真的抛了的时候才存在**，这一点是实测撞出来的：首版把 `replayNewContract`
 *     回传的 `code` 一律拿去查表，于是 170 条"工具级报错"里 143 条的码是 `OK`、27 条是
 *     `ALREADY_APPLIED` —— 那是重放层给"**工具正常返回**"起的标签（`ok` / `already_applied`
 *     两态都是编排层**返回**的，不是抛出来的），壳层根本看不到它们，也从不会拿它们去查表。
 *     把两个成功标签算进"工具级报错"，正好把壳层语义**反过来**写：那 170 条没有一条进过错误
 *     通道。所以分流按壳层真实的两条通道走：
 *       · 引擎抛了（`outcome === 'fail'`，`code` 就是抛出来的那个码）⇒ 查表：转正常结果还是抛；
 *       · 工具正常返回（`ok` / `already_applied`）⇒ 压根没有错误通道，恒为正常结果（`isError=false`）；
 *       · 另有 `needs_choice` 一态：它的码也是引擎**抛出来的**（带候选那条），仍在表内 ⇒ 正常结果。
 *     没有"它该不该算故障"的空隙留给猜测：两条通道的判据都在**同一个入口**的回传值里。
 *
 *   · **写进台账的是"进了错误通道的每一条"，不只是 Y**。本波实测 Y = 0（见下），只登记 Y 的话
 *     台账会是空的、判据没有对象 —— 一份"恒绿"的判据正是本仓反复治过的形状。登记整个错误通道
 *     （`fail` + `needs_choice`，共 162 条）之后：任何**新条目**、任何**新码**、以及任何一条
 *     **判定与实际相反**（台账说可判定、实测却抛了）都会当场变红，判据在任何读数下都有对象。
 *
 * ## 判据（有判定力，且 exit code 挂钩它）
 *
 * ① **覆盖**：进了错误通道的每一条都必须在下面那份手写台账里，且码逐条对得上 —— 引擎开始抛一个
 *    新码、语料多出/换掉一条抛错条目 ⇒ 当场变红并点名，强迫人做决定（"这确实该是工具级故障"
 *    还是"它其实可判定、该收进白名单"），而不是被一句"读数变了"糊过去。
 * ② **不过期**：台账每一条都还得对得上一条真实抛错（引擎改好之后台账不会变成一句旧话）。
 * ③ **判定与实际相反即红**：`code ∈ INTENT_CODES` ⇔ 台账判它"其实可判定，建议收进白名单"。
 *    这条是两处红的分水岭：把壳层白名单里的一条删掉 ⇒ 那些条目的实测通道变了、台账没变 ⇒ 红。
 * ④ **交叉自证**：同一趟里用文本正则把壳层源码里那张表**再解析一遍**，断言与导出的
 *    `INTENT_CODES` 逐字相等 —— 导出面不会偷偷漂移，三处按文本解析那张表的眼睛也不必被换掉。
 * ⑤ **桥接**：壳层源码里那条边界的形状仍在（表里 ⇒ `intentReceipt`（正常结果）／表外 ⇒ `throw`），
 *    否则"表外即抛错"这句话就只是本探针的信仰。
 * ⑥ **守恒**：Y + X + 无从表达 + 不适用 = 可重放；可重放 + 不可重放 = 语料全量。
 *    条数被谁吞掉一条也会红。
 *
 * 用法：
 *   node aura-tools/probes/tool-error-rate.mjs                  # 跑判据（读语料，打印头条读数与台账）
 *   node aura-tools/probes/tool-error-rate.mjs --emit-ledger    # 附：把未登记的抛错条目打成台账草稿行
 *
 * 支持的旗标就是这两条（`--emit-ledger` 是唯一一个；见下面 FLAGS）。**任何别的东西当场拒收**：
 * 点名那个旗标 + 列出支持集 + exit 2，且不读语料、不跑重放、不打印读数 ——
 * 从前旗标是用 `process.argv.includes('--emit-ledger')` 读的，别的一律被静默吞掉，
 * 于是一个错字换来一份看着完全正常的读数（本仓已经因此被咬过一次）。
 * 退出码：0 = 判据全绿 ｜ 1 = 有判据红 ｜ 2 = 用法错（未知旗标）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'


// 只 import 现成的导出：引擎侧的重放入口 + 壳层那张表的派生视图。本探针不重写任何一份判定。
import { replayNewContract } from '../src/locator-lab/failure-replay.mjs'
import { pkgRoot } from '../build/pkg-root.mjs'
import { INTENT_CODES } from '../src/aura-edit/index.js'

// 包根从文件位置推导（`build/pkg-root.mjs`）：目录名不参与路径计算。
// 包根从文件位置推导（`build/pkg-root.mjs`）：目录名不参与路径计算。
const REPO = pkgRoot
const SHELL_PATH = path.join(REPO, 'src/aura-edit/index.js')
const CORPUS_PATH = path.join(REPO, 'src/locator-lab/failure-corpus.json')

/** 台账允许的两个判定词：要么它确实是工具级故障，要么它其实可判定、该收进白名单。 */
const FAULT = '工具级故障'
const IN_TABLE = '其实可判定，建议收进白名单'
const JUDGEMENTS = [FAULT, IN_TABLE]

/**
 * 台账一台账一行的构造器：`L(码, 判定, 理由)`。判定词与理由仍是逐条写进去的字符串，这里只是
 * 省掉重复的字段名，让 162 条能一行一条地读下来。
 */
const L = (code, judgement, reason) => ({ code, judgement, reason })

/**
 * 台账的分组写法：`...ids('F0003 F0008', 码, 判定, 理由)` 展开成 `Map` 构造器要的 `[编号, 判定]` 对
 * （前面的 `...` 不能省：`ids()` 返回的是一串对，不摊开的话 `Map` 会把整串当成一个键）。
 * 分组只是排版 —— **每个编号仍然逐条在台账里**（判据逐条查），重复编号由判据③b 点名。
 */
const ids = (list, code, judgement, reason) =>
  list
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => [id, L(code, judgement, reason)])

/**
 * **手写台账**：进了错误通道（引擎真的抛了）的每一条，逐条写明它的归属 ——
 * "为什么它必须是工具级故障"，或者"它其实是可判定失败、应当被收进白名单"。
 *
 * 这份台账是**判据的锚**：语料/引擎一变，错误通道的构成就变；台账没覆盖到的条目一出现 ⇒ 红，
 * 判定与实际相反（比如白名单里删了一条，那些码不再被壳层转成结果）⇒ 也红。
 * 填法只有一条规矩：**按现场跑出来的读数填，不许为了让它好看去改分类规则**。
 */
const FAULT_LEDGER = new Map([
  /**
   * ── PATCH_AMBIGUOUS（15 条）——判「其实可判定，建议收进白名单」──
   *
   * 为什么它可判定：这个码意味着「你要改的这段文字在文件里有好几处都像」—— 引擎看懂了意图，
   * 只是落点不唯一。壳层把 `candidates >= 2` 转成 `needs_choice` 并把候选一并递回，调用方照
   * 候选挑一个就行。**它不需要调用方去猜任何东西**，所以它不该走错误通道。
   * （另：这 15 条在重放里落成 `needs_choice`，码就是抛出来的那个；它们仍算「正常结果」。）
   */
  ...ids(
    'F0003 F0037 F0076 F0094 F0135 F0151 F0155 F0251 F0256 F0262 F0272 F0279 F0299 F0367 F0409',
    'PATCH_AMBIGUOUS',
    IN_TABLE,
    '多处都能对上 ⇒ 回执给候选让调用方挑一个，不用猜；已在表内（needs_choice）',
  ),
  /**
   * ── PATCH_NOT_FOUND（147 条）——判「其实可判定，建议收进白名单」──
   *
   * 为什么它可判定：这是本语料里**数量最大**的一格（147/162）。它对应的事实很具体——
   * 「你给的这段引文/锚点在文件里根本没有（或坐标在文件里不存在）」。壳层把它转成
   * `not_found`（若 `replace` 已整行唯一存在则为第四态 `already_applied`），回执里带着
   * 「全文没有」这句话与恢复动作；抛错反而会把 `next` / `candidates` / `already_applied`
   * 这些结构化字段丢掉（框架只取 `error.message`）。
   *
   * 代价不对称也是判据的一部分（与壳层表头同一段理由）：漏收一个可判定码只是没改进；
   * 误吞一个工具级故障则是静默失败。本语料上这一个码没有一条是工具级故障。
   */
  ...ids(
    'F0004 F0005 F0017 F0021 F0029 F0030 F0035 F0050 F0053 F0059 F0060 F0072 F0073 F0078 F0091 F0104' +
      ' F0115 F0117 F0121 F0122 F0129 F0130 F0134 F0137 F0142 F0153 F0166 F0171 F0180 F0181 F0182 F0183 F0187 F0188 F0189' +
      ' F0192 F0196 F0204 F0209 F0211 F0213 F0214 F0217 F0219 F0222 F0224 F0225 F0226 F0229 F0233 F0238 F0239 F0240 F0245 F0246' +
      ' F0247 F0249 F0250 F0252 F0255 F0268 F0269 F0270 F0271 F0274 F0275 F0277 F0278 F0280 F0281 F0282 F0283 F0285 F0288 F0289' +
      ' F0293 F0296 F0300 F0305 F0307 F0313 F0318 F0322 F0330 F0332 F0333 F0334 F0335 F0336 F0338 F0343 F0344 F0346 F0347 F0348' +
      ' F0349 F0352 F0355 F0359 F0360 F0362 F0364 F0365 F0366 F0373 F0374 F0376 F0378 F0380 F0385 F0386 F0390 F0391 F0392 F0393' +
      ' F0394 F0395 F0397 F0398 F0399 F0401 F0402 F0403 F0404 F0405 F0411 F0415 F0416 F0417 F0418 F0419 F0420 F0421 F0423 F0430' +
      ' F0432 F0433 F0434 F0435 F0436 F0437 F0438 F0439 F0440 F0443 F0447 F0449',
    'PATCH_NOT_FOUND',
    IN_TABLE,
    '引文/锚点在全文找不到（或坐标不存在）⇒ 回执说清「全文没有」并给恢复动作；已在表内（not_found）',
  ),
])

/**
 * 把壳层那张表从**源码文本**里解析出来（与 `probes/success-regression.mjs` 同一手法、同一正则形状）。
 * 返回码列表，**保持表里的顺序** —— 与 `INTENT_CODES` 比的是逐字相等，不是集合相等。
 */
function parseShellCodes(text) {
  const block = /const OUTCOME_BY_CODE = new Map\(\[([\s\S]*?)\]\)/.exec(text)
  if (!block) throw new Error(`壳层里找不到 OUTCOME_BY_CODE：${SHELL_PATH}`)
  const codes = []
  const re = /\[\s*'([A-Z_]+)'\s*,\s*'([a-z_]+)'\s*\]/g
  let m
  while ((m = re.exec(block[1])) !== null) codes.push(m[1])
  return codes
}

/**
 * 桥接：壳层那条边界的**形状**还在不在（表外到底抛不抛，是这条读数成立的前提）。
 *
 * 只做可核的文本结构核对，不 import 壳层内部函数（`intentVerdict` 没有导出，本单也不改它的导出面）：
 *   · `const mapped = OUTCOME_BY_CODE.get(code)` + `if (mapped === undefined) return null`
 *     ⇒ 表外 ⇒ 判不出意图（null）；
 *   · `const verdict = intentVerdict(error, already)` + `if (verdict !== null) { … return intentReceipt(`
 *     + 该分支之后紧跟 `throw new PatchError(` ⇒ non-null ⇒ 正常结果回执，null ⇒ 抛。
 */
function shellBoundaryShape(text) {
  const need = [
    ['表外判不出意图', /const mapped = OUTCOME_BY_CODE\.get\(code\)/],
    ['表外返回 null', /if \(mapped === undefined\) return null/],
    ['判决调用', /const verdict = intentVerdict\(error, already\)/],
    ['非空分支', /if \(verdict !== null\) \{/],
  ]
  const missing = need.filter(([, re]) => !re.test(text)).map(([name]) => name)
  if (missing.length > 0) return { ok: false, how: `壳层形状变了，缺：${missing.join(' / ')}` }
  const head = text.indexOf('const verdict = intentVerdict(error, already)')
  const branch = text.indexOf('if (verdict !== null) {', head)
  const receipt = text.indexOf('return intentReceipt(', branch)
  const thrown = text.indexOf('throw new PatchError(', branch)
  if (branch < 0 || receipt < 0 || thrown < 0 || receipt > thrown) {
    return { ok: false, how: '非空分支里没有 `return intentReceipt(`，或它没有排在 `throw new PatchError(` 之前' }
  }
  return {
    ok: true,
    how: `表外 ⇒ null ⇒ throw（第 ${text.slice(0, thrown).split('\n').length} 行）；表里 ⇒ intentReceipt 正常结果`,
  }
}

/** 一条重放结果里"给人看的那句话"：报这个码的那次尝试的 message，截 120 字。 */
function messageOf(res) {
  const attempts = Array.isArray(res.attempts) ? res.attempts : []
  const hit = attempts.find((a) => a.code === res.code) ?? attempts[attempts.length - 1]
  const raw = String(hit?.message ?? '').trim() || String(res.detail ?? '')
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/**
 * 支持的旗标 ── **唯一一份**：解析认它，用法错误清单也印它，两边不可能各说一套。
 * 退出码口径（与其它测量件一致）：0 = 全绿 ｜ 1 = 有判据红 ｜ 2 = 用法错。
 */
const FLAGS = [{ form: '--emit-ledger', note: '附：把未登记的抛错条目打成台账草稿行' }]
const USAGE = ['用法：node aura-tools/probes/tool-error-rate.mjs', ...FLAGS.map((f) => ` [${f.form}]`)].join('')
const USAGE_EXIT = 2
/** 判据与用法错误共用同一个「不存在的旗标」样本：它必须被点名拒收。 */
const UNKNOWN_FLAG = '--no-such-flag-xyz'

/**
 * 解析 argv（**纯函数**：只回值，不打印、不退出 —— 判据直接调它自检）。
 * `--emit-ledger` 的语义与原实现逐字相同；未知旗标**不再被吞掉**。
 */
function parseArgv(argv) {
  const opts = { emitLedger: false }
  const errors = []
  for (const a of argv) {
    if (a === '--emit-ledger') opts.emitLedger = true
    else errors.push(`未知旗标：${a}`)
  }
  return { opts, errors }
}

/** 用法错 ⇒ `{ exit: 2, message }`；没错 ⇒ `null`（判据也调它）。 */
function usageFailureOf(errors) {
  if (errors.length === 0) return null
  return {
    exit: USAGE_EXIT,
    message: [...errors, '', USAGE, '支持的旗标：', ...FLAGS.map((f) => `  ${f.form.padEnd(16)}${f.note}`)].join('\n'),
  }
}
const usageFailure = (argv) => usageFailureOf(parseArgv(argv).errors)

const checks = []
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

async function main() {
  const { opts, errors } = parseArgv(process.argv.slice(2))
  const failure = usageFailureOf(errors)
  if (failure !== null) {
    // 用法错：当场退出 —— 不读壳层源码、不读语料、不跑重放、不打印任何读数。
    process.stderr.write(`${failure.message}\n`)
    process.exit(failure.exit)
  }
  const emitLedger = opts.emitLedger
  const shellText = fs.readFileSync(SHELL_PATH, 'utf8')
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'))
  const total = corpus.entries.length

  const faults = []
  /** 进了**错误通道**的条目（引擎真的抛了）：`fail` 与带候选的 `needs_choice`。台账登记的就是这一批。 */
  const thrown = []
  /** 逐态计数：两条通道各多少条（也是下面那句口径自述的算术依据）。 */
  const byOutcome = new Map()
  let asResult = 0
  let unrepresentable = 0
  let na = 0
  let drifted = 0
  let replayable = 0
  const bump = (k) => byOutcome.set(k, (byOutcome.get(k) ?? 0) + 1)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-tool-error-rate-'))
  try {
    for (const entry of corpus.entries) {
      if (!entry.replayable || !entry.source) {
        drifted += 1
        continue
      }
      replayable += 1
      // 与 `failure-replay.mjs` 的分流同序：读路径没有 old/context 入口（如实计不适用），
      // 没有引文的无处可引（无从表达），其余走**同一个**重放入口。
      if (entry.tool === 'aura_read') {
        na += 1
        continue
      }
      const old = entry.quote?.text ?? null
      if (old === null || old === '') {
        unrepresentable += 1
        continue
      }
      const ext = path.extname(entry.file) || '.txt'
      const toolPath = path.join(tmpDir, `${entry.id}.tool${ext}`)
      fs.writeFileSync(toolPath, entry.source.text, 'utf8')
      const content = fs.readFileSync(toolPath, 'utf8')
      const res = await replayNewContract({ entry, content, old, toolPath })
      const code = String(res.code ?? '')
      bump(res.outcome)
      const row = { id: entry.id, code, source: entry.source.kind, message: messageOf(res), outcome: res.outcome }
      /**
       * 壳层只有两条通道，「码」只属于其中一条（详见文件头）：
       *   · 工具**正常返回**（`ok` / `already_applied`，两态都是编排层 return 出来的）⇒ 没有错误
       *     通道可进，回传的 `code` 是重放层自己的标签（`OK` / `ALREADY_APPLIED`），**不拿去查表**；
       *   · 引擎**抛了**（`fail`；`needs_choice` 的码也是抛出来的那条）⇒ 查表决定转正常结果还是抛。
       */
      if (res.outcome === 'ok' || res.outcome === 'already_applied') {
        asResult += 1
        continue
      }
      thrown.push(row)
      // `needs_choice` 的码来自抛错（带候选那条），在表内 ⇒ 壳层同样把它转成正常结果。
      if (res.outcome === 'needs_choice' || INTENT_CODES.includes(code)) asResult += 1
      else faults.push(row)
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响判据 */
    }
  }

  // ── 头条读数（格式固定，是交付物） ──────────────────────────────────────────
  const excluded = unrepresentable + na + drifted
  const returnedOk = byOutcome.get('ok') ?? 0
  const returnedLanded = byOutcome.get('already_applied') ?? 0
  const choice = byOutcome.get('needs_choice') ?? 0
  const failed = byOutcome.get('fail') ?? 0
  console.log('')
  console.log(
    `工具级报错（isError=true）: ${faults.length} / ${replayable} ｜ 转成正常结果: ${asResult} / ${replayable} ｜ 未参与（无从表达/不适用/不可重放）: ${excluded}`,
  )
  console.log(
    `  （口径：分母 ${replayable} = 可重放条目；Y+X=${faults.length + asResult} 是编辑路径上真被判过的条目；` +
      `未参与 = 无从表达 ${unrepresentable} + 不适用 ${na} + 不可重放 ${drifted}；Y+X+Z=${faults.length + asResult + excluded} = 语料全量 ${total}）`,
  )
  console.log(
    `  （两条通道：工具**正常返回** ${returnedOk} 条 ok + ${returnedLanded} 条 already_applied —— 它们压根没进错误通道，恒 isError=false；` +
      `引擎**抛了** ${thrown.length} 条 = fail ${failed} + needs_choice ${choice}，其中码在表里 ${asResult - returnedOk - returnedLanded} 条 ⇒ 壳层转正常结果，` +
      `码在表外 ${faults.length} 条 ⇒ 工具级报错）`,
  )
  console.log(
    `  （白名单共 ${INTENT_CODES.length} 个码：${INTENT_CODES.join(', ')}）`,
  )

  // ── Y 的逐条构成：给人做决策用 ─────────────────────────────────────────────
  console.log('')
  console.log(`=== Y 的构成（工具级报错 ${faults.length} 条；每条都要能被判定"它到底该不该算工具级故障"）===`)
  if (faults.length === 0) console.log('（空：本趟没有一条 code ∉ INTENT_CODES 的抛错条目）')
  for (const f of faults) {
    const led = FAULT_LEDGER.get(f.id)
    console.log(`${f.id} ｜ ${f.code} ｜ ${f.source} ｜ ${f.message}`)
    console.log(`      台账：${led ? `${led.judgement} —— ${led.reason}` : '**未登记**'}`)
  }

  // 错误通道的码分布：与上面那一格正交，也是"表内/表外"这一刀的可核对读数。
  const dist = new Map()
  for (const t of thrown) dist.set(t.code, (dist.get(t.code) ?? 0) + 1)
  console.log('')
  console.log(
    `=== 错误通道的码分布（引擎抛了 ${thrown.length} 条）=== ` +
      (dist.size === 0
        ? '(空)'
        : [...dist.entries()]
            .sort((a, b) => b[1] - a[1])
.map(([c, n]) => `${c}=${n}${INTENT_CODES.includes(c) ? '(表内)' : '(**表外**)'}`)
            .join(' ')),
  )

  // ── 判据 ──────────────────────────────────────────────────────────────────
  console.log('')
  console.log('=== 判据 ===')
  /**
   * 用法面（本次加固）：未知旗标必须被**点名拒收**（exit 2，见文件头「用法」）。
   * 判据直接调本探针的解析器（不 spawn 子进程）：拿一个不存在的旗标问它 ——
   * 从前 `process.argv.includes('--emit-ledger')` 会静默吞掉它。
   */
  const argProbe = usageFailure([UNKNOWN_FLAG])
  check(
    argProbe !== null && argProbe.exit === USAGE_EXIT && argProbe.message.includes(UNKNOWN_FLAG) && FLAGS.every((f) => argProbe.message.includes(f.form)),
    `用法：未知旗标被点名拒收（exit ${USAGE_EXIT}，不是静默跑默认口径）`,
    argProbe === null ? `${UNKNOWN_FLAG} 被静默吞掉（会跑出一份看着正常的读数）` : `exit ${argProbe.exit}；点名 ${UNKNOWN_FLAG}；列出 ${FLAGS.length} 个支持旗标`,
  )

  const thrownIds = new Set(thrown.map((t) => t.id))
  const uncovered = thrown.filter((t) => !FAULT_LEDGER.has(t.id))
  const mismatched = thrown.filter((t) => FAULT_LEDGER.has(t.id) && FAULT_LEDGER.get(t.id).code !== t.code)
  check(
    uncovered.length === 0 && mismatched.length === 0,
    '进了错误通道的每一条都在手写台账里，且码逐条对得上（多出一条抛错 / 换了一个码 ⇒ 变红，逼人做决定）',
    uncovered.length > 0
      ? `未登记 ${uncovered.length} 条：${uncovered.slice(0, 6).map((f) => `${f.id}(${f.code})`).join(', ')}${uncovered.length > 6 ? ' …' : ''}（草稿见 --emit-ledger）`
      : mismatched.length > 0
        ? `码对不上：${mismatched.slice(0, 6).map((f) => `${f.id}: 实测 ${f.code} / 台账 ${FAULT_LEDGER.get(f.id).code}`).join(', ')}`
        : `${thrown.length} 条全部有台账`,
  )

  const stale = [...FAULT_LEDGER.keys()].filter((id) => !thrownIds.has(id))
  check(
    stale.length === 0,
    '台账没有过期条目（每一条都还对得上一条真实抛错）',
    stale.length === 0 ? `台账 ${FAULT_LEDGER.size} 条，全部命中` : `过期：${stale.slice(0, 8).join(', ')}${stale.length > 8 ? ' …' : ''}`,
  )

  // ③a 判定词与理由齐备；③b 分组写法没吞掉重复编号。
  const badRows = [...FAULT_LEDGER.entries()].filter(
    ([, v]) => !JUDGEMENTS.includes(v.judgement) || String(v.reason ?? '').trim().length < 8,
  )
  const expanded = [...FAULT_LEDGER.values()].length
  check(
    badRows.length === 0 && expanded === FAULT_LEDGER.size,
    `台账每条都写明判定（∈ ${JUDGEMENTS.join(' / ')}）与理由，且没有重复编号被分组写法吞掉`,
    badRows.length > 0
      ? `不合格：${badRows.slice(0, 6).map(([id]) => id).join(', ')}`
      : `台账 ${FAULT_LEDGER.size} 条 = 展开 ${expanded} 条；判为「${FAULT}」的 ${[...FAULT_LEDGER.values()].filter((v) => v.judgement === FAULT).length} 条`,
  )

  // ③c 判定与实际相反即红：白名单删一条 ⇒ 那些条目的实测通道变了而台账没变 ⇒ 这里点名。
  const wrongWay = [...FAULT_LEDGER.entries()].filter(
    ([, v]) => (INTENT_CODES.includes(v.code) ? v.judgement !== IN_TABLE : v.judgement !== FAULT),
  )
  const wrongSide = thrown.filter((t) => INTENT_CODES.includes(t.code) === (FAULT_LEDGER.get(t.id)?.judgement === FAULT))
  check(
    wrongWay.length === 0 && wrongSide.length === 0,
    `台账的判定与实测通道一致（码在表内 ⇔ 判"可判定"；表外 ⇔ 判"${FAULT}"）——白名单删一条必红`,
    wrongWay.length > 0
      ? `判定相反 ${wrongWay.length} 条：${wrongWay.slice(0, 6).map(([id, v]) => `${id}(${v.code}: 台账判「${v.judgement}」)`).join(', ')}`
      : wrongSide.length > 0
        ? `台账与实测对不上：${wrongSide.slice(0, 6).map((t) => `${t.id}(${t.code})`).join(', ')}`
        : `表内 ${thrown.length - faults.length} 条判「${IN_TABLE}」，表外 ${faults.length} 条判「${FAULT}」`,
  )

  const parsed = parseShellCodes(shellText)
  const same = parsed.length === INTENT_CODES.length && parsed.every((c, i) => c === INTENT_CODES[i])
  check(
    same,
    '壳层源码里那张表解析出来的码集与导出面 INTENT_CODES 逐字相等（导出面没漂移）',
    same
      ? `两边各 ${INTENT_CODES.length} 个码，顺序也一致`
      : `解析 ${parsed.length} 个 [${parsed.join(', ')}] vs 导出 ${INTENT_CODES.length} 个 [${INTENT_CODES.join(', ')}]`,
  )

  const bridge = shellBoundaryShape(shellText)
  check(bridge.ok, '壳层那条边界的形状仍在（表里 ⇒ 正常结果回执／表外 ⇒ 抛）', bridge.how)

  check(
    faults.length + asResult + unrepresentable + na === replayable && replayable + drifted === total,
    '守恒：Y + X + 无从表达 + 不适用 = 可重放；可重放 + 不可重放 = 语料全量',
    `${faults.length} + ${asResult} + ${unrepresentable} + ${na} = ${faults.length + asResult + unrepresentable + na}（可重放 ${replayable}）；${replayable} + ${drifted} = ${total}`,
  )

  if (emitLedger && uncovered.length > 0) {
    console.log('')
    console.log('=== 台账草稿（按码分组，判定与理由请人工逐条确认后再贴进 FAULT_LEDGER）===')
    const groups = new Map()
    for (const t of uncovered) {
      if (!groups.has(t.code)) groups.set(t.code, [])
      groups.get(t.code).push(t.id)
    }
    for (const [code, list] of groups) {
      const judgement = INTENT_CODES.includes(code) ? IN_TABLE : FAULT
      console.log(`  ...ids('${list.join(' ')}', '${code}', ${judgement === FAULT ? 'FAULT' : 'IN_TABLE'}, '<理由>'),  // ${code}`)
    }
  }

  const bad = checks.filter((c) => !c.ok).length
  console.log('')
  console.log(
    `${bad === 0 ? '判据通过' : '判据失败'}：${checks.length - bad} / ${checks.length} 条判据通过 ｜ 工具级报错（isError=true） ${faults.length} 条 ｜ 错误通道 ${thrown.length} 条 ｜ 台账 ${FAULT_LEDGER.size} 条 ｜ 语料 ${total} 条（可重放 ${replayable}）`,
  )
  process.exit(bad === 0 ? 0 : 1)
}

await main()
