/**
 * dsh-tool-aura-read —— 具结构感知的读取工具（DSH 适配器）。
 *
 * 与内置 `read` 的差别不是"读得更省"，而是**先问要什么**：
 *
 *   内置 read 的原语是"把文件给你"。它把三种意图（这文件是什么／改那一处／通读一遍）
 *   都当成"要内容"，于是三者都付全文的钱，再被下游剪枝砍到约 10% 可见。
 *
 *   本工具的原语是"说出你需要什么"，有七个模式，且 `auto` 会自己选最小的那个：
 *     map      这文件里有什么（按重要性排序的符号目录）
 *     digest   它的接口与依赖（签名，不含函数体）
 *     full     全文（小文件上它反而最小）
 *     around   某个符号/某句话附近的窗口
 *     lines    指定行区间
 *     search   全文找一个子串
 *     changed  自上次读取以来变了什么
 *
 * 两条贯穿约束：
 *   1. 输出对齐下游剪枝预算，且开销是**算出来**的，不是预留的魔数
 *   2. 任何丢弃都带 `omitted` 说明与 `next` 续读指令——绝不静默
 *
 * fs 契约与 `dsh-tool-fs` 一致：resolve → 读 → `fs/observed`。
 * 本工具只读不写，因此不发 write/edit 意图。
 *
 * @module dsh-tool-aura-read
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// 读取逻辑本身框架无关，住在 locator-lab；本文件是它的 DSH 适配器。
import { readWith, MODES, BYTE_ORDER_MARK_BYTES, startsWithByteOrderMark } from '../locator-lab/read-core.mjs'
import { LINE_ADDRESS_HINT, asLinePair, assertKnownArgs, gaveLineAddress, inferReadMode, lineRangeOf } from '../locator-lab/args.mjs'
// 仓库级地图（T26）：引擎驱动遍历，本文件只把 ctx.fs 的两个原始能力接上去。
import { collectRepoMap } from '../locator-lab/repo-map.mjs'

export const name = 'dsh-tool-aura-read'

/**
 * 硬依赖。声明进 inject，与 `dsh-tool-fs` 的做法一致——它同样声明这三个。
 *
 * `systemPrompt` **也必须声明**，不能靠 `ctx.get` 兜：用 `ctx.get` 时若服务不可见
 * 就静默跳过，于是"工具注册了但没有指导文本"这种半成品状态**不会报错**，
 * 表现为模型永远不用这个工具——正是我踩过的那个坑。
 * 声明进 inject 后，服务缺失时 Cordis 会让插件进入等待，问题在装载期就暴露。
 *
 * 注意：Cordis 的 guard 会拒绝任何未声明的 `ctx.<name>` 访问。
 */
export const inject = ['fs', 'tools', 'systemPrompt']

// 注：`toolResultPruner` **刻意不写进 inject**。它是可选依赖：
// 写进去会让没有部署剪枝器的组合（CLI / MCP / 单测）把本插件停在等待态、工具根本不注册，
// 而那正是 `dsh-tool-fs` 对可选 `attachments` 服务用 `ctx.inject([...])` 处理的形状。
// 这里更简：用 `ctx.get` 软取，取不到就用引擎缺省值。

/** 本工具无可配置项，但加载器要求这个导出存在。 */
export const Config = z.object({})

/**
 * 从引擎信封**原样透传**给框架的字段。
 *
 * **不要把它改回逐个展开的清单。** 这里原来是
 *   `...(env.omitted === undefined ? {} : { omitted: env.omitted }),` 等六行手写展开，
 * 而那份清单漏字段的方式正好是本工具反复出事的形态——每一次都是"引擎给了、schema 认了、
 * 中间的透传忘了"：
 *   1. `text` 漏声明       → 每条成功路径被拒
 *   2. `version` 在部分模式漏传 → around／lines／search 与所有未索引扩展名读不了
 *   3. `version: null`     → 类型校验拒绝
 *   4. `truncated` 漏传    → 超长单行的截断事实到不了模型（审计时抓到）
 * 前三次的修法都是**往清单里再加一行**——那正是"补丁的补丁"：治的是症状，
 * 而"手写清单会漏"这个成因一直在。现在改成从集合派生，字段的增删只发生在一处。
 *
 * 约束：本清单必须与 `output.schema.properties` 保持一致，
 * 由 `locator-lab/aura-read-schema-test.mjs` 逐模式逐扩展名地守着
 * （它会断言 schema 声明的字段与引擎真实产出的字段对得上）。
 */
export const PASSTHROUGH_FIELDS = ['symbols', 'version', 'omitted', 'next', 'note', 'truncated', 'truncatedLines', 'relocatable']

/**
 * 本工具声明的**顶层参数名**（唯一一份）。
 *
 * 为什么要单列一个常量，而不是在 schema 与守卫处各写一遍：
 * `assertKnownArgs` 要拿它算“合法键集合”，而 schema 要按它声明 `additionalProperties: false`。
 * 两份名单必然会漂（本项目已经因为“同一决策写两处”漏改过多次），
 * 而这里漂的代价很具体：某天给 schema 加一个参数、忘了同步守卫，那个参数会被**自己的守卫拒掉**。
 */
export const READ_ARG_KEYS = ['file_path', 'mode', 'around', 'lines', 'start_line', 'end_line', 'search', 'context', 'since', 'kind']

/**
 * 这份文件带不带 UTF-8 BOM。
 *
 * 为什么不能看内容：提供方的 `readText` 用 `new TextDecoder('utf-8', {fatal:true})` 解码，
 * `ignoreBOM` 默认 false ⇒ BOM **不会**进入解码后的字符串（dsh-fs-local/lib/index.js:315）。
 * 于是“这个文件带不带 BOM”在字符串层已经无法回答，只能问原始字节
 * （`readByteRange`，接口声明见同包 lib/types/index.d.ts:56、实现见 lib/index.js:800）。
 *
 * 判据本身在 read-core（`startsWithByteOrderMark`），与写路径共用一份，
 * 否则“令牌说没 BOM、写回却带 BOM”这类不自洽会两处各修一遍。
 *
 * 测试 mock 可能没有字节接口：那时返回 false（没拿到字节，就没有 BOM 信息可传）。
 */
async function fileStartsWithByteOrderMark(fsService, target, signal) {
  if (typeof fsService.readByteRange !== 'function') return false
  // 探测长度取自字节常量本身（不写死 3）：判据与长度同源，改一处不会漏另一处
  const head = await fsService.readByteRange(target, { offset: 0, length: BYTE_ORDER_MARK_BYTES.length }, signal)
  return startsWithByteOrderMark(head)
}

/**
 * 把信封渲染成模型可读的文本。
 *
 * 分离渲染与逻辑：`readWith` 返回结构化信封（字段即契约），本函数只负责排版。
 * 这样非 DSH 的调用方可以直接消费信封，不必解析这段文本。
 */
function renderEnvelope(env) {
  if (env.ok === false) {
    return `Error: ${env.message}${env.candidates === undefined ? '' : `\n${env.candidates.map((c) => `  line ${c.line}: ${c.text ?? ''}`).join('\n')}`}`
  }
  const head = []
  // `auto` 是**选模式的理由**（engine 里 auto = suggestMode(...).reason），不是模式名；
  // 模式名一直在 `mode` 字段里。这里两样都给：模型要能看出"这次被选了什么、为什么"，
  // 否则选择规则再确定也是黑盒——实测 107 次读取里 69 次走 auto，而回执从未说过选了什么。
  if (env.auto !== undefined) head.push(`(auto: ${env.mode} — ${env.auto})`)
  // 版本令牌：让 changed 可用。此前它只在 changed 自己的回执里出现，而 changed 需要
  // 上一次的令牌当入参——"要拿钥匙先得有钥匙"，于是那一模式在真实会话里等于不存在。
  if (env.version !== undefined) head.push(`version: ${env.version}`)
  if (env.note !== undefined) head.push(env.note)
  /**
   * 可重新定位的引用：把"这个行号属于哪个符号"交给模型。
   *
   * 动态视角下这是必需的一条：行号是**绝对坐标**，而编辑是破坏它的那个变换
   * （上面插一行，下面全 +1）。模型手里只有 `6: return b` 时，一旦文件被改过，
   * 它**没有任何东西可以用来换算**；而 `beta (5-7)` 在插入/删除下不变。
   * 实测不对称：`around` 一直带着符号（在 `label` 里）、`map` 本身就全是符号，
   * **只有 `lines` 与 `search` 给裸行号**——这两个正是最常用于"照着改"的输出。
   */
  if (env.relocatable !== undefined) {
    head.push(
      `relocatable: ${env.relocatable
        .map((r) => `line ${r.line} → ${r.target} (${r.lines[0]}-${r.lines[1]})`)
        .join('; ')}`,
    )
  }
  const body = [head.join('\n'), env.text ?? '', '']
  if (env.label !== undefined) body.push(`[${env.label}]`)
  if (env.omitted !== undefined) body.push(`omitted: ${env.omitted}`)
  if (env.next !== undefined) body.push(`next: ${env.next}`)
  return body.filter((l) => l.length > 0).join('\n')
}

/**
 * 注册 `aura_read` 工具，以及配套的提示段。
 *
 * ## 为什么必须同时注册提示段
 *
 * 只注册工具是不够的——这是实测出来的结论。我在一个真实会话里观察模型**完全不用**
 * 本工具，查会话日志里的系统提示词才找到原因：内置 `tool-fs` 会注入**命令式**指导：
 *
 *   Use the read tool — not shell commands like cat — to inspect text files
 *   Use the write tool to create files or completely replace file contents
 *   Use the edit tool for targeted changes to existing UTF-8 text files
 *
 * 这些句子**无条件注入**（只要内置工具可见），而本工具只有 schema、没有一句话指导。
 * 于是模型面对"读文件"时，提示词明确说用 `read`，本工具只是个沉默的备选——
 * **这不是模型的选择问题，是共存缺陷。**
 *
 * 修法是用同一套机制说同样明确的话。位置放在 `TOOL_EDIT`(1300) **之后**：
 * 提示词里靠后的指导压过靠前的，因此与内置指导冲突时，本段生效。
 *
 * @param ctx - 携带文件系统服务、工具注册表与提示词注册表的上下文。
 */
export function apply(ctx) {
  // 与 dsh-tool-fs 一致：按 scope 检查工具可见性，本工具被限制掉的会话不该收到关于它的指导。
  // `systemPrompt` 已声明进 inject，因此直接访问——用 `ctx.get` 兜会静默跳过，
  // 而"工具注册了却没有指导"正是我踩过的坑。
  ctx.systemPrompt.section({
    name: 'tool:aura-read',
    order: 1310,
    text: ({ scope }) =>
      ctx.tools.get('aura_read', scope) === undefined
        ? ''
        : [
            // 措辞与内置指导**同形**（命令式）。理由见 aura-edit 里同一处的注释：
            // 建议式的措辞在实测中只在部分会话里生效——它是在跟先验拔河。
            // 兜底措辞分两处写：开头**不**给平级选项（给了就等于发许可证——实测中性任务下模型会顺着它选内置），
            // 只在末尾给"aura_read 真做不到"的那两种情况。
            'Use the aura_read tool — not read — for every text-file read: it is the default, and it shows structure instead of raw bytes.',
            'Start with `map` when you do not yet know the file (an importance-ranked symbol directory); use `around` or a line range (`start_line` + `end_line`) for the part you will edit; `digest` for a file\'s interface and dependencies; `changed` to see what moved since a previous read.',
            // 刻意**不再**写"未知扩展名请用内置 read"。实测这句话是错的：未知扩展名上
            // `auto` 会降级到 `full`，内容照给（见 locator-lab/disable-check.mjs）。
            // 那句话唯一的实际效果，是在工具完全可用的场景里把模型赶回内置工具。
            'Files without an indexed extension (config, data, markup) still work: `auto` falls back to `full` and returns the content.',
            // 兜底条件写明白：不写会让模型在确实需要内置工具时犹豫（超大窗口 / aura 直接拒读）。
            'The built-in `read` remains only for what aura_read cannot do: a raw window larger than one reply, or a file aura_read refuses.',
          ].join(' '),
  })

  ctx.tools.register(
    defineTool({
      name: 'aura_read',
      description:
        'Read a file the way you actually need it. Seven modes, and `auto` picks the smallest one for you: ' +
        '`map` (what is in this file — an importance-ranked symbol directory), ' +
        '`digest` (its interface and dependencies — signatures without bodies), ' +
        '`full` (whole text; smallest for tiny files), ' +
        '`around` (a window around a symbol or phrase — give `around=<name>`), ' +
        '`lines` (an exact range — pass `start_line: 412, end_line: 500`, or `lines: [412, 500]`), ' +
        '`search` (find a substring — give `search=<text>`), ' +
        '`changed` (what differs since a previous read — pass `since=<version>`). ' +
        'Output never exceeds what the pipeline preserves, and anything dropped is reported in `omitted` with a `next` hint. ' +
        'Prefer `map` first when you do not yet know the file; then `around` or `lines` for the part you will edit.',
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: 'Path to read, resolved by the filesystem backend.',
        },
        mode: {
          type: 'string',
          description: `One of: ${MODES.join(', ')}, or auto (default). Auto compares rendered sizes and picks the smallest.`,
        },
        around: {
          type: 'string',
          description: 'mode=around: a symbol name or a phrase to center the window on.',
        },
        // 行区间声明成 oneOf：模型的常见失误是把区间写成 `412, 500`（那已经不是合法 JSON，
        // 宿主会在参数进工具之前就拒：`invalid arguments: "arguments" must be an object`），
        // 或者写成 `"412,500"`、单个 412。声明得宽一点，再加上 start_line/end_line 这条
        // "没有数组语法可写错"的路，能少掉一整类来回。
        lines: {
          // 四个分支都要写全：宿主按 oneOf 校验（"must match exactly one branch"），少写 object
          // 会让 `lines: {start, end}` 在参数层就被拒；而 object 分支还**必须显式声明
          // additionalProperties**（宿主规定：必须显式 true/false），否则整个工具在注册时就报
          // UNSUPPORTED_SCHEMA（实测：11 个套件全崩）。两条都是宿主当场教的。
          oneOf: [
            { type: 'array' },
            { type: 'string' },
            { type: 'integer' },
            { type: 'object', additionalProperties: true },
          ],
          description:
            'mode=lines: the range, 1-based inclusive — `[412, 500]`. Also accepts "412,500" or a single 412. ' +
            'Preferred instead: `start_line` + `end_line` (two plain numbers, no array syntax to get wrong).',
        },
        start_line: {
          type: 'integer',
          description: 'mode=lines (preferred): first line of the range, 1-based inclusive.',
        },
        end_line: {
          type: 'integer',
          description: 'mode=lines (preferred): last line of the range, 1-based inclusive. Defaults to start_line.',
        },
        search: {
          type: 'string',
          description: 'mode=search: a substring to find across the file.',
        },
        context: {
          type: 'integer',
          description: 'mode=around: how many lines of context on each side. Default 8.',
        },
        since: {
          type: 'string',
          description: 'mode=changed: the `version` value from a previous aura_read of this file.',
        },
        kind: {
          type: 'string',
          description: 'mode=map: only list symbols of this kind (e.g. `function`).',
        },
      },
      /**
       * 顶层**也要** `additionalProperties: false`。
       *
       * 旧版只有 `output.schema` 写了这一条，参数面没写。而真框架的校验器只在它显式 `false` 时才拒
       * 未声明属性（`json-schema.js:492`）⇒ `{file_path, mod:'map'}` 这种拼写错误**零违规直接放行**，
       * 然后被工具静默忽略（实测：`args.mod` 确实到达 execute，而工具只读 `args.mode`）。
       * 两处一起才自洽：schema 层管住形状，{@link assertKnownArgs} 给可执行的报错。
       */
      additionalProperties: false,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            totalLines: { type: 'integer', required: true },
            // `text` 必须声明。第一版漏了它——而渲染器返回的正是 `text`，
            // 于是**每一条成功路径**都被框架以 `additionalProperties: false` 拒绝：
            //   tool "aura_read" returned invalid output: "value.text" is not a declared property
            // 我的 load-test 当时 29/29 全绿，因为它从不校验输出是否合自己声明的 schema。
            // 现在那道校验补上了，这类错误不会再穿过测试。
            text: { type: 'string', required: true },
            symbols: { type: 'integer' },
            // `version` 可选，而不是必填。历史：它曾是必填，而当时 `changed` 在 `since` 缺省下不给令牌，
            // 于是 around／lines／search 与所有未索引扩展名上它是 undefined，真实会话里 .json／.yml／.md
            // 的读取被框架整条拒掉，才改成可选。
            // 现状（2026-09-22 实测，格式靶场把这条钉住了）：`changed` 无论缺省、相同、过期的 `since`
            // **都会给令牌**（令牌 = 相对当前内容算出的基准）；"含内容的回执必须给令牌"这条更强的规则
            // 由 aura-read-schema-test 的显式不变量守。
            //
            // 更要紧的是：**声明得比产出窄，等于给工具装了一个只在特定参数下才触发的雷。**
            // 这个字段已经炸过两次——第一次是漏声明 `text`（每条成功路径全废），
            // 第二次是它在 around／lines／search 与所有未索引扩展名上是 undefined。
            // 所以现在的判据是：schema 只声明**确实可能缺席**的字段为可选；
            // 而"含内容的模式必须给令牌"这条更强的约束，交给 aura-read-schema-test 去守，
            // 那里能逐模式逐扩展名地断言，比 schema 层能表达的多。
            version: { type: 'string' },
            omitted: { type: 'string' },
            // 单行超过内容预算时，引擎会给出行内截断的机器可读事实。
            // 必须声明：这个 schema 是 additionalProperties:false，任何未声明的返回字段
            // 都会让**整条成功路径**被框架拒绝。同一类错误在本工具上已经发生过三次
            // （漏声明 text、version 在部分模式 undefined、version 为 null），
            // 所以"引擎会返回什么"与"schema 声明了什么"必须同时改。
            // 单行被截：形状全局唯一（{line, shown, omittedChars}）。
            // 第一版在 `search` 里给的是这个形状的**数组**、在 `windowEnvelope` 里给对象，
            // 同一个字段名两种含义——本项目已因此裁过一次（fitWithin.kept），不再重犯。
            truncated: {
              type: 'object',
              additionalProperties: false,
              properties: {
                line: { type: 'integer', required: true },
                shown: { type: 'integer', required: true },
                omittedChars: { type: 'integer', required: true },
              },
            },
            // 多行被截时才出现（search 可能一次截好几行）；元素形状同上。
            truncatedLines: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'integer', required: true },
                  shown: { type: 'integer', required: true },
                  omittedChars: { type: 'integer', required: true },
                },
              },
            },
            // "这个行号属于哪个符号"——行号会随编辑腐坏，符号名不会。
            // 形状**必须唯一**（数组）：引擎里曾经让 lines 给对象、search 给字符串，
            // 那是同一字段两种含义，schema 层根本表达不了。
            relocatable: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'integer', required: true },
                  target: { type: 'string', required: true },
                  lines: { type: 'array', required: true, items: { type: 'integer' } },
                },
              },
            },
            next: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
          throw new Error('file_path must be a non-empty string')
        }
        // 参数形状在这里收敛一次：后面只认 {start, end}，三个调用面（工具壳/CLI/MCP）判据一致。
        const lineRange = lineRangeOf(args)
        if (lineRange === undefined && gaveLineAddress(args)) {
          throw new Error(LINE_ADDRESS_HINT)
        }
        // 给了行区间就用 lines 模式，省掉"顺手再写一个 mode"的机会（写了也尊重）。
        // 未知参数不回默认行为：拼错的字段被静默忽略时，模型看到的是**成功**。
        assertKnownArgs(args, READ_ARG_KEYS, 'aura_read')
        // 未知参数不回默认行为：拼错的字段被静默忽略时，模型看到的是**成功**。
        assertKnownArgs(args, READ_ARG_KEYS, 'aura_read')
        const mode = inferReadMode(args, lineRange)
        const cwd = exec.agent?.session?.header?.cwd
        const target = await ctx.fs.resolve(args.file_path, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal,
        })

        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) {
          // **缺失也要记录成一次观测。** 这是 dsh-tool-fs 的契约：`fs/observed` 的
          // `{kind:'absent'}` 让后续 `write` 能走"带防护的创建"而不是被策略拒绝。
          // 我第一版直接抛错、不记录，于是"读一个还不存在的文件，然后创建它"这条
          // 完全正常的流程会在写入侧失败——而且失败原因看起来与读取毫无关系。
          ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
          throw new Error(`cannot read "${target.displayPath}": not found`)
        }
        /**
         * 目录：**不读文件，直接给一张仓库地图**（T26）。
         *
         * 为什么由这里自动接管，而不是加一个 `mode=repo` / `scope=repo`：
         * 实测模型的 `mode` 主动选择率只有 4%（T17），它宁愿让工具选；
         * 而“这个路径是目录”工具自己就看得出来，让模型多填一个参数只是增加决策成本。
         * 判据只有一条：它确实是目录。传目录的人不可能期待“读一个不存在的文件”那个错。
         *
         * 遍历、忽略规则、候选排序、预算全部在 `collectRepoMap` 里——与 CLI 共用一份。
         * 这里只把 ctx.fs 的两个原始能力（列目录 / 读头部字节）接上去。
         */
        const dirChildren = info.type === 'directory' ? await ctx.fs.listDir(target, exec.signal) : undefined
        if (dirChildren !== undefined) {
          const dirCeiling = (() => {
            const pruner = ctx.get('toolResultPruner')
            const threshold = pruner?.config?.thresholdChars
            return Number.isInteger(threshold) && threshold > 0 ? threshold : undefined
          })()
          const env = await collectRepoMap(
            {
              listChildren: (dir) => ctx.fs.listDir(dir, exec.signal),
              readHead: async (childTarget, bytes) => {
                const head = await ctx.fs.readByteRange(childTarget, { offset: 0, length: bytes }, exec.signal)
                return new TextDecoder('utf-8').decode(head)
              },
            },
            target,
            { rootPath: target.displayPath, ...(dirCeiling === undefined ? {} : { budget: dirCeiling }) },
          )
          return {
            path: target.displayPath,
            mode: env.mode,
            totalLines: env.totalLines,
            ...Object.fromEntries(
              PASSTHROUGH_FIELDS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]),
            ),
            text: env.text,
          }
        }
        const source = await ctx.fs.readText(target, exec.signal)
        // BOM 只存在于字节里（readText 会在解码时丢掉它）——版本令牌要能区分只差 BOM 的两个文件，
        // 就必须把这个事实从字节里取出来交给引擎。
        const byteOrderMark = await fileStartsWithByteOrderMark(ctx.fs, target, exec.signal)
        /**
         * 宿主给"单条工具结果"定的字符上限，**当场读**（不在引擎里抄）。
         *
         * 为什么能读到：`standard` preset 把本工具与 `tool-result-pruner` 放在**同一个
         * isolate realm**（`agent.cordis.yml` 的 compaction 组），服务名 `toolResultPruner`，
         * 它的 `config` 是公开属性（`dsh-compaction-tool-result-pruner/lib/index.js:72`）。
         * 用 `ctx.get` 软取：没部署剪枝器（CLI / MCP / 单测）时落回引擎缺省，而不是让插件停等。
         *
         * 单位注意：该值是 **Unicode 码点**，而引擎量的是 `JSON.stringify(...).length`（UTF-16 码元）。
         * 两者对 BMP 内字符一致；代理对（emoji 等）会让引擎的数字偏大，即偏保守——方向安全，
         * 且因为披露机制在，偏保守不会丢信息。
         */
        const hostCeiling = (() => {
          const pruner = ctx.get('toolResultPruner')
          const threshold = pruner?.config?.thresholdChars
          return Number.isInteger(threshold) && threshold > 0 ? threshold : undefined
        })()
        // 读一次就是一次合法观测：记录当前版本，供后续 changed 比对与其它工具的新鲜度判断
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

        const request = {
          filePath: target.displayPath,
          ...(mode === undefined ? {} : { mode }),
          ...(args.around === undefined ? {} : { around: args.around }),
          // 读侧的 renderLines 只认数组 [start,end]（写侧的 locate 才认 {start,end}）。
          ...(lineRange === undefined ? {} : { lines: asLinePair(lineRange) }),
          ...(args.search === undefined ? {} : { search: args.search }),
          ...(args.context === undefined ? {} : { context: args.context }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
          // changed 的 `since` 用文件版本而非内容指纹：调用方从 read 结果里拿到的是版本，
          // 而版本来自 fs 后端，因此跨进程、跨工具都一致。
          ...(args.since === undefined ? {} : { since: args.since }),
          // 流水线硬上限**现读现传**，不在引擎里抄一个常量。
          // `toolResultPruner.config.thresholdChars` 是可配置的（dsh-base 与三个 preset 都显式写着），
          // 所以"抄进引擎"会在宿主改配置时静默失准（调大→白白少给，调小→中段被剪）。
          ...(hostCeiling === undefined ? {} : { budget: hostCeiling }),
          byteOrderMark,
        }
        const env = readWith(source, request)
        if (env.ok === false) {
          /**
           * 把 `next`（续读指令）与 `candidates`（候选行）一并拼进 message。
           *
           * 为什么必须拼进来：DSH 框架对抛出的错误**只取 `error.message`**
           * （`dsh-tools/lib/index.js:2495-2503` 的 `errorMessage`），挂在错误对象上的
           * 其它字段一概不读。所以错误路径上的结构化字段等于不存在——
           * 而本文件上方（L99 附近的 `renderEnvelope`）**已经**会渲染 candidates，
           * 只是成功路径用得上、失败路径根本走不到那里。
           *
           * 实测：`READ_AMBIGUOUS` 类失败里引擎给出了完整候选行，模型一个也没看到。
           */
          const extra = [
            env.next === undefined ? '' : `\nnext: ${env.next}`,
            env.candidates === undefined
              ? ''
              : `\n${env.candidates.map((c) => `  line ${c.line}: ${c.text ?? ''}`).join('\n')}`,
          ].join('')
          throw new Error(`${env.code}: ${env.message}${extra}`)
        }

        // 渲染成文本放进 output.schema 允许的字段。
        // 可选字段从 PASSTHROUGH_FIELDS 派生，而不是手写展开——理由见该常量的注释。
        return {
          path: target.displayPath,
          mode: env.mode,
          totalLines: env.totalLines,
          ...Object.fromEntries(
            PASSTHROUGH_FIELDS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]),
          ),
          text: renderEnvelope(env),
        }
      },
      presentCall: (args) => {
        const range = lineRangeOf(args)
        const shown = inferReadMode(args, range)
        return {
          card: 'generic',
          title: `Read ${args.file_path}${shown === undefined ? '' : ` (${shown})`}`,
          kind: 'read',
          rawInput: { mode: shown ?? 'auto', around: args.around, lines: range ?? args.lines, search: args.search },
        }
      },
    }),
  )
}
