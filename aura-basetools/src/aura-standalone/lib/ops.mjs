/**
 * ops.mjs —— CLI 与 MCP 两个入口共用的**一次读 / 一次改**。
 *
 * 两个入口只差参数怎么来（argv / JSON-RPC），执行完全一致；这样"服务化"不会变成两套行为。
 * 引擎（`locator-lab/`）不认框架也不认 OS，本文件只做两件宿主该做的事：
 *   1. 把观测缓存换成**落盘**实现（短进程也要有"上次观测"这个基准）；
 *   2. 提供 `node:fs` 版的 provider（逐字节写 + 本机 CAS + 原子 rename）。
 *
 * 本文件同时是**引擎位置的唯一解析点**（见下方 `engineBase`）：CLI 与 MCP 都从这里拿引擎绑定
 * （`flatHunk` 也从这里出去），于是「引擎在哪」这个问题在整棵树里只有一个答案。
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createNodeFsProvider, DEFAULT_MAX_TEXT_BYTES } from './fs-provider.mjs'
import { withWorkspaceLock } from './workspace-lock.mjs'
import { createTransaction, getTransactionMeta, openTransaction } from './transaction-store.mjs'
import { createDiskStore } from './observation-store.mjs'

/**
 * ── 引擎位置：两种布局各一个候选，选一次之后就冻住 ─────────────────────────────
 *
 * 为什么不能只写一个相对路径：引擎相对本文件的位置在两种布局里不同。
 *   src 布局：本文件 = `src/aura-standalone/lib/ops.mjs`
 *            引擎   = `src/locator-lab/`                  ⇒ 候选 `../../locator-lab/`
 *   摊平布局：本文件 = `dist/aura-basetools/lib/ops.mjs`
 *            引擎   = `dist/aura-basetools/locator-lab/`（`lib/` 的同层）⇒ 候选 `../locator-lab/`
 *（相对 URL 是相对**本文件所在目录**解析的：`'./x'` 与 `'../x'` 差的就是这一层。）
 *
 * 这不是「少写了一个 `..`」那种笔误：两个布局要求的层数**本来就不同**。从前两处写的是
 * `'../locator-lab/read-core.mjs'`，只在摊平布局下成立；src 布局下它解析成
 * `src/aura-standalone/locator-lab/read-core.mjs`（不存在），CLI 子进程一启动就是
 * ERR_MODULE_NOT_FOUND（`src/aura-standalone/test/standalone-test.mjs` 23 条全红就是这么来的）。
 *
 * 为什么另一个布局也成立（两条要一起看，否则等于换个布局照样红）：
 *   · 引擎在 src 布局下位于**包根外面**、在摊平布局下位于**包根里面**，是同一个相对路径
 *     永远够不着的两处；所以判据不能是「路径写得多长」，只能是「这里到底有没有引擎」。
 *   · 打包器 `build/make-bundle.mjs` 的摊平规则是 `aura-standalone/{bin,lib,test}` → `{bin,lib,test}`，
 *     只压掉 `aura-standalone/` 这一层，`bin/`、`lib/`、`locator-lab/` 三者同时上移一层；
 *     它们彼此的**相对位置一个都没动**，所以 `bin/aura.mjs` → `../lib/ops.mjs` 这类同层引用
 *     天然两边都成立，需要重新定位的只有「引擎」这一个目标（也就是本文件这一段）。
 *
 * 为什么不是别的三条路（都想过，都不如这条）：
 *   · 只修相对路径：做不到。同一个字面量在两种布局里指向两个不同目录，几何上无解。
 *     除非改摊平规则去迁就——那要动 `build/make-bundle.mjs`（本单元写范围之外），且会把
 *     「包内 bin/、lib/ 与引擎同层」这个既有事实反过来变成「引擎必须多一层」。
 *   · `#engine/*` subpath imports：要包内在位、且带 `imports` 映射的 `package.json`。
 *     src 布局那份即便放在 `aura-standalone/package.json`，打包器也只复制 `{bin,lib,test}` 里的 .mjs，
 *     产物里不会有它 ⇒ 摊平布局反而解析不到（把一个绿的布局换红）。要让它成立就得改打包器。
 *   · 按 `package.json` 的归属分岔：同样依赖那份清单在位，同样绕不开改打包器。
 *
 * 剩下的选择只在「怎么判」上，而判据只有一条：候选里有没有引擎本体 `read-core.mjs`。
 *   ① 判据是引擎自带的事实，不是环境变量、cwd、盘符或进程参数 —— 同一份代码在任意机器、任意
 *      cwd、Windows/macOS/Linux 上得到同一个答案（本文件不按操作系统分岔，打包器的 host 档守卫也在守这条）；
 *   ② 候选只有两个，是两种布局的定义值，不是搜索：选中即冻结成常量 `engineBase`，
 *      运行期不再有任何按调用分岔的路径（每次 read/edit 走的都是同一套 import 绑定）；
 *   ③ 两个都不中时不静默兜底：报错把两个候选连同判据一起列出来，谁都能一眼看出布局坏了。
 */
const ENGINE_MARKER = 'read-core.mjs'
// 顺序无关：两个候选互不包含。摊平那份排前面只是为了让"包里那一份"优先。
const ENGINE_CANDIDATES = ['../locator-lab/', '../../locator-lab/']
const engineBase = (() => {
  for (const candidate of ENGINE_CANDIDATES) {
    const base = new URL(candidate, import.meta.url)
    if (fs.existsSync(fileURLToPath(new URL(ENGINE_MARKER, base)))) return base
  }
  throw new Error(
    `aura: 找不到引擎（判据：候选目录里有 ${ENGINE_MARKER}）。` +
      `从 ${fileURLToPath(import.meta.url)} 试过：${ENGINE_CANDIDATES.map((c) => fileURLToPath(new URL(c, import.meta.url))).join('、')}。` +
      `这通常意味着打包摊平规则改了、或 aura-standalone/ 被整体挪出了原位。`,
  )
})()
const engineUrl = (name) => new URL(name, engineBase).href

// 引擎（`locator-lab/`）不认框架也不认 OS；这里按内容取模块，不按写死的相对深度取。
const readCore = await import(engineUrl('read-core.mjs'))
const repoMap = await import(engineUrl('repo-map.mjs'))
const engineArgs = await import(engineUrl('args.mjs'))
const writePath = await import(engineUrl('write-path.mjs'))
const structCore = await import(engineUrl('struct-core.mjs'))
const handleCore = await import(engineUrl('handle-core.mjs'))

/**
 * 0.9.9：运行时可查询的能力清单（与 build/capabilities.mjs 同一份源码常量）。
 * 不发货额外 JSON：包内已有的引擎模块就是唯一来源。
 */
export function capabilitiesEnvelope() {
  const langs = Object.keys(structCore.LANGS).sort()
  return {
    tools: [
      { name: 'aura_basetools_read', modes: ['auto', ...readCore.MODES] },
      {
        name: 'aura_basetools_edit',
        addressKinds: [...new Set([...engineArgs.FLAT_ADDRESS_KEYS, 'old', 'context', 'position'])],
        options: ['replace_all', 'require_observation', 'verify'],
        writeSafety: {
          cli: ['workspace-lock', 'stale-region-gate', 'byte-verify'],
          mcp: ['workspace-lock', 'stale-region-gate', 'byte-verify'],
          dsh: ['stale-region-gate', 'byte-verify'],
        },
      },
      {
        name: 'aura_basetools_write',
        operations: ['create', 'overwrite'],
        options: ['eol', 'verify'],
        writeSafety: {
          cli: ['workspace-lock', 'stale-region-gate', 'observation-gate', 'byte-verify'],
          mcp: ['workspace-lock', 'stale-region-gate', 'observation-gate', 'byte-verify'],
          // DSH 壳没有工作区锁；它经过引擎的区域闸、严格新鲜度与回读校验。
          dsh: ['stale-region-gate', 'observation-gate', 'byte-verify'],
        },
      },
    ],
    commands: ['basetools read', 'basetools edit', 'basetools write', 'basetools tx', 'basetools mcp', 'basetools doctor', 'basetools capabilities', '--version', '--help'],
    langs,
    langsCount: langs.length,
    limits: {
      multiTargetsMax: engineArgs.MT_MAX_TARGETS,
      multiTargetPool: engineArgs.MT_POOL,
      defaultPruneBudget: readCore.DEFAULT_PRUNE_BUDGET,
      envelopeAllowance: readCore.DEFAULT_ENVELOPE_ALLOWANCE,
      contentBudget: readCore.CONTENT_BUDGET,
      handlesPerReceipt: handleCore.HANDLE_MAX_PER_RECEIPT,
    },
    packaging: { corePackage: 'aura-basetools', adapterPackage: 'aura-basetools-dsh' },
  }
}

/**
 * 引擎公开面的转发：绑定转发，不是「把命名空间塞给调用方」——
 * 静态 import 与动态 import 在 ESM 缓存里同键，所以这里转出去的 `readWith`、`flatHunk`
 * 与 DSH 壳静态引到的是同一个值、同一份模块实例。
 *
 * `flatHunk` 一并转发：CLI 需要的容错规则是引擎里那一份，从这里出去就少一个
 * 「谁去定位引擎」的地方（少一处 = 少一处会在另一种布局下红的引用）。
 */
export const readWith = readCore.readWith
export const setObservationStore = readCore.setObservationStore
export const BYTE_ORDER_MARK_BYTES = readCore.BYTE_ORDER_MARK_BYTES
export const collectRepoMap = repoMap.collectRepoMap
export const LINE_ADDRESS_HINT = engineArgs.LINE_ADDRESS_HINT
export const asLinePair = engineArgs.asLinePair
export const gaveLineAddress = engineArgs.gaveLineAddress
export const inferReadMode = engineArgs.inferReadMode
export const lineRangeOf = engineArgs.lineRangeOf
export const normalizeReadRequest = engineArgs.normalizeReadRequest
export const flatHunk = engineArgs.flatHunk
export const applyEditToProvider = writePath.applyEditToProvider

/**
 * ── 多目标（fs-contract-v2）在独立面上的接法：CLI 与 MCP 都从这里拿引擎绑定 ──────
 *
 * 与上面的 `flatHunk` 同一条纪律：**“引擎在哪”只有一个答案**。两个 bin 里各写一句
 * `import('../locator-lab/…')` 就等于又长出两个只在摊平布局下成立的引用（见 `engineBase`）。
 *
 * 形状判据（数组 / 上限 32 / 空批 / 逐项路径 / 与单目标形状互斥）**一条都不在这里**：
 * 它就是 `locator-lab/args.mjs` 里那两份（`assertReadTargets` ↔ `assertEditTargets`，
 * 与两个 DSH 壳共用同一份）。调用面只负责把参数递对。
 *
 * `assertTargetShape`（两个都没给）与 `assertKnownArgs`（顶层不认识的键）同样从引擎转出：
 * 前者是“必居其一”的完整判据（壳里原来那句 `file_path must be a non-empty string` 是它的半个身子），
 * 后者防的是“拼错的键被静默忽略 ⇒ 调用方以为成功”。
 */
export const readManyWith = readCore.readManyWith
export const applyEditsToProvider = writePath.applyEditsToProvider
export const assertReadTargets = engineArgs.assertReadTargets
export const assertEditTargets = engineArgs.assertEditTargets
export const assertTargetShape = engineArgs.assertTargetShape
export const assertKnownArgs = engineArgs.assertKnownArgs
export const MT_READ_ELEMENT_KEYS = engineArgs.MT_READ_ELEMENT_KEYS
export const MT_EDIT_ELEMENT_KEYS = engineArgs.MT_EDIT_ELEMENT_KEYS

// ── C55：非 UTF-8 文件 ⇒ 可执行的拒绝 ──────────────────────────────────────

/**
 * 这次失败是不是「这份文件不是 UTF-8 文本」？
 *
 * 两种后端形状都要认（都是实测出来的）：
 *   · `ERR_ENCODING_INVALID_ENCODED_DATA` —— `new TextDecoder('utf-8',{fatal:true}).decode()`
 *     在裸 Node 侧的原始错误，消息是 `The encoded data was not valid for encoding utf-8`，
 *     **不带文件名**（BASE 段的实测读数就是它：CLI 与 MCP 两面都只回这一句）；
 *   · `FS_NOT_TEXT` + 消息里有 `utf-8` —— `dsh-fs-local` 的 `decodeUtf8` 把上面那个 TypeError
 *     翻成了 `cannot read "<路径>": invalid UTF-8 text`。
 *
 * 为什么不能只看码：`FS_NOT_TEXT` 同时也用于「含 NUL 的二进制文件」（消息是 `binary file`，
 * 见 dsh-fs-local:355 与本包 fs-provider:97）。那是另一件事，它的说法本来就够
 * （有路径、有原因），不该被这一段的文案盖住。
 *
 * 反过来，判据也**不能**用「解码失败」去反推：本函数只在**已经捕获到**错误时被调用，
 * 带 BOM 的 UTF-8（`TextDecoder` 默认 `ignoreBOM:false`，只吃掉第一个 BOM）根本走不到这里，
 * 因此不会被误判成非 UTF-8。
 */
function isNonUtf8TextFailure(error) {
  if (error === null || typeof error !== 'object') return false
  if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return true
  const message = typeof error.message === 'string' ? error.message : ''
  return /invalid utf-?8|not valid for encoding utf-?8/i.test(message)
}

/**
 * 「这份文件不是 UTF-8 文本」的拒绝回执：**三件事必须同一次说清**。
 *
 *   ① 是哪个文件——路径原样带引号，可以直接复制去查；
 *   ② 为什么读不了——它的字节不是 UTF-8 文本，因此这里根本没有可读/可寻址的文本；并点明
 *      这是**环境级拒绝**，换参数重发不可能成功（否则调用方会去改地址、改模式，
 *      而它真正要做的只是把文件转成 UTF-8）；
 *   ③ 下一步怎么办——先确认编码、再转成 UTF-8、再调一次；并明说**这次一个字节都没改**。
 *
 * 独立面（CLI / MCP）的口径与 DSH 壳一致：留在**失败通道**里（`ok:false` + 非零退出），
 * 不伪装成结果通道的「判定不出你的意图」——那是两件事。
 *
 * 同一段判据与同一句话在三个面上各有一份（本波写范围不共享模块）：
 *   aura-read/index.js · aura-edit/index.js · aura-standalone/lib/ops.mjs。
 * 抄漏一处由 `locator-lab/encoding-refusal-test.mjs` 段C 逐处抽出来比对 ⇒ 会红。
 */
function nonUtf8RefusalMessage(verb, displayPath, tool) {
  return (
    `cannot ${verb} "${displayPath}": this file is not UTF-8 text.\n` +
    `why: its bytes are not a UTF-8 encoding of text, so there is no text here to ${verb === 'read' ? 'read' : 'address'}. ` +
    `This is an environment-level refusal, not a problem with the arguments you passed — re-sending the same call cannot succeed.\n` +
    `next: (1) find out which encoding the file really uses — look at its bytes (a hex view) or at your editor's encoding indicator (\`file -i\` where available); ` +
    `(2) convert it to UTF-8 (for example \`iconv -f GBK -t UTF-8\`, or the editor's "save with encoding: UTF-8"); ` +
    `(3) then call ${tool} again on the converted file.\n` +
    `nothing was written: this call did not touch the file — its bytes on disk are exactly as they were.`
  )
}

/**
 * 解析成绝对路径；解析本身失败就退回调用方写的那一份。
 * 拒绝里的路径要是**能直接拿去用**的那一个（相对路径要先知道相对于谁），
 * 但也不能拿一个路径解析失败去掩盖原始的编码错误。
 */
function resolvedOrRaw(provider, file) {
  try {
    return provider.resolve(file)
  } catch {
    return String(file)
  }
}

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
export function errorEvidence(error) {
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
  if (process.env.AURA_NO_OBSERVATION_CACHE === '1') {
    installed = true
    return
  }
  setObservationStore(createDiskStore())
  installed = true
}

export function openProvider(resolveRoot) {
  installDiskObservations()
  return createNodeFsProvider({ resolveRoot })
}

/** 与提供方同形地读一份文件：fatal 解码 + 第一个 BOM 不进字符串；二进制拒绝。 */
export function readFileBytes(displayPath) {
  let stat
  try {
    stat = fs.statSync(displayPath)
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'FS_IO_ERROR'
    return { error: { ok: false, error: `cannot read "${displayPath}": ${error?.message ?? code}`, code } }
  }
  const configuredMax = Number(process.env.AURA_MAX_FILE_BYTES)
  const maxTextBytes = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_TEXT_BYTES
  if (stat.isFile() && stat.size > maxTextBytes) {
    return {
      error: {
        ok: false,
        error: `cannot read "${displayPath}": file is ${stat.size} bytes, over the ${maxTextBytes}-byte text limit`,
        code: 'FS_TOO_LARGE',
      },
    }
  }
  const bytes = fs.readFileSync(displayPath)
  if (bytes.includes(0)) {
    return { error: { ok: false, error: `cannot read "${displayPath}": binary file`, code: 'FS_NOT_TEXT' } }
  }
  const byteOrderMark = bytes.length >= BYTE_ORDER_MARK_BYTES.length && BYTE_ORDER_MARK_BYTES.every((b, i) => bytes[i] === b)
  /**
   * C55：解码失败原来直接抛裸 `TypeError`（`The encoded data was not valid for encoding utf-8`），
   * 一路浮到 CLI/MCP 就只剩这一句——不说哪个文件、不说下一步。现在在这里换成可执行的拒绝。
   * 码**原样保留**（`ERR_ENCODING_INVALID_ENCODED_DATA`）：调用方与既有判据靠它区分
   * 「不是 UTF-8」与别的工具级故障（`range-bytes-test` 段D 就钉着它）。
   */
  try {
    return { source: new TextDecoder('utf-8', { fatal: true }).decode(bytes), byteOrderMark }
  } catch (error) {
    return {
      error: {
        ok: false,
        error: nonUtf8RefusalMessage('read', displayPath, 'aura_basetools_read'),
        code: typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'FS_NOT_TEXT',
      },
    }
  }
}

/** 读一次（含令牌与观测记账）。 */
/** 读一次（含令牌与观测记账）。抛出与 `editEnvelope` 对称地变成**回包**：
 * 少这一层时，MCP 客户端会因为“没有回包”永久等待（实测：参数名写成 file，只留一行 stderr）。 */
/**
 * `async`：目录路径要走 `collectRepoMap`（它要 await 列目录与读头部）。
 * 两个调用方（CLI `bin/aura.mjs`、MCP `bin/aura-mcp.mjs`）本来就 `await` 它，写法不变。
 */
export async function readEnvelope(provider, args) {
  const { file, around, search, since, context, kind, budget } = args
  // 宿主面用 `max_chars`，引擎面用 `maxChars`；单目标与 targets 元素都必须认两种写法。
  const maxChars = args.maxChars ?? args.max_chars
  try {
    /**
     * 行区间 / 分页 / 模式推断收成一份（`normalizeReadRequest`）：单目标与 `targets` 元素
     * 走同一个判定器。第一遍只判形状（文件还没读），第二遍拿到总行数后做 offset 越界与截断。
     */
    const requestShape = normalizeReadRequest(args)
    if (requestShape.ok !== true) return requestShape
    const displayPath = provider.resolve(file)
    const info = provider.stat(displayPath)
    if (info === undefined) return { ok: false, error: `cannot read "${file}": not found`, code: 'FS_NOT_FOUND' }
    if (info.type === 'directory' && requestShape.paginate) {
      return { ok: false, error: 'offset/limit applies to files; a directory is returned as a repo map — drop pagination', code: 'READ_BAD_ARGS' }
    }
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
    const request = normalizeReadRequest(args, got.source.split(/\r?\n/).length)
    if (request.ok !== true) return request
    const env = readWith(got.source, {
      mode: request.mode,
      around,
      // 读侧只认数组：这里从收敛层的 {start,end} 转一次（之前 CLI/MCP 直接传 {start,end}，
      // 于是 `aura read --lines 1,2` 会报 READ_NO_RANGE —— 顺手修掉的既有 bug）。
      lines: asLinePair(request.lines),
      search,
      since,
      maxChars,
      ...(context === undefined ? {} : { context }),
      ...(kind === undefined ? {} : { kind }),
      ...(budget === undefined ? {} : { budget }),
      byteOrderMark: got.byteOrderMark,
      filePath: displayPath,
    })
    return { ok: true, ...env }
  } catch (error) {
    /**
     * C55：非 UTF-8 也走这条 catch（解码确实发生在这里的上游）。单独分一支是必要的：
     * 通用的那一支只转发原始 message，而这里要的是**换一句话**。
     */
    if (isNonUtf8TextFailure(error)) {
      return {
        ok: false,
        error: nonUtf8RefusalMessage('read', resolvedOrRaw(provider, file), 'aura_basetools_read'),
        code: typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'FS_NOT_TEXT',
        ...errorEvidence(error),
      }
    }
    return {
      ok: false,
      error: String(error?.message ?? error),
      code: error?.code ?? 'IO_ERROR',
      ...errorEvidence(error),
    }
  }
}

/** 改一次（规划 → 陈旧闸门 → 逐字节写 + CAS → 回读校验 → 刷新观测）。 */
async function editEnvelopeInner(provider, { file, hunks, dryRun, create, requireObservation, wholeFile, eol, skipStaleGate, toolName = 'aura_basetools_edit' }) {
  try {
    const result = await applyEditToProvider(provider, {
      displayPath: provider.resolve(file),
      hunks: hunks ?? [],
      dryRun: dryRun === true,
      ...(requireObservation === true ? { requireObservation: true } : {}),
      ...(typeof wholeFile === 'string' ? { wholeFile } : {}),
      ...(typeof eol === 'string' ? { eol } : {}),
      ...(skipStaleGate === true ? { skipStaleGate: true } : {}),
      ...(typeof create === 'string' ? { create } : {}),
    })
    return { ok: true, result }
  } catch (error) {
    /**
     * C55：写路径上的非 UTF-8 同样要可执行。它抛在引擎 `applyEditToProvider` 的第一步
     * （读不到文本就无法规划 hunk），因此**磁盘上什么都没发生过**——回执里那句
     * 「nothing was written」在写侧不是承诺，而是这条路上不可能有写。
     */
    if (isNonUtf8TextFailure(error)) {
      return {
        ok: false,
        error: nonUtf8RefusalMessage('patch', resolvedOrRaw(provider, file), toolName),
        code: typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'FS_NOT_TEXT',
        ...errorEvidence(error),
      }
    }
    return {
      ok: false,
      error: String(error?.message ?? error),
      code: error?.code ?? 'IO_ERROR',
      ...errorEvidence(error),
    }
  }
}

/**
 * **多目标写在独立面上的信封**：转发引擎入口，并补一个“整批成没成”的位。
 *
 * 为什么这个位必须在**这里**补（而不是在 `bin/` 里各算一份）：引擎的写侧批回执
 * （`mtEnvelope`）刻意没有 `ok` —— DSH 壳那边由框架自己的结果形状表达，而 CLI/MCP 要的是
 * 一个能接退出码与 `isError` 的布尔位。两个 bin 各写一遍“哪些 outcome 算成”必然漂开，
 * 而漂开的方向恰好是“CLI 说成了、MCP 说没成”这种没人会发现的分叉。
 *
 * “成”的判据用的是引擎自己的 outcome 词表（`write-path.mjs` 的 `receiptKindOf` / `failureItem`）：
 *   · `applied` / `created` / `already_applied` / `dry_run` —— 成了（`dry_run` 是“按你说的没写”，
 *     不是失败）；
 *   · `failed` / `not_applied` —— 没成（`not_applied` 只在同一批里别的目标规划失败时出现，
 *     契约 §3.4：“要么全改、要么一个字节不动”）。
 *
 * 逐项与汇总行**一个字都不动**（`ok` 加在信封最前面，与读侧引擎自己的字段顺序对齐）：
 * 引擎怎么算的就怎么回，本函数只补那一个位。
 *
 * @param provider - 与单目标同一条 provider 契约（`stat/readText/readByteRange/writeText`）
 * @param request - `{ targets: [...], dryRun?, identityKey?, signal? }`
 * @returns 引擎的批回执 + `ok`
 */
async function editManyEnvelopeInner(provider, request) {
  const batch = await applyEditsToProvider(provider, request)
  const ok = batch.edits.every((edit) => edit.outcome !== 'failed' && edit.outcome !== 'not_applied')
  return { ok, ...batch }
}

function transactionError(error) {
  return {
    ok: false,
    error: String(error?.message ?? error),
    code: error?.code ?? 'IO_ERROR',
    ...errorEvidence(error),
  }
}

const VERIFY_OUTPUT_LIMIT = 4000
const tailText = (value) => {
  const text = String(value ?? '')
  return text.length <= VERIFY_OUTPUT_LIMIT ? text : `…${text.slice(-VERIFY_OUTPUT_LIMIT)}`
}

/**
 * 写后验证：**只在调用方显式给出命令时**执行。
 *
 * 不是自动发现仓库脚本，也不绕过沙箱/权限；命令在 workspace 根下跑，有超时与输出上限。
 * 失败由外层事务回滚，调用方拿到的是可判定的 `PATCH_VERIFY_FAILED`，不是“写完再说”。
 */
function runVerification(command, cwd) {
  const timeout = Math.min(600000, Math.max(1000, Number(process.env.AURA_VERIFY_TIMEOUT_MS) || 120000))
  const started = Date.now()
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
    windowsHide: true,
  })
  const timedOut = res.error?.code === 'ETIMEDOUT'
  return {
    command,
    cwd,
    ok: res.status === 0 && res.error === undefined,
    exitCode: res.status,
    signal: res.signal ?? null,
    timedOut,
    durationMs: Date.now() - started,
    stdout: tailText(res.stdout),
    stderr: tailText(res.stderr),
    ...(res.error === undefined ? {} : { error: String(res.error.message ?? res.error) }),
  }
}

async function editInTransaction(provider, request) {
  const verifyCommand = typeof request.verify === 'string' && request.verify.trim().length > 0 ? request.verify.trim() : null
  try {
    return await withWorkspaceLock(provider.root, async () => {
      const tx = openTransaction(provider.root, request.transaction)
      const env = await editEnvelopeInner(tx.proxy(provider), request)
      if (!env.ok) return env
      let verification
      if (verifyCommand !== null) {
        verification = runVerification(verifyCommand, provider.root)
        if (!verification.ok) {
          const rollback = await tx.rollback(provider)
          return {
            ok: false,
            code: 'PATCH_VERIFY_FAILED',
            error: `edit verification failed (exit ${verification.exitCode ?? 'no-status'}${verification.timedOut ? ', timed out' : ''}): ${verifyCommand}`,
            verification,
            rollback,
            transaction: tx.summary(),
          }
        }
      }
      return { ...env, transaction: tx.summary(), ...(verification === undefined ? {} : { verification }) }
    })
  } catch (error) {
    return transactionError(error)
  }
}

async function editManyInTransaction(provider, request) {
  const verifyCommand = typeof request.verify === 'string' && request.verify.trim().length > 0 ? request.verify.trim() : null
  try {
    return await withWorkspaceLock(provider.root, async () => {
      const tx = openTransaction(provider.root, request.transaction)
      const batch = await editManyEnvelopeInner(tx.proxy(provider), request)
      if (!batch.ok) return batch
      let verification
      if (verifyCommand !== null) {
        verification = runVerification(verifyCommand, provider.root)
        if (!verification.ok) {
          const rollback = await tx.rollback(provider)
          const finalBatch = writePath.rebuildAfterRollback(batch, rollback)
          return {
            ...finalBatch,
            ok: false,
            code: 'PATCH_VERIFY_FAILED',
            error: `edit verification failed (exit ${verification.exitCode ?? 'no-status'}${verification.timedOut ? ', timed out' : ''}): ${verifyCommand}`,
            verification,
            rollback,
            transaction: tx.summary(),
          }
        }
      }
      return { ...batch, transaction: tx.summary(), ...(verification === undefined ? {} : { verification }) }
    })
  } catch (error) {
    return transactionError(error)
  }
}

/**
 * 写事务外壳：workspace 锁 + 事务日志 + 失败回滚。
 *
 * 锁只约束遵守本协议的 Aura 进程；事务日志在第一次 writeText 前记原始字节，
 * 失败时按 afterVersion 检查后恢复。不改变引擎的规划/寻址语义。
 */
export async function editEnvelope(provider, request) {
  // 事务需要工作区根与真实文件系统；测试/嵌入式 provider 没有 root 时保持原来的引擎行为。
  if (provider.root === undefined) return editEnvelopeInner(provider, request)
  /**
   * 预演不建事务、不写盘，也不需要工作区锁；0.14.0 起事务日志只用于失败回滚。
   */
  if (request.dryRun === true) return editEnvelopeInner(provider, request)
  if (typeof request.transaction === 'string' && request.transaction.length > 0) return editInTransaction(provider, request)
  const verifyCommand = typeof request.verify === 'string' && request.verify.trim().length > 0 ? request.verify.trim() : null
  try {
    return await withWorkspaceLock(provider.root, async () => {
      const tx = createTransaction(provider.root, 'aura_basetools_edit')
      const env = await editEnvelopeInner(tx.proxy(provider), request)
      if (env.ok) {
        if (verifyCommand !== null) {
          const verification = runVerification(verifyCommand, provider.root)
          if (!verification.ok) {
            const rollback = await tx.rollback(provider)
            return {
              ok: false,
              error: `edit verification failed (exit ${verification.exitCode ?? 'no-status'}${verification.timedOut ? ', timed out' : ''}): ${verifyCommand}`,
              code: 'PATCH_VERIFY_FAILED',
              verification,
              rollback,
            }
          }
          try {
            tx.commit()
          } catch (error) {
            const rollback = await tx.rollback(provider)
            error.transaction = tx.summary()
            error.rollback = rollback
            throw error
          }
          return { ...env, verification }
        }
        try {
          tx.commit()
        } catch (error) {
          const rollback = await tx.rollback(provider)
          error.transaction = tx.summary()
          error.rollback = rollback
          throw error
        }
        return env
      }
      await tx.rollback(provider)
      return env
    })
  } catch (error) {
    return transactionError(error)
  }
}

/** 多目标写事务：与单目标共用锁/日志/回滚；批次返回 ok=false 时也回滚。 */
export async function editManyEnvelope(provider, request) {
  if (provider.root === undefined) return editManyEnvelopeInner(provider, request)
  // 与单目标同一条：预演不建事务、不写盘，不能顶掉真正的最近 committed 事务。
  if (request.dryRun === true) return editManyEnvelopeInner(provider, request)
  if (typeof request.transaction === 'string' && request.transaction.length > 0) return editManyInTransaction(provider, request)
  const verifyCommand = typeof request.verify === 'string' && request.verify.trim().length > 0 ? request.verify.trim() : null
  try {
    return await withWorkspaceLock(provider.root, async () => {
      const tx = createTransaction(provider.root, 'aura_basetools_edit')
      try {
        const batch = await editManyEnvelopeInner(tx.proxy(provider), request)
        if (batch.ok) {
          if (verifyCommand !== null) {
            const verification = runVerification(verifyCommand, provider.root)
            if (!verification.ok) {
              const rollback = await tx.rollback(provider)
              const finalBatch = writePath.rebuildAfterRollback(batch, rollback)
              return {
                ...finalBatch,
                ok: false,
                code: 'PATCH_VERIFY_FAILED',
                error: `edit verification failed (exit ${verification.exitCode ?? 'no-status'}${verification.timedOut ? ', timed out' : ''}): ${verifyCommand}`,
                verification,
                rollback,
              }
            }
            try {
              tx.commit()
            } catch (error) {
              const rollback = await tx.rollback(provider)
              error.transaction = tx.summary()
              error.rollback = rollback
              throw error
            }
            return { ...batch, verification }
          }
          try {
            tx.commit()
          } catch (error) {
            const rollback = await tx.rollback(provider)
            error.transaction = tx.summary()
            error.rollback = rollback
            throw error
          }
          return batch
        }
        const rollback = await tx.rollback(provider)
        const finalBatch = writePath.rebuildAfterRollback(batch, rollback)
        return {
          ...finalBatch,
          ok: false,
        }
      } catch (error) {
        const rollback = await tx.rollback(provider)
        error.transaction = tx.summary()
        error.rollback = rollback
        throw error
      }
    })
  } catch (error) {
    return transactionError(error)
  }
}

/** 开一个跨调用事务；后续 `edit --tx <id>` 写在同一份日志里。 */
export function beginTransactionEnvelope(provider) {
  if (provider.root === undefined) return { ok: false, error: 'transactions need a workspace root', code: 'TX_NO_ROOT' }
  try {
    const tx = createTransaction(provider.root, 'aura_basetools_tx')
    return { ok: true, transaction: tx.summary() }
  } catch (error) {
    return transactionError(error)
  }
}

/** 提交跨调用事务：先做 afterVersion 乐观校验，再跑可选 verify；失败自动 rollback。 */
export async function commitTransactionEnvelope(provider, { id, verify } = {}) {
  if (provider.root === undefined) return { ok: false, error: 'transactions need a workspace root', code: 'TX_NO_ROOT' }
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'commit needs a transaction id', code: 'TX_BAD_ID' }
  const verifyCommand = typeof verify === 'string' && verify.trim().length > 0 ? verify.trim() : null
  try {
    return await withWorkspaceLock(provider.root, async () => {
      const tx = openTransaction(provider.root, id)
      const conflicts = tx.assertFresh(provider)
      if (conflicts.length > 0) {
        return {
          ok: false,
          code: 'TX_STALE',
          error: `transaction ${id} has ${conflicts.length} file(s) changed since the transaction wrote them`,
          conflicts,
          transaction: tx.summary(),
        }
      }
      let verification
      if (verifyCommand !== null) {
        verification = runVerification(verifyCommand, provider.root)
        if (!verification.ok) {
          const rollback = await tx.rollback(provider)
          return {
            ok: false,
            code: 'PATCH_VERIFY_FAILED',
            error: `transaction verification failed (exit ${verification.exitCode ?? 'no-status'}${verification.timedOut ? ', timed out' : ''}): ${verifyCommand}`,
            verification,
            rollback,
            transaction: tx.summary(),
          }
        }
      }
      tx.commit()
      return { ok: true, transaction: tx.summary(), ...(verification === undefined ? {} : { verification }) }
    })
  } catch (error) {
    return transactionError(error)
  }
}

/** 回滚跨调用事务：与内部失败回滚同一套 afterVersion 校验。 */
export async function rollbackTransactionEnvelope(provider, { id } = {}) {
  if (provider.root === undefined) return { ok: false, error: 'transactions need a workspace root', code: 'TX_NO_ROOT' }
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'rollback needs a transaction id', code: 'TX_BAD_ID' }
  try {
    return await withWorkspaceLock(provider.root, async () => {
      const tx = openTransaction(provider.root, id)
      const rollback = await tx.rollback(provider)
      return { ok: rollback.status === 'rolled_back', rollback, transaction: tx.summary() }
    })
  } catch (error) {
    return transactionError(error)
  }
}

/** 只读事务状态。 */
export function statusTransactionEnvelope(provider, { id } = {}) {
  if (provider.root === undefined) return { ok: false, error: 'transactions need a workspace root', code: 'TX_NO_ROOT' }
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'status needs a transaction id', code: 'TX_BAD_ID' }
  try {
    const meta = getTransactionMeta(provider.root, id)
    return { ok: true, transaction: { id: meta.id, status: meta.status, files: meta.files.length, written: meta.files.filter((f) => f.written).length, dir: meta.dir } }
  } catch (error) {
    return transactionError(error)
  }
}

/** 整文件写的紧凑回执：不把整份 old/new 文本塞进 applied（那是 edit 的形状，不是 write 的）。 */
function compactWriteReceipt(env, content) {
  if (env === null || typeof env !== 'object' || env.ok !== true) return env
  const result = env.result ?? {}
  const dryRun = result.dryRun === true
  /**
   * 覆写预演没有落盘，也没有回读字节数；此时 `content` 的长度可能不等于最终字节数
   * （整份写会把 content 的换行适配成文件已有风格，CRLF 每行多一个字节）。
   * 宁可**不报** bytes，也不报一个预演后必然对不上的数。新建预演不需要适配，照报。
   */
  const bytes = result.write_verify?.bytes ?? (dryRun && result.operation === 'create' ? Buffer.byteLength(content, 'utf8') : undefined)
  return {
    ok: true,
    ...(env.verification === undefined ? {} : { verification: env.verification }),
    result: {
      path: result.path,
      operation: result.operation ?? 'write',
      ...(bytes === undefined ? {} : { bytes }),
      dryRun,
      ...(result.write_verify === undefined ? {} : { write_verify: result.write_verify }),
      ...(result.unverified_region === true ? { unverified_region: true } : {}),
    },
  }
}

/**
 * 0.10.1：整文件写（内置 `Write` 的替代）。
 *
 * 新建与覆写都走 `editEnvelope`：同一把工作区锁、同一份事务日志、同一套回读校验。
 * 覆写用“整文件行区间（含末尾那个空行）+ `eol: auto`”表达：行区间覆盖到文件末尾，
 * 于是 content 自己的**有无尾换行**被精确保留，而 content 内的换行统一成文件已有的风格
 * （与内置 Edit 对多行替换的处理一致）。已有的 BOM 也照旧保留。
 *
 * **覆写默认要求先读过这版内容**（`PATCH_UNOBSERVED`），与内置 `Write` 的 read-before-write
 * 同一条；`allowUnobserved` 是显式逃生口（回执照实标 `unverified_region`）。
 * 新建不受这条约束。
 *
 * `eol` 只对覆写有意义：`auto`（默认）把 content 的新行适配成文件已有风格，
 * `preserve` 按 content 原样写（与内置 Write 的“给什么写什么”对齐），`lf` / `crlf` 强制统一。
 * 新建文件永远按 content 原样写；显式传非 `auto` 的 eol 会被拒绝（不做静默忽略）。
 */
export async function writeEnvelope(provider, { file, content, dryRun = false, noOverwrite = false, allowUnobserved = false, eol = 'auto', verify, transaction } = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    return { ok: false, error: 'write needs a file path', code: 'WRITE_BAD_ARGS' }
  }
  if (typeof content !== 'string') {
    return { ok: false, error: 'write needs `content` as a string', code: 'WRITE_BAD_ARGS' }
  }
  if (!['auto', 'preserve', 'lf', 'crlf'].includes(eol)) {
    return { ok: false, error: 'write `eol` must be auto, preserve, lf, or crlf', code: 'WRITE_BAD_ARGS' }
  }
  try {
    const displayPath = provider.resolve(file)
    const info = provider.stat(displayPath)
    if (info !== undefined && noOverwrite) {
      return { ok: false, error: `cannot write "${displayPath}": it already exists (no-overwrite)`, code: 'WRITE_EXISTS' }
    }
    if (info === undefined) {
      if (eol !== 'auto') {
        return {
          ok: false,
          error: 'write `eol` applies when overwriting an existing file; a new file is written exactly as given — pass the endings you want in `content`',
          code: 'WRITE_BAD_ARGS',
        }
      }
      if (dryRun) {
        return { ok: true, result: { path: displayPath, operation: 'create', bytes: Buffer.byteLength(content, 'utf8'), dryRun: true } }
      }
      return compactWriteReceipt(await editEnvelope(provider, { file, create: content, verify, transaction }), content)
    }
    return compactWriteReceipt(
      await editEnvelope(provider, {
        file,
        wholeFile: content,
        eol,
        dryRun,
        requireObservation: allowUnobserved !== true,
        skipStaleGate: allowUnobserved === true,
        toolName: 'aura_basetools_write',
        verify,
        transaction,
      }),
      content,
    )
  } catch (error) {
    return transactionError(error)
  }
}
