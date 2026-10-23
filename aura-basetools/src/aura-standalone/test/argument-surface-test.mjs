/**
 * argument-surface-test.mjs —— P0.1 / P1.6：参数面不许静默。
 *
 * 判据：
 *   · CLI 未知旗标（`--dryrun`）⇒ USAGE/ARGS_UNKNOWN_KEY、exit 1、磁盘不变；
 *   · MCP 未知参数（顶层与 targets 元素）⇒ ok:false/code ARGS_UNKNOWN_KEY、isError、磁盘不变；
 *   · 合法 `--dry-run` / `dry_run` 仍是预演；
 *   · MCP initialize 不回显不存在的协议版本；非法类型回 -32602，不崩不挂死。
 *
 * 运行：node src/aura-standalone/test/argument-surface-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const bin = path.join(here, '..', 'bin', 'aura.mjs')
const mcpBin = path.join(here, '..', 'bin', 'aura-mcp.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-args-'))
const cache = path.join(tmp, 'cache')
const env = { ...process.env, AURA_CACHE_DIR: cache }
const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env })
const json = (res) => {
  try {
    return JSON.parse(String(res.stdout).trim().split('\n').pop())
  } catch {
    return { ok: false, error: `stdout 不是 JSON：${JSON.stringify(res.stdout)} ${String(res.stderr ?? '').trim().split('\n')[0] ?? ''}` }
  }
}
const file = (name) => path.join(tmp, name)
const put = (name, text) => {
  fs.writeFileSync(file(name), text)
  return file(name)
}
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清不掉不影响判据 */ }
})

// ── A CLI ────────────────────────────────────────────────────────────────
say('A CLI：未知旗标不执行、不写盘')
{
  const pathA = put('a.txt', 'alpha\n')
  const moved = run(['edit', '--file', pathA, '--lines', '1', '--replace', 'beta'])
  const movedEnv = json(moved)
  check(moved.status === 1 && movedEnv.shape === 'CLI_NAMESPACE_REQUIRED' && fs.readFileSync(pathA, 'utf8') === 'alpha\n', 'A0 顶层旧动词 ⇒ CLI_NAMESPACE_REQUIRED 且磁盘不变', JSON.stringify(movedEnv).slice(0, 200))

  const bad = run(['basetools', 'edit', '--file', pathA, '--lines', '1', '--replace', 'beta', '--dryrun'])
  const badEnv = json(bad)
  check(bad.status === 1 && badEnv.ok === false && badEnv.shape === 'ARGS_UNKNOWN_KEY', 'A1 --dryrun ⇒ exit 1 + ARGS_UNKNOWN_KEY', JSON.stringify({ status: bad.status, env: badEnv }).slice(0, 220))
  check(fs.readFileSync(pathA, 'utf8') === 'alpha\n', 'A2 --dryrun 被拒后磁盘不变')

  const positional = run(['basetools', 'edit', pathA, '--lines', '1', '--replace', 'beta'])
  const positionalEnv = json(positional)
  check(positional.status === 1 && positionalEnv.shape === 'ARGS_UNKNOWN_KEY', 'A3 裸位置参数也被拒', JSON.stringify(positionalEnv).slice(0, 180))

  const writeBad = run(['basetools', 'write', '--file', file('w.txt'), '--content', 'x\n', '--dryrun'])
  const writeBadEnv = json(writeBad)
  check(writeBad.status === 1 && writeBadEnv.shape === 'ARGS_UNKNOWN_KEY' && !fs.existsSync(file('w.txt')), 'A4 write --dryrun ⇒ 拒绝且不建文件', JSON.stringify(writeBadEnv).slice(0, 180))

  const good = run(['basetools', 'edit', '--file', pathA, '--lines', '1', '--replace', 'beta', '--dry-run'])
  const goodEnv = json(good)
  check(good.status === 0 && goodEnv.ok === true && goodEnv.result?.dryRun === true, 'A5 合法 --dry-run 仍是预演', JSON.stringify(goodEnv).slice(0, 160))
  check(fs.readFileSync(pathA, 'utf8') === 'alpha\n', 'A6 预演之后磁盘不变')

  const elemBad = json(run(['basetools', 'edit', '--targets', JSON.stringify([
    { file_path: pathA, hunks: [{ lines: [1, 1], replace: 'beta' }], dryrun: true },
  ])]))
  check(elemBad.ok === false && elemBad.shape === 'ARGS_UNKNOWN_KEY' && fs.readFileSync(pathA, 'utf8') === 'alpha\n', 'A7 targets 元素未知键 ⇒ 参数面拒绝且零写入', JSON.stringify(elemBad).slice(0, 200))

  const readElemBad = json(run(['basetools', 'read', '--targets', JSON.stringify([{ file_path: pathA, mode: 'map', dryrun: true }])]))
  check(readElemBad.ok === false && readElemBad.shape === 'ARGS_UNKNOWN_KEY', 'A8 read targets 元素未知键 ⇒ 拒绝', JSON.stringify(readElemBad).slice(0, 180))
}

// ── B MCP ────────────────────────────────────────────────────────────────
say('B MCP：未知参数 + initialize 协议版本')
{
  const pathB = put('b.txt', 'alpha\n')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: pathB, hunks: [{ lines: [1, 1], replace: 'beta' }], dryrun: true } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { targets: [{ file_path: pathB, hunks: [{ lines: [1, 1], replace: 'beta' }], dryrun: true }] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: pathB, hunks: [{ lines: [1, 1], replace: 'beta' }], dry_run: true } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: { file: pathB, mode: 'map' } } },
    { jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '9999-99-99' } },
    { jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: 42 } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: { file_path: pathB, mode: 'map' } } },
  ]
  const res = spawnSync(process.execPath, [mcpBin], { input: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`, encoding: 'utf8', env })
  const replies = String(res.stdout).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(replies.map((reply) => [reply.id, reply]))
  const envOf = (id) => {
    const text = byId.get(id)?.result?.content?.[0]?.text
    try { return JSON.parse(text ?? '{}') } catch { return {} }
  }
  check(byId.get(2)?.result?.isError === true && envOf(2).code === 'ARGS_UNKNOWN_KEY', 'B1 MCP 顶层 dryrun ⇒ ARGS_UNKNOWN_KEY/isError', JSON.stringify(envOf(2)).slice(0, 180))
  check(byId.get(3)?.result?.isError === true && envOf(3).code === 'ARGS_UNKNOWN_KEY', 'B2 MCP targets 元素 dryrun ⇒ ARGS_UNKNOWN_KEY', JSON.stringify(envOf(3)).slice(0, 180))
  check(fs.readFileSync(pathB, 'utf8') === 'alpha\n', 'B3 两次未知参数都没有写盘')
  check(byId.get(4)?.result?.isError === false && envOf(4).result?.dryRun === true, 'B4 合法 dry_run 仍是预演')
  check(envOf(5).code === 'ARGS_UNKNOWN_KEY', 'B5 aura_basetools_read 的 file 拼写 ⇒ ARGS_UNKNOWN_KEY', JSON.stringify(envOf(5)).slice(0, 160))
  check(byId.get(1)?.result?.protocolVersion === '2025-06-18', 'B6 受支持的协议版本原样返回')
  check(byId.get(6)?.result?.protocolVersion === '2025-06-18' && Array.isArray(byId.get(6)?.result?.supportedProtocolVersions), 'B7 不支持的版本返回服务端最新版本 + supported 列表', JSON.stringify(byId.get(6)?.result).slice(0, 180))
  check(typeof byId.get(7)?.error?.code === 'number' && byId.get(7).error.code === -32602, 'B8 非字符串协议版本 ⇒ -32602（不挂死）', JSON.stringify(byId.get(7)).slice(0, 180))
  check(envOf(8).ok === true, 'B9 坏输入之后服务仍然可用')
}

say(`\n--- 参数面：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
