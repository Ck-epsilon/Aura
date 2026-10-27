#!/usr/bin/env node
/**
 * aura MCP 服务（stdio，JSON-RPC 2.0，一行一条消息）。
 *
 * 为什么是它：Codex / Claude Code / Cursor / Zed 这些 agent 都吃 MCP —— 一次写壳，到处能用，
 * 且**不要求对方装 DSH**（本文件只依赖 node:fs 与本包的引擎）。
 *
 * 暴露三个工具：
 *   aura_basetools_read          七种取景（map/digest/full/around/lines/search/changed）+ 版本令牌
 *   aura_basetools_edit          四层寻址 + expect + dry_run；逐字节写回 + 陈旧区域闸门 + 落盘后回读校验
 *   aura_basetools_write         整份写入（对应内置 Write）：新建或整文件替换，同走原子写与回读校验
 *
 * 接法（写进各家的 MCP 配置即可）：
 *   codex:        codex mcp add aura -- npx -y --package aura-basetools aura basetools mcp
 *   claude code:  claude mcp add aura -- npx -y --package aura-basetools aura basetools mcp
 *   cursor/zed:   command = "npx", args = ["-y", "--package", "aura-basetools", "aura", "basetools", "mcp"]
 *
 * 为什么必须带 `--package`：本包有两个 bin（`aura` / `aura-mcp`），**没有**一个叫
 * `aura-basetools`；npx 在"多个 bin 且没有与包名同名的"时候会拒绝猜，直接报
 * `could not determine executable to run`（实测）。`--package` 明确指定包，`aura` 才是命令。
 */
import { readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'

/**
 * MCP `initialize.instructions`: the only standard server-side nudge many MCP clients will
 * prepend to their prompt. Keep it imperative and factual; it must not promise client behavior
 * the client does not implement.
 */
const SERVER_INSTRUCTIONS = [
  'Prefer the aura_basetools_* tools over built-in Read/Edit/Write/Grep for file work when they are available.',
  'Read with aura_basetools_read: pass `entity` to view one definition + references, a directory path with `search` for repository-wide grep, or an image path for metadata + image content.',
  'Write with aura_basetools_apply: op=replace-body or rename is the default for code (pass the `evidence` from an entity read; ambiguity or staleness writes nothing). op=patch (raw hunks), write (whole file), convert (encoding), and tx (cross-call transaction) cover the remaining write paths.',
  'Keep tool arguments small — long, deeply nested JSON is what the provider\'s stream parser fails on (MALFORMED_RESPONSE). For a single raw change pass the hunk FLAT at the top level (`old`+`replace`, or `start_line`+`end_line`+`replace`+`expect`, or a `handle` from a previous read + `replace`); use `hunks: [...]` only for several changes. Every line-number-addressed hunk must carry `expect` (the text you believe is at those lines) or it is refused; a coordinate is not a content check. If you already hold a `handle`, do not repeat the old text in `old`.',
  'For changes spanning multiple calls use aura_basetools_apply with op=tx begin -> writes with transaction -> commit; rollback on failure.',
  'These tools preserve BOM and per-line endings, gate only the addressed region for staleness, verify writes, and keep multi-target edits atomic.',
  'If your client can enforce provider-side strict tool schemas (DeepSeek `/beta` + `strict: true` per function, OpenAI strict), enable it: strict decoding makes malformed tool-call JSON impossible instead of merely rarer. The schemas convert cleanly with `locator-lab/strict-schema.mjs` (toStrictSchema / strictToolList); `aura basetools doctor` prints the recipe.',
].join(' ')
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  openProvider,
  readEnvelope,
  editEnvelope,
  applyEnvelope,
  writeEnvelope,
  convertEnvelope,
  // 多目标（fs-contract-v2）的引擎绑定：与单目标同一处（`lib/ops.mjs`），bin 里不另找引擎。
  readManyWith,
  editManyEnvelope,
  beginTransactionEnvelope,
  commitTransactionEnvelope,
  rollbackTransactionEnvelope,
  statusTransactionEnvelope,
  MODES,
  assertReadTargets,
  assertEditTargets,
  assertTargetShape,
  assertKnownArgs,
  MT_READ_ELEMENT_KEYS,
  MT_EDIT_ELEMENT_KEYS,
  // 平铺形状的拼装规则与 DSH 壳 / CLI 共用这一份（`locator-lab/args.mjs` 的 `flatHunk`）。
  flatHunk,
} from '../lib/ops.mjs'

// 版本从包自己的 package.json 读：写死过一次，结果 0.4.0 的服务对外还报 0.2.1。
// 取不到（开发树里没有包清单）就报 dev，不谎报版本号。
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'dev'
  }
})()
const DEFAULT_PROTOCOL = '2025-06-18'
/**
 * 服务端真正支持的 MCP 协议版本（按新到旧）。
 *
 * 旧实现原样回显客户端给的任意字符串：客户端发 `9999-99-99`，服务端就宣称自己支持
 * 一个不存在的版本。按 MCP 规范：受支持的请求版本原样返回；不受支持的返回服务端最新的
 * 受支持版本；类型不合法是参数错误（`-32602`），不是“照抄”。
 */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

/**
 * 两个工具共用的 `targets` 声明（fs-contract-v2 §2.1/§2.2）。
 *
 * 一句话说清四件事：一次调用、逐项回执、输出按输入序、一个目标失败不连坐其余
 * （写侧例外：先全部规划，任一规划失败 ⇒ 一个字都不写）。
 * 元素内部**不在 schema 层细化**：读侧元素就是上面那套单目标参数、写侧元素就是 `{file_path, hunks}`，
 * 判据由运行期那两份（`assertReadTargets` / `assertEditTargets`）给，与 DSH 壳一字不差。
 */
const TARGETS_SCHEMA = {
  type: 'array',
  items: { type: 'object' },
  description:
    '一次调用读/改多个目标（与 `file_path` 互斥，最多 32 项）：每个元素就是上面那套单目标参数（读：file_path/mode/lines…；写：file_path/hunks/create）。' +
    '一次调用、逐项回执、输出按输入序；一个目标失败不连坐其余（写侧例外：先全部规划，任一规划失败 ⇒ 一个字都不写）。',
}

/**
 * 为什么 `lines` 用 `anyOf` 而不是 `oneOf`：
 *   四个分支按 `type` 互斥，语义完全等价；但 `oneOf` 在部分 provider 的严格模式里不受支持
 *   （DeepSeek strict / OpenAI strict 只认 `anyOf`），而 MCP 这一面是**多 agent 共用**的。
 *   DSH 适配器保留 `oneOf` —— 它的参数校验器认这个、静默忽略 `anyOf`（见 `aura-edit/index.js`）。
 */

const HUNK_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', description: '符号名，如 `toTodoList` 或 `function:apply`；跳过全部文本匹配' },
    lines: {
      anyOf: [
        { type: 'array' },
        { type: 'string' },
        { type: 'integer' },
        { type: 'object', additionalProperties: true },
      ],
      description: '行号区间 [起, 止]（1-based，闭区间）；也接受 "4,6"、单个 4 或 {start,end}。推荐改用 start_line + end_line。纯行号地址必须同时给 `expect`（该区间当前文本），否则整条拒绝（PATCH_LINES_NEED_EXPECT，零写入）；只改行内一段用 `old`',
    },
    start_line: { type: 'integer', description: '推荐：区间起始行（1-based，闭区间）。纯行号地址必须同时给 `expect`' },
    end_line: { type: 'integer', description: '推荐：区间结束行（1-based，闭区间）；省略则等于 start_line。纯行号地址必须同时给 `expect`' },
    line_cue: { type: 'string', description: '该行上唯一的词' },
    anchor: {
      type: 'string',
      description:
        '整行地址：记得的整行（或连续几行）原文，容忍空白漂移与改写；`replace` 替换命中到的整行。只改行内一段请用 `old`（片段层只换命中跨度）。锚点只是行内片段时整条拒绝（PATCH_ANCHOR_FRAGMENT，零写入）。',
    },
    old: {
      type: 'string',
      description:
        '内容地址：你正在替换的**逐字原文**（+ 可选 context 消歧）。给了它，坐标/符号名降为提示；引擎按内容定位，不唯一时拒绝并给候选。手里已有上次回执的 `handle` 时优先用 handle + replace —— 不必把旧文本再抄一遍，参数更短。',
    },
    context: { type: 'string', description: '与 old 同用：紧邻被替换区域的原文，只在 old 多处命中时用来消歧。' },
    /**
     * fs-contract-v2 §5：读侧发的**区间句柄**（`aura_basetools_read` 的回执里就有，也在正文首行行尾）。
     *
     * 为什么要声明：句柄把「被编辑的那段字节」从模型手里拿走，换成工具自己账本里那份逐字节副本的
     * 凭据；而**参数表里没有的键在这一面就等于不存在** —— CLI 读出来的回执带着柄，模型却看不见
     * 这条路。这一面只做「收得下 + 原样递到引擎」两件事，判据（形状、过期、身份标签、相对定位）
     * 全在引擎（`locator-lab/handle-core.mjs` + `write-path.mjs`），与 DSH 壳那三处**同一套事实**。
     */
    handle: {
      type: 'string',
      description:
        '`aura_basetools_read` 发的区间句柄（不透明，如 `h9f3ac1b2e4d5:120-160`）：工具读过的**逐字节区间**，于是那段文字不必由你转述。配合 `line` 或 `position` 在区间内／边界定位。句柄优先于 `old`／坐标——被让开的一方会在回执里点名。',
      },
      structure: {
        type: 'string',
        description:
          '结构地址：`symbol:<名字>` / `section:<标题>` / `key:<点号路径>`。按结构定位（符号名、节标题、键路径）而不是坐标：行号漂移、整段正文被改写都不会让它失效。' ,
      },
    /** 段内**相对**行：整段替换与“只换其中一行”由此分开；越界是**结果**（正常 not_found 回执），不是抛错。 */
    line: {
      type: 'integer',
      description:
        '与 `handle` 同用：区间**内**第 k 行（1-based，从区间首行数起）——只换这一行，不必重述整段。越界走正常的 not_found 回执（`PATCH_HANDLE_LINE_OUT_OF_RANGE`）。单独给（没有 `handle`）不构成地址。',
    },
    /** 区间**边界**插入：不改动区间本身；“在这段里面”由 `line`／`old` 表达。 */
    position: {
      type: 'string',
      enum: ['before', 'after'],
      description:
        '与 `handle` 同用：把替换文本插在区间**边界**（`before` / `after`）而不是替换区间本身——区间一个字节都不动。单独给（没有 `handle`）不构成地址。',
    },
    near: { type: 'integer', description: '歧义时的行号提示' },
    expect: { type: 'string', description: '断言该处应是什么；对不上则整个补丁失败' },
    replace: { type: 'string', description: '替换文本；空串 = 删除该区域' },
    replace_all: {
      type: 'boolean',
      description:
        '与 old 同用：替换全部非重叠出现（从左到右），不再要求唯一。不能与 target/lines/line_cue/anchor/context/handle/near 同用；读取后出现次数变了会整体拒绝。',
    },
    eol: {
      type: 'string',
      enum: ['auto', 'preserve', 'lf', 'crlf'],
      description: '替换文本的换行风格。auto（默认）= 适配被替换区域的行尾（CRLF 文件写 CRLF，避免混合行尾）；preserve = 按 replace 原样；lf/crlf = 强制。',
    },
  },
  // `required` 只写 `replace`：`handle`／`line`／`position` 是**地址的可选形态**，写进必填会让
  // 「按符号改一行」这类调用在参数层就被拒（与 DSH 壳那三处同一条：它们不是必填）。
  required: ['replace'],
}

const ALL_TOOLS = [
  {
    name: 'aura_basetools_read',
    description:
      'Read a file the way you actually need it. Modes: probe (metadata only: lines, bytes, line endings, encoding, language, structure size — no content), map (symbol/section directory), digest (interface only), full (up to the content budget, not necessarily the whole file), around, lines, search, changed. `auto` picks one for you. Prefer this over reading the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要读的文件路径（绝对或相对 cwd）' },
        mode: {
          type: 'string',
      enum: ['auto', ...MODES],
          description: '省略时按你给的参数自动判断：行区间→lines、around→around、search→search、since→changed',
        },
        around: { type: 'string', description: 'mode=around：以该符号或短语为中心开窗' },
        lines: {
          anyOf: [
            { type: 'array' },
            { type: 'string' },
            { type: 'integer' },
            { type: 'object', additionalProperties: true },
          ],
          description: 'mode=lines：[起, 止]；也接受 "412,500"、单个 412 或 {start,end}。推荐改用 start_line + end_line',
        },
        start_line: { type: 'integer', description: 'mode=lines（推荐）：起始行，1-based，闭区间' },
        end_line: { type: 'integer', description: 'mode=lines（推荐）：结束行，1-based，闭区间；省略则等于 start_line' },
        search: {
          type: 'string',
          description:
            '子串查询。传文件路径时是 mode=search；传**目录**路径时执行仓库级 grep（递归、忽略 node_modules/.git、跳过二进制与超限文件）。',
        },
        entity: {
          anyOf: [{ type: 'string' }, { type: 'object' }],
          description: '实体选择器（如 `function:apply`、`Class/method`，或 {kind,name,file}）：读一个定义 + 引用 + 证据，而不是整份文件。',
        },
        regex: { type: 'boolean', description: '目录 grep：把 search 当正则（默认按字面量子串）。' },
        glob: { type: 'string', description: '目录 grep：只扫描匹配该 glob 的相对路径（如 `src/**/*.ts`；无 `/` 时匹配文件名）。' },
        case_sensitive: { type: 'boolean', description: '目录 grep：区分大小写（默认 true；false = 忽略大小写）。' },
        max_results: { type: 'integer', description: '目录 grep：最多返回多少条命中行（默认 200，上限 1000）。' },
        context: { type: 'integer', description: 'mode=around：上下各留几行（默认 8）' },
        kind: { type: 'string', description: 'mode=map：只保留某一类符号（function / class / …）' },
        budget: { type: 'integer', description: '宿主剪枝阈值（字符）；省略用默认 8192' },
        encoding: { type: 'string', description: '源编码覆盖（默认自动探测）：gb18030 / shift_jis / euc-kr / big5 / utf-16le / utf-16be / windows-1252。只对本次调用生效；显式指定过一次后会被记住（文件未被外部改动时）。' },
        since: { type: 'string', description: 'mode=changed：上次回执里的 version 令牌' },
        max_chars: { type: 'integer' },
        coverage: {
          type: 'boolean',
          description:
            '回执带覆盖集：covered / notCovered（区间字符串，如 "1-9"）与 totalLines；map/digest 的正文覆盖为空数组。默认 false（既有回执形状不变）。',
        },
        structure_handle: {
          type: 'boolean',
          description:
            '窗口恰好覆盖一个符号时，回执额外带结构句柄 `s…:symbol=<name>`：行号漂移或整段正文被改写后，仍能按符号重定位。默认 false。',
        },
        offset: { type: 'integer', description: '与 limit 同用：0-based 行偏移（内置 Read 的分页形状）；与 lines 互斥' },
        limit: { type: 'integer', description: '与 offset 同用：返回行数（默认 2000）；与 lines 互斥' },
        targets: TARGETS_SCHEMA,
      },
      /**
       * `required` 里**不写** `file_path`：单目标（`file_path`）与多目标（`targets`）必居其一，
       * 而“二选一”在 schema 层表达不了（本框架方言不支持 `anyOf`）—— 硬写必填会让多目标形状
       * 在**到达服务之前**就被客户端拒掉。判据只有一处：运行期 `assertTargetShape`（两者都没给）
       * 与 `assertReadTargets`（形状与互斥），与两个 DSH 壳、CLI 共用同一份。
       * 与下面 `aura_basetools_edit` 里 `hunks` 不在 required 是同一条理由。
       */
    },
  },
  {
    name: 'aura_basetools_edit',
    description:
      'Edit or create a text file in one call. PREFER THE FLAT FORM for a single change: put the hunk fields at the top level (`old`+`replace`, or `start_line`/`end_line`+`replace`, or `handle` from a previous read + `replace`) and omit `hunks` entirely — one JSON object instead of an array of objects, which is smaller and survives the provider\'s stream parser more reliably. Use `hunks: [...]` only when a call changes several places. Address each hunk by target (symbol), lines, line_cue, anchor, handle, or old (verbatim content + optional context). With `old`, set `replace_all: true` to replace every non-overlapping occurrence. Writes back byte-for-byte (BOM and per-line endings preserved), refuses a hunk whose addressed region changed since your last read, and reads the file back to verify. All hunks must locate or nothing is written. A single hunk may also be passed flat at the top level (`file_path` + the hunk fields) instead of wrapped in `hunks: [...]`. JSON/JSONC edits: prefer `lines`/`start_line`+`end_line` and put only the new text in `replace` — re-typing the old text doubles the escaped quotes/newlines the call must carry.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        hunks: {
          type: 'array',
          items: HUNK_SCHEMA,
          description: '多次修改时用；**单处修改请用平铺形式**（把 hunk 字段直接放顶层、不传 hunks）：一个对象比“对象数组”少一层嵌套，参数更短、更不容易在流式解码时坏掉。',
        },
        dry_run: { type: 'boolean', description: '只定位不落盘' },
        retry: {
          type: 'boolean',
          description:
            '地址过期时用旧观测里的原文在当前内容里重定位：整行精确匹配且全文唯一才重放，回执带 rebased（from/to）；找不到或命中多处则照旧拒绝。默认 false。',
        },
        require_observation: {
          type: 'boolean',
          description: '严格新鲜度：要求这一版文件在本会话里被读过（或由本工具写过）；否则 PATCH_UNOBSERVED。create 不受影响；dry_run 同样执行这条判决。',
        },
        verify: {
          type: 'string',
          description: '写后验证命令（显式给出才执行；在 workspace 根下、受超时/输出上限约束）。非零退出 ⇒ 自动回滚并返回 PATCH_VERIFY_FAILED。不自动发现/执行仓库脚本。',
        },
        transaction: { type: 'string', description: '跨调用事务 id（tx begin 返回）；本次修改追加到该事务的回滚日志。**写入立即可见**（tx 不是隔离事务，pending 期间盘上已是新字节），commit 只做 afterVersion 校验与可选 verify' },
        create: { type: 'string', description: '文件不存在时用它创建（整份内容）' },
        encoding: { type: 'string', description: '源编码覆盖（默认自动探测）；猜不准时写会拒绝，用它显式指定。只对本次调用生效。' },
        targets: TARGETS_SCHEMA,
        /**
         * 平铺形状：单个 hunk 的键**也**声明在顶层（与 DSH 壳、CLI 同一份容错）。
         *
         * 此前只有 DSH 壳声明了这些键：同一份载荷 `{file_path, start_line, end_line, replace}`
         * 在 DSH 面被执行、在 MCP 面被未知参数守卫拒掉——而 MCP 正是 Codex/Claude Code/Cursor/ZCode
         * 共用的那一面。声明与实装现在同源（拼装仍走 `flatHunk`，不另写一份判据）。
         */
        ...HUNK_SCHEMA.properties,
      },
      /**
       * `hunks` **不在 required 里**：`create` 就是在建一个新文件，那时没有 hunk 可给。
       *
       * 旧版把它写成必填，于是客户端在**到达下面那句友好提示之前**就被 JSON Schema 拒了——
       * 而 `callTool` 里那句“hunks 必须是数组（即使是空数组也要给）”本来就是为了引导这个情况。
       * 同一个坑 DSH 壳早就修过（`aura-edit/index.js`：不在 schema 层声明 hunks 必选，
       * 因为“schema 层表达不了‘二选一’，硬写必填会让创建功能被自己的 schema 挡住”）。
       * MCP 面只是把同一件事补上：两者真正的约束是“**hunks 或 create 至少一个**”，由运行期判。
       *
       * `required` 里同样**不写** `file_path`：单目标（`file_path`）与多目标（`targets`）必居其一，
       * 判据只有一处（运行期 `assertTargetShape` ↔ `assertEditTargets`，与 DSH 壳共用）。
       */
    },
  },
  {
    name: 'aura_basetools_apply',
    description:
      'The single write tool. Default for code: op=replace-body (entity + change) or rename (entity + new_name); pass the evidence from an entity read and the tool resolves the entity, refuses ambiguity/staleness with zero writes, observes the current revision itself, writes atomically and verifies. ' +
      'Same tool covers the old write paths as operations: op=patch (raw hunks/create; escape hatch), op=write (whole file), op=convert (encoding normalization; MCP supports all encodings), op=tx (cross-call transaction begin/commit/rollback/status). ' +
      'Comments and string literals are never renamed. Omit `op` to infer it from the fields you pass.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['replace-body', 'rename', 'patch', 'write', 'convert', 'tx'],
          description: '省略时按字段推断：entity+new_name→rename；entity→replace-body；hunks/create→patch；content→write；to→convert；action→tx',
        },
        file_path: { type: 'string', description: '要修改的文件路径（tx begin/status 可省略）' },
        entity: {
          anyOf: [{ type: 'string' }, { type: 'object' }],
          description: '实体选择器：`function:apply`、`Class/method`，或 {kind,name,file}',
        },
        change: { type: 'string', description: 'replace-body：新的完整实体正文（含签名与结尾换行）' },
        new_name: { type: 'string', description: 'rename：新名字' },
        scope: { type: 'string', enum: ['span', 'file'], description: 'rename 的替换范围：span = 实体跨度，file = 整份文件（默认 file）' },
        evidence: {
          type: 'object',
          description: '上次实体读回执里的 evidence（{spanHash, contentHash, version}）：与当前不一致 ⇒ PATCH_ENTITY_STALE，零写入',
        },
        expect: { type: 'string', description: 'replace-body：断言当前实体跨度应是什么；对不上则整个失败' },
        hunks: { type: 'array', items: HUNK_SCHEMA, description: 'op=patch：原始 hunk 数组（逃生口；单处修改优先用平铺字段或实体 op）' },
        targets: TARGETS_SCHEMA,
        create: { type: 'string', description: 'op=patch：整份内容建文件' },
        require_observation: { type: 'boolean', description: 'op=patch：要求本会话已读过该文件' },
        retry: { type: 'boolean', description: 'op=patch：地址过期时按上次读到的原文重放' },
        content: { type: 'string', description: 'op=write：整份 UTF-8 文本' },
        no_overwrite: { type: 'boolean', description: 'op=write：文件已存在则拒绝' },
        allow_unobserved: { type: 'boolean', description: 'op=write：允许未读即覆写（显式逃生口）' },
        eol: { type: 'string', enum: ['auto', 'preserve', 'lf', 'crlf', 'keep'], description: 'op=write/convert：行尾策略' },
        to: { type: 'string', description: 'op=convert：目标编码（如 utf-8 / gb18030）' },
        from: { type: 'string', description: 'op=convert：源编码；省略时只接受合法 UTF-8' },
        bom: { type: 'string', enum: ['keep', 'yes', 'no'], description: 'op=convert：BOM 策略' },
        repair_double_encoding: { type: 'boolean', description: 'op=convert：修复可逆的双重编码' },
        action: { type: 'string', enum: ['begin', 'commit', 'rollback', 'status'], description: 'op=tx：事务动作' },
        transaction: { type: 'string', description: 'op=tx/写入：跨调用事务 id（begin 时不需要）' },
        verify: { type: 'string', description: '写后验证命令（op=patch/write/tx commit；显式给出才执行）' },
        dry_run: { type: 'boolean', description: '只规划不落盘（tx 与实体 op 不写）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'aura_basetools_write',
    description:
      'Write a whole UTF-8 text file at once (create or overwrite), matching a plain Write tool. Preserves an existing file\'s BOM and line endings, goes through the same atomic write path as aura_basetools_edit, and reads the file back to verify bytes. Prefer aura_basetools_edit for partial changes.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要写的文件路径（绝对或相对 cwd）；不存在则创建' },
        content: { type: 'string', description: '整份内容；覆盖已有文件时替换全部行' },
        encoding: { type: 'string', description: '源编码覆盖（默认自动探测）；写回沿用该编码。只对本次调用生效。' },
        dry_run: { type: 'boolean', description: '只规划不落盘：新建报 create，覆盖校验换行与字节数' },
        no_overwrite: { type: 'boolean', description: '文件已存在时拒绝（WRITE_EXISTS）' },
        allow_unobserved: {
          type: 'boolean',
          description: '覆写默认要求先读过这一版（PATCH_UNOBSERVED）；设为 true 才允许盲写，回执照实标 unverified_region。',
        },
        eol: {
          type: 'string',
          enum: ['auto', 'preserve', 'lf', 'crlf'],
          description: '覆写时的换行风格：auto（默认）适配文件已有风格；preserve 按 content 原样写；lf/crlf 强制。新建文件始终按 content 原样写（非 auto 会被拒绝）。',
        },
        verify: {
          type: 'string',
          description: '写后验证命令（显式给出才执行；在**工作区根目录**执行；无超时参数——MCP 传输上限约 30s，慢命令不要放进来；非零退出 ⇒ 自动回滚并返回 PATCH_VERIFY_FAILED）。',
        },
        transaction: { type: 'string', description: '跨调用事务 id（tx begin 返回）；本次修改追加到该事务的回滚日志。**写入立即可见**（tx 不是隔离事务），commit 只做 afterVersion 校验与可选 verify' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'aura_basetools_convert',
    description:
      'Convert a file between encodings locally, without sending its content through the model: change encoding, line endings, or BOM in one call. Reads with the same detector as read/edit, verifies the encoded bytes decode back to the same text, and writes atomically with a version guard. Also repairs reversible double-encoding (UTF-8 bytes that were decoded as Latin-1/GBK and saved again).',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要转换的文件路径' },
        to: { type: 'string', description: '目标编码，如 utf-8 / gb18030 / utf-16le / windows-1251' },
        from: { type: 'string', description: '源编码覆盖（默认自动探测）' },
        bom: { type: 'string', enum: ['keep', 'yes', 'no'], description: 'BOM 策略：keep（默认，保留源 BOM）/ yes / no' },
        eol: { type: 'string', enum: ['keep', 'lf', 'crlf'], description: '行尾策略：keep（默认）/ lf / crlf' },
        dry_run: { type: 'boolean', description: '只报计划（from/to/字节数），不写盘' },
        repair_double_encoding: {
          type: 'boolean',
          description: '先修复可逆的双重编码（Ã¤Â¸\u00ad 这一类），再做编码/行尾/BOM 变换；检测不到就拒绝（不假装能救）。',
        },
      },
      required: ['file_path', 'to'],
    },
  },
  {
    name: 'aura_basetools_tx',
    description:
      'Begin, commit, rollback, or inspect a cross-call transaction. Begin returns an id; pass it to edit/write `transaction` to append changes. Writes are visible immediately: a transaction is a cross-file ROLLBACK JOURNAL, not isolation — while it is pending the file on disk already holds the new bytes. `commit` checks each written file was not changed externally and can run `verify`; `rollback` restores all files.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['begin', 'commit', 'rollback', 'status'] },
        transaction: { type: 'string', description: 'tx begin 返回的事务 id（begin 时不需要）' },
        verify: { type: 'string', description: 'commit 时的写后验证命令（在**工作区根目录**执行、无超时参数；MCP 传输上限约 30s）；失败 ⇒ 整个事务回滚' },
      },
      required: ['action'],
    },
  },
]

/**
 * 模型可见面：两个工具。旧名字仍在 `ALL_TOOLS` 里，只保留隐藏调用路径给旧接口套件与兼容客户端；
 * `AURA_TEST_EXPOSE_LEGACY=1` 只供测试枚举旧 schema，不进入生产提示。
 */
const PUBLIC_TOOL_NAMES = new Set(['aura_basetools_read', 'aura_basetools_apply'])
const TOOLS = ALL_TOOLS.filter((tool) => PUBLIC_TOOL_NAMES.has(tool.name))

/**
 * 每个工具接受的顶层键，**直接从注册面同一份 `inputSchema` 派生**。
 *
 * 不再手抄第二份名单：schema 加了字段而这里漏改，就会把合法调用拒掉；反过来则把拼错的键
 * 静默忽略（`dryrun: true` 会变成一次真写盘）。两种漂移都在这一行上消失。
 */
const ALLOWED_BY_TOOL = new Map(
  ALL_TOOLS.map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties ?? {})]),
)

/** 未知键拒绝：走 normal envelope（`isError:true`），不让它变成写盘或挂死。 */
function unknownArgsRefusal(source, allowed, where) {
  try {
    assertKnownArgs(source, allowed, where)
    return undefined
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      code: typeof error?.code === 'string' ? error.code : 'BAD_ARGS',
    }
  }
}

/**
 * MCP 客户端的 `arguments` 按规范是对象；实测有的客户端会把 JSON 当**字符串**传过来（模型
 * 把参数写坏时尤其常见），也有传数组的。字符串能解析就用，解不了就回一条可读的结构化错误——
 * 绝不能让它变成 provider 内部的 TypeError（那种不给回包，客户端会一直等到自己的超时）。
 */
function toolArguments(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 落到下面那条统一错误 */
    }
  }
  return undefined
}

/**
 * 多目标读（MCP 面）：`targets` 在场 ⇒ 引擎的批入口 `readManyWith`。
 *
 * 形状判据**一条都不在这里**：`assertReadTargets`（与写侧 `assertEditTargets` 是同一个判据，
 * 只是提示语不同）住在 `locator-lab/args.mjs`，两个 DSH 壳与 CLI 共用同一份。
 * 它抛的是**参数面**错（`ARGS_TARGETS_SHAPE` / `ARGS_TARGETS_LIMIT` / `ARGS_SHAPE_EXCLUSIVE`），
 * 这里把它接成回包 —— 这一面从不把抛出交给客户端（等不到回包就是挂死，见 `serve` 里那条兜底）。
 *
 * 返回值就是**引擎那份批回执**（逐项 + 汇总行 `summary`，原样 JSON）：一个目标失败不连坐其余，
 * 整批 `ok` = 引擎自己的 `counts.failed === 0`。
 */
async function readTargetsCall(provider, args) {
  let targets
  try {
    targets = assertReadTargets(args, { toolName: 'aura_basetools_read', elementKeys: MT_READ_ELEMENT_KEYS })
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), code: typeof error?.code === 'string' ? error.code : 'BAD_ARGS' }
  }
  return await readManyWith(provider, targets)
}

/**
 * 多目标写（MCP 面）：`targets` ⇒ `editManyEnvelope`（引擎三阶段提交 + 独立面那个 `ok` 位）。
 *
 * `dry_run` 是这一面的旗标名（单目标那条路就是它）。元素自带 `hunks` / `create`，因此
 * “hunks 或 create 至少一个”那条规则对多目标形状**不适用**。
 */
async function editTargetsCall(provider, args) {
  let targets
  try {
    targets = assertEditTargets(args, { toolName: 'aura_basetools_edit', elementKeys: MT_EDIT_ELEMENT_KEYS })
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), code: typeof error?.code === 'string' ? error.code : 'BAD_ARGS' }
  }
  return await editManyEnvelope(provider, {
    targets,
    dryRun: args.dry_run === true,
    ...(args.require_observation === true ? { requireObservation: true } : {}),
    ...(args.retry === true ? { retry: true } : {}),
    ...(typeof args.verify === 'string' ? { verify: args.verify } : {}),
    ...(typeof args.transaction === 'string' ? { transaction: args.transaction } : {}),
  })
}

/**
 * 两种形状**都没给**（`file_path` 缺席或空串，且没有 `targets`）⇒ 参数面拒绝。
 *
 * 判据本体是引擎的 `assertTargetShape`（“必居其一”只有那一份）；这里只把码换成这一面的
 * `BAD_ARGS`（既有行为不变），并把**两种形状**写进错误里 —— 旧版那句只说 `file_path`，
 * 于是“你其实该用 targets”这件事在回执里根本看不到。
 */
function noShapeRefusal(source, toolName) {
  try {
    assertTargetShape(source, { toolName })
  } catch (error) {
    return {
      ok: false,
      error: `${String(error?.message ?? error)} — MCP 参数面：单目标是 \`file_path\`（非空字符串），一次多个目标是 \`targets\` 数组（每个元素就是那套单目标参数）`,
      code: 'BAD_ARGS',
    }
  }
  return undefined
}

async function callTool(provider, name, args = {}) {
  // 参数名错是最常见的 agent 失误（比如把 file_path 写成 file）。
  // 这里先给一句人话，不让它退化成 provider 内部的 TypeError（那个不给回包，客户端会挂死）。
  // 多目标形状（fs-contract-v2 §2.1/§2.2）：`targets` 在场 ⇒ 走引擎的批入口；
  // 此时 `file_path` **可以缺席**（“file_path 与 targets 二者至少一个，都缺才拒”）。
  const multi = args.targets !== undefined && args.targets !== null
  /**
   * 未知参数在**任何工具分支之前**拒：旧版 `dryrun:true` 会一路走到写盘，因为这里只读
   * `args.dry_run`、对多出来的键零反馈。schema 与这份名单同源（见 `ALLOWED_BY_TOOL`）。
   * `targets` 元素也逐个校验：它们被声明成 `additionalProperties:true`（形状由运行期判），
   * 但“运行期判形状”不等于“任意拼错的键都可以被静默丢掉”。
   */
  {
    const allowed = ALLOWED_BY_TOOL.get(name)
    if (allowed !== undefined) {
      const refusal = unknownArgsRefusal(args, allowed, name)
      if (refusal !== undefined) return refusal
      if (multi && Array.isArray(args.targets)) {
        /**
         * 写侧元素的合法键用 `MT_EDIT_ELEMENT_KEYS`（与 DSH/CLI 同一份）：它包含**平铺 hunk**
         * 的 `start_line`/`replace` 等。此前这里用 apply 顶层 allowed 过滤，平铺元素被误报
         * unknown arguments——参数面收下一个形状、运行期却永远走不到。
         */
        const writeTargets = name === 'aura_basetools_apply' || name === 'aura_basetools_edit'
        const elementAllowed = writeTargets ? MT_EDIT_ELEMENT_KEYS : allowed.filter((key) => key !== 'targets')
        for (const [index, element] of args.targets.entries()) {
          if (element === null || typeof element !== 'object' || Array.isArray(element)) continue
          const elementRefusal = unknownArgsRefusal(element, elementAllowed, `${name} targets[${index}]`)
          if (elementRefusal !== undefined) return elementRefusal
        }
      }
    }
  }
  /**
   * 逐调用编码覆盖（0.21）：长驻进程里 provider 是同一个，环境变量没法按调用改。
   * 不传时复位到环境变量——不能把上一次调用的 hint 泄漏给下一次。
   */
  if (typeof provider.setEncodingHint === 'function') provider.setEncodingHint(args.encoding)
  if (name === 'aura_basetools_convert') {
    return await convertEnvelope(provider, {
      file: args.file_path,
      to: args.to,
      from: args.from,
      bom: args.bom ?? 'keep',
      eol: args.eol ?? 'keep',
      dryRun: args.dry_run === true,
      repairDoubleEncoding: args.repair_double_encoding === true,
    })
  }
  if (name === 'aura_basetools_tx') {
    const action = args.action
    if (action === 'begin') return beginTransactionEnvelope(provider)
    if (action === 'commit') return await commitTransactionEnvelope(provider, { id: args.transaction, verify: args.verify })
    if (action === 'rollback') return await rollbackTransactionEnvelope(provider, { id: args.transaction })
    if (action === 'status') return statusTransactionEnvelope(provider, { id: args.transaction })
    return { ok: false, error: 'aura_basetools_tx needs action = begin | commit | rollback | status', code: 'BAD_ARGS' }
  }
  if (name === 'aura_basetools_read') {
    if (multi) return await readTargetsCall(provider, args)
    const noShape = noShapeRefusal(args, 'aura_basetools_read')
    if (noShape !== undefined) return noShape
    // 原样透传（不再自己挑字段）：行区间的宽容解析在 lib/ops.mjs → locator-lab/args.mjs 一处做，
    // 三个调用面共用同一套判据。之前这里只挑了几个字段，start_line/end_line 会被默默丢掉。
    return readEnvelope(provider, { ...args, file: args.file_path, maxChars: args.max_chars })
  }
  if (name === 'aura_basetools_edit') {
    if (multi) return await editTargetsCall(provider, args)
    const noShape = noShapeRefusal(args, 'aura_basetools_edit')
    if (noShape !== undefined) return noShape
    /**
     * 真正的约束是“**hunks 或 create 至少一个**”（与 schema 的 `required` 一致）。
     *
     * 旧版无条件要求 hunks，于是 `create` 路径被自己的校验挡住，
     * 而那句提示（“即使是空数组也要给”）本意是引导用户去写 `hunks: []`——
     * 但那本来就是 workaround，不该是必需写法。三面（DSH 壳 / CLI / MCP）现在同一条规则。
     * 多目标形状不走这一条：每个 target 自带 hunks/create（契约 §2.2）。
     */
    const creating = typeof args.create === 'string'
    // 平铺形状（单 hunk 直接写在顶层）：拼装规则只认 `flatHunk` 那一份，不在 bin 里另写。
    const flat = Array.isArray(args.hunks) ? null : flatHunk(args)
    const hunks = Array.isArray(args.hunks) ? args.hunks : flat === null ? [] : [flat]
    if (hunks.length === 0 && !creating) {
      return {
        ok: false,
        error: 'aura_basetools_edit 需要 hunks 数组，或 create（整份内容建文件）二选一；只建文件时直接给 create 即可',
        code: 'BAD_ARGS',
      }
    }
    return await editEnvelope(provider, {
      file: args.file_path,
      hunks,
      dryRun: args.dry_run === true,
      create: creating ? args.create : undefined,
      ...(args.require_observation === true ? { requireObservation: true } : {}),
      ...(args.retry === true ? { retry: true } : {}),
      ...(typeof args.verify === 'string' ? { verify: args.verify } : {}),
      ...(typeof args.transaction === 'string' ? { transaction: args.transaction } : {}),
    })
  }
  if (name === 'aura_basetools_apply') {
    return await applyEnvelope(provider, {
      file: args.file_path,
      entity: args.entity,
      op: args.op,
      change: args.change,
      newName: args.new_name,
      scope: args.scope,
      evidence: args.evidence,
      dryRun: args.dry_run === true,
      verify: args.verify,
      transaction: args.transaction,
      expect: args.expect,
      hunks: args.hunks,
      targets: args.targets,
      create: args.create,
      content: args.content,
      noOverwrite: args.no_overwrite === true,
      allowUnobserved: args.allow_unobserved === true,
      eol: args.eol,
      to: args.to,
      from: args.from,
      bom: args.bom,
      repairDoubleEncoding: args.repair_double_encoding === true,
      action: args.action,
      requireObservation: args.require_observation === true,
      retry: args.retry === true,
    })
  }
  if (name === 'aura_basetools_write') {
    return await writeEnvelope(provider, {
      file: args.file_path,
      content: args.content,
      dryRun: args.dry_run === true,
      noOverwrite: args.no_overwrite === true,
      allowUnobserved: args.allow_unobserved === true,
      ...(typeof args.eol === 'string' ? { eol: args.eol } : {}),
      ...(typeof args.verify === 'string' ? { verify: args.verify } : {}),
      ...(typeof args.transaction === 'string' ? { transaction: args.transaction } : {}),
    })
  }
  return { ok: false, error: `unknown tool ${JSON.stringify(name)}`, code: 'UNKNOWN_TOOL' }
}

export async function serve() {
  const provider = openProvider()
  let buffer = ''
  let chain = Promise.resolve()

  const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  const handle = async (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return replyError(null, -32700, 'Parse error')
    }
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null
    try {
      if (method === 'initialize') {
        const asked = params?.protocolVersion
        if (asked !== undefined && asked !== null && (typeof asked !== 'string' || asked.length === 0)) {
          return replyError(
            id,
            -32602,
            `protocolVersion must be a non-empty string; supported: ${SUPPORTED_PROTOCOLS.join(', ')}`,
          )
        }
        const version =
          typeof asked === 'string' && SUPPORTED_PROTOCOLS.includes(asked)
            ? asked
            : DEFAULT_PROTOCOL
        return reply(id, {
          protocolVersion: version,
          supportedProtocolVersions: SUPPORTED_PROTOCOLS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aura-basetools', version: VERSION },
          instructions: SERVER_INSTRUCTIONS,
        })
      }
      if (method === 'ping') return reply(id, {})
      if (method === 'tools/list') return reply(id, { tools: process.env.AURA_TEST_EXPOSE_LEGACY === '1' ? ALL_TOOLS : TOOLS })
      if (method === 'tools/call') {
        let env
        const callArgs = toolArguments(params?.arguments)
        if (callArgs === undefined) {
          return reply(id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  code: 'BAD_ARGS',
                  error: 'arguments 必须是 JSON 对象（收到字符串或数组，且不是可解析的 JSON 对象）',
                }),
              },
            ],
            isError: true,
          })
        }
        try {
          env = await callTool(provider, params?.name, callArgs)
        } catch (error) {
          // 兜底：漏网的抛出也必须变成回包。不回包 = 客户端永久等待（实测过一轮：
          // 参数名写错 → 只有一行 stderr，客户端挂到自己的超时为止）。
          process.stderr.write(`aura-mcp: tools/call 抛出：${String(error?.stack ?? error)}\n`)
          env = { ok: false, error: String(error?.message ?? error), code: error?.code ?? 'TOOL_THREW' }
        }
        // 图片：MCP 有原生 image content —— 元数据走文本、字节走 image，不把 base64 塞进 JSON。
        let content = [{ type: 'text', text: JSON.stringify(env) }]
        if (env.ok === true && env.image !== undefined) {
          const { image, ...meta } = env
          content = [
            { type: 'image', data: image.data, mimeType: image.mimeType },
            { type: 'text', text: JSON.stringify(meta) },
          ]
        }
        return reply(id, {
          content,
          isError: env.ok !== true,
        })
      }
      if (isNotification) return undefined // 通知不回包（notifications/initialized、cancelled…）
      return replyError(id, -32601, `Method not found: ${String(method)}`)
    } catch (error) {
      process.stderr.write(`aura-mcp: 处理抛出：${String(error?.stack ?? error)}\n`)
      if (isNotification) return undefined
      return replyError(id, -32603, `内部错误：${String(error?.message ?? error)}`)
    }
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      // 单帧失败不能让服务停摆，但**绝不能吞掉**（这里原本写的是 `.catch(() => undefined)`，
      // 结果 MCP 一声不响、定位花了一轮）：错误写 stderr，回包给结构化错误。
      chain = chain
        .then(() => handle(line))
        .catch((error) => {
          process.stderr.write(`aura-mcp: ${String(error?.stack ?? error)}\n`)
        })
    }
  })
  await new Promise((resolve) => process.stdin.on('end', resolve))
  await chain
}

// 直接运行本文件（`aura-mcp`，package.json 里声明的第二个 bin）也要起服务，与 `aura basetools mcp` 等价。
// 用 pathToFileURL 比手拼 file:// 靠得住（Windows 盘符就是那种手拼会踩的地方）。
/**
 * 直接执行本文件才起 stdio 服务。
 *
 * 不能只比 `import.meta.url === pathToFileURL(argv[1])`：macOS 的临时目录
 * `/var/folders/...` 是 `/private/var/folders/...` 的符号链接，Node 给模块的 URL 与
 * argv 的写法可能一侧已 realpath、另一侧没有 ⇒ 服务静默退出，客户端看到 0 个工具
 * （post-publish / split-package 在 macOS 上正是这条）。两边都过 realpath 再比。
 */
function isDirectRun() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  if (import.meta.url === pathToFileURL(invoked).href) return true
  try {
    return realpathSync.native(fileURLToPath(import.meta.url)) === realpathSync.native(invoked)
  } catch {
    return false
  }
}

if (isDirectRun()) {
  await serve()
}
