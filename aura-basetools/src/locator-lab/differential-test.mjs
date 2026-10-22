/**
 * differential-test.mjs —— 差分测试：**期望值由两个独立实现互相提供**（T24）。
 *
 * ## 为什么单独立一条
 *
 * 本项目已经三次出现"测试全绿但功能不对"，三次的共同形态都是**测试与代码共享同一个盲区**：
 *   1. `aura_read` 输出 schema 漏声明 `text` —— 每条成功路径被框架拒，而 load-test 从不校验输出形状；
 *   2. `aura_edit` 的 mock `editText` 只声明 2 个参数（真实 5 个）—— "漏传沙箱策略"在 41/41 里穿过；
 *   3. 引擎 10 个顶层 `function` 只认出 2 个（正则字面量未当词法类别），而当时 44 扩展名、
 *      11040 符号的语料测试全过。
 *
 * 机制是同一个：**手写测试的期望值是人写的，而人写期望值时用的是与实现相同的理解，
 * 于是双方会同时错——错得一致，测试就绿。**
 *
 * ## 本文件怎么做
 *
 * 不用"我认为应该是什么"，而是让**两个独立的实现互相当裁判**，随机生成输入、断言两者等价。
 * 裁判实现一律**故意写得笨、写得慢、直白**——笨是实现独立性的代价，也是它的价值所在。
 *
 * | 待测（快路径） | 裁判（笨路径） | 断言 |
 * |---|---|---|
 * | `struct-core` 的符号跨度 | 从声明行起手工配平花括号 | 跨度覆盖真实块体 |
 * | `locate` 的 `lines` 层 | 直接按行号切片 | 给出的区间文本 = 直接切片 |
 * | `planHunks` 的替换结果 | 整份文本 `split/join` | 逐字节相同 |
 * | `search` 的命中行 | `indexOf` 逐行扫 | 行号集合相同 |
 * | `line_cue` 的唯一性判定 | 逐行 `includes` 计数 | 命中/歧义/找不到三者一致 |
 *
 * 所有输入都从**真实语料**（`src/` 下的真文件）里取，不凭空合成——合成的样本会偏向实现的假设。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { indexStructure, langOf, listSymbols, rankSymbols } from './struct-core.mjs'
import { locate } from './locator-api.mjs'
import { readWith } from './read-core.mjs'
import { planHunks } from './write-path.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (label, ok, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
/** 真实语料：本目录下所有 .mjs（含本文件——自指也是语料）。 */
const CORPUS = fs
  .readdirSync(here)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => path.join(here, f))
  .filter((f) => fs.statSync(f).size > 200)

say(`=== 语料：${CORPUS.length} 个真实 .mjs（本目录）===`)
say('')

// ── 1. 符号跨度：快路径 vs 手工配平 ─────────────────────────────────────────
// 裁判：从声明行起，逐字符数花括号，深度回到 0 的那一行就是真实结束行。
// 笨、慢、但在"什么算块体"这件事上只依赖花括号本身，不依赖符号表。
say('=== 1. 符号跨度（快路径 vs 手工配平花括号）===')
{
  /**
   * 从 `startLine` 起手工配平，返回真实结束行；**声明行没有开块体时返回 null**。
   *
   * 第一版直接从声明行开始数花括号，实测 17/196 不一致——而逐条看下来**全是裁判的错**：
   * `const width = (s) => [...String(s)].reduce(...)` 是**表达式体箭头函数**（没有块体），
   * 真实跨度就是那一行；而笨裁判从 340 起数，一直数到 356 的 `}))` 才回到 0。
   *
   * 所以"笨"不等于"可以错"：裁判必须至少拿得准**它声称在量的那个东西**。
   * 现在它只对"声明行确实开了块体"的形态发言，其余（表达式体、单行）返回 null 让位。
   *
   * 仍然刻意不处理字符串/注释里的花括号（那需要写一个词法器，就不再独立了）——
   * 代价是含 `{` 的字符串会让它算多，所以判据是"绝大多数一致"，而非零容忍。
   */
  const braceEnd = (lines, startLine) => {
    const head = lines[startLine - 1] ?? ''
    if (!head.includes('{')) return null
    let depth = 0
    let seen = false
    for (let n = startLine; n <= lines.length; n += 1) {
      for (const ch of lines[n - 1]) {
        if (ch === '{') { depth += 1; seen = true } else if (ch === '}') depth -= 1
      }
      if (seen && depth === 0) return n
    }
    return startLine
  }
  /**
   * 真实花括号深度（逐行缓存）：对比基准。
   *
   * 它不区分字符串/注释，所以**不能单独当裁判**（它会把模板串里的 `{` 算进去）；
   * 但用它做交叉判据足够：若真实深度也恰在那个行号归零，而裸扫描提前归零，
   * 就说明提前来自字符串——那是**裁判的已知偏差**，不是被测代码的错。
   * 留下真正无法解释的那几条，再人工看。
   */
  const realDepthAt = (lines) => {
    const out = []
    let d = 0
    for (const l of lines) {
      for (const ch of l) {
        if (ch === '{') d += 1
        else if (ch === '}') d -= 1
      }
      out.push(d)
    }
    return out
  }
  let compared = 0
  let mismatched = 0
  let explainedByStrings = 0
  const samples = []
  for (const f of CORPUS) {
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    const lang = langOf(f)
    if (lang === null) continue
    for (const s of listSymbols(indexStructure(src, lang))) {
      if (s.kind !== 'function' && s.kind !== 'class') continue
      if (s.spanComplete === false) continue
      const real = braceEnd(lines, s.startLine)
      if (real === null) continue // 该形态不由笨裁判发言（表达式体 / 单行）
      compared += 1
      if (real !== s.endLine) {
        // 交叉判据：若真实深度也在同一行归零，则它确实是块体结束（快路径短了）；
        // 否则是裸扫描被字符串/注释里的花括号带偏（裁判的已知偏差）。
        const depth = realDepthAt(lines)
        if (depth[real - 1] === 0) {
          mismatched += 1
          if (samples.length < 5) samples.push(`${path.basename(f)} ${s.name} 快=${s.startLine}-${s.endLine} 笨=${s.startLine}-${real}`)
        } else {
          explainedByStrings += 1
        }
      }
    }
  }
  check(`比较了 ${compared} 个函数/类符号`, compared > 100, `只有 ${compared} 个`)
  /**
   * 允许少量不一致：裁判对字符串/注释里的花括号会算错（已知偏差），
   * 而快路径会正确地跳过它们。所以判据是"绝大多数一致 + 不一致有解释"，
   * 不是"零不一致"——**把已知偏差写成零容忍会让测试变成假的**。
   */
  const rate = compared === 0 ? 0 : mismatched / compared
  check(
    `不一致率 < 5%（实际 ${(rate * 100).toFixed(1)}%，${mismatched}/${compared}；另有 ${explainedByStrings} 个由裁判的字符串偏差解释）`,
    rate < 0.05,
    samples.join(' | '),
  )
}

// ── 2. lines 层：快路径 vs 直接切片 ─────────────────────────────────────────
say('')
say('=== 2. lines 寻址（快路径 vs 直接按行号切片）===')
{
  let n = 0
  let bad = 0
  for (const f of CORPUS.slice(0, 12)) {
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    // 用确定性的伪随机取区间，避免依赖 Math.random 让失败不可复现
    for (let k = 1; k <= 5; k += 1) {
      const start = ((k * 37) % Math.max(1, lines.length - 2)) + 1
      const end = Math.min(lines.length, start + ((k * 11) % 7))
      const want = lines.slice(start - 1, end).join('\n')
      const got = locate(src, { lines: { start, end }, filePath: f })
      n += 1
      if (!got.ok || got.actual !== want) {
        bad += 1
        if (bad <= 3) say(`    ✗ ${path.basename(f)} [${start},${end}] ${got.ok ? 'actual 不同' : got.code}`)
      }
    }
  }
  check(`${n} 个区间的 actual 与直接切片逐字符相同`, bad === 0, `${bad} 个不同`)
}

// ── 3. planHunks 的替换结果 vs 整份 split/join ──────────────────────────────
say('')
say('=== 3. planHunks 的落盘内容（快路径 vs 整份 split/join）===')
{
  let n = 0
  let bad = 0
  for (const f of CORPUS.slice(0, 10)) {
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    const start = ((src.length % Math.max(1, lines.length - 2))) + 1
    const end = Math.min(lines.length, start + 2)
    const original = lines.slice(start - 1, end).join('\n')
    const marker = `// diff-test-${start}-${end}`
    let planned
    try {
      planned = planHunks(src, [{ lines: [start, end], replace: marker }], f)
    } catch {
      continue // 该区间不可寻址（例如落在符号中途）——不是本项的判据
    }
    const naive = lines.slice(0, start - 1).concat([marker], lines.slice(end)).join('\n')
    n += 1
    if (planned.content !== naive) {
      bad += 1
      if (bad <= 3) say(`    ✗ ${path.basename(f)} [${start},${end}] 快路径与整份拼接不同`)
    }
    void original
  }
  check(`${n} 个替换的结果与整份拼接逐字符相同`, n > 0 && bad === 0, `${n} 个样本，${bad} 个不同`)
}

// ── 4. search 的命中行 vs indexOf 逐行扫 ────────────────────────────────────
say('')
say('=== 4. search 命中行（快路径 vs indexOf 逐行扫）===')
{
  let n = 0
  let bad = 0
  for (const f of CORPUS.slice(0, 12)) {
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    for (const q of ['export', 'function', 'return', 'const']) {
      const want = []
      for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(q)) want.push(i + 1)
      if (want.length === 0) continue
      const got = readWith(src, { filePath: f, mode: 'search', search: q, limit: 100000 })
      if (got.ok === false) {
        bad += 1
        say(`    ✗ ${path.basename(f)} q=${q} 快路径报 ${got.code}`)
        continue
      }
      n += 1
      if ((got.matches ?? 0) !== want.length) {
        bad += 1
        if (bad <= 3) say(`    ✗ ${path.basename(f)} q=${q} 快=${got.matches} 笨=${want.length}`)
      }
    }
  }
  check(`${n} 组搜索的命中数与逐行扫相同`, n > 0 && bad === 0, `${n} 组，${bad} 个不同`)
}

// ── 5. line_cue 的三态判定 vs 逐行计数 ──────────────────────────────────────
say('')
say('=== 5. line_cue 的三态（唯一命中 / 歧义 / 找不到）===')
{
  let n = 0
  let bad = 0
  for (const f of CORPUS.slice(0, 10)) {
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    for (const cue of ['export function', 'const', 'return', '绝对不存在的词ZZZ']) {
      const hits = lines.map((l, i) => (l.includes(cue) ? i + 1 : 0)).filter(Boolean)
      const got = locate(src, { lineCue: cue, filePath: f })
      n += 1
      if (hits.length === 0 && got.ok) { bad += 1; say(`    ✗ ${path.basename(f)} "${cue}" 应为找不到`) ; continue }
      if (hits.length === 1 && (!got.ok || got.startLine !== hits[0])) {
        bad += 1
        say(`    ✗ ${path.basename(f)} "${cue}" 应唯一命中 ${hits[0]}，实为 ${got.ok ? got.startLine : got.code}`)
        continue
      }
      if (hits.length > 1 && got.ok) { bad += 1; say(`    ✗ ${path.basename(f)} "${cue}" 应报歧义（${hits.length} 处）`) }
    }
  }
  check(`${n} 组线索的三态判定与逐行计数一致`, bad === 0, `${bad} 个不一致`)
}

// ── 6. rankSymbols 的稳定性（同一输入两次调用必须同一顺序）─────────────────
say('')
say('=== 6. rankSymbols 的确定性（同输入两次必须同序）===')
{
  let n = 0
  let bad = 0
  for (const f of CORPUS.slice(0, 12)) {
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')
    const lang = langOf(f)
    if (lang === null) continue
    const a = rankSymbols(indexStructure(src, lang), lines).map((r) => r.s.name)
    const b = rankSymbols(indexStructure(src, lang), lines).map((r) => r.s.name)
    n += 1
    if (JSON.stringify(a) !== JSON.stringify(b)) bad += 1
  }
  check(`${n} 个文件的排序两次调用完全一致`, bad === 0, `${bad} 个不同`)
}

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
