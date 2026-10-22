/**
 * arg-shape-test —— `aura_edit` 的**入参形状**容错面（取自 403 会话日志的失败构成）。
 *
 * ## 为什么单开一个套件
 *
 * `probes/edit-failure-census.mjs` 量出写失败的构成，头部两项都不是"改不动"，而是**没进门**：
 *
 * ```
 * 984 次失败 / 6039 次调用（16.3%）
 *   PATCH_EXPECT_MISMATCH  548  55.7%   ← 已修（回执贴出实际内容后自纠率 77.5%，0.4% 原样重发）
 *   LOCATOR_AMBIGUOUS      116  11.8%   ← 已修（回执带候选行）
 *   unclassified            94   9.6%
 *       其中 27 次：`hunks must be a non-empty array`，入参形状一律是
 *                    `{file_path, start_line, end_line, replace}`（单个 hunk 平铺在顶层）
 *       其中 12 次：hunk 里塞了未声明字段（`replace_all` / `replace_note` …，共 13/9541 个 hunk）
 * ```
 *
 * 前两类修完之后，第三类里**唯一成规模**的就是平铺形状（27 次 ≈ 全部失败的 2.7%）。
 * 未声明字段只有 13 个 hunk（0.14%），**刻意不放宽 schema**：为 0.14% 把 schema 打开，
 * 等于让"参数写错"永远不再被指出——本项目的取舍是宽容**形状**、不宽容**拼写**。
 *
 * 本套件钉的就是这条分界：容错的那一侧要真的能用，不容错的那一侧要真的报错。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expectVerdict } from './locator-api.mjs'
import { contextServices } from './mock-ctx.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const tmp = path.join(os.tmpdir(), `arg-shape-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const readBytes = (p) => fs.readFileSync(p)
const writeBytes = (p, t) => fs.writeFileSync(p, Buffer.from(new TextEncoder().encode(t)))
const decode = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b)

let version = 1
const fsService = {
  resolve: async (p) => ({ displayPath: p, targetKey: p }),
  stat: async (t) => (fs.existsSync(t.targetKey) ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size } : undefined),
  readText: async (t) => decode(readBytes(t.targetKey)),
  readByteRange: async (t, range) => readBytes(t.targetKey).subarray(range.offset, range.offset + range.length),
  writeText: async (t, content, expected) => {
    const p = t.targetKey
    const existed = fs.existsSync(p)
    if (expected?.kind === 'replaceIfVersion' && (!existed || `v${version}` !== expected.version)) {
      throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
    }
    writeBytes(p, content)
    version += 1
    return { version: `v${version}`, operation: existed ? 'update' : 'create', after: content }
  },
  editText: async () => {
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
/** 直接喂原始入参：本套件测的就是"形状"，不能先替它归一。 */
const raw = async (args) => {
  try {
    return { ok: true, out: await editTool.execute(args, exec) }
  } catch (error) {
    return { ok: false, code: error.code, message: error.message }
  }
}

const SRC = 'alpha\nbravo\ncharlie\ndelta\necho\n'

// ── 段A：平铺形状（日志里 27 次）必须能用 ────────────────────────────────────
say('=== A. 单个 hunk 平铺在顶层：必须能编辑（日志里 27 次失败就是这个形状）===')
{
  const file = path.join(tmp, 'a_flat.md')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  const r = await raw({ file_path: file, start_line: 3, end_line: 3, replace: 'CHARLIE' })
  check(r.ok === true, 'A start_line+end_line+replace 平铺 ⇒ 成功', r.ok ? '' : `${r.code}: ${r.message}`)
  check(decode(readBytes(file)) === 'alpha\nbravo\nCHARLIE\ndelta\necho\n', 'A 落盘正确', JSON.stringify(decode(readBytes(file))))
}
{
  const file = path.join(tmp, 'a_flat_lines.md')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  const r = await raw({ file_path: file, lines: [4, 4], replace: 'DELTA' })
  check(r.ok === true, 'A lines 平铺 ⇒ 成功', r.ok ? '' : `${r.code}: ${r.message}`)
  check(decode(readBytes(file)).includes('DELTA'), 'A 落盘正确')
}
{
  const file = path.join(tmp, 'a_flat_anchor.md')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  const r = await raw({ file_path: file, anchor: 'echo', replace: 'ECHO' })
  check(r.ok === true, 'A anchor 平铺 ⇒ 成功', r.ok ? '' : `${r.code}: ${r.message}`)
  check(decode(readBytes(file)).includes('ECHO'), 'A 落盘正确')
}
{
  // `expect` 与 `near` 也要一起搬过去：漏搬会让平铺形状**少一道闸门**（那比不支持更坏）。
  // 判决本身现在走**结果通道**（fs-contract-v2 / C3）——所以断的不是"抛不抛"，而是
  // 回执里的 outcome / code / applied / 磁盘，以及"为什么这么判"那句话。
  const file = path.join(tmp, 'a_flat_expect.md')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  const bad = await raw({ file_path: file, lines: [3, 3], expect: 'WRONG', replace: 'X' })
  check(
    bad.ok === true && bad.out?.outcome === 'not_found' && bad.out?.code === 'LOCATOR_ASSERT_MISMATCH',
    'A 平铺形状下 expect 仍然生效（闸门搬到了平铺形状里，判决走结果通道）',
    bad.ok ? `outcome=${bad.out?.outcome} code=${bad.out?.code}` : `${bad.code}: ${bad.message}`,
  )
  check(
    bad.ok === true && Array.isArray(bad.out?.applied) && bad.out.applied.length === 0,
    'A 拦下时 applied 为空数组（结构上可读：一个 hunk 都没落盘）',
  )
  check(
    bad.ok === true && /shorter than 12 chars/.test(String(bad.out?.message)),
    'A 回执写明这次为何仍按整段相等判（<12 字符不参与放松）——口径可见，不是静默规则',
    String(bad.out?.message).slice(-80),
  )
  check(decode(readBytes(file)) === SRC, 'A 被 expect 拦下时磁盘未变')
  const good = await raw({ file_path: file, lines: [3, 3], expect: 'charlie', replace: 'CHARLIE' })
  check(good.ok === true && good.out?.outcome === 'applied', 'A expect 相符时成功', good.ok ? `outcome=${good.out?.outcome}` : `${good.code}`)
}
{
  // 带 `expect` 的平铺 hunk 按**地址形态**分两档（C17）：同一份“全文两处”的引文，
  // 调用方自己写出坐标时坐标就是地址 ⇒ 通过；只给线索时唯一性照旧 ⇒ needs_choice。
  // 两档都要在平铺形状上钉住，缺一档就等于平铺形状少了一道闸门。
  const DUP = 'let sum = 0;\nline two\nlet sum = 0;\n'
  const file = path.join(tmp, 'a_flat_needs_choice.md')
  writeBytes(file, DUP)
  await read(file, { mode: 'full' })
  const r = await raw({ file_path: file, lines: [3, 3], expect: 'let sum = 0;', replace: 'let sum = 1;' })
  check(
    r.ok === true && r.out?.outcome === 'applied' && r.out?.code === undefined,
    'A 平铺形状 + 精确坐标：引文全文 2 处但坐标本身就是地址 ⇒ 通过（C17 分档，不再要求全文唯一）',
    r.ok ? `outcome=${r.out?.outcome} code=${r.out?.code}` : `${r.code}: ${r.message}`,
  )
  check(
    decode(readBytes(file)) === 'let sum = 0;\nline two\nlet sum = 1;\n',
    'A 那一处真被改掉、另一处一字未动（分档不是“不判了”，是判到坐标上）',
    JSON.stringify(decode(readBytes(file))),
  )

  // 线索档：同一份文件、同一段引文，只给词线索 ⇒ 区间是引擎猜的，仍必须拒绝并给候选
  const cueFile = path.join(tmp, 'a_flat_cue_needs_choice.md')
  writeBytes(cueFile, DUP)
  await read(cueFile, { mode: 'full' })
  const cue = await raw({ file_path: cueFile, line_cue: 'line two', expect: 'let sum = 0;', replace: 'let sum = 1;' })
  check(
    cue.ok === true && cue.out?.outcome === 'needs_choice' && cue.out?.code === 'LOCATOR_ASSERT_MISMATCH',
    'A 平铺形状 + 只给线索：引文不唯一仍 ⇒ needs_choice（候选这一态不许跟着坐标档一起松掉）',
    cue.ok ? `outcome=${cue.out?.outcome} code=${cue.out?.code}` : `${cue.code}: ${cue.message}`,
  )
  check(
    JSON.stringify((cue.out?.candidates ?? []).map((c) => c.line)) === '[1,3]',
    'A 候选把两处行号都带回来了（needs_choice 的全部价值在这里）',
    JSON.stringify(cue.out?.candidates ?? null),
  )
  check(decode(readBytes(cueFile)) === DUP, 'A needs_choice 时磁盘未变')

  // 本套件的**变异反证**：分档的唯一开关就是第 6 参 tier。同址对照——把 `tier='lines'`
  // 换成不传，同一份输入当场由通过翻成 not_unique。所以“收回 C17 放宽”时本套件必红。
  check(
    expectVerdict(DUP.split('\n'), 3, 3, 'let sum = 0;', 'let sum = 0;', 'lines') === null &&
      expectVerdict(DUP.split('\n'), 3, 3, 'let sum = 0;', 'let sum = 0;')?.kind === 'not_unique',
    'A 分档开关可机械核对：同址同引文，tier="lines" ⇒ 通过；不传 tier ⇒ not_unique（收回忆放宽则本条必红）',
    `tier=lines ⇒ ${expectVerdict(DUP.split('\n'), 3, 3, 'let sum = 0;', 'let sum = 0;', 'lines') === null ? 'pass' : 'reject'} / 不传 ⇒ ${expectVerdict(DUP.split('\n'), 3, 3, 'let sum = 0;', 'let sum = 0;')?.kind ?? 'pass'}`,
  )
}

// ── 段B：平铺形状的边界——半成品必须继续报原错 ──────────────────────────────
say('')
say('=== B. 半成品不给假地址：仍报“hunks 非空”，不误报定位失败 ===')
{
  const file = path.join(tmp, 'b_bare_replace.md')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  const r = await raw({ file_path: file, replace: 'X' })
  check(r.ok === false && /hunks must be a non-empty array/.test(String(r.message)), 'B 只有 replace（没地址）⇒ 仍报原错', String(r.message).slice(0, 90))
  check(decode(readBytes(file)) === SRC, 'B 磁盘未变')
}
{
  const file = path.join(tmp, 'b_null_keys.md')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  /**
   * 顶层显式 `null`：**拒**，不是忽略。
   *
   * 这条断言原先写的是“空键（null）不干扰真地址”（当时期望放行）。改成拒是**有依据的决定**，
   * 而不是为了变绿：
   *   · 真框架的参数校验对 `type: 'string'` 的字段不接受 `null`（实测：
   *     `invalid arguments: "target" must be a string`）；要让 null 通过就得把九个 hunk 键
   *     全改成 `oneOf: [string, null]`，而那是为了一个**调用方失误**去放宽整张声明面。
   *   · 它 fail-closed：模型不会静默改错地方。
   *   · 真实调用里显式 null 占 16817 次中的 **39 次（0.23%）**——大多是把整个 args 写成 null。
   * 为了把这 0.23% 变宽容而放宽 schema，与本项目“宽容形状、不宽容拼写”的分界不一致。
   * 工具描述里已明说：`Omit keys you do not need — an explicit null is rejected, not ignored.`
   */
  const r = await raw({ file_path: file, target: null, line_cue: null, lines: [5, 5], replace: 'ECHO' })
  check(r.ok === false, 'B 顶层显式 null ⇒ 拒（fail-closed，且描述里已说明要省略而不是置 null）', r.ok ? '放行了' : `${r.code}`)
  check(decode(readBytes(file)) === SRC, 'B 被拒时磁盘未变')
  // 对照：把不用的键**省略**就能成功——这才是描述里推荐的写法
  const omitted = await raw({ file_path: file, lines: [5, 5], replace: 'ECHO' })
  check(omitted.ok === true, 'B 对照：省略不用的键 ⇒ 成功', omitted.ok ? '' : `${omitted.code}: ${omitted.message}`)
  check(decode(readBytes(file)).includes('ECHO'), 'B 落盘正确')
}
{
  const file = path.join(tmp, 'b_false_address.md')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  // 只有 `expect`、没有地址：`expect` 不是地址键，所以不该被当成 hunk（否则会报"缺地址"而不是"没给 hunks"）
  const r = await raw({ file_path: file, expect: 'alpha', replace: 'X' })
  check(r.ok === false && /hunks must be a non-empty array/.test(String(r.message)), 'B 只有 expect ⇒ 仍报原错', String(r.message).slice(0, 90))
}

// ── 段C：未声明字段**刻意不放宽**（13/9541，不为它打开 schema）────────────────
say('')
say('=== C. 未声明字段仍由 schema 拒绝（宽松限于形状，不限于拼写）===')
{
  const file = path.join(tmp, 'c_stray.md')
  writeBytes(file, SRC)
  await read(file, { mode: 'full' })
  /**
   * ① **声明面**：必填字段名单。`hunks` 不在里面（创建路径不需要它）；`file_path` **也不在**里面
   *    ——这不是“顺手放松”，而是多目标形状逼出来的：宿主把 `required: true` 编译成
   *    `required: ['file_path']`，写上它 `{targets:[…]}` 就在参数层被拒、根本到不了 execute。
   *
   *    “二选一”想回 schema 挡：MT7 实测**本框架方言里不可表达**——参数面是隐式属性表
   *    （`compilePropertyMap`），`anyOf`/`allOf` 不在允许关键字子集里；而校验器对 `anyOf`
   *    是**静默忽略**（`{}` 照样通过），所以硬写就是一条**没有效果的声明**。证据与探测读数
   *    记在 `aura-read/index.js` 的 `file_path` 声明处。
   *
   * ② **闸门面（更强：从“查声明”改成“查行为”）**：参数面因此放行的两种“二选一”违反，
   *    必须被**唯一判据**当场拒——两个都给 ⇒ `ARGS_SHAPE_EXCLUSIVE`；两个都没给 ⇒ 也拒。
   *    任一条不再被拒，下面两条断言当场变红。
   */
  const requiredNames = editTool?.parameters?.required ?? []
  check(
    Array.isArray(requiredNames) && !requiredNames.includes('hunks') && !requiredNames.includes('file_path'),
    'C 必填名单里既没有 hunks（创建路径）也没有 file_path（多目标形状）',
    JSON.stringify(editTool?.parameters?.required ?? null),
  )
  const bothShapes = await raw({
    file_path: file,
    targets: [{ file_path: file, hunks: [{ lines: [1, 1], replace: 'X' }] }],
  })
  check(
    bothShapes.ok === false && bothShapes.code === 'ARGS_SHAPE_EXCLUSIVE',
    'C 二选一（更强）：两个都给 ⇒ 唯一判据当场拒（ARGS_SHAPE_EXCLUSIVE）',
    `${bothShapes.code}: ${String(bothShapes.message).slice(0, 90)}`,
  )
  const neitherShape = await raw({})
  check(
    neitherShape.ok === false && /file_path must be a non-empty string/.test(String(neitherShape.message)),
    'C 二选一（更强）：两个都没给 ⇒ 也拒（没有形状可用）',
    `${neitherShape.code}: ${String(neitherShape.message).slice(0, 90)}`,
  )
  check(decode(readBytes(file)) === SRC, 'C 被拒时磁盘未变（' + JSON.stringify(decode(readBytes(file))) + '）')
  // 走真框架时这是 schema 层拒绝（`... is not a declared property`）；mock 不校验入参，
  // 所以这里断言的是**声明面**：`replace_all` 不在 properties 里。
  //
  // 形状注意：`defineTool` 的 `parameters` 是 **JSON Schema**（`{type,properties,required}`），
  // 不是 `{字段名: 声明}` 的扁平映射——我第一版按扁平读，拿到空对象，而断言当时写的是
  // “能读到 …”这种**看起来在测、实际最容易被写成恒真**的句子。现在把形状也钉住。
  const declared = Object.keys(editTool?.parameters?.properties?.hunks?.items?.properties ?? {})
  check(declared.length > 0, 'C 能读到 hunks.items.properties（声明面可见）', declared.join(','))
  for (const stray of ['replace_all', 'replace_note', 'replace_first', 'note']) {
    check(!declared.includes(stray), `C "${stray}" 刻意不在声明里`, `declared=${declared.join(',')}`)
  }
}

say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
