/**
 * digest-feasibility.mjs —— 先量："看懂一个文件"到底需要什么？
 *
 * 这是对 read 的核心质疑。模型说"我读一下这个文件"，背后的意图通常是四种之一：
 *   a. 我要改其中一处        → 需要那一处 + 上下文
 *   b. 我要看懂它怎么运作    → 需要结构、导出、依赖，**不需要每个函数体**
 *   c. 我要找某个东西        → 需要命中行
 *   d. 我要通读一遍          → 极少，且通常是为了 b
 *
 * 旧 read 对四种意图都给全文。我已解决 a/c。这一版量 b：**一个"结构摘要"能有多小、
 * 又能保住多少信息**？
 *
 * 摘要候选字段（都能从现有结构索引 + 词法统计算出，零新依赖）：
 *   · 规模：行数、符号数
 *   · 导出/公开面：export 出来的名字
 *   · 每个函数的**签名行**（不含函数体）
 *   · 依赖邻接：这个文件调用了哪些外部符号、被谁调用（同仓库范围内）
 *   · 控制流密度：分枝/循环个数的粗量——用来判断"这函数复不复杂"
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexStructure, langOf, listSymbols } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const NM = 'E:\\software\\npmlocal\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'
const CORPUS = [
  'dsh-tool-todo/lib/index.js',
  'dsh-fs-observation-policy/lib/index.js',
  'dsh-tool-fs/lib/index.js',
  'dsh-fs-local/lib/index.js',
  'dsh-tool-subagent/lib/index.js',
  'dsh-skill-filesystem/lib/index.js',
  'dsh-agent-presets/lib/index.js',
  'dsh-tool-pwsh/lib/index.js',
].map((r) => path.join(NM, r))

const T = (s) => Math.round(String(s).length / 3.3)

/** 结构摘要：不使用函数体，只使用签名与名字。 */
function digest(src, file) {
  const lines = src.split('\n')
  const lang = langOf(file)
  if (lang === null) return null
  const index = indexStructure(src, lang)
  const syms = listSymbols(index)

  // 导出面：`export` 出现在符号起点之前那一行或同一行
  const exported = []
  for (const s of syms) {
    const line = lines[s.startLine - 1] ?? ''
    const prev = lines[s.startLine - 2] ?? ''
    if (/\bexport\b/.test(line) || /\bexport\b/.test(prev)) exported.push(`${s.kind} ${s.name}`)
  }

  // 签名：符号起点那一行，裁到 `{` 或行尾
  const signatures = syms
    .filter((s) => s.kind === 'function' || s.kind === 'class')
    .map((s) => {
      const raw = (lines[s.startLine - 1] ?? '').trim()
      const cut = raw.indexOf('{')
      const sig = (cut >= 0 ? raw.slice(0, cut) : raw).trim().replace(/\s+/g, ' ')
      return `${s.startLine}-${s.endLine} ${sig.length > 76 ? `${sig.slice(0, 76)}…` : sig}`
    })

  // 分支/循环粗量：判断复杂度，不需要函数体细节
  const control = (src.match(/\b(if|for|while|switch|catch)\b/g) ?? []).length

  // 依赖邻接：文件里出现的外部标识符（点号调用 / import 来源）
  const imports = [...src.matchAll(/(?:import\s[^'"]*from\s|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  const called = new Set()
  for (const m of src.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) called.add(m[1])
  const own = new Set(syms.map((s) => s.name))
  const external = [...called].filter((c) => !own.has(c) && !['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof'].includes(c))

  return { lines: lines.length, symbols: syms.length, exported, signatures, control, imports, external, bytes: src.length }
}

say('=== 结构摘要 vs 全文：信息量与体量 ===')
say(
  ['文件', '全文token', '摘要token', '压缩比', '导出', '函数', '外部调用'].map((s) => s.padEnd(13)).join(''),
)
say('-'.repeat(88))

let fullSum = 0
let digSum = 0
for (const f of CORPUS) {
  if (!fs.existsSync(f)) continue
  const src = fs.readFileSync(f, 'utf8')
  const d = digest(src, f)
  const digestText = [
    `${d.lines} lines · ${d.symbols} symbols · ${d.control} control-flow`,
    `exported: ${d.exported.join(', ') || '(none)'}`,
    `imports: ${d.imports.join(', ') || '(none)'}`,
    `externals: ${d.external.slice(0, 14).join(', ')}`,
    ...d.signatures,
  ].join('\n')
  const name = path.basename(path.dirname(path.dirname(f)))
  fullSum += T(src)
  digSum += T(digestText)
  say(
    [
      name.padEnd(13),
      String(T(src)).padEnd(13),
      String(T(digestText)).padEnd(13),
      `${(T(src) / T(digestText)).toFixed(1)}x`.padEnd(13),
      String(d.exported.length).padEnd(13),
      String(d.signatures.length).padEnd(13),
      String(d.external.length).padEnd(13),
    ].join(''),
  )
}

say('')
say(`合计：全文 ${fullSum} token → 摘要 ${digSum} token（压缩 ${(fullSum / digSum).toFixed(1)}x）`)
say('')
say('判读：')
say('  · 若压缩比在 10x 以上，说明"看懂这个文件"根本不需要全文——')
say('    旧 read 让模型为"理解"付了"复现"的钱。')
say('  · 摘要里的签名行是关键：它让模型知道每个函数**收发什么**，而不必看实现。')
say('  · 摘要仍受 8192 字符预算约束，因此也要有超量时的显式截断——与内容模式同一契约。')

// 抽样展示一个摘要
const demo = CORPUS[1]
if (fs.existsSync(demo)) {
  const src = fs.readFileSync(demo, 'utf8')
  const d = digest(src, demo)
  say('')
  say(`=== 摘要样例（${path.basename(path.dirname(path.dirname(demo)))}）===`)
  say(`  ${d.lines} lines · ${d.symbols} symbols · ${d.control} control-flow`)
  say(`  exported: ${d.exported.join(', ') || '(none)'}`)
  say(`  imports:  ${d.imports.join(', ') || '(none)'}`)
  say(`  externals: ${d.external.slice(0, 12).join(', ')}`)
  for (const s of d.signatures.slice(0, 8)) say(`  ${s}`)
}
