/**
 * locator-api —— 框架无关的定位服务。
 *
 * 这一层的存在本身就是"不要打补丁"的兑现：DSH 的 `patch` 工具是它的**适配器之一**，
 * 不是它的宿主。定位逻辑不认识 Cordis、不认识 ctx、不认识 schema，因此换成别的 agent
 * 框架时不需要动它一行。
 *
 * 设计约束：
 *   1. **零依赖**：只 import node 内建与本目录的纯函数。任何框架都能直接 import。
 *   2. **无状态、无 I/O**：输入源码字符串，输出行区间。文件读写归调用方。
 *      ——这一条是关键。工具层各自有各自的沙箱/观察策略/审批模型，定位层不该知道这些。
 *   3. **同步**：索引是 CPU 活，没有理由异步。调用方要异步就自己包一层。
 *
 * 对任何 agent 框架，接进来只需要三件事：
 *   a. 把文件内容读成字符串（用你框架自己的 fs 能力，带它自己的沙箱/权限）
 *   b. 调 `locate(source, request)` 拿到区间或候选
 *   c. 用你框架自己的写回能力落盘（带它自己的原子性/审批）
 */

import { indexStructure, langOf, listSymbols, findReferences, regionConfidence, resolveTarget, rankSymbols, LANGS } from './struct-core.mjs'
import { indexFile, locateWith, normSpace } from './anchor-core.mjs'

/**
 * 定位一份源码里的改动点。
 *
 * 四层寻址，按"模型要提供什么"从强到弱排列。每层覆盖上一层够不到的场景，
 * 但**都不要求模型复现字节**——这是它们与 `edit` 的根本差别：
 *
 *   1. `target`  —— 符号名。不读文本，对内容记错免疫。适合改整个函数/类/类型。
 *   2. `lines`   —— 行号区间。模型刚用 `read` 看过文件，输出就是 `<行号>: <文本>`，
 *                    `grep` 也给行号——**位置是它本来就知道的信息**，我却一直只让它给内容。
 *                    把行号纳入地址空间后，符号体内的任意一行都变得可精确寻址。
 *   3. `lineCue` —— 一个词。当模型记不住行号时，说"就在有 resolvePolicy 的那一行"。
 *                    只接受**全文件唯一**的线索；不唯一则报歧义并给出候选行号，绝不猜。
 *   4. `anchor`  —— 记得的原文。五级降级匹配，容错性最好但要求模型复现内容。
 *
 * 前两层是**精确**的（要么命中要么报错），后两层是**容错**的。
 * 调用方可以传 `assert` 做内容校验，四层都适用——那才是防止"指到错的行"的那道闸。
 *
 * @param {string} source - 源码全文
 * @param {object} request - 定位请求
 * @param {string} [request.target] - 符号名（`name` / `kind:name` / `Outer/Inner` / `name#n`）
 * @param {{start:number,end:number}} [request.lines] - 1-based 闭区间行号
 * @param {string} [request.lineCue] - 一个词的线索，必须全文件唯一
 * @param {string} [request.anchor] - 记得的原文，走五级文本匹配
 * @param {number} [request.near] - 行号提示
 * @param {string} [request.assert] - 内容校验：该区域必须等于（空白归一化后）这个文本
 * @param {string} [request.filePath] - 用于判定语言；给了才能用 target / lineCue
 * @returns {{ok: true, startLine, endLine, tier, actual} | {ok: false, code, message, candidates?, hint?}}
 *   `startLine`/`endLine` 是 1-based 闭区间；`actual` 是该区间的原文，供调用方核对或展示。
 */
/**
 * 引用一段原文给人/模型看：单行化、限额截断、并明写截掉了多少。
 *
 * 为什么不是直接 `JSON.stringify`：那会把换行写成 `\n` 两个字符，模型要自己再解一层；
 * 而**换行位置本身就是信息**（"你这几行其实是一行"是常见误判），用 `⏎` 标出来更直读。
 * 限额存在的理由与其它披露点一致：错误回执也占输出预算，不能把一整段原文无条件倒进去。
 *
 * @param text - 原始文本（可能多行、可能很长）
 * @returns 单行化的引用，形如 `"…" (N chars withheld)`
 */
/**
 * 把失败回执的候选行**写进 message**，并返回自含的回执对象。
 *
 * 为什么不能只挂 `candidates` 字段：DSH 框架对抛出的错误只取 `error.message`
 * （`dsh-tools/lib/index.js:2495-2503`），其余字段一概不读。所以"给候选行"这件事
 * 挂成结构化字段等于没给——**模型看不到它**。
 *
 * 实测：86 次 `appears on N lines` 歧义失败，回执里只有"出现在 2 行上"，
 * 没有任何行号；模型只能猜或重试。而候选行在这里**已经算出来了**。
 *
 * 统一走这一个助手而不是在四处各拼一遍：本项目吃过"同一决策写两处、必有一处漏改"
 * 的亏（`rankSymbols` 的挑选逻辑、手写透传清单），而下面四条失败路径都要做同一件事。
 *
 * @param code - 失败码
 * @param message - 原始说明（候选行会追加在它后面）
 * @param candidates - 两种形状：**行候选** `{line, text?}` 与**符号候选** `{name, kind, enclosing, startLine, endLine}`
 * @returns 自含的回执对象
 */
function failure(code, message, candidates) {
  const raw = Array.isArray(candidates) ? candidates : []
  /**
   * 候选有**两种形状**，而它们走同一个格式化器。
   *
   * 这是个真踩过的坑（T29 顺带发现）：符号候选带的是 `startLine` / `enclosing`，
   * 而这里只读 `line` / `text`，于是 `target=` 歧义的回执印成
   * **`candidates: line undefined, line undefined`**——
   * 候选明明算出来了，却在回执里变成两个 `undefined`。
   * 覆盖面不小：真实语料里 659 个符号有 **165 个（25%）** 按名寻址是歧义的，
   * 也就是说“四分之一次的按名编辑里，模型拿到的是两个 undefined”。
   *
   * 统一在这里归一，不在调用方各拼一遍（上游已经因为同一个决策写两处而漏改过）。
   */
  const rows = raw.map((c, i) => {
    if (c === null || typeof c !== 'object') return c
    if (typeof c.line === 'number') return { ...c, ordinal: i + 1 }
    return {
      ...c,
      line: typeof c.startLine === 'number' ? c.startLine : null,
      ...(c.kind === undefined ? {} : { text: `${c.kind}${c.enclosing === undefined ? '' : ` in ${c.enclosing}`}` }),
      ordinal: i + 1,
    }
  })
  const shown = rows.slice(0, CANDIDATE_LIMIT)
  const listed = rows.length === 0
    ? ''
    : `; candidates: ${shown
        .map(
          (c) =>
            `line ${c.line}${c.text === undefined ? '' : ` = ${quoteForMessage(c.text)}`}` +
            // 符号候选额外给出**可直接用的地址**：`#N` 就是 hits 里的序号（`resolveTarget` 的语义）。
            // 不给的话，模型只能看见“matched 2 symbols”，而不知道下一步该写什么。
            (c.name === undefined ? '' : ` (target=${c.name}#${c.ordinal})`),
        )
        .join(', ')}${rows.length > CANDIDATE_LIMIT ? ` (+${rows.length - CANDIDATE_LIMIT} more)` : ''}`
  // 两种消歧写法都说：`#N` 精确、`near=<行号>` 省事。不说的话它只能盲重试。
  const howto =
    code === 'STRUCT_AMBIGUOUS' && rows.some((c) => c.name !== undefined)
      ? ' — retry with one of those addresses, or add near=<line> to pick the closest'
      : ''
  return {
    ok: false,
    code,
    message: `${message}${listed}${howto}`,
    ...(rows.length === 0 ? {} : { candidates: rows }),
  }
}

/**
 * 失败回执里最多列几行候选。
 *
 * 同样是**框架剪枝阀**的派生值，不是"够用就好"的估计：错误回执也会被剪（该项 prune 不区分 `isError`），
 * 而候选行是恢复率最高的信息（实测：锚点失败里可被符号名救回的比例很高）。
 * 原先写 6，理由是"错误回执也占预算"——那句话对，但 6 与预算之间**没有任何换算关系**，
 * 实测空出的预算能容下几十行（最大的目录 5490 字节，与 8192 差 2702）。
 * 所以改成由 {@link DEFAULT_HINT_CHARS} 派生，并**如实报出截了多少**（`+N more`）。
 */
const CANDIDATE_LIMIT = 20

/**
 * 符号目录的**缺省**字符预算。
 *
 * 它**只有一个依据：框架的剪枝阀**——`dsh-compaction-tool-result-pruner` 对任何超过 8192 字符的
 * 工具结果保留 前 4096 + `[marker]` + 后 1024，中间的文本**被静默移除**（实测确认：该 prune 不区分
 * `isError`，错误回执同样被剪）。所以上限存在的意义是：**自己先截、自己先说**，而不是让下游默默抽掉。
 *
 * 取 7600 = 8192 减信封余量（路径/指令/omitted 那一圈），而不是一个"够用就好"的拍值。
 *
 * 曾经这里是 `const HINT_LIMIT = 24`（条数），注释自称"能放下的 24 个"而**没有任何东西在量**；
 * 后来我又改成 754（旧 24 条的字节量）。两者都是同一个错：
 * **用输出预算去替代"有多少是有用的"这个判断**。而实测说明这个限制从未防住任何溢出：
 * 本仓库语料里最大的目录是 `build/upgrade-test.mjs`（159 符号 / 5490 字节），离 8192 尚有 2702 字节。
 * 也就是说：那条 24 条的限制一直在**默默少给本来装得下的信息**。
 *
 * 仍然保留 `budget` 入参（可选）：调用方知道自己那条回执还剩多少空间时可以传更小的值。
 */
const DEFAULT_HINT_CHARS = 7600

/**
 * 引用一段原文给人/模型看：单行化、限额截断、并明写截掉了多少。
 *
 * 为什么不是直接 `JSON.stringify`：那会把换行写成 `\n` 两个字符，模型要自己再解一层；
 * 而**换行位置本身就是信息**（"你这几行其实是一行"是常见误判），用 `⏎` 标出来更直读。
 * 限额存在的理由与其它披露点一致：错误回执也占输出预算，不能把一整段原文无条件倒进去。
 *
 * @param text - 原始文本（可能多行、可能很长）
 * @returns 单行化的引用，形如 `"…" (N chars withheld)`
 */
function quoteForMessage(text) {
  const flat = text.replace(/\r\n/g, '\u23ce').replace(/[\r\n]/g, '\u23ce')
  if (flat.length <= QUOTE_LIMIT) return `\u201c${flat}\u201d`
  const kept = flat.slice(0, QUOTE_LIMIT)
  return `\u201c${kept}\u2026\u201d (${flat.length - QUOTE_LIMIT} more chars withheld)`
}

/** 错误回执里引用的原文上限（字符）。超过就截断并明写截了多少。 */
const QUOTE_LIMIT = 400

/**
 * 定位一个区间。四层降级：符号身份 → 行号 → 唯一词 → 文本锚点。
 *
 * @param source - 文件全文
 * @param request - `target` / `lines` / `lineCue` / `anchor` 四选一，外加 `near` 与 `assert`
 * @returns 命中时 `{ok: true, startLine, endLine, tier, actual}`；未命中时 `{ok: false, code, message, ...}`。
 *   `actual` 是该区间的原文，供调用方核对或展示。
 */
export function locate(source, request = {}) {
  const lines = source.split(/\r?\n/)
  const slice = (start, end) => lines.slice(start - 1, end).join('\n')
  const filePath = request.filePath ?? null
  const lang = filePath === null ? null : langOf(filePath)

  /**
   * @param byNear - 这次命中是否靠 `near` 从歧义里收敛出来的（见 anchor-core 的四个产出点）。
   *   必须透传：工具回执的 `by near` 标记、以及由此给出的"下次直接用确定地址"建议都靠它。
   *   此前本函数只回 `{startLine, endLine, tier, actual}`，把引擎算好的 `byNear` 丢在中间——
   *   于是 `aura_edit` 渲染的 `by near` **恒为 false**（字段被声明必填、被渲染、却永远不出现），
   *   降级命中对模型完全不可见。这是本项目最典型的"双义字段/死字段"形态。
   */
  const done = (startLine, endLine, tier, byNear = false) => {
    if (request.assert !== undefined && request.assert !== null) {
      const actual = slice(startLine, endLine)
      if (normSpace(actual) !== normSpace(request.assert)) {
        return {
          ok: false,
          code: 'LOCATOR_ASSERT_MISMATCH',
          /**
           * 把**实际内容**写进 message，而不是只报"不符"。
           *
           * 实测依据（11k 条真实调用）：`expect` 不符 388 条，而**回执里贴出实际内容的 0 条**，
           * 于是模型只能盲重试——161 组"参数完全相同的重复失败"，最高一组撞 17 次，
           * 其中 202 次多余重试属于这一类。它拿到"不符"三个字，却拿不到可用于修正的信息。
           *
           * 为什么必须写进 **message** 而不是挂成结构化字段：DSH 框架对抛出的错误
           * 只取 `error.message`（`dsh-tools/lib/index.js:2495-2503` 的 `errorMessage`），
           * 其余字段（`candidates` / `minimal_next` 等）**框架一律不读**。
           * 所以对"让模型看见"而言，message 是唯一有效的通道。
           *
           * 引用方式：换行用 `⏎` 标出，让模型看得出边界；截断到
           * {@link QUOTE_LIMIT} 并明写省略了多少字符。
           */
          message:
            `lines ${startLine}-${endLine} via ${tier} do not match assert — ` +
            `the content there is: ${quoteForMessage(actual)}`,
          actual,
        }
      }
    }
    return {
      ok: true,
      startLine,
      endLine,
      tier,
      ...(byNear ? { byNear: true } : {}),
      actual: slice(startLine, endLine),
    }
  }

  // ── 第 1 层：符号身份。不读文本，因此对内容记错免疫。
  if (typeof request.target === 'string' && request.target.trim().length > 0) {
    if (lang === null) {
      return { ok: false, code: 'LOCATOR_NO_LANGUAGE', message: 'target= needs a recognized file extension' }
    }
    try {
      const hit = resolveTarget(indexStructure(source, lang), request.target, request.near ?? null)
      /**
       * 跨度覆盖不了符号体时必须**拒绝**，不能退化成"只有签名行"。
       *
       * 这是本工具最贵的一个静默失效：`target=<函数名>` 只换掉签名行、旧函数体原样留下，
       * 而 `python -m py_compile` 一样返回 0——没有任何错误信号。拒绝会让调用方立刻看见
       * 失败，并把恢复路径（`lines=` / `line_cue=`）写进消息里。
       */
      if (hit.spanComplete === false) {
        return {
          ok: false,
          code: 'LOCATOR_SPAN_INCOMPLETE',
          message: `cannot address "${hit.name}" by target in ${filePath}: the span does not cover the body — ${hit.spanNote}; address it with lines= or line_cue= instead`,
          hint: directoryHint(source, lang),
        }
      }
      return done(hit.startLine, hit.endLine, 'symbol')
    } catch (error) {
      return {
        ...failure(error.code ?? 'LOCATOR_FAILED', error.message, error.candidates),
        hint: directoryHint(source, lang),
      }
    }
  }

  // ── 第 2 层：行号区间。模型从 read / grep 的输出里直接抄，不需要回忆内容。
  if (request.lines !== undefined && request.lines !== null) {
    const start = request.lines.start
    const end = request.lines.end ?? request.lines.start
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { ok: false, code: 'LOCATOR_BAD_LINES', message: 'lines.start / lines.end must be integers' }
    }
    if (start < 1 || end < start || end > lines.length) {
      return {
        ok: false,
        code: 'LOCATOR_OUT_OF_RANGE',
        message: `lines ${start}-${end} is outside 1..${lines.length}${loneCarriageReturnNote(source)}`,
      }
    }
    return done(start, end, 'lines')
  }

  // ── 第 3 层：单词线索。要求全文件唯一；不唯一就报歧义，绝不猜。
  if (typeof request.lineCue === 'string' && request.lineCue.trim().length > 0) {
    const cue = request.lineCue.trim()
    const hits = []
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(cue)) hits.push(i + 1)
    }
    if (hits.length === 0) {
      return { ok: false, code: 'LOCATOR_CUE_NOT_FOUND', message: `no line contains ${JSON.stringify(cue)}` }
    }
    if (hits.length > 1) {
      if (request.near !== undefined && request.near !== null) {
        const near = request.near
        let best = hits[0]
        let bestD = Infinity
        let ties = 0
        for (const h of hits) {
          const d = Math.abs(h - near)
          if (d < bestD) {
            bestD = d
            ties = 1
            best = h
          } else if (d === bestD) ties += 1
        }
        // 靠 `near` 从多个候选里收敛到一个：这也是"按提示命中"，与锚点层同义
        if (ties === 1) return done(best, best, 'lineCue', true)
      }
      return failure(
        'LOCATOR_CUE_AMBIGUOUS',
        `${JSON.stringify(cue)} appears on ${hits.length} lines`,
        hits.map((line) => ({ line, endLine: line, text: lines[line - 1].trim().slice(0, 80) })),
      )
    }
    // 唯一命中：这正是 lineCue 设计上最常见的情形。
    // 这一行曾在一次按行号区间的编辑里被误删，后果是**每个唯一线索都报
    // LOCATOR_NO_REQUEST**（"provide one of: target, lines, lineCue, anchor"）——
    // 提示信息与真正的原因完全无关，且看起来像调用方没给参数。
    return done(hits[0], hits[0], 'lineCue')
  }

  // ── 第 4 层：文本锚点。容错性最好，但要求模型复现内容。
  if (typeof request.anchor === 'string' && request.anchor.length > 0) {
    try {
      const loc = locateWith(indexFile(source), request.anchor, request.near ?? null)
      return done(loc.start + 1, loc.end, loc.tier, loc.byNear === true)
    } catch (error) {
      return {
        ...failure(error.code ?? 'LOCATOR_FAILED', error.message, error.candidates),
        // 锚点失败时给出符号目录——这是实测支撑的恢复路径。
        // 注：`hint` 走的是结构化字段，只有把它拼进 message 的调用方（如 aura_edit
        // 的 symbolHint）才真能让模型看到；aura_read 直接透传 message，所以真正
        // 抵达模型的是上面那条 message。
        ...(lang === null ? {} : { hint: directoryHint(source, lang) }),
      }
    }
  }

  return { ok: false, code: 'LOCATOR_NO_REQUEST', message: 'provide one of: target, lines, lineCue, anchor' }
}

/**
 * 单 `\r`（老 Mac 行尾）文件的拒绝说明：这类文件在本工具里**整份算一行**。
 *
 * 为什么不干脆按 `\r` 也断行：行号是**跨层共享**的判据——符号表那一层（`struct-core` 的
 * `lineIndexFor`）只按 `\n` 数行，而它不在本组件的改动范围内。若只有这里按 `\r` 断行，
 * 同一个文件的“第 1 行”在两个层里会指向不同字节，`target=` 算出来的区间就会**静默**指错地方
 * （比现在“拒绝”坏得多）。因此结论是：不支持单 `\r` 行尾，但拒绝信息必须点名原因，
 * 并给出真能用的替代：整份替换 `lines=[1,1]`，或 `line_cue` / `anchor`。
 *
 * @param source - 文件全文
 * @returns 追加到错误消息后的说明；不含单 `\r` 时为空串
 */
function loneCarriageReturnNote(source) {
  if (!/\r(?!\n)/.test(source)) return ''
  return ' — this file uses lone CR (\\r) line endings, which are not treated as line breaks here (the symbol index counts lines by \\n, so a second line model would point at different bytes); address it with line_cue/anchor, or replace the whole file with lines=[1,1]'
}

/**
 * 符号目录：失败时给调用方一条可执行的恢复路径。
 *
 * **排序依据与地图共用 `rankSymbols`**，这是必须的：先前这里用的是 `listSymbols().slice(0, 24)`，
 * 即**声明顺序**——而实测声明顺序与重要性零相关（前 24 个里 49% 是函数内局部量）。
 * 于是"恢复提示"给模型的恰恰是最没用的那些名字。我修了地图却漏了这里，
 * 原因就是同一个选择逻辑存在两份实现。现在只有一份。
 *
 * 深度上按预算收：目录也可能很长，超出内容预算的部分不入内，并如实报告总数。
 *
 * 收录条数**按字符预算填充**，不是一个拍死的条数上限。
 *
 * 先前这里写的是 `const HINT_LIMIT = 24`，注释自称"能放下的 24 个"——而**没有任何东西在量**：
 * 它既不是算出来的，也不随调用方的信封预算伸缩。后果是预算宽的宿主（错误消息很短、
 * 下游剪枝阈值很高）本来能容下 60 个候选、却只拿到 24 个，而穷尽的候选**正是恢复率最高的手段**
 * （实测：锚点失败里可被符号名救回的比例很高）。
 *
 * 现在：`budget` 是可选入参（字符），按序填充到装不下为止，并把"被截了多少"如实报出。
 * 缺省值保留 `DEFAULT_HINT_CHARS`，因此**所有现有调用方行为不变**——这是"可选但更强"。
 *
 * @param source - 文件全文
 * @param lang - 语言配置
 * @param budget - 可选的字符预算（缺省 `DEFAULT_HINT_CHARS`）
 * @returns {{symbols, total, shown, truncated, instruction}|null} 无符号时返回 null
 */
export function directoryHint(source, lang, budget = DEFAULT_HINT_CHARS) {
  const lines = source.split(/\r?\n/)
  const ranked = rankSymbols(indexStructure(source, lang), lines).filter((x) => x.imp > 0)
  if (ranked.length === 0) return null
  // 按预算填充：每行形如 `function name (lines a-b) ★`，按**实际渲染长度**累加，
  // 不估算字符宽度（估算会系统性偏差，本项目已经在信封预算上栽过一次）。
  const chars = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_HINT_CHARS
  /** 渲染一行（与消费方看到的形状一致，含缩进与换行）——预算就按它的真实长度算。 */
  const renderRow = (s, exported) => `  ${s.kind} ${s.name} (lines ${s.startLine}-${s.endLine})${exported ? ' ★' : ''}`
  const picked = []
  let used = 0
  for (const { s, exported } of ranked) {
    // 不再估算行宽：估算值是拍的，而拍错的方向很贵——
    // 拍大 → 默认回执胀（增加使用代价）；拍小 → 比旧的写死 24 条还少（能力回退）。
    // 直接建行、量它的真实长度，两个方向都不会错。
    const cost = renderRow(s, exported).length + 1
    if (used + cost > chars && picked.length > 0) break
    used += cost
    picked.push({ s, exported })
  }
  const symbols = picked.map(({ s, exported }) => ({
    name: s.name,
    kind: s.kind,
    startLine: s.startLine,
    endLine: s.endLine,
    exported,
    // 建议里必须带上"这个符号能不能用 target="——否则"重试时改用 target=<name>"
    // 会把调用方推回同一个结构化拒绝，形成死循环式的重试。
    spanComplete: s.spanComplete !== false,
  }))
  const incomplete = symbols.filter((s) => !s.spanComplete).length
  /**
   * 被预算截掉多少，必须如实报出。
   *
   * 先前 `total` 算了却**无人消费**（`aura-edit` 的 `symbolHint` 自己重渲染行、丢掉 `total`），
   * 于是模型看到 24 条就以为"这文件只有 24 个符号"——把"被截"伪装成了"就这些"。
   * 现在调用方可以把它写进回执，也可以拿个更大的 `budget` 再要一次。
   */
  return {
    symbols,
    total: ranked.length,
    shown: symbols.length,
    truncated: ranked.length - symbols.length,
    instruction:
      'locate by name instead of guessing text: retry with target=<name> (also accepts kind:name, Outer/Inner) and no anchor' +
      (incomplete === 0
        ? ''
        : `; ${incomplete} of the symbols listed have no determinable span and reject target= — use lines= for those regions`),
  }
}

/** 列出源码里的符号，供 agent 在不知道确切名字时先看目录。 */
export function outline(source, filePath) {
  const lang = langOf(filePath)
  if (lang === null) return null
  return listSymbols(indexStructure(source, lang))
}

/** 某符号体内的引用位置：重命名这类需要"所有出现处"的操作。 */
export function references(source, filePath, name) {
  const lang = langOf(filePath)
  if (lang === null) return null
  return findReferences(indexStructure(source, lang), name)
}

/** 一个区间是否恰好是完整的语法单位。可用于给候选排序，或判断"这次改动是否自洽"。 */
export function spanQuality(source, filePath, startLine, endLine) {
  const lang = langOf(filePath)
  if (lang === null) return null
  return regionConfidence(indexStructure(source, lang), startLine, endLine)
}

/**
 * 支持的语言扩展名。别的框架据此判断能不能挂结构路径。
 *
 * **从配置表派生，不手写清单。** 第一版这里写死了一个九项数组
 * （`js ts jsx tsx mjs cjs py go rs`），而配置表早已长到 44 项——
 * 于是这个导出对调用方撒了谎：它说"只支持这九种"，实际远不止。
 * 手写清单必然与配置表脱节，且脱节是静默的；派生就没有这个问题。
 */
export const SUPPORTED_EXTENSIONS = Object.keys(LANGS).sort()
