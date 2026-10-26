/**
 * entity-apply-test —— 独立面的接口/系统验收：实体读、apply、目录 grep、图片读。
 *
 * WHERE TO CHANGE:
 *   A read --entity / B apply replace-body / C stale evidence / D rename / E ambiguous
 *   F directory grep / G image (CLI metadata + MCP image content) / H tools/list
 *
 * USED BY:
 *   build/release-check.mjs SUITES + CRITICAL_SUITES ('entity-apply')
 *
 * 真 CLI / 真 MCP 进程；缓存与夹具都在 os.tmpdir()，不碰 ~/.aura、不碰外网。
 * 运行：node src/aura-standalone/test/entity-apply-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..', '..')
const cli = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const mcp = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-apply-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }

let pass = 0
let fail = 0
const say = (m) => process.stdout.write(`${m}\n`)
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  say(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}

const runCli = (args, cwd = tmp) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
const json = (res) => {
  try {
    return JSON.parse(String(res.stdout).trim().split('\n').pop())
  } catch {
    return { ok: false, error: `stdout is not JSON: ${JSON.stringify(res.stdout)} ${String(res.stderr ?? '').trim().slice(0, 200)}` }
  }
}
const write = (name, text) => {
  const p = path.join(tmp, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf8')
  return p
}

/** 一次 MCP stdio 往返：frames = [{id, method, params}]，返回 id → reply。 */
const mcpCall = (frames) => {
  const res = spawnSync(process.execPath, [mcp], {
    input: `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  })
  const replies = String(res.stdout).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return new Map(replies.map((reply) => [reply.id, reply]))
}

say('=== A. read --entity：定义 + 引用 + 证据 ===')
const alphaPath = write(
  'alpha.mjs',
  "// alpha stays in this comment\nconst label = 'alpha'\n\nexport function alpha(value) {\n  return alpha(value - 1)\n}\n",
)
const alphaRead = json(runCli(['basetools', 'read', '--file', alphaPath, '--entity', 'function:alpha']))
check(alphaRead.ok === true && alphaRead.mode === 'entity', 'A1 实体读取成功（mode=entity）', JSON.stringify(alphaRead).slice(0, 160))
check(alphaRead.entity?.name === 'alpha' && alphaRead.entity?.kind === 'function', 'A2 回执带实体身份', JSON.stringify(alphaRead.entity ?? null).slice(0, 160))
check(String(alphaRead.definition?.body ?? '').includes('export function alpha(value)'), 'A3 definition.body 是实体跨度正文', String(alphaRead.definition?.body ?? '').slice(0, 80))
check(Array.isArray(alphaRead.references) && alphaRead.references.length === 1 && alphaRead.references[0].line === 5, 'A4 references 指向调用行', JSON.stringify(alphaRead.references))
check(
  (typeof alphaRead.evidence?.spanHash === 'string' || typeof alphaRead.evidence?.spanHash === 'number') &&
    typeof alphaRead.evidence?.version === 'string',
  'A5 evidence 带 spanHash + version',
  JSON.stringify(alphaRead.evidence),
)

say('')
say('=== B. apply replace-body + evidence：落盘并回读验证 ===')
const body = 'export function alpha(value) {\n  return value + 1\n}'
const applied = json(
  runCli([
    'basetools', 'apply', '--file', alphaPath, '--entity', 'function:alpha', '--op', 'replace-body',
    '--change', body, '--evidence', JSON.stringify(alphaRead.evidence),
  ]),
)
check(applied.ok === true && applied.entity?.name === 'alpha', 'B1 apply 成功并回带实体', JSON.stringify(applied).slice(0, 180))
check(applied.auto_observed === true && applied.result?.write_verify?.level === 'bytes', 'B2 apply 自带观测 + 字节级回读', JSON.stringify({ auto: applied.auto_observed, verify: applied.result?.write_verify }))
check(fs.readFileSync(alphaPath, 'utf8').includes('return value + 1'), 'B3 磁盘上是新正文')
const alphaAgain = json(runCli(['basetools', 'read', '--file', alphaPath, '--entity', 'function:alpha']))
check(String(alphaAgain.definition?.body ?? '').includes('return value + 1'), 'B4 回读实体确认新正文', String(alphaAgain.definition?.body ?? '').slice(0, 80))

say('')
say('=== C. 证据过期：PATCH_ENTITY_STALE，零写入 ===')
const stalePath = write('stale.mjs', 'export function alpha(value) {\n  return value\n}\n')
const staleRead = json(runCli(['basetools', 'read', '--file', stalePath, '--entity', 'function:alpha']))
fs.writeFileSync(stalePath, 'export function alpha(value) {\n  return value * 2\n}\n', 'utf8')
const external = fs.readFileSync(stalePath, 'utf8')
const stale = json(
  runCli([
    'basetools', 'apply', '--file', stalePath, '--entity', 'function:alpha', '--change', body,
    '--evidence', JSON.stringify(staleRead.evidence),
  ]),
)
check(stale.ok === false && stale.code === 'PATCH_ENTITY_STALE', 'C1 拒绝码 PATCH_ENTITY_STALE', JSON.stringify(stale).slice(0, 160))
check(fs.readFileSync(stalePath, 'utf8') === external, 'C2 磁盘保持外部改动（一字未写）')

say('')
say('=== D. apply rename：定义 + 引用改，注释/字符串不动 ===')
const renamePath = write(
  'rename.mjs',
  "// alpha stays in this comment\nconst label = 'alpha'\n\nexport function alpha(value) {\n  return alpha(value - 1)\n}\n",
)
const renamed = json(runCli(['basetools', 'apply', '--file', renamePath, '--entity', 'function:alpha', '--op', 'rename', '--new-name', 'omega', '--scope', 'file']))
const renamedText = fs.readFileSync(renamePath, 'utf8')
check(renamed.ok === true, 'D1 rename 成功', JSON.stringify(renamed).slice(0, 160))
check(renamedText.includes('function omega(') && renamedText.includes('return omega(value - 1)'), 'D2 定义与引用都改了', JSON.stringify(renamedText))
check(renamedText.includes('// alpha stays in this comment') && renamedText.includes("'alpha'"), 'D3 注释与字符串原样保留')

say('')
say('=== E. 歧义实体：ENTITY_AMBIGUOUS + candidates，零写入 ===')
const dupPath = write('dup.mjs', 'export function dup() { return 1 }\nexport function dup() { return 2 }\n')
const dupBefore = fs.readFileSync(dupPath, 'utf8')
const dup = json(runCli(['basetools', 'apply', '--file', dupPath, '--entity', 'function:dup', '--change', 'export function dup() { return 3 }']))
check(dup.ok === false && dup.code === 'ENTITY_AMBIGUOUS', 'E1 拒绝码 ENTITY_AMBIGUOUS', JSON.stringify(dup).slice(0, 180))
check(Array.isArray(dup.candidates) && dup.candidates.length === 2, 'E2 回执带两个候选', JSON.stringify(dup.candidates ?? null).slice(0, 200))
check(fs.readFileSync(dupPath, 'utf8') === dupBefore, 'E3 歧义时文件一字未写')

say('')
say('=== F. 目录 grep：字面量 / 正则 / glob / 忽略规则 / 二进制 ===')
const work = path.join(tmp, 'repo')
write('repo/src/one.js', '// needle one\nconst x = 1\n')
write('repo/src/two.js', 'const needle = 2\nconst y = "needle42"\n')
write('repo/node_modules/pkg/hidden.js', 'needle hidden\n')
write('repo/.git/objects/blob.js', 'needle git\n')
fs.mkdirSync(path.join(work, 'assets'), { recursive: true })
fs.writeFileSync(path.join(work, 'assets', 'binary.bin'), Buffer.concat([Buffer.from([0]), Buffer.from('needle\u0000\n')]))

const literal = json(runCli(['basetools', 'read', '--file', work, '--search', 'needle']))
check(literal.ok === true && literal.mode === 'grep', 'F1 目录 + --search ⇒ mode=grep', JSON.stringify(literal).slice(0, 160))
check(Array.isArray(literal.matches) && literal.matches.length === 3, 'F2 字面量命中三行（src 两个文件）', JSON.stringify(literal.matches?.map((m) => `${m.file}:${m.line}`)))
check(literal.matches.every((m) => !m.file.includes('node_modules') && !m.file.includes('.git')), 'F3 忽略 node_modules / .git')
check(!literal.matches.some((m) => m.file.endsWith('.bin')), 'F4 跳过二进制文件')

const regex = json(runCli(['basetools', 'read', '--file', work, '--search', 'needle[0-9]+', '--regex']))
check(regex.ok === true && regex.matches.length === 1 && regex.matches[0].text.includes('needle42'), 'F5 正则命中 needle42', JSON.stringify(regex.matches ?? null))

const globbed = json(runCli(['basetools', 'read', '--file', work, '--search', 'needle', '--glob', 'src/*.js']))
check(globbed.ok === true && globbed.matches.length === 3 && globbed.matches.every((m) => m.file.startsWith('src/')), 'F6 glob 限定到 src/*.js', JSON.stringify(globbed.matches?.map((m) => m.file)))

const none = json(runCli(['basetools', 'read', '--file', work, '--search', 'zzz_not_here']))
check(none.ok === true && Array.isArray(none.matches) && none.matches.length === 0 && /0 match/.test(String(none.text)), 'F7 无命中仍是 ok:true + 0 match 形状', JSON.stringify(none).slice(0, 140))

say('')
say('=== G. 图片：CLI 只回元数据；MCP 走原生 image content ===')
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const png = path.join(tmp, 'pixel.png')
fs.writeFileSync(png, pngBytes)
const imageCli = json(runCli(['basetools', 'read', '--file', png]))
check(imageCli.ok === true && imageCli.mode === 'image' && imageCli.mime === 'image/png', 'G1 CLI 图片回执 mode/mime', JSON.stringify(imageCli).slice(0, 180))
check(imageCli.width === 1 && imageCli.height === 1 && imageCli.bytes === pngBytes.length, 'G2 CLI 给出宽高与字节数', JSON.stringify({ w: imageCli.width, h: imageCli.height, b: imageCli.bytes }))
check(imageCli.image === undefined && imageCli.image_data === 'omitted (MCP returns bytes)', 'G3 CLI 不输出 base64', JSON.stringify({ image: imageCli.image, image_data: imageCli.image_data }))

const imageMcp = mcpCall([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: { file_path: png } } },
])
const imageReply = imageMcp.get(2)
const imagePart = imageReply?.result?.content?.find((part) => part.type === 'image')
const imageMeta = JSON.parse(imageReply?.result?.content?.find((part) => part.type === 'text')?.text ?? '{}')
check(imagePart?.mimeType === 'image/png' && typeof imagePart?.data === 'string' && imagePart.data.length > 0, 'G4 MCP content 含 {type:image, mimeType:image/png}', JSON.stringify(imagePart ?? null).slice(0, 100))
check(imageReply?.result?.isError !== true && imageMeta.mode === 'image' && imageMeta.width === 1 && imageMeta.image === undefined, 'G5 MCP 文本段是元数据（不含 image.data）', JSON.stringify(imageMeta).slice(0, 160))

say('')
say('=== H. MCP tools/list：read + apply 都在 ===')
const listed = mcpCall([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
])
const names = (listed.get(2)?.result?.tools ?? []).map((tool) => tool.name)
const applyTool = (listed.get(2)?.result?.tools ?? []).find((tool) => tool.name === 'aura_basetools_apply')
const readTool = (listed.get(2)?.result?.tools ?? []).find((tool) => tool.name === 'aura_basetools_read')
check(names.includes('aura_basetools_read') && names.includes('aura_basetools_apply') && names.length === 2, 'H1 默认 tools/list 只有 read 与 apply', names.join(','))
check(applyTool?.inputSchema?.properties?.file_path !== undefined && applyTool?.inputSchema?.properties?.entity !== undefined && applyTool?.inputSchema?.properties?.op !== undefined && applyTool?.inputSchema?.additionalProperties === false, 'H2 apply schema 含 file_path/entity/op 且禁止额外键', JSON.stringify(applyTool?.inputSchema?.required ?? null))
check(readTool?.inputSchema?.properties?.entity !== undefined && readTool?.inputSchema?.properties?.max_results !== undefined, 'H3 read schema 声明 entity / max_results', Object.keys(readTool?.inputSchema?.properties ?? {}).join(','))

say('')
say('=== I. apply 的其他 op：write / patch / convert ===')
{
  const envOf = (replies, id) => JSON.parse(replies.get(id)?.result?.content?.[0]?.text ?? '{}')
  const writePath = path.join(tmp, 'apply-write.txt')
  const writeMcp = mcpCall([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_basetools_apply', arguments: { op: 'write', file_path: writePath, content: 'one\ntwo\n' } } },
  ])
  const written = envOf(writeMcp, 2)
  check(written.ok === true && fs.readFileSync(writePath, 'utf8') === 'one\ntwo\n', 'I1 apply op=write 建文件并落盘', JSON.stringify(written).slice(0, 120))

  const patchMcp = mcpCall([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_basetools_read', arguments: { file_path: writePath, mode: 'lines', lines: [1, 2] } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_basetools_apply', arguments: { op: 'patch', file_path: writePath, hunks: [{ lines: [2, 2], replace: 'TWO' }] } } },
  ])
  const patched = envOf(patchMcp, 3)
  check(patched.ok === true && fs.readFileSync(writePath, 'utf8').includes('TWO'), 'I2 apply op=patch 走既有编辑路径', JSON.stringify(patched).slice(0, 120))

  const utf16 = path.join(tmp, 'apply-convert.txt')
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\n', 'utf16le')]))
  const convertMcp = mcpCall([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aura_basetools_apply', arguments: { op: 'convert', file_path: utf16, to: 'utf-8', from: 'utf-16le' } } },
  ])
  const converted = envOf(convertMcp, 2)
  check(converted.ok === true && fs.readFileSync(utf16, 'utf8').includes('hello'), 'I3 apply op=convert 转 UTF-16LE → UTF-8', JSON.stringify(converted).slice(0, 120))
}

say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exitCode = fail === 0 ? 0 : 1
