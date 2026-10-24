/**
 * tx-session-test —— 跨调用事务：begin → edit --tx（多次）→ commit/rollback。
 *
 * 判据只走 CLI 子进程（真正的跨进程持久化），不读私有状态之外的磁盘结果。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-tx-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }
const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env })
const json = (res) => {
  try { return JSON.parse(String(res.stdout ?? '')) } catch { return null }
}
const node = `"${process.execPath}"`
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

console.log('=== A. begin → 两次 edit → commit ===')
{
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'b\n')
  const begun = json(run(['basetools', 'tx', 'begin']))
  const id = begun?.transaction?.id
  check('A1 begin 返回 open/pending 事务', begun?.ok === true && typeof id === 'string' && begun.transaction.status === 'pending', JSON.stringify(begun).slice(0, 160))

  const e1 = json(run(['basetools', 'edit', '--file', path.join(tmp, 'a.txt'), '--lines', '1', '--replace', 'A', '--tx', id]))
  check('A2 第一次 edit --tx 成功且未提交', e1?.ok === true && e1.transaction?.id === id, JSON.stringify(e1).slice(0, 160))
  check('A3 第一次写已落盘', fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8') === 'A\n')
  const e2 = json(run(['basetools', 'edit', '--file', path.join(tmp, 'b.txt'), '--lines', '1', '--replace', 'B', '--tx', id]))
  check('A4 第二次 edit --tx 成功', e2?.ok === true, JSON.stringify(e2).slice(0, 160))
  check('A5 第二次写已落盘', fs.readFileSync(path.join(tmp, 'b.txt'), 'utf8') === 'B\n')

  const committed = json(run(['basetools', 'tx', 'commit', '--id', id]))
  check('A6 commit 成功', committed?.ok === true && committed.transaction.status === 'committed', JSON.stringify(committed).slice(0, 160))
  check('A7 两处修改都保留', fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8') === 'A\n' && fs.readFileSync(path.join(tmp, 'b.txt'), 'utf8') === 'B\n')
}

console.log('')
console.log('=== B. begin → edit → rollback ===')
{
  fs.writeFileSync(path.join(tmp, 'c.txt'), 'c\n')
  const begun = json(run(['basetools', 'tx', 'begin']))
  const id = begun.transaction.id
  const e = json(run(['basetools', 'edit', '--file', path.join(tmp, 'c.txt'), '--lines', '1', '--replace', 'C', '--tx', id]))
  check('B1 edit 成功', e?.ok === true)
  const back = json(run(['basetools', 'tx', 'rollback', '--id', id]))
  check('B2 rollback 返回 rolled_back', back?.ok === true && back.rollback?.status === 'rolled_back', JSON.stringify(back).slice(0, 160))
  check('B3 文件回到原字节', fs.readFileSync(path.join(tmp, 'c.txt'), 'utf8') === 'c\n', JSON.stringify(fs.readFileSync(path.join(tmp, 'c.txt'), 'utf8')))
}

console.log('')
console.log('=== C. commit --verify 失败 ⇒ 整个事务回滚 ===')
{
  fs.writeFileSync(path.join(tmp, 'd.txt'), 'd\n')
  const begun = json(run(['basetools', 'tx', 'begin']))
  const id = begun.transaction.id
  json(run(['basetools', 'edit', '--file', path.join(tmp, 'd.txt'), '--lines', '1', '--replace', 'D', '--tx', id]))
  const refused = json(run(['basetools', 'tx', 'commit', '--id', id, '--verify', failCmd]))
  check('C1 commit 返回 PATCH_VERIFY_FAILED', refused?.ok === false && refused.code === 'PATCH_VERIFY_FAILED', JSON.stringify(refused).slice(0, 200))
  check('C2 文件回到事务前', fs.readFileSync(path.join(tmp, 'd.txt'), 'utf8') === 'd\n', JSON.stringify(fs.readFileSync(path.join(tmp, 'd.txt'), 'utf8')))
}

console.log('')
console.log('=== D. 提交前外部改动 ⇒ TX_STALE，不覆盖 ===')
{
  fs.writeFileSync(path.join(tmp, 'e.txt'), 'e\n')
  const begun = json(run(['basetools', 'tx', 'begin']))
  const id = begun.transaction.id
  json(run(['basetools', 'edit', '--file', path.join(tmp, 'e.txt'), '--lines', '1', '--replace', 'E', '--tx', id]))
  fs.writeFileSync(path.join(tmp, 'e.txt'), 'external\n')
  const stale = json(run(['basetools', 'tx', 'commit', '--id', id]))
  check('D1 commit 拒绝无法合并的外部改动（TX_CONFLICT）', stale?.ok === false && stale.code === 'TX_CONFLICT', JSON.stringify(stale).slice(0, 180))
  check('D2 外部内容没有被覆盖', fs.readFileSync(path.join(tmp, 'e.txt'), 'utf8') === 'external\n')
}

console.log('')
console.log('=== E. MCP：tx begin / edit.transaction / tx commit ===')
{
  const mcpPath = path.join(root, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')
  const call = (frames) => {
    const res = spawnSync(process.execPath, [mcpPath], {
      cwd: tmp,
      input: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`,
      encoding: 'utf8',
      env,
      timeout: 30000,
    })
    const byId = new Map()
    for (const line of String(res.stdout ?? '').split('\n')) {
      if (line.trim() === '') continue
      try { const msg = JSON.parse(line); byId.set(msg.id, msg) } catch { /* 只收 JSON 行 */ }
    }
    return { res, byId }
  }
  const payload = (msg) => {
    try { return JSON.parse(msg?.result?.content?.[0]?.text ?? 'null') } catch { return null }
  }
  const first = call([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_basetools_tx', arguments: { action: 'begin' } } },
  ])
  const begun = payload(first.byId.get(2))
  const id = begun?.transaction?.id
  check('E1 MCP tx begin 返回 id', begun?.ok === true && typeof id === 'string', JSON.stringify(begun).slice(0, 160))

  fs.writeFileSync(path.join(tmp, 'mcp.txt'), 'm\n')
  const second = call([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: path.join(tmp, 'mcp.txt'), hunks: [{ lines: [1, 1], replace: 'M' }], transaction: id } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_basetools_tx', arguments: { action: 'commit', transaction: id } } },
  ])
  const edited = payload(second.byId.get(2))
  const committed = payload(second.byId.get(3))
  check('E2 MCP edit.transaction 成功', edited?.ok === true && edited.transaction?.id === id, JSON.stringify(edited).slice(0, 180))
  check('E3 MCP tx commit 成功', committed?.ok === true && committed.transaction?.status === 'committed', JSON.stringify(committed).slice(0, 180))
  check('E4 文件已提交', fs.readFileSync(path.join(tmp, 'mcp.txt'), 'utf8') === 'M\n', JSON.stringify(fs.readFileSync(path.join(tmp, 'mcp.txt'), 'utf8')))
}

console.log('')
console.log('=== F. 并发合并：非重叠改动合并，重叠冲突拒绝 ===')
{
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' })
  if (git.status !== 0) {
    console.log('  ⏭ Git 不可用，跳过 merge-file 路径（提交会返回 TX_CONFLICT，不会覆盖）')
  } else {
    fs.writeFileSync(path.join(tmp, 'merge.txt'), 'one\ntwo\nthree\n')
    const begun = json(run(['basetools', 'tx', 'begin']))
    const id = begun.transaction.id
    json(run(['basetools', 'edit', '--file', path.join(tmp, 'merge.txt'), '--lines', '1', '--replace', 'ONE', '--tx', id]))
    fs.writeFileSync(path.join(tmp, 'merge.txt'), 'one\ntwo\nTHREE\n')
    const committed = json(run(['basetools', 'tx', 'commit', '--id', id]))
    check('F1 非重叠改动合并成功', committed?.ok === true && committed.merges?.length === 1, JSON.stringify(committed).slice(0, 220))
    check('F2 双方改动都在', fs.readFileSync(path.join(tmp, 'merge.txt'), 'utf8') === 'ONE\ntwo\nTHREE\n', JSON.stringify(fs.readFileSync(path.join(tmp, 'merge.txt'), 'utf8')))

    fs.writeFileSync(path.join(tmp, 'conflict.txt'), 'alpha\nbeta\n')
    const begun2 = json(run(['basetools', 'tx', 'begin']))
    const id2 = begun2.transaction.id
    json(run(['basetools', 'edit', '--file', path.join(tmp, 'conflict.txt'), '--lines', '1', '--replace', 'ALPHA', '--tx', id2]))
    fs.writeFileSync(path.join(tmp, 'conflict.txt'), 'external\nbeta\n')
    const conflicted = json(run(['basetools', 'tx', 'commit', '--id', id2]))
    check('F3 同一区域冲突 ⇒ TX_CONFLICT', conflicted?.ok === false && conflicted.code === 'TX_CONFLICT', JSON.stringify(conflicted).slice(0, 220))
    check('F4 冲突时不覆盖外部内容', fs.readFileSync(path.join(tmp, 'conflict.txt'), 'utf8') === 'external\nbeta\n')

    fs.writeFileSync(path.join(tmp, 'rollback-merge.txt'), 'a\nb\nc\n')
    const begun3 = json(run(['basetools', 'tx', 'begin']))
    const id3 = begun3.transaction.id
    json(run(['basetools', 'edit', '--file', path.join(tmp, 'rollback-merge.txt'), '--lines', '1', '--replace', 'A', '--tx', id3]))
    fs.writeFileSync(path.join(tmp, 'rollback-merge.txt'), 'a\nb\nC\n')
    const refused = json(run(['basetools', 'tx', 'commit', '--id', id3, '--verify', failCmd]))
    check('F5 合并后 verify 失败 ⇒ 回滚', refused?.ok === false && refused.code === 'PATCH_VERIFY_FAILED', JSON.stringify(refused).slice(0, 200))
    check('F6 回滚保留外部改动', fs.readFileSync(path.join(tmp, 'rollback-merge.txt'), 'utf8') === 'a\nb\nC\n', JSON.stringify(fs.readFileSync(path.join(tmp, 'rollback-merge.txt'), 'utf8')))
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('')
console.log(`--- 跨调用事务：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
