// Independent comparison: aura-basetools 0.19.0 (published CLI) vs the DSH filesystem seam
// (`@deepseek-ai/dsh-fs-local`, the implementation behind the default read/write/edit tools).
//
// The native side is invoked directly through LocalFileSystem, with a version token from a prior
// read where a read-before-write guard is being modelled. That isolates byte semantics from the
// model-facing formatting; the tool layer calls exactly these methods.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const globalRoot = process.platform === 'win32'
  ? execFileSync('cmd.exe', ['/c', 'npm', 'root', '-g'], { encoding: 'utf8' }).trim()
  : execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
const DSH_BASE = process.env.AURA_DSH_NM ?? path.join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const AURA = path.resolve('eval/independent/.vendor/node_modules/aura-basetools/bin/aura.mjs')
const cordis = await import('file:///' + path.join(DSH_BASE, 'cordis', 'lib', 'index.js').replaceAll('\\', '/'))
const { LocalFileSystem } = await import('file:///' + path.join(DSH_BASE, 'dsh-fs-local', 'lib', 'index.js').replaceAll('\\', '/'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-vs-dsh-'))
let seq = 0
const mk = (label) => {
  const root = path.join(tmp, `${String(++seq).padStart(2, '0')}-${label}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}
const write = (root, name, bytes) => fs.writeFileSync(path.join(root, name), Buffer.from(bytes))
const read = (root, name) => fs.readFileSync(path.join(root, name))
const hex = (bytes) => Buffer.from(bytes).toString('hex')
const show = (bytes) => {
  const b = Buffer.from(bytes)
  return b.length <= 64 ? b.toString('hex') : `${b.subarray(0, 32).toString('hex')}…（${b.length}B）`
}

function nativeFs(root) {
  const ctx = new cordis.Context()
  return new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 4 * 1024 * 1024 })
}
async function nativeTarget(root, name = 'f.txt') {
  const p = nativeFs(root)
  return { p, target: await p.resolve(name, { cwd: root }) }
}
function runAura(root, args) {
  const res = spawnSync(process.execPath, [AURA, 'basetools', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, AURA_CACHE_DIR: path.join(root, '.cache') },
  })
  let json = null
  try { json = JSON.parse(String(res.stdout ?? '').trim().split('\n').pop() ?? '') } catch { /* no json */ }
  return { status: res.status, json, stderr: String(res.stderr ?? '').trim() }
}
const auraRead = (root, name = 'f.txt') => runAura(root, ['read', '--file', name, '--mode', 'full'])
const auraEditLines = (root, line, replace, name = 'f.txt') => runAura(root, ['edit', '--file', name, '--lines', String(line), '--replace', replace])
const auraEditOld = (root, oldString, newString, name = 'f.txt') => runAura(root, ['edit', '--file', name, '--old', oldString, '--replace', newString])
const auraWrite = (root, content, name = 'f.txt') => runAura(root, ['write', '--file', name, '--content', content])

const cases = []
const add = (name, detail) => {
  cases.push({ name, ...detail })
  console.log(`${detail.same ? '  =' : '  ≠'} ${name}  native=${show(detail.native)} aura=${show(detail.aura)}`)
}

console.log('=== A. edit: BOM + CRLF, exact token ===')
{
  const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\nthree\r\n')])
  const rootN = mk('native-bom-token'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  await p.readText(target)
  const st = await p.stat(target)
  await p.editText(target, { oldString: 'two', newString: 'TWO', replaceAll: false }, st)
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-bom-token'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  await auraEditOld(rootA, 'two', 'TWO')
  const aura = read(rootA, 'f.txt')
  const expected = Buffer.from(input.toString('utf8').replace('two', 'TWO'), 'utf8')
  add('edit-bom-crlf-token', { native, aura, expected, same: native.equals(aura), nativeOk: native.equals(expected), auraOk: aura.equals(expected) })
}

console.log('')
console.log('=== B. edit: BOM + CRLF, line-addressed ===')
{
  const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\nthree\r\n')])
  const rootN = mk('native-bom-line'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  await p.readText(target)
  const st = await p.stat(target)
  await p.editText(target, { oldString: 'one', newString: 'ONE', replaceAll: false }, st)
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-bom-line'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  await auraEditLines(rootA, 1, 'ONE')
  const aura = read(rootA, 'f.txt')
  const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ONE\r\ntwo\r\nthree\r\n')])
  add('edit-bom-crlf-line', { native, aura, expected, same: native.equals(aura), nativeOk: native.equals(expected), auraOk: aura.equals(expected) })
}

console.log('')
console.log('=== C. edit: CRLF + multiline replacement ===')
{
  const input = Buffer.from('p1\r\np2\r\np3\r\n')
  const rootN = mk('native-multiline'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  await p.readText(target)
  const st = await p.stat(target)
  await p.editText(target, { oldString: 'p2', newString: 'P2a\nP2b', replaceAll: false }, st)
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-multiline'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  await auraEditLines(rootA, 2, 'P2a\nP2b')
  const aura = read(rootA, 'f.txt')
  const expected = Buffer.from('p1\r\nP2a\r\nP2b\r\np3\r\n')
  add('edit-crlf-multiline', { native, aura, expected, same: native.equals(aura), nativeOk: native.equals(expected), auraOk: aura.equals(expected) })
}

console.log('')
console.log('=== D. edit: no trailing newline ===')
{
  const input = Buffer.from('x\ny')
  const rootN = mk('native-nonl'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  await p.readText(target)
  const st = await p.stat(target)
  await p.editText(target, { oldString: 'y', newString: 'Y', replaceAll: false }, st)
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-nonl'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  await auraEditLines(rootA, 2, 'Y')
  const aura = read(rootA, 'f.txt')
  const expected = Buffer.from('x\nY')
  add('edit-no-final-newline', { native, aura, expected, same: native.equals(aura), nativeOk: native.equals(expected), auraOk: aura.equals(expected) })
}

console.log('')
console.log('=== E. edit: mixed line endings ===')
{
  const input = Buffer.from('a\nb\r\nc\nd\n')
  const rootN = mk('native-mixed'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  await p.readText(target)
  const st = await p.stat(target)
  await p.editText(target, { oldString: 'c', newString: 'C', replaceAll: false }, st)
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-mixed'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  await auraEditLines(rootA, 3, 'C')
  const aura = read(rootA, 'f.txt')
  const expected = Buffer.from('a\nb\r\nC\nd\n')
  add('edit-mixed-eol', { native, aura, expected, same: native.equals(aura), nativeOk: native.equals(expected), auraOk: aura.equals(expected) })
}

console.log('')
console.log('=== F. overwrite: BOM file, content read then written ===')
{
  const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')])
  const rootN = mk('native-write-bom'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  const text = await p.readText(target)
  const st = await p.stat(target)
  await p.writeText(target, text, { kind: 'replaceIfVersion', version: st.version })
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-write-bom'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  await auraWrite(rootA, text)
  const aura = read(rootA, 'f.txt')
  add('overwrite-bom-preserved', { native, aura, expected: input, same: native.equals(aura), nativeOk: native.equals(input), auraOk: aura.equals(input) })
}

console.log('')
console.log('=== G. overwrite: existing CRLF, content uses LF ===')
{
  const input = Buffer.from('one\r\ntwo\r\n')
  const content = 'a\nb\n'
  const rootN = mk('native-write-eol'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  const st = await p.stat(target)
  await p.writeText(target, content, { kind: 'replaceIfVersion', version: st.version })
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-write-eol'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  await auraWrite(rootA, content)
  const aura = read(rootA, 'f.txt')
  add('overwrite-crlf-with-lf', { native, aura, expected: null, same: native.equals(aura), nativeOk: native.equals(Buffer.from(content)), auraOk: aura.equals(Buffer.from('a\r\nb\r\n')) })
}

console.log('')
console.log('=== H. stale: external change on another line ===')
{
  const input = Buffer.from('one\ntwo\nthree\n')
  const rootN = mk('native-stale-other'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  await p.readText(target)
  const st = await p.stat(target)
  fs.writeFileSync(path.join(rootN, 'f.txt'), 'one\ntwo\nEXTERNAL\n')
  let nativeError = null
  try { await p.editText(target, { oldString: 'one', newString: 'ONE', replaceAll: false }, st) } catch (e) { nativeError = e.code ?? e.message }
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-stale-other'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  fs.writeFileSync(path.join(rootA, 'f.txt'), 'one\ntwo\nEXTERNAL\n')
  const auraRes = await auraEditLines(rootA, 1, 'ONE')
  const aura = read(rootA, 'f.txt')
  add('stale-other-line', { native, aura, expected: null, same: native.equals(aura), nativeOk: nativeError !== null, auraOk: auraRes.json?.ok === true, nativeError, auraCode: auraRes.json?.code ?? 'ok', nativeText: native.toString('utf8'), auraText: aura.toString('utf8') })
}

console.log('')
console.log('=== I. stale: external change on the addressed line ===')
{
  const input = Buffer.from('one\ntwo\nthree\n')
  const rootN = mk('native-stale-same'); write(rootN, 'f.txt', input)
  const { p, target } = await nativeTarget(rootN)
  await p.readText(target)
  const st = await p.stat(target)
  fs.writeFileSync(path.join(rootN, 'f.txt'), 'one\ntwo-EXTERNAL\nthree\n')
  let nativeError = null
  try { await p.editText(target, { oldString: 'two', newString: 'TWO', replaceAll: false }, st) } catch (e) { nativeError = e.code ?? e.message }
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-stale-same'); write(rootA, 'f.txt', input)
  await auraRead(rootA)
  fs.writeFileSync(path.join(rootA, 'f.txt'), 'one\ntwo-EXTERNAL\nthree\n')
  const auraRes = await auraEditLines(rootA, 2, 'TWO')
  const aura = read(rootA, 'f.txt')
  add('stale-same-line', { native, aura, expected: null, same: native.equals(aura), nativeOk: nativeError !== null, auraOk: auraRes.json?.ok === false, nativeError, auraCode: auraRes.json?.code ?? 'ok', nativeText: native.toString('utf8'), auraText: aura.toString('utf8') })
}

console.log('')
console.log('=== J. multi-target: second target fails (native has no batch API) ===')
{
  const input = Buffer.from('A1\na2\n')
  const rootN = mk('native-multi'); write(rootN, 'f.txt', input); fs.mkdirSync(path.join(rootN, 'dir'))
  const { p, target } = await nativeTarget(rootN)
  await p.readText(target)
  const st = await p.stat(target)
  await p.writeText(target, 'A1\na2\n'.replace('A1', 'A9'), { kind: 'replaceIfVersion', version: st.version })
  // second "target" is a directory: native has no all-or-nothing batch; sequential write leaves the first applied.
  let nativeSecondError = null
  try {
    const dirTarget = await p.resolve('dir', { cwd: rootN })
    await p.writeText(dirTarget, 'X')
  } catch (error) {
    nativeSecondError = error.code ?? error.message
  }
  const native = read(rootN, 'f.txt')

  const rootA = mk('aura-multi'); write(rootA, 'f.txt', input); fs.mkdirSync(path.join(rootA, 'dir'))
  await auraRead(rootA)
  const spec = [
    { file_path: 'f.txt', hunks: [{ lines: [1, 1], replace: 'A9' }] },
    { file_path: 'dir', hunks: [{ lines: [1, 1], replace: 'X' }] },
  ]
  const auraRes = runAura(rootA, ['edit', '--targets', JSON.stringify(spec)])
  const aura = read(rootA, 'f.txt')
  add('multi-target-partial', { native, aura, expected: input, same: native.equals(aura), nativeOk: !native.equals(input), auraOk: aura.equals(input), nativeText: native.toString('utf8'), nativeCode: nativeSecondError, auraCode: auraRes.json?.code ?? 'ok' })
}

const report = {
  subject: 'aura-basetools@0.19.0',
  native: {
    package: '@deepseek-ai/dsh-fs-local@0.2.1-rc.2',
    entry: 'LocalFileSystem (readText/writeText/editText)',
    note: 'Direct provider; the model-facing read/write/edit tools call these methods. Version token from a prior read is passed where the default observation policy would pass it.',
  },
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  cases,
}
fs.writeFileSync(path.join(tmp, 'dsh-compare-results.json'), JSON.stringify(report, null, 2))
fs.copyFileSync(path.join(tmp, 'dsh-compare-results.json'), path.resolve('eval/independent/dsh-compare-results.json'))

const sameCount = cases.filter((c) => c.same).length
const lines = [
  '# aura-basetools@0.19.0 vs DSH 默认 Read/Write/Edit 背后的 provider',
  '',
  `- 被测 aura：\`${AURA}\`（npm 0.19.0）`,
  `- DSH：\`${report.native.package}\`，入口 \`LocalFileSystem.readText/writeText/editText\``,
  `- 平台：${report.platform}，Node ${report.node}`,
  `- 结果：${cases.length} 组，逐字节相同 ${sameCount} 组，不同 ${cases.length - sameCount} 组`,
  '',
  '> 直接调用 DSH 默认 Read/Write/Edit 背后的 provider；模型面工具只做参数解析/格式渲染/观测策略，写盘语义在这里。涉及“读后写”时传入读到的 version token，等价于默认 observation policy 的守卫。',
  '',
  '| 用例 | 原生结果 | aura 结果 | 是否逐字节相同 |',
  '|---|---|---|---|',
  ...cases.map((c) => `| ${c.name} | \`${show(c.native)}\` | \`${show(c.aura)}\` | ${c.same ? '相同' : '**不同**'} |`),
  '',
  '## 状态码（stale / multi）',
  '',
  '- `stale-other-line`：原生 `FS_STALE_VERSION`（整文件 version 挡住非重叠修改）；aura `ok`（区域未变，允许）。',
  '- `stale-same-line`：原生 `FS_STALE_VERSION`；aura `PATCH_STALE_REGION`。两者都拒绝，磁盘都保持外部内容。',
  '- `multi-target-partial`：原生第二个目标是目录 ⇒ `FS_NOT_REGULAR_FILE`，但第一个已写入（`A9`）；aura 整批零写入（`A1` 保留）。',
  '',
  '## 关键差异',
  '',
  '- **BOM**：DSH `readText` 用 `TextDecoder` 默认剥掉 BOM；`editText`/`writeText` 不会再补回。aura 的字节路径保留 BOM。',
  '- **混合行尾**：DSH `editText` 按检测到的行尾风格统一 `restoreLineEndings`；aura 保留逐行行尾。',
  '- **BOM 覆写**：从 DSH 读出的文本写回，BOM 已经不在字符串里；aura 的整份写保留已有 BOM。',
  '- **整文件写行尾**：DSH `writeText` 按 content 原样写；aura 覆写默认把 content 的新行适配成文件已有风格。',
  '- **陈旧闸粒度**：DSH 的 version 是整文件版本；外部改了别的行，按旧 version 的 edit 会拒绝。aura 的 `lines` 区域闸允许非重叠修改。',
  '- **多目标原子性**：DSH 没有多目标 API；顺序调用会在第二个目标失败时留下第一个写入。aura `--targets` 全量规划，失败零写入。',
  '',
  '## 这些差异不都是“aura 更好”',
  '',
  '- BOM/混合行尾/覆写行尾是**语义选择**：DSH 是文本层工具，读出来就是解码后的文本；aura 选择按字节保真。',
  '- 整文件写时，DSH 按 content 原样写；aura 默认把换行适配成文件已有风格——对“我就要写 LF”的调用方，DSH 更直接。',
  '- 陈旧粒度：aura 允许非重叠修改（更少阻塞），代价是调用方必须理解“区域不变”而不是“整文件不变”；需要整文件 CAS 时用 `expect`/整份写。',
  '',
  '## 局限',
  '',
  '- 这是 **provider 层** 对比；真实 DSH 宿主还会加沙箱、观察策略、格式渲染。',
  '- 只测了单进程；没有测 DSH 的并发锁/观察策略在不同宿主配置下的差异。',
  '- 原生侧用 `LocalFileSystem` 直接调用；没有启动完整 DSH agent。',
  '- 读接口没有做逐字节对照：原生 `read` 返回格式化文本，aura 返回结构化取景，二者不是同一形状；本表只比较写回语义。',
]
fs.writeFileSync(path.resolve('eval/independent/DSH-COMPARE.md'), lines.join('\n'))
console.log('')
console.log(`wrote eval/independent/DSH-COMPARE.md and dsh-compare-results.json (${cases.length} cases)`)
fs.rmSync(tmp, { recursive: true, force: true })
