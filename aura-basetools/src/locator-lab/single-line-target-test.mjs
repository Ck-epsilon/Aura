/**
 * single-line-target-test.mjs —— P0.2：符号地址落在共享行 / lone CR 时必须拒绝。
 *
 * 旧行为：压缩 JS 里两个顶层符号同为 1-1，`target=alpha` 落到整行，`beta` 一起消失；
 * 老式 Mac（lone CR）整份被当成一行，`target`/`lines` 会把整个文件替换成一个符号。
 * 这里钉住“拒绝 + 磁盘不变”，并确认 `old` 片段仍能安全地只改那一段。
 *
 * 运行：node src/locator-lab/single-line-target-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { planHunks } from './write-path.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const bin = path.join(here, '..', 'aura-standalone', 'bin', 'aura.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-single-line-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }
const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env })
const json = (res) => {
  try { return JSON.parse(String(res.stdout).trim().split('\n').pop()) } catch { return { ok: false, error: String(res.stdout) } }
}
const put = (name, text) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, text)
  return p
}
const codeOf = (fn) => {
  try { fn(); return 'NO_ERROR' } catch (error) { return error.code ?? 'ERROR' }
}
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清不掉不影响判据 */ }
})

const COMPRESSED = 'function alpha(){return 1}function beta(){return 2}\n'
const CR_ONLY = 'function alpha(){\r  return 1\r}\r'

say('A target 共享行')
{
  const p = put('min.js', COMPRESSED)
  const before = fs.readFileSync(p)
  const res = run(['basetools', 'edit', '--file', p, '--target', 'alpha', '--replace', 'x'])
  const env = json(res)
  check(res.status === 2 && env.code === 'LOCATOR_LINE_SHARED', 'A1 压缩 JS 的 target=alpha ⇒ LOCATOR_LINE_SHARED', JSON.stringify(env).slice(0, 220))
  check(fs.readFileSync(p).equals(before), 'A2 被拒后磁盘逐字节不变')
  check(env.candidates?.some((c) => c.name === 'beta'), 'A3 回执点名同行候选 beta', JSON.stringify(env.candidates))
  check(codeOf(() => planHunks(COMPRESSED, [{ target: 'alpha', replace: 'x' }], 'min.js')) === 'LOCATOR_LINE_SHARED', 'A4 引擎层同一判据（不是 CLI 自己拦）')

  const single = 'function alpha(){return 1}\n'
  const singlePlan = planHunks(single, [{ target: 'alpha', replace: 'function alpha(){return 9}' }], 'single.js')
  check(singlePlan.content === 'function alpha(){return 9}\n', 'A5 没有同行兄弟时 target 仍正常')
}

say('B lone CR')
{
  const p = put('cr.mjs', CR_ONLY)
  const before = fs.readFileSync(p)
  const target = json(run(['basetools', 'edit', '--file', p, '--target', 'alpha', '--replace', 'x']))
  check(target.code === 'LOCATOR_LONE_CR', 'B1 lone CR + target ⇒ LOCATOR_LONE_CR', JSON.stringify(target).slice(0, 220))
  const lines = json(run(['basetools', 'edit', '--file', p, '--lines', '1', '--replace', 'x']))
  check(lines.code === 'LOCATOR_LONE_CR', 'B2 lone CR + lines ⇒ LOCATOR_LONE_CR', JSON.stringify(lines).slice(0, 220))
  check(fs.readFileSync(p).equals(before), 'B3 两次拒绝后磁盘逐字节不变')
  check(codeOf(() => planHunks(CR_ONLY, [{ target: 'alpha', replace: 'x' }], 'cr.mjs')) === 'LOCATOR_LONE_CR', 'B4 引擎层 target 同一判据')
  check(codeOf(() => planHunks(CR_ONLY, [{ lines: [1, 1], replace: 'x' }], 'cr.mjs')) === 'LOCATOR_LONE_CR', 'B5 引擎层 lines 同一判据')

  const oldTarget = json(run(['basetools', 'edit', '--file', p, '--old', 'return 1', '--replace', 'return 9']))
  check(oldTarget.ok === true && fs.readFileSync(p, 'utf8') === 'function alpha(){\r  return 9\r}\r', 'B6 old 片段仍可安全修改 lone CR 文件', JSON.stringify(oldTarget).slice(0, 200))
}

say('C 压缩文件里的 old 片段')
{
  const p = put('min-old.js', COMPRESSED)
  const res = json(run(['basetools', 'edit', '--file', p, '--old', 'return 1', '--replace', 'return 9']))
  check(res.ok === true && fs.readFileSync(p, 'utf8') === 'function alpha(){return 9}function beta(){return 2}\n', 'C1 old 只改命中片段，beta 保留', JSON.stringify(res).slice(0, 200))
}

say(`\n--- 单行/CR 寻址：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
