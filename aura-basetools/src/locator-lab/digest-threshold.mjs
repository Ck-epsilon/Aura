/**
 * digest-threshold.mjs —— digest 从多大开始才划算？
 *
 * 测试暴露出一个重要事实：**digest 有固定开销**（规模行、导出面、import、外部依赖、
 * 以及"signatures"表头）。在小文件上，这份开销比全文还大——实测一个 172 字符的文件，
 * digest 反倒有 231 字符。
 *
 * 所以"digest 压缩 20x"这个数是有条件的，条件就是文件够大。本脚本量出**盈亏平衡点**，
 * 好让工具在文件小于它时干脆不要用 digest——否则就是在帮倒忙。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readWith } from './read-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const NM = 'E:\\software\\npmlocal\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'

/** 造一个规模可控、结构真实的文件。 */
function makeFile(fnCount) {
  const parts = ['import { helper } from "./helper.js";', '']
  for (let i = 0; i < fnCount; i += 1) {
    parts.push(`export function fn_${i}(input, opts) {`)
    parts.push(`  const v = helper(input);`)
    parts.push(`  if (v > ${i}) return v;`)
    parts.push(`  return opts?.default ?? ${i};`)
    parts.push(`}`)
    parts.push('')
  }
  return parts.join('\n')
}

say('=== digest 与全文的体量随文件增长的变化 ===')
say(['函数数', '全文字符', 'map字符', 'digest字符', 'digest/全文', '划算?'].map((s) => s.padEnd(12)).join(''))
say('-'.repeat(76))

let breakEven = null
for (const n of [1, 2, 3, 5, 8, 12, 20, 40, 80, 160]) {
  const src = makeFile(n)
  const map = readWith(src, { filePath: 'x.js', mode: 'map' })
  const dig = readWith(src, { filePath: 'x.js', mode: 'digest' })
  const ratio = dig.text.length / src.length
  const worth = ratio < 1
  if (worth && breakEven === null) breakEven = { fnCount: n, chars: src.length, ratio }
  say(
    [
      String(n).padEnd(12),
      String(src.length).padEnd(12),
      String(map.text.length).padEnd(12),
      String(dig.text.length).padEnd(12),
      ratio.toFixed(2).padEnd(12),
      worth ? '是' : '否',
    ].join(''),
  )
}

say('')
if (breakEven !== null) {
  say(`盈亏平衡点：约 ${breakEven.fnCount} 个函数 / ${breakEven.chars} 字符（此时 digest/全文 = ${breakEven.ratio.toFixed(2)}）`)
} else {
  say('在所测范围内 digest 始终不比全文小')
}
say('')
say('结论：digest 的应用阈值不是一个魔数，而是**两个量之比**——')
say('  当 digest 比全文更小时才用它。工具应当自己算这个比较，而不是让调用方去猜阈值。')
say('  这不是"调参"，是把选择权交给可测量的比较。')

// 用真实文件复核
say('')
say('=== 真实文件复核 ===')
const real = ['dsh-tool-todo', 'dsh-fs-observation-policy', 'dsh-tool-subagent', 'dsh-tool-fs'].map((d) =>
  path.join(NM, d, 'lib', 'index.js'),
)
for (const f of real) {
  if (!fs.existsSync(f)) continue
  const src = fs.readFileSync(f, 'utf8')
  const dig = readWith(src, { filePath: f, mode: 'digest' })
  const map = readWith(src, { filePath: f, mode: 'map' })
  const name = path.basename(path.dirname(path.dirname(f)))
  say(
    `  ${name.padEnd(26)} 全文 ${String(src.length).padStart(6)}  map ${String(map.text.length).padStart(5)}  digest ${String(dig.text.length).padStart(5)}  digest/全文 ${(dig.text.length / src.length).toFixed(2)}`,
  )
}
