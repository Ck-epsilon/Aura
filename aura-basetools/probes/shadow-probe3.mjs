/**
 * shadow-probe3.mjs —— 最后一问：同一处被反复改写（返工）到不到"该有暂存区/检查点"的程度。
 *
 * 判据只用 edit / aura_edit 的参数（old_string / new_string），不从结果文本猜：
 *   同文件相邻两次改动 A、B，若 A.new 被 B.old 包含（或反向包含）⇒ 同一区域被再次改写 = 返工。
 * 连续返工段 ≥3 次 = 一次"试错循环"。
 *
 * 输出还给出：返工段里"改回去"（B.new 与更早的 A.old 相同）的次数 = 真·悔棋。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const say = (m) => fs.writeSync(1, `${m}\n`)
const root = path.join(process.env.USERPROFILE, '.dsh', 'sessions')
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const CAP = 4000 // 只比较前 4000 字符，避免 O(n²) 文本爆炸

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

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, CAP)
const related = (a, b) => {
  if (a.length < 12 || b.length < 12) return false
  return a.includes(b) || b.includes(a)
}

let totalEdits = 0
let reworkEdits = 0
let undoEdits = 0
const runs = []
const perSession = []

for (const f of files(root)) {
  let text
  try {
    text = decompressAll(fs.readFileSync(f))
  } catch {
    continue
  }
  if (!text.includes('"tool/call"')) continue
  const calls = []
  for (const l of text.split('\n')) {
    if (!l.includes('"tool/call"')) continue
    let ev
    try {
      ev = JSON.parse(l)
    } catch {
      continue
    }
    if (ev.type !== 'tool/call') continue
    const name = ev.data?.name
    if (name !== 'edit' && name !== 'aura_edit') continue
    let args = ev.data.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    if (args === null || typeof args !== 'object') continue
    // aura_edit 的 hunks[].replace 与 edit 的 new_string 统一成 new；old 只在 edit 里可得
    const oldStr = args.old_string ?? args.oldString ?? null
    const newStr = args.new_string ?? args.newString ?? (Array.isArray(args.hunks) ? args.hunks.map((h) => h?.replace ?? '').join('\n') : null)
    const file = args.file_path ?? null
    if (file === null || newStr === null) continue
    calls.push({ file, old: oldStr, new: newStr, name })
  }
  if (calls.length === 0) continue
  totalEdits += calls.length

  // 逐文件按调用顺序看相邻两次
  const byFile = new Map()
  for (const c of calls) {
    if (!byFile.has(c.file)) byFile.set(c.file, [])
    byFile.get(c.file).push(c)
  }
  let rework = 0
  let undo = 0
  let chain = 0
  let chainStart = 0
  for (const [file, seq] of byFile) {
    let cur = 0
    for (let i = 1; i < seq.length; i += 1) {
      const a = seq[i - 1]
      const b = seq[i]
      const hit = related(norm(a.new), norm(b.old ?? '')) || related(norm(b.old ?? ''), norm(a.new))
      if (hit) {
        rework += 1
        cur = cur === 0 ? 2 : cur + 1
        // 悔棋：这次写的内容与上一次改之前的内容相同
        if (a.old !== null && norm(b.new) === norm(a.old)) undo += 1
      } else {
        if (cur >= 3) runs.push({ file, n: cur, session: path.basename(path.dirname(f)) })
        cur = 0
      }
    }
    if (cur >= 3) runs.push({ file, n: cur, session: path.basename(path.dirname(f)) })
    chainStart += cur
  }
  reworkEdits += rework
  undoEdits += undo
  perSession.push({ id: path.basename(path.dirname(f)), edits: calls.length, rework, undo })
  void chainStart
}

say(`=== 返工统计（按 old/new 文本相关性判定，只算 edit / aura_edit）===`)
say(`  编辑调用总数：${totalEdits}`)
say(`  与上一次改动"同一区域"的再次改写：${reworkEdits} 次（占 ${((reworkEdits / Math.max(totalEdits, 1)) * 100).toFixed(1)}%）`)
say(`  其中"写回了更早的内容"（真·悔棋）：${undoEdits} 次`)
say('')
say(`=== 试错循环（同一文件连续返工 ≥3 次）===`)
say(`  段数：${runs.length}`)
const rh = new Map()
for (const r of runs) {
  const b = r.n >= 10 ? '10+' : String(r.n)
  rh.set(b, (rh.get(b) ?? 0) + 1)
}
for (const [b, c] of [...rh.entries()].sort((a, b) => Number(a[0].replace('+', '')) - Number(b[0].replace('+', '')))) say(`    连续返工 ${b} 次：${c} 段`)
say(`  连续返工 ≥5 次的段：${runs.filter((r) => r.n >= 5).length}`)
say('  最长的 12 段：')
for (const r of [...runs].sort((a, b) => b.n - a.n).slice(0, 12)) say(`    ${String(r.n).padStart(3)} 次返工  ${r.file.replace(/^.*[\\/]/, '')}`)
say('')
say('=== 返工最集中的会话 ===')
for (const s of [...perSession].sort((a, b) => b.rework - a.rework).slice(0, 8)) {
  say(`  ${String(s.rework).padStart(4)} 次返工 / ${String(s.edits).padStart(4)} 次编辑（悔棋 ${s.undo}）  ${s.id}`)
}
