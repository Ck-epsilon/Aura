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
import { MT_READ_ELEMENT_KEYS, MT_EDIT_ELEMENT_KEYS } from '../../locator-lab/args.mjs'

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

// ── C 声明=送达（一条机制，不是一个个用例） ──────────────────────────────
/**
 * 判据只有一个方向：**工具对外声明/承诺过的键，必须在这条路上真的被引擎收到**。
 *
 * 为什么要这一节：1.0.2 的三个事故同形——`instructions` 与 `docs/agent-guide.md` 推荐平铺形状、
 * `capabilities` 点名 views、schema 却一个键都没声明；于是**每一层各自都对**，接起来是坏的，
 * 而既有套件全绿（它只验"名单里有的键能收"，不验"声明的键会送达"）。这里把两端都夹住：
 *   C0 名单从**线上 tools/list** 现取，并硬要求真的取到（取不到时下面几条会空转成假绿）；
 *   C1 承诺 ⊆ 声明：`SERVER_INSTRUCTIONS` / docs 点名的键，必须在工具的声明里。这份表是**手抄的**，
 *      抄的是对外承诺而非实现，所以只有一条"往里加"的规则：任何一次把某个键写进给模型看的文案，
 *      都要在这里补一行——否则 C1 会红；
 *   C2 声明 ⊆ 送达：每个声明键各发一次 dry_run，回执不得是 `ARGS_UNKNOWN_KEY`
 *      ——声明了却拒收，正是"参数面收下一个形状、运行期走不到"；
 *   C3 平铺形状必须**摊成 hunk**：只给顶层地址键时，判决必须是行号断言那一条（缺 expect 才拒），
 *      而不是"需要 hunks 数组"——后者说明键进来了但没人拼装；
 *   C4 元素名单与顶层名单**同一类判决**：`targets` 元素里每个合法键都不许停在 `ARGS_UNKNOWN_KEY`
 *      ——名单是两份，漂开一次就是"顶层能执行、元素里被拒"，换个位置重演 1.0.2。
 */
say('C 声明=送达：tools/list 的每个键都要走到判决，不是走到名单')
{
  const pathC = put('c.txt', 'alpha\n')
  const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  const hello = () => [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]
  /** 一帧一发、按 id 收：整节只 spawn 一次服务（每键一发，进程成本与键数无关）。 */
  const rpc = (frames) => {
    const res = spawnSync(process.execPath, [mcpBin], { input: `${[...frames].map((f) => JSON.stringify(f)).join('\n')}\n`, encoding: 'utf8', env })
    const lines = String(res.stdout).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return new Map(lines.map((r) => [r.id, r]))
  }
  const envOf = (reply) => {
    const text = reply?.result?.content?.[0]?.text ?? '{}'
    try { return { raw: text, ...(JSON.parse(text) ?? {}) } } catch { return { raw: text } }
  }

  // C0 名单现取：测试不抄第二份声明——抄了就有两份真值，而本仓反复出现的正是这类漂移
  const listed = rpc([...hello(), { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }]).get(2)?.result?.tools ?? []
  const propsOf = new Map(listed.map((t) => [t.name, t.inputSchema?.properties ?? {}]))
  check(propsOf.size >= 2, 'C0 tools/list 拿到 schema（拿不到时下面几条不许空转）', JSON.stringify([...propsOf.keys()]))

  /**
   * 值按**声明自己的类型**造。测试不猜"这个键该填什么业务值"：猜出来的只能验测试自己的想象，
   * 而这一节要验的只有一件事——这个键有没有被运行期**认出来**。
   * 所以每个取样都保证落到某个真实判决（`PATCH_NO_ADDRESS` / `PATCH_LINES_NEED_EXPECT` / 缺参…），
   * 唯独不该落到 `ARGS_UNKNOWN_KEY`。
   */
  const sample = (key, spec) => {
    if (key === 'file_path') return pathC
    if (Array.isArray(spec?.enum)) return spec.enum[0]
    switch (spec?.type) {
      // `targets` 的元素只带 `file_path`：元素键名单由 B2 单独验，这里塞满可选键会把两件事搅在一起
      case 'array': return key === 'targets' ? [{ file_path: pathC }] : [{ lines: [1, 1], replace: 'beta', expect: 'alpha' }]
      case 'object': return key === 'evidence' ? { spanHash: 'deadbeef', contentHash: 'deadbeef', version: 'deadbeef:1' } : { file_path: pathC }
      case 'integer': return 1
      case 'boolean': return true
      default: return 'x'
    }
  }

  const probes = []
  const idFor = new Map()
  let next = 200
  for (const [tool, props] of propsOf) {
    const base = { file_path: pathC }
    if (props.dry_run !== undefined) base.dry_run = true
    for (const key of Object.keys(props)) {
      idFor.set(`${tool}:${key}`, next)
      probes.push(call(next++, tool, { ...base, [key]: sample(key, props[key]) }))
    }
  }
  check(probes.length >= 20, `C0 探到 ${probes.length} 个声明键（少于 20 说明 schema 没读全）`, String(probes.length))
  const probed = rpc([...hello(), ...probes])

  // C1：对外承诺的键 ⊆ 线上声明的键（承诺表手抄，规则只有一条：往模型看的文案里加键就加一行）
  const promiseTable = {
    aura_basetools_apply: [
      'op', 'file_path', 'entity', 'change', 'new_name', 'scope', 'evidence', 'expect', 'hunks', 'targets',
      'create', 'require_observation', 'retry', 'content', 'no_overwrite', 'allow_unobserved', 'eol',
      'to', 'from', 'bom', 'repair_double_encoding', 'action', 'transaction', 'verify', 'dry_run',
      // instructions §"pass the hunk FLAT" 点名的平铺键（1.0.2 缺的就是这一批）
      'target', 'lines', 'start_line', 'end_line', 'line_cue', 'anchor', 'old', 'context',
      'handle', 'structure', 'line', 'position', 'near', 'replace', 'replace_all', 'encoding',
    ],
    // 只列 instructions **原文点名**的读侧键：承诺表抄的是文案，不是实现，多抄一个就是替项目说话
    aura_basetools_read: ['file_path', 'mode', 'entity', 'search', 'lines', 'targets'],
  }
  for (const [tool, keys] of Object.entries(promiseTable)) {
    const have = propsOf.get(tool)
    const declaredSet = have === undefined ? undefined : new Set(Object.keys(have))
    const missing = declaredSet === undefined ? ['(schema 没取到)'] : keys.filter((key) => !declaredSet.has(key))
    check(missing.length === 0, `C1 ${tool}：对外承诺的键都在声明里`, JSON.stringify(missing))
  }

  // C2：声明的每个键都走到判决，不能停在"未知参数"
  {
    const dead = []
    for (const [tool, props] of propsOf) {
      for (const key of Object.keys(props)) {
        const reply = probed.get(idFor.get(`${tool}:${key}`))
        if (reply === undefined) { dead.push(`${key}(无回包)`); continue }
        if (envOf(reply).code === 'ARGS_UNKNOWN_KEY') dead.push(key)
      }
    }
    check(dead.length === 0, 'C2 声明的键没有一个停在 ARGS_UNKNOWN_KEY', JSON.stringify(dead))
  }

  // C3：平铺形状必须被**摊成 hunk**——判决要落在行号断言上，而不是"缺 hunks 数组"
  {
    const flat = spawnFlat({ start_line: 1, end_line: 1, replace: 'beta' })
    check(flat.code !== 'ARGS_UNKNOWN_KEY' && /PATCH_LINES_NEED_EXPECT/.test(flat.raw), 'C3 平铺地址走到了行号断言闸（不是"需要 hunks"）', flat.raw.slice(0, 160))
    const flatExpect = spawnFlat({ start_line: 1, end_line: 1, replace: 'beta', expect: 'alpha' })
    check(flatExpect.ok === true || flatExpect.code === 'PATCH_UNSEEN_REGION', 'C3 顶层 expect 摊进了那条 hunk（闸门认它作断言）', flatExpect.raw.slice(0, 160))
  }
  function spawnFlat(extra) {
    const reply = rpc([...hello(), call(900, 'aura_basetools_apply', { file_path: pathC, ...extra })]).get(900)
    const e = envOf(reply)
    return { raw: e.raw, ok: e.ok === true, code: e.code ?? null }
  }

  /**
   * C4 同一个键，写在顶层与写在 `targets` 元素里必须得到**同一类**判决。
   *
   * 为什么单列一条：C2 只夹住了顶层声明，而元素名单是另一份名单——两份名单漂开时的形状
   * 正是 1.0.2 的形状（顶层能执行、元素里被 `ARGS_UNKNOWN_KEY` 拒掉），只是这次换了位置。
   * 名单从引擎的导出名现取（`MT_*_ELEMENT_KEYS`），不在测试里再抄一遍。
   */
  {
    const valueOf = (key) => {
      if (key === 'file_path') return pathC
      if (key === 'hunks') return [{ lines: [1, 1], replace: 'beta', expect: 'alpha' }]
      if (key === 'create') return 'beta\n'
      if (key === 'lines') return [1, 1]
      if (key === 'start_line' || key === 'end_line' || key === 'line' || key === 'offset') return 1
      if (key === 'limit' || key === 'budget' || key === 'max_chars' || key === 'around' || key === 'context') return 2
      if (key === 'dry_run' || key === 'require_observation' || key === 'replace_all') return true
      if (key === 'position') return 'after'
      if (key === 'handle') return 'h0000000000:1-1'
      if (key === 'structure') return 'function:alpha'
      return 'x'
    }
    const elementProbes = []
    const elementId = new Map()
    let id = 400
    for (const [tool, keys] of [['aura_basetools_read', MT_READ_ELEMENT_KEYS], ['aura_basetools_apply', MT_EDIT_ELEMENT_KEYS]]) {
      for (const key of keys) {
        if (key === 'file_path') continue
        elementId.set(`${tool}:${key}`, id)
        const args = { targets: [{ file_path: pathC, [key]: valueOf(key) }] }
        if (tool === 'aura_basetools_apply') args.dry_run = true
        elementProbes.push(call(id++, tool, args))
      }
    }
    const probedElements = rpc([...hello(), ...elementProbes])
    const deadElements = []
    for (const [tool, keys] of [['aura_basetools_read', MT_READ_ELEMENT_KEYS], ['aura_basetools_apply', MT_EDIT_ELEMENT_KEYS]]) {
      for (const key of keys) {
        if (key === 'file_path') continue
        const reply = probedElements.get(elementId.get(`${tool}:${key}`))
        if (reply === undefined) { deadElements.push(`${tool}:${key}(无回包)`); continue }
        if (envOf(reply).code === 'ARGS_UNKNOWN_KEY') deadElements.push(`${tool}:${key}`)
      }
    }
    check(deadElements.length === 0, `C4 元素名单（${elementProbes.length} 键）没有一个停在 ARGS_UNKNOWN_KEY`, JSON.stringify(deadElements))
  }
}

say(`\n--- 参数面：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
