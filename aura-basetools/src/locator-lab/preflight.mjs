/**
 * preflight.mjs —— 写前预检 + 写后结构状态（错误闭环的第一段）。
 *
 * ## 它治什么
 *
 * 工具的错误预算里，代价最高的不是“拒绝”，而是**写下去了才发现坏了**：JSON 少一个括号、
 * 替换文本里混进 lone CR、在没读过的文件上一次删掉 90 行。这些都**在本地就能判**，
 * 判据不该等下一次读或下一次测试。
 *
 * 所以：`planHunks` 算出“写下去会变成什么”之后、任何字节落盘之前，跑一遍不变量。
 * 致命项 ⇒ 抛 `PATCH_*`，**零写入**；提醒项 ⇒ 随回执带出（只在存在时出现，保持既有回执
 * 逐字节不变——黄金集就是靠这一条不被打扰）。
 *
 * ## 为什么只做“真实可判”的几类
 *
 *   · JSON：`JSON.parse` 是真正的解析器，判得准；
 *   · Markdown：围栏配平是确定性的；
 *   · lone CR：字节层事实；
 *   · 大段删除 + 未观察：观测账本里已经有 `basis`。
 *
 * 代码的括号配平**不在**这里：它需要一个完整的词法器（正则字面量、模板串、JSX 都会骗人），
 * 误报会把回执变成噪声。等有真实语料支撑再加。
 */
import { docKindOf } from './doc-structure.mjs'

// 诊断命令也要判“文档类型”，单源在这里。
export { docKindOf }

const JSON_FILE = /\.json$/i

/** 数“孤立 CR”（`\r` 后面不是 `\n`）。 */
export function countLoneCr(source) {
  let n = 0
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\r' && source[i + 1] !== '\n') n += 1
  }
  return n
}

/** 行尾普查：crlf / lf / cr 三种行尾各多少。 */
export function eolCensus(source) {
  const census = { crlf: 0, lf: 0, cr: 0 }
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\r') {
      if (source[i + 1] === '\n') {
        census.crlf += 1
        i += 1
      } else census.cr += 1
    } else if (source[i] === '\n') census.lf += 1
  }
  return census
}

/** 围栏配平：返回未配平的围栏行数（偶数 = 配平）。 */
export function fenceBalance(source) {
  let open = null
  let unbalanced = 0
  for (const line of String(source).split(/\r?\n/)) {
    const hit = /^\s*(```+|~~~+)/.exec(line)
    if (hit === null) continue
    const mark = hit[1][0]
    if (open === null) open = mark
    else if (open === mark) open = null
    else unbalanced += 1
  }
  if (open !== null) unbalanced += 1
  return unbalanced
}

/**
 * 写后结构状态：只在**能判**的格式上给结论；判不了就是 `null`，不猜。
 *
 * 回执里只在 `ok === false` 时出现（保持既有成功回执逐字节不变）。
 */
export function structureOf(source, displayPath) {
  const docKind = docKindOf(displayPath)
  if (docKind === 'json' && JSON_FILE.test(displayPath)) {
    try {
      JSON.parse(source)
      return { kind: 'json', ok: true }
    } catch (error) {
      return { kind: 'json', ok: false, error: String(error?.message ?? error) }
    }
  }
  if (docKind === 'markdown') {
    const balance = fenceBalance(source)
    return { kind: 'markdown', ok: balance % 2 === 0, fences: balance }
  }
  return { kind: null, ok: null }
}

/**
 * 写前预检。
 *
 * `wholeFile`（write 的整份替换）是**显式逃生口**：结构/行尾的致命项降级为提醒，
 * 写入照常进行，写后校验会把 `structure: broken` 放进回执。这样“edit 必须保结构、
 * write 是调用方自己负责”两句话才自洽——否则拒绝报文里建议的 `write` 路径也会被拒。
 *
 * @param {object} input
 * @param {string} input.displayPath - 面向调用方的路径（只用于选判据与报文）
 * @param {string} input.source - 落地前的原文（create 时为空串）
 * @param {string} input.planned - 计划写入的全文（已带 BOM 拼接）
 * @param {'observation'|'handle'|'none'|'create'} input.basis - 这次编辑的核对基准
 * @param {boolean} input.wholeFile - 整份替换（write）时为 true：致命项降为提醒，且不做删除闸
 * @returns {{fatal: Array<{code:string,message:string}>, warnings: Array<{code:string,message:string}>}}
 */
export function preflightEdit({ displayPath, source, planned, basis, wholeFile = false }) {
  const fatal = []
  const warnings = []
  const docKind = docKindOf(displayPath)
  /** 致命项在整份替换时降级为提醒（write 是显式逃生口）。 */
  const fatalOrWarn = (item, relaxedMessage) => {
    if (wholeFile) warnings.push({ ...item, message: relaxedMessage })
    else fatal.push(item)
  }

  // ── JSON：改前能解析、改后不能 ⇒ 拒绝 ─────────────────────────────────────
  if (docKind === 'json' && JSON_FILE.test(displayPath)) {
    let before = true
    try {
      JSON.parse(source)
    } catch {
      before = false
    }
    if (before) {
      try {
        JSON.parse(planned)
      } catch (error) {
        const detail = String(error?.message ?? error).slice(0, 160)
        fatalOrWarn(
          {
            code: 'PATCH_STRUCTURE_BROKEN',
            message: `cannot patch "${displayPath}": this edit would leave the file unparseable as JSON (${detail}) — nothing was written; fix the hunk, or use \`write\` to replace the whole file`,
          },
          `the file will be unparseable as JSON (${detail}); a whole-file write is not blocked, but the receipt will say structure: broken`,
        )
      }
    }
  }

  // ── Markdown：改前围栏配平、改后不配平 ⇒ 拒绝 ─────────────────────────────
  if (docKind === 'markdown') {
    const before = fenceBalance(source)
    const after = fenceBalance(planned)
    if (before % 2 === 0 && after % 2 !== 0) {
      fatalOrWarn(
        {
          code: 'PATCH_STRUCTURE_BROKEN',
          message: `cannot patch "${displayPath}": this edit would leave an unbalanced code fence (${after} unmatched fence marker(s)) — nothing was written; close the fence in the same edit, or use \`write\` for a whole-file change`,
        },
        `the file will have an unbalanced code fence (${after} unmatched fence marker(s)); the receipt will say structure: broken`,
      )
    }
  }

  // ── 孤立 CR：计划内容比原文多出 lone CR ⇒ 拒绝 ────────────────────────────
  const loneBefore = countLoneCr(source)
  const loneAfter = countLoneCr(planned)
  if (loneAfter > loneBefore) {
    fatalOrWarn(
      {
        code: 'PATCH_LONE_CR',
        message: `cannot patch "${displayPath}": the replacement introduces ${loneAfter - loneBefore} lone CR (carriage return without LF) — nothing was written; use \\n (or \\r\\n if the file is CRLF)`,
      },
      `the whole-file write introduces ${loneAfter - loneBefore} lone CR (carriage return without LF)`,
    )
  }

  // ── 大段删除 + 从未读过这个文件 ⇒ 拒绝 ───────────────────────────────────
  // 整份替换（write）不适用：它有显式的 `allow_unobserved` 语义，调用方已经表达过意图。
  if (!wholeFile && basis === 'none' && source.length > 0) {
    const beforeLines = source.split(/\r?\n/).length
    const afterLines = planned.split(/\r?\n/).length
    const removed = beforeLines - afterLines
    if (removed >= 30 && removed >= beforeLines * 0.3) {
      fatal.push({
        code: 'PATCH_DESTRUCTIVE_UNOBSERVED',
        message: `cannot patch "${displayPath}": this edit removes ${removed} of ${beforeLines} lines from a file you have not read — nothing was written; read the file first, or use \`write\` to replace it entirely`,
      })
    }
  }

  // ── 行尾混用：原文是纯 CRLF、计划内容混入 LF ⇒ 提醒（不拒绝） ─────────────
  const beforeEol = eolCensus(source)
  const afterEol = eolCensus(planned)
  if (beforeEol.crlf > 0 && beforeEol.lf === 0 && afterEol.lf > 0) {
    warnings.push({
      code: 'PATCH_EOL_MIXED',
      message: `this edit introduces ${afterEol.lf} LF line ending(s) into a CRLF file — the result has mixed line endings`,
    })
  }

  return { fatal, warnings }
}
