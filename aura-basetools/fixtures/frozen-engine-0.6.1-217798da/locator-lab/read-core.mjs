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
const DEFAULT_ENVELOPE_ALLOWANCE = 700
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
export const MODES = ['map', 'digest', 'full', 'around', 'lines', 'search', 'changed']

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
    return {
      ...base,
      mode: 'digest',
      note: `unsupported extension — no structure available; ${base.totalLines} lines`,
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
  for (const s of syms) {
    if (s.enclosing !== null && s.enclosing !== undefined) continue // 函数体内的量不是导出
    const own = lines[s.startLine - 1] ?? ''
    if (/\bexport\b/.test(own)) {
      exported.push(`${s.kind} ${s.name}`)
      continue
    }
    // 向上看紧邻的连续行，遇到空行即停（`export {` 与声明之间不会有空行）
    for (let k = s.startLine - 2; k >= 0; k -= 1) {
      const up = lines[k] ?? ''
      if (up.trim().length === 0) break
      if (/\bexport\b/.test(up)) {
        exported.push(`${s.kind} ${s.name}`)
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
  const heading = [
    `${base.totalLines} lines · ${syms.length} symbols · ${control} control-flow`,
    `exported: ${exported.join(', ') || '(none)'}`,
    `imports: ${imports.join(', ') || '(none)'}`,
    `external calls: ${external.slice(0, 16).join(', ') || '(none)'}`,
    '--- signatures ---',
  ]
  const parts = [...heading, ...signatures]
  const kept = fitWithin(parts.join('\n'), base.contentBudget)
  const dropped = Math.max(0, signatures.length - Math.max(0, kept.kept - heading.length))
  return {
    ...base,
    mode: 'digest',
    symbols: syms.length,
    exported,
    text: kept.text,
    // 摘要也会超预算（函数极多时）。同一契约：超了必须显式。
    ...(dropped > 0
      ? { omitted: `${dropped} more signatures beyond the content budget`, next: 'mode=map to see the full symbol list' }
      : { next: 'mode=around around=<name> to see one function' }),
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
 * 存储契约（五个方法）：remember / latest / entry / recall / count。
 *
 * @param limit - 条目上限；超出按插入顺序淘汰（淘汰时同步清"最近观测"指针，
 *   否则它会指向一条不存在的全文）。
 */
export function createMemoryStore(limit = 8) {
  const seen = new Map() // `路径@版本` → { source, byteOrderMark }
  const latest = new Map() // 路径 → `路径@版本`
  return {
    remember(filePath, version, source, byteOrderMark = false) {
      const key = `${filePath}@${version}`
      seen.delete(key)
      seen.set(key, { source, byteOrderMark: byteOrderMark === true })
      latest.set(filePath, key)
      while (seen.size > limit) {
        const oldest = seen.keys().next().value
        seen.delete(oldest)
        for (const [p, k] of latest) if (k === oldest) latest.delete(p)
      }
    },
    latest(filePath) {
      const key = latest.get(filePath)
      if (key === undefined) return null
      const entry = seen.get(key)
      if (entry === undefined) return null
      return { version: key.slice(filePath.length + 1), source: entry.source, byteOrderMark: entry.byteOrderMark === true }
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

/** 换掉观测存储（传 null 恢复默认内存实现）。引擎只依赖上面那五个方法。 */
export function setObservationStore(store) {
  STORE = store ?? createMemoryStore()
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
export function rememberRead(filePath, version, source, byteOrderMark = false) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return
  STORE.remember(filePath, version, source, byteOrderMark)
}

/**
 * 这个文件**最近一次被观测到**的全文（供区域级新鲜度闸门当判据）。
 *
 * 从没读过、或那一条已被淘汰 ⇒ null，语义是"没观测过"（闸门不拦，但回执会带 unverified_region）。
 * 每一模式的读都会记账（见 {@link readWith} 的 render），不只是 `changed`。
 */
export function latestObservation(filePath) {
  if (typeof filePath !== 'string') return null
  return STORE.latest(filePath)
}

/** 缓存条目（内容 + BOM 元数据）；模块内部使用，未命中返回 null。 */
function seenEntry(filePath, version) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return null
  return STORE.entry(filePath, version)
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
export function hasObservedVersion(filePath, version) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return false
  return STORE.has(filePath, version)
}

/** 取回某个版本的**全文**；未命中返回 null（缓存有界，这是正常情况而非错误）。 */
export function recallRead(filePath, version) {
  if (typeof filePath !== 'string' || typeof version !== 'string') return null
  return STORE.recall(filePath, version)
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
function renderChanged(base, source, lines, request, symbolsIndex = null) {
  const filePath = request.filePath ?? null
  /**
   * `since` 不是字符串时（缺省／null／其它类型）一律当作**没有基准**，也就是首读。
   *
   * 先前这里把非字符串的 `since` 当成"首读哨兵"并返回 `version: null`。那个 null 传不下去：
   * 工具声明的 schema 里 version 是 string，框架对字符串字段做类型校验
   * （dsh-tools/lib/index.js:495 `typeof value === "string"`），于是 null 会被判违规：
   *   tool "aura_read" returned invalid output: "value.version" must be a string
   * 更糟的是它**没意义**：回执的 next 让模型"把 version 传回来"，而 null 传回来又落回同一分支——
   * 一个永远解不开的环。现在首读也给真令牌，环就断了。
   */
  const sinceRaw = typeof request.since === 'string' && request.since.length > 0 ? request.since : null
  const byteOrderMark = request.byteOrderMark === true
  const version = contentToken(source, byteOrderMark)
  const sinceVersion = sinceRaw !== null && sinceRaw !== '<first>' ? sinceRaw : null
  const prevEntry = sinceVersion === null ? null : seenEntry(filePath, sinceVersion)
  const prev = prevEntry === null ? null : prevEntry.source
  const bomBefore = prevEntry !== null && prevEntry.byteOrderMark === true

  // 把当前版本记下，供下一次比对：内容一律是**提供方视角文本**，BOM 作为元数据一并存（只有一套约定）。
  rememberRead(filePath, version, source, byteOrderMark)

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
    // 缓存未命中：换进程、或读完太多轮被淘汰。诚实说明，不假装能比对。
    return {
      ...base,
      mode: 'changed',
      version,
      note: 'that version is no longer cached — cannot diff; read the regions you need',
      next: 'mode=map then mode=lines',
      text: 'that version is no longer cached — cannot diff; read the regions you need (next: mode=map then mode=lines)',
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
 * @param source - 解码后的全文
 * @param byteOrderMark - 这份文件是否带 UTF-8 BOM（判据只能是字节，见 {@link startsWithByteOrderMark}）
 */
export function contentToken(source, byteOrderMark = false) {
  const effective = byteOrderMark ? BYTE_ORDER_MARK + source : source
  let h = 2166136261
  for (let i = 0; i < effective.length; i += 1) {
    h ^= effective.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${(h >>> 0).toString(16)}:${effective.length}`
}

/**
 * full —— 全文。**仍然受预算约束**，因此它不是"旧的 read"：超预算时同样显式说明。
 *
 * 这一模式存在是因为实测发现：文件足够小时，全文比 map 和 digest 都小
 * （1 个函数时全文 156 字符、map 123、digest 180；再小一点全文就反超）。
 * 把这种情况硬塞给 lines 模式是错的——lines 需要调用方给区间，而这里调用方什么都没给。
 */
function renderFull(base, lines, symbolsIndex = null) {
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
export function suggestMode(source, filePath) {
  const sizes = { full: source.length }
  const lang = filePath === null || filePath === undefined ? null : langOf(filePath)
  let symbols = null
  if (lang !== null) {
    symbols = listSymbols(indexStructure(source, lang)).length
    sizes.map = readWith(source, { filePath, mode: 'map' }).text?.length ?? 0
    if (sizes.map <= sizes.full) {
      sizes.digest = readWith(source, { filePath, mode: 'digest' }).text?.length ?? 0
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
  const FULL_TEXT_FITS = source.length <= CONTENT_BUDGET
  if (FULL_TEXT_FITS) {
    return {
      mode: 'full',
      reason: `the whole text fits the content budget (${source.length} ≤ ${CONTENT_BUDGET} chars), so it is the complete answer`,
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
  const ranked = top.filter(([name]) => name === 'full' || delivered(name))
  const candidates = ranked.length > 0 ? ranked : [['full', sizes.full]]
  const best = candidates[0]
  const reason =
    best[0] === 'full'
      ? `full text is the smallest option (${source.length} chars)`
      : `${best[0]} is ${(sizes.full / best[1]).toFixed(1)}x smaller than the full text`
  return { mode: best[0], reason, sizes, ...(symbols === null ? {} : { symbols }) }
}

/**
 * 读一个文件，按模式返回**带预算与省略说明**的结构化结果。
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
      auto = suggestMode(source, request.filePath ?? null)
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

  const render = (budget) => {
    /**
     * 版本令牌：**每条含内容的回执都必须给**。
     *
     * 这个字段曾经被 `mode === 'changed' || lang === null` 这个条件剥掉，后果是一整类
     * 调用被框架直接拒绝（schema 声明它必填）：
     *   tool "aura_read" returned invalid output: missing required property "value.version"
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
     * 实测后果：普通 `aura_read` 之后拿那个令牌去问 `changed`，得到的是
     * “that version is no longer cached — cannot diff”，把“上次观测”当判据的路直接断掉。
     */
    const bom = request.byteOrderMark === true
    const version = contentToken(source, bom)
    if (filePath !== null) rememberRead(filePath, version, source, bom)
    const base = {
      ok: true,
      mode,
      totalLines: total,
      contentBudget: budget,
      ...(mode === 'changed' ? {} : { version }),
      ...(auto === null ? {} : { auto: auto.reason }),
    }
    // 符号索引只建一次：`map`/`digest`/`around` 本来就要用，而 `lines`/`search` 现在也要
    // （给裸行号附上可重新定位的引用）。没语言配置（未索引扩展名）时为 null，各处自行降级。
    const symbolsIndex = lang === null ? null : indexStructure(source, lang)
    if (mode === 'map') return renderMap(base, source, lines, lang, request, symbolsIndex)
    if (mode === 'digest') return renderDigest(base, source, lines, lang, request, symbolsIndex)
    if (mode === 'full') return renderFull(base, lines, symbolsIndex)
    if (mode === 'around') return renderAround(base, lines, lang, request, symbolsIndex)
    if (mode === 'lines') return renderLines(base, lines, request, symbolsIndex)
    if (mode === 'changed') return renderChanged(base, source, lines, request, symbolsIndex)
    return renderSearch(base, lines, request, symbolsIndex)
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
  // `maxChars`：调用方可以要求**更小**的预算。CLI（`--max-chars`）与 MCP（`max_chars`）都暴露了
  // 这个开关，但之前**从没接上**——四档不同取值回执完全一致（字节靶场报的 F6：开关是空的）。
  // 更大的请求由流水线硬上限兜住："输出绝不越过剪枝阈值"是硬保证，不能被参数推翻。
  let budget =
    Number.isInteger(request.maxChars) && request.maxChars > 0
      ? Math.min(request.maxChars, contentCeiling)
      : contentCeiling
  let result = render(budget)
  /** 每轮额外多收的余量：只按"超出多少"收窄会恰好贴着上限，信封随内容缩短而重算时容易再涨回去。 */
  const SHRINK_MARGIN = 64
  /** 轮数上限：收敛是单调的，几轮就够；给足是为了让下面那道硬断言根本不触发。 */
  const MAX_PASSES = 8
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const size = serializedSize(result)
    if (size <= ceiling) break
    const next = Math.max(0, budget - (size - ceiling) - SHRINK_MARGIN)
    if (next >= budget) break // 收不动了，交给下面那道硬断言
    budget = next
    result = render(budget)
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
  const finalSize = serializedSize(result)
  if (finalSize > ceiling) {
    const minimal = render(0)
    const minimalSize = serializedSize(minimal)
    if (minimalSize <= ceiling) return minimal
    return {
      ...minimal,
      omitted: `${minimal.omitted === undefined ? '' : `${minimal.omitted}; `}output is already at its minimum envelope (${minimalSize} chars) and still exceeds the host result limit (${ceiling}); the limit is below what a read result can physically be`,
    }
  }
  return result
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
    return {
      ...base,
      mode: 'map',
      note: `unsupported extension — no symbol index; ${base.totalLines} lines, ${source.length} chars`,
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
    next: budgetCut
      ? 'mode=digest for all signatures · mode=around around=<name> for one region'
      : 'mode=around around=<name> · mode=lines lines=[a,b] · mode=digest for signatures',
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
function renderLines(base, lines, request, symbolsIndex = null) {
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
  return windowEnvelope(base, lines, start, to, 'requested range', start, note, symbolsIndex)
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

function renderSearch(base, lines, request, symbolsIndex = null) {
  const q = typeof request.search === 'string' ? request.search : ''
  if (q.length === 0) return { ok: false, code: 'READ_NO_QUERY', message: 'mode=search needs `search`' }
  const hits = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(q)) hits.push(i + 1)
  if (hits.length === 0) {
    return { ok: false, code: 'READ_NOT_FOUND', message: `no line contains ${JSON.stringify(q)}` }
  }
  const limit = request.limit ?? 40
  const shown = hits.slice(0, limit)
  /**
   * 命中行也要**披露截断**（T12）。
   *
   * 先前这里是 `slice(0, 110)` 的裸数字：一行被切掉尾巴时回执不说任何话，
   * 而 `search` 恰好是**唯一能看到超长行内部**的模式（行区间只能整行给）。
   * 不披露就等于告诉模型“这一行就到那里”。
   * `windowEnvelope` 早就有这套机制（`truncated` + `omitted`），这里只是把同一件事补上。
   */
  const clipped = []
  const rows = shown.map((n) => {
    const raw = lines[n - 1].trim()
    if (raw.length <= MATCH_LINE_CHARS) return `${n}: ${raw}`
    const cut = raw.length - MATCH_LINE_CHARS
    // 形状与 `windowEnvelope` 的 `truncated` **完全一致**（{line, shown, omittedChars}）：
    // 第一版这里给的是 `{line, omittedChars}` 的数组，而 `windowEnvelope` 给的是对象——
    // 同一个字段名两种含义，schema 层根本表达不了。本项目已因此裁过一次。
    clipped.push({ line: n, shown: MATCH_LINE_CHARS, omittedChars: cut })
    return `${n}: ${raw.slice(0, MATCH_LINE_CHARS)} ⋯ [truncated ${cut} chars]`
  })
  const kept = fitWithin(rows.join('\n'), base.contentBudget)
  // 每个命中行附上"它属于哪个符号"。行号会随编辑漂坏（插一行→下面全 +1），
  // 而符号名不会；`search` 是四个内容模式里**唯一连 label 都没有**的一个，
  // 所以模型的相对位置感知在这里最弱。
  const relocatable = symbolsIndex === null ? [] : relocatableFor(symbolsIndex, shown)
  return {
    ...base,
    mode: 'search',
    matches: hits.length,
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
          ...(hits.length > kept.kept
            ? { next: `mode=lines lines=[<a>,<b>] to read around a specific match` }
            : {}),
        }
      : {}),
  }
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
function windowEnvelope(base, lines, from, to, label, center, note = null, symbolsIndex = null) {
  const rows = []
  let chars = 0
  let lostFrom = null
  let truncated = null
  for (let n = from; n <= to; n += 1) {
    const raw = lines[n - 1] ?? ''
    const rendered = `${n}: ${raw}`
    if (chars + rendered.length + 1 <= base.contentBudget) {
      chars += rendered.length + 1
      rows.push(rendered)
      continue
    }
    // 放不下。若这是窗口的第一行，就不能空手而归——给一段并标注截断。
    if (rows.length === 0) {
      // `suffix` 是行号之外还要留的说明空间：截断标记本身也要算进预算，
      // 否则"标注"会把内容顶出预算，重演同一个问题。
      const suffix = ' ⋯ [truncated]'
      const take = Math.max(0, base.contentBudget - suffix.length - `${n}: `.length)
      if (take > 0) {
        rows.push(`${n}: ${raw.slice(0, take)}${suffix}`)
        truncated = { line: n, shown: take, omittedChars: raw.length - take }
      }
    }
    lostFrom = n
    break
  }
  const kept = rows.length
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
    shown: kept === 0 ? 'none' : `${from}-${from + kept - 1}`,
    text: rows.join('\n'),
  }
  const omissions = []
  if (truncated !== null) {
    // 截断必须能被程序化读取，不能只藏在 omitted 的自然语言里
    out.truncated = truncated
    omissions.push(
      `line ${truncated.line} truncated: ${truncated.omittedChars} of ${truncated.omittedChars + truncated.shown} chars withheld (content budget ${base.contentBudget} chars)`,
    )
  }
  if (lostFrom !== null && lostFrom <= to) {
    omissions.push(`lines ${lostFrom}-${to} (content budget ${base.contentBudget} chars)`)
  }
  if (note !== null) omissions.push(note)
  if (omissions.length > 0) out.omitted = omissions.join('; ')
  if (truncated !== null) {
    // 续读建议必须真的能拿到剩下的部分：单行内部再切只有 search 模式做得到
    // （它给的是匹配处的字符窗口）。这时候建议 lines 是空头支票。
    out.next = `mode=search search=<substring on line ${truncated.line}> to see text beyond the clip`
  } else if (lostFrom !== null && lostFrom <= to) {
    out.next = `mode=lines lines=[${lostFrom},${to}]`
  }
  return out
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
