/**
 * probe-modes.mjs —— auto 的选择规则到底是不是可复述、可预测的？
 *
 * 两问：
 *   Q1 同一输入两次调用 suggestMode，结论是否逐字节一致（含 reason / sizes）？
 *   Q2 在真实文件 + 合成文件谱系上，选择的转折点在哪、是不是一条可写下来的规则？
 *
 * 另：七模式里哪些在真实会话里从未被显式选过（配合 adoption-stats.mjs 的分布读）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { suggestMode, MODES, readWith } from '../src/locator-lab/read-core.mjs'
import { CONTENT_BUDGET } from '../src/locator-lab/read-core.mjs'
import { langOf } from '../src/locator-lab/struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)

// ── Q1 确定性 ──────────────────────────────────────────────────────────────
const real = []
const roots = ['E:\\workspaces\\agent-browser-bridge', 'E:\\workspaces\\deepseekharness']
for (const r of roots) {
  const walk = (d, depth) => {
    if (depth > 3) return
    let es
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '__pycache__') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.(mjs|js|py|ts)$/.test(e.name)) {
        try {
          const st = fs.statSync(p)
          if (st.size > 400 && st.size < 400000) real.push(p)
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(r, 0)
}
say(`=== Q1 auto 的确定性（真实文件 ${real.length} 个，每个各调两次）===`)
let same = 0
let diff = 0
const diffs = []
for (const f of real.slice(0, 220)) {
  const src = fs.readFileSync(f, 'utf8')
  const a = suggestMode(src, f)
  const b = suggestMode(src, f)
  if (JSON.stringify(a) === JSON.stringify(b)) same += 1
  else {
    diff += 1
    if (diffs.length < 5) diffs.push({ f, a: a.mode, b: b.mode })
  }
}
say(`  两次结论一致：${same}；不一致：${diff}`)
for (const d of diffs) say(`    ${path.basename(d.f)}: ${d.a} vs ${d.b}`)

// ── Q2 转折点 ─────────────────────────────────────────────────────────────
say('')
say(`=== Q2 选择规则的转折点（CONTENT_BUDGET=${CONTENT_BUDGET}，全文门槛 = 25% = ${Math.floor(CONTENT_BUDGET * 0.25)} 字符）===`)
const mk = (nFn) => {
  const parts = ['// synthetic; each function is distinct']
  for (let i = 0; i < nFn; i += 1) {
    parts.push(
      [
        `/** doc for fn_${i}: returns a value derived from input ${i} */`,
        `export function fn_${i}(input, opts) {`,
        `  const scaled = input * ${i + 1}`,
        `  const label = 'fn_${i}-' + String(scaled)`,
        `  if (opts && opts.strict) return { label, scaled, strict: true }`,
        `  return { label, scaled, strict: false }`,
        `}`,
      ].join('\n'),
    )
  }
  return parts.join('\n\n') + '\n'
}
const tmp = path.join(os.tmpdir(), `mode-probe-${Date.now()}.mjs`)
say('  合成谱系（函数个数 → 文件字符数 → 选中模式 → 理由）：')
for (const n of [1, 2, 3, 4, 6, 8, 12, 20, 40, 80, 160, 320]) {
  const src = mk(n)
  fs.writeFileSync(tmp, src, 'utf8')
  const r = suggestMode(src, tmp)
  say(`    ${String(n).padStart(4)} fn  ${String(src.length).padStart(7)} chars  →  ${r.mode.padEnd(7)} ${r.reason}`)
}
fs.unlinkSync(tmp)

// ── 七模式里哪些"设计过但没被显式用过" ──────────────────────────────────────
say('')
say(`=== 七模式清单（对照 adoption-stats 的显式 mode 分布）===`)
say(`  ${MODES.join(' / ')}`)
const nonJs = ['E:\\workspaces\\agent-browser-bridge\\bridge\\http_api.py', 'E:\\workspaces\\deepseekharness\\locator-lab\\read-core.mjs'].filter((p) => fs.existsSync(p))
say('')
say('  同一份内容在"支持的语言"与"不支持的扩展名"下的差别（map/digest 是否降级）：')
for (const p of nonJs) {
  const src = fs.readFileSync(p, 'utf8')
  const ok = suggestMode(src, p)
  const bad = suggestMode(src, `${p}.unknown`)
  say(`    ${path.basename(p)}  (lang=${langOf(p)?.name ?? 'null'})  →  ${ok.mode}  ／ 改扩展名后  →  ${bad.mode}`)
}

// ── Q3 被 auto 选中的模式，渲染出来到底多长（怀疑大文件上 digest 名不副实）──
say('')
say('=== Q3 各模式渲染实测长度（合成谱系）===')
const tail = (t) => (t ?? '').trimEnd().split('\n').slice(-1)[0].slice(0, 70)
say('   fn数   文件chars   full      map      digest   digest尾行')
for (const n of [20, 80, 160, 240, 320, 600]) {
  const src = mk(n)
  fs.writeFileSync(tmp, src, 'utf8')
  const m = readWith(src, { filePath: tmp, mode: 'map' })
  const d = readWith(src, { filePath: tmp, mode: 'digest' })
  const f = readWith(src, { filePath: tmp, mode: 'full' })
  say(
    `  ${String(n).padStart(4)}  ${String(src.length).padStart(8)}  ${String(f.text?.length ?? 0).padStart(6)}  ${String(m.text?.length ?? 0).padStart(6)}  ${String(d.text?.length ?? 0).padStart(6)}   ${tail(d.text)}`,
  )
}
fs.unlinkSync(tmp)
