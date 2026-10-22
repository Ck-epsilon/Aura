/**
 * session-log.mjs —— 读 ~/.dsh/sessions 下每个会话实际发生过的工具调用。
 *
 * 会话日志是可靠来源：它记的是**实际发生**的调用，不依赖 stdout 捕获。
 * 会话文件是 zstd 多帧流，单帧只能解出会话头，所以要按 magic 切帧逐帧解。
 *
 * 两种读法，共用同一份解压与判定（避免两处解析逻辑漂移）：
 *   readSessions()          —— 只要工具名（覆盖率、调用总量）
 *   readSessionsDetailed()  —— 连参数与成败一起（模式/寻址分布、失败率）
 * 参数在日志里是**字符串化的 JSON**，成败在结果事件里是结构化字段 `isError`——
 * 所以失败判定用字段而不是文本正则；两者都在这里解析，调用方不必再碰原始事件。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const SESSION_FILE = 'session.v3.jsonl.zstd'

/** 逐帧解压；坏帧忽略（日志尾部可能是半帧）。 */
export function decompressAll(buf) {
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
      /* 坏帧忽略 */
    }
  }
  return text
}

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

/** 会话日志里的 cwd（结果事件里也有 request/header，取第一个出现的）。 */
function cwdOf(text) {
  const m = text.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (m === null) return null
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return null
  }
}

/** 工具参数：日志里是字符串化的 JSON，解析不了就记 null（不猜）。 */
function argsOf(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * @param since - 只要 mtime 晚于它的会话（毫秒时间戳；默认 0 = 全部）
 * @param root - 会话根目录（测试可指到别处）
 * @returns `[{ dir, cwd, mtime, text, calls }]`，只含确实发生过工具调用的会话，按时间升序
 *   `calls[i] = { name, args, isError }`；`text` 是解压后的原始日志（调用方可据此判定自测会话）
 */
export function readSessionsDetailed(since = 0, root = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')) {
  const rows = []
  for (const file of sessionFiles(root)) {
    const stat = fs.statSync(file)
    if (stat.mtimeMs < since) continue
    let text
    try {
      text = decompressAll(fs.readFileSync(file))
    } catch {
      continue
    }
    const calls = []
    const byId = new Map()
    for (const line of text.split('\n')) {
      if (!line.includes('"tool/')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        /* 坏行忽略 */
      }
      if (event === undefined) continue
      if (event.type === 'tool/call') {
        const name = event.data?.name
        if (typeof name !== 'string') continue
        const call = { name, args: argsOf(event.data?.arguments), isError: false }
        calls.push(call)
        if (typeof event.data?.callId === 'string') byId.set(event.data.callId, call)
      } else if (event.type === 'tool/result') {
        const id = event.data?.message?.source?.callId
        const call = typeof id === 'string' ? byId.get(id) : undefined
        if (call === undefined) continue
        const parts = event.data?.message?.content ?? []
        call.isError = parts.some((part) => part?.isError === true)
        /**
         * 回执正文一并留下（只取 text 块）。
         *
         * 为什么必须留：只有 `isError` 时，“失败**构成**”这一格根本量不出来——
         * `probes/edit-failure-census.mjs` 第一版就把 984 次写失败全归成 `unclassified`，
         * 因为它手里只有一个布尔值。而“该修哪一种失败”是优先级问题，不是是非问题。
         *
         * 形状（实测 dump）：`part = { type:'tool-result', content:[{type:'text', text}], isError }`——
         * 正文在**嵌套一层**的 `part.content[].text` 里，不在 `part.text`。
         * 我第一版只看顶层，于是 984 条失败的回执文本全是空字符串（“字段在，但是空的”这类假数据
         * 比缺字段更难发现：它看起来像“这条确实没带正文”）。顶层与嵌套两层都收，以防形状再变。
         *
         * 保持向后兼容：既有读 `session.calls[i].isError` 的探针不受影响。
         */
        const textOf = (part) => {
          const own = typeof part?.text === 'string' ? part.text : ''
          const nested = Array.isArray(part?.content)
            ? part.content.map((inner) => (typeof inner?.text === 'string' ? inner.text : '')).filter((t) => t.length > 0)
            : []
          return [own, ...nested].filter((t) => t.length > 0).join('\n')
        }
        call.text = parts.map(textOf).filter((t) => t.length > 0).join('\n')
      }
    }
    if (calls.length === 0) continue
    rows.push({ dir: path.basename(path.dirname(file)), cwd: cwdOf(text), mtime: stat.mtime, text, calls })
  }
  return rows.sort((a, b) => a.mtime - b.mtime)
}

/**
 * 只要工具名的那一种读法（覆盖率、调用总量）。`which-tools.mjs` 与既有调用方用它。
 * @returns `[{ dir, mtime, calls }]`，`calls` 是工具名数组
 */
export function readSessions(since = 0, root = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')) {
  return readSessionsDetailed(since, root).map((row) => ({ dir: row.dir, mtime: row.mtime, calls: row.calls.map((c) => c.name) }))
}

/** 统计一次调用的名字分布。 */
export const tallyOf = (rows) =>
  rows
    .flatMap((row) => row.calls)
    .reduce((map, name) => ((map[name] = (map[name] ?? 0) + 1), map), {})
