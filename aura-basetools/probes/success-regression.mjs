/**
 * success-regression.mjs —— R2：新契约有没有把**原本成功**的编辑打坏？
 *
 * ## 它回答什么问题
 *
 * 蓝图 fs-contract-v2 的前几波只测了**失败集**（`locator-lab/failure-corpus.json`，450 条，
 * 全是历史失败）。一个只修好 153 条失败、却打坏 500 条成功的契约，是净亏 —— 而真实的
 * **成功集**（会话日志里数出的 9466 次成功 `aura_edit`）从没被重放过。本探针补这一格：
 * 把历史成功的调用**原参数原样**喂给两套引擎，看新契约是否把它们弄失败。
 *
 * ## 与失败集夹具的三个关键差别（决定了这份探针不能照抄它）
 *
 *   1. **入参不改写**。`failure-replay.mjs` 的「新契约」列会把历史 hunk 改写成 `old`+`context`
 *      再跑，量的是「新寻址能不能表达同一次编辑」。本探针两列都跑**原参数**——历史调用方
 *      当年写的是什么就喂什么。量的是「同一个调用在新引擎下还成不成」，也就是回归本身。
 *      代价：这会把「新契约要求改写才生效」的那些算成失败。这是有意的，明写在表头。
 *   2. **语料是成功集**。判定口径是会话日志里 `tool/result` 的 `isError === false`，
 *      不靠回执文本正则（那会把「回执里恰好写着 Error」的成功算成失败）。
 *   3. **原文来自编辑之前的那次读**。成功调用的文件在调用之后就被改了，所以「当时的原文」
 *      只能取**同会话此前**对同一路径的 `aura_read` 回执里的 `行号: 正文`。提取口径见 §2。
 *
 * ## 语料怎么建（三步，全部可复算）
 *
 *   · **扫描**：`C:\Users\cxk\.dsh\sessions\**\session.v3.jsonl.zstd`。这是 zstd **多帧流**，
 *     整体解压只能得到会话头，必须按 magic `28 B5 2F FD` 切帧逐帧解 —— §0 从
 *     `tmp/session-log-scan/zstd-read.mjs` 照抄（那份文件不动；抄一份是为了不让探针依赖 tmp/）。
 *   · **重建原文**：按路径累积该会话里所有 `aura_read` 回执的行号快照，用回执首行的
 *     `version: <hash>:<chars>` 令牌当**同一份内容的凭据**：令牌相同 ⇒ 两次读的是同一份文件，
 *     行号可以合并；令牌不同 ⇒ 文件变了，快照作废、从新那次重新累积。成功编辑后再把它清掉
 *     （文件已经变了）。取不到覆盖受寻址区间的快照 ⇒ 标 drifted **排除**，并记原因。
 *   · **分层抽样**：`定位器种类 × 文件大小档` 为层，层内按扩展名轮转 + 等距取样（确定性，
 *     不掷骰子：同样输入永远抽出同一批条目）。抽样在**可重建池**上做，不是在全部成功调用上。
 *
 * ## 哪些会话不进扫描（否则分母会随「什么时候跑」而变）
 *
 *   · **正在写日志的那个会话**（`DSH_SESSION_ID` 对应的目录）：本探针自己就在里面落盘；
 *   · **最近 `--stale-minutes`（默认 20）分钟内还被写过的会话文件**：本轮是并行测量（R1–R5
 *     同时在跑），那些日志正在被追加。
 * 实测：不排这两类，同一个探针连跑两次给出 Z=3 与 Z=7；排掉之后，只要 `--until` 相同，
 * 两次输出逐字相同（只差耗时与 pid）。复算请把 `--until=<毫秒>` 一起抬上。
 *
 * ## 两列各是什么（同一份重建原文、同一批原始入参）
 *
 *   · **冻结基准**：仓库内一份**只读夹具** `aura-tools/fixtures/frozen-engine-0.6.1-217798da/`
 *     ——逐字节等于升级前那一份现网（构建戳 0.6.1+217798da5117），而且**不在升级路径上**。
 *     原来读的是安装副本 `C:\Users\cxk\.aura\pkg\node_modules\aura-tools`，而那正是升级要覆盖的
 *     目标：波 8 把它刷新成现树之后，基准列与现树列当场同源（`previous/` 也不行——它是
 *     `--rollback` 的对调目标）。跑在**独立子进程**里，import 的是夹具自己的 `locator-lab` 模块
 *     （`loadFrozenEngine` 借自 `failure-replay.mjs`，只读引用，一个字节都不写）。
 *     它答的是「改动前，这条调用在这份原文上是什么下场」。
 *     夹具缺了 / 被改过 / 被换成现树，本条判据当场变红并点名（见 §5 的那三条），**不静默退化**。
 *   · **现树新契约**：同一份原文、同一批原始入参交给当前工作树的 `planHunks`。
 *     它答的是「今天这条调用还成不成」。
 *   · **第三栏（结果一致性）**：两列都通过时，比两边**改出来的内容**的 sha256_16。
 *     只比 ok/fail 会漏掉一类更坏的回归：两列都说「成了」，改出来的文件却不同
 *     （蓝图里已有同性质的已知例：行内片段兜底吞掉 `const ` 前缀）。它是读数不是判据。
 *   · 两列都**只到引擎入口**（`planHunks`），不落盘：探针把重建原文写成临时目录里的副本，
 *     语料里的路径从不被当作可写目标。三态判定见 §4。
 *
 * ## 已知盲区（已量化，不要当它不存在）
 *
 * 重建原文只有「读过的那些行」，没读到的部分是空行占位。空行不匹配任何非空引文，
 * 所以盲区只会让「全文唯一吗」这个判断**偏宽松**（把真文件上本该 `needs_choice` 的当成唯一命中）。
 * 反方向不受影响：快照是真文件的**子集**，在快照里就重复的引文在真文件里必定重复 ——
 * 所以「expect 不唯一 ⇒ 拒绝」这类转失败是**可信**的，而「applied」是**上界**。
 * 探针 §⑧ 把这个盲区量成数：拿引擎自己的 `expectVerdict` 数同一条引文在重建原文与今天磁盘文件上的处数。
 *
 * ## 「成功语料」这四个字自带偏差（必须一起读）
 *
 * 历史成功集是被**旧契约筛过**的样本：旧契约拒绝的调用不会出现在里面。所以本探针算不出
 * 「新契约的整体报错率」，只能算「在旧契约过得去的那批调用里，新契约过不去的比例」。
 * 这个偏差的方向是**低估回归**：旧契约过不去的那批（占历史 19%）里，凡是靠新契约才成立、
 * 又在别的形状上被新契约弄坏的，一条也进不了这里的分母。
 *
 * 用法：
 *   node aura-tools/probes/success-regression.mjs                     # 跑全量（默认）
 *   node aura-tools/probes/success-regression.mjs --sessions=40       # 只扫前 40 个会话文件（快，开发用）
 *   node aura-tools/probes/success-regression.mjs --sample=200 --show=20
 *   node aura-tools/probes/success-regression.mjs --json              # 附机器可读统计
 *
 * 支持的旗标共八个（**唯一一份**在下面 FLAGS；后四个从前只活在代码里，这里补齐）：
 *   --sample=N            抽样条数（默认 900，层内配额按它分）
 *   --sessions=N          只扫前 N 个会话文件（开发用；与第三方对账的那条判据随之跳过）
 *   --show=N              只打印前 N 条转失败明细（默认 0 = 全部）
 *   --json                附机器可读统计
 *   --corpus-out=PATH     语料落点（默认落在临时目录）
 *   --no-corpus           不写语料文件
 *   --until=<epoch-ms|ISO> 时间窗上端（两种形式都收；默认 = 现在）
 *   --stale-minutes=N     最近 N 分钟还在写的会话文件排除（默认 20）
 * **任何别的东西当场拒收**：点名那个旗标 + 列出支持集 + exit 2，且不扫日志、不重放、不写语料 ——
 * 从前 `parseArgv` 是 `if / else if` 链且**没有最后的 else**，于是 `--untill=…` 这样的错字被丢在地上，
 * 跑出来的是一份**默认窗口**的、看着完全正常的读数（exit 0）—— 而本探针的读数是要当验收证据用的。
 * 退出码：0 = 判据全绿 ｜ 1 = 有判据红 ｜ 2 = 用法错（未知旗标 / 旗标值不合形）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { pkgPath } from '../build/pkg-root.mjs'

import { planHunks } from '../src/locator-lab/write-path.mjs'
import { lineRangeOf, flatHunk } from '../src/locator-lab/args.mjs'
import { normSpace } from '../src/locator-lab/anchor-core.mjs'
// 盲区量化（主流程 §⑧）直接调用引擎**自己那份**唯一性判据，不另写一份计数。
import { expectVerdict, ASSERT_RELAX_MIN_CHARS } from '../src/locator-lab/locator-api.mjs'
// 三态 outcome 的**名字**从壳层 import（唯一一份）；码到态的判决表从壳层源码里解析（§4）。
import { OUTCOMES } from '../src/aura-edit/index.js'
/**
 * 冻结基准借自 C11 夹具的两样：
 *   · `frozenEngineDigests` 父进程自己算一份夹具摘要（与子进程报回的比对）；
 *   · `inspectFrozenFixture` 夹具自检（缺了 / 对不上清单 / 被换成现树，三种分开点名）；
 *   · `FROZEN_BASELINE_ROOT` 夹具根 —— 两个探针指向同一份字节，不可能各指各的；
 *   · `loadFrozenEngine` 只在子进程里用 —— 父进程不直接引用它，免得两列跑在同一份模块实例上。
 */
import { frozenEngineDigests, inspectFrozenFixture, FROZEN_BASELINE_ROOT } from '../src/locator-lab/failure-replay.mjs'

// ── 0. zstd 多帧读取（照抄 tmp/session-log-scan/zstd-read.mjs，那份文件不动） ──

const ZSTD_MAGIC = 0xfd2fb528
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SKIP_BASE = 0x184d2a50

function frameLength(buf, off) {
  let p = off + 4
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictIdFlag = fhd & 3
  if (!singleSegment) p += 1
  p += [0, 1, 2, 4][dictIdFlag]
  let fcsSize = [0, 2, 4, 8][fcsFlag]
  if (fcsFlag === 0 && singleSegment) fcsSize = 1
  p += fcsSize
  for (;;) {
    const bh = buf.readUIntLE(p, 3)
    p += 3
    const last = bh & 1
    const btype = (bh >> 1) & 3
    const bsize = bh >> 3
    if (btype === 0 || btype === 2) p += bsize
    else if (btype === 1) p += 1
    else throw new Error(`reserved block type at ${p - 3}`)
    if (last) break
  }
  if (checksum) p += 4
  return p - off
}

/**
 * 逐帧解压、逐行吐出。
 *
 * 为什么不先拼成一个大字符串再 split：全量会话日志 572 MB，解出来是 1.7 GB 文本，
 * 一次拿在手里会把内存打满；而按帧吐行是流式的，峰值只有一帧。**跨帧的半行要留着**
 * （`carry`）——一行的 JSON 事件理论上可以横跨两次追加，拼不回去就会静默丢掉一条调用。
 */
function* sessionLines(file) {
  const buf = fs.readFileSync(file)
  let off = 0
  let carry = ''
  while (off + 4 <= buf.length) {
    const word = buf.readUInt32LE(off)
    if (word === ZSTD_MAGIC) {
      let len
      try {
        len = frameLength(buf, off)
      } catch {
        break
      }
      let text = ''
      try {
        text = zstdDecompressSync(buf.subarray(off, off + len)).toString('utf8')
      } catch {
        text = '' // 坏帧忽略（日志尾部可能是半帧）
      }
      off += len
      if (text.length === 0) continue
      const parts = (carry + text).split('\n')
      carry = parts.pop() ?? ''
      yield* parts
    } else if ((word & 0xfffffff0) === SKIP_BASE) {
      off += 8 + buf.readUInt32LE(off + 4)
    } else {
      const next = buf.indexOf(ZSTD_MAGIC_BYTES, off + 1)
      if (next < 0) break
      off = next
    }
  }
  if (carry.length > 0) yield carry
}

// ── 1. 常量与写范围 ──

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
export const SESSIONS_ROOT = process.env.AURA_SESSIONS_ROOT ?? 'C:\\Users\\cxk\\.dsh\\sessions'
/**
 * 冻结基准的夹具根：**不在升级路径上**，所以不随升级漂移。
 * 路径只有一处来源 —— `failure-replay.mjs` 导出的 `FROZEN_BASELINE_ROOT`（两个探针指向同一份
 * 字节，不可能各指各的）。只读引用（读模块、算摘要、拍快照），不写一个字节。
 */
const FROZEN_ENGINE_MODULES = ['write-path.mjs', 'read-core.mjs', 'locator-api.mjs']
/** 独立对账用：第三方解析器数出来的逐次调用表（本探针不依赖它，存在才比）。 */
const CROSS_CHECK_CSV = path.join(REPO, 'tmp/session-log-scan/out/aura-calls.csv')
/** 冻结基准的装载器所在模块：子进程按这个 URL import 它（`loadFrozenEngine` 的唯一一份实现）。 */
const FROZEN_FIXTURE_URL = new URL('../src/locator-lab/failure-replay.mjs', import.meta.url).href

/** 重建原文的体积上限。超了不截断而是排除 —— 截断会把「唯一不唯一」这类语义悄悄改掉。 */
const SOURCE_CAP = 150000
const RANGE_SPAN_CAP = 2000
const SCAFFOLD_MAX_LINES = 60000
/** 抽样目标（分层后条数）。判据要求 ≥500，留了余量：抽样里会有几条在基准列上不 ok。 */
const SAMPLE_TARGET = 900
const SAMPLE_FLOOR = 12 // 每个非空层至少抽这么多（保证长尾层也被覆盖到）

/** 覆盖率分档（快照真字符数 / 当时的整份文件字符数）。 */
const COVERAGE_BANDS = [
  ['≥ 0.9', (c) => c !== null && c >= 0.9],
  ['0.5 ~ 0.9', (c) => c !== null && c >= 0.5 && c < 0.9],
  ['< 0.5', (c) => c !== null && c < 0.5],
  ['未知', (c) => c === null],
]

const SIZE_BUCKETS = [
  ['small', 0, 4096],
  ['medium', 4096, 32768],
  ['large', 32768, Infinity],
]

const EXT_BUCKETS = [
  ['js', ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']],
  ['py', ['.py', '.pyi']],
  ['doc', ['.md', '.txt', '.rst']],
  ['data', ['.json', '.jsonl', '.yml', '.yaml', '.toml', '.ini', '.csv']],
  ['shell', ['.ps1', '.sh', '.cmd', '.bat', '.psm1']],
  ['web', ['.html', '.css', '.scss', '.vue', '.svelte']],
]

// ── 2. 日志解析（会话 → 成功编辑候选） ──

function walkSessions(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkSessions(p, out)
    else if (e.name === 'session.v3.jsonl.zstd') out.push(p)
  }
  return out.sort()
}

/**
 * 工具参数：日志里是**字符串化的 JSON**。解析不了就记 null（不猜）——
 * 猜出来的参数会让一条本该被排除的调用悄悄进语料。
 */
function argsOf(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 回执正文：形状是 `part.content[].text`（嵌套一层），顶层 `part.text` 也收（防形状再变）。 */
export function receiptTextOf(parts) {
  const textOf = (part) => {
    const own = typeof part?.text === 'string' ? part.text : ''
    const nested = Array.isArray(part?.content)
      ? part.content.map((inner) => (typeof inner?.text === 'string' ? inner.text : '')).filter((t) => t.length > 0)
      : []
    return [own, ...nested].filter((t) => t.length > 0).join('\n')
  }
  return parts.map(textOf).filter((t) => t.length > 0).join('\n')
}

function cwdOf(text) {
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  if (m === null) return null
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return null
  }
}

/** 会话里的 cwd：不整份解压，取第一帧里出现的那个（每个会话只有一个 cwd）。 */
function cwdOfFile(file) {
  const it = sessionLines(file)
  let seen = 0
  for (const line of it) {
    if (!line.includes('"cwd"')) continue
    const cwd = cwdOf(line)
    if (cwd !== null) return cwd
    seen += 1
    if (seen > 50) break
  }
  return null
}

/**
 * `aura_read` 回执的正文是 `行号: 正文`，按行号收起来就是**当时那份文件的局部快照**。
 *
 * 只认行首裸数字后面跟冒号的行 —— 信封、符号目录（`★ function …  12-30`）、省略说明都不长这样。
 * 这正是选「宁可少收，不可收错行」的理由：把符号目录里一行数字当成正文，会凭空造出原文。
 * 首行的 `version: <hash>:<chars>` 一并留下：`<chars>` 是整份文件的字符数（实测与 map 模式
 * 回执里写的 "180 lines, 13422 chars" 逐字相同），`<hash>` 是内容凭据（见 §3 的合并规则）。
 */
function lineMapFromReceipt(text) {
  const map = new Map()
  const lines = String(text ?? '').split('\n')
  const head = /^version:\s*(\S+)/.exec(lines[0] ?? '')
  const version = head ? head[1] : null
  let fileChars = null
  if (version !== null) {
    const c = /:(\d+)$/.exec(version)
    if (c) fileChars = Number(c[1])
  }
  for (let i = 1; i < lines.length; i += 1) {
    const g = /^(\d+): ?([\s\S]*)$/.exec(lines[i])
    if (!g) continue
    const n = Number(g[1])
    if (!Number.isInteger(n) || n < 1) continue
    if (!map.has(n)) map.set(n, g[2])
  }
  return { map, version, fileChars }
}

function resolvePath(cwd, p) {
  if (typeof p !== 'string' || p.trim().length === 0) return null
  try {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd ?? process.cwd(), p)
    return path.normalize(abs)
  } catch {
    return null
  }
}

const pathKey = (p) => p.replace(/\//g, '\\').toLowerCase()

/** 一次调用要搬的 hunk 数组：`args.hunks`，或扁平写法（与 `planHunks` 的入口同形）。 */
export function hunksOf(args) {
  if (Array.isArray(args?.hunks)) return args.hunks.filter((h) => h && typeof h === 'object')
  const flat = flatHunk(args)
  return flat ? [flat] : []
}

const ADDRESS_KEYS = ['anchor', 'line_cue', 'target']

/** 定位器种类（按 hunk 里实际用的地址键，取该调用里最主要的那个）。 */
function locatorKindOf(hunks) {
  const kinds = new Set()
  for (const h of hunks) {
    if (lineRangeOf(h) !== undefined) kinds.add('lines')
    for (const k of ADDRESS_KEYS) if (typeof h[k] === 'string' && h[k].length > 0) kinds.add(k)
  }
  for (const k of ['lines', 'anchor', 'line_cue', 'target']) if (kinds.has(k)) return k
  return 'none'
}

const extOf = (file) => path.extname(file ?? '').toLowerCase()
function extBucketOf(file) {
  const ext = extOf(file)
  for (const [name, exts] of EXT_BUCKETS) if (exts.includes(ext)) return name
  return 'other'
}
function sizeBucketOf(chars) {
  for (const [name, lo, hi] of SIZE_BUCKETS) if (chars >= lo && chars < hi) return name
  return 'large'
}

/**
 * 单次会话扫描：把「成功的 aura_edit」连同**当时可用的原文快照**一起抽出来。
 *
 * 快照按路径累积，凭据是回执首行的 version 令牌：
 *   · 令牌相同 ⇒ 两次读的是同一份文件，行号可以并集（覆盖率越高，「唯一不唯一」这类
 *     整份文件语义才越接近真实）；
 *   · 令牌不同 ⇒ 文件在这两次读之间变过，旧快照作废，从新那次重新累积；
 *   · 成功编辑之后 ⇒ 文件已经变了，把该路径的快照清掉（下一条调用要用新的读）。
 * 这条规则比「只取紧邻的那一次读」强：它既拿到了更大的覆盖，又不会把两个版本的行拼在一起。
 */
function scanSession(file, sessionsRoot, tally, pool) {
  const cwd = cwdOfFile(file)
  const dir = path.basename(path.dirname(file))
  const byId = new Map()
  const claimed = new Set()
  const state = new Map() // pathKey -> { map, version, fileChars }
  let index = 0

  for (const line of sessionLines(file)) {
    if (!line.includes('"tool/')) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'tool/call') {
      const name = ev.data?.name
      if (typeof name !== 'string') continue
      const callId = ev.data?.callId
      const rec = { name, args: argsOf(ev.data?.arguments), index: index++, id: callId, t: ev.time ?? null }
      if (typeof callId === 'string') byId.set(callId, rec)
      continue
    }
    if (ev.type !== 'tool/result') continue
    const callId = ev.data?.message?.source?.callId
    if (typeof callId !== 'string' || claimed.has(callId)) continue
    const call = byId.get(callId)
    if (call === undefined) continue
    claimed.add(callId)
    const parts = ev.data?.message?.content ?? []
    const isError = parts.some((part) => part?.isError === true)
    const receipt = receiptTextOf(parts)

    if (call.name === 'aura_read') {
      if (isError) continue
      const p = resolvePath(cwd, call.args?.file_path)
      if (p === null) continue
      const key = pathKey(p)
      const { map, version, fileChars } = lineMapFromReceipt(receipt)
      if (version === null) continue
      const prev = state.get(key)
      if (prev !== undefined && prev.version === version) {
        for (const [n, t] of map) if (!prev.map.has(n)) prev.map.set(n, t)
      } else {
        state.set(key, { map: new Map(map), version, fileChars, path: p })
      }
      continue
    }

    if (call.name !== 'aura_edit') continue
    tally.editCalls += 1
    if (typeof call.t === 'number') tally.editCallTimes.push(call.t)
    if (isError) {
      tally.editErr += 1
      continue
    }
    tally.editOk += 1
    if (typeof call.t === 'number') tally.editOkTimes.push(call.t)
    const args = call.args
    if (args === null || typeof args !== 'object') {
      tally.drift.argsUnparsed += 1
      continue
    }
    const p = resolvePath(cwd, args.file_path)
    if (p === null) {
      tally.drift.noFilePath += 1
      continue
    }
    const key = pathKey(p)
    const hunks = hunksOf(args)
    if (hunks.length === 0) {
      tally.drift.noHunks += 1
      state.delete(key)
      continue
    }
    /** 新契约入参（带 `old`）不属于「旧契约下的成功」：两列不可比，单独计。 */
    if (hunks.some((h) => typeof h.old === 'string' && h.old.length > 0)) {
      tally.drift.newContractArgs += 1
      state.delete(key)
      continue
    }
    const st = state.get(key)
    const built = buildSource(st, hunks)
    state.delete(key) // 这次编辑成功了：文件已经变了
    if (built.source === null) {
      tally.drift[built.drift] = (tally.drift[built.drift] ?? 0) + 1
      continue
    }
    const fileChars = st?.fileChars ?? built.source.length
    pool.push({
      dir,
      sessionFile: file,
      cwd,
      callIndex: call.index,
      file: p,
      ext: extBucketOf(p),
      extRaw: extOf(p) || '(无扩展名)',
      locator: locatorKindOf(hunks),
      hasExpect: hunks.some((h) => typeof h.expect === 'string' && h.expect.length > 0),
      hunkCount: hunks.length,
      args,
      hunks,
      fileChars,
      sizeBucket: sizeBucketOf(fileChars),
      sourceText: built.source,
      sourceKind: built.kind,
      sourceLines: built.source.split('\n').length,
      coverage: fileChars > 0 ? Math.min(1, Math.round((built.realChars / fileChars) * 1000) / 1000) : null,
      receiptFirstLine: receipt.split('\n')[0] ?? '',
    })
  }
  return sessionsRoot
}

/**
 * 用行号快照拼出**当时的**那一份文本：快照里有的行是真的，其余留空行占位。
 *
 * 空行占位是**不会冒充原文**的：任何非空的引文都不可能匹配到空行。代价是「整份文件里
 * 这段文字唯一吗」这个判断只在快照覆盖到的部分成立（这是本格的已知盲区，写在报告边界里）。
 */
function buildSource(st, hunks) {
  if (st === undefined || st.map.size === 0) return { source: null, drift: 'noSnapshot' }
  let maxLine = 0
  for (const n of st.map.keys()) maxLine = Math.max(maxLine, n)
  const text = () => {
    const arr = new Array(maxLine).fill('')
    for (const [n, t] of st.map) if (n >= 1 && n <= maxLine) arr[n - 1] = t
    return arr.join('\n')
  }
  for (const h of hunks) {
    const range = lineRangeOf(h)
    if (range !== undefined) {
      const { start: s, end: e } = range
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s) return { source: null, drift: 'badLineRange' }
      if (e - s > RANGE_SPAN_CAP) return { source: null, drift: 'rangeTooWide' }
      for (let i = s; i <= e; i += 1) if (!st.map.has(i)) return { source: null, drift: 'addressedLineNotInSnapshot' }
      maxLine = Math.max(maxLine, e)
      continue
    }
    const key = ADDRESS_KEYS.find((k) => typeof h[k] === 'string' && h[k].length > 0)
    if (key === undefined) return { source: null, drift: 'noAddress' }
    const body = text()
    if (key === 'target') {
      /** 符号名（`function:apply#2`）不会字面出现在正文里：剥掉种类与序号，只要名字在场即可。
       *  宽松在这里是安全的 —— 真不真的对得上，由冻结基准那一列当场判（它不过就整条不计）。 */
      const bare = String(h.target).replace(/^[A-Za-z_]+:/, '').replace(/#\d+$/, '')
      if (bare.length === 0 || !body.includes(bare)) return { source: null, drift: 'targetNotInSnapshot' }
      continue
    }
    const needle = normSpace(String(h[key]))
    const hay = normSpace(body)
    if (needle.length === 0 || !hay.includes(needle)) return { source: null, drift: `${key}NotInSnapshot` }
  }
  if (maxLine > SCAFFOLD_MAX_LINES) return { source: null, drift: 'tooManyLines' }
  const body = text()
  if (body.length > SOURCE_CAP) return { source: null, drift: 'sourceTooLarge' }
  let realChars = 0
  for (const t of st.map.values()) realChars += t.length + 1
  return { source: body, kind: 'log-scaffold', realChars }
}

/**
 * 语料文件选择：**哪些会话文件进扫描** —— 唯一一份（本文件与 `probes/indent-loss-census.mjs` 共用）。
 *
 * 从 `scanAll` 里**原样**提出来的，一个字都没改（只把 `files`/`use` 一起交出去）：
 * 提出来的理由是「同一批文件」这句话必须靠**同一段代码**成立，而不是靠两个探针各写一遍
 * 选择规则再祈祷它们一致。判定与计数一概没动 —— `scanAll` 的读数与提出去之前逐条相同。
 */
export function selectCorpusFiles(sessionsRoot, limitSessions, windowOpts = {}) {
  /**
   * 把**正在写这份日志的那个会话**排除在外。
   *
   * 理由不是「它不算数」，而是「它此刻还没写完」：本探针自己就在那个会话里落盘，边跑边写，
   * 于是同一份语料两次跑出来条数会差几条（实测：池 3503 / 3504，冻结基准 ok 911 / 910）。
   * 一个会被自己的运行过程改动的分母，没法被另一个代理复算。排除掉它，抽样就是确定性的。
   */
  /** 会话目录名两种写法并存（旧 `session-<uuid>`、新 `<uuid>`）——两种都要认，否则排除静默失效。 */
  const id = process.env.DSH_SESSION_ID ?? null
  const names = id === null ? [] : [id, `session-${id}`]
  const all = walkSessions(sessionsRoot)
  const skipped = names.length === 0 ? [] : all.filter((f) => names.includes(path.basename(path.dirname(f))))
  /**
   * 还要排除**刚刚还在写**的会话，否则分母会随运行时机变：这是一轮并行测量（R1–R5 同时在跑），
   * 别的仓己的会话日志正在被追加。实测两次连跑，同一个探针给出 Z=3 与 Z=7 —— 差的就是它们。
   * 规则：只收 `mtime ≤ until - staleMinutes` 的会话文件。`until` 可以钉死（`--until=<ISO>`），
   * 钉死后抽样就是确定的：另一个代理用同一个 until 跑，会取到同一个文件集。
   */
  const cutoff = windowOpts.cutoffMs ?? Infinity
  const stats = new Map()
  const fresh = []
  for (const f of all) {
    try {
      stats.set(f, fs.statSync(f).mtimeMs)
    } catch {
      fresh.push(f)
    }
  }
  const writing = [...stats].filter(([, m]) => m > cutoff).map(([f]) => f)
  const files0 = skipped.length === 0 ? all : all.filter((f) => !skipped.includes(f))
  const files = files0.filter((f) => !writing.includes(f))
  const use = limitSessions === null ? files : files.slice(0, limitSessions)
  /** `files` = 过滤后、截取前（`tally.sessionFiles` 说的是它）；`use` = 真去扫的那批。 */
  return { all, files, use, skippedLive: skipped, writing, cutoff }
}

function scanAll(sessionsRoot, limitSessions, windowOpts = {}, poolSink = null) {
  const { files, use, skippedLive: skipped, writing, cutoff } = selectCorpusFiles(sessionsRoot, limitSessions, windowOpts)
  const tally = {
    sessionFiles: files.length,
    scanned: 0,
    bytes: 0,
    editCalls: 0,
    editOk: 0,
    editErr: 0,
    /** 逐次调用的时间戳：只用于与第三方 CSV 按**同一个时间窗**对账（§7.1）。 */
    editCallTimes: [],
    editOkTimes: [],
    drift: {
      argsUnparsed: 0,
      noFilePath: 0,
      noHunks: 0,
      newContractArgs: 0,
      noSnapshot: 0,
      addressedLineNotInSnapshot: 0,
      anchorNotInSnapshot: 0,
      line_cueNotInSnapshot: 0,
      targetNotInSnapshot: 0,
      noAddress: 0,
      badLineRange: 0,
      rangeTooWide: 0,
      tooManyLines: 0,
      sourceTooLarge: 0,
    },
  }
  /** `poolSink` 只给「只要计数、不要池」的调用方用（见 {@link tallyCorpusEdits}）。 */
  const pool = poolSink ?? []
  for (const file of use) {
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      continue
    }
    tally.scanned += 1
    tally.bytes += size
    scanSession(file, sessionsRoot, tally, pool)
  }
  return { tally, pool, skippedLive: skipped, writing, cutoff }
}

/**
 * 只要 `tally` 的那一次扫描（`probes/indent-loss-census.mjs` 的上游口径对账用）：
 * 同一批文件、同一个窗口，**本文件的解析器**数出来的 `editCalls / editOk / editErr` 是多少。
 * 池里的 `sourceText` 是这份语料最占内存的那一块，对账只要计数 ⇒ 用一个丢弃用的收件口接住它。
 */
export const tallyCorpusEdits = (sessionsRoot, limitSessions, windowOpts = {}) =>
  scanAll(sessionsRoot, limitSessions, windowOpts, { push() {} }).tally

// ── 3. 分层抽样（确定性：同样输入永远抽同一批） ──

function stratify(pool, target) {
  const strata = new Map()
  for (const e of pool) {
    const key = `${e.locator}|${e.sizeBucket}`
    if (!strata.has(key)) strata.set(key, [])
    strata.get(key).push(e)
  }
  const keys = [...strata.keys()].sort()
  const total = pool.length
  const picked = []
  const quota = new Map()
  for (const key of keys) {
    const n = strata.get(key).length
    const want = n === 0 ? 0 : Math.max(SAMPLE_FLOOR, Math.round((n / total) * target))
    quota.set(key, Math.min(n, want))
  }
  for (const key of keys) {
    const items = [...strata.get(key)].sort(
      (a, b) => a.ext.localeCompare(b.ext) || a.dir.localeCompare(b.dir) || a.callIndex - b.callIndex,
    )
    const want = quota.get(key)
    if (want >= items.length) {
      picked.push(...items)
      continue
    }
    /** 等距取样：确定性、且不会因为池子的排列顺序而偏向某个会话或某一天。 */
    const stride = items.length / want
    for (let i = 0; i < want; i += 1) picked.push(items[Math.floor(i * stride)])
  }
  return { picked, quota, strataSizes: Object.fromEntries(keys.map((k) => [k, strata.get(k).length])) }
}

// ── 4. 三态判定（码 → outcome；判决表从壳层源码里解析，不手抄） ──

/**
 * `aura-edit/index.js` 里的 `OUTCOME_BY_CODE` 是**唯一一份**「哪些码算判定得出意图」的表。
 * 探针不重写它，而是把那张表从壳层源码里**解析**出来：手抄一份的下场是壳层改了表、探针还在用
 * 旧口径，两边的「转失败」计数从此对不上，而表面上都说得通。
 * 解析必须命中已知的十条（多出来的照收并打印），少一条就当场报错退出 —— 那是壳层形状变了。
 */
function outcomeTableFromShell() {
  const file = pkgPath('src', 'aura-edit', 'index.js')
  const text = fs.readFileSync(file, 'utf8')
  const block = /const OUTCOME_BY_CODE = new Map\(\[([\s\S]*?)\]\)/.exec(text)
  if (!block) throw new Error(`壳层里找不到 OUTCOME_BY_CODE：${file}`)
  const table = new Map()
  const re = /\[\s*'([A-Z_]+)'\s*,\s*'([a-z_]+)'\s*\]/g
  let m
  while ((m = re.exec(block[1])) !== null) table.set(m[1], m[2])
  const required = [
    'PATCH_NOT_FOUND',
    'PATCH_ANCHOR_NOT_FOUND',
    'LOCATOR_CUE_NOT_FOUND',
    'PATCH_EXPECT_MISMATCH',
    'LOCATOR_ASSERT_MISMATCH',
    'LOCATOR_OUT_OF_RANGE',
    'LOCATOR_BAD_LINES',
    'PATCH_AMBIGUOUS',
    'LOCATOR_AMBIGUOUS',
    'LOCATOR_CUE_AMBIGUOUS',
  ]
  const missing = required.filter((c) => !table.has(c))
  if (missing.length > 0) throw new Error(`壳层判决表解析缺码：${missing.join(', ')}（壳层形状变了，探针要跟着改）`)
  for (const [code, outcome] of table) {
    if (!OUTCOMES.includes(outcome)) throw new Error(`壳层判决表里 ${code} → ${outcome} 不是合法三态`)
  }
  return { file, table }
}

/**
 * 一份文本里，「这段引文在全文出现了几处」——**直接调引擎自己那份判据**，不另写一份计数。
 *
 * 把受寻址区间设成整个文件、`actual` 给空串，于是它必然落到「唯一但不在区间内」那条分支上，
 * 而 `places` 已经数好了全文出现处。返回 1 = 全文唯一；n>1 = 多处；0 = 全文没有。
 */
function placesIn(content, expectText) {
  const lines = content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const verdict = expectVerdict(lines, 1, Math.max(1, lines.length), '', expectText)
  if (verdict === null) return 1
  return Array.isArray(verdict.places) ? verdict.places.length : 0
}

/** 与壳层 `intentVerdict` 同形的判决：白名单未命中 ⇒ 工具级故障（**不折进 not_found**）。 */
function outcomeOf(table, code, candidates) {
  const mapped = table.get(code)
  if (mapped === undefined) return 'tool_error'
  const n = Array.isArray(candidates) ? candidates.length : 0
  if (n > 1) return 'needs_choice'
  return mapped === 'needs_choice' ? 'not_found' : mapped
}

// ── 5. 两列重放 ──

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 语料里的路径永不被写：重建原文一律摊到临时目录的副本上，两列读的是同一批副本。 */
function stageCopy(entry, tmpDir, index) {
  const ext = extOf(entry.file) || '.txt'
  const copyPath = path.join(tmpDir, `${entry.id}${ext}`)
  fs.writeFileSync(copyPath, entry.sourceText, 'utf8')
  const inside = path.relative(tmpDir, copyPath)
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`副本跑到临时目录外：${copyPath}`)
  return copyPath
}

/** 现树新契约那一列：原参数原样交给当前工作树的 `planHunks`。 */
function replayTree(entry, content, copyPath, table) {
  try {
    const out = planHunks(content, entry.hunks, copyPath)
    return {
      outcome: 'applied',
      code: 'OK',
      message: '',
      applied: out.applied.length,
      contentSha: crypto.createHash('sha256').update(String(out.content ?? '')).digest('hex').slice(0, 16),
      contentChars: String(out.content ?? '').length,
    }
  } catch (error) {
    const code = String(error?.code ?? 'THROW')
    return {
      outcome: outcomeOf(table, code, error?.candidates),
      code,
      message: String(error?.message ?? error).slice(0, 200),
      candidates: Array.isArray(error?.candidates) ? error.candidates.length : 0,
    }
  }
}

/**
 * 子进程的源码：`node --input-type=module -e <这段>`。
 *
 * 它只做三件事：按绝对路径 import **夹具自己的**引擎、用同一个 `planHunks` 跑一遍基准列、
 * 把引擎文件的路径与 sha256 报回来。父进程拿它报回的摘要与**自己独立算的**夹具摘要比对 ——
 * 两边都对上，才认这一列是「另一份代码跑出来的」。结果走**文件**不走管道：受约束的沙箱里
 * node 抓子进程管道会 EPERM，而这条判据不该因为跑法变了就红。
 */
const FROZEN_CHILD_SOURCE = `
const fs = await import('node:fs')
const crypto = await import('node:crypto')
const out = { ok: false, pid: process.pid, error: 'child wrote nothing' }
try {
  const fx = await import(process.env.AURA_R2_FIXTURE)
  const engine = await fx.loadFrozenEngine(process.env.AURA_R2_ENGINE_ROOT)
  const job = JSON.parse(fs.readFileSync(process.env.AURA_R2_JOB, 'utf8'))
  const perId = {}
  for (const e of job.entries) {
    const content = fs.readFileSync(e.copyPath, 'utf8')
    try {
      const res = engine.planHunks(content, e.hunks, e.copyPath)
      perId[e.id] = {
        ok: true,
        applied: Array.isArray(res?.applied) ? res.applied.length : 0,
        contentSha: crypto.createHash('sha256').update(String(res?.content ?? '')).digest('hex').slice(0, 16),
        contentChars: String(res?.content ?? '').length,
      }
    } catch (error) {
      perId[e.id] = {
        ok: false,
        code: String(error?.code ?? 'THROW'),
        message: String(error?.message ?? error).slice(0, 200),
        candidates: Array.isArray(error?.candidates) ? error.candidates.length : 0,
      }
    }
  }
  out.engine = engine.provenance
  out.oldProbe = fx.probeEngineOldContract ? fx.probeEngineOldContract(engine) : null
  out.acceptsOld = (() => { try { engine.planHunks('a\\nb\\n', [{ old: 'b', replace: 'B' }], null); return true } catch { return false } })()
  out.perId = perId
  out.entries = job.entries.length
  out.error = null
  out.ok = true
} catch (error) {
  out.error = String((error && error.stack) || error)
}
fs.writeFileSync(process.env.AURA_R2_RESULT, JSON.stringify(out))
`

function snapshotTree(root) {
  const out = new Map()
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      try {
        const st = fs.statSync(p)
        out.set(p, `${e.isDirectory() ? 'd' : 'f'}|${st.size}|${st.mtimeMs}`)
        if (e.isDirectory()) walk(p, depth + 1)
      } catch {
        /* 拍不到的项不参与比对 */
      }
    }
  }
  walk(root, 0)
  return out
}

function diffTree(before, after) {
  const changed = []
  for (const [k, v] of before) if (after.get(k) !== v) changed.push(k)
  for (const [k] of after) if (!before.has(k)) changed.push(k)
  return changed
}

function runFrozenColumn(jobEntries, tmpDir) {
  const root = FROZEN_BASELINE_ROOT
  const started = Date.now()
  /**
   * 夹具自检（与 failure-replay 同一份实现）：夹具缺了 / 被改过 / 被换成现树，
   * 三种异常各是一种**结果**，一路挂到判据上分开点名，不静默退化。
   */
  const fixture = inspectFrozenFixture(root)
  const common = {
    status: 'unavailable',
    root,
    fixture,
    childPid: null,
    engine: null,
    acceptsOld: null,
    perId: null,
    treeFiles: 0,
    treeChanged: null,
    exit: null,
    ms: 0,
    how: '',
  }
  if (!fs.existsSync(root)) {
    // `problems` 里已经写得够具体（清单读不到 / 副本没了），不在这里再套一层「夹具不存在」。
    return { ...common, how: fixture.problems.join(' ； ') || `冻结基准夹具不存在：${root}` }
  }
  const before = snapshotTree(root)
  const jobPath = path.join(tmpDir, 'r2-frozen-job.json')
  const resultPath = path.join(tmpDir, 'r2-frozen-result.json')
  fs.writeFileSync(jobPath, JSON.stringify({ entries: jobEntries }), 'utf8')
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', FROZEN_CHILD_SOURCE], {
    env: {
      ...process.env,
      AURA_R2_FIXTURE: FROZEN_FIXTURE_URL,
      AURA_R2_ENGINE_ROOT: root,
      AURA_R2_JOB: jobPath,
      AURA_R2_RESULT: resultPath,
    },
    stdio: 'ignore',
    windowsHide: true,
    timeout: 20 * 60 * 1000,
  })
  const after = snapshotTree(root)
  const base = {
    ...common,
    treeFiles: before.size,
    treeChanged: diffTree(before, after),
    exit: { status: proc.status, signal: proc.signal, error: proc.error ? String(proc.error.message) : null },
    ms: Date.now() - started,
  }
  let child = null
  try {
    child = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  } catch {
    child = null
  }
  if (!child) return { ...base, how: `子进程没写出结果文件（exit=${proc.status}，signal=${proc.signal}）` }
  if (!child.ok) return { ...base, childPid: child.pid, how: `子进程报错：${String(child.error).split('\n')[0]}` }
  return {
    ...base,
    status: 'ok',
    childPid: child.pid,
    engine: child.engine,
    acceptsOld: child.acceptsOld,
    perId: child.perId,
    how: `子进程 pid ${child.pid} 用 ${root}（v${child.engine?.version}）跑完 ${child.entries} 条`,
  }
}

// ── 6. 显示与小工具 ──

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))
const padL = (s, n) => ' '.repeat(Math.max(0, n - String(s).length)) + String(s)
const pct = (a, b) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(2)}%`)
const sha16 = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * 支持的旗标 ── **唯一一份**：解析认它，用法错误清单也印它，两边不可能各说一套。
 * 退出码口径（与其它测量件一致）：0 = 全绿 ｜ 1 = 有判据红 ｜ 2 = 用法错。
 */
const FLAGS = [
  { form: '--sample=N', note: '抽样条数（默认 900）' },
  { form: '--sessions=N', note: '只扫前 N 个会话文件（开发用）' },
  { form: '--show=N', note: '只打印前 N 条转失败明细（默认 0 = 全部）' },
  { form: '--json', note: '附机器可读统计' },
  { form: '--corpus-out=PATH', note: '语料落点（默认落在临时目录）' },
  { form: '--no-corpus', note: '不写语料文件' },
  { form: '--until=<epoch-ms|ISO>', note: '时间窗上端（epoch 毫秒或 ISO；默认 = 现在）' },
  { form: '--stale-minutes=N', note: '最近 N 分钟还在写的会话文件排除（默认 20）' },
]
const USAGE = ['用法：node aura-tools/probes/success-regression.mjs', ...FLAGS.map((f) => ` [${f.form}]`)].join('')
const USAGE_EXIT = 2
/** 判据与用法错误共用同一个「不存在的旗标」样本：它必须被点名拒收。 */
const UNKNOWN_FLAG = '--no-such-flag-xyz'

/**
 * 解析 argv（**纯函数**：只回值，不打印、不退出 —— 判据直接调它自检）。
 * 已知旗标的语义与原实现逐字相同（含 `--until=<epoch-ms>` 与 `--until=<ISO>` 两种形式）；
 * 未知旗标、以及**值解不开**的旗标（NaN 从前会静默落回默认窗口）一律记成用法错。
 */
function parseArgv(argv) {
  const opts = {
    sample: SAMPLE_TARGET,
    sessions: null,
    show: 0, // 0 = 全部转失败明细（验收要求打印）
    json: false,
    corpusOut: path.join(os.tmpdir(), 'aura-r2-success-corpus.json'),
    noCorpus: false,
    until: 0, // 0 = 现在
    staleMinutes: 20,
  }
  const errors = []
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a)
    if (!m) {
      errors.push(`不是旗标：${a}`)
      continue
    }
    const k = m[1]
    const v = m[2]
    /** 值旗标：缺 `=值` 或值解不成就记用法错（从前是 NaN 静默落回默认）。 */
    const num = () => {
      const n = Number(v)
      if (v === undefined || v === '' || !Number.isFinite(n)) {
        errors.push(`--${k} 要是数：${v === undefined ? `--${k} 后面缺 =值` : `=「${v}」`}`)
        return null
      }
      return n
    }
    const noValue = () => {
      if (v !== undefined) {
        errors.push(`--${k} 不带值：--${k}=${v}`)
        return false
      }
      return true
    }
    if (k === 'sample') {
      const n = num()
      if (n !== null) opts.sample = n
    } else if (k === 'sessions') {
      const n = num()
      if (n !== null) opts.sessions = n
    } else if (k === 'show') {
      const n = num()
      if (n !== null) opts.show = n
    } else if (k === 'stale-minutes') {
      const n = num()
      if (n !== null) opts.staleMinutes = n
    } else if (k === 'until') {
      const parsed = v === undefined || v === '' ? NaN : Number.isFinite(Number(v)) ? Number(v) : Date.parse(v)
      if (Number.isFinite(parsed)) opts.until = parsed
      else errors.push(`--until 要是 epoch 毫秒或 ISO 时间：${v === undefined ? '--until 后面缺 =值' : `=「${v}」`}`)
    } else if (k === 'json') {
      if (noValue()) opts.json = true
    } else if (k === 'no-corpus') {
      if (noValue()) opts.noCorpus = true
    } else if (k === 'corpus-out') {
      if (v === undefined || v === '') errors.push(`--corpus-out 要一个路径：${v === undefined ? '--corpus-out 后面缺 =PATH' : '--corpus-out='}`)
      else opts.corpusOut = v
    } else errors.push(`未知旗标：--${k}`)
  }
  return { opts, errors }
}

/** 用法错 ⇒ `{ exit: 2, message }`；没错 ⇒ `null`（判据也调它）。 */
function usageFailureOf(errors) {
  if (errors.length === 0) return null
  return {
    exit: USAGE_EXIT,
    message: [...errors, '', USAGE, '支持的旗标：', ...FLAGS.map((f) => `  ${f.form.padEnd(24)}${f.note}`)].join('\n'),
  }
}
const usageFailure = (argv) => usageFailureOf(parseArgv(argv).errors)

// ── 7. 主流程 ──

async function main() {
  const { opts, errors } = parseArgv(process.argv.slice(2))
  const failure = usageFailureOf(errors)
  if (failure !== null) {
    // 用法错：当场退出 —— 不扫会话日志、不重放、不写语料文件、不打印任何读数。
    process.stderr.write(`${failure.message}\n`)
    process.exit(failure.exit)
  }
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail })

  /**
   * 用法面（本次加固）：未知旗标必须被**点名拒收**（exit 2，见文件头「用法」），
   * 不能像从前那样被丢在地上、跑出一份默认窗口的读数。
   * 判据直接调本探针的解析器（不 spawn 子进程）：时间窗旗标与一个错字旗标一起给，
   * 断言错字那条被点名、且支持集列全。
   */
  const argProbe = usageFailure(['--until=2026-10-13T15:29:59.767Z', UNKNOWN_FLAG])
  check(
    '用法：未知旗标被点名拒收（exit 2，不是静默跑默认窗口）',
    argProbe !== null && argProbe.exit === USAGE_EXIT && argProbe.message.includes(UNKNOWN_FLAG) && FLAGS.every((f) => argProbe.message.includes(f.form)),
    argProbe === null ? `${UNKNOWN_FLAG} 被静默吞掉（会跑出一份看着正常的默认窗口读数）` : `exit ${argProbe.exit}；点名 ${UNKNOWN_FLAG}；列出 ${FLAGS.length} 个支持旗标`,
  )

  console.log('=== R2 成功集回归：新契约有没有把原本成功的编辑打坏 ===')
  console.log(`会话根：${SESSIONS_ROOT}`)

  // ── 7.1 扫日志、建池 ──
  const t0 = Date.now()
  const until = opts.until > 0 ? opts.until : t0
  const cutoffMs = until - opts.staleMinutes * 60000
  const { tally, pool, skippedLive, writing } = scanAll(SESSIONS_ROOT, opts.sessions, { cutoffMs })
  const scanMs = Date.now() - t0
  const driftTotal = Object.values(tally.drift).reduce((a, b) => a + b, 0)
  console.log('')
  console.log('── ① 会话日志扫描 ──')
  console.log(`会话文件：${tally.scanned}/${tally.sessionFiles} 个，${(tally.bytes / 1048576).toFixed(1)} MB，用时 ${(scanMs / 1000).toFixed(1)}s`)
  console.log(
    skippedLive.length > 0
      ? `排除「正在写日志的那个会话」${skippedLive.length} 个：${skippedLive.map((f) => path.basename(path.dirname(f))).join(', ')}（它还在写，会让分母随本探针自己的运行而变）`
      : '未排除任何会话（环境里没有 DSH_SESSION_ID，或它的目录还没落盘：可能不是在 DSH 会话里跑的）',
  )
  console.log(
    `时间窗：mtime ≤ ${new Date(cutoffMs).toISOString()}（--until=${new Date(until).toISOString()} --stale-minutes=${opts.staleMinutes}）；` +
      `因「最近 ${opts.staleMinutes} 分钟内还在写」排除 ${writing.length} 个会话文件`,
  )
  console.log(`aura_edit 调用：${tally.editCalls} 次（成功 ${tally.editOk} / 失败 ${tally.editErr}）`)
  console.log(`成功调用里排除 ${driftTotal} 条，原因分布：`)
  for (const [k, v] of Object.entries(tally.drift).sort((a, b) => b[1] - a[1])) {
    if (v > 0) console.log(`    ${pad(k, 28)} ${v}`)
  }
  console.log(`可重建池：${pool.length} 条`)

  /**
   * 与第三方 CSV 对账**必须同一个时间窗**：那份 CSV 是 2026-10-13T12:21:54Z 那一刻扫的，
   * 之后新产生的会话（含今天 C1–C12 各轮的工作会话）它一条也没有。不切窗口就比，差的那 300 条
   * 会被读成「本探针多数了 300 条」，而真实原因只是时间。窗口端点从 CSV 自己的 `t` 列取。
   */
  const csv = crossCheckCsv()
  if (csv !== null) {
    const mine = tally.editOkTimes.filter((t) => t <= csv.maxT).length
    const gap = mine - csv.ok
    console.log(
      `对账（第三方解析器 ${path.relative(REPO, CROSS_CHECK_CSV)}，窗口截至 ${new Date(csv.maxT).toISOString()}）：` +
        `成功 aura_edit 它 ${csv.ok} 条 / 本探针同窗口 ${mine} 条（差 ${gap}）；全窗口本探针 ${tally.editOk} 条`,
    )
    if (opts.sessions === null) {
      check(
        '对账：同一时间窗内本探针数出的成功调用与第三方扫描一致',
        Math.abs(gap) <= Math.max(50, csv.ok * 0.02),
        `同窗口 ${mine} vs ${csv.ok}（差 ${gap}）；窗口外新增 ${tally.editOk - mine} 条`,
      )
    }
  }

  // ── 7.2 分层抽样 ──
  const { picked, quota, strataSizes } = stratify(pool, opts.sample)
  picked.sort((a, b) => a.dir.localeCompare(b.dir) || a.callIndex - b.callIndex)
  picked.forEach((e, i) => {
    e.id = `S${String(i + 1).padStart(4, '0')}`
  })
  console.log('')
  console.log('── ② 分层抽样（层 = 定位器种类 × 文件大小档） ──')
  for (const key of Object.keys(strataSizes).sort()) {
    console.log(`    ${pad(key, 18)} 池 ${padL(strataSizes[key], 5)} → 抽 ${padL(quota.get(key), 5)}`)
  }
  console.log(`合计：池 ${pool.length} → 抽 ${picked.length}`)
  const dist = (fn) => {
    const m = new Map()
    for (const e of picked) m.set(fn(e), (m.get(fn(e)) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')
  }
  console.log(`    文件类型：${dist((e) => e.ext)}`)
  console.log(`    定位器：  ${dist((e) => e.locator)}`)
  console.log(`    文件大小：${dist((e) => e.sizeBucket)}`)
  console.log(`    带 expect：${dist((e) => (e.hasExpect ? '有' : '无'))}`)

  check('语料条数 ≥ 500', picked.length >= 500, `抽到 ${picked.length} 条（池 ${pool.length}）`)
  check(
    '三个维度都有覆盖',
    new Set(picked.map((e) => e.ext)).size >= 3 &&
      new Set(picked.map((e) => e.sizeBucket)).size >= 3 &&
      new Set(picked.map((e) => e.locator)).size >= 2,
    `类型 ${new Set(picked.map((e) => e.ext)).size} / 大小 ${new Set(picked.map((e) => e.sizeBucket)).size} / 定位器 ${new Set(picked.map((e) => e.locator)).size}`,
  )

  // ── 7.3 摊副本（语料里的路径从不被写） ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-r2-replay-'))
  const staged = []
  for (const e of picked) {
    const copyPath = stageCopy(e, tmpDir, staged.length)
    staged.push({ e, copyPath, content: fs.readFileSync(copyPath, 'utf8') })
  }
  const stageOk = staged.every((s) => sha16(s.content) === sha16(s.e.sourceText))
  check('每条重放读到的字节 = 语料原文', stageOk, `逐条比对 sha256_16，${staged.length} 条`)

  // ── 7.4 两列重放 ──
  const { file: shellFile, table } = outcomeTableFromShell()
  console.log('')
  console.log('── ③ 两列重放 ──')
  console.log(`三态判决表（解析自 ${path.relative(REPO, shellFile)}，不手抄）：`)
  console.log(`    ${[...table.entries()].map(([c, o]) => `${c}→${o}`).join('  ')}`)

  const t1 = Date.now()
  const treePerId = {}
  for (const s of staged) treePerId[s.e.id] = replayTree(s.e, s.content, s.copyPath, table)
  const treeMs = Date.now() - t1

  const frozen = runFrozenColumn(
    staged.map((s) => ({ id: s.e.id, copyPath: s.copyPath, hunks: s.e.hunks })),
    tmpDir,
  )
  console.log(`冻结基准：${frozen.how}（${(frozen.ms / 1000).toFixed(1)}s）`)
  console.log(`现树新契约：${staged.length} 条，${(treeMs / 1000).toFixed(1)}s`)
  console.log(`基准那份认不认 {old}：${frozen.acceptsOld === null ? '未知' : frozen.acceptsOld ? '认' : '不认（= 改动前的代码）'}`)

  /**
   * 夹具自检：三种异常分开点名，且**先于**摘要比对检查 —— 夹具不在时 `frozenEngineDigests`
   * 会直接抛 ENOENT，那样探针会以一个栈收场，而「夹具缺失」是一句该被打印出来的判据。
   */
  const fixture = frozen.fixture ?? { status: 'missing', problems: ['（没有夹具自检结果）'], sameSourceFiles: [] }
  const sameSource = Array.isArray(fixture.sameSourceFiles) ? fixture.sameSourceFiles : []
  console.log(
    `  夹具自检：${fixture.status === 'ok' ? `清单 ${fixture.expectedCount} 个文件逐个对上` : fixture.status}；与现树同源的引擎模块 ${sameSource.length} 个`,
  )
  let expected = []
  let digestsError = null
  try {
    expected = frozenEngineDigests(FROZEN_BASELINE_ROOT)
  } catch (error) {
    digestsError = String(error?.message ?? error).slice(0, 160)
  }
  const childFiles = frozen.engine?.files ?? []
  const digestMatch =
    childFiles.length === expected.length &&
    expected.every((x, i) => childFiles[i].file === x.file && childFiles[i].sha256 === x.sha256)
  const localDigests = FROZEN_ENGINE_MODULES.map((name) => sha256File(path.join(HERE, '../src/locator-lab', name)))
  /**
   * 把「现树那份」也报成可核查的摘要。不报的话，本回执里的「新契约」就只能靠运行时刻来指认，
   * 而本轮引擎时刻在改（写路径最后动于 2026-10-13T23:13:16+08:00，比本探针第一次全量跑早 34 分钟）。
   */
  const treeEngine = localDigests.map((sha, i) => ({
    file: `aura-tools/src/locator-lab/${FROZEN_ENGINE_MODULES[i]}`,
    sha256_16: sha.slice(0, 16),
    mtime: fs.statSync(path.join(HERE, '../src/locator-lab', FROZEN_ENGINE_MODULES[i])).mtime.toISOString(),
  }))
  const shellSha16 = sha256File(pkgPath('src', 'aura-edit', 'index.js')).slice(0, 16)
  console.log(`现树新契约那份代码：${treeEngine.map((t) => `${path.basename(t.file)} sha256_16=${t.sha256_16}@${t.mtime}`).join('  ')}`)
  console.log(`三态判决表那份壳层：aura-edit/index.js sha256_16=${shellSha16}`)
  const differsLocally = expected.length > 0 && expected.every((x, i) => x.sha256 !== localDigests[i])
  /**
   * 三种异常**各自一段**、拼起来报（不是 switch 取一支）：把夹具换成现树那一份时，
   * 「对不上清单」与「与现树同源」会**同时**成立——正是要让人同时看见这两句，
   * 而不是只看见前者、把根因埋掉。
   */
  const fixtureDetail = [
    fixture.status === 'missing'
      ? `冻结基准夹具缺失：${(fixture.problems ?? []).join(' ； ') || fixture.root}`
      : null,
    fixture.status !== 'missing' && fixture.status !== 'ok'
      ? `冻结基准夹具对不上清单：${(fixture.problems ?? []).join(' ； ')}`
      : null,
    fixture.status === 'ok'
      ? `夹具 ${fixture.fileCount}/${fixture.expectedCount} 个文件逐个对上清单（构建戳 ${fixture.manifest?.buildStamp ?? '(没记)'}）`
      : null,
    sameSource.length > 0
      ? `基准与现树同源：夹具里 ${sameSource.map((f) => `${f.file}=${String(f.sha256).slice(0, 8)}`).join(' ')} 的 sha256 与现树同名文件相同 —— 夹具被拿现树刷新过了，这一列已经不是「改动前」那份`
      : null,
  ]
    .filter(Boolean)
    .join(' ； ')
  check('基准列跑在另一个进程', frozen.childPid !== null && frozen.childPid !== process.pid, `子进程 pid ${frozen.childPid} vs 本进程 ${process.pid}`)
  check(
    '基准列跑的是夹具那份代码',
    fixture.status === 'ok' && sameSource.length === 0 && digestMatch && differsLocally,
    digestsError !== null
      ? `夹具摘要算不出来（${digestsError}）—— ${fixtureDetail}`
      : `${fixtureDetail}；子进程报回的摘要与父进程独立算出的一致=${digestMatch}；与现树同名文件全不同=${differsLocally}` +
        `（夹具 ${expected.map((x) => x.sha256.slice(0, 8)).join(',') || '(读不到)'} vs 现树 ${localDigests.map((x) => x.slice(0, 8)).join(',')}）`,
  )
  check('夹具目录一个字节没被写', Array.isArray(frozen.treeChanged) && frozen.treeChanged.length === 0, `跑前跑后快照 ${frozen.treeFiles} 项，变化 ${frozen.treeChanged?.length ?? '?'} 项`)

  // ── 7.5 三态计数与转移矩阵 ──
  const newBuckets = ['applied', 'needs_choice', 'not_found', 'tool_error']
  const treeTally = Object.fromEntries(newBuckets.map((k) => [k, 0]))
  const frozenTally = { ok: 0, fail: 0 }
  const matrix = {}
  const rows = []
  for (const s of staged) {
    const id = s.e.id
    const f = frozen.perId?.[id] ?? null
    const t = treePerId[id]
    const fOld = f === null ? 'unknown' : f.ok ? 'ok' : 'fail'
    if (fOld === 'ok') frozenTally.ok += 1
    else if (fOld === 'fail') frozenTally.fail += 1
    treeTally[t.outcome] += 1
    const key = `${fOld}→${t.outcome}`
    matrix[key] = (matrix[key] ?? 0) + 1
    rows.push({ id, entry: s.e, frozen: f, frozenOld: fOld, tree: t })
  }

  const sumNew = newBuckets.reduce((a, k) => a + treeTally[k], 0)
  const sumOld = frozenTally.ok + frozenTally.fail
  check('两列分桶和 = 语料条数', sumNew === staged.length && sumOld === staged.length, `旧 ${sumOld} / 新 ${sumNew} / 语料 ${staged.length}`)

  const okRows = rows.filter((r) => r.frozenOld === 'ok')
  const regressions = okRows.filter((r) => r.tree.outcome !== 'applied')
  /**
   * 第三栏：两列都通过时，**改出来的内容逐字节一样吗**。
   *
   * 只比 ok/fail 会漏掉一类更坏的回归：两列都说「成了」，改出来的文件却不同。
   * 蓝图里已经有一个同性质的已知例（C12 的行内片段兜底把 `const x = 1` 改成 `x = 2`，
   * 吞掉前缀）——那一条在失败集里被发现，而成功集里同机制的情形只能靠这一栏拓出来。
   * 比的是**16 位 sha**，只作相等判定用，不当内容凭据。
   */
  const bothOk = rows.filter((r) => r.frozenOld === 'ok' && r.frozen?.ok === true && r.tree.outcome === 'applied')
  const contentSame = bothOk.filter((r) => r.frozen.contentSha === r.tree.contentSha)
  const contentDiff = bothOk.filter((r) => r.frozen.contentSha !== r.tree.contentSha)

  const M = staged.length
  const Mok = okRows.length
  const Z = regressions.length

  console.log('')
  console.log('── ④ 两列三态计数（同一份原始入参，原样不改写） ──')
  console.log(`语料 M = ${M} 条（全部可重放）；其中冻结基准 ok 的 M_ok = ${Mok} 条`)
  console.log(
    `  冻结基准 0.6.1+217798da（仓库内夹具）  ok ${padL(frozenTally.ok, 4)} / fail ${padL(frozenTally.fail, 4)}`,
  )
  console.log(`  现树新契约                  applied ${padL(treeTally.applied, 4)} / needs_choice ${padL(treeTally.needs_choice, 4)} / not_found ${padL(treeTally.not_found, 4)} / tool_error ${padL(treeTally.tool_error, 4)}`)

  console.log('')
  console.log('── ⑤ 逐条转移矩阵（行 = 冻结基准，列 = 现树新契约） ──')
  console.log(`  ${pad('', 12)}${newBuckets.map((k) => padL(k, 14)).join('')}${padL('合计', 8)}`)
  for (const fOld of ['ok', 'fail', 'unknown']) {
    const cells = newBuckets.map((k) => rows.filter((r) => r.frozenOld === fOld && r.tree.outcome === k).length)
    const total = cells.reduce((a, b) => a + b, 0)
    if (total === 0) continue
    console.log(`  ${pad(fOld, 12)}${cells.map((c) => padL(c, 14)).join('')}${padL(total, 8)}`)
  }

  console.log('')
  console.log('── ⑤b 结果一致性（两列都通过时，改出来的内容是否逐字节相同）──')
  console.log(
    `  两列都 applied 的 ${bothOk.length} 条里：内容相同 ${contentSame.length} 条 / **内容不同 ${contentDiff.length} 条**` +
      `（这一栏是读数不是判据 —— 出现差异不会改变退出码，但每一条都是「静默改成了别的东西」的候选）`,
  )
  for (const r of contentDiff.slice(0, opts.show > 0 ? opts.show : 20)) {
    console.log(`  ${r.id}  ${pad(r.entry.locator, 9)} ${r.entry.extRaw.padEnd(7)} ${r.entry.file}`)
    console.log(`        冻结 ${r.frozen.contentSha} (${r.frozen.contentChars}c)  ≠  现树 ${r.tree.contentSha} (${r.tree.contentChars}c)`)
  }

  console.log('')
  console.log(`── ⑥ 转失败明细（旧 ok → 新非 applied）：${Z} 条 ──`)
  console.log(
    `  结论：成功语料 M = ${M} 条（其中 M_ok = ${Mok} 条在冻结基准上复现了历史成功）里，` +
      `新契约把 Z = ${Z} 条原本成功的弄失败了。`,
  )
  const showN = opts.show > 0 ? Math.min(opts.show, Z) : Z
  for (const r of regressions.slice(0, showN)) {
    console.log(
      `  ${r.id}  ${pad(r.tree.outcome, 13)} ${pad(r.tree.code, 24)} ${pad(r.entry.locator, 9)} ` +
        `${r.entry.extRaw.padEnd(7)} ${String(r.entry.fileChars).padStart(7)}c  ${r.entry.file}`,
    )
    console.log(`        ${String(r.tree.message).slice(0, 150)}`)
  }
  if (showN < Z) console.log(`  …另有 ${Z - showN} 条（--show=${Z} 看全）`)

  // ── 7.6 失败码分布（转失败之外也要看：基准 fail 的那批是什么） ──
  const codeHist = (list) => {
    const m = new Map()
    for (const r of list) m.set(r.tree.code, (m.get(r.tree.code) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  console.log('')
  console.log('── ⑦ 现树失败码分布（按基准列分桶） ──')
  for (const fOld of ['ok', 'fail']) {
    const list = rows.filter((r) => r.frozenOld === fOld && r.tree.outcome !== 'applied')
    if (list.length === 0) continue
    console.log(`  基准 ${pad(fOld, 5)}（${list.length} 条失败）：${codeHist(list).map(([c, n]) => `${c}=${n}`).join('  ')}`)
  }
  const byExpect = (has) => {
    const list = okRows.filter((r) => r.entry.hasExpect === has)
    const bad = list.filter((r) => r.tree.outcome !== 'applied')
    return `${has ? '带' : '不带'} expect：${bad.length}/${list.length}（${pct(bad.length, list.length)}）`
  }
  console.log(`  旧 ok 里的转失败率：${byExpect(true)}   ${byExpect(false)}`)
  console.log('  旧 ok 里的转失败率（按快照覆盖率分档 —— 覆盖率越低，「全文唯一性」越判不准）：')
  for (const [label, pred] of COVERAGE_BANDS) {
    const list = okRows.filter((r) => pred(r.entry.coverage))
    if (list.length === 0) continue
    const bad = list.filter((r) => r.tree.outcome !== 'applied')
    console.log(`      ${pad(label, 22)} ${padL(bad.length, 4)}/${padL(list.length, 4)}（${pct(bad.length, list.length)}）`)
  }

  /**
   * 本格最大的已知盲区：快照只有「读过的那些行」，没读到的部分在重建原文里是空行占位。
   * 空行不会匹配任何非空引文，所以**盲区只会让新契约显得比真实更宽松**（把真文件上本该
   * 判 `needs_choice` 的当成唯一命中）。这里把它量成一个数，而不是写一句「可能有偏」：
   * 对每条带 `expect` 的语料，拿引擎自己那份 `expectVerdict` 数它在（a）重建原文与
   * （b）今天的磁盘文件上各有几处。
   *
   * 读法：`(b) ≥ 2` 是**上界**而非实测——今天的文件已经被这次编辑以及之后的改动改过，
   * 多出来的那处可能当年并不存在。所以这一栏只能回答「盲区最多可能藏了多少条」，
   * 不能回答「实际藏了多少条」。
   */
  const blind = { expectEntries: 0, uniqueInScaffold: 0, uniqueOnDisk: 0, dupOnDisk: 0, diskMissing: 0, hidden: [] }
  for (const s of staged) {
    const ex = (s.e.hunks ?? []).map((h) => (typeof h?.expect === 'string' ? h.expect : null)).find((x) => x !== null)
    if (ex === undefined || ex === null) continue
    const want = normSpace(ex).replace(/^\n+/, '').replace(/\n+$/, '')
    if (want.length < ASSERT_RELAX_MIN_CHARS) continue // 短引文不放松，不参与唯一性判定
    blind.expectEntries += 1
    if (placesIn(s.content, ex) > 1) continue
    blind.uniqueInScaffold += 1
    let disk = null
    try {
      disk = fs.readFileSync(s.e.file, 'utf8')
    } catch {
      disk = null
    }
    if (disk === null) {
      blind.diskMissing += 1
      continue
    }
    if (placesIn(disk, ex) > 1) {
      blind.dupOnDisk += 1
      if (treePerId[s.e.id].outcome === 'applied') blind.hidden.push(s.e.id)
    } else {
      blind.uniqueOnDisk += 1
    }
  }
  console.log('')
  console.log('── ⑧ 盲区量化（快照覆盖率对「全文唯一性」的影响，上界口径） ──')
  console.log(`  带 expect（≥${ASSERT_RELAX_MIN_CHARS} 字符）的语料：${blind.expectEntries} 条`)
  console.log(`    快照里就不唯一 ⇒ 新契约拒绝得对：${blind.expectEntries - blind.uniqueInScaffold} 条`)
  console.log(`    快照里唯一：${blind.uniqueInScaffold} 条（磁盘文件读不到 ${blind.diskMissing} 条）`)
  console.log(`      今天的文件上也只出现 1 次：${blind.uniqueOnDisk} 条`)
  console.log(`      今天的文件上出现 ≥2 次：${blind.dupOnDisk} 条（盲区上界；其中新契约仍判 applied 的 ${blind.hidden.length} 条）`)
  if (blind.hidden.length > 0) console.log(`        仍判 applied 的编号：${blind.hidden.slice(0, 40).join(' ')}${blind.hidden.length > 40 ? ' …' : ''}`)

  // ── 7.7 语料落盘（探针自己生成到临时目录，不落 probes/） ──
  let corpusDigest = null
  if (!opts.noCorpus) {
    const corpus = {
      kind: 'fs-contract-v2.R2.success-corpus',
      /**
       * 这里**不写 builtAt**：语料文件的摘要要能被别人复算，就得只由输入决定。
       * 写入时刻是跑的人自己造出来的输入，把它放进文件会让同一份语料每次跑出不同 sha。
       * 时间只以「选择窗口」的形式留下（它真的决定了抽哪几条，是输入的一部分）。
       */
      window: { until: new Date(until).toISOString(), cutoff: new Date(cutoffMs).toISOString(), staleMinutes: opts.staleMinutes },
      how: 'aura-tools/probes/success-regression.mjs（成功 aura_edit + 同会话此前 aura_read 的行号快照）',
      sessionsRoot: SESSIONS_ROOT,
      window: { until: new Date(until).toISOString(), cutoff: new Date(cutoffMs).toISOString(), staleMinutes: opts.staleMinutes, writingExcluded: writing.length },
      sessionsScanned: tally.scanned,
      editOk: tally.editOk,
      poolSize: pool.length,
      drift: tally.drift,
      sampleTarget: opts.sample,
      entries: picked.map((e) => ({
        id: e.id,
        session: e.dir,
        file: e.file,
        ext: e.extRaw,
        locator: e.locator,
        sizeBucket: e.sizeBucket,
        fileChars: e.fileChars,
        coverage: e.coverage,
        hasExpect: e.hasExpect,
        hunkCount: e.hunkCount,
        args: e.args,
        hunks: e.hunks,
        sourceText: e.sourceText,
        receiptFirstLine: e.receiptFirstLine,
      })),
    }
    const text = JSON.stringify(corpus, null, 1)
    fs.writeFileSync(opts.corpusOut, text, 'utf8')
    corpusDigest = sha16(text)
    console.log('')
    console.log(`语料已写出：${opts.corpusOut}（${(text.length / 1048576).toFixed(2)} MB，sha256_16=${corpusDigest}）`)
    console.log(`重放副本目录：${tmpDir}`)
  }

  // ── 7.8 读数收尾 ──
  const failedChecks = checks.filter((c) => !c.ok)
  console.log('')
  console.log('── 判据 ──')
  for (const c of checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name} —— ${c.detail}`)
  console.log('')
  console.log(`${checks.length - failedChecks.length}/${checks.length} 判据通过`)

  if (opts.json) {
    const stats = {
      sessionsScanned: tally.scanned,
      sessionFiles: tally.sessionFiles,
      window: {
        until: new Date(until).toISOString(),
        cutoff: new Date(cutoffMs).toISOString(),
        staleMinutes: opts.staleMinutes,
        writingExcluded: writing.length,
        skippedLive: skippedLive.map((f) => path.basename(path.dirname(f))),
      },
      editCalls: tally.editCalls,
      editOk: tally.editOk,
      editErr: tally.editErr,
      csvCrossCheck: csv,
      drift: tally.drift,
      poolSize: pool.length,
      sample: picked.length,
      sampleByName: { ext: dist((e) => e.ext), locator: dist((e) => e.locator), size: dist((e) => e.sizeBucket) },
      columns: {
        m: M,
        mOldOk: Mok,
        frozen: frozenTally,
        tree: treeTally,
        matrix,
        regressions: regressions.map((r) => ({
          id: r.id,
          file: r.entry.file,
          locator: r.entry.locator,
          outcome: r.tree.outcome,
          code: r.tree.code,
          message: r.tree.message.slice(0, 200),
          hasExpect: r.entry.hasExpect,
          coverage: r.entry.coverage,
        })),
      },
      blindSpot: blind,
      contentAgreement: {
        bothApplied: bothOk.length,
        same: contentSame.length,
        different: contentDiff.map((r) => ({ id: r.id, file: r.entry.file, frozenSha: r.frozen.contentSha, treeSha: r.tree.contentSha })),
      },
      coverageBands: COVERAGE_BANDS.map(([label, pred]) => {
        const list = okRows.filter((r) => pred(r.entry.coverage))
        return { band: label, oldOk: list.length, regressed: list.filter((r) => r.tree.outcome !== 'applied').length }
      }),
      corpus: { path: opts.corpusOut, sha256_16: corpusDigest },
      skippedLiveSessions: skippedLive.map((f) => path.basename(path.dirname(f))),
      frozenProvenance: {
        root: frozen.root,
        version: frozen.engine?.version ?? null,
        childPid: frozen.childPid,
        acceptsOld: frozen.acceptsOld,
        treeChanged: frozen.treeChanged,
        // 夹具自检：缺了 / 被改过 / 被换成现树，都从这里看得出来。
        fixture: {
          status: fixture.status,
          manifestPath: fixture.manifestPath,
          buildStamp: fixture.manifest?.buildStamp ?? null,
          expectedCount: fixture.expectedCount,
          fileCount: fixture.fileCount,
          missingFiles: fixture.missingFiles,
          driftedFiles: fixture.driftedFiles,
          extraFiles: fixture.extraFiles,
          sameSourceFiles: sameSource,
          problems: fixture.problems,
        },
      },
      treeEngine: { modules: treeEngine, shell: { file: 'aura-tools/src/aura-edit/index.js', sha256_16: shellSha16 } },
      checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
      ms: Date.now() - t0,
    }
    console.log('')
    console.log('---JSON---')
    console.log(JSON.stringify(stats, null, 1))
  }

  process.exit(failedChecks.length === 0 ? 0 : 1)
}

/**
 * 独立对账：`tmp/session-log-scan/out/aura-calls.csv` 是**另一个解析器**（早先的扫描脚本）
 * 逐行数出来的调用表。两个数应当接近但不保证逐条相同（它把 4 条重复 result 事件算成两次、
 * 把当前会话算了进去）。它只用来回答「本探针有没有整段漏掉会话」，不参与任何判定。
 */
function crossCheckCsv() {
  try {
    const text = fs.readFileSync(CROSS_CHECK_CSV, 'utf8')
    const lines = text.split('\n')
    let n = 0
    let maxT = 0
    for (let i = 1; i < lines.length; i += 1) {
      const cells = lines[i].split(',')
      if (cells.length < 12) continue
      const t = Date.parse(cells[0])
      if (Number.isFinite(t) && t > maxT) maxT = t
      if (cells[3] === 'aura_edit' && cells[10] === '1') n += 1
    }
    return n === 0 || maxT === 0 ? null : { ok: n, maxT }
  } catch {
    return null
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) await main()
