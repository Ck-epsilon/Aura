/**
 * read-test —— read 原型的正确性验证。
 *
 * 判定标准与旧 read 的差别在于：不只测"给得对不对"，更测**丢得清不清楚**。
 *   · 预算：任何模式的输出都不得超出下游剪枝能保全的字符数（否则中段会被静默砍掉）
 *   · 显式：一旦丢弃内容，信封必须带 `omitted` 说明与 `next` 续读指令
 *   · 保真：给出的行号与内容必须与源文件逐字一致（旧 read 的剪枝会让行号跳跃）
 */
import fs from 'node:fs'
import path from 'node:path'
import { readWith, PRUNE_BUDGET, CONTENT_BUDGET, MODES } from './read-core.mjs'
import { dshModulesRoot } from './dsh-test-paths.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const NM = dshModulesRoot()
if (NM === null) {
  say('✗ 找不到 DSH 语料（设置 AURA_DSH_NM 或安装 @deepseek-ai/dsh）')
  process.exit(2)
}
const FILE = path.join(NM, 'dsh-tool-fs', 'lib', 'index.js')
const SRC = fs.readFileSync(FILE, 'utf8')
const TOTAL = SRC.split('\n').length

say(`靶子 dsh-tool-fs/lib/index.js: ${TOTAL} 行，${SRC.length} 字符`)

// ── 贯穿全篇的硬断言：任何输出不超预算 ────────────────────────────────────
const outputs = []
function record(label, r) {
  outputs.push({ label, r })
  return r
}

say('')
say('=== 1. 预算：所有模式的输出都不得超出下游能保全的上限 ===')
const map = record('map', readWith(SRC, { filePath: FILE, mode: 'map' }))
const around = record('around', readWith(SRC, { filePath: FILE, mode: 'around', around: 'applyWriteTool' }))
const linesMode = record('lines', readWith(SRC, { filePath: FILE, mode: 'lines', lines: [400, 1200] }))
const search = record('search', readWith(SRC, { filePath: FILE, mode: 'search', search: 'ctx.fs' }))

let over = 0
for (const o of outputs) {
  const size = JSON.stringify(o.r).length
  const textSize = (o.r.text ?? '').length
  if (textSize > CONTENT_BUDGET) over += 1
  say(`  ${o.label.padEnd(8)} text=${String(textSize).padStart(6)} 信封=${String(size).padStart(6)} ${size > PRUNE_BUDGET ? '⚠ 信封超预算' : ''}`)
}
check(over === 0, `四模式内容均未超出内容预算 ${CONTENT_BUDGET}`, `超出 ${over} 个`)
check(
  outputs.every((o) => o.r.metrics?.mode === o.r.mode && o.r.metrics.lines === o.r.totalLines && o.r.metrics.chars === (o.r.text ?? '').length && typeof o.r.metrics.truncated === 'boolean'),
  '所有模式都带确定性 metrics（mode/lines/chars/truncated）',
  JSON.stringify(outputs.map((o) => [o.label, o.r.metrics])),
)
const failure = readWith('a\n', { filePath: 'm.txt', mode: 'lines' })
check(failure.ok === false && failure.metrics === undefined, '失败回执不带 metrics（metrics 只对成功信封作承诺）', JSON.stringify(failure.metrics))

say('')
say('=== 2. map 模式：先给地图，且足够小 ===')
check(map.ok && map.mode === 'map', `mode=${map.mode}`)
check(typeof map.symbols === 'number' && map.symbols > 0, `索引到 ${map.symbols} 个符号`)
check(map.metrics?.symbols === map.symbols, `metrics.symbols 与顶层 symbols 同值（${map.metrics?.symbols}）`)
// 地图的大小不再是"越小越好"——它应当**用满预算**给出最多的可寻址名字。
// 断言因此改成验真正要紧的性质：不超预算，且相对全文仍有大幅节省。
check(map.text.length <= CONTENT_BUDGET, `地图 ${map.text.length} 字符，未超内容预算`)
check(map.text.length < SRC.length / 10, `地图仅为全文的 1/${Math.round(SRC.length / map.text.length)}（${map.text.length} vs ${SRC.length}）`)
check(map.text.includes('lines') || map.text.includes('symbols'), '地图含总体规模信息')
// 地图里不该出现函数内局部量：它们重名率高、模型改它们时用 lines 层即可，不值得占行
check(!/^\s+\S+\s+v\s+\d+-\d+$/m.test(map.text) || map.text.split('\n').filter((l) => /\bv\s+\d+-\d+$/.test(l)).length === 0, '地图不含函数内局部量（如 variable v）')
check(typeof map.omitted === 'string' && map.omitted.includes('nested locals'), `显式说明被略过的局部量：${map.omitted}`)
check(typeof map.next === 'string' && map.next.includes('mode='), `给出续读指令：${map.next}`)
say('  地图实际内容：')
for (const l of map.text.split('\n').slice(0, 6)) say(`    ${l}`)

say('')
say('=== 3. around 模式：给目标附近的窗口，不需要先知道行号 ===')
check(around.ok, `命中 ${around.center}（${around.shown}）`)
check(around.text.split('\n').length <= 2 * (8 + 1) + 2, `窗口行数受控：${around.text.split('\n').length} 行`)
const aroundNums = [...around.text.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]))
check(aroundNums.length > 0 && aroundNums.every((n) => n >= 1 && n <= TOTAL), `行号全部在 1..${TOTAL} 内`)
check(aroundNums.includes(around.center), `窗口包含中心行 ${around.center}`)

say('')
say('=== 4. 保真：给出的每一行都与源文件逐字一致（旧 read 的剪枝会让行号跳跃）===')
const srcLines = SRC.split('\n')
let mismatched = 0
let checked = 0
for (const m of around.text.matchAll(/^(\d+): (.*)$/gm)) {
  const n = Number(m[1])
  const shown = m[2]
  checked += 1
  // 长行会被显式标注截断，比前缀
  const raw = srcLines[n - 1]
  if (!raw.startsWith(shown.split('   ←')[0])) mismatched += 1
}
check(mismatched === 0, `校验 ${checked} 行，全部与源文件一致`, `不一致 ${mismatched}`)
// 连续性：窗口内不得出现行号跳跃（那正是旧 read 剪枝的症状）
let jumps = 0
for (let i = 1; i < aroundNums.length; i += 1) if (aroundNums[i] !== aroundNums[i - 1] + 1) jumps += 1
check(jumps === 0, `窗口内行号连续，无跳跃（旧 read 会出现 89 → 1131）`, `跳跃 ${jumps} 处`)

say('')
say('=== 5. 超预算时必须显式，而不是静默丢弃 ===')
check(linesMode.ok, `lines 模式可用：请求 400-1200，实给 ${linesMode.shown}`)
const gotTo = Number(linesMode.shown.split('-')[1])
check(gotTo < 1200, `确实被预算截住了（实给到 ${gotTo}）`)
check(typeof linesMode.omitted === 'string' && linesMode.omitted.length > 0, `带 omitted 说明：${linesMode.omitted}`)
check(typeof linesMode.next === 'string' && linesMode.next.includes('mode=lines'), `带续读指令：${linesMode.next}`)
check(
  linesMode.omitted.includes(String(gotTo + 1)),
  'omitted 说明里点明了从哪一行开始没给',
)

say('')
say('=== 6. map 也受预算约束：符号极多时显式截断 ===')
const many = Array.from({ length: 400 }, (_, i) => `function fn_${i}() {\n  return ${i};\n}`).join('\n')
const bigMap = readWith(many, { filePath: 'x.js', mode: 'map' })
check(bigMap.ok && bigMap.text.length <= CONTENT_BUDGET, `400 个符号时地图 ${bigMap.text.length} 字符，未超预算`)
check(typeof bigMap.omitted === 'string', `超量时显式说明：${bigMap.omitted}`)
check(bigMap.symbols === 400, `仍如实报告总数 ${bigMap.symbols}`)

say('')
say('=== 7. search 模式：命中行 + 显式省略 ===')
check(search.ok, `命中 ${search.matches} 处`)
check(typeof search.text === 'string' && search.text.length <= CONTENT_BUDGET, 'search 输出也未超预算')
if (search.matches > 40) {
  check(typeof search.omitted === 'string', `命中过多时显式说明：${search.omitted}`)
}

say('')
say('=== 8. 错误必须可执行，不是一句"失败了" ===')
check(readWith(SRC, { filePath: FILE, mode: 'nope' }).code === 'READ_BAD_MODE', '未知 mode 明确报错')
check(readWith(SRC, { filePath: FILE, mode: 'lines' }).code === 'READ_NO_RANGE', 'lines 模式缺区间时报错')
check(readWith(SRC, { filePath: FILE, mode: 'lines', lines: [999999] }).code === 'READ_OUT_OF_RANGE', '越界报错')
const amb = readWith(SRC, { filePath: FILE, mode: 'around', around: 'return' })
check(amb.code === 'READ_AMBIGUOUS', `歧义目标报错并给候选（${amb.candidates?.length} 个）`)
check(amb.next !== undefined, `歧义时也给续读指令：${amb.next}`)
const nf = readWith(SRC, { filePath: FILE, mode: 'around', around: '绝不存在的符号ZZZ' })
check(nf.code === 'READ_NOT_FOUND', `${nf.code}: ${nf.message}`)

say('')
say('=== 9. 无扩展名文件：map 降级而不是崩 ===')
const plain = readWith('a\nb\nc\n', { filePath: 'x.unknown', mode: 'map' })
check(plain.ok && typeof plain.note === 'string', `降级说明：${plain.note}`)
check(plain.next !== undefined, `仍给续读指令：${plain.next}`)

say('')
say('=== 10. 成本对比：同一文件的三种意图 ===')
const oldCost = JSON.stringify({ content: SRC }).length
const oldAfterPrune = Math.min(oldCost, 4096 + 1024)
say(`  旧 read 全文：            ${oldCost} 字符  →  剪枝后实际保全 ${oldAfterPrune}，丢 ${oldCost - oldAfterPrune}`)
say(`  新 read map：             ${map.text.length} 字符（保住全部信息，且更小）`)
say(`  新 read around:           ${around.text.length} 字符（拿到要改的地方）`)
say(`  新 read lines(400-1200):  ${linesMode.text.length} 字符（显式说明截断）`)

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
