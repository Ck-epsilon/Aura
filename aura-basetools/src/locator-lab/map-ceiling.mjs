/**
 * map-ceiling.mjs —— map 的输出为什么不随文件增长？
 *
 * 现象（上一轮测量）：20 个函数时 map 1051 字符，160 个函数时 1054 字符。
 * 一个索引 160 个符号的结构表，输出怎么可能和 20 个符号时一样大？
 *
 * 两种可能，必须分开：
 *   A. 它**渲染了**全部符号，只是每行很短（不可能——160 行至少 4000+ 字符）
 *   B. 它**没有**渲染全部符号，有某个机制把输出截住了
 *
 * 本脚本把"索引了多少"与"渲染了多少"分开量，不让两者混在一个数里。
 */
import fs from 'node:fs'
import { readWith } from './read-core.mjs'
import { indexStructure, langOf, listSymbols } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)

function makeFile(fnCount) {
  const parts = []
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

say('=== 索引量 vs 渲染量：分开量 ===')
say(['函数数', '文件行', '索引到符号', 'map渲染行', 'map字符', 'map声称总数', 'omitted?'].map((s) => s.padEnd(14)).join(''))
say('-'.repeat(98))

for (const n of [1, 3, 5, 8, 12, 20, 40, 80, 160, 400]) {
  const src = makeFile(n)
  const lang = langOf('x.js')
  const idx = indexStructure(src, lang)
  const all = listSymbols(idx)
  const m = readWith(src, { filePath: 'x.js', mode: 'map' })
  const rendered = m.text.split('\n').length
  say(
    [
      String(n).padEnd(14),
      String(src.split('\n').length).padEnd(14),
      String(all.length).padEnd(14),
      String(rendered).padEnd(14),
      String(m.text.length).padEnd(14),
      String(m.symbols).padEnd(14),
      (m.omitted === undefined ? '否' : '是').padEnd(14),
    ].join(''),
  )
}

say('')
say('=== 分解：map 输出的构成 ===')
const src = makeFile(40)
const m = readWith(src, { filePath: 'x.js', mode: 'map' })
say(`  40 个函数 / ${src.split('\n').length} 行 / 索引到 ${listSymbols(indexStructure(src, langOf('x.js'))).length} 个符号`)
say(`  map 渲染 ${m.text.split('\n').length} 行（含 1 行表头），${m.text.length} 字符`)
say(`  map 自称总数 symbols=${m.symbols}`)
say(`  omitted = ${m.omitted ?? '(无)'}`)
say(`  默认 limit = request.limit ?? 24`)
say('')
say('  前 3 行:')
for (const l of m.text.split('\n').slice(0, 3)) say(`    ${l}`)
say('  末 3 行:')
for (const l of m.text.split('\n').slice(-3)) say(`    ${l}`)
