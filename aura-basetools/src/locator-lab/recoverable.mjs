/**
 * recoverable.mjs —— 量化"失败时返回符号目录"这条建议值多少。
 *
 * 问题：patch 的失败里，有多少是"符号名可救"的？即真值所在的符号，能否被唯一解析出来。
 * 若能，那么把符号目录作为失败回执返回，就有一条把模型引到正确方向的路。
 *
 * 这是**可救性**的测量，不是"模型会不会用"的测量。后者需要真实模型跑，见文档末尾的说明。
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexFile, locateWith } from './anchor-core.mjs'
import { indexStructure, resolveTarget, langOf } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const NM = 'E:\\software\\npm_local\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'
const NM2 = 'E:\\software\\npmlocal\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'
const root = fs.existsSync(NM2) ? NM2 : NM

const CORPUS = [
  'dsh-tool-todo/lib/index.js',
  'dsh-fs-observation-policy/lib/index.js',
  'dsh-tool-fs/lib/index.js',
  'dsh-fs-local/lib/index.js',
  'dsh-tool-subagent/lib/index.js',
  'dsh-skill-filesystem/lib/index.js',
  'dsh-agent-presets/lib/index.js',
  'dsh-tool-pwsh/lib/index.js',
].map((r) => path.join(root, r))

let seed = 424242
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

const PERTURB = {
  clean: (b) => b,
  reindent: (b) => b.split('\n').map((l) => (l.trim() ? '  ' + l : l)).join('\n'),
  trailingWs: (b) => b.split('\n').map((l) => l + '  ').join('\n'),
  rename: (b) => {
    const m = b.match(/[A-Za-z_$][A-Za-z0-9_$]{4,}/)
    return m === null ? b : b.replace(m[0], m[0].slice(0, -1) + 'X')
  },
  dropLine: (b) => {
    const ls = b.split('\n')
    return ls.length < 3 ? b : [...ls.slice(0, 1), ...ls.slice(2)].join('\n')
  },
  swapLines: (b) => {
    const ls = b.split('\n')
    if (ls.length < 3) return b
    const t = ls[1]
    ls[1] = ls[2]
    ls[2] = t
    return ls.join('\n')
  },
  firstLineOnly: (b) => b.split('\n')[0],
}

const cache = new Map()
function load(file) {
  if (!cache.has(file)) {
    const src = fs.readFileSync(file, 'utf8')
    const lang = langOf(file)
    cache.set(file, {
      src,
      anchor: indexFile(src),
      struct: lang === null ? null : indexStructure(src, lang),
      lines: src.split('\n'),
    })
  }
  return cache.get(file)
}

// ── 建任务（与 bench.mjs 同一套规则，保证可比）────────────────────────────
const tasks = []
for (const file of CORPUS) {
  if (!fs.existsSync(file)) continue
  const { src, struct, lines } = load(file)
  if (struct === null) continue
  const pkg = path.basename(path.dirname(path.dirname(file)))
  // 与 bench.mjs 同一套任务规则：真值 = 可符号寻址的符号跨度本身。
  // 曾经这里是"随机取 3 行"，于是两份报告的任务集不同源，数字没法互相印证。
  const candidates = struct.symbols.filter((s) => {
    const len = s.endLine - s.startLine + 1
    if (len < 3 || len > 12) return false
    return lines.slice(s.startLine - 1, s.endLine).every((l) => l.trim().length > 0)
  })
  let taken = 0
  for (const target of candidates) {
    if (taken >= 4) break
    const chain = target.enclosing === null || target.enclosing === target.name ? target.name : `${target.enclosing}/${target.name}`
    const text = lines.slice(target.startLine - 1, target.endLine).join('\n')
    if (src.split(text).length !== 2) continue
    tasks.push({ pkg, file, symbol: target.name, target: chain, startLine: target.startLine, endLine: target.endLine, truth: text })
    taken += 1
  }
}

say(`任务集：${tasks.length} 个（与 bench.mjs 同源）`)
say('')

// ── 测量：patch 失败的用例里，有多少是"符号名可救"的 ──────────────────────
let total = 0
let patchFail = 0
let recoverable = 0
const byPerturb = new Map()

for (const task of tasks) {
  const { anchor, struct } = load(task.file)
  for (const [v, fn] of Object.entries(PERTURB)) {
    const variant = fn(task.truth)
    total += 1
    let failed = false
    try {
      const loc = locateWith(anchor, variant, null)
      const contains = loc.start + 1 <= task.startLine && loc.end >= task.endLine
      if (!contains) failed = true
    } catch {
      failed = true
    }
    if (!failed) continue
    patchFail += 1

    // 可救性：真值所在的符号能否被唯一解析？
    let canRecover = false
    try {
      const hit = resolveTarget(struct, task.symbol)
      canRecover = hit.startLine <= task.startLine && hit.endLine >= task.endLine
    } catch {
      canRecover = false
    }
    if (canRecover) recoverable += 1

    const k = v
    if (!byPerturb.has(k)) byPerturb.set(k, { fail: 0, rec: 0 })
    const b = byPerturb.get(k)
    b.fail += 1
    if (canRecover) b.rec += 1
  }
}

const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(0)}%`)
say('=== patch 失败用例的可救性 ===')
say(`总用例 ${total}   patch 失败 ${patchFail} (${pct(patchFail, total)})`)
say(`其中符号名可救 ${recoverable}  →  占失败的 ${pct(recoverable, patchFail)}，占总用例 ${pct(recoverable, total)}`)
say('')
say('逐扰动：')
for (const [v, b] of byPerturb) {
  say(`  ${v.padEnd(16)} 失败 ${String(b.fail).padStart(3)}   可救 ${String(b.rec).padStart(3)}   ${pct(b.rec, b.fail)}`)
}

say('')
say('=== 判读 ===')
say('若"可救率"高，说明失败回执里附上符号目录，能把模型从"重猜一整段原文"引到"用符号名重试"。')
say('注意这只是**可救性**：它不证明模型会去用那份目录。那需要真实模型跑，见 FINDINGS.md 的偏袒说明。')
