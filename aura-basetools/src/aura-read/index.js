/**
 * dsh-tool-aura-read —— 具结构感知的读取工具（DSH 适配器）。
 *
 * 与内置 `read` 的差别不是"读得更省"，而是**先问要什么**：
 *
 *   内置 read 的原语是"把文件给你"。它把三种意图（这文件是什么／改那一处／通读一遍）
 *   都当成"要内容"，于是三者都付全文的钱，再被下游剪枝砍到约 10% 可见。
 *
 *   本工具的原语是"说出你需要什么"，有七个模式，且 `auto` 会自己选最小的那个：
 *     map      这文件里有什么（按重要性排序的符号目录）
 *     digest   它的接口与依赖（签名，不含函数体）
 *     full     全文（小文件上它反而最小）
 *     around   某个符号/某句话附近的窗口
 *     lines    指定行区间
 *     search   全文找一个子串
 *     changed  自上次读取以来变了什么
 *
 * 两条贯穿约束：
 *   1. 输出对齐下游剪枝预算，且开销是**算出来**的，不是预留的魔数
 *   2. 任何丢弃都带 `omitted` 说明与 `next` 续读指令——绝不静默
 *
 * fs 契约与 `dsh-tool-fs` 一致：resolve → 读 → `fs/observed`。
 * 本工具只读不写，因此不发 write/edit 意图。
 *
 * @module dsh-tool-aura-read
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 读取逻辑本身框架无关，住在 locator-lab；本文件是它的 DSH 适配器。
import { readWith, readManyWith, MODES, BYTE_ORDER_MARK_BYTES, startsWithByteOrderMark } from '../locator-lab/read-core.mjs'
import { LINE_ADDRESS_HINT, asLinePair, assertKnownArgs, assertReadTargets, assertTargetShape, gaveLineAddress, inferReadMode, lineRangeOf } from '../locator-lab/args.mjs'
// 仓库级地图（T26）：引擎驱动遍历，本文件只把 ctx.fs 的两个原始能力接上去。
import { collectRepoMap } from '../locator-lab/repo-map.mjs'

export const name = 'dsh-tool-aura-read'

/**
 * 硬依赖。声明进 inject，与 `dsh-tool-fs` 的做法一致——它同样声明这三个。
 *
 * `systemPrompt` **也必须声明**，不能靠 `ctx.get` 兜：用 `ctx.get` 时若服务不可见
 * 就静默跳过，于是"工具注册了但没有指导文本"这种半成品状态**不会报错**，
 * 表现为模型永远不用这个工具——正是我踩过的那个坑。
 * 声明进 inject 后，服务缺失时 Cordis 会让插件进入等待，问题在装载期就暴露。
 *
 * 注意：Cordis 的 guard 会拒绝任何未声明的 `ctx.<name>` 访问。
 */
export const inject = ['fs', 'tools', 'systemPrompt']

// 注：`toolResultPruner` **刻意不写进 inject**。它是可选依赖：
// 写进去会让没有部署剪枝器的组合（CLI / MCP / 单测）把本插件停在等待态、工具根本不注册，
// 而那正是 `dsh-tool-fs` 对可选 `attachments` 服务用 `ctx.inject([...])` 处理的形状。
// 这里更简：用 `ctx.get` 软取，取不到就用引擎缺省值。

/** 本工具无可配置项，但加载器要求这个导出存在。 */
export const Config = z.object({})

/**
 * 从引擎信封**原样透传**给框架的字段。
 *
 * **不要把它改回逐个展开的清单。** 这里原来是
 *   `...(env.omitted === undefined ? {} : { omitted: env.omitted }),` 等六行手写展开，
 * 而那份清单漏字段的方式正好是本工具反复出事的形态——每一次都是"引擎给了、schema 认了、
 * 中间的透传忘了"：
 *   1. `text` 漏声明       → 每条成功路径被拒
 *   2. `version` 在部分模式漏传 → around／lines／search 与所有未索引扩展名读不了
 *   3. `version: null`     → 类型校验拒绝
 *   4. `truncated` 漏传    → 超长单行的截断事实到不了模型（审计时抓到）
 * 前三次的修法都是**往清单里再加一行**——那正是"补丁的补丁"：治的是症状，
 * 而"手写清单会漏"这个成因一直在。现在改成从集合派生，字段的增删只发生在一处。
 *
 * 约束：本清单必须与 `output.schema.properties` 保持一致，
 * 由 `locator-lab/aura-read-schema-test.mjs` 逐模式逐扩展名地守着
 * （它会断言 schema 声明的可选字段与本常量完全一致）。
 *
 * 这个常量管的是**输出面**，不只是引擎信封：fs-contract-v2 起，失败通道的判决
 * （`outcome` / `code` / `candidates`）是**壳层自己算的**，不走引擎信封——但它们仍然是
 * "可能缺席的返回字段"，必须写在同一份名单里。两份名单一旦分开，schema 就会漏声明，
 * 而漏声明的后果是**整条路径被框架拒**（本工具已经因此出过四次事故，见上）。
 */
export const PASSTHROUGH_FIELDS = [
  'symbols',
  'version',
  'omitted',
  'next',
  'note',
  'truncated',
  'truncatedLines',
  'relocatable',
  /**
   * fs-contract-v2 / 波H：**区间句柄**（契约 §3/§4）。它落在引擎 `windowEnvelope` 那一层，
   * 与 `shown` / `relocatable` 同级（HD1 负责发），壳层只透传、不发也不排版。
   *
   * 为什么必须在这里登记：本壳的透传是**白名单**（`ship()` 只从本名单取键）⇒ 名单漏一个键，
   * 后果不是"渲染得难看"，而是**该字段静默消失**；而 schema 侧漏声明是另一个方向的同一类
   * 事故（`additionalProperties:false` ⇒ 整条回执被 `INVALID_TOOL_OUTPUT` 顶掉，本工具已经
   * 因此出过四次）。两处一起改，由 `locator-lab/aura-read-schema-test.mjs`（两份名单必须
   * 逐字一致）与 `outcome-test` 段D 守着。
   *
   * **三个字段、两种形状**（与引擎 `windowEnvelope` / `search` 实际发的一致）：
   *   · `handle`     —— 单值：lines / around / full 的**整段一个**（`read-core.mjs` 的 windowEnvelope）；
   *   · `handles`    —— 多值：search **逐命中**一个，元素与 `relocatable` 同形 `{line, handle}`；
   *   · `handlesOmitted` —— 命中数超过 `HANDLE_MAX_PER_RECEIPT` 时**只报数**（契约 §4：
   *     句柄数上限，超出的不发、但得说清有多少没发）。
   *
   * 三个都是**按情形**出现的可选字段（没句柄可发时整个键不出现），不是按参数开关——
   * 这正是本壳既有可选字段的惯例（`relocatable` / `truncated` / `resume` 都这样）。
   */
  'handle',
  'handles',
  'handlesOmitted',
  // fs-contract-v2：判定不出调用方意图时走**正常结果**，三态与它的证据随回执一起回来。
  'outcome',
  // 引擎的判决码原文（`READ_OUT_OF_RANGE` / `READ_AMBIGUOUS` …）：outcome 是粗分类，码才是原因。
  'code',
  // 候选位置（`{line, text}`）——`needs_choice` 的全部价值就在这里。
  'candidates',
  // 续读参数：下一次调用的**确切入参**（`{mode, lines}` / `{mode, search}`）。
  // 它不是“建议”——它和调用方自己写的参数同形同名，所以可以直接回填再调一次。
  'resume',
  /**
   * fs-contract-v2 / 波MT：多目标（§2.1）的三个**壳层**字段。
   *
   * 它们不是引擎信封里的字段，但本名单管的是**输出面的可选字段白名单**（见上），
   * 而输出 schema 是 `additionalProperties:false`：漏登记 ⇒ 整条多目标回执被
   * `INVALID_TOOL_OUTPUT` 顶掉。两份名单必须同源，这一条由 `aura-read-schema-test` 守着。
   *
   * `targets` 是条数、`summary` 是一行汇总（**只在字段里**，不进正文 body：正文是宿主
   * 剪枝器量的东西）、`entries` 是逐项（每一项 `text` 就是今天那套单目标渲染的输出）。
   */
  'targets',
  'summary',
  'entries',
]

/**
 * 本工具声明的**顶层参数名**（唯一一份）。
 *
 * 为什么要单列一个常量，而不是在 schema 与守卫处各写一遍：
 * `assertKnownArgs` 要拿它算“合法键集合”，而 schema 要按它声明 `additionalProperties: false`。
 * 两份名单必然会漂（本项目已经因为“同一决策写两处”漏改过多次），
 * 而这里漂的代价很具体：某天给 schema 加一个参数、忘了同步守卫，那个参数会被**自己的守卫拒掉**。
 */
export const READ_ARG_KEYS = [
  'file_path',
  'mode',
  'around',
  'lines',
  'start_line',
  'end_line',
  'search',
  'context',
  'since',
  'kind',
  // fs-contract-v2 §2.1：多目标形状。它与 `file_path` **互斥**（判据只有一份：`assertReadTargets`）。
  'targets',
]

/**
 * 这份文件带不带 UTF-8 BOM。
 *
 * 为什么不能看内容：提供方的 `readText` 用 `new TextDecoder('utf-8', {fatal:true})` 解码，
 * `ignoreBOM` 默认 false ⇒ BOM **不会**进入解码后的字符串（dsh-fs-local/lib/index.js:315）。
 * 于是“这个文件带不带 BOM”在字符串层已经无法回答，只能问原始字节
 * （`readByteRange`，接口声明见同包 lib/types/index.d.ts:56、实现见 lib/index.js:800）。
 *
 * 判据本身在 read-core（`startsWithByteOrderMark`），与写路径共用一份，
 * 否则“令牌说没 BOM、写回却带 BOM”这类不自洽会两处各修一遍。
 *
 * 测试 mock 可能没有字节接口：那时返回 false（没拿到字节，就没有 BOM 信息可传）。
 */
async function fileStartsWithByteOrderMark(fsService, target, signal) {
  if (typeof fsService.readByteRange !== 'function') return false
  // 探测长度取自字节常量本身（不写死 3）：判据与长度同源，改一处不会漏另一处
  const head = await fsService.readByteRange(target, { offset: 0, length: BYTE_ORDER_MARK_BYTES.length }, signal)
  return startsWithByteOrderMark(head)
}

// ── C55：非 UTF-8 文件 ⇒ 可执行的拒绝 ──────────────────────────────────────

/**
 * 这次失败是不是「这份文件不是 UTF-8 文本」？
 *
 * 两种后端形状都要认（都是实测出来的）：
 *   · `ERR_ENCODING_INVALID_ENCODED_DATA` —— `new TextDecoder('utf-8',{fatal:true}).decode()`
 *     在裸 Node 侧的原始错误，消息是 `The encoded data was not valid for encoding utf-8`，
 *     **不带文件名**（BASE 段的实测读数就是它）；
 *   · `FS_NOT_TEXT` + 消息里有 `utf-8` —— `dsh-fs-local` 的 `decodeUtf8` 把上面那个 TypeError
 *     翻成了 `cannot read "<路径>": invalid UTF-8 text`。
 *
 * 为什么不能只看码：`FS_NOT_TEXT` 同时也用于「含 NUL 的二进制文件」（消息是 `binary file`）。
 * 那是另一件事，它的说法本来就够（有路径、有原因），不该被这一段的文案盖住。
 *
 * 反过来，判据也**不能**用「解码失败」去反推：本函数只在**已经捕获到**错误时被调用，
 * 带 BOM 的 UTF-8（`TextDecoder` 默认 `ignoreBOM:false`，只吃掉第一个 BOM）根本走不到这里，
 * 因此不会被误判成非 UTF-8。
 */
function isNonUtf8TextFailure(error) {
  if (error === null || typeof error !== 'object') return false
  if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return true
  const message = typeof error.message === 'string' ? error.message : ''
  return /invalid utf-?8|not valid for encoding utf-?8/i.test(message)
}

/**
 * 「这份文件不是 UTF-8 文本」的拒绝回执：**三件事必须同一次说清**。
 *
 *   ① 是哪个文件——路径原样带引号，可以直接复制去查；
 *   ② 为什么读不了——它的字节不是 UTF-8 文本，因此这里根本没有可读的文本；并点明这是
 *      **环境级拒绝**，换参数重发不可能成功（否则调用方会去改地址、改模式，
 *      而它真正要做的只是把文件转成 UTF-8）；
 *   ③ 下一步怎么办——先确认编码、再转成 UTF-8、再调一次；并明说**这次一个字节都没改**。
 *
 * 为什么走抛错（工具级故障）而不是结果通道：按本仓口径，「判定不出你的意图」才走结果，
 * 而这一条是环境故障。把「读不了这个文件」伪装成「判不出你要哪一段」是两件不同的事，
 * 会让调用方去重试一个必然失败的形状。
 *
 * 同一段判据与同一句话在三个面上各有一份（本波写范围不共享模块）：
 *   aura-read/index.js · aura-edit/index.js · aura-standalone/lib/ops.mjs。
 * 抄漏一处由 `locator-lab/encoding-refusal-test.mjs` 段C 逐处抽出来比对 ⇒ 会红。
 */
function nonUtf8RefusalMessage(verb, displayPath, tool) {
  return (
    `cannot ${verb} "${displayPath}": this file is not UTF-8 text.\n` +
    `why: its bytes are not a UTF-8 encoding of text, so there is no text here to ${verb === 'read' ? 'read' : 'address'}. ` +
    `This is an environment-level refusal, not a problem with the arguments you passed — re-sending the same call cannot succeed.\n` +
    `next: (1) find out which encoding the file really uses — look at its bytes (a hex view) or at your editor's encoding indicator (\`file -i\` where available); ` +
    `(2) convert it to UTF-8 (for example \`iconv -f GBK -t UTF-8\`, or the editor's "save with encoding: UTF-8"); ` +
    `(3) then call ${tool} again on the converted file.\n` +
    `nothing was written: this call did not touch the file — its bytes on disk are exactly as they were.`
  )
}

// ── 失败通道：判定不出调用方意图 ⇒ 走结果；工具级故障 ⇒ 继续抛错 ─────────────

/**
 * 引擎错误码 → 三态 outcome。**不在表里的码一律按工具级故障抛错。**
 *
 * 方向是刻意选的（与 `aura-edit` 那边同一张表、同一条理由）：漏收一个可判定码只是
 * “没改进”，而误吞一个工具级故障会让调用方把“没读到”当成“读到了”。
 *
 * **刻意不收的**（继续抛错）：
 *   · `READ_BAD_MODE` / `READ_NO_RANGE` / `READ_NO_TARGET` / `READ_NO_QUERY`：
 *     参数面就没成形（没写 mode、没给区间/关键词）——与“文件里没有你要的那一段”
 *     是两件事，混为一谈会让模型去换地址，而它真正要做的只是把参数写全。
 *   · 文件不存在 / 不可读、解码失败等：工具级或环境级，不是意图问题。
 */
const OUTCOME_BY_CODE = new Map([
  // 文件里没有你要的那一段（含坐标在文件里不存在）
  ['READ_NOT_FOUND', 'not_found'],
  ['READ_OUT_OF_RANGE', 'not_found'],
  ['READ_BAD_RANGE', 'not_found'],
  // 你指的头部在多处都能对上 ⇒ 得由调用方选一个
  ['READ_AMBIGUOUS', 'needs_choice'],
])

/** 判定不出意图时的下一步（引擎没给 `next` 时才用；引擎给了就以引擎的为准）。 */
const NEXT_BY_OUTCOME = {
  needs_choice: 'more than one line matches — pick one of the candidate lines and re-read with start_line + end_line',
  not_found: 'the file does not contain that — re-read it (mode=map for the symbol directory, or mode=full) and ask for something that is there',
}

/**
 * 判决一次失败：**返回三态判决**（可判定）或 **null**（工具级故障，调用方必须原样抛出）。
 *
 * 只在 `readWith` 返回 `ok:false` 时调用——此刻文件已经读到，只是没判定出调用方要哪一段；
 * 磁盘上一个字节也没动过（本工具只读）。
 *
 * @param env - `readWith` 的失败信封（`{ok:false, code, message, candidates?, next?}`）
 * @returns {{outcome: string, code: string, next: string} | null}
 */
function intentVerdict(env) {
  const mapped = typeof env.code === 'string' ? OUTCOME_BY_CODE.get(env.code) : undefined
  if (mapped === undefined) return null
  const candidates = Array.isArray(env.candidates) ? env.candidates : []
  // 候选本身就是“需要选”的证据：码说歧义却一个候选都没给时退回 not_found——
  // “从候选里挑”却列不出候选，对调用方是一句空话。
  const outcome = candidates.length > 1 ? 'needs_choice' : mapped === 'needs_choice' ? 'not_found' : mapped
  return {
    outcome,
    code: env.code,
    next: typeof env.next === 'string' && env.next.length > 0 ? env.next : NEXT_BY_OUTCOME[outcome],
  }
}

/**
 * 把信封渲染成模型可读的文本。
 *
 * 分离渲染与逻辑：`readWith` 返回结构化信封（字段即契约），本函数只负责排版。
 * 这样非 DSH 的调用方可以直接消费信封，不必解析这段文本。
 */
function renderEnvelope(env) {
  /**
   * 失败分支：这段文本现在真的会被模型看到（以前它抛错，走到这里的只有成功路径）。
   *
   * 三件事按这个顺序给：判决码（可检索、可引用）→ 原因 → 候选与下一步。
   * 码必须进来：回执的 `outcome` 只说“哪一类”，`READ_OUT_OF_RANGE` 与 `READ_NOT_FOUND`
   * 在模型眼里是完全不同的两件事（一个改行号就行，一个得换目标）。
   */
  if (env.ok === false) {
    const head = `Error${typeof env.code === 'string' && env.code.length > 0 ? ` (${env.code})` : ''}: ${env.message}`
    const rows = Array.isArray(env.candidates)
      ? `\n${env.candidates.map((c) => `  line ${c.line}: ${c.text ?? ''}`).join('\n')}`
      : ''
    const next = typeof env.next === 'string' && env.next.length > 0 ? `\nnext: ${env.next}` : ''
    return `${head}${rows}${next}`
  }
  const head = []
  // `auto` 是**选模式的理由**（engine 里 auto = suggestMode(...).reason），不是模式名；
  // 模式名一直在 `mode` 字段里。这里两样都给：模型要能看出"这次被选了什么、为什么"，
  // 否则选择规则再确定也是黑盒——实测 107 次读取里 69 次走 auto，而回执从未说过选了什么。
  if (env.auto !== undefined) head.push(`(auto: ${env.mode} — ${env.auto})`)
  // 版本令牌：让 changed 可用。此前它只在 changed 自己的回执里出现，而 changed 需要
  // 上一次的令牌当入参——"要拿钥匙先得有钥匙"，于是那一模式在真实会话里等于不存在。
  if (env.version !== undefined) head.push(`version: ${env.version}`)
  if (env.note !== undefined) head.push(env.note)
  /**
   * 可重新定位的引用：把"这个行号属于哪个符号"交给模型。
   *
   * 动态视角下这是必需的一条：行号是**绝对坐标**，而编辑是破坏它的那个变换
   * （上面插一行，下面全 +1）。模型手里只有 `6: return b` 时，一旦文件被改过，
   * 它**没有任何东西可以用来换算**；而 `beta (5-7)` 在插入/删除下不变。
   * 实测不对称：`around` 一直带着符号（在 `label` 里）、`map` 本身就全是符号，
   * **只有 `lines` 与 `search` 给裸行号**——这两个正是最常用于"照着改"的输出。
   */
  if (env.relocatable !== undefined) {
    head.push(
      `relocatable: ${env.relocatable
        .map((r) => `line ${r.line} → ${r.target} (${r.lines[0]}-${r.lines[1]})`)
        .join('; ')}`,
    )
  }
  const body = [head.join('\n'), env.text ?? '', '']
  if (env.label !== undefined) body.push(`[${env.label}]`)
  if (env.omitted !== undefined) body.push(`omitted: ${env.omitted}`)
  if (env.next !== undefined) body.push(`next: ${env.next}`)
  return body.filter((l) => l.length > 0).join('\n')
}

/**
 * 整批的三态 `outcome`（输出 schema 的 enum 只有这三格）。
 *
 * 逐项 outcome 才是判决本体（契约 §1.3：失败逐项走结果通道）；这一格只回答
 * “这一批里还有没有需要你看一眼的项”——“全成”才给 `applied`，否则交给更可执行的那一格。
 */
function batchOutcomeOf(entries) {
  if (entries.every((entry) => entry.ok === true)) return 'applied'
  return entries.some((entry) => entry.outcome === 'needs_choice') ? 'needs_choice' : 'not_found'
}

/**
 * 逐项回执行（契约 §5）：形状与单目标回执的**关键字段同形**，`text` 就是**同一个渲染器**的输出。
 *
 * 三种情形合流到同一组字段上：
 *   · 读成了 ⇒ `renderEnvelope(env)`；
 *   · 读了但判定不出你要哪一段（引擎把 `readWith` 的失败信封原样放在 `envelope` 里）⇒
 *     走与单目标**同一张** `OUTCOME_BY_CODE` 表得三态，`text` 仍是 `renderEnvelope(env)`；
 *   · 没读成（不存在 / 目录 / 非 UTF-8 / 行寻址写坏）⇒ 引擎已经给了 `code` + `message`，
 *     把它们拼成失败信封再交给**同一个** `renderEnvelope`（不另写一份失败排版）。
 */
function batchEntryOf(entry) {
  const head = { index: entry.index, file_path: entry.file_path }
  if (entry.envelope === undefined) {
    const failure = {
      ok: false,
      code: entry.code,
      message: entry.message,
      ...(entry.next === undefined ? {} : { next: entry.next }),
    }
    return { ...head, ok: false, outcome: 'failed', ...failure, text: renderEnvelope(failure) }
  }
  const env = entry.envelope
  if (env.ok === false) {
    const verdict = intentVerdict(env)
    return {
      ...head,
      ok: false,
      outcome: verdict === null ? 'failed' : verdict.outcome,
      code: env.code,
      ...(env.candidates === undefined ? {} : { candidates: env.candidates }),
      ...(verdict === null ? {} : { next: verdict.next }),
      text: renderEnvelope(env),
    }
  }
  /**
   * 成功那条要把**区间句柄原样透传**（fs-contract-v2 §3/§4）：单目标回执是在顶层给 `handle`，
   * 而多目标这一批没有“一个区间”——句柄必须在**它自己那一项**里。
   *
   * 为什么这是必须的、不是一个美化：多目标的存在意义之一就是“一次读一批、再一次改一批”，
   * 而改那一步的地址就是句柄（`{handle, replace}`）；不把它交出去，批内句柄就只在引擎内部存在，
   * 模型拿到的是一批进不去写的回执（`renderEnvelope` 只排正文，句柄不在正文里）。
   * 只在信封确实给了句柄时出现（map/digest/目录不发），与顶层 `handle` 同一条纪律。
   */
  const handleFields = env.handle === undefined ? {} : { handle: env.handle }
  return { ...head, ok: true, outcome: 'applied', mode: env.mode, ...handleFields, text: renderEnvelope(env) }
}

/**
 * **多目标读**（fs-contract-v2 §2.1）：`targets` ⇒ 引擎入口 `readManyWith`。
 *
 * ## provider 怎么接（两个形状都要给对：显示路径 **与** 身份键）
 *
 * 引擎要的是一份 `resolve/stat/readText/readByteRange`，而壳手里的能力是 `ctx.fs`：
 *   · `resolve` 在引擎里是**同步调用点**（`const hostTarget = await provider.resolve(filePath)`），
 *     而 `ctx.fs.resolve` 是 async ⇒ 这里返回**那个 Promise**；引擎 `await` 它，并同时认两种返回形状
 *     （字符串 = 旧提供方；`{displayPath, targetKey}` = 宿主解析结果）。
 *     返回对象是**必须**的，不再是“可选美化”：句柄的身份标签按 `ledgerIdentityKey(filePath, identityKey)`
 *     算，而单目标那条路递的是 `ctx.fs.resolve()` 的 `targetKey`（C61）。多目标若只把路径串当身份，
 *     同一文件同一区间在两条路上会得到**两个不同的句柄**（实测 `h4745015d4840:…` vs `he6dd015d4840:…`），
 *     于是“一次读一批、再一次改一批”这条正路会在 `aura_edit` 上以 `PATCH_HANDLE_IDENTITY_MISMATCH` 断掉。
 *     `readManyTarget` 现在把 `displayPath` 当显示路径、`targetKey` 当身份键（**不新造第三份口径**：
 *     `ledgerIdentityKey` / `IDENTITY_KEYS` 就是既有那一份）。
 *   · 同一路径不得解析三次（resolve 在真实后端上是 realpath）⇒ 按路径**记忆化一个 Promise**，
 *     且把解析结果自己的 `displayPath` 也登记进同一张表：引擎会拿它回来问（那是同一次解析）。
 *     解析仍然发生在引擎的有界池里（不在壳里另开并发）。
 * ## 单目标那条路
 *
 * 一个字没动：`targets` 缺席时 `assertReadTargets` 立即返回 undefined，`execute` 继续走
 * 它今天的 `ctx.fs.resolve/stat/readText/readByteRange` 序列（红线套件逐项钉着）。
 */
async function readTargetsBatch(ctx, exec, targets) {
  const cwd = exec.agent?.session?.header?.cwd
  const signal = exec.signal
  const pending = new Map()
  /**
   * 按输入写法记忆化，**并**把解析出来的 `displayPath` 也挂到同一个 Promise 上。
   *
   * 为什么后者也要：模型常给相对写法，而 `displayPath` 是相对 cwd 解出的绝对路径；
   * 引擎接下来拿 `displayPath` 回调 `stat`/`readText`/`readByteRange`（那是它唯一知道的路径），
   * 不登记就会为同一个目标**再解析一次**（`realpath` 是真实 IO）。
   * 只登记不覆盖：同一条 `displayPath` 已经有 Promise 时以后来者为准会丢前者。
   */
  const resolved = (displayPath) => {
    const hit = pending.get(displayPath)
    if (hit !== undefined) return hit
    const promise = Promise.resolve(ctx.fs.resolve(displayPath, { ...(cwd === undefined ? {} : { cwd }), signal })).then(
      (target) => {
        if (
          target !== null &&
          typeof target === 'object' &&
          typeof target.displayPath === 'string' &&
          target.displayPath !== displayPath &&
          !pending.has(target.displayPath)
        ) {
          pending.set(target.displayPath, promise)
        }
        return target
      },
    )
    pending.set(displayPath, promise)
    return promise
  }
  const provider = {
    // 见上面“provider 怎么接”：身份键就藏在这个返回值里，不能只回路径串。
    resolve: (displayPath) => resolved(displayPath),
    // 下面三个拿到的是引擎归一后的**显示路径**（字符串），所以它们与 `pending` 的键同源。
    stat: async (raw) => ctx.fs.stat(await resolved(raw), signal),
    readText: async (raw) => ctx.fs.readText(await resolved(raw), signal),
    readByteRange: async (raw, range) =>
      ctx.fs.readByteRange(await resolved(raw), { offset: range.offset, length: range.length }, signal),
  }
  const batch = await readManyWith(provider, targets)
  const entries = batch.entries.map((entry) => batchEntryOf(entry))
  return {
    // `path` 是必填字段，而这一批没有“一个路径”——给它整批的事实（逐项路径在 `entries` 里）。
    path: `${batch.targets} targets`,
    mode: 'multi',
    outcome: batchOutcomeOf(entries),
    targets: batch.targets,
    // 汇总行**只在这里**（引擎算的那一行原样带回来）：不进任何一项的正文。
    summary: batch.summary,
    entries,
    // 正文 = 逐项正文的顺序拼接（每项一行 `路径 — outcome` 抬头，否则 N 段正文认不出归属）。
    text: entries.map((entry) => `${entry.file_path} — ${entry.outcome}\n${entry.text}`).join('\n\n'),
  }
}

/**
 * 注册 `aura_read` 工具，以及配套的提示段。
 *
 * ## 为什么必须同时注册提示段
 *
 * 只注册工具是不够的——这是实测出来的结论。我在一个真实会话里观察模型**完全不用**
 * 本工具，查会话日志里的系统提示词才找到原因：内置 `tool-fs` 会注入**命令式**指导：
 *
 *   Use the read tool — not shell commands like cat — to inspect text files
 *   Use the write tool to create files or completely replace file contents
 *   Use the edit tool for targeted changes to existing UTF-8 text files
 *
 * 这些句子**无条件注入**（只要内置工具可见），而本工具只有 schema、没有一句话指导。
 * 于是模型面对"读文件"时，提示词明确说用 `read`，本工具只是个沉默的备选——
 * **这不是模型的选择问题，是共存缺陷。**
 *
 * 修法是用同一套机制说同样明确的话。位置放在 `TOOL_EDIT`(1300) **之后**：
 * 提示词里靠后的指导压过靠前的，因此与内置指导冲突时，本段生效。
 *
 * @param ctx - 携带文件系统服务、工具注册表与提示词注册表的上下文。
 */
export function apply(ctx) {
  // 与 dsh-tool-fs 一致：按 scope 检查工具可见性，本工具被限制掉的会话不该收到关于它的指导。
  // `systemPrompt` 已声明进 inject，因此直接访问——用 `ctx.get` 兜会静默跳过，
  // 而"工具注册了却没有指导"正是我踩过的坑。
  ctx.systemPrompt.section({
    name: 'tool:aura-read',
    order: 1310,
    text: ({ scope }) =>
      ctx.tools.get('aura_read', scope) === undefined
        ? ''
        : [
            // 措辞与内置指导**同形**（命令式）。理由见 aura-edit 里同一处的注释：
            // 建议式的措辞在实测中只在部分会话里生效——它是在跟先验拔河。
            // 兜底措辞分两处写：开头**不**给平级选项（给了就等于发许可证——实测中性任务下模型会顺着它选内置），
            // 只在末尾给"aura_read 真做不到"的那两种情况。
            'Use the aura_read tool — not read — for every text-file read: it is the default, and it shows structure instead of raw bytes.',
            'Start with `map` when you do not yet know the file (an importance-ranked symbol directory); use `around` or a line range (`start_line` + `end_line`) for the part you will edit; `digest` for a file\'s interface and dependencies; `changed` to see what moved since a previous read.',
            // 刻意**不再**写"未知扩展名请用内置 read"。实测这句话是错的：未知扩展名上
            // `auto` 会降级到 `full`，内容照给（见 locator-lab/disable-check.mjs）。
            // 那句话唯一的实际效果，是在工具完全可用的场景里把模型赶回内置工具。
            'Files without an indexed extension (config, data, markup) still work: `auto` falls back to `full` and returns the content.',
            // 多目标：**这一步是为了采用率**（判据⑤）。参数里的 `targets` 一直就在，但“参数表里有”与
            // “模型会想到它”是两回事：指导文本是模型最先读的一段，不提就等着它一次一个文件。
            // 措辞仍是命令式，与上下文同形；放在兜底条件**之前**，让“何时该用内置 read”仍是最后一句。
            'When several files are needed — or several places in files you are about to change — pass `targets` instead of calling once per file: one call, one receipt per target, output in input order, and a missing file does not fail the rest.',
            // 兜底条件写明白：不写会让模型在确实需要内置工具时犹豫（超大窗口 / aura 直接拒读）。
            'The built-in `read` remains only for what aura_read cannot do: a raw window larger than one reply, or a file aura_read refuses.',
          ].join(' '),
  })

  ctx.tools.register(
    defineTool({
      name: 'aura_read',
      description:
        'Read a file the way you actually need it. Seven modes, and `auto` picks the smallest one for you: ' +
        '`map` (what is in this file — an importance-ranked symbol directory), ' +
        '`digest` (its interface and dependencies — signatures without bodies), ' +
        '`full` (whole text; smallest for tiny files), ' +
        '`around` (a window around a symbol or phrase — give `around=<name>`), ' +
        '`lines` (an exact range — pass `start_line: 412, end_line: 500`, or `lines: [412, 500]`), ' +
        '`search` (find a substring — give `search=<text>`), ' +
        '`changed` (what differs since a previous read — pass `since=<version>`). ' +
        'Output never exceeds what the pipeline preserves, and anything dropped is reported in `omitted` with a `next` hint. ' +
        'Prefer `map` first when you do not yet know the file; then `around` or `lines` for the part you will edit. ' +
        'To read several files (or several ranges) in one call, pass `targets` — an array of the same single-target arguments.',
      parameters: {
        /**
         * `file_path` 不再声明 `required: true` —— 这是**多目标形状**逼出来的唯一一处声明面改动。
         *
         * 宿主把 `required: true` 编译成参数面的 `required: ['file_path']`，于是 `{targets:[…]}`
         * 会在**参数层**就被拒，多目标永远到不了 execute。
         *
         * ## 为什么“二选一”没有写在 schema 里（已实测，不要重试 `anyOf`）
         *
         * MT7 按“用 `anyOf: [{required:['file_path']}, {required:['targets']}]` 把闸补回来”动过手，
         * 结果是**本框架的 schema 方言里它不可表达**，三条硬证据（探测脚本读数，
         * 两份 dsh-tools 副本 —— 仓库 `node_modules` 与已装的 `.aura/pkg/node_modules` —— 完全一致）：
         *   1. 参数面**不是** JSON Schema，是隐式属性表（`compilePropertyMap`）：根上的键一律被当成
         *      **属性名**。`anyOf`/`allOf` 被 `assertSupportedJsonSchema` 判为
         *      `is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`；
         *   2. 更致命的是 `validateJsonSchemaValue` **静默忽略** `anyOf`：`anyOf` 在场时 `{}` 照样通过。
         *      于是就算能把它塞进去，它也是一条**没有效果的声明**——比不写更坏（本仓已为
         *      “声明得比实装宽”付过代价，见 `hunks.items.required` 那条注释）；
         *   3. 方言里唯一能表达“恰取其一”的是 `oneOf`，而它与根上的 `type: 'object'` **不能共存**
         *      （`cannot declare both type and oneOf`）；去掉 `type` 又违反
         *      `assertObjectJsonSchema`（宿主与 SDK 渲染器都要求参数面是对象根）。
         *
         * 所以“单目标形状必须有 file_path”这条约束**由运行期判**：execute 第一条就是原来那句
         * `file_path must be a non-empty string`，一字未改——单目标调用因此**完全相同**
         * （它本来就带 file_path）；而“两个都给”由**唯一判据** `assertReadTargets` 拒
         * （`ARGS_SHAPE_EXCLUSIVE`）。两条都由 `arg-shape-test` 段C 与 `real-framework-smoke-test`
         * 段C **端到端**锤着（不是查声明），这是本条能做到的最强形式。
         */
        file_path: {
          type: 'string',
          description: 'Path to read, resolved by the filesystem backend.',
        },
        /**
         * 多目标：一次调用读多个文件 / 多个区间（互斥于 `file_path`）。
         *
         * 元素就是**今天那套单目标参数**（`file_path` + `mode`/`lines`/`search`/…），
         * 元素的键在这里 `additionalProperties: true`：逐个声明等于把单目标那 10 个键
         * 抄第二遍，而两份清单必然漂——漂的方向是“schema 里有、运行期不认”。
         * 逐项校验由引擎 `readManyWith` 走同一套单目标判定器。
         */
        targets: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Read several files (or several ranges) in one call: an array of the same single-target arguments. ' +
            'Mutually exclusive with `file_path` — pass one or the other. Each item gets its own receipt line and its own outcome; ' +
            'one missing file does not fail the rest. Output order = input order.',
        },
        mode: {
          type: 'string',
          description: `One of: ${MODES.join(', ')}, or auto (default). Auto compares rendered sizes and picks the smallest.`,
        },
        around: {
          type: 'string',
          description: 'mode=around: a symbol name or a phrase to center the window on.',
        },
        // 行区间声明成 oneOf：模型的常见失误是把区间写成 `412, 500`（那已经不是合法 JSON，
        // 宿主会在参数进工具之前就拒：`invalid arguments: "arguments" must be an object`），
        // 或者写成 `"412,500"`、单个 412。声明得宽一点，再加上 start_line/end_line 这条
        // "没有数组语法可写错"的路，能少掉一整类来回。
        lines: {
          // 四个分支都要写全：宿主按 oneOf 校验（"must match exactly one branch"），少写 object
          // 会让 `lines: {start, end}` 在参数层就被拒；而 object 分支还**必须显式声明
          // additionalProperties**（宿主规定：必须显式 true/false），否则整个工具在注册时就报
          // UNSUPPORTED_SCHEMA（实测：11 个套件全崩）。两条都是宿主当场教的。
          oneOf: [
            { type: 'array' },
            { type: 'string' },
            { type: 'integer' },
            { type: 'object', additionalProperties: true },
          ],
          description:
            'mode=lines: the range, 1-based inclusive — `[412, 500]`. Also accepts "412,500" or a single 412. ' +
            'Preferred instead: `start_line` + `end_line` (two plain numbers, no array syntax to get wrong).',
        },
        start_line: {
          type: 'integer',
          description: 'mode=lines (preferred): first line of the range, 1-based inclusive.',
        },
        end_line: {
          type: 'integer',
          description: 'mode=lines (preferred): last line of the range, 1-based inclusive. Defaults to start_line.',
        },
        search: {
          type: 'string',
          description: 'mode=search: a substring to find across the file.',
        },
        context: {
          type: 'integer',
          description: 'mode=around: how many lines of context on each side. Default 8.',
        },
        since: {
          type: 'string',
          description: 'mode=changed: the `version` value from a previous aura_read of this file.',
        },
        kind: {
          type: 'string',
          description: 'mode=map: only list symbols of this kind (e.g. `function`).',
        },
      },
      /**
       * 顶层**也要** `additionalProperties: false`。
       *
       * 旧版只有 `output.schema` 写了这一条，参数面没写。而真框架的校验器只在它显式 `false` 时才拒
       * 未声明属性（`json-schema.js:492`）⇒ `{file_path, mod:'map'}` 这种拼写错误**零违规直接放行**，
       * 然后被工具静默忽略（实测：`args.mod` 确实到达 execute，而工具只读 `args.mode`）。
       * 两处一起才自洽：schema 层管住形状，{@link assertKnownArgs} 给可执行的报错。
       */
      additionalProperties: false,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            /**
             * 从 fs-contract-v2 起**可选**：失败回执（读了，但判定不出你要哪一段）
             * 没读出内容就不知道总行数，而它也不想编一个数字（编一个比缺席坏）。
             *
             * 这不算回到“声明得比产出窄”那个老病：成功路径仍然**总是**给 totalLines，
             * 并且在 `aura-read-schema-test` 里逐模式逐扩展名地守着。
             */
            totalLines: { type: 'integer' },
            // `text` 必须声明。第一版漏了它——而渲染器返回的正是 `text`，
            // 于是**每一条成功路径**都被框架以 `additionalProperties: false` 拒绝：
            //   tool "aura_read" returned invalid output: "value.text" is not a declared property
            // 我的 load-test 当时 29/29 全绿，因为它从不校验输出是否合自己声明的 schema。
            // 现在那道校验补上了，这类错误不会再穿过测试。
            text: { type: 'string', required: true },
            /**
             * 三态 outcome（**必填**，成功也要给）。
             *
             * 读取侧没有写入，“applied”在这里的含义是**这次调用按调用方的意图执行完毕**；
             * `needs_choice` = 你指的头部在多处都能对上（附候选行）；
             * `not_found` = 文件里没有你要的那一段（含坐标越界）。
             * 两把工具共用同一组取值与同一个判读方式——调用方不必按工具名分支。
             *
             * 为什么必填：失败从抛错改成结果之后，“回执到手”不再等于“读成了”，
             * 得有个字段把这件事说清，而不是让调用方从 `text` 是否以 "Error" 开头去猜。
             */
            outcome: { type: 'string', enum: ['applied', 'needs_choice', 'not_found'], required: true },
            // 引擎的判决码原文（`READ_OUT_OF_RANGE` / `READ_AMBIGUOUS` …）。
            code: { type: 'string' },
            /**
             * 候选位置。读取侧的引擎本来就给 `{line, text}`（`READ_AMBIGUOUS`），
             * 以前壳层把它拼进 message 字符串——结构化信息变成了要正则才能抠出来的文本。
             * 现在原样带回来。
             */
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'integer', required: true },
                  text: { type: 'string' },
                },
              },
            },
            symbols: { type: 'integer' },
            // `version` 可选，而不是必填。历史：它曾是必填，而当时 `changed` 在 `since` 缺省下不给令牌，
            // 于是 around／lines／search 与所有未索引扩展名上它是 undefined，真实会话里 .json／.yml／.md
            // 的读取被框架整条拒掉，才改成可选。
            // 现状（2026-09-22 实测，格式靶场把这条钉住了）：`changed` 无论缺省、相同、过期的 `since`
            // **都会给令牌**（令牌 = 相对当前内容算出的基准）；"含内容的回执必须给令牌"这条更强的规则
            // 由 aura-read-schema-test 的显式不变量守。
            //
            // 更要紧的是：**声明得比产出窄，等于给工具装了一个只在特定参数下才触发的雷。**
            // 这个字段已经炸过两次——第一次是漏声明 `text`（每条成功路径全废），
            // 第二次是它在 around／lines／search 与所有未索引扩展名上是 undefined。
            // 所以现在的判据是：schema 只声明**确实可能缺席**的字段为可选；
            // 而"含内容的模式必须给令牌"这条更强的约束，交给 aura-read-schema-test 去守，
            // 那里能逐模式逐扩展名地断言，比 schema 层能表达的多。
            version: { type: 'string' },
            omitted: { type: 'string' },
            // 单行超过内容预算时，引擎会给出行内截断的机器可读事实。
            // 必须声明：这个 schema 是 additionalProperties:false，任何未声明的返回字段
            // 都会让**整条成功路径**被框架拒绝。同一类错误在本工具上已经发生过三次
            // （漏声明 text、version 在部分模式 undefined、version 为 null），
            // 所以"引擎会返回什么"与"schema 声明了什么"必须同时改。
            // 单行被截：形状全局唯一（{line, shown, omittedChars}）。
            // 第一版在 `search` 里给的是这个形状的**数组**、在 `windowEnvelope` 里给对象，
            // 同一个字段名两种含义——本项目已因此裁过一次（fitWithin.kept），不再重犯。
            truncated: {
              type: 'object',
              additionalProperties: false,
              properties: {
                line: { type: 'integer', required: true },
                shown: { type: 'integer', required: true },
                omittedChars: { type: 'integer', required: true },
              },
            },
            // 多行被截时才出现（search 可能一次截好几行）；元素形状同上。
            truncatedLines: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'integer', required: true },
                  shown: { type: 'integer', required: true },
                  omittedChars: { type: 'integer', required: true },
                },
              },
            },
            // "这个行号属于哪个符号"——行号会随编辑腐坏，符号名不会。
            // 形状**必须唯一**（数组）：引擎里曾经让 lines 给对象、search 给字符串，
            // 那是同一字段两种含义，schema 层根本表达不了。
            relocatable: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'integer', required: true },
                  target: { type: 'string', required: true },
                  lines: { type: 'array', required: true, items: { type: 'integer' } },
                },
              },
            },
            /**
             * 读侧区间句柄（见 `PASSTHROUGH_FIELDS` 上那段长注释）：**只声明形状**，
             * 不做任何语义判断——形状、指纹、解析口径全在引擎（`locator-lab/handle-core.mjs`），
             * 而壳层连它长什么样都不需要知道（句柄是宿主剪枝器不该量到的东西，见契约 §4）。
             *
             * 两者都是**可选**：发不发由引擎按模式决定（map / digest 不发）。
             */
            handle: { type: 'string' },
            handles: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'integer', required: true },
                  handle: { type: 'string', required: true },
                },
              },
            },
            handlesOmitted: {
              type: 'object',
              additionalProperties: false,
              properties: {
                total: { type: 'integer', required: true },
                emitted: { type: 'integer', required: true },
                max: { type: 'integer', required: true },
                reason: { type: 'string', required: true },
              },
            },
            next: { type: 'string' },
            note: { type: 'string' },
            /**
             * 多目标（契约 §2.1/§5）：条数 + 一行汇总 + 逐项回执。
             *
             * 逐项的 `text` 就是**今天那套单目标渲染的输出**（`renderEnvelope`，不另写一份）；
             * 形状与单目标回执的关键字段同形（`outcome` / `mode` / `code` / `next` / `candidates`），
             * 只是把 `path` 换成调用方写的那份 `file_path` 原文（回执原样回抄，与单目标同一条纪律）。
             */
            targets: { type: 'integer' },
            summary: { type: 'string' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'integer', required: true },
                  file_path: { type: 'string', required: true },
                  ok: { type: 'boolean', required: true },
                  outcome: { type: 'string', required: true },
                  mode: { type: 'string' },
                  /**
                   * 区间句柄（可选）：与顶层 `handle` **同源同形**（都是引擎 `windowEnvelope` 发的那个串），
                   * 只是位置不同——多目标没有“一个区间”，句柄必须跟着它自己那一项。
                   * 搜模式的逐命中 `handles` 不在这里重复声明：那是另一个形状，等它真的被需要时再说。
                   */
                  handle: { type: 'string' },
                  code: { type: 'string' },
                  message: { type: 'string' },
                  next: { type: 'string' },
                  candidates: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        line: { type: 'integer', required: true },
                        text: { type: 'string' },
                      },
                    },
                  },
                  text: { type: 'string', required: true },
                },
              },
            },
            /**
             * 续读参数：**下一次调用的确切入参**，与调用方自己写的参数同形同名。
             *
             * 为什么它是一个结构化字段，而不只是 `next` 里那句话：
             * “用 mode=lines 继续”这种建议要求调用方自己把起止行算出来，
             * 而那正是它手里没有的信息（R5 实测：“上次没给够”占重复读的 10.6%，
             * 其中大部分是重新点一遍已经看过的地方）。`resume` 里的值可以原样回填。
             *
             * 形状必须唯一：只有两种取值模式，要么 `{mode:'lines', lines:[a,b]}`，
             * 要么 `{mode:'search', search:'<真的子串>'}`——后者用于“单行太长、
             * 行区间救不了”的那一种截断（只有 search 能看到行内部）。
             *
             * 必填字段只留 `mode`：缺席的字段说明这一种续读不需要它，
             * 而不是“本来有、这次忘了”——后者在本工具上已经出过四次事故。
             */
            resume: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', required: true },
                lines: { type: 'array', items: { type: 'integer' } },
                search: { type: 'string' },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        /**
         * 多目标入口（fs-contract-v2 §2.1）：`targets` 在场 ⇒ 引擎入口，`file_path` 那条路一个字不动。
         *
         * 形状判据（含“与单目标形状互斥”）只有一份，住在 `args.mjs`：壳里再写一遍必然漂开。
         * 它抛的是**参数面**错（`ARGS_TARGETS_SHAPE` / `ARGS_TARGETS_LIMIT` / `ARGS_SHAPE_EXCLUSIVE`），
         * 逐项失败则是结果通道（引擎已把每项封成结果，不抛）。
         */
        const batch = assertReadTargets(args, { toolName: 'aura_read' })
        if (batch !== undefined) {
          // 多目标形状同样要过未知参数守卫：拼错的键不因为换了形状就被放行。
          assertKnownArgs(args, READ_ARG_KEYS, 'aura_read')
          return await readTargetsBatch(ctx, exec, batch)
        }
        /**
         * “二选一”的**另一半**（两个都没给 ⇒ 也拒）只有一份判据，住在 `args.mjs` 的
         * `assertTargetShape`（`src/locator-lab/args.mjs:455`）——壳里原来那句
         * `file_path must be a non-empty string` 是特例写法，已删（它把“没有形状可用”
         * 说成了“file_path 写错了”，而 aura_edit 壳里还长着同一句：两处必然会漂）。
         * 抛的仍是参数面同族码 `ARGS_SHAPE_EXCLUSIVE`；单目标调用照旧带 `file_path`，故这条路一字未变。
         */
        assertTargetShape(args, { toolName: 'aura_read' })
        // 参数形状在这里收敛一次：后面只认 {start, end}，三个调用面（工具壳/CLI/MCP）判据一致。
        const lineRange = lineRangeOf(args)
        if (lineRange === undefined && gaveLineAddress(args)) {
          throw new Error(LINE_ADDRESS_HINT)
        }
        // 给了行区间就用 lines 模式，省掉"顺手再写一个 mode"的机会（写了也尊重）。
        // 未知参数不回默认行为：拼错的字段被静默忽略时，模型看到的是**成功**。
        assertKnownArgs(args, READ_ARG_KEYS, 'aura_read')
        // 未知参数不回默认行为：拼错的字段被静默忽略时，模型看到的是**成功**。
        assertKnownArgs(args, READ_ARG_KEYS, 'aura_read')
        const mode = inferReadMode(args, lineRange)
        const cwd = exec.agent?.session?.header?.cwd
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal,
        })

        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) {
          // **缺失也要记录成一次观测。** 这是 dsh-tool-fs 的契约：`fs/observed` 的
          // `{kind:'absent'}` 让后续 `write` 能走"带防护的创建"而不是被策略拒绝。
          // 我第一版直接抛错、不记录，于是"读一个还不存在的文件，然后创建它"这条
          // 完全正常的流程会在写入侧失败——而且失败原因看起来与读取毫无关系。
          ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
          throw new Error(`cannot read "${target.displayPath}": not found`)
        }
        /**
         * 目录：**不读文件，直接给一张仓库地图**（T26）。
         *
         * 为什么由这里自动接管，而不是加一个 `mode=repo` / `scope=repo`：
         * 实测模型的 `mode` 主动选择率只有 4%（T17），它宁愿让工具选；
         * 而“这个路径是目录”工具自己就看得出来，让模型多填一个参数只是增加决策成本。
         * 判据只有一条：它确实是目录。传目录的人不可能期待“读一个不存在的文件”那个错。
         *
         * 遍历、忽略规则、候选排序、预算全部在 `collectRepoMap` 里——与 CLI 共用一份。
         * 这里只把 ctx.fs 的两个原始能力（列目录 / 读头部字节）接上去。
         */
        const dirChildren = info.type === 'directory' ? await ctx.fs.listDir(target, exec.signal) : undefined
        if (dirChildren !== undefined) {
          const dirCeiling = (() => {
            const pruner = ctx.get('toolResultPruner')
            const threshold = pruner?.config?.thresholdChars
            return Number.isInteger(threshold) && threshold > 0 ? threshold : undefined
          })()
          const env = await collectRepoMap(
            {
              listChildren: (dir) => ctx.fs.listDir(dir, exec.signal),
              readHead: async (childTarget, bytes) => {
                const head = await ctx.fs.readByteRange(childTarget, { offset: 0, length: bytes }, exec.signal)
                return new TextDecoder('utf-8').decode(head)
              },
            },
            target,
            { rootPath: target.displayPath, ...(dirCeiling === undefined ? {} : { budget: dirCeiling }) },
          )
          return {
            path: target.displayPath,
            mode: env.mode,
            totalLines: env.totalLines,
            // 目录（仓库地图）也是一次成功的读——outcome 是必填，两条成功返回都得带。
            outcome: 'applied',
            ...Object.fromEntries(
              PASSTHROUGH_FIELDS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]),
            ),
            text: env.text,
          }
        }
        /**
         * C55：非 UTF-8 文件 ⇒ **可执行的拒绝**。
         *
         * 只换说法，不换通道：它仍是抛错（工具级/环境级故障），不是结果通道——
         * 这一点是刻意留住的（否则「读不了这个文件」会被伪装成「判不出你要哪一段」，
         * 调用方会去改地址/改模式，而它真正要做的是把文件转成 UTF-8）。
         *
         * 后端可能有三种形状，这一层只认「它说了不是 UTF-8」这一条（见
         * {@link isNonUtf8TextFailure}）：裸 `TextDecoder` 的 TypeError（不带路径）、
         * `dsh-fs-local` 翻过的 `FS_NOT_TEXT`（带路径）、以及其它任何含该判据的消息。
         * 其余错误原样抛出，一个字不改。
         */
        let source
        try {
          source = await ctx.fs.readText(target, exec.signal)
        } catch (error) {
          if (!isNonUtf8TextFailure(error)) throw error
          throw Object.assign(new Error(nonUtf8RefusalMessage('read', target.displayPath, 'aura_read')), {
            code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'ERR_ENCODING_INVALID_ENCODED_DATA',
            cause: error,
          })
        }
        // BOM 只存在于字节里（readText 会在解码时丢掉它）——版本令牌要能区分只差 BOM 的两个文件，
        // 就必须把这个事实从字节里取出来交给引擎。
        const byteOrderMark = await fileStartsWithByteOrderMark(ctx.fs, target, exec.signal)
        /**
         * 宿主给"单条工具结果"定的字符上限，**当场读**（不在引擎里抄）。
         *
         * 为什么能读到：`standard` preset 把本工具与 `tool-result-pruner` 放在**同一个
         * isolate realm**（`agent.cordis.yml` 的 compaction 组），服务名 `toolResultPruner`，
         * 它的 `config` 是公开属性（`dsh-compaction-tool-result-pruner/lib/index.js:72`）。
         * 用 `ctx.get` 软取：没部署剪枝器（CLI / MCP / 单测）时落回引擎缺省，而不是让插件停等。
         *
         * 单位注意：该值是 **Unicode 码点**，而引擎量的是 `JSON.stringify(...).length`（UTF-16 码元）。
         * 两者对 BMP 内字符一致；代理对（emoji 等）会让引擎的数字偏大，即偏保守——方向安全，
         * 且因为披露机制在，偏保守不会丢信息。
         */
        const hostCeiling = (() => {
          const pruner = ctx.get('toolResultPruner')
          const threshold = pruner?.config?.thresholdChars
          return Number.isInteger(threshold) && threshold > 0 ? threshold : undefined
        })()
        // 读一次就是一次合法观测：记录当前版本，供后续 changed 比对与其它工具的新鲜度判断
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

        /**
         * ## 宿主看到的**不是**引擎信封，而是这一层包完之后的那个对象
         *
         * 剪枝器量的是工具结果里的 text block（`measureContent` 只看 `block.type === 'text'`），
         * 而那个 text 是本壳 `renderEnvelope` 排过版的正文：引擎信封里的 `omitted` / `next`
         * 会在正文里**再出现一次**，再加上 `path` / `outcome` 这些外壳字段。
         * 于是「引擎信封 ≤ 8192」推不出「工具输出 ≤ 8192」——实测 400 函数的 `map`
         * 在 146 字符路径上交出 **8246 字节**，而引擎当时认为自己合规。
         *
         * 先前试过在引擎里加一个“外壳开销”标量（`path` + `outcome` 的字节数）——**不够**：
         * 真正的大头是那份重排后的说明，而它只有本层算得出来。
         * 所以现在交给引擎的不是一个数，而是**一把尺子**（`request.shippedSize`）：
         * 引擎的收敛循环与最后那道硬断言都用它量。
         *
         * 行为不变：`ship` 就是本工具在成功路径上**原本就要构造**的那个对象，
         * 每次收敛多量一次而已（纯字符串拼接，无 IO）。
         */
        const ship = (envelope) => ({
          path: target.displayPath,
          mode: envelope.mode,
          totalLines: envelope.totalLines,
          // 成功也带 outcome：调用方只看这一个字段就能决定“能不能用这份回执”，
          // 不必按工具名分支，也不必解析 text。
          outcome: 'applied',
          // 可选字段从 PASSTHROUGH_FIELDS 派生，而不是手写展开——理由见该常量的注释。
          ...Object.fromEntries(
            PASSTHROUGH_FIELDS.filter((k) => envelope[k] !== undefined).map((k) => [k, envelope[k]]),
          ),
          text: renderEnvelope(envelope),
        })
        const shippedSize = (envelope) => JSON.stringify(ship(envelope)).length
        const request = {
          /**
           * **显示路径 vs 账本身份**（C61）：这两个是两件事，不能合成一个。
           *
           * `filePath` 是调用方给的那个写法，回执原样回抄它（{@link ship} 与下面两条成功返回
           * 都用它）——硬不许破第 1 条：模型下次要照着回执发调用，替换成 realpath 就对不上了。
           *
           * `identityKey` 是**这份盘上文件是谁**，交给引擎记账用。事实来源是宿主自己：
           * `ctx.fs.resolve()` 的 `targetKey`，`dsh-fs` 的类型契约把它定义为
           * 「Opaque key for stale guards and target lookup」（`lib/types/types.d.ts:10-14`、
           * `:54`），本地后端（`dsh-fs-local/lib/index.js:159`）的实现就是 `await realpath(displayPath)`。
           *
           * 为什么必须在壳这一层递：junction / 符号链接 / 8.3 短名只有文件系统认得，而引擎
           * （`locator-lab/*.mjs`）被 `build/make-bundle.mjs` 的 `copyFile` 守卫禁止直接碰
           * `node:fs`、按平台分支、写盘符字面量。实测后果在 `locator-lab/alias-identity-test.mjs`
           * 段A/段B：读 `…\linkdir\Gamma.js`、第三方改掉被寻址行、再用 `…\realdir\Gamma.js`
           * 发一个无 `expect` 的编辑 ⇒ 改前 `outcome=applied` 且磁盘被静默覆盖。
           *
           * 归一化只有一处实现：引擎的 `read-core.mjs` 的 `ledgerIdentityKey`。这里不重复实现，
           * 只把宿主已有的事实递进去。
           */
          filePath: target.displayPath,
          ...(typeof target.targetKey === 'string' && target.targetKey.length > 0
            ? { identityKey: target.targetKey }
            : {}),
          ...(mode === undefined ? {} : { mode }),
          ...(args.around === undefined ? {} : { around: args.around }),
          // 读侧的 renderLines 只认数组 [start,end]（写侧的 locate 才认 {start,end}）。
          ...(lineRange === undefined ? {} : { lines: asLinePair(lineRange) }),
          ...(args.search === undefined ? {} : { search: args.search }),
          ...(args.context === undefined ? {} : { context: args.context }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
          // changed 的 `since` 用文件版本而非内容指纹：调用方从 read 结果里拿到的是版本，
          // 而版本来自 fs 后端，因此跨进程、跨工具都一致。
          ...(args.since === undefined ? {} : { since: args.since }),
          // 流水线硬上限**现读现传**，不在引擎里抄一个常量。
          // `toolResultPruner.config.thresholdChars` 是可配置的（dsh-base 与三个 preset 都显式写着），
          // 所以"抄进引擎"会在宿主改配置时静默失准（调大→白白少给，调小→中段被剪）。
          ...(hostCeiling === undefined ? {} : { budget: hostCeiling }),
          // 量体量的尺子交给引擎：本层是【引擎信封 ≠ 工具输出】这个接缝的唯一知情人。
          shippedSize,
          byteOrderMark,
        }
        const env = readWith(source, request)
        if (env.ok === false) {
          /**
           * 失败分两种，**在这里分道**（fs-contract-v2 的核心改动）。
           *
           * 旧版无条件抛错，而框架对抛出的错误**只取 `error.message`**
           * （`dsh-tools/lib/index.js:2495-2503` 的 `errorMessage`），挂在错误对象上的
           * 其它字段一概不读——于是 `READ_AMBIGUOUS` 给出的完整候选行，模型一个也没看到。
           * 实测就是这条：引擎知道"第 12、31、58 行都有"，模型只知道"错了"。
           *
           * 现在：判定不出调用方意图（READ_NOT_FOUND / READ_AMBIGUOUS / 坐标越界）
           * ⇒ 走**正常结果**，`outcome` 说清哪一类，`candidates` 原样带回；
           * 工具级与环境级故障（文件不存在、解码失败、IO）⇒ 照旧抛错。
           * 表与理由见 {@link OUTCOME_BY_CODE}。
           */
          const verdict = intentVerdict(env)
          if (verdict !== null) {
            return {
              path: target.displayPath,
              // 失败回执也要给 mode：调用方要知道"这次是按哪种模式找的"，否则没法判断
              // 该改地址还是改模式。env 在失败时不带 mode，所以回退到本次请求的模式 / auto。
              mode: env.mode ?? mode ?? 'auto',
              // totalLines 缺席：没读出内容就不知道总行数，也不编一个数字（见 schema 处的注释）。
              outcome: verdict.outcome,
              code: verdict.code,
              next: verdict.next,
              ...(env.candidates === undefined ? {} : { candidates: env.candidates }),
              // 与成功路径同一个渲染器：失败那段文本（含候选行与 next）就在这里。
              text: renderEnvelope(env),
            }
          }
          throw new Error(`${env.code}: ${env.message}`)
        }

        // 渲染成文本、按 PASSTHROUGH_FIELDS 透传——这就是宿主看到的那一份。
        return ship(env)
      },
      presentCall: (args) => {
        // 多目标的卡片：`file_path` 不在场，照单目标那行拼出来会是 “Read undefined”。
        if (Array.isArray(args?.targets)) {
          return {
            card: 'generic',
            title: `Read ${args.targets.length} targets`,
            kind: 'read',
            rawInput: { targets: args.targets.length },
          }
        }
        const range = lineRangeOf(args)
        const shown = inferReadMode(args, range)
        return {
          card: 'generic',
          title: `Read ${args.file_path}${shown === undefined ? '' : ` (${shown})`}`,
          kind: 'read',
          rawInput: { mode: shown ?? 'auto', around: args.around, lines: range ?? args.lines, search: args.search },
        }
      },
    }),
  )
}
