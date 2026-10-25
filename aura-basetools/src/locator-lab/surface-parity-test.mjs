/**
 * surface-parity-test —— **同一个工具在不同 agent 入口上是不是同一张形状**。
 *
 * 为什么需要它：aura 有三条入口（MCP / DSH 壳 / CLI），而 MCP 一面被 Codex / Claude Code /
 * Cursor / ZCode 共用。同一个载荷在 A 面能用、在 B 面被拒，比"某个面少个功能"更糟——模型按
 * 文档写一次，换个 agent 就失败，而失败信息还指向参数名。
 *
 * 实测过一次真实漂移（本套件的由来）：`{file_path, start_line, end_line, replace}` 这种
 * **平铺单 hunk**，DSH 壳声明并在执行，MCP 面却在未知参数守卫那里被拒——因为 MCP 的 schema
 * 只声明了 `hunks`。同一个模型、同一份载荷，换个客户端就死。
 *
 * 判据（不是"大体一致"，是逐面点名的集合差）：
 *   1. 工具名：DSH 侧注册的 read/edit/write 必须都能在 MCP 面找到同名工具；
 *   2. 顶层参数键：两面集合差必须**恰好等于**文档化的不对称清单（`MCP_ONLY`），其余任何差都红；
 *   3. hunk 字段：`hunks.items.properties` 两面必须完全相等（平铺形状靠它）；
 *   4. 平铺键：DSH 顶层声明的每个 hunk 键，MCP 顶层也必须声明。
 *
 * 文档化的不对称（不是 bug，是尚未实现）：
 *   · `verify` / `transaction`：MCP 与 CLI 已实现写后验证与跨调用事务；DSH 壳还没有。
 *   这两项留在清单里，是为了"加了没同步"与"本来就没有"能分开——清单外的差异一律红。
 *
 * 运行：node src/locator-lab/surface-parity-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { contextServices } from './mock-ctx.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}

/** 用最小 mock ctx 把 DSH 插件注册一遍，拿到编译后的 parameters。 */
async function dshTools(relative) {
  const plugin = await import(pathToFileURL(path.join(root, relative)).href)
  const registered = []
  const ctx = {
    ...contextServices(),
    tools: { register: (tool) => registered.push(tool) },
    systemPrompt: { section: () => () => {} },
    emit() {},
    waterfall() {
      throw Object.assign(new Error('parity: no waterfall in this harness'), { code: 'FS_NOT_OBSERVED' })
    },
  }
  plugin.apply(ctx)
  return registered
}

/** MCP 面：真实进程 + tools/list（与客户端拿到的是同一份）。 */
function mcpTools() {
  const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const res = spawnSync(process.execPath, [bin], { input: `${init}\n${list}\n`, encoding: 'utf8', timeout: 30000 })
  const lines = String(res.stdout ?? '').split('\n').filter((line) => line.trim().length > 0)
  for (const line of lines) {
    try {
      const msg = JSON.parse(line)
      if (msg?.id === 2) return msg.result.tools
    } catch {
      /* 非 JSON 行 */
    }
  }
  return []
}

/** 文档化的不对称：MCP 有、DSH 还没有（不是漂移）。 */
const MCP_ONLY = {
  // `encoding`：MCP/CLI 可按调用指定源编码；DSH 宿主只递 UTF-8 文本，这一层无意义。
  aura_basetools_edit: ['encoding', 'transaction', 'verify'],
  aura_basetools_write: ['encoding', 'transaction', 'verify'],
  aura_basetools_read: ['encoding'],
}

const dsh = [...(await dshTools('src/aura-read/index.js')), ...(await dshTools('src/aura-edit/index.js'))]
const dshByName = Object.fromEntries(dsh.map((tool) => [tool.name, tool]))
const mcp = mcpTools()
const mcpByName = Object.fromEntries(mcp.map((tool) => [tool.name, tool]))

console.log('=== 1. 工具名（DSH 有的，MCP 必须有） ===')
const dshNames = Object.keys(dshByName).sort()
check(dshNames.length >= 3, `DSH 注册了 ${dshNames.length} 个工具：${dshNames.join(', ')}`)
for (const name of dshNames) {
  check(mcpByName[name] !== undefined, `${name} 在 MCP 面存在`)
}
check(mcpByName.aura_basetools_tx !== undefined && dshByName.aura_basetools_tx === undefined, 'tx 只在 MCP/CLI 面（文档化不对称）')

console.log('\n=== 2. 顶层参数键（差异必须只有文档化清单） ===')
for (const name of dshNames) {
  if (mcpByName[name] === undefined) continue
  const mcpKeys = Object.keys(mcpByName[name].inputSchema?.properties ?? {}).sort()
  const dshKeys = Object.keys(dshByName[name].parameters?.properties ?? {}).sort()
  const onlyDsh = dshKeys.filter((key) => !mcpKeys.includes(key))
  const onlyMcp = mcpKeys.filter((key) => !dshKeys.includes(key))
  const expectedMcpOnly = (MCP_ONLY[name] ?? []).filter((key) => onlyMcp.includes(key)).sort()
  const unexpectedMcpOnly = onlyMcp.filter((key) => !(MCP_ONLY[name] ?? []).includes(key))
  check(onlyDsh.length === 0, `${name}：DSH 声明的键 MCP 都有`, onlyDsh.length > 0 ? `MCP 缺：${onlyDsh.join(', ')}` : '')
  check(unexpectedMcpOnly.length === 0, `${name}：MCP 多出的键都在文档化清单里`, unexpectedMcpOnly.length > 0 ? `未登记：${unexpectedMcpOnly.join(', ')}（MCP-only 已登记：${expectedMcpOnly.join(', ') || '无'}）` : '')
}

console.log('\n=== 3. hunk 字段（数组形与平铺形共用同一张表） ===')
{
  const a = Object.keys(mcpByName.aura_basetools_edit?.inputSchema?.properties?.hunks?.items?.properties ?? {}).sort()
  const b = Object.keys(dshByName.aura_basetools_edit?.parameters?.properties?.hunks?.items?.properties ?? {}).sort()
  check(a.length > 0 && JSON.stringify(a) === JSON.stringify(b), `hunk 字段两面相等（${a.length} 个）`, `mcp=${a.join(',')} | dsh=${b.join(',')}`)
}

console.log('\n=== 4. 平铺键：DSH 顶层的每个 hunk 键，MCP 顶层也有 ===')
{
  const hunkKeys = Object.keys(dshByName.aura_basetools_edit?.parameters?.properties?.hunks?.items?.properties ?? {})
  const mcpTop = new Set(Object.keys(mcpByName.aura_basetools_edit?.inputSchema?.properties ?? {}))
  const missing = hunkKeys.filter((key) => !mcpTop.has(key))
  check(missing.length === 0, `MCP 顶层声明了全部 ${hunkKeys.length} 个平铺键`, missing.length > 0 ? `缺：${missing.join(', ')}` : '')
}

/**
 * 形状签名：只比较**契约面**（type / union / enum / items），不比描述与 additionalProperties。
 *
 * `anyOf` 与 `oneOf` 归一到同一个 `union`：两面用不同的关键字表达**同一个**类型并集
 * （MCP 为了 provider strict 用 anyOf，DSH 的校验器认 oneOf），这不是漂移。
 */
const shapeOf = (node, withEnum = true) => {
  if (node === null || node === undefined) return 'null'
  if (typeof node !== 'object') return JSON.stringify(node)
  const parts = []
  const type = Array.isArray(node.type) ? [...node.type].sort().join('|') : node.type
  if (type !== undefined) parts.push(`type:${type}`)
  const union = node.anyOf ?? node.oneOf
  if (Array.isArray(union)) parts.push(`union:${union.map((child) => shapeOf(child, withEnum)).sort().join(',')}`)
  if (withEnum && Array.isArray(node.enum)) parts.push(`enum:${node.enum.map(String).sort().join('|')}`)
  if (node.items !== undefined) parts.push(`items:${shapeOf(node.items, withEnum)}`)
  return parts.join(';')
}

console.log('\n=== 5. 字段类型（同名同型，差一个就红） ===')
{
  const diffs = []
  for (const name of dshNames) {
    if (mcpByName[name] === undefined) continue
    const mcpProps = mcpByName[name].inputSchema?.properties ?? {}
    const dshProps = dshByName[name].parameters?.properties ?? {}
    for (const key of Object.keys(mcpProps)) {
      if (!(key in dshProps)) continue
      const a = shapeOf(mcpProps[key], false)
      const b = shapeOf(dshProps[key], false)
      if (a !== b) diffs.push(`${name}.${key}: mcp=${a} | dsh=${b}`)
      // 枚举：**两侧都声明时**才比较。只在一侧声明是已记录的刻意不对称（见 aura-read
      // 的 `mode` 注释：DSH 的框架会在参数层先拒，报的不是引擎的 READ_BAD_MODE）。
      const enumA = Array.isArray(mcpProps[key]?.enum) ? mcpProps[key].enum.map(String).sort().join('|') : null
      const enumB = Array.isArray(dshProps[key]?.enum) ? dshProps[key].enum.map(String).sort().join('|') : null
      if (enumA !== null && enumB !== null && enumA !== enumB) diffs.push(`${name}.${key} enum: mcp=${enumA} | dsh=${enumB}`)
    }
  }
  check(diffs.length === 0, '两面同名参数的形状签名一致', diffs.slice(0, 3).join('  //  '))
}

console.log('\n=== 6. MCP 的 mode 枚举必须等于引擎的 MODES + auto ===')
{
  const { MODES } = await import('./read-core.mjs')
  const mcpMode = mcpByName.aura_basetools_read?.inputSchema?.properties?.mode?.enum
  const expected = ['auto', ...MODES]
  check(Array.isArray(mcpMode) && JSON.stringify(mcpMode) === JSON.stringify(expected), `mode enum = auto + ${MODES.length} 个引擎模式`, JSON.stringify(mcpMode))
}

console.log('\n=== 7. 平铺形状在 MCP 面真的能执行（不只是声明） ===')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-parity-'))
  const file = path.join(tmp, 'flat.txt')
  fs.writeFileSync(file, 'alpha\nbravo\ncharlie\n')
  const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const call = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'aura_basetools_edit', arguments: { file_path: file, start_line: 2, end_line: 2, replace: 'BRAVO', expect: 'bravo' } },
  })
  const res = spawnSync(process.execPath, [bin], { input: `${init}\n${call}\n`, encoding: 'utf8', timeout: 30000 })
  let envelope = null
  for (const line of String(res.stdout ?? '').split('\n')) {
    try {
      const msg = JSON.parse(line)
      if (msg?.id === 2) envelope = JSON.parse(msg.result?.content?.[0]?.text ?? 'null')
    } catch {
      /* 非 JSON 行 */
    }
  }
  check(envelope?.ok === true, 'MCP 平铺 edit 回 ok=true', JSON.stringify(envelope).slice(0, 160))
  check(fs.readFileSync(file, 'utf8') === 'alpha\nBRAVO\ncharlie\n', '磁盘内容正确（平铺真的落了盘）', JSON.stringify(fs.readFileSync(file, 'utf8')))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n--- ${pass} 通过 / ${fail} 失败 ---`)
process.exit(fail === 0 ? 0 : 1)
