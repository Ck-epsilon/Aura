/**
 * name-addressing.mjs —— **符号级寻址的可达面**：`target=<名字>` 在真实语料上能寻到多少、寻不到的为什么。
 *
 * ## 为什么需要量这个
 *
 * `target=` 是本工具最值钱的一层寻址（符号身份不受文本扰动影响，实测对扰动免疫）。
 * 但"值钱"与"可达"是两件事：名字**重名**时 `resolveTarget` 拒绝猜，直接失败。
 * 本探针量出这个比例，并检查**失败回执里有没有给出下一步**——
 * 因为回执是模型唯一的恢复信息（DSH 框架只读 `error.message`）。
 *
 * 实测（本仓 7 个文件 / 659 个符号）：
 *   · 按名直接寻址失败 **165 个（25.0%）**，全部是 `STRUCT_AMBIGUOUS`（重名，如 `tokens`/`i`/`start`）；
 *   · 而这 165 个**全都可以**用 `target=<名字>#<序号>` 或 `target=<名字> near=<行号>` 寻到；
 *   · 修之前，回执印的是 `candidates: line undefined, line undefined`——候选算出来了却没印出来。
 *
 * 运行：node probes/name-addressing.mjs [相对路径…]（缺省用本仓的引擎与壳）
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexStructure, langOf, listSymbols } from '../src/locator-lab/struct-core.mjs'
import { locate } from '../src/locator-lab/locator-api.mjs'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const root = path.join(here, '..')
const DEFAULT_CORPUS = [
  'src/locator-lab/struct-core.mjs',
  'src/locator-lab/read-core.mjs',
  'src/locator-lab/locator-api.mjs',
  'src/locator-lab/write-path.mjs',
  'src/aura-edit/index.js',
  'src/aura-read/index.js',
  'build/make-bundle.mjs',
]

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set([])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/name-addressing.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const CORPUS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_CORPUS

const out = (m) => process.stdout.write(`${m}\n`)
let total = 0
let ok = 0
const byCode = new Map()
const undefinedLines = []
let recoverable = 0
let failed = 0
const samples = []

for (const rel of CORPUS) {
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel)
  if (!fs.existsSync(abs)) continue
  const src = fs.readFileSync(abs, 'utf8')
  const lang = langOf(abs)
  const symbols = listSymbols(indexStructure(src, lang)).filter((s) => s.spanComplete !== false)
  for (const s of symbols) {
    total += 1
    const r = locate(src, { target: s.name, filePath: abs })
    if (r.ok) {
      ok += 1
      continue
    }
    failed += 1
    byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1)
    const text = String(r.message ?? '')
    if (/line undefined/.test(text)) undefinedLines.push(`${rel} :: ${s.name}`)
    if (samples.length < 5) samples.push(`${rel} :: ${s.kind} ${s.name} ⇒ ${r.code}`)
    // 换一条恢复路径试：歧义时用 `#1` 或 `near`，应当能寻到
    const ordinal = locate(src, { target: `${s.name}#1`, filePath: abs })
    const nearby = locate(src, { target: s.name, near: s.startLine, filePath: abs })
    if (ordinal.ok || nearby.ok) recoverable += 1
  }
}

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)
out('')
out(`=== 按名寻址可达面（${CORPUS.length} 个文件 / ${total} 个可寻址符号）===`)
out('')
out(`  直接命中        ${String(ok).padStart(5)}   ${pct(ok, total)}`)
out(`  需要消歧或换层  ${String(failed).padStart(5)}   ${pct(failed, total)}`)
for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) out(`      ${code.padEnd(22)} ${String(n).padStart(5)}`)
out('')
out(`  失败里**可恢复**的（\`#N\` 或 \`near=<行号>\` 能寻到）：${recoverable} / ${failed}`)
out(
  `  失败回执里出现 \`line undefined\` 的：${undefinedLines.length}` +
    (undefinedLines.length === 0 ? '（无 —— 候选形状已归一）' : ' ← 回归！候选没印出行号'),
)
out('')
out('  样本：')
for (const s of samples) out(`    ${s}`)
out('')
out('  结论只在本仓这份语料下成立；换语料请重跑，不要引用单次数字。')
out('')
process.exit(undefinedLines.length === 0 ? 0 : 1)
