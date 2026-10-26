/**
 * schema-portability-test —— 工具 schema 的**可移植子集**判据（多 agent 共用一面）。
 *
 * 为什么需要它：MCP 这一面被 Codex / Claude Code / Cursor / ZCode / Hermes 共用，而各家对 JSON Schema
 * 的支持不是全集——最要命的是 `oneOf`：DeepSeek strict 与 OpenAI strict 都只认 `anyOf`，`$ref` 也不是
 * 每家都展开。工具侧能给的保证不是"模型不会写坏 JSON"（那在 provider），而是"**我们的 schema 不会被
 * 任何一家的方言拒掉**"。这条保证必须由测试守着，否则加字段时会悄悄退化。
 *
 * 判据（对 `tools/list` 的真实回包递归检查，不看源码常量）：
 *   1. 禁用关键字：`oneOf` / `$ref` / `$defs`（严格模式不支持，且分支可按 type 写成 anyOf）；
 *   2. 禁用长度约束：`minLength` / `maxLength` / `minItems` / `maxItems`（strict 明确不支持）；
 *   3. `required` 只能引用已声明的属性；
 *   4. `enum` 非空；
 *   5. 每个 schema 都有 `type`（anyOf 分支允许没有，但非 anyOf 节点必须有）。
 *
 * 边界：它只测 MCP 面。DSH 适配器用自己的方言（保留 `oneOf`），由 `aura-edit/load-test` 与
 * `outcome-test` 守着——两个面共用同一份引擎，不走同一份 schema 渲染。
 *
 * 运行：node src/locator-lab/schema-portability-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..')
const mcpBin = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-schema-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const res = spawnSync(process.execPath, [mcpBin], {
  cwd: tmp,
  env,
  encoding: 'utf8',
  timeout: 30000,
  input: [rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'portability', version: '0' } }), rpc(2, 'tools/list', {})].join('\n') + '\n',
})
const lines = String(res.stdout ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
const responses = []
for (const line of lines) {
  try {
    responses.push(JSON.parse(line))
  } catch {
    /* 非 JSON 行忽略：stderr 不在这里 */
  }
}
const tools = responses.find((msg) => msg.id === 2)?.result?.tools

console.log('=== 0. 服务端可用 ===')
check(res.status === 0, 'MCP 进程正常退出', `status=${res.status} stderr=${String(res.stderr ?? '').slice(0, 120)}`)
check(Array.isArray(tools) && tools.length >= 4, `tools/list 返回 ${Array.isArray(tools) ? tools.length : 0} 个工具`)
if (!Array.isArray(tools)) {
  console.log(`\n--- ${pass} 通过 / ${fail} 失败（无法拿到 schema，后续判据跳过）---`)
  process.exit(1)
}

/** 递归收集问题：返回 [{where, why}]，空数组 = 合规。 */
const FORBIDDEN_KEYWORDS = new Set(['oneOf', '$ref', '$defs'])
const FORBIDDEN_BOUNDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems'])
function auditSchema(node, where, problems) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  const hasAnyOf = Array.isArray(node.anyOf)
  if (typeof node.type !== 'string' && !hasAnyOf && node !== node.properties) {
    // 只有 anyOf 容器允许没有 type；`properties` 容器本身也允许（部分实现省略）。
    if (!Array.isArray(node.enum) && Object.keys(node).length > 0 && !Array.isArray(node.required)) {
      problems.push({ where, why: '缺少 type 且不是 anyOf 容器' })
    }
  }
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYWORDS.has(key)) problems.push({ where, why: `使用了 ${key}` })
    if (FORBIDDEN_BOUNDS.has(key)) problems.push({ where, why: `使用了 ${key}（strict 不支持长度约束）` })
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required)) problems.push({ where, why: 'required 不是数组' })
    else {
      const declared = node.properties && typeof node.properties === 'object' ? Object.keys(node.properties) : []
      for (const name of node.required) {
        if (!declared.includes(name)) problems.push({ where, why: `required 里的 ${name} 没有声明` })
      }
    }
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    problems.push({ where, why: 'enum 为空或不是数组' })
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean' && typeof node.additionalProperties !== 'object') {
    problems.push({ where, why: 'additionalProperties 形状非法' })
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties)) auditSchema(child, `${where}.properties.${name}`, problems)
  }
  if (node.items) auditSchema(node.items, `${where}.items`, problems)
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((child, index) => auditSchema(child, `${where}.anyOf[${index}]`, problems))
}

console.log('\n=== 1. 可移植子集（多 agent 共用的那条线）===')
for (const tool of tools) {
  const problems = []
  auditSchema(tool.inputSchema, tool.name, problems)
  check(problems.length === 0, `${tool.name} schema 在可移植子集内`, problems.slice(0, 3).map((p) => `${p.where}: ${p.why}`).join(' | '))
}

console.log('\n=== 2. 工具面完整性 ===')
const names = tools.map((tool) => tool.name).sort()
const expected = ['aura_basetools_convert', 'aura_basetools_edit', 'aura_basetools_read', 'aura_basetools_tx', 'aura_basetools_write']
check(JSON.stringify(names) === JSON.stringify(expected), `五个工具都在：${names.join(', ')}`)

console.log(`\n--- ${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
