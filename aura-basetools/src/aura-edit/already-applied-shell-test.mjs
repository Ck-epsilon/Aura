/**
 * already-applied-shell-test —— C49 的验收套件：**第四态要真的到得了模型眼前**。
 *
 * 背景（一句话）：引擎编排层（`locator-lab/write-path.mjs` 的 `applyEditToProvider`）在
 * 「要改的原文不在文件里、但结果**已经**是调用方给的样子」时会返回 `outcome: 'already_applied'`
 * 且不写盘；而 DSH 壳的 `OUTCOMES` 里没有这一态，它把同一个 `PATCH_NOT_FOUND` 一律折成
 * `not_found` —— 于是模型看到的是「找不到你要改的原文」，而事实是「已经改好了」。
 * 本套件钉的就是最后一公里。
 *
 * 契约（本套件是它的判据，不是它的说明书）：
 *   段A 已落地 ⇒ 工具面回 `outcome='already_applied'`，**一个字节都不写**，回执说清事实
 *        （没写盘 / 为什么没写 / 命中的行号与那一行的原文），且合 output.schema；
 *   段B 真找不到 ⇒ **仍是 `not_found`**（不是所有 `PATCH_NOT_FOUND` 都翻成第四态）；
 *   段C 危险短串（`}` / `ok` / `return` / `};` …）⇒ **无一误判**成已落地；
 *   段D 第四态在 `output.schema` 的 enum 与字段面里**声明过**（否则整条回执被框架
 *        `INVALID_TOOL_OUTPUT` 顶掉，模型什么都看不到）。
 *
 * 每段都带**反向对照**：只断言「这条不抛」的话，一个把什么都吞掉的实现也能全绿 ——
 * 所以段B 的 not_found 旁边站着一条「同一份夹具、换一个真在文件里的 replace ⇒ already_applied」，
 * 段C 的每条误判负向旁边站着一条「同一份夹具、换一个够长够唯一的 replace ⇒ already_applied」。
 *
 * 跑法：`node src/aura-edit/already-applied-shell-test.mjs`，全绿 exit 0。
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
// 与 `aura-edit/outcome-test.mjs` 同一套做法：本仓被「返回了没声明的字段 / 声明了非法值」
// 咬过四次，而 mock 不校验 schema —— 只测「抛没抛」会漏掉一半。
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
/** 结构下限校验（永远跑）：字段已声明 / 必填在场 / enum 合法，逐层下钻数组项。 */
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

// ── mock ctx：与真实 Cordis 同形（用共享的 contextServices）────────────────────
const tmp = path.join(os.tmpdir(), `aura-already-applied-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })

/**
 * 可控的 fs 后端，带**写调用计数**。
 *
 * 计数是段A/B/C 的核心量具：第四态的全部内容是「这次没写盘」，而"没写盘"只能靠
 * 「写调用数恒 0 + 磁盘逐字节不变」两件事一起证。只证后者不够——一个先写再回滚的实现
 * 也能让内容看起来没变（本仓已有这类先例：`byte-fidelity` 段F 的反向断言）。
 */
const makeFs = (fail = {}) => {
  let version = 1
  const stats = { writes: 0, edits: 0, reads: 0 }
  const boom = (spec) => {
    if (spec !== undefined) throw Object.assign(new Error(spec.message), { code: spec.code })
  }
  return {
    stats,
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
      stats.reads += 1
      return fs.readFileSync(t.targetKey, 'utf8')
    },
    readByteRange: async (t, r) => fs.readFileSync(t.targetKey).subarray(r.offset, r.offset + r.length),
    writeText: async (t, content) => {
      boom(fail.writeText)
      stats.writes += 1
      fs.writeFileSync(t.targetKey, content)
      version += 1
      return { version: `v${version}`, operation: 'update', after: content }
    },
    editText: async () => {
      stats.edits += 1
      throw new Error('editText must not be used by the write path')
    },
  }
}

/** ctx 只 apply 一次，fs 后端可换（与 outcome-test 同一条理由：重注册会换掉手里那个闭包）。 */
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
  waterfall: async () => {
    throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
  },
})
const tool = registered
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

/** 像框架那样跑一次调用：抛错 ⇒ isError 结果；返回 ⇒ 过 output.schema 校验，再交给 render。 */
const run = async (args, fsService = makeFs()) => {
  holder.fs = fsService
  let value
  try {
    value = await tool.execute(args, exec)
  } catch (error) {
    return {
      isError: true,
      error,
      code: error?.code,
      text: String(error?.message ?? error),
      value: undefined,
      violations: [],
      writes: fsService.stats.writes,
      edits: fsService.stats.edits,
    }
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
  return { isError: false, value, code: value.code, text, violations, writes: fsService.stats.writes, edits: fsService.stats.edits }
}

const writeFixture = (name, content) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}
const readFixture = (p) => fs.readFileSync(p, 'utf8')

/**
 * 主夹具：**一次「重试」的真实形状** —— 上一次调用已经把 `n = 1` 改成了 `n = 42`，
 * 而调用方又拿着旧入参打了一遍。所以「已落地」的判据在这里有确定的答案：
 * `old` 两层都不在文件里，`replace` 逐字就在第 2 行。
 */
const LANDED = ['function alpha(input) {', '  const n = 42;', '  if (n > 0) {', '    return n * 2;', '  }', '  return n;', '}', ''].join(
  '\n',
)
/** 重试用的那一对：`old` 是**改之前**的原文（已不在），`replace` 是**改之后**的样子（已在）。 */
const RETRY = { old: '  const n = 1;', replace: '  const n = 42;' }
/** 一句确定不在文件里的原文（两层都不在：整行层与片段层都找不到）。 */
const MISSING_OLD = '这段内容根本不在文件里ZZZ\n也不在这里YYY'

// ════════════════════════════════════════════════════════════════════════════
say('=== A. 已落地：工具面回 already_applied，且一个字节都不写 ===')
{
  const file = writeFixture('a1.js', LANDED)
  const fsService = makeFs()
  const r = await run({ file_path: file, hunks: [{ ...RETRY }] }, fsService)

  check(!r.isError, 'A1 已落地的 hunk 不抛错（走结果通道）', r.isError ? `抛了：${r.code} ${r.text.slice(0, 60)}` : '')
  check(
    r.value?.outcome === 'already_applied',
    'A1 outcome=already_applied（壳层第四态，不再折成 not_found）',
    `实际 ${JSON.stringify(r.value?.outcome)} code=${r.value?.code}`,
  )
  check(
    r.value?.code === 'PATCH_NOT_FOUND',
    'A1 带回引擎的原判决码（这一态是从 PATCH_NOT_FOUND 细分出来的）',
    `code=${JSON.stringify(r.value?.code)}`,
  )
  check(Array.isArray(r.value?.applied) && r.value.applied.length === 0, 'A1 applied 为空数组（结构上可读：一个 hunk 都没落盘）', JSON.stringify(r.value?.applied))
  check(r.value?.unchanged === true, 'A1 unchanged=true（文件本来就是对的）', JSON.stringify(r.value?.unchanged))

  // —— 可核的证据：命中的行号 + 那一行的**原文** ——
  const hits = r.value?.already_applied
  check(Array.isArray(hits) && hits.length === 1, 'A1 回执带 already_applied 证据数组（逐条可与文件对照）', JSON.stringify(hits))
  check(hits?.[0]?.line === 2, 'A1 证据给出命中的行号（第 2 行）', `line=${JSON.stringify(hits?.[0]?.line)}`)
  check(
    typeof hits?.[0]?.tier === 'string' && hits[0].tier.startsWith('already-applied~'),
    'A1 证据给出命中层级（already-applied~…）',
    JSON.stringify(hits?.[0]?.tier),
  )
  check(
    hits?.[0]?.actual === RETRY.replace && hits?.[0]?.replaced === RETRY.replace,
    'A1 证据里的 actual（那一行原文）与 replaced（调用方给的文本）逐字相等 —— 这一态成立的依据',
    `actual=${JSON.stringify(hits?.[0]?.actual)}`,
  )
  check(hits?.[0]?.hunk === 0, 'A1 证据指回是第几条 hunk（多 hunk 调用时必需）', `hunk=${JSON.stringify(hits?.[0]?.hunk)}`)

  // —— 不改盘：写调用数 + 磁盘字节，两件事一起证 ——
  check(r.writes === 0 && r.edits === 0, 'A1 写调用数 = 0（writeText/editText 都没被碰过）', `writes=${r.writes} edits=${r.edits}`)
  check(readFixture(file) === LANDED, 'A1 磁盘逐字节未变')
  check(r.violations.length === 0, 'A1 回执合 output.schema（不许凭空多字段 / enum 必须收得下）', r.violations.slice(0, 2).join('; '))

  // —— 回执正文：模型真正看得见的那段 ——
  check(/nothing was written/.test(r.text), 'A1 正文明说"没写盘"', r.text.split('\n')[0].slice(0, 90))
  check(/already there verbatim/.test(r.text), 'A1 正文说清**为什么**没写（结果已经逐字在那儿了）', r.text.split('\n')[1]?.slice(0, 90))
  check(
    typeof r.value?.message === 'string' && r.text.includes(r.value.message),
    'A1 正文读的是回执的 message（单源：判决与叙述不会两处各写一句）',
    r.text.split('\n')[1]?.slice(0, 70),
  )
  check(
    !/re-read the file/.test(r.text) && !/re-read the file/.test(String(r.value?.message)),
    'A1 正文与 message 都不带引擎那句 `not_found` 的恢复指令（“重读文件”）—— 这一态没有要改的东西',
    String(r.value?.message).slice(0, 70),
  )
  check(/nothing needs to change/.test(r.text), 'A1 正文正面陈述“没什么要改的”', String(r.value?.message).slice(0, 60))
  check(/already_applied/.test(r.text), 'A1 正文里能看出是哪一类判决', r.text.split('\n')[0].slice(0, 90))
  check(/line 2/.test(r.text), 'A1 正文给出命中的行号', r.text.split('\n').slice(2, 4).join(' / ').slice(0, 110))
  check(
    r.text.includes(JSON.stringify(RETRY.replace)),
    'A1 正文引用**那一行的原文**（转义引用，可逐字核对）',
    r.text.split('\n').slice(3, 4).join('').slice(0, 110),
  )
  check(/next: /.test(r.text), 'A1 正文给出下一步（不是只报一句"错了"）', String(r.value?.next).slice(0, 70))
  check(!/outcome: not_found/.test(r.text), 'A1 正文不冒充 not_found（两态指向相反的动作）')
  check(!/structural directory/.test(r.text), 'A1 正文不附符号目录（那是给失败用的恢复路径，这一态没有失败）')

  // —— 幂等：同一份入参再打一次，还是第四态、还是不写盘 ——
  const again = await run({ file_path: file, hunks: [{ ...RETRY }] }, fsService)
  check(again.value?.outcome === 'already_applied' && again.writes === 0, 'A2 幂等：同一份入参第二次仍是 already_applied 且写调用仍为 0', `writes=${again.writes}`)
  check(readFixture(file) === LANDED, 'A2 幂等：磁盘仍逐字节未变')

  // —— 多 hunk：两条都已落地 ⇒ 两条都要给证据 ——
  const multiFile = writeFixture('a3.js', LANDED)
  const multi = await run(
    {
      file_path: multiFile,
      hunks: [
        { ...RETRY },
        { old: '  return n * 3;', replace: '  return n;' },
      ],
    },
    makeFs(),
  )
  check(multi.value?.outcome === 'already_applied', 'A3 多 hunk 全部已落地 ⇒ already_applied', JSON.stringify(multi.value?.outcome ?? multi.code))
  check(
    Array.isArray(multi.value?.already_applied) && multi.value.already_applied.length === 2,
    'A3 逐条给证据（2 条 hunk ⇒ 2 条证据）',
    JSON.stringify(multi.value?.already_applied?.map((h) => h.line)),
  )
  check(multi.writes === 0 && readFixture(multiFile) === LANDED, 'A3 多 hunk 也没写盘', `writes=${multi.writes}`)

  // —— 平铺形状：一个 hunk 直接写在顶层，也要走同一条判决 ——
  const flatFile = writeFixture('a4.js', LANDED)
  const flat = await run({ file_path: flatFile, ...RETRY }, makeFs())
  check(flat.value?.outcome === 'already_applied', 'A4 平铺形状（old/replace 在顶层）同样回 already_applied', JSON.stringify(flat.value?.outcome ?? flat.code))
  check(flat.writes === 0 && readFixture(flatFile) === LANDED, 'A4 平铺形状也没写盘', `writes=${flat.writes}`)

  // —— dry_run 与第四态并存：仍然不写盘，且如实标注 ——
  const dryFile = writeFixture('a5.js', LANDED)
  const dry = await run({ file_path: dryFile, hunks: [{ ...RETRY }], dry_run: true }, makeFs())
  check(dry.value?.outcome === 'already_applied' && dry.value?.dryRun === true, 'A5 dry_run 下仍是 already_applied（dryRun 如实标注）', JSON.stringify(dry.value?.outcome))
  check(dry.writes === 0 && readFixture(dryFile) === LANDED, 'A5 dry_run 下磁盘未变', `writes=${dry.writes}`)
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== B. 真找不到：仍必须是 not_found（第四态不许把失败吞掉）===')
{
  // B1 反向对照的**基准**：同一份夹具、把 replace 换成一个逐字在文件里的文本 ⇒ 第四态
  const control = writeFixture('b0.js', LANDED)
  const hit = await run({ file_path: control, hunks: [{ old: MISSING_OLD, replace: '  const n = 42;' }] }, makeFs())
  check(hit.value?.outcome === 'already_applied', 'B0 对照：replace 真在文件里 ⇒ already_applied（证明后面的 not_found 不是恒真）', JSON.stringify(hit.value?.outcome ?? hit.code))

  // B1 `old` 不在、`replace` 也不在 ⇒ 真找不到
  const file = writeFixture('b1.js', LANDED)
  const fsService = makeFs()
  const r = await run({ file_path: file, hunks: [{ old: MISSING_OLD, replace: '一段确实不在文件里的替换文本ZZZ' }] }, fsService)
  check(!r.isError, 'B1 真找不到不抛错（仍走结果通道）', r.isError ? `抛了：${r.code}` : '')
  check(r.value?.outcome === 'not_found', 'B1 真找不到 ⇒ outcome=not_found（第四态不越界）', `实际 ${JSON.stringify(r.value?.outcome)}`)
  check(r.value?.code === 'PATCH_NOT_FOUND', 'B1 带回引擎判决码', `code=${JSON.stringify(r.value?.code)}`)
  check(r.value?.already_applied === undefined && r.value?.unchanged === undefined, 'B1 真找不到的回执不带第四态字段（形状一字未变）', JSON.stringify(Object.keys(r.value ?? {})))
  check(Array.isArray(r.value?.applied) && r.value.applied.length === 0, 'B1 applied 为空数组')
  check(r.writes === 0 && readFixture(file) === LANDED, 'B1 磁盘未变', `writes=${r.writes}`)
  check(r.violations.length === 0, 'B1 回执合 output.schema', r.violations.slice(0, 2).join('; '))
  check(/nothing was written/.test(r.text) && /not_found/.test(r.text), 'B1 正文仍按失败口径说（not_found）', r.text.split('\n')[0].slice(0, 90))

  // B2 多 hunk **只有一半**已落地 ⇒ 整体不是第四态（宁可少说，不许说错）
  const halfFile = writeFixture('b2.js', LANDED)
  const half = await run(
    {
      file_path: halfFile,
      hunks: [
        { ...RETRY },
        { old: MISSING_OLD, replace: '一段确实不在文件里的替换文本ZZZ' },
      ],
    },
    makeFs(),
  )
  check(
    half.value?.outcome === 'not_found',
    'B2 多 hunk 里只有一条已落地 ⇒ 仍 not_found（不许把"没全部落地"说成"已经是你给的样子"）',
    JSON.stringify(half.value?.outcome),
  )
  check(half.value?.already_applied === undefined, 'B2 半落地不回第四态字段', JSON.stringify(half.value?.already_applied))
  check(readFixture(halfFile) === LANDED, 'B2 半落地时第一条也没偷偷落盘')

  // B3 正常编辑不受影响：`old` 在场 ⇒ 照旧 applied，第四态不许抢
  const editFile = writeFixture('b3.js', LANDED)
  const edit = await run({ file_path: editFile, hunks: [{ old: '  const n = 42;', replace: '  const n = 7;' }] }, makeFs())
  check(edit.value?.outcome === 'applied' && edit.writes === 1, 'B3 old 在场的正常编辑照旧 applied（第四态不抢正常路径）', `outcome=${JSON.stringify(edit.value?.outcome)} writes=${edit.writes}`)
  check(readFixture(editFile).includes('  const n = 7;'), 'B3 正常编辑真的落盘了')

  // B4 只给坐标（没有 old）时，第四态**结构上不可能**成立 ⇒ 越界仍是 not_found
  const outFile = writeFixture('b4.js', LANDED)
  const outOfRange = await run({ file_path: outFile, hunks: [{ lines: [99, 99], replace: '  const n = 42;' }] }, makeFs())
  check(
    outOfRange.value?.outcome === 'not_found',
    'B4 只给坐标且越界 ⇒ not_found（第四态要求 `old`，坐标档不该被它接管）',
    `${JSON.stringify(outOfRange.value?.outcome)} code=${outOfRange.value?.code}`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== C. 危险短串：`}` / `ok` / `return` / `};` … 一个都不许误判成已落地 ===')
/**
 * 这一段的样本刻意做成**最坏形状**：文件里那几行是**恰好等于**危险短串的整行
 * （`}` / `ok` / `return` / `};` 各出现一次 ⇒ 整行命中且全文唯一）。
 * 也就是说，唯一挡住误判的是判据第三档「`replace` 去空白后 ≥ 8 字符」——
 * 少了它，「文件里恰好有一行是 `}`」就会被卖成"已经改好了"。
 */
{
  const TRAP = ['const a = 1;', '}', 'ok', 'return', '};', 'const b = 2;', ''].join('\n')
  const SHORT = ['}', 'ok', 'return', '};', '  }', ' ', 'x', ';', 'const', '{\n}']
  for (const [i, replace] of SHORT.entries()) {
    const file = writeFixture(`c1-${i}.js`, TRAP)
    const r = await run({ file_path: file, hunks: [{ old: MISSING_OLD, replace }] }, makeFs())
    check(
      r.value?.outcome === 'not_found',
      `C1.${i + 1} replace=${JSON.stringify(replace)} ⇒ not_found（不许误判成已落地）`,
      `实际 ${JSON.stringify(r.value?.outcome)} already_applied=${JSON.stringify(r.value?.already_applied)}`,
    )
    check(r.writes === 0 && readFixture(file) === TRAP, `C1.${i + 1} 磁盘未变`, `writes=${r.writes}`)
  }
  // 同夹具的**正向对照**：换一个够长、整行、唯一的 replace ⇒ 第四态，证明上面每条负向都有判定力
  const trapFile = writeFixture('c1-control.js', TRAP)
  const trapHit = await run({ file_path: trapFile, hunks: [{ old: MISSING_OLD, replace: 'const a = 1;' }] }, makeFs())
  check(trapHit.value?.outcome === 'already_applied', 'C1 对照：同一份夹具 + 够长够唯一的 replace ⇒ already_applied', JSON.stringify(trapHit.value?.outcome ?? trapHit.code))

  // C2 replace 只在**行内片段**里出现（不是整行）⇒ 不判已落地（片段层接不住它）
  const INLINE = ['function f() {', '  const width = 12;', '  return width;', '}', ''].join('\n')
  const inlineFile = writeFixture('c2.js', INLINE)
  const inline = await run({ file_path: inlineFile, hunks: [{ old: MISSING_OLD, replace: 'const width = 12' }] }, makeFs())
  check(
    inline.value?.outcome === 'not_found',
    'C2 replace 只在行内片段里（`const width = 12` 是第 2 行的一截，17 字符够长）⇒ not_found',
    `实际 ${JSON.stringify(inline.value?.outcome)}`,
  )
  const inlineFile2 = writeFixture('c2-control.js', INLINE)
  const inlineHit = await run({ file_path: inlineFile2, hunks: [{ old: MISSING_OLD, replace: '  const width = 12;' }] }, makeFs())
  check(inlineHit.value?.outcome === 'already_applied', 'C2 对照：同一行改写成**整行** ⇒ already_applied', JSON.stringify(inlineHit.value?.outcome ?? inlineHit.code))

  // C3 整行命中但**不唯一** ⇒ 不判已落地（唯一性是 `old` 被应用时本来就要求的门槛）
  const DUP = ['  const dup = 1;', 'x', '  const dup = 1;', ''].join('\n')
  const dupFile = writeFixture('c3.js', DUP)
  const dup = await run({ file_path: dupFile, hunks: [{ old: MISSING_OLD, replace: '  const dup = 1;' }] }, makeFs())
  check(dup.value?.outcome === 'not_found', 'C3 replace 整行命中但出现两次 ⇒ not_found（唯一性门槛不放松）', `实际 ${JSON.stringify(dup.value?.outcome)}`)
  check(dup.writes === 0 && readFixture(dupFile) === DUP, 'C3 磁盘未变', `writes=${dup.writes}`)

  // C4 短 replace + `old` 在场：照旧走正常判决（既不误判第四态，也不丢原来的语义）
  const bothFile = writeFixture('c4.js', LANDED)
  const both = await run({ file_path: bothFile, hunks: [{ old: '  const n = 42;', replace: '}' }] }, makeFs())
  check(
    both.value?.outcome === 'applied' || both.value?.outcome === 'not_found',
    'C4 `old` 在场时短 replace 仍走原判决（applied/not_found，绝不 already_applied）',
    `outcome=${JSON.stringify(both.value?.outcome)}`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== D. 第四态在 output.schema 里声明过（否则整条回执被框架顶掉）===')
{
  const out = tool.output.schema
  const enumNames = out.properties?.outcome?.enum
  check(Array.isArray(enumNames) && enumNames.includes('already_applied'), 'D1 第四态在 outcome 的 enum 里（产出面与验证面同一份名单）', JSON.stringify(enumNames))
  check(
    JSON.stringify(enumNames) === JSON.stringify(plugin.OUTCOMES),
    'D1 enum 与导出的 OUTCOMES 逐字同源（schema 是验证面，常量是产出面）',
    `enum=${JSON.stringify(enumNames)} OUTCOMES=${JSON.stringify(plugin.OUTCOMES)}`,
  )
  const hitSpec = out.properties?.already_applied
  check(hitSpec?.type === 'array' && hitSpec.items?.properties !== undefined, 'D2 already_applied 已声明（array + items）', JSON.stringify(hitSpec?.items?.properties && Object.keys(hitSpec.items.properties)))
  check(
    JSON.stringify(hitSpec?.items?.required) === '["hunk","line","tier","actual","replaced"]',
    'D2 证据的五个键都是必填（缺正文的证据比没有证据更难核对）',
    JSON.stringify(hitSpec?.items?.required),
  )
  check(out.properties?.unchanged?.type === 'boolean', 'D3 unchanged 已声明（boolean）', JSON.stringify(out.properties?.unchanged?.type))

  /** 真校验器：第四态的回执必须**收得下**（这三格就是「校验不过」那一类半接状态）。 */
  const sample = {
    path: 'x.js',
    outcome: 'already_applied',
    code: 'PATCH_NOT_FOUND',
    message: 'm',
    already_applied: [{ hunk: 0, line: 2, tier: 'already-applied~exact', actual: '  const n = 42;', replaced: '  const n = 42;' }],
    unchanged: true,
    next: 'n',
    applied: [],
    dryRun: false,
  }
  check(declaredViolations(out, sample).length === 0, 'D4 结构下限：第四态回执没有未声明字段', declaredViolations(out, sample).slice(0, 2).join('; '))
  check(
    realViolations(out, sample).length === 0,
    framework === null ? 'D4 真校验器缺席（结构下限已跑，见上一条）' : 'D4 真校验器收下第四态回执',
    realViolations(out, sample).slice(0, 2).join('; '),
  )
  // 反向对照：不是"什么都收"——编造的取值与字段仍要被拒
  check(
    declaredViolations(out, { ...sample, outcome: 'already_applied_typo' }).length > 0,
    'D5 对照：编造的 outcome 取值被 enum 拒（D1 的名单不是恒真）',
    declaredViolations(out, { ...sample, outcome: 'already_applied_typo' }).slice(0, 1).join(''),
  )
  check(
    declaredViolations(out, { ...sample, already_applied_typo: [] }).length > 0,
    'D5 对照：形近的假字段被 additionalProperties:false 拒',
    declaredViolations(out, { ...sample, already_applied_typo: [] }).slice(0, 1).join(''),
  )
  if (framework !== null) {
    check(
      realViolations(out, { ...sample, already_applied: [{ hunk: 0, line: 2, tier: 't', actual: 'a' }] }).length > 0,
      'D6 对照：证据缺了 replaced 这个必填键 ⇒ 真校验器当场拒',
      realViolations(out, { ...sample, already_applied: [{ hunk: 0, line: 2, tier: 't', actual: 'a' }] }).slice(0, 1).join(''),
    )
  }
  check(out.additionalProperties === false, 'D7 output.schema 仍是 additionalProperties:false（没被放松）')
}

fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`--- 结果：${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL: ${f.label} ${f.detail}`)
  process.exitCode = 1
}
