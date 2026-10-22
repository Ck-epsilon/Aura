/**
 * dsh-tool-patch —— 锚点补丁工具。
 *
 * 命题：agent 改文件不该输出"最终字节"，而该输出"一个声明式操作 + 一段允许有偏差的锚点"。
 * 匹配、消歧、落盘、回滚由宿主承担。相对 `edit` 的变化：
 *   1. 四级降级匹配（exact → 空白折叠 → 行 strip → 相似度），容错缩进/空白/改词/重排；
 *   2. `near` 位置提示把歧义锚点收敛为确定命中（grep 早就知道行号，`edit` 却只认字节）；
 *   3. 一次调用多个 hunk，且整体事务化：任一 hunk 失败则磁盘不变；
 *   4. 降级命中时把"实际改的那段原文"作为回执带回，把不可见的错配变成可见。
 *
 * fs 契约与 `dsh-tool-fs` 完全一致：resolve → 尝试 fs/edit-intent 取守 → fs.editText →
 * fs/observed。因此 fs-observation-policy 与 fs-sandbox 对本工具同样生效。
 *
 * @module dsh-tool-patch
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 结构定位器：零依赖、跨语言。只在**锚点失败**时用来给模型一份符号目录作为恢复路径，
// 不参与成功的定位——实测符号级定位对文本扰动免疫（100% vs 58.6%），而锚点失败里
// 100% 都能被符号名救回（见 locator-lab/recoverable.mjs）。
import { langOf } from '../locator-lab/struct-core.mjs'
// 定位引擎本身是框架无关的，住在 locator-lab；本文件是它的 **DSH 适配器**。
// 这条依赖方向是刻意的：引擎不认识 Cordis，而 Cordis 侧认识引擎。
// 换一个 agent 框架接进来，只需要另写一个适配器，引擎一行不用动。
import { locate, directoryHint } from '../locator-lab/locator-api.mjs'
// 归一化只有一份实现，住在引擎里。插件里再写一份会让"锚点匹配"与"expect 校验"两处判断
// 可能不一致，而那种不一致极难发现——它只在特定空白组合下才现形。
import { normSpace } from '../locator-lab/anchor-core.mjs'
// 单个 hunk 的“平铺形状”容错**只有一份**（住在 args.mjs，与行区间收敛同一层）：
// DSH 壳与 CLI 共用它。同一套容错规则写两处，就一定会有一处与另一处不一致。
import { assertKnownArgs, flatHunk } from '../locator-lab/args.mjs'
// BOM 的字符形态与字节判据都住在引擎里：读路径（aura_read 的令牌）与写路径（这里）共用一份，
// 否则"令牌说没 BOM、写回却带 BOM"这类不自洽会两处各修一遍。
import {
  BYTE_ORDER_MARK,
  BYTE_ORDER_MARK_BYTES,
  contentToken,
  countByteOrderMarks,
  latestObservation,
  leadingByteOrderMarks,
  rememberRead,
} from '../locator-lab/read-core.mjs'
import {
  PatchError,
  splitLinesWithEndings,
  hasMixedLineEndings,
  // 区域级新鲜度闸门：判据 + 收据都在引擎里（`staleConflicts` / `staleRegionRefusal`），
  // 壳只调决策函数 `regionGate`。此前判据在本文件里也有一份，已删——
  // 同一个决策写在两处，就一定会有一处漏改（本文件被这条坑过一次，见 `symbolHint`）。
  regionGate,
  staleConflicts,
  regionTextIn,
  joinLinesWithEndings,
  planHunks,
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
} from '../locator-lab/write-path.mjs'

export const name = 'dsh-tool-aura-edit'

/**
 * 硬依赖，与 `dsh-tool-fs` 声明的一致。
 *
 * `systemPrompt` **必须声明**，不能靠 `ctx.get` 兜：用 `ctx.get` 时若服务不可见就静默跳过，
 * 于是"工具注册了但没有指导文本"这种半成品状态**不报错**，表现为模型永远不用这个工具。
 * 声明进 inject 后服务缺失会让插件进入等待，问题在装载期就暴露。
 *
 * 注意：Cordis 的 guard 会拒绝任何未在 inject 里声明的 `ctx.<name>` 访问——
 * `ctx.tools` 不声明就会在 apply 阶段直接抛 "cannot get property ... without inject"。
 */
export const inject = ['fs', 'tools', 'systemPrompt']

/**
 * 一个 hunk 的**属性声明**（唯一一份）。
 *
 * 它出现两次：`hunks.items.properties`（数组形状）与顶层（**平铺形状**）。
 * 两处必须是同一份对象，而不是各写一遍——同一条描述写两处必然漂，
 * 而这里漂的后果是“两种写法接受不同的键”，那比拒收更难排查。
 */
const HUNK_PROPERTIES = {
  target: {
    type: 'string',
    description:
      'Symbol to replace, e.g. `toTodoList`, `function:apply`, `Outer/Inner`, `name#2`. Skips all text matching, so it is immune to misremembered content.',
  },
  // 与 aura_read 同一套宽容声明：模型把区间写成 `4, 6` 时那不是合法 JSON（宿主在参数层就拒），
  // 写成 `"4,6"` / `4` 则是合法 JSON 但形状不对——声明宽一点，能容的都容下来。
  lines: {
    oneOf: [{ type: 'array' }, { type: 'string' }, { type: 'integer' }, { type: 'object', additionalProperties: true }],
    description:
      'Exact line range `[start, end]` (1-based, inclusive), as printed by the read tool. Use this to edit inside a function without reproducing its text. `[n]` means one line. Also accepts "4,6" or a single 4. Preferred instead: `start_line` + `end_line`.',
  },
  start_line: {
    type: 'integer',
    description: 'Preferred over `lines`: first line of the range, 1-based inclusive.',
  },
  end_line: {
    type: 'integer',
    description: 'Preferred over `lines`: last line of the range, 1-based inclusive. Defaults to start_line.',
  },
  line_cue: {
    type: 'string',
    description:
      'A single word that appears on exactly one line of the file — use when you know roughly where the line is but not its number. Ambiguous cues are rejected with candidate lines.',
  },
  anchor: {
    type: 'string',
    description:
      'The text to find. May carry whitespace drift; keep at least 2 lines for safety. The fallback when no address above is available.',
  },
  replace: {
    type: 'string',
    /**
     * `required: true` 是**本框架 DSL 的写法**（写在属性里），编译期会被提升成
     * `items.required: ["replace"]`——`aura-edit/load-test` 断言的正是编译后的那个形状。
     *
     * 不能直接写 `items.required: [...]`：那样会被拒（`parameters.hunks.items.required is not
     * supported by the value schema DSL`，插件直接注册失败）。两种写法只差一个位置，实测踩过。
     */
    required: true,
    description: 'Replacement text. Empty string deletes the addressed region.',
  },
  expect: {
    type: 'string',
    description:
      'Guard: the content you believe is at that location. A mismatch fails the whole patch instead of editing an uncertain place. Works with every addressing mode.',
  },
  near: {
    type: 'integer',
    description: 'Optional 1-based line number hint that resolves an otherwise ambiguous match.',
  },
}

/**
 * 把 `HUNK_PROPERTIES` 里的 `required` 语句剥掉，得到可**展开到另一个对象**的属性表。
 *
 * 为什么需要两份：真框架的 `compilePropertyMap` 会把属性上的 `required: true`
 * 提升到**所属对象**的 `required` 数组。于是同一份属性表在 `hunks.items` 里是对的
 * （一个 hunk 必须有 `replace`），直接展开到顶层就错了——顶层的 `required` 会变成
 * `["file_path","replace"]`，而 `hunks` 与 `create` 两条路都不需要顶层 `replace`。
 * 实测后果：`{file_path, hunks:[…]}` 被 `missing required property "replace"` 拒掉
 * （`aura-edit/load-test` 第 157 行当场抛 INVALID_ARGS）。
 *
 * 两份表由**同一个循环**产出，所以新增一个 hunk 键时不会漏掉任何一份。
 */
const HUNK_PROPERTIES_OPTIONAL = Object.fromEntries(
  Object.entries(HUNK_PROPERTIES).map(([key, spec]) => {
    const { required: _required, ...rest } = spec
    return [key, rest]
  }),
)

/**
 * 本工具声明的**顶层参数名**（唯一一份，供未知参数守卫用）。
 *
 * 它必须等于 `parameters` 真实声明的键集合，否则会出现“schema 里有、守卫却拒”
 * 或反过来的情况。`real-framework-smoke-test` 的段C 会拿真框架的校验器核对这一点。
 */
export const EDIT_ARG_KEYS = ['file_path', 'hunks', 'dry_run', 'create', ...Object.keys(HUNK_PROPERTIES)]

export const Config = z.object({})

// ── 与 dsh-tool-fs 一致的观测契约 ──────────────────────────────────────────

/**
 * 模型侧诊断：把 fs 错误码翻成可执行的恢复指令。
 *
 * 两条写回路径的“变了”是不同判据报出来的，但含义一样，因此合成同一句恢复指令：
 *   · `writeText` + `replaceIfVersion`（主路径）⇒ `FS_STALE_VERSION`（提供方级版本 CAS）
 *   · `editText`（后端无 writeText 时的退化路径）⇒ `FS_EDIT_NOT_FOUND`（整份内容匹配不上）
 * 错误码**原样保留**：调用方与测试要能区分“第三方改了文件”与“锚点对不上”。
 * @param error - 捕获到的错误
 * @param displayPath - 面向模型的路径
 * @returns 可直接抛出的错误
 */
function remediate(error, displayPath) {
  const code = errorCodeOf(error)
  if (code === 'FS_EDIT_NOT_FOUND' || code === 'FS_STALE_VERSION') {
    return Object.assign(new Error(`cannot patch "${displayPath}": the file changed while patching — read it again, then retry`), { code })
  }
  if (code === 'FS_AMBIGUOUS_EDIT') {
    return new Error(`cannot patch "${displayPath}": the replacement was not unique — report this, it is a bug`)
  }
  return error
}

/**
 * 把 lab 的符号目录渲染成错误消息里的一段文本。
 *
 * **不再自己挑前 24 个符号。** 这里原本写的是 `listSymbols().slice(0, 24)`，即**声明顺序**——
 * 而实测声明顺序与重要性零相关（前 24 个里 49% 是函数内局部量）。
 * 我在审计时已把 `directoryHint` 改成用共享的 `rankSymbols`，却漏了本文件这一份：
 * **同一个决策写在两处，就一定会有一处漏改**，这次轮到它。
 * 现在只从 lab 取，不再自行挑选。
 */
function symbolHint(displayPath, content) {
  const lang = langOf(displayPath)
  if (lang === null) return ''
  try {
    const dir = directoryHint(content, lang)
    if (dir === null) return ''
    // 英文界面：工具结果会被送进英文会话。此前这里漏出中文"行"字——
    // 我在别处修过同一个决策，却漏了本文件这一份（同一个决策写在两处，必有一处漏改）。
    const rows = dir.symbols.map(
      (s) =>
        `${s.kind} ${s.name} (lines ${s.startLine}-${s.endLine})${s.exported ? ' ★' : ''}` +
        // 跨度判不了的符号不能出现在"改用 target="的建议里而不加标记：
        // 那会让模型重试同一个必然失败的动作。
        (s.spanComplete === false ? ' [span not determinable — use lines=]' : ''),
    )
    return (
      `\n\nThis file's structural directory — locate by name instead of guessing text:\n  ` +
      rows.join('\n  ') +
      `\nRetry with target=<name> (also accepts kind:name, Outer/Inner) and no anchor.`
    )
  } catch {
    // 结构索引失败不能掩盖原始错误——恢复建议是加分项，不是必需品
    return ''
  }
}

const FUZZY_TIERS = new Set(['norm-space', 'trim-line', 'similarity', 'aligned'])

/**
 * 回执：**报告替换后的内容**，并说明这次命中的是哪个区间。
 *
 * 这里改过一次，起因是真实模型的一句反馈。原版引用的是 `actual`，也就是**改之前**那一段：
 *
 *   line 6 [lines] "  if (value === 0) return { kind: 'zero' };"
 *
 * 模型的评论逐字如下：
 *   "the tool's receipt echoes the addressed line … that reads as the *pre-replacement* content,
 *    not evidence the replacement failed."
 *
 * 它说得对：回执的全部用处就是让模型确认改对了，而显示改前内容做不到这一点——
 * 反而让人怀疑是不是没改。现在报告**改后**内容，改前内容仅在两者都短时一并显示。
 */
function renderResult(value) {
  const lines = [`${value.path}: ${value.applied.length} hunk(s) applied.`]
  for (const a of value.applied) {
    const flags = [a.tier, a.byNear ? 'by near' : null].filter(Boolean).join(', ')
    const clip = (t) => {
      const one = t.split('\n')[0]
      const multi = t.includes('\n')
      const short = one.length <= 64
      return multi || !short ? `${JSON.stringify(short ? one : `${one.slice(0, 64)}…`)}${multi ? ` +${t.split('\n').length - 1} more line(s)` : ''}` : JSON.stringify(one)
    }
    const after = a.replaced ?? ''
    // 单行 → 单行的替换，把 before → after 都给出；否则只给改后，避免刷屏
    const singleLineSwap = !a.actual.includes('\n') && !after.includes('\n')
    lines.push(
      singleLineSwap
        ? `  line ${a.line} [${flags}] ${clip(a.actual)} → ${clip(after)}`
        : `  line ${a.line} [${flags}] now: ${clip(after)}`,
    )
  }
  if (value.applied.some((a) => FUZZY_TIERS.has(a.tier))) {
    lines.push('  (a hunk matched by fallback — confirm the quoted text is the region you meant.)')
  }
  /**
   * 靠 `near` 收敛出来的命中，把**那条确定地址**一并给出。
   *
   * 理由：`near` 是模型唯一的"歧义时也能试一下"的手段，而它这次之所以生效，是因为文件里
   * 确实存在那个提示行。把这个事实变成可复用的坐标，下一次就不必再赌一次 `near`。
   * 不增加任何代价：坐标在 `applied[].line` 里已经算好了，只是没说出来。
   */
  const byNear = value.applied.filter((a) => a.byNear === true)
  if (byNear.length > 0) {
    lines.push(
      `  (${byNear.length} hunk(s) resolved by the \`near\` hint — next time address ${byNear
        .map((a) => `line ${a.line}`)
        .join(', ')} directly, no hint needed.)`,
    )
  }
  return lines.join('\n')
}

// ── 插件 ────────────────────────────────────────────────────────────────────

/**
 * 注册 `aura_edit` 工具，以及配套的提示段。
 *
 * ## 为什么必须同时注册提示段
 *
 * 只注册工具是不够的——实测结论。内置 `tool-fs` 会注入命令式指导：
 * "Use the edit tool for targeted changes to existing UTF-8 text files"，
 * 而本工具只有 schema、没有一句话指导。于是模型面对"改文件"时，提示词明确说用 `edit`。
 *
 * 位置放在 `TOOL_EDIT`(1300) 之后：提示词里靠后的指导压过靠前的。
 *
 * ## 为什么策略服务是可选注入
 *
 * Resolved through `ctx.inject([...])` instead of being declared in this plugin's own
 * `inject` — the same treatment `dsh-tool-fs` gives the optional `attachments` service.
 * The distinction matters: a hard declaration parks the whole plugin in a waiting state
 * when the service is absent, so the tools would never register, yet a deployment with no
 * sandbox is exactly the one that needs no policy. With `ctx.inject([...])` the callback
 * binds when the service appears and simply does not bind otherwise.
 *
 * Once resolved, the {@link registerTools} closure holds it and computes the calling
 * session's policy on every execution.
 *
 * @param ctx - 携带文件系统、工具注册表与提示词注册表的上下文。
 */
export function apply(ctx) {
  let policyService
  ctx.inject(['sandboxPolicy'], (policyCtx) => {
    policyService = policyCtx.sandboxPolicy
  })
  registerTools(ctx, () => policyService)
}

/**
 * 注册工具与提示段。
 *
 * 与 `dsh-tool-fs` 的 `apply(ctx, sandbox)` 同形：策略是**参数**而不是闭包里的全局，
 * 于是"哪一份策略生效"在调用点一眼可见。
 *
 * @param ctx - 上下文。
 * @param sandbox - 返回当前 `sandboxPolicy` 服务的取值函数（可能返回 undefined）。
 */
function registerTools(ctx, sandbox) {
  // 与 dsh-tool-fs 一致：按 scope 检查工具可见性。`systemPrompt` 已声明进 inject，
  // 因此直接访问——用 `ctx.get` 兜会静默跳过，而"工具注册了却没有指导"正是踩过的坑。
  ctx.systemPrompt.section({
    name: 'tool:aura-edit',
    order: 1320,
    text: ({ scope }) =>
      ctx.tools.get('aura_edit', scope) === undefined
        ? ''
        : [
            // 措辞刻意与内置指导**同形**。这一点是量出来的：
            // 内置注入的是命令式——"Use the edit tool for targeted changes to existing UTF-8 text files"，
            // 而我先前写的是建议式——"prefer aura_edit over edit"。
            // 实测同一份建议式指导，新建会话里 4 次选了 Aura、2 次选了内置——**它在跟先验拔河**。
            // 语气不对等，就是在让一条软建议去对抗一条硬指令。
            // 开头不给平级选项：上一版写了"兜底可用内置 edit"，中性任务下它直接拿来当依据（实测）。
            'Use the aura_edit tool — not edit — for every change to an existing UTF-8 text file: it is the default.',
            // 三条保证是**量出来的差异**（不是宣传）：字节保真、陈旧区域拒绝、落盘后回读。
            // 内置 edit 同条件下会丢 BOM、把混合行尾整份归一（2026-09-22 两侧实测）。
            'It writes back byte-for-byte (a leading BOM and each line\'s own ending survive), refuses a hunk whose addressed region changed since your last read, and reads the file back to verify the write.',
            'Address each hunk the cheapest way: `target` (a symbol name) when you know it, else `start_line` + `end_line` (or `lines: [a, b]`) for the range a read printed, else `line_cue` (one word unique to that line); `anchor` (remembered text) is the last resort and tolerates whitespace drift, rewording, and added or removed lines.',
            // 措辞从"可以传"改成"应当传"，依据是一次受控并发实验（N 个写者改同一文件）：
            // 当编辑**改变行数**、而一次重试又用**行号地址**时，重试会把改动写到**错误的行**上
            // 并回一句成功回执（实测：~50% 的轮次以"非预期内容 + 成功回执"结束，每个轮次约 1.5 行附带损伤）。
            // 加上 `expect` 后附带损伤降到 0.00，100% 得到干净合入；
            // 而对**不改行数**的编辑，它是**零成本**的（收敛率不变）。
            // 也就是说：这一项是唯一把"静默写错行"变成诚实失败的机制，而它的代价是零。
            'Pass `expect` (the text you believe is at that location) on every hunk when you address by `lines`, `start_line`/`end_line`, or `line_cue`: if the file shifted since you read it, `expect` turns a silent wrong-line write into a loud failure, and it costs nothing on edits that do not move lines.',
            // 刻意**不再**写"未知扩展名请用内置 edit"。那句话是错的：只有 `target` 需要语言配置
            // （符号表只对已索引的扩展名存在），而 `lines`／`line_cue`／`anchor` 三种寻址根本不看语言，
            // 创建路径更是与寻址无关。它恰好在工具可用的地方把模型赶回内置工具。
            'Extensions aura_edit cannot index (config, data, markup) are still fully editable — address them with `lines`, `line_cue`, or `anchor` instead of `target`.',
            // 兜底：内置 `write` 是整份覆写的唯一手段（aura_edit 刻意没有这条路），`read_image` 更是无替代。
            // 兜底只列 aura_edit **刻意不做**的两件事（整份覆写、拒绝改行尾的文件），以及无替代的读图；
            // 刻意不把内置 `edit` 写进来：它在同样场景会丢 BOM / 归一行尾，不是等价兜底。
            'The built-in `write` remains for what aura_edit deliberately does not do — replacing a whole file, or writing one whose line endings it refuses to touch; `read_image` is still the only way to read an image.',
          ].join(' '),
  })

  ctx.tools.register(
    defineTool({
      name: 'aura_edit',
      description:
        'Edit or create a UTF-8 text file with hunks, in a single call. Address each hunk in the cheapest way you can: `target` (a symbol name — immune to misremembered content), or `start_line` + `end_line` (preferred: two plain numbers, no array syntax to get wrong — same as `lines: [a, b]`), or `line_cue` (one word unique to that line), or `anchor` (remembered text, matched with graceful degradation). Only `anchor` requires you to reproduce content; prefer the other three. Pass `expect` to assert what is at that location — it is checked in every mode. All hunks must locate or nothing is written. Omit keys you do not need — an explicit `null` is rejected, not ignored.',
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: 'Path to patch, resolved by the filesystem backend.',
        },
        hunks: {
          type: 'array',
          // 不在 schema 层声明 required：创建路径（`create`）不需要 hunks。
          // "必须给 hunks 或 create 之一"这条约束由运行期判——schema 层表达不了"二选一"，
          // 硬写成必填会让创建功能被自己的 schema 挡住。
          description:
            'The changes to apply. Every hunk must locate, or the file is left untouched. Each hunk locates either by `target` (a symbol name — preferred when you know it) or by `anchor` (remembered text). Not needed when `create` is used.',
          /**
           * `items` 里**不写 `required`**。
           *
           * 本框架的 `required` 是对象上的**数组关键字**（顶层 `required: [...]` 被接受、`{}` 被拒），
           * 但把它放进 `items` 会被拒：`parameters.hunks.items.required is not supported by the value schema DSL`
           * （实测，插件直接注册失败）。而写数组本身无效——实测嵌套的 `items.required: ['a']`
           * 虽然被接受，却**不产生任何约束**（`{}` 照样通过）。
           *
           * 所以“一个 hunk 必须有 replace”这条约束**只在运行期判**：`planHunks` 读不到
           * `replace` 会报 `PATCH_NO_HUNKS`/定位失败，而 `aura-edit/load-test` 守着那条回执。
           * 把一条**没有效果的**声明留在 schema 里，比不写更坏——它让人以为有闸门。
           */
          items: { type: 'object', additionalProperties: false, properties: HUNK_PROPERTIES },
        },
        // ── 单个 hunk 的键**也**在顶层声明（平铺形状）──────────────────────
        //
        // `flatHunk()` 从 02:37 起就支持“一个 hunk 不包数组、直接写在顶层”，
        // 但顶层 schema 一直没声明那 9 个键。后果有二，都由实测确认：
        //   · 真框架的参数校验对未声明键**零违规**（只在 `additionalProperties:false` 时才拒）⇒
        //     长久以来没有任何东西拦住它们，属于“声明与实装不一致”；
        //   · 会话日志里 35 次平铺调用有 29 次失败于 `hunks must be a non-empty array`——
        //     那些发生在支持实装**之前**，而支持之后日志里的平铺调用**是成功的**，
        //     说明框架**不会**剥掉未声明参数、平铺真的能用。
        // 所以这里不是新增能力，而是**把已实装的能力补进声明面**，并让它与守卫的名单一致。
        /**
         * 平铺形状：把 hunk 属性展开到顶层——用**剥过 `required`** 的那一份。
         *
         * 平铺形状下“必须有 replace”由 `flatHunk()` 在运行期判：
         * 顶层有地址键但没 replace ⇒ 报“缺 hunks/create”（`arg-shape-test` 段B 守着）。
         * 这里**不能再展开一次完整表**：那会把 `replace` 提升成顶层 required，
         * 于是 `{file_path, hunks:[…]}` 与 `{file_path, create:…}` 两条正常路径全被拒
         * （实测：`aura-edit/load-test` 与 `real-framework-smoke-test` 同时变红）。
         */
        ...HUNK_PROPERTIES_OPTIONAL,
        dry_run: {
          type: 'boolean',
          description: 'Locate every hunk and report where they would land, without touching the file.',
        },
        create: {
          type: 'string',
          description:
            'Full content for a file that does not exist yet. Only used when the path is absent — if the file exists this is ignored and the hunks apply normally instead, so an accidental overwrite is impossible.',
        },
      },
      /**
       * 与 {@link READ_ARG_KEYS} 同理：参数面**也要** `additionalProperties: false`。
       * 旧版只有 `output.schema` 写了它 ⇒ `{file_path, mode:'auto'}` 这种属于别的工具的参数
       * 可以零违规穿过框架，然后被本工具静默忽略。
       */
      additionalProperties: false,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            applied: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'integer', required: true },
                  tier: { type: 'string', required: true },
                  byNear: { type: 'boolean', required: true },
                  actual: { type: 'string', required: true },
                  replaced: { type: 'string', required: true },
                },
              },
            },
            dryRun: { type: 'boolean', required: true },
            // C13：这次编辑没有可信的“上次观测”（文件从没被 aura_read 读过）⇒ true。
            // 声明在这里是必须的：output.schema 是 additionalProperties:false，
            // 未声明的字段会让整条成功路径被框架拒绝。
            unverified_region: { type: 'boolean' },
            // C14：这次写入被**回读校验**过。`level: 'bytes'` = 逐字节整份比对（看得见 BOM 与行尾改写）；
            // `level: 'text'` = 后端没有字节接口，只比对了文本（看不见 BOM / 行尾），如实写在这里。
            // 对不上时走不到这里：那条路抛 WRITE_VERIFY_FAILED（错误对象上带两边字节数与普查）。
            write_verify: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'string', required: true },
                bytes: { type: 'integer' },
                chars: { type: 'integer' },
              },
            },
            // 创建路径会带上 operation，让调用方能区分"改了文件"与"建了文件"。
            operation: { type: 'string' },
          },
        },
        render: (_args, value) =>
          value.dryRun
            ? [
                {
                  type: 'text',
                  text: `Dry run for ${value.path} — every hunk matched; nothing was written.\n${renderResult(value)}`,
                },
              ]
            : [{ type: 'text', text: renderResult(value) }],
      },
      async execute(args, exec) {
        if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
          throw new Error('file_path must be a non-empty string')
        }
        // 创建路径不经过 hunks：给 `create` 时 hunks 可以为空（甚至省略）。
        // 第一版把"hunks 非空"当无条件校验，于是**创建被自己的校验挡住**，
        // 而报错信息（"hunks must be a non-empty array"）与真正的原因（文件不存在）毫无关系。
        // 未知参数不回默认行为：拼错的字段被静默忽略时，模型看到的是**成功**。
        // （实测：`{file_path, mode:'auto'}` 这种属于 aura_read 的参数曾零违规穿过框架。）
        assertKnownArgs(args, EDIT_ARG_KEYS, 'aura_edit')
        const creating = typeof args.create === 'string'
        /**
         * 单个 hunk **平铺在顶层**也认。
         *
         * 实测依据（403 会话日志）：报 `hunks must be a non-empty array` 的失败有 27 次，
         * 入参形状一律是 `{file_path, start_line, end_line, replace}`——模型把“一个 hunk”
         * 直接写在了顶层，而不是包进 `hunks: [...]`。这与已采纳的宽容方向是同一条：
         * 模型把 `lines` 写成 `"4,6"` / `4` / `start_line`+`end_line` 都容得下（见上面 schema 的注释），
         * 因为“回一句参数不对让它重试一遍，纯是浪费一轮”。
         *
         * 安全性不变：被容忍的字段（target/lines/…/near）在顶层**本来就不是合法参数**，
         * 所以不存在“把一个真参数误当 hunk”的可能；而地址与 `expect` 闸门一个都不少。
         */
        const flat = flatHunk(args)
        const hunks = Array.isArray(args.hunks) && args.hunks.length > 0 ? args.hunks : flat === null ? null : [flat]
        if (!creating && hunks === null) {
          throw new Error(
            'hunks must be a non-empty array (or pass `create` to make a new file) — a single hunk may also be passed flat: file_path + one of target/lines/line_cue/anchor + replace',
          )
        }
        // 每一次 mutation 都必须带上**调用会话那一份**沙箱策略。
        //
        // 这不是可选的：`dsh-fs-sandbox` 的 `checkedTarget` 读的是它第 5 个参数
        // （`sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`），漏传就退回 fs 插件自己的
        // 默认策略——那是一个**没有 session** 的策略，`writableRoots` 取的是部署兜底根，
        // 而不是调用会话的 cwd。后果不是"更严格"，而是**本工具彻底写不动**：
        // 对工作区内的文件也报 `file access denied under workspace-write mode`。
        //
        // 服务本身来自 apply 期的可选注入（见上方 apply 的注释），这里每次现算，
        // 因为模式可以按会话变化（`sandbox/mode` 事件）。
        const policyService = sandbox()
        const policy =
          policyService === undefined
            ? undefined
            : policyService.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
        // 这两条曾经只是推理，现已实测确认（探针跑完即删）：
        //   injectBound: true  —— `ctx.inject(['sandboxPolicy'])` 在整体 preset 挂载下确实绑得上
        //   hasAgent:    true  —— 执行期 exec.agent 在场，于是 resolve 真的带上了 session
        //   resolved: {mode:'danger-full-access', workspaceRoot:<会话 cwd>, sessionId:…}
        // 即"落到哪个模式"取决于会话策略，而不是部署默认。
        // 解析路径也要用策略里的 workspaceRoot（与内置 tool-fs 的 sessionResolveOptions 一致）：
        // 相对路径必须相对本次 mutation 的沙箱根解析，否则"被检查的路径"与"被写入的路径"可能不同。
        const cwd = policy?.workspaceRoot ?? exec.agent?.session?.header?.cwd
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal,
        })

        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) {
          /**
           * 目标不存在：**先记一次 absent 观测**，再按"创建"或"报错"处理。
           *
           * 这是 dsh-tool-fs 的契约：`fs/observed` 的 `{kind:'absent'}` 让后续写入
           * 能走"带防护的创建"而不被观察策略拒绝。先前这里直接抛错、不记录，
           * 于是"读一个还不存在的文件、然后创建它"这条完全正常的流程会在写入侧失败——
           * 且失败原因看起来与本工具毫无关系。
           */
          ctx.emit('fs/observed', target, { kind: 'absent' }, exec)

          // 创建模式：停掉内置 `write` 之后，这是唯一的建文件路径，因此必须支持。
          // 语义刻意与内置 `write` 对齐 —— 只在文件不存在时创建，存在则报错，
          // 而不是静默覆盖（覆盖现有文件必须走 address + replace 那条路，那条路有 expect 闸门）。
          const createContent = args.create
          if (typeof createContent !== 'string') {
            throw new PatchError(
              `cannot patch "${target.displayPath}": not found — to create it, pass \`create\` with the full file content`,
              'PATCH_NOT_FOUND',
            )
          }
          const created = await ctx.fs.writeText(
            target,
            createContent,
            { kind: 'createIfAbsent' },
            exec.signal,
            policy,
          )
          ctx.emit('fs/observed', target, { kind: 'present', version: created.version }, exec)
          // 建文件也是一次“写成功” ⇒ 同样回读校验（create 被偷偷改写的后果与编辑一样真）。
          const createdVerification = await verifyWriteBack(ctx.fs, target, createContent, target.displayPath, exec.signal)
          // 新建的内容也是“自己刚写过的内容” ⇒ 记成最新观测，随后编辑它不必带 unverified_region。
          // 记账同样取**提供方视角**：内容自带前导 U+FEFF 时，下一次 readText 会剥掉一个，
          // 存原样就会让随后的未断言编辑第 1 行被误拒（F1 就是这条）。
          const createdView = providerView(createContent)
          const createdByteOrderMark = createContent.startsWith(BYTE_ORDER_MARK)
          rememberRead(target.displayPath, contentToken(createdView, createdByteOrderMark), createdView, createdByteOrderMark)
          return {
            path: target.displayPath,
            operation: 'create',
            applied: [
              {
                line: 1,
                tier: 'create',
                byNear: false,
                actual: '',
                replaced: created.after ?? createContent,
              },
            ],
            dryRun: false,
            write_verify: createdVerification,
          }
        }
        const content = await ctx.fs.readText(target, exec.signal)
        // BOM 在解码时已经丢了（只丢第一个），写回前先问字节：它是唯一能回答“原来有几个 BOM”的地方。
        const byteOrderMarks = await fileByteOrderMarkCount(ctx.fs, target, exec.signal)
        let planned
        try {
          planned = planHunks(content, hunks, target.displayPath)
        } catch (error) {
          // 锚点失败时**不要只报错**：把该文件的结构目录一并交回，给模型一条可执行的恢复路径。
          // 实测依据：patch 的失败用例里 100% 都能被符号名救回（locator-lab/recoverable.mjs），
          // 而符号级定位对文本扰动免疫——文本怎么错都影响不到它。
          // 这一步把一个死胡同变成一次可判定的重试，且只在失败时付费。
          throw new PatchError(
            `${error.message}${symbolHint(target.displayPath, content)}`,
            error.code ?? 'PATCH_FAILED',
            error.candidates === undefined ? {} : { candidates: error.candidates },
          )
        }
        const { content: next, applied } = planned

        /**
         * `dry_run` **不能排在闸门之前**（真机实测的结论）。
         *
         * 旧顺序下会出现：预演说 "every hunk matched"，而同样的 hunks 真落盘时闸门报
         * "the text you addressed moved: line 3 no longer holds it (it is now line 1)"。
         * 也就是**预演没预演出真正的判决**——而预演的全部价值就在于“先看会发生什么”。
         * 一个只在写入路径上生效的闸门，配上一个说“没事”的预演，比没有预演更坏：
         * 它会把“会被拒的编辑”报成“可以放心提交”。所以闸门先行，预演在它之后。
         */

        /**
         * 区域级新鲜度闸门（C13）：未带 `expect` 的 hunk，落盘前核对**被寻址区域**
         * 是否在“本次观测”之后被改过（判据形状见 {@link staleConflicts}）。
         *
         * 为什么不能退化成全局版本守：v1 就是因为“整份版本变了就拒”被否掉的——
         * 它会误杀“别人改了无关区域”的正常编辑（段C）。这里只看被寻址区域的文本。
         * 也从没读过（`latestObservation` 为 null）时不拦：那种情况下没有可比的基准，
         * 诚实地在回执里带 `unverified_region`，而不是拿别的信号冒充新鲜。
         *
         * 判据与收据都住在 write-path.mjs（`staleConflicts` / `staleRegionRefusal`）——
         * 这里只做编排。读侧、写侧、独立 CLI 共用同一份，正是为了不再出现
         * “同一个决策写在两处，必有一处漏改”（本文件已经被这条坑过一次，见 `symbolHint`）。
         */
        // `byteOrderMarks` 已在上面从**字节**量过（第 511 行）：BOM 在解码后看不见，
        // 而账本令牌是按 `contentToken(读到的文本, 字节里有 BOM 吗)` 记的。
        // 漏传会让所有 BOM 文件的回执被标成 `unverified_region`（"核对过"被报成"没核对过"）。
        const gate = regionGate(hunks, content, planned, target.displayPath, {
          byteOrderMark: byteOrderMarks > 0,
        })
        if (!gate.clean) throw new PatchError(gate.message, 'PATCH_STALE_REGION', gate.extras)
        // 闸门过了才轮到预演：此刻“预演通过”与“真写会成功”是同一句话。
        if (args.dry_run === true) return { path: target.displayPath, applied, dryRun: true }

        // 本次读取就是一次合法观测，先记上：策略随后对**其它**改动方仍然有效，
        // 而本工具自己的新鲜度由锚点保证——见下。
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

        /**
         * 写回：**提供方级 CAS 的整份写**（writeText + replaceIfVersion），不再用 editText。
         *
         * 为什么必须换：`editText` 内部先把整份内容归一到 LF、匹配替换，再按 `detectLineEndings`
         * 的**多数派**把整份内容统一成一种行尾（dsh-fs-local 的 normalizeLineEndings /
         * restoreLineEndings）⇒ **没被寻址**的行的行尾也会跟着变。真机实测：
         * `alpha\n beta\r\n gamma\n delta\n` 改第 4 行 ⇒ 第 2 行的 `\r\n` 变 `\n`（24 → 23 字节）。
         * `writeText` 逐字节落盘（`:821-839`），因此混合行尾也能只改被寻址那一段。
         *
         * 守卫不弱于旧的：`replaceIfVersion` 在提供方的 per-target 临界区里比对版本
         * （版本 = dev:ino:size:mtimeNs:ctimeNs，原子发布还换 inode），读后被第三方改过 ⇒
         * `FS_STALE_VERSION` 且磁盘不变（locator-lab/byte-fidelity.mjs 段 F 有反向断言）。
         * 内容一侧的守卫也仍在：`planHunks` 已经按**实际读到的全文**逐条定位与核对过，
         * 交出去的 `next` 就是那个内容加上本次改动。
         *
         * 沙箱策略照第 5 个参数传：`dsh-fs-sandbox` 的 writeText 与 editText 用同一个
         * `checkedTarget`（`dsh-fs-sandbox/lib/index.js:125` 与 `:139`），漏传才会退回
         * “没有会话的策略”——那会让本工具在 workspace-write 下写不动。
         *
         * 后端没有 writeText 时（仓库里几个 mock 就是这种形状）退回原来的 editText：
         * 那条路对**行尾统一**的文件逐字节等价（normalize/restore 在纯 LF / 纯 CRLF / 纯 CR 上
         * 是恒等变换），与改前行为一致，不会更坏；真实后端（dsh-fs-local / dsh-fs-sandbox）都有它。
         */
        const newContent = carryingByteOrderMarks(next, byteOrderMarks)
        const byteExact = typeof ctx.fs.writeText === 'function'
        if (!byteExact && hasMixedLineEndings(newContent)) {
          // 后端没有整份写能力，而这份文件是混合行尾 ⇒ 两条路都会改坏非目标行。拒绝，不降级。
          throw new PatchError(
            `cannot patch "${target.displayPath}": this file mixes CRLF and LF line endings and the filesystem backend cannot write it back byte-for-byte (no writeText) — normalize the line endings first, then retry`,
            'PATCH_NO_BYTE_EXACT_WRITE',
          )
        }
        let outcome
        try {
          outcome = byteExact
            ? await ctx.fs.writeText(target, newContent, { kind: 'replaceIfVersion', version: info.version }, exec.signal, policy)
            : await ctx.fs.editText(target, { oldString: content, newString: newContent, replaceAll: false }, undefined, exec.signal, policy)
        } catch (error) {
          throw remediate(error, target.displayPath)
        }
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        /**
         * 落盘后**回读校验**（C14）：先验证，再记账。
         *
         * 顺序是故意的：验证失败时**不刷新观测**——那一刻我们并不知道磁盘上是“我以为写下的内容”，
         * 把它记成最新观测等于替提供方的改写背书。失败回执让模型重读，重读会写下真观测。
         */
        const verification = await verifyWriteBack(ctx.fs, target, newContent, target.displayPath, exec.signal)
        /**
         * 自己刚写的内容就是**最新观测**：不刷新它，同一轮里对同一区域的第二次编辑
         * 会被上面那道闸门拦下（段E 就是这条）。存的版本按内容指纹算（与 `aura_read` 同一把尺子），
         * 存的内容是**提供方视角文本**（见 {@link providerView}）——与下一次读所见逐字一致。
         */
        const writtenView = providerView(newContent)
        const writtenByteOrderMark = newContent.startsWith(BYTE_ORDER_MARK)
        rememberRead(
          target.displayPath,
          contentToken(writtenView, writtenByteOrderMark),
          writtenView,
          writtenByteOrderMark,
        )
        return {
          path: target.displayPath,
          applied,
          dryRun: false,
          write_verify: verification,
          // 没有基准（从未观测过 / 基准已被淘汰）时如实标注，与 CLI 侧同一句话：
          // "没核对过"与"核对过且没变"必须是两句话，否则回执在撒谎。
          ...(gate.basis === 'none' ? { unverified_region: true } : {}),
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Patch ${args.file_path}`,
        kind: 'edit',
        rawInput: hunks,
      }),
    }),
  )
}

export { planHunks } from '../locator-lab/write-path.mjs'