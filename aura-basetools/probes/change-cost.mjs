/**
 * change-cost.mjs —— 一次「有意义的改动」，agent 到底付了几次调用、多少回执字符、多少墙钟，浪费在哪。
 *
 *   node probes/change-cost.mjs                    # 全量（~1362 个会话文件 / ~600MB 压缩）
 *   node probes/change-cost.mjs --limit 200        # 只取最近 200 个会话（迭代用，结论不据此下）
 *   node probes/change-cost.mjs --gap 5            # 换 episode 的 N（默认 3）
 *   node probes/change-cost.mjs --top 10           # 额外打印最贵的 10 个 episode
 *   node probes/change-cost.mjs --sample 2         # 额外打印 2 条真实回执样本（校对字符口径）
 *   node probes/change-cost.mjs --split-at=2026-10-01T00:00:00Z   # 按时刻切两窗，做部署前后对照（§B）
 *
 * ## 退出码（C48 接线：判据只增不减）
 *
 *   本探针的判据是「读数能不能信」。以前它们只**打印**一个 ⚠（`change-cost.mjs` 的收尾是恒
 *   `process.exit(0)`），于是「守恒」与「守恒被破」两种结局在退出码上完全同形 —— 谁也没法用一条
 *   命令问它。C48 把判据接上退出码：
 *
 *     · `--split-at` ⇒ 有判据在跑。守恒自检 / 角色表自检 / 未归入 episode 的调用 逐条判定，
 *       不符则退出码 1，并在末行**点名是那几项**（不只在屏幕上变红）。
 *     · 不带 `--split-at` ⇒ 退出码仍是 0，stdout 逐字节不变（C48 的硬约束：切窗那段不执行，
 *       就不许改默认路径的任何行为）。上面那两条自检因此只在末行多一个 `—（本次没判）`。
 *
 *   判据只增不减，接线范围也写清楚（免得下一个人以为缺口被默默吞了）：
 *     · 进退出码的两条 = 守恒自检（§B2）、角色表自检（§6）。两条都在切窗路径上逐条判定并点名。
 *     · **不进**退出码的一条 = §0 的「读写调用里取不到文件路径的」。现行语料上它 = 88 ≠ 0
 *       （`aura_read` 6 / `aura_edit` 81 / `write` 1，这些调用进不了任何 episode），真按它判，
 *       不带开关的路径今天就得 exit 1 —— 那与「不带 --split-at 不许改行为」直接冲突。
 *       所以它照旧印在原处、照旧带 ⚠（判据的性质、差多少都看得见），只是**不参与退出码**；
 *       正确修法是去修「那 88 条为什么取不到路径」，不是让探针改用估算去凑（§0 那句话自己说的）。
 */

/*
 * ## 为什么问这个
 *
 * 「报错率」与「单次耗时」都不是 agent 真正付的价。
 *
 *     调用次数 × (单次固定税 + 工具耗时) + 回执字符（token）
 *
 * 历史读数：aura_read 15,935 次 / 回执 53.8M 字符；aura_edit 11,684 次 / 回执 5.4M 字符。
 * 单看这两个数说明不了任何事——必须除以「做成了一件事」的次数。本探针就是那个分母的测量。
 *
 * ## 「一次逻辑改动」的定义（本文件的唯一判据，先定义再测量）
 *
 *   在**同一个会话**里，把全部工具调用按 `seq` 排成一条流。只看带文件路径的读写调用
 *   （`aura_read`/`read`/`aura_edit`/`edit`/`write`），对每个**文件**切出一段：
 *
 *     · 同一文件的两个连续读写调用之间，若夹着 **< N** 个别的调用（任何工具，含别的文件），
 *       则它们属于同一次改动；夹了 ≥ N 个别的调用，则前一段到此结束。
 *     · 剩下只要一段里**至少有一次写成功**，它就是一次「有意义的改动」（主口径）。
 *     · 一段里只有写但全失败 ⇒ 归「放弃」（另外计数，不混进主口径）。
 *     · 一段里一次写都没有 ⇒ 归「只读」，不是改动，整体丢弃。
 *
 *   N = 3。理由在运行时用数据打出来（`相邻同文件调用之间夹了几个别的调用` 的分布）：
 *   N 是「这个文件已经被放下了」的分界，取太小会把一次改动切成两半，取太大会把两件事并成一件。
 *   本文件同时打印 N ∈ {1,2,3,5,8} 的敏感性，任何结论如果随 N 剧烈变化，就不该被当成结论。
 *
 *   一次改动的**代价取整段 span**（首末文件调用之间的全部调用，含别的文件、含 pwsh/grep）——
 *   因为那些调用确实是这次改动期间付掉的。同时单独给「只算该文件上的调用」的对照列。
 *
 * ## 口径（可复算者请照抄这几行）
 *
 *   · 字符 = JS 字符串长度（UTF-16 code unit），回执正文的拼接方式与 `probes/session-log.mjs`
 *     逐字相同（顶层 `part.text` + 嵌套 `part.content[].text`，同层用 `\n` 连接）——
 *     不与历史读数共用口径的数不可比。
 *   · 墙钟 = 段内最后一次回执时间 − 段内第一次调用时间（毫秒/1000）。它**包含**模型思考与用户
 *     离开的时间，所以另有 `busy 秒` = 相邻事件间隔逐个封顶 120s 后求和（人为封顶，仅作对照）。
 *   · 会话日志是 zstd 多帧流，整体解压只得到会话头 ⇒ 按 magic `28 B5 2F FD` 切帧逐帧解。
 *     切帧实现照抄 `tmp/session-log-scan/zstd-read.mjs`（解析 block header 推帧长，不是暴力 indexOf）。
 *   · 失败判定用结构化字段 `isError`，不用文本正则（理由见 `edit-failure-census.mjs` 头部）。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/* ══════════════════════════════════════════════════════════════════════════
 * ① 会话日志读取
 * ══════════════════════════════════════════════════════════════════════════ */

const MAGIC_WORD = 0xfd2fb528
const SKIP_BASE = 0x184d2a50
const MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE = 'session.v3.jsonl.zstd'

/** 走 block header 推出整帧长度（照抄 tmp/session-log-scan/zstd-read.mjs）。 */
function frameLength(buf, off) {
  let p = off + 4
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictIdFlag = fhd & 3
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][dictIdFlag]
  let fcsSize = [0, 2, 4, 8][fcsFlag]
  if (fcsFlag === 0 && singleSegment) fcsSize = 1
  p += fcsSize
  for (;;) {
    const bh = buf.readUIntLE(p, 3)
    p += 3
    const last = bh & 1
    const btype = (bh >> 1) & 3
    const bsize = bh >> 3
    if (btype === 0 || btype === 2) p += bsize
    else if (btype === 1) p += 1
    else throw new Error(`reserved block type at ${p - 3}`)
    if (last) break
  }
  if (checksum) p += 4
  return p - off
}

/** 切帧；skip 帧跳过，坏帧向前 resync 到下一个 magic。 */
export function splitFrames(buf) {
  const frames = []
  let off = 0
  let resyncs = 0
  while (off + 4 <= buf.length) {
    const word = buf.readUInt32LE(off)
    if (word === MAGIC_WORD) {
      let len
      try {
        len = frameLength(buf, off)
      } catch {
        resyncs += 1
        const next = buf.indexOf(MAGIC_BYTES, off + 1)
        if (next < 0) break
        off = next
        continue
      }
      frames.push({ off, len })
      off += len
    } else if ((word & 0xfffffff0) === SKIP_BASE) {
      const size = buf.readUInt32LE(off + 4)
      off += 8 + size
    } else {
      resyncs += 1
      const next = buf.indexOf(MAGIC_BYTES, off + 1)
      if (next < 0) break
      off = next
    }
  }
  return { frames, resyncs, tail: buf.length - off }
}

/** 逐帧解压 → 逐行产出。跨帧的半行用 carry 持有（帧一般行对齐，但不能假设）。 */
function* iterLines(buf, frames) {
  let carry = ''
  for (const f of frames) {
    let text
    try {
      text = zlib.zstdDecompressSync(buf.subarray(f.off, f.off + f.len)).toString('utf8')
    } catch {
      continue /* 坏帧忽略：日志尾部常是半帧 */
    }
    const parts = (carry + text).split('\n')
    carry = parts.pop() ?? ''
    for (const line of parts) yield line
  }
  if (carry.trim().length > 0) yield carry
}

/** 工具参数：日志里是字符串化的 JSON；解不开记 null（不猜）。 */
function argsOf(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 回执正文：与 probes/session-log.mjs 逐字相同（顶层 text + 嵌套 content[].text）。 */
const textOf = (part) => {
  const own = typeof part?.text === 'string' ? part.text : ''
  const nested = Array.isArray(part?.content)
    ? part.content.map((inner) => (typeof inner?.text === 'string' ? inner.text : '')).filter((t) => t.length > 0)
    : []
  return [own, ...nested].filter((t) => t.length > 0).join('\n')
}

/**
 * 一个会话文件 → 按 seq 排好的调用数组。
 * `t0` = tool/call 时间戳，`t1` = tool/result 时间戳（没有就 null）。
 */
export function readSessionCalls(file) {
  const buf = fs.readFileSync(file)
  const { frames, resyncs, tail } = splitFrames(buf)
  const calls = []
  const byId = new Map()
  let multiResult = 0
  let resultOrphans = 0
  for (const line of iterLines(buf, frames)) {
    if (!line.includes('"tool/')) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'tool/call') {
      const name = ev.data?.name
      if (typeof name !== 'string') continue
      const call = { name, args: argsOf(ev.data?.arguments), isError: false, chars: 0, text: '', t0: ev.time ?? null, t1: null, results: 0 }
      calls.push(call)
      if (typeof ev.data?.callId === 'string') byId.set(ev.data.callId, call)
      continue
    }
    if (ev.type !== 'tool/result') continue
    const id = ev.data?.message?.source?.callId
    const call = typeof id === 'string' ? byId.get(id) : undefined
    if (call === undefined) {
      resultOrphans += 1
      continue
    }
    const parts = ev.data?.message?.content ?? []
    const chunk = parts.map(textOf).filter((t) => t.length > 0).join('\n')
    if (call.results > 0) multiResult += 1
    call.results += 1
    call.isError = parts.some((p) => p?.isError === true)
    call.text = call.text.length === 0 ? chunk : `${call.text}\n${chunk}`
    call.chars = call.text.length
    call.t1 = ev.time ?? null
  }
  return { calls, bytes: buf.length, frames: frames.length, resyncs, tail, multiResult, resultOrphans }
}

/* ══════════════════════════════════════════════════════════════════════════
 * ② 判据与切段
 * ══════════════════════════════════════════════════════════════════════════ */

const READ = new Set(['aura_read', 'read'])
const WRITE = new Set(['aura_edit', 'edit', 'write'])
/** 文件参数可能叫的名字；没命中会显式计数并打印（不许静默丢调用）。 */
const FILE_ARG_KEYS = ['file_path', 'path', 'filePath', 'target']
/** 段与段之间的分界：同一文件两次读写调用之间最多允许夹这么多「别的调用」。 */
const DEFAULT_GAP = 3
/** busy 秒用的单次间隔封顶（ms）。 */
const IDLE_CAP_MS = 120_000
/** 「被逐字引用」判定时忽略的短行长度（短行到处出现，匹配上不算证据）。 */
const MIN_NEEDLE = 12

const isFileCall = (c) => READ.has(c.name) || WRITE.has(c.name)

function fileOf(call) {
  if (!isFileCall(call)) return null
  const a = call.args
  if (a === null || typeof a !== 'object') return null
  for (const k of FILE_ARG_KEYS) {
    const v = a[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/** Windows 大小写不敏感：键用小写 + 正斜杠。 */
const keyOf = (p) => p.replace(/\\/g, '/').toLowerCase()
const baseOf = (p) => p.split(/[\\/]/).pop()

/**
 * 切段。返回 `[{ file, key, indices, firstIdx, lastIdx }]`（indices 升序，指全局调用下标）。
 */
export function episodes(calls, gap) {
  const open = new Map()
  const out = []
  for (let i = 0; i < calls.length; i += 1) {
    const file = fileOf(calls[i])
    if (file === null) continue
    const k = keyOf(file)
    const cur = open.get(k)
    if (cur !== undefined && i - cur.lastIdx <= gap) {
      cur.indices.push(i)
      cur.lastIdx = i
      continue
    }
    if (cur !== undefined) out.push(cur)
    open.set(k, { file, key: k, indices: [i], firstIdx: i, lastIdx: i })
  }
  for (const ep of open.values()) out.push(ep)
  return out
}

/** 相邻同文件读写调用之间「夹了几个别的调用」——N 的经验依据。 */
export function interveningHistogram(calls) {
  const last = new Map()
  const buckets = new Map()
  for (let i = 0; i < calls.length; i += 1) {
    const file = fileOf(calls[i])
    if (file === null) continue
    const k = keyOf(file)
    const prev = last.get(k)
    if (prev !== undefined) {
      const n = i - prev - 1
      const b = n <= 4 ? String(n) : n <= 9 ? '5-9' : n <= 19 ? '10-19' : n <= 49 ? '20-49' : '50+'
      buckets.set(b, (buckets.get(b) ?? 0) + 1)
    }
    last.set(k, i)
  }
  return buckets
}

/* ── 读区间：优先用回执里真实给出的行号，其次用参数 ───────────────────────── */

/** 回执正文里 `123: text` 形态 → 实际观测到的行区间。 */
function observedRange(call) {
  if (call.text.length === 0) return null
  let lo = Infinity
  let hi = -Infinity
  for (const m of call.text.matchAll(/^(\d+): /gm)) {
    const n = Number(m[1])
    if (n < lo) lo = n
    if (n > hi) hi = n
  }
  return lo === Infinity ? null : [lo, hi]
}

function toPair(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v]
  if (typeof v === 'string') {
    const nums = v.split(/[^0-9.-]+/).map(Number).filter(Number.isFinite)
    if (nums.length === 1) return [nums[0], nums[0]]
    if (nums.length >= 2) return [nums[0], nums[1]]
    return null
  }
  if (Array.isArray(v)) {
    const nums = v.map(Number).filter(Number.isFinite)
    if (nums.length === 1) return [nums[0], nums[0]]
    if (nums.length >= 2) return [nums[0], nums[1]]
    return null
  }
  if (v !== null && typeof v === 'object') {
    const s = Number(v.start ?? v.start_line ?? v.from)
    const e = Number(v.end ?? v.end_line ?? v.to)
    if (Number.isFinite(s)) return [s, Number.isFinite(e) ? e : s]
  }
  return null
}

/** 参数声明的行区间（回执解析不出来时的兜底）。 */
function argRange(call) {
  const a = call.args
  if (a === null || typeof a !== 'object') return null
  if (a.start_line !== undefined || a.end_line !== undefined) {
    const s = Number(a.start_line)
    const e = a.end_line === undefined ? s : Number(a.end_line)
    if (Number.isFinite(s)) return [s, Number.isFinite(e) ? e : s]
  }
  if (a.lines !== undefined) return toPair(a.lines)
  if (call.name === 'read' && (a.offset !== undefined || a.limit !== undefined)) {
    const off = Number(a.offset ?? 1)
    const lim = Number(a.limit ?? 2000)
    if (Number.isFinite(off)) return [off, off + (Number.isFinite(lim) ? lim : 2000) - 1]
  }
  return null
}

const rangeOfRead = (call) => observedRange(call) ?? argRange(call)
const overlap = (x, y) => x !== null && y !== null && x[0] <= y[1] && y[0] <= x[1]

/** 地址签名：同一份「要哪一段」的参数组合。用于「一字不差的重复读」。 */
function addressKey(call) {
  const a = call.args
  if (a === null || typeof a !== 'object') return '{}'
  const pick = {}
  for (const k of ['mode', 'lines', 'start_line', 'end_line', 'around', 'search', 'context', 'since', 'kind', 'offset', 'limit']) {
    if (a[k] !== undefined) pick[k] = a[k]
  }
  return JSON.stringify(pick)
}

const normalizeArgs = (call) => {
  try {
    return JSON.stringify(call.args ?? null)
  } catch {
    return '(unserializable)'
  }
}

/** 递归收集参数里的全部字符串（用于「后来有没有逐字用到这行」）。 */
function stringsOf(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out)
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out)
  return out
}

/* ══════════════════════════════════════════════════════════════════════════
 * ③ 统计工具
 * ══════════════════════════════════════════════════════════════════════════ */

/** 线性插值分位（与 numpy 默认一致）。空数组返回 null。 */
function quant(sorted, p) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const pos = p * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const n0 = (x) => (x === null ? '—' : String(Math.round(x)))
const n2 = (x) => (x === null ? '—' : x.toFixed(2))
const pctf = (part, whole) => (whole === 0 ? '—' : `${((100 * part) / whole).toFixed(1)}%`)

const say = (m) => fs.writeSync(1, `${m}\n`)

/** 本次运行里累积的「不符」清单（每条都自带姓名，§⑦ 只负责收拢与表态）。
 *  **必须在这里（模块顶层、§B2 之前）先赋初值**：§B2 的守恒自检一旦不符就会往这里 push，
 *  而 `var violations` 的提升只把名字提上来、值仍是 `undefined` —— C48 的变异反证当场就撞了
 *  `TypeError: Cannot read properties of undefined (reading 'push')`：判据红的那一刻反而崩在
 *  汇总之前（健康语料上永远看不到，因为那条分支不执行）。初值放在这里两个用途都盖得到。 */
var violations = []

/* ══════════════════════════════════════════════════════════════════════════
 * ④ 主流程
 * ══════════════════════════════════════════════════════════════════════════ */

function* sessionFiles(dir, depth = 0) {
  if (depth > 5) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sessionFiles(full, depth + 1)
    else if (entry.name === SESSION_FILE) yield full
  }
}

function parseArgs(argv) {
  const get = (flag, dflt) => {
    const i = argv.indexOf(flag)
    return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
  }
  /** `--split-at=<值>` 与 `--split-at <值>` 两种写法都收（题面写的是前者）。 */
  const getEq = (flag, dflt) => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`))
    return hit === undefined ? get(flag, dflt) : hit.slice(flag.length + 1)
  }
  return {
    root: get('--root', path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')),
    limit: Number(get('--limit', '0')) || 0,
    gap: Number(get('--gap', String(DEFAULT_GAP))) || DEFAULT_GAP,
    top: Number(get('--top', '0')) || 0,
    sample: Number(get('--sample', '0')) || 0,
    since: get('--since', '') === '' ? 0 : Date.parse(get('--since', '')),
    splitAt: splitStamp(getEq('--split-at', '')),
    includeSelf: argv.includes('--include-self'),
  }
}

/**
 * `--split-at` 的取值：纯数字当 epoch 毫秒，其余交给 `Date.parse`（ISO 串等）。
 *
 * 认不出就**报错退出**，不猜。切点猜错一整天，两窗读数会整体错一窗，而错出来的数
 * 长得很像对的（两窗都非空、加总也守恒）—— 守恒只能证明分桶没丢会话，证不了切点对不对。
 */
function splitStamp(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '') return null
  if (/^\d+$/.test(s)) return Number(s)
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) {
    fs.writeSync(2, `--split-at 认不出这个时刻：${JSON.stringify(raw)}（要 ISO 时刻串，或 epoch 毫秒）\n`)
    process.exit(1)
  }
  return ms
}


// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--root', '--limit', '--gap', '--top', '--sample', '--since', '--split-at', '--include-self'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/change-cost.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const opts = parseArgs(process.argv.slice(2))

/**
 * 一份计数桶 = 一整套口径的全部累加器（含「语料合计」）。
 *
 * 默认只建一个（全部语料）。`--split-at` 时另建两个（切点前 / 切点后），每场会话
 * **既进全量桶、又进它所属的那一窗**，三次记的都是同一个 `scanSession`。于是：
 *   · 「两窗口径一致」不是靠对齐两份代码，而是同一段代码；
 *   · 「两窗相加 == 全量」也不是靠事后检查，而是同一份输入按会话被分进不同桶
 *     （§B2 的守恒自检就是验这一条 —— 它唯一能失败的方式是定窗丢会话或记重）。
 */
function mkAgg() {
  return {
    /** 语料合计。 */
    corpus: {
      files: 0,
      bytes: 0,
      frames: 0,
      resyncs: 0,
      sessionsWithCalls: 0,
      calls: 0,
      chars: 0,
      results: 0,
      pending: 0,
      multiResult: 0,
      resultOrphans: 0,
      tally: new Map(),
      charsByTool: new Map(),
      msByTool: new Map(),
      latency: new Map(),
      negativeLatency: 0,
      fileArgMiss: new Map(),
      hunksPerEdit: new Map(),
      readsWithRange: 0,
      identicalSessionReads: 0,
      identicalSessionReadChars: 0,
      sameAddrReads: 0,
      sameAddrReadChars: 0,
      sameAddrFirstChars: 0,
      overlapSessionReads: 0,
      overlapSessionReadChars: 0,
      containedSessionReads: 0,
      containedSessionReadChars: 0,
      duplicateCallReceipts: 0,
      duplicateCallReceiptChars: 0,
    },
    /** 主口径 episode 行。 */
    rows: [],
    /** 启发式：N 的敏感性。 */
    sensitivity: new Map(),
    /** span 内每个调用的角色计数（主口径 episode 合计）。 */
    role: new Map(),
    /** 「未被逐字引用」账。 */
    quote: { receipts: 0, receiptChars: 0, needleChars: 0, nonNeedleChars: 0, refChars: 0, unrefChars: 0, receiptNoWrite: 0, receiptNoWriteChars: 0 },
    /** 相邻同文件读写调用之间「夹了几个别的调用」的分布。 */
    hist: new Map(),
    /** `--sample` 抽到的回执样本。 */
    samples: [],
  }
}

/** 全量桶。不切窗时它是唯一的口径。 */
const aggAll = mkAgg()

/**
 * 切窗（`--split-at`）。不切窗时是 `null` —— 默认路径不建桶、不定窗、不打印任何多出来的字。
 *
 * `cut` 是 epoch 毫秒。定窗判据见 `classifySession`。
 */
const split =
  opts.splitAt === null
    ? null
    : {
        cut: opts.splitAt,
        before: mkAgg(),
        after: mkAgg(),
        /** 会话里一个时间戳都没有、只能用文件 mtime 定窗的会话数。 */
        byMtime: 0,
        /** 起点在切点前、却有调用落在切点后的会话数（整场归**前窗**，是一股已知偏差）。 */
        straddleSessions: 0,
        /** 上面那些会话里，落在切点之后的调用次数。 */
        straddleCalls: 0,
      }

/** 调用时间戳：正常是 epoch 毫秒；老日志里可能是串，统一成毫秒，认不出记 null。 */
function stampOf(call) {
  const t = call.t0
  if (typeof t === 'number' && Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

/**
 * 一场会话落在哪一窗 —— 按**会话内最早一次调用**的时刻定，不按文件 mtime。
 *
 * 为什么不是 mtime：mtime 是「最后一次写」。一场部署前开的会话，只要它一直跑到部署后，
 * mtime 就落在切点之后，于是它整场（包括部署前那段）会被算进后窗 —— 而后窗正是用来
 * 判断「新工具做了什么」的那一格，混进旧行为等于把结论往「没动」的方向拽。
 * 一个时间戳都没有的会话才退回 mtime，并单独计数（`split.byMtime`），不静默。
 *
 * 跨切点的会话（起点在切点前、末尾在切点后）整场归**前窗**，并把「切点后的调用次数」
 * 单独记出来打印 —— 归哪边都有偏，但把偏差写在报告里比把它藏进某一窗强。
 */
function classifySession(sp, calls, mtime) {
  let first = null
  let last = null
  let afterCalls = 0
  for (const c of calls) {
    const t = stampOf(c)
    if (t === null) continue
    if (first === null || t < first) first = t
    if (last === null || t > last) last = t
    if (t >= sp.cut) afterCalls += 1
  }
  if (first === null) {
    sp.byMtime += 1
    return mtime < sp.cut ? sp.before : sp.after
  }
  if (first < sp.cut && last >= sp.cut) {
    sp.straddleSessions += 1
    sp.straddleCalls += afterCalls
  }
  return first < sp.cut ? sp.before : sp.after
}

const bump = (map, k, v = 1) => map.set(k, (map.get(k) ?? 0) + v)

const all = [...sessionFiles(opts.root)]
  .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
  .filter((x) => opts.since === 0 || x.mtime >= opts.since)
  .sort((a, b) => a.mtime - b.mtime)

/**
 * 把自己这次会话排掉。
 *
 * 会话日志是**活的**：本探针每跑一次，它自己的调用就写进 `DSH_SESSION_ID` 那个会话里，
 * 而那个会话里恰好全是对本文件的读与写——下一次跑就会把上一次跑当成语料。
 * 自我污染不会把结论改到离谱（~100 次调用 vs 10 万），但它会让“同一条命令两次读”对不上，
 * 而复算是这次交付的前提。要包含自己就加 `--include-self`。
 */
const selfId = process.env.DSH_SESSION_ID ?? ''
const selfHit = selfId === '' ? [] : all.filter((x) => path.basename(path.dirname(x.f)) === selfId)
const kept = opts.includeSelf || selfHit.length === 0 ? all : all.filter((x) => path.basename(path.dirname(x.f)) !== selfId)
const files = opts.limit > 0 ? kept.slice(-opts.limit) : kept

for (const { f, mtime } of files) {
  let parsed
  try {
    parsed = readSessionCalls(f)
  } catch {
    continue
  }
  /* 不切窗：只有一个桶。切窗：这场会话既进全量桶、又进它所属的那一窗。 */
  const targets = split === null ? [aggAll] : [aggAll, classifySession(split, parsed.calls, mtime)]
  for (const T of targets) scanSession(T, f, parsed)
}

/**
 * 扫描一场会话：日志只解析一次（`parsed`），记进**每一个**目标桶。
 *
 * 桶是参数 `T`，函数体第一行把桶里的容器就地展开成原来那批名字，于是下面三百行记账
 * 代码**一个字没动** —— 换桶只换这几个引用。「两窗口径一致」由此是构造，不是承诺。
 */
function scanSession(T, f, parsed) {
  const { corpus, rows, role, quote, hist, sensitivity, samples } = T
  corpus.files += 1
  corpus.bytes += parsed.bytes
  corpus.frames += parsed.frames
  corpus.resyncs += parsed.resyncs
  corpus.multiResult += parsed.multiResult
  corpus.resultOrphans += parsed.resultOrphans
  const calls = parsed.calls
  if (calls.length === 0) return
  corpus.sessionsWithCalls += 1

  // 全局账
  const seenCallReceipt = new Map() // name+args+回执 → 是否已见过
  const lastReadOfFile = new Map() // fileKey → call（同一会话内上一次读）
  for (const c of calls) {
    corpus.calls += 1
    corpus.chars += c.chars
    bump(corpus.tally, c.name)
    bump(corpus.charsByTool, c.name, c.chars)
    if (c.t1 !== null && c.t0 !== null) {
      const d = c.t1 - c.t0
      if (d < 0) corpus.negativeLatency += 1
      else {
        bump(corpus.msByTool, c.name, d)
        const arr = corpus.latency.get(c.name) ?? []
        arr.push(d)
        corpus.latency.set(c.name, arr)
      }
    }
    if (c.results === 0) corpus.pending += 1
    if (isFileCall(c) && fileOf(c) === null) bump(corpus.fileArgMiss, c.name)
    if (c.name === 'read' || c.name === 'aura_read') {
      if (rangeOfRead(c) !== null) corpus.readsWithRange += 1
      const k = fileOf(c) === null ? null : keyOf(fileOf(c))
      if (k !== null) {
        const prev = lastReadOfFile.get(k)
        if (prev !== undefined) {
          if (prev.text.length > 0 && prev.text === c.text) {
            corpus.identicalSessionReads += 1
            corpus.identicalSessionReadChars += c.chars
          }
          /**
           * 会话级重复读：同一文件、**同一地址签名**又读了一次。
           * 这是「同一区间被重复读」在全会话尺度上的计数（§4 那个只看段内，窗口窄，是下界）。
           * 同时把「重复读到的那条回执多少字符」与「上一次读花了多少字符」分开记：
           * 增量回执若真生效，第二次应当显著短——那个差就是已经拿回来的钱，不是口号。
           */
          const ak = addressKey(c)
          if (ak !== '{}' && ak === addressKey(prev)) {
            corpus.sameAddrReads += 1
            corpus.sameAddrReadChars += c.chars
            corpus.sameAddrFirstChars += prev.chars
          }
          const r = rangeOfRead(c)
          const rp = rangeOfRead(prev)
          if (overlap(rp, r)) {
            corpus.overlapSessionReads += 1
            corpus.overlapSessionReadChars += c.chars
            /** 更强的形态：这次读的区间**整个落在上一次读过的区间里** ⇒ 一个字都没新增。 */
            if (rp !== null && r !== null && r[0] >= rp[0] && r[1] <= rp[1]) {
              corpus.containedSessionReads += 1
              corpus.containedSessionReadChars += c.chars
            }
          }
        }
        lastReadOfFile.set(k, c)
      }
    }
    const dk = `${c.name}\u0000${normalizeArgs(c)}`
    if (c.text.length > 0) {
      const prevText = seenCallReceipt.get(dk)
      if (prevText !== undefined && prevText === c.text) {
        /**
         * 空转的判据必须**只在会话级、按调用顺序**算一次，并把结论钉在调用对象上。
         *
         * 第一版把这一步写在了 episode 循环里，且沿用同一个 Map——而那个 Map 在本循环里
         * 已经被**本次调用自己**填过了，于是「同参数同回执」恒成立：全机 35 次重复被数成 1693 次，
         * 浪费率直接飞到 82.3%。自比对是最容易写出来、也最容易看不出来的假数据。
         */
        c.dupCall = true
        corpus.duplicateCallReceipts += 1
        corpus.duplicateCallReceiptChars += c.chars
      } else if (prevText === undefined) {
        seenCallReceipt.set(dk, c.text)
      }
    }
    if (c.name === 'aura_edit') {
      const n = Array.isArray(c.args?.hunks) ? c.args.hunks.length : c.args?.create !== undefined ? 0 : -1
      bump(corpus.hunksPerEdit, n < 0 ? '无 hunks 也无 create' : String(n))
    }
  }

  for (const [b, n] of interveningHistogram(calls)) bump(hist, b, n)

  // 敏感性：只算 episode 数与调用数中位数
  for (const g of new Set([1, 2, opts.gap, 5, 8])) {
    const eps = episodes(calls, g)
    const changed = eps.filter((ep) => hasSuccessfulWrite(calls, ep))
    const sizes = changed.map((ep) => spanOf(calls, ep).length).sort((a, b) => a - b)
    const charSizes = changed.map((ep) => sum(spanOf(calls, ep).map((c) => c.chars))).sort((a, b) => a - b)
    const bucket = sensitivity.get(g) ?? { eps: 0, changed: 0, sizes: [], charSizes: [] }
    bucket.eps += eps.length
    bucket.changed += changed.length
    bucket.sizes.push(...sizes)
    bucket.charSizes.push(...charSizes)
    sensitivity.set(g, bucket)
  }

  // 主口径明细
  for (const ep of episodes(calls, opts.gap)) {
    const span = spanOf(calls, ep)
    /**
     * 只数**落在本 episode 那个文件上**的写。
     *
     * 第一版写的是 `span.filter(WRITE.has)`——段内别的文件上的写也被算成本次改动，
     * 于是「一次改动的段里顺手改了 B」会被当成本文件改成功了（实测多出 39 个这样的假改动）。
     * 段是文件视角的切片，判据必须回到文件上。
     */
    const onEp = (c) => fileOf(c) !== null && keyOf(fileOf(c)) === ep.key
    const writes = span.filter((c) => WRITE.has(c.name) && onEp(c))
    const writeOk = writes.filter((c) => c.isError !== true)
    if (writes.length === 0) continue
    const kind = writeOk.length > 0 ? 'changed' : 'abandoned'
    if (kind === 'abandoned') {
      bump(role, 'abandoned:调用')
      bump(role, 'abandoned:字符', sum(span.map((c) => c.chars)))
      continue
    }

    // ── 浪费分类（优先级：失败 > 重复读 > 空转重复调用）；一个调用最多进一类
    const waste = new Map()
    const readsOnFile = new Map() // fileKey → [{range, text, addressKey}]
    let firstReadSeen = false
    let firstWriteOkSeen = false
    let firstWriteTool = null
    let firstWriteIsCreate = false
    let wasteCalls = 0
    let wasteChars = 0
    let wasteMs = 0

    for (let j = 0; j < span.length; j += 1) {
      const c = span[j]
      const isRead = READ.has(c.name)
      const isWrite = WRITE.has(c.name)
      const k = fileOf(c) === null ? null : keyOf(fileOf(c))
      const onEpFile = k !== null && k === ep.key
      const ms = c.t0 !== null && c.t1 !== null ? c.t1 - c.t0 : 0

      let cls = null
      if (c.isError === true) cls = 'failed'
      else if (isRead && onEpFile) {
        const seen = readsOnFile.get(k) ?? []
        const r = rangeOfRead(c)
        const ak = addressKey(c)
        const identical = seen.some((s) => (s.text.length > 0 && s.text === c.text) || (s.addressKey === ak && ak !== '{}'))
        const overlapped = !identical && r !== null && seen.some((s) => overlap(s.range, r))
        if (identical) cls = 'reread-identical'
        else if (overlapped) cls = 'reread-overlap'
        seen.push({ range: r, text: c.text, addressKey: ak })
        readsOnFile.set(k, seen)
      }
      // 空转：同一会话里**更早**的某次调用同名同参数、且回执一字不差（顺序敏感，已在会话级预计算）
      if (cls === null && c.dupCall === true) cls = 'noop'

      if (cls !== null) {
        waste.set(cls, (waste.get(cls) ?? 0) + 1)
        bump(role, `waste:${cls}`)
        bump(role, `waste:${cls}:字符`, c.chars)
        wasteCalls += 1
        wasteChars += c.chars
        wasteMs += ms
        bump(role, 'waste:调用')
        bump(role, 'waste:字符', c.chars)
        bump(role, 'waste:工具毫秒', ms)
        continue
      }

      // ── 非浪费：记角色
      if (isRead && onEpFile && !firstReadSeen) {
        firstReadSeen = true
        bump(role, 'read-ground')
        continue
      }
      if (isWrite && onEpFile && c.isError !== true && !firstWriteOkSeen) {
        firstWriteOkSeen = true
        firstWriteTool = c.name
        /** `write` 是整文件写入，`aura_edit` 带 `create` 是新建：两者都**不需要先读**，契约下界因此只有 1。 */
        firstWriteIsCreate = c.name === 'write' || (c.args !== null && typeof c.args === 'object' && c.args.create !== undefined)
        bump(role, 'write-first')
        bump(role, `write-first:${c.name}`)
        // 这一笔之后，本 episode 里该文件上的写就都齐了 → 作为「引用」用的 haystack
        continue
      }
      if (isWrite && onEpFile && c.isError !== true) {
        bump(role, 'write-extra-ok')
        bump(role, 'write-extra-ok:字符', c.chars)
        continue
      }
      if (isRead && onEpFile) {
        bump(role, 'read-extra')
        bump(role, 'read-extra:字符', c.chars)
        continue
      }
      if (k !== null) {
        bump(role, 'other-file')
        bump(role, 'other-file:字符', c.chars)
        continue
      }
      bump(role, 'tool-other')
      bump(role, 'tool-other:字符', c.chars)
      bump(role, `tool-other:${c.name}`)
    }

    // ── 「回执里有多少字符被后续写调用逐字用到」（上限口径）
    const laterStrings = []
    for (let j = 0; j < span.length; j += 1) {
      const c = span[j]
      if (!WRITE.has(c.name)) continue
      const k = fileOf(c) === null ? null : keyOf(fileOf(c))
      if (k !== ep.key) continue
      // 只算「这一条读之后」的写：按位置切
      laterStrings.push({ j, hay: stringsOf(c.args ?? {}).join('\n') })
    }
    for (let j = 0; j < span.length; j += 1) {
      const c = span[j]
      if (!READ.has(c.name)) continue
      const k = fileOf(c) === null ? null : keyOf(fileOf(c))
      if (k !== ep.key || c.text.length === 0) continue
      const hay = laterStrings.filter((x) => x.j > j).map((x) => x.hay).join('\n')
      quote.receipts += 1
      quote.receiptChars += c.chars
      if (hay.length === 0) {
        quote.receiptNoWrite += 1
        quote.receiptNoWriteChars += c.chars
      }
      for (const line of c.text.split('\n')) {
        const m = /^\s*(\d+): (.*)$/.exec(line)
        const body = (m === null ? line : m[2]).trim()
        if (body.length < MIN_NEEDLE) {
          quote.nonNeedleChars += body.length
          continue
        }
        quote.needleChars += body.length
        if (hay.length > 0 && hay.includes(body)) quote.refChars += body.length
        else quote.unrefChars += body.length
      }
    }

    const t0s = span.filter((c) => c.t0 !== null).map((c) => c.t0)
    const t1s = span.filter((c) => c.t1 !== null).map((c) => c.t1)
    const start = t0s.length > 0 ? Math.min(...t0s) : null
    const end = t1s.length > 0 ? Math.max(...t1s) : start
    const sec = start !== null && end !== null ? (end - start) / 1000 : null
    // busy：相邻事件间隔封顶后求和
    const stamps = [...new Set([...t0s, ...t1s])].sort((a, b) => a - b)
    let busy = 0
    for (let j = 1; j < stamps.length; j += 1) busy += Math.min(stamps[j] - stamps[j - 1], IDLE_CAP_MS)
    const fileCalls = span.filter((c) => fileOf(c) !== null && keyOf(fileOf(c)) === ep.key)
    const readsInSpan = span.filter((c) => READ.has(c.name) && fileOf(c) !== null && keyOf(fileOf(c)) === ep.key).length

    rows.push({
      session: path.basename(path.dirname(f)),
      file: ep.file,
      fileBase: baseOf(ep.file),
      calls: span.length,
      chars: sum(span.map((c) => c.chars)),
      sec,
      busy: busy / 1000,
      fileCalls: fileCalls.length,
      fileChars: sum(fileCalls.map((c) => c.chars)),
      readsInSpan,
      firstWriteTool,
      firstWriteIsCreate,
      writes: writes.length,
      writeOk: writeOk.length,
      wasteCalls,
      wasteChars,
      wasteMs,
      waste,
    })

    if (samples.length < opts.sample) samples.push({ file: ep.file, session: path.basename(path.dirname(f)), span: span.map((c) => ({ name: c.name, chars: c.chars, isError: c.isError, args: c.args, head: c.text.slice(0, 220) })) })
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * ⑤ 打印
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 打印区沿用原来的名字，指向**全量桶**里的同一批容器（对象/数组/Map 都是引用）——
 * 所以下面每一行输出逐字未动：不加 `--split-at` 时读数与改造前逐字节相同。
 * `--split-at` 的那一节（§B）另外读两窗的桶。
 */
const { corpus, rows, role, quote, hist, sensitivity, samples } = aggAll

const changed = rows
const series = (get, filter = () => true) => changed.filter(filter).map(get).filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b)

function distTable(title, seriesList, note = '') {
  say(`\n=== ${title}${note ? `（${note}）` : ''} ===`)
  say(`  ${'指标'.padEnd(22)}${'n'.padStart(7)}${'min'.padStart(8)}${'p10'.padStart(9)}${'p25'.padStart(9)}${'p50'.padStart(9)}${'p75'.padStart(9)}${'p90'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}${'mean'.padStart(10)}${'合计'.padStart(14)}`)
  for (const [label, xs, fmt] of seriesList) {
    const s = [...xs].sort((a, b) => a - b)
    const f = fmt ?? n2
    say(
      `  ${label.padEnd(22)}${String(s.length).padStart(7)}${f(quant(s, 0)).padStart(8)}${f(quant(s, 0.1)).padStart(9)}${f(quant(s, 0.25)).padStart(9)}` +
        `${f(quant(s, 0.5)).padStart(9)}${f(quant(s, 0.75)).padStart(9)}${f(quant(s, 0.9)).padStart(9)}${f(quant(s, 0.99)).padStart(9)}${f(quant(s, 1)).padStart(9)}` +
        `${f(s.length === 0 ? null : sum(s) / s.length).padStart(10)}${f(s.length === 0 ? null : sum(s)).padStart(14)}`,
    )
  }
}

const totalReceiptChars = corpus.chars
const histTotal = [...hist.values()].reduce((a, b) => a + b, 0)

say('')
say('════════════════════════════════════════════════════════════════════════')
say('  一次「逻辑改动」的价钱 —— 调用次数 × (固定税 + 工具耗时) + 回执字符')
say('════════════════════════════════════════════════════════════════════════')

say('\n=== 0. 语料（原始读数）===')
say(`  会话根                    : ${opts.root}`)
say(`  会话文件（含工具调用的）  : ${corpus.sessionsWithCalls} / 扫描 ${corpus.files}${opts.limit > 0 ? `（--limit ${opts.limit}，**不是全量**）` : '（全量）'}`)
say(`  本次自身会话（DSH_SESSION_ID）: ${selfId === '' ? '环境里没有' : selfHit.length === 0 ? `未在语料里（${selfId}）` : opts.includeSelf ? `已计入（${selfId}）` : `已排除（${selfId}，另有 ${selfHit.length} 个文件）`}`)
say(`  压缩字节 / zstd 帧        : ${corpus.bytes} / ${corpus.frames}（resync ${corpus.resyncs} 次；坏帧忽略）`)
say(`  工具调用合计              : ${corpus.calls}`)
say(`  回执字符合计              : ${totalReceiptChars}`)
say(`  没有回执的调用            : ${corpus.pending}；一条调用收到多个 result 的 : ${corpus.multiResult}；找不到调用的 result : ${corpus.resultOrphans}`)
say('')
say(`  工具名分布（top 14）：`)
for (const [name, n] of [...corpus.tally].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  const lat = [...(corpus.latency.get(name) ?? [])].sort((a, b) => a - b)
  say(
    `    ${name.padEnd(16)}${String(n).padStart(7)} 次   回执 ${String(corpus.charsByTool.get(name) ?? 0).padStart(11)} 字符   ` +
      `工具耗时 p50 ${n0(quant(lat, 0.5)).padStart(7)} ms  p90 ${n0(quant(lat, 0.9)).padStart(8)} ms  累计 ${String(corpus.msByTool.get(name) ?? 0).padStart(11)} ms`,
  )
}
say(`  （工具耗时 = 单次调用的 tool/result 时间 − tool/call 时间；累计值含被挂起/等后台任务的长尾，**不是墙钟**；负值 ${corpus.negativeLatency} 条已剔除）`)
const missTotal = [...corpus.fileArgMiss.values()].reduce((a, b) => a + b, 0)
say('')
say(`  读写调用里取不到文件路径的                  : ${missTotal}${missTotal === 0 ? '  ✓（口径无洞）' : `  ⚠ ${JSON.stringify(Object.fromEntries(corpus.fileArgMiss))}（这些调用进不了任何 episode，是口径的洞）`}`)
say(`  读调用里能定出行区间的                      : ${corpus.readsWithRange} / ${(corpus.tally.get('aura_read') ?? 0) + (corpus.tally.get('read') ?? 0)}`)
say(`  aura_edit 每次带几个 hunk（0 表示 create）   : ${JSON.stringify(Object.fromEntries([...corpus.hunksPerEdit].sort((a, b) => Number(a[0]) - Number(b[0]))))}`)
say(`  同一会话内「同文件 + 回执一字不差」的重复读  : ${corpus.identicalSessionReads} 次 / ${corpus.identicalSessionReadChars} 字符`)
const perRepeat = corpus.sameAddrReads === 0 ? '—' : (corpus.sameAddrReadChars / corpus.sameAddrReads).toFixed(0)
const perFirst = corpus.sameAddrReads === 0 ? '—' : (corpus.sameAddrFirstChars / corpus.sameAddrReads).toFixed(0)
say(`  同一会话内「同文件 + 同一地址签名」的重复读: ${corpus.sameAddrReads} 次 / ${corpus.sameAddrReadChars} 字符（同地址的首次读共 ${corpus.sameAddrFirstChars} 字符 ⇒ 重复读平均 ${perRepeat} 字符 vs 首次 ${perFirst} 字符）`)
say(`  同一会话内「同文件 + 行区间相交」的重复读  : ${corpus.overlapSessionReads} 次 / ${corpus.overlapSessionReadChars} 字符（相交含「整文件重读」这种平凡相交，看数不看比例）`)
say(`  更严的一档：本次读的区间整个落在上次读过的区间里: ${corpus.containedSessionReads} 次 / ${corpus.containedSessionReadChars} 字符（一个字都没新增）`)
say(`  同一会话内「同名同参数 + 回执一字不差」的调用: ${corpus.duplicateCallReceipts} 次 / ${corpus.duplicateCallReceiptChars} 字符`)

say('\n=== 1. 「一次逻辑改动」的定义 ===')
say('  同一会话内、同一文件上的一串读写调用；两串之间以「夹了 ≥ N 个别的调用」为界；')
say('  一段里至少一次写成功才算一次「有意义的改动」。代价取整段 span（含段内别的文件与别的工具）。')
say('  ⚠ span 会互相重叠：A 文件那次改动的段里若夹着 B 文件的一次读，这次读同时算进 A 与 B 两段。')
say('     所以 §3/§4/§6 的合计是「按每次改动各记一笔」，不是全部调用的一次划分。')
say(`  N = ${opts.gap}（本次运行值，--gap 可改）。N 的经验依据：相邻同文件读写调用之间夹了几个别的调用 ——`)
for (const b of ['0', '1', '2', '3', '4', '5-9', '10-19', '20-49', '50+']) {
  const n = hist.get(b) ?? 0
  const bar = '█'.repeat(Math.min(40, Math.round((40 * n) / Math.max(1, histTotal))))
  say(`    ${b.padStart(6)} 个 : ${String(n).padStart(6)}  (${pctf(n, histTotal).padStart(6)}) ${bar}`)
}
say(`  合计相邻对 ${histTotal}`)
const cov = (N) => {
  let inN = 0
  let allN = 0
  for (const [b, n] of hist) {
    allN += n
    const lo = b.includes('-') ? Number(b.split('-')[0]) : b === '50+' ? 50 : Number(b)
    if (lo < N) inN += n
  }
  return allN === 0 ? 0 : inN / allN
}
say(`  ⇒ 夹 0 个别的调用占 ${pctf(cov(1), 1)}，< 2 占 ${pctf(cov(2), 1)}，< ${opts.gap} 占 ${pctf(cov(opts.gap), 1)}，< 5 占 ${pctf(cov(5), 1)}`)
say('  N 取 3：一是 >1，好让一次无关调用（读别的文件、跑一次命令）不把一次改动劈成两半；')
say('  二是 ≤3，好在模型确实走开之后立刻收口。下面给敏感性表——结论若不随 N 稳，就不是结论。')

say('\n=== 2. 敏感性：N 变了，结论会不会变 ===')
say(`  ${'N'.padStart(3)}${'改动次数'.padStart(11)}${'调用中位'.padStart(11)}${'调用 p90'.padStart(11)}${'字符中位'.padStart(11)}${'字符 p90'.padStart(11)}`);
{
  for (const g of [1, 2, opts.gap, 5, 8]) {
    const b = sensitivity.get(g)
    if (b === undefined) continue
    const s = [...b.sizes].sort((a, b2) => a - b2)
    const cs = [...b.charSizes].sort((a, b2) => a - b2)
    say(
      `  ${String(g).padStart(3)}${String(b.changed).padStart(11)}${n0(quant(s, 0.5)).padStart(11)}${n0(quant(s, 0.9)).padStart(11)}` +
        `${n0(quant(cs, 0.5)).padStart(11)}${n0(quant(cs, 0.9)).padStart(11)}`,
    )
  }
}

say('\n=== 3. 分布（主口径 = 至少一次写成功的改动）===')
say(`  改动次数 : ${changed.length}`)
distTable('每次改动的代价', [
  ['调用次数（整段 span）', series((r) => r.calls), n0],
  ['回执字符（整段 span）', series((r) => r.chars), n0],
  ['墙钟秒（首→末回执）', series((r) => r.sec), n2],
  ['busy 秒（间隔封顶 120s）', series((r) => r.busy), n2],
  ['只算该文件的调用次数', series((r) => r.fileCalls), n0],
  ['只算该文件的回执字符', series((r) => r.fileChars), n0],
  ['失败的调用次数', series((r) => r.waste.get('failed') ?? 0), n0],
  ['落地成功的写次数', series((r) => r.writeOk), n0],
])

/**
 * §3 的分布是**两种改动混在一起**的，必须拆开，否则中位数会被其中一种主导：
 *
 *   · 「读了再改」——段内有该文件的读，代价里含一次真读；这是工具设计的正常路径。
 *   · 「凭记忆改」——段内一次读都没有。它便宜（中位 1 次调用）但不是因为工具好，
 *     而是因为**读发生在了更早、落在段外**（或这次写是 `write` 新建文件，本就不需要读）。
 *
 * 不拆开就会读出一个漂亮的「中位 1 次调用」，而它回答不了「改动贵不贵」。
 */
say('\n=== 3b. 把两种改动拆开（不拆开，中位数会被其中一种主导）===')
const withRead = changed.filter((r) => r.readsInSpan > 0)
const noRead = changed.filter((r) => r.readsInSpan === 0)
say(`  ${'子集'.padEnd(26)}${'n'.padStart(7)}${'调用 p50'.padStart(11)}${'调用 p90'.padStart(11)}${'字符 p50'.padStart(11)}${'秒 p50'.padStart(10)}${'busy p50'.padStart(10)}`)
for (const [label, n, pred] of [
  ['读了再改（段内有读）', withRead.length, (r) => r.readsInSpan > 0],
  ['凭记忆改（段内无读）', noRead.length, (r) => r.readsInSpan === 0],
  ['全部改动', changed.length, () => true],
]) {
  say(
    `  ${label.padEnd(26)}${String(n).padStart(7)}${n2(quant(series((r) => r.calls, pred), 0.5)).padStart(11)}` +
      `${n2(quant(series((r) => r.calls, pred), 0.9)).padStart(11)}${n2(quant(series((r) => r.chars, pred), 0.5)).padStart(11)}` +
      `${n2(quant(series((r) => r.sec, pred), 0.5)).padStart(10)}${n2(quant(series((r) => r.busy, pred), 0.5)).padStart(10)}`,
  )
}
const firstTools = new Map()
for (const r of changed) bump(firstTools, r.firstWriteTool ?? '(无)')
say(`  第一次落地写用的工具分布：${[...firstTools].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  ')}`)

const mCalls = quant(series((r) => r.calls), 0.5)
const mChars = quant(series((r) => r.chars), 0.5)
const mSec = quant(series((r) => r.sec), 0.5)
const mBusy = quant(series((r) => r.busy), 0.5)
const mWasteCalls = quant(series((r) => r.wasteCalls), 0.5)
const mWasteChars = quant(series((r) => r.wasteChars), 0.5)

say('\n=== 4. 浪费项点名（一个调用最多进一类，去重后合计）===')
const wasteClasses = ['failed', 'reread-identical', 'reread-overlap', 'noop']
const classCalls = wasteClasses.map((c) => [c, role.get(`waste:${c}`) ?? 0, role.get(`waste:${c}:字符`) ?? 0])
const wCallsTotal = sum(classCalls.map((x) => x[1]))
const wCharsTotal = sum(classCalls.map((x) => x[2]))
const spanCallsTotal = sum(changed.map((r) => r.calls))
const spanCharsTotal = sum(changed.map((r) => r.chars))
say(`  ${'类别'.padEnd(20)}${'次数'.padStart(8)}${'占 span 调用'.padStart(14)}${'字符'.padStart(13)}${'占 span 字符'.padStart(14)}`)
for (const [name, n, ch] of classCalls) say(`  ${name.padEnd(20)}${String(n).padStart(8)}${pctf(n, spanCallsTotal).padStart(14)}${String(ch).padStart(13)}${pctf(ch, spanCharsTotal).padStart(14)}`)
say(`  ${'浪费合计（去重）'.padEnd(20)}${String(wCallsTotal).padStart(8)}${pctf(wCallsTotal, spanCallsTotal).padStart(14)}${String(wCharsTotal).padStart(13)}${pctf(wCharsTotal, spanCharsTotal).padStart(14)}`)
const wasteMsCapped = [...changed].reduce((a, r) => a + Math.min(r.wasteMs, r.calls * IDLE_CAP_MS), 0)
say(`  浪费调用的工具耗时（单次封顶 120s 后求和）: ${wasteMsCapped} ms（并行会重叠，不等于墙钟）`)
say('')
say('  · 4.1 失败的调用（重试税）—— 上表 `failed`（只算**段内**的失败）。全机失败构成见 `probes/edit-failure-census.mjs`。')
say('  · 4.2 同一区间被重复读 —— 段内：`reread-identical`（同地址或回执一字不差）+ `reread-overlap`（行区间相交）；')
say(`    段内只是窗口 N=${opts.gap} 内的下界，会话级计数见 §0（同地址签名 ${corpus.sameAddrReads} 次、区间相交 ${corpus.overlapSessionReads} 次）。`)
say(`    段内覆盖 ${pctf(corpus.readsWithRange, (corpus.tally.get('aura_read') ?? 0) + (corpus.tally.get('read') ?? 0))} 的读调用；区间定不出来的读不计入 overlap。`)
say(`  · 4.3 空转调用 —— noop：同名同参数、回执一字不差地又调了一次（段内 ${role.get('waste:noop') ?? 0} 次；`)
say(`    会话级不分段是 ${corpus.duplicateCallReceipts} 次 / ${corpus.duplicateCallReceiptChars} 字符，见 §0）。`)
say('  · 4.4 大回执里没被后续写调用逐字引用的部分（**上限**，见下表）：')
say(`      读回执条数 ${quote.receipts} / 字符 ${quote.receiptChars}`)
say(`      其中「可作证据的长行」字符 ${quote.needleChars}，短行与表头 ${quote.nonNeedleChars}`)
say(`      长行里被后续写调用逐字用到 ${quote.refChars}，没被用到 ${quote.unrefChars}（= 读回执字符的 ${pctf(quote.unrefChars, quote.receiptChars)}）`)
say(`      段内该文件之后再没发生任何写的读回执：${quote.receiptNoWrite} 条 / ${quote.receiptNoWriteChars} 字符（按构造 0 引用）`)
say('      为什么是上限：只有**逐字**出现才算「用到」，模型可能只是据它判断；反过来也可能把原文改了几个字再引用。')

say('\n=== 5. 结论（一句可核）===')
say('')
/* ── §5 结论 ─────────────────────────────────────────────────────────────
 * 措辞上的一个坑：中位改动只有 1 次调用，于是「其中 W 是浪费」的中位数恒为 0。
 * 直接写「中位 = 1 次调用，其中 0 次浪费」是**结构上不可能有浪费**的同义反复，不是好消息。
 * 所以这句结论给三个数：中位、均摊、以及浪费的合计占比；并把双峰拆开讲。
 */
const meanCalls = changed.length === 0 ? null : spanCallsTotal / changed.length
const meanChars = changed.length === 0 ? null : spanCharsTotal / changed.length
const meanWasteCalls = changed.length === 0 ? null : wCallsTotal / changed.length
const meanWasteChars = changed.length === 0 ? null : wCharsTotal / changed.length
const meanBusy = changed.length === 0 ? null : sum(changed.map((r) => r.busy)) / changed.length
const noWasteShare = changed.filter((r) => r.wasteCalls === 0).length
say(`  中位一次逻辑改动 = ${n0(mCalls)} 次调用 / ${n0(mChars)} 字符 / ${n2(mBusy)} 秒（busy 口径；原始墙钟中位 ${n2(mSec)} 秒）；`)
say(`  中位浪费         = ${n0(mWasteCalls)} 次调用 / ${n0(mWasteChars)} 字符 —— 这个 0 是**结构性的**（中位改动只有 1 次调用，装不下浪费），不是好消息，所以读下面那行均摊。`)
say(`  均摊每次改动     = ${n2(meanCalls)} 次调用 / ${n2(meanChars)} 字符 / ${n2(meanBusy)} 秒；`)
say(`  其中浪费         = ${n2(meanWasteCalls)} 次调用 / ${n2(meanWasteChars)} 字符（均摊到每次改动；合计占比：调用 ${pctf(wCallsTotal, spanCallsTotal)}、字符 ${pctf(wCharsTotal, spanCharsTotal)}）。`)
say('')
say('  ⚠ 中位数会骗人，这三行必须一起读：')
say(`    · 中位改动只有 ${n0(mCalls)} 次调用，**不是因为它高效**，而是因为读落在了段外（N=${opts.gap} 的窗口之外）。`)
say(`      段内一次读都没有的改动 ${noRead.length} / ${changed.length}（${pctf(noRead.length, changed.length)}），这一档中位 ${n0(quant(series((r) => r.calls, (r) => r.readsInSpan === 0), 0.5))} 次调用 / ${n0(quant(series((r) => r.chars, (r) => r.readsInSpan === 0), 0.5))} 字符；`)
say(`      段内有读的那一档（${withRead.length} / ${changed.length}）中位 ${n0(quant(series((r) => r.calls, (r) => r.readsInSpan > 0), 0.5))} 次调用 / ${n0(quant(series((r) => r.chars, (r) => r.readsInSpan > 0), 0.5))} 字符 / ${n2(quant(series((r) => r.busy, (r) => r.readsInSpan > 0), 0.5))} 秒。`)
say(`    · 浪费不是「每次都有一点」，而是「一部分改动很贵」：浪费调用数为 0 的改动 ${noWasteShare} 个（${pctf(noWasteShare, changed.length)}）。`)
say(`    · 均值 ${n2(meanCalls)} 次 > 中位 ${n0(mCalls)} 次，长尾在 p90=${n0(quant(series((r) => r.calls), 0.9))} / p99=${n0(quant(series((r) => r.calls), 0.99))} 次，最大 ${n0(quant(series((r) => r.calls), 1))} 次。`)

say('\n=== 6. 下界与差距归因 ===')
say('  下界推导（一步都不能少的动作）：')
say('    · 一次 `aura_edit` 可以带多个 hunk（§0 已给每次调用的 hunk 数分布）⇒ 同一文件上的多处')
say('      修改**不需要**多次调用：写这一侧的下界 = 1。')
say('    · `write` 是整文件写入、`aura_edit` 带 `create` 是新建：两者都不需要先读原文。')
say('    · 校验（回读比对、CAS、陈旧闸门）在引擎内部完成，不额外收调用费。')
say('')
say('  ⇒ 两个下界，**别混用**：')
say('     LB-契约 = 1 次/改动：一次调用就足以落地（工具契约允许；write/create 不读也能写）。')
say('     LB-有据 = 2 次/改动：改**已有文件**时先读到当前字节（hunk 的 old/expect 要原文，')
say('        引擎的陈旧闸门也要同一会话内的观测令牌）⇒ 1 读 + 1 写。')
say('')
const createLed = changed.filter((r) => r.firstWriteIsCreate)
const lbTotal = createLed.length + 2 * (changed.length - createLed.length)
say(`     实测：首次落地写是 write/create 的改动 ${createLed.length} / ${changed.length}（${pctf(createLed.length, changed.length)}）⇒ 这部分 LB=1；`)
say(`           其余 ${changed.length - createLed.length} 个以编辑已有文件为主，LB=2。`)
say(`   ⇒ 本语料的总下界 = ${createLed.length}×1 + ${changed.length - createLed.length}×2 = ${lbTotal} 次调用；实测 span 调用 ${spanCallsTotal} 次。`)
say(`      差 ${spanCallsTotal - lbTotal} 次（${(spanCallsTotal / Math.max(1, lbTotal)).toFixed(2)}× 于下界）。`)
/**
 * 差距的逐项归因：
 *
 *   差 = 零配额类 − 「下界要求、但窗口内没出现」的那部分
 *
 * 零配额类 = 下界分配 0 次的东西（多余成功写、段内别的文件、段内非文件工具、失败、重复读、空转）。
 * 后半项必须减：下界也**要求**一次有据的读，而只有一部分改动真的在窗口内读了（其余读在窗口外），
 * 不减就会把「少读的那部分」当成浪费。这个式子是恒等式（九类恰好分完 span），
 * 所以它同时是一个自检：两边不相等就说明角色表漏了一类。
 */
const zeroQuota =
  (role.get('write-extra-ok') ?? 0) +
  (role.get('other-file') ?? 0) +
  (role.get('tool-other') ?? 0) +
  (role.get('waste:failed') ?? 0) +
  (role.get('waste:reread-identical') ?? 0) +
  (role.get('waste:reread-overlap') ?? 0) +
  (role.get('waste:noop') ?? 0)
const inWindow = (role.get('read-ground') ?? 0) + (role.get('read-extra') ?? 0) + (role.get('write-first') ?? 0)
say(`      逐项归因（恒等式，可直接对账）：零配额类 ${zeroQuota} − 窗口内没出现的下界项 ${lbTotal - inWindow} = ${zeroQuota - (lbTotal - inWindow)}`)
say(
  `        零配额类 = 多余成功写 ${role.get('write-extra-ok') ?? 0} + 段内别的文件 ${role.get('other-file') ?? 0} + 段内非文件工具 ${role.get('tool-other') ?? 0} + ` +
    `失败 ${role.get('waste:failed') ?? 0} + 重复读 ${(role.get('waste:reread-identical') ?? 0) + (role.get('waste:reread-overlap') ?? 0)} + 空转 ${role.get('waste:noop') ?? 0}`,
)
say(`        窗口内没出现的下界项 = 下界 ${lbTotal} −（窗口内读 ${(role.get('read-ground') ?? 0) + (role.get('read-extra') ?? 0)} + 首次写 ${role.get('write-first') ?? 0}）`)
say('')
say('  多出来的部分，按机制归因（下面九类恰好分完 span 调用，自检见末行）：')
say(`  ${'角色'.padEnd(26)}${'合计次数'.padStart(10)}${'占 span 调用'.padStart(14)}${'每改动均值'.padStart(12)}`)
const roleRows = [
  ['read-ground 起的必要读', role.get('read-ground') ?? 0],
  ['write-first 落地的那次写', role.get('write-first') ?? 0],
  ['多余的成功写（同文件）', role.get('write-extra-ok') ?? 0],
  ['多余的读（同文件，非重复）', role.get('read-extra') ?? 0],
  ['段内别的文件', role.get('other-file') ?? 0],
  ['段内非文件工具（pwsh/grep/…）', role.get('tool-other') ?? 0],
  ['浪费：失败', role.get('waste:failed') ?? 0],
  ['浪费：重复读', (role.get('waste:reread-identical') ?? 0) + (role.get('waste:reread-overlap') ?? 0)],
  ['浪费：空转', role.get('waste:noop') ?? 0],
]
for (const [name, n] of roleRows) {
  const per = changed.length === 0 ? null : n / changed.length
  say(`  ${name.padEnd(26)}${String(n).padStart(10)}${pctf(n, spanCallsTotal).padStart(14)}${n2(per).padStart(12)}`)
}
say(`  ${'合计（= span 调用）'.padEnd(26)}${String(spanCallsTotal).padStart(10)}${'100.0%'.padStart(14)}${n2(changed.length === 0 ? null : spanCallsTotal / changed.length).padStart(12)}`)
const roleSum = sum(roleRows.map(([, n]) => n))
say(`  自检：九类相加 ${roleSum} vs span 调用合计 ${spanCallsTotal} ⇒ ${roleSum === spanCallsTotal ? '✓ 恰好分完，无遗漏类别' : `⚠ 差 ${spanCallsTotal - roleSum}（有调用没被归入任何一类，口径有洞）`}`)
// C48：自检的读数原处不变（不许多一个字：默认路径要逐字节不变），判定接上退出码。
// `var` 是因为汇总段在文件后半（§⑦）。
var roleOk = roleSum === spanCallsTotal
if (opts.splitAt !== null && !roleOk) {
  violations.push(`角色表自检：九类相加 ${roleSum} vs span 调用合计 ${spanCallsTotal}（差 ${spanCallsTotal - roleSum}）`)
}
say('')
say(`  段内非文件工具里最贵的三样：${[...role.entries()].filter(([k]) => k.startsWith('tool-other:')).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k.slice(11)}×${v}`).join('  ') || '—'}`)

if (opts.top > 0) {
  say(`\n=== 7. 最贵的 ${opts.top} 次改动（按调用次数）===`)
  for (const r of [...changed].sort((a, b) => b.calls - a.calls).slice(0, opts.top)) {
    say(`  ${String(r.calls).padStart(3)} 次 / ${String(r.chars).padStart(7)} 字符 / ${n2(r.sec).padStart(8)} 秒  浪费 ${r.wasteCalls} 次 ${JSON.stringify(Object.fromEntries(r.waste))}  ${r.fileBase}`)
    say(`      ${r.file}`)
  }
}

const topFiles = new Map()
for (const r of changed) bump(topFiles, r.fileBase)
say(`\n=== 8. 语料构成：改动最多的 12 个文件 ===`)
for (const [name, n] of [...topFiles].sort((a, b) => b[1] - a[1]).slice(0, 12)) say(`  ${String(n).padStart(5)} 次改动  ${name}`)

if (opts.sample > 0) {
  say(`\n=== 9. 回执样本（校对字符口径用）===`)
  for (const s of samples) {
    say(`  ── ${s.file}  (${s.session})`)
    for (const c of s.span) say(`    [${c.name}] err=${c.isError} chars=${c.chars} args=${JSON.stringify(c.args).slice(0, 160)}`)
    say(`    ── 首条回执前 220 字符：`)
    say(`    ${String(s.span[0]?.head ?? '').replace(/\n/g, '\n    ')}`)
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * ⑥ 部署切窗对照（--split-at）
 *
 * 换「读侧取景形状」的触发条件是两格读数：本探针负责的「一次逻辑改动的均摊调用次数」，
 * 与 `reread-cause.mjs` 的「重复读里全新区间占比」。历史值（3.17 次/改动、51.7%）里
 * **不含新工具的行为**，所以拿它当对照没有意义 —— 要的是「部署后新会话 vs 部署前会话」
 * 这样一次同口径切窗。这一节就是把那次切窗做成现成能力：重启后一条命令就能回答触发条件。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 每窗最少要有多少次工具调用 / 多少次「一次逻辑改动」——低于此不给结论。 */
const SPLIT_MIN_CALLS = 30
const SPLIT_MIN_CHANGES = 30
/** 触发格判定的「没动」带：两窗相对变化落在这个带内算没动。 */
const TRIGGER_TOL = 0.05

/** 一个桶的核心读数 —— 字段与 §3/§4/§5 同一批，值由同一段代码算出，只是换了桶。 */
function coreOf(T) {
  const rs = T.rows
  const n = rs.length
  const spanCalls = sum(rs.map((r) => r.calls))
  const spanChars = sum(rs.map((r) => r.chars))
  const wasteCalls = wasteClasses.reduce((a, c) => a + (T.role.get(`waste:${c}`) ?? 0), 0)
  const wasteChars = wasteClasses.reduce((a, c) => a + (T.role.get(`waste:${c}:字符`) ?? 0), 0)
  const secs = rs.map((r) => r.sec).filter((x) => x !== null && Number.isFinite(x))
  return {
    sessions: T.corpus.sessionsWithCalls,
    files: T.corpus.files,
    calls: T.corpus.calls,
    chars: T.corpus.chars,
    changes: n,
    spanCalls,
    spanChars,
    meanCalls: n === 0 ? null : spanCalls / n,
    meanChars: n === 0 ? null : spanChars / n,
    meanBusy: n === 0 ? null : sum(rs.map((r) => r.busy)) / n,
    meanSec: secs.length === 0 ? null : sum(secs) / secs.length,
    medCalls: quant(rs.map((r) => r.calls).sort((a, b) => a - b), 0.5),
    medChars: quant(rs.map((r) => r.chars).sort((a, b) => a - b), 0.5),
    wasteCalls,
    wasteChars,
    wasteCallShare: spanCalls === 0 ? null : wasteCalls / spanCalls,
    wasteCharShare: spanChars === 0 ? null : wasteChars / spanChars,
    meanWasteCalls: n === 0 ? null : wasteCalls / n,
    enough: T.corpus.calls >= SPLIT_MIN_CALLS && n >= SPLIT_MIN_CHANGES,
  }
}

const pct1 = (x) => (x === null || !Number.isFinite(x) ? '—' : `${(100 * x).toFixed(1)}%`)

/** 「前 → 后」并以绝对差 + 相对差（分母是前窗）收尾；任一侧量不出就不给差。 */
function arrow(before, after, fmt = n2) {
  if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) {
    return `${fmt(before)} → ${fmt(after)}（有一窗量不出，不给差）`
  }
  const d = after - before
  const rel = before === 0 ? null : d / before
  return `${fmt(before)} → ${fmt(after)}（${d >= 0 ? '+' : ''}${fmt(d)}${rel === null ? '' : `，${rel >= 0 ? '+' : ''}${(100 * rel).toFixed(1)}%`}）`
}

function printSplitWindow(label, c) {
  say('')
  say(`  ── ${label} ──`)
  say(`    会话 / 扫描文件        : ${c.sessions} 个 / ${c.files} 个`)
  say(`    工具调用 / 回执字符    : ${c.calls} 次 / ${c.chars} 字符`)
  say(`    一次逻辑改动（主口径） : ${c.changes} 次`)
  say(`    均摊每次改动           : ${n2(c.meanCalls)} 次调用 / ${n2(c.meanChars)} 字符 / busy ${n2(c.meanBusy)} 秒（原始墙钟均值 ${n2(c.meanSec)} 秒）`)
  say(`    中位每次改动           : ${n0(c.medCalls)} 次调用 / ${n0(c.medChars)} 字符`)
  say(`    浪费（去重后）         : ${c.wasteCalls} 次调用（占 span 调用 ${pctf(c.wasteCalls, c.spanCalls)}）/ ${c.wasteChars} 字符（占 span 字符 ${pctf(c.wasteChars, c.spanChars)}）；均摊 ${n2(c.meanWasteCalls)} 次/改动`)
  say(
    `    样本判据               : 调用 ${c.calls} ${c.calls >= SPLIT_MIN_CALLS ? '≥' : '<'} ${SPLIT_MIN_CALLS} 且 改动 ${c.changes} ${c.changes >= SPLIT_MIN_CHANGES ? '≥' : '<'} ${SPLIT_MIN_CHANGES}` +
      ` ⇒ ${c.enough ? '样本充足，可读' : '**样本不足：上面这些数只当记账，不当读数、不给结论**'}`,
  )
}

if (split !== null) {
  say('')
  say('════════════════════════════════════════════════════════════════════════')
  say('  B. 部署切窗对照 —— 切点前窗 vs 切点后窗（同一段代码、同一套判据）')
  say('════════════════════════════════════════════════════════════════════════')
  say(`  切点 --split-at   : ${new Date(split.cut).toISOString()}（epoch ${split.cut} ms，上面按 UTC 打印）`)
  say(`  定窗判据          : 会话内**最早一次调用**的时刻 < 切点 ⇒ 前窗，≥ 切点 ⇒ 后窗（不按文件 mtime）`)
  say(`  退回文件 mtime 的 : ${split.byMtime} 个会话（这些会话一个时间戳都没有，是口径的已知让步）`)
  say(`  跨切点的会话      : ${split.straddleSessions} 个，其中落在切点之后的调用 ${split.straddleCalls} 次 —— 整场归前窗`)
  say('    为什么这么归：跨切点的会话身上一定带着旧工具的行为，放进**后窗**正好污染')
  say('    「新工具做了什么」那一格；放前窗只会稀释前窗。偏差写在这里，不藏进某一窗。')

  const bc = coreOf(split.before)
  const ac = coreOf(split.after)
  printSplitWindow('前窗（< 切点）', bc)
  printSplitWindow('后窗（≥ 切点）', ac)

  say('')
  say('  同口径对照（前窗 → 后窗；两窗同代码、同判据，只有会话集合不同）：')
  say(`    均摊调用次数   ${arrow(bc.meanCalls, ac.meanCalls)}`)
  say(`    均摊回执字符   ${arrow(bc.meanChars, ac.meanChars)}`)
  say(`    均摊 busy 秒   ${arrow(bc.meanBusy, ac.meanBusy)}`)
  say(`    均摊墙钟秒     ${arrow(bc.meanSec, ac.meanSec)}`)
  say(`    中位调用次数   ${arrow(bc.medCalls, ac.medCalls, n0)}`)
  say(`    浪费调用占比   ${arrow(bc.wasteCallShare, ac.wasteCallShare, pct1)}`)
  say(`    浪费字符占比   ${arrow(bc.wasteCharShare, ac.wasteCharShare, pct1)}`)
  say(`    （两窗改动次数 ${bc.changes} → ${ac.changes}；调用 ${bc.calls} → ${ac.calls}）`)

  say('')
  say('  触发格判定（本探针负责的那一格：「一次逻辑改动的均摊调用次数」）')
  if (!bc.enough || !ac.enough) {
    say(`    **样本不足，不给结论**：判这一格要求两窗都「调用 ≥ ${SPLIT_MIN_CALLS} 且 改动 ≥ ${SPLIT_MIN_CHANGES}」，`)
    say(`    现在是 前窗 ${bc.calls} 次调用 / ${bc.changes} 次改动，后窗 ${ac.calls} 次调用 / ${ac.changes} 次改动。`)
    say('    样本不够时唯一诚实的话是「再跑一段」——小样本的「没动」和真的没动长得一模一样。')
  } else {
    const rel = bc.meanCalls === 0 ? null : (ac.meanCalls - bc.meanCalls) / bc.meanCalls
    const moved = rel === null || Math.abs(rel) > TRIGGER_TOL
    say(`    前窗 ${n2(bc.meanCalls)} → 后窗 ${n2(ac.meanCalls)}，相对变化 ${rel === null ? '—（前窗为 0）' : `${rel >= 0 ? '+' : ''}${(100 * rel).toFixed(1)}%`}；「没动」的带是 ±${(TRIGGER_TOL * 100).toFixed(0)}%`)
    say(`    ⇒ 这一格【${moved ? '动了' : '未动'}】`)
  }
  say('    注：换「读侧取景形状」要求**两格都没动**。另一格「重复读里全新区间占比」在')
  say('        `node aura-tools/probes/reread-cause.mjs --split-at=<同一时刻>` 里；两格都读「未动」才轮到换形状。')

  say('')
  say('  B2. 守恒自检：两窗计数之和 == 不切窗的总计数')
  const cons = [
    ['扫描到的会话文件', split.before.corpus.files, split.after.corpus.files, aggAll.corpus.files],
    ['含工具调用的会话', split.before.corpus.sessionsWithCalls, split.after.corpus.sessionsWithCalls, aggAll.corpus.sessionsWithCalls],
    ['工具调用', split.before.corpus.calls, split.after.corpus.calls, aggAll.corpus.calls],
    ['回执字符', split.before.corpus.chars, split.after.corpus.chars, aggAll.corpus.chars],
    ['一次逻辑改动（episode）', split.before.rows.length, split.after.rows.length, aggAll.rows.length],
    ['浪费调用（去重后）', bc.wasteCalls, ac.wasteCalls, wCallsTotal],
    ['读回执条数（§4.4 引用账）', split.before.quote.receipts, split.after.quote.receipts, aggAll.quote.receipts],
  ]
  consOk = true
  for (const [name, b, a, t] of cons) {
    const ok = b + a === t
    if (!ok) consOk = false
    say(`    ${name.padEnd(24)}前 ${String(b).padStart(8)} + 后 ${String(a).padStart(8)} = ${String(b + a).padStart(8)}   总 ${String(t).padStart(8)}   ${ok ? '✓' : `⚠ 差 ${t - b - a}`}`)
  }
  say('    这一条只能证「分桶没丢会话、没记重」，**证不了切点选得对** —— 切点错了，这里照样全绿。')
  say(`    ⇒ 守恒判据：${consOk ? '✓ 全部一致' : '⚠ 有不一致项（定窗丢会话或记重了，先修这个再看读数）'}`)
  if (!consOk) {
    const bad = cons.filter(([n, b, a, t]) => b + a !== t).map(([n, b, a, t]) => `${n}（前 ${b} + 后 ${a} = ${b + a} ≠ 总 ${t}，差 ${t - b - a}）`)
    // 判据名 + 逐项点名：判据名给「是哪条判据」的账，明细给「是哪个计数项」的点名。
    violations.push({ name: '守恒自检（§B2）', detail: `${bad.length} 项：${bad.join('；')}` })
  }
}

say('')
say('量不到的（不许用估算冒充）：')
say('  · 「回执里到底有多少字符进了模型的下一跳」——日志没有 attention/引用记录，只能测逐字引用（§4.4，上限）。')
say('  · 一次改动被拆到**两个会话**（上下文用尽、换会话重来）时，本探针按会话切，会数成两次改动 ⇒ 真实改动次数更少、单次更贵。')
say('  · 墙钟含模型思考与用户离开；busy 秒的 120s 封顶是人为约定，不是测量。')
say('  · 固定税（单次调用的编排开销）日志里没有单独字段，只能从 `工具耗时` 与墙钟之差间接体现。')
say('')

/* ══════════════════════════════════════════════════════════════════════════
 * ⑦ 判据汇总与退出码（C48）—— **只在 --split-at 下执行**
 *
 * 判据只增不减：它们照旧在**原处**印着（守恒自检在 §B2、角色表自检在 §6、未归入 episode 的
 * 调用在 §0），这里只把判定收拢成一行、并按退出码表态 —— 屏幕变红与进程表态从此同一件事。
 *
 * 两条边界，都是为了让退出码可读：
 *   · 守恒自检的判定 `na` = **本次没跑**（不带 `--split-at` 时切窗那一段不执行）—— 「没判」
 *     与「判过且不符」必须是两种结局：把没跑过的沉默算成通过，就是这一波要灭的那个形状。
 *     `--split-at` 认不出时在 `splitStamp` 里已经 exit 1（用法错），走不到这里。
 *   · 未归入 episode 的调用（§0 的 `missTotal`）今天 **≠ 0**（实测 88 条：`aura_read` 6 /
 *     `aura_edit` 81 / `write` 1）—— 真按它判，不带开关的路径今天就得 exit 1，而那与「不带
 *     `--split-at` 不许改任何行为」直接冲突。所以它作为已知缺口**写在头部**、只印不判；
 *     正确修法是去修「那 88 条为什么取不到路径」，不是让探针改用估算去凑（§0 那句话自己说的）。
 *
 * 退出码语义只有一条：**任何一条判据 falsify ⇒ 1**，否则 0。
 *
 * 这一整段**只在 `--split-at` 下执行**（`if (opts.splitAt !== null)`）—— 这是硬约束的直接后果：
 * 「不带 `--split-at` ⇒ stdout 与 `--json` 产物逐字节不变」。默认路径上多打一个字都算改行为，
 * 所以默认路径连「判据汇总」这个标题都不印（C48 实测：第一版印了，两份默认路径 stdout 当场
 * 与改动前不同）。判据不因此变少：「没跑」与「跑过且通过」在默认路径上本来就是同一件事。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 守恒自检（§B2）的判定。`var` + 模块顶层：§B2 在 `if (split !== null)` 块里跑，而汇总段在
 * 块外 —— 块内 `let` 外面看不见（C48 实测：那样写会 ReferenceError）。切窗时那个块会把它
 * 置 true/false（`consOk = true` 就是它的初值，不在这里再赋一次，免得把 §B2 的结果盖掉）。
 */
var consOk

/**
 * 判据 → 退出码。**只在 `--split-at` 下执行**（默认路径连标题都不印，见上面那段注释）。
 *
 * 门是三个信号的**并集**，不是 `violations.length`：
 *   `consOk === false`（切窗守恒自检不符）、`roleOk === false`（角色表自检不符）、`violations`。
 * 为什么不只数清单：自检标志与清单是两处记的，万一有人只置标志忘了 push，光数清单就会
 * **看着红、出门绿** —— 那正是本波要灭的那个形状。并集之下，任一处说了不符就出不去。
 * （这条是 tmp/c48/check-logic.mjs 的单元自检逼出来的：第一版只数清单，两格当场假绿。）
 */
if (opts.splitAt !== null) {
  const failedJudgements = []
  if (consOk === false) failedJudgements.push('守恒自检（§B2）')
  if (roleOk === false) failedJudgements.push('角色表自检（§6）')
  /** 逐项点名：`violations` 里的明细（`{ name, detail }`；不带明细的条目按字符串收）。 */
  const details = violations.map((v) => (typeof v === 'string' ? v : `${v.name} ${v.detail}`))
  const named = [...new Set([...failedJudgements, ...violations.map((v) => (typeof v === 'string' ? v : v.name))])]
  const gate = failedJudgements.length === 0 && violations.length === 0 ? 'ok' : 'violated'
  say('')
  say('── 判据汇总（退出码按这一行表态）──')
  say(`  守恒自检（§B2）      : ${consOk ? '✓ 通过' : '⚠ 不符'}`)
  say(`  角色表自检（§6）      : ${roleOk ? '✓ 通过' : '⚠ 不符'}`)
  say(`  ⇒ 判据：${gate === 'ok' ? '✓ 全部通过（退出码 0）' : `⚠ ${named.length} 项判据不符 ⇒ 退出码 1：${named.join('；')}`}`)
  if (gate !== 'ok') {
    for (const name of named) fs.writeSync(2, `判据不符：${name}\n`)
    for (const d of details) fs.writeSync(2, `判据明细：${d}\n`)
    process.exitCode = 1
  }
}

/* ── 小工具 ──────────────────────────────────────────────────────────────── */

function spanOf(calls, ep) {
  return calls.slice(ep.firstIdx, ep.lastIdx + 1)
}

function hasSuccessfulWrite(calls, ep) {
  for (let i = ep.firstIdx; i <= ep.lastIdx; i += 1) {
    const c = calls[i]
    if (!WRITE.has(c.name) || c.isError === true) continue
    const f = fileOf(c)
    if (f !== null && keyOf(f) === ep.key) return true
  }
  return false
}
