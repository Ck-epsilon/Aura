/**
 * adoption-stats.mjs —— aura_* 到底被用起来没有？**唯一入口**。
 *
 *   node probes/adoption-stats.mjs [since] [--include-meta] [--json] [--stream]
 *   --stream：流式读（不保留正文与回执），内存有界；模式/寻址分布与默认路径同口径。
 *
 * since 例：`2026-09-21T07:26`（web profile 打上 aura 补丁的时刻）—— 用来回答"补丁之后还用不用"。
 *
 * ## 为什么只有这一个入口
 *
 * 这套统计此前有两个入口：本文件按**会话**算覆盖率，另有一个脚本按**调用**算模式分布。
 * 两边各自筛"哪些会话算数"，而筛选口径不同（一个不筛、一个筛掉自测会话），于是同一批日志
 * 能读出两个不同的采用率——**数字没有任何东西在守着它**。现在合并成一个：
 * 一次读日志、一份筛选口径（`self` 单列并可 `--include-meta` 合并）、一份判据测试
 * （`adoption-stats-test.mjs`）。
 *
 * ## 为什么覆盖率按会话算，而不是按调用次数
 *
 * 调用总量会被少数几个大批量会话（子代理改上百处、或别的项目里根本不需要 aura）主导，
 * 看起来像"没人用"。覆盖率回答的才是"遇到读写任务时会不会想到它"。
 * 模式与寻址分布则相反，按**次**（寻址按 hunk）算才有意义——它们描述的是"怎么用"。
 */
import { pathToFileURL } from 'node:url'
import { iterateSessionsDetailed, readSessionsDetailed, tallyOf } from './session-log.mjs'

export const AURA = /^aura_(read|edit)$/
export const BUILTIN = /^(read|edit|write)$/

/** 自测会话的判据：workdir 就在工具自己树里，或命令/开场白明显是在测这套工具。 */
// 判据必须锚在路径分隔符上：`agent-browser-bridge` 里也含 "aura-read" 这几个字，
// 无锚的子串匹配会把**真实项目会话**误判成自测会话（实测：一个 12 行夹具因此被滤掉，
// 采用率从 2/3 掉到 1/2）。
const AURA_TREE = /[\\/](?:aura-tools|locator-lab|aura-read|aura-edit|deepseekharness)(?=[\\/]|$)/
const SELF_TEXT = /load-test\.mjs|adoption-stats\.mjs|probe-adoption\.mjs|which-tools\.mjs|shadow-probe|AUDIT\.md|FINDINGS\.md|收口|采用率/

/** @returns true = 这个会话是在测工具本身，不该算进真实采用率 */
export function isSelfSession(dir, text, cwd = null) {
  if (AURA_TREE.test(`${dir ?? ''} ${cwd ?? ''}`)) return true
  return SELF_TEXT.test(String(text ?? '').slice(0, 20000))
}

/** 分类：自测会话与真实会话分开，口径只在这一处。 */
export function markSelfSessions(rows) {
  const self = []
  const real = []
  for (const row of rows) (isSelfSession(row.dir, row.text, row.cwd) ? self : real).push(row)
  return { self, real }
}

/** ISO 时间 → 毫秒；缺省 0（全部）；解析不了 null（调用方据此报错退出，而不是静默当成全部）。 */
export function parseSince(argv) {
  if (argv === undefined || argv === '') return 0
  const t = Date.parse(argv)
  return Number.isNaN(t) ? null : t
}

const bump = (map, key) => {
  map[key] = (map[key] ?? 0) + 1
}

/** 寻址方式：`target` 优先，其次 lines / line_cue / anchor。 */
function addressOf(hunk) {
  if (hunk === null || typeof hunk !== 'object') return '(none)'
  if (typeof hunk.target === 'string' && hunk.target.length > 0) return 'target'
  if (Array.isArray(hunk.lines)) return 'lines'
  if (typeof hunk.line_cue === 'string') return 'line_cue'
  if (typeof hunk.anchor === 'string') return 'anchor'
  return '(none)'
}

/**
 * 纯统计：输入会话行（`readSessionsDetailed` 的形状），输出全部数字。无 I/O、无打印，可单测。
 *
 * @param rows - 会话行；每行 `{ dir, cwd, mtime, text, calls:[{name,args,isError}] }`
 * @param options.includeMeta - true 时把自测会话也算进主口径（默认单列）
 */
export function summarize(rows, options = {}) {
  const includeMeta = options.includeMeta === true
  const { self, real: realRows } = markSelfSessions(rows)
  const real = includeMeta ? rows : realRows

  const readModes = {}
  const readParams = {}
  const editHunks = {}
  const editFlags = {}
  let readCalls = 0
  let editCalls = 0
  let readErrors = 0
  let editErrors = 0
  let editDryRun = 0

  for (const row of real) {
    for (const call of row.calls) {
      const args = call.args ?? {}
      if (call.name === 'aura_read') {
        readCalls += 1
        if (call.isError) readErrors += 1
        bump(readModes, typeof args.mode === 'string' && args.mode.length > 0 ? args.mode : '(auto)')
        for (const key of ['lines', 'around', 'search', 'since', 'kind', 'context']) {
          if (args[key] !== undefined) bump(readParams, key)
        }
      } else if (call.name === 'aura_edit') {
        editCalls += 1
        if (call.isError) editErrors += 1
        if (args.dry_run === true) {
          editDryRun += 1
          bump(editFlags, 'dry_run')
        }
        if (typeof args.create === 'string') bump(editFlags, 'create')
        for (const hunk of Array.isArray(args.hunks) ? args.hunks : []) {
          bump(editHunks, addressOf(hunk))
          if (hunk?.expect !== undefined) bump(editHunks, 'expect')
          if (hunk?.near !== undefined) bump(editHunks, 'near')
        }
      }
    }
  }

  // 名字分布：本函数拿到的是**详列**（calls 是对象数组），而 session-log 的 tallyOf 吃的是
  // 名字数组。早先这里直接 `tallyOf(real)`，于是所有计数静默变成 0——测试第一次就抓到了。
  const tally = {}
  for (const row of real) for (const call of row.calls) bump(tally, call.name)

  const used = (row, pattern) => row.calls.some((call) => pattern.test(call.name))
  const auraRows = real.filter((row) => used(row, AURA))
  const builtinRows = real.filter((row) => used(row, BUILTIN))
  return {
    sessions: {
      total: real.length,
      raw: rows.length,
      aura: auraRows.length,
      auraOnly: auraRows.filter((row) => !used(row, BUILTIN)).length,
      both: auraRows.filter((row) => used(row, BUILTIN)).length,
      builtinOnly: real.filter((row) => !used(row, AURA) && used(row, BUILTIN)).length,
      selfExcluded: self.length,
    },
    tally,
    readCalls,
    editCalls,
    readErrors,
    editErrors,
    readModes,
    readParams,
    editHunks,
    editFlags,
    editDryRun,
    rows: real,
  }
}

/**
 * 流式口径：与 `summarize` 同样的计数器，但逐会话消费、不把正文留在内存里。
 * 用于日志大到 `readSessionsDetailed` 会 OOM 的机器；默认路径仍保留完整行以便最近会话明细。
 */
function streamReport(since, includeMeta, json) {
  const readModes = {}
  const editHunks = {}
  const tally = {}
  const sessions = { total: 0, raw: 0, aura: 0, auraOnly: 0, both: 0, builtinOnly: 0, selfExcluded: 0 }
  const recent = []
  let readCalls = 0
  let editCalls = 0
  let readErrors = 0
  let editErrors = 0
  let editDryRun = 0

  for (const row of iterateSessionsDetailed(since)) {
    sessions.raw += 1
    if (!includeMeta && isSelfSession(row.dir, '', row.cwd)) {
      sessions.selfExcluded += 1
      continue
    }
    sessions.total += 1
    let hasAura = false
    let hasBuiltin = false
    const counts = {}
    for (const call of row.calls) {
      tally[call.name] = (tally[call.name] ?? 0) + 1
      counts[call.name] = (counts[call.name] ?? 0) + 1
      if (AURA.test(call.name)) hasAura = true
      if (BUILTIN.test(call.name)) hasBuiltin = true
      const args = call.args ?? {}
      if (call.name === 'aura_read') {
        readCalls += 1
        if (call.isError) readErrors += 1
        bump(readModes, typeof args.mode === 'string' && args.mode.length > 0 ? args.mode : '(auto)')
      } else if (call.name === 'aura_edit') {
        editCalls += 1
        if (call.isError) editErrors += 1
        if (args.dry_run === true) editDryRun += 1
        for (const hunk of Array.isArray(args.hunks) ? args.hunks : []) {
          bump(editHunks, addressOf(hunk))
          if (hunk?.expect !== undefined) bump(editHunks, 'expect')
          if (hunk?.near !== undefined) bump(editHunks, 'near')
        }
      }
    }
    if (hasAura) sessions.aura += 1
    if (hasAura && hasBuiltin) sessions.both += 1
    else if (hasAura) sessions.auraOnly += 1
    else if (hasBuiltin) sessions.builtinOnly += 1
    recent.push({ mtime: row.mtime, counts })
    if (recent.length > 10) recent.shift()
  }

  const result = { sessions, readCalls, editCalls, readErrors, editErrors, readModes, editHunks, editDryRun, tally }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`)
    return
  }
  say(`=== aura 采用率（流式${since === 0 ? '' : `，mtime ≥ ${new Date(since).toLocaleString()}`}）===`)
  say(`  含工具调用的会话        : ${sessions.total}${includeMeta ? '' : `（另有自测会话 ${sessions.selfExcluded} 个，未计入）`}`)
  say(`  用过 aura_* 的会话      : ${sessions.aura}  (${pct(sessions.aura, sessions.total)})`)
  say(`  只用内置三件套的会话    : ${sessions.builtinOnly}  (${pct(sessions.builtinOnly, sessions.total)})`)
  say(`  两者都用的会话          : ${sessions.both}`)
  say(`  只用 aura 的会话        : ${sessions.auraOnly}`)
  say('')
  say('=== aura_read：调用与失败 ===')
  say(`  调用 ${readCalls} 次；失败 ${readErrors} 次（${pct(readErrors, readCalls)}）`)
  table('aura_read 的 mode 分布', readModes, readCalls, '(auto) = 未给 mode')
  say('')
  say('=== aura_edit：调用与失败 ===')
  say(`  调用 ${editCalls} 次；失败 ${editErrors} 次（${pct(editErrors, editCalls)}）；dry_run ${editDryRun} 次`)
  const hunkTotal = Object.entries(editHunks)
    .filter(([k]) => !['expect', 'near'].includes(k))
    .reduce((a, [, v]) => a + v, 0)
  table('aura_edit 的寻址分布（按 hunk）', editHunks, hunkTotal, 'expect / near 是额外标志，不参与该分母')
}

const pct = (part, whole) => (whole === 0 ? '—' : `${Math.round((100 * part) / whole)}%`)
const say = (m) => process.stdout.write(`${m}\n`)
const table = (title, map, total, note = '') => {
  say(`\n=== ${title}${note ? `（${note}）` : ''} ===`)
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) say('  （无）')
  for (const [key, count] of entries) say(`  ${String(count).padStart(5)}  ${String(key).padEnd(14)}${total ? `  ${pct(count, total)}` : ''}`)
}

// CLI 只在**直接执行**本文件时跑：它同时被 adoption-stats-test.mjs import，
// 作为库被引入时不该扫日志、不该打印（此前它照样跑真日志，把测试输出整个盖住）。
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

main()

function main() {
  if (!isMain) return
  const argv = process.argv.slice(2)
  const since = parseSince(argv.find((a) => !a.startsWith('--')))
  if (since === null) {
    process.stderr.write(`since 解析不了：${argv.find((a) => !a.startsWith('--'))}（要 ISO 时间，如 2026-09-21T07:26）\n`)
    process.exit(2)
  }
  const includeMeta = argv.includes('--include-meta')
  if (argv.includes('--stream')) {
    streamReport(since, includeMeta, argv.includes('--json'))
    return
  }
  const rows = readSessionsDetailed(since)
  const s = summarize(rows, { includeMeta })

  if (argv.includes('--json')) {
    const { rows: _rows, ...rest } = s
    process.stdout.write(`${JSON.stringify(rest, null, 1)}\n`)
    return
  }

  say(`=== aura 采用率${since === 0 ? '（全部会话）' : `（mtime ≥ ${new Date(since).toLocaleString()}）`} ===`)
  say(`  含工具调用的会话        : ${s.sessions.total}${includeMeta ? '' : `（另有自测会话 ${s.sessions.selfExcluded} 个，未计入；--include-meta 可合并）`}`)
  say(`  用过 aura_* 的会话      : ${s.sessions.aura}  (${pct(s.sessions.aura, s.sessions.total)})`)
  say(`  只用内置三件套的会话    : ${s.sessions.builtinOnly}  (${pct(s.sessions.builtinOnly, s.sessions.total)})`)
  say(`  两者都用的会话          : ${s.sessions.both}`)
  say(`  只用 aura 的会话        : ${s.sessions.auraOnly}`)

  say('\n=== 调用次数 ===')
  for (const name of ['aura_read', 'aura_edit', 'read', 'edit', 'write']) say(`  ${name.padEnd(12)} ${s.tally[name] ?? 0}`)
  const auraTotal = (s.tally.aura_read ?? 0) + (s.tally.aura_edit ?? 0)
  const builtinTotal = (s.tally.read ?? 0) + (s.tally.edit ?? 0) + (s.tally.write ?? 0)
  say(`  ${'aura 合计'.padEnd(12)} ${auraTotal}\n  ${'内置合计'.padEnd(12)} ${builtinTotal}`)

  say('\n=== aura_read：调用与失败 ===')
  say(`  调用 ${s.readCalls} 次；失败 ${s.readErrors} 次（${pct(s.readErrors, s.readCalls)}）`)
  table('aura_read 的 mode 分布', s.readModes, s.readCalls, '(auto) = 未给 mode')
  table('aura_read 的其它参数被用到几次', s.readParams, s.readCalls)

  say('\n=== aura_edit：调用与失败 ===')
  say(`  调用 ${s.editCalls} 次；失败 ${s.editErrors} 次（${pct(s.editErrors, s.editCalls)}）；dry_run ${s.editDryRun} 次`)
  const hunkTotal = Object.entries(s.editHunks)
    .filter(([k]) => !['expect', 'near'].includes(k))
    .reduce((a, [, v]) => a + v, 0)
  table('aura_edit 的寻址分布（按 hunk）', s.editHunks, hunkTotal, 'expect / near 是额外标志，不参与该分母')

  say('\n=== 最近 10 个会话用了什么 ===')
  for (const row of s.rows.slice(-10)) {
    const counts = row.calls.reduce((map, call) => ((map[call.name] = (map[call.name] ?? 0) + 1), map), {})
    const aura = Object.entries(counts).filter(([n]) => AURA.test(n)).map(([n, c]) => `${n}×${c}`)
    const builtin = Object.entries(counts).filter(([n]) => BUILTIN.test(n)).map(([n, c]) => `${n}×${c}`)
    say(`  ${row.mtime.toLocaleString()}  aura[${aura.join(' ') || '-'}]  内置[${builtin.join(' ') || '-'}]`)
  }
}
