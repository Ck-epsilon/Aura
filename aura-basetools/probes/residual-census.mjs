/**
 * residual-census.mjs —— R1：新契约下**残余 147 条失败**的机制分解（只测量，不改引擎）。
 *
 * ## 它回答什么
 *
 * `failure-replay.mjs` 的三列对跑读出「现树·新契约 143 ok / 147 fail / 15 需选择 /
 * 27 已落地 / 17 无从表达 / 4 无对应入口」。这一格把 **147 条 fail 逐条**归到一个机制类里，并给出：
 *
 * **C51 换的是尺子，不是引擎**：新契约列从前直接调判据层 `planHunks`，而真实工具走的是编排层
 * `applyEditToProvider` —— 后者在「`old` 两层都找不到、而 `replace` 已整行唯一存在」时会回第四态
 * `already_applied`（**一个字节都不写**），前者照旧抛 `PATCH_NOT_FOUND`。于是那 27 条一度只是
 * 别处普查的结论，在读数上仍记 fail。把那一列接到真入口之后，残余从 174 变 147，
 * 多出来的一格（27）单列成「已落地」——**不是把 27 条藏起来，而是给它们一个说得住的去处**。
 *
 *   · 机制分布（互斥且穷尽，见 {@link classify} 的有序阶梯）；
 *   · 按「重放原文来源」分层（log=日志快照 / receipt=回执实证 / disk=今日磁盘），
 *     以及**剔除今日磁盘来源**后的 fail 与分母；
 *   · X = 「模型给的信息足以确定意图、工具却没做到」的条数 + 逐条编号；
 *   · B01（引文取自 `target` / `anchor` / `line_cue` 的那 12 条）的 `legacy_form` 一列：
 *     按**原参数重放**给它们**另加**一个归属（见下「B01 那一格」）。
 *
 * ## X 的定义（窄到可以逐条复算）
 *
 * X 只数**严格口径**：语料里那条引文（`entry.quote.text`）
 *   ① 在**重放原文**里**逐字**存在（`content.includes(old)`，不是归一化后存在），
 *   ② 出现**恰好一次**，
 *   ③ 且出现处是**整行对齐**（不是行内片段）。
 * 三条同时成立 ⇒ 意图由字面文本唯一确定，`planHunks` 仍报找不到 ⇒ 真缺陷。
 *
 * 为什么必须窄：任务里那句「信息足以确定意图」如果放松成「片段唯一」或「归一化后唯一」，
 * 就会把「引擎该不该替调用方扩到整行」这种设计选择算进缺陷里——那是另一个问题。
 * 本探针**同时**报出两个更宽的口径（`X_broad`：片段唯一；`X_norm`：归一化后唯一）并给出
 * 它们的编号，读数摆在这里，判定留给下一刀。三个口径都算出来是**零**时，X=0 才不是「判据太紧」。
 *
 * ## 与 failure-replay 的关系（两列都走它的导出，不是复刻）
 *
 * C51 把最后一块复刻也拆了。现在两列都是**上游的同一份实现**：
 *   · 「现树·旧入参」列调它的导出 `replayOldColumn`；
 *   · 「现树·新契约」列调它的导出 `replayNewContract`（走编排层 `applyEditToProvider`）
 *     —— 这是本波新加的导出，
 *     存在的理由就是本探针这一类下游：**复刻件只要与上游差半点，`fail` 集合就会分叉，
 *     而对账只能报「逐格不一致」——复刻走样与引擎真变了，在屏幕上长得一模一样。**
 *
 * 对账照旧按**上游现场读数**（`failure-replay.mjs --json` 的 `columns.treeNew` /
 * `columns.treeOld`）**逐格**做：
 *   ok 143 / fail 147 / 需选择 15 / 已落地 27 / 无从表达 17 / 无对应入口 4 与
 *   旧列 ok 92 / fail 260 / 无从表达 1 全部对上，才认这份机制分解。
 *   对账不过 → exit 1（读数对不上时不允许输出漂亮的机制表）。
 *
 *     屏幕上的期望文本从期望对象生成（不会再出现「判据绿着、屏幕上印的却是旧数」）；
 *     期望值本身的 pin / live 规矩见下面「内嵌期望值」一节。
 *
 * ## B01 那一格：标签、注释与 `legacy_form` 一列（C39 改）
 *
 * 这一格的判据只有一行：`entry.quote.kind !== 'expect'` —— 引文取自 `target` / `anchor` /
 * `line_cue` 这三种**地址形态**，而重放器把它当成了 `old`（当字面量使）。旧注释说
 * 「这几类的失败说明的是『旧地址形态无从表达』」——**实测与它相反**：
 *
 *   · 上游 `probes/address-form-census.mjs` 把**原始 hunk 参数**（不是被改造成 `old` 的形态）
 *     喂回现树 `planHunks`，36 次尝试里**分派码出现 0 次**、全部进了对应的地址层 ⇒
 *     Y（真缺口）= 0：`target` / `anchor` / `line_cue` 三种形态在新契约里**入口齐备**；
 *   · 12 条里 5 条按原形态能命中（其中 F0017 的落点是**兄弟块**，见 `legacy_form` 的 R 一格），
 *     6 条原形态同样失败但报的是**层内码**（这段地址在重放原文里找不到 / 不唯一），
 *     1 条是 `target` 落在 `.md` 上按设计拒绝。
 *
 * ⇒ **B01 的失败不构成新契约的账**：它是「拿地址当引文」这个重放改造的产物，不是
 * 「引擎认不认这三种形态」。所以本探针在这一格上**加一列** `legacy_form`
 * （X / R / Z / W / Y，见 {@link LEGACY_FORM}）：归因**只读复用**
 * `address-form-census.mjs --json` 的 `verdict`（本探针不重写那份判定），只把它的 X
 * 按「落点是不是调用方指的那一处」再拆出 R —— 那一拆的证据与复核写在一起
 * （`landingEvidenceOf` / `legacyFormOf` / `verifyLegacyForms`）。
 * **分母不动**：这 12 条仍留在失败分母里 —— 失败条数与 `failure-replay` 主线程逐格对账，移出分母就断了那条链。
 *
 * ## 上游：两条都只在子进程里**只读消费**
 *
 *   · `address-form-census.mjs --json`：B01 的 12 条按**原参数重放**的归因（X/Y/Z/W）与它自己
 *     算出来的落点。本探针只映射、只往下拆一格，**不自己再实现一份 X/Z/W 判定**；
 *   · `failure-replay.mjs --json`：本次对账用的**活读数**（见下一节）。
 * 两条都跑在 `execFileSync` 的只读子进程里：不 import 它们的内部函数，也不写它们的任何文件。
 * 起不来 / 没有 `=== JSON ===` 段 ⇒ 明说「取不到」并判红（读数没到手就不装作对过账），
 * 而不是猜一个值 —— 例外只有 `--no-upstream`（显式跳过，屏幕上说明这一列没取）。
 *
 * ## 内嵌期望值：pin（手抄快照）+ live（现场向上游要）
 *
 * 手抄的期望值会随引擎 / 语料演进而过期，而过期的期望值会让本探针**常态红** ——
 * 那种红不是读数出了问题，是常量旧了（C29 / 波 9 各踩过一次：旧入参列这里还写着 85/267/1，
 * 主线程早就读 92/260/1，于是它自报 exit 1 而**读数其实全对**）。现在的规矩：
 *
 *   1. 现场向上游 `failure-replay.mjs --json` 取**活读数**（`columns.treeNew` / `columns.treeOld`），
 *     它才是本次对账的参照；
 *   2. `PINNED` 那两组数只作**带日期的快照**（来源与抄写日期写在它上面），用来发现「上游自己变了」；
 *   3. pin 与活读数不符 ⇒ 打 `⚠ 内嵌 pin 已过期`，并给出**可原样粘贴的替换文本**与更新规矩
 *     （**不判红**：此时本探针的复刻与活读数逐格一致，读数本身可信，旧的只是那个常量）；
 *   4. 取不到活读数（`--no-upstream` / 子进程起不来）⇒ 退回以 pin 为参照，这时 pin 不符**判红**
 *     —— 没有活参照时，陈旧常量就是唯一参照，不能装作没看见。
 *
 * ## 只读约束
 *
 * 写范围只有本文件与报告落点。分类只读语料与重放原文；副本一律落在 `os.tmpdir()`，
 * 语料里的路径**从不**被写。跑前跑后各算一次引擎文件摘要，变了就红并点名。
 *
 * 用法：
 *   node aura-tools/probes/residual-census.mjs            # 机制表 + 分层表 + X + legacy_form
 *   node aura-tools/probes/residual-census.mjs --json     # 附机器可读统计（含全部 fail 逐条 + 已落地逐条）
 *   node aura-tools/probes/residual-census.mjs --show=N   # 附 N 条逐条明细
 *   node aura-tools/probes/residual-census.mjs --no-assert # 只打印不对账（调试用）
 *   node aura-tools/probes/residual-census.mjs --no-upstream # 不起上游子进程（沙箱禁管道时用；
 *                                                          #  此时 legacy_form 取不到，如实说明，不猜）
 *
 * 支持的旗标就是上面这四条（`--json` / `--show=N` / `--no-assert` / `--no-upstream`，见下面 FLAGS）。
 * **任何别的东西当场拒收**：点名那个旗标 + 列出支持集 + exit 2，且不做任何工作、不打印报告 ——
 * 从前它们被 `argv.includes()` 静默吞掉，于是一个错字（例如本仓文档里出现过的 `--assert`）换来的
 * 是一份完整的机制表加 `✓ 全部对账通过`：一份没人会怀疑的假读数。
 * 退出码：0 = 全部对账通过 ｜ 1 = 有判据红 ｜ 2 = 用法错（未知旗标 / 旗标值不合形）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pkgPath } from '../build/pkg-root.mjs'
import { execFileSync } from 'node:child_process'

// 只 import 引擎现成的导出：本单不改 aura-tools/src/**
import { planHunks } from '../src/locator-lab/write-path.mjs'
import { locate } from '../src/locator-lab/locator-api.mjs'
import { readWith } from '../src/locator-lab/read-core.mjs'
import { lineRangeOf } from '../src/locator-lab/args.mjs'
import { normSpace } from '../src/locator-lab/anchor-core.mjs'
// `replayNewContract` = 「现树·新契约」列**那一处实现**（走编排层 `applyEditToProvider`）。
// 本探针不再复刻它（C51）：复刻件会与上游分叉，而屏幕上只会报一句「读数不一致」。
import { probeEngineOldContract, replayNewContract, replayOldColumn } from '../src/locator-lab/failure-replay.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const CORPUS_PATH = pkgPath('src', 'locator-lab', 'failure-corpus.json')
const ENGINE_MODULES = ['write-path.mjs', 'locator-api.mjs', 'read-core.mjs', 'anchor-core.mjs', 'args.mjs']
const RELAX_MIN_CHARS = 12

/**
 * 两条上游测量线 —— 本探针只在**只读子进程**里消费它们的 `--json`（起进程读 stdout），
 * 不 import 它们的内部函数，也不写它们任何一个文件。见文件头「上游」一节。
 */
const ADDRESS_FORM_CENSUS = path.join(HERE, 'address-form-census.mjs')
const FAILURE_REPLAY = pkgPath('src', 'locator-lab', 'failure-replay.mjs')
const UPSTREAM_TIMEOUT_MS = 20 * 60 * 1000
const UPSTREAM_MAX_BUFFER = 1 << 26 // 64 MiB：failure-replay --json 的正文不小
const JSON_MARKER = '=== JSON ==='

/**
 * B01 的 `legacy_form` 一列 —— 按**原参数重放**给这 12 条**另加**一个归属（分母不动，它们仍计在失败里）。
 *
 * X/Y/Z/W 的判定**只有一个来源**：上游 `address-form-census.mjs --json` 的 `verdict`
 * （映射见 {@link LEGACY_FROM_C34}）—— 本探针**不自己再实现一份** X/Z/W 判定。
 * 本探针只往下再拆一格 R：上游的 X 只说「引擎进了那一层并给了一个落点」，
 * **不说落点就是调用方要改的那一处**（地址层不拿原文核对落点，除非调用方给了 `expect`）。
 * 所以对 X 做一次**落点复核**，三条证据同时成立才改判 R：
 *   ① 同一个调用里，调用方自己给过坐标（`lines` / `start_line`+`end_line`）；
 *   ② 引擎的落点**不在**任何一个坐标区间内；
 *   ③ 地址里有某一整行在重放原文里**只出现一次**，且那一行**落在**某个坐标区间内。
 *   ⇒ 入口确实在，但落点落在下游的**兄弟块**上，不是调用方指的那一处。
 * R ⊆ X（复核只把 X 往下拆，不新增归因）。
 */
const LEGACY_FORM = {
  X: 'X 语料伪影（原形态能命中；落点落在调用方给的坐标里，或调用方本就没给坐标）',
  R: 'R 入口在、落点错（兄弟块：调用方给了坐标，落点不在其中，而地址里有一整行只在坐标区间内出现一次）',
  Z: 'Z 入口在、地址解不开（层内码：这段地址在重放原文里找不到 / 不唯一）',
  W: 'W 入口在、按设计拒绝（进了 target 层，但该文件类型没有可识别的符号语言）',
  Y: 'Y 真缺口（引擎连「这是哪一种地址形态」都没认出来）',
}
/** 上游 `verdict` → 本列取值。**只映射，不重判**。 */
const LEGACY_FROM_C34 = { artifact: 'X', entryGap: 'Y', payload: 'Z', inapplicable: 'W' }

const OUTCOME = {
  ok: 'ok',
  fail: 'fail',
  needsChoice: 'needs_choice',
  /**
   * 编排层的第四态（C49）：`old` 两层都找不到、而 `replace` 已整行唯一存在 ⇒
   * 「你要的结果已经是文件现在的样子，这次不用改」，**一个字节都不写**（C51 起本探针真的量到它）。
   * 它**不是** fail：那些条目从前计的 27 条 fail 已经从残余里出去了，所以这一格必须自己占一行。
   */
  alreadyApplied: 'already_applied',
  unrepresentable: 'unrepresentable',
  na: 'na',
}

/**
 * 机制类目 —— 互斥且穷尽。
 *
 * `kind` 是本单的**判定**（可消 / 不可消 / 夹具 / 按设计 / 非编辑 / 未归类），
 * `asks` 是它对应任务里四问的哪一问（`none` = 不属于那四问）。
 */
const MECHANISM = {
  na_read: { short: 'A01 读路径条目（没有 old/context 入口可走）', kind: 'not_edit', asks: 'none' },
  no_quote: { short: 'A02 条目没有可引用的原文（无从表达）', kind: 'not_edit', asks: 'none' },
  not_text_quote: {
    // 标签只说实测说得住的那件事：引文取自**地址形态** ⇒ 这一格的失败是重放改造出来的，
    // **不构成新契约的账**（Y=0，三种形态入口齐备；逐条归属见 legacy_form 一列）。
    short: 'B01 引文是地址形态（target/anchor/line_cue）⇒ 不算新契约的账',
    kind: 'legacy_address',
    asks: 'corpus',
  },
  post_edit_quote: { short: 'B02 引文是改后文本（`old` 出现在自己的 replace 里）', kind: 'unrecoverable', asks: 'corpus' },
  absent_from_source: { short: 'B03 引文逐字不在重放原文里（整块都不在）', kind: 'unrecoverable', asks: 'absent' },
  partial_row_block: {
    short: 'B04 引文只有部分相邻行在原文里（整块对不上：隔行/改动）',
    kind: 'unrecoverable',
    asks: 'absent',
  },
  stale_source: { short: 'C01 重放原文是副本、已过期（引文在今天的磁盘上）', kind: 'fixture', asks: 'corpus' },
  scaffold_gap: { short: 'C02 引文落在脚手架的空行占位上（地址在覆盖范围外）', kind: 'fixture', asks: 'corpus' },
  defect_whole_line_unique: {
    short: 'D01 引文整行对齐 + 逐字 + 全文唯一，planHunks 仍报找不到',
    kind: 'defect',
    asks: 'unique_missed',
  },
  defect_fragment_unique: {
    short: 'D02 引文是行内片段 + 逐字 + 全文唯一，planHunks 仍报找不到',
    kind: 'defect',
    asks: 'unique_missed',
  },
  defect_norm_unique: {
    short: 'D03 引文只在空白折叠后唯一，planHunks 仍报找不到',
    kind: 'defect',
    asks: 'unique_missed',
  },
  ambiguous_in_source: { short: 'E01 引文在重放原文里多处出现（该报需选择却落进 fail）', kind: 'by_design', asks: 'not_unique' },
  other: { short: 'F01 其他（未归入以上）', kind: 'other', asks: 'none' },
}

const KIND_LABEL = {
  defect: '可消（真缺陷）',
  legacy_address: '地址形态（失败是重放改造出来的，不算新契约的账）',
  unrecoverable: '不可消（引文不是原文）',
  fixture: '夹具构造（不算引擎的账）',
  by_design: '按设计拒绝（引文不唯一）',
  not_edit: '非编辑路径',
  other: '未归类',
}

/** 任务四问的回指：条目落在哪一问上。 */
const ASK_LABEL = {
  absent: '① old/引文在原文里确实不存在',
  not_unique: '② old/引文存在但不唯一',
  unique_missed: '③ old/引文存在且唯一、工具没找到（真缺陷）',
  corpus: '④ 语料/夹具本身有问题（引文取自地址形态、已过期、地址不在覆盖内）',
  none: '（不属于四问：非编辑路径 / 未归类）',
}

// ── 复刻 failure-replay.mjs 的重放机制（逐字照抄，只加统计字段） ───────────────

/**
 * 与 `failure-replay.stageCopy` 同一件事：只读地把重放原文摊到临时目录的副本上。
 * 「写 + 读回」这一步是有意的：引擎入口拿到的是**副本路径**，读回来的字节才是引擎
 * 真正看到的字节（BOM / 行尾的差别都在这一步定形）。
 */
function stageCopy(entry, tmpDir, index) {
  const ext = path.extname(entry.file) || '.txt'
  const copyPath = path.join(tmpDir, `${entry.id}_${index}${ext}`)
  fs.writeFileSync(copyPath, entry.source.text, 'utf8')
  const content = fs.readFileSync(copyPath, 'utf8')
  return { copyPath, content }
}

/**
 * 与 `failure-replay.stageToolCopy` 同一件事：新契约列踩的那份**可写**副本。
 * 它必须与上面那份只读副本分开 —— 编排层在成功那一步会真的写盘。
 */
function stageToolCopy(entry, tmpDir, label) {
  const ext = path.extname(entry.file) || '.txt'
  const toolPath = path.join(tmpDir, `${entry.id}.${label}${ext}`)
  fs.writeFileSync(toolPath, entry.source.text, 'utf8')
  return toolPath
}

/**
 * （C51 删了这里的四个复刻件：`toContentAddress` / `locateQuiet` / `legacyRequest` /
 *  `neighbourContext` —— 它们是 `failure-replay.replayNew` 的逐字副本。）
 *
 * 为什么删：上游那一列已经改成走**真实工具那条入口**（编排层 `applyEditToProvider`），
 * 而本探针原先复刻的是它在**判据层**的旧形态。两边的 `fail` 集合会当场分叉（上游 147、
 * 本地 174），而屏幕上只会说「与主线程读数不一致」—— 复刻走样与引擎真变了长得一模一样。
 * 现在两边跑的是**同一个导出** `replayNewContract`（见下面那个薄适配层），
 * 「测的层和跑的层不是同一层」这条缝在结构上不再存在，也不必再靠对账去追。
 */

/**
 * 一条条目在本探针里的归属：**与上游同一个函数**（`replayNewContract`），只把「读路径」与
 * 「没有引文」这两种**本探针的记账**补在外面。
 *
 * 为什么必须 import 而不是复刻（C51）：复刻件只要与上游差半点，`fail` 集合就不一样，
 * 而对账只报「逐格不一致」——**复刻走样和引擎真改过，屏幕上长得一模一样**。
 * 上游把重放导出之后，这里就只负责传副本路径与改写形状，不再自己拿主意。
 *
 * 外拿回每次尝试的 code/message（机制分解要看引擎到底报了什么）：上游返回的 `attempts[]`
 * 就是那个形状，本函数不再加工。
 */
async function replayNew(entry, content, copyPath, old, ready, toolPath) {
  if (!ready) return { outcome: OUTCOME.unrepresentable, code: 'NOT_READY', detail: 'engine not ready', attempts: [] }
  if (entry.tool === 'aura_read') return { outcome: OUTCOME.na, code: 'READ_PATH', detail: '读路径没有 old/context 入口', attempts: [] }
  if (!old) return { outcome: OUTCOME.unrepresentable, code: 'NO_QUOTE', detail: '该条目没有可引用的原文', attempts: [] }
  return replayNewContract({ entry, content, old, toolPath })
}

// ── 取证：在重放原文上把「引文到底在不在、唯不唯一」量出来 ─────────────────────

/**
 * 归一化：整篇按行 `normSpace` 后用 `\n` 拼起来。
 * 不能直接用 `normSpace(content)`——它会把**换行也折成空格**，折完就没有行了，
 * 「整行对齐」这个判据必须在折过空白的行结构上做。与引擎 `expectVerdict` / `fragmentSpans`
 * 里的 `hay` 是同一把尺子。
 */
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

/**
 * `old` 的**最长逐字连续行段**：old 的第 i..i+k-1 行在原文里连续出现（逐字相等）的最大 k。
 * 这是「引文有一部分是原文」的原始读数——`k < 行数` 就说明整块对不上，
 * 而 k 很大（如 22/32）说明模型引的是原文的一大段、只是局部漂了。
 */
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

function clipBlock(s, cap = 160) {
  const flat = String(s).replace(/\r?\n/g, '\u23ce')
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…(+${flat.length - cap})`
}

/** 一页取证：174 条里每一条的现场读数都在这里，分类只是对它的判定。 */
function evidenceOf(entry, content, res) {
  const old = entry.quote?.text ?? null
  const trimmed = old === null ? null : old.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')
  const hayNorm = normaliseContent(content)
  const today = readTodayText(entry.file)
  const focusHunk = entry.hunks?.[entry.focus ?? 0] ?? null
  const replaceHints = (entry.hunks ?? []).map((h) => ({
    replace: typeof h?.replace === 'string' ? h.replace : null,
    replaceTruncatedAt: h?.replaceTruncatedAt ?? null,
    keys: Object.keys(h ?? {}),
  }))
  const ev = {
    tool: entry.tool,
    file: entry.file,
    quoteKind: entry.quote?.kind ?? null,
    /** C51：这一次调用真落过盘没有（`writeText` 调用数 / 只读副本之外的摘要变化）。 */
    writes: res.writes ?? 0,
    diskChanged: res.diskChanged === true,
    sourceKind: entry.source.kind,
    fidelity: entry.source.fidelity,
    sourceChars: content.length,
    sourceLines: content.split('\n').length,
    oldChars: old === null ? null : old.length,
    oldRows: trimmed === null ? null : trimmed.split('\n').length,
    /** ① 逐字存在几处 / ② 整行对齐几处 / ③ 归一化后几处 —— 三个原始读数。 */
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
    oldPreview: old === null ? null : clipBlock(old, 120),
    focusHunk,
    replaceHints,
  }
  ev.class = classify(entry, ev)
  return ev
}

/** 有序阶梯：每条恰好落在第一个命中项上（互斥且穷尽）。 */
function classify(entry, f) {
  if (f.tool === 'aura_read') return 'na_read'
  if (f.oldChars === null) return 'no_quote'
  // 引文取自**地址形态**（`target`/`anchor`/`line_cue`）：这三个键是**地址**，不是原文。
  // 重放器把地址文本当成了 `old` ⇒ 这一格量的是「拿地址当引文会发生什么」，
  // **不是**新契约认不认这三种形态（旧注释写的「旧地址形态无从表达」与实测相反）。
  // 实测（上游 address-form-census，按**原始 hunk 参数**重放）：分派码 0 次、Y（真缺口）= 0，
  // 12 条里 5 条原形态能命中 ⇒ **B01 的失败不构成新契约的账**。
  // 按原参数重放的逐条归属见 legacyFormOf，以及屏幕上的「B01 的 legacy_form」一节。
  if (f.quoteKind !== 'expect') return 'not_text_quote'
  // 引文出现在自己的 replace 里 ⇒ 引用的是**改后**文本（只在 replace 未被语料截断时可判）。
  if (!f.replaceTruncated && f.oldInReplace === true) return 'post_edit_quote'
  if (f.literalSpans.length === 0) {
    // 逐字不在重放原文里 —— 但**今天的磁盘上**有吗？（副本过期 = 夹具的账，不是引擎的账）
    if (f.todayHasOld === true) return 'stale_source'
    // 连一段逐字连续的行都没有 ⇒ 整块都不在；有一段的 ⇒ 只是整块对不上
    const run = f.longestExactRowRun
    if (run && run.len > 0) return 'partial_row_block'
    return 'absent_from_source'
  }
  // 逐字存在 —— 分「唯一不唯一」与「整行还是片段」
  if (f.literalWholeLineSpans.length === 1) return 'defect_whole_line_unique'
  if (f.literalSpans.length === 1) return 'defect_fragment_unique'
  if (f.literalWholeLineSpans.length > 1 || f.literalSpans.length > 1) return 'ambiguous_in_source'
  if (f.normWholeLineSpans.length === 1 || f.normSpans.length === 1 || f.normSpaceSpans.length === 1) return 'defect_norm_unique'
  return 'other'
}

// ── 上游：只读消费两个探针的 --json（B01 的 legacy_form 一列 + 现场活参照） ──────

/**
 * 起一个上游探针进程，把它 stdout 里 `=== JSON ===` 之后那段取回来。
 * 非零退出也照收（失败时 stdout 仍可能是完整的读数），把退出码与原因一并带回去判红；
 * 起不来（沙箱禁管道 / 路径不对）⇒ `ok=false` + `why`，由调用方明说「取不到」，不猜。
 */
function runUpstreamJson(script, args, label) {
  const opts = { encoding: 'utf8', cwd: REPO, timeout: UPSTREAM_TIMEOUT_MS, maxBuffer: UPSTREAM_MAX_BUFFER, windowsHide: true }
  let stdout = ''
  let stderr = ''
  let exit = 0
  let how = 'exit 0'
  try {
    stdout = execFileSync(process.execPath, [script, ...args], opts)
  } catch (error) {
    stdout = String(error?.stdout ?? '')
    stderr = String(error?.stderr ?? '')
    if (Number.isInteger(error?.status)) {
      exit = error.status
      how = `exit ${exit}`
    } else {
      exit = -1
      how = `起不来/被杀（${error?.code ?? error?.signal ?? 'unknown'}）`
    }
  }
  const parsed = jsonAfterMarker(stdout, JSON_MARKER)
  const fails = upstreamComplaints(stdout)
  if (!parsed.ok) {
    const tail = stderr.trim().split('\n').slice(-1)[0] ?? ''
    return { ok: false, exit, how, fails, json: null, why: `${label}：${parsed.why}（stdout ${stdout.length} 字符${tail ? `；stderr 末行 ${clipBlock(tail, 160)}` : ''}）` }
  }
  return { ok: true, exit, how, fails, json: parsed.json, why: null }
}

/** 上游客自己印出来的 `✗` 行（它没认账的那些判据）—— 原样带回去点名，本探针不重写它们的说法。 */
function upstreamComplaints(stdout) {
  const out = []
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('✗')) continue
    const one = clipBlock(t, 200)
    if (!out.includes(one)) out.push(one)
  }
  return out.slice(0, 5)
}

/**
 * 从上游客里取 `=== JSON ===` 之后的**第一个完整 JSON 值**。
 * 不能把 marker 之后的文本直接丢给 `JSON.parse`：`failure-replay` 在 JSON 后面还会印一行
 * `N/N 判据通过`，那会让解析整段失败（而它的 JSON 本体其实完好）。
 * 所以按括号深度扫描，并跟着字符串状态走（正文里的 `}` 不能计入深度）。
 */
function jsonAfterMarker(text, marker) {
  const at = text.indexOf(marker)
  if (at < 0) return { ok: false, json: null, why: `stdout 里没有 ${marker} 段` }
  const start = text.indexOf('{', at + marker.length)
  if (start < 0) return { ok: false, json: null, why: `${marker} 之后没有 JSON 对象` }
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return { ok: true, json: JSON.parse(text.slice(start, i + 1)), why: null }
        } catch (error) {
          return { ok: false, json: null, why: `${marker} 段里的 JSON 解析失败：${String(error?.message ?? error)}` }
        }
      }
    }
  }
  return { ok: false, json: null, why: `${marker} 段里的 JSON 不完整（括号没闭合）` }
}

/** 上游 `address-form-census.mjs --json`：B01 的 12 条按**原参数重放**的归因 + 它自己算的落点。 */
function readAddressFormCensus() {
  // `--show` 给足：那一段才会连 `landing`（引擎落点）一起吐出来；给少了下游会判红而不是猜。
  const up = runUpstreamJson(ADDRESS_FORM_CENSUS, ['--json', '--show=4096'], 'address-form-census')
  const json = up.json ?? {}
  const rows = new Map((Array.isArray(json.entries) ? json.entries : []).map((r) => [r.id, r]))
  return { ...up, rows, verdict: json.verdict ?? null, ids: Array.isArray(json.b01?.ids) ? json.b01.ids : null, shape: json }
}

/** 上游 `failure-replay.mjs --json` 的**现场**读数：本次对账的活参照（见文件头「内嵌期望值」）。 */
function readFailureReplayLive() {
  const up = runUpstreamJson(FAILURE_REPLAY, ['--json'], 'failure-replay')
  const cols = up.json?.columns ?? null
  const treeNew = cols?.treeNew ?? null
  const treeOld = cols?.treeOld ?? null
  // 拿不到那两列时把原因写清楚 —— 它退回去当 pin 参照，屏幕上要能看出是为什么退的。
  const why = treeNew === null || treeOld === null
    ? (up.ok ? `${up.how}，但它的 --json 里没有 columns.treeNew / columns.treeOld（形状变了）` : up.why)
    : up.why
  return { ...up, treeNew, treeOld, why }
}

// ── B01 的 legacy_form 一列：上游给 X/Y/Z/W，本探针只把 X 再拆出 R ──────────────

/** 调用方在**同一个调用**里给过的坐标区间（走引擎自己的解析器 `lineRangeOf`）。 */
function coordRegionsOf(entry) {
  const out = []
  for (const h of entry.hunks ?? []) {
    const r = h && typeof h === 'object' ? lineRangeOf(h) : undefined
    if (r) out.push({ start: r.start, end: r.end })
  }
  return out
}

/** 去掉首尾空行后的引文行（地址文本的行结构）。 */
function trimmedRows(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '').split('\n')
}

/** 某一整行在原文里出现的**行号**（逐字相等、整行对齐）。 */
function wholeLineRowNumbers(content, row) {
  const lines = content.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i] === row) out.push(i + 1)
  return out
}

/**
 * 落点复核的**证据**（只量三样；判定在 {@link legacyFormOf} 里一行写完）：
 * landingLines 上游给的落点行 ｜ coords 调用方给的坐标区间 ｜ uniqueInside 只在坐标区间内出现一次的地址整行。
 */
function landingEvidenceOf(entry, content, c34Row) {
  const coords = coordRegionsOf(entry)
  const inside = (n) => coords.some((c) => n >= c.start && n <= c.end)
  const landingLines = (c34Row?.landing?.hits ?? []).map((h) => h.line).filter((n) => Number.isInteger(n))
  const uniqueInside = []
  trimmedRows(entry.quote?.text ?? '').forEach((row, i) => {
    if (row.trim() === '') return
    const at = wholeLineRowNumbers(content, row)
    if (at.length === 1 && inside(at[0])) uniqueInside.push({ row: i + 1, line: at[0] })
  })
  const sibling = coords.length > 0 && landingLines.length > 0 && landingLines.every((n) => !inside(n)) && uniqueInside.length > 0
  return { coords, landingLines, uniqueInside, sibling, c34Tiers: c34Row?.landing?.tiers ?? null }
}

/** 判据：上游的 X/Y/Z/W 只**映射**；X 再按证据拆出 R（这一行就是判据本身）。 */
function legacyFormOf(c34Verdict, ev) {
  const base = LEGACY_FROM_C34[c34Verdict] ?? null
  if (base === null) return null // 上游没判过这一条 —— 归不了因，判红
  if (base !== 'X') return base
  return ev.sibling ? 'R' : 'X'
}

/**
 * 复核（**第二份表达式**，与 {@link landingEvidenceOf} / {@link legacyFormOf} 分开写）：
 * 判据必须与原始读数一致 —— R **当且仅当**那三条证据同时成立；证据表里的三组读数
 * 也必须能在这里独立重算出来。改判据或改证据，都会被这一处抓到（`--no-upstream` 时跳过并说明）。
 */
function verifyLegacyForms(legacyRows) {
  const problems = []
  for (const r of legacyRows) {
    const coords = []
    for (const h of r.entry.hunks ?? []) {
      const g = h && typeof h === 'object' ? lineRangeOf(h) : undefined
      if (g) coords.push({ start: g.start, end: g.end })
    }
    const hits = (r.c34Row?.landing?.hits ?? []).map((h) => h.line).filter((n) => Number.isInteger(n))
    const uniq = []
    const src = r.content.split(/\r?\n/)
    trimmedRows(r.entry.quote?.text ?? '').forEach((row, i) => {
      if (row.trim() === '') return
      let seen = 0
      let last = -1
      for (let j = 0; j < src.length; j += 1) {
        if (src[j] === row) {
          seen += 1
          last = j + 1
        }
      }
      if (seen === 1 && coords.some((c) => last >= c.start && last <= c.end)) uniq.push({ row: i + 1, line: last })
    })
    const sibling = coords.length > 0 && hits.length > 0 && hits.every((n) => !coords.some((c) => n >= c.start && n <= c.end)) && uniq.length > 0
    const want = r.c34Verdict === 'artifact' ? (sibling ? 'R' : 'X') : r.form
    if (r.form !== want) problems.push(`${r.id} 的 legacy_form=${r.form} 与原始读数不符：按证据应当是 ${want}`)
    if (JSON.stringify(r.ev.coords) !== JSON.stringify(coords)) problems.push(`${r.id} 证据表里的坐标 ${JSON.stringify(r.ev.coords)} ≠ 复核重算的 ${JSON.stringify(coords)}`)
    if (JSON.stringify(r.ev.landingLines) !== JSON.stringify(hits)) problems.push(`${r.id} 证据表里的落点 ${JSON.stringify(r.ev.landingLines)} ≠ 复核重算的 ${JSON.stringify(hits)}`)
    if (JSON.stringify(r.ev.uniqueInside.map((u) => u.line)) !== JSON.stringify(uniq.map((u) => u.line))) problems.push(`${r.id} 证据表里「只在坐标内出现一次的地址整行」 ${JSON.stringify(r.ev.uniqueInside.map((u) => u.line))} ≠ 复核重算的 ${JSON.stringify(uniq.map((u) => u.line))}`)
  }
  return problems
}

// ── 打印工具 ──────────────────────────────────────────────────────────────

function width(s) {
  let w = 0
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return w
}
function pad(s, n) {
  const t = String(s)
  return t + ' '.repeat(Math.max(0, n - width(t)))
}
function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by
}
function sha256File(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12)
  } catch {
    return null
  }
}
const listIds = (list, cap = 200) => (list.length <= cap ? list.join(', ') : `${list.slice(0, cap).join(', ')} …共 ${list.length} 条`)

// ── 旗标 / 用法（唯一一份清单；未知旗标 ⇒ exit 2，不做任何工作） ──────────────

/**
 * 支持的旗标 —— **唯一一份**：解析认它，用法错误清单也印它，两边不可能各说一套。
 * 退出码口径（与其它测量件一致）：0 = 全绿 ｜ 1 = 有判据红 ｜ 2 = 用法错。
 */
const FLAGS = [
  { form: '--json', note: '附机器可读统计（含全部 fail 逐条 + 已落地逐条）' },
  { form: '--show=N', note: '附 N 条逐条明细（N = 非负整数）' },
  { form: '--no-assert', note: '只打印不对账（调试用）' },
  { form: '--no-upstream', note: '不起上游子进程（沙箱禁管道时用；legacy_form 一列取不到）' },
]
const USAGE = ['用法：node aura-tools/probes/residual-census.mjs', ...FLAGS.map((f) => ` [${f.form}]`)].join('')
const USAGE_EXIT = 2
/** 判据与用法错误共用同一个「不存在的旗标」样本：它必须被点名拒收。 */
const UNKNOWN_FLAG = '--no-such-flag-xyz'

/**
 * 解析 argv（**纯函数**：只回值，不打印、不退出 —— 判据直接调它自检）。
 * 四个已知旗标的语义与原实现逐字相同（含 `--show` 缺省 0）；未知旗标**不再被吞掉**。
 */
function parseArgv(argv) {
  const opts = { json: false, show: 0, assertMode: true, wantUpstream: true }
  const errors = []
  for (const a of argv) {
    if (a === '--json') opts.json = true
    else if (a === '--no-assert') opts.assertMode = false
    else if (a === '--no-upstream') opts.wantUpstream = false
    else if (a.startsWith('--show=')) {
      const n = Number(a.slice('--show='.length))
      if (Number.isInteger(n) && n >= 0) opts.show = n
      else errors.push(`--show 要非负整数：${a}`)
    } else errors.push(`未知旗标：${a}`)
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

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const { opts, errors } = parseArgv(process.argv.slice(2))
  const failure = usageFailureOf(errors)
  if (failure !== null) {
    // 用法错：当场退出 —— 不读语料、不起上游子进程、不写任何文件、不打印任何报告。
    process.stderr.write(`${failure.message}\n`)
    process.exit(failure.exit)
  }
  const { json, show, assertMode, wantUpstream } = opts

  const digestsBefore = Object.fromEntries(ENGINE_MODULES.map((m) => [m, sha256File(pkgPath('src', 'locator-lab', m))]))
  const corpusBytes = fs.readFileSync(CORPUS_PATH)

  const corpusDigest = crypto.createHash('sha256').update(corpusBytes).digest('hex').slice(0, 12)
  const corpus = JSON.parse(corpusBytes.toString('utf8'))
  const engine = probeEngineOldContract()
  // 上游只读消费（见文件头「上游」）：两条都跑在子进程里，本进程不 import 它们的内部函数。
  const c34 = wantUpstream
    ? readAddressFormCensus()
    : { ok: false, exit: -1, how: '跳过（--no-upstream）', json: null, rows: new Map(), verdict: null, ids: null, shape: null, why: '--no-upstream：没有取上游读数' }
  const liveUpstream = wantUpstream
    ? readFailureReplayLive()
    : { ok: false, exit: -1, how: '跳过（--no-upstream）', json: null, treeNew: null, treeOld: null, why: '--no-upstream：没有取上游读数' }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-r1-census-'))
  const facts = []
  const jobs = []
  const legacyRows = []
  try {
    // C51：这里从 `forEach` 改成 `for … of` —— 新契约列走的是**真写路径**（异步），
    // 而 `forEach` 不接 promise：漏掉这个 await，本探针会在一半条目还没跑完时就去对账。
    for (const [index, entry] of corpus.entries.entries()) {
      if (!entry.replayable || !entry.source) continue
      const { copyPath, content } = stageCopy(entry, tmpDir, index)
      // 可写副本与只读副本分开：编排层在成功那一步会真的写盘（旧入参列还要读那份只读的）。
      const toolPath = stageToolCopy(entry, tmpDir, 'tool')
      const res = await replayNew(entry, content, copyPath, entry.quote?.text ?? null, engine.ready, toolPath)
      jobs.push({ id: entry.id, tool: entry.tool, hunks: entry.hunks ?? [], args: entry.args ?? null, copyPath })
      const fact = {
        id: entry.id,
        klass: entry.klass,
        at: entry.at,
        drifted: false,
        ...evidenceOf(entry, content, res),
      }
      facts.push(fact)
      // B01（引文取自地址形态）逐条留一页现场：上游的归因 + 落点复核的证据。
      // `content` 只活在这一层（临时目录在 finally 里删），所以证据在这里就量完。
      // 只收 **fail** —— `classify()` 对每一条 fact 都跑，非 fail 的条目也可能落进这一格。
      if (wantUpstream && fact.outcome === OUTCOME.fail && fact.class === 'not_text_quote') {
        const c34Row = c34.rows.get(entry.id) ?? null
        const ev = landingEvidenceOf(entry, content, c34Row)
        const c34Verdict = c34Row?.verdict ?? null
        legacyRows.push({ id: entry.id, entry, content, c34Row, c34Verdict, form: legacyFormOf(c34Verdict, ev), ev, source: `${fact.sourceKind}/${fact.fidelity}` })
      }
    }
    // 「现树·旧入参」列走 failure-replay 自己的导出：同一份实现，不可能分叉。
    var oldColumn = replayOldColumn({ planHunks, readWith, locate }, jobs)
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响读数 */
    }
  }
  const digestsAfter = Object.fromEntries(ENGINE_MODULES.map((m) => [m, sha256File(pkgPath('src', 'locator-lab', m))]))


  // ── 分桶 ──
  const buckets = {}
  for (const f of facts) bump(buckets, f.outcome)
  const fails = facts.filter((f) => f.outcome === OUTCOME.fail)
  const choices = facts.filter((f) => f.outcome === OUTCOME.needsChoice)
  const unrep = facts.filter((f) => f.outcome === OUTCOME.unrepresentable)
  const nas = facts.filter((f) => f.outcome === OUTCOME.na)
  /**
   * 第四态那一批（C51）：**从残余里出去的 27 条**。它们不再是 fail，但必须看得见 ——
   * 「残余少了 27」和「这 27 条去哪里了」是两件事，只报前者就成了把条目藏起来。
   * 每一条的两个原始读数（写盘次数 / 副本摘要是否变过）一并收：
   * 「一个字节都没写」这句话得由本探针自己量到的数撑着，不能引用上游的结论。
   */
  const landed = facts.filter((f) => f.outcome === OUTCOME.alreadyApplied)
  const landedWrote = landed.filter((f) => (f.writes ?? 0) !== 0 || f.diskChanged === true)
  /** 机制分布要能回答「这 27 条从前归在哪一格」——按同一条阶梯再归一次即可。 */
  const landedByClass = {}
  for (const f of landed) bump(landedByClass, f.class)

  // ── 机制分布 ──
  const perClass = {}
  for (const f of fails) bump(perClass, f.class)
  const perClassBySource = {}
  for (const f of fails) bump(perClassBySource, `${f.class}|${f.sourceKind}`)
  const perClassByKlass = {}
  for (const f of fails) bump(perClassByKlass, `${f.class}|${f.klass}`)
  /** 机制 × 「文件今天还在吗」：路径没了 ⇒ 「引文在不在原文里」这件事今天已无法再查。 */
  const perClassByExists = {}
  for (const f of fails) bump(perClassByExists, `${f.class}|${f.todayExists ? 'exists' : 'gone'}`)
  const goneTotal = Object.keys(perClassByExists)
    .filter((k) => k.endsWith('|gone'))
    .reduce((a, k) => a + perClassByExists[k], 0)
  const singleRowFails = fails.filter((f) => f.oldRows === 1)
  const perAsk = {}
  for (const f of fails) bump(perAsk, MECHANISM[f.class].asks)
  const perKind = {}
  for (const f of fails) bump(perKind, MECHANISM[f.class].kind)

  // ── 来源分层 ──
  const strata = {}
  for (const f of facts) {
    const k = f.sourceKind ?? 'none'
    strata[k] ??= { entries: 0, ok: 0, fail: 0, needs_choice: 0, already_applied: 0, unrepresentable: 0, na: 0 }
    strata[k].entries += 1
    strata[k][f.outcome] += 1
  }
  const nonDisk = facts.filter((f) => f.sourceKind !== 'disk')
  const nonDiskBuckets = {}
  for (const f of nonDisk) bump(nonDiskBuckets, f.outcome)
  const diskFails = fails.filter((f) => f.sourceKind === 'disk')
  const nonDiskFails = fails.filter((f) => f.sourceKind !== 'disk')
  const nonDiskByClass = {}
  for (const f of nonDiskFails) bump(nonDiskByClass, f.class)

  // ── X：三个口径 ──
  const xStrict = fails.filter((f) => f.class === 'defect_whole_line_unique')
  const xBroadList = fails.filter((f) => f.class === 'defect_whole_line_unique' || f.class === 'defect_fragment_unique')
  const xNormList = fails.filter((f) => f.class.startsWith('defect_'))
  const xBySource = {}
  for (const f of xNormList) bump(xBySource, f.sourceKind)
  const xByKlass = {}
  for (const f of xNormList) bump(xByKlass, f.klass)

  // ── 反例核对：X=0 时，最接近「信息足够」的那些条是什么样 ──
  const nearMiss = [...fails]
    .filter((f) => f.longestExactRowRun && f.longestExactRowRun.len > 0)
    .sort((a, b) => b.longestExactRowRun.len / b.longestExactRowRun.rows - a.longestExactRowRun.len / a.longestExactRowRun.rows)
  const fullRowRun = nearMiss.filter((f) => f.longestExactRowRun.len === f.longestExactRowRun.rows)

  // ── 需选择 / 无从表达 的构成（证明 174 的失败不是「该走 needs_choice 而没走」） ──
  const choiceWithPresence = choices.filter((f) => f.literalSpans.length > 0 || f.normSpans.length > 0)
  const choiceAbsent = choices.filter((f) => f.literalSpans.length === 0 && f.normSpans.length === 0)
  const unrepNoQuote = unrep.filter((f) => f.oldChars === null)
  const unrepNotReady = unrep.filter((f) => f.code === 'NOT_READY')

  // ── 对账 ──
  /**
   * PINNED —— 手抄自 `failure-replay.mjs` 主线程读数的**带日期快照**（不是从它那里算出来的）。
   *
   * 它现在**不是**判绿的参照：参照是现场向上游要的**活读数**（`columns.treeNew` / `columns.treeOld`）。
   * PINNED 只用来发现「上游自己变了」。取不到活读数（`--no-upstream` / 子进程起不来）时
   * 才退回以 PINNED 为参照 —— 那时它不符**判红**（没有活参照，陈旧常量就是唯一参照）。
   *
   * 什么时候必须更新它：只有当 `failure-replay.mjs` 跑绿（exit 0）之后，把它的 `--json` 里
   * `columns.treeNew` / `columns.treeOld` 原样抄过来 —— **只改数字，不碰判据**；
   * 两边不一致时先查 failure-replay，**不要**为了让本探针变绿而改这里 —— 本探针的存在意义
   * 就是当那个不对称的第三方。不更新也不会让本探针判红：屏幕上会打
   * `⚠ 内嵌 pin 已过期` 并给出**可原样粘贴的替换文本**（那种红是常量旧了，不是读数走样）。
   *
   * 上一次更新：C51（fs-contract-v2 波 17），2026-10-15。
   *   新契约列从 {ok:143, fail:174, needs_choice:15, unrepresentable:17, na:4}
   *   改成 {ok:143, fail:147, needs_choice:15, already_applied:27, unrepresentable:17, na:4}
   *   —— 不是引擎变了，是**这一列换到了与真工具同一个入口**（编排层 `applyEditToProvider`）：
   *   从前直接调判据层 `planHunks`，它对「old 不在、而 replace 已整行唯一存在」照旧抛
   *   `PATCH_NOT_FOUND`，于是那 27 条在读数上仍记 fail。现在多一格 `already_applied`。
   *   旧入参列不变。
   *
   * 上一次更新：C29（fs-contract-v2 波 9），2026-10-14。
   *   新契约列 {ok:143, fail:174, needs_choice:15, unrepresentable:17, na:4} —— 与波4/波7 同值；
   *   旧入参列从 85/267/1 改成 92/260/1（引擎在波5–波8 又沉了 7 条 ok，主线程侧已经变了，
   *   而这里一直抄的是波前的值，于是它是波8 之后唯一一条真的陈旧期望）。
   */
  const PINNED = {
    at: 'C51（fs-contract-v2 波 17），2026-10-15',
    source: 'node aura-tools/src/locator-lab/failure-replay.mjs --json → columns.treeNew / columns.treeOld',
    // 第四态也是新契约列的一格（且**必须**在这一组里）：不抄它，pin 与活读数会在 `fail` 上
    // 差出整整 27，而那不是“上游变了”，是本探针抄漏了一格。
    new: { ok: 143, fail: 147, needs_choice: 15, already_applied: 27, unrepresentable: 17, na: 4 },
    old: { ok: 92, fail: 260, unrepresentable: 1 },
  }
  /** 参照：活读数优先（现场向上游要的）；取不到才退回 pin，并在屏幕上说明。 */
  const reference = liveUpstream.treeNew === null || liveUpstream.treeOld === null
    ? { from: 'pin', how: `活读数取不到（${liveUpstream.why ?? liveUpstream.how}），退回 pin：${PINNED.at}`, new: PINNED.new, old: PINNED.old }
    : {
        from: 'live',
        how: `上游 failure-replay --json（${liveUpstream.how}）`,
        new: { ok: liveUpstream.treeNew.ok, fail: liveUpstream.treeNew.fail, needs_choice: liveUpstream.treeNew.needsChoice, already_applied: liveUpstream.treeNew.alreadyApplied, unrepresentable: liveUpstream.treeNew.unrepresentable, na: liveUpstream.treeNew.na },
        old: { ok: liveUpstream.treeOld.ok, fail: liveUpstream.treeOld.fail, unrepresentable: liveUpstream.treeOld.unrepresentable },
      }
  const expected = reference.new
  const mismatches = Object.entries(expected).filter(([k, v]) => (buckets[k] ?? 0) !== v)
  const oldExpected = reference.old
  const oldMismatch = Object.entries(oldExpected).filter(([k, v]) => (oldColumn.tally[k] ?? 0) !== v)
  /**
   * pin 过期：只在上游活得着、且活读数与 pin 不同时才算。这是**常量旧了**，不是读数走样；
   * `paste` 是可直接贴回 `PINNED` 的文本（只改数字，不碰判据）。
   */
  const pinStale = reference.from === 'live'
    ? {
        new: Object.entries(PINNED.new).filter(([k, v]) => expected[k] !== v),
        old: Object.entries(PINNED.old).filter(([k, v]) => oldExpected[k] !== v),
        paste: `    new: { ok: ${expected.ok}, fail: ${expected.fail}, needs_choice: ${expected.needs_choice}, already_applied: ${expected.already_applied}, unrepresentable: ${expected.unrepresentable}, na: ${expected.na} },\n    old: { ok: ${oldExpected.ok}, fail: ${oldExpected.fail}, unrepresentable: ${oldExpected.unrepresentable} },`,
      }
    : { new: [], old: [], paste: '' }
  const pinStaleAny = pinStale.new.length + pinStale.old.length > 0

  // ── B01 的 legacy_form：分格 + 与上游形状对账 + 复核 ──
  const b01IdsNow = fails.filter((f) => f.class === 'not_text_quote').map((f) => f.id)
  const c34Verdict = c34.json?.verdict ?? null
  const legacySplit = {}
  for (const r of legacyRows) bump(legacySplit, r.form ?? 'unknown')
  /** 形状不变量：只允许把上游的 X 拆成 X+R，Z / W / Y 必须逐格相等。 */
  const c34Shape = c34Verdict === null
    ? null
    : {
        x: c34Verdict.x_artifact.length,
        y: c34Verdict.y_entryGap.length,
        z: c34Verdict.z_payload.length,
        w: c34Verdict.w_inapplicable.length,
        ok:
          (legacySplit.X ?? 0) + (legacySplit.R ?? 0) === c34Verdict.x_artifact.length &&
          (legacySplit.Z ?? 0) === c34Verdict.z_payload.length &&
          (legacySplit.W ?? 0) === c34Verdict.w_inapplicable.length &&
          (legacySplit.Y ?? 0) === c34Verdict.y_entryGap.length,
      }
  /** 本次的 B01 编号集必须与上游逐字一致 —— 否则这一列建在两份不同的名单上。 */
  const b01IdSetEqual = c34.ids !== null && c34.ids.length === b01IdsNow.length && b01IdsNow.every((id) => c34.ids.includes(id))
  /** 每一条都必须拿到上游归因 + 它自己的 landing（`--show` 给小了就拿不到）。 */
  const legacyRowProblems = []
  for (const r of legacyRows) {
    if (r.c34Verdict === null) legacyRowProblems.push(`${r.id} 在上游 address-form-census 的 entries 里没有归因（B01 名单分叉 / 上游没跑到它）`)
    else if (!Object.prototype.hasOwnProperty.call(r.c34Row, 'landing')) legacyRowProblems.push(`${r.id} 的上游行里没有 landing 字段（--show 给小了？）`)
  }
  const legacyProblems = wantUpstream && c34.ok ? [...legacyRowProblems, ...verifyLegacyForms(legacyRows)] : []
  const digestDrift = ENGINE_MODULES.filter((m) => digestsBefore[m] !== digestsAfter[m])
  const rowSum = Object.values(perClass).reduce((a, b) => a + b, 0)

  // ── 打印 ──
  console.log('')
  console.log(`=== R1 残余失败机制分解（新契约 fail ${fails.length} 条逐条归类；令 27 条已落地的不在其中） ===`)
  console.log(`  语料 ${path.relative(REPO, CORPUS_PATH)} ｜ sha256:12=${corpusDigest} ｜ builtAt=${corpus.builtAt} ｜ schema=${corpus.schema}`)
  console.log(`  条目 ${corpus.entries.length} ｜ 可重放 ${facts.length} ｜ 漂移(drifted) ${corpus.entries.length - facts.length}（不计入分母）`)
  console.log(`  引擎（现树） ${ENGINE_MODULES.map((m) => `${m}=${digestsBefore[m]}`).join('  ')}`)
  console.log(`  引擎探针 ready=${engine.ready} ｜ ${engine.how}`)
  console.log('')
  console.log('  ── 分桶（与 failure-replay 主线程读数逐格对账） ──')
  console.log(
    `     新契约   ok ${buckets.ok ?? 0} ｜ fail ${buckets.fail ?? 0} ｜ 需选择 ${buckets.needs_choice ?? 0} ｜ 已落地 ${buckets.already_applied ?? 0} ｜ 无从表达 ${buckets.unrepresentable ?? 0} ｜ 无对应入口 ${buckets.na ?? 0} ｜ 合计 ${facts.length}`,
  )
  // 期望值的**显示文本从期望对象生成**，不再手写第二遍：两处各写一次时，改了一处忘了另一处
  // 就会出现「判据绿着、屏幕上印的却是旧数」——那是比过期更难发现的一种错。
  const expectedLine = `ok ${expected.ok} ｜ fail ${expected.fail} ｜ 需选择 ${expected.needs_choice} ｜ 已落地 ${expected.already_applied} ｜ 无从表达 ${expected.unrepresentable} ｜ 无对应入口 ${expected.na}`
  const oldExpectedLine = `${oldExpected.ok}/${oldExpected.fail}/${oldExpected.unrepresentable}`
  console.log(
    `     期望      ${expectedLine}  →  ${mismatches.length === 0 ? '逐格一致 ✓' : `不一致：${mismatches.map(([k, v]) => `${k} 期望 ${v} 实得 ${buckets[k] ?? 0}`).join('；')}`}`,
  )
  console.log(
    `     现树·旧入参 ok ${oldColumn.tally.ok ?? 0} / fail ${oldColumn.tally.fail ?? 0} / 无从表达 ${oldColumn.tally.unrepresentable ?? 0}（走 replayOldColumn 导出）→ ${oldMismatch.length === 0 ? `与主线程 ${oldExpectedLine} 逐格一致 ✓` : `不一致：${oldMismatch.map(([k, v]) => `${k} 期望 ${v} 实得 ${oldColumn.tally[k] ?? 0}`).join('；')}`}`,
  )
  console.log('')
  console.log(`  ── 机制分布（分母 = 新契约 fail ${fails.length} 条） ──`)
  for (const key of Object.keys(MECHANISM)) {
    const n = perClass[key] ?? 0
    if (n === 0) continue
    console.log(`    ${pad(MECHANISM[key].short, 62)} ${pad(n, 5)}  [${KIND_LABEL[MECHANISM[key].kind]}]`)
  }
  console.log(`    ${pad('合计', 62)} ${pad(rowSum, 5)}  ${rowSum === fails.length ? `= fail ${fails.length} ✓` : `≠ fail ${fails.length} ✗ 阶梯没穷尽`}`)
  console.log('')
  console.log('  ── 机制 × 重放原文来源（log=日志快照 / receipt=回执实证 / disk=今日磁盘） ──')
  for (const key of Object.keys(MECHANISM)) {
    if ((perClass[key] ?? 0) === 0) continue
    const cells = ['log', 'receipt', 'disk'].map((s) => `${s} ${perClassBySource[`${key}|${s}`] ?? 0}`).join(' ｜ ')
    console.log(`    ${pad(MECHANISM[key].short, 62)} ${pad(perClass[key], 5)}  ${cells}`)
  }
  console.log('')
  console.log('  ── 机制 × 语料类别（S/W/D/N/歧义/坐标/参数/其他） ──')
  for (const key of Object.keys(MECHANISM)) {
    if ((perClass[key] ?? 0) === 0) continue
    const cells = ['S', 'W', 'D', 'N', 'ambiguity', 'coordinate', 'params', 'other']
      .map((k) => `${k} ${perClassByKlass[`${key}|${k}`] ?? 0}`)
      .filter((c) => !c.endsWith(' 0'))
      .join(' ｜ ')
    console.log(`    ${pad(MECHANISM[key].short, 62)} ${pad(perClass[key], 5)}  ${cells}`)
  }
  console.log('')
  console.log('  ── 机制 × 文件今天还在吗（路径没了的条目：它的引文在不在原文里，今天已无法再查） ──')
  for (const key of Object.keys(MECHANISM)) {
    if ((perClass[key] ?? 0) === 0) continue
    console.log(
      `    ${pad(MECHANISM[key].short, 62)} ${pad(perClass[key], 5)}  今天还在 ${perClassByExists[`${key}|exists`] ?? 0} ｜ 路径已不存在 ${perClassByExists[`${key}|gone`] ?? 0}`,
    )
  }
  console.log(`    合计路径已不存在的 fail：${goneTotal} 条（= 逐条 todayExists=false 的条数 ${fails.filter((f) => !f.todayExists).length}）`)
  console.log(`    引文是**单行**的 fail：${singleRowFails.length} 条（多行的 ${fails.length - singleRowFails.length} 条）`)
  console.log('')
  console.log(`  ── 第四态「已落地」（从残余里出去的 ${landed.length} 条；它们**不在**上面那个分母里） ──`)
  console.log('     判据归编排层（write-path.mjs 的 alreadyAppliedHits）：old 两层都找不到、而 replace 已整行唯一存在。')
  console.log('     下面这两个数由**本探针自己**量到（不引用上游结论）：写盘次数 = 0、且副本 sha256 前后相同。')
  console.log(`     已落地 ${landed.length} 条：其中 writeText 调用 0 次 ${landed.length - landedWrote.length} 条 ｜ 副本未变 ${landed.filter((f) => f.diskChanged !== true).length} 条 ｜ 动了盘的 ${landedWrote.length} 条${landedWrote.length ? ' ✗' : ' ✓'}`)
  console.log(`     从前归在哪一格（同一条阶梯重算一遍，证明它们确实是“从前记 fail 的那一批”）：${Object.entries(landedByClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${MECHANISM[k].short.split(' ')[0]}×${v}`).join(' ') || '—'}`)
  console.log('')
  console.log(`  ── B01 的 legacy_form（按**原参数**重放另加一列；分母 ${fails.length} 不动） ──`)
  if (!wantUpstream) {
    console.log(`     跳过（--no-upstream）：这一列没取，机制分布与 ${fails.length} 分母不受影响。`)
  } else if (!c34.ok) {
    console.log(`     ✗ 上游读数取不到：${c34.why}`)
  } else {
    console.log(`     判据来源：上游 address-form-census.mjs --json 的 verdict（${c34.how}）｜ B01 ${b01IdsNow.length} 条 ｜ 编号集与上游 ${b01IdSetEqual ? '逐字一致 ✓' : '不一致 ✗'}`)
    console.log('     只把上游的 X 再拆一格：X + R = 上游 x_artifact；Z / W / Y 逐格照搬（上游的判定本探针不重写）。')
    console.log(`     ${pad('id', 8)}${pad('形态', 11)}${pad('上游归因', 13)}${pad('legacy_form', 13)}${pad('落点', 9)}证据`)
    for (const r of legacyRows) {
      const ev = r.ev
      const landed = ev.landingLines.length ? ev.landingLines.map((n) => `L${n}`).join(',') : '—'
      const coords = ev.coords.length ? ev.coords.map((c) => `L${c.start}-${c.end}`).join('/') : '调用方没给坐标'
      const why = r.form === 'R'
        ? `兄弟块：落点 ${landed} 不在调用方给的坐标（${coords}）内；地址里有整行只在 L${ev.uniqueInside.map((u) => u.line).join('/')} 出现一次，而它在坐标内`
        : r.form === 'X'
          ? `坐标 ${coords}；落点 ${landed}（原形态能命中 ⇒ 入口在）`
          : (LEGACY_FORM[r.form] ?? '上游没判过这一条')
      console.log(`     ${pad(r.id, 8)}${pad(r.c34Row?.form ?? '?', 11)}${pad(r.c34Verdict ?? '?', 13)}${pad(r.form ?? '?', 13)}${pad(landed, 9)}${why}`)
    }
    console.log(`     分格  X ${legacySplit.X ?? 0} ｜ R ${legacySplit.R ?? 0} ｜ Z ${legacySplit.Z ?? 0} ｜ W ${legacySplit.W ?? 0} ｜ Y（真缺口） ${legacySplit.Y ?? 0}   合计 ${legacyRows.length} = B01 ${b01IdsNow.length}${legacyRows.length === b01IdsNow.length ? ' ✓' : ' ✗'}`)
    console.log(`     与上游形状对账：X+R ${(legacySplit.X ?? 0) + (legacySplit.R ?? 0)} = x_artifact ${c34Shape?.x ?? '?'} ｜ Z ${legacySplit.Z ?? 0} = z_payload ${c34Shape?.z ?? '?'} ｜ W ${legacySplit.W ?? 0} = w_inapplicable ${c34Shape?.w ?? '?'} ｜ Y ${legacySplit.Y ?? 0} = y_entryGap ${c34Shape?.y ?? '?'} → ${c34Shape?.ok ? '逐格一致 ✓' : '不一致 ✗'}`)
    console.log(`     ⇒ 结论：B01 的失败**不构成新契约的账** —— Y（真缺口）= ${legacySplit.Y ?? 0}（36 次原参数尝试里分派码 0 次，全部进了对应的地址层）。`)
    console.log(`        X + R 的 ${(legacySplit.X ?? 0) + (legacySplit.R ?? 0)} 条按原形态能命中（其中 R 的 ${legacySplit.R ?? 0} 条是「入口在、落点错（兄弟块）」）；`)
    console.log(`        Z 的 ${legacySplit.Z ?? 0} 条与 W 的 ${legacySplit.W ?? 0} 条原形态同样失败，但失败的是「这段地址在重放原文里对不上」/「该文件类型没有符号语言」——与 B03、C01 同族，是语料与夹具账。`)
  }
  console.log('')
  console.log('  ── 来源分层（分母 = 可重放 ' + facts.length + '） ──')
  console.log(`    ${pad('来源', 10)}${pad('条目', 7)}${pad('ok', 6)}${pad('fail', 7)}${pad('需选择', 8)}${pad('已落地', 8)}${pad('无从表达', 10)}${pad('无对应入口', 10)}`)
  for (const k of ['log', 'receipt', 'disk']) {
    const s = strata[k] ?? { entries: 0, ok: 0, fail: 0, needs_choice: 0, already_applied: 0, unrepresentable: 0, na: 0 }
    console.log(`    ${pad(k, 10)}${pad(s.entries, 7)}${pad(s.ok, 6)}${pad(s.fail, 7)}${pad(s.needs_choice, 8)}${pad(s.already_applied, 8)}${pad(s.unrepresentable, 10)}${pad(s.na, 10)}`)
  }
  console.log('')
  console.log('    **剔除今日磁盘(disk)来源**（拿几周前的调用去重放今天的文件，天然不公平）：')
  console.log(
    `      分母 ${nonDisk.length} 条 ｜ ok ${nonDiskBuckets.ok ?? 0} ｜ fail ${nonDiskBuckets.fail ?? 0} ｜ 需选择 ${nonDiskBuckets.needs_choice ?? 0} ｜ 已落地 ${nonDiskBuckets.already_applied ?? 0} ｜ 无从表达 ${nonDiskBuckets.unrepresentable ?? 0} ｜ 无对应入口 ${nonDiskBuckets.na ?? 0}`,
  )
  console.log(`      其中 disk 来源贡献 fail ${diskFails.length} 条（占 disk 分母 ${strata.disk?.entries ?? 0} 的 ${(((diskFails.length / (strata.disk?.entries ?? 1)) * 100) || 0).toFixed(1)}%）；非 disk 来源 fail ${nonDiskFails.length} 条（占 ${nonDisk.length} 的 ${(((nonDiskFails.length / (nonDisk.length || 1)) * 100) || 0).toFixed(1)}%）`)
  console.log(`      非 disk 来源的 fail 构成：${Object.entries(nonDiskByClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${MECHANISM[k].short.split(' ')[0]}×${v}`).join(' ')}`)
  console.log('')
  console.log('  ── 任务四问（把机制映射回那一问） ──')
  for (const ask of ['absent', 'not_unique', 'unique_missed', 'corpus', 'none']) {
    const n = perAsk[ask] ?? 0
    const which = Object.keys(MECHANISM).filter((k) => MECHANISM[k].asks === ask && (perClass[k] ?? 0) > 0)
    console.log(`    ${pad(ASK_LABEL[ask], 46)} ${pad(n, 5)}  ${which.map((k) => `${k}=${perClass[k]}`).join(' + ') || '—'}`)
  }
  console.log('')
  console.log('  ── X：模型给的信息足以确定意图、但工具没做到 ──')
  console.log('     严格口径 X = 引文逐字存在 + 全文唯一 + 整行对齐，planHunks 仍报找不到')
  console.log(`       X_strict = ${xStrict.length} 条   ${xStrict.length ? '编号：' + listIds(xStrict.map((f) => f.id)) : '(无)'}`)
  console.log(`       X_broad（+ 行内片段唯一） = ${xBroadList.length - xStrict.length} 条   ${xBroadList.length - xStrict.length ? '编号：' + listIds(xBroadList.filter((f) => f.class === 'defect_fragment_unique').map((f) => f.id)) : '(无)'}`)
  console.log(`       X_norm（+ 仅在空白折叠后唯一）= ${xNormList.length - xBroadList.length} 条   ${xNormList.length - xBroadList.length ? '编号：' + listIds(xNormList.filter((f) => f.class === 'defect_norm_unique').map((f) => f.id)) : '(无)'}`)
  console.log(`       ⇒ 合计 X = ${xNormList.length} 条（三个口径都算过；${xNormList.length === 0 ? '三个都是 0' : '见上'}）`)
  console.log('')
  console.log('  ── X=0 的反例核对：最接近「信息足够」的 fail 长什么样 ──')
  console.log(`     引文有 ≥1 行逐字连续命中的 fail：${nearMiss.length} 条；其中**全部行**都逐字命中的：${fullRowRun.length} 条`)
  console.log(`       （「全部行命中」仍失败的原因是它们**不连续**或顺序不对——逐条见 --json）`)
  for (const f of nearMiss.slice(0, 8)) {
    const r = f.longestExactRowRun
    console.log(`       ${f.id} ${pad(f.klass, 11)} ${pad(f.class, 20)} 最长逐字连续 ${r.len}/${r.rows} 行（old 第 ${r.oldRow + 1} 行 ↔ 原文第 ${r.srcLine} 行）`)
  }
  if (nearMiss.length > 8) console.log(`       …共 ${nearMiss.length} 条，全量见 --json 的 nearMiss`)
  console.log('')
  console.log('  ── 存疑：「该走需选择却落进 fail」有没有 ──')
  console.log(`     ${fails.length} 条 fail 里，引文逐字出现 ≥2 处的：${fails.filter((f) => f.literalSpans.length > 1).length} 条`)
  console.log(`     ${fails.length} 条 fail 里，引文逐字出现 ≥1 处的：${fails.filter((f) => f.literalSpans.length > 0).length} 条（引擎只在「找到了但收敛不到一个」时才报候选）`)
  console.log(`     另：判为需选择的 ${choices.length} 条里，引文在重放原文里逐字/归一化存在的 ${choiceWithPresence.length} 条，不存在的 ${choiceAbsent.length} 条`)
  console.log(`     另：无从表达 ${unrep.length} 条里，没有引文的 ${unrepNoQuote.length} 条，引擎未就绪的 ${unrepNotReady.length} 条`)
  console.log('')

  if (show > 0) {
    console.log(`  ── 逐条明细（fail 前 ${show} 条） ──`)
    for (const f of fails.slice(0, show)) {
      const r = f.longestExactRowRun
      console.log(`    ${f.id} ${f.klass} ${f.class} [${f.sourceKind}/${f.fidelity}] quoteKind=${f.quoteKind} code=${f.code}`)
      console.log(`       file=${f.file}`)
      console.log(`       old(${f.oldChars} chars / ${f.oldRows} rows)=${f.oldPreview}`)
      console.log(`       literalSpans=${JSON.stringify(f.literalSpans)} literalWholeLine=${JSON.stringify(f.literalWholeLineSpans)} normSpans=${JSON.stringify(f.normSpans)} normSpaceSpans=${JSON.stringify(f.normSpaceSpans)} longestExactRowRun=${r ? `${r.len}/${r.rows}` : 'null'}`)
      console.log(`       oldInReplace=${f.oldInReplace} replaceTruncated=${f.replaceTruncated} todayExists=${f.todayExists} todayHasOld=${f.todayHasOld}`)
      for (const a of f.attempts) console.log(`       try[${a.address}] ${a.code} cands=${a.candidates} msg=${String(a.message).slice(0, 200)}`)
    }
  }

  console.log('=== 对账 ===')
  console.log(`  参照：${reference.from === 'live' ? '**活读数**' : '**内嵌 pin**'}（${reference.how}）`)
  console.log(
    `  新契约列 vs 主线程 ${expected.ok}/${expected.fail}/${expected.needs_choice}/${expected.already_applied}/${expected.unrepresentable}/${expected.na}：${mismatches.length === 0 ? '逐格一致 ✓' : `不一致 ✗ ${mismatches.map(([k, v]) => `${k} 期望 ${v} 实得 ${buckets[k] ?? 0}`).join('；')}`}`,
  )
  console.log(`  现树·旧入参列 vs 主线程 ${oldExpectedLine}：${oldMismatch.length === 0 ? '逐格一致 ✓' : `不一致 ✗ ${oldMismatch.map(([k, v]) => `${k} 期望 ${v} 实得 ${oldColumn.tally[k] ?? 0}`).join('；')}`}`)
  console.log(`  引擎文件跑前/跑后摘要：${digestDrift.length === 0 ? '逐项未变 ✓' : `变了 ✗ ${digestDrift.map((m) => `${m}: ${digestsBefore[m]}→${digestsAfter[m]}`).join('；')}`}`)
  console.log(`  机制分布之和 ${rowSum} ${rowSum === fails.length ? `=  fail ${fails.length} ✓` : `≠ fail ${fails.length} ✗`} ｜ 未归类(other) ${perClass.other ?? 0} 条`)
  if (!wantUpstream) {
    console.log('  legacy_form：跳过（--no-upstream）—— 这一列没取，它的断言一并跳过。')
  } else if (!c34.ok) {
    console.log(`  legacy_form：✗ 上游读数取不到（${c34.why}）`)
  } else {
    console.log(`  legacy_form：B01 ${legacyRows.length} 条全部拿到上游归因（${legacyRowProblems.length === 0 ? '✓' : `✗ ${legacyRowProblems.length} 条例外`}）｜ 编号集 ${b01IdSetEqual ? '与上游逐字一致 ✓' : '与上游不一致 ✗'} ｜ 分格形状 ${c34Shape?.ok ? '与上游 verdict 逐格相容 ✓' : '与上游 verdict 不符 ✗'}`)
    console.log(`  落点复核：R（入口在、落点错·兄弟块）${legacySplit.R ?? 0} 条 —— 判据与证据分开写、复核又重算一遍：${legacyProblems.length === 0 ? '逐条一致 ✓' : `✗ ${legacyProblems.length} 条不一致`}`)
    if (c34.exit !== 0) {
      console.log(`  ⚠ 上游 address-form-census 自检未通过（${c34.how}）—— 它自己没认账的判据（原样转引，本探针改写不了它们）：`)
      for (const f of c34.fails) console.log(`        上游自报：${f}`)
    }
  }
  if (pinStaleAny) {
    console.log('')
    console.log('  ⚠ 内嵌 pin 已过期（上游/引擎演进了；**不影响本次判绿**，参照是活读数）：')
    for (const [k, v] of pinStale.new) console.log(`     新契约列 ${k}：pin ${v} → 上游现读 ${expected[k]}`)
    for (const [k, v] of pinStale.old) console.log(`     旧入参列 ${k}：pin ${v} → 上游现读 ${oldExpected[k]}`)
    console.log('     更新指引（规矩见 PINNED 上方注释：只在 failure-replay exit 0 之后抄，只改数字）：')
    console.log('       1) 先把上游跑绿：node aura-tools/src/locator-lab/failure-replay.mjs   （必须 exit 0）')
    console.log('       2) 读它的 --json → columns.treeNew / columns.treeOld，把 PINNED 里那两行原样换掉，并把 `at:` 改成今天日期：')
    for (const line of pinStale.paste.split('\n')) console.log(`          ${line}`)
    console.log('       3) 改完重跑本探针：这一块 ⚠ 应当消失；若上游现读与本次复刻不符，那才是判红的那种错（复刻走样）。')
  }

  let exitCode = 0
  if (assertMode) {
    const problems = []
    if (mismatches.length || oldMismatch.length) problems.push(`与主线程读数不一致（本探针与上游跑的不是同一份实现；参照=${reference.from}，${reference.how}）`)
    if (rowSum !== fails.length) problems.push('机制分布未穷尽（之和不等于 fail 条数）')
    /**
     * C51 新增：「已落地」这一格的**自有凭据**（不引用上游的任何结论）：
     *   · 这一格必须真的非空 —— 空了要么是引擎里那一态被拿掉了，要么是本探针又退回复刻；
     *   · 每一条都必须量到**写盘 0 次且副本未变** —— 「一个字节都没写」由本探针自己的两个读数撑。
     * 这两条与 fail 的分母无关：它们判的是「那 27 条到底去哪了」这件事有没有被说谎。
     */
    if (landed.length === 0) problems.push('已落地（第四态）= 0：新契约列要么没走编排层，要么引擎里这一态没了（两者都与本探针的读数口径相违）')
    if (landedWrote.length > 0) problems.push(`已落地 ${landed.length} 条里有 ${landedWrote.length} 条动了盘（writes=${landedWrote.map((f) => f.writes).join('/')}；diskChanged=${landedWrote.filter((f) => f.diskChanged === true).length} 条）—— 第四态必须发生在写盘之前`)
    if ((perClass.other ?? 0) > 0) problems.push(`有 ${perClass.other} 条未归类`)
    if (digestDrift.length) problems.push('引擎文件在本次测量期间发生变化')
    // 上游：读数取不到就不装作对过账；上游自检红 = 本格建在它没认账的读数上。
    if (wantUpstream && !liveUpstream.ok) problems.push(`上游 failure-replay 的活读数取不到：${liveUpstream.why ?? liveUpstream.how}`)
    if (wantUpstream && liveUpstream.ok && liveUpstream.exit !== 0) problems.push(`上游 failure-replay 自检未通过（${liveUpstream.how}${liveUpstream.fails.length ? `；它自报：${liveUpstream.fails.slice(0, 2).join(' / ')}` : ''}）⇒ 它给的活读数没被它自己认账；先修上游，再回来看本格`)
    if (wantUpstream && !c34.ok) problems.push(`上游 address-form-census 的读数取不到（legacy_form 一列无源）：${c34.why}`)
    if (wantUpstream && c34.ok && c34.exit !== 0) problems.push(`上游 address-form-census 自检未通过（${c34.how}${c34.fails.length ? `；它自报：${c34.fails.slice(0, 3).join(' / ')}` : ''}）⇒ B01 的 legacy_form 一列建在它没认账的归因上；先修上游（或它点名的引擎问题），再看这一格`)
    if (wantUpstream && c34.ok && !b01IdSetEqual) problems.push(`本次的 B01 编号集与上游不一致（我 ${b01IdsNow.length} 条 / 上游 ${c34.ids?.length ?? 0} 条）`)
    if (wantUpstream && c34.ok && c34Shape !== null && !c34Shape.ok) problems.push('legacy_form 的分格与上游 verdict 形状不符（只允许把上游的 X 拆成 X+R；Z / W / Y 必须逐格相等）')
    if (wantUpstream && c34.ok && (legacySplit.unknown ?? 0) > 0) problems.push(`有 ${legacySplit.unknown} 条 B01 没拿到上游归因（归不了因就不装作归过）`)
    if (wantUpstream && c34.ok && (legacySplit.Y ?? 0) > 0) problems.push(`Y（真缺口）= ${legacySplit.Y}：原参数重放出现了**分派码**，这三种形态上真的有入口缺口（该补引擎的地址分派层）`)
    for (const p of legacyProblems) problems.push(p)
    /**
     * 用法面（本次加固）：未知旗标必须被**点名拒收**（exit 2），不能静默跑默认窗口 ——
     * `--assert` 那样的错字在旧版会被吞掉，屏幕上仍是一份完整读数加 `✓ 全部对账通过`。
     * 判据直接调本探针的解析器（不 spawn 子进程）：拿一个不存在的旗标问它。
     */
    const argProbe = usageFailure([UNKNOWN_FLAG])
    if (
      argProbe === null ||
      argProbe.exit !== USAGE_EXIT ||
      !argProbe.message.includes(UNKNOWN_FLAG) ||
      FLAGS.some((f) => !argProbe.message.includes(f.form))
    ) {
      problems.push(
        `用法面：未知旗标没有被拒收 —— ${UNKNOWN_FLAG} ⇒ ${argProbe === null ? '解析器静默吞掉（会跑出一份看着正常的读数）' : `exit ${argProbe.exit}，点名/支持集 ${!argProbe.message.includes(UNKNOWN_FLAG) || FLAGS.some((f) => !argProbe.message.includes(f.form)) ? '不全' : '齐全'}`}；要求 exit ${USAGE_EXIT} 并点名 + 列出全部 ${FLAGS.length} 个支持旗标`,
      )
    }
    if (problems.length) {
      for (const p of problems) console.log(`✗ ${p}`)
      exitCode = 1
    } else {
      console.log('✓ 全部对账通过')
    }
  }

  if (json) {
    console.log('')
    console.log('=== JSON ===')
    const payload = {
      unit: 'R1',
      corpus: { path: path.relative(REPO, CORPUS_PATH), sha256_12: corpusDigest, builtAt: corpus.builtAt, entries: corpus.entries.length, replayable: facts.length },
      engine: { digests: digestsBefore, ready: engine.ready, how: engine.how },
      buckets,
      expected,
      expectationSource: {
        reference: reference.from,
        how: reference.how,
        pinned: { at: PINNED.at, source: PINNED.source, new: PINNED.new, old: PINNED.old },
        // pin 过期时把「可直接贴回去的文本」一并吐出来（下游不必自己拼）。
        pinStale: pinStaleAny ? { new: pinStale.new, old: pinStale.old, paste: pinStale.paste } : null,
      },
      upstream: {
        addressFormCensus: wantUpstream ? { ran: true, ok: c34.ok, exit: c34.exit, how: c34.how, why: c34.why, selfReported: c34.fails } : { ran: false, why: '--no-upstream' },
        failureReplay: wantUpstream ? { ran: true, ok: liveUpstream.ok, exit: liveUpstream.exit, how: liveUpstream.how, why: liveUpstream.why, selfReported: liveUpstream.fails, treeNew: liveUpstream.treeNew, treeOld: liveUpstream.treeOld } : { ran: false, why: '--no-upstream' },
      },
      legacyForm: {
        column: 'legacy_form',
        from: 'address-form-census.mjs --json 的 verdict（只读消费；本探针只把 X 再拆出 R）',
        denominatorUntouched: fails.length,
        b01: b01IdsNow,
        b01MatchesUpstream: b01IdSetEqual,
        split: legacySplit,
        upstreamShape: c34Shape,
        checkProblems: legacyProblems,
        rows: legacyRows.map((r) => ({
          id: r.id,
          form: r.c34Row?.form ?? null,
          c34Verdict: r.c34Verdict,
          legacyForm: r.form,
          source: r.source,
          evidence: r.ev,
          landingTiers: r.ev.c34Tiers,
        })),
      },
      reconciled: mismatches.length === 0 && oldMismatch.length === 0,
      oldColumn: oldColumn.tally,
      failTotal: fails.length,
      /**
       * C51：从残余里出去的那一批（第四态）。`wroteAnything` / `diskChanged` 都是**本探针**
       * 在可写副本上量到的原始读数 —— 上游的 27 这个数与本探针的这一组必须各自成立。
       */
      alreadyApplied: {
        total: landed.length,
        ids: landed.map((f) => f.id),
        wroteAnything: landedWrote.length,
        diskChanged: landed.filter((f) => f.diskChanged === true).length,
        byClass: landedByClass,
        rows: landed.map((f) => ({ id: f.id, klass: f.klass, class: f.class, source: `${f.sourceKind}/${f.fidelity}`, writes: f.writes, diskChanged: f.diskChanged })),
      },
      mechanism: perClass,
      mechanismByKind: perKind,
      mechanismBySource: perClassBySource,
      mechanismByKlass: perClassByKlass,
      mechanismByExists: perClassByExists,
      singleRowFails: singleRowFails.length,
      byAsk: perAsk,
      strata,
      nonDisk: { denominator: nonDisk.length, buckets: nonDiskBuckets, fails: nonDiskFails.length, byClass: nonDiskByClass },
      X: {
        strict: xStrict.length,
        broad: xBroadList.length,
        norm: xNormList.length,
        strictIds: xStrict.map((f) => f.id),
        broadIds: xBroadList.map((f) => f.id),
        normIds: xNormList.map((f) => f.id),
        bySource: xBySource,
        byKlass: xByKlass,
      },
      nearMiss: nearMiss.map((f) => ({
        id: f.id,
        klass: f.klass,
        class: f.class,
        source: `${f.sourceKind}/${f.fidelity}`,
        longestExactRowRun: f.longestExactRowRun,
        literalSpans: f.literalSpans,
        oldRows: f.oldRows,
      })),
      choiceAudit: { total: choices.length, withQuote: choiceWithPresence.length, withoutQuote: choiceAbsent.length },
      unrepAudit: { total: unrep.length, noQuote: unrepNoQuote.length, notReady: unrepNotReady.length, ids: unrep.map((f) => f.id) },
      naAudit: { total: nas.length, ids: nas.map((f) => f.id) },
      fails: fails.map((f) => ({
        id: f.id,
        klass: f.klass,
        at: f.at,
        class: f.class,
        asks: MECHANISM[f.class].asks,
        kind: MECHANISM[f.class].kind,
        code: f.code,
        source: `${f.sourceKind}/${f.fidelity}`,
        quoteKind: f.quoteKind,
        file: f.file,
        oldChars: f.oldChars,
        oldRows: f.oldRows,
        literalSpans: f.literalSpans,
        literalWholeLineSpans: f.literalWholeLineSpans,
        normSpans: f.normSpans,
        normSpaceSpans: f.normSpaceSpans,
        longestExactRowRun: f.longestExactRowRun,
        oldInReplace: f.oldInReplace,
        replaceTruncated: f.replaceTruncated,
        todayExists: f.todayExists,
        todayHasOld: f.todayHasOld,
        oldPreview: f.oldPreview,
        attempts: f.attempts,
      })),
    }
    console.log(JSON.stringify(payload, null, 1))
  }
  process.exit(exitCode)
}

await main()
