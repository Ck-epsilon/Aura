/**
 * load-test —— 用最小 mock 上下文把 aura_basetools_read 当作加载器会做的那样跑一遍。
 *
 * 验三件事（与 aura_basetools_edit 的加载测试同一套口径）：
 *   1. 模块形状：name / inject / apply 齐全，依赖能解析
 *   2. 注册：apply 真的注册了 aura_basetools_read，schema 正确
 *   3. 行为：七个模式都能通过工具层跑通，且输出信封里的字段真的到得了模型
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MODES } from '../locator-lab/read-core.mjs'

const plugin = await import('./index.js')

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

say('=== 1. 模块形状 ===')
check(plugin.name === 'dsh-tool-aura-read', `name = ${JSON.stringify(plugin.name)}`)
check(typeof plugin.apply === 'function', 'apply 是函数')
check(Array.isArray(plugin.inject) && plugin.inject.includes('fs') && plugin.inject.includes('tools'), `inject = ${JSON.stringify(plugin.inject)}`)

say('')
say('=== 2. 注册 ===')
let registered = null
/** 收集注册的提示段，供断言。真机上由框架渲染，这里只验证注册行为。 */
const sections = []
const mockCtx = {
  // `get` 必须**尊重 scope 参数**：第一版写成 `() => registered`，无视参数永远返回工具，
  // 于是"工具被 scope 隐藏时指导应为空"这条断言**永远通过不了**——是 mock 太笨，
  // 不是被测代码有问题。mock 的保真度直接决定它能测出什么。
  tools: {
    register: (t) => (registered = t),
    get: (toolName, scope) => (scope === undefined ? registered : undefined),
  },
  emit: () => {},
  waterfall: async () => undefined,
  // systemPrompt **必须提供**：否则 `ctx.get('systemPrompt')` 返回 undefined，
  // 注册提示段那段代码根本不会执行——测试照样绿，而真机上少了一整段指导。
  // 这与先前 output.schema 漏声明是同一类盲区：mock 缺什么，就等于那块没测。
  systemPrompt: {
    section: (s) => {
      sections.push(s)
      return () => {}
    },
  },
}
plugin.apply(mockCtx)
check(registered !== null, 'apply 调用了 ctx.tools.register')
check(registered?.name === 'aura_basetools_read', `注册的工具名 = ${JSON.stringify(registered?.name)}`)
const params = Object.keys(registered?.parameters?.properties ?? {})
check(
  // start_line/end_line 是后加的：行区间不用写数组语法，模型少一类写错的机会（2026-09-22）。
  params.join(',') === 'file_path,targets,mode,around,lines,start_line,end_line,search,entity,regex,glob,case_sensitive,max_results,max_chars,budget,coverage,structure_handle,offset,limit,context,since,kind',
  `参数 = ${params.join(',')}`,
)
check(registered?.description?.includes('map'), '描述里点明了 map 模式')

say('')
say('=== 2b. 提示段：只注册工具是不够的 ===')
// 背景：在真实会话里观察到模型完全不用本工具，查系统提示词才找到原因——
// 内置 tool-fs 注入了"Use the read tool …"这类命令式指导，而本工具只有 schema。
// 因此提示段与工具是**同一件事的两半**，必须一起验。
check(sections.length === 1, `注册了 ${sections.length} 个提示段`)
const sec = sections[0]
check(sec?.name === 'tool:aura-read', `段名 = ${JSON.stringify(sec?.name)}`)
// order 必须晚于 TOOL_EDIT(1300)：提示词里靠后的指导压过靠前的
check(typeof sec?.order === 'number' && sec.order > 1300, `order = ${sec?.order}（须 > 1300 以压过内置指导）`)
const guideText = typeof sec?.text === 'function' ? sec.text({ scope: undefined }) : sec?.text
// 措辞必须是**命令式**，与内置的 "Use the read tool — not shell commands like cat — …" 同形。
// 这已不是风格偏好：实测建议式措辞（"prefer X over Y"）在部分会话里压不过先验，
// 同一份指导会出现"有时选 Aura、有时选内置"的分裂结果。
check(typeof guideText === 'string' && guideText.includes('Use the aura_basetools_read tool'), '指导用与内置同形的命令式措辞')
// 这里原本断言指导里含 "Keep the built-in read"，即"未知扩展名请用内置 read"。
// 那句话是**错的**，已删：实测未知扩展名上 `auto` 会降级到 `full` 并给出完整内容
// （见 locator-lab/unknown-ext-output.mjs）。错的指导比没有指导更坏——它恰好在
// 工具完全可用的场景里把模型赶回内置工具，而那正是本工具要解决的问题。
check(
  typeof guideText === 'string' && guideText.includes('falls back to `full`'),
  '指导说明了未知扩展名会降级到 full，而不是把模型赶回内置 read',
)
// 工具被 scope 隐藏时指导必须为空——否则会教模型用一个它没有的工具
const hiddenText = typeof sec?.text === 'function' ? sec.text({ scope: 'hidden' }) : null
check(hiddenText === '' || hiddenText === undefined, '工具被隐藏时指导为空', String(hiddenText).slice(0, 30))

say('')
say('=== 3. 行为：每个模式都通过工具层跑通 ===')
const tmp = path.join(os.tmpdir(), `aura-read-load-${Date.now()}`)
fs.mkdirSync(tmp, { recursive: true })
const target = path.join(tmp, 'sample.js')
const SRC = [
  'export function total(items) {',
  '  let sum = 0;',
  '  for (const it of items) {',
  '    sum += it.price;',
  '  }',
  '  return sum;',
  '}',
  '',
  'export function label(count) {',
  '  return `n=${count}`;',
  '}',
  '',
].join('\n')
fs.writeFileSync(target, SRC, 'utf8')

// 通过工具执行路径真的跑一遍
let version = 'v1'
const liveCtx = {
  fs: {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    // stat 必须**按路径**报告存在与否。第一版写成无条件的 `async () => ({version})`，
    // 于是"文件不存在"这条路径根本走不到，测试报出一个假的失败
    // （miss=null，即没抛错）。mock 失真会把被测对象的正确行为伪装成 bug。
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version } : undefined),
    readText: async () => fs.readFileSync(target, 'utf8'),
  },
  /**
   * `get` 与真实 Cordis 上下文同形（这是本项目第四次因为"mock 比真件宽松"而漏测）：
   * 工具壳读宿主上限时用的是 `ctx.get('toolResultPruner')`，而 mock 没有 `get`
   * → `TypeError: ctx.get is not a function`，**测试当场红**。
   * 错的方向是安全的（红而不是绿），但它说明：mock 缺一个成员，就缺一条被测路径。
   * 这里返回 undefined = "未部署剪枝器"，即引擎落回缺省上限——另一条路径（宿主给了阈值）
   * 由 `aura-read-schema-test` 的上限矩阵覆盖。
   */
  get: () => undefined,
  tools: { register: (t) => (registered = t), get: () => registered },
  // 这个 ctx 也必须提供 systemPrompt：插件把它声明进了 inject，缺了会在 apply 期抛错。
  // 这个"抛错"是好事——它把"工具注册了却没有指导"这种半成品状态挡在装载期，
  // 而不是留到运行期表现为"模型永远不用这个工具"（我踩过的坑）。
  systemPrompt: { section: () => () => {} },
  emit: (ev) => {
    if (ev === 'fs/observed') observed += 1
  },
  waterfall: async () => undefined,
}
let observed = 0
plugin.apply(liveCtx)
const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }

/**
 * 校验一个返回值是否**合工具自己声明的 output.schema**。
 *
 * 这道校验是本文件最重要的一课。第一版 load-test 29/29 全绿，而 aura_basetools_read 在真机上
 * **每一条成功路径都失败**——因为渲染器返回 `text`，而 output.schema 里没声明它，
 * 框架按 `additionalProperties: false` 直接拒绝。mock 从不校验输出形状，于是那个 bug
 * 一路穿过所有测试，直到真实模型调用才暴露。
 *
 * **mock 比框架宽松，就等于没测。** 这里按框架的规则实现最小校验：
 * 未声明的属性、缺必填、类型不符，三者都算失败。
 */
function validateOutput(schema, value, path = 'value') {
  const errors = []
  if (schema === undefined) return errors
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path} 应为 object，实际 ${typeof value}`]
    }
    const declared = Object.keys(schema.properties ?? {})
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!declared.includes(k)) errors.push(`${path}.${k} is not a declared property`)
      }
    }
    for (const k of schema.required ?? []) {
      if (value[k] === undefined) errors.push(`${path}.${k} is required but missing`)
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (value[k] === undefined) continue
      errors.push(...validateOutput(sub, value[k], `${path}.${k}`))
    }
    return errors
  }
  if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path} 应为 string，实际 ${typeof value}`)
  if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} 应为 integer，实际 ${typeof value}`)
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} 应为 boolean，实际 ${typeof value}`)
  if (schema.type === 'array' && !Array.isArray(value)) errors.push(`${path} 应为 array，实际 ${typeof value}`)
  return errors
}

const OUTPUT_SCHEMA = registered?.output?.schema
let schemaViolations = 0
/** 每次执行都过一遍输出校验——这是框架会做而我们先前没做的事。 */
async function run(args) {
  const r = await registered.execute(args, exec)
  const errs = validateOutput(OUTPUT_SCHEMA, r)
  if (errs.length > 0) {
    schemaViolations += 1
    say(`    ! 输出不合 schema: ${errs.join('; ')}`)
  }
  return r
}

for (const mode of MODES) {
  const args = { file_path: target, mode }
  if (mode === 'around') args.around = 'sum += it.price'
  if (mode === 'lines') args.lines = [2, 4]
  if (mode === 'search') args.search = 'export'
  if (mode === 'changed') args.since = 'never'
  const r = await run(args)
  check(typeof r.text === 'string' && r.text.length > 0, `${mode.padEnd(8)} 返回文本 ${r.text.length} 字符`, r.mode === mode ? '' : `mode=${r.mode}`)
  check(r.mode === mode, `${mode.padEnd(8)} 回执 mode 正确`)
}
check(schemaViolations === 0, `${MODES.length} 个模式的输出全部合声明的 schema`, `违规 ${schemaViolations}`)

say('')
say('=== 4. auto 模式：不给 mode 时自己选 ===')
const auto = await run({ file_path: target })
check(typeof auto.mode === 'string' && MODES.includes(auto.mode), `auto 选了 ${auto.mode}`)
check(auto.text.includes('auto:'), '文本里说明了 auto 的选择理由')

say('')
say('=== 5. 观测契约：读一次要记一次 fs/observed ===')
check(observed > 0, `emit 了 ${observed} 次 fs/observed`)
const before = observed
await run({ file_path: target, mode: 'map' })
check(observed === before + 1, '每次读取恰好记一次观测')

say('')
say('=== 6. 错误必须可执行 ===')
const obsBeforeMiss = observed
let miss = null
try {
  await run({ file_path: path.join(tmp, 'nope.js') })
} catch (e) {
  miss = e
}
check(miss instanceof Error && String(miss.message).includes('not found'), `缺失文件报错：${miss?.message}`)
// 缺失必须记成一次观测，否则后续 write 无法走"带防护的创建"——这是 dsh-tool-fs 的契约
check(observed === obsBeforeMiss + 1, '缺失也记录了一次 fs/observed（供后续创建使用）')
const badMode = await run({ file_path: target, mode: 'nope' }).catch((e) => e)
check(badMode instanceof Error && badMode.message.includes('READ_BAD_MODE'), `未知 mode 报错：${badMode.message.slice(0, 40)}`)
const badRange = await run({ file_path: target, mode: 'lines' }).catch((e) => e)
check(badRange instanceof Error && badRange.message.includes('READ_NO_RANGE'), `缺区间报错：${badRange.message.slice(0, 40)}`)

say('')
say('=== 7. 回执自描述：模型要看得见工具的决策 ===')
// 背景（实测）：107 次真实读取里 69 次走 auto，而回执从不说明"选了哪个模式、为什么"——
// 选择规则本身是确定的（suggestMode 是纯函数），但那条规则只存在于代码里，模型侧看不到；
// 版本令牌同样只在 changed 自己的回执里出现，于是"要拿钥匙先得有钥匙"，changed 实际不可用。
const autoReceipt = await run({ file_path: target })
check(autoReceipt.text.includes(`auto: ${autoReceipt.mode} —`), `回执里写了所选模式：${autoReceipt.text.split('\n')[0].slice(0, 60)}`)
check(/budget|complete answer|smaller than the full text/.test(autoReceipt.text), '回执里写了选择理由（而不是只给模式名）')
check(autoReceipt.text.includes('version:'), '普通读取也带版本令牌')

// auto 选中的模式由 `mode` 字段承载（此前 `auto` 字段被错当成模式名）
check(autoReceipt.mode === 'full', `小文件上 auto 选 full（实际 ${autoReceipt.mode}）`)

// 令牌必须真的能用：同一内容拿它当 since 重读 ⇒ 无变化
const delta = await run({ file_path: target, since: autoReceipt.version })
check(delta.mode === 'changed', `带 since 不带 mode 时进入 changed（实际 ${delta.mode}）`)
check(String(delta.note ?? '').includes('no change'), `无变化时明确说明：${delta.note}`)
check(delta.text.includes('version:'), 'changed 回执同样带版本令牌')

// 内容变了要有窗口
const changedSrc = SRC.replace('return sum;', 'return sum * 2;')
fs.writeFileSync(target, changedSrc, 'utf8')
const delta2 = await run({ file_path: target, since: autoReceipt.version })
check(delta2.mode === 'changed' && delta2.text.includes('* 2'), '内容变化后回执给出改动窗口')
fs.writeFileSync(target, SRC, 'utf8')

say('')
say('=== 7b. digest 坍塌护栏：auto 不得选中已坍塌的 digest，要退到 map ===')
// 本节迁移过一次（波5 C20）。迁移前的两条断言钉的是**修复前**的失效模式本身：
//   「600 函数上显式 digest 交不出签名（sig600 === 0）」「auto 不再选坍塌的 digest」
// 那个失效模式是：digest 的导出面不受预算约束，固定头把预算吃完后正文坍塌成一行统计，
// 而 auto 的判据恰好是"选最小的"——**越废掉的输出越会被选中**。
// 现在导出面与正文共享同一把尺子，600 函数上 digest 交出签名，那两条断言的前提已消失。
// 因此本节改成两半，缺一不可：
//   前半 迁移：digest 在该交签名的地方**确实交出签名**，auto 选它是**正确的**；
//   后半 护栏：另找一个 digest **真的会坍塌**的规模，断言 auto 不选它、退到 map。
// 只保留前半等于把护栏删掉；只保留后半则会把"已经修好的规模"误判成坍塌。
//
// 注意本节必须用**按路径读**的 exec：C7 那节之后 mock 的 readText 一直返回第一个 target，
// 若不换，这里读到的其实是那个 12 行的样例文件，前提断言会以"假失败"的方式报出来。
const synth = (n) => {
  const parts = ['// synthetic', "import { alpha } from './util.mjs'"]
  for (let i = 0; i < n; i += 1) {
    parts.push(
      `/** doc ${i} */`,
      `export function fn_${i}(input, opts) {`,
      `  const scaled = normalize(input) * ${i + 1}`,
      `  logger.debug(labelOf(scaled, opts))`,
      `  return scaled`,
      `}`,
    )
  }
  return parts.join('\n') + '\n'
}
const bigTarget = path.join(tmp, 'big.js')
const byPathCtx = {
  ...liveCtx,
  fs: {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    stat: async (t) => (fs.existsSync(t.targetKey) ? { version } : undefined),
    readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
  },
}
plugin.apply(byPathCtx)
const bigExec = exec

// ---- 前半：迁移后的真实行为（digest 在该交签名的地方交出签名）----
// 前提一：200 函数时 digest 可用，护栏不许误伤这一档
fs.writeFileSync(bigTarget, synth(200), 'utf8')
const s200 = fs.statSync(bigTarget).size
const forced200 = await registered.execute({ file_path: bigTarget, mode: 'digest' }, bigExec)
const body200 = forced200.text ?? ''
const sig200 = body200.split('\n').filter((l) => /^\d+-\d+ \(/.test(l)).length
check(sig200 > 0, `前提：200 函数上显式 digest 交出签名（${sig200} 行，正文 ${body200.length} 字符）`)
// 「交出签名」不能只看非零：真坍塌时剩下的那点正文是固定头，签名行数为 0。
// 这里连体量一起钉：正文必须真的装下了多条签名（一条签名约 60 字符）。
check(sig200 >= 10 && body200.length > 1000, `前提：200 函数的 digest 正文有实质体量（${body200.length} 字符 / 源文件 ${s200}）`)

// 前提二（迁移点）：600 函数上 digest **交出签名**，不再是修复前的一行统计
fs.writeFileSync(bigTarget, synth(600), 'utf8')
const s600 = fs.statSync(bigTarget).size
const forced600 = await registered.execute({ file_path: bigTarget, mode: 'digest' }, bigExec)
const body600 = forced600.text ?? ''
const sig600 = body600.split('\n').filter((l) => /^\d+-\d+ \(/.test(l)).length
check(sig600 > 0, `前提：600 函数上显式 digest 交出签名（${sig600} 行，正文 ${body600.length} 字符）`)
// 合理区间：600 函数受内容预算约束，正文应落在内容预算内、且远大于那条 3897 字符的坍塌态。
// 下界 3897 是同一规模修复前的实测坍塌值（含固定头与首条签名），只做"不再坍塌"的方向断言。
check(body600.length > 3897 && body600.length <= 8192, `前提：600 函数的 digest 正文在合理区间（${body600.length} ∈ (3897, 8192]）`)
// digest 仍然显式说明丢了多少（只是丢的是"更多签名"，不再是"一条都没剩"）
check(String(forced600.omitted ?? '').includes('signatures'), `前提：此时仍显式说明丢了多少：${forced600.omitted}`)

// 迁移点：auto 在 600 函数上选 digest 是**正确的**，理由是可量的倍数
const auto600 = await registered.execute({ file_path: bigTarget }, bigExec)
check(auto600.mode === 'digest', `auto 在 600 函数上选 digest（实际 ${auto600.mode}）`)
check(auto600.text.length > 500, `auto 选出的结果确实有内容（${auto600.text.length} 字符）`)
// 回执里的倍数：引擎拿**渲染前的候选体量**算（digest 3950 vs 源文件 89120），
// 比的是"给整份文件还是给签名表"，而不是两个被内容预算压到同一档的渲染结果。
// 所以这里断言那个理由真的说出来了，而不是拿渲染后长度去反推它。
const autoHead600 = auto600.text.split('\n')[0]
check(auto600.text.includes('smaller than the full text'), `auto 选 digest 的理由可量：${autoHead600.slice(0, 70)}`)
// 反向护栏：拿**渲染后**的 full 当参照，digest 不能比它还大——否则 auto 选 digest 就是纯亏。
// （两者都被内容预算压到同一档，所以这里留 1.1 倍的宽容上界，只拦"选了个明显更贵的"。）
const size600 = (await registered.execute({ file_path: bigTarget, mode: 'full' }, bigExec)).text.length
check(body600.length < size600 * 1.1, `auto 选 digest 不亏：digest 正文 ${body600.length} vs full 正文 ${size600}`)

// ---- 后半：护栏本体——另找一个 digest 真的会坍塌的场景 ----
//
// 为什么不再拿 600 函数演示：600 函数上 digest 覆盖率是 8.5%（已修复），那张"坍塌"已不存在；
// 拿它当护栏要么永远绿（没在测东西），要么把修复后的正确行为当成 bug。
//
// 也**不能**靠把函数数推大来造坍塌：那样 digest 与 map **同时**掉到 1% 以下
// （实测 5000 函数：digest 1.006%、map 0.990%），auto 只能退到 full，
// "退到 map"就断言不了——护栏会变成在测另一件事。
//
// 真正会坍塌的形状不是"函数多"，而是**"声明多、签名少"**：一个大数据模块。
// 实测（14000 行 `export const k_i = [i, i+1]` + 1 个函数，源文件 484777 字节）：
//   digest 渲染 3895 字符 = 源文件的 **0.80%**（只有那一条函数签名，装不下别的）
//   map    渲染 7561 字符 = 源文件的 **1.56%**（能交付）
// digest 比 map 小，但交不出"这个文件是什么"——这正是修复前 auto 会踩的陷阱：
// 旧判据"选最小的"会选中 3895 那个。
const dataModule = (rows) => {
  const parts = ['// generated data module', "import { alpha } from './util.mjs'"]
  for (let i = 0; i < rows; i += 1) parts.push(`export const k${i} = [${i}, ${i + 1}]`)
  parts.push('', 'export function size() {', '  return alpha', '}', '')
  return parts.join('\n')
}
fs.writeFileSync(bigTarget, dataModule(14000), 'utf8')
const sCollapse = fs.statSync(bigTarget).size
const forcedCollapse = await registered.execute({ file_path: bigTarget, mode: 'digest' }, bigExec)
const collapsed = forcedCollapse.text?.length ?? 0
const sigCollapse = (forcedCollapse.text ?? '').split('\n').filter((l) => /^\d+-\d+ \(/.test(l)).length
const mapCollapse = (await registered.execute({ file_path: bigTarget, mode: 'map' }, bigExec)).text.length
const ratioCollapse = collapsed / sCollapse
// 前提（护栏的成立条件一）：这份 digest 真的坍塌——交付率不到源文件的 1%。
// 注意它不是"空壳"（仍有签名行），所以护栏判据必须是**覆盖率**，
// 而不是绝对长度，也不是"有没有签名"：600 函数（8.5%）与这份（0.8%）都交出了签名。
check(collapsed > 0 && ratioCollapse < 0.01, `前提：数据模块上 digest 真的坍塌（正文 ${collapsed} 字符 / 源文件 ${sCollapse} = ${(ratioCollapse * 100).toFixed(2)}% < 1%，仍含 ${sigCollapse} 条签名）`)
// 前提（成立条件二）：map 在同一份文件上是**交付得出来**的那个（≥ 1%），
// 否则"退到 map"这个断言本身不成立（5000 函数时就是这种情况）。
check(mapCollapse >= sCollapse * 0.01, `前提：同一份文件上 map 能交付（${mapCollapse} 字符 = ${((mapCollapse / sCollapse) * 100).toFixed(2)}% ≥ 1%）`)
// 护栏一：auto 不得选中它
const autoCollapse = await registered.execute({ file_path: bigTarget }, bigExec)
check(autoCollapse.mode !== 'digest', `护栏：auto 不选已坍塌的 digest（选中 ${autoCollapse.mode}）`)
// 护栏二：退到哪——同一份候选里 map 才是能交付的那个
check(autoCollapse.mode === 'map', `护栏：auto 退到 map 而不是 full（实际 ${autoCollapse.mode}）`)
check(autoCollapse.text.length > 1000, `护栏：退到的 map 确实有内容（${autoCollapse.text.length} 字符）`)
// 护栏三：回执要说明原因（"比全文小 N 倍"），而不是只给一个模式名
const headCollapse = autoCollapse.text.split('\n')[0]
check(headCollapse.startsWith('(auto: map —'), `护栏：回执说明选择原因：${headCollapse.slice(0, 80)}`)
check(autoCollapse.text.includes('smaller than the full text'), '护栏：回执给出的理由是体量比较，不是只报模式名')

// 不误伤：digest 可用时仍被选中
fs.writeFileSync(bigTarget, synth(200), 'utf8')
const auto200 = await registered.execute({ file_path: bigTarget }, bigExec)
check(auto200.mode === 'digest', `200 函数（digest 可用）仍选 digest（实际 ${auto200.mode}）`)

say('')
say('=== 8. 0.23 实体读 / 目录 grep / 图片 ===')
{
  // 这一节要按路径读、按目录列、按字节读：mock 必须同形，否则测不到那三条路。
  const featureCtx = {
    ...liveCtx,
    fs: {
      resolve: async (p) => ({ displayPath: p, targetKey: p }),
      stat: async (t) => {
        if (!fs.existsSync(t.targetKey)) return undefined
        const st = fs.statSync(t.targetKey)
        return st.isDirectory() ? { type: 'directory', size: 0 } : { type: 'file', version, size: st.size }
      },
      readText: async (t) => fs.readFileSync(t.targetKey, 'utf8'),
      readByteRange: async (t, r) =>
        fs.readFileSync(t.targetKey).subarray(r.offset ?? 0, (r.offset ?? 0) + (r.length ?? 0)),
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
    },
    get: () => undefined,
    tools: { register: (t) => (registered = t), get: () => registered },
    systemPrompt: { section: () => () => {} },
  }
  plugin.apply(featureCtx)

  // 实体读：定义 + 引用 + 证据，正文是实体跨度而不是整份文件。
  const entity = await run({ file_path: target, entity: 'function:total' })
  check(entity.mode === 'entity' && entity.entity?.name === 'total', `实体读 mode=${entity.mode} name=${entity.entity?.name}`)
  check(entity.definition?.body?.includes('sum += it.price'), 'definition 是该实体的正文')
  check(typeof entity.evidence?.spanHash === 'string' && typeof entity.evidence?.version === 'string', 'evidence 带 spanHash 与 version')
  check(Array.isArray(entity.references), '回执带 references 数组')

  // 歧义：两个同名顶层函数 ⇒ needs_choice + 候选，而不是猜一个。
  const dupTarget = path.join(tmp, 'dup.js')
  fs.writeFileSync(dupTarget, ['export function dup() {', '  return 1', '}', '', 'export function dup() {', '  return 2', '}', ''].join('\n'), 'utf8')
  const ambiguous = await run({ file_path: dupTarget, entity: 'function:dup' })
  check(ambiguous.mode === 'entity' && ambiguous.outcome === 'needs_choice', `歧义 outcome=${ambiguous.outcome}`)
  check(Array.isArray(ambiguous.candidates) && ambiguous.candidates.length >= 2, `歧义带 ${ambiguous.candidates?.length} 个候选`)

  // 目录 grep：目录 + search ⇒ 仓库级命中；glob/case_sensitive 生效。
  const grepDir = path.join(tmp, 'grep')
  fs.mkdirSync(grepDir, { recursive: true })
  fs.writeFileSync(path.join(grepDir, 'a.js'), 'const needle = 1\n', 'utf8')
  fs.writeFileSync(path.join(grepDir, 'b.md'), 'NEEDLE elsewhere\n', 'utf8')
  const grep = await run({ file_path: grepDir, search: 'needle' })
  check(grep.mode === 'grep' && grep.text.includes('a.js:1:'), `目录 grep mode=${grep.mode}`)
  check(!grep.text.includes('b.md'), '默认区分大小写：b.md 的 NEEDLE 不命中')
  const grepInsensitive = await run({ file_path: grepDir, search: 'needle', case_sensitive: false, glob: '*.md' })
  check(grepInsensitive.mode === 'grep' && grepInsensitive.text.includes('b.md:1:'), 'case_sensitive:false + glob 只命中 b.md')
  const grepAsMap = await run({ file_path: grepDir })
  check(grepAsMap.mode !== 'grep' && grepAsMap.text.includes('a.js'), '目录无查询词仍是仓库地图')

  // 图片：header-only 元信息；没有附件服务时如实说明省略了字节。
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const imageTarget = path.join(tmp, 'pixel.png')
  fs.writeFileSync(imageTarget, png)
  const image = await run({ file_path: imageTarget })
  check(image.mode === 'image' && image.mime === 'image/png', `图片 mode=${image.mode} mime=${image.mime}`)
  check(image.width === 1 && image.height === 1 && image.bytes === png.length, `图片尺寸 ${image.width}x${image.height} / ${image.bytes} bytes`)
  check(image.attachment === undefined && typeof image.image_data_omitted === 'string', `无附件服务时省略字节：${image.image_data_omitted}`)

  // 附件服务在场：字节存成 ImageAttachmentRef，render 同时给 image block 与元信息文本。
  const saved = []
  plugin.apply({
    ...featureCtx,
    get: (name) =>
      name === 'attachments'
        ? {
            saveImage: async ({ data, mediaType, name }) => {
              saved.push({ bytes: data.length, mediaType, name })
              return { attachmentId: 'att-load-1', mediaType, bytes: data.length, width: 1, height: 1, name }
            },
          }
        : undefined,
  })
  const attached = await run({ file_path: imageTarget })
  check(attached.attachment?.attachmentId === 'att-load-1' && attached.image_data_omitted === undefined, '附件在场时回执带 attachment')
  check(saved.length === 1 && saved[0].mediaType === 'image/png' && saved[0].name === 'pixel.png', 'saveImage 收到原始字节与媒体类型')
  const blocks = registered.output.render({ file_path: imageTarget }, attached)
  check(blocks.length === 2 && blocks[0].type === 'image' && blocks[0].attachment === attached.attachment, 'render 产出 image block + 文本')
  check(blocks[1].type === 'text' && JSON.parse(blocks[1].text).width === 1, '文本 block 是元信息 JSON')

  // 超过上限：只回元信息（不读整份字节、不调用附件服务）。
  const priorCap = process.env.AURA_MAX_IMAGE_BYTES
  process.env.AURA_MAX_IMAGE_BYTES = '10'
  try {
    const capped = await run({ file_path: imageTarget })
    check(capped.attachment === undefined && String(capped.image_data_omitted).includes('10-byte cap'), `超过上限只回元信息：${capped.image_data_omitted}`)
  } finally {
    if (priorCap === undefined) delete process.env.AURA_MAX_IMAGE_BYTES
    else process.env.AURA_MAX_IMAGE_BYTES = priorCap
  }
}

fs.rmSync(tmp, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
