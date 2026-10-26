/**
 * incremental-read-test.mjs —— 同会话增量读的判据（C5）。
 *
 * 终态：同一会话内第二次读同一个文件时，只回**差量**（新增/改动/删除的行区间）
 * 并明写基准令牌；文件没变时回执明写 `no change`。
 *
 * ## 判据为什么长这样
 *
 * 省流层最容易骗人的地方是"看起来更省"：截断一段、概括一段、给个提示，都能把字节数
 * 压下来，而代价是**调用方手里的内容悄悄变旧**。所以本脚本的主断言不是"更省"，
 * 而是**正确性**：
 *
 *   · 段A 第二次读的体量 < 该文件全量读的 30%（省是真的）；
 *   · 段B 文件未变 ⇒ 明写 no change，且**不重复给正文**；
 *   · 段C **首读全文 + 差量重放 == 直接全量读，逐字节相同**（本单最重要的一条）；
 *   · 段D 拿不到可信基准（没观测过 / 基准被有界缓存淘汰 / 文件大到不做差分）⇒ 降级全量并说明；
 *   · 段E 负向不变量：只改一个字符也必须报出来（多报可以，漏报不行）。
 *
 * 段C 用**两种独立的重放**验：一种在 `N: 正文` 的行号正文上重放（模型真正收到的东西），
 * 一种在源行数组上重放（不依赖渲染格式）。两者都必须与直接全量读逐字节相同。
 *
 * 段落之外还有一节"没被改坏的东西"：map／digest／lines／around／search／changed
 * 的语义一个字都没动，且**首次读的回执与本层不存在时逐字节一致**。
 *
 * 跑法：node src/locator-lab/incremental-read-test.mjs
 */

import { createMemoryStore, readWith, setObservationStore } from './read-core.mjs'

const results = []
const say = (line = '') => console.log(line)

function check(ok, label, detail = '') {
  results.push({ ok: Boolean(ok), label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
//
// 文件要足够大，才能让"体量 < 30%"这条判据有意义：小文件上信封的固定开销就占满了
// （实测：只含 BOM 的文件全文 5 字符，而一句 no-change 说明两百多字符）。
// 210 行、约 4.6KB，恰好落在"auto 选全文"的档里（全文装得下内容预算）。

function buildSource(n = 210) {
  const rows = ['// incremental read fixture', "import { alpha } from './alpha.mjs'", '']
  for (let i = 0; i < n; i += 1) {
    rows.push(`const value_${i} = ${i};`)
    if (i % 20 === 19) rows.push(`export function fn_${i}(input) {`, `  return alpha(input) + ${i};`, '}')
  }
  return `${rows.join('\n')}\n`
}

/** 把 `N: 正文` 的行号正文解析回行数组（行号必须从 1 连续）。 */
function bodyRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = /^(\d+): (.*)$/.exec(line)
    if (m === null) throw new Error(`不是带行号的正文行：${JSON.stringify(line)}`)
    if (Number(m[1]) !== rows.length + 1) throw new Error(`行号不连续：${JSON.stringify(line)} (期望 ${rows.length + 1})`)
    rows.push(m[2])
  }
  return rows
}

/** 解析差量正文（unified diff）成 hunk 列表。 */
function parseDelta(deltaText) {
  const hunks = []
  let cur = null
  for (const line of deltaText.split('\n')) {
    if (line.startsWith('--- baseline ') || line.startsWith('+++ current ')) continue
    const head = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line)
    if (head !== null) {
      cur = { oldStart: Number(head[1]), oldCount: Number(head[2]), newStart: Number(head[3]), newCount: Number(head[4]), lines: [] }
      hunks.push(cur)
      continue
    }
    if (cur === null) throw new Error(`差量正文里有 hunk 之外的行：${JSON.stringify(line)}`)
    cur.lines.push(line)
  }
  return hunks
}

/**
 * 把差量重放回一份行数组。
 *
 * 行号约定与引擎里 `diffHunks` 的注释同源（照 GNU diff）：`@@ -a,b +c,d @@`，
 * 行数为 0 时起点是 **0-based 插入位**，否则是 1-based 首行。
 */
function applyDelta(rows, deltaText) {
  const out = []
  let cursor = 0
  for (const h of parseDelta(deltaText)) {
    const at = h.oldCount === 0 ? h.oldStart : h.oldStart - 1
    if (at < cursor) throw new Error(`hunk 重叠：at=${at} cursor=${cursor}`)
    for (let i = cursor; i < at; i += 1) out.push(rows[i])
    let oldSeen = 0
    let newSeen = 0
    for (const line of h.lines) {
      const type = line.slice(0, 1)
      const text = line.slice(1)
      if (type === ' ') {
        out.push(text)
        oldSeen += 1
        newSeen += 1
      } else if (type === '-') {
        oldSeen += 1
      } else if (type === '+') {
        out.push(text)
        newSeen += 1
      } else {
        throw new Error(`差量行前缀非法：${JSON.stringify(line)}`)
      }
    }
    if (oldSeen !== h.oldCount) throw new Error(`hunk 旧侧行数不符：报了 ${h.oldCount}，正文里 ${oldSeen}`)
    if (newSeen !== h.newCount) throw new Error(`hunk 新侧行数不符：报了 ${h.newCount}，正文里 ${newSeen}`)
    cursor = at + h.oldCount
  }
  for (let i = cursor; i < rows.length; i += 1) out.push(rows[i])
  return out
}

const size = (env) => JSON.stringify(env).length
const isDelta = (env) => typeof env.text === 'string' && env.text.startsWith('--- baseline ')

/** 固定种子的 PRNG：随机化性质测试必须是可复现的（否则失败无法复跑）。 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── 段A：第二次读只回差量，体量 < 全量 30%，且明写基准令牌 ──────────────────
say('=== 段A 第二次读同一文件（中间改了两处）⇒ 只回差量 ===')
{
  setObservationStore()
  const file = 'inc-a.js'
  const v1 = buildSource()
  const first = readWith(v1, { filePath: file, mode: 'full' })
  check(first.text.includes('const value_0 = 0;'), 'A1 首次读给的是全文', `${size(first)} 字符`)

  // 两处改动，相隔很远：一处改值、一处插一行
  const v2 = v1.replace('const value_5 = 5;', 'const value_5 = 55;').replace('const value_150 = 150;', 'const value_150 = 150;\nconst extra = alpha(150);')
  const second = readWith(v2, { filePath: file, mode: 'full' })
  const ratio = size(second) / size(first)
  check(ratio < 0.3, `A2 第二次读 ${size(second)} 字符 < 全量 ${size(first)} 的 30%（实测 ${(ratio * 100).toFixed(1)}%）`)
  check(second.note !== undefined && second.note.includes(first.version), 'A3 回执明写基准令牌（note 里点名首读的版本）', `note=${second.note}`)
  check(second.text.includes(first.version) && second.text.includes(second.version), 'A4 差量正文自带两端令牌（--- baseline / +++ current）')
  check(second.mode === 'full', 'A5 差量不改 mode 语义：请求 full，回执仍是 full', `mode=${second.mode}`)
  check(second.text.includes('-const value_5 = 5;') && second.text.includes('+const value_5 = 55;'), 'A6 改动行以 -/+ 成对给出')
  check(second.text.includes('+const extra = alpha(150);'), 'A7 新增行给出')
  check(second.omitted !== undefined && /unchanged line/.test(second.omitted), 'A8 被省下的未改行显式标明（不静默丢）', `omitted=${second.omitted}`)
}

// ── 段B：文件没变 ⇒ 明写 no change，且不重复给正文 ──────────────────────────
say('')
say('=== 段B 文件未变的第二次读 ⇒ no change，不给正文 ===')
{
  const file = 'inc-a.js'
  const v2 = buildSource().replace('const value_5 = 5;', 'const value_5 = 55;').replace('const value_150 = 150;', 'const value_150 = 150;\nconst extra = alpha(150);')
  const again = readWith(v2, { filePath: file, mode: 'full' })
  const full = readWith(v2, { filePath: 'inc-b-ref.js', mode: 'full' })
  check(/no change/.test(again.text) && /no change/.test(again.note ?? ''), 'B1 回执明写 no change', `note=${again.note}`)
  check(!again.text.includes('const value_0'), 'B2 不重复给正文', JSON.stringify(again.text.slice(0, 60)))
  check(again.version === full.version, 'B3 令牌是当前版本（与直接全量读同一把尺子）')
  check(size(again) < size(full) * 0.3, `B4 体量 ${size(again)} 远小于全量 ${size(full)}`)
  check(again.next !== undefined && /lines=\[1,\d+\]/.test(again.next), 'B5 给出可执行的续读指令（拿全文的路没被堵死）', `next=${again.next}`)
}

// ── 段C：正确性 —— 首读全文 + 差量 重放出来必须与直接全量读逐字节相同 ────────
say('')
say('=== 段C 首读全文 + 差量 重放 == 直接全量读（逐字节）===')
{
  setObservationStore()
  const file = 'inc-c.js'
  const v1 = buildSource()
  const v2 = v1
    .replace('const value_11 = 11;', 'const value_11 = 1111;') // 改一行
    .replace('const value_40 = 40;', 'const value_40 = 40;\nconst added_a = 1;\nconst added_b = 2;') // 插两行
    .replace('const value_77 = 77;\n', '') // 删一行

  const first = readWith(v1, { filePath: file, mode: 'full' })
  const delta = readWith(v2, { filePath: file, mode: 'full' })
  // 参照读：换一条路径 ⇒ 没有基准 ⇒ 必然是全文（不靠任何开关，保证参照物独立）
  const reference = readWith(v2, { filePath: 'inc-c-ref.js', mode: 'full' })

  check(reference.text.includes('const value_0 = 0;') && reference.text.includes('const added_b = 2;'), 'C1 参照读确实是全文')
  check(isDelta(delta), 'C2 第二次读确实是差量（否则本节什么也没验）', JSON.stringify(delta.text.slice(0, 40)))
  const header = delta.text.split('\n')[0]
  check(header === `--- baseline ${first.version}`, 'C3 差量自称的基准就是首读给的令牌', `header=${header}`)

  // 重放本身是本节的核心：没有差量就没有可重放的东西——那时如实报失败，而不是崩在解析里。
  try {
    // 重放一：在模型真正收到的行号正文上重放，再按同一渲染格式拼回去逐字节比
    const replayedRows = applyDelta(bodyRows(first.text), delta.text)
    const rendered = replayedRows.map((t, i) => `${i + 1}: ${t}`).join('\n')
    check(rendered === reference.text, 'C4 首读正文 + 差量 重放出的正文 == 直接全量读的正文（逐字节相同）', firstDiff(rendered, reference.text))
    check(replayedRows.join('\n') === bodyRows(reference.text).join('\n'), 'C4b 内容层也逐字节相同')

    // 重放二：在源行数组上重放（不依赖渲染格式）
    const replayedSource = applyDelta(v1.split('\n'), delta.text).join('\n')
    check(replayedSource === v2, 'C5 源级重放 == 目标源码（逐字节相同）', firstDiff(replayedSource, v2))
  } catch (error) {
    check(false, 'C4/C5 重放', `没有可重放的差量：${error.message}`)
  }

  // 重放三：重放结果再与"第三次读（no change）"的说法自洽
  const third = readWith(v2, { filePath: file, mode: 'full' })
  check(/no change/.test(third.text), 'C6 差量之后再读同一版本 ⇒ no change（账本记的是差量后的新版本）')
}

/** 给失败信息定位到第一个不同的字符，否则"不相同"三个字什么也说明不了。 */
function firstDiff(a, b) {
  if (a === b) return ''
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return `首个不同在第 ${i} 字符：${JSON.stringify(a.slice(Math.max(0, i - 20), i + 20))} vs ${JSON.stringify(b.slice(Math.max(0, i - 20), i + 20))}`
  }
  return `长度不同：${a.length} vs ${b.length}`
}

// ── 段D：拿不到可信基准 ⇒ 降级全量并说明 ────────────────────────────────────
say('')
say('=== 段D 基准不可信 ⇒ 降级全量并说明（不许猜）===')
{
  setObservationStore()
  // D1：从未观测过（显式要求增量时，"为什么还是全文"必须有答案）
  const d1 = readWith(buildSource(), { filePath: 'inc-d1.js', mode: 'full', incremental: true })
  check(d1.text.includes('const value_0 = 0;'), 'D1 没观测过：给的是全量')
  check(/has not been observed/.test(d1.note ?? ''), 'D1 并说明了原因', `note=${d1.note}`)

  // D2：令牌不可比 —— 账本记得"你读过"，但基准已被有界观测缓存淘汰
  const file = 'inc-d2.js'
  const v1 = buildSource()
  const first = readWith(v1, { filePath: file, mode: 'full' })
  const v2 = v1.replace('const value_3 = 3;', 'const value_3 = 33;')
  for (let i = 0; i < 9; i += 1) readWith(buildSource(4), { filePath: `inc-d2-filler-${i}.js`, mode: 'full' })
  const d2 = readWith(v2, { filePath: file, mode: 'full' })
  check(d2.text.includes('const value_0 = 0;'), 'D2 基准被淘汰：降级为全量')
  const d2ref = readWith(v2, { filePath: 'inc-d2-ref.js', mode: 'full' })
  check(/no longer in the bounded observation cache/.test(d2.note ?? ''), 'D2 并说明基准不可取', `note=${d2.note}`)
  check(d2.version === d2ref.version && d2.text === d2ref.text, 'D2 降级后给的确实是当前版本的全文')

  // D3：文件大到不做差分（引擎级护栏：差分是每次调用都要付的代价）
  const big = Array.from({ length: 10001 }, (_, i) => `const big_line_${i} = ${i};`).join('\n')
  const bigFirst = readWith(big, { filePath: 'inc-d3.js', mode: 'full', budget: 500000 })
  const bigSecond = readWith(big.replace('const big_line_3 = 3;', 'const big_line_3 = 33;'), { filePath: 'inc-d3.js', mode: 'full', budget: 500000 })
  check(bigFirst.text.includes('const big_line_0 = 0;') && bigFirst.omitted === undefined, 'D3 前提：大文件先被完整交付过一次')
  check(bigSecond.text.includes('const big_line_0 = 0;'), 'D3 太大不做差分：降级为全量')
  check(/too large to diff/.test(bigSecond.note ?? ''), 'D3 并说明是规模问题', `note=${(bigSecond.note ?? '').slice(0, 90)}`)
}

// ── 段E
say('')
say('=== 段E 负向不变量：一个字符的改动也不许漏报 ===')
{
  setObservationStore()
  const file = 'inc-e.js'
  const v1 = buildSource()
  readWith(v1, { filePath: file, mode: 'full' })
  const v2 = v1.replace('const value_11 = 11;', 'const value_11 = 12;')
  const delta = readWith(v2, { filePath: file, mode: 'full' })
  try {
    const hunks = parseDelta(delta.text)
    const removed = hunks.flatMap((h) => h.lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1)))
    const added = hunks.flatMap((h) => h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)))
    check(removed.includes('const value_11 = 11;'), 'E1 旧行被明确标为删除', JSON.stringify(removed))
    check(added.includes('const value_11 = 12;'), 'E2 新行被明确标为新增', JSON.stringify(added))
    check(removed.length === 1 && added.length === 1, 'E3 恰好一行改动：不多报也不漏报', `-${removed.length} +${added.length}`)
    check(applyDelta(v1.split('\n'), delta.text).join('\n') === v2, 'E4 重放结果与目标源码逐字节相同')
  } catch (error) {
    check(false, 'E1–E4 一个字符的改动也必须报出来', `差分正文不可解析：${error.message}`)
  }
}

say('')
say('=== 段E′ 随机化性质测试：任何形状的编辑都不许漏报（固定种子）===')
{
  setObservationStore()
  const rnd = rng(20261013)
  let trials = 0
  let deltas = 0
  let failures = 0
  let detail = ''
  for (let t = 0; t < 200; t += 1) {
    const file = `inc-rand-${t}.js`
    const base = buildSource(30).split('\n')
    const target = base.slice()
    // 四种编辑形状：改一行 / 插一行 / 删一行 / 改一个字符
    const kind = t % 4
    const at = 1 + Math.floor(rnd() * (target.length - 2))
    if (kind === 0) target[at] = `${target[at]} // touched_${t}`
    else if (kind === 1) target.splice(at, 0, `const inserted_${t} = ${t};`)
    else if (kind === 2) target.splice(at, 1)
    else target[at] = target[at].replace(/\d/, (d) => String((Number(d) + 1) % 10)) + ` /* char_${t} */`

    readWith(base.join('\n'), { filePath: file, mode: 'full' })
    const receipt = readWith(target.join('\n'), { filePath: file, mode: 'full' })
    trials += 1
    let replayed = null
    if (isDelta(receipt)) {
      deltas += 1
      replayed = applyDelta(base, receipt.text)
    } else {
      // 差量不比全文省时引擎退回全文——那时正文本身就是答案
      try {
        replayed = bodyRows(receipt.text)
      } catch (error) {
        failures += 1
        detail = `trial ${t}: ${error.message}`
        continue
      }
    }
    if (replayed.join('\n') !== target.join('\n')) {
      failures += 1
      detail = `trial ${t} (kind=${kind}): ${firstDiff(replayed.join('\n'), target.join('\n'))}`
    }
  }
  check(trials === 200, `E′1 跑满 200 次编辑-重放（其中 ${deltas} 次走差量，其余退回全文）`)
  check(failures === 0, 'E′2 200 次重放全部与目标逐字节相同（无一次漏报）', detail)
}

// ── 没被改坏的东西：既有 mode 语义与本层不存在时逐字节一致 ────────────────────
say('')
say('=== 兼容：既有 mode 语义不变，首读回执与本层不存在时逐字节一致 ===')
{
  setObservationStore()
  const src = buildSource(60)

  const firstA = readWith(src, { filePath: 'inc-compat-1.js', mode: 'full' })
  const firstB = readWith(src, { filePath: 'inc-compat-2.js', mode: 'full' })
  check(JSON.stringify(firstA) === JSON.stringify(firstB), 'K1 首次读的回执不受本层影响（两条新路径逐字节相同）')
  check(firstA.note === undefined, 'K2 首次读不多出一句说明（沉默就是答案）')

  const mapA = readWith(src, { filePath: 'inc-compat-3.js', mode: 'map' })
  const mapB = readWith(src, { filePath: 'inc-compat-3.js', mode: 'map' })
  check(mapB.mode === 'map' && mapB.text === mapA.text, 'K3 map 重复读仍是同一张地图（结构模式不参与增量）')

  const digA = readWith(src, { filePath: 'inc-compat-4.js', mode: 'digest' })
  const digB = readWith(src, { filePath: 'inc-compat-4.js', mode: 'digest' })
  check(digB.mode === 'digest' && digB.text === digA.text, 'K4 digest 重复读仍是同一份摘要')

  const linesA = readWith(src, { filePath: 'inc-compat-5.js', mode: 'lines', lines: [2, 5] })
  const linesB = readWith(src, { filePath: 'inc-compat-5.js', mode: 'lines', lines: [2, 5] })
  check(linesB.mode === 'lines' && linesB.text === linesA.text, 'K5 lines 重复读仍给那几行（定向模式不参与增量）')

  const aroundA = readWith(src, { filePath: 'inc-compat-6.js', mode: 'around', around: 'fn_19' })
  const aroundB = readWith(src, { filePath: 'inc-compat-6.js', mode: 'around', around: 'fn_19' })
  check(aroundB.mode === 'around' && aroundB.text === aroundA.text, 'K6 around 重复读仍给同一个窗口')

  const searchA = readWith(src, { filePath: 'inc-compat-7.js', mode: 'search', search: 'value_42' })
  const searchB = readWith(src, { filePath: 'inc-compat-7.js', mode: 'search', search: 'value_42' })
  check(searchB.mode === 'search' && searchB.text === searchA.text, 'K7 search 重复读仍给匹配窗口')

  const changedA = readWith(src, { filePath: 'inc-compat-8.js', mode: 'changed' })
  const changedB = readWith(src, { filePath: 'inc-compat-8.js', mode: 'changed', since: changedA.version })
  check(changedB.note === 'no change since that version', 'K8 changed 的语义没动（no change 原话不变）', `note=${changedB.note}`)

  // 逃生门：显式要求全文时必须给全文
  const forced = readWith(src, { filePath: 'inc-compat-1.js', mode: 'full', incremental: false })
  check(forced.text.includes('const value_0 = 0;') && forced.text === firstA.text, 'K9 incremental=false 是逃生门：强制全文')

  // auto 选中 full 时同样走增量，且回执仍然说明"auto 选了什么、为什么"
  const autoA = readWith(src, { filePath: 'inc-compat-9.js' })
  const autoB = readWith(src, { filePath: 'inc-compat-9.js' })
  check(autoA.mode === 'full' && /no change/.test(autoB.text), 'K10 auto→full 的重复读也走增量')
  check(autoB.auto !== undefined && autoB.mode === 'full', 'K11 增量回执仍然带着 auto 的选择理由（模型看得见工具的决定）')
}

// ── D4（2026-10-25 反馈）：截断基准 + 显式更大 budget ⇒ 必须给正文 ──────────
//
// 旧行为：首读被预算截断后，同一会话里再用更大的 `budget` 读 `full`，仍走 no-change，
// 只回一句“去用 lines 拿剩下的”（实测 401 行文件第二次只拿到 155 字符且 `truncated: false`）。
// 账本里那份是**半份**，就不能当“你已经有全文”用。
say('')
say('=== L. 截断基准 + 显式更大 budget ⇒ 给正文，不再谎报 no-change ===')
{
  const file = 'inc-d4-budget.js'
  const big = Array.from({ length: 400 }, (_, i) => `export const d4_${String(i).padStart(3, '0')} = ${i}; // padding padding padding`).join('\n') + '\n'
  const first = readWith(big, { filePath: file, mode: 'full' })
  check(first.metrics?.truncated === true, 'L1 首读被默认预算截断（truncated=true）', String(first.metrics?.truncated))
  const second = readWith(big, { filePath: file, mode: 'full', budget: 60000 })
  check(
    typeof second.text === 'string' && second.text.length > (first.text ?? '').length * 2,
    'L2 第二次给正文（而不是一句提示）',
    `chars=${(second.text ?? '').length}（首读 ${(first.text ?? '').length}）`,
  )
  check(second.metrics?.truncated === false, 'L3 第二次不再处于截断态', String(second.metrics?.truncated))
  check(!/no change since baseline/.test(second.text ?? ''), 'L4 正文不是那句 no-change 提示语', String(second.text ?? '').slice(0, 80))
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
say('')
say(`断言总数 ${results.length}，失败 ${failed.length}`)
for (const f of failed) say(`  FAIL ${f.label}  ${f.detail}`)
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
process.exit(failed.length === 0 ? 0 : 1)
