/**
 * which-tools.mjs —— 会话日志里真实用过的工具：列出最近 25 个会话 + 全量合计。
 *
 *   node probes/which-tools.mjs [since]
 *
 * 日志读取与"哪些名字算 aura / 内置"都在 session-log.mjs 与 adoption-stats.mjs 里：
 * 本文件只负责逐会话打印。**三个入口共用一份解析**，避免口径漂移
 * （此前有过"同一个日志、两个采用率"的问题，见 adoption-stats.mjs 头部）。
 */
import { iterateSessionsDetailed } from './session-log.mjs'
import { AURA, BUILTIN } from './adoption-stats.mjs'

const say = (m) => process.stdout.write(`${m}\n`)

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set([])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/which-tools.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const since = process.argv[2] === undefined ? 0 : Date.parse(process.argv[2])
// 流式读：只保留最近 25 条的摘要与全量计数，不把每个会话的正文/回执留在内存里。
// 旧版 `readSessions` 会把全部会话（含正文）收进数组，实测 4GB heap OOM。
const recent = []
const tally = {}
let total = 0
for (const row of iterateSessionsDetailed(since)) {
  total += 1
  const counts = {}
  for (const call of row.calls) {
    tally[call.name] = (tally[call.name] ?? 0) + 1
    counts[call.name] = (counts[call.name] ?? 0) + 1
  }
  recent.push({ mtime: row.mtime, dir: row.dir, counts })
  recent.sort((a, b) => a.mtime - b.mtime)
  if (recent.length > 25) recent.shift()
}

say(`=== ${total} 个含工具调用的会话（按时间，只列最近 25 个）===`)
for (const row of recent) {
  const summary = Object.entries(row.counts)
    .map(([name, count]) => `${name}×${count}`)
    .join(' ')
  say(`  ${row.mtime.toLocaleString()}  ${row.dir.slice(0, 22)}…  ${summary}`)
}

say('')
say('=== 合计 ===')
const tracked = (name) => AURA.test(name) || BUILTIN.test(name) || ['pwsh', 'glob', 'grep'].includes(name)
for (const [name, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  if (tracked(name)) say(`  ${name.padEnd(12)} ${count}`)
}
