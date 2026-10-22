/**
 * hook-inproc —— 把 AuraPolaris 的 PreToolUse 钩子【在宿主进程内】跑完。
 *
 * 【这是什么】宿主 `ctx.shell` 的执行器（`./argv-shell.mjs`）在 `run()` 里对已知形状的钩子调用
 *   走一条短路支路：不 spawn、不过 windows-job runner、不重启 Node，直接调【钩子自己的入口】
 *   `hook.mjs` 导出的 `main()`。本文件就是那条支路的全部实现（执行器只负责"认出来 + 调用 + 兜底"）。
 *
 * 【为什么不重写判定】判定口径的唯一来源是 AuraPolaris 的 `guard-core.mjs` / `adapters/codex-hook.mjs`，
 *   本文件**一行判定都不写**：它调的就是 `main(argv, { defaultMode: 'shadow' })` —— 与子进程里
 *   `if (invokedDirectly) process.exit(await main(process.argv.slice(2), { defaultMode: 'shadow' }))`
 *   是【同一个函数、同一份 argv、同一份 stdin】。少一个转述层就少一处会漂移的第二口径。
 *
 * 【为什么能等价】子进程与本进程的差别只有四处，全部按子进程的取值补齐：
 *   ① cwd   —— 子进程跑在 spec.workdir 下，本进程 chdir 到那里（钩子用 `process.cwd()` 推 `<cwd>/.polaris` 落点，
 *              不补这一处记录就会落到宿主自己的目录里；实测过，不是理论担忧）。
 *   ② argv  —— 子进程的 `process.argv.slice(2)` 是钩子的旗标，本进程临时换上同一串（`stateInfo()` 只读一次并缓存）。
 *   ③ stdin —— 子进程的 stdin 是桥写进去的载荷，本进程换上一个同步吐完 data+end 的假 stdin
 *              （宿主自己的 stdin 可能是 TTY，`readStdin()` 一见 isTTY 就直接收空串）。
 *   ④ stdout/stderr —— 子进程的两个流是被抓取的管道，本进程临时接管 `process.stdout/stderr.write`。
 *   环境变量不在其列：子进程环境 = 父进程环境【脱敏后】+ {NO_COLOR,PAGER,GIT_PAGER}
 *   （dsh-subprocess 的 scrubbedParentEnv：只删 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*`，再把显式项合并上去），
 *   而钩子读的全部环境名（POLARIS_* / USERPROFILE / HOME / TEMP / TMP / TMPDIR）都不在那两类里。
 *
 * 【模块级缓存：唯一需要设防的地方】钩子模块里有若干"一个进程只算一次"的缓存（`stateInfoCache`、
 *   `registryCache`、规则表、可写性探针）。子进程每次都是全新的，本进程不是 —— 所以本文件按
 *   【签名】(旗标 + workdir + 全量环境) 各持一份模块实例：签名一变就用带缓存键的 URL 重新 import
 *   一份干净实例（见下方 hookCache）。这样既不会让第二次调用吃到第一次的落点，也不需要退回 spawn。
 *
 * 【失败方向】本文件任何异常都只回答 `{ ok:false, reason }`，由调用方走原来的 spawn 路径；
 *   它【永远不会】合成判定、永远不返回"放行"。唯一返回 `ok:true` 的情况 = 钩子入口真的跑完并给了退出码。
 *
 * 【开关】`AURA_HOOK_INPROC=0` → 执行器直接走 spawn（本文件连 import 都不做判定）。
 *   `AURA_HOOK_INPROC_MARKER=<路径>` → 覆盖计数文件（自证用）；两者都不进签名（它们是本支路的控制量，
 *   不是钩子的输入）。
 *
 * @module dsh/hook-inproc
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/** 计数文件（"这次走了哪条路"的可观测标记）：小、可追加语义、写失败绝不影响调用。 */
export const MARKER_DIR = path.join(os.homedir(), '.aura', 'pkg', '.cache')
export const MARKER_FILE = path.join(MARKER_DIR, 'aura-hook-inproc.json')
/** 本支路自己的控制量：它们变化不改变钩子行为，故不进签名。 */
const CONTROL_ENV = new Set(['AURA_HOOK_INPROC', 'AURA_HOOK_INPROC_MARKER'])
/** 钩子脚本的机名面：`hook.mjs`。同目录必须齐这两个兄弟（是"这就是 AuraPolaris 那个钩子"的最低凭证）。 */
const HOOK_SCRIPT_RE = /(?:^|[\\/])hook\.mjs$/i
const SIBLINGS = ['guard-core.mjs', path.join('adapters', 'codex-hook.mjs')]
const NODE_BASENAMES = new Set(['node', 'node.exe', 'nodejs', 'nodejs.exe'])
/** 与钩子入口同款的模式默认：直接跑 hook.mjs 时用 shadow（enforce 由档位文件/env 决定）。 */
const MAIN_OPTS = { defaultMode: 'shadow' }
const PRE_TOOL_USE = 'pretooluse'

const NOOP = () => {}

/* ------------------------------------------------------------------ 识别 */

/** argv[0] 是不是 Node 解释器（容忍 `node` / `node.exe` / 绝对路径 / 正反斜杠）。 */
export function isNodeInterpreter (token) {
  if (typeof token !== 'string' || token === '') return false
  return NODE_BASENAMES.has(path.basename(token).toLowerCase())
}

/** 取 `--event=` / `--event <值>` 的事件名（两种写法都认；没有则 null）。 */
export function eventFlagValue (argv) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (typeof token !== 'string') continue
    if (token.startsWith('--event=')) return token.slice('--event='.length)
    if (token === '--event') return typeof argv[i + 1] === 'string' ? argv[i + 1] : null
  }
  return null
}

/**
 * 权威识别：这串 argv 是不是「node <…>/hook.mjs … --event=PreToolUse …」。
 * 容错的是写法（引号已被执行器的词法器剥掉、脚本路径可正可反斜杠、旗标可 `=` 可空格），
 * 严格的是事件：事件名必须就是 PreToolUse（其它事件不归本支路）。
 * @param argv - 已切好的 argv。
 * @returns `{ hookPath, hookArgs }`；不是本支路的目标时返回 null（调用方走 spawn）。
 */
export function recognizePreToolUseHook (argv) {
  if (!Array.isArray(argv) || argv.length < 2) return null
  if (!isNodeInterpreter(argv[0])) return null
  let scriptIndex = -1
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (typeof token !== 'string' || token.startsWith('-')) continue
    if (HOOK_SCRIPT_RE.test(token)) { scriptIndex = i; break }
  }
  if (scriptIndex < 0) return null
  const event = eventFlagValue(argv)
  if (typeof event !== 'string' || event.trim().toLowerCase() !== PRE_TOOL_USE) return null
  return { hookPath: path.resolve(argv[scriptIndex]), hookArgs: argv.slice(scriptIndex + 1) }
}

/** 同目录兄弟文件齐不齐 —— 「别把别人家的 hook.mjs import 进宿主进程」的机械凭证。 */
export function hookLayoutError (hookPath) {
  const dir = path.dirname(hookPath)
  for (const rel of SIBLINGS) {
    try {
      if (!fs.statSync(path.join(dir, rel)).isFile()) return `not_aurapolaris_hook(${rel})`
    } catch { return `not_aurapolaris_hook(${rel})` }
  }
  return null
}

/* -------------------------------------------------------------- 计数标记 */

function markerPath () {
  const override = String(process.env.AURA_HOOK_INPROC_MARKER ?? '').trim()
  return override === '' ? MARKER_FILE : path.resolve(override)
}

function readMarker (file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
  } catch { /* 首次 / 坏文件：都按空账本处理 */ }
  return {}
}

/**
 * 记一次分派：`inproc` = 走了本进程内，`spawn` = 退回子进程（带原因）。
 * 契约：**绝不抛**（写不进去只是少一个读数，不许把宿主调用打挂）。
 * @param kind - `'inproc'` | `'spawn'`。
 * @param reason - spawn 档的原因标签（`disabled` / `threw` / `state_signature_changed` / …）。
 * @returns 落盘后的计数对象，或 null（没写成功）。
 */
export function noteHookDispatch (kind, reason = '') {
  try {
    const file = markerPath()
    const prev = readMarker(file)
    const next = {
      inproc: Number(prev.inproc) || 0,
      spawn: Number(prev.spawn) || 0,
      reasons: (prev.reasons && typeof prev.reasons === 'object' && !Array.isArray(prev.reasons)) ? { ...prev.reasons } : {},
      pid: process.pid,
      at: new Date().toISOString(),
    }
    if (kind === 'inproc') next.inproc += 1
    else {
      next.spawn += 1
      const key = String(reason || 'unknown').slice(0, 60)
      next.reasons[key] = (Number(next.reasons[key]) || 0) + 1
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next) + '\n')
    return next
  } catch { return null }
}

/* ------------------------------------------------------- 加载 + 关键区 */

/** 关键区串行闸：全局补丁（argv/cwd/流）必须独占，并发分派不许交叉。 */
let criticalChain = Promise.resolve()
/**
 * 【模块级缓存的正确解法】钩子入口按【签名】各持一份模块实例。
 *
 * 为什么不能只持一份：钩子里有“一个进程只算一次”的缓存（`stateInfoCache` / `registryCache` / 规则表 / 可写性探针），
 * 而它的输入不止 argv —— 还有 workdir 与环境。子进程每次都是全新的；本进程只持一份就会【第二次调用吃到
 * 第一次的落点】。
 *
 * 为什么不能“签名一变就退回 spawn”（本文件 0.6.11–0.6.14 的做法）：那是用【每次调用都 spawn】去换正确性。
 * 实测（2026-10-16，宿主 pid 24224）：`inproc=46 / spawn=103`，其中 `state_signature_changed=68` ——
 * 即签名在真实宿主里每调用一变，于是“进程内跑”实际上一次都没发生，整条支路的收益归零（固定税回到 ~250ms）。
 *
 * 现在的做法：签名一变就【用带缓存键的 URL 重新 import 一份干净实例】（模块级缓存随之全新），
 * 仍然在进程内跑完 —— 语义与“每次 spawn 一个全新进程”等价，代价只有模块图求值（毫秒量级）。
 * 实测：模块实例与 spawn 两条路的 stdout/退出码/落账逐字相同（历史签名差分记录）。
 */
const hookCache = new Map()
/** 实例上限：签名抖动时不能无界增长。到顶就整批丢掉（旧实例会被 GC，功能不受影响）。 */
const HOOK_CACHE_MAX = 8

/** 同一份签名 → 同一个 URL（键）；不同签名 → 不同 URL ⇒ Node 视为不同模块、重新求值。 */
const hookUrlOf = (hookPath, signature) =>
  `${pathToFileURL(hookPath).href}?aura-inproc=${createHash('sha256').update(signature).digest('hex').slice(0, 16)}`

/**
 * 上一次分派的签名（只用来区分“签名换过没有”并记一行读数）。
 * 【不再】用它把调用赶回 spawn —— 换签名现在只换实例（见 hookCache）。
 */
let seenSignature = null

async function loadHookMain (hookPath, signature) {
  const url = hookUrlOf(hookPath, signature)
  const hit = hookCache.get(url)
  if (hit !== undefined) return hit
  const mod = await import(url)
  if (typeof mod.main !== 'function') return null
  // 预热适配器：钩子入口里那一次 `await import('./adapters/codex-hook.mjs')` 若在关键区里发生，
  // 就会在补丁生效期间插进一次真实文件 I/O（那会让宿主别的事件有机会在这扇窗里说话）——
  // 先在干净的全局状态下把它读进模块缓存，关键区里那次 await 就只剩微任务。
  //
  // 【适配器本身【不】按签名复制】——它必须与钩子入口共用同一份模块实例：钩子靠它的导出说话，
  // 复制一份等于在这里造第二个口径。适配器里的状态是每次调用现算的，与 workdir/环境无关。
  await import(pathToFileURL(path.join(path.dirname(hookPath), 'adapters', 'codex-hook.mjs')).href)
  const hook = { path: hookPath, main: mod.main }
  if (hookCache.size >= HOOK_CACHE_MAX) hookCache.clear()
  hookCache.set(url, hook)
  return hook
}

/**
 * 签名的四个组成部分，分开保存 —— 比对时才知道【是哪一段变了】（只影响读数，不影响判定）。
 * 顺序：路径 / workdir / 旗标 / 环境。
 */
function signatureParts (hookPath, hookArgs, workdir) {
  const env = Object.keys(process.env)
    .filter((key) => !CONTROL_ENV.has(key.toUpperCase()))
    .sort()
    .map((key) => `${key}=${process.env[key]}`)
    .join('\u0000')
  return [hookPath, workdir, hookArgs.join('\u0000'), env]
}

/** 签名 = 旗标 + workdir + 全量环境（控制量除外）。签名一变就退回 spawn。 */
function signatureOf (hookPath, hookArgs, workdir) {
  return signatureParts(hookPath, hookArgs, workdir).join('\u0001')
}

const PART_NAMES = ['hookPath', 'workdir', 'hookArgs', 'env']

/** 两个字符串第一个不同的下标（没有则 -1）。 */
function firstDiffIndex (a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

/**
 * 【读数，不是判据】签名变了就写一行「是哪一段变的」到 `<cache>/aura-hook-inproc-signature.log`。
 * 为什么要它：光看 `inproc` / `spawn` 两个计数，分不出“谁在漂”——是 workdir 换了、旗标变了，
 * 还是宿主往环境里塞了东西。这是唯一能把「模块实例按签名分家」这条修法证伪的现场读数。
 * 契约与 noteHookDispatch 同款：**绝不抛**（写不进去只是少一个读数），绝不改变判定。
 */
function noteSignatureDrift (prevSig, hookPath, hookArgs, workdir) {
  try {
    const prev = String(prevSig)
    if (prev.indexOf('\u0001') < 0) return
    const prevParts = prev.split('\u0001')
    const nextParts = signatureParts(hookPath, hookArgs, workdir)
    let which = -1
    let detail = ''
    for (let i = 0; i < nextParts.length; i++) {
      if (prevParts[i] === nextParts[i]) continue
      which = i
      const a = String(prevParts[i] ?? '')
      const b = String(nextParts[i] ?? '')
      const at = firstDiffIndex(a, b)
      detail = `@${at} prev[${a.length}]=${JSON.stringify(a.slice(Math.max(0, at - 40), at + 60))} next[${b.length}]=${JSON.stringify(b.slice(Math.max(0, at - 40), at + 60))}`
      break
    }
    if (which < 0) return
    const file = path.join(MARKER_DIR, 'aura-hook-inproc-signature.log')
    const line = `${new Date().toISOString()}\tpart=${PART_NAMES[which] ?? which}\t${detail}\n`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, line)
  } catch { /* 读数失败不许影响调用 */ }
}

function enterCritical (fn) {
  const next = criticalChain.then(fn)
  criticalChain = next.then(NOOP, NOOP)
  return next
}

/** 同步吐完 data+end 的假 stdin：`hook.mjs#readStdin()` 只认这三个行为。 */
function makeStdin (text) {
  const data = typeof text === 'string' ? text : ''
  let onData = null
  return {
    isTTY: false,
    readable: true,
    setEncoding () { return this },
    on (event, cb) {
      if (event === 'data') onData = cb
      else if (event === 'end') {
        if (typeof onData === 'function' && data.length > 0) onData(data)
        if (typeof cb === 'function') cb()
      }
      return this
    },
    addListener (event, cb) { return this.on(event, cb) },
    once (event, cb) { return this.on(event, cb) },
    removeListener () { return this },
    off () { return this },
    resume () { return this },
    pause () { return this },
    destroy () { return this },
  }
}

function makeSink (sink) {
  return (chunk, encoding, callback) => {
    if (typeof chunk === 'string') sink.push(chunk)
    else if (chunk !== undefined && chunk !== null) sink.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
    const cb = typeof callback === 'function' ? callback : (typeof encoding === 'function' ? encoding : null)
    if (cb !== null) queueMicrotask(() => cb())
    return true
  }
}

function restoreWrite (stream, own) {
  if (own !== undefined) { Object.defineProperty(stream, 'write', own); return }
  // 原本没有自有属性（方法在原型上）：删掉我们的遮蔽即可，原型方法原样可见。
  try { delete stream.write } catch { /* 删不掉就留着（下面兜底赋回原值） */ }
}

/**
 * 按子进程的取值把四个全局面换掉（见文件头 ①②③④）。
 * @returns 还原所需的一切；调用方必须在 finally 里交给 restoreGlobals。
 */
function patchGlobals (hookPath, hookArgs, stdin, workdir, outSink, errSink) {
  const saved = {
    argv: process.argv,
    cwd: process.cwd(),
    stdin: Object.getOwnPropertyDescriptor(process, 'stdin'),
    stdoutWrite: Object.getOwnPropertyDescriptor(process.stdout, 'write'),
    stderrWrite: Object.getOwnPropertyDescriptor(process.stderr, 'write'),
  }
  process.argv = [process.execPath, hookPath, ...hookArgs]
  process.stdout.write = makeSink(outSink)
  process.stderr.write = makeSink(errSink)
  Object.defineProperty(process, 'stdin', { configurable: true, enumerable: true, value: makeStdin(stdin) })
  if (path.resolve(saved.cwd) !== workdir) process.chdir(workdir)
  return saved
}

function restoreGlobals (saved) {
  process.argv = saved.argv
  try { if (path.resolve(process.cwd()) !== path.resolve(saved.cwd)) process.chdir(saved.cwd) } catch { /* 原 cwd 没了：留着现在的，别把调用打挂 */ }
  restoreWrite(process.stdout, saved.stdoutWrite)
  restoreWrite(process.stderr, saved.stderrWrite)
  if (saved.stdin !== undefined) Object.defineProperty(process, 'stdin', saved.stdin)
}

async function runCritical (hook, hookArgs, request, workdir) {
  const outSink = []
  const errSink = []
  const saved = patchGlobals(hook.path, hookArgs, request.stdin, workdir, outSink, errSink)
  let code
  try {
    code = await hook.main([...hookArgs], MAIN_OPTS)
  } finally {
    restoreGlobals(saved)
  }
  if (typeof code !== 'number' || !Number.isFinite(code)) return { ok: false, reason: 'no_exit_code' }
  const stdout = outSink.join('')
  const stderr = errSink.join('')
  // 超帽：spawn 那条路会截断 + 溢写 spill，这里【不近似】—— 退回 spawn 让真身去做（守卫判定是确定性的，
  // 重跑一次结论相同；代价只是多一条记录，收益是不会出现"差一字节的判定"）。
  if (Buffer.byteLength(stdout, 'utf8') > request.stdoutMaxBytes) return { ok: false, reason: 'stdout_over_cap' }
  if (Buffer.byteLength(stderr, 'utf8') > request.stderrMaxBytes) return { ok: false, reason: 'stderr_over_cap' }
  return { ok: true, exitCode: code, stdout, stderr }
}

/* ---------------------------------------------------------------- 入口 */

async function attempt (request) {
  const argv = Array.isArray(request?.argv) ? request.argv : null
  if (argv === null) return { ok: false, reason: 'no_argv' }
  const rec = recognizePreToolUseHook(argv)
  if (rec === null) return { ok: false, reason: 'unrecognized' }
  const layout = hookLayoutError(rec.hookPath)
  if (layout !== null) return { ok: false, reason: layout }
  if (request.signalAborted === true) return { ok: false, reason: 'caller_aborted' }
  const workdir = path.resolve(String(request.workdir ?? '') || process.cwd())
  const signature = signatureOf(rec.hookPath, rec.hookArgs, workdir)
  // 签名换了 ⇒ 拿一份【干净实例】（不是退回 spawn，见文件头“模块级缓存的正确解法”）。
  // 只记读数：上一次是哪一段变的 —— 它能直接回答“这条支路到底有没有在跑”。
  if (seenSignature !== null && seenSignature !== signature) noteSignatureDrift(seenSignature, rec.hookPath, rec.hookArgs, workdir)
  seenSignature = signature
  const hook = await loadHookMain(rec.hookPath, signature)
  if (hook === null) return { ok: false, reason: 'module_unavailable' }
  const stdoutMaxBytes = positiveInt(request.stdoutMaxBytes)
  const stderrMaxBytes = positiveInt(request.stderrMaxBytes)
  return await enterCritical(() => runCritical(hook, rec.hookArgs, {
    stdin: typeof request.stdin === 'string' ? request.stdin : '',
    stdoutMaxBytes,
    stderrMaxBytes,
  }, workdir))
}

function positiveInt (value) {
  return Number.isInteger(value) && value > 0 ? value : 64 * 1024
}

/**
 * 试着在本进程内跑完这次 PreToolUse 钩子调用。
 * 契约：**绝不抛**（任何异常都降级成 `{ ok:false, reason }`），**绝不合成判定**。
 * @param request - `{ argv, stdin, workdir, stdoutMaxBytes, stderrMaxBytes, signalAborted }`。
 * @returns `{ ok:true, exitCode, stdout, stderr }` 或 `{ ok:false, reason }`；后者一律由调用方走 spawn。
 */
export async function runPreToolUseHookInProcess (request) {
  try {
    return await attempt(request)
  } catch (error) {
    return { ok: false, reason: `dispatcher_error:${String(error?.message ?? error).slice(0, 80)}` }
  }
}

export default runPreToolUseHookInProcess
