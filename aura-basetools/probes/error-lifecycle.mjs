/**
 * error-lifecycle.mjs —— 错误闭环的**基线探针**（不是闸）。
 *
 * 判据不是“工具会不会错”，而是错误发生后的四个数：
 *   ① 预检：写入前就被拒（磁盘逐字节未动）；
 *   ② 定位：回执点名了区域/候选/首个差异，而不是一句泛泛的失败；
 *   ③ 修复：一次后续调用能改对（不是重读 + 重想 + 重写）；
 *   ④ 误拒：一组本来就合法的编辑，一条都不该被拒。
 *
 * 现在还没有结构预检与写后校验，所以部分故障会“成功落盘”——本探针**如实记录**，
 * 不做断言；等预检/校验落地后，同一套故障的 preempt/localized/fixable 会自行翻绿，
 * 那时再把关键行提升成闸内判据（`error-lifecycle-range`）。
 *
 * 跑法：node probes/error-lifecycle.mjs [--json=dist/error-lifecycle.json]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { encodeText } from '../src/aura-standalone/lib/encoding.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const bin = path.join(root, 'src', 'aura-standalone', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-errlife-'))
const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }

const run = (args) => {
  const res = spawnSync(process.execPath, [bin, 'basetools', ...args, '--pretty'], { cwd: tmp, encoding: 'utf8', env, timeout: 60000 })
  let body = null
  try {
    body = JSON.parse(String(res.stdout ?? '').trim())
  } catch {
    body = null
  }
  return { status: res.status, body, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') }
}
// 写盘路径解析：写类回执在 result 里，读类在顶层；失败回执的 code 在顶层。
const ok = (r) => r.body?.ok === true
const codeOf = (r) => r.body?.code ?? r.body?.result?.code ?? (r.status === 0 ? null : 'NO_JSON')
const file = (name, bytes) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, bytes)
  return p
}
const text = (name, content) => file(name, Buffer.from(content, 'utf8'))
const disk = (p) => fs.readFileSync(p)
const edit = (args) => run(['edit', ...args])
const read = (args) => run(['read', ...args])
const contentOf = (r) => String(r.body?.text ?? '')
const hasEvidence = (r, pattern) => pattern.test(String(r.body?.error ?? '')) || pattern.test(JSON.stringify(r.body ?? {}))

const faults = []
const add = (fault) => faults.push(fault)
const record = async (fault) => {
  try {
    const result = await fault.run()
    return { id: fault.id, label: fault.label, ...result }
  } catch (error) {
    return { id: fault.id, label: fault.label, preempt: false, localized: false, fixable: false, note: `probe error: ${error?.message ?? error}` }
  }
}

// ── 故障 1：地址近似但不等（错字） ───────────────────────────────────────────
add({
  id: 'wrong-old',
  label: '错的 old（唯一但不相等）',
  async run() {
    const p = text('wrong-old.txt', 'alpha\nbravo\ncharlie\n')
    const r = edit(['--file', p, '--old', 'brava', '--replace', 'BRAVO'])
    const preempt = !ok(r) && disk(p).equals(Buffer.from('alpha\nbravo\ncharlie\n'))
    const localized = codeOf(r) === 'PATCH_NOT_FOUND' && hasEvidence(r, /nearest|retry|line/i)
    const fixed = ok(edit(['--file', p, '--old', 'bravo', '--replace', 'BRAVO'])) && disk(p).includes('BRAVO')
    return { preempt, localized, fixable: fixed, note: String(codeOf(r)) }
  },
})

// ── 故障 2：陈旧区域（读后被无关改动） ───────────────────────────────────────
add({
  id: 'stale-region',
  label: '读后目标区域被外部改',
  async run() {
    const p = text('stale.txt', 'alpha\nbravo\ncharlie\n')
    read(['--file', p, '--mode', 'full'])
    // 改的必须是**被寻址的那一行**：闸门按区域判，与文件其他处无关。
    fs.writeFileSync(p, 'alpha-EXTERNAL\nbravo\ncharlie\n')
    const r = edit(['--file', p, '--lines', '1', '--replace', 'ALPHA'])
    const preempt = !ok(r) && disk(p).toString().startsWith('alpha-EXTERNAL')
    const localized = /STALE/.test(String(codeOf(r))) && hasEvidence(r, /changed|stale|line/i)
    // 修复路径是“重读 + 再改”（两次调用）：一次调用拿不回来，除非将来有 --retry。
    read(['--file', p, '--mode', 'full'])
    const fixed = ok(edit(['--file', p, '--lines', '1', '--replace', 'ALPHA'])) && disk(p).toString().startsWith('ALPHA\n')
    return { preempt, localized, fixable: fixed, note: `${codeOf(r)}（修复需重读+重改）` }
  },
})

// ── 故障 3：句柄过期（读后被改，句柄仍指旧内容） ───────────────────────────────
add({
  id: 'handle-stale',
  label: '句柄指向的内容被改',
  async run() {
    const p = text('handle.txt', 'alpha\nbravo\ncharlie\n')
    const r1 = read(['--file', p, '--mode', 'lines', '--lines', '1,1'])
    const handle = r1.body?.handle
    fs.writeFileSync(p, 'ALPHA-EXTERNAL\nbravo\ncharlie\n')
    const r = handle === undefined ? { body: { ok: false, code: 'NO_HANDLE' }, status: 1 } : edit(['--file', p, '--handle', handle, '--replace', 'ALPHA'])
    const preempt = !ok(r) && disk(p).toString().startsWith('ALPHA-EXTERNAL')
    const localized = /STALE/.test(String(codeOf(r))) && hasEvidence(r, /handle|stale|line/i)
    const fixed = ok(edit(['--file', p, '--lines', '1', '--replace', 'ALPHA'])) && disk(p).toString().startsWith('ALPHA\n')
    return { preempt, localized, fixable: fixed, note: String(codeOf(r)) }
  },
})

// ── 故障 3b：目标内容没变、位置漂移（--retry 的一刀） ────────────────────
add({
  id: 'drift-lines',
  label: '目标内容没变、位置漂移',
  async run() {
    const p = text('drift.txt', 'alpha\nbravo\ncharlie\n')
    read(['--file', p, '--mode', 'full'])
    fs.writeFileSync(p, 'LEAD\nalpha\nbravo\ncharlie\n')
    const r = edit(['--file', p, '--lines', '2', '--replace', 'BRAVO'])
    const preempt = !ok(r) && disk(p).toString() === 'LEAD\nalpha\nbravo\ncharlie\n'
    const localized = /STALE/.test(String(codeOf(r))) && hasEvidence(r, /moved|line 2|now/i)
    const retried = edit(['--file', p, '--lines', '2', '--replace', 'BRAVO', '--retry'])
    const fixed = ok(retried) && disk(p).toString().split('\n')[2] === 'BRAVO' && Array.isArray(retried.body?.result?.rebased)
    return { preempt, localized, fixable: fixed, note: `${codeOf(r)} → ${ok(retried) ? 'retry ✓' : 'retry ✗'}` }
  },
})

// ── 故障 4：歧义锚点 ────────────────────────────────────────────────────────
add({
  id: 'ambiguous-anchor',
  label: '锚点在两处命中',
  async run() {
    const p = text('anchor.txt', 'alpha\nbravo\nalpha\ncharlie\n')
    const r = edit(['--file', p, '--anchor', 'alpha', '--replace', 'ALPHA'])
    const preempt = !ok(r) && disk(p).equals(Buffer.from('alpha\nbravo\nalpha\ncharlie\n'))
    const localized = /AMBIGUOUS|NEED/.test(String(codeOf(r))) && Array.isArray(r.body?.candidates) && r.body.candidates.length >= 2
    const fixed = ok(edit(['--file', p, '--lines', '1', '--replace', 'ALPHA'])) && disk(p).toString().split('\n')[0] === 'ALPHA'
    return { preempt, localized, fixable: fixed, note: String(codeOf(r)) }
  },
})

// ── 故障 5：行号越界 ────────────────────────────────────────────────────────
add({
  id: 'out-of-range',
  label: '行号越界',
  async run() {
    const p = text('range.txt', 'alpha\nbravo\n')
    const r = edit(['--file', p, '--lines', '99', '--replace', 'X'])
    const preempt = !ok(r) && disk(p).equals(Buffer.from('alpha\nbravo\n'))
    const localized = /OUT_OF_RANGE|RANGE/.test(String(codeOf(r))) && hasEvidence(r, /\bgot\b|max|99/i)
    const fixed = ok(edit(['--file', p, '--lines', '2', '--replace', 'BRAVO'])) && disk(p).includes('BRAVO')
    return { preempt, localized, fixable: fixed, note: String(codeOf(r)) }
  },
})

// ── 故障 6：编码猜不准（短 GBK 文件） ─────────────────────────────────────────
add({
  id: 'ambiguous-encoding',
  label: '短 GBK 文件：编码猜不准',
  async run() {
    const gbk = encodeText('中文测试\r\n第二行\r\n', { encoding: 'gb18030', bom: [] })
    const p = file('gbk-short.txt', gbk)
    const r = edit(['--file', p, '--lines', '2', '--replace', '第二行甲'])
    const preempt = !ok(r) && disk(p).equals(gbk)
    const localized = /ENCODING_AMBIGUOUS/.test(String(codeOf(r))) && hasEvidence(r, /encoding|gb18030/i)
    const fixed = ok(edit(['--file', p, '--lines', '2', '--replace', '第二行甲', '--encoding', 'gb18030'])) && !disk(p).equals(gbk)
    return { preempt, localized, fixable: fixed, note: String(codeOf(r)) }
  },
})

// ── 故障 7：目标编码表示不了的字符 ──────────────────────────────────────────
add({
  id: 'unrepresentable',
  label: 'GBK 文件写入 BMP 扩展区字符',
  async run() {
    const gbk = encodeText('中文测试\r\n第二行\r\n', { encoding: 'gb18030', bom: [] })
    const p = file('gbk-bmp.txt', gbk)
    const r = edit(['--file', p, '--lines', '1', '--replace', '㐀', '--encoding', 'gb18030'])
    const preempt = !ok(r) && disk(p).equals(gbk)
    const localized = /ENCODING_UNREPRESENTABLE/.test(String(codeOf(r))) && hasEvidence(r, /U\+3400|㐀/i)
    // 可表示字符是合法的修法：写成“中文”，文件变化且仍是 GBK。
    const fixed = ok(edit(['--file', p, '--lines', '1', '--replace', '中文', '--encoding', 'gb18030'])) && disk(p).toString('utf8').length > 0 && !disk(p).equals(gbk)
    return { preempt, localized, fixable: fixed, note: String(codeOf(r)) }
  },
})

// ── 故障 8：改坏 JSON（删掉闭合括号） ────────────────────────────────────────
add({
  id: 'json-break',
  label: '编辑把 JSON 改成不合法',
  async run() {
    const p = text('broken.json', '{\n  "a": 1,\n  "b": 2\n}\n')
    const r = edit(['--file', p, '--lines', '4', '--replace', ''])
    const preempt = !ok(r)
    let valid = true
    try {
      JSON.parse(disk(p).toString())
    } catch {
      valid = false
    }
    const localized = preempt && hasEvidence(r, /structure|json|parse/i)
    const fixed = ok(edit(['--file', p, '--lines', '4', '--replace', '}'])) && (() => {
      try {
        JSON.parse(disk(p).toString())
        return true
      } catch {
        return false
      }
    })()
    return { preempt, localized, fixable: fixed, note: preempt ? String(codeOf(r)) : `写入后 JSON 非法（valid=${valid}）` }
  },
})

// ── 故障 9：lone CR ─────────────────────────────────────────────────────────
add({
  id: 'lone-cr',
  label: '替换文本里出现 lone CR',
  async run() {
    const p = text('lonecr.txt', 'alpha\nbravo\n')
    const r = edit(['--file', p, '--lines', '1', '--replace', 'A\rB'])
    const preempt = !ok(r) && disk(p).equals(Buffer.from('alpha\nbravo\n'))
    const localized = /LONE_CR/.test(String(codeOf(r))) && hasEvidence(r, /CR|carriage/i)
    const fixed = ok(edit(['--file', p, '--lines', '1', '--replace', 'A\nB'])) && !disk(p).toString().includes('\r')
    return { preempt, localized, fixable: fixed, note: preempt ? String(codeOf(r)) : '写入后文件出现 lone CR（未拦）' }
  },
})

// ── 故障 10：未观测的大段删除（应预检告警/拒绝） ─────────────────────────────
add({
  id: 'blind-huge-delete',
  label: '未读过的文件一次删掉 90 行',
  async run() {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const p = text('huge.txt', body)
    const r = edit(['--file', p, '--lines', '1,90', '--replace', ''])
    const preempt = !ok(r)
    const localized = preempt && hasEvidence(r, /not read|removes|unobserved|delete/i)
    const fixed = ok(edit(['--file', p, '--lines', '1,90', '--replace', Array.from({ length: 90 }, (_, i) => `line ${i + 1}`).join('\n')])) && disk(p).toString() === body
    return { preempt, localized, fixable: fixed, note: preempt ? String(codeOf(r)) : '静默落盘（未预检）' }
  },
})

// ── 故障 11：重叠 hunk ──────────────────────────────────────────────────────
add({
  id: 'overlap-hunks',
  label: '两个 hunk 区间重叠',
  async run() {
    const p = text('overlap.txt', 'alpha\nbravo\ncharlie\n')
    const hunks = JSON.stringify([
      { lines: [2, 2], expect: 'bravo', replace: 'B1' },
      { lines: [2, 3], expect: 'bravo\ncharlie', replace: 'B2' },
    ])
    const r = edit(['--file', p, '--hunks', hunks])
    const preempt = !ok(r) && disk(p).equals(Buffer.from('alpha\nbravo\ncharlie\n'))
    const localized = /OVERLAP|BAD_HUNK/.test(String(codeOf(r))) && hasEvidence(r, /hunk|overlap/i)
    const fixed = ok(edit(['--file', p, '--lines', '2', '--replace', 'BRAVO'])) && disk(p).includes('BRAVO')
    return { preempt, localized, fixable: fixed, note: String(codeOf(r)) }
  },
})

// ── 故障 12：二进制目标 ─────────────────────────────────────────────────────
add({
  id: 'binary-target',
  label: '二进制文件被当文本编辑',
  async run() {
    const bytes = Buffer.from([0x61, 0x00, 0x62, 0x0a])
    const p = file('bin.dat', bytes)
    const r = edit(['--file', p, '--lines', '1', '--replace', 'x'])
    const preempt = !ok(r) && disk(p).equals(bytes)
    const localized = /FS_NOT_TEXT/.test(String(codeOf(r))) && hasEvidence(r, /binary|text/i)
    // 二进制目标没有“改对”的修法：按设计它就是不可编辑。
    return { preempt, localized, fixable: false, note: `${codeOf(r)}（按设计不可改）` }
  },
})

// ── 对照组：本来就合法的编辑，一条都不该被拒 ─────────────────────────────────
const controls = []
add({
  id: 'control-old',
  label: '[对照] old + replace',
  async run() {
    const p = text('ctl-old.txt', 'alpha\nbravo\n')
    const r = edit(['--file', p, '--old', 'bravo', '--replace', 'BRAVO'])
    controls.push({ id: 'control-old', ok: ok(r) })
    return { preempt: false, localized: false, fixable: false, note: ok(r) ? 'ok' : String(codeOf(r)) }
  },
})
add({
  id: 'control-lines',
  label: '[对照] lines + replace',
  async run() {
    const p = text('ctl-lines.txt', 'alpha\nbravo\n')
    const r = edit(['--file', p, '--lines', '2', '--replace', 'BRAVO'])
    controls.push({ id: 'control-lines', ok: ok(r) })
    return { preempt: false, localized: false, fixable: false, note: ok(r) ? 'ok' : String(codeOf(r)) }
  },
})
add({
  id: 'control-multihunk',
  label: '[对照] 两个不重叠 hunk',
  async run() {
    const p = text('ctl-multi.txt', 'a\nb\nc\nd\n')
    const hunks = JSON.stringify([{ lines: [1, 1], expect: 'a', replace: 'A' }, { lines: [3, 3], expect: 'c', replace: 'C' }])
    const r = edit(['--file', p, '--hunks', hunks])
    controls.push({ id: 'control-multihunk', ok: ok(r) })
    return { preempt: false, localized: false, fixable: false, note: ok(r) ? 'ok' : String(codeOf(r)) }
  },
})
add({
  id: 'control-target',
  label: '[对照] target 按符号改',
  async run() {
    const p = text('ctl-target.mjs', 'export function beta() {\n  return 1\n}\n')
    const r = edit(['--file', p, '--target', 'beta', '--replace', 'export function beta() {\n  return 2\n}'])
    controls.push({ id: 'control-target', ok: ok(r) })
    return { preempt: false, localized: false, fixable: false, note: ok(r) ? 'ok' : String(codeOf(r)) }
  },
})

// ── 跑 ──────────────────────────────────────────────────────────────────────
const results = []
for (const fault of faults) results.push(await record(fault))

// 中文按 2 列宽算，否则表会错位
const displayWidth = (s) => [...String(s)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
const pad = (s, width) => String(s) + ' '.repeat(Math.max(0, width - displayWidth(s)))
const shown = results.filter((r) => !r.id.startsWith('control'))
const width = Math.max(...shown.map((r) => displayWidth(r.label)), 10)
const mark = (v) => (v ? '✓' : '·')
console.log('错误闭环基线（当前实现；✓ = 已具备，· = 缺口）\n')
console.log(`${pad('故障', width)}  预检  定位  一次修复  说明`)
for (const r of shown) {
  console.log(`${pad(r.label, width)}   ${mark(r.preempt)}    ${mark(r.localized)}     ${mark(r.fixable)}      ${r.note ?? ''}`)
}
const counted = results.filter((r) => !r.id.startsWith('control'))
const sum = (key) => counted.filter((r) => r[key]).length
console.log('')
console.log(`故障 ${counted.length} 条：预检 ${sum('preempt')}/${counted.length} · 定位 ${sum('localized')}/${counted.length} · 一次修复 ${sum('fixable')}/${counted.length}`)
const rejected = controls.filter((c) => !c.ok)
console.log(`对照组 ${controls.length} 条合法编辑：误拒 ${rejected.length} 条${rejected.length === 0 ? '' : `（${rejected.map((c) => c.id).join(',')}）`}`)

const jsonArg = process.argv.find((a) => a.startsWith('--json='))
if (jsonArg !== undefined) {
  const target = path.resolve(jsonArg.slice('--json='.length))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ generatedAt: new Date().toISOString(), results, controls }, null, 2) + '\n')
  console.log(`\nJSON: ${target}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)
