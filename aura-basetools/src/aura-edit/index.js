/**
 * dsh-tool-patch —— 锚点补丁工具。
 *
 * 命题：agent 改文件不该输出"最终字节"，而该输出"一个声明式操作 + 一段允许有偏差的锚点"。
 * 匹配、消歧、落盘、回滚由宿主承担。相对 `edit` 的变化：
 *   1. 四级降级匹配（exact → 空白折叠 → 行 strip → 相似度），容错缩进/空白/改词/重排；
 *   2. `near` 位置提示把歧义锚点收敛为确定命中（grep 早就知道行号，`edit` 却只认字节）；
 *   3. 一次调用多个 hunk，且整体事务化：任一 hunk 失败则磁盘不变；
 *   4. 降级命中时把"实际改的那段原文"作为回执带回，把不可见的错配变成可见。
 *
 * fs 契约与 `dsh-tool-fs` 完全一致：resolve → 尝试 fs/edit-intent 取守 → fs.editText →
 * fs/observed。因此 fs-observation-policy 与 fs-sandbox 对本工具同样生效。
 *
 * @module dsh-tool-patch
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 结构定位器：零依赖、跨语言。只在**锚点失败**时用来给模型一份符号目录作为恢复路径，
// 不参与成功的定位——实测符号级定位对文本扰动免疫（100% vs 58.6%），而锚点失败里
// 100% 都能被符号名救回（见 locator-lab/recoverable.mjs）。
import { langOf } from '../locator-lab/struct-core.mjs'
// 实体地址（0.23）：解析 → 正文替换 / 词元重命名 hunk。apply 壳只编排，判据全在引擎里。
import { entityRenameHunks, entityToStructureHunk, entityView } from '../locator-lab/entity-core.mjs'
// 定位引擎本身是框架无关的，住在 locator-lab；本文件是它的 **DSH 适配器**。
// 这条依赖方向是刻意的：引擎不认识 Cordis，而 Cordis 侧认识引擎。
// 换一个 agent 框架接进来，只需要另写一个适配器，引擎一行不用动。
import { locate, directoryHint } from '../locator-lab/locator-api.mjs'
// 归一化只有一份实现，住在引擎里。插件里再写一份会让"锚点匹配"与"expect 校验"两处判断
// 可能不一致，而那种不一致极难发现——它只在特定空白组合下才现形。
import { normSpace } from '../locator-lab/anchor-core.mjs'
// 单个 hunk 的“平铺形状”容错**只有一份**（住在 args.mjs，与行区间收敛同一层）：
// DSH 壳与 CLI 共用它。同一套容错规则写两处，就一定会有一处与另一处不一致。
import { MT_EDIT_ELEMENT_KEYS, assertEditTargets, assertKnownArgs, assertLineAddressesNeedExpect, assertTargetShape, editTargetHunks, flatHunk } from '../locator-lab/args.mjs'
// BOM 的字符形态与字节判据都住在引擎里：读路径（aura_basetools_read 的令牌）与写路径（这里）共用一份，
// 否则"令牌说没 BOM、写回却带 BOM"这类不自洽会两处各修一遍。
import {
  BYTE_ORDER_MARK,
  BYTE_ORDER_MARK_BYTES,
  contentToken,
  countByteOrderMarks,
  latestObservation,
  leadingByteOrderMarks,
  readWith,
  rememberRead,
} from '../locator-lab/read-core.mjs'
import {
  PatchError,
  splitLinesWithEndings,
  hasMixedLineEndings,
  // 区域级新鲜度闸门：判据 + 收据都在引擎里（`staleConflicts` / `staleRegionRefusal`），
  // 壳只调决策函数 `regionGate`。此前判据在本文件里也有一份，已删——
  // 同一个决策写在两处，就一定会有一处漏改（本文件被这条坑过一次，见 `symbolHint`）。
  regionGate,
  staleConflicts,
  regionTextIn,
  joinLinesWithEndings,
  planHunks,
  // 0.10.3：严格新鲜度（read-before-write）。判据在引擎里，壳层只把宿主的事实递进去。
  requireObservedRevision,
  // C49：「已落地」的**判据本体**（`old` 两层都不在 + `replace` 整行命中且全文唯一 + 去空白 ≥8 字符）。
  // 与 `planHunks` 同源、同住引擎：壳层只负责把它接进 outcome 通道，**不在这里写第二份判据**——
  // 引擎与壳层各写一份「已经改好了吗」的判断，就是两个判决面（本文件已被这类分叉坑过一次）。
  alreadyAppliedHits,
  fileByteOrderMarkCount,
  carryingByteOrderMarks,
  READBACK_PROBE_EXTRA_BYTES,
  CARRIAGE_RETURN,
  LINE_FEED,
  providerView,
  firstDifference,
  lineEndingCensus,
  verifyWriteBack,
  verifyMismatchError,
  errorCodeOf,
  // fs-contract-v2 §2.2/§3：多目标写侧的**唯一入口**。三阶段提交（全量规划 →
  // 全部可落才提交 → 回读校验）与逐项回执都在引擎里，壳层只把 `ctx.fs` 接成它要的 provider
  // 并把逐项回执渲染出来——本文件里**不写第二份**提交纪律。
  applyEditToProvider,
  applyEditsToProvider,
  // 1.0.2 交付覆盖闸：DSH 的单目标编辑是内联规划（不走 applyEditToProvider），
  // 判据本体必须借引擎那一份，否则同一条规则会在两处各写一遍。
  coverageGate,
} from '../locator-lab/write-path.mjs'

export const name = 'dsh-tool-aura-edit'

/**
 * 硬依赖，与 `dsh-tool-fs` 声明的一致。
 *
 * `systemPrompt` **必须声明**，不能靠 `ctx.get` 兜：用 `ctx.get` 时若服务不可见就静默跳过，
 * 于是"工具注册了但没有指导文本"这种半成品状态**不报错**，表现为模型永远不用这个工具。
 * 声明进 inject 后服务缺失会让插件进入等待，问题在装载期就暴露。
 *
 * 注意：Cordis 的 guard 会拒绝任何未在 inject 里声明的 `ctx.<name>` 访问——
 * `ctx.tools` 不声明就会在 apply 阶段直接抛 "cannot get property ... without inject"。
 */
export const inject = ['fs', 'tools', 'systemPrompt']

/**
 * Test-only seam: the legacy write/convert/edit tool definitions after `apply(ctx)`.
 * Production registers only `aura_basetools_apply`; the old interface suites register these
 * into their mock ctx to keep their assertions. Never read this from production code.
 */
export let lastLegacyTools = null

/**
 * 一个 hunk 的**属性声明**（唯一一份）。
 *
 * 它出现两次：`hunks.items.properties`（数组形状）与顶层（**平铺形状**）。
 * 两处必须是同一份对象，而不是各写一遍——同一条描述写两处必然漂，
 * 而这里漂的后果是“两种写法接受不同的键”，那比拒收更难排查。
 */
const HUNK_PROPERTIES = {
  target: {
    type: 'string',
    description:
      'Symbol to replace, e.g. `toTodoList`, `function:apply`, `Outer/Inner`, `name#2`. Skips all text matching, so it is immune to misremembered content.',
  },
  // 与 aura_basetools_read 同一套宽容声明：模型把区间写成 `4, 6` 时那不是合法 JSON（宿主在参数层就拒），
  // 写成 `"4,6"` / `4` 则是合法 JSON 但形状不对——声明宽一点，能容的都容下来。
  lines: {
    oneOf: [{ type: 'array' }, { type: 'string' }, { type: 'integer' }, { type: 'object', additionalProperties: true }],
    description:
      'Exact line range `[start, end]` (1-based, inclusive), as printed by the read tool. `[n]` means one line. Also accepts "4,6" or a single 4. Preferred instead: `start_line` + `end_line`. A line-number-only address must also pass `expect` (the current text of that range), otherwise it is refused (PATCH_LINES_NEED_EXPECT, nothing written); use `old` for a change inside one line.',
  },
  start_line: {
    type: 'integer',
    description: 'Preferred over `lines`: first line of the range, 1-based inclusive. A line-number-only address must also pass `expect`.',
  },
  end_line: {
    type: 'integer',
    description: 'Preferred over `lines`: last line of the range, 1-based inclusive. Defaults to start_line. A line-number-only address must also pass `expect`.',
  },
  line_cue: {
    type: 'string',
    description:
      'A single word that appears on exactly one line of the file — use when you know roughly where the line is but not its number. Ambiguous cues are rejected with candidate lines.',
  },
  anchor: {
    type: 'string',
    description:
      'A whole-line address: the line (or consecutive lines) you remember, tolerant of whitespace drift and rewording; `replace` overwrites the whole matched line(s). For a change inside one line use `old` (it replaces only the matched span). An anchor that matches only part of a line is refused (PATCH_ANCHOR_FRAGMENT, nothing written).',
  },
  /**
   * 内容地址（fs-contract-v2 / C2 的契约）：`old` 就是地址，坐标降为提示。
   *
   * 名字在这里**冻结**：schema、未知参数守卫（`EDIT_ARG_KEYS` 由本表派生）、参数校验
   * 都读同一份，改名会同时改三处。**语义不在这里**——「怎么用 old 定位、不唯一时怎么扩
   * context 重试」在引擎（`locator-lab/write-path.mjs`，由 C2 实现）；壳层只保证两件事：
   * schema **收得下**、字段**原样传得到引擎**。
   */
  old: {
    type: 'string',
    description:
      'Content address: the exact text you are replacing. `old` (+ optional `context`) locates the region by content, so coordinates become a hint rather than the address. Read the file first and copy the text verbatim.',
  },
  context: {
    type: 'string',
    description:
      'Optional disambiguator for `old`: text that sits next to the region you mean. Only needed when `old` alone matches more than one place.',
  },
  replace: {
    type: 'string',
    /**
     * `required: true` 是**本框架 DSL 的写法**（写在属性里），编译期会被提升成
     * `items.required: ["replace"]`——`aura-edit/load-test` 断言的正是编译后的那个形状。
     *
     * 不能直接写 `items.required: [...]`：那样会被拒（`parameters.hunks.items.required is not
     * supported by the value schema DSL`，插件直接注册失败）。两种写法只差一个位置，实测踩过。
     */
    required: true,
    description: 'Replacement text. Empty string deletes the addressed region.',
  },
  replace_all: {
    type: 'boolean',
    description:
      'With `old`: replace every non-overlapping occurrence, not just a unique one. Left-to-right; cannot be combined with target/lines/line_cue/anchor/context/handle/near (those narrow to one place). If the occurrence count changed since your last read, the whole patch is refused.',
  },
  eol: {
    type: 'string',
    enum: ['auto', 'preserve', 'lf', 'crlf'],
    description:
      'Line-ending style for the replacement. `auto` (default) matches the addressed region (CRLF file => CRLF, no mixed endings); `preserve` keeps the replacement exactly as written; `lf`/`crlf` force one style.',
  },
  expect: {
    type: 'string',
    description:
      'Guard: the content you believe is at that location. A mismatch fails the whole patch instead of editing an uncertain place. Works with every addressing mode.',
  },
  near: {
    type: 'integer',
    description: 'Optional 1-based line number hint that resolves an otherwise ambiguous match.',
  },
  /**
   * fs-contract-v2 / 波H：**区间句柄**（契约 §5）。它把"被编辑的那段字节"从模型手里拿走，
   * 换成工具自己账本里那份逐字节副本的凭据——147 条残余失败里 78.2% 正是"引用本身失真"。
   *
   * 壳层在这里只做两件事：schema **收得下**（否则参数层就把调用拦掉，模型连原因都看不到）、
   * 字段**原样传得到引擎**。句柄的形状校验、过期判定、身份标签核对、区间内相对定位
   * 全在引擎（`locator-lab/handle-core.mjs` + `write-path.mjs`）：壳层**不重写第二份判据**。
   *
   * 名字在这里冻结，并随 `HUNK_PROPERTIES` 自动进 `EDIT_ARG_KEYS`——于是平铺形状
   * `{file_path, handle, replace}` 也被运行期守卫认，不必再登记一处名单。
   */
  handle: {
    type: 'string',
    description:
      'Opaque region handle handed out by `aura_basetools_read` (e.g. `h9f3ac1b2e4d5:120-160`) — the byte-exact region the tool read, so you never have to retype that text. Combine with `line` or `position` to address inside or beside the region. The handle wins over `old`/coordinates; whatever gets ignored is reported back in the receipt.',
  },
  structure: {
    type: 'string',
    description:
      'Structural address: `symbol:<name>` / `section:<title>` / `key:<dotted.path>`. Resolves by structure (name, heading, key path) instead of coordinates, so line drift and whole-body rewrites do not break it. Use it after `handle` when the bytes you read may have been rewritten.',
  },
  /**
   * 段内**相对**定位：区间内第 k 行（1-based，相对区间起点）——整段替换与"只换其中一行"
   * 由此分开。越界是**结果**（`PATCH_HANDLE_LINE_OUT_OF_RANGE`），不是抛错：
   * 那是"你给的坐标不在你给的区间里"这个可判定的事实。
   */
  line: {
    type: 'integer',
    description:
      'With `handle`: the 1-based line **inside** that region (relative to its first line) — swaps just that line without retyping the region. Out of range is reported as a normal not_found receipt.',
  },
  /**
   * 区间**边界**插入：不改动区间本身（契约 §5 的第四种形状）。与 `line` 互斥地表达
   * "在这段之前/之后"，而"在这段里面"由 `line` / `old` 表达。
   */
  position: {
    type: 'string',
    enum: ['before', 'after'],
    description:
      'With `handle`: insert the replacement at the region’s edge instead of replacing the region — `before` or `after`. The region itself is left untouched.',
  },
}

/**
 * 把 `HUNK_PROPERTIES` 里的 `required` 语句剥掉，得到可**展开到另一个对象**的属性表。
 *
 * 为什么需要两份：真框架的 `compilePropertyMap` 会把属性上的 `required: true`
 * 提升到**所属对象**的 `required` 数组。于是同一份属性表在 `hunks.items` 里是对的
 * （一个 hunk 必须有 `replace`），直接展开到顶层就错了——顶层的 `required` 会变成
 * `["file_path","replace"]`，而 `hunks` 与 `create` 两条路都不需要顶层 `replace`。
 * 实测后果：`{file_path, hunks:[…]}` 被 `missing required property "replace"` 拒掉
 * （`aura-edit/load-test` 第 157 行当场抛 INVALID_ARGS）。
 *
 * 两份表由**同一个循环**产出，所以新增一个 hunk 键时不会漏掉任何一份。
 */
const HUNK_PROPERTIES_OPTIONAL = Object.fromEntries(
  Object.entries(HUNK_PROPERTIES).map(([key, spec]) => {
    const { required: _required, ...rest } = spec
    return [key, rest]
  }),
)

// ── receipt schema fragments shared by aura_basetools_edit and aura_basetools_apply ──
// apply returns the edit receipt verbatim, so these shapes must be one declaration, not two.

/** One applied hunk: before/after coordinates, tier, and (0.8.1) the follow-up handle. */
const APPLIED_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true },
    tier: { type: 'string', required: true },
    byNear: { type: 'boolean', required: true },
    actual: { type: 'string', required: true },
    replaced: { type: 'string', required: true },
    eolAdapted: { type: 'boolean' },
    afterLine: { type: 'integer' },
    afterEndLine: { type: 'integer' },
    delta: { type: 'integer' },
    handle: { type: 'string' },
    after: { type: 'string' },
    afterTruncated: { type: 'boolean' },
  },
}

/** Candidate lines: one shape only (`{line, text?}`), shared by success and failure receipts. */
const CANDIDATES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      line: { type: 'integer', required: true },
      text: { type: 'string' },
    },
  },
}

/** A handle the caller can paste back with its own replacement. */
const RETRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { handle: { type: 'string', required: true } },
}

/** Evidence for the `already_applied` outcome. */
const ALREADY_APPLIED_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hunk: { type: 'integer', required: true },
    line: { type: 'integer', required: true },
    tier: { type: 'string', required: true },
    actual: { type: 'string', required: true },
    replaced: { type: 'string', required: true },
  },
}

/** Write-back verification level and byte counts. */
const WRITE_VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    level: { type: 'string', required: true },
    bytes: { type: 'integer' },
    chars: { type: 'integer' },
  },
}

/**
 * 平铺形状下的**内容地址**（`old` + 可选 `context`）。
 *
 * 为什么本文件里还得有这一段：平铺形状由 `flatHunk()`（`locator-lab/args.mjs`）拼装，
 * 而它认的地址键名单（`FLAT_ADDRESS_KEYS`）里还没有这两个名字——那个文件不在本单的
 * 施工范围里。而 schema 一旦声明了 `old`/`context`（它们随 `HUNK_PROPERTIES` 展开到顶层），
 * "声明得比产出宽"就成了一口新的雷：`{file_path, old, context, replace}` 会以**不相关的报错**
 * （"hunks must be a non-empty array"）失败，而模型看不到任何真实原因。
 *
 * 所以这里只补一件事：**顶层确实带了内容地址时**，把它连同 `flatHunk` 已经收好的其余键
 * （replace/expect/near/lines/…）拼成一个 hunk。判据与 `flatHunk` 保持一致——没拿到 `replace`
 * 就不算一个 hunk（返回 null），于是"半成品仍报原错"那条不变。
 *
 * 待办（记在这里以免被忘掉）：`FLAT_ADDRESS_KEYS` 应当吸收 old/context，那时本函数可以删掉——
 * 同一个决策不该有两份判据，这里只是为了不等另一个文件。
 */
function contentFlatHunk(source) {
  const hasOld = typeof source.old === 'string' && source.old.length > 0
  const hasContext = typeof source.context === 'string' && source.context.length > 0
  if (!hasOld && !hasContext) return null
  /**
   * `flatHunk` 在**认不出地址**时会把整个 hunk 判成 null（它只看 `FLAT_ADDRESS_KEYS`），
   * 而 `{file_path, old, context, replace}` 恰好落在那个分支里——于是它手里的
   * replace/expect/near 也一并没了，这里得补回来。
   *
   * 取值判据与 `flatHunk` **逐字一致**（跳过 undefined / null / 空串）：两处对"这个键
   * 算不算给了"的判断一旦不同，同一个入参在两种形状下会得到不同结果。
   */
  const hunk = flatHunk(source) ?? {}
  for (const key of ['replace', 'expect', 'near', 'eol', 'replace_all']) {
    if (hunk[key] !== undefined) continue
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.length === 0 && key !== 'replace') continue
    hunk[key] = value
  }
  if (hasOld) hunk.old = source.old
  if (hasContext) hunk.context = source.context
  return typeof hunk.replace === 'string' ? hunk : null
}

/**
 * 本次调用**有效的** hunk 列表（唯一一份判据）。
 *
 * 它有两个消费者：`execute` 要知道改什么，渲染要知道**句柄 hunk 忽略了什么**。
 * 两处各写一遍的话，"这次哪些 hunk 走了句柄"就有了两个真值来源——本仓为这类漂移付过账。
 */
function hunkListOf(args) {
  const flat = flatHunk(args) ?? contentFlatHunk(args)
  return Array.isArray(args.hunks) && args.hunks.length > 0 ? args.hunks : flat === null ? null : [flat]
}

/**
 * 句柄之外的地址键：`old`/`context` 是**内容**地址，其余是**坐标**地址。
 *
 * 名单在这里是为了"被忽略的一方"能被逐字点名——不是第二份寻址判据：
 * 谁真的生效由引擎决定（`write-path.mjs`），这里只报告"调用方还给了这些"。
 */
const ADDRESS_KEYS_BESIDE_HANDLE = ['old', 'context', 'lines', 'start_line', 'end_line', 'line_cue', 'anchor', 'target']

/** 这个键这次**真的给了**吗（判据与 `flatHunk` 一致：跳过 undefined / null / 空串 / 空数组）。 */
function gaveKey(source, key) {
  const value = source[key]
  if (value === undefined || value === null) return false
  if (typeof value === 'string' && value.length === 0) return false
  if (Array.isArray(value) && value.length === 0) return false
  return true
}

/**
 * 句柄 hunk 的**披露**（契约 §9 的 D7：句柄优先，但**沉默忽略不行**）。
 *
 * 为什么由壳层算：调用方给的那份入参只有壳层见过（引擎拿到的是一个个 hunk），而这一段
 * 的全部职责就是"把被判决忽略掉的那一半说出来"。它不改任何判决，也不碰寻址语义——
 * 既有的 `old` 裁决早就这么做了（引擎的 `coordinateNote`），句柄照做一份。
 *
 * 为什么不把句柄本身抄进正文：正文是宿主剪枝器真正量的东西（契约 §2 不变式 5 / §4），
 * 而调用方知道自己发的是哪个句柄——需要被提醒的是"还有哪些字段这次没被用上"。
 *
 * 没有句柄 hunk 时返回空数组 ⇒ 既有回执**逐字不变**（不动的判据不许被这次改动碰）。
 */
function handleNotes(args) {
  if (args === null || typeof args !== 'object') return []
  const hunks = hunkListOf(args)
  if (!Array.isArray(hunks)) return []
  const notes = []
  hunks.forEach((hunk, index) => {
    if (hunk === null || typeof hunk !== 'object') return
    if (!gaveKey(hunk, 'handle')) return
    const which = hunks.length > 1 ? `hunk ${index + 1}` : 'this hunk'
    const ignored = ADDRESS_KEYS_BESIDE_HANDLE.filter((key) => gaveKey(hunk, key))
    notes.push(
      `  (${which} was addressed by a handle — the region and its bytes come from the tool's own copy of what you read, not from text retyped by you.)`,
    )
    if (ignored.length > 0) {
      notes.push(
        `  ignored because the handle wins: ${ignored.map((key) => `\`${key}\``).join(', ')} — drop the handle if you meant those instead.`,
      )
    }
  })
  return notes
}

/** 把披露附在正文末尾（没有句柄 hunk 时一个字符都不加）。 */
function appendHandleNotes(text, args) {
  const notes = handleNotes(args)
  return notes.length === 0 ? text : `${text}\n${notes.join('\n')}`
}

/**
 * 本工具声明的**顶层参数名**（唯一一份，供未知参数守卫用）。
 *
 * 它必须等于 `parameters` 真实声明的键集合，否则会出现“schema 里有、守卫却拒”
 * 或反过来的情况。`real-framework-smoke-test` 的段C 会拿真框架的校验器核对这一点。
 */
export const EDIT_ARG_KEYS = [
  'file_path',
  'hunks',
  'dry_run',
  'create',
  'require_observation',
  'require_delivered',
  'retry',
  // fs-contract-v2 §2.2：多目标形状。它与 `file_path`/`hunks` **互斥**——
  // 判据只有一份（引擎与壳共调 `assertEditTargets`），这里只登记名字。
  'targets',
  ...Object.keys(HUNK_PROPERTIES),
]

/**
 * `aura_basetools_apply` 的顶层参数名（唯一一份，供未知参数守卫用）。
 * 它与 `EDIT_ARG_KEYS` **分开**：apply 接受 entity/op/change，edit 不接受（反过来也一样）。
 */
export const APPLY_ARG_KEYS = [
  'file_path',
  'entity',
  'op',
  'change',
  'new_name',
  'scope',
  'evidence',
  'dry_run',
  'verify',
  'transaction',
  'expect',
  'hunks',
  'create',
  'content',
  'no_overwrite',
  'allow_unobserved',
  'eol',
  'to',
  'from',
  'bom',
  'repair_double_encoding',
  'require_observation',
  'retry',
  'action',
  'targets',
]

/** Drop undefined values before handing args to a nested defineTool: it validates lossless JSON. */
const definedArgs = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

/**
 * `aura_basetools_write` 的顶层参数名（唯一一份，供未知参数守卫用）。
 *
 * 它与 `aura_basetools_edit` 是两个工具：这里没有 hunks/地址字段，只有“整份内容 + 落盘选项”。
 * 未知键必须拒——拼错的 `content`/`file_path` 被静默忽略时，模型会看到一次成功。
 */
export const WRITE_ARG_KEYS = ['file_path', 'content', 'dry_run', 'no_overwrite', 'allow_unobserved', 'eol']

/** `aura_basetools_write` 的 eol 模式（与 CLI/MCP/引擎同一组）。 */
const WRITE_EOL_MODES = ['auto', 'preserve', 'lf', 'crlf']

export const Config = z.object({})

// ── 与 dsh-tool-fs 一致的观测契约 ──────────────────────────────────────────

/**
 * 模型侧诊断：把 fs 错误码翻成可执行的恢复指令。
 *
 * 两条写回路径的“变了”是不同判据报出来的，但含义一样，因此合成同一句恢复指令：
 *   · `writeText` + `replaceIfVersion`（主路径）⇒ `FS_STALE_VERSION`（提供方级版本 CAS）
 *   · `editText`（后端无 writeText 时的退化路径）⇒ `FS_EDIT_NOT_FOUND`（整份内容匹配不上）
 * 错误码**原样保留**：调用方与测试要能区分“第三方改了文件”与“锚点对不上”。
 * @param error - 捕获到的错误
 * @param displayPath - 面向模型的路径
 * @returns 可直接抛出的错误
 */
function remediate(error, displayPath) {
  const code = errorCodeOf(error)
  if (code === 'FS_EDIT_NOT_FOUND' || code === 'FS_STALE_VERSION') {
    return Object.assign(new Error(`cannot patch "${displayPath}": the file changed while patching — read it again, then retry`), { code })
  }
  if (code === 'FS_AMBIGUOUS_EDIT') {
    return new Error(`cannot patch "${displayPath}": the replacement was not unique — report this, it is a bug`)
  }
  return error
}

/**
 * 把 lab 的符号目录渲染成错误消息里的一段文本。
 *
 * **不再自己挑前 24 个符号。** 这里原本写的是 `listSymbols().slice(0, 24)`，即**声明顺序**——
 * 而实测声明顺序与重要性零相关（前 24 个里 49% 是函数内局部量）。
 * 我在审计时已把 `directoryHint` 改成用共享的 `rankSymbols`，却漏了本文件这一份：
 * **同一个决策写在两处，就一定会有一处漏改**，这次轮到它。
 * 现在只从 lab 取，不再自行挑选。
 */
function symbolHint(displayPath, content) {
  const lang = langOf(displayPath)
  if (lang === null) return ''
  try {
    const dir = directoryHint(content, lang)
    if (dir === null) return ''
    // 英文界面：工具结果会被送进英文会话。此前这里漏出中文"行"字——
    // 我在别处修过同一个决策，却漏了本文件这一份（同一个决策写在两处，必有一处漏改）。
    const rows = dir.symbols.map(
      (s) =>
        `${s.kind} ${s.name} (lines ${s.startLine}-${s.endLine})${s.exported ? ' ★' : ''}` +
        // 跨度判不了的符号不能出现在"改用 target="的建议里而不加标记：
        // 那会让模型重试同一个必然失败的动作。
        (s.spanComplete === false ? ' [span not determinable — use lines=]' : ''),
    )
    return (
      `\n\nThis file's structural directory — locate by name instead of guessing text:\n  ` +
      rows.join('\n  ') +
      `\nRetry with target=<name> (also accepts kind:name, Outer/Inner) and no anchor.`
    )
  } catch {
    // 结构索引失败不能掩盖原始错误——恢复建议是加分项，不是必需品
    return ''
  }
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
 *   ② 为什么读不了——它的字节不是 UTF-8 文本，因此这里根本没有可寻址的文本；并点明这是
 *      **环境级拒绝**，换参数重发不可能成功（否则调用方会去改地址、改模式，
 *      而它真正要做的只是把文件转成 UTF-8）；
 *   ③ 下一步怎么办——先确认编码、再转成 UTF-8、再调一次；并明说**这次一个字节都没改**。
 *
 * 为什么走抛错（工具级故障）而不是结果通道：按本仓口径，「判定不出你的意图」才走结果，
 * 而这一条是环境故障。把「读不了这个文件」伪装成「判不出你要哪一段」是两件不同的事，
 * 会让调用方去重试一个必然失败的形状。写路径上还有一条**结构性**的加强：这一抛发生在
 * `planHunks` 与 `writeText` 之前，所以「没有写盘」不是承诺，而是这条路上不可能有写。
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
 * outcome 的取值（**冻结的名字**，schema 的 `enum` 与下面的判决表读同一份）。
 *
 *   applied        这次调用按调用方的意图执行完毕（改成了 / 建成了 / 预演过了）
 *   needs_choice   有多处都能对上，得由调用方从候选里挑一个
 *   not_found      要改的原文不在文件里（含给的坐标在文件里不存在）
 *   already_applied 要改的原文不在，但结果**已经**是调用方给的样子了（C49 补的第四态：
 *                  这条路上一个字节都没写，且事实上也不需要写）
 *
 * 第四态与 `not_found` 的差别是**事实差别**，不是措辞差别：一个是「你得去改」
 * （重读、重挑地址），另一个是「这次不用改」（调用方上一次其实成功了，或者目标文本
 * 本来就在那儿）。把它们合成一句话，代价是一次重试、或者一次把文件改成错的样子
 * —— 而这条路上磁盘从未被碰过，所以「事实」本来就能逐字核对。
 *
 * `enum` 必须与这份名单同一份（见下面 output.schema 那条注释）：名单加了而 enum 没加，
 * 框架会拿 `INVALID_TOOL_OUTPUT` 把**整条回执**拒掉——模型连这段文字都看不到。
 */
export const OUTCOMES = ['applied', 'needs_choice', 'not_found', 'already_applied']

/**
 * 引擎错误码 → outcome（**缺省态**）。**不在表里的码一律按工具级故障抛错。**
 *
 * 表里的值只记「这个码通常意味着什么」；`PATCH_NOT_FOUND` 还有**第二个出口**
 * （见紧随其后的 `SECOND_EXIT_BY_CODE`），两张表成对读才完整。
 *
 * 方向是刻意选的，两边代价不对称：
 *   · 漏收一个**可判定**码 ⇒ 这条失败还按旧契约报错。是没改进，不是退化；
 *   · 误吞一个**工具级**故障 ⇒ 磁盘没动，调用方却拿到一条"正常结果"并据此认为
 *     事情已经办完。那是静默失败，比报错坏得多。
 * 所以这里用白名单，而不是"default: not_found"。
 *
 * 判据来自真实调用日志（16757 次调用、1565 次失败）里出现过的码：
 * `PATCH_EXPECT_MISMATCH` 936、`LOCATOR_AMBIGUOUS` 155、`PATCH_ANCHOR_NOT_FOUND` 97、
 * `LOCATOR_OUT_OF_RANGE` 32 —— 前四名里有三个正是本表要收的"判定不出意图"。
 *
 * **刻意不收的**（保持抛错，各有理由）：
 *   · `PATCH_STALE_REGION`：安全闸门（地址漂移），不是"读不懂意图"。它的恢复动作是
 *     **重读**，不是重挑地址；降级成结果会让"磁盘没动"看起来像已完成。
 *   · `WRITE_VERIFY_FAILED` / `PATCH_NO_BYTE_EXACT_WRITE` / 任何 FS_* 码：工具级故障。
 *   · `PATCH_NO_ADDRESS`（"这个 hunk 一个地址都没给"，含 `start_line` 写坏那条）：
 *     它是**参数没成形**，与"地址对不上"是两件事。混淆的代价很具体：调用方会去改地址，
 *     而它真正要做的只是把字段写全。同一条边界还有 execute 里那两处 throw。
 */
const OUTCOME_BY_CODE = new Map([
  // 要改的原文不在文件里（含坐标在文件里不存在）
  ['PATCH_NOT_FOUND', 'not_found'],
  ['PATCH_ANCHOR_NOT_FOUND', 'not_found'],
  // 锚点是整行地址，却只引用了行内一段：写前拒绝（零写入），不是工具故障。
  ['PATCH_ANCHOR_FRAGMENT', 'not_found'],
  ['LOCATOR_CUE_NOT_FOUND', 'not_found'],
  ['PATCH_EXPECT_MISMATCH', 'not_found'],
  ['LOCATOR_ASSERT_MISMATCH', 'not_found'],
  ['LOCATOR_OUT_OF_RANGE', 'not_found'],
  ['LOCATOR_BAD_LINES', 'not_found'],
  // 共享行 / lone CR：地址面明确拒绝（不是工具故障）；共享行给候选，属 needs_choice。
  ['LOCATOR_LINE_SHARED', 'needs_choice'],
  ['LOCATOR_LONE_CR', 'not_found'],
  // 符号层（`resolveTarget`）的两种失败：它们与上面是同一类“地址对不上”，
  // 必须走结果通道并带 next/候选；漏进工具故障会让模型只看到一句 error.message。
  ['STRUCT_NOT_FOUND', 'not_found'],
  ['STRUCT_AMBIGUOUS', 'needs_choice'],
  // 符号跨度不完整 / 文件类型未知：可判定、可恢复，不是工具坏了。
  ['LOCATOR_SPAN_INCOMPLETE', 'not_found'],
  ['LOCATOR_NO_LANGUAGE', 'not_found'],
  // 需要调用方从候选里选一个
  ['PATCH_AMBIGUOUS', 'needs_choice'],
  ['LOCATOR_AMBIGUOUS', 'needs_choice'],
  ['LOCATOR_CUE_AMBIGUOUS', 'needs_choice'],
  /**
   * 句柄路的四种**如实拒绝**（契约 §5 解析次序 / §9 的 D6）：句柄过期、身份标签不符、
   * 段内行号越界、`{handle, old}` 而引文不在该区间内。
   *
   * 它们**不是**工具级故障：这四条路上磁盘一个字节都没动，调用方拿到的是一个可判定的
   * 事实，恢复动作是"重读、重寻址"。复用 `PATCH_NOT_FOUND` 会语义说谎（句柄路上引文
   * 是对的那一半），所以码是新的；判决仍是 `not_found`——四态里的第三态。
   *
   * 唯一**仍然抛错**的是"句柄形状不对"（连正则都不匹配）：那是参数面没成形，与
   * `PATCH_NO_ADDRESS` 同族，见 {@link OUTCOME_BY_CODE} 上方的边界说明。
   */
  ['PATCH_HANDLE_STALE', 'not_found'],
  ['PATCH_HANDLE_IDENTITY_MISMATCH', 'not_found'],
  ['PATCH_HANDLE_LINE_OUT_OF_RANGE', 'not_found'],
  ['PATCH_HANDLE_QUOTE_OUTSIDE', 'not_found'],
])

/**
 * 上面那张判决表的**导出面**：表里的键，按表里的顺序，冻结。
 *
 * 它是**派生视图**，不是第二份判据 —— 判据仍在 `OUTCOME_BY_CODE` 上：表的形状、键名、值、
 * 顺序一个都没动，三处按文本解析这张表的套件（`expect-single-source-test` /
 * `success-regression` / `notfound-receipt-test`）照旧活着，它们盯的仍然是那张表本身。
 *
 * 导出它只为一件事：让量具能**程序可读**地拿到这条边界，而不是手抄一份。
 * 唯一的使用者 `probes/tool-error-rate.mjs` 靠它算「引擎抛的码是工具级故障，还是壳层会转成
 * 正常结果」那一格；同一趟里它还会用文本正则把源码里这张表**再解析一遍**，断言两边逐字相等
 * —— 导出面一旦与表漂移，那条断言当场变红。
 *
 * 判据（与上表同一条）：`code ∈ INTENT_CODES` ⇒ 壳层把它转成**正常结果**（`isError=false`）；
 * `code ∉ INTENT_CODES` ⇒ 壳层**抛错**（`isError=true`）。判决本体见 {@link intentVerdict}：
 * `mapped === undefined` 返回 null，调用方拿到 null 就原样抛。
 */
export const INTENT_CODES = Object.freeze([...OUTCOME_BY_CODE.keys()])

/**
 * 「同一个码，两种事实」的**第二出口**：码 → { 细分态, 判据 }。
 *
 * 为什么单独摆一张表、而不把两个名字塞进上面那份值里：上面那张表被**三处按文本解析**，
 * 三处都在找「一条形如 `['CODE', 'outcome']` 的项」：
 *   · `src/locator-lab/expect-single-source-test.mjs` 直接断言 `/\['PATCH_NOT_FOUND',\s*'not_found'\]/`；
 *   · `probes/success-regression.mjs` 用正则把它整张表从壳层源码里解析出来（少一条码就报错）；
 *   · `src/locator-lab/notfound-receipt-test.mjs` 锁着「候选 ≥2 ⇒ needs_choice」那一行。
 * 改值的形状会把这三处一起弄红，而它们要防的正是「壳层判决表漏了一条码」——
 * 用「把表改成别的形状」去满足第四态，代价是丢掉三只已经在那里的眼睛。
 *
 * `PATCH_NOT_FOUND` 为什么会有第二出口：这个码对应的事实有两种——
 *   真的不在（缺省 `not_found`），与「原文不在、但结果**已经**在文件里了」（`already_applied`）。
 * 两件事都是「没写盘」，但恢复动作相反：前者要重读重寻址，后者是「这次不用改」。
 *
 * `hits` 就是引擎那份判据本体（`write-path.mjs` 的 `alreadyAppliedHits`）：全过 ⇒ 回执数组，
 * 任一条不成立 ⇒ `null`。壳层不重写它，也不拓宽它——门槛（整行命中 / 全文唯一 / 去空白≥8字符）
 * 一放宽，「文件里恰好有一行是 `}`」这种巧遇就会被卖成「已经改好了」。
 *
 * 只对 `PATCH_NOT_FOUND` 生效：`PATCH_AMBIGUOUS`（有好几处像）与断言不符是另外两态，
 * 不该被这句话盖住。
 */
const SECOND_EXIT_BY_CODE = new Map([
  ['PATCH_NOT_FOUND', { outcome: 'already_applied', hits: alreadyAppliedHits }],
])

/**
 * 第二出口的证据：这个码有细分态吗？有的话，判据命中了吗？
 *
 * 调用方（`execute` 的 catch）只调这一个函数，不必知道哪几条码有第二出口；
 * 没命中（或这个码压根没有第二出口）一律 `null` ⇒ 原样走缺省态那条路。
 */
/**
 * 第四态的 `message`（事实 first）：**不再抄**引擎那句 `not_found` 的正文。
 *
 * 引擎的 `PATCH_NOT_FOUND` 正文有两大段：一句“你要的原文不在这里，重读文件、
 * 按那里的实际内容重新寻址”，加一段“最近的一带长什么样”。它们在失败那一态是对的，
 * 到这一态却**句句都不成立**（没有要改的东西，也就没什么可重寻址的），而模型对
 * `message` 的敏感度高于任何别的字段。所以这里只留下**两件真事**：
 *   · `old` 确实不在文件里（这是这一支成立的前提，仍然是真话）；
 *   · 你要的结果**已经逐字在那儿了**，落在哪几行——并且请核对那几行是不是你要的地方。
 *
 * 丢掉“最近的一带”不是丢证据：可核的证据在 `already_applied[].actual`（就是命中那一行的原文），
 * 它比“附近长什么样”直接得多。
 */
function alreadyAppliedMessage(hits) {
  const where = hits.map((h) => `line ${h.line}`).join(', ')
  return `the \`old\` text you gave is not in the file — but nothing needs to change: the text you asked to end up there is already there verbatim (${where}). Check that line is the region you meant; this call wrote nothing.`
}

function secondExitEvidence(error, content, hunks) {
  const exit = SECOND_EXIT_BY_CODE.get(errorCodeOf(error))
  return exit === undefined ? null : exit.hits(content, hunks)
}

/** 判定不出意图时的恢复指令（引擎没给 `next` 时才用；引擎给了就以引擎的为准）。 */
const NEXT_BY_OUTCOME = {
  /**
   * 第四态的 `next` **刻意不取 `error.next`**（其余两态取）。
   *
   * 引擎的 `PATCH_NOT_FOUND` 错误对象上确实带一句 `next`，内容是「重读文件、按那里的实际
   * 内容重新寻址」——那是 `not_found` 的恢复动作。到这一态它已经**不成立**了：没有要改的东西。
   * 照抄它等于把「这次不用改」重新卖成「去改点什么」，而模型会真去改。
   * 实测（本轮探针）：`PATCH_NOT_FOUND` 的 `error.next` = "re-read the file (aura_basetools_read) and pass
   * the text exactly as it is there — no line of your old text is in this file"。
   */
  already_applied:
    'nothing to do: this call wrote nothing because the file already holds the replacement you gave — the line(s) above are the file as it is now; re-send this hunk only if you meant to change that text further',
  needs_choice:
    'more than one place matches — pick one of the candidate lines and re-send that hunk addressed by `start_line` + `end_line`, or add `old`/`context` to say which one you mean',
  not_found:
    'the addressed text is not in the file as it is now — re-read it (aura_basetools_read), then address what is actually there',
}

/**
 * 候选位置归一成**一种形状**：`{line, text?}`。
 *
 * 引擎两处给的候选不同形：编辑侧给行号数组（`[2, 6]`，见 anchor-core 的 `PATCH_AMBIGUOUS`），
 * 读取侧给 `{line, text}` 对象。回执要能被一个消费方读懂，就不能让同一个字段名有两种含义——
 * 归一是**壳层的责任**，因为壳层才是"对外的那个契约面"。认不出的条目丢弃而不是硬塞，
 * 免得为了凑形状编出一个不存在的行号。
 */
function normalizeCandidates(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (Number.isInteger(entry)) {
      out.push({ line: entry })
      continue
    }
    if (entry === null || typeof entry !== 'object' || !Number.isInteger(entry.line)) continue
    out.push(typeof entry.text === 'string' ? { line: entry.line, text: entry.text } : { line: entry.line })
  }
  return out
}

/**
 * 判决一次定位失败：**返回判决**（可判定）或 **null**（工具级故障，调用方必须原样抛出）。
 *
 * 只在**定位阶段**调用：目标文件已读到、内容在手、任何字节都还没写。因此这条路上的失败
 * 天然满足"磁盘不变"——不必额外回滚，也不必担心半个事务。第四态也是从这条路出去的，
 * 所以它"一个字节都没写"同样是**结构性**的（不是靠回滚），与引擎侧 `applyEditToProvider`
 * 里那条同源：判决与它描述的事实，必须在同一个位置上成立。
 *
 * @param error - `planHunks` 抛出的错误（PatchError，带 code / candidates / next）
 * @param already - 第二出口的证据（{@link secondExitEvidence} 的返回值）：命中就翻成细分态，
 *   `null` 则走缺省态。**由调用方算好传进来**，而不是在这里 import 引擎：本函数只管
 *   「什么码能落到哪个态」，判据本体住在引擎（`write-path.mjs` 的 `alreadyAppliedHits`）。
 * @returns {{outcome: string, code: string, message: string, candidates?: Array, already_applied?: Array, next: string} | null}
 */
function intentVerdict(error, already = null) {
  if (error === null || typeof error !== 'object') return null
  const code = typeof error.code === 'string' ? error.code : ''
  const mapped = OUTCOME_BY_CODE.get(code)
  // 白名单未命中 ⇒ 工具级故障。**不要在这里改成"默认 not_found"**（理由见上表）。
  if (mapped === undefined) return null
  /**
   * 第二出口：判据命中 ⇒ 这个码指向的是**另一种事实**。
   *
   * 它排在 `candidates` 那条闸门**之前**，因为两者不会同时成立（`already_applied` 要求
   * `replace` 全文唯一，而"有好几处像"要求不唯一）；而先判它有个具体好处：
   * `PATCH_NOT_FOUND` 上不可能带候选，所以这里不会接错东西。
   *
   * `next` 用表里那一份，**不用 `error.next`**（理由写在 `NEXT_BY_OUTCOME.already_applied`）：
   * 引擎给的那句是 `not_found` 的恢复动作，到这一态已经不成立。
   */
  const refined = SECOND_EXIT_BY_CODE.get(code)
  if (refined !== undefined && Array.isArray(already) && already.length > 0) {
    return {
      outcome: refined.outcome,
      code,
      message: alreadyAppliedMessage(already),
      already_applied: already,
      next: NEXT_BY_OUTCOME[refined.outcome],
    }
  }
  const candidates = normalizeCandidates(error.candidates)
  // 候选列表本身就是"需要选"的证据：引擎只要给出 ≥2 个候选，这次失败就是可判定的，
  // 无论它的 code 叫什么。反过来，码说"歧义"却一个候选都没给时，退回 not_found——
  // "从候选里选"却列不出候选，对调用方是一句空话。
  const outcome = candidates.length > 1 ? 'needs_choice' : mapped === 'needs_choice' ? 'not_found' : mapped
  /**
   * 引擎算好的**可粘回地址**（`error.nearest.retry.handle`）：能力面对齐的一处补全。
   *
   * 为什么必须转出来：地址本来就在 `message` 的正文里（模型看得见），但**结构化那半在壳这层被丢了** ——
   * 同一个失败在 CLI 上是 `nearest.retry.handle`、在引擎上是 `error.retry.handle`，唯独 DSH 回执
   * 一个结构化字段都没有。消费方（宿主、写自动化的人）只能去正则抠那段正文；
   * 而“可粘回的地址”的全部价值就在于**机器也能直接用**。
   *
   * 只在引擎真给了的时候带上（没铸出柄就没有地址，不编一个空壳）。
   */
  const retry = error.nearest?.retry
  return {
    outcome,
    code,
    message: String(error.message ?? ''),
    ...(candidates.length === 0 ? {} : { candidates }),
    ...(typeof retry?.handle === 'string' ? { retry: { handle: retry.handle } } : {}),
    next: typeof error.next === 'string' && error.next.length > 0 ? error.next : NEXT_BY_OUTCOME[outcome],
  }
}

/**
 * 判定得出意图时的**正常结果**（不是错误）——三态失败与第四态「已落地」共用这一个构造器。
 *
 * 每个字段都必须在 `output.schema` 里声明过：那是 `additionalProperties:false`，
 * 凭空多一个字段会让整条路径被框架以 `INVALID_TOOL_OUTPUT` 拒掉——
 * 于是"可判定的失败"又变回工具故障，正好是本次要拆掉的那个形状。
 *
 * `applied: []` 是**结构性**的：调用方不必解析文本就能看出"一个 hunk 都没落盘"。
 * 把它写成缺省字段会让消费方在 `value.applied.length` 上拿到 TypeError。
 * 第四态也走这条（它同样一个 hunk 都没落盘），只是额外把证据放进 `already_applied`
 * 并把 `unchanged` 置真；这两个字段只在那一态出现，前三态的回执形状**一字未变**
 * （既有断言直接读 `value.outcome` / `value.code` / `value.candidates`，不受影响）。
 */
function intentReceipt(displayPath, verdict, dryRun) {
  return {
    path: displayPath,
    outcome: verdict.outcome,
    code: verdict.code,
    message: verdict.message,
    ...(verdict.candidates === undefined ? {} : { candidates: verdict.candidates }),
    // 可粘回的地址（见 intentVerdict 的注释）：结构化那半，与正文里那行 `retry:` 同源同名。
    ...(verdict.retry === undefined ? {} : { retry: verdict.retry }),
    // 第四态的可核证据：命中的行号、层级、那一行的**原文**，以及调用方给的那份文本。
    ...(verdict.already_applied === undefined
      ? {}
      : { already_applied: verdict.already_applied, unchanged: true }),
    next: verdict.next,
    applied: [],
    dryRun,
  }
}

// ── 0.23 aura_basetools_apply: entity receipt shapes ───────────────────────

/** Struct-core candidates ({name,kind,startLine}) → the receipt's single {line,text} shape. */
function entityCandidatesOf(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c) => c !== null && typeof c === 'object' && Number.isInteger(c.startLine))
    .map((c) => ({ line: c.startLine, text: `${c.kind ?? 'symbol'} ${c.name ?? ''}`.trim() }))
}

/** `enclosing: null` is normalized away so the receipt schema stays strictly typed. */
function entityRecordOf(entity) {
  return {
    id: entity.id,
    file: typeof entity.file === 'string' ? entity.file : '',
    kind: entity.kind,
    name: entity.name,
    ...(entity.enclosing === null || entity.enclosing === undefined ? {} : { enclosing: entity.enclosing }),
    startLine: entity.startLine,
    endLine: entity.endLine,
    signature: entity.signature,
    structureTarget: entity.structureTarget,
    evidence: { contentHash: entity.evidence.contentHash, spanHash: entity.evidence.spanHash },
  }
}

/** Entity evidence with the observation's version (view.evidence.version is null before a read). */
function entityEvidenceOf(evidence, version) {
  return {
    ...(typeof version === 'string' ? { version } : {}),
    contentHash: evidence.contentHash,
    spanHash: evidence.spanHash,
  }
}

/** Ambiguity / not-found / stale: a normal receipt with zero writes and the reason attached. */
function applyFailureReceipt(displayPath, { code, message, candidates, entity, evidence, dryRun, outcome = 'not_found', next }) {
  const receipt = {
    ok: false,
    path: displayPath,
    outcome,
    code,
    message,
    error: message,
    ...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
    ...(entity === undefined ? {} : { entity }),
    ...(evidence === undefined ? {} : { evidence }),
    applied: [],
    dryRun,
    next,
  }
  receipt.text = renderFailure(receipt)
  return receipt
}

/**
 * `notWrittenClause` / `renderFailure` 在改壳之前就存在：apply 的失败回执走同一个渲染器，
 * 不另写一份「没写盘」的排版。
 */

/**
 * 失败回执抬头里那一句「磁盘动了没有」——**两种事实两个句子**。
 *
 * `landed: true` 只有一个来源：多目标的**阶段三**（回读校验）失败，引擎在那一条上如实标了
 * `landed: true`（`write-path.mjs` 的 `failureItem(..., 'verify', true, ...)`）——磁盘上那份文件
 * **已经被改**，只是回读证明不了它（`WRITE_VERIFY_FAILED`：“the write landed but …”）。
 * 此时抬头若照旧印 “nothing was written”，回执就与磁盘、也与它自己的 `landed` 字段同时矛盾：
 * 调用方会以为可以安心原样重发，而真实的下一步是**先重读**。
 *
 * 单目标那条路上这一态**抛错**（`WRITE_VERIFY_FAILED` 是工具级故障），拿不到回执、也不会带
 * `landed` ⇒ 这一格是批内专有的：取值一改，单目标正文一个字节不动。
 */
const notWrittenClause = (value) =>
  value.landed === true ? 'the write landed but this call could not verify it' : 'nothing was written'

/**
 * 失败回执的渲染。
 *
 * 失败**不再抛错**，所以"模型看得见的那段文本"从此由这里给——而它必须与回执里的
 * 结构化字段说同一件事：一个 hunk 都没落盘（不是"可能没落盘"），为什么，以及下一步。
 */
function renderFailure(value) {
  const head = [
    `${value.path}: ${value.dryRun === true ? 'dry run — ' : ''}${notWrittenClause(value)}`,
    `outcome: ${value.outcome}${typeof value.code === 'string' && value.code.length > 0 ? ` (${value.code})` : ''}`,
  ].join(' — ')
  const lines = [head, value.message]
  if (Array.isArray(value.candidates) && value.candidates.length > 0) {
    lines.push('Candidates:')
    for (const c of value.candidates) {
      lines.push(`  line ${c.line}${typeof c.text === 'string' ? `: ${c.text}` : ''}`)
    }
  }
  if (typeof value.next === 'string' && value.next.length > 0) lines.push(`next: ${value.next}`)
  return lines.join('\n')
}

/**
 * 「已落地」回执的渲染（C49）：**说清三件事**——没写盘、为什么没写、以及可核的证据。
 *
 * 为什么不能复用 `renderFailure`：它开头那句是 `nothing was written` 加上引擎的失败正文
 * （"要改的原文不在文件里"），读起来就是"你得去改"——而这一态的全部内容恰好相反。
 * 模型的下一步动作由这两句话决定，而它们的代价不对称：把"已经改好了"报成"找不到"会让它
 * 重读、重寻址、甚至把文件改成错的样子；把"找不到"报成"已经改好了"则是静默失败。
 * 所以两者必须是**两个不同的句子**，且各自带上自己的证据。
 *
 * 证据就是命中的那一行（`line` + `tier` + 原文）。它是**引擎逐字算出来的**：`actual` 是文件
 * 里那一行的原文、`replaced` 是调用方给的那份文本——两者逐字相等才是"已经是你给的样子"。
 * 引用时用 `JSON.stringify` 而不是裸拼：制表符、不可见空白、CR 都会在裸拼里变成"看着一样"，
 * 而这一态的全部价值就是让调用方**能自己核对**。
 */
function renderAlreadyApplied(value) {
  const head = [
    `${value.path}: ${value.dryRun === true ? 'dry run — ' : ''}nothing was written`,
    `outcome: ${value.outcome}${typeof value.code === 'string' && value.code.length > 0 ? ` (${value.code})` : ''}`,
  ].join(' — ')
  const lines = [head]
  /**
   * “为什么没写”不在这里另写一句，而是直接用回执里的 `message`（单源）。
   * 两处各写一句的代价本仓已经付过：同一个判决写在两处，必有一处漏改。
   * 它只在该字段缺位的 mock/降级形状下才回退到一句固定的。
   */
  if (typeof value.message === 'string' && value.message.length > 0) lines.push(value.message)
  else lines.push('nothing needs to change: the text you asked to end up there is already in the file as you gave it.')
  lines.push('evidence (the file as it is now — check this is the region you meant):')
  for (const hit of value.already_applied) {
    lines.push(`  line ${hit.line} [${hit.tier}]: ${quoteHit(hit.actual)}`)
  }
  if (typeof value.next === 'string' && value.next.length > 0) lines.push(`next: ${value.next}`)
  return lines.join('\n')
}

/**
 * 把一条命中原文引成**一行**：首行 JSON 转义 + 多行时自报还差几行。
 *
 * 转义是必须的（见 `renderAlreadyApplied` 的注释）；截断只影响显示，不影响 `already_applied`
 * 里那个逐字的字段——回执同时给了两份，要逐字核对的读字段，要一眼看懂的读这行。
 */
function quoteHit(text) {
  const rows = String(text).split('\n')
  const first = rows[0]
  const clipped = first.length > 120 ? `${first.slice(0, 120)}…` : first
  return `${JSON.stringify(clipped)}${rows.length > 1 ? ` +${rows.length - 1} more line(s)` : ''}`
}

const FUZZY_TIERS = new Set(['norm-space', 'trim-line', 'similarity', 'aligned'])

/**
 * 回执：**报告替换后的内容**，并说明这次命中的是哪个区间。
 *
 * 这里改过一次，起因是真实模型的一句反馈。原版引用的是 `actual`，也就是**改之前**那一段：
 *
 *   line 6 [lines] "  if (value === 0) return { kind: 'zero' };"
 *
 * 模型的评论逐字如下：
 *   "the tool's receipt echoes the addressed line … that reads as the *pre-replacement* content,
 *    not evidence the replacement failed."
 *
 * 它说得对：回执的全部用处就是让模型确认改对了，而显示改前内容做不到这一点——
 * 反而让人怀疑是不是没改。现在报告**改后**内容，改前内容仅在两者都短时一并显示。
 */
function renderResult(value) {
  const lines = [`${value.path}: ${value.applied.length} hunk(s) applied.`]
  for (const a of value.applied) {
    const flags = [a.tier, a.byNear ? 'by near' : null].filter(Boolean).join(', ')
    const clip = (t) => {
      const one = t.split('\n')[0]
      const multi = t.includes('\n')
      const short = one.length <= 64
      return multi || !short ? `${JSON.stringify(short ? one : `${one.slice(0, 64)}…`)}${multi ? ` +${t.split('\n').length - 1} more line(s)` : ''}` : JSON.stringify(one)
    }
    const after = a.after ?? a.replaced ?? ''
    // 单行 → 单行的替换，把 before → after 都给出；否则只给改后，避免刷屏
    const singleLineSwap = !a.actual.includes('\n') && !after.includes('\n')
    lines.push(
      singleLineSwap
        ? `  line ${a.line} [${flags}] ${clip(a.actual)} → ${clip(after)}`
        : `  line ${a.line} [${flags}] now: ${clip(after)}`,
    )
    /**
     * 0.8.1：改后坐标与可复用句柄。`line` 是改前坐标；下一处同一区域的编辑不必回读，
     * 直接拿这里给的句柄（或 afterLine）定位即可。
     */
    if (a.afterLine !== undefined) {
      const delta = a.delta === 0 ? 'same line count' : `${a.delta > 0 ? '+' : ''}${a.delta} line(s)`
      const handle = a.handle === undefined ? '' : `, handle ${a.handle}`
      const truncated = a.afterTruncated === true ? ', after truncated' : ''
      lines.push(`  now lines ${a.afterLine}-${a.afterEndLine} (${delta})${handle}${truncated}`)
    }
  }
  if (value.applied.some((a) => FUZZY_TIERS.has(a.tier))) {
    lines.push('  (a hunk matched by fallback — confirm the quoted text is the region you meant.)')
  }
  /**
   * 靠 `near` 收敛出来的命中，把**那条确定地址**一并给出。
   *
   * 理由：`near` 是模型唯一的"歧义时也能试一下"的手段，而它这次之所以生效，是因为文件里
   * 确实存在那个提示行。把这个事实变成可复用的坐标，下一次就不必再赌一次 `near`。
   * 不增加任何代价：坐标在 `applied[].line` 里已经算好了，只是没说出来。
   */
  const byNear = value.applied.filter((a) => a.byNear === true)
  if (byNear.length > 0) {
    lines.push(
      `  (${byNear.length} hunk(s) resolved by the \`near\` hint — next time address ${byNear
        .map((a) => `line ${a.line}`)
        .join(', ')} directly, no hint needed.)`,
    )
  }
  return lines.join('\n')
}

/**
 * 单目标回执**正文**的四种分叉（成功 / 失败 / 已是你给的样子 / 预演）——**唯一一份**。
 *
 * 它原来是写在 `render` 里的一个三目链；多目标逐项要的正是同一段文本，所以提出来共用
 * （表达式逐字未改 ⇒ 单目标正文逐字节不变）。句柄披露不在里面：它由调用处append（见 `render`），
 * 而多目标按**元素**逐项 append（每一项目己的 `handle` hunk 自己披露）。
 */
function receiptBody(value) {
  if (value.outcome === 'already_applied') return renderAlreadyApplied(value)
  if (value.outcome !== 'applied') return renderFailure(value)
  return value.dryRun === true
    ? `Dry run for ${value.path} — every hunk matched; nothing was written.\n${renderResult(value)}`
    : renderResult(value)
}

/**
 * 引擎逐项那格 `outcome`（`applied` / `created` / `already_applied` / `dry_run`）→
 * **壳层回执**那格 `outcome`（{@link OUTCOMES} 里那几格）。
 *
 * 两个词表问的不是同一件事，所以不能直接对拷：
 *   · 引擎按“**它怎么做到的**”分类（改成了 / 建成了 / 预演过了 / 已经是你要的样子）；
 *   · 壳层的成功词表只有两格——`applied` 与 `already_applied`，而“建成”与“预演”
 *     由**别的字段**表达（`applied[].tier === 'create'`、`dryRun === true`）。单目标那条路上
 *     它们也正是 `outcome: 'applied'`（见 `registerTools` 里三个成功 return 与 `intentReceipt`）。
 *
 * 逐格有据，且逐格只对应引擎 {@link receiptKindOf} 的一个分支（`write-path.mjs`）：
 * 那张表只有这四种产出，第五种不存在，所以这里不需要缺省分支去猜。
 */
const SHELL_OUTCOME_BY_ENGINE_KIND = new Map([
  ['applied', 'applied'],
  ['created', 'applied'],
  ['dry_run', 'applied'],
  ['already_applied', 'already_applied'],
])

/**
 * 逐项回执进**同一个** `receiptBody` 之前，把壳层那格 `outcome` 补齐。
 *
 * 为什么非补不可（实测缺陷，0.6.12）：`receiptBody` 按 `value.outcome` 分四支，而单目标那条路上
 * 这一格是**壳层自己填的**；引擎回执只有 `already_applied` 那一态自带 `outcome`，成功 / 创建 /
 * 预演三态把“怎么做到的”记在 `applied[].tier` / `operation` / `dryRun` 上。不补这一格，
 * `undefined !== 'applied'` 会把一次**已经落盘**的编辑交给失败渲染器，正文印出
 * 「nothing was written — outcome: undefined」：抬头那行说 `applied`、正文说“什么都没写”，
 * 同一条回执自相矛盾，模型据此去重试一次本来就成功的编辑。
 *
 * 取的是引擎**已经算好**的那个事实（逐项 `outcome`，见 `write-path.mjs` 的 `receiptKindOf`），
 * 壳层本来就在读它（`batchOutcomeOf` 的整批判决、正文抬头那行）。这里只做**词表对齐**：
 * 不新增判据、不新增渲染分支、不写第二份排版——分叉仍全部由 `receiptBody` 那三行决定。
 *
 * `already_applied` 那一态引擎自带 `outcome`，原样透传（逐字节不动）。冒出一个表外的
 * 引擎态时**不编**一个壳层词：原样交下去，宁可让缺陷可见，也不把未知说成成功。
 */
function shellReceiptOf(edit) {
  const receipt = edit.receipt
  if (typeof receipt.outcome === 'string') return receipt
  const outcome = SHELL_OUTCOME_BY_ENGINE_KIND.get(edit.outcome)
  return outcome === undefined ? receipt : { ...receipt, outcome }
}

/**
 * 逐项正文的失败那一支：引擎的 `error`（`code`/`message`/`next`）拼成**同一个**失败渲染器
 * 认得的那本书——本文件里不写第二份失败排版。
 */
/**
 * 逐项正文：`receipt` 在场就走 `receiptBody`（**同一个**渲染器，成功/失败/已改好/预演四种分叉
 * 一个不差）；没成的那些（阶段一/二的失败，以及“同批里另一项没规划成 ⇒ 本轮一字未写”）
 * 由引擎给了 `error`（`code`/`message`/`next`）或 `note`，拼成 `renderFailure` 认得的形状
 * ——本文件里**不写第二份**失败排版。
 *
 * 句柄披露是按**元素**逐项 append 的（每一项目己的 `handle` hunk 自己披露），
 * 而单目标那条路的披露仍然只在 `render` 里 append 一次（无句柄 hunk 时一个字符不加）。
 */
function batchItemBody(edit, element) {
  if (edit.receipt !== undefined) return appendHandleNotes(receiptBody(shellReceiptOf(edit)), element)
  const failure = {
    path: edit.file_path,
    outcome: typeof edit.outcome === 'string' ? edit.outcome : 'not_found',
    // 已落地却没收尾（阶段三回读校验失败）那一项：抬头那句不能再说“没写盘”（见 `notWrittenClause`）。
    // 只在真的为 true 时带上，其余形状逐字不变。
    ...(edit.landed === true ? { landed: true } : {}),
    ...(edit.error === undefined ? {} : { code: edit.error.code }),
    message: edit.error?.message ?? edit.note ?? '',
    ...(edit.error?.next === undefined ? {} : { next: edit.error.next }),
  }
  return appendHandleNotes(renderFailure(failure), element)
}

/**
 * 整批的三态 `outcome`（输出 schema 的 enum 只有 `OUTCOMES` 那几格）。
 *
 * 判决本体是**逐项**的（契约 §1.3）：这一格只回答“还有没有得看的”。全落地 ⇒ `applied`；
 * 全部早就是你给的样子 ⇒ `already_applied`；否则取**第一条失败**的码去查本文件既有那张
 * `OUTCOME_BY_CODE` 表（与单目标同一个映射面），查不到就不编一个：回 `not_found`。
 */
function batchOutcomeOf(edits) {
  const failed = edits.filter((edit) => edit.outcome === 'failed')
  if (failed.length === 0) {
    return edits.every((edit) => edit.outcome === 'already_applied') ? 'already_applied' : 'applied'
  }
  const mapped = OUTCOME_BY_CODE.get(failed[0].error?.code)
  /**
   * `OUTCOME_BY_CODE` 的值就是**壳层那格词本身**（字符串），不是 `{outcome, …}` 那种对象
   * （对象形状只有 `SECOND_EXIT_BY_CODE` 那张表才有）。这里曾经写成 `mapped?.outcome`：
   * 在字符串上取 `.outcome` 永远是 `undefined` ⇒ 任何一批带失败的调用都落回 `not_found`，
   * 于是一批“两处都能对上、等你挑一处”的编辑被整批报成 `not_found`——两者要的恢复动作
   * 正好相反（重挑地址 vs 重读文件）。判据：`src/aura-edit/outcome-test.mjs` 段I 的 I5。
   */
  return typeof mapped === 'string' ? mapped : 'not_found'
}

/**
 * **多目标写**（fs-contract-v2 §2.2/§3）：`targets` ⇒ 引擎入口 `applyEditsToProvider`。
 *
 * ## provider 怎么接
 *
 * 引擎的 provider 契约是 `(displayPath, signal)`——它**不碰** `node:fs`，路径解析与沙箱策略
 * 都必须在壳这层递进去（沙箱策略照第 5 个参数，与单目标那条路同一个位置；漏传会让本工具在
 * `workspace-write` 下写不动）。同一路径不得解析多次（真实后端上是 realpath）⇒ 按路径
 * 记忆化一个 Promise，每条路径最多一次 `ctx.fs.resolve`。
 *
 * ## 单目标那条路
 *
 * 一个字没动：`targets` 缺席时 `assertEditTargets` 立即返回 undefined（纯计算，零 provider 调用），
 * `execute` 继续走它今天的 `ctx.fs.resolve/stat/readText/writeText` 序列。
 */
async function applyEditTargets(ctx, exec, args, targets, policy) {
  const cwd = policy?.workspaceRoot ?? exec.agent?.session?.header?.cwd
  const signal = exec.signal
  const pending = new Map()
  const resolved = (displayPath) => {
    let promise = pending.get(displayPath)
    if (promise === undefined) {
      promise = Promise.resolve(ctx.fs.resolve(displayPath, { ...(cwd === undefined ? {} : { cwd }), signal }))
      pending.set(displayPath, promise)
    }
    return promise
  }
  const provider = {
    stat: async (displayPath, at) => ctx.fs.stat(await resolved(displayPath), at ?? signal),
    readText: async (displayPath, at) => ctx.fs.readText(await resolved(displayPath), at ?? signal),
    readByteRange: async (displayPath, range, at) =>
      ctx.fs.readByteRange(await resolved(displayPath), { offset: range.offset, length: range.length }, at ?? signal),
    writeText: async (displayPath, content, expected, at) =>
      ctx.fs.writeText(await resolved(displayPath), content, expected, at ?? signal, policy),
  }
  const batch = await applyEditsToProvider(provider, {
    targets,
    ...(args.dry_run === undefined ? {} : { dryRun: args.dry_run }),
    ...(args.require_observation === true ? { requireObservation: true } : {}),
    ...(args.require_delivered === true ? { requireDelivered: true } : {}),
    ...(args.retry === true ? { retry: true } : {}),
    ...(signal === undefined ? {} : { signal }),
  })
  const elements = Array.isArray(args.targets) ? args.targets : []
  const edits = batch.edits.map((edit) => ({ ...edit, text: batchItemBody(edit, elements[edit.index]) }))
  return {
    // `path` 是必填字段，而这一批没有“一个路径”——给它整批的事实（逐项路径在 `edits` 里）。
    path: `${batch.targets} targets`,
    outcome: batchOutcomeOf(edits),
    // 顶层 `applied` = 全批 hunk 的并集（逐项各自的 `applied` 在 `edits[i].receipt` 里，一字未改）。
    applied: edits.flatMap((edit) => edit.receipt?.applied ?? []),
    dryRun: edits.some((edit) => edit.receipt?.dryRun === true),
    targets: batch.targets,
    // 汇总行**只在这里**（引擎算的那一行原样带回来）：不进任何一项的正文。
    summary: batch.summary,
    unchanged: batch.unchanged,
    // “哪些已落地、哪些没有”（契约 §3.4）：阶段一失败时 landed_paths 为空、not_landed_paths 全在。
    landed_paths: batch.landed_paths,
    ...(batch.not_landed_paths === undefined ? {} : { not_landed_paths: batch.not_landed_paths }),
    ...(batch.aborted === undefined ? {} : { aborted: batch.aborted }),
    ...(batch.partial === undefined ? {} : { partial: batch.partial }),
    edits,
    // 正文 = 逐项正文的顺序拼接（每项一行 `路径 — outcome` 抬头，否则 N 段正文认不出归属）。
    text: edits.map((edit) => `${edit.file_path} — ${edit.outcome}\n${edit.text}`).join('\n\n'),
  }
}

// ── 插件 ────────────────────────────────────────────────────────────────────

/**
 * 注册 `aura_basetools_edit` 工具，以及配套的提示段。
 *
 * ## 为什么必须同时注册提示段
 *
 * 只注册工具是不够的——实测结论。内置 `tool-fs` 会注入命令式指导：
 * "Use the edit tool for targeted changes to existing UTF-8 text files"，
 * 而本工具只有 schema、没有一句话指导。于是模型面对"改文件"时，提示词明确说用 `edit`。
 *
 * 位置放在 `TOOL_EDIT`(1300) 之后：提示词里靠后的指导压过靠前的。
 *
 * ## 为什么策略服务是可选注入
 *
 * Resolved through `ctx.inject([...])` instead of being declared in this plugin's own
 * `inject` — the same treatment `dsh-tool-fs` gives the optional `attachments` service.
 * The distinction matters: a hard declaration parks the whole plugin in a waiting state
 * when the service is absent, so the tools would never register, yet a deployment with no
 * sandbox is exactly the one that needs no policy. With `ctx.inject([...])` the callback
 * binds when the service appears and simply does not bind otherwise.
 *
 * Once resolved, the {@link registerTools} closure holds it and computes the calling
 * session's policy on every execution.
 *
 * @param ctx - 携带文件系统、工具注册表与提示词注册表的上下文。
 */
export function apply(ctx) {
  let policyService
  ctx.inject(['sandboxPolicy'], (policyCtx) => {
    policyService = policyCtx.sandboxPolicy
  })
  registerTools(ctx, () => policyService)
}

/**
 * 注册工具与提示段。
 *
 * 与 `dsh-tool-fs` 的 `apply(ctx, sandbox)` 同形：策略是**参数**而不是闭包里的全局，
 * 于是"哪一份策略生效"在调用点一眼可见。
 *
 * @param ctx - 上下文。
 * @param sandbox - 返回当前 `sandboxPolicy` 服务的取值函数（可能返回 undefined）。
 */
function registerTools(ctx, sandbox) {
  // 与 dsh-tool-fs 一致：按 scope 检查工具可见性。`systemPrompt` 已声明进 inject，
  // 因此直接访问——用 `ctx.get` 兜会静默跳过，而"工具注册了却没有指导"正是踩过的坑。
  /**
   * `aura_basetools_write`：整份新建/覆写。
   *
   * 与 `aura_basetools_edit` 同一个插件、同一套 `ctx.fs` 契约；差别只在入口语义——它没有 hunk/地址，
   * 只接“整份内容 + 落盘选项”。注册顺序放在 `aura_basetools_edit` **之前**：`load-test` 等套件用
   * “最后一次 register”取 `aura_basetools_edit`，保持它们不动；`real-framework-smoke` 按名字找。
   */
  ctx.systemPrompt.section({
    name: 'tool:aura-write',
    order: 1319,
    text: ({ scope }) =>
      ctx.tools.get('aura_basetools_write', scope) === undefined
        ? ''
        : [
            'Use the aura_basetools_write tool to create a new file or replace a whole file in one call — not the built-in write.',
            'For any partial change use aura_basetools_edit: it preserves every untouched byte and has addressing / expect guards.',
            'Overwriting requires the current revision to have been read (aura_basetools_read) in this session; set `allow_unobserved` only when you deliberately accept a blind overwrite.',
            '`dry_run` previews without writing, `no_overwrite` refuses an existing file, and `eol` controls line endings (`auto` follows the file, `preserve` writes the content exactly, `lf` / `crlf` force one style).',
          ].join(' '),
  })

  const writeTool = defineTool({
      name: 'aura_basetools_write',
      description:
        'Create or replace a whole UTF-8 text file in one call. It preserves a leading BOM and (with `eol: "auto"`) the file\'s line-ending style, writes through the host filesystem with a version check, and reads the file back to verify. ' +
        'For partial changes use `aura_basetools_edit` instead — it preserves every byte you did not address. ' +
        'Overwriting an existing file requires the current revision to have been read (aura_basetools_read) in this session; `allow_unobserved: true` is the explicit blind-write escape hatch. ' +
        '`dry_run` previews without writing; `no_overwrite` refuses an existing file; `eol` is auto | preserve | lf | crlf.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path to create or replace, resolved by the filesystem backend.' },
        content: { type: 'string', required: true, description: 'The complete file content. Empty string writes an empty file.' },
        dry_run: { type: 'boolean', description: 'Plan and validate without touching the file; the receipt says create/write and dryRun=true.' },
        no_overwrite: { type: 'boolean', description: 'Refuse when the file already exists (WRITE_EXISTS) instead of replacing it.' },
        allow_unobserved: {
          type: 'boolean',
          description: 'Allow overwriting a revision this session has not read (or that changed since it was read). The receipt is marked unverified_region.',
        },
        eol: {
          type: 'string',
          enum: WRITE_EOL_MODES,
          description: 'Line-ending policy for an overwrite: auto (default) follows the existing file; preserve writes content exactly; lf/crlf force one style. A new file is always written exactly as given.',
        },
      },
      additionalProperties: false,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            operation: { type: 'string', enum: ['create', 'write'], required: true },
            // 与 aura_basetools_edit 共用 OUTCOMES 里的成功态；create/write 的区分在 operation。
            outcome: { type: 'string', enum: ['applied'], required: true },
            dryRun: { type: 'boolean', required: true },
            bytes: { type: 'integer' },
            unverified_region: { type: 'boolean' },
            write_verify: WRITE_VERIFY_SCHEMA,
          },
        },
        render: (_args, value) => {
          const planned = value.dryRun === true ? 'would ' : ''
          const bytes = typeof value.bytes === 'number' ? `, ${value.bytes} bytes` : ''
          const warning =
            value.unverified_region === true
              ? '\nunverified_region: this revision was not read in this session; the write was allowed only because allow_unobserved was set.'
              : ''
          return [{ type: 'text', text: `${value.path} — ${planned}${value.operation}${bytes}${warning}` }]
        },
      },
      async execute(args, exec) {
        assertKnownArgs(args, WRITE_ARG_KEYS, 'aura_basetools_write')
        if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
          throw new Error('file_path must be a non-empty string')
        }
        if (typeof args.content !== 'string') throw new Error('content must be a string')
        const eol = args.eol ?? 'auto'
        if (!WRITE_EOL_MODES.includes(eol)) {
          throw new PatchError('write `eol` must be auto, preserve, lf, or crlf — nothing was written', 'WRITE_BAD_ARGS')
        }
        const policyService = sandbox()
        const policy =
          policyService === undefined
            ? undefined
            : policyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
        const cwd = policy?.workspaceRoot ?? exec.agent?.session?.header?.cwd
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal,
        })
        const info = await ctx.fs.stat(target, exec.signal)
        if (info !== undefined && args.no_overwrite === true) {
          throw new PatchError(`cannot write "${target.displayPath}": it already exists (no-overwrite)`, 'WRITE_EXISTS')
        }
        if (info === undefined && eol !== 'auto') {
          throw new PatchError(
            'write `eol` applies when overwriting an existing file; a new file is written exactly as given — pass the endings you want in `content`',
            'WRITE_BAD_ARGS',
          )
        }
        // 与 aura_basetools_edit 同一条观察契约：写之前先告诉策略我们看见了什么（absent / present + version）。
        ctx.emit(
          'fs/observed',
          target,
          info === undefined ? { kind: 'absent' } : { kind: 'present', version: info.version },
          exec,
        )
        let writtenVersion
        const provider = {
          stat: async (_displayPath, at) => ctx.fs.stat(target, at ?? exec.signal),
          readText: async (_displayPath, at) => ctx.fs.readText(target, at ?? exec.signal),
          readByteRange: async (_displayPath, range, at) =>
            ctx.fs.readByteRange(target, { offset: range.offset, length: range.length }, at ?? exec.signal),
          writeText: async (_displayPath, content, expected, at) => {
            const out = await ctx.fs.writeText(target, content, expected, at ?? exec.signal, policy)
            writtenVersion = out?.version
            return out
          },
        }
        let receipt
        try {
          receipt = await applyEditToProvider(provider, {
            displayPath: target.displayPath,
            hunks: [],
            ...(info === undefined
              ? { create: args.content }
              : {
                  wholeFile: args.content,
                  eol,
                  // 覆写默认要求先读过这一版；allow_unobserved 同时越过严格闸、区域闸与覆盖闸。
                  requireObservation: args.allow_unobserved !== true,
                  requireDelivered: args.allow_unobserved !== true,
                  skipStaleGate: args.allow_unobserved === true,
                }),
            dryRun: args.dry_run === true,
            ...(typeof target.targetKey === 'string' && target.targetKey.length > 0
              ? { identityKey: target.targetKey }
              : {}),
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          })
        } catch (error) {
          if (!isNonUtf8TextFailure(error)) throw error
          throw Object.assign(new Error(nonUtf8RefusalMessage('write', target.displayPath, 'aura_basetools_write')), {
            code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'ERR_ENCODING_INVALID_ENCODED_DATA',
            cause: error,
          })
        }
        if (receipt.dryRun !== true && writtenVersion !== undefined) {
          ctx.emit('fs/observed', target, { kind: 'present', version: writtenVersion }, exec)
        }
        const operation = receipt.operation ?? (info === undefined ? 'create' : 'write')
        const verify = receipt.write_verify
        return {
          path: target.displayPath,
          operation,
          outcome: 'applied',
          dryRun: receipt.dryRun === true,
          ...(verify?.bytes === undefined ? {} : { bytes: verify.bytes }),
          ...(receipt.unverified_region === true ? { unverified_region: true } : {}),
          ...(verify === undefined ? {} : { write_verify: verify }),
        }
      },
    })

  /**
   * `aura_basetools_convert`（0.23）：本地换编码 / 换行尾 / 增删 BOM。
   *
   * ## 为什么这一面只支持目标 UTF-8
   *
   * 宿主的 `ctx.fs.writeText` 是 **UTF-8 only**（`dsh-fs` 契约："Atomically create or replace
   * UTF-8 text"），字节级写入没有开口。`readBytes` 有，所以“读到原始字节、自己解码、写成 UTF-8”
   * 可行；反过来把 GBK/UTF-16 字节写回去**不可行**。其余目标编码走 CLI：
   * `aura basetools convert --to <编码>`（独立面有自己的字节写入口）。
   *
   * 源侧不猜：给了 `from` 就按它解码；没给则只接受**合法 UTF-8**，其余情况要求显式给 `from`。
   * 这比“猜一个”保守，但与“拒绝而不是猜”是同一方向。
   */
  const convertTool = defineTool({
      name: 'aura_basetools_convert',
      description:
        'Convert a text file to UTF-8 locally, without sending its content through the model: decode raw bytes (explicit `from`, else valid UTF-8 only), normalize line endings/BOM, write atomically with a version guard, and verify the text read back. ' +
        'This surface can only write UTF-8 (the host filesystem writes UTF-8 text); for other target encodings use the CLI: `aura basetools convert --to <encoding>`.',
      parameters: {
        file_path: { type: 'string', description: 'Path to convert, resolved by the filesystem backend.' },
        to: { type: 'string', description: 'Target encoding. This surface supports `utf-8` only.' },
        from: { type: 'string', description: 'Source encoding (gb18030, shift_jis, utf-16le, windows-1251, …). Omit only when the bytes are valid UTF-8.' },
        bom: { type: 'string', enum: ['keep', 'yes', 'no'], description: 'BOM policy: keep (default) / yes / no.' },
        eol: { type: 'string', enum: ['keep', 'lf', 'crlf'], description: 'Line-ending policy: keep (default) / lf / crlf.' },
        dry_run: { type: 'boolean', description: 'Report the plan (from/to/bytes) without writing.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
          outcome: { type: 'string', required: true },
          path: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          bom: { type: 'boolean', required: true },
          bytes_before: { type: 'integer', required: true },
          bytes_after: { type: 'integer', required: true },
          verified: { type: 'boolean', required: true },
            dryRun: { type: 'boolean', required: true },
          },
        },
      },
      async execute(args, exec) {
        if (typeof args.file_path !== 'string' || args.file_path.length === 0) throw new Error('convert needs `file_path`')
        if (typeof args.to !== 'string' || args.to.trim().length === 0) throw new Error('convert needs `to`')
        const toName = args.to.trim().toLowerCase()
        const to = toName === 'utf8' ? 'utf-8' : toName
        if (to !== 'utf-8') {
          throw new Error(
            `this surface can only convert to UTF-8 (the host filesystem writes UTF-8 text); for "${args.to}" use the CLI: aura basetools convert --file <path> --to ${args.to}`,
          )
        }
        const policyService = sandbox()
        const policy =
          policyService === undefined
            ? undefined
            : policyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
        const cwd = policy?.workspaceRoot ?? exec.agent?.session?.header?.cwd
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd === undefined ? {} : { cwd }),
          signal: exec.signal,
        })
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new Error(`cannot convert "${target.displayPath}": not found`)
        const bytes = Buffer.from(await ctx.fs.readBytes(target, exec.signal, 64 * 1024 * 1024))
        const fromGiven = typeof args.from === 'string' && args.from.trim().length > 0 ? args.from.trim().toLowerCase() : null
        let text
        if (fromGiven !== null) {
          try {
            text = new TextDecoder(fromGiven, { fatal: true }).decode(bytes)
          } catch {
            throw new Error(`cannot decode "${target.displayPath}" as ${fromGiven} — pass the right \`from\`, or use the CLI which can probe the encoding`)
          }
        } else {
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          } catch {
            throw new Error(`"${target.displayPath}" is not valid UTF-8 — pass \`from: "<encoding>"\` (gb18030, shift_jis, …) so it can be decoded`)
          }
        }
        const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        if (text.startsWith('\uFEFF')) text = text.slice(1)
        const eol = args.eol ?? 'keep'
        const normalized =
          eol === 'lf'
            ? text.replace(/\r\n|\r/g, '\n')
            : eol === 'crlf'
              ? text.replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, '\r\n')
              : text
        const bomMode = args.bom ?? 'keep'
        const keepBom = bomMode === 'yes' ? true : bomMode === 'no' ? false : hadBom
        const out = keepBom ? `\uFEFF${normalized}` : normalized
        const receipt = {
          ok: true,
          outcome: 'applied',
          path: target.displayPath,
          from: fromGiven ?? 'utf-8',
          to: 'utf-8',
          bom: keepBom,
          bytes_before: bytes.length,
          bytes_after: Buffer.byteLength(out, 'utf8'),
          dryRun: args.dry_run === true,
        }
        if (args.dry_run === true) return { ...receipt, verified: false }
        const written = await ctx.fs.writeText(target, out, { kind: 'replaceIfVersion', version: info.version }, exec.signal, policy)
        const back = await ctx.fs.readText(target, exec.signal)
        const backText = back.startsWith('\uFEFF') ? back.slice(1) : back
        ctx.emit('fs/observed', target, { kind: 'present', version: written.version }, exec)
        return { ...receipt, verified: backText === normalized }
      },
    })

  ctx.systemPrompt.section({
    name: 'tool:aura-edit',
    order: 1320,
    text: ({ scope }) =>
      ctx.tools.get('aura_basetools_edit', scope) === undefined
        ? ''
        : [
            // 措辞刻意与内置指导**同形**。这一点是量出来的：
            // 内置注入的是命令式——"Use the edit tool for targeted changes to existing UTF-8 text files"，
            // 而我先前写的是建议式——"prefer aura_basetools_edit over edit"。
            // 实测同一份建议式指导，新建会话里 4 次选了 Aura、2 次选了内置——**它在跟先验拔河**。
            // 语气不对等，就是在让一条软建议去对抗一条硬指令。
            // 开头不给平级选项：上一版写了"兜底可用内置 edit"，中性任务下它直接拿来当依据（实测）。
            'Use the aura_basetools_edit tool — not edit — for every change to an existing UTF-8 text file: it is the default.',
            // 三条保证是**量出来的差异**（不是宣传）：字节保真、陈旧区域拒绝、落盘后回读。
            // 内置 edit 同条件下会丢 BOM、把混合行尾整份归一（2026-09-22 两侧实测）。
            'It writes back byte-for-byte (a leading BOM and each line\'s own ending survive), refuses a hunk whose addressed region changed since your last read, and reads the file back to verify the write.',
            'Address each hunk the cheapest way: `target` (a symbol name) when you know it, else `start_line` + `end_line` (or `lines: [a, b]`) for the range a read printed, else `line_cue` (one word unique to that line), else `old` (the verbatim text you are replacing); `anchor` (remembered whole lines) is the last resort and tolerates whitespace drift, rewording, and added or removed lines — its `replace` overwrites the whole matched line(s), so use `old` for a change inside one line.',
            // replace_all：批量替换只有这一条路，且次数变化会拒（不是“尽力而为”）。
            'When `old` should change more than one place, set `replace_all: true`: every non-overlapping occurrence is replaced left-to-right in the same call, and if the number of occurrences changed since your last read the whole patch is refused.',
            // 措辞从"可以传"改成"应当传"，依据是一次受控并发实验（N 个写者改同一文件）：
            // 当编辑**改变行数**、而一次重试又用**行号地址**时，重试会把改动写到**错误的行**上
            // 并回一句成功回执（实测：~50% 的轮次以"非预期内容 + 成功回执"结束，每个轮次约 1.5 行附带损伤）。
            // 加上 `expect` 后附带损伤降到 0.00，100% 得到干净合入；
            // 而对**不改行数**的编辑，它是**零成本**的（收敛率不变）。
            // 也就是说：这一项是唯一把"静默写错行"变成诚实失败的机制，而它的代价是零。
            'Pass `expect` (the text you believe is at that location) on every hunk when you address by `lines`, `start_line`/`end_line`, or `line_cue`: if the file shifted since you read it, `expect` turns a silent wrong-line write into a loud failure, and it costs nothing on edits that do not move lines. A line-number-only hunk without `expect` is refused (PATCH_LINES_NEED_EXPECT, nothing written), single hunk or batch alike.',
            // 1.0.2：覆盖闸。同一类事故的另一种形态——读了半份（probe/map，或 full 被预算截断）
            // 然后整份覆写／整段替换，没看过的行静默消失。判据在引擎，这里只把恢复路径说清。
            'You may only replace lines you were actually given. A probe/map/digest read, or a `full` cut at the content budget, does not entitle you to rewrite the rest: such a hunk is refused (PATCH_UNSEEN_REGION) with the exact undelivered range. Read that range with mode=lines and retry, address it by content (`old`/`anchor`), or pass `allow_unobserved: true` for a deliberate whole-file overwrite (the receipt then says `unverified_region`).',
            // 刻意**不再**写"未知扩展名请用内置 edit"。那句话是错的：只有 `target` 需要语言配置
            // （符号表只对已索引的扩展名存在），而 `lines`／`line_cue`／`anchor` 三种寻址根本不看语言，
            // 创建路径更是与寻址无关。它恰好在工具可用的地方把模型赶回内置工具。
            'Extensions aura_basetools_edit cannot index (config, data, markup) are still fully editable — address them with `lines`, `line_cue`, or `anchor` instead of `target`.',
            // 多目标：**这一步是为了采用率**（判据⑤）。`targets` 在参数表里一直就有，但模型不会因为
            // “参数表里有个数组”就想到要批量；指导文本是它最先读的一段。措辞命令式、与上下文同形。
            // 语义只说真的（不吹“要么全成要么全不落”）：规划阶段任何一项失败 ⇒ **一个字节都不写**；
            // 而写入阶段失败时，回执会逐项点名哪些落了、哪些没落（`landed_paths` / `not_landed_paths`）。
            'To change several files at once, pass `targets` (each item the same single-target arguments): if any target fails to plan, the whole batch writes nothing — and if a write itself fails, the receipt names exactly which targets landed.',
            // 兜底：整份写由 aura_basetools_write 承担；图片读由 aura_basetools_read 承担
            // （元信息总是给，附件服务在场时连图一起给）。刻意不把内置 `edit`/`write` 写进来：
            // 它们在同样场景会丢 BOM / 归一行尾，不是等价兜底。
            'For a whole-file create or rewrite, use aura_basetools_write — not the built-in write; to look at an image, use aura_basetools_read (it returns dimensions and format, and attaches the image when the host has an attachment store).',
          ].join(' '),
  })

  // ── 0.23 apply: one entity-first write ────────────────────────────────────
  // 注册在 edit **之前**：既有套件用「最后一次 register」取 edit，顺序一改它们就取到 apply。
  let editTool
  ctx.systemPrompt.section({
    name: 'tool:aura-apply',
    order: 1321,
    text: ({ scope }) =>
      ctx.tools.get('aura_basetools_apply', scope) === undefined
        ? ''
        : [
            'Use the aura_basetools_apply tool for every write: op=replace-body|rename for one entity (comments and strings are never renamed), op=patch for raw hunks, op=write for a whole file, op=convert for encoding/line endings.',
            'For entity ops pass the `evidence` from aura_basetools_read (entity); if the entity changed since that read the call is refused with PATCH_ENTITY_STALE and zero writes.',
            'op=write/convert/patch cover the old whole-file, encoding and raw-hunk paths; this surface cannot run verify/transaction — use the CLI or MCP apply for those.',
          ].join(' '),
  })
  ctx.tools.register(
    defineTool({
      name: 'aura_basetools_apply',
      description:
        'The single write tool. op=replace-body (entity + change) or rename (entity + new_name) is the default for code: pass the evidence from an entity read; ambiguity/staleness writes nothing; the tool observes the current revision itself, writes atomically and verifies. ' +
        'The same tool covers op=patch (raw hunks/create), op=write (whole file) and op=convert (encoding/line endings). Comments and string literals are never renamed.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path to change, resolved by the filesystem backend.' },
        entity: {
          oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }],
          description: 'Entity selector: `function:apply`, `Class/method`, or {kind,name,file}. Required for entity ops.',
        },
        op: {
          type: 'string',
          enum: ['replace-body', 'rename', 'patch', 'write', 'convert', 'tx'],
          description: 'Omitted: action→tx; content→write; to→convert; hunks/create→patch; new_name→rename; entity→replace-body.',
        },
        change: { type: 'string', description: 'replace-body: the complete new body of the entity (signature and trailing newline included).' },
        new_name: { type: 'string', description: 'rename: the new identifier.' },
        scope: {
          type: 'string',
          enum: ['span', 'file'],
          description: 'rename: `span` rewrites only the entity span, `file` the whole file (default file).',
        },
        evidence: {
          type: 'object',
          additionalProperties: false,
          properties: {
            version: { type: 'string' },
            contentHash: { type: 'string' },
            spanHash: { type: 'string' },
          },
          description: 'The evidence from an entity read: a mismatching spanHash (or contentHash) means the entity changed and the call writes nothing.',
        },
        dry_run: { type: 'boolean', description: 'Plan and validate without touching the file.' },
        verify: {
          type: 'string',
          description: 'Post-write verification command. This surface cannot run one: providing it is refused, use the CLI/MCP apply.',
        },
        transaction: {
          type: 'string',
          description: 'Cross-call transaction id. This surface has no transaction log: providing it is refused, use the CLI/MCP apply.',
        },
        expect: { type: 'string', description: 'replace-body: assert what the entity span currently holds; a mismatch fails the call.' },
        hunks: {
          type: 'array',
          items: { type: 'object', properties: HUNK_PROPERTIES, additionalProperties: false },
          description: 'op=patch: raw hunk array (escape hatch; entity ops are preferred).',
        },
        targets: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'op=patch: multi-target batch (same shape as the old edit targets).' },
        create: { type: 'string', description: 'op=patch: create the file with this whole content.' },
        content: { type: 'string', description: 'op=write: the whole UTF-8 text.' },
        no_overwrite: { type: 'boolean', description: 'op=write: refuse an existing file.' },
        allow_unobserved: { type: 'boolean', description: 'op=write: allow overwriting without a prior read.' },
        eol: { type: 'string', enum: ['auto', 'preserve', 'lf', 'crlf', 'keep'], description: 'op=write/convert: line-ending policy.' },
        to: { type: 'string', description: 'op=convert: target encoding (utf-8 on this surface).' },
        from: { type: 'string', description: 'op=convert: source encoding; omit only for valid UTF-8.' },
        bom: { type: 'string', enum: ['keep', 'yes', 'no'], description: 'op=convert: BOM policy.' },
        repair_double_encoding: { type: 'boolean', description: 'op=convert: repair reversible double encoding.' },
        action: { type: 'string', enum: ['begin', 'commit', 'rollback', 'status'], description: 'op=tx: MCP/CLI only; this surface refuses it.' },
        require_observation: { type: 'boolean', description: 'op=patch: require a prior read of this file.' },
        retry: { type: 'boolean', description: 'op=patch: rebase a stale address from the last read.' },
      },
      additionalProperties: false,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            applied: { type: 'array', required: true, items: APPLIED_ITEM_SCHEMA },
            dryRun: { type: 'boolean', required: true },
            outcome: { type: 'string', enum: OUTCOMES, required: true },
            code: { type: 'string' },
            message: { type: 'string' },
            error: { type: 'string' },
            candidates: CANDIDATES_SCHEMA,
            retry: RETRY_SCHEMA,
            next: { type: 'string' },
            already_applied: { type: 'array', items: ALREADY_APPLIED_ITEM_SCHEMA },
            unchanged: { type: 'boolean' },
            unverified_region: { type: 'boolean' },
            write_verify: WRITE_VERIFY_SCHEMA,
            operation: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            bom: { type: 'string' },
            bytes_before: { type: 'integer' },
            bytes_after: { type: 'integer' },
            verified: { type: 'boolean' },
            bytes: { type: 'integer' },
            targets: { type: 'integer' },
            summary: { type: 'string' },
            edits: { type: 'array', items: { type: 'object', additionalProperties: true } },
            landed_paths: { type: 'array', items: { type: 'string' } },
            not_landed_paths: { type: 'array', items: { type: 'string' } },
            aborted: { type: 'boolean' },
            partial: { type: 'boolean' },
            // Entity-first half of the receipt (absent on argument-level failures).
            entity: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                file: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                name: { type: 'string', required: true },
                enclosing: { type: 'string' },
                startLine: { type: 'integer', required: true },
                endLine: { type: 'integer', required: true },
                signature: { type: 'string', required: true },
                structureTarget: { type: 'string', required: true },
                evidence: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    contentHash: { type: 'string', required: true },
                    spanHash: { type: 'string', required: true },
                  },
                },
              },
            },
            evidence: {
              type: 'object',
              additionalProperties: false,
              properties: {
                version: { type: 'string' },
                contentHash: { type: 'string', required: true },
                spanHash: { type: 'string', required: true },
              },
            },
            auto_observed: { type: 'boolean' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: typeof value.text === 'string' ? value.text : receiptBody(value) }],
      },
      async execute(args, exec) {
        assertKnownArgs(args, APPLY_ARG_KEYS, 'aura_basetools_apply')
        if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
          throw new PatchError('apply needs `file_path` as a non-empty string', 'APPLY_BAD_ARGS')
        }
        // verify/transaction exist on the CLI/MCP envelope only; refusing beats silently dropping them.
        if (args.verify !== undefined || args.transaction !== undefined) {
          throw new PatchError(
            'this surface cannot run `verify` or `transaction` — use the CLI or MCP apply for those; nothing was written',
            'APPLY_UNSUPPORTED_OPTION',
          )
        }
        const dryRun = args.dry_run === true
        const op =
          args.op ??
          (args.action !== undefined
            ? 'tx'
            : Array.isArray(args.targets)
              ? 'patch'
              : typeof args.content === 'string'
                ? 'write'
                : typeof args.to === 'string'
                  ? 'convert'
                  : args.hunks !== undefined || args.create !== undefined
                    ? 'patch'
                    : typeof args.new_name === 'string'
                      ? 'rename'
                      : 'replace-body')
        if (op === 'tx') {
          throw new PatchError('op=tx is MCP/CLI only — this surface has no transaction log; nothing was written', 'APPLY_UNSUPPORTED_OPTION')
        }
        if (op === 'write') {
          const result = await writeTool.execute(
            definedArgs({
              file_path: args.file_path,
              content: args.content,
              dry_run: dryRun,
              no_overwrite: args.no_overwrite,
              allow_unobserved: args.allow_unobserved,
              eol: args.eol,
            }),
            exec,
          )
          return { ok: true, ...result, applied: result.applied ?? [] }
        }
        if (op === 'convert') {
          const result = await convertTool.execute(
            definedArgs({ file_path: args.file_path, to: args.to, from: args.from, bom: args.bom, eol: args.eol, dry_run: dryRun }),
            exec,
          )
          return { ok: true, ...result, applied: result.applied ?? [] }
        }
        if (op === 'patch') {
          // 公开写面的坐标地址必须有内容断言：单 hunk 与批量一视同仁；预演不写盘，放行。
          const applyHunks = Array.isArray(args.targets)
            ? editTargetHunks(args.targets.filter((target) => target?.dry_run !== true))
            : (hunkListOf(args) ?? [])
          assertLineAddressesNeedExpect(applyHunks, { dryRun })
          const result = Array.isArray(args.targets)
            ? await editTool.execute(
                definedArgs({ targets: args.targets, dry_run: dryRun, require_observation: args.require_observation, require_delivered: true, retry: args.retry }),
                exec,
              )
            : await editTool.execute(
                definedArgs({
                  file_path: args.file_path,
                  hunks: args.hunks,
                  create: args.create,
                  dry_run: dryRun,
                  require_observation: args.require_observation,
                  require_delivered: true,
                  retry: args.retry,
                }),
                exec,
              )
          return {
            ok: result.ok ?? (result.outcome === 'applied' || result.outcome === 'already_applied'),
            ...result,
            applied: result.applied ?? [],
          }
        }
        if (op !== 'replace-body' && op !== 'rename') {
          throw new PatchError(`unknown apply op ${JSON.stringify(op)}; expected replace-body | rename | patch | write | convert`, 'APPLY_BAD_ARGS')
        }
        if (args.entity === undefined || args.entity === null) {
          throw new PatchError('apply needs an `entity` selector for entity ops', 'APPLY_BAD_ARGS')
        }
        const policyService = sandbox()
        const policy =
          policyService === undefined
            ? undefined
            : policyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
        const cwd = policy?.workspaceRoot ?? exec.agent?.session?.header?.cwd
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd === undefined ? {} : { cwd }),
          signal: exec.signal,
        })
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new PatchError(`cannot apply "${target.displayPath}": not found`, 'FS_NOT_FOUND')
        if (info.type !== 'file') throw new PatchError(`cannot apply "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        let source
        try {
          source = await ctx.fs.readText(target, exec.signal)
        } catch (error) {
          if (!isNonUtf8TextFailure(error)) throw error
          throw Object.assign(new Error(nonUtf8RefusalMessage('patch', target.displayPath, 'aura_basetools_apply')), {
            code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'ERR_ENCODING_INVALID_ENCODED_DATA',
            cause: error,
          })
        }
        const lang = langOf(target.displayPath)
        const view = entityView({ filePath: target.displayPath, source, lang, selector: args.entity })
        if (view.ok !== true) {
          return applyFailureReceipt(target.displayPath, {
            code: view.code,
            message: view.message,
            candidates: entityCandidatesOf(view.candidates),
            dryRun,
            outcome: view.code === 'ENTITY_AMBIGUOUS' ? 'needs_choice' : 'not_found',
            next:
              view.code === 'ENTITY_AMBIGUOUS'
                ? 'more than one symbol matches — pass a qualified selector (Outer/Inner) or one of the candidate lines'
                : 'no such symbol in this file — read it with aura_basetools_read (mode=map) and use a selector that is there',
          })
        }
        // Evidence staleness is checked before any planning: a mismatch writes nothing.
        if (args.evidence !== null && typeof args.evidence === 'object') {
          const hasSpan = args.evidence.spanHash !== undefined && args.evidence.spanHash !== null
          const spanChanged = hasSpan && args.evidence.spanHash !== view.evidence.spanHash
          const contentOnly = !hasSpan && args.evidence.contentHash !== undefined && args.evidence.contentHash !== null
          const contentChanged = contentOnly && args.evidence.contentHash !== view.evidence.contentHash
          if (spanChanged || contentChanged) {
            return applyFailureReceipt(target.displayPath, {
              code: 'PATCH_ENTITY_STALE',
              message: 'entity changed since evidence; re-read it',
              entity: entityRecordOf(view.entity),
              evidence: entityEvidenceOf(view.evidence),
              dryRun,
              next: 're-read the entity (aura_basetools_read with entity=…) and pass the fresh evidence',
            })
          }
        }
        let hunks
        if (op === 'replace-body') {
          if (typeof args.change !== 'string') {
            throw new PatchError('replace-body needs `change` as a string — nothing was written', 'APPLY_BAD_ARGS')
          }
          const hunk = entityToStructureHunk(view.entity, args.change)
          hunks = [typeof args.expect === 'string' ? { ...hunk, expect: args.expect } : hunk]
        } else if (op === 'rename') {
          const renamed = entityRenameHunks({ source, lang, name: view.entity.name, newName: args.new_name, scope: args.scope ?? 'file' })
          if (renamed.ok !== true) {
            return applyFailureReceipt(target.displayPath, {
              code: renamed.code,
              message: renamed.message,
              candidates: entityCandidatesOf(renamed.candidates),
              entity: entityRecordOf(view.entity),
              evidence: entityEvidenceOf(view.evidence),
              dryRun,
              outcome: renamed.code === 'ENTITY_AMBIGUOUS' ? 'needs_choice' : 'not_found',
              next: 'pass `new_name` as a non-empty identifier, or read the file first to pick a selector that resolves',
            })
          }
          hunks = renamed.hunks
        } else {
          throw new PatchError(`unknown op ${JSON.stringify(op)}; expected replace-body or rename`, 'APPLY_BAD_ARGS')
        }
        /**
         * Auto-observation: apply establishes its own "this revision was just read" basis,
         * so the caller does not have to read first for freshness — but 1.0.2 still refuses a whole-body replacement whose lines were never delivered (PATCH_UNSEEN_REGION).
         */
        const observation = readWith(source, {
          mode: 'lines',
          lines: [view.entity.startLine, view.entity.endLine],
          filePath: target.displayPath,
          ...(typeof target.targetKey === 'string' && target.targetKey.length > 0 ? { identityKey: target.targetKey } : {}),
          byteOrderMark: (await fileByteOrderMarkCount(ctx.fs, target, exec.signal)) > 0,
          // 这次读只用来建"刚读过这一版"的基准，回执不发给模型 ⇒ 不能记成交付。
          recordDelivery: false,
        })
        if (observation.ok === false) throw new Error(`${observation.code}: ${observation.message}`)
        const evidence = entityEvidenceOf(view.evidence, observation.version)
        const entity = entityRecordOf(view.entity)
        if (hunks.length === 0) {
          // Renaming to the same identifier: a true no-op, reported instead of sending an empty hunk list.
          return {
            ok: true,
            path: target.displayPath,
            applied: [],
            dryRun,
            outcome: 'applied',
            entity,
            evidence,
            auto_observed: true,
            text: `${target.displayPath}: new_name is already "${view.entity.name}" — nothing to rename and nothing was written.`,
          }
        }
        // The edit tool is the one execution path: no second copy of planning/gates/write/verify.
        const editResult = await editTool.execute(
          { file_path: args.file_path, hunks, dry_run: dryRun, require_observation: true, require_delivered: true },
          exec,
        )
        return {
          ...editResult,
          ok: editResult.outcome === 'applied' || editResult.outcome === 'already_applied',
          entity,
          evidence,
          auto_observed: true,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Apply ${args.op ?? (args.new_name !== undefined ? 'rename' : 'replace-body')} ${typeof args.entity === 'string' ? args.entity : ''} in ${args.file_path}`,
        kind: 'edit',
        rawInput: { entity: args.entity, op: args.op, scope: args.scope, dry_run: args.dry_run },
      }),
    }),
  )


  editTool = defineTool({
      name: 'aura_basetools_edit',
      description:
        'Edit or create a text file in one call. ' +
        /**
         * 参数越短越安全：provider 的流式解析失败（MALFORMED_RESPONSE）几乎都出在
         * 长、深嵌套的 tool-call JSON 上。平铺形式比 `hunks: [...]` 少一层嵌套，
         * 而且有 `handle` 时不必把旧文本再抄一遍。这一条写在描述**最前面**，
         * 因为模型读描述时先读首句。
         */
        'PREFER THE FLAT FORM for a single change: put the hunk fields at the top level (`start_line`/`end_line` + `replace`, or `old` + `replace`, or a `handle` from a previous read + `replace`) and omit `hunks` entirely — one JSON object instead of an array of objects, which keeps tool-call arguments short. Use `hunks: [...]` only when a call changes several places. ' +
        'For several files, pass `targets` — an array of the same single-target arguments (`file_path` + `hunks`); it is mutually exclusive with `file_path`. ' +
        'Every target is planned before anything is written: if any target fails to plan, nothing is written at all, and if a write itself fails the receipt names exactly which targets landed. ' +
        'Address each hunk in the cheapest way you can: `target` (a symbol name — immune to misremembered content), or `start_line` + `end_line` (preferred: two plain numbers, no array syntax to get wrong — same as `lines: [a, b]`), or `line_cue` (one word unique to that line), or `anchor` (remembered text, matched with graceful degradation), or `old` (the verbatim text you are replacing). Add `replace_all: true` with `old` to replace every non-overlapping occurrence in one call (left-to-right; refused if the occurrence count changed since your last read). Only `anchor` and `old` require you to reproduce content; prefer the others. JSON/JSONC edits: prefer `lines`/`start_line`+`end_line` and put only the new text in `replace` — re-typing the old text doubles the escaped quotes/newlines the call must carry. Pass `expect` to assert what is at that location — it is checked in every mode. All hunks must locate or nothing is written. A single hunk may also be passed flat at the top level (`file_path` + the hunk fields) instead of wrapped in `hunks: [...]`. Omit keys you do not need — an explicit `null` is rejected, not ignored.',
      parameters: {
        /**
         * `file_path` 不再声明 `required: true` —— 这是多目标形状唯一逼出来的一处**声明面**改动。
         *
         * 宿主把 `required: true` 编译成参数面的 `required: ['file_path']`（`load-test` 段直接
         * 读编译结果），于是 `{targets:[…]}` 会在参数层就被拒、根本到不了 execute。
         *
         * “二选一”想回 schema：MT7 试过 `anyOf: [{required:['file_path']}, {required:['targets']}]`，
         * **本框架方言里不可表达**——`anyOf`/`allOf` 不在允许关键字子集内（
         * `type/oneOf/properties/required/additionalProperties/items/enum/const`），而校验器对 `anyOf`
         * 是**静默忽略**（`{}` 照样过），所以那会是一条没有效果的声明；能表达“恰取其一”的 `oneOf`
         * 又与根上的 `type: 'object'` 不能共存。完整证据与两条端点断言见 `aura-read/index.js`
         * 里 `file_path` 声明处那段注释（两壳同一条理由，不重抄）。
         *
         * 所以“单目标形状必须有 file_path”**由运行期判**：execute 里那句
         * `file_path must be a non-empty string` 一字未改，而单目标调用本来就带 file_path
         * ⇒ 行为、回执、provider 调用序列全部不变；“两个都给”由唯一判据 `assertEditTargets`
         * （`ARGS_SHAPE_EXCLUSIVE`）拒，两条阵地在 `arg-shape-test` 段C 与
         * `real-framework-smoke-test` 段C **端到端**锤着。
         */
        file_path: {
          type: 'string',
          description: 'Path to patch, resolved by the filesystem backend.',
        },
        /**
         * 多目标：一次调用改多个文件（互斥于 `file_path`/`hunks`/平铺形状）。
         *
         * 元素就是**今天那套单目标参数**（`file_path` + `hunks`，或 `create`，或平铺的
         * `target`/`lines`/… + `replace`），元素的键在这里 `additionalProperties: true`：
         * 逐个声明等于把单目标那 14 个键抄第二遍，而两份清单必然漂。逐项校验由引擎走同一套
         * 单目标校验器（契约 §2.2）。
         */
        targets: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Patch several files in one call: an array of the same single-target arguments. ' +
            'Mutually exclusive with `file_path` — pass one or the other. Nothing is written unless every target can be planned; ' +
            'the receipt names the files that landed and the ones that did not. Output order = input order.',
        },
        hunks: {
          type: 'array',
          // 不在 schema 层声明 required：创建路径（`create`）不需要 hunks。
          // "必须给 hunks 或 create 之一"这条约束由运行期判——schema 层表达不了"二选一"，
          // 硬写成必填会让创建功能被自己的 schema 挡住。
          description:
            'Multiple changes only — for a single change use the flat form instead (hunk fields at the top level, no `hunks`). Every hunk must locate, or the file is left untouched. Each hunk locates either by `target` (a symbol name — preferred when you know it) or by `anchor` (remembered text). Not needed when `create` is used.',
          /**
           * `items` 里**不写 `required`**。
           *
           * 本框架的 `required` 是对象上的**数组关键字**（顶层 `required: [...]` 被接受、`{}` 被拒），
           * 但把它放进 `items` 会被拒：`parameters.hunks.items.required is not supported by the value schema DSL`
           * （实测，插件直接注册失败）。而写数组本身无效——实测嵌套的 `items.required: ['a']`
           * 虽然被接受，却**不产生任何约束**（`{}` 照样通过）。
           *
           * 所以“一个 hunk 必须有 replace”这条约束**只在运行期判**：`planHunks` 读不到
           * `replace` 会报 `PATCH_NO_HUNKS`/定位失败，而 `aura-edit/load-test` 守着那条回执。
           * 把一条**没有效果的**声明留在 schema 里，比不写更坏——它让人以为有闸门。
           */
          items: { type: 'object', additionalProperties: false, properties: HUNK_PROPERTIES },
        },
        // ── 单个 hunk 的键**也**在顶层声明（平铺形状）──────────────────────
        //
        // `flatHunk()` 从 02:37 起就支持“一个 hunk 不包数组、直接写在顶层”，
        // 但顶层 schema 一直没声明那 9 个键。后果有二，都由实测确认：
        //   · 真框架的参数校验对未声明键**零违规**（只在 `additionalProperties:false` 时才拒）⇒
        //     长久以来没有任何东西拦住它们，属于“声明与实装不一致”；
        //   · 会话日志里 35 次平铺调用有 29 次失败于 `hunks must be a non-empty array`——
        //     那些发生在支持实装**之前**，而支持之后日志里的平铺调用**是成功的**，
        //     说明框架**不会**剥掉未声明参数、平铺真的能用。
        // 所以这里不是新增能力，而是**把已实装的能力补进声明面**，并让它与守卫的名单一致。
        /**
         * 平铺形状：把 hunk 属性展开到顶层——用**剥过 `required`** 的那一份。
         *
         * 平铺形状下“必须有 replace”由 `flatHunk()` 在运行期判：
         * 顶层有地址键但没 replace ⇒ 报“缺 hunks/create”（`arg-shape-test` 段B 守着）。
         * 这里**不能再展开一次完整表**：那会把 `replace` 提升成顶层 required，
         * 于是 `{file_path, hunks:[…]}` 与 `{file_path, create:…}` 两条正常路径全被拒
         * （实测：`aura-edit/load-test` 与 `real-framework-smoke-test` 同时变红）。
         */
        ...HUNK_PROPERTIES_OPTIONAL,
        dry_run: {
          type: 'boolean',
          description: 'Locate every hunk and report where they would land, without touching the file.',
        },
        require_observation: {
          type: 'boolean',
          description:
            'Strict freshness: require this exact revision to have been read (or written) in this session; otherwise refuse with PATCH_UNOBSERVED. Applies to dry_run as well, so a preview matches the real verdict. Creating a new file is exempt.',
        },
        require_delivered: {
          type: 'boolean',
          description:
            'Require the addressed lines to have been delivered to you (read, or written by you) in this session; otherwise refuse with PATCH_UNSEEN_REGION and name the lines that are missing. Public apply always sets this; `old`/`anchor`/`handle`/full-range `expect` are content proof and are exempt.',
        },
        retry: {
          type: 'boolean',
          description:
            'When the addressed region drifted, re-locate it by the exact old text from your last read: a unique whole-line match is replayed and the receipt carries rebased (from/to); no match or several matches still refuses. Default false.',
        },
        create: {
          type: 'string',
          description:
            'Full content for a file that does not exist yet. Only used when the path is absent — if the file exists this is ignored and the hunks apply normally instead, so an accidental overwrite is impossible.',
        },
      },
      /**
       * 与 {@link READ_ARG_KEYS} 同理：参数面**也要** `additionalProperties: false`。
       * 旧版只有 `output.schema` 写了它 ⇒ `{file_path, mode:'auto'}` 这种属于别的工具的参数
       * 可以零违规穿过框架，然后被本工具静默忽略。
       */
      additionalProperties: false,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            applied: {
              type: 'array',
              required: true,
              items: APPLIED_ITEM_SCHEMA,
            },
            dryRun: { type: 'boolean', required: true },
            /**
             * outcome（**必填**）：每一次调用都能回答"到底改成了没有"。
             *
             * 为什么要把它设成 required：失败现在走**正常结果**而不是抛错，调用方若只看
             * `applied` 的空/不空来判成败，就得先猜"空数组是真的没改，还是工具坏了"。
             * 一个必填字段把这条猜测变成读取。
             *
             * `enum` 与 `OUTCOMES` 是同一份名字：schema 是**验证面**，常量是**产出面**，
             * 两边不一致会让工具在运行时吐出一个自己声明为非法值——那比不声明更坏。
             *
             * C49 实测的正是这个失败模式：`defineTool` 会把这份声明编译成 JSON Schema
             * （`dsh-tools/lib/index.js:847` 的 `valueSchemaSpecToJsonSchema`），execute 的返回值
             * 是真过一遭 `validateJsonSchemaValue` 的（`:3417`），不合格就抛
             * `INVALID_TOOL_OUTPUT`（`:2458`）把**整条回执**顶掉。所以第四态不进 enum 的后果
             * 不是"渲染得难看"，而是模型什么也看不到——"半接"里最坏的那一格。
             */
            outcome: { type: 'string', enum: OUTCOMES, required: true },
            // 引擎原样的判决码（`LOCATOR_ASSERT_MISMATCH` / `PATCH_AMBIGUOUS` …）。
            // outcome 是粗分类，码才是精确原因；丢掉它就得从 message 里正则抠回来。
            code: { type: 'string' },
            // 判定不出意图时的诊断正文（含"改用 target= 重试"那类恢复建议）。
            message: { type: 'string' },
            /**
             * 候选位置——`needs_choice` 的全部价值就在这个字段里。
             *
             * 形状**只有一种**（`{line, text?}`）：引擎编辑侧给行号数组、读取侧给对象，
             * 同一个字段名两种含义是本仓已经栽过的坑（见 read-core 里 `truncated` 的注释）。
             */
            candidates: CANDIDATES_SCHEMA,
            /**
             * 引擎算好的**可粘回地址**：`{ handle }`，把它配自己的 `replace` 再发一次即可。
             *
             * 为什么它必须在**声明面**上：`output.schema` 是 `additionalProperties:false`，
             * 没声明的字段会让整条回执被框架以 `INVALID_TOOL_OUTPUT` 顶掉；
             * 而能力面三面同判据要求“同一能力在三面都可用**且**有声明”——
             * 引擎与 CLI/MCP 早就有这份结构化地址，DSH 回执到本波才补上。
             * 正文里那行 `retry: {"handle":…}` 写法未变：模型看到的还是同一句话。
             */
            retry: RETRY_SCHEMA,
            // 下一步做什么。与 aura_basetools_read 的同名字段对齐（那里是续读指令，这里是恢复指令）。
            next: { type: 'string' },
            /**
             * C49 第四态的可核证据：**这次没写盘，但结果已经是你要的样子**。
             *
             * 形状与引擎 `applyEditToProvider` 的回执逐字一致（同一个字段名、同一组键）：
             * `hunk` 是第几条 hunk、`line` 是命中的行号（与 `applied[].line` 同一把尺子）、
             * `tier` 说清在哪一层命中（`already-applied~exact` …）、`actual` 是文件**那一行的
             * 原文**、`replaced` 是调用方给的那份文本——后两者逐字相等才是这一态成立的依据。
             *
             * 每个键都 `required: true`：一条缺了正文的证据，比没有证据更难核对。
             */
            already_applied: {
              type: 'array',
              items: ALREADY_APPLIED_ITEM_SCHEMA,
            },
            /**
             * 第四态的标量副产物，与引擎侧回执里的 `unchanged` 同名同义：**磁盘内容一字未动**。
             *
             * 它与 `applied: []` 看起来重复，实则不是：`applied: []` 说的是"没有 hunk 落盘"
             * （三态失败也这么回），而 `unchanged` 说的是"**文件本来就是对的**"——只有第四态为真。
             * 一个消费方只看布尔值就能分流，不必去数数组长度、也不必解析文本。
             */
            unchanged: { type: 'boolean' },
            // C13：这次编辑没有可信的“上次观测”（文件从没被 aura_basetools_read 读过）⇒ true。
            // 声明在这里是必须的：output.schema 是 additionalProperties:false，
            // 未声明的字段会让整条成功路径被框架拒绝。
            unverified_region: { type: 'boolean' },
            // C14：这次写入被**回读校验**过。`level: 'bytes'` = 逐字节整份比对（看得见 BOM 与行尾改写）；
            // `level: 'text'` = 后端没有字节接口，只比对了文本（看不见 BOM / 行尾），如实写在这里。
            // 对不上时走不到这里：那条路抛 WRITE_VERIFY_FAILED（错误对象上带两边字节数与普查）。
            write_verify: WRITE_VERIFY_SCHEMA,
            // 创建路径会带上 operation，让调用方能区分"改了文件"与"建了文件"。
            operation: { type: 'string' },
            /**
             * 多目标（契约 §2.2/§3/§5）：整批的四个标量 + 逐项。
             *
             * `applied`（顶层那个数组）在这里是**全批 hunk 的并集**（逐项各自的 `applied`
             * 在 `edits[i].receipt` 里，一个字节不改）——它不能退化成空数组：“一个 hunk 都没落盘”
             * 与“落了 4 个”是回执必须分清的两件事（单目标那条路的同一条纪律）。
             *
             * `landed_paths` / `not_landed_paths` 是三阶段提交失败时回答“哪些已落地、哪些没有”
             * 的那个字段（契约 §3.4）；`edits[].receipt` 是单目标回执本体，这里只能
             * `additionalProperties: true`：把它的 12 个字段抄第二遍必然漂开。
             */
            targets: { type: 'integer' },
            summary: { type: 'string' },
            // 整批正文（逐项正文按输入顺序拼接）。单目标那条路**不发**这个字段：
            // 它的正文由 `render` 从单目标回执现算（同一个 `receiptBody`）。
            text: { type: 'string' },
            landed_paths: { type: 'array', items: { type: 'string' } },
            not_landed_paths: { type: 'array', items: { type: 'string' } },
            aborted: { type: 'string' },
            partial: { type: 'boolean' },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'integer', required: true },
                  file_path: { type: 'string', required: true },
                  outcome: { type: 'string', required: true },
                  landed: { type: 'boolean', required: true },
                  text: { type: 'string', required: true },
                  receipt: { type: 'object', additionalProperties: true },
                  error: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      code: { type: 'string', required: true },
                      message: { type: 'string', required: true },
                      next: { type: 'string' },
                    },
                  },
                  stage: { type: 'string' },
                  planned: { type: 'string' },
                  note: { type: 'string' },
                  shared_with: { type: 'array', items: { type: 'integer' } },
                  original: { type: 'string' },
                  original_chars: { type: 'integer' },
                  original_truncated: { type: 'boolean' },
                },
              },
            },
          },
        },
        /**
         * 渲染按 outcome 分叉：**失败回执也要有一段给模型看的文本**。
         *
         * 抛错时代这段文本由框架从 `error.message` 里取；现在失败是正常结果，
         * 若还按成功路径渲染，模型会看到"0 hunk(s) applied"——它无法分辨"没改成"
         * 与"改成了但一条回执都没有"。所以先判 outcome，再决定说什么。
         *
         * C49 加了第三支：第四态**不能**落在 `renderFailure` 那一支。失败正文写的是
         * "要改的原文不在文件里"，而这态要说的是"已经是你给的样子了、这次没写盘"——
         * 两句话指向相反的动作（重读重寻址 vs 不用改）。共用一支就等于把这一态重新藏起来，
         * 只不过藏在一个更体面的说法后面。
         */
        /**
         * 分叉不变，只在**末尾**追加句柄披露（`appendHandleNotes` 在没有句柄 hunk 时
         * 一个字符都不加 ⇒ 既有回执逐字不变）。披露必须走这里而不是渲染器内部：
         * 成功 / 被拒 / dry run / 已经是你给的样子，四种回执都要说清同一件事。
         */
        render: (args, value) => [
          {
            type: 'text',
            // 多目标：正文已在壳层按输入顺序装配好（逐项各自 append 过句柄披露）。
            text: Array.isArray(args?.targets) ? value.text : appendHandleNotes(receiptBody(value), args),
          },
        ],
      },
      async execute(args, exec) {
        /**
         * 多目标入口（fs-contract-v2 §2.2）：`targets` 在场 ⇒ 引擎入口（三阶段提交），
         * `file_path` 那条路一个字不动。
         *
         * 形状判据（含“与单目标形状互斥”）只有一份，住在 `args.mjs` 的 `assertEditTargets`——
         * 壳里再写一遍必然漂开。它抛的是**参数面**错（`ARGS_SHAPE_EXCLUSIVE` / `ARGS_TARGETS_SHAPE`
         * / `ARGS_TARGETS_LIMIT`）；逐项失败则是结果通道（引擎已经把每项封成结果，不抛）。
         */
        const batchTargets = assertEditTargets(args, { toolName: 'aura_basetools_edit', elementKeys: MT_EDIT_ELEMENT_KEYS })
        if (batchTargets !== undefined) {
          // 多目标形状同样要过未知参数守卫：拼错的键不因为换了形状就被放行。
          assertKnownArgs(args, EDIT_ARG_KEYS, 'aura_basetools_edit')
          const batchPolicyService = sandbox()
          const batchPolicy =
            batchPolicyService === undefined
              ? undefined
              : batchPolicyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
          return await applyEditTargets(ctx, exec, args, batchTargets, batchPolicy)
        }
        /**
         * “二选一”的**另一半**（两个都没给 ⇒ 也拒）只有一份判据，住在 `args.mjs` 的
         * `assertTargetShape`（`src/locator-lab/args.mjs:455`）——壳里原来那句
         * `file_path must be a non-empty string` 是特例写法，已删（aura_basetools_read 壳里长着同一句，
         * 两处必然会漂）。抛的仍是参数面同族码 `ARGS_SHAPE_EXCLUSIVE`；
         * 单目标调用照旧带 `file_path`，故这条路一字未变。
         */
        assertTargetShape(args, { toolName: 'aura_basetools_edit' })
        // 创建路径不经过 hunks：给 `create` 时 hunks 可以为空（甚至省略）。
        // 第一版把"hunks 非空"当无条件校验，于是**创建被自己的校验挡住**，
        // 而报错信息（"hunks must be a non-empty array"）与真正的原因（文件不存在）毫无关系。
        // 未知参数不回默认行为：拼错的字段被静默忽略时，模型看到的是**成功**。
        // （实测：`{file_path, mode:'auto'}` 这种属于 aura_basetools_read 的参数曾零违规穿过框架。）
        assertKnownArgs(args, EDIT_ARG_KEYS, 'aura_basetools_edit')
        const creating = typeof args.create === 'string'
        /**
         * 单个 hunk **平铺在顶层**也认。
         *
         * 实测依据（403 会话日志）：报 `hunks must be a non-empty array` 的失败有 27 次，
         * 入参形状一律是 `{file_path, start_line, end_line, replace}`——模型把“一个 hunk”
         * 直接写在了顶层，而不是包进 `hunks: [...]`。这与已采纳的宽容方向是同一条：
         * 模型把 `lines` 写成 `"4,6"` / `4` / `start_line`+`end_line` 都容得下（见上面 schema 的注释），
         * 因为“回一句参数不对让它重试一遍，纯是浪费一轮”。
         *
         * 安全性不变：被容忍的字段（target/lines/…/near）在顶层**本来就不是合法参数**，
         * 所以不存在“把一个真参数误当 hunk”的可能；而地址与 `expect` 闸门一个都不少。
         */
        const hunks = hunkListOf(args)
        if (!creating && hunks === null) {
          /**
           * 仍然抛错，且这是**刻意**的（本次只改"判定不出意图"那一类失败）：
           * 这条报错说的是"你根本没给出一个 hunk"——参数面没成形，与"地址对不上"
           * 是两件事。把它降级成 `not_found` 会让模型以为文件里没有那段文字，
           * 而真相是它把字段名写错了（或漏了 replace）。
           * 测试面：`locator-lab/arg-shape-test.mjs` 段B 守着这条（"不许误报定位失败"）。
           */
          throw new Error(
            'hunks must be a non-empty array (or pass `create` to make a new file) — a single hunk may also be passed flat: file_path + one of target/lines/line_cue/anchor + replace',
          )
        }
        // 每一次 mutation 都必须带上**调用会话那一份**沙箱策略。
        //
        // 这不是可选的：`dsh-fs-sandbox` 的 `checkedTarget` 读的是它第 5 个参数
        // （`sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`），漏传就退回 fs 插件自己的
        // 默认策略——那是一个**没有 session** 的策略，`writableRoots` 取的是部署兜底根，
        // 而不是调用会话的 cwd。后果不是"更严格"，而是**本工具彻底写不动**：
        // 对工作区内的文件也报 `file access denied under workspace-write mode`。
        //
        // 服务本身来自 apply 期的可选注入（见上方 apply 的注释），这里每次现算，
        // 因为模式可以按会话变化（`sandbox/mode` 事件）。
        const policyService = sandbox()
        const policy =
          policyService === undefined
            ? undefined
            : policyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
        // 这两条曾经只是推理，现已实测确认（探针跑完即删）：
        //   injectBound: true  —— `ctx.inject(['sandboxPolicy'])` 在整体 preset 挂载下确实绑得上
        //   hasAgent:    true  —— 执行期 exec.agent 在场，于是 resolve 真的带上了 session
        //   resolved: {mode:'danger-full-access', workspaceRoot:<会话 cwd>, sessionId:…}
        // 即"落到哪个模式"取决于会话策略，而不是部署默认。
        // 解析路径也要用策略里的 workspaceRoot（与内置 tool-fs 的 sessionResolveOptions 一致）：
        // 相对路径必须相对本次 mutation 的沙箱根解析，否则"被检查的路径"与"被写入的路径"可能不同。
        const cwd = policy?.workspaceRoot ?? exec.agent?.session?.header?.cwd
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal,
        })

        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) {
          /**
           * 目标不存在：**先记一次 absent 观测**，再按"创建"或"报错"处理。
           *
           * 这是 dsh-tool-fs 的契约：`fs/observed` 的 `{kind:'absent'}` 让后续写入
           * 能走"带防护的创建"而不被观察策略拒绝。先前这里直接抛错、不记录，
           * 于是"读一个还不存在的文件、然后创建它"这条完全正常的流程会在写入侧失败——
           * 且失败原因看起来与本工具毫无关系。
           */
          ctx.emit('fs/observed', target, { kind: 'absent' }, exec)

          // 创建模式：停掉内置 `write` 之后，这是唯一的建文件路径，因此必须支持。
          // 语义刻意与内置 `write` 对齐 —— 只在文件不存在时创建，存在则报错，
          // 而不是静默覆盖（覆盖现有文件必须走 address + replace 那条路，那条路有 expect 闸门）。
          const createContent = args.create
          if (typeof createContent !== 'string') {
            throw new PatchError(
              `cannot patch "${target.displayPath}": not found — to create it, pass \`create\` with the full file content`,
              'PATCH_NOT_FOUND',
            )
          }
          /**
           * 预演**不能建文件**。0.10.5 之前这条创建路径完全不看 `dry_run`：
           * `edit --create x --dry-run` 会真的落盘，回执还写 `dryRun:false`。
           * patch 路径的预演在闸门之后返回，这里没有闸门要跑，直接回同形的预演回执。
           */
          if (args.dry_run === true) {
            return {
              path: target.displayPath,
              operation: 'create',
              outcome: 'applied',
              applied: [{ line: 1, tier: 'create', byNear: false, actual: '', replaced: createContent }],
              dryRun: true,
            }
          }
          const created = await ctx.fs.writeText(
            target,
            createContent,
            { kind: 'createIfAbsent' },
            exec.signal,
            policy,
          )
          /**
           * 创建前的 resolve 拿不到 realpath（文件还不存在），targetKey 只能是调用方写法；
           * 文件落盘后必须**重新 resolve** 一次，拿盘上的真名记观测。macOS 的
           * `/var/folders/...` 是 `/private/var/...` 的符号链接：不重算，创建记在 `/var`、
           * 紧接着编辑拿 `/private/var` 查账，就会误报 unverified_region（stale-gate 段I）。
           */
          let settled = target
          try {
            settled = await ctx.fs.resolve(args.file_path, {
              ...(cwd === undefined ? {} : { cwd }),
              signal: exec.signal,
            })
          } catch {
            // 重算失败不改变已落盘的事实；退回创建前的 target，至少行为与旧版一致。
          }
          ctx.emit('fs/observed', settled, { kind: 'present', version: created.version }, exec)
          // 建文件也是一次“写成功” ⇒ 同样回读校验（create 被偷偷改写的后果与编辑一样真）。
          const createdVerification = await verifyWriteBack(ctx.fs, settled, createContent, settled.displayPath ?? target.displayPath, exec.signal)
          // 新建的内容也是“自己刚写过的内容” ⇒ 记成最新观测，随后编辑它不必带 unverified_region。
          // 记账同样取**提供方视角**：内容自带前导 U+FEFF 时，下一次 readText 会剥掉一个，
          // 存原样就会让随后的未断言编辑第 1 行被误拒（F1 就是这条）。
          const createdView = providerView(createContent)
          const createdByteOrderMark = createContent.startsWith(BYTE_ORDER_MARK)
          rememberRead(
            settled.displayPath ?? target.displayPath,
            contentToken(createdView, createdByteOrderMark),
            createdView,
            createdByteOrderMark,
            settled.targetKey ?? target.targetKey,
          )
          return {
            path: target.displayPath,
            operation: 'create',
            outcome: 'applied',
            applied: [
              {
                line: 1,
                tier: 'create',
                byNear: false,
                actual: '',
                replaced: created.after ?? createContent,
              },
            ],
            dryRun: false,
            write_verify: createdVerification,
          }
        }
        /**
         * C55：非 UTF-8 文件 ⇒ **可执行的拒绝**。
         *
         * 只换说法，不换通道：它仍是抛错（工具级/环境级故障），不是结果通道——这一点是
         * 刻意留住的（否则「读不了这个文件」会被伪装成「判不出你要哪一段」，调用方会去改
         * 地址、改模式，而它真正要做的是把文件转成 UTF-8）。它也不进下面 `planHunks` 那个
         * catch：那一支的判断表（`OUTCOME_BY_CODE`）只管定位失败。
         *
         * 位置也是判据的一部分：它在 `readText` 上，早于 `regionGate`、`writeText`，
         * 所以回执里那句「没有写盘」是**结构性**成立的，不靠任何回滚去兼。
         */
        let content
        try {
          content = await ctx.fs.readText(target, exec.signal)
        } catch (error) {
          if (!isNonUtf8TextFailure(error)) throw error
          throw Object.assign(new Error(nonUtf8RefusalMessage('patch', target.displayPath, 'aura_basetools_edit')), {
            code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'ERR_ENCODING_INVALID_ENCODED_DATA',
            cause: error,
          })
        }
        // BOM 在解码时已经丢了（只丢第一个），写回前先问字节：它是唯一能回答“原来有几个 BOM”的地方。
        const byteOrderMarks = await fileByteOrderMarkCount(ctx.fs, target, exec.signal)
        if (args.require_observation === true) {
          requireObservedRevision({
            displayPath: target.displayPath,
            ...(typeof target.targetKey === 'string' && target.targetKey.length > 0
              ? { identityKey: target.targetKey }
              : {}),
            content,
            byteOrderMark: byteOrderMarks > 0,
          })
        }
        let planned
        try {
          /**
           * 第 4 参（`{ identityKey, byteOrderMark }`）**不是可选的**，两个值上面都已算好：
           * 句柄里的**身份标签**按 `ledgerIdentityKey(filePath, identityKey)` 算、**区间摘要**
           * 按"含 BOM 的区间字节"算，而读侧记账时递的正是这两样（`aura-read/index.js` 同样
           * 递 `target.targetKey`）。
           *
           * 漏传的后果**不是改错地方**，而是这两个口径与句柄里那份对不上 ⇒ BOM 文件与
           * 别名/符号链接路径上句柄**永远**判成 `PATCH_HANDLE_STALE`（一律拒绝）。
           * 与下面 `regionGate` 递的是同一对值（那里传的是 `byteOrderMark: byteOrderMarks > 0`
           * 与 `identityKey: target.targetKey`）——两处必须同源，否则同一份文件在"闸门"与"句柄核对"
           * 里会有两种身份。判据：段G 三档端到端（普通 / BOM / 别名路径），mutation 去掉本参数即变红。
           */
          planned = planHunks(content, hunks, target.displayPath, {
            byteOrderMark: byteOrderMarks > 0,
            ...(typeof target.targetKey === 'string' && target.targetKey.length > 0
              ? { identityKey: target.targetKey }
              : {}),
          })
        } catch (error) {
          /**
           * 定位失败分两种，**在这里分道**（fs-contract-v2 的核心改动）：
           *
           *   · 判定得出意图（原文不在文件里 / 断言不符 / 多处都能对上 / 坐标越界，
           *     以及 C49 补的第四态「原文不在、但结果已经是你给的样子了」）
           *     ⇒ 回一条**正常结果**，`outcome` 说清是哪一种。抛错会把
           *       `candidates`/`next`/`already_applied` 这些结构化字段一起丢掉——框架只取
           *       `error.message`（`dsh-tools/lib/index.js` 的 errorMessage），于是"选哪一个"
           *       "已经改好了没有"这份信息在错误通道里**根本传不出去**。
           *   · 工具级故障（IO、沙箱、引擎内部 bug）⇒ 原样抛出，一个字不少。
           *
           * 判定表与理由见 {@link OUTCOME_BY_CODE}（缺省态）与 {@link SECOND_EXIT_BY_CODE}
           * （同一码的第二种事实）；判决本体见 {@link intentVerdict}。
           *
           * 顺序也是判据的一部分：证据先算（`secondExitEvidence`，读的是**已读到的全文**）、
           * 再判决。位置更讲究：`planHunks` 刚抛、`regionGate` 还没跑、`writeText` 更没轮到 ⇒
           * 这条路上"任何字节都没写"是**结构性的**（事务性来自"先全部规划完再落盘"），
           * 第四态那句"这次没写盘"不需要任何回滚去兼。也正因此这里**不**刷新观测账本
           * （`rememberRead`）：什么都没写，就没有"自己刚写的内容"要记。
           */
          const already = secondExitEvidence(error, content, hunks)
          const verdict = intentVerdict(error, already)
          if (verdict !== null) {
            /**
             * 第四态的回执**不带**符号目录：那不是失败，而是"已经是你给的样子了"。
             * 给一条根本没发生的失败附上恢复路径，等于把模型赶去修一个不存在的问题。
             */
            if (verdict.outcome === 'already_applied') {
              return intentReceipt(target.displayPath, verdict, args.dry_run === true)
            }
            // 锚点失败时**不要只报错**：把该文件的结构目录一并交回，给模型一条可执行的恢复路径。
            // 实测依据：patch 的失败用例里 100% 都能被符号名救回（locator-lab/recoverable.mjs），
            // 而符号级定位对文本扰动免疫——文本怎么错都影响不到它。
            // 这一步把一个死胡同变成一次可判定的重试，且只在失败时付费。
            // 现在它进的是**回执正文**而不是错误消息：失败不再抛错，这段建议要是留在 throw 里
            // 就永远到不了模型眼前。
            return intentReceipt(
              target.displayPath,
              { ...verdict, message: `${verdict.message}${symbolHint(target.displayPath, content)}` },
              args.dry_run === true,
            )
          }
          throw new PatchError(
            `${error.message}${symbolHint(target.displayPath, content)}`,
            error.code ?? 'PATCH_FAILED',
            error.candidates === undefined ? {} : { candidates: error.candidates },
          )
        }
        const { content: next, applied } = planned

        /**
         * `dry_run` **不能排在闸门之前**（真机实测的结论）。
         *
         * 旧顺序下会出现：预演说 "every hunk matched"，而同样的 hunks 真落盘时闸门报
         * "the text you addressed moved: line 3 no longer holds it (it is now line 1)"。
         * 也就是**预演没预演出真正的判决**——而预演的全部价值就在于“先看会发生什么”。
         * 一个只在写入路径上生效的闸门，配上一个说“没事”的预演，比没有预演更坏：
         * 它会把“会被拒的编辑”报成“可以放心提交”。所以闸门先行，预演在它之后。
         */

        /**
         * 区域级新鲜度闸门（C13）：未带 `expect` 的 hunk，落盘前核对**被寻址区域**
         * 是否在“本次观测”之后被改过（判据形状见 {@link staleConflicts}）。
         *
         * 为什么不能退化成全局版本守：v1 就是因为“整份版本变了就拒”被否掉的——
         * 它会误杀“别人改了无关区域”的正常编辑（段C）。这里只看被寻址区域的文本。
         * 也从没读过（`latestObservation` 为 null）时不拦：那种情况下没有可比的基准，
         * 诚实地在回执里带 `unverified_region`，而不是拿别的信号冒充新鲜。
         *
         * 判据与收据都住在 write-path.mjs（`staleConflicts` / `staleRegionRefusal`）——
         * 这里只做编排。读侧、写侧、独立 CLI 共用同一份，正是为了不再出现
         * “同一个决策写在两处，必有一处漏改”（本文件已经被这条坑过一次，见 `symbolHint`）。
         */
        // `byteOrderMarks` 已在上面从**字节**量过（第 511 行）：BOM 在解码后看不见，
        // 而账本令牌是按 `contentToken(读到的文本, 字节里有 BOM 吗)` 记的。
        // 漏传会让所有 BOM 文件的回执被标成 `unverified_region`（"核对过"被报成"没核对过"）。
        /**
         * **显示路径 vs 账本身份**（C61）：`displayPath` 是调用方给的那个写法（回执 / 报错 /
         * 候选行 / 诊断里的路径一字不许换）；`identityKey` 是"这份盘上文件是谁"，只给闸门记账用。
         *
         * 事实来源是宿主自己：`ctx.fs.resolve()` 的 `targetKey`——`dsh-fs` 的类型契约把它定义为
         * 「Opaque key for stale guards and target lookup」（`lib/types/types.d.ts:10-14`、`:54`），
         * 本地后端（`dsh-fs-local/lib/index.js:159`）的实现是 `await realpath(displayPath)`。
         *
         * 为什么必须在这一层递：junction / 符号链接 / 8.3 短名只有文件系统认得，而引擎
         * （`locator-lab/*.mjs`）被 `build/make-bundle.mjs` 的 `copyFile` 守卫禁止直接碰 `node:fs`。
         * 实测后果在 `locator-lab/alias-identity-test.mjs` 段A/段B：读 `…\linkdir\Gamma.js`、
         * 第三方改掉被寻址的第 3 行、再用 `…\realdir\Gamma.js` 发一个无 `expect` 的 hunk
         * ⇒ 改前 `outcome=applied` 且磁盘被静默覆盖（两个方向各自复现过一次）。
         *
         * 归一化只有一处实现：引擎的 `read-core.mjs` 的 `ledgerIdentityKey`（`regionGate`
         * 内部走它）。这里不重复实现，只把宿主已有的事实递进去。
         */
        const gate = regionGate(hunks, content, planned, target.displayPath, {
          byteOrderMark: byteOrderMarks > 0,
          ...(typeof target.targetKey === 'string' && target.targetKey.length > 0
            ? { identityKey: target.targetKey }
            : {}),
        })
        if (!gate.clean) throw new PatchError(gate.message, 'PATCH_STALE_REGION', gate.extras)
        /**
         * 交付覆盖闸（1.0.2）：`require_delivered` 由公开写面（apply）传进来。
         * 与陈旧闸门同一条位置纪律——规划之后、预演之前、落盘之前。
         */
        if (args.require_delivered === true) {
          const unseen = coverageGate(hunks, planned, content, target.displayPath, {
            byteOrderMark: byteOrderMarks > 0,
            ...(typeof target.targetKey === 'string' && target.targetKey.length > 0
              ? { identityKey: target.targetKey }
              : {}),
          })
          if (unseen !== null) throw new PatchError(unseen.message, 'PATCH_UNSEEN_REGION', unseen.extras)
        }
        // 闸门过了才轮到预演：此刻“预演通过”与“真写会成功”是同一句话。
        if (args.dry_run === true) {
          return { path: target.displayPath, outcome: 'applied', applied, dryRun: true }
        }

        // 本次读取就是一次合法观测，先记上：策略随后对**其它**改动方仍然有效，
        // 而本工具自己的新鲜度由锚点保证——见下。
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

        /**
         * 写回：**提供方级 CAS 的整份写**（writeText + replaceIfVersion），不再用 editText。
         *
         * 为什么必须换：`editText` 内部先把整份内容归一到 LF、匹配替换，再按 `detectLineEndings`
         * 的**多数派**把整份内容统一成一种行尾（dsh-fs-local 的 normalizeLineEndings /
         * restoreLineEndings）⇒ **没被寻址**的行的行尾也会跟着变。真机实测：
         * `alpha\n beta\r\n gamma\n delta\n` 改第 4 行 ⇒ 第 2 行的 `\r\n` 变 `\n`（24 → 23 字节）。
         * `writeText` 逐字节落盘（`:821-839`），因此混合行尾也能只改被寻址那一段。
         *
         * 守卫不弱于旧的：`replaceIfVersion` 在提供方的 per-target 临界区里比对版本
         * （版本 = dev:ino:size:mtimeNs:ctimeNs，原子发布还换 inode），读后被第三方改过 ⇒
         * `FS_STALE_VERSION` 且磁盘不变（locator-lab/byte-fidelity.mjs 段 F 有反向断言）。
         * 内容一侧的守卫也仍在：`planHunks` 已经按**实际读到的全文**逐条定位与核对过，
         * 交出去的 `next` 就是那个内容加上本次改动。
         *
         * 沙箱策略照第 5 个参数传：`dsh-fs-sandbox` 的 writeText 与 editText 用同一个
         * `checkedTarget`（`dsh-fs-sandbox/lib/index.js:125` 与 `:139`），漏传才会退回
         * “没有会话的策略”——那会让本工具在 workspace-write 下写不动。
         *
         * 后端没有 writeText 时（仓库里几个 mock 就是这种形状）退回原来的 editText：
         * 那条路对**行尾统一**的文件逐字节等价（normalize/restore 在纯 LF / 纯 CRLF / 纯 CR 上
         * 是恒等变换），与改前行为一致，不会更坏；真实后端（dsh-fs-local / dsh-fs-sandbox）都有它。
         */
        const newContent = carryingByteOrderMarks(next, byteOrderMarks)
        const byteExact = typeof ctx.fs.writeText === 'function'
        if (!byteExact && hasMixedLineEndings(newContent)) {
          // 后端没有整份写能力，而这份文件是混合行尾 ⇒ 两条路都会改坏非目标行。拒绝，不降级。
          throw new PatchError(
            `cannot patch "${target.displayPath}": this file mixes CRLF and LF line endings and the filesystem backend cannot write it back byte-for-byte (no writeText) — normalize the line endings first, then retry`,
            'PATCH_NO_BYTE_EXACT_WRITE',
          )
        }
        let outcome
        try {
          outcome = byteExact
            ? await ctx.fs.writeText(target, newContent, { kind: 'replaceIfVersion', version: info.version }, exec.signal, policy)
            : await ctx.fs.editText(target, { oldString: content, newString: newContent, replaceAll: false }, undefined, exec.signal, policy)
        } catch (error) {
          throw remediate(error, target.displayPath)
        }
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        /**
         * 落盘后**回读校验**（C14）：先验证，再记账。
         *
         * 顺序是故意的：验证失败时**不刷新观测**——那一刻我们并不知道磁盘上是“我以为写下的内容”，
         * 把它记成最新观测等于替提供方的改写背书。失败回执让模型重读，重读会写下真观测。
         */
        const verification = await verifyWriteBack(ctx.fs, target, newContent, target.displayPath, exec.signal)
        /**
         * 自己刚写的内容就是**最新观测**：不刷新它，同一轮里对同一区域的第二次编辑
         * 会被上面那道闸门拦下（段E 就是这条）。存的版本按内容指纹算（与 `aura_basetools_read` 同一把尺子），
         * 存的内容是**提供方视角文本**（见 {@link providerView}）——与下一次读所见逐字一致。
         */
        const writtenView = providerView(newContent)
        const writtenByteOrderMark = newContent.startsWith(BYTE_ORDER_MARK)
        /**
         * 身份键一并递下去（C61）：事件簿要记在**同一处**，别名索引也要按调用方那种写法登记
         * —— 否则"读别名 → 写真实路径 → 再写别名"的第三步查不到刚刚写下的观测。
         * 这里与上面 `regionGate` 用的是同一个事实（`target.targetKey`），两处都不是自己算的。
         */
        rememberRead(
          target.displayPath,
          contentToken(writtenView, writtenByteOrderMark),
          writtenView,
          writtenByteOrderMark,
          target.targetKey,
        )
        return {
          path: target.displayPath,
          // 三态里的"改成了"。这三个 return（create / dry_run / 真写）都必须带上它——
          // 它是必填字段，漏一个就是一条成功路径被自己的 schema 拒掉。
          outcome: 'applied',
          applied,
          dryRun: false,
          write_verify: verification,
          // 没有基准（从未观测过 / 基准已被淘汰）时如实标注，与 CLI 侧同一句话：
          // "没核对过"与"核对过且没变"必须是两句话，否则回执在撒谎。
          ...(gate.basis === 'none' ? { unverified_region: true } : {}),
        }
      },
      presentCall: (args) => {
        // 多目标的卡片：`file_path` 不在场，照单目标那行拼出来会是 “Patch undefined”。
        if (Array.isArray(args?.targets)) {
          return {
            card: 'generic',
            title: `Patch ${args.targets.length} targets`,
            kind: 'edit',
            rawInput: { targets: args.targets.length },
          }
        }
        return {
          card: 'generic',
          title: `Patch ${args.file_path}`,
          kind: 'edit',
          rawInput: hunks,
        }
      },
    })
  lastLegacyTools = { write: writeTool, convert: convertTool, edit: editTool }
}

export { planHunks } from '../locator-lab/write-path.mjs'