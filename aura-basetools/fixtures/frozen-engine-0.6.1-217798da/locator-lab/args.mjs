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
  for (const key of [...ADDRESS_KEYS, 'replace', 'expect', 'near']) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.length === 0) continue
    hunk[key] = value
  }
  return typeof hunk.replace === 'string' ? hunk : null
}

/**
 * 平铺形状的**地址键**（{@link flatHunk} 与未知参数守卫共用同一份名单）。
 *
 * 导出它是为了不再出现第二份：守卫要拿它算“合法键集合”，而如果有两份名单，
 * 新增一种地址写法时必有一处漏改——那正是本项目反复出现的形状。
 */
export const FLAT_ADDRESS_KEYS = ['target', 'lines', 'start_line', 'end_line', 'line_cue', 'anchor']

/**
 * 拒绝**工具不认识的顶层参数**——而不是静默忽略它们。
 *
 * ## 为什么必须有这道守卫（实测出来的）
 *
 * 真框架**不会**剥掉未声明的参数：实测 `aura_read` 收到 `{file_path, mod: 'map'}` 时
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
 * （全在 `aura_read` 侧；`aura_edit` 侧**一条都没有**）。
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
