/**
 * alias-identity-test —— **路径别名**（junction / 符号链接）下的陈旧闸门（C61）。
 *
 * ## 这个套件问的问题
 *
 * 观测账本的键必须是**同一个磁盘文件**的键。C54 把**词法**那一半（`.` 段 / 冗余分隔符 /
 * 正反斜线 / 盘符大小写）与**进程内折叠别名**收进了 `read-core.mjs`；C56 把**跨进程**那一半
 * （`realpath`）收进了独立面 CLI/MCP 的磁盘存储（`aura-standalone/lib/observation-store.mjs`）。
 *
 * **DSH 壳这一条路两半都没走到**：壳按 `target.displayPath`（调用方给的那个写法）记账，
 * 而 `displayPath` 是 `ctx.fs.resolve()` 里 `path.resolve(cwd, p)` 的产物 —— 纯词法。
 * 于是 junction / 符号链接这两种写法在账本里是**两个键**：
 *
 *   读 `…\linkdir\Gamma.js`      （建立观测，键 = linkdir 那个写法）
 *   第三方       改掉**被寻址的第 3 行**
 *   写 `…\realdir\Gamma.js`      （无 `expect` 的 `lines=[3,3]` 编辑）
 *   ⇒ 改前实测：`outcome=applied`、磁盘只剩我们的覆盖结果 —— **静默改错**。
 *
 * ## 事实从哪来（本单的方案根据）
 *
 * `dsh-fs` 的类型契约早就把这件事说清楚了（`lib/types/types.d.ts`）：
 *   · `FsTarget.targetKey` —— "Opaque key for **stale guards and target lookup**"（`:10-14`、`:54`）；
 *   · `FsTarget.displayPath` —— "Path for **model/UI-facing output**"（`:56-59`）。
 * `dsh-fs-local` 的实现（`lib/index.js:159`）是 `targetKey: FsTargetKey(await realpath(displayPath))`：
 * **宿主本来就拿着 realpath**，壳只是没往下传。
 *
 * 引擎（`locator-lab/*.mjs`）拿不到这个事实：`build/make-bundle.mjs` 的 `copyFile` 守卫
 * （`:72-84`，ENGINE 清单在 `:38-47`）禁止 ENGINE 文件 `from 'node:fs'`、`process.platform`
 * 与盘符字面量。这是 C54 把 junction 记成"已知边界"的原因；本单把那一半改成由**宿主**递进来。
 *
 * ## 本套件的判据（六段）
 *
 *   段A 读**别名** → 第三方改被寻址行 → 用**真实路径**发无 `expect` 编辑 ⇒ 必须拒绝（改动前必红）。
 *   段B 反向：读**真实路径** → 写**别名** ⇒ 必须拒绝。
 *   段C 两个**真的不同**的文件不得并成一个键（大小写敏感目录里 `Beta.js` 与 `beta.js`）。
 *   段D 模型看到的路径仍是它给的那个（逐字比对，两个方向）。
 *   段E 同一写法的正常编辑仍成功（不许退化成"一律拒绝"）——含改了别处、被寻址行没动的正向例。
 *   段F 登记与退出码：本文件自己表态（闸侧登记在 `build/release-check.mjs` 的 SUITES）。
 *
 * ## 这个套件为什么跑**真壳**而不是只跑独立面
 *
 * 独立面 CLI/MCP 那一侧 C56 已经修了（磁盘存储自己做 realpath），拿它验等于把本单的**成因**
 * 抹掉。所以这里 `import` 两个壳的 `apply(ctx)` 与 `registered.execute`，配上与
 * `dsh-fs-local` **同形**的 `ctx.fs`（`resolve` 给 `{displayPath, targetKey}`、`stat` 给
 * 版本令牌），在**真文件系统**上真建 junction / 符号链接。
 *
 * 关键：给 `targetKey` **真的 realpath**。若如实照抄壳今天拿到的两个字段却把 `targetKey`
 * 也写成 `displayPath`，那就等于把宿主的事实替换成词法路径——段A/段B 会照样红，而"壳有没有
 * 把 `targetKey` 传下去"这件事就测不到了。本套件测的正是那一段接线。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { contextServices } from './mock-ctx.mjs'
import {
  contentToken,
  hasObservedVersion,
  latestObservation,
  ledgerIdentityKey,
  recallRead,
  rememberRead,
  setObservationStore,
} from './read-core.mjs'

const say = (m) => fs.writeSync(1, `${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}
/**
 * 「本机跑不了这一支」—— 与「跑过了、绿」是两句不同的话（C62 段CS）。
 *
 * 它**不计入通过数**，但也不是默不作声：`⊘` 行当场打出来，收尾的汇总行还与在案 ——
 * 一条永远绿的死支就是这样被防住的（`F6` 会把"这一跑到底走没走到那一支"记在总账里）。
 */
const skips = []
const skip = (label, reason = '') => {
  skips.push({ label, reason })
  say(`⊘ 跳过 ${label}${reason ? `  ${reason}` : ''}`)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..', '..') // 包根/

// ── 靶场 ────────────────────────────────────────────────────────────────────
const tmp = path.join(os.tmpdir(), `c61-alias-${Date.now()}`)
const REAL = path.join(tmp, 'realdir')
const LINK = path.join(tmp, 'linkdir')
fs.mkdirSync(REAL, { recursive: true })

/**
 * 建一个**真**目录别名。
 *
 * Windows 上 `symlinkSync(...,'dir')` 与 `junction` 都能用（本机实测都成功），
 * 优先 junction：它不依赖开发者模式/特权，且正是任务书点名的形态。
 * 建不出来时如实报一条失败判据并把后面几段标成跳过 —— 不许静默降级成"没测"。
 */
const linkProblem = (() => {
  try {
    fs.symlinkSync(REAL, LINK, process.platform === 'win32' ? 'junction' : 'dir')
    return null
  } catch (error) {
    return `${error.code ?? 'ERR'}: ${error.message}`
  }
})()
const hasLink = linkProblem === null

const ORIGINAL = 'line one\nline two\nline three\n'
const AFTER_THIRD_PARTY = 'line one\nline two\nline three CHANGED BY B\n'
const readDisk = (p) => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(p))
const writeDisk = (p, text) => fs.writeFileSync(p, Buffer.from(new TextEncoder().encode(text)))

// ── 真壳：与 dsh-fs-local 同形的 ctx.fs ─────────────────────────────────────
/**
 * `resolve` 与 `dsh-fs-local/lib/index.js:153-160` 的 `resolveLocalTarget` **同形**：
 * `displayPath` = `path.resolve(cwd, p)`（词法绝对路径），`targetKey` = `realpath(displayPath)`。
 * 缺目标时退回"最近的已存在祖先 + 剩余名字"，这里只在文件确实不存在时才用得到。
 */
const fsService = {
  resolve: async (p, options = {}) => {
    const displayPath = path.resolve(options.cwd ?? process.cwd(), p)
    let targetKey
    try {
      targetKey = fs.realpathSync.native(displayPath)
    } catch {
      targetKey = displayPath
    }
    return { displayPath, targetKey }
  },
  stat: async (t) => {
    if (!fs.existsSync(t.targetKey)) return undefined
    const st = fs.statSync(t.targetKey, { bigint: false })
    if (st.isDirectory()) return { type: 'directory', size: 0, version: `dir-${st.mtimeMs}` }
    if (!st.isFile()) return { type: 'other', size: 0, version: `other-${st.mtimeMs}` }
    // 形状抄 `dsh-fs-local` 的 `versionOf`：身份 + 新鲜度字段拼成的不透明串。
    return { version: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`, type: 'file', size: st.size }
  },
  readText: async (t) => readDisk(t.targetKey),
  readByteRange: async (t, range) => fs.readFileSync(t.targetKey).subarray(range.offset, range.offset + range.length),
  /** 逐字节写 + 版本 CAS（真提供方的语义）：版本对不上就抛 FS_STALE_VERSION。 */
  writeText: async (t, content, expected) => {
    if (expected?.kind === 'replaceIfVersion') {
      const st = fs.statSync(t.targetKey)
      const now = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
      if (expected.version !== now) throw Object.assign(new Error('stale version'), { code: 'FS_STALE_VERSION' })
    }
    writeDisk(t.targetKey, content)
    const st = fs.statSync(t.targetKey)
    return { operation: 'update', version: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`, before: content, after: content }
  },
  editText: async (t, edit) => {
    const before = readDisk(t.targetKey)
    const after = before.replace(edit.oldString, edit.newString)
    writeDisk(t.targetKey, after)
    const st = fs.statSync(t.targetKey)
    return { version: `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`, before, after }
  },
  listDir: async () => [],
}

const readPlugin = await import('../aura-read/index.js')
const editPlugin = await import('../aura-edit/index.js')
let readTool = null
let editTool = null
const mkCtx = () => ({
  fs: fsService,
  ...contextServices(),
  tools: {
    register: (t) => (t.name === 'aura_basetools_read' ? (readTool = t) : (editTool = t)),
    get: () => readTool,
  },
  systemPrompt: { section: () => () => {} },
  emit: () => {},
  waterfall: async () => undefined,
})
readPlugin.apply(mkCtx())
editPlugin.apply(mkCtx())
// 本套件钉的是别名/路径身份归一，走未注册的 legacy edit 描述符；公开 apply 的行号断言由 entity-apply 覆盖。
editTool = editPlugin.lastLegacyTools.edit
/** 真 `exec` 形状：壳读 `exec.agent.session.header.cwd`、`exec.signal`（见两个壳的 execute）。 */
const mkExec = () => ({ agent: { session: { header: { cwd: tmp } } }, signal: undefined })

const read = (filePath, args = {}) => readTool.execute({ file_path: filePath, ...args }, mkExec())
const edit = (filePath, hunks) => editTool.execute({ file_path: filePath, hunks }, mkExec())

/** 一次编辑的判决：拒绝要给出**结构化**证据（code），不是只看"抛没抛"。 */
const outcomeOf = async (filePath, hunks) => {
  try {
    const r = await edit(filePath, hunks)
    return { applied: true, receipt: r }
  } catch (error) {
    return { applied: false, code: error?.code, message: String(error?.message ?? error).split('\n')[0] }
  }
}

const fresh = (file, text = ORIGINAL) => {
  setObservationStore(null) // 换存储 = 换会话：段与段之间的账本不许互相污染
  writeDisk(file, text)
}

// ── 段A：读别名 → 写真实路径 ⇒ 必须拒绝（改动前必红）──────────────────────
say('=== A. 读别名 → 第三方改被寻址行 → 用真实路径发无 expect 编辑 ⇒ 必须拒绝 ===')
let aReadPath = null
let aWritePath = null
if (!hasLink) {
  check(false, 'A0 前提：能建出目录别名（junction / symlink）', linkProblem)
} else {
  const realFile = path.join(REAL, 'Gamma.js')
  const linkFile = path.join(LINK, 'Gamma.js')
  aReadPath = linkFile
  aWritePath = realFile
  // 先让文件真的存在：realpath 对不存在的路径会抛，而"同一个磁盘文件"这条前提只能对存在的文件断言。
  fresh(realFile)
  check(
    fs.realpathSync.native(linkFile) === fs.realpathSync.native(realFile),
    'A0 前提：两种写法确实是**同一个磁盘文件**（realpath 相等）',
    `${fs.realpathSync.native(linkFile)} === ${fs.realpathSync.native(realFile)}`,
  )
  const first = await read(linkFile, { mode: 'full' })
  check(first?.path === linkFile, 'A1 读别名：回执里的 path 就是调用方给的那个', JSON.stringify(first?.path))
  writeDisk(realFile, AFTER_THIRD_PARTY) // 第三方
  const a = await outcomeOf(realFile, [{ lines: [3, 3], replace: 'MINE' }])
  check(
    !a.applied && a.code === 'PATCH_STALE_REGION',
    'A2 读别名、写真实路径（无 expect）⇒ 必须结构化拒绝（改动前必红：applied / 静默覆盖）',
    a.applied ? `outcome=${a.receipt?.outcome}` : a.code,
  )
  check(readDisk(realFile) === AFTER_THIRD_PARTY, 'A3 磁盘保持第三方内容（我们的编辑一字未落）', JSON.stringify(readDisk(realFile)))
}

// ── 段B：反向 —— 读真实路径 → 写别名 ⇒ 必须拒绝 ───────────────────────────
say('')
say('=== B. 读真实路径 → 第三方改被寻址行 → 用别名发无 expect 编辑 ⇒ 必须拒绝 ===')
if (!hasLink) {
  check(false, 'B0 前提：能建出目录别名', linkProblem)
} else {
  const realFile = path.join(REAL, 'Delta.js')
  const linkFile = path.join(LINK, 'Delta.js')
  fresh(realFile)
  const first = await read(realFile, { mode: 'full' })
  check(first?.path === realFile, 'B1 读真实路径：回执里的 path 保持原样', JSON.stringify(first?.path))
  writeDisk(realFile, AFTER_THIRD_PARTY)
  const b = await outcomeOf(linkFile, [{ lines: [3, 3], replace: 'MINE' }])
  check(
    !b.applied && b.code === 'PATCH_STALE_REGION',
    'B2 读真实路径、写别名（无 expect）⇒ 必须结构化拒绝（改动前必红）',
    b.applied ? `outcome=${b.receipt?.outcome}` : b.code,
  )
  check(readDisk(realFile) === AFTER_THIRD_PARTY, 'B3 磁盘保持第三方内容', JSON.stringify(readDisk(realFile)))
}

// ── 段C：两个真不同的文件不得并键 ───────────────────────────────────────────
say('')
say('=== C. 两个真的不同的文件不得并成一个键 ===')
{
  /**
   * 两个方向都要钉：
   *   C1 同一目录下 `Beta.js` 与 `beta.js` 是两个**内容不同**的真文件 ⇒ 两次读给出两个键：
   *      按一个的写法编辑另一个之后，**另一个自己的**陈旧判决仍按它自己的观测算
   *      （即：改了 U、编辑 L，L 的观测还在 ⇒ L 照常成功——不许被并成一个键而误拒/误放）。
   *   C2 大小写不敏感的文件系统上这两个名字只有一个真文件（本机 `%TEMP%` 就是），
   *      那时不许把"不存在的那个写法"当成"存在的那一个"来记账 —— 判据是拿**第二个写法**
   *      单独读一次，若它命中同一个文件，则它必须与第一个写法给出同一个身份。
   *
   * ## 为什么还要一块 CS（真·大小写敏感目录，C62）
   *
   * 上面那两支靠**探测本机文件系统**选：本机 `%TEMP%` 大小写不敏感 ⇒ 永远走 C1–C3 那一支，
   * 而这一段真正的命题（两个仅大小写不同的名字是**两个文件**时不许并键）在本机从没被执行过
   * —— 那是一条**死支**。C61 的验收把这件事点破了：判据原文点名的那一格「没有任何一条会红的
   * 判据覆盖它」。
   *
   * 现在按 `stale-gate-test` 段O:636 的先例，用 `fsutil file setCaseSensitiveInfo` **在本机造一个
   * 真·大小写敏感目录**，让那一格真的跑（造不出来时**明写跳过并说明**，不留死支）。
   * CS 段钉的就是 C61 判红的那一格（改前红、改后绿）：
   *
   *   只观测过 `Beta.js` → 对**从未观测过**的、真正不同的 `beta.js` 发无 `expect` 编辑
   *   ⇒ 必须 `applied` + 回执带 `unverified_region`，**绝不许**声称它有过 last observation。
   *
   * 同时钉住反向：真有过观测的目标照旧拒（CS6／CS7）、两个文件的观测不许互相牵连（CS8／CS9）、
   * **内容逐字节相同**的两个身份键也不许并（CS10）、引擎四个查询入口逐个直读（CS11）。
   */
  const dir = path.join(tmp, 'case')
  fs.mkdirSync(dir, { recursive: true })
  const upper = path.join(dir, 'Beta.js')
  const lower = path.join(dir, 'beta.js')
  setObservationStore(null)
  writeDisk(upper, 'U one\nU two\nU three\n')
  const upperText = readDisk(upper)
  let lowerIsSameFile
  try {
    lowerIsSameFile = fs.realpathSync.native(lower) === fs.realpathSync.native(upper)
  } catch {
    lowerIsSameFile = false
  }
  if (lowerIsSameFile) {
    // 大小写不敏感：两个写法是同一个文件 ⇒ 必须被认成同一处（否则闸门又瞎了）
    const cu = await outcomeOf(upper, [{ lines: [2, 2], replace: 'U TWO' }])
    check(cu.applied, 'C1 大小写不敏感：按 U 的写法编辑 U（无第三方改动）⇒ 成功', cu.applied ? 'ok' : String(cu.code))
    const afterEdit = readDisk(upper)
    const cl = await outcomeOf(lower, [{ lines: [1, 1], replace: 'U ONE' }])
    check(cl.applied, 'C2 大小写不敏感：换写法继续编辑同一个文件 ⇒ 认得出同一处观测（不许误拒）', cl.applied ? 'ok' : String(cl.code))
    check(readDisk(upper) !== afterEdit, 'C3 换写法那一次真的落到同一个文件上', JSON.stringify(readDisk(upper)))
    /**
     * C4 是**兜底不许被拆**那一侧：这两个写法在**没有身份键**时必须仍然被折叠认成一处。
     *
     * 没有身份键的入口就是引擎本身（独立面 CLI/MCP 与老调用方走的那条）：`rememberRead`
     * 登记在一个写法上，拿另一个写法问不能落空 —— 落了空，`stale-gate-test` 段M
     * （读一种写法、第三方改被寻址行、写另一种写法 ⇒ 必须拒）就重新洞穿。
     * 只在**本机确实大小写不敏感**时才成立，所以它长在这一支里。
     */
    setObservationStore(null)
    const token = contentToken(readDisk(upper), false)
    rememberRead(upper, token, readDisk(upper))
    check(
      latestObservation(lower) !== null && hasObservedVersion(lower, token),
      'C4 身份键缺席时折叠兜底仍然生效（独立面 CLI/MCP 那条路不许被一起拆掉）',
      `latest=${latestObservation(lower) === null ? 'null' : 'hit'} has=${hasObservedVersion(lower, token)}`,
    )
  } else {
    // 大小写敏感：两个真文件 ⇒ 两个键，各归各的
    writeDisk(lower, 'l one\nl two\nl three\n')
    writeDisk(upper, upperText)
    const ru = await read(upper, { mode: 'full' })
    const rl = await read(lower, { mode: 'full' })
    check(ru?.path === upper && rl?.path === lower, 'C1 两个写法的回执各自保持原样', `${ru?.path} | ${rl?.path}`)
    const eu = await outcomeOf(upper, [{ lines: [1, 1], replace: 'U ONE' }])
    const el = await outcomeOf(lower, [{ lines: [1, 1], replace: 'L ONE' }])
    check(eu.applied && el.applied, 'C2 两份改动各自成功（两个真文件不许被并成一个键而互相顶掉）', `${eu.applied}/${el.applied}`)
    check(
      readDisk(upper).startsWith('U ONE') && readDisk(lower).startsWith('L ONE'),
      'C3 两份改动各落到自己那份文件',
      `${JSON.stringify(readDisk(upper))} | ${JSON.stringify(readDisk(lower))}`,
    )
    writeDisk(upper, upperText)
    const cu2 = await outcomeOf(lower, [{ lines: [2, 2], replace: 'L TWO' }])
    check(cu2.applied, 'C4 第三方改了 U 之后编辑 L：L 自己的观测还在 ⇒ 必须成功（不被牵连）', cu2.applied ? 'ok' : String(cu2.code))
  }
}

// ── 段CS：**真·大小写敏感目录**（本机用 fsutil 开）──────────────────────────
say('')
say('=== CS. 真·大小写敏感目录：只观测过一个，绝不认领另一个 ===')
/**
 * 造目录的方式照 `stale-gate-test` 段O:636：`fsutil file setCaseSensitiveInfo <dir> enable`，
 * 然后用"建一个 Probe.js、看 probe.js 在不在"做**实测探针**（不看退出码）。
 * 造不出来就 `skip()` 明写跳过并说明，不留一条永远绿的死支。
 *
 * 判据标号用 `CSn` 前缀：段F 的 `F6` 按这个前缀断言"本跑真的走到了这一支"。
 */
let csRan = false
let csSkipReason = null
{
  const csDir = path.join(tmp, 'cs')
  fs.mkdirSync(csDir, { recursive: true })
  try {
    execFileSync('fsutil', ['file', 'setCaseSensitiveInfo', csDir, 'enable'], { stdio: 'ignore' })
    const probe = path.join(csDir, 'Probe.js')
    writeDisk(probe, 'p\n')
    csRan = fs.existsSync(path.join(csDir, 'probe.js')) === false
    fs.rmSync(probe, { force: true })
    if (!csRan) csSkipReason = `fsutil 接受了命令但目录仍大小写不敏感（${csDir}）`
  } catch (error) {
    csSkipReason = `fsutil file setCaseSensitiveInfo 不可用：${error.code ?? 'ERR'}: ${error.message}`
  }
}
if (!csRan) {
  skip('CS0 真·大小写敏感目录可用（本机造不出来 ⇒ 这一整块只报跳过、不计通过）', csSkipReason)
} else {
  const csDir = path.join(tmp, 'cs')
  const U = path.join(csDir, 'Beta.js')
  const L = path.join(csDir, 'beta.js')
  const U_TEXT = 'U one\nU two\nU three\n'
  const L_TEXT = 'l one\nl two\nl three\n'
  /** 第三方版本：改的是**被寻址的第 1 行**（CS7 才有判定力）。 */
  const BOTH = 'U one CHANGED BY B\nU two\nU three\n'
  setObservationStore(null)
  writeDisk(U, U_TEXT)
  writeDisk(L, L_TEXT)
  check(
    fs.realpathSync.native(U) !== fs.realpathSync.native(L) && readDisk(U) !== readDisk(L),
    'CS0 前提：两个仅大小写不同的文件并存且内容不同（真·两个文件）',
    JSON.stringify([fs.realpathSync.native(U), fs.realpathSync.native(L)]),
  )

  // ── CS1–CS5：**C61 判红的那一格**（只观测过 U ⇒ 编辑从未观测过的 L）──
  setObservationStore(null)
  writeDisk(U, U_TEXT)
  writeDisk(L, L_TEXT)
  const u1 = await read(U, { mode: 'full' })
  check(u1?.path === U, 'CS1 只读 U：回执 path 逐字保持原样', JSON.stringify(u1?.path))
  const e1 = await outcomeOf(L, [{ lines: [1, 1], replace: 'L ONE' }])
  check(
    e1.applied,
    'CS2 对**从未观测过**的 L 发无 expect 编辑 ⇒ 闸门不拦（改前必红：PATCH_STALE_REGION 误拒）',
    e1.applied ? 'ok' : `${e1.code}: ${e1.message}`,
  )
  check(
    e1.applied && e1.receipt?.unverified_region === true,
    'CS3 回执如实带 unverified_region（从没观测过 ⇒ 不冒充新鲜）',
    JSON.stringify(e1.receipt?.unverified_region ?? null),
  )
  /**
   * CS4 钉的是**那句谎**：改前拒绝文本说 "changed after the last observation"，而 `beta.js`
   * 从来没有过 last observation。判据不只看"放行了没有"：**任何**回执/错误文本里都不许出现
   * 这句断言 —— 它只在真的有观测史时才成立（反向见 CS7b）。
   */
  const csText = String(e1.message ?? '')
  check(
    !/last observation/.test(csText),
    'CS4 回执/拒绝文本不得声称不存在的观测史（"after the last observation" 一字不许出现）',
    JSON.stringify(csText === '' ? '(无文本)' : csText.split('\n')[0]),
  )
  check(
    e1.applied && readDisk(L) === 'L ONE\nl two\nl three\n' && readDisk(U) === U_TEXT,
    'CS5 改动只落到 L 自己那份，U 一字未动',
    `${JSON.stringify(readDisk(U))} | ${JSON.stringify(readDisk(L))}`,
  )

  // ── CS6–CS9：反向 —— 真有过观测的目标照旧拒（不许借这一格退化成一律放行）──
  writeDisk(U, U_TEXT)
  const u2 = await read(U, { mode: 'full' })
  check(u2?.path === U, 'CS6 前提：重读 U 建立观测', JSON.stringify(u2?.path))
  writeDisk(U, BOTH) // 第三方改掉**被寻址的第 1 行**
  const e2 = await outcomeOf(U, [{ lines: [1, 1], replace: 'MINE' }])
  check(
    !e2.applied && e2.code === 'PATCH_STALE_REGION',
    'CS7 U 自己的被寻址行被第三方改过 ⇒ 仍然结构化拒绝',
    e2.applied ? 'applied' : String(e2.code),
  )
  check(
    !e2.applied && /after the last observation/.test(String(e2.message ?? '')) && String(e2.message ?? '').includes(U),
    'CS7b 拒绝文本在**真有过观测**时才说 "after the last observation"，且逐字含调用方给的路径',
    String(e2.message ?? '(放行了)').split('\n')[0],
  )
  check(readDisk(U) === BOTH, 'CS7c 拒绝时磁盘保持第三方内容', JSON.stringify(readDisk(U)))
  /**
   * L **不重置**：它上一次被自己编辑过（CS2），那份观测还在账本里 —— 这才能钉住
   * "第三方动的只是 U，另一个文件不许被牵连"。
   */
  const e3 = await outcomeOf(L, [{ lines: [2, 2], replace: 'L TWO' }])
  check(e3.applied, 'CS8 U 被第三方改过之后编辑 L：L 自己的观测还在 ⇒ 必须成功（不被牵连）', e3.applied ? 'ok' : String(e3.code))
  check(
    e3.applied && readDisk(L) === 'L ONE\nL TWO\nl three\n' && readDisk(U) === BOTH,
    'CS9 两份文件在磁盘上仍是两份不同的内容（U 保持第三方内容，L 落到自己那份）',
    `${JSON.stringify(readDisk(U))} | ${JSON.stringify(readDisk(L))}`,
  )

  // ── CS10：**内容逐字节相同**的两个身份键也不许并（登记侧的护栏）──
  setObservationStore(null)
  writeDisk(U, U_TEXT)
  writeDisk(L, U_TEXT)
  await read(U, { mode: 'full' })
  await read(L, { mode: 'full' })
  writeDisk(U, BOTH) // 第三方只改 U
  const e4 = await outcomeOf(L, [{ lines: [1, 1], replace: 'L ONE' }])
  check(
    e4.applied && readDisk(L) === 'L ONE\nU two\nU three\n',
    'CS10 内容逐字节相同的两个身份键仍是两个（登记侧不许按内容证据折叠）',
    `${e4.applied ? 'ok' : e4.code} | ${JSON.stringify(readDisk(L))}`,
  )

  // ── CS11：引擎层面直读「身份键在场 ⇒ 不折叠」（查询侧入口逐个走）──
  setObservationStore(null)
  const idU = ledgerIdentityKey(U, fs.realpathSync.native(U))
  const idL = ledgerIdentityKey(L, fs.realpathSync.native(L))
  const tokenU = contentToken(readDisk(U), false)
  rememberRead(idU, tokenU, readDisk(U), false, fs.realpathSync.native(U))
  check(
    latestObservation(idL) === null && latestObservation(idL, { token: tokenU }) === null,
    'CS11a latestObservation：L 的身份键下没有观测 ⇒ null（不许拿 U 那份作答）',
    JSON.stringify(latestObservation(idL)?.source ?? null),
  )
  check(
    hasObservedVersion(idL, tokenU) === false,
    'CS11b hasObservedVersion：U 的令牌不算 L 的',
    String(hasObservedVersion(idL, tokenU)),
  )
  check(recallRead(idL, tokenU) === null, 'CS11c recallRead：同上', JSON.stringify(recallRead(idL, tokenU)))
  check(idU !== idL, 'CS11d 两个真名给出两个身份键（身份键不折叠大小写）', `${idU} | ${idL}`)
}

// ── 段D：回执里模型看到的路径 = 它给的那个（逐字）──────────────────────────
say('')
say('=== D. 回执路径 = 调用方给的路径（逐字比对，两个方向）===')
if (!hasLink) {
  check(false, 'D0 前提：能建出目录别名', linkProblem)
} else {
  const realFile = path.join(REAL, 'Epsilon.js')
  const linkFile = path.join(LINK, 'Epsilon.js')
  fresh(realFile)
  const r1 = await read(linkFile, { mode: 'full' })
  check(r1?.path === linkFile, 'D1 读别名 ⇒ 回执 path 逐字等于别名（不许悄悄换成 realpath）', JSON.stringify(r1?.path))
  const r2 = await read(realFile, { mode: 'full' })
  check(r2?.path === realFile, 'D2 读真实路径 ⇒ 回执 path 逐字等于真实路径', JSON.stringify(r2?.path))
  /**
   * D3/D4 走 `outcomeOf`（而不是直接 await edit）：被拒时它是一条**判据红**，不是未捕获的异常。
   * 这不只是"跑得好看"——变异反证时（把归一化摘掉）一段未捕获的异常会把后面所有段一起带走，
   * 于是"哪几条判据在变异下变红"这份读数就残缺了。
   */
  const w1 = await outcomeOf(linkFile, [{ lines: [3, 3], replace: 'line three EDITED' }])
  check(w1.applied && w1.receipt?.path === linkFile, 'D3 写别名 ⇒ 回执 path 逐字等于别名', JSON.stringify(w1.receipt?.path ?? w1.code))
  const w2 = await outcomeOf(realFile, [{ lines: [3, 3], replace: 'line three EDITED AGAIN' }])
  check(
    w2.applied && w2.receipt?.path === realFile,
    'D4 写真实路径 ⇒ 回执 path 逐字等于真实路径',
    JSON.stringify(w2.receipt?.path ?? w2.code),
  )
  /**
   * D5 是**反向**的一条：拒绝回执（抛错）里的路径也必须是调用方给的那个。
   * 它同时钉住"身份键只用于记账、不许渗进任何面向文本"。
   */
  fresh(realFile)
  await read(realFile, { mode: 'full' })
  writeDisk(realFile, AFTER_THIRD_PARTY)
  const refused = await outcomeOf(linkFile, [{ lines: [3, 3], replace: 'MINE' }])
  check(
    !refused.applied && typeof refused.message === 'string' && refused.message.includes(linkFile),
    'D5 拒绝回执里的路径也是调用方给的那个别名（逐字出现在 message 里）',
    refused.message ?? '(放行了)',
  )
}

// ── 段E：不许退化成"一律拒绝" ───────────────────────────────────────────────
say('')
say('=== E. 同一写法的正常编辑仍成功（含"第三方改了别处、被寻址行没动"）===')
if (!hasLink) {
  check(false, 'E0 前提：能建出目录别名', linkProblem)
} else {
  const realFile = path.join(REAL, 'Zeta.js')
  const linkFile = path.join(LINK, 'Zeta.js')
  fresh(realFile)
  await read(linkFile, { mode: 'full' })
  const ok1 = await outcomeOf(linkFile, [{ lines: [3, 3], replace: 'line three EDITED' }])
  check(ok1.applied, 'E1 别名读 + 别名写、没人动过 ⇒ 照常成功', ok1.applied ? 'ok' : String(ok1.code))
  check(readDisk(realFile).includes('line three EDITED'), 'E2 E1 真的落了盘', JSON.stringify(readDisk(realFile)))

  // 正向对照：第三方改的是**第 1 行**，被寻址的第 3 行一字未动 ⇒ 闸门不许拿整份文件当锚
  fresh(realFile)
  await read(linkFile, { mode: 'full' })
  writeDisk(realFile, `line one CHANGED BY B\nline two\nline three\n`)
  const ok2 = await outcomeOf(realFile, [{ lines: [3, 3], replace: 'line three EDITED' }])
  check(ok2.applied, 'E3 第三方改了别处（第 1 行）、被寻址行没动 + 换写法 ⇒ 照常成功（不许误拒）', ok2.applied ? 'ok' : String(ok2.code))
  check(
    readDisk(realFile) === 'line one CHANGED BY B\nline two\nline three EDITED\n',
    'E4 E3 落盘正确：第三方的第 1 行原样保留',
    JSON.stringify(readDisk(realFile)),
  )
  /**
   * E5/E6：换写法但**内容一字未改**时，同一处观测必须仍然认得出来 ⇒ 回执不许标 `unverified_region`。
   *
   * 为什么不能拿 E3 那一次来钉这条：E3 的第三方改动让**当前内容**不等于任何观测，那时
   * `unverified_region: true` 是诚实的（见 `regionGate` 里那段"不能拿别的信号冒充新鲜"），
   * 把它判红等于用一条错误的期望去逼实现说谎。
   */
  fresh(realFile)
  await read(linkFile, { mode: 'full' })
  const ok3 = await outcomeOf(realFile, [{ lines: [3, 3], replace: 'line three EDITED' }])
  check(ok3.applied, 'E5 读别名、没人动过、写真实路径 ⇒ 成功（写法差异本身不该让人付代价）', ok3.applied ? 'ok' : String(ok3.code))
  check(
    ok3.receipt?.unverified_region === undefined,
    'E6 E5 的回执不谎称"没核对过"（换写法仍认得出同一处观测）',
    JSON.stringify(ok3.receipt?.unverified_region ?? null),
  )
}

// ── 段F：登记与退出码（本文件自己表态）────────────────────────────────────
say('')
say('=== F. 登记与退出码：本文件自己表态（闸侧登记在 build/release-check.mjs 的 SUITES）===')
{
  const self = fileURLToPath(import.meta.url)
  const text = fs.readFileSync(self, 'utf8')
  check(/process\.exitCode\s*=/.test(text), 'F1 本套件有退出码接线（判据红 ⇒ 进程非零，闸才看得见）', 'process.exitCode = 1')
  check(/通过|失败/.test(text), 'F2 本套件自带通过/失败汇总行（闸的 §⑩ 普查按形态收它）')
  const ledgerText = fs.readFileSync(path.join(pkgRoot, 'build', 'release-check.mjs'), 'utf8')
  check(
    // 只认"文件名在这个文件里"会被注释/单据骗过；要求整条登记行、且第三格是条数基线。
    /\[\s*'[^']*'\s*,\s*'src\/locator-lab\/alias-identity-test\.mjs'\s*,\s*\d+\s*\]/.test(ledgerText),
    'F3 本套件已登记进闸（SUITES，带条数基线）—— 没登记等于不存在',
    /alias-identity-test\.mjs/.test(ledgerText) ? 'found' : 'missing',
  )
  /**
   * F4：本套件必须真的走**壳**。判据是"壳那一层有没有把宿主事实递下去"这件事**可被观测**：
   * 源码里两处 `identityKey` 接线（读壳 ×1、写壳 ×1）必须在场。这条不是风格检查——
   * 把接线摘掉，段A/段B 立刻变红（本单的变异反证就是那一次读数）。
   */
  const readShell = fs.readFileSync(path.join(pkgRoot, 'src', 'aura-read', 'index.js'), 'utf8')
  const editShell = fs.readFileSync(path.join(pkgRoot, 'src', 'aura-edit', 'index.js'), 'utf8')
  check(
    /identityKey:\s*target\.targetKey/.test(readShell) && /identityKey:\s*target\.targetKey/.test(editShell),
    'F4 两个壳都把宿主事实（targetKey）递进引擎（摘掉这条 ⇒ 段A/段B 必红）',
    `read=${/identityKey:\s*target\.targetKey/.test(readShell)} edit=${/identityKey:\s*target\.targetKey/.test(editShell)}`,
  )
  /** F5：归一化只有一处 —— 引擎侧只有 `ledgerIdentityKey` 这一个定义，壳里不许自己实现一遍。 */
  const readCore = fs.readFileSync(path.join(pkgRoot, 'src', 'locator-lab', 'read-core.mjs'), 'utf8')
  const definitions = readCore.match(/function\s+ledgerIdentityKey|ledgerIdentityKey\s*=/g) ?? []
  check(definitions.length === 1, 'F5 归一化只有一处实现（read-core.mjs 的 ledgerIdentityKey）', `${definitions.length} 处定义`)
  /**
   * F7 只看**真的用没用**：`import … 'node:fs'` / `require('node:fs')`。
   * 不去匹配注释里的字面词 —— 壳的注释**必须**能说明"为什么引擎用不了它"，
   * 把那段说明也判红，等于逼下一个改的人删掉理由。
   */
  const importsFs = /(?:from|import|require\()\s*['"]node:fs['"]/
  check(
    !importsFs.test(readShell) && !importsFs.test(editShell),
    'F7 壳没有自己 import node:fs（事实来自宿主公开契约，不是壳去问文件系统）',
    `read=${importsFs.test(readShell)} edit=${importsFs.test(editShell)}`,
  )
}

/**
 * F6／F8：两条「本套件自己表态」的收尾判据（放在 F 块之后：它们读的是**这一跑的实际结果表**
 * 与 read-core 的实现形状，不依赖 F 块里的局部变量）。
 *
 *   · F6 段C 的大小写敏感支本跑真的执行了 —— C61 判红的那一格就是「没人跑」。
 *     造不出目录时 CS0 会 `skip()`（不计通过、在收尾行点名），那时 F6 仍要求**别默不作声**。
 *   · F8 「身份键在场 ⇒ 不折叠」只有一处实现：`resolveLedgerKey` 的第一级必须是它，
 *     调用点不许自己拼第二份。
 */
{
  const readCoreSource = fs.readFileSync(path.join(pkgRoot, 'src', 'locator-lab', 'read-core.mjs'), 'utf8')
  const csPremise = results.find((r) => r.label.startsWith('CS0'))
  const csSkipped = skips.some((s) => s.label.startsWith('CS0'))
  check(
    csRan === true ? csPremise?.ok === true : csSkipped,
    'F6 段C 的大小写敏感支本跑真的走到了（真跑并绿，或已明写跳过）',
    csRan === true ? `csRan=true ${JSON.stringify(csPremise?.label ?? '')}` : `csRan=false skip=${csSkipped} ${csSkipReason ?? ''}`,
  )
  const firstBranch = /if \(typeof identityKey === 'string' && identityKey.length > 0\) return ledgerIdentityKey\(filePath, identityKey\)/
  const signature = /function resolveLedgerKey\(filePath, evidence, identityKey = undefined\)/
  check(
    signature.test(readCoreSource) && firstBranch.test(readCoreSource),
    'F8 身份键优先只有一处实现（resolveLedgerKey 的第一级，不在调用点各拼一份）',
    `signature=${signature.test(readCoreSource)} first-branch=${firstBranch.test(readCoreSource)}`,
  )
}

/** 跳过项也在收尾处逐条点名："跳过"与"通过"必须是两句不同的话。 */
for (const s of skips) say(`⊘ 跳过（本机不可用，不计通过）：${s.label}${s.reason ? `  ${s.reason}` : ''}`)

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
say('')
say(`--- 路径别名下的陈旧闸门：${results.length - failed.length}/${results.length} 通过 ---`)
if (failed.length > 0) {
  say('失败项：')
  for (const f of failed) say(`  ✗ ${f.label}${f.detail ? `  ${f.detail}` : ''}`)
  process.exitCode = 1
}
