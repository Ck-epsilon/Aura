/**
 * failure-replay.mjs —— C7 失败重放夹具 + C11 对照口径（**取证单**，不改引擎、不改壳层）。
 *
 * ## 它回答什么问题
 *
 * 蓝图 fs-contract-v2 的赌注是：把寻址契约换成内容寻址（`old` + `context`）、把
 * `expect` 从"整段相等"放松成"包含且唯一"，就能把读写工具的报错率从 19% 压到 <2%。
 * 这个数字只能拿**真实失败**去验：本夹具从会话日志里抽出历史上真的失败过的调用，
 * 把它们的**原始参数**在两套契约下各重放一次，打印成功/失败/需选择计数。
 *
 * ## 语料从哪来（不重造）
 *
 *   · 逐次调用明细：`tmp/session-log-scan/out/aura-calls.csv`（27k 行，用作**对账**：
 *     本夹具自己从原始事件里数出来的失败数必须与它同量级）；
 *   · 原始事件：`C:\Users\cxk\.dsh\sessions\**\session.v3.jsonl.zstd`。注意这是
 *     **zstd 多帧流**，整体解压只能得到会话头，必须按 magic `28 B5 2F FD` 切帧逐帧解
 *     ——下面的 `splitFrames` / `readJsonl` 是从 `tmp/session-log-scan/zstd-read.mjs`
 *     **照抄**的（那份文件不动；抄一份是为了不让 `src/` 依赖 `tmp/`）。
 *
 * 从原始事件里能拿到 CSV 里没有的三样东西，而它们是重放的前提：
 *   1. **原始 hunk 参数**（CSV 只有定位器种类与个数）；
 *   2. **回执首行**（CSV 只有归类名）；
 *   3. **可用的原文片段** —— 失败之前同会话里对同一文件的那几次成功 `aura_read`，
 *      回执里带 `行号: 正文`，按行号拼回去就是**当时那份文件的局部快照**。
 *
 * ## 重放怎么算"可重放"
 *
 * 历史文件多半已经漂移，所以每条先找**重放原文**（ladder）：
 *   · `log`  —— 用上面那份行号快照重建（受寻址区间必须被快照覆盖）；保真度最高，
 *               错配类（S/W/D/N）走这条路，历史失败能**逐字复现**；
 *   · `disk` —— 今天磁盘上的那份文件（整份读）。歧义/坐标类走这条路，因为
 *               "唯一不唯一""越界不越界"要的是**整份文件**语义；
 *   · 两条都拿不到 ⇒ `drifted`，**不计入成功/失败分母**，但要在表里出现。
 *
 * 重放一律在 `os.tmpdir()` 下的临时目录副本上做：语料里的路径**从不**被当作可写目标。
 * 副本分两种，**不许混用**（C51 立的规矩，理由见「三列各是什么」那一节）：
 *   · **只读副本**（`stageCopy`）—— 旧入参列与冻结基准列踩的那一份。它们调的是判据层
 *     `planHunks` / `readWith`（纯函数，不落盘），而冻结基准列**还要在子进程里按路径把它读回去**，
 *     所以这份副本必须逐字节保持原样；
 *   · **可写副本**（`stageToolCopy`）—— 「现树·新契约」列踩的那一份。它走的是**真实工具那条
 *     入口**（编排层 `applyEditToProvider`，成功的调用**会真的写盘**），写坏也只写坏它自己。
 * 两份副本源自同一份原件文本、落在两个文件上：「真的落过盘」这件事因此可量，
 * 而只读那两列脚下的原文不会被谁改掉。
 *
 * ## 三列各是什么（同一份语料、同一批可重放原件）
 *
 *   · **冻结基准（发布版 0.6.1+217798da5117）**：仓库内一份**只读夹具**
 *     `aura-tools/fixtures/frozen-engine-0.6.1-217798da/`——逐字节等于升级前那一份现网，
 *     而且**不在升级路径上**。这一条是 C29 改出来的：原来读的是安装副本
 *     `C:\Users\cxk\.aura\pkg\node_modules\aura-basetools`，而它正是升级要覆盖的目标，波 8 把它
 *     刷新成现树之后，基准列与「现树·旧入参」列当场逐条同源（`previous/` 也不行 —— 那是
 *     `--rollback` 的对调目标）。它在**独立子进程**里跑，import 的是夹具自己的 `locator-lab`
 *     模块；本探针只读引用——读它的模块、算它的摘要、拍它整棵目录的 mtime/size 快照，
 *     一个字节都不写。这一列答的是「**改动前**这条调用是什么下场」，且**不随现树漂移**。
 *   · **现树·旧入参**：同一批原始参数原样交给**当前工作树**的入口（写侧 `planHunks`，读侧 `readWith`）。
 *     旧契约没有「需选择」这个态（判定不出意图就是抛错），那一格恒为 `—`。它与冻结基准的差 =
 *     **引擎在这批语料上已经漂了多少**；这一列本身会随引擎继续漂，所以它当不了基准
 *     （引擎没动那会儿这一列是 25 ok / 327 fail，波7 是 92 ok / 260 fail —— 同一列两次读数不同）。
 *   · **现树·新契约**：把**同一个聚焦 hunk**改写成 `old` + `context`，交给**真实工具那条入口**
 *     ——编排层 `write-path.mjs` 的 `applyEditToProvider`（CLI / MCP 走的就是它；DSH 壳的第四态
 *     与它共用 `alreadyAppliedHits` 这条判据）。`old` 就是调用方当年自己写的引文。
 *     它答的是：「把这条调用原样交给**今天那个工具**，是什么下场」。
 *
 *     **为什么必须是编排层，而不是判据层**（C51）：编排层在「`old` 两层都找不到、而 `replace`
 *     已经整行唯一地在原文里」时会回一个**结果态** `already_applied`（判据在**任何写盘之前**，
 *     所以这一态一个字节都不动）。此前本列直接调判据层 `planHunks`，而它照旧抛 `PATCH_NOT_FOUND`
 *     —— 于是「那 27 条其实已经落地」只是别处普查的结论，在这张表上仍记 fail。**测的层与跑的层
 *     不是同一层**，本身就是一处单源问题：现在这一列与工具同入口，落地与否由**工具自己**回答。
 *
 *     代价如实写明：编排层会真的写盘，所以这一列只跑在 `stageToolCopy` 那份**可写副本**上；
 *     语料里的路径、以及只读两列脚下的副本，一个字节都不碰。第四态**单列一格**（表头写「已落地」），
 *     不并进 ok、也不并进 fail：算成 ok 会把「这次没寻到址」说成「寻到了」；算成 fail 会把
 *     「这次不用改」说成「失败了」——两种都会让这一格重新变成猜测。
 *
 *     入口可能还不存在——那就整列标成「接口未就绪」并如实计数，**不自己实现一份寻址**；
 *     就绪与否由两个运行时探针现场判定，不写死在代码里。
 *   · 附表一列 **新契约·引文取实证原文**：引文换成回执/快照里**实证到的**那一段（`actual`）。
 *     它答的是「若调用方先读再引」。与主列的「引文原样」是两个不同的问题，所以分开列，
 *     不混成一个数。
 *   · 三列都附**失败码分布**：`PATCH_NOT_FOUND`（这段引文在原文里根本没有）与
 *     `PATCH_AMBIGUOUS`（有多个落点，即新契约三态里的 needs_choice）是两条不同的出路，
 *     只报一个「失败」计数会把它们抹平成一个数。
 *
 * ## 冻结基准凭什么「不随现树漂」
 *
 * 六条各自可核的凭据，缺任何一条判据⑬当场变红并点名（前两条是 C29 加的）：
 *   1. **夹具在、且对得上清单**：夹具目录与它的清单都在，副本里每个文件逐个比对清单里的 sha256，
 *      多了少了改了都算「对不上」——夹具就是被删/被改也**不静默退化**，而是红并点名；
 *   2. **夹具与现树不同源**：夹具里那三个引擎模块的摘要逐个与现树同名文件比，相同即「基准与现树同源」。
 *      这一条与上一条分开：把夹具换成现树那一份，两条会同时亮；反过来若有人连清单一起按现树重写，
 *      上一条会绿而这—条照样亮——所以两条都不能省；
 *   3. **另一个进程**：基准列在一个 `node` 子进程里跑，子进程自报 pid（与父进程不同才算另一个进程）；
 *   4. **另一份代码**：子进程按**绝对路径**从夹具目录 import 引擎，并把三个入口模块文件的路径与
 *      sha256 报回来，与父进程**独立**读夹具算出的摘要逐一比对——现树同名文件的摘要是另一个值；
 *   5. **行为上也不同源**：跑一次「这个引擎认不认 `{old}`」探针（冻结的 0.6.1 不认，现树认），
 *      并把基准列与「现树·旧入参」列**逐条**比对：把基准列改回用现树跑，两列会逐条相同；
 *   6. **夹具没被写**：跑前跑后各拍一次夹具整棵目录的快照（文件集合 + 字节数 + mtime），
 *      有任何变化就红并点出是哪个文件。
 *
 * ## 这份夹具替不了什么
 *
 * 「现树·新契约」那一列跑的仍是**今天的**引擎（C1–C5/C10/C12 还在改它），它量的是「同一份原文上
 * 两种参数编码的差别」，不是「新世界已经建成」。要量「引擎改前 vs 改后」，看冻结基准那一列与现树
 * 两列的差——基准列不会因为引擎继续改而变。
 *
 * 用法：
 *   node src/locator-lab/failure-replay.mjs            # 跑判据（读语料，打印对照表）
 *   node src/locator-lab/failure-replay.mjs --json     # 附机器可读统计
 *   node src/locator-lab/failure-replay.mjs --build    # 从会话日志重建语料（慢，约数分钟）
 *   node src/locator-lab/failure-replay.mjs --show=3   # 附 N 条逐条明细
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 只 import 引擎/壳层**现成的导出**：本单不改它们（C1–C5/C10/C12 正在并发改）。
import { planHunks, applyEditToProvider } from './write-path.mjs'
/**
 * 「现树·新契约」列用的 provider —— **就是 CLI / MCP 那一个**（`lib/ops.mjs` 里
 * `createNodeFsProvider({ resolveRoot })` 造出来的同一个函数）。不自造一个只够
 * `applyEditToProvider` 跑通的简化版：那样量到的就只是引擎自己，而不是工具实际跑的那条路 ——
 * 原子落盘、版本令牌（CAS）、回读校验就都不在这条路上了。
 *
 * 这个模块只 import node 内置模块（fs / path / crypto），在 src 布局下也能直接加载。
 */
import { createNodeFsProvider } from '../aura-standalone/lib/fs-provider.mjs'
import { locate } from './locator-api.mjs'
import { readWith } from './read-core.mjs'
import { flatHunk, lineRangeOf, asLinePair } from './args.mjs'
import { normSpace } from './anchor-core.mjs'
import { contextServices } from './mock-ctx.mjs'

/**
 * 「现树」这份引擎的入口：新契约列、以及「现树·旧入参」列用它。
 *
 * 引擎在下面被当成**参数**传（`replayOldWith` / `probeEngineOldContract`）而不是直接引用 —— 因为
 * 冻结基准列要在**子进程**里把同一个函数指向副本那份引擎（见 `loadFrozenEngine`）。两个引擎只差
 * 一个参数，分类口径就不可能悄悄分叉。
 */
const LOCAL_ENGINE = { planHunks, readWith, locate, origin: new URL('./write-path.mjs', import.meta.url).href }

/** 基准引擎要报回来的入口模块（它们自己再 import 同目录的兄弟，模块图整块落在副本里）。 */
const FROZEN_ENGINE_MODULES = ['write-path.mjs', 'read-core.mjs', 'locator-api.mjs']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')

/**
 * 「冻结基准」的存放点：仓库内一份**只读夹具**，不在升级路径上。
 *
 * 这个落点换过两回，两回的教训都写在这儿：
 *   · 第一版读的是安装副本 `C:\Users\cxk\.aura\pkg\node_modules\aura-basetools`。那正是升级
 *     要覆盖的目标 —— 波 8 把它刷新成现树之后，基准列与「现树·旧入参」列当场逐条同源，
 *     判据⑬如实打红。基准的全部价值就在「不随现树漂移」，所以它**不能住在会被升级改写的目录里**。
 *   · `previous/aura-basetools` 也不行：那是 `--rollback` 的对调目标，下一次回滚就被换掉。
 *
 * 现在的落点 `aura-tools/fixtures/frozen-engine-0.6.1-217798da/` 逐字节等于升级前那一份现网
 * （树哈希 217798da5117…；来历、复算方式、维护规则见 `fixtures/README.md`）。
 * 只读引用：读它的模块、算它的摘要、拍它整棵目录的快照——一个字节都不写（判据⑬）。
 */
const FROZEN_FIXTURE_NAME = 'frozen-engine-0.6.1-217798da'
export const FROZEN_BASELINE_ROOT = path.resolve(HERE, '../../fixtures', FROZEN_FIXTURE_NAME)
/**
 * 夹具的清单：**副本的兄弟文件**，不参与副本自己的树哈希（塞进副本里「逐字节副本」就复算不出来了）。
 * 探针每次跑都逐文件核对它；夹具被改写、被换成现树，都是从这里最先看出来。
 */
export const FROZEN_MANIFEST_PATH = path.resolve(HERE, '../../fixtures', `${FROZEN_FIXTURE_NAME}.json`)
const CORPUS_PATH = path.join(HERE, 'failure-corpus.json')
const CSV_PATH = path.join(REPO, 'tmp/session-log-scan/out/aura-calls.csv')
const SESSIONS_ROOT = 'C:\\Users\\cxk\\.dsh\\sessions'

/** 语料目标：每类的抽样上限。合计 ≥ 300，且七类都要有。 */
const SAMPLING = {
  S: 90,
  W: 80,
  D: 60,
  N: 60,
  ambiguity: 50,
  coordinate: 50,
  params: 40,
  other: 20,
}
/** 判据要求覆盖的七类（`other` 是长尾，不参与覆盖判定）。 */
const REQUIRED_CLASSES = ['S', 'W', 'D', 'N', 'ambiguity', 'coordinate', 'params']
const MIN_ENTRIES = 300

const KLASS_LABEL = {
  S: 'S  引文是区间原文的子串',
  W: 'W  区间比引文窄',
  D: 'D  前 12 字符内分歧',
  N: 'N  长前缀一致、中间有改动',
  ambiguity: '歧义 线索不唯一/找不到',
  coordinate: '坐标 越界/重叠/缺地址',
  params: '参数 JSON 非法/schema 不符',
  other: '其他 长尾（事务未提交等）',
}

/** 单条语料里原文/替换文本的存储上限：语料是**证据**不是仓库，超了截断并标注。 */
const REPLACE_CAP = 800
const SOURCE_CAP = 12000
/**
 * 脚手架的体积上限比整份文件宽——这是**量出来的，不是拍的**。
 *
 * 快照脚手架里绝大部分是空行占位（行号对齐要的），而它比回执实证多出来的那部分
 * 正是受寻址区间上下那几行**真文本**：`W`（区间比引文窄）那类失败里引文横跨到区间外面，
 * 只有脚手架里那几行是真的才找得到。两处共用一个上限时，W 的成功数从 33 掉到 10
 * （实测那一轮的读数）。多出来的字节买的就是这个。
 */
const SCAFFOLD_CAP = 30000
const EXCERPT_CAP = 2400
const SCAFFOLD_MAX_LINES = 60000
const RANGE_SPAN_CAP = 400

// ── 0. zstd 多帧读取（照抄 tmp/session-log-scan/zstd-read.mjs，那份文件不动） ──

const ZSTD_MAGIC = 0xfd2fb528
const SKIP_BASE = 0x184d2a50

function splitFrames(buf) {
  const frames = []
  let off = 0
  while (off + 4 <= buf.length) {
    const word = buf.readUInt32LE(off)
    if (word === ZSTD_MAGIC) {
      const len = frameLength(buf, off)
      frames.push({ off, len })
      off += len
    } else if ((word & 0xfffffff0) === SKIP_BASE) {
      const size = buf.readUInt32LE(off + 4)
      off += 8 + size
    } else {
      const next = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off + 1)
      if (next < 0) break
      off = next
    }
  }
  return frames
}

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

function readJsonl(file) {
  const buf = fs.readFileSync(file)
  const frames = splitFrames(buf)
  const out = []
  for (const f of frames) {
    const slice = buf.subarray(f.off, f.off + f.len)
    const text = zstdDecompressSync(slice).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch (e) {
        out.push({ __parseError: e.message, raw: line.slice(0, 200) })
      }
    }
  }
  return { records: out, frameCount: frames.length, bytes: buf.length }
}

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
  return out
}

// ── 1. 归类口径（与 tmp/session-log-scan/final.mjs 同一套，便于与 CSV 对账） ──

function classifyReceipt(txt) {
  const t = (txt ?? '').split('\n')[0]
  if (!t) return 'unknown'
  if (/interrupted after it was recorded/.test(t)) return '中断：无结果落盘'
  if (/^Error: READ_BAD_RANGE/.test(t)) return 'READ 行范围非法'
  if (/^Error: READ_NO_RANGE/.test(t)) return 'READ 缺范围'
  if (/^Error: READ_OUT_OF_RANGE/.test(t)) return 'READ 起点越界'
  if (/^Error: READ_AMBIGUOUS/.test(t)) return 'READ 线索不唯一'
  if (/^Error: READ_NOT_FOUND/.test(t)) return 'READ 线索找不到'
  if (/^Error: cannot read .*: not found/.test(t)) return 'READ 文件不存在'
  if (/^Error: invalid arguments: "arguments" must be an object/.test(t)) return '参数 JSON 非法（模型侧）'
  if (/^Error: .*got unknown argument/.test(t)) return '参数名不认识（模型侧）'
  if (/^Error: invalid arguments:/.test(t)) return '参数 schema 不符（模型侧）'
  if (/returned invalid output/.test(t)) return '工具输出不合 schema'
  if (/^Error: .*appears on \d+ lines/.test(t) || /matched \d+ (times|symbols)/.test(t)) return 'EDIT 线索不唯一（拒绝猜）'
  const via = /via ([A-Za-z_\- ]+?) do not match assert/.exec(t)
  if (via) return `EDIT 断言不符：${via[1].trim()}`
  if (/^Error: anchor not found/.test(t)) return 'EDIT 锚点找不到'
  if (/^Error: cannot write .*file access denied/.test(t)) return '写盘被沙箱拒绝'
  if (/^Error: cannot patch/.test(t)) return 'EDIT 事务未提交'
  if (/^Error: hunks overlap/.test(t)) return 'EDIT hunk 重叠'
  if (/^Error: .*needs one of|^Error: provide one of/.test(t)) return 'EDIT 缺定位器（模型侧）'
  if (/^Error: hunks must be a non-empty array/.test(t)) return 'EDIT hunks 为空（模型侧）'
  if (/^Error: cannot address .* by target/.test(t)) return 'EDIT target 不可寻址'
  if (/^Error: no symbol matching/.test(t)) return 'EDIT symbol 找不到'
  if (/^Error: no line contains/.test(t)) return 'EDIT real 找不到'
  if (/is outside 1\.\./.test(t)) return 'EDIT 行范围越界'
  if (/needs a recognized file extension/.test(t)) return 'EDIT target 无扩展名'
  return '其他：' + t.slice(0, 70)
}

/**
 * 失败类别 → 语料分层。七类是判据点名的口径，`mismatch` 是待细分的中间态
 * （再由引文与原文的关系落到 S/W/D/N）。
 */
function bucketOf(errorClass) {
  if (/^参数/.test(errorClass) || /hunks 为空/.test(errorClass) || /工具输出不合 schema/.test(errorClass)) {
    return 'params'
  }
  if (/缺定位器/.test(errorClass)) return 'coordinate' // 判据把"缺定位器"算坐标类
  if (/行范围越界|hunk 重叠|READ 行范围非法|READ 起点越界|READ 缺范围|target 不可寻址|target 无扩展名/.test(errorClass)) {
    return 'coordinate'
  }
  if (/线索不唯一|锚点找不到|real 找不到|symbol 找不到/.test(errorClass)) return 'ambiguity'
  if (/断言不符/.test(errorClass)) return 'mismatch'
  return 'other'
}

// ── 2. 从日志里挖"当时的原文片段" ──

/**
 * 成功 `aura_read` 的回执里，正文是 `行号: 文本`；把这一份按行号收起来，
 * 就是**当时那份文件的局部快照**。非正文行（信封、符号目录、省略说明）不匹配这个形状，
 * 自然被跳过——这正是选择"行号: "而不是"尽量解析"的理由：**宁可少收，不可收错行**。
 */
function lineMapFromReceipt(text) {
  const map = new Map()
  let version = null
  const lines = String(text ?? '').split('\n')
  const head = /^version:\s*(\S+)/.exec(lines[0] ?? '')
  if (head) version = head[1]
  for (const line of lines) {
    const g = /^(\d+): ?([\s\S]*)$/.exec(line)
    if (!g) continue
    const n = Number(g[1])
    if (!Number.isInteger(n) || n < 1) continue
    if (!map.has(n)) map.set(n, g[2])
  }
  return { map, version }
}

/** 回执里"the content there is: “…”"引出的**实证原文**（换行写成 ⏎，末尾可能截断）。 */
function quotedActual(text) {
  const m = /the content there is: “([\s\S]*?)”/.exec(String(text ?? ''))
  if (!m) return null
  const body = m[1]
  if (/…\s*$/.test(body) || /\(\d+ more chars\)/.test(body)) return null // 截断的不当实证
  return body.split('⏎').join('\n')
}

// ── 3. 寻址参数的搬运（**不实现寻址**，只把原参数喂给引擎现有入口） ──

function hunksOf(args) {
  if (Array.isArray(args?.hunks)) return args.hunks.filter((h) => h && typeof h === 'object')
  const flat = flatHunk(args)
  return flat ? [flat] : []
}

/** 与 `planHunks` 内部那次 `locate(...)` 同一张映射表（不含 assert：分类要的是原文）。 */
function legacyRequest(hunk, filePath) {
  if (!hunk || typeof hunk !== 'object') return null
  const hasTarget = typeof hunk.target === 'string' && hunk.target.trim().length > 0
  const range = lineRangeOf(hunk)
  const hasCue = typeof hunk.line_cue === 'string' && hunk.line_cue.trim().length > 0
  const hasAnchor = typeof hunk.anchor === 'string' && hunk.anchor.length > 0
  if (!hasTarget && range === undefined && !hasCue && !hasAnchor) return null
  return {
    ...(hasTarget ? { target: hunk.target } : {}),
    ...(range === undefined ? {} : { lines: range }),
    ...(hunk.line_cue === undefined ? {} : { lineCue: hunk.line_cue }),
    ...(hasTarget || range !== undefined || hunk.line_cue !== undefined ? {} : { anchor: hunk.anchor }),
    ...(hunk.near === undefined ? {} : { near: hunk.near }),
    ...(filePath == null ? {} : { filePath }),
  }
}

/** 读侧请求：照抄 `aura-read/index.js` 构造 request 的那几行。 */
function readRequest(args, filePath) {
  const range = lineRangeOf(args)
  return {
    filePath,
    ...(args?.mode === undefined ? {} : { mode: args.mode }),
    ...(args?.around === undefined ? {} : { around: args.around }),
    // 读侧的 renderLines 只认数组 [start,end]（写侧的 locate 才认 {start,end}）。
    ...(range === undefined ? {} : { lines: asLinePair(range) }),
    ...(args?.search === undefined ? {} : { search: args.search }),
    ...(args?.context === undefined ? {} : { context: args.context }),
    ...(args?.kind === undefined ? {} : { kind: args.kind }),
  }
}

/** 条目要用的"引文"：新契约的 `old` 从这里来。 */
/**
 * 条目要用的"引文"（新契约的 `old` 从这里来）——**由那一个 hunk 自己给**。
 *
 * 「聚焦 hunk」必须全程只有一份：关系（S/W/D/N）取自哪个 hunk 的 expect，
 * 重放就得用哪个 hunk 的引文。两处各挑一次，挑到不同 hunk（多 hunk 调用里很常见），
 * 分类与重放看的就不是同一件事了——那种表看着合理，其实每一格都对不上号。
 */
function focusIndexOf(hunks) {
  for (const key of ['expect', 'anchor', 'line_cue']) {
    const i = hunks.findIndex((h) => typeof h?.[key] === 'string' && h[key].length > 0)
    if (i >= 0) return i
  }
  const t = hunks.findIndex((h) => typeof h?.target === 'string' && h.target.trim().length > 0)
  return t >= 0 ? t : 0
}

/** 单个 hunk 的引文：`expect` 优先（S/W/D/N 说的就是它），再看锚点与线索。 */
function quoteOfHunk(h) {
  if (!h || typeof h !== 'object') return null
  for (const key of ['expect', 'anchor', 'line_cue']) {
    if (typeof h[key] === 'string' && h[key].length > 0) return { kind: key, text: h[key] }
  }
  if (typeof h.target === 'string' && h.target.trim().length > 0) return { kind: 'target', text: h.target }
  return null
}

/**
 * 引文与原文的关系——S/W/D/N 的判据本体。
 * `contains` → S（引文是区间原文的子串）、`contained` → W（区间比引文窄）、
 * 前 12 字符就分歧 → D、长前缀一致但中间有改动 → N。
 */
function relationOf(quote, actual) {
  const q = normSpace(String(quote))
  const a = normSpace(String(actual))
  if (q === a) return 'equal'
  if (a.includes(q)) return 'contains'
  if (q.includes(a)) return 'contained'
  const n = Math.min(q.length, a.length)
  let i = 0
  while (i < n && q[i] === a[i]) i += 1
  return i < 12 ? 'diverge12' : 'mid-change'
}

const RELATION_KLASS = { contains: 'S', contained: 'W', diverge12: 'D', 'mid-change': 'N' }

// ── 4. 建语料 ──────────────────────────────────────────────────────────────

function buildCorpus(log = console.error) {
  const files = walkSessions(SESSIONS_ROOT)
  log(`扫会话日志：${files.length} 个 session.v3.jsonl.zstd`)

  const candidates = []
  const csvCounts = new Map()
  let sessionsWithCalls = 0
  let seenFiles = 0

  for (const file of files) {
    seenFiles += 1
    if (seenFiles % 200 === 0) log(`  … ${seenFiles}/${files.length}`)
    let records
    try {
      ({ records } = readJsonl(file))
    } catch {
      continue
    }
    const order = records.filter(
      (r) => r.type === 'tool/call' && (r.data?.name === 'aura_read' || r.data?.name === 'aura_edit'),
    )
    if (!order.length) continue
    sessionsWithCalls += 1
    const header = records.find((r) => r.type === 'session') ?? {}
    const lastResult = new Map()
    const callById = new Map()
    for (const r of order) callById.set(r.data.callId, r)
    for (const r of records) {
      if (r.type !== 'tool/result') continue
      const cid = r.data?.message?.source?.callId
      if (!cid || !callById.has(cid)) continue
      lastResult.set(cid, r)
    }

    // 逐调用顺序推进：成功的 read 把行号快照并进 accumulator，失败点就地取证。
    const snaps = new Map() // filePath → {map, version, freshLine}
    for (const call of order) {
      const res = lastResult.get(call.data.callId)
      const isError = Boolean(res?.data?.message?.content?.[0]?.isError)
      const txt = res?.data?.message?.content?.[0]?.content?.[0]?.text ?? ''
      let args = null
      try {
        args = JSON.parse(call.data.arguments)
      } catch {
        args = null
      }
      const fp = typeof args?.file_path === 'string' ? args.file_path : ''
      if (!isError && call.data.name === 'aura_read' && fp) {
        const { map, version } = lineMapFromReceipt(txt)
        if (map.size > 0) {
          const cur = snaps.get(fp) ?? { map: new Map(), version: null }
          for (const [n, t] of map) cur.map.set(n, t) // 后读覆盖先读：越靠近失败越新
          if (version) cur.version = version
          snaps.set(fp, cur)
        }
        continue
      }
      if (!isError) continue
      const errorClass = classifyReceipt(txt)
      csvCounts.set(errorClass, (csvCounts.get(errorClass) ?? 0) + 1)
      candidates.push({
        t: new Date(call.time).toISOString(),
        sessionId: header.id ?? '',
        cwd: header.cwd ?? '',
        tool: call.data.name,
        args,
        rawArgs: call.data.arguments,
        receipt: txt,
        receiptFirstLine: String(txt).split('\n')[0] ?? '',
        errorClass,
        snap: fp ? snaps.get(fp) ?? null : null,
      })
    }
  }
  log(`失败调用（从原始事件数出来）：${candidates.length}；有调用的会话 ${sessionsWithCalls}`)

  // ── 逐条取证：重放原文 + S/W/D/N 细分 ──
  const entries = []
  for (const c of candidates) {
    const entry = shapeEntry(c)
    if (entry) entries.push(entry)
  }
  log(`可成形条目：${entries.length}（其余为无参数/无法归类的长尾）`)

  const picked = stratify(entries)
  const stats = {}
  for (const k of Object.keys(SAMPLING)) {
    const all = entries.filter((e) => e.klass === k)
    stats[k] = { available: all.length, picked: picked.filter((e) => e.klass === k).length }
  }
  const corpus = {
    schema: 'aura-failure-corpus/1',
    builtAt: new Date().toISOString(),
    sources: {
      calls: 'tmp/session-log-scan/out/aura-calls.csv（对账用）',
      events: 'C:\\Users\\cxk\\.dsh\\sessions\\**\\session.v3.jsonl.zstd（原始事件，多帧 zstd）',
      sessionsScanned: files.length,
      failuresSeen: candidates.length,
    },
    sampling: SAMPLING,
    available: stats,
    entries: picked,
  }
  reconcileCsv(csvCounts, candidates, log)
  fs.writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 1), 'utf8')
  log(`语料已落盘：${CORPUS_PATH}（${picked.length} 条，${(fs.statSync(CORPUS_PATH).size / 1024).toFixed(0)} KB）`)
  return corpus
}

/** 把一条失败调用变成语料条目；拿不到任何原文则标 drifted。 */
/**
 * 把一条失败调用变成语料条目。
 *
 * 重放原文的 ladder（要的是「当时那几行的逐字原文」，不是「随便一份能跑的文件」）：
 *   1. `log`     —— 失败前同会话对同一文件的成功 `aura_read` 回执，按行号拼回快照；
 *   2. `receipt` —— 回执自己引出的实证原文（`the content there is: “…”`），
 *                   铺在回执报出的行号上。它是断言不符那条路径**逐字吐出来的区域原文**，
 *                   因此受寻址区间与历史逐字相同，失败能原样复现；
 *   3. `disk`    —— 今天磁盘上的那份文件（整份）。歧义/坐标/参数类走这条：
 *                   「唯一不唯一、越界不越界」要的是整份文件语义，不是那几行；
 *   4. 三条都拿不到 ⇒ `drifted`，不计入成功/失败分母。
 *
 * `source.fidelity`：`exact` = 受寻址区间是历史原文（log / receipt）；`live` = 今日文本。
 */
function shapeEntry(c) {
  const hunks = hunksOf(c.args)
  const bucket = bucketOf(c.errorClass)
  const fp = typeof c.args?.file_path === 'string' ? c.args.file_path : ''
  // 聚焦 hunk：分类、引文、重放三处都只用它——多 hunk 调用里挑到不同的 hunk，
  // 表面上每格都填了数，实际上分类与重放说的不是同一件事。
  const focus = focusIndexOf(hunks)
  const focusHunk = hunks[focus] ?? null
  const expect = typeof focusHunk?.expect === 'string' && focusHunk.expect.length > 0 ? focusHunk.expect : null
  const quote = quoteOfHunk(focusHunk)

  const receiptActual = quotedActual(c.receipt)
  const snapSource = scaffoldFromSnap(c.snap, hunks)
  const receiptSource = scaffoldFromReceipt(c, receiptActual)
  const diskSource = readToday(fp, hunks)

  // 错配类要的是「当时那几行」（快照 → 回执实证）；其余要的是整份文件语义（今日磁盘）。
  const order =
    bucket === 'mismatch' ? [snapSource, receiptSource, diskSource] : [diskSource, snapSource, receiptSource]
  const source = order.find((s) => s !== null) ?? null

  // S/W/D/N 优先由**重放原文**解析：分类与重放看同一份文本，表里那句「旧契约失败」
  // 才对得上是同一个失败。重放原文解析不出来时才退回回执实证。
  let actual = null
  let actualFrom = null
  if (source !== null) {
    const req = legacyRequest(focusHunk, source.path)
    const res = req === null ? null : locateQuiet(source.text, req)
    if (res?.ok) {
      actual = res.actual
      actualFrom = source.kind
    }
  }
  if (actual === null && receiptActual !== null) {
    actual = receiptActual
    actualFrom = 'receipt'
  }

  let klass = bucket === 'mismatch' ? null : bucket
  let relation = null
  if (bucket === 'mismatch' && expect !== null && actual !== null) {
    relation = relationOf(expect, actual)
    klass = RELATION_KLASS[relation] ?? 'other'
  } else if (bucket === 'mismatch') {
    klass = 'other'
  }

  const drift = {
    fileExistsToday: diskSource !== null,
    quoteInToday: diskSource !== null && quote !== null ? diskSource.text.includes(quote.text) : null,
    quoteInSource: source !== null && quote !== null ? source.text.includes(quote.text) : null,
  }

  return {
    id: '', // 抽样后统一编号
    klass,
    errorClass: c.errorClass,
    tool: c.tool,
    at: c.t,
    sessionId: c.sessionId,
    file: fp,
    receiptFirstLine: c.receiptFirstLine,
    receiptChars: c.receipt.length,
    args: trimArgs(c.args),
    hunks: hunks.map(trimHunk),
    focus,
    quote,
    evidence: { actual: actual === null ? null : clip(actual, EXCERPT_CAP), from: actualFrom, relation },
    drift,
    source:
      source === null
        ? null
        : {
            kind: source.kind,
            path: source.path,
            fidelity: source.kind === 'disk' ? 'live' : 'exact',
            truncated: source.truncated === true,
            lineCount: source.text.split('\n').length,
            text: source.text,
          },
    excerpt: buildExcerpt(source, hunks, quote),
    replayable: source !== null,
    drifted: source === null,
  }
}

/**
 * 回执实证原文 → 重放原文。
 *
 * 只在**行寻址**时成立，并且要求实证原文的行数与回执报出的区间行数一致——
 * 对得上才铺（对不上说明引文被截断过，宁可不铺也不铺错行）。其余行留空行占位：
 * 行号对齐是这类重放的全部要求，而空行永远不会冒充引文。
 */
function scaffoldFromReceipt(c, receiptActual) {
  if (receiptActual === null) return null
  const m = /^Error: lines (\d+)-(\d+) via /.exec(c.receiptFirstLine)
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null
  if (end - start + 1 > RANGE_SPAN_CAP) return null
  const body = receiptActual.split('\n')
  if (body.length !== end - start + 1) return null
  const arr = new Array(end).fill('')
  for (let i = 0; i < body.length; i += 1) arr[start - 1 + i] = body[i]
  return { kind: 'receipt', path: null, text: arr.join('\n'), version: null }
}


/** 用引擎自己的定位器取区间原文；定位不到是正常结果（不吞实现 bug）。 */
function locateQuiet(text, request) {
  try {
    return locate(text, request)
  } catch {
    return null
  }
}

/** 用行号快照拼出**当时的**那一份文本（只覆盖快照含有的行；其余留空行占位）。 */
function scaffoldFromSnap(snap, hunks) {
  if (!snap || snap.map.size === 0) return null
  const needed = []
  let maxLine = 0
  for (const h of hunks) {
    const range = lineRangeOf(h)
    if (range === undefined) continue
    const { start: s, end: e } = range
    if (!Number.isInteger(s) || !Number.isInteger(e) || e < s || e - s > RANGE_SPAN_CAP) return null
    for (let i = s; i <= e; i += 1) needed.push(i)
    maxLine = Math.max(maxLine, e)
  }
  if (needed.length === 0) {
    // 线索类地址：快照里得找得到那条线索，否则覆盖无从谈起
    for (const h of hunks) {
      const cues = [h.line_cue, h.anchor].filter((v) => typeof v === 'string' && v.length > 0)
      for (const cue of cues) {
        for (const [n, t] of snap.map) {
          if (t.includes(cue)) {
            needed.push(n)
            maxLine = Math.max(maxLine, n)
          }
        }
      }
    }
    if (needed.length === 0) return null
  }
  if (needed.some((n) => !snap.map.has(n))) return null // 受寻址区间没被快照覆盖：不冒充原文
  for (const n of snap.map.keys()) maxLine = Math.max(maxLine, Math.min(n, SCAFFOLD_MAX_LINES))
  if (maxLine > SCAFFOLD_MAX_LINES) return null
  const arr = new Array(maxLine).fill('')
  for (const [n, t] of snap.map) if (n >= 1 && n <= maxLine) arr[n - 1] = t
  const text = arr.join('\n')
  // 脚手架也守同一个体积上限：快照可能读到文件的第几万行，而中间绝大部分是空行占位——
  // 那不携带信息却能把语料撑胖；但上下那几行真文本不能丢（见 SCAFFOLD_CAP 处的实测），
  // 所以这里守的是更宽的那个上限。
  if (text.length > SCAFFOLD_CAP) return null
  return { kind: 'log', path: null, text, version: snap.version }
}

/**
 * 今日磁盘上的那份文件。
 *
 * 大文件**只在盖得住受寻址区间时**按行边界截断：截断保住前面每一行的行号，
 * 因此按行寻址仍然逐字对齐；盖不住（或地址不是行）就不截——那种情况下
 * 「唯一不唯一」这类语义会被截断悄悄改掉，宁可退到下一个来源甚至标 drifted。
 */
function readToday(fp, hunks) {
  if (!fp) return null
  let text
  try {
    const st = fs.statSync(fp)
    if (!st.isFile()) return null
    text = fs.readFileSync(fp, 'utf8')
  } catch {
    return null
  }
  if (text.length <= SOURCE_CAP) return { kind: 'disk', path: fp, text, version: null }
  const need = maxAddressedLine(hunks)
  if (need === null) return null
  const cut = text.lastIndexOf('\n', SOURCE_CAP)
  if (cut <= 0) return null
  const head = text.slice(0, cut)
  if (head.split('\n').length < need) return null
  return { kind: 'disk', path: fp, text: head, version: null, truncated: true }
}

/** 所有 hunk 里最大的行号；只要有一个 hunk 不是行寻址就返回 null（不假装盖得住）。 */
function maxAddressedLine(hunks) {
  let max = null
  for (const h of hunks) {
    const r = lineRangeOf(h)
    if (r === undefined) return null
    max = Math.max(max ?? 0, r.end)
  }
  return max
}


function buildExcerpt(source, hunks, quote) {
  if (!source) return null
  const lines = source.text.split('\n')
  const base = lines.findIndex((l) => (quote ? l.includes(quote.text) : false))
  let from = base
  if (from < 0) {
    for (const h of hunks) {
      const range = lineRangeOf(h)
      if (range !== undefined) {
        from = range.start - 1
        break
      }
    }
  }
  if (from < 0) from = 0
  const start = Math.max(0, from - 6)
  const body = lines.slice(start, start + 40).join('\n')
  return { from: source.kind, baseLine: start + 1, text: clip(body, EXCERPT_CAP) }
}

function clip(text, cap) {
  const s = String(text)
  return s.length <= cap ? s : `${s.slice(0, cap)}…(+${s.length - cap} chars)`
}

function trimHunk(h) {
  const out = {}
  for (const [k, v] of Object.entries(h)) {
    if (k === 'replace' && typeof v === 'string' && v.length > REPLACE_CAP) {
      out.replace = clip(v, REPLACE_CAP)
      out.replaceTruncatedAt = REPLACE_CAP
    } else out[k] = v
  }
  return out
}

/**
 * 存进语料的调用参数：**hunk 本体只存一份**。
 *
 * `args.hunks` 与条目顶层的 `hunks` 是同一份东西，存两遍会让语料凭空胖一倍，
 * 而 hunk 参数（`expect` / `lines` / `line_cue` / `anchor` / `target` / `replace`）
 * 已经逐字存在顶层的 `hunks` 里，一个字段都没少。
 */
function trimArgs(args) {
  if (args === null || typeof args !== 'object') return null
  const { hunks, ...rest } = args
  return Array.isArray(hunks) ? { ...rest, hunkCount: hunks.length } : { ...rest }
}

/** 分层抽样：同类内按时间等距取，先取有重放原文的，并做参数签名去重。 */
function stratify(entries) {
  const picked = []
  for (const [klass, cap] of Object.entries(SAMPLING)) {
    const pool = entries.filter((e) => e.klass === klass)
    if (pool.length === 0) continue
    const fresh = pool.filter((e) => e.replayable)
    const stale = pool.filter((e) => !e.replayable)
    // 可重放的排前面：无原文的条目只用来证明"漂移"存在，不该占满配额。
    const ordered = [...fresh, ...stale]
    const seen = new Set()
    const take = []
    const stride = Math.max(1, Math.floor(ordered.length / cap))
    for (let i = 0; i < ordered.length && take.length < cap; i += stride) {
      const e = ordered[i]
      const sig = `${e.file}|${JSON.stringify(e.hunks)}`
      if (seen.has(sig)) continue
      seen.add(sig)
      take.push(e)
    }
    for (let i = 0; i < ordered.length && take.length < cap; i += 1) {
      const e = ordered[i]
      const sig = `${e.file}|${JSON.stringify(e.hunks)}`
      if (seen.has(sig)) continue
      seen.add(sig)
      take.push(e)
    }
    take.sort((a, b) => (a.at < b.at ? -1 : 1))
    picked.push(...take)
  }
  picked.sort((a, b) => (a.at < b.at ? -1 : 1))
  picked.forEach((e, i) => {
    e.id = `F${String(i + 1).padStart(4, '0')}`
  })
  return picked
}

/** 与 CSV 对账：同一批日志、两套口径，数量应同量级。 */
function reconcileCsv(csvCounts, candidates, log) {
  const fromCsv = readCsvFailureCounts()
  if (fromCsv === null) {
    log('对账：CSV 读不到，跳过（不影响语料）')
    return
  }
  const mine = new Map()
  for (const c of candidates) mine.set(c.errorClass, (mine.get(c.errorClass) ?? 0) + 1)
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0)
  log(`对账：CSV 失败 ${sum(fromCsv)} 条 / 原始事件失败 ${sum(mine)} 条`)
  const keys = new Set([...fromCsv.keys(), ...mine.keys()])
  let drift = 0
  for (const k of keys) {
    const a = fromCsv.get(k) ?? 0
    const b = mine.get(k) ?? 0
    if (Math.abs(a - b) > Math.max(2, a * 0.05)) {
      drift += 1
      if (drift <= 6) log(`  · 对不上：${k}  CSV=${a} 事件=${b}`)
    }
  }
  if (drift) log(`  （${drift} 个类别对不上，多为口径边界；不影响语料可用性）`)
  void csvCounts
}

/**
 * 从 CSV 里数一遍失败——**只用来对账**，不当语料源：CSV 是同一批日志的另一个口径，
 * 它没有原始 hunk 参数，重放要的那些只有原始事件里有。
 *
 * 列序是 `…,ok,errorClass,receiptChars`，而 `cwd` / 错误话术里都可能带逗号，
 * 所以从**右边**认：最后一列是纯数字的 receiptChars，倒数第二列是 0/1，
 * 再往左才是 errorClass。
 */
function readCsvFailureCounts() {
  let text
  try {
    text = fs.readFileSync(CSV_PATH, 'utf8')
  } catch {
    return null
  }
  const counts = new Map()
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    const parts = line.split(',')
    if (parts.length < 6) continue
    if (!/^\d+$/.test(parts[parts.length - 1])) continue
    const ok = parts[parts.length - 3]
    if (ok !== '0' && ok !== '1') continue
    if (ok === '1') continue
    const errorClass = parts[parts.length - 2]
    if (!errorClass || /^\d+$/.test(errorClass)) continue
    counts.set(errorClass, (counts.get(errorClass) ?? 0) + 1)
  }
  return counts
}

// ── 5. 重放 ────────────────────────────────────────────────────────────────

const OUTCOME = {
  ok: 'ok',
  fail: 'fail',
  needsChoice: 'needs_choice',
  /**
   * 编排层的**第四态**（C49）：`old` 两层都找不到，而 `replace` 已经整行唯一地在原文里
   * ⇒ 「你要的结果已经是文件现在的样子，这次不用改」，一个字节都不写。
   * 它既不是 ok（没寻到址、也没落盘），也不是 fail（调用想要的结果已经在那儿了），所以**单列一格**。
   */
  alreadyApplied: 'already_applied',
  notReady: 'not_ready',
  na: 'na',
  unrepresentable: 'unrepresentable',
}

/**
 * 一列的显示口径：ok / fail / 需选择 / 已落地 / 无从表达 / 无对应入口 —— 六个数都**按 OUTCOME 常量取键**。
 *
 * C51 把第四态（`already_applied`）加进来时要**同时改三处**：这个函数、`columnCell`、`columnSum`；
 * 判据④的分桶和拿的就是它们，只改两处会当场红（「某一格数漏了」正是它要抓的形状）。
 *
 * 表里的格子、附表、以及判据里的分桶和都读这一个函数。C11 段A 修的就是这一处：`neuCell` 当时读的是
 * `n.needsChoice`，而计数桶的键来自 OUTCOME 的 `'needs_choice'`，于是 8 条「需选择」在表里恒显示 0。
 * 现在键名只有一个来源（OUTCOME），写错就会同时让格子印 0、让分桶和对不上，判据当场点名。
 */
function columnOf(tally) {
  const at = (key) => Number(tally?.[key] ?? 0)
  return {
    ok: at(OUTCOME.ok),
    fail: at(OUTCOME.fail),
    needsChoice: at(OUTCOME.needsChoice),
    // C51：第四态在这一格里**必须有自己的位置**。少了它，`already_applied` 会从分桶和里漏掉
    // （判据④当场红并点名），而不是静默地并进 ok/fail 里的某一个。
    alreadyApplied: at(OUTCOME.alreadyApplied),
    unrepresentable: at(OUTCOME.unrepresentable),
    na: at(OUTCOME.na),
  }
}

/**
 * 一格：`ok / fail / 需选择 / 已落地 / 无从表达 / 无对应入口`。0 印成 `—`——该契约结构上没有这一态。
 *
 * 顺序与 `columnOf` 的键序、`columnSum` 的加法、表下的图例**逐字同序**：这一格是给人横着比
 * 三列的，某一处自己改个序，读表的人就会把「已落地」看成「无从表达」。
 */
function columnCell(c) {
  const dash = (n) => (n === 0 ? '—' : n)
  return `${c.ok} / ${c.fail} / ${dash(c.needsChoice)} / ${dash(c.alreadyApplied)} / ${dash(c.unrepresentable)} / ${dash(c.na)}`
}

/** 一列的分桶之和：必须恰好等于这一列跑的条数（判据靠它抓「某一格数漏了/键名写错了」）。 */
function columnSum(c) {
  return c.ok + c.fail + c.needsChoice + c.alreadyApplied + c.unrepresentable + c.na
}

/**
 * 引擎侧新入口探针：`planHunks` 认不认 `{old}`。不认就如实报"接口未就绪"。
 *
 * 引擎是参数：对「现树」问一次，对「冻结夹具」也问一次 —— 两边的答案不同，本身就是
 * 「基准列不是用现树跑的」的一条行为凭据（判据⑬）。导出它是为了让子进程也能用它问副本。
 */
export function probeEngineOldContract(engine = LOCAL_ENGINE) {
  const probe = 'alpha\nbeta\ngamma\ndelta\nepsilon\n'
  try {
    const out = engine.planHunks(probe, [{ old: 'gamma', replace: 'GAMMA' }], null)
    const got = out?.content
    if (got === 'alpha\nbeta\nGAMMA\ndelta\nepsilon\n') {
      return { ready: true, how: 'planHunks 接受 {old}，且只换了第三行' }
    }
    return { ready: false, how: `planHunks 吃了 {old} 但结果不对：${JSON.stringify(String(got).slice(0, 60))}` }
  } catch (error) {
    const code = error?.code ?? '(无 code)'
    return { ready: false, how: `planHunks 拒绝 {old}：${code} ${String(error?.message ?? error).slice(0, 140)}` }
  }
}

/** 壳层侧探针：`aura_edit` 的 hunk schema 里有没有 `old` / `context`。 */
async function probeShellOldContract() {
  try {
    const plugin = await import('../aura-edit/index.js')
    let registered = null
    const ctx = {
      ...contextServices(),
      tools: { register: (t) => (registered = t) },
      systemPrompt: { section: () => () => {} },
      emit: () => {},
      waterfall: async () => {
        throw Object.assign(new Error('edit requires reading first'), { code: 'FS_NOT_OBSERVED' })
      },
    }
    plugin.apply(ctx)
    const keys = Object.keys(registered?.parameters?.properties?.hunks?.items?.properties ?? {})
    const flatKeys = Object.keys(registered?.parameters?.properties ?? {})
    return {
      ready: keys.includes('old'),
      keys,
      flatKeys,
      how: `aura_edit hunk 键 = [${keys.join(', ')}]`,
    }
  } catch (error) {
    return { ready: false, keys: [], how: `壳层 schema 读不到：${String(error?.message ?? error).slice(0, 140)}` }
  }
}

/** 只读地把重放原文摊到临时目录的副本上——**语料里的路径永不被写**。 */
/** 只读地把重放原文摊到临时目录的副本上——**语料里的路径永不被写**。 */
function stageCopy(entry, tmpDir, index) {
  const ext = path.extname(entry.file) || '.txt'
  const copyPath = path.join(tmpDir, `${entry.id}_${index}${ext}`)
  fs.writeFileSync(copyPath, entry.source.text, 'utf8')
  const content = fs.readFileSync(copyPath, 'utf8')
  const inside = path.relative(tmpDir, copyPath)
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`副本跑到临时目录外：${copyPath}`)
  return { copyPath, content }
}

/**
 * 「现树·新契约」列踩的那份副本：**可写** —— 它走的编排层会真的落盘。
 *
 * 为什么不能与 `stageCopy` 那份共用（这是实打实的顺序依赖，不是洁癖）：冻结基准列在重放**跑完**
 * 之后才在子进程里按 `copyPath` 把文件读回去。新契约列要是在同一份文件上写成一改，基准列读到的
 * 就不是「当时那份原文」了 —— 两列于是量不到同一批原件，而表里看不出任何异常。
 *
 * 同一条目的多次重放各占一个文件（`<id>.<label><ext>`）：主重放与附表（引文取实证原文）是两次
 * 不同的尝试，挤在一个文件上会让第二次打在第一次写过的内容上。限定同一条规矩：只允许落在临时目录里。
 */
function stageToolCopy(entry, tmpDir, label) {
  const ext = path.extname(entry.file) || '.txt'
  const toolPath = path.join(tmpDir, `${entry.id}.${label}${ext}`)
  fs.writeFileSync(toolPath, entry.source.text, 'utf8')
  const inside = path.relative(tmpDir, toolPath)
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`可写副本跑到临时目录外：${toolPath}`)
  return toolPath
}

/**
 * 旧契约重放：原始参数原样交给**给定引擎**的入口（写侧 `planHunks`，读侧 `readWith`）。
 *
 * `engine` 是参数而不是闭包是有意的：「现树·旧入参」与「冻结基准（夹具）」两列跑的就是
 * 这一段代码（父进程 / 子进程各传各的引擎），分类口径因此不可能悄悄分叉。
 */
function replayOldWith(engine, entry, content, copyPath) {
  try {
    if (entry.tool === 'aura_edit') {
      const hunks = (entry.hunks ?? []).filter((h) => h && typeof h === 'object')
      if (hunks.length === 0) return { outcome: OUTCOME.unrepresentable, detail: '没有可搬运的 hunk 参数' }
      engine.planHunks(content, hunks, copyPath)
      return { outcome: OUTCOME.ok, detail: 'planHunks 通过' }
    }
    const req = readRequest(entry.args ?? {}, copyPath)
    const env = engine.readWith(content, req)
    if (env?.ok === false) return { outcome: OUTCOME.fail, detail: `${env.code}`, code: env.code }
    return { outcome: OUTCOME.ok, detail: `${env?.mode ?? 'auto'}` }
  } catch (error) {
    const code = String(error?.code ?? 'THROW')
    return { outcome: OUTCOME.fail, detail: `${code} ${String(error?.message ?? error).slice(0, 90)}`, code }
  }
}

/** 「现树·旧入参」那一列：与 `replayOldWith` 同一个函数，只是引擎换成当前工作树的入口。 */
function replayOld(entry, content, copyPath) {
  return replayOldWith(LOCAL_ENGINE, entry, content, copyPath)
}

// ── 5.5 冻结基准：在独立子进程里跑**仓库内冻结夹具**的引擎 ─────────────────

/** 整棵目录的快照：相对路径 → `d|f:字节数:修改时间`。目录本身也拍（改名/增删文件都看得见）。 */
function snapshotTree(root) {
  const out = new Map()
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      out.set(r, `${e.isDirectory() ? 'd' : 'f'}:${st.size}:${st.mtimeMs}`)
      if (e.isDirectory()) walk(p, r)
    }
  }
  walk(root, '')
  return out
}

/** 两份快照的差，写成给人看的行（判红时点名是哪个文件被动过）。 */
function diffTree(before, after) {
  const diffs = []
  for (const [k, v] of before) {
    const now = after.get(k)
    if (now === undefined) diffs.push(`${k} 消失了`)
    else if (now !== v) diffs.push(`${k} 被改过（${v} → ${now}）`)
  }
  for (const k of after.keys()) if (!before.has(k)) diffs.push(`${k} 是新出现的`)
  return diffs
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readPackageVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '(包没写 version)'
  } catch {
    return '(读不到 package.json)'
  }
}

/** 父进程自己算一遍夹具的引擎摘要 —— 与子进程各算各的，两边对上才算「另一份代码」。 */
export function frozenEngineDigests(root) {
  return FROZEN_ENGINE_MODULES.map((name) => {
    const file = path.join(root, 'locator-lab', name)
    return { file, sha256: sha256File(file) }
  })
}

/** 现树那份引擎的摘要（只用来并排打印）：与副本那份不是同一个值，才叫「另一份代码」。 */
/** 现树那份引擎的摘要（只用来并排打印）：与副本那份不是同一个值，才叫「另一份代码」。 */
function localEngineDigests() {
  return FROZEN_ENGINE_MODULES.map((name) => {
    const file = path.join(HERE, name)
    return { file, sha256: sha256File(file) }
  })
}

/**
 * 夹具自检：清单读不读得到、副本在不在、每个文件对不对得上清单、**是不是被换成了现树**。
 *
 * 三种异常各自是一种**结果**（而不是笼统的「没跑成」），判据⑬按状态分别点名，不许静默退化：
 *   · `missing`    —— 清单或夹具目录不存在（被删了 / 换了工作树）；
 *   · `drifted`    —— 有文件对不上清单，或多了/少了文件（被改写、被换成了别的东西）；
 *   · `sameAsTree` —— 夹具里的引擎模块与**现树同名文件摘要相同**（拿现树刷新了夹具）。
 *
 * `sameSourceFiles` 单列而不是并进 `drifted`：把夹具换成现树那一份时清单必然也对不上，
 * 两条会同时亮；但只有这一条说的是根因——「基准与现树同源」，这一列的价值就此归零。
 * 反过来，若有人连清单一起按现树重写，`status` 会是 ok 而这一条照样亮：两道判据缺一不可。
 */
export function inspectFrozenFixture(root = FROZEN_BASELINE_ROOT, manifestPath = FROZEN_MANIFEST_PATH) {
  const view = {
    status: 'missing',
    root,
    manifestPath,
    manifest: null,
    problems: [],
    fileCount: 0,
    expectedCount: 0,
    missingFiles: [],
    driftedFiles: [],
    extraFiles: [],
    sameSourceFiles: [],
  }
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    view.problems.push(
      `冻结基准夹具的清单读不到：${manifestPath}（${String(error?.message ?? error).slice(0, 120)}）—— 夹具来历无从核对`,
    )
    return view
  }
  view.manifest = manifest
  const expected = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {}
  view.expectedCount = Object.keys(expected).length
  if (!fs.existsSync(root)) {
    view.problems.push(`冻结基准夹具不存在：${root}（清单在、副本没了）`)
    return view
  }
  const actual = {}
  for (const rel of Object.keys(expected)) {
    try {
      actual[rel] = sha256File(path.join(root, rel))
    } catch {
      view.missingFiles.push(rel)
    }
  }
  /** 多出来的文件也算「被动过」：往副本里塞东西同样会让「逐字节副本」这句话失效。 */
  const walkExtra = (dir, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walkExtra(path.join(dir, e.name), r)
      else if (!(r in expected)) view.extraFiles.push(r)
    }
  }
  walkExtra(root, '')
  for (const [rel, want] of Object.entries(expected)) {
    const got = actual[rel]
    if (got !== undefined && got !== want) view.driftedFiles.push({ file: rel, expect: want, actual: got })
  }
  /** 「基准与现树同源」：逐个比引擎模块与现树同名文件的摘要，相同就是同源。 */
  for (const d of localEngineDigests()) {
    const rel = `locator-lab/${path.basename(d.file)}`
    if (actual[rel] !== undefined && actual[rel] === d.sha256) {
      view.sameSourceFiles.push({ file: rel, sha256: d.sha256 })
    }
  }
  view.fileCount = Object.keys(actual).length + view.extraFiles.length
  view.status = view.missingFiles.length || view.driftedFiles.length || view.extraFiles.length ? 'drifted' : 'ok'
  if (view.status !== 'ok') {
    if (view.missingFiles.length) {
      view.problems.push(`夹具缺 ${view.missingFiles.length} 个文件：${view.missingFiles.slice(0, 4).join(', ')}`)
    }
    if (view.driftedFiles.length) {
      view.problems.push(
        `夹具被改过 ${view.driftedFiles.length} 个文件：` +
          view.driftedFiles
            .slice(0, 4)
            .map((d) => `${d.file}（清单 ${String(d.expect).slice(0, 12)} → 实得 ${String(d.actual).slice(0, 12)}）`)
            .join(' ｜ '),
      )
    }
    if (view.extraFiles.length) {
      view.problems.push(`夹具多出 ${view.extraFiles.length} 个文件：${view.extraFiles.slice(0, 4).join(', ')}`)
    }
  }
  return view
}

/**
 * 按**绝对路径**从夹具目录 import 那三个入口模块，返回引擎 + 来历（路径与摘要）。
 *
 * 这一段跑在**子进程**里（父进程只把这句源码交给 `node --input-type=module -e`），所以它 import 到的
 * 模块图整个落在夹具目录内；摘要也是**读到什么算什么**，不是从参数抄下来的。
 */
export async function loadFrozenEngine(root) {
  const lab = path.join(root, 'locator-lab')
  const spec = (name) => new URL(name, pathToFileURL(lab + path.sep).href).href
  const write = await import(spec('write-path.mjs'))
  const read = await import(spec('read-core.mjs'))
  const locateMod = await import(spec('locator-api.mjs'))
  return {
    planHunks: write.planHunks,
    readWith: read.readWith,
    locate: locateMod.locate,
    origin: spec('write-path.mjs'),
    provenance: {
      root,
      version: readPackageVersion(root),
      files: frozenEngineDigests(root),
      self: import.meta.url,
    },
  }
}

/**
 * 一列旧契约重放：父进程（现树引擎）与子进程（副本引擎）跑的是**同一个函数**。
 *
 * 每条读回自己那份原件副本（两个进程读到的是同一批 staged 文件），逐条记 outcome。
 */
export function replayOldColumn(engine, entries) {
  const tally = {}
  const perId = {}
  for (const e of entries) {
    const content = fs.readFileSync(e.copyPath, 'utf8')
    const res = replayOldWith(engine, e, content, e.copyPath)
    bump(tally, res.outcome)
    perId[e.id] = res.outcome
  }
  return { tally, perId }
}

/**
 * 子进程的源码：`node --input-type=module -e <这段>`。
 *
 * 它只做三件事：按绝对路径 import **副本自己的**引擎、把那三个模块文件的路径与 sha256 报回来、
 * 用本文件导出的 `replayOldColumn` 跑一遍基准列。判据⑬拿它报回来的东西与父进程**独立**算出的
 * 副本摘要比对 —— 两边都对上，才认这一列是「另一份代码跑出来的」。
 *
 * 结果走**文件**不走管道：受约束的沙箱里，node 抓子进程的管道会 EPERM，而这条判据不该因为
 * 跑法变了就红；`stdio: 'ignore'` + 结果文件在哪种沙箱里都一样。
 */
const FROZEN_CHILD_SOURCE = `
const fs = await import('node:fs')
const out = { ok: false, pid: process.pid, error: 'child wrote nothing' }
try {
  const fx = await import(process.env.AURA_C11_FIXTURE)
  const engine = await fx.loadFrozenEngine(process.env.AURA_C11_ENGINE_ROOT)
  const job = JSON.parse(fs.readFileSync(process.env.AURA_C11_JOB, 'utf8'))
  const res = fx.replayOldColumn(engine, job.entries)
  const probe = fx.probeEngineOldContract(engine)
  out.engine = engine.provenance
  out.oldProbe = probe
  out.jobEntries = job.entries.length
  out.tally = res.tally
  out.perId = res.perId
  out.error = null
  // ok 最后才置：中间任何一步抛错，回执都是「没跑成 + 原因」，而不是一份缺字段的成功回执。
  out.ok = true
} catch (error) {
  out.error = String((error && error.stack) || error)
}
fs.writeFileSync(process.env.AURA_C11_RESULT, JSON.stringify(out))
`

/**
 * 冻结基准列：把同一批重放原件交给**副本那份引擎**在子进程里跑一遍。只读。
 *
 * 跑前跑后各拍一次副本整棵目录的快照（判据⑬的「该目录 mtime 未变」）；子进程报回来的引擎
 * 路径/摘要与父进程自己算的那份比对；副本本身只被 `readFileSync` 碰过。
 */
function runFrozenBaseline(jobEntries, tmpDir) {
  const root = FROZEN_BASELINE_ROOT
  const started = Date.now()
  /**
   * 夹具自检放在最前面：夹具没了 / 被换过时，`how` 当场点名是哪种异常，
   * 而不是让判据只看见一句「列是空的」。自检结果一路挂在结果上，判据⑬读的就是它。
   */
  const fixture = inspectFrozenFixture(root)
  const common = {
    status: 'unavailable',
    root,
    fixture,
    jobEntries: jobEntries.length,
    childPid: null,
    engine: null,
    oldProbe: null,
    tally: null,
    perId: null,
    expected: [],
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
  let expected = []
  try {
    expected = frozenEngineDigests(root)
  } catch (error) {
    // 夹具在、但引擎文件读不到（比如根指错了地方）：如实报「没跑成 + 原因」，让判据⑬红并点名，
    // 而不是把一条 ENOENT 栈抛给跑判据的人。
    return { ...common, how: `副本的引擎文件读不到：${String(error?.message ?? error).slice(0, 160)}` }
  }
  const before = snapshotTree(root)
  const jobPath = path.join(tmpDir, 'c11-frozen-job.json')
  const resultPath = path.join(tmpDir, 'c11-frozen-result.json')
  fs.writeFileSync(jobPath, JSON.stringify({ corpus: CORPUS_PATH, entries: jobEntries }), 'utf8')
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', FROZEN_CHILD_SOURCE], {
    env: {
      ...process.env,
      AURA_C11_FIXTURE: import.meta.url,
      AURA_C11_ENGINE_ROOT: root,
      AURA_C11_JOB: jobPath,
      AURA_C11_RESULT: resultPath,
    },
    stdio: 'ignore',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
  })
  const after = snapshotTree(root)
  const base = {
    ...common,
    expected,
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
  if (!child) {
    return { ...base, how: `子进程没写出结果文件（exit=${proc.status}，signal=${proc.signal}）—— 副本那侧没跑起来` }
  }
  if (!child.ok) {
    return { ...base, childPid: child.pid, how: `子进程报错：${String(child.error).split('\n')[0]}` }
  }
  return {
    ...base,
    status: 'ok',
    childPid: child.pid,
    engine: child.engine,
    oldProbe: child.oldProbe,
    tally: child.tally,
    perId: child.perId,
    how: `子进程 pid ${child.pid} 用夹具 ${root}（v${child.engine?.version}，构建戳 ${fixture.manifest?.buildStamp ?? '(清单里没记)'}）跑完 ${child.jobEntries} 条`,
  }
}

/**
 * 把聚焦 hunk 改写成内容寻址：`old` = 引文，`context` = 原文里紧邻的上下行。
 *
 * 试两种形状：先 `old + context`，再退回**只有 `old`**（蓝图里 context 本来就是可选的）。
 * 两种都试是有意的：`context` 到底含不含 `old` 自己，各家的 old+context 契约写法不一，
 * 夹具不该把某一种猜测当成判据；而"不唯一时给候选"这个信号在两种形状下都会冒出来。
 */
function toContentAddress(entry, content, old) {
  const focusHunk = entry.hunks?.[entry.focus ?? 0] ?? null
  const replace = typeof focusHunk?.replace === 'string' ? focusHunk.replace : ''
  /** 每条变体自报家门：`address` 就是「这一次 ok 靠什么寻到址」的凭据。
   *  凭据由**造变体的地方**写，不从 hunk 的形状反推——否则将来有人往这条循环里
   *  塞回旧坐标 hunk 当兼底，那些“兼底命中”会跟着冒充内容寻址命中（判据③专盯这一手）。 */
  const variants = []
  const ctx = neighbourContext(entry, content, old, focusHunk)
  if (ctx) variants.push({ address: 'old+context', hunk: { old, context: ctx, replace } })
  variants.push({ address: 'old', hunk: { old, replace } })
  return variants
}

/**
 * `context` 取被寻址区域**紧邻的上下行**（不含 old 自己）——这是 old+context 这类
 * 契约的通行形状。取不到就退化成"只有 old"。
 */
function neighbourContext(entry, content, old, focusHunk) {
  const lines = content.split(/\r?\n/)
  let at = -1
  const req = legacyRequest(focusHunk ?? {}, null)
  const res = req === null ? null : locateQuiet(content, req)
  if (res?.ok) at = res.startLine - 1
  if (at < 0) at = lines.findIndex((l) => l.includes(old))
  if (at < 0) return null
  const before = at - 1 >= 0 ? lines[at - 1] : ''
  const after = at + 1 < lines.length ? lines[at + 1] : ''
  const ctx = [before, after].filter((l) => l.trim().length > 0).join('\n')
  return ctx.length > 0 ? ctx : null
}

/**
 * 一次「真实工具调用」：**同一个编排层入口**（`applyEditToProvider`）+ **同一个 provider**
 * （`createNodeFsProvider`，CLI / MCP 用的就是它），跑在调用方给的**可写副本**上。
 *
 * 为什么连 provider 也照搬：`applyEditToProvider` 只认一个「四方法契约」，随便包一层计数用的壳
 * 也能跑通 —— 但那样量到的仍只是引擎自己，而不是工具实际跑的那条路：原子落盘（临时文件+rename）、
 * 版本令牌（CAS）、写后回读校验就都不在这条路上了。
 *
 * 写盘计数与副本摘要一起回来：第四态那句「一个字节都没动」是**结论**，判据要拿
 * `writes === 0` 与 `before === after` 两条**证据**来钉 —— 只看结果字段是自证不了自己的。
 *
 * @returns `{ result, error, writes, diskChanged }`（抛错不外泄：失败也是一条读数）
 */
async function callToolOnCopy(toolPath, hunk) {
  const provider = createNodeFsProvider({ resolveRoot: path.dirname(toolPath) })
  let writes = 0
  const counting = {
    resolve: (t) => provider.resolve(t),
    stat: (t, s) => provider.stat(t, s),
    readText: (t, s) => provider.readText(t, s),
    readByteRange: (t, r, s) => provider.readByteRange(t, r, s),
    writeText: (t, c, e, s) => {
      writes += 1
      return provider.writeText(t, c, e, s)
    },
  }
  const before = sha256File(toolPath)
  let result = null
  let error = null
  try {
    result = await applyEditToProvider(counting, { displayPath: toolPath, hunks: [hunk] })
  } catch (thrown) {
    error = thrown
  }
  return { result, error, writes, diskChanged: sha256File(toolPath) !== before }
}

/**
 * 「现树·新契约」列的一条条目：**与真实工具同一个入口**，两种地址形状各试一次。
 *
 * 导出它是为了把「新契约列到底怎么算」变成**一处实现**：`residual-census` / `address-form-census`
 * 原先各自逐字复刻了一份 `replayNew`，上游一改就得跟着改两处 —— 那正是本单要治的那类缝。
 * 现在两份下游普查件 import 这一个函数，复刻走样在结构上不可能发生。
 *
 * 三件事在这里定形：
 *   ① `ok` 仍以**真的寻到址并落盘**为准（`applyEditToProvider` 正常返回）；
 *   ② 两种形状都寻不到址、而编排层回了第四态 ⇒ `already_applied`（**它自己报的**，不在这里判）；
 *   ③ 任一形状被判「需选择」⇒ 仍报 `needs_choice`：「有好几处像」与「已经改好了」是两件事，
 *      不许被后者盖住（与 `applyEditToProvider` 里那段注释同一个道理）。
 *
 * @returns `{ outcome, code, detail, address, writes, diskChanged, attempts }`
 *   `attempts[]` 逐次记 `{ address, outcome, code, candidates, message }`：机制分解靠它看引擎报了什么。
 */
export async function replayNewContract({ entry, content, old, toolPath }) {
  const attempts = []
  let sawChoice = null
  let landed = null
  let lastCode = 'THROW'
  let writes = 0
  let diskChanged = false
  for (const { address, hunk } of toContentAddress(entry, content, old)) {
    const seen = await callToolOnCopy(toolPath, hunk)
    writes += seen.writes
    if (seen.diskChanged) diskChanged = true
    if (seen.error === null) {
      const outcome = seen.result?.outcome ?? OUTCOME.ok
      if (outcome === OUTCOME.alreadyApplied) {
        /**
         * 第四态：编排层在**任何写盘之前**回它（判据是 `alreadyAppliedHits`，理由在 `write-path.mjs`）。
         * **不在这里返回**：另一种形状也许真能寻到址 —— 那是更强的结论，先让它跑完。
         */
        landed = { address, detail: `old 寻不到址、而 replace 已整行唯一存在（编排层回 already_applied，第 ${attempts.length + 1} 次尝试：${address}）` }
        attempts.push({ address, outcome, code: 'ALREADY_APPLIED', candidates: 0, message: '' })
        continue
      }
      attempts.push({ address, outcome: OUTCOME.ok, code: 'OK', candidates: 0, message: '' })
      // `address` 明写这一次 ok 是哪条地址挣来的——判据要靠它证明新列的成功**出自
      // 内容寻址**，而不是旧坐标 hunk 侥幸命中（那等于新列根本没被走到）。
      return {
        outcome: OUTCOME.ok,
        detail: address === 'old+context' ? 'old+context 命中' : 'old 命中',
        code: 'OK',
        address,
        writes,
        diskChanged,
        attempts,
      }
    }
    const error = seen.error
    const code = String(error?.code ?? 'THROW')
    lastCode = code
    const cands = Array.isArray(error?.candidates) ? error.candidates.length : 0
    attempts.push({ address, outcome: OUTCOME.fail, code, candidates: cands, message: String(error?.message ?? error).slice(0, 400) })
    // 「需选择」与「找不到」是两种不同的结果：前者说明引擎看懂了意图但有多个落点
    // （这正是新契约三态里的 needs_choice），后者说明这段引文在原文里根本没有。
    // 判据要同时看 code 与 candidates：只认 message 会漏掉 code 里写明 AMBIGUOUS 的那些。
    const ambiguous =
      cands > 0 || /AMBIGUOUS|CANDIDATE/i.test(code) || /candidates|appears on|occurrence|not unique|ambiguous/i.test(String(error?.message ?? error))
    if (ambiguous) sawChoice = code
  }
  if (sawChoice) {
    return { outcome: OUTCOME.needsChoice, detail: `引文不唯一/有候选：${sawChoice}`, code: sawChoice, address: null, writes, diskChanged, attempts }
  }
  if (landed) {
    return { outcome: OUTCOME.alreadyApplied, detail: landed.detail, code: 'ALREADY_APPLIED', address: null, writes, diskChanged, attempts }
  }
  return { outcome: OUTCOME.fail, detail: `old 在原文里找不到（${lastCode}）`, code: lastCode, address: null, writes, diskChanged, attempts }
}

/**
 * 主列的一条条目怎么分流：读路径没有 old/context 入口（如实计 na）、没有引文的无处可引
 * （无从表达），其余走 {@link replayNewContract}。
 *
 * 这一层是**本探针的记账**，不是引擎的判断 —— 所以它不进导出面：下游普查件要读的是
 * 「引擎怎么答」，不是「本夹具怎么归类」。
 */
async function replayNew(entry, content, copyPath, old, toolPath) {
  if (!old) return { outcome: OUTCOME.unrepresentable, detail: '该条目没有可引用的原文', code: 'NO_QUOTE', address: null, attempts: [], writes: 0, diskChanged: false }
  return replayNewContract({ entry, content, old, toolPath })
}

// ── 6. 主流程 ──────────────────────────────────────────────────────────────

function emptyTally() {
  return {
    entries: 0,
    replayable: 0,
    drifted: 0,
    sourceMix: { log: 0, receipt: 0, disk: 0 },
    exact: 0,
    /**
     * 旧契约列的分桶。键与 `neu` 一样**按 OUTCOME 取值**（`ok`/`fail`/`needs_choice`/
     * `unrepresentable`/`na`），不再自己起一套 `needsChoice` 的写法：三列同形，显示口径
     * （`columnOf`）才能一个函数盖住，"表里恒 0" 这类键名事故也只可能发生在 OUTCOME 上。
     * 旧契约没有「需选择」这一态（判定不出意图就是抛错），`needs_choice` 结构性恒 0。
     */
    old: { ok: 0, fail: 0, needs_choice: 0, unrepresentable: 0, na: 0 },
    neu: {},
    evidenceNeu: {},
    // 失败码分布：只报「失败」计数回答不了「为什么」——`PATCH_NOT_FOUND`（引文不在原文里）
    // 与 `PATCH_AMBIGUOUS`（有多个落点）是两条完全不同的出路，必须分开数。
    oldCodes: {},
    neuCodes: {},
    /**
     * `PATCH_NOT_FOUND` 里**引文其实就在原文中**的条数。
     *
     * 这两个数必须分开数：`old` 是**行粒度**地址（`old='gamma'` 而原文是 `beta gamma` →
     * 报 `PATCH_NOT_FOUND`，message 里写着 "line 2 contains it inside …"）。于是
     * 「引文在不在原文里」与「old 能不能寻到址」是两件事，抹成一个 PATCH_NOT_FOUND
     * 会把真正的失败原因藏起来——而 S 类（引文是区间原文的子串）恰恰全落在这一格上。
     */
    neuQuotePresentButNotFound: 0,
  }
}

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by
}

/**
 * 每条语料的账本条目：终态要求「每条记 类别/文件/原始 hunk 参数/回执首行/可用原文片段」。
 *
 * `hunks` 记的是**调用方当时给的那份原始参数**，不是改写成 `old`+`context` 之后的那一份——
 * 这不是措辞问题：把改写后的参数当成「原始参数」记下来，这份夹具就再也说不清「旧契约
 * 到底失败在哪」，对照表的旧列也就无从复算。判据拿语料文件里那份原始参数逐字比对
 * （见 `freezeEntry` / `freezeRecord`）。
 */
function recordOf(entry) {
  const drifted = !entry.replayable || !entry.source
  return {
    id: entry.id,
    klass: entry.klass ?? null,
    file: entry.file ?? '',
    hunks: entry.hunks ?? [],
    receipt: entry.receiptFirstLine ?? '',
    excerpt: entry.excerpt?.text ?? null,
    drifted,
    replayable: !drifted,
  }
}

/**
 * 判据基准：把「类别/文件/原始 hunk 参数/回执首行」冻结成一串。
 *
 * 在重放**之前**冻结，是为了让基准不随重放过程漂移：重放期间若有人就地改写条目
 * （比如把 hunk 改写成 old+context 之后再记录），账本照样对不上语料文件，判据当场看出来。
 */
function freezeEntry(e) {
  return JSON.stringify([e.klass ?? null, e.file ?? '', e.hunks ?? [], e.receiptFirstLine ?? ''])
}

function freezeRecord(r) {
  return JSON.stringify([r.klass ?? null, r.file ?? '', r.hunks ?? [], r.receipt ?? ''])
}

async function replayCorpus(corpus, options) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-c7-replay-'))
  const engine = probeEngineOldContract()
  const shell = await probeShellOldContract()
  const perKlass = new Map()
  const details = []
  /**
   * 每条语料都要记下来的五样：类别 / 文件 / 原始 hunk 参数 / 回执首行 / 可用原文片段。
   *
   * `details` 只在 `--show` 时留前 N 条（给人看），是视图不是账本；判据要看的是**整份**
   * 账本，所以这里无条件逐条记，`--show=0`（默认）时也在。判据见主流程那两条
   * 「每条明细…」/「非 drifted 条目都带可用原文片段」。
   */
  const records = []
  /**
   * 新旧两列的**逐条配对**结果：判据靠它回答「新列是不是旧列的副本」。
   *
   * `scope` 说明这条条目在新列里走的是哪条路：`edit`（真的进了 `replayNew`）/ `read`
   * （读路径没有 old/context 入口，如实计 na）/ `not_ready`（引擎探针未就绪）。
   * **只有 `edit` 那批能拿来判「两列是否同源」**：读路径那条分支无论如何都跟旧列不同，
   * 把它算进「结果不同」的条数里，会让「新列退化成旧列副本」这种破坏假绿。
   */
  const pairs = []
  /**
   * 冻结基准列的重放工单：每条可重放条目一行，只带子进程需要的五样（id / 工具 / 原始 hunk /
   * 原始入参 / 那份原件副本的路径）。两个进程读到的是**同一批 staged 文件**，所以三列跑的
   * 是同一份原文——这是它们能放进同一张表的前提。
   */
  const jobEntries = []
  let staged = 0
  let frozen = null

  try {
    for (const entry of corpus.entries) {
      const tally = perKlass.get(entry.klass) ?? emptyTally()
      perKlass.set(entry.klass, tally)
      tally.entries += 1
      records.push(recordOf(entry))
      if (!entry.replayable || !entry.source) {
        tally.drifted += 1
        if (details.length < (options.show ?? 0)) {
          // 明细与账本同形：五样字段一个不少（drifted 本来就没有原文片段，如实记 null）。
          details.push({
            id: entry.id,
            klass: entry.klass,
            verdict: 'drifted',
            file: entry.file ?? '',
            hunks: entry.hunks ?? [],
            receipt: entry.receiptFirstLine,
            excerpt: null,
          })
        }
        continue
      }
      tally.replayable += 1
      bump(tally.sourceMix, entry.source.kind)
      if (entry.source.fidelity === 'exact') tally.exact += 1
      const { copyPath, content } = stageCopy(entry, tmpDir, staged++)
      const oldRes = replayOld(entry, content, copyPath)
      bump(tally.old, oldRes.outcome)
      if (oldRes.outcome === OUTCOME.fail && oldRes.code) bump(tally.oldCodes, oldRes.code)
      jobEntries.push({ id: entry.id, tool: entry.tool, hunks: entry.hunks ?? [], args: entry.args ?? null, copyPath })

      const oldText = entry.quote?.text ?? null
      const evidenceText = entry.evidence?.actual ?? null
      const idle = { attempts: [], writes: 0, diskChanged: false }
      let neuRes
      if (!engine.ready) neuRes = { outcome: OUTCOME.notReady, detail: engine.how, code: 'NOT_READY', ...idle }
      else if (entry.tool === 'aura_read') {
        neuRes = { outcome: OUTCOME.na, detail: '读路径没有 old/context 入口', code: 'READ_PATH', ...idle }
      } else {
        // 新契约列只踩这一份**可写**副本（编排层会真落盘）；旧入参列与冻结基准列踩上面那份只读的。
        neuRes = await replayNew(entry, content, copyPath, oldText, stageToolCopy(entry, tmpDir, 'tool'))
      }
      bump(tally.neu, neuRes.outcome)
      if (neuRes.outcome !== OUTCOME.ok) bump(tally.neuCodes, neuRes.code ?? neuRes.outcome)
      // 「找不到」与「引文在原文里、只是不是整行」是两件事，分开数（见 emptyTally 的注释）。
      if (neuRes.code === 'PATCH_NOT_FOUND' && oldText !== null && content.includes(oldText)) {
        tally.neuQuotePresentButNotFound += 1
      }

      let evRes = { outcome: OUTCOME.na, detail: '', code: 'NA', ...idle }
      if (!engine.ready) evRes = { outcome: OUTCOME.notReady, detail: engine.how, code: 'NOT_READY', ...idle }
      else if (entry.tool === 'aura_edit') {
        // 附表这一列也是**真入口**，所以它也占一个自己的可写副本：挤在主列那份上，
        // 第二次尝试就会打在第一次写过的内容上（主列成功时那份已经变了）。
        evRes = evidenceText
          ? await replayNew(entry, content, copyPath, evidenceText, stageToolCopy(entry, tmpDir, 'evidence'))
          : { outcome: OUTCOME.unrepresentable, detail: '无实证原文', code: 'NO_EVIDENCE', ...idle }
      }
      bump(tally.evidenceNeu, evRes.outcome)

      pairs.push({
        id: entry.id,
        klass: entry.klass,
        scope: !engine.ready ? 'not_ready' : entry.tool === 'aura_read' ? 'read' : 'edit',
        old: oldRes.outcome,
        neu: neuRes.outcome,
        // 新列这一条 ok 是哪条地址挣来的：`old+context` / `old` / null（不是 ok）。
        neuAddress: neuRes.address ?? null,
        /**
         * 「这一次调用真的落过盘吗」——两个原始读数，不靠文本推断：
         *   · `neuWrites` = `writeText` 被调用的次数（`applyEditToProvider` 只在真写那一刻调它）；
         *   · `neuDiskChanged` = 可写副本的 sha256 前后是否不同。
         * 判据⑭（第四态一个字节都没动）与⑮（ok 确实走了编排层）都读这两个数。
         */
        neuWrites: neuRes.writes ?? 0,
        neuDiskChanged: neuRes.diskChanged === true,
      })

      if (details.length < (options.show ?? 0)) {
        details.push({
          id: entry.id,
          klass: entry.klass,
          file: entry.file,
          hunks: entry.hunks ?? [],
          source: `${entry.source.kind}/${entry.source.fidelity}`,
          quote: oldText === null ? null : clip(oldText, 60),
          quoteInCopy: oldText === null ? null : content.includes(oldText),
          old: `${oldRes.outcome}${oldRes.detail ? ` (${oldRes.detail})` : ''}`,
          neu: `${neuRes.outcome}${neuRes.detail ? ` (${neuRes.detail})` : ''}`,
          evidenceNeu: `${evRes.outcome}${evRes.detail ? ` (${evRes.detail})` : ''}`,
          receipt: entry.receiptFirstLine,
        })
      }
    }
    // 冻结基准列：在子进程里用**仓库内夹具**的引擎跑同一批工单（临时目录还在，重放原件还在）。
    frozen = runFrozenBaseline(jobEntries, tmpDir)
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响判据 */
    }
  }
  return { perKlass, engine, shell, details, records, pairs, frozen }
}

// ── 7. 打印 ────────────────────────────────────────────────────────────────

/** CJK 按两格宽算：表格对齐是给人看的，错了就白打印。 */
function width(s) {
  let w = 0
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return w
}
function pad(s, n) {
  const t = String(s)
  return t + ' '.repeat(Math.max(0, n - width(t)))
}


function printTable(corpus, result) {
  const order = [...REQUIRED_CLASSES, 'other']
  const present = order.filter((k) => result.perKlass.has(k))
  /** 就绪探针未就绪时整列只有一个数；就绪时走三列同形的 `columnCell`（键名只有一个来源）。 */
  const neuCell = (n, ready) => (!ready ? `接口未就绪(${n.notReady ?? 0})` : columnCell(columnOf(n)))
  /**
   * 冻结基准列按类别聚合：子进程只回**逐条 outcome**，归类在父进程做
   * （类别取自语料，不经过子进程——子进程不该有机会决定哪条算哪一类）。
   */
  const frozenByKlass = new Map()
  if (result.frozen?.status === 'ok') {
    const klassOf = new Map(corpus.entries.map((e) => [e.id, e.klass]))
    for (const [id, outcome] of Object.entries(result.frozen.perId ?? {})) {
      const klass = klassOf.get(id) ?? 'other'
      const bucket = frozenByKlass.get(klass) ?? {}
      bump(bucket, outcome)
      frozenByKlass.set(klass, bucket)
    }
  }
  const frozenCell = (tally) => (tally ? columnCell(columnOf(tally)) : '（没跑）')

  console.log('')
  console.log('=== 失败语料（按失败类别分层） ===')
  console.log(`  语料条目 ${corpus.entries.length} 条 ｜ 每类抽样上限 ${JSON.stringify(corpus.sampling)}`)
  console.log(`  来源：${corpus.sources.sessionsScanned} 个会话文件；从原始事件数出失败 ${corpus.sources.failuresSeen} 次（与 CSV 对账见 --build 输出）`)
  console.log('')
  console.log('=== 三列同语料对跑（冻结基准 / 现树·旧入参 / 现树·新契约） ===')
  const head = [
    pad('类别', 30),
    pad('条目', 6),
    pad('可重放', 8),
    pad('逐字', 6),
    pad('来源 l/r/d', 12),
    pad('漂移', 6),
    pad('冻结基准 0.6.1+217798da', 28),
    pad('现树·旧入参', 28),
    '现树·新契约（真工具入口）',
  ].join('')
  console.log(head)
  // 三列每一格的形状写在自己那一列下面：格与格可以直接横着比。
  console.log(
    pad('', 30) + pad('', 6) + pad('', 8) + pad('', 6) + pad('', 12) + pad('', 6) +
      pad('ok/fail/需选择', 28) + pad('ok/fail/需选择', 28) + 'ok/fail/需选择/已落地/无从表达/无对应入口',
  )
  console.log('-'.repeat(width(head)))

  const totals = emptyTally()
  for (const k of present) {
    const t = result.perKlass.get(k)
    totals.entries += t.entries
    totals.replayable += t.replayable
    totals.drifted += t.drifted
    totals.exact += t.exact
    for (const [key, v] of Object.entries(t.sourceMix)) bump(totals.sourceMix, key, v)
    for (const [key, v] of Object.entries(t.old)) bump(totals.old, key, v)
    for (const [key, v] of Object.entries(t.neu)) bump(totals.neu, key, v)
    for (const [key, v] of Object.entries(t.evidenceNeu)) bump(totals.evidenceNeu, key, v)
    for (const [key, v] of Object.entries(t.oldCodes)) bump(totals.oldCodes, key, v)
    for (const [key, v] of Object.entries(t.neuCodes)) bump(totals.neuCodes, key, v)
    totals.neuQuotePresentButNotFound += t.neuQuotePresentButNotFound
    console.log(
      [
        pad(KLASS_LABEL[k] ?? k, 30),
        pad(t.entries, 6),
        pad(t.replayable, 8),
        pad(t.exact, 6),
        pad(`${t.sourceMix.log}/${t.sourceMix.receipt}/${t.sourceMix.disk}`, 12),
        pad(t.drifted, 6),
        pad(frozenCell(frozenByKlass.get(k)), 28),
        pad(columnCell(columnOf(t.old)), 28),
        neuCell(t.neu, result.engine.ready),
      ].join(''),
    )
  }
  console.log('-'.repeat(width(head)))
  console.log(
    [
      pad('合计', 30),
      pad(totals.entries, 6),
      pad(totals.replayable, 8),
      pad(totals.exact, 6),
      pad(`${totals.sourceMix.log}/${totals.sourceMix.receipt}/${totals.sourceMix.disk}`, 12),
      pad(totals.drifted, 6),
      pad(frozenCell(result.frozen?.status === 'ok' ? result.frozen.tally : null), 28),
      pad(columnCell(columnOf(totals.old)), 28),
      neuCell(totals.neu, result.engine.ready),
    ].join(''),
  )
  console.log('')
  console.log('  三列的格同形 = ok / fail / 需选择 / 已落地 / 无从表达 / 无对应入口；「—」= 该契约结构上没有这一态。')
  console.log('  「已落地」= 编排层回的第四态（old 两层都找不到、而 replace 已整行唯一存在）：一个字节都没写，')
  console.log('    也既不算 ok、也不算 fail —— 它只有「现树·新契约」那一列可能非零（只有真入口会回这一态）。')
  console.log('  来源 l/r/d = 日志快照(log) / 回执实证(receipt) / 今日磁盘(disk) 的条数；')
  console.log('  「逐字」= 受寻址区间与历史逐字相同（log 覆盖受寻址区间，或 receipt 铺的就是回执吐出的那段）。')
  const oldCol = columnOf(totals.old)
  const neuCol = columnOf(totals.neu)
  const baseCol = result.frozen?.status === 'ok' ? columnOf(result.frozen.tally) : null
  const bucketSum = (c) => `${c.ok}+${c.fail}+${c.needsChoice}+${c.alreadyApplied}+${c.unrepresentable}+${c.na}`
  // 「分桶之和 == 明细条数」：三列各自的六格相加必须都落在可重放条数上（少一格就是某一格数漏了）。
  console.log(
    `  分桶自洽（每列六格相加 = 可重放 ${totals.replayable}）：` +
      `冻结基准 ${baseCol ? bucketSum(baseCol) : '（没跑）'}` +
      ` ｜ 现树旧入参 ${bucketSum(oldCol)}` +
      ` ｜ 现树新契约 ${bucketSum(neuCol)}`,
  )
  console.log('')
  const frozenVersion = result.frozen?.engine?.version ?? '(版本读不到)'
  const frozenBuild = result.frozen?.fixture?.manifest?.buildStamp ?? `v${frozenVersion}（清单里没记构建戳）`
  const baseFail = baseCol ? `${baseCol.fail}` : `（冻结基准没跑成：${result.frozen?.how ?? '未知'}）`
  console.log(
    `  一句话：语料 ${corpus.entries.length} 条里（可重放 ${totals.replayable} 条为分母），` +
      `冻结基准（夹具 ${frozenBuild}）${baseFail} 条失败 → 新契约 ${neuCol.fail} 条仍失败` +
      `（另 ${neuCol.needsChoice} 条判为"需选择"、按结果通道带回候选，不算"找不到"；` +
      `${neuCol.alreadyApplied} 条是第四态"已经是你给的样子了、这次不用改"，一个字节都没写）；` +
      `同一批历史入参交现树旧引擎是 ${oldCol.fail} 条失败。`,
  )

  console.log('')
  console.log('=== 失败码分布（"失败"两个字回答不了"为什么"） ===')
  const codes = (m) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join('  ') || '—'
  console.log(`  旧契约失败：${codes(totals.oldCodes)}`)
  console.log(`  新契约非成功：${codes(totals.neuCodes)}`)
  for (const k of present) {
    const t = result.perKlass.get(k)
    console.log(`    ${pad(KLASS_LABEL[k] ?? k, 30)} 旧 ${codes(t.oldCodes)} ｜ 新 ${codes(t.neuCodes)}`)
  }
  console.log('')
  console.log('=== 「引文不在原文里」 vs 「引文在、但不是整行」 ===')
  console.log('  `old` 是行粒度地址：原文 `beta gamma` 上只给 `old=gamma` 会回 PATCH_NOT_FOUND。')
  console.log('  所以 PATCH_NOT_FOUND 里要再分一次：引文到底在不在原文里。')
  for (const k of present) {
    const t = result.perKlass.get(k)
    const nf = t.neuCodes.PATCH_NOT_FOUND ?? 0
    if (nf === 0 && t.neuQuotePresentButNotFound === 0) continue
    console.log(
      `    ${pad(KLASS_LABEL[k] ?? k, 30)} PATCH_NOT_FOUND ${nf} 条，其中引文其实在原文里 ${t.neuQuotePresentButNotFound} 条`,
    )
  }
  console.log(
    `    合计 PATCH_NOT_FOUND ${totals.neuCodes.PATCH_NOT_FOUND ?? 0} 条，其中引文其实在原文里 ${totals.neuQuotePresentButNotFound} 条`,
  )

  console.log('')
  console.log('=== 接口就绪探针 ===')
  console.log(`  引擎  planHunks 认 {old}?  ${result.engine.ready ? '就绪' : '未就绪'} —— ${result.engine.how}`)
  console.log(`  壳层  aura_edit schema 认 old/context?  ${result.shell.ready ? '就绪' : '未就绪'} —— ${result.shell.how}`)
  // 同一个探针再问一遍**冻结夹具**：两边答案不同，就是「基准列确实用的是另一份代码」的行为凭据。
  console.log(
    `  基准  冻结夹具认 {old}?  ${result.frozen?.status === 'ok' ? (result.frozen.oldProbe?.ready ? '就绪' : '未就绪') : '（基准列没跑成）'}` +
      ` —— ${result.frozen?.status === 'ok' ? result.frozen.oldProbe?.how : (result.frozen?.how ?? '未知')}`,
  )

  console.log('')
  console.log('=== 附表：新契约·引文取实证原文（"先读再引"那一问） ===')
  for (const k of present) {
    const t = result.perKlass.get(k)
    console.log(`  ${pad(KLASS_LABEL[k] ?? k, 30)} ${neuCell(t.evidenceNeu, result.engine.ready)}`)
  }

  console.log('')
  console.log(`  分母 = 可重放 ${totals.replayable} 条；drifted ${totals.drifted} 条不计入成功/失败分母（找不到可重放原文）。`)
  console.log(`  重放一律在 ${path.join(os.tmpdir(), 'aura-c7-replay-*')} 的临时副本上做；语料里的路径从未被写过。`)
  if (result.frozen?.status === 'ok') {
    const fbView = result.frozen
    const fixture = fbView.fixture ?? { status: 'missing', problems: [], sameSourceFiles: [] }
    const files = Array.isArray(fbView.engine?.files) ? fbView.engine.files : []
    const brief = (list) => list.map((f) => `${path.basename(String(f.file))}=${String(f.sha256).slice(0, 12)}`).join(' ')
    console.log(
      `  冻结基准的来历：仓库内只读夹具（不在升级路径上）｜子进程 pid ${fbView.childPid}（本进程 ${process.pid}）｜${fbView.root}`,
    )
    console.log(
      `    夹具清单：v${fixture.manifest?.version ?? '?'}，构建戳 ${fixture.manifest?.buildStamp ?? '(没记)'}，取自 ${fixture.manifest?.source?.path ?? '(没记)'}，取用时 ${fixture.manifest?.takenAt ?? '(没记)'}`,
    )
    console.log(
      `    夹具自检：清单 ${fixture.expectedCount ?? '?'} 个文件 vs 实得 ${fixture.fileCount ?? '?'} 个 —— ` +
        `${fixture.status === 'ok' ? '逐个对上' : `${fixture.status}：${(fixture.problems ?? []).join(' ； ')}`}` +
        `；与现树同源的引擎模块 ${(fixture.sameSourceFiles ?? []).length} 个`,
    )
    console.log(`    子进程报回的引擎文件摘要  ${brief(files)}`)
    console.log(`    父进程独立算出的（同一批）  ${brief(fbView.expected)}`)
    console.log(`    现树同名文件的摘要          ${brief(localEngineDigests())}`)
    console.log(
      `    夹具整棵目录 ${fbView.treeFiles} 项，跑前跑后 mtime/size 快照比对：` +
        `${fbView.treeChanged.length === 0 ? '逐项未变' : `${fbView.treeChanged.length} 项变了 —— ${fbView.treeChanged.slice(0, 3).join(' ｜ ')}`}`,
    )
  }
  return totals
}


// ── 8. 入口 ────────────────────────────────────────────────────────────────

async function main() {

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--json', '--no-upstream', '--show', '--top', '--legacy', '--limit'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'src/locator-lab/failure-replay.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
  const argv = process.argv.slice(2)
  const options = {
    build: argv.includes('--build'),
    json: argv.includes('--json'),
    show: Number((argv.find((a) => a.startsWith('--show=')) ?? '--show=0').slice(7)) || 0,
  }

  if (options.build) buildCorpus()

  if (!fs.existsSync(CORPUS_PATH)) {
    console.error(`✗ 语料不存在：${CORPUS_PATH}\n  先跑：node ${path.relative(REPO, import.meta.filename)} --build`)
    process.exit(1)
  }
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'))
  // 「原始 hunk 参数」的独立基准：在重放**之前**照语料文件里那份冻结成串。重放期间若有人
  // 就地改写条目（比如把 hunk 改写成 old+context 之后再记录），账本照样对不上基准，判据点名。
  const frozenRecords = new Map(corpus.entries.map((e) => [e.id, freezeEntry(e)]))
  const result = await replayCorpus(corpus, options)
  const totals = printTable(corpus, result)

  const checks = []
  const check = (ok, label, detail = '') => {
    checks.push({ ok, label, detail })
    console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  }
  console.log('')
  console.log('=== 判据 ===')
  const counts = {}
  for (const k of REQUIRED_CLASSES) counts[k] = result.perKlass.get(k)?.entries ?? 0
  check(corpus.entries.length >= MIN_ENTRIES, `语料条目 ≥ ${MIN_ENTRIES}`, `实得 ${corpus.entries.length}`)
  const missing = REQUIRED_CLASSES.filter((k) => counts[k] === 0)
  check(missing.length === 0, '七类各有覆盖', missing.length ? `缺：${missing.join(',')}` : REQUIRED_CLASSES.map((k) => `${k}=${counts[k]}`).join(' '))
  check(
    REQUIRED_CLASSES.every((k) => (result.perKlass.get(k)?.replayable ?? 0) > 0),
    '每一类都有可重放条目（不是靠 drifted 凑数）',
    REQUIRED_CLASSES.map((k) => `${k}:${result.perKlass.get(k)?.replayable ?? 0}`).join(' '),
  )
  check(
    REQUIRED_CLASSES.filter((k) => k !== 'params').every((k) => (result.perKlass.get(k)?.exact ?? 0) > 0),
    '错配/歧义/坐标类都有「原文逐字」的条目（失败能在重放里复现）',
    REQUIRED_CLASSES.map((k) => `${k}:${result.perKlass.get(k)?.exact ?? 0}`).join(' '),
  )
  check(totals.replayable > 0, '对照表有非空分母', `可重放 ${totals.replayable} / 漂移 ${totals.drifted}`)

  // ── 两列各自计数的**判别性**断言 ─────────────────────────────────────────
  // 上面五条判的是语料构成（条数/类别/分母），对「新旧两列各自算了什么」零判定力：
  // 把新契约列整个换成 replayOld 的副本，前五条读数一字不变（变异实测）。下面这几条判的
  // 正是那件事，每一条都能被变异反证（把对应实现改坏 ⇒ 必红并点名）。
  const nameIds = (list, cap = 6) =>
    `${list.slice(0, cap).join(', ')}${list.length > cap ? ` …共 ${list.length} 条` : ''}`
  // 只有 `edit` 那批配对能判「同源」：读路径那条分支（na）与未就绪分支无论如何都跟旧列
  // 不同，把它们算进「结果不同」的条数里，会让「新列退化成旧列副本」假绿。
  const editPairs = result.pairs.filter((p) => p.scope === 'edit')
  const diffPairs = editPairs.filter((p) => p.old !== p.neu)
  const okFlip = diffPairs.filter((p) => (p.old === OUTCOME.ok) !== (p.neu === OUTCOME.ok))
  const choicePairs = editPairs.filter((p) => p.neu === OUTCOME.needsChoice)
  const scopes = [...new Set(result.pairs.map((p) => p.scope))].join('/') || '(无)'
  // 三态的读数走**表格用的那个显示口径**（`columnOf`），不直接读内部字典：C11 段A 的 bug 正是
  // 「表里读 `n.needsChoice`、桶里写 `'needs_choice'`」两套键名——判据若直接读内部字典，
  // 这种「表印 0、真值 8」的事故永远不会被它发现。现在①④两条判据与表格同源。
  const neuCol = columnOf(totals.neu)
  const oldCol = columnOf(totals.old)
  const neuChoice = neuCol.needsChoice
  const oldChoice = oldCol.needsChoice
  const okPairs = editPairs.filter((p) => p.neu === OUTCOME.ok)
  const ctxOk = okPairs.filter((p) => p.neuAddress === 'old+context')
  const plainOk = okPairs.filter((p) => p.neuAddress === 'old')
  const foreignOk = okPairs.filter((p) => p.neuAddress !== 'old' && p.neuAddress !== 'old+context')
  /** 第四态那一格：逐条配对 + 两个原始读数（写盘次数 / 副本摘要是否变过）。 */
  const landedPairs = editPairs.filter((p) => p.neu === OUTCOME.alreadyApplied)
  const landedWrote = landedPairs.filter((p) => (p.neuWrites ?? 0) !== 0 || p.neuDiskChanged === true)
  /** ok 那批：每一次都该真的落过盘 —— 这是「走的是编排层、不是判据层」的行为凭据。 */
  const okSilent = okPairs.filter((p) => (p.neuWrites ?? 0) === 0)

  // ① 三态是**结构性**差异：旧契约没有 needs_choice 这一态（判定不出意图就是抛错），
  //    所以「新列 > 0 而旧列恒 0」不会随语料波动而假绿，只可能靠新入口真被走到。
  check(
    neuChoice > 0 && oldChoice === 0 && choicePairs.length === neuChoice,
    '新列出现 needs_choice、旧列恒 0（三态只在新契约列出现，两列不同源）',
    choicePairs.length > 0 && choicePairs.length === neuChoice && oldChoice === 0
      ? `旧 needs_choice=${oldChoice}（旧契约没这一态），新 needs_choice=${neuChoice}，点名：${nameIds(choicePairs.map((p) => `${p.id}(${p.klass})`))}`
      : choicePairs.length !== neuChoice
        ? `三态计数与逐条配对不符：新列 needs_choice=${neuChoice}，而编辑路径配对只有 ${choicePairs.length} 条（本列 scope=${scopes}）—— 这一态不是新契约入口挣来的，要么没走真入口，要么计数被重复累加`
        : `旧 needs_choice=${oldChoice}、新 needs_choice=${neuChoice} —— 两列在三态上无差别：新列要么没走新契约入口，要么就是旧列副本 ｜ 旧 ${JSON.stringify(totals.old)} ｜ 新 ${JSON.stringify(totals.neu)}`,
  )

  // ② 「新列 ok 与旧列 ok 不同源」：逐条比对编辑路径上的结果。新列若是旧列的副本，
  //    这一批会逐条相同（变异实测：把 replayNew 换成 replayOld ⇒ 本条必红）。
  check(
    diffPairs.length > 0 && okFlip.length > 0,
    '新列 ok 与旧列 ok 不同源（编辑路径逐条结果不同，不是同一份结果的两次打印）',
    editPairs.length === 0
      ? '编辑路径一条都没跑（引擎未就绪或语料里没有 aura_edit 条目）—— 无从判断两列是否同源'
      : diffPairs.length === 0
        ? `编辑路径 ${editPairs.length} 条逐条结果与旧列完全一致（旧列 ${JSON.stringify(totals.old)}）—— 新列疑似旧列副本`
        : `编辑路径 ${editPairs.length} 条里 ${diffPairs.length} 条结果不同，其中 ok 归属翻转 ${okFlip.length} 条，点名：${nameIds(okFlip.map((p) => `${p.id}:旧=${p.old}→新=${p.neu}`))}`,
  )

  // ③ 新列的成功必须出自内容寻址。若有人把新列改成「先试 old，失败再退回旧坐标 hunk」，
  //    表面读数更漂亮，但成功的来源已经不是新契约了——本条专盯这一手。
  check(
    okPairs.length > 0 && foreignOk.length === 0,
    '新列每一次 ok 都出自 old / old+context 内容寻址（不是旧坐标 hunk 侥幸命中）',
    okPairs.length === 0
      ? '新列在编辑路径上一条 ok 都没有 —— 成功的来源无从判断'
      : foreignOk.length === 0
        ? `ok ${okPairs.length} 条全部带内容寻址（old+context ${ctxOk.length} / 仅 old ${plainOk.length}）`
        : `ok ${okPairs.length} 条里 ${foreignOk.length} 条不带 old/old+context 地址，点名：${nameIds(foreignOk.map((p) => `${p.id}:${p.neuAddress ?? '(无地址)'}`))}`,
  )

  /**
   * ⑮ 「新契约列走的是编排层」的**行为**凭据（C51）：
   *
   * 不是去读源码里 import 了谁（那种判据改一行注释就能骗过），而是看**真的落过盘没有**：
   * 判据层 `planHunks` 是纯函数，永远不会调 `writeText`；只有编排层 `applyEditToProvider`
   * 才会在成功那一步真写一次。所以「每一条 ok 都至少写过一次」只能由「走了编排层」挣来。
   * 变异反证（实测）：把这一列改回直接调 `planHunks` ⇒ 每条的写次数归 0，本条当场红并点名。
   */
  check(
    okPairs.length > 0 && okSilent.length === 0,
    '⑮ 新契约列的每一次 ok 都真落过一次盘（走的是编排层，不是判据层的纯规划）',
    okPairs.length === 0
      ? '新列在编辑路径上一条 ok 都没有 —— 走的是哪一层无从判断'
      : okSilent.length === 0
        ? `ok ${okPairs.length} 条全部带写盘记录（writeText 调用数 ≥ 1；判据层 planHunks 永远不会写）`
        : `ok ${okPairs.length} 条里 ${okSilent.length} 条一次盘都没落 —— 这一列没走编排层，点名：${nameIds(okSilent.map((p) => p.id))}`,
  )

  /**
   * ⑭ 第四态**单列一格**且「一个字节都没动」是实测出来的（C51）。
   *
   * 三件事各判一次：① 这一格在**显示口径**里存在且非零（不是并进 ok 或 fail 里被抹掉）；
   * ② 逐条配对数与这一格相等（不重复累加）；③ 每一条的写调用 = 0 **且**副本 sha256 前后相同
   * —— 只看结果字段是自证不了自己的。
   */
  check(
    landedPairs.length > 0 && neuCol.alreadyApplied === landedPairs.length && landedWrote.length === 0,
    '⑭ 第四态「已落地」单列一格，且这一格逐条实测过不写盘（写调用 0 次 + 副本 sha256 未变）',
    landedPairs.length === 0
      ? `新列一条 already_applied 都没有（显示口径里的这一格 = ${neuCol.alreadyApplied}）—— 要么引擎里这一态没了，要么这一列根本没走到编排层`
      : neuCol.alreadyApplied !== landedPairs.length
        ? `显示口径这一格 ${neuCol.alreadyApplied} ≠ 逐条配对 ${landedPairs.length}（计数被重复累加或某一格漏了）`
        : landedWrote.length === 0
          ? `已落地 ${landedPairs.length} 条：逐条 writeText 调用 0 次、副本 sha256 前后相同，点名：${nameIds(landedPairs.map((p) => `${p.id}(${p.klass})`))}`
          : `已落地 ${landedPairs.length} 条里有 ${landedWrote.length} 条动了盘（writes/diskChanged 二选一非零）—— 第四态必须发生在写盘之前，点名：${nameIds(landedWrote.map((p) => `${p.id}:writes=${p.neuWrites} diskChanged=${p.neuDiskChanged}`))}`,
  )

  // ④ 就绪探针与列计数必须自洽：就绪 ⇒ 每条可重放条目在新列里各有归属、且没有 not_ready；
  //    未就绪 ⇒ 0 条成功、可重放条目全部如实计成 not_ready（这一列不许自造寻址）。
  // 分桶和同样走显示口径：C11 段A 那句「分桶之和 == 明细条数」就是这条（缺了 8 就红）。
  // C51：第四态也是「编辑路径上的一条归属」，所以它必须算进这个和里 —— 漏了它，
  // 本条会以「分桶合计 ≠ 编辑路径条数」的形态红，而不是静默地少算 27 条。
  const neuBuckets = neuCol.ok + neuCol.fail + neuCol.needsChoice + neuCol.alreadyApplied + neuCol.unrepresentable
  const notReady = totals.neu.notReady ?? 0
  const neuNa = neuCol.na
  check(
    result.engine.ready
      ? notReady === 0 && neuBuckets === editPairs.length && neuBuckets + neuNa === totals.replayable
      : neuCol.ok === 0 && neuBuckets === 0 && notReady === totals.replayable,
    '新列计数与就绪探针自洽（就绪⇒逐条有归属、无 not_ready；未就绪⇒0 成功且如实计 not_ready）',
    result.engine.ready
      ? `就绪：编辑路径 ${editPairs.length} 条，新列分桶合计 ${neuBuckets}（ok ${neuCol.ok}+fail ${neuCol.fail}+needs_choice ${neuCol.needsChoice}+already_applied ${neuCol.alreadyApplied}+unrepresentable ${neuCol.unrepresentable}），加上读路径 na ${neuNa} 与可重放 ${totals.replayable} 相等，not_ready ${notReady}`
      : `未就绪（${result.engine.how}）：not_ready ${notReady} / 可重放 ${totals.replayable}，ok ${neuCol.ok}`,
  )

  // ⑤ 壳层探针的真断言（原先这里是写死的 `check(true, …)`，字面量真值 ⇒ 永不可能失败）。
  //    判的是「探针真读到了 schema 键」+「ready 与读到的键一致」+「两处探针不互相矛盾」。
  const shellKeys = Array.isArray(result.shell.keys) ? result.shell.keys : null
  const shellProbeRead = shellKeys !== null && String(result.shell.how ?? '').includes('hunk')
  const shellDeclares = shellKeys !== null && shellKeys.includes('old') && shellKeys.includes('context')
  check(
    shellProbeRead && result.shell.ready === shellDeclares && !(result.shell.ready === true && result.engine.ready === false),
    '壳层 old/context 声明状态已探明：ready 与读到的 schema 键一致，且不与引擎探针矛盾',
    !shellProbeRead
      ? `探针没读到 schema 键：${result.shell.how}`
      : result.shell.ready !== shellDeclares
        ? `ready=${result.shell.ready} 与 schema 键 [${shellKeys.join(', ')}] 不一致（键表里${shellDeclares ? '有' : '没有'} old+context）`
        : result.shell.ready && !result.engine.ready
          ? `壳层声明了 old/context，引擎却不认 {old}：${result.engine.how}`
          : `schema 键 [${shellKeys.join(', ')}]；壳层就绪=${result.shell.ready}，引擎就绪=${result.engine.ready}`,
  )

  // ⑥ 终态里「每条记 类别/文件/原始 hunk 参数/回执首行/可用原文片段」这半句，纳入判据。
  //    账本条目必须逐条对上**语料文件里那份**原始参数（不是改写成 old+context 之后的那份）。
  const recordFields = ['klass', 'file', 'hunks', 'receipt', 'excerpt']
  const seenIds = new Set()
  const badRecords = []
  for (const rec of result.records) {
    if (seenIds.has(rec.id)) badRecords.push(`${rec.id}:重复记录`)
    seenIds.add(rec.id)
    const miss = recordFields.filter((f) => !(f in rec))
    if (miss.length > 0) {
      badRecords.push(`${rec.id}:缺字段 ${miss.join('/')}`)
      continue
    }
    const frozen = frozenRecords.get(rec.id)
    if (frozen === undefined) badRecords.push(`${rec.id}:语料文件里没有这个 id`)
    else if (freezeRecord(rec) !== frozen) badRecords.push(`${rec.id}:类别/文件/原始 hunk 参数/回执首行与语料文件不一致`)
  }
  const unrecorded = corpus.entries.filter((e) => !seenIds.has(e.id)).map((e) => e.id)
  const withFile = result.records.filter((r) => String(r.file ?? '').length > 0).length
  const withHunks = result.records.filter((r) => Array.isArray(r.hunks) && r.hunks.length > 0).length
  const withExcerpt = result.records.filter((r) => typeof r.excerpt === 'string' && r.excerpt.length > 0).length
  check(
    badRecords.length === 0 && unrecorded.length === 0 && result.records.length === corpus.entries.length,
    '每条明细都记了 类别/文件/原始 hunk 参数/回执首行，且与语料文件逐字一致',
    badRecords.length > 0 || unrecorded.length > 0
      ? `${badRecords.length + unrecorded.length} 条不合格，点名：${nameIds([...badRecords, ...unrecorded.map((id) => `${id}:账本里没有这条`)])}`
      : `账本 ${result.records.length}/${corpus.entries.length} 条；文件非空 ${withFile}、原始 hunk 参数非空 ${withHunks}、带原文片段 ${withExcerpt}（其余是原始调用本身就没给的，如实记空）`,
  )

  // ⑦ 非 drifted 条目必须带可用原文片段：片段是「引文在不在原文里」的唯一凭据，缺了这条
  //    条目就只能靠猜。drifted 本来就没有原文，允许缺。
  const shyExcerpt = result.records
    .filter((r) => !r.drifted && !(typeof r.excerpt === 'string' && r.excerpt.length > 0))
    .map((r) => r.id)
  const nonDrifted = result.records.filter((r) => !r.drifted).length
  check(
    nonDrifted > 0 && shyExcerpt.length === 0,
    '非 drifted 条目都带可用原文片段（缺片段 = 说不清引文在不在原文里）',
    shyExcerpt.length === 0
      ? `非 drifted ${nonDrifted} 条都带片段；drifted ${result.records.length - nonDrifted} 条本就没有原文，允许缺`
      : `缺原文片段 ${shyExcerpt.length} 条，点名：${nameIds(shyExcerpt)}`,
  )

  // ⑬ 冻结基准列（C11 新增，C29 把基准从安装副本改成仓库内夹具）：这一列的全部价值是
  //    「不随现树漂移」，所以下面几条凭据都要成立 —— 夹具在、夹具对得上清单、夹具与现树**不同源**、
  //    独立进程 / 夹具路径 / 摘要与父进程独立算的那份一致 / 逐条读数与现树旧列不同源；
  //    外加「跑完夹具 mtime/size 逐项未变」。
  //    变异反证（实测过）：把夹具目录换成现树那一份 ⇒ 「基准与现树同源」与逐条同源两条同时红并点名；
  //    删掉夹具 ⇒ 「夹具不存在」红并点名；两条异常**都不静默退化**。
  const fb = result.frozen ?? { status: 'unavailable', how: '（没有冻结基准结果）' }
  const fbFixture = fb.fixture ?? { status: 'missing', problems: ['（没有夹具自检结果）'], sameSourceFiles: [] }
  const fbFiles = Array.isArray(fb.engine?.files) ? fb.engine.files : []
  const fbExpected = Array.isArray(fb.expected) ? fb.expected : []
  const insideRoot = (p, root) => {
    const rel = path.relative(root, p)
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  const fbPaths =
    fbFiles.length > 0 &&
    fbFiles.every((f) => {
      const p = path.resolve(String(f.file))
      return insideRoot(p, fb.root) && !insideRoot(p, HERE)
    })
  const fbDigests =
    fbFiles.length === fbExpected.length &&
    fbExpected.every((e) =>
      fbFiles.some((f) => path.resolve(String(f.file)) === path.resolve(e.file) && String(f.sha256) === e.sha256),
    )
  const fbSeparate = Number.isInteger(fb.childPid) && fb.childPid !== process.pid
  const fbPreOld = fb.oldProbe?.ready === false
  const fbComplete = fb.status === 'ok' && columnSum(columnOf(fb.tally)) === totals.replayable
  const fbPerId = fb.perId ?? {}
  // 逐条比对：基准列与「现树·旧入参」列必须至少有一条不同 —— 全同就说明基准列在用现树跑。
  const fbOverlap = result.pairs.filter((p) => fbPerId[p.id] !== undefined)
  const fbSameAsTree = fbOverlap.filter((p) => fbPerId[p.id] === p.old).length
  const fbDistinct = fbOverlap.length > 0 && fbSameAsTree < fbOverlap.length
  const fbTreeClean = Array.isArray(fb.treeChanged) && fb.treeChanged.length === 0
  const fbBad = []
  if (fb.status !== 'ok') fbBad.push(`基准列没跑成：${fb.how ?? fb.status}`)
  // 夹具的两种异常各归各的：先报「在不在 / 对不对得上清单」，再报「是不是被换成了现树」。
  if (fbFixture.status === 'missing') {
    fbBad.push(`冻结基准夹具缺失：${fbFixture.problems.join(' ； ') || `清单与副本都不在 ${fbFixture.root}`}`)
  } else if (fbFixture.status !== 'ok') {
    fbBad.push(`冻结基准夹具对不上清单：${fbFixture.problems.join(' ； ')}`)
  }
  if (Array.isArray(fbFixture.sameSourceFiles) && fbFixture.sameSourceFiles.length > 0) {
    fbBad.push(
      `基准与现树同源：夹具里 ${fbFixture.sameSourceFiles.map((f) => `${f.file}=${String(f.sha256).slice(0, 12)}`).join(' ')} 的 sha256 与现树同名文件相同` +
        ` —— 夹具被拿现树刷新过了，这一列已经不是「改动前」那份`,
    )
  }
  if (!fbPaths)
    fbBad.push(
      `基准引擎不在夹具目录里（子进程报 ${fbFiles.map((f) => f.file).join(', ') || '(空)'}；夹具根 ${fb.root}）—— 这一列不是夹具的代码跑的`,
    )
  if (!fbDigests)
    fbBad.push(
      `引擎摘要对不上父进程独立算的那份（子进程 ${fbFiles.map((f) => `${path.basename(String(f.file))}=${String(f.sha256).slice(0, 12)}`).join(' ')} ｜ 父进程 ${fbExpected.map((e) => `${path.basename(e.file)}=${String(e.sha256).slice(0, 12)}`).join(' ')}）`,
    )
  if (!fbSeparate)
    fbBad.push(
      `基准列不是独立进程跑出来的（子进程 pid=${fb.childPid}，本进程 pid=${process.pid}）—— 现树引擎就地跑出来的读数不算冻结基准`,
    )
  if (!fbPreOld) fbBad.push(`基准引擎认 {old}（${fb.oldProbe?.how ?? '探针没结果'}）—— 它不是「改动前」那份`)
  if (!fbComplete)
    fbBad.push(
      `基准列分桶合计 ${fb.status === 'ok' ? columnSum(columnOf(fb.tally)) : '(无)'} ≠ 可重放 ${totals.replayable} —— 这一列没跑全`,
    )
  if (!fbDistinct)
    fbBad.push(
      fbOverlap.length === 0
        ? '基准列没有逐条结果可比对（子进程没回 perId）—— 无从判断它与现树旧列是否同源'
        : `基准列与「现树·旧入参」列逐条相同（${fbOverlap.length} 条全同）—— 基准列在用现树跑`,
    )
  // 没跑成时上面已经点过名了；这里只在「跑成了、却看到夹具被动过」时说话，
  // 否则会打出一行「被写过：」后面什么都没有的废话。
  if (fb.status === 'ok' && !fbTreeClean) fbBad.push(`冻结基准夹具被写过：${(fb.treeChanged ?? []).slice(0, 4).join(' ｜ ')}`)
  check(
    fbBad.length === 0,
    '⑬ 冻结基准列可用，且确实是夹具那份代码跑出来的（夹具在 / 对得上清单 / 与现树不同源 / 独立进程 / 夹具路径 / 摘要一致 / 夹具 mtime 未变）',
    fbBad.length > 0
      ? fbBad.join(' ； ')
      : `夹具 ${fb.root}（清单记 v${fbFixture.manifest?.version ?? '?'}，构建戳 ${fbFixture.manifest?.buildStamp ?? '(没记)'}，${fbFixture.fileCount}/${fbFixture.expectedCount} 个文件逐个对上清单）；子进程 pid ${fb.childPid}（本进程 ${process.pid}）用 ${fb.root}（v${fb.engine?.version}）跑完 ${fbOverlap.length} 条，逐列 ${columnCell(columnOf(fb.tally))}；引擎摘要 == 父进程独立算的夹具摘要（现树同名文件是另一个值）；夹具不认 {old}；与「现树·旧入参」列逐条比对 ${fbOverlap.length - fbSameAsTree} 条不同（同 ${fbSameAsTree} 条）；夹具整棵目录 ${fb.treeFiles} 项 mtime/size 逐项未变；分桶和 ${columnSum(columnOf(fb.tally))} == 可重放 ${totals.replayable}`,
  )

  if (options.show) {
    console.log('')
    console.log(`=== 逐条明细（前 ${options.show} 条） ===`)
    for (const d of result.details) console.log('  ' + JSON.stringify(d))
  }
  if (options.json) {
    console.log('')
    console.log('=== JSON ===')
    console.log(
      JSON.stringify(
        {
          entries: corpus.entries.length,
          byKlass: Object.fromEntries([...result.perKlass.entries()].map(([k, v]) => [k, v])),
          totals,
          engine: result.engine,
          shell: { ready: result.shell.ready, how: result.shell.how },
          // 判据的输入也一并吐出来：判红时能直接看出是哪一批/哪几条把哪条断言顶掉的。
          recordAudit: { total: result.records.length, withFile, withHunks, withExcerpt, nonDrifted },
          pairs: {
            edit: editPairs.length,
            differing: diffPairs.length,
            okFlip: okFlip.length,
            neuOkByAddress: { 'old+context': ctxOk.length, old: plainOk.length, foreign: foreignOk.length },
            needsChoiceIds: choicePairs.map((p) => p.id),
            /**
             * 第四态那一格与它的两条实测凭据（C51）。`byAddress` 如实报出来是为了让人看得见：
             * 这一态**不是**寻到址挣来的（寻到址就是 ok）——它是编排层看「结果是否已经在文件里」给的回执。
             */
            alreadyApplied: {
              count: landedPairs.length,
              ids: landedPairs.map((p) => p.id),
              byAddress: { 'old+context': landedPairs.filter((p) => p.neuAddress === 'old+context').length, old: landedPairs.filter((p) => p.neuAddress === 'old').length },
              wroteOrChangedDisk: landedWrote.map((p) => p.id),
            },
            /** 走编排层的行为凭据：ok 里一次盘都没落的有几条（应为 0）。 */
            okWithoutWrite: okSilent.map((p) => p.id),
          },
          // 三列的显示口径与分桶和（判据读的就是这几个数）。
          columns: {
            replayable: totals.replayable,
            frozen: fb.status === 'ok' ? { ...columnOf(fb.tally), sum: columnSum(columnOf(fb.tally)) } : null,
            treeOld: { ...oldCol, sum: columnSum(oldCol) },
            treeNew: { ...neuCol, sum: columnSum(neuCol) },
          },
          frozenBaseline: {
            status: fb.status,
            root: fb.root,
            childPid: fb.childPid,
            version: fb.engine?.version ?? null,
            // 夹具自检：缺了 / 被改过 / 被换成现树，都从这里看得出来（判据⑬按这三种分别点名）。
            fixture: {
              status: fbFixture.status,
              manifestPath: fbFixture.manifestPath,
              buildStamp: fbFixture.manifest?.buildStamp ?? null,
              treeHash: fbFixture.manifest?.treeHash ?? null,
              source: fbFixture.manifest?.source?.path ?? null,
              takenAt: fbFixture.manifest?.takenAt ?? null,
              expectedCount: fbFixture.expectedCount,
              fileCount: fbFixture.fileCount,
              missingFiles: fbFixture.missingFiles,
              driftedFiles: fbFixture.driftedFiles,
              extraFiles: fbFixture.extraFiles,
              sameSourceFiles: fbFixture.sameSourceFiles,
              problems: fbFixture.problems,
            },
            engineFiles: fbFiles.map((f) => ({ file: f.file, sha256: f.sha256 })),
            expectedFiles: fbExpected.map((e) => ({ file: e.file, sha256: e.sha256 })),
            acceptsOld: fb.oldProbe?.ready ?? null,
            tally: fb.tally,
            differsFromTree: fbOverlap.length - fbSameAsTree,
            sameAsTree: fbSameAsTree,
            treeFiles: fb.treeFiles,
            treeChanged: fb.treeChanged,
            ms: fb.ms,
            exit: fb.exit,
            how: fb.how,
          },
        },
        null,
        1,
      ),
    )
  }

  const failed = checks.filter((c) => !c.ok)
  console.log('')
  console.log(`${checks.length - failed.length}/${checks.length} 判据通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) await main()
