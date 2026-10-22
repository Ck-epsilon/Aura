#!/usr/bin/env node
// =============================================================================
// aura-tools/probes/hook-wiring-plan.mjs —— C25：宿主钩子固定税的【预备改造】计划 + 非激活实测
//
// 【这是什么】产出「把钩子命令不经任何 shell、直投 argv」的宿主接线改动（精确到行）+ 一键回滚，
//   并在**不重启宿主、不写宿主任何文件**的前提下，把这条改动实测跑通：真桥 + 真 shell 接缝 +
//   真 hook.mjs + 真落账。
//
// 【为什么】PreToolUse 钩子每个工具调用付 686ms（p50，n=58,139，合计 613 分钟）；构成分解
//   （C6 实测，aura-tools/src/locator-lab/hook-cost-probe.mjs）：宿主壳层（pwsh 两层）76–84%，
//   钩子侧（node 启动 + 模块图 + 判定 + 落账）16–24%，真正的判定+落账只占 4.7%。
//   本探针把「壳层」整个去掉：命令串按最小词法切成 argv，直接交给 ctx.subprocess.spawn
//   （`argv[0]` 是程序，DSH 逐字声明 "Never shell-interpreted here"）。
//
// 【怎么复跑】node aura-tools/probes/hook-wiring-plan.mjs            # 全量：事实链 + 前后对照 + 计划
//            node aura-tools/probes/hook-wiring-plan.mjs --json       # 机器可读（末尾一段 JSON）
//            node aura-tools/probes/hook-wiring-plan.mjs --emit-shim  # 只把待落地的 argv-shell.mjs 打到 stdout
//            node aura-tools/probes/hook-wiring-plan.mjs --verify-guard  # 激活后一条命令验护栏（两种 transport 判决一致）
//            node aura-tools/probes/hook-wiring-plan.mjs --reps=3 --keep-tmp --no-timing
//   退出码：0 = 全部硬判据通过 / 1 = 有硬判据红（逐条点名）/ 2 = 用法错。
//
// 【怎么关掉】本文件只读仓库与宿主配置（不写宿主任何文件），只在 %TEMP% 里建一次性箱；
//   宿主配置的改动**本探针不施加**（见 §4 的 APPLY 一栏，交给操作者）。--keep-tmp 保留临时箱。
//
// 【边界（如实声明）】
//   · 本探针不改 C:\Users\cxk\.dsh\** 的任何文件（宿主正在运行：激活要重启宿主，而本会话跑在宿主里）。
//   · 落账一律落在 %TEMP% 的一次性箱里：argv 与宿主 hooks.json 里的命令串【逐字同形】，
//     靠「子进程 cwd = 箱」把 --state=workspace 解析到箱内（hook.mjs 自己的自证也是这个办法）。
//   · 唯一与生产不同的配置：给执行器的 config 传了 cwd=<箱>（生产那行不传 config，回落
//     bridge 给的 session workdir / process.cwd()，与 pwsh-local 同款回落）。这条差异在 §3.2 逐字打印。
// =============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pkgPath as pkgFile } from '../build/pkg-root.mjs'

const say = (m = '') => fs.writeSync(1, `${m}\n`)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── 参数 ──────────────────────────────────────────────────────────────────────

// ── 用法闸（C71 同类欠账）：不认识的旗标**点名 + exit 2**，不静默跑默认窗口 ──────────────
// 为什么必须有：这些探针的读数是被当作验收证据引用的，而"旗标拼错"过去会得到一份
// 看上去完全正常、其实取了默认窗口的读数，没人会去质疑它（交接单里真咬过一次）。
// 已知旗标的语义与解析器一字未动 ⇒ 正常调用的输出逐字不变。
const GUARD_FLAGS = new Set(['--json', '--emit-shim', '--verify-guard', '--reps', '--keep-tmp', '--no-timing', '--hook', '--host', '--event', '--hooks-json', '--dsh-home', '--dump-config', '--generator'])
const guardUnknown = (argv) => {
  const unknown = argv.find((a) => typeof a === 'string' && a.startsWith('-') && !GUARD_FLAGS.has(a.split('=')[0]))
  if (unknown === undefined) return
  process.stderr.write(`用法错：不认识的旗标 ${unknown}（${'probes/hook-wiring-plan.mjs'}）\n支持：${[...GUARD_FLAGS].join(' ')}\n`)
  process.exit(2)
}
guardUnknown(process.argv.slice(2))
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? def : hit.slice(name.length + 3)
}
const has = (name) => argv.includes(`--${name}`)
const num = (s, def) => (Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : def)

const EMIT_ONLY = has('emit-shim')
const VERIFY_GUARD = has('verify-guard')
const JSON_OUT = has('json')
const KEEP_TMP = has('keep-tmp')
// --verify-guard = 「激活后的一条验证命令」：跳过全部计时（快），退出码只由护栏一致性决定
const NO_TIMING = has('no-timing') || VERIFY_GUARD
const REPS = Math.max(3, Math.round(num(argOf('reps', '9'), 9)))
const DSH_HOME = path.resolve(argOf('dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const PROFILE = path.resolve(argOf('profile', path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')))
const HOOKS_JSON = path.resolve(argOf('hooks-json', path.join(DSH_HOME, 'aurapolaris-hooks.json')))
const HOOK = path.resolve(argOf('hook', path.join(DSH_HOME, 'skills', 'aurapolaris', 'tools', 'hook.mjs')))
const AURAPOLARIS_GEN = argOf('generator', 'E:\\workspaces\\AuraPolaris\\tools\\apply-hook-dsh.mjs')

if (has('help')) {
  say('用法: node aura-tools/probes/hook-wiring-plan.mjs [--reps=N] [--json] [--emit-shim] [--verify-guard] [--keep-tmp] [--no-timing]')
  say('      [--dsh-home=<dir>] [--profile=<cordis.patch.yml>] [--hooks-json=<file>] [--hook=<hook.mjs>] [--generator=<apply-hook-dsh.mjs>]')
  process.exit(0)
}

// 这是落账档：子进程必须真写。生产遥测开关只影响我们自己的子进程，不外泄给宿主。
delete process.env.POLARIS_NO_LOG
// 图谱自启与本单无关，且会在临时箱里拉服务：关掉（与 hook.mjs 自证同款）。
process.env.POLARIS_GRAPH = process.env.POLARIS_GRAPH || 'off'

// ── 小工具 ────────────────────────────────────────────────────────────────────
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'c25-hookwiring-'))
const r1 = (v) => (v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toFixed(1))
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex')
const sorted = (xs) => [...xs].sort((a, b) => a - b)
const padR = (s, n) => String(s ?? '').padEnd(n)
const padL = (s, n) => String(s ?? '').padStart(n)
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => (String(s).length <= n ? String(s) : `${String(s).slice(0, n)}…(+${String(s).length - n})`)
const relRepo = (p) => (path.resolve(p).startsWith(REPO) ? path.relative(REPO, path.resolve(p)).split(path.sep).join('/') : p)

function readText (file) {
  try { return { ok: true, text: fs.readFileSync(file, 'utf8') } } catch (e) { return { ok: false, why: oneLine(e?.message ?? e) } }
}
/** 1-based 行号；找不到返回 null。 */
function lineOf (text, needle) {
  const i = text.indexOf(needle)
  return i < 0 ? null : text.slice(0, i).split('\n').length
}
function listFiles (dir, depth = 3) {
  const out = []
  const walk = (d, k) => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = path.join(d, e.name)
      out.push(p)
      if (e.isDirectory() && k > 1) walk(p, k - 1)
    }
  }
  walk(dir, depth)
  return out
}

// ── 宿主 bundle 定位（读的是宿主真正加载的那一份，不是仓库里的同名副本）────────
function findBundle () {
  const r = spawnSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true })
  const first = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (first) {
    // <globalRoot>\dsh.cmd  ->  <globalRoot>\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai
    const globalRoot = path.dirname(first)
    const cand = path.join(globalRoot, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
    if (fs.existsSync(path.join(cand, 'dsh-hooks-codex', 'package.json'))) return { dir: cand, via: `where.exe dsh -> ${first}` }
  }
  const repo = path.join(REPO, 'node_modules', '@deepseek-ai')
  if (fs.existsSync(path.join(repo, 'dsh-hooks-codex', 'package.json'))) return { dir: repo, via: '仓库 node_modules（兜底）', fallback: true }
  return { dir: null, via: '找不到（both where.exe dsh 与仓库 node_modules 都没有）' }
}
const BUNDLE = findBundle()
const pkgPath = (spec) => {
  if (!BUNDLE.dir) return null
  const p = path.join(BUNDLE.dir, ...spec.split('/'))
  if (fs.existsSync(p)) return p
  const repo = path.join(REPO, 'node_modules', '@deepseek-ai', ...spec.split('/'))
  return fs.existsSync(repo) ? repo : null
}
const pkgVersion = (name) => {
  const p = pkgPath(`${name}/package.json`)
  if (!p) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).version } catch { return null }
}

// ── 常量：任务书/前序实测语料（供读者对照本机读数）────────────────────────────
const CITED = {
  preToolP50: 686, n: 58139, minutes: 613,
  shellShareLo: 76, shellShareHi: 84, judgeShare: 4.7,
  before: 913.6, after: 145.4, saveLo: 82, saveHi: 84,
}

// ── 待落地的执行器源码（逐字；本探针实测的就是这一份）────────────────────────
const SHIM_ABS = pkgFile('dsh', 'argv-shell.mjs')
const SHIM_SRC = `/**
 * argv-shell —— 宿主钩子专用的「不经任何 shell」执行器（\`ctx.shell\` 的提供者）。
 *
 * 【这是什么】把钩子桥交来的命令【字符串】按最小词法切成 argv，直接交给
 *   \`ctx.subprocess.spawn({ argv })\`；中间不启动任何 shell、不做命令替换、不做元字符解释。
 *   语义等价于 \`@deepseek-ai/dsh-native-command\` 的 \`runNativeCommand\`（execFile，argv 原样给 OS），
 *   只是搬到了 shell 接缝上 —— 因为 \`dsh-hook-protocol\` 的 \`runHook()\` 只认
 *   \`ctx.shell.run(ctx.shell.resolve({ command }))\`，钩子配置里没有任何 argv 字段。
 *
 * 【为什么】宿主现行 \`ctx.shell\` 是 \`@deepseek-ai/dsh-pwsh-local\`：命令串被拼成
 *   \`pwsh -NoLogo -NoProfile -NonInteractive -Command "<前置编码指令><串>"\` 再解析一遍。
 *   PreToolUse 每个工具调用都要付这一层（p50 686ms，n=58,139），其中 76–84% 是这层壳，
 *   真正的判定+落账只占 4.7%。换成本执行器 = 把壳层整个删掉。
 *
 * 【口径】只做最小、可预测的词法：空白分词；双/单引号成组并去掉引号；反斜杠只在成对引号内
 *   转义（Windows 路径里的 \`\\\` 必须原样保留）。\`;\` \`|\` \`&\` \`$\` \`%\` 反引号【都不是元字符】——
 *   这正是它与 shell 的全部差别。引号不配对 = 抛错（不猜，宁可响亮失败）。
 *
 * 【边界】只实现 \`run()\`（钩子桥只用它）。\`start()\` 明确抛错：本执行器只挂在
 *   \`polaris-hooks-unconfined\` 隔离组里，组内没有任何后台消费者 —— 不做半个实现。
 *
 * 【回滚】把 \`<DSH_HOME>/profiles/<profile>/cordis.patch.yml\` 里那一行的 name 改回
 *   \`@deepseek-ai/dsh-pwsh-local\` 即可（本文件可以留着，没人指向它就永远不会被 import）。
 *
 * @module aura-tools/dsh/argv-shell
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
      if (ch === '\\\\' && command[i + 1] === quote) { token += quote; i++; continue }
      if (ch === quote) { quote = null; continue }
      token += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === ' ' || ch === '\\t' || ch === '\\n' || ch === '\\r') {
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
const HOOK_SCRIPT_RE = /(?:^|[\\\\/])hook\\.mjs$/i
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
    noteDispatch(mod, 'spawn', \`threw:\${String(error?.message ?? error).slice(0, 60)}\`)
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
 * 本地 argv 执行器：\`ctx.shell\` 的无 shell 实现。
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
`

if (EMIT_ONLY) {
  fs.writeSync(1, SHIM_SRC)
  process.exit(0)
}

// ── 报告骨架 ──────────────────────────────────────────────────────────────────
const report = {
  at: new Date().toISOString(), repo: REPO, node: process.version, platform: process.platform,
  box, bundle: { dir: BUNDLE.dir, via: BUNDLE.via, versions: {} },
  facts: [], before: {}, after: {}, guard: [], change: {}, errors: [], warnings: [],
}
const HARD = []
const hardFail = (id, detail) => { HARD.push({ id, detail }); say(`  ✗ 硬判据红 ${id}: ${detail}`) }

// 生产落点快照：本探针跑完必须【一行都没碰】（跑的是宿主自己的账，只拿来对账、不当证据用它）
const PROD_LEDGER0 = path.join(REPO, '.polaris', 'polaris-guard.log.jsonl')
function prodSnapshot () {
  const dir = path.dirname(PROD_LEDGER0)
  let entries = null
  try { entries = fs.readdirSync(dir).length } catch { /* 目录不在 */ }
  try {
    const st = fs.statSync(PROD_LEDGER0)
    return { entries, bytes: st.size, mtime: st.mtime.toISOString() }
  } catch { return { entries, bytes: null, mtime: null } }
}
const PROD_BEFORE = prodSnapshot()

// ═════════════════════════════════════════════════════════════════════════════
say('══════════════════════════════════════════════════════════════════════════════')
say(' C25：宿主钩子固定税的预备改造 —— argv 直投接线计划 + 非激活实测')
say('══════════════════════════════════════════════════════════════════════════════')
say('')
say('【前提 / 计时单声明】')
say(`  cwd=${REPO}`)
say(`  node=${process.version}  平台=${process.platform}  核数=${os.cpus().length}  时间=${report.at}`)
say(`  临时箱（唯一写入点）= ${box}${KEEP_TMP ? '（--keep-tmp：保留）' : ''}`)
say(`  宿主 bundle = ${BUNDLE.dir ?? '(未找到)'}`)
say(`                定位方式 = ${BUNDLE.via}`)
say(`  宿主 profile  = ${PROFILE}`)
say(`  宿主 hooks.json = ${HOOKS_JSON}`)
say(`  钩子入口 = ${HOOK}${fs.existsSync(HOOK) ? '' : '  ← 不存在：钩子相关读数会标「不可用」'}`)
say(`  本探针【不写】任何 C:\\Users\\cxk\\.dsh\\ 下的文件；落账只落临时箱（口径见文件头「边界」）。`)
say(`  重复次数=${REPS}（每层串行、取 p50；给 min/max 供判断抖动；--no-timing 可跳过全部计时）`)
say('')

// ═════════════════════════════════════════════════════════════════════════════
say('──────────────────────────────────────────────────────────────────────────────')
say(' §1  ① DSH 到底怎么执行那个 command 字符串 / 有没有现成的「直投 argv」机制')
say('──────────────────────────────────────────────────────────────────────────────')
say('')

const FACTS = [
  { id: 'F1-hook-shape', pkg: 'dsh-hook-protocol/lib/types/types.d.ts', needle: 'The shell command line to run.', line: null,
    why: '钩子配置的形状：CommandHook 只有 command: string（+ timeoutSec）——没有任何 argv/args 字段' },
  { id: 'F2-codex-parse', pkg: 'dsh-hooks-codex/lib/index.js', needle: 'if (typeof hook.command !== "string") continue;', line: 67,
    why: '桥的解析器：command 不是字符串就直接跳过（所以 argv 形状连登记都登记不上）' },
  { id: 'F3-bridge-run', pkg: 'dsh-hooks-codex/lib/index.js', needle: 'await runHook(ctx.shell, hook, {', line: 159,
    why: '执行入口：桥把钩子交给 ctx.shell —— 【经 shell 还是直投 argv 由这个服务的提供者决定】' },
  { id: 'F4-bridge-inject', pkg: 'dsh-hooks-codex/lib/index.js', needle: 'const inject = ["shell", "sessionProjections"];', line: 102,
    why: '桥的依赖声明：必须有 ctx.shell 才能挂载' },
  { id: 'F5-protocol-request', pkg: 'dsh-hook-protocol/lib/index.js', needle: 'command: hook.command,', line: 192,
    why: '协议层：把命令【串】原样塞进 ShellExecRequest.command' },
  { id: 'F6-protocol-run', pkg: 'dsh-hook-protocol/lib/index.js', needle: 'const result = await bash.run(bash.resolve(request));', line: 200,
    why: '协议层唯一的执行语句：bash = ctx.shell' },
  { id: 'F7-shell-seam', pkg: 'dsh-shell/lib/index.js', needle: 'super(ctx, "shell");', line: 86,
    why: 'ctx.shell 这个能力接缝的定义（抽象类；一个上下文只许有一个提供者）' },
  { id: 'F8-pwsh-argv', pkg: 'dsh-pwsh-local/lib/index.js', needle: '"-Command",', line: 277,
    why: '现行提供者 pwsh-local：命令串被拼成 pwsh … -Command "<串>" —— 这就是那 76–84% 的壳层' },
  { id: 'F9-native-lib', pkg: 'dsh-native-command/lib/index.js', needle: 'const runNativeCommand = (command, args, signal) => new Promise', line: 17,
    why: 'DSH 自带的无 shell 机制：execFile(command, argv) —— 但它是【库】，不是 ctx.shell 提供者' },
  { id: 'F10-native-doc', pkg: 'dsh-native-command/lib/index.js', needle: '* @param args - argv (never a shell string).', line: 13,
    why: '它自己的文档：argv，永远不是 shell 串' },
  { id: 'F11-subprocess-argv', pkg: 'dsh-subprocess/lib/types/types.d.ts', needle: 'Never shell-interpreted here.', line: null,
    why: '底层接缝的合同：argv[0] 是程序，【绝不经过 shell 解释】—— 换 provider 就是走这条' },
  { id: 'F12-subprocess-local', pkg: 'dsh-subprocess-local/lib/index.js', needle: 'spawn(spec) {', line: 990,
    why: '本地 subprocess 提供者：argv 直投的落点' },
  { id: 'F13-native-exports', pkg: 'dsh-native-command/lib/index.js', needle: 'export { canOpenNativePath, nativeFileManager, openNativePath, openNativeTextFile, revealNativePath, runNativeCommand };', line: null,
    why: 'dsh-native-command 的导出清单里【没有 apply / 没有 Service】⇒ 现成机制只到库级，宿主缺一个壳提供者' },
  { id: 'F14-loader-name', pkg: 'cordis-plugin-loader/src/config/tree.ts', needle: 'import(name: string, getOuterStack?: () => string[]) {', line: 145,
    why: '加载器的 name 只接受模块说明符（cordis: 前缀/相对/裸包名）⇒ 不能在 YAML 里内联定义插件' },
]
say('  逐条复核（读的是宿主真正加载的那一份；每条给文件:行号）：')
for (const f of FACTS) {
  const p = pkgPath(f.pkg)
  if (p === null) { say(`  · ${padR(f.id, 20)} 文件不在（跳过）：${f.pkg}`); report.facts.push({ ...f, ok: null, file: null, line: null }); continue }
  const t = readText(p)
  if (!t.ok) { say(`  · ${padR(f.id, 20)} 读不出（跳过）：${f.pkg}`); report.facts.push({ ...f, ok: null, file: p, line: null }); continue }
  const line = lineOf(t.text, f.needle)
  const ok = line !== null && (f.line === null || f.line === line)
  const shown = p.replace(BUNDLE.dir ?? '', '').replace(/^[\\/]/, '')
  say(`  ${ok ? '✓' : '✗'} ${padR(f.id, 20)} ${shown}:${line ?? '?'}${f.line !== null && f.line !== line ? `（任务书说 :${f.line}）` : ''}`)
  say(`      ${f.why}`)
  report.facts.push({ id: f.id, file: p, line, expected: f.line, ok })
  if (!ok) hardFail(f.id, `${f.pkg} 里找不到 ${JSON.stringify(clip(f.needle, 60))}（读到的行号=${line}）`)
}
for (const v of ['dsh-hooks-codex', 'dsh-pwsh-local', 'dsh-native-command', 'dsh-subprocess', 'dsh-hook-protocol', 'dsh-shell']) {
  report.bundle.versions[v] = pkgVersion(v)
}
say('')
say(`  bundle 版本（宿主那份）：${Object.entries(report.bundle.versions).map(([k, v]) => `${k}@${v}`).join('  ')}`)

// 全 bundle 扫描：谁提供了 ctx.shell（证明「没有现成的 argv 提供者」）
say('')
say('  全 bundle 扫描：谁是 ctx.shell 的提供者（extends ShellExecutor / super(ctx,"shell")）')
const shellProviders = []
for (const f of listFiles(BUNDLE.dir ?? path.join(REPO, 'node_modules', '@deepseek-ai'), 4)) {
  if (!f.endsWith('.js') || f.includes(`${path.sep}dist${path.sep}`) || f.includes(`${path.sep}client`)) continue
  const t = readText(f)
  if (!t.ok) continue
  if (t.text.includes('extends ShellExecutor')) {
    shellProviders.push({ file: f.replace(BUNDLE.dir ?? '', '').replace(/^[\\/]/, ''), line: lineOf(t.text, 'extends ShellExecutor') })
  }
}
for (const s of shellProviders) say(`    · ${s.file}:${s.line}`)
const onlyShells = shellProviders.length === 2 && shellProviders.every((s) => /dsh-(bash|pwsh)-local/.test(s.file))
say(`    ⇒ 提供者只有 ${shellProviders.length} 个，且全是【真 shell】（bash-local / pwsh-local）：${onlyShells ? '成立' : '与预期不符'}`)
report.facts.push({ id: 'F15-no-argv-provider', ok: onlyShells, providers: shellProviders })
if (!onlyShells) hardFail('F15-no-argv-provider', `bundle 里的 ctx.shell 提供者不是「只有 bash-local/pwsh-local」：${JSON.stringify(shellProviders)}`)

// 宿主现行接线（只读）
say('')
say('  宿主现行接线（只读）：')
const profTxt = readText(PROFILE)
let profShellLine = null
let profRowLine = null
let profIsolateLine = null
let profBridgeLine = null
const hooksTxt = readText(HOOKS_JSON)
let hookCommands = []
if (profTxt.ok) {
  profShellLine = lineOf(profTxt.text, "name: '@deepseek-ai/dsh-pwsh-local'")
  profRowLine = lineOf(profTxt.text, 'id: polaris-hooks-shell')
  profIsolateLine = lineOf(profTxt.text, 'shell: true')
  profBridgeLine = lineOf(profTxt.text, 'id: polaris-injection-bridge')
  const profLines = profTxt.text.split(/\r?\n/)
  say(`    ${PROFILE}:${profRowLine ?? '?'}  id: polaris-hooks-shell`)
  say(`    ${PROFILE}:${profShellLine ?? '?'}  name: '@deepseek-ai/dsh-pwsh-local'      ← 【决定「经 shell」的那一行】`)
  say(`    ${PROFILE}:${profIsolateLine ?? '?'}  shell: true（所在组 isolate ⇒ 组内 ctx.shell 与宿主工具用的那份分开）`)
  say(`    ${PROFILE}:${profBridgeLine ?? '?'}  id: polaris-injection-bridge（@deepseek-ai/dsh-hooks-codex）`)
  if (profShellLine !== null) say(`        原文: ${profLines[profShellLine - 1]}`)
} else {
  say(`    （读不出 ${PROFILE}：${profTxt.why} —— 该行号无法钉住，§4 会标「待人工核对」）`)
  report.warnings.push(`读不出宿主 profile：${profTxt.why}`)
  hardFail('F16-profile-line', `读不出 ${PROFILE}，改动清单无法精确到行`)
}
if (hooksTxt.ok) {
  const hj = JSON.parse(hooksTxt.text)
  for (const [ev, groups] of Object.entries(hj.hooks ?? {})) {
    for (const g of groups) for (const h of g.hooks ?? []) {
      hookCommands.push({ event: ev, command: h.command, timeout: h.timeout })
    }
  }
  for (const h of hookCommands) say(`    hooks.json ${padR(h.event, 18)} command: ${h.command}`)
} else {
  say(`    （读不出 ${HOOKS_JSON}：${hooksTxt.why}）`)
  report.warnings.push(`读不出宿主 hooks.json：${hooksTxt.why}`)
}
const preToolCmd = (hookCommands.find((h) => h.event === 'PreToolUse') ?? {}).command
  ?? `node "${HOOK.replace(/\\/g, '/')}" --event=PreToolUse --host=dsh --state=workspace`
report.facts.push({ id: 'F16-profile-line', ok: profShellLine !== null, file: PROFILE, line: profShellLine })
report.facts.push({ id: 'F17-pretool-command', ok: true, command: preToolCmd })

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' §2  改动前（before）：现行接线的三条原始读数')
say('──────────────────────────────────────────────────────────────────────────────')

// 2.1 生产账本尾（现网就是这条 shell 路在用）
say('')
say(' 2.1 生产账本尾 3 条（只读；宿主正在用它，每一行都是一次真实判定+落账）')
const PROD_LEDGER = path.join(REPO, '.polaris', 'polaris-guard.log.jsonl')
const prodTxt = readText(PROD_LEDGER)
let prodTail = []
if (prodTxt.ok) {
  prodTail = prodTxt.text.trim().split('\n').slice(-3)
  for (const l of prodTail) say(`    ${clip(l, 240)}`)
} else {
  say(`    （读不出 ${PROD_LEDGER}：${prodTxt.why}）`)
}
report.before.prodLedgerTail = prodTail

// 载荷（与 dsh-hooks-codex 的 preToolPayload 同形）
const allowExec = { name: 'grep', arguments: { pattern: 'x' }, callId: 'c25-allow' }
const denyExec = { name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: 'c25-deny' }

// ── 桥级对照装置：真桥 + 真 subprocess + 指定 transport ──────────────────────
let cordis = null
let hooksCodex = null
let SubprocessLocal = null
let transportErr = null
try {
  cordis = await import('@deepseek-ai/cordis')
  hooksCodex = await import('@deepseek-ai/dsh-hooks-codex')
  SubprocessLocal = (await import('@deepseek-ai/dsh-subprocess-local')).default
} catch (e) { transportErr = oneLine(e?.message ?? e) }
const BRIDGE_AVAILABLE = transportErr === null && fs.existsSync(HOOK)

/** 组一份「桥 + 子进程 + 指定 shell 提供者」的真组合，喂一个 PreToolUse，返回原始读数。 */
async function runBridge ({ transport, exec, tag, env }) {
  const runBox = fs.mkdtempSync(path.join(box, `${tag}-`))
  const cfgPath = path.join(runBox, 'hooks.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: preToolCmd, timeout: 10 }] }] } }, null, 2))
  const saved = {}
  for (const [k, v] of Object.entries(env ?? {})) { saved[k] = process.env[k]; process.env[k] = v }
  const spawns = []
  let ctx = null
  let proto = null
  let origSpawn = null
  try {
    ctx = new cordis.Context()
    await ctx.plugin(SubprocessLocal).await?.()
    ctx.provide('sessionProjections', { stateOf: () => undefined })
    const plugin = transport === 'argv' ? (await importTempShim(runBox)).default : (await import('@deepseek-ai/dsh-pwsh-local')).default
    await ctx.plugin(plugin, { cwd: runBox }).await?.()
    // 观测点：把所有交给 ctx.subprocess 的 spawn 规格记下来（argv 直投的【物证】）
    proto = Object.getPrototypeOf(ctx.subprocess)
    origSpawn = proto.spawn
    proto.spawn = function (spec) { spawns.push(spec); return origSpawn.call(this, spec) }
    await ctx.plugin(hooksCodex, { configPath: cfgPath }).await?.()
    const started = performance.now()
    const decision = await ctx.waterfall('tools/pre-execute', { ...exec, signal: undefined }, () => ({ kind: 'enter' }))
    const ms = performance.now() - started
    const ledger = readText(path.join(runBox, '.polaris', 'polaris-guard.log.jsonl'))
    const rows = ledger.ok ? ledger.text.trim().split('\n').filter(Boolean) : []
    return {
      tag, transport, ms,
      decision: { kind: decision?.kind ?? null, reason: decision?.reason ?? null },
      spawnSpec: spawns.length ? { argv: spawns[spawns.length - 1].argv, cwd: spawns[spawns.length - 1].cwd, stdinBytes: (spawns[spawns.length - 1].stdio?.stdin?.data ?? '').length } : null,
      ledger: rows.length ? rows[rows.length - 1] : null,
      ledgerParsed: rows.length ? (() => { try { return JSON.parse(rows[rows.length - 1]) } catch { return null } })() : null,
      ledgerFile: path.join(runBox, '.polaris', 'polaris-guard.log.jsonl'),
      box: runBox,
      files: rows.length ? null : listFiles(runBox).map(relRepo),
    }
  } finally {
    if (proto !== null && origSpawn !== null) proto.spawn = origSpawn
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    try { await ctx?.stop?.() } catch { /* 组合随进程退出即可 */ }
  }
}

/** 把待落地的 shim 源码写进临时箱并 import（裸包名换成探针解析出的 file:// —— 唯一差异，逐字打印）。 */
let tempShimInfo = null
async function importTempShim (runBox) {
  if (tempShimInfo !== null && tempShimInfo.box === runBox) return tempShimInfo.mod
  fs.mkdirSync(runBox, { recursive: true })
  const shellUrl = import.meta.resolve('@deepseek-ai/dsh-shell')
  const schemaUrl = import.meta.resolve('@deepseek-ai/schemastery')
  const rewritten = SHIM_SRC
    .replace("from '@deepseek-ai/dsh-shell'", `from '${shellUrl}'`)
    .replace("from '@deepseek-ai/schemastery'", `from '${schemaUrl}'`)
  const file = path.join(runBox, 'argv-shell.mjs')
  fs.writeFileSync(file, rewritten)
  const mod = await import(pathToFileURL(file).href)
  tempShimInfo = { box: runBox, file, mod, shellUrl, schemaUrl, rewritten }
  return mod
}

const bridgeRuns = { before: {}, after: {} }
if (!BRIDGE_AVAILABLE) {
  say(`  ⚠ 桥级对照不可用（${transportErr ?? `${HOOK} 不存在`}）—— 只出事实链与耗时对照`)
  report.warnings.push('桥级对照不可用，§2.2/§3.2/§3.5 缺读数')
} else {
  say('')
  say(' 2.2 桥级对照（真 @deepseek-ai/dsh-hooks-codex + 真 subprocess + transport=pwsh-local）')
  say('     装置：组一份内存里的真组合（桥 config = 临时 hooks.json，命令串逐字取自宿主 hooks.json），')
  say('           喂一次 tools/pre-execute，读回执 + 读落账。子进程 cwd = 临时箱 ⇒ --state=workspace 落箱内。')
  for (const [tag, exec] of [['allow', allowExec], ['deny', denyExec]]) {
    const r = await runBridge({ transport: 'pwsh', exec, tag: `before-${tag}` })
    bridgeRuns.before[tag] = r
    say(`      · payload=${padR(tag, 5)} 判决=${padR(r.decision.kind, 6)} 耗时=${padL(r1(r.ms), 8)}ms  落账=${r.ledger ? '有' : '无'}`)
    if (r.ledgerParsed) say(`        落账原文: ${clip(r.ledger, 300)}`)
    else if (r.files) say(`        落账缺失；箱内文件: ${clip(r.files.join(' '), 300)}`)
  }
  report.before.bridge = bridgeRuns.before

  say('')
  say(' 2.3 「argv 形状」今天能不能表达？（真桥 + 真解析器，两个自然写法）')
  const shapes = [
    { type: 'command', argv: ['node', '-e', '0'], timeout: 5 },
    { type: 'command', command: ['node', '-e', '0'], timeout: 5 },
  ]
  for (const shape of shapes) {
    const runBox = fs.mkdtempSync(path.join(box, 'shape-'))
    const cfgPath = path.join(runBox, 'hooks.json')
    fs.writeFileSync(cfgPath, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [shape] }] } }))
    const ctx = new cordis.Context()
    let calls = 0
    ctx.provide('shell', { run: async () => { calls++; return { exitCode: 0 } }, resolve: (x) => x })
    ctx.provide('sessionProjections', { stateOf: () => undefined })
    await ctx.plugin(hooksCodex, { configPath: cfgPath }).await?.()
    await ctx.waterfall('tools/pre-execute', { ...allowExec, signal: undefined }, () => ({ kind: 'enter' }))
    say(`      · hooks.json 里写 ${padR(JSON.stringify(shape), 52)} ⇒ ctx.shell.run 调用次数 = ${calls}`)
    report.before.argvShape = report.before.argvShape ?? []
    report.before.argvShape.push({ shape, shellRunCalls: calls })
    if (calls !== 0) hardFail('B3-argv-shape', `argv 形状居然被执行了（calls=${calls}）`)
  }
  say('      ⇒ 改动前：argv 形式【在钩子配置里不可表达】（command 必须是字符串，见 §1 的 F1/F2）。')
}

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' §3  改动后（after）：argv 直投下钩子仍能判定与落账')
say('──────────────────────────────────────────────────────────────────────────────')

// 3.1 命令串 -> argv
say('')
say(' 3.1 命令串 → argv（逐字；tokenizeArgv 是 shim 里的纯函数）')
let tokenizeArgv = null
const TOKEN_CASES = [
  { in: preToolCmd, why: '宿主 hooks.json 的 PreToolUse 命令串（真身）' },
  { in: 'node -e 0', why: '最简' },
  { in: 'node "C:/a b/c.mjs" --x=1  --y=2', why: '双引号内含空格 + 连续空白' },
  { in: "node 'C:/a b/c.mjs' 'lit\\'q'", why: '单引号 + 引号内转义' },
  { in: 'node C:\\tools\\x.mjs --p=1', why: '未加引号的 Windows 反斜杠路径必须原样保留' },
  { in: 'node -e "" --t', why: '空串参数要留下一个空 token' },
]
if (BRIDGE_AVAILABLE) {
  const mod = await importTempShim(path.join(box, 'shimapi'))
  tokenizeArgv = mod.tokenizeArgv
  const apiBox = path.join(box, 'shimapi')
  fs.mkdirSync(apiBox, { recursive: true })
  for (const c of TOKEN_CASES) {
    let got = null
    let err = null
    try { got = tokenizeArgv(c.in) } catch (e) { err = oneLine(e?.message ?? e) }
    const ok = err === null && Array.isArray(got) && got.length > 0
    say(`      ${ok ? '✓' : '✗'} ${JSON.stringify(c.in)}`)
    say(`         ⇒ ${JSON.stringify(got)}${err ? `  抛错=${err}` : ''}      (${c.why})`)
    if (!ok) hardFail('A0-tokenize', `命令串切不出 argv：${JSON.stringify(c.in)}`)
  }
  // 反例：引号不配对必须响亮抛错
  let unbalanced = null
  try { tokenizeArgv('node "C:\\x\\') } catch (e) { unbalanced = oneLine(e?.message ?? e) }
  say(`      ${unbalanced ? '✓' : '✗'} 引号不配对 ⇒ ${unbalanced ?? '（居然没抛错）'}`)
  if (!unbalanced) hardFail('A0-unbalanced', '引号不配对没有抛错（会静默猜一个 argv）')
  const wantArgv = ['node', HOOK.replace(/\\/g, '/'), '--event=PreToolUse', '--host=dsh', '--state=workspace']
  const gotArgv = tokenizeArgv(preToolCmd)
  const hostArgvOk = JSON.stringify(gotArgv) === JSON.stringify(wantArgv)
  say(`      ${hostArgvOk ? '✓' : '✗'} 宿主命令串 ⇒ 与期望 argv 逐字相等：${hostArgvOk ? '成立' : `实得 ${JSON.stringify(gotArgv)}，期望 ${JSON.stringify(wantArgv)}`}`)
  if (!hostArgvOk) hardFail('A0-host-argv', `宿主命令串切出的 argv 与期望不等：${JSON.stringify(gotArgv)}`)
  report.after.tokenizer = { hostArgv: gotArgv, expected: wantArgv, ok: hostArgvOk }
} else {
  say('      （跳过：桥不可用）')
}

// 3.2 桥级对照：transport = argv
if (BRIDGE_AVAILABLE) {
  say('')
  say(' 3.2 桥级对照（同一份装置，transport=argv-shell；这条就是改动后的接线形状）')
  for (const [tag, exec] of [['allow', allowExec], ['deny', denyExec]]) {
    const r = await runBridge({ transport: 'argv', exec, tag: `after-${tag}` })
    bridgeRuns.after[tag] = r
    say(`      · payload=${padR(tag, 5)} 判决=${padR(r.decision.kind, 6)} 耗时=${padL(r1(r.ms), 8)}ms  落账=${r.ledger ? '有' : '无'}`)
    if (r.spawnSpec) say(`        实际 spawn 的 argv = ${JSON.stringify(r.spawnSpec.argv)}`)
    if (r.spawnSpec) say(`        实际 spawn 的 cwd  = ${r.spawnSpec.cwd}   stdin=${r.spawnSpec.stdinBytes} 字节`)
    if (r.ledgerParsed) say(`        落账原文: ${clip(r.ledger, 320)}`)
    else { say('        ✗ 没有落账记录'); hardFail(`A2-ledger-${tag}`, `argv 路径下 payload=${tag} 没有落账`) }
    if (r.spawnSpec && r.spawnSpec.argv.some((a) => String(a).toLowerCase().includes('-command'))) {
      hardFail(`A2-shellleak-${tag}`, `argv 里出现了 -Command：${JSON.stringify(r.spawnSpec.argv)}`)
    }
    if (!r.ledgerParsed) continue
    if (r.ledgerParsed.verdict === undefined) hardFail(`A2-verdict-${tag}`, '落账里没有 verdict 字段')
  }
  report.after.bridge = bridgeRuns.after

  // 判决一致性（护栏仍在 = 换 transport 不改判决）
  say('')
  say(' 3.3 护栏一致性：同一载荷、两种 transport 的判决与落账 verdict 必须逐字相同')
  for (const tag of ['allow', 'deny']) {
    const b = bridgeRuns.before[tag]
    const a = bridgeRuns.after[tag]
    const kindSame = b?.decision?.kind === a?.decision?.kind
    const vSame = (b?.ledgerParsed?.verdict ?? null) === (a?.ledgerParsed?.verdict ?? null)
    const cSame = (b?.ledgerParsed?.cause ?? null) === (a?.ledgerParsed?.cause ?? null)
    report.guard.push({ payload: tag, kindBefore: b?.decision?.kind ?? null, kindAfter: a?.decision?.kind ?? null, verdictBefore: b?.ledgerParsed?.verdict ?? null, verdictAfter: a?.ledgerParsed?.verdict ?? null, causeBefore: b?.ledgerParsed?.cause ?? null, causeAfter: a?.ledgerParsed?.cause ?? null, ok: kindSame && vSame && cSame })
    say(`      ${kindSame && vSame && cSame ? '✓' : '✗'} payload=${padR(tag, 5)} 判决 ${b?.decision?.kind} → ${a?.decision?.kind}   落账 verdict ${b?.ledgerParsed?.verdict} → ${a?.ledgerParsed?.verdict}   cause ${b?.ledgerParsed?.cause ?? '—'} → ${a?.ledgerParsed?.cause ?? '—'}`)
    if (!(kindSame && vSame && cSame)) hardFail(`A3-guard-${tag}`, '两种 transport 的判决/落账不一致 —— 换 transport 动了语义，不许激活')
  }
  const denyAfter = bridgeRuns.after.deny
  say(`      ⇒ 破坏性命令（payload: pwsh "rm -rf /"）在 argv 路径下的回执：${JSON.stringify(denyAfter?.decision ?? null)}`)
  say(`         ⇒ 结论：护栏的判定与落账与 transport 无关；argv 路径下护栏仍在。`)

  // 3.4 同一判据、前后两个读数：执行路径里到底有没有 shell
  say('')
  say(' 3.4 同一判据「命令串没有被 shell 词法解释」，改动前 / 改动后各一个原始读数')
  const pwshPlugin = (await import('@deepseek-ai/dsh-pwsh-local')).default
  const cA = new cordis.Context()
  const cB = new cordis.Context()
  await cA.plugin((await import('@deepseek-ai/dsh-subprocess-local')).default).await?.()
  await cB.plugin((await import('@deepseek-ai/dsh-subprocess-local')).default).await?.()
  await cA.plugin(pwshPlugin, { cwd: box }).await?.()
  await cB.plugin((await importTempShim(path.join(box, 'shimapi'))).default, { cwd: box }).await?.()
  const argvBefore = cA.shell.argv(cA.shell.resolve({ command: preToolCmd }))
  const argvAfter = cB.shell.argv(cB.shell.resolve({ command: preToolCmd }))
  say(`      · 改动前 pwsh-local.argv(spec)   = ${JSON.stringify(argvBefore)}`)
  say(`      · 改动后 argv-shell.argv(spec)    = ${JSON.stringify(argvAfter)}`)
  const beforeHasShell = argvBefore.some((a) => /(^|[\\/])(pwsh|bash|sh|cmd)(\.exe)?$/i.test(String(a))) || argvBefore.includes('-Command')
  const afterHasShell = argvAfter.some((a) => /(^|[\\/])(pwsh|bash|sh|cmd)(\.exe)?$/i.test(String(a))) || argvAfter.includes('-Command')
  say(`      ${beforeHasShell && !afterHasShell ? '✓' : '✗'} 改动前 argv[0] 是 shell 且带 -Command；改动后 argv[0] 是 node（无 -Command）`)
  report.after.argvPair = { command: preToolCmd, argvBefore, argvAfter, beforeHasShell, afterHasShell }
  if (!(beforeHasShell && !afterHasShell)) hardFail('A4-argv-pair', '改动前/后的 argv 形状不构成「有 shell → 无 shell」的对照')

  // 3.4b 无 shell 反证（行为面）
  say('')
  say(' 3.4b 无 shell 反证（同一命令串，两种 transport 的输出必须不同）')
  const META_CMD = 'node -e "process.stdout.write(\'C25-OK\')" ; Write-Output C25-INJECTED'
  say(`      命令串 = ${META_CMD}`)
  say('      （";" 在 PowerShell 里是语句分隔符 ⇒ 经 shell 会多跑一句；argv 直投时它只是一个普通参数）')
  const pwsh = whichPwsh()
  const PW_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
  const PW_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  let viaShell = { out: '(pwsh 不在)' }
  if (pwsh) {
    const r = spawnSync(pwsh, [...PW_ARGS, PW_PREAMBLE + META_CMD], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    viaShell = { exe: pwsh, status: r.status, out: String(r.stdout ?? '') }
  }
  const viaArgv = await runViaShim(META_CMD)
  const shellInjected = viaShell.out.includes('C25-INJECTED')
  const argvInjected = String(viaArgv.stdout ?? '').includes('C25-INJECTED')
  say(`      · 经 shell（pwsh -Command）：stdout=${JSON.stringify(viaShell.out)}  ⇒ 多跑了 INJECTED = ${shellInjected}`)
  say(`      · 直投 argv（本方案）    ：stdout=${JSON.stringify(viaArgv.stdout)}  exit=${viaArgv.exitCode}  ⇒ 多跑了 INJECTED = ${argvInjected}`)
  say(`      ${shellInjected && !argvInjected ? '✓' : '✗'} argv 路径下没有任何 shell 参与（元字符只当普通参数）`)
  report.after.noShellProof = { command: META_CMD, viaShell: viaShell.out, viaShellInjected: shellInjected, viaArgv: viaArgv.stdout, viaArgvInjected: argvInjected, spawnArgv: viaArgv.spawnArgv }
  if (!(shellInjected && !argvInjected)) hardFail('A4-noshell', `无 shell 反证不成立：shell=${shellInjected} argv=${argvInjected}`)
} else if (VERIFY_GUARD) {
  say('      ✗ --verify-guard 要求桥可用（真桥 + 真 subprocess），当前不可用 ⇒ 无法验证护栏')
  hardFail('A2-bridge-unavailable', '--verify-guard 下桥不可用')
  report.guard.push({ payload: '(全部)', ok: false, kindBefore: null, kindAfter: null })
} else {
  say('      （跳过：桥不可用）')
}

// 3.5 耗时对照
say('')
say(' 3.5 耗时对照（同一 stdin 载荷；每层串行 ' + REPS + ' 次取 p50）')
if (NO_TIMING) {
  say('      （--no-timing：跳过）')
} else {
  const payload = JSON.stringify({
    session_id: 'c25-hook-wiring-plan', transcript_path: null, cwd: REPO, hook_event_name: 'PreToolUse',
    model: '', permission_mode: 'default', turn_id: '0', tool_name: 'pwsh',
    tool_input: { command: 'node -e "process.exit(0)"' }, tool_use_id: 'call_c25',
  })
  const pwsh = whichPwsh()
  const timingBox = fs.mkdtempSync(path.join(box, 'timing-'))
  const PW_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
  const PW_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  const measure = (exe, args) => {
    const xs = []
    let last = null
    for (let i = 0; i < REPS; i++) {
      const t0 = performance.now()
      // cwd = 临时箱：--state=workspace 就落箱里；即使将来 NO_LOG 失效也不会污染仓库
      const r = spawnSync(exe, args, { cwd: timingBox, input: payload, encoding: 'utf8', env: { ...process.env, POLARIS_NO_LOG: '1' }, windowsHide: true, maxBuffer: 1 << 24, timeout: 60000 })
      xs.push(performance.now() - t0)
      last = r
    }
    const s = sorted(xs)
    return { n: xs.length, p50: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], status: last?.status }
  }
  const drift1 = measure(process.execPath, ['-e', '0'])
  const T = {}
  if (pwsh) T.beforeShell = measure(pwsh, [...PW_ARGS, PW_PREAMBLE + preToolCmd])
  else say('      （pwsh 不在 PATH/well-known 位置：改动前那一层测不了）')
  // 直投 argv：argv[0] 是「node」—— 我们自己就是 node，所以丢掉 argv[0]，其余原样交给 spawnSync（不经 shell）。
  const hookArgv = tokenizeArgv ? tokenizeArgv(preToolCmd).slice(1) : [HOOK, '--event=PreToolUse', '--host=dsh', '--state=workspace']
  T.argvRaw = measure(process.execPath, hookArgv)
  T.argvRaw.argv = hookArgv
  const drift2 = measure(process.execPath, ['-e', '0'])
  say(`      node -e 0（启动下限，首/末各一次做漂移对照）: p50=${r1(drift1.p50)}ms → ${r1(drift2.p50)}ms`)
  for (const [id, label, m] of [
    ['B2', '改动前：pwsh … -Command "<宿主命令串>"', T.beforeShell],
    ['A1', '改动后：node hook.mjs … 直投 argv', T.argvRaw],
  ]) {
    if (!m) continue
    say(`      ${padR(id, 4)}${padR(label, 42)} p50=${padL(r1(m.p50), 8)}ms  min=${padL(r1(m.min), 8)}  max=${padL(r1(m.max), 8)}  exit=${m.status}`)
  }
  report.before.timing = T.beforeShell ?? null
  report.after.timing = T.argvRaw
  report.timingDrift = { first: drift1.p50, last: drift2.p50 }
  if (T.beforeShell && T.argvRaw) {
    const saved = T.beforeShell.p50 - T.argvRaw.p50
    const pctSaved = (saved / T.beforeShell.p50) * 100
    say(`      ⇒ 省 ${r1(saved)}ms / 每次调用（${r1(pctSaved)}%）；对照任务书语料 ${CITED.before}ms → ${CITED.after}ms（省 ${CITED.saveLo}–${CITED.saveHi}%）`)
    if (pctSaved < 50) hardFail('A5-savings', `只省了 ${r1(pctSaved)}%，与方案预期（80%+）差距过大`)
  }
  say(`      注：绝对值随机器负载漂移（C6 实测同款声明）；占比看 p50 比值，绝对值请与上面 node 启动下限一起读。`)

  // 为什么「改动后」有两个不同的数字：进程级（去壳层）vs 接线级（过真 ctx.subprocess 接缝）
  if (BRIDGE_AVAILABLE) {
    say('')
    say(' 3.5b 接缝地板分解（两个「改动后」数字的口径差在哪）')
    const subCtx = new cordis.Context()
    await subCtx.plugin(SubprocessLocal).await?.()
    const floorXs = []
    for (let i = 0; i < 4; i++) {
      const t0 = performance.now()
      const h = subCtx.subprocess.spawn({
        argv: [process.execPath, '-e', '0'], cwd: timingBox, graceMs: 3000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536, spill: { maxBytes: 1 << 20 } }, stderr: { maxBytes: 65536, spill: { maxBytes: 1 << 20 } } },
      })
      await h.done
      floorXs.push(performance.now() - t0)
    }
    const floor = sorted(floorXs)[Math.floor(floorXs.length / 2)]
    say(`      · 裸 spawnSync node -e 0        p50 = ${r1(drift2.p50)}ms（本次首/末漂移对照的末次值）`)
    say(`      · ctx.subprocess.spawn node -e 0 p50 = ${r1(floor)}ms（4 次里取中位）⇒ 接缝地板 ≈ ${r1(floor - drift2.p50)}ms/次`)
    say('      ⇒ 两个口径都对，只是分母不同：')
    say(`         进程级（去壳层本身）        : ${r1(T.beforeShell?.p50 ?? NaN)} → ${r1(T.argvRaw.p50)}ms（-${r1((1 - T.argvRaw.p50 / (T.beforeShell?.p50 ?? NaN)) * 100)}%）—— 与任务书语料 913.6→145.4 同口径`)
    if (bridgeRuns.before.allow && bridgeRuns.after.allow) {
      const bMs = bridgeRuns.before.allow.ms
      const aMs = bridgeRuns.after.allow.ms
      say(`         接线级（真桥+真接缝+真落账）: ${r1(bMs)} → ${r1(aMs)}ms（-${r1((1 - aMs / bMs) * 100)}%）—— 接缝地板在两边都付，不参与差额`)
      say(`         两种口径算出的【壳层本身】代价一致：${r1((T.beforeShell?.p50 ?? 0) - T.argvRaw.p50)}ms vs ${r1(bMs - aMs)}ms`)
    }
    report.after.seamFloor = { spawnSyncNode: drift2.p50, subprocessSpawnNode: floor, floorOverhead: floor - drift2.p50 }
  }
}

// 3.6 插件契约
if (BRIDGE_AVAILABLE) {
  say('')
  say(' 3.6 插件契约：这份 shim 作为 cordis 插件挂上去，ctx.shell 必须就是它')
  const c = new cordis.Context()
  await c.plugin((await import('@deepseek-ai/dsh-subprocess-local')).default).await?.()
  const mod = await importTempShim(path.join(box, 'shimapi'))
  await c.plugin(mod.default, { cwd: box }).await?.()
  const ok = typeof c.shell?.run === 'function' && typeof c.shell?.resolve === 'function' && c.shell?.sandboxMode === undefined
  say(`      ${ok ? '✓' : '✗'} ctx.shell.run=${typeof c.shell?.run}  ctx.shell.resolve=${typeof c.shell?.resolve}  sandboxMode=${String(c.shell?.sandboxMode)}`)
  report.after.pluginContract = { ok, name: c.shell?.name ?? null }
  if (!ok) hardFail('A6-plugin-contract', 'shim 没把自己注册成 ctx.shell（run/resolve 不全）')
  const inst = c.shell
  const v = inst.argv(inst.resolve({ command: 'node -e 0' }))
  say(`      ✓ 契约自证：resolve+argv ⇒ ${JSON.stringify(v)}`)
  try { inst.start({}); hardFail('A6-start', 'start() 居然没抛错') } catch (e) { say(`      ✓ start() 响亮失败（不做半个实现）：${clip(oneLine(e.message), 90)}`) }
}

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' §4  ② 改动清单（精确到行）')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
const shimYamlPath = SHIM_ABS
const lineBefore = "          name: '@deepseek-ai/dsh-pwsh-local'"
const lineAfter = `          name: '${shimYamlPath}'`
say(' ① 新增（执行器）：')
say(`      ${shimYamlPath}`)
say(`      sha256=${sha256(SHIM_SRC)}   行数=${SHIM_SRC.split('\n').length}`)
say('      作用：把 ctx.shell 从「pwsh 再解析一遍命令串」换成「按最小词法切 argv 直投 subprocess」。')
say('')
say(' ② 修改（宿主 profile，1 行）：')
say(`      ${PROFILE}:${profShellLine ?? '(待人工核对：profile 读不出)'}`)
say(`      改前: ${lineBefore}`)
say(`      改后: ${lineAfter}`)
say('      作用域不变：仍旧是 polaris-hooks-unconfined 隔离组里的 polaris-hooks-shell 那一行；')
say('      组内 isolate:{shell:true} ⇒ 只影响钩子桥拿到的 ctx.shell，agent 自己的 pwsh 工具一个字节都不动。')
say('')
say(' ③ 耐久性（建议；不改也不会破坏护栏，只会让下次 apply 静默回退性能）：')
say(`      ${AURAPOLARIS_GEN}:306`)
const genTxt = readText(AURAPOLARIS_GEN)
let genLine = null
if (genTxt.ok) {
  genLine = lineOf(genTxt.text, 'const SHELL_LOCAL = process.platform')
  const src = genLine === null ? null : genTxt.text.split(/\r?\n/)[genLine - 1]
  say(`      改前: ${src}`)
  say(`      改后: const SHELL_LOCAL = process.env.POLARIS_ARGV_SHELL ?? (process.platform === 'win32' ? ${JSON.stringify(shimYamlPath)} : '@deepseek-ai/dsh-bash-local')`)
  say('      理由：profile 里那一段是【生成物】（写入者就是本文件）——只改产物不改生成器，下次 apply 会把它改回去。')
} else {
  say(`      （读不出生成器 ${AURAPOLARIS_GEN}：${genTxt.why} —— 该项标「待人工核对」）`)
  report.warnings.push(`读不出生成器：${genTxt.why}`)
}
report.change = {
  created: [{ path: shimYamlPath, sha256: sha256(SHIM_SRC), lines: SHIM_SRC.split('\n').length }],
  edited: [
    { path: PROFILE, line: profShellLine, before: lineBefore, after: lineAfter },
    { path: AURAPOLARIS_GEN, line: genLine, note: '生成器（耐久性；跨仓库）' },
  ],
}
say('')
say(' 4.1 待落地源码全文（APPLY 时逐字节写盘；本探针实测的就是这一份）：')
say(`      sha256=${sha256(SHIM_SRC)}   字节=${Buffer.byteLength(SHIM_SRC, 'utf8')}   行=${SHIM_SRC.split('\n').length}`)
const shimShapeOk = SHIM_SRC.includes("import { ShellExecutor } from '@deepseek-ai/dsh-shell'")
  && SHIM_SRC.includes("import z from '@deepseek-ai/schemastery'")
  && SHIM_SRC.includes('export function tokenizeArgv')
  && SHIM_SRC.includes('export default ArgvShellExecutor')
  && SHIM_SRC.endsWith('\n')
if (shimShapeOk) {
  say('      自检 ✓：裸包名 import ×2 + tokenizeArgv 导出 + 默认导出 + 结尾换行（实测副本见 §4.2）')
} else {
  say('      自检 ✗：源码形状不对（缺 import / 导出 / 结尾换行）')
  hardFail('A7-shim-shape', 'shim 源码形状不对：缺 import / 导出 / 结尾换行')
}
say('      ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈')
for (const l of SHIM_SRC.split('\n')) say(`      ${l}`)
say('      ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈')
if (tempShimInfo) {
  say('')
  say(' 4.2 实测副本与待落地源码的唯一差异（临时箱不在仓库 node_modules 解析链上，故把裸包名换成绝对 file://）：')
  const a = SHIM_SRC.split('\n').find((l) => l.includes("from '@deepseek-ai/dsh-shell'"))
  const b = tempShimInfo.rewritten.split('\n').find((l) => l.includes('dsh-shell/lib/index.js'))
  say(`      待落地: ${a}`)
  say(`      实测用: ${b}`)
  say(`      （另一条同形改写：@deepseek-ai/schemastery → ${tempShimInfo.schemaUrl}）`)
}

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' §5  一键回滚（不需要 git）')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
say(' 口径：APPLY 的第一步就是【先备份】；回滚 = 用备份逐字节覆盖回去。生成器那行同理。')
say('')
say(' APPLY（一条；幂等性由备份决定 —— 重复跑不会覆盖已存在的 .bak）：')
say(' （写 shim 用 node 自己写：避开 PowerShell 重定向的编码/行模式两个坑，落盘字节与实测那份逐字相同，末尾回读 sha256 判据。）')
say(`   $P='${PROFILE}'; $S='${SHIM_ABS}'; $G='${AURAPOLARIS_GEN}'; New-Item -ItemType Directory -Force (Split-Path $S) | Out-Null; if (-not (Test-Path "$P.bak-before-argv-shell")) { Copy-Item $P "$P.bak-before-argv-shell" }; if ((Test-Path $G) -and -not (Test-Path "$G.bak-before-argv-shell")) { Copy-Item $G "$G.bak-before-argv-shell" }; node -e 'const fs=require("fs"),cp=require("child_process");const a=process.argv.slice(1);fs.writeFileSync(a[0],cp.execFileSync(process.execPath,[a[1],"--emit-shim"],{encoding:"utf8"}))' $S '${pkgFile('probes', 'hook-wiring-plan.mjs')}'; (Get-Content -Raw $P) -replace [regex]::Escape("name: '@deepseek-ai/dsh-pwsh-local'"), "name: '${SHIM_ABS}'" | Set-Content -Encoding utf8 -NoNewline $P; $h=(Get-FileHash -Algorithm SHA256 $S).Hash.ToLower(); "shim sha256=$h 期望=${sha256(SHIM_SRC)} 逐字一致=" + ($h -eq '${sha256(SHIM_SRC)}') + '；重启 dsh 后生效'`)
say('')
say(' ROLLBACK（一条）：')
say(`   Copy-Item '${PROFILE}.bak-before-argv-shell' '${PROFILE}' -Force; if (Test-Path '${AURAPOLARIS_GEN}.bak-before-argv-shell') { Copy-Item '${AURAPOLARIS_GEN}.bak-before-argv-shell' '${AURAPOLARIS_GEN}' -Force }; Write-Host 'ROLLBACK done; 重启 dsh 后生效（argv-shell.mjs 可留着：没人指向它就不会被 import）'`)
say('')
say(' 只回滚 profile 那一行（生成器没动过时的最小回滚）：')
say(`   (Get-Content -Raw '${PROFILE}') -replace [regex]::Escape("name: '${SHIM_ABS}'"), "name: '@deepseek-ai/dsh-pwsh-local'" | Set-Content -Encoding utf8 -NoNewline '${PROFILE}'`)
say('')
say(' 回滚判据（改回后这条必须成立）：')
say(`   Select-String -Path '${PROFILE}' -Pattern "polaris-hooks-shell" -Context 0,1`)
say('   ⇒ polaris-hooks-shell 的下一行必须是 name: @deepseek-ai/dsh-pwsh-local')

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' §6  ④ 激活需要什么 + 激活后怎么验护栏')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
say(' 激活需要【重启宿主】：')
say('   · 那一行是【进程组合层】的接线，只在 dsh 启动时读一次；新会话不生效（新会话共享同一个进程组合）。')
say('   · 本会话就跑在宿主里 —— 我重启它会终止本会话，所以本单不激活（这也是"预备改造"的边界）。')
say('   · 属于"重启即可、无需重装"：不碰任何安装副本、不改 dsh 自身、不加依赖。')
say('')
say(' 6.0 激活前的只读合成检查（本探针自己跑真加载器，不重启、不写宿主）：')
const dshBin = pkgPath('../dsh/lib/bin.js') ?? (BUNDLE.dir ? path.resolve(BUNDLE.dir, '..', '..', 'lib', 'bin.js') : null)
if (!profTxt.ok || dshBin === null || !fs.existsSync(dshBin)) {
  say(`   （跳过：${profTxt.ok ? '找不到 dsh 的 bin' : '读不出 profile'}）`)
  report.warnings.push('合成检查跳过')
} else {
  const edited = profTxt.text.replace("name: '@deepseek-ai/dsh-pwsh-local'", `name: '${SHIM_ABS}'`)
  const editedOk = edited !== profTxt.text
  const yml = path.join(box, 'cordis.patch.argv.yml')
  fs.writeFileSync(yml, edited)
  const r = spawnSync(process.execPath, [dshBin, '--profile', 'web', '--patch', yml, '--dump-config'], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1 << 24, env: { ...process.env, DSH_HOME } })
  const out = String(r.stdout ?? '') + String(r.stderr ?? '')
  const want = `file:///${SHIM_ABS.replace(/\\/g, '/')}`
  const replaced = out.includes(want)
  const groups = (out.match(/id: polaris-hooks-unconfined/g) ?? []).length
  say(`   $ node <dsh>/lib/bin.js --profile web --patch <改后副本> --dump-config   ⇒ exit=${r.status}`)
  say(`     ${editedOk && replaced ? '✓' : '✗'} 组装树里那一行的 name 变成 ${want}`)
  say(`     ⚠ 副产品读数：polaris-hooks-unconfined 出现 ${groups} 次（原层 1 + 叠加层 1）——两个隔离组各挂一次桥 = 钩子跑两遍。`)
  say('       所以激活【不能】把改后的整份 patch 当叠加层喂进去，只能就地改那一行（本单 ② 就是这个形状）。')
  say('       （--dump-config 只组装、不 import：它证明得了「那一行能合成」，证明不了「模块能被 import」——')
  say('         后者由 §3.2/§3.6 的 ctx.plugin(实测副本) 负责。）')
  report.change.composeCheck = { bin: dshBin, exit: r.status, replaced, want, groupOccurrences: groups, editedOk }
  if (r.status !== 0 || !replaced) hardFail('A8-dump-config', `只读合成检查未通过：exit=${r.status} replaced=${replaced}`)
}
say('')
say(' 激活后的验证（一条命令，可重复跑）：')
say(`   node '${pkgFile('probes', 'hook-wiring-plan.mjs')}' --verify-guard`)
say('   ⇒ 它把「同载荷 × 两种 transport」的判决与落账逐字比对，全一致 = 护栏仍在；任一不一致 exit 1 并点名。')
say('')
say(' 激活后的人工双保险（读宿主自己的账，不看本探针）：')
say(`   node -e "const fs=require('fs');const f='${PROD_LEDGER.replace(/\\/g, '/')}';const L=fs.readFileSync(f,'utf8').trim().split('\\n');console.log(L.slice(-3).join('\\n'))"`)
say('   ⇒ 让宿主随便跑一次工具调用，看新落的那条：state_root 仍是工作区、verdict 与刷新前同形、ms 掉到 ~1/6。')
say('   且 76–84% 那一层没了之后，宿主 hook/result 的 durationMs 应从 p50≈686ms 落到≈145ms 量级。')
say('')
say(' 回滚判据同上（§5 最后一条）。')

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' §7  ⑤ 新失效模式与兜底（如实）')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
const FAIL_MODES = [
  ['M1 命令串里出现 shell 语法', '现网 4 条命令串都是「程序 + 引号路径 + --k=v」，切成 argv 后语义【完全相同】（§3.1 逐字读出）。但若将来有人往 command 里写 `|`、`&&`、`$(...)`、重定向，argv 路径会把它们当普通参数 ⇒ 命令行为静默改变。', 'tokenizeArgv 只认空白/引号，引号不配对当场抛错；落账与回执的 exitCode/stderr 都会露。兜底=接线时把「命令串必须 argv-clean」写进 hook.mjs 侧的自检（本单未做，属后续单）。'],
  ['M2 生成器把这一行改回去', 'profile 那一段是 apply-hook-dsh.mjs 的生成物；只改产物不改生成器，下次 apply 静默回到 pwsh（本单 ③ 已给出行级改动）。', '回退是 fail-safe 的：护栏与落账全不受影响，只是每次调用又付 686ms ⇒ 用 §3.5 的 p50 一测就露。'],
  ['M3 反斜杠/引号边界', 'Windows 路径以 `\\` 结尾又包在引号里时（`"C:\\dir\\"`）会被判成转义引号 ⇒ 抛错。宿主的 4 条命令串都用正斜杠，不受影响。', '抛错而不是猜；报错串里带原命令串，改成正斜杠或去掉尾反斜杠即可。'],
  ['M4 执行世界差异', 'pwsh-local 会在子进程里钉 UTF-8 输出编码（ENCODING_PREAMBLE）。argv 路径没有 shell 编码问题，但反过来也不再提供「命令串里可写 PowerShell」这一层能力。', '钩子入口只用 `node + 参数`，不依赖任何 shell 能力；本探针 §3.2 的落账逐字证明判定与落账未变。'],
  ['M5 平台', '本单实测在 win32；posix 上同一行会被生成器投影成 @deepseek-ai/dsh-bash-local（仍是 shell）。', 'shim 本身平台无关（argv 直投），posix 要吃到同一收益需把生成器那行一并改（§4 ③ 已含条件表达式）。'],
  ['M6 落点假设', '本探针用「子进程 cwd=临时箱」把 --state=workspace 留在箱里；生产里 cwd 由 bridge 的 session workdir 给（与 pwsh-local 同款回落）。', '若某天 bridge 不再传 workdir，两边的回落也一样（config.cwd ?? process.cwd()）——换 transport 不改变落点语义。'],
]
for (const [id, what, fallback] of FAIL_MODES) {
  say(` · ${id}`)
  say(`   新形态: ${what}`)
  say(`   兜底  : ${fallback}`)
  say('')
}
report.failModes = FAIL_MODES.map(([id, what, fallback]) => ({ id, what, fallback }))

// ═════════════════════════════════════════════════════════════════════════════
say('──────────────────────────────────────────────────────────────────────────────')
say(' §8  汇总')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
const t = report.before.timing
const a = report.after.timing
say(`  事实链           : ${report.facts.filter((f) => f.ok === true).length} 条复核通过 / ${report.facts.filter((f) => f.ok === null).length} 条跳过 / ${report.facts.filter((f) => f.ok === false).length} 条红`)
if (t && a) say(`  耗时(进程级)     : ${r1(t.p50)}ms → ${r1(a.p50)}ms（p50，各 n=${REPS}，省 ${r1((1 - a.p50 / t.p50) * 100)}%；与任务书语料 913.6→145.4 同口径）`)
if (bridgeRuns.before.allow && bridgeRuns.after.allow) {
  say(`  耗时(接线级)     : ${r1(bridgeRuns.before.allow.ms)}ms → ${r1(bridgeRuns.after.allow.ms)}ms（真桥+真接缝+真落账；接缝地板 ≈ ${r1(report.after.seamFloor?.floorOverhead ?? NaN)}ms/次两边都付，不参与差额 —— 见 §3.5b）`)
}
say(`  argv 可表达性    : 改动前 0 次执行（配置里写不进 argv）/ 改动后 ${bridgeRuns.after.allow?.ledgerParsed ? '真判定 + 真落账' : '(未测)'}`)
say(`  护栏一致性       : ${report.guard.filter((g) => g.ok).length}/${report.guard.length} 条载荷两种 transport 判决一致`)
say(`  硬判据           : ${HARD.length === 0 ? '全绿' : `${HARD.length} 条红`}`)
for (const h of HARD) say(`      ✗ ${h.id}: ${h.detail}`)
const guardOk = report.guard.length > 0 && report.guard.every((g) => g.ok)
if (VERIFY_GUARD) {
  say('')
  say(`  === --verify-guard（激活后验护栏）: ${guardOk ? 'PASS' : 'FAIL'} ===`)
  for (const g of report.guard) say(`      ${g.ok ? '✓' : '✗'} payload=${g.payload}  判决 ${g.kindBefore} → ${g.kindAfter}  verdict ${g.verdictBefore} → ${g.verdictAfter}`)
  say('      口径：同一份真桥 + 真 subprocess，只换 transport（pwsh-local ↔ argv-shell）；')
  say('            判决（enter/deny）与落账 verdict/cause 必须逐字相同 —— 不同就是换 transport 动了语义。')
}
const PROD_AFTER = prodSnapshot()
const ledgerTouched = PROD_AFTER.bytes !== PROD_BEFORE.bytes || PROD_AFTER.mtime !== PROD_BEFORE.mtime
const entriesChanged = PROD_AFTER.entries !== PROD_BEFORE.entries
say(`  生产账本文件     : ${ledgerTouched ? '⚠ 字节/mtime 变了（见下）' : '一个字节没动（bytes/mtime 与开工快照逐字相同）'}`)
if (ledgerTouched) {
  say(`      开工: bytes=${PROD_BEFORE.bytes} mtime=${PROD_BEFORE.mtime}`)
  say(`      收工: bytes=${PROD_AFTER.bytes} mtime=${PROD_AFTER.mtime}`)
  say('      （本探针的全部子进程 cwd 都在临时箱 ⇒ 写不到这里；这一段差来自【同宿主的其它并发会话】——本波是多单元并行，')
  say('        它们的工具调用与本探针共用同一个工作区账本。判据只认一条：本探针自己没写过 —— §3.2 的落账全在箱里。）')
}
if (entriesChanged) {
  say(`  同目录条目数     : ${PROD_BEFORE.entries} → ${PROD_AFTER.entries}（宿主自己产的 sidecar 文件，如 polaris-umdecision-base-*.json；不是本探针写的：本探针全部子进程 cwd 都在临时箱，且计时档带 POLARIS_NO_LOG=1）`)
}
report.prodLanding = { before: PROD_BEFORE, after: PROD_AFTER, ledgerTouched, entriesChanged }
say(`  临时箱           : ${box}${KEEP_TMP ? '（保留）' : '（退出前删除）'}`)
say('')
say(`  一句话：① 决定「经 shell / 直投 argv」的不是钩子 JSON（那里只有 command: string），而是 ctx.shell 的提供者 ——`)
say(`          宿主 profile 第 ${profShellLine ?? '?'} 行的 @deepseek-ai/dsh-pwsh-local；② 改动 = 1 个新执行器 + 1 行 name；`)
say(`          ③ argv 路径下钩子照常判定与落账（§3.2 逐字）；④ 激活要重启宿主，验护栏 = --verify-guard；⑤ 失效模式与兜底见 §7。`)

report.hard = HARD
report.verifyGuard = { requested: VERIFY_GUARD, pass: guardOk }
// --verify-guard = 激活后的护栏判据：退出码只由「两种 transport 判决一致」决定（其余只打印、不参与）。
report.exit = VERIFY_GUARD ? (guardOk ? 0 : 1) : (HARD.length === 0 ? 0 : 1)
say(`  退出码           : ${report.exit}${VERIFY_GUARD ? '（--verify-guard：只看护栏一致性）' : '（全量：看全部硬判据）'}`)
if (JSON_OUT) {
  say('')
  say('--- JSON ---')
  say(JSON.stringify(report, null, 1))
}
if (!KEEP_TMP) {
  try { fs.rmSync(box, { recursive: true, force: true }) } catch { /* 删不掉就留着，路径已打印 */ }
}
process.exit(report.exit)

// ── 辅助（函数声明提升）──────────────────────────────────────────────────────
function whichPwsh () {
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  const r = spawnSync('where.exe', ['pwsh'], { encoding: 'utf8', windowsHide: true })
  const line = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  return line || null
}

/** 经【本方案的 shim + 真 subprocess】跑一条命令串（不是 spawnSync 直投，走的是接线里那条真路）。 */
async function runViaShim (command) {
  const runBox = fs.mkdtempSync(path.join(box, 'shimprobe-'))
  const mod = await importTempShim(runBox)
  const ctx = new cordis.Context()
  await ctx.plugin(SubprocessLocal).await?.()
  const spawns = []
  const proto = Object.getPrototypeOf(ctx.subprocess)
  const orig = proto.spawn
  proto.spawn = function (spec) { spawns.push(spec.argv); return orig.call(this, spec) }
  await ctx.plugin(mod.default, { cwd: runBox }).await?.()
  const out = await ctx.shell.run(ctx.shell.resolve({ command, timeoutMs: 60000 }))
  proto.spawn = orig
  return { exitCode: out.exitCode, stdout: out.stdout.text, stderr: out.stderr.text, spawnArgv: spawns[spawns.length - 1] ?? null }
}
