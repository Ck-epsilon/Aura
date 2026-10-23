/**
 * expect-single-source-test —— fs-contract-v2 波2 / C10：`expect` 判据单源化。
 *
 * ## 命题（施工单终态，判据不可改）
 *
 * 波1（C1）把 `expect` 的语义改成了「被受寻址区间**包含** + 该文本在全文件**唯一**（短引文除外）」，
 * 但那条判据当时只活在 `locate()` 里：写路径另有一道独立的**整段相等**闸门
 * （`PATCH_EXPECT_MISMATCH`），于是**同一个 `expect` 在两条路径上判出两种结果**。
 *
 * 改动前的原始读数（完整命令与退出码见 `.polaris/workorders/fs-contract-v2.C10.result.json`）：
 *
 *   locate(fragment): ok=true lines=1-7 tier=lines
 *   planHunks {"lines":[1,7]}               => PATCH_EXPECT_MISMATCH | hunk at line 1 matched via lines, but the content there differs from expect
 *   planHunks {"lines":"1,7"}               => PATCH_EXPECT_MISMATCH | （同上）
 *   planHunks {"start_line":1,"end_line":7} => PATCH_EXPECT_MISMATCH | （同上）
 *
 * 施工中还撞到同一件事的现场证据：用 `aura_basetools_edit` 改一个 11 行的区间、`expect` 只引其中一行时，
 * 编辑被**同一道闸门**拒了（回执 `lines 217-227 via lines do not match assert — the content there is: …`）——
 * 这道不一致连引擎自己的编辑路径都挡。
 *
 * 改动后：判据收敛成 `locator-api.expectVerdict` **唯一一处实现**（阈值 / 包含 / 全文件唯一 /
 * 候选清单形状全在里面），两条路径都读它的**结论**，只把结论翻成各自的码：
 *   · `locate()` 的 `assert` 闸门 → `LOCATOR_ASSERT_MISMATCH`（消息与 C1 逐字相同）
 *   · 写路径的 `expect` 闸门 → `PATCH_EXPECT_MISMATCH` / `PATCH_AMBIGUOUS` / `PATCH_NOT_FOUND`
 *
 * 「改动前必红」怎么复现（不动本仓一个文件）：把 `src` 整树拷到临时目录，
 * 只把拷贝里 `write-path.mjs` 的那道闸门换回 `normSpace(actual) !== normSpace(hunk.expect)`
 * （并把 import 里的 `expectVerdict, ASSERT_RELAX_MIN_CHARS` 去掉），再把本文件拷进去跑。
 * 实测：同一份本文件在改前的引擎上是 **24/42 通过、exit 1**（段A 九条全红；
 * 段D 的运行路径扫描当场抓出 `write-path.mjs:854 [P1,P3]`；段B/段C/段E 在内容寻址那一支全红），
 * 改后 **42/42、exit 0**。
 *
 * ## 段
 *
 *   A 片段引文经 hunk 路径 ⇒ 改中（三种 `lines` 写法 × 真落盘；改前三种全拒）
 *   B 区间内不含引文 ⇒ 拒绝（not_found 家族）+ 磁盘逐字节不变
 *   C 引文全文多处 ⇒ **按地址形态分档**：坐标档（区间=调用方给的坐标）通过；线索档（old / lineCue）
 *     仍拒且给候选 + 磁盘逐字节不变（C17）
 *   D 单源断言：运行路径上不存在第二份 `expect` 判定（可机械检的形态；带正对照与"抓不到什么"）
 *   E 短引文（< 12 字符）仍走整段相等，与 C1 同口径（11 / 12 边界）
 *
 * 落盘一律走 `applyEditToProvider`（DSH 壳 / CLI / MCP 共用的那条写路径），不是本套件自己编的。
 *
 * 跑法：`node src/locator-lab/expect-single-source-test.mjs`，全绿 exit 0。
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

/**
 * 判据样本：alpha / beta / gamma 三个函数，其中 beta 与 gamma 的两行**逐字相同**
 * （真实文件里重复代码块极常见），于是"全文多处"有真实形态：单行重复（第 10 / 18 行）。
 * 第 4 行 `return first * 2;` 全文件唯一，用来做"在文件里、但不在受寻址区间里"那一例。
 */
const SRC = [
  'export function alpha(input) {', // 1
  '  const first = helper(input);', // 2
  '  if (first > 0) {', // 3
  '    return first * 2;', // 4
  '  }', // 5
  '  return 0;', // 6
  '}', // 7
  '', // 8
  'export function beta(items) {', // 9
  '  let sum = 0;', // 10
  '  for (const item of items) {', // 11
  '    sum += item.price;', // 12
  '  }', // 13
  '  return sum;', // 14
  '}', // 15
  '', // 16
  'export function gamma(items) {', // 17
  '  let sum = 0;', // 18
  '  for (const item of items) {', // 19
  '    sum += item.price;', // 20
  '  }', // 21
  '  return sum;', // 22
  '}', // 23
  '', // 24
].join('\n')
const FILE = 'x.js'
const LINES = SRC.split('\n')
/** 1-based 闭区间的原文（逐字，含缩进）——判据与样本都用它构造，避免手抄出错。 */
const region = (start, end) => LINES.slice(start - 1, end).join('\n')

/** 仓库根（段B/段C 要核对壳层的判决表文本，段D 要全仓扫描）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const TMP = path.join(os.tmpdir(), `expect-single-source-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

/**
 * 与真提供方同形的文件提供方（形状照抄 `content-address-test` / `write-verify-test` 的 mock：
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
const brief = (error) =>
  error === null || error === undefined
    ? 'no error (这次没有拒绝)'
    : `${error.code ?? '?'} ${String(error.message ?? error).slice(0, 150)}`

// ════════════════════════════════════════════════════════════════════════════
say('=== 段A：片段引文经 hunk 路径 ⇒ 改中（改前：三种 lines 写法全被 PATCH_EXPECT_MISMATCH 拒）===')
{
  const QUOTE = 'const first = helper(input);'
  const ADDRESSED = region(1, 7)

  check(
    ADDRESSED !== QUOTE && ADDRESSED.includes(QUOTE),
    'A 样本事实核对：引文只是区间(1-7)原文里的一行 —— 这一例确实不是"整段相等"',
    `区间 ${ADDRESSED.length} 字符 / 引文 ${QUOTE.length} 字符`,
  )

  const byLocate = locate(SRC, { lines: { start: 1, end: 7 }, assert: QUOTE, filePath: FILE })
  check(
    byLocate.ok === true && byLocate.startLine === 1 && byLocate.endLine === 7,
    'A 同一份引文在 locate() 里通过（改前就是这条在通过，两条路径的分歧从这里开始）',
    byLocate.ok ? `ok tier=${byLocate.tier} lines=${byLocate.startLine}-${byLocate.endLine}` : brief(byLocate),
  )

  /** 三种 `lines` 写法：模型在真机上就是这么写的（数组 / 字符串 / 拆成 start_line+end_line）。 */
  const forms = [
    { label: 'lines: [1, 7]', hunk: { lines: [1, 7] } },
    { label: 'lines: "1,7"', hunk: { lines: '1,7' } },
    { label: 'start_line: 1, end_line: 7', hunk: { start_line: 1, end_line: 7 } },
  ]
  for (const form of forms) {
    const c = fresh(SRC)
    const r = await attempt(c, [{ ...form.hunk, expect: QUOTE, replace: 'REPLACED' }])
    check(
      r.ok === true && r.out.applied.length === 1 && r.out.applied[0].line === 1,
      `A hunk 经 ${form.label} + 片段引文 ⇒ 改中（走真写路径，不是只看 planHunks）`,
      r.ok ? `line ${r.out.applied[0].line} tier=${r.out.applied[0].tier}` : brief(r.error),
    )
    check(
      r.ok === true && c.read() === SRC.replace(ADDRESSED, 'REPLACED'),
      `A ${form.label} 磁盘只换掉被寻址的那一段（其余逐字不动）`,
      JSON.stringify(c.read().split('\n')[0]),
    )
  }

  /** 再单独钉一次 `planHunks`（施工单点名的那个入口）：三种写法都要能规划出来。 */
  for (const form of forms) {
    let planned
    try {
      planned = planHunks(SRC, [{ ...form.hunk, expect: QUOTE, replace: 'X' }], FILE)
    } catch (error) {
      planned = error
    }
    check(
      !(planned instanceof Error) && planned.applied.length === 1 && planned.applied[0].line === 1,
      `A planHunks(${form.label}) 规划成功（改前：PATCH_EXPECT_MISMATCH）`,
      planned instanceof Error ? brief(planned) : `applied=${planned.applied.length}`,
    )
  }
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段B：区间内根本不含引文 ⇒ 拒绝（not_found 家族），磁盘不变 ===')
{
  const QUOTE = 'return first * 2;' // 全文唯一（第 4 行），但不在 9-15 这一段里
  const addressed = region(9, 15)

  const v = expectVerdict(LINES, 9, 15, addressed, QUOTE)
  check(
    v !== null && v.kind === 'outside',
    'B 判据结论 kind=outside（引文在文件里，但唯一出现处落在区间之外）',
    v === null ? 'null（放过了）' : `${v.kind} at line ${v.at.line}`,
  )

  const byLocate = locate(SRC, { lines: { start: 9, end: 15 }, assert: QUOTE, filePath: FILE })
  check(
    byLocate.ok === false && byLocate.code === 'LOCATOR_ASSERT_MISMATCH' && /is outside the addressed region/.test(byLocate.message),
    'B locate() 拒绝，并点出那处唯一出现的位置（回执可执行）',
    byLocate.ok ? 'ok（放过了）' : String(byLocate.message).slice(0, 120),
  )

  // 定位那一支（lines 寻址）：expect 由 locate() 判 —— 码与 C1 同码
  const c1 = fresh(SRC)
  const r1 = await attempt(c1, [{ lines: [9, 15], expect: QUOTE, replace: 'X' }])
  check(
    r1.ok === false && r1.error.code === 'LOCATOR_ASSERT_MISMATCH',
    'B hunk 经 lines 寻址 ⇒ 拒绝（码 LOCATOR_ASSERT_MISMATCH，壳层判成 outcome=not_found）',
    brief(r1.error),
  )
  check(c1.read() === SRC, 'B 磁盘逐字节不变', `${c1.read().length}B`)

  // 内容寻址那一支（old）：闸门在这里（locate 没参与 expect 判定）
  const c2 = fresh(SRC)
  const r2 = await attempt(c2, [{ old: 'export function alpha(input) {', expect: QUOTE, replace: 'X' }])
  check(
    r2.ok === false && r2.error.code === 'PATCH_NOT_FOUND' && /outside the addressed region/.test(String(r2.error.message)),
    'B hunk 经 old 寻址 ⇒ 拒绝（PATCH_NOT_FOUND，改前这里是"整段相等"的另一份判据）',
    brief(r2.error),
  )
  check(c2.read() === SRC, 'B old 寻址下磁盘也逐字节不变', `${c2.read().length}B`)

  // 引文在全文件根本不存在
  const c3 = fresh(SRC)
  const r3 = await attempt(c3, [{ old: 'export function alpha(input) {', expect: 'const neverWritten = 1;', replace: 'X' }])
  check(
    r3.ok === false && r3.error.code === 'PATCH_NOT_FOUND' && /nowhere in this file/.test(r3.error.message),
    'B 引文全文不存在 ⇒ 拒绝并明说"全文没有"（比"不符"更可执行）',
    brief(r3.error),
  )
  check(c3.read() === SRC, 'B 磁盘逐字节不变', `${c3.read().length}B`)

  /**
   * 壳层判决表的**静态核对**：上面那个 `PATCH_NOT_FOUND` 要真能变成 outcome=not_found，
   * 靠的是 `aura-edit/index.js` 的 `OUTCOME_BY_CODE`。这里只按文本核对它的取值
   * （不 import 壳：那是 `aura-edit/outcome-test.mjs` 的活，本套件不重复造一份 mock）。
   */
  const shell = fs.readFileSync(path.join(REPO_ROOT, 'src/aura-edit/index.js'), 'utf8')
  check(
    /\['PATCH_NOT_FOUND',\s*'not_found'\]/.test(shell) && /\['PATCH_EXPECT_MISMATCH',\s*'not_found'\]/.test(shell),
    'B 壳层判决表把 PATCH_NOT_FOUND / PATCH_EXPECT_MISMATCH 都收进 not_found（"not_found" 由此成立）',
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段C：引文全文多处 ⇒ 按地址形态分档：坐标档通过 / 线索档仍拒且给候选（C17）===')
/**
 * 唯一性不是判据的目的，而是“这个地址是否明确”的**代理**。调用方自己写出精确坐标（`lines`）时，
 * 受寻址区间就是地址本身，“这段文字在全文件还有没有第二处”不再提供关于“你指的是哪儿”的信息，
 * 却会误伤坐标给准的调用 ⇒ 唯一性这一档免掉（`tier === 'lines'`）。地址来自**线索**（`old` /
 * `lineCue` / `anchor` / `target`）时区间是引擎算出来的，引文不唯一就判不出意图 ⇒ 照旧拒绝。
 * 分档的边界一条不放：**区间内不含该文本时仍拒**（段B 钉的就是它）。
 *
 * 线索档那一条**必须用区间真的含引文的样本**（`region(9, 15)`），否则拒绝来自「区间内不含该文本」
 * 那一支，而不是来自分档 —— 那样即便把放宽延伸到 `lineCue`，断言照旧打印 ✓（改前正是如此：
 * 样本 `region(3, 3)` 的实际内容是 `  if (first > 0) {`，一条没有判定力的断言）。
 */
{
  const QUOTE = 'let sum = 0;' // 归一化后 12 字符（正好到放松阈值），全文 2 处：第 10、18 行
  const addressed = region(9, 15)

  // ── 旧调用（不传第 6 参）：最严一档仍然有效，分档开关是**声明式**的，不是默认放松
  const v = expectVerdict(LINES, 9, 15, addressed, QUOTE)
  check(
    v !== null && v.kind === 'not_unique' && v.places.length === 2,
    'C 旧 5 参调用（不声明地址形态）⇒ kind=not_unique 且给出 2 处（默认不放宽）',
    v === null ? 'null（放过了）' : `${v.kind} places=${v.places.map((p) => p.line).join(',')}`,
  )
  check(
    v !== null &&
      v.places.every((p) => Number.isInteger(p.line) && Number.isInteger(p.endLine) && typeof p.text === 'string'),
    'C 候选清单只有一种形状 {line, endLine, text}（与 C1 同一份，写路径不再自造）',
    JSON.stringify(v?.places?.map((p) => ({ line: p.line, endLine: p.endLine, text: p.text }))),
  )
  check(
    expectVerdict(LINES, 9, 15, addressed, QUOTE, 'lines') === null &&
      expectVerdict(LINES, 9, 15, addressed, QUOTE)?.kind === 'not_unique',
    'C 分档开关可机械核对：同址同引文，第 6 参="lines" ⇒ 通过；不传 ⇒ not_unique（收回忆放宽则本条必红）',
    `tier=lines ⇒ ${expectVerdict(LINES, 9, 15, addressed, QUOTE, 'lines') === null ? 'pass' : 'reject'} / 不传 ⇒ ${expectVerdict(LINES, 9, 15, addressed, QUOTE)?.kind ?? 'pass'}`,
  )

  // ── 坐标档：`lines` 寻址时区间就是地址 ⇒ 通过（C17）；改前这两条必红
  const byLocate = locate(SRC, { lines: { start: 9, end: 15 }, assert: QUOTE, filePath: FILE })
  check(
    byLocate.ok === true && byLocate.actual === addressed && byLocate.candidates === undefined,
    'C locate() 经 lines 寻址 ⇒ 通过，且 actual 就是那段区间原文（引文全文 2 处不再当歧义）—— 定位那一支',
    byLocate.ok
      ? `lines=${byLocate.startLine}-${byLocate.endLine} tier=${byLocate.tier}`
      : `${byLocate.code}: ${byLocate.message}`,
  )

  const c1 = fresh(SRC)
  const r1 = await attempt(c1, [{ lines: [9, 15], expect: QUOTE, replace: 'X' }])
  check(
    r1.ok === true && r1.out.applied.length === 1 && r1.out.applied[0].line === 9,
    'C hunk 经 lines 寻址 ⇒ 改中（改前：LOCATOR_ASSERT_MISMATCH + 两个候选）',
    r1.ok ? `applied=${r1.out.applied.length} line=${r1.out.applied[0]?.line}` : brief(r1.error),
  )
  check(
    c1.read().includes('X') && c1.read().includes('  let sum = 0;\n  for (const item of items) {\n'),
    'C 磁盘：被寻址那一段真被换掉，另一处重复代码块一字未动',
    `${c1.read().length}B`,
  )

  // ── 线索档：同一份引文，地址来自 `old` ⇒ 仍拒且给候选（老调用一个字不改地拿到旧结论）
  const c2 = fresh(SRC)
  const r2 = await attempt(c2, [{ old: 'export function beta(items) {', expect: QUOTE, replace: 'X' }])
  check(
    r2.ok === false && r2.error.code === 'PATCH_AMBIGUOUS' && (r2.error.candidates ?? []).length === 2,
    'C hunk 经 old 寻址（内容寻址不传 tier）⇒ 仍 PATCH_AMBIGUOUS + 两个候选',
    brief(r2.error),
  )
  check(
    r2.ok === false && /candidates: line 10 = /.test(r2.error.message) && /line 18 = /.test(r2.error.message),
    'C 候选也写进 message（框架只读 error.message，挂成字段等于没给）',
    String(r2.error?.message ?? '').slice(-120),
  )
  check(c2.read() === SRC, 'C 线索档被拒时磁盘逐字节不变', `${c2.read().length}B`)

  // ── 线索档的另一支：`locate()` 的 lineCue 层（区间由引擎猜）⇒ 同样不参与分档
  // 与上面坐标档**同址同引文**（region(9,15) + 第 10 / 18 行那句），唯一变量是第 6 参 —— 这样
  // 这一条的判定力只可能来自"分档把 lineCue 挡在外面"这一件事。
  // 改前这里用的是 region(3,3)：它的实际内容是 `  if (first > 0) {`，**不含**引文，于是"仍拒"是
  // 「区间内不含该文本」那一支拒的，与线索档无关 —— 把放宽延伸到 lineCue 也照样绿（实测）。
  // 样本事实（区间真的含引文）并进**同一条**断言的合取项里，而不是另开一条：本套件的断言总数被
  // `old-fragment-fallback-test` 段D1 钉成 44/44（`/44\/44 通过/`），多一条就会在那边变红。
  const cueRegion = region(9, 15)
  const cue = expectVerdict(LINES, 9, 15, cueRegion, QUOTE, 'lineCue')
  check(
    cueRegion.includes(QUOTE) &&
      cue !== null &&
      cue.kind === 'not_unique' &&
      cue.places.map((p) => p.line).join(',') === '10,18',
    'C 线索档（tier="lineCue"）在区间真含引文时仍拒，且点出 10 / 18 两处（样本被换成不含引文的区间、或放宽延伸到 lineCue ⇒ 本条当场必红）',
    `样本区间(9-15) 含引文=${cueRegion.includes(QUOTE)} / ${cue === null ? 'null（放过了）' : `${cue.kind} places=${cue.places.map((p) => p.line).join(',')}`}`,
  )

  const shell = fs.readFileSync(path.join(REPO_ROOT, 'src/aura-edit/index.js'), 'utf8')
  check(
    /\['PATCH_AMBIGUOUS',\s*'needs_choice'\]/.test(shell),
    'C 壳层判决表把 PATCH_AMBIGUOUS 判成 needs_choice（"needs_choice" 由此成立）',
  )
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段D：单源断言 —— 运行路径上没有第二份 expect 判定（可机械检的形态）===')
/**
 * 抓什么（三条正则，先剥注释再匹配）：
 *   P1 `norm*(…) <比较算子> norm*(…)` —— **双向归一化后比较**：改前写路径闸门的确切形态
 *      （`normSpace(actual) !== normSpace(hunk.expect)`），也是"同一个 expect 判出两种结果"的载体。
 *   P2 `norm*(…).includes(` —— **归一化后做包含**：把 C1 的"包含"判据就地写第二遍。
 *   P3 同一行里同时出现 归一化调用 / `expect|assert` 操作数 / 比较算子 —— 就地判 expect 的气味，
 *      抓的是"换个写法绕开 P1/P2 字面"的那种。
 * 另加两条**配线**断言（防"没有第二份，因为一份都没有"）：
 *   · 写路径 import 并调用 `expectVerdict`，且 `locate()` 那一支也调它；
 *   · 阈值 `ASSERT_RELAX_MIN_CHARS = 12` 全仓只有一份定义。
 *
 * 抓不到什么（如实写下，别把它当万能的）：
 *   · **变量化后**的同一判定（`const have = normSpace(a); const want = normSpace(b); have !== want`）——
 *     形态不匹配 P1/P2；
 *   · 用**别的归一化**写的第二份判定（`toLowerCase()`、自定义 `replace(/\s+/g,' ')`、`localeCompare`）——
 *     字面不含 `normSpace|normTrim`；
 *   · 动态构造（`eval`、拼函数名、从配置里读谓词）——正则看不见；
 *   · 靶场文件（`*-test.mjs` / `*-probe.mjs` 之类）里的同形表达式 —— 按名放过（**会列出来**，
 *     不静默；代价是"藏在靶场里的第二份判定"抓不到，它不是发货路径，但会污染探针读数）；
 *   · 注释里的写法 —— 注释先被剥掉。这条是刻意的：本仓把"这里曾经是 X"写在注释里是惯例
 *     （`locator-api` 与 `write-path` 各有一处），那是沿革说明，不是第二份判定。
 *   · 剥注释本身是粗粒度的：字符串字面量里的 `//`（如 URL）会把它后面的同一行截掉 ——
 *     方向是"可能漏掉同一行后半段的命中"，不是"误报"。
 */
/** 剥注释但**保持行结构**（行号不能错位）。粗粒度，局限见上。 */
const stripComments = (text) => {
  let out = ''
  let inBlock = false
  for (const line of text.split('\n')) {
    let rest = line
    let kept = ''
    for (;;) {
      if (inBlock) {
        const end = rest.indexOf('*/')
        if (end === -1) break
        rest = rest.slice(end + 2)
        inBlock = false
        continue
      }
      const block = rest.indexOf('/*')
      const lineComment = rest.indexOf('//')
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        kept += rest.slice(0, lineComment)
        break
      }
      if (block === -1) {
        kept += rest
        break
      }
      kept += rest.slice(0, block)
      rest = rest.slice(block + 2)
      inBlock = true
    }
    out += `${kept}\n`
  }
  return out
}

const BANNED = [
  { id: 'P1', re: /\bnorm(Space|Trim)\s*\([^)]*\)\s*(?:===|!==|==|!=)\s*\bnorm(Space|Trim)\s*\(/ },
  { id: 'P2', re: /\bnorm(Space|Trim)\s*\([^)]*\)\s*\.\s*includes\s*\(/ },
  { id: 'P3', re: /^(?=.*\bnorm(Space|Trim)\b)(?=.*\b(?:expect|assert)\b)(?=.*(?:===|!==|==|!=)).*$/ },
]

/** 生成物与运行时目录：`dist/` 由 `build/make-bundle.mjs` 从 `src/` 生成（派生物，改了也会被覆盖），
 *  其余是快照/日志/临时/依赖。它们既不是"第二份实现"，也不该让判据抖动。 */
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

/** 靶场/量具/判据脚本：文件名里带这些词的不算"发货的运行路径"。 */
const isHarness = (rel) => /(-test|-probe|-replay|-scan|bench|smoke|audit|corpus)\.mjs$/.test(rel)
const isRunPath = (rel) => rel.startsWith('src/') && !isHarness(rel)
const classify = (rel) => (isRunPath(rel) ? 'runpath' : isHarness(rel) ? 'harness' : rel.startsWith('.polaris/') ? 'snapshot' : 'other')

{
  const files = walk(REPO_ROOT)
  const hits = []
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/')
    const lines = stripComments(fs.readFileSync(abs, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      const ids = BANNED.filter((b) => b.re.test(line)).map((b) => b.id)
      if (ids.length > 0) hits.push({ rel, line: i + 1, ids, text: line.trim().slice(0, 110), where: classify(rel) })
    })
  }
  const runpath = hits.filter((h) => h.where === 'runpath')
  const control = hits.filter((h) => h.rel.endsWith('locator-lab/assert-contains-test.mjs'))

  check(
    runpath.length === 0,
    `D 运行路径（src/** 里非靶场的 ${files.filter((f) => isRunPath(path.relative(REPO_ROOT, f).split(path.sep).join('/'))).length} 个文件）没有第二份 expect 判定`,
    runpath.map((h) => `${h.rel}:${h.line} [${h.ids}] ${h.text}`).slice(0, 3).join(' | '),
  )
  check(
    control.length >= 2,
    'D 正对照：扫描器确实看得见同形表达式（C1 判据脚本里的两条断言被点名）——防止"因为正则坏掉所以全绿"',
    control.map((h) => `${h.line}[${h.ids}]`).join(', '),
  )

  const sourceOf = (rel) => stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
  const LOCATOR = 'src/locator-lab/locator-api.mjs'
  const WRITE = 'src/locator-lab/write-path.mjs'
  check(/export function expectVerdict\(/.test(sourceOf(LOCATOR)), 'D 唯一入口真的导出了：locator-api.mjs `export function expectVerdict(`')
  check(
    /import \{[^}]*\bexpectVerdict\b[^}]*\} from '\.\/locator-api\.mjs'/.test(sourceOf(WRITE)),
    'D 写路径 import 的是同一入口（不是自己再实现一份）',
  )
  check(
    (sourceOf(WRITE).match(/expectVerdict\(/g) ?? []).length >= 1,
    'D 写路径真的调它（不是只 import 不用）',
    `${(sourceOf(WRITE).match(/expectVerdict\(/g) ?? []).length} 处调用`,
  )
  check(
    (sourceOf(LOCATOR).match(/expectVerdict\(/g) ?? []).length >= 2,
    'D locate 那一支也走同一入口（定义 1 处 + 调用 1 处 ≥ 2）',
    `${(sourceOf(LOCATOR).match(/expectVerdict\(/g) ?? []).length} 处`,
  )

  const thresholdDefs = []
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/')
    if (!isRunPath(rel) && !isHarness(rel)) continue
    const hit = stripComments(fs.readFileSync(abs, 'utf8')).match(/ASSERT_RELAX_MIN_CHARS\s*=\s*(\d+)/)
    if (hit !== null) thresholdDefs.push(`${rel} = ${hit[1]}`)
  }
  check(
    thresholdDefs.length === 1 && thresholdDefs[0] === `${LOCATOR} = 12`,
    'D 阈值也只有一份定义（12 不许在别处重写）',
    thresholdDefs.join(' | '),
  )

  say(`   扫描范围：全仓 ${files.length} 个 .mjs/.js（跳过 ${[...SKIP_DIRS].join(' / ')}）`)
  const others = hits.filter((h) => h.where !== 'runpath')
  for (const h of others) say(`   · ${h.where} ${h.rel}:${h.line} [${h.ids}] ${h.text}`)
}

// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段E：短引文（< 12 字符）仍走整段相等 —— 与 C1 同口径 ===')
{
  const SHORT = 'const first' // 归一化后 11 字符
  const EDGE = 'return first' // 归一化后 12 字符（正好到阈值）
  check(
    ASSERT_RELAX_MIN_CHARS === 12 && normSpace(SHORT).length === 11 && normSpace(EDGE).length === 12,
    'E 边界样本长度核对（归一化后 11 / 12）+ 阈值取自 locator-api 的同一条常量',
    `${normSpace(SHORT).length}/${normSpace(EDGE).length}, ASSERT_RELAX_MIN_CHARS=${ASSERT_RELAX_MIN_CHARS}`,
  )

  const v11 = expectVerdict(LINES, 1, 7, region(1, 7), SHORT)
  check(
    v11 !== null && v11.kind === 'short_mismatch',
    'E 11 字符被区间包含 ⇒ 仍拒绝（短引文不参与放松，不是"包含即通过"）',
    v11 === null ? 'null（放过了）' : v11.kind,
  )

  const c11 = fresh(SRC)
  const r11 = await attempt(c11, [{ old: '  const first = helper(input);', expect: SHORT, replace: 'X' }])
  check(
    r11.ok === false && r11.error.code === 'PATCH_EXPECT_MISMATCH' && /shorter than 12 chars/.test(r11.error.message),
    'E hunk（old 寻址）⇒ PATCH_EXPECT_MISMATCH，且回执明写"这次为什么仍要求整段相等"',
    brief(r11.error),
  )
  check(c11.read() === SRC, 'E 磁盘逐字节不变', `${c11.read().length}B`)

  const c12 = fresh(SRC)
  const r12 = await attempt(c12, [{ old: '    return first * 2;', expect: EDGE, replace: '    return first * 3;' }])
  check(
    r12.ok === true && c12.read() === SRC.replace('    return first * 2;', '    return first * 3;'),
    'E 12 字符（正好到阈值）被区间包含 ⇒ 通过（放松的那一侧边界）',
    r12.ok ? `line ${r12.out.applied[0]?.line}` : brief(r12.error),
  )

  const cEq = fresh(SRC)
  const rEq = await attempt(cEq, [{ old: '  return 0;', expect: '  return 0;', replace: '  return 1;' }])
  check(
    rEq.ok === true && cEq.read() === SRC.replace('  return 0;', '  return 1;'),
    'E 短引文与区间整段相等 ⇒ 仍然通过（改前的正确路径不因单源化而变）',
    rEq.ok ? `line ${rEq.out.applied[0]?.line}` : brief(rEq.error),
  )
}

// ════════════════════════════════════════════════════════════════════════════
fs.rmSync(TMP, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- ${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) process.exitCode = 1
