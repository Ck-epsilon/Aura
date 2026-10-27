/**
 * index-scaling-test —— 结构索引的**归属归因（`enclosing`）不再二次**（蓝图 fs-contract-v2 / 施工单元 C59）。
 *
 * ## 命题（施工单终态）
 *
 * 结构索引的耗时**对规模不再是超线性的**：100000 符号档冷索引 ≤ 2 秒；并且 `enclosing` 字段与
 * 改动前**逐条相同**（那是给别人用的字段，语义一个字都不许动）。
 *
 * ## 施工前实测的悬崖（这一件就是为它立的）
 *
 * 内容形态 = 每行一个符号（`export const vN = N;` × N 行），冷 = 每次都拿一个全新的引擎模块实例
 * （`import('…?scaling=N')`，模块级缓存必空）。改前本机读数：
 *
 *     N（符号=行）   冷索引        µs/行
 *          5000      110.8 ms      22.2
 *         10000      382.2 ms      38.2
 *         20000     1311.3 ms      65.6
 *         40000     7081.4 ms     177.0
 *        100000    67579.0 ms     675.8
 *
 * 每行成本随规模上升 ⇒ 超线性。而**同样行数、零符号**的文件（每行 `total += vN;`）是平的
 * （20000 行 106.7 ms / 5.3 µs/行；40000 行 133.7 ms / 3.3 µs/行）——所以问题在符号处理，
 * 不在扫描器。
 *
 * ## 根因与改法（为什么是这一段）
 *
 * 根因是 `buildStructure` 尾段的归属归因：每个符号都扫一遍**按宽度排序的整张符号表**。平坦文件里
 * 没有任何符号包含别的符号 ⇒ 每个符号都扫满全表 ⇒ 完整的 O(n²)。`--cpu-prof` 行级 tick 把账算死：
 * 40000 符号档 `buildStructure` 自身 3763 个采样点里，那段的三行占 **3732 个（99.2%）**，而
 * tokenize / matchRule / matchBrackets / declarationSpan 加起来不到 1%。
 *
 * 改法 = 按 `startTok` 扫掠 + 一棵按 `endTok` 的后缀最小值树（Fenwick），O(n log n)。
 * 算法、逐条等价性论证、以及「区间重叠但不包含时给出什么」，写在 `struct-core.mjs` 的
 * `attributeEnclosing` 上方那一段里。
 *
 * ## 判据（段）
 *
 *   A  **10 万符号档冷索引 ≤ 2 秒**（贴原始毫秒），且这一档真的建出了 100000 个符号；
 *      顺带钉住「第一次调用真的是冷路径」（同一实例的第二次调用必须快一个量级）
 *   B  **缩放**：5000 / 10000 / 20000 / 40000 / 100000 五档，**每行成本不再随规模上升**
 *      （末档 ≤ 首档 × 1.5，且五档里最差的一档也在这条线内）。改前这一条是 30.4 倍，必红。
 *   C  **语义等价**：`enclosing` 逐符号比对必须 **0 处不一致**。三个子面：
 *        C1 真实语料（本目录最大的 10 个 `*.mjs`，2000+ 个符号、1200+ 个非空 `enclosing`）；
 *        C2 钉住的形状（**交叉区间** / 同 start / 同 end / 等宽 / 空文件 / 单符号 / CRLF /
 *           7 种语言的小样本）+ 它们的确定性变异；
 *        C3 确定性 token 汤模糊（2000 例），并**自证覆盖**：必须真的出现过「重叠但不包含」的
 *           区间对，否则这一条判「覆盖丢了」而不是默默变绿。
 *       Oracle 是**改前那段判据的逐字照抄**（见 `enclosingOracle`）——它不是「另一个实现」，
 *       它就是被冻结的语义本身。
 *   D  **对照**：同样行数但没有符号的文件仍走平的那条线（证明优化没把扫描器改坏）。
 *   E  **登记进闸**：本文件必须在 `build/release-check.mjs` 的 `SUITES` 里（按登记行形态匹配），
 *      且自身有退出码接线。
 *
 * ## 变异反证（这一件真的会红吗）
 *
 * 把 `attributeEnclosing` 换回施工前那段嵌套扫描 ⇒ **段A 与段B 当场红并点名**（段A 会印出
 * 50 秒量级的原始毫秒与 2000 ms 的上限；段B 会印出末档/首档的每行成本与 1.5 倍这条线）。
 * 段C 不受影响（语义没变，本来就该是绿的）——这正是「先保语义、再谈速度」的形状：
 * 速度那条线会红，语义那条线不动。
 *
 * ## 为什么段C 的 oracle 长这样
 *
 * 它逐字照抄改前那 15 行（`byWidth` 排序 + 每个符号扫全表）。用「另一个更聪明的实现」当 oracle
 * 会把两个盲区一起藏起来；这里的 oracle 不需要聪明，它需要**就是原来那个语义**。代价是 O(n²)，
 * 因此只喂真实语料里 ≤ 4000 符号的文件与短样本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { langOf, indexStructure } from './struct-core.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const SELF = path.join(here, 'index-scaling-test.mjs')
const GATE = path.join(ROOT, 'build', 'release-check.mjs')
const CORE_URL = pathToFileURL(path.join(here, 'struct-core.mjs')).href

/**
 * 把本套件的索引缓存额度**钉死**。
 *
 * 默认额度按"当时的可用内存 / 16"算（上下夹住），而闸里同时跑着别的进程：内存紧的时候
 * 额度可能装不下 10 万符号那一档，于是"同一实例的第二次调用命中缓存"退化成"又解析了一遍"，
 * 段A 测的就不再是算法，而是这台机器当时剩下多少内存（实测：同一份代码，单独跑热 10 ms，
 * 闸里某一轮热 487 ms ⇒ 误红）。256 MiB 是额度常量上限，与算法无关。
 *
 * 只有动态创建的引擎实例（`freshCore()`）读这个变量，而它们都在下面才创建，所以这行有效。
 */
process.env.AURA_INDEX_CACHE_MB = '256'

/** 每行一个符号的形态（施工单上的那个悬崖）。 */
const symbolSrc = (n) => {
  const out = new Array(n)
  for (let i = 0; i < n; i += 1) out[i] = `export const v${i} = ${i};`
  return `${out.join('\n')}\n`
}
/** 同样行数、**零符号**的对照形态。 */
const plainSrc = (n) => {
  const out = new Array(n)
  for (let i = 0; i < n; i += 1) out[i] = `total += v${i};`
  return `${out.join('\n')}\n`
}

let freshSeq = 0
/**
 * 一个**全新**的引擎模块实例：模块级 `INDEX_CACHE` 必然为空 ⇒ 它的第一次调用就是冷路径。
 * （ESM 的模块表按完整 URL 索引，查询串一换就是另一个实例。与 `index-cache-test.mjs` 同一手法。）
 */
const freshCore = () => import(`${CORE_URL}?scaling=${(freshSeq += 1)}`)

const ms = (h) => Number(h) / 1e6
/** 索引一份内容的冷读数（毫秒）＋索引本身。 */
async function coldIndex(src, ext, core) {
  const instance = core ?? (await freshCore())
  const lang = instance.langOf(`x${ext}`)
  const t0 = process.hrtime.bigint()
  const idx = instance.indexStructure(src, lang)
  return { ms: ms(process.hrtime.bigint() - t0), idx, instance }
}

// ── 段A / 段B：五档缩放 ──────────────────────────────────────────────────────
/** 判据线上的那个倍率：每行成本允许在首档之上的最大倍数（改前是 30.4 倍）。 */
const SCALE_TOLERANCE = 1.5
/** 段A 的硬上限（毫秒）：施工单终态。 */
const BUDGET_100K_MS = 2000
const SIZES = [5000, 10000, 20000, 40000, 100000]

say('[段A/段B 量测] 冷索引——每次都拿一个全新模块实例（模块级缓存必空）')
say('  内容 = 每行一个符号：`export const vN = N;`')
const rows = []
for (const n of SIZES) {
  const src = symbolSrc(n)
  const { ms: took, idx, instance } = await coldIndex(src, '.mjs')
  rows.push({ n, ms: took, usPerLine: (took * 1000) / n, symbols: idx.symbols.length, instance })
  say(`  ${String(n).padStart(6)} 行  ${took.toFixed(1).padStart(9)} ms  ${((took * 1000) / n).toFixed(1).padStart(7)} µs/行  （${idx.symbols.length} 符号）`)
}

const last = rows[rows.length - 1]
check(
  rows.length === SIZES.length && rows.every((r) => r.symbols === r.n),
  '段B 五档都真的建出了 N 个符号（量的是符号处理，不是空气）',
  rows.map((r) => `${r.n}→${r.symbols}`).join(' '),
)
check(
  last.symbols === 100000,
  '段A 的 10 万档确实是 100000 个符号',
  `实建 ${last.symbols} 个`,
)
check(
  last.ms <= BUDGET_100K_MS,
  `段A 100000 符号档冷索引 ≤ ${BUDGET_100K_MS} ms`,
  `实测 ${last.ms.toFixed(1)} ms（改前同机 67579.0 ms）`,
)

/**
 * 冷路径自证：同一个实例再问一次，命中记忆化缓存 ⇒ 必须快一个量级。
 * 没有这一条，「冷读数」可能只是「这一档本来就慢」——测的东西就不是冷索引了。
 */
{
  const t0 = process.hrtime.bigint()
  last.instance.indexStructure(symbolSrc(last.n), last.instance.langOf('x.mjs'))
  const hot = ms(process.hrtime.bigint() - t0)
  check(
    hot <= last.ms / 4,
    '段A 的第一次调用确实是**冷路径**（同一实例的第二次调用快一个量级 ⇒ 那次没重新解析）',
    `冷 ${last.ms.toFixed(1)} ms / 热 ${hot.toFixed(2)} ms`,
  )
}

const firstUs = rows[0].usPerLine
const worstUs = Math.max(...rows.map((r) => r.usPerLine))
check(
  last.usPerLine <= firstUs * SCALE_TOLERANCE,
  `段B 每行成本不再随规模上升：末档 ≤ 首档 × ${SCALE_TOLERANCE}`,
  `首档 ${firstUs.toFixed(1)} µs/行（${rows[0].n}） ×${SCALE_TOLERANCE} = ${(firstUs * SCALE_TOLERANCE).toFixed(1)}；末档 ${last.usPerLine.toFixed(1)} µs/行（${last.n}）`,
)
check(
  worstUs <= firstUs * SCALE_TOLERANCE,
  `段B 五档里最差的一档也在这条线内（没有哪一档在中途跳出去）`,
  `最差 ${worstUs.toFixed(1)} µs/行；全档 ${rows.map((r) => r.usPerLine.toFixed(1)).join(' / ')}`,
)

// ── 段C：语义等价 ───────────────────────────────────────────────────────────
/**
 * **改前那段判据的逐字照抄**——被冻结的语义本身，不是「另一个实现」。
 * 对每个符号取「按宽度升序（并列按原序）第一个满足包含且严格更宽的」符号名。
 */
function enclosingOracle(symbols) {
  const byWidth = [...symbols].sort((a, b) => a.endTok - a.startTok - (b.endTok - b.startTok))
  const out = []
  for (const s of symbols) {
    let enclosing = null
    for (const cand of byWidth) {
      if (cand === s) continue
      if (cand.startTok <= s.startTok && cand.endTok >= s.endTok && cand.endTok - cand.startTok > s.endTok - s.startTok) {
        enclosing = cand
        break
      }
    }
    out.push(enclosing === null ? null : enclosing.name)
  }
  return out
}

/** oracle 逐个符号比；返回不一致的处数。 */
function compareEnclosing(idx) {
  const want = enclosingOracle(idx.symbols)
  let bad = 0
  for (let i = 0; i < idx.symbols.length; i += 1) {
    if (idx.symbols[i].enclosing !== want[i]) {
      bad += 1
      if (bad <= 3) say(`    ✗ ${idx.symbols[i].name}  #${i}: 改前语义 ${JSON.stringify(want[i])} / 实测 ${JSON.stringify(idx.symbols[i].enclosing)}`)
    }
  }
  return bad
}

/** 「重叠但不包含」的区间对：A.start < B.start ≤ A.end < B.end（或镜像）。 */
function crossingPairs(symbols) {
  let c = 0
  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const a = symbols[i]
      const b = symbols[j]
      if ((a.startTok < b.startTok && b.startTok <= a.endTok && a.endTok < b.endTok) ||
        (b.startTok < a.startTok && a.startTok <= b.endTok && b.endTok < a.endTok)) c += 1
    }
  }
  return c
}

/** oracle 是 O(n²)，给它一个上限；真实语料最大的文件远在这条线以内。 */
const ORACLE_SYMBOL_CAP = 4000

// C1 —— 真实语料
say('')
say('[段C1] 真实语料（本目录最大的 10 个 *.mjs）：`enclosing` 逐符号 vs 改前语义')
const corpus = fs.readdirSync(here)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => ({ f, size: fs.statSync(path.join(here, f)).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 10)

let c1Symbols = 0
let c1WithEnclosing = 0
let c1Bad = 0
let c1Files = 0
for (const { f } of corpus) {
  const abs = path.join(here, f)
  const idx = indexStructure(fs.readFileSync(abs, 'utf8'), langOf(abs))
  if (idx.symbols.length > ORACLE_SYMBOL_CAP) {
    say(`  … ${f} 符号 ${idx.symbols.length} 越过 oracle 上限 ${ORACLE_SYMBOL_CAP}，本段跳过`)
    continue
  }
  const bad = compareEnclosing(idx)
  const nonNull = idx.symbols.filter((s) => s.enclosing !== null).length
  c1Files += 1
  c1Symbols += idx.symbols.length
  c1WithEnclosing += nonNull
  c1Bad += bad
  say(`  ${bad === 0 ? '✓' : '✗'} ${f.padEnd(28)} 符号 ${String(idx.symbols.length).padStart(4)}  非空 enclosing ${String(nonNull).padStart(4)}  不一致 ${bad}`)
}
check(c1Files >= 5, '段C1 真实语料取到至少 5 个大文件', `实取 ${c1Files} 个`)
check(c1Symbols > 1000, '段C1 比对的符号数足够（不是拿几个符号糊过去）', `共 ${c1Symbols} 个符号`)
check(c1WithEnclosing > 500, '段C1 里非空 enclosing 的样本足够（比的是真答案，不是一片 null）', `非空 ${c1WithEnclosing} 个`)
check(c1Bad === 0, '段C1 真实语料上 `enclosing` 逐符号与改前语义**零不一致**', `比对 ${c1Symbols} 个符号，不一致 ${c1Bad} 处`)

// C2 —— 钉住的形状 + 变异
say('')
say('[段C2] 钉住的形状（交叉 / 同 start / 同 end / 等宽 / 边界）+ 确定性变异')
const PINNED = [
  // 这一条是**交叉区间**的真身（token 汤模糊里捞出来的，已复现）：两个符号重叠但不互相包含。
  { ext: '.hs', src: '| table : val -> table val def val val ] table \n     val table def def -> val def val \n : def => val val def def \n     def = table def async def val \n\t ' },
  { ext: '.hs', src: 'table def val [ table ) \n   val table val val \n   table = \n     def => table table table def table table val val \n     val table def def ' },
  { ext: '.hs', src: 'alpha :: Int -> Int\nalpha x = x + 1\nbeta :: Int -> Int\nbeta x = x + 2\n' },
  { ext: '.mjs', src: 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' },
  { ext: '.mjs', src: 'export function outer() {\n  const a = 1\n  function inner() {\n    const b = 2\n  }\n}\nexport const tail = 1\n' },
  { ext: '.mjs', src: 'function todos() {\n  const todos = 1\n}\nfunction todos() {\n  const todos = 2\n}\n' },
  { ext: '.mjs', src: 'export const alpha = () => {\n  export const beta = () => {\n' },
  { ext: '.mjs', src: '' },
  { ext: '.mjs', src: 'export const solo = 1;\n' },
  { ext: '.mjs', src: 'export const a = 1;\r\nexport const b = 2;\r\n' },
  { ext: '.py', src: 'def alpha():\n    x = 1\n    def beta():\n        y = 2\n    return y\n\ndef gamma():\n    pass\n' },
  { ext: '.rb', src: 'def alpha\n  x = 1\n  def beta\n    y = 2\n  end\nend\ndef gamma\nend\n' },
  { ext: '.lua', src: 'function alpha()\n  local x = 1\n  function beta()\n    local y = 2\n  end\nend\n' },
  { ext: '.sql', src: 'CREATE TABLE alpha (\n  id INTEGER\n);\nCREATE TABLE beta (\n  id INTEGER\n);\n' },
  { ext: '.go', src: 'package main\n\nfunc alpha() {\n\tx := 1\n\tfunc beta() {\n\t}\n}\n' },
  { ext: '.vim', src: 'function! Alpha()\n  let x = 1\nendfunction\nfunction! Beta()\nendfunction\n' },
  { ext: '.ex', src: 'defmodule Alpha do\n  def beta do\n    1\n  end\nend\n' },
]
/** 确定性变异：删一行 / 删一个闭符 / 截断 / 复制一行 —— 把跨度搞歪，逼出非嵌套形状。 */
const mutate = (src, k) => {
  const lines = src.split('\n')
  if (lines.length < 2) return src
  if (k % 4 === 0) {
    lines.splice(k % lines.length, 1)
  } else if (k % 4 === 1) {
    const i = k % lines.length
    lines[i] = lines[i].replace(/[})\]]/, '')
  } else if (k % 4 === 2) {
    return lines.slice(0, 1 + (k % lines.length)).join('\n')
  } else {
    const i = k % lines.length
    lines.splice(i, 0, lines[i])
  }
  return lines.join('\n')
}

let c2Cases = 0
let c2Symbols = 0
let c2Bad = 0
let c2Cross = 0
for (const p of PINNED) {
  const shapes = [p.src]
  for (let k = 0; k < 4; k += 1) shapes.push(mutate(p.src, k + p.ext.length))
  for (const src of shapes) {
    const idx = indexStructure(src, langOf(`x${p.ext}`))
    if (idx.symbols.length > ORACLE_SYMBOL_CAP) continue
    c2Cases += 1
    c2Symbols += idx.symbols.length
    c2Cross += crossingPairs(idx.symbols)
    c2Bad += compareEnclosing(idx)
  }
}
say(`  ${c2Cases} 个形状（${PINNED.length} 条钉住的 × 5：原样 + 4 种变异），共 ${c2Symbols} 个符号，交叉区间 ${c2Cross} 对`)
check(c2Cases >= 50, '段C2 形状数足够', `${c2Cases} 个`)
check(c2Bad === 0, '段C2 钉住的形状上 `enclosing` 与改前语义**零不一致**', `比对 ${c2Symbols} 个符号，不一致 ${c2Bad} 处`)

// C3 —— 确定性 token 汤模糊（自证覆盖）
say('')
say('[段C3] 确定性 token 汤模糊（种子固定，跨机器可复现）：碰非嵌套形状')
const WORDS = ['def', 'class', 'function', 'const', 'let', 'var', 'export', 'public', 'static', 'async', 'fn', 'func',
  'sub', 'module', 'package', 'create', 'table', 'select', 'insert', 'from', 'where', 'rpc', 'message', 'service',
  'enum', 'struct', 'impl', 'trait', 'interface', 'type', 'data', 'newtype', 'val', 'proc', 'lambda', 'and', 'or',
  'alpha', 'beta', 'gamma', 'todos', 'main', 'foo', 'bar', 'x', 'y', 'n', 'i']
const PUNCT = ['{', '}', '(', ')', '[', ']', ':', '=', ';', '.', ',', '=>', '->', '::', '|', '\n', '\n  ', '\n    ', '\n\t']
/** xorshift32：全部是 32 位整数运算 ⇒ 精确、可复现，与 V8 版本无关。 */
let seed = 20260215
const rnd = (n) => {
  seed ^= seed << 13
  seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5
  seed >>>= 0
  return seed % n
}
let c3Cases = 0
let c3Symbols = 0
let c3Bad = 0
let c3Cross = 0
let c3CrossCases = 0
const SOUP_CASES = 2000
for (let r = 0; r < SOUP_CASES; r += 1) {
  const len = 6 + rnd(40)
  let src = ''
  for (let k = 0; k < len; k += 1) src += rnd(3) === 0 ? `${PUNCT[rnd(PUNCT.length)]} ` : `${WORDS[rnd(WORDS.length)]} `
  const idx = indexStructure(src, langOf('x.hs'))
  c3Cases += 1
  c3Symbols += idx.symbols.length
  const cx = crossingPairs(idx.symbols)
  if (cx > 0) {
    c3CrossCases += 1
    c3Cross += cx
  }
  c3Bad += compareEnclosing(idx)
}
say(`  ${c3Cases} 例，共 ${c3Symbols} 个符号；交叉区间出现在 ${c3CrossCases} 例里、共 ${c3Cross} 对`)
check(c3Bad === 0, '段C3 模糊语料上 `enclosing` 与改前语义**零不一致**', `比对 ${c3Symbols} 个符号，不一致 ${c3Bad} 处`)
check(
  c3Cross + c2Cross > 0,
  '段C 的交叉覆盖**不是假设**：语料里真的出现了「重叠但不包含」的区间对',
  `段C2 ${c2Cross} 对 + 段C3 ${c3Cross} 对；若有朝一日归零 ⇒ 这一条判的是「覆盖丢了」，该去补形状而不是删断言`,
)
check(
  c1Bad + c2Bad + c3Bad === 0,
  '段C 汇总：三个子面合计 **0 处不一致**',
  `共比对 ${c1Symbols + c2Symbols + c3Symbols} 个符号（真实语料 + 钉住形状 + 模糊）`,
)

// ── 段D：对照（零符号的文件仍走平的那条线）────────────────────────────────────
say('')
say('[段D 对照] 同样行数、**零符号**（每行 `total += vN;`）')
const PLAIN_SIZES = [20000, 40000]
const plain = []
for (const n of PLAIN_SIZES) {
  const src = plainSrc(n)
  const { ms: took, idx } = await coldIndex(src, '.mjs')
  plain.push({ n, ms: took, usPerLine: (took * 1000) / n, symbols: idx.symbols.length, tokens: idx.tokens.length })
  say(`  ${String(n).padStart(6)} 行  ${took.toFixed(1).padStart(9)} ms  ${((took * 1000) / n).toFixed(1).padStart(7)} µs/行  （${idx.symbols.length} 符号 / ${idx.tokens.length} token）`)
}
check(
  plain.every((p) => p.symbols === 0 && p.tokens > 0),
  '段D 对照件确实是「零符号但真有 token」（不是空文件，也不是把符号藏起来的文件）',
  plain.map((p) => `${p.n}→符号${p.symbols}/token${p.tokens}`).join(' '),
)
check(
  plain[plain.length - 1].usPerLine <= plain[0].usPerLine * SCALE_TOLERANCE,
  `段D 扫描器那条线仍然是平的：零符号档 40000 行 ≤ 20000 行 × ${SCALE_TOLERANCE}`,
  `20000 ${plain[0].usPerLine.toFixed(1)} µs/行 → 40000 ${plain[plain.length - 1].usPerLine.toFixed(1)} µs/行`,
)
{
  const sym20 = rows.find((r) => r.n === 20000)
  const sym40 = rows.find((r) => r.n === 40000)
  check(
    sym40.usPerLine <= sym20.usPerLine * SCALE_TOLERANCE && plain[1].usPerLine <= plain[0].usPerLine * SCALE_TOLERANCE,
    `段D 有符号 / 零符号**两条线在 20000→40000 这一段都是平的**（优化没把扫描器改坏）`,
    `符号 ${sym20.usPerLine.toFixed(1)}→${sym40.usPerLine.toFixed(1)} µs/行；零符号 ${plain[0].usPerLine.toFixed(1)}→${plain[1].usPerLine.toFixed(1)} µs/行`,
  )
}

// ── 段E：登记进闸 + 退出码接线 ───────────────────────────────────────────────
say('')
say('[段E] 进闸登记与退出码接线')
const gateSrc = fs.readFileSync(GATE, 'utf8')
const registration = /\[\s*'[^']*'\s*,\s*'src\/locator-lab\/index-scaling-test\.mjs'\s*\]/
check(
  registration.test(gateSrc),
  '段E 本套件登记在 `build/release-check.mjs` 的 `SUITES` 里（按登记行形态匹配，不靠文件名）',
  `${path.relative(ROOT, GATE)} 里有 ['…', 'src/locator-lab/index-scaling-test.mjs']`,
)
const selfSrc = fs.readFileSync(SELF, 'utf8')
check(
  /process\.exitCode\s*=/.test(selfSrc),
  '段E 本套件自带退出码接线（判据红 ⇒ 进程非零退出，闸才拦得住）',
  '源码里有 process.exitCode =',
)
check(
  /通过/.test(selfSrc) && /\$\{/.test(selfSrc),
  '段E 本套件自带通过/失败汇总行（闸按这一行取摘要，§⑩ 的 S2 也是这个形态）',
  '源码里有带计数的「通过」汇总行',
)

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
say('')
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
}
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
process.exitCode = failed.length === 0 ? 0 : 1
