/**
 * observation-gate-test.mjs —— 0.10.3：严格新鲜度（read-before-write）。
 *
 * 覆盖：
 *   A CLI：默认不强制（但如实标 unverified_region）、--require-observation 的 never-read /
 *     changed-since-read、dry-run 同判、create 豁免、多目标全量规划时零写入、写后自带观测
 *   B MCP：schema 声明、blind 拒绝、同进程 read→edit、dry-run、create
 *   C 引擎 helper：never-read / 当前版本通过 / 版本变化拒绝
 *
 * 运行：node src/locator-lab/observation-gate-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { requireObservedRevision } from './write-path.mjs'
import { contentToken, rememberRead } from './read-core.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..')
const bin = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const mcpBin = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-observed-'))
const cache = path.join(tmp, 'cache')
const env = { ...process.env, AURA_CACHE_DIR: cache, AURA_TEST_EXPOSE_LEGACY: '1' }
const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env })
const json = (res) => {
  try {
    return JSON.parse(String(res.stdout).trim().split('\n').pop())
  } catch {
    return { ok: false, error: `stdout 不是 JSON：${JSON.stringify(res.stdout)} ${String(res.stderr ?? '').trim().split('\n').slice(0, 3).join(' / ')}` }
  }
}
const file = (name) => path.join(tmp, name)
const put = (name, text) => {
  fs.writeFileSync(file(name), text)
  return file(name)
}
const read = (name) => json(run(['basetools', 'read', '--file', name, '--mode', 'full']))
process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 清不掉不影响判据 */
  }
})

// ── A CLI ────────────────────────────────────────────────────────────────
say('A CLI：严格新鲜度')
{
  put('plain.txt', 'alpha\nbeta\n')
  const blind = json(run(['basetools', 'edit', '--file', 'plain.txt', '--lines', '1,1', '--replace', 'ALPHA']))
  check(blind.ok === true && fs.readFileSync(file('plain.txt'), 'utf8') === 'ALPHA\nbeta\n', 'A1 默认仍允许盲改（不破坏既有工作流）')
  check(blind.result?.unverified_region === true, 'A2 默认盲改在回执里如实标 unverified_region', JSON.stringify(blind.result?.unverified_region))

  put('strict.txt', 'alpha\nbeta\n')
  const before = fs.readFileSync(file('strict.txt'))
  const refused = json(run(['basetools', 'edit', '--file', 'strict.txt', '--lines', '1,1', '--replace', 'ALPHA', '--require-observation']))
  check(refused.ok === false && refused.code === 'PATCH_UNOBSERVED' && refused.reason === 'never-read', 'A3 没读过 + 严格模式 ⇒ PATCH_UNOBSERVED（never-read）', JSON.stringify(refused).slice(0, 180))
  check(fs.readFileSync(file('strict.txt')).equals(before), 'A4 拒绝时磁盘没变')

  read('strict.txt')
  const ok = json(run(['basetools', 'edit', '--file', 'strict.txt', '--lines', '1,1', '--replace', 'ALPHA', '--require-observation']))
  check(ok.ok === true && fs.readFileSync(file('strict.txt'), 'utf8') === 'ALPHA\nbeta\n', 'A5 读过之后严格模式放行')
  check(ok.result?.unverified_region === undefined, 'A6 有观测基准时不标 unverified_region', JSON.stringify(ok.result?.unverified_region))

  const follow = json(run(['basetools', 'edit', '--file', 'strict.txt', '--lines', '1,1', '--replace', 'FIRST', '--require-observation']))
  check(follow.ok === true, 'A7 自己刚写的内容算已观测（不必回读）', JSON.stringify(follow).slice(0, 160))

  put('map-strict.js', 'export function alpha() {\n  return 1\n}\n')
  const mapRead = json(run(['basetools', 'read', '--file', 'map-strict.js', '--mode', 'map']))
  const afterMap = json(run(['basetools', 'edit', '--file', 'map-strict.js', '--lines', '2,2', '--replace', '  return 2', '--require-observation']))
  check(mapRead.ok === true && afterMap.ok === true, 'A7b map/digest 读也算观测（不必整份读）', JSON.stringify(afterMap).slice(0, 160))

  fs.writeFileSync(file('strict.txt'), 'external\n')
  const changed = json(run(['basetools', 'edit', '--file', 'strict.txt', '--lines', '1,1', '--replace', 'X', '--require-observation']))
  check(changed.ok === false && changed.code === 'PATCH_UNOBSERVED' && changed.reason === 'changed-since-read', 'A8 读过之后文件又变 ⇒ changed-since-read', JSON.stringify(changed).slice(0, 180))

  put('dry-strict.txt', 'a\n')
  const dry = json(run(['basetools', 'edit', '--file', 'dry-strict.txt', '--lines', '1,1', '--replace', 'b', '--dry-run', '--require-observation']))
  check(dry.ok === false && dry.code === 'PATCH_UNOBSERVED' && fs.readFileSync(file('dry-strict.txt'), 'utf8') === 'a\n', 'A9 dry-run 也执行严格判决（预演不撒谎）', JSON.stringify(dry).slice(0, 160))
  const blindDry = json(run(['basetools', 'edit', '--file', 'dry-strict.txt', '--lines', '1,1', '--replace', 'b', '--dry-run']))
  check(blindDry.ok === true && blindDry.result?.unverified_region === true, 'A9b 默认盲改的 dry-run 如实标 unverified_region', JSON.stringify(blindDry.result?.unverified_region))

  const created = json(run(['basetools', 'edit', '--file', 'created-strict.txt', '--create', 'new\n', '--require-observation']))
  check(created.ok === true && fs.readFileSync(file('created-strict.txt'), 'utf8') === 'new\n', 'A10 create 不受严格闸约束（新文件没有“读过”可言）')

  put('multi-a.txt', 'a\n')
  put('multi-b.txt', 'b\n')
  read('multi-a.txt')
  const batchBeforeA = fs.readFileSync(file('multi-a.txt'))
  const batchBeforeB = fs.readFileSync(file('multi-b.txt'))
  const targets = JSON.stringify([
    { file_path: file('multi-a.txt'), hunks: [{ lines: [1, 1], replace: 'A' }] },
    { file_path: file('multi-b.txt'), hunks: [{ lines: [1, 1], replace: 'B' }] },
  ])
  const batch = json(run(['basetools', 'edit', '--targets', targets, '--require-observation']))
  check(batch.ok === false, 'A11 多目标里有一个未读 ⇒ 整批失败', JSON.stringify(batch).slice(0, 180))
  check(fs.readFileSync(file('multi-a.txt')).equals(batchBeforeA) && fs.readFileSync(file('multi-b.txt')).equals(batchBeforeB), 'A12 整批失败时两个文件都零写入')
  read('multi-b.txt')
  const batchOk = json(run(['basetools', 'edit', '--targets', targets, '--require-observation']))
  check(batchOk.ok === true && fs.readFileSync(file('multi-a.txt'), 'utf8') === 'A\n' && fs.readFileSync(file('multi-b.txt'), 'utf8') === 'B\n', 'A13 两个都读过 ⇒ 整批放行并落盘')

  // 0.10.5 评审：targets 元素上的 require_observation 曾被静默丢掉
  put('elem.txt', 'alpha\n')
  const elemBefore = fs.readFileSync(file('elem.txt'))
  const elemTargets = JSON.stringify([
    { file_path: file('elem.txt'), hunks: [{ lines: [1, 1], replace: 'X' }], require_observation: true },
  ])
  const elem = json(run(['basetools', 'edit', '--targets', elemTargets]))
  check(elem.ok === false && fs.readFileSync(file('elem.txt')).equals(elemBefore), 'A14 targets 元素自带 require_observation ⇒ 未读时拒绝且零写入', JSON.stringify(elem).slice(0, 180))

  // 0.10.6 复审：同文件多个 targets 合并时，元素级 require_observation 不能被 groupRequest 丢掉
  put('merge.txt', 'a\nb\n')
  const mergeBefore = fs.readFileSync(file('merge.txt'))
  const mergeTargets = JSON.stringify([
    { file_path: file('merge.txt'), hunks: [{ lines: [1, 1], replace: 'X' }], require_observation: true },
    { file_path: file('merge.txt'), hunks: [{ lines: [2, 2], replace: 'Y' }] },
  ])
  const merged = json(run(['basetools', 'edit', '--targets', mergeTargets]))
  check(merged.ok === false && merged.edits?.some((edit) => edit.error?.code === 'PATCH_UNOBSERVED'), 'A14b 同文件合并仍保留元素级 require_observation（整组拒绝）', JSON.stringify(merged).slice(0, 220))
  check(fs.readFileSync(file('merge.txt')).equals(mergeBefore), 'A14c 合并组拒绝时磁盘没变')

  // 0.10.6 复审：非法元素值必须在参数面回 JSON（dry-run 分支曾直接吐 Node 栈）
  const badElement = JSON.stringify([
    { file_path: file('merge.txt'), hunks: [{ lines: [1, 1], replace: 'x' }], require_observation: 'yes' },
  ])
  const badDryRes = run(['basetools', 'edit', '--targets', badElement, '--dry-run'])
  const badDry = json(badDryRes)
  check(badDryRes.status === 1 && badDry.ok === false && badDry.code === 'USAGE' && badDry.shape === 'ARGS_BAD_REQUIRE_OBSERVATION', 'A14d 非法 require_observation ⇒ exit 1 + JSON 参数面拒绝', JSON.stringify({ status: badDryRes.status, env: badDry }).slice(0, 220))

  // 0.10.5 评审（P1）：>256 KiB 的令牌-only 观测上没有全文，陈旧句柄必须走 PATCH_HANDLE_STALE
  fs.writeFileSync(file('big-handle.txt'), `A\n${'x'.repeat(300000)}\n`)
  const handleRead = json(run(['basetools', 'read', '--file', 'big-handle.txt', '--lines', '1,1']))
  const staleHandle = handleRead.handle
  fs.writeFileSync(file('big-handle.txt'), `B\n${'x'.repeat(300000)}\n`)
  const staleHandleEdit = json(run(['basetools', 'edit', '--file', 'big-handle.txt', '--handle', staleHandle, '--replace', 'Z']))
  check(typeof staleHandle === 'string' && staleHandleEdit.ok === false && staleHandleEdit.code === 'PATCH_HANDLE_STALE', 'A16 >256 KiB 上的陈旧句柄 ⇒ PATCH_HANDLE_STALE（不是 TypeError）', JSON.stringify(staleHandleEdit).slice(0, 200))

  // 0.10.6 复审：token-only 观测的 basis 只认最新那一版（回退到更早版本不再冒充“已核对”）
  const tail = 'x'.repeat(262145)
  fs.writeFileSync(file('big-basis.txt'), `A\n${tail}\n`)
  json(run(['basetools', 'read', '--file', 'big-basis.txt', '--lines', '1,1']))
  fs.writeFileSync(file('big-basis.txt'), `B\n${tail}\n`)
  json(run(['basetools', 'read', '--file', 'big-basis.txt', '--lines', '1,1']))
  fs.writeFileSync(file('big-basis.txt'), `A\n${tail}\n`)
  const basisEdit = json(run(['basetools', 'edit', '--file', 'big-basis.txt', '--lines', '1,1', '--replace', 'Z']))
  check(basisEdit.ok === true && basisEdit.result?.unverified_region === true, 'A17 当前版本只是“更早读过”时不再声称 observation（标 unverified）', JSON.stringify(basisEdit.result?.unverified_region))

  // 0.10.6 复审：changed 模式的降级理由要区分“超限不存全文”与“缓存淘汰”
  fs.writeFileSync(file('big-changed.txt'), `A\n${tail}\n`)
  const changedBase = json(run(['basetools', 'read', '--file', 'big-changed.txt', '--mode', 'lines', '--lines', '1,1']))
  fs.writeFileSync(file('big-changed.txt'), `A\n${tail}\nB\n`)
  const changedBig = json(run(['basetools', 'read', '--file', 'big-changed.txt', '--mode', 'changed', '--since', changedBase.version]))
  check(changedBig.ok === true && /exceeds 256 KiB/.test(String(changedBig.note)) && !/no longer cached/.test(String(changedBig.note)), 'A18 大文件 changed 降级说明“超限未保留全文”，不谎称缓存淘汰', JSON.stringify(changedBig.note))

  // 0.10.5 评审（P1）：>256 KiB 的文件此前整条观测被丢掉，严格闸永远无法满足
  fs.writeFileSync(file('big.txt'), 'x'.repeat(262145))
  const bigRead = json(run(['basetools', 'read', '--file', 'big.txt', '--mode', 'lines', '--lines', '1,1']))
  const bigWrite = json(run(['basetools', 'write', '--file', 'big.txt', '--content', 'y\n']))
  check(bigRead.ok === true && bigWrite.ok === true && fs.readFileSync(file('big.txt'), 'utf8') === 'y\n', 'A15 >256 KiB 的文件读过后严格覆写可满足（令牌仍记账）', JSON.stringify(bigWrite).slice(0, 180))
}

// ── B MCP ────────────────────────────────────────────────────────────────
say('B MCP：read → edit 同进程')
{
  put('mcp-strict.txt', 'alpha\n')
  put('mcp-blind.txt', 'alpha\n')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: file('mcp-blind.txt'), hunks: [{ lines: [1, 1], replace: 'X' }], require_observation: true } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: { file_path: file('mcp-strict.txt'), mode: 'full' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: file('mcp-strict.txt'), hunks: [{ lines: [1, 1], replace: 'ALPHA' }], require_observation: true } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: file('mcp-blind.txt'), hunks: [{ lines: [1, 1], replace: 'X' }], require_observation: true, dry_run: true } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: file('mcp-created-strict.txt'), create: 'created\n', require_observation: true } } },
  ]
  const res = spawnSync(process.execPath, [mcpBin], { input: `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`, encoding: 'utf8', env })
  const replies = String(res.stdout).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(replies.map((reply) => [reply.id, reply]))
  const envOf = (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}')
  const editTool = byId.get(2)?.result?.tools?.find((tool) => tool.name === 'aura_basetools_edit')
  check(editTool?.inputSchema?.properties?.require_observation?.type === 'boolean', 'B1 MCP 声明 require_observation: boolean', JSON.stringify(editTool?.inputSchema?.properties?.require_observation))
  check(envOf(3).ok === false && envOf(3).code === 'PATCH_UNOBSERVED', 'B2 未读 + 严格 ⇒ 结构化拒绝', JSON.stringify(envOf(3)).slice(0, 160))
  check(envOf(4).ok === true, 'B3 同进程 aura_basetools_read 成功', JSON.stringify(envOf(4)).slice(0, 120))
  check(envOf(5).ok === true && fs.readFileSync(file('mcp-strict.txt'), 'utf8') === 'ALPHA\n', 'B4 同进程 read → edit 严格模式放行')
  check(envOf(6).ok === false && envOf(6).code === 'PATCH_UNOBSERVED', 'B5 未读 + dry_run + 严格 ⇒ 同样拒绝', JSON.stringify(envOf(6)).slice(0, 160))
  check(envOf(7).ok === true && fs.readFileSync(file('mcp-created-strict.txt'), 'utf8') === 'created\n', 'B6 create 豁免严格闸')
}

// ── C 引擎 helper ────────────────────────────────────────────────────────
say('C 引擎：requireObservedRevision')
{
  const displayPath = path.join(tmp, 'engine-helper.js')
  let never = null
  try {
    requireObservedRevision({ displayPath, content: 'one\n' })
  } catch (error) {
    never = error
  }
  check(never?.code === 'PATCH_UNOBSERVED' && never.reason === 'never-read', 'C1 从没读过 ⇒ never-read', String(never?.code))

  rememberRead(displayPath, contentToken('one\n', false), 'one\n', false)
  let passed = true
  try {
    requireObservedRevision({ displayPath, content: 'one\n' })
  } catch {
    passed = false
  }
  check(passed, 'C2 账本里有这一版 ⇒ 通过')

  let stale = null
  try {
    requireObservedRevision({ displayPath, content: 'two\n' })
  } catch (error) {
    stale = error
  }
  check(stale?.code === 'PATCH_UNOBSERVED' && stale.reason === 'changed-since-read', 'C3 版本不同 ⇒ changed-since-read', String(stale?.code))
}

say(`\n--- 严格新鲜度：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
