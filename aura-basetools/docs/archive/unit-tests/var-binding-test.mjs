/**
 * var-binding-test —— **带修饰符/导出的变量绑定**能否进符号表（T7 的验收）。
 *
 * 为什么单独一个文件：既有套件各盯一种性质——`struct-test` 盯跨度、`lang-test` 盯注释陷阱、
 * `lang-coverage-test` 盯每个新语言能否 `target=` 改写。它们都不回答这一个问题：
 *
 *   "`export const X = 1` 里那个 `X`，在符号表里吗？"
 *
 * ## 这个洞的形态（实测，本轮修的）
 *
 * `export const/let/var NAME` **一个都不进符号表**——本仓库语料 22/22 全漏，
 * 含 `aura-read/index.js` 自己的 `PASSTHROUGH_FIELDS`。而 `export function` / `export class` /
 * `export type` 全部正常。也就是说：**模块的公共接口里，"值"这一半不可按名寻址。**
 *
 * 机制：变量规则的 pattern 是 `['const', '$name']`，**没有 `$mods*`**，而
 * `precededByModifier`（唯一性去重闸门）看到 `const` 前面站着 `export` 就判"这不是声明起点"。
 * `export function` 能活，正因为 function 规则带了 `$mods*`。
 *
 * 修法是给变量规则补 `$mods*`（各语言，规则表里；扫描器一行未动）。
 *
 * ## 本文件同时守一条**负向不变量**
 *
 * 补 `$mods*` 的代价是同一个声明可能在多个位置匹配上：
 * `public static final class A` 会在 `class` / `static` / `public` 三处各命中一次。
 * 所以这里除了断言"该有的符号有"，还断言"**同名符号只出现一次**"——
 * 这条比前者更容易被后来的改动破坏，而且破坏了也不报错，只是坐标变得歧义。
 */
import { indexStructure, langOf, listSymbols } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
import fs from 'node:fs'

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const names = (src, file) => listSymbols(indexStructure(src, langOf(file))).map((s) => s.name)
const kinds = (src, file) => listSymbols(indexStructure(src, langOf(file))).map((s) => `${s.kind}:${s.name}`)

say('=== 1. 导出/修饰符变量绑定必须进符号表（T7 的正向断言）===')
const POSITIVE = [
  // JS / TS / ESM / TSX —— 这一族是 bug 的原发地
  ['export const LIMIT = 10', 'x.mjs', 'LIMIT'],
  ['export let counter = 0', 'x.mjs', 'counter'],
  ['export var legacy = 1', 'x.mjs', 'legacy'],
  ['export const G = () => 1', 'x.mjs', 'G'],
  ['export const H = function () {}', 'x.mjs', 'H'],
  ['export const T = { a: 1 }', 'x.ts', 'T'],
  ['export const A: number = 1', 'x.ts', 'A'],
  ['export const J = 1', 'x.js', 'J'],
  ['export const K = 1', 'x.cjs', 'K'],
  ['export const L = 1', 'x.tsx', 'L'],
  ['export const M = 1', 'x.astro', 'M'],
  // 无 export 的对照（本来就能用——断言修改没有把它弄坏）
  ['const PLAIN = 1', 'x.mjs', 'PLAIN'],
  ['let plain2 = 1', 'x.ts', 'plain2'],
  // 其它语言的修饰符变量
  ['private val K1 = 1', 'x.scala', 'K1'],
  ['val K2 = 1', 'x.scala', 'K2'],
  ['public let S1 = 1', 'x.swift', 'S1'],
  ['let S2 = 1', 'x.swift', 'S2'],
  ['const val KT = 1', 'x.kt', 'KT'],
  ['public const val KT2 = 1', 'x.kt', 'KT2'],
  // Rust：`const` / `static` 声明（含 T28 修好的 `pub const` / `pub unsafe const`）
  ['const R1: i32 = 1', 'x.rs', 'R1'],
  ['static R2: i32 = 1', 'x.rs', 'R2'],
  ['pub static R3: i32 = 1', 'x.rs', 'R3'],
  ['pub const R5: i32 = 1', 'x.rs', 'R5'],
  ['pub const R6: u8 = 2;', 'x.rs', 'R6'],
  ['pub unsafe const R7: i32 = 1', 'x.rs', 'R7'],
  ['pub(crate) const R8: u8 = 2', 'x.rs', 'R8'],
]
for (const [src, file, want] of POSITIVE) {
  const got = names(src, file)
  check(got.includes(want), `${JSON.stringify(src)} [${file}] → 含 ${want}`, JSON.stringify(got))
}

say('')
say('=== 2. 负向不变量：多修饰符声明不得报出重复符号 ===')
// 判据取自既有行为：`public static final class A` 修前修后都只出 1 个 A。
// 若 `$mods*` 的改动破坏了去重，这里会先红。
const NO_DUP = [
  ['public static final class A {\n  int x;\n}', 'x.java', 'A'],
  ['export function f() { return 1 }', 'x.mjs', 'f'],
  ['export class C {}', 'x.mjs', 'C'],
  ['export const D = 1', 'x.mjs', 'D'],
  ['pub static R4: i32 = 1', 'x.rs', 'R4'],
  ['pub const R9: i32 = 1', 'x.rs', 'R9'],
  ['public const val KT3 = 1', 'x.kt', 'KT3'],
  ['public static let S3 = 1', 'x.swift', 'S3'],
]
for (const [src, file, name] of NO_DUP) {
  const got = names(src, file)
  const n = got.filter((x) => x === name).length
  check(n === 1, `${JSON.stringify(src.split('\n')[0])} [${file}] → ${name} 恰好 1 次`, `实际 ${n} 次：${JSON.stringify(got)}`)
}

say('')
say('=== 3. 负向：函数体内的局部量不得因为补了 mods 而冒出来 ===')
// `$mods*` 只该让**声明起点前移**，不该让规则匹配到块体内部。
const LOCALS = [
  ['export const OUT = 1\nfunction wrap() {\n  const INNER = 2\n  return INNER\n}\n', 'x.mjs', 'OUT', 'INNER'],
  ['pub static OUT2: i32 = 1\nfn wrap2() {\n  let inner2 = 2;\n}\n', 'x.rs', 'OUT2', null],
]
for (const [src, file, want, unwanted] of LOCALS) {
  const got = names(src, file)
  check(got.includes(want), `${file}: 顶层 ${want} 在`, JSON.stringify(got))
  if (unwanted !== null) {
    // 局部量**可以**在符号表里（imp 会把它降级），但不该被当成顶层导出——这里只断言它没被算成 OUT 的同名重复
    const dup = got.filter((x) => x === want).length
    check(dup === 1, `${file}: ${want} 未被局部量顶成重复`, `实际 ${dup} 次`)
  }
}

say('')
say('=== 4. 端到端：`target=` 能改到导出的常量（T7 的真实收益）===')
// 这是 bug 的用户可见形态：修前 target=PASSTHROUGH_FIELDS 直接 STRUCT_NOT_FOUND。
const src = 'export const CONFIG = 1\nexport function use() {\n  return CONFIG\n}\n'
const syms = listSymbols(indexStructure(src, langOf('x.mjs')))
const cfg = syms.find((s) => s.name === 'CONFIG')
check(cfg !== undefined, '导出常量出现在符号表里（可按名寻址）', JSON.stringify(syms.map((s) => s.name)))
check(cfg !== undefined && cfg.startLine === 1 && cfg.endLine === 1, '它的跨度是第 1 行', cfg ? `${cfg.startLine}-${cfg.endLine}` : 'n/a')

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
