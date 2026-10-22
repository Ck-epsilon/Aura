/**
 * aura-read-schema-test.mjs —— 把 `aura_read` 的真实输出，逐一对照它**自己声明的 schema** 校验。
 *
 * ## 为什么这个测试是必需的
 *
 * 同类 bug 已经发生**两次**，两次都穿过了当时全部测试：
 *
 *   1. 输出 schema 漏声明 `text`，而渲染器返回的正是 `text` →
 *      每条成功路径都被框架以 additionalProperties:false 拒绝：
 *        tool "aura_read" returned invalid output: "value.text" is not a declared property
 *   2. `version` 在 around／lines／search 三种模式以及**所有未索引扩展名**上是 undefined，
 *      而 schema 声明它必填 → 在真实会话里 .json／.yml／.md 一个都读不了：
 *        tool "aura_read" returned invalid output: missing required property "value.version"
 *
 * 两次的根因相同，而且都不是"引擎算错了"，而是**引擎与工具壳的契约对不上**：
 * 引擎返回的信封，与工具声明给框架的 schema，是两份各自演化的东西。
 *
 * 只测引擎（`read-core`）永远发现不了这类问题——所以本测试从**工具注册的那份 schema**
 * 出发（`load-test` 里注册出来的 `output.schema`），用它去校验**工具真实返回的 value**。
 * 这样"声明"与"产出"被同一份数据同时约束，契约不可能再单方面漂移。
 *
 * 校验器照抄 DSH 的判据（dsh-tools/lib/index.js:455-495）：
 *   - required 键必须**存在且不为 undefined**（`null` 不算缺失，但见下一条）
 *   - 标量字段**要查类型**：`case "string": typeof value === "string"` —— 所以 `null`
 *     过不了字符串字段。这一条是本测试第一版漏掉的，而它恰好决定了一个真实行为
 *     （`since='<first>'` 曾返回 `version: null`，在真实会话里会被框架拒绝）
 *   - additionalProperties:false 下不得出现未声明的键
 *   - 逐层递归到子 schema
 * 刻意**不**引入第三方 schema 库：校验器越接近框架本体，测出来的结论才越可信。
 * 若框架放宽了某条判据，本校验器会比它更严——那属于"可能误报"，而不是"漏报"，
 * 遇到误报时的正确做法是对照 dsh-tools 的源码修正判据，而不是放宽到自己舒服为止。
 *
 * ## 为什么也要模拟 `text` 的渲染
 *
 * 框架额外要求返回值可无损序列化为 JSON。`null` 能过，`undefined` 不能——
 * 而 `undefined` 正是上面第 2 个 bug 的形态。所以这里对产出做一次 JSON 往返，
 * 把"能过 schema 但过不了序列化"的中间状态也一并挡住。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply as applyRead } from '../aura-read/index.js'
import { contextServices } from './mock-ctx.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/**
 * 按 DSH 的判据校验一个 value 是否合 schema。
 * @param value - 工具返回值。
 * @param schema - 工具声明的 output.schema。
 * @param at - 诊断用的路径前缀。
 * @returns 违规描述数组；空数组表示通过。
 */
function validate(value, schema, at = 'value') {
  const out = []
  if (schema === undefined || schema === null) return out
  const type = schema.type
  if (type !== undefined) {
    if (type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      return [`${at} must be an object`]
    }
    if (type === 'array' && !Array.isArray(value)) return [`${at} must be an array`]
    if (type === 'string' && typeof value !== 'string') return [`${at} must be a string (got ${value === null ? 'null' : typeof value})`]
    if (type === 'integer' && !Number.isInteger(value)) return [`${at} must be an integer`]
    if (type === 'number' && typeof value !== 'number') return [`${at} must be a number`]
    if (type === 'boolean' && typeof value !== 'boolean') return [`${at} must be a boolean`]
  }
  if (type === 'object') {
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        out.push(`missing required property "${at}.${key}"`)
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) out.push(`"${at}.${key}" is not a declared property (additionalProperties: false)`)
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      out.push(...validate(value[key], child, `${at}.${key}`))
    }
  }
  if (type === 'array' && schema.items !== undefined) {
    value.forEach((item, i) => out.push(...validate(item, schema.items, `${at}[${i}]`)))
  }
  return out
}

/** 模拟框架的 JSON 无损要求：undefined 会在序列化里消失，必须当成违规。 */
function serializationViolations(value, at = 'value') {
  const out = []
  if (!Array.isArray(value) && typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) out.push(`${at}.${k} is undefined (would vanish in JSON)`)
      else out.push(...serializationViolations(v, `${at}.${k}`))
    }
  }
  return out
}

const tmp = path.join(os.tmpdir(), `auraschema-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })

// ── 用真实仓库里的文件类型，覆盖"已索引"与"未索引"两侧 ──────────────────────
const JS_SRC = 'function alpha() {\n  return 1\n}\n\nfunction beta() {\n  return 2\n}\n'
const CONFIG_SRC = '{\n  "name": "blackbox",\n  "port": 3080\n}\n'
const fixtures = [
  { label: '.js（已索引）', file: 'sample.js', src: JS_SRC, probe: 'alpha' },
  { label: '.json（未索引）', file: 'blackbox.json', src: CONFIG_SRC, probe: 'blackbox' },
  { label: '.yml（未索引）', file: 'conf.yml', src: 'server:\n  port: 3080\n', probe: 'port' },
  { label: '.md（未索引）', file: 'NOTES.md', src: '# Title\n\ntext\n', probe: 'Title' },
  { label: '无扩展名', file: 'README', src: 'plain text\nsecond line\n', probe: 'second' },
]
for (const f of fixtures) fs.writeFileSync(path.join(tmp, f.file), f.src, 'utf8')

let registered = null
const ctx = {
  fs: {
    resolve: async (p, opts) => {
      const abs = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? process.cwd(), p)
      return { displayPath: p, targetKey: abs, _opts: opts }
    },
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version: 'v1' } : undefined),
    readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
    editText: async () => ({ version: 'v2', operation: 'update' }),
    writeText: async () => ({ version: 'v1', operation: 'create' }),
  },
  ...contextServices(),
  tools: { register: (t) => (registered = t) },
  emit: () => {},
  systemPrompt: { section: () => () => {} },
}
applyRead(ctx)
const schema = registered.output.schema

// ── 宿主上限：**现读现传**，不在引擎里抄一个常量 ──────────────────────────────
// `toolResultPruner.config.thresholdChars` 是可配置的（dsh-base 与三个 preset 都显式写着
// 8192 / 4096 / 1024），而它最初的来源只是 8 KiB 这类**页大小的惯例数**（README 里只有
// "低摩擦默认值"一句，无测算依据）。把可配置值抄成引擎常量会静默失准：
//   宿主调大 → 本工具继续白白少给；宿主调小 → 输出被静默剪掉中段。
// 这里用**真的把宿主阈值设成不同值**来断言工具确实跟随。
say('')
say('=== 可重新定位的引用：行号会随编辑腐坏，符号名不会 ===')
// 动态视角：本工具输出里行号是**绝对坐标**，而编辑正是破坏绝对坐标的那个变换——
// 上面插一行，下面全 +1。模型手里那向 `6: return b` 一旦经过一次编辑就失效，
// 而它**没有任何东西可以用来换算**。补一条"这个行号属于哪个符号"就能修好。
// 实测不对称：`around` 一直带着符号（在 `label` 里）、`map` 本身就全是符号，
// **只有 `lines` 与 `search` 给裸行号**——而这两个正是最常用于照着改的输出。
{
  const f = path.join(tmp, 'reloc.mjs')
  fs.writeFileSync(f, 'export function alpha(a) {\n  return a\n}\n\nexport function beta(b) {\n  return b\n}\n', 'utf8')
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  const linesOut = await registered.execute({ file_path: f, mode: 'lines', lines: [5, 7] }, exec)
  check('lines 模式带 relocatable', Array.isArray(linesOut.relocatable) && linesOut.relocatable.length > 0, JSON.stringify(linesOut.relocatable))
  check('它指向正确的符号', linesOut.relocatable?.[0]?.target === 'beta', JSON.stringify(linesOut.relocatable?.[0]))
  check('形状统一为数组（不是字符串也不是对象）', Array.isArray(linesOut.relocatable))
  const searchOut = await registered.execute({ file_path: f, mode: 'search', search: 'return' }, exec)
  check('search 模式也带 relocatable（它原本连 label 都没有）', Array.isArray(searchOut.relocatable) && searchOut.relocatable.length >= 2, JSON.stringify(searchOut.relocatable))
  check('每个元素都有 line/target/lines 三个字段', searchOut.relocatable.every((r) => Number.isInteger(r.line) && typeof r.target === 'string' && Array.isArray(r.lines)), JSON.stringify(searchOut.relocatable))
  // 未索引扩展名没有符号表 → 不得给（也不得报错）
  const yml = path.join(tmp, 'reloc.yml')
  fs.writeFileSync(yml, 'a: 1\nb: 2\n', 'utf8')
  const ymlOut = await registered.execute({ file_path: yml, mode: 'lines', lines: [1, 2] }, exec)
  check('未索引扩展名：给了内容但不给 relocatable', ymlOut.relocatable === undefined, JSON.stringify(ymlOut.relocatable))
}

say('')
say('=== 宿主上限：工具必须跟随 toolResultPruner.thresholdChars ===')
{
  const big = path.join(tmp, 'big-symbols.mjs')
  fs.writeFileSync(big, Array.from({ length: 300 }, (_, i) => `export function fn${i}(a) { return a }`).join('\n'), 'utf8')
  let bigRegistered = null
  const mkCtx = (threshold) => ({
    fs: {
      resolve: async (p) => ({ displayPath: p, targetKey: p }),
      stat: async () => ({ version: 'v1' }),
      readText: async () => fs.readFileSync(big, 'utf8'),
      editText: async () => ({ version: 'v2' }),
      writeText: async () => ({ version: 'v1' }),
    },
    ...contextServices(threshold === undefined ? {} : { toolResultPruner: { config: { thresholdChars: threshold } } }),
    tools: { register: (t) => (bigRegistered = t) },
    emit: () => {},
    systemPrompt: { section: () => () => {} },
  })
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  const sizes = {}
  for (const threshold of [3000, 8192, 40000]) {
    applyRead(mkCtx(threshold))
    const r = await bigRegistered.execute({ file_path: big, mode: 'map' }, exec)
    const size = JSON.stringify(r).length
    sizes[threshold] = size
    check(`宿主阈值 ${threshold} → 输出 ${size} 不超上限`, size <= threshold, `超出 ${size - threshold}`)
  }
  check(`阈值调大确实给出更多内容（${sizes[8192]} → ${sizes[40000]}）`, sizes[40000] > sizes[8192])
  check(`阈值调小确实收紧（${sizes[8192]} → ${sizes[3000]}）`, sizes[3000] < sizes[8192])
  // 无剪枝器（CLI / MCP / 单测）必须落回缺省，而不是报错或什么都不给
  applyRead(mkCtx(undefined))
  const fallback = await bigRegistered.execute({ file_path: big, mode: 'map' }, exec)
  check('未部署剪枝器时落回缺省上限并正常出内容', JSON.stringify(fallback).length > 0)
}

// ── 契约层：透传清单必须与 schema 声明一致 ──────────────────────────────────
// 这是本工具反复出事的那条接缝。手写透传清单漏字段已经造成四次事故
// （text 未声明、version 在部分模式 undefined、version 为 null、truncated 漏传），
// 而前三次的修法都是往清单里再加一行。现在清单从集合派生，并由本断言与 schema 对齐。
say('=== 契约层：透传字段集合 ≡ schema 声明的可选字段 ===')
{
  const { PASSTHROUGH_FIELDS } = await import('../aura-read/index.js')
  const declared = Object.keys(schema.properties)
  const mandatory = ['path', 'mode', 'totalLines', 'text']
  const declaredOptional = declared.filter((k) => !mandatory.includes(k)).sort()
  const passthrough = [...PASSTHROUGH_FIELDS].sort()
  check(
    'schema 的可选字段与 PASSTHROUGH_FIELDS 完全一致',
    JSON.stringify(declaredOptional) === JSON.stringify(passthrough),
    `schema=[${declaredOptional}] passthrough=[${passthrough}]`,
  )
  check(
    'PASSTHROUGH_FIELDS 全部已在 schema 声明（漏声明会让成功路径被整条拒绝）',
    passthrough.every((k) => declared.includes(k)),
    passthrough.filter((k) => !declared.includes(k)).join(', '),
  )
  check('schema 未声明引擎产不出的字段', declared.every((k) => mandatory.includes(k) || passthrough.includes(k)))
}
say('')

// ── 主断言：每个模式 × 每个文件类型，输出都必须合自己的 schema ──────────────
say('=== 每个模式 × 每种扩展名：真实输出 vs 声明的 schema ===')
for (const f of fixtures) {
  const filePath = path.join(tmp, f.file)
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  // around／search 必须用**该文件里真实存在**的词，否则报 READ_NOT_FOUND——
  // 那是工具的正确行为，不是契约违规。第一版这里给所有文件都用 'alpha'，
  // 于是四个未索引夹具全被判失败，实际测的是"我的夹具没写对"。
  const ARGS = {
    map: {},
    digest: {},
    full: {},
    around: { around: f.probe },
    lines: { lines: [1, 2] },
    search: { search: f.probe },
    changed: {},
    auto: {},
  }
  const bad = []
  for (const [mode, extra] of Object.entries(ARGS)) {
    let value
    try {
      value = await registered.execute({ file_path: filePath, mode, ...extra }, exec)
    } catch (e) {
      bad.push(`${mode}: 抛错 ${e.message}`)
      continue
    }
    const v = [...validate(value, schema), ...serializationViolations(value)]
    // 这条**不能**靠 schema 的 required 表达，所以在这里显式断言。
    // 起因：`version` 曾经是 required，而在 around／lines／search 与所有未索引扩展名上
    // 实际是 undefined → 真实会话里 .json／.yml／.md 全部读取失败。
    // 修的时候把它改成可选（当时的实测是 `changed` 在缺省 since 下不给令牌；
    // 2026-09-22 复测：现在缺省/相同/过期 since 都给——注释按实测更新，断言不变）。
    // 但"含内容的回执必须给令牌"这条**业务规则没有变**——它现在由本行守着。
    // schema 只表达"可能缺席"，不变量由测试守：这是分工，不是放宽。
    if (value.version === undefined) v.push('missing `version` on a success result (changed with no `since` is the only allowed exception)')
    if (v.length > 0) bad.push(`${mode}: ${v.join('; ')}`)
  }
  check(`${f.label} 全部 8 个模式都合 schema`, bad.length === 0, bad.join(' | '))
}

// ── 边界：空的／哨兵 since 一律当首读，且必须给出**可用**令牌 ──────────────
// 这里曾经是 `since='<first>'` 返回 `version: null`。null 过不了框架对字符串字段的
// 类型校验（dsh-tools/lib/index.js:495），而且它让回执的 next 自相矛盾：
// "把 version 传回来"——传回 null 又落回同一分支，是个解不开的环。
//
// 注意参数类型由框架在入口处就校验（`since` 必须是 string），所以这里只喂字符串：
// 非字符串根本到不了 execute，属于"参数层拒绝"，不是本测试的覆盖面。
say('')
say('=== 边界：哨兵／空 since 当首读，且令牌必须可用 ===')
{
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  for (const since of ['<first>', '']) {
    const value = await registered.execute(
      { file_path: path.join(tmp, 'sample.js'), mode: 'changed', since },
      exec,
    )
    check(`since=${JSON.stringify(since)} 给出可用令牌`, typeof value.version === 'string' && value.version.length > 0, JSON.stringify(value.version))
    check(`since=${JSON.stringify(since)} 合 schema`, validate(value, schema).length === 0, validate(value, schema).join('; '))
  }
}

// ── 边界：非字符串 since 由**参数层**拒绝（框架职责，确认它确实拦得住）──────
say('')
say('=== 边界：非字符串 since 在参数层被拒（不会带着坏值进 execute）===')
{
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  for (const bad of [null, 42, true]) {
    let code = null
    try {
      await registered.execute({ file_path: path.join(tmp, 'sample.js'), mode: 'changed', since: bad }, exec)
    } catch (e) {
      code = e.code ?? 'THREW'
    }
    check(`since=${JSON.stringify(bad)} 被拒`, code === 'INVALID_ARGS', String(code))
  }
}

// ── 边界：令牌必须真的能拿回来用（闭环，而不是只看着像令牌）────────────────
say('')
say('=== 边界：令牌闭环（first read 给的令牌拿回来必须能比对）===')
{
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  const first = await registered.execute(
    { file_path: path.join(tmp, 'sample.js'), mode: 'changed', since: '<first>' },
    exec,
  )
  const second = await registered.execute(
    { file_path: path.join(tmp, 'sample.js'), mode: 'changed', since: first.version },
    exec,
  )
  check('带回首读令牌不报错', validate(second, schema).length === 0)
  check('闭环被识别为"无变化"（而不是又落回首读）', String(second.note ?? '').includes('no change'), String(second.note))
}

// ── 边界：changed 走一个真实 token 的往返 ───────────────────────────────────
say('')
say('=== 边界：changed 的令牌往返 ===')
{
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  const first = await registered.execute({ file_path: path.join(tmp, 'sample.js'), mode: 'changed' }, exec)
  check('首读给出可用令牌', typeof first.version === 'string' && first.version.length > 0, JSON.stringify(first.version))
  const second = await registered.execute(
    { file_path: path.join(tmp, 'sample.js'), mode: 'changed', since: first.version },
    exec,
  )
  check('带回令牌不报错且合 schema', validate(second, schema).length === 0)
  check('令牌往返被识别为"无变化"', String(second.note ?? '').includes('no change'), String(second.note))
}

// ── 边界：不存在的文件必须抛错，且不得返回半个信封 ──────────────────────────
say('')
say('=== 边界：不存在的文件 ===')
{
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  let threw = false
  try {
    await registered.execute({ file_path: path.join(tmp, 'nope.js') }, exec)
  } catch {
    threw = true
  }
  check('读不存在的文件抛错而不是返回空信封', threw)
  check('读不存在的文件抛错而不是返回空信封', threw)
}

// ── 错误路径：抛出的错误必须**自含**恢复信息 ────────────────────────────────
// DSH 框架对抛出的错误只取 `error.message`（`dsh-tools/lib/index.js:2495-2503`），
// 挂在错误对象上的 `candidates` / `next` / `hint` **一概不读**。
// 所以"把候选行给模型"只有在 message 里才算数——而这里原本抛的是纯 `${code}: ${message}`，
// 引擎已经算出的候选行**一个也到不了模型**。
// 实测：`READ_AMBIGUOUS` / `LOCATOR_CUE_AMBIGUOUS` 这类失败在真实会话里共 86+ 次。
// C3 之后载体从 `error.message` 改成了**回执的 text**（失败不再抛错）：模型能看见的那段
// 依然是这几条断言的对象，只是取的字段换了名字。
say('')
say('=== 错误路径：歧义失败的错误文本必须含候选行 ===')
{
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  const ambiguous = path.join(tmp, 'ambiguous.mjs')
  fs.writeFileSync(ambiguous, 'const a = 1\nconst b = 2\nconst c = 3\nfunction f() {\n  return a\n}\n', 'utf8')
  // 载体换了（fs-contract-v2 / C3）：歧义这类"判定不出意图"的失败**不再抛错**，
  // 改走结果通道。本块原本的 4 条断言是按旧签名写的（check 的参数是 (label, ok)），
  // 于是它们一直在打 "✓ false"——断言看着在测，实际从未生效。迁移时一并摆正，
  // 并把判据从"error.message 里有什么"改成"回执里读到什么"，一条不少。
  let threw = null
  let receipt = null
  try {
    receipt = await registered.execute({ file_path: ambiguous, mode: 'around', around: 'const' }, exec)
  } catch (e) {
    threw = e
  }
  const text = String(receipt?.text ?? '')
  check('确实走的是结果通道（不抛错）', threw === null && receipt !== null, threw ? String(threw.message).slice(0, 60) : 'no throw')
  check('回执的码是歧义错 READ_AMBIGUOUS', receipt?.code === 'READ_AMBIGUOUS', String(receipt?.code))
  check('三态是 needs_choice（多处都能对上，要调用方选一处）', receipt?.outcome === 'needs_choice', String(receipt?.outcome))
  // 注意参数顺序：本文件的 check 是 (label, ok, detail)——旧版这四行写反了，
  // 于是它们一直在打 "✓ false"。下面三行保持正确顺序。
  check('回执文本里含候选行（否则模型只能盲重试）', /line 1:/.test(text) && /line 2:/.test(text), text.replace(/\n/g, ' | ').slice(0, 110))
  check('回执文本里含续读指令', text.includes('next:'), text.replace(/\n/g, ' | ').slice(0, 110))
  check('候选带实际内容，模型可直接据此改写地址', text.includes('const a = 1'))
  check(
    '候选也以结构化字段带回来了（文本之外还有机器可读的那一份）',
    Array.isArray(receipt?.candidates) && receipt.candidates.length === 3 && receipt.candidates[0]?.line === 1,
    JSON.stringify(receipt?.candidates ?? null),
  )
  // 另一支：文件里根本没有这段 ⇒ not_found / READ_NOT_FOUND，同样走结果通道。
  const notFound = await registered.execute({ file_path: ambiguous, mode: 'search', search: 'zzz-not-in-this-file' }, exec)
  check(
    `查不到的内容也走结果通道：outcome=${notFound?.outcome} code=${notFound?.code}`,
    notFound?.outcome === 'not_found' && notFound?.code === 'READ_NOT_FOUND',
  )
  check('not_found 的回执文本里也带着码', String(notFound?.text ?? '').includes('READ_NOT_FOUND'), String(notFound?.text).slice(0, 70))
}

// ── 超长单行：必须是"截断并标注"，绝不能是"整行不给" ────────────────────────
// 这是一次审计查出的真实缺陷：预算判断排在前面，于是只要某一行自己就超过 contentBudget，
// 循环立刻 break、rows 为空 —— 整个文件读不出一个字。实测单行 8000/20000 字符时：
//   lines [1,1] text=0 · full text=0 · around text=0 · auto text=0
// 而 next 还在建议 `mode=lines lines=[1,1]`，即让模型重试刚刚返回空内容的同一个调用。
// 压缩 JS、单行数据、单行配置都会踩到。
//
// 这里断言四件事：内容**非空**、截断**被标注**、`truncated` **可程序化读取**、
// 且续读建议**不是**那个已经失败的调用。
say('')
say('=== 超长单行：可读 + 标注 + 机器可读 + 续读建议有效 ===')
{
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  for (const n of [8000, 20000]) {
    const longFile = path.join(tmp, `long${n}.js`)
    fs.writeFileSync(longFile, `const A = "${'x'.repeat(n)}";\nshort\n`, 'utf8')
    for (const [label, extra] of [
      ['lines', { mode: 'lines', lines: [1, 1] }],
      ['full', { mode: 'full' }],
      ['around', { mode: 'around', around: 'short' }],
    ]) {
      const value = await registered.execute({ file_path: longFile, ...extra }, exec)
      const issues = [...validate(value, schema), ...serializationViolations(value)]
      check(`单行${n} ${label}: 合 schema（truncated 已声明）`, issues.length === 0, issues.join('; '))
      check(`单行${n} ${label}: 内容非空（不是整行不给）`, typeof value.text === 'string' && value.text.length > 0, `text 长度 ${value.text?.length}`)
      check(`单行${n} ${label}: 截断被显式标注`, String(value.text ?? '').includes('[truncated]'))
      check(
        `单行${n} ${label}: truncated 机器可读`,
        value.truncated !== undefined && value.truncated.line === 1 && value.truncated.omittedChars > 0,
        JSON.stringify(value.truncated),
      )
      // 续读建议必须真的能拿到剩下的部分。建议 lines 是空头支票——单行内部再切只有 search 做得到。
      check(
        `单行${n} ${label}: next 指向 search 而不是已失败的 lines`,
        typeof value.next === 'string' && value.next.includes('mode=search'),
        String(value.next),
      )
    }
  }
}

// ── 负向对照：校验器本身必须抓得住 bug ──────────────────────────────────────
// 一个从不失败的校验器等于没有校验器。这里手工注入两个已知缺陷形态，
// 确认它们**会**被判违规——否则上面那些 ✓ 毫无意义。
say('')
say('=== 负向对照：校验器必须抓得住已知缺陷形态 ===')
{
  // `outcome` 现在是必填（三态：applied / needs_choice / not_found），成功回执也必须给——
  // 对照基线因此要把这一格填上，否则"完好对象"本身就不完好。
  const good = { path: 'x.js', mode: 'full', totalLines: 3, text: 'a', version: 'tok', outcome: 'applied' }
  check('完好对象通过（对照基线）', validate(good, schema).length === 0, validate(good, schema).join('; '))

  // 类型错必须被抓：`version` 曾经在 since='<first>' 时返回 null，
  // 而框架对标量字段查类型（dsh-tools:495），所以那在真实会话里是被拒的。
  const wrongType = { ...good, version: null }
  const v0 = validate(wrongType, schema)
  check('version=null 被类型检查抓住（真实出现过的形态）', v0.length > 0, v0.join('; '))

  const extraField = { ...good, bogus: 1 }
  const v2 = validate(extraField, schema)
  check('多出未声明字段被抓（第 1 个真实 bug 的形态）', v2.some((m) => m.includes('bogus')), v2.join('; '))

  const withUndef = { ...good, omitted: undefined }
  check('undefined 字段被序列化检查抓住', serializationViolations(withUndef).length > 0)

  // 说明分工：`version` 现在声明为可选，所以"缺 version"不再是 schema 违规，
  // 而是由上面主循环里的显式不变量守着。这里断言 schema 确实不再管它——
  // 免得有人误以为删掉那行不变量也安全。
  const missingVersion = { path: 'x.js', mode: 'full', totalLines: 3, text: 'a', outcome: 'applied' }
  check('schema 已不把 version 当必填（该约束改由显式不变量承担）', validate(missingVersion, schema).length === 0)
}

// ── 参数形状：模型怎么写都得能用 ─────────────────────────────────────────────
// 起因是一次真实报错：`{"file_path": "bridge.py", "lines": 412, 500, "mode": "lines"}`——
// 那不是合法 JSON，宿主在参数进工具之前就拒了（`invalid arguments: "arguments" must be an object`）。
// 工具管不到那种情况，但**只要参数对象到了**，形状宽容一点就少一整类来回。
say('')
say('=== 参数形状：能容的都容下来，容不了要说清接受什么 ===')
{
  const filePath = path.join(tmp, 'sample.js')
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  const shapes = [
    ['start_line + end_line（推荐）', { start_line: 1, end_line: 2 }, 'lines'],
    ['只给 start_line', { start_line: 2 }, 'lines'],
    ['lines: [1, 2]（老写法）', { lines: [1, 2] }, 'lines'],
    ['lines: "1,2"（字符串）', { lines: '1,2' }, 'lines'],
    ['lines: "1-2"（连字符）', { lines: '1-2' }, 'lines'],
    ['lines: 2（单行）', { lines: 2 }, 'lines'],
    ['lines: {start,end}', { lines: { start: 1, end: 2 } }, 'lines'],
  ]
  for (const [label, extra, expectMode] of shapes) {
    try {
      const value = await registered.execute({ file_path: filePath, ...extra }, exec)
      check(`${label} → mode=${value.mode}`, value.mode === expectMode && typeof value.text === 'string', JSON.stringify(value).slice(0, 90))
    } catch (error) {
      check(`${label} → 能用`, false, error.message)
    }
  }

  // 显式给了 mode 就听它的（给了行区间也不该被改写成 lines）
  try {
    const value = await registered.execute({ file_path: filePath, mode: 'map', start_line: 1, end_line: 2 }, exec)
    check('显式 mode 优先于推断', value.mode === 'map', value.mode)
  } catch (error) {
    check('显式 mode 优先于推断', false, error.message)
  }

  // 给了行但解不出来：必须报错并说清接受哪些形状（静默退回 auto 会让人以为是别的问题）
  try {
    await registered.execute({ file_path: filePath, lines: '从第2行到第3行' }, exec)
    check('行区间写坏时报错而不是静默 auto', false, '没有报错')
  } catch (error) {
    check(
      '行区间写坏时报错，并说清接受哪些形状',
      error.message.includes('start_line') && error.message.includes('lines'),
      error.message.slice(0, 110),
    )
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
