/**
 * handle-edit-test —— 编辑侧的**句柄寻址**（fs-contract-v2 / HD2）。
 *
 * 命题（施工单终态）：`aura_basetools_edit` 的 hunk 能带一个读侧发的 21 字符句柄，用
 * 「句柄 + 相对定位」取代调用方转述的原文——被编辑的那段字节**不由模型转述**。
 *
 * 判据分九段，逐段对着契约 §5 的解析次序：
 *   A 四种形状各自命中，且**真的落盘**（`writeText` ≥ 1、副本字节确实变了）；
 *   B 区间未变时句柄路**不依赖调用方的引文/坐标**（给一个故意写错的 `old` 也按句柄落）
 *     —— 只有 `{handle, old}` 那种组合才要求 `old` 命中区间内部（见 G）；
 *   C 身份标签不符 ⇒ `PATCH_HANDLE_IDENTITY_MISMATCH`，磁盘一字节未动；
 *   D 区间被改坏 ⇒ `PATCH_HANDLE_STALE`，磁盘未动；
 *   E 区间被搬到别处（前面插了几行）⇒ **按新坐标成功**并在回执里披露"区间已移动"；
 *   F `line: k` 越界 ⇒ `PATCH_HANDLE_LINE_OUT_OF_RANGE`（报出该区间共几行）；
 *   G `{handle, old}` 而引文在区间**外** ⇒ `PATCH_HANDLE_QUOTE_OUTSIDE`（不退化成整段替换）；
 *   H 句柄形状坏 ⇒ **抛错**（参数面），而不是回一条结果；
 *   I 闸门：句柄 hunk **进** regionGate（不借 `expect` 从它下面绕过去），
 *     而同形状的 `lines` hunk 照旧走既有那条"带 expect 整条跳过"的规则——两条一起钉。
 *
 * 为什么全部打在 `applyEditToProvider`（编排层）而不是 `planHunks`（判据层）上：
 * "真的落盘"与"磁盘一字节未动"这两句话，只有在**编排层**才成立（判据层是纯函数，
 * 它永远不写盘——那是 `already-applied-test` 段 F 钉过的事）。
 *
 * mock 与真提供方同形（与 `stale-gate-test` / `write-verify-test` 同一套收尾）：
 * `readText` = TextDecoder 解原始字节、`writeText` = 逐字节写 + `replaceIfVersion` 版本 CAS。
 * 第三方改动**直接写盘、不动账本**——那正是"读到之后别人改了文件"的形状。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyEditToProvider } from './write-path.mjs'
import { contentToken, rememberRead } from './read-core.mjs'
import { identityTag, mintHandle } from './handle-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const TMP = path.join(os.tmpdir(), `handle-edit-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

const encode = (text) => new TextEncoder().encode(text)
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const readBytes = (p) => fs.readFileSync(p)
const writeBytes = (p, text) => fs.writeFileSync(p, Buffer.from(encode(text)))
const readTextFile = (p) => decode(readBytes(p))

let version = 1
const calls = { writeText: 0, editText: 0 }
/** 真提供方 `dsh-fs-local:821-839`：逐字节写 + 版本 CAS。`target` 在编排层就是 displayPath。 */
const provider = {
  stat: async (p) => (fs.existsSync(p) ? { version: `v${version}`, type: 'file', size: fs.statSync(p).size } : undefined),
  readText: async (p) => {
    if (!fs.existsSync(p)) throw Object.assign(new Error(`cannot read "${p}"`), { code: 'FS_NOT_FOUND' })
    return readTextFile(p)
  },
  readByteRange: async (p, range) => readBytes(p).subarray(range.offset, range.offset + range.length),
  writeText: async (p, content, expected) => {
    calls.writeText += 1
    if (expected?.kind === 'replaceIfVersion' && `v${version}` !== expected.version) {
      throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
    }
    writeBytes(p, content)
    version += 1
    return { version: `v${version}`, operation: 'update', after: content }
  },
  /** 不该被走到：写回走 writeText。被调用就记数，末尾断言为 0。 */
  editText: async () => {
    calls.editText += 1
    throw new Error('editText must not be used by the write path')
  },
}

const rowsOf = (text) => text.split(/\r?\n/)
/**
 * 铸柄：与读侧 `read-core.mjs` 的 `handleFor` **同一口径、同一个函数**（`mintHandle`）——
 * 账本键取"写侧会算出的那一个"（不传 `identityKey` 时 `ledgerIdentityKey` 原样返回 `filePath`）。
 */
const mint = (file, text, startLine, endLine, byteOrderMark = false) =>
  mintHandle({
    ledgerKey: file,
    regionText: rowsOf(text).slice(startLine - 1, endLine).join('\n'),
    byteOrderMark,
    startLine,
    endLine,
  })

const BASE = [
  'const alpha = 1',
  'const beta = 2',
  'const gamma = 3',
  'const delta = 4',
  'const epsilon = 5',
].join('\n') + '\n'
const REGION = [2, 4]

let seq = 0
/**
 * 一个靶场：写文件 → 记观测（= 读侧那次读）→ 铸柄 →（可选）第三方改动 → 发编辑。
 *
 * 返回 `{file, handle, before, after, text, receipt, error, writes}`。
 * `mutate` 走的是**直接写盘**：它只改磁盘，账本里仍留着读时那一版——闸门与搬迁重找
 * 要的正是这个差。
 */
async function scenario(name, edit, { content = BASE, region = REGION, mutate = null, mintedFrom = null, bom = false } = {}) {
  seq += 1
  const file = path.join(TMP, `${name}-${seq}.mjs`)
  // `content` 是**提供方视角**的文本（前导 BOM 已被解码器吃掉）；磁盘上那份按 `bom` 补回字节。
  writeBytes(file, bom ? `\uFEFF${content}` : content)
  rememberRead(file, contentToken(content, bom), content, bom)
  const handle = mintedFrom === null ? mint(file, content, region[0], region[1], bom) : mintedFrom(file, content, region)
  if (mutate !== null) {
    const next = mutate(content)
    writeBytes(file, bom ? `\uFEFF${next}` : next)
  }
  const before = readBytes(file)
  const writesBefore = calls.writeText
  let receipt = null
  let error = null
  try {
    receipt = await applyEditToProvider(provider, { displayPath: file, hunks: [edit(handle)] })
  } catch (caught) {
    error = caught
  }
  return {
    file,
    handle,
    before,
    after: readBytes(file),
    text: readTextFile(file),
    receipt,
    error,
    writes: calls.writeText - writesBefore,
  }
}

const codeOf = (error) => error?.code ?? null
const untouched = (run) => run.before.equals(run.after)

// ── A. 四种形状各自命中，且真的落盘 ──────────────────────────────────────────
say('=== A. 四种句柄形状：各自命中 + 真的落盘（writeText ≥ 1、副本字节确实变了）===')
const SHAPES = [
  ['A1 {handle, replace} 整段替换', (h) => ({ handle: h, replace: 'R1' }), 'handle', (t) => t.replace('const beta = 2\nconst gamma = 3\nconst delta = 4', 'R1')],
  ['A2 {handle, line: k} 段内第 2 行', (h) => ({ handle: h, line: 2, replace: 'R2' }), 'handle line 2', (t) => t.replace('const gamma = 3', 'R2')],
  ['A3 {handle, old} 段内内容定位', (h) => ({ handle: h, old: 'const gamma = 3', replace: 'R3' }), 'handle+old', (t) => t.replace('const gamma = 3', 'R3')],
  ['A4a {handle, position: before} 边界插入', (h) => ({ handle: h, position: 'before', replace: 'PRE' }), 'handle before', (t) => t.replace('const beta = 2', 'PRE\nconst beta = 2')],
  ['A4b {handle, position: after} 边界插入', (h) => ({ handle: h, position: 'after', replace: 'POST' }), 'handle after', (t) => t.replace('const delta = 4', 'const delta = 4\nPOST')],
]
for (const [label, edit, tierPrefix, expected] of SHAPES) {
  const run = await scenario(label.slice(0, 2).toLowerCase(), edit)
  check(
    run.error === null && run.receipt !== null && run.receipt.applied.length === 1,
    `${label} ⇒ 一次成功回执`,
    run.error === null ? `applied=${run.receipt?.applied?.length}` : codeOf(run.error),
  )
  check(run.writes >= 1 && !run.before.equals(run.after), `${label} ⇒ 真的落盘（writeText=${run.writes}、字节已变）`)
  check(run.text === expected(BASE), `${label} ⇒ 落盘字节就是预期的那一段`, JSON.stringify(run.text))
  check(
    String(run.receipt?.applied?.[0]?.tier ?? '').startsWith(tierPrefix),
    `${label} ⇒ 回执层名点名句柄（tier=${JSON.stringify(run.receipt?.applied?.[0]?.tier)}）`,
  )
}

// ── B. 句柄路不依赖调用方转述的字节 ─────────────────────────────────────────
say('\n=== B. 区间未变时句柄路**不依赖调用方转述**（错的坐标 / 错的引文都按句柄落）===')
{
  const run = await scenario('b1', (h) => ({ handle: h, lines: [1, 1], replace: 'R' }))
  check(
    run.error === null && run.text === BASE.replace('const beta = 2\nconst gamma = 3\nconst delta = 4', 'R'),
    'B1 坐标写错（lines: [1,1]）也按句柄落：区间是句柄定的，不是坐标定的',
    run.error === null ? JSON.stringify(run.text) : codeOf(run.error),
  )
  check(
    String(run.receipt?.applied?.[0]?.tier ?? '').includes('ignored (the handle decides the region): lines'),
    'B1 被让开的坐标必须在回执里披露（沉默忽略不行，D7）',
    JSON.stringify(run.receipt?.applied?.[0]?.tier),
  )
  check(run.receipt?.applied?.[0]?.line === 2, 'B1 落点是句柄那一段（第 2 行），不是坐标说的第 1 行', `line=${run.receipt?.applied?.[0]?.line}`)
}
{
  const WRONG = 'this quote is not anywhere in the file at all'
  check(!BASE.includes(WRONG), 'B2 先证明那句引文确实不在文件里（判据的前提）')
  const run = await scenario('b2', (h) => ({ handle: h, line: 2, old: WRONG, replace: 'R2B' }))
  check(
    run.error === null && run.text === BASE.replace('const gamma = 3', 'R2B'),
    'B2 故意写错的 old + {handle, line: k} ⇒ 按句柄成功（只有 {handle, old} 那种组合才要求 old 命中）',
    run.error === null ? JSON.stringify(run.text) : codeOf(run.error),
  )
  check(
    String(run.receipt?.applied?.[0]?.tier ?? '').includes('ignored (the handle decides the region): old'),
    'B2 被让开的 old 也要披露',
    JSON.stringify(run.receipt?.applied?.[0]?.tier),
  )
}

// ── C. 身份标签不符 ─────────────────────────────────────────────────────────
say('\n=== C. 身份标签不符 ⇒ PATCH_HANDLE_IDENTITY_MISMATCH，磁盘一字节未动 ===')
{
  const other = (file, text, region) =>
    mintHandle({
      ledgerKey: `${file}.some-other-file`,
      regionText: rowsOf(text).slice(region[0] - 1, region[1]).join('\n'),
      byteOrderMark: false,
      startLine: region[0],
      endLine: region[1],
    })
  const run = await scenario('c1', (h) => ({ handle: h, replace: 'R' }), { mintedFrom: other })
  check(
    codeOf(run.error) === 'PATCH_HANDLE_IDENTITY_MISMATCH',
    'C1 另一个文件铸的柄（同一段字节、同一坐标）⇒ PATCH_HANDLE_IDENTITY_MISMATCH',
    codeOf(run.error) ?? 'no error',
  )
  check(run.writes === 0 && untouched(run), 'C1 磁盘一字节未动（writeText=0，副本逐字节相同）')
}

// ── D. 区间被改坏 ───────────────────────────────────────────────────────────
say('\n=== D. 区间被改坏（第三人改了那三行）⇒ PATCH_HANDLE_STALE，磁盘未动 ===')
{
  const run = await scenario('d1', (h) => ({ handle: h, replace: 'R' }), {
    mutate: (t) => t.replace('const gamma = 3', 'const gamma = 999'),
  })
  check(
    codeOf(run.error) === 'PATCH_HANDLE_STALE',
    'D1 句柄那一段的字节已不在文件里 ⇒ PATCH_HANDLE_STALE',
    codeOf(run.error) ?? 'no error',
  )
  check(run.writes === 0 && untouched(run), 'D1 磁盘一字节未动（writeText=0，副本逐字节相同）')
}

// ── E. 区间被搬到别处 ───────────────────────────────────────────────────────
say('\n=== E. 区间被搬到别处（前面插了三行）⇒ 按新坐标成功并披露 ===')
{
  const PREFIX = '// inserted one\n// inserted two\n// inserted three\n'
  const run = await scenario('e1', (h) => ({ handle: h, replace: 'R' }), { mutate: (t) => PREFIX + t })
  check(
    run.error === null && run.text === PREFIX + BASE.replace('const beta = 2\nconst gamma = 3\nconst delta = 4', 'R'),
    'E1 唯一命中 ⇒ 按**新坐标**应用（2-4 → 5-7）',
    run.error === null ? JSON.stringify(run.text) : codeOf(run.error),
  )
  check(run.receipt?.applied?.[0]?.line === 5, 'E1 回执报的是新行号 5', `line=${run.receipt?.applied?.[0]?.line}`)
  check(
    String(run.receipt?.applied?.[0]?.tier ?? '').includes('region moved: lines 2-4 → 5-7'),
    'E1 回执披露"区间已移动"（照 coordinateNote 的风格）',
    JSON.stringify(run.receipt?.applied?.[0]?.tier),
  )
  check(run.writes >= 1, `E1 重找之后真的落盘（writeText=${run.writes}）`)
}

// ── F. line: k 越界 ─────────────────────────────────────────────────────────
say('\n=== F. line: k 越界 ⇒ PATCH_HANDLE_LINE_OUT_OF_RANGE（报出该区间共几行）===')
for (const k of [9, 0]) {
  const run = await scenario(`f${k}`, (h) => ({ handle: h, line: k, replace: 'R' }))
  check(
    codeOf(run.error) === 'PATCH_HANDLE_LINE_OUT_OF_RANGE' && /has 3 line\(s\)/.test(String(run.error?.message)),
    `F line: ${k} 越界 ⇒ PATCH_HANDLE_LINE_OUT_OF_RANGE 且点名区间共 3 行`,
    codeOf(run.error) ?? 'no error',
  )
  check(run.writes === 0 && untouched(run), `F line: ${k} 越界时磁盘一字节未动`)
}

// ── G. {handle, old} 引文在区间外 ───────────────────────────────────────────
say('\n=== G. {handle, old} 而引文在区间**外** ⇒ PATCH_HANDLE_QUOTE_OUTSIDE ===')
{
  const run = await scenario('g1', (h) => ({ handle: h, old: 'const alpha = 1', replace: 'R' }))
  check(
    codeOf(run.error) === 'PATCH_HANDLE_QUOTE_OUTSIDE' && /not inside the region/.test(String(run.error?.message)),
    'G1 引文在文件里、但不在句柄那段区间里 ⇒ PATCH_HANDLE_QUOTE_OUTSIDE（点名"不在区间里"）',
    codeOf(run.error) ?? 'no error',
  )
  check(
    run.writes === 0 && untouched(run),
    'G1 **不许**退化成整段替换：磁盘一字节未动（引文对了、区间不对，是调用方要重挑引文）',
  )
}

// ── H. 句柄形状坏 ───────────────────────────────────────────────────────────
say('\n=== H. 句柄形状坏 ⇒ 抛错（参数面），不是回一条结果 ===')
for (const bad of ['nope', 'hZZZZac1b2e4d5:2-4', 'h9f3ac1b2e4d5:2', 'h9f3ac1b2e4d5']) {
  const run = await scenario('h', (h) => ({ handle: h, replace: 'R' }), { mintedFrom: () => bad })
  check(
    run.receipt === null && codeOf(run.error) === 'PATCH_HANDLE_SHAPE',
    `H ${JSON.stringify(bad)} ⇒ 抛 PATCH_HANDLE_SHAPE（不是结果通道）`,
    run.receipt === null ? codeOf(run.error) : 'returned a receipt',
  )
}

// ── I. 闸门：句柄 hunk 进 regionGate，不被 expect 那条规则跳过 ───────────────
say('\n=== I. 闸门：句柄 hunk 进 regionGate（同形状的 lines hunk 照旧跳过）===')
{
  /**
   * 造一个"闸门该说话"的局面：账本里那条观测（读时那一版）与磁盘上现在这一版
   * 在被寻址的那几行上**不同**，而句柄与当前文件一致（= 句柄不是从账本那条观测铸出来的）。
   * 前两版：坐标 + 摘要都对得上；第三版：账本里那条观测说不出这几行的话。
   */
  const OBSERVED = BASE
  const NOW = BASE.replace('const beta = 2', 'const beta = 22')
  const regionText = rowsOf(NOW).slice(1, 4).join('\n')
  const run = await scenario('i1', (h) => ({ handle: h, expect: regionText, replace: 'R' }), {
    content: OBSERVED,
    mutate: () => NOW,
    mintedFrom: (file) =>
      mintHandle({ ledgerKey: file, regionText, byteOrderMark: false, startLine: 2, endLine: 4 }),
  })
  check(
    codeOf(run.error) === 'PATCH_STALE_REGION',
    'I1 句柄 hunk 带 expect 也照旧进闸门（没被"带 expect 的 hunk 整条跳过"那条规则让开）',
    codeOf(run.error) ?? 'no error',
  )
  const control = await scenario('i2', (h, file) => ({ lines: [2, 4], expect: regionText, replace: 'R' }), {
    content: OBSERVED,
    mutate: () => NOW,
  })
  check(
    control.error === null && control.writes >= 1,
    'I2 对照：同形状的 `lines` hunk 带 expect 照旧跳过闸门（既有语义一个字节没改）',
    control.error === null ? `writeText=${control.writes}` : codeOf(control.error),
  )
}

// ── J. CRLF 与 BOM：句柄摘要的另一半（只能从字节取的那个事实）────────────────
//
// 为什么单列一段：句柄摘要 = `contentToken(区间字节, 有没有 BOM)`。写侧拿到 BOM 这个事实的
// **唯一**途径是 `readByteRange`（`readText` 解码时已经把第一个 BOM 吃掉了，这是既有注释里
// 记着的那条：拿 `content.startsWith(BOM)` 判会**恒为 false**）。这一半错了，句柄在 CRLF/BOM
// 文件上会一律对不上——那是拒绝（不是改错地方），但它会让整个机制在那类文件上白站。
// CRLF 另有一半：被替换行的行尾要**继承**（既有 C13 语义），句柄路不能把它弄丢。
say('\n=== J. CRLF 与 BOM：摘要的另一半 + 行尾继承 ===')
{
  const CRLF = BASE.replace(/\n/g, '\r\n')
  const run = await scenario('j1', (h) => ({ handle: h, line: 2, replace: 'R' }), { content: CRLF })
  check(
    run.error === null && run.text === CRLF.replace('const gamma = 3\r\n', 'R\r\n'),
    'J1 CRLF 文件：句柄按段内相对行改一行（区段第 2 行 = gamma），行尾照旧是 CRLF（逐字节）',
    run.error === null ? JSON.stringify(run.text) : codeOf(run.error),
  )
  check(run.after[0] !== 0xef, 'J1 无 BOM 的文件没有被平白加上 BOM')
}
{
  const CRLF = BASE.replace(/\n/g, '\r\n')
  const run = await scenario('j2', (h) => ({ handle: h, replace: 'R' }), { content: CRLF, bom: true })
  check(
    run.error === null && run.text === CRLF.replace('const beta = 2\r\nconst gamma = 3\r\nconst delta = 4\r\n', 'R\r\n'),
    'J2 BOM + CRLF 文件：句柄整段替换成功（摘要里的 BOM 那一半从字节取到了）',
    run.error === null ? JSON.stringify(run.text) : codeOf(run.error),
  )
  check(
    run.after[0] === 0xef && run.after[1] === 0xbb && run.after[2] === 0xbf,
    'J2 落盘字节仍然以 BOM 开头（编辑不会把 BOM 弄丢）',
    `${run.after[0]?.toString(16)} ${run.after[1]?.toString(16)} ${run.after[2]?.toString(16)}`,
  )
}

// ── K. `line` / `position` 是**句柄的从属键**：单独在场必须拒绝 ────────────────
//
// 复核实测出来的真回归：`lineRangeOf` 把 `source.line` 当行区间读（那是历史写法），于是
// `{line: 2, replace}` —— `lines` 最经典的那一次手误 —— 会走 `lines` 那一档**成功**：
// 一次我行我素的错误变成一次静默改到别处的编辑。`range-args-test` 段B 那只眼睛盯的是
// 入口那一层；这里把同一条判据钉在**引擎**上，并钉住"消息里看得出 line 需要配 handle"。
say('\n=== K. `line` / `position` 只在 `handle` 同时在场时才成立 ===')
{
  const bare = await scenario('k1', () => ({ line: 3, replace: 'X' }), { content: BASE })
  check(
    codeOf(bare.error) === 'PATCH_NO_ADDRESS' && /`line` needs `handle`/.test(String(bare.error?.message)),
    'K1 `{line: 3}`（没有 handle）⇒ PATCH_NO_ADDRESS，且消息点名 line 需要配 handle',
    codeOf(bare.error) ?? 'no error',
  )
  check(bare.writes === 0 && untouched(bare), 'K1 被拒时磁盘一字节未动')
  const ranged = await scenario('k2', () => ({ lines: [3, 3], replace: 'X' }), { content: BASE })
  check(
    ranged.error === null && ranged.text === BASE.replace('const gamma = 3', 'X') && ranged.writes >= 1,
    'K2 对照：`{lines: [3,3]}` 照旧成功（合法地址没有被这条守卫误伤）',
    ranged.error === null ? JSON.stringify(ranged.text) : codeOf(ranged.error),
  )
  check(
    bare.error !== null && ranged.error === null,
    'K3 两者行为**必须不同**：`line` 抛错 / `lines` 成功（相同就等于静默改错地方）',
    `line=${codeOf(bare.error)} lines=${codeOf(ranged.error) ?? 'applied'}`,
  )
  const barePosition = await scenario('k4', () => ({ position: 'after', replace: 'X' }), { content: BASE })
  check(
    codeOf(barePosition.error) === 'PATCH_NO_ADDRESS' &&
      /`position` needs `handle`/.test(String(barePosition.error?.message)) &&
      barePosition.writes === 0,
    'K4 `{position: "after"}`（没有 handle）⇒ PATCH_NO_ADDRESS，磁盘未动',
    codeOf(barePosition.error) ?? 'no error',
  )
  const mixed = await scenario('k5', () => ({ lines: [2, 4], line: 2, replace: 'X' }), { content: BASE })
  check(
    codeOf(mixed.error) === 'PATCH_NO_ADDRESS',
    'K5 与别的地址形状混用（`lines` + `line`）也拒 —— 不许挑一个用',
    codeOf(mixed.error) ?? 'no error',
  )
  const withHandle = await scenario('k6', (h) => ({ handle: h, position: 'after', replace: 'X' }), { content: BASE })
  check(
    withHandle.error === null && withHandle.writes >= 1,
    'K6 句柄同时在场时 `position` 照旧成立（守卫只拒"没有 handle"的那一种）',
    withHandle.error === null ? `writeText=${withHandle.writes}` : codeOf(withHandle.error),
  )
}

check(calls.editText === 0, '收尾：写回路径是 writeText，editText 一次都没被调用', `writeText=${calls.writeText} editText=${calls.editText}`)

// ── 汇总与退出码 ───────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
say(
  failed.length === 0
    ? `\nhandle-edit 判据 ${results.length} 条全部通过 ✓（writeText ${calls.writeText} 次 / editText ${calls.editText} 次）`
    : `\nhandle-edit 判据 ${results.length} 条：${failed.length} 条不通过 ✗`,
)
for (const bad of failed) say(`      ✗ ${bad.label}`)
process.exit(failed.length === 0 ? 0 : 1)
