/**
 * outcome-test —— fs-contract-v2 的验收套件：**失败通道分成两条，且不许串线**。
 *
 * 契约（本套件是它的判据，不是它的说明书）：
 *   · 「工具判定不出调用方意图」⇒ **正常结果**，回执带三态 `outcome`：
 *       applied（改成了）| needs_choice（得从候选里选）| not_found（要改的原文不在文件里）
 *       ｜ already_applied（C49 补的第四态：原文不在、但结果**已经**是调用方给的样子了，
 *         这次一个字节都没写 —— 期望值跟着四态走，理由见段E2 那条注释）
 *   · 工具级故障 ⇒ 仍然抛错（isError=true）：沙箱拒绝、进程/IO 错误、参数形状根本没成形
 *
 * 为什么必须有这一套（既有 `load-test.mjs` 守不住它）：
 *   `load-test` 的失败用例断言的是"抛出了错误"——那正是**旧契约**。新契约里同一批失败
 *   必须**不抛**，两套断言不可能同时为真。所以旧的那几条注定要改，而"改成什么样"由这份
 *   新判据回答：
 *     段A 三类可判定失败 → isError=false，且 outcome 取值正确、磁盘一个字节没动
 *     段B 工具级故障     → isError=true（不许被降级成"结果"）
 *     段C old/context    → 能被 schema 收下、能原样传到引擎
 *     段D 编造的未知字段 → 仍被拒（schema 层 + 运行期守卫各一次）
 *     段E outcome        → 在 output.schema 里有声明（否则整条失败路径会被框架拒）
 *
 * 段A/段B 各自带**反向对照**：只断言"这条不抛"的话，一个把什么都吞掉的实现也能全绿，
 * 所以每条可判定失败旁边都站着一条必须抛的工具级故障；段D/段E 的"被拒/已声明"旁边
 * 也站着形近的假字段当对照。
 *
 * 跑法：`node src/aura-edit/outcome-test.mjs`，全绿 exit 0。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { planHunks } from './index.js'
import { contextServices } from '../locator-lab/mock-ctx.mjs'

const plugin = await import('./index.js')

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}
const say = (m) => console.log(m)

// ── 真框架的校验器（解析得到就用真的；解析不到只用结构下限，并且**说出来**）────
const loadRealFramework = () => {
  const anchors = [import.meta.url]
  const installed = path.join(process.env.USERPROFILE ?? '', '.aura', 'pkg', 'node_modules', 'aura-basetools', 'aura-read', 'index.js')
  if (fs.existsSync(installed)) anchors.push(installed)
  for (const anchor of anchors) {
    try {
      const mod = createRequire(anchor)('@deepseek-ai/dsh-tools')
      if (typeof mod.validateJsonSchemaValue === 'function') return mod
    } catch {
      /* 换下一个候选 */
    }
  }
  return null
}
const framework = loadRealFramework()
if (framework === null) {
  say('⚠️  解析不到宿主 peer（@deepseek-ai/dsh-tools）：真校验器那一层跳过。')
  say('    结构下限（字段已声明 / 必填在场 / enum 合法）仍然会跑——它是**下限**，不是通过。')
}

/** 真校验器：回**违规消息数组**（空 = 通过），不是 `{ok}` 对象。 */
const realViolations = (schema, value) => {
  if (framework === null) return []
  try {
    const out = framework.validateJsonSchemaValue(schema, value)
    return Array.isArray(out) ? out : []
  } catch (error) {
    return [String(error.message).split('\n')[0]]
  }
}

/**
 * **结构下限**校验（永远跑）：每个返回字段都必须已声明、必填字段必须在场、enum 取值合法。
 *
 * 这是真校验器的一个**子集**，故意只做这一块：本仓四次事故（`text`/`dry_run`/`version`/
 * `truncated`）全都是"返回了没声明的字段"，而这一块不需要完整的 JSON Schema 语义就能判。
 * 它替代不了真校验器，所以真校验器在场时两个都跑。
 */
const declaredViolations = (schema, value, at = 'value') => {
  const out = []
  const props = schema?.properties ?? {}
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(props, key)) out.push(`"${at}.${key}" is not a declared property`)
  }
  for (const key of schema?.required ?? []) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`missing required property "${at}.${key}"`)
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = value[key]
    if (v === undefined) continue
    if (Array.isArray(spec.enum) && !spec.enum.includes(v)) {
      out.push(`"${at}.${key}" = ${JSON.stringify(v)} is not one of ${JSON.stringify(spec.enum)}`)
    }
    if (spec.type === 'array' && Array.isArray(v) && spec.items?.properties !== undefined) {
      v.forEach((entry, i) => out.push(...declaredViolations(spec.items, entry, `${at}.${key}[${i}]`)))
    }
  }
  return out
}

// ── mock ctx：与真实 Cordis 上下文同形（用共享的 contextServices）─────────────
const tmp = path.join(os.tmpdir(), `aura-outcome-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })

/**
 * 一个可控的 fs 后端。
 *
 * `fail` 注入工具级故障（沙箱拒绝 / IO 错误）。**故障发生在后端的哪一层**是有讲究的，
 * 因为它决定这条错误走哪条路——段B 正是要证明这些错误不会被失败通道吞掉。
 */
const makeFs = (fail = {}) => {
  let version = 1
  const boom = (spec) => {
    if (spec !== undefined) throw Object.assign(new Error(spec.message), { code: spec.code })
  }
  return {
    resolve: async (p, opts) => {
      boom(fail.resolve)
      const abs = path.isAbsolute(p) ? p : path.resolve(opts?.cwd ?? tmp, p)
      return { displayPath: abs, targetKey: abs }
    },
    stat: async (t) => {
      if (!fs.existsSync(t.targetKey)) return undefined
      const st = fs.statSync(t.targetKey)
      if (st.isDirectory()) return { type: 'directory', size: 0 }
      return { type: 'file', version: `v${version}`, size: st.size }
    },
    readText: async (t) => {
      boom(fail.readText)
      return fs.readFileSync(t.targetKey, 'utf8')
    },
    readByteRange: async (t, r) => fs.readFileSync(t.targetKey).subarray(r.offset, r.offset + r.length),
    writeText: async (t, content) => {
      boom(fail.writeText)
      fs.writeFileSync(t.targetKey, content)
      version += 1
      return { version: `v${version}`, operation: 'update', after: content }
    },
    editText: async () => {
      throw new Error('editText must not be used by the write path')
    },
  }
}

/**
 * ctx 只 apply **一次**，fs 后端是可换的：`ctx.fs` 走 getter 读 holder，
 * 于是"换后端"不必重新注册工具（重注册会让手里的 `tool` 变成另一个闭包，
 * 而那种错误表现为"我改的 ctx 没生效"，很难看出来）。
 */
let registered = null
const holder = { fs: makeFs() }
plugin.apply({
  get fs() {
    return holder.fs
  },
  // 与真实 Cordis 同形：没有注入的策略 ⇒ inject 回调不触发 ⇒ policy 为 undefined。
  ...contextServices(),
  tools: { register: (t) => (registered = t), get: () => undefined },
  systemPrompt: { section: () => () => {} },
  emit: () => {},
  waterfall: async () => {
    throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
  },
})
const tool = registered
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

/**
 * 像框架那样跑一次调用。
 *
 * 框架只做两件事（`dsh-tools/lib/index.js` 的 finishScheduledExecution）：
 *   execute 抛错 ⇒ isError 结果，**只取 `error.message`**（其余字段全丢）；
 *   返回      ⇒ 过 `output.schema` 校验，再交给 render。
 * 本套件断言的就是这个分叉，所以这里必须有一份同形的实现：只测"抛没抛"会漏掉
 * "返回了但字段没声明"那一半（本仓因此炸过四次）。
 */
const run = async (args, fsService = makeFs()) => {
  holder.fs = fsService
  let value
  try {
    value = await tool.execute(args, exec)
  } catch (error) {
    return { isError: true, error, code: error?.code, text: String(error?.message ?? error), value: undefined, violations: [] }
  }
  const violations = [...declaredViolations(tool.output.schema, value), ...realViolations(tool.output.schema, value)]
  let text = ''
  try {
    text = tool.output
      .render(args, value)
      .map((b) => b.text)
      .join('\n')
  } catch (error) {
    violations.push(`render threw: ${error.message}`)
  }
  return { isError: false, value, code: value.code, text, violations }
}

const writeFixture = (name, content) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}
const readFixture = (p) => fs.readFileSync(p, 'utf8')

const SRC = ['function alpha() {', '  const n = 1;', '  return n;', '}', '', 'function beta() {', '  return 2;', '}', ''].join('\n')

// ════════════════════════════════════════════════════════════════════════════
say('=== A. 三类可判定失败：isError=false，outcome 正确，磁盘不变 ===')
/**
 * 三类（判据原文）：范围非法 / 断言不符 / 歧义。再加一条最朴素的"原文不在文件里"——
 * 它是真机上占比最高的那一类（日志：`PATCH_EXPECT_MISMATCH` 936 次、`PATCH_ANCHOR_NOT_FOUND` 97 次）。
 */
{
  const cases = [
    {
      label: 'A1 范围非法（行号越界）',
      file: 'a1.js',
      args: (p) => ({ file_path: p, hunks: [{ lines: [99, 99], replace: 'X' }] }),
      outcome: 'not_found',
    },
    {
      label: 'A2 断言不符（expect 对不上）',
      file: 'a2.js',
      args: (p) => ({ file_path: p, hunks: [{ lines: [2, 2], expect: '这段内容和第 2 行不一样', replace: 'X' }] }),
      outcome: 'not_found',
    },
    {
      label: 'A3 歧义（锚点两处都能对上）',
      file: 'a3.js',
      args: (p) => ({ file_path: p, hunks: [{ anchor: '  return ', replace: 'X' }] }),
      outcome: 'needs_choice',
    },
    {
      label: 'A4 原文不在文件里（锚点找不到）',
      file: 'a4.js',
      args: (p) => ({ file_path: p, hunks: [{ anchor: '这段内容根本不存在ZZZ\n也不在这里YYY', replace: 'X' }] }),
      outcome: 'not_found',
    },
    {
      label: 'A6 符号名不存在（target，STRUCT_NOT_FOUND）',
      file: 'a6-target.js',
      args: (p) => ({ file_path: p, hunks: [{ target: 'NO_SUCH_SYMBOL_ZZZ', replace: 'X' }] }),
      outcome: 'not_found',
    },
    {
      label: 'A7 符号名歧义（target，STRUCT_AMBIGUOUS）',
      file: 'a7-target.js',
      source: 'export function dup() {\n  return 1\n}\n\nexport function dup() {\n  return 2\n}\n',
      args: (p) => ({ file_path: p, hunks: [{ target: 'dup', replace: 'X' }] }),
      outcome: 'needs_choice',
    },
  ]
  for (const c of cases) {
    const file = writeFixture(c.file, c.source ?? SRC)
    const r = await run(c.args(file))
    check(!r.isError, `${c.label} ⇒ 不抛错（isError=false）`, r.isError ? `抛了：${r.code} ${r.text.slice(0, 60)}` : '')
    check(r.value?.outcome === c.outcome, `${c.label} ⇒ outcome=${c.outcome}`, `实际 ${JSON.stringify(r.value?.outcome)} code=${r.value?.code}`)
    check(typeof r.value?.code === 'string' && r.value.code.length > 0, `${c.label} ⇒ 带回引擎判决码`, `code=${JSON.stringify(r.value?.code)}`)
    check(Array.isArray(r.value?.applied) && r.value.applied.length === 0, `${c.label} ⇒ applied 为空数组（不必靠文本猜）`, JSON.stringify(r.value?.applied))
    check(typeof r.value?.next === 'string' && r.value.next.length > 0, `${c.label} ⇒ 带下一步（next）`, String(r.value?.next).slice(0, 50))
    check(readFixture(file) === (c.source ?? SRC), `${c.label} ⇒ 磁盘一个字节没动`)
    check(r.violations.length === 0, `${c.label} ⇒ 回执合 output.schema（不许凭空多字段）`, r.violations.slice(0, 2).join('; '))
    check(/nothing was written/.test(r.text), `${c.label} ⇒ 渲染文本明说"没写盘"`, r.text.split('\n')[0].slice(0, 80))
  }

  // 歧义还必须把**候选**给出来——否则 needs_choice 是一句空话
  const amb = await run({ file_path: writeFixture('a3b.js', SRC), hunks: [{ anchor: '  return ', replace: 'X' }] })
  check(
    Array.isArray(amb.value?.candidates) && amb.value.candidates.length >= 2,
    'A3 ⇒ needs_choice 必须附候选位置',
    JSON.stringify(amb.value?.candidates),
  )
  check(
    (amb.value?.candidates ?? []).every((x) => Number.isInteger(x.line)),
    'A3 ⇒ 候选形状统一为 {line, text?}（引擎给的是行号数组，壳层负责归一）',
    JSON.stringify(amb.value?.candidates),
  )
  check(/Candidates:/.test(amb.text), 'A3 ⇒ 候选也出现在给模型看的文本里', amb.text.split('\n').slice(0, 4).join(' / '))

  /**
   * 0.9.1：`target` 的两种失败也必须走结果通道。此前 `STRUCT_NOT_FOUND` / `STRUCT_AMBIGUOUS`
   * 不在壳层判决表里，会被当成工具故障抛出——模型只看到一句 error.message，拿不到 next 与候选。
   */
  const dupSource = 'export function dup() {\n  return 1\n}\n\nexport function dup() {\n  return 2\n}\n'
  const ambTarget = await run({ file_path: writeFixture('a7b-target.js', dupSource), hunks: [{ target: 'dup', replace: 'X' }] })
  check(
    ambTarget.value?.outcome === 'needs_choice' && Array.isArray(ambTarget.value?.candidates) && ambTarget.value.candidates.length >= 2,
    'A7 ⇒ target 歧义附候选（不是工具故障）',
    JSON.stringify({ outcome: ambTarget.value?.outcome, code: ambTarget.value?.code, candidates: ambTarget.value?.candidates?.length }),
  )
  const missingTarget = await run({ file_path: writeFixture('a6b-target.js', SRC), hunks: [{ target: 'NO_SUCH_SYMBOL_ZZZ', replace: 'X' }] })
  check(
    missingTarget.value?.outcome === 'not_found' && typeof missingTarget.value?.next === 'string' && missingTarget.value.next.length > 0,
    'A6 ⇒ target 不存在带回 next（不是工具故障）',
    JSON.stringify({ outcome: missingTarget.value?.outcome, code: missingTarget.value?.code, next: missingTarget.value?.next }),
  )

  // 恢复路径不能因为"不抛错了"而丢：符号目录仍要出现在回执正文里
  const hint = await run({
    file_path: writeFixture('a5.js', SRC),
    hunks: [{ anchor: '这段内容根本不存在ZZZ\n也不在这里YYY', replace: 'X' }],
  })
  check(/structural directory/.test(hint.value?.message ?? ''), 'A4 ⇒ 回执正文仍带结构目录（恢复路径没丢）')
  check(/target=/.test(hint.value?.message ?? ''), 'A4 ⇒ 目录里给出可执行的恢复指令（改用 target=）')

  // 事务性：一条能改、一条改不了 ⇒ 整体不落盘，且整体走结果
  const tx = writeFixture('a6.js', SRC)
  const multi = await run({
    file_path: tx,
    hunks: [
      { anchor: '  return 2;', replace: '  return 42;' },
      { anchor: '这段内容根本不存在ZZZ', replace: 'X' },
    ],
  })
  check(!multi.isError, 'A5 多 hunk 里任一条定位失败 ⇒ 仍走结果（不抛错）', multi.isError ? multi.code : '')
  check(multi.value?.outcome === 'not_found', 'A5 ⇒ outcome=not_found', JSON.stringify(multi.value?.outcome))
  check(readFixture(tx) === SRC, 'A5 ⇒ 第一条也**没有**偷偷落盘（事务性没退化）')
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== B. 工具级故障：必须仍然抛错（不许被降级成"结果"）===')
{
  const file = writeFixture('b1.js', SRC)
  const edit = { file_path: file, hunks: [{ anchor: '  return 2;', replace: '  return 42;' }] }

  const denied = await run(
    edit,
    makeFs({ writeText: { code: 'FS_PERMISSION_DENIED', message: 'file access denied under workspace-write mode' } }),
  )
  check(denied.isError, 'B1 沙箱拒绝写盘 ⇒ isError=true', denied.isError ? `code=${denied.code}` : `被降级成了 ${JSON.stringify(denied.value?.outcome)}`)
  check(/denied/.test(String(denied.text)), 'B1 ⇒ 拒绝原因原样带回', String(denied.text).slice(0, 80))
  check(readFixture(file) === SRC, 'B1 ⇒ 磁盘未变')

  const io = await run(edit, makeFs({ readText: { code: 'FS_IO_ERROR', message: 'EIO: i/o error, read' } }))
  check(io.isError, 'B2 读盘 IO 错误 ⇒ isError=true', io.isError ? `code=${io.code}` : '被降级成了结果')

  const resolveDenied = await run(
    edit,
    makeFs({ resolve: { code: 'FS_PERMISSION_DENIED', message: 'file access denied under read-only mode' } }),
  )
  check(resolveDenied.isError, 'B3 沙箱在解析路径时就拒绝 ⇒ isError=true', resolveDenied.isError ? `code=${resolveDenied.code}` : '被降级成了结果')

  // 参数形状根本没成形（与"参数 JSON 根本没解出来"同族）：报参数错，不报定位错
  const shapeless = await run({ file_path: file, hunks: 'nope' })
  check(shapeless.isError, 'B4 参数形状不成形（hunks 不是数组）⇒ isError=true', shapeless.isError ? String(shapeless.text).slice(0, 60) : '被降级成了结果')
  const halfBaked = await run({ file_path: file, replace: 'X' })
  check(halfBaked.isError, 'B5 只给 replace（没有地址）⇒ 仍报"hunks 非空"而不是定位失败', halfBaked.isError ? String(halfBaked.text).slice(0, 60) : '被降级成了结果')
  /**
   * B6 `PATCH_NO_ADDRESS`（列表里的 hunk 一个地址都没给）也**刻意不收**：它是参数没成形，
   * 不是"地址对不上"。这条断言就是那条边界的钉子——把表放松成"默认 not_found"时它会红。
   */
  const noAddress = await run({ file_path: file, hunks: [{ replace: 'X' }] })
  check(
    noAddress.isError && noAddress.code === 'PATCH_NO_ADDRESS',
    'B6 hunk 里一个地址都没给 ⇒ 抛错（参数没成形，不是 not_found）',
    noAddress.isError ? `code=${noAddress.code}` : `被降级成了 ${JSON.stringify(noAddress.value?.outcome)}`,
  )

  /**
   * B7 地址漂移（`PATCH_STALE_REGION`）：**刻意仍然抛错**，这条断言就是那个边界的记录。
   *
   * 它不是"判定不出意图"，而是安全闸门：调用方指的区间在它读完之后被别人改了。
   * 恢复动作是**重读**，不是重挑地址；降级成结果会让"磁盘没动"看起来像办完了。
   * 所以本单只收三类可判定失败 + "原文不在"那一族，闸门原样保留。
   */
  const staleFile = writeFixture('b6.js', SRC)
  const first = await run({ file_path: staleFile, hunks: [{ anchor: '  return n;', replace: '  return n;' }] })
  check(first.value?.outcome === 'applied', 'B7 前提：第一次编辑成功（账本记下这次观测）', JSON.stringify(first.value?.outcome ?? first.code))
  fs.writeFileSync(staleFile, SRC.replace('  return 2;', '  return 999;'), 'utf8') // 第三方改文件
  const stale = await run({ file_path: staleFile, hunks: [{ lines: [7, 7], replace: 'X' }] })
  check(
    stale.isError && stale.code === 'PATCH_STALE_REGION',
    'B7 地址漂移的安全闸门仍然抛错（本次刻意未降级成结果）',
    stale.isError ? `code=${stale.code}` : `被降级成了 ${JSON.stringify(stale.value?.outcome)}`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== C. old / context：schema 收得下，且原样传到引擎 ===')
const CONTENT_HUNK = {
  old: '  const n = 1;',
  context: 'function alpha() {',
  replace: '  const n = 42;',
}
{
  const shapes = [
    ['hunks 数组形状', { file_path: 'x.js', hunks: [CONTENT_HUNK] }],
    ['平铺形状', { file_path: 'x.js', ...CONTENT_HUNK }],
  ]
  for (const [label, args] of shapes) {
    const violations = realViolations(tool.parameters, args)
    check(violations.length === 0, `C1 ${label}：old/context 被 schema 接受`, violations.slice(0, 2).join('; '))
  }
  const hunkProps = Object.keys(tool.parameters.properties?.hunks?.items?.properties ?? {})
  check(
    hunkProps.includes('old') && hunkProps.includes('context'),
    'C1 hunk 声明里冻结了 old / context 两个名字',
    hunkProps.join(','),
  )
  check(
    tool.parameters.properties?.hunks?.items?.properties?.old?.type === 'string' &&
      tool.parameters.properties?.hunks?.items?.properties?.context?.type === 'string',
    'C1 两个字段都声明为 string',
  )
  check(
    plugin.EDIT_ARG_KEYS.includes('old') && plugin.EDIT_ARG_KEYS.includes('context'),
    'C1 运行期守卫的名单同源（EDIT_ARG_KEYS 由 HUNK_PROPERTIES 派生，没有第二份名单）',
  )

  // C2 运行期：带 old/context 的调用不许被守卫以 ARGS_UNKNOWN_KEY 拒掉
  const guarded = await run({ file_path: writeFixture('c2.js', SRC), hunks: [CONTENT_HUNK] })
  check(guarded.code !== 'ARGS_UNKNOWN_KEY', 'C2 old/context 不被运行期未知参数守卫拒绝', `code=${JSON.stringify(guarded.code)}`)

  // 每个用例都用**自己的夹具路径**：成功的那次会写盘并刷新观测账本，
  // 复用同一个路径会让下一条用例面对的已经不是同一份内容（C3 第一版就是这么假红的）。
  const file = writeFixture('c3.js', SRC)

  /**
   * C3 **判据对照**：壳层的判决必须与"直接调引擎"逐字一致。
   *
   * 这是本段真正的证据。只断言"工具不报未知参数"不够——字段可能在壳层被丢掉，
   * 而结果看起来仍然"没报错"（引擎会回一个 `PATCH_NO_ADDRESS`）。同一个 hunk 直接喂
   * `planHunks` 做对照，两边一致就证明**字段确实到了引擎手里**；
   * 而且这条判据在 C2 落地前后都成立：引擎还不认内容地址时，两边都回 `PATCH_NO_ADDRESS`。
   */
  const direct = (() => {
    try {
      return { ok: true, applied: planHunks(SRC, [CONTENT_HUNK], file).applied }
    } catch (error) {
      return { ok: false, code: error.code }
    }
  })()
  const viaTool = await run({ file_path: file, hunks: [CONTENT_HUNK] })
  if (direct.ok) {
    check(
      viaTool.value?.outcome === 'applied',
      'C3 引擎认内容地址 ⇒ 工具这条路也必须命中（字段没被壳层吞掉）',
      JSON.stringify(viaTool.value?.outcome ?? viaTool.code),
    )
    check(readFixture(file).includes('const n = 42;'), 'C3 ⇒ 替换真的落盘')
  } else {
    check(
      viaTool.code === direct.code,
      'C3 工具与"直接调引擎"的判决一致（字段确实传到了引擎；此刻引擎尚未实现内容寻址）',
      `引擎=${direct.code} 工具=${viaTool.code}`,
    )
    say(`    · 注：引擎此刻对纯内容地址的判决是 ${direct.code} —— 与工具一致。C2 落地后这条自动升级为 applied 断言。`)
  }

  // C4 平铺形状：old/context 在顶层也必须被当成地址（不许掉进"hunks 非空"那条报错）
  // 夹具路径必须是**没被本次套件碰过**的：观测账本按路径记账，复用会让闸门
  // （PATCH_STALE_REGION）先于定位判决开口，而那是另一条通道的事。
  const flatFile = writeFixture('c4.js', SRC)
  const flat = await run({ file_path: flatFile, ...CONTENT_HUNK })
  const flatText = String(flat.isError ? flat.text : flat.value?.message ?? '')
  check(
    !/hunks must be a non-empty array/.test(flatText),
    'C4 平铺的 old/context 被当成地址（没有掉进"hunks 非空"那条报错）',
    flatText.slice(0, 80),
  )
  check(
    flat.isError ? flat.code === direct.code : flat.value?.outcome === (direct.ok ? 'applied' : 'not_found'),
    'C4 平铺形状与 hunks 数组形状给出同一判决',
    flat.isError ? `抛 ${flat.code}` : `outcome=${flat.value?.outcome}`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== D. 编造的未知字段：仍然被拒（两层各一次）===')
{
  const file = writeFixture('d1.js', SRC)
  // 第一层：运行期守卫（给可执行的报错）
  const guard = await run({ file_path: file, hunks: [{ anchor: '  return 2;', replace: 'X' }], outcome_typo: 'applied' })
  check(guard.isError && guard.code === 'ARGS_UNKNOWN_KEY', 'D1 顶层编造字段 ⇒ 运行期守卫拒绝', `code=${guard.code}`)
  // 第二层：schema 的 additionalProperties:false（拼错时框架在参数层就拦下）
  const inHunk = realViolations(tool.parameters, { file_path: 'x.js', hunks: [{ anchor: 'a', replace: 'b', bogus: 1 }] })
  if (framework !== null) {
    check(inHunk.length > 0, 'D2 hunk 里编造字段被 schema 拒（hunks.items 的 additionalProperties:false）', inHunk.slice(0, 1).join(''))
  }
  /**
   * D3 是一条**如实记录的边界**，不是要求：真框架的 `parameters` 根上**没有**
   * `additionalProperties` 这个概念——`defineTool` 只把 `options.parameters` 编译成 schema
   * （`dsh-tools/lib/index.js:846` 的 `parameterSchemaSpecToJsonSchema`），写在 `defineTool`
   * 顶层的那个 `additionalProperties: false` 压根到不了校验器。
   * 所以顶层未声明参数的唯一闸门是运行期守卫 {@link assertKnownArgs}（D1/D4 守着它）。
   * 写下这条是因为它直接决定了"守卫能不能删"：删了就真的没人拦了。
   */
  check(
    tool.parameters.additionalProperties === undefined,
    'D3 如实记录：顶层未声明键不是 schema 层拦的（parameters 根上没有 additionalProperties），拦它的是运行期守卫',
    `parameters.additionalProperties=${JSON.stringify(tool.parameters.additionalProperties)}`,
  )
  // 反向对照：把 old/context 换成形近的假名字，必须**依然**被拒（证明 D 段的判据不是恒真）
  const nearMiss = realViolations(tool.parameters, { file_path: 'x.js', hunks: [{ olds: 'a', contextx: 'b', replace: 'c' }] })
  const nearMissTop = await run({ file_path: file, olds: 'a', replace: 'b' })
  check(nearMissTop.isError && nearMissTop.code === 'ARGS_UNKNOWN_KEY', 'D4 形近的假字段（olds/contextx）在运行期被拒', `code=${nearMissTop.code}`)
  if (framework !== null) {
    check(nearMiss.length > 0, 'D5 形近的假字段在 schema 层被拒', nearMiss.slice(0, 1).join(''))
  }
  const props = Object.keys(tool.parameters.properties ?? {})
  check(
    props.includes('old') && props.includes('context') && !props.includes('olds'),
    'D6 顶层声明的键集合 = 真参数 + 两个新 hunk 键，且没有放宽成 passthrough',
    props.join(','),
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== E. outcome 在 output schema 里声明（否则整条失败路径会被框架拒）===')
{
  const out = tool.output.schema
  check(Object.hasOwn(out.properties ?? {}, 'outcome'), 'E1 output.schema 声明了 outcome')
  /**
   * C49（fs-contract-v2 波16）：这条断言的**期望值从三态改成四态**。
   *
   * 这不是「把红的改绿」：第四态（`already_applied`：原文不在、但结果已经是你给的样子了，
   * 这次一个字节都没写）是这一波引擎与壳层一起补的，而它要能被框架**收下**，就必须进这份
   * `enum` —— `output.schema` 是 `additionalProperties:false`，enum 是验证面，
   * 少一个名字的后果是 execute 的返回值被 `INVALID_TOOL_OUTPUT` 顶掉、模型什么都看不到。
   *
   * 断言本身**一条不少、一个字没弱**：判的仍是「enum 与契约的名单逐字相同」，
   * 只是那份名单现在有四个名字（比改前多钉住一个）。
   * 本条改动的归属与理由见 `.polaris/workorders/fs-contract-v2.C49.result.json` 的 deviations ①。
   */
  check(
    JSON.stringify(out.properties?.outcome?.enum) ===
      JSON.stringify(['applied', 'needs_choice', 'not_found', 'already_applied']),
    'E2 outcome 的四态取值与契约一致',
    JSON.stringify(out.properties?.outcome?.enum),
  )
  // 必填是**提升**到父对象上的：本框架的 DSL 把属性里的 `required: true` 收成父对象的
  // `required: [...]`（与 hunk 的 replace 同一条规则），所以要看 out.required。
  check(
    (out.required ?? []).includes('outcome') || out.properties?.outcome?.required === true,
    'E3 outcome 是必填（成功路径也必须给）',
    `required=${JSON.stringify(out.required)}`,
  )
  check(out.additionalProperties === false, 'E4 output.schema 仍是 additionalProperties:false（没被放松）')
  check(!Object.hasOwn(out.properties ?? {}, 'outcome_typo'), 'E5 对照：编造的字段不在声明里')
  const created = await run({ file_path: path.join(tmp, 'made.txt'), create: 'hello\n' })
  check(
    created.value?.outcome === 'applied' && created.violations.length === 0,
    'E6 建文件路径带回 outcome=applied 且合 schema',
    JSON.stringify(created.value?.outcome),
  )
}

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== F. 句柄：四个新码走结果通道；形状不对仍然抛错（参数面）===')
{
  /**
   * 四个新码（契约 §5 解析次序 / §9 的 D6）：**全部走结果通道**，只有"句柄形状不对"
   * （连正则都不匹配）仍属参数面抛错。本段把这条边界钉在两处：
   *   · 判决表本身（逐条 `['CODE', 'outcome']`，与三处按文本解析它的套件同一份）；
   *   · 派生导出 `INTENT_CODES`——它必须**自动**跟上，不许有人手抄第二份名单。
   */
  const HANDLE_CODES = [
    'PATCH_HANDLE_STALE',
    'PATCH_HANDLE_IDENTITY_MISMATCH',
    'PATCH_HANDLE_LINE_OUT_OF_RANGE',
    'PATCH_HANDLE_QUOTE_OUTSIDE',
  ]
  const HANDLE = 'h9f3ac1b2e4d5:2-3' // 形状合法（h+4+8+坐标）——摘要对不对由引擎核
  const SELF = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  const tableBlock = SELF.slice(SELF.indexOf('const OUTCOME_BY_CODE'), SELF.indexOf('export const INTENT_CODES'))
  const table = new Map(
    [...tableBlock.matchAll(/\['([A-Z_]+)',\s*'(applied|needs_choice|not_found|already_applied)'\]/g)].map((m) => [m[1], m[2]]),
  )
  check(table.size >= 10, 'F1 判决表被逐条解析出来（形状没改成别的写法）', `${table.size} 条`)
  for (const code of HANDLE_CODES) {
    check(
      table.get(code) === 'not_found',
      `F1 ${code} ⇒ OUTCOME_BY_CODE 判为 not_found（结果通道，不抛错）`,
      `表里=${JSON.stringify(table.get(code))}`,
    )
  }
  check(
    JSON.stringify(plugin.INTENT_CODES) === JSON.stringify([...table.keys()]),
    'F2 INTENT_CODES 是那张表的**派生**导出（自动跟上，没有第二份手写名单）',
    `INTENT=${plugin.INTENT_CODES.length} 表=${table.size}`,
  )
  check(
    HANDLE_CODES.every((c) => plugin.INTENT_CODES.includes(c)),
    'F2 四个新码都在 INTENT_CODES 里 ⇒ 壳层不会把它们当工具级故障抛出',
    HANDLE_CODES.filter((c) => !plugin.INTENT_CODES.includes(c)).join(',') || '（全在）',
  )

  // F3 hunk 键清单：handle / line / position 与运行期守卫**同源**（EDIT_ARG_KEYS 由 HUNK_PROPERTIES 派生）
  const hunkProps = Object.keys(tool.parameters.properties?.hunks?.items?.properties ?? {})
  const want = ['handle', 'line', 'position']
  check(want.every((k) => hunkProps.includes(k)), 'F3 hunk 声明里冻结了 handle / line / position 三个名字', hunkProps.join(','))
  check(
    tool.parameters.properties?.hunks?.items?.properties?.handle?.type === 'string' &&
      tool.parameters.properties?.hunks?.items?.properties?.line?.type === 'integer',
    'F3 handle 声明为 string、line 声明为 integer',
  )
  check(
    want.every((k) => plugin.EDIT_ARG_KEYS.includes(k)),
    'F3 运行期守卫的名单同源（删掉一个键，上面这两条与 F4 一起变红）',
    plugin.EDIT_ARG_KEYS.join(','),
  )

  // F4 运行期：平铺的 {file_path, handle, replace} 不许被守卫以 ARGS_UNKNOWN_KEY 拒掉
  const guardFile = writeFixture('f4.js', SRC)
  const guarded = await run({ file_path: guardFile, handle: HANDLE, replace: 'X' })
  check(guarded.code !== 'ARGS_UNKNOWN_KEY', 'F4 平铺的 handle 不被运行期未知参数守卫拒绝', `code=${JSON.stringify(guarded.code)}`)
  // 反向对照：形近的假名字必须**依然**被拒（证明 F4 不是恒真）
  const nearMissHandle = await run({ file_path: guardFile, handel: HANDLE, replace: 'X' })
  check(
    nearMissHandle.isError && nearMissHandle.code === 'ARGS_UNKNOWN_KEY',
    'F4 形近的假字段（handel）在运行期仍被拒',
    `code=${nearMissHandle.code}`,
  )

  /**
   * F5 端到端：句柄 hunk 的判决必须**走结果通道**（isError=false + outcome + code + next）。
   *
   * 与段C3 同一条镜子判据：引擎先落地（HD2）时这一段自动升级成"四条都能判定"；
   * 引擎还没识别句柄时，两边必须给**同一个码**——那证明字段确实到了引擎手里，
   * 而壳层没有自作主张把任何东西吞掉或伪造。
   */
  const e2e = writeFixture('f5.js', SRC)
  const handleHunk = { handle: HANDLE, replace: '  return 7;' }
  const direct = (() => {
    try {
      return { ok: true, applied: planHunks(SRC, [handleHunk], e2e).applied }
    } catch (error) {
      return { ok: false, code: error.code }
    }
  })()
  const viaTool = await run({ file_path: e2e, hunks: [handleHunk] })
  if (direct.ok) {
    check(viaTool.value?.outcome === 'applied', 'F5 引擎认句柄 ⇒ 工具这条路必须命中', JSON.stringify(viaTool.value?.outcome ?? viaTool.code))
  } else if (HANDLE_CODES.includes(direct.code)) {
    check(!viaTool.isError, 'F5 句柄被拒 ⇒ isError=false（走结果通道，不抛错）', viaTool.isError ? `抛了 ${viaTool.code}` : '')
    check(viaTool.value?.outcome === 'not_found', 'F5 ⇒ outcome=not_found', JSON.stringify(viaTool.value?.outcome))
    check(viaTool.value?.code === direct.code, 'F5 ⇒ code 原样透传（与直接调引擎逐字一致）', `引擎=${direct.code} 工具=${viaTool.code}`)
    check(typeof viaTool.value?.next === 'string' && viaTool.value.next.length > 0, 'F5 ⇒ 带下一步（next）', String(viaTool.value?.next).slice(0, 50))
  } else {
    check(
      viaTool.code === direct.code,
      'F5 工具与"直接调引擎"的判决一致（字段确实传到了引擎；此刻引擎尚未识别句柄）',
      `引擎=${direct.code} 工具=${viaTool.code}`,
    )
    say(`    · 注：引擎此刻对句柄 hunk 的判决是 ${direct.code} —— 与工具一致。HD2 落地后这条自动升级为 isError=false + outcome=not_found 断言。`)
  }

  /**
   * F6 反向对照：形状不对的句柄**必须抛错**（契约 §5 第 0 步：参数没成形，不是判不出意图）。
   * 它是 F5 那四条的反面——只断言"不抛"的话，一个把什么都吞掉的实现也能全绿。
   */
  const badShape = await run({ file_path: writeFixture('f6.js', SRC), hunks: [{ handle: 'not-a-handle', replace: 'X' }] })
  check(
    badShape.isError === true,
    'F6 句柄形状不对 ⇒ 仍抛错（参数面，不许降级成结果）',
    badShape.isError ? `code=${badShape.code}` : `被降级成了 ${JSON.stringify(badShape.value?.outcome)}`,
  )

  /**
   * F7 披露（契约 §9 的 D7）：句柄 hunk 的回执必须说出"落点来自句柄"以及被忽略的一方，
   * **沉默忽略不行**。渲染是纯函数，所以这里直接喂一份合 schema 的回执——它测的正是
   * "渲染有没有接上那份披露"，而不是引擎怎么判决。
   */
  const renderArgs = { file_path: 'x.js', hunks: [{ handle: HANDLE, old: '  return n;', lines: [2, 3], replace: 'X' }] }
  const receipt = {
    path: 'x.js',
    // 形状必须与 output.schema 声明的 `applied[]` 逐字一致（多一个键就会被真校验器拒）
    applied: [{ line: 3, tier: 'lines', byNear: false, actual: '  return n;', replaced: 'X' }],
    outcome: 'applied',
    dryRun: false,
  }
  const receiptViolations = [
    ...declaredViolations(tool.output.schema, receipt),
    ...realViolations(tool.output.schema, receipt),
  ]
  check(
    receiptViolations.length === 0,
    'F7 前提：喂给渲染的那份回执本身合 output.schema（不是编的形状）',
    receiptViolations.slice(0, 3).join('; '),
  )
  const rendered = tool.output
    .render(renderArgs, receipt)
    .map((b) => b.text)
    .join('\n')
  check(/addressed by a handle/.test(rendered), 'F7 句柄 hunk 的回执披露"落点来自句柄"', rendered.split('\n').slice(-2).join(' / ').slice(0, 110))
  check(
    /ignored because the handle wins/.test(rendered) && /`old`/.test(rendered) && /`lines`/.test(rendered),
    'F7 ⇒ 点名被忽略的 old / lines（披露，不是沉默忽略）',
    rendered.split('\n').slice(-1)[0].slice(0, 110),
  )
  // 反向对照：没有句柄 hunk 时一个字符都不加（既有回执逐字不变）
  const plainRendered = tool.output
    .render({ file_path: 'x.js', hunks: [{ anchor: '  return n;', replace: 'X' }] }, receipt)
    .map((b) => b.text)
    .join('\n')
  check(
    !/handle|ignored because/.test(plainRendered),
    'F7 反向对照：没有句柄 hunk 时回执里不出现任何披露（既有回执逐字不变）',
    plainRendered.split('\n').slice(-1)[0].slice(0, 80),
  )
}

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== G. 句柄端到端：aura_basetools_read（壳）发句柄 ⇒ aura_basetools_edit（壳）用它改 ===')
{
  /**
   * 这一段的判据是**壳层这条路**上的完整回合，不是引擎单测：
   * 读一次（壳）拿到句柄 ⇒ 拿它改一次（壳）⇒ `outcome=applied` 且**真的落盘**。
   *
   * 为什么必须有它：句柄里的身份标签 + 区间摘要是**读侧按当时的口径**算的，编辑侧
   * 必须重算同一份才可能对上。两处只要有一处漏了 `identityKey` / `byteOrderMark`，
   * 句柄就永远"过期"——而那不是错改，是**永远拒**（`PATCH_HANDLE_STALE`）。
   */
  const readPlugin = await import('../aura-read/index.js')
  let readTool = null
  const readHolder = { fs: makeFs() }
  readPlugin.apply({
    get fs() {
      return readHolder.fs
    },
    ...contextServices(),
    tools: { register: (t) => (readTool = t), get: () => undefined },
    systemPrompt: { section: () => () => {} },
    emit: () => {},
  })
  const readOnce = async (args, fsService) => {
    readHolder.fs = fsService
    return readTool.execute(args, exec)
  }
  /**
   * 与 `dsh-fs-local` 同形的后端：`readText` 是 fatal TextDecoder 解码 ⇒ **头一个 BOM 被吃掉**
   * （字符串里看不见），只有 `readByteRange` 能回答"这份文件带不带 BOM"。
   * `alias` 给定时 `displayPath` 与 `targetKey` 不同——别名 / 符号链接路径那一档。
   */
  const fsLike = (alias = null) => ({
    ...makeFs(),
    resolve: async (p, opts) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(opts?.cwd ?? tmp, p)
      return { displayPath: alias === null ? abs : alias(abs), targetKey: abs }
    },
    readText: async (t) => fs.readFileSync(t.targetKey, 'utf8').replace(/^\uFEFF/, ''),
  })
  const handleOf = async (file, fsService) => {
    const env = await readOnce({ file_path: file, mode: 'lines', lines: [2, 3] }, fsService)
    return typeof env?.handle === 'string' ? env.handle : null
  }
  const roundTrip = async (label, { bom = false, alias = null } = {}) => {
    const file = writeFixture(`g-${label.replace(/[^a-z0-9]/gi, '')}.js`, bom ? `\uFEFF${SRC}` : SRC)
    const fsService = fsLike(alias)
    const handle = await handleOf(file, fsService)
    check(
      typeof handle === 'string' && /^h[0-9a-f]{4}[0-9a-f]{8}:\d+-\d+$/.test(handle),
      `G ${label}：读回执给出形状合法的句柄`,
      String(handle),
    )
    const edited = await run({ file_path: file, hunks: [{ handle, replace: '  const n = 42\n  return n\n' }] }, fsService)
    check(
      edited.value?.outcome === 'applied',
      `G ${label}：句柄 hunk ⇒ outcome=applied`,
      edited.isError ? `抛了 ${edited.code}` : `outcome=${JSON.stringify(edited.value?.outcome)} code=${edited.value?.code}`,
    )
    check(readFixture(file).includes('const n = 42'), `G ${label}：⇒ 真的落盘（不是只回了个 applied）`)
  }

  await roundTrip('普通路径')
  /**
   * BOM 这一档**正是漏传第 4 参会假红的那一档**：读侧按"含 U+FEFF 的区间字节"算摘要，
   * 编辑侧不传 `byteOrderMark` 就会算出另一份 ⇒ 永远 `PATCH_HANDLE_STALE`。
   */
  await roundTrip('BOM文件', { bom: true })
  /**
   * 别名路径这一档盯的是 `identityKey`：`displayPath`（调用方给的写法）与 `targetKey`
   * （盘上是谁）不同，身份标签必须按后者算两面才一致（C61 的同一道接缝）。
   */
  await roundTrip('别名路径', { alias: (abs) => `${abs}.alias` })

  // 反向对照：把 A 文件的句柄拄到 B 文件上 ⇒ 结果通道的身份不符（不是 applied）
  const donorFile = writeFixture('g-donor.js', SRC)
  const otherFile = writeFixture('g-other.js', SRC) // 同内容：把对照逼到**身份**那一条判据上
  const donor = await handleOf(donorFile, fsLike())
  const otherFs = fsLike()
  await handleOf(otherFile, otherFs) // 先读 other：让它有观测记录，别让闸门先开口
  const crossed = await run({ file_path: otherFile, hunks: [{ handle: donor, replace: '  return 2\n' }] }, otherFs)
  check(
    !crossed.isError && crossed.value?.outcome === 'not_found' && crossed.value?.code === 'PATCH_HANDLE_IDENTITY_MISMATCH',
    'G 对照：把另一个文件的句柄拄过来 ⇒ not_found + PATCH_HANDLE_IDENTITY_MISMATCH（结果通道）',
    crossed.isError ? `抛了 ${crossed.code}` : `outcome=${crossed.value?.outcome} code=${crossed.value?.code}`,
  )

  /**
   * G4 读数（**测量**，不是判据）：句柄在**宿主面**与**模型面**各到没到。
   *
   * 宿主面 = 工具结果的结构化 `value`（schema 验过、按 PASSTHROUGH_FIELDS 透传）。
   * 模型面 = `output.render` 产出的 content 块——框架只把这一份装进 tool 消息
   * （`dsh-agent-loop/lib/index.js` 的 `appendToolResult`：`content: result.content`，
   * `result.value` 不进），所以一份只在结构化字段里的句柄，模型看不到。
   */
  const visibleFile = writeFixture('g-visible.js', SRC)
  const visibleFs = fsLike()
  const visible = await readOnce({ file_path: visibleFile, mode: 'lines', lines: [2, 3] }, visibleFs)
  const modelText = readTool.output
    .render({ file_path: visibleFile, mode: 'lines', lines: [2, 3] }, visible)
    .map((b) => b.text)
    .join('\n')
  check(typeof visible?.handle === 'string', 'G4 宿主面：读回执的结构化 value 里带着 handle', String(visible?.handle))
  say(
    `    · G4 读数（模型面）：content 块里${modelText.includes(visible.handle) ? '**有**句柄' : '**没有**句柄'} —— ` +
      '框架只把 result.content 装进 tool 消息（result.value 不进）；这一格要不要修由主线程裁（读侧渲染不在本单写面）。',
  )
}

/**
 * 段H —— 多目标写（fs-contract-v2 §2.2/§3 / MT4 壳层）。
 *
 * 三条要钉的事：
 *   1. `targets` 三条全部 applied **且真落盘**（读磁盘，不是读回执）；
 *   2. 一条规划不成立 ⇒ **磁盘一个字节没动**，且回执明说哪些落地、哪些没有；
 *   3. 互斥与单目标零回归：`targets`+`file_path` 同给 ⇒ 参数面抛错；单目标回执**没多出**任何字段。
 *
 * `applied` 顶层是全批 hunk 的并集：它若退化成空数组，“一个 hunk 都没落盘”就与
 * “落了三个”在回执上不可分了（H2 就是钉这一条的）。
 */
say('')
say('=== 段H 多目标写：三阶段提交 + 逐项回执 + 单目标零回归 ===')
{
  const body = (name) =>
    [`/** ${name} */`, `export const VERSION = '${name}-0.0.1'`, `export const TAG = '${name}-tag'`, ''].join('\n')
  const one = path.join(tmp, 'mt-one.mjs')
  const two = path.join(tmp, 'mt-two.mjs')
  const three = path.join(tmp, 'mt-three.mjs')
  const files = [one, two, three]
  const names = ['mt-one', 'mt-two', 'mt-three']
  files.forEach((file, i) => fs.writeFileSync(file, body(names[i])))

  const batch = await run({
    targets: files.map((file, i) => ({
      file_path: file,
      hunks: [{ target: 'VERSION', replace: `export const VERSION = '${names[i]}-edited'` }],
    })),
  })
  check(!batch.isError, 'H1 多目标写走结果通道（isError=false）', batch.isError ? batch.text.slice(0, 80) : '')
  check(
    batch.violations.length === 0,
    'H1b 整批回执合 output.schema（additionalProperties:false 没把它整条顶掉）',
    batch.violations.slice(0, 2).join('; '),
  )
  check(batch.value?.applied?.length === 3, 'H2 顶层 applied = 全批 hunk 并集（不是空数组）', String(batch.value?.applied?.length))
  check(
    batch.value?.edits?.map((e) => e.outcome).join(',') === 'applied,applied,applied' &&
      batch.value?.landed_paths?.length === 3,
    'H3 三项逐项回执都 applied 且 landed',
    `${batch.value?.edits?.map((e) => e.outcome)} landed=${batch.value?.landed_paths?.length}`,
  )
  check(
    files.every((file, i) => fs.readFileSync(file, 'utf8').includes(`${names[i]}-edited`)),
    'H4 三个文件**真的落盘了**（读磁盘，不是读回执）',
  )
  check(
    typeof batch.value?.summary === 'string' && batch.value.summary.startsWith('targets: 3'),
    'H5 汇总行出现（结构化 summary 字段）',
    String(batch.value?.summary),
  )
  check(!batch.text.includes(batch.value.summary), 'H5b 汇总行**不进**正文 body')
  check(
    batch.value?.edits?.every((e) => typeof e.text === 'string' && e.text.length > 0),
    'H6 逐项正文都在（同一套单目标渲染）',
  )

  // ── 一条规划不成立 ⇒ 零写入（契约 §3.4）────────────────────────────────
  const disk = files.map((file) => fs.readFileSync(file))
  const partial = await run({
    targets: [
      { file_path: one, hunks: [{ target: 'VERSION', replace: "export const VERSION = 'mt-one-second'" }] },
      { file_path: two, hunks: [{ target: 'NO_SUCH_SYMBOL', replace: 'x' }] },
    ],
  })
  check(
    !partial.isError && partial.value?.edits?.some((e) => e.outcome === 'failed'),
    'H7 规划失败走结果通道（不抛）',
    partial.isError ? `抛了 ${partial.code}` : String(partial.value?.edits?.map((e) => e.outcome)),
  )
  check(
    JSON.stringify(files.map((file) => fs.readFileSync(file))) === JSON.stringify(disk),
    'H8 阶段一失败 ⇒ **磁盘一个字节没动**',
  )
  check(
    partial.value?.landed_paths?.length === 0 && (partial.value?.not_landed_paths?.length ?? 0) === 2,
    'H9 回执说清哪些已落地、哪些没有',
    `landed=${JSON.stringify(partial.value?.landed_paths)} not_landed=${JSON.stringify(partial.value?.not_landed_paths)}`,
  )
  check(
    String(partial.value?.summary).includes('no files were changed'),
    'H10 汇总行明说一个文件都没改',
    String(partial.value?.summary),
  )

  // ── 互斥 + 单目标零回归 ───────────────────────────────────────────────
  const both = await run({
    file_path: one,
    hunks: [{ target: 'VERSION', replace: "export const VERSION = 'x'" }],
    targets: [{ file_path: two, hunks: [{ target: 'VERSION', replace: "export const VERSION = 'y'" }] }],
  })
  check(
    both.isError && both.code === 'ARGS_SHAPE_EXCLUSIVE' && /not both/.test(both.text),
    'H11 `targets` 与 `file_path` 同时给 ⇒ 参数面抛错，说清二选一',
    `${both.code}: ${both.text.slice(0, 90)}`,
  )
  const before = fs.readFileSync(one)
  const solo = await run({ file_path: one, hunks: [{ target: 'VERSION', replace: "export const VERSION = 'mt-one-final'" }] })
  check(
    !solo.isError &&
      solo.value?.outcome === 'applied' &&
      !('targets' in solo.value) &&
      !('summary' in solo.value) &&
      !('edits' in solo.value),
    'H12 单目标回执**没多出**任何多目标字段（逐字节不变的那条路）',
    Object.keys(solo.value ?? {}).join(','),
  )
  check(
    fs.readFileSync(one).length !== before.length && fs.readFileSync(one, 'utf8').includes('mt-one-final'),
    'H13 单目标写仍真落盘（与多目标在同一份夹具上共存）',
  )
}

// ════════════════════════════════════════════════════════════════════════════
/**
 * 段I —— 多目标**逐项正文**的诚实性：每项正文必须与**它自己**的 `outcome` / `landed` 对得上。
 *
 * 为什么必须有这一段（实测缺陷，0.6.12）：逐项正文与单目标正文用的是**同一个** `receiptBody`，
 * 而它按 `value.outcome` 分四支；多目标那条路把**引擎回执**原样递了进去，而引擎回执只有
 * `already_applied` 那一态自带 `outcome`（成功 / 创建 / 预演三态把它记在 `operation` / `dryRun` 上）
 * ⇒ `undefined !== 'applied'` 把一次**已经落盘**的编辑交给失败渲染器，正文印出
 * 「nothing was written — outcome: undefined」。同一项的抬头行却写着 `applied`、`landed=true`，
 * 磁盘上那份文件也确实改了——模型拿到的是自相矛盾的回执，代价是去重试一次本来就成功的编辑。
 *
 * 判据不看措辞像不像，只看**两项事实对不对得上**（可机械核对，与文案无关）：
 *   · `landed === true` 的项：正文**不许**出现 `nothing was written`（磁盘动了）；
 *   · `landed !== true` 的项：正文**必须**出现 `nothing was written`（磁盘一个字节没动）；
 *   · 任何一项（以及整批）正文，都不许把 outcome 那格渲染成 `undefined` / `null`；
 *   · 一项的正文只许提**它自己**的路径（判决不许在兄弟项之间串）；
 *   · 成功项的正文与“同一个 hunk 单发一次”的正文**逐字节相同**（同一套渲染，不是另写一套）。
 *
 * 反向对照：成功项旁边站着没落地的项（I2 的写阶段拒绝、I3 的规划失败、I4 的 already_applied、
 * I6 的预演），所以“正文里没有 nothing was written”不是恒真，“有”也不是恒真；I7 那一项
 * `landed=true` 而 `outcome=failed`，钉的是另一头：磁盘已经改了，就不许再说“没写盘”。
 */
say('')
say('=== 段I 多目标逐项正文：与自己的 outcome / landed 对得上 ===')
{
  const bodyOf = (tag) =>
    [`/** ${tag} */`, `export const VERSION = '${tag}-0.0.1'`, `export const TAG = '${tag}-tag'`, ''].join('\n')
  const hunkOf = (tag) => ({ target: 'VERSION', replace: `export const VERSION = '${tag}-edited'` })
  const plant = (name, tag) => {
    const p = path.join(tmp, name)
    fs.writeFileSync(p, bodyOf(tag))
    return p
  }
  const NO_WRITE = /nothing was written/
  /** 一项的正文提了兄弟项的路径，或压根没提自己的 —— 判决串了。 */
  const borrowing = (edits) =>
    edits.filter(
      (edit) => !edit.text.includes(edit.file_path) || edits.some((other) => other !== edit && edit.text.includes(other.file_path)),
    )
  /** outcome 那格被渲染成占位符（缺陷原样就是这一格）。 */
  const placeholders = (texts) => texts.filter((t) => /\bundefined\b|\bnull\b/.test(t))
  const show = (texts) => texts.map((t) => JSON.stringify(String(t).split('\n')[0])).join(' | ')

  // ── I1 三项全落地：正文必须是成功正文，且与单发一次逐字节相同 ──────────────
  const okFiles = ['i1-a.mjs', 'i1-b.mjs', 'i1-c.mjs'].map((name) => plant(name, 'i1'))
  const okBatch = await run({ targets: okFiles.map((file) => ({ file_path: file, hunks: [hunkOf('i1')] })) })
  const okEdits = okBatch.value?.edits ?? []
  check(
    okEdits.length === 3 && okEdits.every((e) => e.landed === true && e.outcome === 'applied'),
    'I1 夹具成立：三项都 applied 且 landed',
    JSON.stringify(okEdits.map((e) => [e.outcome, e.landed])),
  )
  const lied = okEdits.filter((e) => NO_WRITE.test(e.text))
  check(
    lied.length === 0,
    'I1a 已落地的项，正文不许说 "nothing was written"',
    lied.length === 0 ? `${okEdits.length}/3 项都是成功正文` : show(lied.map((e) => e.text)),
  )
  check(
    placeholders([...okEdits.map((e) => e.text), String(okBatch.text)]).length === 0,
    'I1b 正文里没有 undefined / null 占位（outcome 那格必须是有词的那一格）',
    show(placeholders([...okEdits.map((e) => e.text), String(okBatch.text)])) || '3 项 + 整批正文都干净',
  )
  check(
    borrowing(okEdits).length === 0,
    'I1c 每项正文只提自己的路径（不借兄弟项的判决）',
    borrowing(okEdits).map((e) => path.basename(e.file_path)).join(',') || '3/3',
  )
  const soloFile = plant('i1-solo.mjs', 'i1')
  const solo = await run({ file_path: soloFile, hunks: [hunkOf('i1')] })
  const soloText = solo.isError ? `ERROR ${solo.code}: ${solo.text}` : solo.text
  const strip = (t) => String(t).split(soloFile).join('<P>').split(okFiles[0]).join('<P>')
  /**
   * 0.8.1：回执开始带新句柄；句柄的 4 位身份标签来自文件账本键（这里两个临时文件路径不同）。
   * 只归一这 4 位，指纹与行号仍逐字比 —— 它不是渲染分叉，是“不同文件”这一事实。
   */
  const stripHandleId = (t) => String(t).replace(/h[0-9a-f]{4}[0-9a-f]{8}:/g, 'h<id>:')
  check(
    soloText.length > 0 && strip(stripHandleId(okEdits[0]?.text ?? '')) === strip(stripHandleId(soloText)),
    'I1d 逐项正文 == 同一个 hunk 单发一次的单目标正文（逐字节，路径与句柄身份标签除外）',
    `multi=${JSON.stringify(strip(okEdits[0]?.text ?? ''))} single=${JSON.stringify(strip(soloText))}`,
  )

  // ── I2 半批：一项落地 + 一项写阶段被拒（真能同时出现的“一项成、一项不成”）──
  const landFile = plant('i2-land.mjs', 'i2')
  const refuseFile = plant('i2-refuse.mjs', 'i2')
  const refuseBefore = fs.readFileSync(refuseFile)
  const refusingFs = makeFs()
  const innerWrite = refusingFs.writeText
  refusingFs.writeText = async (t, content, expected, signal, policy) => {
    if (t.targetKey === refuseFile) throw Object.assign(new Error('write refused by the sandbox'), { code: 'FS_WRITE_DENIED' })
    return innerWrite(t, content, expected, signal, policy)
  }
  const mixed = await run(
    {
      targets: [
        { file_path: landFile, hunks: [hunkOf('i2')] },
        { file_path: refuseFile, hunks: [hunkOf('i2')] },
      ],
    },
    refusingFs,
  )
  const mixedEdits = mixed.value?.edits ?? []
  const landedItem = mixedEdits.find((e) => e.file_path === landFile)
  const failedItem = mixedEdits.find((e) => e.file_path === refuseFile)
  check(
    landedItem?.landed === true && failedItem?.landed === false,
    'I2 夹具成立：半批（一项落地、一项没落地）',
    `landed=${JSON.stringify(mixed.value?.landed_paths)} not_landed=${JSON.stringify(mixed.value?.not_landed_paths)}`,
  )
  check(
    !NO_WRITE.test(landedItem?.text ?? '') && !placeholders([landedItem?.text ?? '']).length,
    'I2a 落地那项的正文是成功正文（不说没写盘，也不带占位符）',
    JSON.stringify(String(landedItem?.text ?? '').split('\n')[0]),
  )
  check(
    NO_WRITE.test(failedItem?.text ?? '') && !/hunk\(s\) applied/.test(failedItem?.text ?? ''),
    'I2b 没落地那项的正文说清“没写盘”，且不冒领兄弟项的正文',
    JSON.stringify(String(failedItem?.text ?? '').split('\n')[0]),
  )
  check(
    borrowing(mixedEdits).length === 0,
    'I2c 两项各提各的路径：失败项不借成功项的判决，反之亦然',
    borrowing(mixedEdits).map((e) => path.basename(e.file_path)).join(',') || '2/2',
  )
  check(
    String(failedItem?.text ?? '').includes('FS_WRITE_DENIED') && !String(landedItem?.text ?? '').includes('FS_WRITE_DENIED'),
    'I2d 失败项带自己的码，成功项不带（判决没有对调）',
    `failed=${JSON.stringify(String(failedItem?.text ?? '').split('\n').slice(0, 2))}`,
  )
  check(
    JSON.stringify(mixed.value?.landed_paths) === JSON.stringify([landFile]) &&
      JSON.stringify(mixed.value?.not_landed_paths) === JSON.stringify([refuseFile]),
    'I2e 整批仍说清哪些落地：landed_paths / not_landed_paths 各自只点名该点的那一个',
    `landed=${JSON.stringify(mixed.value?.landed_paths)} not_landed=${JSON.stringify(mixed.value?.not_landed_paths)}`,
  )
  check(
    fs.readFileSync(landFile, 'utf8').includes('i2-edited') && fs.readFileSync(refuseFile).equals(refuseBefore),
    'I2f 磁盘与回执一致：落地那个真改了，被拒那个一个字节没动',
    `land=${JSON.stringify(fs.readFileSync(landFile, 'utf8'))}`,
  )

  // ── I3 一项规划失败 ⇒ 整批零写入：两项都说“没写盘”，且各说各的 ──────────
  const fineFile = plant('i3-ok.mjs', 'i3')
  const goneFile = plant('i3-gone.mjs', 'i3')
  const before3 = [fs.readFileSync(fineFile), fs.readFileSync(goneFile)]
  const aborted = await run({
    targets: [
      { file_path: fineFile, hunks: [hunkOf('i3')] },
      { file_path: goneFile, hunks: [{ old: '这段原文根本不在这个文件里ZZZ', replace: 'const gone = 1' }] },
    ],
  })
  const abortedEdits = aborted.value?.edits ?? []
  check(
    abortedEdits.length === 2 && abortedEdits.every((e) => e.landed === false),
    'I3 夹具成立：规划失败 ⇒ 两项都没落地',
    JSON.stringify(abortedEdits.map((e) => [e.outcome, e.landed])),
  )
  check(
    abortedEdits.every((e) => NO_WRITE.test(e.text)),
    'I3a 两项正文都说清“没写盘”（这一批真的一字未写）',
    show(abortedEdits.filter((e) => !NO_WRITE.test(e.text)).map((e) => e.text)) || '2/2',
  )
  check(
    borrowing(abortedEdits).length === 0,
    'I3b 两项各提各的路径（没动的那项不许借失败项的消息）',
    borrowing(abortedEdits).map((e) => path.basename(e.file_path)).join(',') || '2/2',
  )
  const untouched = abortedEdits.find((e) => e.file_path === fineFile)
  check(
    !/PATCH_/.test(String(untouched?.text ?? '')),
    'I3c “同批另一项没规划成”那一项不带任何引擎判决码（它不是失败项，是整批零写入的受牵连者）',
    JSON.stringify(String(untouched?.text ?? '').split('\n').slice(0, 2)),
  )
  check(
    (aborted.value?.landed_paths ?? []).length === 0 && String(aborted.value?.summary ?? '').includes('no files were changed'),
    'I3d 整批明说一个文件都没改',
    String(aborted.value?.summary),
  )
  check(
    fs.readFileSync(fineFile).equals(before3[0]) && fs.readFileSync(goneFile).equals(before3[1]),
    'I3e 磁盘一个字节没动',
  )

  // ── I4 半批：一项 applied + 一项 already_applied（两者都不许借对方的句子）──
  const freshFile = plant('i4-applied.mjs', 'i4')
  const doneFile = path.join(tmp, 'i4-done.mjs')
  fs.writeFileSync(doneFile, ['function alpha() {', '  const n = 42;', '  return n;', '}', ''].join('\n'))
  const doneBefore = fs.readFileSync(doneFile)
  const already = await run({
    targets: [
      { file_path: freshFile, hunks: [hunkOf('i4')] },
      { file_path: doneFile, hunks: [{ old: '  const n = 1;', replace: '  const n = 42;' }] },
    ],
  })
  const alreadyEdits = already.value?.edits ?? []
  const appliedItem = alreadyEdits.find((e) => e.file_path === freshFile)
  const doneItem = alreadyEdits.find((e) => e.file_path === doneFile)
  check(
    appliedItem?.landed === true && doneItem?.outcome === 'already_applied' && doneItem?.landed === false,
    'I4 夹具成立：一项 applied、一项 already_applied（都没走错支）',
    JSON.stringify(alreadyEdits.map((e) => [e.outcome, e.landed])),
  )
  check(
    !NO_WRITE.test(appliedItem?.text ?? ''),
    'I4a applied 那项：正文是成功正文，不借 already_applied 那句“没写盘”',
    JSON.stringify(String(appliedItem?.text ?? '').split('\n')[0]),
  )
  check(
    NO_WRITE.test(doneItem?.text ?? '') && String(doneItem?.text ?? '').includes('already_applied') && String(doneItem?.text ?? '').includes('already-applied'),
    'I4b already_applied 那项：正文说“没写盘”且带上“结果已经在那儿”的逐行证据',
    JSON.stringify(String(doneItem?.text ?? '').split('\n').slice(0, 2)),
  )
  check(
    placeholders(alreadyEdits.map((e) => e.text)).length === 0 && borrowing(alreadyEdits).length === 0,
    'I4c 两项正文都没有 undefined / null，也没提对方的路径',
    show(placeholders(alreadyEdits.map((e) => e.text))) || '2/2',
  )
  check(
    fs.readFileSync(doneFile).equals(doneBefore) && fs.readFileSync(freshFile, 'utf8').includes('i4-edited'),
    'I4d 磁盘与回执一致：already_applied 那个一字未动，applied 那个真改了',
  )

  // ── I5 半批：一项可改 + 一项歧义（needs_choice，整批零写入）─────────────
  const ncFile = plant('i5-ok.mjs', 'i5')
  const ambFile = path.join(tmp, 'i5-amb.mjs')
  fs.writeFileSync(ambFile, 'const dup = 1\nconst dup = 1\n')
  const nc = await run({
    targets: [
      { file_path: ncFile, hunks: [hunkOf('i5')] },
      { file_path: ambFile, hunks: [{ old: 'const dup = 1', replace: 'const dup = 2' }] },
    ],
  })
  const ncEdits = nc.value?.edits ?? []
  const ambItem = ncEdits.find((e) => e.file_path === ambFile)
  check(
    nc.value?.outcome === 'needs_choice' && ncEdits.every((e) => e.landed === false),
    'I5 整批判决 = needs_choice，且两项都没落地',
    `${JSON.stringify(nc.value?.outcome)} ${JSON.stringify(ncEdits.map((e) => e.landed))}`,
  )
  check(
    NO_WRITE.test(ambItem?.text ?? '') && String(ambItem?.text ?? '').includes('PATCH_AMBIGUOUS'),
    'I5a 歧义那项：正文按失败口径说，并带上自己的码',
    JSON.stringify(String(ambItem?.text ?? '').split('\n')[0]),
  )
  check(
    /line 1/.test(String(ambItem?.text ?? '')) && /line 2/.test(String(ambItem?.text ?? '')),
    'I5b 两处候选都在正文里（模型看得见该挑哪一处）',
    JSON.stringify(String(ambItem?.text ?? '').split('\n').slice(1, 4)),
  )
  check(
    placeholders(ncEdits.map((e) => e.text)).length === 0 && borrowing(ncEdits).length === 0,
    'I5c 两项正文都没有 undefined / null，也没提对方的路径',
    show(placeholders(ncEdits.map((e) => e.text))) || '2/2',
  )

  // ── I6 预演：正文必须是单目标那一句（缺陷原样就印在这一格上）────────────
  const dryFiles = ['i6-a.mjs', 'i6-b.mjs'].map((name) => plant(name, 'i6'))
  const dryBefore = dryFiles.map((file) => fs.readFileSync(file))
  const dry = await run({ dry_run: true, targets: dryFiles.map((file) => ({ file_path: file, hunks: [hunkOf('i6')] })) })
  const dryEdits = dry.value?.edits ?? []
  check(
    dryEdits.length === 2 && dryEdits.every((e) => e.landed === false && NO_WRITE.test(e.text)),
    'I6 预演：每一项都 landed=false 且说清“没写盘”',
    JSON.stringify(dryEdits.map((e) => [e.outcome, e.landed])),
  )
  check(
    dryEdits.every((e) => e.text.startsWith(`Dry run for ${e.file_path} — every hunk matched`)),
    'I6a 预演正文就是单目标那一句（同一个渲染器，不是另写一套）',
    show(dryEdits.map((e) => e.text)),
  )
  check(
    placeholders([...dryEdits.map((e) => e.text), String(dry.text)]).length === 0,
    'I6b 预演正文里没有 undefined / null（这正是缺陷原样的那一格）',
    show(placeholders([...dryEdits.map((e) => e.text), String(dry.text)])) || '2/2 + 整批',
  )
  check(
    dryFiles.every((file, i) => fs.readFileSync(file).equals(dryBefore[i])),
    'I6c 预演一个字节都没写',
  )

  // ── I7 另一头：写**已经落地**、只是回读校验没通过 ⇒ 不许再说“没写盘”──────
  const okFile = plant('i7-ok.mjs', 'i7')
  const victimFile = plant('i7-victim.mjs', 'i7')
  const corruptFs = makeFs()
  const innerRange = corruptFs.readByteRange
  corruptFs.readByteRange = async (t, r) =>
    t.targetKey === victimFile ? Buffer.from('CORRUPTED-READBACK', 'utf8') : innerRange(t, r)
  const ver = await run(
    {
      targets: [
        { file_path: okFile, hunks: [hunkOf('i7')] },
        { file_path: victimFile, hunks: [hunkOf('i7')] },
      ],
    },
    corruptFs,
  )
  const verEdits = ver.value?.edits ?? []
  const victim = verEdits.find((e) => e.file_path === victimFile)
  check(
    victim?.landed === true && victim?.outcome === 'failed',
    'I7 夹具成立：阶段三回读校验失败 ⇒ 该项 landed=true 但 outcome=failed',
    JSON.stringify(verEdits.map((e) => [e.outcome, e.landed])),
  )
  check(
    fs.readFileSync(victimFile, 'utf8').includes('i7-edited'),
    'I7a 磁盘核对：那一项的文件**真的被改了**（所以“没写盘”是假话）',
    JSON.stringify(fs.readFileSync(victimFile, 'utf8')),
  )
  check(
    !NO_WRITE.test(victim?.text ?? '') && String(victim?.text ?? '').includes('the write landed'),
    'I7b landed=true 的项，正文不说“nothing was written”，而是明说写入已落地、只是没验成',
    JSON.stringify(String(victim?.text ?? '').split('\n')[0]),
  )
  check(
    placeholders(verEdits.map((e) => e.text)).length === 0 && borrowing(verEdits).length === 0,
    'I7c 两项正文都没有 undefined / null，也没提对方的路径',
    show(placeholders(verEdits.map((e) => e.text))) || '2/2',
  )
}

// ════════════════════════════════════════════════════════════════════════════
fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- 结果：${results.length - failed.length}/${results.length} 通过 ---`)
for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
