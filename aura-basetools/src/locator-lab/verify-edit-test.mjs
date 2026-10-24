/**
 * verify-edit-test —— 写后验证闭环。
 *
 * 判据是行为，不是实现：显式 `verify` 命令成功 ⇒ 提交；失败 ⇒ 文件逐字节回到写前，
 * 回执是 `PATCH_VERIFY_FAILED` 且带命令读数。没有 verify 时行为与旧版逐字一致。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createNodeFsProvider } from '../aura-standalone/lib/fs-provider.mjs'
import { editManyEnvelope, editEnvelope, writeEnvelope } from '../aura-standalone/lib/ops.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-verify-'))
process.env.AURA_CACHE_DIR = path.join(tmp, 'cache')
const provider = createNodeFsProvider({ resolveRoot: tmp })
const file = (name) => path.join(tmp, name)
const node = `"${process.execPath}"`
const okCmd = `${node} -e "process.exit(0)"`
const failCmd = `${node} -e "process.exit(7)"`

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}

console.log('=== A. 单目标：verify 成功 / 失败 ===')
{
  fs.writeFileSync(file('ok.txt'), 'one\n')
  const env = await editEnvelope(provider, {
    file: 'ok.txt',
    hunks: [{ lines: [1, 1], replace: 'ONE' }],
    verify: okCmd,
  })
  check('A1 verify 成功 ⇒ ok=true', env.ok === true, JSON.stringify(env).slice(0, 160))
  check('A2 回执带 verification.ok', env.verification?.ok === true && env.verification?.exitCode === 0, JSON.stringify(env.verification))
  check('A3 文件已提交', fs.readFileSync(file('ok.txt'), 'utf8') === 'ONE\n', JSON.stringify(fs.readFileSync(file('ok.txt'), 'utf8')))

  fs.writeFileSync(file('bad.txt'), 'two\n')
  const refused = await editEnvelope(provider, {
    file: 'bad.txt',
    hunks: [{ lines: [1, 1], replace: 'TWO' }],
    verify: failCmd,
  })
  check('A4 verify 失败 ⇒ ok=false / PATCH_VERIFY_FAILED', refused.ok === false && refused.code === 'PATCH_VERIFY_FAILED', JSON.stringify(refused).slice(0, 200))
  check('A5 回执带非零 exitCode', refused.verification?.exitCode === 7, JSON.stringify(refused.verification))
  check('A6 文件逐字节回到写前', fs.readFileSync(file('bad.txt'), 'utf8') === 'two\n', JSON.stringify(fs.readFileSync(file('bad.txt'), 'utf8')))
  check('A7 回执带 rollback 事实', refused.rollback?.status === 'rolled_back', JSON.stringify(refused.rollback))
}

console.log('')
console.log('=== B. 多目标：verify 失败 ⇒ 已落地的全部回滚 ===')
{
  fs.writeFileSync(file('m1.txt'), 'a\n')
  fs.writeFileSync(file('m2.txt'), 'b\n')
  const batch = await editManyEnvelope(provider, {
    targets: [
      { file_path: 'm1.txt', hunks: [{ lines: [1, 1], replace: 'A' }] },
      { file_path: 'm2.txt', hunks: [{ lines: [1, 1], replace: 'B' }] },
    ],
    verify: failCmd,
  })
  check('B1 多目标 verify 失败 ⇒ ok=false', batch.ok === false, JSON.stringify(batch).slice(0, 200))
  check('B2 两个文件都回到写前', fs.readFileSync(file('m1.txt'), 'utf8') === 'a\n' && fs.readFileSync(file('m2.txt'), 'utf8') === 'b\n', JSON.stringify([fs.readFileSync(file('m1.txt'), 'utf8'), fs.readFileSync(file('m2.txt'), 'utf8')]))
  check('B3 回执 applied=0 / rolled_back', batch.applied === 0 && batch.rolled_back === true, JSON.stringify({ applied: batch.applied, rolled_back: batch.rolled_back }))
}

console.log('')
console.log('=== C. write 也走 verify ===')
{
  const env = await writeEnvelope(provider, { file: 'w.txt', content: 'x\n', verify: failCmd })
  check('C1 write verify 失败 ⇒ PATCH_VERIFY_FAILED', env.ok === false && env.code === 'PATCH_VERIFY_FAILED', JSON.stringify(env).slice(0, 160))
  check('C2 新文件没有留下', fs.existsSync(file('w.txt')) === false)
}

console.log('')
console.log('=== D. 没有 verify 时行为不变 ===')
{
  fs.writeFileSync(file('plain.txt'), 'p\n')
  const env = await editEnvelope(provider, { file: 'plain.txt', hunks: [{ lines: [1, 1], replace: 'P' }] })
  check('D1 无 verify ⇒ 照常成功', env.ok === true && env.verification === undefined, JSON.stringify(env).slice(0, 120))
  check('D2 文件已写', fs.readFileSync(file('plain.txt'), 'utf8') === 'P\n')
}

console.log('')
console.log('=== E. CLI --verify 透传 ===')
{
  const bin = path.resolve(import.meta.dirname, '..', 'aura-standalone', 'bin', 'aura.mjs')
  fs.writeFileSync(file('cli.txt'), 'c\n')
  const res = spawnSync(
    process.execPath,
    [bin, 'basetools', 'edit', '--file', file('cli.txt'), '--lines', '1', '--replace', 'C', '--verify', failCmd],
    { cwd: tmp, encoding: 'utf8', env: { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cli-cache') } },
  )
  let out = null
  try { out = JSON.parse(String(res.stdout ?? '')) } catch { out = null }
  check('E1 CLI 退出码 2', res.status === 2, `${res.status} ${String(res.stderr ?? '').slice(0, 120)}`)
  check('E2 CLI 回执 PATCH_VERIFY_FAILED', out?.code === 'PATCH_VERIFY_FAILED', JSON.stringify(out).slice(0, 180))
  check('E3 CLI 失败后文件未变', fs.readFileSync(file('cli.txt'), 'utf8') === 'c\n', JSON.stringify(fs.readFileSync(file('cli.txt'), 'utf8')))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('')
console.log(`--- 写后验证：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
