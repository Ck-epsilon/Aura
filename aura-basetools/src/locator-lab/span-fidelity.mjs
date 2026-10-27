/**
 * span-fidelity —— 符号跨度保真：跨度必须覆盖符号**真实占据的整段**。
 *
 * 为什么单独一个文件盯这件事：这条性质此前没有任何测试在看。`struct-test` 验"符号被识别"、
 * `corpus-test` 验"不崩 / 不撒野"，两者都不看末端行。而跨度偏短的后果是**静默**的：
 * 缩进型语言的符号跨度只有签名行，于是 `aura_basetools_edit target=<函数名>` 只换掉签名、
 * 旧函数体原样留在文件里，`python -m py_compile` 仍然返回 0——没有任何错误信号。
 *
 * 三段：
 *   A. 每个多行函数的符号末行 == 函数体闭合行（缩进型语言与花括号语言同一把尺子）
 *   B. 跨度无法可靠判定时必须 fail-closed：结构化拒绝 + 磁盘不变
 *   C. 修复的实测后果：`target=` 真的整段替换，旧函数体不残留
 *
 * 夹具的期望跨度是**手写**的（不是从实现里回读的），否则测试只是在复述实现。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { indexStructure, langOf } from './struct-core.mjs'
import { locate } from './locator-api.mjs'
import { contextServices } from './mock-ctx.mjs'
// 1.0.2 覆盖闸：整段替换要落在交付过的正文上。本套件只验跨度，读侧用引擎那一份记账即可。
import { readWith } from './read-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

/**
 * A 段夹具。`span` 是**手写的** [起始行, 末行]：
 * 末行必须是该符号块体的闭合行（`}` / `end` / 函数体内最后一条语句所在行）。
 */
const FIXTURES = [
  {
    ext: 'py', symbol: 'alpha', span: [2, 6],
    lines: ['# alpha', 'def alpha(a):', '    x = 1', '    if a:', '        return x', '    return 0', '', 'def beta():', '    pass'],
  },
  {
    ext: 'py', symbol: 'beta', span: [8, 9],
    lines: ['# alpha', 'def alpha(a):', '    x = 1', '    if a:', '        return x', '    return 0', '', 'def beta():', '    pass'],
  },
  {
    ext: 'pyx', symbol: 'beta', span: [2, 6],
    lines: ['# alpha', 'cpdef beta(int a):', '    x = 1', '    if a:', '        return x', '    return 0'],
  },
  {
    ext: 'rb', symbol: 'alpha', span: [2, 8],
    lines: ['# alpha', 'def alpha(a)', '  x = 1', '  if a', '    return x', '  end', '  return 0', 'end', '', 'def beta', '  1', 'end'],
  },
  {
    ext: 'rb', symbol: 'beta', span: [10, 12],
    lines: ['# alpha', 'def alpha(a)', '  x = 1', '  if a', '    return x', '  end', '  return 0', 'end', '', 'def beta', '  1', 'end'],
  },
  {
    ext: 'lua', symbol: 'alpha', span: [2, 11],
    lines: [
      '-- alpha', 'function alpha(a)', '  local x = 1', '  if a then', '    return x', '  end',
      '  for i = 1, 10 do', '    x = x + i', '  end', '  return x', 'end',
      '', 'function gamma()', '  do', '    local y = 1', '  end', '  return 0', 'end',
    ],
  },
  {
    // `for ... do ... end` 只算一个块：`do` 是循环体的引导词，不是第二个开块词
    ext: 'lua', symbol: 'gamma', span: [13, 18],
    lines: [
      '-- alpha', 'function alpha(a)', '  local x = 1', '  if a then', '    return x', '  end',
      '  for i = 1, 10 do', '    x = x + i', '  end', '  return x', 'end',
      '', 'function gamma()', '  do', '    local y = 1', '  end', '  return 0', 'end',
    ],
  },
  {
    // `${x}` 必须不能把函数的 `{` 提前配平（`${` 与 `$(` 也是括号对）
    ext: 'sh', symbol: 'alpha', span: [3, 10],
    lines: [
      '#!/bin/sh', '# alpha', 'alpha() {', '  x=1', '  if [ -n "$1" ]; then', '    echo "${x}"',
      '    return 1', '  fi', '  return 0', '}', '', 'function beta {', '  echo hi', '}',
    ],
  },
  {
    ext: 'sh', symbol: 'beta', span: [12, 14],
    lines: [
      '#!/bin/sh', '# alpha', 'alpha() {', '  x=1', '  if [ -n "$1" ]; then', '    echo "${x}"',
      '    return 1', '  fi', '  return 0', '}', '', 'function beta {', '  echo hi', '}',
    ],
  },
  // ── 花括号语言（回归：既有跨度不得改变）──────────────────────────────────
  { ext: 'js', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'function alpha(a) {', '  const x = 1;', '  if (a) {', '    return x;', '  }', '  return 0;', '}'] },
  { ext: 'ts', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'function alpha(a: number): number {', '  const x = 1;', '  if (a > 0) {', '    return x;', '  }', '  return 0;', '}'] },
  { ext: 'c', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'int alpha(int a) {', '  int x = 1;', '  if (a) {', '    return x;', '  }', '  return 0;', '}'] },
  { ext: 'h', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'int alpha(int a) {', '  int x = 1;', '  if (a) {', '    return x;', '  }', '  return 0;', '}'] },
  { ext: 'cpp', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'int alpha(int a) {', '  int x = 1;', '  if (a) {', '    return x;', '  }', '  return 0;', '}'] },
  // java/cs 的配置表里没有函数规则（只有 class/interface/enum/record），因此回归夹具取类跨度，
  // 而不是去断言一个从来不存在的能力。
  { ext: 'java', symbol: 'Alpha', span: [2, 10], lines: ['// class', 'class Alpha {', '  int alpha(int a) {', '    int x = 1;', '    if (a > 0) {', '      return x;', '    }', '    return 0;', '  }', '}'] },
  { ext: 'cs', symbol: 'Alpha', span: [2, 10], lines: ['// class', 'class Alpha {', '  int Run(int a) {', '    int x = 1;', '    if (a > 0) {', '      return x;', '    }', '    return 0;', '  }', '}'] },
  { ext: 'go', symbol: 'alpha', span: [3, 9], lines: ['package main', '// alpha', 'func alpha(a int) int {', '  x := 1', '  if a > 0 {', '    return x', '  }', '  return 0', '}'] },
  { ext: 'rs', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'fn alpha(a: i32) -> i32 {', '  let x = 1;', '  if a > 0 {', '    return x;', '  }', '  0', '}'] },
  { ext: 'swift', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'func alpha(_ a: Int) -> Int {', '  let x = 1', '  if a > 0 {', '    return x', '  }', '  return 0', '}'] },
  { ext: 'php', symbol: 'alpha', span: [3, 9], lines: ['<?php', '// alpha', 'function alpha($a) {', '  $x = 1;', '  if ($a > 0) {', '    return $x;', '  }', '  return 0;', '}'] },
  { ext: 'scala', symbol: 'run', span: [3, 9], lines: ['// object', 'object Alpha {', '  def run(a: Int): Int = {', '    val x = 1', '    if (a > 0) {', '      return x', '    }', '    0', '  }', '}'] },
  { ext: 'ps1', symbol: 'Alpha', span: [2, 8], lines: ['# alpha', 'function Alpha($a) {', '  $x = 1', '  if ($a) {', '    return $x', '  }', '  return 0', '}'] },
  { ext: 'pl', symbol: 'alpha', span: [2, 8], lines: ['# alpha', 'sub alpha {', '  my $x = 1;', '  if ($a) {', '    return $x;', '  }', '  return 0;', '}'] },
  { ext: 'proto', symbol: 'Alpha', span: [3, 5], lines: ['// msg', 'message A {', '  rpc Alpha(Req) returns (Res) {', '    option x = 1;', '  }', '}'] },
  // 变量绑定里的箭头函数：块开符落在签名后的第 7 个 token 之后。
  // 这是审计条件 1 的形态：头部扫描一旦用 token 窗口截断，`target=` 就只换签名行、
  // 函数体留在原地，而 spanComplete 仍然是 true（静默）。
  { ext: 'js', symbol: 'f', span: [2, 7], lines: ['// arrow', 'const f = (a, b) => {', '  if (a > b) {', '    return a;', '  }', '  return b;', '}'] },
  { ext: 'ts', symbol: 'g', span: [2, 7], lines: ['// typed arrow', 'const g = (a: number): number => {', '  if (a > 0) {', '    return a;', '  }', '  return 0;', '}'] },
  { ext: 'js', symbol: 'handler', span: [2, 5], lines: ['// async arrow', 'const handler = async (req, res) => {', '  const body = await req.text()', '  return res.send(body)', '}'] },
  // 语句边界：声明后面紧跟一个块语句时，跨度**不能**把那块吃进来（反向守卫）
  { ext: 'js', symbol: 'items', span: [2, 2], lines: ['// boundary', 'const items = getItems()', 'if (items.length > 0) {', '  return items', '}'] },
  // 跨行语句：没有块体，但语句延续到下一行 ⇒ 跨度到语句末尾（不是只有签名行）
  { ext: 'js', symbol: 'ok', span: [2, 3], lines: ['// continued', 'const ok = first', '  && second', 'const after = 1'] },
  // shell 的子 shell 体：`(` 组也是一层，跨过去就是整段（审计条件 2）
  { ext: 'sh', symbol: 'f', span: [1, 3], lines: ['function f() (', '  echo hi', ')'] },
  // 体尾纯注释行不进跨度（审计条件 3，刻意如此：收进去等于静默删注释）
  { ext: 'py', symbol: 'f', span: [1, 2], lines: ['def f():', '    return 1', '    # note'] },
  // 规则把块开符吃进模式里的两门语言：跨度必须从那个 `{` 起算（此前塌成签名行）
  { ext: 'dart', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'int alpha(int a) {', '  var x = 1;', '  if (a > 0) {', '    return x;', '  }', '  return 0;', '}'] },
  { ext: 'kt', symbol: 'beta', span: [2, 8], lines: ['// beta', 'fun beta(a: Int) {', '  val x = 1', '  if (a > 0) {', '    return x', '  }', '  return 0', '}'] },
  // 带返回类型注解：块开符在签名后的第 8 个 token。旧窗口（`endTok + 6`）够不到它，
  // 于是这一形在上一轮是 fail-closed；换成结构化头部扫描后它应该直接拿到整段。
  { ext: 'kt', symbol: 'alpha', span: [2, 8], lines: ['// alpha', 'fun alpha(a: Int): Int {', '  val x = 1', '  if (a > 0) {', '    return x', '  }', '  return 0', '}'] },
]

/**
 * B 段夹具：跨度**判不了**的四种真实情形。每一种都必须走结构化拒绝。
 * 这类夹具的存在本身就是判据——没有它，"fail-closed"只是一句声明。
 */
const FAIL_CLOSED = [
  {
    ext: 'bat', target: 'label:alpha',
    why: '配置表没有块体终结规则（batch 的 function 规则会把裸标识符行都当函数，符号本身就不可信）',
    lines: ['@echo off', ':alpha', 'set x=1', 'echo done', 'goto :eof'],
  },
  {
    ext: 'py', target: 'alpha',
    why: '方法体用制表符、类体用空格：缩进无法比较，块体边界判不了',
    lines: ['class C:', '    def alpha(self):', '\t    x = 1', '        return x'],
  },
  {
    ext: 'rb', target: 'alpha',
    why: 'heredoc 不是词法器认识的语法：里面的 `end` 会被当成真代码',
    lines: ['# alpha', 'def alpha', '  sql = <<~SQL', 'end', '  SQL', '  1', 'end'],
  },
]

function symbolOf(lines, ext, name) {
  const index = indexStructure(lines.join('\n'), langOf(`x.${ext}`))
  return index.symbols.find((s) => s.name === name) ?? null
}

// ── A 段 ───────────────────────────────────────────────────────────────────
say('=== A. 每个多行函数的符号末行 == 函数体闭合行 ===')
for (const fx of FIXTURES) {
  const want = fx.span
  const closeText = fx.lines[want[1] - 1]
  // 夹具自检：期望末行必须是内容行。写错夹具（指到空行/注释）会让断言失去意义。
  check(
    typeof closeText === 'string' && closeText.trim().length > 0,
    `${fx.ext}/${fx.symbol} 夹具自检：第 ${want[1]} 行是内容行`,
    JSON.stringify(closeText ?? '(越界)'),
  )
  const hit = symbolOf(fx.lines, fx.ext, fx.symbol)
  if (hit === null) {
    check(false, `${fx.ext}/${fx.symbol} 被索引到`, `实际符号：${JSON.stringify(indexStructure(fx.lines.join('\n'), langOf(`x.${fx.ext}`)).symbols.map((s) => `${s.kind}:${s.name}`))}`)
    continue
  }
  check(
    hit.startLine === want[0] && hit.endLine === want[1],
    `${fx.ext}/${fx.symbol} 跨度 ${hit.startLine}-${hit.endLine}（期望 ${want[0]}-${want[1]}）`,
    `末行原文 ${JSON.stringify(fx.lines[hit.endLine - 1] ?? '(越界)')}`,
  )
}

// ── A2 段：守卫自己的形状（审计指出本文件的 helper 就是漏掉的那个形态）──────
say('')
say('=== A2. 守卫自己的形状：本文件的箭头函数 helper ===')
const selfSrc = fs.readFileSync(new URL(import.meta.url), 'utf8')
const selfLines = selfSrc.split(/\r?\n/)
const selfHit = indexStructure(selfSrc, langOf('span-fidelity.mjs')).symbols.find((s) => s.name === 'check')
if (selfHit === undefined) {
  check(false, '本文件里的 `check` 被索引到', '找不到 helper 符号')
} else {
  check(selfHit.spanComplete !== false, '`check` 的跨度被判定为完整', `spanComplete=${JSON.stringify(selfHit.spanComplete)}`)
  check(
    selfHit.endLine > selfHit.startLine && (selfLines[selfHit.endLine - 1] ?? '').trim() === '}',
    '`check` 的跨度覆盖到箭头函数体的闭行',
    `span=${selfHit.startLine}-${selfHit.endLine} 末行=${JSON.stringify(selfLines[selfHit.endLine - 1] ?? '')}`,
  )
}

// POSIX 形态的子 shell 体（没有 `function` 关键字）：这个形态识别不出函数，
// 因此没有符号——`target=` 只能结构化拒绝（STRUCT_NOT_FOUND），
// 而不是给出一个 1-1 的静默短跨度（审计条件 2）。
const posixSh = 'f() (\n  echo hi\n)\n'
check(
  indexStructure(posixSh, langOf('x.sh')).symbols.every((s) => s.name !== 'f'),
  'sh 的 `f() ( … )` 不产出半捅子符号',
  JSON.stringify(indexStructure(posixSh, langOf('x.sh')).symbols.map((s) => `${s.kind}:${s.name}`)),
)
const posixHit = locate(posixSh, { target: 'f', filePath: 'x.sh' })
check(posixHit.ok === false, 'sh 的 `f() ( … )` target= 被结构化拒绝', `${posixHit.code ?? 'ok'}`)

// ── B 段 ───────────────────────────────────────────────────────────────────
say('')
say('=== B. 跨度判不了时必须结构化拒绝（fail-closed）===')
for (const fx of FAIL_CLOSED) {
  const src = fx.lines.join('\n')
  const name = fx.target.includes(':') ? fx.target.split(':')[1] : fx.target
  const hit = symbolOf(fx.lines, fx.ext, name)
  check(hit !== null && hit.spanComplete === false, `${fx.ext}/${fx.target} 被标记为跨度不完整`, hit === null ? '符号不存在' : `spanComplete=${JSON.stringify(hit.spanComplete)} note=${JSON.stringify(hit.spanNote)}`)
  const found = locate(src, { target: fx.target, filePath: `x.${fx.ext}` })
  check(found.ok === false && found.code === 'LOCATOR_SPAN_INCOMPLETE', `${fx.ext}/${fx.target} target= 被拒（${found.code ?? 'ok'}）`, fx.why)
}

// ── C 段：经真实 aura_basetools_edit 执行，验证拒绝、磁盘不变、以及"整段替换"──────────
say('')
say('=== C. aura_basetools_edit：整体替换与拒绝（mock ctx 驱动真插件）===')
const plugin = await import('../aura-edit/index.js')
const tmp = path.join(os.tmpdir(), `span-fidelity-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })

let version = 1
const fsService = {
  resolve: async (p) => ({ displayPath: p, targetKey: p }),
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
    return { version: `v${version}`, operation: 'update', before: current, after: next }
  },
}
let tool = null
plugin.apply({
  fs: fsService,
  // 与真实 Cordis 上下文同形：缺 inject/get 就等于少测一条路径（见 mock-ctx.mjs）
  ...contextServices(),
  tools: { register: (t) => (tool = t) },
  emit: () => {},
  systemPrompt: { section: () => () => {} },
  waterfall: async () => {
    throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
  },
})
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

async function runEdit(fileName, lines, hunk) {
  const p = path.join(tmp, fileName)
  fs.writeFileSync(p, lines.join('\n'), 'utf8')
  const before = fs.readFileSync(p, 'utf8')
  // 读一次全份：覆盖闸认的是"这些行交付过"，整段替换才有依据。
  readWith(before, { filePath: p, mode: 'lines', lines: [1, before.split('\n').length] })
  let out = null
  let error = null
  try {
    out = await tool.execute({ file_path: p, hunks: [hunk] }, exec)
  } catch (e) {
    error = e
  }
  return { out, error, before, after: fs.readFileSync(p, 'utf8') }
}

// C1：修好跨度之后，`target=` 必须换掉**整个函数**，旧函数体不能残留
const PY = ['def alpha(a):', '    x = 1', '    return x', '', 'def beta():', '    pass', '']
const PY_NEW = 'def alpha(a):\n    return a * 2'
const pyEdit = await runEdit('c1.py', PY, { target: 'alpha', replace: PY_NEW })
const pyWant = ['def alpha(a):', '    return a * 2', '', 'def beta():', '    pass', ''].join('\n')
check(pyEdit.error === null, 'C1 py target=alpha 成功', pyEdit.error === null ? '' : String(pyEdit.error.code ?? pyEdit.error.message))
check(pyEdit.after === pyWant, 'C1 旧函数体未残留（整段被替换）', JSON.stringify(pyEdit.after))
check(pyEdit.after.includes('def beta():'), 'C1 下一个函数未被触碰')

// C2：跨度不完整的符号，target= 必须结构化拒绝且磁盘不变
const refuseCases = [
  { name: 'c2.py', target: 'alpha', lines: ['class C:', '    def alpha(self):', '\t    x = 1', '        return x', ''], code: 'LOCATOR_SPAN_INCOMPLETE' },
  { name: 'c2.bat', target: 'label:alpha', lines: ['@echo off', ':alpha', 'set x=1', 'goto :eof', ''], code: 'LOCATOR_SPAN_INCOMPLETE' },
  { name: 'c2.rb', target: 'alpha', lines: ['def alpha', '  sql = <<~SQL', 'end', '  SQL', '  1', 'end', ''], code: 'LOCATOR_SPAN_INCOMPLETE' },
]
for (const c of refuseCases) {
  const r = await runEdit(c.name, c.lines, { target: c.target, replace: '# replaced' })
  /**
   * 0.9.1：跨度不完整是可判定、可恢复的地址失败，现在走**结果通道**（outcome=not_found，
   * 带 next），不再作为工具故障抛出。两种形状都接受，但必须带回同一个 code 且磁盘不动。
   */
  const rejectedCode = r.error?.code ?? r.out?.code ?? null
  check(rejectedCode === c.code, `${c.name} target=${c.target} 被拒（${rejectedCode ?? 'ok'}）`, c.code)
  check(r.after === r.before, `${c.name} 磁盘未变`)
  const rejectionMessage = r.error?.message ?? r.out?.message ?? ''
  check(
    typeof rejectionMessage === 'string' && rejectionMessage.includes('lines='),
    `${c.name} 拒绝信息给出可执行替代（lines=）`,
    JSON.stringify(rejectionMessage),
  )
}

// C3：拒绝只针对"跨度不完整"这一种情形——同一个文件用 lines= 仍然可改
const byLines = await runEdit('c3.bat', ['@echo off', ':alpha', 'set x=1', 'goto :eof', ''], { lines: [3], expect: 'set x=1', replace: 'set x=2' })
check(byLines.error === null && byLines.after.includes('set x=2'), 'C3 同一文件改用 lines= 仍可编辑', byLines.error === null ? '' : String(byLines.error.code))

// C5：审计条件 1 的形态——多参箭头函数必须整段替换（旧引擎只换签名行）
const ARROW = ['const f = (a, b) => {', '  return a + b', '}', '', 'const g = 1', '']
const ARROW_NEW = 'const f = (a, b) => a * b'
const arrowEdit = await runEdit('c5.js', ARROW, { target: 'f', replace: ARROW_NEW })
const arrowWant = ['const f = (a, b) => a * b', '', 'const g = 1', ''].join('\n')
check(arrowEdit.error === null, 'C5 js target=f 成功（多参箭头）', arrowEdit.error === null ? '' : String(arrowEdit.error.code ?? arrowEdit.error.message))
check(arrowEdit.after === arrowWant, 'C5 旧箭头函数体未残留（整段被替换）', JSON.stringify(arrowEdit.after))

// C6：Kotlin 带返回类型注解的函数（上一轮是 fail-closed，现在是整段）
const KT = ['fun alpha(a: Int): Int {', '  val x = 1', '  return x', '}', '']
const ktEdit = await runEdit('c6.kt', KT, { target: 'alpha', replace: 'fun alpha(a: Int): Int {\n  return a * 2\n}' })
check(ktEdit.error === null && ktEdit.after === 'fun alpha(a: Int): Int {\n  return a * 2\n}\n', 'C6 kt target=alpha 整段替换（旧函数体未残留）', JSON.stringify(ktEdit.after))

// C4：shell 的 `${...}` 不再把函数块提前配平（修好跨度之前它会截断在第 2 行）
const SH = ['alpha() {', '  echo "${x}"', '  return 0', '}', '']
const shEdit = await runEdit('c4.sh', SH, { target: 'alpha', replace: 'alpha() {\n  echo hi\n}' })
check(shEdit.error === null && shEdit.after === 'alpha() {\n  echo hi\n}\n', 'C4 sh target=alpha 整段替换（`${x}` 未截断跨度）', JSON.stringify(shEdit.after))

fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
  process.exitCode = 1
}
