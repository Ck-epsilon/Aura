/**
 * write-path.mjs —— 写路径的**判据层**：从"读到的内容"到"落盘并验回"的全部规则。
 *
 * 这里刻意**不碰任何框架**：不 import DSH、不 import node:fs。文件读写、版本比对、策略解析
 * 由调用方的 `provider` 提供（契约见 `README` 顶部注释），因此 DSH 壳（`aura-edit/index.js`）、
 * 独立 CLI、MCP 服务三者共用同一份判据 —— 一份实现，三处调用。
 *
 * 本文件由 `tools/_extract-write-path.mjs` 从 `aura-edit/index.js` 机械搬迁而来
 * （用引擎自己的 `outline()` 取跨度，不是手抄）；改这里，别在壳里再写第二份。
 *
 * provider 契约（四个方法，全部可选 signal）：
 *   stat(target)                        -> { version, size } | undefined
 *   readText(target)                    -> string             （提供方视角：解码时剥掉恰好一个前导 BOM）
 *   readByteRange(target, {offset,length}) -> Uint8Array
 *   writeText(target, content, expected)   -> { version }     （expected = {kind:'replaceIfVersion', version} 时为 CAS）
 */
import { normSpace } from './anchor-core.mjs'
import { ASSERT_RELAX_MIN_CHARS, clipReceiptLabel, expectVerdict, locate, quoteForMessage } from './locator-api.mjs'
import {
  LINE_ADDRESS_HINT,
  MT_MAX_TARGETS,
  MT_POOL,
  assertEditTargets,
  editTargetRequests,
  gaveLineAddress,
  handleShapeVerdict,
  lineRangeOf,
  toLineNumber,
} from './args.mjs'
/**
 * 区间句柄（HD2）：写侧**解析**句柄；读侧怎么发见 `read-core.mjs`。
 *
 * `handle-core.mjs` 是叶子（导入表为空）⇒ 本文件 import 它不会造出
 * `write-path → read-core → handle-core` 那类环。
 */
import { identityTag, mintHandle, parseHandle, regionFingerprint } from './handle-core.mjs'
import { indexStructure, langOf, resolveTarget } from './struct-core.mjs'
import { docKindOf, indexDocument } from './doc-structure.mjs'
import { preflightEdit, structureOf } from './preflight.mjs'
import {
  BYTE_ORDER_MARK,
  BYTE_ORDER_MARK_BYTES,
  contentToken,
  countByteOrderMarks,
  deliveredRanges,
  hasObservedVersion,
  latestObservation,
  leadingByteOrderMarks,
  ledgerIdentityKey,
  rememberDeliveredRows,
  rememberRead,
} from './read-core.mjs'
/**
 * 交付覆盖的判据本体（1.0.2）：本文件只把"要替换哪些行"喂进去，区间算术在叶子里。
 */
import { formatRanges, missingRanges, parseRange } from './coverage-core.mjs'


/**
 * 补丁自身的错误类型：带稳定 code 与可回报的候选行号。
 */
class PatchError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 把内容切成“行 + 每行自己的行尾”。
 *
 * 为什么不能再用“整份文件一个主流行尾”：混合行尾的文件里，那会把**没被寻址**的行的行尾一起改掉——
 * 实测（`%TEMP%\aura-byte\mixed.md`：`alpha\r\nbeta\ngamma\r\n`，CRLF 是多数派）改第 2 行 ⇒
 * 第 2 行从 LF 变成 CRLF（19 → 22 字节），而“我没让你改行尾”这件事没有任何提示。
 *
 * 行尾只认 `\n` 与 `\r\n`（与 {@link locate} 里的 `split(/\r?\n/)` 同一把尺子，行号因此不会错位）；
 * 单 `\r` 不是行尾，这类文件由 `locator-api` 给出明确的拒绝说明。
 *
 * @param content - 文件全文
 * @returns {{lines: string[], endings: string[]}} `endings[i]` 是第 i 行后面的行尾（最后一行通常为 ''）
 */
function splitLinesWithEndings(content) {
  const lines = []
  const endings = []
  const breaks = /\r\n|\n/g
  let start = 0
  let hit
  while ((hit = breaks.exec(content)) !== null) {
    lines.push(content.slice(start, hit.index))
    endings.push(hit[0])
    start = hit.index + hit[0].length
  }
  lines.push(content.slice(start))
  endings.push('')
  return { lines, endings }
}

/**
 * `replace` 在回执里的**行文本**口径：按 `\r\n|\n` 切行、用 `\n` 接回。
 *
 * 唯一一份：{@link planHunks} 的 `applied[].replaced` 与片段层就地记下的 `replacedText` 都读它。
 * 行尾不进回执 —— 被替换区域**末尾**的行尾是继承来的（见 `planHunks` 拼接段），不是调用方
 * 写的那一份；把它放进来只会在展示时漏出 `\r` 并凭空多算一行。
 */
function replaceTextOf(text) {
  return splitLinesWithEndings(text).lines.join('\n')
}

/**
 * 0.10.0：`replace` 的换行风格。
 *
 * 内置 `Edit` 会把新行的 LF 适配成文件已有的 CRLF；aura 原先严格按 `replace` 原样写，
 * 模型写 `\n` 就会在 CRLF 文件里制造混合行尾。判据分三档：
 *   · `auto`（默认）：用**被替换区域末行**的行尾（没有就看首行/文件里第一个非空行尾）作目标；
 *   · `preserve`：保持 `replace` 原样（旧的逐字节口径，含混合行尾）；
 *   · `lf` / `crlf`：强制成统一行尾。
 */
function targetEolFor(endings, startLine, endLine) {
  const last = endings[endLine - 1]
  if (typeof last === 'string' && last !== '') return last
  const first = endings[startLine - 1]
  if (typeof first === 'string' && first !== '') return first
  return endings.find((ending) => typeof ending === 'string' && ending !== '') ?? '\n'
}

function adaptReplaceEol(text, mode, targetEol) {
  if (mode === 'preserve' || text === '') return { text, adapted: false }
  const target = mode === 'auto' ? targetEol : mode === 'lf' ? '\n' : mode === 'crlf' ? '\r\n' : null
  if (target === null) {
    throw new PatchError(
      `unknown eol mode ${JSON.stringify(mode)}; use auto, preserve, lf, or crlf — nothing was written`,
      'PATCH_BAD_EOL',
    )
  }
  const normalized = text.replace(/\r?\n/g, target)
  return { text: normalized, adapted: normalized !== text }
}

/**
 * 这份内容是不是**混合行尾**（同时存在 `\r\n` 与裸 `\n`）。
 *
 * 为什么需要它：`editText` 只在行尾**统一**时逐字节等价（normalize/restore 在纯 LF / 纯 CRLF / 纯 CR
 * 上是恒等变换），混合行尾必被整份归一。因此后端没有 writeText 时，混合行尾文件只能**拒绝**，
 * 不能降级去走 editText——那会把“静默改掉非目标行的行尾”重新放回来。
 */
function hasMixedLineEndings(content) {
  return content.includes('\r\n') && /(^|[^\r])\n/.test(content)
}

// ── 区域级新鲜度闸门（C13）─────────────────────────────────────────────────
//
// 未带 `expect` 的 hunk，落盘前核对**被寻址区域**是否在“本次观测”之后被动过。
// 为什么不能退化成全局版本守：v1 就是因为“整份版本变了就拒”被否掉的——
// 它会误杀“别人改了无关区域”的正常编辑（`stale-gate-test` 段C）。
// 带 `expect` 的 hunk 不进这道闸门：它已经用 `expect` 把内容钉住了。

/**
 * 陈旧冲突：这个地址**还作数吗**？
 *
 * 判据分两步，缺一不可：
 *   1. **文本**：同一个 hunk 再对上次观测到的全文跑一遍定位（`planHunks` 是纯函数，
 *      `lines=` / `line_cue=` / `anchor=` / `target=` 四层因此共用一条判据，不必各写一套），
 *      比对两次解析出的区域文本；
 *   2. **坐标**：被寻址的那段文本，在**当前**内容的行号还对不对得上。
 *
 * 第 2 步是**实测补上的**（2026-09-22，探针 `_t21-probe` 五例）：只有第 1 步时，
 * 行号整体位移 + 同址文本恰好相符 ⇒ 放行，而模型给的坐标指的是**别处**：
 *   · 观测 `one/two/three/four/five`，第三方删掉前两行 ⇒ 当前 `three/four/five`；
 *   · 模型发 `lines=[3,3]`：观测第 3 行是 `three`，当前第 3 行是 `five` ⇒ 第 1 步就拦（这是老判据）;
 *   · 但观测第 3 行是 `three`、当前第 3 行**也是** `three` 的情形（重复行 / 固定块的文件）⇒ 老判据放行。
 * 第 2 步把“同一段文本现在在第几行”也算进来，于是位移不再需要靠行号恰好对齐来蒙对。
 *
 * ## 为什么**不报“偏移了多少行”**（一次尝试后的结论，记下来免得重做）
 *
 * 看上去很自然：既然陈旧多因“行号移位”，那就把新行号报给模型，让它一次重发就能成。
 * 我实现过一版，结果它**永不可能触发**，而且会报**假偏移**：
 *
 * · 用“首次出现”当原处，在文本于别处也出现时报出偏移 0——“你给的行号现在指着别的东西”
 *   这句真话会被报成“没动过”。**假数字比没有数字更坏**，所以这里只在“唯一出现”时给行号，
 *   其余一律 `null`（收据里说“无法唯一确定”）。
 * · 就算算对了，**用处也有限**：模型拿到新行号后**仍然要重读**才知道那一段现在长什么样。
 *
 * 结论：地址与版本必须一起走（T21 那条账本不变式的方向），而不是在回执里事后补一个偏移。
 *
 * @param observedSource - 上次观测到的内容
 * @param content - 本次实际读到的内容（坐标核对要在它身上做）
 * @param hunks - 本次的 hunk
 * @param matches - 在当前内容上已定到的区域
 * @param filePath - 用于判定语言
 * @returns `{lines, tier, reason, nowAt}[]`；`reason` ∈ absent-in-observation / moved-out / moved / changed
 */
function staleConflicts(observedSource, content, hunks, matches, filePath, revision = {}) {
  const contentPath = revision.contentPath ?? filePath
  /**
   * 这一份闸门里，**观测那一版与当前内容的行数组各切一次**。
   *
   * 改前每个 hunk 都要重切好几遍整份：`regionTextIn` 里一遍、坐标核对里两遍、短路里再两遍——
   * 90001 行档一份 5.3MB 内容切一次实测 5.1ms，乘上 hunk 数与调用点数就是闸门那一格的大头。
   * 尺子一个字没换：还是 `split(/\r?\n/)`（见 {@link regionLinesIn} 的注释）。
   */
  let observedRowsMemo = null
  const observedRows = () => (observedRowsMemo ??= observedSource.split(/\r?\n/))
  let contentRowsMemo = null
  const contentRows = () => (contentRowsMemo ??= content.split(/\r?\n/))
  /**
   * “两份内容逐行相同”是**两份内容**的性质，不是某个 hunk 的性质 ⇒ 一次闸门只算一遍。
   * （这条短路是旧代码就有的正确性判据，下面用到它的地方一字未改，只是不再每个 hunk 重算。）
   */
  let sameRowsMemo = null
  const sameRows = () => (sameRowsMemo ??= observedRows().join('\n') === contentRows().join('\n'))
  // 这里曾经挂着 `currentToken`（当前内容的版本令牌），但全函数没有任何地方用它——死码，删掉；
  // 账本令牌的 BOM 那一半只有 {@link regionGate} 算 `basis` 时用得上。
  const conflicts = []
  /**
   * `replace_all` 的观测侧判据：**出现次数**前后一致。
   *
   * 它没有“一处区域”可比——一次 hunk 对应 N 处，`regionTextIn` 只会给其中一处（或因为不唯一
   * 返回 null）。真正会发生的事故是“你读的时候有 3 处，现在只剩 2 处”：再全量替换就会
   * 少改一处，且回执不会说。次数变了就拒；次数没变时，内容地址本来就该吸收位移。
   */
  const replaceAllObservedCounts = new Map()
  const observedAllCount = (hunk) => {
    const oldText = oldAddressOf(hunk)
    if (typeof oldText !== 'string') return 0
    /**
     * 层序必须与 {@link locateAllByOld} 逐字一致（片段优先）：两边取不同层时，
     * 同一个 `old` 会在“现在有几处”和“读过时有几处”上给出两个数，闸门就会误拒。
     */
    const fragment = findFragmentTier(observedRows(), oldText)
    if (fragment.spans.length > 0) return nonOverlappingCandidates(fragment.spans, true).length
    const rows = addressRows(oldText)
    const aligned = findWindowTier(observedRows(), rows)
    return nonOverlappingCandidates(aligned.starts.map((start) => ({ start, span: rows.length })), false).length
  }
  const replaceAllReported = new Set()
  for (const match of matches) {
    const hunk = hunks[match.hunk]
    if (hunk === undefined) continue
    /**
     * 结构地址是**路径**，不是字节区间：闸门没有“同一段字节”可比——
     * 它要改的就是当前那个符号/节/键（整段内容已被改写，正是它存在的理由）。
     * 代价必须有声：回执的 `tier` 写 `handle symbol` / `handle section` / `handle key`，
     * 调用方看得出这次用的是结构地址，不是“读过的字节”。
     */
    if (hasStructureArg(hunk)) continue
    /** 结构句柄同理：地址是路径，观测侧没有一组行号可与它对应。 */
    if (hasHandleArg(hunk)) {
      const parsed = parseHandle(hunk.handle)
      if (parsed.ok === true && parsed.kind === 'structure') continue
    }
    if (hunk.replace_all === true) {
      if (replaceAllReported.has(match.hunk)) continue
      replaceAllReported.add(match.hunk)
      if (!replaceAllObservedCounts.has(match.hunk)) {
        replaceAllObservedCounts.set(match.hunk, observedAllCount(hunk))
      }
      const was = replaceAllObservedCounts.get(match.hunk)
      const now = matches.filter((candidate) => candidate.hunk === match.hunk).length
      if (was !== now) {
        conflicts.push({ lines: [match.line, match.end], tier: match.tier, reason: 'occurrences-changed', was, now })
      }
      continue
    }
    // 带了 `expect` 的 hunk 不走这里：它自己的断言就是闸门（且报错里会贴出原文）。
    // **句柄 hunk 是例外**（D3）：句柄是"更准的读过的区间"，它要**喂给**闸门，
    // 而不是借 `expect` 从闸门下面绕过去——句柄不是绕过 `PATCH_STALE_REGION` 的路。
    if (hunk.expect !== undefined && hunk.expect !== null && !hasHandleArg(hunk)) continue
    /**
     * 观测那一版里，这个地址落在哪一段文本上 —— **只算这一段，不重跑整份**（C18）。
     *
     * `lines=` 是纯坐标地址：观测那一版的区域就是那几行，按坐标取即可（{@link observedRegionByLines}）。
     * 等价性逐条对齐：`planHunks` 对纯行号地址走 `locate` 的第 2 层，`done()` 回的 `actual`
     * 就是 `lines.slice(start-1, end).join('\n')`（同一把 `split(/\r?\n/)` 尺子），
     * 行号写坏 / 越界则抛 `LOCATOR_*` ⇒ `regionTextIn` 回 null ⇒ 这里同样回 null。
     *
     * 其余形态（`old` / `target` / `line_cue` / `anchor`）是**内容寻址**：
     * “这段文本在观测那一版里指哪儿”只有定位本身答得出来 ⇒ 仍旧走 {@link regionTextIn}。
     * 那是**地址**，不是可以省掉的重算。
     */
    /**
     * **句柄 hunk 的观测侧**（HD2）：坐标取自**句柄**（读侧当时自己写下的那几个行号），
     * 不是调用方拄的 `lines`。它与另外两条路是同一个问题（"这段地址在观测那一版里指着哪些字节"），
     * 所以只多一个取坐标的来源，不新开一条旁路：比对、冲突分类、收据全部沿用下面同一份代码。
     */
    const handleRegion = match.handleRegion
    const observed = handleRegion !== undefined
      ? observedRegionByHandle(hunk.handle, observedRows())
      : byLineNumbers(hunk)
        ? observedRegionByLines(hunk, observedRows())
        : regionTextIn(observedSource, hunk, filePath)
    if (observed === null) {
      // 观测里根本没有这块区域（当时行数更少 / 地址当时就无效）⇒ 坐标无从核对。
      conflicts.push({ lines: [match.line, match.end], tier: match.tier, reason: 'absent-in-observation' })
      continue
    }
    /**
     * 比对的是**句柄定下的整段区间**（`handleRegion.text`），不是这次替换的那一小段：
     * 句柄的凭据覆盖整个区间，而 `line: k` / `old` 只是区间**内部**的相对定位。
     */
    if (observed !== (handleRegion === undefined ? match.actual : handleRegion.text)) {
      // 文本变了。若**原文还在**（在别的行号上）⇒ 是被整体推移，而不是被改写：
      // 这两句对模型的下一步完全不同（前者要重定位，后者内容可能已被别人改了），所以分开报。
      const origin = regionLinesIn(content, observed, contentRows()).first
      conflicts.push({
        lines: [match.line, match.end],
        tier: match.tier,
        reason: origin === null ? 'changed' : 'moved',
        nowAt: origin,
      })
      continue
    }
    /**
     * 只在**模型自己给出行号**时做坐标核对（`lines=` / `start_line+end_line`）。
     *
     * 为什么不能对所有寻址都做：`target=` / `anchor=` / `line_cue=` 是**内容寻址**——
     * 定位器本来就是靠那段文本（或那个符号名）在**当前**内容里重新定位的，位移正是它该吸收的东西。
     * 对它们再要求“还在原来那个行号”会把该成功的编辑拒掉，`stale-gate-test` 段J 两条断言
     * （符号层 / 锚点层：插入两行后同一函数文本未变 ⇒ 必须成功）实测就是这么红的。
     * 而 `lines=` 不一样：那串数字是模型从上一版视图里抄下来的**绝对坐标**，
     * 一旦行数变了就可能指着别处，而且没有任何东西能替它发现这件事。
     */
    if (!byLineNumbers(hunk)) continue
    /**
     * 行号地址的漂移核对。判据经过**四次证伪**才成形，四版错误全记在这里免得重做：
     *
     * · 一版「这段文本在文件里只出现一次，且还在这个行号上」：第⑥例证伪——
     *   文本重复是**常态**（`}`、空行、许可证头、`import` 行），于是“唯一”恒不成立，
     *   没位移的正常编辑也一起被拒。重复行不是缺陷，是文件本来的样子。
     * · 二版「文件总行数变了就拒」：第②例证伪——那是**整份**的属性，
     *   第三方在下方删两行时总行数变了，可被寻址的那一行逐字节没动。
     * · 三版「从文件头到本区域末尾必须逐字相同」：段C 证伪——那是文档化的非回归基准
     *   （“不许退化成全局版本守”），第三方改的是**第 1 行**，被寻址的第 3 行一字未动。
     * · 四版「总行数必须相同」：段C 第二例（只在尾部追加）证伪，理由同二版。
     *
     * 四版错在同一个地方：都想用**整份**的性质去回答**区域**的问题。现在改成两步：
     *
     *   1. **锚定**：观测那一版里，这段文本出现在第几行？它必须就在模型说的那一行。
     *      不是 ⇒ 模型手上的行号来自别的一版，它以为在改 A、其实在改 B ⇒ 拒。
     *      这一步能拦住上/下方删行造成的位移（第①⑤例、段C 之前的 f3）。
     *   2. **行数旁证**（只在锚定不成立、文本又重复出现时才用得上）：
     *      若观测与当前**行数不同**，就可能存在“前面删两行、后面添两行”这种
     *      位移量恰好自偿的情形——那时文本对得上、行数也对得上，只有“区域出现次数”变了。
     *      行数一致 ⇒ 没有插删 ⇒ 放行；不一致且区域非唯一 ⇒ 拒（第③例）。
     */
    /**
     * 短路：**观测到的就是现在这份内容**（逐字节，行尾不参与）⇒ 不可能有漂。
     *
     * 这条不是优化，是正确性：下面那套锚定判据对**重复文本**无能为力——
     * 区域 `three` 在文件里出现两次时，`regionLinesIn` 只能给第一次出现（第 1 行），
     * 而模型编的是第二次（第 3 行），于是“锚点对不上”会把**一字未改的文件**判成漂移
     * （探针第⑥例当场如此）。而“两份内容逐字相同”时，行号必然还对得上，不需要任何推断。
     */
    if (sameRows()) continue
    const thenAt = regionLinesIn(observedSource, observed, observedRows())
    if (thenAt.first !== match.line) {
      const nowAt = regionLinesIn(content, match.actual, contentRows())
      conflicts.push({
        lines: [match.line, match.end],
        tier: match.tier,
        reason: nowAt.first === null ? 'moved-out' : 'moved',
        nowAt: nowAt.first,
      })
      continue
    }
    if (observedRows().length !== contentRows().length) {
      const nowAt = regionLinesIn(content, match.actual, contentRows())
      // 区域在两侧都不唯一时才敢下结论：不唯一说明这份内容里不止一处长得像，
      // 那么“行数变了但区域还在原处”就不足以证明它没漂。
      if (thenAt.count !== 1 || nowAt.count !== 1) {
        conflicts.push({ lines: [match.line, match.end], tier: match.tier, reason: 'moved', nowAt: nowAt.first })
      }
    }
  }
  return conflicts
}

/**
 * 这段文本在**哪一行**
 *
 * 用途只有一个：核对“被寻址的那段文本现在还在不在这个行号上”。
 * 与 {@link splitLinesWithEndings} 用同一把行尾尺子，所以行号与 `planHunks` 报的行号是同一个坐标。
 *
 * 只回答“在不在、在哪”，**不回答“偏移了多少行”**：
 * · 用“首次出现”当原处会在文本重复时报出**假偏移**（同一段文本在别处也出现时，首次出现往往就是原处，
 *   于是算出偏移 0，等于把“你给的行号现在指着别的东西”报成“没动过”）——假数字比没有数字更坏；
 * · 偏移量对模型也没有额外用处：它仍然得重读那一段才知道现在长什么样。
 *
 * @param source - 要在其中查找的内容（**整份**内容，不是那一段文本自己）
 * @param text - 被寻址区域的原文（`match.actual` / 观测侧解析结果）
 * @returns {{count: number, first: number|null}} 出现次数与首次出现的行号；`first` 仅在唯一时给出
 */
/**
 * 闸门拒绝的收据：先说**哪个区域**，再说**为什么**，最后说**下一步怎么做**。
 *
 * “为什么”必须分情形，因为三种原因对模型的下一步不同（实测依据见 {@link staleConflicts}）：
 *   · `changed` —— 区域文本被改过；
 *   · `moved`   —— 文本还在，但已不在那个行号上（唯一位置时点名新行号）；
 *   · `moved-out` —— 文本已不唯一存在，**给不出新行号**。这里必须说“无法唯一定位”，
 *     不能随便挑一个行号充数——假数字比没有数字更坏（同 {@link regionLinesIn}）。
 *
 * “下一步”里 `expect` 不能省：单纯重读后用行号地址重试，可能把改动写到错行上
 * （其他写者已把行号移位）；带 `expect` 的重试才会在错行上停下来。
 *
 * 冲突可能不止一处。挂在错误对象上的 `minimal_next` / `others` 框架**不读**
 * （只取 `error.message`，见 `dsh-tools/lib/index.js:2495-2503`），所以“还有几处”必须写进 message。
 *
 * @param displayPath - 面向模型的路径
 * @param conflicts - {@link staleConflicts} 的产出（至少一条）
 * @returns {{message: string, extras: object}}
 */
function staleRegionRefusal(displayPath, conflicts) {
  const [first] = conflicts
  const [from, to] = first.lines
  const why =
    first.reason === 'changed'
      ? 'the addressed region changed after the last observation'
      : first.reason === 'moved'
        ? `the text you addressed moved: line ${from} no longer holds it (it is now line ${first.nowAt})`
      : first.reason === 'moved-out'
          ? `the text you addressed is no longer at line ${from} and cannot be located unambiguously elsewhere`
          : first.reason === 'occurrences-changed'
            ? `\`replace_all\` matched ${first.now} occurrence(s) in the current file, but the version you read had ${first.was} (it would change a different set of places)`
          : first.reason === 'unobserved-revision'
            ? `the file now holds a revision this session has never read, so lines ${from}-${to} cannot be checked against what you saw (the text above them changed at some point)`
            : `lines ${from}-${to} were not present in the last observation — the file has changed shape since you read it`
  const more =
    conflicts.length > 1
      ? `; ${conflicts.length - 1} more addressed region(s) also changed: ${conflicts
          .slice(1, 5)
          .map((c) => `lines ${c.lines[0]}-${c.lines[1]}`)
          .join(', ')}${conflicts.length > 5 ? `, +${conflicts.length - 5} more` : ''}`
      : ''
  return {
    message:
      `cannot patch "${displayPath}": ${why} — re-read those lines, then retry with \`expect\` set to what you find there ` +
      `(that keeps a shifted retry from landing on the wrong line)${more}`,
    extras: {
      // 只有“唯一位置”才是可信的重读坐标；不确定就不给，免得模型照着一个假行号重试。
      minimal_next: {
        lines: [from, to],
        ...(first.nowAt === undefined || first.nowAt === null ? {} : { now_at_line: first.nowAt }),
      },
      ...(first.reason === 'occurrences-changed' ? { occurrence_count: { was: first.was, now: first.now } } : {}),
      others: conflicts.map((c) => ({
        lines: c.lines,
        by: 'unknown-writer',
        ...(c.reason === undefined ? {} : { reason: c.reason }),
        ...(c.nowAt === undefined || c.nowAt === null ? {} : { now_at_line: c.nowAt }),
      })),
    },
  }
}

/**
 * 账本里那条记录的**令牌长度**（令牌前半是内容指纹，后半是长度，见 `contentToken`）。
 *
 * 为什么快路上需要它：快路要同时把 `basis` 说准（“这份内容我们观测过吗”），而完整答案要
 * `contentToken`（5.3MB 实测 8.9ms，占端到端 3%+）——快路上这个答案**不必再哈希一遍**：
 *   · 观测条目就是用它自己的令牌存进去的，`latestObservation` 又是从同一条里取出来的
 *     ⇒ 只要**这次算出来的令牌与它逐字符相同**，`hasObservedVersion` 必为 true；
 *   · 令牌 = `hash(有效串):有效串长度`，而有效串 =（BOM 约定 ? U+FEFF : ''）+ 内容；
 *   · 调用方已确认 `observation.source === content` ⇒ 两个内容长度相同
 *     ⇒ 有效串长度相同 ⇔ 两次的 BOM 约定相同 ⇒ 有效串**逐字符相同** ⇒ hash 也相同。
 * 反过来，长度对不上就说明两次的 BOM 约定不同（那就可能不是同一条令牌），
 * 这时**不走快路**，交回老路径完整算一遍——宁可多算一次，不猜。
 *
 * @param version - 账本条目的令牌（`hash:length`）；形状不对时回 -1（与任何长度都不等）
 * @returns 令牌里的长度那一半
 */
function storedTokenLength(version) {
  const at = typeof version === 'string' ? version.lastIndexOf(':') : -1
  return at === -1 ? -1 : Number(version.slice(at + 1))
}

/**
 * 区域级新鲜度闸门的**决策**：读一次账本 → 有基准就比 → 有冲突就给出收据。
 *
 * 为什么单独成一个函数：这个决策有三个调用方（DSH 壳 `aura-edit`、独立 CLI/MCP 的
 * `applyEditToProvider`、以及测试），而"同一个决策写在两处，就一定会有一处漏改"
 * 在本仓已被实证过一次（`symbolHint` 的 `slice(0, 24)`）。判据（{@link staleConflicts}）
 * 与收据（{@link staleRegionRefusal}）都在这里，调用方只负责编排。
 *
 * 三个返回形态的语义是**穷尽**的，调用方可以据此原样写回执：
 *   · `clean: true, basis: 'observation'` —— 有基准且无冲突（可以真心说已核对过）；
 *   · `clean: true, basis: 'none'`        —— **没有可比基准**，且冲突判据没发现任何问题。
 *     调用方要如实标注（DSH 壳 / CLI 都在回执里带 `unverified_region`），不得冒充新鲜；
 *   · `clean: false`                      —— 有冲突，收据在 `message` / `extras` 里。
 *
 * `basis: 'none'` 有两种来源，**必须当成同一种诚实**：
 *   · 从未观测过这个文件（账本为空）；
 *   · 观测缓存有界（默认 8 条 / 256 KiB），基准已被淘汰 ⇒ 未命中就是没有基准可比，
 *     而不是"看起来没变"。实测依据在 `range-bytes-test` 段G：>256 KiB 的文件不入缓存，
 *     那条回执本来就必须带 `unverified_region`。
 *
 * ## 这份"当前内容"是不是我们观测过的那一版
 *
 * 账本的键是 **`路径@内容令牌`**（`rememberRead` 的注释写着为什么是内容令牌而不是行号/时间戳）：
 * 因此 `hasObservedVersion(路径, 当前内容的令牌)` 回答的是"**这份**内容我们见过吗"。
 * 它答 false 有两种情形，回执都给"未核对"，但**说辞不同**：
 *   · 账本为空 ⇒ 没读过，根本没有基准；
 *   · 账本非空 ⇒ 这份内容是在我们最后一次观测**之后**由别人写下的。
 *     模型手上的行号来自更早的一版，而没有任何东西能替它发现这件事：
 *     写侧的版本 CAS 在一次调用**内部**取 `stat`（`write-path` 顶部注释与 `stale-gate-test` 头部
 *     都记着这条），调用之前发生的第三方写入对它是"当前状态"，不是冲突。
 *     所以这里把它标成 `unobserved-revision` —— 诚实地说"我核对不了"，而不是默默放行。
 *     注意它与 `basis: 'none'` 的分工：`none` 是闸门**没找到**基准，
 *     `unobserved-revision` 是闸门找到了基准、但基准对不上**当前这一版**。
 *
 * ## 基准换成了什么（C18）
 *
 * 闸门要回答的问题只有一个：**被寻址区域在这次观测之后有没有被改过**。既然如此，
 * **最少需要重算的是「观测那一份还在不在」，而不是「每个 hunk 落在哪」**：两份内容逐字符相同时，
 * “哪一段被改过”这个问题是自明的（一个字符都没变），而逐 hunk 重放一遍观测全文的规划，
 * 算出来的必然是“没有冲突”。
 *
 * · 换掉的是：**逐 hunk 把整份观测内容重新 `planHunks` 一遍**，外加每个 hunk 几遍整份
 *   `split(/\r?\n/).join('\n')`。90001 行档一次两行改动的写侧端到端实测（`write-gate-cost-test` 段A）：
 *   闸门 87.61ms / 端到端 268.84ms = 32.6%，而闸门那一格几乎全是这份重复规划。
 * · 换来的是：一次 `observation.source === content` 的整串比较加一次令牌长度比对，之后直接回
 *   “已核对、无冲突”。90001 行档（两份各 5.3MB 的不同字符串）闸门那一格实测 1.73-1.89ms，
 *   逐轮 ms = [1.78, 1.70, 1.66, 1.73, 1.65, 1.75, 3.75]；同一个字符串对象相比是 0.004ms
 *   （指针级），真实形态走的是 memcmp 级的那条路，所以这里报的是前一串数，不是后一个。
 *
 * ## 保住了什么（判据零放松，逐条对齐）
 *
 * · 逐字符相同 ⇒ 旧路径的每一步都**不可能**报冲突：`regionTextIn(观测, hunk)` 与
 *   `regionTextIn(当前, hunk)` 是同一个纯函数、同一组入参（内容逐字符相同、hunk 同一个、filePath 同一个），
 *   不可能一个回 null、另一个给出别的文本；
 * · 坐标核对那一步本来就被“两份内容逐行相同”这条短路跳过——而那条短路是**旧代码自己**
 *   用来判“不可能有漂”的判据（见 {@link staleConflicts} 里那处注释），这里只是把它放到
 *   “不必先重算一遍”的位置上；
 * · `basis` 的诚实性不打折：令牌的另一半是长度，长度对得上就意味着当初记账用的 BOM 约定与这次一致，
 *   两个有效串因此逐字符相同、令牌必然相同（推导见 {@link storedTokenLength}）；
 *   对不上就**不走这条路**，交回老路径完整算一遍令牌，如实标 `basis: 'none'`。
 * · 内容只要差一个字符（哪怕只差行尾），快路就不成立，走的仍是原来那条逐 hunk 判据的路。
 *
 * ## 为什么不拿“行尾归一后相同”当快路
 *
 * 那个条件比逐字符相同宽：两版内容在定位器眼里未必等价（`old` 的整行对齐第一级是**逐字**的），
 * 拿它当快路等于**悄悄放松**判据。所以快路只认逐字符相同——先证等价，再换实现。
 *
 * @param hunks - 本次的 hunk（原始 DSL 形状）
 * @param content - 本次实际读到的内容
 * @param planned - `planHunks(content, hunks, ...)` 的结果
 * @param displayPath - 账本钥匙与回执里的路径
 * @param options.byteOrderMark - 当前文件是否有前导 BOM（账本令牌的一半；缺省 false）
 * @returns {{clean: true, basis: 'observation'|'none'} | {clean: false, message: string, extras: object}}
 */
/**
 * 区域级新鲜度闸门：手上的这份内容与**观测过的那一版**比，被寻址的区域是不是动过了。
 *
 * ## 快路：观测到的就是现在这份内容
 *
 * 闸门原来每次都要把**每个 hunk 对观测版重跑一遍定位**（{@link staleConflicts}），
 * 代价随文件规模线性增长：90001 行档实测 46.98ms，占端到端 105ms 的 45%。
 * 而绝大多数编辑里，模型手上的内容**逐字符就是**它刚读过的那一版（工具在两次调用之间
 * 什么也没做）——那时"区域是否漂移"这个问题不需要算：没有漂移可言。
 *
 * 快路因此只认**逐字符相同**：
 *   · 判据成本 O(1)（比长度 + 首个不同处），与文件规模无关；
 *   · `basis` 的诚实性不打折：令牌的另一半是长度，长度对得上就意味着当初记账用的 BOM 约定与这次一致，
 *   两个有效串因此逐字符相同、令牌必然相同（推导见 {@link storedTokenLength}）；
 *   对不上就**不走这条路**，交回老路径完整算一遍令牌，如实标 `basis: 'none'`。
 * · 内容只要差一个字符（哪怕只差行尾），快路就不成立，走的仍是原来那条逐 hunk 判据的路。
 *
 * ## 为什么不拿“行尾归一后相同”当快路
 *
 * 那个条件比逐字符相同宽：两版内容在定位器眼里未必等价（`old` 的整行对齐第一级是**逐字**的），
 * 拿它当快路等于**悄悄放松**判据。所以快路只认逐字符相同——先证等价，再换实现。
 *
 * @param hunks - 本次的 hunk（原始 DSL 形状）
 * @param content - 本次实际读到的内容
 * @param planned - `planHunks(content, hunks, ...)` 的结果
 * @param displayPath - 回执与诊断里的路径（**调用方给的那个**，不许换成别的写法）
 * @param options.identityKey - **宿主给的身份键**（同一份盘上文件必给同一个串）。
 *   它只决定**账本记在哪个键下**，不参与任何回执文本；引擎拿不到文件系统事实
 *   （junction / 符号链接 / 8.3 短名），所以这个事实只能由宿主递进来。
 * @param options.byteOrderMark - 当前文件是否有前导 BOM（账本令牌的一半；缺省 false）
 * @returns {{clean: true, basis: 'observation'|'none'} | {clean: false, message: string, extras: object}}
 */
function regionGate(hunks, content, planned, displayPath, options = {}) {
  const byteOrderMark = options.byteOrderMark === true
  /**
   * 账本的键是**同一个磁盘文件**的键，不是**同一个路径字符串**的键（C54），
   * 也不是**同一种路径写法**的键（C61）。
   *
   * C54 把词法那一半（`.` 段 / 冗余分隔符 / 正反斜线 / 盘符大小写）与进程内折叠别名
   * 收进了 `read-core.mjs`。剩下的那一半——`realpath` 才认识的 junction / 符号链接 / 8.3 短名——
   * 词法层永远拿不到（`PROGRA~1` 与真长名在词法上不共享任何前缀），而引擎被 `make-bundle.mjs`
   * 的 `copyFile` 守卫禁直接碰 `node:fs`。实测后果：读 `…\linkdir\Gamma.js`、
   * 第三方改掉被寻址的第 3 行、再用 `…\realdir\Gamma.js` 发一个**无 `expect`** 的 hunk
   * ⇒ `outcome=applied` 且磁盘被静默覆盖（两个方向各自复现过一次）。
   *
   * 现在这一半由**宿主**在 `resolve()` 那一层给出（`dsh-fs` 契约里的 `targetKey`：
   * 「stale guards and target lookup」用的不透明键，本地后端实现为 `realpath`），本函数只把它
   * 递给同一个 {@link ledgerIdentityKey}——归一化仍然只有一处，这里不重复实现。
   *
   * 为什么要递 `content`：同一个折叠类里出现过 ≥2 种写法时（例如两种写法都读过同一个文件），
   * 归一化**只能靠证据**选一份基准。手上这份全文就是那条证据：内容逐字节相同的两份观测是
   * **可互换**的，拿哪份算结论都一样。代价：只在"一个折叠类里出现过 ≥2 种写法"时才读到它。
   */
  const ledgerKey = ledgerIdentityKey(displayPath, options.identityKey)
  const observation = latestObservation(ledgerKey, { source: content })
  if (observation === null) return { clean: true, basis: 'none' }
  /**
   * 大文件观测只存令牌、不存全文（`observation-store` 的 `MAX_SOURCE`）。没有全文就没有
   * 区域级比对可言——如实退回 `basis:'none'`，但**不改写**“这一版读过没有”的答案：
   * 当前令牌在账本里 ⇒ `basis:'observation'`，否则 `none`。
   */
  if (typeof observation.source !== 'string') {
    /**
     * 只认**最新观测那一版**与当前内容相同。`hasObservedVersion` 还会命中更早的条目；
     * 但“当前内容等于很久以前读过的某一版”不等于“它与最近一次观测一致”，
     * 在没有全文可比时宁可标 `none`，也不冒充核对过。
     */
    return { clean: true, basis: observation.version === contentToken(content, byteOrderMark) ? 'observation' : 'none' }
  }
  /**
   * 快路：**要判断的那份内容就是刚观测过的那一份**（逐字符相同）⇒ 没有陈旧可言（见顶部注释）。
   *
   * 逐字符相同是**可以真的断言**的：两个字符串同一个长度、逐字符相等，V8 里走的是 memcmp 级别的比较，
   * 5.3MB 实测 0.004ms——相对于这里省掉的 87.61ms 重复规划，这一比可以忽略。
   * 第二条（令牌长度）只为把 `basis` 说准：它是“这份内容在账本里”的**充要条件的一半**，
   * 对不上就不下结论、交回老路径（宁可多算一次，不猜）。
   */
  if (observation.source === content && storedTokenLength(observation.version) === content.length + (byteOrderMark ? 1 : 0)) {
    return { clean: true, basis: 'observation' }
  }
  /**
   * 当前内容不是账本里那一版 ⇒ 没有针对**它**的基准，回执必须如实标注（不冒充新鲜）。
   *
   * 这里**不能**再套一层 `providerView`：`content` 已经是 `readText` 的解码结果（第一个 BOM 已被
   * 解码器吃掉，其余留在文本里），而账本里的令牌是 `contentToken(读到的文本, 字节里有 BOM 吗)`。
   * 多剥一层会让**多 BOM 文件**的令牌对不上——实测 `bom2` / `bom3`：账本 `contentToken(„alpha…", true)`
   * 有两个 BOM，而 `providerView` 后的那个只有一个 ⇒ 整个文件被报成"没核对过"。
   * 单 BOM 文件恰好不受影响（`providerView` 是恒等），这类"只在多重形态下露头"的错最难发现。
   *
   * 令牌这里已经算出来了（`contentToken` 是要哈希全文的，5.3MB 实测 8.9ms），所以直接当证据递进去，
   * 不另算一份。
   */
  const currentToken = contentToken(content, byteOrderMark)
  const contentIsKnown = hasObservedVersion(ledgerKey, currentToken)
  const basis = contentIsKnown ? 'observation' : 'none'
  /**
   * 冲突判据里用的是**显示路径**：它的产物是给人/模型看的（`nowAt` / 引文 / "line 3 no longer holds it"），
   * 而模型看到的路径必须是它自己给的那个——换成 realpath 会让它下次照着回执发调用时对不上。
   */
  const conflicts = staleConflicts(observation.source, content, hunks, planned.matches, displayPath, {
    contentPath: displayPath,
    byteOrderMark,
  })
  if (conflicts.length === 0) return { clean: true, basis }
  const refusal = staleRegionRefusal(displayPath, conflicts)
  return { clean: false, message: refusal.message, extras: refusal.extras }
}

/**
 * 交付覆盖闸（1.0.2）：要替换的那几行，调用方到底看过没有。
 *
 * 与 {@link regionGate} 的分工：那条问"读之后这块被别人动过吗"，这条问"这块本来就没交到你手里"。
 * 两条都排在 `dry_run` 之前——预演必须预演出真写的判决。
 *
 * 内容证据豁免：`old` / `anchor` 是抄来的原文，`handle` 是工具自己算的指纹，
 * `expect` **整段等于**被替换区域时同样算数。只覆盖一行的 `expect` 不算：
 * 它证明不了同一 hunk 里的其余几行——那正是"读了半份、写了整段"要拦的形态。
 *
 * @returns null（通过）或 `{ message, extras }`
 */
export function coverageGate(hunks, planned, content, displayPath, options = {}) {
  const version = contentToken(content, options.byteOrderMark === true)
  const delivered = deliveredRanges(displayPath, version, options.identityKey)
  const gaps = []
  for (const match of planned.matches) {
    const hunk = hunks[match.hunk]
    if (hunk === undefined || hunkRegionIsProven(hunk, match.actual)) continue
    // `matches` 里的行号字段是 `line` 与 `end`（0 基起点那一对叫 start/end；`end` 已是 1 基）。
    const endLine = Number.isSafeInteger(match.end) ? match.end : match.line
    const missing = missingRanges(delivered, match.line, endLine)
    if (missing.length > 0) gaps.push({ line: match.line, endLine, missing })
  }
  if (gaps.length === 0) return null
  const undelivered = formatRanges(gaps.flatMap((gap) => gap.missing))
  const where = gaps
    .map((gap) => (gap.line === gap.endLine ? `line ${gap.line}` : `lines ${gap.line}-${gap.endLine}`))
    .join(', ')
  const first = gaps[0].missing[0]
  const what = delivered.length === 0 ? 'not one line of this file has been delivered to you in this session' : `you never received ${undelivered}`
  return {
    message:
      `cannot patch "${displayPath}": ${what}, yet the hunks replace ${where} — that would destroy text you have not seen. Nothing was written. ` +
      `\nnext: read the missing lines first: aura_basetools_read { file_path: "${displayPath}", mode: "lines", lines: [${first[0]}, ${first[1]}] } — then retry. ` +
      `Addressing the region by content (\`old\` or \`anchor\`, which quote the text) is proof enough; ` +
      `a deliberate whole-file overwrite can pass \`allow_unobserved: true\` (the receipt will say \`unverified_region\`).`,
    extras: { undelivered, delivered, lines: gaps.map((gap) => ({ line: gap.line, endLine: gap.endLine })) },
  }
}

/** 这条 hunk 手上的证据是否**覆盖了整个被替换区域**（见 {@link coverageGate}）。 */
function hunkRegionIsProven(hunk, actual) {
  if (oldAddressOf(hunk) !== null) return true
  if (typeof hunk.handle === 'string' && hunk.handle.trim().length > 0) return true
  if (typeof hunk.anchor === 'string' && hunk.anchor.length > 0) return true
  if (typeof hunk.expect === 'string' && (hunk.expect.length > 0 || actual.length === 0)) {
    return normSpace(hunk.expect) === normSpace(actual)
  }
  return false
}

/**
 * 这个 hunk 是不是**按行号**寻址的（而不是按内容）。
 *
 * 判据必须与 {@link planHunks} / {@link locate} 的优先级一致：定位器先看 `target`，再看行区间。
 * 换句话说，同时给了 `target` 和 `lines` 时，真正决定位置的是 `target`——
 * 那么“行号可能漂了”这件事就不成立，不该拦。
 * 两份判据若各写一套，迟早出现“闸门以为在用行号、定位器其实在用符号”。
 *
 * @param hunk - 原始 DSL 形状的 hunk
 * @returns 该 hunk 的地址是否完全由行号决定
 */
function byLineNumbers(hunk) {
  /**
   * **句柄 hunk 一律不是行号地址**（HD2）。
   *
   * 它确实带行号，但那行号是**句柄自己**写的：`line: k` 是段内相对行（相对区间起点），
   * 不是从上一版视图抄来的绝对坐标。把 `{handle, line: 2}` 当 `lines: [2, 2]` 读，
   * 就是拿一个相对量去和绝对坐标比——闸门会因此误报漂移，而定位器**根本不需要**
   * 那个数（位置由句柄定）。这条正是 D7「句柄优先」在闸门这一层的写法。
   */
  if (hasHandleArg(hunk)) return false
  /**
   * `old` 是**内容地址**（见 {@link locateByOld}）：位置由原文决定，坐标只是提示，
   * 位移正是它该吸收的东西——与下面 `target` / `line_cue` 同一条理由。
   * 这一行不能漏：`{old, lines}` 同时在场时，坐标若仍被当成地址，
   * 闸门会把一次正确的“按原文改到新行号”判成 `moved` 拒掉。
   */
  if (oldAddressOf(hunk) !== null) return false
  if (typeof hunk.target === 'string' && hunk.target.trim().length > 0) return false
  if (typeof hunk.line_cue === 'string' && hunk.line_cue.trim().length > 0) return false
  return lineRangeOf(hunk) !== undefined
}
/**
 * 这段文本在**哪一行**（按行边界匹配，不匹配行中间的巧合）。
 *
 * 只回答“在不在、在哪”，**不回答“偏移了多少行”**：
 * · 用“首次出现”当原处会在文本重复时报出**假偏移**（同一段文本在别处也出现时，首次出现往往就是原处，
 *   于是算出偏移 0，等于把“你给的行号现在指着别的东西”报成“没动过”）——假数字比没有数字更坏；
 * · 偏移量对模型也没有额外用处：它仍然得重读那一段才知道现在长什么样。
 *
 * @param source - 要在其中查找的内容（**整份**内容，不是那一段文本自己）
 * @param text - 被寻址区域的原文（`match.actual` / 观测侧解析结果）
 * @param rows - 已经切好的行数组（可选）。同一份内容在一次闸门里被问多次，行数组只切一次；
 *   缺省时自己切，语义完全一样（`rows ?? source.split(/\r?\n/)`）
 * @returns {{count: number, first: number|null}} 出现次数与首次出现的行号；`first` 仅在唯一时给出
 */
function regionLinesIn(source, text, rows = null) {
  if (typeof text !== 'string' || text.length === 0) return { count: 0, first: null }
  if (rows === null && typeof source !== 'string') return { count: 0, first: null }
  // 与 {@link locate} 里 `source.split(/\r?\n/)` **同一把尺子**：行号一致，且行尾不参与比较。
  // 这一点踩过：`match.actual` 是 `split(/\r?\n/).join('\n')` 的产物（行尾归一为 LF），
  // 而按 `splitLinesWithEndings` 逐行比会留下行尾的 `\r`（`'line three\r' !== 'line three'`），
  // 于是**每一行都算“找不到”**，闸门退化成“凡是 CRLF 文件一律拒绝”——6 条断言当场变红。
  let count = 0
  let first = null
  const list = rows ?? source.split(/\r?\n/)
  for (const [i, line] of list.entries()) {
    // 只认**整行相等**：`three` 不是 `thirty three` 的一次命中。
    if (line !== text) continue
    count += 1
    if (first === null) first = i + 1
    // 命中两次就够了：判据只区分“唯一/不唯一”，全扫完没有任何好处。
    if (count > 1) break
  }
  return { count, first: count === 1 ? first : null }
}

/**
 * 纯坐标地址（`lines=` / `start_line`+`end_line`）在**观测那一版**里的区域原文；观测里没有这块区域时回 null。
 *
 * 这是闸门对“被寻址区域”的**最小重算**（C18）：区域就是那几行，按坐标取即可，
 * 不必拿整份观测内容重跑一遍定位。与 {@link regionTextIn} 的等价性逐条对齐
 * （那一份走的是 `planHunks` → `locate` 第 2 层 → `done()`）：
 *   · `actual` = `lines.slice(start - 1, end).join('\n')`（`lines = source.split(/\r?\n/)`，同一把尺子）；
 *   · 行号不是整数 / 越界 / 起止倒序 ⇒ `locate` 回 `LOCATOR_BAD_LINES` / `LOCATOR_OUT_OF_RANGE`
 *     ⇒ `planHunks` 抛错 ⇒ `regionTextIn` 回 null ⇒ 这里同样回 null。
 * 调用方只管 `byLineNumbers(hunk) === true` 的 hunk：其余形态是**内容寻址**，必须真的去定位。
 *
 * @param hunk - 原始 DSL 形状的 hunk
 * @param rows - 观测那一版的行数组（`split(/\r?\n/)`）
 * @returns 区域原文，或 null（观测里没有这块区域）
 */
function observedRegionByLines(hunk, rows) {
  const range = lineRangeOf(hunk)
  if (range === undefined) return null
  const start = range.start
  const end = range.end ?? start
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 1 || end < start || end > rows.length) return null
  return rows.slice(start - 1, end).join('\n')
}

// ── 句柄寻址（HD2）─────────────────────────────────────────────────────
//
// 句柄是**工具自己那份逐字节副本**的凭据（`handle-core.mjs`），治的是残余失败里最大的一类：
// 调用方转述原文时失真。所以句柄路**不读调用方的任何引文**——它只要一个 21 字符的短串。
//
// 四种形状与解析次序（契约 §5，已冻结；形状不对抛错，其余一律走结果通道）：
//
//   {handle, replace}                  整段替换
//   {handle, line: k, replace}         段内第 k 行（1-based，相对区间起点）
//   {handle, old, replace}             段内内容定位（区间之外不找）
//   {handle, position, replace}        区间边界插入（before / after，不改动区间本身）
//
// 相对定位器之间定优先级而不是抛错：`position` > `line` > `old` > 整段。
// 被让开的那个**必须在回执里披露**（D7：沉默忽略不行）——披露写在 `tier` 里，
// 因为 `applied[]` 上加未声明字段会让 DSH 壳整条成功路径被判成 `INVALID_TOOL_OUTPUT`。

/** 地址键 `handle` 是不是真的在场（平铺写法里空值很常见，那不是"给了句柄"）。 */
function hasHandleArg(hunk) {
  return typeof hunk?.handle === 'string' && hunk.handle.trim().length > 0
}

/** 结构地址（0.23）：`symbol:<name>` / `section:<title>` / `key:<path>`。 */
function hasStructureArg(hunk) {
  return typeof hunk?.structure === 'string' && hunk.structure.trim().length > 0
}

/**
 * 结构地址 → `{kind, path}`。形状不对在参数面抛错（与 `handle` 同一条）。
 */
function structureAddressOf(hunk) {
  if (!hasStructureArg(hunk)) return null
  const raw = String(hunk.structure).trim()
  const colon = raw.indexOf(':')
  const kind = colon > 0 ? raw.slice(0, colon) : ''
  const path = colon > 0 ? raw.slice(colon + 1).trim() : ''
  if (!['symbol', 'section', 'key'].includes(kind) || path.length === 0) {
    throw new PatchError(
      '`structure` must be "symbol:<name>", "section:<title>", or "key:<path>" — nothing was written',
      'PATCH_STRUCTURE_SHAPE',
    )
  }
  return { kind, path }
}

/**
 * 把一个结构路径解析成当前文件里的行区间（**唯一**才收）。
 *
 * 判据：
 *   · `symbol`：交给 `resolveTarget`（支持 `function:foo` / `Outer/Inner` / `#n`）；歧义把候选递回；
 *   · `section`：Markdown 标题；范围到下一个同级或更高级标题前一行；
 *   · `key`：JSON/TOML/YAML 的键（`doc-structure` 的条目，名字精确或点号后缀命中）。
 */
function resolveStructureRegion(lines, structure, ctx) {
  const content = ctx.content
  if (structure.kind === 'symbol') {
    const lang = langOf(ctx.label)
    if (lang === null) {
      throw new PatchError(`"${structure.path}" is a symbol address, but ${ctx.label} has no symbol language — use section:/key: instead; nothing was written`, 'PATCH_STRUCTURE_NOT_FOUND')
    }
    let hit
    try {
      hit = resolveTarget(indexStructure(content, lang), structure.path)
    } catch (error) {
      if (error?.code === 'STRUCT_AMBIGUOUS') {
        throw new PatchError(
          `"${structure.path}" matched ${Array.isArray(error.candidates) ? error.candidates.length : 'several'} symbols — add #<n> or a scope (Outer/Inner), or use lines; nothing was written`,
          'PATCH_STRUCTURE_AMBIGUOUS',
          { candidates: error.candidates },
        )
      }
      throw new PatchError(`no symbol matching "${structure.path}" in ${ctx.label} — nothing was written`, 'PATCH_STRUCTURE_NOT_FOUND')
    }
    const rows = regionRowsAt(lines, hit.startLine, hit.endLine)
    if (rows === null) throw new PatchError(`"${structure.path}" resolves outside the current file — nothing was written`, 'PATCH_STRUCTURE_NOT_FOUND')
    return { startLine: hit.startLine, endLine: hit.endLine, rows, moved: false, structure: { kind: 'symbol', path: structure.path } }
  }
  const docKind = docKindOf(ctx.label)
  if (docKind === null) {
    throw new PatchError(`"${structure.path}" is a ${structure.kind} address, but ${ctx.label} is not a document/config file; nothing was written`, 'PATCH_STRUCTURE_NOT_FOUND')
  }
  const doc = indexDocument(content, docKind)
  if (structure.kind === 'section') {
    const headings = doc.entries.filter((entry) => entry.kind === 'heading')
    const matches = headings.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.name === structure.path)
    if (matches.length === 0) throw new PatchError(`no section titled "${structure.path}" in ${ctx.label} — nothing was written`, 'PATCH_STRUCTURE_NOT_FOUND')
    if (matches.length > 1) {
      throw new PatchError(`"${structure.path}" matched ${matches.length} sections — use a unique title; nothing was written`, 'PATCH_STRUCTURE_AMBIGUOUS', {
        candidates: matches.map(({ entry }) => ({ name: entry.name, startLine: entry.startLine })),
      })
    }
    const { entry, index } = matches[0]
    let endLine = lines.length
    for (let i = index + 1; i < headings.length; i += 1) {
      if (headings[i].depth <= entry.depth) {
        endLine = headings[i].startLine - 1
        break
      }
    }
    /** 尾部的空行是**节与节之间的分隔**，不属于上一节的正文：换掉一节不该吃掉分隔行。 */
    while (endLine > entry.startLine && String(lines[endLine - 1] ?? '').trim() === '') endLine -= 1
    const rows = regionRowsAt(lines, entry.startLine, endLine)
    if (rows === null) throw new PatchError(`section "${structure.path}" has no rows in the current file — nothing was written`, 'PATCH_STRUCTURE_NOT_FOUND')
    return { startLine: entry.startLine, endLine, rows, moved: false, structure: { kind: 'section', path: structure.path } }
  }
  // key
  const matches = doc.entries.filter((entry) => entry.name === structure.path || entry.name.endsWith(`.${structure.path}`))
  if (matches.length === 0) throw new PatchError(`no key "${structure.path}" in ${ctx.label} — nothing was written`, 'PATCH_STRUCTURE_NOT_FOUND')
  if (matches.length > 1) {
    throw new PatchError(`"${structure.path}" matched ${matches.length} keys — use the full dotted path; nothing was written`, 'PATCH_STRUCTURE_AMBIGUOUS', {
      candidates: matches.map((entry) => ({ name: entry.name, startLine: entry.startLine })),
    })
  }
  const entry = matches[0]
  const endLine = Number.isInteger(entry.endLine) && entry.endLine >= entry.startLine ? entry.endLine : entry.startLine
  const rows = regionRowsAt(lines, entry.startLine, endLine)
  if (rows === null) throw new PatchError(`key "${structure.path}" has no rows in the current file — nothing was written`, 'PATCH_STRUCTURE_NOT_FOUND')
  return { startLine: entry.startLine, endLine, rows, moved: false, structure: { kind: 'key', path: structure.path } }
}

/**
 * 句柄参数 → 它自己带的坐标与摘要。**形状不对在这里抛错**（契约 §5 第 0 步）。
 *
 * 形状不对为什么是抛错而不是结果：它是"参数没成形"（与 `ARGS_UNKNOWN_KEY` / `PATCH_NO_ADDRESS`
 * 同族），不是"判不出意图"。拿一条 `outcome=not_found` 去回答它，调用方会去改地址，
 * 而它真正要做的只是把那个字段写对。
 */
function handleAddressOf(hunk) {
  if (hunk.handle === undefined || hunk.handle === null) return null
  if (typeof hunk.handle === 'string' && hunk.handle.trim().length === 0) return null
  const verdict = handleShapeVerdict(hunk.handle)
  if (!verdict.ok) {
    throw new PatchError(
      `\`handle\` ${verdict.reason} — pass the handle exactly as the read receipt printed it`,
      'PATCH_HANDLE_SHAPE',
    )
  }
  return verdict.parsed
}

/** 某一段行区间在 `rows` 里的原文；越界 / 倒序 ⇒ null（行号尺子与 `locate` 同一把）。 */
function regionRowsAt(rows, startLine, endLine) {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null
  if (startLine < 1 || endLine < startLine || endLine > rows.length) return null
  return rows.slice(startLine - 1, endLine)
}

/**
 * 句柄 hunk 在**观测那一版**里的区域原文：句柄自己带的坐标就是它读时那几行。
 *
 * 与 {@link observedRegionByLines} 同一条路（都是"按坐标取那几行"），差别只在坐标从哪来：
 * 那条从调用方写的 `lines` 来，这条从**句柄**来——句柄里的行号是读侧当时自己写下的，
 * 比调用方拄的坐标可信。回 null 的情形同那条：观测里没有这块区域（当时行数更少 / 不是这份文件）。
 */
function observedRegionByHandle(handleText, rows) {
  const parsed = parseHandle(handleText)
  if (!parsed.ok) return null
  const region = regionRowsAt(rows, parsed.startLine, parsed.endLine)
  return region === null ? null : region.join('\n')
}


/**
 * 同一个 hunk 在**另一份内容**里解析出的区域文本；解析不到返回 null。
 *
 * “解析不到”是**正常结果**（观测里根本没有这块区域），不是吞错：
 * 只对定位类错误这样说，其它错误（实现 bug）必须继续往上抛。
 *
 * @param source - 参照内容
 * @param hunk - 待解析的 hunk
 * @param filePath - 用于判定语言
 * @returns 该区域文本，或 null
 */
function regionTextIn(source, hunk, filePath) {
  try {
    const planned = planHunks(source, [{ ...hunk, replace: hunk.replace ?? '' }], filePath)
    return planned.matches[0] === undefined ? null : planned.matches[0].actual
  } catch (error) {
    if (/^(PATCH_|LOCATOR_|STRUCT_)/.test(String(error?.code ?? ''))) return null
    throw error
  }
}

/** 把“行 + 行尾”拼回文本（与 {@link splitLinesWithEndings} 互逆）。 */
function joinLinesWithEndings(lines, endings) {
  return lines.map((line, i) => line + (endings[i] ?? '')).join('')
}

// ── 内容寻址：`old`（＋可选 `context`）────────────────────────────────────────
//
// 地址的**主**形态是内容，不是坐标：`old` 是要替换的原文，`context` 是消歧用的额外原文。
// 坐标（`lines` / `start_line` / `end_line`）仍然被读，但只当**提示**：
//   · 它不决定位置——与 `old` 冲突时以 `old` 为准；
//   · 落点与它不一致时，回执必须明说“坐标与原文不符，已按原文定位”（见 {@link locateByOld}）。
//
// 为什么不让坐标在歧义时“就近挑一个”：`anchor-core` 的 `pickNear` 只在调用方**显式**给了
// `near` 提示时才收敛；而一串从上一版视图里抄来的坐标，并不比 `old` 更知道“你想改的是哪一个”。
// 让坐标当裁决者，正是本工具存在的理由（内置 `edit` 多处匹配静默取第一个）所要防的事。
// 所以坐标只做两件事：与落点核对、不符就如实报告。

/** `old` 是非空、且不全是空白的字符串时，才算给了内容地址。 */
function oldAddressOf(hunk) {
  return typeof hunk.old === 'string' && hunk.old.trim().length > 0 ? hunk.old : null
}

/**
 * 把调用方给的原文切成行：行尾按 LF 归一，末尾那个空元素不参与
 * （与 `locateWith` 对 `anchor` 的处理是同一把尺子）。
 */
function addressRows(text) {
  const rows = text.replace(/\r\n/g, '\n').split('\n')
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
  return rows
}

/**
 * 行对齐的两级匹配，由严到松：逐字 → 行内空白折叠（`normSpace`）。
 *
 * 与 `anchor-core` 用同一套归一化（`normSpace`），但这一层**只认整行对齐**：`old` 覆盖完整的行（或
 * 连续几整行）时按行区间命中。落在行**中间**的匹配由下一层（{@link FRAGMENT_TIERS}）接手——
 * 那一层替换**命中跨度自己**，行内其余字节逐字不动（C13）。
 * 为什么只有两级、也不跟到 T4/T5 的相似度层：`old` 是“要替换的原文”，一段**根本不在文件里**的
 * 文本若被相似度层接住，就会改到另一段文本上——正是本工具要消灭的静默错配（段E 钉住这条）。
 * 为什么不需要单独一层 strip-line（`anchor-core` 的 T3）：`normSpace` 逐行折叠空白并去首尾，
 * 因此 strip 相等的两行折叠后必然相等——再加一层是死码。
 */
const ADDRESS_TIERS = [
  { tier: 'exact', norm: (text) => text },
  { tier: 'norm-space', norm: normSpace },
]

/** `rows` 在 `lines` 里所有**行对齐**出现的位置（0-based 起点）。 */
function windowStarts(lines, rows, norm) {
  const span = rows.length
  if (span === 0) return []
  const needle = norm(rows.join('\n'))
  const starts = []
  for (let i = 0; i + span <= lines.length; i += 1) {
    if (norm(lines.slice(i, i + span).join('\n')) === needle) starts.push(i)
  }
  return starts
}

/** 在 `lines` 里找 `rows`：取第一个有命中的匹配级，返回 `{tier, norm, starts}`（一个都没有时 tier 为 null）。 */
function findWindowTier(lines, rows) {
  for (const { tier, norm } of ADDRESS_TIERS) {
    const starts = windowStarts(lines, rows, norm)
    if (starts.length > 0) return { tier, norm, starts }
  }
  return { tier: null, norm: null, starts: [] }
}

/**
 * 行内片段层的两级匹配，由严到松（同 {@link ADDRESS_TIERS} 的读法）：逐字 → 行内空白折叠。
 *
 * 为什么需要这一层：`old` 是“要替换的原文”，而人（与模型）引用原文时给的是**片段**——
 * 原文写着 `beta gamma`，它只写 `gamma`。整行对齐那一层要求 `old` 覆盖完整的行，于是这类
 * “位置对、说法不对”的调用被一律判成 `PATCH_NOT_FOUND`。实测（`failure-replay` 重放语料）：
 * 旧契约下成功的调用在新契约下死掉 23 条，逐条看，19 条的引文**就在原文里**，只是不是整行。
 *
 * 为什么只到「片段逐字出现」为止、不再往下跟相似度层：理由与上面 {@link ADDRESS_TIERS} 那段一字不变——
 * 片段在文件里没有出现就是没有出现，相似度层会把改动落到**另一段文本**上，那正是本工具
 * 要消灭的静默错配。剩下 4 条正好是这条边界的实证：它们的引文与原文**实质不同**
 * （引用的是改后文本 / 语料副本里那句话根本不在），片段层如实放它们继续 `PATCH_NOT_FOUND`。
 */
const FRAGMENT_TIERS = [
  { tier: 'fragment', norm: (text) => text },
  { tier: 'fragment~norm-space', norm: normSpace },
]

/**
 * `fragment` 在 `lines` 里的每一处出现，**扩成覆盖它的整行区间**：`{start, span}`（0-based）。
 *
 * 替换范围取「包含片段的整行」而不是「片段自己那一段」，三条理由：
 *   · 拼接层是按行换的（{@link planHunks} 的倒序拼接用的是 `splitLinesWithEndings` 的行与行尾），
 *     调用方给的 `replace` 也是按行写的；把 `replace` 塞回行的中间，等于让一段**整行**替换文本
 *     长在一条半行的缝里；
 *   · 行粒度才说得清“改了多大一片”：回执的 `actual` / `replaced` 都是按行比对的，
 *     “行内插入”没有任何字段能表达它替换掉了什么；
 *   · 与整行对齐层同一个落点形状（`{start, span}`），收敛/就近/歧义收据两层共用一份代码。
 * 代价明说：调用方给的 `old` 只是行的一部分，被换掉的却是整行——所以命中后回执必须**披露**
 * 这一点（见 {@link fragmentNoteOf}），否则“我只写了 `gamma`”与“整行没了”之间少一句话。
 *
 * 归一化与 `expectVerdict` 的全文扫描是同一把尺子（`normSpace` 逐行折叠、保留换行、把行拼成一篇
 * 再找偏移），因此命中偏移映射回行号是精确的；两处各写一套断行约定，同一个“第 7 行”就会指向
 * 不同字节（本仓在 BOM / CRLF 上已经栽过同族的一次）。
 *
 * 同一行里出现两次只算**一个**候选：替换范围是整行，两次出现落在同一个区间上——
 * 那不是“两处让你挑”，是同一处。
 */
/**
 * `fragment` 在 `lines` 里的每一处出现，连同**它自己那一段原文**：`{start, span, startCol, endCol, text}`（0-based）。
 *
 * 替换范围就是这一处出现本身（C13）。**不许**扩成包含它的整行：`old` 是“要替换的原文”，
 * 调用方写 `gamma`、磁盘上整行没了，是“成功但结果不是调用方要的”的静默失效。实测形状：
 * `{old:"x = 1", replace:"x = 2"}` 打在 `const x = 1` 上，整行版把 `const ` 静默吞掉。
 * 所以这里把**命中跨度**算准（起止列 + 那一段原文），拼接层据此只换这一段（见 {@link planHunks}）。
 *
 * 为什么仍带行的行区间 `{start, span}`：收敛/就近/歧义两轮与整行对齐层共用一份候选代码
 * （{@link contextSitsAt} / {@link nearestOnly} 都按行读数），跨度与它在同一行上是自洽的。
 *
 * 归一化与 `expectVerdict` 的全文扫描是同一把尺子（`normSpace` 逐行折叠、保留换行、把行拼成一篇
 * 再找偏移），因此命中偏移映射回行列是精确的；两处各写一套断行约定，同一个“第 7 行”就会指向
 * 不同字节（本仓在 BOM / CRLF 上已经栽过同族的一次）。
 *
 * 归一化层下行内的偏移可能与文件里的偏移不同（`beta   gamma` 折叠成 `beta gamma`），
 * 所以原文**从归一化行里取**、列号**从原文里量**——两个坐标系各自取自己那一份，不互相换算。
 *
 * 同一行里出现两次算**两个**候选：两处片段落在同一行的不同列上，替换的是不同的字节——
 * 那正是“两处让你挑”，不许挑一个（同 `old` 出现在两行的口径，见 {@link oldAmbiguityError}）。
 */
function fragmentSpans(lines, fragment, norm) {
  const want = norm(fragment.replace(/\r\n/g, '\n')).replace(/^\n+/, '').replace(/\n+$/, '')
  if (want.length === 0) return []
  const normLines = lines.map((line) => norm(line))
  const offsets = []
  for (let i = 0, off = 0; i < normLines.length; i += 1) {
    offsets.push(off)
    off += normLines[i].length + 1
  }
  const hay = normLines.join('\n')
  const lineAt = (offset) => {
    let i = offsets.length - 1
    while (i > 0 && offsets[i] > offset) i -= 1
    return i
  }
  /**
   * “归一化行内偏移 → **原文**行列”的映射。为什么要有它：`startAt` / `endAt` 是**归一化后**的
   * 行内偏移，而拼接层是按**原文**列号切的——`normSpace` 剪掉了行首空白、又把行内连续空白折成
   * 一个，两个坐标系按空白量差开。做法走一遍行，O(行长度)：非空白字在原文里占一列，
   * 空白字在原文里占掉**一整段**（只吃同一种空白：吃“所有空白”会把行尾的 `\n` 一并吞掉）。
   * 不能拿原文去 `indexOf` 那一段：归一化剪过之后它根本不是子串。
   *
   * 切点用 `map[n]`（**归一化前 n 个字的切点**）：它与调用方那句 `old` 同一个尺度——
   * `want` 自己已经被去掉首尾换行，所以首/末两侧贴着的空白本来就不属于这一段。
   */
  /**
  /**
   * **归一化的一段文字**在**原文行**里的起止（`from` / `to`，0-based 开区间）。
   *
   * 归一化只用来回答“在哪”（`normLines` 与 `offsets`），列号必须**从原文量**：`normSpace` 剪掉了
   * 行首空白、又把行内连续空白折成一个空格，两个坐标系按空白量差开。做法分两步：
   *   1. 先在归一化行里定位那段文字（`indexOf`），拿到它在**归一化坐标**里的起点；
   *   2. 从那个字开始逐字对齐原文（`rawLine.indexOf(字符, 上一个命中 + 1)`）——归一化只删空白、
   *      不增删非空白字符，所以每个非空白字符在原文里的下一个出现就是它自己，被折掉的空格自动跳过。
   *
   * 不能拿原文去 `indexOf` 整段引文：归一化剪过空白之后它在原文里根本不是子串
   * （实测：`  beta   gamma` 的引文 `beta gamma` 在原文里搜不到，列号算成 0）。
   */
  const rawSpanIn = (i, chunk, at) => {
    const rawLine = lines[i]
    const lineNorm = normLines[i]
    if (chunk.length === 0 || at < 0) return { from: 0, to: 0 }
    if (chunk.length > lineNorm.length - at) return { from: 0, to: 0 }
    /**
     * 先把这一行“原文列 ↔ 归一化列”的对应表算出来：两个指针同步往前走，对得上就记一笔，
     * 对不上说明原文多了一段空白（`normSpace` 折掉的那些），原文指针多走一步再看。
     * 两个指针都只向一个方向走，所以这层是 O(行长度)、也不需要任何 `indexOf` 猜测。
     */
    const pairs = []
    let r = 0
    let n = 0
    while (r < rawLine.length && n < lineNorm.length) {
      if (rawLine[r] === lineNorm[n]) {
        pairs.push([r, n])
        r += 1
        n += 1
      } else {
        r += 1
      }
    }
    const rawOf = (normAt) => {
      const pair = pairs.find(([, n2]) => n2 === normAt)
      return pair === undefined ? -1 : pair[0]
    }
    const from = rawOf(at)
    const lastRaw = rawOf(at + chunk.length - 1)
    if (from === -1 || lastRaw === -1) return { from: 0, to: 0 }
    /**
     * 末列就是命中末字本身（`to` 为 0-based 排他）。旧代码还会把“与末字相同的后续字符”
     * 一并吞掉——那对 **exact** 层是实打实的越界（`old:"ax "` 会吃掉两个空格），
     * 对 norm-space 层也从未生效（`collapse` 每行都 trim，归一化片段不会以空白结尾）。
     * 片段层的承诺是“只换命中跨度自己”，所以这里不再做任何扩展。
     */
    return { from, to: lastRaw + 1 }
  }
  const spans = []
  const seen = new Set()
  for (let p = hay.indexOf(want); p !== -1; p = hay.indexOf(want, p + 1)) {
    const start = lineAt(p)
    const end = lineAt(p + want.length - 1)
    /** 命中在首/末行里的**归一化偏移**（行内）。同一行时两者是同一行内的两个位置。 */
    const startAt = p - offsets[start]
    const endAt = p + want.length - 1 - offsets[end]
    // 去重键唯一：同一行里的两处出现列号不同，不合并（它们替换的字节本来就不同）。
    const key = `${start}:${startAt}-${end}:${endAt}`
    if (seen.has(key)) continue
    seen.add(key)
    /**
     * 列号必须落到**原文**的坐标系里（拼接层按列号切原文）。
     *
     * `startAt` / `endAt` 是**归一化行内**的偏移（“第几个字”），两个坐标系按被折掉的空白量差开；
     * 首列取首段在原文里的起点、末列取末段在原文里的终点，两组都由 {@link rawSpanIn} **从原文量**
     * ——不能按“归一化宽度”递推：空白折叠层下 `beta   gamma` 与 `beta gamma` 宽度不同，
     * 递推出来的末列会少算被折掉的那几个空格（实测：跨度只盖到片段中间，替换后留下 `BETAamma`）。
     */
    /**
     * `want` 里属于**首行 / 末行**的那两段：单行时整段就是这一段（起点 `startAt`）；跨行时首段到
     * 首行行尾为止（其余都是中间整行与末行那一段），末段占末行行首 `endAt + 1` 个字
     * （{@link addressRows} 已把 `want` 首尾的空行去掉，所以首尾两行都是实打实有内容的）。
     */
    const firstWidth = start === end ? want.length : want.length - (endAt + 1)
    const lastAt = start === end ? startAt : 0
    const head = rawSpanIn(start, normLines[start].slice(startAt, startAt + firstWidth), startAt)
    /** 末段落在**末行**里，它的列号是末行内的坐标（`fragment.lines` 那一侧用它）。 */
    const tail = rawSpanIn(end, normLines[end].slice(lastAt, endAt + 1), lastAt)
    const startCol = head.from + 1
    /**
     * 末列：单行时就是这一段的末字（`head.to`）；跨行时再往末行推 `endAt + 1` 列——末段从末行
     * 行首起，在原文里的宽度与归一化一致（只差被折掉的空白，而它前面没有折叠）。
     * 不能取 `tail.to`：那是**末行内**的列号，而这里要的是**首行内**的列号
     * （`planHunks` 的片段拼接按 `fragment.columns` 在**首行**上切 `prefix` / `tail`）。
     */
    const endCol = start === end ? head.to : head.to + endAt + 1
    /**
     * 首行从命中起点截、末行取到命中终点：`text` 因此**逐字**是文件里那一段（含它自己的空白），
     * 而 `startCol` / `endCol` 是它在**原文**里的列号（1-based 闭区间）——两者同一把尺子：
     * 单行时 `text === lines[start].slice(startCol - 1, endCol)`，回执可核对的前提就是这条恒等式。
     * 跨行时首行只要“从命中起点起的后缀”、末行只要“到命中终点为止的前缀”，
     * 各拼回原文里被剪掉的那一头（首行的前导空白、末行的后继空白）。
     */
    const firstText = start === end ? want : lines[start].slice(head.from, head.to) + normLines[start].slice(startAt + firstWidth)
    const lastText = start === end ? want : lines[end].slice(0, tail.to)
    /** `want` 里首尾两段之间夹着的那些**整行**（跨行时才非空；空行也必须保留）。 */
    const middleRows = normLines.slice(start + 1, end)
    /**
     * 单行时 `text` **从原文里取**（`lines[start].slice(startCol - 1, endCol)`）——归一化只用来
     * 回答“在哪”，回执里那一段必须是文件里逐字的原文，否则空白折叠层下调用方拿到的引文
     * 在文件里根本搜不到。跨行时首尾各取自己那一半；中间行**逐个**拼回去，
     * 不能用 `join` 后过滤空串（那会把 `a\n\nb` 的空白行丢掉，`actual` 与 `expect` 随之错位）。
     */
    const text =
      start === end
        ? lines[start].slice(startCol - 1, endCol)
        : [firstText, ...middleRows, lastText].join('\n')
    spans.push({ start, span: end - start + 1, startCol, endCol, endLineCol: tail.to, text })
  }
  return spans
}

/** 片段层取第一个有命中的匹配级，返回 `{tier, norm, spans}`（都没有时 tier 为 null，同 {@link findWindowTier}）。 */
function findFragmentTier(lines, fragment) {
  for (const { tier, norm } of FRAGMENT_TIERS) {
    const spans = fragmentSpans(lines, fragment, norm)
    if (spans.length > 0) return { tier, norm, spans }
  }
  return { tier: null, norm: null, spans: [] }
}

/**
 * 片段层命中的**披露**：`old` 只是行的一部分，被替换的是整行（或整片行）。
 *
 * 与坐标的说明（{@link locateByOld} 的 `coordinateNote`）同一条规矩：地址落到哪里与调用方字面写的
 * 不同，回执就必须说清——否则调用方看到“我明明只写了 `gamma`”而磁盘上整行没了，中间没有任何
 * 一句话解释这多出来的改动面。`tier` 是 `applied[]` 上唯一能承载这句话的**已声明**字段
 * （DSH 壳的 `output.schema` 是 `additionalProperties: false`，加未声明字段会让整条成功路径
 * 被判成 `INVALID_TOOL_OUTPUT`）。
 */
/**
 * 片段层命中的**披露**：被替换的**就是这一处命中跨度本身**，行内其余字节逐字不动。
 *
 * 与坐标的说明（{@link locateByOld} 的 `coordinateNote`）同一条规矩：地址落到哪里与调用方字面写的
 * 不同，回执就必须说清这次替换**覆盖了哪一段**（起止列 + 原样片段），让调用方能核对。
 * `tier` 是 `applied[]` 上唯一能承载这句话的**已声明**字段（DSH 壳的 `output.schema` 是
 * `additionalProperties: false`，加未声明字段会让整条成功路径被判成 `INVALID_TOOL_OUTPUT`）。
 *
 * `text` 原样进回执、一字不剪：剪了它就不再是“被替换的那一段”——核对的前提是它逐字可对。
 */
function fragmentNoteFor(line, startCol, endCol, text) {
  /**
   * 引文放在**最后**：它可能是多行的忠实块（跨行片段，见 {@link fragmentSpans}），
   * 而块尾自带换行 —— 后面再跟半句话，那句话就会另起一行、把句子读断。
   * 换成"先说完替换范围，再把被替换的那一段贴出来"，两种形态都读得通。
   */
  return (
    `\`old\` matches inside line ${line} — only columns ${startCol}-${endCol} are replaced; ` +
    `the rest of the line is kept byte-for-byte. Replaced text: ${quoteForMessage(text, line)}`
  )
}

/**
 * `anchor` 是不是只引用了命中区域的一部分？
 *
 * `anchor` 走 {@link locate} 的行窗口（`anchor-core`），命中结果 `actual` 是**整行**；
 * 因此调用方给一段行内文字当锚点时，`replace` 会顶掉整行，行内其余字节被静默吞掉。
 * 这与 C13 给 `old` 片段层立的规矩相反（那里只换命中跨度自己），也是 2026-10-27
 * 真实会话里 5 次截断的成因：`{anchor:"2.4, 0.1, 2.6, -0.4", replace:"2.4, 0.27, ..."}`
 * 打在整行 `walk(put(...), 2.4, 0.1, ...)` 上，回执 `actual` 整行、`replaced` 片段，
 * 磁盘上只剩片段。
 *
 * 判据只认**归一化后是命中区域的真子串**：整行锚点、以及容错层接住的改写整行
 * （归一化后不是子串）都不受影响；`old` 的片段层本来就走另一条路。
 * 返回 true 时调用方必须**零写入**并改用 `old` 或补全整行，不许替调用方猜“它想换行内”。
 */
function anchorIsPartialLine(anchorText, actual) {
  const normalize = (text) =>
    normSpace(addressRows(String(text).replace(/\r\n/g, '\n')).join('\n')).replace(/^\n+|\n+$/g, '')
  const anchor = normalize(anchorText)
  const region = normalize(actual)
  return anchor.length > 0 && anchor.length < region.length && region.includes(anchor)
}
/**
 * `context` 是否落在某个候选的**邻域**里。
 *
 * 邻域 = 候选窗口向上下各放宽 `context.length + radius` 行。同一个判据服务两个轮次：
 *   · `radius = 0`（第一轮）：context 紧邻候选（正上方 / 正下方），或 context 自身就是包含
 *     `old` 的那一段（那时 context 的出现位置与候选窗口重叠，仍在邻域内）；
 *   · `radius = context.length`（第二轮，**自动扩大上下文重试一次**）：专门救“context 与 old
 *     之间还隔着几行”这种半对地址。
 *
 * 为什么放宽量取“一个 context 长度”而不是“整份文件”：放宽到全文就等于“context 在文件里出现过”，
 * 每个候选都会通过，这个判据就退化成没有判据（`anchor-core` 里 anchor 相似度层踩过同族的坑）。
 */
function contextSitsAt(lines, start, span, ctxRows, norm, radius) {
  const from = Math.max(0, start - ctxRows.length - radius)
  const to = Math.min(lines.length, start + span + ctxRows.length + radius)
  return windowStarts(lines.slice(from, to), ctxRows, norm).length > 0
}

/**
 * 从候选里取**唯一最近**的一个（按行号距离）；并列最近 ⇒ null（不猜）。
 *
 * 与 `anchor-core` 的 `pickNear` 同一条规矩：`near` 是调用方显式给的歧义提示，
 * 而“等距时挑一个”就是替调用方掷骰子——那正是本工具要消灭的行为。
 */
function nearestOnly(starts, near) {
  let best = null
  let bestDistance = Infinity
  let ties = 0
  for (const start of starts) {
    const distance = Math.abs(start + 1 - near)
    if (distance < bestDistance) {
      bestDistance = distance
      best = start
      ties = 1
    } else if (distance === bestDistance) ties += 1
  }
  return ties === 1 ? best : null
}

/**
 * 引用原文的两个引用点（{@link fragmentNoteFor} / {@link expectGateError}）
 * 与候选清单（{@link candidateListing}）都走 `quoteForMessage` —— 本文件不再自带一份同形实现。
 */

/**
 * 「找不到」回执的**体量预算**（判据：`notfound-receipt-test` 段D）。
 *
 * 上限不是拍的，是宿主的：DSH 的 `dsh-compaction-tool-result-pruner` 对超过
 * `toolResultPruner.config.thresholdChars` 的**工具结果**做头尾裁剪——中间那一段换成一行
 * `[... tool result middle pruned ...]`，只留头 `headChars` 与尾 `tailChars`。
 * 本轮部署实测（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:396-399`，
 * 三个 preset 与 `DEFAULTS` 同值）：`thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`。
 * 超阈的代价正好落在本回执上：被剪掉的是中间，而"那一带原文"就在中间。
 *
 * 6000 < 8192，且 6000 < 4096 + 1024 + 标记长度 ⇒ 整份回执连"只留头窗"那种形态也装得下。
 *
 * ## 这笔预算怎么分（每层都被上一层夹住，合计可证不越 6000）
 *
 *   · 头部（钉住的两句 + `label`）：`label` 最多占 `6000 − {@link NOTFOUND_DETAIL_FLOOR} − 定句长度`；
 *   · "那一带"的说明句：≤ ~520 字符（计数是数字，两处引文各被 {@link quoteForMessage} 夹在自己的限额里）；
 *   · 行号/标记的**身份声明**：≤ ~410 字符（见 {@link notFoundDetail} 的 `bandIdentity`）——
 *     它写在 `fixed` 里，所以已被下面那条"剩下的额度"扣掉，不必另算一份；
 *   · 那一带**原文本身**：≤ {@link NOTFOUND_BAND_CHARS}，且不超过"剩下的额度"；
 *     裁剪过的行另付 ~40 字符的 `[clipped — NOT copyable]` 标记（见 {@link clipReceiptLine}），
 *     所以单行占地上限是 `NOTFOUND_LINE_CHARS` + 那个标记，不是 `NOTFOUND_LINE_CHARS`；
 *   · 截断披露：≤ {@link NOTFOUND_NOTE_CHARS}。
 *
 * 原文那一层的下限是 {@link NOTFOUND_DETAIL_FLOOR}：路径再病态也不许把原文挤没。
 * 因此不需要末尾再兜一刀——每一层各自夹在自己那一份里，等式是算出来的，不是估出来的。
 */
const NOTFOUND_RECEIPT_CHARS = 6000
const NOTFOUND_DETAIL_FLOOR = 1400
const NOTFOUND_NOTE_CHARS = 300
/** 那一带最多展示几行原文：够看清"对得上的那一段"与"从哪一行开始对不上"。 */
const NOTFOUND_BAND_LINES = 12
/**
 * 回执末尾那段**修法**的字符上限（`repairBlock` 的护栏）。
 *
 * 它不是拍出来留余量的：那一段的**定时句**是常量、而句柄长度由行号位数决定（
 * `handle-core.handleCharsFor`：15 + 两个行号的位数，本仓任何上千行的文件都是 21）。
 * 所以 `定时句 + 三个最长句柄` 恒 < 220，这个数只用来在病态输入下把整段**剪掉**
 * （剪掉时正文照旧给 `next` 那句重读指令，不会变成一句空话），不让它把
 * {@link NOTFOUND_RECEIPT_CHARS} 顶穿。
 */
const NOTFOUND_RECOVERY_CHARS = 220
/** 单行原文在回执里的上限（剪了就写明剪了多少字符）。 */
const NOTFOUND_LINE_CHARS = 200
/** 那一带原文**合计**的上限（超出就少展示几行，并写明剪了几行 / 几字符）。 */
const NOTFOUND_BAND_CHARS = 1600
/**
 * 对齐打分的**工作量上限**（逐行比较的总次数）。
 *
 * 为什么需要它：代价是 Σ(引文每一行在文件里的出现次数)，而重复行极多的文件（生成出来的数据表
 * 就是这种）配上一份同样长的引文，这个乘积能到 10^8 量级——一次**拒绝**会变成好几秒的停顿。
 * 诊断路径不能这样：它只是把"找不到"说清楚，不是定位判据本身。
 *
 * 到顶后不再收新的起点，取的是"已经收到的那些里最优"——仍然**确定**（同一份输入同一结果），
 * 只是不再保证全局最优。正常文件远到不了这个量级：本仓最大的源文件也只有几万行，
 * 而要计数还得引文的每一行**真在文件里出现过**。
 */
const NOTFOUND_ALIGN_WORK = 2000000
/** 打分阶段最多看几个对齐起点（起点表也按它封顶）。 */
const NOTFOUND_ALIGN_CAP = 2000

/**
 * 引文的**匹配基准**，由严到松（与 {@link ADDRESS_TIERS} 同一把尺子：逐字 → 行内空白折叠）。
 *
 * 再往下就没有第三档：相似度会给出一个说不清理由的落点，而这份回执的全部价值在于
 * 它说的每一句都能被调用方**逐字核对**。所以这里只回答"有多少行逐字对得上、从哪一行开始对不上"，
 * 不回答"有多像"——后者是定位判据的事，而判据仍然是 {@link findWindowTier} / {@link findFragmentTier}，
 * 本函数一个字节都不改它们的结论。
 */
const NOTFOUND_ALIGN_BASES = [
  { basis: 'exact', norm: (text) => text, how: 'byte-for-byte' },
  { basis: 'norm-space', norm: normSpace, how: 'once whitespace is folded' },
]

/** 钉住的两句：`old-fragment-fallback-test` 段E1 逐字钉着它们，不许改写。 */
function notFoundPinned(label) {
  return (
    `the old text you gave is not in ${label} — not as whole lines, and not inside any line either. ` +
    `Coordinates are only a hint, so there is nothing to address — re-read the file and pass the text exactly as it is there.`
  )
}

/** 钉住那两句里**与 label 无关**的那部分长度（预算就是从这里减出来的）。 */
const NOTFOUND_PINNED_CHARS = notFoundPinned('').length

/**
 * 回执头部：钉住的两句 + 指代这份文件的那句话。
 *
 * `label` 也按预算夹（夹子本体是 {@link clipReceiptLabel}，与 `old` 歧义那一支**共用一份**）。
 * 它通常是一个路径（几十字符），但它的长度**不由本工具决定**，
 * 而它一旦病态地长，挤掉的正好是后面那段原文。夹过就在原地写明夹了多少字符。
 */
function notFoundHead(label) {
  const room = Math.max(40, NOTFOUND_RECEIPT_CHARS - NOTFOUND_DETAIL_FLOOR - NOTFOUND_PINNED_CHARS)
  return notFoundPinned(clipReceiptLabel(label, room))
}

/**
 * 回执里一行原文的截断 —— 剪掉的必须**自己说出来**，而且要一并说清“这一行不可回抄”。
 *
 * 为什么“不可回抄”这四个字是这段代码的一部分：{@link notFoundDetail} 的身份声明
 * （`bandIdentity`）宣称这些行是“这份文件自己的文本、逐字节”，而**裁剪过的行不是** ——
 * 它只是那一行的前 {@link NOTFOUND_LINE_CHARS} 个字符。少了这个标记，身份句在长行上就是
 * 一句**假话**：实测行宽 600 时回执给 217 字符、文件那一行 615 字符；行宽 200 时 216 对 215
 * —— 两处都说“逐字节”，而两处都不是。调用方按“verbatim / byte-for-byte”抄回去必然失配，
 * 而它正是照着回执自己的话抄的。
 *
 * 标记与身份句是**一对**：身份句里那句例外条款点名 `NOT copyable`，这里负责把它贴上。
 * 两处任缺一处，`quote-render-test` 段B 的长行判据当场红。
 */
function clipReceiptLine(text) {
  if (text.length <= NOTFOUND_LINE_CHARS) return text
  return (
    `${text.slice(0, NOTFOUND_LINE_CHARS)}\u2026(${text.length - NOTFOUND_LINE_CHARS} more chars) ` +
    `[clipped \u2014 NOT copyable]`
  )
}

/**
 * 失败回执里的**可修复地址**（MT6）：把区间句柄铸给"回执刚刚展示的那一段"。
 *
 * ## 三样东西各取自什么（缺一样就会铸出一个对不上的柄）
 *
 *   · **身份标签**（`h` 后 4 位）：取**这一次编辑**算出的 `ledgerKey` ——
 *     `planHunks` 里那份 `handleCtx.ledgerKey = ledgerIdentityKey(filePath, identityKey)`，
 *     与读侧发句柄时是**同一个口径、同一条实现**（`read-core.mjs` 也走 `ledgerIdentityKey`）。
 *     不从回执文本里反推路径：回执里的 `label` 是被 `clipReceiptLabel` 夹过的**说法**，
 *     不是键——拿它算标签会铸出一个"身份不符"的柄，而调用方拿到的是一句 `PATCH_HANDLE_IDENTITY_MISMATCH`。
 *   · **区间摘要**（`h` 后 8 位）：取**文件里那几行的原始字节**（`lines.slice(a-1, b).join('\n')`，
 *     行尾不入摘要、不裁行、不加行号前缀）。它逐字节来自**磁盘上读到的内容**，
 *     不是模型转述的引文，也不是回执里那份被 `clipReceiptLine` 剪过的展示文本。
 *   · **行号**（`:` 后那对）：取该段在**文件里的绝对行号**（1-based、含两端），与
 *     `aura_basetools_read` 印的行号是同一把尺子——所以回执里 `!N| ` 的那些 N 与句柄里的数字对得上。
 *
 * 铸出来的柄因此**自描述**：写路径 `resolveHandleRegion` 拿当前文件那几行现算一遍摘要就能核对，
 * 不需要任何句柄表（`handle-core.mjs` 顶部那三条形状约束里的第 3 条）。
 *
 * 取不到就返回 `null`（而不是抛错、也不是铸一个"看着像"的柄）：每次调用都具备这三个事实，
 * 但 `planHunks` 有一个三参数调用点（{@link regionTextIn} 的内部预演）**不给** `options`，
 * 那里没有账本键 ⇒ 无柄可铸。回执照旧，只是少一行修法。
 *
 * @param ctx - `planHunks` 的 `handleCtx`（`{content, ledgerKey, byteOrderMark, label}`）
 * @param startLine - 该段在文件里的起始行（1-based）
 * @param endLine - 该段在文件里的结束行（1-based，含）
 * @returns 句柄字符串，或 `null`
 */
function mintRegionHandle(ctx, startLine, endLine) {
  if (ctx === null || ctx === undefined) return null
  if (typeof ctx.ledgerKey !== 'string') return null
  const rows = regionRowsAt(ctx.content.split('\n'), startLine, endLine)
  if (rows === null) return null
  return mintHandle({
    ledgerKey: ctx.ledgerKey,
    regionText: rows.join('\n'),
    byteOrderMark: ctx.byteOrderMark === true,
    startLine,
    endLine,
  })
}

/** 回执里"抄这个地址"那一行的字面形状。**模型只看得见这一行**，所以它必须自带 `retry:` 标签。 */
const RETRY_LABEL = 'retry: '

/**
 * 一段能直接照抄的重试参数：`retry: {"handle":"h…"}`。
 *
 * 为什么写成**纯参数对象**而不是一句自然语言：调用方下一轮是发一次工具调用，
 * 而工具调用的入参就是一个对象。给它一句散文，它得先翻译成参数——那一步正是本单要省掉的。
 * 形状与契约 §3 的句柄示例逐字同形（`h9f3ac1b2e4d5:42-42`），便于判据与解析器共用一条正则。
 */
const retryLine = (handle) => `${RETRY_LABEL}${JSON.stringify({ handle })}`

/**
 * 回执末尾那段**修法**（`next` 之外的可照抄地址）。
 *
 * 单目标：给**最近那一带**的柄与一句说明——"把 `replace` 配上这个地址再发一次，不必重抄原文"。
 * 多候选：给**每个候选**各一行 `retry:`（让它从"挑一个"变成"抄一个"）。
 *
 * 这段**只描述怎么修**，一个字都不改判定：失败仍是失败、磁盘仍是一个字节不动、码与 `next` 都不变。
 * 体量封在 {@link NOTFOUND_RECOVERY_CHARS}；越限就整段不印（`next` 仍给重读指令），不静默截半句。
 *
 * @param handles - 已铸好的句柄（按回执里出现的顺序）
 * @param lines - 每行前面的说明（与 `handles` 等长）；单目标那一支用同一句
 */
function repairBlock(handles, lines) {
  if (handles.length === 0) return ''
  const body = handles.map((handle, i) => `${lines[i] ?? ''}${retryLine(handle)}`).join('\n')
  return body.length > NOTFOUND_RECOVERY_CHARS ? '' : `${body}\n`
}

/**
 * 单目标"找不到"的修法那一行：一句人话 + 地址。
 *
 * 措辞刻意**不用** `candidates` / `ambiguous` / `not unique` 这几个词：`failure-replay` 与
 * `residual-census` 的三态归类按这些词认，`PATCH_NOT_FOUND` 的回执里出现它们会被记成
 * `needs_choice`（{@link notFoundDetail} 的 `bandIdentity` 同一条理由）。
 */
const NOTFOUND_REPAIR_NOTE = `paste this address with your own \`replace\` and send it again — no need to re-quote the text: `

/**
 * 引文逐行在文件里的**对齐起点**：把「引文第 j 行 = 文件第 i 行」读成「整块从 `i-j` 开始」。
 *
 * 为什么用行号代数和而不是滑窗相似度：这里要回答的是"你引的那块**本该**落在哪一带"，
 * 判据只有一条——有多少行**逐字**对得上。相似度给出的是一个说不清理由的分数，
 * 而这个回执的全部价值在于它说的每一句都能被调用方逐字核对。
 *
 * 先按"每一行出现在哪些行号"建索引再代数和，是为了不落进 O(引文行数 × 文件行数)：
 * 只在**引文里真出现过**的那些行上花时间。重复行极多时这个"只在真出现过的行上花时间"
 * 本身也会炸开（每一行都出现几万次），所以再有 {@link NOTFOUND_ALIGN_CAP} 与
 * {@link NOTFOUND_ALIGN_WORK} 两道封顶——到顶就带着已收到的起点返回，不再继续收。
 */
function alignmentStarts(normLines, normRows) {
  const index = new Map()
  for (let i = 0; i < normLines.length; i += 1) {
    const key = normLines[i]
    if (key.length === 0) continue
    const hit = index.get(key)
    if (hit === undefined) index.set(key, [i])
    else hit.push(i)
  }
  const byStart = new Map()
  let work = NOTFOUND_ALIGN_WORK
  for (let j = 0; j < normRows.length; j += 1) {
    const hits = normRows[j].length === 0 ? undefined : index.get(normRows[j])
    if (hits === undefined) continue
    for (const i of hits) {
      if (work <= 0 || byStart.size >= NOTFOUND_ALIGN_CAP) return byStart
      work -= 1
      const start = i - j
      const rec = byStart.get(start)
      if (rec === undefined) byStart.set(start, { start, hits: 1 })
      else rec.hits += 1
    }
  }
  return byStart
}

/**
 * 某个对齐起点上**逐字对上**的引文行号（升序）。
 *
 * 比对**整行**而不是"行里含有"：引文的一行与文件的一行要么逐字是同一条，要么不是。
 * 空行只与空行对得上——否则空行会与文件里任何一行"对上"，把计数和连续段一起撑虚。
 */
function rowsMatchedAt(normLines, normRows, start) {
  const rows = []
  for (let j = 0; j < normRows.length; j += 1) {
    const i = start + j
    if (i < 0 || i >= normLines.length) continue
    if (normLines[i] === normRows[j]) rows.push(j)
  }
  return rows
}

/** 两段连续区间里更长的那个（`len` 为 0 表示一个都没有）。 */
function longerRun(best, from, to) {
  const len = to - from + 1
  return best === null || len > best.len ? { from, to, len } : best
}

/** 一串**升序**行号里最长的那段连续区间。 */
function longestMatchedRun(rows) {
  let best = null
  let from = null
  let prev = null
  for (const row of rows) {
    if (prev !== null && row === prev + 1) {
      prev = row
      continue
    }
    if (from !== null) best = longerRun(best, from, prev)
    from = row
    prev = row
  }
  if (from !== null) best = longerRun(best, from, prev)
  return best ?? { from: 0, to: -1, len: 0 }
}

/**
 * 引文落在文件里的**最佳对齐**：逐字对上的行最多者胜；并列看最长连续段；仍并列就取离调用方
 * 给的坐标 / `near` 最近的那个（再并列取行号小的）。
 *
 * 每一步都是可复述的规则，**不掷骰子**（同 `anchor-core` 的 `pickNear` 那条口径）：
 * 这份回执要说"最接近的那一带是哪一带"，而"等距时随便挑一个"会让同一份输入给出两种说法。
 */
function bestAlignment(lines, oldRows, norm, hint) {
  /**
   * 归一化**只算一遍**：两层基准下 `normSpace` 不便宜，而这个函数要把它用到
   * “文件一次 + 引文一次 + 每个候选各一遍”上，就地重算会把两百万次预算白白花在重复劳动上。
   */
  const normLines = lines.map(norm)
  const normRows = oldRows.map(norm)
  const starts = [...alignmentStarts(normLines, normRows).values()]
  if (starts.length === 0) return null
  starts.sort((a, b) => b.hits - a.hits || a.start - b.start)
  let best = null
  let work = NOTFOUND_ALIGN_WORK
  for (const { start } of starts) {
    if (work < normRows.length) break
    work -= normRows.length
    const rows = rowsMatchedAt(normLines, normRows, start)
    if (rows.length === 0) continue
    const run = longestMatchedRun(rows)
    const distance = hint === null ? 0 : Math.abs(start + 1 - hint)
    const better =
      best === null ||
      rows.length > best.rows.length ||
      (rows.length === best.rows.length && run.len > best.run.len) ||
      (rows.length === best.rows.length && run.len === best.run.len && distance < best.distance) ||
      (rows.length === best.rows.length && run.len === best.run.len && distance === best.distance && start < best.start)
    if (better) best = { start, rows, run, distance }
  }
  return best
}

/** 调用方给的坐标提示（`lines` / `start_line` / `near`）里的**起始行**；一个都没给就是 null。 */
function hintLineOf(hunk) {
  if (hunk === null || hunk === undefined) return null
  const range = lineRangeOf(hunk)
  if (range !== undefined) return range.start
  return Number.isInteger(hunk.near) ? hunk.near : null
}

/**
 * 把一次对齐翻成回执要的那一带：**行号 + 该处原文的位置信息**。
 *
 * 区间按引文的行数铺开（`对齐起点 .. 对齐起点 + 引文行数 − 1`），再夹到文件范围内——
 * 引文比文件长时（整块伸到文件外）只有落在文件里的那一截是真的，夹掉的部分**没有原文可贴**，
 * 所以 `matched` / `run` 只统计仍在文件内的那些行（不把不存在的那几行算成"对不上"）。
 */
function regionOf(lines, oldRows, aligned, basis, how) {
  const startLine = Math.max(1, aligned.start + 1)
  const endLine = Math.min(lines.length, aligned.start + oldRows.length)
  const inFile = aligned.rows.filter((j) => {
    const n = aligned.start + j + 1
    return n >= startLine && n <= endLine
  })
  const run = longestMatchedRun(inFile)
  const hit = new Set(inFile)
  let mismatch = null
  for (let j = 0; j < oldRows.length; j += 1) {
    const i = aligned.start + j
    if (i < 0 || i >= lines.length || hit.has(j)) continue
    mismatch = { quoteLine: j + 1, fileLine: i + 1, wrote: oldRows[j], there: lines[i] }
    break
  }
  return {
    basis,
    how,
    startLine,
    endLine,
    fileLines: lines.length,
    quoteLines: oldRows.length,
    matched: inFile.length,
    matchedLines: inFile.map((j) => aligned.start + j + 1),
    run: {
      len: run.len,
      quoteFrom: run.from + 1,
      quoteTo: run.to + 1,
      fileFrom: aligned.start + run.from + 1,
      fileTo: aligned.start + run.to + 1,
    },
    mismatch,
  }
}

/** 一处**没有对齐**的区间（坐标带 / 文件头）：只有行号与原文，没有命中数。 */
function bareRegion(lines, startLine, endLine, basis, how) {
  return {
    basis,
    how,
    startLine,
    endLine,
    fileLines: lines.length,
    quoteLines: null,
    matched: 0,
    matchedLines: [],
    run: { len: 0, quoteFrom: 1, quoteTo: 0, fileFrom: startLine, fileTo: endLine },
    mismatch: null,
  }
}

/**
 * 「找不到」时那一带的取法，由强到弱（每一步都写明这一步是哪一种，不含糊）：
 *   1. **逐字**对齐（{@link NOTFOUND_ALIGN_BASES} 第一档）——最好的一档：行号能直接照着用；
 *   2. **空白折叠后**对齐——次好，且回执明说这个前提；
 *   3. 一个逐字行都没有，但调用方给了坐标 / `near` ⇒ 把它指的**那一带**的真原文贴出来
 *      （它以为那儿有东西，而那儿实际是什么，正是它要看的）；
 *   4. 什么都没有 ⇒ 贴文件头，并明说"这不是命中"。
 *
 * 第 3、4 档都**不假装**是候选：`basis` 与说明句都写着"没有一行对上"。宁可说清"这不是匹配"，
 * 也不能让调用方把一段无关的原文当成落点——那是本工具要消灭的静默错配。
 */
function notFoundDetail(lines, oldRows, hunk, budget, ctx = null) {
  const hint = hintLineOf(hunk)
  let region = null
  for (const { basis, norm, how } of NOTFOUND_ALIGN_BASES) {
    const aligned = bestAlignment(lines, oldRows, norm, hint)
    if (aligned === null) continue
    region = regionOf(lines, oldRows, aligned, basis, how)
    break
  }
  if (region === null) {
    /**
     * 第 3 档用**调用方自己写的那个区间**铺开（它以为东西在那儿），比按引文行数铺更贴它的意图；
     * 第 4 档没有区间可用，才退回引文行数。两档都夹在 {@link NOTFOUND_BAND_LINES} 里。
     */
    const declared = hint === null ? undefined : lineRangeOf(hunk)
    const span = Math.max(
      1,
      Math.min(declared === undefined ? oldRows.length : declared.end - declared.start + 1, NOTFOUND_BAND_LINES),
    )
    const start = hint === null ? 1 : Math.min(Math.max(hint, 1), lines.length)
    const end = Math.min(lines.length, start + span - 1)
    region =
      hint === null
        ? bareRegion(
            lines,
            1,
            end,
            'head',
            'not one line of your old text is anywhere in this file; what follows is the head of the file — it is not a match',
          )
        : bareRegion(
            lines,
            start,
            end,
            'hint',
            'not one line of your old text is anywhere in this file; this is where your coordinates point — it is not a match',
          )
  }

  const matchNote =
    region.quoteLines === null
      ? region.how
      : `${region.matched} of your ${region.quoteLines} line(s) match a line in that region ${
          region.basis === 'exact' ? 'byte-for-byte' : 'once whitespace is folded'
        }`
  const runNote =
    region.run.len > 1
      ? `; longest unbroken run: your lines ${region.run.quoteFrom}-${region.run.quoteTo} = file lines ${region.run.fileFrom}-${region.run.fileTo}`
      : region.run.len === 1
        ? `; only your line ${region.run.quoteFrom} = file line ${region.run.fileFrom} stands alone`
        : ''
  const diffNote =
    region.mismatch === null
      ? ''
      : `; first difference: your line ${region.mismatch.quoteLine} is ${quoteForMessage(region.mismatch.wrote)} but file line ${region.mismatch.fileLine} is ${quoteForMessage(region.mismatch.there, region.mismatch.fileLine)}`
  /**
   * 原文那一层的**身份声明**（C38 ③）：回执贴了原文，就必须说清"哪些字节是文件内容"。
   * 行号前缀与 `=` / `!` 标记都是回执加的**边距**，不是文件的一部分 —— 不写明，
   * 调用方整块抄走必然失配（`probes/quote-hygiene.mjs` 把"行首 `数字: `"单列为一类引文污染）。
   *
   * 措辞避开 `candidates` / `occurrence` / `not unique` / `ambiguous`：这几个词是
   * `failure-replay` 与 `residual-census` 三态归类用的触发词，出现在这条回执里会把"找不到"
   * 记成 `needs_choice`（`notfound-receipt-test` 段E5/E6 钉着它）。本句一个都不含。
   *
   * 它进 `fixed` 而不是进 `hold`：下一段那段 `room` 是由 `budget - fixed.length - NOTFOUND_NOTE_CHARS`
   * 反推的，声明句写进 `fixed` 才被同一笔账算进去，`fixed + hold ≤ budget` 这条等式才仍然成立。
   */
  /**
   * 收尾那句必须与 {@link quoteForMessage} 的身份句**同形**（都以 `not part of the file:` 收尾）：
   * 调用方与判据据同一句话定位"块从哪里开始、边距到哪为止"，两处写法不同就等于两套规矩。
   */
  const bandIdentity =
    `The lines below are this file's own text, byte-for-byte \u2014 unless a line ends in ` +
    `\`NOT copyable\`, which means the receipt clipped that one to stay inside its budget and only ` +
    `its beginning is shown. Two marks in front of each one are the receipt's own margin, not ` +
    `part of the file: the \`=\` / \`!\` says whether your old text has that line, and the \`N| \` ` +
    `after it is a line number (the same numbering aura_basetools_read prints).\n`
  const fixed =
    `Closest region: lines ${region.startLine}-${region.endLine} of ${region.fileLines} — ${matchNote}${runNote}${diffNote}.\n` +
    bandIdentity

  /**
   * 原文那一层：先按"还剩多少额度"算上限，再逐行填进去；填不下就停，并把**没展示的**
   * 行数与字符数一起写出来。`room` 由 `budget` 反推，所以 `fixed + hold` 合计恒 ≤ `budget`。
   */
  const matchedLines = new Set(region.matchedLines)
  const legend =
    region.matched > 0 ? ' ("=" marks a line your old text has byte-for-byte, "!" one it does not)' : ''
  const room = Math.min(NOTFOUND_BAND_CHARS, Math.max(0, budget - fixed.length - NOTFOUND_NOTE_CHARS))
  const entries = []
  let used = 0
  let hiddenLines = 0
  let hiddenChars = 0
  for (let n = region.startLine; n <= region.endLine; n += 1) {
    const entry = `${matchedLines.has(n) ? '=' : '!'}${n}| ${clipReceiptLine(lines[n - 1])}`
    if (entries.length >= NOTFOUND_BAND_LINES || used + entry.length + 1 > room) {
      for (let k = n; k <= region.endLine; k += 1) {
        hiddenLines += 1
        hiddenChars += lines[k - 1].length + 1
      }
      break
    }
    entries.push(entry)
    used += entry.length + 1
  }
  const bandTotal = region.endLine - region.startLine + 1
  const hold =
    entries.length === 0
      ? `The text of those line(s) is not shown: the receipt budget left no room (${bandTotal} line(s), ${hiddenChars} char(s) omitted).`
      : `What those line(s) actually hold${legend}:\n${entries.join('\n')}\n(${entries.length} of ${bandTotal} line(s) in this region shown${
          hiddenLines === 0
            ? ''
            : `; ${hiddenLines} more line(s) / ${hiddenChars} char(s) cut to stay inside this receipt's budget`
        })`

  /**
   * 修法那一行（MT6）：柄铸在**回执刚刚展示的那一段**上——`region.startLine`–`region.endLine`，
   * 就是 `Closest region:` 那句与 `!N| ` 那些行号所指的同一段。
   *
   * 铸的是**整段**而不是"逐字命中的那段连续行"（`region.run`）：回执明确写给它看的就是这一段，
   * 给一个比它看到的更窄的区间，等于让它在没看见的字节上落笔；而 `{handle, replace}` 的语义正是
   * "整段替换"。展示被预算剪过（`entries.length < bandTotal`）也照铸：摘要取自**文件字节**，
   * 与回执展示了几行无关（回执自己已声明剪了多少行）。
   */
  const nearestHandle = mintRegionHandle(ctx, region.startLine, region.endLine)
  const repair = nearestHandle === null ? '' : repairBlock([nearestHandle], [`${NOTFOUND_REPAIR_NOTE}\n`])
  return {
    text: `${fixed}${hold}\n${repair}`,
    nearest: {
      ...(nearestHandle === null ? {} : { retry: { handle: nearestHandle } }),
      line: region.startLine,
      endLine: region.endLine,
      fileLines: region.fileLines,
      basis: region.basis,
      ...(region.quoteLines === null ? {} : { quoteLines: region.quoteLines, matched: region.matched }),
      ...(region.run.len === 0
        ? {}
        : {
            run: {
              quoteLines: [region.run.quoteFrom, region.run.quoteTo],
              fileLines: [region.run.fileFrom, region.run.fileTo],
            },
          }),
    },
    next:
      region.run.len > 0
        ? `pass lines ${region.run.fileFrom}-${region.run.fileTo} exactly as they are on disk as \`old\` (your line(s) ${region.run.quoteFrom}-${region.run.quoteTo} are byte-for-byte those), then re-send the hunk`
        : region.basis === 'hint'
          ? `re-read lines ${region.startLine}-${region.endLine} (aura_basetools_read), then pass the text exactly as it is there`
          : 're-read the file (aura_basetools_read) and pass the text exactly as it is there — no line of your old text is in this file',
  }
}

/**
 * `old` 在文件里找不到时的拒绝 —— 带回**最近的那一带真实原文**与**可执行的下一步**。
 *
 * 这是**负向不变量**：坐标再合理也救不了它——坐标已经降为提示，能决定位置的只有原文。
 * 走到这里说明两条路都走完了（整行对齐 {@link findWindowTier} 与行内片段 {@link findFragmentTier}），
 * 所以这句话是字面意义的：**这段文字在文件里没有出现**，连行内片段都不是。
 *
 * 这里曾经附一句“第 N 行包含它，把那一行原样贴过来”——片段层落地后那句提示不再有可达的情形
 * （整行包含它 ⇒ 片段层必然命中），留着只会给出一条自相矛盾的指令（“片段不被接受”）。
 *
 * ## 为什么还要贴原文（本轮新增）
 *
 * 只回一句 `not in`，调用方拿不到任何可用于修正的信息：它既不知道**差在哪**（是这几行对不上，
 * 还是整块都不在这份文件里），也不知道该往哪儿改。实测（`residual-census` 重放语料）：
 * 新契约下仍失败的 147 条（C33 读数 174；入口换成编排层 `applyEditToProvider` 之后 27 条归
 * `already_applied`，见 `probes/already-applied-census.mjs`）里两次尝试的候选数都是 0、message 只有
 * 这一句，每条只能靠一次重读自救；其中 64 条的引文**有一部分连续行逐字就在原文里**（C33 那 174 条
 * 里同一读数是 71 = 64 + 转出的 7 条，见 `residual-census` 的机制分布 B04×7；最接近的 F0059 是
 * 22/32 行、F0447 是 16/20 行），
 * 那是可定位的一层，却没有任何东西把它交出去。所以拒绝照样拒绝，但回执要给出：
 *   · 最接近的那一带的**行号 + 该处原文**（`=` / `!` 标出哪几行对得上）；
 *   · **从哪一行开始对不上**（引文那一行与文件那一行各贴一份，都可逐字核对）；
 *   · 一个**下次可以直接用的地址**（`next`）：从最长的那段连续逐字命中里取行区间
 *     （DSH 壳会把它放进结果的 `next` 字段，见 `aura-edit/index.js` 的 `intentVerdict`）。
 *
 * ## 三条不许破
 *
 *   · **拒绝照旧**：码仍是 `PATCH_NOT_FOUND`（壳层判决表把它收进 `not_found`），磁盘一个字节不动；
 *   · **不当候选卖**：结构化字段叫 `nearest` 而**不叫** `candidates`——`intentVerdict` 见到
 *     `candidates.length > 1` 就把结果翻成 `needs_choice`（`aura-edit/index.js:387`），
 *     而"这段文字不在文件里"不是"有多个落点让你挑"。message 里也刻意不用 candidates / ambiguous
 *     这些词：`failure-replay` 与 `residual-census` 的三态归类按这些词认，给找不到的回执配上
 *     "候选"的措辞，等于让测量面把它记成 `needs_choice`——那是把"找不到"换个名字说成"有得选"；
 *   · **体量不顶穿宿主阈值**：见 {@link NOTFOUND_RECEIPT_CHARS}，且剪了多少一律明写。
 *
 * `expectVerdict` 仍是 `expect` 的唯一判据——本函数只**描述** `old` 的落点，不判任何东西。
 */
function oldNotFoundError(label, lines = null, oldRows = null, hunk = null, ctx = null) {
  const head = notFoundHead(label)
  const detail =
    lines === null || oldRows === null || oldRows.length === 0
      ? { text: '', nearest: undefined, next: undefined }
      : notFoundDetail(lines, oldRows, hunk, NOTFOUND_RECEIPT_CHARS - head.length, ctx)
  return new PatchError(detail.text === '' ? head : `${head} ${detail.text}`, 'PATCH_NOT_FOUND', {
    ...(detail.nearest === undefined ? {} : { nearest: detail.nearest }),
    ...(detail.next === undefined ? {} : { next: detail.next }),
  })
}

/**
 * 收敛不到一个候选时的拒绝：候选清单（行号 + 各候选原文）必须写进 **message**。
 *
 * 为什么写进 message 而不只挂在 `candidates` 字段上：DSH 框架对抛出的错误只取 `error.message`
 * （`dsh-tools/lib/index.js` 的 `errorMessage`），其余字段一律不读（`locator-api.failure` 同）。
 */
/**
 * 收敛不到一个候选时的拒绝：候选清单（行号 + 各候选原文）必须写进 **message**。
 *
 * 候选一律是 `{start, span}`（0-based）：整行对齐那一层的 span 恒为 `old` 的行数，片段层每个候选的
 * span 由“片段落在哪些行里”决定、可以互不相同——两层共用这一份收据，不各写一套候选形状。
 *
 * 为什么写进 message 而不只挂在 `candidates` 字段上：DSH 框架对抛出的错误只取 `error.message`
 * （`dsh-tools/lib/index.js` 的 `errorMessage`），其余字段一律不读（`locator-api.failure` 同）。
 */
/**
 * 收敛不到一个候选时的拒绝：候选清单（行号 + 各候选原文）必须写进 **message**。
 *
 * 候选形状：整行对齐那一层是 `{start, span}`（span 恒为 `old` 的行数）；片段层多带 `startCol` /
 * `endCol` / `text`——片段层替换的**就是那一处跨度**，候选若只说“第 3 行”，调用方拿到的位置比它
 * 实际要改的范围宽，照着候选重发一次又会落回同一个歧义里。
 *
 * 为什么写进 message 而不只挂在 `candidates` 字段上：DSH 框架对抛出的错误只取 `error.message`
 * （`dsh-tools/lib/index.js` 的 `errorMessage`），其余字段一律不读（`locator-api.failure` 同）。
 */
function oldAmbiguityError(lines, candidates, label, total, ctx = null) {
  const rows = candidates.map((c) => ({
    line: c.start + 1,
    endLine: c.start + c.span,
    text: c.text ?? lines.slice(c.start, c.start + c.span).join('\n'),
    ...(c.startCol === undefined ? {} : { startCol: c.startCol, endCol: c.endCol }),
  }))
  const { listing, hidden } = candidateListing(rows, lines, ctx)
  /** 清单多行时它自带收尾换行，那句收尾建议就不能再顶一个 `.` 上去。 */
  const gap = listing.endsWith('\n') ? '' : '. '
  const omitted = hidden === 0 ? '' : ` (+${hidden} more, not shown: this receipt's output budget)`
  const narrowed = total > rows.length ? ` (of ${total}; \`context\` narrowed it to these)` : ''
  /**
   * 预算的**分法**（C41 缺口三）：候选清单先算（它是这条回执的正文，也正是调用方要挑的东西），
   * 剩下的才给 `label`。反过来分——先给 label 一整份、再让清单去挤——量出来就是
   * {@link AMBIGUITY_RECEIPT_CHARS} 注释里那几个数：22479 / 8277 / 8479。
   * `label` 被夹时夹口就在原地写明夹了多少字符，文件名是什么仍然看得见。
   */
  const head = `the old text matches ${rows.length} place(s) in `
  const tail =
    `${narrowed} — cannot tell which one you meant; candidates: ${listing}${omitted}${gap}` +
    `Add the surrounding lines as \`context\` (or make \`old\` unique) — nothing was written` +
    /**
     * 挑一个的**机械做法**（MT6）：候选上面已经各自带了一行 `retry:`，这里只说清"把它抄下来即可"。
     * 措辞不碰判定：不说"更准"、不说"找到多个"以外的任何新结论。
     */
    (listing.includes(RETRY_LABEL)
      ? ' — or paste one handle from a `retry:` line above with your own `replace`: each one already names exactly one of these lines, so nothing has to be re-quoted'
      : '')
  const room = Math.max(40, AMBIGUITY_RECEIPT_CHARS - head.length - tail.length)
  return new PatchError(
    `${head}${clipReceiptLabel(label, room)}${tail}`,
    'PATCH_AMBIGUOUS',
    { candidates: rows },
  )
}

/**
 * 候选清单的**合计**字符预算（与 `locator-api` 的 `CANDIDATE_LIST_CHARS` 同值、同一条理由）。
 *
 * 条数封不住体量：C38 给每条引文配了**忠实块**（真换行 + 行号前缀，单条可到 ~1200 字符），
 * 20 条就是两万四，而宿主 `toolResultPruner.thresholdChars` 是 8192 —— 超了中间会被静默剪掉，
 * 候选恰恰在中间。到顶就停，并把没展示的条数写在原地。
 */
const CANDIDATE_LIST_CHARS = 2400

/**
 * 一条失败回执里最多为**几个候选**铸柄（MT6 的条数上限）。
 *
 * 为什么是 5 而不是候选上限 20：柄本身只有 21 字符，但它每一条都占一整行，
 * 而回执体量是宿主剪枝器（`thresholdChars: 8192`）量的东西。5 条正好把"歧义里最常见的
 * 2~4 处"全覆盖，再多的候选本来也只能靠调用方**看一眼原文**去认——那件事回执已经在做。
 * 超限不静默：候选照旧逐条报行号与原文（今天的形状），只是不带 `retry:` 行。
 */
const HANDLE_CANDIDATE_LIMIT = 5

/**
 * `old` 歧义回执的**体量预算**（`label` 与正文**合计**，不是各算一份）。
 *
 * 与 {@link NOTFOUND_RECEIPT_CHARS} 同值、同一条依据：6000 < 8192（宿主阈值），
 * 也 < 4096 + 1024 + 标记长度 —— 连“只留头窗”那种剪法也装得下。
 *
 * 为什么这一支也需要一个数：这条回执里的 `label` 是**调用方给的原文**（通常是个路径），
 * 长度不由本工具决定，而它与候选清单写在同一条消息里。实测（C41，20 条候选 × 每条 2 行）：
 * label 两万字符时这条回执 22479 字符，是宿主阈值的 2.7 倍；label 5802 时 8277、6004 时 8479
 * —— 两处都越过了 8192。而在 C38 给每条候选配上忠实块之前，同一夹具的同一长度是 6923（合规）：
 * **净增量 1354 字符把一段原本合规的 label 区间顶过了线**（上一波独立验收在它自己的夹具上
 * 量到的是 7223 → 8193，拐点落在同一段长度上）。
 * 所以这里不是“留点余量”，而是先把清单算出来，剩下的才给 `label`
 * （分法见 {@link oldAmbiguityError}，夹子本体是 `locator-api` 的 `clipReceiptLabel`）。
 */
const AMBIGUITY_RECEIPT_CHARS = 6000

/**
 * 候选清单的渲染：`line N[-M] = <引文>` 用 `, ` 连成一行，合计体量封在 {@link CANDIDATE_LIST_CHARS}。
 *
 * 引文本身走 {@link quoteForMessage}（与 `the content there is:` 那处**同一份渲染**）：
 * 候选也是"引用原文给调用方看"，在这里另写一套等于同一件事又有了两份判定。
 *
 * @param rows - `{line, endLine, text, startCol?, endCol?}` 形状的行
 * @returns `{listing, hidden}`：`listing` 是拼好的清单，`hidden` 是因预算没展示的条数
 */
function candidateListing(rows, lines = null, ctx = null) {
  const parts = []
  let spent = 0
  /** 已发出去的候选柄数（封在 {@link HANDLE_CANDIDATE_LIMIT}；超出的候选只报行号，照今天的方式）。 */
  let handles = 0
  for (const row of rows) {
    const place =
      row.startCol === undefined
        ? `line ${row.line}${row.endLine === row.line ? '' : `-${row.endLine}`}`
        : `line ${row.line} columns ${row.startCol}-${row.endCol}`
    /**
     * 每个候选各铸一个柄（MT6）：候选的 `line`–`endLine` 是**文件里的绝对行号**，
     * 拿它去 `lines` 取那段原始字节铸柄——铸法与 {@link mintRegionHandle} 同一处，
     * 所以身份标签/摘要/行号三样与"最近那一带"那一支口径完全一致。
     *
     * 上限是**条数**（{@link HANDLE_CANDIDATE_LIMIT}）：候选最多 20 条，每条一个 21 字符的柄
     * 叠上散文就有几百字符，而回执体量是宿主剪枝器量的东西。超限的候选照旧只报行号。
     */
    const handle =
      handles < HANDLE_CANDIDATE_LIMIT && lines !== null ? mintRegionHandle(ctx, row.line, row.endLine) : null
    const entry =
      `${place} = ${quoteForMessage(row.text, row.line)}` + (handle === null ? '' : `\n${retryLine(handle)}`)
    // 第一条无论多长都要放：一条候选都不印的清单等于没给，"有候选"当场变成一句空话。
    if (parts.length > 0 && spent + entry.length > CANDIDATE_LIST_CHARS) break
    parts.push(entry)
    spent += entry.length
    if (handle !== null) handles += 1
  }
  /**
   * 分隔符看内容：全是单行就给一行 `, ` 连到底（与改前逐字相同），
   * 只要有一条自带忠实块（真换行），就**一条一行** —— 否则上一条的原文块会把下一条的
   * `line N = ` 前缀吞进自己的最后一行，回抄时两条候选粘成一段。
   */
  const sep = parts.some((p) => p.includes('\n')) ? '' : ', '
  return { listing: parts.join(sep), hidden: rows.length - parts.length }
}

/**
 * 写路径的 `expect` 拒绝 —— 把 {@link expectVerdict} 的**同一份结论**翻成 `PatchError`。
 *
 * 本函数**不做任何判定**：没有比较、没有归一化、没有阈值。`kind` 已经是判据给的结论，
 * 这里只决定两件事：用哪个码说、怎么说。阈值也是从 `locator-api` 取的同一个常量
 * （{@link ASSERT_RELAX_MIN_CHARS}），不在本文件重写一个 12。
 *
 * 码的分派与 DSH 壳的三态判决表（`aura-edit/index.js` 的 `OUTCOME_BY_CODE`）对齐：
 *   · `short_mismatch` ⇒ `PATCH_EXPECT_MISMATCH`（"这段文字与这里对不上"；短引文仍要求整段相等，
 *     与改前同码 —— `content-address-test` 段F5 钉着它）⇒ outcome `not_found`；
 *   · `not_unique` ⇒ `PATCH_AMBIGUOUS`（多处都能对上，得由调用方挑一处 ⇒ outcome `needs_choice`；
 *     候选清单必须一起给，否则"从候选里选"是一句空话）;
 *   · `nowhere` / `spans_wider` / `outside` ⇒ `PATCH_NOT_FOUND`（按这段 `expect` 找不到要改的原文
 *     ⇒ outcome `not_found`）。
 *
 * 消息里必须带**区间原文**与**候选行**：DSH 框架对抛出的错误只取 `error.message`
 * （`dsh-tools/lib/index.js` 的 `errorMessage`），其余字段一概不读。
 *
 * @param verdict - {@link expectVerdict} 的结论（非 null）
 * @param line - 命中区间的起始行（1-based）
 * @param tier - 命中层，写进消息
 * @param actual - 受寻址区间原文
 * @returns PatchError（码见上）
 */
function expectGateError(verdict, line, tier, actual) {
  const where = `hunk at line ${line} matched via ${tier}`
  const there = `the content there is: ${quoteForMessage(actual, line)}`

  if (verdict.kind === 'not_unique') {
    const { listing, hidden } = candidateListing(verdict.places)
    /** 清单多行时它自带收尾换行，`(+N more)` 就不能再顶在最后一行原文的尾巴上。 */
    const omitted = hidden === 0 ? '' : `${listing.endsWith('\n') ? '' : ' '}(+${hidden} more, not shown: this receipt's output budget)`
    return new PatchError(
      `${where}, but expect is not unique in this file — it appears on ${verdict.places.length} places, so it ` +
        `cannot say WHICH one you mean; quote more of the surrounding text (or say which one with \`old\`/\`context\`) ` +
        `so that it is unique — ${there}; candidates: ${listing}${omitted}`,
      'PATCH_AMBIGUOUS',
      { line, actual, candidates: verdict.places },
    )
  }

  if (verdict.kind === 'short_mismatch') {
    return new PatchError(
      `${where}, but expect is shorter than ${ASSERT_RELAX_MIN_CHARS} chars, so it must equal the addressed ` +
        `region exactly — ${there}`,
      'PATCH_EXPECT_MISMATCH',
      { line, actual },
    )
  }

  if (verdict.kind === 'nowhere') {
    return new PatchError(
      `${where}, but expect appears nowhere in this file (whole-file scan, whitespace-normalized) — ${there}`,
      'PATCH_NOT_FOUND',
      { line, actual },
    )
  }

  /** 剩下两支都带 `at`（唯一出现处）：`spans_wider` 与 `outside`。 */
  const at = verdict.at
  if (verdict.kind === 'spans_wider') {
    return new PatchError(
      `${where}, but expect spans ${verdict.spans} lines while the addressed region is ${verdict.regionLines} ` +
        `line(s) (lines ${at.line}-${at.endLine} hold it); address the whole quote, or trim expect down to the ` +
        `addressed text — ${there}`,
      'PATCH_NOT_FOUND',
      { line, actual },
    )
  }

  return new PatchError(
    `${where}, but expect's only occurrence in this file is ` +
      `${at.line === at.endLine ? `line ${at.line}` : `lines ${at.line}-${at.endLine}`}, which ` +
      (verdict.overlaps
        ? 'only partly overlaps the addressed region (the quote has to fit entirely inside it)'
        : 'is outside the addressed region') +
      ` — ${there}`,
    'PATCH_NOT_FOUND',
    { line, actual },
  )
}

/**
 * 用**内容**定位一个 hunk：`old` 找候选，`context` 收敛，收敛不了就报候选清单。
 *
 * 收敛顺序（每一步只**筛掉**候选，绝不凭空造出一个）：
 *   1. **整行对齐**（{@link findWindowTier}）：`old` 是一整行（或连续几整行）原文时按行区间命中；
 *      一处都没有 ⇒ 退一层（这一层有命中时不跑下一层：片段层的候选集是它的超集，不会收敛得更好）；
 *   2. **行内片段**（{@link findFragmentTier}）：`old` 只是某一行的**一部分**时，按「片段在文件里
 *      唯一出现」定位，替换范围**就是那一处出现本身**（起止列见 {@link fragmentSpans}）；
 *      两层都没有 ⇒ {@link oldNotFoundError}（这段文字在文件里没有出现）；
 *   3. `context` 在邻域内（紧邻 / 包含 `old`）⇒ 命中（`old+context`）；
 *   4. **自动扩大上下文重试一次**：把邻域放宽一个 context 长度再看 ⇒ 命中（`old+expanded`）；
 *   5. `near` 显式提示从剩下的候选里收敛（唯一最近才算，并列不猜）；
 *   6. 仍不唯一 ⇒ `PATCH_AMBIGUOUS` + 候选清单，磁盘一个字节都不动
 *      （`planHunks` 是纯函数，“先全部规划完再落盘”的事务性由调用方承接）。
 *
 * 唯一性在片段层**不打折**：片段出现多处（哪怕每处都是行内片段）照样拒绝并给候选，不挑一个。
 *
 * @param lines - 文件的行（{@link splitLinesWithEndings} 的产物，行号与 `locate` 同一把尺子）
 * @param hunk - 原始 DSL 形状的 hunk（读 `old` / `context` / `near` / 坐标）
 * @param oldText - {@link oldAddressOf} 的产物（非空）
 * @param label - 回执里指代这份文件的说法
 * @returns `{startLine, endLine, tier, actual, addressed, fragmentNote?, coordinateNote?,
 *   coordinateConflict?, byNear?}`；
 *   地址形态与调用方字面写的不符时（片段层的命中跨度比整行窄、坐标与落点不一致），`tier` 里已经带上
 *   那句话（DSH 壳的 `output.schema` 是
 *   `additionalProperties: false`，`applied[]` 上加未声明字段会让整条成功路径被判成
 *   `INVALID_TOOL_OUTPUT`，`tier` 是那里唯一能承载这句话的已声明字段）。
 * @throws PatchError：`PATCH_NOT_FOUND`（old 不在文件里）/ `PATCH_AMBIGUOUS`（收敛不到一个）
 */
function locateByOld(lines, hunk, oldText, label, ctx = null) {
  const oldRows = addressRows(oldText)
  const aligned = findWindowTier(lines, oldRows)
  /**
   * 候选统一写成 `{start, span}`：整行对齐那一层 span 恒等于 `old` 的行数；片段层每个候选的 span
   * 由“片段落在哪些行里”决定，可以互不相同（两者都另带它自己那段的起止列）。
   * 下面收敛/就近两轮因此对两层是**同一份代码**——不为片段层再抄一遍（抄一份就等于将来只改一处）。
   */
  let candidates = aligned.starts.map((start) => ({ start, span: oldRows.length }))
  let tierKey = aligned.tier
  let norm = aligned.norm
  let byFragment = false
  if (candidates.length === 0) {
    const fragment = findFragmentTier(lines, oldText)
    /**
     * 「找不到」的回执要贴**原文那一带**，所以定位器手里那三样东西一并交给它：
     * 全文的行（行号与 `locate` 同一把尺）、`old` 的行、以及原始 hunk（坐标 / `near` 只当提示）。
     * 这三样都是**只读**的：回执只描述落点，不改任何结论——判据仍是上面那两层。
     */
    if (fragment.spans.length === 0) throw oldNotFoundError(label, lines, oldRows, hunk, ctx)
    candidates = fragment.spans
    tierKey = fragment.tier
    norm = fragment.norm
    byFragment = true
  }
  const ctxRows = typeof hunk.context === 'string' && hunk.context.trim().length > 0 ? addressRows(hunk.context) : []
  const total = candidates.length
  /**
   * 片段层候选多带 `{startCol, endCol, text}`：这一层替换的**就是那一处跨度**，不是整行。
   * 收敛/就近两轮只看 `{start, span}`（行读数），所以它们原样沿用两层同一份代码。
   */
  let narrowed = ''
  if (candidates.length > 1 && ctxRows.length > 0) {
    const tight = candidates.filter((c) => contextSitsAt(lines, c.start, c.span, ctxRows, norm, 0))
    if (tight.length === 1) {
      candidates = tight
      narrowed = '+context'
    } else {
      // 收紧不到一个（含“收紧到 0 个”）⇒ 自动扩大上下文**重试一次**。
      const base = tight.length > 0 ? tight : candidates
      const wide = base.filter((c) => contextSitsAt(lines, c.start, c.span, ctxRows, norm, ctxRows.length))
      if (wide.length === 1) {
        candidates = wide
        narrowed = '+expanded'
      } else if (wide.length > 0) candidates = wide
    }
  }
  let byNear = false
  if (candidates.length > 1 && hunk.near !== undefined && hunk.near !== null) {
    const chosen = nearestOnly(candidates.map((c) => c.start), hunk.near)
    if (chosen !== null) {
      candidates = candidates.filter((c) => c.start === chosen)
      byNear = true
    }
  }
  if (candidates.length > 1) throw oldAmbiguityError(lines, candidates, label, total, ctx)
  const [chosen] = candidates
  return oldHitFromCandidate(lines, hunk, chosen, { tierKey, narrowed, byNear })
}

/**
 * 把一个 `old` 候选变成一份定位命中（单处与 replace_all 共用，判据只写一次）。
 *
 * `tierPrefix` 只改回执里的层名：`old`（单处）/ `old-all`（全量替换）。除此之外两者逐字同形——
 * 回执字段、坐标核对、片段跨度、`after` 的取法都不分叉。
 */
function oldHitFromCandidate(lines, hunk, chosen, { tierKey, narrowed = '', byNear = false, tierPrefix = 'old' } = {}) {
  const byFragment = typeof chosen.text === 'string'
  const startLine = chosen.start + 1
  const endLine = chosen.start + chosen.span
  const tierBase = `${tierPrefix}${tierKey === 'exact' ? '' : `~${tierKey}`}${narrowed}`
  const range = lineRangeOf(hunk)
  const coordinatesAgree = range !== undefined && range.start === startLine && range.end === endLine
  const coordinateNote =
    range === undefined || coordinatesAgree
      ? null
      : `coordinates lines ${range.start}-${range.end} do not hold this old text — addressed by old at line ${startLine} instead`
  /**
   * 受寻址区间的原文：整行对齐层是一整行（或几行）；片段层是**命中跨度自己**。
   * `expect` 闸门（{@link expectVerdict}）因此按真正被替换的那一段判，而不是按一行判。
   */
  const addressed = byFragment ? chosen.text : lines.slice(chosen.start, endLine).join('\n')
  const fragmentNote = byFragment ? fragmentNoteFor(startLine, chosen.startCol, chosen.endCol, chosen.text) : null
  /** 两条披露可能同时成立（片段层的跨度比整行窄 + 坐标与落点不符）：都写进 `tier`，各说各的事实。 */
  const notes = [fragmentNote, coordinateNote].filter((note) => note !== null)
  return {
    startLine,
    endLine,
    tier: notes.length === 0 ? tierBase : `${tierBase} (${notes.join('; ')})`,
    actual: addressed,
    addressed,
    /**
     * 命中跨度的结构：只对片段层有意义（整行对齐层的跨度恒为行首到行尾）。
     * `columns` 是**替换范围**在原文里的起止列（1-based 闭区间），`text` 是它逐字的原文。
     * 跨行时 `columns[1]` 是**首行坐标**（拼接层拿它切 `prefix` / `tail`），
     * 末行那一侧的列号另放 `endLineCol`。
     */
    ...(byFragment
      ? {
          fragment: {
            line: startLine,
            endLine,
            columns: [chosen.startCol, chosen.endCol],
            ...(chosen.endLineCol === undefined ? {} : { endLineCol: chosen.endLineCol }),
            text: chosen.text,
          },
        }
      : {}),
    ...(fragmentNote === null ? {} : { fragmentNote }),
    ...(coordinateNote === null
      ? {}
      : { coordinateNote, coordinateConflict: { given: [range.start, range.end], actual: [startLine, endLine] } }),
    ...(byNear ? { byNear: true } : {}),
  }
}

/**
 * `replace_all`：把 `old` 在文件里的**全部非重叠出现**各变成一份命中。
 *
 * 与 {@link locateByOld} 共用两层定位（整行对齐 → 行内片段）和同一份命中装配；差别有三点：
 *   · 不再要求唯一，而是**逐处**返回（调用方一次改完）；
 *   · **优先用片段层**。整行层对 `norm-space` 的语义是"换掉整行"，而 `replace_all` 的承诺是
 *     "换掉这段文字"——整行优先会让同一段文字在行内出现时被漏掉（实测：
 *     `old:"beta gamma"` 在 `  beta   gamma` 与独立一行各出现一次，整行层只看见后一处）；
 *   · 重叠出现只保留最左边那一个（从左到右、不回头），与 `String.replaceAll` 的非重叠口径一致。
 *     例：`old="aa"` 打在 `aaaa` 上得到两处（1-2、3-4），不会把重叠的三处叠进一次替换。
 *
 * 上下文/坐标/`near` 在这里没有意义（它们都是"收敛到一处"的工具），参数面已拒绝；
 * 找不到任何一处时仍走 {@link oldNotFoundError}，回执与单处地址同一份。
 */
function locateAllByOld(lines, hunk, oldText, label, ctx = null) {
  const oldRows = addressRows(oldText)
  const fragment = findFragmentTier(lines, oldText)
  let candidates
  let tierKey
  let byFragment = true
  if (fragment.spans.length > 0) {
    candidates = fragment.spans
    tierKey = fragment.tier
  } else {
    /**
     * 片段层找不到、整行层却有时才走这里（正常输入不会出现：整行原文本来就是片段层的一个子串）。
     * 保留它是为了不把“找不到”的判决提前成另一种沉默——两层都空才是真的没有。
     */
    const aligned = findWindowTier(lines, oldRows)
    if (aligned.starts.length === 0) throw oldNotFoundError(label, lines, oldRows, hunk, ctx)
    candidates = aligned.starts.map((start) => ({ start, span: oldRows.length }))
    tierKey = aligned.tier
    byFragment = false
  }
  return nonOverlappingCandidates(candidates, byFragment).map((chosen) =>
    oldHitFromCandidate(lines, hunk, chosen, { tierKey, tierPrefix: 'old-all' }),
  )
}

/**
 * 按“从左到右、不回头”筛掉重叠候选（保持输入顺序之外的确定性：先按行/列排序再筛）。
 *
 * 整行候选只比行区间；片段候选还要比列——同一行里的两处 `old` 是两次不同的替换，
 * 不能因为落在同一行就当成重叠（那会把 `replace_all` 静默降成“只改每行第一处”）。
 */
function nonOverlappingCandidates(candidates, byFragment) {
  const sorted = [...candidates].sort(
    (a, b) => a.start - b.start || (byFragment ? a.startCol - b.startCol : 0),
  )
  const kept = []
  for (const candidate of sorted) {
    const previous = kept[kept.length - 1]
    if (previous === undefined || !candidateOverlaps(previous, candidate, byFragment)) kept.push(candidate)
  }
  return kept
}

/** 两个候选在**被替换的字节**上是否重叠（整行层按行，片段层按行列）。 */
function candidateOverlaps(a, b, byFragment) {
  if (!byFragment) return a.start + a.span > b.start
  if (a.start === b.start) return a.startCol <= b.endCol && b.startCol <= a.endCol
  const [first, second] = a.start < b.start ? [a, b] : [b, a]
  const firstEndExclusive = first.start + first.span
  if (second.start > firstEndExclusive - 1) return false
  if (second.start < firstEndExclusive - 1) return true
  /**
   * `endLineCol` 是末行的 0-based 排他列；转换成 1-based 闭区间末列正好等于它。
   * 第二处从同一行更靠后的列开始 ⇒ 两段不相交。
   */
  const firstEndCol = first.endLineCol ?? first.endCol
  return second.startCol <= firstEndCol
}

/**
 * 已定好的两处替换是否重叠（拼接前最后一道）。
 *
 * 整行命中仍按行区间判（保守）；两处**片段**命中允许落在同一行，只要字节不相交——
 * 这正是 `replace_all` 在同一行改多处所需要的那条路（`a` 与 `b` 各换各的那一段）。
 */
function matchesOverlap(a, b) {
  if (a.fragment === undefined || b.fragment === undefined) return a.start < b.end && b.start < a.end
  const asCandidate = (match) => ({
    start: match.start,
    span: match.end - match.start,
    startCol: match.fragment.columns[0],
    endCol: match.fragment.columns[1],
    ...(match.fragment.endLineCol === undefined ? {} : { endLineCol: match.fragment.endLineCol }),
  })
  return candidateOverlaps(asCandidate(a), asCandidate(b), true)
}

// ── 内容寻址的第二条出路：这次编辑**已经落地**了 ─────────────────────────────
//
// 形状：`old` 不在文件里（两层都找不到），但**结果已经在文件里了** —— 调用方给的 `replace`
// 逐字就在原文中。历史数据里这一类是真实存在的：`residual-census` 重放 353 条历史失败，
// C33 读数里归 fail 的 174 条中，有 27 条是这个形状 —— 入口换成编排层之后它们从残余里单列成
// `already_applied`（fail 174 → 147）；这 27 个编号在 `already-applied-census` 的 pin 里列着
// （`treeNew.already_applied` 27 / `landedIds` 27 条），
// 其中 F0040 的实测记录里那句“命中的原文已等于 `replace`”就是这个形状的直白写法。
//
// 为什么值得单列一态：调用方的调用**被中断/失败后重试**时（本仓会话日志里 17 次「调用被记录
// 但没有结果落盘」、111 次「事务未提交」），如果上一次其实已经写成功了，工具只回一句
// “你要改的原文不在文件里”，调用方拿不到任何信息知道“它已经改好了” —— 于是它会去重读、
// 去改地址、去改写法，而正确答案是“这次不用改”。
//
// ## 判据（三档，全部只在**内存**里算）
//
//   ① `old` 两层都找不到 —— 判据与 {@link locateByOld} 是**同两个函数**（{@link findWindowTier}
//      与 {@link findFragmentTier}）。`old` 只要在任一层命中，本条就不成立（那种情形要么已经
//      被 `planHunks` 接住，要么是歧义/断言不符，都不是这个形状）。
//   ② `replace` 是**整行**命中（`findWindowTier` 那一层，比片段层**严**），且**全文唯一**。
//      唯一性是 `old` 被应用时本来就要求的门槛（多处命中 ⇒ `PATCH_AMBIGUOUS`）；对 `replace`
//      用同一把尺子，才谈得上“`replace` 不比 `old` 更宽松地匹配”。**不许**用片段层接住它：
//      `{old:'zzz-nowhere', replace:'X'}` 打在随便哪个含 `X` 的文件上都会“命中”，那不是证据。
//   ③ `replace` 去掉空白后有 {@link ALREADY_APPLIED_MIN_CHARS} 个字符。整行命中挡得住
//      “行内片段巧遇”，挡不住“文件里恰好有一整行是 `X`/`}`”这种巧遇；这条门槛是本单实测
//      这一类里最短的一条（19 字符）之下取的整数，只做**下限**用，不参与定位。
//
// 三条全过 ⇒ 这一条 hunk 判「已落地」。**多 hunk 调用必须逐条全过**才算：一条已落地、
// 另一条真的找不到时，这次编辑**并没有全部落地**，回执就不能说“已经是你给的样子了”——
// 那种情形原样抛 `PATCH_NOT_FOUND`（宁可少说，不许说错）。
//
// ## 不许破的
//
//   · **它不写盘**：判据在 {@link applyEditToProvider} 里、任何 `writeText` **之前**，
//     所以“已落地”这条路的磁盘字节数恒等于进来时那份（`already-applied-test` 段B 逐字节钉住）；
//   · **它不改 `planHunks` 的判决**：`planHunks` 照旧抛 `PATCH_NOT_FOUND`（拿不到原文的调用方
//     仍然拿到那条带最近一带原文与 `next` 的回执），本函数是**第二条出路**，不是对它的放宽；
//   · **幂等**：同一份 `{old, replace}` 打第二次仍然是「已落地」，第二次也不写盘。

/** 「已落地」在回执 `tier` 里的前缀（有已声明字段可用，就不新造顶层字段）。 */
const ALREADY_APPLIED_TIER = 'already-applied'

/**
 * `replace` 去掉空白后的**下限**（字符）。见上面 ③：只挡巧遇，不参与定位。
 *
 * 取 8 的依据是本单的实测分布：27 条“已落地”里最短的一条是 19 个字符（条数与编号集以
 * `already-applied-census.mjs` 的 pin 为准 —— `treeNew.already_applied` 27 / `landedIds` 27 条；
 * 本条早先手抄的 26 已过期。F0243 的 `  "status": "done",` 那一行），而单字符/单词级的 `replace`
 * （`X`、`}`、`-`、`ok`）在文件里出现一次与“调用方要的结果已经在那儿”不可区分。
 */
const ALREADY_APPLIED_MIN_CHARS = 8

/**
 * 回执里“改动后行内区域”的**体量上限**（0.8.1）。
 *
 * 只对片段层（`fragment`）回填整行上下文：整行替换的 `replaced` 已经是完整的新区域，
 * 再回一份 `after` 只是把同一段文本说两遍。片段层不同——`replaced` 只是行内那一段，
 * 调用方看不到整行改完的样子；给整行才能确认前后缀没被挤坏。
 * 上限 400 字符：足够覆盖常见一行，又不会让回执因为一个超长行翻倍。
 */
const RECEIPT_AFTER_CHARS = 400

/**
 * 逐条判「已落地」：全过 ⇒ 回执数组（每条 hunk 一项）；任一条不成立 ⇒ `null`。
 *
 * 返回的每一项都能**逐字核对**：`line` 是 `replace` 已经在的那一行（1-based，与 `applied[].line`
 * 同一把尺子）、`tier` 说清它是在哪一层命中的、`actual` 是那一处的**原文**（就等于 `replace`）、
 * `replaced` 是调用方给的那份文本。
 *
 * @param content - 文件全文
 * @param hunks - 原始 DSL 形状的 hunk 数组（只读 `old` / `replace`）
 * @returns `Array<{hunk, line, tier, actual, replaced}> | null`
 */
export function alreadyAppliedHits(content, hunks) {
  if (!Array.isArray(hunks) || hunks.length === 0) return null
  const { lines } = splitLinesWithEndings(content)
  const hits = []
  for (const [index, hunk] of hunks.entries()) {
    const hit = alreadyAppliedHitOf(lines, hunk)
    if (hit === null) return null
    hits.push({ hunk: index, ...hit })
  }
  return hits
}

/**
 * 单条 hunk 的判据本体（三条，见上面那一段）。命中返回回执那一项，否则 `null`。
 *
 * 三条都不看 `expect`：`expect` 说的是“**改之前**那里是什么”，而这一态的全部内容是
 * “**改之后**那里已经是什么” —— 拿前者给后者作证，是把两件事混成一件。
 */
function alreadyAppliedHitOf(lines, hunk) {
  const oldText = oldAddressOf(hunk)
  if (oldText === null) return null
  const replace = typeof hunk.replace === 'string' ? hunk.replace : ''
  if (replace.trim().length === 0) return null
  if (replace.replace(/\s+/g, '').length < ALREADY_APPLIED_MIN_CHARS) return null
  // ① `old` 两层都没有（判据与 locateByOld 同源；`old` 在场就不是这一态）。
  if (findWindowTier(lines, addressRows(oldText)).starts.length > 0) return null
  if (findFragmentTier(lines, oldText).spans.length > 0) return null
  // ② `replace` 整行命中且唯一 —— 比片段层严，且与 `old` 被应用时的唯一性门槛同一把尺子。
  const rows = addressRows(replace)
  const aligned = findWindowTier(lines, rows)
  if (aligned.starts.length !== 1) return null
  const [start] = aligned.starts
  return {
    line: start + 1,
    tier: `${ALREADY_APPLIED_TIER}~${aligned.tier}`,
    actual: lines.slice(start, start + rows.length).join('\n'),
    replaced: replace,
  }
}

/** 句柄路的层名：进 `applied[].tier`，短是硬要求（回执体积）。 */
const HANDLE_TIER = 'handle'

/** 句柄指不到那一段字节时的统一拒绝（结果通道 `not_found`，磁盘一个字节不动）。 */
function handleStaleError(label) {
  return new PatchError(
    `the bytes this handle names are no longer in ${label} — re-read that region and use the handle from that read; nothing was written`,
    'PATCH_HANDLE_STALE',
  )
}

/**
 * 句柄 → 当前文件里的那一段（契约 §5 的第 1、2 步）。
 *
 *   ① 身份标签（同一个 `resolveLedgerKey` 口径）不符 ⇒ 拒（D5：句柄不能拄到另一份文件上）；
 *   ② 拿句柄带的坐标在当前文件里算**同一份摘要**：
 *        相等 ⇒ **主命中**，就用这一段；
 *        不等 ⇒ **尽力重找**：拿账本里那条整文件观测（读侧 `rememberRead` 记的，本来就在）里
 *              读时文本的同段字节，在当前文件里**逐字整行**搜——
 *              唯一 ⇒ 按新坐标应用并在回执里披露"区间已移动"；多处 ⇒ 既有 `needs_choice`；
 *              零处 ⇒ 拒。
 *
 * 「账本里那条观测不在了」「观测里那段字节的摘要与句柄不符」都归零处命中：**不猜**（契约 §3）。
 * 搜索只走逐字层（不用 {@link findWindowTier} 的空白折叠层）：折叠层会把"内容已被别人
 * 改过"读成一次移动，而移动意味着 `{handle, replace}` 要去覆盖一段**不是调用方读过**的字节。
 */
function resolveHandleRegion(lines, parsed, ctx) {
  if (identityTag(ctx.ledgerKey) !== parsed.idTag) {
    throw new PatchError(
      `this handle was minted for another file (or another path spelling) than ${ctx.label} — re-read that file and use the handle from that read; nothing was written`,
      'PATCH_HANDLE_IDENTITY_MISMATCH',
    )
  }
  /** 结构句柄：地址是路径，不是坐标；指纹只回答“你读到的内容变了没有”。 */
  if (parsed.kind === 'structure') {
    const region = resolveStructureRegion(lines, { kind: parsed.structureKind, path: parsed.path }, ctx)
    const fingerprint = regionFingerprint(region.rows.join('\n'), ctx.byteOrderMark)
    return { ...region, changed: fingerprint !== parsed.fingerprint }
  }
  const own = regionRowsAt(lines, parsed.startLine, parsed.endLine)
  if (own !== null && regionFingerprint(own.join('\n'), ctx.byteOrderMark) === parsed.fingerprint) {
    return { startLine: parsed.startLine, endLine: parsed.endLine, rows: own, moved: false }
  }
  const observation = latestObservation(ctx.ledgerKey, { source: ctx.content })
  /**
   * `source === null` 是**大文件的令牌-only 观测**（`observation-store` 的 `MAX_SOURCE`）：
   * 没有全文就无法核对句柄携带的那段字节，与“账本里根本没有这条观测”同一条出路（`handleStaleError`）。
   * 旧代码直接 `.split`，在 >256 KiB 的陈旧句柄上抛 TypeError，把可判定的拒绝变成工具故障。
   */
  if (observation === null || typeof observation.source !== 'string') throw handleStaleError(ctx.label)
  const thenRows = regionRowsAt(observation.source.split(/\r?\n/), parsed.startLine, parsed.endLine)
  if (thenRows === null) throw handleStaleError(ctx.label)
  const thenText = thenRows.join('\n')
  // 观测里那段字节的摘要必须逐字等于句柄带的摘要：不等 ⇒ 这个句柄不是从这条观测铸出来的，不猜。
  if (regionFingerprint(thenText, ctx.byteOrderMark) !== parsed.fingerprint) throw handleStaleError(ctx.label)
  const starts = windowStarts(lines, thenRows, (text) => text)
  if (starts.length === 0) throw handleStaleError(ctx.label)
  if (starts.length > 1) {
    throw oldAmbiguityError(
      lines,
      starts.map((start) => ({ start, span: thenRows.length })),
      ctx.label,
      starts.length,
      ctx,
    )
  }
  const [start] = starts
  return { startLine: start + 1, endLine: start + thenRows.length, rows: thenRows, moved: true }
}

/**
 * 句柄在场时**不决定位置**的那些地址字段（D7：句柄优先，但让开的一方必须披露）。
 *
 * 只列**真的在场**的：`lines` / `start_line` / `end_line` 是调用方从上一版视图拄来的绝对坐标，
 * `target` / `line_cue` / `anchor` 是另外三种地址形态，`old` / `line` / `position` 是三种相对
 * 定位器（被选中时不算让开——只有 `{handle, old}` 这一种组合要求 `old` 命中区间内）。
 */
function ignoredHandleNotes(hunk, chosen) {
  const names = []
  if (chosen !== 'old' && oldAddressOf(hunk) !== null) names.push('old')
  if (chosen !== 'line' && hunk.line !== undefined && hunk.line !== null) names.push('line')
  if (chosen !== 'position' && hunk.position !== undefined && hunk.position !== null) names.push('position')
  const coords = ['lines', 'range', 'start_line', 'end_line'].filter(
    (key) => hunk[key] !== undefined && hunk[key] !== null,
  )
  if (coords.length > 0) names.push(coords.join('/'))
  for (const key of ['target', 'line_cue', 'anchor']) {
    if (typeof hunk[key] === 'string' && hunk[key].trim().length > 0) names.push(key)
  }
  return names.length === 0 ? [] : [`ignored (the handle decides the region): ${names.join(', ')}`]
}

/**
 * `{handle, old}`：在**句柄那段区间内部**按逐字片段定位，区间之外不找。
 *
 * 与 {@link locateByOld} 同一套层（整行对齐 → 片段）、同一套收敛（`context` 收紧 / 自动扩大
 * 重试一次 / `near` 就近），差别只有两处：**搜索面是区间自己**，以及找不到时的码不是
 * `PATCH_NOT_FOUND` 而是 `PATCH_HANDLE_QUOTE_OUTSIDE`——那时真正的问题是"你给的引文不在
 * 你给的区间里"，报"文件里找不到"会把调用方赶去重读整份文件，而它只需重新挑一段引文。
 *
 * **不许**在找不到时退化成整段替换：那是把"你说的这一段"偷偷换成"整个区间"，
 * 正是本项目最忌的那类静默错配（契约 §5 第 4 条）。
 */
function locateOldInRegion(lines, region, hunk, oldText, ctx) {
  const regionRows = region.rows
  const oldRows = addressRows(oldText)
  const aligned = findWindowTier(regionRows, oldRows)
  /** 候选统一写成 `{start, span}` 且 start 是**区间内**的 0-based 行号（与 {@link locateByOld} 同形）。 */
  let candidates = aligned.starts.map((start) => ({ start, span: oldRows.length }))
  let tierKey = aligned.tier
  let norm = aligned.norm
  let byFragment = false
  if (candidates.length === 0) {
    const fragment = findFragmentTier(regionRows, oldText)
    if (fragment.spans.length === 0) {
      throw new PatchError(
        `the \`old\` text you gave is not inside the region this handle covers (lines ${region.startLine}-${region.endLine} in ${ctx.label}) — nothing was written`,
        'PATCH_HANDLE_QUOTE_OUTSIDE',
      )
    }
    candidates = fragment.spans
    tierKey = fragment.tier
    norm = fragment.norm
    byFragment = true
  }
  const ctxRows =
    typeof hunk.context === 'string' && hunk.context.trim().length > 0 ? addressRows(hunk.context) : []
  const total = candidates.length
  const frag = (c) => byFragment && typeof c?.text === 'string'
  let narrowed = ''
  if (candidates.length > 1 && ctxRows.length > 0) {
    const tight = candidates.filter((c) => contextSitsAt(regionRows, c.start, c.span, ctxRows, norm, 0))
    if (tight.length === 1) {
      candidates = tight
      narrowed = '+context'
    } else {
      const base = tight.length > 0 ? tight : candidates
      const wide = base.filter((c) => contextSitsAt(regionRows, c.start, c.span, ctxRows, norm, ctxRows.length))
      if (wide.length === 1) {
        candidates = wide
        narrowed = '+expanded'
      } else if (wide.length > 0) candidates = wide
    }
  }
  let byNear = false
  if (candidates.length > 1 && hunk.near !== undefined && hunk.near !== null) {
    const chosen = nearestOnly(candidates.map((c) => region.startLine + c.start), hunk.near)
    if (chosen !== null) {
      candidates = candidates.filter((c) => region.startLine + c.start === chosen)
      byNear = true
    }
  }
  if (candidates.length > 1) {
    throw oldAmbiguityError(
      lines,
      candidates.map((c) => ({ ...c, start: region.startLine - 1 + c.start })),
      ctx.label,
      total,
      ctx,
    )
  }
  const [hit] = candidates
  const startLine = region.startLine + hit.start
  const endLine = startLine + hit.span - 1
  const addressed = frag(hit) ? hit.text : regionRows.slice(hit.start, hit.start + hit.span).join('\n')
  return {
    startLine,
    endLine,
    tier: `${HANDLE_TIER}+old${tierKey === 'exact' ? '' : `~${tierKey}`}${narrowed}`,
    actual: addressed,
    ...(frag(hit)
      ? {
          fragment: {
            line: startLine,
            endLine,
            columns: [hit.startCol, hit.endCol],
            ...(hit.endLineCol === undefined ? {} : { endLineCol: hit.endLineCol }),
            text: hit.text,
          },
        }
      : {}),
    ...(frag(hit) ? { fragmentNote: fragmentNoteFor(startLine, hit.startCol, hit.endCol, hit.text) } : {}),
    ...(byNear ? { byNear: true } : {}),
  }
}

/**
 * 句柄寻址的定位本体：四种形状的**次序**就在这里（契约 §5 已冻结）。
 *
 * 优先级：`position` > `line` > `old` > 整段。它们都是**区间内**的相对定位，
 * 所以句柄先定下区间，形状再在区间里定点；被让开的字段走 `tier` 披露（{@link ignoredHandleNotes}）。
 *
 * `handleRegion` 是给闸门用的：句柄的凭据覆盖**整个区间**，而 `line: k` / `old` 只是区间内部的
 * 相对定位 ⇒ 闸门要比对的是整个区间，不是这次替换的那一小段（{@link staleConflicts}）。
 */
function locateByHandle(lines, hunk, parsed, ctx, preResolved = null) {
  const region = preResolved ?? resolveHandleRegion(lines, parsed, ctx)
  const total = region.rows.length
  const regionText = region.rows.join('\n')
  const handleRegion = { startLine: region.startLine, endLine: region.endLine, text: regionText }
  const notes = region.moved
    ? [`region moved: lines ${parsed.startLine}-${parsed.endLine} → ${region.startLine}-${region.endLine}`]
    : []
  const position = hunk.position === undefined || hunk.position === null ? null : hunk.position
  if (position !== null && position !== 'before' && position !== 'after') {
    throw new PatchError(
      `\`position\` must be "before" or "after" (got ${JSON.stringify(position)}) — nothing was written`,
      'PATCH_HANDLE_SHAPE',
    )
  }
  const gaveLine = position === null && hunk.line !== undefined && hunk.line !== null
  const relLine = gaveLine ? toLineNumber(hunk.line) : null
  if (gaveLine && relLine === null) {
    throw new PatchError(
      `\`line\` must be an integer row inside the handle's region (got ${JSON.stringify(hunk.line)}) — nothing was written`,
      'PATCH_HANDLE_SHAPE',
    )
  }
  const oldText = position !== null || relLine !== null ? null : oldAddressOf(hunk)
  const chosen = position !== null ? 'position' : relLine !== null ? 'line' : oldText !== null ? 'old' : 'region'
  notes.push(...ignoredHandleNotes(hunk, chosen))
  const finish = (shape) => ({
    ...shape,
    handleRegion,
    tier: notes.length === 0 ? shape.tier : `${shape.tier} (${notes.join('; ')})`,
  })
  if (chosen === 'position') {
    /**
     * 边界插入：零宽度区间（`loc.start === loc.end`）⇒ 拼接层把它当插入，区间本身一个字节不动。
     * `before` 插在区间首行之前，`after` 插在区间末行之后（都不是"区间外"的模糊地带，就是边界）。
     */
    const at = position === 'before' ? region.startLine : region.endLine + 1
    return finish({ startLine: at, endLine: at - 1, tier: `${HANDLE_TIER} ${position}`, actual: '' })
  }
  if (chosen === 'line') {
    if (relLine < 1 || relLine > total) {
      throw new PatchError(
        `handle region lines ${region.startLine}-${region.endLine} has ${total} line(s); line ${relLine} is outside it (\`line\` counts from the region start, 1-based) — nothing was written`,
        'PATCH_HANDLE_LINE_OUT_OF_RANGE',
      )
    }
    const at = region.startLine + relLine - 1
    const text = region.rows[relLine - 1]
    return finish({ startLine: at, endLine: at, tier: `${HANDLE_TIER} line ${relLine}`, actual: text })
  }
  if (chosen === 'old') return finish(locateOldInRegion(lines, region, hunk, oldText, ctx))
  return finish({
    startLine: region.startLine,
    endLine: region.endLine,
    tier: region.structure === undefined ? HANDLE_TIER : `${HANDLE_TIER} ${region.structure.kind}`,
    actual: regionText,
  })
}

/**
 * 结构地址 → 区间 → 复用句柄的相对定位（`position` / `line` / `old` / 整段）。
 * 不另写一份相对定位：那会造出第二个“区间内怎么定点”的真值源。
 */
function locateByStructure(lines, hunk, structure, ctx) {
  const region = resolveStructureRegion(lines, structure, ctx)
  return locateByHandle(
    lines,
    hunk,
    { ok: true, kind: 'structure', startLine: region.startLine, endLine: region.endLine, fingerprint: regionFingerprint(region.rows.join('\n'), ctx.byteOrderMark) },
    ctx,
    region,
  )
}


/**
 * 规划所有 hunk：逐个定位 → expect 核对 → 重叠检查 → 倒序拼接。
 * 任一 hunk 失败即抛错，调用方据此保证磁盘不变（事务性来自"先全部规划完再落盘"）。
 *
 * 定位本身不在这里——它调 {@link locate}（框架无关的定位服务）或 {@link locateByOld}
 * （内容寻址），本函数只负责 DSH 侧的编排：多 hunk 的事务语义、expect 闸门、倒序拼接。
 *
 * ## 地址的主次（fs-contract-v2）
 *
 * `old`（要替换的原文，＋可选 `context`）是**主地址**：给了它就按内容定位，不跟到符号/线索层。
 * 坐标（`lines` / `start_line` / `end_line`）降为**提示**：与 `old` 冲突时以 `old` 为准，
 * 并在回执里明说“坐标与原文不符，已按原文定位”（`applied[].tier` 里带那句话）。
 *
 * @param content - 文件全文
 * @param hunks - 每个 { handle?, line?, position?, anchor?, target?, old?, context?, replace, expect?, near? }
 *   （`handle` / `line` / `position` 三种是 fs-contract-v2 的句柄形状，见 {@link locateByHandle}）
 * @param filePath - 用于判定语言（符号路径需要）；缺省则符号路径自动不可用
 * @param options.identityKey - **宿主给的身份键**（同一份盘上文件必给同一个串）：句柄里的身份标签
 *   就是拿同一个 `ledgerIdentityKey` 口径算的，不给就只按 `filePath` 自己算（与读侧同形）。
 * @param options.byteOrderMark - 当前文件是否有前导 BOM（**摘要的一半**，只能从字节取）。
 *   漏传的后果是句柄在这份文件上永远对不上 ⇒ 一律 `PATCH_HANDLE_STALE`（拒绝，不是改错地方）。
 * @returns {{matches: Array, content: string, applied: Array}} 新内容与逐条回执
 */
export function planHunks(content, hunks, filePath = null, options = {}) {
  const { lines, endings } = splitLinesWithEndings(content)
  const matches = []
  /**
   * 句柄路的上下文：账本键、BOM、回执里的说法。
   *
   * 账本键只算一次（{@link ledgerIdentityKey} 是全引擎唯一那道归一）：句柄里的身份标签
   * 就是拿它算的，这里重算一遍才能核对（D5：两面各算各的，不一致就拒）。
   */
  const handleCtx = {
    content,
    ledgerKey: ledgerIdentityKey(filePath, options.identityKey),
    byteOrderMark: options.byteOrderMark === true,
    label: filePath === null ? 'this file' : filePath,
  }
  // `hunk: index` 是给区域级新鲜度闸门用的回指：matches 会按位置排序，
  // 而闸门要按**逐个 hunk** 比对它的区域，不能靠顺序猜。
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const hasTarget = typeof hunk.target === 'string' && hunk.target.trim().length > 0
    // 行区间走共用收敛层：`[4,6]`、`"4,6"`、`4`、`start_line/end_line` 都认。
    // 模型把 `lines` 写成 `"4,6"`、只给单行、或写成 `start_line` 是常态；
    // 为此回一句"参数不对"让它重试一遍，纯是浪费一轮。
    const range = lineRangeOf(hunk)
    const hasCue = typeof hunk.line_cue === 'string' && hunk.line_cue.trim().length > 0
    const hasAnchor = typeof hunk.anchor === 'string' && hunk.anchor.length > 0
    const oldText = oldAddressOf(hunk)
    /**
     * `replace_all`（0.10.2）：把 `old` 的**全部非重叠出现**各改一次。
     *
     * 它不是第六种地址，而是 `old` 的一种作用范围；因此只认 `old` + 动作字段（`replace` /
     * `expect` / `eol`）。把 `target`/`lines`/`context`/`near` 混进来意味着"既想全改又想收敛到一处"，
     * 没有正确答案 —— 参数面直接拒绝，与地址字段互斥同一条理由。
     */
    const replaceAll = hunk.replace_all
    if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
      throw new PatchError(
        '`replace_all` must be true or false — nothing was written',
        'PATCH_REPLACE_ALL_CONFLICT',
      )
    }
    if (replaceAll === true) {
      const clashes = []
      if (hasTarget) clashes.push('target')

      for (const key of ['lines', 'range', 'start_line', 'end_line']) {
        if (hunk[key] !== undefined && hunk[key] !== null) clashes.push(key)
      }
      if (hasCue) clashes.push('line_cue')
      if (hasAnchor) clashes.push('anchor')
      if (typeof hunk.context === 'string' && hunk.context.trim().length > 0) clashes.push('context')
      if (typeof hunk.handle === 'string' && hunk.handle.trim().length > 0) clashes.push('handle')
      for (const key of ['line', 'position', 'near']) {
        if (hunk[key] !== undefined && hunk[key] !== null) clashes.push(key)
      }
      if (oldText === null) {
        throw new PatchError(
          '`replace_all` needs `old`: the exact text to replace everywhere — nothing was written',
          'PATCH_REPLACE_ALL_CONFLICT',
        )
      }
      /**
       * 片段层会把 `old` 首尾的换行去掉（那是“按行引用”的约定）。对 `replace_all` 来说，
       * 这个静默归一很危险：`old:"a\n"` 会退化成在所有行里搜 `a`（`banana` 也中），
       * 而单处地址至少还有唯一性兜底。这里直接拒绝，让调用方去掉尾换行后重试。
       */
      if (/^\n|\n$/.test(oldText.replace(/\r\n/g, '\n'))) {
        throw new PatchError(
          '`replace_all` cannot take `old` with a leading or trailing newline: the region is addressed by its text, not by the line ending — drop that newline from `old` and retry (the file\'s own ending stays) — nothing was written',
          'PATCH_REPLACE_ALL_CONFLICT',
        )
      }
      if (clashes.length > 0) {
        throw new PatchError(
          `\`replace_all\` applies \`old\` to every occurrence, so it cannot be combined with ${clashes.join(', ')} (replace / expect / eol are fine); drop either replace_all or those fields — nothing was written`,
          'PATCH_REPLACE_ALL_CONFLICT',
        )
      }
    }
    /** 句柄的形状在这里判（不对就抛错）；`{handle, old}` 那一支的 `old` 仍然要命中区间内部。 */
    const parsedHandle = handleAddressOf(hunk)
    /** 结构地址：`handle` 优先（与 D7 同一口径）；句柄在场时不再看它。 */
    const structureAddress = parsedHandle === null ? structureAddressOf(hunk) : null
    /**
     * `line` / `position` 是**句柄形状的从属键**：只有和 `handle` 同时在场才成立。
     *
     * 为什么必须在这里拒绝（复核实测出来的一条真回归）：{@link lineRangeOf} 把 `source.line`
     * 当行区间读（那是历史写法），于是 `{line: 2, replace}` —— `lines` 最经典的那一次手误 ——
     * 会走 `lines` 那一档**成功**：一次我行我素的错误变成一次静默改到别处的编辑，
     * 正是本项目最忌的那一类。本仓本来就有只眼睛盯着它（`range-args-test` 段B
     * 「hunk 字段名写错（line 而非 lines）」），这里把那条判据钉在**引擎**里——
     * 每个入口各自兜住就是两份判据，而不止一个入口（数组形 / 平铺形 / CLI / MCP）。
     *
     * 码取 `PATCH_NO_ADDRESS`：它是"这个 hunk 一种地址都没成形"那一族，且**刻意不进**壳层的
     * 结果通道（参数没成形要大声抛错，与"地址对不上"是两件事）。
     */
    if (parsedHandle === null && structureAddress === null && hunk.line !== undefined && hunk.line !== null) {
      throw new PatchError(
        '`line` needs `handle` or `structure`: it addresses a row **inside** the region a handle/structure names — for an absolute line range use `lines` / `start_line`+`end_line`; nothing was written',
        'PATCH_NO_ADDRESS',
      )
    }
    if (parsedHandle === null && structureAddress === null && hunk.position !== undefined && hunk.position !== null) {
      throw new PatchError(
        '`position` needs `handle` or `structure`: it inserts at the edge of the region a handle/structure names — for an absolute line range use `lines` / `start_line`+`end_line`; nothing was written',
        'PATCH_NO_ADDRESS',
      )
    }
    if (oldText === null && parsedHandle === null && structureAddress === null && !hasTarget && range === undefined && !hasCue && !hasAnchor) {
      throw new PatchError(
        gaveLineAddress(hunk) ? LINE_ADDRESS_HINT : 'each hunk needs one of: old, target, lines, line_cue, anchor, handle, structure',
        'PATCH_NO_ADDRESS',
      )
    }
    let hits
    if (parsedHandle !== null) {
      /**
       * 句柄优先（D7）：它在场时 `target` / `lines` / `line_cue` / `anchor` **一律不决定位置**，
       * 坐标（含 `expect` 之外的地址字段）与句柄冲突时被让开的一方走 `tier` 披露。
       * 句柄是工具自己那份逐字节副本，拄的 `old` 正是不可信的那一半。
       */
      hits = [locateByHandle(lines, hunk, parsedHandle, handleCtx)]
    } else if (structureAddress !== null) {
      hits = [locateByStructure(lines, hunk, structureAddress, handleCtx)]
    } else if (oldText !== null) {
      /**
       * `old` 在场 ⇒ 走内容寻址，**其余地址字段一律不再决定位置**（坐标只用于核对与披露）。
       * 与 `target` 同时给时以 `old` 为准，同 {@link locateByOld} 的注释：
       * 一段可以被验证的原文，比一个可能来自旧视图的坐标/名字更接近“你想改的是这里”。
       */
      hits = replaceAll === true
        ? locateAllByOld(lines, hunk, oldText, filePath === null ? 'this file' : filePath, handleCtx)
        : [locateByOld(lines, hunk, oldText, filePath === null ? 'this file' : filePath, handleCtx)]
    } else {
      const request = {
        ...(hasTarget ? { target: hunk.target } : {}),
        ...(range === undefined ? {} : { lines: range }),
        ...(hunk.line_cue === undefined ? {} : { lineCue: hunk.line_cue }),
        ...(hasTarget || range !== undefined || hunk.line_cue !== undefined ? {} : { anchor: hunk.anchor }),
        ...(hunk.near === undefined ? {} : { near: hunk.near }),
        ...(hunk.expect === undefined || hunk.expect === null ? {} : { assert: hunk.expect }),
        ...(filePath === null ? {} : { filePath }),
        ...(options.allowLoneCr === true ? { allowLoneCr: true } : {}),
      }
      const found = locate(content, request)
      if (!found.ok) {
        throw new PatchError(found.message, found.code, {
          ...(found.candidates === undefined ? {} : { candidates: found.candidates }),
          /** `LOCATOR_LINE_SHARED` 的“被谁占了”证据（符号兄弟之外的 import/尾随语句）。 */
          ...(found.shared === undefined ? {} : { shared: found.shared }),
        })
      }
      /**
       * 锚点是整行地址：只引用行内一段时，`replace` 会把整行顶掉（见 {@link anchorIsPartialLine}）。
       * 在规划阶段拒绝，磁盘一个字节都不动；改用 `old` 才会只替换被引用的那段。
       * 条件里的 `!hasTarget && range === undefined && !hasCue` 就是 `request.anchor` 的成立条件——
       * 其余地址在场时锚点本来就不决定位置，不能拿它来判这次替换。
       */
      if (hasAnchor && !hasTarget && range === undefined && !hasCue && anchorIsPartialLine(hunk.anchor, found.actual)) {
        throw new PatchError(
          `\`anchor\` addresses whole lines, but this anchor matches only part of line ${found.startLine}: ` +
            `\`replace\` would overwrite the entire line and the rest of it would be lost. Nothing was written. ` +
            `Use \`old\` with the same text for an in-line replacement, or pass the complete line(s) as the anchor ` +
            `(or use \`lines\`). The line is: ${quoteForMessage(found.actual, found.startLine)}`,
          'PATCH_ANCHOR_FRAGMENT',
          { line: found.startLine, actual: found.actual },
        )
      }
      hits = [{
        startLine: found.startLine,
        endLine: found.endLine,
        tier: found.tier,
        actual: found.actual,
        ...(found.byNear === true ? { byNear: true } : {}),
      }]
    }
    for (const hit of hits) {
      const loc = {
        start: hit.startLine - 1,
        end: hit.endLine,
        line: hit.startLine,
        tier: hit.tier,
        byNear: hit.byNear === true,
        /**
         * 片段层：替换范围是**命中跨度**（`fragment.columns`）而不是整行——拼接层据此只换这一段。
         * 整行对齐层不带这个字段（它的跨度就是行首到行尾）。
         */
        ...(hit.fragment === undefined ? {} : { fragment: hit.fragment }),
        /**
         * 地址形态与调用方字面写法不符的**结构化**记录（`matches` 上；`applied` 不能加字段，见
         * `locateByOld`）：片段层的跨度比整行窄、坐标与落点不一致——两条都回指事实，
         * 让消费方能自己判断，而不必去解析 `tier` 里那句话。
         */
        ...(hit.fragmentNote === undefined ? {} : { fragmentNote: hit.fragmentNote }),
        /**
         * 句柄 hunk 多带一条：**句柄定下的整段区间**（坐标 + 字节）。
         *
         * 闸门拿它去和账本里那一段比对（{@link staleConflicts}）：句柄的凭据覆盖整个区间，
         * 而 `line: k` / `old` 只是区间**内部**的相对定位——比错了一方就会误报。
         */
        ...(hit.handleRegion === undefined ? {} : { handleRegion: hit.handleRegion }),
        ...(hit.coordinateNote === undefined
          ? {}
          : { coordinateNote: hit.coordinateNote, coordinateConflict: hit.coordinateConflict }),
      }
      const actual = hit.actual
      /**
       * `expect` 闸门 —— 判据本体是 {@link expectVerdict}（`locator-api.mjs`，**唯一一份**；C10）。
       *
       * 为什么只有**内容寻址**这一支在这里判：另一支（`locate` 的四层）已经在 `locate()` 的 `done()`
       * 里用同一个函数判过同一个区间了（`hunk.expect` 就是作为 `assert` 传下去的），再判一次是同一件事
       * 做两遍——每次都要全文件扫描一遍。两支合起来，一个 hunk 的 `expect` 恰好判一次，
       * 而判它的永远是同一份实现。
       *
       * 这里曾经是 `normSpace(actual) !== normSpace(hunk.expect)`：与 `locate()` 的"包含且唯一"是
       * **两份判据**，于是同一个 `expect` 在两条路径上判出两种结果——片段引文在 `locate()` 里通过，
       * 到这里必被拒（实测：`planHunks` 的三种 `lines` 写法全拒）。改后这里不再有任何比较：
       * 判据、阈值、候选清单形状都只在 `expectVerdict` 里，本函数只把结论翻成码。
       */
      /**
       * 句柄 hunk 也判 `expect`（只多不多）：句柄的摘要已经钉住了那段字节，而 `expect` 是调用方
       * 显式写的断言——两条都成立才放行。零宽度的边界插入（`position`）没有可断言的区间，跳过。
       */
      if ((oldText !== null || parsedHandle !== null) && actual.length > 0 && hunk.expect !== undefined && hunk.expect !== null) {
        const bad = expectVerdict(lines, loc.line, hit.endLine, actual, hunk.expect)
        if (bad !== null) throw expectGateError(bad, loc.line, hit.tier, actual)
      }
      const eol = adaptReplaceEol(hunk.replace ?? '', hunk.eol ?? 'auto', targetEolFor(endings, loc.line, hit.endLine))
      matches.push({ ...loc, hunk: hunkIndex, replace: eol.text, actual, ...(eol.adapted ? { eolAdapted: true } : {}) })
    }
  }
  matches.sort(
    (a, b) => a.start - b.start || (a.fragment?.columns[0] ?? 1) - (b.fragment?.columns[0] ?? 1),
  )
  for (let i = 1; i < matches.length; i += 1) {
    if (matchesOverlap(matches[i - 1], matches[i])) {
      throw new PatchError(
        `hunks overlap: line ${matches[i - 1].line} and line ${matches[i].line}`,
        'PATCH_OVERLAP',
      )
    }
  }
  let out = lines.slice()
  let outEndings = endings.slice()
  for (const m of [...matches].reverse()) {
    /**
     * 替换区域的拼接：
     *   · `replace` 内部的空行/行尾**照 replace 自己写**（段C：文件是 CRLF，replace 带 LF 就写 LF）；
     *   · 区域**末尾**的行尾继承被替换区域最后一行的行尾——这就是“只改被寻址的那一段”中
     *     “行尾不变”的那一半。
     *
     * 片段层（`m.fragment`）多一步：被替换的不是整行，而是行内的一段。这时把该行前缀接在
     * `replace` 第一行前、后缀接在最后一行后（C13）。代价是行内替换没有“行尾可继承”——
     * 行尾本来就不在被替换的那一段里，自然逐字不动。`replace` 为空时前后缀在同一条行上合拢，
     * 于是“删掉行内一段”不会凭空多出一个空行。
     */
    const rep = m.replace === '' ? { lines: [], endings: [] } : splitLinesWithEndings(m.replace)
    if (m.fragment !== undefined) {
      const firstLine = out[m.start]
      const [startCol, endCol] = m.fragment.columns
      const prefix = firstLine.slice(0, startCol - 1)
      /**
       * 跨行片段的后缀在**末行**，不在首行。旧代码从首行切 `line.slice(endCol)`，于是
       * `old: "START\nEND"` 替换后把末行 `END bb` 的 ` bb` 整段丢了——回执还写“只换了列 4-11”。
       * `endLineCol` 是 `fragmentSpans` 从原文量出的末行列号（0-based 排他）；单行时它等于 `endCol`。
       */
      const tail = out[m.end - 1].slice(m.fragment.endLineCol ?? endCol)
      const endsWithNewline = m.replace.endsWith('\n')
      const repLines = rep.lines.length > 1 && rep.lines[rep.lines.length - 1] === '' ? rep.lines.slice(0, -1) : rep.lines
      const parts =
        repLines.length === 0
          ? [`${prefix}${tail}`]
          : repLines.length === 1
            ? endsWithNewline
              ? [`${prefix}${repLines[0]}`, `${tail}`]
              : [`${prefix}${repLines[0]}${tail}`]
            : endsWithNewline
              ? [`${prefix}${repLines[0]}`, ...repLines.slice(1), `${tail}`]
              : [`${prefix}${repLines[0]}`, ...repLines.slice(1, -1), `${repLines[repLines.length - 1]}${tail}`]
      // 逻辑行数：replace 末尾的换行会把后缀顶到下一行（`old:'hello', replace:'A\n'` 是两行）。
      m.newLineCount = repLines.length === 0 ? 1 : repLines.length + (endsWithNewline ? 1 : 0)
      /**
       * 行尾：被替换跨度**末行**的行尾由原文继承；`parts` 里中间行用 replace 自己的行尾。
       * 跨行时必须是 `m.end - 1`（末行），用 `m.start` 会把首行的行尾错接到新末行上。
       */
      const partEndings = [...rep.endings.slice(0, parts.length - 1), outEndings[m.end - 1] ?? '']
      m.replacedText = rep.lines.join('\n')
      out = out.slice(0, m.start).concat(parts, out.slice(m.end))
      outEndings = outEndings.slice(0, m.start).concat(partEndings, outEndings.slice(m.end))
      continue
    }
    /**
     * 区域末行的行尾继承前一行；**插入在文件头**（`m.end === 0`）时前面没有行可继承，
     * 取后一行的行尾——否则插进去的那一行会与第 1 行粘成一行。
     * `m.end === 0` 只有零宽度的边界插入（`position: before` 且区间从第 1 行开始）能造出来：
     * 既有七种地址形状下 `m.end ≥ 1` 恒成立，所以这一改**动不到既有语义**。
     */
    /**
     * 在**无尾换行**的文件末尾插入（`position:'after'` 最后一行）：前一行 ending 是 `''`，
     * 直接拼会把 `c` 与 `d` 粘成 `cd`。补一个分隔行尾（沿用文件已有行尾），
     * 但插入块自己的末行仍保持原来的 `''`——不能凭空给文件加尾换行。
     */
    const insertionAtEof = rep.lines.length > 0 && m.start > 0 && m.end === m.start && (outEndings[m.start - 1] ?? '') === ''
    const tailEnding = insertionAtEof ? '' : (outEndings[m.end - 1] ?? outEndings[m.end] ?? '')
    if (insertionAtEof) outEndings[m.start - 1] = outEndings.find((ending) => ending !== '') ?? '\n'
    if (rep.lines.length > 0) {
      rep.endings[rep.endings.length - 1] = tailEnding
    }
    m.newLineCount = rep.lines.length
    out = out.slice(0, m.start).concat(rep.lines, out.slice(m.end))
    outEndings = outEndings.slice(0, m.start).concat(rep.endings, outEndings.slice(m.end))
  }
  /**
   * 改动后的坐标、行数变化与新句柄（0.8.1）：让调用方**不必回读**就能继续编辑。
   *
   * `applied[].line` 是**改前**坐标（契约，黄金集钉着）；`afterLine` / `afterEndLine` 是同一处
   * 在**改后**文件里的坐标。两者不能互相替代：一次多 hunk 调用里，高位 hunk 的改后行号取决于
   * 低位 hunk 增删了几行（`drift`），调用方手里只有改前文件，算不出来。
   *
   * `handle` 用改后内容现场铸一把：句柄只承诺“这段字节 + 这个区间”，不依赖读写两侧有共享状态；
   * 下一次 `edit` 直接拿它寻址即可。删除（`newLineCount === 0`）没有可指的区间，不铸柄。
   */
  let drift = 0
  /**
   * 终态文本的**逻辑行**视图。片段层的 `out` 里 prefix/tail 是两个数组项、合起来仍是一行，
   * 直接拿 `out.slice` 会多算行；以最终拼接文本为准，行号、回填文本与句柄三者同源。
   */
  const finalLines = joinLinesWithEndings(out, outEndings).split(/\r?\n/)
  for (const m of matches) {
    const oldCount = m.end - m.start
    const newCount = m.newLineCount ?? oldCount
    const afterLine = m.start + 1 + drift
    const afterEndLine = afterLine + newCount - 1
    m.afterLine = afterLine
    m.afterEndLine = afterEndLine
    m.delta = newCount - oldCount
    const regionText = newCount > 0 ? finalLines.slice(afterLine - 1, afterEndLine).join('\n') : ''
    if (m.fragment !== undefined) {
      m.after = regionText.length > RECEIPT_AFTER_CHARS ? `${regionText.slice(0, RECEIPT_AFTER_CHARS)}…` : regionText
      m.afterTruncated = regionText.length > RECEIPT_AFTER_CHARS
    }
    if (newCount > 0 && typeof handleCtx.ledgerKey === 'string' && handleCtx.ledgerKey.length > 0) {
      m.handle = mintHandle({
        ledgerKey: handleCtx.ledgerKey,
        regionText,
        byteOrderMark: handleCtx.byteOrderMark,
        startLine: afterLine,
        endLine: afterEndLine,
      })
    }
    drift += m.delta
  }
  /**
   * 逐条回执：**一条 hunk 一条记录，每条只描述它自己那条 hunk**；数组顺序 = 调用方的**输入顺序**。
   *
   * ## 顺序为什么是输入顺序
   *
   * 调用方给的是一个数组。`applied[k] ↔ 输入的第 k 条 hunk` 是唯一不需要任何换算的对应关系，
   * 而回执的全部用处就是让调用方逐条核对自己给的那几条 hunk。这里曾经是 `[...matches].reverse()`：
   * 那是**倒序拼接**（从文件尾往头改，行号才不会被自己改乱）的实现顺序泄漏进了回执 —— 数组按
   * 文档位置从后往前排，多目标逐项切分（{@link splitReceiptForMember}）也照那个倒序索引，
   * 于是调用方按输入顺序读回执会整批错位。
   *
   * ## `line` 用**改动前**的坐标（1-based）
   *
   * 契约就是它：红线套件 `single-target-nonregression-test` 的黄金集逐字节钉着 `line` 的取值，
   * 而那里的 `line` 一直是改前行号。它也是唯一一套调用方**自己算得出来**的坐标：改后的行号
   * 取决于同一次调用里**别的** hunk 增删了几行，而调用方手里只有改前那份文件。
   * 于是同一次调用的多条记录各自说的是“我落在改前文件的第几行”，互相之间可比、可核对。
   *
   * ## `replaced` = 这一条 hunk **自己写下去的文本**
   *
   * 不再从拼接结果里按 `m.start` 回读。`m.start` 是**改动前**的行下标，而 `out` 是全部 hunk
   * 拼完之后的结果 ⇒ 只要位置更低的那条 hunk 增删过行，高位这条就会读到**别的行**：实测
   * （把 `a2` 换成两行、把 `A6` 换成 `Y6`）回执给第 6 行报的 `replaced` 是 `a5`。真实语料里
   * 18,851 个落点中 5,555 个可观测、其中 1,268 个因此对不回调用方给的任何一条 hunk
   * （`probes/indent-loss-census.mjs` 的读数）—— 而“核对是不是改成了我要的样子”正是回执存在
   * 的理由，串了行的 `replaced` 恰好把这件事变成一次猜测。
   *
   * 口径 = `replace` 的**行文本**（{@link replaceTextOf}）：行尾是被替换区域继承的、不是调用方
   * 写的那一份，不进回执。片段层在拼接时记下的 `replacedText` 与此同式，这里沿用它，
   * 免得同一样东西出现第二份口径。
   */
  const applied = [...matches]
    .sort((a, b) => a.hunk - b.hunk)
    .map((m) => ({
      line: m.line,
      tier: m.tier,
      byNear: m.byNear === true,
      actual: m.actual,
      replaced: m.replacedText ?? replaceTextOf(m.replace),
      ...(m.afterLine === undefined ? {} : { afterLine: m.afterLine, afterEndLine: m.afterEndLine, delta: m.delta }),
      ...(m.after === undefined ? {} : { after: m.after, afterTruncated: m.afterTruncated === true }),
      ...(m.handle === undefined ? {} : { handle: m.handle }),
      ...(m.eolAdapted === true ? { eolAdapted: true } : {}),
    }))
  return { matches, content: joinLinesWithEndings(out, outEndings), applied }
}

/**
 * 这份文件开头有几个 UTF-8 BOM。
 *
 * 只能看字节：提供方的 `readText` 用 `new TextDecoder('utf-8', {fatal:true})` 解码，
 * `ignoreBOM` 默认 false ⇒ **第一个** BOM 不进字符串（后面的会以 U+FEFF 留在文本里）；
 * 回写用 TextEncoder，从不产 BOM。两者叠起来就是“任何一次编辑都永久丢掉 BOM”，没有信号——
 * 因此判据取原始字节（`readByteRange`；aura-read 里有一份同形的探测，两处都是胶水，判据只有一份）。
 *
 * 窗口按需翻倍：头部三个字节里没有 BOM ⇒ 0 个（一次读完）；正好是 BOM ⇒ 可能还有，
 * 把窗口加倍再读，直到“出现非 BOM”或“窗口没被填满”（读到文件尾）。
 * 不设固定上限，也就不会把三个 BOM 的文件静默当成两个；每次读都从 offset 0 开始，
 * 实际代价是 1～2 次几字节的读（只有文件确实以 BOM 开头时才会多读一次）。
 *
 * 测试 mock 可能没有字节接口：那时返回 0（没拿到字节，就没有 BOM 可保）。
 */
async function fileByteOrderMarkCount(fsService, target, signal) {
  if (typeof fsService.readByteRange !== 'function') return 0
  const width = BYTE_ORDER_MARK_BYTES.length
  let length = width
  for (;;) {
    const head = await fsService.readByteRange(target, { offset: 0, length }, signal)
    const count = countByteOrderMarks(head)
    if (count * width < head.length) return count
    const wider = length * 2
    if (head.length < length || wider === length) return count
    length = wider
  }
}

/**
 * 把文件原有的前导 BOM **个数**补齐到内容里（而不是指望提供方自己保留）。
 *
 * 补齐个数 = 字节里的个数 − 内容里已有的个数，只补不删：
 *   · `BOM+BOM` 的文件解码后文本里还留着一个 U+FEFF ⇒ 补 1 个（不是“已经有了就不加”）；
 *   · `replace` 自己把一个 U+FEFF 写进内容开头 ⇒ 那是调用方的显式意图，不删（同理于“replace 自带行尾”）。
 * 幂等因此来自**个数比较**，不来自“开头是不是 U+FEFF”这个布尔。
 */
function carryingByteOrderMarks(text, count) {
  const have = leadingByteOrderMarks(text)
  if (have >= count) return text
  return BYTE_ORDER_MARK.repeat(count - have) + text
}

/**
 * 回读窗口比“我以为写下的字节数”多读 1 字节。
 *
 * 不是经验值：窗口若正好等于意图长度，磁盘上多出来的尾部会被窗口**截断**，
 * 于是“写多了”这种最容易被忽略的改写会被比对成相等。多读 1 字节就能让它现形（长度不等）。
 */
const READBACK_PROBE_EXTRA_BYTES = 1
/** 行尾普查用的字节值：这两个在这里是**数据**，不是格式。 */
const CARRIAGE_RETURN = 0x0d
const LINE_FEED = 0x0a

/**
 * 提供方视角的文本 = `readText` 对同一份字节会返回的文本：解码时剥掉**恰好一个**前导 BOM
 * （`TextDecoder` 的 `ignoreBOM` 默认 false），其余 U+FEFF 原样留在文本里。
 *
 * 写后记账必须用它：存“我以为写下的内容”会在前导 BOM 上比真值多一个字符，
 * 于是下一次未断言编辑第 1 行被新鲜度闸门误拒——C13 打回项（两套内容约定）的同一族，
 * 只是这次的分歧出在 create 与 `replace` 自带 BOM 的那一侧（段F 钉住）。
 */
function providerView(text) {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text
}

/** 逐元素比对：返回第一个不同的下标，完全相同返回 -1（字符串与字节数组通用）。 */
function firstDifference(expected, actual) {
  const width = Math.min(expected.length, actual.length)
  for (let i = 0; i < width; i += 1) if (expected[i] !== actual[i]) return i
  return expected.length === actual.length ? -1 : width
}

/**
 * 行尾普查（按字节）。
 *
 * 为什么失败回执要带它：C10 的 BOM 丢失与 C12 的行尾归一化都是**外面拿探针量出来的**，
 * 而“两边不相等”这句话对模型毫无用处。crlf/lf/cr 三个数直接把
 * “提供方把整份行尾归一到多数派”这类改写点名出来。
 */
function lineEndingCensus(bytes) {
  const census = { crlf: 0, lf: 0, cr: 0 }
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === CARRIAGE_RETURN) {
      if (bytes[i + 1] === LINE_FEED) {
        census.crlf += 1
        i += 1
      } else census.cr += 1
    } else if (bytes[i] === LINE_FEED) census.lf += 1
  }
  return census
}

/**
 * 落盘后**回读校验**（C14）：把磁盘上的内容读回来，与“我以为写下的”逐字节比。
 *
 * 为什么取字节而不是解码文本：BOM 是**解码后彻底看不见**的改写（`readText` 剥掉一个前导 BOM），
 * 行尾在文本里虽仍可见、但“文本相等”远不等于“字节相等”。C10 与 C12 那两次踩过的坑
 * 恰好都落在字节层，而两次都是被外面的探针量出来的——这个函数就是那次探针。
 *
 * 粒度：**整份**，不抽样、不设大小阈值（窗口 = 意图字节数 + 1，见常量注释）。
 * 后端没有 `readByteRange` 时退化到文本级，回执里 `level: 'text'` 如实写明
 * “这次只比对了文本”（不把弱校验伪装成强校验）。
 *
 * 失败分两种，都抛 `WRITE_VERIFY_FAILED` 并**保留写入结果**（不回滚、也不假装成功）：
 *   · 读不回来（文件被删 / 不可读）⇒ `write_verify.readback_error` 带底层错误码；
 *   · 读回来了但对不上 ⇒ 带两边字节数、首个差异偏移、BOM 与行尾普查。
 *
 * @param service - 文件服务
 * @param target - 已写入的目标
 * @param written - 交给提供方的**内容**（它决定了落盘字节）
 * @param displayPath - 面向模型的路径
 * @returns {Promise<{level: string, bytes?: number, chars?: number}>} 验证证据
 */
async function verifyWriteBack(service, target, written, displayPath, signal) {
  const level = typeof service.readByteRange === 'function' ? 'bytes' : 'text'
  let expected
  let actual
  try {
    if (level === 'bytes') {
      /**
       * 期望字节由**提供方**回答（可选 `encodeFor`）：非 UTF-8 存储下，引擎不能假设
       * `TextEncoder` 就是落盘字节。没有这个方法的提供方（DSH 壳）仍走 UTF-8，行为不变。
       */
      expected = typeof service.encodeFor === 'function'
        ? Buffer.from(await service.encodeFor(target, written))
        : new TextEncoder().encode(written)
      actual = await service.readByteRange(
        target,
        { offset: 0, length: expected.length + READBACK_PROBE_EXTRA_BYTES },
        signal,
      )
    } else {
      expected = providerView(written)
      actual = await service.readText(target, signal)
    }
  } catch (error) {
    const readback = errorCodeOf(error)
    throw new PatchError(
      `cannot patch "${displayPath}": the write landed but could not be read back to verify it (${readback ?? 'unknown error'}) — the write was not rolled back; read the file to see what is actually there`,
      'WRITE_VERIFY_FAILED',
      { write_verify: { level, matches: false, readback_error: readback ?? null } },
    )
  }
  const offset = firstDifference(expected, actual)
  if (offset === -1) {
    return level === 'bytes' ? { level, bytes: expected.length } : { level, chars: expected.length }
  }
  throw verifyMismatchError(level, expected, actual, offset, displayPath)
}

/**
 * “读回来了但对不上”的错误：文本级只说字符数与首个差异，字节级再给 BOM 与行尾普查。
 *
 * 普查不是装饰：C10 的 BOM 丢失与 C12 的行尾归一化都是**外面拿探针量出来的**。
 * 把 crlf/lf/cr 与 BOM 有无写进错误里，模型（以及下一个读这份回执的人）不必再自己造探针。
 */
function verifyMismatchError(level, expected, actual, offset, displayPath) {
  if (level === 'text') {
    return new PatchError(
      `cannot patch "${displayPath}": the write landed but reading it back does not match what was written (expected ${expected.length} characters, found ${actual.length}; first difference at character ${offset}) — the write was not rolled back, so re-read the file before further edits`,
      'WRITE_VERIFY_FAILED',
      {
        write_verify: {
          level,
          matches: false,
          expected_chars: expected.length,
          actual_chars: actual.length,
          first_diff_offset: offset,
        },
      },
    )
  }
  const before = lineEndingCensus(expected)
  const after = lineEndingCensus(actual)
  const bomBefore = countByteOrderMarks(expected) > 0
  const bomAfter = countByteOrderMarks(actual) > 0
  return new PatchError(
    `cannot patch "${displayPath}": the write landed but reading it back does not match what was written (expected ${expected.length} bytes, found ${actual.length}; first difference at byte ${offset}; line endings expected crlf=${before.crlf}/lf=${before.lf}/cr=${before.cr}, found crlf=${after.crlf}/lf=${after.lf}/cr=${after.cr}; byte-order mark expected ${bomBefore ? 'present' : 'absent'}, found ${bomAfter ? 'present' : 'absent'}) — the filesystem provider stored something other than what was written; the write was not rolled back, so re-read the file before further edits`,
    'WRITE_VERIFY_FAILED',
    {
      write_verify: {
        level,
        matches: false,
        expected_bytes: expected.length,
        actual_bytes: actual.length,
        first_diff_offset: offset,
        expected_bom: bomBefore,
        actual_bom: bomAfter,
        expected_line_endings: before,
        actual_line_endings: after,
      },
    },
  )
}

/** 只读取第一层 code，避免展开 FsError 的 cause 链。 */
function errorCodeOf(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
}

/**
 * 严格新鲜度（0.10.3）：要求**当前这版内容**在本会话里被读过（或由本工具写过）。
 *
 * 这是内置 `Edit` / `Write` 的 read-before-write 规则，在 aura 里的对应物。默认只在
 * `aura_basetools_write` 的覆写路径开启；`aura_basetools_edit` 用 `require_observation` / `--require-observation`
 * 显式开启。判据不是“账本里有这个路径”，而是**账本里有这个版本**：
 *   · 从没读过 ⇒ `never-read`；
 *   · 读过但之后变了（内容令牌不同）⇒ `changed-since-read`。
 * 两种情况都拒绝，并让调用方先 `aura_basetools_read` 再重试——与区域级闸门（只看被寻址区域）不同，
 * 这里明确要求整份修订被看过。
 *
 * 写成功后 `finishEditPlan` 会把这版内容记进账本，因此“自己刚写的内容”可以直接继续写，
 * 不需要额外再读一次。
 *
 * @throws PatchError('PATCH_UNOBSERVED')
 */
export function requireObservedRevision({ displayPath, identityKey, content, byteOrderMark = false, allowBlindHint = false }) {
  const ledgerKey = ledgerIdentityKey(displayPath, identityKey)
  const observation = latestObservation(ledgerKey, { source: content })
  const currentToken = contentToken(content, byteOrderMark)
  if (observation !== null && observation.version === currentToken) return
  const changed = observation !== null
  /**
   * 回执里直接给**下一次调用**，而不是只说“先读”：实测 5 天内 22 次 PATCH_UNOBSERVED，
   * 每次都要模型自己挑读法（多半选 full，5k+ 字符）。这里按当前内容的体量挑一个装得下预算
   * 的模式；整份覆写还可以走已有的显式逃生口 `allow_unobserved`，把“读一遍再写”折成
   * “一次带标记的写”——代价（unverified_region）写在回执里，而不是藏在 schema 描述里。
   */
  const readHint = content.length <= 6000 ? 'full' : 'map'
  throw new PatchError(
    `cannot patch "${displayPath}": ${changed ? 'the file changed since your last read' : 'this file has not been read in this session'} — read it first (aura_basetools_read), then retry${changed ? ' against the current revision' : ''} — nothing was written` +
      `\nnext: aura_basetools_read { file_path: "${displayPath}", mode: "${readHint}" } — then retry` +
      (allowBlindHint
        ? `\n      or pass allow_unobserved: true if this is a deliberate whole-file overwrite; the receipt will be marked unverified_region`
        : ''),
    'PATCH_UNOBSERVED',
    {
      reason: changed ? 'changed-since-read' : 'never-read',
      ...(changed ? { observed_version: observation.version, current_version: currentToken } : {}),
    },
  )
}

/**
 * 一次完整写回：读 → BOM 计数 → 规划 → 陈旧闸门 → 逐字节写（CAS） → 回读校验 → 刷新观测。
 *
 * 这是**与框架无关的编排**：DSH 壳、独立 CLI、MCP 服务都走它，只有 provider 不同。
 * 与 DSH 壳那边唯一的差别是能力探测——那边后端可能没有 `writeText`（要退回 `editText`），
 * 而本机 provider 总是逐字节写，因此这里没有退化路径，也没有 `PATCH_NO_BYTE_EXACT_WRITE`。
 *
 * @param provider - 四方法契约，见本文件顶部注释
 * @param request - { displayPath, hunks, dryRun?, create?, signal?, identityKey?, requireObservation?,
 *   wholeFile?, eol?, skipStaleGate? }
 *   `identityKey` = **宿主给的身份键**（同一份盘上文件必给同一个串）：有它时账本记在它上面，
 *   而 `displayPath` 只管回执与诊断（模型看到的路径必须是它自己给的那个）；
 *   不给 ⇒ 与本参数存在之前**逐字节一致**（独立面 CLI/MCP 的那条路由磁盘存储自己做归一，见
 *   `aura-standalone/lib/observation-store.mjs` 的 `identityKey`）。
 *   `requireObservation` = 严格新鲜度（见 {@link requireObservedRevision}）；`create` 不受它约束。
 *   `wholeFile` = 整份替换（`aura_basetools_write` 覆写；与 `hunks` 互斥）：行区间**在本次读到的内容上**
 *   现算，避免“先读一次算总行数、规划时又读一次”的 TOCTOU 尾巴。
 *   `skipStaleGate` = 只允许与 `wholeFile` 同用：显式盲写逃生口（`allow_unobserved`）跳过区域闸。
 * @returns 回执字段（与 DSH 版同形：applied / dryRun / write_verify / unverified_region / operation）
 * @throws PatchError（PATCH_STALE_REGION / PATCH_UNOBSERVED / WRITE_VERIFY_FAILED / PATCH_NOT_FOUND …）
 */
/**
 * 漂移重定位（`--retry`）：地址过期时，用**旧观测里的那段原文**在当前内容里找回它。
 *
 * 判据就一条：整行精确匹配**全文唯一**。不看行号、不看相似度——行号已经不可信，
 * 相似度会把“改错了地方”卖成“改对了”。找不到 / 找到多处 ⇒ 该 hunk 原样留下，
 * 闸门照旧判它陈旧。纯函数（无 IO）：旧观测与当前内容都由调用方递进来。
 */
function rebaseHunks(hunks, observedSource, freshContent) {
  const oldLines = observedSource.split(/\r?\n/)
  const freshLines = freshContent.split(/\r?\n/)
  const rebased = []
  const out = []
  let changed = false
  for (const hunk of hunks) {
    if (hunk === null || typeof hunk !== 'object') {
      out.push(hunk)
      continue
    }
    // 句柄里的 `line`/`position` 是**段内相对地址**：换成绝对行号会把语义改掉。
    if (typeof hunk.line === 'number' || hunk.position !== undefined) {
      out.push(hunk)
      continue
    }
    let start
    let end
    try {
      const range = lineRangeOf(hunk)
      if (range !== undefined && range !== null) {
        start = range.start
        end = range.end
      }
    } catch {
      start = undefined
    }
    if (start === undefined && typeof hunk.handle === 'string') {
      const parsed = parseHandle(hunk.handle)
      if (parsed.ok === true) {
        start = parsed.startLine
        end = parsed.endLine
      }
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > oldLines.length) {
      out.push(hunk)
      continue
    }
    const span = end - start
    const oldText = oldLines.slice(start - 1, end).join('\n')
    if (oldText.length === 0) {
      out.push(hunk)
      continue
    }
    let hit = -1
    for (let i = 0; i + span < freshLines.length; i += 1) {
      if (freshLines[i] !== oldLines[start - 1]) continue
      if (freshLines.slice(i, i + span + 1).join('\n') !== oldText) continue
      if (hit !== -1) {
        hit = -2 // 多处命中 = 无法确定落点
        break
      }
      hit = i
    }
    if (hit < 0) {
      out.push(hunk)
      continue
    }
    const newStart = hit + 1
    if (newStart === start && hunk.handle === undefined) {
      out.push(hunk) // 没漂
      continue
    }
    const { handle: _handle, ...rest } = hunk
    out.push({ ...rest, lines: [newStart, newStart + span] })
    rebased.push({ from: [start, end], to: [newStart, newStart + span] })
    changed = true
  }
  return changed ? { hunks: out, rebased } : null
}

async function planEditToProvider(provider, request) {
  const { displayPath, hunks = [], dryRun = false, create, signal, wholeFile, eol, skipStaleGate } = request
  if (wholeFile !== undefined && typeof wholeFile !== 'string') {
    throw new PatchError('`wholeFile` must be a string', 'PATCH_BAD_WHOLE_FILE')
  }
  if (wholeFile !== undefined && hunks.length > 0) {
    throw new PatchError('`wholeFile` replaces the entire file and cannot be combined with `hunks`', 'PATCH_BAD_WHOLE_FILE')
  }
  if (skipStaleGate === true && wholeFile === undefined) {
    throw new PatchError('`skipStaleGate` is only valid together with `wholeFile`', 'PATCH_BAD_WHOLE_FILE')
  }
  /** 账本的键只算一次（{@link ledgerIdentityKey} 是全引擎唯一那道归一）。 */
  const ledgerKey = ledgerIdentityKey(displayPath, request.identityKey)
  const info = await provider.stat(displayPath, signal)

  // 语义与内置 `write` 对齐：`create` **只**在文件不存在时用。它撞上已存在的文件 = 调用方意图搞错了，
  // 必须明确报错——静默忽略它去跑一个"零改动成功"，最容易被误读成"文件已经建好了"。
  if (info !== undefined && typeof create === 'string') {
    throw new PatchError(`cannot create "${displayPath}": it already exists — pass hunks to change it`, 'PATCH_EXISTS')
  }
  if (info !== undefined && hunks.length === 0 && wholeFile === undefined) {
    throw new PatchError(`cannot patch "${displayPath}": no hunks — pass at least one, or use \`create\` for a new file`, 'PATCH_NO_HUNKS')
  }

  if (info === undefined) {
    if (typeof create !== 'string') {
      throw new PatchError(
        `cannot patch "${displayPath}": not found — to create it, pass \`create\` with the full file content`,
        'PATCH_NOT_FOUND',
      )
    }
    /**
     * 新建也要预检：新文件写下去就无从“回读原文”——JSON/Markdown 结构与 lone CR 在
     * 这里就能判。删除闸不适用（没有原文）。
     */
    const createdPreflight = preflightEdit({ displayPath, source: '', planned: create, basis: 'create' })
    if (createdPreflight.fatal.length > 0) {
      throw new PatchError(createdPreflight.fatal[0].message, createdPreflight.fatal[0].code, { preflight: { reasons: createdPreflight.fatal } })
    }
    return {
      kind: 'create',
      ledgerKey,
      displayPath,
      content: create,
      create: true,
      dryRun: dryRun === true,
      ...(createdPreflight.warnings.length === 0 ? {} : { preflight_warnings: createdPreflight.warnings }),
    }
  }

  const content = await provider.readText(displayPath, signal)
  const byteOrderMarks = await fileByteOrderMarkCount(provider, displayPath, signal)
  /**
   * 严格新鲜度排在规划之前：预演与真写拿到同一个判决（预演必须能预演出真写的拒绝）。
   * `create` 已在上面返回，不受这条约束——建新文件没有“读过”可言。
   */
  if (request.requireObservation === true) {
    requireObservedRevision({
      displayPath,
      ...(request.identityKey === undefined ? {} : { identityKey: request.identityKey }),
      content,
      byteOrderMark: byteOrderMarks > 0,
      // 只有整份覆写才有显式逃生口（`allow_unobserved`）；edit 的严格模式不提供它。
      allowBlindHint: typeof request.wholeFile === 'string',
    })
  }
  /**
   * 整份替换的行区间**在这里现算**：它必须与 `content` 是同一次读到的版本。
   * 旧实现由调用方先读一次算总行数、这里再读一次，两次之间文件变长就会只替换前缀、
   * 把旧尾巴留在盘上（`allow_unobserved` 下没有观测闸兜底，实测可复现）。
   */
  let planningHunks =
    wholeFile === undefined
      ? hunks
      : [{ lines: [1, content.split(/\r?\n/).length], replace: wholeFile, ...(typeof eol === 'string' ? { eol } : {}) }]
  /**
   * `--retry`：**计划之前**先用旧观测里的原文把地址重定位。
   * 重定位成功的 hunk 换成新行号；之后闸门直接跳过（“整行精确且全文唯一”比闸门的区域比对更硬）。
   */
  let rebased = null
  if (request.retry === true && wholeFile === undefined) {
    const observed = latestObservation(ledgerKey, { source: content })
    if (observed !== null && typeof observed.source === 'string') {
      const pass = rebaseHunks(planningHunks, observed.source, content)
      if (pass !== null) {
        planningHunks = pass.hunks
        rebased = pass.rebased
      }
    }
  }
  let planned
  try {
    /**
     * 句柄路要的**两个事实**在这里一并递下去：身份键（句柄里的身份标签拿同一口径算）
     * 与"这份文件有没有 BOM"（摘要的另一半）。两者与 {@link regionGate} 拿到的是同一对。
     */
    planned = planHunks(content, planningHunks, displayPath, {
      ...(request.identityKey === undefined ? {} : { identityKey: request.identityKey }),
      byteOrderMark: byteOrderMarks > 0,
      // wholeFile 是整份字节替换，不依赖行号模型；允许它越过 lone CR 的行地址闸。
      ...(wholeFile === undefined ? {} : { allowLoneCr: true }),
    })
  } catch (error) {
    /**
     * 第二条出路：这次编辑**已经落地**了 —— 判据与理由在 {@link alreadyAppliedHits} 那一段。
     *
     * 位置上必须是这里：`planHunks` 刚抛、**任何字节都还没写**、陈旧闸门也还没跑。于是
     * “这条路一个字节都不动磁盘”是**结构性**的（不是靠回滚），与旁边那条“`dry_run` 必须排在
     * 闸门之后”的教训同源：判决与它描述的事实，必须在同一个位置上成立。
     *
     * 只对 `PATCH_NOT_FOUND` 生效。`PATCH_AMBIGUOUS`（有多处都能对上）与断言不符是另外两态。
     * 走**结果通道**而不是抛错：调用的全部价值就是让调用方知道“这次不用改”，而抛出去的错误
     * 在框架那一层只剩 `error.message`（`dsh-tools/lib/index.js` 的 `errorMessage`），
     * `already_applied` 这份结构化字段根本到不了模型眼前。
     */
    if (errorCodeOf(error) !== 'PATCH_NOT_FOUND') throw error
    const hits = alreadyAppliedHits(content, planningHunks)
    if (hits === null) throw error
    return { kind: 'already_applied', ledgerKey, displayPath, hits, dryRun }
  }

  /**
   * 闸门：判据与收据都在 {@link regionGate}，三个调用方共用（不在壳里再写第二份）。
   *
   * BOM 这个事实**只能从字节取**：`content` 是 `readText` 的解码结果，前导 BOM 已被解码器吃掉，
   * 所以 `content.startsWith(BOM)` **恒为 false**。而账本里的令牌是 `contentToken(source, bom)`！
   * 错一个字就永远查不到——实测后果：所有 BOM 文件的编辑回执都被标成 `unverified_region: true`。
   *
   * ## 它必须排在 `dry_run` **之前**（一次真机实测的结论）
   *
   * `dryRun` 原先排在闸门之前直接 return，于是 `dry_run: true` 的回执说 "every hunk matched"，
   * 而同样的 hunks 真数落盘时闸门报 "the text you addressed moved" —— **预演没能预演出真正的判决**。
   * 一个只在写入路径上生效的闸门，配上一个说“没事”的预演，比没有预演更坏。
   */
  const gate =
    skipStaleGate === true
      ? { clean: true, basis: request.requireObservation === true ? 'observation' : 'none' }
      : rebased !== null
        ? { clean: true, basis: 'fresh' }
        : regionGate(planningHunks, content, planned, displayPath, {
            byteOrderMark: byteOrderMarks > 0,
            // 身份键往下传（有才传）：闸门按**同一个磁盘文件**记账，而回执与诊断里的路径仍是 displayPath。
            ...(request.identityKey === undefined ? {} : { identityKey: request.identityKey }),
          })
  if (!gate.clean) throw new PatchError(gate.message, 'PATCH_STALE_REGION', gate.extras)
  /**
   * 交付覆盖闸（1.0.2）：公开写面传 `requireDelivered:true`。位置与陈旧闸门同一条——
   * 规划之后、任何字节落盘之前，`dry_run` 之前。
   */
  if (request.requireDelivered === true && skipStaleGate !== true) {
    const unseen = coverageGate(planningHunks, planned, content, displayPath, {
      byteOrderMark: byteOrderMarks > 0,
      ...(request.identityKey === undefined ? {} : { identityKey: request.identityKey }),
    })
    if (unseen !== null) throw new PatchError(unseen.message, 'PATCH_UNSEEN_REGION', unseen.extras)
  }
  /**
   * 写前预检：在**计划内容**上跑本地不变量，任何字节落盘之前。
   *
   * 位置必须在 `dry_run` 之前（与陈旧闸门同一条理由）：预演要预演出真写的判决。
   */
  const finalContent = carryingByteOrderMarks(planned.content, byteOrderMarks)
  const preflight = preflightEdit({ displayPath, source: content, planned: finalContent, basis: gate.basis, wholeFile: wholeFile !== undefined })
  if (preflight.fatal.length > 0) {
    throw new PatchError(preflight.fatal[0].message, preflight.fatal[0].code, { preflight: { reasons: preflight.fatal } })
  }
  if (dryRun) {
    /**
     * 预演**不铸可复用句柄**：句柄指向“盘上那段字节”，而 dry-run 一个字节都没写；
     * 把它发出去，下一次拿它编辑必然 `PATCH_HANDLE_STALE`。afterLine/delta 仍然给，
     * 足以让调用方判断“会落到哪几行”；要句柄就真写（或写完再读）。
     */
    const applied = planned.applied.map(({ handle: _handle, ...rest }) => rest)
    return {
      kind: 'dry_run',
      ledgerKey,
      displayPath,
      applied,
      basis: gate.basis,
      dryRun: true,
      ...(rebased === null ? {} : { rebased }),
      ...(preflight.warnings.length === 0 ? {} : { preflight_warnings: preflight.warnings }),
    }
  }
  return {
    kind: 'patch',
    ledgerKey,
    displayPath,
    planned,
    applied: planned.applied,
    /**
     * 新内容：BOM 的**个数**只能从字节补（`content` 里那个前导 BOM 已被解码器吃掉）。
     * 计算位置与改前一致 —— 在 `dry_run` 那条早退之后（预演不做这份拼接）。
     */
    content: finalContent,
    version: info.version,
    basis: gate.basis,
    /**
     * 落地**之前**的原文。只有多目标在“整批失败”时才会把它放进回执
     * （契约 §3.4：已落地文件的原内容要留在回执里可核对）；单目标回执里没有这个字段。
     */
    original: content,
    dryRun: false,
    ...(rebased === null ? {} : { rebased }),
    ...(preflight.warnings.length === 0 ? {} : { preflight_warnings: preflight.warnings }),
  }
}

/**
 * 阶段二：**才写**（多目标契约 §3.2）—— 每个文件一次 temp+rename 原子提交。
 *
 * `already_applied` / `dry_run` 两种规划本来就不写：**零 provider 调用**地空转过去
 * （判据在阶段一已经拿全，这一阶段不重新判任何东西）。
 *
 * @returns 是否真的调了 `writeText`
 */
async function writeEditPlan(provider, request, plan) {
  if (plan.kind === 'create') {
    if (plan.dryRun === true) return false
    await provider.writeText(request.displayPath, plan.content, { kind: 'createIfAbsent' }, request.signal)
    return true
  }
  if (plan.kind === 'patch') {
    await provider.writeText(
      request.displayPath,
      plan.content,
      { kind: 'replaceIfVersion', version: plan.version },
      request.signal,
    )
    return true
  }
  return false
}

/**
 * 写完之后调用方手里确实拥有的行（1.0.2 的覆盖账）。
 *
 * 坐标取 `afterLine` / `afterEndLine`（**写后**坐标）：调用方写下去的正是那段文本，
 * 它当然见过；没被寻址的行不记——那些来自写之前那一版，行号可能已经漂了。
 * 整份替换与新建 ⇒ 整份（它的那一个 hunk 本来就覆盖全部行）。
 */
function writtenDeliveredRows(plan, view) {
  if (plan.kind === 'create') return formatRanges([[1, view.split(/\r?\n/).length]])
  const rows = []
  for (const applied of plan.applied ?? []) {
    const start = Number.isSafeInteger(applied.afterLine) ? applied.afterLine : applied.line
    const end = Number.isSafeInteger(applied.afterEndLine) ? applied.afterEndLine : start
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) continue
    rows.push([start, end])
  }
  return formatRanges(rows)
}

/**
 * 阶段三：**写后回读校验**（多目标契约 §3.3）—— 与今天同一条路径：
 * `verifyWriteBack` → 刷新观测账本 → 装配回执（`applied` / `write_verify` / `unverified_region`）。
 *
 * 回读失败**不回滚**（与今天单目标同一条：`WRITE_VERIFY_FAILED` 保留写入结果并如实报出）。
 */
async function finishEditPlan(provider, request, plan) {
  const { displayPath, signal } = request
  if (plan.kind === 'already_applied') {
    return {
      path: displayPath,
      /**
       * 结果里的第四态（另外三态见 DSH 壳的 `OUTCOMES`）。它**不**进 `applied`：
       * `applied` 的语义是“这次写下去的 hunk”，而这一态一个字节都没写 ——
       * 把它塞进 `applied`，会让“到底改成了没有”重新变成一次猜测。
       */
      outcome: 'already_applied',
      applied: [],
      already_applied: plan.hits,
      unchanged: true,
      dryRun: plan.dryRun,
    }
  }
  if (plan.kind === 'dry_run') {
    return {
      path: displayPath,
      applied: plan.applied,
      dryRun: true,
      // 预演也要如实说“这次没有可核对的基准”，否则它比不上真写诚实。
      ...(plan.basis === 'none' ? { unverified_region: true } : {}),
      ...(plan.rebased === undefined ? {} : { rebased: plan.rebased }),
      ...(plan.preflight_warnings === undefined ? {} : { preflight_warnings: plan.preflight_warnings }),
    }
  }
  /**
   * 预演的“新建”**不落盘**，也不能回读校验（盘上没有东西）。旧实现只把 `dryRun` 用在已有文件
   * 的路径上，`create + dry_run` 会真的建文件并把回执写成 `dryRun:false`——预演做了真事。
   */
  if (plan.kind === 'create' && plan.dryRun === true) {
    return {
      path: displayPath,
      operation: 'create',
      applied: [{ line: 1, tier: 'create', actual: '', replaced: plan.content }],
      dryRun: true,
      ...(plan.preflight_warnings === undefined ? {} : { preflight_warnings: plan.preflight_warnings }),
    }
  }
  const verification = await verifyWriteBack(provider, displayPath, plan.content, displayPath, signal)
  const view = providerView(plan.content)
  const byteOrderMark = plan.content.startsWith(BYTE_ORDER_MARK)
  const writtenToken = contentToken(view, byteOrderMark)
  rememberRead(plan.ledgerKey, writtenToken, view, byteOrderMark)
  /**
   * 写完之后调用方手里有什么：**它自己写下去的那几段**。整份覆写与新建 ⇒ 整份。
   *
   * 不把"没动过的行"也记成交付：那些行的内容来自写之前的那一版，行号可能已经漂了。
   * 记多了就等于把覆盖闸关掉，记少了最坏只是多读一次。
   */
  rememberDeliveredRows(plan.ledgerKey, writtenToken, writtenDeliveredRows(plan, view))
  /**
   * 写后结构状态：只在此刻能判的格式上给结论（JSON / Markdown）；**只在坏的时候出现**，
   * 保持既有成功回执逐字节不变（黄金集靠这条）。
   */
  const structure = structureOf(plan.content, displayPath)
  const structureField = structure.ok === false ? { structure: { kind: structure.kind, ok: false, ...(structure.error === undefined ? {} : { error: structure.error }), ...(structure.fences === undefined ? {} : { fences: structure.fences }) } } : {}
  if (plan.kind === 'create') {
    return {
      path: displayPath,
      operation: 'create',
      applied: [{ line: 1, tier: 'create', actual: '', replaced: plan.content }],
      dryRun: false,
      write_verify: verification,
      ...structureField,
      ...(plan.preflight_warnings === undefined ? {} : { preflight_warnings: plan.preflight_warnings }),
    }
  }
  return {
    path: displayPath,
    applied: plan.applied,
    dryRun: false,
    ...(plan.rebased === undefined ? {} : { rebased: plan.rebased }),
    write_verify: verification,
    // 没有基准时如实标注。调用方（CLI/MCP/DSH 壳）都把它透进回执：
    // "没核对过"与"核对过且没变"必须是两句话，否则回执在撒谎。
    ...(plan.basis === 'none' ? { unverified_region: true } : {}),
    ...structureField,
    ...(plan.preflight_warnings === undefined ? {} : { preflight_warnings: plan.preflight_warnings }),
  }
}

export async function applyEditToProvider(provider, request) {
  const plan = await planEditToProvider(provider, request)
  await writeEditPlan(provider, request, plan)
  return finishEditPlan(provider, request, plan)
}

/**
 * 多目标写侧的并发池大小（契约 §4）：跨文件提交 / 读盘最多 8 个在飞。
 *
 * 这个数**不是本地真值**，而是参数面 `args.mjs` 那一份的转发（与 `MT_MAX_TARGETS` 同一条纪律）：
 * 这里与读侧 `read-core.mjs` 曾各写一句 `export const MT_POOL = 8`，两份活真值恰好同值，
 * 于是两边套件同时绿、把缝盖住了。取值只有一个来源：上面的 `import` 建本地绑定供下面三处
 * `mtPool(MT_POOL, …)` 用，再用 `export { MT_POOL }` 把这个**同一绑定**转出去
 * （**不是** `export … from`：那种写法不建本地绑定，本文件自己那三处会当场 `ReferenceError`）。
 * 导出名与取值逐字未变（`multi-edit-test.mjs` 从这里取 `MT_POOL`）。
 */
export { MT_POOL }

/**
 * 多目标逐项回执里带“落地前原文”的上限（契约 §3.4 与 §5 一起读：**要能核对**，也**不许撑爆回执**）。
 * 超了就截断并在同一项里标 `original_truncated`，不静默少给。
 */
const MT_ORIGINAL_CHARS = 4000

/**
 * 错误码 → **下一步怎么走**（多目标回执每项的 `next`）。
 * 一句话、可执行：模型拿到的若是“失败了”，它下一轮只能是猜。
 */
const MT_NEXT = {
  PATCH_NOT_FOUND: 're-read the file, then address the hunk again — the text you quoted is not in it',
  PATCH_AMBIGUOUS: 'quote more of the surrounding text so the address picks exactly one place',
  PATCH_STALE_REGION: 're-read the region first — the lines you addressed have moved',
  PATCH_UNSEEN_REGION: 'read the lines you were never given (mode=lines over the reported range), then retry',
  PATCH_OVERLAP: 'merge the overlapping hunks into one',
  PATCH_NO_ADDRESS: 'give each hunk one of: old, target, lines, line_cue, anchor, handle',
  PATCH_NO_HUNKS: 'pass at least one hunk, or use `create` for a new file',
  PATCH_EXISTS: 'the file already exists — address it with hunks instead of `create`',
  PATCH_HANDLE_STALE: 're-read that region and use the handle from that read',
  MT_CREATE_MERGE: 'give that file a single target (or, if it exists, address it with hunks)',
  WRITE_VERIFY_FAILED: 're-read the file before further edits — the write was not rolled back',
}

const nextForCode = (code) => MT_NEXT[code] ?? 're-read the file, then retry that target'

/** 错误码 → 汇总行里的短名（`PATCH_NOT_FOUND` ⇒ `not_found`，契约 §5 那个例子就是这个口径）。 */
const outcomeLabelOf = (code) =>
  String(code ?? 'error')
    .replace(/^(PATCH|WRITE|READ|ARGS)_/, '')
    .toLowerCase()

/**
 * 并发池（契约 §4 唯一允许的形式）：只跑 async 的 `provider.*` 与纯计算，
 * **不 import 任何 `node:` 内置**（打包守卫盯着这一条），也不用 worker_threads。
 *
 * 结果一律由 worker 自己写进**预分配的下标槽**，所以`Promise.all` 之后装配顺序
 * 恒等于输入顺序 —— 完成顺序不外泄（契约 §1.4）。worker 自己吞异常，一个失败不会拆掉整条流水线。
 */
async function mtPool(size, workers) {
  let next = 0
  const lane = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= workers.length) return
      await workers[index]()
    }
  }
  const lanes = []
  for (let i = 0; i < Math.min(size, workers.length); i += 1) lanes.push(lane())
  await Promise.all(lanes)
}

/**
 * 参数面的目标元素 → **单目标入口那次调用**的请求。
 *
 * 顶层 `identityKey` / `dryRun` / `signal` 是整批的默认值，元素自己给了就听元素的
 * （与“显式给的压过默认”同一口径）。
 */
function singleRequestFrom(item, request) {
  const out = { displayPath: item.displayPath, hunks: item.hunks === undefined ? [] : item.hunks }
  if (item.create !== undefined) out.create = item.create
  const identityKey = item.identityKey === undefined ? request?.identityKey : item.identityKey
  if (identityKey !== undefined) out.identityKey = identityKey
  const dryRun = item.dryRun === undefined ? request?.dryRun : item.dryRun
  if (dryRun !== undefined) out.dryRun = dryRun
  /** 严格新鲜度是整批的默认值；元素自己给了就听元素的（与 `dryRun` 同一口径）。 */
  const requireObservation = item.requireObservation === undefined ? request?.requireObservation : item.requireObservation
  if (requireObservation !== undefined) out.requireObservation = requireObservation
  /** 交付覆盖闸同理：整批默认、元素可覆盖。 */
  const requireDelivered = item.requireDelivered === undefined ? request?.requireDelivered : item.requireDelivered
  if (requireDelivered !== undefined) out.requireDelivered = requireDelivered
  // 漂移重定位是整批的默认值；元素自己给了就听元素的（与上面两条同一口径）。
  const retry = item.retry === undefined ? request?.retry : item.retry
  if (retry !== undefined) out.retry = retry
  if (request?.signal !== undefined) out.signal = request.signal
  return out
}

/**
 * 按**文件**分组（契约 §1.6 同文件单写者）。
 *
 * 分组的键是 {@link ledgerIdentityKey} —— 账本、句柄、陈旧闸门用的都是它；
 * 这里若另用一份“路径相等”的判据，就会出现“账本认为是同一个文件、而分组认为是两个”
 * 那种两边都自洽、合起来错的形状。顺序 = 各文件**首次出现**的输入顺序。
 */
function groupItemsByFile(items, request) {
  const groups = []
  const byKey = new Map()
  for (const item of items) {
    const key = ledgerIdentityKey(item.displayPath, item.identityKey ?? request?.identityKey)
    let group = byKey.get(key)
    if (group === undefined) {
      group = { index: groups.length, key, displayPath: item.displayPath, members: [], plan: null }
      byKey.set(key, group)
      groups.push(group)
    }
    item.group = group
    item.hunkOffset = group.members.reduce((sum, m) => sum + (Array.isArray(m.hunks) ? m.hunks.length : 0), 0)
    group.members.push(item)
  }
  for (const group of groups) {
    for (const member of group.members) {
      member.hunkCount = Array.isArray(member.hunks) ? member.hunks.length : 0
      member.group = group
    }
  }
  return groups
}

/**
 * 一个分组的**请求**：同一文件多个目标 ⇒ hunks 合并成一次规划、一次提交（契约 §1.6）。
 *
 * 合并就是把各目标的 hunks 按输入顺序接起来交给**同一个** `planHunks` —— 于是
 * 校验、重叠判定、陈旧闸门都对**并起来的那一批**生效一次，而不是各判各的。
 *
 * `create` 是唯一不能合并的东西：它写的是一整份文件，两个 `create` 没有“并起来”的定义，
 * 因此在这里明确拒绝（阶段一抛 ⇒ 零写入），而不是挑一个执行。
 */
function groupRequest(group, request) {
  const first = group.members[0]
  if (group.members.length > 1 && group.members.some((m) => typeof m.create === 'string')) {
    throw new PatchError(
      `cannot patch "${group.displayPath}": ${group.members.length} targets in this call name the same file and one of them uses \`create\` — \`create\` writes a whole file, so two targets cannot be merged into one commit; give that file a single target; nothing was written`,
      'MT_CREATE_MERGE',
    )
  }
  const hunks =
    group.members.length === 1
      ? first.hunks === undefined
        ? []
        : first.hunks
      : group.members.flatMap((m) => (Array.isArray(m.hunks) ? m.hunks : []))
  return singleRequestFrom(
    {
      displayPath: group.displayPath,
      hunks,
      create: first.create,
      identityKey: first.identityKey,
      dryRun: first.dryRun,
      /**
       * 同文件合并时把元素级 `requireObservation` 一并带过去：否则它只对“单独一个目标”
       * 那条路生效，多个目标命中同一文件时被静默丢掉。任一成员要求严格 ⇒ 整组严格（安全方向）。
       */
      ...(group.members.some((member) =>
        member.requireObservation === undefined ? request?.requireObservation === true : member.requireObservation === true,
      )
        ? { requireObservation: true }
        : {}),
      /** 覆盖闸同理：任一成员要求严格 ⇒ 整组严格。 */
      ...(group.members.some((member) =>
        member.requireDelivered === undefined ? request?.requireDelivered === true : member.requireDelivered === true,
      )
        ? { requireDelivered: true }
        : {}),
    },
    request,
  )
}

/** 回执是哪一态（`applied` / `created` / `already_applied` / `dry_run`）—— 汇总行与 `landed` 都用它。 */
function receiptKindOf(receipt) {
  // 预演优先：`create + dry_run` 的 operation 仍是 create，但盘上一个字节都没写。
  if (receipt.dryRun === true) return 'dry_run'
  if (receipt.operation === 'create') return 'created'
  if (receipt.outcome === 'already_applied') return 'already_applied'
  return 'applied'
}

const inMember = (item, hunkIndex) => hunkIndex >= item.hunkOffset && hunkIndex < item.hunkOffset + item.hunkCount

/**
 * 合并提交**一次**，但逐项回执要对上各自那些 hunk（契约 §5）：按 hunk 下标切回来。
 *
 * `applied[i]` 描述的是**输入的第 i 条 hunk**（`planHunks` 按 `hunk` 下标排），切分就用同一把尺子：
 * `matches` 是按**位置**排的，先按 `hunk` 还原成输入顺序，再逐格对齐。切完**不重排**，各项内部顺序
 * 与单目标那次一模一样。单目标分组（只有一个成员）直接返回**同一个对象**——逐字节相同因此是
 * 结构性的，不是比对出来的。
 */
function splitReceiptForMember(receipt, group, item) {
  if (group.members.length === 1) return receipt
  if (receipt.outcome === 'already_applied') {
    return { ...receipt, already_applied: receipt.already_applied.filter((hit) => inMember(item, hit.hunk)) }
  }
  const matches = group.plan?.planned?.matches ?? []
  const byHunk = [...matches].sort((a, b) => a.hunk - b.hunk)
  const applied = receipt.applied ?? []
  const mine = []
  for (let i = 0; i < applied.length; i += 1) {
    const match = byHunk[i]
    if (match !== undefined && inMember(item, match.hunk)) mine.push(applied[i])
  }
  return mine.length === applied.length ? receipt : { ...receipt, applied: mine }
}

/** 逐项回执的一条：`receipt` 就是单目标回执本体（壳层用同一套渲染）。 */
function receiptItem(item, receipt, group) {
  const outcome = receiptKindOf(receipt)
  return {
    index: item.index,
    file_path: item.displayPath,
    outcome,
    landed: outcome === 'applied' || outcome === 'created',
    receipt: splitReceiptForMember(receipt, group, item),
  }
}

/** 逐项回执的一条（失败）：哪一项、什么码、`next` 怎么走（契约 §3.4）。 */
function failureItem(item, error, stage, landed, extra = {}) {
  const code = errorCodeOf(error) ?? 'ERROR'
  const shared = item.group !== undefined && item.group.members.length > 1
    ? { shared_with: item.group.members.filter((m) => m !== item).map((m) => m.index) }
    : {}
  return {
    index: item.index,
    file_path: item.displayPath,
    outcome: 'failed',
    landed,
    stage,
    error: { code, message: error?.message ?? String(error), next: nextForCode(code) },
    ...shared,
    ...extra,
  }
}

/** 已落地文件的原内容（截断到 {@link MT_ORIGINAL_CHARS}，并在同一项里标明截断）。 */
function originalEvidence(group) {
  const text = typeof group?.plan?.original === 'string' ? group.plan.original : null
  if (text === null) return {}
  if (text.length <= MT_ORIGINAL_CHARS) return { original: text, original_chars: text.length }
  return { original: text.slice(0, MT_ORIGINAL_CHARS), original_chars: text.length, original_truncated: true }
}

/** 规划结果在“本轮没写”的那一项里怎么称呼（不假装已经落地）。 */
const planKindOf = (plan) => (plan === null || plan === undefined ? 'none' : plan.kind)

/**
 * 多目标回执的**信封**：逐项 + 一行汇总（契约 §5）。
 *
 * 汇总行**只在这里**成形 —— 壳层把它放在正文 body 的末尾，不在别处另塞一份
 * （正文是宿主剪枝器量的东西）。逐项里的 `receipt` 是单目标回执本体，一个字都不加。
 */
function mtEnvelope(edits, meta = {}) {
  const counts = new Map()
  let applied = 0
  let landed = 0
  for (const edit of edits) {
    const key = edit.outcome === 'failed' ? outcomeLabelOf(edit.error?.code) : edit.outcome
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (edit.outcome === 'applied' || edit.outcome === 'created') applied += 1
    if (edit.landed === true) landed += 1
  }
  const parts = [`targets: ${edits.length}`, `applied ${applied}`]
  for (const key of ['created', 'already_applied', 'dry_run', 'not_applied']) {
    if (counts.has(key)) parts.push(`${key} ${counts.get(key)}`)
  }
  const failures = [...counts.keys()].filter((key) => key !== 'applied' && !['created', 'already_applied', 'dry_run', 'not_applied'].includes(key))
  failures.sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : a > b ? 1 : 0))
  for (const key of failures) parts.push(`${key} ${counts.get(key)}`)
  // 同一文件出现过多次时会合并提交：`files` 只在真的合并过时才出现（读回执的人据此知道写了几次）。
  if (meta.groups !== undefined && meta.groups !== edits.length) parts.push(`files ${meta.groups}`)
  const paths = (flag) => [...new Set(edits.filter((edit) => edit.landed === flag).map((edit) => edit.file_path))]
  if (landed === 0) parts.push('no files were changed')
  else if (landed !== edits.length) parts.push(`landed ${landed} ｜ not_landed ${edits.length - landed}`)
  return {
    targets: edits.length,
    applied,
    // 整批都是预演时才把顶层的 dryRun 置 true；混有真写时不能声称“什么都没写”。
    dryRun: edits.every((edit) => edit.receipt?.dryRun === true),
    summary: parts.join(' ｜ '),
    unchanged: landed === 0,
    landed_paths: paths(true),
    ...(landed === edits.length ? {} : { not_landed_paths: paths(false) }),
    ...(meta.aborted === undefined ? {} : { aborted: meta.aborted }),
    ...(meta.partial === true ? { partial: true } : {}),
    edits,
  }
}

/**
 * 事务回滚之后，把**已经装配好的批回执**改写成最终磁盘状态。
 *
 * `applyEditsToProvider` 只负责写；事务层（CLI/MCP）在 `ok:false` 时回滚已落地的文件。
 * 旧版把回滚前的批回执原样返回，于是 `landed_paths` / `applied` / `summary` 仍说“改成了”，
 * 而盘上已经恢复原文——回执与磁盘相反，是比失败更坏的形态。
 *
 * 判据：
 *   · `rollback.status === 'rolled_back'` 且确实有文件落地过 ⇒ 逐项改成 `rolled_back`、
 *     `landed:false`、`applied:0`、`landed_paths:[]`、`unchanged:true`，并由 `mtEnvelope`
 *     重算汇总行（不再出现 `applied 1` / `landed 1`）。
 *   · 回滚有冲突（`recovery_required`）⇒ **不谎称**已全部恢复：保留逐项 landed，标
 *     `recovery_required:true`，把冲突原样交给调用方。
 *   · 根本没落地过（规划阶段失败）⇒ 保留原回执，只附 `rollback` 事实。
 *
 * @param batch - 引擎刚返回的批回执（含 `edits`）
 * @param rollback - `tx.rollback()` 的返回值
 * @returns 新回执；`ok` 由调用方（事务层）决定，这里不伪造成功
 */
export function rebuildAfterRollback(batch, rollback) {
  const edits = Array.isArray(batch?.edits) ? batch.edits : []
  const hadLanded = edits.some((edit) => edit.landed === true)
  if (!hadLanded || rollback?.status !== 'rolled_back') {
    return {
      ...batch,
      rollback,
      ...(rollback?.status === 'recovery_required' ? { recovery_required: true } : {}),
    }
  }
  const finalEdits = edits.map((edit) => {
    if (edit.landed !== true) return { ...edit, landed: false }
    return {
      ...edit,
      outcome: 'rolled_back',
      landed: false,
      rolled_back: true,
      note: 'written, then rolled back — the file is back to its pre-call content',
      // 旧的 receipt 描述的是“写下去的内容”；回滚后它不再等于磁盘，不能原样留着。
      receipt: {
        path: edit.file_path,
        applied: [],
        dryRun: false,
        rolled_back: true,
      },
    }
  })
  return {
    ...mtEnvelope(finalEdits, { aborted: 'rollback' }),
    rolled_back: true,
    rollback,
  }
}

/**
 * 多目标写侧的**唯一入口**（fs-contract-v2 / MT3；形状见契约 §2.2，提交语义见 §3）。
 *
 * 与单目标入口的分工是结构性的，不是约定：
 *   · `N === 1` ⇒ **直调** {@link applyEditToProvider}，零池、零包装、零额外 provider 调用；
 *     单目标那条路因此**跑不到**本文件里任何一段并发代码。
 *   · `N > 1`  ⇒ 阶段一（只读规划，按文件合并）→ 阶段二（逐文件原子提交，并发池）→
 *     阶段三（逐文件回读校验，与今天同一条路径）。
 *
 * 失败语义（契约 §3.4）：**阶段一任一目标失败 ⇒ 零写入**，逐项报（哪一项、什么码、`next`），
 * 汇总行明说 `no files were changed`；阶段二/三中途失败 ⇒ 逐项标 `landed`，已落地那几项
 * 带上落地前原文（截断）可核对，汇总行给出 `landed` / `not_landed` 计数。**不做 `partial` 开关。**
 *
 * @param provider - 四方法契约（同单目标）
 * @param request - `{ targets: [{file_path, hunks, create?, identityKey?, dryRun?}], dryRun?, identityKey?, signal? }`
 * @returns `{targets, applied, summary, unchanged, landed_paths, edits:[{index, file_path, outcome, landed, receipt|error}]}`
 * @throws PatchError / Error（参数形状没成形：`ARGS_TARGETS_SHAPE` / `ARGS_TARGETS_LIMIT` / `ARGS_SHAPE_EXCLUSIVE`）
 */
export async function applyEditsToProvider(provider, request) {
  const targets = assertEditTargets(request, { toolName: 'applyEditsToProvider' })
  if (targets === undefined) {
    throw Object.assign(
      new Error(
        'applyEditsToProvider needs `targets: [{ file_path, hunks }, ...]` — the single-target shape (`file_path` + `hunks`) belongs to the single-target entry; nothing was written',
      ),
      { code: 'ARGS_TARGETS_SHAPE' },
    )
  }
  const items = editTargetRequests(targets)
  if (items.length === 1) {
    const receipt = await applyEditToProvider(provider, singleRequestFrom(items[0], request))
    const group = { index: 0, displayPath: items[0].displayPath, members: [items[0]], plan: null }
    items[0].group = group
    items[0].hunkOffset = 0
    items[0].hunkCount = Array.isArray(items[0].hunks) ? items[0].hunks.length : 0
    return mtEnvelope([receiptItem(items[0], receipt, group)], { groups: 1 })
  }

  const groups = groupItemsByFile(items, request)

  /** 阶段一（只读）：每个文件完整规划 + 校验；一个字节都不写。并发只在读盘与纯计算里。 */
  const planFailed = new Array(groups.length).fill(null)
  await mtPool(
    MT_POOL,
    groups.map((group, index) => async () => {
      try {
        group.plan = await planEditToProvider(provider, groupRequest(group, request))
      } catch (error) {
        planFailed[index] = error
      }
    }),
  )
  if (planFailed.some((error) => error !== null)) {
    const edits = items.map((item) => {
      const failure = planFailed[item.group.index]
      if (failure !== null) return failureItem(item, failure, 'plan', false)
      return {
        index: item.index,
        file_path: item.displayPath,
        outcome: 'not_applied',
        landed: false,
        planned: planKindOf(item.group.plan),
        note: 'not written: another target in this call failed to plan, and this call writes either all of its targets or none',
      }
    })
    return mtEnvelope(edits, { groups: groups.length, aborted: 'plan' })
  }

  /** 阶段二（才写）：逐文件提交。同文件已经合并成一个分组 ⇒ 每个分组恰好一次写事务。 */
  const writeFailed = new Array(groups.length).fill(null)
  await mtPool(
    MT_POOL,
    groups.map((group, index) => async () => {
      try {
        await writeEditPlan(provider, groupRequest(group, request), group.plan)
      } catch (error) {
        writeFailed[index] = error
      }
    }),
  )

  /** 阶段三（回读校验）：只对写到这一步为止没报错的文件跑，走的是与今天同一条路径。 */
  const verified = new Array(groups.length).fill(null)
  const verifyFailed = new Array(groups.length).fill(null)
  await mtPool(
    MT_POOL,
    groups.map((group, index) => async () => {
      if (writeFailed[index] !== null) return
      try {
        verified[index] = await finishEditPlan(provider, groupRequest(group, request), group.plan)
      } catch (error) {
        verifyFailed[index] = error
      }
    }),
  )

  const partial = writeFailed.some((error) => error !== null) || verifyFailed.some((error) => error !== null)
  const edits = items.map((item) => {
    const index = item.group.index
    if (writeFailed[index] !== null) {
      return failureItem(item, writeFailed[index], 'write', false, originalEvidence(item.group))
    }
    if (verifyFailed[index] !== null) {
      return failureItem(item, verifyFailed[index], 'verify', true, originalEvidence(item.group))
    }
    const edit = receiptItem(item, verified[index], item.group)
    // 批次没全成 ⇒ 已落地的那几项带上落地前原文，让调用方能核对磁盘上现在是什么（契约 §3.4）。
    return partial && edit.landed === true ? { ...edit, ...originalEvidence(item.group) } : edit
  })
  return mtEnvelope(edits, { groups: groups.length, partial })
}

export {
  PatchError,
  // 多目标的参数面上限由 `args.mjs` 拥有（唯一一份判据）；这里转出去，是为了壳层能从写侧一处拿全。
  MT_MAX_TARGETS,
  splitLinesWithEndings,
  hasMixedLineEndings,
  // 闸门三件套：判据 / 收据 / 决策。DSH 壳只调最后一个，CLI 走 `applyEditToProvider`。
  regionGate,
  staleConflicts,
  staleRegionRefusal,
  regionTextIn,
  joinLinesWithEndings,
  fileByteOrderMarkCount,
  carryingByteOrderMarks,
  READBACK_PROBE_EXTRA_BYTES,
  CARRIAGE_RETURN,
  LINE_FEED,
  providerView,
  firstDifference,
  lineEndingCensus,
  verifyWriteBack,
  verifyMismatchError,
  errorCodeOf,
}
