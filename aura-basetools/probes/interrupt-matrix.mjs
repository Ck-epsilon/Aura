/**
 * interrupt-matrix —— 哪些故障会让**调用方**中断，哪些只会拿到结构化回执。
 *
 * 背景：同一套引擎有三个入口（CLI / MCP / DSH）。引擎的拒绝对调用方是否"致命"，取决于入口把它
 * 投递成什么：结构化回包（agent 可以继续）还是进程崩溃 / 挂死 / 非 JSON 文本（agent 只能终止）。
 * 这个探针不测正确性，只测**故障时的投递形态**——因为"任务中断"是投递问题，不是功能问题。
 *
 * 七条现场：
 *   1. non-utf8-read   非 UTF-8 文件被当文本读
 *   2. missing-read    文件不存在
 *   3. dir-read        路径是目录
 *   4. huge-read       2 MB 文件（回执必须有界）
 *   5. bad-hunk        hunk 形状写错（`hunks: "nope"`）
 *   6. unknown-arg     未知参数（拼写错）
 *   7. lock-held       工作区锁被活进程持有（必须超时返回，不能挂死）
 *
 * 判定：
 *   envelope       回包是可解析 JSON 且带 `ok`/`error`/`code` —— agent 能继续
 *   protocol-error MCP 层 error 对象（多数客户端按工具失败处理，仍可继续）
 *   raw            回包不是 JSON —— agent 只能当文本猜
 *   crash          进程非零退出且没有回包
 *   hang           超时未返回
 *
 * 注意：`MALFORMED_RESPONSE`（模型输出的 tool 参数 JSON 坏了）**不在本探针范围**——它发生在
 * 工具被调用之前，工具收不到任何字节。见 docs/待办.md 的 T30 记录。
 *
 * 运行：node probes/interrupt-matrix.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { workspaceKey } from '../src/aura-standalone/lib/workspace-lock.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..')
const cliBin = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const mcpBin = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-interrupt-'))
const cache = path.join(tmp, 'cache')
const baseEnv = { ...process.env, AURA_CACHE_DIR: cache }
const TIMEOUT_MS = 8000

const say = (m) => process.stdout.write(`${m}\n`)
const put = (name, content) => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, content)
  return file
}
const lastJson = (stdout) => {
  const text = String(stdout ?? '').trim()
  if (text.length === 0) return null
  // `--pretty` 的回执是多行 JSON：先整段解析；整段失败再逐行从末尾找（前面可能有日志）。
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    /* 多段输出，继续逐行 */
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      /* 继续往前找 */
    }
  }
  return null
}

/** 启一个 MCP 子进程，喂 initialize + 一条 tools/call，收所有 JSON 行。 */
function callMcp(name, args, env = baseEnv) {
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'interrupt-matrix', version: '0' } } })
  const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
  const res = spawnSync(process.execPath, [mcpBin], { cwd: tmp, env, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, input: `${init}\n${call}\n` })
  const responses = []
  for (const line of String(res.stdout ?? '').split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    try {
      responses.push(JSON.parse(text))
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  const reply = responses.find((msg) => msg && msg.id === 2)
  let envelope = null
  if (reply?.result?.content?.[0]?.text) {
    try {
      envelope = JSON.parse(reply.result.content[0].text)
    } catch {
      envelope = null
    }
  }
  return { status: res.status, signal: res.signal, envelope, protocolError: reply?.error ?? null, raw: String(res.stdout ?? '').slice(0, 160) }
}

function callCli(args, env = baseEnv) {
  const res = spawnSync(process.execPath, [cliBin, ...args], { cwd: tmp, env, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
  return { status: res.status, signal: res.signal, envelope: lastJson(res.stdout), raw: String(res.stdout ?? '').slice(0, 160) }
}

const classify = (r) => {
  if (r.signal === 'SIGTERM' || r.status === null) return 'hang'
  if (r.envelope !== null && r.envelope !== undefined) return 'envelope'
  if (r.protocolError) return 'protocol-error'
  if (String(r.raw ?? '').trim().length === 0) return 'crash'
  return 'raw'
}

const codeOf = (r) => r.envelope?.code ?? (r.protocolError ? `rpc:${r.protocolError.code}` : '—')

/**
 * 多 agent 契约：同一个故障在不同入口**可以有不同的 code**（CLI 用 `USAGE`、MCP 用 `BAD_ARGS`），
 * 但必须落在同一个**语义类**。入口之间的 class 不一致 = 调用方按 code 分支时会走出不同行为，
 * 这正是“同一句拒绝在两个 agent 里分量不同”的根源。
 */
const SEMANTIC = [
  [/^(USAGE|BAD_ARGS|INVALID_ARGS|ARGS_|WRITE_BAD_ARGS)/, 'bad-args'],
  [/^(FS_NOT_TEXT|ENCODING)/, 'not-text'],
  [/^(FS_NOT_FOUND|NOT_FOUND|PATCH_NOT_FOUND)/, 'not-found'],
  [/^WORKSPACE_LOCKED/, 'locked'],
]
const classOf = (code) => {
  if (code === '—') return 'ok'
  const hit = SEMANTIC.find(([re]) => re.test(String(code)))
  return hit ? hit[1] : 'other'
}
const rows = []
const record = (surface, scenario, r, started) => {
  const kind = classify(r)
  rows.push({ surface, scenario, kind, ms: Date.now() - started, code: codeOf(r), detail: kind === 'envelope' ? '' : String(r.raw ?? '').replace(/\s+/g, ' ').slice(0, 80) })
  return kind
}

// ── 夹具 ──────────────────────────────────────────────────────────────────────
const textFile = put('plain.txt', 'alpha\nbravo\ncharlie\n')
const nonUtf8 = path.join(tmp, 'binary.dat')
fs.writeFileSync(nonUtf8, Buffer.from([0x00, 0x41, 0xff, 0xfe, 0x80, 0x81, 0x42, 0x00]))
const huge = path.join(tmp, 'huge.txt')
fs.writeFileSync(huge, 'x'.repeat(2 * 1024 * 1024))
const missing = path.join(tmp, 'no-such-file.txt')
const dir = path.join(tmp, 'a-directory')
fs.mkdirSync(dir, { recursive: true })

// 锁：一个"活进程"（本探针自己）持有工作区锁
function armLock() {
  fs.mkdirSync(path.join(cache, 'locks'), { recursive: true })
  const key = workspaceKey(tmp)
  fs.writeFileSync(path.join(cache, 'locks', `${key}.lock`), JSON.stringify({ pid: process.pid, createdAt: Date.now(), root: tmp }))
  return path.join(cache, 'locks', `${key}.lock`)
}
function disarmLock(file) {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* 已经没了 */
  }
}

const scenarios = [
  {
    name: 'non-utf8-read',
    cli: () => ['basetools', 'read', '--file', nonUtf8, '--mode', 'full', '--pretty'],
    mcp: () => ['aura_basetools_read', { file_path: nonUtf8, mode: 'full' }],
  },
  {
    name: 'missing-read',
    cli: () => ['basetools', 'read', '--file', missing, '--mode', 'full', '--pretty'],
    mcp: () => ['aura_basetools_read', { file_path: missing, mode: 'full' }],
  },
  {
    name: 'dir-read',
    cli: () => ['basetools', 'read', '--file', dir, '--mode', 'full', '--pretty'],
    mcp: () => ['aura_basetools_read', { file_path: dir, mode: 'full' }],
  },
  {
    name: 'huge-read',
    cli: () => ['basetools', 'read', '--file', huge, '--mode', 'full', '--pretty'],
    mcp: () => ['aura_basetools_read', { file_path: huge, mode: 'full' }],
    after: (r) => {
      const size = JSON.stringify(r.envelope ?? '').length
      return { ok: size < 40000, note: `回执 ${size} 字符` }
    },
  },
  {
    name: 'bad-hunk',
    cli: () => ['basetools', 'edit', '--file', textFile, '--hunks', '"nope"', '--pretty'],
    mcp: () => ['aura_basetools_edit', { file_path: textFile, hunks: 'nope' }],
  },
  {
    name: 'unknown-arg',
    cli: () => ['basetools', 'read', '--file', textFile, '--mode', 'full', '--linez', '1,2', '--pretty'],
    mcp: () => ['aura_basetools_read', { file_path: textFile, mode: 'full', linez: '1,2' }],
  },
]

say('=== 故障投递矩阵（CLI / MCP 两个入口）===')
for (const scenario of scenarios) {
  const t0 = Date.now()
  record('cli', scenario.name, callCli(scenario.cli()), t0)
  const t1 = Date.now()
  const [tool, args] = scenario.mcp()
  record('mcp', scenario.name, callMcp(tool, args), t1)
}

// 锁：单独跑，因为要临时装锁
{
  const lockFile = armLock()
  const t0 = Date.now()
  record('cli', 'lock-held', callCli(['basetools', 'edit', '--file', textFile, '--hunks', JSON.stringify([{ lines: [1, 1], replace: 'ALPHA' }]), '--pretty'], { ...baseEnv, AURA_LOCK_TIMEOUT_MS: '1200' }), t0)
  const t1 = Date.now()
  record('mcp', 'lock-held', callMcp('aura_basetools_edit', { file_path: textFile, hunks: [{ lines: [1, 1], replace: 'ALPHA' }] }, { ...baseEnv, AURA_LOCK_TIMEOUT_MS: '1200' }), t1)
  disarmLock(lockFile)
}

say('')
say('surface  scenario          class           ms      code')
for (const row of rows) {
  say(`${row.surface.padEnd(8)} ${row.scenario.padEnd(17)} ${row.kind.padEnd(15)} ${String(row.ms).padStart(5)}   ${row.code}${row.detail ? `   ${row.detail}` : ''}`)
}

say('')
say('=== 同一故障的语义类（CLI vs MCP）===')
const byScenario = new Map()
for (const row of rows) {
  const entry = byScenario.get(row.scenario) ?? {}
  entry[row.surface] = { kind: row.kind, klass: classOf(row.code), code: row.code }
  byScenario.set(row.scenario, entry)
}
const mismatched = []
for (const [scenario, pair] of byScenario) {
  const cli = pair.cli ?? {}
  const mcp = pair.mcp ?? {}
  const same = cli.klass === mcp.klass
  if (!same) mismatched.push({ scenario, cli, mcp })
  say(`  ${same ? '✓' : '✗'} ${scenario.padEnd(17)} cli=${String(cli.klass).padEnd(9)}(${cli.code})  mcp=${String(mcp.klass).padEnd(9)}(${mcp.code})`)
}

const fatal = rows.filter((row) => row.kind === 'hang' || row.kind === 'crash' || row.kind === 'raw')
say('')
say(`致命投递（hang / crash / raw）：${fatal.length}`)
for (const row of fatal) say(`  ✗ ${row.surface} / ${row.scenario} → ${row.kind}`)
say(`跨入口语义类不一致：${mismatched.length}`)
for (const row of mismatched) say(`  ✗ ${row.scenario}：cli=${row.cli.klass}(${row.cli.code}) vs mcp=${row.mcp.klass}(${row.mcp.code})`)

say('')
say('P1（模型输出的 tool 参数 JSON 坏了）不在此表：它发生在工具被调用之前，工具收不到字节；')
say('   唯一的根治是 provider 侧 strict 约束，或宿主侧解析失败重试。')

// 闸门可读的摘要行：必须是**最后一行**（release-check 取最后一行含“通过/失败”的文本当摘要）。
const pass = rows.length + byScenario.size - fatal.length - mismatched.length
const total = rows.length + byScenario.size
say('')
say(`--- ${pass}/${total} 通过（致命投递 ${fatal.length}，跨入口语义不一致 ${mismatched.length}）---`)

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fatal.length === 0 && mismatched.length === 0 ? 0 : 1)
