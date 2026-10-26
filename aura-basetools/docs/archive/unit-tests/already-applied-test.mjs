/**
 * already-applied-test —— fs-contract-v2 波15 / C45：**已经落地的编辑不该报“找不到”**。
 *
 * ## 命题
 *
 * 调用方的一次编辑**被中断或失败之后重试**时（本仓会话日志里 17 次「调用被记录但没有结果落盘」、
 * 111 次「事务未提交」），如果上一次其实已经写成功了，工具原先只会回一句
 * “你要改的原文不在文件里”（`PATCH_NOT_FOUND`）—— 调用方拿不到任何信息知道“它已经改好了”，
 * 于是它去重读、去改地址、去改写法，而正确答案是“这次不用改”。
 *
 * 改动后：`write-path.mjs` 的编辑路径（`applyEditToProvider`）多一条**结果态**
 * `outcome: 'already_applied'` —— “你要改的原文不在，但结果已经是你给的样子了”。
 * 判据本体是 `alreadyAppliedHits`（与 `locateByOld` 同两个匹配函数），判据的三条写在它上面。
 *
 * ## 为什么状态落在编辑路径而不是 `planHunks`
 *
 * `planHunks` 是**判据**（纯函数，抛 `PATCH_NOT_FOUND`），它照旧抛 —— 拿不到原文的调用方仍然
 * 拿到那条带「最近一带原文 + `next`」的回执（`notfound-receipt-test` 段C 钉着它）。
 * “已落地”是**编排层**的判断：只有走到“一次完整写回”的那个位置，才同时知道
 * 「原文不在」「replace 在」「一个字节都还没写」这三件事。落在这里还让“磁盘不动”变成**结构性**的
 * ——回执在 `provider.writeText` 之前返回，没有需要回滚的东西。
 *
 * ## 段（判据只增不减：每段都带**负向**对照）
 *
 *   A 真形状：已落地 ⇒ **结果通道**给 `already_applied`（不是抛错），`applied` 结构性为空，
 *     `already_applied[].actual` 可逐字核对（含 `dry_run` 那一支）
 *   B **磁盘一个字节都不许动**：`writeText` 调用数恒 0；真文件的 sha256 / 字节 / 长度逐项不变
 *   C **幂等**：先真改一次（写 1 次），随后同一份 hunk 打两次 ⇒ 两次都是 `already_applied`，
 *     写次数仍是 1，磁盘逐字节不变
 *   D **不得把真的找不到误判成已落地**（六条负向：replace 不在 / 只在行内 / 整行但多处 /
 *     低于字符下限 / old 在场 / 多 hunk 半落地 / old 歧义）—— 逐条仍抛原来的码，磁盘不变
 *   E 历史语料实证：拿 `failure-corpus.json` 里**真实条目**的重放原文打一遍（F0306 / F0040 /
 *     F0020 / F0243 命中；F0059 那条真找不到的**不**命中），并走一次真写路径确认零写入
 *   F 原契约不回退：`planHunks` 对真找不到仍抛 `PATCH_NOT_FOUND` 且带 `next`；正常编辑照旧写盘
 *
 * 「改动前必红」怎么复现（不动本仓一个文件）：把 `src` 整树拷到临时目录，
 * 只把拷贝里 `write-path.mjs` 的 `alreadyAppliedHits` 改成 `return null`（即没有这一态），
 * 再把本文件拷进去跑 —— 段A/段C/段E/段F 的“已落地”那几条当场红（工具回的是 `PATCH_NOT_FOUND`）。
 * 本单实测的变异反证见 `.polaris/workorders/fs-contract-v2.C45.result.json`。
 *
 * 跑法：`node src/locator-lab/already-applied-test.mjs`，全绿 exit 0。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { alreadyAppliedHits, applyEditToProvider, planHunks } from './write-path.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORPUS_PATH = path.join(HERE, 'failure-corpus.json')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-c45-already-'))

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const brief = (error) => (error === null ? 'null' : `${error.code ?? 'THROW'}: ${String(error.message ?? '').slice(0, 90)}`)

/** 落盘一律走**真** provider（`applyEditToProvider` 契约的四方法），并数写入次数。 */
function makeProvider(file) {
  const state = { writes: 0, version: 1 }
  const provider = {
    stat: async (target) =>
      fs.existsSync(target) ? { version: `v${state.version}`, type: 'file', size: fs.statSync(target).size } : undefined,
    readText: async (target) => fs.readFileSync(target, 'utf8'),
    readByteRange: async (target, range) => fs.readFileSync(target).subarray(range.offset, range.offset + range.length),
    writeText: async (target, content, expected) => {
      if (expected?.kind === 'replaceIfVersion' && `v${state.version}` !== expected.version) {
        throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      state.writes += 1
      fs.writeFileSync(target, content)
      state.version += 1
      return { version: `v${state.version}`, operation: 'update', after: content }
    },
  }
  return { provider, state, read: () => fs.readFileSync(file, 'utf8') }
}

/** 一条调用：返回 `{ok, out, error, writes}`（抛错不外泄，判据要看的是两者都有没有）。 */
async function attempt(text, hunks, { dryRun = false } = {}) {
  const file = path.join(TMP, `case-${results.length}-${Math.random().toString(36).slice(2, 8)}.mjs`)
  fs.writeFileSync(file, text)
  const before = sha256(fs.readFileSync(file))
  const { provider, state, read } = makeProvider(file)
  let out = null
  let error = null
  try {
    out = await applyEditToProvider(provider, { displayPath: file, hunks, dryRun })
  } catch (thrown) {
    error = thrown
  }
  return { file, out, error, writes: state.writes, before, after: sha256(fs.readFileSync(file)), read }
}

/**
 * 夹具：一份**逐行可点名**的小文件。段D 的六条负向各自要点名一行，所以每一行都不一样：
 *   · 第 2 行 —— 正常编辑的目标（`old` 在场）
 *   · 第 3 行 —— `ALPHA_MARKER` 只作为**行内片段**出现（整行层接不住它）
 *   · 第 5/6 行 —— `DUPLICATE_LINE();` 整行但**不唯一**
 *   · 第 9 行 —— `zz9` 整行唯一但只有 3 个字符（低于字符下限）
 *   · 第 7/8 行 —— `tau();` 多处（歧义那一支）
 */
const SRC = [
  'alpha',
  'const PROBE_BUDGET_MS = 1500;',
  'const ALPHA_MARKER = 1;',
  'omega',
  'DUPLICATE_LINE();',
  'DUPLICATE_LINE();',
  'tau();',
  'tau();',
  'zz9',
  'tail();',
  '',
].join('\n')

// ════════════════════════════════════════════════════════════════════════════
say('=== 段A：已落地 ⇒ 结果通道（不是抛错），字段可逐字核对 ===')
{
  const LANDED = SRC.replace('const PROBE_BUDGET_MS = 1500;', 'const PROBE_BUDGET_MS = 3000;')
  const a1 = await attempt(LANDED, [{ old: 'const PROBE_BUDGET_MS = 1500;', replace: 'const PROBE_BUDGET_MS = 3000;' }])
  check(
    a1.error === null && a1.out?.outcome === 'already_applied',
    'A1 重试一次已经落地的编辑 ⇒ 正常结果 outcome=already_applied（不是 PATCH_NOT_FOUND）',
    a1.error === null ? `outcome=${a1.out.outcome}` : brief(a1.error),
  )
  check(
    Array.isArray(a1.out?.applied) && a1.out.applied.length === 0,
    'A2 `applied` 结构性为空数组（“一个 hunk 都没落盘”不必解析文本就能看出）',
    JSON.stringify(a1.out?.applied),
  )
  const hit = a1.out?.already_applied?.[0]
  check(
    hit !== undefined && hit.line === 2 && hit.actual === 'const PROBE_BUDGET_MS = 3000;' && hit.replaced === 'const PROBE_BUDGET_MS = 3000;',
    'A3 回执那一项可逐字核对（line / actual / replaced 都是文件里的原文）',
    JSON.stringify(hit),
  )
  check(
    typeof hit?.tier === 'string' && hit.tier.startsWith('already-applied'),
    'A4 tier 明写这是哪一态（`already-applied~<匹配级>`，不新造顶层字段）',
    String(hit?.tier),
  )
  check(a1.out?.unchanged === true, 'A5 回执里写死“磁盘没动”这一条事实（unchanged）', String(a1.out?.unchanged))

  const a6 = await attempt(LANDED, [{ old: 'const PROBE_BUDGET_MS = 1500;', replace: 'const PROBE_BUDGET_MS = 3000;' }], { dryRun: true })
  check(
    a6.error === null && a6.out?.outcome === 'already_applied' && a6.out.dryRun === true,
    'A7 dry_run 也报这一态（预演与真写判同一个事实）',
    a6.error === null ? `dryRun=${a6.out.dryRun}` : brief(a6.error),
  )
}

say('')
say('=== 段B：磁盘一个字节都不许动 ===')
{
  const LANDED = SRC.replace('const PROBE_BUDGET_MS = 1500;', 'const PROBE_BUDGET_MS = 3000;')
  const b = await attempt(LANDED, [{ old: 'const PROBE_BUDGET_MS = 1500;', replace: 'const PROBE_BUDGET_MS = 3000;' }])
  check(b.writes === 0, 'B1 writeText 调用数 = 0（回执在写之前返回，没有需要回滚的东西）', `writes=${b.writes}`)
  check(b.before === b.after, 'B2 真文件 sha256 前后相同', `${b.before.slice(0, 12)} → ${b.after.slice(0, 12)}`)
  check(b.read() === LANDED, 'B3 逐字节相同（sha256 之外再看一次内容）', `${b.read().length}B`)
}

say('')
say('=== 段C：重复应用同一编辑必须幂等 ===')
{
  const c = await attempt(SRC, [{ old: 'const PROBE_BUDGET_MS = 1500;', replace: 'const PROBE_BUDGET_MS = 3000;' }])
  const LANDED = SRC.replace('const PROBE_BUDGET_MS = 1500;', 'const PROBE_BUDGET_MS = 3000;')
  check(
    c.error === null && c.out?.outcome === undefined && c.out.applied.length === 1 && c.writes === 1 && c.read() === LANDED,
    'C1 第一次（原文在场）⇒ 真写一次，走的是原来的成功路径',
    c.error === null ? `applied=${c.out.applied.length} writes=${c.writes}` : brief(c.error),
  )
  const again = async () => {
    const { provider, state, read } = makeProvider(c.file)
    let out = null
    let error = null
    try {
      out = await applyEditToProvider(provider, {
        displayPath: c.file,
        hunks: [{ old: 'const PROBE_BUDGET_MS = 1500;', replace: 'const PROBE_BUDGET_MS = 3000;' }],
      })
    } catch (thrown) {
      error = thrown
    }
    return { out, error, writes: state.writes, text: read() }
  }
  const c2 = await again()
  check(
    c2.error === null && c2.out?.outcome === 'already_applied' && c2.writes === 0 && c2.text === LANDED,
    'C2 同一份 hunk 再打一次 ⇒ already_applied，写 0 次，磁盘逐字节不变',
    c2.error === null ? `writes=${c2.writes}` : brief(c2.error),
  )
  const c3 = await again()
  check(
    c3.error === null && c3.out?.outcome === 'already_applied' && c3.writes === 0 && c3.text === LANDED,
    'C3 第三次同打 ⇒ 仍是 already_applied（不是“第一次之后就不认了”）',
    c3.error === null ? `writes=${c3.writes}` : brief(c3.error),
  )
}

say('')
say('=== 段D：不得把真的找不到误判成已落地（六条负向） ===')
{
  const LANDED = SRC.replace('const PROBE_BUDGET_MS = 1500;', 'const PROBE_BUDGET_MS = 3000;')

  const d1 = await attempt(LANDED, [{ old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'ALSO-NOT-IN-THIS-FILE-AT-ALL' }])
  check(
    d1.error?.code === 'PATCH_NOT_FOUND' && d1.out === null && d1.writes === 0,
    'D1 replace 也不在 ⇒ 仍抛 PATCH_NOT_FOUND（真找不到就是真找不到）',
    brief(d1.error),
  )

  const d2 = await attempt(LANDED, [{ old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'ALPHA_MARKER' }])
  check(
    d2.error?.code === 'PATCH_NOT_FOUND' && d2.out === null,
    'D2 replace 只在**行内片段**里出现（`ALPHA_MARKER` 是第 3 行的一截，12 字符够长）⇒ 不判已落地（不许用片段层接住它）',
    brief(d2.error),
  )

  const d3 = await attempt(LANDED, [{ old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'DUPLICATE_LINE();' }])
  check(
    d3.error?.code === 'PATCH_NOT_FOUND' && d3.out === null,
    'D3 replace 是整行但**不唯一**（`DUPLICATE_LINE();` 出现两次）⇒ 不判已落地（与 `old` 被应用时同一道唯一性门槛）',
    brief(d3.error),
  )

  const d4 = await attempt(LANDED, [{ old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'zz9' }])
  check(
    d4.error?.code === 'PATCH_NOT_FOUND' && d4.out === null,
    'D4 replace 整行唯一、但只有 3 个非空白字符 ⇒ 不判已落地（“文件里恰好有一行是 `zz9`”不是证据）',
    brief(d4.error),
  )

  const d5 = await attempt(SRC, [{ old: 'const PROBE_BUDGET_MS = 1500;', replace: 'const PROBE_BUDGET_MS = 3000;' }])
  check(
    d5.error === null && d5.out?.outcome !== 'already_applied' && d5.writes === 1,
    'D5 `old` 在场（正常编辑）⇒ 不是这一态，照旧真写一次',
    d5.error === null ? `writes=${d5.writes}` : brief(d5.error),
  )

  const d6 = await attempt(LANDED, [
    { old: 'const PROBE_BUDGET_MS = 1500;', replace: 'const PROBE_BUDGET_MS = 3000;' },
    { old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'ALSO-NOT-IN-THIS-FILE-AT-ALL' },
  ])
  check(
    d6.error?.code === 'PATCH_NOT_FOUND' && d6.out === null && d6.writes === 0,
    'D6 多 hunk 半落地（一条已落地、一条真找不到）⇒ 仍抛 PATCH_NOT_FOUND（这次编辑**没有**全部落地）',
    brief(d6.error),
  )

  const d7 = await attempt(LANDED, [{ old: 'tau();', replace: 'TAU();' }])
  check(
    d7.error?.code === 'PATCH_AMBIGUOUS' && d7.out === null,
    'D7 `old` 在文件里多处（歧义）⇒ 仍是 PATCH_AMBIGUOUS，不被这一态盖住',
    brief(d7.error),
  )
  check(
    [d1, d2, d3, d4, d6, d7].every((r) => r.writes === 0 && r.before === r.after),
    'D8 六条负向路径磁盘逐字节不变（拒绝照旧，一个字节都没写）',
    [d1, d2, d3, d4, d6, d7].map((r) => r.writes).join(','),
  )
}

say('')
say('=== 段E：历史语料实证（failure-corpus.json 只读） ===')
{
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'))
  const entryOf = (id) => corpus.entries.find((e) => e.id === id)
  const shapeOf = (id) => {
    const entry = entryOf(id)
    const focus = entry.hunks?.[entry.focus ?? 0] ?? null
    return { entry, content: entry.source.text, hunks: [{ old: entry.quote?.text ?? '', replace: typeof focus?.replace === 'string' ? focus.replace : '' }] }
  }
  const landed = ['F0306', 'F0040', 'F0020', 'F0243']
  const evidence = []
  let allHit = true
  for (const id of landed) {
    const { entry, content, hunks } = shapeOf(id)
    const hits = alreadyAppliedHits(content, hunks)
    const hit = hits?.[0] ?? null
    // 逐字核对：回执里的 `actual` 必须是**条目自己那份原文**里从 hit.line 开始的那几行。
    // 行切法照抄引擎那一把尺子（`addressRows`：行尾按 LF 归一，末尾那个空元素不参与）——
    // 语料里 `replace` 带结尾换行是常态，少这一句就会把 2 行当成 3 行去比。
    const lines = content.split('\n')
    const rows = hunks[0].replace.replace(/\r\n/g, '\n').split('\n')
    if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
    const verbatim = hit !== null && lines.slice(hit.line - 1, hit.line - 1 + rows.length).join('\n') === hit.actual
    // `actual` 比的是**按行切出来的那几行**（`replace` 末尾那个换行不属于任何一行，不参与比较；
    // 回执里的 `replaced` 才是调用方原样给的那份，含它自己的行尾）。
    const ok = hit !== null && hit.actual === rows.join('\n') && verbatim
    if (!ok) allHit = false
    evidence.push(`${id}${ok ? '✓' : '✗'}(line ${hit?.line ?? '-'})`)
  }
  check(allHit, 'E1 四条真实条目判为已落地，且回执里的 actual 与语料原文**逐字**一致', evidence.join(' '))

  const e2 = shapeOf('F0059')
  check(
    alreadyAppliedHits(e2.content, e2.hunks) === null,
    'E2 反面：真找不到的那条（F0059，最长逐字连续 22/32 行）**不**判已落地',
    `hits=${JSON.stringify(alreadyAppliedHits(e2.content, e2.hunks))}`,
  )

  const e3 = shapeOf('F0306')
  const attempt3 = await attempt(e3.content, e3.hunks)
  check(
    attempt3.error === null && attempt3.out?.outcome === 'already_applied' && attempt3.writes === 0 && attempt3.before === attempt3.after,
    'E3 真实条目走一次真写路径 ⇒ already_applied，且磁盘 sha256 不变、零写入',
    attempt3.error === null ? `line=${attempt3.out.already_applied[0].line} writes=${attempt3.writes}` : brief(attempt3.error),
  )
}

say('')
say('=== 段F：原契约不回退（拒绝照旧 / 成功路径照旧） ===')
{
  const f1 = await attempt(SRC, [{ old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'ALSO-NOT-IN-THIS-FILE-AT-ALL' }])
  check(
    f1.error?.code === 'PATCH_NOT_FOUND' && typeof f1.error?.next === 'string' && f1.error.next.length > 0,
    'F1 真找不到仍抛 PATCH_NOT_FOUND，且回执里的 `next` 还在（“找不到”那条出路没有被削弱）',
    f1.error === null ? 'null' : `next=${String(f1.error.next).slice(0, 40)}`,
  )
  let direct = null
  try {
    planHunks(SRC, [{ old: 'zzz-nowhere-zzz-not-in-this-file', replace: 'ALSO-NOT-IN-THIS-FILE-AT-ALL' }], 'x.mjs')
  } catch (error) {
    direct = error
  }
  check(
    direct?.code === 'PATCH_NOT_FOUND',
    'F2 判据层（`planHunks`）对真找不到**照旧抛错** —— 这一态是第二条出路，不是对它的放宽',
    brief(direct),
  )
  const f3 = await attempt(SRC, [{ old: 'alpha', replace: 'ALPHA' }])
  check(
    f3.error === null && f3.out?.applied?.length === 1 && f3.read() === SRC.replace('alpha', 'ALPHA'),
    'F3 正常编辑（原文在场）仍然真写一次、磁盘真的变了（成功路径一个字没动）',
    f3.error === null ? `writes=${f3.writes}` : brief(f3.error),
  )
  const f4 = alreadyAppliedHits(SRC, [{ replace: 'tail();' }])
  check(f4 === null, 'F4 没有 `old` 可言的 hunk（坐标/线索档）不参与这一态', JSON.stringify(f4))
}

// ════════════════════════════════════════════════════════════════════════════
fs.rmSync(TMP, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  ✗ ${f.label}  ${f.detail}`)
  process.exitCode = 1
}
