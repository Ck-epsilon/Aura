/**
 * repair-address-test —— fs-contract-v2 / MT6：**失败回执带"可修复地址"**。
 *
 * ## 命题（本单终态，判据不可改）
 *
 * 现场基线（量具实测）：一次成功率 86.7%、平均 0.714 次返工/三元组、59.3% 的三元组有返工、
 * 失败后自我修正率 80.6%。**失败之后那一次重试**是这一单唯一治的对象：
 *
 *   今天失败回执说的是"nothing was written + 你要改的原文不在文件里 + 最近区域长这样 +
 *   next: 重读文件再按原文传一遍"。也就是说**重试要模型重新转述一段原文**——
 *   而"转述错"正是这个工具最大的一类失败来源（残余 147 条里 B03 55 + B04 46 都是这一类）。
 *   句柄化已经让"读过的东西"可以不转述，但**错误回执里还没有**：模型拿到 not_found 之后，
 *   手里依然没有可用的句柄。
 *
 * 本单的两条改动（都在**正文文本**里——DSH 框架只把 `content` 装进 tool 消息，
 * 壳层的 render 就是 `[{type:'text', text: value.text}]`，挂在结构化字段上的东西**到不了模型眼前**）：
 *
 *   · `PATCH_NOT_FOUND`：回执已经打印了最近区域的逐行原文（`!N| …` 那种边距行），
 *     现在**那一段**多一行 `retry: {"handle":"h…"}` + 一句"把 `replace` 配上这个地址再发一次"；
 *   · `PATCH_AMBIGUOUS` / `needs_choice`：**每个候选**各一行 `retry:`（今天候选已有行号；
 *     句柄让"选一个"变成"抄一个"）。
 *
 * ## 这一套件**不**声称成功率提高
 *
 * 判据是"失败回执给了**可用的**修复地址"，不是"一次成功率提高了"。后者要装上去之后
 * 用 `probes/rework-rate.mjs` 在真机上量——本文件里任何一个数都不构成那个证明。
 *
 * ## 段（判据）
 *
 *   A **地址在场且在正文里**：not_found 的 `message` 里能解析出 `retry: {...}`，
 *     且它给的行区间就是回执自己印的 `Closest region: lines a-b`；
 *   B **回路测试（本单最有价值的判据）**：引文写错 ⇒ 必然 not_found ⇒ **从正文里**解析出那句
 *     `retry:` ⇒ 拿解析出来的参数 + 自己的 `replace` 再发一次 ⇒ **真的落盘**，且落点正是
 *     回执说的那一段；
 *   C **同形再验 `needs_choice`**：候选里取一个句柄 ⇒ 用它编辑 ⇒ 命中**那个候选**的位置；
 *   D **铸柄口径**：身份标签 / 指纹 / 行号各取自什么（拿 `mintHandle` 对拍，不重写一份哈希）；
 *   E **上限与体积**：候选超过上限时只前 N 条带 `retry:`，其余照今天的方式（行号 + 原文）；
 *   F **判定不许放宽**：失败仍失败（`nothing was written` 照旧）、磁盘一个字节不动、
 *     `nearest` 不叫 `candidates`、回执里不出现把 not_found 记成 `needs_choice` 的触发词；
 *   G **反向证伪**：把铸柄那一步短路（句柄恒为读不到的形式）⇒ 回路测试必须红；
 *     按字节还原 ⇒ 绿，并给 sha256 三元组。
 *
 * 跑法：`node src/locator-lab/repair-address-test.mjs`，全绿 exit 0。
 * 子进程跑法（变异反证用）：`node <本文件> --loop-only`，回路测试绿时 exit 0、红时 exit 1。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 子进程模式：只跑回路测试（变异反证拿它当"被判红的那个件"）。 */
const LOOP_ONLY = process.argv.includes('--loop-only')
/** 引擎目录：本文件与它要测的模块同目录（变异镜像里就是那份镜像的目录）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')

const { applyEditToProvider } = await import('./write-path.mjs')
const { mintHandle, parseHandle } = await import('./handle-core.mjs')

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok: Boolean(ok), label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

const TMP = path.join(os.tmpdir(), `repair-address-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

const encode = (text) => new TextEncoder().encode(text)
const writeBytes = (p, text) => fs.writeFileSync(p, Buffer.from(encode(text)))
const readBytes = (p) => fs.readFileSync(p)
const readTextFile = (p) => new TextDecoder('utf-8', { fatal: true }).decode(readBytes(p))

let version = 1
const calls = { writeText: 0 }
/** 与 `handle-edit-test` 同一份 provider 契约：逐字节写 + 版本 CAS。 */
const provider = {
  stat: async (p) => (fs.existsSync(p) ? { version: `v${version}`, type: 'file', size: fs.statSync(p).size } : undefined),
  readText: async (p) => {
    if (!fs.existsSync(p)) throw Object.assign(new Error(`cannot read "${p}"`), { code: 'FS_NOT_FOUND' })
    return readTextFile(p)
  },
  readByteRange: async (p, range) => readBytes(p).subarray(range.offset, range.offset + range.length),
  writeText: async (p, content, expected) => {
    calls.writeText += 1
    if (expected?.kind === 'replaceIfVersion' && `v${version}` !== expected.version) {
      throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
    }
    writeBytes(p, content)
    version += 1
    return { version: `v${version}`, operation: 'update', after: content }
  },
  editText: async () => {
    throw new Error('editText must not be used by the write path')
  },
}

/** 一次编辑：返回 `{file, before, after, error, code, message, text}`（`message` 就是模型看得见的那一段）。 */
async function edit(file, hunks) {
  const before = readBytes(file)
  const writesBefore = calls.writeText
  let error = null
  try {
    await applyEditToProvider(provider, { displayPath: file, hunks })
  } catch (caught) {
    error = caught
  }
  return {
    file,
    before,
    after: readBytes(file),
    error,
    code: error?.code ?? null,
    message: String(error?.message ?? ''),
    writes: calls.writeText - writesBefore,
  }
}

/**
 * **从正文文本里**解析一行重试参数 —— 这是本套件唯一允许的取地址方式。
 *
 * 为什么解析正文而不是读 `error.retry` 之类的结构化字段：DSH 框架对抛出的错误只取
 * `error.message`（`dsh-tools/lib/index.js` 的 `errorMessage`），其余字段一概不读；
 * 壳层的 render 是 `[{type:'text', text: value.text}]`。**正文就是模型唯一看得见的东西**，
 * 判据必须钉在它上面，否则测的是一个到不了眼前的通道。
 *
 * 解析本身刻意抗格式微调（换行、缩进、`retry:` 前后的空白怎么写都认），
 * 但**不抗内容**：拿出来的对象要能原样喂给下一次调用，所以只认 JSON 那一截。
 *
 * @returns `{handle, raw}`；找不到时 `{handle: null, raw: null}`
 */
function parseRetryFromText(text) {
  const all = [...String(text).matchAll(/retry:\s*(\{[^\n]*?\})/g)]
  if (all.length === 0) return { handle: null, raw: null, all: [] }
  const raws = all.map((m) => m[1])
  for (const raw of raws) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.handle === 'string') return { handle: parsed.handle, raw, all: raws }
    } catch {
      /* 不是 JSON 的那一行跳过：判据是"能照抄"，抄不动的不算 */
    }
  }
  return { handle: null, raw: null, all: raws }
}

/** 回执自己印的最近区间：`Closest region: lines 15-20 of 40`。 */
function regionFromText(text) {
  const m = /Closest region: lines (\d+)-(\d+) of (\d+)/.exec(String(text))
  return m === null ? null : { startLine: Number(m[1]), endLine: Number(m[2]), fileLines: Number(m[3]) }
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

/**
 * not_found 的靶子：40 行、每行唯一；引文取文件第 15–20 行的**前 5 行逐字 + 第 6 行写错**。
 *
 * 这样必然走到 {@link oldNotFoundError}：整行对齐层一处都不命中（第 6 行不是文件里的原文）、
 * 片段层也一处都不命中（那 6 行拼起来不在任何一行里），而回执能算出"最近的那一带"。
 */
const NF_LINES = Array.from(
  { length: 40 },
  (_, i) => `const item${String(i + 1).padStart(2, '0')} = make(${i + 1}, 'tag-${i + 1}')`,
)
const NF_SRC = `${NF_LINES.join('\n')}\n`
const NF_QUOTE = NF_LINES.slice(14, 20).join('\n').replace('const item20', 'const item20TYPO')

/**
 * needs_choice 的靶子：三处一模一样的行。
 *
 * 为什么是**同一行原文出现三次**而不是三行内容相同的块：走的是整行对齐层
 * （`findWindowTier` 对唯一的 `old` 给出 3 个起点）⇒ `PATCH_AMBIGUOUS`，
 * 而 `notfound-receipt-test` 段E5/E6 钉的那句"找不到不当候选卖"是**另一码**，两条路互不干扰。
 */
const AMB_LINES = [
  'const head = 0', // 1
  'const pad01 = 1',
  'const pad02 = 2',
  'const pad03 = 3',
  'const pad04 = 4',
  'const pad05 = 5',
  'const pad06 = 6',
  'const pad07 = 7',
  'const pad08 = 8',
  'const pad09 = 9',
  'const pad10 = 10',
  'const pad11 = 11',
  'const dup = value * 2', // 13
  'const pad12 = 12',
  'const pad13 = 13',
  'const pad14 = 14',
  'const pad15 = 15',
  'const pad16 = 16',
  'const pad17 = 17',
  'const pad18 = 18',
  'const dup = value * 2', // 21
  'const pad19 = 19',
  'const pad20 = 20',
  'const dup = value * 2', // 24
  'const tail = 0', // 25
]
const AMB_SRC = `${AMB_LINES.join('\n')}\n`

let seq = 0
const newFile = (tag, text) => {
  seq += 1
  const file = path.join(TMP, `${tag}-${seq}.mjs`)
  writeBytes(file, text)
  return file
}

// ── 段A：地址在场、且在**正文文本**里 ──────────────────────────────────────

const nfFile = newFile('nf', NF_SRC)
const nf = await edit(nfFile, [{ old: NF_QUOTE, replace: '// replaced' }])
const nfBody = parseRetryFromText(nf.message)
const nfRegion = regionFromText(nf.message)
const nfNearest = nf.error?.nearest ?? null

check(nf.code === 'PATCH_NOT_FOUND', 'A1 引文写错 ⇒ 码仍是 PATCH_NOT_FOUND（不许因为"能给地址"就降级）', String(nf.code))
check(
  nfBody.handle !== null,
  'A2 正文文本里能解析出 `retry: {"handle": …}`（模型唯一看得见的就是这段正文）',
  nfBody.raw ?? '(没有)',
)
check(nfRegion !== null, 'A3 回执照旧印出最近区间（`Closest region: lines a-b of N`）', JSON.stringify(nfRegion))
check(
  nfBody.handle === null ? false : parseHandle(nfBody.handle).ok,
  'A4 解析出来的句柄形状合法（HANDLE_RE 认它）',
  String(nfBody.handle),
)
check(
  nfBody.handle !== null && nfNearest !== null && parseHandle(nfBody.handle).startLine === nfNearest.line && parseHandle(nfBody.handle).endLine === nfNearest.endLine,
  'A5 正文那行给的区间 == 回执自己印的那一带（`nearest.line`–`nearest.endLine`）',
  nfBody.handle === null ? '(无柄)' : `${parseHandle(nfBody.handle).startLine}-${parseHandle(nfBody.handle).endLine} vs ${nfNearest?.line}-${nfNearest?.endLine}`,
)
check(
  /no need to re-quote the text/.test(nf.message),
  'A6 同一段正文里有一句人话说明"不必重抄原文"',
  (/[^:\n]*re-quote[^\n]*/.exec(nf.message)?.[0] ?? '(没有)').trim().slice(-80),
)

// ── 段B：回路测试（not_found）──────────────────────────────────────────────
//
// 最有价值的一条：**从正文解析出来的参数**再发一次，必须真的落盘、且落点是回执说的那一段。

/** 重发那一次要写进去的新文本（6 行，与回执展示的那一带等长）。 */
const loopNewText = NF_LINES.slice(14, 20).map((_, i) => `const repaired${i + 1} = ${i + 1}`).join('\n')

/**
 * 回路（not_found）：造一次必然 not_found 的编辑 ⇒ **从正文里**解析出 `retry:` ⇒ 用解析出来的参数 + 自己的
 * `replace` 再发一次 ⇒ 必须成功落盘，且落点正是回执说的那一段。
 *
 * 解析走 {@link parseRetryFromText}（只读正文，不碰结构化字段），因为正文是模型唯一看得见的东西。
 */
async function loopNotFound() {
  const file = newFile('loop-nf', NF_SRC)
  const first = await edit(file, [{ old: NF_QUOTE, replace: '// replaced' }])
  const body = parseRetryFromText(first.message)
  if (body.handle === null) return { ok: false, why: '正文里没有可解析的 retry 参数', first }
  const parsed = parseHandle(body.handle)
  const second = await edit(file, [{ handle: body.handle, replace: loopNewText }])
  const text = readTextFile(file)
  const rows = text.split('\n')
  const region = rows.slice(parsed.startLine - 1, parsed.endLine)
  /** 五个分量各留一个读数：回路红时要一眼看出是**哪一步**不对，而不是只看到"红"。 */
  const parts = {
    landed: second.error === null,
    oneWrite: second.writes === 1,
    // 第二次编辑**之前**磁盘上仍是那次失败的原文（第一次真的一个字节没写）
    untouchedBefore: second.before.equals(Buffer.from(encode(NF_SRC))),
    atThatSpot: region.join('\n') === loopNewText,
    // 文件行数不变（区间替换成等长文本）：`split('\n')` 末尾那个空元素也算一格 ⇒ +1
    lineCount: rows.length === NF_LINES.length + 1,
    endsWithNewline: text.endsWith('\n'),
  }
  const ok = Object.values(parts).every(Boolean)
  // 原始读数一律打印：这一条是本单最有价值的判据，读数要比结论更容易被人复核。
  say(`  第一次（引文写错）：code=${first.code}  正文解析出的 retry=${body.raw}`)
  say(`  重发参数：{"handle":"${body.handle}","replace":"<6 行新文本>"}`)
  say(
    `  重发结果：error=${second.error === null ? 'null' : second.code}  写盘=${second.writes} 次  ` +
      `落点行 ${parsed.startLine}-${parsed.endLine} 现在的字节=${JSON.stringify(region.join('\n'))}`,
  )
  return {
    ok,
    why: ok
      ? '落盘且落点一致'
      : `分项：${JSON.stringify(parts)} ｜ error=${second.code} writes=${second.writes} region=${JSON.stringify(region.join('\n'))}`,
    first,
    second,
    handle: body.handle,
    parsed,
    region,
  }
}

const loop = await loopNotFound()
check(loop.ok, 'B1 回路：正文解析出的 retry 参数 + 自己的 replace 再发一次 ⇒ 真的落盘', loop.why)
check(
  loop.ok && loop.parsed.startLine === nfNearest?.line && loop.parsed.endLine === nfNearest?.endLine,
  'B2 回路：落点正是回执说的那一段（不是别处、也不是整个文件）',
  loop.parsed === undefined ? '(未跑)' : `${loop.parsed.startLine}-${loop.parsed.endLine} vs ${nfNearest?.line}-${nfNearest?.endLine}`,
)

if (LOOP_ONLY) {
  /**
   * 子进程模式：只跑回路测试。
   *
   * 为什么要一个独立模式而不是 in-process 开关：变异反证要在**改了字节的镜像**上跑同一条回路，
   * 而 in-process 的 import 缓存会让人拿到改前那份模块图。子进程 + 退出码是唯一干净的判据。
   */
  const bad = results.filter((r) => !r.ok)
  say(`--- 回路测试：${results.length - bad.length}/${results.length} 通过 ---`)
  process.exitCode = bad.length === 0 ? 0 : 1
}
/* 非 LOOP_ONLY 时继续往下跑（段C–G）；下面这段在子进程模式下不可达。 */
if (!LOOP_ONLY) {
// ── 段C：needs_choice 的回路 ─────────────────────────────────────────────
//
// 同形再验：从**候选里**取一个句柄 ⇒ 用它编辑 ⇒ 必须命中那个候选的位置。

const ambFile = newFile('amb', AMB_SRC)
const amb = await edit(ambFile, [{ old: 'const dup = value * 2', replace: '// nope' }])
const ambBody = parseRetryFromText(amb.message)
const ambCands = amb.error?.candidates ?? []
check(amb.code === 'PATCH_AMBIGUOUS', 'C1 同一行原文出现三次 ⇒ 码仍是 PATCH_AMBIGUOUS', String(amb.code))
check(
  ambCands.length === 3 && ambBody.all.length >= 3,
  'C2 候选清单里**逐条**给出句柄（3 条候选 ⇒ 至少 3 行 retry）',
  `候选 ${ambCands.length} 条 / retry 行 ${ambBody.all.length} 行`,
)
const handleList = ambBody.all
  .map((raw) => {
    try {
      return JSON.parse(raw).handle
    } catch {
      return null
    }
  })
  .filter((h) => typeof h === 'string')
check(
  handleList.length === ambCands.length &&
    handleList.every((h, i) => parseHandle(h).startLine === ambCands[i].line && parseHandle(h).endLine === ambCands[i].endLine),
  'C3 第 i 个句柄的行区间 == 第 i 条候选的行号（顺序与清单一致，可照位置抄）',
  handleList.map((h, i) => `${h}→${ambCands[i]?.line}-${ambCands[i]?.endLine}`).join(' '),
)
check(
  handleList[0] !== undefined && handleList[0] !== handleList[1] && handleList[1] !== handleList[2],
  'C4 三个句柄互不相同（每个候选各铸一个，不是同一个柄印三遍）',
  handleList.join(' '),
)

const picked = 2 // 第三个候选（文件第 24 行）——刻意**不取第一个**：取第一个会让"就近挑一个"的错也蒙对
const pickedHandle = handleList[picked]
const ambLoopBefore = readBytes(ambFile)
const ambLoop = await edit(ambFile, [{ handle: pickedHandle, replace: 'const dup = value * 3' }])
const ambAfter = readTextFile(ambFile).split('\n')
say(`  从候选里取第 ${picked + 1} 个句柄：${pickedHandle}（候选行 ${ambCands[picked]?.line}）`)
say(
  `  用它编辑的结果：error=${ambLoop.error === null ? 'null' : ambLoop.code}  写盘=${ambLoop.writes} 次  ` +
    `第 13/21/24 行现在是 ${JSON.stringify([ambAfter[12], ambAfter[20], ambAfter[23]])}`,
)
check(ambLoop.error === null && ambLoop.writes === 1, 'C5 needs_choice 回路：用候选句柄编辑 ⇒ 成功落盘', `error=${ambLoop.code} writes=${ambLoop.writes}`)
check(
  ambAfter[23] === 'const dup = value * 3' && ambAfter[12] === 'const dup = value * 2' && ambAfter[20] === 'const dup = value * 2',
  'C6 needs_choice 回路：命中的正是**那个候选**（第 24 行），另两处一个字节没动',
  JSON.stringify([ambAfter[12], ambAfter[20], ambAfter[23]]),
)
check(
  !ambAfter.join('\n').includes('// nope') && ambLoopBefore.length > 0,
  'C7 第一次那笔"多处匹配"的编辑一个字节都没落地（`// nope` 不在文件里）',
  '第一次写盘 ' + String(amb.writes) + ' 次',
)

// ── 段D：铸柄口径（与 `mintHandle` 对拍，不重写一份哈希）─────────────────

const nfRows = NF_SRC.split('\n')
const expectedHandle = mintHandle({
  ledgerKey: nfFile,
  regionText: nfRows.slice(nfNearest.line - 1, nfNearest.endLine).join('\n'),
  byteOrderMark: false,
  startLine: nfNearest.line,
  endLine: nfNearest.endLine,
})
check(
  nfBody.handle === expectedHandle,
  'D1 身份标签/指纹/行号三样合起来 == mintHandle(ledgerKey=这一次编辑的键, 文件字节那一段, BOM, 绝对行号)',
  `${nfBody.handle} vs ${expectedHandle}`,
)
/**
 * D2 把三样拆开各验一次（合起来相等也可能两处同时错得对称）：
 * 指纹必须等于**文件里那几行的字节**算出来的摘要。
 */
const { regionFingerprint, identityTag } = await import('./handle-core.mjs')
const parsedNf = parseHandle(nfBody.handle)
check(
  parsedNf.fingerprint === regionFingerprint(nfRows.slice(nfNearest.line - 1, nfNearest.endLine).join('\n'), false),
  'D2 指纹取的是**文件里那几行的原始字节**（不是回执展示的剪裁文本、不是模型引文）',
  `${parsedNf.fingerprint} vs ${regionFingerprint(nfRows.slice(nfNearest.line - 1, nfNearest.endLine).join('\n'), false)}`,
)
check(
  parsedNf.idTag === identityTag(nfFile),
  'D3 身份标签取的是这一次编辑的 ledgerKey（不传 identityKey 时即 displayPath）',
  `${parsedNf.idTag} vs ${identityTag(nfFile)}`,
)
// D4：另一份文件（另一个 ledgerKey）上同形的引文错 ⇒ 铸出的柄身份标签不同（柄拄不到别的文件上）
const nfFile2 = newFile('nf2', NF_SRC)
const nf2 = await edit(nfFile2, [{ old: NF_QUOTE, replace: '// replaced' }])
const nf2Body = parseRetryFromText(nf2.message)
check(
  nf2Body.handle !== null && parseHandle(nf2Body.handle).fingerprint === parsedNf.fingerprint && nf2Body.handle !== nfBody.handle,
  'D4 另一份同内容文件（同字节、另一路径）⇒ 同一指纹、不同身份标签',
  `${nf2Body.handle} vs ${nfBody.handle}`,
)

// ── 段E：上限与体积 ─────────────────────────────────────────────────────

/** 8 处重复（> 上限 5）⇒ 前 5 条带 retry，其余 3 条只有行号 + 原文。 */
const manyLines = []
for (let i = 1; i <= 40; i += 1) manyLines.push(`const pad${String(i).padStart(2, '0')} = ${i}`)
for (const at of [5, 11, 17, 23, 29, 33, 37, 40]) manyLines[at - 1] = 'const many = dup()'
const manyFile = newFile('many', `${manyLines.join('\n')}\n`)
const many = await edit(manyFile, [{ old: 'const many = dup()', replace: '// nope' }])
const manyBody = parseRetryFromText(many.message)
check(
  (many.error?.candidates?.length ?? 0) === 8 && manyBody.all.length === 5,
  'E1 8 处候选 ⇒ 只有前 5 条带 retry（超出上限的照今天的方式只报行号 + 原文）',
  `候选 ${many.error?.candidates?.length} 条 / retry 行 ${manyBody.all.length} 行`,
)
const lastRetryAt = many.message.lastIndexOf('retry: ')
const lastCandidateAt = many.message.lastIndexOf('line 40')
check(
  lastRetryAt > 0 && lastCandidateAt > lastRetryAt,
  'E2 超出上限的那几条候选照旧在正文里（不是被删掉，只是不带地址）',
  `最后一行 retry 在第 ${lastRetryAt} 字符 / 最后一条候选在第 ${lastCandidateAt} 字符`,
)
const manyChars = [...many.message].length
check(manyChars <= 8192, 'E3 8 候选这条回执仍 ≤ 宿主阈值 8192（剪枝器量的是正文）', `${manyChars} 字符`)
const nfChars = [...nf.message].length
say(`  体积读数：not_found 回执 ${nfChars} 字符 / ${Buffer.byteLength(nf.message)} 字节；8 候选回执 ${manyChars} 字符`)

// ── 段F：判定不许放宽 ───────────────────────────────────────────────────

check(nf.after.equals(nf.before), 'F1 not_found 之后磁盘逐字节未动', `${sha256(nf.before).slice(0, 12)} → ${sha256(nf.after).slice(0, 12)}`)
check(nf.writes === 0, 'F2 not_found 那次调用写盘 0 次', `${nf.writes} 次`)
/**
 * F3：**那句钉死的拒绝句**照旧在正文里。
 *
 * 注意它**不是** `nothing was written`：`PATCH_NOT_FOUND` 这一支（`notFoundPinned` 钉住的两句）
 * 从落地那天起就没有那半句，`notfound-receipt-test` 84 条判据里也一条都不含它。
 * 拿它当判据是**错的靶子**——本单只加“怎么修”那一段，拒绝句一个字节都不许动。
 */
check(
  /Coordinates are only a hint, so there is nothing to address — re-read the file and pass the text exactly as it is there/.test(
    nf.message,
  ),
  'F3 钉死的拒绝句照旧逐字在正文里（本单只加"怎么修"那一段）',
  'Coordinates are only a hint … pass the text exactly as it is there',
)
check(nf.error?.candidates === undefined, 'F4 `nearest` 不叫 `candidates`（结构化字段没有让壳把 not_found 翻成 needs_choice）', `candidates=${String(nf.error?.candidates)}`)
const forbidden = ['candidates:', 'ambiguous', 'not unique', 'occurrence']
const leaked = forbidden.filter((w) => nf.message.includes(w))
check(leaked.length === 0, 'F5 not_found 的正文里不出现三态归类用的触发词（否则测量面会把它记成 needs_choice）', leaked.join(',') || '无')
check(
  (nf.error?.next ?? '') !== '' && /pass lines \d+-\d+|re-read/.test(String(nf.error?.next)),
  'F6 `next` 照旧给重读/照抄行区间的指令（新加的那行不替代它）',
  String(nf.error?.next).slice(0, 80),
)
check(
  many.error === undefined || many.error?.candidates?.length === 8,
  'F7 歧义仍歧义：候选一条不少（加句柄不改候选集）',
  `${many.error?.candidates?.length} 条`,
)

// ── 段G：反向证伪（在临时镜像上做，绝不改仓库那份）──────────────────────

/**
 * 镜像：把引擎那 8 个模块 + 本文件复制到 `%TEMP%`，只改 `write-path.mjs` 里的**铸柄那一步**。
 *
 * 为什么改的是"铸柄那一步"而不是别处：本单的全部价值都挂在"柄可不可用"上，
 * 短路它 ⇒ 正文里那行 `retry:` 变成读不到的地址 ⇒ 回路测试必须红。
 * 断言用**子进程退出码**（`--loop-only`），不靠 in-process 的 import 缓存。
 */
const ENGINE_MODULES = [
  'write-path.mjs',
  'locator-api.mjs',
  'anchor-core.mjs',
  'struct-core.mjs',
  'read-core.mjs',
  // read-core 静态 import 它（文档/配置的结构目录）；镜像漏拷 = 回路测试直接 ERR_MODULE_NOT_FOUND。
  'doc-structure.mjs',
  'preflight.mjs',
  'args.mjs',
  'handle-core.mjs',
  'mock-ctx.mjs',
]
const MIRROR = path.join(TMP, 'mirror')
fs.mkdirSync(MIRROR, { recursive: true })
for (const name of ENGINE_MODULES) fs.copyFileSync(path.join(HERE, name), path.join(MIRROR, name))
const mirrorTest = path.join(MIRROR, 'repair-address-test.mjs')
fs.copyFileSync(fileURLToPath(import.meta.url), mirrorTest)

const pristineBytes = readBytes(path.join(MIRROR, 'write-path.mjs'))
const shaBefore = sha256(pristineBytes)
const PRISTINE_TEXT = pristineBytes.toString('utf8')

/** 铸柄那一步的短路：不管给什么都铸一个"读不到"的柄（身份标签全 0 ⇒ 一律身份不符）。 */
const MUTANT = 'const retryLine = (handle) => `${RETRY_LABEL}${JSON.stringify({ handle: "h0000deadbeef:1-1" })}`'
const original = 'const retryLine = (handle) => `${RETRY_LABEL}${JSON.stringify({ handle })}`'
const mutatedText = PRISTINE_TEXT.replace(original, MUTANT)
const mutationLanded = mutatedText !== PRISTINE_TEXT && mutatedText.includes('h0000deadbeef:1-1')

const runLoop = () => {
  const r = spawnSync(process.execPath, [mirrorTest, '--loop-only'], { encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

check(mutationLanded, 'G0 变异确实落进了镜像的 write-path.mjs（字符串替换命中）', MUTANT.slice(0, 60))

const green = runLoop()
check(green.status === 0, 'G1 未变异的镜像上，回路测试绿（exit 0）', `exit=${green.status} ｜ ${green.out.trim().split('\n').slice(-1)[0]}`)

fs.writeFileSync(path.join(MIRROR, 'write-path.mjs'), Buffer.from(mutatedText, 'utf8'))
const shaMutated = sha256(readBytes(path.join(MIRROR, 'write-path.mjs')))
const red = runLoop()
check(red.status !== 0, 'G2 短路铸柄那一步 ⇒ 回路测试必须红（exit ≠ 0）', `exit=${red.status} ｜ ${red.out.trim().split('\n').filter((l) => l.startsWith('✗')).join(' ') || red.out.trim().split('\n').slice(-1)[0]}`)
check(/PATCH_HANDLE_IDENTITY_MISMATCH|PATCH_HANDLE_STALE|没有可解析|exit=1/.test(red.out), 'G3 红的原因正是"那个地址读不到"（不是我别处写坏了）', (red.out.match(/PATCH_HANDLE_[A-Z_]+/) ?? ['(未见 code)'])[0])

fs.writeFileSync(path.join(MIRROR, 'write-path.mjs'), pristineBytes)
const shaRestored = sha256(readBytes(path.join(MIRROR, 'write-path.mjs')))
const greenAgain = runLoop()
check(shaRestored === shaBefore, 'G4 按字节还原 ⇒ sha256 回到原件', `${shaBefore.slice(0, 16)} → ${shaMutated.slice(0, 16)} → ${shaRestored.slice(0, 16)}`)
check(greenAgain.status === 0, 'G5 还原后回路测试立刻回绿（exit 0）', `exit=${greenAgain.status} ｜ ${greenAgain.out.trim().split('\n').slice(-1)[0]}`)
say(`  变异 sha256 三元组：原件 ${shaBefore}`)
say(`                    改坏 ${shaMutated}`)
say(`                    还原 ${shaRestored}`)
check(
  shaBefore === sha256(fs.readFileSync(path.join(HERE, 'write-path.mjs'))),
  'G6 全程没碰过仓库那份 write-path.mjs（变异只落在临时镜像上）',
  sha256(fs.readFileSync(path.join(HERE, 'write-path.mjs'))).slice(0, 16),
)

// ── 汇总 ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok)
say(`--- 结果：${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  say('未通过：')
  for (const f of failed) say(`  ✗ ${f.label}  ${f.detail}`)
  process.exitCode = 1
}
}
