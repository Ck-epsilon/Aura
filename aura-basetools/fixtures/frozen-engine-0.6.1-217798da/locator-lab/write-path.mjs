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
import { locate } from './locator-api.mjs'
import { LINE_ADDRESS_HINT, gaveLineAddress, lineRangeOf } from './args.mjs'
import {
  BYTE_ORDER_MARK,
  BYTE_ORDER_MARK_BYTES,
  contentToken,
  countByteOrderMarks,
  hasObservedVersion,
  latestObservation,
  leadingByteOrderMarks,
  rememberRead,
} from './read-core.mjs'


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
  // 当前内容的版本令牌：用与 `rememberRead` **同一把尺子**（提供方视角文本 + BOM），
  // 否则账本查询会因“两套约定”而永远查不到（`rememberRead` 的注释里记着同一个坑）。
  const currentToken = () => contentToken(providerView(content), revision.byteOrderMark === true)
  const conflicts = []
  for (const match of matches) {
    const hunk = hunks[match.hunk]
    if (hunk === undefined) continue
    // 带了 `expect` 的 hunk 不走这里：它自己的断言就是闸门（且报错里会贴出原文）。
    if (hunk.expect !== undefined && hunk.expect !== null) continue
    const observed = regionTextIn(observedSource, hunk, filePath)
    if (observed === null) {
      // 观测里根本没有这块区域（当时行数更少 / 地址当时就无效）⇒ 坐标无从核对。
      conflicts.push({ lines: [match.line, match.end], tier: match.tier, reason: 'absent-in-observation' })
      continue
    }
    if (observed !== match.actual) {
      // 文本变了。若**原文还在**（在别的行号上）⇒ 是被整体推移，而不是被改写：
      // 这两句对模型的下一步完全不同（前者要重定位，后者内容可能已被别人改了），所以分开报。
      const origin = regionLinesIn(content, observed).first
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
    if (observedSource.split(/\r?\n/).join('\n') === content.split(/\r?\n/).join('\n')) continue
    const thenAt = regionLinesIn(observedSource, observed)
    if (thenAt.first !== match.line) {
      const nowAt = regionLinesIn(content, match.actual)
      conflicts.push({
        lines: [match.line, match.end],
        tier: match.tier,
        reason: nowAt.first === null ? 'moved-out' : 'moved',
        nowAt: nowAt.first,
      })
      continue
    }
    if (observedSource.split(/\r?\n/).length !== content.split(/\r?\n/).length) {
      const nowAt = regionLinesIn(content, match.actual)
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
 * @param hunks - 本次的 hunk（原始 DSL 形状）
 * @param content - 本次实际读到的内容
 * @param planned - `planHunks(content, hunks, ...)` 的结果
 * @param displayPath - 账本钥匙与回执里的路径
 * @param options.byteOrderMark - 当前文件是否有前导 BOM（账本令牌的一半；缺省 false）
 * @returns {{clean: true, basis: 'observation'|'none'} | {clean: false, message: string, extras: object}}
 */
function regionGate(hunks, content, planned, displayPath, options = {}) {
  const observation = latestObservation(displayPath)
  if (observation === null) return { clean: true, basis: 'none' }
  /**
   * 当前内容不是账本里那一版 ⇒ 没有针对**它**的基准，回执必须如实标注（不冒充新鲜）。
   *
   * 这里**不能**再套一层 `providerView`：`content` 已经是 `readText` 的解码结果（第一个 BOM 已被
   * 解码器吃掉，其余留在文本里），而账本里的令牌是 `contentToken(读到的文本, 字节里有 BOM 吗)`。
   * 多剥一层会让**多 BOM 文件**的令牌对不上——实测 `bom2` / `bom3`：账本 `contentToken(„alpha…", true)`
   * 有两个 BOM，而 `providerView` 后的那个只有一个 ⇒ 整个文件被报成"没核对过"。
   * 单 BOM 文件恰好不受影响（`providerView` 是恒等），这类"只在多重形态下露头"的错最难发现。
   */
  const contentIsKnown = hasObservedVersion(displayPath, contentToken(content, options.byteOrderMark === true))
  const basis = contentIsKnown ? 'observation' : 'none'
  const conflicts = staleConflicts(observation.source, content, hunks, planned.matches, displayPath, {
    contentPath: displayPath,
    byteOrderMark: options.byteOrderMark === true,
  })
  if (conflicts.length === 0) return { clean: true, basis }
  const refusal = staleRegionRefusal(displayPath, conflicts)
  return { clean: false, message: refusal.message, extras: refusal.extras }
}

/**
 * 这个 hunk 是不是**按行号**寻址的（而不是按内容）。
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
 * @returns {{count: number, first: number|null}} 出现次数与首次出现的行号；`first` 仅在唯一时给出
 */
function regionLinesIn(source, text) {
  if (typeof source !== 'string' || typeof text !== 'string' || text.length === 0) return { count: 0, first: null }
  // 与 {@link locate} 里 `source.split(/\r?\n/)` **同一把尺子**：行号一致，且行尾不参与比较。
  // 这一点踩过：`match.actual` 是 `split(/\r?\n/).join('\n')` 的产物（行尾归一为 LF），
  // 而按 `splitLinesWithEndings` 逐行比会留下行尾的 `\r`（`'line three\r' !== 'line three'`），
  // 于是**每一行都算“找不到”**，闸门退化成“凡是 CRLF 文件一律拒绝”——6 条断言当场变红。
  let count = 0
  let first = null
  const rows = source.split(/\r?\n/)
  for (const [i, line] of rows.entries()) {
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

/**
 * 规划所有 hunk：逐个定位 → expect 核对 → 重叠检查 → 倒序拼接。
 * 任一 hunk 失败即抛错，调用方据此保证磁盘不变（事务性来自"先全部规划完再落盘"）。
 *
 * 定位本身不在这里——它调 {@link locate}（框架无关的定位服务），本函数只负责 DSH 侧的
 * 编排：多 hunk 的事务语义、expect 闸门、倒序拼接。
 *
 * @param content - 文件全文
 * @param hunks - 每个 { anchor?, target?, replace, expect?, near? }
 * @param filePath - 用于判定语言（符号路径需要）；缺省则符号路径自动不可用
 * @returns {{matches: Array, content: string, applied: Array}} 新内容与逐条回执
 */
export function planHunks(content, hunks, filePath = null) {
  const { lines, endings } = splitLinesWithEndings(content)
  const matches = []
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
    if (!hasTarget && range === undefined && !hasCue && !hasAnchor) {
      throw new PatchError(
        gaveLineAddress(hunk) ? LINE_ADDRESS_HINT : 'each hunk needs one of: target, lines, line_cue, anchor',
        'PATCH_NO_ADDRESS',
      )
    }
    const found = locate(content, {
      ...(hasTarget ? { target: hunk.target } : {}),
      ...(range === undefined ? {} : { lines: range }),
      ...(hunk.line_cue === undefined ? {} : { lineCue: hunk.line_cue }),
      ...(hasTarget || range !== undefined || hunk.line_cue !== undefined ? {} : { anchor: hunk.anchor }),
      ...(hunk.near === undefined ? {} : { near: hunk.near }),
      ...(hunk.expect === undefined || hunk.expect === null ? {} : { assert: hunk.expect }),
      ...(filePath === null ? {} : { filePath }),
    })
    if (!found.ok) {
      throw new PatchError(found.message, found.code, {
        ...(found.candidates === undefined ? {} : { candidates: found.candidates }),
      })
    }
    const loc = { start: found.startLine - 1, end: found.endLine, line: found.startLine, tier: found.tier, byNear: found.byNear === true }
    const actual = found.actual
    if (hunk.expect !== undefined && hunk.expect !== null) {
      // 双向归一化后比较：只判"是不是同一段语义内容"，不因空白差异误杀，但真改了词就拦下
      if (normSpace(actual) !== normSpace(hunk.expect)) {
        throw new PatchError(
          `hunk at line ${loc.line} matched via ${loc.tier}, but the content there differs from expect`,
          'PATCH_EXPECT_MISMATCH',
          { line: loc.line, actual },
        )
      }
    }
    matches.push({ ...loc, hunk: hunkIndex, replace: hunk.replace ?? '', actual })
  }
  matches.sort((a, b) => a.start - b.start)
  for (let i = 1; i < matches.length; i += 1) {
    if (matches[i].start < matches[i - 1].end) {
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
     */
    const rep = m.replace === '' ? { lines: [], endings: [] } : splitLinesWithEndings(m.replace)
    if (rep.lines.length > 0) rep.endings[rep.endings.length - 1] = outEndings[m.end - 1] ?? ''
    out = out.slice(0, m.start).concat(rep.lines, out.slice(m.end))
    outEndings = outEndings.slice(0, m.start).concat(rep.endings, outEndings.slice(m.end))
  }
  // 回执要报告**改后**的内容，因此得从拼接结果里取回该区间的新文本。
  // 倒序拼接会移动行号，所以在这里重算一遍：每个匹配的跨度是 [start, start+新行数)。
  const applied = [...matches]
    .reverse()
    .map((m) => {
      const replacedLines = m.replace === '' ? 0 : splitLinesWithEndings(m.replace).lines.length
      return {
        line: m.line,
        tier: m.tier,
        byNear: m.byNear === true,
        actual: m.actual,
        // 回执给的是**行文本**（不含行尾）：行尾是被继承的、不是调用方写的，
        // 放进来只会在展示时漏出 \r 并凭空多算一行。
        replaced: out.slice(m.start, m.start + replacedLines).join('\n'),
      }
    })
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
      expected = new TextEncoder().encode(written)
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
 * 一次完整写回：读 → BOM 计数 → 规划 → 陈旧闸门 → 逐字节写（CAS） → 回读校验 → 刷新观测。
 *
 * 这是**与框架无关的编排**：DSH 壳、独立 CLI、MCP 服务都走它，只有 provider 不同。
 * 与 DSH 壳那边唯一的差别是能力探测——那边后端可能没有 `writeText`（要退回 `editText`），
 * 而本机 provider 总是逐字节写，因此这里没有退化路径，也没有 `PATCH_NO_BYTE_EXACT_WRITE`。
 *
 * @param provider - 四方法契约，见本文件顶部注释
 * @param request - { displayPath, hunks, dryRun?, create?, signal? }
 * @returns 回执字段（与 DSH 版同形：applied / dryRun / write_verify / unverified_region / operation）
 * @throws PatchError（PATCH_STALE_REGION / WRITE_VERIFY_FAILED / PATCH_NOT_FOUND …）
 */
export async function applyEditToProvider(provider, request) {
  const { displayPath, hunks = [], dryRun = false, create, signal } = request
const info = await provider.stat(displayPath, signal)

  // 语义与内置 `write` 对齐：`create` **只**在文件不存在时用。它撞上已存在的文件 = 调用方意图搞错了，
  // 必须明确报错——静默忽略它去跑一个"零改动成功"，最容易被误读成"文件已经建好了"。
  if (info !== undefined && typeof create === 'string') {
    throw new PatchError(`cannot create "${displayPath}": it already exists — pass hunks to change it`, 'PATCH_EXISTS')
  }
  if (info !== undefined && hunks.length === 0) {
    throw new PatchError(`cannot patch "${displayPath}": no hunks — pass at least one, or use \`create\` for a new file`, 'PATCH_NO_HUNKS')
  }

  if (info === undefined) {
    if (typeof create !== 'string') {
      throw new PatchError(
        `cannot patch "${displayPath}": not found — to create it, pass \`create\` with the full file content`,
        'PATCH_NOT_FOUND',
      )
    }
    await provider.writeText(displayPath, create, { kind: 'createIfAbsent' }, signal)
    const verification = await verifyWriteBack(provider, displayPath, create, displayPath, signal)
    const view = providerView(create)
    const byteOrderMark = create.startsWith(BYTE_ORDER_MARK)
    rememberRead(displayPath, contentToken(view, byteOrderMark), view, byteOrderMark)
    return {
      path: displayPath,
      operation: 'create',
      applied: [{ line: 1, tier: 'create', actual: '', replaced: create }],
      dryRun: false,
      write_verify: verification,
    }
  }

  const content = await provider.readText(displayPath, signal)
  const byteOrderMarks = await fileByteOrderMarkCount(provider, displayPath, signal)
  const planned = planHunks(content, hunks, displayPath)

  /**
   * 闸门：判据与收据都在 {@link regionGate}，三个调用方共用（不在壳里再写第二份）。
   *
   * BOM 这个事实**只能从字节取**：`content` 是 `readText` 的解码结果，前导 BOM 已被解码器吃掉，
   * 所以 `content.startsWith(BOM)` **恒为 false**。而账本里的令牌是 `contentToken(source, bom)`！
   * 错一个字就永远查不到——实测后果：所有 BOM 文件的编辑回执都被标成
   * `unverified_region: true`（`range-bytes-test` 段B 五条断言当场变红），
   * 即"本来核对过"被报成"没核对过"，与相反方向的谎一样坏。
   *
   * ## 它必须在 `dryRun` **之前**（一次真机实测的结论）
   *
   * `dryRun` 原先排在闸门之前直接 return，于是出现这个形状（实测于本机 `drift.md`）：
   *   · `dry_run: true` 的回执说 "every hunk matched"；
   *   · 同样的 hunks 真数落盘时，闸门报 "the text you addressed moved: line 3 no longer holds it
   *     (it is now line 1)"。
   * 也就是说**预演没能预演出真正的判决**——而 `dry_run` 的全部价值就在于“先看会发生什么”。
   * 一个只在写入路径上生效的闸门，配上一个说“没事”的预演，比没有预演更坏：
   * 它会把“会被拒的编辑”报成“可以放心提交”。
   */
  const gate = regionGate(hunks, content, planned, displayPath, {
    byteOrderMark: byteOrderMarks > 0,
  })
  if (!gate.clean) throw new PatchError(gate.message, 'PATCH_STALE_REGION', gate.extras)
  if (dryRun) return { path: displayPath, applied: planned.applied, dryRun: true }
  const newContent = carryingByteOrderMarks(planned.content, byteOrderMarks)
  await provider.writeText(displayPath, newContent, { kind: 'replaceIfVersion', version: info.version }, signal)
  const verification = await verifyWriteBack(provider, displayPath, newContent, displayPath, signal)
  const view = providerView(newContent)
  const byteOrderMark = newContent.startsWith(BYTE_ORDER_MARK)
  rememberRead(displayPath, contentToken(view, byteOrderMark), view, byteOrderMark)
  return {
    path: displayPath,
    applied: planned.applied,
    dryRun: false,
    write_verify: verification,
    // 没有基准时如实标注。调用方（CLI/MCP/DSH 壳）都把它透进回执：
    // "没核对过"与"核对过且没变"必须是两句话，否则回执在撒谎。
    ...(gate.basis === 'none' ? { unverified_region: true } : {}),
  }
}

export {
  PatchError,
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
