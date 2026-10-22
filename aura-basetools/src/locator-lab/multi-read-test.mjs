#!/usr/bin/env node
/**
 * multi-read-test —— 读侧多目标（fs-contract-v2 / mt2）自己的套件。
 *
 * ## 它在钉什么（按契约逐条）
 *
 *   A `items-bytes`   逐项正确：每个目标在多目标调用里拿到的信封，与**同一个目标单独跑一次**
 *                     逐字节相同（含 `lines` / `digest` / `search` / 带行寻址参数三写法 / CRLF+BOM 档）。
 *                     BOM 那两条单独点名：`provider.readText` 把 BOM 吃掉了，多目标路径必须自己
 *                     从**字节**把它捞回来（BOM 进内容指纹与句柄，丢了不是"少一个字段"而是换令牌）。
 *   B `order`         **结果顺序 = 输入顺序**。构造"后面那个明显更小/更快"的样例（慢 provider：
 *                     前面的目标睡 24ms、后面 0ms），于是"按完成顺序 push"会把数组整根翻过来。
 *                     这一条同时用两组不同排列的输入对做，防"恰好倒序也对"。
 *   C `n1-direct`     **N===1 不建池**：计数 provider 断言 N=1 的调用序列与直接调单目标入口
 *                     （`readEnvelope`）**逐项相同**，且两次都是同一份字节。这是本单对红线
 *                     （`single-target-nonregression-test.mjs`）的交代：多目标没有把单目标带进新路径。
 *   D `concurrency`   **N>1 真的并发**，而且是**确定性观测**：可控延迟的假 provider + `trace` 钩子，
 *                     断言 `maxInFlight === min(MT_POOL, N)`（结构量，不是墙钟阈值）。
 *                     同时断言池**有界**：12 个目标、池宽 3 ⇒ 在飞峰值 3。
 *   E `limits`        超过 `MT_MAX_TARGETS` ⇒ **抛错并报出实得数**；空数组 / 不是数组 / 非对象元素
 *                     ⇒ 形状类抛错。形状错误一律抛（不进结果通道），与 `ARGS_UNKNOWN_KEY` 同族。
 *   F `failure`       一条失败不影响其余：3 个目标、中间那个不存在 ⇒ 整批 `ok:false` 但**另外两条照常**；
 *                     目录目标给可执行的拒绝而不是崩；非 UTF-8 同样逐项拒绝。
 *   G `receipt`       逐项回执与**单目标同形**（成功的 `envelope` 就是 `readWith` 的原样输出）+
 *                     一行汇总；汇总只出现在 `summary`，**不进任何正文**（正文是宿主剪枝器量的东西）。
 *
 * ## 为什么一条计时阈值都没有
 *
 * 机器的计时随负载漂移，而本仓在"按可用内存估额度"的计时判据上被咬过两次（红线套件文件头
 * 记着这件事）。这里的并发判据是**在飞峰值**与**完成顺序交错**，两者都由池的实现决定，
 * 与 CPU 忙不忙无关：慢 provider 下 4 个目标必然同时在飞，快机器上也一样。
 *
 * ## 退出码
 *
 * 判据全部接在退出码上（末行 `--- N/N 通过 ---`，有任何一条 ✗ 就 `exit 1`）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pkgRoot, pkgPath } from '../../build/pkg-root.mjs'

/**
 * 包根从**文件位置**推导（`build/pkg-root.mjs`），不靠目录名：仓 clone 到任意名字
 * （`aura-tools` / `aura-basetools` / 随机名）都成立。以前写死 `path.join(ROOT, 'aura-tools', …)`，
 * 只在包目录恰好叫 aura-tools 时可用。
 */
const ROOT = pkgRoot
const FIXTURES = pkgPath('fixtures')

const { readManyWith, readWith, MT_POOL, MT_MAX_TARGETS } = await import('./read-core.mjs')
const { createNodeFsProvider } = await import('../aura-standalone/lib/fs-provider.mjs')
const { readEnvelope } = await import('../aura-standalone/lib/ops.mjs')

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  return ok
}

// ── 夹具：包根内相对写法进请求（与红线套件同一口径，回执里因此没有绝对路径） ──────
const REL = (name) => `fixtures/${name}`
const ABS = (name) => path.join(FIXTURES, name)
const SMALL = 'golden-target-small.mjs'
const LARGE = 'golden-target-large.mjs'
const CRLF_BOM = 'golden-target-crlf-bom.mjs'

const provider = createNodeFsProvider({ resolveRoot: ROOT })

// ── 计数 provider：包住真 provider，逐方法记一条 `方法:目标`（与红线同一形状） ────
const COUNTED_METHODS = ['resolve', 'stat', 'readText', 'readByteRange']
function countingProvider(inner) {
  const calls = []
  const out = {}
  for (const method of COUNTED_METHODS) {
    const fn = inner[method]
    if (typeof fn !== 'function') continue
    out[method] = (...args) => {
      calls.push(`${method}:${String(args[0]).split(path.sep).join('/')}`)
      return fn.apply(inner, args)
    }
  }
  out.calls = calls
  return out
}

/**
 * 假 provider：内存里的文件表 + **固定延迟** + **同步抛**的两种失败。
 *
 * 两个刻意的设计：
 *   · 延迟只在 `readText` 上，且由表里指定 ⇒ 完成顺序完全可预测（不是"大概"）；
 *   · `resolve` / `stat` **同步**返回 ⇒ 调用序列确定，`maxInFlight` 的读数不受微任务调度影响。
 * 非 UTF-8 与二进制走 `readText` **同步抛**（真 provider 也是同步抛：`readOrThrow` 在 async
 * 函数体第一行）——多目标那条路必须在 `await` 上接住它，而不是只在 `catch` 里等 reject。
 */
function fakeProvider(table, { delayOf = () => 0, onFinish = null } = {}) {
  const calls = []
  const has = (t) => Object.prototype.hasOwnProperty.call(table, t)
  return {
    calls,
    resolve: (p) => String(p),
    stat: (t) => {
      calls.push(`stat:${t}`)
      if (!has(t)) return undefined
      const entry = table[t]
      if (entry.type !== undefined) return { type: entry.type, size: 0 }
      return { type: 'file', size: entry.text.length, version: `v:${entry.text.length}` }
    },
    async readText(t) {
      calls.push(`readText:${t}`)
      if (!has(t)) throw Object.assign(new Error(`cannot read "${t}": not found`), { code: 'FS_NOT_FOUND' })
      const entry = table[t]
      const wait = delayOf(t, entry)
      if (wait > 0) {
        const done = new Promise((resolve) => setTimeout(resolve, wait))
        // 睡的时候把"开始读"这条也记下来：它是判断"同时在飞几个"的另一路证据。
        calls.push(`readText:begin:${t}`)
        await done
      }
      // 完成顺序的**唯一**记录点：这一条真的读完（延时走完了 / 本来就不用等）才算。
      if (typeof onFinish === 'function') onFinish(t)
      if (entry.binary === true) throw Object.assign(new Error(`cannot read "${t}": binary file`), { code: 'FS_NOT_TEXT' })
      if (entry.badUtf8 === true) {
        throw Object.assign(new Error('The encoded data was not valid for encoding utf-8'), {
          code: 'ERR_ENCODING_INVALID_ENCODED_DATA',
        })
      }
      return entry.text
    },
    async readByteRange(t, range) {
      calls.push(`readByteRange:${t}`)
      const bytes = table[t]?.bytes ?? new Uint8Array()
      const offset = Math.max(0, range?.offset ?? 0)
      return bytes.slice(offset, offset + Math.max(0, range?.length ?? 0))
    },
  }
}

/** 现造一份"有符号有函数"的小文件（`mode: 'map'` 要符号表才不降级）。 */
function twinSource(tag, blocks) {
  const head = [`/** ${tag} 头 */`, `export const ${tag}Version = '1'`]
  const body = []
  for (let b = 0; b < blocks; b += 1) {
    body.push(`/** ${tag} ${b} */`, `export function ${tag}${b}(value) {`, `  return value + ${b}`, `}`, ``)
  }
  return [...head, ...body].join('\n')
}

/** 直接读夹具文本（本节核对内容用，不经任何 provider）。 */
const readFileSyncText = (name) => fs.readFileSync(ABS(name), 'utf8')

const t0 = Date.now()
say('=== A. 逐项正确：多目标里每一条与它单独跑一次逐字节相同 ===')
/**
 * 用例定义**只有一份**：`req` 既进多目标数组，也单独跑一次。
 * 于是"两条路给出同一份字节"是同一份输入的两种调用方式之比，不是两份手抄的期望值之比。
 */
const A_CASES = [
  { rel: SMALL, req: { mode: 'lines', lines: [10, 30] } },
  { rel: SMALL, req: { mode: 'search', search: 'items' } },
  { rel: LARGE, req: { mode: 'digest' } },
  { rel: LARGE, req: { mode: 'lines', lines: [400, 440] } },
  { rel: LARGE, req: { mode: 'map' } },
  { rel: CRLF_BOM, req: { mode: 'lines', lines: [1, 12] } },
  // 行寻址的三种写法都必须被**同一对判定器**解出来（`lineRangeOf` + `inferReadMode`）
  { rel: SMALL, req: { start_line: 5, end_line: 9 } },
  { rel: SMALL, req: { lines: '12,18' } },
  { rel: SMALL, req: { lines: 7 } },
  { rel: SMALL, req: { mode: 'auto', lines: [4, 6] } },
]
const aTargets = A_CASES.map((c) => ({ file_path: REL(c.rel), ...c.req }))
const aBatch = await readManyWith(provider, aTargets)
check(aBatch.entries.length === A_CASES.length, `逐项回执条数 = 目标数（${aBatch.entries.length}）`)
check(aBatch.ok === true, `整批全部成功：${aBatch.summary}`)
let byteDiff = 0
const byteDiffNames = []
for (let i = 0; i < A_CASES.length; i += 1) {
  const solo = await readEnvelope(provider, { file: REL(A_CASES[i].rel), ...A_CASES[i].req })
  const inBatch = aBatch.entries[i].envelope
  if (JSON.stringify(solo) !== JSON.stringify(inBatch)) {
    byteDiff += 1
    byteDiffNames.push(`${A_CASES[i].rel}/${JSON.stringify(A_CASES[i].req)}`)
  }
}
check(byteDiff === 0, `${A_CASES.length} 条逐项回执与单独跑一次逐字节相同`, byteDiff === 0 ? '' : byteDiffNames.join('；'))
/**
 * BOM 指名道姓测一遍：多目标路径的证据是**字节**，不是"文本里有没有 U+FEFF"。
 * 对照物是 `readEnvelope`（走 `readFileBytes`，BOM 也正是从字节得出的）——
 * 两侧对同一份文件给出**逐字节相同**的信封，才算 BOM 这件事没在路上丢。
 */
const bomBytes = fs.readFileSync(ABS(CRLF_BOM))
check(
  bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf,
  `夹具确实带 UTF-8 BOM（${bomBytes.slice(0, 3).join(',')}）`,
)
const bomTargets = [
  { file_path: REL(CRLF_BOM), mode: 'lines', lines: [1, 6] },
  { file_path: REL(SMALL), mode: 'lines', lines: [1, 6] },
]
const bomBatch = await readManyWith(provider, bomTargets)
for (let i = 0; i < bomTargets.length; i += 1) {
  const solo = await readEnvelope(provider, {
    file: bomTargets[i].file_path,
    mode: 'lines',
    lines: bomTargets[i].lines,
  })
  check(
    JSON.stringify(bomBatch.entries[i].envelope) === JSON.stringify(solo),
    `BOM 档 ${i}：多目标与单目标入口逐字节相同（${bomTargets[i].file_path}）`,
  )
}
check(
  !bomBatch.entries[0].envelope.text.includes('\uFEFF'),
  '正文里没有残留 BOM 字符（`readText` 吃掉它、我们补的是元数据，不是前缀）',
)
check(
  !bomBatch.entries[0].envelope.text.includes('\uFEFF'),
  '正文里没有残留 BOM 字符（`readText` 吃掉它、我们补的是元数据，不是前缀）',
)

say('')
say('=== B. 顺序：结果数组 = 输入顺序（不是完成顺序） ===')
/**
 * 构造"**后面的目标明显更快**"：输入第 0 条睡 30ms、第 1 条 12ms、第 2 条 0ms。
 * 完成顺序因此是 2 → 1 → 0，而输入顺序是 0 → 1 → 2。
 * "按完成顺序 push"会把数组整根翻过来（段 mutation ① 就是这么把它变红的）。
 */
const orderTable = {
  'slow-a.mjs': { text: twinSource('osa', 6), delay: 30 },
  'mid-b.mjs': { text: twinSource('osb', 6), delay: 12 },
  'fast-c.mjs': { text: twinSource('osc', 6), delay: 0 },
}
/**
 * **完成顺序**的存放处：假 provider 的 `readText` 真正返回时（延时结束、往外返回之前）推一条。
 *
 * 为什么不用墙钟去证明"输出不是按完成顺序排的"：那会拿计时当判据，而本套件一条计时判据都没有。
 * 这里的完成顺序是一条**被记下来的序列**，与机器快慢无关：30ms 那个必然最后回。
 */
const orderTargets = ['slow-a.mjs', 'mid-b.mjs', 'fast-c.mjs'].map((f) => ({ file_path: f, mode: 'digest' }))
const finished = []
const ordered = await readManyWith(
  fakeProvider(orderTable, {
    delayOf: (t) => orderTable[t]?.delay ?? 0,
    onFinish: (t) => finished.push(t),
  }),
  orderTargets,
)
check(
  ordered.entries.map((e) => e.file_path).join(',') === 'slow-a.mjs,mid-b.mjs,fast-c.mjs',
  `顺序 = 输入序（${ordered.entries.map((e) => e.file_path).join(' → ')}）`,
)
check(ordered.entries.map((e) => e.index).join(',') === '0,1,2', 'index 也按输入序，不是完成序')
check(
  finished.join(',') === 'fast-c.mjs,mid-b.mjs,slow-a.mjs',
  `完成顺序确实与输入顺序**相反**（${finished.join(' → ')}）——所以上一条不是白送的`,
)
/** 再来一组反排列：把同一批倒过来，输出必须跟着输入倒过来（防"恰好倒序也对"）。 */
const revFinished = []
const reversed = await readManyWith(
  fakeProvider(orderTable, {
    delayOf: (t) => orderTable[t]?.delay ?? 0,
    onFinish: (t) => revFinished.push(t),
  }),
  [...orderTargets].reverse(),
)
check(
  reversed.entries.map((e) => e.file_path).join(',') === 'fast-c.mjs,mid-b.mjs,slow-a.mjs',
  `倒过来的输入给倒过来的输出（${reversed.entries.map((e) => e.file_path).join(' → ')}）`,
)
check(
  revFinished.join(',') === 'fast-c.mjs,mid-b.mjs,slow-a.mjs',
  '倒过来之后完成顺序恰好**等于**输入序（同一批延迟、两种排列各站一边）',
)
/** 内容也跟着下标走：每条信封确实来自它自己那份文件，不是"顺序对了、内容串了"。 */
check(
  ordered.entries[0].envelope.symbols > 0 &&
    ordered.entries[0].envelope.text.includes('osa') &&
    !ordered.entries[0].envelope.text.includes('osc'),
  '第 0 条信封的内容确实来自第 0 个目标（osa 在、osc 不在）',
)

say('')
say('=== C. N===1 ⇒ 直调：零池、零包装、每目标恰好读一次 ===')
/**
 * 这一条是本单对红线的交代。两侧都跑"读同一个文件"：
 *   · 左：`readEnvelope(provider, {file, …})`——**今天** CLI/MCP 用的那条路（红线钉住的那条）；
 *   · 右：`readManyWith(provider, [{file_path, …}])`——多目标入口在 N=1 时的行为。
 *
 * 比什么、为什么不能直接比调用序列（这一条是**读出来的事实**，不是取舍）：
 * 左那条路读盘走 `readEnvelope` 里的 `readFileBytes`（直接 fs），**根本不调 `provider.readText`**
 * ——红线黄金集里 `provider-calls/read-lines-small` 就是 `["resolve:…","stat:…"]` 两条。
 * 所以两侧的调用序列**天然是两条 vs 三条**，而这不是回归：单目标那条路一个字都没改
 * （它仍然只做 resolve + stat + 直接读）。本套件因此把 N=1 钉成三件事：
 *   ① 回执与单目标入口**逐字节相同**（含句柄身份——同一个文件两条路给同一个柄）；
 *   ② 多目标入口自己**每目标恰好读一次**（`resolve → stat → readText`，关了 BOM 探针后
 *      连"多读 3 个字节"都没有），且连跑 3 次序列逐项相同；
 *   ③ N=1 时池一次都没被建起来（`trace` 零次）。
 * 红线套件则站在另一头盯单目标那条路本身（26/26）。
 */
const n1Rel = REL(SMALL)
const leftCount = countingProvider(createNodeFsProvider({ resolveRoot: ROOT }))
const left = await readEnvelope(leftCount, { file: n1Rel, lines: '10,30' })
const rightCount = countingProvider(createNodeFsProvider({ resolveRoot: ROOT }))
const rightBatch = await readManyWith(rightCount, [{ file_path: n1Rel, mode: 'lines', lines: [10, 30] }])
const right = rightBatch.entries[0].envelope
const leftCalls = leftCount.calls
const rightCalls = rightCount.calls
say(`  单目标入口调用序列：${leftCalls.join(' → ')}`)
say(`  多目标 N=1 调用序列：${rightCalls.join(' → ')}`)
check(JSON.stringify(left) === JSON.stringify(right), 'N=1 回执与单目标入口回执逐字节相同（含句柄身份）')
const probeCalls = rightCalls.filter((c) => c.startsWith('readByteRange:'))
check(probeCalls.length <= 1, `N=1 最多一次 BOM 探针（实得 ${probeCalls.length}）`)
check(
  leftCalls.length === 2 && leftCalls[0].startsWith('resolve:') && leftCalls[1].startsWith('stat:'),
  `单目标入口只做 resolve+stat（读盘走 readFileBytes 直接 fs）：${leftCalls.length} 次——这正是它不得被改造的理由`,
)
/**
 * 关掉 BOM 探针（一个新入口没有的选项）⇒ 调用序列是 **resolve → stat → readText**，
 * 即"一个目标恰好读一次、零额外调用"。不比 `readEnvelope`，因为那一条读盘**根本不走 provider**
 * （见上一条断言）；这里比的是"多目标入口自己不许比这更多"。
 */
const bareCalls = []
for (let round = 0; round < 3; round += 1) {
  const bareCount = countingProvider(createNodeFsProvider({ resolveRoot: ROOT }))
  await readManyWith(bareCount, [{ file_path: n1Rel, mode: 'lines', lines: [10, 30] }], { probeBom: false })
  bareCalls.push(bareCount.calls)
}
const bareMethods = bareCalls[0].map((c) => c.split(':')[0])
check(
  bareMethods.join(',') === 'resolve,stat,readText',
  `\`probeBom:false\` 时 N=1 就是一个目标恰好读一次：${bareCalls[0].join(' → ')}`,
)
check(
  bareCalls.every((c) => JSON.stringify(c) === JSON.stringify(bareCalls[0])),
  '连跑 3 次调用序列逐项相同（N=1 这条路是确定的，不长出额外调用）',
)
/** 同一批次里同一个文件出现两次：两次各读一次，但两条回执**逐字节相同**（没有跨项污染）。 */
const twinCount = countingProvider(createNodeFsProvider({ resolveRoot: ROOT }))
const twin = await readManyWith(twinCount, [
  { file_path: n1Rel, mode: 'lines', lines: [10, 30] },
  { file_path: n1Rel, mode: 'lines', lines: [10, 30] },
])
check(
  JSON.stringify(twin.entries[0].envelope) === JSON.stringify(twin.entries[1].envelope),
  '同批里同一个文件两次：两条回执逐字节相同',
)
check(
  twinCount.calls.filter((c) => c.startsWith('readText:')).length === 2,
  `同批同一个文件读两次（每条目标读一次，不合并、不串台）：${twinCount.calls.length} 次调用`,
)
/** `trace` 在 N=1 时一次都不该被叫到——不建池的直接证据（池是唯一会 trace 的地方）。 */
let n1Trace = 0
await readManyWith(provider, [{ file_path: n1Rel, mode: 'digest' }], { trace: () => { n1Trace += 1 } })
check(n1Trace === 0, 'N=1 时 `trace` 一次都没触发（没有池被建起来）')

say('')
say('=== D. N>1 真的并发（确定性观测：在飞峰值，不是墙钟） ===')
const dTable = {}
for (let i = 0; i < 12; i += 1) dTable[`d${i}.mjs`] = { text: twinSource(`od${i}`, 4), delay: 25 }
const dTargets = Object.keys(dTable).map((f) => ({ file_path: f, mode: 'map' }))
/** 每一段跑各造一个 provider：调用轨迹是**这一段**的，不混上一段的账。 */
const dFresh = () => fakeProvider(dTable, { delayOf: (t) => dTable[t]?.delay ?? 0 })
const dProvider = dFresh()
const dPeaks = []
const dBatch = await readManyWith(dProvider, dTargets, { trace: (e) => dPeaks.push(e.maxInFlight) })
check(
  Math.max(...dPeaks) === MT_POOL,
  `N=12（> MT_POOL=${MT_POOL}）时在飞峰值 = MT_POOL（观测值 ${Math.max(...dPeaks)}）`,
)
check(dBatch.ok === true && dBatch.entries.length === 12, `12 条全部成功且顺序装配：${dBatch.summary}`)
/** 有界：池宽压到 3 ⇒ 在飞峰值必须恰好 3（多一个就说明池没夹住）。 */
const narrowPeaks = []
await readManyWith(dFresh(), dTargets.slice(0, 6), { pool: 3, trace: (e) => narrowPeaks.push(e.maxInFlight) })
check(Math.max(...narrowPeaks) === 3, `池宽 3 时在飞峰值 = 3（观测值 ${Math.max(...narrowPeaks)}）`)
/**
 * 并发是**交错**的，不是"一个读完再读下一个"：这一段只用**自己的**轨迹。
 * 第 4 个目标的 `readText` 开始（发了 begin 标记）时，第 1 个还在延迟段里没回。
 */
const beginOrder = dProvider.calls.filter((c) => c.startsWith('readText:begin:'))
const firstThree = dProvider.calls.indexOf('readText:begin:d3.mjs')
const firstSettled = dProvider.calls.indexOf('readByteRange:d0.mjs')
check(beginOrder.length === 12, `12 条读都进了延迟段（${beginOrder.length}）`)
check(
  firstThree !== -1 && (firstSettled === -1 || firstThree < firstSettled),
  `第 4 个目标在第 1 个目标读完之前就已开始（调用序号 ${firstThree + 1} < ${firstSettled === -1 ? '∞' : firstSettled + 1}）`,
)
/** N=1 与 N>1 的**同一批**结果一致：并发不许改变任何一项的内容。 */
const soloOne = await readManyWith(dFresh(), [dTargets[0]], { probeBom: false })
check(
  JSON.stringify({ ...soloOne.entries[0].envelope, handle: undefined }) ===
    JSON.stringify({ ...dBatch.entries[0].envelope, handle: undefined }),
  '同一个目标：单独跑（N=1）与在 12 条里跑，信封除句柄外逐字节相同',
  JSON.stringify(soloOne.entries[0].envelope) === JSON.stringify(dBatch.entries[0].envelope),
  '同一个目标：单独跑（N=1）与在 12 条里跑，信封逐字节相同（连句柄都相同）',
)

say('')
say('=== E. 上限与形状：超过 MT_MAX_TARGETS 抛错并报出实得数 ===')
const tooMany = Array.from({ length: MT_MAX_TARGETS + 3 }, () => ({ file_path: 'x.mjs', mode: 'digest' }))
let tooManyError = null
try {
  await readManyWith(provider, tooMany)
} catch (error) {
  tooManyError = error
}
check(tooManyError !== null && tooManyError.code === 'MT_TOO_MANY_TARGETS', `超过上限抛错：${tooManyError?.code}`)
check(
  tooManyError !== null && String(tooManyError.message).includes(String(tooMany.length)),
  `错误里报出**实得数** ${tooMany.length}：${tooManyError?.message}`,
)
check(tooManyError?.got === tooMany.length && tooManyError?.max === MT_MAX_TARGETS, '错误对象带 got / max 两个结构字段')
const exactlyMax = await readManyWith(fakeProvider({ 'x.mjs': { text: 'export const a = 1\n' } }), tooMany.slice(0, 1))
check(exactlyMax.entries.length === 1, `上限内正常运行（${MT_MAX_TARGETS} 是允许值：这里跑 1 条作代表）`)
const shapeErrors = []
for (const [label, bad] of [
  ['空数组', []],
  ['字符串', 'x.mjs'],
  ['null', null],
  ['数字', 7],
]) {
  try {
    await readManyWith(provider, bad)
    shapeErrors.push(`${label}:没抛`)
  } catch (error) {
    shapeErrors.push(`${label}:${error.code}`)
  }
}
check(
  shapeErrors.every((s) => s.endsWith('MT_BAD_TARGETS')),
  `形状不成形一律抛 \`MT_BAD_TARGETS\`：${shapeErrors.join(' / ')}`,
)
let elementError = null
try {
  await readManyWith(fakeProvider({}), [null])
} catch (error) {
  elementError = error
}
check(elementError?.code === 'MT_BAD_TARGETS', `元素不是对象也抛形状错（不是回一条 not_found）：${elementError?.code}`)
let noPathError = null
try {
  await readManyWith(fakeProvider({}), [{ mode: 'digest' }])
} catch (error) {
  noPathError = error
}
check(noPathError?.code === 'MT_BAD_TARGETS', `元素缺 file_path 抛形状错：${noPathError?.message}`)

say('')
say('=== F. 失败语义：一条失败不影响其余，且逐项说清 ===')
const fTable = {
  'keep-a.mjs': { text: twinSource('ofa', 4) },
  'keep-c.mjs': { text: twinSource('ofc', 4) },
}
const fProvider = fakeProvider(fTable)
const fBatch = await readManyWith(fProvider, [
  { file_path: 'keep-a.mjs', mode: 'digest' },
  { file_path: 'gone-b.mjs', mode: 'digest' },
  { file_path: 'keep-c.mjs', mode: 'digest' },
])
check(fBatch.ok === false, `整批 ok=false（有一条没成）`)
check(
  fBatch.entries.map((e) => e.ok).join(',') === 'true,false,true',
  `中间那条没成，两侧照常（${fBatch.entries.map((e) => e.ok).join(',')}）`,
)
check(
  fBatch.summary === 'targets: 3 ｜ ok 2 ｜ not_found 1',
  `汇总行点明哪几条没成：\`${fBatch.summary}\``,
)
check(fBatch.counts.ok === 2 && fBatch.counts.failed === 1, 'counts 与逐项一致')
check(fBatch.entries[1].code === 'FS_NOT_FOUND' && fBatch.entries[1].target === 'gone-b.mjs', `失败项带 code 与目标：${fBatch.entries[1].code}`)
check(fBatch.entries[1].outcome === 'failed' && fBatch.entries[1].message.includes('not found'), '失败项带 outcome 与 message')
check(
  fBatch.entries[1].envelope === undefined && fBatch.entries[2].envelope !== undefined,
  '没成的那条没有 envelope，成了的照常有',
)
/** 目录：可执行的拒绝（带 `next`），不是崩。 */
const dirBatch = await readManyWith(provider, [
  { file_path: 'fixtures', mode: 'map' },
  { file_path: REL(SMALL), mode: 'digest' },
])
check(dirBatch.entries[0].code === 'MT_TARGET_IS_DIRECTORY', `目录目标逐项拒绝：${dirBatch.entries[0].code}`)
check(typeof dirBatch.entries[0].next === 'string', `拒绝里有可执行的下一步：${dirBatch.entries[0].next}`)
check(dirBatch.entries[1].ok === true, '同批里的文件目标不受目录那条影响')
/** 非 UTF-8 / 二进制：`readText` **同步抛**也要被那条路接住（只在 catch 里等 reject 会炸穿整批）。 */
const badProvider = fakeProvider({
  'bin-a.mjs': { text: '', binary: true },
  'ok-b.mjs': { text: twinSource('ofb', 3) },
  'bad-c.mjs': { text: '', badUtf8: true },
})
const badBatch = await readManyWith(badProvider, [
  { file_path: 'bin-a.mjs', mode: 'digest' },
  { file_path: 'ok-b.mjs', mode: 'digest' },
  { file_path: 'bad-c.mjs', mode: 'digest' },
])
check(
  badBatch.entries.map((e) => e.ok).join(',') === 'false,true,false',
  `同步抛也逐项接住（${badBatch.entries.map((e) => e.code ?? 'ok').join(',')}）`,
)
check(badBatch.entries[0].code === 'FS_NOT_TEXT', `二进制逐项拒绝：${badBatch.entries[0].code}`)
check(
  badBatch.entries[2].code === 'ERR_ENCODING_INVALID_ENCODED_DATA',
  `非 UTF-8 原样保留提供方的码：${badBatch.entries[2].code}`,
)
/** 参数写坏：给了行寻址但解不出来 ⇒ 逐项拒绝（与单目标同一句话），不是静默退回 auto。 */
const badArgsBatch = await readManyWith(provider, [
  { file_path: REL(SMALL), lines: [10, 'abc'] },
  { file_path: REL(SMALL), mode: 'digest' },
])
check(
  badArgsBatch.entries[0].code === 'READ_BAD_ARGS' && String(badArgsBatch.entries[0].message).includes('start_line'),
  `行寻址写坏 ⇒ 逐项拒绝并给出接受哪些形状：${badArgsBatch.entries[0].code}`,
)
check(badArgsBatch.entries[1].ok === true, '写坏的那条不影响同批的其余目标')

say('')
say('=== G. 回执形状：逐项同形 + 汇总只在 summary，不进正文 ===')
const gBatch = await readManyWith(provider, [
  { file_path: REL(SMALL), mode: 'lines', lines: [3, 8] },
  { file_path: REL(LARGE), mode: 'search', search: 'CONFIG_07' },
])
const gSolo = readEnvelope(provider, { file: REL(SMALL), lines: '3,8' })
check(
  JSON.stringify(gBatch.entries[0].envelope) === JSON.stringify(await gSolo),
  '逐项 `envelope` **就是**单目标回执本身（同一套渲染，不是另渲染一遍）',
)
check(
  gBatch.entries.every((e) => typeof e.envelope === 'object' && e.envelope.ok === true),
  '每条都有完整的单目标信封（不是摘要）',
)
check(
  gBatch.entries.every((e) => !String(e.envelope.text ?? '').includes('targets:')),
  '汇总行不在任何逐项正文里',
)
check(
  typeof gBatch.summary === 'string' && gBatch.summary.startsWith(`targets: ${gBatch.targets}`),
  `汇总在 summary 字段里：${gBatch.summary}`,
)
check(
  gBatch.targets === 2 && Object.keys(gBatch).length <= 7,
  `整批回执是紧凑的（顶层 ${Object.keys(gBatch).length} 个字段：${Object.keys(gBatch).join(',')}）`,
)
/**
 * 单目标那条路完全没被碰过：`readWith` 直接调还是原来的字节。
 *
 * `filePath` 必须给 **provider.resolve 之后**的那个串：账本键（因而句柄身份标签）算在它上面，
 * 而单目标入口给的就是解析后的路径。给相对写法会得到另一个柄——这是本单踩过的真坑，
 * 它也让上面那条"批内 == 单独跑"变成了对账本键的断言。
 */
const directLines = readWith(readFileSyncText(SMALL), {
  mode: 'lines',
  lines: [3, 8],
  filePath: provider.resolve(REL(SMALL)),
})
check(
  JSON.stringify(directLines) === JSON.stringify(gBatch.entries[0].envelope),
  '`readWith`（单目标直调）与批内那一条逐字节相同——多目标没有改单目标那条路',
)

say('')
say('=== H. 句柄身份两条路同源：同一文件同一区间 ⇒ 句柄逐字相同，且批内句柄能直接拿去改 ===')
{
  /**
   * 这一段跑的是**两个真壳**（aura_read / aura_edit）+ 一个与 `dsh-fs-local` 同形的宿主 fs：
   * `resolve` 给 `{displayPath, targetKey}`，而**调用方给的是相对写法**（模型真的这么干）。
   *
   * 身份不一致只在“壳把宿主事实丢掉”时出现：单目标那条路递的是 `targetKey`，多目标那条路若只
   * 把路径串当身份，就会按**调用方写法**记账 ⇒ 同一份盘上文件两个句柄（实测 `h4745015d4840:…` vs
   * `he6dd015d4840:…`：指纹段相同、身份标签段不同），而拿批内句柄去改会以
   * `PATCH_HANDLE_IDENTITY_MISMATCH` 断掉。三条断言就在下面。
   */
  const { contextServices } = await import('./mock-ctx.mjs')
  const readPlugin = await import('../aura-read/index.js')
  const editPlugin = await import('../aura-edit/index.js')
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? ROOT, 'mt7-handle-'))
  const A = 'alpha.mjs'
  const B = 'bravo.mjs'
  const SRC_A = 'const one = 1\nconst two = 2\nconst three = 3\nconst four = 4\n'
  const SRC_B = 'const red = 1\nconst green = 2\n'
  fs.writeFileSync(path.join(tmp, A), SRC_A)
  fs.writeFileSync(path.join(tmp, B), SRC_B)
  const decode = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b)
  let version = 1
  const fsService = {
    // 与 `dsh-fs-local` 同形：`displayPath` 是按 cwd 解出的绝对值，`targetKey` 是宿主给的盘上事实。
    resolve: async (p, opts) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(opts?.cwd ?? tmp, p)
      return { displayPath: abs, targetKey: abs }
    },
    stat: async (t) =>
      fs.existsSync(t.targetKey) ? { version: `v${version}`, type: 'file', size: fs.statSync(t.targetKey).size } : undefined,
    readText: async (t) => decode(fs.readFileSync(t.targetKey)),
    readByteRange: async (t, range) => fs.readFileSync(t.targetKey).subarray(range.offset, range.offset + range.length),
    writeText: async (t, content, expected) => {
      const p = t.targetKey
      const existed = fs.existsSync(p)
      if (expected?.kind === 'replaceIfVersion' && (!existed || `v${version}` !== expected.version)) {
        throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      fs.writeFileSync(p, content)
      version += 1
      return { version: `v${version}`, operation: existed ? 'update' : 'create', after: content }
    },
    editText: async () => {
      throw new Error('editText must not be used by the write path')
    },
  }
  let readTool = null
  let editTool = null
  const tools = { register: (t) => (t.name === 'aura_read' ? (readTool = t) : (editTool = t)), get: () => readTool }
  const mkCtx = () => ({
    fs: fsService,
    ...contextServices(),
    tools,
    emit: () => {},
    systemPrompt: { section: () => () => {} },
    waterfall: async () => {
      throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
    },
  })
  readPlugin.apply(mkCtx())
  editPlugin.apply(mkCtx())
  const exec = { agent: { session: { header: { cwd: tmp } } }, signal: undefined }
  /** 直接喂原始入参：本段要的就是两个壳在**同一份入参写法**下各自发出什么。 */
  const run = async (tool, args) => {
    try {
      return { ok: true, out: await tool.execute(args, exec) }
    } catch (error) {
      return { ok: false, code: error.code, message: String(error.message).split('\n')[0] }
    }
  }
  const WINDOW = { mode: 'lines', lines: [2, 4] }
  const single = await run(readTool, { file_path: A, ...WINDOW })
  const multi = await run(readTool, { targets: [{ file_path: A, ...WINDOW }] })
  const entry = multi.out?.entries?.[0] ?? {}
  check(typeof single.out?.handle === 'string' && single.out.handle.length > 0, `单目标读发出句柄：${single.out?.handle}`, single.message ?? '')
  check(typeof entry.handle === 'string' && entry.handle.length > 0, `多目标读的**那一项**也带句柄：${entry.handle}`, JSON.stringify(Object.keys(entry)))
  check(entry.handle === single.out?.handle, '① 同一文件同一区间：两条路的句柄**逐字相同**', `single=${single.out?.handle} multi=${entry.handle}`)
  const other = await run(readTool, { targets: [{ file_path: B, ...WINDOW }] })
  const otherHandle = other.out?.entries?.[0]?.handle
  check(typeof otherHandle === 'string' && otherHandle !== entry.handle, `另一个文件的句柄是另一把：${otherHandle}`)
  const WRONG = 'const two = 22\nconst three = 33\nconst four = 44\n'
  const wrong = await run(editTool, { file_path: A, hunks: [{ handle: otherHandle, replace: WRONG }] })
  /**
   * 判决走**结果通道**（fs-contract-v2 §1.3）：身份不符是“判不出来”那一类，所以它不抛，
   * 而是回一份带 `code` 的回执——剥两边的码：抛出来的（参数面/环境面）与结果里的各取一次。
   */
  const wrongCode = wrong.ok === false ? wrong.code : wrong.out?.code
  check(
    wrongCode === 'PATCH_HANDLE_IDENTITY_MISMATCH',
    '③ 反向：别的文件的句柄必须被拒（PATCH_HANDLE_IDENTITY_MISMATCH）',
    JSON.stringify(wrong.ok === false ? { thrown: wrong.code, message: wrong.message } : wrong.out).slice(0, 200),
  )
  check(decode(fs.readFileSync(path.join(tmp, A))) === SRC_A, '③ 被拒时 A 一个字节没落')
  const applied = await run(editTool, { file_path: A, hunks: [{ handle: entry.handle, replace: WRONG }] })
  check(
    applied.ok === true && applied.out?.outcome === 'applied',
    '② 批内句柄直接拿去 aura_edit ⇒ **成功**（不是身份不符）',
    `${applied.code ?? ''} ${applied.message ?? applied.out?.outcome ?? ''}`,
  )
  check(decode(fs.readFileSync(path.join(tmp, A))).includes('const three = 33'), '② 确实落盘')
  fs.rmSync(tmp, { recursive: true, force: true })
}

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
say('')
say(`（用时读数仅参考：${Date.now() - t0}ms；本套件没有任何计时判据）`)
if (failed > 0) say(`✗ 失败 ${failed} 条：${results.filter((r) => !r.ok).map((r) => r.label).join('；')}`)
say(`--- ${passed}/${results.length} 通过 ---`)
process.exit(failed === 0 ? 0 : 1)
