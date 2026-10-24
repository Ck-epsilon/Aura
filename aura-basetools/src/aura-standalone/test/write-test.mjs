/**
 * write-test.mjs —— 0.10.1：整文件写（内置 `Write` 的替代）的验收。
 *
 * 覆盖：
 *   A 新建：真正建盘、回执 operation=create、dry-run 不建盘、事务可撤销（撤销后文件消失）
 *   B 覆写：整份替换、BOM 与文件既有行尾保留、有无尾换行精确、no-overwrite、dry-run、
 *     `--content @file`（0.14.0 移除公开事务/undo）
 *   C MCP：aura_basetools_write 出现在 tools/list，create/overwrite/no_overwrite/dry_run/坏参数都走同一引擎
 *   D 能力清单：commands 与 tools 都包含 write
 *
 * 只走公开入口（CLI / MCP / capabilities），临时目录与缓存全部隔离，不碰 ~/.aura。
 * 运行：node src/aura-standalone/test/write-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { writeEnvelope } from '../lib/ops.mjs'

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-write-'))
const cache = path.join(tmp, 'cache')
const env = { ...process.env, AURA_CACHE_DIR: cache }
const run = (args, cwd = tmp) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env })
const json = (res) => {
  try {
    return JSON.parse(String(res.stdout).trim().split('\n').pop())
  } catch {
    return { ok: false, error: `stdout 不是 JSON：${JSON.stringify(res.stdout)} ${String(res.stderr ?? '').trim().split('\n').slice(0, 3).join(' / ')}` }
  }
}
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const file = (name) => path.join(tmp, name)
const readBytes = (name) => fs.readFileSync(file(name))
/** 覆写默认要求先读过这一版（0.10.3）；测试里显式把「读 → 写」这条真实路径走一遍。 */
const prime = (name) => json(run(['basetools', 'read', '--file', name, '--mode', 'full']))
process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉不影响判据 */
  }
})

// ── A 新建 ────────────────────────────────────────────────────────────────
say('A 新建：整份建盘，dry-run 不建盘')
{
  const created = json(run(['basetools', 'write', '--file', 'created.txt', '--content', 'alpha\nbeta\n']))
  check(created.ok === true && created.result?.operation === 'create', 'A1 新建回执 operation=create', JSON.stringify(created).slice(0, 160))
  check(created.result?.bytes === 11 && created.result?.write_verify?.level === 'bytes', 'A2 bytes=11 且落盘后按字节回读', JSON.stringify(created.result))
  check(fs.readFileSync(file('created.txt'), 'utf8') === 'alpha\nbeta\n', 'A3 磁盘内容逐字等于 content', JSON.stringify(fs.readFileSync(file('created.txt'), 'utf8')))

  const dry = json(run(['basetools', 'write', '--file', 'dry-new.txt', '--content', 'x', '--dry-run']))
  check(dry.ok === true && dry.result?.operation === 'create' && dry.result?.dryRun === true && dry.result?.bytes === 1, 'A4 新建 dry-run 回执给 create/bytes，但不落盘', JSON.stringify(dry).slice(0, 160))
  check(fs.existsSync(file('dry-new.txt')) === false, 'A5 新建 dry-run 之后文件仍不存在')

  const missingFile = json(run(['basetools', 'write', '--content', 'x']))
  const missingContent = json(run(['basetools', 'write', '--file', 'x.txt']))
  check(missingFile.ok === false && missingFile.code === 'USAGE', 'A9 缺 --file ⇒ USAGE', JSON.stringify(missingFile).slice(0, 140))
  check(missingContent.ok === false && missingContent.code === 'USAGE', 'A10 缺 --content ⇒ USAGE', JSON.stringify(missingContent).slice(0, 140))

  // 0.10.5：`edit --create --dry-run` 曾经真的建文件（预演做了真事）
  const createDry = json(run(['basetools', 'edit', '--file', 'create-dry.txt', '--create', 'new\n', '--dry-run']))
  check(createDry.ok === true && createDry.result?.dryRun === true && createDry.result?.operation === 'create', 'A11 create + dry_run 回执是预演', JSON.stringify(createDry).slice(0, 160))
  check(fs.existsSync(file('create-dry.txt')) === false, 'A12 create + dry_run 之后文件不存在')
}

// ── B 覆写 ────────────────────────────────────────────────────────────────
say('B 覆写：整份替换，BOM / 既有行尾 / 尾换行精确')
{
  fs.writeFileSync(file('bom-crlf.txt'), Buffer.concat([BOM, Buffer.from('one\r\ntwo\r\n', 'utf8')]))
  prime('bom-crlf.txt')
  const crlf = json(run(['basetools', 'write', '--file', 'bom-crlf.txt', '--content', 'alpha\nbeta\n']))
  const expectedCrlf = Buffer.concat([BOM, Buffer.from('alpha\r\nbeta\r\n', 'utf8')])
  check(crlf.ok === true && crlf.result?.operation === 'write', 'B1 覆写回执 operation=write', JSON.stringify(crlf).slice(0, 160))
  check(readBytes('bom-crlf.txt').equals(expectedCrlf), 'B2 BOM 保留，content 的 LF 适配成文件已有的 CRLF', readBytes('bom-crlf.txt').toString('hex'))
  check(crlf.result?.bytes === expectedCrlf.length && crlf.result?.write_verify?.bytes === expectedCrlf.length, `B3 回执字节数 = 实际落盘字节数（${expectedCrlf.length}）`, JSON.stringify(crlf.result))

  fs.writeFileSync(file('no-tail.txt'), 'one\ntwo')
  prime('no-tail.txt')
  json(run(['basetools', 'write', '--file', 'no-tail.txt', '--content', 'alpha\nbeta']))
  check(fs.readFileSync(file('no-tail.txt'), 'utf8') === 'alpha\nbeta', 'B4 原文件无尾换行 + content 无尾换行 ⇒ 结果也无')

  fs.writeFileSync(file('add-tail.txt'), 'one\ntwo')
  prime('add-tail.txt')
  json(run(['basetools', 'write', '--file', 'add-tail.txt', '--content', 'alpha\nbeta\n']))
  check(fs.readFileSync(file('add-tail.txt'), 'utf8') === 'alpha\nbeta\n', 'B5 原文件无尾换行 + content 有尾换行 ⇒ 结果补上')

  fs.writeFileSync(file('kept.txt'), 'one\ntwo\n')
  prime('kept.txt')
  const beforeDry = fs.readFileSync(file('kept.txt'))
  const dry = json(run(['basetools', 'write', '--file', 'kept.txt', '--content', 'new\n', '--dry-run']))
  check(dry.ok === true && dry.result?.dryRun === true, 'B6 覆写 dry-run 成功', JSON.stringify(dry).slice(0, 160))
  check(dry.result?.bytes === undefined, 'B7 覆写 dry-run 不谎报 bytes（行尾适配后长度未知）', JSON.stringify(dry.result))
  check(fs.readFileSync(file('kept.txt')).equals(beforeDry), 'B8 覆写 dry-run 之后磁盘逐字节没变')

  const refused = json(run(['basetools', 'write', '--file', 'kept.txt', '--content', 'nope\n', '--no-overwrite']))
  check(refused.ok === false && refused.code === 'WRITE_EXISTS', 'B9 no-overwrite 对已存在文件 ⇒ WRITE_EXISTS', JSON.stringify(refused).slice(0, 160))
  check(fs.readFileSync(file('kept.txt')).equals(beforeDry), 'B10 被拒绝的 no-overwrite 没动磁盘')
  const newNoOverwrite = json(run(['basetools', 'write', '--file', 'brand-new.txt', '--content', 'ok\n', '--no-overwrite']))
  check(newNoOverwrite.ok === true, 'B11 no-overwrite 对不存在的文件照常创建')

  fs.writeFileSync(file('content-source.txt'), 'from @file\nsecond line\n')
  const atFile = json(run(['basetools', 'write', '--file', 'from-at.txt', '--content', '@' + file('content-source.txt')]))
  check(atFile.ok === true && fs.readFileSync(file('from-at.txt'), 'utf8') === fs.readFileSync(file('content-source.txt'), 'utf8'), 'B14 --content @file 读入整份内容')

  fs.writeFileSync(file('empty.txt'), 'not empty\n')
  prime('empty.txt')
  const empty = json(run(['basetools', 'write', '--file', 'empty.txt', '--content', '']))
  check(empty.ok === true && fs.readFileSync(file('empty.txt')).length === 0, 'B15 content="" 得到真正的空文件', String(fs.readFileSync(file('empty.txt')).length))

  // 0.10.3：整份覆写默认要求先读过这一版（read-before-write）
  fs.writeFileSync(file('blind.txt'), 'original\n')
  fs.writeFileSync(file('blind-dry.txt'), 'original\n')
  const blindBefore = fs.readFileSync(file('blind.txt'))
  const blind = json(run(['basetools', 'write', '--file', 'blind.txt', '--content', 'blind\n']))
  check(blind.ok === false && blind.code === 'PATCH_UNOBSERVED' && blind.reason === 'never-read', 'B16 没读过就覆写 ⇒ PATCH_UNOBSERVED（never-read）', JSON.stringify(blind).slice(0, 180))
  check(fs.readFileSync(file('blind.txt')).equals(blindBefore), 'B17 被严格闸拒绝时磁盘没变')
  const blindDry = json(run(['basetools', 'write', '--file', 'blind.txt', '--content', 'blind\n', '--dry-run']))
  check(blindDry.ok === false && blindDry.code === 'PATCH_UNOBSERVED', 'B18 盲写预演拿到同一个拒绝（预演不撒谎）', JSON.stringify(blindDry).slice(0, 160))
  const escaped = json(run(['basetools', 'write', '--file', 'blind.txt', '--content', 'blind\n', '--allow-unobserved']))
  check(escaped.ok === true && fs.readFileSync(file('blind.txt'), 'utf8') === 'blind\n', 'B19 --allow-unobserved 是显式逃生口', JSON.stringify(escaped).slice(0, 160))
  check(escaped.result?.unverified_region === true, 'B20 盲写在回执里如实标 unverified_region', JSON.stringify(escaped.result))
  const blindDryAllowed = json(run(['basetools', 'write', '--file', 'blind-dry.txt', '--content', 'preview\n', '--dry-run', '--allow-unobserved']))
  check(blindDryAllowed.ok === true && blindDryAllowed.result?.dryRun === true && blindDryAllowed.result?.unverified_region === true, 'B20b 允许盲写的 dry-run 也如实标 unverified_region', JSON.stringify(blindDryAllowed.result))

  fs.writeFileSync(file('changed-since.txt'), 'v1\n')
  prime('changed-since.txt')
  fs.writeFileSync(file('changed-since.txt'), 'v2\n')
  const changed = json(run(['basetools', 'write', '--file', 'changed-since.txt', '--content', 'v3\n']))
  check(changed.ok === false && changed.code === 'PATCH_UNOBSERVED' && changed.reason === 'changed-since-read', 'B21 读过之后文件又变了 ⇒ PATCH_UNOBSERVED（changed-since-read）', JSON.stringify(changed).slice(0, 180))

  // 0.10.4：覆写的换行策略（auto 默认 / preserve 原样 / lf / crlf）
  fs.writeFileSync(file('eol-preserve.txt'), Buffer.concat([BOM, Buffer.from('one\r\ntwo\r\n', 'utf8')]))
  prime('eol-preserve.txt')
  const preserve = json(run(['basetools', 'write', '--file', 'eol-preserve.txt', '--content', 'a\nb\n', '--eol', 'preserve']))
  check(preserve.ok === true && readBytes('eol-preserve.txt').equals(Buffer.concat([BOM, Buffer.from('a\nb\n', 'utf8')])), 'B22 --eol preserve 按 content 原样写（BOM 保留，不改成 CRLF）', readBytes('eol-preserve.txt').toString('hex'))

  fs.writeFileSync(file('eol-lf.txt'), 'one\r\ntwo\r\n')
  prime('eol-lf.txt')
  const lf = json(run(['basetools', 'write', '--file', 'eol-lf.txt', '--content', 'a\r\nb\r\n', '--eol', 'lf']))
  check(lf.ok === true && readBytes('eol-lf.txt').toString('utf8') === 'a\nb\n', 'B23 --eol lf 强制 LF', JSON.stringify(readBytes('eol-lf.txt').toString('utf8')))

  fs.writeFileSync(file('eol-crlf.txt'), 'one\ntwo\n')
  prime('eol-crlf.txt')
  const crlfForce = json(run(['basetools', 'write', '--file', 'eol-crlf.txt', '--content', 'a\nb\n', '--eol', 'crlf']))
  check(crlfForce.ok === true && readBytes('eol-crlf.txt').toString('utf8') === 'a\r\nb\r\n', 'B24 --eol crlf 强制 CRLF', JSON.stringify(readBytes('eol-crlf.txt').toString('utf8')))

  const badEol = json(run(['basetools', 'write', '--file', 'eol-lf.txt', '--content', 'x\n', '--eol', 'cr']))
  check(badEol.ok === false && badEol.code === 'WRITE_BAD_ARGS', 'B25 非法 --eol ⇒ WRITE_BAD_ARGS', JSON.stringify(badEol).slice(0, 160))
  const createEol = json(run(['basetools', 'write', '--file', 'eol-new.txt', '--content', 'x\n', '--eol', 'lf']))
  check(createEol.ok === false && createEol.code === 'WRITE_BAD_ARGS' && !fs.existsSync(file('eol-new.txt')), 'B26 新建文件显式非 auto eol ⇒ 拒绝（不静默忽略）', JSON.stringify(createEol).slice(0, 160))
  const createAuto = json(run(['basetools', 'write', '--file', 'eol-new.txt', '--content', 'x\n', '--eol', 'auto']))
  check(createAuto.ok === true && fs.readFileSync(file('eol-new.txt'), 'utf8') === 'x\n', 'B27 新建文件 eol=auto 照常按 content 原样写')

  // 0.10.5：评审复现的三个失败路径
  const atMissing = json(run(['basetools', 'write', '--file', 'at-missing-out.txt', '--content', '@missing-content.txt']))
  check(atMissing.ok === false && atMissing.code === 'USAGE' && !fs.existsSync(file('at-missing-out.txt')), 'B28 --content @不存在 ⇒ JSON 回执（不是 Node 栈）', JSON.stringify(atMissing).slice(0, 160))

  fs.writeFileSync(file('latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  const nonUtf8 = json(run(['basetools', 'write', '--file', 'latin1.txt', '--content', 'x\n', '--allow-unobserved']))
  check(nonUtf8.ok === false && nonUtf8.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' && /call aura_basetools_write/.test(String(nonUtf8.error)), 'B29 非 UTF-8 覆写给可执行拒绝（点名 aura_basetools_write）', JSON.stringify(nonUtf8).slice(0, 200))
  check(fs.readFileSync(file('latin1.txt')).equals(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])), 'B30 非 UTF-8 拒绝时磁盘逐字节没变')

  fs.writeFileSync(file('stale-force.txt'), 'v1\n')
  prime('stale-force.txt')
  fs.writeFileSync(file('stale-force.txt'), 'v2\n')
  const forced = json(run(['basetools', 'write', '--file', 'stale-force.txt', '--content', 'v3\n', '--allow-unobserved']))
  check(forced.ok === true && fs.readFileSync(file('stale-force.txt'), 'utf8') === 'v3\n', 'B31 allow_unobserved 也能越过“读过之后又变了”的区域闸', JSON.stringify(forced).slice(0, 180))
  check(forced.result?.unverified_region === true, 'B32 强制覆写如实标 unverified_region', JSON.stringify(forced.result))
}

// ── C MCP ────────────────────────────────────────────────────────────────
say('C MCP：aura_basetools_write 声明面与调用面')
{
  fs.writeFileSync(file('mcp-blind.txt'), 'original\n')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_basetools_write', arguments: { file_path: file('mcp-created.txt'), content: 'mcp\ncreate\n' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aura_basetools_write', arguments: { file_path: file('mcp-new.txt'), content: 'mcp\ncreate\n' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'aura_basetools_write', arguments: { file_path: file('mcp-new.txt'), content: 'mcp\noverwrite\n' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'aura_basetools_write', arguments: { file_path: file('mcp-new.txt'), content: 'blocked\n', no_overwrite: true } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aura_basetools_write', arguments: { file_path: file('mcp-new.txt'), content: 'preview\n', dry_run: true } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'aura_basetools_write', arguments: { file_path: file('mcp-bad.txt') } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'aura_basetools_write', arguments: { file_path: file('mcp-blind.txt'), content: 'blind\n' } } },
    { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'aura_basetools_write', arguments: { file_path: file('mcp-blind.txt'), content: 'blind\n', allow_unobserved: true } } },
  ]
  const res = spawnSync(process.execPath, [mcpBin], {
    input: `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    encoding: 'utf8',
    env,
  })
  const replies = String(res.stdout).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(replies.map((reply) => [reply.id, reply]))
  const envOf = (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}')

  const tools = byId.get(2)?.result?.tools ?? []
  const writeTool = tools.find((tool) => tool.name === 'aura_basetools_write')
  check(tools.length === 3 && writeTool !== undefined, `C1 tools/list 三个工具且含 aura_basetools_write（${tools.map((tool) => tool.name).join(',')}）`)
  check(JSON.stringify(writeTool?.inputSchema?.required) === JSON.stringify(['file_path', 'content']), 'C2 aura_basetools_write schema 必填 file_path + content', JSON.stringify(writeTool?.inputSchema?.required))
  check(envOf(3).ok === true && envOf(3).result?.operation === 'create', 'C3 经 MCP 新建成功', JSON.stringify(envOf(3)).slice(0, 160))
  check(fs.readFileSync(file('mcp-created.txt'), 'utf8') === 'mcp\ncreate\n', 'C4 MCP 新建的内容真的落盘')
  check(envOf(5).ok === true && envOf(5).result?.operation === 'write', 'C5 经 MCP 覆写成功', JSON.stringify(envOf(5)).slice(0, 160))
  check(fs.readFileSync(file('mcp-new.txt'), 'utf8') === 'mcp\noverwrite\n', 'C6 MCP 覆写整份替换')
  check(envOf(6).ok === false && envOf(6).code === 'WRITE_EXISTS', 'C7 MCP no_overwrite ⇒ WRITE_EXISTS', JSON.stringify(envOf(6)).slice(0, 160))
  check(envOf(7).ok === true && envOf(7).result?.dryRun === true && fs.readFileSync(file('mcp-new.txt'), 'utf8') === 'mcp\noverwrite\n', 'C8 MCP dry_run 不落盘')
  check(envOf(8).ok === false && envOf(8).code === 'WRITE_BAD_ARGS', 'C9 MCP 缺 content ⇒ WRITE_BAD_ARGS（回包而不是挂死）', JSON.stringify(envOf(8)).slice(0, 160))
  check(envOf(9).ok === false && envOf(9).code === 'PATCH_UNOBSERVED', 'C10 MCP 盲写覆写 ⇒ PATCH_UNOBSERVED', JSON.stringify(envOf(9)).slice(0, 160))
  check(envOf(10).ok === true && envOf(10).result?.unverified_region === true, 'C11 MCP allow_unobserved 放行且如实标注', JSON.stringify(envOf(10)).slice(0, 160))
  const eolSchema = writeTool?.inputSchema?.properties?.eol
  check(JSON.stringify(eolSchema?.enum) === JSON.stringify(['auto', 'preserve', 'lf', 'crlf']), 'C12 MCP 声明 eol 四种模式', JSON.stringify(eolSchema))
}

// ── D 能力清单 ────────────────────────────────────────────────────────────
say('D 能力清单：write 在命令表与工具表里')
{
  const caps = json(run(['basetools', 'capabilities']))
  const writeTool = caps.tools?.find((tool) => tool.name === 'aura_basetools_write')
  check(caps.ok === true && caps.commands?.includes('basetools write'), 'D1 commands 含 write', JSON.stringify(caps.commands))
  check(JSON.stringify(writeTool?.operations) === JSON.stringify(['create', 'overwrite']), 'D2 tools 含 aura_basetools_write{create,overwrite}', JSON.stringify(writeTool))
}

// ── E provider 级：整份替换只读一次 ───────────────────────────────────────
say('E provider：整份替换的区间来自同一次读（无 TOCTOU 尾巴）')
{
  let current = 'a\nb\nc\nd\n'
  let reads = 0
  let readsAtWrite = null
  const provider = {
    resolve: (p) => p,
    stat: () => ({ version: 'v1', size: current.length, type: 'file' }),
    async readText() {
      reads += 1
      return current
    },
    async readByteRange(_target, range) {
      const bytes = Buffer.from(current, 'utf8')
      return new Uint8Array(bytes.subarray(range.offset ?? 0, (range.offset ?? 0) + (range.length ?? 0)))
    },
    async writeText(_target, content) {
      readsAtWrite = reads
      current = content
      return { version: 'v2' }
    },
  }
  const env = await writeEnvelope(provider, { file: 'race.txt', content: 'X\n', allowUnobserved: true })
  check(env.ok === true && current === 'X\n', 'E1 允许盲写时整份替换真的清掉旧尾巴', JSON.stringify({ env, current }))
  check(readsAtWrite === 1, 'E2 写之前只读一次（区间与规划同源，不是先读一遍算行数）', String(readsAtWrite))
}

// ── F 多目标预演：不能声称“已创建/已落盘” ────────────────────────────────
say('F 多目标：create + dry-run 的汇总与逐项都必须是预演')
{
  const env = json(run([
    'basetools', 'edit', '--targets', JSON.stringify([{ file_path: file('mt-dry-create.txt'), create: 'hello\n' }]), '--dry-run',
  ]))
  check(env.ok === true && env.dryRun === true && env.unchanged === true, 'F1 整批回执 dryRun=true、unchanged=true', JSON.stringify(env).slice(0, 180))
  check(env.edits?.[0]?.outcome === 'dry_run' && env.edits[0].landed === false, 'F2 逐项 outcome=dry_run、landed=false', JSON.stringify(env.edits?.[0]).slice(0, 180))
  check(Array.isArray(env.landed_paths) && env.landed_paths.length === 0, 'F3 landed_paths 为空（没有文件被写）', JSON.stringify(env.landed_paths))
  check(/dry_run 1/.test(env.summary) && /no files were changed/.test(env.summary), 'F4 汇总行写 dry_run 且明确 no files were changed', env.summary)
  check(fs.existsSync(file('mt-dry-create.txt')) === false, 'F5 文件确实不存在')
}

say(`\n--- 整文件写：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
