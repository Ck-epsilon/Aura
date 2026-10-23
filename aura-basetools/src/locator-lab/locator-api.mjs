/**
 * locator-api —— 框架无关的定位服务。
 *
 * 这一层的存在本身就是"不要打补丁"的兑现：DSH 的 `patch` 工具是它的**适配器之一**，
 * 不是它的宿主。定位逻辑不认识 Cordis、不认识 ctx、不认识 schema，因此换成别的 agent
 * 框架时不需要动它一行。
 *
 * 设计约束：
 *   1. **零依赖**：只 import node 内建与本目录的纯函数。任何框架都能直接 import。
 *   2. **无状态、无 I/O**：输入源码字符串，输出行区间。文件读写归调用方。
 *      ——这一条是关键。工具层各自有各自的沙箱/观察策略/审批模型，定位层不该知道这些。
 *   3. **同步**：索引是 CPU 活，没有理由异步。调用方要异步就自己包一层。
 *
 * 对任何 agent 框架，接进来只需要三件事：
 *   a. 把文件内容读成字符串（用你框架自己的 fs 能力，带它自己的沙箱/权限）
 *   b. 调 `locate(source, request)` 拿到区间或候选
 *   c. 用你框架自己的写回能力落盘（带它自己的原子性/审批）
 */

import { indexStructure, langOf, listSymbols, findReferences, regionConfidence, resolveTarget, rankSymbols, LANGS } from './struct-core.mjs'
import { indexFile, locateWith, normSpace } from './anchor-core.mjs'

/**
 * 定位一份源码里的改动点。
 *
 * 五层寻址，按"模型要提供什么"从强到弱排列。每层覆盖上一层够不到的场景，
 * 但**都不要求模型复现字节**——这是它们与 `edit` 的根本差别：
 *
 *   1. `intent`  —— 一段模糊意图（符号名片段 / 短语 / 近似原文）。引擎按固定次序收敛：
 *                    精确符号 → 符号子串 → 文本锚点；收敛不了就报歧义并给候选，绝不猜。
 *   2. `target`  —— 符号名。不读文本，对内容记错免疫。适合改整个函数/类/类型。
 *   3. `lines`   —— 行号区间。模型刚用 `read` 看过文件，输出就是 `<行号>: <文本>`，
 *                    `grep` 也给行号——**位置是它本来就知道的信息**，我却一直只让它给内容。
 *                    把行号纳入地址空间后，符号体内的任意一行都变得可精确寻址。
 *   4. `lineCue` —— 一个词。当模型记不住行号时，说"就在有 resolvePolicy 的那一行"。
 *                    只接受**全文件唯一**的线索；不唯一则报歧义并给出候选行号，绝不猜。
 *   5. `anchor`  —— 记得的原文。五级降级匹配，容错性最好但要求模型复现内容。
 *
 * `intent` 与其余四层**互斥**（由 `planHunks` 判）：同时给两个地址时谁说了算没有正确答案。
 * 前两层偏**精确**（要么命中要么报错），后三层偏**容错**。
 * 调用方可以传 `assert` 做内容校验，五层都适用——那才是防止"指到错的行"的那道闸。
 * 判据是**包含且唯一**：这段文字必须在整个文件里只出现一处，且该处落在受寻址区间内
 * （短引文例外，仍要求与区间整段相等；推导见 {@link ASSERT_RELAX_MIN_CHARS}）。
 *
 * @param {string} source - 源码全文
 * @param {object} request - 定位请求
 * @param {string} [request.intent] - 模糊意图地址（符号名片段 / 短语 / 近似原文）
 * @param {string} [request.target] - 符号名（`name` / `kind:name` / `Outer/Inner` / `name#n`）
 * @param {{start:number,end:number}} [request.lines] - 1-based 闭区间行号
 * @param {string} [request.lineCue] - 一个词的线索，必须全文件唯一
 * @param {string} [request.anchor] - 记得的原文，走五级文本匹配
 * @param {number} [request.near] - 行号提示
 * @param {string} [request.assert] - 内容校验（空白归一化后比较）：这段文字必须在**整个文件**里唯一出现，
 *   且该唯一出现处落在受寻址区间内（区间含有它即通过）；不唯一时拒绝并点出每一处的行号与该行原文；
 *   短于 {@link ASSERT_RELAX_MIN_CHARS} 字符时仍要求与区间整段相等
 * @param {string} [request.filePath] - 用于判定语言；给了才能用 target / lineCue
 * @returns {{ok: true, startLine, endLine, tier, actual} | {ok: false, code, message, candidates?, hint?}}
 *   `startLine`/`endLine` 是 1-based 闭区间；`actual` 是该区间的原文，供调用方核对或展示。
 */
/**
 * 引用一段原文给人/模型看 —— 见 {@link quoteForMessage}。
 *
 * 那一份是本仓库**唯一**的引文渲染实现（本文件与写路径 `write-path.mjs` 共用）：
 * 从前写路径照抄过一个同形的 `quoteOne`，于是"同一次渲染改动要落两处"，
 * 两处一旦不同步，同一件事就有了两份判定。
 */
/**
 * 把失败回执的候选行**写进 message**，并返回自含的回执对象。
 *
 * 为什么不能只挂 `candidates` 字段：DSH 框架对抛出的错误只取 `error.message`
 * （`dsh-tools/lib/index.js:2495-2503`），其余字段一概不读。所以"给候选行"这件事
 * 挂成结构化字段等于没给——**模型看不到它**。
 *
 * 实测：86 次 `appears on N lines` 歧义失败，回执里只有"出现在 2 行上"，
 * 没有任何行号；模型只能猜或重试。而候选行在这里**已经算出来了**。
 *
 * 统一走这一个助手而不是在四处各拼一遍：本项目吃过"同一决策写两处、必有一处漏改"
 * 的亏（`rankSymbols` 的挑选逻辑、手写透传清单），而下面四条失败路径都要做同一件事。
 *
 * @param code - 失败码
 * @param message - 原始说明（候选行会追加在它后面）
 * @param candidates - 两种形状：**行候选** `{line, text?}` 与**符号候选** `{name, kind, enclosing, startLine, endLine}`
 * @returns 自含的回执对象
 */
function failure(code, message, candidates) {
  const raw = Array.isArray(candidates) ? candidates : []
  /**
   * 候选有**两种形状**，而它们走同一个格式化器。
   *
   * 这是个真踩过的坑（T29 顺带发现）：符号候选带的是 `startLine` / `enclosing`，
   * 而这里只读 `line` / `text`，于是 `target=` 歧义的回执印成
   * **`candidates: line undefined, line undefined`**——
   * 候选明明算出来了，却在回执里变成两个 `undefined`。
   * 覆盖面不小：真实语料里 659 个符号有 **165 个（25%）** 按名寻址是歧义的，
   * 也就是说“四分之一次的按名编辑里，模型拿到的是两个 undefined”。
   *
   * 统一在这里归一，不在调用方各拼一遍（上游已经因为同一个决策写两处而漏改过）。
   */
  const rows = raw.map((c, i) => {
    /**
     * 数字候选（**行号数组**）与符号候选一样，是"算出来了却印成 undefined"的另一条来路。
     *
     * `anchor-core` 的四条歧义路径（verbatim / norm-space / similarity / aligned）抛的都是
     * `candidates: found.map((i) => i + 1)` 这种 **`number[]`**——它们既不是 `null` 也不是对象，
     * 于是下面那行原样放过，而 `renderCandidates` 只会做 `` `line ${c.line}` ``，
     * 回执当场印成 **`candidates: line undefined, line undefined, line undefined`**。
     * 真实语料 F0059 就是这一例：32 行引文对齐到 3 个窗口，行号三个都算出来了，
     * 模型看到的却是三个 undefined。
     *
     * 判据刻意写成 `typeof c === 'number'`（而不是 `Number.isInteger`）：引擎眼下只发整数，
     * 但只要写成整数判据，任何非整数数字候选又会掉回 undefined 那一支——本单要治的正是这个。
     * 与壳层 `aura-edit/index.js` 的 `normalizeCandidates` 同一个去向（数字 ⇒ `{line}`），
     * 于是 API 面的 `candidates` 从此**只有一种形状**。
     */
    if (typeof c === 'number') return { line: c, ordinal: i + 1 }
    if (c === null || typeof c !== 'object') return c
    if (typeof c.line === 'number') return { ...c, ordinal: i + 1 }
    return {
      ...c,
      line: typeof c.startLine === 'number' ? c.startLine : null,
      ...(c.kind === undefined ? {} : { text: `${c.kind}${c.enclosing === undefined || c.enclosing === null ? '' : ` in ${c.enclosing}`}` }),
      ordinal: i + 1,
    }
  })
  const listed = renderCandidates(rows)
  // 两种消歧写法都说：`#N` 精确、`near=<行号>` 省事。不说的话它只能盲重试。
  const howto =
    code === 'STRUCT_AMBIGUOUS' && rows.some((c) => c.name !== undefined)
      ? ' — retry with one of those addresses, or add near=<line> to pick the closest'
      : ''
  return {
    ok: false,
    code,
    message: `${message}${listed}${howto}`,
    ...(rows.length === 0 ? {} : { candidates: rows }),
  }
}

/**
 * 候选清单的渲染：`line N = <引文>` 用 `, ` 连成一行，**合计**体量封在 {@link CANDIDATE_LIST_CHARS}。
 *
 * 两条上限各管一件事，缺一不可：{@link CANDIDATE_LIMIT} 管**条数**，本条管**体量**。
 * 只有条数上限时，20 条 × 每条一整段忠实原文能到五位数 —— 比宿主阈值 8192 还大，
 * 于是"回执不许顶穿宿主阈值"这条约束在候选这一路上当场落空。
 * 到顶就停，并把没展示的条数写在原地（`+N more`），不静默丢。
 *
 * 引文本身走 {@link quoteForMessage}（与其它引用点同一份渲染）：
 * 候选也是"引用原文给调用方看"，在这里另写一套等于同一件事又有了两份判定。
 *
 * @param rows - 已归一的候选行（形状见 {@link failure}）
 * @returns 形如 `; candidates: line 12 = “…” (+3 more)`；无候选时为空串
 */
function renderCandidates(rows) {
  const parts = []
  let spent = 0
  /**
   * `target=name#n` 的 `n` 必须是**同名的序号**，不是整份候选列表的序号：
   * `resolveTarget` 把 `#n` 解释为该名字的第 n 个命中。旧代码拿全局下标，于是
   * `fooHandler#1, barHandler#2, handler2#3, handler2#4` 里只有第一个能解析——
   * 其余会把调用方引向 `STRUCT_NOT_FOUND`。唯一名字直接给 `target=name`，不带 `#`。
   */
  const nameCounts = new Map()
  for (const c of rows) if (c.name !== undefined) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1)
  const seen = new Map()
  for (const c of rows) {
    let nth = null
    if (c.name !== undefined) {
      nth = (seen.get(c.name) ?? 0) + 1
      seen.set(c.name, nth)
    }
    if (parts.length >= CANDIDATE_LIMIT) break
    const at = typeof c.line === 'number' ? c.line : null
    const address = c.name === undefined ? '' : nameCounts.get(c.name) > 1 ? ` (target=${c.name}#${nth})` : ` (target=${c.name})`
    const entry = `line ${c.line}${c.text === undefined ? '' : ` = ${quoteForMessage(c.text, at)}`}${address}`
    /**
     * 第一条**无论多长都要放**：一条候选都不印的清单等于没给，"有候选"当场变成一句空话。
     * 预算只从第二条起生效。
     */
    if (parts.length > 0 && spent + entry.length > CANDIDATE_LIST_CHARS) break
    parts.push(entry)
    spent += entry.length
  }
  if (parts.length === 0) return ''
  const hidden = rows.length - parts.length
  /**
   * 分隔符看内容：全是单行就给一行 `, ` 连到底（与改前逐字相同），
   * 只要有一条自带忠实块（真换行），就**一条一行** —— 否则上一条的原文块会把下一条的
   * `line N = ` 前缀吞进自己的最后一行，回抄时两条候选粘成一段（这不是格式洁癖：
   * 段A 的 `A8` 就是按"边距可机械剥掉"去取候选原文的，粘在一起就取不出来了）。
   */
  const sep = parts.some((p) => p.includes('\n')) ? '' : ', '
  return `; candidates: ${parts.join(sep)}${hidden > 0 ? ` (+${hidden} more)` : ''}`
}

/**
 * 失败回执里最多列几行候选。
 *
 * 同样是**框架剪枝阀**的派生值，不是"够用就好"的估计：错误回执也会被剪（该项 prune 不区分 `isError`），
 * 而候选行是恢复率最高的信息（实测：锚点失败里可被符号名救回的比例很高）。
 * 原先写 6，理由是"错误回执也占预算"——那句话对，但 6 与预算之间**没有任何换算关系**，
 * 实测空出的预算能容下几十行（最大的目录 5490 字节，与 8192 差 2702）。
 * 所以改成由 {@link DEFAULT_HINT_CHARS} 派生，并**如实报出截了多少**（`+N more`）。
 *
 * 它是**条数**上限，封不住体量：清单的体量上限是 {@link CANDIDATE_LIST_CHARS}，两条各管一头。
 */
const CANDIDATE_LIMIT = 20

/**
 * 候选清单的**合计**字符预算（与 {@link CANDIDATE_LIMIT} 一起把清单夹在宿主阈值以内）。
 *
 * 为什么条数封不住体量（C38 实测）：改前每条引文被夹在 120 字符，20 条 ≈ 2400，看着安全；
 * 而这一单给每条配了**忠实块**（真换行 + 行号前缀，单条可到 ~1200），
 * 20 条就是两万四 —— 宿主 `toolResultPruner.thresholdChars` 是 8192，
 * 超了就把中间换成一行 `[... tool result middle pruned ...]`，而候选恰恰在中间。
 * 所以条数与体量必须各有一条上限。
 */
const CANDIDATE_LIST_CHARS = 2400

/**
 * 符号目录的**缺省**字符预算。
 *
 * 它**只有一个依据：框架的剪枝阀**——`dsh-compaction-tool-result-pruner` 对任何超过 8192 字符的
 * 工具结果保留 前 4096 + `[marker]` + 后 1024，中间的文本**被静默移除**（实测确认：该 prune 不区分
 * `isError`，错误回执同样被剪）。所以上限存在的意义是：**自己先截、自己先说**，而不是让下游默默抽掉。
 *
 * 取 7600 = 8192 减信封余量（路径/指令/omitted 那一圈），而不是一个"够用就好"的拍值。
 *
 * 曾经这里是 `const HINT_LIMIT = 24`（条数），注释自称"能放下的 24 个"而**没有任何东西在量**；
 * 后来我又改成 754（旧 24 条的字节量）。两者都是同一个错：
 * **用输出预算去替代"有多少是有用的"这个判断**。而实测说明这个限制从未防住任何溢出：
 * 本仓库语料里最大的目录是 `build/upgrade-test.mjs`（159 符号 / 5490 字节），离 8192 尚有 2702 字节。
 * 也就是说：那条 24 条的限制一直在**默默少给本来装得下的信息**。
 *
 * 仍然保留 `budget` 入参（可选）：调用方知道自己那条回执还剩多少空间时可以传更小的值。
 */
const DEFAULT_HINT_CHARS = 7600

/**
 * 引用一段原文给人/模型看 —— **两种形态，各自标明身份**：
 *
 *   · **紧凑摘要** `“…”`（换行写成 `⏎`）：一眼看出这段的形状，**明写不可回抄**；
 *   · **忠实块**（真换行 + 行号前缀）：**明写这就是原文、可整段回抄进 expect**。
 *
 * ## 为什么非要两份（C38；实测 F0275）
 *
 * 改前只有摘要这一种形态，而它与原文**逐字不同**：4 行 import 被渲染成一行、用 `⏎` 连接。
 * 调用方把这段引文整块拓进下一次调用的 `expect`，拿到的是**单行字符串**，而原文里永远没有
 * 这样一行。实测：把 `⏎` 还原成真换行（去污）前 fail 174，去污后 173 ——
 * **洗活的唯一一条就是它**。也就是说，错误回执里"原文是什么"那一段，
 * 回抄回去命中不了原文，而它的全部用途恰恰就是让调用方回抄。
 *
 * 当时用 `⏎` 不是没理由（换行位置本身就是信息，"你这几行其实是一行"是常见误判）。
 * 所以这一单不是删掉 `⏎`，而是**让可回抄的那一份是忠实的**：摘要原样留着（它确实更直读），
 * 忠实块另起一份（它确实能抄）。
 *
 * ## 行号前缀为什么是 `N| ` 而不是读回执的 `N: `
 *
 * 行号用的是**读回执同一套编号**（1-based，与 `aura_basetools_read` 打印的行号、与回执开头那句
 * `lines A-B` 同一个尺子），调用方因此能把引文与读回执逐行对上。
 * 字形却刻意**不同形**：`N: ` 正是调用方会整块抄走的那种形状（`probes/quote-hygiene.mjs`
 * 把"行首 `数字: `"列为一类引文污染，且"整块抄走必然失配"），同形等于引诱它连前缀一起抄。
 * 所以换成 `|` 分隔，并在忠实块的身份句里明写"这个前缀不是文件内容"。
 *
 * ## 单行原文不走这条路
 *
 * 一份单行 `“…”` 本身就是逐字的，再套一个块只会把回执撑大，
 * 所以单行与改前**逐字相同**（`layers-test` 有断言钉着单行回执的形状与截断说明）。
 *
 * 限额存在的理由与其它披露点一致：错误回执也占输出预算，不能把一整段原文无条件倒进去。
 *
 * @param text - 原始文本（可能多行、可能很长）
 * @param firstLine - 这段原文首行的 1-based 行号；缺省则忠实块不印行号前缀
 * @param limit - 一份引文的正文上限（字符）；超了就截断并明写截了多少
 * @returns 单行时形如 `“…”`；多行时 `“…” (one-line preview, NOT copyable). <身份句>\n12| 原文行`
 */
export function quoteForMessage(text, firstLine = null, limit = QUOTE_LIMIT) {
  /**
   * 紧凑摘要：与改前的渲染**逐字相同**（含 `(N more chars withheld)`）。
   * 为什么要逐字保留：失败重放器按 `the content there is: “…”` 取实证原文，
   * 形态一改，测量面就换了尺子 —— 而这条线（fail 174/173）正是本单的判据本身。
   */
  const flat = text.replace(/\r\n/g, '\u23ce').replace(/[\r\n]/g, '\u23ce')
  const preview =
    flat.length <= limit
      ? `\u201c${flat}\u201d`
      : `\u201c${flat.slice(0, limit)}\u2026\u201d (${flat.length - limit} more chars withheld)`

  const all = text.split(/\r\n|\r|\n/)
  if (all.length === 1) return preview

  /**
   * 忠实块：真换行 + 行号前缀。两层上限都必须有 ——
   * 只封字符时，一串空行能在 400 字符里塞进几百行；只封行数时，一行能塞进整份文件。
   */
  const rows = []
  let used = 0
  let cut = false
  for (const row of all) {
    if (rows.length >= QUOTE_MAX_LINES || (rows.length > 0 && used + row.length > limit)) {
      cut = true
      break
    }
    if (row.length > limit) {
      rows.push(`${row.slice(0, limit)}\u2026(${row.length - limit} more chars)`)
      used = limit
      cut = true
      continue
    }
    rows.push(row)
    used += row.length + 1
  }
  if (rows.length < all.length) cut = true

  const body = rows.map((row, i) => `${firstLine === null ? '' : `${firstLine + i}| `}${row}`).join('\n')
  const identity = firstLine === null ? QUOTE_VERBATIM_NOTE : QUOTE_VERBATIM_NOTE_GUTTERED
  /**
   * 块尾**自带换行**：回执里这一块后面往往还有别的句子（`(expect is shorter than …)`、
   * `, line 9-10 = …`、`. Add the surrounding lines as \`context\``…）。
   * 不留这个换行，那句话就粘在最后一行原文的尾巴上，于是"块到哪一行为止"变成**猜**出来的 ——
   * 而回抄恰恰要求边界是确定的（段A 的判据就是按 `N| ` 边距逐行取）。
   */
  return (
    `${preview} (${QUOTE_PREVIEW_NOTE}). ${identity}\n${body}\n` +
    (cut
      ? `(only ${rows.length} of ${all.length} line(s) shown \u2014 the rest was cut to stay inside this receipt's budget, so this block cannot be copied whole)\n`
      : '')
  )
}

/** 错误回执里引用的原文上限（字符）。超过就截断并明写截了多少。 */
const QUOTE_LIMIT = 400
/** 忠实块最多印几行：行数也要封顶（见 {@link quoteForMessage} 里那两层上限的理由）。 */
const QUOTE_MAX_LINES = 20
/**
 * 紧凑摘要的身份声明：**明确写出它不可回抄**。
 * 摘要长得像引文，不写这句，调用方就会照抄它 —— 而它恰恰是那份与原文不逐字的形态。
 */
const QUOTE_PREVIEW_NOTE = 'one-line preview, NOT copyable'
/**
 * 忠实块的身份声明：**明确写出这就是原文、可整段回抄**。
 * 行号前缀的身份也必须在这里写清：它是回执加的边距，不是文件内容（否则整块抄走必然失配）。
 */
const QUOTE_VERBATIM_NOTE_GUTTERED =
  'What follows is that same region verbatim, byte-for-byte \u2014 copy it as-is into expect. ' +
  'The `N| ` at the start of each line is a line number (the same numbering as the read receipt), not part of the file:'
const QUOTE_VERBATIM_NOTE =
  'What follows is that same region verbatim, byte-for-byte \u2014 copy it as-is into expect:'

/**
 * 回执里 `label`（通常是文件路径）的夹子 —— 它和回执正文**抢同一份体量预算**。
 *
 * 为什么必须有：`label` 的长度**不由本工具决定**（调用方给什么就是什么），而它与正文写在
 * 同一条消息里。不夹的话，一个病态长路径既能把同一份回执里的原文整段挤出去，也能把整条
 * 回执顶穿宿主阈值（`toolResultPruner.thresholdChars` = 8192）——超了中间会被静默剪掉，
 * 而回执里最有用的那一段恰在中间。实测：`old` 歧义那一支在 label 两万字符时交出 22479 字符。
 *
 * 夹过就在原地写明夹了多少字符，口径与 {@link quoteForMessage} 里那些截断说明一致：
 * 剪了什么、剪了多少，一律自己说出来，不静默丢。
 *
 * 这个函数**导出**，理由与 {@link quoteForMessage} 相同：`write-path.mjs` 的几处回执
 * （找不到 / `old` 歧义）也要夹同一个东西，各写一份等于同一件事有两份判定。
 *
 * @param label - 指代这份文件的说法
 * @param room - 这一处最多能给 `label` 多少字符（**含**披露句本身）
 * @returns 长度不超过 `max(room, 披露句长度)` 的 label
 */
export function clipReceiptLabel(label, room) {
  if (label.length <= room) return label
  const note = (n) => `\u2026(${n} more chars)`
  /** 披露句自己也占地方：先按它留出位置再夹，夹完的长度加披露句**不超过** `room`。 */
  const keep = Math.max(0, room - note(label.length).length)
  return `${label.slice(0, keep)}${note(label.length - keep)}`
}

/**
 * `label` 只有这一个落点（符号跨度拒信）时不与别的正文抢预算，直接给它一份上限。
 *
 * 取 6000 与 `write-path.mjs` 的 `NOTFOUND_RECEIPT_CHARS` 同值、同一条依据：
 * 6000 < 8192（宿主阈值），也 < 4096 + 1024 + 标记长度 —— 连“只留头窗”那种剪法也装得下。
 */
const RECEIPT_LABEL_CHARS = 6000

/**
 * `assert` 走"包含"放松所需的最短引文长度（按 {@link normSpace} 归一化后的字符数）。
 *
 * 为什么必须有这条下限：放松把判据从"受寻址区间**就是**这段文字"降成"受寻址区间**含有**这段文字"，
 * 而后者对一段极短引文几乎不构成证据——`}`、`return`、`const` 这类片段能被大量不同的区间包含，
 * "包含即通过"就等于把"防指到错的行"这道闸放空。蓝图 `fs-contract-v2` 的风险项点名的正是这个。
 *
 * 阈值不是拍的，按**风险预算**从语料里量出来：本仓库 67 个源文件、14305 条**全文件唯一**的归一化
 * 行文本里，长度 < 12 的占 4.54%（12 正是这个分布的 5% 分位，p0.05 = 12）。取 5% 作为预算的含义是：
 * **只有最短的那 ~5% 的行文本留在整段相等的严格判据下**，其余长度才允许"包含即通过"。
 * 量法可复现：逐行 `normSpace` → 按内容计数 → 只留全文件唯一的那些 → 取长度分位。
 *
 * 短于阈值的 `assert` **不放松**：退回改前的整段相等判据（更严，不是更松），失败回执里也会明写
 * 这条口径——否则"为什么这次严格"就成了调用方看不见的规则。
 */
export const ASSERT_RELAX_MIN_CHARS = 12

/**
 * 「调用方自己写出了坐标」的那一层 —— {@link expectVerdict} 唯一性分档的**唯一开关**（C17）。
 *
 * 为什么只有 `lines`：四层降级里，只有行号区间是**调用方断言的地址**，受寻址区间由它直接决定。
 * `symbol`（符号身份）/ `lineCue`（唯一词）/ `anchor`（文本锚点）三层的区间是引擎**按内容算出来**的
 * ——调用方给的是线索，区间是引擎猜的结果。`target` 与 `lines` 同时给时层1 取胜、坐标降为提示
 * （写路径的 `coordinateNote` 已经把这次降级如实披露），那一档因此仍按"没给坐标"判。
 * 判据回答的是"**这次命中的区间是不是调用方给的坐标**"，不是"请求里出现过坐标没有"——两个问题不同。
 */
const COORDINATE_TIER = 'lines'

/**
 * `assert`（工具层的 `expect`）与受寻址区间的关系判定。
 *
 * 判据从"整段相等"改成"**包含且唯一**"，两条都不是可选的：
 *   1. **唯一**：`assert` 归一化后在**整个文件**里必须只出现一处。能被许多位置包含的引文说明不了
 *      "你指的是哪一处"——那正是改前这道闸要防的"指到错的行"，放松后由唯一性接手。
 *      不唯一时拒绝：每一处的**行号 + 那行原文**都要进回执（本函数把它们算好放在 `places`，
 *      由调用方渲染）。DSH 框架只读 `error.message`（`dsh-tools/lib/index.js:2495-2503`），
 *      所以位置既要挂 `candidates` 供壳层渲染，也必须落进 message 才真能被模型看见。
 *   2. **包含**：那处唯一出现必须落在受寻址区间内——即区间**含有**这段文字。
 *      区间比引文窄（引文跨更多行）也落在这一条上：区间没有涵盖它，判不过。
 *      口径写死在这里，而不是"引文比区间宽就放过"：那会把判定变成对称的重叠判定，
 *      引文与区间各说各话也算通过，这道闸就空了（判据脚本段B/段F 钉的就是它）。
 *
 * 短于 {@link ASSERT_RELAX_MIN_CHARS} 的引文走**改前的整段相等**判据，不参与放松，
 * 且在拒绝时明写原因。它对区间的要求只会更严，因此不存在"静默放松"。
 *
 * ## 按地址形态分档（C17）
 *
 * 唯一性不是判据的目的，而是**「这个地址是否明确」的代理判据**：C1 把谓词从"整段相等"放松成
 * "包含"之后，由它接手改前这道闸真正防的事——"指到错的行"。既然是代理，就有**代理多余**的场合：
 * 调用方**自己写出了精确坐标**（`tier === 'lines'`）时，受寻址区间就是地址本身，
 * "这段文字在全文件还有没有第二处"不再提供任何关于"你指的是哪儿"的信息，却会实打实地误伤
 * ——坐标给准、引文也确实在区间里的调用被拒。
 *
 * 代价是**量出来的**，不是推的：成功集重放（`probes/success-regression.mjs`；读数见
 * `.polaris/workorders/fs-contract-v2.integrate4.success-regression.txt` 第 60-75 行）里，
 * 旧契约下成功、新契约被拒的 Z=7 条**全部**是 `lines` 寻址 + `LOCATOR_ASSERT_MISMATCH`，
 * 且 7 条的引文都逐字等于受寻址区间（旧契约要求整段相等）。分档后这一支一律通过，
 * 顺带省掉 `normLines`/`join`/`indexOf` 那次全文件扫描——它本来只为"数处数"而做。
 *
 * 分档的**边界**，两条都不许跟着放松：
 *   1. **区间内不含该文本时仍必须拒绝**。这是防陈旧寻址的闸门，也是这道判据存在的理由：
 *      调用方拿旧视图给的坐标，若区间里根本没有他说的那段文字，唯一性放不放松都救不了，
 *      必须拒。`short_mismatch` / `not_unique` / `nowhere` / `spans_wider` / `outside` 五支一字未动。
 *   2. **没给坐标、只给线索时仍必须要求唯一**（`symbol` / `lineCue` / `anchor` 三层，
 *      以及**不传**第 6 参的旧调用）。那里区间是引擎猜的，引文不唯一就判不出"你指的是哪一处"
 *      ——正是 C1 当初需要唯一性的场合，分档不动它。
 *
 * 短于 {@link ASSERT_RELAX_MIN_CHARS} 的引文**不分档**：仍判整段相等，给了坐标也一样（更严，不是更松）。
 *
 * 本档与 C1 的终态在同一组形状上结论相反（C1 的判据脚本 `assert-contains-test.mjs` 段C/段F 钉的
 * 正是"坐标已给准、区间也含引文、但引文全文两处 ⇒ 拒绝"），这份冲突与实测翻转清单记在
 * `expect-address-form-test.mjs` 的函数头与 C17 回执里——那份判据脚本不在本单的写范围内，不静默改它。
 *
 * ## 为什么返回「结论」而不是「回执」（C10：判据单源化）
 *
 * 这份判据有**两个**调用方：`locate()` 的 `assert` 闸门（{@link assertVerdict}）与写路径的
 * `expect` 闸门（`write-path.mjs` 的 hunk 路径）。改前它们各写了一份谓词——一份"包含且唯一"、
 * 一份"整段相等"——于是**同一个 `expect` 在两条路径上判出两种结果**：片段引文在 `locate()` 里
 * 通过，经 `planHunks` 的三种 `lines` 写法全被拒（实测读数见 `expect-single-source-test.mjs`）。
 * 所以本函数只回答"判据的结论是什么"，把回执形状（码与文案）留给调用方：**一份判据，两处引用**。
 *
 * @param lines - 已切好的行数组（与 `lines=` 用的是同一份，CRLF 已处理）
 * @param startLine - 受寻址区间起点（1-based，用于重叠判定与"引文比区间宽"的披露）
 * @param endLine - 受寻址区间终点（1-based）
 * @param actual - 受寻址区间原文
 * @param expectText - 调用方给的内容断言
 * @param tier - 可选：这次命中是哪一层给的（`locate()` 的 `tier`）。`'lines'` = 调用方给的精确坐标
 *   直接决定了区间 ⇒ 唯一性免掉；其余取值与**不传**同义 ⇒ 唯一性照旧（旧调用不必改一个字）。
 * @returns {null} 通过；否则 `{kind, want, have, places, spans, regionLines, at?, overlaps?}`——
 *   `kind` ∈ `short_mismatch`（短引文不放松，且与区间不整段相等）/ `not_unique`（全文多处）/
 *   `nowhere`（全文没有）/ `spans_wider`（引文比区间宽）/ `outside`（唯一出现处不在区间内）；
 *   `places` 是候选清单的**唯一形状** `[{line, endLine, text}]`（`text` 为该处首行原文，不 trim）。
 */
export function expectVerdict(lines, startLine, endLine, actual, expectText, tier = null) {
  /**
   * 引文首尾的空行是**构造伪影**，不是内容：受寻址区间的 `actual` 是 `lines.slice(a-1,b).join('\n')`，
   * 按构造**永远不带**首尾换行。于是调用方写 `expect: "<整行>\n<整行>\n"`（把行尾一并引上）时，
   * 无论它多正确都不可能被包含——一个系统性的假阴性（实测：CRLF 文件里引两整行必被拒）。
   * 这里把首尾换行去掉再判，两边就同一尺度了。只剪换行、不剪空格：行内与行首空格由
   * {@link normSpace} 折叠，那部分语义不变。
   * 剪完可能为空串（引文只有空行），此时长度必小于阈值，会走下面「整段相等」那一支，
   * 空针不会进全文扫描。
   */
  const want = normSpace(expectText).replace(/^\n+/, '').replace(/\n+$/, '')
  const have = normSpace(actual)
  const spans = want.split('\n').length
  const regionLines = endLine - startLine + 1

  // ── 短引文：不放松，仍旧判"整段相等"（改前的谓词原样保留；有坐标也一样）
  if (want.length < ASSERT_RELAX_MIN_CHARS) {
    return have === want ? null : { kind: 'short_mismatch', want, have, places: [], spans, regionLines }
  }

  /**
   * ── 有坐标：区间本身就是地址 ⇒ 唯一性这一档免掉（C17；理由与边界见函数头）
   *
   * 这一支放在全文件扫描**之前**：通过就是通过，没有回执要渲染，`places` 用不上，
   * 于是连那次全文件扫描也一并省了（带 expect 的语料里凡是坐标已给准的都走这一支）。
   * 让掉的只有唯一性这一条 —— `have.includes(want)`（区间确实含有这段文字）一字不让：
   * 少了它，这道闸就只剩"文件里随便哪儿有这段字"，防陈旧寻址的职责当场落空。
   */
  if (tier === COORDINATE_TIER && have.includes(want)) return null

  /**
   * 全文件出现位置：与判据**同一套归一化**（{@link normSpace} 逐行折叠、保留换行），
   * 而且用的是 `lines` 那一份（不是重新 split 全文）——CRLF 文件下两处若各自按自己的方式断行，
   * 同一个"第 7 行"会指向不同字节，这正是本项目已经栽过一次的那类不一致。
   * 归一化保留行结构，因此命中偏移能一一映射回行号。
   */
  const normLines = lines.map((line) => normSpace(line))
  const hay = normLines.join('\n')
  const offsets = []
  for (let i = 0, off = 0; i < normLines.length; i += 1) {
    offsets.push(off)
    off += normLines[i].length + 1
  }
  const lineAt = (offset) => {
    let i = offsets.length - 1
    while (i > 0 && offsets[i] > offset) i -= 1
    return i + 1
  }
  const places = []
  const seen = new Set()
  for (let p = hay.indexOf(want); p !== -1; p = hay.indexOf(want, p + 1)) {
    const first = lineAt(p)
    const last = lineAt(p + want.length - 1)
    const key = `${first}-${last}`
    if (seen.has(key)) continue
    seen.add(key)
    // 原文（不 trim）：缩进本身就是模型用来对照回执的信息
    places.push({ line: first, endLine: last, text: lines[first - 1] })
  }

  // ── 不唯一：多处都能对上 ⇒ 这段引文说明不了"你指的是哪一处"（唯一性是放松的前提）
  if (places.length > 1) return { kind: 'not_unique', want, have, places, spans, regionLines }

  // ── 全文没有：比"对不上"更可执行的说法
  if (places.length === 0) return { kind: 'nowhere', want, have, places: [], spans, regionLines }

  // ── 唯一且被区间包含：通过
  if (have.includes(want)) return null

  const at = places[0]
  /**
   * 相对位置必须说准：真的不重叠才能说"在区间外"。引文与区间**部分重叠**时（区间 4-5、引文 5-6），
   * 说"在区间外"会与调用方看到的行号自相矛盾——第 5 行明明就在区间里。
   */
  const overlaps = at.line <= endLine && at.endLine >= startLine
  return {
    kind: spans > regionLines ? 'spans_wider' : 'outside',
    want,
    have,
    places,
    spans,
    regionLines,
    at,
    overlaps,
  }
}

/**
 * `locate()` 的失败回执：读 {@link expectVerdict} 的结论，渲染成既有的回执形状。
 *
 * 消息在 C10 前后**逐字不变**（C1 的判据脚本按子串钉着它们：`spans 3 lines`、`widen lines=`、
 * `line 12 =`、`nowhere in this file`、`shorter than 12 chars`、`only partly overlaps` …），
 * 变的只有判据的来源：从"这里现算一份"改成"读那一份结论"。
 *
 * 走到最后那一支时恰好一处（0 处与多处都在 {@link expectVerdict} 里分了支），所以正文可以直接说
 * "唯一出现处"——不写 `places.length === 1 ? ... : ...` 那种永远取同一支的三元
 * （那正是本项目的"死字段"形态）。
 *
 * @returns {null} 通过；否则 `{ok:false, code, message, actual, candidates?}`
 */
function assertVerdict(lines, startLine, endLine, tier, actual, assertText) {
  const bad = expectVerdict(lines, startLine, endLine, actual, assertText, tier)
  if (bad === null) return null
  const where = `lines ${startLine}-${endLine} via ${tier}`
  const there = `the content there is: ${quoteForMessage(actual, startLine)}`

  // ── 短引文不放松，且与区间不整段相等
  if (bad.kind === 'short_mismatch') {
    return {
      ok: false,
      code: 'LOCATOR_ASSERT_MISMATCH',
      message:
        `${where} do not match assert — ${there} ` +
        `(expect is shorter than ${ASSERT_RELAX_MIN_CHARS} chars, so it must equal the addressed region exactly)`,
      actual,
    }
  }

  // ── 不唯一：拒绝，并点出每一处（行号 + 那行原文），要求补上下文
  if (bad.kind === 'not_unique') {
    return {
      ...failure(
        'LOCATOR_ASSERT_MISMATCH',
        `${where}: expect is not unique in this file — it appears on ${bad.places.length} places, so it cannot ` +
          `say WHICH one you mean; quote more of the surrounding text (or address it with target= / line_cue=) ` +
          `so that it is unique — ${there}`,
        bad.places,
      ),
      actual,
    }
  }

  // ── 全文没有
  if (bad.kind === 'nowhere') {
    return {
      ok: false,
      code: 'LOCATOR_ASSERT_MISMATCH',
      message: `${where} do not contain expect — it appears nowhere in this file (whole-file scan, whitespace-normalized) — ${there}`,
      actual,
    }
  }

  // ── 引文比区间宽：明写这条口径，并给出两条可执行的修正方向（不猜、也不"大概齐"放过）
  if (bad.kind === 'spans_wider') {
    return {
      ok: false,
      code: 'LOCATOR_ASSERT_MISMATCH',
      message:
        `${where} do not contain expect — expect spans ${bad.spans} lines but the addressed region is ` +
        `${bad.regionLines} line(s) (lines ${bad.at.line}-${bad.at.endLine} hold it); widen lines= to cover the whole ` +
        `quote, or trim expect down to the addressed text — ${there}`,
      actual,
    }
  }

  // ── 唯一出现处不落在区间内（outside；部分重叠时也不能说"在区间外"）
  const at = bad.at
  return {
    ok: false,
    code: 'LOCATOR_ASSERT_MISMATCH',
    message:
      `${where} do not contain expect — its only occurrence in this file is ` +
      `${at.line === at.endLine ? `line ${at.line}` : `lines ${at.line}-${at.endLine}`}, which ` +
      (bad.overlaps
        ? `only partly overlaps the addressed region (the quote has to fit entirely inside it)`
        : `is outside the addressed region`) +
      ` — ${there}`,
    actual,
  }
}

/**
 * 意图地址（T16）的符号子串匹配：这个候选符号离 `near` 有多远。
 *
 * 判据只有一条：**`near` 落在符号的跨度里就是 0**，否则取到两端中较近的那一端。
 * 与 `resolveTarget` 的 `|startLine - near|` 刻意不同：`intent` 匹配的是"大概想改哪个符号"，
 * 调用方给的 `near` 常常是**符号体内**的一行（它刚从 read 回执里抄来），拿起点算距离会把
 * 一个明显在说的符号判成第二近。跨度包含 `near` ⇒ 距离 0，是这里唯一能自洽的口径。
 *
 * @param - 符号投影（含 startLine / endLine）
 * @param near - 1-based 行号提示
 * @returns 非负整数距离
 */
function symbolDistanceFrom(symbol, near) {
  if (near >= symbol.startLine && near <= symbol.endLine) return 0
  return Math.min(Math.abs(near - symbol.startLine), Math.abs(near - symbol.endLine))
}

/**
 * 多个子串命中里，`near` 能否**严格**收敛到一个（唯一最小值）。
 *
 * 不唯一（并列最小）⇒ null：那正是"该报歧义"的形状，猜测在这里比拒绝贵得多。
 * @returns 命中的符号，或 null（near 没给 / 并列）
 */
function nearestSymbolBySpan(symbols, near) {
  let best = null
  let bestDistance = Infinity
  let ties = 0
  for (const symbol of symbols) {
    const distance = symbolDistanceFrom(symbol, near)
    if (distance < bestDistance) {
      bestDistance = distance
      best = symbol
      ties = 1
    } else if (distance === bestDistance) ties += 1
  }
  return ties === 1 ? best : null
}

/**
 * 定位一个区间。五层降级：意图 → 符号身份 → 行号 → 唯一词 → 文本锚点。
 *
 * `intent`（T16）是**最弱但最自然**的一层：调用方给一个符号名片段、短语或近似原文，
 * 引擎先当符号名解析（精确/限定写法），再按符号名子串匹配，最后才落到文本匹配。
 * 每一档都**确定性地**收敛到一个区间；收敛不了就报歧义并给候选，不猜。
 *
 * @param source - 文件全文
 * @param request - `intent` / `target` / `lines` / `lineCue` / `anchor` 五选一，外加 `near` 与 `assert`
 * @returns 命中时 `{ok: true, startLine, endLine, tier, actual}`；未命中时 `{ok: false, code, message, ...}`。
 *   `actual` 是该区间的原文，供调用方核对或展示。
 */
export function locate(source, request = {}) {
  const lines = source.split(/\r?\n/)
  const slice = (start, end) => lines.slice(start - 1, end).join('\n')
  const filePath = request.filePath ?? null
  const lang = filePath === null ? null : langOf(filePath)

  /**
   * @param byNear - 这次命中是否靠 `near` 从歧义里收敛出来的（见 anchor-core 的四个产出点）。
   *   必须透传：工具回执的 `by near` 标记、以及由此给出的"下次直接用确定地址"建议都靠它。
   *   此前本函数只回 `{startLine, endLine, tier, actual}`，把引擎算好的 `byNear` 丢在中间——
   *   于是 `aura_basetools_edit` 渲染的 `by near` **恒为 false**（字段被声明必填、被渲染、却永远不出现），
   *   降级命中对模型完全不可见。这是本项目最典型的"双义字段/死字段"形态。
   */
  const done = (startLine, endLine, tier, byNear = false) => {
    if (request.assert !== undefined && request.assert !== null) {
      const actual = slice(startLine, endLine)
      /**
       * 把**实际内容**写进 message，而不是只报"不符"。
       *
       * 实测依据（11k 条真实调用）：`expect` 不符 388 条，而**回执里贴出实际内容的 0 条**，
       * 于是模型只能盲重试——161 组"参数完全相同的重复失败"，最高一组撞 17 次，
       * 其中 202 次多余重试属于这一类。它拿到"不符"三个字，却拿不到可用于修正的信息。
       *
       * 为什么必须写进 **message** 而不是挂成结构化字段：DSH 框架对抛出的错误
       * 只取 `error.message`（`dsh-tools/lib/index.js:2495-2503` 的 `errorMessage`），
       * 其余字段（`candidates` / `minimal_next` 等）**框架一律不读**。
       * 所以对"让模型看见"而言，message 是唯一有效的通道。
       *
         * 引用方式见 {@link quoteForMessage}：紧凑摘要一行（`⏎` 标出换行）**明写不可回抄**，
         * 忠实块（真换行 + 行号前缀）**明写可整段回抄进 expect**；两份都截断到 {@link QUOTE_LIMIT}
         * 并明写省略了多少字符（改前只有摘要那一种形态，而它与原文不逐字 —— 实测 F0275）。
       *
       * 判据本体在 {@link assertVerdict}：**包含且唯一**（短引文例外，仍要求整段相等）。
       * 这里曾经是 `normSpace(actual) !== normSpace(request.assert)`——"整段相等"，
       * 于是模型只要把 `expect` 写成区间里的一段（真实调用里最常见的写法：它只记得住那一行），
       * 就必被拒。改后包含即通过，而"不唯一时拒绝"把改前真正防的那件事（指到错的行）接了下来。
       * 上面这五条对新回执同样成立：每一条失败消息都仍然自带区间原文。
       */
      const bad = assertVerdict(lines, startLine, endLine, tier, actual, request.assert)
      if (bad !== null) return bad
    }
    return {
      ok: true,
      startLine,
      endLine,
      tier,
      ...(byNear ? { byNear: true } : {}),
      actual: slice(startLine, endLine),
    }
  }

  /**
   * 符号地址落在“整行区间比声明更宽”的行上 ⇒ 拒绝，不能把行内别的代码一起删掉。
   *
   * 这是 `LOCATOR_LINE_SHARED` 的另一半：同族判据（同一行还有别人），但“别人”
   * 不一定是符号表里的兄弟——`import` / 指令 / 调用语句根本不是符号。
   */
  const sharedLineRefusal = (hit, shared, byWhat) => {
    const label = clipReceiptLabel(filePath === null ? 'this file' : filePath, RECEIPT_LABEL_CHARS)
    const advice = 'use old= with a unique fragment, handle=, or rewrite the whole file explicitly — nothing was written'
    const message =
      shared.side === 'header'
        ? `cannot address "${hit.name}" by ${byWhat} in ${label}: the declaration starts on line ${shared.line} (${JSON.stringify(shared.text)}), so the addressed span would begin after its header and leave it behind; use lines= covering line ${shared.line}, or ${advice}`
        : `cannot address "${hit.name}" by ${byWhat} in ${label}: line ${shared.line} also holds ${JSON.stringify(shared.text)} ${shared.side === 'before' ? 'before' : 'after'} the declaration, so replacing the symbol's whole-line span would delete it; ${advice}`
    return { ok: false, code: 'LOCATOR_LINE_SHARED', message, shared }
  }

  // ── 第 0 层：意图地址（T16）。调用方给一段模糊的意图串，引擎确定性地落成精确区间。
  //
  // 解析次序（每一档都不猜，落不下来就报歧义并给候选）：
  //   ① 已知语言时，先当符号名解析（`resolveTarget` 的精确 / 限定写法）——命中就算 symbol 档；
  //   ② 符号名没对上（或对上多个）⇒ 按符号名**子串**匹配（先区分大小写，再忽略大小写）；
  //   ③ 一个符号都没命中（或语言未知）⇒ 落到文本匹配（`locateWith`，与 `anchor` 同一份引擎）。
  //
  // 顺序上刻意在 `target` 之前：`intent` 与其余地址字段**互斥**（`PATCH_INTENT_CONFLICT`，
  // 由 `planHunks` 判），所以两者同时到达这里是不可能的；放在最前只是把"intent 自成一层"写明。
  if (typeof request.intent === 'string' && request.intent.trim().length > 0) {
    const intent = request.intent.trim()
    const near = request.near ?? null
    const label = clipReceiptLabel(filePath === null ? 'this file' : filePath, RECEIPT_LABEL_CHARS)
    /** 跨度覆盖不了符号体时的拒绝——与 `target=` 那一支**同一句话、同一个码**（不是第二套说法）。 */
    const spanIncomplete = (hit) => ({
      ok: false,
      code: 'LOCATOR_SPAN_INCOMPLETE',
      message: `cannot address "${hit.name}" by intent in ${label}: the span does not cover the body — ${hit.spanNote}; address it with lines= or line_cue= instead`,
      hint: directoryHint(source, lang),
    })
    if (lang !== null) {
      const index = indexStructure(source, lang)
      /**
       * 精确/限定符号：先**不带 near** 解析，拿到唯一命中或完整候选。
       * 带 near 交给 `resolveTarget` 会用“起点距离”，与 intent 档的“跨度包含 near 记 0”冲突，
       * 实测会把 near 落在第一个长函数体内的情况选到第二个同名函数上。歧义时这里用
       * `nearestSymbolBySpan` 按跨度收敛；解析不了再落到子串匹配。
       */
      let exact = null
      try {
        exact = resolveTarget(index, intent, null)
      } catch (error) {
        if (error.code === 'STRUCT_AMBIGUOUS') {
          const candidates = Array.isArray(error.candidates) ? error.candidates : []
          if (near !== null && near !== undefined) {
            const chosen = nearestSymbolBySpan(candidates, near)
            if (chosen !== null) {
              if (chosen.spanComplete === false) return spanIncomplete(chosen)
              return done(chosen.startLine, chosen.endLine, 'intent~symbol', true)
            }
          }
          return failure('LOCATOR_INTENT_AMBIGUOUS', `intent ${JSON.stringify(intent)}: ${error.message}`, candidates)
        }
        // STRUCT_NOT_FOUND / 其它：符号名没猜中不是终点，落到子串匹配（下面）。
      }
      if (exact !== null) {
        if (exact.spanComplete === false) return spanIncomplete(exact)
        const shared = sharedLineContent(source, index, exact, lang)
        if (shared !== null) return sharedLineRefusal(exact, shared, 'intent')
        return done(exact.startLine, exact.endLine, 'intent~symbol')
      }
      // 用原始符号表而不是 `listSymbols` 投影：整行区间是否越界要看 token，投影里没有。
      const symbols = index.symbols
      let matches = symbols.filter((s) => s.name.includes(intent))
      if (matches.length === 0) {
        const lower = intent.toLowerCase()
        matches = symbols.filter((s) => s.name.toLowerCase().includes(lower))
      }
      if (matches.length === 1) {
        const only = matches[0]
        if (only.spanComplete === false) return spanIncomplete(only)
        const shared = sharedLineContent(source, index, only, lang)
        if (shared !== null) return sharedLineRefusal(only, shared, 'intent')
        return done(only.startLine, only.endLine, 'intent~symbol')
      }
      if (matches.length > 1) {
        if (near !== null && near !== undefined) {
          const chosen = nearestSymbolBySpan(matches, near)
          if (chosen !== null) {
            if (chosen.spanComplete === false) return spanIncomplete(chosen)
            const shared = sharedLineContent(source, index, chosen, lang)
            if (shared !== null) return sharedLineRefusal(chosen, shared, 'intent')
            return done(chosen.startLine, chosen.endLine, 'intent~symbol', true)
          }
        }
        const why =
          near === null || near === undefined
            ? `intent ${JSON.stringify(intent)} matched ${matches.length} symbols — pick one with target=<name>, or add near=<line>`
            : `intent ${JSON.stringify(intent)} matched ${matches.length} symbols and near=${near} did not single one out`
        return failure(
          'LOCATOR_INTENT_AMBIGUOUS',
          why,
          matches.map((s) => ({
            name: s.name,
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
            enclosing: s.enclosing,
          })),
        )
      }
    }
    // ── ③ 文本兜底：与 `anchor` 同一份引擎（`locateWith`）；tier 里带上它命中的那一档
    try {
      const loc = locateWith(indexFile(source), intent, near)
      return done(loc.start + 1, loc.end, `intent~text~${loc.tier}`, loc.byNear === true)
    } catch (error) {
      if (error.code === 'PATCH_AMBIGUOUS') {
        /**
         * 行候选统一成 `{line, text}`（`failure` 只认这一形状才会印出行号与原文）：
         * `locateWith` 抛的是 `number[]`，直接递下去会印成 `line undefined`。
         */
        const listed = (Array.isArray(error.candidates) ? error.candidates : [])
          .filter((n) => typeof n === 'number' && n >= 1 && n <= lines.length)
          .map((n) => ({ line: n, text: lines[n - 1].slice(0, 80) }))
        return failure('LOCATOR_INTENT_AMBIGUOUS', `intent ${JSON.stringify(intent)}: ${error.message}`, listed)
      }
      if (error.code === 'PATCH_NOT_FOUND' || error.code === 'PATCH_EMPTY_ANCHOR') {
        return {
          ok: false,
          code: 'LOCATOR_INTENT_NOT_FOUND',
          message: `no symbol or text matches intent ${JSON.stringify(intent)} in ${label}; try target=<name>, lines=, or line_cue=`,
          // 符号目录是实测支撑的恢复路径（与 anchor 失败同一条）：只有认识这门语言时才给得出。
          ...(lang === null ? {} : { hint: directoryHint(source, lang) }),
        }
      }
      return failure(error.code ?? 'LOCATOR_FAILED', error.message, error.candidates)
    }
  }

  // ── 第 1 层：符号身份。不读文本，因此对内容记错免疫。
  if (typeof request.target === 'string' && request.target.trim().length > 0) {
    if (lang === null) {
      return { ok: false, code: 'LOCATOR_NO_LANGUAGE', message: 'target= needs a recognized file extension' }
    }
    /**
     * lone CR：符号索引按 `\n` 数行，老式 Mac 文件整份是“一行”，`target` 落成 1-1 后
     * 会把整个文件替换成一个符号。行号地址在这种情况下没有第二个行模型可校验，
     * 必须在定位前拒绝，而不是用错误的行号去改。
     */
    if (hasLoneCarriageReturn(source)) {
      return failure(
        'LOCATOR_LONE_CR',
        `cannot address "${request.target}" by target in ${clipReceiptLabel(filePath, RECEIPT_LABEL_CHARS)}: this file uses lone CR (\\r) line endings, so line/span addresses point at different bytes than a \\n line model; use old= (verbatim fragment) or handle=, or rewrite the whole file explicitly — nothing was written`,
      )
    }
    try {
      const index = indexStructure(source, lang)
      const hit = resolveTarget(index, request.target, request.near ?? null)
      /**
       * 跨度覆盖不了符号体时必须**拒绝**，不能退化成"只有签名行"。
       *
       * 这是本工具最贵的一个静默失效：`target=<函数名>` 只换掉签名行、旧函数体原样留下，
       * 而 `python -m py_compile` 一样返回 0——没有任何错误信号。拒绝会让调用方立刻看见
       * 失败，并把恢复路径（`lines=` / `line_cue=`）写进消息里。
       */
      if (hit.spanComplete === false) {
        return {
          ok: false,
          code: 'LOCATOR_SPAN_INCOMPLETE',
          message: `cannot address "${hit.name}" by target in ${clipReceiptLabel(filePath, RECEIPT_LABEL_CHARS)}: the span does not cover the body — ${hit.spanNote}; address it with lines= or line_cue= instead`,
          hint: directoryHint(source, lang),
        }
      }
      /**
       * 同一行还有**同级符号** ⇒ `target` 落到的整行区间会连它一起删掉。
       * 压缩代码里两个顶层函数同为 1-1 是实测形态；名字命中不代表“只改这个名字”。
       */
      const siblings = siblingSymbolsOnSameSpan(index, hit)
      if (siblings.length > 0) {
        const names = siblings.map((s) => `${s.kind} ${s.name} (line ${s.startLine})`).join(', ')
        return {
          ...failure(
            'LOCATOR_LINE_SHARED',
            `cannot address "${hit.name}" by target in ${clipReceiptLabel(filePath, RECEIPT_LABEL_CHARS)}: line ${hit.startLine} also holds ${names}, so replacing the symbol's whole-line span would delete them; use old= with a unique fragment, handle=, or rewrite the whole file explicitly — nothing was written`,
            siblings.map((s) => ({ name: s.name, kind: s.kind, enclosing: s.enclosing, startLine: s.startLine, endLine: s.endLine })),
          ),
          hint: directoryHint(source, lang),
        }
      }
      /** 兄弟符号之外，行内还可能有 `import` / 指令 / 调用语句：同一个判据，看字节。 */
      const shared = sharedLineContent(source, index, hit, lang)
      if (shared !== null) return sharedLineRefusal(hit, shared, 'target')
      return done(hit.startLine, hit.endLine, 'symbol')
    } catch (error) {
      return {
        ...failure(error.code ?? 'LOCATOR_FAILED', error.message, error.candidates),
        hint: directoryHint(source, lang),
      }
    }
  }

  // ── 第 2 层：行号区间。模型从 read / grep 的输出里直接抄，不需要回忆内容。
  if (request.lines !== undefined && request.lines !== null) {
    const start = request.lines.start
    const end = request.lines.end ?? request.lines.start
    /**
     * 只有**显式整份写**（`aura_basetools_write` 的内部 wholeFile 请求）能越过 lone CR 闸：
     * 它替换的是整个文件的字节，不依赖行号模型。普通 `lines=[1,1]` 仍拒绝。
     */
    const wholeFile = request.allowLoneCr === true && start === 1 && end === lines.length
    if (!wholeFile && hasLoneCarriageReturn(source)) {
      return failure(
        'LOCATOR_LONE_CR',
        `cannot address lines ${start}-${end} in ${clipReceiptLabel(filePath, RECEIPT_LABEL_CHARS)}: this file uses lone CR (\\r) line endings, so line numbers do not describe the bytes a \\n line model sees; use old= (verbatim fragment) or handle=, or rewrite the whole file explicitly — nothing was written`,
      )
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { ok: false, code: 'LOCATOR_BAD_LINES', message: 'lines.start / lines.end must be integers' }
    }
    if (start < 1 || end < start || end > lines.length) {
      return {
        ok: false,
        code: 'LOCATOR_OUT_OF_RANGE',
        message: `lines ${start}-${end} is outside 1..${lines.length}${loneCarriageReturnNote(source)}`,
      }
    }
    return done(start, end, 'lines')
  }

  // ── 第 3 层：单词线索。要求全文件唯一；不唯一就报歧义，绝不猜。
  if (typeof request.lineCue === 'string' && request.lineCue.trim().length > 0) {
    const cue = request.lineCue.trim()
    const hits = []
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(cue)) hits.push(i + 1)
    }
    if (hits.length === 0) {
      return { ok: false, code: 'LOCATOR_CUE_NOT_FOUND', message: `no line contains ${JSON.stringify(cue)}` }
    }
    if (hits.length > 1) {
      if (request.near !== undefined && request.near !== null) {
        const near = request.near
        let best = hits[0]
        let bestD = Infinity
        let ties = 0
        for (const h of hits) {
          const d = Math.abs(h - near)
          if (d < bestD) {
            bestD = d
            ties = 1
            best = h
          } else if (d === bestD) ties += 1
        }
        // 靠 `near` 从多个候选里收敛到一个：这也是"按提示命中"，与锚点层同义
        if (ties === 1) return done(best, best, 'lineCue', true)
      }
      return failure(
        'LOCATOR_CUE_AMBIGUOUS',
        `${JSON.stringify(cue)} appears on ${hits.length} lines`,
        hits.map((line) => ({ line, endLine: line, text: lines[line - 1].trim().slice(0, 80) })),
      )
    }
    // 唯一命中：这正是 lineCue 设计上最常见的情形。
    // 这一行曾在一次按行号区间的编辑里被误删，后果是**每个唯一线索都报
    // LOCATOR_NO_REQUEST**（"provide one of: target, lines, lineCue, anchor"）——
    // 提示信息与真正的原因完全无关，且看起来像调用方没给参数。
    return done(hits[0], hits[0], 'lineCue')
  }

  // ── 第 4 层：文本锚点。容错性最好，但要求模型复现内容。
  if (typeof request.anchor === 'string' && request.anchor.length > 0) {
    try {
      const loc = locateWith(indexFile(source), request.anchor, request.near ?? null)
      return done(loc.start + 1, loc.end, loc.tier, loc.byNear === true)
    } catch (error) {
      return {
        ...failure(error.code ?? 'LOCATOR_FAILED', error.message, error.candidates),
        // 锚点失败时给出符号目录——这是实测支撑的恢复路径。
        // 注：`hint` 走的是结构化字段，只有把它拼进 message 的调用方（如 aura_basetools_edit
        // 的 symbolHint）才真能让模型看到；aura_basetools_read 直接透传 message，所以真正
        // 抵达模型的是上面那条 message。
        ...(lang === null ? {} : { hint: directoryHint(source, lang) }),
      }
    }
  }

  return { ok: false, code: 'LOCATOR_NO_REQUEST', message: 'provide one of: intent, target, lines, lineCue, anchor' }
}

/**
 * 单 `\r`（老 Mac 行尾）文件的拒绝说明：这类文件在本工具里**整份算一行**。
 *
 * 为什么不干脆按 `\r` 也断行：行号是**跨层共享**的判据——符号表那一层（`struct-core` 的
 * `lineIndexFor`）只按 `\n` 数行，而它不在本组件的改动范围内。若只有这里按 `\r` 断行，
 * 同一个文件的“第 1 行”在两个层里会指向不同字节，`target=` 算出来的区间就会**静默**指错地方
 * （比现在“拒绝”坏得多）。因此结论是：不支持单 `\r` 行尾，但拒绝信息必须点名原因，
 * 并给出真能用的替代：整份替换 `lines=[1,1]`，或 `line_cue` / `anchor`。
 *
 * @param source - 文件全文
 * @returns 追加到错误消息后的说明；不含单 `\r` 时为空串
 */
function loneCarriageReturnNote(source) {
  if (!hasLoneCarriageReturn(source)) return ''
  return ' — this file uses lone CR (\\r) line endings, which are not treated as line breaks here (the symbol index counts lines by \\n, so a second line model would point at different bytes); address it with line_cue/anchor, or replace the whole file with lines=[1,1]'
}

/** 声明前缀里本来就属于声明的标点（指针/引用/泛型/命名空间/可空修饰）。 */
const DECL_PREFIX_PUNCT = new Set(['*', '&', '<', '>', ',', '::', '?', ':', '~', '.'])

/** 允许“包住声明”的开括号：Lisp 族的 `(defn …)`。`{` 不算（JS/C 的块不是声明本身）。 */
const FORM_OPENERS = new Map([['(', ')'], ['[', ']']])

/**
 * 整行替换会把声明之外的内容一起删掉的那些行。
 *
 * `siblingSymbolsOnSameSpan` 只看得见符号表里的兄弟；`import` / 指令 / 调用语句
 * 根本不是符号，却同样会被整行替换删掉（实测：`import fs from 'fs'; function alpha()`
 * 上 `target=alpha` 会把 import 一起删掉）。判据回到字节：
 *   · 声明起点之前：只允许空白与**包住这个声明**的开括号（Lisp 族的 `(defn …)`）；
 *   · 声明终点之后：只允许空白、分号、注释与包住这个声明的闭括号。
 * 其余任何 token（`import` / `return` / 另一条语句）都说明这一个行区间不止这个声明。
 *
 * @returns `{line, side:'before'|'after'|'header', text}`，或 null（这一行只属于这个声明）
 */
function sharedLineContent(source, index, hit, lang) {
  const declStartTok = hit.declStartTok ?? hit.startTok
  const startToken = index.tokens[declStartTok]
  const endToken = index.tokens[hit.endTok]
  if (startToken === undefined || endToken === undefined) return null
  const startLine = index.lineAt(startToken.start)
  /**
   * C 家族：`$ident*` 吃不掉关键字返回类型，声明起点可能落在名字上（见 struct-core 的
   * `declStartUnknown`）。类型回到上一行时，行区间会把上一行留成悬空前缀——拒绝，不静默改。
   * 指令行（`#include`）与注解行（`@Override`）本来就不是声明头，不参与这条判据。
   */
  if (hit.declStartUnknown === true) {
    const prev = index.tokens[(hit.declStartTok ?? hit.startTok) - 1]
    if (prev !== undefined) {
      const prevLine = index.lineAt(prev.end)
      if (prevLine === startLine - 1 && ![';', '{', '}'].includes(prev.value)) {
        const prevLineStart = source.lastIndexOf('\n', prev.start - 1) + 1
        const prevLineEnd = source.indexOf('\n', prev.end)
        const prevLineText = source.slice(prevLineStart, prevLineEnd === -1 ? source.length : prevLineEnd)
        if (!/^\s*[#@]/.test(prevLineText)) {
          return { line: prevLine, side: 'header', text: prevLineText.trim().slice(0, 80) }
        }
      }
    }
  }
  /**
   * 声明起点之前、同一行里的 token。只有两类可以留：
   *   · **类型前缀**——仅当 `declStartUnknown`（C 家族把返回类型漏在声明起点之前）；
   *   · **包住声明的开括号**（Lisp 族）：它的闭括号会在后缀里出现。
   * 其余任何 token（`;` / `{` / `=` / 字符串 / `@` / 别的语句）都说明这一行不止这个声明。
   */
  const allowTypePrefix = hit.declStartUnknown === true
  const enclosing = new Map()
  for (let k = declStartTok - 1; k >= 0; k -= 1) {
    const token = index.tokens[k]
    if (index.lineAt(token.start) !== startLine) break
    if (allowTypePrefix && token.type === 'ident') continue
    if (allowTypePrefix && token.type === 'punct' && DECL_PREFIX_PUNCT.has(token.value)) continue
    if (token.type === 'punct' && FORM_OPENERS.has(token.value)) {
      // `close > endTok` 或 `close === endTok`：Lisp 的收尾 `)` 本身常是跨度的最后一个 token
      // （`(defn alpha [] 1)` 的 endTok 就是那个 `)`），开括号却仍在跨度之前。
      const close = index.pairs.get(k)
      if (close !== undefined && close >= hit.endTok) {
        const closer = FORM_OPENERS.get(token.value)
        enclosing.set(closer, (enclosing.get(closer) ?? 0) + 1)
        continue
      }
    }
    const lineStart = source.lastIndexOf('\n', startToken.start - 1) + 1
    return { line: startLine, side: 'before', text: source.slice(lineStart, startToken.start).trim().slice(0, 80) }
  }
  const endLine = index.lineAt(endToken.end)
  const lineEnd = source.indexOf('\n', endToken.end)
  const after = source.slice(endToken.end, lineEnd === -1 ? source.length : lineEnd)
  const rest = trailingForeign(after, lang, enclosing)
  if (rest !== '') return { line: endLine, side: 'after', text: rest.trim().slice(0, 80) }
  return null
}

/**
 * 声明终点之后同一行里还剩什么：空白、分号、注释、以及**包住声明的**闭括号不算别的代码。
 * 闭括号只在 `enclosing` 计数里出现（由前缀里那些开括号登记），所以 `function inner(){} }`
 * 这种“外层块的 `}` 落在同一行”不会被当成收尾。
 *
 * @returns 剩下的非平凡文本（空串 = 这一行到此为止只属于这个声明）
 */
function trailingForeign(text, lang, enclosing) {
  let rest = text
  const lineComments = lang?.lineComments ?? []
  const blockComments = lang?.blockComments ?? []
  for (;;) {
    rest = rest.replace(/^\s+/, '')
    if (rest === '') return ''
    if (lineComments.some((marker) => rest.startsWith(marker))) return ''
    const block = blockComments.find(([open]) => rest.startsWith(open))
    if (block !== undefined) {
      const close = rest.indexOf(block[1], block[0].length)
      if (close === -1) return rest
      rest = rest.slice(close + block[1].length)
      continue
    }
    // 分号单独处理：JS 家族是语句分隔符，Lisp 族已经在 lineComments 里提前返回。
    if (rest.startsWith(';')) {
      rest = rest.slice(1)
      continue
    }
    const closer = rest[0]
    const count = enclosing.get(closer) ?? 0
    if (count > 0) {
      enclosing.set(closer, count - 1)
      rest = rest.slice(1)
      continue
    }
    return rest
  }
}

/** 文件是否含**不跟 LF** 的 CR（老式 Mac 行尾）。只扫一次、不建第二套行模型。 */
function hasLoneCarriageReturn(source) {
  return /\r(?!\n)/.test(source)
}

/**
 * 同一行里的**同级符号**（会随整行替换一起消失的那些）。
 *
 * 符号投影只有行号、没有列；`target` 最终落到 `[startLine, endLine]` 整行区间。
 * 压缩代码里两个顶层函数同为 1-1 时，`target=alpha` 会静默删掉 `beta` —— 这是
 * “名字命中但实际替换整行”的最坏形态。这里只比较**同一 enclosing** 的符号：
 * 函数体内的局部变量（enclosing 指向函数）不算，否则每个单行函数都会被自己的变量误伤。
 */
function siblingSymbolsOnSameSpan(index, hit) {
  const scope = hit.enclosing ?? null
  return index.symbols.filter((symbol) => {
    if ((symbol.enclosing ?? null) !== scope) return false
    if (
      symbol.name === hit.name &&
      symbol.kind === hit.kind &&
      symbol.startLine === hit.startLine &&
      symbol.endLine === hit.endLine
    ) {
      return false
    }
    return symbol.startLine <= hit.endLine && symbol.endLine >= hit.startLine
  })
}

/**
 * 符号目录：失败时给调用方一条可执行的恢复路径。
 *
 * **排序依据与地图共用 `rankSymbols`**，这是必须的：先前这里用的是 `listSymbols().slice(0, 24)`，
 * 即**声明顺序**——而实测声明顺序与重要性零相关（前 24 个里 49% 是函数内局部量）。
 * 于是"恢复提示"给模型的恰恰是最没用的那些名字。我修了地图却漏了这里，
 * 原因就是同一个选择逻辑存在两份实现。现在只有一份。
 *
 * 深度上按预算收：目录也可能很长，超出内容预算的部分不入内，并如实报告总数。
 *
 * 收录条数**按字符预算填充**，不是一个拍死的条数上限。
 *
 * 先前这里写的是 `const HINT_LIMIT = 24`，注释自称"能放下的 24 个"——而**没有任何东西在量**：
 * 它既不是算出来的，也不随调用方的信封预算伸缩。后果是预算宽的宿主（错误消息很短、
 * 下游剪枝阈值很高）本来能容下 60 个候选、却只拿到 24 个，而穷尽的候选**正是恢复率最高的手段**
 * （实测：锚点失败里可被符号名救回的比例很高）。
 *
 * 现在：`budget` 是可选入参（字符），按序填充到装不下为止，并把"被截了多少"如实报出。
 * 缺省值保留 `DEFAULT_HINT_CHARS`，因此**所有现有调用方行为不变**——这是"可选但更强"。
 *
 * @param source - 文件全文
 * @param lang - 语言配置
 * @param budget - 可选的字符预算（缺省 `DEFAULT_HINT_CHARS`）
 * @returns {{symbols, total, shown, truncated, instruction}|null} 无符号时返回 null
 */
export function directoryHint(source, lang, budget = DEFAULT_HINT_CHARS) {
  const lines = source.split(/\r?\n/)
  const ranked = rankSymbols(indexStructure(source, lang), lines).filter((x) => x.imp > 0)
  if (ranked.length === 0) return null
  // 按预算填充：每行形如 `function name (lines a-b) ★`，按**实际渲染长度**累加，
  // 不估算字符宽度（估算会系统性偏差，本项目已经在信封预算上栽过一次）。
  const chars = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_HINT_CHARS
  /** 渲染一行（与消费方看到的形状一致，含缩进与换行）——预算就按它的真实长度算。 */
  const renderRow = (s, exported) => `  ${s.kind} ${s.name} (lines ${s.startLine}-${s.endLine})${exported ? ' ★' : ''}`
  const picked = []
  let used = 0
  for (const { s, exported } of ranked) {
    // 不再估算行宽：估算值是拍的，而拍错的方向很贵——
    // 拍大 → 默认回执胀（增加使用代价）；拍小 → 比旧的写死 24 条还少（能力回退）。
    // 直接建行、量它的真实长度，两个方向都不会错。
    const cost = renderRow(s, exported).length + 1
    if (used + cost > chars && picked.length > 0) break
    used += cost
    picked.push({ s, exported })
  }
  const symbols = picked.map(({ s, exported }) => ({
    name: s.name,
    kind: s.kind,
    startLine: s.startLine,
    endLine: s.endLine,
    exported,
    // 建议里必须带上"这个符号能不能用 target="——否则"重试时改用 target=<name>"
    // 会把调用方推回同一个结构化拒绝，形成死循环式的重试。
    spanComplete: s.spanComplete !== false,
  }))
  const incomplete = symbols.filter((s) => !s.spanComplete).length
  /**
   * 被预算截掉多少，必须如实报出。
   *
   * 先前 `total` 算了却**无人消费**（`aura-edit` 的 `symbolHint` 自己重渲染行、丢掉 `total`），
   * 于是模型看到 24 条就以为"这文件只有 24 个符号"——把"被截"伪装成了"就这些"。
   * 现在调用方可以把它写进回执，也可以拿个更大的 `budget` 再要一次。
   */
  return {
    symbols,
    total: ranked.length,
    shown: symbols.length,
    truncated: ranked.length - symbols.length,
    instruction:
      'locate by name instead of guessing text: retry with target=<name> (also accepts kind:name, Outer/Inner) and no anchor' +
      (incomplete === 0
        ? ''
        : `; ${incomplete} of the symbols listed have no determinable span and reject target= — use lines= for those regions`),
  }
}

/** 列出源码里的符号，供 agent 在不知道确切名字时先看目录。 */
export function outline(source, filePath) {
  const lang = langOf(filePath)
  if (lang === null) return null
  return listSymbols(indexStructure(source, lang))
}

/** 某符号体内的引用位置：重命名这类需要"所有出现处"的操作。 */
export function references(source, filePath, name) {
  const lang = langOf(filePath)
  if (lang === null) return null
  return findReferences(indexStructure(source, lang), name)
}

/** 一个区间是否恰好是完整的语法单位。可用于给候选排序，或判断"这次改动是否自洽"。 */
export function spanQuality(source, filePath, startLine, endLine) {
  const lang = langOf(filePath)
  if (lang === null) return null
  return regionConfidence(indexStructure(source, lang), startLine, endLine)
}

/**
 * 支持的语言扩展名。别的框架据此判断能不能挂结构路径。
 *
 * **从配置表派生，不手写清单。** 第一版这里写死了一个九项数组
 * （`js ts jsx tsx mjs cjs py go rs`），而配置表早已长到 44 项——
 * 于是这个导出对调用方撒了谎：它说"只支持这九种"，实际远不止。
 * 手写清单必然与配置表脱节，且脱节是静默的；派生就没有这个问题。
 */
export const SUPPORTED_EXTENSIONS = Object.keys(LANGS).sort()
