/**
 * replace-all-test.mjs —— 0.10.2：`replace_all`（对齐内置 Edit 的 replace_all）。
 *
 * 覆盖：
 *   A 引擎：同行/跨行全部出现、重叠出现取最左、多行原文、CRLF、删除、无命中、
 *     参数互斥、expect 逐处核对、norm-space 回退、单处路径不回归
 *   B CLI：平铺旗标 / JSON hunk / dry-run / 参数互斥拒绝
 *   C MCP：声明面（boolean）与调用面
 *   D 陈旧闸门：读取后出现次数变了 ⇒ 拒绝且磁盘不动；只改无关行 ⇒ 放行；有过观测 ⇒ 不标 unverified
 *
 * 运行：node src/locator-lab/replace-all-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { planHunks } from './write-path.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..')
const bin = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const mcpBin = path.join(pkgRoot, 'src', 'aura-standalone', 'bin', 'aura-mcp.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-replace-all-'))
const cache = path.join(tmp, 'cache')
const env = { ...process.env, AURA_CACHE_DIR: cache }
const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env })
const json = (res) => {
  try {
    return JSON.parse(String(res.stdout).trim().split('\n').pop())
  } catch {
    return { ok: false, error: `stdout 不是 JSON：${JSON.stringify(res.stdout)} ${String(res.stderr ?? '').trim().split('\n').slice(0, 3).join(' / ')}` }
  }
}
const file = (name) => path.join(tmp, name)
const put = (name, text) => {
  fs.writeFileSync(file(name), text)
  return file(name)
}
const plan = (source, hunk) => planHunks(source, [hunk], 't.js')
process.on('exit', () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 清不掉不影响判据 */
  }
})

// ── A 引擎 ────────────────────────────────────────────────────────────────
say('A 引擎：全部非重叠出现')
{
  const sameLine = plan('foo bar foo\n', { old: 'foo', replace: 'X', replace_all: true })
  check(sameLine.content === 'X bar X\n' && sameLine.applied.length === 2, 'A1 同一行两处都改，回执逐处给', JSON.stringify({ content: sameLine.content, n: sameLine.applied.length }))
  check(sameLine.applied.every((a) => a.tier.startsWith('old-all~fragment') && a.line === 1 && a.delta === 0), 'A2 tier=old-all~fragment，改前/改后坐标与 delta 正确', JSON.stringify(sameLine.applied.map((a) => ({ line: a.line, afterLine: a.afterLine, tier: a.tier.slice(0, 20) }))))

  const lines = plan('foo\nbar\nfoo\n', { old: 'foo', replace: 'X', replace_all: true })
  check(lines.content === 'X\nbar\nX\n' && lines.applied.length === 2 && lines.applied[1].line === 3, 'A3 跨行两处都改，行号正确', JSON.stringify(lines.applied.map((a) => a.line)))

  const overlap = plan('aaaa\n', { old: 'aa', replace: 'X', replace_all: true })
  check(overlap.content === 'XX\n' && overlap.applied.length === 2, 'A4 重叠出现只取最左两处（从左到右、不回头）', JSON.stringify({ content: overlap.content, n: overlap.applied.length }))

  const multi = plan('a\nb\na\nb\n', { old: 'a\nb', replace: 'X', replace_all: true })
  check(multi.content === 'X\nX\n' && multi.applied.length === 2, 'A5 多行原文的两处都改', JSON.stringify({ content: multi.content, n: multi.applied.length }))

  const crlf = plan('foo\r\nbar\r\nfoo\r\n', { old: 'foo', replace: 'X', replace_all: true })
  check(crlf.content === 'X\r\nbar\r\nX\r\n' && crlf.applied.length === 2, 'A6 CRLF 保持（只换匹配段，不引入 LF）', JSON.stringify(crlf.content))

  const deleted = plan('foo\nfoo\n', { old: 'foo', replace: '', replace_all: true })
  check(deleted.content === '\n\n' && deleted.applied.length === 2, 'A7 replace 为空 ⇒ 删除全部匹配段（行尾保留）', JSON.stringify(deleted.content))

  const single = plan('foo\nbar\n', { old: 'foo', replace: 'X', replace_all: true })
  check(single.content === 'X\nbar\n' && single.applied.length === 1, 'A8 只有一处时与普通 old 同形', JSON.stringify(single.content))

  let notFound = null
  try {
    plan('foo\n', { old: 'missing', replace: 'X', replace_all: true })
  } catch (error) {
    notFound = error
  }
  check(notFound?.code === 'PATCH_NOT_FOUND', 'A9 一处都没有 ⇒ PATCH_NOT_FOUND', String(notFound?.code))

  const conflicts = [
    { old: 'foo', replace: 'X', replace_all: true, context: 'foo' },
    { old: 'foo', replace: 'X', replace_all: true, lines: [1, 1] },
    { old: 'foo', replace: 'X', replace_all: true, target: 'foo' },
    { old: 'foo', replace: 'X', replace_all: true, near: 1 },
    { old: 'foo', replace: 'X', replace_all: true, handle: 'h1a2b3c4d5e6:1-1' },

  ]
  const codes = conflicts.map((hunk) => {
    try {
      plan('foo foo\n', hunk)
      return 'NO_ERROR'
    } catch (error) {
      return error.code
    }
  })
  check(codes.every((code) => code === 'PATCH_REPLACE_ALL_CONFLICT'), 'A10 与收敛到一处的地址/修饰混用 ⇒ 全部拒绝', codes.join(','))

  let noOld = null
  try {
    plan('foo\n', { replace: 'X', replace_all: true })
  } catch (error) {
    noOld = error
  }
  check(noOld?.code === 'PATCH_REPLACE_ALL_CONFLICT' && /needs `old`/.test(noOld.message), 'A11 没有 old ⇒ 参数面拒绝', String(noOld?.code))

  let badType = null
  try {
    plan('foo\n', { old: 'foo', replace: 'X', replace_all: 'yes' })
  } catch (error) {
    badType = error
  }
  check(badType?.code === 'PATCH_REPLACE_ALL_CONFLICT', 'A12 replace_all 不是布尔 ⇒ 拒绝', String(badType?.code))

  const expectOk = plan('foo\nfoo\n', { old: 'foo', replace: 'X', replace_all: true, expect: 'foo' })
  check(expectOk.applied.length === 2 && expectOk.content === 'X\nX\n', 'A13 expect 对每一处都成立 ⇒ 放行')
  let expectBad = null
  try {
    plan('foo\nfoo\n', { old: 'foo', replace: 'X', replace_all: true, expect: 'bar' })
  } catch (error) {
    expectBad = error
  }
  check(expectBad?.code === 'PATCH_EXPECT_MISMATCH', 'A14 任一处 expect 不符 ⇒ 整批拒绝', String(expectBad?.code))

  const normalized = plan('  beta   gamma\n', { old: 'beta gamma', replace: 'X', replace_all: true })
  check(normalized.content === '  X\n' && normalized.applied[0]?.tier.includes('norm-space'), 'A15 没有逐字命中时回退 norm-space（保留行首空白）', JSON.stringify({ content: normalized.content, tier: normalized.applied[0]?.tier?.slice(0, 40) }))

  /**
   * A16 是 0.10.2 顺带修掉的引擎缺陷：片段末列计算曾无条件吞掉“与末字相同的后续字符”，
   * 于是 `old:"a"` 在 `aa` 上会被当成一整段 `aa`。`replace_all` 用它证明每一处都只换自己那一个字符。
   */
  const oneChar = plan('aa\n', { old: 'a', replace: 'X', replace_all: true })
  check(oneChar.content === 'XX\n' && oneChar.applied.length === 2 && oneChar.applied.every((a) => a.actual === 'a'), 'A16 替换段只到命中字符本身（末列不再吞同字）', JSON.stringify({ content: oneChar.content, actual: oneChar.applied.map((a) => a.actual) }))

  // 0.10.5 评审：多行 old 中间的空白行曾被 filter 丢掉，actual/expect 随之错位
  const blank = plan('a\n\nb\n', { old: 'a\n\nb', replace: 'X', replace_all: true, expect: 'a\n\nb' })
  check(blank.content === 'X\n' && blank.applied[0]?.actual === 'a\n\nb', 'A17 多行 old 中间的空白行保留在 actual 里（expect 能对上）', JSON.stringify({ content: blank.content, actual: blank.applied[0]?.actual }))

  // 0.10.5 评审：exact 片段以空格结尾时不再多吃后续空白
  const spaced = plan('x ax  y\n', { old: 'ax ', replace: 'Z', replace_all: true })
  check(spaced.content === 'x Z y\n' && spaced.applied[0]?.actual === 'ax ', 'A18 old 以空格结尾时只替换那一个空格', JSON.stringify({ content: spaced.content, actual: spaced.applied[0]?.actual }))

  // 0.10.5 评审：old 带尾换行会退化成全文子串搜索，必须拒绝
  let trailingNewline = null
  try {
    plan('a\nbanana\n', { old: 'a\n', replace: 'X', replace_all: true })
  } catch (error) {
    trailingNewline = error
  }
  check(trailingNewline?.code === 'PATCH_REPLACE_ALL_CONFLICT' && /newline/.test(trailingNewline.message), 'A19 old 带首/尾换行 ⇒ 拒绝（不退化成全文子串搜索）', String(trailingNewline?.code))
}

// ── B CLI ────────────────────────────────────────────────────────────────
say('B CLI：平铺旗标 / JSON / dry-run / 互斥')
{
  put('cli.txt', 'foo foo\nbar foo\n')
  const flat = json(run(['basetools', 'edit', '--file', 'cli.txt', '--old', 'foo', '--replace', 'X', '--replace-all']))
  check(flat.ok === true && flat.result?.applied?.length === 3, 'B1 平铺 --old/--replace/--replace-all 生效（3 处）', JSON.stringify(flat).slice(0, 180))
  check(fs.readFileSync(file('cli.txt'), 'utf8') === 'X X\nbar X\n', 'B2 平铺路径逐字落盘', JSON.stringify(fs.readFileSync(file('cli.txt'), 'utf8')))

  put('json.txt', 'foo foo\n')
  const jsonHunk = json(run(['basetools', 'edit', '--file', 'json.txt', '--hunks', JSON.stringify([{ old: 'foo', replace: 'Y', replace_all: true }])]))
  check(jsonHunk.ok === true && fs.readFileSync(file('json.txt'), 'utf8') === 'Y Y\n', 'B3 JSON hunk 路径同样生效', JSON.stringify(jsonHunk).slice(0, 160))

  put('dry.txt', 'foo foo\n')
  const dry = json(run(['basetools', 'edit', '--file', 'dry.txt', '--old', 'foo', '--replace', 'X', '--replace-all', '--dry-run']))
  check(dry.ok === true && dry.result?.dryRun === true && dry.result.applied.length === 2, 'B4 dry-run 逐处给出落点，不落盘', JSON.stringify(dry.result?.applied?.length))
  check(fs.readFileSync(file('dry.txt'), 'utf8') === 'foo foo\n', 'B5 dry-run 之后磁盘没变')

  put('conflict.txt', 'foo foo\n')
  const conflict = json(run(['basetools', 'edit', '--file', 'conflict.txt', '--old', 'foo', '--replace', 'X', '--replace-all', '--lines', '1,1']))
  check(conflict.ok === false && conflict.code === 'PATCH_REPLACE_ALL_CONFLICT', 'B6 平铺同时给 --lines ⇒ 拒绝', JSON.stringify(conflict).slice(0, 160))
  check(fs.readFileSync(file('conflict.txt'), 'utf8') === 'foo foo\n', 'B7 被拒绝时磁盘没变')
}

// ── C MCP ────────────────────────────────────────────────────────────────
say('C MCP：声明面与调用面')
{
  put('mcp.txt', 'foo foo\n')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: file('mcp.txt'), hunks: [{ old: 'foo', replace: 'Z', replace_all: true }] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: file('mcp.txt'), hunks: [{ old: 'Z', replace: 'Q', replace_all: true, lines: [1, 1] }] } } },
  ]
  const res = spawnSync(process.execPath, [mcpBin], { input: `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`, encoding: 'utf8', env })
  const replies = String(res.stdout).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(replies.map((reply) => [reply.id, reply]))
  const envOf = (id) => JSON.parse(byId.get(id)?.result?.content?.[0]?.text ?? '{}')
  const editTool = byId.get(2)?.result?.tools?.find((tool) => tool.name === 'aura_basetools_edit')
  const schema = editTool?.inputSchema?.properties?.hunks?.items?.properties?.replace_all
  check(schema?.type === 'boolean', 'C1 MCP hunk schema 声明 replace_all: boolean', JSON.stringify(schema))
  check(envOf(3).ok === true && envOf(3).result?.applied?.length === 2, 'C2 经 MCP 调用 replace_all 成功（2 处）', JSON.stringify(envOf(3)).slice(0, 180))
  check(fs.readFileSync(file('mcp.txt'), 'utf8') === 'Z Z\n', 'C3 MCP 路径真的落盘')
  check(envOf(4).ok === false && envOf(4).code === 'PATCH_REPLACE_ALL_CONFLICT', 'C4 经 MCP 的互斥拒绝走结构化回执', JSON.stringify(envOf(4)).slice(0, 160))
}

// ── D 陈旧闸门 ────────────────────────────────────────────────────────────
say('D 陈旧闸门：出现次数变了就拒，无关行变化放行')
{
  put('stale-add.txt', 'foo\nfoo\n')
  json(run(['basetools', 'read', '--file', 'stale-add.txt', '--mode', 'full']))
  fs.appendFileSync(file('stale-add.txt'), 'foo\n')
  const before = fs.readFileSync(file('stale-add.txt'))
  const stale = json(run(['basetools', 'edit', '--file', 'stale-add.txt', '--old', 'foo', '--replace', 'X', '--replace-all']))
  check(stale.ok === false && stale.code === 'PATCH_STALE_REGION', 'D1 读取后多出一处 ⇒ PATCH_STALE_REGION', JSON.stringify(stale).slice(0, 180))
  check(stale.occurrence_count?.was === 2 && stale.occurrence_count?.now === 3, 'D2 回执给出前后出现次数（was=2, now=3）', JSON.stringify(stale.occurrence_count))
  check(fs.readFileSync(file('stale-add.txt')).equals(before), 'D3 拒绝时磁盘逐字节没变')

  put('stale-unrelated.txt', 'foo\nfoo\nbar\n')
  json(run(['basetools', 'read', '--file', 'stale-unrelated.txt', '--mode', 'full']))
  fs.writeFileSync(file('stale-unrelated.txt'), 'foo\nfoo\nbaz\n')
  const unrelated = json(run(['basetools', 'edit', '--file', 'stale-unrelated.txt', '--old', 'foo', '--replace', 'X', '--replace-all']))
  check(unrelated.ok === true && fs.readFileSync(file('stale-unrelated.txt'), 'utf8') === 'X\nX\nbaz\n', 'D4 出现次数没变、只改了无关行 ⇒ 放行（内容地址吸收位移）', JSON.stringify(unrelated).slice(0, 160))
  check(unrelated.result?.unverified_region === true, 'D5 放行但如实标 unverified_region（当前修订没被这次会话读过）', JSON.stringify(unrelated.result?.unverified_region))

  put('stale-remove.txt', 'foo\nfoo\n')
  json(run(['basetools', 'read', '--file', 'stale-remove.txt', '--mode', 'full']))
  fs.writeFileSync(file('stale-remove.txt'), 'foo\nqux\n')
  const removed = json(run(['basetools', 'edit', '--file', 'stale-remove.txt', '--old', 'foo', '--replace', 'X', '--replace-all']))
  check(removed.ok === false && removed.code === 'PATCH_STALE_REGION' && removed.occurrence_count?.now === 1, 'D6 少了一处也拒（不会静默少改）', JSON.stringify(removed).slice(0, 180))
}

say(`\n--- replace_all：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
