/**
 * perf-gate —— 0.9.3：性能包线闸（不是微基准排行榜）。
 *
 * 目标：在可复现的规模档上，守住“不会突然退化到不可用”的底线，并让每次发布都看见读数。
 * 判据分两类：
 *   · **绝对上限**（宽松，跨机可过）：1k/10k/100k 行 map 冷读、100k 热读、10k 行编辑；
 *   · **规模比值**（不随机器绝对速度漂）：t(100k)/t(10k) ≤ 20（行数 ×10，允许 2× 额外开销）。
 *
 * 墙钟有噪声，所以取 3 次中位数，并只把 p95 当 sanity ceiling；不把某个固定毫秒数写成跨机契约。
 *
 * 跑法：
 *   node build/perf-gate.mjs --capture   # 采本机基线（fixtures/perf-baseline.json）
 *   node build/perf-gate.mjs             # 对照基线 + 判红
 *   node build/perf-gate.mjs --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const baselineFile = path.join(root, 'fixtures', 'perf-baseline.json')
const capture = process.argv.includes('--capture')
const jsonMode = process.argv.includes('--json')
const src = (name) => pathToFileURL(path.join(root, 'src', name)).href
const { readWith } = await import(src('locator-lab/read-core.mjs'))
const { planHunks } = await import(src('locator-lab/write-path.mjs'))

const say = (m) => process.stdout.write(`${m}\n`)
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

const functionOf = (i) => `export function fn${i}(value) {\n  return value + ${i}\n}`
/** 生成恰好 lines 行的 JS：每 3 行一个函数 + 一个空行。 */
function sourceOfLines(lines) {
  const out = []
  for (let i = 0; out.length < lines; i += 1) {
    out.push(functionOf(i), '')
  }
  return out.slice(0, lines).join('\n')
}

const timeIt = (fn) => {
  const t0 = performance.now()
  const value = fn()
  return { ms: performance.now() - t0, value }
}

const SIZES = [1000, 10000, 100000]
const rows = []
for (const n of SIZES) {
  const base = sourceOfLines(n)
  const cold = []
  const warm = []
  let ok = true
  for (let i = 0; i < 3; i += 1) {
    // 每次换一个唯一注释 ⇒ 结构缓存必然 miss（冷读）。
    const coldSource = `// cold ${i} ${'x'.repeat(i + 1)}\n${base}`
    const c = timeIt(() => readWith(coldSource, { filePath: 'perf.js', mode: 'map', budget: 8192 }))
    cold.push(c.ms)
    ok = ok && c.value.ok === true && (c.value.text ?? '').length > 0
    // 同一份内容再读一次 ⇒ 命中结构缓存（热读）。
    const w = timeIt(() => readWith(coldSource, { filePath: 'perf.js', mode: 'map', budget: 8192 }))
    warm.push(w.ms)
    ok = ok && w.value.ok === true
  }
  rows.push({ lines: n, coldP50: median(cold), coldP95: p95(cold), warmP50: median(warm), warmP95: p95(warm), ok })
}

// 10k 行上的一次符号编辑：索引 + 定位 + 规划（不写盘）。
const editSource = sourceOfLines(10000)
const editTimes = []
let editOk = true
for (let i = 0; i < 3; i += 1) {
  const e = timeIt(() =>
    planHunks(editSource, [{ target: 'fn2500', replace: 'export function fn2500(value) {\n  return value * 2\n}' }], 'perf.js'),
  )
  editTimes.push(e.ms)
  editOk = editOk && e.value.applied?.length === 1 && e.value.applied[0].line > 0
}
const edit = { p50: median(editTimes), p95: p95(editTimes), ok: editOk }

const byLines = Object.fromEntries(rows.map((r) => [r.lines, r]))
const ratio = byLines[100000].coldP50 / Math.max(1, byLines[10000].coldP50)
const report = { generatedAt: new Date().toISOString(), rows, edit, ratio }

if (capture) {
  fs.writeFileSync(baselineFile, `${JSON.stringify(report, null, 2)}\n`)
  say(`✓ 已采集性能基线：${path.relative(root, baselineFile)}（100k 冷 p50 ${byLines[100000].coldP50.toFixed(1)}ms；10k 编辑 p50 ${edit.p50.toFixed(1)}ms）`)
  process.exit(0)
}

let baseline = null
try {
  baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
} catch {
  baseline = null
}
if (jsonMode) say(JSON.stringify({ ...report, baseline }, null, 2))

const failures = []
const check = (label, ok, detail = '') => {
  if (!ok) failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!jsonMode) say(`  ${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}
if (baseline === null) failures.push(`缺少基线 ${path.relative(root, baselineFile)} —— 用 node build/perf-gate.mjs --capture 采集`)

check('三档 map 读取都返回正文', rows.every((r) => r.ok), rows.map((r) => `${r.lines}:${r.ok}`).join(','))
check('1k 冷读 p95 ≤ 1000ms', byLines[1000].coldP95 <= 1000, `${byLines[1000].coldP95.toFixed(1)}ms`)
check('10k 冷读 p95 ≤ 3000ms', byLines[10000].coldP95 <= 3000, `${byLines[10000].coldP95.toFixed(1)}ms`)
check('100k 冷读 p95 ≤ 10000ms', byLines[100000].coldP95 <= 10000, `${byLines[100000].coldP95.toFixed(1)}ms`)
check('100k 热读 p95 ≤ 3000ms', byLines[100000].warmP95 <= 3000, `${byLines[100000].warmP95.toFixed(1)}ms`)
check('规模比值 t(100k)/t(10k) ≤ 20（行数 ×10）', ratio <= 20, `×${ratio.toFixed(2)}`)
check('10k 行符号编辑 p95 ≤ 3000ms', edit.p95 <= 3000, `${edit.p95.toFixed(1)}ms`)

if (!jsonMode) {
  say('')
  say('  行数      冷 p50    冷 p95    热 p50    热 p95')
  for (const r of rows) {
    say(`  ${String(r.lines).padStart(6)}  ${r.coldP50.toFixed(1).padStart(8)}  ${r.coldP95.toFixed(1).padStart(8)}  ${r.warmP50.toFixed(1).padStart(8)}  ${r.warmP95.toFixed(1).padStart(8)}`)
  }
  say(`  10k 编辑：p50 ${edit.p50.toFixed(1)}ms / p95 ${edit.p95.toFixed(1)}ms ｜ 100k/10k 冷读比值 ×${ratio.toFixed(2)}`)
  if (failures.length > 0) {
    say('')
    for (const f of failures) say(`  ✗ ${f}`)
  }
  say('')
}
say(`--- 性能包线：${failures.length === 0 ? '7/7 通过' : `${7 - failures.length}/7 通过`} ---`)
process.exitCode = failures.length === 0 ? 0 : 1
