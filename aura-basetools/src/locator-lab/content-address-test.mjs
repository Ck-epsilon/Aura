/**
 * content-address-test —— 内容寻址（fs-contract-v2 / C2）：hunk 以 `old`（＋可选 `context`）为地址。
 *
 * ## 命题（施工单终态，判据不可改）
 *
 *   · `old` 是要替换的原文 ⇒ 它是**主地址**；`context` 是消歧用的额外原文；
 *   · 坐标（`lines` / `start_line` / `end_line`）**从契约降为提示**：与 `old` 冲突时以 `old` 为准，
 *     回执里必须说明“坐标与原文不符，已按原文定位”；
 *   · 不唯一时先**自动扩大上下文重试一次**，仍不唯一 ⇒ 候选清单（各自行号 + 原文），
 *     且**磁盘一个字节都不变**。
 *
 * ## 为什么坐标不能当歧义裁决者（本测试 G 段钉住）
 *
 * “坐标只是提示”有两种读法：①只用来核对与披露；②歧义时按坐标就近挑一个。
 * 这里实现并钉住的是 ①。理由与 `anchor-core` 的 `pickNear` 一致：`near` 是调用方**显式**给的
 * 提示，**等距一律不猜**；而一串从上一版视图里抄来的坐标并不比 `old` 更知道“你想改的是哪一个”，
 * 让它当裁决者就退回内置 `edit` 的“多处匹配静默取第一个”——那正是本工具存在的理由。
 * 代价是明摆着的：`{old 重复两次, lines 指向其中一个}` 会**拒绝**而不是“顺手改那个”。
 *
 * ## 五段判据 + 三段自加
 *
 *   A 不给坐标、只给 `old` ⇒ 改中（含空白降级层：`old` 少写缩进也能中）
 *   B `old` 两次、靠 `context` 收敛到一次 ⇒ 改中（context 在上 / 在下 / 自身含 old 三种写法）
 *   C `old` 两次且 `context` 无法收敛 ⇒ 结构化拒绝 + 候选清单 + 磁盘**逐字节**不变
 *   D 给了坐标但坐标处的原文不是 `old` ⇒ 以 `old` 为准改中，回执里说明
 *   E `old` 在文件里根本不存在 ⇒ 拒绝 + 磁盘不变（负向不变量）；另一例是 `old` 只落在**行中间**
 *     （C13）⇒ 只换命中跨度、行内其余字节逐字不动，回执写明起止列
 *   F 写路径三样守卫在 `old` 地址下仍然生效：版本守 / 字节保真 / 落盘后回读校验
 *   G 自动扩大上下文的能救与不能救（“不猜”是判据的一部分）
 *
 * 落盘一律走 `applyEditToProvider`（CLI/MCP 与 DSH 壳共用的那条写路径），
 * 所以 F 段量的是**真**守卫，不是测试自己编的一套。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyEditToProvider, planHunks } from './write-path.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const TMP = path.join(os.tmpdir(), `content-address-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

const encode = (text) => new TextEncoder().encode(text)
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const readBytes = (file) => fs.readFileSync(file)
const readTextFile = (file) => decode(readBytes(file))
const writeFile = (file, text) => fs.writeFileSync(file, Buffer.from(encode(text)))
const fsError = (message, code) => Object.assign(new Error(message), { code })
/** 失败的简短说法；`error` 缺席（本该失败却成功了）也要能打印，不能自己抛错。 */
const brief = (error) =>
  error === null || error === undefined
    ? 'no error (这次没有拒绝)'
    : `${error.code ?? '?'} ${String(error.message ?? error).slice(0, 140)}`

/**
 * 与真提供方同形的文件提供方：`readByteRange` 给原始字节，`writeText` 逐字节写 + 版本 CAS
 * （形状照抄 `write-verify-test` / `stale-gate-test` 的 mock；mock 与真件不同形就等于没测）。
 *
 * 额外两个门：`thirdParty()` = 第三方改写（内容换掉 + 版本前进）；
 * `mutateAfterNextRead()` = 把第三方写入塞进“读完之后、落盘之前”那个时间窗（版本守的靶子）。
 */
function makeProvider() {
  let version = 1
  let afterRead = null
  /** 这个提供方服务的那个文件（每例一个新建文件，`bind` 时绑上）。 */
  let bound = null
  const provider = {
    stat: async (target) =>
      fs.existsSync(target) ? { version: `v${version}`, type: 'file', size: fs.statSync(target).size } : undefined,
    readText: async (target) => {
      if (!fs.existsSync(target)) throw fsError(`cannot read "${target}": not found`, 'FS_NOT_FOUND')
      const text = readTextFile(target)
      const hook = afterRead
      afterRead = null
      if (hook !== null) hook()
      return text
    },
    readByteRange: async (target, range) => {
      if (!fs.existsSync(target)) throw fsError(`cannot read "${target}": not found`, 'FS_NOT_FOUND')
      return readBytes(target).subarray(range.offset, range.offset + range.length)
    },
    writeText: async (target, content, expected) => {
      if (expected?.kind === 'replaceIfVersion' && `v${version}` !== expected.version) {
        throw fsError('file changed since it was read', 'FS_STALE_VERSION')
      }
      writeFile(target, content)
      version += 1
      return { version: `v${version}`, operation: 'update', after: content }
    },
    thirdParty(text) {
      writeFile(bound, text)
      version += 1
    },
    mutateAfterNextRead(text) {
      afterRead = () => provider.thirdParty(text)
    },
  }
  provider.bind = (file) => {
    bound = file
    return provider
  }
  return provider
}

/** 新建一个用例：文件 + 提供方 + 一个能跑写路径的句柄。 */
let caseSeq = 0
const fresh = (name, text) => {
  caseSeq += 1
  const file = path.join(TMP, `${caseSeq}-${name}`)
  writeFile(file, text)
  const provider = makeProvider().bind(file)
  return { file, provider, text }
}

/** 跑一次真写路径：成功返回回执，失败返回错误（**绝不吞**）。 */
const attempt = async (subject, hunks) => {
  try {
    return { ok: true, out: await applyEditToProvider(subject.provider, { displayPath: subject.file, hunks }) }
  } catch (error) {
    return { ok: false, error }
  }
}

/** 只跑规划（纯函数）：用来钉“抛错就没东西可落盘”与 matches 上的结构化字段。 */
const planOf = (text, hunks, file = 'probe.js') => {
  try {
    return { ok: true, planned: planHunks(text, hunks, file) }
  } catch (error) {
    return { ok: false, error }
  }
}

// ── 段A：只给 old（不给任何坐标）⇒ 改中 ──────────────────────────────────────
say('=== A. 只给 old（没有坐标）⇒ 以原文定位 ===')
const A_SRC = 'const alpha = 1\nconst beta = 2\nconst gamma = 3\n'
const A_WANT = 'const alpha = 1\nconst beta = 42\nconst gamma = 3\n'
{
  const c = fresh('a-plain.js', A_SRC)
  const r = await attempt(c, [{ old: 'const beta = 2', replace: 'const beta = 42' }])
  check(r.ok, 'A 只给 old ⇒ 改中', r.ok ? '' : brief(r.error))
  check(r.ok && r.out.applied.length === 1 && r.out.applied[0].line === 2, 'A 落点 = 原文所在那一行（line 2）', r.ok ? `line ${r.out.applied[0]?.line}` : brief(r.error))
  check(r.ok && r.out.applied[0].tier === 'old', 'A tier = old（原文自己就唯一）', r.ok ? `tier=${r.out.applied[0]?.tier}` : '')
  check(
    r.ok && r.out.applied[0].actual === 'const beta = 2' && r.out.applied[0].replaced === 'const beta = 42',
    'A 回执给出改前原文与被替换后的文本',
    r.ok ? `${JSON.stringify(r.out.applied[0]?.actual)} → ${JSON.stringify(r.out.applied[0]?.replaced)}` : '',
  )
  check(readTextFile(c.file) === A_WANT, 'A 磁盘内容正确（其余行一字未动）', readTextFile(c.file) === A_WANT ? '' : JSON.stringify(readTextFile(c.file)))
  check(
    r.ok && r.out.write_verify?.level === 'bytes' && r.out.write_verify.bytes === Buffer.byteLength(A_WANT),
    'A 落盘后回读校验按字节比对（write_verify.level = bytes）',
    r.ok ? JSON.stringify(r.out.write_verify) : '',
  )
  check(
    r.ok && r.out.unverified_region === true,
    'A 这份文件没被观测过 ⇒ 如实标注 unverified_region（“没核对过”不冒充“核对过”）',
    r.ok ? JSON.stringify(r.out.unverified_region) : '',
  )
}

// ── 段A2：old 少写了缩进 —— 空白折叠层仍然算“原文在” ────────────────────────
say('')
say('=== A2. old 与文件的空白不同 ⇒ 降级到 norm-space 层，仍然只改被寻址的那一行 ===')
{
  const c = fresh('a2-space.js', 'function f() {\n    return 1\n}\n')
  const r = await attempt(c, [{ old: 'return 1', replace: '  return 2' }])
  check(r.ok && r.out.applied[0].tier === 'old~norm-space', 'A2 tier = old~norm-space（空白折叠层）', r.ok ? `tier=${r.out.applied[0]?.tier}` : brief(r.error))
  check(r.ok && r.out.applied[0].line === 2 && r.out.applied[0].actual === '    return 1', 'A2 落点与回执里的“实际原文”都取文件那一行', r.ok ? `${r.out.applied[0]?.line} ${JSON.stringify(r.out.applied[0]?.actual)}` : '')
  check(readTextFile(c.file) === 'function f() {\n  return 2\n}\n', 'A2 磁盘 = 只换那一行', JSON.stringify(readTextFile(c.file)))
}

// ── 段A3：old 与 target 同时在场 ⇒ old 是主地址（不跟到符号层）──────────────
say('')
say('=== A3. old 与 target 冲突 ⇒ 以 old 为准（它是主地址）===')
{
  const c = fresh('a3-old-vs-target.js', 'function alpha() {\n  return 1\n}\n\nfunction beta() {\n  return 2\n}\n')
  const r = await attempt(c, [{ old: '  return 2', target: 'alpha', replace: '  return 22' }])
  check(r.ok && r.out.applied[0].line === 6 && r.out.applied[0].tier === 'old', 'A3 old 说第 6 行、target=alpha 说整个 alpha ⇒ 按 old 改第 6 行', r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : brief(r.error))
  check(readTextFile(c.file) === 'function alpha() {\n  return 1\n}\n\nfunction beta() {\n  return 22\n}\n', 'A3 磁盘：alpha 一字未动', JSON.stringify(readTextFile(c.file)))
}

// ── 段B：old 两次，靠 context 收敛到一次 ⇒ 改中 ──────────────────────────────
say('')
say('=== B. old 出现两次、context 收敛到一次 ⇒ 改中 ===')
const B_SRC = 'function alpha() {\n  return shared\n}\n\nfunction beta() {\n  return shared\n}\n'
const B_WANT = 'function alpha() {\n  return shared\n}\n\nfunction beta() {\n  return 7\n}\n'
{
  const c = fresh('b-context-above.js', B_SRC)
  const r = await attempt(c, [{ old: '  return shared', context: 'function beta() {', replace: '  return 7' }])
  check(r.ok, 'B context 在 old 正上方 ⇒ 改中', r.ok ? '' : brief(r.error))
  check(r.ok && r.out.applied[0].line === 6 && r.out.applied[0].tier === 'old+context', 'B 落点 = 第 6 行（第二次出现），tier = old+context', r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : '')
  check(readTextFile(c.file) === B_WANT, 'B 磁盘：第 2 行一字未动、第 6 行被换', JSON.stringify(readTextFile(c.file)))
}
{
  const c = fresh('b-context-below.js', 'const dup = 1\nconst tail = 2\nconst dup = 1\nconst tail = 3\n')
  const r = await attempt(c, [{ old: 'const dup = 1', context: 'const tail = 3', replace: 'const dup = 9' }])
  check(r.ok && r.out.applied[0].line === 3, 'B context 在 old 正下方 ⇒ 收敛到第 3 行', r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : brief(r.error))
  check(readTextFile(c.file) === 'const dup = 1\nconst tail = 2\nconst dup = 9\nconst tail = 3\n', 'B（下方）磁盘正确', JSON.stringify(readTextFile(c.file)))
}
{
  const c = fresh('b-context-contains.js', 'a1\nold line\na2\nb1\nold line\nb2\n')
  const r = await attempt(c, [{ old: 'old line', context: 'b1\nold line\nb2', replace: 'NEW' }])
  check(r.ok && r.out.applied[0].line === 5, 'B context 自身包含 old ⇒ 收敛到第 5 行', r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : brief(r.error))
  check(readTextFile(c.file) === 'a1\nold line\na2\nb1\nNEW\nb2\n', 'B（包含）磁盘正确', JSON.stringify(readTextFile(c.file)))
}

// ── 段C：old 两次且 context 收敛不了 ⇒ 候选清单 + 磁盘逐字节不变 ─────────────
say('')
say('=== C. old 两次、context 收敛不了 ⇒ 结构化拒绝 + 候选清单 + 磁盘逐字节不变 ===')
const C_SRC = 'const a = 1\nconst dup = 2\nconst b = 3\nconst a = 1\nconst dup = 2\nconst b = 3\n'
const C_HUNK = { old: 'const dup = 2', context: 'this text is nowhere in this file at all', replace: 'const dup = 99' }
{
  const c = fresh('c-ambiguous.js', C_SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [C_HUNK])
  check(!r.ok, 'C 收敛不到一个 ⇒ 拒绝（exit 非 0 / 结构化拒绝）', r.ok ? '竟然改中了' : brief(r.error))
  check(!r.ok && r.error.code === 'PATCH_AMBIGUOUS', 'C 错误码 = PATCH_AMBIGUOUS', brief(r.error))
  const candidates = r.ok ? [] : (r.error.candidates ?? [])
  check(
    candidates.length === 2 && candidates[0].line === 2 && candidates[1].line === 5 && candidates[0].endLine === 2 && candidates[1].endLine === 5,
    'C 候选清单含各自行号（line 2 / line 5）',
    JSON.stringify(candidates.map((x) => [x.line, x.endLine])),
  )
  check(
    candidates.every((x) => x.text === 'const dup = 2'),
    'C 候选清单含各自原文',
    JSON.stringify(candidates.map((x) => x.text)),
  )
  const message = r.ok ? '' : String(r.error.message)
  check(
    /line 2\b/.test(message) && /line 5\b/.test(message) && message.includes('const dup = 2') && /context/.test(message),
    'C 候选写进了 message（框架只读 error.message，字段读不到）',
    message.slice(0, 200),
  )
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'C 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
  check(readTextFile(c.file) === C_SRC, 'C 磁盘仍是原文（没有 dup = 99）', JSON.stringify(readTextFile(c.file)))
  const pure = planOf(C_SRC, [C_HUNK], 'c.js')
  check(!pure.ok && pure.error.code === 'PATCH_AMBIGUOUS' && pure.planned === undefined, 'C planHunks（纯函数）抛错 ⇒ 调用方拿不到任何可落盘的内容')
}

// ── 段D：坐标与原文不符 ⇒ 以 old 为准 + 回执说明 ─────────────────────────────
say('')
say('=== D. 坐标处的原文不是 old ⇒ 以 old 为准，并在回执里说明 ===')
const D_SRC = 'one\ntwo\nthree\nfour\nfive\n'
const NOTE = /coordinates lines (\d+)-(\d+) do not hold this old text — addressed by old at line (\d+)/
{
  const c = fresh('d-coord-conflict.js', D_SRC)
  const r = await attempt(c, [{ old: 'four', lines: [2, 3], replace: 'FOUR' }])
  check(r.ok, 'D 坐标（2-3）与 old 不符 ⇒ 仍然改中', r.ok ? '' : brief(r.error))
  check(r.ok && r.out.applied[0].line === 4, 'D 落点 = old 所在那一行（line 4），不是坐标指的 2-3', r.ok ? `line ${r.out.applied[0]?.line}` : '')
  const tier = r.ok ? String(r.out.applied[0].tier) : ''
  check(NOTE.test(tier) && tier.includes('addressed by old at line 4'), 'D 回执（applied[].tier）说明“坐标与原文不符，已按原文定位”', tier)
  check(readTextFile(c.file) === 'one\ntwo\nthree\nFOUR\nfive\n', 'D 磁盘：只有第 4 行被换（2-3 行一字未动）', JSON.stringify(readTextFile(c.file)))

  const pure = planOf(D_SRC, [{ old: 'four', lines: [2, 3], replace: 'FOUR' }], 'd.js')
  check(
    pure.ok && pure.planned.matches[0].coordinateNote !== undefined && JSON.stringify(pure.planned.matches[0].coordinateConflict) === '{"given":[2,3],"actual":[4,4]}',
    'D matches 上有结构化记录（coordinateNote / coordinateConflict）',
    pure.ok ? JSON.stringify(pure.planned.matches[0].coordinateConflict) : brief(pure.error),
  )
}
{
  const c = fresh('d-coord-out-of-range.js', 'one\ntwo\nthree\n')
  const r = await attempt(c, [{ old: 'two', lines: [999, 1000], replace: 'TWO' }])
  check(r.ok && r.out.applied[0].line === 2, 'D 坐标越界（999-1000）也不再是拒绝理由：原文说了算', r.ok ? `line ${r.out.applied[0]?.line}` : brief(r.error))
  check(NOTE.test(String(r.ok ? r.out.applied[0].tier : '')), 'D 越界坐标同样如实披露（不静默忽略）', r.ok ? String(r.out.applied[0].tier) : '')
  check(readTextFile(c.file) === 'one\nTWO\nthree\n', 'D（越界）磁盘正确', JSON.stringify(readTextFile(c.file)))
}
{
  const c = fresh('d-coord-agree.js', 'one\ntwo\nthree\n')
  const r = await attempt(c, [{ old: 'three', lines: [3, 3], replace: 'THREE' }])
  check(r.ok && r.out.applied[0].tier === 'old' && !NOTE.test(String(r.out.applied[0].tier)), 'D 坐标与落点一致时不加说明（不加噪音，避免“狼来了”）', r.ok ? String(r.out.applied[0].tier) : brief(r.error))
}
{
  const c = fresh('d-start-end-line.js', 'one\ntwo\nthree\nfour\nfive\n')
  const r = await attempt(c, [{ old: 'five', start_line: 1, end_line: 1, replace: 'FIVE' }])
  check(r.ok && r.out.applied[0].line === 5 && NOTE.test(String(r.out.applied[0].tier)), 'D start_line/end_line 形状的坐标同样降为提示（含披露）', r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : brief(r.error))
  check(readTextFile(c.file) === 'one\ntwo\nthree\nfour\nFIVE\n', 'D（start_line）磁盘正确', JSON.stringify(readTextFile(c.file)))
}

// ── 段E：old 不存在 ⇒ 拒绝 + 磁盘不变（负向不变量）───────────────────────────
say('')
say('=== E. old 在文件里根本不存在 ⇒ 拒绝且磁盘不变（坐标救不了它）===')
{
  const c = fresh('e-absent.js', 'alpha\nbravo\ncharlie\n')
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'delta', lines: [2, 2], replace: 'DELTA' }])
  check(!r.ok && r.error.code === 'PATCH_NOT_FOUND', 'E old 不存在 ⇒ 拒绝（PATCH_NOT_FOUND）', brief(r.error))
  check(!r.ok && /old text/.test(String(r.error.message)) && /Coordinates are only a hint/.test(String(r.error.message)), 'E 拒绝理由说清“原文才是地址、坐标只是提示”', String(r.ok ? '' : r.error.message).slice(0, 200))
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'E 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
  check(readTextFile(c.file) === 'alpha\nbravo\ncharlie\n', 'E 磁盘仍是原文（第 2 行没有被坐标改掉）', JSON.stringify(readTextFile(c.file)))
}
{
  /**
   * `old` 落在行中间（不是整行）——**C13 口径**：命中的那一段被替换，行内其余字节逐字不动。
   *
   * 这一段曾经钉的是相反的口径（“old 只落在行中间 ⇒ 拒绝，整行对齐是硬要求”）。反转的理由是
   * 实测出来的静默失效：那个口径下 `{old:"x = 1", replace:"x = 2"}` 打在 `const x = 1` 上，
   * 磁盘变成 `x = 2`——`const ` 被静默吞掉，调用方拿到的是“改成了”而结果不是它要的。
   * 现在钉三件事：**只换命中跨度**、**回执说清换的是哪一段**、**不唯一仍拒绝**。
   */
  const c = fresh('e-inside-line.js', 'const x = 1\n')
  const r = await attempt(c, [{ old: 'x = 1', replace: 'x = 2' }])
  check(
    r.ok && r.out.applied[0].actual === 'x = 1',
    'E2 行内片段 ⇒ 改中，且回执的 actual 就是**被替换的那一段**（不是整行）',
    r.ok ? `line ${r.out.applied[0]?.line} actual=${JSON.stringify(r.out.applied[0]?.actual)}` : brief(r.error),
  )
  check(
    r.ok && /inside line 1/.test(String(r.out.applied[0].tier)) && /columns 7-11/.test(String(r.out.applied[0].tier)),
    'E2 回执说清替换范围（第 1 行第 7-11 列），调用方能核对',
    r.ok ? String(r.out.applied[0].tier) : '',
  )
  check(readTextFile(c.file) === 'const x = 2\n', 'E2 磁盘：只换命中跨度，行内的 `const ` 逐字不动', JSON.stringify(readTextFile(c.file)))
}

// ── 段F：写路径三样守卫在 old 地址下仍然生效 ────────────────────────────────
say('')
say('=== F. 版本守 / 字节保真 / 回读校验在 old 地址下仍然生效（不许绕过）===')
{
  const c = fresh('f-stale-version.js', 'one\ntwo\nthree\n')
  const before = readBytes(c.file)
  c.provider.mutateAfterNextRead('THIRD PARTY WROTE THIS\n')
  const r = await attempt(c, [{ old: 'two', replace: 'TWO' }])
  check(!r.ok && r.error.code === 'FS_STALE_VERSION', 'F1 读后被第三方改过 ⇒ 版本守拒绝（old 地址不能绕过它）', brief(r.error))
  check(Buffer.compare(before, readBytes(c.file)) !== 0 && readTextFile(c.file) === 'THIRD PARTY WROTE THIS\n', 'F1 磁盘是第三方那一版（本工具一个字节都没写）', JSON.stringify(readTextFile(c.file)))
}
{
  const c = fresh('f-byte-fidelity.js', 'alpha\r\nbravo\ncharlie\r\n')
  const r = await attempt(c, [{ old: 'bravo', replace: 'BRAVO' }])
  check(r.ok, 'F2 混合行尾文件 + old 用 LF 写法 ⇒ 改中', r.ok ? '' : brief(r.error))
  check(
    Buffer.compare(readBytes(c.file), Buffer.from(encode('alpha\r\nBRAVO\ncharlie\r\n'))) === 0,
    'F2 字节保真：只换被寻址那一行，非目标行行尾（CRLF/LF 混用）逐字节不变',
    JSON.stringify(readTextFile(c.file)),
  )
}
{
  const c = fresh('f-gate-drift.js', 'one\ntwo\nthree\n')
  const first = await attempt(c, [{ old: 'three', replace: 'THREE' }])
  check(first.ok, 'F3 前置：第一次 old 编辑成功（并因此记账成一次观测）', first.ok ? '' : brief(first.error))
  c.provider.thirdParty('new1\nnew2\none\ntwo\nTHREE\n')
  const r = await attempt(c, [{ old: 'THREE', lines: [3, 3], replace: 'THREE!' }])
  check(r.ok, 'F3 观测后第三方在头部插了两行 ⇒ 内容地址仍改中（坐标只是提示，位移正是它该吸收的）', r.ok ? '' : brief(r.error))
  check(r.ok && r.out.applied[0].line === 5, 'F3 落点 = 原文现在所在的行（line 5）', r.ok ? `line ${r.out.applied[0]?.line}` : '')
  check(readTextFile(c.file) === 'new1\nnew2\none\ntwo\nTHREE!\n', 'F3 磁盘正确', JSON.stringify(readTextFile(c.file)))
  check(r.ok && r.out.unverified_region === true, 'F3 这一版没被观测过 ⇒ 如实标注 unverified_region（不冒充“核对过”）', r.ok ? JSON.stringify(r.out.unverified_region) : '')
}
{
  const c = fresh('f-gate-changed.js', 'one\ntwo\nthree\n')
  await attempt(c, [{ old: 'two', replace: 'TWO' }])
  c.provider.thirdParty('one\nGONE\nthree\n')
  const r = await attempt(c, [{ old: 'TWO', replace: 'TWO2' }])
  check(
    !r.ok && (r.error.code === 'PATCH_NOT_FOUND' || r.error.code === 'PATCH_STALE_REGION'),
    'F4 被寻址的原文已被第三方改掉 ⇒ 拒绝（拒绝形态两种都算：定位不到 / 闸门判定）',
    brief(r.error),
  )
  check(readTextFile(c.file) === 'one\nGONE\nthree\n', 'F4 拒绝时磁盘是第三方那一版（没有覆盖回去）', JSON.stringify(readTextFile(c.file)))
}
{
  const F5_SRC = 'one\ntwo\nthree\n'
  const c = fresh('f-expect-gate.js', F5_SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'two', expect: 'THREE', replace: 'TWO' }])
  check(!r.ok && r.error.code === 'PATCH_EXPECT_MISMATCH', 'F5 expect 闸门对 old 地址同样生效（expect 说 three，实际定到 two ⇒ 拦下）', brief(r.error))
  check(Buffer.compare(before, readBytes(c.file)) === 0 && readTextFile(c.file) === F5_SRC, 'F5 被 expect 拦下时磁盘逐字节不变', JSON.stringify(readTextFile(c.file)))
}

// ── 段G：自动扩大上下文（能救的 / 不能救的）+ 坐标不当裁决者 ─────────────────
say('')
say('=== G. 自动扩大上下文重试一次 —— 能救的救，救不了就报候选（不猜）===')
{
  const G1_SRC = 'head A\nold line\ntail A\nfiller one\nfiller two\nhead B\nold line\ntail B\nctx marker\n'
  const c = fresh('g-expand.js', G1_SRC)
  const r = await attempt(c, [{ old: 'old line', context: 'ctx marker', replace: 'NEW' }])
  check(r.ok && r.out.applied[0].line === 7, 'G1 context 离 old 还差两行 ⇒ 自动扩大一轮后收敛到第 7 行', r.ok ? `line ${r.out.applied[0]?.line} tier=${r.out.applied[0]?.tier}` : brief(r.error))
  check(r.ok && r.out.applied[0].tier === 'old+expanded', 'G1 tier = old+expanded（说明这一命中来自“扩大上下文重试”）', r.ok ? `tier=${r.out.applied[0]?.tier}` : '')
  check(readTextFile(c.file) === G1_SRC.replace('old line\ntail B', 'NEW\ntail B'), 'G1 磁盘：只换第 7 行', JSON.stringify(readTextFile(c.file)))
}
{
  // 两块**逐字相同**的上下文 ⇒ 上下文与原文都没有信息能分出是哪一个。
  // 这里故意再给一个指向第一次出现的坐标：坐标不是裁决者，所以仍然必须拒绝。
  const G2_SRC = 'head\nDUP\ntail\nhead\nDUP\ntail\n'
  const c = fresh('g-twin-blocks.js', G2_SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'DUP', lines: [2, 2], replace: 'DUP!' }])
  check(!r.ok && r.error.code === 'PATCH_AMBIGUOUS', 'G2 两块逐字相同 + 坐标指向其中一个 ⇒ 仍然拒绝（坐标不当歧义裁决者）', brief(r.error))
  check(!r.ok && (r.error.candidates ?? []).length === 2, 'G2 拒绝里给出两个候选', JSON.stringify((r.ok ? [] : r.error.candidates ?? []).map((x) => x.line)))
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'G2 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
}
{
  const G3_SRC = 'DUP\nfiller\nDUP\ntail\n'
  const c = fresh('g-near.js', G3_SRC)
  const r = await attempt(c, [{ old: 'DUP', near: 3, replace: 'DUP!' }])
  check(r.ok && r.out.applied[0].line === 3 && r.out.applied[0].byNear === true, 'G3 显式 near 提示可以从歧义里收敛（回执标 byNear）', r.ok ? `line ${r.out.applied[0]?.line} byNear=${r.out.applied[0]?.byNear}` : brief(r.error))
  check(readTextFile(c.file) === 'DUP\nfiller\nDUP!\ntail\n', 'G3 磁盘正确', JSON.stringify(readTextFile(c.file)))
}
{
  const G4_SRC = 'DUP\nfiller\nDUP\n'
  const c = fresh('g-near-tie.js', G4_SRC)
  const before = readBytes(c.file)
  const r = await attempt(c, [{ old: 'DUP', near: 2, replace: 'DUP!' }])
  check(!r.ok && r.error.code === 'PATCH_AMBIGUOUS', 'G4 near 并列最近（两处等距）⇒ 不猜，仍然拒绝', brief(r.error))
  check(Buffer.compare(before, readBytes(c.file)) === 0, 'G4 磁盘逐字节不变', `before=${before.length}B after=${readBytes(c.file).length}B`)
}

say('')
const passed = results.filter((r) => r.ok).length
say(`--- 结果：${passed}/${results.length} 通过 ---`)
for (const f of results.filter((r) => !r.ok)) say(`  FAIL: ${f.label}  ${f.detail}`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
