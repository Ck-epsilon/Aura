/**
 * ops.mjs —— CLI 与 MCP 两个入口共用的**一次读 / 一次改**。
 *
 * 两个入口只差参数怎么来（argv / JSON-RPC），执行完全一致；这样"服务化"不会变成两套行为。
 * 引擎（`locator-lab/`）不认框架也不认 OS，本文件只做两件宿主该做的事：
 *   1. 把观测缓存换成**落盘**实现（短进程也要有"上次观测"这个基准）；
 *   2. 提供 `node:fs` 版的 provider（逐字节写 + 本机 CAS + 原子 rename）。
 */
import fs from 'node:fs'
import { readWith, setObservationStore, BYTE_ORDER_MARK_BYTES } from '../locator-lab/read-core.mjs'
// 仓库级地图（T26）：遍历/忽略/排序/预算全在引擎里，这里只接 node:fs 的两个原始能力。
import { collectRepoMap } from '../locator-lab/repo-map.mjs'
import { LINE_ADDRESS_HINT, asLinePair, gaveLineAddress, inferReadMode, lineRangeOf } from '../locator-lab/args.mjs'
import { applyEditToProvider } from '../locator-lab/write-path.mjs'
import { createNodeFsProvider } from './fs-provider.mjs'
import { createDiskStore } from './observation-store.mjs'

/**
 * 把错误对象上的**结构化字段**转进回执。
 *
 * 为什么必须有这一层：`PatchError` 用 `Object.assign(this, extra)` 把证据挂在错误对象自身
 * （`candidates`、`minimal_next`、`others`、`write_verify`、`actual`…），而 CLI/MCP 的回执是
 * 调用方**唯一**的证据来源。原先只转发一个全仓没人设过的 `detail`，于是这些字段在 CLI/MCP 上全丢：
 * 人类可读的 message 还在，机器可用的部分没了（字节靶场报的 F5）。
 *
 * 用**排除法**而不是白名单：以后有人往 `extra` 里加字段，这里自动带上，不会再漏一次。
 */
const ERROR_NOISE = new Set(['code', 'name', 'message', 'stack'])
function errorEvidence(error) {
  if (error === null || typeof error !== 'object') return {}
  const out = {}
  for (const key of Object.keys(error)) {
    if (ERROR_NOISE.has(key)) continue
    out[key] = error[key]
  }
  return out
}

let installed = false

/** 装一次即可：把引擎的观测存储换成落盘实现。 */
export function installDiskObservations() {
  if (installed) return
  setObservationStore(createDiskStore())
  installed = true
}

export function openProvider(resolveRoot) {
  installDiskObservations()
  return createNodeFsProvider({ resolveRoot })
}

/** 与提供方同形地读一份文件：fatal 解码 + 第一个 BOM 不进字符串；二进制拒绝。 */
export function readFileBytes(displayPath) {
  const bytes = fs.readFileSync(displayPath)
  if (bytes.includes(0)) {
    return { error: { ok: false, error: `cannot read "${displayPath}": binary file`, code: 'FS_NOT_TEXT' } }
  }
  const byteOrderMark = bytes.length >= BYTE_ORDER_MARK_BYTES.length && BYTE_ORDER_MARK_BYTES.every((b, i) => bytes[i] === b)
  return { source: new TextDecoder('utf-8', { fatal: true }).decode(bytes), byteOrderMark }
}

/** 读一次（含令牌与观测记账）。 */
/** 读一次（含令牌与观测记账）。抛出与 `editEnvelope` 对称地变成**回包**：
 * 少这一层时，MCP 客户端会因为“没有回包”永久等待（实测：参数名写成 file，只留一行 stderr）。 */
/**
 * `async`：目录路径要走 `collectRepoMap`（它要 await 列目录与读头部）。
 * 两个调用方（CLI `bin/aura.mjs`、MCP `bin/aura-mcp.mjs`）本来就 `await` 它，写法不变。
 */
export async function readEnvelope(provider, args) {
  const { file, around, search, since, maxChars } = args
  try {
    // 行区间先收敛：`[412,500]`、`"412,500"`、`412`、`start_line/end_line` 都接受；
    // 给了但解不出来就明说接受哪些形状（静默退回 auto 会让人以为是别的问题）。
    const lines = lineRangeOf(args)
    if (lines === undefined && gaveLineAddress(args)) {
      return { ok: false, error: LINE_ADDRESS_HINT, code: 'READ_BAD_ARGS' }
    }
    const mode = inferReadMode(args, lines)
    const displayPath = provider.resolve(file)
    const info = provider.stat(displayPath)
    if (info === undefined) return { ok: false, error: `cannot read "${file}": not found`, code: 'FS_NOT_FOUND' }
    /**
     * 目录：给一张仓库地图（T26）。判据只有“它是目录”这一条，不需要调用方多填参数。
     *
     * 引擎驱动遍历（`collectRepoMap`），本函数只把 node:fs 侧的两个原始能力接上去——
     * 与 DSH 壳共用同一份判据（忽略规则、候选排序、预算都在引擎里）。
     */
    if (info.type === 'directory') {
      const env = await collectRepoMap(
        {
          listChildren: (dir) => provider.listDir(dir),
          readHead: async (childTarget, bytes) => {
            const head = await provider.readByteRange(childTarget, { offset: 0, length: bytes })
            return new TextDecoder('utf-8').decode(head)
          },
        },
        displayPath,
        { rootPath: displayPath },
      )
      return { ok: true, ...env }
    }
    const got = readFileBytes(displayPath)
    if (got.error !== undefined) return got.error
    const env = readWith(got.source, {
      mode,
      around,
      // 读侧只认数组：这里从收敛层的 {start,end} 转一次（之前 CLI/MCP 直接传 {start,end}，
      // 于是 `aura read --lines 1,2` 会报 READ_NO_RANGE —— 顺手修掉的既有 bug）。
      lines: asLinePair(lines),
      search,
      since,
      maxChars,
      byteOrderMark: got.byteOrderMark,
      filePath: displayPath,
    })
    return { ok: true, ...env }
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      code: error?.code ?? 'IO_ERROR',
      ...errorEvidence(error),
    }
  }
}

/** 改一次（规划 → 陈旧闸门 → 逐字节写 + CAS → 回读校验 → 刷新观测）。 */
export async function editEnvelope(provider, { file, hunks, dryRun, create }) {
  try {
    const result = await applyEditToProvider(provider, {
      displayPath: provider.resolve(file),
      hunks,
      dryRun: dryRun === true,
      ...(typeof create === 'string' ? { create } : {}),
    })
    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      code: error?.code ?? 'IO_ERROR',
      ...errorEvidence(error),
    }
  }
}
