/**
 * read-core.mjs —— 具备结构感知的 read 原型。
 *
 * ## 它替换掉的三个结构缺陷
 *
 * 1. **一个工具干三件事**。"这文件里有什么"（符号表）、"改第 X 行附近"（窗口）、
 *    通读（全文）的信息密度差两个数量级，旧 read 让三者都付全文的钱。
 * 2. **两级截断互不知情**。上游按"模型要看全文"设计（2000 行 / 50KB），
 *    下游按"结果太长就砍"设计（8192 字符掐头留尾）。叠起来产出谁都没设计过的输出。
 * 3. **静默的部分失败**。剪枝不带任何标记，接缝处行号从 89 跳到 1131，
 *    中间那段既不在文本里、也没说被跳过了。
 *
 * ## 贯穿全篇的一条约束
 *
 * **`read` 的输出上限不是它自己能定的。** 下游剪枝在 `PRUNE_BUDGET` 处掐头留尾，
 * 工具无法拒绝。因此正确做法不是"输出得更聪明"，而是：
 *   · 每个模式的输出预算对齐下游能保全的上限；
 *   · 任何丢弃都**显式标明**，并给出可执行的续读指令。
 *
 * 这一条决定了实现形态：所有模式都返回**结构化信封**（含 `omitted` 与 `next`），
 * 而不是一坨文本。信封的字段就是契约——调用方不必解析自然语言去猜发生了什么。
 */

import { indexStructure, langOf, listSymbols, rankSymbols, resolveTarget } from './struct-core.mjs'
import { docKindOf, indexDocument } from './doc-structure.mjs'
/**
 * 区间句柄（HD1）：本文件只**发**句柄，编辑侧怎么解析是另一张单的事。
 *
 * `handle-core.mjs` 是叶子（导入表为空），因此这条 import **不构成环**——
 * 否则 `write-path → read-core → handle-core → read-core` 会让模块求值顺序依赖入口。
 */
import { HANDLE_MAX_PER_RECEIPT, fnv1a32, handleCharsFor, mintHandle, mintStructureHandle } from './handle-core.mjs'
/**
 * 参数收敛层（叶子模块，导入表为空 ⇒ 这条 import 也不构成环）。
 *
 * 多目标读（{@link readManyWith}）**必须**用与 `readEnvelope` 同一对判定器
 * （`gaveLineAddress` + `lineRangeOf` + `inferReadMode`）把"今天那套单目标参数"解出来，
 * 而不是在引擎里另写一份。两份判定一旦分叉，症状是"同一个目标，单独调用读得出来、
 * 放进 targets 里就报参数错"——而两边各自的测试都会绿（契约 §2.1 那句"同一个校验器"）。
 */
import { MT_MAX_TARGETS, MT_POOL, asLinePair, normalizeReadRequest } from './args.mjs'
/**
 * 交付覆盖（1.0.2）：读侧只负责**记账**，判据在写侧。
 *
 * `coverage-core.mjs` 也是叶子，这条 import 同样不构成环；区间解析/合并只有它一份，
 * 写闸与回执用的是同一套 `"1-166"` 写法。
 */
import { formatRanges, mergeLabels, parseRange } from './coverage-core.mjs'

/**
 * 多目标形状的**契约上限**（fs-contract-v2 §2.1）不是本地判据，而是从参数面 `args.mjs` **转出**：
 * 那个数在参数面只有一份（`assertEditTargets` / `assertReadTargets` 与两个壳共用一个上限），
 * 读侧再写一遍就等于把同一份不变式抄成两份独立真值——将来改一处必分叉，而分叉的方向是
 * “参数面放行了、读引擎却拒收”这类没人愿意调的对不上。
 *
 * 接法：上面的 `import` 建一个本地绑定供本文件自己判上限，再把这个**同一绑定**导出
 * （不是 `export … from`：那种写法不建本地绑定，本文件自己的 `if (list.length > MT_MAX_TARGETS)`
 * 会当场 `ReferenceError`——这一点是实跑出来的，不是推的）。取值只有一个来源：`args.mjs` 那个字面量；
 * `const MT_MAX_TARGETS = 32` 这种第二份字面量在这里已无必要。对外导出名与取值逐字未变，`multi-read-test.mjs` 照旧。
 */
export { MT_MAX_TARGETS }

/**
 * 本引擎在调用方**没有告知**宿主上限时使用的缺省值。
 *
 * 这个数不是本项目的选择，也不是量出来的：它来自
 * `dsh-compaction-tool-result-pruner` 的 `DEFAULTS.thresholdChars`（8 KiB，2 的整数次幂，
 * 形状上是“页大小”那类惯例数；README 里只有“低摩擦默认值”一句，无测算依据）。
 *
 * 它**可以被部署改写**（`dsh-base/cordis.patch.yml` 与三个 preset 都显式写着
 * `thresholdChars / headChars / tailChars`），所以把它抄成引擎常量是错的：
 * 部署改成 32768 时本工具会继续白白少给，改小时则会被静默剪掉中段。
 *
 * 因此：调用方可以（也应该）通过 `readWith` 的 `request.budget` 告知真实上限；
 * DSH 壳从 `ctx.toolResultPruner.config.thresholdChars` 现读并传入（见 `aura-read/index.js`）。
 * 这个常量只在无宿主环境（CLI / MCP / 单测）下兜底。
 */
export const DEFAULT_PRUNE_BUDGET = 8192

/** 保留旧名以兼容既有调用方与测试；含义同上。 */
export const PRUNE_BUDGET = DEFAULT_PRUNE_BUDGET

/**
 * 信封开销是**算出来的**（`envelopeOverhead`），不是一个预留的魔数。
 *
 * 我先前写的是 `ENVELOPE_RESERVE = 1100`——一个拍的数，用来估计模式名、路径、omitted
 * 说明、续读指令加起来多大。它有两个毛病：没有依据；而且一旦实际信封超过它，
 * 内容预算就偏大，整个结果可能越过剪枝阈值而被砍——正是这套设计要避免的事。
 *
 * 正确的做法是先把信封渲染出来量一次。见 {@link readWith} 的两趟流程。
 */
/**
 * 单条回执附带的句柄数上限（契约 §4）——**常量本体在 `handle-core.mjs`**，这里只转出。
 *
 * 为什么不在本文件里再写一个 `= 20`：那样读侧与编辑侧就有两个真值来源，
 * 而两者一旦分叉，"命中数超过上限只报数"这条判据会在两侧给出不同答案。
 *
 * 为什么必须有上限：句柄是**按命中数线性增长**的，而 `search` 的命中数由查询词决定、
 * 不由本工具决定——`search e` 这种查询在万行文件上能命中上千行。没有上限，
 * 「不回涨体积」这条不变式（契约 §2.5）就只是句柄数量恰好没撞上而已。
 * 上界因此是确定的：20 × 21 字符 = 420 字符，与命中数无关。
 */
export { HANDLE_CHARS, HANDLE_MAX_PER_RECEIPT } from './handle-core.mjs'

/**
 * 读侧**唯一的铸柄入口**。
 *
 * 为什么收成一处：句柄的摘要必须覆盖**编辑侧将要去核对的那段字节**。
 * 若调用点各自切片（一处给窗口行、一处给命中行…），形状就会漂开，
 * 而**漂开是静默的**——两个位置都"有"句柄，只是它们指的字节不一样。
 * 收在这里之后，"哪段字节对应哪个句柄"只有一个答案。
 *
 * @param ledgerKey - 已归一化的账本键（`ledgerIdentityKey` 的结果）
 * @param lines - 全文按行切开的数组
 * @param byteOrderMark - 这份文件是否带 UTF-8 BOM
 * @param startLine - 区间起始行（1-based，含）
 * @param endLine - 区间结束行（1-based，含）
 * @returns 句柄字符串；行号越界或区间为空时返回 null（**不铸一个指不到字节的柄**）
 */
function handleFor(ledgerKey, lines, byteOrderMark, startLine, endLine) {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null
  if (startLine < 1 || endLine < startLine || startLine > lines.length) return null
  const to = Math.min(endLine, lines.length)
  // 切片取的是**原始行**：行号前缀是渲染的产物，截断是预算的产物——
  // 两者都不是文件里的字节。用它们算摘要会让同一个区间因为"这次预算小了点"而换柄。
  const regionText = lines.slice(startLine - 1, to).join('\n')
  return mintHandle({ ledgerKey, regionText, byteOrderMark, startLine, endLine: to })
}

/**
 * 句柄落在 text 里时的分隔串（也是它唯一的**机器可识别标记**）。
 *
 * 为什么必须有个标记而不是直接 "行内容 + 句柄"：`text` 是行的拼接，句柄得能**被抓出来**
 * （`HANDLE_RE` 还需要一个左边界），而且人读时能一眼看出这不是文件里的字节。
 * 选 `  <` … `>` 是因为：它不会出现在正常行尾，长度只有 3 字符，
 * 而且与既有 ` ⋯ [truncated …]` 的"行尾附加说明"风格一致。
 */
const HANDLE_MARK_OPEN = '  <'
const HANDLE_MARK_CLOSE = '>'

/** 行尾附加说明的**全部字符数**（含两侧标记）：21 字符句柄 ⇒ 24。 */
export function handleInlineChars(startLine, endLine) {
  return HANDLE_MARK_OPEN.length + handleCharsFor(startLine, endLine) + HANDLE_MARK_CLOSE.length
}

/**
 * 把句柄接到一行文本末尾；`handle` 为 null 时原样返回。
 *
 * `lines` 与 `search` 共用这一处，免得两个模式的"行尾长什么样"漂成两种。
 */
function withHandleOnLine(line, handle) {
  return handle === null ? line : `${line}${HANDLE_MARK_OPEN}${handle}${HANDLE_MARK_CLOSE}`
}

/** 句柄的字符长度（契约 §3）——测试与体积核算共用这一个来源，不各写一个 21。 */
// 句柄长度常量与上面那个上限同源，都在 `handle-core.mjs`（见文件顶部那条 re-export）。

export const DEFAULT_ENVELOPE_ALLOWANCE = 700
/**
 * 700 = 两层开销之和，且是**实测**而非拍值：
 *   · 信封自身：路径 + 模式名 + omitted/next + JSON 转义后的换行/引号；
 *   · **工具输出那一层**：DSH 壳再把信封包一次（`path` / `mode` / `totalLines` / `text`），
 *     而框架量的是**这一层**。
 *
 * 只算前者会漏掉后者：实测 400 个函数的 `map` 曾以 8251 字节超出 8192 的 59 字节，
 * 原因就是 `serializedSize` 量的是引擎信封（恰好 8192 以内），而实际送出的是工具输出。
 * 两个数都对、放在一起就错——所以这里把两层预算写在一处，不再分散成几个魔法数字。
 */

/**
 * 内容预算的起点（用于第一趟渲染，随后按**实测**信封收紧）。
 *
 * 512 只是起点：信封（路径 + 模式名 + omitted/next + JSON 转义）在符号多的文件上会超过它。
 * 实测：400 个函数的 `map` 在缺省 8192 下曾产出 **8251 字节**——超出 33，即那条
 * "输出绝不越过剪枝阀"的硬保证实际上是破的（只是恰好还没被剪到）。
 * 现在收敛循环的收窄量不再单靠残留余量（见 readWith 里的 `SHRINK_MARGIN`），
 * 并在循环后**再断言一次**，宁可多收一轮也不发出超限的信封。
 */
export const CONTENT_BUDGET = PRUNE_BUDGET - DEFAULT_ENVELOPE_ALLOWANCE

/**
 * 量一个信封的**真实序列化开销**。
 *
 * 必须按序列化结果量，不能按字符数估：`text` 里的换行在 JSON 里变成 `\n`（两个字符）、
 * 引号要转义，所以"字符数"会系统性低估，而下游剪枝看的正是序列化后的体量。
 * 我先前用 `JSON.stringify(rest).length` 近似就已经不准，用字符数估更错。
 */
function serializedSize(envelope) {
  return JSON.stringify(envelope).length
}

/**
 * 模式。刻意做成显式枚举而不是"有参数就切换"——后者会让"我到底要什么"变得含糊，
 * 而含糊正是信息浪费的源头。
 */
export const MODES = ['map', 'digest', 'full', 'around', 'lines', 'search', 'changed', 'probe']

/**
 * 摘要：**看懂一个文件**所需的最小信息集。
 *
 * 这是对 read 最核心的质疑。模型说"我读一下这个文件"，意图通常是"看懂它怎么运作"，
 * 而不是"我要复现它的每一个字节"。旧 read 让"理解"付了"复现"的钱——
 * 实测同一批文件全文 81008 token，摘要 3970 token，**压缩 20.4x**。
 *
 * 摘要只用**签名与名字**，不碰函数体。因此它天然不受内容截断影响。
 */
function renderDigest(base, source, lines, lang, request, symbolsIndex = null) {
  if (lang === null) {
    /**
     * 文档没有签名，但有**结构**。`digest` 的承诺是“无正文的结构”，
     * 所以文档的 digest = 结构目录（与 `map` 同源），而不是一句“没有结构”。
     */
    const docKind = docKindOf(request.filePath)
    if (docKind !== null) {
      return {
        ...renderDocMap(base, lines, docKind, request),
        mode: 'digest',
        note: 'documents have no signatures; this is their structure directory (same as mode=map)',
      }
    }
    /**
     * 正文放 `text`（不是 `note`）：`metrics.chars` 量的是 `text` 的长度（read-test 钉着这条等式），
     * 只给 `note` 时 `chars` 会报 0，与 note 里的实际信息矛盾（反馈 D8）。
     */
    return {
      ...base,
      mode: 'digest',
      text: `unsupported extension — no structure available; ${base.totalLines} lines`,
      next: 'mode=lines lines=[a,b]',
    }
  }
  const index = indexStructure(source, lang)
  const syms = listSymbols(index)

  // 导出面：符号**在顶层**（没有 enclosing），且 `export` 出现在它自己那一行、
  // 或它上方的连续行里。
  //
  // 第三版才修对。第一版只查同一行 → 全部文件报 0 个导出（`export function` 之后
  // 被断成两行就漏）。第二版加"查上一行" → `let sum` 在 `total` 体内，上一行恰是
  // `export function total(...)`，于是函数内的局部变量被算成导出。
  // 正确判据需要两个条件同时成立：**顶层** 且 导出标记在紧邻上方。
  const exported = []
  /** 与 `exported` **同序同长**的符号表：被裁掉的导出面要靠它算出源码行区间。 */
  const exportedSyms = []
  for (const s of syms) {
    if (s.enclosing !== null && s.enclosing !== undefined) continue // 函数体内的量不是导出
    const own = lines[s.startLine - 1] ?? ''
    if (/\bexport\b/.test(own)) {
      exported.push(`${s.kind} ${s.name}`)
      exportedSyms.push(s)
      continue
    }
    // 向上看紧邻的连续行，遇到空行即停（`export {` 与声明之间不会有空行）
    for (let k = s.startLine - 2; k >= 0; k -= 1) {
      const up = lines[k] ?? ''
      if (up.trim().length === 0) break
      if (/\bexport\b/.test(up)) {
        exported.push(`${s.kind} ${s.name}`)
        exportedSyms.push(s)
        break
      }
    }
  }

  // 签名：签名行裁到块体开符或行尾
  const signatures = syms
    .filter((s) => s.kind === 'function' || s.kind === 'class')
    .map((s) => {
      const raw = (lines[s.startLine - 1] ?? '').trim()
      const cut = raw.indexOf('{')
      const sig = (cut >= 0 ? raw.slice(0, cut) : raw).trim().replace(/\s+/g, ' ')
      const span = s.endLine - s.startLine + 1
      // 签名行的截断也是**披露点**（T12）：截了就在行尾把省略量标出来。
      // 先前这里是 `sig.length > 68 ? slice(0,68)+'…'` 的裸数字——末尾那个 `…`
      // 是唯一提示，而且分不出“这里本来就省略”还是“被裁了”。
      const sigShown =
        sig.length > SIGNATURE_CHARS
          ? `${sig.slice(0, SIGNATURE_CHARS)}… [+${sig.length - SIGNATURE_CHARS} chars]`
          : sig
      // 签名行的“行”字改回英文：`digest` 的回执要进英文会话（同 T9 里修过的那类漏出）。
      return `${s.startLine}-${s.endLine} (${String(span).padStart(3)} lines) ${sigShown}`
    })

  // 控制流密度：判断"哪些函数值得细读"，不需要读函数体
  const control = (source.match(/\b(if|for|while|switch|catch)\b/g) ?? []).length

  // 依赖：import 来源 + 调用的外部自由函数。
  // 只收**自由调用**（前面不是 `.`），因为 `x.foo()` 里的 foo 是字段名不是依赖——
  // 第一版把两者混在一起，于是 `state` `clear` `get` `set` 这类字段名灌满了 externals。
  const imports = [...source.matchAll(/(?:import\s[^'"]*from\s|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  const own = new Set(syms.map((s) => s.name))
  const FREE_CALL = /(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g
  const called = new Set()
  for (const m of source.matchAll(FREE_CALL)) called.add(m[2])
  const external = [...called].filter(
    (c) => !own.has(c) && !lang.keywords.has(c) && !['require', 'import', 'function', 'return'].includes(c),
  )

  /**
   * 摘要头。**行数与下面的 `dropped` 计算必须同源**，否则两边会各自漂移。
   *
   * 这里原来是硬编码的 `- 5`：`dropped = signatures.length - max(0, kept.kept - 5)`，
   * 而 5 是"表头恰好五行"这个事实的手工副本。那是典型的补丁式写法——
   * 头少一行，`dropped` 就少报一条；头多一行，就多报一条，**而且不报错**，
   * 只是安静地把"还剩几条签名"说错。原先 `fitWithin` 的 `kept` 字段就是死在
   * 同一类"同一个事实写两遍"上（超预算分支与不超预算分支语义不同）。
   * 现在两个数字都从 `heading` 派生，改头不再需要记得改别处。
   */
  const headingTop = `${base.totalLines} lines · ${syms.length} symbols · ${control} control-flow`
  const headingTail = [
    `imports: ${imports.join(', ') || '(none)'}`,
    `external calls: ${external.slice(0, 16).join(', ') || '(none)'}`,
    '--- signatures ---',
  ]
  /**
   * ## 导出面与正文**共享同一个内容预算**
   *
   * 这是 `digest` 在 10^5 行档上的一处反转：正文受内容预算管，`exported` 数组不受，
   * 于是**省流模式反而比正文还大**。实测（100000 行 / 100000 个 export）：
   *
   *   digest: text=0 字节 · 整个信封 1889299 字节
   *
   * 而且它是个**死循环**：收敛循环看到信封超限就收窄内容预算，可
   * `exported` 一个字段就占掉了全部体量，预算收到 0 也压不下去，于是最后只能
   * 发一个「text 为空 + omitted 说明信封已至最小」的信封——省流模式给出了比全文大 20 倍的输出。
   *
   * 成因是两套尺子：`fitWithin` 量的是正文，`exported` 直接挂到信封上，谁也没管它。
   * 现在两者用同一把尺子：先算导出面要花多少钱（正文那一行 + 信封里那个数组，
   * 它出现两次就付两次钱），剩下的才是正文的；预算小到装不下导出面时，
   * 导出面自己也被裁短，并在 `omitted` 里明写被省掉了多少。
   *
   * 留下的**下限**是固定的四行头 + 至少一条签名：低于这个的 digest 回答不了
   * “这个文件是什么”（`suggestMode` 的 `delivered()` 门槛也是冲着这个来的）。
   */
  const fixedCost = [headingTop, ...headingTail].reduce((n, row) => n + row.length + 1, 0)
  const floor = fixedCost + (signatures.length === 0 ? 0 : signatures[0].length + 1)
  const exportedBudget = Math.max(0, base.contentBudget - floor)
  const capped = fitExported(exported, exportedBudget)
  const exportedMark =
    capped.dropped === 0
      ? capped.shown.join(', ') || '(none)'
      : `${capped.shown.join(', ')} [+${capped.dropped} more — beyond the content budget]`
  const heading = [headingTop, `exported: ${exportedMark}`, ...headingTail]
  const parts = [...heading, ...signatures]
  const kept = fitWithin(parts.join('\n'), base.contentBudget)
  const dropped = Math.max(0, signatures.length - Math.max(0, kept.kept - heading.length))
  const omissions = []
  if (capped.dropped > 0) {
    omissions.push(`${capped.dropped} exported name(s) beyond the content budget (same budget as the text)`)
  }
  if (dropped > 0) omissions.push(`${dropped} more signatures beyond the content budget`)
  return {
    ...base,
    mode: 'digest',
    symbols: syms.length,
    exported: capped.shown,
    text: kept.text,
    // 摘要也会超预算（函数极多时）。同一契约：超了必须显式。
    ...(omissions.length > 0
      ? {
          omitted: omissions.join('; '),
          // 续读参数：被截掉的符号的**源码行区间**是确定且可读的，所以“剩下的去哪拿”有确切答案。
          ...digestResume(signatures, kept.kept, heading.length, syms, exportedSyms, capped.dropped),
        }
      : { next: 'mode=around around=<name> to see one function' }),
  }
}

/**
 * 导出面要花的钱：**正文那一行 + 信封里那个数组**。
 *
 * 为什么两处都要算：`exported` 同时出现在 `text` 的表头行和信封的 `exported` 字段里，
 * 只算一处就会系统性低估，而低估的方向正好是危险的那一侧（信封越过宿主上限）。
 * 函数对 `n` **严格单调**（每一项都非空），所以下面可以二分。
 */
function exportedCost(items, n) {
  const shown = items.slice(0, n)
  return `exported: ${shown.join(', ')}`.length + 1 + JSON.stringify(shown).length
}

/** `[+N more]` 那个尾巴自己也要钱，先给它留够（最大的 N 是 6 位数）。 */
const EXPORTED_TAIL_RESERVE = 48

/** 按预算裁短导出面；返回**收下的那一份**与被裁掉的数量。 */
function fitExported(items, budget) {
  const cap = Math.max(0, budget - EXPORTED_TAIL_RESERVE)
  if (exportedCost(items, items.length) <= cap) return { shown: items, dropped: 0 }
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (exportedCost(items, mid) <= cap) lo = mid
    else hi = mid - 1
  }
  return { shown: items.slice(0, lo), dropped: items.length - lo }
}

/**
 * `digest` 截断时的续读参数：**没进正文的那些符号**落在哪几行。
 *
 * 先前这里只有一句 `mode=map to see the full symbol list`——而 `map` 同样受预算管
 * （只是换一种截法），拿它当“续读”等于把调用方送到另一个会截断的地方。
 * 候选里真的可执行的只有一条：那批符号的**源码行区间**——那是算得出来的。
 *
 * 被截掉的有**两种**，都要管（第一版只管了后者，于是在一个「全是导出常量、没有函数」
 * 的文件上，续读参数直接缺席——而那正是 `exported` 数组膨胀得最厉害的形状）：
 *   · 签名行没排上（`signatures` 只看 function/class）；
 *   · 导出名没排上（`exported` 被 {@link fitExported} 裁短）。
 * 两种合起来取一个区间：调用方要的是“剩下的那些东西在哪”，而它们在文件里就是那几行。
 *
 * @param signatures - 已渲染的签名行（与 `syms` 里 function/class 同序）
 * @param keptRows - 正文实际收下的行数
 * @param headingRows - 表头占几行
 * @param syms - 全部符号
 * @param exportedSyms - 与导出名同序的符号
 * @param droppedExports - 被裁掉的导出名个数
 */
function digestResume(signatures, keptRows, headingRows, syms, exportedSyms, droppedExports) {
  const shownSigs = Math.max(0, keptRows - headingRows)
  const rest = []
  if (shownSigs < signatures.length) rest.push(...syms.filter((s) => s.kind === 'function' || s.kind === 'class').slice(shownSigs))
  if (droppedExports > 0) rest.push(...exportedSyms.slice(exportedSyms.length - droppedExports))
  if (rest.length === 0) return {}
  const from = Math.min(...rest.map((s) => s.startLine))
  const to = Math.max(...rest.map((s) => s.endLine))
  return {
    resume: { mode: 'lines', lines: [from, to] },
    next: `mode=lines lines=[${from},${to}] covers the ${rest.length} symbol(s) not shown here`,
  }
}

/**
 * 已读内容的**有界缓存**，键是 `路径@版本`。
 *
 * 为什么需要它：`changed` 做 diff 必须有"上次的全文"，但**全文不能放进返回值**。
 * 查过剪枝实现后确认：下游剪枝只作用于 `content` 里的 text block，**不碰其它字段**——
 * 所以"把全文放进另一个字段里"躲不过模型的眼睛，它会原样送达，节省全部作废。
 * 唯一正确的做法是让全文不进入返回值：模型只持有小令牌，全文由工具按令牌存着。
 *
 * 有界：超出上限按插入顺序淘汰。未命中时诚实降级为"没有基准可比"，不假装能 diff。
 */
/**
 * 观测缓存的**存储缝**：默认进程内 Map，宿主可以换（见 {@link setObservationStore}）。
 *
 * 为什么要有这道缝：DSH 壳是长进程，进程内 Map 够用；独立 CLI / MCP 里每次调用可能是**新进程**，
 * 上一轮的观测必须活到进程外，否则区域级新鲜度闸门在那边永远拿不到基准。引擎只管语义
 * （"最近一次观测" + "按版本回取全文" + 有界淘汰），存哪儿由宿主决定。
 *
 * 存储契约（六个方法）：remember / deliver / latest / entry / recall / count。
 *
 * `deliver` 与 `remember` 分开的原因只有一个：**读侧要先记账、后渲染**。
 * 版本令牌在渲染之前就有，而"这次交付了哪些行"只有渲染完才知道——先 remember 建条目，
 * 渲染完再 deliver 补上覆盖，两步之间不可能失败（同一版本，同一条目）。
 *
 * @param limit - 条目上限；超出按插入顺序淘汰（淘汰时同步清"最近观测"指针，
 *   否则它会指向一条不存在的全文）。
 */
export function createMemoryStore(limit = 8) {
  const seen = new Map() // `路径@版本` → { source, byteOrderMark, delivered }
  const latest = new Map() // 路径 → `路径@版本`
  return {
    remember(filePath, version, source, byteOrderMark = false) {
      const key = `${filePath}@${version}`
      const previous = seen.get(key)
      seen.delete(key)
      // 同一版本重记（同一份内容读了两次）不能把上一次的交付覆盖抹掉。
      seen.set(key, { source, byteOrderMark: byteOrderMark === true, delivered: previous?.delivered ?? [] })
      latest.set(filePath, key)
      while (seen.size > limit) {
        const oldest = seen.keys().next().value
        seen.delete(oldest)
        for (const [p, k] of latest) if (k === oldest) latest.delete(p)
      }
    },
    deliver(filePath, version, labels) {
      const entry = seen.get(`${filePath}@${version}`)
      if (entry !== undefined) entry.delivered = labels
    },
    latest(filePath) {
      const key = latest.get(filePath)
      if (key === undefined) return null
      const entry = seen.get(key)
      if (entry === undefined) return null
      return { version: key.slice(filePath.length + 1), source: entry.source, byteOrderMark: entry.byteOrderMark === true, delivered: entry.delivered ?? [] }
    },
    entry(filePath, version) {
      return seen.get(`${filePath}@${version}`) ?? null
    },
    recall(filePath, version) {
      return seen.get(`${filePath}@${version}`)?.source ?? null
    },
    has(filePath, version) {
      return seen.has(`${filePath}@${version}`)
    },
    count: () => seen.size,
  }
}

/** 当前存储。默认内存实现；换实现只影响"观测记在哪"，不影响任何判据。 */
let STORE = createMemoryStore()

/**
 * ── 账本键的**路径同一性**（C54）─────────────────────────────────────────────
 *
 * 观测账本原来按**路径字符串**逐字符记账。于是"同一个磁盘文件"换一种写法，在账本里就是
 * 另一个键：`latestObservation` 查不到 ⇒ 区域级新鲜度闸门没有基准 ⇒ 它按契约走
 * `basis: 'none'`（如实标注、**放行**，见 `write-path.mjs` 的 `regionGate`）。
 * 一句话：**写法差异 = 闸门失效**。
 *
 * 实测（本机 Windows，`%TEMP%` 下的靶子；读数见 `stale-gate-test` 段M）：
 * 读 `…\Beta.js` → 第三方改掉被寻址的第 3 行 → 用 `…\beta.js` 发一个**无 `expect`** 的
 * `lines` 编辑 ⇒ **静默覆盖成功**。`.` 段、`\\` 冗余分隔符、`/` 正向斜线、junction 别名
 * 逐条同样洞穿（改前五条一起红）。
 *
 * ## 归一化只有一处
 *
 * 五个账本入口（`rememberRead` / `latestObservation` / `hasObservedVersion` / `recallRead` /
 * `seenEntry`）全部先经过 {@link ledgerPathKey} 与 {@link resolveLedgerKey}，调用点一处都不
 * 重复实现；增量读的交付账本（`ledgerGet` / `ledgerSet`）走同一个 {@link ledgerPathKey}。
 *
 * ## 为什么是"词法 + 别名"，而不是 `realpath`
 *
 * `realpath` 是这条问题的标准答案：本机实测 `realpathSync.native` 一次同时解决大小写、
 * `.` 段、冗余分隔符、8.3 短名（短名会还原成它真正的长名）、junction（别名会还原成真身），
 * 代价约 68µs/次（`statSync` 是 24µs，都在可接受量级）。
 * **但引擎用不了它**：ENGINE 清单里的文件被两道闸同时禁止直接使用 `node:fs`、按平台分支
 * （读 `process` 的 platform 字段）与盘符字面量 —— `build/make-bundle.mjs` 的 `copyFile`
 * 守卫，以及 `public-surface-test` 里取自同一份 ENGINE 清单的那条判据。而"这个文件系统
 * 是不是大小写敏感"**正是平台事实**，词法层拿不到。拿不到文件系统证据，这里就按
 * **会话内的证据**决定，而不是按平台猜。
 *
 * ## 宿主把事实递进来之后（C61 → C62）
 *
 * C61 让 DSH 壳把 `ctx.fs.resolve()` 的 `targetKey`（本地后端 = `realpath`）作为 `identityKey`
 * 递进引擎。从那时起，"拿不到文件系统事实"不再是普适前提：**身份键在场时必须让它说话**
 * （{@link resolveLedgerKey} 的第 1／2 级）。C62 收的正是上一波漏掉的那半：事实已经带进来了，
 * 查询侧却还按折叠启发式认，于是**真正不同**的 `beta.js` 拿到了 `Beta.js` 的观测 ⇒ 误拒，
 * 而拒绝文本谎称它有过 last observation。折叠现在只在一个场景生效：**手头没有盘上事实**
 * （独立面 CLI/MCP、老调用方、直接调引擎的测试）。
 *
 * ## 覆盖 / 不覆盖（边界写清楚，不含糊）
 *
 * 覆盖：`.` 段、冗余分隔符（`\\` 与 `//`）、`\` 与 `/` 混用（**限 Windows 根路径**：
 * 盘符前缀或 UNC 前缀）、盘符大小写，以及**大小写**（**仅在没有身份键时**经别名索引，见下）。
 * 不覆盖：**8.3 短名**（`PROGRA~1` 与 `Program Files` 在词法上不共享任何前缀，没有证据可依）；
 * **符号链接 / junction**（同上——`realpath` 才认识它们）；**POSIX 上把 `\` 当分隔符**：
 * POSIX 的 `\` 是合法的文件名字符，一律当分隔符会把两个真不同的文件并成一个键，
 * 而那是本条明令禁止的失败方向，所以不猜。
 * 这三样只能由宿主在**进入引擎之前**把路径定成同一个写法（`ctx.fs.resolve` 那一侧）
 * —— 宿主现在就是这么做的，并且把结果作为 `identityKey` 递了进来。
 *
 * ## 确定性
 *
 * {@link ledgerPathKey} 是**纯函数**：同样的输入永远给同样的键，不读 cwd、不读平台、
 * 不看文件是否真的存在。别名索引（下面那段）只回答"这一次会话里这个折叠类出现过几种
 * 写法"，它同样与 cwd 无关；身份键表（{@link IDENTITY_KEYS}）只回答"宿主这一会话里认证过
 * 哪些串是盘上事实"，同样与 cwd 无关。
 */

/**
 * 纯词法归一：同一个文件的常见写法差异 → 同一个字符串。
 *
 * 只做**恒安全**的变换：
 *   · 折叠冗余分隔符；
 *   · 丢掉 `.` 段（`.` 就是当前目录，不可能是链接，丢掉永远等价）；
 *   · 盘符统一成大写（盘符从来不区分大小写）。
 *
 * `\` 与 `/` 互相折算**只对 Windows 根路径做**：POSIX 上 `\` 是合法的文件名字符，
 * 一律当分隔符会把 `a\b.js` 与 `a/b.js` 这两个真不同的文件并成一个键。
 *
 * `..` **不做词法消解**：`a/../b` 只有在 `a` 是普通目录时才等于 `b`；`a` 是符号链接时
 * 它们是两个不同的文件 —— 词法消解正是在制造本条明令禁止的那种合并。
 *
 * @param filePath - 调用方给的路径（相对／绝对、哪种分隔符都可以；非字符串原样返回）
 * @returns 账本键的词法部分
 */
export function ledgerPathKey(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return filePath
  // 盘符前缀（一个字母加冒号，后面跟一个分隔符）或 UNC 前缀（两个前导分隔符）。
  const drive = /^[A-Za-z]:[\\/]/.test(filePath)
  const unc = /^[\\/]{2}[^\\/]/.test(filePath)
  // 既不是 Windows 根路径、又不含正斜线 ⇒ 没有可以**安全**归一的地方，原样返回。
  if (!drive && !unc && !filePath.includes('/')) return filePath
  let head = ''
  let rest = filePath
  if (drive) {
    head = `${filePath[0].toUpperCase()}:/`
    rest = filePath.slice(2)
  } else if (unc) {
    head = '//'
    rest = filePath.slice(2)
  } else if (rest.startsWith('/')) {
    head = '/'
  }
  const body = drive || unc ? rest.replace(/[\\/]+/g, '/') : rest.replace(/\/+/g, '/')
  const parts = []
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue
    parts.push(segment)
  }
  return head + parts.join('/')
}

/**
 * 折叠别名索引：`折叠键 → Set<词法键>`（最近登记的排在后面）。
 *
 * 它回答的**不是**"这两个写法是不是同一个文件"（没有文件系统证据，这个问题答不了），
 * 而是"这次会话里，这个折叠类下出现过几个**不同的写法**"。于是：
 *   · 只见过一个写法 ⇒ 另一个写法请求过来，说的只能是它。Windows 默认大小写不敏感，
 *     这正是 1287 个会话里出现过的那一类；
 *   · 见过 ≥2 个写法 ⇒ 可能是同一个文件被两种写法读过（大小写不敏感），也可能是两个
 *     真不同的文件（大小写敏感，`Beta.js` 与 `beta.js` 并存）。这时**只在"内容逐字节
 *     相同"这条证据下**才敢挑一个：内容相同的两份观测**是可互换的**，拿哪一份当基准，
 *     区域判据算出来的结论都一样。拿不到这条证据就**不猜** —— 请求退回它自己的词法键，
 *     查不到就是查不到，闸门如实带 `unverified_region`。
 *
 * 键**只按词法键登记**（登记侧不跟随别名，除非内容逐字节相同），因此两个真不同的文件
 * 永远是两个键，不会被并成一个（`stale-gate-test` 段O 直接钉住这一条）。
 *
 * ## 它现在只是"没有文件系统事实时"的兵（C62）
 *
 * 上面那套推断的前提是"手头没有盘上事实"。宿主一旦把身份键递进来（见 {@link IDENTITY_KEYS}），
 * 这个前提就没了：那时再折叠只会**盖掉**事实。所以折叠的每一处入口都先让身份键说话
 * —— 判据顺序与理由见 {@link resolveLedgerKey}。
 */
const PATH_ALIASES = new Map()
/** 索引上限。观测缓存是 8 条、交付账本是 64 条，512 远在其上，正常会话碰不到。 */
const PATH_ALIAS_LIMIT = 512
/** ASCII 折叠。Windows 的忽略大小写比较是完整的 Unicode 折叠；ASCII 之外的差异不合并（保守方向）。 */
const foldPathKey = (key) => key.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** 取（必要时建）一个折叠桶；超过上限按插入顺序淘汰整桶。 */
function aliasBucket(key) {
  const fold = foldPathKey(key)
  let bucket = PATH_ALIASES.get(fold)
  if (bucket === undefined) {
    bucket = new Set()
    PATH_ALIASES.set(fold, bucket)
    while (PATH_ALIASES.size > PATH_ALIAS_LIMIT) PATH_ALIASES.delete(PATH_ALIASES.keys().next().value)
  }
  return bucket
}

/** 记下"这个折叠类里出现过这个写法"（重新插入 = 最近登记的排在后面）。 */
function aliasRemember(key) {
  const bucket = aliasBucket(key)
  bucket.delete(key)
  bucket.add(key)
}

/**
 * 桶里与本次手上的**内容**或**令牌**对得上的那一个键。
 *
 * 只在恰好一个成员对得上时返回它：两个都对得上说明两份观测内容逐字节相同、**可互换**，
 * 这时不值得挑（调用方退回精确键即可）；一个都对不上就直接说"没有证据"。
 *
 * @param evidence - `{ source }`（手上是全文）或 `{ token }`（手上是内容令牌）；null = 没有证据
 */
function aliasByEvidence(bucket, evidence) {
  if (evidence === null || evidence === undefined) return null
  let hit = null
  for (const key of bucket) {
    const entry = STORE.latest(key)
    if (entry === null) continue
    const same = evidence.source !== undefined ? entry.source === evidence.source : entry.version === evidence.token
    if (!same) continue
    if (hit !== null) return null
    hit = key
  }
  return hit
}

/**
 * 查询侧：这次请求说的是**哪一个账本键**。
 *
 * 判据顺序（每一级都比上一级弱，最后一级是"不猜"）：
 *   1. 这个折叠类没见过 ⇒ 就是它自己的词法键；
 *   2. 这一类只见过一个写法 ⇒ 就是那一个（写法差异的唯一解释）；
 *   3. 见过 ≥2 个写法 ⇒ 只在内容／令牌对得上时挑那个，否则退回自己的词法键。
 */
/**
 * 本会话里**宿主给过的身份键**（{@link ledgerIdentityKey} 的产物）：这一串是**盘上事实**。
 *
 * 为什么把这件事记在键上，而不只靠调用方再递一次 `identityKey`：写路径的区域闸门
 * （`write-path.mjs` 的 `regionGate`）手上只有**已经算好的账本键**
 * （`ledgerIdentityKey(displayPath, options.identityKey)`），它调 `latestObservation(键, …)` /
 * `hasObservedVersion(键, …)` 时不会再递一次身份键 —— 而那儿正是过度拒绝发生的地方。
 * 记在键上，两种入口（显式递进来的身份键 / 已经算好的身份键）才能在查询侧一视同仁。
 *
 * 它同时是**登记侧**的护栏：身份键是盘上事实，跟着别名走会把另一个真文件的观测盖掉
 * （见 {@link registerLedgerKey}）。
 *
 * 会话级：`setObservationStore` 换存储 = 换会话，与别名索引同源一清。
 */
const IDENTITY_KEYS = new Set()
/** 上限与别名索引同量级：512 条身份键远在正常会话之上。 */
const IDENTITY_KEY_LIMIT = 512

/** 记下"这一串是宿主给的盘上事实"（重新插入 = 最近登记的排在后面；超限按插入顺序淘汰）。 */
function rememberIdentityKey(key) {
  if (typeof key !== 'string' || key.length === 0) return
  IDENTITY_KEYS.delete(key)
  IDENTITY_KEYS.add(key)
  while (IDENTITY_KEYS.size > IDENTITY_KEY_LIMIT) IDENTITY_KEYS.delete(IDENTITY_KEYS.values().next().value)
}

/**
 * 查询侧：这次请求说的是**哪一个账本键**。
 *
 * 判据顺序（每一级都比上一级弱，最后一级是"不猜"）：
 *   1. `identityKey` 在场 ⇒ 就是它（**宿主已经做过归一，它是盘上事实**）；
 *   2. 这一串本身是**本会话里宿主给过的身份键** ⇒ 就是它自己，**不许折叠**；
 *   3. 这个折叠类没见过 ⇒ 就是它自己的词法键；
 *   4. 这一类只见过一个写法 ⇒ 就是那一个（写法差异在**没有文件系统事实**时的唯一解释）；
 *   5. 见过 ≥2 个写法 ⇒ 只在内容／令牌对得上时挑那个，否则退回自己的词法键。
 *
 * ## 为什么 1／2 必须排在折叠前面（C62，先红后修）
 *
 * 第 4 级是**平台猜测**：它假设"同一个目录里不会有只差大小写的两个文件"。在大小写敏感目录里
 * 这条不成立，于是"只观测过 `Beta.js`"会让**真正不同**的 `beta.js` 拿到 `Beta.js` 的那份观测
 * ⇒ 无 `expect` 的编辑被 `PATCH_STALE_REGION` 拒掉，而拒绝文本声称 `beta.js` **有过**
 * last observation —— 那是编出来的观测史，同时违反本文件自己写下的契约（从没读过 ⇒ 闸门不拦
 * ＋ 回执带 `unverified_region`）。实测（真壳 + 真 realpath + `fsutil` 开的大小写敏感目录，
 * 读数见 `locator-lab/alias-identity-test.mjs` 段C）：
 *   读 `…\case\Beta.js`（内容 `U one…`）→ 对**从未观测过**的 `…\case\beta.js`（内容 `l one…`）
 *   发无 `expect` 的 `lines=[1,1]` 编辑
 *   ⇒ 改前 `PATCH_STALE_REGION`、磁盘一字未落（方向安全，但契约被破 + 回执不实）；
 *   ⇒ 改后 `applied` + 回执带 `unverified_region`。
 *
 * ## 身份键为什么是权威，折叠为什么不是
 *
 * 身份键不是"路径字符串"，是宿主 `ctx.fs.resolve()` 给的不透明键
 * （`dsh-fs-local` 的实现是 `targetKey: FsTargetKey(await realpath(displayPath))`，
 * `realpath` 来自 `node:fs/promises`）。本机实测（Windows / Node v24）：
 * `fs/promises.realpath` 与 `realpathSync.native` 都**折叠大小写**（大小写不敏感目录里
 * `…\beta.js` / `…\BETA.JS` 都给出盘上真名 `…\Beta.js`），而 `fs.realpathSync`（JS 版）不折叠。
 * ⇒ 身份键是**规范名**：两个不同的身份键就是两个不同的盘上目录项。折叠在这条路上只会盖掉事实。
 * 折叠仍然要留着：独立面 CLI/MCP 与老调用方**不传**身份键，那时它是唯一的跨写法桥梁
 * （`stale-gate-test` 段M 的六种写法里，四种靠 {@link ledgerPathKey} 的词法归一，
 * 大小写那两种靠它）。
 *
 * @param filePath - 调用方给的路径（或已经算好的账本键）
 * @param evidence - `{ source }` 或 `{ token }`；只在第 5 级被用到
 * @param identityKey - 可选的**身份键**：宿主给的文件系统事实（同一份盘上文件 ⇒ 同一个串）
 */
function resolveLedgerKey(filePath, evidence, identityKey = undefined) {
  if (typeof identityKey === 'string' && identityKey.length > 0) return ledgerIdentityKey(filePath, identityKey)
  const key = ledgerPathKey(filePath)
  if (typeof key === 'string' && IDENTITY_KEYS.has(key)) return key
  const bucket = PATH_ALIASES.get(foldPathKey(key))
  if (bucket === undefined) return key
  if (bucket.size === 1) return bucket.values().next().value
  return aliasByEvidence(bucket, evidence) ?? key
}

/**
 * 登记侧：这次的观测**记到哪个键上**。
 *
 * 与查询侧的差别是**证据门槛**：查询侧在"这一类只见过一个写法"时可以直接认定是它；
 * 登记侧要新建一条观测，跟着别名走就会把**另一个真文件**的观测盖掉（大小写敏感的文件系统上
 * `Beta.js` 与 `beta.js` 并存时，段O 钉的就是这一条）。所以只有**新旧内容逐字节相同**时
 * 才跟随别名 —— 那种情况下两个写法可互换，合并不改变任何判据的结果。
 */
/**
 * 账本键的**唯一一道缝**：同一个磁盘文件用哪条路径记账，只在这里决定一次。
 *
 * 归一化有**两半**，缺一不可，而现在两半都有来源：
 *   · 词法半（`.` 段 / 冗余分隔符 / 盘符大小写 / `\` 与 `/`）：{@link ledgerPathKey}，纯函数，
 *     引擎自己能做；
 *   · 文件系统半（junction / 符号链接 / 8.3 短名 / 大小写的**盘上真名**）：只有文件系统能给，
 *     而引擎被 `build/make-bundle.mjs` 的 `copyFile` 守卫禁止直接碰 `node:fs`、按平台分支、
 *     写盘符字面量 ⇒ **必须由宿主把它作为事实递进来**（`ctx.fs.resolve` 给的 `targetKey`
 *     就是这件事：`dsh-fs` 的契约把它定义为「stale guards and target lookup」用的不透明键，
 *     `dsh-fs-local` 的实现是 `realpath`）。
 *
 * 因此本函数有两个入口：
 *   · `identityKey` 传了 ⇒ 它就是**权威**（宿主已经在它自己那一层做过归一），这里只补词法那一层，
 *     账本键就是它；
 *   · 没传（旧的调用方 / 独立面 / 直接调引擎的测试）⇒ 原样返回 `filePath`（键 = 调用方给的写法），
 *     行为与本参数存在之前**逐字节一致**。
 *
 * `filePath` 在两种入口下都不参与**键**的计算（它是回执/诊断里的那个路径，不许换成别的写法）；
 * 它只在没传 `identityKey` 时被原样当作键用 —— 那正是旧行为。
 *
 * 为什么 `identityKey` 也要过一次 {@link ledgerPathKey}：引擎拿到的仍是一个**字符串**，
 * 而 `ledgerPathKey` 是恒安全的（`.` 段与冗余分隔符丢掉永远等价，盘符不区分大小写）。
 * 它**不折叠文件名大小写**，所以「大小写敏感目录里 `Beta.js` 与 `beta.js` 是两个文件」
 * 这条不许破仍然成立：两个真名给出两个键。
 *
 * @param filePath - 调用方给的路径（**显示**用：回执原样回抄、诊断信息里的就是它）
 * @param identityKey - 可选的**身份键**：宿主给的文件系统事实（同一份盘上文件 ⇒ 同一个串）
 * @returns 这个文件在这次会话里记在哪个键下
 */
export function ledgerIdentityKey(filePath, identityKey) {
  if (typeof identityKey !== 'string' || identityKey.length === 0) return filePath
  const key = ledgerPathKey(identityKey)
  if (typeof key !== 'string' || key.length === 0) return filePath
  // 顺带把"这一串是盘上事实"记在键上：查询侧与登记侧都要据此让开折叠（{@link IDENTITY_KEYS}）。
  rememberIdentityKey(key)
  return key
}

/**
 * 把**调用方那种写法**登记到它对应的账本键上。
 *
 * 为什么非它不可（实测出来的，不是推的）：宿主给了身份键之后，事件簿记在
 * `…\realdir\Epsilon.js` 下，而调用方下次可能仍用 `…\linkdir\Epsilon.js` 过来问。
 * 折叠别名索引按**写法**分桶（`foldPathKey`），而 junction 的两种写法不共享任何折叠前缀
 * ⇒ 不登记的话，换个写法查过来就是"没观测过"，闸门重新变瞎（实测序列：读别名 → 读真实路径
 * → 写别名 → 写真实路径：第四步被误拒，而第三步刚写下的观测明明就在账本里）。
 *
 * 方向是安全的：它只把"这个写法"挂到**已经算好的那个键**上，既不新建键，也不合并两个键。
 */
function aliasRememberKey(filePath, key) {
  if (typeof filePath !== 'string' || filePath.length === 0) return
  if (typeof key !== 'string' || key.length === 0 || filePath === key) return
  const bucket = aliasBucket(key)
  bucket.add(filePath)
  // 桶本身也要有上限：只挂写法的那一桶不受 `aliasBucket` 的建桶淘汰约束。
  while (bucket.size > PATH_ALIAS_LIMIT) bucket.delete(bucket.values().next().value)
}

/**
 * 登记侧：这次的观测**记到哪个键上**。
 *
 * 与查询侧的差别是**证据门槛**：查询侧在"这一类只见过一个写法"时可以直接认定是它；
 * 登记侧要新建一条观测，跟着别名走就会把**另一个真文件**的观测盖掉（大小写敏感的文件系统上
 * `Beta.js` 与 `beta.js` 并存时，段O 钉的就是这一条）。所以只有**新旧内容逐字节相同**时
 * 才跟随别名 —— 那种情况下两个写法可互换，合并不改变任何判据的结果。
 */
function registerLedgerKey(filePath, source) {
  const key = ledgerPathKey(filePath)
  /**
   * 身份键是**盘上事实**：登记侧同样不许折叠。
   *
   * 漏了这一条会以另一种形状破同一条禁令：大小写敏感目录里 `Beta.js` 与 `beta.js`
   * 内容**逐字节相同**时，`aliasByEvidence` 会把后读的那一份登记到先读的键上
   * ⇒ 两个真不同的文件被并成一个键（`alias-identity-test` 段C 的 CS-F 直接钉住）。
   * 内容相同并不能改变"宿主说它们是两个目录项"这个事实。
   */
  if (typeof key === 'string' && IDENTITY_KEYS.has(key)) return key
  const bucket = PATH_ALIASES.get(foldPathKey(key))
  if (bucket === undefined || bucket.has(key)) return key
  return aliasByEvidence(bucket, { source }) ?? key
}


/** 换掉观测存储（传 null 恢复默认内存实现）。引擎只依赖上面那五个方法。 */
export function setObservationStore(store) {
  STORE = store ?? createMemoryStore()
  // 观测存储 = 会话账本的宿主。换存储就是换会话，旧账本必须一起清：
  // 留着它，新会话的第一次 `full` 会拿到"你已经读过"的差量，而它从没读过。
  DELIVERED.clear()
  // 顺扫账本同理：它记的是"这个会话读到哪儿了"，换会话之后那条前沿没有意义。
  SCAN.clear()
  // 别名索引同样是**会话级**的：它记的是"这一次会话里这个折叠类出现过哪几种写法"。
  // 与上面三条同源 —— 换存储就是换会话，留着它，新会话会继承上一个会话认出来的写法同一性。
  PATH_ALIASES.clear()
  // 身份键表同理：它记的是"这一次会话里宿主给过哪些盘上事实"。留着它，新会话里一个
  // 从没被认证过的写法会突然享到"盘上事实"的待遇（折叠一律让开）。
  IDENTITY_KEYS.clear()
}

/**
 * 记下某个版本对应的内容，供后续 diff 与新鲜度判据取用。
 *
 * **内容约定只有一套：提供方视角的文本**（= 下一次 `readText` 会看到的东西，不含我们补的 BOM）。
 * BOM 的事实作为**元数据**存在同一条目里，供 `changed` 显式报告"BOM 出现/消失"。
 * 曾经的做法是带 BOM 时给内容加一个 `U+FEFF` 前缀——那是**第二套约定**，直接制造了接缝：
 * 区域级闸门的基准（`readText`）永远是提供方视角，而 `changed` 写进缓存的内容带前缀，
 * 于是"带 BOM + 上次是 changed 读 + 改第 1 行"会被误判成区域变过（实测误拒）。
 */
export function rememberRead(filePath, version, source, byteOrderMark = false, identityKey = undefined) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return
  /**
   * 记账的键只有一处算法（{@link ledgerIdentityKey}）：宿主给了身份事实就听它的，
   * 没有才走 {@link registerLedgerKey} 那条"词法 + 会话内折叠别名 + 内容证据"的老路。
   *
   * 为什么两条路不能**同时**用（一次实测）：第一版把 `registerLedgerKey(filePath)` 的结果
   * 与 `ledgerIdentityKey(filePath, identityKey)` 拼在一起 —— 事件簿落在真身键上，而别名索引
   * 登记在**写法桶**里（junction 的两种写法是两个折叠类）。后果是"读别名 → 读真实路径 →
   * 写别名 → 写真实路径"的第四步查不到第三步刚写下的观测 ⇒ 误拒。所以身份键在场时，
   * 事件簿用身份键、写法桶用 {@link aliasRememberKey} 挂过去，两条路各自走完。
   */
  const key = ledgerIdentityKey(filePath, identityKey)
  if (key === filePath) {
    const registered = registerLedgerKey(filePath, source)
    aliasRemember(registered)
    STORE.remember(registered, version, source, byteOrderMark)
    return
  }
  aliasRemember(key)
  aliasRememberKey(filePath, key)
  STORE.remember(key, version, source, byteOrderMark)
}

/**
 * 这个文件**最近一次被观测到**的全文（供区域级新鲜度闸门当判据）。
 *
 * 从没读过、或那一条已被淘汰 ⇒ null，语义是"没观测过"（闸门不拦，但回执会带 unverified_region）。
 * 每一模式的读都会记账（见 {@link readWith} 的 render），不只是 `changed`。
 */
/**
 * 覆盖集：这次回执展示了哪些行、没展示哪些行。
 *
 * 输入只有两个事实：引擎自己的 `shown`（`"10-20"` / `"none"`）与总行数。
 * 输出用**区间字符串**（`"1-9"` / `"21-40"`），与 `shown` 同一套写法：
 * 调用方不需要额外解析一层嵌套数组，锚点也能直接对着回执核。
 *
 * 它回答的是“行覆盖”，不是“知识覆盖”：`map`/`digest` 给了结构但没给正文，
 * 这里照实报 `covered: []`（正文一行都没展示）。
 */
export function coverageOf(shown, totalLines) {
  const total = Number.isInteger(totalLines) && totalLines > 0 ? totalLines : null
  if (total === null) return null
  const covered = []
  const match = typeof shown === 'string' ? /^(\d+)-(\d+)$/.exec(shown) : null
  if (match !== null) {
    const start = Number(match[1])
    const end = Number(match[2])
    if (start >= 1 && end >= start && end <= total) covered.push([start, end])
  }
  const notCovered = []
  let cursor = 1
  for (const [start, end] of covered) {
    if (start > cursor) notCovered.push([cursor, start - 1])
    cursor = Math.max(cursor, end + 1)
  }
  if (cursor <= total) notCovered.push([cursor, total])
  const fmt = ([start, end]) => (start === end ? `${start}` : `${start}-${end}`)
  return { totalLines: total, covered: covered.map(fmt), notCovered: notCovered.map(fmt) }
}

export function latestObservation(filePath, evidence, identityKey = undefined) {
  if (typeof filePath !== 'string') return null
  /**
   * `evidence` 是可选的**内容证据**：手上已有当前全文时传 `{ source: content }`，
   * 已有令牌时传 `{ token }`。它只在**没有身份键**、且一个折叠类里出现过 ≥2 种写法时才被用到，
   * 而那时它是唯一能替我们回答"该拿哪一份当基准"的东西（理由见 `PATH_ALIASES` 那段）。
   * 不传就等于"没有证据"：那种情况下退回精确键，绝不猜。
   *
   * `identityKey` 是可选的**身份键**（同一份盘上文件 ⇒ 同一个串）：在场时它就是权威，
   * 折叠一律不生效。调用方就算不递它，只要这个键是宿主给过的（{@link IDENTITY_KEYS}），
   * 效果相同 —— 写路径的闸门走的正是后一条路。
   */
  return STORE.latest(resolveLedgerKey(filePath, evidence ?? null, identityKey))
}

/** 缓存条目（内容 + BOM 元数据）；模块内部使用，未命中返回 null。 */
function seenEntry(filePath, version, identityKey = undefined) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return null
  return STORE.entry(resolveLedgerKey(filePath, { token: version }, identityKey), version)
}

/**
 * 记下"这一次交付了哪些行"（1.0.2）。
 *
 * 与 {@link rememberRead} 分开是一步刻意的最小化：版本令牌在渲染之前就有，
 * 而交付范围只有渲染完才知道。条目已经由 `rememberRead` 建好；这里只补一个字段。
 *
 * `filePath` 是**已归一的账本键**（调用方已经过 `ledgerIdentityKey`）——写侧查的是同一个键。
 * 宿主换了自己的存储实现而不认识 `deliver` 时**静默跳过**：没有交付事实的后果是写闸拒绝，
 * 不是崩溃。
 */
/**
 * 条目**实际**落在哪把键下。
 *
 * `rememberRead` 在调用方没给身份键时会把写法登记成一个注册键（`ledgerPathKey` 归一后的），
 * 而调用方手里的 `ledgerKey` 仍是原样写法。1.0.2 的交付记账与写闸查询都是从调用方那把键出发的，
 * 不做这一步就会"记了、查不到"（实测：同一条路径的正斜线与反斜线两种写法是两把键）。
 *
 * 先试归一后的键（绝大多数情况），没有再试调用方原样给的键（身份键/已注册键的路径）。
 */
function locateEntryKey(filePath, version) {
  const resolved = resolveLedgerKey(filePath, { token: version })
  if (STORE.entry(resolved, version) !== null) return resolved
  if (STORE.entry(filePath, version) !== null) return filePath
  return resolved
}

export function rememberDeliveredRows(filePath, version, ranges) {
  if (typeof filePath !== 'string' || filePath.length === 0) return
  if (typeof version !== 'string' || version.length === 0) return
  if (!Array.isArray(ranges) || ranges.length === 0) return
  if (typeof STORE.deliver !== 'function') return
  const key = locateEntryKey(filePath, version)
  const existing = STORE.entry(key, version)?.delivered ?? []
  STORE.deliver(key, version, mergeLabels(existing, ranges))
}

/**
 * 这一版交付过哪些行（`["1-166"]`；没交付过 ⇒ `[]`）。
 *
 * 写闸用它回答"要替换的那段，调用方到底看没看过"。查不到不等于"看过"——
 * 空数组就是空数组，闸门据此拒绝（这是 1.0.2 修的那条：probe/map 读之后整份覆写过闸）。
 */
export function deliveredRanges(filePath, version, identityKey = undefined) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return []
  if (typeof STORE.entry !== 'function') return []
  const resolved = resolveLedgerKey(filePath, { token: version }, identityKey)
  const entry = STORE.entry(resolved, version) ?? STORE.entry(filePath, version)
  return Array.isArray(entry?.delivered) ? entry.delivered : []
}

/**
 * 这个"路径@版本"是否在观测账本里（不取全文，所以不受缓存上限之外的额外代价）。
 *
 * 用法只有一处，但很关键：区域级新鲜度闸门要判断**当前内容是不是我们观测过的那一版**。
 * 若不在账本里，说明这份内容是在我们最后一次观测之后由别人写下的——
 * 那时模型手上的行号来自更早的一版，而**没有任何东西**能替它发现这件事：
 * 写侧的版本 CAS 在一次调用内部取 `stat`，调用之前发生的第三方写入对它是"当前状态"。
 *
 * `latestObservation` 回答不了这个问题：它按**路径**给最新一条，而"最新"不等于"就是现在这份"。
 */
export function hasObservedVersion(filePath, version, identityKey = undefined) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return false
  return STORE.has(resolveLedgerKey(filePath, { token: version }, identityKey), version)
}

/** 取回某个版本的**全文**；未命中返回 null（缓存有界，这是正常情况而非错误）。 */
export function recallRead(filePath, version, identityKey = undefined) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return null
  return STORE.recall(resolveLedgerKey(filePath, { token: version }, identityKey), version)
}

/** 仅供测试与诊断：当前缓存条目数。 */
export function seenCount() {
  return STORE.count()
}

/**
 * changed —— 自上次读取以来变了什么。
 *
 * 这是 read 最真实的浪费：同一个文件在一次会话里常被读两三次，而其中大部分内容没变。
 * 旧 read 每次都重发全文（再被剪到 10%），于是"重读一次"等于"再付一次钱"。
 *
 * 设计要点：**模型只持有一个小令牌，全文由工具按令牌存着。**
 *
 * 我试过把全文放进返回值（多一个 `full` 字段），那条路是错的——查过剪枝实现后确认：
 * 下游剪枝只作用于 `content` 里的 text block，**不碰其它字段**。所以"放在另一个字段里"
 * 并不能躲过模型的眼睛，它会原样送达，于是每次重读仍要付全文的钱，节省全部作废。
 * 唯一正确的做法是让全文**不进入返回值**。
 *
 * 缓存有界。未命中（换进程、或被淘汰）时诚实降级为"没有基准可比"，不假装能 diff。
 */
function renderChanged(base, source, lines, request, symbolsIndex = null, ledgerKey = request.filePath ?? null) {
  /**
   * 这里不再算第二个身份：账本键由调用方（{@link readWith}）算好递进来，本函数只用它
   * —— 两处各算一遍就是本条明令禁止的"归一化写两遍"。
   */
  /**
   * `since` 不是字符串时（缺省／null／其它类型）一律当作**没有基准**，也就是首读。
   *
   * 先前这里把非字符串的 `since` 当成"首读哨兵"并返回 `version: null`。那个 null 传不下去：
   * 工具声明的 schema 里 version 是 string，框架对字符串字段做类型校验
   * （dsh-tools/lib/index.js:495 `typeof value === "string"`），于是 null 会被判违规：
   *   tool "aura_basetools_read" returned invalid output: "value.version" must be a string
   * 更糟的是它**没意义**：回执的 next 让模型"把 version 传回来"，而 null 传回来又落回同一分支——
   * 一个永远解不开的环。现在首读也给真令牌，环就断了。
   */
  const sinceRaw = typeof request.since === 'string' && request.since.length > 0 ? request.since : null
  const byteOrderMark = request.byteOrderMark === true
  const version = contentToken(source, byteOrderMark)
  const sinceVersion = sinceRaw !== null && sinceRaw !== '<first>' ? sinceRaw : null
  /**
   * 身份键顺下来（有才有效）：`ledgerKey` 已经是账本身份键，但显式递一次让"身份键在场 ⇒ 不折叠"
   * 在**每条入口**上都成立，而不是靠调用顺序。
   */
  const prevEntry = sinceVersion === null ? null : seenEntry(ledgerKey, sinceVersion, request.identityKey)
  const prev = prevEntry === null ? null : prevEntry.source
  const bomBefore = prevEntry !== null && prevEntry.byteOrderMark === true

  // 把当前版本记下，供下一次比对：内容一律是**提供方视角文本**，BOM 作为元数据一并存（只有一套约定）。
  // 身份键一并递下去：别名索引要按**调用方那种写法**登记，否则下一次换个写法查过来就落空。
  rememberRead(ledgerKey, version, source, byteOrderMark, request.identityKey)

  if (sinceVersion === null) {
    return {
      ...base,
      mode: 'changed',
      version,
      note: 'first read — nothing to compare against',
      next: "pass `since` = this result's `version` to get a delta next time",
      // 统一契约：**每个模式都返回 `text`**。这四条"没内容可给"的路径原先不给 `text`，
      // 调用方（尤其模型）会把"字段缺失"读成"文件是空的"——静默换语义的另一种形态。
      text: 'first read — nothing to compare against; pass `since` = this version to get a delta next time',
    }
  }
  if (sinceVersion === version) {
    return {
      ...base,
      mode: 'changed',
      version,
      note: 'no change since that version',
      text: 'no change since that version',
    }
  }
  if (prev === null) {
    /**
     * 缓存未命中：换进程、被淘汰，或**大文件只记了令牌、没保留全文**（`source_omitted`）。
     * 最后一种不是“过期”，说成“no longer cached”会让调用方以为重读一次就能修好——
     * 它即使重读，>256 KiB 的全文仍然不会进缓存。把两种事实分开说。
     */
    const omitted = prevEntry?.source_omitted === true
    const note = omitted
      ? 'that revision is in the ledger, but the file exceeds 256 KiB so its full text was not retained — cannot diff; read the regions you need'
      : 'that version is no longer cached — cannot diff; read the regions you need'
    return {
      ...base,
      mode: 'changed',
      version,
      note,
      next: 'mode=map then mode=lines',
      text: `${note} (next: mode=map then mode=lines)`,
    }
  }

  const before = prev.split('\n')
  // 逐行最长公共前后缀：给出"变了哪一段"，而不是整文件
  let head = 0
  while (head < before.length && head < lines.length && before[head] === lines[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head &&
    tail < lines.length - head &&
    before[before.length - 1 - tail] === lines[lines.length - 1 - tail]
  ) {
    tail += 1
  }
  const from = head + 1
  const to = lines.length - tail
  if (to < from) {
    /**
     * 行文本逐行相同、令牌却不同 ⇒ 只可能是 BOM 变了（令牌的判据含 BOM）。
     * 显式点名这件事，而不是说“没变”：令牌变了却说没变就是自相矛盾。
     * BOM 在偏移 0 ⇒ 它就是第 1 行的开头，窗口取第 1 行。
     */
    if (bomBefore !== byteOrderMark) {
      const label = byteOrderMark ? 'the byte-order mark was added' : 'the byte-order mark was removed'
      const win = windowEnvelope({ ...base, ok: true, mode: 'changed' }, lines, 1, Math.min(1, lines.length), 'changed region', 1)
      return { ...win, version, note: `${label} since that version (the text itself is unchanged)` }
    }
    return {
      ...base,
      mode: 'changed',
      version,
      note: 'no change since that version',
      text: 'no change since that version',
    }
  }
  // 变更窗口两侧各留 3 行上下文，保证模型看清它在哪个函数里
  const ctxFrom = Math.max(1, from - 3)
  const ctxTo = Math.min(lines.length, to + 3)
  // windowEnvelope 铺开 base，而 base 里没有 ok（它在调用处才补上），所以这里显式带上
  const win = windowEnvelope({ ...base, ok: true, mode: 'changed' }, lines, ctxFrom, ctxTo, 'changed region', from)
  return {
    ...win,
    version,
    // 正文也变了、BOM 同时也变了时，两个事实都要说（令牌是内容+BOM 的指纹）
    ...(bomBefore === byteOrderMark
      ? {}
      : { note: `the byte-order mark was ${byteOrderMark ? 'added' : 'removed'} since that version` }),
  }
}

/** UTF-8 BOM 的字符形态：解码后就是一个 U+FEFF。 */
export const BYTE_ORDER_MARK = '\uFEFF'

/** UTF-8 BOM 的字节形态（EF BB BF）。 */
export const BYTE_ORDER_MARK_BYTES = [0xef, 0xbb, 0xbf]

/**
 * 这份字节是不是以 UTF-8 BOM 开头。
 *
 * 为什么判据必须是**字节**：提供方的 `readText` 用 `new TextDecoder('utf-8', {fatal:true})`
 * 解码，而 `ignoreBOM` 默认 false ⇒ BOM 根本不会进入解码后的字符串；写回用 TextEncoder，
 * 从不产 BOM。所以"这个文件带不带 BOM"在字符串层已经无法回答，只能问原始字节
 * （提供方接口：`readByteRange`，见 dsh-fs-local 的 `lib/types/index.d.ts`）。
 *
 * @param bytes - 文件头部的原始字节（可能不足三个）
 * @returns 真表示以 EF BB BF 开头
 */
export function startsWithByteOrderMark(bytes) {
  return countByteOrderMarks(bytes) > 0
}

/**
 * 这份字节开头**连续几个** UTF-8 BOM。
 *
 * 为什么必须是个数而不是布尔：本部署的解码器（`TextDecoder`，`ignoreBOM` 默认 false）只吃掉
 * **第一个** BOM，文件里第二个 BOM 会以 U+FEFF 的身份留在文本里。用布尔 + “已经有了就不加”
 * 的幂等守卫，就会把“文本开头那个 U+FEFF 是**内容**”误判成“提供方已经把 BOM 留在文本里了”，
 * 于是 `BOM+BOM+…` 的文件编辑后少一个 BOM（实测 23 → 22 字节，且首字节看着仍是 BOM——静默删字节）。
 *
 * @param bytes - 文件头部的原始字节（可能不足三个）
 * @returns 前导 BOM 的个数（0、1、2…）
 */
export function countByteOrderMarks(bytes) {
  if (bytes === undefined || bytes === null) return 0
  const width = BYTE_ORDER_MARK_BYTES.length
  let n = 0
  while (bytes.length >= (n + 1) * width && BYTE_ORDER_MARK_BYTES.every((b, i) => bytes[n * width + i] === b)) n += 1
  return n
}

/**
 * 文本开头**连续几个** U+FEFF（= 这份内容自己携带了几个 BOM）。
 *
 * 与 {@link countByteOrderMarks} 配合回答“还差几个”：字节里有 B 个、内容里已有 T 个，
 * 就补 `B - T` 个（只补不删：`replace` 自己写进内容的 U+FEFF 是调用方的显式意图）。
 *
 * @param text - 解码后的文本
 * @returns 前导 U+FEFF 的个数
 */
export function leadingByteOrderMarks(text) {
  let n = 0
  while (text !== undefined && text !== null && text[n] === BYTE_ORDER_MARK) n += 1
  return n
}

/**
 * 内容指纹：用于 changed 模式的比对。变化敏感、且不依赖 mtime。
 *
 * 带 BOM 的文件按**含 U+FEFF 的内容**算——否则只差一个 BOM 的两个文件会拿到同一个令牌，
 * `changed` 会说"没变"。令牌因此与落盘字节、与写路径带回的内容给出一致答案。
 *
 * **哈希本体不在这里**：它是 `handle-core.mjs` 的 {@link fnv1a32}（全仓唯一一份 FNV-1a）。
 * 句柄的区间摘要（`regionFingerprint`）取的是同一个哈希的前 8 位，所以"整文件令牌"与
 * "区间摘要"在 BOM 口径上永远一致——两边各自实现一份就可能漂开，而漂开是静默的。
 * 搬家的边界很窄：**只有哈希那几行**搬了，下面这个返回串的形状（`指纹:长度`）
 * 与 `effective` 的口径都逐字未改（否则 `changed` 与既有判据全要重算）。
 *
 * @param source - 解码后的全文
 * @param byteOrderMark - 这份文件是否带 UTF-8 BOM（判据只能是字节，见 {@link startsWithByteOrderMark}）
 */
export function contentToken(source, byteOrderMark = false) {
  const effective = byteOrderMark ? BYTE_ORDER_MARK + source : source
  return `${fnv1a32(source, byteOrderMark)}:${effective.length}`
}

/* ── 同会话增量读 ──────────────────────────────────────────────────────────
 *
 * ## 它治的是什么
 *
 * 实测：15,935 次 aura_basetools_read 里 **63.8%** 是同一会话内对**已读文件**的重复读，
 * 那些回执合计 53.8M 字符。重复读里绝大多数行根本没变——再发一遍全文，
 * 是把已经给过的东西再收一次钱。
 *
 * ## 判据不是"我记得这个路径"，而是"我确知你手里有这份内容的完整一份"
 *
 * 账本记的是**交付事实**（版本 + 是否完整），不是读取次数：
 *   · 一次完整的 `full` 交付 ⇒ covered = true；
 *   · 被预算截断的 `full` ⇒ covered = false。拿半份当基准做差量会**静默丢掉
 *     调用方从没见过的那些行**——那正是本模块开头列的第一类缺陷；
 *   · `map` / `digest` / `lines` / `around` / `search` 不改变这个事实：它们既不能
 *     证明调用方有全文，也不能推翻他先前拿到过全文。
 *
 * 任何一条不成立就退回全量，并把**为什么退**写进回执的 `note`——拿不到可信基准时
 * 只有两种正确行为：给全量，或者给全量加一句解释。绝不猜。
 *
 * ## 适用范围：只叠在"把文件给我"这个请求上
 *
 * 增量挂在**整文件内容**模式（`full`，含 auto 选中 full）之上。结构模式
 * （map／digest）与定向模式（lines／around／search）的语义**一个字都不动**：
 * 它们要的不是同一件东西（一个要索引，一个要指定区间），把答案换成一段差量是换答案，
 * 不是省字节。
 *
 * ## 会话边界
 *
 * 账本活在模块实例里（= 一个 realm），随 {@link setObservationStore} 一起重置：
 * DSH 里读工具与剪枝器同处一个 isolate realm，账本因此天然是会话级的；
 * 宿主若在一个 realm 里跑多个会话，必须为每个会话换一个观测存储，
 * 否则"另一个会话读过"会被当成"你读过"——那时回执里的 `next` 是唯一出口。
 */

/** 差量窗口两侧各留几行上下文（与 changed 同值：都要让模型看清它在哪个函数里）。 */
const DELTA_CONTEXT = 3

/**
 * 参与差分的行数上限（两侧之和）。
 *
 * 差分的代价随规模与编辑距离增长，而 read 是**每次调用都要付**的路径：
 * 在上万行的文件上做全量差分，会把"读一次"从毫秒级拖到百毫秒级，而那时差量本身
 * 也已经不比全文省。超过就退回全量，并在回执里说明是为什么。
 */
const MAX_DIFF_LINES = 20000

/** Myers 的编辑距离上限；超过就退化成"整段替换"（仍然**完整**，只是不精细）。 */
const MAX_DIFF_D = 512

/** 会话交付账本：路径 → { version, covered, bom }。 */
const DELIVERED = new Map()
/** 账本容量。比观测缓存大：它只存三个短字段，却决定"还能不能做差量"。 */
const DELIVERED_LIMIT = 64

function ledgerGet(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  // 交付账本与观测账本同源：同一个磁盘文件换一种写法，不该被当成两个文件。
  // 这里只用**词法**归一（不带别名索引）：它决定的是"还能不能做差量"这个**报告层**判断，
  // 最坏的后果是重发一次全文，而不是静默改错；而它记的内容令牌与别名索引不同源，
  // 拿证据去那边比对只会多一层耦合。大小写那半条因此只在观测账本（= 写侧闸门的基准面）生效。
  return DELIVERED.get(ledgerPathKey(filePath)) ?? null
}

function ledgerSet(filePath, version, covered, bom) {
  if (typeof filePath !== 'string' || filePath.length === 0) return
  const key = ledgerPathKey(filePath)
  DELIVERED.delete(key)
  DELIVERED.set(key, { version, covered: covered === true, bom: bom === true })
  while (DELIVERED.size > DELIVERED_LIMIT) DELIVERED.delete(DELIVERED.keys().next().value)
}

/**
 * 顺扫账本：路径 → `{ version, frontier }`，`frontier` = **第一个还没交付的行号**。
 *
 * ## 为什么需要它（而它为什么必须是会话级的）
 *
 * 真实会话里的读不是孤立的。R5 的实测（`probes/reread-cause.mjs`）：14,728 次重复读里
 * 999 次（占全新区间重复读的 13.1%）是**顺着文件往下扫**——模型自己挑一个 N，
 * `lines=[a, a+N]` 一段一段往下翻，每一次都只拿到它开口要的那 N 行，
 * 而内容预算装得下好几倍。原始读数里这样的例子很多：`req=[1030,1060]` 交付 `[1030,1060]`
 * 只用了 1740 字符，而当时的内容预算是 7492。
 *
 * ## 为什么不能只看这一次请求就决定「多给」
 *
 * `lines=[a,b]` 的语义就是「给我 a..b」，多给就改了语义——既有套件把这条钉死了
 * （`range-args-test` 断言 `start_line: 2` 只回第 2 行、`lines: [1,2]` 只回 1-2 行）。
 * 而「一个孤立的定向读」与「接着上一次没给完的地方继续」**在参数上长得一模一样**，
 * 靠请求本身分不开。所以判据落在会话状态上：
 *
 *   · 一次窗口读**因为内容预算**而没给完 ⇒ 记下前沿（第一个未交付的行号）；
 *   · 下一次请求的起点落在前沿附近（≤ {@link SCAN_SLACK}）**且伸进未交付区** ⇒ 同一次顺扫，
 *     于是把窗口开到文件末尾，让预算装满为止；
 *   · 一次**没有**被预算截断的窗口读 ⇒ 清账（孤立的定向读不该被上一轮扫描带跑）；
 *   · 版本变了 ⇒ 清账（内容换了，行号前沿就没有意义）。
 *
 * 这条账只影响**给多少**，不影响**给什么**：窗口永远从请求的起点开始、按文件顺序、
 * 不越过文件末尾——因此「文件没变时不会因为顺扫多给不存在的内容」是可判定的。
 */
const SCAN = new Map()

/**
 * 前沿两侧允许多大的错位还算「同一段顺扫」。
 *
 * 200 不是拍的：它取自 `probes/reread-cause.mjs` 的 `SWEEP_MAX_GAP`——那个探针
 * 用同一个阈值量出了「顺扫 999 次 = 13.1%」这个数，这里沿用同一把尺子。
 * 换一个数就会出现「回执按一套尺子判顺扫、读数按另一套量顺扫」的错位。
 */
const SCAN_SLACK = 200

function scanGet(filePath, version) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  const entry = SCAN.get(filePath)
  if (entry === undefined || entry.version !== version) return null
  return entry
}

/** `frontier === null` = 清账（这一段顺扫已经给完）。 */
function scanSet(filePath, version, frontier) {
  if (typeof filePath !== 'string' || filePath.length === 0) return
  SCAN.delete(filePath)
  if (frontier === null) return
  SCAN.set(filePath, { version, frontier })
  while (SCAN.size > DELIVERED_LIMIT) SCAN.delete(SCAN.keys().next().value)
}

/**
 * 这次请求是不是「同一次顺扫的下一段」。
 *
 * 三个条件缺一不可，且都只看这一次请求 + 会话账本，不看任何启发式：
 *   1. 本文件当前版本有未交付的前沿（上一次窗口读被预算截断留下的）；
 *   2. 请求起点 ≤ 前沿 + {@link SCAN_SLACK}（模型重叠几行、或跳几行，都还算往下翻）；
 *   3. 请求终点 ≥ 前沿（这次确实伸进了没给过的区域，不是把给过的再点一遍）。
 */
/**
 * 这次请求是不是「同一次顺扫的下一段」。
 *
 * 三个条件缺一不可，且都只看这一次请求 + 会话账本，不看任何启发式：
 *   1. 本文件当前版本有未交付的前沿（上一次窗口读被预算截断留下的）；
 *   2. 请求起点 ≤ 前沿 + {@link SCAN_SLACK}（模型重叠几行、或跳几行，都还算往下翻）；
 *   3. 请求终点 ≥ 前沿（这次确实伸进了没给过的区域，不是把给过的再点一遍）。
 *
 * `key` 是**账本身份键**（由 {@link ledgerIdentityKey} 算好递进来），不是显示路径：
 * 顺扫的前沿属于「这份盘上文件读到哪儿了」，与调用方这次怎么拼写路径无关。
 */
function planScan(mode, request, key, version, total) {
  if (mode !== 'lines') return null
  const range = request.lines
  if (!Array.isArray(range) || range.length === 0) return null
  const start = range[0]
  const end = range[1] ?? range[0]
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const entry = scanGet(key, version)
  if (entry === null) return null
  if (!Number.isInteger(entry.frontier) || entry.frontier < 1 || entry.frontier > total) return null
  if (!(start <= entry.frontier + SCAN_SLACK && end >= entry.frontier)) return null
  return { extend: true, frontier: entry.frontier }
}

/**
 * 按**最终发出去的那一份**记顺扫账。
 *
 * 只有经由 `windowEnvelope` 的回执才有 `shown`——`changed` 的差量与「no change」
 * 没有行区间可言，那时**什么都不动**（不清账也不记前沿），
 * 否则一次无关的 `changed` 会把正在进行的顺扫打断。
 */
/**
 * 按**最终发出去的那一份**记顺扫账。
 *
 * 只有经由 `windowEnvelope` 的回执才有 `shown`——`changed` 的差量与「no change」
 * 没有行区间可言，那时**什么都不动**（不清账也不记前沿），
 * 否则一次无关的 `changed` 会把正在进行的顺扫打断。
 *
 * `key` 与 {@link planScan} 同源：两者必须是**同一个账本身份键**（由
 * {@link ledgerIdentityKey} 算好递进来），否则"记在前沿 A、查在前沿 B"会让顺扫
 * 断在调用方换了一种路径写法的那一次上。
 */
function recordScan(mode, key, version, result, total) {
  if (mode !== 'lines' && mode !== 'full') return
  if (result === null || result === undefined || result.ok === false) return
  const shown = result.shown
  if (typeof shown !== 'string') return
  if (shown === 'none') {
    scanSet(key, version, 1)
    return
  }
  const match = /^(\d+)-(\d+)$/.exec(shown)
  if (match === null) return
  const deliveredTo = Number(match[2])
  const pending = result.resume !== undefined && result.resume.mode === 'lines'
  scanSet(key, version, pending && deliveredTo < total ? deliveredTo + 1 : null)
}

/**
 * 行级编辑脚本（Myers 贪心，带编辑距离上限）。
 *
 * 为什么不用"公共前后缀"了事（`renderChanged` 的做法）：那只能给出**一个**变更段，
 * 两处相隔很远的改动之间的整段未改内容会被一并算进"变了"——差量于是和全文一样大，
 * 省流层等于不存在。
 *
 * 上限（`MAX_DIFF_D`）不是优化而是**诚实性**的一部分：超限时退化成"整段替换"，
 * 它多报（把没变的行也说成变的）但**绝不漏报**。漏报才会让调用方以为手里那份还是新的。
 *
 * @returns {{type: ' '|'-'|'+', text: string}[]} 对齐后的操作序列
 */
function myersOps(a, b, maxD) {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ type: '+', text }))
  if (m === 0) return a.map((text) => ({ type: '-', text }))
  const max = Math.min(maxD, n + m)
  const offset = max
  const v = new Int32Array(2 * max + 1)
  const trace = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(Int32Array.from(v))
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return null
  const ops = []
  let x = n
  let y = m
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]) ? k + 1 : k - 1
    const prevX = prev[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: ' ', text: a[x - 1] })
      x -= 1
      y -= 1
    }
    if (x === prevX) {
      ops.push({ type: '+', text: b[y - 1] })
      y -= 1
    } else {
      ops.push({ type: '-', text: a[x - 1] })
      x -= 1
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: ' ', text: a[x - 1] })
    x -= 1
    y -= 1
  }
  while (x > 0) {
    ops.push({ type: '-', text: a[x - 1] })
    x -= 1
  }
  while (y > 0) {
    ops.push({ type: '+', text: b[y - 1] })
    y -= 1
  }
  ops.reverse()
  return ops
}

/** 两份行数组的编辑脚本：先削公共前后缀（最常见的情形），中段才交给 Myers。 */
function diffOps(before, after) {
  const n = before.length
  const m = after.length
  let head = 0
  while (head < n && head < m && before[head] === after[head]) head += 1
  let tail = 0
  while (tail < n - head && tail < m - head && before[n - 1 - tail] === after[m - 1 - tail]) tail += 1
  const ops = []
  for (let i = 0; i < head; i += 1) ops.push({ type: ' ', text: before[i] })
  const midOld = before.slice(head, n - tail)
  const midNew = after.slice(head, m - tail)
  const mid = myersOps(midOld, midNew, MAX_DIFF_D)
  if (mid === null) {
    // 编辑距离超上限：退化成整段替换。多报可以，漏报不行。
    for (const text of midOld) ops.push({ type: '-', text })
    for (const text of midNew) ops.push({ type: '+', text })
  } else {
    for (const op of mid) ops.push(op)
  }
  for (let i = n - tail; i < n; i += 1) ops.push({ type: ' ', text: before[i] })
  return ops
}

/**
 * 把编辑脚本切成 unified diff 的 hunk（变更段两侧各 3 行上下文，相邻的合并）。
 *
 * 行号约定照 GNU diff：`@@ -旧起点,旧行数 +新起点,新行数 @@`；**行数为 0 时**
 * 起点是该侧的**插入位（0-based）**，否则是 1-based 的首行。重放器必须照这个约定写
 * （见 `incremental-read-test.mjs` 的 `applyDelta`）。
 */
function diffHunks(ops, context = DELTA_CONTEXT) {
  const oldBefore = new Array(ops.length + 1)
  const newBefore = new Array(ops.length + 1)
  let o = 0
  let s = 0
  for (let i = 0; i < ops.length; i += 1) {
    oldBefore[i] = o
    newBefore[i] = s
    if (ops[i].type !== '+') o += 1
    if (ops[i].type !== '-') s += 1
  }
  oldBefore[ops.length] = o
  newBefore[ops.length] = s
  const runs = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].type === ' ') {
      i += 1
      continue
    }
    let end = i
    while (end < ops.length) {
      if (ops[end].type === ' ') {
        let j = end
        while (j < ops.length && ops[j].type === ' ') j += 1
        // 两段变更之间只隔得下上下文：合并成一个 hunk，别把它切成两个
        if (j < ops.length && j - end <= context * 2) {
          end = j
          continue
        }
        break
      }
      end += 1
    }
    runs.push([i, end - 1])
    i = end
  }
  const spans = []
  for (const [from, to] of runs) {
    const start = Math.max(0, from - context)
    const stop = Math.min(ops.length - 1, to + context)
    const last = spans[spans.length - 1]
    if (last !== undefined && start <= last.to + 1) last.to = Math.max(last.to, stop)
    else spans.push({ from: start, to: stop })
  }
  return spans.map(({ from, to }) => {
    const oldCount = oldBefore[to + 1] - oldBefore[from]
    const newCount = newBefore[to + 1] - newBefore[from]
    return {
      oldStart: oldCount === 0 ? oldBefore[from] : oldBefore[from] + 1,
      oldCount,
      newStart: newCount === 0 ? newBefore[from] : newBefore[from] + 1,
      newCount,
      lines: ops.slice(from, to + 1),
    }
  })
}

/** 渲染差量正文：两端令牌写在 `---` / `+++` 上，**回执自带基准**，不靠别处交代。 */
function renderDeltaBody(baselineToken, currentToken, hunks) {
  const rows = [`--- baseline ${baselineToken}`, `+++ current ${currentToken}`]
  for (const h of hunks) {
    rows.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`)
    for (const line of h.lines) rows.push(`${line.type}${line.text}`)
  }
  return rows.join('\n')
}

/** 给一份已经渲染好的信封补一句说明（`note` 已存在就接在后面，不覆盖）。 */
function withBaselineNote(env, note) {
  return { ...env, note: env.note === undefined ? note : `${env.note}; ${note}` }
}

/**
 * 增量层能不能上：**只看证据**。
 *
 * 每次判定都返回一个 kind，绝不"尽量试"：
 *   · `skip`     —— 没有可用的证据（也从未被显式要求增量）：行为与本层存在前**逐字节一致**；
 *   · `no-change`—— 文件与账本里那一版逐行相同（或只差 BOM）：不给正文；
 *   · `delta`    —— 有完整基准可比：给 unified diff；
 *   · `degrade`  —— 有证据表明调用方读过，但基准不可信/不可取/太贵：**全量 + 说明**。
 *
 * `request.incremental`：`true` 表示调用方**显式要求**增量（那时连"没观测过"也要给解释，
 * 否则"为什么又是全文"没有答案）；`false` 是逃生门，强制全量（诊断与对照用）。
 */
function planIncremental(request, lines, version) {
  if (request.incremental === false) return { kind: 'skip' }
  const filePath = request.filePath
  const asked = request.incremental === true
  if (typeof filePath !== 'string' || filePath.length === 0) return { kind: 'skip' }
  const entry = ledgerGet(filePath)
  if (entry === null) {
    return asked
      ? { kind: 'degrade', asked: true, reason: 'the incremental read was asked for, but this file has not been observed in this session — there is no baseline to diff against, so here is the full text' }
      : { kind: 'skip' }
  }
  if (entry.version === version) {
    /**
     * 同一版重读：**只有账本里那份是完整交付时**，“不发正文”才成立。
     *
     * 上一次被预算截断（`covered = false`）时，调用方手里只有前半份。旧实现仍走
     * `no-change`，只回一句“去用 lines 拿剩下的”，于是**显式提高 budget 的请求被吞掉**：
     * 实测 401 行文件第二次 `full` + `budget: 60000` 只拿到 155 字符，且 `truncated: false`——
     * 程序化调用方会把它当成“已拿全”。（反馈 D4）
     *
     * 现在：没被显式要求增量 ⇒ `skip`（普通 full 渲染，按本次 budget 出正文）；
     * 被显式要求增量 ⇒ `degrade`（全文 + 为何不能给差量）。两者都不会再谎报“没变化”。
     */
    if (entry.covered !== true) {
      return asked
        ? { kind: 'degrade', asked: true, reason: 'your earlier read of this file was cut at the content budget, so the ledger copy is not a complete baseline; the full text follows' }
        : { kind: 'skip' }
    }
    return { kind: 'no-change', baseline: entry.version, asked, bomChanged: false }
  }
  if (entry.covered !== true) {
    return asked
      ? { kind: 'degrade', asked: true, reason: `your earlier read of this file was cut at the content budget, so it is not a complete baseline (baseline ${entry.version}); the full text follows` }
      : { kind: 'skip' }
  }
  // 身份键在手就递下去（宿主事实优先）：观测账本本来就按身份键记，这里少一次"写法 vs 盘上"的对不上。
  const beforeEntry = seenEntry(filePath, entry.version, request.identityKey)
  const before = beforeEntry === null ? null : beforeEntry.source
  if (before === null) {
    /**
     * 账本说“你读过”，但没有可 diff 的全文。两种原因要分开：
     *   · `source_omitted`：文件超过 256 KiB，**按设计**不保留全文（重读也不会改变）；
     *   · 否则：有界缓存淘汰 / 换进程（重读可以恢复）。
     */
    if (beforeEntry?.source_omitted === true) {
      return { kind: 'degrade', asked, reason: `the baseline you read earlier (${entry.version}) is in the ledger, but this file exceeds 256 KiB so its full text was not retained; cannot diff — the full text follows` }
    }
    // 账本说"你读过"，缓存却说"我没有那份内容"——有界缓存淘汰或换进程都会走到这里
    return { kind: 'degrade', asked, reason: `the baseline you read earlier (${entry.version}) is no longer in the bounded observation cache, so it cannot be diffed; the full text follows` }
  }
  const beforeLines = before.split(/\r?\n/)
  if (beforeLines.length + lines.length > MAX_DIFF_LINES) {
    return { kind: 'degrade', asked, reason: `this file is too large to diff within the incremental budget (${beforeLines.length + lines.length} lines > ${MAX_DIFF_LINES}); the full text follows` }
  }
  const ops = diffOps(beforeLines, lines)
  const hunks = diffHunks(ops)
  const bom = request.byteOrderMark === true
  if (hunks.length === 0) {
    // 行文本逐行相同、令牌却不同 ⇒ 只可能是 BOM 变了（令牌是内容+BOM 的指纹）
    return { kind: 'no-change', baseline: entry.version, asked, partial: false, bomChanged: entry.bom !== bom }
  }
  const changed = ops.reduce((n, op) => n + (op.type === ' ' ? 0 : 1), 0)
  return { kind: 'delta', baseline: entry.version, asked, hunks, changed, unchanged: ops.length - changed }
}

/** 文件没变时的回执：**明写 no change、明写基准令牌，不给正文**。 */
function noChangeEnvelope(base, plan, total) {
  const bom = plan.bomChanged === true ? ' (the byte-order mark changed; the text itself is unchanged)' : ''
  const note = `no change since baseline ${plan.baseline} — the file is byte-identical to the copy you already have${bom}`
  return { ...base, mode: 'full', note, text: `no change since baseline ${plan.baseline} — nothing to send${bom}`, next: `mode=lines lines=[1,${total}] to get the whole text again` }
}

/**
 * 增量层的总装：给一个 `full` 请求挑回执。
 *
 * ## 一条压过一切的判据：**只在真的更省时才说话**
 *
 * 两条增量路径都要过这一关，而不是只给差量把关：
 *   · 差量在改得满篇都是时比全文还长（unified diff 每行都要多一个前缀）；
 *   · `no change` 的说明是**固定开销**，在正文只有几个字符的文件上比正文还长——
 *     那时返回一段解释是倒贴。实测：只含 BOM 的文件全文 5 字符（`1: \uFEFF`），
 *     而"no change"回执两百多字符。
 * 判据取**序列化后的信封体量**（与下游剪枝量的是同一个数），而不是 `text.length`：
 * 说明字段（note／next／omitted）也是要付钱的字节。
 *
 * 返回 `{ env, record }`：`record` 是"这次交付该怎么记进账本"（null = 按普通 full 记）。
 * 退成全文时的说辞只在**显式要求增量**（`request.incremental === true`）时才附上：
 * 那时调用方要的明确是增量，"为什么还是全文"必须有答案；自动路径下省字节优先，
 * 沉默就是答案（全文本身已经回答了那个问题）。
 */
function renderIncremental(base, lines, symbolsIndex, plan, budget, total, handleContext = null) {
  // `handleContext` 在这里**不被消费**：`full` 不发句柄（见 `readWith` 里的长注释）。
  // 参数留着是为了让调用点不必按模式分叉——去掉它就得在调用处再判一次模式。
  const full = () => renderFull(base, lines, symbolsIndex)
  if (plan.kind === 'skip') return { env: full(), record: null }
  const ref = full()
  const refSize = serializedSize(ref)
  /** 退成全文的路径一律按普通 full 记账。 */
  const fallback = (why) => ({ env: plan.asked === true ? withBaselineNote(ref, why) : ref, record: null })
  if (plan.kind === 'no-change') {
    const env = noChangeEnvelope(base, plan, total)
    const size = serializedSize(env)
    if (size < refSize) return { env, record: { covered: plan.partial !== true } }
    return fallback(`a no-change receipt would be larger than the text itself (${size} > ${refSize} chars), so here is the text`)
  }
  if (plan.kind === 'delta') {
    const text = renderDeltaBody(plan.baseline, base.version, plan.hunks)
    const summary = `delta against baseline ${plan.baseline}: ${plan.hunks.length} hunk(s), ${plan.changed} of ${total} lines changed`
    const env = {
      ...base,
      mode: 'full',
      note: summary,
      omitted: `${plan.unchanged} unchanged line(s) withheld — byte-identical to baseline ${plan.baseline}`,
      text,
      next: `mode=lines lines=[1,${total}] to get the whole text again`,
    }
    const size = serializedSize(env)
    if (text.length <= budget && size < refSize) return { env, record: { covered: true } }
    return fallback(`${summary}, but that receipt would not be smaller than the text itself (${size} > ${refSize} chars) — full text follows`)
  }
  return { env: withBaselineNote(ref, plan.reason), record: null }
}

/**
 * 这次交付之后，调用方手里有什么——**账本记的就是这件事**。
 *
 * 只有两种交付会改变它：
 *   · 整文件内容（`full`，含差量/无变化两条增量路径）；
 *   · `changed` 给出的**完整**变更窗口（它把旧全文补成新全文）。
 * 其余模式（map／digest／lines／around／search）不动账本：它们既不能证明调用方有全文，
 * 也不能推翻他先前拿到过全文。
 */
function recordDelivery(filePath, result, version, total, bom, record) {
  if (typeof filePath !== 'string' || filePath.length === 0) return
  /**
   * 行覆盖**无条件**落账（1.0.2）：布尔账本只回答"有没有全文"，写闸要回答"哪几行交过"。
   * 两条判据各有各的用途，互不替代。
   */
  rememberDeliveredRows(filePath, version, deliveredLabels(result, total, record))
  if (record !== null) {
    ledgerSet(filePath, version, record.covered, bom)
    return
  }
  if (result.mode === 'full') {
    ledgerSet(filePath, version, result.shown === `1-${total}` && result.truncated === undefined, bom)
    return
  }
  if (result.mode === 'changed') {
    const entry = ledgerGet(filePath)
    if (entry === null || entry.covered !== true) return
    // 窗口被预算剪过就不算补全：调用方的新全文里有洞
    const holed = result.omitted !== undefined && /\blines \d+-\d+ \(content budget/.test(result.omitted)
    ledgerSet(filePath, version, !holed && result.truncated === undefined, bom)
  }
}

/**
 * 这次回执**逐字交出去**的行；拿不准就是空（空 = 没交付，写闸会拒绝）。
 *
 * 增量层说"调用方已有全文"（`record.covered`）时记整份：差量读没逐行重发，
 * 但调用方手上的旧全文＋这份差量合起来就是新全文，这与布尔账本的语义是同一件事。
 */
function deliveredLabels(result, total, record) {
  if (record !== null) {
    return record.covered === true && Number.isInteger(total) && total > 0 ? [`1-${total}`] : []
  }
  if (typeof result.shown === 'string') {
    const range = parseRange(result.shown)
    if (range !== null) return formatRanges([range])
  }
  return []
}

/**
 * full —— 全文。**仍然受预算约束**，因此它不是"旧的 read"：超预算时同样显式说明。
 *
 * 这一模式存在是因为实测发现：文件足够小时，全文比 map 和 digest 都小
 * （1 个函数时全文 156 字符、map 123、digest 180；再小一点全文就反超）。
 * 把这种情况硬塞给 lines 模式是错的——lines 需要调用方给区间，而这里调用方什么都没给。
 */
function renderFull(base, lines, symbolsIndex = null) {
  // 不发句柄（理由见 `readWith` 里 `handleContext` 那段）：全文读不是编辑地址。
  return windowEnvelope(base, lines, 1, lines.length, 'full file', 1, null, symbolsIndex)
}

/**
 * 选模式的依据：**比较各模式的输出体量，选最小的那个**。
 *
 * 这不是调参，是把选择权交给可测量的比较。实测依据（`digest-threshold.mjs`）：
 *   · `map` 不随文件增长——被内容预算封顶在约 1050 字符
 *   · `digest` 随函数数线性增长（20 函数 1616、160 函数 7048）
 *   · 全文在小文件上反而最小（1 个函数时 digest 180 > 全文 156）
 * 因此"看懂一个文件"的正确答案取决于文件规模，而那是可以算出来的，不该让调用方猜。
 *
 * @returns {{mode: string, reason: string, sizes: object}}
 */
export function suggestMode(source, filePath, budget = null) {
  /**
   * 宿主预算（`request.budget`）优先：它是调用方**实际会执行**的剪枝阈值，缺省才是 8192。
   * 内容上限必须减去两层信封开销（{@link DEFAULT_ENVELOPE_ALLOWANCE}），与 `readWith` 的
   * `contentCeiling` 同一口径——否则 auto 会以为“装得下”，实际渲染时又被信封挤出去。
   */
  const hostBudget = Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_PRUNE_BUDGET
  const contentBudget = Math.max(0, hostBudget - DEFAULT_ENVELOPE_ALLOWANCE)
  /**
   * `full` 的渲染长度**不是** `source.length`：每行有 `N: ` 行号前缀，736 行的文件会多出
   * 约 1.6KB。旧判据拿原始字符数比预算，于是 5902 字符 / 736 行被判成“全文装得下”，
   * 实际渲染时剪掉 193 行，`auto` 理由还写着 “complete answer”。这里直接用 full 的真实
   * 渲染结果（`omitted === undefined` 才算完整）作判据。
   */
  const fullProbe = readWith(source, { filePath, mode: 'full', budget: hostBudget, probe: true })
  const sizes = { full: fullProbe.text?.length ?? source.length }
  const lang = filePath === null || filePath === undefined ? null : langOf(filePath)
  let symbols = null
  if (lang !== null) {
    symbols = listSymbols(indexStructure(source, lang)).length
    sizes.map = readWith(source, { filePath, mode: 'map', budget: hostBudget, probe: true }).text?.length ?? 0
    if (sizes.map <= sizes.full) {
      sizes.digest = readWith(source, { filePath, mode: 'digest', budget: hostBudget, probe: true }).text?.length ?? 0
    }
  }

  /**
   * **内容门槛**：文件小到全文装得下时，直接给全文，不做任何"更省"的选择。
   *
   * 这条判据来自一次真实使用：模型在一个 14 行文件上拿到地图后的反馈是——
   * "这对大文件是正确的经济选择，在这里是错的：模式选择在全文就是整个答案的文件上
   * 优化了字节数"。
   *
   * 它说对了，而且指出的是目标函数漏了一项：**地图的价值随文件增大而上升**。
   * 小文件上全文是完备的，地图只给名字、反而不完备；省下的那点字节换不来任何东西。
   * 因此"最小"不是唯一判据——还要问"这个选择是否真的回答了问题"。
   *
   * ## 门槛从 0.25 改成 1.0（实测驱动）
   *
   * 原先这里是 `CONTENT_BUDGET * 0.25`（约 1920 字符）。后果：**1920 到 7492 字符之间的文件，
   * 全文明明装得下，却拿到一个索引**。而日志测量给出了这个后果的大小：
   *   · `auto` 选了 `map` 的读取，**64.6%** 被“同一文件、同一轮、紧接着的另一次读”跟进；
   *     选了 `full` 的只有 **17.1%**（n=488）→ 相差 **3.8 倍**；
   *   · 而那些跟进里 **87.7% 是在要正文**（`full` 或显式行区间），不是在问别的问题；
   *   · 总体看，**46.0% 的 auto 读取**会被同轮同文件的再读跟进（n=3812，不依赖回执头）。
   *
   * 也就是说：在装得下的文件上给索引，付出的是一整轮往返，换来的只是“字节更少”。
   * 判据改成“**全文是否装得下**”（`<= CONTENT_BUDGET`）：装得下就给全文，
   * 装不下才进入索引竞逐。
   *
   * 为什么用预算而不是固定字符数：预算是算出来的（内容预算随信封收紧），
   * 而固定字符数会随着预算变化而变成另一个隐含的错值。
   */
  const FULL_TEXT_FITS = fullProbe.ok === true && fullProbe.omitted === undefined
  if (FULL_TEXT_FITS) {
    return {
      mode: 'full',
      reason: `the whole text fits the content budget (${sizes.full} ≤ ${contentBudget} chars rendered; host budget ${hostBudget}, envelope allowance ${DEFAULT_ENVELOPE_ALLOWANCE}), so it is the complete answer`,
      sizes,
    }
  }

  /**
   * **两份候选**，用途不同：`sizes` 是实测渲染长度，照旧全给调用方看；
   * `ranked` 是"真的交付了内容"的那些——选择只在后者里做。
   *
   * 起因是一次实测：合成 240 函数的源文件（23.7KB）上 digest 渲染出 41 个字符——
   * 只剩一行规模统计，一条签名也没有（固定头里的 exported / external 行把预算吃完了）；
   * 600 函数时渲染为 0 字节，而本函数仍然选中它，理由写成"比全文小 2094.2 倍"。
   *
   * 根因不是 digest 写坏了，而是选择的判据与目标反向：本函数挑**最小**，而坍塌后的 digest
   * 正好是最小的——**越是废掉的输出越会被选中**。上面那道内容门槛（FULL_TEXT_FITS）
   * 是同一类闸门，只是它只管小文件。
   *
   * 判据取两条，都不依赖某个模式的内部细节，因此可判定：
   *   1. 渲染不出任何字节 —— 任何模式都不该被选中；
   *   2. 渲染长度不到源文件的 1% —— 交出的是索引的影子而不是答案。
   * `full` 不受第二条约束：它的"少"有解释（预算＋显式 omitted），而不是坍塌；
   * 因此最坏情况下退到全文，也不会去选一个空壳。
   */
  const delivered = (name) => {
    const n = sizes[name] ?? 0
    return n > 0 && n >= source.length * 0.01
  }
  const top = Object.entries(sizes).sort((a, b) => a[1] - b[1])
  // `full` 通常不受“1% 交付”门槛限制（它的少是预算裁剪，有解释）；
  // 但渲染长度是 0 的 full 是**空壳**，不能因为“叫 full”就被选中。
  const ranked = top.filter(([name]) => (name === 'full' ? sizes.full > 0 : delivered(name)))
  const candidates = ranked.length > 0 ? ranked : [['full', sizes.full]]
  const best = candidates[0]
  const reason =
    best[1] === 0
      ? `no mode can render text at host budget ${hostBudget} (below the minimum envelope); raise the budget or pass maxChars`
      : best[0] === 'full'
        ? `full text is the smallest option (${sizes.full} chars rendered)`
        : `${best[0]} is ${(sizes.full / best[1]).toFixed(1)}x smaller than the full text`
  return { mode: best[0], reason, sizes, ...(symbols === null ? {} : { symbols }) }
}

/**
 * 多目标读（契约 §2.1 / §4）——**与单目标并列的新增形状**，既有形状一字不改。
 *
 * 这不是 `readWith` 的变体：`readWith` 吃**已经读进来的全文**，本入口吃**目标描述**，
 * 读盘那一步由 provider 完成。两者共用的只有"一个目标怎么读"这一处逻辑
 * （{@link readManyTarget}），因此不存在"单目标一套、多目标另一套"两份判定。
 *
 * ## 为什么新入口要读盘、而单目标那条路不读（这一条是可复核的历史，不是取舍）
 *
 * 读侧的真编排入口是 `ops.mjs` 的 `readEnvelope`，它在文件分支用 `readFileBytes`（直接 fs 读）
 * ——**不经 `provider.readText`**。上一单把这条现状钉成了红线（`provider-calls` 那三类逐条比对
 * 调用序列）。所以本入口**绝不**改 `readEnvelope`：多目标走 provider 是**新路径**，单目标
 * 继续走它原来那条。谁要动单目标那条路，先绿的是红线套件，不是这份代码。
 *
 * 本文件**零 `node:` 依赖**（契约 §1.5）：这里只做纯计算与 provider 调用，
 * 计时用 `Date.now()`（全局，不是内置模块）。
 */

/**
 * 并发池大小（契约 §4：`MT_POOL = 8`）—— **不是本地真值**，而是参数面 `args.mjs` 那一份的转发。
 *
 * 这里原来写着 `export const MT_POOL = 8`，与写侧 `write-path.mjs` 里同一句构成**两份活真值**；
 * 两边恰好都是 8，于是两个套件同时绿，把缝盖住了。现在取值只有一个来源，与上面 `MT_MAX_TARGETS`
 * 同一条纪律、同一种接法：上面的 `import` 建本地绑定供本文件自己用（`options.pool ?? MT_POOL`），
 * 再用 `export { MT_POOL }` 把这个**同一绑定**转出去。**不是** `export … from`：那种写法不建本地绑定，
 * 本文件自己那两处会当场 `ReferenceError`——`node --check` 抓不到，只有实跑套件才炸。
 *
 * 导出名与取值逐字未变（`multi-read-test.mjs` 从这里取 `MT_POOL` 并断言在飞峰值）。
 */
export { MT_POOL }
/** 多目标的"参数形状没成形"错误码（与 `ARGS_UNKNOWN_KEY` 同族：**抛错**，不是结果通道）。 */
export const MT_BAD_TARGETS = 'MT_BAD_TARGETS'
export const MT_TOO_MANY_TARGETS = 'MT_TOO_MANY_TARGETS'

/** 一个目标读完之后账面上算哪一类（汇总行只按这一列计数）。 */
const MT_OK = 'ok'

/**
 * 汇总行：形如 `targets: 7 ｜ ok 6 ｜ not_found 1`。
 *
 * 计数**按结果现算**，不另维护一套账：两套账迟早会分叉，而分叉的方向必然是
 * "汇总说 6 条成了、逐项里只有 5 条 ok"这种谁都不信的中间态。
 * 没成的按 `code` 逐个列出（`not_found` 用短名，其余用原码），因此
 * "哪几条没成"在一行里就能读出来。
 */
function mtSummaryLine(entries) {
  const counts = new Map()
  for (const entry of entries) {
    const label = entry.outcome === MT_OK ? MT_OK : mtShortCode(entry.code)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  // `ok` 永远排第一（它是这条行的主语），其余按名字排序 ⇒ 同一份输入恒定给同一行。
  const names = [...counts.keys()].sort((a, b) => (a === MT_OK ? -1 : b === MT_OK ? 1 : a < b ? -1 : a > b ? 1 : 0))
  return [`targets: ${entries.length}`, ...names.map((name) => `${name} ${counts.get(name)}`)].join(' ｜ ')
}

/** 汇总行里的短码：只给 `not_found` 起短名，其余原样——短名多了就成了第二种语言。 */
const mtShortCode = (code) => (code === 'FS_NOT_FOUND' ? 'not_found' : String(code ?? 'error'))

/**
 * 读一个 target：**唯一的**"一个目标 = 一次读"实现。
 *
 * N===1 直调它、N>1 池里调它——同一条代码路径，所以"多目标那条路会不会比单目标多跑一次"
 * 这个问题在结构上就只有一种答案。
 *
 * 顺序（也就是 provider 调用序列）是刻意钉死的：`resolve` → `stat` → `readText` →（可选）`readByteRange`。
 * 它刻意与 `readEnvelope` 文件分支的 `resolve` → `stat` → 读 同形：
 * 这样 N===1 的调用**序列**与直接读一个目标逐字相同，红线那条断言才有东西可比。
 *
 * @param provider - 四方法契约：`resolve` / `stat` / `readText` / `readByteRange`
 * @param rawTarget - 调用方给的单个目标（**就是今天那套单目标参数**）
 * @param index - 在输入数组里的序号（进回执，用于"哪一条没成"）
 * @param probeBom - 是否用 `readByteRange` 探一次 BOM。理由见 {@link readManyWith}
 * @returns 逐项回执行（与单目标回执同一套渲染：成功时就是 `readWith` 的原样输出）
 */
async function readManyTarget(provider, rawTarget, index, probeBom) {
  const request = rawTarget === null || typeof rawTarget !== 'object' ? null : rawTarget
  if (request === null) throw Object.assign(new Error(`targets[${index}] must be an object`), { code: MT_BAD_TARGETS })
  /**
   * 目标里的 `file_path` 留**原样**（回执原样回抄调用方给的路径，与单目标同一条纪律）；
   * `readWith` 要的是 `filePath`，转换只在这一处发生。
   */
  const filePath = request.file_path ?? request.filePath ?? request.path
  if (typeof filePath !== 'string' || filePath === '') {
    throw Object.assign(new Error(`targets[${index}] needs a file_path string`), { code: MT_BAD_TARGETS })
  }
  /**
   * 行区间 / 分页 / 模式推断：与单目标**同一个** `normalizeReadRequest`。
   * 旧版只转发 `around/lines/search/since/maxChars`，于是 `offset/limit/context/kind/budget`
   * 在多目标里被静默丢掉（同一个元素单独读与放进 targets 读会得到两种结果）。
   * 这里先只判形状；读到内容后再用它做 offset 越界与尾行截断。
   */
  const shape = normalizeReadRequest(request)
  if (shape.ok !== true) {
    return mtFailure(index, [filePath, filePath], 'READ_BAD_ARGS', shape.error)
  }
  /**
   * `provider.resolve` 的两种返回形状**都认**（`await` 对同步值等价，所以旧提供方一行不用改）：
   *   · **字符串** —— 旧形状（CLI/MCP 的 `createNodeFsProvider`、绝大多数测试）：它就是显示路径，
   *     账本键也由它算（`identityKey` 缺席）⇒ 与本参数存在之前**逐字节相同**；
   *   · **宿主解析结果** `{displayPath, targetKey}` —— DSH 壳的 `ctx.fs.resolve()` 就是这个形状：
   *     显示路径用 `displayPath`，**身份键**用 `targetKey`。
   *
   * 为什么必须认第二种（实测：同一文件同一区间，单目标读发 `h4745015d4840:…`、多目标读发
   * `he6dd015d4840:…` —— 指纹段相同、**身份标签段不同**）：句柄的身份标签按
   * `ledgerIdentityKey(filePath, identityKey)` 算，而单目标那条路（`readEnvelope` 前的壳）递的正是
   * `ctx.fs.resolve()` 的 `targetKey`。多目标若只把路径串当身份，就会对**同一份盘上文件**发出两个
   * 不同的句柄，后果具体：拿批量读来的句柄去 `aura_basetools_edit` ⇒ `PATCH_HANDLE_IDENTITY_MISMATCH`。
   *
   * 身份口径**不新造第三份**：宿主给的 `targetKey` 就是既有那一份（@see ledgerIdentityKey / IDENTITY_KEYS）；
   * 元素自带的 `identityKey`（与写侧 `editTargetRequests` 同名的那个键）只作为提供方给不出事实时的回落。
   */
  const hostTarget = await provider.resolve(filePath)
  const target =
    hostTarget !== null && typeof hostTarget === 'object' ? (hostTarget.displayPath ?? filePath) : hostTarget
  const identityKey =
    hostTarget !== null && typeof hostTarget === 'object' && typeof hostTarget.targetKey === 'string' && hostTarget.targetKey.length > 0
      ? hostTarget.targetKey
      : request.identityKey
  let info
  try {
    info = await provider.stat(target)
  } catch (error) {
    return mtFailure(index, [target, filePath], error?.code ?? 'IO_ERROR', String(error?.message ?? error))
  }
  /**
   * `stat` 的两套约定都要认：
   *   · `createNodeFsProvider` 与 DSH 的 `probe()` 给 `{type: 'file'|'directory'|'other', …}`；
   *   · 有些提供方给 `undefined` 表示不存在。
   * 存在但拿不到类型时**按文件试读**（读不动自有 provider 抛错兜底），
   * 不在这里替提供方发明第三种类型判定。
   */
  if (info === undefined || info === null) {
    return mtFailure(index, [target, filePath], 'FS_NOT_FOUND', `cannot read "${filePath}": not found`)
  }
  if (info.type === 'directory') {
    // 目录级地图（T26）是**单目标**的既有能力，多目标这一波不扩它：只给可执行的拒绝。
    return mtFailure(index, [target, filePath], 'MT_TARGET_IS_DIRECTORY', `"${filePath}" is a directory: read it on its own (a repo map is not a window)`, `read "${filePath}" by itself for a repo map`)
  }
  /**
   * `readText` 可能同步抛（非 UTF-8 / 二进制 / 竞争删除）——`await` 包在 try 里，
   * 于是同步抛与 reject 走同一条路。逐项拒绝，整批不受影响（契约 §1.3）。
   */
  let source
  try {
    source = await provider.readText(target)
  } catch (error) {
    return mtFailure(index, [target, filePath], error?.code ?? 'IO_ERROR', String(error?.message ?? error))
  }
  /**
   * BOM：`provider.readText` 把第一个 BOM 吃掉了（默认 `ignoreBOM: false`），
   * 而 BOM **进内容指纹**、也进句柄（契约 §4 的令牌语义），因此它必须由**字节**得出。
   *
   * 这一笔是"多目标路径上多出来的一次读"，代价与理由都摆在这里：只读 BOM 那几个字节，
   * 且只在提供方有 `readByteRange` 时；`probeBom: false` 可整体关掉（那时按"无 BOM"读）。
   * **单目标那条路一点没碰**：它仍旧走 `readEnvelope` 的 `readFileBytes`（一次 fs 读，BOM 一次拿到）。
   */
  let byteOrderMark = false
  if (probeBom && typeof provider.readByteRange === 'function') {
    try {
      const head = await provider.readByteRange(target, { offset: 0, length: BYTE_ORDER_MARK_BYTES.length })
      byteOrderMark = startsWithByteOrderMark(head)
    } catch {
      // 读头失败不回滚整条读：BOM 是**元数据**，缺它就按没有处理（下面那次 readText 已经成功了）。
      byteOrderMark = false
    }
  }
  const requestShape = normalizeReadRequest(request, source.split(/\r?\n/).length)
  if (requestShape.ok !== true) {
    return mtFailure(index, [target, filePath], 'READ_BAD_ARGS', requestShape.error)
  }
  const env = readWith(source, {
    mode: requestShape.mode,
    around: request.around,
    lines: asLinePair(requestShape.lines),
    search: request.search,
    since: request.since,
    // 读侧两层叫法不同：宿主面 `max_chars`，引擎面 `maxChars`（与 `readEnvelope` 同源）。
    maxChars: request.max_chars ?? request.maxChars,
    ...(request.context === undefined ? {} : { context: request.context }),
    ...(request.kind === undefined ? {} : { kind: request.kind }),
    ...(request.budget === undefined ? {} : { budget: request.budget }),
    byteOrderMark,
    /**
     * `filePath` 给的是 **provider.resolve 之后的那个串**，不是调用方原样给的路径。
     *
     * 为什么必须是它（这条是实测出来的，不是风格）：`readWith` 用它算**账本键**，
     * 而账本键进句柄的身份标签。单目标那条路（`readEnvelope`）给的正是 `provider.resolve(file)`，
     * 于是这里若给原样的 `file_path`，同一个文件在两条路上会得到**两个不同的句柄**
     * ——`multi-read-test` 段A 的"逐项回执与单独跑一次逐字节相同"当场变红，
     * 而且更坏的是：拿批内句柄去 `aura_basetools_edit` 会查不到那一条观测。
     *
     * 回执里显示哪一份由 `file_path` 字段负责（下面那条）——两件事分开，各归各的字段。
     */
    filePath: target,
    /**
     * 身份键与 `filePath` **分开递**，与单目标那条路（`readEnvelope` 的 `identityKey: target.targetKey`）
     * 同源。缺席时（提供方只给字符串、元素也没带）走旧行为：账本键 = `filePath`。
     */
    ...(typeof identityKey === 'string' && identityKey.length > 0 ? { identityKey } : {}),
  })
  /**
   * 成了 ⇒ **这一条就是单目标回执本身**（同一个对象引用，不是另渲染一遍）。
   * 另渲染一遍是这一单最容易犯的错：两份渲染一开始一样，改一处就只改一份。
   */
  return {
    index,
    file_path: filePath,
    ok: true,
    outcome: MT_OK,
    mode: env.mode,
    envelope: env,
  }
}

/**
 * 一条没成的逐项回执。
 *
 * 形状刻意与成了的那条**逐字段对齐**（`index` / `file_path` / `ok` / `outcome` 都在），
 * 只有 `envelope` 换成 `code` + `message`：调用方按同一个字段集读两种结果，不用分叉。
 * `next` 只在能给**可执行**的下一步时才出现（与单目标的 `next` 同一条纪律：不给空话）。
 */
function mtFailure(index, [target, displayPath], code, message, next) {
  return {
    index,
    file_path: displayPath,
    ok: false,
    outcome: 'failed',
    ...(code === 'FS_NOT_FOUND' ? { target } : {}),
    code,
    message,
    ...(next === undefined ? {} : { next }),
  }
}

/**
 * **一次调用读多个目标**（契约 §2.1 的读侧形状）。
 *
 * ## 形状
 *
 * 两种调用方式，**互斥**：
 *   · `readManyWith(provider, [{file_path, mode, …}, …], opts)` —— 多目标（推荐，显式）；
 *   · `readManyWith(provider, {file_path, mode, …}, opts)` —— 单个目标，与上面**同一条代码路径**。
 * 单个对象被归一成"长度 1 的数组"，所以不存在第二条实现。
 *
 * ## N===1 ⇒ 直调（结构性保证，不是"我们测了没变慢"）
 *
 * 长度 1 时**不建池、不建队列、不包一层**：直接 `await` 那个唯一的目标，
 * 一行 `if` 就出函数。因此"N=1 时多跑一次 / 多包一层 / 多一个字段"这件事
 * 在本入口里没有可发生的语法位置——它是控制流性质，不是性能观测。
 * 测试（`multi-read-test.mjs` 段C）用计数 provider 把这条钉成"调用序列逐项相同"。
 *
 * ## N>1 ⇒ 有界并发池，只并发 I/O 与纯计算（契约 §4）
 *
 * 池子就是 `min(MT_POOL, N)` 个**常驻 worker** 各拉一条队列：`maxInFlight` 因此由结构决定，
 * 不用"数一数同时在飞几个"去经验地保证。
 * **结果按输入顺序装配**：`results[i] = …` 按下标写，完成顺序只影响"谁先写"、不影响任何一项的位置。
 * 这一条是硬要求（契约 §1.4）——并发完成顺序一旦泄漏到输出，同一份输入两次调用可能给两种排列。
 *
 * ## 失败语义（契约 §1.3）
 *
 * 逐项失败（不存在 / 找不到 / 需选择 / 不是文本 / 目录）一律**走结果通道**：那一条带
 * `ok:false` + `code` + `message`（能给下一步时还有 `next`），**其余目标照常**。
 * 只有"参数形状没成形"才抛错：
 *   · `targets` 不是数组/不是对象 ⇒ `MT_BAD_TARGETS`；
 *   · 目标数超过 {@link MT_MAX_TARGETS} ⇒ `MT_TOO_MANY_TARGETS`，**message 里报出实得数**；
 *   · `targets` 为空 ⇒ `MT_BAD_TARGETS`（空批不是"成功读了 0 个"，那是静默换语义）。
 * 抛错**不会**吞掉已经读成的那些：抛发生在**读之前**（形状校验是第一件事），所以没有"半批已读"这种状态。
 *
 * ## 回执
 *
 * 逐项（同一套渲染）+ **一行汇总**（`targets: N ｜ ok K ｜ not_found M`）。
 * 汇总只在 `summary` 字段里、不进任何 `envelope.text`：正文是宿主剪枝器量的东西（契约 §5），
 * 往里塞一行就是让每一份多目标回执的正文回涨。
 *
 * @param provider - 四方法契约：`resolve` / `stat` / `readText` / `readByteRange`
 * @param targets - 目标数组（每个元素就是今天那套单目标参数），或**单个**这样的对象
 * @param {number} [options.pool] - 覆盖池大小（默认 {@link MT_POOL}）。测试要它把"有界"钉成结构观测
 * @param {boolean} [options.probeBom] - 是否探 BOM，默认 `true`
 * @param {(event: {index: number, maxInFlight: number}) => void} [options.trace] - 纯观测钩子（测试用）
 * @returns 逐项 + 汇总的整批回执（**不是** Promise 之外的任何包装）
 * @throws {Error} `code` ∈ {`MT_BAD_TARGETS`, `MT_TOO_MANY_TARGETS`}
 */
export async function readManyWith(provider, targets, options = {}) {
  if (provider === null || typeof provider !== 'object' || typeof provider.readText !== 'function') {
    throw Object.assign(new Error('readManyWith needs a provider with resolve/stat/readText'), { code: MT_BAD_TARGETS })
  }
  /** 单个对象 = 长度 1 的数组：**归一只有这一处**，下面再没有"单个/多个"的分叉。 */
  const list = Array.isArray(targets) ? targets : targets !== null && typeof targets === 'object' ? [targets] : null
  if (list === null) {
    throw Object.assign(new Error(`targets must be an array or a single target object, got ${targets === null ? 'null' : typeof targets}`), { code: MT_BAD_TARGETS })
  }
  if (list.length === 0) {
    throw Object.assign(new Error('targets must not be empty (an empty batch is not "read 0 files")'), { code: MT_BAD_TARGETS })
  }
  if (list.length > MT_MAX_TARGETS) {
    throw Object.assign(new Error(`targets has ${list.length} entries, but the limit is ${MT_MAX_TARGETS} — split the call`), {
      code: MT_TOO_MANY_TARGETS,
      got: list.length,
      max: MT_MAX_TARGETS,
    })
  }
  const probeBom = options.probeBom !== false
  const started = Date.now()
  const entries = new Array(list.length)
  if (list.length === 1) {
    // ── N===1：直调。没有池、没有队列、没有 trace、没有包装 —— 这里少写一行代码就是保证。 ──
    entries[0] = await readManyTarget(provider, list[0], 0, probeBom)
  } else {
    await mtPool(list, options.pool ?? MT_POOL, options.trace, async (item, index) => {
      entries[index] = await readManyTarget(provider, item, index, probeBom)
    })
  }
  const counts = { ok: 0, failed: 0 }
  for (const entry of entries) {
    if (entry.ok === true) counts.ok += 1
    else counts.failed += 1
  }
  return {
    ok: counts.failed === 0,
    targets: entries.length,
    counts,
    summary: mtSummaryLine(entries),
    entries,
    elapsedMs: Date.now() - started,
  }
}

/**
 * 有界并发池：`min(pool, N)` 个常驻 worker 各拉一条队列。
 *
 * 为什么是"常驻 worker + 共享游标"而不是"分批 `Promise.all`"：分批发的话，
 * 一格慢就整批等（尾部空转），而"同时在飞几个"这件事会随每批的完成快慢漂移。
 * 常驻 worker 下**在飞数恒 ≤ pool**——这是结构，不靠经验观测。
 *
 * 为什么 worker 自己 `await`：`maxInFlight` 只在 worker 真正进入/离开时增减，
 * 而它进出之间**只**做一件事：跑 `run`（I/O 与纯计算）。`trace` 因此能给出
 * "同时在飞的最大值"这个**确定性**读数（慢 provider 下它必然等于 pool），
 * 而不是一次墙钟计时（机器上有并行单元，计时不作判据）。
 */
async function mtPool(items, pool, trace, run) {
  const width = Math.max(1, Math.min(Math.trunc(pool) || MT_POOL, items.length))
  let next = 0
  let inFlight = 0
  let maxInFlight = 0
  const worker = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      inFlight += 1
      if (inFlight > maxInFlight) maxInFlight = inFlight
      if (typeof trace === 'function') trace({ index, maxInFlight })
      try {
        await run(items[index], index)
      } finally {
        inFlight -= 1
      }
    }
  }
  const workers = []
  for (let w = 0; w < width; w += 1) workers.push(worker())
  await Promise.all(workers)
}

/**
 * 读一个文件，按模式返回**带预算与省略说明**的结构化结果。
 *
 * 多目标（多文件 / 多区间一次调用）走 {@link readManyWith}：它**逐个**调用本函数，
 * 因此"一个目标怎么读"只有一处实现。本函数自身一行未改——单目标零回归由红线套件钉住。
 *
 * @param {string} source - 文件全文
 * @param {object} request
 * @param {'map'|'digest'|'around'|'lines'|'search'|'changed'|'auto'} [request.mode] - 默认 auto
 * @param {string} [request.filePath] - 用于判定语言；无扩展名时 map/digest 降级
 * @param {string} [request.around] - mode=around：目标（符号名 / 一个词）
 * @param {number} [request.context] - mode=around：上下各给几行，默认 8
 * @param {[number, number]} [request.lines] - mode=lines：1-based 闭区间
 * @param {string} [request.search] - mode=search：子串
 * @param {string} [request.since] - mode=changed：上次回执里的 `version`（给 since 而不给 mode 即进本模式）
 * @param {boolean} [request.byteOrderMark] - 这份文件是否带 UTF-8 BOM。**只能由调用方从字节得出**
 *   （提供方的 readText 会把 BOM 丢掉）：它进内容指纹，因此只差 BOM 的两个文件令牌不同
 * @param {string} [request.token] - `since` 的旧名，仅为兼容保留
 * @param {number} [request.limit] - 各模式最多返回多少条
 * @param {boolean} [request.incremental] - 同会话增量读的开关。缺省（宿主今天的样子）是
 *   "有可信基准就给差量"；`true` = 显式要求增量（那时连"没有基准"也要在回执里解释）；
 *   `false` = 逃生门，强制全文（诊断与对照用）。宿主若在一个 realm 里跑多个会话，
 *   应改为按会话换观测存储（见 {@link setObservationStore}），而不是把它指死为 false。
 * @param {string} [request.identityKey] - **宿主给的身份键**：同一份盘上文件必给同一个串
 *   （DSH 壳传 `ctx.fs.resolve()` 的 `targetKey`，`dsh-fs` 的契约就把它定义成
 *   「stale guards / target lookup」用的不透明键）。传了 ⇒ 账本（观测 / 交付 / 顺扫）
 *   一律记在它上面，而 `filePath` 只管**显示**（回执原样回抄调用方给的路径）；
 *   不传 ⇒ 行为与本参数存在之前**逐字节一致**。理由与"归一化只此一处"见
 *   {@link ledgerIdentityKey}。
 * @returns 结构化信封，含 `omitted`（丢了什么）与 `next`（怎么续读）
 */
export function readWith(source, request = {}) {
  let mode = request.mode ?? 'auto'
  let auto = null
  if (mode === 'auto') {
    // 有明确指向性参数时，那些模式更精确，不参与"体量比较"
    if (request.around !== undefined) mode = 'around'
    else if (request.lines !== undefined) mode = 'lines'
    else if (request.search !== undefined) mode = 'search'
    // `since` 是工具层实际传下来的参数名；本函数早先只认 token / previous，
    // 于是"带 since 重读"拿不到 changed 语义——它被当成 auto 重新算模式，since 本身被丢掉。
    // 实测后果：changed 在真实会话里只被用过 1 次、且那一次没带 since——工具递出了钥匙，引擎不接。
    else if (request.since !== undefined || request.token !== undefined || request.previous !== undefined) mode = 'changed'
    else {
      auto = suggestMode(source, request.filePath ?? null, request.budget)
      mode = auto.mode
    }
  }
  if (!MODES.includes(mode)) {
    return { ok: false, code: 'READ_BAD_MODE', message: `mode must be one of ${MODES.join(', ')}, or auto` }
  }
  const lines = source.split(/\r?\n/)
  const total = lines.length
  const filePath = request.filePath ?? null
  const lang = filePath === null ? null : langOf(filePath)
  /**
   * 账本的**身份键**：算一次，下面每一处账本操作都用它（{@link ledgerIdentityKey} 是
   * 全引擎唯一那道归一）。`filePath` 从这一行往下只管显示与语言判定。
   */
  const ledgerKey = ledgerIdentityKey(filePath, request.identityKey)
  /**
   * 版本令牌与"这份内容带不带 BOM"
   * （它们原先在 `render` 里算——每轮重算一遍纯属白做工，而下面还要用它们做一次增量判定。）
   */
  const bom = request.byteOrderMark === true
  const version = contentToken(source, bom)

  /**
   * 增量层的判定也放在循环外：它只看账本、缓存与内容，不看预算。
   * 放进 `render` 会让收敛的每一轮把差分重做一遍（大文件上那就是百毫秒级 × 8 轮）。
   */
  const incremental = mode === 'full' && request.probe !== true ? planIncremental(request, lines, version) : { kind: 'skip' }
  /**
   * 顺扫判定同样放在循环外：它只看请求与会话账本（不看预算），而且
   * 「这一次是不是同一段顺扫的下一段」不应该随收敛轮次变。
   */
  const scan = planScan(mode, request, ledgerKey, version, total)
  /**
   * 最后一轮 `render` 交付了什么（增量的记录 / null = 普通交付）。
   * 收敛可能从差量退回全量，所以账本必须按**最终发出去的那一份**记，
   * 否则账本会说"你有全文了"，而实际发出去的是一份被截断的全量。
   */
  let delivery = null

  const render = (budget) => {
    /**
     * 版本令牌：**每条含内容的回执都必须给**。
     *
     * 这个字段曾经被 `mode === 'changed' || lang === null` 这个条件剥掉，后果是一整类
     * 调用被框架直接拒绝（schema 声明它必填）：
     *   tool "aura_basetools_read" returned invalid output: missing required property "value.version"
     * 实测命中的组合：`around`／`lines`／`search` 三种模式（它们经 windowEnvelope 再铺 base，
     * 而 base 里已经被剥掉了），以及**所有未索引扩展名**上的内容读取——
     * `.json`／`.yml`／`.md` 一个都读不了。
     *
     * 错在哪：`lang === null` 被当成了"本模式没有内容"的判据，但语言配置只决定**能否建符号表**，
     * 与内容是否可得无关（`full` 压根不需要符号表）。判据换成"这个模式是否产出内容"本身。
     *
     * `changed` 除外：它自己按 since 算出语义正确的令牌（首读哨兵要给 null，而不是
     * 一个会误导模型"可以拿去 diff"的令牌），因此由 renderChanged 自行覆盖 base 里的值。
     */
    /**
     * 版本令牌与**观测记录**：每一模式都要。
     *
     * `changed` 自己也会记一次（同一键重复记无害），而其余模式此前不记——
     * 实测后果：普通 `aura_basetools_read` 之后拿那个令牌去问 `changed`，得到的是
     * “that version is no longer cached — cannot diff”，把“上次观测”当判据的路直接断掉。
     */
    delivery = null
    // 账本键换成**身份键**（有的话）：`filePath` 只用于显示与语言判定
    if (filePath !== null && request.probe !== true) rememberRead(ledgerKey, version, source, bom, request.identityKey)
    const base = {
      ok: true,
      mode,
      totalLines: total,
      contentBudget: budget,
      ...(mode === 'changed' ? {} : { version }),
      ...(auto === null ? {} : { auto: auto.reason }),
      // 结构句柄（0.23，opt-in）：窗口**恰好**覆盖一个符号时，回执带 `s…:symbol=名字`。
      ...(request.structureHandle === true ? { structureHandle: true } : {}),
    }
    // 符号索引只建一次：`map`/`digest`/`around` 本来就要用，而 `lines`/`search` 现在也要
    // （给裸行号附上可重新定位的引用）。没语言配置（未索引扩展名）时为 null，各处自行降级。
    const symbolsIndex = lang === null ? null : indexStructure(source, lang)
    if (mode === 'probe') return renderProbe(base, source, lang, docKindOf(request.filePath), request)
    if (mode === 'map') return renderMap(base, source, lines, lang, request, symbolsIndex)
    if (mode === 'digest') return renderDigest(base, source, lines, lang, request, symbolsIndex)
    /**
     * 句柄上下文：`lines` / `search` / `full` 用它铸柄，其余模式为 null。
     *
     * 为什么按模式逐个点名、而不是"凡有窗口就发"：契约 §4 的表把发法逐模式钉死了。
     * `around` / `changed` 不在表里，给它们附加柄就是**超出契约的发法**——
     * 而回执体积那条不变式（§2.5）只管得住被量过的模式。
     *
     * `search` 必须在这一行里点名：这个函数**按模式逐个分支**，少一个名字就是静默不发
     * （而"没发句柄"与"发了空句柄"在回执上长得一样，只有掐住字段才看得出来）。
     *
     * **`full` 不在名单里（本单的裁决，理由是可复核的）**：
     * 契约 §4 给 `full` 写的是"发一条，仅在调用方显式要时"——**条件句、非强制**（同表的
     * `map`/`digest` 写的是硬"不发"）。而代价是实测的：`full` 的句柄带**身份标签**，
     * 于是**两条不同路径上的同一份内容**不再给出逐字节相同的回执。
     * 既有套件 `incremental-read-test` 的 K1（"首次读的回执不受本层影响（两条新路径逐字节相同）"）
     * 正是拿这件事当判据的，实测**只因这一个字段变红**（把 `full` 从这行名单里去掉 ⇒ 45/45 绿）。
     * 而 §7 对 HD1 的硬验收要求那三个既有套件判据**逐字不变**，
     * 因此这里选择**不发 `full` 句柄**：一个"把整个文件给我"的读本来就不是编辑地址
     * （它没有相对定位可依附），而"同一份内容两份回执逐字节相同"是既有契约。
     * `lines`（区间读）与 `search`（命中行）不受影响——那才是编辑要用的两种读法。
     */
    const handleContext =
      mode === 'lines' || mode === 'search' ? { ledgerKey, byteOrderMark: bom } : null
    if (mode === 'full') {
      // 整文件内容请求：先让增量层说话（差量 / no change / 全量＋为什么），
      // 它说"不适用"时才是普通的全文渲染。见文件上方"同会话增量读"一节。
      const out = renderIncremental(base, lines, symbolsIndex, incremental, budget, total, handleContext)
      delivery = out.record
      return out.env
    }
    if (mode === 'around') return renderAround(base, lines, lang, request, symbolsIndex)
    if (mode === 'lines') return renderLines(base, lines, request, symbolsIndex, scan, handleContext)
    if (mode === 'changed') return renderChanged(base, source, lines, request, symbolsIndex, ledgerKey)
    if (mode === 'search') return renderSearch(base, lines, request, symbolsIndex, handleContext)
    return renderFull(base, lines, symbolsIndex, handleContext)
  }

  /**
   * 收敛到"序列化后不超预算"的内容预算。
   *
   * 为什么必须迭代而不是一次算准：内容预算与序列化体量互相影响——信封里的 `omitted`
   * 说明随内容被截断而变化，而序列化又会把换行、引号撑大。用一个拍死的预留值
   * （我先前写的 1100）要么浪费空间、要么在信封偏胖时让总输出越过剪枝阈值而被砍。
   *
   * 做法：从保守预算起，每次量**真实序列化体量**，超出就把预算按超出量收窄，最多几轮。
   * 每轮都是纯 CPU，代价可忽略；换来"输出绝不可能因为信封胖而被剪"这条硬保证。
   * 收敛是单调的（预算只减不增，内容随之只减不增），因此不会来回震荡。
   */
  /**
   * 流水线硬上限：**由调用方告知**，缺省才用 `DEFAULT_PRUNE_BUDGET`。
   *
   * 为什么必须可告知：这个数属于宿主（`toolResultPruner.config.thresholdChars`），
   * 而它是可配置的。引擎写死 8192 会出现两种静默失效：宿主调大 → 本工具继续白白少给；
   * 宿主调小 → 输出被静默剪掉中段。DSH 壳现读现传（见 `aura-read/index.js`），
   * 无宿主环境（CLI / MCP / 单测）自然落回缺省。
   */
  const ceiling =
    Number.isInteger(request.budget) && request.budget > 0 ? request.budget : DEFAULT_PRUNE_BUDGET
  const contentCeiling = Math.max(0, ceiling - DEFAULT_ENVELOPE_ALLOWANCE)
  /**
   * **量体量的那把尺子由调用方给定**（缺省 = 引擎自己的信封）。
   *
   * 这是「两个数都对、放在一起就错」的第三次现身：
   *   · `serializedSize(result)` 量的是**引擎信封**；
   *   · 而 `toolResultPruner` 量的是**工具输出**——DSH 壳把引擎信封重排成另一个对象，
   *     其中 `renderEnvelope` 还会把 `version` / `omitted` / `next` **再铺进正文一次**；
   *   · 收敛循环原来只保证前者 ≤ ceiling，于是后者可以越过 ceiling 而工具以为它合规。
   *
   * 先前这里是一句注释（`DEFAULT_ENVELOPE_ALLOWANCE` 里写着“700 = 两层开销之和”），
   * 但 700 只用在**初始内容预算**上，**从不参与**那条硬断言的比较——所以它管不住任何事。
   *
   * 也试过用“外壳多出来的字段值多少字节”当上界（`path` + `outcome`）——**不够**：
   * 实测 400 函数的 `map` 在 146 字符路径上仍交出 **8246 字节**（阈值 8192），
   * 因为真正的大头是正文里那份**重排后的说明**（`omitted` / `next` 会在正文里再出现一次），
   * 而不是那两个字段。
   *
   * 与其在引擎里猜一层它看不见的排版，不如把尺子交出去：调用方给一个
   * `(信封) => 字节数` 的函数，收敛循环与硬断言都用它量。
   * 缺省（无外壳：CLI / MCP / 单测 / 其它调用方）＝ 引擎自己的 `serializedSize`，
   * 行为与本层不存在时逐字节一致。
   */
  const sizeBy = typeof request.shippedSize === 'function' ? request.shippedSize : serializedSize
  // `maxChars`：调用方可以要求**更小**的预算。CLI（`--max-chars`）与 MCP（`max_chars`）都暴露了
  // 这个开关，但之前**从没接上**——四档不同取值回执完全一致（字节靶场报的 F6：开关是空的）。
  // 更大的请求由流水线硬上限兜住："输出绝不越过剪枝阈值"是硬保证，不能被参数推翻。
  let budget =
    Number.isInteger(request.maxChars) && request.maxChars > 0
      ? Math.min(request.maxChars, contentCeiling)
      : contentCeiling
  /**
   * 0.9.8：确定性的回执 metrics。`mode` / `totalLines` / `text` / `symbols` 本来就在信封里，
   * 但调用方要自己数字符、自己判断有没有裁剪；这里统一附一份，三面同形。
   * 不加 `elapsedMs`（墙钟有噪声），只放**可由内容复算**的事实。
   *
   * **必须进收敛循环**：metrics 本身也占字节；事后贴上去会让 `sizeBy(result)` 少算几十字节，
   * 实测把 8192 档顶到 8250。所以每次 render 后立刻附 metrics，再量尺寸。
   */
  const withMetrics = (env) => env.ok === false ? env : ({
    ...env,
    metrics: {
      mode: env.mode,
      lines: env.totalLines,
      chars: (env.text ?? '').length,
      ...(env.symbols === undefined ? {} : { symbols: env.symbols }),
      // `truncated` = **被预算裁过**，不是“有任何 omitted”。map 的 “nested locals omitted”
      // 是刻意不列（不是内容被裁），旧判据会把它误报成 truncated。
      truncated: typeof env.omitted === 'string' && /content budget|minimum envelope|host result limit|withheld|truncated/i.test(env.omitted),
    },
  })
  const renderMeasured = (chars) => withMetrics(render(chars))
  let result = renderMeasured(budget)
  /** 每轮额外多收的余量：只按"超出多少"收窄会恰好贴着上限，信封随内容缩短而重算时容易再涨回去。 */
  const SHRINK_MARGIN = 64
  /** 轮数上限：收敛是单调的，几轮就够；给足是为了让下面那道硬断言根本不触发。 */
  const MAX_PASSES = 8
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const size = sizeBy(result)
    if (size <= ceiling) break
    const next = Math.max(0, budget - (size - ceiling) - SHRINK_MARGIN)
    if (next >= budget) break // 收不动了，交给下面那道硬断言
    budget = next
    result = renderMeasured(budget)
  }
  /**
   * 收不到上限时，缩到最小再试一次。
   *
   * 为什么不再挂 `budgetWarning` 字段（上一版的错）：它不在输出 schema 里，
   * 一旦触发会让框架以"未声明属性"拒掉**整条输出**——自检反而把工具弄挂了。
   *
   * 为什么不能"保证不超"：信封有一条**不可压缩的下限**——`path` / `mode` / `totalLines` / `text`
   * 是 schema 必填，所以 6 个模式的最小输出实测在 287–407 字节之间。
   * 宿主阈值低于这个下限时（实测 200）工具**物理上做不到合规**，再收内容也压不下去。
   * 那种情况下诚实报出来，而不是假装合规：
   *   · 输出仍取最小值（不白送裁剪）；
   *   · 在 `omitted` 里明写“已至最小信封，仍超宿主上限”—— 模型/人都能看到真相。
   */
  const finalSize = sizeBy(result)
  if (finalSize > ceiling) {
    const minimal = renderMeasured(0)
    const minimalSize = sizeBy(minimal)
    // 记账必须发生在**确定要发哪一份之后**：账本决定下一次还能不能做差量。
    // probe（`suggestMode` 的选型探针）只量渲染长度，不改账本、也不触发增量。
    if (request.probe !== true) {
      // `recordDelivery:false` 是**工具内部**那次读（apply 自建观测基准）：它的回执不发给模型，
      // 记成"交付过"会让写闸把没看过的正文当成看过。
      if (request.recordDelivery !== false) recordDelivery(ledgerKey, minimal, version, total, bom, delivery)
      recordScan(mode, ledgerKey, version, minimal, total)
    }
    if (minimalSize <= ceiling) return minimal
    return {
      ...minimal,
      metrics: {
        ...minimal.metrics,
        truncated: true,
      },
      omitted: `${minimal.omitted === undefined ? '' : `${minimal.omitted}; `}output is already at its minimum envelope (${minimalSize} chars) and still exceeds the host result limit (${ceiling}); the limit is below what a read result can physically be`,
    }
  }
  if (request.probe !== true) {
    if (request.recordDelivery !== false) recordDelivery(ledgerKey, result, version, total, bom, delivery)
    recordScan(mode, ledgerKey, version, result, total)
  }
  return result
}

/**
 * probe —— 只回答“这是什么文件”，不重复正文。
 *
 * 用途：调用方先判断“值不值得读”。行数、字节数、行尾风格、编码、语言/文档类型、
 * 结构规模（符号数或节/键数）都在这一行里；正文一律不发。
 *
 * 它不是 `map` 的替代：`map` 给的是**可追问的目录**，`probe` 给的是一句**元信息摘要**。
 * 代价也只有本地 IO——但对于“先看一眼再决定”这种意图，它省的是整份回执的 token。
 */
/** 1 symbols / 1 sections 这种复数噪声一律收掉（回执是给人读的）。 */
const unitWord = (n, unit) => (n === 1 && unit.endsWith('s') ? unit.slice(0, -1) : unit)

function renderProbe(base, source, lang, docKind, request) {
  const bytes = Number.isSafeInteger(request.fileSize) ? request.fileSize : new TextEncoder().encode(source).length
  const hasCrlf = source.includes('\r\n')
  const hasLf = source.replaceAll('\r\n', '').includes('\n')
  const lineEndings = hasCrlf && hasLf ? 'mixed' : hasCrlf ? 'crlf' : 'lf'
  const encoding = typeof request.sourceEncoding === 'string' ? request.sourceEncoding : null
  /**
   * `lang` 是**语法配置对象**（`langOf` 的返回值），不是名字；直接拼进摘要会得到
   * `[object Object]`（实测）。名字取扩展名，与 `langOf` 判定的是同一个东西。
   */
  const dot = typeof request.filePath === 'string' ? request.filePath.lastIndexOf('.') : -1
  const language = lang !== null && dot >= 0 ? request.filePath.slice(dot + 1).toLowerCase() : null
  let structure = null
  if (lang !== null) {
    const n = listSymbols(indexStructure(source, lang)).length
    structure = `${n} ${unitWord(n, 'symbols')}`
  } else if (docKind !== null) {
    const index = indexDocument(source, docKind)
    structure = `${index.entries.length} ${unitWord(index.entries.length, index.unit)}`
  }
  const parts = [`${base.totalLines} lines`, `${bytes} bytes`, lineEndings === 'mixed' ? 'mixed line endings' : lineEndings.toUpperCase()]
  if (encoding !== null) parts.push(encoding)
  if (language !== null) parts.push(language)
  else if (docKind !== null) parts.push(docKind)
  if (structure !== null) parts.push(structure)
  return {
    ...base,
    mode: 'probe',
    bytes,
    lineEndings,
    ...(encoding === null ? {} : { encoding }),
    ...(language === null ? {} : { language }),
    ...(docKind === null ? {} : { docKind }),
    ...(structure === null ? {} : { structure }),
    text: parts.join(' · '),
    next: 'mode=map for a directory; mode=lines lines=[a,b] for a section; mode=full for every line',
  }
}

/**
 * 文档 / 配置的目录：行号 + 层级 + 名字，不复制正文。
 *
 * 与代码地图同一套预算与续读语义：超出预算时 `omitted` 点名区间，下一步是 `mode=lines`。
 */
function renderDocMap(base, lines, docKind, request) {
  const index = indexDocument(lines.join('\n'), docKind)
  const kindFilter = typeof request.kind === 'string' ? request.kind : null
  const entries = kindFilter === null ? index.entries : index.entries.filter((entry) => entry.kind === kindFilter)
  if (entries.length === 0) {
    return {
      ...base,
      mode: 'map',
      text: `${base.totalLines} lines · no ${index.unit} found in this ${docKind} file`,
      ...(index.note === undefined ? {} : { note: index.note }),
      next: 'use mode=full or mode=lines to read content',
    }
  }
  const byKind = {}
  for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
  const header = `${base.totalLines} lines · ${index.entries.length} ${unitWord(index.entries.length, index.unit)} (${Object.entries(byKind).map(([kind, n]) => `${kind}:${n}`).join(' ')})`
  const rows = entries.map((entry) => `${'  '.repeat(Math.max(0, entry.depth - 1))}${entry.name}  ${entry.startLine}-${entry.endLine}`)
  const kept = fitWithin([header, ...rows].join('\n'), base.contentBudget)
  const shown = Math.max(0, kept.kept - 1)
  return {
    ...base,
    mode: 'map',
    symbols: index.entries.length,
    shown,
    byKind,
    text: kept.text,
    ...(index.note === undefined ? {} : { note: index.note }),
    ...(shown < rows.length ? { omitted: `${index.unit} ${shown + 1}..${rows.length} of ${rows.length} beyond the content budget; read them with mode=lines over their line range` } : {}),
    next: 'mode=lines lines=[a,b] to read a section; mode=map kind=<kind> to filter',
  }
}

/**
 * map —— 先给地图。
 *
 * 与旧 read 的根本差别：默认动作不是"把文件给你"，而是"告诉你这里有什么、怎么继续要"。
 *
 * 地图的形态是**目录**而不是清单：清单越长越没用，目录给出类别、数量与关键名字，
 * 并且能被追问（`mode=map kind=function` / `mode=map limit=80`）。
 */
function renderMap(base, source, lines, lang, request, symbolsIndex = null) {
  if (lang === null) {
    /**
     * 文档 / 配置（.md/.json/.yaml/.toml）也应有目录：实测 22% 的读取目标是这几类扩展名
     * （最近 62 个会话 / 1,836 次 read），而旧实现只回一句“unsupported extension”。
     * 结构索引在 `doc-structure.mjs`；这里只负责渲染与续读。
     */
    const docKind = docKindOf(request.filePath)
    if (docKind !== null) return renderDocMap(base, lines, docKind, request)
    // 同上：正文进 `text`，否则 `metrics.chars` 为 0 而同一条回执的说明里写着实际字符数。
    return {
      ...base,
      mode: 'map',
      text: `unsupported extension — no symbol index; ${base.totalLines} lines, ${source.length} chars`,
      next: 'use mode=full or mode=lines to read content',
    }
  }
  const all = listSymbols(indexStructure(source, lang))
  const byKind = {}
  for (const s of all) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1

  // kind 过滤：目录可被追问"只给我函数"
  const kindFilter = typeof request.kind === 'string' ? request.kind : null

  // **按重要性分级，而不是按声明顺序**——这是本次重写的全部要点。
  // 排序依据与"失败时的符号目录"共用同一个 rankSymbols，避免两处各修一遍。
  const ranked = rankSymbols(indexStructure(source, lang), lines)
    .filter((x) => x.imp > 0)
    .filter((x) => kindFilter === null || x.s.kind === kindFilter)

  const header = `${base.totalLines} lines · ${all.length} symbols (${Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(' ')})`
  /**
   * 被 `imp > 0` 过滤掉的符号要**分两类报**（T10）。
   *
   * 它们对模型的可用性完全不同：
   *   · **函数体内的局部量**（`enclosing !== null`）——真噪声：要改它用行号/外层符号即可，
   *     没必要出现在目录里，也**无法**用 `target=<name>` 取回（它本来就不是顶层名字）。
   *   · **顶层未导出绑定**（`enclosing === null`）——这些是**可用信息**：它们是可按名寻址的，
   *     而先前被一律说成 “nested locals” 并建议用 `mode=lines`——**给出的取回方式对它们不成立**。
   *
   * 一条**不可执行的恢复指令比不写更坏**（本项目自己的原则：报错要带下一步）。
   * 这一条也是在 T7 把 `export const` 修进索引之后才成为可验证的：
   * 在那之前顶层未导出绑定连索引都进不了，“按名取回”是句空话。
   */
  // 用**稳定标识**（kind+name+startLine）而非引用比较：`rankSymbols` 每次调用返回新的包装对象，
  // `r.s === s` 永远不相等——那样算出来的“顶层未列出”数会把**已经列出的**也算进去（实测差了一倍）。
  const idOf = (s) => `${s.kind}\u0000${s.name}\u0000${s.startLine}`
  const rankedIds = new Set(ranked.map((r) => idOf(r.s)))
  const omittedByRank = kindFilter !== null ? [] : all.filter((s) => !rankedIds.has(idOf(s)))
  const localCount = omittedByRank.filter((s) => s.enclosing !== null && s.enclosing !== undefined).length
  const topLevelCount = omittedByRank.length - localCount
  // `exported` 由 rankSymbols 一并给出，这里不再用 `imp === 3` 反推——
  // 用分数反推布尔值，等于把"导出"的含义绑死在"最高重要性恰好是 3"上。
  /**
   * 地图分两段：**导出面在前**，内部符号在后（T25）。
   *
   * ## 为什么必须分段，而不是靠排序碰巧把导出排前
   *
   * 分形几何里让体积变大而不抬高结构成本的，是"边界量级受控"——代码里那就是**导出面**：
   * 文件再大，“它给别人什么”通常仍是常数个名字。而先前的 `map` 只用一个 `★` 标记把它
   * 混在符号表里：于是回答公共接口问题必须**读完整个目录再自己筛**——理解代价随体积线性增长。
   *
   * 实测：本仓库最大的目录是 `build/upgrade-test.mjs`（159 符号）；日志里还有一个
   * 10135 行 / 1727 符号的文件。那些规模上，“读完再筛”等于答不出来。
   *
   * 分段之后，“它给别人什么”变成**读前几行**的常数成本问题。
   * 导出面先占预算，剩余预算再给内部符号——这是刻意的优先级，不是排序副产物。
   *
   * ## 与 T7 的因果关系
   *
   * T7 修好了 `export const` 进索引。在那之前**边界本身是丢的**——
   * 所以这一条是 T7 的直接兞现：边界先要**存在**，然后要**被突出**。
   */
  const rowOf = (s, mark) => `${mark} ${s.kind.padEnd(9)} ${s.name.padEnd(26)} ${s.startLine}-${s.endLine}`
  const exportedRows = ranked.filter((r) => r.exported === true)
  const internalRows = ranked.filter((r) => r.exported !== true)
  const rows = [
    `exported (${exportedRows.length}):`,
    ...exportedRows.map(({ s }) => rowOf(s, '★')),
    ...(internalRows.length === 0 ? [] : ['internal:', ...internalRows.map(({ s }) => rowOf(s, ' '))]),
  ]
  /**
   * 与 `rows` **逐行对齐**的符号表（分段标题行对应 null）。
   *
   * 续读参数要回答“没列出来的那批符号在哪几行”，而那是从行号算出来的：
   * 没有这份对齐表，就只能像上一版那样回一句 `mode=digest for all signatures`——
   * 它连“剩下多少个”都没说，更不用说“去哪拿”。两份数组必须同源同长，
   * 否则“被截掉的符号”会数错（本项目在 `fitWithin.kept` 上已经因此裁过一次）。
   */
  const rowSyms = [
    null,
    ...exportedRows.map(({ s }) => s),
    ...(internalRows.length === 0 ? [] : [null, ...internalRows.map(({ s }) => s)]),
  ]
  const kept = fitWithin([header, ...rows].join('\n'), base.contentBudget)

  // 渲染了几行符号 = 实际收下的总行数 − 表头那一行。
  // 第一版直接用 kept.kept 当符号数，于是表头被算成一个符号，
  // 报出 "symbols 2..2 of 2" 这种"丢了一个"的假警告，而其实两个都渲染了。
  // 渲染了几行 = 实际收下的总行数 − 表头那一行。**注**：`rows` 现在含分段标题行
  // （`exported (N):` / `internal:`），所以这个数是"行"不是"符号"——
  // 字段名保持 `shown` 不变，但下面报超出时用 `rows.length`，两者同尺子。
  const shownCount = Math.max(0, kept.kept - 1)
  const budgetCut = shownCount < rows.length
  const omissions = []
  if (localCount > 0) {
    omissions.push(`${localCount} nested locals omitted (inside a function — reach them with mode=lines, not target=)`)
  }
  if (topLevelCount > 0) {
    // 顶层绑定是**可按名寻址**的：给的方式与局部量相反，因此必须分开说。
    omissions.push(`${topLevelCount} top-level binding(s) not listed here — address them by name with target=<name>`)
  }
  if (budgetCut) {
    omissions.push(`symbols ${shownCount + 1}..${rows.length} of ${rows.length} beyond the content budget`)
  }
  /**
   * 没被列出来的那批符号占了哪几行。
   *
   * 这是 `map` 截断唯一**可执行**的续读：地图本身按预算填、也没有 offset 参数，
   * 所以“剩下半张地图”没法再点一次；但那批符号的**源码行区间**是确定且可读的，
   * 而读源文正是拿到它们的最短路径。
   */
  const droppedSyms = budgetCut ? rowSyms.slice(kept.kept).filter((s) => s !== null && s !== undefined) : []
  const resumeLines =
    droppedSyms.length === 0
      ? null
      : [Math.min(...droppedSyms.map((s) => s.startLine)), Math.max(...droppedSyms.map((s) => s.endLine))]
  return {
    ...base,
    mode: 'map',
    symbols: all.length,
    shown: shownCount,
    byKind,
    text: kept.text,
    ...(omissions.length > 0 ? { omitted: omissions.join('; ') } : {}),
    // `limit` 已不再是参数——地图按预算填，不按固定条数截。因此续读建议里不能再提 limit
    // （第一版留了 `limit=55` 这种已经不起作用的提示，那是把过时的接口写进了输出）。
    //
    // 截断时的 `next` 也不再是 `mode=digest for all signatures` 这类**建议**：
    // digest 自己也会被预算截（只是换一种截法），而“剩下那批符号在哪几行”现在算得出来。
    ...(resumeLines === null
      ? budgetCut
        ? { next: 'mode=digest for all signatures · mode=around around=<name> for one region' }
        : { next: 'mode=around around=<name> · mode=lines lines=[a,b] · mode=digest for signatures' }
      : {
          resume: { mode: 'lines', lines: resumeLines },
          next: `mode=lines lines=[${resumeLines[0]},${resumeLines[1]}] covers the ${droppedSyms.length} symbol(s) that did not fit this map`,
        }),
  }
}

/**
 * around —— 给一个目标，返回它周围的窗口。
 *
 * 这是"我要改那处"最自然的表达。比旧 read 的"从 offset 开始翻页"少一次试探：
 * 模型不必先知道行号，只要说出它要改的东西。
 */
function renderAround(base, lines, lang, request, symbolsIndex = null) {
  const target = typeof request.around === 'string' ? request.around.trim() : ''
  if (target.length === 0) {
    return { ok: false, code: 'READ_NO_TARGET', message: 'mode=around needs `around`' }
  }
  const ctx = request.context ?? 8

  // 先按符号解析；不是符号名就按子串找行
  let center = null
  let how = null
  if (lang !== null) {
    try {
      const hit = resolveTarget(indexStructure(lines.join('\n'), lang), target)
      center = hit.startLine
      how = `symbol ${hit.kind}:${hit.name} (${hit.startLine}-${hit.endLine})`
    } catch {
      center = null
    }
  }
  if (center === null) {
    const hits = []
    for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(target)) hits.push(i + 1)
    if (hits.length === 0) {
      return { ok: false, code: 'READ_NOT_FOUND', message: `no symbol or line matching ${JSON.stringify(target)}` }
    }
    if (hits.length > 1) {
      return {
        ok: false,
        code: 'READ_AMBIGUOUS',
        message: `${JSON.stringify(target)} appears on ${hits.length} lines`,
        candidates: hits.slice(0, 20).map((n) => ({ line: n, text: lines[n - 1].trim().slice(0, 80) })),
        next: 'narrow with mode=around around=<unique word> or mode=lines lines=[a,b]',
      }
    }
    center = hits[0]
    how = `line containing ${JSON.stringify(target)}`
  }

  const from = Math.max(1, center - ctx)
  const to = Math.min(lines.length, center + ctx)
  // `around` 一直带着符号引用（在 `label` 里）；这里再附上结构化的可重新定位引用，
  // 让消费方不必去解析那段人类可读的字符串。
  return windowEnvelope(base, lines, from, to, `around ${how}`, center, null, symbolsIndex)
}

/** lines —— 给区间，返回原文。这是 patch 的 lines 层在读取侧的对偶。 */
/** lines —— 给区间，返回原文。这是 patch 的 lines 层在读取侧的对偶。 */
function renderLines(base, lines, request, symbolsIndex = null, scan = null, handleContext = null) {
  const range = request.lines
  if (!Array.isArray(range) || range.length === 0) {
    return { ok: false, code: 'READ_NO_RANGE', message: 'mode=lines needs lines=[start,end]' }
  }
  const start = range[0]
  const end = range[1] ?? range[0]
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { ok: false, code: 'READ_BAD_RANGE', message: `lines must be [start,end] with 1 <= start <= end` }
  }
  if (start > lines.length) {
    return { ok: false, code: 'READ_OUT_OF_RANGE', message: `start ${start} is past end of file (${lines.length} lines)` }
  }
  const to = Math.min(end, lines.length)
  const note = end > lines.length ? `requested to ${end}, file ends at ${lines.length}` : null
  // `lines` 模式曾经只给裸行号：编辑一插行，模型手里那个区间就失效且无从换算。
  // 现在附上"这一段属于哪个符号"——符号名在插入/删除下不变。
  //
  // `scan` 只在会话账本认定这是同一段顺扫的下一段时非空（见 {@link planScan}）；
  // 它把窗口右端从请求里的 N 换成文件末尾，让预算去决定给多少。
  return windowEnvelope(base, lines, start, to, 'requested range', start, note, symbolsIndex, scan, handleContext)
}

/**
 * 给一个行号找一个**可重新定位的引用**（最小的包含它的符号）。没有符号层可用时返回 null。
 *
 * ## 为什么需要它（动态视角）
 *
 * 本工具的输出里，行号是**绝对坐标**，而编辑正是**破坏绝对坐标的那个变换**：
 * 上面插一行，下面所有行号 +1。于是模型手里那句 `6: return b` 一旦经过一次编辑就**失效**，
 * 而它手里**没有别的东西可以用来换算**——它只知道"第 6 行"，不知道第 6 行属于谁。
 *
 * 而 `around` 模式一直带着这个引用（`label` 形如 `around symbol function:alpha (1-3)`），
 * `map` 模式本身就全是符号；**只有 `lines` 与 `search` 给的是裸行号**。
 * 这不对称本身就是错：同一份输出里，有的位置可以重新定位、有的不行。
 *
 * 补的东西不增加任何新概念：符号表在渲染前**已经建好了**（`map`/`digest` 都要用），
 * 这里只是在同一个索引上多做一次包含查询，并把结果接在一行里。
 *
 * @param index - `indexStructure` 的结果
 * @param line - 1-based 行号
 * @returns `{target, lines}` 或 null
 */
/**
 * 把若干行映射为**统一形状**的可重新定位引用。
 *
 * 形状必须唯一。第一版让 `lines`/`full`/`around` 返回一个对象、`search` 返回一个拼接好的
 * 字符串（`"2 → alpha (1-3); 6 → beta (5-7)"`）——那是典型的**同一字段两种含义**：
 * 消费方（工具壳、schema、跨语言适配器）按任一种解释都会错，而 schema 层根本表达不了。
 * 本项目已经在 `fitWithin.kept` 上因为这件事栽过一次，不再重犯。
 *
 * @param index - `indexStructure` 的结果
 * @param lineNumbers - 1-based 行号列表
 * @returns `{line, target, lines}[]`（保留原顺序，无符号可归属的行被跳过）
 */
function relocatableFor(index, lineNumbers) {
  const out = []
  for (const line of lineNumbers) {
    const hit = relocatableAt(index, line)
    if (hit === null) continue
    out.push({ line, target: hit.target, lines: hit.lines })
  }
  return out
}

/**
 * 给一个行号找一个符号引用。
 *
 * @param index - `indexStructure` 的结果
 * @param line - 1-based 行号
 * @returns `{target, lines}` 或 null
 */
function relocatableAt(index, line) {
  let best = null
  for (const s of listSymbols(index)) {
    // 只收**跨度确定**的符号：跨度不确定的符号 `target=` 会被结构化拒绝（fail-closed），
    // 那时把它当引用推给模型等于推荐一个必然失败的动作。
    if (s.spanComplete === false) continue
    if (s.startLine <= line && line <= s.endLine) {
      // 取**最小**的包含者：嵌套时越内层越接近那一行，漂移它相对更稳
      const span = s.endLine - s.startLine
      if (best === null || span < best.span) best = { span, s }
    }
  }
  if (best === null) return null
  return { target: best.s.name, lines: [best.s.startLine, best.s.endLine] }
}

/** search —— 全文找一个子串，返回命中行与上下文。 */
/**
 * `search` 命中行的字符上限。
 *
 * 它不取代内容预算（那是总量约束），只管**单行**：一个压缩过的单行文件里，
 * 一行就可能超过整个内容预算。两个限额职责不同，因此都要在，且都必须披露。
 */
const MATCH_LINE_CHARS = 110

/** `digest` 里单个签名的字符上限；超过就截断并在行尾报出省略量（T12）。 */
const SIGNATURE_CHARS = 68

function renderSearch(base, lines, request, symbolsIndex = null, handleContext = null) {
  const q = typeof request.search === 'string' ? request.search : ''
  if (q.length === 0) return { ok: false, code: 'READ_NO_QUERY', message: 'mode=search needs `search`' }
  const hits = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(q)) hits.push(i + 1)
  if (hits.length === 0) {
    return { ok: false, code: 'READ_NOT_FOUND', message: `no line contains ${JSON.stringify(q)}` }
  }
  /**
   * 上限夹一层，不只是"接受调用方给的 limit"。
   *
   * 为什么必须夹：`limit` 是**调用方可控**的，而句柄是按命中数线性增长的。
   * 调用方一句 `limit=100000`（或只是习惯性填个大数）就能让单条回执挂上十万条句柄——
   * 「回执体积不许回涨」（契约 §2.5）就成了一句只能靠调用方自觉的话。
   * 夹在 {@link HANDLE_MAX_PER_RECEIPT} 之后，上界是**本工具自己保证的**：420 字符。
   *
   * 为什么是夹住整条回执而不只夹句柄数组：句柄必须**只指它真的渲染出来的那些行**。
   * 否则拿到柄也拿不到那段文本，而工具没说过这件事——那是静默的半个答案。
   */
  const limit = Math.min(request.limit ?? 40, HANDLE_MAX_PER_RECEIPT)
  const shown = hits.slice(0, limit)
  /**
   * 每条命中一个句柄（契约 §4）。两个落点**都要**：
   *   · `handles: [{line, handle}]`（结构化，与 `relocatable` 同形）——宿主 / UI / schema 面用；
   *   · **每个命中行的行尾**（`  <句柄>`）——模型面用。
   *
   * 为什么非要有第二个落点（HD3 集成时实测出来的）：壳层只把 `value.text` 交给模型
   * （`aura-read/index.js` 的 `render: (_args, value) => [{type:'text', text: value.text}]`），
   * 框架再把 `result.content` 装进 tool 消息——**结构化字段一个都到不了模型**。
   * 只发结构化字段 = 句柄存在但没人看得见，而本波的全部价值就是让模型手里有一个
   * 工具发的、逐字节正确的区间地址。
   *
   * 行首的 `N: ` 前缀一个字不许动：既有解析器（`^\d+: `）靠它取行号，动了就会把
   * "格式演进"变成"行为退化"。所以句柄一律接在**行尾**。
   *
   * 区间取**单行**（`n-n`）：`search` 的命中就是一行，句柄指多行反而让"改哪里"变模糊。
   */
  const handles = (handleContext === null ? [] : shown)
    .map((n) => ({ line: n, handle: handleFor(handleContext.ledgerKey, lines, handleContext.byteOrderMark, n, n) }))
    .filter((h) => h.handle !== null)
  const handled = handles.length
  /**
   * 命中行也要**披露截断**（T12）。
   *
   * 先前这里是 `slice(0, 110)` 的裸数字：一行被切掉尾巴时回执不说任何话，
   * 而 `search` 恰好是**唯一能看到超长行内部**的模式（行区间只能整行给）。
   * 不披露就等于告诉模型“这一行就到那里”。
   * `windowEnvelope` 早就有这套机制（`truncated` + `omitted`），这里只是把同一件事补上。
   */
  /** 行号 → 句柄。末尾没柄的行拿不到（不会指到没渲染的文本）。 */
  const handleByLine = new Map(handles.map((h) => [h.line, h.handle]))
  const clipped = []
  const rows = shown.map((n) => {
    const raw = lines[n - 1].trim()
    // 句柄接在**行尾**：行首的 `N: ` 前缀是既有解析器（`^\d+: `）的锚点，一个字符都不能动。
    const handle = handleByLine.get(n) ?? null
    if (raw.length <= MATCH_LINE_CHARS) return withHandleOnLine(`${n}: ${raw}`, handle)
    const cut = raw.length - MATCH_LINE_CHARS
    // 形状与 `windowEnvelope` 的 `truncated` **完全一致**（{line, shown, omittedChars}）：
    // 第一版这里给的是 `{line, omittedChars}` 的数组，而 `windowEnvelope` 给的是对象——
    // 同一个字段名两种含义，schema 层根本表达不了。本项目已因此裁过一次。
    clipped.push({ line: n, shown: MATCH_LINE_CHARS, omittedChars: cut })
    return withHandleOnLine(`${n}: ${raw.slice(0, MATCH_LINE_CHARS)} ⋯ [truncated ${cut} chars]`, handle)
  })
  const kept = fitWithin(rows.join('\n'), base.contentBudget)
  // 每个命中行附上"它属于哪个符号"。行号会随编辑漂坏（插一行→下面全 +1），
  // 而符号名不会；`search` 是四个内容模式里**唯一连 label 都没有**的一个，
  // 所以模型的相对位置感知在这里最弱。
  // 只对**真的带柄**（因此真的渲染了）的命中求符号引用：两者同源同序，不会一个有一个没有。
  const relocatable = symbolsIndex === null ? [] : relocatableFor(symbolsIndex, handles.map((h) => h.line))
  return {
    ...base,
    mode: 'search',
    matches: hits.length,
    // 句柄在 `matches` 之后、`relocatable` 之前：三个字段同序叙述同一批命中。
    ...(handles.length === 0 ? {} : { handles }),
    ...(hits.length > handled
      ? {
          handlesOmitted: {
            total: hits.length,
            emitted: handled,
            max: HANDLE_MAX_PER_RECEIPT,
            reason: `handles are capped at ${HANDLE_MAX_PER_RECEIPT} per receipt; narrow \`search\` to get handles for the rest`,
          },
        }
      : {}),
    ...(relocatable.length === 0 ? {} : { relocatable }),
    ...(clipped.length === 0 ? {} : { truncated: clipped[0] }),
    ...(clipped.length <= 1 ? {} : { truncatedLines: clipped }),
    text: kept.text,
    ...(hits.length > kept.kept || clipped.length > 0
      ? {
          omitted: [
            hits.length > kept.kept ? `matches ${kept.kept + 1}..${hits.length} of ${hits.length}` : null,
            clipped.length > 0 ? `${clipped.length} matched line(s) clipped to ${MATCH_LINE_CHARS} chars` : null,
          ]
            .filter((x) => x !== null)
            .join('; '),
          // 续读参数：命中行给到一半时，**剩下那批命中落在什么行区间**是算得出来的，
          // 就不该回一个 `lines=[<a>,<b>]` 的模板让调用方自己填。
          ...searchResume(hits, shown, kept.kept, clipped, lines),
        }
      : {}),
  }
}

/**
 * `search` 的续读参数。
 *
 * 两种截断各不相同，不能只给一句话：
 *   · **命中行被预算截掉**（`hits` 多于实际渲染的）⇒ 续读是一个**确定的行区间**，
 *     从第一个没渲染的命中行到最后一个命中行；
 *   · **单行本身被裁到 {@link MATCH_LINE_CHARS}** ⇒ 行区间救不了（`lines` 给整行时
 *     会被内容预算再截一次，而截出来的还是**同一行的开头**）。这种情况只有 `search`
 *     能看到行内部，所以续读参数必须是一个**真的子串**——取自被裁掉的那一段。
 */
function searchResume(hits, shown, keptRows, clipped, lines) {
  if (clipped.length > 0) {
    const first = clipped[0]
    const query = beyondClipQuery((lines[first.line - 1] ?? '').trim(), first.shown)
    if (query !== null) {
      return {
        resume: { mode: 'search', search: query },
        next: `mode=search search=${JSON.stringify(query)} to see text beyond the clip on line ${first.line}`,
      }
    }
  }
  if (hits.length > keptRows) {
    const from = shown[keptRows] ?? hits[keptRows]
    const to = hits[hits.length - 1]
    return {
      resume: { mode: 'lines', lines: [from, to] },
      next: `mode=lines lines=[${from},${to}] to read the rest of the matches in one call`,
    }
  }
  return {}
}

/**
 * 窗口渲染：把 [from,to] 行渲染成带行号的文本，**在超出预算时显式截断并说明**。
 *
 * 单行**不设独立长度上限**。我先前加了 `raw.length > 160` 的截断，那是错的：
 * 它与字符预算机制重复，两个各自合理的机制叠在一起，产生的正是我在审计旧 read 时
 * 批评过的形状——两级截断互不知情，输出既不完整也不说明。
 * 现在只有一个机制：按预算收行。
 *
 * ## 超过预算的**单行**必须是"截断并标注"，而不是"整行不给"
 *
 * 这里曾经是后者，而且是个真实缺陷：预算判断排在前面，所以只要某一行自己就超过
 * `contentBudget`，循环立刻 `break`，`rows` 为空 —— 于是**整个文件读不出一个字**。
 * 实测（单行 8000 / 20000 字符）：
 *   lines [1,1] text=0 · full text=0 · around text=0 · auto text=0
 * 唯一的例外是 `search`（它给的是匹配处的字符窗口）。更糟的是 `next` 还在建议
 * `mode=lines lines=[1,1]` —— **让模型重试刚刚返回空内容的同一个调用**，是个死循环。
 *
 * 压缩过的 JS、单行数据、单行配置都会触发它。这正是本模块开头列为"要消灭的三类缺陷"
 * 之一的静默丢失，只是换了个位置复现。
 *
 * 现在的取舍是明确的：给**前面一段**并标注还有多少字符没给。注释原先担心
 * "切掉行尾会让模型以为这一行就到那里"——那个担心是对的，所以标注必须显式且醒目；
 * 但"什么都不给"并不能保护模型，只是把不可读换成了另一种不可读。
 *
 * @param base - 信封基底
 * @param lines - 文件行
 * @param from - 起始行（1-based）
 * @param to - 结束行（1-based，含）
 * @param label - 这段窗口的来历，用于回执
 * @param center - 焦点行
 * @param note - 额外的省略说明
 * @param symbolsIndex - 已建好的符号索引（可选）；给了就附带"可重新定位的引用"
 */
function windowEnvelope(
  base,
  lines,
  from,
  to,
  label,
  center,
  note = null,
  symbolsIndex = null,
  scan = null,
  /** `{ledgerKey, byteOrderMark}` 或 null。null = **不发句柄**（`around` / `changed` 走这条）。 */
  handleContext = null,
) {
  const total = lines.length
  /**
   * 顺扫：窗口的右端**不再由请求里那个 N 决定，而由预算决定**。
   *
   * 这是本文件唯一一处「多给」，而且只在会话账本认定「这是同一次顺扫的下一段」时打开
   * （见 {@link SCAN} / {@link planScan}）。它只往下、不越过文件末尾、永远包含请求区间，
   * 因此 `lines` 的既有语义（请求的那几行一定在里面）没有被改。
   */
  const limit = scan !== null && scan.extend === true ? Math.max(to, total) : to
  const rows = []
  let chars = 0
  let lostFrom = null
  let truncated = null
  /**
   * 句柄要落在**窗口的头行**上（契约 §4），而头行是哪一行由预算决定——
   * 所以预留不能拍死：先按 `from` 算一份，等 `deliveredTo` 定下来再换真的那一份。
   *
   * 预留必须**在循环里**算：句柄是行的一部分，把它排除在预算外，
   * 就会出现"行放下了、句柄被拆掉"的静默半答案。
   */
  const reserve = handleContext === null ? 0 : handleInlineChars(from, from)
  for (let n = from; n <= limit; n += 1) {
    const raw = lines[n - 1] ?? ''
    const rendered = `${n}: ${raw}`
    const cost = rendered.length + 1 + (rows.length === 0 ? reserve : 0)
    if (chars + cost <= base.contentBudget) {
      chars += cost
      rows.push(rendered)
      continue
    }
    // 放不下。若这是窗口的第一行，就不能空手而归——给一段并标注截断。
    if (rows.length === 0) {
      // `suffix` 是行号之外还要留的说明空间：截断标记本身也要算进预算，
      // 否则"标注"会把内容顶出预算，重演同一个问题。
      const suffix = ' ⋯ [truncated]'
      const budget = base.contentBudget - reserve
      const take = Math.max(0, budget - suffix.length - `${n}: `.length)
      if (take > 0) {
        rows.push(`${n}: ${raw.slice(0, take)}${suffix}`)
        truncated = { line: n, shown: take, omittedChars: raw.length - take }
      }
    }
    lostFrom = n
    break
  }
  const kept = rows.length
  /** 实际交付到的最后一行；“已经读到哪”这句话的唯一来源。 */
  const deliveredTo = kept === 0 ? from - 1 : from + kept - 1
  const budgetCut = lostFrom !== null && lostFrom <= limit
  /**
   * 头行现在是确定的，句柄就在这里真的接上去（第二轮）。
   *
   * 为什么不在循环里直接接：头行上那个句柄的**结束行**就是 `deliveredTo`，而它要到
   * 循环跑完才知道（预算可能砍在中间、顺扫可能把窗口拉长）。用 `from` 硬编出来的是
   * 一个**指错区间**的地址——那比不发还坏。
   */
  const headHandle =
    handleContext === null || kept === 0
      ? null
      : handleFor(handleContext.ledgerKey, lines, handleContext.byteOrderMark, from, deliveredTo)
  /**
   * 结构句柄：只在调用方显式要、且交付窗口**恰好**等于一个符号的跨度时发。
   * 不在跨度上就不发——“长得差不多”的区间不能冒充一个结构节点。
   */
  const structureHandle =
    base.structureHandle !== true || handleContext === null || kept === 0 || symbolsIndex === null
      ? null
      : (() => {
          const hit = symbolsIndex.symbols.find((symbol) => symbol.startLine === from && symbol.endLine === deliveredTo)
          if (hit === undefined) return null
          return mintStructureHandle({
            ledgerKey: handleContext.ledgerKey,
            regionText: lines.slice(from - 1, deliveredTo).join('\n'),
            byteOrderMark: handleContext.byteOrderMark,
            kind: 'symbol',
            path: hit.name,
          })
        })()
  const rowsWithHandle = headHandle === null ? rows : [withHandleOnLine(rows[0], headHandle), ...rows.slice(1)]
  const out = {
    ...base,
    mode: base.mode,
    center,
    label,
    // 可重新定位的引用：见 {@link relocatableAt} 的长注释（行号会随编辑腐坏）。
    // 统一取**数组**形状，即使窗口起点只有一个引用。
    ...(symbolsIndex === null || relocatableFor(symbolsIndex, [from]).length === 0
      ? {}
      : { relocatable: relocatableFor(symbolsIndex, [from]) }),
    shown: kept === 0 ? 'none' : `${from}-${deliveredTo}`,
    // 区间句柄：**整段一个**，落在本层（`shown` / `relocatable` 同级），不进 `text`。
    //
    // 覆盖的区间是**实际交付的**那一段（预算截断与顺扫延伸都算进去），而不是请求里那个 N：
    // 调用方拿到柄之后要编辑的是"它手里那段字节"，不是"它当初点名要的那几行"。
    // 两者在预算截断时会分叉，而分叉后一个指得到、一个指不到——指不到的那个是错的。
    // 与接在头行上的那一个**是同一个值**（`headHandle` 只算一次）：两处各算一次的话，
    // 以后任何一处改了口径，结构化字段与模型看到的文本就会静默地对不上。
    ...(headHandle === null ? {} : { handle: headHandle }),
    ...(structureHandle === null ? {} : { structure_handle: structureHandle }),
    text: rowsWithHandle.join('\n'),
  }
  const omissions = []
  if (truncated !== null) {
    // 截断必须能被程序化读取，不能只藏在 omitted 的自然语言里
    out.truncated = truncated
    omissions.push(
      `line ${truncated.line} truncated: ${truncated.omittedChars} of ${truncated.omittedChars + truncated.shown} chars withheld (content budget ${base.contentBudget} chars)`,
    )
  }
  if (budgetCut) {
    omissions.push(`lines ${lostFrom}-${limit} (content budget ${base.contentBudget} chars)`)
  }
  if (limit > to && kept > 0) {
    omissions.push(
      `requested ${from}-${to}; continued to ${from}-${deliveredTo} because this continues a forward scan and the content budget still had room`,
    )
  }
  if (note !== null) omissions.push(note)
  if (omissions.length > 0) out.omitted = omissions.join('; ')
  /**
   * 续读参数 `resume`：**下一次调用的确切参数**，而不是一句“接下来可以看看……”。
   *
   * 为什么不是一个自然语言的建议：实测里模型真的会去猜下一段（“上次没给够”占重复读 10.6%），
   * 而猜的方式是重新点一遍已经看过的地方。一个**可以直接拿去再调一次**的字段，比一句
   * “用 mode=lines 继续”有用得多——后者要求调用方自己算出起止行，而那正是它没有的信息。
   *
   * 形状与工具入参同名同形（`mode` + `lines` / `search`），所以回执里的值可以原样回填。
   */
  if (truncated !== null) {
    // 单行内部再切只有 search 模式做得到（它给的是匹配处的字符窗口）。
    // 先前这里给的是 `search=<substring on line N>`——一个**带尖括号的模板**，
    // 调用方没法直接执行；现在从被扣下的那段里取一个真的子串填进去。
    const query = beyondClipQuery(lines[truncated.line - 1] ?? '', truncated.shown)
    if (query === null) {
      out.next = `mode=search search=<substring on line ${truncated.line}> to see text beyond the clip`
    } else {
      out.resume = { mode: 'search', search: query }
      out.next = `mode=search search=${JSON.stringify(query)} to see text beyond the clip on line ${truncated.line}`
    }
  } else if (budgetCut) {
    // 「把剩余一次取完」：续读区间一路给到**文件末尾**，而不是回到请求里那个 N。
    // 下一次调用自己会被预算截到该截的地方，调用方不必先猜 N 该填多少。
    out.resume = { mode: 'lines', lines: [lostFrom, total] }
    out.next = `mode=lines lines=[${lostFrom},${total}] to take the rest in one call`
  }
  return out
}

/**
 * 单行被截断时，从**被扣下的那一段**里取一个有辨识度的子串，当 `search` 的入参。
 *
 * 必须来自被扣下的部分（而不是整行）：否则调用方拿它去 search，拿回来的还是同一段
 * 已经看过的开头，等于没续上。
 */
const RESUME_QUERY_CHARS = 24

function beyondClipQuery(raw, shown) {
  const withheld = raw.slice(shown).trim()
  if (withheld.length === 0) return null
  return withheld.slice(0, RESUME_QUERY_CHARS)
}

/**
 * 按预算收行：从前往后收，收不下就停。
 *
 * **返回值语义必须唯一**：`kept` 始终是"实际写进 text 的行数"。这一点第一版是错的——
 * 超预算分支返回收下的行数（含表头），不超预算分支却返回传入的 `totalRows`（不含表头）。
 * 同一个字段两种含义，调用方按一种解释就会差 1，于是明明全渲染了却报"丢了一个"。
 * 这类 bug 不报错、只撒谎，比崩溃难查得多。
 *
 * @param body - 已经拼好的文本（调用方若加了表头，表头也算一行）
 * @param budget - 字符预算
 * @returns {{text, kept, dropped}} kept = text 的实际行数
 */
function fitWithin(body, budget) {
  const rows = body.split('\n')
  if (body.length <= budget) return { text: body, kept: rows.length, dropped: 0 }
  let chars = 0
  const keptRows = []
  for (const r of rows) {
    if (chars + r.length + 1 > budget) break
    chars += r.length + 1
    keptRows.push(r)
  }
  return { text: keptRows.join('\n'), kept: keptRows.length, dropped: rows.length - keptRows.length }
}
