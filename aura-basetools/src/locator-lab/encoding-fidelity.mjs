/**
 * encoding-fidelity —— 写路径的**字节保真**：BOM 与行尾。
 *
 * 为什么单独一个文件盯这件事：BOM 的丢失是**静默**的，而且发生在依赖包里（不许改它）：
 *   · `dsh-fs-local/lib/index.js:315` 用 `new TextDecoder('utf-8', {fatal:true})` 解码，
 *     而 `ignoreBOM` 默认 false ⇒ **BOM 不进解码后的字符串**；
 *   · 写回用 `TextEncoder`，它**从不**产出 BOM。
 * 于是任何一次编辑都会永久丢掉 BOM，而没有任何信号。第二个后果更隐蔽：
 * `aura_basetools_read` 的版本令牌算在解码后的字符串上，只差 BOM 的两个文件因此拿到**同一个令牌**——
 * `changed` 会说"没变"。
 *
 * 判据只能来自**字节**：提供方的 `readByteRange`（接口声明见
 * `dsh-fs-local/lib/types/index.d.ts:56`，实现在同包 `lib/index.js:800`）。
 *
 * mock 必须与真提供方**同形**（`mock-ctx.mjs` 的教训：mock 比框架宽松就等于没测）：
 *   readText      = TextDecoder('utf-8', {fatal:true})  —— BOM 被丢掉（这是缺陷的入口）
 *   readByteRange = 原始字节                            —— BOM 的唯一判据
 *   editText      = 字面替换 + TextEncoder              —— 内容首字符是 U+FEFF 才落盘 EF BB BF
 *
 * 三段：(A) BOM 经编辑仍在 (B) 只差 BOM 的两文件令牌不同 (C) LF/CRLF 逐文件保留。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contentToken, startsWithByteOrderMark } from './read-core.mjs'
import { contextServices } from './mock-ctx.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const BOM_BYTES = [0xef, 0xbb, 0xbf]
const bytesStartWithBom = (bytes) => bytes.length >= BOM_BYTES.length && BOM_BYTES.every((b, i) => bytes[i] === b)
const describeHead = (bytes) => `首三字节 ${JSON.stringify([...bytes.subarray(0, 3)])}`
const loneLf = (bytes) => {
  let n = 0
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) n += 1
  return n
}
const crCount = (bytes) => [...bytes].filter((b) => b === 0x0d).length
const lfCount = (bytes) => [...bytes].filter((b) => b === 0x0a).length

const tmp = path.join(os.tmpdir(), `encoding-fidelity-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const readBytes = (p) => new Uint8Array(fs.readFileSync(p))
const writeBytes = (p, bytes) => fs.writeFileSync(p, Buffer.from(bytes))
const encode = (s) => new TextEncoder().encode(s)
const decode = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b)
const withBom = (text) => Buffer.concat([Buffer.from(BOM_BYTES), Buffer.from(encode(text))])

// ── mock：与真提供方同形 ────────────────────────────────────────────────────
let version = 1
const fsService = {
  resolve: async (p) => ({ displayPath: p, targetKey: p }),
  stat: async (t) => (fs.existsSync(t.targetKey) ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
  // 真提供方 readWholeText → decodeUtf8 → TextDecoder（BOM 被吃掉）。mock 必须照做，
  // 否则本测试测的是一个真机上不存在的世界。
  readText: async (t) => decode(readBytes(t.targetKey)),
  // 真提供方 readByteRange：窗口读，不decode、不拒二进制。BOM 只能从这里看出来。
  readByteRange: async (t, range) => readBytes(t.targetKey).subarray(range.offset, range.offset + range.length),
  editText: async (t, req) => {
    const current = decode(readBytes(t.targetKey))
    const n = current.split(req.oldString).length - 1
    if (n === 0) throw Object.assign(new Error('old_string was not found'), { code: 'FS_EDIT_NOT_FOUND' })
    if (n > 1) throw Object.assign(new Error(`old_string matched ${n} times`), { code: 'FS_AMBIGUOUS_EDIT' })
    const next = current.split(req.oldString).join(req.newString)
    // 真提供方用 TextEncoder 落盘：内容里没有 U+FEFF 就**没有** BOM。
    writeBytes(t.targetKey, encode(next))
    version += 1
    return { version: `v${version}`, operation: 'update', before: current, after: next }
  },
}

const readPlugin = await import('../aura-read/index.js')
const editPlugin = await import('../aura-edit/index.js')
let readTool = null
let editTool = null
const sharedTools = { register: (t) => (t.name === 'aura_basetools_read' ? (readTool = t) : (editTool = t)), get: () => readTool }
const mkCtx = () => ({
  fs: fsService,
  ...contextServices(),
  tools: sharedTools,
  emit: () => {},
  systemPrompt: { section: () => () => {} },
  waterfall: async () => {
    throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
  },
})
readPlugin.apply(mkCtx())
editPlugin.apply(mkCtx())
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
check(readTool !== null && editTool !== null, 'aura_basetools_read 与 aura_basetools_edit 都注册成功', `${readTool?.name} / ${editTool?.name}`)

const read = (file, args = {}) => readTool.execute({ file_path: file, ...args }, exec)
// 1.0.2 覆盖闸：整段替换要落在交付过的正文上——先按真实读走一次全份。
// 用 lines 而不是 full：full 会写下增量基线，后面按版本令牌取回执的判据会拿到"无变化"。
const edit = async (file, hunks, extra = {}) => {
  const total = fs.readFileSync(file, 'utf8').split('\n').length
  await read(file, { mode: 'lines', lines: [1, total] })
  return editTool.execute({ file_path: file, hunks, ...extra }, exec)
}

// ── mock 自检：readText 真的会丢 BOM（否则本文件测不出东西） ─────────────────
say('')
say('=== 0. mock 与真提供方同形（mock 自检）===')
{
  const p = path.join(tmp, 'mock-shape.txt')
  writeBytes(p, withBom('hello\n'))
  const text = await fsService.readText({ targetKey: p })
  check(!text.startsWith('\uFEFF'), 'mock 的 readText 丢掉了 BOM（与 dsh-fs-local 的 TextDecoder 同形）', JSON.stringify(text))
  const head = await fsService.readByteRange({ targetKey: p }, { offset: 0, length: 3 })
  check(bytesStartWithBom(head), 'mock 的 readByteRange 给出原始字节（BOM 的唯一判据）', describeHead(head))
  writeBytes(path.join(tmp, 'mock-encode.txt'), encode('hello\n'))
  check(!bytesStartWithBom(readBytes(path.join(tmp, 'mock-encode.txt'))), 'mock 的写路径是 TextEncoder：内容没 BOM 就不落 BOM')
  // 判据自身的边界：提供方文档说窗口在文件内结束时会更短，因此三种短窗口都是真实输入
  check(startsWithByteOrderMark(new Uint8Array([0xef, 0xbb, 0xbf])), '判据：完整 BOM 窗口为真')
  check(!startsWithByteOrderMark(new Uint8Array([0xef, 0xbb])), '判据：不足三字节不算 BOM（两字节文件是真实存在的）')
  check(!startsWithByteOrderMark(new Uint8Array(0)), '判据：空窗口不算 BOM（offset 落在文件末尾）')
  check(!startsWithByteOrderMark(undefined), '判据：拿不到字节时不算 BOM')
}

// ── A 段：BOM 经编辑仍在 ────────────────────────────────────────────────────
say('')
say('=== A. BOM 文件经 aura_basetools_edit 编辑后首三字节仍是 EF BB BF ===')
const BOM_SRC = 'export function alpha(a) {\n  return a;\n}\n'
const bomFile = path.join(tmp, 'bom.js')
writeBytes(bomFile, withBom(BOM_SRC))
check(bytesStartWithBom(readBytes(bomFile)), 'A 夹具自检：编辑前首三字节是 BOM', describeHead(readBytes(bomFile)))

const bomEdit = await edit(bomFile, [{ target: 'alpha', replace: 'export function alpha(a) {\n  return a * 2;\n}' }])
check(bomEdit.applied.length === 1, 'A 编辑成功（1 条回执）')
const afterBomBytes = readBytes(bomFile)
check(bytesStartWithBom(afterBomBytes), 'A 编辑后首三字节仍是 EF BB BF', describeHead(afterBomBytes))
check(
  decode(afterBomBytes) === 'export function alpha(a) {\n  return a * 2;\n}\n',
  'A 编辑后正文正确（BOM 之外的内容与期望逐字相等）',
  JSON.stringify(decode(afterBomBytes)),
)
check(!bytesStartWithBom(afterBomBytes.subarray(3)), 'A BOM 没有被写成两个', describeHead(afterBomBytes.subarray(3)))

// ── B 段：只差 BOM 的两个文件令牌必须不同 ───────────────────────────────────
say('')
say('=== B. version 令牌能区分只差 BOM 的两个文件 ===')
const plainFile = path.join(tmp, 'plain.js')
const bomTwin = path.join(tmp, 'twin.js')
writeBytes(plainFile, encode(BOM_SRC))
writeBytes(bomTwin, withBom(BOM_SRC))
check(!bytesStartWithBom(readBytes(plainFile)) && bytesStartWithBom(readBytes(bomTwin)), 'B 夹具自检：两个文件只差 BOM')

const plainRead = await read(plainFile, { mode: 'full' })
const bomRead = await read(bomTwin, { mode: 'full' })
check(typeof plainRead.version === 'string' && typeof bomRead.version === 'string', 'B 两次读取都拿到令牌', `${plainRead.version} / ${bomRead.version}`)
check(plainRead.version !== bomRead.version, 'B 只差 BOM 的两个文件令牌不同', `不带 BOM=${plainRead.version} 带 BOM=${bomRead.version}`)

// 令牌必须与"字节 + 内容"给出一致答案：带 BOM 的文件令牌 == 含 U+FEFF 内容的指纹
check(bomRead.version === contentToken(BOM_SRC, true), 'B 带 BOM 文件的令牌等于"含 U+FEFF 内容"的指纹', `实际 ${bomRead.version}`)
check(plainRead.version === contentToken(BOM_SRC, false), 'B 不带 BOM 文件的令牌等于普通内容指纹', `实际 ${plainRead.version}`)
const again = await read(bomTwin, { mode: 'full' })
check(again.version === bomRead.version, 'B 同一文件重复读取令牌稳定（不依赖 mtime）', `${bomRead.version} -> ${again.version}`)

// 自洽：BOM 被外部改掉时，changed 必须把它当成一次**真实改动**报出来
// （先走一次 changed 把基准记下来：基准缓存由 changed 自己填充，这是引擎既有行为）
const prime = await read(bomTwin, { since: bomRead.version })
check(prime.mode === 'changed' && String(prime.note ?? '').includes('no change'), 'B 基准读取：内容未变 ⇒ changed 说没变', JSON.stringify(prime.note ?? ''))
writeBytes(bomTwin, encode(BOM_SRC))
const delta = await read(bomTwin, { since: bomRead.version })
check(delta.version !== bomRead.version, 'B BOM 被外部去掉后令牌随之变化', `${bomRead.version} -> ${delta.version}`)
check(!String(delta.note ?? '').includes('no change'), 'B BOM 变了就不许说 "no change"', JSON.stringify(delta.note ?? ''))
check(
  /changed region/.test(delta.text ?? ''),
  'B BOM 的变化被当成一次真实改动报出改动窗口',
  JSON.stringify((delta.text ?? '').split('\n').slice(0, 2).join(' | ')),
)

// 编辑保住 BOM 之后，令牌必须等于"编辑后含 BOM 内容"的指纹（三处给出一致答案）
const bomAgain = await read(bomFile, { mode: 'full' })
check(
  bomAgain.version === contentToken(decode(readBytes(bomFile)), true),
  'B 编辑后的令牌 == 落盘字节（带回读内容）的指纹',
  `令牌 ${bomAgain.version}，落盘 ${describeHead(readBytes(bomFile))}`,
)

// ── C 段：行尾逐文件保留 ────────────────────────────────────────────────────
say('')
say('=== C. 回归：LF 仍 LF、CRLF 仍 CRLF ===')
const lfFile = path.join(tmp, 'lf.js')
writeBytes(lfFile, encode('export function beta(b) {\n  return b;\n}\n'))
await edit(lfFile, [{ target: 'beta', replace: 'export function beta(b) {\n  return b + 1;\n}' }])
const lfAfter = readBytes(lfFile)
check(loneLf(lfAfter) === lfCount(lfAfter) && crCount(lfAfter) === 0, 'C LF 文件编辑后没有引入 CR', `LF ${lfCount(lfAfter)} / lone LF ${loneLf(lfAfter)} / CR ${crCount(lfAfter)}`)

const crlfFile = path.join(tmp, 'crlf.js')
const CRLF_SRC = 'export function gamma(c) {\r\n  return c;\r\n}\r\n'
writeBytes(crlfFile, encode(CRLF_SRC))
await edit(crlfFile, [{ target: 'gamma', replace: 'export function gamma(c) {\r\n  return c + 2;\r\n}' }])
const crlfAfter = readBytes(crlfFile)
check(
  loneLf(crlfAfter) === 0 && crCount(crlfAfter) === lfCount(crlfAfter),
  'C CRLF 文件编辑后每一行仍是 CRLF',
  `LF ${lfCount(crlfAfter)} / lone LF ${loneLf(crlfAfter)} / CR ${crCount(crlfAfter)}`,
)

// CRLF + BOM 同时存在：两件事都要保住
const bothFile = path.join(tmp, 'both.js')
writeBytes(bothFile, Buffer.concat([Buffer.from(BOM_BYTES), Buffer.from(encode(CRLF_SRC))]))
await edit(bothFile, [{ target: 'gamma', replace: 'export function gamma(c) {\r\n  return c + 3;\r\n}' }])
const bothAfter = readBytes(bothFile)
check(bytesStartWithBom(bothAfter), 'C CRLF+BOM 文件编辑后 BOM 仍在', describeHead(bothAfter))
check(
  loneLf(bothAfter) === 0 && crCount(bothAfter) === lfCount(bothAfter),
  'C CRLF+BOM 文件编辑后行尾仍是 CRLF',
  `LF ${lfCount(bothAfter)} / lone LF ${loneLf(bothAfter)} / CR ${crCount(bothAfter)}`,
)

// ── D 段：后端差异——readText 保留了 BOM 时不许写成两个 ─────────────────────
say('')
say('=== D. 另一种 fs 后端：readText 保留 BOM 时不许写成两个 ===')
// Node 的 `fs.readFileSync(p, 'utf8')` **不**去 BOM（仓库里现有的 mock 就是这么写的），
// 因此“提供方把 BOM 留在了内容里”是真实存在的后端形态，
// `carryingByteOrderMark` 的“已经带了就不重复加”那一条必须被真的走到，而不是永不执行。
const keepingFs = {
  ...fsService,
  readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
  editText: async (t, req) => {
    const current = fs.readFileSync(t.targetKey, 'utf8')
    const n = current.split(req.oldString).length - 1
    if (n === 0) throw Object.assign(new Error('old_string was not found'), { code: 'FS_EDIT_NOT_FOUND' })
    const next = current.split(req.oldString).join(req.newString)
    fs.writeFileSync(t.targetKey, next, 'utf8')
    version += 1
    return { version: `v${version}`, operation: 'update', before: current, after: next }
  },
}
readPlugin.apply({ ...mkCtx(), fs: keepingFs })
editPlugin.apply({ ...mkCtx(), fs: keepingFs })
const keepFile = path.join(tmp, 'keep-bom.js')
writeBytes(keepFile, withBom(BOM_SRC))
check(fs.readFileSync(keepFile, 'utf8').startsWith('\uFEFF'), 'D 夹具自检：该后端的 readText 确实保留了 BOM')
// 关键：改的是**第 2 行**——第 1 行（带 U+FEFF 的那一行）会原样留在新内容里。
// 如果改的是第 1 行，新内容首字符就不是 BOM 了，这条守卫永远不会被走到（第一次就是这么写错的）。
await edit(keepFile, [{ lines: [2], expect: '  return a;', replace: '  return a * 9;' }])
const keepAfter = readBytes(keepFile)
check(bytesStartWithBom(keepAfter), 'D BOM 仍在', describeHead(keepAfter))
check(
  !bytesStartWithBom(keepAfter.subarray(3)),
  'D BOM 没有被写成两个（内容已经带 BOM 时不重复加）',
  describeHead(keepAfter.subarray(3)),
)
// 用"去 BOM"的解码器比正文（BOM 本身由上面两条字节断言负责）
check(
  decode(keepAfter) === 'export function alpha(a) {\n  return a * 9;\n}\n',
  'D 正文已改，且 BOM 之外逐字相等',
  JSON.stringify(decode(keepAfter)),
)

fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
  process.exitCode = 1
}
