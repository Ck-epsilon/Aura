/**
 * expect-address-form-test —— fs-contract-v2 波5 / C17：`expect` 唯一性按地址形态分档。
 *
 * ## 命题（施工单终态，判据不可改）
 *
 * 调用方**已经给出精确坐标**（`lines` ⇒ 命中层 `tier === 'lines'`）、且 `expect` 被受寻址区间
 * **包含**时，不再要求该文本在**全文件唯一**——坐标本身就是地址；地址模糊（没给坐标，只给线索）
 * 时才要求唯一。
 *
 * ## 为什么可以免掉唯一性（理由写在这里，也在 `locator-api.mjs` 的 `COORDINATE_TIER` 旁）
 *
 * 唯一性不是判据的目的，是**「这个地址是否明确」的代理判据**：C1 把谓词从"整段相等"放松成
 * "包含"之后，由它接手改前这道闸真正防的事——"指到错的行"。既然是代理，就有代理多余的场合：
 * 调用方自己写出了坐标时，区间就是地址，"这段文字还有没有第二处"不再提供任何关于
 * "你指的是哪儿"的信息，却会实打实地误伤。
 *
 * 代价是**量出来的**：成功集重放（`probes/success-regression.mjs`，读数
 * `.polaris/workorders/fs-contract-v2.integrate4.success-regression.txt` 第 60-75 行）里，
 * 旧契约下成功、新契约被拒的 **Z=7 条全部**是 `lines` 寻址 + `LOCATOR_ASSERT_MISMATCH`，
 * 且 7 条的引文都逐字等于受寻址区间。复核过那 7 条的原始入参（`aura-r2-success-corpus.json`）：
 * 每条 hunk 都**只有**坐标（`lines` / `start_line`+`end_line`），没有 `old` / `target` / `line_cue` /
 * `anchor`。段A 的第 5 例就是照 S0578 的形状（单行坐标 + 该行逐字 + 全文 3 处）造的。
 *
 * ## 段
 *
 *   A 精确坐标 + 区间含该文本 + 该文本全文两处（乃至三处）⇒ **通过**（**改前必红**）
 *   B 无坐标、只给线索（line_cue / anchor / target / old）⇒ 仍**拒绝**并给候选
 *   C 坐标处不含该文本 ⇒ 仍**拒绝**（陈旧防护零放松）；穷举重钉"通过 ⇒ 区间必含引文"
 *   D 短引文（< 12 字符）口径不变：仍走整段相等，给了坐标也一样
 *   E 单源与签名：全仓运行路径上只有一处 `expectVerdict` 实现；签名只多一个**可选**第 6 参
 *
 * ## 改动前的原始读数（怎么复现、红在哪）
 *
 * 复现方式与 C10 的 `expect-single-source-test.mjs` 同法：把 `src` 整树拷到临时目录，
 * 只把拷贝里 `locator-api.mjs` 的三处还原成改前形态（`expectText, tier = null)` 收回 5 参、
 * 删掉 `if (tier === COORDINATE_TIER && have.includes(want)) return null` 这一行、
 * `assertVerdict` 的调用去掉尾参），再把本文件拷进去跑。
 *
 * 实测（同一个文件、同一台机器，只差引擎这三处）：
 *   改前 **33/48 通过、exit 1** —— 红的是段A 12 条（`kind=not_unique`，回执要求"补上下文"）、
 *     段D 的 12 字符边界那条、段E 的签名与同址对照两条；段B 9/9、段C 9/9 全绿。
 *   改后 **48/48 通过、exit 0**。
 * 段B/段C 改前就绿是**故意的**：它们是分档的边界（线索档仍要唯一、坐标处不含文本仍要拒），
 * 分档不该动它们——这正是这一段读数要证的东西。两段原始读数都留在
 * `.polaris/workorders/fs-contract-v2.C17.result.json` 的 `evidence` 里。
 *
 * ## 与 C1 的终态相撞（如实记下，别当它不存在）
 *
 * C1 的终态是「包含**且唯一**」；本单的终态是「有坐标就不要求唯一」。两份终态在**同一组形状**上
 * 结论相反（坐标给准 + 区间含引文 + 引文全文两处 ⇒ 拒 vs 过），所以 C1 时代钉过这一组的断言
 * 必然随本档翻面。`assert-contains-test.mjs` 段C 的 c3 写得最明白——
 * "区间恰好落在其中一处上、且逐字全等 ⇒ 仍然拒绝（不因相等豁免）"——它钉的就是 Z=7 里那 7 条。
 *
 * 实测翻转清单（同一份快照，只把引擎那三处还原，逐个套件跑）：
 *   assert-contains-test 44/44 → 34/44 ｜ expect-single-source-test 42/42 → 39/42
 *   stale-gate-test 62/62 → 58/62 ｜ arg-shape-test 27/27 → 24/27 ｜ old-fragment-fallback-test 48/48 → 39/42
 *   （其余 35 个套件不变；`aura-edit/load-test` 57/57、`content-address-test` 68/68 两个点名的套件**没有**退化）
 * 后三个套件钉的是**逐字全等**那一形状（`lines:[3,3]` + 该行原文，全文两处），与 Z=7 同形；
 * 唯一的"少翻一点"的做法是只免逐字全等、不免片段包含，实测仍会翻前三个套件里的两个
 * （arg-shape 24/27、stale-gate 58/62）+ assert-contains 41/44，却把终态的轴从"地址形态"
 * 偷换成"地址形态 × 引文形状"——那是在终态里加一条它没写的条件，所以不那么做。
 *
 * 这些判据脚本**不在本单的写范围内**（本单只许改 `locator-api.mjs` 与本文件），因此不在本单里
 * 静默改它们：冲突、因果隔离实验与实测清单全部交给回执。注意硬约束的措辞是"迁移旧断言 ≠ 删断言：
 * 断言**总数**不许减少，且要断到实质"——迁移是允许的，缺的是写范围。
 *
 * 跑法：`node src/locator-lab/expect-address-form-test.mjs`，全绿 exit 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSERT_RELAX_MIN_CHARS, expectVerdict, locate } from './locator-api.mjs'
import { applyEditToProvider, planHunks } from './write-path.mjs'
import { normSpace } from './anchor-core.mjs'

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}
const brief = (error) =>
  error === null || error === undefined
    ? 'no error (这次没有拒绝)'
    : `${error.code ?? '?'} ${String(error.message ?? error).slice(0, 150)}`

/**
 * 判据样本：beta 与 gamma 的函数体**逐字相同**（真实文件里重复代码块极常见），于是"全文多处"
 * 有真实形态：单行重复（第 12 / 21 行）与跨行重复块（13-16 / 22-25）。
 *
 * 第 12 / 21 行的差别只在注释（`// beta` / `// gamma`）：这样 `line_cue` 能唯一命中第 12 行
 * （线索档要有"线索唯一、引文不唯一"的形态），而引文 `let sum = 0;` 本身仍是全文两处。
 */
const SRC = [
  'import { helper } from "./helper.js";', // 1
  '', // 2
  'export function alpha(input) {', // 3
  '  const first = helper(input);', // 4
  '  if (first > 0) {', // 5
  '    return first * 2;', // 6
  '  }', // 7
  '  return 0;', // 8
  '}', // 9
  '', // 10
  'export function beta(items) {', // 11
  '  let sum = 0; // beta', // 12
  '  for (const item of items) {', // 13
  '    sum += item.price;', // 14
  '  }', // 15
  '  return sum;', // 16
  '}', // 17
  '', // 18
  '// 重复的代码块在真实文件里很常见：下面这段与 beta 体内逐字相同', // 19
  'export function gamma(items) {', // 20
  '  let sum = 0; // gamma', // 21
  '  for (const item of items) {', // 22
  '    sum += item.price;', // 23
  '  }', // 24
  '  return sum;', // 25
  '}', // 26
  '', // 27
].join('\n')
const FILE = 'x.js'
const LINES = SRC.split('\n')
/** 1-based 闭区间的原文（逐字，含缩进）——判据与样本都用它构造，避免手抄出错。 */
const region = (start, end) => LINES.slice(start - 1, end).join('\n')

/**
 * 全文件出现次数——**独立口径**，用来核对"全文两处/三处"这个前提是真的。
 * 归一化与判据同源（{@link normSpace}）：这是本项目反复强调的"同一个决策只有一份定义"。
 */
const occurrences = (text, lines = LINES) => {
  const want = normSpace(text)
  const hay = lines.map((line) => normSpace(line)).join('\n')
  let n = 0
  for (let p = hay.indexOf(want); p !== -1; p = hay.indexOf(want, p + 1)) n += 1
  return n
}

/**
 * 段A 第 5 例的样本：照 S0578 的原样形状造——**单行坐标 + 引文逐字等于该行 + 全文 3 处**
 * （S0578 的回执是 `lines 320-320 via lines: expect is not unique … it appears on 3 places`）。
 */
const SRC3 = [
  'export function a() {', // 1
  '  const run = (name, fn) => {', // 2
  '    return fn(name)', // 3
  '  }', // 4
  '}', // 5
  '', // 6
  'export function b() {', // 7
  '  const run = (name, fn) => {', // 8
  '    return fn(name)', // 9
  '  }', // 10
  '}', // 11
  '', // 12
  'export function c() {', // 13
  '  const run = (name, fn) => {', // 14
  '    return fn(name)', // 15
  '  }', // 16
  '}', // 17
  '', // 18
].join('\n')
const LINES3 = SRC3.split('\n')
const Z_LINE = '  const run = (name, fn) => {'

/**
 * 仓库根：向上找到含 `src/locator-lab/locator-api.mjs` 的那一级。
 * 这样"改前读数"的临时拷贝（`<tmp>/src/...`）里段E 的静态扫描照样成立，
 * 不必为复现方式在判据里开洞。
 */
const findRepoRoot = (from) => {
  let dir = from
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src/locator-lab/locator-api.mjs'))) return dir
    const up = path.dirname(dir)
    if (up === dir) throw new Error(`repo root not found above ${from}`)
    dir = up
  }
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = findRepoRoot(HERE)

const TMP = path.join(os.tmpdir(), `expect-address-form-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

/**
 * 与真提供方同形的文件提供方（形状照抄 `expect-single-source-test` / `content-address-test` 的 mock：
 * mock 与真件不同形就等于没测）。写回走 `replaceIfVersion` 的 CAS。
 */
let caseSeq = 0
const fresh = (text) => {
  caseSeq += 1
  const file = path.join(TMP, `${caseSeq}.js`)
  fs.writeFileSync(file, text)
  let version = 1
  const provider = {
    stat: async (target) =>
      fs.existsSync(target) ? { version: `v${version}`, type: 'file', size: fs.statSync(target).size } : undefined,
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
  return { file, provider, read: () => fs.readFileSync(file, 'utf8') }
}

/** 跑一次真写路径：成功返回回执，失败返回错误（**绝不吞**，失败的那条也必须能打印）。 */
const attempt = async (c, hunks) => {
  try {
    return { ok: true, out: await applyEditToProvider(c.provider, { displayPath: c.file, hunks }) }
  } catch (error) {
    return { ok: false, error }
  }
}
const planned = (src, hunks, file = FILE) => {
  try {
    return { ok: true, out: planHunks(src, hunks, file) }
  } catch (error) {
    return { ok: false, error }
  }
}

// ════════════════════════════════════════════════════════════════════════════
say('=== 段A：精确坐标 + 区间含该文本 + 全文两处 ⇒ 通过（改前：not_unique 拒绝）===')
{
  const QUOTE = 'let sum = 0;' // 归一化后 12 字符（正好到放松阈值），全文 2 处：第 12 / 21 行
  check(
    occurrences(QUOTE) === 2 && occurrences(region(13, 16)) === 2 && occurrences('const first = helper(input);') === 1,
    'A 样本事实核对：引文 2 处、跨行块 region(13,16) 2 处、对照用的那一行只有 1 处',
    `let sum = 0; =${occurrences(QUOTE)} / region(13,16) =${occurrences(region(13, 16))} / const first = helper(input); =${occurrences('const first = helper(input);')}`,
  )

  const vFragment = expectVerdict(LINES, 11, 17, region(11, 17), QUOTE, 'lines')
  check(
    vFragment === null,
    'A 判据结论：有坐标（tier=lines）+ 区间含引文 + 引文全文两处 ⇒ **通过**（改前这里是 kind=not_unique）',
    vFragment === null ? 'null（通过）' : `${vFragment.kind} places=${vFragment.places?.map((p) => p.line).join(',')}`,
  )

  const vWhole = expectVerdict(LINES, 13, 16, region(13, 16), region(13, 16), 'lines')
  check(
    vWhole === null,
    'A 引文逐字等于整个受寻址区间（旧契约下唯一能过的那一形状）+ 该块全文两处 ⇒ 照样通过',
    vWhole === null ? 'null（通过）' : `${vWhole.kind} places=${vWhole.places?.map((p) => p.line).join(',')}`,
  )

  const byLocate = locate(SRC, { lines: { start: 11, end: 17 }, assert: QUOTE, filePath: FILE })
  check(
    byLocate.ok === true && byLocate.tier === 'lines' && byLocate.startLine === 11 && byLocate.endLine === 17,
    'A 引擎入口 locate()：同一份引文通过，且回执区间仍是请求的区间（放松的是唯一性，不是地址）',
    byLocate.ok ? `ok tier=${byLocate.tier} lines=${byLocate.startLine}-${byLocate.endLine}` : brief(byLocate),
  )
  check(
    byLocate.ok === true && byLocate.actual === region(11, 17),
    'A actual 仍是该区间逐字原文（一字不差）',
  )

  const wholeByLocate = locate(SRC, { lines: { start: 13, end: 16 }, assert: region(13, 16), filePath: FILE })
  check(
    wholeByLocate.ok === true,
    'A 引擎入口 locate()：整段重复块逐字全等 ⇒ 通过',
    wholeByLocate.ok ? `ok lines=${wholeByLocate.startLine}-${wholeByLocate.endLine}` : brief(wholeByLocate),
  )

  // ── 段A 第 5 例：Z 语料里 S0578 的原样形状（单行坐标 + 该行逐字 + 全文 3 处）
  check(
    occurrences(Z_LINE, LINES3) === 3,
    'A 样本事实核对（Z 形状）：单行引文在全文件共 3 处（第 2 / 8 / 14 行）',
    `${occurrences(Z_LINE, LINES3)} 处`,
  )
  const zShape = locate(SRC3, { lines: { start: 8, end: 8 }, assert: Z_LINE, filePath: FILE })
  check(
    zShape.ok === true && zShape.startLine === 8 && zShape.endLine === 8,
    'A 单行坐标 + 该行逐字 + 全文 3 处 ⇒ 通过（这就是 Z=7 里被拒的那一形状）',
    zShape.ok ? `ok lines=${zShape.startLine}-${zShape.endLine}` : brief(zShape),
  )

  // ── 写路径端到端：这一批调用本该成功（旧契约下确实成功）
  const byPlan = planned(SRC, [{ lines: [11, 17], expect: QUOTE, replace: 'REPLACED' }])
  check(
    byPlan.ok === true && byPlan.out.applied.length === 1 && byPlan.out.applied[0].line === 11,
    'A planHunks：坐标 + 片段引文（全文两处）⇒ 规划成功（改前 PATCH_AMBIGUOUS）',
    byPlan.ok ? `applied=${byPlan.out.applied.length} line=${byPlan.out.applied[0]?.line}` : brief(byPlan.error),
  )

  const c1 = fresh(SRC)
  const r1 = await attempt(c1, [{ lines: [11, 17], expect: QUOTE, replace: 'REPLACED' }])
  check(
    r1.ok === true && r1.out.applied.length === 1 && r1.out.applied[0].line === 11,
    'A 真写路径：坐标 + 片段引文 ⇒ applied（不是"只回了个 ok"）',
    r1.ok ? `line ${r1.out.applied[0].line} tier=${r1.out.applied[0].tier}` : brief(r1.error),
  )
  check(
    r1.ok === true && c1.read() === SRC.replace(region(11, 17), 'REPLACED'),
    'A 磁盘只换掉被寻址的那一段，其余逐字不动',
    JSON.stringify(c1.read().split('\n')[10]),
  )
  check(
    r1.ok === true && c1.read().includes(region(20, 26)),
    'A 区间之外那段逐字相同的代码块（20-26）**完全没动**（放松的是断言，落点仍由坐标决定）',
  )

  const c2 = fresh(SRC)
  const r2 = await attempt(c2, [{ lines: [13, 13], expect: 'for (const item of items) {', replace: '  for (const it of items) {' }])
  check(
    r2.ok === true && c2.read() === SRC.replace(region(13, 13), '  for (const it of items) {'),
    'A 真写路径（单行坐标 + 该行引文 + 全文两处）⇒ 落盘，且第 22 行那份重复逐字保留',
    r2.ok ? `line ${r2.out.applied[0].line}` : brief(r2.error),
  )
  check(
    r2.ok === true && c2.read().split('\n')[21] === '  for (const item of items) {',
    'A 第 22 行没有被"就近改掉"（同形块的落点由坐标钉住）',
    JSON.stringify(c2.read().split('\n')[21]),
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段B：无坐标、只给线索 ⇒ 仍要求唯一（line_cue / anchor / target / old 四路）===')
{
  const QUOTE = 'let sum = 0;' // 全文 2 处；线索本身唯一（`// beta` 只在第 12 行）

  check(occurrences('// beta') === 1, 'B 样本事实核对：线索 `// beta` 全文件只有 1 处（线索唯一、引文不唯一）', `${occurrences('// beta')} 处`)

  const byCue = locate(SRC, { lineCue: '// beta', assert: QUOTE, filePath: FILE })
  check(
    byCue.ok === false && byCue.code === 'LOCATOR_ASSERT_MISMATCH',
    'B line_cue 命中唯一一行、引文也被那一行包含，但引文全文两处 ⇒ 仍拒绝',
    byCue.ok ? 'ok（放过了）' : String(byCue.message).slice(0, 110),
  )
  check(
    byCue.ok === false && (byCue.candidates ?? []).map((c) => c.line).join(',') === '12,21',
    'B 回执带候选（12 / 21）——"从候选里选一处"是这一档的全部价值',
    JSON.stringify(byCue.candidates?.map((c) => c.line)),
  )
  check(
    byCue.ok === false && /quote more of the surrounding text/.test(String(byCue.message)),
    'B 回执给出可执行的下一步（补上下文 / 用坐标），不是一句"不符"',
  )

  const byAnchor = locate(SRC, {
    anchor: 'export function beta(items) {\n  let sum = 0; // beta',
    assert: QUOTE,
    filePath: FILE,
  })
  check(
    byAnchor.ok === false && byAnchor.code === 'LOCATOR_ASSERT_MISMATCH' && /line 21 =/.test(String(byAnchor.message)),
    'B anchor（文本锚点，tier 不是 lines）⇒ 仍拒绝，且点出区间之外那一处（第 21 行）',
    byAnchor.ok ? 'ok（放过了）' : String(byAnchor.message).slice(-110),
  )

  const byTarget = locate(SRC, { target: 'beta', assert: QUOTE, filePath: FILE })
  check(
    byTarget.ok === false && byTarget.code === 'LOCATOR_ASSERT_MISMATCH' && /via symbol/.test(String(byTarget.message)),
    'B target=（符号身份）⇒ 仍拒绝：区间是引擎按符号表算出来的，坐标并不是调用方给的（见 COORDINATE_TIER 注释）',
    byTarget.ok ? 'ok（放过了）' : String(byTarget.message).slice(0, 110),
  )

  const byOld = planned(SRC, [{ old: 'export function beta(items) {', expect: QUOTE, replace: 'X' }])
  check(
    byOld.ok === false && byOld.error.code === 'PATCH_AMBIGUOUS' && (byOld.error.candidates ?? []).length === 2,
    'B 内容寻址（old）⇒ PATCH_AMBIGUOUS + 2 个候选：写路径那一道闸（不传地址形态的旧调用）也照旧严格',
    brief(byOld.error),
  )

  const c = fresh(SRC)
  const r = await attempt(c, [{ line_cue: '// beta', expect: QUOTE, replace: 'X' }])
  check(r.ok === false && c.read() === SRC, 'B 线索寻址的 hunk 被拒时磁盘逐字节不变', `${c.read().length}B`)

  // 判据层：把线索档的可能取值**逐一点名**，一个都不许被放过
  const hintForms = ['symbol', 'lineCue', 'anchor', 'exact', 'norm-space', 'trim-line', 'similarity', 'aligned']
  const leaked = hintForms.filter(
    (form) => expectVerdict(LINES, 11, 17, region(11, 17), QUOTE, form) === null,
  )
  check(
    leaked.length === 0,
    `B 判据层：线索档的 ${hintForms.length} 个取值（${hintForms.join(' / ')}）全部仍要求唯一，没有一个被误分进坐标档`,
    leaked.length === 0 ? 'none leaked' : `leaked: ${leaked.join(',')}`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段C：坐标处不含该文本 ⇒ 仍拒绝（陈旧防护零放松）===')
{
  const QUOTE = 'let sum = 0;'

  const c1 = locate(SRC, { lines: { start: 13, end: 13 }, assert: QUOTE, filePath: FILE })
  check(
    c1.ok === false && c1.code === 'LOCATOR_ASSERT_MISMATCH',
    'C 坐标落在第 13 行（那一行是 for 循环，不含引文）⇒ 拒绝 —— 分档只免唯一性，不免"区间要真的含它"',
    c1.ok ? 'ok（放过了）' : String(c1.message).slice(0, 110),
  )

  const c2 = locate(SRC, { lines: { start: 21, end: 21 }, assert: 'const first = helper(input);', filePath: FILE })
  check(
    c2.ok === false && /is outside the addressed region/.test(String(c2.message)) && String(c2.message).includes('line 4'),
    'C 引文全文唯一、只是不在坐标处 ⇒ 拒绝，并点名它真正在第 4 行（模型能据此改地址）',
    c2.ok ? 'ok（放过了）' : String(c2.message).slice(0, 130),
  )

  const c3 = locate(SRC, { lines: { start: 11, end: 17 }, assert: 'const neverWritten = 1;', filePath: FILE })
  check(
    c3.ok === false && /nowhere in this file/.test(String(c3.message)),
    'C 引文全文根本不存在 ⇒ 拒绝并明说"全文没有"（比"不符"更可执行）',
    c3.ok ? 'ok（放过了）' : String(c3.message).slice(0, 130),
  )

  const c4 = locate(SRC, { lines: { start: 12, end: 12 }, assert: region(12, 13), filePath: FILE })
  check(
    c4.ok === false && /expect spans 2 lines/.test(String(c4.message)) && /the addressed region is 1 line/.test(String(c4.message)),
    'C 引文比区间宽（区间 1 行、引文 2 行）⇒ 拒绝：区间并没有包含引文，不做"大概齐"',
    c4.ok ? 'ok（放过了）' : String(c4.message).slice(0, 150),
  )

  // 端到端：陈旧坐标（内容已经移位）必须被拦下，且磁盘不动
  const c5 = fresh(SRC)
  const r5 = await attempt(c5, [{ lines: [13, 13], expect: QUOTE, replace: 'X' }])
  check(
    r5.ok === false && r5.error.code === 'LOCATOR_ASSERT_MISMATCH',
    'C 陈旧坐标的 hunk（坐标处不含 expect）⇒ 拒绝（防陈旧寻址这道闸一个字没让）',
    brief(r5.error),
  )
  check(c5.read() === SRC, 'C 被拦下时磁盘逐字节不变', `${c5.read().length}B`)

  /**
   * 穷举把**分档后**的负向不变量钉死——这是 C1 段F 的同一条不变量，去掉那条已经有意改掉的口径
   * （"通过 ⇒ 全文唯一"），保留分档**没有**动的那一条：
   *   · 通过 ⇒ `normSpace(区间原文)` 必须包含 `normSpace(引文)`（短引文则必须整段相等）
   * 不变量只描述"通过者长什么样"，因此它不是把实现重抄一遍：实现多放一个通过，这里必然报出来。
   */
  const wants = [
    'helper(input)',
    'const first = helper(input);',
    'return first * 2;',
    'if (first > 0) {',
    'let sum = 0;',
    'let sum = 0',
    'sum += item.price;',
    'for (const item of items) {',
    '// beta',
    region(13, 16),
    region(12, 13),
    region(3, 9),
    'const neverWritten = 1;',
    'export function',
    'return 0;',
    '}',
  ]
  const violations = []
  let passed = 0
  let rejected = 0
  for (let a = 1; a <= LINES.length; a += 1) {
    for (let b = a; b <= Math.min(LINES.length, a + 7); b += 1) {
      const actual = region(a, b)
      for (const want of wants) {
        const r = locate(SRC, { lines: { start: a, end: b }, assert: want, filePath: FILE })
        if (!r.ok) {
          rejected += 1
          continue
        }
        passed += 1
        const want_ = normSpace(want)
        const have_ = normSpace(r.actual)
        if (want_.length < ASSERT_RELAX_MIN_CHARS ? have_ !== want_ : !have_.includes(want_)) {
          violations.push(`lines ${a}-${b} × ${JSON.stringify(want.slice(0, 24))}: 区间不含引文却通过`)
        }
      }
    }
  }
  check(
    violations.length === 0,
    `C 穷举 ${passed + rejected} 组（有坐标的区间 × 引文）里，没有一组出现"expect 不在区间内却通过"`,
    violations.slice(0, 3).join(' | '),
  )
  check(
    passed > 0 && rejected > 0,
    `C 穷举不是空转：通过 ${passed} 组 / 拒绝 ${rejected} 组（通过的那批正是分档新放行的）`,
    `通过率 ${((100 * passed) / (passed + rejected)).toFixed(1)}%`,
  )
  check(
    passed > 0 && wants.some((w) => normSpace(w).length >= ASSERT_RELAX_MIN_CHARS),
    'C 穷举里长引文（≥ 阈值）确实参与（否则这一段的"零放松"结论只覆盖短引文）',
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段D：短引文（< 12 字符）口径不变 —— 给了坐标也仍走整段相等 ===')
{
  check(
    ASSERT_RELAX_MIN_CHARS === 12 && normSpace('let sum = 0').length === 11 && normSpace('let sum = 0;').length === 12,
    'D 边界样本长度核对（归一化后 11 / 12）+ 阈值取自 locator-api 的同一条常量',
    `${normSpace('let sum = 0').length}/${normSpace('let sum = 0;').length}, ASSERT_RELAX_MIN_CHARS=${ASSERT_RELAX_MIN_CHARS}`,
  )

  const short = locate(SRC, { lines: { start: 11, end: 12 }, assert: 'let sum = 0', filePath: FILE })
  check(
    short.ok === false && short.code === 'LOCATOR_ASSERT_MISMATCH' && /shorter than 12 chars/.test(String(short.message)),
    'D 11 字符被区间包含（坐标也给了）⇒ 仍拒绝，且回执明写"这次为什么仍要求整段相等"',
    short.ok ? 'ok（放过了）' : String(short.message).slice(-110),
  )

  const edge = locate(SRC, { lines: { start: 11, end: 12 }, assert: 'let sum = 0;', filePath: FILE })
  check(
    edge.ok === true,
    'D 同一地址上只差一个字符（12 字符）⇒ 通过：分档与阈值各管各的，边界不被分档挪动',
    edge.ok ? `ok lines=${edge.startLine}-${edge.endLine}` : brief(edge),
  )

  const equalShort = locate(SRC, { lines: { start: 8, end: 8 }, assert: '  return 0;', filePath: FILE })
  check(
    equalShort.ok === true,
    'D 9 字符短引文与区间整段相等 ⇒ 通过（改前的正确路径不因分档而变）',
    equalShort.ok ? `ok lines=${equalShort.startLine}` : brief(equalShort),
  )
  const equalShortByCue = locate(SRC, { lineCue: 'return 0;', assert: '  return 0;', filePath: FILE })
  check(
    equalShortByCue.ok === true,
    'D 同一例走线索档 ⇒ 同样通过（两档在短引文上同判）',
    equalShortByCue.ok ? `ok tier=${equalShortByCue.tier}` : brief(equalShortByCue),
  )

  const c = fresh(SRC)
  const r = await attempt(c, [{ lines: [11, 12], expect: 'let sum = 0', replace: 'X' }])
  check(
    r.ok === false && r.error.code === 'LOCATOR_ASSERT_MISMATCH' && /shorter than 12 chars/.test(String(r.error.message)),
    'D 端到端：11 字符引文的 hunk ⇒ 拒绝（口径在写路径上同样可见）',
    brief(r.error),
  )
  check(c.read() === SRC, 'D 磁盘逐字节不变', `${c.read().length}B`)
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段E：单源与签名 —— 只多一个可选第 6 参，旧调用一个字不用改 ===')
{
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'logs', 'tmp', 'state', '_maptest', '_verify', '.aura-verify'])
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name), out)
      } else if (/\.(mjs|js)$/.test(entry.name)) out.push(path.join(dir, entry.name))
    }
    return out
  }
  /** 靶场/量具/判据脚本不算发货的运行路径（同 `expect-single-source-test` 段D 的口径）。 */
  const isHarness = (rel) => /(-test|-probe|-replay|-scan|bench|smoke|audit|corpus)\.mjs$/.test(rel)
  const relOf = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/')
  const files = walk(REPO_ROOT)
  const ship = files.filter((f) => relOf(f).startsWith('src/') && !isHarness(relOf(f)))

  const defs = ship.filter((f) => /(^|\n)\s*(export\s+)?function\s+expectVerdict\s*\(/.test(fs.readFileSync(f, 'utf8')))
  check(
    defs.length === 1 && relOf(defs[0]) === 'src/locator-lab/locator-api.mjs',
    `E 发货运行路径（${ship.length} 个文件）上 expectVerdict 的实现**只有一处**，就在 locator-api.mjs`,
    defs.map(relOf).join(' | ') || '（一处都没有）',
  )

  const LOCATOR = path.join(REPO_ROOT, 'src/locator-lab/locator-api.mjs')
  const WRITE = path.join(REPO_ROOT, 'src/locator-lab/write-path.mjs')
  const locatorSrc = fs.readFileSync(LOCATOR, 'utf8')
  const writeSrc = fs.readFileSync(WRITE, 'utf8')
  check(
    /export function expectVerdict\(/.test(locatorSrc),
    'E 唯一实现仍是导出的 `export function expectVerdict(`（名字与导出行没动）',
  )
  check(
    (locatorSrc.match(/expectVerdict\(/g) ?? []).length >= 2,
    'E locator-api 内部仍有调用（定义 1 处 + assert 闸门 1 处 ≥ 2）',
    `${(locatorSrc.match(/expectVerdict\(/g) ?? []).length} 处`,
  )
  check(
    /import \{[^}]*\bexpectVerdict\b[^}]*\} from '\.\/locator-api\.mjs'/.test(writeSrc) &&
      (writeSrc.match(/expectVerdict\(/g) ?? []).length >= 1,
    'E 写路径 import 并调用的是同一入口（转发结论，不自己再实现一份）',
    `${(writeSrc.match(/expectVerdict\(/g) ?? []).length} 处调用`,
  )

  const sig = /export function expectVerdict\(([^)]*)\)\s*\{/.exec(locatorSrc)
  const params = (sig?.[1] ?? '').split(',').map((p) => p.trim())
  check(
    params.length === 6 &&
      params.slice(0, 5).join(',') === 'lines,startLine,endLine,actual,expectText' &&
      params[5] === 'tier = null',
    'E 签名 = 原样 5 个位置参数 + 可选第 6 参 `tier = null`（旧 5 参调用照旧可调，不必改一个字）',
    `(${params.join(', ')})`,
  )

  // 行为核对：同一地址、同一引文，只差第 6 参 ⇒ 两种结论。分档只由**地址形态**决定。
  const oldCall = expectVerdict(LINES, 11, 17, region(11, 17), 'let sum = 0;')
  check(
    oldCall !== null && oldCall.kind === 'not_unique',
    'E 旧 5 参调用（不声明地址形态）⇒ 仍按最严一档判：kind=not_unique（默认不放宽）',
    oldCall === null ? 'null（放过了）' : `${oldCall.kind}`,
  )
  const newCall = expectVerdict(LINES, 11, 17, region(11, 17), 'let sum = 0;', 'lines')
  check(
    oldCall !== null && newCall === null,
    'E 同址对照：第 6 参从"不传"改成 \'lines\' ⇒ 结论由拒绝翻成通过（分档是**声明式**的，不靠猜）',
  )

  const shape = expectVerdict(LINES, 9, 15, region(9, 15), 'const neverWritten = 1;')
  check(
    shape !== null && Object.keys(shape).sort().join(',') === 'have,kind,places,regionLines,spans,want',
    'E 返回形状不变：结论仍是 `{kind, want, have, places, spans, regionLines}`（并发消费者读的字段一个没增删）',
    Object.keys(shape ?? {}).join(','),
  )
  const okShape = locate(SRC, { lines: { start: 8, end: 8 }, assert: '  return 0;', filePath: FILE })
  check(
    okShape.ok === true && Object.keys(okShape).sort().join(',') === 'actual,endLine,ok,startLine,tier',
    'E locate() 的成功回执仍是 {ok,startLine,endLine,tier,actual}',
    Object.keys(okShape).join(','),
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('── 附：与 C1 判据脚本的撞点（不改它，只点出来）──')
{
  const other = path.join(REPO_ROOT, 'src/locator-lab/assert-contains-test.mjs')
  if (fs.existsSync(other)) {
    const src = fs.readFileSync(other, 'utf8')
    const pinned = /'C 区间恰好落在其中一处上、且逐字全等 ⇒ 仍然拒绝/.test(src)
    say(`   assert-contains-test.mjs 里那条与分档相撞的 pin ${pinned ? '仍在' : '已不在'}：`)
    say('     c3「区间恰好落在其中一处上、且逐字全等 ⇒ 仍然拒绝」+ 段F 第二条不变量（通过 ⇒ 全文唯一）')
    say('     它们是 C1 的终态，与本单的终态在同一组形状上结论相反；该文件不在本单写范围内。')
    say('     实测翻转清单与两段原始读数见 .polaris/workorders/fs-contract-v2.C17.result.json。')
  } else {
    say('   （临时拷贝布局里没有这份判据脚本，跳过撞点提示）')
  }
}

const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`  FAIL: ${f.label}${f.detail ? `  ${f.detail}` : ''}`)
  process.exitCode = 1
}
