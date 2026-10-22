/**
 * argv-shell —— 宿主钩子专用的「不经任何 shell」执行器（`ctx.shell` 的提供者）。
 *
 * 【这是什么】把钩子桥交来的命令【字符串】按最小词法切成 argv，直接交给
 *   `ctx.subprocess.spawn({ argv })`；中间不启动任何 shell、不做命令替换、不做元字符解释。
 *   语义等价于 `@deepseek-ai/dsh-native-command` 的 `runNativeCommand`（execFile，argv 原样给 OS），
 *   只是搬到了 shell 接缝上 —— 因为 `dsh-hook-protocol` 的 `runHook()` 只认
 *   `ctx.shell.run(ctx.shell.resolve({ command }))`，钩子配置里没有任何 argv 字段。
 *
 * 【为什么】宿主现行 `ctx.shell` 是 `@deepseek-ai/dsh-pwsh-local`：命令串被拼成
 *   `pwsh -NoLogo -NoProfile -NonInteractive -Command "<前置编码指令><串>"` 再解析一遍。
 *   PreToolUse 每个工具调用都要付这一层（p50 686ms，n=58,139），其中 76–84% 是这层壳，
 *   真正的判定+落账只占 4.7%。换成本执行器 = 把壳层整个删掉。
 *
 * 【口径】只做最小、可预测的词法：空白分词；双/单引号成组并去掉引号；反斜杠只在成对引号内
 *   转义（Windows 路径里的 `\` 必须原样保留）。`;` `|` `&` `$` `%` 反引号【都不是元字符】——
 *   这正是它与 shell 的全部差别。引号不配对 = 抛错（不猜，宁可响亮失败）。
 *
 * 【边界】只实现 `run()`（钩子桥只用它）。`start()` 明确抛错：本执行器只挂在
 *   `polaris-hooks-unconfined` 隔离组里，组内没有任何后台消费者 —— 不做半个实现。
 *
 * 【回滚】把 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 里那一行的 name 改回
 *   `@deepseek-ai/dsh-pwsh-local` 即可（本文件可以留着，没人指向它就永远不会被 import）。
 *
 * @module dsh/argv-shell
 */
import path from 'node:path'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import z from '@deepseek-ai/schemastery'

const DEFAULT_GRACE_MS = 3000
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024
/** 与 pwsh-local 同款的非交互环境覆盖：去掉颜色与分页器，免得混进被抓取的 stdout。 */
const ENV_OVERRIDES = { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }

/**
 * 命令串 -> argv。纯函数、无副作用、不碰任何 shell 语义。
 * @param command - 钩子配置里的命令串（跨 shell 同形写法：只用双引号、路径用正斜杠）。
 * @returns argv；argv[0] 是程序，其余原样传给子进程。
 * @throws 引号不配对时抛错（不猜一个"大概是这个意思"的 argv）。
 */
export function tokenizeArgv (command) {
  if (typeof command !== 'string') throw new TypeError('argv-shell: command must be a string')
  const out = []
  let token = ''
  let started = false
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== null) {
      // 反斜杠只在【紧跟本段引号】时转义；其余一律字面（Windows 路径不能被吃掉反斜杠）。
      if (ch === '\\' && command[i + 1] === quote) { token += quote; i++; continue }
      if (ch === quote) { quote = null; continue }
      token += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) { out.push(token); token = ''; started = false }
      continue
    }
    token += ch
    started = true
  }
  if (quote !== null) throw new Error('argv-shell: unbalanced ' + quote + ' in command: ' + command)
  if (started) out.push(token)
  return out
}

// —— AuraPolaris PreToolUse 钩子的【进程内短路支路】———————————————
// 【为什么】这条钩子是每个工具调用都要付一次的固定成本，而它要干的判定只有几毫秒：剩下全是
//   "起两个 Node 进程"的税（宿主 → windows-job runner → 真身）。本执行器【就活在宿主进程里】
//   （见文件头：它是 ctx.shell 的提供者），所以这一次调用完全可以不出进程。
// 【代价面】2026-10-15 实测（串行、每路 n=24）：
//   spawn 路径（含 windows-job runner 间接层）p50 ≈ 250–276ms，进程内路径 p50 ≈ 4ms；
//   其中钩子自己的判定只占 ≈6ms（关掉：AURA_HOOK_INPROC=0）。
// 【边界】①只认 PreToolUse（其它事件不归本支路）；②任何不确定都退回下面的 spawn 原路；
//   ③非钩子命令在这段里只多一次 O(argv) 的字符串预筛，一个字节的行为变化都没有。
// 关掉：环境变量 AURA_HOOK_INPROC=0（不必改宿主 profile）。
const HOOK_SCRIPT_RE = /(?:^|[\\/])hook\.mjs$/i
const NODE_BASENAMES = new Set(['node', 'node.exe', 'nodejs', 'nodejs.exe'])

/**
 * 便宜预筛：这串 argv 像不像「node <…>/hook.mjs … --event=PreToolUse」。
 * 【这不是判定】—— 权威识别在 hook-inproc.recognizePreToolUseHook（那里解析脚本路径、校验同目录的
 *   guard-core/adapters 布局）。这里只回答"值不值得去 import 那个模块"：漏判 = 白付一次 spawn，
 *   误判 = 多一次 import + 一次失败返回，两种都不改变行为、都不会变成放行。
 */
function looksLikePreToolUseHook (argv) {
  if (!Array.isArray(argv) || argv.length < 2) return false
  if (typeof argv[0] !== 'string' || !NODE_BASENAMES.has(path.basename(argv[0]).toLowerCase())) return false
  let script = false
  let event = false
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (typeof token !== 'string') continue
    if (!script && !token.startsWith('-') && HOOK_SCRIPT_RE.test(token)) { script = true; continue }
    if (token.startsWith('--event=')) event = token.slice('--event='.length).trim().toLowerCase() === 'pretooluse'
    else if (token === '--event' && typeof argv[i + 1] === 'string') event = argv[i + 1].trim().toLowerCase() === 'pretooluse'
  }
  return script && event
}

/** 记一次分派（可观测标记）。写标记失败不许影响这次调用：吞掉。 */
function noteDispatch (mod, kind, reason) {
  try { if (typeof mod?.noteHookDispatch === 'function') mod.noteHookDispatch(kind, reason) } catch { /* 标记是读数，不是判据 */ }
}

/**
 * 短路支路：把已知的 AuraPolaris PreToolUse 钩子在本进程内跑完。
 * @returns 与 spawn 路径【同形】的结果对象；返回 null = 走原来的 spawn（一个字都没改的那条路）。
 */
async function inProcessShortCircuit (executor, argv, spec) {
  if (!looksLikePreToolUseHook(argv)) return null
  // 懒加载：非钩子命令不付这个模块的任何代价（构造执行器时也不 import）。
  let mod
  try { mod = await import('./hook-inproc.mjs') } catch { return null }
  if (process.env.AURA_HOOK_INPROC === '0') { noteDispatch(mod, 'spawn', 'disabled'); return null }
  let result = null
  try {
    result = await mod.runPreToolUseHookInProcess({
      argv,
      stdin: typeof spec.stdin === 'string' ? spec.stdin : '',
      workdir: spec.workdir,
      stdoutMaxBytes: spec.stdoutMaxBytes,
      stderrMaxBytes: executor.config.maxOutputBytes,
      signalAborted: spec.signal !== undefined && spec.signal.aborted === true,
    })
  } catch (error) {
    // 抛 = 这条支路不可用。这里【只】退回 spawn：合成任何判定都等于把"护栏坏了"变成"放行"。
    noteDispatch(mod, 'spawn', `threw:${String(error?.message ?? error).slice(0, 60)}`)
    return null
  }
  // 形状不对（缺字段 / 类型不对 / ok 不是 true）= 与"抛"同等处理：退回 spawn。
  if (result === null || typeof result !== 'object' || result.ok !== true ||
    typeof result.exitCode !== 'number' || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    noteDispatch(mod, 'spawn', String(result?.reason ?? 'unshaped'))
    return null
  }
  noteDispatch(mod, 'inproc', 'ok')
  return {
    exitCode: result.exitCode,
    signal: null,
    timedOut: false,
    aborted: spec.signal !== undefined && spec.signal.aborted === true,
    timeoutMs: spec.timeoutMs,
    stdout: { text: result.stdout, truncated: false },
    stderr: { text: result.stderr, truncated: false },
  }
}

/** 把已结算的 collect 读取器投影成 CollectedOutput。 */
function finalOutput (reader) {
  const read = reader.readFrom(0)
  const out = { text: read.text, truncated: read.lossy }
  if (read.spillPath !== undefined) out.spillPath = read.spillPath
  return out
}

function assertPositiveFinite (name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('argv-shell: ' + name + ' must be a positive finite number')
  }
}

function clampTimeout (value, base, max, label) {
  if (value === undefined) return base
  assertPositiveFinite(label, value)
  return Math.min(value, max)
}

/**
 * 本地 argv 执行器：`ctx.shell` 的无 shell 实现。
 */
export class ArgvShellExecutor extends ShellExecutor {
  static inject = ['subprocess']
  static Config = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120000),
    maxTimeoutMs: z.number().default(600000),
    maxOutputBytes: z.number().default(64000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  constructor (ctx, config) {
    super(ctx)
    assertPositiveFinite('argv-shell: timeoutMs', config.timeoutMs)
    assertPositiveFinite('argv-shell: maxTimeoutMs', config.maxTimeoutMs)
    assertPositiveFinite('argv-shell: maxOutputBytes', config.maxOutputBytes)
    assertPositiveFinite('argv-shell: maxSpillBytes', config.maxSpillBytes)
    assertPositiveFinite('argv-shell: graceMs', config.graceMs)
    this.entry = config
  }

  get config () { return this.entry }

  /** 不沙箱化：本执行器是「宿主壳层的替身」，不引入任何新的执行语义。 */
  get sandboxMode () { return undefined }

  /** 与 pwsh-local 同款：填 workdir / timeoutMs / stdoutMaxBytes，其余原样透传。 */
  resolve (request) {
    const timeoutMs = clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, 'argv-shell: request.timeoutMs')
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    const spec = {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      sandboxPolicy: request.sandboxPolicy,
    }
    if (request.signal !== undefined) spec.signal = request.signal
    if (request.stdin !== undefined) spec.stdin = request.stdin
    if (request.env !== undefined) spec.env = request.env
    if (request.dshEnv !== undefined) spec.dshEnv = request.dshEnv
    return spec
  }

  /** 命令串 -> argv。本执行器与 pwsh-local 的【唯一】实质差别就在这一步。 */
  argv (spec) {
    const out = tokenizeArgv(spec.command)
    if (out.length === 0) throw new Error('argv-shell: empty command')
    return out
  }

  spawnSpec (spec, stdoutMaxBytes, signal, argv) {
    const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    const out = {
      argv: [...argv],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
    }
    if (signal !== undefined) out.signal = signal
    return out
  }

  async run (spec) {
    const argv = this.argv(spec)
    // 短路支路：已知的 AuraPolaris PreToolUse 钩子在进程内跑完。null = 原路（下面的代码一个字没改）。
    const shortcut = await inProcessShortCircuit(this, argv, spec)
    if (shortcut !== null) return shortcut
    const controller = new AbortController()
    const onCallerAbort = () => controller.abort()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, spec.timeoutMs)
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) controller.abort()
      else spec.signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    let handle
    let outcome = { exitCode: null, signal: null }
    let failure = null
    try {
      handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, controller.signal, argv))
      outcome = await handle.done
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(timer)
      if (spec.signal !== undefined) spec.signal.removeEventListener('abort', onCallerAbort)
    }
    const outputs = handle === undefined ? undefined : handle.collected
    const stdout = outputs !== undefined && outputs.stdout !== undefined ? finalOutput(outputs.stdout) : { text: '', truncated: false }
    const stderr = outputs !== undefined && outputs.stderr !== undefined
      ? finalOutput(outputs.stderr)
      : { text: failure === null ? '' : String(failure.message ?? failure), truncated: false }
    return {
      ...outcome,
      timedOut,
      aborted: spec.signal !== undefined && spec.signal.aborted === true && !timedOut,
      timeoutMs: spec.timeoutMs,
      stdout,
      stderr,
    }
  }

  /** 后台执行不属于本执行器的用例面（隔离组里只有钩子桥这一个消费者）。 */
  start () {
    throw new Error('argv-shell: background execution is not implemented — this executor only serves the hooks bridge')
  }
}

export default ArgvShellExecutor
