#!/usr/bin/env node
/**
 * aura MCP 服务（stdio，JSON-RPC 2.0，一行一条消息）。
 *
 * 为什么是它：Codex / Claude Code / Cursor / Zed 这些 agent 都吃 MCP —— 一次写壳，到处能用，
 * 且**不要求对方装 DSH**（本文件只依赖 node:fs 与本包的引擎）。
 *
 * 暴露两个工具，与 DSH 版的 schema 同形：
 *   aura_read  七种取景（map/digest/full/around/lines/search/changed）+ 版本令牌
 *   aura_edit  四层寻址 + expect + dry_run；逐字节写回 + 陈旧区域闸门 + 落盘后回读校验
 *
 * 接法（写进各家的 MCP 配置即可）：
 *   codex:        codex mcp add aura -- npx -y aura-tools mcp
 *   claude code:  claude mcp add aura -- npx -y aura-tools mcp
 *   cursor/zed:   command = "npx", args = ["-y", "aura-tools", "mcp"]
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { openProvider, readEnvelope, editEnvelope } from '../lib/ops.mjs'

// 版本从包自己的 package.json 读：写死过一次，结果 0.4.0 的服务对外还报 0.2.1。
// 取不到（开发树里没有包清单）就报 dev，不谎报版本号。
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'dev'
  }
})()
const DEFAULT_PROTOCOL = '2024-11-05'

const HUNK_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', description: '符号名，如 `toTodoList` 或 `function:apply`；跳过全部文本匹配' },
    lines: {
      oneOf: [
        { type: 'array' },
        { type: 'string' },
        { type: 'integer' },
        { type: 'object', additionalProperties: true },
      ],
      description: '行号区间 [起, 止]（1-based，闭区间）；也接受 "4,6"、单个 4 或 {start,end}。推荐改用 start_line + end_line',
    },
    start_line: { type: 'integer', description: '推荐：区间起始行（1-based，闭区间）' },
    end_line: { type: 'integer', description: '推荐：区间结束行（1-based，闭区间）；省略则等于 start_line' },
    line_cue: { type: 'string', description: '该行上唯一的词' },
    anchor: { type: 'string', description: '记得的原文，容忍空白漂移与改写' },
    near: { type: 'integer', description: '歧义时的行号提示' },
    expect: { type: 'string', description: '断言该处应是什么；对不上则整个补丁失败' },
    replace: { type: 'string', description: '替换文本；空串 = 删除该区域' },
  },
  required: ['replace'],
}

const TOOLS = [
  {
    name: 'aura_read',
    description:
      'Read a file the way you actually need it. Modes: map (symbol directory), digest (interface only), full, around, lines, search, changed. `auto` picks one for you. Prefer this over reading the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要读的文件路径（绝对或相对 cwd）' },
        mode: {
          type: 'string',
          enum: ['map', 'digest', 'full', 'around', 'lines', 'search', 'changed'],
          description: '省略时按你给的参数自动判断：行区间→lines、around→around、search→search、since→changed',
        },
        around: { type: 'string', description: 'mode=around：以该符号或短语为中心开窗' },
        lines: {
          oneOf: [
            { type: 'array' },
            { type: 'string' },
            { type: 'integer' },
            { type: 'object', additionalProperties: true },
          ],
          description: 'mode=lines：[起, 止]；也接受 "412,500"、单个 412 或 {start,end}。推荐改用 start_line + end_line',
        },
        start_line: { type: 'integer', description: 'mode=lines（推荐）：起始行，1-based，闭区间' },
        end_line: { type: 'integer', description: 'mode=lines（推荐）：结束行，1-based，闭区间；省略则等于 start_line' },
        search: { type: 'string', description: 'mode=search：子串' },
        since: { type: 'string', description: 'mode=changed：上次回执里的 version 令牌' },
        max_chars: { type: 'integer' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'aura_edit',
    description:
      'Edit or create a UTF-8 text file with hunks in one call. Address each hunk by target (symbol), lines, line_cue, or anchor. Writes back byte-for-byte (BOM and per-line endings preserved), refuses a hunk whose addressed region changed since your last read, and reads the file back to verify. All hunks must locate or nothing is written.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        hunks: { type: 'array', items: HUNK_SCHEMA },
        dry_run: { type: 'boolean', description: '只定位不落盘' },
        create: { type: 'string', description: '文件不存在时用它创建（整份内容）' },
      },
      /**
       * `hunks` **不在 required 里**：`create` 就是在建一个新文件，那时没有 hunk 可给。
       *
       * 旧版把它写成必填，于是客户端在**到达下面那句友好提示之前**就被 JSON Schema 拒了——
       * 而 `callTool` 里那句“hunks 必须是数组（即使是空数组也要给）”本来就是为了引导这个情况。
       * 同一个坑 DSH 壳早就修过（`aura-edit/index.js`：不在 schema 层声明 hunks 必选，
       * 因为“schema 层表达不了‘二选一’，硬写必填会让创建功能被自己的 schema 挡住”）。
       * MCP 面只是把同一件事补上：两者真正的约束是“**hunks 或 create 至少一个**”，由运行期判。
       */
      required: ['file_path'],
    },
  },
]

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

async function callTool(provider, name, args = {}) {
  // 参数名错是最常见的 agent 失误（比如把 file_path 写成 file）。
  // 这里先给一句人话，不让它退化成 provider 内部的 TypeError（那个不给回包，客户端会挂死）。
  const badFile = typeof args.file_path === 'string' && args.file_path !== '' ? undefined : { ok: false, error: 'file_path 必须是非空字符串（MCP 参数名是 file_path）', code: 'BAD_ARGS' }
  if (name === 'aura_read') {
    if (badFile !== undefined) return badFile
    // 原样透传（不再自己挑字段）：行区间的宽容解析在 lib/ops.mjs → locator-lab/args.mjs 一处做，
    // 三个调用面共用同一套判据。之前这里只挑了几个字段，start_line/end_line 会被默默丢掉。
    return readEnvelope(provider, { ...args, file: args.file_path, maxChars: args.max_chars })
  }
  if (name === 'aura_edit') {
    if (badFile !== undefined) return badFile
    /**
     * 真正的约束是“**hunks 或 create 至少一个**”（与 schema 的 `required: ['file_path']` 一致）。
     *
     * 旧版无条件要求 hunks，于是 `create` 路径被自己的校验挡住，
     * 而那句提示（“即使是空数组也要给”）本意是引导用户去写 `hunks: []`——
     * 但那本来就是 workaround，不该是必需写法。三面（DSH 壳 / CLI / MCP）现在同一条规则。
     */
    const creating = typeof args.create === 'string'
    if (!Array.isArray(args.hunks) && !creating) {
      return {
        ok: false,
        error: 'aura_edit 需要 hunks 数组，或 create（整份内容建文件）二选一；只建文件时直接给 create 即可',
        code: 'BAD_ARGS',
      }
    }
    return await editEnvelope(provider, {
      file: args.file_path,
      hunks: Array.isArray(args.hunks) ? args.hunks : [],
      dryRun: args.dry_run === true,
      create: creating ? args.create : undefined,
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
        return reply(id, {
          protocolVersion: typeof asked === 'string' && asked.length > 0 ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aura-tools', version: VERSION },
        })
      }
      if (method === 'ping') return reply(id, {})
      if (method === 'tools/list') return reply(id, { tools: TOOLS })
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
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(env) }],
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

// 直接运行本文件（`aura-mcp`，package.json 里声明的第二个 bin）也要起服务，与 `aura mcp` 等价。
// 用 pathToFileURL 比手拼 file:// 靠得住（Windows 盘符就是那种手拼会踩的地方）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serve()
}
