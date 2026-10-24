/**
 * outcome-test —— fs-contract-v2 的验收套件（读侧）：**失败通道分成两条，且不许串线**。
 *
 * 与写侧（`aura-edit/outcome-test.mjs`）同一份契约、同一组取值：
 *   · 「工具判定不出调用方意图」⇒ **正常结果**，回执带三态 `outcome`：
 *       applied（按你的意图读到了）| needs_choice（你指的头部在多处都能对上）| not_found（文件里没有那一处）
 *   · 工具级故障 ⇒ 仍然抛错（isError=true）：文件不存在、IO/解码错误、沙箱拒绝、参数面没成形
 *
 * 读侧的失败在本次改动前**全部**走抛错，而框架对抛出的错误只取 `error.message`
 * （`dsh-tools/lib/index.js` 的 errorMessage）——于是 `READ_AMBIGUOUS` 里引擎辛苦算出的
 * 候选行，模型一个也没看到。这是本套件段A3 要钉住的那件事。
 *
 * 段A 三类可判定失败（范围非法 / 找不到 / 歧义）→ isError=false，outcome 正确，候选可见
 * 段B 工具级故障与参数形状错误 → isError=true（不许被降级成"结果"）
 * 段C outcome 在 output.schema 声明，且与 `PASSTHROUGH_FIELDS` 的对应关系没断
 *
 * 段A/段B 互为反向对照：只断言"这条不抛"的话，一个把什么都吞掉的实现也能全绿。
 *
 * 跑法：`node src/aura-read/outcome-test.mjs`，全绿 exit 0。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
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
 * **结构下限**校验（永远跑）：返回字段必须已声明、必填必须在场、enum 取值合法。
 * 这是真校验器的子集——本工具被"漏声明返回字段 ⇒ 每条成功路径被框架拒"咬过四次，
 * 而那一类不需要完整的 JSON Schema 语义就能判。真校验器在场时两个都跑。
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

// ── mock ctx：与真实 Cordis 上下文同形 ────────────────────────────────────────
const tmp = path.join(os.tmpdir(), `aura-read-outcome-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })

const makeFs = (fail = {}) => {
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
      return { type: 'file', version: `v1:${st.size}`, size: st.size }
    },
    readText: async (t) => {
      boom(fail.readText)
      return fs.readFileSync(t.targetKey, 'utf8')
    },
    readByteRange: async (t, r) => fs.readFileSync(t.targetKey).subarray(r.offset, r.offset + r.length),
  }
}

/** ctx 只 apply 一次，fs 后端可换（同写侧套件：重注册会让手里的 tool 指向另一个闭包）。 */
let registered = null
const holder = { fs: makeFs() }
plugin.apply({
  get fs() {
    return holder.fs
  },
  ...contextServices(),
  tools: { register: (t) => (registered = t), get: () => undefined },
  systemPrompt: { section: () => () => {} },
  emit: () => {},
})
const tool = registered
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

/**
 * 像框架那样跑一次调用：抛错 ⇒ isError（只取 message）；返回 ⇒ 过 output.schema 再渲染。
 * 本套件断言的就是这个分叉，所以这里必须有一份同形的实现。
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

const SRC = [
  'export function alpha() {',
  '  const n = 1',
  '  return n',
  '}',
  '',
  'export function beta() {',
  '  return 2',
  '}',
  '',
].join('\n')
const FILE = path.join(tmp, 'sample.js')
fs.writeFileSync(FILE, SRC, 'utf8')
const PLAIN = path.join(tmp, 'note.zzz')
fs.writeFileSync(PLAIN, 'plain text\nsecond line\n', 'utf8')

// ════════════════════════════════════════════════════════════════════════════
say('=== A. 三类可判定失败：isError=false，outcome 正确，候选可见 ===')
{
  const cases = [
    { label: 'A1 范围非法（start < 1）', args: { mode: 'lines', lines: [0, 0] }, outcome: 'not_found' },
    { label: 'A2 范围非法（越界）', args: { mode: 'lines', lines: [99, 99] }, outcome: 'not_found' },
    { label: 'A3 找不到（around 既不是符号也不是任何一行）', args: { mode: 'around', around: 'ZZZ_不存在的东西' }, outcome: 'not_found' },
    { label: 'A4 歧义（around 在多行都出现）', args: { mode: 'around', around: 'return' }, outcome: 'needs_choice' },
  ]
  for (const c of cases) {
    const r = await run({ file_path: FILE, ...c.args })
    check(!r.isError, `${c.label} ⇒ 不抛错（isError=false）`, r.isError ? `抛了：${r.code} ${r.text.slice(0, 60)}` : '')
    check(
      r.value?.outcome === c.outcome,
      `${c.label} ⇒ outcome=${c.outcome}`,
      `实际 ${JSON.stringify(r.value?.outcome)} code=${r.value?.code}`,
    )
    check(typeof r.value?.code === 'string' && r.value.code.length > 0, `${c.label} ⇒ 带回引擎判决码`, `code=${JSON.stringify(r.value?.code)}`)
    check(typeof r.value?.next === 'string' && r.value.next.length > 0, `${c.label} ⇒ 带下一步（next）`, String(r.value?.next).slice(0, 50))
    check(typeof r.value?.text === 'string' && r.value.text.length > 0, `${c.label} ⇒ 有给模型看的正文`, '')
    check(r.violations.length === 0, `${c.label} ⇒ 回执合 output.schema（不许凭空多字段）`, r.violations.slice(0, 2).join('; '))
  }

  // 歧义必须把候选行**结构化**带回来——以前它们被拼进 message 字符串，模型看不到
  const amb = await run({ file_path: FILE, mode: 'around', around: 'return' })
  check(
    Array.isArray(amb.value?.candidates) && amb.value.candidates.length >= 2,
    'A4 ⇒ needs_choice 必须附候选行',
    JSON.stringify(amb.value?.candidates),
  )
  check(
    (amb.value?.candidates ?? []).every((c) => Number.isInteger(c.line)),
    'A4 ⇒ 候选形状为 {line, text?}',
    JSON.stringify(amb.value?.candidates?.slice(0, 2)),
  )
  check(/line \d+/.test(amb.text), 'A4 ⇒ 候选行也出现在给模型看的正文里（这正是改动前丢掉的东西）', amb.text.split('\n').slice(0, 3).join(' / '))
  check(/needs_choice|READ_AMBIGUOUS/.test(amb.text), 'A4 ⇒ 正文里能看出是哪一类判决', amb.text.split('\n')[0].slice(0, 90))

  // 成功路径也要带 outcome：调用方只看一个字段就能决定能不能用这份回执
  const ok = await run({ file_path: FILE, mode: 'full' })
  check(ok.value?.outcome === 'applied', 'A5 成功读取 ⇒ outcome=applied', JSON.stringify(ok.value?.outcome))
  check(Number.isInteger(ok.value?.totalLines), 'A5 成功路径仍给 totalLines', JSON.stringify(ok.value?.totalLines))
  check(ok.violations.length === 0, 'A5 ⇒ 成功回执仍合 schema', ok.violations.slice(0, 2).join('; '))

  // 未索引扩展名上同样成立（自动降级到 full）
  const plain = await run({ file_path: PLAIN, start_line: 99, end_line: 99 })
  check(!plain.isError && plain.value?.outcome === 'not_found', 'A6 未索引扩展名上的越界同样走结果', `${plain.isError ? plain.code : plain.value?.outcome}`)
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== B. 工具级故障与参数形状错误：必须仍然抛错 ===')
{
  const missing = await run({ file_path: path.join(tmp, 'nope.js'), mode: 'map' })
  check(missing.isError && /not found/.test(String(missing.text)), 'B1 文件不存在 ⇒ 抛错（isError=true）', missing.isError ? String(missing.text).slice(0, 60) : `被降级成 ${JSON.stringify(missing.value?.outcome)}`)

  const io = await run({ file_path: FILE, mode: 'full' }, makeFs({ readText: { code: 'FS_IO_ERROR', message: 'EIO: i/o error, read' } }))
  check(io.isError && io.code === 'FS_IO_ERROR', 'B2 读盘 IO 错误 ⇒ 抛错', io.isError ? `code=${io.code}` : '被降级成了结果')

  const denied = await run(
    { file_path: FILE, mode: 'full' },
    makeFs({ resolve: { code: 'FS_PERMISSION_DENIED', message: 'file access denied under read-only mode' } }),
  )
  check(denied.isError && denied.code === 'FS_PERMISSION_DENIED', 'B3 沙箱拒绝 ⇒ 抛错', denied.isError ? `code=${denied.code}` : '被降级成了结果')

  // 参数面没成形：与"文件里没有那一处"是两件事，混为一谈会让模型去换地址而不是补参数
  const badMode = await run({ file_path: FILE, mode: 'nope' })
  check(badMode.isError && /READ_BAD_MODE/.test(String(badMode.text)), 'B4 未知 mode ⇒ 抛错（参数面，不是意图面）', badMode.isError ? String(badMode.text).slice(0, 50) : '被降级成了结果')
  const noRange = await run({ file_path: FILE, mode: 'lines' })
  check(noRange.isError && /READ_NO_RANGE/.test(String(noRange.text)), 'B5 mode=lines 却没给区间 ⇒ 抛错（缺参数）', noRange.isError ? String(noRange.text).slice(0, 50) : '被降级成了结果')
  const noQuery = await run({ file_path: FILE, mode: 'search' })
  check(noQuery.isError && /READ_NO_QUERY/.test(String(noQuery.text)), 'B6 mode=search 却没给关键词 ⇒ 抛错（缺参数）', noQuery.isError ? String(noQuery.text).slice(0, 50) : '被降级成了结果')
  const unknown = await run({ file_path: FILE, mod: 'map' })
  check(unknown.isError && unknown.code === 'ARGS_UNKNOWN_KEY', 'B7 拼错的参数名 ⇒ 运行期守卫抛错', unknown.isError ? `code=${unknown.code}` : '被降级成了结果')
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== C. outcome 在 output schema 里声明，且与 PASSTHROUGH_FIELDS 的对应关系没断 ===')
{
  const out = tool.output.schema
  check(Object.hasOwn(out.properties ?? {}, 'outcome'), 'C1 output.schema 声明了 outcome')
  check(
    JSON.stringify(out.properties?.outcome?.enum) === JSON.stringify(['applied', 'needs_choice', 'not_found']),
    'C2 三态取值与契约一致',
    JSON.stringify(out.properties?.outcome?.enum),
  )
  check((out.required ?? []).includes('outcome'), 'C3 outcome 是必填（成功路径也必须给）', `required=${JSON.stringify(out.required)}`)
  check(out.additionalProperties === false, 'C4 output.schema 仍是 additionalProperties:false（没被放松）')
  check(!Object.hasOwn(out.properties ?? {}, 'outcome_typo'), 'C5 对照：编造的字段不在声明里')
  /**
   * C6 是**接缝**：`aura-read-schema-test` 断言"schema 声明的可选字段 ≡ PASSTHROUGH_FIELDS"。
   * 失败通道新增的三个字段（outcome/code/candidates）必须在那份名单里，否则那条断言会变红，
   * 而红的原因是"两份名单漂了"——不是新字段错了。这里先把它钉住，省一轮排查。
   */
  const mandatory = ['path', 'mode', 'totalLines', 'text']
  const declaredOptional = Object.keys(out.properties ?? {})
    .filter((k) => !mandatory.includes(k))
    .sort()
  check(
    JSON.stringify(declaredOptional) === JSON.stringify([...plugin.PASSTHROUGH_FIELDS].sort()),
    'C6 schema 声明的可选字段 ≡ PASSTHROUGH_FIELDS（接缝没断）',
    `schema=[${declaredOptional}] passthrough=[${[...plugin.PASSTHROUGH_FIELDS].sort()}]`,
  )
  check(
    ['outcome', 'code', 'candidates'].every((k) => plugin.PASSTHROUGH_FIELDS.includes(k)),
    'C7 失败通道的三个字段都在名单里',
    plugin.PASSTHROUGH_FIELDS.join(','),
  )
}

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== D. 句柄字段：读侧新字段不会被壳层丢掉，也不会把回执整条顶掉 ===')
{
  /**
   * 波H 的读侧句柄落在引擎 `windowEnvelope` 那一层（与 `shown` / `relocatable` 同级，
   * HD1 负责发）。壳层这里要证的恰好是**两件它自己的事**：
   *   · 透传是白名单（`ship()` 只从 `PASSTHROUGH_FIELDS` 取键）⇒ 名单漏一个键，句柄会**静默消失**；
   *   · schema 是 `additionalProperties:false` ⇒ 声明漏一个键，整条回执被 `INVALID_TOOL_OUTPUT`
   *     顶掉，模型连文字都看不到（本工具已经因此出过四次事故）。
   *
   * 三个字段（`handle` 单值 / `handles` 逐命中 / `handlesOmitted` 只报数）已随 HD1 一起落地，
   * 壳层只做一件事：把它们的形状**声明对**，并让透传白名单与 schema 两份名单逐字一致。
   */
  const out = tool.output.schema
  const props = out.properties ?? {}
  const mandatory = ['path', 'mode', 'totalLines', 'text']
  for (const key of ['handle', 'handles', 'handlesOmitted']) {
    check(Object.hasOwn(props, key), `D1 output.schema 声明了 ${key}（漏声明 ⇒ 回执被 INVALID_TOOL_OUTPUT 整条顶掉）`)
    check(plugin.PASSTHROUGH_FIELDS.includes(key), `D2 ${key} 在 PASSTHROUGH_FIELDS 里（漏了会静默丢掉句柄）`)
  }
  // 形状必须与引擎实际发的一致（HD1 的 `read-core.mjs`：handle 是字符串、handles 是 {line,handle} 数组）
  check(
    props.handles?.items?.properties?.handle?.type === 'string' && props.handles?.items?.properties?.line?.type === 'integer',
    'D2b handles 的元素形状 = {line, handle}（与 `relocatable` 同形）',
    JSON.stringify(props.handles?.items?.properties),
  )
  check(
    JSON.stringify(Object.keys(props).filter((k) => !mandatory.includes(k)).sort()) === JSON.stringify([...plugin.PASSTHROUGH_FIELDS].sort()),
    'D3 接缝仍没断：schema 的可选字段 ≡ PASSTHROUGH_FIELDS（两份名单逐字一致）',
    `schema=${Object.keys(props).filter((k) => !mandatory.includes(k)).sort()}`,
  )
  // D4 行为：引擎真发了这两个字段时，回执必须仍然合 schema（这正是四次事故的形态）
  const real = await run({ file_path: FILE, mode: 'full' })
  const withHandles = {
    ...real.value,
    handle: 'h9f3ac1b2e4d5:1-10',
    handles: [
      { line: 1, handle: 'h9f3ac1b2e4d5:1-1' },
      { line: 2, handle: 'h9f3ac1b2e4d5:2-2' },
    ],
    handlesOmitted: { total: 7, emitted: 2, max: 20, reason: 'handles are capped at 20 per receipt' },
  }
  const violations = [...declaredViolations(out, withHandles), ...realViolations(out, withHandles)]
  check(violations.length === 0, 'D4 带 handle / handles 的成功回执仍合 schema（声明与实际同形）', violations.slice(0, 2).join('; '))
  // 反向对照：没声明过的字段仍旧拒（证明 D1/D4 不是恒真）
  check(
    declaredViolations(out, { ...real.value, handle_typo: 'x' }).length > 0,
    'D5 反向对照：编造的句柄字段名仍被拒（additionalProperties:false 没被放松）',
  )
  /**
   * D6 红线：句柄**不许**被搬进 `renderEnvelope` 的正文。
   *
   * 正文是宿主剪枝器真正量的东西（契约 §2 不变式 5 / §4），句柄只进结构化字段。
   * 这一条盯的是源码本身：`renderEnvelope` 的函数体里不得出现句柄相关标识符。
   */
  const selfSrc = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const at = selfSrc.indexOf('function renderEnvelope(env)')
  const body = selfSrc.slice(at, selfSrc.indexOf('\n}\n', at))
  check(at > 0, 'D6 找到 renderEnvelope 源码段（这条断言不是空的）', `at=${at}`)
  check(!/handle/i.test(body), 'D6 renderEnvelope 正文里没有句柄（壳层不把句柄搬进渲染）', body.match(/.{0,40}handle.{0,40}/i)?.[0] ?? '')
}

/**
 * 段E —— 多目标（fs-contract-v2 §2.1 / MT4 壳层）。
 *
 * 四条要钉的事：
 *   1. 逐项 outcome 正确、**顺序 = 输入序**（即使完成顺序是反的）；
 *   2. 一条不存在 ⇒ 其余照常且整批 `isError=false`（失败走结果通道，参数面错才抛）；
 *   3. 汇总行出现且在**结构化字段**里，不进正文 body；
 *   4. 逐项正文就是**单目标那套渲染**的输出，而单目标回执本身没多出任何多目标字段。
 *
 * 完成顺序是故意反转的：若壳层（或引擎）按完成顺序装配，E4 必须变红——这是这条断言的反向对照。
 */
say('')
say('=== 段E 多目标：逐项回执 + 顺序 = 输入序 + 一条失败不废整批 ===')
{
  const rel = (name) => path.join(tmp, name)
  const A = rel('mt-a.mjs')
  const B = rel('mt-b.mjs')
  const C = rel('mt-c.mjs')
  const GONE = rel('mt-gone.mjs')
  fs.rmSync(GONE, { force: true })
  fs.writeFileSync(A, 'export const alpha = 1\nexport const gamma = 3\n')
  fs.writeFileSync(B, 'export const beta = 2\n')
  fs.writeFileSync(C, 'export const delta = 4\nexport const epsilon = 5\nexport const zeta = 6\n')

  /** 完成顺序与输入顺序**相反**的后端（第一个目标最慢）：顺序断言因此不是恒真的。 */
  const finishes = []
  const inner = makeFs()
  const reversedFs = {
    ...inner,
    resolve: async (p, opts) => {
      const target = await inner.resolve(p, opts)
      const wait = target.displayPath.endsWith('mt-a.mjs') ? 30 : target.displayPath.endsWith('mt-b.mjs') ? 15 : 0
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      finishes.push(path.basename(target.displayPath))
      return target
    },
  }
  const targets = [
    { file_path: A, mode: 'lines', lines: [1, 1] },
    { file_path: B, mode: 'digest' },
    { file_path: C, mode: 'full' },
  ]
  const batch = await run({ targets }, reversedFs)
  check(!batch.isError, 'E1 多目标走结果通道（isError=false）', batch.isError ? batch.text.slice(0, 80) : '')
  check(
    batch.violations.length === 0,
    'E1b 整批回执合 output.schema（additionalProperties:false 没把它整条顶掉）',
    batch.violations.slice(0, 2).join('; '),
  )
  check(
    batch.value?.targets === 3 && batch.value?.entries?.length === 3,
    'E2 三条逐项回执都在',
    `targets=${batch.value?.targets} entries=${batch.value?.entries?.length}`,
  )
  check(
    batch.value?.entries?.map((e) => e.outcome).join(',') === 'applied,applied,applied',
    'E3 逐项 outcome 正确（全 applied）',
    String(batch.value?.entries?.map((e) => e.outcome)),
  )
  check(
    batch.value?.entries?.map((e) => e.file_path).join('|') === [A, B, C].join('|'),
    'E4 **顺序 = 输入序**（不是完成顺序）',
    String(batch.value?.entries?.map((e) => e.file_path)),
  )
  check(
    finishes.length === 3 && finishes[0] !== 'mt-a.mjs',
    'E4b 反向对照：完成顺序确实是反的（证明 E4 不是恒真）',
    finishes.join(','),
  )
  check(
    typeof batch.value?.summary === 'string' && batch.value.summary.startsWith('targets: 3'),
    'E5 汇总行出现（结构化 summary 字段）',
    String(batch.value?.summary),
  )
  check(
    !batch.text.includes(batch.value.summary),
    'E5b 汇总行**不进**正文 body（正文是宿主剪枝器量的东西）',
  )
  /**
   * 逐项正文与单目标正文的比对。
   *
   * **分两种模式比**，因为句柄（`<h…:1-1>`）不在壳层可控范围内：
   *   · 不发句柄的模式（`digest`）⇒ 断**逐字节相同**（同一个 `renderEnvelope`、同一份信封）；
   *   · 发句柄的模式（`lines`）⇒ 掩掉 `<h…>` 后逐字节相同，并把两个句柄 id 原样打进读数。
   *     实测（2026-10-16 00:47）：同一个文件、同一区间，两条路给出的句柄 id **不同**
   *     （`h4745015d4840` vs `he6dd015d4840`）——句柄 id 的构成（是否吃 `identityKey`、
   *     或是否带调用路径）在 `read-core.mjs` / `handle-core.mjs`，不在壳层；这里只如实记录。
   */
  const stripHandles = (text) => text.replace(/<h[0-9a-f]+:\d+-\d+>/g, '<h…>')
  const soloB = await run(targets[1])
  check(
    batch.value?.entries?.[1]?.text === soloB.text,
    'E6 不发句柄的模式（digest）逐项正文与单目标**逐字节相同**（同一个渲染器）',
    batch.value?.entries?.[1]?.text === soloB.text
      ? ''
      : `batch=${JSON.stringify(String(batch.value?.entries?.[1]?.text).slice(0, 60))} solo=${JSON.stringify(soloB.text.slice(0, 60))}`,
  )
  const soloA = await run(targets[0])
  const itemText = String(batch.value?.entries?.[0]?.text ?? '')
  const maskedEqual = stripHandles(itemText) === stripHandles(soloA.text)
  check(
    maskedEqual,
    'E6b 发句柄的模式（lines）掩掉 `<h…>` 后逐字节相同（差异只在句柄 id）',
    maskedEqual
      ? `batch=${itemText.match(/<h[0-9a-f]+:\d+-\d+>/)?.[0]} solo=${soloA.text.match(/<h[0-9a-f]+:\d+-\d+>/)?.[0]}`
      : `batch=${JSON.stringify(itemText.slice(60, 120))} solo=${JSON.stringify(soloA.text.slice(60, 120))}`,
  )
  check(
    batch.text.includes(`${A} — applied`) &&
      batch.text.includes(`${B} — applied`) &&
      batch.text.includes(String(batch.value?.entries?.[1]?.text)),
    'E6c 整批正文里每一项都带自己的抬头（N 段正文认得出归属）',
  )

  const mixed = await run({
    targets: [
      { file_path: A, mode: 'digest' },
      { file_path: GONE, mode: 'digest' },
      { file_path: C, mode: 'digest' },
    ],
  })
  check(!mixed.isError, 'E7 一条不存在 ⇒ 整批仍 isError=false（失败走结果通道）')
  check(
    mixed.value?.entries?.map((e) => e.ok).join(',') === 'true,false,true',
    'E8 失败项逐项标出，其余照常',
    String(mixed.value?.entries?.map((e) => e.ok)),
  )
  check(
    mixed.value?.entries?.[1]?.outcome === 'failed' && mixed.value?.entries?.[1]?.code === 'FS_NOT_FOUND',
    'E9 失败项带 outcome 与码',
    `${mixed.value?.entries?.[1]?.outcome}/${mixed.value?.entries?.[1]?.code}`,
  )
  check(
    mixed.value?.summary === 'targets: 3 ｜ ok 2 ｜ not_found 1',
    'E10 汇总行按逐项现算',
    String(mixed.value?.summary),
  )
  check(/not found/.test(String(mixed.value?.entries?.[1]?.text)), 'E11 失败项正文说清为什么')

  const both = await run({ file_path: A, mode: 'digest', targets: [{ file_path: B, mode: 'digest' }] })
  check(
    both.isError && both.code === 'ARGS_SHAPE_EXCLUSIVE' && /not both/.test(both.text),
    'E12 `targets` 与 `file_path` 同时给 ⇒ 参数面抛错，说清二选一',
    `${both.code}: ${both.text.slice(0, 90)}`,
  )
  const tooMany = await run({ targets: Array.from({ length: 33 }, () => ({ file_path: A, mode: 'digest' })) })
  check(
    tooMany.isError && tooMany.code === 'ARGS_TARGETS_LIMIT' && tooMany.text.includes('33'),
    'E13 超上限（32）⇒ 参数面拒绝并报出实得数',
    `${tooMany.code}: ${tooMany.text.slice(0, 90)}`,
  )
  const empty = await run({ targets: [] })
  check(
    empty.isError && empty.code === 'ARGS_TARGETS_SHAPE',
    'E14 空 `targets` ⇒ 参数面抛错（空批不是“成功读了 0 个”）',
    `${empty.code}: ${empty.text.slice(0, 70)}`,
  )
  const notArray = await run({ targets: A })
  check(
    notArray.isError && (notArray.code === 'INVALID_ARGS' || notArray.code === 'ARGS_TARGETS_SHAPE'),
    'E14b `targets` 不是数组 ⇒ 参数面拒（声明的形状就是数组）',
    `${notArray.code}: ${notArray.text.slice(0, 70)}`,
  )

  const solo = await run({ file_path: A, mode: 'digest' })
  check(
    !solo.isError &&
      solo.value?.outcome === 'applied' &&
      !('targets' in solo.value) &&
      !('summary' in solo.value) &&
      !('entries' in solo.value),
    'E15 单目标回执**没多出**任何多目标字段（没有汇总行、没有 entries）— 逐字节不变的那条路',
    Object.keys(solo.value ?? {}).join(','),
  )
}

// ════════════════════════════════════════════════════════════════════════════
fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- 结果：${results.length - failed.length}/${results.length} 通过 ---`)
for (const f of failed) say(`  FAIL: ${f.label}  ${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
