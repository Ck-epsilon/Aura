/**
 * load-test —— 不启动 DSH，用最小 mock 上下文把插件当作加载器会做的那样跑一遍。
 *
 * 目的：在改动用户的预设之前，先证明三件事
 *   1. 模块能被 import（依赖解析、ESM 形状、导出齐全）；
 *   2. `apply(ctx)` 真的向 ctx.tools 注册了名为 patch 的工具；
 *   3. 注册后的工具能被真正执行，且 fs 事件契约（edit-intent / observed / editText）按预期被调用。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 定位引擎住在 lab 层（框架无关），DSH 侧只剩编排——测试按这个分层取用。
// 引擎层的歧义语义用 locateWith 直接验（它会抛错）；locate() 是包装，把错误变成结构化返回值。
import { lastLegacyTools, planHunks } from './index.js'
import { indexFile, locateWith } from '../locator-lab/anchor-core.mjs'
// 引擎的定位 API 本身也要断言：expect 的放松（C1）落在这一层，与 hunk 端到端**不是**同一道闸。
import { locate } from '../locator-lab/locator-api.mjs'
import { contextServices } from '../locator-lab/mock-ctx.mjs'

const plugin = await import('./index.js')

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

console.log('=== 1. 模块形状（加载器要求 name / apply，注入声明 fs） ===')
check(plugin.name === 'dsh-tool-aura-edit', `name = ${JSON.stringify(plugin.name)}`)
check(typeof plugin.apply === 'function', 'apply 是函数')
check(Array.isArray(plugin.inject) && plugin.inject.includes('fs'), `inject = ${JSON.stringify(plugin.inject)}`)

console.log('')
console.log('=== 2. 注册：用 mock ctx 跑 apply ===')
let registered = null
let writeTool = null
let applyTool = null
const registeredNames = []
const events = []
/** 收集提示段。systemPrompt 必须提供，否则注册指导那段代码根本不会执行。 */
const sections = []
const mockCtx = {
  // 与真实 Cordis 上下文同形（inject / get 都必须在场）——理由见 mock-ctx.mjs 的注释。
  ...contextServices(),  tools: { register: (t) => {
    registered = t
    if (t?.name === 'aura_basetools_apply') applyTool = t
    if (t?.name !== undefined) registeredNames.push(t.name)
  } },
  systemPrompt: { section: () => () => {} },
  emit: (...a) => events.push(a[0]),  waterfall: async (name) => {
    events.push(name)
    throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
  },
}
plugin.apply(mockCtx)
check(registered !== null, 'apply 调用了 ctx.tools.register')
check(registered?.name === 'aura_basetools_apply', `公开注册的工具名 = ${JSON.stringify(registered?.name)}`)
// 旧 write/convert/edit 不再注册；测试从 lastLegacyTools 取它们的定义，继续跑同一批断言。
check(
  lastLegacyTools?.edit?.name === 'aura_basetools_edit' && lastLegacyTools?.write?.name === 'aura_basetools_write',
  `旧工具仍可取用（${lastLegacyTools?.edit?.name} / ${lastLegacyTools?.write?.name}）`,
)
registered = lastLegacyTools.edit
writeTool = lastLegacyTools.write
// 本插件只注册 apply（read 在 aura-read 插件里，合计两个 DSH 工具）。
check(
  [...new Set(registeredNames)].sort().join(',') === 'aura_basetools_apply',
  `本插件注册 ${new Set(registeredNames).size} 个工具 = ${[...new Set(registeredNames)].sort().join(', ')}`,
)
// defineTool 会把参数 DSL 编译成 JSON Schema：顶层是 {type, properties, required}
const compiled = registered?.parameters ?? {}
const paramKeys = Object.keys(compiled.properties ?? {})
check(compiled.type === 'object', `编译后的参数是 object schema`)
/**
 * 顶层参数表：四个工具级参数 + **一个 hunk 的十一个键**。
 *
 * 其中 `old` / `context` 是 fs-contract-v2 / C2 补上的**内容地址**：地址由原文本身给出，
 * 坐标降为提示。声明面与未知参数守卫（`EDIT_ARG_KEYS`）读的是同一份表，两者必须同时在。
 *
 * 后面那九个是 2026-09-29 补上的：`flatHunk()` 从 02:37 起就支持“一个 hunk 不包数组、直接写在顶层”，
 * 而顶层 schema 一直没声明它们——属于**实装先于声明**，而后果是双重的：
 *   · 真框架的参数校验对未声明键零违规（`additionalProperties` 当时是 undefined）⇒ 没有任何东西拦住它们；
 *   · 与新增的未知参数守卫的名单对不上 ⇒ 守卫会把模型真在用的平铺形状拒掉。
 * 实测依据：会话日志里 35 次平铺调用，**支持实装之后的那几次是成功的**（
 * `{start_line, end_line, replace, expect}` → `1 hunk(s) applied`），说明框架不剥未声明参数、平铺真能用。
 */
check(
  paramKeys.join(',') ===
    'file_path,targets,hunks,target,lines,start_line,end_line,line_cue,anchor,old,context,replace,replace_all,eol,expect,near,handle,structure,line,position,dry_run,require_observation,retry,create',
  `参数 = ${paramKeys.join(',')}`,
)
// `hunks` 不再无条件必填：创建路径用 `create`，此时 hunks 可有可无。
// 断言跟着真实契约走——写死旧契约会让测试在**正确的**改动后失败，
// 而那种失败最容易被顺手改掉，从而把契约漂移掩盖过去。
//
// fs-contract-v2 / MT4：`file_path` 也不再声明必填，顶层必填集从 `["file_path"]` 变成 `[]`。
// 这是**多目标形状逼出来的唯一一处声明面改动**：宿主把 `required: true` 编译成参数面的
// `required: ['file_path']`，于是 `{targets:[…]}` 会在参数层就被拒、根本到不了 execute；
// 而 schema 层表达不了“二选一”（同 hunks/create）。“单目标必须有 file_path”改由运行期判：
// execute 第一条仍是原来那句 `file_path must be a non-empty string`（单目标调用因此完全相同）。
check(
  compiled.required === undefined,
  `顶层必填 = ${JSON.stringify(compiled.required)}`,
)
const hunkKeys = Object.keys(compiled.properties?.hunks?.items?.properties ?? {})
// start_line/end_line 是后加的：hunk 里也能用两个整数表达区间，不必写 `lines: [a, b]`。
/**
 * 0.14.0 移除了 `intent` 模糊地址；`target` 之后直接是 `lines`。
 * 顺序就是 `HUNK_PROPERTIES` 的顺序（声明面与守卫同源）。
 */
check(
  hunkKeys.join(',') === 'target,lines,start_line,end_line,line_cue,anchor,old,context,replace,replace_all,eol,expect,near,handle,structure,line,position',
  `hunk 字段 = ${hunkKeys.join(',')}`,
)
check(
  JSON.stringify(compiled.properties?.hunks?.items?.required ?? []) === '["replace"]',
  `hunk 必填 = ${JSON.stringify(compiled.properties?.hunks?.items?.required)}`,
)
const toolFromMockPhase = registered

console.log('')
console.log('=== 3. 端到端：在临时文件上真的执行一次 patch ===')
const tmp = path.join(os.tmpdir(), `patch-loadtest-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const target = path.join(tmp, 'sample.js')
const ORIGINAL = [
  'function allocate(items) {',
  '  const total = items.length;',
  '  const width = 12;',
  '  return { total, width };',
  '}',
  '',
  'function render(row) {',
  '  const width = 12;',
  '  return row.padEnd(width);',
  '}',
  '',
].join('\n')
fs.writeFileSync(target, ORIGINAL, 'utf8')

let version = 1
const fsService = {
  resolve: async (p) => ({ displayPath: p, targetKey: p }),
  stat: async (t) => {
    const p = t.targetKey
    if (!fs.existsSync(p)) return undefined
    return { version: `v${version}`, type: 'file', size: fs.statSync(p).size }
  },
  // 必须按 targetKey 读：早先这里硬编码成第一个样本文件，导致后续用例全在读别人的内容
  readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
  // 字节回读（aura_basetools_write 的 verifyWriteBack 会走它）：与真提供方同形，按区间返回 Buffer。
  readByteRange: async (t, r) => fs.readFileSync(t.targetKey).subarray(r.offset ?? 0, (r.offset ?? 0) + (r.length ?? 0)),
  readBytes: async (t) => fs.readFileSync(t.targetKey),
  editText: async (t, req) => {
    const p = t.targetKey
    const current = fs.readFileSync(p, 'utf8')
    const n = current.split(req.oldString).length - 1
    if (n === 0) throw Object.assign(new Error('old_string was not found'), { code: 'FS_EDIT_NOT_FOUND' })
    if (n > 1) throw Object.assign(new Error(`old_string matched ${n} times`), { code: 'FS_AMBIGUOUS_EDIT' })
    const next = current.split(req.oldString).join(req.newString)
    fs.writeFileSync(p, next, 'utf8')
    version += 1
    return { version: `v${version}`, operation: 'update', before: current, after: next }
  },
  /**
   * 与真提供方同形（dsh-fs-local `:821-839`）：整份逐字节写；`replaceIfVersion` 在临界区里
   * 比对版本，不符抛 `FS_STALE_VERSION`。mock 必须**同形**——缺一个成员就是缺一条被测路径
   * （见 locator-lab/mock-ctx.mjs 的教训）。
   */
  writeText: async (t, content, expected) => {
    const p = t.targetKey
    const existed = fs.existsSync(p)
    if (expected?.kind === 'replaceIfVersion') {
      if (!existed) throw Object.assign(new Error('file no longer exists'), { code: 'FS_STALE_VERSION' })
      if (`v${version}` !== expected.version) throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
    } else if (expected?.kind === 'createIfAbsent' && existed) {
      throw Object.assign(new Error('cannot overwrite existing file without reading it first'), { code: 'FS_NOT_OBSERVED' })
    }
    fs.writeFileSync(p, content, 'utf8')
    version += 1
    return { version: `v${version}`, operation: existed ? 'update' : 'create', after: content }
  },
}
const liveCtx = {
  fs: fsService,
  // 与真实 Cordis 上下文同形（inject / get 都必须在场）——理由见 mock-ctx.mjs 的注释。
  ...contextServices(),  tools: {
    register: (t) => {
      if (t?.name === 'aura_basetools_write') writeTool = t
      if (t?.name === 'aura_basetools_apply') applyTool = t
      // 保持 `registered` = 最后一个注册的工具（aura_basetools_edit）：既有断言与执行入口都读它。
      registered = t
    },
  },
  emit: () => {},
  systemPrompt: { section: (x) => { sections.push(x); return () => {} } },
  // 策略在场但拒绝：验证"策略失败不阻断、由锚点自己把关"的设计
  waterfall: async () => {
    throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
  },
}
// 关键：重新跑一次 apply，让工具闭包里的 ctx 是带 fs 的那个。
// （真实运行时每进程只 apply 一次；这里重跑只为在同一进程里测两个 ctx。）
plugin.apply(liveCtx)
check(registered !== null, '第二次 apply 重新注册（闭包指向带 fs 的 ctx）')
registered = lastLegacyTools.edit
writeTool = lastLegacyTools.write
check(registered?.name === 'aura_basetools_edit' && writeTool?.name === 'aura_basetools_write', `旧工具定义仍可取用（${registered?.name} / ${writeTool?.name}）`)

const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
// 故意注入漂移：缩进少 2 格 + 行尾空格 + 改了一个词（真实模型最常见的三种手误）
const drifted = 'const total = items.length;  \nconst width = 13;\nreturn { total, width };'
const out = await registered.execute(
  {
    file_path: target,
    hunks: [{ anchor: drifted, replace: 'const total = items.length;\nconst width = 16;\nreturn { total, width };' }],
  },
  exec,
)
const after = fs.readFileSync(target, 'utf8')
check(out.applied.length === 1, `返回 1 条回执`)
check(out.applied[0].tier !== 'exact', `降级命中，层级 = ${out.applied[0].tier}`)
check(after.includes('const width = 16'), '替换真的落盘了')
check(after.includes('return { total, width };'), '锚点覆盖的行保留完整')
check(!after.includes('width = 13'), '旧的错误内容已消失')
check(
  out.applied[0].actual.includes('const width = 12;'),
  '回执带回了实际命中的原文（模型可核对）',
)
check(fs.readFileSync(target, 'utf8').split('\n').length === ORIGINAL.split('\n').length, '行数不变')

console.log('')
console.log('=== 4. 事务性：一个 hunk 失败，磁盘必须不变 ===')
const beforeFail = fs.readFileSync(target, 'utf8')
let threw = null
let aborted = null
try {
  aborted = await registered.execute(
    {
      file_path: target,
      hunks: [
        { anchor: 'function render(row) {', replace: 'function renderRow(row) {' },
        { anchor: '这段内容绝对不存在ZZZ', replace: 'x' },
      ],
    },
    exec,
  )
} catch (e) {
  threw = e
}
// 旧契约断言的是"整体中止 ⇒ 抛异常"。同一个判决现在走**结果通道**
// （fs-contract-v2 / C3）：判定不出意图的那一类失败回一条正常结果，
// `outcome` 说清是哪一种。所以断言从"抛错"改成"回执里读得出来"，
// 但一条也不能少：outcome / code / applied 空 / 磁盘一字未落 / 恢复指令。
check(threw === null && aborted !== null, '整体中止不再抛错（判定不出意图 ⇒ 结果通道）', `threw=${threw?.code}`)
check(aborted?.outcome === 'not_found', `回执 outcome = ${aborted?.outcome}（要改的原文不在文件里）`)
check(aborted?.code === 'PATCH_NOT_FOUND', `回执带上引擎的码 = ${aborted?.code}`)
check(Array.isArray(aborted?.applied) && aborted.applied.length === 0, 'applied 为空数组（结构上可读：一个 hunk 都没落盘）')
check(typeof aborted?.next === 'string' && aborted.next.length > 0, '回执给出下一步 next（不是只报一句"错了"）', String(aborted?.next).slice(0, 60))
check(fs.readFileSync(target, 'utf8') === beforeFail, '磁盘内容未变（第一个 hunk 没有偷偷落盘）')

console.log('')
console.log('=== 5. dry_run 不写盘 ===')
const beforeDry = fs.readFileSync(target, 'utf8')
const dry = await registered.execute(
  { file_path: target, hunks: [{ anchor: 'function render(row) {', replace: 'function renderRow(row) {' }], dry_run: true },
  exec,
)
check(dry.dryRun === true, 'dryRun 标记为 true')
check(fs.readFileSync(target, 'utf8') === beforeDry, '磁盘未变')

// 0.10.5：create + dry_run 也不能建文件；require_observation 在 DSH 面同样生效
const createDryPath = path.join(tmp, 'create-dry.mjs')
const createDry = await registered.execute(
  { file_path: createDryPath, create: 'export const x = 1\n', dry_run: true },
  exec,
)
check(createDry.dryRun === true && !fs.existsSync(createDryPath), 'create + dry_run：回执是预演，文件不存在', JSON.stringify(createDry).slice(0, 160))

const strictPath = path.join(tmp, 'strict.mjs')
fs.writeFileSync(strictPath, 'export const x = 1\n', 'utf8')
let strictErr = null
try {
  await registered.execute(
    { file_path: strictPath, hunks: [{ lines: [1, 1], replace: 'export const x = 2' }], require_observation: true },
    exec,
  )
} catch (error) {
  strictErr = error
}
check(strictErr?.code === 'PATCH_UNOBSERVED', `未读 + require_observation ⇒ PATCH_UNOBSERVED（${strictErr?.code}）`)
check(fs.readFileSync(strictPath, 'utf8') === 'export const x = 1\n', '严格新鲜度拒绝时磁盘未变')

console.log('')
console.log('=== 5b. aura_basetools_write：整份新建/覆写 ===')
{
  check(writeTool !== null, 'aura_basetools_write 已注册')
  const writeTarget = path.join(tmp, 'write-load.txt')
  const created = await writeTool.execute({ file_path: writeTarget, content: 'one\ntwo\n' }, exec)
  check(created.operation === 'create' && created.dryRun === false, `新建回执 operation=create（${created.operation}）`)
  check(fs.readFileSync(writeTarget, 'utf8') === 'one\ntwo\n', '新建内容逐字落盘')

  const dryTarget = path.join(tmp, 'write-dry.txt')
  const dryNew = await writeTool.execute({ file_path: dryTarget, content: 'x\n', dry_run: true }, exec)
  check(dryNew.operation === 'create' && dryNew.dryRun === true, '新建预演回执 dryRun=true')
  check(!fs.existsSync(dryTarget), '新建预演没有建文件')

  const external = path.join(tmp, 'write-external.txt')
  fs.writeFileSync(external, 'external\n', 'utf8')
  let strictErr = null
  try {
    await writeTool.execute({ file_path: external, content: 'blind\n' }, exec)
  } catch (error) {
    strictErr = error
  }
  check(strictErr?.code === 'PATCH_UNOBSERVED', `未读覆写默认拒绝（${strictErr?.code}）`)
  check(fs.readFileSync(external, 'utf8') === 'external\n', '严格拒绝时磁盘未变')

  const blind = await writeTool.execute({ file_path: external, content: 'blind\n', allow_unobserved: true }, exec)
  check(blind.operation === 'write' && blind.unverified_region === true, 'allow_unobserved 覆写并标 unverified_region')
  check(fs.readFileSync(external, 'utf8') === 'blind\n', '盲写内容落盘')

  // writeTarget 由 aura_basetools_write 自己创建 ⇒ 引擎已记观测，随后严格覆写可直接过。
  const preserved = await writeTool.execute({ file_path: writeTarget, content: 'a\nb\n', eol: 'preserve' }, exec)
  check(preserved.operation === 'write' && fs.readFileSync(writeTarget, 'utf8') === 'a\nb\n', 'eol=preserve 按 content 原样写')

  let existsErr = null
  try {
    await writeTool.execute({ file_path: writeTarget, content: 'nope\n', no_overwrite: true }, exec)
  } catch (error) {
    existsErr = error
  }
  check(existsErr?.code === 'WRITE_EXISTS', `no_overwrite 对已存在文件拒绝（${existsErr?.code}）`)
  check(fs.readFileSync(writeTarget, 'utf8') === 'a\nb\n', 'no_overwrite 拒绝时磁盘未变')

  let unknownErr = null
  try {
    await writeTool.execute({ file_path: writeTarget, content: 'x', dryrun: true }, exec)
  } catch (error) {
    unknownErr = error
  }
  check(unknownErr?.code === 'ARGS_UNKNOWN_KEY', `拼错的 dryrun 被未知参数守卫拒绝（${unknownErr?.code}）`)
}

console.log('')
console.log('=== 6. 歧义必须被拒绝，而不是猜 ===')
const dup = ['function f() {', '  return 1;', '}', '', 'function g() {', '  return 1;', '}', ''].join('\n')
let amb = null
try {
  locateWith(indexFile(dup), '  return 1;')
} catch (e) {
  amb = e
}
check(amb?.code === 'PATCH_AMBIGUOUS', `重复锚点被拒：${amb?.code}`)
check(JSON.stringify(amb?.candidates) === '[2,6]', `候选行号 = ${JSON.stringify(amb?.candidates)}`)
const nearHit = locateWith(indexFile(dup), '  return 1;', 6)
check(nearHit.line === 6 && nearHit.byNear === true, `near=6 收敛到 line ${nearHit.line}`)
/**
 * 上面那条测的是 `locateWith` 的**直达 API**——它一直能拿到 `byNear`。
 * 真正会断的是**经由 `locate()` 的那条路**：`locate()` 的 `done()` 曾经只回
 * `{startLine, endLine, tier, actual}`，把引擎算好的 `byNear` 丢在中间，
 * 而 `planHunks`（write-path:179）与工具回执都在读它。
 * 后果：回执里渲染的 `by near` **永远不出现**，降级命中对模型不可见。
 * 所以必须走 `planHunks` 再断言一次——只测直连 API 会漏掉整条工具链。
 */
{
  const planned = planHunks(dup, [{ anchor: '  return 1;', near: 6, replace: '  return 42;' }], 'x.mjs')
  check(planned.applied[0].byNear === true, 'byNear 穿过 locate() 抵达 planHunks（回执靠它渲染 `by near`）')
  // 反向：没有 `near` 时歧义必须被拒，绝不能猜——
  // 否则上面那条 `byNear === true` 可能只是"总是真"。
  let rejected = null
  try {
    planHunks(dup, [{ anchor: '  return 1;', replace: '  return 42;' }], 'x.mjs')
  } catch (e) {
    rejected = e
  }
  check(rejected?.code === 'PATCH_AMBIGUOUS', `无 near 时仍拒歧义：${rejected?.code}`)
  // 而唯一命中时不该被标成 byNear（那会让"靠提示命中"这个信号失去意义）
  const unique = planHunks('function f() {\n  return 1;\n}\n', [{ anchor: '  return 1;', replace: '  return 9;' }], 'x.mjs')
  check(unique.applied[0].byNear === false, '唯一命中时 byNear 不为真')
}

console.log('')
console.log('=== 7. 符号定位（target）：跳过全部文本匹配 ===')
const symTarget = path.join(tmp, 'symbolic.js')
const SYM_SRC = [
  'function alpha() {',
  '  const a = 1;',
  '  return a;',
  '}',
  '',
  'function beta() {',
  '  const b = 2;',
  '  return b;',
  '}',
  '',
].join('\n')
fs.writeFileSync(symTarget, SYM_SRC, 'utf8')
const symOut = await registered.execute(
  { file_path: symTarget, hunks: [{ target: 'function:beta', replace: 'function beta() {\n  const b = 42;\n  return b;\n}' }] },
  exec,
)
const symAfter = fs.readFileSync(symTarget, 'utf8')
check(symOut.applied[0].tier === 'symbol', `命中层级 = ${symOut.applied[0].tier}`)
check(symOut.applied[0].line === 6, `落在第 ${symOut.applied[0].line} 行（期望 6，即 beta 起始行）`)
check(symAfter.includes('const b = 42;'), '符号区域内被正确替换')
check(symAfter.includes('const a = 1;'), '另一个函数未被触碰')
check(symAfter.split('\n').length === SYM_SRC.split('\n').length, '行数不变')

console.log('')
console.log('=== 8. 锚点失败时返回符号目录（恢复路径）===')
fs.writeFileSync(symTarget, SYM_SRC, 'utf8')
let hintErr = null
let hint = null
try {
  hint = await registered.execute(
    { file_path: symTarget, hunks: [{ anchor: '这段内容根本不存在ZZZ\n也不存在YYY', replace: 'x' }] },
    exec,
  )
} catch (e) {
  hintErr = e
}
// 恢复路径的**载体**换了：以前搭在 `error.message` 上，现在搭在失败回执的 `message` 上。
// 换载体的理由就是这条断言存在的理由：框架只读 `error.message`，而回执正文是模型真看得见的那段。
check(hintErr === null && hint !== null, '失败不再抛出（走结果通道）', `threw=${hintErr?.code}`)
check(hint?.outcome === 'not_found' && hint?.code === 'PATCH_NOT_FOUND', `回执 outcome=${hint?.outcome} code=${hint?.code}`)
check(Array.isArray(hint?.applied) && hint.applied.length === 0, 'applied 为空数组（磁盘一字未动）')
check(fs.readFileSync(symTarget, 'utf8') === SYM_SRC, '被拦下时磁盘未变')
check(
  typeof hint?.message === 'string' && hint.message.includes('structural directory'),
  '回执正文包含结构目录',
)
check(typeof hint?.message === 'string' && hint.message.includes('beta'), '目录里列出了可用的符号名（beta）')
check(typeof hint?.message === 'string' && hint.message.includes('target='), '目录里给出了可执行的恢复指令（改用 target=）')

fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
console.log('=== 9. 四层寻址在工具层都可用 ===')
const addrTmp = path.join(os.tmpdir(), `patch-addr-${Date.now()}`)
fs.mkdirSync(addrTmp, { recursive: true })
const addrTarget = path.join(addrTmp, 'addr.js')
const ADDR_SRC = [
  'export function alpha(input) {',
  '  const first = compute(input);',
  '  if (first > 0) {',
  '    return first * 2;',
  '  }',
  '  return 0;',
  '}',
  '',
].join('\n')

// 第 2 层：行号（if 块内部，符号层够不到）
fs.writeFileSync(addrTarget, ADDR_SRC, 'utf8')
const byLines = await registered.execute(
  { file_path: addrTarget, hunks: [{ lines: [4], expect: 'return first * 2;', replace: '    return first * 3;' }] },
  exec,
)
check(byLines.applied[0].tier === 'lines', `按行号命中：tier=${byLines.applied[0].tier} line=${byLines.applied[0].line}`)
check(fs.readFileSync(addrTarget, 'utf8').includes('return first * 3;'), '行号层落盘正确')

// 第 3 层：词线索
fs.writeFileSync(addrTarget, ADDR_SRC, 'utf8')
const byCue = await registered.execute(
  { file_path: addrTarget, hunks: [{ line_cue: 'compute(input)', replace: '  const first = compute(input) ?? 0;' }] },
  exec,
)
check(byCue.applied[0].tier === 'lineCue', `按词线索命中：tier=${byCue.applied[0].tier}`)
check(fs.readFileSync(addrTarget, 'utf8').includes('?? 0'), '词线索层落盘正确')

// 第 4 层：锚点（原有能力不能退化）
fs.writeFileSync(addrTarget, ADDR_SRC, 'utf8')
const byAnchor = await registered.execute(
  { file_path: addrTarget, hunks: [{ anchor: '  return 0;\n}', replace: '  return -1;\n}' }] },
  exec,
)
check(byAnchor.applied[0].tier === 'exact', `按锚点命中：tier=${byAnchor.applied[0].tier}`)

// expect 在行号层也必须拦得住"指错行"（C1 之后判的是"区间含不含这段、全文唯不唯一"）
fs.writeFileSync(addrTarget, ADDR_SRC, 'utf8')
let wrongLineThrew = null
let wrongLine = null
try {
  wrongLine = await registered.execute(
    { file_path: addrTarget, hunks: [{ lines: [6], expect: 'return first * 2;', replace: 'x' }] },
    exec,
  )
} catch (e) {
  wrongLineThrew = e
}
// 引文（17 字符）在全文唯一，却在第 4 行而不在第 6 行 ⇒ 受寻址区间不含它 ⇒ not_found。
check(wrongLineThrew === null, '指错行不再抛错（结果通道）', `threw=${wrongLineThrew?.code}`)
check(
  wrongLine?.outcome === 'not_found' && wrongLine?.code === 'LOCATOR_ASSERT_MISMATCH',
  `指错行被 expect 拦下：outcome=${wrongLine?.outcome} code=${wrongLine?.code}`,
)
check(Array.isArray(wrongLine?.applied) && wrongLine.applied.length === 0, '拦下时 applied 为空数组')
check(
  typeof wrongLine?.message === 'string' && wrongLine.message.includes('line 4'),
  '回执点名引文真正所在的那一行（第 4 行），模型能据此改地址',
  String(wrongLine?.message).slice(-70),
)
check(fs.readFileSync(addrTarget, 'utf8') === ADDR_SRC, '被拦下时磁盘未变')

// C1 的放松面：判据从"整段相等"改成"被受寻址区间包含 + 这段文字在全文件唯一"。
// 两层都要断言，而且**必须同判**：判据只有一份（`expectVerdict`，引擎与 hunk 端到端共用），
// 所以同一组输入在 `locate()` 与工具路径上不能给出两种结论——write-path 曾经自己写了一遍
// `normSpace(actual) !== normSpace(expect)`，同一个 expect 在两条路径上判出两种结果（C1 的
// 回执把它记成偏离项 6，C10 把那份重复判据收拢回引擎）。下面两条各钉一层，第二条还钉住
// "两层同判"这件事本身。
fs.writeFileSync(addrTarget, ADDR_SRC, 'utf8')
const relaxedWide = locate(ADDR_SRC, { lines: { start: 2, end: 4 }, assert: 'const first = compute(input);', filePath: 'addr.js' })
check(
  relaxedWide.ok === true && relaxedWide.tier === 'lines',
  '引擎层 locate()：区间含引文且引文全文唯一 ⇒ 通过（改前会被整段相等拒掉）',
  relaxedWide.ok ? `lines=${relaxedWide.startLine}-${relaxedWide.endLine}` : `${relaxedWide.code}: ${relaxedWide.message}`,
)
const wideHunk = await registered.execute(
  { file_path: addrTarget, hunks: [{ lines: [2, 4], expect: 'const first = compute(input);', replace: '  const first = compute(input) ?? 0;' }] },
  exec,
)
check(
  wideHunk.outcome === 'applied' && wideHunk.applied[0]?.tier === 'lines',
  `工具层 hunk：同一输入与引擎同判（两层共用一份判据）⇒ outcome=${wideHunk.outcome}`,
  wideHunk.outcome === 'applied' ? '' : `${wideHunk.code}: ${String(wideHunk.message).slice(0, 60)}`,
)
check(fs.readFileSync(addrTarget, 'utf8').includes('?? 0'), '被放宽的那一例真的落盘（不是只回了个 applied）')
fs.rmSync(addrTmp, { recursive: true, force: true })

console.log('')
console.log('=== 10. aura_basetools_apply：实体地址的一步写入 ===')
{
  check(applyTool !== null && applyTool?.name === 'aura_basetools_apply', 'aura_basetools_apply 已注册')
  const applyTmp = path.join(os.tmpdir(), `apply-load-${Date.now()}`)
  fs.mkdirSync(applyTmp, { recursive: true })
  const applyTarget = path.join(applyTmp, 'entity.js')
  const APPLY_SRC = [
    'export function alpha() {',
    '  return 1',
    '}',
    '',
    'export function beta() {',
    '  return 2',
    '}',
    '',
    'export const value = beta()',
    '',
  ].join('\n')
  fs.writeFileSync(applyTarget, APPLY_SRC, 'utf8')

  // 预演：拿证据、不动盘。
  const preview = await applyTool.execute(
    {
      file_path: applyTarget,
      entity: 'function:beta',
      op: 'replace-body',
      change: 'export function beta() {\n  return 20\n}',
      dry_run: true,
    },
    exec,
  )
  check(preview.outcome === 'applied' && preview.dryRun === true, `预演 outcome=${preview.outcome} dryRun=${preview.dryRun}`)
  check(preview.entity?.name === 'beta' && typeof preview.evidence?.spanHash === 'string', '回执带 entity 与 evidence（spanHash）')
  check(preview.auto_observed === true, '回执标 auto_observed（apply 自己建立观测）')
  check(fs.readFileSync(applyTarget, 'utf8') === APPLY_SRC, '预演不写盘')

  // 真写：带上一轮的 evidence。
  const landed = await applyTool.execute(
    {
      file_path: applyTarget,
      entity: 'function:beta',
      op: 'replace-body',
      change: 'export function beta() {\n  return 20\n}',
      evidence: preview.evidence,
    },
    exec,
  )
  const afterApply = fs.readFileSync(applyTarget, 'utf8')
  check(landed.outcome === 'applied' && landed.ok === true, `真写 outcome=${landed.outcome}`)
  check(afterApply.includes('return 20') && afterApply.includes('return 1'), '只有 beta 的正文被替换')
  check(landed.evidence?.version !== undefined, '回执 evidence 带观测版本')

  // 证据过期：实体在证据之后被改过 ⇒ PATCH_ENTITY_STALE，零写入。
  const staleEvidence = (
    await applyTool.execute(
      { file_path: applyTarget, entity: 'function:alpha', op: 'replace-body', change: 'export function alpha() {\n  return 1\n}', dry_run: true },
      exec,
    )
  ).evidence
  fs.writeFileSync(applyTarget, fs.readFileSync(applyTarget, 'utf8').replace('return 1', 'return 100'), 'utf8')
  const staleSource = fs.readFileSync(applyTarget, 'utf8')
  const stale = await applyTool.execute(
    { file_path: applyTarget, entity: 'function:alpha', op: 'replace-body', change: 'export function alpha() {\n  return 7\n}', evidence: staleEvidence },
    exec,
  )
  check(stale.code === 'PATCH_ENTITY_STALE' && stale.ok === false, `证据过期 ⇒ ${stale.code}`)
  check(stale.error === 'entity changed since evidence; re-read it', '拒绝正文点名了原因')
  check(Array.isArray(stale.applied) && stale.applied.length === 0, 'applied 为空数组')
  check(fs.readFileSync(applyTarget, 'utf8') === staleSource, '证据过期时零写入')

  // 重命名：只换 ident 词元，调用点一起换。
  const renamed = await applyTool.execute(
    { file_path: applyTarget, entity: 'function:beta', op: 'rename', new_name: 'gamma', scope: 'file' },
    exec,
  )
  const afterRename = fs.readFileSync(applyTarget, 'utf8')
  check(renamed.outcome === 'applied', `重命名 outcome=${renamed.outcome}`)
  check(afterRename.includes('function gamma()') && afterRename.includes('gamma()'), '声明与调用点都被改名')
  check(!afterRename.includes('beta'), '旧名字已消失')

  // 参数面：verify/transaction 本面没有，必须**明确拒绝**而不是静默忽略；拼错的键被守卫拒。
  let verifyErr = null
  try {
    await applyTool.execute({ file_path: applyTarget, entity: 'function:gamma', op: 'rename', new_name: 'delta', verify: 'true' }, exec)
  } catch (error) {
    verifyErr = error
  }
  check(verifyErr?.code === 'APPLY_UNSUPPORTED_OPTION', `verify 在本面被明确拒绝（${verifyErr?.code}）`)
  let typoErr = null
  try {
    await applyTool.execute({ file_path: applyTarget, entity: 'function:gamma', op: 'rename', newname: 'delta' }, exec)
  } catch (error) {
    typoErr = error
  }
  check(typoErr?.code === 'ARGS_UNKNOWN_KEY', `拼错的 newname 被未知参数守卫拒绝（${typoErr?.code}）`)

  // 同一个 apply 的其余 op：write / patch / convert（旧工具定义仍在，apply 负责统一入口）。
  const opFile = path.join(applyTmp, 'ops.txt')
  const opWrite = await applyTool.execute({ file_path: opFile, op: 'write', content: 'one\ntwo\n' }, exec)
  check(opWrite.ok === true && opWrite.outcome === 'applied' && fs.readFileSync(opFile, 'utf8') === 'one\ntwo\n', 'apply op=write 从 DSH 面落盘')
  const opPatch = await applyTool.execute({ file_path: opFile, op: 'patch', hunks: [{ lines: [2, 2], expect: 'two', replace: 'TWO' }] }, exec)
  check(opPatch.ok === true && opPatch.outcome === 'applied' && fs.readFileSync(opFile, 'utf8').includes('TWO'), 'apply op=patch 从 DSH 面落盘')
  const opUtf16 = path.join(applyTmp, 'utf16.txt')
  fs.writeFileSync(opUtf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\n', 'utf16le')]))
  const opConvert = await applyTool.execute({ file_path: opUtf16, op: 'convert', to: 'utf-8', from: 'utf-16le' }, exec)
  check(opConvert.ok === true && opConvert.outcome === 'applied' && fs.readFileSync(opUtf16, 'utf8').includes('hello'), 'apply op=convert 从 DSH 面转 UTF-8')
  fs.rmSync(applyTmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`--- 结果：${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL: ${f.label} ${f.detail}`)
  process.exitCode = 1
}
