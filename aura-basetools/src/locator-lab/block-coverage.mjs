/**
 * block-coverage.mjs —— 量第二层的天花板：把**块体**也变成可寻址区域，覆盖率会到多少？
 *
 * 上一版测出"可精确寻址仅 17.8%"，但那个数反映的是**符号表窄**，不是符号寻址的极限：
 * 只索引了 function/class/const/var 这几类声明。而文件里的结构远不止这些——
 * 有 if/for/while/try 块、数组字面量、对象字面量、语句序列。
 *
 * 本脚本不实现任何东西，只回答：**如果把这些块体也编号进索引，覆盖率能到多少？**
 * 覆盖不了的剩余部分是什么？——这决定了还需不需要三四层。
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexStructure, langOf } from './struct-core.mjs'

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

function isBlockStart(lines, i) {
  if (i === 0) return true
  const prev = lines[i - 1].trim()
  const cur = lines[i]
  if (cur.trim().length === 0) return false
  if (prev.length === 0) return true
  if (/[;{}]$/.test(prev)) return true
  if (/^\s*(if|for|while|switch|try|catch|return|const|let|var|function|class|export|import)\b/.test(cur) && /;$/.test(prev)) return true
  return false
}

let totalBlocks = 0
let preciseNow = 0
let preciseWithLines = 0
let coveredBySymbolSpan = 0
const gapByKind = new Map()
const layerUse = { symbol: 0, lines: 0, none: 0 }

for (const file of CORPUS) {
  if (!fs.existsSync(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split('\n')
  const index = indexStructure(src, langOf(file))

  const symbolStarts = new Set(index.symbols.map((s) => s.startLine))
  const allSymbolLines = new Set()
  for (const s of index.symbols) {
    for (let l = s.startLine; l <= s.endLine; l += 1) allSymbolLines.add(l)
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlockStart(lines, i)) continue
    const line = i + 1
    totalBlocks += 1
    if (symbolStarts.has(line)) {
      preciseNow += 1
      layerUse.symbol += 1
    }
    if (allSymbolLines.has(line)) {
      preciseWithLines += 1
      if (!symbolStarts.has(line)) layerUse.lines += 1
    } else {
      layerUse.none += 1
      const k = lines[i].trim().replace(/\s+/g, ' ').slice(0, 40)
      gapByKind.set(k, (gapByKind.get(k) ?? 0) + 1)
    }
    if (index.symbols.some((s) => s.startLine <= line && s.endLine >= line)) coveredBySymbolSpan += 1
  }
}

const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`
const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\u3000-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(ch) ? 2 : 1), 0)
const w = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)))

say(`代码块起点总数 ${totalBlocks}`)
say('')
say('=== 四层寻址的可达性 ===')
say(`${w('层', 34)}${w('可达', 10)}占比`)
say('-'.repeat(56))
say(`${w('① 符号名（target）—— 改整个函数/类', 34)}${w(layerUse.symbol, 10)}${pct(layerUse.symbol, totalBlocks)}`)
say(`${w('② + 行号（lines）—— 符号体内任意行', 34)}${w(layerUse.lines, 10)}${pct(layerUse.lines, totalBlocks)}`)
say(`${w('③ + 词线索（lineCue）—— 全文件唯一词', 34)}${w(0, 10)}${pct(0, totalBlocks)}  取决于模型给的词`)
say(`${w('④ + 文本锚点（anchor）—— 记得的原文', 34)}${w(0, 10)}${pct(0, totalBlocks)}  兜底，覆盖全部`)
say('-'.repeat(56))
say(`${w('前两层合计（精确寻址）', 34)}${w(preciseWithLines, 10)}${pct(preciseWithLines, totalBlocks)}`)
say('')
say(`=== 前两层都够不到的空隙：${layerUse.none} 个 (${pct(layerUse.none, totalBlocks)}) ===`)
say('这些行只能靠 ③ 词线索或 ④ 文本锚点寻址。看它们是什么：')
for (const [k, n] of [...gapByKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  say(`  ×${String(n).padStart(3)}  ${k}`)
}
say('')
say('判读：')
say('  · 前两层把"可精确寻址"从 17.8% 提到 ' + pct(preciseWithLines, totalBlocks) + '，且**都不要求模型复现内容**。')
say('  · 剩余空隙的样本若全是注释/指令/import，说明它们可以被 ③ 一个词搞定（这些行词少、区分度高）。')

