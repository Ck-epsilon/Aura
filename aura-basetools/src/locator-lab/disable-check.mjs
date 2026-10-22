/**
 * disable-check.mjs —— 停掉 tool-fs 之前，先查两个会致命的缺口。
 *
 * 用户的意图是"强制走 Aura"，但实际可用性取决于两件事：
 *   ① aura_edit 能不能**创建**不存在的文件（否则新建文件的能力整个没了）
 *   ② aura_read 对**未知扩展名**能不能给内容（否则读 .yml/.json/.md 的能力整个没了）
 *
 * 第二个尤其要紧：.yml 是用户自己的预设、.json/.md 是任何仓库里最常见的文件。
 * 不查清就停用，等于把这两类文件变成不可读。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readWith } from './read-core.mjs'
import { apply as applyEdit } from '../aura-edit/index.js'

const say = (m) => fs.writeSync(1, `${m}\n`)

say('=== ① aura_read 对未知扩展名给什么 ===')
for (const [label, file] of [
  ['YAML', 'x.yml'],
  ['JSON', 'x.json'],
  ['Markdown', 'x.md'],
  ['SQL', 'x.sql'],
  ['无扩展名', 'README'],
]) {
  const src = 'some: value\nlist:\n  - a\n  - b\n'
  const r = readWith(src, { filePath: file, mode: 'auto' })
  say(`  ${label.padEnd(10)} auto → mode=${r.mode?.padEnd(6)} ${r.ok === false ? r.code : `text ${(r.text ?? '').length} 字符`}`)
}

say('')
say('=== ② aura_edit 能不能创建不存在的文件 ===')
const tmp = path.join(os.tmpdir(), `aura-create-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const newFile = path.join(tmp, 'brand-new.js')

let reg = null
let observedAbsent = false
const ctx = {
  fs: {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version: 'v1' } : undefined),
    readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
    editText: async (t, req) => {
      const exists = fs.existsSync(t.targetKey)
      const cur = exists ? fs.readFileSync(t.targetKey, 'utf8') : ''
      if (exists && cur.split(req.oldString).length - 1 !== 1) {
        throw Object.assign(new Error('no match'), { code: 'FS_EDIT_NOT_FOUND' })
      }
      fs.writeFileSync(t.targetKey, exists ? cur.split(req.oldString).join(req.newString) : req.newString, 'utf8')
      return { version: 'v2', operation: exists ? 'update' : 'create' }
    },
    // 创建路径走 writeText（与内置 write 同一条 seam），mock 必须提供，
    // 否则测不到创建——第一版就是缺了它，报 "writeText is not a function"。
    writeText: async (t, content, expected) => {
      if (expected?.kind === 'createIfAbsent' && fs.existsSync(t.targetKey)) {
        throw Object.assign(new Error('cannot overwrite existing without reading it first'), { code: 'FS_NOT_OBSERVED' })
      }
      fs.writeFileSync(t.targetKey, content, 'utf8')
      return { version: 'v1', operation: 'create', after: content }
    },
  },
  // 与真实 Cordis 上下文同形：`inject` 与 `get` 都必须存在。
  inject: (deps, fn) => {
    if (deps.includes('sandboxPolicy') && ctx.sandboxPolicy !== undefined) {
      fn({ sandboxPolicy: ctx.sandboxPolicy })
    }
  },
  get: (n) => ctx[n],
  tools: { register: (x) => (reg = x) },
  emit: (ev, _t, obs) => {
    if (ev === 'fs/observed' && obs?.kind === 'absent') observedAbsent = true
  },
  systemPrompt: { section: () => () => {} },
}
applyEdit(ctx)
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

try {
  const r = await reg.execute(
    { file_path: newFile, create: 'export const x = 1;\n', hunks: [] },
    exec,
  )
  say(`  创建成功: operation=${r.operation} line=${r.applied?.[0]?.line} tier=${r.applied?.[0]?.tier}`)
  say(`  文件已存在: ${fs.existsSync(newFile)}`)
  if (fs.existsSync(newFile)) say(`  内容: ${JSON.stringify(fs.readFileSync(newFile, 'utf8'))}`)
} catch (e) {
  say(`  创建失败: ${e.code ?? ''} ${String(e.message).slice(0, 120)}`)
}
say(`  缺失时是否发出 absent 观测: ${observedAbsent}`)

// 覆盖保护：文件已存在时，create 必须被忽略而不是静默覆盖
try {
  const r2 = await reg.execute(
    { file_path: newFile, create: 'THIS SHOULD NOT WIN\n', hunks: [{ lines: [1], replace: 'export const x = 2;' }] },
    exec,
  )
  const after = fs.readFileSync(newFile, 'utf8')
  say(`  文件已存在时: operation=${r2.operation} 内容=${JSON.stringify(after)}`)
  say(`  未被 create 覆盖: ${!after.includes('SHOULD NOT WIN')}`)
} catch (e) {
  say(`  已存在时报错: ${e.code ?? ''} ${String(e.message).slice(0, 80)}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
