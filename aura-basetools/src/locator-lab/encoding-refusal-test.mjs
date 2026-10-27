/**
 * encoding-refusal-test —— fs-contract-v2 波20 / C55：非 UTF-8 文件给的是**可执行的拒绝**，
 * 不是裸的 Node 错误。
 *
 * ## 命题（施工单终态，判据不可改）
 *
 * 拒绝本身是对的：磁盘一个字节都没动（本套件逐条复验 sha256）。要改的是**说的内容**。
 * 改动前实测（两个面各跑一遍，读数逐字如下）：
 *
 *   DSH `aura_basetools_read` / `aura_basetools_edit`（后端是裸 `TextDecoder`）：
 *     抛出错误 → 框架只取 error.message: "The encoded data was not valid for encoding utf-8"
 *                error.code = "ERR_ENCODING_INVALID_ENCODED_DATA"
 *   ——不说哪个文件、不说为什么、不说下一步。
 *
 *   DSH 壳（后端是 `dsh-fs-local` 的 `decodeUtf8`）：
 *     "cannot read "<路径>": invalid UTF-8 text" / code = "FS_NOT_TEXT"
 *   ——有路径、有原因，仍**没有下一步**，也没说"这次什么都没写"（写侧最要紧的那一句）。
 *
 *   独立面 `aura read` / `aura edit`（CLI 与 MCP 都走 ops.mjs）：
 *     {"ok":false,"error":"The encoded data was not valid for encoding utf-8",
 *      "code":"ERR_ENCODING_INVALID_ENCODED_DATA"}   exit=2
 *   ——与裸错误逐字相同，路径也没了。
 *
 * ## 段（A/B/C/D：与施工单 desired.accept 逐条对齐；E：本仓既有约定，C58 补的自证）
 *
 *   A **非 UTF-8 读与写都给出可执行拒绝**（含文件名与下一步）：回执必须同一次说清四件事
 *     ——① 是哪个文件 ② 为什么读不了 ③ 下一步怎么办 ④ 这次没有改任何东西。
 *     覆盖 DSH 壳的**两种后端形状**（裸 `TextDecoder` / `dsh-fs-local` 翻过的 `FS_NOT_TEXT`）
 *     与独立面两重（`readEnvelope`/`editEnvelope` 直调 + 真进程 CLI）。通道不变：DSH 侧仍是
 *     **抛错**，独立面仍是 `ok:false` + exit 2；**不许**被伪装成结果通道里的
 *     「判定不出你的意图」（`needs_choice` / `not_found` / `already_applied`）。
 *   B **逐字节不动（拒绝即不写）**：段A 的每一条拒绝之后，四个夹具的 sha256 都必须与
 *     改动前逐字节相同——「nothing was written」是被验过的事实，不是一句话。
 *   C **UTF-8 与带 BOM 的文件不受影响**：带 BOM 的 UTF-8（`TextDecoder` 默认吃掉第一个
 *     BOM）必须**照常读成功**，成功回执里不许出现拒绝文案；无 BOM 的 UTF-8 逐字照旧；
 *     含 NUL 的二进制是**另一件事**（`FS_NOT_TEXT` + `binary file`），不许被这里的文案盖住。
 *     外加一条防漂：三个面上的判据与那句话**逐字同源**（本波写范围不共享模块，
 *     靠本段抽出来比对，抄漏一处就红）。
 *   D **登记进闸 + 退出码接线**：本文件必须在 `build/release-check.mjs` 的 `SUITES` 里
 *     （闸内真跑），且自带退出码接线（判据红 ⇒ 闸红），两者都在本段当场核对源码。
 *   E **不写用户真实 home**（C58 加的，对应本仓既有约定，不在施工单那四条里）：本套件驱动的
 *     每一次引擎调用（进程内落盘账本 / DSH 壳记账 / 真 CLI 子进程）都把观测缓存指到**它自己的
 *     临时目录**。判据是「指针自证（E1/E2）+ 源码不再引用真实 home（E3）」；早先的
 *     「整棵树跑前跑后哈希不变」会与并发会话的正常写入竞争（实测 8/8 红），已撤掉。
 *
 * 跑法：`node src/locator-lab/encoding-refusal-test.mjs`，全绿 exit 0。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { contextServices } from './mock-ctx.mjs'
import { openProvider, readEnvelope, editEnvelope } from '../aura-standalone/lib/ops.mjs'
import { observationsPath } from '../aura-standalone/lib/observation-store.mjs'
import { probeEncoding } from '../aura-standalone/lib/encoding.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label })
  say(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const SELF = fileURLToPath(import.meta.url)
const TMP = path.join(os.tmpdir(), `encoding-refusal-${Date.now()}-${process.pid}`)
fs.mkdirSync(TMP, { recursive: true })

/**
 * ── 观测缓存一律落**本套件自己的临时目录**（C58）────────────────────────────────
 *
 * 引擎落盘账本的路径由 `AURA_CACHE_DIR` 决定（`aura-standalone/lib/observation-store.mjs` 的
 * `observationsPath()`：`process.env.AURA_CACHE_DIR ?? path.join(os.homedir(), '.aura')`）——
 * **默认值就是用户真实的 home**。本套件有三处会让引擎记账，默认全都打在那儿：
 *   ① `openProvider(TMP)` 装的那份**落盘**账本（进程内）：段A 的 `readEnvelope`/`editEnvelope`
 *      与段C 两次成功的读都走它；
 *   ② 同一个进程里 DSH 壳那两次成功的读——`setObservationStore` 是 `read-core.mjs` 的模块级单例，
 *      壳与独立面共用同一道缝，所以壳的记账也落在同一份盘上账本里；
 *   ③ `runCli` 起的每一个真 CLI 子进程（**每次调用都是新进程**，各自读一次环境变量）。
 * 三处共用下面这一个环境变量 ⇒ 必须在**任何引擎调用之前**把它钉死，子进程再显式继承一份。
 *
 * 照抄的仓内先例（同一句 `AURA_CACHE_DIR: <临时目录>`）：
 *   · `aura-standalone/test/standalone-test.mjs`  `const env = { ...process.env, AURA_CACHE_DIR: cache }`
 *   · `locator-lab/cli-mcp-e2e-test.mjs`         `const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }`
 *   · `locator-lab/observation-store-identity-test.mjs`  `cli(cacheDir, …)`（每个子进程各带一份）
 *
 * 这里是**覆盖**、不是沿用调用方给的值：闸内父进程传进来的那份也一并盖掉——本套件要自证的是
 * 「它自己把缓存指到了临时目录」，不是「碰巧没人给它指错」。反面价码（改前实测）：漏掉这一行，
 * `node src/locator-lab/encoding-refusal-test.mjs` 每跑一次就把
 * `~/.aura/observations.json` 写大一次（11246B → 11252B）。判据在段E：指针只在临时目录，
 * 且源码不再引用真实 home；不是「跑完删掉」。
 */

/** 落盘账本目录（理由见上）：本套件自己的临时目录，`TMP` 被删掉时一起消失。 */
const CACHE = path.join(TMP, 'cache')
process.env.AURA_CACHE_DIR = CACHE

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const utf8 = (s) => Buffer.from(s, 'utf8')
const write = (name, bytes) => {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, bytes)
  return p
}

// ════════════════════════════════════════════════════════════════════════════
// 夹具（字节是手写的，不经过任何编码器——判据要能逐字节复验）
// ════════════════════════════════════════════════════════════════════════════
/** GBK 的「中文」：`0xd6` 是二字节前导、`0xd0` 不是后继字节 ⇒ 不是合法 UTF-8 序列。 */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
const PLAIN_SRC = utf8('export const a = 1;\nexport function f() {\n  return 2\n}\n')
const GBK_SRC = Buffer.concat([
  utf8('export const a = 1; // '),
  GBK_ZHONGWEN,
  utf8('\nexport function f() {\n  return 2\n}\n'),
])
/** 带 BOM 的 UTF-8——它**本来就能读**，改动前后都必须成功（段C 的反向判据）。 */
const BOM_SRC = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PLAIN_SRC])
/** 含 NUL 的二进制：`FS_NOT_TEXT` 的另一个分支，说法必须与「不是 UTF-8」分开。 */
const NUL_SRC = Buffer.concat([utf8('alpha\n'), Buffer.from([0x00]), utf8('beta\n')])

const gbkPath = write('gbk.mjs', GBK_SRC)
const plainPath = write('plain.mjs', PLAIN_SRC)
const bomPath = write('bom.mjs', BOM_SRC)
const nulPath = write('nul.dat', NUL_SRC)

/** 每个夹具的「改动前」字节指纹：段B 在每一次拒绝之后复验，段C 结束时再复验一次。 */
const BEFORE = new Map([
  [gbkPath, sha256(gbkPath)],
  [plainPath, sha256(plainPath)],
  [bomPath, sha256(bomPath)],
  [nulPath, sha256(nulPath)],
])
const unchanged = () => [...BEFORE].filter(([p, h]) => sha256(p) !== h).map(([p]) => path.basename(p))
/** 段B 的判据：一次拒绝都没让磁盘动过。 */
const checkUntouched = (label) => {
  const dirty = unchanged()
  check(dirty.length === 0, `B/${label}：四个夹具的 sha256 与改动前逐字节相同`, dirty.join(', '))
}

// ════════════════════════════════════════════════════════════════════════════
// 三个面：DSH 读壳 / DSH 写壳 / 独立面（CLI 与 MCP 共用 ops.mjs）
// ════════════════════════════════════════════════════════════════════════════
const readPlugin = await import('../aura-read/index.js')
const editPlugin = await import('../aura-edit/index.js')
const provider = openProvider(TMP)

/**
 * 后端的三种形状，都是**实测出来的**，不是编的：
 *   raw    —— 裸 `TextDecoder` 的 TypeError（BASE 段的读数：消息里没有文件名）；
 *   local  —— `dsh-fs-local` 的 `decodeUtf8`：同一个 TypeError 被翻成 `FS_NOT_TEXT`
 *             + `cannot read "<路径>": invalid UTF-8 text`；
 *   binary —— 同一个 `FS_NOT_TEXT` 码的**另一个分支**（含 NUL 的二进制，正文是 `binary file`）。
 *             它不该被 C55 的新文案盖住——这一条是段C 的反向判据。
 */
function decodeWith(shape, buffer, displayPath) {
  if (shape === 'binary') {
    throw Object.assign(new Error(`cannot read "${displayPath}": binary file`), { code: 'FS_NOT_TEXT' })
  }
  if (shape === 'local') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw Object.assign(new Error(`cannot read "${displayPath}": invalid UTF-8 text`), { code: 'FS_NOT_TEXT' })
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
}

/** 与真后端同形的 fs 服务（成员一个不少；mock 缺什么就等于那块没测）。 */
function fsService(shape) {
  const abs = (t) => (typeof t === 'string' ? t : t.targetKey)
  return {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    stat: async (t) => {
      const p = abs(t)
      if (!fs.existsSync(p)) return undefined
      const st = fs.statSync(p)
      if (st.isDirectory()) return { type: 'directory', size: 0 }
      return { type: 'file', size: st.size, version: `${st.size}:${Math.trunc(st.mtimeMs)}` }
    },
    readText: async (t) => decodeWith(shape, fs.readFileSync(abs(t)), abs(t)),
    readByteRange: async (t, r) => new Uint8Array(fs.readFileSync(abs(t)).subarray(r.offset, r.offset + r.length)),
  }
}

/** 像加载器那样 apply 一次，再真的 execute 一次；抛错也当成读数带回来。 */
async function runShell(plugin, shape, args) {
  let registered = null
  const ctx = {
    fs: fsService(shape),
    // 与真 Cordis 上下文同形（inject / get 都必须在场）——理由见 mock-ctx.mjs 的注释。
    ...contextServices(),
    tools: { register: (t) => (registered = t), get: () => registered },
    emit: () => {},
    systemPrompt: { section: () => () => {} },
  }
  plugin.apply(ctx)
  const exec = { agent: { session: { header: { cwd: TMP } } }, signal: undefined }
  try {
    return { threw: false, value: await registered.execute(args, exec) }
  } catch (error) {
    return { threw: true, error }
  }
}

const CLI = path.join(REPO_ROOT, 'src', 'aura-standalone', 'bin', 'aura.mjs')
/**
 * 真进程跑一次 CLI（独立面的第二重：不只看函数返回值，看进程真的怎么表态）。
 *
 * `env` 里那一个 `AURA_CACHE_DIR` 不能省：**每个 CLI 都是一次新进程**，账本落哪里由它自己那一次
 * `observationsPath()` 说了算，所以「指路」这件事必须在**每一次 spawn 上**各自成立一次。
 * 不写 `env` 时子进程拿到父进程的环境块——那条路只是“碰巧能行”（模块顶部已经改过
 * `process.env`），一旦上面那一行被挪走/覆盖，子进程会静默改用用户真实的 `~/.aura`，而进程内
 * 那一路可能另有遮盖：一个写点绿、另一个写点红是最难查的形状。显式传一份与进程内同一路径的
 * 临时缓存，三处写点（进程内落盘账本 / DSH 壳记账 / 真 CLI）就都挂在同一个 `CACHE` 上。
 * 先例：`locator-lab/observation-store-identity-test.mjs` 的 `cli(cacheDir, …)` 同形。
 */
function runCli(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, AURA_CACHE_DIR: CACHE },
  })
  let env = null
  try {
    env = JSON.parse((res.stdout ?? '').trim().split('\n').pop())
  } catch {
    env = null
  }
  return { status: res.status, env, stderr: (res.stderr ?? '').trim() }
}

// ════════════════════════════════════════════════════════════════════════════
// 判据：回执必须说清的那几件事（子串判据，不是全等——各面可以有自己的前后缀，
// 但这几句一个字都不能少）
// ════════════════════════════════════════════════════════════════════════════
const MUST = {
  reason: 'is not UTF-8 text',
  environment: 'environment-level refusal',
  nextHead: 'next:',
  nextAct: 'convert it to UTF-8',
  noWrite: 'nothing was written',
  untouched: 'exactly as they were',
}
/** 结果通道里**不许**出现的东西：这一条是环境故障，不是「判不出你的意图」。 */
const FORBIDDEN_VERDICTS = ['needs_choice', 'not_found', 'already_applied']

/**
 * 「可执行的拒绝」的四件事，逐个查。
 * @param label - 读数标签
 * @param text - 回执正文（DSH 侧是 error.message，独立面是 env.error）
 * @param shape - `{verb: 'read'|'patch', path: <绝对路径>, tool: 'aura_basetools_read'|'aura_basetools_edit'}`
 */
function checkRefusal(label, text, { verb, path: displayPath, tool }) {
  const missing = Object.entries(MUST).filter(([, needle]) => !text.includes(needle))
  check(
    missing.length === 0,
    `${label}：① 哪个文件 ② 为什么 ③ 下一步 ④ 没写盘 —— 四件事齐`,
    missing.length === 0 ? `${text.length} 字符` : `缺 ${missing.map(([k]) => k).join(', ')}`,
  )
  check(text.includes(`cannot ${verb} "${displayPath}"`), `${label}：① 说的是**这个**文件（路径带引号可复制）`)
  check(
    text.includes('read') || text.includes('address'),
    `${label}：② 说明了"这里没有可读/可寻址的文本"`,
  )
  check(text.includes(tool), `${label}：③ 下一步点名回到**这个**工具（${tool}）`)
}

// ════════════════════════════════════════════════════════════════════════════
// 段A 非 UTF-8 读与写都给出可执行拒绝
// ════════════════════════════════════════════════════════════════════════════
say('=== 段A 读与写：非 UTF-8 ⇒ 可执行的拒绝（四件事齐）===')
const readTexts = {}
const writeTexts = {}
{
  for (const shape of ['raw', 'local']) {
    const out = await runShell(readPlugin, shape, { file_path: gbkPath, mode: 'full' })
    check(out.threw === true, `A/读·${shape} 被拒：仍然**抛错**（工具级/环境级故障走错误通道，不走结果通道）`)
    check(
      out.threw && !('outcome' in (out.value ?? {})),
      `A/读·${shape} 没有被伪装成结果通道的判决（回执里没有 outcome）`,
    )
    readTexts[shape] = out.threw ? String(out.error?.message ?? out.error) : ''
    checkRefusal(`A/读·${shape}`, readTexts[shape], { verb: 'read', path: gbkPath, tool: 'aura_basetools_read' })
    check(
      out.threw && typeof out.error?.code === 'string' && out.error.code.length > 0,
      `A/读·${shape} 码原样保留（区分"不是 UTF-8"与别的工具级故障）`,
      out.threw ? String(out.error?.code) : '(没抛)',
    )
  }

  /**
   * 0.21 起：独立面（CLI/MCP 共用 ops.mjs）**支持非 UTF-8**，所以这里不再是拒绝，
   * 而是解码 + 在回执里点名编码。拒绝仍留在 DSH 面：宿主只递 UTF-8 文本。
   */
  const readEnv = await readEnvelope(provider, { file: gbkPath })
  check(
    readEnv.ok === true && readEnv.encoding === 'gb18030',
    'A/读·独立面：非 UTF-8 成功解码并标 encoding=gb18030',
    JSON.stringify({ ok: readEnv.ok, encoding: readEnv.encoding, code: readEnv.code }),
  )
  check(String(readEnv.text ?? '').includes('中文'), 'A/读·独立面：正文是正确的中文（不是乱码）', String(readEnv.text ?? '').slice(0, 40))

  const readCli = runCli(['basetools', 'read', '--file', gbkPath])
  check(
    readCli.status === 0 && readCli.env?.ok === true && readCli.env?.encoding === 'gb18030',
    'A/读·CLI 真进程：exit=0、回执带 encoding=gb18030',
    `exit=${readCli.status}`,
  )
  check(String(readCli.env?.text ?? '').includes('中文'), 'A/读·CLI 真进程：正文是正确的中文')

  // 公开 apply 的行号写要求内容断言；这里只为走到“非 UTF-8 拒绝”那条路，expect 不会被执行。
  const hunks = [{ start_line: 1, end_line: 1, expect: 'export const a = 1;', replace: 'export const a = 9;' }]
  for (const shape of ['raw', 'local']) {
    const out = await runShell(editPlugin, shape, { file_path: gbkPath, hunks })
    check(out.threw === true, `A/写·${shape} 被拒：仍然**抛错**（不是结果通道里的 not_found / needs_choice）`)
    check(
      out.threw && !('outcome' in (out.value ?? {})),
      `A/写·${shape} 没有被伪装成结果通道的判决（回执里没有 outcome）`,
    )
    writeTexts[shape] = out.threw ? String(out.error?.message ?? out.error) : ''
    checkRefusal(`A/写·${shape}`, writeTexts[shape], { verb: 'patch', path: gbkPath, tool: 'aura_basetools_edit' })
  }

  // 独立面写：在**副本**上改（原文件留给段B 的“拒绝即不写”断言）。
  // 改的是**第 2 行**（纯 ASCII），第 1 行的中文必须保留——否则文件变成纯 ASCII，
  // “改后仍是 GBK”就成了一句没有信息量的断言。
  const copyHunks = [{ start_line: 2, end_line: 2, replace: 'export function g() {' }]
  const copy = write('gbk-copy.mjs', GBK_SRC)
  const writeEnv = await editEnvelope(provider, { file: copy, hunks: copyHunks })
  check(
    writeEnv.ok === true,
    'A/写·独立面：GBK 文件可改（写回同一编码）',
    JSON.stringify({ ok: writeEnv.ok, code: writeEnv.code, error: String(writeEnv.error ?? '').slice(0, 80) }),
  )
  const afterCopy = fs.readFileSync(copy)
  check(afterCopy.includes(GBK_ZHONGWEN), 'A/写·独立面：含中文的第 1 行字节被逐字节保留')
  check(probeEncoding(afterCopy).encoding === 'gb18030', 'A/写·独立面：改后仍是 GBK', probeEncoding(afterCopy).encoding)

  const writeCli = runCli(['basetools', 'edit', '--file', copy, '--lines', '2', '--replace', 'export function g() {'])
  check(writeCli.status === 0 && writeCli.env?.ok === true, 'A/写·CLI 真进程：GBK 文件可改（exit=0）', `exit=${writeCli.status}`)

  // 预演：DSH 壳仍然拒绝（它拿到的只有宿主解码后的文本，非 UTF-8 根本到不了这层）。
  const dry = await runShell(editPlugin, 'raw', { file_path: gbkPath, hunks, dry_run: true })
  check(dry.threw === true, 'A/写·dry_run 预演：DSH 面同样被可执行地拒绝（预演不能报"没事"）')

  check(writeTexts.raw === writeTexts.local, 'A/写·DSH 两种后端形状渲染出的拒绝正文逐字相同')
  check(
    readTexts.raw !== writeTexts.raw && writeTexts.raw.includes('cannot patch'),
    'A/写侧的正文与读侧**不是**同一句（cannot patch vs cannot read；动词不同，判据同一份）',
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 段B 逐字节不动（拒绝即不写）
// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段B 拒绝即不写：磁盘逐字节不动 ===')
{
  checkUntouched('段A 全部拒绝之后')
  // 写路径是多带一层风险的：它本来**就要**落盘。所以这里额外单独再核一次——
  // 判据不是"没抛错"，而是"抛了错、而磁盘与读之前逐字节相同"。
  check(
    unchanged().length === 0 && fs.readFileSync(gbkPath).equals(GBK_SRC),
    'B/写路径被拒后：被寻址的那份 GBK 文件仍与改动前的字节**完全相同**（含未被寻址的行）',
    `${fs.readFileSync(gbkPath).length}B / sha256=${sha256(gbkPath)}`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 段C UTF-8 与带 BOM 的文件不受影响 + 三面同源
// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段C 不误伤：BOM 的 UTF-8 是好的；二进制是另一件事；三处判据同源 ===')
{
  const forbidden = Object.values(MUST)

  // C1 带 BOM 的 UTF-8：**照常读成功**（TextDecoder 默认 ignoreBOM，只吃掉第一个 BOM）。
  const bomRead = await runShell(readPlugin, 'raw', { file_path: bomPath, mode: 'full' })
  check(
    bomRead.threw === false && bomRead.value?.outcome === 'applied',
    'C1 带 BOM 的 UTF-8：DSH 读壳照常**成功**（没有被误判成非 UTF-8）',
    bomRead.threw ? String(bomRead.error?.message).slice(0, 80) : `outcome=${bomRead.value?.outcome}`,
  )
  check(
    bomRead.threw === false && forbidden.every((n) => !String(bomRead.value?.text ?? '').includes(n)),
    'C1 带 BOM 的 UTF-8：成功回执里没有一句拒绝文案',
  )
  const bomEnv = await readEnvelope(provider, { file: bomPath })
  check(bomEnv.ok === true, 'C1 带 BOM 的 UTF-8：独立面同样成功', String(bomEnv.code ?? ''))

  // C2 无 BOM 的 UTF-8：逐字照旧（成功路径的行为一个比特没动）。
  const plainRead = await runShell(readPlugin, 'raw', { file_path: plainPath, mode: 'full' })
  check(
    plainRead.threw === false && plainRead.value?.outcome === 'applied' && String(plainRead.value?.text ?? '').includes('return 2'),
    'C2 无 BOM 的 UTF-8：照常读出内容（成功路径不变）',
  )
  const plainEnv = await readEnvelope(provider, { file: plainPath })
  check(plainEnv.ok === true, 'C2 无 BOM 的 UTF-8：独立面照常成功')

  // C3 含 NUL 的二进制是**另一件事**：同一个 FS_NOT_TEXT 码，说法不许被新文案盖住。
  const nulRead = await runShell(readPlugin, 'binary', { file_path: nulPath, mode: 'full' })
  const nulText = nulRead.threw ? String(nulRead.error?.message ?? '') : ''
  check(
    nulText.includes('binary file') && !nulText.includes(MUST.reason),
    'C3 含 NUL 的二进制：仍拒，但用的是它自己那句（binary file）——两件事没有被合并',
    nulText.slice(0, 100),
  )
  const nulEnv = await readEnvelope(provider, { file: nulPath })
  check(
    nulEnv.ok === false && String(nulEnv.error ?? '').includes('binary file') && !String(nulEnv.error ?? '').includes(MUST.reason),
    'C3 含 NUL 的二进制：独立面同样留在 "binary file"',
    String(nulEnv.error ?? '').slice(0, 100),
  )

  // C4 三处源码里的判据与那句话**逐字同源**（本波写范围不共享模块 ⇒ 靠这一条防漂）。
  const SURFACES = [
    ['aura-read/index.js', path.join(REPO_ROOT, 'src', 'aura-read', 'index.js')],
    ['aura-edit/index.js', path.join(REPO_ROOT, 'src', 'aura-edit', 'index.js')],
    ['aura-standalone/lib/ops.mjs', path.join(REPO_ROOT, 'src', 'aura-standalone', 'lib', 'ops.mjs')],
  ]
  for (const name of ['isNonUtf8TextFailure', 'nonUtf8RefusalMessage']) {
    const bodies = SURFACES.map(([label, file]) => {
      const src = fs.readFileSync(file, 'utf8')
      const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src)
      return { label, body: m === null ? null : m[0] }
    })
    const missing = bodies.filter((b) => b.body === null).map((b) => b.label)
    const distinct = new Set(bodies.map((b) => (b.body ?? '').replace(/\s+/g, ' ').trim()))
    check(
      missing.length === 0 && distinct.size === 1,
      `C4 ${name} 在三个面上逐字同源`,
      missing.length > 0 ? `缺：${missing.join(', ')}` : distinct.size === 1 ? `${bodies[0].body.split('\n').length} 行` : `${distinct.size} 个不同版本`,
    )
  }

  // C5 成功路径的字节也没被碰（读是只读工具，这一条钉的是"没有偷偷写回"）。
  checkUntouched('段C 结束')
}

// ════════════════════════════════════════════════════════════════════════════
// 段D 登记进闸 + 退出码接线
// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段D 登记进闸 + 退出码接线 ===')
{
  const gateSrc = fs.readFileSync(path.join(REPO_ROOT, 'build', 'release-check.mjs'), 'utf8')
  check(
    /\[\s*'encoding-refusal'\s*,\s*'src\/locator-lab\/encoding-refusal-test\.mjs'\s*\]/.test(gateSrc),
    'D1 已登记进 release-check.mjs 的 SUITES（闸内**真跑**，退出码被看）',
  )
  check(
    !/'src\/locator-lab\/encoding-refusal-test\.mjs'[\s\S]{0,400}?ranAs:/.test(gateSrc),
    'D2 不是以「闸内别处实跑」的形式豁免掉的（它必须自己跑）',
  )
  // 退出码接线：判据红 ⇒ 闸红。缺了它，这套件就是一条"哑线"（C42 的 A7 闸门判的就是这条）。
  const selfSrc = fs.readFileSync(SELF, 'utf8')
  check(
    /process\.exit\s*\(|process\.exitCode\s*(?:=|\+=|\?\?=)/.test(selfSrc),
    'D3 本套件自带退出码接线（process.exit / process.exitCode）',
  )
  check(
    results.length > 0 && results.some((r) => r.ok) && results.some((r) => typeof r.ok === 'boolean'),
    'D4 本套件真的有判据在跑（不是只有汇总行的空壳）',
    `${results.length} 条`,
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 段E 闸内套件不得写用户真实 home（自证：跑完自己核自己，判据是「逐件哈希不变」）
// ════════════════════════════════════════════════════════════════════════════
say('')
say('=== 段E 不写用户真实 home：观测缓存一律落本套件的临时目录 ===')
{
  // E1 指路本身。这一条是**点名**用的：删掉模块顶部那句 `process.env.AURA_CACHE_DIR = CACHE`
  //    （或把它改回真实 home），`observationsPath()` 立刻回落到 `~/.aura/observations.json`，
  //    这里当场红并把那条路径原样印出来——「忘了指」与「指错了」两种变异都跑不掉。
  const ledger = observationsPath()
  const inside = path.relative(TMP, ledger)
  check(
    inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside),
    'E1 引擎落盘账本的路径在**本套件的临时目录**里（AURA_CACHE_DIR 没回落到 ~/.aura）',
    ledger,
  )

  // E2 子进程那一半：真 CLI 读一份 UTF-8 ⇒ 它的账本必须写进**临时**缓存目录。
  //    这是「指路真的生效」的正向对照：没有它，E1/E3 只能证明「哪儿都没写」，
  //    分不出「指对了」与「运气好」（先例：observation-store-identity-test 段A 的正向对照同义）。
  const probePath = write('probe.mjs', PLAIN_SRC)
  const probe = runCli(['basetools', 'read', '--file', probePath, '--mode', 'full'])
  check(probe.status === 0 && probe.env?.ok === true, 'E2 真 CLI 子进程照常成功（段E 的探针读）', `exit=${probe.status}`)
  const ledgerFile = path.join(CACHE, 'observations.json')
  const ledgerText = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').toLowerCase() : ''
  // 账本里存的是 JSON 串：反斜线是双写的，所以要比对转义后的探针路径（大小写不敏感：同一份
  // 文件在不同写法下可以由 realpath 归一成另一种大小写）。
  // Windows runner 的 TMP 可能是 8.3 短路径，账本存的是 realpath 长路径；两种写法都认。
  const needles = [...new Set([probePath, fs.realpathSync.native(probePath)])].map((p) => JSON.stringify(p).slice(1, -1).toLowerCase())
  check(
    needles.some((needle) => ledgerText.includes(needle)),
    'E2 真 CLI 子进程的观测落进**临时缓存目录**（子进程没有改用用户真实的 ~/.aura）',
    fs.existsSync(ledgerFile) ? `${path.relative(TMP, ledgerFile)} ${fs.statSync(ledgerFile).size}B，含探针路径` : `${ledgerFile} 不存在`,
  )

  // E3 静态守卫：真实 home 的全树哈希会与并发会话的正常写入竞争（实测 8/8 红），
  // 判据改为「套件源码不得重新引入真实 home 入口」；指针自证由 E1/E2 负责。
  const selfText = fs.readFileSync(new URL(import.meta.url), 'utf8')
  // 只扫代码行：顶部注释里就有 `os.homedir()` 的说明，扫全文会把说明当成违规。
  const code = selfText.split(/\r?\n/).filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
  const homeApi = /os\.homedir\s*\(|process\.env\.(?:HOME|USERPROFILE)\b/.exec(code)
  check(
    homeApi === null,
    'E3 套件源码不引用真实 home（AURA_CACHE_DIR 是唯一落点）',
    homeApi === null ? '只有 AURA_CACHE_DIR' : `命中 ${homeApi[0]}`,
  )
}

fs.rmSync(TMP, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
say('')
say(`--- 结果：${results.length - failed.length}/${results.length} 通过 ---`)
for (const f of failed) say(`  FAIL: ${f.label}`)
if (failed.length > 0) process.exitCode = 1
