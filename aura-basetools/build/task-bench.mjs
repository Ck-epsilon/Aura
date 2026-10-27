/**
 * task-bench —— 任务级基准（0.8.3）：把“读一次 + 改一次”当成一个任务来量。
 *
 * 为什么需要它：引擎套件测的是“函数/判据对不对”，探针测的是“真实会话里的采用率”，
 * 两者之间缺一层**可重复的任务成本**：同一个编辑任务，要几次调用、多少 token、是否一次成功。
 * 这一层是“高性能”唯一可判定的口径——单次调用快但要多读一轮，端到端更慢。
 *
 * 每个任务：
 *   1. 真读：`readWith(source, {mode, budget})`（读侧公开 API）；
 *   2. 真写：`applyEditToProvider`（真 node fs provider，含回读校验）；
 *   3. 判据：落盘内容包含期望片段、`applied` 条数 = hunk 数、`write_verify.level === 'bytes'`。
 *
 * 读数：每次任务的 read 输出 + edit 回执字符数 / 4 ≈ token；调用数固定 2（读 + 写）；
 * 延迟取 3 次中位数，p95 只作 sanity ceiling（墙钟有噪声，不当硬 SLO）。
 *
 * 跑法：
 *   node build/task-bench.mjs --capture   # 采基线（fixtures/task-bench-baseline.json）
 *   node build/task-bench.mjs             # 对照基线并判红
 *   node build/task-bench.mjs --json      # 机器读
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const baselineFile = path.join(root, 'fixtures', 'task-bench-baseline.json')
const jsonMode = process.argv.includes('--json')
const capture = process.argv.includes('--capture')

/**
 * 观测缓存指到临时目录：基准不该往真实 `~/.aura` 写东西。
 * 必须在**动态 import 之前**设好——模块可能在加载时读这个环境变量。
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-task-bench-'))
process.env.AURA_CACHE_DIR = path.join(scratch, 'cache')

const src = (name) => pathToFileURL(path.join(root, 'src', name)).href
const { readWith } = await import(src('locator-lab/read-core.mjs'))
const { applyEditToProvider } = await import(src('locator-lab/write-path.mjs'))
const { createNodeFsProvider } = await import(src('aura-standalone/lib/fs-provider.mjs'))

const say = (m) => process.stdout.write(`${m}\n`)
const TOKEN_DIVISOR = 4
const tokensOf = (text) => Math.ceil(String(text).length / TOKEN_DIVISOR)

const TASKS = [
  {
    id: 'js-symbol',
    file: 'app.js',
    source: [
      'export function greet(name) {',
      '  return `Hello, ${name}`',
      '}',
      '',
      'export function farewell(name) {',
      '  return `Bye, ${name}`',
      '}',
      '',
    ].join('\n'),
    read: { mode: 'auto', budget: 8192 },
    hunks: [{ target: 'greet', replace: 'export function greet(name) {\n  return `Hi, ${name}`\n}' }],
    expect: ['Hi, ${name}'],
  },
  {
    id: 'ts-target',
    file: 'types.ts',
    source: [
      'export interface Config {',
      '  retries: number',
      '}',
      '',
      'export function loadConfig(path: string) {',
      '  return { retries: 3, path }',
      '}',
      '',
    ].join('\n'),
    read: { mode: 'digest', budget: 8192 },
    hunks: [{ target: 'loadConfig', replace: 'export function loadConfig(path: string) {\n  return { retries: 5, path }\n}' }],
    expect: ['retries: 5'],
  },
  {
    id: 'py-target',
    file: 'util.py',
    source: [
      'def parse(value):',
      '    return int(value)',
      '',
      'def render(item):',
      '    return str(item)',
      '',
    ].join('\n'),
    read: { mode: 'map', budget: 8192 },
    hunks: [{ target: 'parse', replace: 'def parse(value):\n    return int(value) * 2' }],
    expect: ['* 2'],
  },
  {
    id: 'go-lines',
    file: 'main.go',
    source: [
      'package main',
      '',
      'func total(a int, b int) int {',
      '\treturn a + b',
      '}',
      '',
    ].join('\n'),
    read: { mode: 'lines', lines: [1, 6], budget: 8192 },
    hunks: [{ lines: [4, 4], replace: '\treturn a + b + 1' }],
    expect: ['+ 1'],
  },
  {
    id: 'rust-pub-const',
    file: 'lib.rs',
    source: [
      'pub const LIMIT: i32 = 10;',
      '',
      'pub fn clamp(value: i32) -> i32 {',
      '    value.min(LIMIT)',
      '}',
      '',
    ].join('\n'),
    read: { mode: 'auto', budget: 8192 },
    hunks: [{ target: 'LIMIT', replace: 'pub const LIMIT: i32 = 20;' }],
    expect: ['= 20'],
  },
  {
    id: 'sql-lines',
    file: 'schema.sql',
    source: [
      'CREATE TABLE users (',
      '  id INTEGER PRIMARY KEY,',
      '  name TEXT',
      ');',
      '',
    ].join('\n'),
    read: { mode: 'digest', budget: 8192 },
    hunks: [{ lines: [3, 3], replace: '  name TEXT NOT NULL' }],
    expect: ['NOT NULL'],
  },
  {
    id: 'erl-target',
    file: 'sample.erl',
    source: ['-module(sample).', '-export([beta/1]).', '', 'beta(X) ->', '    X + 1.', ''].join('\n'),
    read: { mode: 'map', budget: 8192 },
    hunks: [{ target: 'beta', replace: 'beta(X) ->\n    X + 2.' }],
    expect: ['X + 2'],
  },
  {
    id: 'js-multi-hunk',
    file: 'consts.js',
    source: ['export const A = 1;', 'export const B = 2;', 'export const C = 3;', ''].join('\n'),
    read: { mode: 'auto', budget: 8192 },
    hunks: [
      { lines: [1, 1], expect: 'export const A = 1;', replace: 'export const A = 10;' },
      { lines: [3, 3], expect: 'export const C = 3;', replace: 'export const C = 30;' },
    ],
    expect: ['A = 10', 'C = 30'],
  },
]

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
const p95 = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

async function runTask(task, iteration) {
  const dir = fs.mkdtempSync(path.join(scratch, `task-${task.id}-`))
  const file = path.join(dir, task.file)
  fs.writeFileSync(file, task.source)
  const provider = createNodeFsProvider({ resolveRoot: dir })
  const started = performance.now()
  const read = readWith(task.source, {
    filePath: task.file,
    mode: task.read.mode,
    ...(task.read.lines === undefined ? {} : { lines: task.read.lines }),
    budget: task.read.budget,
  })
  const receipt = await applyEditToProvider(provider, {
    displayPath: task.file,
    hunks: task.hunks,
    identityKey: `task-bench-${task.id}-${iteration}`,
  })
  const elapsed = performance.now() - started
  const after = fs.readFileSync(file, 'utf8')
  const success =
    read.ok === true &&
    receipt.applied.length === task.hunks.length &&
    task.expect.every((needle) => after.includes(needle)) &&
    receipt.write_verify?.level === 'bytes'
  const tokens = tokensOf(read.text ?? '') + tokensOf(JSON.stringify(receipt))
  const calls = 2
  fs.rmSync(dir, { recursive: true, force: true })
  return {
    id: task.id,
    file: task.file,
    readMode: read.mode,
    readChars: (read.text ?? '').length,
    receiptChars: JSON.stringify(receipt).length,
    tokens,
    calls,
    rework: success ? 0 : 1,
    success,
    latencyMs: elapsed,
    tier: receipt.applied?.[0]?.tier ?? null,
  }
}

const ITERATIONS = 3
const results = []
for (const task of TASKS) {
  const runs = []
  for (let i = 0; i < ITERATIONS; i += 1) runs.push(await runTask(task, i))
  const first = runs[0]
  results.push({
    ...first,
    latencyMs: median(runs.map((r) => r.latencyMs)),
    allSuccess: runs.every((r) => r.success),
  })
}

const totals = {
  tasks: results.length,
  success: results.filter((r) => r.allSuccess).length,
  calls: results.reduce((n, r) => n + r.calls, 0),
  tokens: results.reduce((n, r) => n + r.tokens, 0),
  rework: results.reduce((n, r) => n + r.rework, 0),
  p95Ms: p95(results.map((r) => r.latencyMs)),
}
const report = { generatedAt: new Date().toISOString(), tasks: Object.fromEntries(results.map((r) => [r.id, r])), totals }

fs.rmSync(scratch, { recursive: true, force: true })

if (capture) {
  fs.writeFileSync(baselineFile, `${JSON.stringify(report, null, 2)}\n`)
  say(`✓ 已采集任务基准：${path.relative(root, baselineFile)}（${totals.success}/${totals.tasks} 成功，${totals.tokens} token，p95 ${totals.p95Ms.toFixed(1)} ms）`)
  process.exit(0)
}

let baseline = null
try {
  baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
} catch {
  baseline = null
}

if (jsonMode) {
  say(JSON.stringify({ ...report, baseline }, null, 2))
}

const failures = []
if (baseline === null) {
  failures.push(`缺少基线 ${path.relative(root, baselineFile)} —— 用 node build/task-bench.mjs --capture 采集`)
} else {
  if (totals.success !== totals.tasks) failures.push(`成功率 ${totals.success}/${totals.tasks}，要求全成功`)
  if (totals.calls !== totals.tasks * 2) failures.push(`调用数 ${totals.calls}，要求每任务 2 次（读 + 写）`)
  if (totals.rework !== 0) failures.push(`返工 ${totals.rework}，要求 0`)
  if (totals.tokens > Math.ceil(baseline.totals.tokens * 1.2) + 40) {
    failures.push(`总 token ${totals.tokens} 超过基线 ${baseline.totals.tokens} 的 1.2 倍`)
  }
  const latencyCeiling = Math.max(5000, baseline.totals.p95Ms * 3)
  if (totals.p95Ms > latencyCeiling) failures.push(`p95 ${totals.p95Ms.toFixed(1)}ms 超过 sanity ceiling ${latencyCeiling.toFixed(1)}ms`)
  for (const task of results) {
    const base = baseline.tasks[task.id]
    if (base === undefined) {
      failures.push(`${task.id}: 基线里没有这个任务`)
      continue
    }
    if (!task.allSuccess) failures.push(`${task.id}: 任务未一次成功`)
    if (task.tokens > Math.ceil(base.tokens * 1.2) + 20) failures.push(`${task.id}: token ${task.tokens} 超过基线 ${base.tokens} 的 1.2 倍`)
  }
}

if (!jsonMode) {
  say('任务              读模式   成功  调用  token  Δtoken   p95ms   tier')
  for (const r of results) {
    const base = baseline?.tasks?.[r.id]
    const delta = base === undefined ? 'n/a' : `${r.tokens - base.tokens >= 0 ? '+' : ''}${r.tokens - base.tokens}`
    say(
      `${r.id.padEnd(17)} ${String(r.readMode).padEnd(8)} ${r.allSuccess ? '✓' : '✗'}     ${r.calls}    ${String(r.tokens).padEnd(6)} ${String(delta).padEnd(7)} ${r.latencyMs.toFixed(1).padStart(6)}  ${r.tier ?? ''}`,
    )
  }
  say('')
  say(`合计：${totals.success}/${totals.tasks} 成功 ｜ 调用 ${totals.calls} ｜ token ${totals.tokens} ｜ 返工 ${totals.rework} ｜ p95 ${totals.p95Ms.toFixed(1)}ms`)
  if (failures.length > 0) {
    say('')
    for (const f of failures) say(`  ✗ ${f}`)
  }
}

say(`--- 任务基准：${failures.length === 0 ? `${results.length}/${results.length} 通过` : `${results.length - failures.length}/${results.length} 通过`} ---`)
process.exitCode = failures.length === 0 ? 0 : 1
