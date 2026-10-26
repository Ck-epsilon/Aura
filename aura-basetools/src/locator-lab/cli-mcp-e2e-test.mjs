/**
 * cli-mcp-e2e-test —— **端到端 + 集成**：把 CLI 与 MCP 当**真进程**驱动，走完整条用户路径。
 *
 * ## 为什么需要它（与既有套件的分工）
 *
 * | 既有套件 | 它驱动的是 | 它测不到的 |
 * |---|---|---|
 * | `*-load-test` | 壳的 `execute()`，mock ctx | 框架的参数校验、真 bin 的启动、进程边界 |
 * | `standalone-test` | 真 bin 进程 | 只看单次调用的回执，不看**两次调用之间**的一致性 |
 * | `range-bytes-test` | 真 bin 进程 | 同上，且侧重字节形态 |
 * | **本套件** | **真 bin 进程 + 真文件 + 多次调用串起来** | —— |
 *
 * 这里问的是既有套件都没问过的问题：**跨进程的那条状态链还在不在**。
 * 具体就是三件（都是一次真实使用里必然发生的）：
 *   1. `read` 给出的令牌能否被后来的 `edit` 用上（观测账本跨进程活着 —— 独立面靠落盘账本）；
 *   2. 令牌**过期**时 `edit` 是否拒绝（而不是静默改错地方）；
 *   3. 读目录、读文件、写文件**交替**发生时不互相踩（这是真实会话的形状）；
 *   4. 两个进程**同时**改同一个文件时不丢更新、不留半截（原子性）。
 *
 * MCP 那一侧走 JSON-RPC over stdio（客户端就是 spawn 一个进程喂 stdin），
 * 与 Codex / Claude Code 接它的方式同形。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..')
const cli = path.join(pkgRoot, 'dist', 'aura-basetools', 'bin', 'aura.mjs')
const mcp = path.join(pkgRoot, 'dist', 'aura-basetools', 'bin', 'aura-mcp.mjs')

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

if (!fs.existsSync(cli) || !fs.existsSync(mcp)) {
  say('')
  say('⚠️  跳过 cli-mcp-e2e：构建产物不存在（先跑 node build/make-bundle.mjs）。')
  say('    这不等于通过——它只说明本机还没构建。')
  say('')
  say('--- 0/0 通过（已跳过）---')
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'))
/** 观测缓存放到测试目录：账本跨进程活着靠的就是它，不能污染 ~/.aura。 */
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }
const runCli = (args, cwd = tmp) => {
  const res = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  let parsed = null
  try {
    parsed = JSON.parse(String(res.stdout).trim().split('\n').pop())
  } catch {
    parsed = null
  }
  return { status: res.status, out: parsed, stderr: String(res.stderr ?? '') }
}
const utf8 = (s) => Buffer.from(s, 'utf8')

say('=== A. 端到端：read 拿令牌 → edit 用它 → 磁盘与回执都对 ===')
{
  const f = path.join(tmp, 'article.md')
  fs.writeFileSync(f, utf8('alpha\nbravo\ncharlie\ndelta\n'))
  const read = runCli(['basetools', 'read', '--file', f, '--mode', 'full'])
  check(read.status === 0 && typeof read.out?.version === 'string', 'A1 read 给出令牌', `${read.status} ${String(read.out?.version ?? read.out?.error ?? '').slice(0, 60)}`)
  const edit = runCli(['basetools', 'edit', '--file', f, '--hunks', JSON.stringify([{ lines: [3, 3], replace: 'CHARLIE' }])])
  check(edit.status === 0 && edit.out?.ok === true, 'A2 用该令牌 edit 成功', JSON.stringify(edit.out?.error ?? edit.out?.result?.applied ?? '').slice(0, 100))
  check(fs.readFileSync(f, 'utf8') === 'alpha\nbravo\nCHARLIE\ndelta\n', 'A3 磁盘内容正确', JSON.stringify(fs.readFileSync(f, 'utf8')))
  check(edit.out?.result?.write_verify?.level === 'bytes', 'A4 回执带字节级回读证据', String(edit.out?.result?.write_verify?.level))
}

say('')
say('=== B. 端到端：令牌过期必须拒绝（不静默改错地方）===')
{
  const f = path.join(tmp, 'stale.md')
  fs.writeFileSync(f, utf8('one\ntwo\nthree\nfour\nfive\n'))
  const read = runCli(['basetools', 'read', '--file', f, '--mode', 'full'])
  check(read.status === 0, 'B1 先 read 建立观测')
  // 第三方在**同一次调用之间**改文件（这正是账本要拦的形状：调用前发生的第三方写入，
  // 对单次调用内部的版本 CAS 来说是"当前状态"，不是冲突）
  fs.writeFileSync(f, utf8('one\ntwo\nTHREE-CHANGED\nfour\nfive\n'))
  const edit = runCli(['basetools', 'edit', '--file', f, '--hunks', JSON.stringify([{ lines: [3, 3], replace: 'MINE' }])])
  check(edit.status === 2 && edit.out?.ok === false, 'B2 被寻址区域被第三方改过 ⇒ 结构化拒绝（exit 2）', `exit=${edit.status} code=${edit.out?.code ?? '—'}`)
  check(String(edit.out?.code ?? '') === 'PATCH_STALE_REGION', 'B3 拒绝码是 PATCH_STALE_REGION', String(edit.out?.code ?? ''))
  check(fs.readFileSync(f, 'utf8') === 'one\ntwo\nTHREE-CHANGED\nfour\nfive\n', 'B4 磁盘保持第三方内容（我们一字未落）', JSON.stringify(fs.readFileSync(f, 'utf8')))
  check(String(edit.out?.error ?? '').includes('re-read'), 'B5 拒绝信息给出下一步（re-read）', String(edit.out?.error ?? '').slice(0, 90))
}

say('')
say('=== C. 集成：同一缓存目录下，两个不同文件互不干扰 ===')
{
  const a = path.join(tmp, 'a.md')
  const b = path.join(tmp, 'b.md')
  fs.writeFileSync(a, utf8('a1\na2\na3\n'))
  fs.writeFileSync(b, utf8('b1\nb2\nb3\n'))
  runCli(['basetools', 'read', '--file', a, '--mode', 'full'])
  runCli(['basetools', 'read', '--file', b, '--mode', 'full'])
  const ea = runCli(['basetools', 'edit', '--file', a, '--hunks', JSON.stringify([{ lines: [2, 2], replace: 'A2' }])])
  const eb = runCli(['basetools', 'edit', '--file', b, '--hunks', JSON.stringify([{ lines: [2, 2], replace: 'B2' }])])
  check(ea.status === 0 && eb.status === 0, 'C1 两个文件都能改（账本按路径分开）')
  check(fs.readFileSync(a, 'utf8') === 'a1\nA2\na3\n' && fs.readFileSync(b, 'utf8') === 'b1\nB2\nb3\n', 'C2 两份文件各自正确', `${JSON.stringify(fs.readFileSync(a, 'utf8'))} ${JSON.stringify(fs.readFileSync(b, 'utf8'))}`)
}

say('')
say('=== D. 集成：并发多进程改同一文件 ⇒ 不丢更新、不留半截 ===')
{
  // 判据不是“全都成功”（那不可能），而是**任何结果下文件都是一份完整内容**：
  // 要么是 A 的整份、要么是 B 的整份，绝不能是两者的混合或截断。
  const f = path.join(tmp, 'race.md')
  const base = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(f, utf8(base))
  runCli(['basetools', 'read', '--file', f, '--mode', 'full'])
  const hunkA = JSON.stringify([{ lines: [5, 5], replace: 'A-WROTE-HERE' }])
  const hunkB = JSON.stringify([{ lines: [6, 6], replace: 'B-WROTE-HERE' }])
  // 同时起两个进程（不 await），随后各自看退出码
  const { spawn } = await import('node:child_process')
  const launch = (hunks) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, 'basetools', 'edit', '--file', f, '--hunks', hunks], { cwd: tmp, env })
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += d))
      child.on('close', (code) => resolve({ code, stdout }))
    })
  const [ra, rb] = await Promise.all([launch(hunkA), launch(hunkB)])
  const final = fs.readFileSync(f, 'utf8')
  const lines = final.split('\n')
  check(lines.length === 201, `D1 文件仍是 200 行 + 尾换行（实测 ${lines.length - 1} 行）`, `${lines.length}`)
  const hasA = final.includes('A-WROTE-HERE')
  const hasB = final.includes('B-WROTE-HERE')
  check(hasA || hasB, 'D2 至少一个写者的改动落盘（不是两个都丢）', `A=${hasA} B=${hasB}`)
  // 不许出现“A 的改动 + B 的改动”这种两个都进去的情形吗？**允许**——它们改的是不同行，
  // 且各自都通过了闸门。真正要禁的是“半截”：行数不符、或某一行的内容被截断。
  const truncated = lines.some((l, i) => i < 200 && l !== `line ${i + 1}` && !l.endsWith('WROTE-HERE'))
  check(!truncated, 'D3 没有任何一行是半截或混合的', lines.filter((l, i) => i < 200 && l !== `line ${i + 1}` && !l.endsWith('WROTE-HERE')).slice(0, 3).join(' | '))
  const shown = [ra.code, rb.code].join('/')
  check(ra.code === 0 || rb.code === 0, `D4 两个进程至少一个成功（退出码 ${shown}）`, shown)
}

say('')
say('=== E. MCP：JSON-RPC over stdio 的整条往返 ===')
{
  const mcpFile = path.join(tmp, 'mcp-target.mjs')
  fs.writeFileSync(mcpFile, 'export function alpha() {\n  return 1\n}\n')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: { file_path: mcpFile, mode: 'full' } } },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'aura_basetools_edit', arguments: { file_path: mcpFile, hunks: [{ lines: [2, 2], replace: '  return 42' }] } },
    },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: { file_path: mcpFile, mode: 'lines', lines: [2, 2] } } },
  ]
  const res = spawnSync(process.execPath, [mcp], { input: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  const replies = String(res.stdout)
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter((r) => r !== null)
  const byId = new Map(replies.map((r) => [r.id, r]))
  check(byId.get(1)?.result?.serverInfo?.name === 'aura-basetools', 'E1 initialize 握手带回 serverInfo', JSON.stringify(byId.get(1)?.result?.serverInfo ?? null))
  const tools = byId.get(2)?.result?.tools?.map((t) => t.name) ?? []
  check(
    ['aura_basetools_read', 'aura_basetools_edit', 'aura_basetools_write', 'aura_basetools_convert', 'aura_basetools_tx'].every((name) =>
      tools.includes(name),
    ),
    'E2 tools/list 列出读/改/整写/转换/事务五个工具',
    tools.join(','),
  )
  const readText = byId.get(3)?.result?.content?.[0]?.text ?? ''
  check(typeof byId.get(3)?.result?.structuredContent?.version === 'string' || /version/.test(readText), 'E3 读回的令牌在回包里', readText.slice(0, 60))
  const editRes = byId.get(4)?.result
  check(editRes?.structuredContent?.ok === true || /applied|hunk/.test(JSON.stringify(editRes ?? {})), 'E4 编辑回执正常', JSON.stringify(editRes ?? {}).slice(0, 90))
  check(fs.readFileSync(mcpFile, 'utf8').includes('return 42'), 'E5 磁盘真的改了（MCP 面逐字节落盘）', JSON.stringify(fs.readFileSync(mcpFile, 'utf8')))
  check(String(res.stderr).trim() === '', 'E6 全程没有走 stderr 兜底', String(res.stderr).trim().slice(0, 80))
}

say('')
say('=== F. MCP：坏参数必须回包而不是挂死客户端 ===')
{
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    // 不给 file_path：契约要求回一个结构化错误包，而不是抛异常（抛了客户端会一直等）
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: {} } },
  ]
  const res = spawnSync(process.execPath, [mcp], { input: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`, encoding: 'utf8', env, timeout: 20000 })
  const lines = String(res.stdout).trim().split('\n').filter(Boolean)
  const last = (() => {
    try {
      return JSON.parse(lines[lines.length - 1])
    } catch {
      return null
    }
  })()
  check(last?.id === 2, 'F1 缺 file_path 时仍然回包（客户端不会挂死）', JSON.stringify(last ?? null).slice(0, 100))
  check(/file_path/.test(JSON.stringify(last ?? {})), 'F2 回包点名缺的是 file_path')
}

fs.rmSync(tmp, { recursive: true, force: true })
say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
