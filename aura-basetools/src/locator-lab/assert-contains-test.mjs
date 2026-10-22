/**
 * assert-contains-test —— C1：断言语义「整段相等 → 包含且唯一」。
 *
 * 这道闸的职责没变（防"指到错的行"），变的是它**凭什么**下判断：
 *   · 改前：受寻址区间的归一化原文必须**逐字等于** `expect`。
 *   · 改后：`expect` 归一化后在**整个文件**里必须**只出现一处**，并且这一处必须落在
 *     受寻址区间内——区间**含有**这段文字即通过。
 *
 * 唯一性是放松的前提，不是附加条款：没有它，"包含"就退化成"文件里随便哪儿有这段字"，
 * 闸门等于放空（蓝图风险项点名的正是这个）。所以本文件把两条一起钉住：段A/段E 钉包含，
 * 段C/段F 钉唯一性——但唯一性在 C17 之后是**按地址形态分档**的（见下）。
 *
 * ## C17 分档：唯一性看地址形态，包含一条不让
 *
 * 唯一性不是判据的目的，而是"这个地址是否明确"的**代理**。调用方**自己写出精确坐标**
 * （`tier === 'lines'`）时，受寻址区间就是地址本身，"这段文字在全文件还有没有第二处"
 * 不再提供任何关于"你指的是哪儿"的信息，却会实打实地误伤坐标给准的调用 ⇒ 这一档免掉。
 * 地址来自**线索**（`symbol` / `lineCue` / `anchor`，以及写路径的 `old`）时，区间是引擎按内容
 * 算出来的，引文不唯一就判不出意图 ⇒ 照旧拒绝且给候选。**不传第 6 参的旧调用与"线索"同义。**
 *
 * 分档的边界两条都不放，本文件逐条钉住：
 *   · **区间内不含该文本时仍拒**（段C 的陈旧档、段E），与唯一性无关——这是防陈旧寻址的闸门；
 *   · **线索档仍要求唯一**（段C 的 cue / anchor 两支、段E 的 e3cue），候选与"补上下文"那句呼吁
 *     都在回执里；
 *   · **短于 12 字符照旧不分档**（段G），仍判整段相等，给了坐标也一样。
 * 段F 的穷举不变量因此重述为「通过 ⇒ 区间真的含有引文，且（全文唯一 或 有精确坐标且区间含该文本）」，
 * 并额外核对两档都有样本、分档开关可机械翻转（收回忆放宽则本套件当场红）。
 *
 * 段B 的口径（蓝图那句"区间比引文窄通过"与终态"被受寻址区间包含即为通过"冲突，本单给出
 * 明确结论并说明）：**拒绝**。区间比引文窄时，区间并没有包含引文；若让"引文比区间宽"也算
 * 通过，判定就退化成对称的重叠判定——引文与区间各说各话也算通过，段F 那条负向不变量的
 * 「expect 不在区间内却通过」立刻成立。拒绝时回执明写"引文跨 N 行 / 区间只有 M 行"，
 * 并给出两条可执行的修正方向（加宽 lines= 覆盖整段引文，或把 expect 裁到区间内的文字）。
 *
 * 段G 钉阈值口径：短于 12 字符的引文不参与放松，仍按**改前的整段相等**判定（更严，不是更松），
 * 并在失败回执里明写这条口径。阈值不是拍的：见 locator-api.mjs 里 `ASSERT_RELAX_MIN_CHARS`
 * 的推导（本仓库 67 个源文件、14305 条全文件唯一的归一化行文本，长度 < 12 的占 4.54%）。
 *
 * 段H 钉硬约束：`locate()` 的签名与返回形状一个字都没变，改的只有谓词与失败消息。
 *
 * 段C 的 c3 是本单**迁过来**的那一条：区间**恰好**落在其中一处重复文本上、而且逐字全等，
 * 改前判"拒绝"（"不唯一时拒绝"是对【整个文件】的要求，不因相等而豁免），C17 之后判**通过**
 * ——因为区间就是调用方给的坐标。同一组形状在线索档下的旧结论原样保留（段C 的 cue / anchor 两支）。
 */
import fs from 'node:fs'
import { expectVerdict, locate } from './locator-api.mjs'
import { normSpace } from './anchor-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

/**
 * 判据样本。刻意让 beta / gamma 两个函数体**逐字相同**（真实文件里重复代码块极常见），
 * 于是段C 的"全文出现多次"有真实形态：单行重复（第 12/21 行）与跨行重复（13-15 / 22-24）。
 */
const SRC = [
  'import { helper } from "./helper.js";',
  '',
  'export function alpha(input) {',
  '  const first = helper(input);',
  '  if (first > 0) {',
  '    return first * 2;',
  '  }',
  '  return 0;',
  '}',
  '',
  'export function beta(items) {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item.price;',
  '  }',
  '  return sum;',
  '}',
  '',
  '// 重复的代码块在真实文件里很常见：下面这段与 beta 体内逐字相同',
  'export function gamma(items) {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item.price;',
  '  }',
  '  return sum;',
  '}',
  '',
].join('\n')
const FILE = 'x.js'
const LINES = SRC.split('\n')
/** 1-based 闭区间的原文（逐字，含缩进）——引文与区间都用它构造，避免手抄出错。 */
const region = (start, end) => LINES.slice(start - 1, end).join('\n')

/**
 * 全文件出现次数——**独立口径**，用来核对回执里报的处数是不是真的。
 * 归一化与判据同源（{@link normSpace}）：这是本项目反复强调的"同一个决策只有一份定义"。
 */
const occurrences = (text) => {
  const want = normSpace(text)
  const hay = LINES.map((line) => normSpace(line)).join('\n')
  let n = 0
  for (let p = hay.indexOf(want); p !== -1; p = hay.indexOf(want, p + 1)) n += 1
  return n
}

say('=== 段A：片段断言（expect 是受寻址区间原文的一段）⇒ 通过 ===')
{
  const a1 = locate(SRC, { lines: { start: 3, end: 9 }, assert: 'const first = helper(input);', filePath: FILE })
  check(
    a1.ok === true,
    'A 寻址整个函数体（3-9）+ 其中一行的引文 ⇒ 通过',
    a1.ok ? `tier=${a1.tier} lines=${a1.startLine}-${a1.endLine}` : `${a1.code}: ${a1.message}`,
  )
  check(a1.ok === true && a1.startLine === 3 && a1.endLine === 9, 'A 回执区间仍是请求的区间（放松的是断言，不是地址）')
  check(
    a1.ok === true && normSpace(a1.actual) !== normSpace('const first = helper(input);'),
    'A 这一例确实不是"整段相等"——改前必被拒，所以它测的正是放松本身',
  )

  const a2 = locate(SRC, { lines: { start: 3, end: 9 }, assert: 'helper(input)', filePath: FILE })
  check(a2.ok === true, 'A 引文是某行的一个片段（helper(input)，13 字符）⇒ 通过', a2.ok ? '' : `${a2.code}: ${a2.message}`)

  const a3 = locate(SRC, { lines: { start: 3, end: 9 }, assert: 'return first * 2;\n  }', filePath: FILE })
  check(a3.ok === true, 'A 引文跨行且带缩进（区间内相邻两行的尾与头）⇒ 通过', a3.ok ? '' : `${a3.code}: ${a3.message}`)

  const a4 = locate(SRC, { target: 'alpha', assert: 'helper(input)', filePath: FILE })
  check(
    a4.ok === true && a4.tier === 'symbol',
    'A 断言对符号层同样按包含判定（四层共用 done() 里这一道闸）',
    a4.ok ? `tier=${a4.tier} lines=${a4.startLine}-${a4.endLine}` : `${a4.code}: ${a4.message}`,
  )

  const a5 = locate(SRC, { lineCue: 'const first', assert: 'const first = helper', filePath: FILE })
  check(
    a5.ok === true && a5.tier === 'lineCue',
    'A 断言对词线索层同样按包含判定',
    a5.ok ? `tier=${a5.tier}` : `${a5.code}: ${a5.message}`,
  )
}

say('')
say('=== 段B：区间比引文窄（引文跨更多行）⇒ 拒绝，且回执把口径写明 ===')
{
  const b1 = locate(SRC, { lines: { start: 4, end: 4 }, assert: region(3, 5), filePath: FILE })
  check(
    b1.ok === false && b1.code === 'LOCATOR_ASSERT_MISMATCH',
    'B 引文跨 3 行、区间只有 1 行 ⇒ 拒绝（区间没有包含引文）',
    b1.ok ? 'ok' : b1.code,
  )
  check(
    b1.ok === false && /spans 3 lines/.test(b1.message) && /the addressed region is 1 line/.test(b1.message),
    'B 回执明写这条口径：引文跨 3 行 / 区间 1 行',
    String(b1.message).slice(0, 160),
  )
  check(
    b1.ok === false && b1.message.includes('widen lines='),
    'B 回执给出可执行的修正方向（加宽 lines= 覆盖整段引文，或把 expect 裁到区间内）',
  )
  check(
    b1.ok === false && typeof b1.actual === 'string' && b1.actual === region(4, 4),
    'B 拒绝时仍回报区间实际内容（模型唯一能看见的通道是 message，actual 供壳层渲染）',
    JSON.stringify(b1.actual),
  )

  const b2 = locate(SRC, { lines: { start: 4, end: 5 }, assert: region(3, 5), filePath: FILE })
  check(
    b2.ok === false && /spans 3 lines/.test(b2.message) && /the addressed region is 2 line/.test(b2.message),
    'B 区间 2 行、引文 3 行 ⇒ 拒绝（差一行也算没被包含，不做"大概齐"）',
    b2.ok ? 'ok' : String(b2.message).slice(0, 160),
  )
}

say('')
say('=== 段C：引文全文多处 ⇒ 按地址形态分档：坐标档通过 / 线索档仍拒且给候选（C17）===')
{
  check(occurrences('let sum = 0;') === 2, 'C 样本事实核对：let sum = 0; 在全文件共 2 处（第 12、21 行）', `${occurrences('let sum = 0;')}`)

  // ── 坐标档：`lines` 就是调用方给的地址 ⇒ 唯一性这一档免掉（C17）。
  // 改前这五条全红（实测 34/44：段C 八条红里前五条就是它们）。
  const c1 = locate(SRC, { lines: { start: 11, end: 17 }, assert: 'let sum = 0;', filePath: FILE })
  check(
    c1.ok === true,
    'C 区间 11-17 含引文、引文全文 2 处，但坐标本身就是地址 ⇒ 通过（C17 分档）',
    c1.ok ? `lines=${c1.startLine}-${c1.endLine} tier=${c1.tier}` : `${c1.code}: ${c1.message}`,
  )
  check(
    c1.ok === true && c1.actual === region(11, 17) && c1.candidates === undefined,
    'C 回执不再是候选清单，而是区间原文（成功回执仍是 {ok,startLine,endLine,tier,actual}）',
    c1.ok ? JSON.stringify(c1.actual.slice(0, 40)) : c1.code,
  )
  check(
    c1.ok === true && c1.startLine === 11 && c1.endLine === 17,
    'C 区间没有被“收敛”到引文那一行（放松的是唯一性，不是地址）',
    c1.ok ? `${c1.startLine}-${c1.endLine}` : c1.code,
  )

  const c2 = locate(SRC, { lines: { start: 11, end: 17 }, assert: region(13, 15), filePath: FILE })
  check(
    c2.ok === true,
    'C 跳行引文（13-15 与 22-24 逐字相同）在坐标档下同样通过',
    c2.ok ? `lines=${c2.startLine}-${c2.endLine}` : `${c2.code}: ${c2.message}`,
  )

  const c3 = locate(SRC, { lines: { start: 12, end: 12 }, assert: '  let sum = 0;', filePath: FILE })
  check(
    c3.ok === true && c3.actual === region(12, 12),
    'C 区间恰好落在其中一处上、且逐字全等 ⇒ 通过（改前这一条钉的是“不因相等豁免”）',
    c3.ok ? JSON.stringify(c3.actual) : c3.code,
  )

  // ── 陈旧档：坐标在、区间内**不含**该文本 ⇒ 仍拒（分档一条边界都不放）
  const stale = locate(SRC, { lines: { start: 12, end: 12 }, assert: 'let sum = 9;', filePath: FILE })
  check(
    stale.ok === false && stale.code === 'LOCATOR_ASSERT_MISMATCH' && /nowhere in this file/.test(stale.message),
    'C 坐标档的陈旧防护：区间不含该文本 ⇒ 仍拒（全文没有 ⇒ nowhere，不看唯一性）',
    stale.ok ? 'ok（放过了）' : String(stale.message).slice(0, 120),
  )
  check(stale.ok === false && stale.actual === region(12, 12), 'C 拒绝时仍回报区间实际内容', stale.ok ? 'ok' : JSON.stringify(stale.actual))

  // ── 线索档：区间由引擎算出来，引文不唯一就判不出意图 ⇒ 照旧拒且给候选
  const cue = locate(SRC, { lineCue: 'return sum', assert: 'let sum = 0;', filePath: FILE })
  check(
    cue.ok === false && cue.code === 'LOCATOR_CUE_AMBIGUOUS',
    'C 线索档（lineCue）引文不唯一 ⇒ 仍拒（这一条与本档无关：线索连区间都没定下来）',
    cue.ok ? 'ok（放过了）' : cue.code,
  )
  check(
    cue.ok === false && (cue.candidates ?? []).map((c) => c.line).join(',') === '16,25',
    'C 线索档拒绝时给候选行号（与改前一字未变）',
    JSON.stringify((cue.candidates ?? []).map((c) => c.line)),
  )

  const anchor = locate(SRC, { anchor: 'export function beta(items) {', assert: 'let sum = 0;', filePath: FILE })
  check(
    anchor.ok === false && anchor.code === 'LOCATOR_ASSERT_MISMATCH' && /not unique/.test(anchor.message),
    'C 线索档（anchor）区间已定下来，但引文不唯一 ⇒ 仍拒且回执仍是那条“不唯一”',
    anchor.ok ? 'ok（放过了）' : String(anchor.message).slice(0, 120),
  )
  check(
    anchor.ok === false && (anchor.candidates ?? []).map((c) => c.line).join(',') === '12,21' && /quote more of the surrounding text/.test(anchor.message),
    'C 线索档的候选与“补上下文”那句呼吁都还在（终态原文：不唯一时要求补上下文并给候选位置）',
    anchor.ok ? 'ok' : JSON.stringify((anchor.candidates ?? []).map((c) => c.line)),
  )

  // ── 本套件的**变异反证**：分档的唯一开关是第 6 参。同址同引文，第 6 参='lines' ⇒
  // 通过；不传 ⇒ not_unique + 2 处。把 C17 的放宽收回去，本套件当场红。
  const LINES = SRC.split('\n')
  const withTier = expectVerdict(LINES, 11, 17, region(11, 17), 'let sum = 0;', 'lines')
  const withoutTier = expectVerdict(LINES, 11, 17, region(11, 17), 'let sum = 0;')
  check(
    withTier === null && withoutTier !== null && withoutTier.kind === 'not_unique' && withoutTier.places.length === 2,
    'C 分档开关可机械核对：第 6 参="lines" ⇒ 通过；不传 ⇒ not_unique + 2 处（收回忆放宽则本条必红）',
    `tier=lines ⇒ ${withTier === null ? 'pass' : 'reject'} / 不传 ⇒ ${withoutTier?.kind ?? 'pass'} places=${(withoutTier?.places ?? []).map((p) => p.line).join(',')}`,
  )
}

say('')
say('=== 段D：expect 与区间逐字全等 ⇒ 仍然通过（原正确路径不能因放松而变）===')
{
  const d1 = locate(SRC, { lines: { start: 6, end: 6 }, assert: '    return first * 2;', filePath: FILE })
  check(d1.ok === true, 'D 单行逐字全等（含缩进）⇒ 通过', d1.ok ? '' : `${d1.code}: ${d1.message}`)
  check(occurrences('    return first * 2;') === 1, 'D 样本事实核对：该行在全文件唯一')

  const d2 = locate(SRC, { lines: { start: 3, end: 5 }, assert: region(3, 5), filePath: FILE })
  check(d2.ok === true, 'D 多行逐字全等 ⇒ 通过', d2.ok ? '' : `${d2.code}: ${d2.message}`)

  const d3 = locate(SRC, { lines: { start: 11, end: 17 }, assert: region(11, 17), filePath: FILE })
  check(
    d3.ok === true && d3.actual === region(11, 17),
    'D 整段函数逐字全等 ⇒ 通过，且 actual 就是该段原文（一字不差）',
    d3.ok ? '' : `${d3.code}: ${d3.message}`,
  )
}

say('')
say('=== 段E：区间内根本不含 expect ⇒ 拒绝 ===')
{
  const e1 = locate(SRC, { lines: { start: 6, end: 6 }, assert: 'const first = helper(input);', filePath: FILE })
  check(
    e1.ok === false && e1.code === 'LOCATOR_ASSERT_MISMATCH',
    'E 引文全文唯一、但在区间之外 ⇒ 拒绝（"指到错的行"仍然拦得住）',
    e1.ok ? 'ok' : e1.code,
  )
  check(
    e1.ok === false && e1.message.includes('line 4') && /outside the addressed region/.test(e1.message),
    'E 回执点出那处唯一出现的位置（第 4 行），模型能据此改地址',
    e1.ok ? 'ok' : String(e1.message).slice(0, 160),
  )
  check(e1.ok === false && e1.actual === region(6, 6), 'E 回执回报区间实际内容')

  const e2 = locate(SRC, { lines: { start: 6, end: 6 }, assert: 'const neverWritten = 1;', filePath: FILE })
  check(
    e2.ok === false && /nowhere in this file/.test(e2.message),
    'E 引文在全文件根本不存在 ⇒ 拒绝并明说"全文没有"（比"不符"更可执行）',
    e2.ok ? 'ok' : String(e2.message).slice(0, 160),
  )

  const e3 = locate(SRC, { lines: { start: 20, end: 26 }, assert: 'let sum = 0;', filePath: FILE })
  check(
    e3.ok === true && e3.actual === region(20, 26),
    'E 区间含其中一处、全文有 2 处，但区间就是调用方给的坐标 ⇒ 通过（与段C 是同一件事的两面）',
    e3.ok ? `lines=${e3.startLine}-${e3.endLine}` : `${e3.code}: ${e3.message}`,
  )
  // 线索档的对照：同一份文件、同一段引文，地址换成词线索 ⇒ 区间是引擎算的，仍拒且带候选
  // 线索必需自己唯一（否则先撞 LOCATOR_CUE_AMBIGUOUS）：'gamma' 只出现在第 19 行注释里，
  // 区间落在 20-20，那里恰好含 'let sum = 0;' 的一处，而该引文全文 2 处 ⇒ 必须由分档拒。
  const e3cue = locate(SRC, { lineCue: 'gamma', assert: 'let sum = 0;', filePath: FILE })
  check(
    e3cue.ok === false && e3cue.code === 'LOCATOR_ASSERT_MISMATCH' && /not unique/.test(e3cue.message),
    'E 线索档下同一段引文 ⇒ 仍拒绝（“不唯一就拒”只对线索档保留，不是整条闸都松了）',
    e3cue.ok ? 'ok' : String(e3cue.message).slice(0, 140),
  )

  // 引文首尾的空行是**构造伪影**：受寻址区间的 actual 是 join('\n') 出来的，按构造不带首尾换行。
  // 所以"把整行的行尾也一并引上"不该被拒——否则无论引得多准都判不过（系统性假阴性，CRLF 文件里必现）。
  const e4 = locate(SRC, { lines: { start: 6, end: 6 }, assert: '\n    return first * 2;\n', filePath: FILE })
  check(
    e4.ok === true,
    'E 引文首尾多一个换行（把行尾一并引上）⇒ 通过：首尾换行是构造伪影，不是内容',
    e4.ok ? '' : `${e4.code}: ${e4.message}`,
  )

  // 引文与区间部分重叠时，回执不能说"在区间外"——那句话会与它自己给的行号自相矛盾（第 5 行就在区间里）
  const e5 = locate(SRC, { lines: { start: 4, end: 5 }, assert: region(5, 6), filePath: FILE })
  check(
    e5.ok === false && /only partly overlaps/.test(e5.message),
    'E 引文与区间部分重叠（区间 4-5、引文 5-6）⇒ 拒绝，回执说"部分重叠"而不是"在区间外"',
    e5.ok ? 'ok' : String(e5.message).slice(0, 170),
  )
}

say('')
say('=== F：负向不变量 —— 凡是“通过”，区间就必须真的含有引文（且长引文要么全文唯一，要么有精确坐标）===')
{
  /**
   * 穷举区间 × 引文，逐条核对**只有通过**这一侧的不变量。分档之后它重述为：
   *   · **包含**（两档共同，一条不让）：通过 ⇒ `normSpace(区间原文)` 必须含 `normSpace(引文)`
   *     （短引文走整段相等，相等也蕴含包含）。少了它，这道闸就只剩“文件里随便哪儿有这段字”。
   *   · **唯一性**（看地址形态）：长度 ≥ 12 的引文，若全文不唯一，则仅当**有精确坐标且区间含该文本**
   *     时才允许通过 —— 这条与本文件的调用形态一致：`locate()` 收到的 `lines` 就是调用方给的坐标，
   *     `tier` 必为 `'lines'`，正是 C17 免掉唯一性的那一档。
   * 不变量只描述“通过者长什么样”，不是把实现重抄一遍：实现多放一个通过，这里必然报出来。
   */
  const wants = [
    'helper(input)',
    'const first = helper(input);',
    'return first * 2;',
    'if (first > 0) {',
    'let sum = 0;',
    'sum += item.price;',
    region(13, 15),
    region(3, 5),
    region(11, 17),
    '    return first * 2;\n  }',
    'const neverWritten = 1;',
    'export function',
    'return 0;',
    '}',
  ]
  const violations = []
  let passed = 0
  let rejected = 0
  /** 通过者里“靠 C17 分档过的”有多少组 —— 这一档在旧口径下本来是被拒的。 */
  let passedByCoordinate = 0
  /** 通过者里“靠全文唯一过的”有多少组 —— 两档都必须有样本，否则不变量在空转。 */
  let passedByUnique = 0
  for (let a = 1; a <= LINES.length; a += 1) {
    for (let b = a; b <= Math.min(LINES.length, a + 7); b += 1) {
      for (const want of wants) {
        const want_ = normSpace(want)
        const r = locate(SRC, { lines: { start: a, end: b }, assert: want, filePath: FILE })
        if (!r.ok) {
          rejected += 1
          continue
        }
        passed += 1
        const inside = normSpace(r.actual).includes(want_)
        if (!inside) violations.push(`lines ${a}-${b} × ${JSON.stringify(want.slice(0, 24))}: 区间不含引文却通过`)
        if (want_.length < 12) continue
        const unique = occurrences(want) === 1
        if (unique) passedByUnique += 1
        // 分档的两个条件：调用方给的坐标（tier='lines'）+ 区间内确实含有这段文字
        const byCoordinate = r.tier === 'lines' && inside
        if (byCoordinate) passedByCoordinate += 1
        if (!unique && !byCoordinate) {
          violations.push(
            `lines ${a}-${b} × ${JSON.stringify(want.slice(0, 24))}: 引文全文不唯一且无精确坐标却通过（tier=${r.tier}）`,
          )
        }
      }
    }
  }
  check(
    violations.length === 0,
    `F ${passed + rejected} 组（区间 × 引文）里，没有一组出现“expect 不在区间内却通过”或“无坐标不唯一却通过”`,
    violations.slice(0, 3).join(' | '),
  )
  check(passed > 0 && rejected > 0, `F 穷举不是空转：通过 ${passed} 组 / 拒绝 ${rejected} 组`, `通过率 ${(100 * passed / (passed + rejected)).toFixed(1)}%`)
  check(
    passedByCoordinate > 0 && passedByUnique > 0,
    'F 两档都被穷举覆盖：既有靠坐标（区间含引文）过的，也有靠全文唯一过的（否则不变量没测到分档）',
    `坐标档 ${passedByCoordinate} 组 / 全文唯一 ${passedByUnique} 组`,
  )

  /**
   * ── 本套件的**变异反证**：把 C17 的第 6 参那一档去掉，同一组形状必须当场变红。
   * 同址同引文、同一个“全文 2 处”的引文：带 `tier='lines'` ⇒ 通过；不传 ⇒ not_unique。
   */
  const LINES_ = SRC.split('\n')
  const withTier = expectVerdict(LINES_, 20, 26, region(20, 26), 'let sum = 0;', 'lines')
  const withoutTier = expectVerdict(LINES_, 20, 26, region(20, 26), 'let sum = 0;')
  check(
    withTier === null && withoutTier !== null && withoutTier.kind === 'not_unique',
    'F 分档开关可机械核对：第 6 参="lines" ⇒ 通过；不传 ⇒ not_unique（收回忆放宽则本套件当场红）',
    `tier=lines ⇒ ${withTier === null ? 'pass' : 'reject'} / 不传 ⇒ ${withoutTier?.kind ?? 'pass'}`,
  )
}

say('')
say('=== 段G：短引文不参与放松（阈值口径可见，不是静默规则）===')
{
  check('import { he'.length === 11 && 'import { hel'.length === 12, 'G 边界样本长度核对：11 与 12 字符', `${'import { he'.length}/${'import { hel'.length}`)

  const g1 = locate(SRC, { lines: { start: 3, end: 9 }, assert: 'return', filePath: FILE })
  check(
    g1.ok === false && g1.code === 'LOCATOR_ASSERT_MISMATCH',
    'G 极短引文即使被区间包含也拒绝 —— 不许静默放松',
    g1.ok ? 'ok（放过了）' : g1.code,
  )
  check(
    g1.ok === false && /shorter than 12 chars/.test(g1.message),
    'G 回执明写"这次为什么仍要求整段相等"（口径不可见时，调用方只看到一条更严的失败）',
    g1.ok ? 'ok' : String(g1.message).slice(-110),
  )

  const g2 = locate(SRC, { lines: { start: 8, end: 8 }, assert: '  return 0;', filePath: FILE })
  check(g2.ok === true, 'G 短引文与区间整段相等 ⇒ 仍然通过（改前的正确路径不变）', g2.ok ? '' : `${g2.code}: ${g2.message}`)

  const g3 = locate(SRC, { lines: { start: 1, end: 1 }, assert: 'import { he', filePath: FILE })
  check(
    g3.ok === false,
    'G 11 字符（差 1 到阈值）⇒ 仍按整段相等判定，因此拒绝',
    g3.ok ? 'ok（放过了）' : g3.code,
  )
  const g4 = locate(SRC, { lines: { start: 1, end: 1 }, assert: 'import { hel', filePath: FILE })
  check(
    g4.ok === true,
    'G 12 字符（正好到阈值）⇒ 按包含判定，同一行的同一片段通过',
    g4.ok ? '' : `${g4.code}: ${g4.message}`,
  )
}

say('')
say('=== 段H：返回形状不变量（硬约束：只改谓词与失败消息）===')
{
  const okShape = locate(SRC, { lines: { start: 6, end: 6 }, assert: 'return first * 2;', filePath: FILE })
  check(
    okShape.ok === true && Object.keys(okShape).sort().join(',') === 'actual,endLine,ok,startLine,tier',
    'H 成功回执仍是 {ok,startLine,endLine,tier,actual}',
    Object.keys(okShape).join(','),
  )
  const badShape = locate(SRC, { lines: { start: 6, end: 6 }, assert: 'const first = helper(input);', filePath: FILE })
  check(
    badShape.ok === false && typeof badShape.code === 'string' && typeof badShape.message === 'string' && typeof badShape.actual === 'string',
    'H 失败回执仍是 {ok:false,code,message,actual}（可选 candidates 与既有失败路径同形）',
    Object.keys(badShape).join(','),
  )
  const noAssert = locate(SRC, { lines: { start: 6, end: 6 }, filePath: FILE })
  check(
    noAssert.ok === true && Object.keys(noAssert).sort().join(',') === 'actual,endLine,ok,startLine,tier',
    'H 不给 expect 时形状与判据都不变',
    Object.keys(noAssert).join(','),
  )
  check(
    okShape.ok === true && !okShape.message && !('code' in okShape),
    'H 通过时不额外冒字段（没有"assertPassed"之类的新面）',
  )
}

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}`)
  process.exitCode = 1
}
