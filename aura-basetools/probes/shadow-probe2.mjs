/**
 * shadow-probe2.mjs —— 跨轮试错暂存区（"影子工作区"）到底有没有真实需求。
 *
 * 全部从会话日志数出来：
 *   A. 每个 (会话,文件) 被改几次；同一文件的最长连续改动段
 *   B. 编辑类工具失败多少次、多少种；失败后同一文件又被改几次（试错成本）
 *   C. 一次**用户回合**内同一文件被改几次（跨轮试错的真实频次）——这是影子区的目标函数
 *   D. 有没有反向证据：diff 工具/回退类动作的使用（说明"先看后提交"已被别的手段满足）
 *
 * 失败判据用结构字段 isError === true，不用文本正则。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const say = (m) => fs.writeSync(1, `${m}\n`)
const root = path.join(process.env.USERPROFILE, '.dsh', 'sessions')
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function decompressAll(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k]
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      /* ignore */
    }
  }
  return text
}

function* files(dir, depth = 0) {
  if (depth > 5) return
  let es
  try {
    es = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of es) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* files(p, depth + 1)
    else if (e.name === 'session.v3.jsonl.zstd') yield p
  }
}

const EDIT_TOOLS = new Set(['aura_edit', 'edit', 'write', 'patch', 'str_replace_editor', 'apply_patch'])
const sessions = []
const toolTally = new Map()
let parseFail = 0

for (const f of files(root)) {
  let text
  try {
    text = decompressAll(fs.readFileSync(f))
  } catch {
    continue
  }
  if (!text.includes('tool/call')) continue
  const calls = []
  const byId = new Map()
  for (const l of text.split('\n')) {
    if (!l.includes('"tool/')) continue
    let ev
    try {
      ev = JSON.parse(l)
    } catch {
      parseFail += 1
      continue
    }
    if (ev.type === 'tool/call') {
      const name = ev.data?.name
      if (typeof name !== 'string') continue
      toolTally.set(name, (toolTally.get(name) ?? 0) + 1)
      let args = ev.data.arguments ?? ev.data.args ?? ev.data.input
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = null
        }
      }
      const file = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : null
      const rec = { name, file, turn: ev.data?.turn ?? null, step: ev.data?.step ?? null, isError: null }
      calls.push(rec)
      if (typeof ev.data?.callId === 'string') byId.set(ev.data.callId, rec)
    } else if (ev.type === 'tool/result') {
      const cid = ev.data?.message?.source?.callId ?? ev.data?.message?.content?.[0]?.toolCallId
      const rec = typeof cid === 'string' ? byId.get(cid) : undefined
      const inner = ev.data?.message?.content ?? []
      const err = inner.some((c) => c?.isError === true)
      if (rec) rec.isError = err
    }
  }
  if (calls.length === 0) continue
  sessions.push({ id: path.basename(path.dirname(f)), mtime: fs.statSync(f).mtimeMs, calls })
}

say(`会话（含工具调用）：${sessions.length}；事件解析失败行：${parseFail}`)
say('')
say('=== 工具调用总量（前 15）===')
for (const [n, c] of [...toolTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) say(`  ${String(c).padStart(6)}  ${n}`)
say('')

// A. 每 (会话,文件) 改动次数 + 最长连续段
const perFile = []
const streaks = []
let editTotal = 0
for (const s of sessions) {
  const edits = s.calls.filter((c) => EDIT_TOOLS.has(c.name) && c.file !== null)
  editTotal += edits.length
  const byFile = new Map()
  for (const c of edits) {
    const k = `${c.name}|${c.file}`
    byFile.set(k, (byFile.get(k) ?? 0) + 1)
  }
  for (const [k, n] of byFile) {
    const [name, file] = k.split('|')
    perFile.push({ session: s.id, name, file, n })
  }
  // 连续段：换文件或换工具即断开
  let run = 0
  let prev = null
  for (const c of edits) {
    if (prev !== null && c.file === prev) run += 1
    else run = 1
    prev = c.file
    if (run >= 3) streaks.push({ session: s.id, file: c.file, n: run })
  }
}
say(`=== A. 编辑调用 ${editTotal} 次，落在 ${perFile.length} 个 (会话,工具,文件) 三元组上 ===`)
const hist = new Map()
for (const x of perFile) hist.set(x.n, (hist.get(x.n) ?? 0) + 1)
const bucket = (lo, hi) => [...hist.entries()].filter(([n]) => n >= lo && (hi === null || n <= hi)).reduce((m, [, c]) => m + c, 0)
say(`  1 次：${bucket(1, 1)}   2-3 次：${bucket(2, 3)}   4-9 次：${bucket(4, 9)}   ≥10 次：${bucket(10, null)}`)
say(`  ≥2 次占比：${(((perFile.length - bucket(1, 1)) / perFile.length) * 100).toFixed(1)}%`)
const byTool = new Map()
for (const x of perFile) {
  const cur = byTool.get(x.name) ?? { pairs: 0, edits: 0, multi: 0 }
  cur.pairs += 1
  cur.edits += x.n
  if (x.n >= 2) cur.multi += 1
  byTool.set(x.name, cur)
}
say('  按工具：')
for (const [n, v] of [...byTool.entries()].sort((a, b) => b[1].edits - a[1].edits)) {
  say(`    ${n.padEnd(12)} 编辑 ${String(v.edits).padStart(5)} 次 / ${String(v.pairs).padStart(4)} 个文件 / 其中改≥2次的 ${v.multi}`)
}
say('  最长连续段分布：')
const sh = new Map()
for (const s of streaks) {
  const b = s.n >= 10 ? '10+' : String(s.n)
  sh.set(b, (sh.get(b) ?? 0) + 1)
}
for (const [b, c] of sh) say(`    连续 ${b} 次：${c} 段`)
say(`  连续 ≥5 次的段：${streaks.filter((s) => s.n >= 5).length}`)
for (const s of streaks.sort((a, b) => b.n - a.n).slice(0, 10)) say(`    ${String(s.n).padStart(3)} 连改  ${s.file.replace(/^.*[\\/]/, '')}`)
say('')

// B. 编辑类工具失败
say('=== B. 编辑类工具的失败（isError 结构化判定）===')
let editCalls = 0
let editErrs = 0
const errByTool = new Map()
for (const s of sessions) {
  for (const c of s.calls) {
    if (!EDIT_TOOLS.has(c.name) || c.file === null) continue
    editCalls += 1
    if (c.isError === true) {
      editErrs += 1
      errByTool.set(c.name, (errByTool.get(c.name) ?? 0) + 1)
    }
  }
}
say(`  编辑类调用 ${editCalls} 次，其中失败 ${editErrs} 次（${((editErrs / Math.max(editCalls, 1)) * 100).toFixed(1)}%）`)
for (const [n, c] of [...errByTool.entries()].sort((a, b) => b[1] - a[1])) say(`    ${n.padEnd(12)} 失败 ${c}`)
say('')

// C. 用户回合内的重复改动（跨轮试错的真实频次）
say('=== C. 同一个用户回合（turn）内，同一文件被改几次 ===')
const perTurn = []
for (const s of sessions) {
  const byTurn = new Map()
  for (const c of s.calls) {
    if (!EDIT_TOOLS.has(c.name) || c.file === null || c.turn === null) continue
    const k = `${c.turn}|${c.file}`
    byTurn.set(k, (byTurn.get(k) ?? 0) + 1)
  }
  for (const [k, n] of byTurn) {
    const [turn, file] = k.split('|')
    perTurn.push({ session: s.id, turn, file, n })
  }
}
const th = new Map()
for (const x of perTurn) th.set(x.n, (th.get(x.n) ?? 0) + 1)
const tb = (lo, hi) => [...th.entries()].filter(([n]) => n >= lo && (hi === null || n <= hi)).reduce((m, [, c]) => m + c, 0)
say(`  (回合,文件) 对：${perTurn.length}`)
say(`  1 次：${tb(1, 1)}   2-3 次：${tb(2, 3)}   4-9 次：${tb(4, 9)}   ≥10 次：${tb(10, null)}`)
const heavy = perTurn.filter((x) => x.n >= 4)
say(`  同一回合内改同一文件 ≥4 次：${heavy.length} 对（占 ${((heavy.length / Math.max(perTurn.length, 1)) * 100).toFixed(1)}%）`)
for (const x of heavy.sort((a, b) => b.n - a.n).slice(0, 10)) say(`    ${String(x.n).padStart(3)} 次  turn ${x.turn}  ${x.file.replace(/^.*[\\/]/, '')}`)
say('')

// D. 反向证据：有没有"先看后提交"类手段在用
say('=== D. 反向证据：diff / 回退类动作的使用 ===')
const counter = new Map()
for (const s of sessions) {
  for (const c of s.calls) {
    const n = c.name
    if (['glob', 'grep', 'read', 'aura_read', 'pwsh', 'bash', 'git'].some((x) => n.includes(x)) || n === 'aura_edit') {
      counter.set(n, (counter.get(n) ?? 0) + 1)
    }
  }
}
for (const [n, c] of [...counter.entries()].sort((a, b) => b[1] - a[1])) say(`  ${String(c).padStart(6)}  ${n}`)
