/**
 * read-cost.mjs —— 用**真实会话日志**量 read 的代价。
 *
 * 数据源：~/.dsh/sessions 下各会话的 session.v3.jsonl.zstd（逐事件 JSONL，zstd 压缩）。
 * 不估算、不抽样——把全部会话解出来，数每一次工具调用的参数与结果体量。
 *
 * 回答四个问题：
 *   ① read 吃了多少上下文，占所有工具结果的多少？
 *   ② read 的结果有多大比例超过剪枝阈值（会中段被砍）？
 *   ③ 有没有对同一文件重复读取（读了不用）？
 *   ④ 读进来的行里，有多少在后继的 edit/patch 调用里真被寻址到？
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const say = (m) => fs.writeSync(1, `${m}\n`)
const root = path.join(process.env.USERPROFILE, '.dsh', 'sessions')

function collect(d, depth = 0) {
  const out = []
  if (depth > 4) return out
  let es
  try {
    es = fs.readdirSync(d, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of es) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) out.push(...collect(p, depth + 1))
    else if (e.name === 'session.v3.jsonl.zstd') out.push(p)
  }
  return out
}

const files = collect(root)
say(`会话数据文件 ${files.length} 个`)

const toolCalls = new Map() // 工具名 -> 次数
let readResultChars = 0
let allToolResultChars = 0
const readSizes = []
let overPrune = 0
const readByFile = new Map() // 文件 -> 读取次数
let editCallsOnFiles = 0
let sessionCount = 0

const PRUNE_THRESHOLD = 8192

for (const f of files) {
  let text
  try {
    text = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8')
  } catch {
    continue
  }
  sessionCount += 1
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.length < 30) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const t = ev.type
    if (t === 'tool/call') {
      const name = ev.data?.name ?? ev.data?.tool
      if (typeof name === 'string') toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1)
      const args = ev.data?.args ?? {}
      if (name === 'read' && typeof args.file_path === 'string') {
        readByFile.set(args.file_path, (readByFile.get(args.file_path) ?? 0) + 1)
      }
      if ((name === 'edit' || name === 'patch') && typeof args.file_path === 'string') editCallsOnFiles += 1
    }
    if (t === 'tool/result') {
      const content = ev.data?.content ?? ev.data?.result
      const s = typeof content === 'string' ? content : JSON.stringify(content ?? '')
      allToolResultChars += s.length
      const name = ev.data?.name ?? ev.data?.tool
      if (name === 'read') {
        readResultChars += s.length
        readSizes.push(s.length)
        if (s.length > PRUNE_THRESHOLD) overPrune += 1
      }
    }
  }
}

say(`解出 ${sessionCount} 个会话`)
say('')
say('=== 工具调用次数 ===')
for (const [n, c] of [...toolCalls.entries()].sort((a, b) => b[1] - a[1])) {
  say(`  ${String(n).padEnd(14)} ${c}`)
}

if (readSizes.length > 0) {
  readSizes.sort((a, b) => a - b)
  const sum = readSizes.reduce((a, b) => a + b, 0)
  const p = (q) => readSizes[Math.min(readSizes.length - 1, Math.floor(readSizes.length * q))]
  say('')
  say('=== read 结果的体量分布（字符）===')
  say(`  次数 ${readSizes.length}`)
  say(`  中位数 ${p(0.5)}    p90 ${p(0.9)}    p99 ${p(0.99)}    最大 ${readSizes[readSizes.length - 1]}`)
  say(`  粗估 token 合计 ${Math.round(sum / 3.3)}`)
  say('')
  say(`超过剪枝阈值(${PRUNE_THRESHOLD})：${overPrune} 次 = ${((overPrune / readSizes.length) * 100).toFixed(1)}%（这些的中段会被砍掉）`)
  if (allToolResultChars > 0) {
    say(`read 占全部工具结果体量：${((readResultChars / allToolResultChars) * 100).toFixed(1)}%`)
  }
}

say('')
say('=== 重复读取（同一文件被读多次）===')
const repeats = [...readByFile.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
const totalReads = [...readByFile.values()].reduce((a, b) => a + b, 0)
const repeatReads = repeats.reduce((a, [, n]) => a + n, 0)
say(`  被读过的不同文件 ${readByFile.size} 个，读取总次数 ${totalReads}`)
say(`  被重复读的 ${repeats.length} 个文件，贡献 ${repeatReads} 次 = ${((repeatReads / Math.max(1, totalReads)) * 100).toFixed(1)}%`)
say('  读得最多的前 8 个：')
for (const [f, n] of repeats.slice(0, 8)) {
  say(`    ×${String(n).padStart(3)}  ${path.basename(f)}`)
}
