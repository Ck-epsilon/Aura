/**
 * coordinate-drift-experiment —— T15 的分辨实验：**行号地址会不会随会话内编辑次数变差？**
 *
 * 猜想（T15）：`lines=[a,b]` 是绝对坐标，每次编辑都破坏它；`target=` 不是。
 * 若成立，`lines` 的失败率应随“同会话内此前成功编辑次数”上升，而 `target` 基本平坦。
 * 这是**先验实验**，不预设结论：本探针只把曲线算出来，并明确打印样本量。
 *
 * 数据源：`~/.dsh/sessions`（`session-log.mjs` 已解压、解析工具参数与 `isError`）。
 * 无日志时只跑合成自证并明说“没有真实样本”，不假装有结论。
 *
 * 跑法：
 *   node probes/coordinate-drift-experiment.mjs            # 自证 + 真实日志（有就跑）
 *   node probes/coordinate-drift-experiment.mjs --self-test
 *   node probes/coordinate-drift-experiment.mjs --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { iterateSessionsDetailed } from './session-log.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const jsonMode = process.argv.includes('--json')
const selfTestOnly = process.argv.includes('--self-test')

const SELF_TEST_RE = /[\\/](?:aura-tools|locator-lab|aura-read|aura-edit|aura-basetools|deepseekharness)(?=[\\/]|$)/
const EDIT_TOOL = 'aura_edit'

/** 一次调用用的地址类型。多目标/多 hunk 取第一条（实验关心“模型这次主要用哪种坐标”）。 */
export function addressKindOf(args) {
  if (args === null || typeof args !== 'object') return 'unknown'
  if (Array.isArray(args.hunks) && args.hunks.length > 0) return addressKindOf(args.hunks[0])
  if (args.targets !== undefined && Array.isArray(args.targets) && args.targets.length > 0) {
    return addressKindOf(args.targets[0]?.hunks?.[0] ?? args.targets[0] ?? null)
  }
  if (typeof args.target === 'string' && args.target.trim() !== '') return 'target'
  if (args.lines !== undefined || args.start_line !== undefined) return 'lines'
  if (typeof args.line_cue === 'string' && args.line_cue.trim() !== '') return 'line_cue'
  if (typeof args.anchor === 'string' && args.anchor !== '') return 'anchor'
  if (typeof args.old === 'string' && args.old !== '') return 'old'
  if (typeof args.handle === 'string' && args.handle !== '') return 'handle'
  return 'unknown'
}

const BUCKETS = [
  { label: '0', test: (n) => n === 0 },
  { label: '1-2', test: (n) => n >= 1 && n <= 2 },
  { label: '3-5', test: (n) => n >= 3 && n <= 5 },
  { label: '6-10', test: (n) => n >= 6 && n <= 10 },
  { label: '11+', test: (n) => n >= 11 },
]
const bucketOf = (n) => BUCKETS.find((b) => b.test(n))?.label ?? null

/**
 * 纯分析：输入会话行（`{calls:[{name,args,isError}]}`），输出按地址类型 × 此前成功编辑次数的桶。
 * 成功编辑的计数**只算同一会话内、当前调用之前**的 aura_edit；失败不增加计数（否则失败会污染自变量）。
 */
export function analyze(rows) {
  const byKind = new Map()
  let samples = 0
  for (const row of rows) {
    let priorSuccess = 0
    for (const call of row.calls ?? []) {
      if (call.name !== EDIT_TOOL) continue
      const kind = addressKindOf(call.args)
      const success = call.isError !== true
      const bucket = bucketOf(priorSuccess)
      samples += 1
      if (bucket !== null) {
        const key = `${kind}\u0000${bucket}`
        const cell = byKind.get(key) ?? { kind, bucket, n: 0, failures: 0 }
        cell.n += 1
        if (!success) cell.failures += 1
        byKind.set(key, cell)
      }
      if (success) priorSuccess += 1
    }
  }
  return {
    samples,
    rows: [...byKind.values()].sort((a, b) => (a.kind === b.kind ? BUCKETS.findIndex((x) => x.label === a.bucket) - BUCKETS.findIndex((x) => x.label === b.bucket) : a.kind.localeCompare(b.kind))),
  }
}

const rate = (cell) => (cell.n === 0 ? null : cell.failures / cell.n)
const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

/**
 * 粗判：T15 的预测是 `lines` 失败率随此前成功编辑次数**上升**、`target` 基本平坦。
 * 判据是首桶 → 末桶的差（百分点）：
 *   · lines 上升 ≥5pp 且 target 变化 ≤10pp ⇒ supports；
 *   · lines 末桶 ≤ 首桶 ⇒ contradicts（方向相反）；
 *   · 其余 ⇒ inconclusive。
 * 这是**粗判**，不控制任务难度/首次尝试/模型适应；只用来决定“要不要为漂移补偿立项”。
 */
export function verdictOf(rows) {
  const cellsOf = (kind) => rows.filter((r) => r.kind === kind).sort((a, b) => BUCKETS.findIndex((x) => x.label === a.bucket) - BUCKETS.findIndex((x) => x.label === b.bucket))
  const ends = (cells) => (cells.length < 2 ? null : { first: cells[0], last: cells[cells.length - 1] })
  const lines = ends(cellsOf('lines'))
  const target = ends(cellsOf('target'))
  if (lines === null || target === null) return { verdict: 'inconclusive', reason: 'lines/target 的桶不足两个' }
  const lf = rate(lines.first)
  const ll = rate(lines.last)
  const tf = rate(target.first)
  const tl = rate(target.last)
  const detail = {
    lines: { first: lf, last: ll, nFirst: lines.first.n, nLast: lines.last.n },
    target: { first: tf, last: tl, nFirst: target.first.n, nLast: target.last.n },
  }
  if (ll - lf >= 0.05 && Math.abs(tl - tf) <= 0.1) return { verdict: 'supports', detail }
  if (ll <= lf) return { verdict: 'contradicts', detail }
  return { verdict: 'inconclusive', detail }
}

const failures = []
const check = (label, ok, detail = '') => {
  if (ok) say(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  else {
    failures.push(label)
    say(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}

say('=== A. 合成自证：分析逻辑本身（不依赖真实日志） ===')
{
  const calls = []
  for (let i = 0; i < 6; i += 1) calls.push({ name: EDIT_TOOL, args: { lines: [i + 1, i + 1], replace: 'x' }, isError: false })
  for (let i = 0; i < 6; i += 1) calls.push({ name: EDIT_TOOL, args: { lines: [i + 1, i + 1], replace: 'x' }, isError: true })
  const a = analyze([{ calls }])
  const lines0 = a.rows.find((r) => r.kind === 'lines' && r.bucket === '0')
  const lines6 = a.rows.find((r) => r.kind === 'lines' && r.bucket === '6-10')
  check('A1 前 6 次成功落在 0/1-2/3-5 三桶', a.rows.filter((r) => r.kind === 'lines' && r.bucket !== '6-10').reduce((n, r) => n + r.n, 0) === 6, JSON.stringify(a.rows))
  check('A2 之后 6 次失败全部落在 6-10 桶（此前成功 6 次）', lines6?.n === 6 && lines6?.failures === 6, JSON.stringify(lines6))
  check('A3 失败不增加 priorSuccess（自变量不被污染）', lines0?.n === 1 && lines0?.failures === 0, JSON.stringify(lines0))

  const flat = analyze([
    {
      calls: Array.from({ length: 8 }, () => ({ name: EDIT_TOOL, args: { target: 'alpha', replace: 'x' }, isError: false })),
    },
  ])
  check('A4 target 地址按同一规则分桶', flat.rows.every((r) => r.kind === 'target') && flat.rows.reduce((n, r) => n + r.n, 0) === 8, JSON.stringify(flat.rows))

  check('A6 多 hunk 取第一条的地址类型', addressKindOf({ hunks: [{ lines: [1, 2] }, { target: 'x' }] }) === 'lines')
  check('A7 多目标取第一个目标的 hunks', addressKindOf({ targets: [{ file_path: 'a.js', hunks: [{ target: 'x' }] }] }) === 'target')

  const rising = analyze([
    { calls: [...Array.from({ length: 6 }, () => ({ name: EDIT_TOOL, args: { lines: [1, 1], replace: 'x' }, isError: false })), ...Array.from({ length: 6 }, () => ({ name: EDIT_TOOL, args: { lines: [1, 1], replace: 'x' }, isError: true }))] },
    { calls: Array.from({ length: 8 }, () => ({ name: EDIT_TOOL, args: { target: 'x', replace: 'x' }, isError: false })) },
  ])
  check('A8 合成“lines 上升 + target 平坦” ⇒ supports', verdictOf(rising.rows).verdict === 'supports', JSON.stringify(verdictOf(rising.rows)))
  const falling = analyze([
    { calls: [...Array.from({ length: 6 }, () => ({ name: EDIT_TOOL, args: { lines: [1, 1], replace: 'x' }, isError: true })), ...Array.from({ length: 6 }, () => ({ name: EDIT_TOOL, args: { lines: [1, 1], replace: 'x' }, isError: false }))] },
    { calls: Array.from({ length: 8 }, () => ({ name: EDIT_TOOL, args: { target: 'x', replace: 'x' }, isError: false })) },
  ])
  check('A9 合成“lines 下降” ⇒ contradicts（方向相反）', verdictOf(falling.rows).verdict === 'contradicts', JSON.stringify(verdictOf(falling.rows)))
}

let report = null
if (!selfTestOnly) {
  say('')
  say('=== B. 真实会话日志（若本机有） ===')
  let sessionCount = 0
  function* realRows() {
    for (const row of iterateSessionsDetailed(0)) {
      if (typeof row.cwd !== 'string' || SELF_TEST_RE.test(row.cwd)) continue
      sessionCount += 1
      yield row
    }
  }
  try {
    report = analyze(realRows())
  } catch {
    report = null
  }
  if (report === null || sessionCount === 0) {
    say('  (没有可用的真实会话日志；本次只完成合成自证，不产出曲线结论)')
  } else {
    say(`  会话 ${sessionCount} 个 / aura_edit 调用 ${report.samples} 次`)
    if (report.samples === 0) {
      say('  (会话里没有 aura_edit 调用；不产出曲线结论)')
    } else {
      say('')
      say('  地址类型   此前成功编辑   样本   失败   失败率')
      for (const cell of report.rows) {
        say(`  ${cell.kind.padEnd(10)} ${cell.bucket.padEnd(13)} ${String(cell.n).padStart(5)} ${String(cell.failures).padStart(6)}   ${pct(rate(cell)).padStart(6)}`)
      }
      const verdict = verdictOf(report.rows)
      report.verdict = verdict
      if (verdict.detail !== undefined) {
        say('')
        say(`  lines 首桶 ${pct(verdict.detail.lines.first)}（n=${verdict.detail.lines.nFirst}）→ 末桶 ${pct(verdict.detail.lines.last)}（n=${verdict.detail.lines.nLast}）`)
        say(`  target 首桶 ${pct(verdict.detail.target.first)}（n=${verdict.detail.target.nFirst}）→ 末桶 ${pct(verdict.detail.target.last)}（n=${verdict.detail.target.nLast}）`)
      }
      const zh = { supports: '支持（lines 上升、target 平坦）', contradicts: '不支持（lines 未上升，方向与猜想相反）', inconclusive: '不确定（样本或方向不足以判）' }[verdict.verdict]
      say(`  T15 判读：${zh}${verdict.reason === undefined ? '' : ` — ${verdict.reason}`}`)
    }
  }
}

if (jsonMode) say(JSON.stringify({ selfTestFailures: failures, report }, null, 2))
say('')
say(`--- 行号漂移实验：${failures.length === 0 ? '自证通过' : `${failures.length} 项自证失败`} ---`)
process.exitCode = failures.length === 0 ? 0 : 1
