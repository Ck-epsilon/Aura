/**
 * args.mjs —— 把「模型写出来的参数形状」收敛成引擎要的那一种。
 *
 * 为什么单独有这一层：工具参数是模型写的 JSON，它最常见的失误不是"不知道该读哪几行"，
 * 而是**把行区间写坏**——`"lines": 412, 500`（这已经不是合法 JSON）、`"lines": "412,500"`、
 * `"lines": 412`、`start_line`/`end_line` 混用。实测报错长这样：
 *
 *     Error: invalid arguments: "arguments" must be an object
 *
 * 那是**宿主**在参数进工具之前拒的（`dsh-tools` 的 JSON Schema 校验，code `INVALID_ARGS`）——
 * 参数根本没成为对象时，工具无能为力。但只要参数**对象**到了，能容的就该容下来：
 * 多容一种形状，就少一次"报错 → 重试 → 再报错"的来回。
 *
 * 本文件是纯函数（不用 node:fs、无平台分支），DSH 工具壳 / CLI / MCP 三面共用同一套判据。
 */

/**
 * 句柄的**形状**只由 `handle-core.mjs` 一处定义（`HANDLE_RE`），这里只把它包成参数面的判词。
 *
 * 为什么不在这里再写一份正则：两个真值来源必然漂开，而漂开之后"写坏的句柄"与"不是句柄"
 * 会有两种说法——判据只有一份这条规矩，本仓已经为同类问题裁过一次（见 `HANDLE_RE` 的注释）。
 */
import { HANDLE_RE, parseHandle } from './handle-core.mjs'


/**
 * 把 number / "412" 收敛成整数行号；小数、空串、非数字一律 undefined。
 *
 * **刻意不在这里判"行号是否合法"**（0、负数、start>end 都照原样传下去）：越界与倒序该由引擎
 * 回它自己那把结构化错误（READ_BAD_RANGE 等），而不是在这层被悄悄变成"没给行号"——
 * 那样错误码会从"区间不合法"变成"缺参数"，调用方看到的就完全不是一回事了（实测踩过：
 * 11 个套件变红，全是拿越界行号在验结构化拒绝）。
 */
export function toLineNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/**
 * 单个 hunk 允许**平铺在一层里**（不必包进 `hunks: [...]`）。
 *
 * 实测依据（403 会话日志）：报 `hunks must be a non-empty array` 的失败有 27 次，
 * 入参形状一律是 `{file_path, start_line, end_line, replace}`——模型把“一个 hunk”
 * 直接写在了顶层。CLI 那边同理：`--lines 5 --replace X` 比手写转义过的 JSON 数组好用。
 *
 * 取值就是 hunk 声明里的那几个键。**只取有值的**：平铺形状下常把不用的键留成 `null` / `""`
 * （`{anchor: null, lines: [3,3]}`），而 `planHunks` 判“有没有这个地址”用的是
 * `typeof x === 'string' && x.trim().length > 0`——把空值搬进去等于给它一个**假地址**，
 * 会把“缺地址”变成更难懂的定位失败。
 *
 * 判“是不是平铺形状”只认**地址键**，不认 `replace`：`replace` 单独出现说明不了什么
 * （没有地址的 `replace` 在两种形状下都该报“缺 hunks”），而 `expect` 也不是地址键。
 *
 * 三个调用面（DSH 壳 / CLI / 以后接的框架）**共用这一份**，不各写一套容错规则——
 * 这正是 args.mjs 开头说的那层：能容的就容下来，但不能容出两套判据。
 *
 * @param source - 工具入参（或 CLI 的旗标对象）
 * @returns 一个 hunk 对象；不是平铺形状则 null
 */
export function flatHunk(source) {
  if (source === null || typeof source !== 'object') return null
  const ADDRESS_KEYS = FLAT_ADDRESS_KEYS
  if (!ADDRESS_KEYS.some((k) => source[k] !== undefined)) return null
  const hunk = {}
  for (const key of [...ADDRESS_KEYS, ...HANDLE_SHAPE_KEYS, 'context', 'replace', 'expect', 'near', 'eol', 'replace_all']) {

    const value = source[key]
    if (value === undefined || value === null) continue
    // `replace: ''` 是**删除**，是合法动作；其余空串仍然不是地址/断言。
    if (typeof value === 'string' && value.length === 0 && key !== 'replace') continue
    hunk[key] = value
  }
  return typeof hunk.replace === 'string' ? hunk : null
}

/**
 * 单次读请求的**统一收敛**（单目标与 `targets` 元素共用）。
 *
 * 旧版 `readManyTarget` 手写字段转发，`offset` / `limit` / `context` / `kind` / `budget`
 * 在多目标里被静默丢掉——同一个元素单独读与放进 `targets` 读会得到两种结果。
 * 这里把“行区间 / 分页 / 模式推断 / 非法组合”收成一份，两个入口都调它。
 *
 * `totalLines` 只有在内容已读到时才给得出；第一遍（读文件前）传 undefined，用来尽早拒绝
 * 形状错误；第二遍传真实行数，用来做 offset 越界与尾行截断。
 *
 * @returns `{ok:true, mode, lines, paginate, offset, limit}` 或
 *   `{ok:false, code:'READ_BAD_ARGS', error}`。
 */
export function normalizeReadRequest(args, totalLines = undefined) {
  const lines = lineRangeOf(args)
  if (lines === undefined && gaveLineAddress(args)) {
    return { ok: false, code: 'READ_BAD_ARGS', error: LINE_ADDRESS_HINT }
  }
  const paginate = args.offset !== undefined || args.limit !== undefined
  if (paginate && lines !== undefined) {
    return { ok: false, code: 'READ_BAD_ARGS', error: 'use either lines/start_line+end_line or offset/limit, not both' }
  }
  if (paginate && args.mode !== undefined && args.mode !== null && args.mode !== 'auto') {
    return { ok: false, code: 'READ_BAD_ARGS', error: `mode=${JSON.stringify(args.mode)} cannot be combined with offset/limit; drop the mode or use lines/start_line+end_line` }
  }
  const offset = paginate ? Number(args.offset ?? 0) : null
  const limit = paginate ? Number(args.limit ?? 2000) : null
  if (paginate && (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit <= 0)) {
    return { ok: false, code: 'READ_BAD_ARGS', error: 'offset must be an integer >= 0 and limit an integer > 0' }
  }
  let resolvedLines = lines
  if (paginate && totalLines !== undefined) {
    if (!Number.isInteger(totalLines) || totalLines < 1 || offset >= totalLines) {
      return { ok: false, code: 'READ_BAD_ARGS', error: `offset ${offset} is outside 0..${Math.max(0, totalLines - 1)}` }
    }
    resolvedLines = { start: offset + 1, end: Math.min(offset + limit, totalLines) }
  }
  return {
    ok: true,
    mode: paginate ? 'lines' : inferReadMode(args, lines),
    lines: resolvedLines,
    paginate,
    offset,
    limit,
  }
}
/**
 * 平铺形状的**地址键**（{@link flatHunk} 与未知参数守卫共用同一份名单）。
 *
 * 导出它是为了不再出现第二份：守卫要拿它算“合法键集合”，而如果有两份名单，
 * 新增一种地址写法时必有一处漏改——那正是本项目反复出现的形状。
 */
export const FLAT_ADDRESS_KEYS = ['target', 'intent', 'lines', 'start_line', 'end_line', 'line_cue', 'anchor', 'handle', 'old']

/**
 * `targets` 元素（单目标参数）的合法键。
 *
 * 与顶层工具键**分开**：`targets` 本身、批量级的 `include_transaction` 都不是元素参数；
 * 放进元素里只会被静默丢掉。三面（CLI / MCP / DSH）共用这一份，未知键一律
 * `ARGS_UNKNOWN_KEY`，不再只校验顶层。
 */
export const MT_READ_ELEMENT_KEYS = [
  'file_path', 'mode', 'around', 'lines', 'start_line', 'end_line', 'search', 'context', 'since', 'kind', 'budget', 'max_chars', 'offset', 'limit',
]
export const MT_EDIT_ELEMENT_KEYS = [
  'file_path', 'hunks', 'create', 'dry_run', 'require_observation',
  'target', 'intent', 'lines', 'start_line', 'end_line', 'line_cue', 'anchor', 'old', 'context',
  'replace', 'replace_all', 'eol', 'expect', 'near', 'handle', 'line', 'position',
]

/**
 * 句柄形状的**从属键**（fs-contract-v2 / HD2）：它们只在 `handle` 在场时有意义，
 * 因此**不算地址键**（单给一个 `line` / `position` 不构成一次编辑），但平铺时必须被带上。
 *
 * `line` 是段内相对行（1-based，相对区间起点）；`position` 是 `before` / `after` 的边界插入。
 * 两个名字都和既有键不冲突：`lines` 是调用方抄来的绝对坐标，`line` 从来不是入口——
 * 平铺形状里带上它，才不会出现"参数到了、引擎却没收到"这种静默丢字段。
 *
 * **带上 ≠ 成立**：两者单独在场（或与别的地址形状混用而没 `handle`）一律拒绝，
 * 判据本体在 `write-path.mjs` 的 `planHunks`（`PATCH_NO_ADDRESS`）——只有一处，
 * 因为入口不止一个（数组形 / 平铺形 / CLI / MCP），每个入口各自兜住就是两份判据。
 */
export const HANDLE_SHAPE_KEYS = ['line', 'position']

/**
 * 句柄参数的**形状守卫**（参数面）：非空字符串、且匹配 `HANDLE_RE` 才算成形。
 *
 * 形状不对在编辑侧是**抛错**而不是结果（契约 §5 第 0 步）：它是"参数没成形"，
 * 与 `ARGS_UNKNOWN_KEY` / `PATCH_NO_ADDRESS` 同族，与"地址对不上"是两件事。
 *
 * @param value - 调用方给的 `handle`
 * @returns `{ok: true, parsed}` 或 `{ok: false, reason}`（`reason` 直接进 message，要短）
 */
export function handleShapeVerdict(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'must be a string' }
  if (value.length === 0) return { ok: false, reason: 'is empty' }
  const parsed = parseHandle(value)
  if (parsed.ok) return { ok: true, parsed }
  return {
    ok: false,
    reason: `does not look like ${HANDLE_RE.source} (expected h<4 hex><8 hex>:<startLine>-<endLine>)`,
  }
}


/**
 * 拒绝**工具不认识的顶层参数**——而不是静默忽略它们。
 *
 * ## 为什么必须有这道守卫（实测出来的）
 *
 * 真框架**不会**剥掉未声明的参数：实测 `aura_basetools_read` 收到 `{file_path, mod: 'map'}` 时
 * `args.mod` 原样到达 `execute`，而工具只读 `args.mode` ⇒ 回一个**默认模式的成功回执**，零反馈。
 * 模型把 `mode` 写成 `mod`、`lines` 写成 `line`、`maxChars` 写成 `max_chars` 时，
 * 它看到的是成功——比报错坏得多（本项目原则：宁可大声失败，不可静默换语义）。
 *
 * 真框架的 schema 校验器也拦不住：它只在 `additionalProperties: false` 时拒未声明属性
 * （`json-schema.js:492`）。两个工具的旧 schema 没写这一条，所以那是**真空白**。
 * 现在两处一起补：schema 里声明 `additionalProperties: false`（让声明面自洽）
 * + 这里运行期守卫（给**可执行**的报错，而 schema 层只能给一句框架的通用话）。
 *
 * ## 实测代价（16757 次真实调用）
 *
 * 会被这道守卫拒的：`limit×13`、`offset×10`、`line_cue×2`、`start_mode×1`、`sandbox_permissions×1`
 * （全在 `aura_basetools_read` 侧；`aura_basetools_edit` 侧**一条都没有**）。
 * 其中 `limit`与`offset` 本意是分页——而本工具的分页参数叫 `start_line`/`end_line`，
 * 静默忽略的结果是“模型以为自己翻页了、实际拿到的是同一段”。报错是**修好**，不是收紧。
 *
 * @param source - 工具入参
 * @param allowed - 本工具声明的顶层键（含名与平铺键）
 * @param toolName - 回执里点名的工具
 * @throws {Error} 带 `code: 'ARGS_UNKNOWN_KEY'`，并在 message 里给出合法键名
 */
export function assertKnownArgs(source, allowed, toolName) {
  if (source === null || typeof source !== 'object') return
  const known = new Set(allowed)
  const unknown = Object.keys(source).filter((k) => !known.has(k))
  if (unknown.length === 0) return
  const hint =
    unknown.length === 1
      ? `unknown argument ${JSON.stringify(unknown[0])}`
      : `unknown arguments ${unknown.map((k) => JSON.stringify(k)).join(', ')}`
  // 只列键名、不列描述：回执要能一眼看完，而参数说明在工具描述里。
  const valid = [...known].sort().join(', ')
  throw Object.assign(
    new Error(`${toolName} got ${hint} — this tool ignores unrecognised arguments, so passing one would silently do nothing. Valid arguments: ${valid}.`),
    { code: 'ARGS_UNKNOWN_KEY', unknown },
  )
}

/** 调用方到底有没有给"行"这类寻址参数（给了但解析不出来时要报错，而不是静默退回 auto）。 */
export function gaveLineAddress(source) {
  if (source === null || typeof source !== 'object') return false
  return (
    source.lines !== undefined ||
    source.line !== undefined ||
    source.range !== undefined ||
    source.start_line !== undefined ||
    source.startLine !== undefined ||
    source.end_line !== undefined ||
    source.endLine !== undefined
  )
}

/**
 * 取"行区间"。接受（任何一种都行）：
 *   · `start_line` + `end_line`（推荐：两个整数，没有数组语法可写错）
 *   · `lines: [412, 500]` / `[412]`
 *   · `lines: "412,500"` / `"412-500"` / `"412 500"` / `"412"`
 *   · `lines: 412`
 *   · `lines: { start, end }`（也认 start_line/end_line、from/to、first/last）
 * @returns {{start: number, end: number} | undefined}
 */
export function lineRangeOf(source) {
  if (source === null || typeof source !== 'object') return undefined
  const pair = (start, end) => (start === undefined ? undefined : { start, end: end ?? start })

  // **给了末端但解析不出来 → 返回 undefined（拒绝），而不是悄悄缩成单行**。
  // `lines: [412, "abc"]` / `start_line: 4, end_line: "abc"` 这种半坏的输入，
  // 如果按"末端缺失就用起端"处理，调用方以为读了一段，实际只读了一行 ——
  // 和 0.4.1 修掉的那类静默换语义是同一个病，不能在收敛层自己又犯一次。
  const gaveStart = source.start_line !== undefined || source.startLine !== undefined
  const gaveEnd = source.end_line !== undefined || source.endLine !== undefined
  const startLine = toLineNumber(source.start_line ?? source.startLine)
  const endLine = toLineNumber(source.end_line ?? source.endLine)
  if (gaveStart || gaveEnd) {
    if ((gaveStart && startLine === undefined) || (gaveEnd && endLine === undefined)) return undefined
    return pair(startLine ?? endLine, endLine ?? startLine)
  }

  const raw = source.lines ?? source.range ?? source.line
  if (raw === undefined || raw === null) return undefined
  if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined
    const start = toLineNumber(raw[0])
    if (start === undefined) return undefined
    if (raw.length === 1) return { start, end: start }
    const end = toLineNumber(raw[1])
    return end === undefined ? undefined : { start, end }
  }
  if (typeof raw === 'number' || typeof raw === 'string') {
    const match = /^(\d+)\s*(?:[,;.\-–~]|\s+)?\s*(\d+)?$/.exec(String(raw).trim())
    if (match === null) return undefined
    return pair(Number(match[1]), match[2] === undefined ? Number(match[1]) : Number(match[2]))
  }
  if (typeof raw === 'object') {
    const start = toLineNumber(raw.start ?? raw.start_line ?? raw.from ?? raw.first)
    const endValues = [raw.end, raw.end_line, raw.to, raw.last, raw.stop]
    const gaveEndKey = endValues.some((value) => value !== undefined)
    const end = toLineNumber(endValues.find((value) => value !== undefined))
    if (gaveEndKey && end === undefined) return undefined // 同上：末端写坏就拒绝，不静默缩成单行
    return pair(start, end)
  }
  return undefined
}

/** 行区间参数写坏时的统一说法：告诉调用方**接受哪些形状**，而不是只说"参数不对"。 */
/**
 * 引擎两处要的形状不同，而且必须是它们各自那个：
 *   · 读侧 `read-core.renderLines` 只认**数组** `[start, end]`（不然 READ_NO_RANGE）；
 *   · 写侧 `locate` 只认 **`{start, end}`**。
 * 收敛层统一给 `{start, end}`，到边界各转一次——转错一边就是“参数对了却报参数错”。
 */
export const asLinePair = (range) => (range === undefined ? undefined : [range.start, range.end])

export const LINE_ADDRESS_HINT =
  'lines 解析不出来：接受 start_line + end_line（推荐）、lines: [412, 500]、lines: "412,500"、lines: 412'

/**
 * 读的模式推断：给了哪类定位参数就用哪个模式，省掉一个"顺手写错 mode"的机会。
 * 显式给了 mode 就一律听它（哪怕同时给了 lines）。
 * @returns {string | undefined} undefined = 交给引擎的 auto
 */
export function inferReadMode(args, range) {
  if (typeof args?.mode === 'string' && args.mode.trim() !== '') return args.mode
  if (range !== undefined) return 'lines'
  if (args?.around !== undefined) return 'around'
  if (args?.search !== undefined) return 'search'
  if (args?.since !== undefined) return 'changed'
  if (args?.kind !== undefined) return 'map'
  return undefined
}

/**
 * 多目标形状的**契约上限**（fs-contract-v2 §2.1）：一次调用最多 32 个目标。
 *
 * 为什么宁可控拒绝也不静默截断：回执体积与宿主载荷都有上限，截断会让调用方以为
 * “这一批都改了”。判据只有这一份 —— 引擎入口与两个壳都调 {@link assertEditTargets}，
 * 任何一处都不许再写一遍 `32`。
 */
export const MT_MAX_TARGETS = 32

/**
 * 并发池大小（契约 §4：`MT_POOL = 8`）。
 *
 * 为什么住在参数面：读侧（`read-core.mjs`）与写侧（`write-path.mjs`）曾**各写一份**
 * `export const MT_POOL = 8` —— 两份活真值恰好同值，于是两边套件同时绿，缝被盖到
 * “有人只改一处”的那一天。与 {@link MT_MAX_TARGETS} 同一条纪律：池大小进的是
 * “同时在飞几个 I/O”这条不变式，不是各引擎可自调的配置。引擎侧改为转发：
 * `import { MT_POOL } from './args.mjs'` 建本地绑定，再 `export { MT_POOL }` 转出去
 * （**不是** `export … from`：那种写法不建本地绑定，引擎自己那两处会当场 `ReferenceError`）。
 *
 * 导出是为了让测试**断言**它，而不是让调用方改写它。
 */
export const MT_POOL = 8

/**
 * 目标元素的路径键。`file_path` 是既有写侧那个键（契约 §2.2 的例子就是它），`path` 是回执里
 * 印的那个名字，`displayPath` 是引擎层那个名字（壳层平铺透传时原样带过来也认）。
 *
 * 三个都认是**容错**，不是三套判据：取值只有 {@link targetPathOf} 一处。
 */
export const MT_TARGET_PATH_KEYS = ['file_path', 'path', 'displayPath']

/**
 * 顶层**单目标形状**的键：它们与 `targets` **互斥**（契约 §1.2）。
 *
 * 多给就是“两种形状同时成形”，谁说了算没有正确答案 —— 参数面必须拒绝，而不是挑一个执行：
 * 挑错的那一次会是一次**静默换语义**的编辑，正是本仓最忌的那一类。
 */
export const MT_SINGLE_TOP_KEYS = ['file_path', 'path', 'displayPath', 'hunks']

/** 参数面报错时的类型说法（`got a string` / `got an array`）。 */
function typeWordOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * 目标元素的路径（第一个非空字符串）—— 取值**只有这一处**。
 * @returns {string | undefined}
 */
export function targetPathOf(element) {
  if (element === null || typeof element !== 'object') return undefined
  for (const key of MT_TARGET_PATH_KEYS) {
    const value = element[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * `targets` 的**形状判据**（参数面，唯一一份）：供引擎入口与两个壳复用。
 *
 * 为什么放在 args.mjs 而不是壳里：壳有两个（DSH 壳 / CLI·MCP 的 ops），判据写两遍必然漂开 ——
 * 而漂开之后同一个载荷在一面被拒、在另一面被执行。与 `lineRangeOf`、`flatHunk` 同一条纪律。
 *
 * 只判**形状**（是不是数组、几项、每项有没有路径、跟单目标形状撞不撞），
 * 元素内部（hunks、地址、`expect`）一律交给引擎那份既有单目标校验器（契约 §2.2：同一个校验器）。
 *
 * @param source - 工具入参
 * @param options.toolName - 回执里点名的工具
 * @param options.targetKey - 多目标那个键，默认 `targets`
 * @returns 校验过的 `targets` 数组；**没有 `targets` 键**时返回 undefined（单目标形状，壳层照旧走）
 * @throws {Error & {code}} `ARGS_TARGETS_SHAPE` / `ARGS_TARGETS_LIMIT` / `ARGS_SHAPE_EXCLUSIVE`
 */
export function assertEditTargets(source, options = {}) {
  const toolName = options.toolName ?? 'this tool'
  const targetKey = options.targetKey ?? 'targets'
  if (source === null || typeof source !== 'object') return undefined
  const raw = source[targetKey]
  // 没有这个键 ⇒ 单目标形状：这里一个字都不说，壳层继续走它今天那条路（契约 §1.1 零回归）。
  if (raw === undefined || raw === null) return undefined
  /**
   * 形状提示语**可换**（读侧的元素是 `{file_path, mode, …}`，写侧是 `{file_path, hunks}`）。
   * 只换措辞，判据一个字不动；缺省值与写侧改前**逐字相同**（`multi-edit-test` 段里比过 message）。
   */
  const shapeHint = options.shapeHint ?? `each one is { ${MT_TARGET_PATH_KEYS[0]}: \"...\", hunks: [...] }`
  if (!Array.isArray(raw)) {
    throw Object.assign(
      new Error(
        `${toolName}: \`${targetKey}\` must be an array of targets (${shapeHint}) — got ${typeWordOf(raw)}; pass one object per file`,
      ),
      { code: 'ARGS_TARGETS_SHAPE', got: typeWordOf(raw) },
    )
  }
  /** 互斥判据（契约 §1.2）就在这里，壳层不许再写一遍。 */
  const clashed = MT_SINGLE_TOP_KEYS.filter((key) => source[key] !== undefined)
  if (clashed.length > 0) {
    throw Object.assign(
      new Error(
        `${toolName}: pass \`${targetKey}\` or the single-target shape (${clashed.join(', ')}), not both — they are two ways to say the same call, and nothing was written`,
      ),
      { code: 'ARGS_SHAPE_EXCLUSIVE', clashed },
    )
  }
  if (raw.length === 0) {
    throw Object.assign(
      new Error(`${toolName}: \`${targetKey}\` is empty — pass at least one target (${shapeHint})`),
      { code: 'ARGS_TARGETS_SHAPE', got: 'an empty array' },
    )
  }
  if (raw.length > MT_MAX_TARGETS) {
    throw Object.assign(
      new Error(
        `${toolName}: too many targets — the limit is ${MT_MAX_TARGETS}, got ${raw.length}; split the call into batches of ${MT_MAX_TARGETS}`,
      ),
      { code: 'ARGS_TARGETS_LIMIT', limit: MT_MAX_TARGETS, got: raw.length },
    )
  }
  raw.forEach((element, index) => {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      throw Object.assign(
        new Error(`${toolName}: \`${targetKey}[${index}]\` must be an object (${shapeHint}) — got ${typeWordOf(element)}`),
        { code: 'ARGS_TARGETS_SHAPE', index, got: typeWordOf(element) },
      )
    }
    if (element[targetKey] !== undefined) {
      throw Object.assign(
        new Error(
          `${toolName}: \`${targetKey}[${index}]\` carries its own \`${targetKey}\` — nested batches are not a shape this tool accepts; flatten it into one array`,
        ),
        { code: 'ARGS_TARGETS_SHAPE', index, got: `an object with \`${targetKey}\`` },
      )
    }
    if (targetPathOf(element) === undefined) {
      throw Object.assign(
        new Error(
          `${toolName}: \`${targetKey}[${index}]\` has no path — give it \`${MT_TARGET_PATH_KEYS[0]}\` (or \`${MT_TARGET_PATH_KEYS[1]}\`)`,
        ),
        { code: 'ARGS_TARGETS_SHAPE', index, got: 'an object without a path' },
      )
    }
    /**
     * 元素级布尔参数在**参数面**就判类型：否则 `require_observation:"yes"` 会在
     * `editTargetRequests` 里抛到编排层之外（dry-run 分支没有 try/catch，CLI 直接吐 Node 栈；
     * 非 dry-run 还会先建一个事务再回滚）。参数没成形属于 `ARGS_*` 面，与 `USAGE/1` 同档。
     */
    for (const key of ['require_observation', 'requireObservation']) {
      if (element[key] !== undefined && typeof element[key] !== 'boolean') {
        throw Object.assign(
          new Error(`${toolName}: \`${targetKey}[${index}].${key}\` must be a boolean — got ${typeWordOf(element[key])}`),
          { code: 'ARGS_BAD_REQUIRE_OBSERVATION', index, key, got: typeWordOf(element[key]) },
        )
      }
    }
    // 元素级的未知键：与顶层同一个守卫、同一套报错（合法键由调用方按读/写给）。
    if (Array.isArray(options.elementKeys)) {
      assertKnownArgs(element, options.elementKeys, `${toolName} ${targetKey}[${index}]`)
    }
  })
  return raw
}

/**
 * 把参数面的目标元素收敛成**引擎请求形状**（`{displayPath, hunks, create?, identityKey?, dryRun?}`）。
 *
 * 为什么也放在这里：形状判据与取值归一一旦分家，就会出现“判的是 A、读的是 B”那种错位；
 * 两个壳 + 引擎入口共用的必须是同一份。**元素内部一个字都不解读** —— hunks、地址、`expect`
 * 原样递下去，由既有单目标校验器判（契约 §2.2）。
 *
 * @param targets - {@link assertEditTargets} 放行的数组
 * @returns `Array<{index, displayPath, hunks, create?, identityKey?, dryRun?}>`（顺序 = 输入顺序）
 */
/**
 * **读侧**的 `targets` 形状校验（契约 §2.1）：与写侧**同一个判据**，只换形状提示语。
 *
 * 为什么不是另一份实现：`assertEditTargets` 里那条互斥判据（`targets` 与单目标形状同时给 ⇒
 * 参数面拒绝）是本仓的**唯一一份**。读侧再写一遍就会漂开 —— 而漂开之后，同一个载荷
 * 在 `aura_basetools_read` 被放行、在 `aura_basetools_edit` 被拒（或反过来），且两边都不会报错。
 *
 * 读侧元素内部（mode / lines / search / since / kind）本函数**一个字都不解读**：
 * 它们由引擎 `readManyWith` 逐项走今天那套单目标判定器（契约 §2.1「同一个校验器」）。
 *
 * @param source - 工具入参
 * @param options.toolName - 回执里点名的工具
 * @returns 校验过的 `targets` 数组；**没有 `targets` 键**时返回 undefined（单目标形状，壳层照旧走）
 * @throws {Error & {code}} 同 {@link assertEditTargets}（`ARGS_TARGETS_SHAPE` / `ARGS_TARGETS_LIMIT` / `ARGS_SHAPE_EXCLUSIVE`）
 */
export function assertReadTargets(source, options = {}) {
  return assertEditTargets(source, {
    ...options,
    shapeHint: `each one is { ${MT_TARGET_PATH_KEYS[0]}: \"...\", mode: \"...\" }`,
  })
}

/**
 * **顶层形状判据**（参数面，唯一一份）：`targets` 与单目标形状**必居其一**。
 *
 * 与 {@link assertEditTargets} 里那条“互斥”判据是一对：
 *   · **两个都给** ⇒ {@link assertEditTargets} 先判，抛 `ARGS_SHAPE_EXCLUSIVE`（语义一字未动）；
 *   · **两个都没给** ⇒ 本函数抛**同族码** `ARGS_SHAPE_EXCLUSIVE`。壳里原来那句
 *     `file_path must be a non-empty string` 就是这条判据的半个身子——它写成特例，
 *     于是“什么都没给”在回执里长得像“file_path 写错了”，而真正的原因是**没有形状可用**。
 *
 * 为什么只能由行为面判：把“二选一”写回 schema **已实测不可行**（本框架方言不支持 `anyOf`，
 * 且校验器对它静默忽略），证据记在 `aura-read/index.js` 的 `file_path` 声明处。而行为面有
 * 两个壳（`aura-read` / `aura-edit`），判据写两遍必然漂开 ⇒ 只此一处，两个壳各调一次。
 *
 * message 里**逐字保留** `file_path must be a non-empty string`：`arg-shape-test` 段C 用这句
 * 正则钉着“两个都没给 ⇒ 也拒”。措辞改了那条断言就红，而那条断言**不许改**。
 *
 * @param source - 工具入参
 * @param options.toolName - 回执里点名的工具
 * @param options.targetKey - 多目标那个键，默认 `targets`
 * @returns `targets` 的值（多目标形状）或 undefined（单目标形状成形）
 * @throws {Error & {code}} `ARGS_SHAPE_EXCLUSIVE`（两个都没给）
 */
export function assertTargetShape(source, options = {}) {
  const toolName = options.toolName ?? 'this tool'
  const targetKey = options.targetKey ?? 'targets'
  const object = source !== null && typeof source === 'object' ? source : undefined
  const raw = object === undefined ? undefined : object[targetKey]
  // `targets` 在场 ⇒ 已经是多目标形状（“与单目标形状互斥”由 assertEditTargets 先判过）。
  if (raw !== undefined && raw !== null) return raw
  // 单目标形状**成形**的唯一条件与两个壳逐字相同：`file_path` 是非空字符串。
  const filePath = object === undefined ? undefined : object.file_path
  if (typeof filePath === 'string' && filePath.trim().length > 0) return undefined
  throw Object.assign(
    new Error(
      `${toolName}: pass \`${targetKey}\` or the single-target shape, not neither — they are two ways to say the same call and exactly one of them has to be there; the single-target shape starts with \`file_path must be a non-empty string\``,
    ),
    { code: 'ARGS_SHAPE_EXCLUSIVE', missing: [targetKey, 'file_path'] },
  )
}

/**
 * 把参数面的目标元素收敛成**引擎请求形状**（`{displayPath, hunks, create?, identityKey?, dryRun?}`）。
 *
 * 为什么也放在这里：形状判据与取值归一一旦分家，就会出现“判的是 A、读的是 B”那种错位；
 * 两个壳 + 引擎入口共用的必须是同一份。**元素内部一个字都不解读** —— hunks、地址、`expect`
 * 原样递下去，由既有单目标校验器判（契约 §2.2）。
 *
 * @param targets - {@link assertEditTargets} 放行的数组
 * @returns `Array<{index, displayPath, hunks, create?, identityKey?, dryRun?}>`（顺序 = 输入顺序）
 */
export function editTargetRequests(targets) {
  return targets.map((element, index) => {
    const request = { index, displayPath: targetPathOf(element), hunks: element.hunks }
    for (const key of ['create', 'identityKey', 'dryRun']) {
      if (element[key] !== undefined) request[key] = element[key]
    }
    /**
     * 单目标参数里的 `require_observation` 在这里翻成引擎的驼峰键。
     *
     * 旧版只转发 `create/identityKey/dryRun`，于是元素上写 `require_observation: true`
     * 在参数面被收下、到引擎前被静默丢掉——与“顶层默认值”相反的行为，而且回执照样成功。
     * 元素显式给了就压过顶层默认（与 `dryRun` 同一口径）。
     */
    const requireObservation =
      element.require_observation !== undefined ? element.require_observation : element.requireObservation
    if (requireObservation !== undefined) {
      if (typeof requireObservation !== 'boolean') {
        throw Object.assign(new Error(`targets[${index}].require_observation must be a boolean`), {
          code: 'ARGS_BAD_REQUIRE_OBSERVATION',
        })
      }
      request.requireObservation = requireObservation
    }
    return request
  })
}
