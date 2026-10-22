/**
 * write-verify-test —— 落盘后**回读校验**（D2）。
 *
 * 命题（施工单终态）：写成功后必须把落盘内容**读回**，并与"我以为写下的"比对。
 *   不符 ⇒ `WRITE_VERIFY_FAILED` 且**如实报告**（保留写入结果，不假装成功）；
 *   相符 ⇒ 回执带验证证据（`write_verify`）。
 *
 * 为什么现在做：C10 的 BOM 丢失与 C12 的行尾归一化，**两次都是外面拿探针量出来的**，
 * 工具自己当时一声不吭。所以比对取**字节**而不是解码文本——解码比对看不见
 * (i) 前导 BOM 变化、(ii) 行尾改写，而那两个正是我们踩过的坑。
 *
 * mock 与真提供方同形：
 *   · readText = `TextDecoder('utf-8',{fatal:true})` 解原始字节（只剥一个前导 BOM）；
 *   · readByteRange = 原始字节窗口；文件不在 ⇒ `FS_NOT_FOUND`（与 `statRegularFile` 同形）；
 *   · writeText = 逐字节写 + `replaceIfVersion` 版本 CAS；
 *   · 「偷偷改写」模式**逐字复刻** `editText` 的收尾（dsh-fs-local/lib/index.js:566-583, :848）：
 *     normalizeLineEndings → detectLineEndings（首 4096 字节多数派）→ restoreLineEndings。
 *     用近似写法就等于没测：C12 的实测数字（24 → 23 字节）就是被这条收尾改出来的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contextServices } from './mock-ctx.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const TMP = path.join(os.tmpdir(), `write-verify-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

const encode = (text) => new TextEncoder().encode(text)
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const readBytes = (p) => fs.readFileSync(p)
const writeBytes = (p, text) => fs.writeFileSync(p, Buffer.from(encode(text)))
const readTextFile = (p) => decode(readBytes(p))
const byteLength = (text) => Buffer.byteLength(text, 'utf8')
const isBom = (bytes) => bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
/** 连前导 BOM 一起看（`decode` 会像提供方那样剥掉一个）——断言“磁盘上真有几个 BOM”时必须用它。 */
const decodeRaw = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
const fsError = (message, code) => Object.assign(new Error(message), { code })

// —— 提供方收尾逻辑（逐字复刻 dsh-fs-local:566-583，不许用近似）——
const normalizeLineEndings = (content) => content.replaceAll('\r\n', '\n')
const detectLineEndings = (raw) => {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF'
}
const restoreLineEndings = (content, lineEndings) =>
  lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')

let version = 1
const calls = { writeText: 0, editText: 0 }
/** null=忠实提供方 | 'normalize'=落盘后把整份行尾归一到多数派 | 'unlink'=落盘后删文件 */
let stealth = null

const fsService = {
  resolve: async (p) => ({ displayPath: p, targetKey: p }),
  stat: async (t) =>
    fs.existsSync(t.targetKey)
      ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size }
      : undefined,
  readText: async (t) => {
    if (!fs.existsSync(t.targetKey)) throw fsError(`cannot read "${t.displayPath}": not found`, 'FS_NOT_FOUND')
    return readTextFile(t.targetKey)
  },
  readByteRange: async (t, range) => {
    if (!fs.existsSync(t.targetKey)) throw fsError(`cannot read "${t.displayPath}": not found`, 'FS_NOT_FOUND')
    return readBytes(t.targetKey).subarray(range.offset, range.offset + range.length)
  },
  /** 真提供方 `:821-839`：逐字节写 + 版本 CAS。 */
  writeText: async (t, content, expected) => {
    calls.writeText += 1
    const p = t.targetKey
    const existed = fs.existsSync(p)
    if (expected?.kind === 'replaceIfVersion') {
      if (!existed) throw fsError('file no longer exists', 'FS_STALE_VERSION')
      if (`v${version}` !== expected.version) throw fsError('file changed since it was read', 'FS_STALE_VERSION')
    } else if (expected?.kind === 'createIfAbsent' && existed) {
      throw fsError('cannot overwrite existing file', 'FS_NOT_OBSERVED')
    }
    writeBytes(p, content)
    version += 1
    if (stealth === 'normalize') {
      // 提供方在落盘之后又把整份内容改了一遍：等价于 editText 的收尾。
      const raw = readTextFile(p)
      writeBytes(p, restoreLineEndings(normalizeLineEndings(raw), detectLineEndings(raw)))
    }
    if (stealth === 'unlink') fs.rmSync(p)
    return { version: `v${version}`, operation: existed ? 'update' : 'create', after: content }
  },
  /** 不该被走到：写回走 writeText。被调用就记数，末尾断言为 0。 */
  editText: async () => {
    calls.editText += 1
    throw new Error('editText must not be used by the write path')
  },
}

const readPlugin = await import('../aura-read/index.js')
const editPlugin = await import('../aura-edit/index.js')
let readTool = null
let editTool = null
const tools = { register: (t) => (t.name === 'aura_read' ? (readTool = t) : (editTool = t)), get: () => readTool }
const mkCtx = () => ({
  fs: fsService,
  ...contextServices(),
  tools,
  emit: () => {},
  systemPrompt: { section: () => () => {} },
  waterfall: async () => {
    throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
  },
})
readPlugin.apply(mkCtx())
editPlugin.apply(mkCtx())
const exec = { agent: { session: { header: { cwd: TMP } } }, signal: undefined }
const read = (file, args = {}) => readTool.execute({ file_path: file, ...args }, exec)
const call = async (args) => {
  try {
    return { ok: true, out: await editTool.execute(args, exec) }
  } catch (error) {
    return { ok: false, error }
  }
}
const attempt = (file, hunks) => call({ file_path: file, hunks })

// ── 段A：提供方在落盘后偷偷改写 ⇒ 今天静默通过，必须变成结构化失败 ──────────
say('=== A. 落盘后被偷偷改写（复刻 editText 的多数派行尾归一）⇒ 必须 WRITE_VERIFY_FAILED ===')
const A_BEFORE = 'alpha\r\nbravo\r\ncharlie\ndelta\r\n' // 混合行尾，CRLF 是多数派
const A_INTENDED = 'alpha\r\nbravo\r\nCHARLIE\ndelta\r\n' // 我们以为写下的（逐行行尾保留）
const A_LANDED = 'alpha\r\nbravo\r\nCHARLIE\r\ndelta\r\n' // 提供方改后的样子（全 CRLF）
{
  const file = path.join(TMP, 'a-mixed.md')
  writeBytes(file, A_BEFORE)
  await read(file, { mode: 'full' })
  stealth = 'normalize'
  const r = await attempt(file, [{ lines: [3, 3], replace: 'CHARLIE' }])
  stealth = null
  check(!r.ok && r.error.code === 'WRITE_VERIFY_FAILED', 'A 被偷偷改写 ⇒ WRITE_VERIFY_FAILED', `${r.error?.code ?? 'ok（静默通过）'}`)
  const wv = r.error?.write_verify
  check(
    wv?.level === 'bytes' && wv.expected_bytes === byteLength(A_INTENDED) && wv.actual_bytes === byteLength(A_LANDED),
    'A 回执给出两边字节数',
    JSON.stringify(wv ?? null),
  )
  check(
    wv?.expected_line_endings?.crlf === 3 && wv?.actual_line_endings?.crlf === 4,
    'A 行尾普查点名“被归一到 CRLF 多数派”',
    `${JSON.stringify(wv?.expected_line_endings ?? null)} -> ${JSON.stringify(wv?.actual_line_endings ?? null)}`,
  )
  check(wv?.first_diff_offset === 21, 'A 首个差异字节指向第 3 行行尾（偏移 21）', `${wv?.first_diff_offset}`)
  check(readTextFile(file) === A_LANDED, 'A 写入结果**不被回滚**（磁盘就是提供方改后的样子）', JSON.stringify(readTextFile(file)))
}

// ── 段B：正常写回不许误报 ──────────────────────────────────────────────────
say('')
say('=== B. 正常写回：相符 ⇒ 成功 + 回执带验证证据 ===')
{
  const file = path.join(TMP, 'b1.md')
  writeBytes(file, 'one\r\ntwo\r\nthree\r\n')
  await read(file, { mode: 'full' })
  const r = await attempt(file, [{ lines: [2, 2], replace: 'TWO' }])
  check(r.ok, 'B1 统一 CRLF 正常写回不误报', `${r.ok ? 'ok' : r.error?.code}`)
  check(r.ok && r.out.write_verify?.level === 'bytes', 'B1 回执带 level=bytes 的验证证据', JSON.stringify(r.out?.write_verify ?? null))
  check(
    r.ok && r.out.write_verify?.bytes === fs.statSync(file).size,
    'B1 验的是**整份**文件（字节数 = 文件大小，没有抽样）',
    `${r.out?.write_verify?.bytes} vs ${fs.statSync(file).size}`,
  )
  check(readTextFile(file) === 'one\r\nTWO\r\nthree\r\n', 'B1 磁盘逐字节等于“我以为写下的”', JSON.stringify(readTextFile(file)))
}
{
  const file = path.join(TMP, 'b2.md')
  writeBytes(file, 'x\ny\r\nz\n') // 混合行尾 + LF 多数派
  await read(file, { mode: 'full' })
  const r = await attempt(file, [{ lines: [1, 1], replace: 'X' }])
  check(r.ok, 'B2 混合行尾正常写回不误报', `${r.ok ? 'ok' : r.error?.code}`)
  check(readTextFile(file) === 'X\ny\r\nz\n', 'B2 非目标行的行尾一个都没被碰（C12 的立身之本）', JSON.stringify(readTextFile(file)))
}
{
  const file = path.join(TMP, 'b3.md')
  writeBytes(file, '\uFEFFconst one = 1\nconst two = 2\n') // 磁盘上带 BOM
  await read(file, { mode: 'changed' })
  const r = await attempt(file, [{ lines: [1, 1], replace: 'const one = 9' }])
  check(r.ok, 'B3 C13 段K 场景（BOM + changed 读 + 改第 1 行）不误报', `${r.ok ? 'ok' : r.error?.code}`)
  check(isBom(readBytes(file)), 'B3 写回后 BOM 仍在（C10 不许退化）', JSON.stringify([...readBytes(file).subarray(0, 3)]))
}

// ── 段C：回读失败（文件被删 / 不可读）⇒ 结构化报告，不许吞 ─────────────────
say('')
say('=== C. 回读失败：结构化报告 + 底层错误码，不许吞 ===')
{
  const file = path.join(TMP, 'c1.md')
  writeBytes(file, 'alpha\nbravo\n')
  await read(file, { mode: 'full' })
  stealth = 'unlink'
  const r = await attempt(file, [{ lines: [1, 1], replace: 'ALPHA' }])
  stealth = null
  check(!r.ok && r.error.code === 'WRITE_VERIFY_FAILED', 'C1 回读读不到（文件被删）⇒ WRITE_VERIFY_FAILED', `${r.error?.code ?? 'ok'}`)
  check(
    r.error?.write_verify?.readback_error === 'FS_NOT_FOUND',
    'C1 带回底层错误码（没有被吞掉）',
    JSON.stringify(r.error?.write_verify ?? null),
  )
  check(/not rolled back/i.test(String(r.error?.message ?? '')), 'C1 消息说明写入**未回滚**（如实报告）', JSON.stringify(String(r.error?.message ?? '')))
}
{
  // 后端没有字节接口（仓库里几个 mock 就是这种形状）⇒ 退化到文本级回读；文本级读不到也要结构化。
  const file = path.join(TMP, 'c2.md')
  writeBytes(file, 'alpha\nbravo\n')
  await read(file, { mode: 'full' })
  const saved = fsService.readByteRange
  delete fsService.readByteRange
  stealth = 'unlink'
  const r = await attempt(file, [{ lines: [1, 1], replace: 'ALPHA' }])
  stealth = null
  fsService.readByteRange = saved
  check(
    !r.ok && r.error.code === 'WRITE_VERIFY_FAILED' && r.error.write_verify?.level === 'text',
    'C2 无字节接口 ⇒ 文本级回读，失败仍结构化（level 明说是 text）',
    `${r.error?.code ?? 'ok'} / ${JSON.stringify(r.error?.write_verify ?? null)}`,
  )
}

// ── 段D：带 BOM 的文件写回后回读必须仍然相符 ───────────────────────────────
say('')
say('=== D. 带 BOM 的文件：写回后回读仍相符，且 BOM 不丢 ===')
{
  const file = path.join(TMP, 'd1.md')
  writeBytes(file, '\uFEFFalpha\r\nbravo\r\n')
  await read(file, { mode: 'changed' })
  const r = await attempt(file, [{ lines: [2, 2], replace: 'BRAVO' }])
  const bytes = readBytes(file)
  check(r.ok && r.out.write_verify?.level === 'bytes', 'D1 带 BOM + changed 读 ⇒ 回读相符', `${r.ok ? JSON.stringify(r.out.write_verify) : r.error?.code}`)
  check(r.ok && r.out.write_verify?.bytes === bytes.length, 'D1 校验字节数含 BOM（= 文件大小）', `${r.out?.write_verify?.bytes} vs ${bytes.length}`)
  check(isBom(bytes), 'D1 BOM 仍在', JSON.stringify([...bytes.subarray(0, 3)]))
  check(decodeRaw(bytes) === '\uFEFFalpha\r\nBRAVO\r\n', 'D1 磁盘逐字节等于意图（BOM + 逐行行尾）', JSON.stringify(decodeRaw(bytes)))
}
{
  const file = path.join(TMP, 'd2.md')
  writeBytes(file, '\uFEFFline one\nline two\nline three\n')
  await read(file, { mode: 'full' })
  const r = await attempt(file, [{ lines: [3, 3], replace: 'line three!' }])
  check(r.ok && isBom(readBytes(file)), 'D2 带 BOM + full 读 ⇒ 回读相符且 BOM 仍在', `${r.ok ? 'ok' : r.error?.code}`)
}

// ── 段E：create 也是“写成功” ⇒ 同样回读校验 ────────────────────────────────
say('')
say('=== E. create 路径同样回读校验 ===')
{
  const file = path.join(TMP, 'e1.md')
  const created = await call({ file_path: file, create: '\uFEFFalpha\nbravo\n' })
  const bytes = readBytes(file)
  check(created.ok, 'E1 create 成功', `${created.ok ? 'ok' : created.error?.code}`)
  check(
    created.ok && created.out.write_verify?.level === 'bytes' && created.out.write_verify.bytes === bytes.length,
    'E1 create 也做回读校验（bytes = 文件大小）',
    JSON.stringify(created.out?.write_verify ?? null),
  )
  check(isBom(bytes), 'E1 内容以 U+FEFF 开头 ⇒ 磁盘确实带 BOM', JSON.stringify([...bytes.subarray(0, 3)]))
}
{
  const file = path.join(TMP, 'e2.md')
  const created = await call({ file_path: file, create: 'alpha\nbravo\n' })
  check(
    created.ok && created.out.write_verify?.bytes === 12,
    'E2 普通 create 的回读字节数正确',
    JSON.stringify(created.out?.write_verify ?? null),
  )
}
{
  const file = path.join(TMP, 'e3.md')
  stealth = 'normalize'
  const created = await call({ file_path: file, create: 'a\r\nb\r\nc\n' })
  stealth = null
  check(!created.ok && created.error.code === 'WRITE_VERIFY_FAILED', 'E3 create 被偷偷改写 ⇒ WRITE_VERIFY_FAILED（create 也校验）', `${created.ok ? 'ok（静默通过）' : created.error?.code}`)
  check(
    created.error?.write_verify?.expected_line_endings?.lf === 1 && created.error?.write_verify?.actual_line_endings?.lf === 0,
    'E3 create 的普查同样点名行尾被归一',
    JSON.stringify(created.error?.write_verify ?? null),
  )
}
// ── 段F：写后观测必须取**提供方视角**（前导 BOM 只被提供方剥一次）──────────
say('')
say('=== F. 写后观测 = 提供方视角：随后的未断言编辑不许误拒 ===')
{
  // F1：create 的内容自带前导 U+FEFF ⇒ 下一次 readText 会剥掉它；观测必须先剥，否则第 1 行对不上。
  const file = path.join(TMP, 'e1.md')
  const r = await attempt(file, [{ lines: [1, 1], replace: 'ALPHA' }])
  check(r.ok, 'F1 create 带 BOM 之后，未断言的编辑第 1 行不许误拒', `${r.ok ? 'ok' : r.error?.code}`)
  check(isBom(readBytes(file)), 'F1 编辑后 BOM 仍在', JSON.stringify([...readBytes(file).subarray(0, 3)]))
  check(decodeRaw(readBytes(file)) === '\uFEFFALPHA\nbravo\n', 'F1 磁盘 = 一个 BOM + 改后的内容', JSON.stringify(decodeRaw(readBytes(file))))
}
{
  // F2：replace 自己带前导 U+FEFF ⇒ 落盘确实带 BOM（调用方的显式意图），观测同样要取提供方视角。
  const file = path.join(TMP, 'f2.md')
  writeBytes(file, 'alpha\nbravo\n')
  await read(file, { mode: 'full' })
  const first = await attempt(file, [{ lines: [1, 1], replace: '\uFEFFALPHA' }])
  check(first.ok && isBom(readBytes(file)), 'F2 replace 自带前导 U+FEFF ⇒ 落盘确实带 BOM', `${first.ok ? 'ok' : first.error?.code} ${JSON.stringify([...readBytes(file).subarray(0, 3)])}`)
  const second = await attempt(file, [{ lines: [1, 1], replace: 'ALPHA2' }])
  check(second.ok, 'F2 随后的未断言编辑不许误拒（观测必须是提供方视角）', `${second.ok ? 'ok' : second.error?.code}`)
}

// ── 段G：dry_run 不落盘 ⇒ 不回读、不带验证字段 ─────────────────────────────
say('')
say('=== G. dry_run：不落盘 ⇒ 不回读 ===')
{
  const file = path.join(TMP, 'g.md')
  writeBytes(file, 'alpha\nbravo\n')
  await read(file, { mode: 'full' })
  const before = calls.writeText
  const r = await call({ file_path: file, hunks: [{ lines: [1, 1], replace: 'ALPHA' }], dry_run: true })
  check(r.ok && r.out.dryRun === true && r.out.write_verify === undefined, 'G dry_run 回执不带 write_verify', JSON.stringify(r.out?.write_verify ?? null))
  check(r.ok && calls.writeText === before && readTextFile(file) === 'alpha\nbravo\n', 'G dry_run 没有落盘（writeText 次数未增加）', `writeText=${calls.writeText}`)
}

// ── 段H：回执字段必须在 output.schema 里声明（C13 的 unverified_region 踩过一次）──
say('')
say('=== H. 回执字段与 output.schema 一致（未声明的字段会被框架整条拒掉）===')
{
  const declared = editTool.output?.schema?.properties ?? {}
  const file = path.join(TMP, 'h.md')
  writeBytes(file, 'alpha\nbravo\n')
  await read(file, { mode: 'full' })
  const patched = await attempt(file, [{ lines: [1, 1], replace: 'ALPHA' }])
  const dry = await call({ file_path: file, hunks: [{ lines: [1, 1], replace: 'A' }], dry_run: true })
  const made = await call({ file_path: path.join(TMP, 'h2.md'), create: 'x\n' })
  for (const [label, out] of [['编辑', patched], ['dry_run', dry], ['create', made]]) {
    const undeclared = out.ok ? Object.keys(out.out).filter((k) => !(k in declared)) : ['（本次调用失败）']
    check(undeclared.length === 0, `H ${label} 回执字段都在 schema 里`, undeclared.join(',') || 'ok')
  }
  check('write_verify' in declared, 'H write_verify 已在 output.schema 声明', Object.keys(declared).join(','))
  check(
    declared.write_verify?.required?.includes('level') === true && 'bytes' in (declared.write_verify?.properties ?? {}),
    'H write_verify 的形状与 schema 一致（level 必填 + bytes）',
    JSON.stringify(declared.write_verify ?? null),
  )
  check(
    patched.ok && typeof patched.out.write_verify?.bytes === 'number',
    'H 编辑回执的 write_verify = {level, bytes}，没有 schema 外的字段',
    JSON.stringify(patched.out?.write_verify ?? null),
  )
}

// ── 收尾：写回路径仍然是 writeText ─────────────────────────────────────────
say('')
check(calls.editText === 0 && calls.writeText > 0, `写回路径：writeText ${calls.writeText} 次 / editText ${calls.editText} 次`)

fs.rmSync(TMP, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
  process.exitCode = 1
}
