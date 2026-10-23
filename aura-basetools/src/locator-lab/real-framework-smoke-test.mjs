/**
 * real-framework-smoke-test —— 用**真框架的真函数**验两个工具的形状契约。
 *
 * ## 它补的是哪一格（这是本套件存在的全部理由）
 *
 * `aura-read/load-test.mjs` 与 `aura-edit/load-test.mjs` 用 mock，测的是**逻辑**（判据、落盘、闸门）。
 * mock 不校验 schema。于是本仓被同一形态咬过三次，每次都是**每一条成功路径被框架拒**而套件全绿：
 *
 *   1. `aura_basetools_read` 输出漏声明 `text`  ⇒ 每次成功读取都被拒；
 *   2. `aura_basetools_edit` 输出带 `dry_run`   ⇒ 每次预演都被拒；
 *   3. `hunks[1].replace_all is not a declared property` ⇒ 参数进不来（0.10.2 起它已是正式声明）。
 *
 * 本套件用 `@deepseek-ai/dsh-tools` 的**真** `assertObjectJsonSchema` / `validateJsonSchemaValue`
 * 与**真** `schemastery`，验三件事：
 *   · 两个描述符被真框架接受（注册期）；
 *   · `execute()` 的真实返回值通过真输出校验（运行期）——含目录读取、预演、建文件；
 *   · 参数面在真 schema 下的判决（**含一个判据对照**，见段C，防“恒真断言”）。
 *
 * ## 为什么能在这里跑（以及跑不了时怎么办）
 *
 * 真框架的两个包是 aura-basetools 的 **peer**，只声明 `"*"`，不随包分发。所以：
 *   · DSH 面 —— 安装器会把它们 junction 进装包目录（`linkHostPeers`），本套件直接解析得到；
 *   · 独立面 —— 解析不到。
 * 解析不到时本套件**自报跳过**并 exit 0，但把“跳过”印得显眼：
 * 一个悄悄跳过的套件等于不存在（本仓已因此漏掉过恒红的断言）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..')

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

// ── 解析真框架：从装包位置（与 DSH 加载插件时的解析路径一致）──────────────
const asUrl = (p) => pathToFileURL(p).href
let dshTools = null
let z = null
let resolvedFrom = null
const candidates = [
  path.join(process.env.USERPROFILE ?? '', '.aura', 'pkg', 'node_modules', 'aura-basetools', 'aura-read', 'index.js'),
  path.join(pkgRoot, 'dist', 'aura-basetools', 'aura-read', 'index.js'),
]
for (const anchor of candidates) {
  if (!fs.existsSync(anchor)) continue
  try {
    const req = createRequire(anchor)
    dshTools = await import(asUrl(req.resolve('@deepseek-ai/dsh-tools')))
    z = (await import(asUrl(req.resolve('@deepseek-ai/schemastery')))).default
    resolvedFrom = anchor
    break
  } catch {
    /* 换下一个候选 */
  }
}
if (dshTools === null || typeof z?.object !== 'function') {
  say('')
  say('⚠️  跳过 real-framework-smoke：解析不到宿主 peer（@deepseek-ai/dsh-tools / schemastery）。')
  say(`    试过：${candidates.filter((c) => fs.existsSync(c)).join('、') || '(都不存在)'}`)
  say('    这**不等于**通过——它只说明本机没有可用的真框架。装一次包即可获得（安装器会自动接 peer）。')
  say('')
  say('--- 0/0 通过（已跳过）---')
  process.exit(0)
}

const { validateJsonSchemaValue, assertObjectJsonSchema } = dshTools
const say2 = (m) => process.stdout.write(`${m}\n`)
say2(`真框架来自：${resolvedFrom}`)
say2('')

/**
 * 真校验器的**返回形状**：`validateJsonSchemaValue(schema, value)` 回的是**违规消息数组**
 * （空 = 通过），不是 `{ok}` 对象。当 `{ok}` 用会让每一条都“失败”——那种假失败同样浪费一轮排查。
 */
const validateShape = (schema, value) => {
  let violations = []
  try {
    const r = validateJsonSchemaValue(schema, value)
    violations = Array.isArray(r) ? r : []
  } catch (error) {
    violations = [String(error.message).split('\n')[0]]
  }
  return violations.length === 0 ? { ok: true } : { ok: false, why: violations.slice(0, 2).join('；') }
}

// ── 真 ctx.fs（node:fs）与注册 ────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'real-smoke-'))
const file = path.join(tmp, 'demo.mjs')
fs.writeFileSync(file, 'export function alpha() {\n  const n = 1\n  return n\n}\n\nexport function beta() {\n  return 2\n}\n')
fs.writeFileSync(path.join(tmp, 'note.zzz'), 'plain text\n')
fs.writeFileSync(path.join(tmp, 'external.txt'), 'original\n')

let version = 1
const fsService = {
  resolve: async (p, opts) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(opts?.cwd ?? tmp, p)
    return { displayPath: abs, targetKey: abs }
  },
  stat: async (t) => {
    if (!fs.existsSync(t.targetKey)) return undefined
    const st = fs.statSync(t.targetKey)
    if (st.isDirectory()) return { type: 'directory', size: 0 }
    return { type: 'file', version: `v${version}`, size: st.size }
  },
  readText: async (t) => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(t.targetKey)),
  readByteRange: async (t, r) => fs.readFileSync(t.targetKey).subarray(r.offset, r.offset + r.length),
  listDir: async (t) =>
    fs.readdirSync(t.targetKey, { withFileTypes: true }).map((e) => {
      const child = path.join(t.targetKey, e.name)
      return {
        name: e.name,
        type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
        size: e.isFile() ? fs.statSync(child).size : undefined,
        target: { displayPath: child, targetKey: child },
      }
    }),
  writeText: async (t, content) => {
    fs.writeFileSync(t.targetKey, content)
    version += 1
    return { version: `v${version}` }
  },
  editText: async () => {
    throw new Error('editText must not be used by the write path')
  },
}
const registered = []
const mkCtx = () => ({
  fs: fsService,
  inject: () => {},
  get: () => undefined,
  on: () => {},
  emit: () => {},
  tools: { register: (t) => registered.push(t), get: () => undefined },
  systemPrompt: { section: () => () => {} },
})
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

say('=== A. 描述符必须被真框架接受 ===')
for (const dir of ['aura-read', 'aura-edit']) {
  const mod = await import(asUrl(path.join(pkgRoot, 'src', dir, 'index.js')))
  mod.apply(mkCtx())
}
const readTool = registered.find((t) => t.name === 'aura_basetools_read')
const editTool = registered.find((t) => t.name === 'aura_basetools_edit')
const writeTool = registered.find((t) => t.name === 'aura_basetools_write')
check(readTool !== undefined && editTool !== undefined && writeTool !== undefined, '三个工具都注册成功（aura_basetools_read / aura_basetools_edit / aura_basetools_write）')
for (const tool of [readTool, editTool, writeTool]) {
  if (tool === undefined) continue
  let why = ''
  let ok = true
  try {
    assertObjectJsonSchema(tool.parameters)
    assertObjectJsonSchema(tool.output.schema)
  } catch (error) {
    ok = false
    why = String(error.message).split('\n')[0]
  }
  check(ok, `${tool.name} 的参数与输出 schema 通过 assertObjectJsonSchema`, why)
  let cfgOk = true
  try {
    const serialized = JSON.parse(JSON.stringify(tool.parameters))
    if (serialized.type !== 'object') throw new Error('parameters 的 type 不是 object')
  } catch (error) {
    cfgOk = false
    why = String(error.message).split('\n')[0]
  }
  check(cfgOk, `${tool.name} 的 parameters 可序列化为 object schema`, why)
}

say('')
say('=== B. execute() 的真实返回值必须通过真输出校验 ===')
const cases = [
  ['aura_basetools_read 读文件（full）', readTool, { file_path: file }],
  ['aura_basetools_read 读目录（仓库地图）', readTool, { file_path: tmp }],
  ['aura_basetools_read 行区间', readTool, { file_path: file, start_line: 2, end_line: 3 }],
  ['aura_basetools_read 按符号', readTool, { file_path: file, around: 'beta' }],
  ['aura_basetools_read 未索引扩展名', readTool, { file_path: path.join(tmp, 'note.zzz') }],
  ['aura_basetools_edit 写入', editTool, { file_path: file, hunks: [{ lines: [3, 3], replace: '  return 111' }] }],
  ['aura_basetools_edit 预演（dry_run）', editTool, { file_path: file, hunks: [{ lines: [3, 3], replace: '  return 222' }], dry_run: true }],
  ['aura_basetools_edit 建文件（create）', editTool, { file_path: path.join(tmp, 'made.txt'), create: 'hello\n' }],
  ['aura_basetools_edit 平铺形状', editTool, { file_path: file, start_line: 3, end_line: 3, replace: '  return 333' }],
  ['aura_basetools_write 新建', writeTool, { file_path: path.join(tmp, 'written.txt'), content: 'written\n' }],
  ['aura_basetools_write 预演', writeTool, { file_path: path.join(tmp, 'written-dry.txt'), content: 'x\n', dry_run: true }],
  ['aura_basetools_write 覆写（已观测）', writeTool, { file_path: path.join(tmp, 'written.txt'), content: 'rewritten\n' }],
  ['aura_basetools_write 盲写（allow_unobserved）', writeTool, { file_path: path.join(tmp, 'external.txt'), content: 'external-new\n', allow_unobserved: true }],
  ['aura_basetools_write eol preserve', writeTool, { file_path: path.join(tmp, 'written.txt'), content: 'exact\n', eol: 'preserve' }],
]
for (const [label, tool, args] of cases) {
  let value = null
  try {
    value = await tool.execute(args, exec)
  } catch (error) {
    // 抛错对某些用例是合法结果；但 B 段这一组**都应当成功**，所以这里算失败并附上原因
    check(false, `${label} → 执行成功`, `${error.code ?? ''} ${String(error.message).split('\n')[0]}`.slice(0, 110))
    continue
  }
  const v = validateShape(tool.output.schema, value)
  check(v.ok, `${label} → 输出通过真校验`, v.ok ? '' : v.why)
}

say('')
say('=== C. 参数面判决（带一个**判据对照**，防恒真断言）===')
// 对照的必要性：只断言“合法形状被接受”时，一个**永远返回空违规**的坏校验器也能全绿。
// 所以先钉住校验器**确实会拒**：把必填字段拿掉必须报 missing required property。
//
// 对照值为什么不再是 `{}`：多目标形状逼着 `file_path` 退出必填名单（宿主把 `required: true`
// 编译成 `required: ['file_path']`，写上它 `{targets:[…]}` 在参数层就被拒），而本框架方言
// **表达不了**“`file_path` 或 `targets` 二选一”——`anyOf`/`allOf` 不在允许关键字子集内，
// 且校验器对 `anyOf` 是**静默忽略**（`{}` 照样通过，所以那会是一条没有效果的声明）；
// 能与根上 `type: 'object'` 共存的 `oneOf` 不存在（实测读数记在 `aura-read/index.js`）。
// 于是 `{}` 这一份改由**工具自己**拒（段D 端到端锤着），而“校验器确实在判”改用
// **类型违规**对照：它同样必须报违规，且不可能被一个恒真校验器伪造。
const typeViolation = validateShape(readTool.parameters, { file_path: 42 })
check(!typeViolation.ok, '判据对照：类型不合法的实参被真校验器拒（证明校验器**确实在判**）', typeViolation.why ?? '')

const READ_SHAPES = [
  { file_path: 'x.js' },
  { file_path: 'x.js', mode: 'auto' },
  { file_path: 'x.js', start_line: 1, end_line: 2 },
  { file_path: 'x.js', lines: '1,2' },
  { file_path: 'x.js', lines: [1, 2] },
  { file_path: 'x.js', lines: 3 },
  { file_path: 'x.js', around: 'alpha' },
  { file_path: 'x.js', search: 'needle' },
  { file_path: 'x.js', since: 'v1' },
]
const EDIT_SHAPES = [
  { file_path: 'x.js', hunks: [{ lines: [1, 1], replace: 'y' }] },
  { file_path: 'x.js', hunks: [{ target: 'a', expect: 'b', replace: 'c', near: 3 }] },
  { file_path: 'x.js', hunks: [{ anchor: 'a\nb', replace: '' }] },
  { file_path: 'x.js', hunks: [], create: 'text' },
  { file_path: 'x.js', create: 'text' },
  { file_path: 'x.js', hunks: [{ lines: [1, 1], replace: 'y' }], dry_run: true },
  { file_path: 'x.js', start_line: 1, end_line: 1, replace: 'y' },
  { file_path: 'x.js', lines: 3, replace: 'y' },
  { file_path: 'x.js', line_cue: 'uniq', replace: 'y' },
]
const WRITE_SHAPES = [
  { file_path: 'x.js', content: 'y' },
  { file_path: 'x.js', content: '', dry_run: true },
  { file_path: 'x.js', content: 'y', eol: 'preserve', no_overwrite: true },
  { file_path: 'x.js', content: 'y', allow_unobserved: true },
]
for (const [tool, shapes] of [
  [readTool, READ_SHAPES],
  [editTool, EDIT_SHAPES],
  [writeTool, WRITE_SHAPES],
]) {
  const bad = shapes.filter((s) => !validateShape(tool.parameters, s).ok)
  check(bad.length === 0, `${tool.name}：真 schema 接受全部 ${shapes.length} 种合法调用形状`, bad.map((s) => JSON.stringify(s)).join(' | '))
}

say('')
say('=== D. 二选一闸门：参数面放行的那两种非法形状，工具必须真拒 ===')
/**
 * 为什么阵地在这里而不是 schema 里：见段C 的注释（方言表达不了“二选一”）。
 * 但**拒**这件事必须是真的，两个方向都要拒：
 *   · 两个都给 ⇒ 唯一判据（`assertReadTargets` / `assertEditTargets` 的 `ARGS_SHAPE_EXCLUSIVE`）；
 *   · 两个都没给 ⇒ 无形状可用。
 * 断言的是“抛没抛 + 抛的是不是那一类”，不是某个错字。
 */
const TWO_WAY_CASES = [
  ['aura_basetools_read', readTool, {}, undefined],
  ['aura_basetools_read', readTool, { file_path: file, targets: [{ file_path: file, mode: 'full' }] }, 'ARGS_SHAPE_EXCLUSIVE'],
  ['aura_basetools_edit', editTool, {}, undefined],
  [
    'aura_basetools_edit',
    editTool,
    { file_path: file, targets: [{ file_path: file, hunks: [{ lines: [3, 3], replace: 'x' }] }] },
    'ARGS_SHAPE_EXCLUSIVE',
  ],
]
for (const [toolName, tool, args, wantCode] of TWO_WAY_CASES) {
  const what = args.targets === undefined ? '两个都没给' : '两个都给'
  let rejected = false
  let why = ''
  try {
    await tool.execute(args, exec)
  } catch (error) {
    rejected = true
    why = `${error.code ?? ''} ${String(error.message).split('\n')[0]}`.trim()
    if (wantCode !== undefined && error.code !== wantCode) {
      check(false, `${toolName}：${what} ⇒ 判据码必须是 ${wantCode}`, why.slice(0, 110))
      continue
    }
  }
  check(rejected, `${toolName}：${what} ⇒ 必须被拒${wantCode === undefined ? '' : `（${wantCode}）`}`, why.slice(0, 110))
}

fs.rmSync(tmp, { recursive: true, force: true })
say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
