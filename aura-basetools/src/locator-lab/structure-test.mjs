/**
 * structure-test —— 结构地址与结构句柄（0.23）。
 *
 * 判据：
 *   ① 按 `symbol:` / `section:` / `key:` 定位，能改到正确的结构节点；
 *   ② **整段正文被外部改写**后，结构地址与结构句柄仍然指得到（行号地址做不到，这正是它存在的理由）；
 *   ③ 歧义 / 找不到 ⇒ 明确拒绝，零写入；
 *   ④ 结构句柄是 **opt-in** 的（`read --structure-handle`），不请求时回执形状不变；
 *   ⑤ 跨文件用结构句柄 ⇒ 身份不符拒绝。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-structure-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (line = '') => console.log(line)
const run = (args) => {
  const res = spawnSync(process.execPath, [bin, 'basetools', ...args], { cwd: tmp, encoding: 'utf8', env, timeout: 60000 })
  try {
    return JSON.parse(String(res.stdout ?? '').trim())
  } catch {
    return null
  }
}
const file = (name, content) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, content)
  return p
}
const disk = (p) => fs.readFileSync(p, 'utf8')
const code = (r) => r?.code ?? r?.result?.code ?? null

const CODE = 'export function beta() {\n  return 1\n}\n\nexport function gamma() {\n  return 2\n}\n'
const CODE_REWRITTEN = 'export function beta() {\n  return 99 // external\n}\n\nexport function gamma() {\n  return 2\n}\n'

// ── 1. 符号地址 ────────────────────────────────────────────────────────────
say('=== 1. symbol ===')
{
  const p = file('a.mjs', CODE)
  const r = run(['edit', '--file', p, '--structure', 'symbol:beta', '--replace', 'export function beta() {\n  return 42\n}', '--pretty'])
  check(r?.ok === true, 'S1 按符号名改整个函数', JSON.stringify({ ok: r?.ok, code: code(r) }))
  check(disk(p).includes('return 42') && disk(p).includes('return 2'), 'S2 只改了 beta，gamma 未动')

  fs.writeFileSync(p, CODE_REWRITTEN)
  const r2 = run(['edit', '--file', p, '--structure', 'symbol:beta', '--replace', 'export function beta() {\n  return 7\n}', '--pretty'])
  check(r2?.ok === true, 'S3 整段正文被改写后，按符号名仍改得到', JSON.stringify({ ok: r2?.ok, code: code(r2) }))
  check(disk(p).includes('return 7') && disk(p).includes('return 2'), 'S4 落点正确（gamma 未动）')

  const missing = run(['edit', '--file', p, '--structure', 'symbol:nope', '--replace', 'x', '--pretty'])
  check(missing?.ok === false && code(missing) === 'PATCH_STRUCTURE_NOT_FOUND', 'S5 符号不存在 ⇒ PATCH_STRUCTURE_NOT_FOUND')
}

// ── 2. 歧义符号 ────────────────────────────────────────────────────────────
say('')
say('=== 2. 歧义 ===')
{
  const p = file('b.mjs', 'export function dup() {\n  return 1\n}\n\nexport function dup() {\n  return 2\n}\n')
  const r = run(['edit', '--file', p, '--structure', 'symbol:dup', '--replace', 'x', '--pretty'])
  check(r?.ok === false && code(r) === 'PATCH_STRUCTURE_AMBIGUOUS', 'S6 两个同名符号 ⇒ PATCH_STRUCTURE_AMBIGUOUS', JSON.stringify({ code: code(r) }))
  check(disk(p).includes('return 1'), 'S7 拒绝时磁盘未动')
}

// ── 3. 节 ──────────────────────────────────────────────────────────────────
say('')
say('=== 3. section ===')
{
  const p = file('c.md', '# A\ntext A\n\n# B\ntext B\n')
  const r = run(['edit', '--file', p, '--structure', 'section:A', '--replace', '# A\nnew A', '--pretty'])
  check(r?.ok === true, 'S8 按节标题改', JSON.stringify({ ok: r?.ok, code: code(r) }))
  check(disk(p) === '# A\nnew A\n\n# B\ntext B\n', 'S9 只改 A 节，B 节未动', JSON.stringify(disk(p)))
}

// ── 4. 键 ──────────────────────────────────────────────────────────────────
say('')
say('=== 4. key ===')
{
  const p = file('d.json', '{\n  "db": {\n    "host": "x"\n  }\n}\n')
  const r = run(['edit', '--file', p, '--structure', 'key:host', '--replace', '    "host": "y"', '--pretty'])
  check(r?.ok === true, 'S10 按 JSON 键路径改', JSON.stringify({ ok: r?.ok, code: code(r) }))
  check(JSON.parse(disk(p)).db.host === 'y', 'S11 落盘后 JSON 合法且值已改')
}

// ── 5. 结构句柄（opt-in） ──────────────────────────────────────────────────
say('')
say('=== 5. structure_handle ===')
{
  const p = file('e.mjs', CODE)
  const plain = run(['read', '--file', p, '--lines', '1,3', '--pretty'])
  check(plain?.structure_handle === undefined, 'S12 不请求时没有 structure_handle（回执形状不变）')

  const read = run(['read', '--file', p, '--lines', '1,3', '--structure-handle', '--pretty'])
  const handle = read?.structure_handle
  check(typeof handle === 'string' && /^s[0-9a-f]{4}[0-9a-f]{8}:symbol=beta$/.test(handle), 'S13 恰好覆盖符号的窗口发行结构句柄', JSON.stringify(handle))

  fs.writeFileSync(p, CODE_REWRITTEN)
  const r = run(['edit', '--file', p, '--handle', handle, '--replace', 'export function beta() {\n  return 5\n}', '--pretty'])
  check(r?.ok === true, 'S14 正文改写后，结构句柄仍指得到', JSON.stringify({ ok: r?.ok, code: code(r) }))
  check(disk(p).includes('return 5'), 'S15 落点正确')

  // 跨文件：同一个 s 句柄用到另一份文件上 ⇒ 身份不符
  const other = file('f.mjs', CODE)
  const bad = run(['edit', '--file', other, '--handle', handle, '--replace', 'x', '--pretty'])
  check(bad?.ok === false && code(bad) === 'PATCH_HANDLE_IDENTITY_MISMATCH', 'S16 跨文件用结构句柄 ⇒ 身份不符', JSON.stringify({ code: code(bad) }))
}

say('')
say(`--- ${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
