/**
 * intent-address-test —— 意图地址（T16 / 0.8.0）：调用方给一段**模糊的意图串**，引擎确定性地
 * 落成一个精确区间，并如实报出它实际走的那一档；落不下来就**拒绝并给候选**，绝不猜。
 *
 * ## 为什么需要这一层
 *
 * 既有四层都要求调用方先知道一件它常常不知道的事：`target` 要知道符号全名，`lines` 要知道行号，
 * `line_cue` 要一个全文件唯一的词，`anchor` 要记得住逐字原文。真实调用里最常见的形态是
 * "大概知道要改哪个函数/哪句话"——这层把这句话收敛成一个确定区间，并把**它是怎么落下来的**
 * 写进 `tier`（`intent~symbol` / `intent~text~<档>`），调用方据此判断这次命中可信不可信。
 *
 * ## 解析次序（本套件逐档钉住）
 *
 *   ① 已知语言 ⇒ 先当符号名解析（`resolveTarget`，这就是 `target=` 那一层的引擎）；
 *      **结构歧义当场拒绝**，绝不落到文本层——文本往往能"恰好"命中其中一个候选，那会把
 *      "有两个都可能"静默卖成"就是这一个"。
 *   ② 符号名没对上 ⇒ 符号名**子串**匹配：先区分大小写，没有才忽略大小写；
 *      一个命中即符号档；多个命中时 `near` 要能**严格**收敛到一个（跨度含 near 记距离 0）。
 *   ③ 一个符号都没命中（或语言未知）⇒ 文本匹配（`locateWith`，与 `anchor` 同一份引擎）。
 *
 * ## 段
 *
 *   A 符号档：精确名 / 唯一子串 / 大小写不敏感子串
 *   B 符号歧义：多个子串命中 ⇒ 码 + 候选（候选带 name/kind，证明**没有**落到文本候选）
 *   C near 消歧：跨度含 near ⇒ 距离 0，byNear=true
 *   D 文本档：唯一短语 / 近似原文（改一个词）/ 重复短语歧义 / 连文本也没有
 *   E 参数面：`intent` 与其他地址字段互斥 ⇒ PATCH_INTENT_CONFLICT，且磁盘一个字节都不动
 *   F 写路径：planHunks 逐字节落地 + 回执的 tier/line；`expect` 闸门在 intent 档同样生效
 *
 * 只走公开 API（`locate` / `planHunks` / `applyEditToProvider`），不碰任何私有函数：
 * 判据要能跟着实现一起换，而不必跟着实现一起改。
 *
 * 跑法：`node src/locator-lab/intent-address-test.mjs`，全绿 exit 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import { locate } from './locator-api.mjs'
import { applyEditToProvider, planHunks } from './write-path.mjs'
import { indexStructure, langOf, resolveTarget } from './struct-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}

const TMP = path.join(os.tmpdir(), `intent-address-${process.pid}-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

// ════════════════════════════════════════════════════════════════════════════
// 夹具：行号是判据的一部分（tier 之外的第二个可核对事实），所以写成数组、按 1-based 编号。
//   2-5   renderHeader      —— 子串 `render` 的候选之一
//   7-10  renderFooter      —— 子串 `render` 的另一个候选（near 消歧用它）
//   12    一行长注释        —— 唯一短语 / 近似原文各取一段
//   13-17 uniqueHelper      —— 唯一子串 `Helper`
//   15+20 重复注释          —— 文本档的歧义
// ════════════════════════════════════════════════════════════════════════════
const ROWS = [
  '// intent fixture: one file, several address shapes', // 1
  'export function renderHeader(title) {', // 2
  '  // render pipeline notes', // 3
  '  return `<h1>${title}</h1>`', // 4
  '}', // 5
  '', // 6
  'export function renderFooter(note) {', // 7
  '  const status = "ready"', // 8
  '  return `<footer>${note}</footer>`', // 9
  '}', // 10
  '', // 11
  '// The upload retry keeps the last payload around until the server acks it.', // 12
  'export function uniqueHelper(value) {', // 13
  '  const status = "ready"', // 14
  '  // keep this comment identical', // 15
  '  return value + 1', // 16
  '}', // 17
  '', // 18
  'export function alphaSomething() {', // 19
  '  // keep this comment identical', // 20
  '  return 0', // 21
  '}', // 22
  '', // 23
]
const SRC = ROWS.join('\n')
const FILE = 'intent-fixture.mjs'
const ask = (request) => locate(SRC, { filePath: FILE, ...request })

/**
 * planHunks 抛错的统一取法：返回 `{code, message, error}`。不吞错——没抛也算一种结果，由调用方断言。
 */
function thrownBy(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return { code: error?.code, message: String(error?.message ?? ''), error }
  }
}

say('=== A. 符号档：精确名 / 唯一子串 / 大小写不敏感子串 ===')
{
  const exact = ask({ intent: 'renderFooter' })
  check(
    'A1 精确符号名 ⇒ ok，tier=intent~symbol，区间就是该函数的跨度',
    exact.ok === true && exact.tier === 'intent~symbol' && exact.startLine === 7 && exact.endLine === 10,
    exact.ok ? `${exact.tier} lines ${exact.startLine}-${exact.endLine}` : `${exact.code}: ${exact.message}`,
  )
  check('A1 actual 是该区间的逐字原文', exact.ok === true && exact.actual === ROWS.slice(6, 10).join('\n'))

  const substring = ask({ intent: 'Helper' })
  check(
    'A2 唯一符号名子串（区分大小写）⇒ 落到 uniqueHelper',
    substring.ok === true && substring.tier === 'intent~symbol' && substring.startLine === 13 && substring.endLine === 17,
    substring.ok ? `${substring.tier} lines ${substring.startLine}-${substring.endLine}` : `${substring.code}: ${substring.message}`,
  )

  const insensitive = ask({ intent: 'HELPER' })
  check(
    'A3 区分大小写没有命中时才忽略大小写（同一条符号）',
    insensitive.ok === true && insensitive.tier === 'intent~symbol' && insensitive.startLine === 13,
    insensitive.ok ? `${insensitive.tier} lines ${insensitive.startLine}-${insensitive.endLine}` : `${insensitive.code}: ${insensitive.message}`,
  )
}

say('')
say('=== B. 符号歧义：多个子串命中 ⇒ 拒绝 + 符号候选（绝不落到文本） ===')
{
  const ambiguous = ask({ intent: 'render' })
  const names = (ambiguous.candidates ?? []).map((c) => c.name).sort()
  check(
    'B1 两个候选 ⇒ LOCATOR_INTENT_AMBIGUOUS',
    ambiguous.ok === false && ambiguous.code === 'LOCATOR_INTENT_AMBIGUOUS',
    ambiguous.ok ? `ok（静默挑了一个：lines ${ambiguous.startLine}-${ambiguous.endLine}）` : ambiguous.code,
  )
  check(
    'B2 候选是**符号**对象（name/kind/startLine/endLine），不是文本行候选',
    names.join(',') === 'renderFooter,renderHeader' && (ambiguous.candidates ?? []).every((c) => typeof c.kind === 'string' && typeof c.startLine === 'number' && typeof c.endLine === 'number'),
    JSON.stringify((ambiguous.candidates ?? []).map((c) => ({ name: c.name, kind: c.kind, lines: `${c.startLine}-${c.endLine}` }))),
  )
  check(
    'B3 回执正文自带候选（DSH 只读 error.message，挂在字段上的东西模型看不见）',
    ambiguous.ok === false && /renderHeader/.test(ambiguous.message) && /renderFooter/.test(ambiguous.message),
    ambiguous.ok ? '（无回执）' : ambiguous.message,
  )

  // 候选里的 `target=name#n` 必须真的能解析：`#n` 是**同名序号**，不是全局候选序号。
  const handlers = [
    'export function fooHandler() {',
    '  return 1',
    '}',
    '',
    'export function barHandler() {',
    '  return 2',
    '}',
    '',
    'export function handler2() {',
    '  return 3',
    '}',
    '',
    'export function handler2() {',
    '  return 4',
    '}',
    '',
  ].join('\n')
  const many = locate(handlers, { filePath: FILE, intent: 'andler' })
  const addresses = [...String(many.message ?? '').matchAll(/target=([A-Za-z0-9_$#]+)/g)].map((m) => m[1])
  let resolvable = 0
  for (const address of addresses) {
    try {
      resolveTarget(indexStructure(handlers, langOf(FILE)), address)
      resolvable += 1
    } catch {
      /* 不可解析的地址就是这次要抓的回归 */
    }
  }
  check(
    'B4 歧义回执里的每个 target 地址都能解析（#n 按同名序号，不按全局下标）',
    addresses.length >= 4 && resolvable === addresses.length,
    JSON.stringify({ addresses, resolvable }),
  )
  check(
    'B5 唯一名字不带 #，同名才带 #',
    addresses.includes('fooHandler') && addresses.includes('barHandler') && addresses.includes('handler2#1') && addresses.includes('handler2#2'),
    JSON.stringify(addresses),
  )
}

say('')
say('=== C. near 消歧：跨度含 near ⇒ 距离 0，byNear=true ===')
{
  const picked = ask({ intent: 'render', near: 9 })
  check(
    'C1 near 落在 renderFooter 跨度内 ⇒ 选中 footer，tier=intent~symbol，byNear=true',
    picked.ok === true && picked.startLine === 7 && picked.endLine === 10 && picked.byNear === true,
    picked.ok ? `${picked.tier} lines ${picked.startLine}-${picked.endLine} byNear=${picked.byNear}` : `${picked.code}: ${picked.message}`,
  )
  const tie = ask({ intent: 'render', near: 6 })
  check(
    'C2 near 与两个候选**并列**（都在跨度外、距离相等）⇒ 仍报歧义，不猜',
    tie.ok === false && tie.code === 'LOCATOR_INTENT_AMBIGUOUS' && (tie.candidates ?? []).length === 2,
    tie.ok ? `ok（静默挑了 lines ${tie.startLine}-${tie.endLine}）` : tie.code,
  )

  // 同名精确符号 + near 落在第一个长函数体内：必须按**跨度包含**选第一个，
  // 不能按 `|startLine - near|` 选到后面那个（旧实现会把 near=18 选到第二处）。
  const dupRender = [
    'export function render() {', // 1
    ...Array.from({ length: 18 }, (_, i) => `  // filler ${i + 1}`), // 2-19
    '}', // 20
    '',
    'export function render() {', // 22
    '  return 2', // 23
    '}', // 24
    '',
  ].join('\n')
  const exactNear = locate(dupRender, { filePath: FILE, intent: 'render', near: 18 })
  check(
    'C3 同名精确符号 + near 在第一个长函数体内 ⇒ 选中第一个（跨度距离 0，不是起点距离）',
    exactNear.ok === true && exactNear.startLine === 1 && exactNear.endLine === 20 && exactNear.byNear === true,
    exactNear.ok ? `${exactNear.startLine}-${exactNear.endLine} byNear=${exactNear.byNear}` : `${exactNear.code}: ${exactNear.message}`,
  )
}

say('')
say('=== D. 文本档：唯一短语 / 近似原文 / 重复短语 / 不存在 ===')
{
  const phrase = ask({ intent: 'keeps the last payload around' })
  check(
    'D1 唯一文本短语 ⇒ tier 记成 intent~text~<档>（档名来自文本引擎）',
    phrase.ok === true && phrase.tier === 'intent~text~exact' && phrase.startLine === 12 && phrase.endLine === 12,
    phrase.ok ? `${phrase.tier} lines ${phrase.startLine}-${phrase.endLine}` : `${phrase.code}: ${phrase.message}`,
  )

  // 一个词改了 1 个字符（payload → payloae）：这是"记错一个词"的最常见形状。
  const approximate = ask({ intent: '// The upload retry keeps the last payloae around until the server acks it.' })
  check(
    'D2 近似原文（一个词写错）⇒ 仍收敛到同一行，并如实报 similarity 档',
    approximate.ok === true && approximate.tier === 'intent~text~similarity' && approximate.startLine === 12,
    approximate.ok ? `${approximate.tier} lines ${approximate.startLine}-${approximate.endLine}` : `${approximate.code}: ${approximate.message}`,
  )

  const repeated = ask({ intent: 'keep this comment identical' })
  check(
    'D3 重复短语 ⇒ LOCATOR_INTENT_AMBIGUOUS',
    repeated.ok === false && repeated.code === 'LOCATOR_INTENT_AMBIGUOUS',
    repeated.ok ? `ok（静默挑了 line ${repeated.startLine}）` : repeated.code,
  )
  const lines = (repeated.candidates ?? []).map((c) => c.line)
  check(
    'D4 候选用的是**行**形状 {line,text}，行号就是那两处',
    lines.length === 2 && lines.includes(15) && lines.includes(20) && (repeated.candidates ?? []).every((c) => typeof c.text === 'string' && c.text === ROWS[c.line - 1]),
    JSON.stringify((repeated.candidates ?? []).map((c) => ({ line: c.line, text: c.text }))),
  )
  const nearRepeated = ask({ intent: 'keep this comment identical', near: 19 })
  check(
    'D5 重复短语 + near ⇒ 收敛到较近那一处，text 档同样如实报 byNear',
    nearRepeated.ok === true && nearRepeated.startLine === 20 && nearRepeated.byNear === true,
    nearRepeated.ok ? `${nearRepeated.tier} line ${nearRepeated.startLine} byNear=${nearRepeated.byNear}` : `${nearRepeated.code}: ${nearRepeated.message}`,
  )

  const absent = ask({ intent: 'definitely-not-a-symbol-or-any-text-9f3a' })
  check(
    'D6 符号与文本都没有 ⇒ LOCATOR_INTENT_NOT_FOUND，并给出可执行的下一步',
    absent.ok === false && absent.code === 'LOCATOR_INTENT_NOT_FOUND' && /no symbol or text matches intent/.test(absent.message) && /try target=<name>, lines=, or line_cue=/.test(absent.message),
    absent.ok ? `ok（静默命中 lines ${absent.startLine}-${absent.endLine}）` : absent.code,
  )
  check(
    'D7 已知语言时附符号目录（与 anchor 失败同一条恢复路径）',
    absent.ok === false && absent.hint !== undefined && Array.isArray(absent.hint.symbols) && absent.hint.symbols.length > 0,
    absent.ok ? '（无回执）' : `hint.symbols=${absent.hint?.symbols?.length ?? 'none'}`,
  )
}

say('')
say('=== E. 参数面：intent 与其他地址字段互斥，且磁盘一个字节都不动 ===')
{
  const withTarget = thrownBy(() => planHunks(SRC, [{ intent: 'renderFooter', target: 'renderFooter', replace: 'X' }], FILE))
  check(
    'E1 intent + target ⇒ PATCH_INTENT_CONFLICT，message 点名 target',
    withTarget !== null && withTarget.code === 'PATCH_INTENT_CONFLICT' && withTarget.message.includes('target'),
    withTarget === null ? '没有抛错' : `${withTarget.code}: ${withTarget.message}`,
  )
  const withLines = thrownBy(() => planHunks(SRC, [{ intent: 'renderFooter', lines: [7, 10], replace: 'X' }], FILE))
  check(
    'E2 intent + lines ⇒ PATCH_INTENT_CONFLICT，message 点名 lines',
    withLines !== null && withLines.code === 'PATCH_INTENT_CONFLICT' && withLines.message.includes('lines'),
    withLines === null ? '没有抛错' : `${withLines.code}: ${withLines.message}`,
  )
  const withStart = thrownBy(() => planHunks(SRC, [{ intent: 'renderFooter', start_line: 7, end_line: 10, replace: 'X' }], FILE))
  check(
    'E3 intent + start_line/end_line ⇒ 同时点名两个字段',
    withStart !== null && withStart.code === 'PATCH_INTENT_CONFLICT' && withStart.message.includes('start_line') && withStart.message.includes('end_line'),
    withStart === null ? '没有抛错' : `${withStart.code}: ${withStart.message}`,
  )
  const allowed = thrownBy(() => planHunks(SRC, [{ intent: 'renderFooter', near: 8, expect: 'export function renderFooter(note) {', replace: 'X' }], FILE))
  check(
    'E4 near / expect / replace 与 intent 同给**不是**冲突（它们是修饰与动作）',
    allowed === null,
    allowed === null ? '' : `${allowed.code}: ${allowed.message}`,
  )

  // 走真写路径：冲突必须在规划期就抛，磁盘逐字节不动。
  const victim = path.join(TMP, 'conflict-fixture.mjs')
  fs.writeFileSync(victim, SRC)
  const before = crypto.createHash('sha256').update(fs.readFileSync(victim)).digest('hex')
  let version = 1
  const provider = {
    stat: async (target) => (fs.existsSync(target) ? { version: `v${version}`, type: 'file', size: fs.statSync(target).size } : undefined),
    readText: async (target) => fs.readFileSync(target, 'utf8'),
    readByteRange: async (target, range) => fs.readFileSync(target).subarray(range.offset, range.offset + range.length),
    writeText: async (target, content, expected) => {
      if (expected?.kind === 'replaceIfVersion' && `v${version}` !== expected.version) {
        throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
      }
      fs.writeFileSync(target, content)
      version += 1
      return { version: `v${version}`, operation: 'update', after: content }
    },
  }
  const runConflict = async () => {
    try {
      await applyEditToProvider(provider, { displayPath: victim, hunks: [{ intent: 'renderFooter', target: 'renderFooter', replace: 'X' }] })
      return null
    } catch (error) {
      return error
    }
  }
  const conflictError = await runConflict()
  const after = crypto.createHash('sha256').update(fs.readFileSync(victim)).digest('hex')
  check(
    'E5 真写路径同样拒绝（不是返回假成功）',
    conflictError !== null && conflictError.code === 'PATCH_INTENT_CONFLICT',
    conflictError === null ? '返回了回执（假成功）' : String(conflictError.code),
  )
  check('E6 磁盘 sha256 不变（一个字节都没写）', before === after, `${before.slice(0, 12)} → ${after.slice(0, 12)}`)
}

say('')
say('=== F. 写路径：planHunks 逐字节落地 + 回执 tier/line；expect 闸门照旧 ===')
{
  const replacement = ['export function uniqueHelper(value) {', '  return value * 2', '}'].join('\n')
  const planned = planHunks(SRC, [{ intent: 'uniqueHelper', replace: replacement }], FILE)
  const expected = [...ROWS.slice(0, 12), ...replacement.split('\n'), ...ROWS.slice(17)].join('\n')
  check('F1 字节精确：改后的内容 = 手写期望（只动被寻址的那一段）', planned.content === expected)
  const receipt = planned.applied[0]
  check(
    'F2 回执报真实 tier 与行号（line 用改动前的坐标）',
    receipt !== undefined && receipt.tier === 'intent~symbol' && receipt.line === 13 && receipt.byNear === false,
    JSON.stringify(receipt === undefined ? null : { line: receipt.line, tier: receipt.tier, byNear: receipt.byNear }),
  )
  check('F3 actual 是被替换区间的原文（不是 replace）', receipt !== undefined && receipt.actual === ROWS.slice(12, 17).join('\n'))

  const withExpect = planHunks(
    SRC,
    [{ intent: 'renderFooter', expect: '  return `<footer>${note}</footer>`', replace: '  return `<footer>${note}</footer>`' }],
    FILE,
  )
  check(
    'F4 expect 与命中区间一致 ⇒ 通过（intent 档与其余四层走同一个判据）',
    withExpect.applied.length === 1 && withExpect.applied[0].line === 7,
    JSON.stringify(withExpect.applied.map((a) => ({ line: a.line, tier: a.tier }))),
  )

  const mismatched = thrownBy(() =>
    planHunks(SRC, [{ intent: 'renderFooter', expect: 'this text is nowhere near the footer region at all', replace: 'X' }], FILE),
  )
  check(
    'F5 expect 与命中区间不符 ⇒ LOCATOR_ASSERT_MISMATCH（拒绝，不写）',
    mismatched !== null && mismatched.code === 'LOCATOR_ASSERT_MISMATCH',
    mismatched === null ? '没有抛错' : mismatched.code,
  )
  check(
    'F6 拒绝回执点明这次命中走的是 intent 档',
    mismatched !== null && mismatched.message.includes('via intent~symbol'),
    mismatched === null ? '' : mismatched.message.slice(0, 160),
  )
}

say('')
say('=== G. 三个入口的接线：平铺键 / 运行期守卫名单（同源派生） ===')
{
  const { FLAT_ADDRESS_KEYS, flatHunk } = await import('./args.mjs')
  check(
    'G1 FLAT_ADDRESS_KEYS 收下 intent（CLI 的 --intent 与平铺形状都靠它才递得到引擎）',
    FLAT_ADDRESS_KEYS.includes('intent'),
    FLAT_ADDRESS_KEYS.join(','),
  )
  const flat = flatHunk({ intent: 'renderFooter', replace: 'X' })
  check(
    'G2 flatHunk 认得出"只有 intent + replace"就是一个 hunk（不必包成 hunks 数组）',
    flat !== null && flat.intent === 'renderFooter' && flat.replace === 'X',
    JSON.stringify(flat),
  )
  const edit = await import('../aura-edit/index.js')
  check(
    'G3 DSH 壳的运行期守卫名单含 intent（EDIT_ARG_KEYS 由 HUNK_PROPERTIES 派生，没有第二份名单）',
    edit.EDIT_ARG_KEYS.includes('intent'),
    edit.EDIT_ARG_KEYS.join(','),
  )
}

fs.rmSync(TMP, { recursive: true, force: true })

say('')
say(`--- ${pass}/${pass + fail} 通过 ---`)
if (fail > 0) say(`失败 ${fail} 条`)
process.exitCode = fail === 0 ? 0 : 1
