/**
 * concurrency-crash-test —— 0.9.2：并发与崩溃一致性。
 *
 * 两个问题，各自有独立的判据：
 *   A. **多进程同工作区**：4 个 CLI 同时改同一个文件的不同行；工作区锁必须串行化，
 *      最终文件包含全部 4 处修改，且没有一个进程把别人的改动覆盖掉。
 *   B. **崩溃后的 pending 事务**：写了一个文件、没有 commit（模拟进程在提交前死掉），
 *      事务仍应能回滚到原始字节；磁盘不能留下半新半旧的内容。
 *
 * 判据只走公开入口（CLI 子进程 + transaction-store 的公开函数），不读私有状态。
 * 跑法：`node src/locator-lab/concurrency-crash-test.mjs`，全绿 exit 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createTransaction } from '../aura-standalone/lib/transaction-store.mjs'
import { createNodeFsProvider } from '../aura-standalone/lib/fs-provider.mjs'
import { lockFileFor, withWorkspaceLock } from '../aura-standalone/lib/workspace-lock.mjs'

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

const root = path.resolve(import.meta.dirname, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-concurrency-'))
process.env.AURA_CACHE_DIR = path.join(tmp, 'cache')

const runAsync = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: tmp,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('exit', (code, signal) => resolve({ code, signal, out, err }))
  })

say('=== A. 4 个进程同时改同一文件的不同行：锁串行化，不丢更新 ===')
{
  const file = path.join(tmp, 'shared.txt')
  const original = ['line 1', 'line 2', 'line 3', 'line 4', ''].join('\n')
  fs.writeFileSync(file, original)
  const env = { AURA_CACHE_DIR: path.join(tmp, 'cache'), AURA_LOCK_TIMEOUT_MS: '30000' }
  const jobs = [1, 2, 3, 4].map((k) =>
    runAsync(['basetools', 'edit', '--file', file, '--lines', `${k},${k}`, '--replace', `line ${k} edited`], env),
  )
  const results = await Promise.all(jobs)
  check('A1 4 个进程全部 exit 0（没有锁冲突被吞成成功）', results.every((r) => r.code === 0), results.map((r) => r.code).join(','))
  check('A2 没有进程报 WORKSPACE_LOCKED', results.every((r) => !/WORKSPACE_LOCKED/.test(r.out + r.err)), results.map((r) => (r.out + r.err).slice(0, 40)).join(' | '))
  const after = fs.readFileSync(file, 'utf8')
  const expected = ['line 1 edited', 'line 2 edited', 'line 3 edited', 'line 4 edited', ''].join('\n')
  check('A3 最终文件包含全部 4 处修改（无丢失更新）', after === expected, JSON.stringify(after))
  check('A4 每一行都只有一次替换（没有把别人的改动叠掉）', after.split('\n').filter((l) => l.endsWith('edited')).length === 4, JSON.stringify(after.split('\n')))
  check('A5 文件仍是合法文本（没有被截断/拼接）', after.endsWith('\n') && after.split('\n').length === 5, `${after.length}B / ${after.split('\n').length} lines`)
}

say('')
say('=== B. 崩溃后的 pending 事务：未 commit 也能回滚到原字节 ===')
{
  const dir = path.join(tmp, 'crash')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'crash.txt')
  fs.writeFileSync(file, 'ORIGINAL-BYTES\n')
  const provider = createNodeFsProvider({ resolveRoot: dir })
  const tx = createTransaction(dir, 'concurrency-crash-test')
  const proxy = tx.proxy(provider)
  await proxy.writeText('crash.txt', 'CHANGED-BYTES\n')
  check('B1 写入真的落盘（模拟进程已改过文件）', fs.readFileSync(file, 'utf8') === 'CHANGED-BYTES\n', JSON.stringify(fs.readFileSync(file, 'utf8')))
  check('B2 事务仍是 pending（没有 commit，模拟崩溃点）', tx.summary().status === 'pending', JSON.stringify(tx.summary()))
  const back = await tx.rollback(provider)
  check('B4 回滚返回 rolled_back', back.status === 'rolled_back' && back.restored === 1, JSON.stringify(back))
  check('B5 文件回到原始字节（不是半新半旧）', fs.readFileSync(file, 'utf8') === 'ORIGINAL-BYTES\n', JSON.stringify(fs.readFileSync(file, 'utf8')))
  check('B6 回滚后没有残留的临时文件', fs.readdirSync(dir).filter((n) => n.includes('aura-tmp')).length === 0, JSON.stringify(fs.readdirSync(dir)))
}


say('')
say('=== D. 空锁竞态：新鲜空锁不被抢走，陈旧空锁可回收 ===')
{
  const dir = path.join(tmp, 'lock-grace')
  fs.mkdirSync(dir, { recursive: true })
  const lock = lockFileFor(dir)
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.writeFileSync(lock, '')
  let ran = false
  let err = null
  try {
    await withWorkspaceLock(dir, async () => { ran = true; return 1 }, { timeoutMs: 200, staleMs: 10000 })
  } catch (error) {
    err = error
  }
  check('D1 新鲜空锁不被抢走（等待到超时，而不是删锁进入）', ran === false && err?.code === 'WORKSPACE_LOCKED', JSON.stringify({ ran, code: err?.code }))
  fs.utimesSync(lock, new Date(Date.now() - 20000), new Date(Date.now() - 20000))
  const out = await withWorkspaceLock(dir, async () => 42, { timeoutMs: 1000, staleMs: 10000 })
  check('D2 陈旧空锁可回收并正常执行', out === 42 && !fs.existsSync(lock), JSON.stringify({ out, exists: fs.existsSync(lock) }))
  fs.rmSync(lock, { force: true })
}


fs.rmSync(tmp, { recursive: true, force: true })
say('')
say(`--- 并发/崩溃：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
