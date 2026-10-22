/**
 * quote-hygiene.mjs —— C33：残余那些「引文与原文对不上」的失败里，有多少是
 * **工具自己的回执格式被抄进了引文**？（只测量，不改引擎、不改语料、不改重放器）
 *
 * ## 它回答什么
 *
 * `residual-census.mjs` 读出残余 174 条 fail（**C33 当次读数**；C53 把入口换成上游那一份实现、
 * 接上第四态之后是 147 —— 差的 27 条是「这次编辑其实已经落地了」，不是引文对不上），机制上全是
 * 「引文与原文对不上」（B03 整块不在 73 ｜ B04 只有部分相邻行对得上 53 ｜ B01 引文不是文本 12 ｜
 *   B02 引文是改后文本 14 ｜ C01 语料过期 22），且其中**引文逐字出现在重放原文里的：0 条**。
 * 工具侧可消的 X 已经到 0，于是要问下一个问题：
 *
 *   这 147 条的**引文本身**，是不是被读/写回执的渲染格式弄脏了？——行号前缀 `123: `、
 *   换行标记 `⏎`、续断 `…`、截断说明 `(N more chars withheld)`、零宽/全角同形异码、
 *   CRLF 混入、引文行数与声称区间不符。
 *
 * 如果污染占比高，那这就不是「调用方记错」而是**回执把原文弄脏了**，是工具侧可修的。
 *
 * ## 三段读数
 *
 *   ① **污染形态分布**：对语料里每条引文机械检测上列形态，给计数与占比（分母两套：
 *      全部有引文的 397 条 / 残余 fail 147 条）。
 *   ② **去污后重测**（本单最值钱的一个数）：把检测到的污染剥掉，用**同一份**重放器
 *      再跑一次，读「去污前 fail X → 去污后 fail Y」。并给**逐形态归因**：只剥这一种
 *      形态时，147 条里有几条翻成 ok —— 翻不动的形态，计数再高也不是病因。
 *   ③ **逐类判定**：工具侧可修 / 调用方侧 / 语料伪影，并指出该改哪一层。
 *
 * 另有 ④ 成功集对照（同一套检测跑 success-regression 抽的那份成功语料）与
 * ⑤ 源侧污染普查（重放原文自己带没带这些形态）——前者给相关性作对照，
 * 后者是「语料伪影」这一类判定的证据。
 *
 * ## 与上游的关系：import 同一份入口，不再复刻（C53）
 *
 * 本文件原先自带一份 `toContentAddress` / `neighbourContext` / `locateQuiet` /
 * `legacyRequest` 的逐字复刻 —— 与 `residual-census.mjs` / `address-form-census.mjs` /
 * `already-applied-census.mjs` 上一波删掉的是**同一处缝**：复刻件只要与上游差半点，fail 集合
 * 就不一样，于是「本探针的读数」与「上游那一列」变成两份口径，谁也说不出哪个对。
 *
 * 现在重放本身走 `failure-replay.mjs` 导出的 `replayNewContract`（**上游那一列的实现本身**，
 * 走编排层 `applyEditToProvider`）。本文件只留两样：一层**记账**适配（未就绪 / 读路径 / 无引文
 * 三种归属，与上游主循环逐条同形）与**摊副本**那一步（上游不导出它，其余三件普查件同样保留）。
 * 判据层一个字都不另写 —— 判据①拿读数逐格对账，判据⑯拿源码静态盯住这个入口。
 *
 * 口径也随之换成上游的**六格**（原先是五格）：ok / fail / 需选择 / **已落地 `already_applied`** /
 * 无从表达 / 无对应入口。原先那份复刻走的是 `planHunks`，**看不见第四态** —— 于是 27 条
 * 「这次编辑其实已经落地了」被算进了 fail（旧读数的 174 = 147 fail + 27 已落地）。
 *
 * ## 只读约束
 *
 * 写范围只有本文件。分类只读语料与重放原文；副本一律落在 `os.tmpdir()`，
 * 语料里的路径**从不**被写（`stageToolCopy` 写的是临时目录里的副本）。
 *
 * ## 判定力（C36 加严；形态是 C33 的，判定力是后补的）
 *
 * 本探针原先的毛病：**判据判不了它自己的结论**。关于去污的那条写成 `fail ≤ baseline`（等号放行），
 * 去污函数改成恒等（fail 仍 174、Δ 0）它照样打印「7/7 判据通过」并 exit 0 ——
 * 因为 exit 只挂在基准对账上，而基准对账与「去污到底有没有用」是两件事。现在：
 *
 *   ① 主读数钉成**等式**：洗活集恰为 EXPECT.cleanLive（当前 `["F0275"]`，逐条点名）、
 *      去污后 fail/ok 恰为 EXPECT.cleanFail / EXPECT.cleanOk（C53 实测 146 / 144）、洗坏集恰为空集。
 *      任一条不符 ⇒ exit 非 0。期望值集中在文件顶部的 `EXPECT` 里，不散落在各条判据里。
 *   ② 反面对照（连忠实形态一起洗）的期望同样钉死：恰洗坏 EXPECT.allFormsBroken 条、ok 恰为
 *      EXPECT.allFormsOk（22 条 / 122）—— 不再是「只要变差就行」。
 *   ③ **自证**（④ 趟）：同一份重放器多跑一趟**恒等对照**（`transform: null`）。两条路只差
 *      `clean` 一个函数，所以「主去污趟必须与恒等对照分叉」就是「去污函数真的在做事」的证据；
 *      去污退化成恒等时两路重合，自证与主判据一齐红。
 *   ④ 退出码改挂**全部判据**（`checks.every(ok)`），不是只挂基准对账。
 *
 * 变异反证（可复现）：把任一形态的 `clean` 改成 `s => s` ⇒ exit 1，并点名「期望 cleanFail、delta 0、
 * 期望 delta = 洗活条数」；整层去污都恒等 ⇒ 同样 exit 1（红在自证那条）。改回即回绿。
 * 断言只增不减：7 条 → 13 条 → 15 条（C40 加「常量自洽」与「常量指纹」两条，见下一节）→
 * 18 条（C53 加三条：③「分桶穷尽」（桶必须恰为六格）、⑰「六格下的洗活口径」（除 fail→ok 外
 * 没有别的迁移进出 fail 格）、⑱「入口同一性」（与其余三件普查件同形 —— 它盯的是**缝本身有没有长回来**））。
 *
 * ## C40：两个内嵌期望值不许各自漂移（本波还原的就是这一处现场）
 *
 * 上一波在这个文件里留下一行 `cleanFail: 172`（= 洗活 2 条）而 `cleanLive` 仍是 `{F0275}`（1 条）——
 * 三个数各自钉死、谁也不管谁，于是「改了一个忘了另一个」就留下自相矛盾的现场：探针红在**读数**上
 * （fail 174→173 ≠ 期望 172），读的人得从屏幕文字里反推到底是哪条常量写错了、还是引擎真的变了。
 * 从 C40 起加两条**常量侧**判据（它们与实测读数无关，所以不会被漂亮的实测读数掩盖）：
 *
 *   第 15 条 `EXPECT.cleanFail === BASELINE.fail - EXPECT.cleanLive.length`（自洽不变量），
 *            不符即红并**给出建议值**。三个数仍然逐格钉死（绝不按运行结果回填），只是必须互相自洽。
 *   第 16 条 三个常量的**指纹**（`EXPECT_PIN_FINGERPRINT`）—— 把 `147 / 146 / ["F0275"]` 当**一个组合**
 *            钉住。第 15 条拦不住「一对同向改动」（把 cleanFail 与 cleanLive 一起改成 147 / [] 也自洽），
 *            指纹拦得住：一被改动就当场点名「≠ 交付时记录」。有意改动时要连注释与指纹一起更新。
 *            （序号随判据增删而移：C53 在开头插了「分桶穷尽」一条，这两条由 14/15 移到了 15/16。）
 *
 * 另外，运行时读数最前面会打印**本文件自己的 sha256**（全量与前 16 位）、三个钉死常量的当前值、
 * 常量指纹与这三句的逐句对账 —— 「变异反证之后到底还原了没有」从此是对着屏幕逐字比，
 * 而不是靠回执里的一句话（口径见下面 `自身` 那三行）。
 *
 * 用法：
 *   node aura-tools/probes/quote-hygiene.mjs                 # 全部读数
 *   node aura-tools/probes/quote-hygiene.mjs --json          # 附机器可读统计
 *   node aura-tools/probes/quote-hygiene.mjs --show=8        # 每形态附若干条明细
 *   node aura-tools/probes/quote-hygiene.mjs --success=PATH  # 指定成功集语料
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pkgPath } from '../build/pkg-root.mjs'

// 只 import 现成的导出：本单不改 aura-tools/src/**
//
// `replayNewContract` = 上游「现树·新契约」列**那一处实现**（走编排层 `applyEditToProvider`）。
// 口径不许另写一份：本文件原先那四个复刻件（`toContentAddress` / `neighbourContext` /
// `locateQuiet` / `legacyRequest`）C53 删除，重放一律走这个导出。
import { probeEngineOldContract, replayNewContract } from '../src/locator-lab/failure-replay.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 探针自己（C40）：运行时算出自身 sha256 打印出来，供「变异反证后确认已还原」逐字对账。 */
const SELF_PATH = fileURLToPath(import.meta.url)
/**
 * **在模块加载那一瞬间把自己的字节读下来**（C53 顺手收紧的一处）。
 *
 * 原先这一读写在打印那一段里（`main()` 末尾），于是“跑到一半文件被改掉”时，它打印的是**改后的
 * 字节**，而真正跑完的代码是改前那一份 —— 这一行存在的意义（对着它逐字确认“变异反证之后到底
 * 还原了没有”）当场失效，而且失效得**看不出来**。读在模块加载时仍不等于“逐字节等于执行的那一份”，
 * 但窗口从“整个跑动时长”缩到了“加载那一瞬”。
 */
const SELF_BYTES = fs.readFileSync(SELF_PATH)
const REPO = path.resolve(HERE, '../..')
const CORPUS_PATH = pkgPath('src', 'locator-lab', 'failure-corpus.json')
const ENGINE_MODULE_SET = ['write-path.mjs', 'locator-api.mjs', 'read-core.mjs', 'anchor-core.mjs', 'args.mjs']
/**
 * 主流程第一件事算出来的可重放条数（= 六格之和应当等于的那个数）。
 *
 * 单独存一份而不是用 `baseline.sum`：`sum` 是**分桶求和**，它与“可重放条数”相等是需要判的
 * 结论（条目落在六格之外时就不再相等），拿 `sum` 给自己当分母等于什么都没判。
 */
let replayableCount = 0

/**
 * 成功集语料：`success-regression.mjs` 自己那次 `--corpus-out` 写出来的那份
 * （它的默认落点就是 `os.tmpdir()/aura-r2-success-corpus.json`）。
 * 本单**不重跑**那个探针（它扫 600MB 会话日志、要跑几分钟），只读它已经写下的样本；
 * 候选按 mtime 取最新，屏幕上明写用了哪一份、多大、什么时候写的、摘要多少。
 */
const SUCCESS_CANDIDATES = [
  path.join(os.tmpdir(), 'aura-r2-success-corpus.json'),
  path.join(os.tmpdir(), 'aura-r2-success-corpus-c33.json'),
]

// 六格取上游 `failure-replay.mjs` 的 OUTCOME 取值（键名逐字对齐，显示口径才能一个函数盖住）。
const OUTCOME = {
  ok: 'ok',
  fail: 'fail',
  needsChoice: 'needs_choice',
  alreadyApplied: 'already_applied',
  unrepresentable: 'unrepresentable',
  na: 'na',
}

/**
 * 基准桶：**六格**，抄自 `failure-replay.mjs` 主线程「现树·新契约」列的活读数
 * （C53 由五格换成六格 —— 第四态 `already_applied` 是上游 `replayNewContract` 才有的那一格，
 * 旧的本地复刻走 `planHunks`、看不见它）。六格之和恒等于可重放条数（353）。
 */
const BASELINE = { ok: 143, fail: 147, needs_choice: 15, already_applied: 27, unrepresentable: 17, na: 4 }

/**
 * 预期读数（C36 加的）—— **逐格写死，不写「不劣于」「不少于」这类不等式**。
 *
 * 本单踩过的坑：原先第 5 条判据写成 `cleanPass.fail <= BASELINE.fail`，**等号放行**，
 * 于是把去污函数改成恒等（fail 仍 174、Δ 0）它照样绿。凡是「洗了没坏处」就能满足的判据，
 * 都判不了「洗了到底有没有用」。所以：
 *   · `cleanLive` —— 洗活集**恰为**这个集合（有序、逐条点名）。多一条 = 去污越界（把不该动的动了），
 *     少一条 = 去污失效（该洗的没洗掉）。集合本身是本单实测的结论（② 的读数），不是照抄假设。
 *     它**只该在语料或引擎真的变了、且人复核过之后**才手工改 —— 探针自己绝不按运行结果回填。
 *   · `cleanFail` / `cleanOk` —— 去污后的绝对读数，用来钉 Δ（必须**不是 0**：Δ0 恰恰是
 *     「去污函数什么也没做」的形状）。
 *
 * **C53：这组常量随上游口径变过一次（174/173 → 147/146）—— 旧数字不是被“调口径”保下来的，
 * 是把本地复刻换成上游那一份实现后**实测**出来的：旧复刻走 `planHunks`、看不见第四态，
 * 于是 27 条「已经落地」被算进了 fail（174 = 147 + 27）。洗活集本身**没变**：仍是 {F0275}
 * （那条 `⏎` 引文），147 - 1 = 146。
 *   · `allFormsBroken` —— 反面对照的期望，同样钉死：把忠实形态（全角/续断）一起洗，
 *     恰好洗坏 22 条（比的是**恒等对照的 ok**，不是基准 ok —— 后者会随主去污层一起动）。
 *   · `allFormsBrokenIds` —— 被反面对照洗坏的那 22 条**逐条钉死**，不只钉条数。
 *     这里有个本单实测到的坑：`broken` 是 ok→**任意非 ok**，而 143 - 122 = **21** 不是 22 ——
 *     其中 1 条落到了 needs_choice（15→13），另外 1 条从 needs_choice 掉进了 fail。
 *     所以「ok 净变化」不能拿 broken 条数去减；要分三项各自钉（见「反面对照」那条判据）。
 *   · `allFormsOk` —— 反面对照的 ok 绝对值，基准引擎下 = 122。
 *   · `identityLoss` —— 恒等对照的**预期损失**（= 0）。它跟真实去污的读数一比，本单的自证就成立了。
 */
const EXPECT = {
  // C53 实测：146（= 147 - 1）。去污把 fail 147 里的 1 条（洗活集恰为 {F0275}）洗成 ok。
  // C40 当时这里是 173（= 174 - 1）：基准 fail 从 174 换成 147 是**入口换掉**带来的
  // （旧复刻看不见第四态），不是去污能力变了 —— 洗活集与洗坏集两条都一字未改。
  // 三个钉死常量的自洽不变量与指纹见下面 `PINNED`。
  cleanFail: 146,
  cleanOk: 144,
  cleanLive: ['F0275'],
  bothSidesLive: ['F0275'],
  allFormsOk: 122,
  allFormsBroken: 22,
  allFormsBrokenIds: [
    'F0041', 'F0079', 'F0089', 'F0101', 'F0107', 'F0138', 'F0152', 'F0178', 'F0215', 'F0218', 'F0237',
    'F0264', 'F0353', 'F0356', 'F0383', 'F0388', 'F0406', 'F0424', 'F0426', 'F0428', 'F0431', 'F0445',
  ],
  identityLoss: 0,
}

// ── 1.5 三个钉死常量的自洽不变量与指纹（C40）──────────────────────────────
//
// `baselineFail`（= BASELINE.fail，去污前的 fail 读数）、`cleanFail`（去污后应当剩几条 fail）、
// `washedIds`（= EXPECT.cleanLive，应当被洗活的条目）是**同一件事的三个面**：去污把 `washedIds` 里
// 每一条从 fail 洗成 ok，所以 `cleanFail` 必须**恰好**等于 `baselineFail - washedIds.length`。
// 三个数仍然各自钉死（本探针绝不按运行结果回填期望），只是不许自相矛盾 —— 上一波就是在这里
// 留下 `cleanFail: 172` 而 `washedIds` 只有 1 条的现场，红在读数上、要人反推是哪条常量错。
//
// **六格下这条不变量的前提要重述（C53）**：它默认「只有 fail→ok 这一种迁移进出 fail 格」。
// 五格时代这是默认成立的（其余四格不会动）；接上第四态后它**不再白给** —— 只要有一条
// `already_applied` 被洗成 fail，`cleanFail` 就会与 `baselineFail - washed` 对不上，
// 而屏幕上那条红只会说「数字不符」，指不到迁移上。所以另外单加一条**逐条迁移**判据
// （「六格下的洗活口径」）把它量出来；本条只留“三个常量互相自洽”这一件事。
const PINNED = (() => {
  const baselineFail = BASELINE.fail
  const cleanFail = EXPECT.cleanFail
  const washedIds = EXPECT.cleanLive
  const suggestedCleanFail = baselineFail - washedIds.length
  return {
    baselineFail,
    cleanFail,
    washedIds,
    suggestedCleanFail,
    consistent: cleanFail === suggestedCleanFail,
    // 指纹 = sha256(JSON.stringify([baselineFail, cleanFail, washedIds])) 的前 16 位。三个数当成
    // **一个组合**钉住：自洽不变量拦不住「一对同向改动」（例如 cleanFail 与 cleanLive 一起改成
    // 174 / [] 也自洽），指纹拦得住 —— 一被改动就失配。
    fingerprint: crypto.createHash('sha256').update(JSON.stringify([baselineFail, cleanFail, washedIds])).digest('hex').slice(0, 16),
  }
})()

/**
 * 交付时记录的常量指纹（C40 建、C53 随口径更新一次）。它只增不减地钉住 `147 / 146 / ["F0275"]`
 * 这一个组合：
 *   · 不等 ⇒ 三个钉死常量里至少一个被动过 —— 要么是变异反证没还原，要么是语料/引擎真的变了
 *     且人复核过（那就把这里、`EXPECT` 的注释与回执里的 sha256 一起更新，别只改数）。
 *
 * 变更记（两种必须分得清）：
 *   · C40–C52：`5f7bd20bb16a7fe5` = [174, 173, ["F0275"]]；
 *   · C53：`79d72c86e172aa57` = [147, 146, ["F0275"]] —— 入口从本地复刻改成上游导出的
 *     `replayNewContract`，基准 fail 少了 27 条「其实已经落地」（174 = 147 + 27），
 *     洗活集一字未改。**不是**把 cleanFail 挪一个数去保全旧指纹。
 * 算法见 `PINNED.fingerprint` 那一行；核对方法：跑一次探针，看它打印的「常量指纹」是否与这里一致。
 */
const EXPECT_PIN_FINGERPRINT = '79d72c86e172aa57'

// ── 1. 污染形态：检测 + 去污 ────────────────────────────────────────────────
//
// 每条形态三件事写在一处：`detect`（怎么算「有」）、`clean`（怎么剥）、`layer`（判定该谁修）。
// 写成一张表而不是散在各处，是为了「检测到的」与「被剥掉的」永远是同一件事 ——
// 两处各写一份的下场是去污读数好看、却答不了「你到底剥了什么」。

/** 回执行号前缀：`123: 内容`（aura_read 的行号前缀形状）。 */
const LINENO_RE = /^[ \t]{0,10}(\d{1,6}):([ \t])/
/** 换行标记：回执把换行渲染成的字面量（`⏎` 与它的近亲 `↵`）。 */
const RET_RE = /[\u23ce\u21b5]/
/** 续断标记：`…`（U+2026）与作为续断用的 `...`（排除 JS 展开运算符 `...args`）。 */
const UNI_ELLIPSIS_RE = /\u2026/g
const ASCII_DOTS_RE = /(^|[^\w$)\]}'"`])\.\.\.([^\w$([{'"`]|$)/
/**
 * 回执自己的说明文本：截断/省略句，以及错误回执的那两句套话。
 *
 * `omitted` 单字**不算**：语料里它是正文（`env.omitted`），加进去当场多一个假阳性。
 * 判据是「这句活只有回执会写」，不是「这个词看着像回执」。
 */
const RECEIPT_PROSE_RE = /\(\s*\d+\s+more\s+(?:chars?|lines?|bytes?)[^)]*\)|more\s+signatures?\s+beyond|chars?\s+withheld|lines?\s+withheld/i
/** 零宽 / 不可见字符。 */
const ZERO_WIDTH_RE = /[\u200b-\u200f\u2060\ufeff\u00ad]/
/** 全角同形异码（只收「有 ASCII 等价物」的那几个）。 */
const LOOKALIKE_RE = /[\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1d\uff02\uff1f]/
const LOOKALIKE_MAP = { '\uff01': '!', '\uff08': '(', '\uff09': ')', '\uff0c': ',', '\uff1a': ':', '\uff1b': ';', '\uff1d': '=', '\uff02': '"', '\uff1f': '?' }
// 带 `g` 的那几份：检测与去污共用同一条模式，不另拍一份（普查是热点，也省下重复编译）。
const RECEIPT_PROSE_G = new RegExp(RECEIPT_PROSE_RE.source, 'gi')
const ZERO_WIDTH_G = new RegExp(ZERO_WIDTH_RE.source, 'g')
const LOOKALIKE_G = new RegExp(LOOKALIKE_RE.source, 'g')
const ASCII_DOTS_G = new RegExp(ASCII_DOTS_RE.source, 'g')
/** 回执把原文包在弯引号里（`the content there is: “…”`）。只在引文首尾才算。 */
const WRAP_OPEN_RE = /^[\u201c\u201d\u2018\u2019]/
const WRAP_CLOSE_RE = /[\u201c\u201d\u2018\u2019]$/

/**
 * 形态表。`clean === null` ⇒ **不可去污**（剥掉就没有引文了），只报计数不参与重测。
 *
 * `layer` 是本单的判定（③），三个取值：
 *   `tool`    工具侧可修（回执渲染层）
 *   `caller`  调用方侧（模型抄错了东西，回执是干净的）
 *   `fixture` 语料/夹具伪影（重放原文本身不是原件）
 *   `design`  按设计（引文与地址本来就是两件事）
 */
const FORMS = [
  {
    key: 'lineno_prefix',
    label: '行首 `数字: ` 行号前缀',
    layer: 'tool',
    role: 'receipt',
    detect: (s) => {
      const rows = s.split('\n')
      const hit = rows.filter((r) => LINENO_RE.test(r))
      return hit.length > 0 ? { rows: hit.length, of: rows.length } : null
    },
    clean: (s) => s.split('\n').map((r) => r.replace(LINENO_RE, '$2')).join('\n'),
  },
  {
    key: 'ret_newline',
    label: '字面量换行标记 `⏎` / `↵`',
    layer: 'tool',
    role: 'receipt',
    detect: (s) => (RET_RE.test(s) ? { rows: s.split(RET_RE).length - 1, of: s.split('\n').length } : null),
    clean: (s) => s.replace(/[ \t]*[\u23ce\u21b5][ \t]*/g, '\n'),
  },
  {
    key: 'ellipsis',
    label: '续断标记 `…` 或 `...`',
    layer: 'caller',
    role: 'content',
    detect: (s) => {
      const uni = (s.match(UNI_ELLIPSIS_RE) ?? []).length
      const ascii = (s.match(/\.\.\./g) ?? []).length
      const asciiCont = ASCII_DOTS_RE.test(s) ? ascii : 0
      return uni + asciiCont > 0 ? { uni, ascii: asciiCont, of: s.split('\n').length } : null
    },
    clean: (s) => s.replace(UNI_ELLIPSIS_RE, '').replace(ASCII_DOTS_G, '$1$2'),
  },
  {
    key: 'receipt_prose',
    label: '回执说明文本（`(N more chars withheld)` 等）',
    layer: 'tool',
    role: 'receipt',
    detect: (s) => (RECEIPT_PROSE_RE.test(s) ? { rows: 1, of: s.split('\n').length } : null),
    clean: (s) => s.replace(RECEIPT_PROSE_G, ''),
  },
  {
    key: 'zero_width',
    label: '零宽 / 不可见字符',
    layer: 'tool',
    role: 'receipt',
    detect: (s) => {
      const m = s.match(ZERO_WIDTH_G)
      return m ? { count: m.length, of: s.split('\n').length } : null
    },
    clean: (s) => s.replace(ZERO_WIDTH_G, ''),
  },
  {
    key: 'lookalike',
    label: '全角同形异码（`：` `（` `，` 等）',
    layer: 'caller',
    role: 'content',
    detect: (s) => {
      const m = s.match(LOOKALIKE_G)
      return m ? { count: m.length, of: s.split('\n').length } : null
    },
    clean: (s) => s.replace(LOOKALIKE_G, (c) => LOOKALIKE_MAP[c] ?? c),
  },
  {
    key: 'receipt_wrap',
    label: '引文首尾带回执的弯引号 `“ ”`',
    layer: 'tool',
    role: 'receipt',
    detect: (s) => (WRAP_OPEN_RE.test(s) || WRAP_CLOSE_RE.test(s) ? { rows: 1, of: s.split('\n').length } : null),
    clean: (s) => s.replace(WRAP_OPEN_RE, '').replace(WRAP_CLOSE_RE, ''),
  },
  {
    key: 'eol_mismatch',
    label: '行尾与原文不一致（CRLF ↔ LF）',
    layer: 'tool',
    role: 'receipt',
    detect: (s, ctx) => {
      const src = ctx?.source
      if (typeof src !== 'string' || src.length === 0) return null
      const q = /\r\n/.test(s)
      const a = /\r\n/.test(src)
      return q === a ? null : { quoteCRLF: q, sourceCRLF: a }
    },
    clean: (s, ctx) => {
      const src = ctx?.source ?? ''
      return /\r\n/.test(src) ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n')
    },
  },
  {
    key: 'rows_vs_range',
    label: '引文行数 ≠ 它声称的区间行数',
    layer: 'design',
    role: 'content',
    skipSource: true,
    detect: (s, ctx) => {
      const rng = claimedRange(ctx?.hunk)
      if (!rng) return null
      const rows = s.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '').split('\n').length
      const claim = rng[1] - rng[0] + 1
      // 方向有意义：引文比区间**短**只是取了片段（旧契约允许），比区间**长**才永远对不上。
      return rows === claim ? null : { rows, claim, range: rng, dir: rows < claim ? 'short' : 'long' }
    },
    // 剥掉就是凭空造原文 —— 不可去污，只报计数（这条判定为 `design`，不是污染）。
    clean: null,
  },
]

/**
 * 逐类判定 —— **手写**，但每一句都必须指回上面的读数或指回可从语料里逐条复核的现场。
 *
 * 分三类：`工具侧可修` / `调用方侧` / `语料伪影`（外加「按设计」与「本语料无实例」）。
 * 判据不是「这个形态像不像污染」，而是「剥了它到底有没有用」——
 * 全角冒号那一行就是反面教材：命中 41 条，一剥反倒洗坏 22 条本来就 ok 的。
 *
 * **C53：每一条改成 `(R) => ({ who, why, layer })`**，里面的数字全部从这一趟的读数（`R`）里取。
 * 理由就是本单的题目：原先那些数字（0/174、1/174、41、5、6、39、22、74/49）是**手抄**的，
 * 入口一换（五格→六格）、分母就变了，而手抄的那份不会自己跟着走 —— 屏幕上一行写
 * 「残余 fail 命中 37」，下一行写「41 条命中看着最高」，读者得先判断哪个可信。
 * 换成函数后，散文与同一行的读数**共用一个来源**，漂移在结构上不可能发生。
 * 数字都是读数，判定（谁该修、算不算污染）仍然是手写的 —— 这两件事不能混。
 */
const VERDICTS = {
  lineno_prefix: (R) => ({
    who: `本语料无实例（0/${R.failN}）——不是这批残余的病因`,
    why: `${R.allN} 条引文里一条都没有 \`数字: \` 行首前缀。但它仍是**最值得加防线**的形态：行号前缀只能来自读回执，且一旦整块抄走就必然失配，代价为 0。`,
    layer: '读回执的渲染层（`aura_read` 的行号前缀）：若要保持可抄，应在回执里显式声明「行号前缀不属于文件内容」，或另给一段无前缀的原文块。本单量不到收益（命中 0），不建议现在动。',
  }),
  ret_newline: (R) => ({
    who: `工具侧可修，且已实测复现（${R.formFail('ret_newline')}/${R.failN}）`,
    why: `F0275 的引文是回执里那句 \`the content there is: “import fs …⏎import path …”\` 的整块拓回：4 行 import 被回执渲染成一行、用 \`⏎\` 连接，抄进 \`expect\` 后是**单行字符串**，原文里永远没有。把 \`⏎\` 还原成换行后该条当场命中（fail ${R.fail}→${R.cleanFail} 就是它）。`,
    layer: `错误回执的**引文渲染层**（\`aura-edit\` / \`aura-read\` 的错误文案）：机器可能原样复用的那段文本，换行必须是真换行；\`⏎\` 只能出现在「给人看的摘要」里，并且要标明不可回抄。注意 \`⏎\` 在本仓库也是正文（${R.sourceRet} 条重放原文、${R.successRet} 条成功引文带它），不能一律当污染。`,
  }),
  ellipsis: (R) => ({
    who: '调用方侧（引文是自己截断/省略过的）',
    why: `${R.formFail('ellipsis')} 条带续断标记；剥掉后续断处拼接的是两段不相邻的原文，结构上不可能命中，所以洗活 0。这不是回执弄脏的：\`…\`/\`...\` 是调用方（或它所抄的工具输出字段）自己的省略。`,
    layer: null,
  }),
  receipt_prose: (R) => ({
    who: `工具侧可修，但本语料在引文侧无实例（0/${R.failN}）`,
    why: '引文里一条都没有 `(N more chars withheld)` 这类回执说明。源侧唯一那条命中（F0446）是词表假阳性——那是一段写着 `(N chars withheld)` 的**函数注释**，不是回执残渣。',
    layer: '读回执的截断说明：若截断说明与内容同处一段可复制的文本里，调用方会把说明当内容。量不到收益，但同 `lineno_prefix` —— 防线代价为 0。',
  }),
  zero_width: (R) => ({
    who: `本语料无实例（0/${R.failN}）`,
    why: '引文与重放原文里都没有零宽/不可见字符（NBSP、U+200B…U+FEFF）。这条假说在这份语料上不成立。',
    layer: null,
  }),
  lookalike: (R) => ({
    who: '调用方/正文侧，**不是**污染',
    why: `${R.formFail('lookalike')} 条命中看着最高，但把 \`：\`→\`:\` 一洗，fail 反而 ${R.fail}→${R.allFormsFail}，还把 ${R.broken} 条原本 ok 的洗坏；${R.formAll('lookalike')} 条里 ${R.lookFaithful} 条的全角字符在重放原文里同样存在。全角冒号是中文正文，不是回执引入的。`,
    layer: null,
  }),
  receipt_wrap: (R) => ({
    who: `本语料无实例（0/${R.failN}）——不是这批残余的病因`,
    why: '错误回执把原文包在弯引号 `“”` 里；引文首尾带弯引号的 0 条。调用方拓回时没有把引号一起带上。',
    layer: '回执渲染层（同 `lineno_prefix`）：弯引号是回执的包装物，不应与内容混在同一段可复制文本里。',
  }),
  eol_mismatch: (R) => ({
    who: '语料伪影（夹具把 CRLF 归一成了 LF）',
    why: `${R.formFail('eol_mismatch')} 条引文带 \`\\r\\n\` 而重放原文是全 LF；洗成 LF 后洗活 0。逐条看 F0233：那份原件是 Windows 上的 PowerShell 源，引文的 CRLF 是**忠实**的，是 \`log\` 快照那一侧把行尾归一了。这算夹具的账，不算回执的账。`,
    layer: null,
  }),
  rows_vs_range: (R) => ({
    who: '调用方侧（引文与它声称的区间不是一回事）；且不可去污',
    why: `残余 fail 里 ${R.formFail('rows_vs_range')} 条（${pct(R.formFail('rows_vs_range'), R.failN)}），成功集里只有 ${R.successRows} 条（${pct(R.successRows, R.successQuoted)}）—— 相差 ${R.rowsRatio} 倍，是很强的**相关量**，但它不是污染：没有哪种「洗法」能把引文洗成区间原文而不凭空造文本。引文比区间短是旧契约允许的片段寻址，只有「比区间长」才是结构上永远对不上。`,
    layer: null,
  }),
}

const CLEANABLE = FORMS.filter((f) => typeof f.clean === 'function')
/**
 * 「回执渲染类」形态：这些字符**原文里不会有**（除源侧同病），洗掉它们是保意的。
 * 与 `role: 'content'` 那些分开，是本单踩过的一个真坑：全角冒号在引文里 37 条命中（本期读数），
 * 一洗之下 fail 反而从 147 涨到 170、22 条**原本 ok** 的被洗坏 —— 因为原文自己就是全角。
 * 所以「全洗」只能当**反面对照**，不能当去污读数。
 */
const RECEIPT_FORMS = FORMS.filter((f) => f.role === 'receipt' && typeof f.clean === 'function').map((f) => f.key)
const CONTENT_FORMS = CLEANABLE.filter((f) => f.role !== 'receipt').map((f) => f.key)

// ── 2. 小工具 ──────────────────────────────────────────────────────────────

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by
}
const pct = (a, b) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`)
function sha256Full(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  } catch {
    return null
  }
}
function sha256File(p) {
  return sha256Full(p)?.slice(0, 12) ?? null
}
function width(s) {
  let w = 0
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return w
}
function pad(s, n) {
  const t = String(s)
  return t + ' '.repeat(Math.max(0, n - width(t)))
}
function padL(s, n) {
  const t = String(s)
  return ' '.repeat(Math.max(0, n - width(t))) + t
}
const listIds = (ids, cap = 12) => (ids.length <= cap ? ids.join(', ') : `${ids.slice(0, cap).join(', ')} …共 ${ids.length} 条`)

/**
 * 六格的显示口径：**一个函数盖住全部打印点**（键名/格子数的事故只可能发生在 OUTCOME 上）。
 * 带 `already_applied`（第四态）—— C53 从上游接回来的那一格。
 */
const CELL_KEYS = ['ok', 'fail', 'needs_choice', 'already_applied', 'unrepresentable', 'na']
const CELL_LABEL = { ok: 'ok', fail: 'fail', needs_choice: '需选择', already_applied: '已落地', unrepresentable: '无从表达', na: '无入口' }
const cellLine = (b) => CELL_KEYS.map((k) => `${CELL_LABEL[k]} ${b[k] ?? 0}`).join(' / ')
/** 把换行/制表显形，供屏幕与 JSON 里贴原始读数用。 */
const clip = (s, cap = 120) => {
  const flat = String(s).replace(/\r/g, '\\r').replace(/\n/g, '\u23ce').replace(/\t/g, '\\t')
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…(+${flat.length - cap})`
}

/** 引文声称的区间（`lines:[a,b]` 或 `start_line`/`end_line`）。 */
function claimedRange(hunk) {
  if (!hunk || typeof hunk !== 'object') return null
  if (Array.isArray(hunk.lines) && hunk.lines.length >= 1) {
    const a = Number(hunk.lines[0])
    const b = hunk.lines.length > 1 ? Number(hunk.lines[1]) : a
    return Number.isFinite(a) ? [a, Number.isFinite(b) ? b : a] : null
  }
  const a = Number(hunk.start_line)
  if (!Number.isFinite(a)) return null
  const b = Number(hunk.end_line)
  return [a, Number.isFinite(b) ? b : a]
}

/** 与 `failure-replay.focusIndexOf` 同一件事：聚焦 hunk 全场只有一份。 */
function focusIndexOf(hunks) {
  for (const key of ['expect', 'anchor', 'line_cue']) {
    const i = hunks.findIndex((h) => typeof h?.[key] === 'string' && h[key].length > 0)
    if (i >= 0) return i
  }
  const t = hunks.findIndex((h) => typeof h?.target === 'string' && h.target.trim().length > 0)
  return t >= 0 ? t : 0
}

/** 与 `failure-replay.quoteOfHunk` 同一件事：`expect` 优先，再看锚点与线索。 */
function quoteOfHunk(h) {
  if (!h || typeof h !== 'object') return null
  for (const key of ['expect', 'anchor', 'line_cue']) {
    if (typeof h[key] === 'string' && h[key].length > 0) return { kind: key, text: h[key] }
  }
  if (typeof h.target === 'string' && h.target.trim().length > 0) return { kind: 'target', text: h.target }
  return null
}

/** 成功集条目的引文（那份语料没存 `quote`，按同一把尺子从 hunks 里取）。 */
function quoteOfEntry(entry) {
  const hunks = Array.isArray(entry.hunks) ? entry.hunks : []
  if (hunks.length === 0) return null
  return quoteOfHunk(hunks[focusIndexOf(hunks)])
}

// ── 3. 污染普查（引文侧 + 源侧） ────────────────────────────────────────────

/**
 * 对一组条目做污染普查。`getText` 取引文，`getSource` 取重放原文（有的形态要用它判真伪：
 * 原文本来就是全角冒号的，那叫**忠实**，不叫污染）。
 */
function census(items, getText, getSource, skipKeys = []) {
  const per = {}
  for (const f of FORMS) per[f.key] = { count: 0, ids: [], samples: [], dirs: {} }
  const anyIds = []
  for (const item of items) {
    const text = getText(item)
    if (typeof text !== 'string' || text.length === 0) continue
    const ctx = { source: getSource(item), hunk: item.hunk ?? null }
    let dirty = false
    for (const f of FORMS) {
      if (skipKeys.includes(f.key)) continue
      const d = f.detect(text, ctx)
      if (!d) continue
      dirty = true
      const slot = per[f.key]
      slot.count += 1
      if (slot.ids.length < 400) slot.ids.push(item.id)
      if (slot.samples.length < 6) slot.samples.push({ id: item.id, text: clip(text, 150), detail: d })
      if (d.dir) bump(slot.dirs, d.dir)
    }
    if (dirty) anyIds.push(item.id)
  }
  return { per, anyIds }
}

// ── 4. 记账适配层：重放本身走**上游那一个导出**（C53 起不再复刻） ──────────────

/**
 * 与 `failure-replay.stageToolCopy` 同一件事：把这一趟要重放的原文摊到临时目录的**可写**副本上。
 *
 * 上游不导出摊副本那一步（它只是四行 I/O），所以本文件保留这一小段 —— 与其余三件普查件
 * （`residual-census` / `address-form-census` / `already-applied-census`）逐字同形。
 * 它是**记账**，不是判据层：怎么把引文变成地址、什么叫 ok / 需选择 / 已落地，一律在
 * `replayNewContract` 里，这里一个字都不另写。
 *
 * 「写 + 读回」这一步是有意的：引擎入口拿到的是**副本路径**，读回来的字节才是引擎真正
 * 看到的字节（BOM / 行尾的差别都在这一步定形）。扩展名照抄语料里那份文件的（引擎可能按扩展名决定读法）。
 */
function stageToolCopy(text, tmpDir, name) {
  const toolPath = path.join(tmpDir, name)
  fs.writeFileSync(toolPath, text, 'utf8')
  return { toolPath, content: fs.readFileSync(toolPath, 'utf8') }
}

/**
 * 一条条目在本探针里的归属：**与上游同一个函数**（`replayNewContract`）。
 *
 * 本函数只补三种**记账**归属，与上游主循环逐条同形（`failure-replay` 主循环里那段
 * `if (!engine.ready) … else if (entry.tool === 'aura_read') … else replayNew(…)`）：
 *   · 引擎未就绪 ⇒ `unrepresentable`（`NOT_READY`）；
 *   · 读路径（`aura_read`）没有 old/context 入口 ⇒ `na`（`READ_PATH`）；
 *   · 没有引文可引 ⇒ `unrepresentable`（`NO_QUOTE`）。
 * 其余四格（ok / fail / 需选择 / **已落地 already_applied**）全归上游那一个导出 ——
 * 于是「本探针的分桶」与「上游那一列的分桶」在结构上不可能分叉：
 * 判据①拿读数逐格对账，判据⑯拿源码静态盯住这个入口没被换回本地复刻。
 */
async function replayNew(entry, content, old, ready, toolPath) {
  const idle = { address: null, attempts: [], writes: 0, diskChanged: false }
  if (!ready) return { outcome: OUTCOME.unrepresentable, code: 'NOT_READY', ...idle }
  if (entry.tool === 'aura_read') return { outcome: OUTCOME.na, code: 'READ_PATH', ...idle }
  if (!old) return { outcome: OUTCOME.unrepresentable, code: 'NO_QUOTE', ...idle }
  return replayNewContract({ entry, content, old, toolPath })
}

/**
 * 一趟重放：`transform(entry)` 给出这一趟要用的引文与原文（默认就是原件）。
 * 返回分桶、逐条结果与 fail 编号表。
 *
 * 六格（与上游 `failure-replay` 主线程同形）：ok / fail / needs_choice / **already_applied** /
 * unrepresentable / na —— 六格之和恒等于这一趟重放的条数。
 */
async function runPass(entries, tmpDir, tag, transform, ready) {
  const buckets = { ok: 0, fail: 0, needs_choice: 0, already_applied: 0, unrepresentable: 0, na: 0 }
  const fails = []
  const oks = []
  /** 编号→该条的态（C53）：六格下的迁移分析（「除 fail→ok 外没别的迁移进出 fail 格」）要用它。 */
  const outcomes = new Map()
  let dirty = 0
  /**
   * **一次重放一份自己的副本**（路径不复用）—— 这不是讲究，是正确性：
   *
   * `applyEditToProvider` 里有一本**按 `displayPath` 记账**的观测账本（`regionGate` 读
   * `latestObservation(displayPath)` 判「当前内容是不是刚观测过的那一份」）。路径一旦被两条
   * 条目复用，账本里那条观测就是**别人的**内容，闸门会把一次本来会命中的编辑当成 stale 拒掉。
   * 实测（C53 第一次跑就撞上）：按内容缓存、复用路径 ⇒ ok 143 掉成 134，9 条从 ok 变
   * fail / 需选择（F0165 / F0308–F0311 / F0324 / F0325 / F0327 / F0329）—— 逐格对账当场就能看见。
   * 上游用的也是「每条一份」（`${entry.id}.tool${ext}`）；这里再带上趟名，让十三趟互不相干。
   *
   * 代价：十三趟 × 353 条 ≈ 4589 份小文件，全在 `os.tmpdir()` 的一个临时目录里，跑完即删。
   */
  for (const entry of entries) {
    const t = transform ? transform(entry) : { old: entry.quote?.text ?? null, source: entry.source.text }
    if (t.old !== (entry.quote?.text ?? null) || t.source !== entry.source.text) dirty += 1
    const ext = path.extname(entry.file) || '.txt'
    const { toolPath, content } = stageToolCopy(t.source, tmpDir, `${entry.id}.${tag}${ext}`)
    const res = await replayNew(entry, content, t.old, ready, toolPath)
    buckets[res.outcome] += 1
    outcomes.set(entry.id, res.outcome)
    if (res.outcome === OUTCOME.ok) oks.push(entry.id)
    if (res.outcome === OUTCOME.fail) fails.push({ id: entry.id, code: res.code })
  }
  return { buckets, fails, oks, outcomes, transformed: dirty, sum: Object.values(buckets).reduce((a, b) => a + b, 0) }
}

/**
 * 一键：把指定形态的检测器对应的清洗器套上去。`keys` 为空 = 全剥。
 *
 * **恒等对照从哪来**：本函数在 `keys` 为空数组时逐形态 `continue`，返回的就是 `{old: 原件, …}` ——
 * 什么也没动。C36 的自证（判据「恒等对照必须真的等于原件」+「恒等对照必须让主读数有变化」）
 * 就靠这条路径：若哪天去污层退化成恒等，主去污趟与恒等趟的读数会**重合**，自证当场红。
 */
function cleanerFor(keys) {
  return (entry) => {
    const old = entry.quote?.text ?? null
    if (old === null) return { old: null, source: entry.source.text }
    let text = old
    for (const f of CLEANABLE) {
      if (keys && !keys.includes(f.key)) continue
      if (!f.detect(text, { source: entry.source.text, hunk: focusHunkOf(entry) })) continue
      text = f.clean(text, { source: entry.source.text, hunk: focusHunkOf(entry) })
    }
    return { old: text, source: entry.source.text }
  }
}
/**
 * 重放原文侧的同一套清洗：**只洗「回执渲染类」**。源本身是回执渲染出来的副本时，
 * 它自己就带着 `⏎` / 行号前缀 / 截断说明 —— 那种形态在源里出现，是**夹具的账**。
 * 全角与续断不动：源里的它们是正文（中文标点、文档里的省略号）。
 */
function cleanSource(src) {
  let out = src.replace(/[ \t]*[\u23ce\u21b5][ \t]*/g, '\n')
  out = out.split('\n').map((r) => r.replace(LINENO_RE, '$2')).join('\n')
  out = out.replace(RECEIPT_PROSE_G, '')
  out = out.replace(ZERO_WIDTH_G, '')
  return out
}

const focusHunkOf = (entry) => (entry.hunks ?? [])[entry.focus ?? 0] ?? null

// ── 5. 主流程 ──────────────────────────────────────────────────────────────

async function main() {

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--json', '--show', '--success'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/quote-hygiene.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const show = Number((argv.find((a) => a.startsWith('--show=')) ?? '--show=0').slice(7)) || 0
  const successArg = (argv.find((a) => a.startsWith('--success=')) ?? '').slice(10)

  const digestsBefore = Object.fromEntries(ENGINE_MODULE_SET.map((m) => [m, sha256File(pkgPath('src', 'locator-lab', m))]))
  const corpusBytes = fs.readFileSync(CORPUS_PATH)

  const corpusDigest = crypto.createHash('sha256').update(corpusBytes).digest('hex').slice(0, 12)
  const corpus = JSON.parse(corpusBytes.toString('utf8'))
  const engine = probeEngineOldContract()

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-c33-hygiene-'))
  let baseline
  let quoteCensus
  let passes
  let attr
  let sourceCensus
  let success
  let lookalikeFaithful = []
  /** 恒等对照趟（C36 自证用）：见 cleanerFor 的注释。 */
  let identityPass
  /** 主去污趟里**原本 ok、却被洗成 fail** 的条目（期望恰好为空集）。 */
  let qBroken = []
  /** 「≥6 连续空行」的条目集（= 重放原文被抹掉一大片的那种）；④ 要用。 */
  let blankRunSet = new Set()
  try {
    const replayable = corpus.entries.filter((e) => e.replayable && e.source)
    replayableCount = replayable.length
    // 普查的条目一律带上它的聚焦 hunk：`rows_vs_range` 这类判据要用「引文声称的区间」，
    // 而那个区间只在 hunk 里。复刻时漏带过一次，那一行的计数整整齐齐全是 0。
    const withQuote = corpus.entries
      .filter((e) => typeof e.quote?.text === 'string' && e.quote.text.length > 0)
      .map((e) => ({ id: e.id, hunk: focusHunkOf(e), entry: e }))

    // ── 基准趟 ──
    baseline = await runPass(replayable, tmpDir, 'base', null, engine.ready)
    const failIds = baseline.fails.map((f) => f.id)
    const failSet = new Set(failIds)

    // ── ① 污染普查 ──
    const qText = (x) => x.entry.quote.text
    const qSource = (x) => x.entry.source?.text ?? null
    quoteCensus = {
      all: census(withQuote, qText, qSource),
      fail: census(withQuote.filter((x) => failSet.has(x.id)), qText, qSource),
      allN: withQuote.length,
      failN: withQuote.filter((x) => failSet.has(x.id)).length,
    }
    /** 全角同形异码的「忠实度」：重放原文自己也用全角的有多少条 —— 那是正文，不是污染。 */
    lookalikeFaithful = withQuote.filter((x) => {
      if (!LOOKALIKE_RE.test(x.entry.quote.text)) return false
      const src = x.entry.source?.text ?? ''
      const chars = x.entry.quote.text.match(LOOKALIKE_G) ?? []
      return chars.every((c) => src.includes(c))
    })

    // ── ② 去污后重测 ──
    passes = {}
    // A：只洗引文，且只洗**回执渲染类**形态（保意的那些）。
    passes.quoteSide = await runPass(replayable, tmpDir, 'q', cleanerFor(RECEIPT_FORMS), engine.ready)
    // B：引文与重放原文一起洗（源侧同病 —— 源本身是回执渲染出来的副本时才有意义）。
    passes.bothSides = await runPass(
      replayable,
      tmpDir,
      'qs',
      (entry) => ({ old: cleanerFor(RECEIPT_FORMS)(entry).old, source: cleanSource(entry.source.text) }),
      engine.ready,
    )
    // C：**反面对照** —— 连「已证忠实」的形态（全角、续断）也一起洗。
    //    它预期会让读数变差；若它也让 fail 变少，才说明那些形态其实也是污染。
    passes.allForms = await runPass(replayable, tmpDir, 'qall', cleanerFor([...RECEIPT_FORMS, ...CONTENT_FORMS]), engine.ready)
    // D：**恒等对照**（C36 自证）。`transform: null` ⇒ runPass 直接取原件，连 cleanerFor 都不进；
    //    与基准趟走的是同一段代码、同一批副本 —— 于是「对照真的没动东西」
    //    与「主去污趟真的动了东西」是同一把尺子量出来的，不是各量各的。
    //    它同时是 cleanerFor 注释里那条恒等路径的**活体副本**：若去污层哪天退化成恒等，
    //    主去污趟与它的读数会重合，自证判据当场红。
    passes.identity = await runPass(replayable, tmpDir, 'ident', null, engine.ready)

    // ── 逐形态归因：只剥这一种 ──
    attr = {}
    for (const f of CLEANABLE) {
      const p = await runPass(replayable, tmpDir, `a_${f.key}`, cleanerFor([f.key]), engine.ready)
      const flipped = baseline.fails.map((x) => x.id).filter((id) => p.oks.includes(id))
      attr[f.key] = { buckets: p.buckets, fails: p.fails.length, fixed: flipped.length, fixedIds: flipped, transformed: p.transformed }
    }

    // ── ④ 源侧污染普查 ──
    sourceCensus = census(
      replayable.map((e) => ({ id: e.id, source: e.source.text, hunk: focusHunkOf(e) })),
      (e) => e.source,
      () => null,
      ['rows_vs_range'],
    )
    blankRunSet = new Set(replayable.filter((e) => /\n(?:[ \t]*\n){5,}/.test(e.source.text)).map((e) => e.id))
    const byKind = {}
    for (const e of replayable) {
      const k = e.source.kind
      byKind[k] ??= { n: 0, blank: 0, ret: 0, prose: 0 }
      byKind[k].n += 1
      if (/\n(?:[ \t]*\n){5,}/.test(e.source.text)) byKind[k].blank += 1
      if (RET_RE.test(e.source.text)) byKind[k].ret += 1
      if (RECEIPT_PROSE_RE.test(e.source.text)) byKind[k].prose += 1
    }
    sourceCensus.byKind = byKind

    // ── ⑤ 成功集对照 ──
    success = loadSuccessCorpus(successArg)
    if (success) {
      const items = success.entries
        .map((e) => ({ id: e.id, quote: quoteOfEntry(e), hunk: (e.hunks ?? [])[focusIndexOf(e.hunks ?? [])] ?? null, entry: e }))
        .filter((x) => x.quote && typeof x.quote.text === 'string' && x.quote.text.length > 0)
      success.census = census(items, (x) => x.quote.text, (x) => x.entry.sourceText ?? null)
      success.quoted = items.length
      success.byKind = {}
      for (const x of items) bump(success.byKind, x.quote.kind)
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响读数 */
    }
  }
  const digestsAfter = Object.fromEntries(ENGINE_MODULE_SET.map((m) => [m, sha256File(pkgPath('src', 'locator-lab', m))]))
  const engineUnchanged = ENGINE_MODULE_SET.every((m) => digestsBefore[m] === digestsAfter[m])


  // ── 对账 ──
  const mismatches = Object.keys(BASELINE).filter((k) => baseline.buckets[k] !== BASELINE[k])
  const reconciled = mismatches.length === 0

  // ── 打印 ──
  const L = (...a) => console.log(...a)
  // C40：先算**自己** —— 「这个文件现在是不是还原到位了」要能一眼核对（尤其是刚做完变异反证），
  // 所以自身 sha256、三个钉死常量的当前值与常量指纹都摆在读数最前面。三行对账口径写死在下面：
  //   · sha256 必须 = 回执（.polaris/workorders/fs-contract-v2.C40.result.json）里的 finalSha256；
//   · 三个常量必须 = 147 / 146 / ["F0275"]（C53 实测值；见 EXPECT / EXPECT_PIN_FINGERPRINT）；
  //   · 常量指纹必须 = EXPECT_PIN_FINGERPRINT。
  // 三条全合 = 绿态原件；只要有一条不合 = 停在变异态/半还原态（下面的第 14/15 条判据会一并点名）。
  const selfBytes = SELF_BYTES
  const selfSha = crypto.createHash('sha256').update(selfBytes).digest('hex')
  L('')
  L('=== C33 引文污染量化与去污重测 ===')
  L(`  自身：${path.relative(REPO, SELF_PATH)}  字节=${selfBytes.length}  sha256=${selfSha}`)
  L(`        sha256_16=${selfSha.slice(0, 16)}  ← 与回执的 finalSha256 比：不等 = 这个文件被改过`)
  L(
    `  钉死常量：baselineFail=${PINNED.baselineFail}  cleanFail=${PINNED.cleanFail}  washedIds=${JSON.stringify(PINNED.washedIds)}  →  ${PINNED.baselineFail} - ${PINNED.washedIds.length} = ${PINNED.suggestedCleanFail} ${PINNED.consistent ? '自洽 ✓' : `**不自洽 ✗（建议 cleanFail = ${PINNED.suggestedCleanFail}）**`}`,
  )
  L(`  常量指纹：${PINNED.fingerprint}${PINNED.fingerprint === EXPECT_PIN_FINGERPRINT ? '（= 交付时记录，未漂移 ✓）' : `（≠ 交付时记录的 ${EXPECT_PIN_FINGERPRINT} ✗：三个常量里至少一个被改过）`}`)
  L(`  语料：aura-tools/src/locator-lab/failure-corpus.json  sha256_16=${corpusDigest}  entries=${corpus.entries.length}  可重放=${baseline.sum}`)
  L(`  引擎：现树 ${engine.ready ? '就绪' : '未就绪'} —— ${engine.how}`)
  L('')
  L('── 基准对账（同一份入口 replayNewContract vs failure-replay 主线程六格读数） ──')
  L(`  本次：${cellLine(baseline.buckets)}`)
  L(`  期望：${cellLine(BASELINE)}  ${reconciled ? '逐格一致 ✓' : `不一致 ✗（${mismatches.map((k) => CELL_LABEL[k] ?? k).join(', ')}）`}`)
  L(
    `  分桶之和 ${baseline.sum} = 可重放条数 ${replayableCount} ${baseline.sum === replayableCount ? '✓' : '✗'}（六格之和 ${Object.values(BASELINE).reduce((a, b) => a + b, 0)}）`,
  )

  L('')
  L('── ① 污染形态分布（引文侧） ──')
  L(`  ${pad('形态', 40)}${padL('全部引文', 10)}${padL('占比', 9)}${padL('残余 fail', 10)}${padL('占比', 9)}`)
  for (const f of FORMS) {
    const a = quoteCensus.all.per[f.key]
    const b = quoteCensus.fail.per[f.key]
    L(
      `  ${pad(f.label, 40)}${padL(a.count, 10)}${padL(pct(a.count, quoteCensus.allN), 9)}${padL(b.count, 10)}${padL(pct(b.count, quoteCensus.failN), 9)}`,
    )
  }
  L(
    `  分母：有引文的条目 ${quoteCensus.allN} 条（= 语料 450 里 quote.text 非空的）；其中落在残余 fail 里的 ${quoteCensus.failN} 条`,
  )
  L(`  「至少带一种形态」的引文：全部 ${quoteCensus.all.anyIds.length} 条（${pct(quoteCensus.all.anyIds.length, quoteCensus.allN)}）｜残余 fail ${quoteCensus.fail.anyIds.length} 条（${pct(quoteCensus.fail.anyIds.length, quoteCensus.failN)}）`)
  L(`  ⤷ 「带形态」≠「污染」：全角同形异码命中 ${quoteCensus.all.per.lookalike.count} 条，其中 ${lookalikeFaithful.length} 条用到的全角字符在**重放原文里同样存在**（中文正文而已）。`)
  L(
    `  ⤷ 同样地，字面量 \`⏎\` 在本仓库既是回执的渲染物、也是**正文**：重放原文里 ${sourceCensus.per.ret_newline.count} 条用它当分隔符/文档例子，成功集里还有 ${success ? success.census.per.ret_newline.count : 0} 条引文带它且**逐字命中**。所以光靠「含有」判不了，判据只能是②的洗后能否命中。`,
  )
  L(
    `  ⤷ 行数≠区间行数的方向：比区间短的（取了片段，旧契约允许）${quoteCensus.all.per.rows_vs_range.dirs.short ?? 0} 条，比区间长的（结构上永远对不上）${quoteCensus.all.per.rows_vs_range.dirs.long ?? 0} 条；残余 fail 里分别是 ${quoteCensus.fail.per.rows_vs_range.dirs.short ?? 0} / ${quoteCensus.fail.per.rows_vs_range.dirs.long ?? 0} 条。`,
  )
  L('  ⤷ 词表本身会假阳性，已逐条标出：`chars withheld` 这套词表在**本仓库自己的源码里**就有 —— ④ 里源侧唯一那条命中')
  L('     （F0446）是一条写着 `"…" (N chars withheld)` 的**函数注释**，不是回执残渣。错误回执那句 `do not match assert` 同理：')
  L('     本仓库正文里就有人讨论它（成功集 S0672 的引文是一段蓝图正文），所以它**没进词表**（进去当场多一个假阳性）。')
  L('     结论：「字面命中」不等于「回执弄脏了」—— 本单的判定一律以②的洗后能否命中为准，不以词表命中为准。')
  if (show > 0) {
    for (const f of FORMS) {
      const s = quoteCensus.fail.per[f.key].samples.slice(0, show)
      if (s.length === 0) continue
      L(`    · ${f.key}（残余 fail 里 ${quoteCensus.fail.per[f.key].count} 条）`)
      for (const x of s) L(`        ${x.id}  ${JSON.stringify(x.text)}`)
    }
  }

  L('')
  L('── ② 去污后重测（同一份重放器、同一批副本） ──')
  L(
    `  ${pad('变体', 40)}${padL('ok', 6)}${padL('fail', 6)}${padL('需选择', 8)}${padL('已落地', 8)}${padL('无从表达', 10)}${padL('无入口', 8)}${padL('改了引文', 10)}`,
  )
  const row = (name, p) =>
    L(
      `  ${pad(name, 40)}${padL(p.buckets.ok, 6)}${padL(p.buckets.fail, 6)}${padL(p.buckets.needs_choice, 8)}${padL(p.buckets.already_applied, 8)}${padL(p.buckets.unrepresentable, 10)}${padL(p.buckets.na, 8)}${padL(p.transformed, 10)}`,
    )
  row('去污前（原件）', baseline)
  row('去污后 A：只洗引文（回执渲染类）', passes.quoteSide)
  row('去污后 B：引文＋重放原文一起洗', passes.bothSides)
  row('反面对照 C：连忠实形态也一起洗', passes.allForms)
  L('')
  L(
    `  **去污前 fail ${baseline.buckets.fail} 条 → 去污后 fail ${passes.quoteSide.buckets.fail} 条（Δ ${passes.quoteSide.buckets.fail - baseline.buckets.fail}）**`,
  )
  L(
    `  引文＋原文一起洗（源侧同病）：fail ${passes.bothSides.buckets.fail} 条（Δ ${passes.bothSides.buckets.fail - baseline.buckets.fail}）；ok ${baseline.buckets.ok} → ${passes.bothSides.buckets.ok}`,
  )
  L(
    `  反面对照 C（把全角/续断也洗掉）：ok ${baseline.buckets.ok} → ${passes.allForms.buckets.ok}、fail ${baseline.buckets.fail} → ${passes.allForms.buckets.fail} —— **读数变差**，即那些形态不是污染，而是与原文一致的内容`,
  )
  const qFixed = baseline.fails.map((f) => f.id).filter((id) => passes.quoteSide.oks.includes(id))
  const bFixed = baseline.fails.map((f) => f.id).filter((id) => passes.bothSides.oks.includes(id))
  const broken = baseline.oks.filter((id) => !passes.allForms.oks.includes(id))
  qBroken = baseline.oks.filter((id) => !passes.quoteSide.oks.includes(id))
  const idLoss = baseline.oks.filter((id) => !passes.identity.oks.includes(id))
  /**
   * **六格下的「洗活」口径（C53 重述）**：
   *
   * 洗活集 = **基准趟落在 fail 格、去污趟落到 ok 格**的条目（`qFixed`，只从 `baseline.fails` 里取）。
   * 它等于 `baselineFail - cleanFail` 这件事，在五格时代是白给的（剩下四格不会动）；接上第四态
   * 之后要**量**：只要有一条 `already_applied` 被洗成 fail、或有一条 `needs_choice` 被洗进 fail，
   * Δ 就对不上，而 `cleanFail` 那条等式只会说「数字不符」，指不到迁移上。
   *
   * 所以这里把迁移逐条算出来：**除 fail→ok 之外，不允许有任何迁移进出 fail 格**。
   * 第四态那一格本期一格不动（27 → 27）—— 既没有被洗活、也没有被洗坏，这正是它该有的样子。
   */
  const baseOut = baseline.outcomes
  const cleanOut = passes.quoteSide.outcomes
  const enteredFail = [...cleanOut].filter(([id, o]) => o === OUTCOME.fail && baseOut.get(id) !== OUTCOME.fail).map(([id]) => id)
  const leftFailToOther = [...baseOut]
    .filter(([id, o]) => o === OUTCOME.fail && cleanOut.get(id) !== OUTCOME.fail && cleanOut.get(id) !== OUTCOME.ok)
    .map(([id]) => id)
  const NON_MAIN_CELLS = CELL_KEYS.filter((k) => k !== 'ok' && k !== 'fail')
  const otherCellsFlat = NON_MAIN_CELLS.every((k) => passes.quoteSide.buckets[k] === baseline.buckets[k])
  L(`  被洗活的条目（A：只洗引文）：${qFixed.length} 条 ${listIds(qFixed)}`)
  L(
    `  六格下的迁移：新进 fail 的 ${enteredFail.length} 条 ｜ 离开 fail 但不是去 ok 的 ${leftFailToOther.length} 条 ｜ 其余四格 ${otherCellsFlat ? '逐格不动' : '有变动'}（${NON_MAIN_CELLS.map((k) => `${CELL_LABEL[k]} ${baseline.buckets[k]}→${passes.quoteSide.buckets[k]}`).join('、')}）`,
  )
  L(`  被洗活的条目（B：引文＋原文）：${bFixed.length} 条 ${listIds(bFixed)}`)
  L(`  被反面对照 C 洗坏的条目（原本 ok）：${broken.length} 条 ${listIds(broken)}`)
  // 自证读数：恒等对照**必须原样复现基准**；主去污趟**必须**与它分叉。两者合起来证明
  // 「fail 147→146 是去污函数挣来的」，而不是基准对账白送的。
  L(
    `  恒等对照 D（去污函数原样放行）：ok ${passes.identity.buckets.ok} / fail ${passes.identity.buckets.fail}，改了引文 ${passes.identity.transformed} 条（= 基准）、洗活 ${baseline.fails.filter((f) => passes.identity.oks.includes(f.id)).length} 条、洗坏 ${idLoss.length} 条`,
  )
  L(
    `  ⤷ 自证：主去污趟与恒等对照的 fail 差 ${baseline.buckets.fail - passes.quoteSide.buckets.fail} 条、改了引文 ${passes.quoteSide.transformed} 条；**两者必须不等** —— 相等就是去污函数没做事，主判据恒真`,
  )

  L('')
  L('── ③ 逐形态归因（只剥这一种形态，其余不动；「洗完 fail」变大 = 洗过头了） ──')
  L(`  ${pad('形态', 40)}${padL('检出', 6)}${padL('洗完 fail', 10)}${padL('洗活', 6)}  洗活的条目`)
  for (const f of FORMS) {
    const a = attr[f.key]
    if (!a) {
      L(`  ${pad(f.label, 40)}${padL(quoteCensus.fail.per[f.key].count, 6)}${padL('—', 6)}${padL('—', 6)}  不可去污（剥掉就没有引文了）`)
      continue
    }
  L(
      `  ${pad(f.label, 40)}${padL(quoteCensus.fail.per[f.key].count, 6)}${padL(a.fails, 10)}${padL(a.fixed, 6)}  ${a.fixed > 0 ? listIds(a.fixedIds) : '（无）'}`,
    )
  }

  L('')
  L('── ④ 源侧污染普查（重放原文自己带没带这些形态；分母 = 可重放 353） ──')
  for (const f of FORMS) {
    const c = sourceCensus.per[f.key]
    if (c.count > 0) L(`  ${pad(f.label, 40)}${padL(c.count, 6)}  ${pct(c.count, baseline.sum)}  ${f.key === 'rows_vs_range' ? '' : listIds(c.ids, 8)}`)
  }
  L('  按来源分层（脚手架/日志快照里成片的空行 = 被抹掉的原文；这类原文不可能与引文逐字对上）：')
  L(`    ${pad('来源', 12)}${padL('条数', 6)}${padL('≥6 连续空行', 14)}${padL('带 ⏎', 8)}${padL('带回执说明', 12)}`)
  for (const [k, v] of Object.entries(sourceCensus.byKind ?? {})) {
    L(`    ${pad(k, 12)}${padL(v.n, 6)}${padL(v.blank, 14)}${padL(v.ret, 8)}${padL(v.prose, 12)}`)
  }
  L('')
  const blankAmongFails = baseline.fails.filter((f) => blankRunSet.has(f.id)).length
  L(
    `  「≥6 连续空行」在**残余 fail** 里的分布：${blankAmongFails}/${baseline.buckets.fail} 条（${pct(blankAmongFails, baseline.buckets.fail)}）｜在 ok 里：${baseline.oks.filter((id) => blankRunSet.has(id)).length}/${baseline.buckets.ok} 条`,
  )
  L('  读法：重放原文被抹成空行的地方，**原文已经不在语料里了** —— 引文对不上是夹具构造的必然结果，')
  L('  既不是回执弄脏的，也不是引擎没找到。这一类只能靠重建语料消，去污消不掉。')

  L('')
  L('── ⑤ 成功集对照（同一套检测） ──')
  if (!success) {
    L('  量不到：没有找到 success-regression 写出的成功集语料（候选路径都不存在）。')
  } else {
    L(`  语料：${success.path}`)
    L(`         mtime=${success.mtime}  字节=${success.bytes}  sha256_16=${success.sha}  条目=${success.entries.length}  有引文=${success.quoted}`)
    L(`         引文种类：${Object.entries(success.byKind).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    L(`  ${pad('形态', 40)}${padL('残余 fail', 10)}${padL('占比', 9)}${padL('成功集', 10)}${padL('占比', 9)}`)
    for (const f of FORMS) {
      const b = quoteCensus.fail.per[f.key]
      const s = success.census.per[f.key]
      L(
        `  ${pad(f.label, 40)}${padL(b.count, 10)}${padL(pct(b.count, quoteCensus.failN), 9)}${padL(s.count, 10)}${padL(pct(s.count, success.quoted), 9)}`,
      )
    }
    L(`  「至少带一种形态」的成功引文：${success.census.anyIds.length} 条（${pct(success.census.anyIds.length, success.quoted)}）`)
  }

  L('')
  L('── 逐类判定（判定跟读数走，不跟假设走） ──')
  /**
   * 逐类判定的**读数来源**（C53）：`VERDICTS` 里每一句里的数字都从这里取，
   * 与同一行印的读数同源 —— 散文与读数不会各说各的。
   */
  const RV = {
    failN: quoteCensus.failN,
    allN: quoteCensus.allN,
    fail: baseline.buckets.fail,
    cleanFail: passes.quoteSide.buckets.fail,
    allFormsFail: passes.allForms.buckets.fail,
    broken: broken.length,
    lookFaithful: lookalikeFaithful.length,
    formFail: (k) => quoteCensus.fail.per[k].count,
    formAll: (k) => quoteCensus.all.per[k].count,
    sourceRet: sourceCensus.per.ret_newline.count,
    successRet: success ? success.census.per.ret_newline.count : 0,
    successRows: success ? success.census.per.rows_vs_range.count : 0,
    successQuoted: success ? success.quoted : 0,
    // 「相差多少倍」原本写的是 30：读数是 22.4% / 0.7% 算出来的，这里把它也算成读数。
    rowsRatio: (() => {
      const a = quoteCensus.failN === 0 ? 0 : quoteCensus.fail.per.rows_vs_range.count / quoteCensus.failN
      const b = !success || success.quoted === 0 ? 0 : success.census.per.rows_vs_range.count / success.quoted
      return b === 0 ? '—' : Math.round(a / b)
    })(),
  }
  for (const f of FORMS) {
    const hits = quoteCensus.fail.per[f.key].count
    const a = attr[f.key]
    const v = VERDICTS[f.key](RV)
    L(`  ▸ ${f.label}（残余 fail 命中 ${hits} ｜ 洗活 ${a ? a.fixed : '— 不可去污'}）`)
    L(`      判定：${v.who}`)
    L(`      依据：${v.why}`)
    if (v.layer) L(`      该动的层：${v.layer}`)
  }

  L('')
  L('── 判据 ──')
  const checks = [
    {
      // C53：名字不再手写五个数字 —— 口径由 BASELINE（六格）自己说，改了常量名字跟着走。
      name: `基准桶与上游主线程六格 ${cellLine(BASELINE)} 逐格一致`,
      ok: reconciled,
      detail: mismatches.length === 0 ? `本次 ${cellLine(baseline.buckets)}` : `不符的格：${mismatches.map((k) => `${CELL_LABEL[k] ?? k} 期望 ${BASELINE[k]} 实得 ${baseline.buckets[k]}`).join('；')}`,
    },
    { name: '分桶之和 = 可重放条数', ok: baseline.sum === replayableCount, detail: `${baseline.sum} / ${replayableCount}` },
    {
      // C53 加：**分桶穷尽** —— 基准趟的桶必须恰好是六格，一个不多一个不少。
      //
      // 为什么需要它：`buckets[res.outcome] += 1` 对**任何**字符串都照收，而上面两条只看六格
      // 的读数与总和。上游将来新加一态（或链路回了一个七格之外的键）时，它会静默地记进一个新键：
      // 六格读数全部不变、总和也照样对（因为在同一个 Map 里）——“静默多一格”看起来与“什么都没变”
      // 一模一样。这条是拿**桶的键集**判的，不是拿读数判的，所以它拦得住。
      name: '分桶穷尽：基准趟的桶恰为六格（没有条目落在六格之外）',
      ok: CELL_KEYS.every((k) => typeof baseline.buckets[k] === 'number') && Object.keys(baseline.buckets).length === CELL_KEYS.length,
      detail: `键集 [${Object.keys(baseline.buckets).join(', ')}] vs 六格 [${CELL_KEYS.join(', ')}]`,
    },
    { name: '引擎文件跑前/跑后摘要未变', ok: engineUnchanged, detail: ENGINE_MODULE_SET.map((m) => `${m}:${digestsBefore[m]}`).join(' ') },
    {
      // C36：从 `>=`（等号放行）改成**集合等式**—— 洗坏集必须恰为空集，一个都不行。
      // 但要说清它的量程：恒等去污也满足这一条（143 → 143），它只管「不越界」。
      // 判定力在同级的等式条（去污后 fail / 洗活集 / 去污后 ok / 引文＋原文）/ 自证三条
      // 与 C40 加的常量侧两条上 —— 序号会随判据增删而移，所以这里只点名不点号。
      // （对比试验：恒等化 clean ⇒ 读数侧那几条一齐红、exit 1。C36 当时把它记成「6/13」——
      //   C40 加了两条常量侧判据、总数变 15，而那两条只谈常量、不随去污函数动，故恒等变异下
      //   照常通过。分数随判据总数变，所以这里不再写死一个会漂的分子/分母。）
      name: '去污重测（只洗回执渲染类）不把任何一条从 ok 洗成 fail（洗坏集恰为空集）',
      ok: qBroken.length === 0 && baseline.oks.every((id) => passes.quoteSide.oks.includes(id) && passes.bothSides.oks.includes(id)),
      detail: `ok ${baseline.buckets.ok} → ${passes.quoteSide.buckets.ok} / ${passes.bothSides.buckets.ok}；洗坏 A ${qBroken.length} 条${qBroken.length > 0 ? `（${listIds(qBroken)}）` : ''}`,
    },
    {
      // ★ 主判据（C36 改为等式）：原来是 `<=`，等号放行 —— 去污退化成恒等也能绿。
      //   `baseline.fail - quoteSide.fail` 就是「去污真正洗活了几条」；恒等时它是 **0**，
      //   与 EXPECT.cleanFail 要求的 Δ=1 当场不符 —— 变异反证要求它红并点名 delta 不符。
      name: `去污后 fail 恰为预期 ${EXPECT.cleanFail}（= 洗活 ${BASELINE.fail - EXPECT.cleanFail} 条，不是「不劣于」）`,
      ok: passes.quoteSide.buckets.fail === EXPECT.cleanFail,
      detail: `fail ${baseline.buckets.fail} → ${passes.quoteSide.buckets.fail}；期望 ${EXPECT.cleanFail}、delta ${baseline.buckets.fail - passes.quoteSide.buckets.fail}、期望 delta ${BASELINE.fail - EXPECT.cleanFail}`,
    },
    {
      // ★ 主判据二（C36 新增）：洗活集**必须恰好**是 EXPECT.cleanLive（当前 {F0275}）。
      //   多一条 = 洗动不该动的（越界）；少一条 = 该洗的没洗掉；空集 = 去污没做事。
      //   旧写法 `fail <= baseline.fail` 对空集也放行 —— 这一条就是堵那个口子的。
      name: `洗活集恰为预期 ${JSON.stringify(EXPECT.cleanLive)}（不等就点名）`,
      ok: JSON.stringify(qFixed) === JSON.stringify(EXPECT.cleanLive),
      detail: `期望 ${JSON.stringify(EXPECT.cleanLive)} ｜ 实际 ${JSON.stringify(qFixed)}（洗活 ${qFixed.length} 条）`,
    },
    {
      // ★ 去污的**收益侧**同样钉成等式：洗活必须真的把一条 fail 换成 ok。
      name: `去污后 ok 恰为预期 ${EXPECT.cleanOk}`,
      ok: passes.quoteSide.buckets.ok === EXPECT.cleanOk,
      detail: `ok ${baseline.buckets.ok} → ${passes.quoteSide.buckets.ok}；期望 ${EXPECT.cleanOk}、delta ${passes.quoteSide.buckets.ok - baseline.buckets.ok}、期望 delta ${EXPECT.cleanOk - BASELINE.ok}`,
    },
    {
      // ★ 引文＋原文一起洗（B）也必须恰为预期：源侧同病的那条路径不能悄悄多洗或少洗。
      name: `引文＋原文一起洗的洗活集恰为预期 ${JSON.stringify(EXPECT.bothSidesLive)}`,
      ok: JSON.stringify(bFixed) === JSON.stringify(EXPECT.bothSidesLive),
      detail: `期望 ${JSON.stringify(EXPECT.bothSidesLive)} ｜ 实际 ${JSON.stringify(bFixed)}（洗活 ${bFixed.length} 条）`,
    },
    {
      name: '去污集 = 全部标为「工具侧回执渲染类」的形态（标了却没洗 = 漏，洗了没标的 = 越界）',
      ok:
        RECEIPT_FORMS.length === FORMS.filter((f) => f.layer === 'tool').length &&
        FORMS.filter((f) => f.layer === 'tool').every((f) => RECEIPT_FORMS.includes(f.key)),
      detail: `去污集 [${RECEIPT_FORMS.join(', ')}] vs 标 tool 的 [${FORMS.filter((f) => f.layer === 'tool').map((f) => f.key).join(', ')}]`,
    },
    {
      // ★ 反面对照的期望**同样钉死**（原来是 `allForms.ok < baseline.ok`，只拦「没变差」）。
      //   两块分开钉，因为它们的**参照系不同**（这是本单自己踩到的一个坑）：
      //     · `broken` —— 相对量：恒等对照里 ok、而反面对照里不 ok 的条目。它只取决于「全角/续断
      //       这两种形态到底有多忠实」，与主去污函数无关，所以钉成**绝对条数**恰 22。
      //     · `allForms.ok` —— 绝对量，只能等于「恒等对照的 ok 减掉那 22 条」。若直接钉成基准的
      //       122，主去污层一有风吹草动（例如某个回执形态的 `clean` 退化）它就会跟着红，
      //       而那不是反面对照的错 —— 第一版就是这么写的，变异试验里它红在 ok 121 而不是点子上。
      // ★ 反面对照的期望**同样钉死**（原来是 `allForms.ok < baseline.ok`，只拦「没变差」）。
      //   三项各自钉，因为它们的**参照系不同**（这是本单自己踩到的一个坑）：
      //     · `broken` —— 恒等对照里 ok、而反面对照里不 ok 的条目集，**逐条**等于 EXPECT.allFormsBrokenIds。
      //       它只取决于「全角/续断这两种形态到底有多忠实」，与主去污函数无关。
      //     · `allForms.ok` —— 绝对值 122。注意它 ≠ 143 - 22 = 121：broken 里那条是从 ok 掉到
      //       needs_choice 的，同时又有 1 条从 needs_choice 掉进 fail（15→13）。
      //       拿 broken 条数去减 ok 是错的 —— 第一版就这么写，变异试验里它红在 ok 121 而不是点子上。
      //     · `needs_choice` 的净减 2 —— 上面那两条反向移动的痕迹，单钉一项作为对账。
      name: `反面对照：连「忠实形态」一起洗必须恰洗坏 ${EXPECT.allFormsBroken} 条（逐条点名）、ok 恰为 ${EXPECT.allFormsOk}`,
      ok:
        JSON.stringify(broken) === JSON.stringify(EXPECT.allFormsBrokenIds) &&
        passes.allForms.buckets.ok === EXPECT.allFormsOk &&
        passes.identity.buckets.needs_choice - passes.allForms.buckets.needs_choice === 2,
      detail: `被洗坏 ${broken.length} 条（期望 ${EXPECT.allFormsBroken}）${broken.length > 0 ? `（${listIds(broken)}）` : ''}；ok 恒等 ${passes.identity.buckets.ok} → 反面对照 ${passes.allForms.buckets.ok}（期望 ${EXPECT.allFormsOk}，净减 ${passes.identity.buckets.ok - passes.allForms.buckets.ok}）；needs_choice ${passes.identity.buckets.needs_choice} → ${passes.allForms.buckets.needs_choice}`,
    },
    {
      // ★ 自证（一）：恒等对照必须**真的等于原件** —— 改了 0 条引文、洗活 0 条、洗坏 0 条、
      //   分桶与基准逐格相同。它保证「对照」本身是诚实的；若去污层的 `clean` 被改成恒等，
      //   主去污趟也会变成这个形状（改了 0 条）—— 由下一条拦住。
      name: '自证：恒等对照真的什么也没动（改了 0 条引文、洗活 0 条、分桶 = 基准）',
      ok:
        passes.identity.transformed === 0 &&
        idLoss.length === 0 &&
        baseline.fails.every((f) => !passes.identity.oks.includes(f.id)) &&
        Object.keys(BASELINE).every((k) => passes.identity.buckets[k] === baseline.buckets[k]),
      detail: `改了引文 ${passes.identity.transformed} 条（期望 0）；恒等下的洗活 ${baseline.fails.filter((f) => passes.identity.oks.includes(f.id)).length} 条（期望 0）；恒等分桶 ok ${passes.identity.buckets.ok}/fail ${passes.identity.buckets.fail}（基准 ${baseline.buckets.ok}/${baseline.buckets.fail}）`,
    },
    {
      // ★ 自证（二）：**主读数必须与恒等对照分叉**。这一条把「恒等」与「真去污」区分开，
      //   是上面几条等式判据不恒真的根据：两条路走同一段重放代码、只差 `clean` 一个函数，
      //   读数却不同，差别只能来自去污函数本身。恒等化 `clean` ⇒ 两路重合 ⇒ 本条红。
      name: '自证：主去污趟必须与恒等对照分叉（否则主判据恒真）',
      ok: passes.quoteSide.buckets.fail !== passes.identity.buckets.fail && passes.quoteSide.transformed > passes.identity.transformed,
      detail: `fail 主去污 ${passes.quoteSide.buckets.fail} vs 恒等 ${passes.identity.buckets.fail}（必须不等）；改了引文 ${passes.quoteSide.transformed} vs ${passes.identity.transformed}；洗活 ${qFixed.length} vs ${baseline.fails.filter((f) => passes.identity.oks.includes(f.id)).length}`,
    },
    {
      // ★ 自证（三）：恒等对照的**预期损失**恰为 0；它与反面对照的 22 条拼成本探针的「量程」：
      //   0（什么也不做）→ 1（真去污）→ 22（洗过头，把忠实形态也洗了）。
      name: `自证：恒等对照的预期损失 = ${EXPECT.identityLoss} 条（量程下限）`,
      ok: idLoss.length === EXPECT.identityLoss && broken.length === EXPECT.allFormsBroken,
      detail: `恒等洗坏 ${idLoss.length} 条（期望 ${EXPECT.identityLoss}）；反面对照洗坏 ${broken.length} 条（期望 ${EXPECT.allFormsBroken}）；量程（同一量纲 = 洗活条数）：恒等 ${EXPECT.identityLoss} → 真去污 ${BASELINE.fail - passes.quoteSide.buckets.fail}；反面对照的损害自成一档：ok ${passes.identity.buckets.ok} → ${passes.allForms.buckets.ok}、needs_choice ${passes.identity.buckets.needs_choice} → ${passes.allForms.buckets.needs_choice}（拿 22 去减 ok 是错的，见 EXPECT.allFormsBrokenIds 的注释）`,
    },
    {
      // ★ C40 常量侧判据（一）：三个钉死常量必须**互相自洽**。
      //   `cleanFail` 不是自由参数 —— 去污把 `baselineFail` 里的若干条从 fail 洗成 ok，所以它必须
      //   恰好等于 `baselineFail - washedIds.length`。上一波的现场就是「改了一个忘了另一个」：
      //   `cleanFail` 留成 172（= 洗活 2 条）而 `washedIds` 仍是 ["F0275"]（1 条），于是探针红在
      //   **读数**上（实测 173 ≠ 期望 172），读的人得从屏幕文字里反推是哪条常量写错了。
      //   这一条与实测读数无关（只谈常量之间的关系），所以它把「手抄的数写错了」与「引擎变了」
      //   分开报：两个都红 ⇒ 现场自相矛盾，先看这一条。
      //   注意：它**不是**按实测回填（三个数仍然逐格钉死），只是禁止自相矛盾。
      name: `自洽：cleanFail ${PINNED.cleanFail} === baselineFail ${PINNED.baselineFail} - 洗活 ${PINNED.washedIds.length} 条（= ${PINNED.suggestedCleanFail}）`,
      ok: PINNED.consistent,
      detail: PINNED.consistent
        ? `${PINNED.baselineFail} - ${PINNED.washedIds.length} = ${PINNED.suggestedCleanFail} = cleanFail ✓（洗活集 ${JSON.stringify(PINNED.washedIds)}；与第 5/6 条实测判据互锁：实测的洗活集也必须恰是这一集）`
        : `**不自洽**：cleanFail ${PINNED.cleanFail} ≠ baselineFail ${PINNED.baselineFail} - 洗活 ${PINNED.washedIds.length} = ${PINNED.suggestedCleanFail} ⇒ 建议把 EXPECT.cleanFail 改成 ${PINNED.suggestedCleanFail}；若你要说的其实是「洗活了 ${PINNED.baselineFail - PINNED.cleanFail} 条」，那要改的是 EXPECT.cleanLive（第 5/6 条会跟着红 —— 洗活集只有一个来源，是实测）`,
    },
    {
      // ★ C40 常量侧判据（二）：三个常量的**指纹**。自洽判据拦不住「一对同向改动」——
      //   把 cleanFail 与 cleanLive 一起改成 174 / [] 也满足 `174 - 0 = 174`；指纹拦得住：
      //   一被改动，屏幕上那行「常量指纹」与这里当场不等。
      name: `自洽：钉死常量指纹未漂移（交付时记录 ${EXPECT_PIN_FINGERPRINT}）`,
      ok: PINNED.fingerprint === EXPECT_PIN_FINGERPRINT,
      detail:
        PINNED.fingerprint === EXPECT_PIN_FINGERPRINT
          ? `指纹 ${PINNED.fingerprint} = 交付时记录（baselineFail ${PINNED.baselineFail} / cleanFail ${PINNED.cleanFail} / washedIds ${JSON.stringify(PINNED.washedIds)}）✓`
          : `指纹 ${PINNED.fingerprint} ≠ 交付时记录的 ${EXPECT_PIN_FINGERPRINT} ⇒ 三个钉死常量里至少一个被改过：变异反证没还原就改回并复跑；若是**有意**改动（语料/引擎真变了且人复核过），把 EXPECT 的注释、EXPECT_PIN_FINGERPRINT 与回执里的 sha256 一起更新`,
    },
    {
      // ★ C53 加：**六格下的洗活口径**。`cleanFail = baselineFail - 洗活条数` 这条不变量的前提是
      //   「除 fail→ok 外没有别的迁移进出 fail 格」。五格时代它是白给的；接上第四态后不是了 ——
      //   一条 `already_applied` 被洗成 fail、或一条 `needs_choice` 被洗进 fail，都会让 Δ 对不上，
      //   而「去污后 fail 恰为预期」与「常量自洽」那两条只会报「数字不符」，指不到迁移上。
      //   逐条量出来就指得到了（上一条的 detail 里逐项列了四格的前后值）。
      name: '六格下的洗活口径：除 fail→ok 外没有别的迁移进出 fail 格（已落地/需选择/无从表达/无入口 四格不动）',
      ok: enteredFail.length === 0 && leftFailToOther.length === 0 && otherCellsFlat,
      detail: `新进 fail 的 ${enteredFail.length} 条${enteredFail.length > 0 ? `（${listIds(enteredFail)}）` : ''}；离开 fail 却不是去 ok 的 ${leftFailToOther.length} 条${leftFailToOther.length > 0 ? `（${listIds(leftFailToOther)}）` : ''}；其余四格 ${otherCellsFlat ? '逐格不动' : '**有变动**'}（${NON_MAIN_CELLS.map((k) => `${CELL_LABEL[k]} ${baseline.buckets[k]}→${passes.quoteSide.buckets[k]}`).join('、')}）`,
    },
    (() => {
      /**
       * ★ C53 加：**入口同一性的静态自检**（与其余三件普查件同形：`already-applied-census` 判据⑧）。
       *
       * 上面那些判据用的是**读数**（与上游六格逐格对账），它只在链路上真的分叉时才红；而分叉
       * 与「引擎真改过」在屏幕上长得一模一样 —— 这正是本单要治的那类缝。这一条管的是
       * **缝本身有没有重新长回来**：只要本文件里重新声明了复刻件（哪怕当下没被调用），
       * 或者重放不再走 import 进来的上游导出，就当场红并点名那个符号。
       *
       * 认的是**声明形态**（`function` / `const` / `let` / `var` + 名字），不是随便提到名字 ——
       * 上面的文件头注释里就写着这几个名字（说明它们为什么被删），那不该算数。
       * 名单与 `already-applied-census` 的判据⑧逐字相同；本地那个薄适配层 `replayNew`
       * （只补三种记账归属）**故意不算复刻件** —— 它是四件探针的统一形状。
       */
      const REPLICA_NAMES = ['toContentAddress', 'neighbourContext', 'locateQuiet', 'legacyRequest']
      const selfSource = fs.readFileSync(SELF_PATH, 'utf8')
      const replicaDecls = [...selfSource.matchAll(new RegExp(`(?:function|const|let|var)\\s+(${REPLICA_NAMES.join('|')})\\b`, 'g'))].map((m) => m[1])
      const importsUpstream = /import\s*\{[^}]*\breplayNewContract\b[^}]*\}\s*from\s*['"][^'"]*locator-lab\/failure-replay\.mjs['"]/.test(selfSource)
      const callsUpstream = /return\s+replayNewContract\s*\(\s*\{/.test(selfSource)
      return {
        name: '入口同一性：本探针没有判据层复刻件，重放确实走 import 的上游导出 replayNewContract',
        ok: replicaDecls.length === 0 && importsUpstream && callsUpstream,
        detail:
          replicaDecls.length > 0
            ? `✗ 本地又出现了复刻件声明：${[...new Set(replicaDecls)].join(' / ')}（那就是 C53 删掉的那类东西：它一回来，六格里的第四态与 fail 格就会与上游分叉）`
            : importsUpstream && callsUpstream
              ? '✓ 无复刻件声明 ｜ import 上游导出 ✓ ｜ 调用上游导出 ✓'
              : `✗ ${importsUpstream ? '' : '没有从 failure-replay.mjs import replayNewContract；'}${callsUpstream ? '' : '没有一处 `return replayNewContract({…})`（重放不再走上游导出）'}`,
      }
    })(),
  ]
  for (const c of checks) L(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name} —— ${c.detail}`)
  L(`  ${checks.filter((c) => c.ok).length}/${checks.length} 判据通过`)

  if (json) {
    L('')
    L('=== JSON ===')
    L(
      JSON.stringify(
        {
          unit: 'C33', // 探针自己的编号（读数是 C33 的）；判定力由 C36 加严
          corpus: { path: path.relative(REPO, CORPUS_PATH), sha256_12: corpusDigest, entries: corpus.entries.length, replayable: baseline.sum },
          engine,
          baseline: baseline.buckets,
          expected: BASELINE,
          // C36：主判据的预期（洗活集/去污后读数/反面对照/恒等对照）也进 JSON，
          // 让验收方不必从屏幕文字里反推判据量程。
          expectedClean: EXPECT,
          // C40：探针自身的身份 + 三个钉死常量的自洽/指纹（屏幕上也有一份，这里是机器可读的那份）
          self: {
            path: path.relative(REPO, SELF_PATH),
            bytes: selfBytes.length,
            sha256: selfSha,
            sha256_16: selfSha.slice(0, 16),
            pinned: { baselineFail: PINNED.baselineFail, cleanFail: PINNED.cleanFail, washedIds: PINNED.washedIds },
            suggestedCleanFail: PINNED.suggestedCleanFail,
            consistent: PINNED.consistent,
            fingerprint: PINNED.fingerprint,
            fingerprintExpected: EXPECT_PIN_FINGERPRINT,
          },
          reconciled,
          allChecksOk: checks.every((c) => c.ok),
          quoteCensus: {
            allN: quoteCensus.allN,
            failN: quoteCensus.failN,
            all: Object.fromEntries(FORMS.map((f) => [f.key, { count: quoteCensus.all.per[f.key].count, ids: quoteCensus.all.per[f.key].ids }])),
            fail: Object.fromEntries(FORMS.map((f) => [f.key, { count: quoteCensus.fail.per[f.key].count, ids: quoteCensus.fail.per[f.key].ids }])),
            anyAll: quoteCensus.all.anyIds.length,
            anyFail: quoteCensus.fail.anyIds.length,
            samples: Object.fromEntries(FORMS.map((f) => [f.key, quoteCensus.fail.per[f.key].samples])),
          },
          passes: {
            before: baseline.buckets,
            quoteSide: passes.quoteSide.buckets,
            bothSides: passes.bothSides.buckets,
            allForms: passes.allForms.buckets,
            identity: passes.identity.buckets,
            identityTransformed: passes.identity.transformed,
            quoteSideFixedIds: qFixed,
            bothSidesFixedIds: bFixed,
            quoteSideBrokenIds: qBroken,
            allFormsBrokenIds: baseline.oks.filter((id) => !passes.allForms.oks.includes(id)),
            remainingFailIds: passes.quoteSide.fails.map((f) => f.id),
            // C53：六格下的「洗活」口径逐条量出来的那一份（判据⑰读它；机器可读同上）
            transitions: {
              enteredFail,
              leftFailToOther,
              otherCellsFlat,
              otherCells: Object.fromEntries(NON_MAIN_CELLS.map((k) => [k, { before: baseline.buckets[k], after: passes.quoteSide.buckets[k] }])),
            },
          },
          lookalikeFaithful: lookalikeFaithful.length,
          attribution: attr,
          sourceCensus: {
            per: Object.fromEntries(FORMS.map((f) => [f.key, { count: sourceCensus.per[f.key].count, ids: sourceCensus.per[f.key].ids }])),
            byKind: sourceCensus.byKind,
          },
          success: success
            ? {
                path: success.path,
                mtime: success.mtime,
                bytes: success.bytes,
                sha256_16: success.sha,
                entries: success.entries.length,
                quoted: success.quoted,
                byKind: success.byKind,
                counts: Object.fromEntries(FORMS.map((f) => [f.key, success.census.per[f.key].count])),
                any: success.census.anyIds.length,
                samples: Object.fromEntries(FORMS.map((f) => [f.key, success.census.per[f.key].samples])),
              }
            : null,
          checks,
        },
        null,
        1,
      ),
    )
  }
  // C36：退出码从「只挂钩基准对账」改成**挂钩全部判据**。
  // 旧写法 `exit(reconciled ? 0 : 1)` 把去污读数排除在表态之外 —— 基准对账与「去污到底有没有用」
  // 本来就是两件事（对账只比对分桶），所以去污函数退化成恒等时它仍 exit 0。「判据打印了就作数」
  // 不是判定力：屏幕上多一行 FAIL、退出码却是 0，机检线看不见它。
  process.exit(checks.every((c) => c.ok) ? 0 : 1)
}

/** 成功集语料：读出来（只读，不改）。读不到就如实返回 null，屏幕上报「量不到」。 */
function loadSuccessCorpus(explicit) {
  const cands = explicit ? [explicit] : SUCCESS_CANDIDATES
  const found = cands.filter((p) => p && fs.existsSync(p))
  if (found.length === 0) return null
  // 取最新的一份：成功集是**抽样**语料，池子会随会话日志增长而变，最新那份最有代表性。
  const pick = found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  try {
    const bytes = fs.readFileSync(pick)
    const j = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(j?.entries)) return null
    return {
      path: pick,
      mtime: new Date(fs.statSync(pick).mtimeMs).toISOString(),
      bytes: bytes.length,
      sha: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12),
      entries: j.entries,
      poolSize: j.poolSize ?? null,
      sampleTarget: j.sampleTarget ?? null,
    }
  } catch {
    return null
  }
}

await main()
