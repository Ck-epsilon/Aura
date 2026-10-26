/**
 * receipt-context-test —— 0.8.1：编辑回执要**自带继续编辑所需的上下文**。
 *
 * 目标不是把整份文件再贴一遍，而是给三样调用方自己算不出来的事实：
 *   1. `afterLine` / `afterEndLine`：同一处在**改后**文件里的坐标（`line` 仍是改前坐标）；
 *   2. `delta`：这条 hunk 增删了几行（多 hunk 调用里后一条的改后坐标依赖它）；
 *   3. `handle`：改后区间的**新句柄**，下一次编辑直接拿它寻址，不必回读。
 *
 * 片段层（`old` 命中行内一段）额外回填 `after`（整行改完的样子）：`replaced` 只是行内那一段，
 * 看不到前后缀有没有被挤坏。整行替换不重复回填——`replaced` 已经是完整新区域。
 *
 * 判据只走公开 API（`planHunks` / handle-core 的公开函数），不读引擎私有状态。
 * 跑法：`node src/locator-lab/receipt-context-test.mjs`，全绿 exit 0。
 */
import fs from 'node:fs'
import { HANDLE_RE, mintHandle, parseHandle, regionFingerprint } from './handle-core.mjs'
import { planHunks } from './write-path.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}

const SRC = [
  'function a() {', // 1
  '  return 1', // 2
  '}', // 3
  '', // 4
  'function b() {', // 5
  '  return 2', // 6
  '}', // 7
].join('\n')
const FILE = 'receipt-fixture.mjs'
const plan = (content, hunks) => planHunks(content, hunks, FILE)

say('=== A. 单 hunk：改后坐标、行数变化、新句柄 ===')
{
  const p = plan(SRC, [{ lines: [2, 2], replace: '  return 10\n  // added' }])
  const a = p.applied[0]
  check('A1 改前坐标仍是 line=2（契约不变）', a.line === 2, `line=${a.line}`)
  check('A2 改后坐标 afterLine=2 / afterEndLine=3', a.afterLine === 2 && a.afterEndLine === 3, `${a.afterLine}-${a.afterEndLine}`)
  check('A3 delta=+1', a.delta === 1, `delta=${a.delta}`)
  check('A4 句柄形状合法且行号是改后坐标', typeof a.handle === 'string' && HANDLE_RE.test(a.handle) && parseHandle(a.handle).startLine === 2 && parseHandle(a.handle).endLine === 3, String(a.handle))
  const parsed = parseHandle(a.handle)
  check(
    'A5 句柄指纹 = 改后区间文本（工具现场铸的，不依赖读侧状态）',
    parsed.ok && parsed.fingerprint === regionFingerprint('  return 10\n  // added'),
    parsed.ok ? parsed.fingerprint : 'parse failed',
  )
  check('A6 整行替换不重复回填 after（replaced 已是完整新区域）', a.after === undefined, JSON.stringify(a.after))

  const follow = plan(p.content, [{ handle: a.handle, replace: '  return 99' }])
  check('A7 下一次编辑可直接用新句柄寻址（无需回读）', follow.applied.length === 1 && follow.applied[0].line === 2 && follow.content.includes('  return 99'), JSON.stringify(follow.applied[0]))
}

say('')
say('=== B. 多 hunk：后一条的改后坐标 = 改前坐标 + 前一条的 delta ===')
{
  const p = plan(SRC, [
    { lines: [2, 2], replace: '  return 10\n  // added' },
    { lines: [6, 6], replace: '  return 20' },
  ])
  const [first, second] = p.applied
  check('B1 第一条 afterLine=2 / delta=+1', first.afterLine === 2 && first.delta === 1, `${first.afterLine} delta=${first.delta}`)
  check('B2 第二条改前 line=6、改后 afterLine=7（被前一条 +1 顶下去）', second.line === 6 && second.afterLine === 7 && second.afterEndLine === 7, `line=${second.line} after=${second.afterLine}-${second.afterEndLine}`)
  check('B3 第二条句柄的行号也是 7', parseHandle(second.handle).startLine === 7 && parseHandle(second.handle).endLine === 7, String(second.handle))
  const follow = plan(p.content, [{ handle: second.handle, replace: '  return 21' }])
  check('B4 多 hunk 后铸的句柄仍能定位到正确行', follow.applied[0]?.line === 7 && follow.content.includes('  return 21'), JSON.stringify(follow.applied[0]))
}

say('')
say('=== C. 片段层：after 回填整行，行数按逻辑行算（不是 parts 数组项数） ===')
{
  const src = 'const x = "hello world"\n'
  const p = plan(src, [{ old: 'hello', replace: 'HI' }])
  const a = p.applied[0]
  check('C1 行内替换 delta=0（没有新增一行）', a.line === 1 && a.afterLine === 1 && a.afterEndLine === 1 && a.delta === 0, `line=${a.line} after=${a.afterLine}-${a.afterEndLine} delta=${a.delta}`)
  check('C2 after = 整行改完的样子（含前后缀）', a.after === 'const x = "HI world"', JSON.stringify(a.after))
  check('C3 句柄覆盖整行，指纹 = 改后整行', parseHandle(a.handle)?.fingerprint === regionFingerprint('const x = "HI world"'), String(a.handle))
  check('C4 落盘文本只有一行（行内替换没有多出空行）', p.content === 'const x = "HI world"\n', JSON.stringify(p.content))

  const multi = plan(src, [{ old: 'hello', replace: 'A\nB' }])
  const m = multi.applied[0]
  check('C5 replace 自带换行 ⇒ delta=+1、after 是两行', m.delta === 1 && m.afterLine === 1 && m.afterEndLine === 2 && m.after === 'const x = "A\nB world"', `${m.afterLine}-${m.afterEndLine} delta=${m.delta} after=${JSON.stringify(m.after)}`)
  check('C6 落盘也是两行', multi.content.split('\n').length === 3 && multi.content.includes('A\nB world'), JSON.stringify(multi.content))

  // replace 末尾带换行：后缀被顶到下一行，delta/after/handle 都必须按两行算。
  const trailing = plan(src, [{ old: 'hello', replace: 'A\n' }])
  const t = trailing.applied[0]
  check('C7 replace 末尾换行 ⇒ delta=+1、after 两行、句柄 1-2', t.delta === 1 && t.afterLine === 1 && t.afterEndLine === 2 && t.after === 'const x = "A\n world"' && parseHandle(t.handle)?.endLine === 2, JSON.stringify(t))
  check('C8 落盘两行（后缀在新行，不粘在 A 后面）', trailing.content === 'const x = "A\n world"\n', JSON.stringify(trailing.content))
}

say('')
say('=== C2. 无尾换行文件末尾插入：不把最后两行粘在一起 ===')
{
  const eofSrc = 'a\nb\nc'
  const handle = mintHandle({ ledgerKey: FILE, regionText: eofSrc, startLine: 1, endLine: 3 })
  const p = plan(eofSrc, [{ handle, position: 'after', replace: 'd' }])
  const a = p.applied[0]
  check('C9 末尾插入后文件是 a/b/c/d 四行', p.content === 'a\nb\nc\nd', JSON.stringify(p.content))
  check('C10 不凭空加尾换行', !p.content.endsWith('\n'), JSON.stringify(p.content))
  check('C11 回执 afterLine=4，句柄覆盖第 4 行且指纹 = “d”', a.afterLine === 4 && a.afterEndLine === 4 && parseHandle(a.handle)?.startLine === 4 && parseHandle(a.handle)?.fingerprint === regionFingerprint('d'), JSON.stringify(a))
}

say('')
say('=== D. 删除：没有可指区间 ⇒ 不铸句柄，delta 为负 ===')
{
  const p = plan(SRC, [{ lines: [2, 3], replace: '' }])
  const a = p.applied[0]
  check('D1 afterLine=2 / afterEndLine=1（空区间）', a.afterLine === 2 && a.afterEndLine === 1, `${a.afterLine}-${a.afterEndLine}`)
  check('D2 delta=-2', a.delta === -2, `delta=${a.delta}`)
  check('D3 删除没有句柄（没有字节区间可指）', a.handle === undefined, String(a.handle))
  check('D4 删除没有 after', a.after === undefined, JSON.stringify(a.after))
}

say('')
say('=== E. 体量：片段层 after 超长时截断，句柄仍覆盖完整区间 ===')
{
  const prefix = 'p'.repeat(300)
  const tail = 't'.repeat(300)
  const src = `const y = "${prefix}NEEDLE${tail}"\n`
  const p = plan(src, [{ old: 'NEEDLE', replace: 'SHORT' }])
  const a = p.applied[0]
  check('E1 afterTruncated=true', a.afterTruncated === true, String(a.afterTruncated))
  check('E2 after 被截到 400 字符 + 省略号', typeof a.after === 'string' && a.after.length === 401 && a.after.endsWith('…'), `len=${a.after?.length}`)
  const fullLine = `const y = "${prefix}SHORT${tail}"`
  check('E3 句柄指纹用完整区间（不是截断后的 after）', parseHandle(a.handle)?.fingerprint === regionFingerprint(fullLine), String(a.handle))
}

say('')
say('=== F. CRLF：句柄指纹与读侧同一口径（按 \\n 拼区间文本） ===')
{
  const src = 'function a() {\r\n  return 1\r\n}\r\n'
  const p = plan(src, [{ lines: [2, 2], replace: '  return 10' }])
  const a = p.applied[0]
  check('F1 afterLine=2 / delta=0', a.afterLine === 2 && a.delta === 0, `${a.afterLine} delta=${a.delta}`)
  check('F2 句柄指纹 = 新行文本（不含 \\r）', parseHandle(a.handle)?.fingerprint === regionFingerprint('  return 10'), String(a.handle))
  check('F3 落盘仍是 CRLF', p.content === 'function a() {\r\n  return 10\r\n}\r\n', JSON.stringify(p.content))
}

say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
if (fail > 0) say(`失败 ${fail} 条`)
process.exitCode = fail === 0 ? 0 : 1
