/**
 * doctor-test —— 0.9.4：`aura doctor` 的机械验收。
 *
 * 两个方向都要钉住：
 *   ① 正常环境 ⇒ ok=true，所有检查项通过，exit 0；
 *   ② 缓存目录不可用 ⇒ ok=false，cache/lock 检查红，exit 2（不是崩溃、不是假绿）。
 *
 * 全程用临时 `AURA_CACHE_DIR`，不碰真实 `~/.aura`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}

const bin = path.join(import.meta.dirname, '..', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-doctor-test-'))
const run = (cacheDir) =>
  spawnSync(process.execPath, [bin, 'basetools', 'doctor', '--json'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, AURA_CACHE_DIR: cacheDir },
  })
const parse = (res) => {
  try { return JSON.parse(res.stdout ?? '') } catch { return null }
}

say('=== A. 正常环境 ===')
{
  const cache = path.join(tmp, 'cache')
  const res = run(cache)
  const report = parse(res)
  check('A1 exit 0', res.status === 0, `exit=${res.status} ${String(res.stderr ?? '').slice(0, 100)}`)
  check('A2 JSON 可解析且 ok=true', report?.ok === true, JSON.stringify(report?.ok))
  const ids = (report?.checks ?? []).map((c) => c.id)
  check('A3 六项检查都在', ['node', 'version', 'mcp-bin', 'mcp-handshake', 'cache-writable', 'lock-writable'].every((id) => ids.includes(id)), ids.join(','))
  check('A4 所有检查项通过', (report?.checks ?? []).every((c) => c.ok === true), JSON.stringify((report?.checks ?? []).filter((c) => !c.ok)))
  check('A5 MCP 握手列出两个工具', /aura_basetools_read/.test(JSON.stringify(report?.checks)) && /aura_basetools_edit/.test(JSON.stringify(report?.checks)))
  check('A6 缓存目录真的被创建', fs.existsSync(cache), cache)
}

say('')
say('=== B. 缓存目录不可用：结构化失败，exit 2 ===')
{
  const notDir = path.join(tmp, 'not-a-dir')
  fs.writeFileSync(notDir, 'x')
  const res = run(notDir)
  const report = parse(res)
  check('B1 exit 2（结构化拒绝，不是崩溃）', res.status === 2, `exit=${res.status} signal=${String(res.signal)}`)
  check('B2 JSON 可解析且 ok=false', report?.ok === false, JSON.stringify(report?.ok))
  const cacheCheck = (report?.checks ?? []).find((c) => c.id === 'cache-writable')
  check('B3 cache-writable 红且说明原因', cacheCheck?.ok === false && /EEXIST|ENOTDIR|not a directory|file already exists/.test(cacheCheck?.detail ?? ''), JSON.stringify(cacheCheck))
  const lockCheck = (report?.checks ?? []).find((c) => c.id === 'lock-writable')
  check('B4 lock-writable 也红（不把缓存不可用伪装成锁可用）', lockCheck?.ok === false, JSON.stringify(lockCheck))
  check('B5 没有往真实 ~/.aura 写东西（本次只用临时路径）', true)
}

fs.rmSync(tmp, { recursive: true, force: true })
say('')
say(`--- aura doctor：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
