/**
 * byte-fidelity —— 一次编辑的**字节影响面**。
 *
 * 命题（施工单终态）：一次编辑只改被寻址的那一段——
 *   · 被编辑行的行尾字节与编辑前逐字节相同（除非 `replace` 自己带了行尾）；
 *   · 文件前导 BOM 的**个数**在编辑前后相同；
 *   · 其余字节完全不变。
 *
 * 为什么单独一个文件盯它：这两种破坏都是**静默删/改字节**，不报错、不改行数，
 * 只是文件少了 1 个字节或某一行的行尾换了风格（实测装置：`%TEMP%\aura-byte\`）。
 *
 * 三个已知缺口（本文件开工时的红）：
 *   F-a `double_bom.md`（BOM+BOM+…）编辑后少一个 BOM——幂等守卫把“文本开头那个 U+FEFF 是**内容**”
 *       误判成“提供方已经把 BOM 留在文本里了”。判据要数**个数**，不是布尔。
 *   F-b `mixed.md`（`a\r\nb\nc\r\n`）被编辑那一行的 LF 被改成 CRLF——整份文件按“主流行尾”重写。
 *       判据是**逐行**行尾：被替换区域继承它替换掉的那一行的行尾。
 *   F-c `lone_cr.md`（老 Mac 单 `\r`）整份被当成一行，`lines=[2,2]` 报“outside 1..1”。
 *
 * ### C12：mock 必须逐字复刻真提供方（不再是“近似”），它本身成为判据
 *
 *   readText      = `new TextDecoder('utf-8', {fatal:true})`（BOM 只被吃掉第一个）
 *   readByteRange = 原始字节（BOM 个数的唯一判据）
 *   editText      = **真提供方的整条链子**（读→LF 归一→字面替换→行尾还原→写）：
 *                   `:566` normalizeLineEndings / `:569` detectLineEndings（首 4096 字节多数派）
 *                   / `:582` restoreLineEndings（LF 原样，CRLF 则把整份 `\n` 换成 `\r\n`）
 *   writeText     = `:821` 整份**逐字节**写；`expected.kind==='replaceIfVersion'` 时在 per-target
 *                   临界区里比对版本，不符抛 `FS_STALE_VERSION`
 *
 * 于是本文件测的是“真机链路”：mixed 两条（编辑第 4 行、非目标行的行尾被整份归一）今天必红，
 * 因为 aura_basetools_edit 的写回也走 editText。段 D 还从反面钉住 mock 的保真度（那条链子确实会毁掉混合行尾）。
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

const BOM_BYTES = [0xef, 0xbb, 0xbf]
const BYTE_ORDER_MARK_CHAR = '\uFEFF'
const encode = (s) => Buffer.from(new TextEncoder().encode(s))
const bytesOf = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? encode(p) : Buffer.from(p))))
const bomBytes = (n) => Buffer.from(Array.from({ length: n * 3 }, (_, i) => BOM_BYTES[i % 3]))
const decode = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b)
const hasBom = (b) => b.length >= 3 && BOM_BYTES.every((x, i) => b[i] === x)
const describe = (b) => `首三字节 ${JSON.stringify([...b.subarray(0, 3)])} / ${b.length} 字节`

/**
 * 把字节切成“行 + 每行自己的行尾”。这是**期望值的独立实现**（不引用被测代码）：
 * 与工具同一把尺子（只认 `\n` 与 `\r\n`；单 `\r` 不是行尾），但代码各写各的。
 */
function splitRaw(bytes) {
  const segs = []
  const ends = []
  let start = 0
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue
    const crlf = i > start && bytes[i - 1] === 0x0d
    segs.push(bytes.subarray(start, crlf ? i - 1 : i))
    ends.push(crlf ? '\r\n' : '\n')
    start = i + 1
  }
  segs.push(bytes.subarray(start))
  ends.push('')
  return { segs, ends }
}
const rebuild = (segs, ends) => Buffer.concat(segs.map((s, i) => bytesOf(Buffer.from(s), ends[i])))
/** 第 n 行（1-based）换成 text，行尾保留原样。 */
function expectReplaceLine(bytes, n, text) {
  const { segs, ends } = splitRaw(bytes)
  const i = n - 1
  const outSegs = segs.map((s, k) => (k === i ? encode(text) : Buffer.from(s)))
  return rebuild(outSegs, ends)
}
const leadingBomCount = (bytes) => {
  let n = 0
  while (bytes.length >= (n + 1) * 3 && BOM_BYTES.every((x, i) => bytes[n * 3 + i] === x)) n += 1
  return n
}

// ── mock：与真提供方同形 ────────────────────────────────────────────────────
const tmp = path.join(os.tmpdir(), `byte-fidelity-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const readBytesFile = (p) => fs.readFileSync(p) // Buffer 是 Uint8Array，且自带 equals/subarray
let version = 1
/**
 * 真提供方 dsh-fs-local 的行尾算法，逐字复刻（行号可核）：
 *   `:566` `normalizeLineEndings(content) = content.replaceAll("\r\n", "\n")`
 *   `:569` `detectLineEndings(raw)`：取**首 4096 字节**，CRLF 多于纯 LF 则 'CRLF' 否则 'LF'
 *   `:582` `restoreLineEndings(content, style)`：'LF' 原样；否则归一化后把 `\n` 全换成 `\r\n`
 */
const DETECT_SAMPLE_BYTES = 4096
const normalizeLineEndings = (s) => s.replaceAll('\r\n', '\n')
const detectLineEndings = (raw) => {
  const sample = raw.slice(0, DETECT_SAMPLE_BYTES)
  const crlf = sample.split('\r\n').length - 1
  return crlf > sample.split('\n').length - 1 - crlf ? 'CRLF' : 'LF'
}
const restoreLineEndings = (content, style) => (style === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n'))

const fsService = {
  resolve: async (p) => ({ displayPath: p, targetKey: p }),
  stat: async (t) => (fs.existsSync(t.targetKey) ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
  readText: async (t) => decode(readBytesFile(t.targetKey)),
  readByteRange: async (t, range) => readBytesFile(t.targetKey).subarray(range.offset, range.offset + range.length),
  /** 真提供方的 editText（`:846-849`）：整份归一到多数派行尾 ⇒ 混合行尾必被改写。 */
  editText: async (t, req) => {
    const raw = decode(readBytesFile(t.targetKey))
    const style = detectLineEndings(raw)
    const content = normalizeLineEndings(raw)
    const oldNorm = normalizeLineEndings(req.oldString)
    const newNorm = normalizeLineEndings(req.newString)
    const n = content.split(oldNorm).length - 1
    if (n === 0) throw Object.assign(new Error('old_string was not found'), { code: 'FS_EDIT_NOT_FOUND' })
    if (n > 1) throw Object.assign(new Error(`old_string matched ${n} times`), { code: 'FS_AMBIGUOUS_EDIT' })
    const edited = content.split(oldNorm).join(newNorm)
    const out = restoreLineEndings(edited, style)
    fs.writeFileSync(t.targetKey, Buffer.from(new TextEncoder().encode(out)))
    version += 1
    return { version: `v${version}`, operation: 'update', before: content, after: normalizeLineEndings(out) }
  },
  /** 真提供方的 writeText（`:821-839`）：逐字节写 + 版本 CAS。 */
  writeText: async (t, content, expected) => {
    const p = t.targetKey
    const existed = fs.existsSync(p)
    if (expected?.kind === 'replaceIfVersion') {
      if (!existed) throw Object.assign(new Error('file no longer exists'), { code: 'FS_STALE_VERSION' })
      if (`v${version}` !== expected.version) throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
    } else if (expected?.kind === 'createIfAbsent' && existed) {
      throw Object.assign(new Error('cannot overwrite existing file without reading it first'), { code: 'FS_NOT_OBSERVED' })
    }
    fs.writeFileSync(p, Buffer.from(new TextEncoder().encode(content)))
    version += 1
    return { version: `v${version}`, operation: existed ? 'update' : 'create', after: normalizeLineEndings(content) }
  },
}

const readPlugin = await import('../aura-read/index.js')
const editPlugin = await import('../aura-edit/index.js')
let readTool = null
let editTool = null
const tools = { register: (t) => (t.name === 'aura_basetools_read' ? (readTool = t) : (editTool = t)), get: () => readTool }
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
// 本套件钉的是字节保真语义，走未注册的 legacy edit 描述符；公开 apply 的行号断言由 entity-apply 覆盖。
editTool = editPlugin.lastLegacyTools.edit
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
const read = (file, args = {}) => readTool.execute({ file_path: file, ...args }, exec)
const edit = (file, hunks) => editTool.execute({ file_path: file, hunks }, exec)

// ── 15 种字节形态（`editLine` 默认第 2 行；最后两条是审计真机实测的混合行尾两向）────────
const LF = 'alpha\nbeta\ngamma\n'
const CRLF = 'alpha\r\nbeta\r\ngamma\r\n'
const FORMS = [
  { name: 'lf_majority.md', editLine: 4, bytes: bytesOf('alpha\nbeta\r\ngamma\ndelta\n') },
  { name: 'crlf_majority.md', editLine: 4, bytes: bytesOf('alpha\r\nbeta\ngamma\r\ndelta\r\n') },
  { name: 'bom_lf.md', bytes: bytesOf(bomBytes(1), LF) },
  { name: 'bom_crlf.md', bytes: bytesOf(bomBytes(1), CRLF) },
  { name: 'double_bom.md', bytes: bytesOf(bomBytes(2), LF) },
  { name: 'mixed.md', bytes: bytesOf('alpha\r\nbeta\ngamma\r\n') },
  { name: 'crlf.md', bytes: bytesOf(CRLF) },
  { name: 'blank_lines.md', bytes: bytesOf('alpha\n\nbeta\n\n') },
  { name: 'cjk.md', bytes: bytesOf('第一行\n第二行\n第三行\n') },
  { name: 'inner_feff.md', bytes: bytesOf('alpha\nbeta\ngamma\uFEFF\n') },
  { name: 'no_trailing.md', bytes: bytesOf('alpha\nbeta\ngamma') },
  { name: 'trailing_bom.md', bytes: bytesOf('alpha\nbeta\ngamma\n', bomBytes(1)) },
  { name: 'empty.md', bytes: Buffer.alloc(0) },
  { name: 'empty_bom.md', bytes: bytesOf(bomBytes(1)) },
  { name: 'lone_cr.md', bytes: bytesOf('alpha\rbeta\rgamma\r') },
]
const EDITABLE = FORMS.filter((f) => !['empty.md', 'empty_bom.md', 'lone_cr.md'].includes(f.name))

// ── A 段：真往返（读 → 改被寻址那一行 → 写回 → 逐字节比对） ────────────────
say('=== A. 真往返：每种形态改一行为 EDITED，逐字节比对 ===')
for (const form of EDITABLE) {
  const lineNo = form.editLine ?? 2
  const file = path.join(tmp, form.name)
  fs.writeFileSync(file, form.bytes)
  const before = readBytesFile(file)
  const beforeBom = leadingBomCount(before)
  const { ends } = splitRaw(before)
  const editedEnding = ends[lineNo - 1]

  const receipt = await read(file, { mode: 'full' })
  const out = await edit(file, [{ lines: [lineNo, lineNo], replace: 'EDITED' }])
  const after = readBytesFile(file)
  const expected = expectReplaceLine(before, lineNo, 'EDITED')

  check(out.applied[0]?.tier === 'lines', `${form.name} 经 lines=[${lineNo},${lineNo}] 命中`, `tier=${out.applied[0]?.tier}`)
  check(
    after.equals(expected),
    `${form.name} 往返后字节与期望逐字节相同`,
    `实际 ${JSON.stringify(after.toString('latin1'))} 期望 ${JSON.stringify(expected.toString('latin1'))}`,
  )
  check(
    leadingBomCount(after) === beforeBom,
    `${form.name} 前导 BOM 个数不变（${beforeBom} 个）`,
    `${describe(after)}`,
  )
  check(
    splitRaw(after).ends[lineNo - 1] === editedEnding,
    `${form.name} 被编辑行的行尾与原来相同`,
    `${JSON.stringify(editedEnding)} -> ${JSON.stringify(splitRaw(after).ends[lineNo - 1])}`,
  )
  // 区域之外逐字节相同（前缀 + 区域之后的后缀）
  const { segs, ends: e2 } = splitRaw(before)
  const prefix = rebuild(segs.slice(0, lineNo - 1), e2.slice(0, lineNo - 1))
  const suffix = rebuild(segs.slice(lineNo), e2.slice(lineNo))
  check(
    after.subarray(0, prefix.length).equals(prefix) && after.subarray(after.length - suffix.length).equals(suffix),
    `${form.name} 被寻址区域之外字节完全不变`,
    `前缀 ${prefix.length} 字节 / 后缀 ${suffix.length} 字节`,
  )
  check(receipt.version !== undefined, `${form.name} 读取给出令牌`, `${receipt.version}`)
}

// ── G 段：非目标行零改动（逐行文本 + 行尾，混合行尾两向） ────────────────────
say('')
say('=== G. 非目标行零改动：混合行尾两向逐行比对 ===')
for (const name of ['lf_majority.md', 'crlf_majority.md']) {
  const form = FORMS.find((f) => f.name === name)
  const lineNo = form.editLine ?? 2
  const file = path.join(tmp, `g_${name}`)
  fs.writeFileSync(file, form.bytes)
  const before = readBytesFile(file)
  await edit(file, [{ lines: [lineNo, lineNo], replace: 'EDITED' }])
  const after = readBytesFile(file)
  const b = splitRaw(before)
  const a = splitRaw(after)
  const othersSame = a.segs.length === b.segs.length && b.segs.every((s, i) => i === lineNo - 1 || (Buffer.from(s).equals(Buffer.from(a.segs[i])) && b.ends[i] === a.ends[i]))
  check(othersSame, `${name} 除第 ${lineNo} 行外每一行的文本与行尾逐字节相同`, `行数 ${b.segs.length} → ${a.segs.length}`)
  check(
    b.ends.filter((e, i) => i !== lineNo - 1).join('|') === a.ends.filter((e, i) => i !== lineNo - 1).join('|'),
    `${name} 非目标行的行尾序列不变`,
    `${JSON.stringify(b.ends)} -> ${JSON.stringify(a.ends)}`,
  )
}

// ── 边界三种：空文件 / 纯 BOM / 单 \r（F-c 的结论） ─────────────────────────
say('')
say('=== A2. 边界：空文件、纯 BOM、单 \\r 行尾 ===')
/**
 * fs-contract-v2 / C24：这一段原先钉的是「壳层必须 throw（`error !== null`）」，那是旧契约。
 * 新契约把**判定不出调用方意图**的失败与**工具级故障**分了道（判决表 = `aura-edit/index.js`
 * 的 `OUTCOME_BY_CODE` 白名单）：
 *   · 坐标越界（`LOCATOR_OUT_OF_RANGE`）＝ 读不懂意图 ⇒ 回一条**正常结果**，
 *     带 `outcome` / `code` / `next`，`applied: []`，一个字节都没落盘；
 *   · 工具级故障（IO / 沙箱 / `FS_STALE_VERSION` / `PATCH_NO_BYTE_EXACT_WRITE`）⇒ 照旧抛错。
 * 所以这四条迁到结果通道，但**真正要保的东西照旧钉死**：拒绝时磁盘逐字节不变。
 * 段 F（`FS_STALE_VERSION`）与段 H（`PATCH_NO_BYTE_EXACT_WRITE`）属于后一类，那两条断言一字未动。
 */
for (const name of ['empty.md', 'empty_bom.md', 'lone_cr.md']) {
  const form = FORMS.find((f) => f.name === name)
  const file = path.join(tmp, name)
  fs.writeFileSync(file, form.bytes)
  let out = null
  let error = null
  try {
    out = await edit(file, [{ lines: [2, 2], replace: 'EDITED' }])
  } catch (e) {
    error = e
  }
  const wantCode = name === 'lone_cr.md' ? 'LOCATOR_LONE_CR' : 'LOCATOR_OUT_OF_RANGE'
  check(
    error === null && out?.outcome === 'not_found' && out?.code === wantCode,
    `${name} 第 2 行不存在 ⇒ 结构化拒绝走结果通道（outcome=not_found / ${wantCode}）`,
    error ? `throw ${error.code}` : `outcome=${out?.outcome} code=${out?.code}`,
  )
  check(
    Array.isArray(out?.applied) && out.applied.length === 0,
    `${name} 拒绝回执 applied 为空（结构性：一个 hunk 都没落盘）`,
    `applied=${JSON.stringify(out?.applied ?? null)}`,
  )
  check(
    typeof out?.next === 'string' && out.next.length > 0,
    `${name} 拒绝回执带可执行的 next`,
    JSON.stringify(String(out?.next ?? '').slice(0, 80)),
  )
  check(readBytesFile(file).equals(form.bytes), `${name} 拒绝时磁盘未变`, describe(readBytesFile(file)))
}
// 单 \r 的结论：不支持把它当行尾，但整份替换（第 1 行）可用且字节保真
{
  const form = FORMS.find((f) => f.name === 'lone_cr.md')
  const file = path.join(tmp, 'lone_cr_whole.md')
  fs.writeFileSync(file, form.bytes)
  let out = null
  let error = null
  try {
    out = await edit(file, [{ lines: [2, 2], replace: 'EDITED' }])
  } catch (e) {
    error = e
  }
  check(
    error === null && out?.outcome === 'not_found' && out?.code === 'LOCATOR_LONE_CR',
    '单 \\r 文件的 lines= ⇒ not_found 走结果通道（不是工具级故障）',
    error ? `throw ${error.code}` : `outcome=${out?.outcome} code=${out?.code}`,
  )
  check(
    /lone|\\r|CR/.test(String(out?.message ?? '')),
    '单 \\r 文件的 lines= 拒绝信息点名原因（不是干巴巴的 outside 1..1）',
    JSON.stringify(String(out?.message ?? '').slice(0, 160)),
  )
  check(readBytesFile(file).equals(form.bytes), '单 \\r 文件拒绝时磁盘未变', describe(readBytesFile(file)))
  fs.writeFileSync(file, form.bytes)
  // 拒绝信息指向的出口：按**逐字原文**整份替换（old 片段不依赖行号模型）。
  const wholeOut = await edit(file, [{ old: 'alpha\rbeta\rgamma\r', replace: 'EDITED' }])
  check(
    wholeOut.applied[0]?.tier?.startsWith('old') && decode(readBytesFile(file)) === 'EDITED',
    '单 \\r 文件按 old 原文整份替换可用且字节保真',
    JSON.stringify(readBytesFile(file).toString('latin1')),
  )
}

// ── C 段：replace 自带行尾时按 replace 写（反例守卫） ───────────────────────
say('')
say('=== C. eol:preserve 时，replace 自带行尾必须照 replace 写（旧逐字节口径） ===')
{
  const file = path.join(tmp, 'c_crlf_file.md')
  fs.writeFileSync(file, bytesOf(CRLF))
  await edit(file, [{ lines: [2, 2], replace: 'EDITED\nSECOND', eol: 'preserve' }])
  const after = readBytesFile(file)
  const expected = bytesOf('alpha\r\n', 'EDITED\nSECOND', '\r\ngamma\r\n')
  check(after.equals(expected), 'replace 自带 LF：eol=preserve 时文件是 CRLF 也照 LF 写（内部行尾来自 replace）', JSON.stringify(after.toString('latin1')))
}
{
  const file = path.join(tmp, 'c_lf_file.md')
  fs.writeFileSync(file, bytesOf(LF))
  await edit(file, [{ lines: [2, 2], replace: 'EDITED\r\nSECOND', eol: 'preserve' }])
  const after = readBytesFile(file)
  const expected = bytesOf('alpha\n', 'EDITED\r\nSECOND', '\ngamma\n')
  check(after.equals(expected), 'replace 自带 CRLF：eol=preserve 时文件是 LF 也照 CRLF 写', JSON.stringify(after.toString('latin1')))
}

// ── H 段：后端没有 writeText 时，混合行尾必须拒绝（不得降级去走会改坏字节的路） ──
say('')
say('=== H. 无 writeText 的后端 + 混合行尾 ⇒ 拒绝，而不是静默归一 ===')
{
  // 一个“旧后端”：只有 editText（仓库里若干 mock 就是这种形状）
  const legacy = { ...fsService, writeText: undefined }
  readPlugin.apply({ ...mkCtx(), fs: legacy })
  editPlugin.apply({ ...mkCtx(), fs: legacy })
  editTool = editPlugin.lastLegacyTools.edit
  const mixedFile = path.join(tmp, 'h_mixed.md')
  fs.writeFileSync(mixedFile, bytesOf('alpha\r\nbeta\ngamma\r\ndelta\r\n'))
  const beforeMixed = readBytesFile(mixedFile)
  let mixedError = null
  try {
    await edit(mixedFile, [{ lines: [4, 4], replace: 'DELTA' }])
  } catch (e) {
    mixedError = e
  }
  check(
    mixedError !== null && mixedError.code === 'PATCH_NO_BYTE_EXACT_WRITE',
    '混合行尾 + 无 writeText ⇒ 结构化拒绝（PATCH_NO_BYTE_EXACT_WRITE）',
    `${mixedError?.code ?? 'ok'}`,
  )
  check(readBytesFile(mixedFile).equals(beforeMixed), '拒绝时磁盘未变', describe(readBytesFile(mixedFile)))
  // 同一个旧后端上，行尾统一的文件仍然可编（退化路径保留，不是把所有编辑都拒掉）
  const uniformFile = path.join(tmp, 'h_uniform.md')
  fs.writeFileSync(uniformFile, bytesOf('alpha\nbeta\ngamma\n'))
  const uniformOut = await edit(uniformFile, [{ lines: [2, 2], replace: 'EDITED' }])
  check(
    uniformOut.applied[0]?.tier === 'lines' && decode(readBytesFile(uniformFile)) === 'alpha\nEDITED\ngamma\n',
    '同一旧后端上行尾统一的文件仍可编辑（退化路径逐字节等价）',
    JSON.stringify(decode(readBytesFile(uniformFile))),
  )
  // 后续段回到带 writeText 的后端
  readPlugin.apply(mkCtx())
  editPlugin.apply(mkCtx())
  editTool = editPlugin.lastLegacyTools.edit
}

// ── B 段：15 种形态的令牌两两不同 ───────────────────────────────────────────
say('')
say('=== B. 13 种形态两两令牌互不相同（含纯 BOM vs 空文件）===')
const tokens = new Map()
for (const form of FORMS) {
  const file = path.join(tmp, `tok_${form.name}`)
  fs.writeFileSync(file, form.bytes)
  const r = await read(file, { mode: 'full' })
  tokens.set(form.name, r.version)
}
const seen = new Map()
let collisions = 0
for (const [name, token] of tokens) {
  if (seen.has(token)) {
    collisions += 1
    check(false, `${name} 与 ${seen.get(token)} 令牌相同`, token)
  } else {
    seen.set(token, name)
  }
}
check(collisions === 0, `${FORMS.length} 种形态两两令牌不同（${seen.size} 个唯一令牌）`, `空文件=${tokens.get('empty.md')} 纯 BOM=${tokens.get('empty_bom.md')}`)

// ── F 段：读后被第三方改过 ⇒ 必须拒绝（FS_STALE_VERSION）且磁盘不变 ──────────
say('')
say('=== F. 读后被第三方改过：必须拒绝、磁盘不变（守卫不许丢掉）===')
{
  const file = path.join(tmp, 'stale.md')
  const ORIG = 'alpha\r\nbeta\ngamma\r\ndelta\r\n'
  const THIRD = 'alpha\r\nbeta\nTHIRD\r\ndelta\r\n'
  fs.writeFileSync(file, bytesOf(ORIG))
  // 在“本工具读完之后”插入一次第三方写入（并推进提供方版本）：
  // 本工具手上的 info.version 因此变陈旧。
  const realReadText = fsService.readText
  fsService.readText = async (t) => {
    const text = await realReadText(t)
    if (t.targetKey === file) {
      fs.writeFileSync(file, bytesOf(THIRD))
      version += 1
    }
    return text
  }
  let error = null
  try {
    await edit(file, [{ lines: [4, 4], replace: 'DELTA' }])
  } catch (e) {
    error = e
  }
  fsService.readText = realReadText
  check(
    error !== null && error.code === 'FS_STALE_VERSION',
    '第三方在“读→写”之间改了文件 ⇒ 结构化拒绝 FS_STALE_VERSION',
    `${error?.code ?? 'ok'}: ${String(error?.message ?? '').slice(0, 100)}`,
  )
  check(
    decode(readBytesFile(file)) === THIRD,
    '磁盘保持第三方写后的内容（我们的编辑一字未落盘）',
    JSON.stringify(decode(readBytesFile(file))),
  )
}

// ── D 段：mock 保真自检——提供方 editText 确实会毁掉混合行尾（所以写回不能走它）──
say('')
say('=== D. mock 保真自检：editText 毁掉混合行尾 / writeText 逐字节保真 ===')
{
  // 用 mock 自己的两个方法直接对撞：同一个混合行尾文件、同一次“把第 4 行改成 DELTA”，
  // 分别走提供方的 editText 与 writeText，比落盘字节。
  const before = bytesOf('alpha\r\nbeta\ngamma\r\ndelta\r\n')
  const want = expectReplaceLine(before, 4, 'DELTA')
  const f1 = path.join(tmp, 'd_edittext.md')
  const f2 = path.join(tmp, 'd_writetext.md')
  fs.writeFileSync(f1, before)
  fs.writeFileSync(f2, before)
  await fsService.editText({ targetKey: f1, displayPath: f1 }, { oldString: decode(before), newString: decode(want), replaceAll: false })
  await fsService.writeText({ targetKey: f2, displayPath: f2 }, decode(want), undefined)
  check(
    !readBytesFile(f1).equals(want),
    'editText（提供方真算法）确实改写了非目标行的行尾——mock 保真',
    `${JSON.stringify(decode(readBytesFile(f1)))}`,
  )
  check(readBytesFile(f2).equals(want), 'writeText 逐字节保真——这就是选它的根因', `${readBytesFile(f2).length} 字节`)
}

// ── D2 段：把两种写法的最终落盘差异摆出来（判读，不计分） ────────────────────
say('')
say('=== D2. 判读：两种写回路径的落盘差异 ===')
{
  /** 本层交给提供方的 newString：'我们的落盘字节'对应的字符串（TextDecoder 只吃掉一个 BOM，补回那一个）。 */
  const asNewString = (finalBytes) => (leadingBomCount(finalBytes) > 0 ? BYTE_ORDER_MARK_CHAR + decode(finalBytes) : decode(finalBytes))
  let rewritten = 0
  let compared = 0
  for (const form of FORMS) {
    if (['empty.md', 'empty_bom.md'].includes(form.name)) continue
    const lineNo = form.editLine ?? 2
    // 目标字节：单 \r 文件只能整份替换，其余是“把被寻址那一行改成 EDITED”
    const want = form.name === 'lone_cr.md' ? bytesOf('EDITED') : expectReplaceLine(form.bytes, lineNo, 'EDITED')
    // 直接走 mock 的提供方 editText（真算法），看它落盘成什么
    const file = path.join(tmp, `d2_${form.name}`)
    fs.writeFileSync(file, form.bytes)
    await fsService.editText({ targetKey: file, displayPath: file }, { oldString: decode(form.bytes), newString: asNewString(want), replaceAll: false })
    const viaEditText = readBytesFile(file)
    const same = viaEditText.equals(want)
    compared += 1
    if (!same) rewritten += 1
    say(`  ${form.name}: 期望 ${want.length} 字节 ⇒ editText 落盘 ${viaEditText.length} 字节${same ? '（一致）' : '（**被改写**）'}`)
  }
  say(`  结论：${rewritten}/${compared} 条会被 editText 的整份归一改写（全是混合行尾）；`)
  say('        所以写回改用 writeText：逐字节落盘 + 提供方级版本 CAS。')
}

fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
  process.exitCode = 1
}
