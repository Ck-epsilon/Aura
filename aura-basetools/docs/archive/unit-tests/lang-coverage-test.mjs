/**
 * lang-coverage-test —— 新增语言（F1）的验收：**能否建符号表、能否按 target= 精确改写**。
 *
 * 为什么单独一个文件：既有套件各自盯一种性质（`struct-test` 盯跨度的正确性、`lang-test` 盯注释陷阱、
 * `range-formats-test` 把扩展名当自变量）。它们都不回答新语言的这一组问题：
 * "这个扩展名认得出来吗 / 夹具上有符号吗 / 行号落在文件内吗 / 跨度完整吗 / target= 改到的
 * 正好是那一段吗 / 一句普通语句会不会被当成符号"。
 *
 * 判据全部取自**引擎的对外接口**（`langOf` / `indexStructure` / `listSymbols` / `planHunks`），
 * 不读实现内部状态——否则测试只是在复述实现。
 *
 * 三个刻意保留的严格点：
 *   1. `spanComplete` 必须为 true。为 false 时 `target=` 会被结构化拒绝（设计上的 fail-closed），
 *      本文件不去绕过它，而是把它当红。
 *   2. 改写后的文件必须**逐字节**等于"原文件只换掉该符号所在行区间"的结果——区外一个字节都不许动。
 *   3. **负向**：夹具里都放了一句普通语句（调用/赋值），它不许出现在符号表里。
 *
 * 夹具里的每一行都按该语言的**真实语法**写。批 2 的语言未完成前不写进这里——
 * 红着的半成品没有价值。
 */
import fs from 'node:fs'
import { indexStructure, langOf, listSymbols } from './struct-core.mjs'
import { planHunks } from './write-path.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const splitLines = (src) => src.split(/\r?\n/)
/** 行区间 [a,b]（1-based，含两端）的整行文本，不含行尾。 */
const regionOf = (src, a, b) => splitLines(src).slice(a - 1, b).join('\n')
/** 把行区间 [a,b] 换成 rep（单行）之后的期望全文。 */
const replacedLines = (src, a, b, rep) => {
  const out = splitLines(src).slice()
  out.splice(a - 1, b - a + 1, rep)
  return out.join('\n')
}

/**
 * 夹具表。
 *   ext    —— 扩展名
 *             所以线索词不能带点，否则文件会变成另一个扩展名）
 *   want   —— 期望符号：`kind:name[起-止]`
 *   target —— 用 target= 寻址的符号名
 *   span   —— 该符号**手写**的期望行区间（不是从实现回读的）
 *   absent —— 不许出现在符号表里的名字（夹具里那句普通语句）
 */
const FIXTURES = [
  {
    ext: 'sql',
    lines: ['CREATE TABLE alpha (', '  beta INTEGER', ');', 'SELECT COUNT(*) FROM alpha;'],
    want: 'table:alpha[1-3]',
    target: 'alpha',
    span: [1, 3],
    absent: ['COUNT'],
  },
  {
    ext: 'graphql',
    lines: ['type Alpha {', '  beta: Int', '}', 'query Fetch { beta }'],
    want: 'type:Alpha[1-3]',
    target: 'Alpha',
    span: [1, 3],
    absent: ['Fetch'],
  },
  {
    ext: 'gql',
    lines: ['type Alpha {', '  beta: Int', '}', 'query Fetch { beta }'],
    want: 'type:Alpha[1-3]',
    target: 'Alpha',
    span: [1, 3],
    absent: ['Fetch'],
  },
  {
    ext: 'tf',
    lines: ['resource "alpha" "beta" {', '  count = 1', '}', 'output "gamma" {', '  value = 1', '}'],
    want: 'resource:alpha[1-3] output:gamma[4-6]',
    target: 'alpha',
    span: [1, 3],
    absent: ['count'],
  },
  {
    ext: 'vue',
    lines: ['<template>', '  <p>{{ hello(title) }}</p>', '</template>', '<script setup>', "const title = 'Hi'", 'export function hello(name) {', '  return name', '}', '</script>'],
    want: 'variable:title[5-5] function:hello[6-8]',
    target: 'hello',
    span: [6, 8],
    absent: ['name'],
  },
  {
    ext: 'svelte',
    lines: ['<script>', '  let alpha = 1', '  export function beta(x) {', '    return x + alpha', '  }', '</script>', '<p>{alpha}</p>'],
    want: 'variable:alpha[2-2] function:beta[3-5]',
    target: 'beta',
    span: [3, 5],
    absent: ['x'],
  },
  {
    ext: 'astro',
    lines: ['---', "const title = 'Hi'", 'const greet = (name) => {', '  return name', '}', '---', '<h1>{greet(title)}</h1>'],
    want: 'variable:title[2-2] function:greet[3-5]',
    target: 'greet',
    span: [3, 5],
    absent: ['name'],
  },
  // ── 批 2：已做好的扩展名（erl 的 T2 已补；hrl/hs/ml/nim/zig 仍未做对，故不写进这里）───
  {
    ext: 'r',
    lines: ["alpha <- function(a) {", '  a + 1', '}', 'print(alpha(1))'],
    want: 'function:alpha[1-3]',
    target: 'alpha',
    span: [1, 3],
    absent: ['a'],
  },
  {
    ext: 'ex',
    lines: ['defmodule Alpha do', '  def beta(a) do', '    a + 1', '  end', 'end'],
    want: 'module:Alpha[1-5] function:beta[2-4]',
    target: 'beta',
    span: [2, 4],
    absent: ['a'],
  },
  {
    ext: 'exs',
    lines: ['defmodule Alpha do', '  def beta(a) do', '    a + 1', '  end', 'end'],
    want: 'module:Alpha[1-5] function:beta[2-4]',
    target: 'Alpha',
    span: [1, 5],
    absent: ['a'],
  },
  {
    ext: 'clj',
    lines: ['(ns alpha.core)', '', '(defn beta [a]', '  (+ a 1))'],
    // 2026-10-24：namespace 的跨度是它自己那对括号（`(...)`），不能把下一行 `(defn …)` 的 `(`
    // 当成块体——旧期望 [1-4] 锁住的正是那个 bug，`target=alpha` 会连 beta 一起删掉。
    want: 'namespace:alpha[1-1] function:beta[3-4]',
    target: 'beta',
    span: [3, 4],
    absent: ['a'],
  },
  {
    ext: 'cljs',
    lines: ['(ns alpha.core)', '', '(defn beta [a]', '  (+ a 1))'],
    // 同上：只换 namespace 自己那一行，后面的 `(defn …)` 逐字节保留。
    want: 'namespace:alpha[1-1] function:beta[3-4]',
    target: 'alpha',
    span: [1, 1],
    absent: ['a'],
  },
  {
    ext: 'el',
    lines: ['(defun alpha (a)', '  (+ a 1))', '(provide (quote alpha))'],
    want: 'function:alpha[1-2]',
    target: 'alpha',
    span: [1, 2],
    absent: ['a'],
  },
  {
    ext: 'vim',
    lines: ['function! Alpha(a)', '  return a:a + 1', 'endfunction', 'call Alpha(1)'],
    want: 'function:Alpha[1-3]',
    target: 'Alpha',
    span: [1, 3],
    absent: ['a'],
  },
  {
    ext: 'cython',
    lines: ['def alpha(int a):', '    return a + 1', '', 'cdef beta(int b):', '    return b + 1'],
    want: 'function:alpha[1-2] function:beta[4-5]',
    target: 'beta',
    span: [4, 5],
    absent: ['b'],
  },
  // ── T2：Erlang 函数子句（提取 + 多行跨度 + when 守卫 + 多子句合并 + spec 不误收）──
  {
    ext: 'erl',
    lines: ['-module(alpha).', '-export([beta/1]).', '', 'beta(A) ->', '    A + 1.'],
    want: 'module:alpha[1-1] function:beta[4-5]',
    target: 'beta',
    span: [4, 5],
    absent: ['A'],
  },
  {
    ext: 'erl',
    lines: ['-module(alpha).', 'f(0) -> zero;', 'f(N) when N > 0 ->', '    N;', 'f(N) ->', '    -N.'],
    want: 'module:alpha[1-1] function:f[2-6]',
    target: 'f',
    span: [2, 6],
    absent: ['N', 'zero'],
  },
  {
    ext: 'erl',
    lines: ['-module(alpha).', '-spec beta(integer()) -> integer().', 'beta(A) ->', '    A + 1.'],
    want: 'module:alpha[1-1] function:beta[3-4]',
    target: 'beta',
    span: [3, 4],
    absent: ['integer'],
  },
]

const MARK = 'LANG_COVERAGE_MARK'

say('=== A. 每个新扩展名：认得出来、有符号、行号在文件内 ===')
for (const fx of FIXTURES) {
  const src = fx.lines.join('\n')
  const total = fx.lines.length
  const lang = langOf(`x.${fx.ext}`)
  check(lang !== null, `${fx.ext}：langOf 认得这个扩展名`, `实际 ${lang === null ? 'null' : 'object'}`)
  if (lang === null) continue

  const idx = indexStructure(src, lang)
  const symbols = listSymbols(idx)
  const shown = symbols.map((s) => `${s.kind}:${s.name}[${s.startLine}-${s.endLine}]`).join(' ')
  check(symbols.length >= 1, `${fx.ext}：至少 1 个符号`, shown === '' ? '(符号表为空)' : shown)
  check(
    symbols.every((s) => Number.isInteger(s.startLine) && Number.isInteger(s.endLine) && s.startLine >= 1 && s.startLine <= s.endLine && s.endLine <= total),
    `${fx.ext}：符号行号落在 1..${total}`,
    shown,
  )
  check(shown === fx.want, `${fx.ext}：符号与跨度符合手写期望`, `实际 ${JSON.stringify(shown)} 期望 ${JSON.stringify(fx.want)}`)

  // 负向：夹具里那句普通语句不许被当成符号
  const names = symbols.map((s) => s.name)
  for (const bad of fx.absent) {
    check(!names.includes(bad), `${fx.ext}：普通语句里的 ${JSON.stringify(bad)} 不是符号`, `实际符号 ${JSON.stringify(names)}`)
  }

  // spanComplete：为 false 时 target= 会被设计拒绝，本文件不绕过
  const hits = symbols.filter((s) => s.name === fx.target)
  check(hits.length === 1, `${fx.ext}：${JSON.stringify(fx.target)} 在符号表里唯一`, `命中 ${hits.length} 个`)
  check(hits.length === 1 && hits[0].spanComplete === true, `${fx.ext}：${JSON.stringify(fx.target)} 的 spanComplete 为 true`, hits[0]?.spanNote ?? '')
  check(
    hits.length === 1 && hits[0].startLine === fx.span[0] && hits[0].endLine === fx.span[1],
    `${fx.ext}：${JSON.stringify(fx.target)} 落在 ${fx.span[0]}-${fx.span[1]}`,
    hits[0] === undefined ? '未命中' : `实际 ${hits[0].startLine}-${hits[0].endLine} kind=${hits[0].kind}`,
  )
}

say('')
say('=== B. target= 改写：改到的正好是那一段，区外逐字节不动 ===')
for (const fx of FIXTURES) {
  const src = fx.lines.join('\n')
  const got = planHunks(src, [{ target: fx.target, replace: MARK }], `x.${fx.ext}`)
  const want = replacedLines(src, fx.span[0], fx.span[1], MARK)
  check(got.matches.length === 1 && got.matches[0].tier === 'symbol', `${fx.ext}：target= 走符号层`, `tier=${got.matches[0]?.tier}`)
  check(
    got.matches[0]?.start === fx.span[0] - 1 && got.matches[0]?.end === fx.span[1],
    `${fx.ext}：target= 命中行 ${fx.span[0]}-${fx.span[1]}`,
    `实际 ${got.matches[0] === undefined ? '无' : `${got.matches[0].start + 1}-${got.matches[0].end}`}`,
  )
  check(got.content === want, `${fx.ext}：改后全文 == 只换该区间的结果（区外逐字节相同）`, diffHint(want, got.content))
  // 替换后行号会移动，所以这里问的是**改后**的第 span[0] 行（mark 落点），
  // 以及"整份文件正好少了 span 长度 − 1 行"——多删一行/少删一行都会在这里露馅。
  check(splitLines(got.content)[fx.span[0] - 1] === MARK, `${fx.ext}：改后 mark 落在第 ${fx.span[0]} 行`, JSON.stringify(splitLines(got.content)[fx.span[0] - 1]))
  check(
    splitLines(got.content).length === fx.lines.length - (fx.span[1] - fx.span[0]),
    `${fx.ext}：整份文件正好少 ${fx.span[1] - fx.span[0]} 行`,
    `实际 ${splitLines(got.content).length} 行，原 ${fx.lines.length} 行`,
  )
}

/** 失败时只报第一处不同，避免把两份全文刷进日志。 */
function diffHint(want, got) {
  if (want === got) return ''
  const a = splitLines(want)
  const b = splitLines(got)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return `第 ${i + 1} 行：期望 ${JSON.stringify(a[i])} 实际 ${JSON.stringify(b[i])}`
  }
  return `行数不同：${a.length} vs ${b.length}`
}

const failed = results.filter((r) => !r.ok)
say('')
if (failed.length > 0) {
  say('失败明细：')
  for (const f of failed) say(`  FAIL ${f.label}${f.detail === '' ? '' : `  ${f.detail}`}`)
  say('')
}
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
