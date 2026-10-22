/**
 * map-value.mjs —— map 现在选出来的 24 个符号，"有用"的比例是多少？
 *
 * 上一轮发现 map 停在 24 个符号，而 400 个函数的文件里有 800 个符号（只给了 3%）。
 * 但"给得少"不一定是问题——**给错**才是。所以要先量：
 * 现在按声明顺序取前 24 个，其中有多少是模型真正可能需要寻址的？
 *
 * 判定"有用"的口径（都用现有索引能算出来，不引入新概念）：
 *   · 顶层导出        —— 最可能被改
 *   · 顶层 function/class —— 其次
 *   · 嵌套 function   —— 再次
 *   · 函数内 variable —— 基本不需要（`const v = ...` 这类，重名率高）
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

/** 给符号分级：级别越高越值得进地图。 */
function rank(s, lines) {
  const own = lines[s.startLine - 1] ?? ''
  const isExported = /\bexport\b/.test(own)
  const top = s.enclosing === null || s.enclosing === undefined
  const structural = s.kind === 'function' || s.kind === 'class' || s.kind === 'type' || s.kind === 'interface'
  if (top && isExported) return { level: 3, why: '导出' }
  if (top && structural) return { level: 2, why: '顶层结构' }
  if (!top && structural) return { level: 1, why: '嵌套结构' }
  if (top) return { level: 1, why: '顶层变量' }
  return { level: 0, why: '函数内局部量' }
}

say('=== 现状：按声明顺序取前 24 个，它们值多少 ===')
say(['文件', '总符号', '前24中 L3', 'L2', 'L1', 'L0(噪声)', '噪声占比'].map((s) => s.padEnd(12)).join(''))
say('-'.repeat(84))

let totFirst = 0
let totNoise = 0
for (const f of CORPUS) {
  if (!fs.existsSync(f)) continue
  const src = fs.readFileSync(f, 'utf8')
  const lines = src.split('\n')
  const all = listSymbols(indexStructure(src, langOf(f)))
  const first24 = all.slice(0, 24)
  const byLevel = { 0: 0, 1: 0, 2: 0, 3: 0 }
  for (const s of first24) byLevel[rank(s, lines).level] += 1
  totFirst += first24.length
  totNoise += byLevel[0]
  say(
    [
      path.basename(path.dirname(path.dirname(f))).padEnd(12),
      String(all.length).padEnd(12),
      String(byLevel[3]).padEnd(12),
      String(byLevel[2]).padEnd(12),
      String(byLevel[1]).padEnd(12),
      String(byLevel[0]).padEnd(12),
      `${((byLevel[0] / first24.length) * 100).toFixed(0)}%`.padEnd(12),
    ].join(''),
  )
}

say('')
say(`前 24 个符号合计 ${totFirst} 个，其中函数内局部量（L0）${totNoise} 个 = ${((totNoise / totFirst) * 100).toFixed(0)}%`)

say('')
say('=== 如果按"级别优先"重排，前 24 个会是什么 ===')
let better = 0
let betterNoise = 0
for (const f of CORPUS) {
  if (!fs.existsSync(f)) continue
  const src = fs.readFileSync(f, 'utf8')
  const lines = src.split('\n')
  const all = listSymbols(indexStructure(src, langOf(f)))
  const sorted = [...all].sort((a, b) => rank(b, lines).level - rank(a, lines).level || a.startLine - b.startLine)
  const top = sorted.slice(0, 24)
  const l0 = top.filter((s) => rank(s, lines).level === 0).length
  better += top.length
  betterNoise += l0
}
say(`重排后前 24 个里 L0 ${betterNoise} 个 = ${((betterNoise / better) * 100).toFixed(0)}%（原顺序 ${((totNoise / totFirst) * 100).toFixed(0)}%）`)

say('')
say('=== 抽样：一个真实文件的前 12 行地图 ===')
const demo = CORPUS[2]
if (fs.existsSync(demo)) {
  const src = fs.readFileSync(demo, 'utf8')
  const lines = src.split('\n')
  const all = listSymbols(indexStructure(src, langOf(demo)))
  say(`文件: ${path.basename(path.dirname(path.dirname(demo)))}  ${all.length} 个符号`)
  say('  现状（声明顺序）:')
  for (const s of all.slice(0, 12)) say(`    ${rank(s, lines).why.padEnd(12)} ${s.kind} ${s.name}`)
  const sorted = [...all].sort((a, b) => rank(b, lines).level - rank(a, lines).level || a.startLine - b.startLine)
  say('  按级别重排:')
  for (const s of sorted.slice(0, 12)) say(`    ${rank(s, lines).why.padEnd(12)} ${s.kind} ${s.name}`)
}
