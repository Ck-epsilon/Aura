#!/usr/bin/env node
/**
 * range-all.mjs —— 一条命令跑完三套靶场（格式矩阵 / 字节形态 / 参数形态）。
 *
 *   node build/range-all.mjs           # 人看
 *   node build/range-all.mjs --json    # 机器看
 *
 * 为什么要有它：靶场是"持续打"的东西（本轮就是靠改一处、红了 11 个套件才发现漏判），
 * 分三次手动跑很容易漏掉其中一套。这里只做汇总与退出码，不替靶场做判断——
 * 每套靶场自己打印 `--- N/M 通过 ---` 并以退出码表态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const RANGES = [
  ['格式矩阵', 'src/locator-lab/range-formats-test.mjs'],
  ['字节形态', 'src/aura-standalone/test/range-bytes-test.mjs'],
  ['参数形态', 'src/locator-lab/range-args-test.mjs'],
]

const rows = []
for (const [name, relative] of RANGES) {
  const file = path.join(root, relative)
  if (!fs.existsSync(file)) {
    rows.push({ name, file: relative, status: 'missing', exit: null, summary: '(文件不存在 —— 靶场还没建)', stderr: '' })
    continue
  }
  const res = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 900000 })
  const stdout = res.stdout ?? ''
  const summary = stdout
    .trim()
    .split('\n')
    .filter((line) => line.includes('通过'))
    .pop()
  rows.push({
    name,
    file: relative,
    status: res.status === 0 ? 'ok' : 'fail',
    exit: res.status,
    summary: (summary ?? '').trim(),
    stderr: (res.stderr ?? '').trim().split('\n').slice(0, 3).join(' | '),
  })
}

const failed = rows.filter((row) => row.status !== 'ok')
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, ranges: rows }, null, 2)}\n`)
} else {
  process.stdout.write('=== 靶场汇总 ===\n')
  for (const row of rows) {
    const mark = row.status === 'ok' ? '✅' : row.status === 'missing' ? '⚪' : '❌'
    process.stdout.write(`  ${mark} ${row.name.padEnd(6)} ${row.file}\n`)
    if (row.summary !== '') process.stdout.write(`       ${row.summary}\n`)
    if (row.stderr !== '') process.stdout.write(`       stderr: ${row.stderr}\n`)
  }
  process.stdout.write(failed.length === 0 ? '\n三套靶场全部通过\n' : `\n有 ${failed.length} 套没通过\n`)
}
process.exitCode = failed.length === 0 ? 0 : 1
