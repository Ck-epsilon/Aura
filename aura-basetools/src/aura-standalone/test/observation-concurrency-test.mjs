/**
 * observation-concurrency-test.mjs —— P1.5：并发读数不能互相覆盖观测缓存。
 *
 * 旧实现每个进程启动读整份 `observations.json`、结束整份写回：两个 `aura read` 并发时
 * 后写的那个覆盖先写的，随后对先读文件做 `--require-observation` 编辑会报 `never-read`。
 *
 * 验收：
 *   1. 两个进程并发读不同文件；
 *   2. 两条观测都在账本里；
 *   3. 对两个文件分别严格编辑均成功；
 *   4. 外部改动后再严格编辑，仍正确拒绝（不是靠放宽严格闸变绿）。
 *
 * 运行：node src/aura-standalone/test/observation-concurrency-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const bin = path.join(here, '..', 'bin', 'aura.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-obs-race-'))
const cache = path.join(tmp, 'cache')
const env = { ...process.env, AURA_CACHE_DIR: cache }
const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env })
const json = (res) => {
  try { return JSON.parse(String(res.stdout).trim().split('\n').pop()) } catch { return { ok: false, error: String(res.stdout), stderr: String(res.stderr ?? '') } }
}
const file = (name) => path.join(tmp, name)
const spawnRead = (name) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, 'basetools', 'read', '--file', name, '--mode', 'full'], { cwd: tmp, env })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => resolve({ code, out, err }))
  })
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清不掉不影响判据 */ }
})

say('A 并发读两个文件')
{
  fs.writeFileSync(file('a.txt'), 'alpha\n')
  fs.writeFileSync(file('b.txt'), 'bravo\n')
  const [a, b] = await Promise.all([spawnRead('a.txt'), spawnRead('b.txt')])
  check(a.code === 0 && b.code === 0, 'A1 两个 read 进程都成功', JSON.stringify({ a: a.code, b: b.code, err: a.err || b.err }).slice(0, 180))

  const cacheFile = path.join(cache, 'observations.json')
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  const keys = raw.seen.map((entry) => entry.key)
  check(keys.some((key) => key.includes('a.txt@')) && keys.some((key) => key.includes('b.txt@')), 'A2 两条观测都在（没有互相覆盖）', JSON.stringify(keys))

  const editA = json(run(['basetools', 'edit', '--file', 'a.txt', '--lines', '1,1', '--replace', 'ALPHA', '--require-observation']))
  const editB = json(run(['basetools', 'edit', '--file', 'b.txt', '--lines', '1,1', '--replace', 'BRAVO', '--require-observation']))
  check(editA.ok === true && fs.readFileSync(file('a.txt'), 'utf8') === 'ALPHA\n', 'A3 a.txt 严格编辑成功', JSON.stringify(editA).slice(0, 180))
  check(editB.ok === true && fs.readFileSync(file('b.txt'), 'utf8') === 'BRAVO\n', 'A4 b.txt 严格编辑成功', JSON.stringify(editB).slice(0, 180))

  fs.writeFileSync(file('a.txt'), 'external\n')
  const stale = json(run(['basetools', 'edit', '--file', 'a.txt', '--lines', '1,1', '--replace', 'X', '--require-observation']))
  check(stale.ok === false && stale.code === 'PATCH_UNOBSERVED' && stale.reason === 'changed-since-read', 'A5 外部改动后严格编辑仍正确拒绝', JSON.stringify(stale).slice(0, 200))
  check(fs.readFileSync(file('a.txt'), 'utf8') === 'external\n', 'A6 拒绝时磁盘未变')
}

say('B 多轮并发（锁/合并压力）')
{
  const names = Array.from({ length: 6 }, (_, i) => `n${i + 1}.txt`)
  for (const name of names) fs.writeFileSync(file(name), `${name}\n`)
  const results = await Promise.all(names.map((name) => spawnRead(name)))
  check(results.every((result) => result.code === 0), 'B1 六个并发 read 都成功', JSON.stringify(results.map((r) => r.code)))
  const raw = JSON.parse(fs.readFileSync(path.join(cache, 'observations.json'), 'utf8'))
  const keys = raw.seen.map((entry) => entry.key)
  check(names.every((name) => keys.some((key) => key.includes(`${name}@`))), 'B2 六个文件的观测一条不少', JSON.stringify(keys))
  const edits = names.map((name) => json(run(['basetools', 'edit', '--file', name, '--lines', '1,1', '--replace', 'X', '--require-observation'])))
  check(edits.every((env) => env.ok === true), 'B3 六个文件都能严格编辑', JSON.stringify(edits.map((e) => e.code ?? 'ok')))
}

say(`\n--- 观测并发：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
