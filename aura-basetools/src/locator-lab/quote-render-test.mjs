/**
 * quote-render-test —— C38：错误回执里那段「原文是什么」，回抄回去要能逐字命中原文。
 *
 * ## 病（上一波实测，唯一一条工具侧可修的引文污染：F0275）
 *
 * 错误回执把 4 行 import 渲染成**一行**、用字面量 `⏎` 连接：
 *
 *   `the content there is: “import fs from 'node:fs'⏎import path from 'node:path'⏎…`
 *
 * 调用方把这段引文整块拓回进 `expect`，拿到的是**单行字符串**，而原文里永远没有这样一行。
 * 实测：去污（把 `⏎` 还原成换行）前 fail 174，去污后 173 —— **洗活的唯一一条就是它**。
 * 也就是说，回执里那段专门用来让调用方回抄的文本，**回抄回去命中不了原文**。
 *
 * 当时用 `⏎` 不是没理由（换行位置本身就是信息，"你这几行其实是一行"是常见误判）。
 * 所以这一单不是删掉 `⏎`，而是**让可回抄的那一份是忠实的**：摘要原样留（它确实更直读），
 * 忠实块另起一份（它确实能抄），两者各自标明身份。
 *
 * ## "改动前"基准从哪来（C9：不再依赖 `dist/aura-tools` 这份旧产物）
 *
 *   · `fixtures/frozen-engine-0.6.1-217798da/locator-lab/` —— failure-replay 那条线的冻结基准（0.6.1）。
 *     **段A 用它复现病**：同一个输入，它的引文里确实有字面量 `⏎`，且整块抄回去命中不了。
 *   · 段B/C/D/E 也要一份同一套语义的"改动前"。旧写法读 `dist/aura-tools/locator-lab/`（C38 之前
 *     那一份构建产物）—— 那是**包目录名 + 旧产物**双重假设：仓 clone 到别的目录名、或 dist 里
 *     没有这份旧产物（新仓只有现构建的 `dist/<包名>/`）时直接 ENOENT。C9 把它换成显式探测：
 *     先试冻结件，冻结件不齐（0.6.1 尚在 `expectVerdict` 之前，也没有 C38 之后那一套语义）就按
 *     下面这条**降级口径**处理，而且**每次都把原因印出来**，不静默跳过：
 *
 *       段B–E 的"改动前"退化为自比（= 本次源码）：等价断言仍然成立（等价本来就成立），
 *       只是少了对照；段A 的病侧不依赖它（用冻结夹具），所以"复现 F0275"这件事不受影响。
 *
 * ## 段
 *
 *   A 多行原文的引用里是**真换行**
 *   B 紧凑摘要仍在，且带**明确的不可回抄标记**；
 *   C 最坏情况下回执体量 ≤ 宿主阈值（`toolResultPruner.thresholdChars`，现读现用）；
 *   D 单行原文的引用形态与改动前**逐字节等价**（单行场景一个字节都不许改坏）；
 *   E 负向不变量：渲染改动**不影响任何判定**（`expectVerdict` 返回值逐字段不变）；
 *   F 覆盖面：全部"引用原文给调用方看"的落点都走**同一份渲染**（不许只修一处）。
 *
 * ## C41 补的三条判据（本波新增 —— 上一波独立验收实测出的三处“声称覆盖了、实际没有”）
 *
 *   · 段A A11–A13：**真走 `old + expect`** 落到写路径自己的 `expectGateError`。原先 C4/A5 用的是
 *     `lines + expect`，而那一路的 `expect` 闸与回执**都由 `locator-api.locate` 渲染**
 *     （`planHunks` 里 `if (oldText !== null && hunk.expect …)` 才走写路径那支）——
 *     所以那个落点从来没被走到。实测：把 `expectGateError` 里 `quoteForMessage(actual, line)`
 *     的**行号参数丢掉**（行号边距与带边距的身份句一起消失），本套件仍旧 58/58 exit 0。
 *   · 段B B8–B12：「那一带」的长行经 `clipReceiptLine` 裁剪，而裁剪处原先**没有**不可回抄标记，
 *     身份句却无条件宣称 byte-for-byte。实测：行宽 600 时回执给 221 字符 / 原文 615 字符，
 *     行宽 200 时 216 / 215。现在裁剪处带 `NOT copyable`、身份句带同一条例外条款，
 *     判据**逐行核对“标记 ⟺ 这一行真的不是逐字节”**（两个方向都咬）。
 *   · 段C C4b/C10/C11：`old` 歧义那一支原先完全不夹 `label`（病态路径下 22479 字符，
 *     阈值 8192；且 C38 的净增量把 label 长度 ~5798 起的**原本合规**回执顶过了线）。
 *     现在清单先算、剩下的才给 `label`，判据在**整段 label 带宽**上逐点扫，不是只查一个样本。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pkgPath } from '../../build/pkg-root.mjs'
import { expectVerdict, locate, quoteForMessage } from './locator-api.mjs'
import { planHunks } from './write-path.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
/** 注意参数序：**判据标签在前**（与 `notfound-receipt-test` 同一口径，不是 `assert-contains-test` 那份）。 */
const check = (label, ok, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** failure-replay 的冻结基准（0.6.1）—— 段A 的病侧。 */
const frozenApi = await import(
  pathToFileURL(pkgPath('fixtures', 'frozen-engine-0.6.1-217798da', 'locator-lab', 'locator-api.mjs')).href,
)

/**
 * “改动前”基准的解析：**先试冻结件**（`fixtures/frozen-engine-0.6.1-217798da/locator-lab/`），
 * 冻结件本来就是 failure-replay 那条线的“升级前”。
 *
 * 但冻结件是 0.6.1，**尚在 `expectVerdict` 之前**：段E 要逐字段比 `beforeApi.expectVerdict`，
 * 段B/C/D 也要同一套 `locate` / `planHunks` 语义（0.6.1 与现树之间除了 C38 还有别的改动，
 * 拿它当“改动前”会把无关差异算到这一单头上）。所以探测不齐时按文件头写明的降级口径：
 * 段B–E 退化为自比（= 本次源码），段A 仍用冻结夹具复现病 —— 并且**把原因显式印出来**。
 */
async function resolveBeforeBaseline() {
  const frozenDir = pkgPath('fixtures', 'frozen-engine-0.6.1-217798da', 'locator-lab')
  const required = { api: ['locate', 'expectVerdict'], write: ['planHunks'] }
  const missing = []
  let api = null
  let write = null
  try {
    api = await import(pathToFileURL(path.join(frozenDir, 'locator-api.mjs')).href)
    write = await import(pathToFileURL(path.join(frozenDir, 'write-path.mjs')).href)
  } catch (error) {
    missing.push(`冻结件 import 失败：${error?.message ?? error}`)
  }
  if (api !== null) for (const name of required.api) if (typeof api[name] !== 'function') missing.push(`locator-api.${name}`)
  if (write !== null) for (const name of required.write) if (typeof write[name] !== 'function') missing.push(`write-path.${name}`)
  if (missing.length === 0) {
    return { api, write, source: 'fixtures/frozen-engine-0.6.1-217798da/locator-lab/', contrast: true }
  }
  return {
    api: await import(new URL('./locator-api.mjs', import.meta.url)),
    write: await import(new URL('./write-path.mjs', import.meta.url)),
    source: '本次源码（自比）',
    contrast: false,
    why: missing.join('、'),
  }
}

const before = await resolveBeforeBaseline()
const beforeApi = before.api
const beforeWrite = before.write
/** 把“用的是哪一份、对照还有没有、降级为什么”印在头上：不许让基准静默漂掉。 */
say(
  `  "改动前"基准 = ${before.source}：${
    before.contrast
      ? '冻结件可用，对照有效'
      : `冻结件不可用（缺 ${before.why}）⇒ 按文件头降级：段B–E 退化为自比，段A 仍用冻结夹具复现病`
  }`,
)

// ════════════════════════════════════════════════════════════════════════════
// 夹具与助手
// ════════════════════════════════════════════════════════════════════════════

/** F0275 的形状：4 行 import，逐字不同、行行非空。 */
const IMPORTS = [
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  "import crypto from 'node:crypto'",
  "import os from 'node:os'",
]
const IMPORT_SRC = `${[...IMPORTS, '', 'const a = 1', 'const b = 2', ''].join('\n')}`
/** 一份与原文毫不相干的引文（保证走"不存在"那一支，回执照贴区间原文）。 */
const NOPE = 'zzz-not-in-this-file-zzz'

/**
 * 回执里那段**可回抄**的原文，按回执**自己声明的规则**取：
 * 身份句里写着「`N| ` 是行号、不是文件内容」，所以去掉 `N| ` 边距就是文件原文。
 *
 * 判据不靠猜格式：行号从 `startLine` 起逐行取，取不到就返回 null（格式变了当场红）。
 */
const VERBATIM_MARK = 'not part of the file:'
const copyBack = (message, startLine, endLine) => {
  const at = String(message ?? '').indexOf(VERBATIM_MARK)
  if (at < 0) return null
  const tail = String(message).slice(at + VERBATIM_MARK.length)
  const rows = []
  for (let n = startLine; n <= endLine; n += 1) {
    // `[=!]?` 就是"那一带"那处多出来的匹配标记（= 逐字对上 / ! 对不上），它也是边距。
    const m = new RegExp(`(?:^|\\n)[=!]?${n}\\| ([^\\n]*)`).exec(tail)
    if (m === null) return null
    rows.push(m[1])
  }
  return rows.join('\n')
}

/** 回执里那段**紧凑摘要**（`the content there is: “…”`），逐字取出。 */
const preview = (message) => {
  const m = /the content there is: (“[^”]*”)/.exec(String(message ?? ''))
  return m === null ? null : m[1]
}
/** 回执里"那一带"的逐行原文（`N| ` 边距之后的一切）。 */
const bandRows = (message, first, last) => copyBack(message, first, last)

const planOr = (mod, content, hunks, filePath) => {
  try {
    return { ok: true, out: mod.planHunks(content, hunks, filePath) }
  } catch (error) {
    return { ok: false, error }
  }
}
const msgOf = (r) => (r.ok ? '' : String(r.error?.message ?? ''))
/** 同一份输入在"改动前"那一份上的回执。 */
const msgBefore = (content, hunks, filePath) => {
  try {
    beforeWrite.planHunks(content, hunks, filePath)
    return ''
  } catch (error) {
    return String(error.message ?? '')
  }
}

/** 剥掉整行注释再扫源码（口径与 `notfound-receipt-test` 段「运行路径扫描」一致）。 */
const codeOnly = (source) =>
  source
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')

// ════════════════════════════════════════════════════════════════════════════
say('=== 段A：多行原文的引用是真换行，且能逐字回抄 ===')
{
  // ── A0 病侧：冻结基准（0.6.1）上复现 F0275
  const sick = frozenApi.locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, assert: NOPE, filePath: 'x.mjs' })
  const sickPreview = preview(sick.message)
  check(
    'A0 冻结基准上复现病：引文用字面量 `⏎` 把 4 行连成一行',
    sickPreview.includes('\u23ce') && !sickPreview.includes('\n'),
    `${sickPreview.length} 字符 / 含 ⏎=${sickPreview.includes('\u23ce')}`,
  )
  const sickBody = sickPreview.replace(/^\u201c|\u201d$/g, '')
  const sickReuse = frozenApi.locate(IMPORT_SRC, {
    lines: { start: 1, end: 4 },
    assert: sickBody,
    filePath: 'x.mjs',
  })
  check(
    'A0b 且把那段引文**整块原样**回抄回去 ⇒ 命中不了原文（这就是 F0275）',
    sickReuse.ok === false,
    `ok=${sickReuse.ok} code=${sickReuse.code ?? ''}`,
  )
  const sickFixed = frozenApi.locate(IMPORT_SRC, {
    lines: { start: 1, end: 4 },
    assert: sickBody.split('\u23ce').join('\n'),
    filePath: 'x.mjs',
  })
  check(
    'A0c 而把 `⏎` 还原成真换行后**当场命中** ⇒ 病在渲染层，不在原文、也不在调用方',
    sickFixed.ok === true,
    `ok=${sickFixed.ok}`,
  )

  // ── A1..A4 现在：同一输入，引文段里是真换行、且能逐字回抄
  const now = locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, assert: NOPE, filePath: 'x.mjs' })
  const block = copyBack(now.message, 1, 4)
  check('A1 回执给出了可回抄的原文块（身份句 + `N| ` 行号边距）', block !== null, JSON.stringify(block))
  check('A2 原文块里是**真换行**，逐行就是文件那 4 行', block === IMPORTS.join('\n'), JSON.stringify(block))
  check(
    'A3 原文块里**没有**字面量 `⏎`（`⏎` 只允许留在标明不可回抄的摘要里）',
    !String(block).includes('\u23ce'),
    `⏎ 出现 ${(String(block).match(/\u23ce/g) ?? []).length} 次`,
  )
  const reuse = locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, assert: block, filePath: 'x.mjs' })
  check('A4 把那段原样回抄进 expect（地址不变）⇒ **逐字命中**，这一次通过', reuse.ok === true, `ok=${reuse.ok} code=${reuse.code ?? ''}`)
  const reuseNoAddress = locate(IMPORT_SRC, { anchor: block, filePath: 'x.mjs' })
  check(
    'A4b 不靠坐标、只用这段原文做 anchor ⇒ 也命中（说明它就是原文，不是回执的转述）',
    reuseNoAddress.ok === true && reuseNoAddress.startLine === 1 && reuseNoAddress.endLine === 4,
    `ok=${reuseNoAddress.ok} ${reuseNoAddress.startLine ?? ''}-${reuseNoAddress.endLine ?? ''} tier=${reuseNoAddress.tier ?? ''}`,
  )

  // ── A5 写路径的同一个落点（`expectGateError` 的 `the content there is:`）
  const wNow = planOr({ planHunks }, IMPORT_SRC, [{ lines: { start: 1, end: 4 }, expect: NOPE, replace: 'X' }], 'x.mjs')
  const wBlock = copyBack(msgOf(wNow), 1, 4)
  check('A5 写路径的 `the content there is:` 同样给可回抄的原文块', wBlock === IMPORTS.join('\n'), JSON.stringify(wBlock))
  const wReuse = planOr({ planHunks }, IMPORT_SRC, [{ lines: { start: 1, end: 4 }, expect: wBlock, replace: 'X' }], 'x.mjs')
  check('A5b 写路径：回抄那段 ⇒ 通过', wReuse.ok === true, `ok=${wReuse.ok} code=${wReuse.error?.code ?? ''}`)

  // ── A6 行号与读回执同一套
  const mid = locate(IMPORT_SRC, { lines: { start: 2, end: 3 }, assert: NOPE, filePath: 'x.mjs' })
  check(
    'A6 原文块的行号是**读回执那套编号**（1-based、从区间起始行起），且逐行对上文件',
    copyBack(mid.message, 2, 3) === IMPORTS.slice(1, 3).join('\n') &&
      /(?:^|\n)2\| /.test(mid.message) &&
      /(?:^|\n)3\| /.test(mid.message),
    JSON.stringify(copyBack(mid.message, 2, 3)),
  )

  // ── A7 「找不到」时最近那一带的原文（`notFoundDetail`）也是可回抄的
  const nfHunks = [{ old: 'const rowA = 1\nconst rowB = 2', replace: 'X' }]
  const nfMsg = msgOf(planOr({ planHunks }, IMPORT_SRC, nfHunks, 'x.mjs'))
  const nfBand = /Closest region: lines (\d+)-(\d+) of (\d+)/.exec(nfMsg)
  const nfFirst = Number(nfBand?.[1])
  const nfLast = Number(nfBand?.[2])
  const nfBlock = Number.isInteger(nfFirst) ? bandRows(nfMsg, nfFirst, nfLast) : null
  check(
    'A7 找不到时贴出的"那一带原文"逐行等于文件原文（`N| ` 边距可机械剥掉）',
    nfBlock !== null && nfBlock === IMPORT_SRC.split('\n').slice(nfFirst - 1, nfLast).join('\n'),
    `${nfFirst}-${nfLast} ${JSON.stringify(nfBlock)}`,
  )
  check(
    'A7b 且明写两个边距（行号与 `=` / `!`）都不是文件内容',
    /not part of the file/.test(nfMsg) && /line number/.test(nfMsg),
    nfMsg.slice(nfMsg.indexOf('The lines below'), nfMsg.indexOf('The lines below') + 80),
  )

  // ── A8 候选清单里的多行引文（`oldAmbiguityError`）
  const dup = [
    'const dupA = 1',
    'const dupB = 2',
    'const filler = 3',
    'const dupA = 1',
    'const dupB = 2',
    '',
  ].join('\n')
  const ambMsg = msgOf(planOr({ planHunks }, dup, [{ old: 'const dupA = 1\nconst dupB = 2', replace: 'X' }], 'dup.mjs'))
  const cand1 = copyBack(ambMsg, 1, 2)
  const cand2 = copyBack(ambMsg, 4, 5)
  check(
    'A8 候选清单里每条多行候选都给可回抄的原文块（不是 `⏎` 连成的一行）',
    cand1 === 'const dupA = 1\nconst dupB = 2' && cand2 === 'const dupA = 1\nconst dupB = 2',
    `${JSON.stringify(cand1)} / ${JSON.stringify(cand2)}`,
  )
  const ambReuse = planOr({ planHunks }, dup, [{ old: cand1, near: 4, replace: 'X' }], 'dup.mjs')
  check(
    'A8b 回抄候选那一段 + `near` ⇒ 从那一条命中（回抄是有用的，不是好看的）',
    ambReuse.ok === true && ambReuse.out.applied[0].line === 4,
    `ok=${ambReuse.ok} line=${ambReuse.out?.applied?.[0]?.line ?? ''} code=${ambReuse.error?.code ?? ''}`,
  )

  // ── A9 渲染单元：连边距一起抄回去**不**命中 —— 这正是身份句必须存在的理由
  const unit = quoteForMessage(IMPORTS.join('\n'), 1)
  const unitBody = unit.slice(unit.indexOf(VERBATIM_MARK) + VERBATIM_MARK.length + 1)
  const withGutter = locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, assert: unitBody, filePath: 'x.mjs' })
  check(
    'A9 连 `N| ` 边距一起抄回去 ⇒ 不命中（所以身份句必须明写"边距不是文件内容"）',
    withGutter.ok === false,
    `ok=${withGutter.ok} code=${withGutter.code ?? ''}`,
  )

  // ── A10 成功回执的 `actual` 逐字节等于区间原文
  const okHit = locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, filePath: 'x.mjs' })
  check(
    'A10 成功回执的 `actual` 逐字节等于区间原文（这一路本来就没有中间层）',
    okHit.ok && okHit.actual === IMPORTS.join('\n'),
    JSON.stringify(okHit.actual),
  )

  /**
   * ── A11–A13：写路径自己的 `expectGateError` 那个落点（C41 缺口一）。
   *
   * 为什么必须单列一段：`expectGateError` 只在 `old` 在场时被调用（`planHunks` 里
   * `if (oldText !== null && hunk.expect !== undefined && …)`）；`lines + expect` 形状的判据与回执
   * 都是 `locator-api.locate` 做的（`locate()` 把 `hunk.expect` 当 `assert` 传下去）。
   * 所以 C4/A5 的标签虽然写着“写路径 `expectGateError`”，**一步也没走到那里** —— 实测：
   * 把它那行的行号参数丢掉，边距与身份句一起消失，本套件仍旧 58/58 exit 0。
   *
   * 这里断的是那个落点的**输出形态**，三样任缺一样都当场红，且名字里点名 `expectGateError`：
   *   ① 回执确实是那一支（`hunk at line 1 matched via old, but expect appears nowhere…`）；
   *   ② 原文块**带 `N| ` 行号边距**（丢了行号参数就取不出东西）；
   *   ③ 用的是**带边距那版身份句**（丢掉行号参数会换成无行号那版）。
   */
  const gateMsg = msgOf(planOr({ planHunks }, IMPORT_SRC, [{ old: IMPORTS.join('\n'), expect: NOPE, replace: 'X' }], 'x.mjs'))
  check(
    'A11 `old + expect` 确实落到写路径自己的 `expectGateError`（不是 locator-api 渲染的那一支）',
    /^hunk at line 1 matched via old, but expect appears nowhere in this file/.test(gateMsg),
    JSON.stringify(gateMsg.slice(0, 72)),
  )
  const gateBlock = copyBack(gateMsg, 1, 4)
  check(
    'A12 `expectGateError` 交出**带行号边距**的可回抄原文块（丢掉行号参数 ⇒ 这里取不到东西）',
    gateBlock === IMPORTS.join('\n'),
    JSON.stringify(gateBlock),
  )
  check(
    'A13 `expectGateError` 用的是**带边距那版身份句**（`N| ` 是行号、不是文件内容）',
    /not part of the file/.test(gateMsg) && /The `N\| ` at the start of each line is a line number/.test(gateMsg),
    JSON.stringify((/What follows[^\n]*/.exec(gateMsg) ?? [''])[0].slice(0, 60)),
  )
}

say('')
say('=== 段B：紧凑摘要仍在，且带明确的不可回抄标记 ===')
{
  const now = locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, assert: NOPE, filePath: 'x.mjs' })
  const pv = preview(now.message)
  const bx = beforeApi.locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, assert: NOPE, filePath: 'x.mjs' })
  const beforePreview = preview(bx.message)
  check('B1 紧凑摘要仍在（一行、`⏎` 连接）', pv !== null && pv.includes('\u23ce') && !pv.includes('\n'), pv ?? 'null')
  check(
    'B2 摘要与改动前**逐字节相同**（那一条是给人直读的，不是这一单要改的东西）',
    pv === beforePreview,
    `${JSON.stringify(pv)} vs ${JSON.stringify(beforePreview)}`,
  )
  check('B3 摘要有**明确的不可回抄标记**（`NOT copyable`）', /NOT copyable/.test(now.message))
  check(
    'B4 忠实块有**明确的可回抄声明**（`verbatim` + `copy it as-is into expect`）',
    /verbatim, byte-for-byte/.test(now.message) && /copy it as-is into expect/.test(now.message),
  )
  check('B5 身份句明写 `N| ` 是行号、不是文件内容', /not part of the file/.test(now.message) && /line number/.test(now.message))
  const one = locate(IMPORT_SRC, { lines: { start: 6, end: 6 }, assert: NOPE, filePath: 'x.mjs' })
  check(
    'B6 单行回执里**没有** `NOT copyable`（单行引文本身就是逐字的，标错等于自相矛盾）',
    !/NOT copyable/.test(one.message) && !one.message.includes('\u23ce'),
    preview(one.message) ?? '',
  )
  const pvBody = pv.replace(/^\u201c|\u201d$/g, '')
  const pvReuse = locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, assert: pvBody, filePath: 'x.mjs' })
  check('B7 摘要确实不可回抄（原样回抄 ⇒ 不命中），标记与事实相符', pvReuse.ok === false, `ok=${pvReuse.ok}`)

  say('  ── B8–B12：长行上的「byte-for-byte」必须仍然为真（C41 缺口二）──')
  /**
   * 病（C41 实测）：`notFoundDetail` 的“那一带”逐行经 `clipReceiptLine` 裁剪，而裁剪处原先
   * **没有**不可回抄标记，身份句却无条件宣称那些行是“这份文件自己的文本、逐字节”。
   * 实测：行宽 600 时回执给 221 字符 / 原文 615 字符；行宽 200 时 216 / 215 ——
   * 两处都在说一句在长行上**为假**的话，而调用方正是照着这句话去抄的。
   *
   * 判据不是“看有没有某个词”，是把回执的**字**对回文件：从 `=` / `!N| ` 边距里逐行取出，
   * 再与文件那一行判等 —— 于是“标记 ⇔ 这一行真的不是逐字节”这个双向不变量可以逐行核。
   * 去标记 ⇒ 长行那一侧不合；乱撒标记 ⇒ 短行那一侧不合。
   */
  const wideLineOf = (n) => `const wide = '${'q'.repeat(n)}'`
  const mixedSrc = `${['const a = 1', wideLineOf(600), 'const b = 2', wideLineOf(250), 'const c = 3'].join('\n')}\n`
  const gone5 = Array.from({ length: 5 }, (_, i) => `const gone${i} = ${i}`).join('\n')
  const mixedMsg = msgOf(planOr({ planHunks }, mixedSrc, [{ old: gone5, replace: 'X' }], 'band.mjs'))
  const mixedRows = mixedMsg
    .split('\n')
    .map((line) => /^([=!])(\d+)\| (.*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ n: Number(m[2]), text: m[3] }))
  const fileRows = mixedSrc.split('\n')
  const markedCopyable = (row) => /NOT copyable/.test(row.text)
  const faithfulRow = (row) => row.text === fileRows[row.n - 1]
  check(
    'B8 那一带每一行的「不可回抄」标记与该行是否真的逐字节，**逐行相符**（该撒不撒、不该撒乱撒都红）',
    mixedRows.length === 5 && mixedRows.every((row) => markedCopyable(row) === !faithfulRow(row)),
    mixedRows.map((row) => `${row.n}:${markedCopyable(row) ? 'marked' : '-'}${faithfulRow(row) ? '=' : '≠'}`).join(' '),
  )
  const clippedRows = mixedRows.filter((row) => !faithfulRow(row))
  check(
    'B9 且这一带确实发生了裁剪（否则 B8 恒真：没有长行时"标记 ⇔ 不逐字节"两边都空）',
    clippedRows.length === 2 && clippedRows.every(markedCopyable),
    `裁剪 ${clippedRows.length} 行｜回执 ${clippedRows.map((r) => r.text.length).join(',')} 字符 vs 原文 ${clippedRows.map((r) => fileRows[r.n - 1].length).join(',')} 字符`,
  )
  check(
    'B10 长行那行带明确的不可回抄标记，且一并写明剪了多少字符（去掉标记 ⇒ B8/B10 红）',
    clippedRows.length > 0 &&
      clippedRows.every((row) => /NOT copyable/.test(row.text) && /\(\d+ more chars\)/.test(row.text)),
    JSON.stringify(clippedRows[0]?.text.slice(-46) ?? ''),
  )
  check(
    'B11 身份句带**同一条例外条款**（收窄到"除标明 `NOT copyable` 的那几行"，那句 byte-for-byte 才为真）',
    /byte-for-byte/.test(mixedMsg) && /unless a line ends in `NOT copyable`/.test(mixedMsg),
  )
  check(
    'B12 短行那几行仍**逐字节**等于文件原文，且一个标记也不带（长行那条规矩不许外溢）',
    mixedRows.filter(faithfulRow).length === 3 && mixedRows.filter(faithfulRow).every((row) => !markedCopyable(row)),
    mixedRows.filter(faithfulRow).map((row) => JSON.stringify(row.text)).join(' '),
  )
}

say('')
say('=== 段C：最坏情况下回执体量 ≤ 宿主结果阈值 ===')
{
  /**
   * 阈值来自**宿主**，不是本工具拍的：`dsh-compaction-tool-result-pruner` 的
   * `toolResultPruner.config.thresholdChars`（超过就把中间换成一行
   * `[... tool result middle pruned ...]`，只留 headChars / tailChars）。
   * 与 `notfound-receipt-test` 段D 同一口径：现读现用，读不到才落回引擎缺省。
   */
  const deployed = [
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'),
    path.join(
      os.homedir(),
      '.dsh',
      'profiles',
      'node_modules',
      '@deepseek-ai',
      'dsh-agent-presets',
      'presets',
      'standard',
      'agent.cordis.yml',
    ),
  ]
  let threshold = 8192
  let from = '引擎缺省 8192（未部署剪枝器时）'
  for (const f of deployed) {
    try {
      const m = /thresholdChars:\s*(\d+)/.exec(fs.readFileSync(f, 'utf8'))
      if (m !== null) {
        threshold = Number(m[1])
        from = f
        break
      }
    } catch {
      /* 读不到就试下一个 */
    }
  }
  say(`  宿主阈值 = ${threshold} 字符（来源：${from}）`)
  check('C0 阈值确实查到了（不是拿本工具自己的数当阈值）', Number.isInteger(threshold) && threshold > 0, `${threshold}`)

  const long = (n, ch = 'x') => ch.repeat(n)
  const wideLine = (n) => `const wide${String(n).padStart(3, '0')} = '${long(4000)}'`
  const wideSrc = `${Array.from({ length: 300 }, (_, i) => wideLine(i + 1)).join('\n')}\n`
  /** 20 行 × 400 字符：刚好把忠实块的字符上限吃满，是"多行引文"的最坏形状。 */
  const fatSrc = `${Array.from({ length: 40 }, (_, i) => `const fat${String(i + 1).padStart(2, '0')} = '${long(400, 'y')}'`).join('\n')}\n`
  /** 20 条候选、每条 2 行：候选清单的体量最坏形状。 */
  const dupSrc = `${Array.from({ length: 20 }, () => 'const sameA = 1\nconst sameB = 2\nconst pad = 0').join('\n')}\n`
  /** 20 行 × 400 字符的区间引文（engine 侧与写路径侧共用同一形状）。 */
  const fatHunk = [{ lines: { start: 1, end: 20 }, expect: NOPE, replace: 'X' }]

  const CASES = [
    ['C1 找不到 · 病态长路径（label 两万字符）', () => planOr({ planHunks }, IMPORT_SRC, [{ old: NOPE, replace: 'X' }], `${long(20000, 'p')}.mjs`)],
    [
      'C2 找不到 · 那一带每行 4000 字符（12 行对上 + 8 行不存在）',
      () =>
        planOr(
          { planHunks },
          wideSrc,
          [
            {
              old: [
                ...Array.from({ length: 12 }, (_, i) => wideLine(41 + i)),
                ...Array.from({ length: 8 }, (_, i) => `const gone${i + 1} = '${long(4000, 'z')}'`),
              ].join('\n'),
              replace: 'X',
            },
          ],
          'diag.mjs',
        ),
    ],
    ['C3 找不到 · 单行 200 万字符（整份文件只有一行）', () => planOr({ planHunks }, `${long(2000000)}\n`, [{ old: NOPE, replace: 'X' }], 'mono.mjs')],
    /**
     * C4 这一条走的是 `lines + expect`：`planHunks` 把 `expect` 当 `assert` 转给 `locate()`，
     * 判据与回执都是 `locator-api` 做的 —— 所以标签里**不能**写 `expectGateError`（那是 `old` 在场时
     * 才走的那一支）。写路径自己那一支的体量由 C4b 量（C41 缺口一）。
     */
    ['C4 expect 闸 · 20 行 × 400 字符的区间引文（写路径 · `lines + expect` 形状，由 `locate` 渲染）', () => planOr({ planHunks }, fatSrc, fatHunk, 'fat.mjs')],
    [
      'C4b 同一条引文，但走 `old + expect` ⇒ 真正落到写路径自己的 ' + '`expectGateError`',
      () =>
        planOr(
          { planHunks },
          fatSrc,
          [
            {
              old: Array.from({ length: 20 }, (_, i) => `const fat${String(i + 1).padStart(2, '0')} = '${long(400, 'y')}'`).join('\n'),
              expect: NOPE,
              replace: 'X',
            },
          ],
          'fat.mjs',
        ),
    ],
    [
      'C5 同上，走 locator-api（aura_read 那一侧）',
      () => ({ ok: false, error: locate(fatSrc, { lines: { start: 1, end: 20 }, assert: NOPE, filePath: 'fat.mjs' }) }),
    ],
    ['C6 候选清单 · 20 条候选 × 每条 2 行（写路径 old 歧义）', () => planOr({ planHunks }, dupSrc, [{ old: 'const sameA = 1\nconst sameB = 2', replace: 'X' }], 'dup.mjs')],
    [
      'C7 候选清单 · 20 条单行候选（line_cue 歧义，locator-api）',
      () => ({
        ok: false,
        error: locate(`${Array.from({ length: 20 }, (_, i) => `const cue${i + 1} = hit`).join('\n')}\n`, {
          lineCue: 'hit',
          filePath: 'cue.mjs',
        }),
      }),
    ],
    /**
     * C10（C41 缺口三）：同一条回执里 `label` 与候选清单**抢预算**的最坏形状 ——
     * 病态长路径 × `old` 歧义。改前实测 22479 字符（阈值 8192）；
     * 且净增量把 label 长度 ~5798 起的**原本合规**回执（7223）顶到了 8193。
     */
    [
      'C10 候选清单 · 病态长路径（label 两万字符）× `old` 歧义',
      () => planOr({ planHunks }, dupSrc, [{ old: 'const sameA = 1\nconst sameB = 2', replace: 'X' }], `${long(20000, 'p')}.mjs`),
    ],
  ]

  const measured = []
  for (const [label, run] of CASES) {
    const now = run()
    const after = msgOf(now)
    const chars = [...after].length
    const bytes = Buffer.byteLength(after, 'utf8')
    measured.push({ label, chars, bytes })
    say(`  ${label}\n    改动后 message=${chars} 字符 / ${bytes} 字节`)
    /** 逐条报时用**完整的那一段编号**（`C4b` / `C10`），不用前两个字符 —— 后者会把两条不同的话印成同一句。 */
    const tag = /^(C\d+b?)/.exec(label)?.[1] ?? label.slice(0, 2)
    check(`${tag} 仍拒绝（体量收紧不许把拒绝变成放过）`, now.ok === false, now.error?.code ?? '')
    check(
      `${tag} 回执 ≤ 宿主阈值 ${threshold}（实测 ${chars} 字符 / ${bytes} 字节）`,
      chars <= threshold,
      `超出 ${chars - threshold}`,
    )
  }
  const worst = measured.reduce((a, b) => (b.chars > a.chars ? b : a))
  say(`  最坏一条：${worst.label} ⇒ ${worst.chars} 字符 / ${worst.bytes} 字节（阈值 ${threshold}）`)
  check('C8 最坏一条也不越阈值（把上界钉成一个数）', worst.chars <= threshold, `${worst.chars} ≤ ${threshold}`)

  /**
   * C11/C11b/C12 —— 上界不是“某个样本”，而是**整段 label 带宽**上的上界（C41 缺口三）。
   *
   * 为什么非扫不可：这处缺陷的形状是“原本合规、到某一段长度才越线”——实测（C38 之后）
   * label 长度 5798 时 8193 字符（**刚好越过 8192 一个字符**）、6000 时 8395，而 600 时只有几千。
   * 只查一个“病态样本”同时漏掉两头：既看不出拐点在哪，也说不清“多长以内是安全的”。
   *
   * 三条落点各扫一遍（`label` 进回执的地方就这三处）：
   *   · 写路径 `old` 歧义（`oldAmbiguityError`）；
   *   · 写路径找不到（`notFoundHead`）；
   *   · 引擎符号跨度拒信（`locate` 的 `LOCATOR_SPAN_INCOMPLETE`，`filePath` 进 message）。
   *
   * 每个点要同时满足三件事，缺一不可：
   *   ① 回执 ≤ 宿主阈值；② **判定不变**（码与短 label 时逐字相同：夹 label 只改说法，不改结论）；
   *   ③ 夹过就**明写**夹了多少字符（不静默丢）。
   */
  const SPAN_SRC = ['class C:', '    def alpha(self):', '\t    x = 1', '        return x', ''].join('\n')
  const LABEL_BAND = [0, 1, 64, 512, 2048, 4096, 5798, 5802, 6000, 6767, 7000, 8000, 8192, 12000, 20000, 60000]
  const SWEEPS = [
    {
      name: '写路径 · `old` 歧义（label 与候选清单抢预算）',
      run: (n) => planOr({ planHunks }, dupSrc, [{ old: 'const sameA = 1\nconst sameB = 2', replace: 'X' }], `${long(n, 'p')}.mjs`),
    },
    {
      name: '写路径 · 找不到（label 进头部）',
      run: (n) => planOr({ planHunks }, IMPORT_SRC, [{ old: NOPE, replace: 'X' }], `${long(n, 'p')}.mjs`),
    },
    {
      name: '引擎 · 符号跨度拒信（filePath 进 message）',
      run: (n) => ({ ok: false, error: locate(SPAN_SRC, { target: 'alpha', filePath: `${long(n, 'p')}.py` }) }),
    },
  ]
  const sweepWorst = { chars: 0, at: '（无）' }
  for (const { name, run } of SWEEPS) {
    const baseCode = run(4).error?.code ?? 'OK'
    const points = []
    const bad = []
    const opaque = []
    for (const n of LABEL_BAND) {
      const r = run(n)
      const m = msgOf(r)
      const chars = [...m].length
      const code = r.error?.code ?? 'OK'
      points.push({ n, chars })
      if (chars > sweepWorst.chars) {
        sweepWorst.chars = chars
        sweepWorst.at = `${name} · label ${n}`
      }
      if (chars > threshold) bad.push(`${n}:${chars} 字符`)
      if (code !== baseCode) bad.push(`${n}:码变成 ${code}`)
      if (n >= 12000 && !/more chars\)/.test(m)) opaque.push(`${n}`)
    }
    const top = points.reduce((a, b) => (b.chars > a.chars ? b : a))
    check(
      `C11 label 带宽逐点扫（${name}，${LABEL_BAND.length} 点）：全部 ≤ ${threshold} 且判定不变`,
      bad.length === 0,
      bad.length === 0 ? `最坏 ${top.chars} 字符（label ${top.n}）` : `越线/变判：${bad.join(' ')}`,
    )
    check(
      `C11b 病态长度上夹口**明写**夹了多少字符（${name}）`,
      opaque.length === 0,
      opaque.length === 0 ? '每个 ≥ 12000 的点都带披露句' : `没写明：${opaque.join(',')}`,
    )
  }
  say(`  带宽扫描最坏一点：${sweepWorst.at} ⇒ ${sweepWorst.chars} 字符（阈值 ${threshold}）`)
  check(
    'C12 带宽扫描的最坏点也不越阈值（上界钉的是整条带宽，不是一个样本）',
    sweepWorst.chars <= threshold,
    `${sweepWorst.chars} ≤ ${threshold}`,
  )

  /**
   * C9：这一单给回执**加了多少**，也是要钉的数。
   *
   * `dist/aura-tools/locator-lab/` 是 C38 之前那一份 src 的构建产物，同一台机器、同一份输入，
   * 所以 `改动后 − 改动前` 就是这一单的净增量（别的改动两边抵消）。
   * 上界 1400 的来源：摘要（≤ ~430）+ 身份句（≤ ~200）+ 忠实块（≤ 400 正文 + 20 行边距 ~160
   * + 换行 ~20）+ 截断披露（≤ ~140）。实测值印在下面，上界是算出来的，可以被逐条核对。
   */
  const deltas = []
  const pairs = [
    [
      msgOf(planOr({ planHunks }, IMPORT_SRC, [{ old: NOPE, replace: 'X' }], 'x.mjs')),
      msgBefore(IMPORT_SRC, [{ old: NOPE, replace: 'X' }], 'x.mjs'),
    ],
    [msgOf(planOr({ planHunks }, fatSrc, fatHunk, 'fat.mjs')), msgBefore(fatSrc, fatHunk, 'fat.mjs')],
    [
      msgOf({ ok: false, error: locate(fatSrc, { lines: { start: 1, end: 20 }, assert: NOPE, filePath: 'fat.mjs' }) }),
      msgOf({ ok: false, error: beforeApi.locate(fatSrc, { lines: { start: 1, end: 20 }, assert: NOPE, filePath: 'fat.mjs' }) }),
    ],
  ]
  for (const [i, [after, before]] of pairs.entries()) {
    const d = [...after].length - [...before].length
    deltas.push(d)
    say(`  增量样本${i + 1}：改动前 ${[...before].length} → 改动后 ${[...after].length}（+${d} 字符）`)
  }
  check(
    'C9 这一单的净增量有界（每条 ≤ 1400 字符，且改动后必然 ≥ 改动前）',
    deltas.every((d) => d >= 0 && d <= 1400),
    deltas.map((d) => `+${d}`).join(' / '),
  )
}

say('')
say('=== 段D：单行原文的引用形态与原来等价 ===')
{
  const single = 'const only = 1'
  const src = `${single}\n`
  const now = locate(src, { lines: { start: 1, end: 1 }, assert: NOPE, filePath: 'x.mjs' })
  const before = beforeApi.locate(src, { lines: { start: 1, end: 1 }, assert: NOPE, filePath: 'x.mjs' })
  check(
    'D1 单行引文**逐字节**等于改动前（`“const only = 1”`）',
    preview(now.message) === preview(before.message) && preview(now.message) === '\u201cconst only = 1\u201d',
    `${preview(now.message)} vs ${preview(before.message)}`,
  )
  check(
    'D2 单行回执里没有真换行、没有 `⏎`、没有忠实块',
    !now.message.includes('\n') && !now.message.includes('\u23ce') && !now.message.includes(VERBATIM_MARK),
  )
  check(
    'D2b 整条单行回执逐字节等于改动前（单行场景一个字节都不许改坏）',
    now.message === before.message,
    `${now.message.length} vs ${before.message.length} 字符`,
  )

  const longSrc = `const X = "${'y'.repeat(600)}"\n`
  const longHunk = [{ lines: { start: 1, end: 1 }, expect: 'const X = 1', replace: 'X' }]
  const longNow = locate(longSrc, { lines: { start: 1, end: 1 }, assert: 'const X = 1', filePath: 'x.mjs' })
  const longBefore = beforeApi.locate(longSrc, { lines: { start: 1, end: 1 }, assert: 'const X = 1', filePath: 'x.mjs' })
  check(
    'D3 超长单行仍旧 `“<400>…” (N more chars withheld)`，且逐字节等于改动前',
    /more chars withheld/.test(longNow.message) && longNow.message === longBefore.message,
    `${longNow.message.length} 字符`,
  )
  check('D3b 截断的单行不冒充可回抄（它本来就没给忠实块）', !longNow.message.includes(VERBATIM_MARK))

  const crlf = 'const one = 1\r\nconst two = 2\r\nconst three = 3\r\n'
  const crlfNow = locate(crlf, { lines: { start: 1, end: 3 }, assert: NOPE, filePath: 'x.mjs' })
  check(
    'D4 CRLF 多行：忠实块是真换行、且逐行等于原文（不带 `\\r`、不带 `⏎`）',
    copyBack(crlfNow.message, 1, 3) === 'const one = 1\nconst two = 2\nconst three = 3',
    JSON.stringify(copyBack(crlfNow.message, 1, 3)),
  )

  const w = planOr({ planHunks }, src, [{ lines: { start: 1, end: 1 }, expect: NOPE, replace: 'X' }], 'x.mjs')
  const wBefore = msgBefore(src, [{ lines: { start: 1, end: 1 }, expect: NOPE, replace: 'X' }], 'x.mjs')
  check(
    'D5 写路径单行回执逐字节等于改动前',
    msgOf(w) === wBefore && !msgOf(w).includes('\n'),
    `${msgOf(w).length} vs ${wBefore.length} 字符`,
  )
}

say('')
say('=== 段E：负向不变量 —— 渲染改变不得影响任何判定 ===')
{
  /**
   * 判据（`expectVerdict`）在改动前后必须**逐字段**相同。
   *
   * 为什么这条是本单的硬要求：`expectVerdict` 是 `expect` 的**唯一**实现，而 `locator-api`
   * 是热路径。这一单只改渲染，一个判定都不许动 —— 所以两边各跑一遍同一张矩阵，
   * 把返回对象**整体** `JSON.stringify` 对比（字段顺序也一致，因为两边是同一份代码）。
   */
  const A = 'alpha\nbravo\ncharlie\ndelta\necho\n'
  /** 两行逐字相同（且 ≥ 12 字符，才走得了"包含即通过"那一支）。 */
  const B = 'const dupX = 1\nconst y = 2\nconst dupX = 1\n'
  /**
   * `[src, start, end, expect, tier, 期望的 kind]`（`null` = 通过）。
   *
   * 期望值是按**规则**写下的（短引文整段相等 / 坐标档免唯一性 / 线索档要唯一 / 引文比区间宽 /
   * 唯一处不在区间内），不是跑出来再抄回来的 —— 否则这张表只能证明"它今天和自己一样"。
   */
  const MATRIX = [
    [A, 1, 1, 'alpha', 'lines', null],
    [A, 1, 3, 'bravo\ncharlie', 'lines', null],
    [A, 1, 3, 'bravo\ncharlie', null, null],
    [A, 3, 3, 'charlie', 'lineCue', null],
    [A, 1, 1, 'zz', 'lines', 'short_mismatch'],
    [A, 2, 2, 'bravo?', 'lines', 'short_mismatch'],
    [A, 1, 1, '', 'lines', 'short_mismatch'],
    [A, 1, 1, '   ', 'lines', 'short_mismatch'],
    [A, 1, 5, 'echo\n', 'lines', 'short_mismatch'],
    [A, 1, 5, '\nalpha\n', 'lines', 'short_mismatch'],
    [B, 1, 1, 'const dupX = 1', null, 'not_unique'],
    [B, 1, 3, 'const dupX = 1', null, 'not_unique'],
    [B, 1, 1, 'const dupX = 1', 'symbol', 'not_unique'],
    [B, 1, 1, 'const dupX = 1', 'lines', null],
    [A, 1, 5, 'zzz-not-in-this-file-zzz', 'lines', 'nowhere'],
    [A, 1, 1, 'const qqqq = 1', null, 'nowhere'],
    // `spans_wider`：引文唯一、但跨 3 行，而区间只有 1 行
    [A, 1, 1, 'bravo\ncharlie\ndelta', null, 'spans_wider'],
    [A, 5, 5, 'bravo\ncharlie\ndelta', null, 'spans_wider'],
    // `outside`：引文跨 2 行、区间也跨 2 行（跨度不比区间宽），但唯一出现处不在区间里
    [A, 1, 2, 'charlie\ndelta', null, 'outside'],
    [A, 4, 5, 'bravo\ncharlie', null, 'outside'],
  ]
  const rows = MATRIX.map(([src, s, e, want, tier]) => {
    const lines = src.split('\n')
    const actual = lines.slice(s - 1, e).join('\n')
    return {
      key: `${JSON.stringify(want)} @ ${s}-${e} ${tier ?? 'null'}`,
      now: expectVerdict(lines, s, e, actual, want, tier),
      before: beforeApi.expectVerdict(lines, s, e, actual, want, tier),
    }
  })
  const serialize = (v) => (v === null ? 'null' : JSON.stringify(v))
  const mismatched = rows.filter((r) => serialize(r.now) !== serialize(r.before))
  check(
    `E1 ${rows.length} 组输入：改动前后 \`expectVerdict\` 返回值**逐字段相同**（含字段顺序）`,
    mismatched.length === 0,
    mismatched.length === 0 ? `全部 ${rows.length} 组 null/对象形状与字段值一致` : mismatched.map((r) => r.key).join('; '),
  )
  const kinds = new Set(rows.map((r) => (r.now === null ? 'pass' : r.now.kind)))
  check(
    'E2 矩阵真的走到了每一支（pass / short_mismatch / not_unique / nowhere / spans_wider / outside 都有样本）',
    ['pass', 'short_mismatch', 'not_unique', 'nowhere', 'spans_wider', 'outside'].every((k) => kinds.has(k)),
    [...kinds].sort().join(','),
  )
  /**
   * `spans_wider` / `outside` 两条要求引文 ≥ 12 字符（短引文走的是"整段相等"那一支，见
   * {@link ASSERT_RELAX_MIN_CHARS}）—— 所以这两支的 `want` 必须够长，否则矩阵看着走过了、其实没走到。
   */
  const kindDrift = MATRIX.map(([, s, e, want, tier, expected], i) => {
    const got = rows[i].now === null ? 'pass' : rows[i].now.kind
    const exp = expected === null ? 'pass' : expected
    return got === exp ? null : `${JSON.stringify(want)} @ ${s}-${e} tier=${tier ?? 'null'}：期望 ${exp}，实得 ${got}`
  }).filter(Boolean)
  check('E2b 每一组的 kind 都等于规则写下的期望值', kindDrift.length === 0, kindDrift.slice(0, 3).join('; ') || `${MATRIX.length} 组全中`)
  /**
   * E3：结构解耦 —— 判据层里不出现任何**渲染**符号。
   * 这条比"跑一遍看结果"更强：渲染改动**够不着**判据，不是"这次恰好没影响"。
   */
  const source = codeOnly(fs.readFileSync(path.join(HERE, 'locator-api.mjs'), 'utf8'))
  const verdictBody = /\n(?:export )?function expectVerdict\([\s\S]*?\n}\n/.exec(`\n${source}`)?.[0] ?? ''
  check(
    'E3 `expectVerdict` 的函数体里不出现任何渲染符号（`quoteForMessage` / `⏎` / U+201C）',
    verdictBody.length > 500 &&
      !/quoteForMessage/.test(verdictBody) &&
      !verdictBody.includes('\u23ce') &&
      !verdictBody.includes('\u201c'),
    `函数体 ${verdictBody.length} 字符`,
  )

  // E4：整条判定路径（locate 的判定字段）也不受渲染改动影响
  const fields = (r) =>
    JSON.stringify({
      ok: r.ok,
      code: r.code ?? null,
      startLine: r.startLine ?? null,
      endLine: r.endLine ?? null,
      tier: r.tier ?? null,
      actual: r.actual ?? null,
      byNear: r.byNear ?? null,
      want: r.want ?? null,
      spans: r.spans ?? null,
      regionLines: r.regionLines ?? null,
      places: r.places ?? null,
    })
  const drifted = []
  for (const [src, s, e, want] of MATRIX) {
    for (const address of [{ lines: { start: s, end: e } }, { anchor: src.split('\n').slice(s - 1, e).join('\n') }]) {
      const req = { ...address, assert: want, filePath: 'x.mjs' }
      if (fields(locate(src, req)) !== fields(beforeApi.locate(src, req))) {
        drifted.push(`${JSON.stringify(want)} ${JSON.stringify(address)}`)
      }
    }
  }
  check(
    'E4 `locate` 的判定字段（ok/code/坐标/tier/actual/places…）在整张矩阵上改动前后相同',
    drifted.length === 0,
    drifted.length === 0 ? `${MATRIX.length * 2} 次调用逐字段一致` : drifted.slice(0, 3).join('; '),
  )
  const wDrift = []
  for (const [src, s, e, want] of MATRIX) {
    const hunks = [{ lines: { start: s, end: e }, expect: want, replace: 'X' }]
    const a = planOr({ planHunks }, src, hunks, 'x.mjs')
    const b = planOr(beforeWrite, src, hunks, 'x.mjs')
    const shape = (r) => JSON.stringify({ ok: r.ok, code: r.error?.code ?? null, line: r.out?.applied?.[0]?.line ?? null })
    if (shape(a) !== shape(b)) wDrift.push(`${JSON.stringify(want)} @ ${s}-${e}`)
  }
  check(
    'E5 写路径的判定（通过/拒绝、错误码、落点行号）在整张矩阵上改动前后相同',
    wDrift.length === 0,
    wDrift.length === 0 ? `${MATRIX.length} 个 hunk 逐字段一致` : wDrift.slice(0, 3).join('; '),
  )
}

say('')
say('=== 段F：覆盖面 —— 全部引用落点走同一份渲染 ===')
{
  const wp = fs.readFileSync(path.join(HERE, 'write-path.mjs'), 'utf8')
  const api = fs.readFileSync(path.join(HERE, 'locator-api.mjs'), 'utf8')
  check(
    'F1 写路径不再自带同形副本（`quoteOne` 已删，`CANDIDATE_QUOTE_CHARS` 已删）',
    !/quoteOne\s*\(/.test(codeOnly(wp)) && !/CANDIDATE_QUOTE_CHARS/.test(codeOnly(wp)),
    `quoteOne 出现 ${(codeOnly(wp).match(/quoteOne\s*\(/g) ?? []).length} 次`,
  )
  const wpCalls = (codeOnly(wp).match(/quoteForMessage\s*\(/g) ?? []).length
  const apiCalls = (codeOnly(api).match(/quoteForMessage\s*\(/g) ?? []).length
  check(
    'F2 两个文件的每个引用落点都调到同一份 `quoteForMessage`（写路径 ≥ 5 处、引擎 ≥ 2 处）',
    wpCalls >= 5 && apiCalls >= 2,
    `write-path ${wpCalls} 处 / locator-api ${apiCalls} 处`,
  )
  check(
    'F3 `quoteForMessage` 是导出面的一部分（否则写路径只能再抄一份）',
    typeof quoteForMessage === 'function' && /export function quoteForMessage/.test(api),
  )
  /**
   * F4：回执里"引用原文给调用方看"的落点**逐个点名**，每一个都要能取出**逐字**的原文。
   *
   * 单行落点用 `“…”`（本来就是逐字的），多行落点用忠实块（剥 `N| ` 边距）——
   * 两种形态都由回执自己声明，所以"怎么取"不是本测试猜的。
   * 这条不是新判据，是把段A 那几条按**落点**列一张表，让"只修一处"当场现形。
   */
  const dup = ['const dupA = 1', 'const dupB = 2', 'const filler = 3', 'const dupA = 1', 'const dupB = 2', ''].join('\n')
  const holed = ['const rowA = 1', 'const rowB = 2', 'const rowC = 3', 'const rowD = 4', ''].join('\n')
  const holeHunk = [{ old: 'const rowA = 1\nconst rowX = 99\nconst rowC = 3', replace: 'X' }]
  const q = '\u201c([^\u201d]*)\u201d'
  /**
   * 每一个落点都带 `site`：它在源码里对应的**调用点**（`文件:函数名`）。
   *
   * 为什么要写这个字段：名单是手写的，而“声称覆盖了”与“真的走到了”是两件事。
   * C41 实测：7 个 `quoteForMessage` 调用点里只有 4 个被真覆盖，而 F4 底下这一行
   * 写着“全部交出逐字原文”—— F5 就是拿这份 `site` 去核那句话的。
   * 粒度是**函数**：一个函数里有两处引用时，两处都算在它头上（§F5 注释里有理由）。
   */
  const sites = [
    {
      name: 'locator-api · 失败回执的区间原文',
      site: 'locator-api:assertVerdict',
      get: () => locate(IMPORT_SRC, { lines: { start: 1, end: 4 }, assert: NOPE, filePath: 'x.mjs' }).message,
      take: (m) => copyBack(m, 1, 4),
      want: IMPORTS.join('\n'),
    },
    {
      name: 'locator-api · 候选清单里的那行原文（单行 → 弯引号）',
      site: 'locator-api:renderCandidates',
      get: () => locate(`${'const c1 = hit\n'.repeat(3)}`, { lineCue: 'hit', filePath: 'x.mjs' }).message,
      take: (m) => new RegExp(`; candidates: (?:line \\d+ = ${q}, )*line 3 = ${q}`).exec(m)?.at(-1) ?? null,
      want: 'const c1 = hit',
    },
    {
      /**
       * 这一条走的是 `lines + expect`：`planHunks` 把它转给 `locate()`，**回执由 `locate` 渲染**。
       * 所以名字里不能写 `expectGateError`（那是 `old` 在场时的另一支）—— C41 缺口一实测：
       * 改了 `expectGateError` 的落点，这一条形丝不动。它的名字就是“同一支渲染器”。
       */
      name: 'locator-api · 写路径 `lines + expect` 形状的区间原文（同一支渲染器）',
      site: 'locator-api:assertVerdict',
      get: () =>
        msgOf(planOr({ planHunks }, IMPORT_SRC, [{ lines: { start: 1, end: 4 }, expect: NOPE, replace: 'X' }], 'x.mjs')),
      take: (m) => copyBack(m, 1, 4),
      want: IMPORTS.join('\n'),
    },
    {
      name: 'write-path · 找不到时最近那一带原文（`clipReceiptLine` 逐行渲染）',
      site: 'write-path:notFoundDetail',
      get: () => msgOf(planOr({ planHunks }, IMPORT_SRC, [{ old: 'const rowA = 1\nconst rowB = 2', replace: 'X' }], 'x.mjs')),
      take: (m) => {
        const r = /Closest region: lines (\d+)-(\d+) of (\d+)/.exec(m)
        return r === null ? null : copyBack(m, Number(r[1]), Number(r[2]))
      },
      want: IMPORT_SRC.split('\n').slice(0, 2).join('\n'),
    },
    {
      name: 'write-path · 首次差异，**文件那一侧**的原文（单行 → 弯引号）',
      site: 'write-path:notFoundDetail',
      get: () => msgOf(planOr({ planHunks }, holed, holeHunk, 'holed.mjs')),
      take: (m) => new RegExp(`but file line 2 is ${q}`).exec(m)?.[1] ?? null,
      want: 'const rowB = 2',
    },
    {
      name: 'write-path · 首次差异，**你那一侧**的原文（单行 → 弯引号）',
      site: 'write-path:notFoundDetail',
      get: () => msgOf(planOr({ planHunks }, holed, holeHunk, 'holed.mjs')),
      take: (m) => new RegExp(`your line \\d+ is ${q}`).exec(m)?.at(-1) ?? null,
      want: 'const rowX = 99',
    },
    {
      /** 行内片段那一支的落点在**成功**回执的 `tier` 里（它不是说“不匹配”，是说“只有这几列被换”）。 */
      name: 'write-path · 行内片段替换处的原文（单行 → 弯引号）',
      site: 'write-path:fragmentNoteFor',
      get: () => planOr({ planHunks }, 'const alpha = 7\nconst beta = 8\n', [{ old: 'alpha = 7', replace: 'X' }], 'frag.mjs').out?.applied?.[0]?.tier ?? '',
      take: (m) => new RegExp(`Replaced text: ${q}`).exec(m)?.[1] ?? null,
      want: 'alpha = 7',
    },
    {
      name: 'write-path · expect 闸的区间原文（`old + expect` ⇒ ' + '`expectGateError`）',
      site: 'write-path:expectGateError',
      get: () => msgOf(planOr({ planHunks }, IMPORT_SRC, [{ old: IMPORTS.join('\n'), expect: NOPE, replace: 'X' }], 'x.mjs')),
      take: (m) => copyBack(m, 1, 4),
      want: IMPORTS.join('\n'),
    },
    {
      name: 'write-path · 候选清单里的那几行原文',
      site: 'write-path:candidateListing',
      get: () => msgOf(planOr({ planHunks }, dup, [{ old: 'const dupA = 1\nconst dupB = 2', replace: 'X' }], 'dup.mjs')),
      take: (m) => copyBack(m, 1, 2),
      want: 'const dupA = 1\nconst dupB = 2',
    },
  ]
  const wired = new Set(
    sites
      .filter((s) => {
        const got = s.take(s.get())
        return got !== null && got === s.want
      })
      .map((s) => s.name),
  )
  check(
    `F4 ${sites.length} 个引用落点全部交出**逐字**的原文（单行走弯引号、多行走忠实块）`,
    wired.size === sites.length,
    wired.size === sites.length
      ? sites.map((s) => s.name.split(' · ')[0]).join(',')
      : `未交出：${sites.filter((s) => !wired.has(s.name)).map((s) => s.name).join('; ')}`,
  )

  /**
   * F5/F5b —— 调用点覆盖：把两个源文件里**每一个**渲染调用点扫出来，要求 F4 名单逐个点名。
   *
   * 为什么需要它：F4 的名单是手写的，而“声称覆盖了”与“真的走到了”是两件事。C41 实测：
   * 7 个 `quoteForMessage` 调用点只有 4 个被真覆盖 —— 写路径的 `expectGateError`
   * （`the content there is:` 那一处）不在其中：把它的行号参数丢掉，那个落点的渲染整个变了
   * （边距与身份句一起消失），本套件仍旧 58/58 exit 0。
   * 所以覆盖面不能靠人读，得由**源码枚举**出来：新加一个调用点就当场红，并点名是哪一个函数。
   *
   * 粒度是**函数**（`文件:函数名`）：一个函数里有两处引用时两处都算在它头上。
   * 这一档粒度够抓住本次那处缺口（`expectGateError` 是独立函数），也够抓住“新开一处引用”；
   * 再细到“同一函数里第 j 处”需要给每处起名字，而那些名字本身又会成为需要维护的东西。
   *
   * 枚举面是**两个渲染器**：`quoteForMessage`（引文）与 `clipReceiptLine`（那一带逐行），
   * 它们都是“把原文交给调用方看”的那一层；两处的定义行都不算调用点。
   */
  const RENDERERS = ['quoteForMessage', 'clipReceiptLine']
  const renderCalls = []
  for (const [file, mod] of [['write-path', wp], ['locator-api', api]]) {
    const srcLines = codeOnly(mod).split('\n')
    srcLines.forEach((line, i) => {
      if (!RENDERERS.some((fn) => new RegExp(`${fn}\\s*\\(`).test(line))) return
      if (/(?:export\s+)?function\s+\w+\s*\(/.test(line) && RENDERERS.some((fn) => new RegExp(`function\\s+${fn}\\s*\\(`).test(line))) return
      let owner = '<top-level>'
      for (let k = i; k >= 0; k -= 1) {
        const m = /^\s*(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(srcLines[k])
        if (m !== null) {
          owner = m[1]
          break
        }
      }
      renderCalls.push(`${file}:${owner}`)
    })
  }
  const callPoints = [...new Set(renderCalls)].sort()
  const declaredSites = new Set(sites.map((s) => s.site))
  const uncovered = callPoints.filter((s) => !declaredSites.has(s))
  check(
    `F5 源码里枚举出的 ${callPoints.length} 个渲染调用点，每一个都在 F4 名单里被点名`,
    uncovered.length === 0,
    uncovered.length === 0 ? callPoints.join(', ') : `没点名的落点：${uncovered.join('; ')}`,
  )
  const staleSites = [...declaredSites].filter((s) => !callPoints.includes(s))
  check(
    'F5b F4 名单里没有过时/写错的落点名（每个名字都能在源码里找到对应的调用点）',
    staleSites.length === 0,
    staleSites.length === 0 ? `${declaredSites.size} 个落点名逐个对得上` : `对不上：${staleSites.join('; ')}`,
  )
}

say('')
const failed = results.filter((r) => !r.ok)
say(`--- 结果：${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  for (const f of failed) say(`   FAIL: ${f.label}`)
  process.exitCode = 1
}
