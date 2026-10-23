/**
 * single-line-target-test.mjs —— P0.2：符号地址落在共享行 / lone CR 时必须拒绝。
 *
 * 旧行为：压缩 JS 里两个顶层符号同为 1-1，`target=alpha` 落到整行，`beta` 一起消失；
 * 老式 Mac（lone CR）整份被当成一行，`target`/`lines` 会把整个文件替换成一个符号。
 * 这里钉住“拒绝 + 磁盘不变”，并确认 `old` 片段仍能安全地只改那一段。
 *
 * D/E 两组是同一条判据的剩余形状（推导自“整行区间必须恰好是这个声明”）：
 *   · 行内别的**非符号**内容（`import` / 指令 / 尾随调用 / 嵌套声明）同样会被整行替换删掉；
 *   · 多行声明头：起点是名字时，`export function` / C 的返回类型会被留成悬空前缀。
 *
 * 运行：node src/locator-lab/single-line-target-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { planHunks } from './write-path.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const bin = path.join(here, '..', 'aura-standalone', 'bin', 'aura.mjs')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (m) => console.log(`\n=== ${m} ===`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-single-line-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }
const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8', env })
const json = (res) => {
  try { return JSON.parse(String(res.stdout).trim().split('\n').pop()) } catch { return { ok: false, error: String(res.stdout) } }
}
const put = (name, text) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, text)
  return p
}
const codeOf = (fn) => {
  try { fn(); return 'NO_ERROR' } catch (error) { return error.code ?? 'ERROR' }
}
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清不掉不影响判据 */ }
})

const COMPRESSED = 'function alpha(){return 1}function beta(){return 2}\n'
const CR_ONLY = 'function alpha(){\r  return 1\r}\r'

say('A target 共享行')
{
  const p = put('min.js', COMPRESSED)
  const before = fs.readFileSync(p)
  const res = run(['basetools', 'edit', '--file', p, '--target', 'alpha', '--replace', 'x'])
  const env = json(res)
  check(res.status === 2 && env.code === 'LOCATOR_LINE_SHARED', 'A1 压缩 JS 的 target=alpha ⇒ LOCATOR_LINE_SHARED', JSON.stringify(env).slice(0, 220))
  check(fs.readFileSync(p).equals(before), 'A2 被拒后磁盘逐字节不变')
  check(env.candidates?.some((c) => c.name === 'beta'), 'A3 回执点名同行候选 beta', JSON.stringify(env.candidates))
  check(codeOf(() => planHunks(COMPRESSED, [{ target: 'alpha', replace: 'x' }], 'min.js')) === 'LOCATOR_LINE_SHARED', 'A4 引擎层同一判据（不是 CLI 自己拦）')

  const single = 'function alpha(){return 1}\n'
  const singlePlan = planHunks(single, [{ target: 'alpha', replace: 'function alpha(){return 9}' }], 'single.js')
  check(singlePlan.content === 'function alpha(){return 9}\n', 'A5 没有同行兄弟时 target 仍正常')
}

say('B lone CR')
{
  const p = put('cr.mjs', CR_ONLY)
  const before = fs.readFileSync(p)
  const target = json(run(['basetools', 'edit', '--file', p, '--target', 'alpha', '--replace', 'x']))
  check(target.code === 'LOCATOR_LONE_CR', 'B1 lone CR + target ⇒ LOCATOR_LONE_CR', JSON.stringify(target).slice(0, 220))
  const lines = json(run(['basetools', 'edit', '--file', p, '--lines', '1', '--replace', 'x']))
  check(lines.code === 'LOCATOR_LONE_CR', 'B2 lone CR + lines ⇒ LOCATOR_LONE_CR', JSON.stringify(lines).slice(0, 220))
  check(fs.readFileSync(p).equals(before), 'B3 两次拒绝后磁盘逐字节不变')
  check(codeOf(() => planHunks(CR_ONLY, [{ target: 'alpha', replace: 'x' }], 'cr.mjs')) === 'LOCATOR_LONE_CR', 'B4 引擎层 target 同一判据')
  check(codeOf(() => planHunks(CR_ONLY, [{ lines: [1, 1], replace: 'x' }], 'cr.mjs')) === 'LOCATOR_LONE_CR', 'B5 引擎层 lines 同一判据')

  const oldTarget = json(run(['basetools', 'edit', '--file', p, '--old', 'return 1', '--replace', 'return 9']))
  check(oldTarget.ok === true && fs.readFileSync(p, 'utf8') === 'function alpha(){\r  return 9\r}\r', 'B6 old 片段仍可安全修改 lone CR 文件', JSON.stringify(oldTarget).slice(0, 200))
}

say('C 压缩文件里的 old 片段')
{
  const p = put('min-old.js', COMPRESSED)
  const res = json(run(['basetools', 'edit', '--file', p, '--old', 'return 1', '--replace', 'return 9']))
  check(res.ok === true && fs.readFileSync(p, 'utf8') === 'function alpha(){return 9}function beta(){return 2}\n', 'C1 old 只改命中片段，beta 保留', JSON.stringify(res).slice(0, 200))
}

say('D 声明之外的行内内容（import / 指令 / 尾随语句 / 嵌套）')
{
  const importSrc = "import fs from 'node:fs'; function alpha(){ return fs }\n"
  const p = put('imp.js', importSrc)
  const before = fs.readFileSync(p)
  const res = json(run(['basetools', 'edit', '--file', p, '--target', 'alpha', '--replace', 'x']))
  check(res.ok === false && res.code === 'LOCATOR_LINE_SHARED' && res.shared?.side === 'before', 'D1 import 与符号同一行 ⇒ 拒绝（before）', JSON.stringify(res).slice(0, 220))
  check(fs.readFileSync(p).equals(before), 'D2 被拒后磁盘逐字节不变')
  check(String(res.error).includes('import fs'), 'D3 报错点名会被删掉的原文', String(res.error).slice(0, 200))
  check(codeOf(() => planHunks(importSrc, [{ target: 'alpha', replace: 'x' }], 'imp.js')) === 'LOCATOR_LINE_SHARED', 'D4 引擎层同一判据（不是 CLI 自己拦）')

  const old = json(run(['basetools', 'edit', '--file', p, '--old', 'function alpha(){ return fs }', '--replace', 'function alpha(){ return 9 }']))
  check(old.ok === true && fs.readFileSync(p, 'utf8') === "import fs from 'node:fs'; function alpha(){ return 9 }\n", 'D5 old 片段仍可只改那一段，import 逐字节保留', JSON.stringify(old).slice(0, 200))

  const directive = put('strict.js', "'use strict'; function alpha(){return 1}\n")
  const directiveBefore = fs.readFileSync(directive)
  const dRes = json(run(['basetools', 'edit', '--file', directive, '--target', 'alpha', '--replace', 'x']))
  check(dRes.code === 'LOCATOR_LINE_SHARED' && fs.readFileSync(directive).equals(directiveBefore), 'D6 指令语句同一行 ⇒ 拒绝且零写入')

  const tail = put('tail.js', 'function alpha(){return 1} run()\n')
  const tailBefore = fs.readFileSync(tail)
  const tRes = json(run(['basetools', 'edit', '--file', tail, '--target', 'alpha', '--replace', 'x']))
  check(tRes.code === 'LOCATOR_LINE_SHARED' && tRes.shared?.side === 'after' && fs.readFileSync(tail).equals(tailBefore), 'D7 尾随调用同一行 ⇒ 拒绝（after）')

  const nested = put('nested.js', 'function outer(){ function inner(){return 1} }\n')
  const nRes = json(run(['basetools', 'edit', '--file', nested, '--target', 'inner', '--replace', 'x']))
  check(nRes.code === 'LOCATOR_LINE_SHARED', 'D8 嵌套符号同一行 ⇒ 拒绝（外层声明也会被删）')

  const semi = put('semi.js', 'const a=1;const b=2\n')
  const sRes = json(run(['basetools', 'edit', '--file', semi, '--target', 'b', '--replace', 'x']))
  check(sRes.code === 'LOCATOR_LINE_SHARED', 'D9 分号分隔的两条声明 ⇒ 拒绝')

  const intent = json(run(['basetools', 'edit', '--file', p, '--intent', 'alpha', '--replace', 'x']))
  check(intent.code === 'LOCATOR_LINE_SHARED' && intent.shared?.side === 'before', 'D10 intent 落到符号层时同一判据', JSON.stringify(intent).slice(0, 200))
}

say('E 多行声明头')
{
  const p = put('hdr.js', 'export function\nalpha() {\n  return 1\n}\n')
  const res = json(run(['basetools', 'edit', '--file', p, '--target', 'alpha', '--replace', 'function alpha() { return 9 }']))
  check(res.ok === true && fs.readFileSync(p, 'utf8') === 'function alpha() { return 9 }\n', 'E1 target 覆盖整个声明（旧版会留下 `export function` 悬空前缀）', JSON.stringify(res).slice(0, 220))
  check(res.result?.applied?.[0]?.line === 1, 'E2 回执从声明第一行开始（不是名字所在行）')
  check(codeOf(() => planHunks('export function\nalpha() {\n  return 1\n}\n', [{ target: 'alpha', replace: 'x' }], 'hdr.js')) === 'NO_ERROR', 'E3 引擎层同样从声明起点算')

  const c = put('hdr.c', 'static int\nalpha(void) {\n  return 1;\n}\n')
  const cBefore = fs.readFileSync(c)
  const cRes = json(run(['basetools', 'edit', '--file', c, '--target', 'alpha', '--replace', 'x']))
  check(cRes.code === 'LOCATOR_LINE_SHARED' && cRes.shared?.side === 'header' && fs.readFileSync(c).equals(cBefore), 'E4 C 返回类型在上一行 ⇒ 拒绝（不把返回类型留成悬空前缀）')

  const clj = put('form.clj', '(defn alpha [] 1)\n')
  const cljRes = json(run(['basetools', 'edit', '--file', clj, '--target', 'alpha', '--replace', '(defn alpha [] 2)']))
  check(cljRes.ok === true && fs.readFileSync(clj, 'utf8') === '(defn alpha [] 2)\n', 'E5 Lisp：包住声明的括号属于声明本身，target 仍可用')

  const py = put('deco.py', '@dec\ndef alpha():\n    return 1\n')
  const pyRes = json(run(['basetools', 'edit', '--file', py, '--target', 'alpha', '--replace', 'def alpha():\n    return 2']))
  check(pyRes.ok === true && fs.readFileSync(py, 'utf8') === '@dec\ndef alpha():\n    return 2\n', 'E6 上一行的装饰器不在跨度里，保留')
}

say(`\n--- 单行/CR 寻址：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
