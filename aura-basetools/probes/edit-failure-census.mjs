/**
 * edit-failure-census.mjs —— `aura_edit` 失败的**构成**（T27 指出的真靶子：写侧占 94% 错误）。
 *
 * 与 `adoption-stats.mjs` 同一口径：**共用 `session-log.mjs` 的读取**，不另起第二个统计入口。
 * 本探针只回答一个问题：15–18% 的写失败里，**哪一种**占得最多、且可修。
 *
 * 判据一律用结构化字段（`isError` + 回执文本里的稳定 code），不用宽泛文本规则——
 * 文本规则会把源码里含 `Error:` 字面量的内容也数进来（T27 实测多算 16 次）。
 *
 * 运行：node probes/edit-failure-census.mjs [topN]
 */
import { readSessionsDetailed } from './session-log.mjs'


// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set([])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/edit-failure-census.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const TOP = Number(process.argv[2] ?? 12)

/** 失败回执里出现的**稳定判据**。顺序即优先级：一条回执同时命中多个时取最具体的。 */
const CODE_PATTERNS = [
  ['PATCH_EXPECT_MISMATCH', /differs from expect|do not match assert/],
  ['LOCATOR_ASSERT_MISMATCH', /LOCATOR_ASSERT_MISMATCH/],
  ['PATCH_STALE_REGION', /changed after the last observation|no longer holds it|cannot be checked against what you saw/],
  ['FS_STALE_VERSION', /changed while patching|FS_STALE_VERSION/],
  ['PATCH_ANCHOR_NOT_FOUND', /anchor.*not found|no line contains/i],
  ['LOCATOR_AMBIGUOUS', /appears on \d+ lines|ambiguous/i],
  ['LOCATOR_OUT_OF_RANGE', /outside 1\.\.|lone CR/],
  ['PATCH_NO_ADDRESS', /each hunk needs one of|pass \`lines\` as/],
  ['PATCH_OVERLAP', /hunks overlap/],
  ['PATCH_NOT_FOUND', /not found — to create it/],
  ['PATCH_EXISTS', /already exists — pass hunks/],
  ['WRITE_VERIFY_FAILED', /does not match what was written/],
  ['PATCH_NO_BYTE_EXACT_WRITE', /mixes CRLF and LF/],
  ['FS_ACCESS', /access denied|FS_PERMISSION|sandbox/i],
  ['TARGET_MISS', /target= needs|cannot resolve target|no symbol/i],
]

/** 从一条失败回执里取判据；取不到就归 `unclassified`（**必须显式**，不许悄悄吞掉）。 */
function classify(text) {
  for (const [name, re] of CODE_PATTERNS) if (re.test(text)) return name
  return 'unclassified'
}

const sessions = readSessionsDetailed()
const failed = []
let total = 0
for (const session of sessions) {
  for (const call of session.calls) {
    if (call.name !== 'aura_edit') continue
    total += 1
    if (call.isError === true) failed.push({ session: session.dir, args: call.args, text: String(call.text ?? '') })
  }
}

const byCode = new Map()
for (const f of failed) {
  const code = classify(f.text)
  byCode.set(code, (byCode.get(code) ?? 0) + 1)
}
const ranked = [...byCode].sort((a, b) => b[1] - a[1])

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`

process.stdout.write(`\n=== aura_edit 失败构成（${sessions.length} 会话 / ${total} 次调用 / ${failed.length} 次失败，${pct(failed.length, total)}）===\n\n`)
process.stdout.write(`判据                       次数   占失败   占全部\n`)
for (const [code, n] of ranked.slice(0, TOP)) {
  process.stdout.write(`${code.padEnd(26)} ${String(n).padStart(5)}   ${pct(n, failed.length).padStart(6)}   ${pct(n, total).padStart(6)}\n`)
}
const rest = ranked.slice(TOP).reduce((a, [, n]) => a + n, 0)
if (rest > 0) process.stdout.write(`${'(其余判据合计)'.padEnd(26)} ${String(rest).padStart(5)}   ${pct(rest, failed.length).padStart(6)}   ${pct(rest, total).padStart(6)}\n`)

// ── 可修性：每一类里，**同一文件同一地址**是否被重复撞（重复即“模型没有拿到修正所需的信息”）
process.stdout.write(`\n=== 重复撞同一地址（重试是否白付）===\n\n`)
const streak = new Map()
for (const f of failed) {
  const key = `${classify(f.text)}|${f.args?.file_path ?? '?'}`
  streak.set(key, (streak.get(key) ?? 0) + 1)
}
const repeats = [...streak].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
process.stdout.write(`失败里，同一 (判据,文件) 撞 ≥2 次的有 ${repeats.length} 组，合计 ${repeats.reduce((a, [, n]) => a + n, 0)} 次\n`)
for (const [key, n] of repeats.slice(0, 8)) process.stdout.write(`  ${String(n).padStart(3)}× ${key}\n`)
process.stdout.write('\n')
