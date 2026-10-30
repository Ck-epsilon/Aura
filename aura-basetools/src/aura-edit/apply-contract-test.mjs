/**
 * apply-contract-test —— DSH `aura_basetools_apply` 的接口级契约闸。
 *
 * 这里不测私有函数，而是把插件真正注册出来的 apply 工具拿来执行，再用
 * `@deepseek-ai/dsh-tools` 的同一个校验器检查返回值。覆盖的是 1.0.3 暴露出的
 * 几类“核心产出与 DSH 声明各自演化”问题：
 *   · applied[].note 漏声明；
 *   · convert 的 bom 输出是 boolean，而 apply schema 曾声明 string；
 *   · 纯 targets 调用被必填 file_path 挡在 execute 之前；
 *   · 多目标规划失败回执的 aborted 是字符串；
 *   · content + to 的 op 推断必须与独立面同序；
 *   · 单目标 retry 必须真的按上次观测重定位，并把 rebased 送回模型。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { apply as applyRead } from '../aura-read/index.js'
import { contextServices } from '../locator-lab/mock-ctx.mjs'
import * as editPlugin from './index.js'

const require = createRequire(import.meta.url)
let framework = null
try {
  framework = require('@deepseek-ai/dsh-tools')
} catch {
  framework = null
}

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}

function validate(value, schema, at = 'value') {
  const out = []
  if (schema === undefined || schema === null) return out
  const type = schema.type
  if (type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    return [`${at} must be an object`]
  }
  if (type === 'array' && !Array.isArray(value)) return [`${at} must be an array`]
  if (type === 'string' && typeof value !== 'string') return [`${at} must be a string (got ${typeof value})`]
  if (type === 'integer' && !Number.isInteger(value)) return [`${at} must be an integer`]
  if (type === 'boolean' && typeof value !== 'boolean') return [`${at} must be a boolean (got ${typeof value})`]
  if (type === 'object') {
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`${at}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) out.push(`${at}.${key} is not declared`)
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) out.push(...validate(value[key], child, `${at}.${key}`))
    }
  }
  if (type === 'array' && schema.items !== undefined) {
    value.forEach((entry, index) => out.push(...validate(entry, schema.items, `${at}[${index}]`)))
  }
  return out
}

function frameworkViolations(schema, value) {
  if (framework === null || typeof framework.validateJsonSchemaValue !== 'function') return []
  try {
    const out = framework.validateJsonSchemaValue(schema, value)
    return Array.isArray(out) ? out : []
  } catch (error) {
    return [String(error?.message ?? error).split('\n')[0]]
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-apply-contract-'))
let version = 0
const disk = {
  resolve: async (filePath, options) => {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(options?.cwd ?? tmp, filePath)
    return { displayPath: abs, targetKey: abs }
  },
  stat: async (target) => {
    if (!fs.existsSync(target.targetKey)) return undefined
    const stat = fs.statSync(target.targetKey)
    if (stat.isDirectory()) return { type: 'directory', size: 0 }
    return { type: 'file', version: `v${version}`, size: stat.size }
  },
  readText: async (target) => fs.readFileSync(target.targetKey, 'utf8'),
  readByteRange: async (target, range) =>
    fs.readFileSync(target.targetKey).subarray(range.offset, range.offset + range.length),
  readBytes: async (target, _signal, cap) => fs.readFileSync(target.targetKey).subarray(0, cap),
  writeText: async (target, content) => {
    fs.writeFileSync(target.targetKey, content)
    version += 1
    return { version: `v${version}`, after: content }
  },
  editText: async () => {
    throw new Error('editText must not be used')
  },
}

const tools = new Map()
const ctx = {
  get fs() {
    return disk
  },
  ...contextServices(),
  tools: {
    register: (tool) => tools.set(tool.name, tool),
    get: (name) => tools.get(name),
  },
  systemPrompt: { section: () => {} },
  emit: () => {},
  waterfall: async () => undefined,
}
applyRead(ctx)
editPlugin.apply(ctx)

const readTool = tools.get('aura_basetools_read')
const applyTool = tools.get('aura_basetools_apply')
check(readTool !== undefined && applyTool !== undefined, '注册出 read 与 apply 两个真实 DSH 工具')

const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
const run = async (tool, args) => {
  try {
    const value = await tool.execute(args, exec)
    return {
      value,
      violations: [...validate(value, tool.output.schema), ...frameworkViolations(tool.output.schema, value)],
    }
  } catch (error) {
    return { isError: true, error, code: error?.code, text: String(error?.message ?? error), violations: [] }
  }
}
const writeFile = (name, content) => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, content, 'utf8')
  version += 1
  return file
}

console.log('')
console.log('=== A. schema 与固定字段约定 ===')
const appliedSchema = applyTool.output.schema.properties.applied.items
check(appliedSchema.properties.note?.type === 'string', 'APPLIED_ITEM_SCHEMA 声明可选 string note')
check(applyTool.output.schema.properties.bom?.type === 'boolean', 'apply 输出把 bom 声明为 boolean')
check(applyTool.output.schema.properties.aborted?.type === 'string', 'apply 输出把 aborted 声明为 string')
check(applyTool.output.schema.properties.rebased?.type === 'array', 'apply 输出声明 retry 的 rebased 数组')
check(!(applyTool.parameters.required ?? []).includes('file_path'), 'apply 参数允许 targets 省略 file_path')

console.log('')
console.log('=== B. applied[].note 必须能通过 DSH 校验 ===')
{
  const file = writeFile('note.txt', 'alpha\nbeta\ngamma\n')
  const result = await run(applyTool, {
    op: 'patch',
    file_path: file,
    hunks: [{ old: 'alpha\nbeta\n', replace: 'ALPHA\n' }],
  })
  check(!result.isError, '带尾换行的 patch 正常返回', result.text)
  check(typeof result.value?.applied?.[0]?.note === 'string', '回执保留空行提示 note', JSON.stringify(result.value?.applied?.[0]))
  check(result.violations.length === 0, '带 note 的回执通过 output.schema', result.violations.join('; '))
  check(fs.readFileSync(file, 'utf8') === 'ALPHA\n\ngamma\n', 'patch 真落盘且保留改后内容')
}

console.log('')
console.log('=== C. convert 的 boolean bom 必须能通过 DSH 校验 ===')
{
  const file = writeFile('convert.txt', 'hello\n')
  const result = await run(applyTool, { op: 'convert', file_path: file, to: 'utf-8' })
  check(!result.isError, 'apply op=convert 正常返回', result.text)
  check(result.value?.bom === false, 'convert 回执的 bom 是 boolean 事实', JSON.stringify(result.value?.bom))
  check(result.violations.length === 0, 'convert 回执通过 output.schema', result.violations.join('; '))
}

console.log('')
console.log('=== D. 纯 targets 多目标入口 ===')
{
  const good = writeFile('batch.txt', 'one\ntwo\n')
  const result = await run(applyTool, {
    op: 'patch',
    targets: [
      { file_path: good, hunks: [{ old: 'one\n', replace: 'ONE' }] },
      { file_path: path.join(tmp, 'missing.txt'), hunks: [{ old: 'absent\n', replace: 'X' }] },
    ],
  })
  check(!result.isError, 'targets 可以不带 file_path 进入 execute', result.text)
  check(result.value?.aborted === 'plan', '规划失败回执带字符串 aborted=plan', JSON.stringify(result.value?.aborted))
  check(result.violations.length === 0, '多目标失败回执通过 output.schema', result.violations.join('; '))
  check(fs.readFileSync(good, 'utf8') === 'one\ntwo\n', '同批另一项规划失败时没有落盘')

  const both = await run(applyTool, {
    op: 'patch',
    file_path: good,
    targets: [{ file_path: good, hunks: [{ old: 'one\n', replace: 'ONE' }] }],
  })
  check(both.code === 'ARGS_SHAPE_EXCLUSIVE', 'file_path 与 targets 同时给必须拒绝', both.text)
  check(fs.readFileSync(good, 'utf8') === 'one\ntwo\n', '双形状拒绝时零写入')
}

console.log('')
console.log('=== E. content + to 的推断与独立面同序 ===')
{
  const file = writeFile('infer.txt', 'old\n')
  const result = await run(applyTool, { file_path: file, content: 'ignored\n', to: 'utf-8' })
  check(!result.isError, 'content + to 没有落到 write 的未读拒绝', result.text)
  check(result.value?.to === 'utf-8' && result.value?.operation !== 'write', '共享推断选择 convert', JSON.stringify(result.value))
  check(result.violations.length === 0, '推断路径回执通过 output.schema', result.violations.join('; '))
}

console.log('')
console.log('=== F. 单目标 retry 真正重定位并声明 rebased ===')
{
  const file = writeFile('retry.txt', 'alpha\nbravo\ncharlie\n')
  const read = await run(readTool, { file_path: file, mode: 'lines', lines: [2, 2] })
  check(!read.isError && read.violations.length === 0, '建立旧观测的读取成功且合 schema', read.text)
  fs.writeFileSync(file, 'PREFIX\nalpha\nbravo\ncharlie\n', 'utf8')
  version += 1

  const refused = await run(applyTool, {
    op: 'patch',
    file_path: file,
    hunks: [{ lines: [2, 2], expect: 'bravo', replace: 'BRAVO' }],
  })
  check(refused.value?.outcome === 'not_found', '不带 retry 时漂移地址仍被拒', JSON.stringify({ outcome: refused.value?.outcome, code: refused.value?.code }))
  check(fs.readFileSync(file, 'utf8').includes('\nbravo\n'), '拒绝路径不写盘')

  const retried = await run(applyTool, {
    op: 'patch',
    file_path: file,
    hunks: [{ lines: [2, 2], expect: 'bravo', replace: 'BRAVO' }],
    retry: true,
  })
  check(!retried.isError && retried.value?.outcome === 'applied', 'retry:true 一次改对', JSON.stringify(retried.value ?? retried.text))
  check(
    JSON.stringify(retried.value?.rebased) === JSON.stringify([{ from: [2, 2], to: [3, 3] }]),
    'retry 回执带 rebased from/to',
    JSON.stringify(retried.value?.rebased),
  )
  check(retried.violations.length === 0, 'retry 回执通过 output.schema', retried.violations.join('; '))
  check(fs.readFileSync(file, 'utf8').split('\n')[2] === 'BRAVO', 'retry 落在现文第 3 行')
}

console.log('')
console.log(`--- ${pass}/${pass + fail} 通过 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1
