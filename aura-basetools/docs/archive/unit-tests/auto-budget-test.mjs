/**
 * auto-budget-test —— 0.8.2：`auto` 选模式必须用**宿主真实预算**，不是引擎里的固定常数。
 *
 * 判据来自实测（`read-core` 已有的日志读数）：全文明明装得下时给索引，64.6% 会被同轮同文件的
 * 下一次读跟进；装得下给全文只有 17.1%。而“装得下”取决于宿主剪枝器的 `thresholdChars`，
 * 不是本机固定 8192。本套件钉住三件事：
 *   1. `suggestMode(source, file, budget)` 用 `budget - 信封开销` 判全文是否装得下；
 *   2. `readWith({mode:'auto', budget})` 实际选中的模式与之一致；
 *   3. 回执的 `auto` 理由**披露**用的是哪个宿主预算，避免“看起来是全文、其实按旧常数算”。
 *
 * 只走公开 API，不碰缓存内部。跑法：`node src/locator-lab/auto-budget-test.mjs`，全绿 exit 0。
 */
import fs from 'node:fs'
import {
  DEFAULT_ENVELOPE_ALLOWANCE,
  DEFAULT_PRUNE_BUDGET,
  readWith,
  suggestMode,
} from './read-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}

/** 造一份至少 minChars 字符、带一个可索引符号的 JS 源；长度由循环精确累加。 */
function sourceOfAtLeast(minChars) {
  const lines = ['export function alpha() {', '  return 1', '}']
  let length = lines.join('\n').length
  let i = 0
  while (length < minChars) {
    const line = `// filler ${String(i).padStart(5, '0')} ${'x'.repeat(24)}`
    lines.splice(3, 0, line)
    length += line.length + 1
    i += 1
  }
  return lines.join('\n')
}

const FILE = 'auto-budget-fixture.js'
const contentCeiling = (budget) => Math.max(0, budget - DEFAULT_ENVELOPE_ALLOWANCE)

say('=== A. suggestMode：预算决定“全文装不装得下” ===')
{
  const medium = sourceOfAtLeast(6000)
  check('A0 夹具长度落在两个阈之间（3300 < len < 7492）', medium.length > contentCeiling(4000) && medium.length < contentCeiling(DEFAULT_PRUNE_BUDGET), `len=${medium.length} ceilings=${contentCeiling(4000)}/${contentCeiling(DEFAULT_PRUNE_BUDGET)}`)

  const wide = suggestMode(medium, FILE, DEFAULT_PRUNE_BUDGET)
  check('A1 默认预算 8192 ⇒ 全文装得下 ⇒ mode=full', wide.mode === 'full', `${wide.mode}: ${wide.reason}`)
  check('A2 full 的理由披露宿主预算与内容上限', /host budget 8192/.test(wide.reason) && wide.reason.includes(`≤ ${contentCeiling(DEFAULT_PRUNE_BUDGET)}`), wide.reason)

  const narrow = suggestMode(medium, FILE, 4000)
  check('A3 宿主预算 4000 ⇒ 全文装不下 ⇒ 不选 full', narrow.mode !== 'full', `${narrow.mode}: ${narrow.reason}`)
  check('A4 窄预算下仍交付了内容（不是空壳）', (narrow.sizes[narrow.mode] ?? 0) > 0, JSON.stringify(narrow.sizes))

  const large = sourceOfAtLeast(9000)
  const raised = suggestMode(large, FILE, 16384)
  check('A5 大文件 + 宿主预算 16384 ⇒ 全文仍装得下 ⇒ full', raised.mode === 'full', `${raised.mode}: ${raised.reason}`)
  const standard = suggestMode(large, FILE, DEFAULT_PRUNE_BUDGET)
  check('A6 同一份大文件 + 默认预算 ⇒ 不选 full', standard.mode !== 'full', `${standard.mode}: ${standard.reason}`)

  const noBudget = suggestMode(medium, FILE)
  check('A7 不传 budget 时回落到默认 8192（既有调用方不受影响）', noBudget.mode === 'full' && /host budget 8192/.test(noBudget.reason), `${noBudget.mode}: ${noBudget.reason}`)

  // 原始字符数装得下、但加上行号前缀后渲染装不下：不能再说“complete answer”。
  const manyLines = Array.from({ length: 736 }, (_, i) => `// ${String(i).padStart(3, '0')}`).join('\n')
  const rawFits = manyLines.length < contentCeiling(DEFAULT_PRUNE_BUDGET)
  const rendered = suggestMode(manyLines, FILE, DEFAULT_PRUNE_BUDGET)
  check('A8 夹具：原始字符装得下（但渲染不一定）', rawFits, `raw=${manyLines.length} ceiling=${contentCeiling(DEFAULT_PRUNE_BUDGET)}`)
  check(
    'A9 原始装得下但渲染装不下 ⇒ 不得宣称 full/complete',
    !(rendered.mode === 'full' && /complete answer/.test(rendered.reason)),
    `${rendered.mode}: ${rendered.reason}`,
  )
  const autoMany = readWith(manyLines, { mode: 'auto', filePath: FILE, budget: DEFAULT_PRUNE_BUDGET })
  check(
    'A10 auto 若选 full 必须带 omitted（不许把截断卖成完整）',
    autoMany.mode !== 'full' || autoMany.omitted !== undefined,
    `${autoMany.mode} omitted=${autoMany.omitted ?? '(none)'}`,
  )
  const tiny = suggestMode(medium, FILE, 500)
  check(
    'A11 极小预算：不选渲染为 0 的空 full，除非所有模式都为 0 且明确披露',
    tiny.mode !== 'full' || tiny.sizes.full > 0 || /below the minimum envelope/.test(tiny.reason),
    `${tiny.mode}: ${JSON.stringify(tiny.sizes)} — ${tiny.reason}`,
  )
}

say('')
say('=== B. readWith(auto)：实际选中与 suggestMode 一致，并带预算披露 ===')
{
  const medium = sourceOfAtLeast(6000)
  const wide = readWith(medium, { mode: 'auto', filePath: FILE, budget: 8192 })
  check('B1 budget=8192 ⇒ auto 选 full', wide.ok === true && wide.mode === 'full', `${wide.ok}:${wide.mode} auto=${wide.auto ?? ''}`)
  check('B1b auto 的 full 是真全文（不是选型探针留下的 no-change 短回执）', wide.mode === 'full' && wide.text.length > 1000 && wide.omitted === undefined, `text=${wide.text?.length} omitted=${wide.omitted ?? '(none)'}`)
  check('B2 auto 理由披露 host budget 8192', typeof wide.auto === 'string' && /host budget 8192/.test(wide.auto), String(wide.auto))
  check('B3 内容预算不超过宿主预算', Number.isInteger(wide.contentBudget) && wide.contentBudget <= 8192, `contentBudget=${wide.contentBudget}`)

  const narrow = readWith(medium, { mode: 'auto', filePath: FILE, budget: 4000 })
  check('B4 budget=4000 ⇒ auto 不选 full', narrow.ok === true && narrow.mode !== 'full', `${narrow.ok}:${narrow.mode} auto=${narrow.auto ?? ''}`)
  check('B5 窄预算回执仍给可读正文与下一步', typeof narrow.text === 'string' && narrow.text.length > 0 && typeof narrow.next === 'string', `text=${narrow.text?.length} next=${narrow.next ?? ''}`)
  check('B6 内容预算不超过 4000', Number.isInteger(narrow.contentBudget) && narrow.contentBudget <= 4000, `contentBudget=${narrow.contentBudget}`)
}

say('')
say('=== C. 显式 mode 不被预算选择改写（auto 只是默认值） ===')
{
  const medium = sourceOfAtLeast(6000)
  const explicitMap = readWith(medium, { mode: 'map', filePath: FILE, budget: 4000 })
  check('C1 显式 mode=map 仍是 map（预算只影响渲染）', explicitMap.ok === true && explicitMap.mode === 'map', `${explicitMap.ok}:${explicitMap.mode}`)
  const explicitFull = readWith(medium, { mode: 'full', filePath: FILE, budget: 2000 })
  check('C2 显式 mode=full 仍是 full，并如实披露预算裁剪', explicitFull.ok === true && explicitFull.mode === 'full' && (explicitFull.omitted !== undefined || explicitFull.text.length > 0), `${explicitFull.mode} omitted=${explicitFull.omitted ?? '(none)'}`)
}

say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
if (fail > 0) say(`失败 ${fail} 条`)
process.exitCode = fail === 0 ? 0 : 1
