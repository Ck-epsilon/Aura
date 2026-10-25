/**
 * strict-schema —— 把可移植 schema 变成 **provider strict 模式可接受**的变体。
 *
 * 为什么需要：`MALFORMED_RESPONSE`（模型输出的 tool 参数不是合法 JSON）发生在工具被调用之前，
 * 工具侧只能降概率；**能归零的只有 provider 的约束解码**。DeepSeek 的 strict（Beta）与 OpenAI 的
 * strict 都要求同一组硬约束：
 *
 *   · 每个 object 的**全部** properties 必须进 `required`；
 *   · 每个 object 必须 `additionalProperties: false`；
 *   · 不支持 `oneOf`（支持 `anyOf`）；
 *   · 不支持 `minLength` / `maxLength` / `minItems` / `maxItems`。
 *
 * 而"可选参数"在 strict 里只能用“**必填但可为 null**”表达，于是转换规则是：
 *   原本不在 `required` 里的字段 ⇒ `anyOf: [原类型, {type: 'null'}]`。
 *
 * 代价：模型每次调用会多输出一批 `null` 字段（按 15 天用量估算 ≈ +9M output tokens）。
 * 换来的是这一类失败**结构上不可能**——而不是更少见。
 *
 * 边界：本模块只做纯转换，不改任何运行时校验；宿主在自己那一侧决定是否启用 strict
 * （`base_url=/beta` + 每个 function 的 `strict: true`）。
 *
 * 运行自检见 `strict-schema-test.mjs`。
 */

const DROP_BOUNDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems'])

const clone = (value) => JSON.parse(JSON.stringify(value))

/**
 * @param schema - 可移植 JSON Schema（允许 `anyOf`，不允许 `oneOf`——出现了会就地转成 `anyOf`）
 * @returns 满足 strict 四条硬约束的新 schema（不改原对象）
 */
export function toStrictSchema(schema) {
  if (schema === null || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(toStrictSchema)

  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_BOUNDS.has(key)) continue
    if (key === 'oneOf') {
      // strict 只认 anyOf；两个关键字在分支互斥时语义相同。
      out.anyOf = Array.isArray(value) ? value.map(toStrictSchema) : value
      continue
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toStrictSchema(child)]))
      continue
    }
    if (key === 'items') {
      out.items = toStrictSchema(value)
      continue
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value.map(toStrictSchema)
      continue
    }
    out[key] = value
  }

  if (out.type === 'object' && out.properties !== null && typeof out.properties === 'object') {
    const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : [])
    const properties = {}
    for (const [name, child] of Object.entries(out.properties)) {
      if (originallyRequired.has(name)) {
        properties[name] = child
        continue
      }
      // 可选 ⇒ 必填但可为 null（strict 不认 "可选"）。
      const nullable = { anyOf: [child, { type: 'null' }] }
      if (child !== null && typeof child === 'object' && typeof child.description === 'string') nullable.description = child.description
      properties[name] = nullable
    }
    out.properties = properties
    out.required = Object.keys(properties)
    out.additionalProperties = false
  }

  return out
}

/** 从 MCP `tools/list` 的形状生成 strict 工具表（宿主可直接塞给 provider）。 */
export function strictToolList(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toStrictSchema(clone(tool.inputSchema)),
  }))
}
