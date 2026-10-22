/**
 * bench.mjs —— 定位策略对比评测。
 *
 * 任务集：在**真实源文件**上圈定真实区域作为 ground truth，并为每个任务准备 0..k 个
 * "模型可能给出的扰动版本"（缩进漂移、改词、重排、少一行、多一行、只记得首行）。每个扰动
 * 都是模型回抄原文时真实会犯的偏差。
 *
 * 策略按**能力签名**建模，而不是按实现建模。签名是一组"模型要提供什么"：
 *   - kind    : 'literal' | 'anchor' | 'struct' | 'candidates'
 *   - pos     : 'exact' | 'near' | 'target' | 'pick'   —— 定位信息怎么给
 *   - multi   : 是否一次调用可提交多个改动点
 *   - shortlist: 是否在不确定时返回候选清单供模型判定
 *
 * 这样"组合"是签名层面的组合，不是把两段代码粘起来——后者是补丁，前者是设计。
 *
 * 三个指标：
 *   准确率  —— 定位到 ground truth 区域；并单列"命中了错的位置"（不可见失败）
 *   输出成本 —— 模型为了表达这次改动**最少**要生成的 token 数（按策略取最小正确表达）
 *   往返    —— 达到确定结果所需的轮数
 */

import fs from 'node:fs'
import path from 'node:path'
import { indexFile, locateWith } from './anchor-core.mjs'
import { indexStructure, resolveTarget, langOf, listSymbols } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const NM = 'E:\\software\\npmlocal\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'

const CORPUS = [
  'dsh-tool-todo/lib/index.js',
  'dsh-fs-observation-policy/lib/index.js',
  'dsh-tool-fs/lib/index.js',
  'dsh-fs-local/lib/index.js',
  'dsh-tool-subagent/lib/index.js',
  'dsh-skill-filesystem/lib/index.js',
  'dsh-agent-presets/lib/index.js',
  'dsh-tool-pwsh/lib/index.js',
].map((r) => path.join(NM, r))

/** 与 patch 插件同一套 token 估算，保证跨策略可比。 */
const est = (s) => Math.round(String(s).length / 3.3)

// ── 任务集：真实文件 + 真实区域 + 扰动变体 ────────────────────────────────

/** 确定性伪随机，保证可复现。 */
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

/**
 * 造任务：先选一个**可符号寻址**的目标，任务的真值就是该符号自身的跨度。
 *
 * 为什么必须"先生成、再验证"，而不是"先取区域、再找符号"：
 * 第一版随机取 3 行再去找"完全落在里面的符号"，结果记录跨度用的是另一个符号，
 * 真值与符号脱钩——`struct` 策略被误判成 100% 命中错位。诊断显示 `resolveTarget`
 * 一直是对的（记录跨度与解析结果逐条一致），错的是任务本身。
 *
 * 因此真值只有一处来源：符号的跨度。区域（用于造扰动）必须落在这个跨度内，否则任务作废。
 */
function buildTasks() {
  const tasks = []
  for (const file of CORPUS) {
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    const lines = src.split('\n')
    const lang = langOf(file)
    if (lang === null) continue
    const struct = indexStructure(src, lang)
    const pkg = path.basename(path.dirname(path.dirname(file)))

    // 候选目标：长度 3..12 行、内容非空、且能用归属限定唯一寻址的符号
    const candidates = struct.symbols.filter((s) => {
      const len = s.endLine - s.startLine + 1
      if (len < 3 || len > 12) return false
      const body = lines.slice(s.startLine - 1, s.endLine)
      return body.every((l) => l.trim().length > 0)
    })

    let taken = 0
    for (const target of candidates) {
      if (taken >= 4) break
      const chain = target.enclosing === null || target.enclosing === target.name ? target.name : `${target.enclosing}/${target.name}`
      // 自检：这条寻址必须真的解析回同一个跨度，否则它不是合法任务
      let resolved
      try {
        resolved = resolveTarget(struct, chain)
      } catch {
        continue
      }
      if (resolved.startLine !== target.startLine || resolved.endLine !== target.endLine) continue

      const text = lines.slice(target.startLine - 1, target.endLine).join('\n')
      if (src.split(text).length !== 2) continue

      tasks.push({
        pkg,
        file,
        symbol: target.name,
        target: chain,
        symbolKind: target.kind,
        // 真值 = 符号跨度本身。这里不再有第二个"记录跨度"。
        startLine: target.startLine,
        endLine: target.endLine,
        truth: text,
      })
      taken += 1
    }
  }
  return tasks
}

// ── 策略实现（每个策略只实现"定位"这一件事）────────────────────────────────

const structCache = new Map()
function structFor(file) {
  if (!structCache.has(file)) {
    const src = fs.readFileSync(file, 'utf8')
    structCache.set(file, { src, index: indexStructure(src, langOf(file)) })
  }
  return structCache.get(file)
}
const anchorCache = new Map()
function anchorFor(file) {
  if (!anchorCache.has(file)) {
    const src = fs.readFileSync(file, 'utf8')
    anchorCache.set(file, { src, index: indexFile(src) })
  }
  return anchorCache.get(file)
}

/**
 * 每条策略返回：
 *   { region:[s,e]|null, wrongSpot, modelTokens, note }
 *
 * 判定标准（**必须对所有策略一视同仁**）：
 *   ok        —— 返回的区域**包含** ground-truth 的 3 行
 *   excess    —— 返回区域比真值多出几行。符号级策略天然返回整个函数，因此它的 ok 高、
 *                excess 也高。这两个数必须**一起看**：只报 ok 会系统性偏袒粗粒度策略，
 *                这正是第一版评测犯的错。
 *   wrongSpot —— 命中了某个位置但不含真值（不可见失败，最危险）
 *
 * 定位信息对等性：所有基于锚点的策略都**不给** `near` 提示——给了一方就是偏袒。
 * 需要提示的策略单独列一行，让"提示"这件事本身可比较。
 */
const STRATEGIES = {
  /** S0 现状：edit —— 逐字节唯一匹配，模型必须复現原文 */
  'edit（现状）': (task) => {
    const { src } = anchorFor(task.file)
    const text = task.variant
    const tokens = est(text) // 只算定位载荷；replace 是所有策略共同的改动载荷，不参与比较
    if (text.trim().length === 0) return { region: null, wrongSpot: false, modelTokens: tokens, note: 'empty' }
    let count = 0
    let i = 0
    while ((i = src.indexOf(text, i)) !== -1) {
      count += 1
      i += text.length
    }
    if (count !== 1) return { region: null, wrongSpot: false, modelTokens: tokens, note: count === 0 ? 'NOT_FOUND' : 'AMBIGUOUS' }
    const at = src.slice(0, src.indexOf(text)).split('\n').length
    return { region: [at, at + text.split('\n').length - 1], wrongSpot: false, modelTokens: tokens, note: 'exact' }
  },

  /** S1 patch：多级锚点匹配，模型仍须给一段原文 */
  'patch（已实现）': (task) => {
    const { index } = anchorFor(task.file)
    const tokens = est(task.variant) // 只算定位载荷
    try {
      const loc = locateWith(index, task.variant, null)
      return { region: [loc.start + 1, loc.end], wrongSpot: false, modelTokens: tokens, note: loc.tier }
    } catch (err) {
      return { region: null, wrongSpot: false, modelTokens: tokens, note: err.code }
    }
  },

  /** S1b patch + near 提示：检验"多给一个行号"值多少 */
  'patch + near 提示': (task) => {
    const { index } = anchorFor(task.file)
    const tokens = est(task.variant) // 只算定位载荷 + 1
    try {
      const loc = locateWith(index, task.variant, task.startLine + 2)
      return { region: [loc.start + 1, loc.end], wrongSpot: false, modelTokens: tokens, note: `${loc.tier}${loc.byNear ? '+near' : ''}` }
    } catch (err) {
      return { region: null, wrongSpot: false, modelTokens: tokens, note: err.code }
    }
  },

  /** S2 struct：模型只给**符号名**，不给任何原文 */
  'struct（仅符号名）': (task) => {
    const { index } = structFor(task.file)
    const tokens = est(task.symbol)
    try {
      const hit = resolveTarget(index, task.target)
      return { region: [hit.startLine, hit.endLine], wrongSpot: false, modelTokens: tokens, note: 'symbol-span' }
    } catch (err) {
      return { region: null, wrongSpot: false, modelTokens: tokens, note: err.code }
    }
  },

  /** S3 struct+域内锚点：符号名缩范围，再在函数体内做锚点匹配 */
  'struct+域内锚点': (task) => {
    const { index } = structFor(task.file)
    const { src } = anchorFor(task.file)
    const tokens = est(task.symbol) + est(task.variant) // 符号名 + 锚点，都是定位载荷
    try {
      const host = resolveTarget(index, task.target)
      const lines = src.split('\n')
      const sub = indexFile(lines.slice(host.startLine - 1, host.endLine).join('\n'))
      const loc = locateWith(sub, task.variant, null)
      return {
        region: [host.startLine + loc.start, host.startLine + loc.end - 1],
        wrongSpot: false,
        modelTokens: tokens,
        note: `scoped:${loc.tier}`,
      }
    } catch (err) {
      return { region: null, wrongSpot: false, modelTokens: tokens, note: err.code }
    }
  },

  /** S4 候选清单：不确定时返回候选，模型只回一个序号 */
  'patch+候选清单': (task) => {
    const { index } = anchorFor(task.file)
    const tokens = 3
    try {
      const loc = locateWith(index, task.variant, null)
      return { region: [loc.start + 1, loc.end], wrongSpot: false, modelTokens: tokens, note: `pick:${loc.tier}` }
    } catch (err) {
      if (err.code === 'PATCH_AMBIGUOUS' && Array.isArray(err.candidates)) {
        const cands = err.candidates.map((line) => ({ line, end: line + task.variant.split('\n').length - 1 }))
        // 模型从清单里挑含真值的那条（等价于它做一次判定）
        const pick = cands.find((c) => c.line <= task.startLine && c.end >= task.startLine)
        if (pick !== undefined) return { region: [pick.line, pick.end], wrongSpot: false, modelTokens: tokens, note: `picked-${cands.length}` }
        return { region: null, wrongSpot: false, modelTokens: tokens, note: `pick-missed-${cands.length}` }
      }
      return { region: null, wrongSpot: false, modelTokens: tokens, note: err.code }
    }
  },

  /** S5 组合拳：符号名 → 域内锚点 → 不确定则候选清单 */
  '组合：struct→域内→清单': (task) => {
    const { index } = structFor(task.file)
    const { src } = anchorFor(task.file)
    const tokens = est(task.symbol) + 3
    try {
      const host = resolveTarget(index, task.target)
      const lines = src.split('\n')
      const sub = indexFile(lines.slice(host.startLine - 1, host.endLine).join('\n'))
      const loc = locateWith(sub, task.variant, null)
      return { region: [host.startLine + loc.start, host.startLine + loc.end - 1], wrongSpot: false, modelTokens: tokens, note: `sym+${loc.tier}` }
    } catch (err) {
      if (err.code === 'PATCH_AMBIGUOUS' && Array.isArray(err.candidates)) {
        // 候选行号是相对函数体的，换算回全局再判定
        const hostStart = structSpanCache.get(`${task.file}::${task.symbol}`)?.start ?? 1
        const global = err.candidates.map((c) => ({ line: hostStart - 1 + c, end: hostStart - 1 + c + task.variant.split('\n').length - 1 }))
        const pick = global.find((c) => c.line <= task.startLine && c.end >= task.startLine)
        if (pick !== undefined) return { region: [pick.line, pick.end], wrongSpot: false, modelTokens: tokens, note: 'sym+picked' }
      }
      return { region: null, wrongSpot: false, modelTokens: tokens, note: err.code }
    }
  },
}

/** 判定：区域是否包含真值，以及多出多少行。 */
function judge(result, task) {
  if (result.region === null) return { ...result, ok: false, wrongSpot: false, excess: 0 }
  const [s, e] = result.region
  const contains = s <= task.startLine && e >= task.endLine
  const overlap = Math.max(0, Math.min(e, task.endLine) - Math.max(s, task.startLine) + 1)
  const excess = Math.max(0, e - s + 1 - (task.endLine - task.startLine + 1))
  return { ...result, ok: contains, wrongSpot: !contains && overlap > 0, excess }
}

// ── 跑 ─────────────────────────────────────────────────────────────────────

const tasks = buildTasks()
say(`任务集：${tasks.length} 个（来自 ${new Set(tasks.map((t) => t.pkg)).size} 个真实文件）`)

// 给每个任务补上符号跨度（struct 策略要按符号定位）
const structSpanCache = new Map()
for (const t of tasks) {
  const key = `${t.file}::${t.symbol}`
  if (!structSpanCache.has(key)) {
    const { index } = structFor(t.file)
    const s = index.symbols.find((x) => x.name === t.symbol)
    structSpanCache.set(key, s === undefined ? null : { start: s.startLine, end: s.endLine })
  }
  const sp = structSpanCache.get(key)
  t.symbolStart = sp === null ? -1 : sp.start
  t.symbolEnd = sp === null ? -1 : sp.end
}

const variants = Object.keys(PERTURB)
const table = new Map()
for (const name of Object.keys(STRATEGIES)) table.set(name, { ok: 0, wrong: 0, err: 0, tokens: 0, excess: 0, excessN: 0, n: 0, notes: new Map() })

for (const task of tasks) {
  for (const v of variants) {
    const t = { ...task, variant: PERTURB[v](task.truth), truthStart: task.startLine }
    for (const [name, fn] of Object.entries(STRATEGIES)) {
      const r = judge(fn(t), task)
      const acc = table.get(name)
      acc.n += 1
      acc.tokens += r.modelTokens ?? 0
      if (r.ok) {
        acc.ok += 1
        acc.excess += r.excess
        acc.excessN += 1
      } else if (r.wrongSpot) acc.wrong += 1
      else acc.err += 1
      const key = r.note ?? '-'
      acc.notes.set(key, (acc.notes.get(key) ?? 0) + 1)
    }
  }
}

// ── 报表 ───────────────────────────────────────────────────────────────────
const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\u3000-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(ch) ? 2 : 1), 0)
const w = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)))

say('')
say(w('策略', 30) + w('找对', 9) + w('明确报错', 11) + w('命中错位', 11) + w('多带行数', 11) + w('输出token', 12) + '相对成本')
say('-'.repeat(96))
const base = table.get('edit（现状）')
const rows = [...table.entries()].map(([name, a]) => ({
  name,
  acc: a.ok / a.n,
  err: a.err / a.n,
  wrong: a.wrong / a.n,
  excess: a.excessN === 0 ? 0 : a.excess / a.excessN,
  tok: a.tokens / a.n,
  rel: a.tokens / base.tokens,
  notes: a.notes,
}))
for (const r of rows) {
  say(
    w(r.name, 30) +
      w(`${(r.acc * 100).toFixed(1)}%`, 9) +
      w(`${(r.err * 100).toFixed(1)}%`, 11) +
      w(`${(r.wrong * 100).toFixed(1)}%`, 11) +
      w(r.excess.toFixed(1), 11) +
      w(r.tok.toFixed(1), 12) +
      `${r.rel.toFixed(2)}x`,
  )
}
say('')
say('注：`多带行数`是"找对时区域比真值平均多出几行"。只报找对率会系统性偏袒粗粒度策略——')
say('    符号级定位天然返回整个函数，找对率必然高，但那不等于它更好用。两个数必须一起看。')

say('')
say('=== 逐扰动分解（找对率）===')
say(w('扰动', 16) + rows.map((r) => w(r.name.slice(0, 15), 17)).join(''))
for (const v of variants) {
  const line = [w(v, 16)]
  for (const name of Object.keys(STRATEGIES)) {
    let ok = 0
    let n = 0
    for (const task of tasks) {
      const t = { ...task, variant: PERTURB[v](task.truth), truthStart: task.startLine }
      const r = judge(STRATEGIES[name](t), task)
      n += 1
      if (r.ok) ok += 1
    }
    line.push(w(`${((ok / Math.max(1, n)) * 100).toFixed(0)}%`, 17))
  }
  say(line.join(''))
}

say('')
say('=== 各策略的失败原因分布 ===')
for (const r of rows) {
  const top = [...r.notes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  say(`  ${w(r.name, 30)} ${top.map(([k, v]) => `${k}×${v}`).join('  ')}`)
}
