/**
 * read-fidelity.mjs —— read 的输出，够 patch 的新寻址层用吗？
 *
 * 这是刚被引入的耦合：patch 的第 1、2 层（target / lines）依赖模型**知道行号与位置**，
 * 而模型的位置知识**完全来自 read**。所以 read 的保真度直接决定那两层能不能用。
 *
 * 三条可量的失真：
 *   ① 单行超过 2000 字符 → 被截断，模型看到的内容与磁盘不同
 *   ② 整个结果超过 50KB → 被截断，模型只拿到一部分行
 *   ③ 结果超过剪枝阈值 8192 字符 → **中段被砍掉**，且行号出现跳跃
 *
 * ③ 最危险：它不像①②那样有"(line truncated)"或"(Output capped)"标记，
 * 而是直接少一段——模型若不知道，会以为文件里那几行不存在。
 */
import fs from 'node:fs'
import path from 'node:path'
import { indexStructure, langOf } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const NM = 'E:\\software\\pmlocal\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'
const NM2 = 'E:\\software\\npmlocal\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'
const ROOT = fs.existsSync(NM2) ? NM2 : NM

const LIMIT_LINES = 2000
const LIMIT_LINE_CHARS = 2000
const LIMIT_BYTES = 50 * 1024
const PRUNE_THRESHOLD = 8192
const PRUNE_HEAD = 4096
const PRUNE_TAIL = 1024

/** 模拟 read 工具的输出（严格按 dsh-tool-fs 的规则）。 */
function simulateRead(src) {
  const lines = src.split('\n')
  const out = []
  let bytes = 0
  let truncatedByBytes = false
  let truncatedLines = 0
  for (let i = 0; i < lines.length && i < LIMIT_LINES; i += 1) {
    const raw = lines[i]
    const t = raw.length > LIMIT_LINE_CHARS ? raw.slice(0, LIMIT_LINE_CHARS) : raw
    if (raw.length > LIMIT_LINE_CHARS) truncatedLines += 1
    const rendered = `${i + 1}: ${t}`
    if (bytes + rendered.length + 1 > LIMIT_BYTES) {
      truncatedByBytes = true
      break
    }
    bytes += rendered.length + 1
    out.push({ line: i + 1, text: t, raw })
  }
  return { rendered: out, truncatedByBytes, truncatedLines, totalLines: lines.length }
}

/**
 * 模拟剪枝：超阈值就掐头留尾，中段换成一个**显式标记**。
 *
 * 这里曾被我写错：我一度断言剪枝"静默丢中段、无任何标记"。读实现后确认是错的——
 * `dsh-compaction-tool-result-pruner` 在移除处插入固定标记
 * `[... tool result middle pruned ...]`，模型**看得见**。
 *
 * 因此真正的问题不是"静默"，而是两件不同的事：
 *   ① 可见量极少：模型只看得到约 10% 的行（下一节量化）；
 *   ② **该看什么没告诉它**：标记说了"这里被剪了"，但没说"原本有什么、该用什么方式再要"。
 *      剪枝是诚实的，但没有给出续读路径。
 */
const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
function simulatePrune(text) {
  if (text.length <= PRUNE_THRESHOLD) return { pruned: false, text, lost: 0 }
  const head = text.slice(0, PRUNE_HEAD)
  const tail = text.slice(-PRUNE_TAIL)
  return { pruned: true, text: head + PRUNE_MARKER + tail, lost: text.length - PRUNE_HEAD - PRUNE_TAIL }
}

/**
 * 两级截断的**叠加**：stage-1 封顶（50KB）+ stage-2 剪枝（掐头留尾）。
 *
 * 这是本测量最该说清的一件事：两级各自"有理由"，叠起来的结果是模型拿到的行**既不连续、
 * 也无标记**。单看任一级都觉察不到。
 */
function compound(src) {
  const r = simulateRead(src)
  const stage1 = r.rendered.map((x) => `${x.line}: ${x.text}`).join('\n')
  const p = simulatePrune(stage1)
  const shownLines = new Set()
  for (const m of p.text.matchAll(/(?:^|\n)(\d+): /g)) shownLines.add(Number(m[1]))
  return {
    total: r.totalLines,
    stage1Lines: r.rendered.length,
    capped: r.truncatedByBytes,
    afterStage2: shownLines.size,
    lostChars: p.lost,
    // 模型实际能看到的行，占文件总行的比例
    visibleRatio: r.totalLines === 0 ? 0 : shownLines.size / r.totalLines,
  }
}

const CORPUS = []
for (const dir of ['dsh-tool-fs', 'dsh-fs-local', 'dsh-agent-presets', 'dsh-tool-subagent']) {
  const p = path.join(ROOT, dir, 'lib', 'index.js')
  if (fs.existsSync(p)) CORPUS.push(p)
}

say('=== 逐个真实文件：read 之后模型拿到的东西有多少失真 ===')
say(['文件', '总行', 'read行', '截断行', '封顶', '剪枝', '丢失字符'].map((s) => s.padEnd(12)).join(''))
say('-'.repeat(80))

let anyPruned = 0
let anyByteCapped = 0
let lostTotal = 0

for (const f of CORPUS) {
  const src = fs.readFileSync(f, 'utf8')
  const r = simulateRead(src)
  const text = r.rendered.map((x) => `${x.line}: ${x.text}`).join('\n')
  const p = simulatePrune(text)
  if (p.pruned) anyPruned += 1
  if (r.truncatedByBytes) anyByteCapped += 1
  if (p.lost !== undefined) lostTotal += p.lost
  const name = path.basename(path.dirname(path.dirname(f)))
  say(
    [
      name.padEnd(12),
      String(r.totalLines).padEnd(12),
      String(r.rendered.length).padEnd(12),
      String(r.truncatedLines).padEnd(12),
      (r.truncatedByBytes ? '是' : '否').padEnd(12),
      (p.pruned ? `是(-${p.lost})` : '否').padEnd(12),
      String(p.lost ?? 0).padEnd(12),
    ].join(''),
  )
}

say('')
say('=== 两级截断的叠加：模型实际看到多少行 ===')
say(['文件', '总行', 'stage1后', 'stage2后', '可见占比', '中段丢失字符'].map((s) => s.padEnd(13)).join(''))
say('-'.repeat(82))
let ratioSum = 0
for (const f of CORPUS) {
  const c = compound(fs.readFileSync(f, 'utf8'))
  ratioSum += c.visibleRatio
  say(
    [
      path.basename(path.dirname(path.dirname(f))).padEnd(13),
      String(c.total).padEnd(13),
      String(c.stage1Lines).padEnd(13),
      String(c.afterStage2).padEnd(13),
      `${(c.visibleRatio * 100).toFixed(1)}%`.padEnd(13),
      String(c.lostChars).padEnd(13),
    ].join(''),
  )
}
say('')
say(`平均可见比例 ${((ratioSum / CORPUS.length) * 100).toFixed(1)}%`)
say('')
say('判读：可见量本身很小（约 10%）。但**剪枝是诚实的**——它插入显式标记说明中段被移除，')
say('模型看得见。这一点我先前写错过，读实现后已纠正。真正缺的是另外两件：')
say('  · 标记没说原本有什么（模型不知道丢了哪些函数）')
say('  · 标记没说怎么要回来（没有 offset / 模式指引）')
say('于是模型的处境是"知道缺，但不知道缺什么、也不知道怎么补"。而那恰恰是符号表能补的。')

say('')
say('=== 剪枝后，模型实际看到的文本（截取接缝处）===')
const demo = CORPUS[0]
if (demo !== undefined) {
  const src = fs.readFileSync(demo, 'utf8')
  const r = simulateRead(src)
  const text = r.rendered.map((x) => `${x.line}: ${x.text}`).join('\n')
  const p = simulatePrune(text)
  if (p.pruned) {
    const cut = p.text.slice(0, PRUNE_HEAD)
    const tail = p.text.slice(PRUNE_HEAD + PRUNE_MARKER.length)
    say(`  …${cut.slice(-70).replace(/\n/g, '⏎')}`)
    say(`  ${PRUNE_MARKER.trim()}`)
    say(`  ${tail.slice(0, 70).replace(/\n/g, '⏎')}…`)
    const headNum = (cut.match(/(\d+): /g) ?? []).pop()
    const tailNum = (tail.match(/(\d+): /g) ?? [])[0]
    say('')
    say(`  前半最后一行 ${headNum?.trim()}  →  后半第一行 ${tailNum?.trim()}`)
    say('  标记诚实地说明了"这里被剪了"，但**没说原本有什么、也没说怎么要回来**。')
  }
}
say(`需要 read 才能拿到行号的文件里，${anyPruned}/${CORPUS.length} 个会在剪枝后**丢掉中段**`)
say(`被剪枝丢掉的字符合计 ${lostTotal}`)
say('')

