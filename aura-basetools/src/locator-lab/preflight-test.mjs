/**
 * preflight-test —— 写前预检 / 写后结构状态的契约（0.22）。
 *
 * 判据的三件事：
 *   ① 能判的坏结果**不落盘**：JSON 解析失败、Markdown 围栏不配平、替换引入 lone CR、
 *      未读过的文件一次删掉 ≥30 行且 ≥30%；
 *   ② 合法编辑**一条都不误拒**（对照组）；
 *   ③ `write`（整份替换）是**显式逃生口**：同样的坏结构不拦，但回执要带
 *      `preflight_warnings` 与写后的 `structure: broken`——拒绝报文里建议的那条路必须真的走得通。
 *
 * 跑法：node src/locator-lab/preflight-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { encodeText } from '../aura-standalone/lib/encoding.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.resolve(here, '..', '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-preflight-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (line = '') => console.log(line)
const run = (args, extraEnv = {}) => {
  const res = spawnSync(process.execPath, [bin, 'basetools', ...args, '--pretty'], { cwd: tmp, encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 60000 })
  let body = null
  try {
    body = JSON.parse(String(res.stdout ?? '').trim())
  } catch {
    body = null
  }
  return { status: res.status, body }
}
const ok = (r) => r.body?.ok === true
const codeOf = (r) => r.body?.code ?? r.body?.result?.code ?? null
const file = (name, content) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, content)
  return p
}
const disk = (p) => fs.readFileSync(p, 'utf8')

// ── A. JSON：结构被改坏 ⇒ 拒绝；合法编辑 ⇒ 放行 ─────────────────────────────
say('=== A. JSON ===')
{
  const p = file('a.json', '{\n  "a": 1,\n  "b": 2\n}\n')
  const bad = run(['edit', '--file', p, '--lines', '4', '--replace', ''])
  check(ok(bad) === false && codeOf(bad) === 'PATCH_STRUCTURE_BROKEN', 'A1 删掉闭合括号 ⇒ PATCH_STRUCTURE_BROKEN', JSON.stringify(bad.body).slice(0, 120))
  check(disk(p) === '{\n  "a": 1,\n  "b": 2\n}\n', 'A2 拒绝时磁盘逐字节未动')

  const dry = run(['edit', '--file', p, '--lines', '4', '--replace', '', '--dry-run'])
  check(ok(dry) === false && codeOf(dry) === 'PATCH_STRUCTURE_BROKEN', 'A3 dry-run 预演出同一个判决（不是“没事”）')

  const good = run(['edit', '--file', p, '--lines', '2', '--replace', '  "a": 10,'])
  check(ok(good) === true, 'A4 合法编辑放行', JSON.stringify(good.body).slice(0, 120))
  check(JSON.parse(disk(p)).a === 10, 'A5 落盘后 JSON 合法且值已改')

  // 写后结构状态：只在坏的时候出现；合法编辑的回执里没有 structure 字段
  check(good.body?.result?.structure === undefined, 'A6 合法编辑的回执不带 structure（既有回执形状不变）')

  // write 是逃生口：结构坏也照写，但回执要如实说
  const p2 = file('b.json', '{\n  "a": 1\n}\n')
  run(['read', '--file', p2, '--mode', 'full'])
  const w = run(['write', '--file', p2, '--content', '{"a": 1'])
  check(ok(w) === true, 'A7 write 整份替换不被结构预检拦住（显式逃生口）', JSON.stringify(w.body).slice(0, 140))
  check(w.body?.result?.structure?.ok === false && w.body?.result?.structure?.kind === 'json', 'A8 write 回执带 structure: broken')
  check(Array.isArray(w.body?.result?.preflight_warnings) && w.body.result.preflight_warnings.some((x) => x.code === 'PATCH_STRUCTURE_BROKEN'), 'A9 write 回执带 preflight_warnings')
}

// ── B. Markdown：围栏 ───────────────────────────────────────────────────────
say('')
say('=== B. Markdown 围栏 ===')
{
  const p = file('a.md', '# A\n\ntext\n')
  const bad = run(['edit', '--file', p, '--lines', '3', '--replace', 'text\n```\ncode'])
  check(ok(bad) === false && codeOf(bad) === 'PATCH_STRUCTURE_BROKEN', 'B1 引入未闭合围栏 ⇒ 拒绝', JSON.stringify(bad.body).slice(0, 120))
  check(disk(p) === '# A\n\ntext\n', 'B2 拒绝时磁盘未动')
  const good = run(['edit', '--file', p, '--lines', '3', '--replace', 'text\n```\ncode\n```'])
  check(ok(good) === true, 'B3 配平的围栏编辑放行')
  check(disk(p).includes('```\ncode\n```'), 'B4 围栏落盘正确')
}

// ── C. lone CR ─────────────────────────────────────────────────────────────
say('')
say('=== C. 孤立 CR ===')
{
  const p = file('c.txt', 'alpha\nbravo\n')
  const bad = run(['edit', '--file', p, '--lines', '1', '--replace', 'A\rB'])
  check(ok(bad) === false && codeOf(bad) === 'PATCH_LONE_CR', 'C1 替换引入 lone CR ⇒ 拒绝', JSON.stringify(bad.body).slice(0, 120))
  check(disk(p) === 'alpha\nbravo\n', 'C2 拒绝时磁盘未动')
  const good = run(['edit', '--file', p, '--lines', '1', '--replace', 'A\nB'])
  check(ok(good) === true && !disk(p).includes('\r'), 'C3 用 \\n 的等价编辑放行')
}

// ── D. 大段删除 + 未观察 ────────────────────────────────────────────────────
say('')
say('=== D. 大段删除只在“没读过”时拦 ===')
{
  const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const blind = file('d1.txt', body)
  const bad = run(['edit', '--file', blind, '--lines', '1,90', '--replace', ''])
  check(ok(bad) === false && codeOf(bad) === 'PATCH_DESTRUCTIVE_UNOBSERVED', 'D1 未读过的文件删 90 行 ⇒ 拒绝', JSON.stringify(bad.body).slice(0, 140))
  check(disk(blind) === body, 'D2 拒绝时磁盘未动')

  const seen = file('d2.txt', body)
  run(['read', '--file', seen, '--mode', 'full'])
  const good = run(['edit', '--file', seen, '--lines', '1,90', '--replace', ''])
  check(ok(good) === true, 'D3 读过之后同样的删除放行', JSON.stringify(good.body).slice(0, 120))

  const small = file('d3.txt', body)
  const smallEdit = run(['edit', '--file', small, '--lines', '1,10', '--replace', ''])
  check(ok(smallEdit) === true, 'D4 未读过但只删 10 行（低于阈值）⇒ 不误拒')
}

// ── E. 对照组：普通编辑一条都不误拒 ─────────────────────────────────────────
say('')
say('=== E. 对照组 ===')
{
  const p1 = file('e1.txt', 'alpha\nbravo\n')
  check(ok(run(['edit', '--file', p1, '--old', 'bravo', '--replace', 'BRAVO'])), 'E1 old + replace')
  const p2 = file('e2.txt', 'a\nb\nc\nd\n')
  const hunks = JSON.stringify([{ lines: [1, 1], expect: 'a', replace: 'A' }, { lines: [3, 3], expect: 'c', replace: 'C' }])
  check(ok(run(['edit', '--file', p2, '--hunks', hunks])), 'E2 两个不重叠 hunk')
  const p3 = file('e3.mjs', 'export function beta() {\n  return 1\n}\n')
  check(ok(run(['edit', '--file', p3, '--target', 'beta', '--replace', 'export function beta() {\n  return 2\n}'])), 'E3 target 按符号改')
  const p4 = file('e4.json', '{\n  "a": 1,\n  "b": 2\n}\n')
  check(ok(run(['edit', '--file', p4, '--lines', '2', '--replace', '  "a": 2,'])), 'E4 JSON 合法编辑')
  const p5 = file('e5.md', '# A\n\ntext\n')
  check(ok(run(['edit', '--file', p5, '--lines', '3', '--replace', 'more text'])), 'E5 Markdown 正文编辑')
}

// ── F. diagnose：只读体检 ────────────────────────────────────────────────
say('')
say('=== F. diagnose ===')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-diag-'))
  const gbkPath = path.join(dir, 'g.txt')
  fs.writeFileSync(gbkPath, encodeText('中文测试\r\n第二行\r\n', { encoding: 'gb18030', bom: [] }))
  const d1 = run(['diagnose', '--file', gbkPath])
  check(ok(d1) === true && d1.body.encoding === 'gb18030', 'F1 GBK 文件：diagnose 报 gb18030', JSON.stringify(d1.body).slice(0, 120))

  const mixed = path.join(dir, 'm.txt')
  fs.writeFileSync(mixed, 'a\r\nb\nc\r\n')
  const d2 = run(['diagnose', '--file', mixed])
  check(ok(d2) === true && Array.isArray(d2.body.warnings) && d2.body.warnings.some((w) => /mixed line endings/.test(w)), 'F2 混合行尾：diagnose 给提醒', JSON.stringify(d2.body.warnings))

  const badJson = path.join(dir, 'b.json')
  fs.writeFileSync(badJson, '{"a": 1')
  const d3 = run(['diagnose', '--file', badJson])
  check(ok(d3) === true && d3.body.structure?.ok === false, 'F3 坏 JSON：diagnose 报 structure.broken', JSON.stringify(d3.body.structure))

  const binPath = path.join(dir, 'x.dat')
  fs.writeFileSync(binPath, Buffer.from([0x61, 0x00, 0x62]))
  const d4 = run(['diagnose', '--file', binPath])
  check(ok(d4) === false && codeOf(d4) === 'FS_NOT_TEXT', 'F4 二进制：diagnose 明确报 FS_NOT_TEXT')
  fs.rmSync(dir, { recursive: true, force: true })
}

say('')
say(`--- ${pass} 通过 / ${fail} 失败 ---`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
