/**
 * weight-profile.mjs —— 把"重尾"从结论变成**可复跑的表**（T27）。
 *
 * ## 为什么要把它落在 probes/ 里
 *
 * T27 的结论（"优化靶子在重尾头部"）**被证伪了一半**，而那个结论来自一次一次性分析：
 * 脚本当时只在临时目录里。一次性分析与它的结论不能分开验证——所以这里把它变成
 * `probes/` 下的常驻探针，与 `adoption-stats.mjs` 同口径（共用 `session-log.mjs` 的读取，
 * **不另起第二个统计入口**）。
 *
 * ## 实测结论（本机快照，2026-09-28）
 *
 * 扫描 433 份会话日志、27,891 次相关调用（`aura_read`/`aura_edit`/`read`/`edit`/`write`），
 * 其中 24,191 次能归属到规模桶。四条要点：
 *
 * 1. **集中度极高**：Gini 0.827；**单个文件吸收 9.8% 的调用**（`background.js`，10,467 行 / 113 会话）；
 *    17 个文件（0.8%）吸收 29.7%；97 个文件吸收一半的输出字符。
 * 2. **失败率与文件大小无关**（这条推翻了 T27 原本的猜想）：
 *    `aura_read` 在各桶为 0.66 / 0.92 / 0.77 / 0.71 / **0.30**%（最大桶最低）；
 *    `aura_edit` 也是平的（15.0 / 14.5 / 15.0 / 17.7 / 14.4%）。
 *    按规模十分位看同样无单调趋势（4.6 / 0.9 / 3.1 / 2.5 / 3.8 / 4.1 / 4.9 / 5.2 / 5.5 / 4.3%）。
 * 3. **真正退化的是"每次调用交付多少信息"**：读 >10000 行的文件只给出 **0.61%** 的内容，
 *    而 <200 行的文件给 59%；每文件行的载荷从 24.54 字符降到 0.41；载荷 p99 在每个桶都钉在
 *    **~7,800 字符**（硬上限，实测最大 7,870，从未越过 8,192）。
 * 4. **失败的大头在写不在读**：桶内 859 个错误里 **797 个（93%）是 `aura_edit`**，
 *    且与文件大小无关 → 优化的靶子是写侧，不是大文件。
 *
 * ## 边界（不要过度解读）
 *
 * - `>=10000` 桶**只有一个文件**（`background.js`），关于它的一切都是关于一个项目的文件，n=670 次读。
 * - 语料主要是两个项目（87.7% 的调用来自 `agent-browser-bridge` 与 `AuraPolaris`）。
 * - 44.5% 的引用路径已不存在（临时目录），被排除；而排除**不中性**——被排除的调用失败率 6.4%，
 *   桶内 1.1%。所以上面的失败率偏向乐观。
 * - 行数是**今天**量的，不一定是调用当时的。
 * - 语料是活的：本会话自己也在被记录，所以两次运行的总数会不同——**引用快照，不要引用单次复跑**。
 *
 * 用法：`node probes/weight-profile.mjs [--csv <路径>]`
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSessionsDetailed } from './session-log.mjs'

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 位置很重要：必须紧贴 import、在**读会话库之前** —— 本探针顶层就要把整库读进来，
// 闸放在下游等于让一次拼错的调用先付几十秒内存再说（实测：跑到一半 V8 堆爆、exit 134）。
// 已知旗标（`--csv`）语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--csv'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（probes/weight-profile.mjs）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))

const TOOLS = /^(aura_read|aura_edit|read|edit|write)$/
const BUCKETS = [
  ['<200', 0, 200],
  ['200-500', 200, 500],
  ['500-2000', 500, 2000],
  ['2000-10000', 2000, 10000],
  ['>=10000', 10000, Number.POSITIVE_INFINITY],
]

const say = (m) => fs.writeSync(1, `${m}\n`)

/**
 * 失败判据：**用读取器已经算好的结构化字段**。
 *
 * 先前那轮一次性分析用的是文本规则（回执以 `Error:` 开头或含 `returned invalid output`），
 * 而它**会误计**：本工具自己的源码里就包含这两串字面量，读自己的源码时会被当成失败
 * （实测多算 16 次）。这里直接用 `calls[i].isError`，不再重算。
 */
const badOf = (c) => c.isError === true


function lineCountOf(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').length
  } catch {
    return null
  }
}

/**
 * 被测版本指纹（T19）。
 *
 * 本项目的源码变动快于测量：本轮就发生过两次因源码被改写而误报状态
 * （把已修好的报成未修、把"中间层丢弃"报成"已无"）。所以任何测量输出都必须
 * 带上**被测文件的哈希**——结论只在该哈希下有效，否则它只是复述。
 */
function engineFingerprint() {
  // 用 fileURLToPath 而不是手改 URL 的 pathname：后者在 Windows 上会留下 `/E:/...` 这样的前缀，
  // `path.join` 于是解析不到文件（实测第一版三个哈希全是 `?`）。
  const here = path.dirname(fileURLToPath(import.meta.url))
  // 从 `probes/` 回到仓库根再进 `src/`（相对路径拼接在 Windows 上曾静默失败，三个哈希全是 `?`，
  // 所以这里把路径写清楚并**在取不到时报错而不是略过**——静默的 `?` 等于没有指纹）。
  const root = path.dirname(here)
  const files = ['src/locator-lab/struct-core.mjs', 'src/locator-lab/read-core.mjs', 'src/aura-edit/index.js']
  const out = []
  for (const rel of files) {
    try {
      const p = path.join(root, rel)
      const h = createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12)
      out.push(`${path.basename(p)}=${h}`)
    } catch (error) {
      // **不吞错误**：把原因带上。第一版是裸 `catch {}` → 三个 `?` 让你无法区分
      // “文件不在那”与“导入写错了”（实测就是后者：`createHash` 没导进来）。
      out.push(`${path.basename(rel)}=?(${error.code ?? error.message})`)
    }
  }
  return out.join(' ')
}

const sessions = readSessionsDetailed()
say(`=== 被测版本（结论只在该哈希下有效）===`)
say(`  ${engineFingerprint()}`)
say('')
const calls = []
for (const s of sessions) {
  for (const c of s.calls ?? []) {
    if (!TOOLS.test(c.name)) continue
    calls.push(c)
  }
}

let attributed = 0
let missing = 0
const byFile = new Map()
for (const c of calls) {
  const p = c.args?.file_path
  if (typeof p !== 'string' || p.length === 0) {
    missing += 1
    continue
  }
  if (!byFile.has(p)) byFile.set(p, { calls: 0, read: 0, readErr: 0, edit: 0, editErr: 0, payloads: [] })
  const rec = byFile.get(p)
  rec.calls += 1
  const bad = badOf(c)
  if (c.name === 'aura_read') {
    rec.read += 1
    if (bad) rec.readErr += 1
    // 注意：读取器不提供回执长度，所以这里**不报载荷**。
    // 先前那轮的载荷数字（p99 钀이在 ~7,800）需要自己解析日志才能得到，
    // 而那样做等于在第二个入口重实现一遍读取——本项目明确禁止（口径会漂）。
    // 载荷结论因此以注释形式记录在本文件头部，不在这里重算。
  }
  if (c.name === 'aura_edit') {
    rec.edit += 1
    if (bad) rec.editErr += 1
  }
}

say('=== 语料 ===')
say(`  会话 ${sessions.length} 份 · 相关调用 ${calls.length} 次 · 引用路径 ${byFile.size} 个`)

// 行数（只算今天还在的文件）
const rows = []
for (const [p, rec] of byFile) {
  const lines = lineCountOf(p)
  if (lines === null) {
    missing += rec.calls
    continue
  }
  const bucket = BUCKETS.find(([, lo, hi]) => lines >= lo && lines < hi)
  if (bucket === undefined) continue
  rows.push({ p, lines, bucket: bucket[0], ...rec })
  attributed += rec.calls
}
say(`  能归属到规模桶 ${attributed} 次 · 排除 ${missing} 次（文件已不存在或无路径）`)
say('')

say('=== 集中度 ===')
const sorted = [...rows].sort((a, b) => b.calls - a.calls)
const totalCalls = rows.reduce((n, r) => n + r.calls, 0)
for (const k of [1, 5, 10, 25, 50]) {
  const share = sorted.slice(0, k).reduce((n, r) => n + r.calls, 0) / totalCalls
  say(`  前 ${String(k).padStart(2)} 个文件 = ${(share * 100).toFixed(1)}% 的调用`)
}
{
  // Gini（只看有调用的文件）
  const xs = sorted.map((r) => r.calls).sort((a, b) => a - b)
  const n = xs.length
  const sum = xs.reduce((a, b) => a + b, 0)
  let acc = 0
  for (let i = 0; i < n; i += 1) acc += (i + 1) * xs[i]
  say(`  Gini（调用次数）= ${((2 * acc) / (n * sum) - (n + 1) / n).toFixed(3)}`)
}
say('')

say('=== 按规模桶：失败率与交付量（T27 的核心表）===')
say('  桶           文件   调用   占比   | aura_read 失败 | aura_edit 失败 | 写侧占比')
for (const [label] of BUCKETS) {
  const g = rows.filter((r) => r.bucket === label)
  if (g.length === 0) continue
  const c = g.reduce((n, r) => n + r.calls, 0)
  const rd = g.reduce((n, r) => n + r.read, 0)
  const rdE = g.reduce((n, r) => n + r.readErr, 0)
  const ed = g.reduce((n, r) => n + r.edit, 0)
  const edE = g.reduce((n, r) => n + r.editErr, 0)
  say(
    `  ${label.padEnd(11)} ${String(g.length).padStart(4)} ${String(c).padStart(6)} ` +
      `${((c / totalCalls) * 100).toFixed(1).padStart(5)}% | ` +
      `${rd === 0 ? '     n/a' : `${((rdE / rd) * 100).toFixed(2).padStart(5)}%`} (n=${String(rd).padStart(4)}) | ` +
      `${ed === 0 ? '     n/a' : `${((edE / ed) * 100).toFixed(2).padStart(5)}%`} (n=${String(ed).padStart(4)}) | ` +
      `${ed === 0 ? "n/a" : `${((edE / ed) * 100).toFixed(1)}%`}`,
  )
}
say('')
say('=== 错误构成（证明靶子在写侧）===')
{
  const rdE = rows.reduce((n, r) => n + r.readErr, 0)
  const edE = rows.reduce((n, r) => n + r.editErr, 0)
  const all = rdE + edE
  say(`  aura_read ${rdE} · aura_edit ${edE}（合计 ${all}，写侧占 ${all === 0 ? 'n/a' : ((edE / all) * 100).toFixed(0)}%）`)
}

const csvIdx = process.argv.indexOf('--csv')
if (csvIdx > -1 && process.argv[csvIdx + 1] !== undefined) {
  const out = process.argv[csvIdx + 1]
  const head = 'path,lines,bucket,calls,read,readErr,edit,editErr\n'
  fs.writeFileSync(out, head + rows.map((r) => [r.p, r.lines, r.bucket, r.calls, r.read, r.readErr, r.edit, r.editErr].join(',')).join('\n'))
  say(`\n  已写 ${out}`)
}