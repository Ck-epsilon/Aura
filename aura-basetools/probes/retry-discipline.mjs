/**
 * retry-discipline.mjs —— 把"同一文件连续局部修补"从**自责**变成**可检测的信号**。
 *
 * ## 它从哪来
 *
 * 一次真实事故：我在 `probes/weight-profile.mjs` 一个文件上连续失败 6 次
 * （路径解析 → 正则替换 → 两次锚点语义搞反 → 漏 import → 裸 catch 吞错），
 * 每次的动作都是"再修一次"，而不是**停下来重读整个文件**。
 *
 * 那正是本项目在代码里反复批评的形状（补丁的补丁）：**局部修补掩盖结构问题**。
 * 而它跟代码里的那类 bug 一样，是**可检测的**——不需要靠自觉：
 *
 *   同一个文件在短时间内被**反复编辑**，且编辑之间**没有一次成功的验证**
 *   （没有读取、没有跑测试），就是"我在打补丁"的可观测特征。
 *
 * ## 判据（全部可从会话日志直接读出）
 *
 * 初版写的是“连续 3 次以上写且其间没有读 ⇒ 盲修补”。**实测把这个判据否掉了**：
 * 它把一次正常的连续重构也标成“盲修补”，而全量扫下来命中几百条，没有分辨力。
 * 修正后的判据把两件事**分开**，因为它们的含义不同：
 *
 *   · `blind`（真信号）：**失败之后没有成功读就又改**。上一次改错了，下一步不是去看清楚，
 *     而是再猜一次——这才是“打补丁”的可观测特征。
 *   · `long`（背景）：连续写 ≥ 3 次而其间没读过。只说明“没回头核对”，长重构也会这样，
 *     **单独不算问题**：实测我自己的 `struct-core.mjs` 有过 9 连写 0 读、且 0 失败。
 *
 * 实测（403 会话）：1137 条连续写序列，**真信号 511 条**；
 * 最坏的一条是 `state/blueprints/aura-intent-ops.json`——6 连写、6 次全失败。
 *
 * 对每个会话、每个文件，按时间顺序取该文件的写操作（`aura_edit`/`edit`/`write`）：
 *   · 连续 3 次以上写、且其间**没有任何成功的读**（`aura_read`/`read`）⇒ 记一条
 *   · 其中若还伴随失败（`isError`）⇒ 标为"盲修补"（最坏的形态：失败后不看就再改）
 *
 * 这不是"不许连改三次"——正常重构也会连改。判据里**"其间没有读"**才是关键：
 * 读了再改是迭代，不读就改是猜。
 *
 * ## 用法
 *
 *   node probes/retry-discipline.mjs            # 扫全部会话，列出触发的序列
 *   node probes/retry-discipline.mjs --top 20   # 只看最长的若干条
 *
 * 与 `adoption-stats.mjs` 同口径（共用 `session-log.mjs`），不另起统计入口。
 */
import fs from 'node:fs'
import { readSessionsDetailed } from './session-log.mjs'

const WRITE = /^(aura_edit|edit|write)$/
const READ = /^(aura_read|read)$/
/** 连续写多少次算"该停下来重读"了。3 是刻意保守的：两次连改很常见。 */
const STREAK_LIMIT = 3

const say = (m) => fs.writeSync(1, `${m}\n`)

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--top'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/retry-discipline.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const topIdx = process.argv.indexOf('--top')
const TOP = topIdx > -1 ? Number(process.argv[topIdx + 1]) : 10

const sessions = readSessionsDetailed()
const findings = []

for (const s of sessions) {
  /** 只有时间顺序可用的序列；`calls` 已按出现顺序。 */
  let streak = []
  const flush = () => {
    if (streak.length === 0) return
    const fails = streak.filter((c) => c.isError === true).length
    /**
     * 两条命中条件，**分开记**——它们的含义不同：
     *
     *   · `blind`：**失败之后没有成功读就又改**。这是真正的“在打补丁”：
     *     上一次改错了，而下一步不是去看清楚，而是再猜一次。
     *   · `long`：连续写 ≥ STREAK_LIMIT 而其间没读过。这只说明“没有回头核对”，
     *     长重构也会这样，所以它**单独不算问题**，只作为背景。
     *
     * 第一版把两者合成一条（`blind: fails > 0` 且要求长度 ≥3），于是
     * **抓不到我自己的那次事故**：那一串 6 次写里有失败，但第一版要求的是长度与失败同时满足，
     * 而真正的信号只有“失败后不读又改”。判据要按**动作序列**定义，不是按长度。
     */
    let blind = 0
    for (let i = 1; i < streak.length; i += 1) {
      if (streak[i - 1].isError === true) blind += 1
    }
    if (blind > 0 || streak.length >= STREAK_LIMIT) {
      findings.push({ session: s.dir, file: streak[0].file, writes: streak.length, fails, blind })
    }
    streak = []
  }
  for (const c of s.calls ?? []) {
    const file = c.args?.file_path
    if (typeof file !== 'string') continue
    if (WRITE.test(c.name)) {
      // 换文件就结算上一串
      if (streak.length > 0 && streak[0].file !== file) flush()
      streak.push({ name: c.name, isError: c.isError, file })
      continue
    }
    if (READ.test(c.name)) {
      // 成功读一次即打断：这条序列不再是"盲修补"
      if (c.isError !== true) flush()
    }
  }
  flush()
}

findings.sort((a, b) => b.blind - a.blind || b.writes - a.writes)

say('=== 同一文件反复修补：把“自责”变成可检测的信号 ===')
say('  真信号：**失败之后没有成功读就又改**（上一次改错了，下一步不是去看清楚而是再猜一次）')
say(`  背景：同一文件连续 ≥${STREAK_LIMIT} 次写且其间没读（长重构也会这样，**单独不算问题**）`)
say(`  扫描：${sessions.length} 个会话`)
say('')

const blind = findings.filter((f) => f.blind > 0)
say(`  命中 ${findings.length} 条；其中"失败后不读又改"（真信号）${blind.length} 条`)
say(`  最长的一条：${findings.length === 0 ? 'n/a' : `${findings[0].writes} 次连续写`}`)
say('')

if (findings.length === 0) {
  say('  ✓ 没有命中。注意这**不等于**"没有打补丁"——判据只覆盖"不读就连改"这一种可观测形态。')
} else {
  say(`  最长的 ${Math.min(TOP, findings.length)} 条：`)
  for (const f of findings.slice(0, TOP)) {
    const name = f.file.split(/[\\/]/).pop()
    say(`    盲修补 ${String(f.blind).padStart(2)} / 连续写 ${String(f.writes).padStart(2)} / 失败 ${String(f.fails).padStart(2)}  ${name}`)
    say(`         ${f.file}`)
  }
}
