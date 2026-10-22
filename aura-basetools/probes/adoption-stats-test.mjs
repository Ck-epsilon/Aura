/**
 * probes/adoption-stats-test.mjs —— 采用率统计的**判据**测试（不需要会话日志）。
 *
 *   node probes/adoption-stats-test.mjs
 *
 * 为什么需要它：这套统计此前有**两个入口**（`adoption-stats.mjs` 按会话算覆盖率、
 * `probe-adoption.mjs` 另算一遍模式分布），两边的会话筛选口径不同，同一批日志能得出
 * 两个不同的"采用率"——而数字本身没有任何东西在守着它。这里把统计逻辑当纯函数测：
 * 真正会出错的地方（自动选模式、hunk 级寻址、失败判定、自测会话过滤）各有断言。
 *
 * 夹具只用三类会话：只用内置的、用过 aura 的、自测的。**夹具的 text 必须是中性内容**，
 * 否则它会被自测文本判据命中——那会让"真实会话"在测试里悄悄变成自测会话
 * （本文件第一版就踩了这个：会话总数断言差了一个）。
 */
import { summarize, isSelfSession, parseSince } from './adoption-stats.mjs'

let failed = 0
const check = (ok, label, detail = '') => {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}\n`)
  if (!ok) failed += 1
}

const call = (name, args = undefined, isError = false) => ({ name, args: args ?? {}, isError })
const rows = [
  // ⑨ 只用内置的会话
  { dir: 'lol', cwd: 'E:\\workspaces\\lol', mtime: 1, text: '把这段代码改一下', calls: [call('read'), call('edit'), call('edit')] },
  // ⑨ 用过 aura 的会话：一次 auto 读、一次显式 lines 读、两个 hunk、一次失败、一次 dry_run
  {
    dir: 'agent-browser-bridge',
    cwd: 'E:\\workspaces\\agent-browser-bridge',
    mtime: 2,
    text: '帮我修一下这个 bug',
    calls: [
      call('aura_read'),
      call('aura_read', { mode: 'lines', lines: [1, 9] }),
      call('aura_edit', { hunks: [{ lines: [1, 2], replace: 'x' }, { target: 'foo', replace: 'y' }] }),
      call('aura_edit', { hunks: [{ line_cue: 'needle', replace: 'z' }], dry_run: true }, true),
    ],
  },
  // ⑨ 自测会话：workdir 与内容都在工具自己树里
  {
    dir: 'deepseekharness',
    cwd: 'E:\\workspaces\\deepseekharness\\aura-tools',
    mtime: 3,
    text: 'node aura-read/load-test.mjs',
    calls: [call('aura_read'), call('aura_read'), call('aura_edit', { hunks: [{ anchor: 'a', replace: 'b' }] })],
  },
]

const s = summarize(rows)

process.stdout.write('=== 覆盖率（自测会话单列，不计入）===\n')
check(s.sessions.total === 2, `真实会话总数 ${s.sessions.total}`)
check(s.sessions.raw === 3, `原始会话总数 ${s.sessions.raw}`)
check(s.sessions.selfExcluded === 1, `被识别为自测并单列的会话 ${s.sessions.selfExcluded}`)
check(s.sessions.aura === 1, `用过 aura 的会话 ${s.sessions.aura}`)
check(s.sessions.builtinOnly === 1, `只用内置的会话 ${s.sessions.builtinOnly}`)
// 夹具里那个 aura 会话**没碰内置三件套**（只 read/edit 那两个名字不算），所以是"只用 aura"；
// 而只碰内置的那个会话才是 builtinOnly。两条断言此前写反了——测试自己也会写错，所以要跑。

process.stdout.write('\n=== 调用次数 ===\n')
check(s.tally.read === 1, `read ${s.tally.read}`)
check(s.tally.edit === 2, `edit ${s.tally.edit}`)
check(s.tally.aura_read === 2, `aura_read ${s.tally.aura_read}`)
check(s.tally.aura_edit === 2, `aura_edit ${s.tally.aura_edit}`)
check(s.sessions.auraOnly === 1, `只用 aura 的会话 ${s.sessions.auraOnly}`)
check(s.sessions.both === 0, `两者都用的会话 ${s.sessions.both}`)

process.stdout.write('\n=== aura_read 模式分布（不给 mode 记作 auto）===\n')
check(s.readModes['(auto)'] === 1, `auto ${s.readModes['(auto)']}`)
check(s.readModes.lines === 1, `lines ${s.readModes.lines}`)
check(
  Object.values(s.readModes).reduce((a, b) => a + b, 0) === s.readCalls,
  `模式分布之和 ${Object.values(s.readModes).reduce((a, b) => a + b, 0)} = aura_read 调用数 ${s.readCalls}`,
)

process.stdout.write('\n=== aura_edit 寻址分布（按 hunk 计）===\n')
check(s.editHunks.lines === 1, `lines ${s.editHunks.lines}`)
check(s.editHunks.target === 1, `target ${s.editHunks.target}`)
check(s.editHunks.line_cue === 1, `line_cue ${s.editHunks.line_cue}`)
check(s.editHunks.anchor === undefined, '自测会话里的 anchor 没有被计入')
check(s.editHunks.expect === undefined, `expect（额外标志）未被计入寻址分母 ${s.editHunks.expect}`)
check(s.editDryRun === 1, `dry_run ${s.editDryRun}`)
check(s.editCalls === 2, `aura_edit 调用 ${s.editCalls}`)

process.stdout.write('\n=== 失败判定（结构化 isError，不用文本正则）===\n')
check(s.readErrors === 0, `aura_read 失败 ${s.readErrors}`)
check(s.editErrors === 1, `aura_edit 失败 ${s.editErrors}`)

process.stdout.write('\n=== 自测会话的识别口径 ===\n')
check(isSelfSession('deepseekharness', '', 'E:\\workspaces\\deepseekharness\\aura-tools') === true, 'workdir 在 aura-tools 里 ⇒ 自测')
check(isSelfSession('x', 'node probes/adoption-stats.mjs') === true, '命令行里跑了探针 ⇒ 自测')
check(
  isSelfSession('agent-browser-bridge', '帮我修一个 bug', 'E:\\workspaces\\agent-browser-bridge') === false,
  '路径里含 "aura-read" 字样的真实项目不算自测（子串未加分隔符锚定就会误判）',
)
check(isSelfSession('lol', '把这段代码改一下') === false, '普通会话不算自测')

process.stdout.write('\n=== since 解析 ===\n')
check(parseSince(undefined) === 0, '缺省 = 全部')
check(parseSince('2026-09-21T07:26') === Date.parse('2026-09-21T07:26'), 'ISO 时间可解析')
check(parseSince('昨天') === null, '解析不了返回 null（调用方据此报错退出）')

process.stdout.write(`\n--- ${failed === 0 ? '全部通过' : `${failed} 项失败`} ---\n`)
process.exit(failed === 0 ? 0 : 1)
