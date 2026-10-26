/**
 * export-surface-test —— `map` 必须把**导出面**当作一等公民（T25）。
 *
 * ## 分形原则：边界不随体积增长
 *
 * 分形几何的要点不是自相似好看，而是**界面量级受控**：单元在每一层暴露定长界面，
 * 于是体积变大**不带来线性增长的结构成本**。代码里对应的东西就是**导出面**——
 * 一个文件再大，"它给别人什么"通常仍是常数个名字。
 *
 * ## 现状的问题（实测）
 *
 * `map` 里导出只是一个 `★` 标记，混在符号列表里。于是：
 *   · 一个 1385 行 / 142 符号的文件，要回答"这个模块对外提供什么"必须**读完整个目录**再自己筛**；
 *   · 实测本仓库最大的目录是 `build/upgrade-test.mjs`（159 符号），而一个 10135 行 / 1727 符号的
 *     文件（日志里真实存在）更是几乎不可回答。
 * 也就是说：**理解一个模块的代价随体积线性增长，而不是随模块数增长。**
 *
 * 而 T7 修好之前，`export const` 连索引都进不了——**边界本身是被弄丢的**。
 * 所以这一条是 T7 的直接兑现：边界先要**存在**，然后要**被突出**。
 *
 * ## 本文件测什么
 *
 * 1. 导出**全部**出现在输出里（不被内部符号挤掉预算）；
 * 2. 导出段**位于**内部符号之前（读前几行即可拿到公共接口）；
 * 3. 导出面有自己的**计数与标题**，"这个模块给别人什么"可常数成本回答；
 * 4. 非导出符号仍然可见（不能为了突出导出而丢掉内部结构）。
 */
import { readWith } from './read-core.mjs'
import { listSymbols, indexStructure, langOf } from './struct-core.mjs'

const say = (m) => process.stdout.write(m + '\n')
const results = []
const check = (label, ok, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

/** 造一个"导出多、内部更多"的合成文件：这是本条的靶子形态。 */
const synth = () => {
  const out = []
  for (let i = 0; i < 8; i += 1) out.push(`export const PUB${i} = ${i}`)
  for (let i = 0; i < 40; i += 1) out.push(`function internal${i}(a) {\n  const local${i} = a\n  return local${i}\n}`)
  return out.join('\n')
}

say('=== 1. 导出面必须全部出现，且排在内部符号之前 ===')
{
  const src = synth()
  const r = readWith(src, { filePath: 'x.mjs', mode: 'map' })
  const text = String(r.text)
  const exported = listSymbols(indexStructure(src, langOf('x.mjs'))).filter((s) => s.name.startsWith('PUB'))
  check(`合成文件里有 ${exported.length} 个导出`, exported.length === 8)

  const missing = exported.filter((s) => !text.includes(s.name))
  check('8 个导出全部出现在 map 输出里', missing.length === 0, missing.map((s) => s.name).join(','))
}

say('')
say('=== 2. 导出段的位置：必须在内部符号之前 ===')
{
  const src = synth()
  const r = readWith(src, { filePath: 'x.mjs', mode: 'map' })
  const text = String(r.text)
  const firstExport = text.indexOf('PUB0')
  const firstInternal = text.indexOf('internal0')
  check('导出段出现在内部符号之前', firstExport >= 0 && (firstInternal < 0 || firstExport < firstInternal), `export@${firstExport} internal@${firstInternal}`)
}

say('')
say('=== 3. 导出面有自己的标题与计数（常数成本回答"它给别人什么"）===')
{
  const src = synth()
  const r = readWith(src, { filePath: 'x.mjs', mode: 'map' })
  const text = String(r.text)
  check('输出里有导出面的标题', /exported/i.test(text), text.split('\n').slice(0, 4).join(' ⏎ '))
  const firstLines = text.split('\n').slice(0, 12).join('\n')
  const shownInHead = ['PUB0', 'PUB7'].filter((n) => firstLines.includes(n))
  check('前 12 行里已能看到导出面（不必读完整目录）', shownInHead.length === 2, JSON.stringify(shownInHead))
}

say('')
say('=== 4. 非导出符号不得因为突出导出而消失 ===')
{
  const src = synth()
  const r = readWith(src, { filePath: 'x.mjs', mode: 'map' })
  const text = String(r.text)
  check('内部函数仍然列出（至少一个）', /internal\d/.test(text))
  check('嵌套局部量仍被如实报为 omitted 或未列出', !/local0\s+\d/.test(text) || /nested locals omitted/.test(String(r.omitted)), String(r.omitted).slice(0, 80))
}

say('')
say('=== 5. 真实文件上的抽查：导出面是否可数 ===')
{
  const src = [
    "export const A = 1",
    "export function f() { return A }",
    "const privateThing = 2",
    "function helper() { return privateThing }",
    "export type T = number",
  ].join('\n')
  const r = readWith(src, { filePath: 'x.ts', mode: 'map' })
  const text = String(r.text)
  for (const name of ['A', 'f', 'T']) check(`导出 ${name} 在输出里`, text.includes(name))
  const firstPrivate = text.indexOf('privateThing')
  const lastExport = Math.max(text.indexOf('T'), text.indexOf('f('), text.indexOf('f '))
  check(
    '非导出的 privateThing 排在导出之后',
    firstPrivate >= 0 && firstPrivate > lastExport,
    `private@${firstPrivate} lastExport@${lastExport}`,
  )
}

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
