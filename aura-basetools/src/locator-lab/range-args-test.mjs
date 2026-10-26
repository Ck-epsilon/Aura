/**
 * range-args-test.mjs —— 「行区间参数形态 + 原子性」靶场。
 *
 * ## 为什么要有这个靶场
 *
 * 真实会话里模型把行区间写坏的形态是无穷的，而每一种写坏都会变成一次"报错 → 重试 → 再报错"：
 *
 *     {"file_path": "x.py", "lines": 412, 500, "mode": "lines"}   ← 连合法 JSON 都不是
 *     {"lines": "412,500"} / {"lines": 412} / {"start_line": 412, "end_line": 500}
 *
 * 最后那种（`"arguments" must be an object，code INVALID_ARGS`）是**宿主**在参数进工具之前拒的，
 * 参数根本没到工具，工具侧接不住——所以靶场不去模拟它，只钉住"参数对象到了之后"的契约。
 * 本轮为此新增/放宽的三件事，正是本靶场要打的三面：
 *
 *   1. `start_line` + `end_line` 两个整数（没有数组语法可写错）；
 *   2. `lineRangeOf` 的宽容解析（数组 / 字符串 / 数字 / 对象 / 起止字段）；
 *   3. 读模式推断（给了行区间就不必写 `mode`，显式 `mode` 优先）。
 *
 * ## 三个面为什么必须都打（一层测不到另一层）
 *
 *   A 引擎纯函数面 —— `args.mjs` 的收敛层 + `write-path.planHunks` 的规划层。
 *      错误码是**返回值**（`{ok:false, code}`）或 `.code`，可以直接断到码。
 *   B DSH 工具壳面 —— 用 mock ctx 跑 `apply`，拿 `registered.execute`。
 *      **这是唯一能验证"宿主 schema 校验"的地方**：`defineTool` 会在 execute 之前
 *      按声明的 schema 校验参数（实测 `end_line: "abc"` 直接抛
 *      `invalid arguments: "hunks[0].end_line" must be an integer`），
 *      而 schema 一旦写成宿主不认的形状（object 分支漏 `additionalProperties`），
 *      工具在**注册期**就报 UNSUPPORTED_SCHEMA——历史上 11 个套件因此全崩。
 *      所以这里同时断"声明"（parameters 的形状）与"行为"（execute 的产出）。
 *   C 独立面 —— `dist/aura-basetools/bin/aura.mjs`（CLI）与 `aura-mcp.mjs`（MCP）。
 *      产物与 DSH 无关，验证的是"同一套判据在另外两个入口没有第二份实现"。
 *
 * ## 通过数 vs 产品缺口
 *
 * 本靶场把结论分成两类，**不混在一起**：
 *   · `check`  —— 契约断言。红了就是红，退出码非 0。
 *   · `gap`    —— 已核实的**产品缺口**（附最小复现：命令 + 期望 + 实际）。它不计入通过数，
 *                 因为本靶场禁止改产品代码，把它算成红只会让靶场永久变红、失去守卫作用。
 *                 缺口在报告里单独成节，重建产物或修好之后**应当**被提升为 `check`。
 *
 * 观测缓存一律用 `AURA_CACHE_DIR` 指到临时目录——绝不写 `~/.aura`（测试污染用户的 home
 * 是比测不出来更贵的事故）。临时文件全部落在 `os.tmpdir()`，结束前删干净。
 *
 * 运行：node src/locator-lab/range-args-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { apply as applyRead } from '../aura-read/index.js'
import * as editPlugin from '../aura-edit/index.js'
import {
  LINE_ADDRESS_HINT,
  asLinePair,
  gaveLineAddress,
  inferReadMode,
  lineRangeOf,
  toLineNumber,
} from './args.mjs'
import { planHunks } from './write-path.mjs'
import { readWith } from './read-core.mjs'
import { contextServices } from './mock-ctx.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const bin = path.join(root, 'dist', 'aura-basetools', 'bin', 'aura.mjs')
const mcpBin = path.join(root, 'dist', 'aura-basetools', 'bin', 'aura-mcp.mjs')

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const gaps = []
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
/** 已核实的产物缺口：打印 + 记账，但**不**计入通过数（理由见文件头）。 */
const gap = (label, detail) => {
  gaps.push({ label, detail })
  say(`  ⚠ [缺口] ${label} — ${detail}`)
}
const section = (m) => say(`\n=== ${m} ===`)

// ── 夹具：每行内容互不相同，才能断言"读到的确实是那几行"而不是"读了点什么" ──────────
const LINES = ['alpha one', 'beta two', 'gamma three', 'delta four', 'epsilon five', 'zeta six']
const SRC = `${LINES.join('\n')}\n`
const rowOf = (n) => `${n}: ${LINES[n - 1]}`

/**
 * 从渲染文本里取出所有 `行号: 内容` 行——这是"读到哪几行"的唯一判据。
 * 行尾的区间句柄标记（`  <h…>`）不是文件里的字节，比对前先剥掉**行尾那一条**。
 * 剥法是 `$` 锚定的，所以这条判据比以前**更严**而不是放宽：剥完之后行文仍必须逐字节
 * 等于源文，且行尾至多只允许存在一条合法句柄（句柄若吃掉正文，剥完就不再相等）。
 */
const rowsOf = (text) =>
  String(text ?? '')
    .split('\n')
    .filter((l) => /^\d+: /.test(l))
    .map((l) => l.replace(/  <h[0-9a-f]{4}[0-9a-f]{8}:\d+-\d+>$/, ''))
const rowsFor = ([from, to]) => {
  const out = []
  for (let n = from; n <= to; n += 1) out.push(rowOf(n))
  return out
}

/** DSH 壳把引擎信封压成 `new Error(`${code}: ${message}`)`（不带 `.code`），CLI/MCP 带 `.code`。 */
const codeOf = (e) => (e?.code !== undefined && e.code !== null ? e.code : String(e?.message ?? '').split(':')[0])

/**
 * 行区间形状矩阵——三面共用同一份数据，避免"B 面测的形状 C 面没测"这种覆盖率漂移。
 * `want` 是**期望读到的闭区间**；断言会逐行比对渲染出的行，多一行少一行都算错。
 */
const SHAPES = [
  ['start_line + end_line', { start_line: 2, end_line: 4 }, [2, 4]],
  ['lines: [2, 4]', { lines: [2, 4] }, [2, 4]],
  ['lines: "2,4"', { lines: '2,4' }, [2, 4]],
  ['lines: "2-4"', { lines: '2-4' }, [2, 4]],
  ['lines: "2 4"', { lines: '2 4' }, [2, 4]],
  ['lines: 2（单个数字）', { lines: 2 }, [2, 2]],
  ['lines: "2"（单个字符串）', { lines: '2' }, [2, 2]],
  ['lines: {start, end}', { lines: { start: 2, end: 4 } }, [2, 4]],
  ['lines: {from, to}', { lines: { from: 2, to: 4 } }, [2, 4]],
  ['lines: {first, last}', { lines: { first: 2, last: 4 } }, [2, 4]],
  ['lines: {start_line, end_line}', { lines: { start_line: 2, end_line: 4 } }, [2, 4]],
  ['lines: [2]（单元素）', { lines: [2] }, [2, 2]],
  ['start_line 单独给（= 单行）', { start_line: 3 }, [3, 3]],
]

/**
 * 半坏输入：**末端给了但解不出来**。这是本轮刚补的洞——从前会悄悄缩成"只读起点那一行"，
 * 调用方以为读了一段，实际读到一行，且没有任何信号。
 * `route` 是预期它被哪一层拦下，由声明出去的 schema 决定（见 B 面的自校验）。
 */
const HALF_BAD = [
  ['lines: [2, "abc"]', { lines: [2, 'abc'] }, 'engine'],
  ['lines: {start: 2, end: "x"}', { lines: { start: 2, end: 'x' } }, 'engine'],
  ['lines: {start_line: 2, end_line: "abc"}', { lines: { start_line: 2, end_line: 'abc' } }, 'engine'],
  ['start_line: 2, end_line: "abc"', { start_line: 2, end_line: 'abc' }, 'host'],
]

/** 完全解不出来的行区间：必须结构化拒绝，且说清"接受哪些写法"。 */
const UNPARSEABLE = [
  ['lines: "从第2行到第3行"', { lines: '从第2行到第3行' }],
  ['lines: {}', { lines: {} }],
  ['lines: null', { lines: null }],
  ['lines: []', { lines: [] }],
]

/** 越界与倒序：**引擎自己的**结构化错误，绝不能退化成"缺参数"。 */
const OUT_OF_RANGE = [
  ['lines: [0, 2]', { lines: [0, 2] }, 'READ_BAD_RANGE'],
  ['lines: [-3, 2]', { lines: [-3, 2] }, 'READ_BAD_RANGE'],
  ['lines: [5, 2]（起大于止）', { lines: [5, 2] }, 'READ_BAD_RANGE'],
  ['lines: [999999, 1000000]', { lines: [999999, 1000000] }, 'READ_OUT_OF_RANGE'],
]

// ── 宿主 schema 的判据（照抄 DSH：类型 / oneOf 恰好一支 / required / additionalProperties）──
/**
 * 校验一个 value 是否合 schema，返回违规描述数组。
 *
 * 为什么自己写而不引入库：这里要复现的正是 DSH 那几条**具体**判据，
 * 包括"oneOf 必须恰好命中一支"与"object 节点必须显式声明 additionalProperties"——
 * 后者是 `UNSUPPORTED_SCHEMA` 的成因（曾经 11 个套件在注册期全崩）。
 */
function hostViolations(value, schema, at = 'value') {
  const out = []
  if (schema === undefined || schema === null) return out
  if (Array.isArray(schema.oneOf)) {
    const hits = schema.oneOf.filter((branch) => hostViolations(value, branch, at).length === 0)
    if (hits.length !== 1) out.push(`${at} must match exactly one oneOf branch (matched ${hits.length})`)
    return out
  }
  const type = schema.type
  const typeOf = (v) =>
    Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v
  if (type !== undefined) {
    const got = typeOf(value)
    const okType = type === 'integer' ? got === 'integer' : type === 'number' ? got === 'integer' || got === 'number' : got === type
    if (!okType) return [`${at} must be a ${type} (got ${got})`]
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`${at} is missing required property "${key}"`)
    }
    const props = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) out.push(`${at}.${key} is not a declared property`)
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      out.push(...hostViolations(value[key], child, `${at}.${key}`))
    }
  }
  if (type === 'array' && schema.items !== undefined) {
    value.forEach((item, i) => out.push(...hostViolations(item, schema.items, `${at}[${i}]`)))
  }
  return out
}

/**
 * 走一遍 schema，找出会让宿主在**注册期**就拒的形状：**根以下**的 object 节点必须显式声明
 * `additionalProperties`。实测踩过：`lines.oneOf` 的 object 分支漏了它，11 个套件在注册期全崩
 * （UNSUPPORTED_SCHEMA）。根节点由 `defineTool` 自己生成、且线上注册得好好的，所以不查它——
 * 查了就是误报，而误报会让人顺手把守卫关掉。
 */
function unsupportedSchema(schema, at = 'schema', isRoot = true) {
  const out = []
  if (schema === null || typeof schema !== 'object') return out
  if (!isRoot && schema.type === 'object' && typeof schema.additionalProperties !== 'boolean') {
    out.push(`${at}: object node without explicit additionalProperties`)
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((branch, i) => out.push(...unsupportedSchema(branch, `${at}.oneOf[${i}]`, false)))
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    out.push(...unsupportedSchema(child, `${at}.properties.${key}`, false))
  }
  if (schema.items !== undefined) out.push(...unsupportedSchema(schema.items, `${at}.items`, false))
  return out
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-range-args-'))
const cache = path.join(tmp, 'cache') // 观测缓存：绝不写 ~/.aura
// 扒一眼用户 home：运行前后各拍一张快照，任何新增都算测试污染（比测不出来更贵的事故）。
const homeCache = path.join(os.homedir(), '.aura')
const homeCacheBefore = fs.existsSync(homeCache) ? fs.readdirSync(homeCache).sort().join(',') : null
const env = { ...process.env, AURA_CACHE_DIR: cache, AURA_TEST_EXPOSE_LEGACY: '1' }

try {
  const mdPath = path.join(tmp, 'range.md')
  fs.writeFileSync(mdPath, SRC, 'utf8')

  // ══════════════════════════════════════════════════════════════════════════
  section('A 引擎纯函数面：收敛层（args.mjs）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const bad = SHAPES.filter(([, args, want]) => {
      const r = lineRangeOf(args)
      return r === undefined || JSON.stringify(asLinePair(r)) !== JSON.stringify(want)
    })
    check(
      `lineRangeOf 覆盖全部 ${SHAPES.length} 种形态（起止值都收对）`,
      bad.length === 0,
      bad.map(([l]) => l).join(', '),
    )

    // 单行形态必须收敛成 start === end（写侧 locate 与读侧 renderLines 都靠这个）
    check(
      '单行形态收敛成 start === end（"2" / 2 / [2] / {start: 2}）',
      [
        { lines: '2' },
        { lines: 2 },
        { lines: [2] },
        { lines: { start: 2 } },
        { start_line: 2 },
      ].every((a) => {
        const r = lineRangeOf(a)
        return r !== undefined && r.start === 2 && r.end === 2
      }),
    )

    // 收敛层刻意**不判合法性**：越界与倒序要原样传到引擎，由引擎回自己的码。
    // 这里一旦"顺手修正"，错误码就会从"区间不合法"退化成"缺参数"（实测踩过：11 个套件变红）。
    check(
      'toLineNumber 不做合法性判断（0 / 负数 / 起大于止照原样）',
      toLineNumber(0) === 0 && toLineNumber(-3) === -3 && toLineNumber(5) === 5 && toLineNumber('7') === 7,
      `0→${toLineNumber(0)} -3→${toLineNumber(-3)} "7"→${toLineNumber('7')}`,
    )
    check(
      'lineRangeOf 把越界/倒序原样传给引擎（不返回 undefined）',
      JSON.stringify(asLinePair(lineRangeOf({ lines: [5, 2] }))) === '[5,2]' &&
        JSON.stringify(asLinePair(lineRangeOf({ lines: [0, 2] }))) === '[0,2]',
      `[5,2]→${JSON.stringify(lineRangeOf({ lines: [5, 2] }))}`,
    )
    check('toLineNumber 拒绝小数与非数字', toLineNumber(1.5) === undefined && toLineNumber('abc') === undefined)

    // ── 本轮刚补的洞：末端给了但解不出来 → undefined（拒绝），不缩成单行 ──────────────
    const halfBadConverge = HALF_BAD.filter(([, args]) => lineRangeOf(args) !== undefined)
    check(
      '半坏区间（末端解不出来）在收敛层一律 undefined —— 不悄悄缩成单行',
      halfBadConverge.length === 0,
      halfBadConverge.map(([l]) => l).join(', '),
    )
    check(
      '半坏区间确实"给了行地址"（gaveLineAddress 为真，所以能走到拒绝分支而不是静默退回 auto）',
      HALF_BAD.every(([, args]) => gaveLineAddress(args)),
    )
    check(
      '单元素 / 只给起点仍然合法 → 单行',
      JSON.stringify(lineRangeOf({ lines: [412] })) === '{"start":412,"end":412}' &&
        JSON.stringify(lineRangeOf({ lines: { start: 1 } })) === '{"start":1,"end":1}' &&
        JSON.stringify(lineRangeOf({ start_line: 4 })) === '{"start":4,"end":4}',
    )

    // ── 解不出来的区间：hint 必须说清接受哪些写法 ─────────────────────────────────
    check(
      '解不出来的区间：gaveLineAddress 为真（读侧据此拒绝，而不是静默 auto）',
      UNPARSEABLE.every(([, args]) => gaveLineAddress(args) && lineRangeOf(args) === undefined),
    )
    check(
      '拒绝提示同时给出 start_line 与 lines 两种可接受写法',
      LINE_ADDRESS_HINT.includes('start_line') && LINE_ADDRESS_HINT.includes('lines'),
      LINE_ADDRESS_HINT,
    )

    // ── 模式推断（纯函数面） ─────────────────────────────────────────────────────
    const range = lineRangeOf({ start_line: 2, end_line: 4 })
    check('inferReadMode：只给行区间 → lines', inferReadMode({ start_line: 2, end_line: 4 }, range) === 'lines')
    check('inferReadMode：显式 mode 优先于行区间', inferReadMode({ mode: 'map', start_line: 2, end_line: 4 }, range) === 'map')
    check(
      'inferReadMode：空串/空白 mode 视同没给（不当成显式）',
      inferReadMode({ mode: '', start_line: 2 }, range) === 'lines' && inferReadMode({ mode: '  ', start_line: 2 }, range) === 'lines',
    )
    check(
      'inferReadMode：其它定位参数的推断顺序（around/search/changed/kind）',
      [
        [{ around: 'x' }, 'around'],
        [{ search: 'x' }, 'search'],
        [{ since: 'v1' }, 'changed'],
        [{ kind: 'function' }, 'map'],
      ].every(([args, want]) => inferReadMode(args, undefined) === want),
    )
    check('inferReadMode：什么都没有 → undefined（交给引擎 auto）', inferReadMode({}, undefined) === undefined)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('A 引擎纯函数面：读引擎的码（readWith）与写侧规划（planHunks）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const codes = OUT_OF_RANGE.map(([, args, want]) => {
      const r = readWith(SRC, { mode: 'lines', lines: asLinePair(lineRangeOf(args)) })
      return r.ok === false && r.code === want ? null : `${JSON.stringify(args)}→${r.ok === true ? 'ok' : r.code}`
    }).filter(Boolean)
    check(
      '越界/倒序在引擎里回自己的码（READ_BAD_RANGE / READ_OUT_OF_RANGE），不是 READ_NO_RANGE',
      codes.length === 0,
      codes.join(', '),
    )
    const missing = readWith(SRC, { mode: 'lines', lines: undefined })
    check(
      '对照：真的没给区间才是 READ_NO_RANGE（与上一条区分开）',
      missing.ok === false && missing.code === 'READ_NO_RANGE',
      JSON.stringify(missing),
    )
    const correct = readWith(SRC, { mode: 'lines', lines: asLinePair(lineRangeOf({ start_line: 2, end_line: 4 })) })
    check(
      '引擎侧读到的区间逐行正确',
      correct.ok === true && JSON.stringify(rowsOf(correct.text)) === JSON.stringify(rowsFor([2, 4])),
      JSON.stringify(rowsOf(correct.ok ? correct.text : '')),
    )

    // ── 写侧规划：四种 hunk 写法都必须落对行 ────────────────────────────────────
    const HUNK_SHAPES = [
      ['hunk {start_line, end_line}', { start_line: 2, end_line: 2, replace: 'EDITED-2' }, 2],
      ['hunk {lines: "3,3"}', { lines: '3,3', replace: 'EDITED-3' }, 3],
      ['hunk {lines: [4, 4]}', { lines: [4, 4], replace: 'EDITED-4' }, 4],
      ['hunk {lines: 5}', { lines: 5, replace: 'EDITED-5' }, 5],
    ]
    const hunkBad = []
    for (const [label, hunk, line] of HUNK_SHAPES) {
      try {
        const planned = planHunks(SRC, [hunk], mdPath)
        const got = planned.content.split('\n')[line - 1]
        const othersIntact = planned.content
          .split('\n')
          .every((l, i) => i === line - 1 || l === SRC.split('\n')[i])
        if (got !== hunk.replace || !othersIntact || planned.applied[0]?.line !== line) {
          hunkBad.push(`${label}: line=${planned.applied[0]?.line} got=${JSON.stringify(got)}`)
        }
      } catch (e) {
        hunkBad.push(`${label}: 抛错 ${e.code} ${e.message}`)
      }
    }
    check(`planHunks 支持全部 ${HUNK_SHAPES.length} 种 hunk 写法并落对行、不动其它行`, hunkBad.length === 0, hunkBad.join(' | '))

    // 原子性（纯函数面）：多 hunk 中一个定位不到 ⇒ 抛错，且没有任何"部分结果"泄漏出去。
    let threw = null
    try {
      planHunks(SRC, [{ lines: [1, 1], replace: 'A' }, { lines: [99, 99], replace: 'B' }], mdPath)
    } catch (e) {
      threw = e
    }
    check(
      'planHunks 多 hunk 一个失败即整体抛错，且带稳定 code',
      threw !== null && typeof threw.code === 'string' && /^(PATCH_|LOCATOR_)/.test(threw.code),
      `code=${threw?.code} msg=${String(threw?.message).slice(0, 60)}`,
    )
    check('纯函数失败无副作用：原内容未被改动', SRC === `${LINES.join('\n')}\n`)

    // 半坏 hunk 在规划层必须"没有地址可用"，而不是被当成单行
    let hunkHalfBad = null
    try {
      planHunks(SRC, [{ start_line: 2, end_line: 'x', replace: 'BAD' }], mdPath)
    } catch (e) {
      hunkHalfBad = e
    }
    check(
      '半坏 hunk（end_line 解不出来）在规划层被拒（PATCH_NO_ADDRESS），不缩成单行',
      hunkHalfBad !== null && hunkHalfBad.code === 'PATCH_NO_ADDRESS' && hunkHalfBad.message.includes('start_line'),
      `code=${hunkHalfBad?.code} msg=${String(hunkHalfBad?.message).slice(0, 60)}`,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('B DSH 工具壳面：mock ctx + apply + registered.execute')
  // ══════════════════════════════════════════════════════════════════════════
  const byName = new Map()
  let version = 1
  const editWrites = []
  const fsService = {
    resolve: async (p, opts) => ({
      displayPath: p,
      targetKey: path.isAbsolute(p) ? p : path.join(opts?.cwd ?? process.cwd(), p),
    }),
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
    readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
    editText: async (t, req) => {
      const current = fs.readFileSync(t.targetKey, 'utf8')
      const n = current.split(req.oldString).length - 1
      if (n === 0) throw Object.assign(new Error('old_string was not found'), { code: 'FS_EDIT_NOT_FOUND' })
      if (n > 1) throw Object.assign(new Error(`old_string matched ${n} times`), { code: 'FS_AMBIGUOUS_EDIT' })
      const next = current.split(req.oldString).join(req.newString)
      fs.writeFileSync(t.targetKey, next, 'utf8')
      version += 1
      editWrites.push(next)
      return { version: `v${version}`, operation: 'update', before: current, after: next }
    },
    writeText: async (t, content, expected) => {
      const existed = fs.existsSync(t.targetKey)
      if (expected?.kind === 'replaceIfVersion') {
        if (!existed) throw Object.assign(new Error('file no longer exists'), { code: 'FS_STALE_VERSION' })
        if (`v${version}` !== expected.version) throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      } else if (expected?.kind === 'createIfAbsent' && existed) {
        throw Object.assign(new Error('cannot overwrite existing file without reading it first'), { code: 'FS_NOT_OBSERVED' })
      }
      fs.writeFileSync(t.targetKey, content, 'utf8')
      version += 1
      editWrites.push(content)
      return { version: `v${version}`, operation: existed ? 'update' : 'create', after: content }
    },
  }
  const ctx = {
    fs: fsService,
    // inject / get 必须在场（缺一个成员就是缺一条被测路径——见 mock-ctx.mjs 的教训）
    ...contextServices(),
    tools: { register: (t) => byName.set(t.name, t) },
    emit: () => {},
    systemPrompt: { section: () => () => {} },
    // 新鲜度/意图策略在场但拒绝：验证"策略失败不阻断、由锚点自己把关"的设计
    waterfall: async () => {
      throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
    },
  }
  applyRead(ctx)
  editPlugin.apply(ctx)
  const registered = new Map(byName)
  // Public surface is read+apply; the flat/schema matrix below still targets the legacy edit
  // descriptor through the test seam.
  byName.set('aura_basetools_edit', editPlugin.lastLegacyTools.edit)
  const read = registered.get('aura_basetools_read')
  const apply = registered.get('aura_basetools_apply')
  const edit = byName.get('aura_basetools_edit')
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  // 宿主要校验的参数里一定带 file_path（它是必填），所以校验形状时要把它补上——
  // 少了它就是"必填缺失"，13 种形状会一起红，而那不是形状的问题。
  const asHostArgs = (extra) => ({ file_path: mdPath, ...extra })

  check('apply 注册出 aura_basetools_read 与 aura_basetools_apply', read !== undefined && apply !== undefined, [...registered.keys()].join(','))

  // ── 声明层：宿主会在注册期与 execute 之前拿这份 schema 把关 ─────────────────────
  {
    const readSchema = read.parameters
    const hunkSchema = edit.parameters.properties.hunks.items
    // 三份 schema 都要走一遍：注册期被拒是整个工具消失，不是某条路径失败。
    const schemaShapes = [...unsupportedSchema(readSchema, 'read.parameters'), ...unsupportedSchema(edit.parameters, 'edit.parameters'), ...unsupportedSchema(read.output.schema, 'read.output')]
    check('注册的 schema 无宿主不认的形状（根以下的 object 节点都显式声明 additionalProperties）', schemaShapes.length === 0, schemaShapes.join('; '))
    check(
      'read 声明了 start_line / end_line（integer）',
      readSchema.properties.start_line?.type === 'integer' && readSchema.properties.end_line?.type === 'integer',
      JSON.stringify([readSchema.properties.start_line?.type, readSchema.properties.end_line?.type]),
    )
    check(
      'read 的 lines 是四支 oneOf（array / string / integer / object）',
      JSON.stringify((readSchema.properties.lines?.oneOf ?? []).map((b) => b.type)) === '["array","string","integer","object"]',
      JSON.stringify(readSchema.properties.lines?.oneOf),
    )
    check(
      'hunk 也声明了 start_line / end_line / lines（同两份字段）',
      hunkSchema.properties.start_line?.type === 'integer' &&
        hunkSchema.properties.end_line?.type === 'integer' &&
        JSON.stringify((hunkSchema.properties.lines?.oneOf ?? []).map((b) => b.type)) === '["array","string","integer","object"]',
    )
    // 宿主只会放行"声明过 + 校验得过"的参数；形状矩阵若过不了声明层，B 面测的就是别的东西。
    const rejected = SHAPES.filter(([, args]) => hostViolations(asHostArgs(args), readSchema, 'args').length > 0)
    check(
      `形状矩阵全部通过宿主参数校验（${SHAPES.length} 种都能到 execute）`,
      rejected.length === 0,
      rejected.map(([l]) => l).join(', '),
    )
    // 半坏输入的落点由声明决定：end_line 声明成 integer ⇒ 宿主当场拒；塞进 object 分支 ⇒ 到引擎。
    const routed = HALF_BAD.map(([, args]) => hostViolations(asHostArgs(args), readSchema).length > 0)
    check(
      '半坏输入的拦截层与声明一致（end_line: "abc" 被宿主拒，其余到引擎）',
      JSON.stringify(routed) === '[false,false,false,true]',
      JSON.stringify(routed),
    )
    // 框架对返回值额外要求可无损 JSON 往返（`undefined` 会在序列化里消失——这正是历史上
    // "version 在某些模式下是 undefined" 那类事故的形态）。schema 自己也得过这一关。
    check(
      'schema 可无损 JSON 往返（没有 undefined 会被序列化吃掉）',
      [read.parameters, read.output.schema, edit.parameters].every((s) => JSON.stringify(JSON.parse(JSON.stringify(s))) === JSON.stringify(s)),
    )
  }

  // ── 行为层：形状矩阵 ────────────────────────────────────────────────────────
  {
    const bad = []
    for (const [label, extra] of SHAPES) {
      let value
      try {
        value = await read.execute({ file_path: mdPath, ...extra }, exec)
      } catch (e) {
        bad.push(`${label}: 抛错 ${codeOf(e)}`)
        continue
      }
      const want = rowsFor(SHAPES.find((s) => s[0] === label)[2])
      if (value.mode !== 'lines') bad.push(`${label}: mode=${value.mode}`)
      else if (JSON.stringify(rowsOf(value.text)) !== JSON.stringify(want)) {
        bad.push(`${label}: rows=${JSON.stringify(rowsOf(value.text))} want=${JSON.stringify(want)}`)
      }
    }
    check(`B 面：${SHAPES.length} 种写法都 ok 且 mode=lines，且逐行读到正确区间`, bad.length === 0, bad.join(' | '))
  }

  // ── 行为层：模式推断 ────────────────────────────────────────────────────────
  {
    const implied = await read.execute({ file_path: mdPath, start_line: 2, end_line: 4 }, exec)
    check('B 面：不传 mode、只给行区间 → lines（且区间正确）', implied.mode === 'lines' && JSON.stringify(rowsOf(implied.text)) === JSON.stringify(rowsFor([2, 4])), `mode=${implied.mode}`)
    const explicit = await read.execute({ file_path: mdPath, mode: 'map', start_line: 2, end_line: 4 }, exec)
    check('B 面：显式 mode=map + 行区间 → map（显式优先）', explicit.mode === 'map', `mode=${explicit.mode}`)
    const explicitFull = await read.execute({ file_path: mdPath, mode: 'full', start_line: 2, end_line: 4 }, exec)
    check('B 面：显式 mode=full + 行区间 → full（不被行区间劫持）', explicitFull.mode === 'full', `mode=${explicitFull.mode}`)
  }

  // ── 行为层：明确拒绝而不是静默 ──────────────────────────────────────────────
  {
    const bad = []
    for (const [label, extra] of UNPARSEABLE) {
      let e = null
      try {
        await read.execute({ file_path: mdPath, ...extra }, exec)
      } catch (err) {
        e = err
      }
      if (e === null) bad.push(`${label}: 没拒绝（静默成功了）`)
      // 两条都算"结构化拒绝"：宿主 schema 先拦（INVALID_ARGS），或引擎拦（提示语）。
      // 但**只要参数对象到了引擎**，提示语就必须同时给出 start_line 与 lines 两种写法。
      else if (e.code === 'INVALID_ARGS') continue
      else if (!(String(e.message).includes('start_line') && String(e.message).includes('lines'))) {
        bad.push(`${label}: 拒绝信息没说清可接受写法 → ${String(e.message).slice(0, 60)}`)
      }
    }
    check(`B 面：${UNPARSEABLE.length} 种解不出来的区间全部结构化拒绝`, bad.length === 0, bad.join(' | '))

    // 到引擎的那几种，拒绝语必须是**逐字**的收敛层提示：壳若自己改写一句，模型就看不到
    // "接受哪些写法"——而那正是本条要防的（只说"参数不对"等于没说）。
    const hintBad = []
    for (const [label, extra] of UNPARSEABLE) {
      if (hostViolations(asHostArgs(extra), read.parameters).length > 0) continue // 宿主先拦的：上面已断
      let msg = null
      try {
        await read.execute({ file_path: mdPath, ...extra }, exec)
      } catch (e) {
        msg = String(e.message)
      }
      if (msg !== LINE_ADDRESS_HINT) hintBad.push(`${label}: ${JSON.stringify(msg ?? '(没拒绝)').slice(0, 60)}`)
    }
    check('B 面：到引擎的拒绝语与收敛层提示逐字一致（同时给出 start_line 与 lines）', hintBad.length === 0, hintBad.join(' | '))
  }

  // ── 行为层：半坏输入（本轮新修）──────────────────────────────────────────────
  {
    const bad = []
    for (const [label, extra, route] of HALF_BAD) {
      let e = null
      try {
        const v = await read.execute({ file_path: mdPath, ...extra }, exec)
        bad.push(`${label}: 没拒绝，反而返回 rows=${JSON.stringify(rowsOf(v.text))}（静默缩成单行）`)
      } catch (err) {
        e = err
      }
      if (e === null) continue
      if (route === 'host') {
        if (e.code !== 'INVALID_ARGS') bad.push(`${label}: 期望宿主拦（INVALID_ARGS），实际 ${codeOf(e)}`)
      } else if (e.code === 'INVALID_ARGS') {
        bad.push(`${label}: 意外被宿主拦（声明层与预期不符）`)
      } else if (!(String(e.message).includes('start_line') && String(e.message).includes('lines'))) {
        bad.push(`${label}: 拒绝信息没说清可接受写法 → ${String(e.message).slice(0, 50)}`)
      }
    }
    check(`B 面：${HALF_BAD.length} 种半坏区间全部结构化拒绝（不缩成单行）`, bad.length === 0, bad.join(' | '))

    const single = await read.execute({ file_path: mdPath, lines: [2] }, exec)
    const onlyStart = await read.execute({ file_path: mdPath, start_line: 3 }, exec)
    const objStart = await read.execute({ file_path: mdPath, lines: { start: 4 } }, exec)
    check(
      'B 面：单元素 / 只给起点仍然合法，且正好读那一行',
      JSON.stringify(rowsOf(single.text)) === JSON.stringify(rowsFor([2, 2])) &&
        JSON.stringify(rowsOf(onlyStart.text)) === JSON.stringify(rowsFor([3, 3])) &&
        JSON.stringify(rowsOf(objStart.text)) === JSON.stringify(rowsFor([4, 4])),
      JSON.stringify([rowsOf(single.text), rowsOf(onlyStart.text), rowsOf(objStart.text)]),
    )
  }

  // ── 行为层：越界与非法值不许被吃掉（断到 code）────────────────────────────────
  {
    // C3 之后这批失败走**结果通道**：回执带 outcome（not_found）、引擎的码原文、
    // 一段给模型看的 text，以及下一步 next。所以断言从"抛出时带什么码"改成"回执里读到什么"，
    // 而且不能只看"没抛"：码、三态、text、next 一个都不能少。
    const bad = []
    const shallow = []
    for (const [label, extra, want] of OUT_OF_RANGE) {
      let code = null
      let receipt = null
      try {
        receipt = await read.execute({ file_path: mdPath, ...extra }, exec)
        code = receipt.code
      } catch (e) {
        code = codeOf(e)
      }
      // 壳把引擎码原样放在回执的 `code` 上（旧契约里它被拼进 `READ_BAD_RANGE: ...` 首段）；
      // 这里断到码本身，与"缺参数"（LINE_ADDRESS_HINT / file_path must be...）严格区分开。
      if (code !== want) bad.push(`${label}: code=${code} want=${want}`)
      else if (receipt === null || receipt.outcome !== 'not_found') bad.push(`${label}: outcome=${receipt?.outcome} want=not_found`)
      else if (!String(receipt.text ?? '').includes(want) || typeof receipt.next !== 'string' || receipt.next.length === 0) {
        shallow.push(`${label}: text/next 不完整`)
      }
    }
    check(`B 面：${OUT_OF_RANGE.length} 种越界/非法区间都回引擎自己的码（不是"缺参数"）`, bad.length === 0, bad.join(' | '))
    check(
      `B 面：${OUT_OF_RANGE.length} 种都在结果通道里给全 outcome=not_found + text 带码 + next`,
      shallow.length === 0,
      shallow.join(' | '),
    )
  }

  // ── 行为层：hunk 的四种写法 + 原子失败 ──────────────────────────────────────
  {
    const file = path.join(tmp, 'b-hunks.md')
    const cases = [
      ['hunk {start_line, end_line}', { start_line: 2, end_line: 2, replace: 'EDIT-2' }, 2],
      ['hunk {lines: "3,3"}', { lines: '3,3', replace: 'EDIT-3' }, 3],
      ['hunk {lines: [4, 4]}', { lines: [4, 4], replace: 'EDIT-4' }, 4],
      ['hunk {lines: 5}', { lines: 5, replace: 'EDIT-5' }, 5],
    ]
    const bad = []
    for (const [label, hunk, line] of cases) {
      fs.writeFileSync(file, SRC, 'utf8')
      version += 1
      try {
        const out = await edit.execute({ file_path: file, hunks: [hunk] }, exec)
        const disk = fs.readFileSync(file, 'utf8').split('\n')
        if (out.applied.length !== 1) bad.push(`${label}: applied=${out.applied.length}`)
        else if (disk[line - 1] !== hunk.replace) bad.push(`${label}: 第${line}行=${JSON.stringify(disk[line - 1])}`)
        else if (disk.filter((l, i) => i !== line - 1 && l !== SRC.split('\n')[i]).length > 0) bad.push(`${label}: 动了别的行`)
      } catch (e) {
        bad.push(`${label}: 抛错 ${codeOf(e)}`)
      }
    }
    check(`B 面：hunk 的 ${cases.length} 种写法都能定位并正确落盘`, bad.length === 0, bad.join(' | '))

    // 原子失败 1：多 hunk 中一个定位不到 —— 判定不出意图 ⇒ 走结果通道（C3），
    // 但"整体中止"这条事务语义不变：`applied` 必须是**空数组**（结构上可读），
    // 而不是靠"回执里没有 applied 字段"这种要靠猜的形状。
    fs.writeFileSync(file, SRC, 'utf8')
    version += 1
    const beforeBytes = fs.readFileSync(file)
    let threw = null
    let txn = null
    try {
      txn = await edit.execute({ file_path: file, hunks: [{ lines: [1, 1], replace: 'A' }, { lines: [99, 99], replace: 'B' }] }, exec)
    } catch (e) {
      threw = e
    }
    check(
      'B 面：多 hunk 一个定位失败 ⇒ 结果通道里带回引擎的码',
      threw === null && typeof txn?.code === 'string' && /^(PATCH_|LOCATOR_)/.test(txn.code),
      `threw=${threw?.code} code=${txn?.code} msg=${String(txn?.message).slice(0, 60)}`,
    )
    check(
      'B 面：整体事务语义不变 —— outcome=not_found 且 applied 为空数组',
      txn?.outcome === 'not_found' && Array.isArray(txn.applied) && txn.applied.length === 0,
      `outcome=${txn?.outcome} applied=${JSON.stringify(txn?.applied ?? null)}`,
    )
    check('B 面：失败后文件字节完全不变', Buffer.compare(beforeBytes, fs.readFileSync(file)) === 0, fs.readFileSync(file, 'utf8').slice(0, 40))

    // 原子失败 2：半坏 hunk（end_line 解不出来）——本轮新修的那类
    const beforeHalf = fs.readFileSync(file)
    let halfThrew = null
    try {
      await edit.execute({ file_path: file, hunks: [{ start_line: 2, end_line: 'x', replace: 'BAD' }] }, exec)
    } catch (e) {
      halfThrew = e
    }
    check(
      'B 面：半坏 hunk（end_line: "x"）被拒，不静默改成"只改第 2 行"',
      halfThrew !== null,
      `没拒绝，文件=${JSON.stringify(fs.readFileSync(file, 'utf8'))}`,
    )
    check('B 面：半坏 hunk 被拒后文件字节完全不变', Buffer.compare(beforeHalf, fs.readFileSync(file)) === 0)
  }

  // ── 行为层：坏参数矩阵（钉住已有行为）────────────────────────────────────────
  {
    const cases = [
      ['参数名写成 file（应为 file_path）', () => read.execute({ file: mdPath, mode: 'map' }, exec), (e) => String(e.message).includes('file_path')],
      ['mode 写错（outline）', () => read.execute({ file_path: mdPath, mode: 'outline' }, exec), (e) => codeOf(e) === 'READ_BAD_MODE'],
      ['文件不存在', () => read.execute({ file_path: path.join(tmp, 'nope.md'), mode: 'map' }, exec), (e) => String(e.message).includes('not found')],
      ['hunks 不是数组', () => edit.execute({ file_path: mdPath, hunks: 'nope' }, exec), (e) => String(e.message).includes('hunks')],
      ['hunk 字段名写错（line 而非 lines）', () => edit.execute({ file_path: mdPath, hunks: [{ line: 2, replace: 'x' }] }, exec), (e) => /PATCH_|INVALID_ARGS/.test(String(codeOf(e)))],
    ]
    const bad = []
    for (const [label, run, ok] of cases) {
      let e = null
      try {
        await run()
      } catch (err) {
        e = err
      }
      if (e === null) bad.push(`${label}: 没拒绝`)
      else if (!ok(e)) bad.push(`${label}: code=${codeOf(e)} msg=${String(e.message).slice(0, 50)}`)
    }
    check(`B 面：${cases.length} 种坏参数全部被拒且说明原因`, bad.length === 0, bad.join(' | '))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('C 独立面：dist 产物（MCP）')
  // ══════════════════════════════════════════════════════════════════════════
  const mcpPath = path.join(tmp, 'c-mcp.md')
  fs.writeFileSync(mcpPath, SRC, 'utf8')
  /** 一次性把所有帧喂进去（spawnSync 的 input），一次进程启动覆盖一组场景。 */
  const mcpRun = (calls) => {
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      ...calls,
    ]
    // `timeout` 不是可选的：本组正好在测"服务会不会挂死"，若它真的挂死而这里没有超时，
    // 靶场自己会永久挂住——那就从"测出缺陷"变成了"变成缺陷"。超时后 stdout 是残缺的，
    // 回包数断言会直接变红，这正是想要的结果。
    const res = spawnSync(process.execPath, [mcpBin], {
      input: `${frames.map((x) => JSON.stringify(x)).join('\n')}\n`,
      encoding: 'utf8',
      env,
      timeout: 60000,
    })
    const replies = res.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const byId = new Map(replies.map((r) => [r.id, r]))
    return {
      replies,
      res,
      // initialize 也要回一帧（notifications/initialized 是通知，不回）——
      // 期望值按"帧数 + 1"算，别写死，否则收全了也会判红。
      expected: calls.length + 1,
      envOf: (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}'),
    }
  }
  const readCall = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: args } })
  const editCall = (id, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: args } })

  check('dist 产物存在（CLI + MCP）', fs.existsSync(bin) && fs.existsSync(mcpBin), `${bin} / ${mcpBin}`)
  {
    // 形状矩阵 + 模式推断，一次喂完
    const calls = []
    let id = 10
    const ids = new Map()
    for (const [label, extra] of SHAPES) {
      calls.push(readCall(id, { file_path: mcpPath, ...extra }))
      ids.set(label, id)
      id += 1
    }
    const impliedId = id++
    calls.push(readCall(impliedId, { file_path: mcpPath, start_line: 2, end_line: 4 }))
    const explicitId = id++
    calls.push(readCall(explicitId, { file_path: mcpPath, mode: 'map', start_line: 2, end_line: 4 }))
    const { replies, envOf, expected } = mcpRun(calls)
    check(`C 面 MCP：${calls.length} 条请求全部有回包`, replies.length === expected, `收到 ${replies.length}，期望 ${expected}`)
    const bad = []
    for (const [label, , want] of SHAPES) {
      const env2 = envOf(ids.get(label))
      if (env2.ok !== true) bad.push(`${label}: ok=${env2.ok} code=${env2.code}`)
      else if (env2.mode !== 'lines') bad.push(`${label}: mode=${env2.mode}`)
      else if (JSON.stringify(rowsOf(env2.text)) !== JSON.stringify(rowsFor(want))) {
        bad.push(`${label}: rows=${JSON.stringify(rowsOf(env2.text))}`)
      }
    }
    check(`C 面 MCP：${SHAPES.length} 种写法都 ok 且 mode=lines，且逐行读到正确区间`, bad.length === 0, bad.join(' | '))
    const implied = envOf(impliedId)
    check('C 面 MCP：不传 mode、只给行区间 → lines', implied.ok === true && implied.mode === 'lines', JSON.stringify(implied).slice(0, 80))
    const explicit = envOf(explicitId)
    check('C 面 MCP：显式 mode=map + 行区间 → map（显式优先）', explicit.ok === true && explicit.mode === 'map', `mode=${explicit.mode}`)
  }

  {
    // 解不出来的区间 + 越界：都要结构化拒绝并断到 code
    const calls = []
    let id = 40
    const ids = new Map()
    for (const [label, extra] of UNPARSEABLE) {
      calls.push(readCall(id, { file_path: mcpPath, ...extra }))
      ids.set(label, id)
      id += 1
    }
    for (const [label, extra] of OUT_OF_RANGE) {
      calls.push(readCall(id, { file_path: mcpPath, ...extra }))
      ids.set(label, id)
      id += 1
    }
    const { replies, envOf, expected } = mcpRun(calls)
    check(`C 面 MCP：${calls.length} 条负向请求全部有回包`, replies.length === expected, `收到 ${replies.length}，期望 ${expected}`)
    const bad = []
    for (const [label] of UNPARSEABLE) {
      const env2 = envOf(ids.get(label))
      if (env2.ok !== false) bad.push(`${label}: ok=${env2.ok}（静默成功）`)
      else if (!String(env2.error ?? '').includes('start_line') || !String(env2.error ?? '').includes('lines')) {
        bad.push(`${label}: 没说清可接受写法 → ${String(env2.error).slice(0, 50)}`)
      }
    }
    check(`C 面 MCP：${UNPARSEABLE.length} 种解不出来的区间结构化拒绝，且给出可接受写法`, bad.length === 0, bad.join(' | '))
    const badRange = []
    for (const [label, , want] of OUT_OF_RANGE) {
      const env2 = envOf(ids.get(label))
      if (env2.ok !== false || env2.code !== want) badRange.push(`${label}: ok=${env2.ok} code=${env2.code} want=${want}`)
    }
    check(`C 面 MCP：${OUT_OF_RANGE.length} 种越界/非法区间回引擎自己的码（不是缺参数）`, badRange.length === 0, badRange.join(' | '))
  }

  {
    // 半坏输入：源码面已修；产物是否带上这条修复，由**这里**回答（产物落后 = 缺口，不是本靶场红）
    const calls = HALF_BAD.map(([, extra], i) => readCall(50 + i, { file_path: mcpPath, ...extra }))
    calls.push(readCall(60, { file_path: mcpPath, lines: [2] }))
    calls.push(readCall(61, { file_path: mcpPath, start_line: 3 }))
    const { envOf } = mcpRun(calls)
    const collapsed = []
    HALF_BAD.forEach(([label], i) => {
      const env2 = envOf(50 + i)
      if (env2.ok === true) collapsed.push(`${label} → 返回 rows=${JSON.stringify(rowsOf(env2.text))}（静默缩成单行）`)
    })
    check(
      'C 面 MCP：单元素 / 只给起点仍然成功且正好读那一行',
      JSON.stringify(rowsOf(envOf(60).text)) === JSON.stringify(rowsFor([2, 2])) && JSON.stringify(rowsOf(envOf(61).text)) === JSON.stringify(rowsFor([3, 3])),
      JSON.stringify([rowsOf(envOf(60).text), rowsOf(envOf(61).text)]),
    )
    if (collapsed.length === 0) {
      check(`C 面 MCP：${HALF_BAD.length} 种半坏区间结构化拒绝（不缩成单行）`, true)
    } else {
      gap(
        `dist 产物（0.4.1）未包含 args.mjs 的"半坏末端必须拒绝"修复：${collapsed.length}/${HALF_BAD.length} 种被静默缩成单行`,
        `复现：node dist/aura-basetools/bin/aura-mcp.mjs ← tools/call aura_basetools_read {file_path, lines:[2,"abc"]}；期望 code=READ_BAD_ARGS 的拒绝，实际 ${collapsed[0]}`,
      )
    }
  }

  {
    // hunk 四种写法：一次进程里顺序改四行，最后一次性看盘面。
    // 刻意**不**把失败帧混在这一轮——失败帧会改掉盘面，让"四种写法都落对了"这条断言
    // 测到的是别的东西（第一版就这么错过：半坏帧把第 2 行写成 BAD，四种写法反而被判红）。
    const ePath = path.join(tmp, 'c-hunks.md')
    const shapes = [
      ['{start_line, end_line}', { start_line: 2, end_line: 2, replace: 'EDIT-2' }, 2],
      ['{lines: "3,3"}', { lines: '3,3', replace: 'EDIT-3' }, 3],
      ['{lines: [4, 4]}', { lines: [4, 4], replace: 'EDIT-4' }, 4],
      ['{lines: 5}', { lines: 5, replace: 'EDIT-5' }, 5],
    ]
    const ids = new Map()
    const calls = shapes.map(([label, hunk], i) => {
      ids.set(label, 70 + i)
      return editCall(70 + i, { file_path: ePath, hunks: [hunk] })
    })
    fs.writeFileSync(ePath, SRC, 'utf8')
    const { envOf } = mcpRun(calls)
    const expectedSrc = SRC.split('\n')
    for (const [, hunk, line] of shapes) expectedSrc[line - 1] = hunk.replace
    const bad = []
    for (const [label, hunk, line] of shapes) {
      const env2 = envOf(ids.get(label))
      if (env2.ok !== true) bad.push(`${label}: ok=${env2.ok} code=${env2.code}`)
      else if (fs.readFileSync(ePath, 'utf8').split('\n')[line - 1] !== hunk.replace) bad.push(`${label}: 第${line}行未落盘`)
    }
    check(
      `C 面 MCP：hunk 的 ${shapes.length} 种写法都能定位并正确落盘`,
      bad.length === 0 && fs.readFileSync(ePath, 'utf8') === expectedSrc.join('\n'),
      bad.length > 0 ? bad.join(' | ') : JSON.stringify(fs.readFileSync(ePath, 'utf8')),
    )
  }

  {
    // 原子失败：多 hunk 中一个定位不到。**单独一轮进程**——盘面有没有被第一个 hunk 改掉，
    // 只能在没有后续帧干扰时回答。
    const ePath = path.join(tmp, 'c-atomic.md')
    fs.writeFileSync(ePath, SRC, 'utf8')
    const before = fs.readFileSync(ePath)
    const { envOf } = mcpRun([editCall(80, { file_path: ePath, hunks: [{ lines: [1, 1], replace: 'A' }, { lines: [99, 99], replace: 'B' }] })])
    const atomic = envOf(80)
    check(
      'C 面 MCP：多 hunk 一个定位失败 ⇒ 结构化失败且带 code',
      atomic.ok === false && /^(PATCH_|LOCATOR_)/.test(String(atomic.code)),
      `ok=${atomic.ok} code=${atomic.code}`,
    )
    check('C 面 MCP：原子失败后文件字节完全不变', Buffer.compare(before, fs.readFileSync(ePath)) === 0, JSON.stringify(fs.readFileSync(ePath, 'utf8')).slice(0, 50))
  }

  {
    // 半坏 hunk（本轮新修）：同样单独一轮，才能断言"被拒 + 字节不变"。
    const ePath = path.join(tmp, 'c-halfhunk.md')
    fs.writeFileSync(ePath, SRC, 'utf8')
    const before = fs.readFileSync(ePath)
    const { envOf } = mcpRun([editCall(81, { file_path: ePath, hunks: [{ start_line: 2, end_line: 'x', replace: 'BAD' }] })])
    const halfEdit = envOf(81)
    if (halfEdit.ok === false) {
      check(
        'C 面 MCP：半坏 hunk 被拒且文件字节不变',
        Buffer.compare(before, fs.readFileSync(ePath)) === 0,
        `code=${halfEdit.code} 盘面=${JSON.stringify(fs.readFileSync(ePath, 'utf8')).slice(0, 50)}`,
      )
    } else {
      gap(
        'dist 产物（0.4.1）的 hunk 半坏区间被静默缩成"只改第 2 行"（源码面已修）',
        `复现：aura_basetools_edit {file_path, hunks:[{start_line:2, end_line:"x", replace:"BAD"}]}；期望 ok=false，实际 ok=true 且盘面=${JSON.stringify(fs.readFileSync(ePath, 'utf8'))}`,
      )
    }
  }

  {
    // arguments 容错：JSON 字符串能用、解不开的字符串/数组回 BAD_ARGS、服务仍在
    const calls = [
      { jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: JSON.stringify({ file_path: mcpPath, start_line: 2, end_line: 4 }) } },
      { jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: '不是 JSON' } },
      { jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: [1, 2, 3] } },
      { jsonrpc: '2.0', id: 93, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: JSON.stringify({ file_path: mcpPath, lines: [3, 3] }) } },
    ]
    const { replies, envOf, res, expected } = mcpRun(calls)
    check('C 面 MCP：4 条请求全部有回包', replies.length === expected, `收到 ${replies.length}，期望 ${expected}`)
    const asString = envOf(90)
    check(
      'C 面 MCP：arguments 整体是 JSON 字符串时能用（且行区间生效）',
      asString.ok === true && asString.mode === 'lines' && JSON.stringify(rowsOf(asString.text)) === JSON.stringify(rowsFor([2, 4])),
      JSON.stringify(asString).slice(0, 100),
    )
    check('C 面 MCP：arguments 解不开的字符串 → BAD_ARGS', envOf(91).ok === false && envOf(91).code === 'BAD_ARGS', JSON.stringify(envOf(91)).slice(0, 90))
    check('C 面 MCP：arguments 是数组 → BAD_ARGS', envOf(92).ok === false && envOf(92).code === 'BAD_ARGS', JSON.stringify(envOf(92)).slice(0, 90))
    check(
      'C 面 MCP：两次坏 arguments 之后服务仍在（后续正常调用依旧成功）',
      envOf(93).ok === true && JSON.stringify(rowsOf(envOf(93).text)) === JSON.stringify(rowsFor([3, 3])),
      JSON.stringify(envOf(93)).slice(0, 90),
    )
    check('C 面 MCP：坏参数不靠 stderr 兜底（不用抛出当回包）', res.stderr.trim() === '', res.stderr.trim().slice(0, 80))
  }

  {
    // 坏输入矩阵：每种都要有回包与 code
    const calls = [
      readCall(100, { file: mcpPath, mode: 'map' }),
      readCall(101, { file_path: mcpPath, mode: 'outline' }),
      readCall(102, { file_path: path.join(tmp, 'nope.md'), mode: 'map' }),
      editCall(103, { file_path: mcpPath, hunks: 'nope' }),
      { jsonrpc: '2.0', id: 104, method: 'tools/call', params: { name: 'aura_nope', arguments: {} } },
      readCall(105, { file_path: mcpPath, start_line: 2, end_line: 4 }),
    ]
    const { replies, envOf, expected } = mcpRun(calls)
    check('C 面 MCP：6 条坏输入全部有回包', replies.length === expected, `收到 ${replies.length}，期望 ${expected}`)
    const want = [
      [100, 'ARGS_UNKNOWN_KEY', '参数名写成 file'],
      [101, 'READ_BAD_MODE', 'mode 写错'],
      [102, 'FS_NOT_FOUND', '文件不存在'],
      [103, 'BAD_ARGS', 'hunks 不是数组'],
      [104, 'UNKNOWN_TOOL', '未知工具'],
    ]
    const bad = want.filter(([id, code]) => envOf(id).ok !== false || envOf(id).code !== code).map(([id, code, label]) => `${label}: code=${envOf(id).code} want=${code}`)
    check('C 面 MCP：5 种坏输入各自的 code 都被钉住', bad.length === 0, bad.join(' | '))
    check('C 面 MCP：连着 5 次坏输入之后，正常调用仍然可用', envOf(105).ok === true && envOf(105).mode === 'lines', JSON.stringify(envOf(105)).slice(0, 80))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('C 独立面：dist 产物（CLI）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const cliPath = path.join(tmp, 'c-cli.md')
    fs.writeFileSync(cliPath, SRC, 'utf8')
    const run = (args) => {
      const res = spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env, timeout: 60000 })
      const line = res.stdout.trim().split('\n').filter(Boolean).pop()
      let json
      try {
        json = JSON.parse(line)
      } catch {
        json = { ok: false, error: `stdout 不是 JSON：${JSON.stringify(res.stdout)} ${String(res.stderr ?? '').slice(0, 120)}` }
      }
      return { json, status: res.status }
    }
    const versionRun = run(['--version'])
    check(`dist 产物版本可读（${versionRun.json.version}）`, versionRun.json.ok === true && typeof versionRun.json.version === 'string')

    const comma = run(['basetools', 'read', '--file', cliPath, '--lines', '2,4'])
    check(
      'C 面 CLI：--lines "2,4" 读到正确区间且 mode=lines',
      comma.json.ok === true && comma.json.mode === 'lines' && JSON.stringify(rowsOf(comma.json.text)) === JSON.stringify(rowsFor([2, 4])),
      JSON.stringify(comma.json).slice(0, 110),
    )

    const editCli = run(['basetools', 'edit', '--file', cliPath, '--hunks', JSON.stringify([{ start_line: 6, end_line: 6, replace: 'CLI-EDIT' }])])
    check(
      'C 面 CLI：hunk 用 start_line/end_line 能定位并落盘',
      editCli.json.ok === true && fs.readFileSync(cliPath, 'utf8').split('\n')[5] === 'CLI-EDIT',
      JSON.stringify(editCli.json).slice(0, 110),
    )

    // CLI 是旗标面：行区间只有 `--lines a,b` 一种写法，而**写坏时它不拒绝、只是静默丢掉**。
    // 这与"明确拒绝而不是静默"是同一个判据，所以按缺口记账而不是放它过去。
    const silent = [
      ['--lines "2-4"', ['basetools', 'read', '--file', cliPath, '--lines', '2-4']],
      ['--lines "从第2行到第3行"', ['basetools', 'read', '--file', cliPath, '--lines', '从第2行到第3行']],
      ['--start-line 2 --end-line 4', ['basetools', 'read', '--file', cliPath, '--start-line', '2', '--end-line', '4']],
    ].map(([label, args]) => {
      const r = run(args)
      return { label, mode: r.json.mode, ok: r.json.ok, code: r.json.code }
    })
    const ignored = silent.filter((s) => s.ok === true && s.mode !== 'lines')
    if (ignored.length === 0) {
      check('C 面 CLI：行区间写法写坏时不静默（要么拒绝、要么当成 lines）', true)
    } else {
      gap(
        `dist CLI（0.4.1）把行区间写坏时静默退回 auto（${ignored.length}/3 种）：${ignored.map((s) => `${s.label}→mode=${s.mode}`).join('、')}`,
        '复现：node dist/aura-basetools/bin/aura.mjs read --file F --lines "2-4"；期望结构化拒绝（给 start_line/lines 提示）或当成 lines，' +
          `实际 ok=true mode=${ignored[0].mode}。dist 的 aura.mjs 还在用 ^\\d+\\s*,\\s*\\d+$ 预筛，落空即 lines=undefined，` +
          '收敛层因此看不到"调用方给过行区间"，也没有 --start-line/--end-line 旗标（见下方源码 CLI 对照）',
      )
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('C 面补充：源码 CLI（把"缺口在源码还是在产物"分开）')
  // ══════════════════════════════════════════════════════════════════════════
  // 上面那条 CLI 缺口必须回答一件事：是入口的实现漏了，还是只怪产物没重建？
  // 两者后续动作完全不同（改代码 vs 重新打包）。
  //
  // 只能**静态**查：`src/aura-standalone/` 是按构建后的**扁平布局**写的（`lib/ops.mjs` import
  // `../locator-lab/read-core.mjs`），在 src 布局下必然 ERR_MODULE_NOT_FOUND——实测：
  //   node src/aura-standalone/bin/aura.mjs --version
  //   → Cannot find module '...\src\aura-standalone\locator-lab\read-core.mjs'
  // 所以运行时行为由 dist 面覆盖，这里只断言"源码确实把行区间原样交给了收敛层"。
  {
    const srcCli = fs.readFileSync(path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs'), 'utf8')
    const passes = {
      lines: /lines:\s*flag\('lines'\)/.test(srcCli),
      start: /start_line:\s*flag\('start-line'\)/.test(srcCli),
      end: /end_line:\s*flag\('end-line'\)/.test(srcCli),
    }
    check(
      '源码 CLI：lines / start_line / end_line 三个键都原样透传给收敛层',
      Object.values(passes).every(Boolean),
      JSON.stringify(passes),
    )
    // 旧写法是在入口自己用正则挑 `a,b`，落空即把 lines 丢掉——那正是"静默换语义"的来源。
    check('源码 CLI：不再在入口自己预筛行区间（旧写法 linesRaw 已消失）', !srcCli.includes('linesRaw'), srcCli.match(/.*linesRaw.*/)?.[0]?.trim().slice(0, 80) ?? '')
  }


  // ══════════════════════════════════════════════════════════════════════════
  section('收尾')
  // ══════════════════════════════════════════════════════════════════════════
  const homeCacheAfter = fs.existsSync(homeCache) ? fs.readdirSync(homeCache).sort().join(',') : null
  check('观测缓存没有落到 ~/.aura（三面都走 AURA_CACHE_DIR）', homeCacheAfter === homeCacheBefore, `${homeCacheBefore} → ${homeCacheAfter}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  check('临时目录已清理（不留残留）', !fs.existsSync(tmp), tmp)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (gaps.length > 0) {
  say('')
  say(`--- 产品缺口 ${gaps.length} 项（已核实，未计入通过数；详见报告）---`)
  for (const g of gaps) say(`  ⚠ ${g.label}`)
}
say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
process.exit(fail === 0 ? 0 : 1)
