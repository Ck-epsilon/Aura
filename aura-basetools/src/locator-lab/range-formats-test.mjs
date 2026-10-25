/**
 * range-formats-test —— 文件格式全覆盖靶场。
 *
 * 为什么要有这一个文件：既有套件各自只盯**一种性质**——`read-test` 盯模式语义、
 * `span-fidelity` 盯符号跨度、`byte-fidelity` 盯一次编辑的字节影响面、`corpus-test` 盯真实语料。
 * 没有一个回答"换一种扩展名，这些性质还成不成立"。本文件把**扩展名当自变量**：
 * 每种格式一个最小夹具，逐个跑读与写，断言四件事：
 *   1. 索引格式能建符号表（≥1 个符号，行号落在 1..totalLines）；
 *   2. 未索引格式走 full 兜底（ok 且 text 非空），各模式都带 version 令牌；
 *   3. 一次编辑只动被寻址的那一段——区外逐字节相同（行尾是行的一部分，也在内）；
 *   4. 任何输入（含 0 字节 / 只有 BOM / 单 \r 行尾 / emoji）都**不许**抛未捕获异常，
 *      要么 ok:true，要么给出明确的 code。
 *
 * 夹具全是**纯内存字符串**：引擎是纯函数，本文件不碰 node:fs 的读写，因此没有临时目录、
 * 没有平台分支、没有清理残留。落盘链路（BOM 字节、editText 整份归一、版本冲突闸门）
 * 归 byte-fidelity / encoding-fidelity / stale-gate-test，这里不重复也不替代它们。
 *
 * ### 覆盖到哪些（80 个夹具）
 *
 * 引擎有语言定义、本文件**断言符号**的格式（33 个）：
 *   js ts jsx tsx mjs cjs py rb php go rs java kt kts scala swift c cpp h hpp cs
 *   sh bash zsh lua pl pm pyx bat cmd ps1 proto dart
 *
 * 引擎**没有**语言定义、只走未索引路径的格式（47 个）：
 *   json jsonc yml yaml toml ini cfg conf env csv tsv xml html htm md markdown rst txt
 *   lock log diff patch gitignore a.noext Dockerfile Makefile
 *   r ex exs erl hrl hs ml clj cljs vim el cython sql graphql gql tf vue svelte astro nim zig
 *
 * ### 没覆盖的，以及为什么（诚实清单——这些不是"通过"，是"没测"）
 *
 * 1. **清单点名、引擎里根本没有语言定义的 21 个扩展名**：r ex exs erl hrl hs ml clj cljs vim el
 *    cython sql graphql gql tf vue svelte astro nim zig。`struct-core.mjs` 的 `LANGS` 表里
 *    没有它们（`langOf()` 一律返回 null），因此它们**没有符号可断言**——本文件只验未索引兜底。
 *    每个夹具仍按该格式的**真实语法**写（真的声明就在夹具里），缺的只是引擎那一侧的语言配置，
 *    这是覆盖缺口而不是通过项。`cython` 这个字面扩展名同样不在表里（引擎的 Cython 挂在
 *    `pyx`/`pxd`/`pxi` 上），两个扩展名都建了夹具、分别归到两类。
 * 2. **`LANGS` 里有、验收清单没点名的扩展名**：mts cts pyi cc cxx hh ksh psm1 psd1 pxd pxi。
 *    它们不在清单里，未建夹具。
 * 3. **bat/cmd 的 `target=`**：这两种格式有语言定义、也能出符号，但 `BATCH` 配置刻意不给终结规则，
 *    符号一律 `spanComplete: false`，`target=` 因此按设计被结构化拒绝（实测 STRUCT_AMBIGUOUS）。
 *    它们的第二层寻址改用 `line_cue`；"target= 必须被拒绝"另有一条**显式断言**钉住，而不是绕开。
 * 4. **未索引格式的 `target=`**：没有符号表就没有符号身份，只能是 LOCATOR_NO_LANGUAGE。同上有显式断言。
 *    ⇒ 清单第 3 条"一半用 lines、一半用 target"因此调整为：**每个夹具各有一次 lines 寻址，
 *      外加一次第二层寻址**（能用 target 就用 target，不能用就用 line_cue）。被换掉的那些格式
 *      不是"没测寻址"，而是"换了那一层能用的寻址方式"，并且换的原因本身被断言。
 * 5. **`changed` 首读有没有令牌**：清单假设"无基准就无令牌"。实测相反——`renderChanged` 的首读分支
 *    也给真令牌（否则模型拿到 null 传回来还是首读，是个死环，read-core.mjs 里有这条记录）。
 *    本文件按**实测**断言（首读也给令牌，且与其它模式同值），并把清单与实现的这处出入记在这里。
 * 6. **预算与规模**：夹具都是最小夹具（≤7 行），因此不覆盖内容预算截断、单行超长、大文件 digest
 *    与 map 上限（read-cost / map-ceiling / digest-threshold 的范围）。
 * 7. **Unicode 归一**：含组合字符的夹具只断言"不崩 + 原文能原样取回"，**不**断言 NFC/NFD 归一。
 * 8. **单 `\r` 行尾（老 Mac）**：只在边界段验"给出明确 code"，不做行号语义断言
 *    （locator-api 显式拒绝这类文件，理由在它自己的注释里）。
 */
import fs from 'node:fs'
import { gaveLineAddress, lineRangeOf } from './args.mjs'
import { readWith } from './read-core.mjs'
import { docKindOf } from './doc-structure.mjs'
import { indexStructure, langOf } from './struct-core.mjs'
import { planHunks } from './write-path.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)

// ── 断言记账 ────────────────────────────────────────────────────────────────
// 每个"行"是一个格式（或一个边界文件）：行内累积断言数，收尾打印一行摘要。
// 失败明细统一留到最后——红的时候要看的是"哪些判据没成立"，不是被刷屏。
const results = []
let row = { name: '', tag: '', n: 0, bad: 0 }

const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  row.n += 1
  if (!ok) row.bad += 1
}

const flushRow = () => {
  if (row.n === 0) return
  const head = row.bad === 0 ? '✓' : '✗'
  const tail = row.bad === 0 ? '' : `  失败 ${row.bad}`
  say(`${head} ${row.name.padEnd(15)} ${row.tag.padEnd(7)} ${String(row.n).padStart(3)} 项断言${tail}`)
  row = { name: '', tag: '', n: 0, bad: 0 }
}

const beginRow = (name, tag) => {
  flushRow()
  row = { name, tag, n: 0, bad: 0 }
}

const section = (title) => {
  flushRow()
  say('')
  say(`=== ${title} ===`)
}

/**
 * 调引擎：把"不抛异常"本身当成一条断言。
 *
 * 为什么单独一层：清单第 4 条要求"绝不允许未捕获异常"——而一个逃出去的异常会让整个脚本
 * 在第 N 个格式上中断，剩下的格式**一条都没跑**。那是最坏的失败形态：看着像"跑了一半"，
 * 实际是"后面全没测"。因此所有引擎调用都必须经过这里。
 *
 * @returns 引擎的返回值；抛错则返回 null（失败已记账）。
 */
const guarded = (label, fn) => {
  try {
    return fn()
  } catch (error) {
    check(false, `${label}：不抛异常`, `未捕获的 ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`)
    return null
  }
}

/** 信封判据：要么 ok:true，要么 ok:false 且 code 是**非空字符串**。没有第三种形状。 */
const checkEnvelope = (label, r) => {
  if (r === null || typeof r !== 'object') {
    check(false, `${label}：返回对象`, `实际 ${r === null ? 'null' : typeof r}`)
    return false
  }
  check(true, `${label}：返回对象`)
  if (r.ok === true) return true
  check(
    r.ok === false && typeof r.code === 'string' && r.code.length > 0,
    `${label}：失败必须带明确 code`,
    `ok=${JSON.stringify(r.ok)} code=${JSON.stringify(r.code)}`,
  )
  return false
}

/**
 * 读一次并断言三件事：不抛异常、ok===true、**带 version 令牌**。
 *
 * 令牌这一条不是形式主义：`read-core` 的 `render` 里记着它曾被 `mode === 'changed' || lang === null`
 * 这个错误的判据剥掉，后果是**所有未索引扩展名一个都读不出来**（框架按 schema 判违规）。
 * 因此这里对每个夹具的每个模式都问一次令牌——这正是那次缺陷会命中的地方。
 */
const readCheck = (label, text, request) => {
  const r = guarded(label, () => readWith(text, request))
  check(r !== null && r.ok === true, `${label}：ok===true`, r === null ? '未返回' : `code=${r.code} ${r.message ?? ''}`)
  check(
    typeof r?.version === 'string' && r.version.length > 0,
    `${label}：带 version 令牌`,
    `version=${JSON.stringify(r?.version)}`,
  )
  return r
}

// ── 夹具表 ──────────────────────────────────────────────────────────────────
/**
 * 字段：
 *   file    —— 文件名。`langOf` 只看最后一个 `.` 之后的后缀，所以 `Dockerfile` / `a.noext` 都落到未索引路径。
 *   indexed —— **声明**它是否属于"引擎有语言定义"的那一类；实测结果会与它交叉核对（声明错了就报红），
 *              这样"覆盖清单"本身是被机器检查的，不会随时间腐烂。
 *   sym     —— 可用于 `target=` 的符号名；null 表示该格式没有可寻址符号（未索引，或 span 不完整）。
 *   span    —— **手写**的符号跨度 [起, 止]（不是从实现里回读的，否则测试只是在复述实现）。
 *   cue     —— 全文件**唯一**的词：`search` / `around` / `line_cue` 三层都用它。
 *   lines   —— 夹具的每一行，**不含行尾**。
 *   eol     —— 行尾：字符串（逐行套用，末行不加——模拟"文件末尾无换行"）或数组（逐行显式给出，用于混合行尾）。
 *   gap     —— 非空表示"验收清单点名、但引擎里没有语言定义"，用于汇总时的诚实分类。
 */
const FIXTURES = [
  // ── 一、引擎认识的语言：断言符号 ───────────────────────────────────────────
  { file: 'a.js', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['function alpha(a) {', '  return a + 1', '}'] },
  { file: 'a.ts', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['export function alpha(a: number): number {', '  return a + 1', '}'] },
  { file: 'a.jsx', indexed: true, sym: 'Alpha', span: [1, 3], cue: 'Alpha',
    lines: ['export function Alpha(props) {', '  return <div>{props.x}</div>', '}'] },
  { file: 'a.tsx', indexed: true, sym: 'Alpha', span: [1, 3], cue: 'Alpha',
    lines: ['export function Alpha(props: { x: number }) {', '  return <div>{props.x}</div>', '}'] },
  { file: 'a.mjs', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['export function alpha(a) {', '  return a + 1', '}'] },
  // CJS 夹具里 `alpha` 出现两次（函数名 + 导出对象），所以线索词取 `exports`
  { file: 'a.cjs', indexed: true, sym: 'alpha', span: [1, 3], cue: 'exports',
    lines: ['function alpha(a) {', '  return a + 1', '}', 'module.exports = { alpha }'] },
  { file: 'a.py', indexed: true, sym: 'alpha', span: [1, 2], cue: 'alpha',
    lines: ['def alpha(a):', '    return a + 1'] },
  { file: 'a.rb', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['def alpha(a)', '  a + 1', 'end'] },
  { file: 'a.php', indexed: true, sym: 'alpha', span: [2, 4], cue: 'alpha',
    lines: ['<?php', 'function alpha($a) {', '  return $a + 1;', '}'] },
  { file: 'a.go', indexed: true, sym: 'alpha', span: [3, 5], cue: 'alpha',
    lines: ['package main', '', 'func alpha(a int) int {', '\treturn a + 1', '}'] },
  { file: 'a.rs', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['fn alpha(value: i32) -> i32 {', '    value + 1', '}'] },
  { file: 'a.java', indexed: true, sym: 'Alpha', span: [1, 5], cue: 'Alpha',
    lines: ['class Alpha {', '  int get(int a) {', '    return a + 1;', '  }', '}'] },
  { file: 'a.kt', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['fun alpha(a: Int): Int {', '  return a + 1', '}'] },
  { file: 'a.kts', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['fun alpha(a: Int): Int {', '  return a + 1', '}'] },
  { file: 'a.scala', indexed: true, sym: 'Alpha', span: [1, 3], cue: 'Alpha',
    lines: ['object Alpha {', '  def get(a: Int): Int = a + 1', '}'] },
  { file: 'a.swift', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['func alpha(_ a: Int) -> Int {', '  return a + 1', '}'] },
  { file: 'a.c', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha', eol: '\r\n',
    lines: ['int alpha(int a) {', '  return a + 1;', '}'] },
  { file: 'a.cpp', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['int alpha(int a) {', '  return a + 1;', '}'] },
  { file: 'a.h', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['int alpha(int a) {', '  return a + 1;', '}'] },
  { file: 'a.hpp', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['int alpha(int a) {', '  return a + 1;', '}'] },
  { file: 'a.cs', indexed: true, sym: 'Alpha', span: [1, 5], cue: 'Alpha', eol: '\r\n',
    lines: ['class Alpha {', '  int Get(int a) {', '    return a + 1;', '  }', '}'] },
  { file: 'a.sh', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['alpha() {', '  echo hi', '}'] },
  { file: 'a.bash', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['function alpha() {', '  echo hi', '}'] },
  { file: 'a.zsh', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['alpha() {', '  echo hi', '}'] },
  { file: 'a.lua', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['function alpha(a)', '  return a + 1', 'end'] },
  { file: 'a.pl', indexed: true, sym: 'alpha', span: [1, 4], cue: 'alpha',
    lines: ['sub alpha {', '  my ($a) = @_;', '  return $a + 1;', '}'] },
  { file: 'a.pm', indexed: true, sym: 'beta', span: [3, 5], cue: 'beta',
    lines: ['package Alpha;', '', 'sub beta {', '  return 1;', '}', '', '1;'] },
  { file: 'a.pyx', indexed: true, sym: 'alpha', span: [1, 2], cue: 'alpha',
    lines: ['def alpha(int a):', '    return a + 1'] },
  // bat/cmd：有符号但 span 不完整 ⇒ target= 被设计拒绝，第二层寻址走 line_cue
  { file: 'a.bat', indexed: true, sym: null, cue: 'alpha',
    lines: ['@echo off', ':alpha', 'echo hi'] },
  { file: 'a.cmd', indexed: true, sym: null, cue: 'alpha',
    lines: ['@echo off', ':alpha', 'echo hi'] },
  { file: 'a.ps1', indexed: true, sym: 'Alpha', span: [1, 4], cue: 'Alpha', eol: '\r\n',
    lines: ['function Alpha {', '  param($a)', '  return $a', '}'] },
  { file: 'a.proto', indexed: true, sym: 'Alpha', span: [3, 5], cue: 'Alpha',
    lines: ['syntax = "proto3";', '', 'message Alpha {', '  int32 a = 1;', '}'] },
  { file: 'a.dart', indexed: true, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['int alpha(int value) {', '  return value + 1', '}'] },

  // ── 二、验收清单点名、但引擎里没有语言定义（gap）────────────────────────────
  // 夹具按各语言**真实语法**写；引擎不认识 ⇒ 没有符号可断言，只验未索引兜底。
  // F1 批 2 的 14 条：声明按**实测**翻成 indexed（主代理量的，不是猜）。
  // → 6 条已好（r/erl/clj/cljs/vim/cython，已填 sym+span）；
  // → 5 条跨度不完整（ex/exs/hs/ml/el，`target=` 会被 fail-closed 拒）→ sym 留 null 等修；
  // → 3 条零符号（hrl/nim/zig）→ `map` 断言会红；hs 另有一个假符号 `a`（参数被当成符号）。
  { file: 'a.r', indexed: true, gap: false, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['alpha <- function(a) {', '  a + 1', '}'] },
  { file: 'a.ex', indexed: true, gap: false, sym: null, cue: 'beta', // 跨度不完整（do…end 未界定）
    lines: ['defmodule Alpha do', '  def beta(a), do: a + 1', 'end'] },
  { file: 'a.exs', indexed: true, gap: false, sym: null, cue: 'beta', // 同上
    lines: ['defmodule Alpha do', '  def beta(a), do: a + 1', 'end'] },
  // T2：函数子句已能提取；这里改断函数（模块断言仍在 lang-coverage 的 erl 夹具里）。
  { file: 'a.erl', indexed: true, gap: false, sym: 'beta', span: [4, 5], cue: 'beta',
    lines: ['-module(alpha).', '-export([beta/1]).', '', 'beta(A) ->', '    A + 1.'] },
  // 裁决（主代理）：hrl/nim/zig 三种**已从语言表里移除**（作者单步实测后熔断停手：
  // `$param*`/`$ident*` 吃不下 "逗号+字面量"、`$mods*` 与 `proc` 互抢 token、末尾 `$ident*` 退化）。
  // 声明因此翻回 indexed:false —— 让靶场**如实反映现实**；缺口另行追，**不靠补夹具掩盖**。
  // 主代理加了 `$rest` 原语（跳到当前括号组收尾）后修好：`-define(ALPHA, 1).` → `ALPHA@1-1`
  // （同夹具第 2 行的 `-record(alpha, …)` 也出 `alpha@2-2`）。声明按实测。
  { file: 'a.hrl', indexed: true, gap: false, sym: 'ALPHA', span: [1, 1], cue: 'ALPHA',
    lines: ['-define(ALPHA, 1).', '-record(alpha, {beta = 1}).'] },
  // `hs` 已修好并加回登记：`guard: 'topLevel'`（第一列 layout 闸门）去掉假符号 `a`，
  // 去掉 `::` 签名规则消除同名歧义。实测只剩实现那一个符号 `beta@4-4` 且 `target=` 成功。
  { file: 'a.hs', indexed: true, gap: false, sym: 'beta', span: [4, 4], cue: 'Alpha',
    lines: ['module Alpha where', '', 'beta :: Int -> Int', 'beta a = a + 1'] },
  // a.ml：首次实测是 `alpha@1-1(不完整)`；作者随后修好，复测为 `alpha@1-2`（完整、target= 成功）。
  // 声明按**最新一次实测**填（探针结果会变，每次改完都要重量，不能拿旧结论当判据）。
  { file: 'a.ml', indexed: true, gap: false, sym: 'alpha', span: [1, 2], cue: 'alpha',
    lines: ['let alpha a =', '  a + 1'] },
  { file: 'a.clj', indexed: true, gap: false, sym: 'beta', span: [3, 4], cue: 'beta',
    lines: ['(ns alpha.core)', '', '(defn beta [a]', '  (+ a 1))'] },
  { file: 'a.cljs', indexed: true, gap: false, sym: 'beta', span: [3, 4], cue: 'beta',
    lines: ['(ns alpha.core)', '', '(defn beta [a]', '  (+ a 1))'] },
  { file: 'a.vim', indexed: true, gap: false, sym: 'Alpha', span: [1, 3], cue: 'Alpha',
    lines: ['function! Alpha(a)', '  return a:a + 1', 'endfunction'] },
  // a.el：首次实测 `alpha@1-1`（函数体在第 2 行，改完会留下孤儿 `(+ a 1))`）——已当作缺口报给作者；
  // 作者修好后**两次连续实测都是 `alpha@1-2`**，声明随实测更新为 [1,2]。
  { file: 'a.el', indexed: true, gap: false, sym: 'alpha', span: [1, 2], cue: 'alpha',
    lines: ['(defun alpha (a)', '  (+ a 1))'] },
  { file: 'a.cython', indexed: true, gap: false, sym: 'alpha', span: [1, 2], cue: 'alpha',
    lines: ['def alpha(int a):', '    return a + 1'] },
  // 下面这 7 条曾是"清单点名但引擎无语言定义"；F1 批 1 补上定义后，声明按**实测**翻成 indexed。
  // sym/span 是主代理量出来的实际提取结果（`alpha@1-3` 等），不是猜的；tf/vue 暂时仍是 null
  // —— 它们现在还提不出符号（map 断言会红），等定义修好后再填。
  { file: 'a.sql', indexed: true, gap: false, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['CREATE TABLE alpha (', '  beta INTEGER', ');'] },
  { file: 'a.graphql', indexed: true, gap: false, sym: 'Alpha', span: [1, 3], cue: 'beta',
    lines: ['type Alpha {', '  beta: Int', '}'] },
  { file: 'a.gql', indexed: true, gap: false, sym: 'Alpha', span: [1, 3], cue: 'beta',
    lines: ['type Alpha {', '  beta: Int', '}'] },
  // tf：HCL 块名是**带引号的字符串**，引擎的 `$label` 捕的是**第一个标签**（即类型 `alpha`）。
  // 线索词仍取实例名 `beta`——演示“两个标签里只有第二个是唯一的”这件事，且它在夹具里唯一。
  { file: 'a.tf', indexed: true, gap: false, sym: 'alpha', span: [1, 3], cue: 'beta',
    lines: ['resource "alpha" "beta" {', '  count = 1', '}'] },
  // vue/svelte：符号在 `<script>` 段里（模板段本来就没有可寻址的声明）；各补了一个导出函数。
  { file: 'a.vue', indexed: true, gap: false, sym: 'title', span: [5, 5], cue: 'hello',
    lines: ['<template>', '  <div>{{ hello(title) }}</div>', '</template>', '<script setup>',
      "const title = 'Hello'", 'export function hello(name) {', '  return name', '}', '</script>'] },
  { file: 'a.svelte', indexed: true, gap: false, sym: 'alpha', span: [2, 2], cue: 'alpha',
    lines: ['<script>', '  let alpha = 1', '</script>',
      '<p>{alpha}</p>'] },
  // a.astro：曾被从靶场里**删掉**（删夹具 = 删断言，是红线）。主代理已恢复，元数据按实测。
  { file: 'a.astro', indexed: true, gap: false, sym: 'alpha', span: [2, 3], cue: 'alpha',
    lines: ['---', 'const alpha = 1', '---'] },
  // 主代理接手后修好并登记（写法：缩进体不写终结符、不加 guard；块开符不进模式）。实测值如下。
  { file: 'a.nim', indexed: true, gap: false, sym: 'alpha', span: [1, 2], cue: 'alpha',
    lines: ['proc alpha(a: int): int =', '  a + 1'] },
  { file: 'a.zig', indexed: true, gap: false, sym: 'alpha', span: [1, 3], cue: 'alpha',
    lines: ['fn alpha(a: i32) i32 {', '    return a + 1;', '}'] },

  // ── 三、未索引格式：只验 full 兜底 + 令牌 ───────────────────────────────────
  { file: 'a.json', indexed: false, sym: null, cue: 'alpha',
    lines: ['{', '  "alpha": 1,', '  "beta": 2', '}'] },
  { file: 'a.jsonc', indexed: false, sym: null, cue: 'alpha',
    lines: ['{', '  // alpha comment', '  "beta": 2', '}'] },
  { file: 'a.yml', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha: 1', 'beta: 2'] },
  { file: 'a.yaml', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha: 1', 'beta: 2'] },
  { file: 'a.toml', indexed: false, sym: null, cue: 'alpha', eol: '\r\n',
    lines: ['[alpha]', 'beta = 2'] },
  { file: 'a.ini', indexed: false, sym: null, cue: 'alpha',
    lines: ['[alpha]', 'beta = 2'] },
  { file: 'a.cfg', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha = 1', 'beta = 2'] },
  { file: 'a.conf', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha 1', 'beta 2'] },
  { file: 'a.env', indexed: false, sym: null, cue: 'ALPHA',
    lines: ['ALPHA=1', 'BETA=2'] },
  { file: 'a.csv', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha,beta', '1,2'] },
  { file: 'a.tsv', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha\tbeta', '1\t2'] },
  { file: 'a.xml', indexed: false, sym: null, cue: 'alpha',
    lines: ['<?xml version="1.0"?>', '<root>', '  <alpha id="1"/>', '</root>'] },
  { file: 'a.html', indexed: false, sym: null, cue: 'alpha',
    lines: ['<!doctype html>', '<html>', '  <body id="alpha">hi</body>', '</html>'] },
  { file: 'a.htm', indexed: false, sym: null, cue: 'alpha',
    lines: ['<!doctype html>', '<html>', '  <body id="alpha">hi</body>', '</html>'] },
  // 混合行尾（CRLF/LF 混用）：用来钉住"未改动的行行尾不被整份归一"
  { file: 'a.md', indexed: false, sym: null, cue: 'alpha',
    lines: ['# alpha', '', '- beta', '- gamma'], ends: ['\r\n', '\n', '\r\n', ''] },
  { file: 'a.markdown', indexed: false, sym: null, cue: 'alpha',
    lines: ['# alpha', '', '- beta'] },
  { file: 'a.rst', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha', '=====', '', 'beta'] },
  { file: 'a.txt', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha', 'beta'] },
  { file: 'a.lock', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha@1.0.0:', '  resolution: {}'] },
  { file: 'a.log', indexed: false, sym: null, cue: 'alpha',
    lines: ['2024-01-01 alpha started', '2024-01-02 beta stopped'] },
  { file: 'a.diff', indexed: false, sym: null, cue: 'gamma',
    lines: ['--- a/alpha.txt', '+++ b/alpha.txt', '@@ -1 +1 @@', '-beta', '+gamma'] },
  { file: 'a.patch', indexed: false, sym: null, cue: 'gamma',
    lines: ['--- a/alpha.txt', '+++ b/alpha.txt', '@@ -1 +1 @@', '-beta', '+gamma'] },
  { file: 'a.gitignore', indexed: false, sym: null, cue: 'alpha',
    lines: ['node_modules/', '*.alpha'] },
  { file: 'a.noext', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha', 'beta'] },
  { file: 'Dockerfile', indexed: false, sym: null, cue: 'alpha',
    lines: ['FROM node:20-alpine', '# alpha', 'CMD ["node"]'] },
  { file: 'Makefile', indexed: false, sym: null, cue: 'alpha',
    lines: ['alpha:', '\techo hi'] },
]

const LINE_MARK = 'RANGE_FORMATS_LINES_MARK'
const TARGET_MARK = 'RANGE_FORMATS_TARGET_MARK'

/** 行尾表：`eol` 是数组就逐行照用；是字符串就逐行套用但**末行不加**（文件末尾无换行）。 */
function endingsFor(fx) {
  if (Array.isArray(fx.eol) || Array.isArray(fx.ends)) return fx.ends ?? fx.eol
  const e = fx.eol ?? '\n'
  return fx.lines.map((_, i) => (i === fx.lines.length - 1 ? '' : e))
}

const buildText = (fx) => {
  const ends = endingsFor(fx)
  return fx.lines.map((line, i) => line + (ends[i] ?? '')).join('')
}

const isMixed = (ends) => ends.includes('\r\n') && ends.some((e) => e === '\n')

/** 把文本切成"行 + 该行行尾"。行尾**参与**后续比较——它就是要保住的那部分字节。 */
function splitKeepEndings(text) {
  const out = []
  const breaks = /\r\n|\n/g
  let start = 0
  let hit
  while ((hit = breaks.exec(text)) !== null) {
    out.push(text.slice(start, hit.index + hit[0].length))
    start = hit.index + hit[0].length
  }
  out.push(text.slice(start))
  return out
}

const endingOf = (line) => {
  const m = /\r\n$|\n$/.exec(line)
  return m === null ? '' : m[0]
}

/** `[start,end]`（1-based 闭区间）**之外**的每一行都必须逐字节相同。 */
function outsideIdentical(before, after, start, end) {
  const tailLen = before.length - end
  if (after.length < start - 1 + tailLen) return false
  for (let i = 0; i < start - 1; i += 1) if (before[i] !== after[i]) return false
  for (let i = 0; i < tailLen; i += 1) {
    if (before[end + i] !== after[after.length - tailLen + i]) return false
  }
  return true
}

/** 被寻址区域在结果里的文本（`replace` 可能比原区域短，因此由尾部长度反推）。 */
const regionText = (after, start, tailLen) => after.slice(start - 1, after.length - tailLen).join('')

/**
 * 一次编辑的完整判据：**只动被寻址的那一段**。
 *
 * 逐字节比对而不是比长度：静默改行尾、少一个字节这类破坏都不会改变行数。
 * 期望区间是**手写**的（`expect.start/end`），不是从回执里回读的。
 */
function editCheck(tag, text, hunk, expect) {
  const before = splitKeepEndings(text)
  const planned = guarded(tag, () => planHunks(text, [hunk], expect.file))
  if (planned === null || typeof planned.content !== 'string') {
    check(false, `${tag}：返回 content`, `实际 ${planned === null ? 'null' : typeof planned.content}`)
    return
  }
  const m = planned.matches?.[0]
  check(m !== undefined, `${tag}：matches 非空`)
  if (m === undefined) return
  check(
    m.line === expect.start && m.end === expect.end,
    `${tag}：落在 ${expect.start}-${expect.end}`,
    `实际 ${m.line}-${m.end} tier=${m.tier}`,
  )
  const after = splitKeepEndings(planned.content)
  const tailLen = before.length - expect.end
  check(outsideIdentical(before, after, expect.start, expect.end), `${tag}：区外逐字节相同（行尾也是字节）`)
  const got = regionText(after, expect.start, tailLen)
  const want = expect.replace + endingOf(before[expect.end - 1])
  check(got === want, `${tag}：区内容 = replace + 继承被替换行的行尾`, `实际 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`)
  if (expect.keepLineCount === true) {
    check(after.length === before.length, `${tag}：行数不变`, `${before.length} → ${after.length}`)
  }
  if (expect.crlf === true) {
    check(
      endingOf(before[expect.end - 1]) === '\r\n' && got.endsWith('\r\n'),
      `${tag}：CRLF 行尾没被归一成 LF`,
      `原行尾 ${JSON.stringify(endingOf(before[expect.end - 1]))}`,
    )
  }
  if (expect.mixed === true) {
    check(
      planned.content.includes('\r\n') && /(^|[^\r])\n/.test(planned.content),
      `${tag}：混合行尾没被整份归一`,
      JSON.stringify(planned.content.slice(0, 60)),
    )
  }
}

/**
 * 原子性：多 hunk 请求里放一个定位不到的 hunk ⇒ 必须抛错，且**不返回**任何 content。
 *
 * "抛错即视为磁盘不变"是 planHunks 的事务语义（先全部规划完，再由调用方落盘）；
 * 因此判据是"调用点拿不到半成品"——一旦它返回了对象，调用方就可能把它写下去。
 */
function atomicityCheck(tag, text, file, good, bad) {
  let returned = null
  let thrown = null
  try {
    returned = planHunks(text, [good, bad], file)
  } catch (error) {
    thrown = error
  }
  check(thrown !== null, `${tag}：坏 hunk 必抛错（不许静默跳过）`, returned === null ? '' : '却正常返回了')
  check(returned === null, `${tag}：抛错时没有半成品 content`)
  check(
    typeof thrown?.code === 'string' && thrown.code.length > 0,
    `${tag}：错误码结构化`,
    `code=${JSON.stringify(thrown?.code)} ${thrown?.message ?? ''}`,
  )
}

/** 期待一次**结构化拒绝**：返回 null 或 code 形状不符都算失败。 */
function refusalCheck(label, fn, pattern) {
  let returned = null
  let thrown = null
  try {
    returned = fn()
  } catch (error) {
    thrown = error
  }
  const code = typeof thrown?.code === 'string' ? thrown.code : null
  check(
    returned === null && code !== null && pattern.test(code),
    `${label}：结构化拒绝（code 匹配 ${pattern}）`,
    `returned=${returned === null ? 'null' : 'object'} code=${JSON.stringify(code)}`,
  )
  return code
}

// ── A 格式矩阵：读 ──────────────────────────────────────────────────────────
section('A 格式矩阵：map 建表 / 未索引兜底 / 各模式令牌')
let indexedN = 0
let gapN = 0

for (const fx of FIXTURES) {
  const text = buildText(fx)
  const ends = endingsFor(fx)
  const measured = langOf(fx.file) !== null
  if (fx.indexed) indexedN += 1
  if (fx.gap === true) gapN += 1
  beginRow(fx.file, measured ? '索引' : '未索引')

  // 夹具形状自检：夹具写坏了（行尾表长度不符、行里混进换行）会让后面所有断言失去意义，
  // 而且失败会伪装成"引擎不对"。因此先把夹具本身钉住。
  check(ends.length === fx.lines.length, `${fx.file}：行尾表长度 == 行数`, `${ends.length} vs ${fx.lines.length}`)
  check(
    text.split(/\r?\n/).length === fx.lines.length && !fx.lines.some((l) => /[\r\n]/.test(l)),
    `${fx.file}：夹具形状自检（行内无换行、切分后行数一致）`,
    `切出 ${text.split(/\r?\n/).length} 行`,
  )
  check(
    measured === fx.indexed,
    `${fx.file}：langOf 判定与夹具声明一致`,
    `声明 indexed=${fx.indexed}，实测 ${measured}${fx.gap === true ? '（清单点名但引擎无语言定义）' : ''}`,
  )
  check(fx.lines.some((l) => l.includes(fx.cue)), `${fx.file}：线索词存在于夹具里`, `cue=${JSON.stringify(fx.cue)}`)

  const map = readCheck(`${fx.file} map`, text, { mode: 'map', filePath: fx.file })
  check(map?.totalLines === fx.lines.length, `${fx.file} map：totalLines == 夹具行数`, `${map?.totalLines} vs ${fx.lines.length}`)
  if (measured) {
    check((map?.symbols ?? 0) >= 1, `${fx.file} map：至少 1 个符号`, `symbols=${map?.symbols}`)
    const idx = guarded(`${fx.file} indexStructure`, () => indexStructure(text, langOf(fx.file)))
    const total = map?.totalLines ?? fx.lines.length
    check(
      idx !== null &&
        idx.symbols.length >= 1 &&
        idx.symbols.every((s) => Number.isInteger(s.startLine) && Number.isInteger(s.endLine) && s.startLine >= 1 && s.startLine <= s.endLine && s.endLine <= total),
      `${fx.file}：符号行号落在 1..${total}`,
      idx === null ? '建表抛错' : idx.symbols.map((s) => `${s.name}[${s.startLine}-${s.endLine}]`).join(' '),
    )
  } else if (docKindOf(fx.file) !== null) {
    /**
     * 0.21 起：.md/.json/.yaml/.toml 不再是“未索引”——它们有自己的结构目录。
     * 判据随之变成：必须给出 entries（symbols >= 1），而不是一句拒绝。
     */
    check(
      typeof map?.text === 'string' && map.text.length > 0 && typeof map?.symbols === 'number' && map.symbols >= 1,
      `${fx.file} map（文档）：给出结构目录而不是“不支持”`,
      `symbols=${map?.symbols} text=${JSON.stringify(String(map?.text ?? '').slice(0, 60))}`,
    )
  } else {
    // 说明从 `note` 改到 `text`（反馈 D8）：`metrics.chars` 量的是 `text` 的长度，
    // 只给 note 时 chars 会报 0，与同一条回执里“未索引”的说明自相矛盾。
    check(
      typeof map?.text === 'string' && map.text.length > 0,
      `${fx.file} map（未索引）：明说没有符号表，而不是假装有`,
      `text=${JSON.stringify(map?.text)}`,
    )
    check(map?.symbols === undefined, `${fx.file} map（未索引）：不谎报 symbols`, `symbols=${JSON.stringify(map?.symbols)}`)
  }

  const full = readCheck(`${fx.file} full`, text, { mode: 'full', filePath: fx.file })
  check(typeof full?.text === 'string' && full.text.length > 0, `${fx.file} full：text 非空（未索引的兜底路径）`)
  const linesMode = readCheck(`${fx.file} lines`, text, { mode: 'lines', lines: [1, 1], filePath: fx.file })
  check(typeof linesMode?.text === 'string' && linesMode.text.length > 0, `${fx.file} lines：text 非空`)
  const search = readCheck(`${fx.file} search`, text, { mode: 'search', search: fx.cue, filePath: fx.file })
  check((search?.matches ?? 0) >= 1, `${fx.file} search：命中线索词`, `matches=${search?.matches} q=${JSON.stringify(fx.cue)}`)
  const around = readCheck(`${fx.file} around`, text, { mode: 'around', around: fx.cue, filePath: fx.file })
  check(typeof around?.text === 'string' && around.text.length > 0, `${fx.file} around：text 非空`)
  const changed = readCheck(`${fx.file} changed`, text, { mode: 'changed', filePath: fx.file })
  const auto = readCheck(`${fx.file} auto`, text, { filePath: fx.file })
  const tokens = [full, linesMode, search, around, changed, auto].map((r) => r?.version)
  check(
    tokens.every((v) => typeof v === 'string' && v.length > 0 && v === tokens[0]),
    `${fx.file}：六个模式对同一份内容给同一个令牌`,
    tokens.join(' | '),
  )
  flushRow()
}

// ── B 编辑保真 ──────────────────────────────────────────────────────────────
section('B 编辑保真：一次编辑只动被寻址的那一段')
FIXTURES.forEach((fx, i) => {
  const text = buildText(fx)
  const ends = endingsFor(fx)
  beginRow(fx.file, '编辑')

  // 第一层：行号区间。一半写成 `lines: [a,b]`，一半写成 `start_line/end_line`——
  // 两种形状都必须经 `args.lineRangeOf` 收敛成同一个区间（写侧只认 `{start,end}`）。
  const lineHunk =
    i % 2 === 0
      ? { lines: [2, 2], replace: LINE_MARK }
      : { start_line: 2, end_line: 2, replace: LINE_MARK }
  editCheck(`${fx.file} lines`, text, lineHunk, {
    file: fx.file,
    start: 2,
    end: 2,
    replace: LINE_MARK,
    keepLineCount: true,
    crlf: ends[1] === '\r\n',
    mixed: isMixed(ends),
  })

  // 第二层：符号身份（该格式有可寻址符号时），否则一个**全文件唯一**的词。
  if (fx.sym !== null) {
    editCheck(`${fx.file} target=${fx.sym}`, text, { target: fx.sym, replace: TARGET_MARK }, {
      file: fx.file,
      start: fx.span[0],
      end: fx.span[1],
      replace: TARGET_MARK,
      mixed: isMixed(ends),
    })
  } else {
    // 唯一性由本文件自己算（不是回读引擎的候选），命中行号因此是**手写期望**。
    const hits = fx.lines.map((l, n) => (l.includes(fx.cue) ? n + 1 : 0)).filter((n) => n > 0)
    check(hits.length === 1, `${fx.file}：line_cue 词全文件唯一`, `cue=${JSON.stringify(fx.cue)} 命中 ${hits.join(',') || '无'}`)
    if (hits.length === 1) {
      editCheck(`${fx.file} line_cue=${fx.cue}`, text, { line_cue: fx.cue, replace: TARGET_MARK }, {
        file: fx.file,
        start: hits[0],
        end: hits[0],
        replace: TARGET_MARK,
        keepLineCount: true,
        crlf: ends[hits[0] - 1] === '\r\n',
        mixed: isMixed(ends),
      })
    }
  }

  // 原子性：好坏 hunk 混在一个请求里。坏 hunk 两种形态轮流用（符号找不到 / 行号越界）。
  const bad =
    i % 2 === 0
      ? { target: 'no_such_symbol_zzz', replace: TARGET_MARK }
      : { lines: [fx.lines.length + 9, fx.lines.length + 9], replace: TARGET_MARK }
  atomicityCheck(`${fx.file} 原子性`, text, fx.file, lineHunk, bad)

  // 没有符号身份的格式上，`target=` 必须是**结构化拒绝**：没有符号表就没有符号身份，
  // 退化成"文本里猜一个"会把"改错地方"从报错扩大成静默错改。
  if (fx.sym === null) {
    refusalCheck(
      `${fx.file} target=`,
      () => planHunks(text, [{ target: fx.cue, replace: TARGET_MARK }], fx.file),
      /^(LOCATOR_|STRUCT_)/,
    )
  }
  flushRow()
})

// ── C 边界格式 ──────────────────────────────────────────────────────────────
section('C 边界格式：要么 ok，要么明确 code，绝不抛未捕获异常')

const EDGE = [
  { file: 'edge-empty.js', text: '', why: '0 字节', wantLines: 1 },
  { file: 'edge-single.js', text: 'const alpha = 1', why: '单行且无结尾换行', wantLines: 1 },
  { file: 'edge-bom.js', text: '\uFEFF', bom: true, why: '只有 BOM（字节层是 EF BB BF）', wantLines: 1 },
  {
    file: 'edge-i18n.py',
    text: '# 中文注释 🎉 e\u0301\ndef alpha(a):\n    """返回 a+1 → 🎉"""\n    return a + 1  # café\n',
    why: 'emoji / 中日韩 / 组合字符',
    wantLines: 5,
  },
  { file: 'edge-tabs.md', text: '# alpha\tbeta\n\n\n\n- gamma\n', why: '制表符与连续空行', wantLines: 6 },
  { file: 'edge-lonecr.js', text: 'const alpha = 1\rconst beta = 2', why: '单 \\r 行尾（老 Mac）', wantLines: 1 },
  { file: 'edge-noext', text: 'alpha\n', why: '完全无扩展名', wantLines: 2 },
]

const EDGE_REQUESTS = [
  { mode: 'map' },
  { mode: 'digest' },
  { mode: 'full' },
  { mode: 'lines', lines: [1, 1] },
  { mode: 'lines', lines: [999, 999] },
  { mode: 'search', search: 'alpha' },
  { mode: 'search', search: 'zzz_absent_zzz' },
  { mode: 'around', around: 'alpha' },
  { mode: 'around', around: 'zzz_absent_zzz' },
  { mode: 'changed' },
  { mode: 'auto' },
]

const labelOfEdge = (r) =>
  [r.mode, r.lines === undefined ? '' : `lines=${r.lines.join(',')}`, r.search === undefined ? '' : `search=${r.search}`, r.around === undefined ? '' : `around=${r.around}`]
    .filter((s) => s !== '')
    .join(' ')

for (const edge of EDGE) {
  beginRow(edge.file, '边界')
  for (const request of EDGE_REQUESTS) {
    const label = `${edge.file} ${labelOfEdge(request)}`
    const r = guarded(label, () => readWith(edge.text, { ...request, ...(edge.bom === true ? { byteOrderMark: true } : {}), filePath: edge.file }))
    checkEnvelope(label, r)
  }
  // 边界文件也要参加"令牌"的检查：0 字节与只有 BOM 的文件最容易在令牌那一步出问题。
  const full = guarded(`${edge.file} full`, () => readWith(edge.text, { mode: 'full', filePath: edge.file, ...(edge.bom === true ? { byteOrderMark: true } : {}) }))
  check(full !== null && full.ok === true, `${edge.file}：full ok===true`, `code=${full?.code} ${full?.message ?? ''}`)
  check(typeof full?.version === 'string' && full.version.length > 0, `${edge.file}：0 字节/BOM 也有令牌`, `version=${JSON.stringify(full?.version)}`)
  check(full?.totalLines === edge.wantLines, `${edge.file}：totalLines 手写期望 ${edge.wantLines}`, `实际 ${full?.totalLines}`)
  say(`  · ${edge.file.padEnd(16)} ${edge.why}`)
  flushRow()
}

// 逐条点名几个"必须给出明确 code"的地方，避免上面的通用断言把结论说糊。
beginRow('edge-single.js', '边界')
const oneLine = guarded('edge-single.js lines[1,1]', () => readWith('const alpha = 1', { mode: 'lines', lines: [1, 1], filePath: 'edge-single.js' }))
check(oneLine?.ok === true && oneLine.text.includes('const alpha = 1'), '无结尾换行：那一行原样可读', JSON.stringify(oneLine?.text))
const past = guarded('edge-single.js lines[2,2]', () => readWith('const alpha = 1', { mode: 'lines', lines: [2, 2], filePath: 'edge-single.js' }))
check(past?.ok === false && past.code === 'READ_OUT_OF_RANGE', '越过末行：READ_OUT_OF_RANGE', `code=${JSON.stringify(past?.code)}`)
const emptySearch = guarded('edge-empty.js search', () => readWith('', { mode: 'search', search: 'alpha', filePath: 'edge-empty.js' }))
check(emptySearch?.ok === false && typeof emptySearch.code === 'string', '0 字节文件里找不到词：明确 code', `code=${JSON.stringify(emptySearch?.code)}`)
const bomOnly = guarded('edge-bom.js full', () => readWith('\uFEFF', { mode: 'full', filePath: 'edge-bom.js', byteOrderMark: true }))
check(bomOnly?.ok === true && bomOnly.text.includes('\uFEFF'), '只有 BOM 的文件：那一个 U+FEFF 就是内容', JSON.stringify(bomOnly?.text?.slice(0, 20)))
flushRow()

beginRow('edge-i18n.py', '边界')
const i18nText = EDGE.find((e) => e.file === 'edge-i18n.py').text
const i18n = guarded('edge-i18n.py lines[1,5]', () => readWith(i18nText, { mode: 'lines', lines: [1, 5], filePath: 'edge-i18n.py' }))
check(i18n?.ok === true, 'emoji/CJK：整段可读', `code=${i18n?.code}`)
check(typeof i18n?.text === 'string' && i18n.text.includes('🎉'), 'emoji 原样返回（没有被替换成 ?）')
check(typeof i18n?.text === 'string' && i18n.text.includes('中文注释'), '中日韩原样返回')
check(typeof i18n?.text === 'string' && i18n.text.includes('e\u0301'), '组合字符原样返回（不做归一——本文件不声称做了归一）')
const i18nMap = guarded('edge-i18n.py map', () => readWith(i18nText, { mode: 'map', filePath: 'edge-i18n.py' }))
check((i18nMap?.symbols ?? 0) >= 1, '非 ASCII 注释不妨碍建符号表', `symbols=${i18nMap?.symbols}`)
flushRow()

beginRow('edge-tabs.md', '边界')
const tabs = guarded('edge-tabs.md lines[1,6]', () => readWith('# alpha\tbeta\n\n\n\n- gamma\n', { mode: 'lines', lines: [1, 6], filePath: 'edge-tabs.md' }))
check(typeof tabs?.text === 'string' && tabs.text.includes('\t'), '制表符原样保留（没有被展开成空格）')
check(tabs?.totalLines === 6, '连续空行按行计数（含末尾换行带来的空行）', `totalLines=${tabs?.totalLines}`)
flushRow()

beginRow('edge-lonecr.js', '边界')
const loneCr = guarded('edge-lonecr.js lines[2,2]', () => readWith('const alpha = 1\rconst beta = 2', { mode: 'lines', lines: [2, 2], filePath: 'edge-lonecr.js' }))
check(loneCr?.ok === false && loneCr.code === 'READ_OUT_OF_RANGE', '单 \\r 文件整份算一行：读侧明确拒绝', `code=${JSON.stringify(loneCr?.code)}`)
refusalCheck(
  'edge-lonecr.js 编辑',
  () => planHunks('const alpha = 1\rconst beta = 2', [{ lines: [2, 2], replace: LINE_MARK }], 'edge-lonecr.js'),
  /^LOCATOR_/,
)
flushRow()

// ── D 寻址收敛层与令牌语义 ──────────────────────────────────────────────────
section('D 行区间收敛层（args.lineRangeOf）与令牌语义')

beginRow('lineRangeOf', '收敛')
const RANGE_SHAPES = [
  [{ lines: [4, 6] }, 4, 6],
  [{ lines: '4,6' }, 4, 6],
  [{ lines: '4-6' }, 4, 6],
  [{ lines: '4 6' }, 4, 6],
  [{ lines: 4 }, 4, 4],
  [{ start_line: 4, end_line: 6 }, 4, 6],
  [{ lines: { start: 4, end: 6 } }, 4, 6],
]
for (const [input, start, end] of RANGE_SHAPES) {
  const r = lineRangeOf(input)
  check(
    r !== undefined && r.start === start && r.end === end,
    `lineRangeOf(${JSON.stringify(input)}) == {${start},${end}}`,
    `实际 ${JSON.stringify(r)}`,
  )
}
check(lineRangeOf({ lines: 'abc' }) === undefined, "写坏的行区间：'abc' 不猜，返回 undefined", JSON.stringify(lineRangeOf({ lines: 'abc' })))
check(lineRangeOf({}) === undefined, '完全没给行区间：返回 undefined，交给上层报缺参数')
check(gaveLineAddress({ lines: 'abc' }) === true, '给了但解析不出来：gaveLineAddress 仍为 true（据此报"行区间写坏了"）')
flushRow()

beginRow('PATCH_NO_ADDRESS', '收敛')
const jsText = buildText(FIXTURES[0])
refusalCheck('无任何寻址的 hunk', () => planHunks(jsText, [{ replace: LINE_MARK }], 'a.js'), /^PATCH_NO_ADDRESS$/)
let noAddressMessage = ''
try {
  planHunks(jsText, [{ replace: LINE_MARK }], 'a.js')
} catch (error) {
  noAddressMessage = String(error?.message ?? '')
}
check(noAddressMessage.includes('target'), '无寻址的报错点名可选的四层地址', JSON.stringify(noAddressMessage))
refusalCheck('行区间写坏（lines:"abc"）', () => planHunks(jsText, [{ lines: 'abc', replace: LINE_MARK }], 'a.js'), /^PATCH_NO_ADDRESS$/)
// 坏掉的 lines 必须走 LINE_ADDRESS_HINT 那条分支，而不是笼统的"缺地址"
let badRangeMessage = ''
try {
  planHunks(jsText, [{ lines: 'abc', replace: LINE_MARK }], 'a.js')
} catch (error) {
  badRangeMessage = String(error?.message ?? '')
}
check(badRangeMessage !== noAddressMessage, '行区间写坏时的说明与"完全没给地址"不同', JSON.stringify(badRangeMessage))
flushRow()

beginRow('令牌语义', '令牌')
const tokenA = readWith(jsText, { mode: 'full', filePath: 'a.js' })
const tokenB = readWith(jsText, { mode: 'full', filePath: 'a.js' })
const tokenC = readWith(`${jsText}\n// tail`, { mode: 'full', filePath: 'a.js' })
const tokenBom = readWith(jsText, { mode: 'full', filePath: 'a.js', byteOrderMark: true })
check(tokenA.version === tokenB.version, '同一份内容：令牌稳定')
check(tokenA.version !== tokenC.version, '内容多了 7 个字节：令牌必须变（否则 changed 会说"没变"）')
check(tokenA.version !== tokenBom.version, '只差一个 BOM：令牌必须不同（令牌是内容+BOM 的指纹）')
const first = readWith(jsText, { mode: 'changed', filePath: 'a.js' })
check(typeof first.version === 'string' && first.version.length > 0, 'changed 首读也给令牌（无基准 ≠ 无令牌）', `version=${JSON.stringify(first.version)} note=${first.note}`)
check(first.version === tokenA.version, 'changed 首读的令牌与 full 同值（同一把尺子）')
const again = readWith(jsText, { mode: 'changed', since: first.version, filePath: 'a.js' })
check(again.ok === true && again.note === 'no change since that version', '把令牌传回去：changed 说"没变"', `note=${again.note}`)
const altered = readWith(`${jsText}\n// tail`, { mode: 'changed', since: first.version, filePath: 'a.js' })
check(altered.ok === true && altered.version !== first.version && typeof altered.text === 'string', '内容变了：changed 给出变更窗口', `note=${altered.note}`)
flushRow()

// ── 汇总 ────────────────────────────────────────────────────────────────────
section('汇总')
flushRow()
const failed = results.filter((r) => !r.ok)
say(`夹具 ${FIXTURES.length} 个 · 索引格式 ${indexedN} 个 · 未索引 ${FIXTURES.length - indexedN} 个（其中清单点名而引擎无语言定义 ${gapN} 个）`)
say(`没有符号可断言的格式（只验未索引兜底，符号断言明确不适用）：`)
say(`  ${FIXTURES.filter((f) => !f.indexed).map((f) => f.file).join(' ')}`)
say(`有符号但 target= 被设计拒绝（BATCH 无终结规则，span 不完整）：${FIXTURES.filter((f) => f.indexed && f.sym === null).map((f) => f.file).join(' ')}`)
say(`断言总数 ${results.length}，失败 ${failed.length}`)

if (failed.length > 0) {
  say('')
  say('失败明细：')
  for (const f of failed.slice(0, 60)) say(`  FAIL ${f.label}${f.detail === '' ? '' : `  ${f.detail}`}`)
  if (failed.length > 60) say(`  …另有 ${failed.length - 60} 条`)
}

say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
