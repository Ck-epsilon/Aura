/**
 * stale-gate-test —— 未断言编辑的**区域级新鲜度闸门**（D1 丢失更新 + D3 改错行）。
 *
 * 命题（施工单终态）：未带 `expect` 的 hunk，落盘前必须核对**被寻址区域**是否在"本次观测"之后
 * 被改过 —— 改过则结构化拒绝（磁盘一字不落）；变化**在别处**则照常成功（不许退化成全局版本守）；
 * 同一会话自己刚写过的内容算最新观测；从未观测过则不拦，但回执带 `unverified_region`。
 *
 * 两条真机实测（2026-09-21，C12 之后重测，靶子在 `%TEMP%\aura-d1\`）：
 *   f1 丢失更新：读完 f1（第 3 行 `line three`，令牌 `17fe0a7e:32`）→ 第三方把第 3 行改成
 *      `line three CHANGED BY B` → 无 `expect` 的 `lines=[3,3]` 编辑 ⇒ **静默覆盖成功**。
 *   f3 改错行：读完 f3（第 3 行 `charlie`）→ 第三方在顶部插两行 → 仍发 `lines=[3,3]`
 *      ⇒ **静默改了 `alpha`**（`lines=` 是绝对坐标，插行即位移）。
 * C12 的版本 CAS 在这里帮不上忙：它在**单次调用内部**取 `stat`，第三方在调用**之前**改的东西
 * 对它是"当前状态"，不是冲突。
 *
 * mock 与真提供方同形（`mock-ctx.mjs` 的教训）：readText = `TextDecoder(fatal)`、
 * readByteRange = 原始字节、writeText = 逐字节写 + `replaceIfVersion` 版本 CAS。
 * 本测试里 `editText` 只被记数：写回必须走 `writeText`（C12 的字节保真），这条也一并钉住。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { contextServices } from './mock-ctx.mjs'
// 同一个模块实例（两个壳 import 的也是这一个文件）—— 所以这里能直接断言账本键本身。
import { ledgerPathKey } from './read-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const tmp = path.join(os.tmpdir(), `stale-gate-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const readBytes = (p) => fs.readFileSync(p)
const writeBytes = (p, text) => fs.writeFileSync(p, Buffer.from(new TextEncoder().encode(text)))
const decode = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b)
const readTextFile = (p) => decode(readBytes(p))

let version = 1
const calls = { writeText: 0, editText: 0 }
const fsService = {
  /**
   * `targetKey` = **真宿主那一行**（C62）：`dsh-fs-local/lib/index.js:159` 是
   * `targetKey: FsTargetKey(await realpath(displayPath))`，`realpath` 来自 `node:fs/promises`
   * —— 本机实测它**折叠大小写**（大小写不敏感目录里 `…\beta.js` / `…\BETA.JS` 都给出盘上
   * 真名 `…\Beta.js`；`realpathSync.native` 同形）。
   *
   * 原先这里写 `targetKey: p`（把调用方给的写法原样当身份）：那不是任何一个真后端的行为。
   * 后果是把"同一个文件的两个写法"在账本里变成两个身份键，段M/段N 的判定于是落在
   * **折叠启发式**上而不是宿主事实上 —— C62 把启发式降为"没有文件系统事实时的兜底"之后，
   * 这一行就成了 mock 保真度的缺口（实测：不改这行，本套件 89/95；改后 95/95，断言一条未动）。
   */
  resolve: async (p) => {
    let targetKey = p
    try {
      targetKey = fs.realpathSync.native(p)
    } catch {
      // 不存在 / 解析不了：真后端退回"最近已存在祖先 + 剩余名字"，这里退到调用方给的写法
      // （本套件靶子路径都是已存在文件的绝对路径，只有 create 那几格走这一支）。
    }
    return { displayPath: p, targetKey }
  },
  stat: async (t) => (fs.existsSync(t.targetKey) ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
  readText: async (t) => readTextFile(t.targetKey),
  readByteRange: async (t, range) => readBytes(t.targetKey).subarray(range.offset, range.offset + range.length),
  /** 真提供方 `:821-839`：逐字节写 + 版本 CAS。 */
  writeText: async (t, content, expected) => {
    calls.writeText += 1
    const p = t.targetKey
    const existed = fs.existsSync(p)
    if (expected?.kind === 'replaceIfVersion') {
      if (!existed) throw Object.assign(new Error('file no longer exists'), { code: 'FS_STALE_VERSION' })
      if (`v${version}` !== expected.version) throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
    } else if (expected?.kind === 'createIfAbsent' && existed) {
      throw Object.assign(new Error('cannot overwrite existing file'), { code: 'FS_NOT_OBSERVED' })
    }
    writeBytes(p, content)
    version += 1
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
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
const read = (file, args = {}) => readTool.execute({ file_path: file, ...args }, exec)
const edit = (file, hunks) => editTool.execute({ file_path: file, hunks }, exec)
/** 第三方写入：内容变了、版本也前进（真提供方的版本含 ino/size/mtimeNs/ctimeNs）。 */
const thirdParty = (file, text) => {
  writeBytes(file, text)
  version += 1
}
const attempt = async (file, hunks) => {
  try {
    return { ok: true, out: await edit(file, hunks) }
  } catch (error) {
    return { ok: false, error }
  }
}

// ── 段A：f1 丢失更新 ────────────────────────────────────────────────────────
say('=== A. f1 丢失更新：读后第三方改了**被寻址那一行** ⇒ 必须拒绝 ===')
const F1_BEFORE = 'line one\r\nline two\r\nline three\r\n'
const F1_AFTER_B = 'line one\r\nline two\r\nline three CHANGED BY B\r\n'
{
  const file = path.join(tmp, 'f1.md')
  writeBytes(file, F1_BEFORE)
  const first = await read(file, { mode: 'full' })
  check(typeof first.version === 'string', 'A 首次读取给出令牌', `${first.version}`)
  thirdParty(file, F1_AFTER_B)
  const r = await attempt(file, [{ lines: [3, 3], replace: 'line three (A overwrote)' }])
  check(!r.ok && r.error.code === 'PATCH_STALE_REGION', 'A 被寻址行被第三方改过 ⇒ 结构化拒绝', `${r.error?.code ?? 'ok'}`)
  check(readTextFile(file) === F1_AFTER_B, 'A 磁盘保持第三方内容（我们的编辑一字未落）', JSON.stringify(readTextFile(file)))
  check(calls.editText === 0, 'A 写回走的是 writeText（editText 一次都没被调用）', `writeText=${calls.writeText} editText=${calls.editText}`)
}

// ── 段B：f3 改错行 ─────────────────────────────────────────────────────────
say('')
say('=== B. f3 改错行：第三方在顶部插两行 ⇒ 拒绝（lines= 是绝对坐标）===')
const F3_BEFORE = 'alpha\r\nbravo\r\ncharlie\r\ndelta\r\necho\r\n'
const F3_AFTER_INSERT = 'inserted by B 1\r\ninserted by B 2\r\nalpha\r\nbravo\r\ncharlie\r\ndelta\r\necho\r\n'
{
  const file = path.join(tmp, 'f3.md')
  writeBytes(file, F3_BEFORE)
  await read(file, { mode: 'full' })
  thirdParty(file, F3_AFTER_INSERT)
  const r = await attempt(file, [{ lines: [3, 3], replace: 'CHARLIE (A meant charlie)' }])
  check(!r.ok && r.error.code === 'PATCH_STALE_REGION', 'B 所寻址的行已被位移/改写 ⇒ 结构化拒绝', `${r.error?.code ?? 'ok'}`)
  check(readTextFile(file) === F3_AFTER_INSERT, 'B 磁盘未变（没有把 alpha 改成 CHARLIE）', JSON.stringify(readTextFile(file)))
}

// ── 段G：拒绝回执的结构 ────────────────────────────────────────────────────
say('')
say('=== G. 拒绝回执：minimal_next 指向冲突行区间 + others.by=unknown-writer ===')
{
  const file = path.join(tmp, 'g.md')
  writeBytes(file, F1_BEFORE)
  await read(file, { mode: 'full' })
  thirdParty(file, F1_AFTER_B)
  const r = await attempt(file, [{ lines: [3, 3], replace: 'x' }])
  const next = r.error?.minimal_next
  const others = r.error?.others
  check(
    Array.isArray(next?.lines) && next.lines[0] === 3 && next.lines[1] === 3,
    'G minimal_next.lines 指向冲突行区间 [3,3]',
    JSON.stringify(next ?? null),
  )
  check(
    Array.isArray(others) && others.length === 1 && others[0].by === 'unknown-writer' && others[0].lines?.[0] === 3,
    'G others[0] = { lines: [3,3], by: "unknown-writer" }',
    JSON.stringify(others ?? null),
  )
}

// ── 段C：反向（不许过度拒绝）───────────────────────────────────────────────
say('')
say('=== C. 反向：第三方改**别处** / 只在尾部追加 ⇒ 必须成功 ===')
{
  const file = path.join(tmp, 'c_elsewhere.md')
  writeBytes(file, F1_BEFORE)
  await read(file, { mode: 'full' })
  thirdParty(file, 'line one CHANGED BY B\r\nline two\r\nline three\r\n') // 只动第 1 行
  const r = await attempt(file, [{ lines: [3, 3], replace: 'line three (A edited)' }])
  check(r.ok === true, 'C 变化在别处 ⇒ 编辑成功（不许退化成全局版本守）', `${r.error?.code ?? 'ok'}`)
  check(
    readTextFile(file) === 'line one CHANGED BY B\r\nline two\r\nline three (A edited)\r\n',
    'C 第三方的改动与我们的改动都在',
    JSON.stringify(readTextFile(file)),
  )
}
{
  const file = path.join(tmp, 'c_append.md')
  writeBytes(file, F1_BEFORE)
  await read(file, { mode: 'full' })
  thirdParty(file, `${F1_BEFORE}appended by B\r\n`)
  const r = await attempt(file, [{ lines: [3, 3], replace: 'line three (A edited)' }])
  check(r.ok === true, 'C 只在尾部追加 ⇒ 编辑成功', `${r.error?.code ?? 'ok'}`)
  check(
    readTextFile(file) === 'line one\r\nline two\r\nline three (A edited)\r\nappended by B\r\n',
    'C 追加的行仍在、被寻址行已改',
    JSON.stringify(readTextFile(file)),
  )
}

// ── 段D：带 expect 的 hunk —— 三态各自断言（闸门不介入）──────────────────────
// C1 把判据改成"被受寻址区间**包含** + 这段文字在**全文件唯一**"，C3 又把"判定不出意图"的
// 那一类失败从抛错改成**结果通道**。于是"expect 对不上"不再是一句话，而是三种互不相同的结论：
//   包含且唯一 ⇒ applied ｜ 不唯一 ⇒ needs_choice（带候选）｜ 完全不含 ⇒ not_found。
// 本段三种各写一条，一条都不笼统：outcome / code / applied / 候选 / 磁盘 一个不少；
// 另有第四条钉住"短引文不参与放松"（<12 字符仍要求整段相等）。
// C17 之后唯一性**按地址形态分档**：调用方自己写出坐标（`lines`）时区间就是地址，引文全文多处
// 也放行（D3a）；地址来自线索（`line_cue`）时区间是引擎猜的，引文不唯一仍拒且给候选（D3b）。
say('')
say('=== D. 带 expect 的 hunk：坐标档不唯一也通过（C17）/ 线索档不唯一⇒needs_choice / 不含⇒not_found ===')
{
  const file = path.join(tmp, 'd_expect_old.md')
  writeBytes(file, F1_BEFORE)
  await read(file, { mode: 'full' })
  thirdParty(file, F1_AFTER_B)
  // expect 写的是**读到的旧内容**（'line three'，10 字符 < 12 ⇒ 不参与放松，仍要求整段相等），
  // 而区域已被第三方改成 'line three CHANGED BY B' ⇒ 区间不含它 ⇒ not_found。
  // 码仍是 `LOCATOR_ASSERT_MISMATCH`（与改前同码）——变的只是它现在走回执，而不是异常。
  const r = await attempt(file, [{ lines: [3, 3], expect: 'line three', replace: 'x' }])
  check(r.ok === true, 'D1 expect 对不上不再抛错（走结果通道）', `threw=${r.error?.code ?? 'no'}`)
  check(
    r.out?.outcome === 'not_found' && r.out?.code === 'LOCATOR_ASSERT_MISMATCH',
    `D1 回执 outcome=not_found / code 与改前同码：${r.out?.outcome}/${r.out?.code}`,
  )
  check(
    Array.isArray(r.out?.applied) && r.out.applied.length === 0,
    'D1 applied 为空数组（结构上可读：一个 hunk 都没落盘）',
    JSON.stringify(r.out?.applied ?? null),
  )
  check(typeof r.out?.next === 'string' && r.out.next.length > 0, 'D1 回执给出下一步 next', String(r.out?.next).slice(0, 56))
  check(
    /shorter than 12 chars/.test(String(r.out?.message)),
    'D1 回执写明这次为何仍要求整段相等（口径可见，不是静默规则）',
    String(r.out?.message).slice(-72),
  )
  check(readTextFile(file) === F1_AFTER_B, 'D1 磁盘未变', JSON.stringify(readTextFile(file)))
}
{
  const file = path.join(tmp, 'd_expect_new.md')
  writeBytes(file, F1_BEFORE)
  await read(file, { mode: 'full' })
  thirdParty(file, F1_AFTER_B)
  // 第一态：引文（22 字符 ≥ 12）被区间**包含**且全文唯一 ⇒ 放松后通过（改前要求整段相等）。
  // expect 闸门放行，区域闸门对带 expect 的 hunk 不介入 ⇒ 落盘成功。
  const r = await attempt(file, [{ lines: [3, 3], expect: 'line three CHANGED BY B', replace: 'line three (A edited)' }])
  check(r.ok === true && r.out?.outcome === 'applied', 'D2 引文被区间包含且全文唯一 ⇒ 通过（闸门不重复拦）', `${r.error?.code ?? `outcome=${r.out?.outcome}`}`)
  check(
    readTextFile(file) === 'line one\r\nline two\r\nline three (A edited)\r\n',
    'D2 落盘正确',
    JSON.stringify(readTextFile(file)),
  )
}
{
  /**
   * 第二态（坐标档，C17）：引文（'let sum = 0;' 正好 12 字符，到放松阈值）在**全文出现 2 次**，
   * 而调用方给的是**精确坐标** `lines: [3,3]` —— 区间就是它指的地址，唯一性不再提供信息
   * ⇒ **通过**。改前这一条钉的是 needs_choice + 候选（旧读数：58/62，四条红全在这一块）。
   */
  const DUP = 'let sum = 0;\r\nline two\r\nlet sum = 0;\r\n'
  const file = path.join(tmp, 'd_expect_dup.md')
  writeBytes(file, DUP)
  await read(file, { mode: 'full' })
  const r = await attempt(file, [{ lines: [3, 3], expect: 'let sum = 0;', replace: 'let sum = 1;' }])
  check(r.ok === true, 'D3a 坐标档下引文不唯一不再拦（走结果通道）', `threw=${r.error?.code ?? 'no'}`)
  check(
    r.out?.outcome === 'applied' && r.out?.code === undefined,
    `D3a 回执 outcome=applied（坐标就是地址，唯一的另一处不是歧义）：${r.out?.outcome}/${r.out?.code}`,
  )
  check(
    readTextFile(file) === 'let sum = 0;\r\nline two\r\nlet sum = 1;\r\n',
    'D3a 改的正是坐标指的那一处，另一处一字未动',
    JSON.stringify(readTextFile(file)),
  )
  check(
    Array.isArray(r.out?.candidates) === false,
    'D3a 通过时不抛候选清单（needs_choice 那一态没被错用）',
    JSON.stringify(r.out?.candidates ?? null),
  )

  /**
   * 第二态（线索档）：同一份文件、同一段引文，地址换成**词线索** `line_cue` —— 区间由引擎
   * 按线索算出来，引文不唯一就判不出意图 ⇒ **旧结论原样保留**：needs_choice + 候选 + 一句
   * “补上下文” + 磁盘不变。这是本段迁移后必须逐条留住的那一半。
   */
  const cueFile = path.join(tmp, 'd_expect_dup_cue.md')
  writeBytes(cueFile, DUP)
  await read(cueFile, { mode: 'full' })
  const cue = await attempt(cueFile, [{ line_cue: 'line two', expect: 'let sum = 0;', replace: 'let sum = 1;' }])
  check(cue.ok === true, 'D3b 线索档下判定不出意图仍不抛错（走结果通道）', `threw=${cue.error?.code ?? 'no'}`)
  check(
    cue.out?.outcome === 'needs_choice' && cue.out?.code === 'LOCATOR_ASSERT_MISMATCH',
    `D3b 回执 outcome=needs_choice（要调用方选一处，不许猜）：${cue.out?.outcome}/${cue.out?.code}`,
  )
  check(
    JSON.stringify((cue.out?.candidates ?? []).map((c) => c.line)) === '[1,3]',
    'D3b 候选把两处行号都带回来了（needs_choice 的全部价值在这里）',
    JSON.stringify(cue.out?.candidates ?? null),
  )
  check(
    /quote more of the surrounding text/.test(String(cue.out?.message)),
    'D3b 回执要求补上下文（终态原文：不唯一时要求补上下文并给候选位置）',
    String(cue.out?.message).slice(0, 80),
  )
  check(
    Array.isArray(cue.out?.applied) && cue.out.applied.length === 0 && readTextFile(cueFile) === DUP,
    'D3b applied 为空数组且磁盘未变（没有随便挑一处改掉）',
    JSON.stringify(readTextFile(cueFile)),
  )

  /**
   * ── 本套件的**变异反证**：分档的唯一开关是调用方给的坐标。把同一条 hunk 从 `lines` 换成
   * `line_cue`（同一份区间形状、同一段引文），结论必须由 applied 翻成 needs_choice ——
   * 也就是把 C17 的放宽收回去时，本套件的 D3a 三条当场红。
   */
  check(
    r.out?.outcome === 'applied' && cue.out?.outcome === 'needs_choice',
    'D3c 分档开关可机械核对：同引文同区间，坐标档 ⇒ applied；线索档 ⇒ needs_choice（收回忆放宽则 D3a 必红）',
    `坐标档=${r.out?.outcome} / 线索档=${cue.out?.outcome}`,
  )
}
{
  // 第三态：引文（32 字符）在全文**唯一**，但那处在区间之外 ⇒ 区间不含它 ⇒ not_found，
  // 且回执点名它真正所在的行（模型据此改地址，而不是重试同一个地址）。
  const SRC3 = 'const alpha = compute(INPUT_VALUE);\r\nconst beta = compute(INPUT_VALUE);\r\nreturn alpha + beta;\r\n'
  const file = path.join(tmp, 'd_expect_elsewhere.md')
  writeBytes(file, SRC3)
  await read(file, { mode: 'full' })
  const r = await attempt(file, [{ lines: [3, 3], expect: 'const alpha = compute(INPUT_VALUE);', replace: 'x' }])
  check(r.ok === true, 'D4 引文在区间之外不再抛错（走结果通道）', `threw=${r.error?.code ?? 'no'}`)
  check(
    r.out?.outcome === 'not_found' && r.out?.code === 'LOCATOR_ASSERT_MISMATCH',
    `D4 回执 outcome=not_found：${r.out?.outcome}/${r.out?.code}`,
  )
  check(
    String(r.out?.message).includes('line 1') && /outside the addressed region/.test(String(r.out?.message)),
    'D4 回执点出引文真正所在的那一行（第 1 行）',
    String(r.out?.message).slice(0, 96),
  )
  check(readTextFile(file) === SRC3, 'D4 磁盘未变', JSON.stringify(readTextFile(file)))
}

// ── 段E：同轮连编同一区域两次都成功 ────────────────────────────────────────
say('')
say('=== E. 同一轮里对同一区域连编两次：都成功（写成功后刷新观测）===')
{
  const file = path.join(tmp, 'e.md')
  writeBytes(file, F1_BEFORE)
  await read(file, { mode: 'full' })
  const r1 = await attempt(file, [{ lines: [3, 3], replace: 'third (A pass 1)' }])
  check(r1.ok === true, 'E 第一次编辑成功', `${r1.error?.code ?? 'ok'}`)
  const r2 = await attempt(file, [{ lines: [3, 3], replace: 'third (A pass 2)' }])
  check(r2.ok === true, 'E 第二次编辑（未重读）也成功——自己刚写的内容算最新观测', `${r2.error?.code ?? 'ok'}`)
  check(readTextFile(file) === 'line one\r\nline two\r\nthird (A pass 2)\r\n', 'E 落盘为第二次的结果', JSON.stringify(readTextFile(file)))
}

// ── 段F：从未读过的文件 ────────────────────────────────────────────────────
say('')
say('=== F. 从未被 aura_read 读过的文件：不拦，但回执带 unverified_region ===')
{
  const file = path.join(tmp, 'f_never_read.md')
  writeBytes(file, F1_BEFORE)
  const r = await attempt(file, [{ lines: [3, 3], replace: 'edited without reading' }])
  check(r.ok === true, 'F 从未读过 ⇒ 编辑成功（不拦）', `${r.error?.code ?? 'ok'}`)
  check(r.out?.unverified_region === true, 'F 回执带 unverified_region: true', JSON.stringify(r.out?.unverified_region ?? null))
  check(readTextFile(file) === 'line one\r\nline two\r\nedited without reading\r\n', 'F 落盘正确', JSON.stringify(readTextFile(file)))
}
{
  const file = path.join(tmp, 'f_read.md')
  writeBytes(file, F1_BEFORE)
  await read(file, { mode: 'full' })
  const r = await attempt(file, [{ lines: [3, 3], replace: 'edited after reading' }])
  check(r.ok === true && r.out?.unverified_region === undefined, 'F 读过之后编辑：不带 unverified_region', JSON.stringify(r.out?.unverified_region ?? null))
}

// ── H：普通读也记账（闸门的判据要能拿到“上次观测”）──────────────────────────
// 背景（真机实测）：普通 `aura_read`（非 changed）之后，`changed since=<那个令牌>` 报
// “that version is no longer cached — cannot diff”——因为 `rememberRead` 只在 changed 路径被调用。
// 要拿“上次观测”当判据，必须让普通读也记账。
say('')
say('=== H. 普通读也记账：它的令牌可直接当 changed 的基准 ===')
{
  const file = path.join(tmp, 'h_cache.md')
  writeBytes(file, F1_BEFORE)
  const first = await read(file, { mode: 'full' }) // 普通读（不是 changed）
  thirdParty(file, F1_AFTER_B)
  const delta = await read(file, { since: first.version })
  check(delta.mode === 'changed', 'H 带 since 重读进入 changed', `${delta.mode}`)
  check(
    !String(delta.note ?? '').includes('no longer cached'),
    'H 普通读的令牌有基准可比（不再报 no longer cached）',
    JSON.stringify(String(delta.note ?? '')),
  )
  check(/changed region/.test(delta.text ?? ''), 'H 差异被当成一次真实改动报出改动窗口', JSON.stringify((delta.text ?? '').split('\n')[0]))
}

// ── I：create 之后紧接着编辑，不算“从未观测” ────────────────────────────────
say('')
say('=== I. create → edit：新建的内容也是“自己刚写过的内容”===')
{
  const file = path.join(tmp, 'i_created.md')
  const created = await editTool.execute({ file_path: file, create: F1_BEFORE }, exec)
  check(created.operation === 'create', 'I 创建成功', `${created.operation}`)
  const r = await attempt(file, [{ lines: [3, 3], replace: 'edited after create' }])
  check(r.ok === true, 'I 创建后编辑成功', `${r.error?.code ?? 'ok'}`)
  check(r.out?.unverified_region === undefined, 'I 不带 unverified_region（刚创建的内容就是最新观测）', JSON.stringify(r.out?.unverified_region ?? null))
}

// ── J：四层寻址共用同一条判据（区域文本，不是行号、也不是整份版本）──────────
say('')
say('=== J. 区域级：符号/锚点整体位移后仍可编（行号层则拒）===')
{
  const SRC = '// head\n\nfunction alpha() {\n  return 1\n}\n\nfunction beta() {\n  return 2\n}\n'
  const SHIFTED = '// inserted by B 1\n// inserted by B 2\n// head\n\nfunction alpha() {\n  return 1\n}\n\nfunction beta() {\n  return 2\n}\n'
  // 必须是可索引的扩展名：`target=` 走符号表（`.md` 会得到 LOCATOR_NO_LANGUAGE）
  const file = path.join(tmp, 'j.js')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  thirdParty(file, SHIFTED)
  // 行号层：同一个行号现在指向别的文本 ⇒ 拒（与段B 同类）
  const byLines = await attempt(file, [{ lines: [4, 4], replace: '  return 99' }])
  check(!byLines.ok && byLines.error.code === 'PATCH_STALE_REGION', 'J 行号层：位移后仍按原行号编 ⇒ 拒', `${byLines.error?.code ?? 'ok'}`)
  // 符号层：区域（函数体）文本没变，只是整体下移 ⇒ 放行
  const byTarget = await attempt(file, [{ target: 'function:alpha', replace: 'function alpha() {\n  return 42\n}' }])
  check(byTarget.ok === true, 'J 符号层：同一函数的文本未变（只是位移）⇒ 成功', `${byTarget.error?.code ?? 'ok'}`)
  check(
    readTextFile(file) === SHIFTED.replace('  return 1\n', '  return 42\n'),
    'J 改动落在位移后的那个函数上，插入的两行仍在',
    JSON.stringify(readTextFile(file)),
  )
  // 锚点层：同样的位移下，锚点文本未变 ⇒ 放行（第四层也共用这条判据）
  const byAnchor = await attempt(file, [{ anchor: 'function beta() {\n  return 2', replace: 'function beta() {\n  return 7' }])
  check(byAnchor.ok === true, 'J 锚点层：锚点文本未变（只是位移）⇒ 成功', `${byAnchor.error?.code ?? 'ok'}`)
}

// ── K：接缝——观测缓存必须**只有一套约定**（否则 BOM 文件第 1 行被误拒）────────
// 审计在真机（provider-faithful mock）上量到的表：带 BOM 的文件，若“上次观测”来自 `changed`，
// 无 expect 地改**第 1 行**会被误拒 PATCH_STALE_REGION（带 BOM 时 `changed` 曾把
// `BYTE_ORDER_MARK + source` 存进缓存，而闸门的基准 `ctx.fs.readText` 永远是提供方视角）。
// 本 mock 的 readText 就是 `TextDecoder('utf-8',{fatal:true})` ⇒ **会去 BOM**，与真提供方同形。
say('')
say('=== K. BOM 接缝：观测来源（changed / full / map）× 被编行（1 / 2）===')
const BOM_BYTES = [0xef, 0xbb, 0xbf]
const bomJs = (text) => Buffer.concat([Buffer.from(BOM_BYTES), Buffer.from(new TextEncoder().encode(text))])
const J_SRC = 'const one = 1\nconst two = 2\nconst three = 3\n'
const hasBomBytes = (p) => {
  const b = readBytes(p)
  return b.length >= 3 && BOM_BYTES.every((x, i) => b[i] === x)
}
const seamCase = async (fileName, observeMode, lineNo, mutate, withBom = true) => {
  const file = path.join(tmp, fileName)
  fs.writeFileSync(file, withBom ? bomJs(J_SRC) : Buffer.from(new TextEncoder().encode(J_SRC)))
  await read(file, { mode: observeMode })
  if (mutate !== undefined) thirdParty(file, mutate)
  const r = await attempt(file, [{ lines: [lineNo, lineNo], replace: `const line${lineNo} = 99` }])
  return { file, r }
}
{
  const { file, r } = await seamCase('k_changed_line1.js', 'changed', 1, undefined)
  check(r.ok === true, 'K 带 BOM + 上次是 changed 读 + 改第 1 行 ⇒ 必须成功（不许误拒）', `${r.error?.code ?? 'ok'}`)
  check(hasBomBytes(file), 'K 编辑后 BOM 仍在', JSON.stringify(readBytes(file).subarray(0, 3).toJSON().data))
  check(readTextFile(file) === 'const line1 = 99\nconst two = 2\nconst three = 3\n', 'K 第 1 行已改、其余不变', JSON.stringify(readTextFile(file)))
}
{
  const { r } = await seamCase('k_changed_line2.js', 'changed', 2, undefined)
  check(r.ok === true, 'K 带 BOM + changed 读 + 改第 2 行 ⇒ 成功', `${r.error?.code ?? 'ok'}`)
}
for (const mode of ['full', 'map', 'digest']) {
  const { r } = await seamCase(`k_${mode}_line1.js`, mode, 1, undefined)
  check(r.ok === true, `K 带 BOM + ${mode} 读 + 改第 1 行 ⇒ 成功`, `${r.error?.code ?? 'ok'}`)
}
{
  const { file, r } = await seamCase('k_no_bom_line1.js', 'changed', 1, undefined, false)
  check(r.ok === true, 'K 无 BOM + changed 读 + 改第 1 行 ⇒ 成功', `${r.error?.code ?? 'ok'}`)
  check(!hasBomBytes(file), 'K 无 BOM 的文件编辑后仍无 BOM', JSON.stringify(readBytes(file).subarray(0, 3).toJSON().data))
}
{
  // 反向：接缝修好之后，第 1 行**真的**被第三方改过仍然必须拒（别为了修误拒把闸门关掉）
  const { file, r } = await seamCase('k_changed_line1_stale.js', 'changed', 1, bomJs('const one CHANGED BY B = 1\nconst two = 2\nconst three = 3\n'))
  check(!r.ok && r.error.code === 'PATCH_STALE_REGION', 'K 带 BOM + changed 读 + 第 1 行真被改过 ⇒ 仍拒绝', `${r.error?.code ?? 'ok'}`)
  check(readTextFile(file) === 'const one CHANGED BY B = 1\nconst two = 2\nconst three = 3\n', 'K 拒绝时磁盘保持第三方内容', JSON.stringify(readTextFile(file)))
}

// ── L：BOM 的事实由**显式手段**报告（不再靠缓存里偷偷加前缀）─────────────────
say('')
say('=== L. changed 报告“只差 BOM”：点名 + 给窗口，而不是说没变 ===')
{
  const file = path.join(tmp, 'l_bom_changed.md')
  fs.writeFileSync(file, bomJs(F1_BEFORE))
  const first = await read(file, { mode: 'changed' }) // 首读：建立基准（带 BOM）
  thirdParty(file, F1_BEFORE) // 只去掉 BOM，正文一字未改
  const delta = await read(file, { mode: 'changed', since: first.version })
  check(delta.version !== first.version, 'L 令牌随 BOM 变化', `${first.version} -> ${delta.version}`)
  check(!String(delta.note ?? '').includes('no change'), 'L 不许说 “no change”', JSON.stringify(String(delta.note ?? '')))
  check(/byte-order mark/.test(String(delta.note ?? '')), 'L 回执点名 BOM 被去掉', JSON.stringify(String(delta.note ?? '')))
  check(
    /changed region/.test(String(delta.text ?? '')) && String(delta.text ?? '').includes('1: '),
    'L 仍给出改动窗口（BOM 在偏移 0 ⇒ 第 1 行）',
    JSON.stringify(String(delta.text ?? '').split('\n')[0]),
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// C54：账本的**路径同一性** —— 同一个磁盘文件，不管用哪种写法读、哪种写法写，
// 陈旧闸门都必须按**同一处**记账。
//
// 改前实测（本机 Windows，靶子在 `%TEMP%`）：读 `…\Beta.js` → 第三方改掉被寻址的第 3 行
// → 用 `…\beta.js` 发一个无 `expect` 的 `lines` 编辑 ⇒ **静默覆盖成功**。
// 归一化落在 `read-core.mjs` 的 `ledgerPathKey` / `resolveLedgerKey`（唯一一处）；
// 本段四组判据：段M 那个洞已堵、段N 是同一个键、段O 不许多并、段P 既有断言一条不少。
// ══════════════════════════════════════════════════════════════════════════════
const EXISTING_ASSERTIONS = results.length // 本单新增段之前的断言数（改前 67 条）

/** 本段用到的写法：同一个磁盘文件在 Windows 上常见的几种写法差异。 */
const SPELLINGS = [
  ['小写', (dir) => path.join(dir, 'beta.js')],
  ['全大写', (dir) => path.join(dir, 'BETA.JS')],
  ['点斜线', (dir) => `${dir}${path.sep}.${path.sep}Beta.js`],
  ['冗余分隔符', (dir) => `${dir}${path.sep}${path.sep}Beta.js`],
  ['反斜线绝对写法', (dir) => `${dir}\\.\\Beta.js`],
  ['正向斜线绝对写法', (dir) => `${dir.replaceAll('\\', '/')}/Beta.js`],
]

say('')
say('=== M. 改前必红的洞：读一种写法、写另一种写法 ⇒ 陈旧闸门必须照样拒（施工单段A）===')
let mIndex = 0
for (const [label, spell] of SPELLINGS) {
  mIndex += 1
  const dir = path.join(tmp, `m${mIndex}_${label}`)
  fs.mkdirSync(dir, { recursive: true })
  const base = path.join(dir, 'Beta.js')
  writeBytes(base, F1_BEFORE)
  const alt = spell(dir)
  /**
   * 本平台是否把这种写法解析到**同一个文件**：不解析就不是“同一个磁盘文件的另一种写法”，
   * 那条洞在这台机器上也不成立 —— 如实记录分支，而不是假装判过（POSIX 上 `\` 是文件名字符）。
   */
  if (!fs.existsSync(alt)) {
    check(true, `M ${label}：本平台不把该写法解析到同一个文件 ⇒ 这条洞在本机不成立`, alt)
    check(readTextFile(base) === F1_BEFORE, `M ${label}：未发编辑 ⇒ 靶子一字未动（跳过分支的对称记录）`, JSON.stringify(readTextFile(base)))
    continue
  }
  await read(base, { mode: 'full' }) // 基准写法：建立观测
  thirdParty(base, F1_AFTER_B) // 第三方改掉**被寻址的第 3 行**
  const r = await attempt(alt, [{ lines: [3, 3], replace: 'line three (A overwrote)' }])
  check(
    !r.ok && r.error.code === 'PATCH_STALE_REGION',
    `M ${label}：换个写法发无 expect 编辑 ⇒ 结构化拒绝`,
    `${r.error?.code ?? 'ok — 静默放行'}`,
  )
  check(readTextFile(base) === F1_AFTER_B, `M ${label}：磁盘保持第三方内容（我们的编辑一字未落）`, JSON.stringify(readTextFile(base)))
}

say('')
say('=== N. 同一个文件的不同写法在账本里是同一个键（施工单段B）===')
{
  const dir = path.join(tmp, 'n_same_key')
  fs.mkdirSync(dir, { recursive: true })
  const base = path.join(dir, 'Beta.js')
  writeBytes(base, F1_BEFORE)
  /**
   * 判据一（直接断言，纯函数）：**写法**差异（点斜线／冗余分隔符／反斜线／正斜线）归到同一个词法键。
   *
   * 大小写**故意不在词法层折叠**：词法层拿不到"这个文件系统是不是区分大小写"这个事实
   * （引擎被禁直接碰 `node:fs` / 平台分支），一律折叠会把大小写敏感文件系统上两个真不同的
   * 文件并成一个键 —— 那是施工单明令禁止的失败方向（段O 钉它）。所以大小写那半条交给
   * 别名索引按**证据**解，判据二／三就是它的可观测判据。
   */
  const shapeKeys = [
    ...new Set(SPELLINGS.filter(([label]) => label !== '小写' && label !== '全大写').map(([, spell]) => ledgerPathKey(spell(dir)))),
  ]
  check(shapeKeys.length === 1, 'N 写法差异（点斜线／冗余分隔符／反斜线／正斜线）经 ledgerPathKey 归为同一个键', JSON.stringify(shapeKeys))
  const allKeys = [...new Set(SPELLINGS.map(([, spell]) => ledgerPathKey(spell(dir))))]
  check(
    allKeys.length === 3,
    'N 词法键**保留大小写**（六种写法只汇成三组：小写／全大写／原名 —— 折叠只发生在带证据的解析那一步）',
    JSON.stringify(allKeys),
  )
  // 判据二（可观测的等价判据）：换一种写法重读，账本必须认出“这就是我读过的那一份”。
  const first = await read(base, { mode: 'full' })
  const alt = fs.existsSync(path.join(dir, 'beta.js')) ? path.join(dir, 'beta.js') : `${dir}${path.sep}.${path.sep}Beta.js`
  const delta = await read(alt, { mode: 'changed', since: first.version })
  check(delta.version === first.version, 'N 换个写法重读：令牌与基准写法读到的逐字符相同', `${first.version} vs ${delta.version}`)
  check(
    /no change since that version/.test(String(delta.note ?? '')),
    'N 换个写法重读 ⇒ 账本认出是同一个键（说 no change，而不是“那个版本不在缓存里”）',
    JSON.stringify(String(delta.note ?? '')),
  )
  // 判据三：换写法做一次**正常**编辑不许被误拒，且回执不许谎称“没核对过”。
  const r = await attempt(alt, [{ lines: [3, 3], replace: 'line three (A edited)' }])
  check(r.ok === true, 'N 换个写法发无 expect 编辑：文件没被别人改过 ⇒ 照常成功（不许误拒）', `${r.error?.code ?? 'ok'}`)
  check(
    r.ok === true && r.out?.unverified_region === undefined,
    'N 回执不谎称“没核对过”（basis 是观测而不是 none）',
    JSON.stringify(r.out?.unverified_region ?? null),
  )
  /**
   * 判据四（**判别性**在这一条）：用一个**从未读过**的第三种写法做编辑。
   *
   * 判据二／三都能被"上一次用那个写法读过一次"解释掉（读一次就把那个键也登记上了），
   * 所以它们对"两种写法是同一个键"这条命题**不具判别力** —— 实测：把归一化关掉
   * （`ledgerPathKey` 恒等、别名索引旁路），判据二／三照样全绿。这一条不一样：这个写法
   * 从没被读过，账本里只有另外那把键。归一化在 ⇒ 认得出那份观测（basis=observation，
   * 回执不带 `unverified_region`）；归一化不在 ⇒ 认不出，回执谎称"没核对过"。
   */
  const third = path.join(dir, 'BETA.JS')
  if (!fs.existsSync(third)) {
    check(true, 'N 本平台不把另一种写法解析到同一个文件 ⇒ 这条判别性判据在本机不成立', third)
    check(readTextFile(base) === 'line one\nline two\nline three (A edited)\n', 'N 未发编辑 ⇒ 靶子停在上一判据的结果上', JSON.stringify(readTextFile(base)))
  } else {
    const r3 = await attempt(third, [{ lines: [1, 1], replace: 'line one (A edited)' }])
    check(r3.ok === true, 'N 用一个从未读过的写法编辑：照常成功（不许误拒）', `${r3.error?.code ?? 'ok'}`)
    check(
      r3.ok === true && r3.out?.unverified_region === undefined,
      'N 从未读过的写法也认得出账本里那份观测（判别性：关掉归一化这一条必红）',
      JSON.stringify(r3.out?.unverified_region ?? null),
    )
  }
}

say('')
say('=== O. 反向：两个**真的不同**的文件不得被并成一个键（施工单段C）===')
{
  const upperDir = path.join(tmp, 'o_upper')
  const lowerDir = path.join(tmp, 'o_lower')
  fs.mkdirSync(upperDir, { recursive: true })
  fs.mkdirSync(lowerDir, { recursive: true })
  const upper = path.join(upperDir, 'Beta.js')
  const lower = path.join(lowerDir, 'beta.js')
  // 判据一：词法键**保留大小写**（键不是输入的 toLowerCase）。
  check(
    ledgerPathKey(upper) !== ledgerPathKey(lower),
    'O1 仅大小写不同的两个路径给出不同的键（键不折叠大小写）',
    `${ledgerPathKey(upper)} | ${ledgerPathKey(lower)}`,
  )
  // 判据二：**不存在**的路径（新建场景）同样不折叠 —— 没有文件系统证据时一律不许合并。
  check(
    ledgerPathKey(path.join(upperDir, 'Nope.js')) !== ledgerPathKey(path.join(upperDir, 'nope.js')),
    'O2 两个**不存在**的路径也不因大小写被并成一个键',
    `${ledgerPathKey(path.join(upperDir, 'Nope.js'))} | ${ledgerPathKey(path.join(upperDir, 'nope.js'))}`,
  )
  /**
   * 判据三～七：真·两个仅大小写不同的文件（需要**大小写敏感的目录**，本机用 `fsutil` 开）。
   * 开不出来就退到等价判据 —— 两支都恰好五条断言，读数里写明走的是哪一支。
   */
  let caseSensitive = false
  const csDir = path.join(tmp, 'o_case_sensitive')
  fs.mkdirSync(csDir, { recursive: true })
  try {
    execFileSync('fsutil', ['file', 'setCaseSensitiveInfo', csDir, 'enable'], { stdio: 'ignore' })
    const probe = path.join(csDir, 'Probe.js')
    writeBytes(probe, 'p\n')
    caseSensitive = fs.existsSync(path.join(csDir, 'probe.js')) === false
    fs.rmSync(probe, { force: true })
  } catch {
    caseSensitive = false
  }
  if (caseSensitive) {
    const U = path.join(csDir, 'Beta.js')
    const L = path.join(csDir, 'beta.js')
    writeBytes(U, F1_BEFORE)
    writeBytes(L, 'l one\nl two\nl three\n') // 内容不同 ⇒ 是两个真文件，不是同一个
    check(
      fs.existsSync(U) && fs.existsSync(L) && readTextFile(U) !== readTextFile(L),
      'O3 大小写敏感目录：两个仅大小写不同的文件并存且内容不同（真·两个文件）',
      JSON.stringify([readTextFile(U), readTextFile(L)]),
    )
    await read(U, { mode: 'full' })
    await read(L, { mode: 'full' })
    /**
     * 判别性就在这里：**没有任何第三方改动**，按各自的写法编辑各自的文件，两个都必须成功。
     * 把两个文件并成一个键的实现到这一步必然露馅 —— 折出来的那个键里只留得下最后读过的那一份，
     * 先读的那份观测被顶掉 ⇒ 闸门拿错基准 ⇒ 误拒。
     * 实测（变异反证 B）：`ledgerPathKey` 改成 `return filePath.toLowerCase()` 时 O4 当场红。
     */
    const u = await attempt(U, [{ lines: [3, 3], replace: 'line three EDITED BY A' }])
    check(u.ok === true, 'O4 按 U 自己的写法编辑 U（无第三方改动）⇒ 必须成功', `${u.error?.code ?? 'ok'}`)
    const l = await attempt(L, [{ lines: [3, 3], replace: 'l three EDITED BY A' }])
    check(l.ok === true, 'O5 按 L 自己的写法编辑 L（无第三方改动）⇒ 必须成功', `${l.error?.code ?? 'ok'}`)
    check(
      readTextFile(U) === 'line one\r\nline two\r\nline three EDITED BY A\r\n' && readTextFile(L) === 'l one\nl two\nl three EDITED BY A\n',
      'O6 两份改动各归各的：落到的正是自己那份文件',
      JSON.stringify([readTextFile(U), readTextFile(L)]),
    )
    thirdParty(U, F1_AFTER_B) // 第三方只改 U 的被寻址行
    const r = await attempt(L, [{ lines: [3, 3], replace: 'l three EDITED AGAIN' }])
    check(r.ok === true, 'O7 第三方改了 U 之后编辑 L：L 自己的观测还在 ⇒ 必须成功（不被牵连）', `${r.error?.code ?? 'ok'}`)
  } else {
    check(
      true,
      'O3 本机文件系统不支持同目录大小写并存 ⇒ “真·两个文件”那一支不可用，退到等价判据',
      csDir,
    )
    const f = path.join(upperDir, 'Beta.js')
    writeBytes(f, F1_BEFORE)
    await read(f, { mode: 'full' })
    const r = await attempt(`${upperDir}${path.sep}.${path.sep}Beta.js`, [{ lines: [3, 3], replace: 'line three (A edited)' }])
    check(r.ok === true, 'O4 同一文件换写法编辑：照常成功（不许把不同文件并进来、也不许把它踢出去）', `${r.error?.code ?? 'ok'}`)
    check(
      readTextFile(f) === 'line one\r\nline two\r\nline three (A edited)\r\n',
      'O5 改动确实落盘',
      JSON.stringify(readTextFile(f)),
    )
    const r2 = await attempt(`${upperDir}${path.sep}${path.sep}Beta.js`, [{ lines: [1, 1], replace: 'line one (A edited)' }])
    check(
      r2.ok === true && r2.out?.unverified_region === undefined,
      'O6 再换一种写法编辑（无第三方改动）⇒ 仍然成功、且不谎称“没核对过”',
      `${r2.error?.code ?? `unverified=${r2.out?.unverified_region ?? 'none'}`}`,
    )
    check(
      readTextFile(f) === 'line one (A edited)\r\nline two\r\nline three (A edited)\r\n',
      'O7 两次改动都在',
      JSON.stringify(readTextFile(f)),
    )
  }
}

say('')
say('=== P. 既有断言一条不少（施工单段D）===')
/**
 * 改前总数 67 = 本单新增段之前的 66 条 + **紧跟在本段后面**那条收尾的 `writeText` 判据。
 * 写死 66 而不是 67：段M–O 的断言全部落在 `EXISTING_ASSERTIONS` 快照**之后**，
 * 所以这个数只可能因为**既有断言被删**而变小 —— 那正是它要拦的事。
 */
const preExistingAssertions = EXISTING_ASSERTIONS + 1
check(
  preExistingAssertions >= 67,
  'P 既有断言一条不少（改前 67 条 = 本单新增段之前的 66 条 + 收尾那条 writeText 判据）',
  `${preExistingAssertions} 条`,
)

// ── 收尾：写回路径仍然是 writeText ─────────────────────────────────────────
say('')
check(calls.editText === 0 && calls.writeText > 0, `写回路径：writeText ${calls.writeText} 次 / editText ${calls.editText} 次`)

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
  process.exitCode = 1
}
