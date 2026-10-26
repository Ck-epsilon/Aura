/**
 * strict-schema-test —— `toStrictSchema()` 的判据：输出必须满足 provider strict 的四条硬约束。
 *
 * 为什么单测它：strict 变体是"P1（模型输出的参数不是合法 JSON）归零"的**唯一工具侧产物**。
 * 如果它悄悄不合规，宿主开了 strict 只会得到一条 schema 校验错误，而不是更稳的调用——那比不转更糟。
 *
 * 判据（对转换结果递归检查）：
 *   1. 不出现 `oneOf`（strict 不认）；
 *   2. 不出现 `minLength` / `maxLength` / `minItems` / `maxItems`；
 *   3. 每个带 `properties` 的 object：`additionalProperties === false`，且 `required` 恰好等于属性名集合；
 *   4. 原本可选的字段必须变成 `anyOf: [原类型, {type:'null'}]`；
 *   5. 纯函数：原 schema 不被改动。
 *
 * 运行：node src/locator-lab/strict-schema-test.mjs
 */
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { toStrictSchema, strictToolList } from './strict-schema.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}

function mcpTools() {
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const res = spawnSync(process.execPath, [bin], { input: `${init}\n${list}\n`, encoding: 'utf8', timeout: 30000 })
  for (const line of String(res.stdout ?? '').split('\n')) {
    try {
      const msg = JSON.parse(line)
      if (msg?.id === 2) return msg.result.tools
    } catch {
      /* 非 JSON 行 */
    }
  }
  return []
}

const STRICT_FORBIDDEN = new Set(['oneOf', 'minLength', 'maxLength', 'minItems', 'maxItems'])

/** 递归审计转换结果，返回问题列表。 */
function auditStrict(node, where, problems) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => auditStrict(child, `${where}[${index}]`, problems))
    return
  }
  for (const key of Object.keys(node)) {
    if (STRICT_FORBIDDEN.has(key)) problems.push(`${where}: 出现 ${key}`)
  }
  if (node.type === 'object' && node.properties !== null && typeof node.properties === 'object') {
    if (node.additionalProperties !== false) problems.push(`${where}: additionalProperties 不是 false`)
    const names = Object.keys(node.properties).sort()
    const required = Array.isArray(node.required) ? [...node.required].sort() : []
    if (JSON.stringify(names) !== JSON.stringify(required)) problems.push(`${where}: required 与属性集合不一致`)
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties)) auditStrict(child, `${where}.${name}`, problems)
  }
  if (node.items) auditStrict(node.items, `${where}.items`, problems)
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((child, index) => auditStrict(child, `${where}.anyOf[${index}]`, problems))
}

const tools = mcpTools()
check(tools.length >= 4, `拿到 ${tools.length} 个工具（tools/list）`)
const strict = strictToolList(tools)
check(strict.length === tools.length && strict.every((tool, index) => tool.name === tools[index].name), 'strictToolList 保留工具名与顺序')

for (const tool of tools) {
  const before = JSON.stringify(tool.inputSchema)
  const converted = toStrictSchema(tool.inputSchema)
  check(JSON.stringify(tool.inputSchema) === before, `${tool.name}: 转换不改原 schema`)
  const problems = []
  auditStrict(converted, tool.name, problems)
  check(problems.length === 0, `${tool.name}: strict 四条硬约束`, problems.slice(0, 3).join(' | '))
}

// 4. 可选字段必须变成“必填但可为 null”——挑一个确定的样本：edit 的 `verify` 原本不在 required。
{
  const edit = strict.find((tool) => tool.name === 'aura_basetools_edit')
  const verify = edit?.inputSchema?.properties?.verify
  check(
    verify?.anyOf?.some((branch) => branch.type === 'null') === true,
    '原本可选的 `verify` 变成 anyOf[类型, null]',
    JSON.stringify(verify).slice(0, 120),
  )
  const filePath = edit?.inputSchema?.properties?.file_path
  check(
    filePath?.anyOf?.some((branch) => branch.type === 'null') === true,
    '原本不在 required 的 `file_path` 也变成可为 null',
    JSON.stringify(filePath).slice(0, 120),
  )
}

console.log(`\n--- ${pass} 通过 / ${fail} 失败 ---`)
process.exit(fail === 0 ? 0 : 1)
