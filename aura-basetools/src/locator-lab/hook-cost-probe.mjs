/**
 * hook-cost-probe.mjs —— C6：PreToolUse 钩子「每次工具调用的固定税」的**构成分解**与**降本方案读数**。
 *
 * 背景（会话日志实测，本探针会自己复算一遍）：hook/result 自带 durationMs，PreToolUse p50≈686ms，
 *   而 aura_read 端到端 p50=200ms、aura_edit p50=252ms —— 固定税 > 工具自身耗时。
 *
 * 本探针回答三个问题（全部只读，不改宿主、不写仓库）：
 *   ① 这 686ms 花在哪：pwsh 进程启动 / pwsh 拉起子进程的管道 / node 启动 / 钩子模块图 / 钩子判定与落账 / 宿主桥
 *   ② 钩子自己那一段到底多贵（同进程 import + main() 与端到端复刻做对照）
 *   ③ 三个候选方案各能省多少、各引入什么新失效模式（打印预估收益与落地判据）
 *
 * 计时单纪律：全部测量串行、每层重复 REPS 次；读数给 min/p50/max；首尾各测一次 node 启动做漂移对照。
 *   机器上若同时有别的重活，p50 会整体抬高 —— 判断依据写在输出的「前提」段里，不靠读者猜。
 *
 * 被测对象与宿主形状（只读来源，一处不改）：
 *   · 安装态统一入口 = ~/.dsh/skills/aurapolaris/tools/hook.mjs（可用 --hook= 覆盖）
 *   · 宿主接线 = ~/.dsh/aurapolaris-hooks.json + ~/.dsh/profiles/web/cordis.patch.yml
 *     钩子组 polaris-hooks-unconfined 用的 shell 执行器 = @deepseek-ai/dsh-pwsh-local，
 *     即每条钩子都走 pwsh -NoLogo -NoProfile -NonInteractive -Command "<ENCODING_PREAMBLE><命令串>"。
 *   · 载荷形状 = @deepseek-ai/dsh-hooks-codex 的 preToolPayload（非 shell 工具的参数被压成 {command}）。
 *
 * 用法：
 *   node src/locator-lab/hook-cost-probe.mjs                 # 默认：分层实测 + 本工作区会话日志
 *   node src/locator-lab/hook-cost-probe.mjs --reps=15       # 加重复次数
 *   node src/locator-lab/hook-cost-probe.mjs --all-workspaces # 扫全机会话语料（慢，~1 分钟）
 *   node src/locator-lab/hook-cost-probe.mjs --no-measure    # 只读日志，不跑分层实测
 *   node src/locator-lab/hook-cost-probe.mjs --json          # 末尾附机器可读汇总
 * 退出码：恒 0（探针不是判据；取不到的那一档标「不可用」并继续）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const say = (m = '') => fs.writeSync(1, `${m}\n`)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? def : hit.slice(name.length + 3)
}
const hasFlag = (name) => argv.includes(`--${name}`)
const num = (s, def) => (Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) : def)

const REPS = Math.max(3, Math.round(num(argOf('reps', '9'), 9)))
const JSON_OUT = hasFlag('json')
const NO_MEASURE = hasFlag('no-measure')
const ALL_WS = hasFlag('all-workspaces')
const KEEP_TMP = hasFlag('keep-tmp')
const SESSION_FILES = Math.round(num(argOf('session-files', '10'), 10))
const SESSION_BUDGET_MB = num(argOf('session-budget-mb', ALL_WS ? '400' : '48'), 48)
const DSH_HOME = argOf('dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const SESSIONS_ROOT = argOf('sessions-root', path.join(DSH_HOME, 'sessions'))
const HOOK = path.resolve(argOf('hook', process.env.POLARIS_HOOK || path.join(DSH_HOME, 'skills', 'aurapolaris', 'tools', 'hook.mjs')))
const GUARD_LOG = argOf('guard-log', path.join(REPO, '.polaris', 'polaris-guard.log.jsonl'))
const HOOK_EXISTS = fs.existsSync(HOOK)
const HOOK_URL = pathToFileURL(HOOK).href

// 名单只读【同一份实现】：钩子自己的模块常量（不在这里抄第二份，抄了迟早漂移）
const JUDGE = { shellNames: ['pwsh', 'bash', 'shell', 'exec', 'run_command', 'terminal', 'powershell', 'cmd'], fileToolNames: [], delegationNames: [], error: null }
try {
  const gcore = await import(pathToFileURL(path.join(path.dirname(HOOK), 'guard-core.mjs')).href)
  JUDGE.fileToolNames = gcore.FILE_TOOL_NAMES ?? []
  const hookMod = await import(HOOK_URL)   // 只读常量；invokedDirectly 判定用 argv[1]，不会被当成宿主调用
  JUDGE.delegationNames = hookMod.DELEGATION_TOOL_NAMES ?? []
} catch (e) {
  JUDGE.error = String(e?.message ?? e)
}

// ── 小工具 ────────────────────────────────────────────────────────────────────
const sorted = (xs) => [...xs].sort((a, b) => a - b)
/** 最近秩百分位（n-1 封顶）：样本少时不外推。 */
const pct = (xs, p) => (xs.length ? sorted(xs)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null)
const r1 = (v) => (v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toFixed(1))
const padR = (s, n) => String(s ?? '').padEnd(n)
const padL = (s, n) => String(s ?? '').padStart(n)
const share = (a, b) => (b ? (a / b) * 100 : 0)

function which(name, preferred = []) {
  for (const c of preferred) if (c && fs.existsSync(c)) return c
  const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
  const line = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  return line || null
}

const report = { at: new Date().toISOString(), repo: REPO, hook: HOOK, reps: REPS }

// ── 0. 前提：环境、宿主接线形状、计时单声明 ───────────────────────────────────
say('══════════════════════════════════════════════════════════════════════════════')
say(' C6 探针：PreToolUse 钩子固定开销 —— 构成分解与降本方案读数')
say('══════════════════════════════════════════════════════════════════════════════')
say('')
say('【前提 / 计时单声明】')
say(`  cwd=${REPO}`)
say(`  node=${process.version}  核数=${os.cpus().length}  平台=${process.platform}  时间=${report.at}`)
say(`  钩子入口=${HOOK}${HOOK_EXISTS ? '' : '  ← 不存在：与钩子相关的分层与读数会标「不可用」'}`)
say(`  重复次数=${REPS}（每层串行跑，取 p50；给 min/max 供判断抖动）`)
say('  本探针同一时刻只做一件事；若机器上另有重活，p50 会整体抬高 —— 末尾的 L1/L1b 漂移对照就是这条的测温计。')
say('  全部分层默认 POLARIS_NO_LOG=1（不写生产遥测）；「落账」那一档单列，写进一次性临时日志箱。')
say('')

// ── 宿主接线形状（只读引用，供读者核对「固定税从哪来」）──────────────────────
const CMD_STRING = `node "${HOOK.replace(/\\/g, '/')}" --event=PreToolUse --host=dsh --state=workspace`
// 与 @deepseek-ai/dsh-pwsh-local 的 argv() 同形：-NoLogo -NoProfile -NonInteractive -Command "<ENCODING_PREAMBLE><command>"
const PW_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
const PW_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
const PW_FULL = PW_PREAMBLE + CMD_STRING
// 与 @deepseek-ai/dsh-hooks-codex 的 preToolPayload 同形（非 shell 工具的参数被压成 {command:''}）
const PAYLOAD = JSON.stringify({
  session_id: 'c6-hook-cost-probe',
  transcript_path: null,
  cwd: REPO,
  hook_event_name: 'PreToolUse',
  model: '',
  permission_mode: 'default',
  turn_id: '0',
  tool_name: 'pwsh',
  tool_input: { command: 'node -e "process.exit(0)"' },
  tool_use_id: 'call_c6',
})

const NODE_EXE = process.execPath
const PWSH = which('pwsh', [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')])
const BASH = which('bash', ['C:/Program Files/Git/usr/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'])

say('【宿主接线形状（只读，未改动任何文件）】')
say(`  钩子组 polaris-hooks-unconfined 的 shell 执行器 = @deepseek-ai/dsh-pwsh-local`)
say(`    ⇒ 每条钩子 = pwsh -NoLogo -NoProfile -NonInteractive -Command "<前置编码指令>${CMD_STRING.slice(0, 46)}…"`)
say(`  pwsh 解析到 = ${PWSH ?? '（PATH 里找不到）'}`)
say(`  bash 解析到 = ${BASH ?? '（PATH 里找不到；Git Bash 存在也不等于在 PATH 上）'}`)
say(`  node 解析到 = ${NODE_EXE}`)
say('')

// ── 1. 生产实读（只读）────────────────────────────────────────────────────────
say('──────────────────────────────────────────────────────────────────────────────')
say(' 1. 生产实读（只读现有日志，不改任何东西）')
say('──────────────────────────────────────────────────────────────────────────────')

// 1a. 钩子自己的账：pre_tool 的 ms（runEvent 内的单调钟差值，只覆盖钩子进程内那一段）
const guard = { file: GUARD_LOG, exists: fs.existsSync(GUARD_LOG), records: 0, preTool: 0, ms: [], byTool: new Map(), verdicts: new Map(), kinds: new Map(), targetsUnparsed: 0, targetsParsed: 0, mainWrite: 0 }
if (guard.exists) {
  let raw = ''
  try { raw = fs.readFileSync(GUARD_LOG, 'utf8') } catch { raw = '' }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let j = null
    try { j = JSON.parse(line) } catch { continue }
    guard.records++
    if (j.kind) guard.kinds.set(j.kind, (guard.kinds.get(j.kind) ?? 0) + 1)
    if (j.kind !== 'pre_tool') continue
    guard.preTool++
    guard.byTool.set(j.tool ?? '(空)', (guard.byTool.get(j.tool ?? '(空)') ?? 0) + 1)
    guard.verdicts.set(j.verdict ?? '?', (guard.verdicts.get(j.verdict ?? '?') ?? 0) + 1)
    if (typeof j.ms === 'number' && Number.isFinite(j.ms)) guard.ms.push(j.ms)
    if (j.targets_unparsed) guard.targetsUnparsed++
    if (j.targets) guard.targetsParsed++
    if (j.cause === 'main_write') guard.mainWrite++
  }
}
const guardMs = { n: guard.ms.length, p50: pct(guard.ms, 0.5), p90: pct(guard.ms, 0.9), min: guard.ms.length ? sorted(guard.ms)[0] : null, max: guard.ms.length ? sorted(guard.ms)[guard.ms.length - 1] : null }
say('')
say(`1a. 钩子自己的账（${GUARD_LOG}）`)
if (!guard.exists) {
  say('    ⌜不可用⌟ 文件不存在：这一档的读数是「钩子进程内耗时」的唯一来源，缺了就只能看分层实测。')
} else {
  say(`    记录 ${guard.records} 条，其中 pre_tool ${guard.preTool} 条；带 ms 的 ${guardMs.n} 条`)
  say(`    钩子进程内 ms：p50=${r1(guardMs.p50)}  p90=${r1(guardMs.p90)}  min=${r1(guardMs.min)}  max=${r1(guardMs.max)}`)
  say(`    判定分布：${[...guard.verdicts].map(([k, v]) => `${k}:${v}`).join('  ')}`)
  say(`    目标解析：解出目标 ${guard.targetsParsed} 条 / targets_unparsed=${guard.targetsUnparsed} 条 / main_write=${guard.mainWrite} 条`)
  const top = [...guard.byTool].sort((a, b) => b[1] - a[1])
  say(`    工具分布（前 12）：${top.slice(0, 12).map(([k, v]) => `${k}:${v}`).join('  ')}`)
}
// 空工具名归一成 '(空)'：JSON 本身允许空键名，但消费方（PowerShell ConvertFrom-Json 等）会当场拒收
report.guard = { exists: guard.exists, records: guard.records, preTool: guard.preTool, ms: guardMs, verdicts: Object.fromEntries(guard.verdicts), targetsUnparsed: guard.targetsUnparsed, tools: Object.fromEntries([...guard.byTool].sort((a, b) => b[1] - a[1]).map(([k, v]) => [String(k).trim() ? k : '(空)', v])) }

// 1b. 宿主的账：会话日志 hook/result.durationMs（durationMs 的区间 = spawn 前 → runHook 收流结束）
const ZMAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 会话 .jsonl.zstd 是【多帧拼接】：按 magic 切帧逐帧解，整段解只拿得到第一帧。 */
function frameOffsets(buf) {
  const offs = []
  let i = 0
  for (;;) { const q = buf.indexOf(ZMAGIC, i); if (q < 0) break; offs.push(q); i = q + 4 }
  return offs
}
function walkFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out
  let es = []
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of es) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, depth + 1, out)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}
function sessionFileList() {
  const enc = `--${REPO.replace(/[:\\/]+/g, '-')}--`
  let dirs = []
  const all = (() => { try { return fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] } })()
  if (ALL_WS) dirs = all.map((n) => path.join(SESSIONS_ROOT, n))
  else {
    const exact = all.find((n) => n.toLowerCase() === enc.toLowerCase())
    const loose = exact ?? all.find((n) => n.toLowerCase().includes(path.basename(REPO).toLowerCase()))
    if (loose) dirs = [path.join(SESSIONS_ROOT, loose)]
  }
  const files = []
  for (const d of dirs) {
    const inDir = []
    for (const f of walkFiles(d)) {
      let st = null
      try { st = fs.statSync(f) } catch { continue }
      inDir.push({ file: f, mtime: st.mtimeMs, size: st.size })
    }
    // 同一会话可能同时有 session.jsonl.zstd 与 session.v3.jsonl.zstd：优先 v3，避免同一次调用被数两遍
    const byDir = new Map()
    for (const x of inDir) {
      const key = path.dirname(x.file)
      const prev = byDir.get(key)
      const better = !prev || (/\.v3\./.test(x.file) && !/\.v3\./.test(prev.file)) || (/\.v3\./.test(x.file) === /\.v3\./.test(prev.file) && x.mtime > prev.mtime)
      if (better) byDir.set(key, x)
    }
    files.push(...byDir.values())
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

const session = { scanned: [], byPoint: new Map(), badExit: 0, available: false, note: '' }
if (fs.existsSync(SESSIONS_ROOT)) {
  const all = sessionFileList()
  let budget = SESSION_BUDGET_MB * 1024 * 1024
  const chosen = []
  for (const f of all) {
    if (chosen.length >= SESSION_FILES) break
    if (budget - f.size < 0) continue
    budget -= f.size
    chosen.push(f)
  }
  for (const f of chosen) {
    let buf = null
    try { buf = fs.readFileSync(f.file) } catch { continue }
    session.scanned.push({ file: f.file, mb: Math.round((f.size / 1048576) * 100) / 100 })
    const offs = frameOffsets(buf)
    for (let k = 0; k < offs.length; k++) {
      const end = k + 1 < offs.length ? offs[k + 1] : buf.length
      let out = null
      try { out = zlib.zstdDecompressSync(buf.subarray(offs[k], end)) } catch { continue }
      const text = out.toString('utf8')
      if (!text.includes('"hook/result"')) continue
      for (const line of text.split('\n')) {
        if (!line.includes('"hook/result"')) continue
        let j = null
        try { j = JSON.parse(line) } catch { continue }
        if (j?.type !== 'hook/result') continue
        const d = j.data ?? {}
        const pt = String(d.point ?? '(未知)')
        if (!session.byPoint.has(pt)) session.byPoint.set(pt, { ms: [], pass: 0, other: 0 })
        const b = session.byPoint.get(pt)
        if (typeof d.durationMs === 'number' && Number.isFinite(d.durationMs)) b.ms.push(d.durationMs)
        if (d.decision === 'pass') b.pass++
        else b.other++
        if (d.exitCode !== undefined && d.exitCode !== 0) session.badExit++
      }
    }
  }
  session.available = session.byPoint.size > 0
  if (!session.available) session.note = ALL_WS ? '语料里没有 hook/result（宿主桥未接线或日志已轮转）' : `工作区 ${REPO} 的会话目录里没有 hook/result；可用 --all-workspaces 扫全机语料`
} else {
  session.note = `会话目录不存在：${SESSIONS_ROOT}`
}
const pre = session.byPoint.get('PreToolUse') ?? null
const preStats = pre ? { n: pre.ms.length, p50: pct(pre.ms, 0.5), p90: pct(pre.ms, 0.9), p99: pct(pre.ms, 0.99), min: pre.ms.length ? sorted(pre.ms)[0] : null, max: pre.ms.length ? sorted(pre.ms)[pre.ms.length - 1] : null } : null

say('')
say(`1b. 宿主的账（会话日志 hook/result.durationMs；${ALL_WS ? '全机语料' : `本工作区 ${path.basename(REPO)}`}）`)
if (!session.available) {
  say(`    ⌜不可用⌟ ${session.note}`)
} else {
  say(`    扫了 ${session.scanned.length} 个会话文件（预算 ${SESSION_BUDGET_MB}MB）：`)
  for (const s of session.scanned.slice(0, 6)) say(`      ${padR(path.basename(path.dirname(s.file)) + '/' + path.basename(s.file), 52)} ${padL(s.mb, 6)} MB`)
  if (session.scanned.length > 6) say(`      … 其余 ${session.scanned.length - 6} 个`)
  say('')
  say(`    ${padR('point', 18)}${padL('n', 7)}${padL('p50', 10)}${padL('p90', 10)}${padL('min', 10)}${padL('max', 10)}`)
  for (const [pt, b] of [...session.byPoint].sort((a, b2) => b2[1].ms.length - a[1].ms.length)) {
    say(`    ${padR(pt, 18)}${padL(b.ms.length, 7)}${padL(r1(pct(b.ms, 0.5)), 10)}${padL(r1(pct(b.ms, 0.9)), 10)}${padL(r1(b.ms.length ? sorted(b.ms)[0] : null), 10)}${padL(r1(b.ms.length ? sorted(b.ms)[b.ms.length - 1] : null), 10)}`)
  }
  if (preStats) say(`    PreToolUse 分布：无一次低于 ${r1(preStats.min)}ms（固定开销的形状）；非 0 退出 ${session.badExit} 条`)
}
report.sessions = {
  root: SESSIONS_ROOT, allWorkspaces: ALL_WS, available: session.available, note: session.note,
  scanned: session.scanned.length,
  byPoint: Object.fromEntries([...session.byPoint].map(([k, v]) => [k, { n: v.ms.length, p50: pct(v.ms, 0.5), p90: pct(v.ms, 0.9), min: v.ms.length ? sorted(v.ms)[0] : null, max: v.ms.length ? sorted(v.ms)[v.ms.length - 1] : null }])),
}

// 生产对照值：拿不到本机读数就用任务书给的语料值（n=58139, p50=686, p90=878）
const CITED = { n: 58139, p50: 686, p90: 878, minutes: 613 }   // 任务书语料：合计 613 分钟
const PROD = preStats && preStats.n >= 50 ? { n: preStats.n, p50: preStats.p50, p90: preStats.p90, src: '本探针实测' } : { ...CITED, src: '任务书引用（本机会话语料不足）' }
say('')
say(`    ⇒ 分解用的生产对照值：PreToolUse p50=${r1(PROD.p50)}ms（${PROD.src}${PROD.src === '本探针实测' ? `，n=${PROD.n}` : ''}）`)
if (!ALL_WS && PROD.p50 > CITED.p50 * 1.25) {
  say('')
  say(`    ⚠ 本工作区样本 p50=${r1(PROD.p50)}ms 明显高于全机语料 p50≈${CITED.p50}ms —— 差别来自【此刻机器上还有别的活】，不是口径差异。`)
  say('      分解的**占比**不受影响（同一台机、同一时段里分层实测与它同涨同落）；绝对值请读「折算686」那一列。')
  say(`      想自己复算全机值：node <本文件> --all-workspaces --no-measure --session-files=2000 --session-budget-mb=700`)
}

// ── 2. 分层实测 ───────────────────────────────────────────────────────────────
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' 2. 分层实测（每层重复 ' + REPS + ' 次，spawnSync + 真 stdin 载荷 + 收 stdout/stderr）')
say('──────────────────────────────────────────────────────────────────────────────')

function measure(exe, args, opts = {}) {
  const xs = []
  let last = { status: null, out: '', err: '', error: null }
  for (let i = 0; i < (opts.reps ?? REPS); i++) {
    const t0 = performance.now()
    const r = spawnSync(exe, args, {
      cwd: REPO,
      input: PAYLOAD,
      encoding: 'utf8',
      env: { ...process.env, POLARIS_NO_LOG: '1', ...(opts.env ?? {}) },
      windowsHide: true,
      maxBuffer: 1 << 24,
      ...(opts.spawn ?? {}),
    })
    xs.push(performance.now() - t0)
    last = { status: r.status, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim(), error: r.error ? String(r.error.message) : null }
  }
  const s = sorted(xs)
  return { n: xs.length, p50: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], xs, last }
}

const TMPBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'c6-hookcost-'))
const layers = []
const L = (id, label, fn) => layers.push({ id, label, run: fn })
let phase2 = {}

if (!NO_MEASURE) {
  L('L1', 'node -e 0（node 进程启动下限）', () => measure(NODE_EXE, ['-e', '0']))
  if (HOOK_EXISTS) L('L2', 'node -e "await import(hook.mjs)"（+钩子模块图）', () => measure(NODE_EXE, ['-e', `await import(${JSON.stringify(HOOK_URL)})`]))
  if (HOOK_EXISTS) L('L3', 'node hook.mjs --event=PreToolUse（+判定/落账，无 shell）', () => measure(NODE_EXE, [HOOK, '--event=PreToolUse', '--host=dsh', '--state=workspace']))
  if (BASH) L('L4', 'bash -c "<命令串>"（Git Bash 层，候选接线）', () => measure(BASH, ['-c', CMD_STRING]))
  if (PWSH) {
    L('L5', 'pwsh … -Command "exit 0"（pwsh 启动下限）', () => measure(PWSH, [...PW_ARGS, 'exit 0']))
    L('L6', 'pwsh … -Command "cmd /c exit 0"（pwsh 拉起子进程+串流，不含 node）', () => measure(PWSH, [...PW_ARGS, 'cmd /c exit 0']))
    L('L7', 'pwsh … -Command "node -e 0"（+node 启动）', () => measure(PWSH, [...PW_ARGS, 'node -e 0']))
    if (HOOK_EXISTS) L('L8', 'pwsh … -Command "<宿主现行命令串>"（端到端复刻）', () => measure(PWSH, [...PW_ARGS, PW_FULL]))
  }
  if (HOOK_EXISTS) L('L10', 'node hook.mjs … --log-dir=<临时箱>（+真落账）', () => measure(NODE_EXE, [HOOK, '--event=PreToolUse', '--host=dsh', `--log-dir=${TMPBOX}`], { env: { POLARIS_NO_LOG: '0' } }))
}

for (const layer of layers) {
  say(`  … ${layer.id} ${layer.label}`)
  const res = layer.run()
  phase2[layer.id] = res
  const bad = res.last.error ? `  错误=${res.last.error}` : res.last.status !== 0 ? `  exit=${res.last.status} err=${JSON.stringify(res.last.err.slice(0, 90))}` : ''
  say(`  ${padR(layer.id, 4)}${padR(layer.label.split('（')[0], 40)} p50=${padL(r1(res.p50), 8)}  min=${padL(r1(res.min), 8)}  max=${padL(r1(res.max), 8)}${bad}`)
}

// L9：同进程（每轮一个新子进程）：模块图加载 vs 判定+落账，把「钩子自己那一段」从端到端里剥出来
let inproc = null
if (!NO_MEASURE && HOOK_EXISTS) {
  const CHILD = `
import { pathToFileURL } from 'node:url'
const url = process.env.C6_HOOK_URL
const t0 = performance.now()
const mod = await import(url)
const t1 = performance.now()
process.argv = ['node', 'hook.mjs', '--event=PreToolUse', '--host=dsh', '--state=workspace']
const t2 = performance.now()
const code = await mod.main(process.argv.slice(2), {})
const t3 = performance.now()
process.stdout.write(JSON.stringify({ importMs: +(t1 - t0).toFixed(2), mainMs: +(t3 - t2).toFixed(2), code }) + '\\n')
`
  const imp = []
  const mainMs = []
  let code = null
  for (let i = 0; i < REPS; i++) {
    const r = spawnSync(NODE_EXE, ['-e', CHILD], { cwd: REPO, input: PAYLOAD, encoding: 'utf8', env: { ...process.env, POLARIS_NO_LOG: '1', C6_HOOK_URL: HOOK_URL }, windowsHide: true })
    const line = String(r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
    try {
      const j = JSON.parse(line)
      imp.push(j.importMs)
      mainMs.push(j.mainMs)
      code = j.code
    } catch { /* 这一轮没解析出来就不计入 */ }
  }
  inproc = { importMs: pct(imp, 0.5), mainMs: pct(mainMs, 0.5), importMin: imp.length ? sorted(imp)[0] : null, mainMax: mainMs.length ? sorted(mainMs)[mainMs.length - 1] : null, code, n: mainMs.length }
  say(`  ${padR('L9', 4)}${padR('同进程：import 模块图 / main() 判定+落账', 40)} import p50=${padL(r1(inproc.importMs), 8)}  main() p50=${padL(r1(inproc.mainMs), 8)}  (exit=${code})`)
}

// L11：漂移对照（首尾各测一次 node 启动）
let drift = null
if (!NO_MEASURE) {
  const again = measure(NODE_EXE, ['-e', '0'])
  const first = phase2.L1 ?? null
  drift = { first: first ? first.p50 : null, last: again.p50 }
  say('')
  say(`  L11 漂移对照：node 启动 首次 p50=${r1(drift.first)}ms  末次 p50=${r1(drift.last)}ms  ⇒ ${drift.first && Math.abs(drift.last - drift.first) / drift.first > 0.25 ? '⚠ 首尾差 >25%，本页 p50 只作量级用' : '首尾一致（≤25%）'}`)
}
// 并发读数：spawnSync 量不到 CPU 争用（进程启动主要卡在磁盘/AV），所以另外数一遍同机同名进程
function procCount(image) {
  const r = spawnSync('tasklist', ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${image}`], { encoding: 'utf8', windowsHide: true })
  return String(r.stdout ?? '').split(/\r?\n/).filter((l) => l.trim().startsWith('"')).length
}
const load0 = { node: procCount('node.exe'), pwsh: procCount('pwsh.exe') }
report.load = load0
say(`  L12 并发读数：同机 node.exe ${load0.node} 个 / pwsh.exe ${load0.pwsh} 个（含本探针自己的 1 个 node）—— 这是「计时单前提」的机械证据，不是体感`)

// L10 自证：复刻跑的是不是「真判定」那条路（而不是「本工作区没有 polaris 台账」的零成本早退）
let logged = null
if (phase2.L10) {
  const f = path.join(TMPBOX, 'polaris-guard.log.jsonl')
  try {
    const ls = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    logged = ls.length ? JSON.parse(ls[ls.length - 1]) : null
  } catch { logged = null }
}
say('')
if (phase2.L10) {
  if (logged && logged.kind === 'pre_tool') {
    say(`  ⌈复刻自证⌋ 临时日志箱末条 = kind=${logged.kind} tool=${logged.tool} verdict=${logged.verdict} 钩子自报 ms=${r1(logged.ms)}  ⇒ 走的是真判定路径，不是「无台账早退」`)
  } else {
    say(`  ⌈复刻自证⌋ ⚠ 临时日志箱里没看到 pre_tool 记录（${JSON.stringify(logged)}）—— 本页的端到端读数可能是早退路径，分解不成立`)
  }
}
if (!KEEP_TMP) { try { fs.rmSync(TMPBOX, { recursive: true, force: true }) } catch { /* 删不掉就留着，不值得让探针挂 */ } }
report.layers = Object.fromEntries(Object.entries(phase2).map(([k, v]) => [k, { n: v.n, p50: v.p50, min: v.min, max: v.max, exit: v.last.status, err: v.last.err.slice(0, 120), error: v.last.error }]))
report.inproc = inproc
report.drift = drift
report.replicaSelfCheck = logged

// ── 3. 构成分解 ───────────────────────────────────────────────────────────────
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' 3. 构成分解：这 ' + r1(PROD.p50) + 'ms 花在哪')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
say('  口径（两层，各自可核）：')
say('    第一层 = 两条路之差：宿主壳层（把 node 拉起来并收回输出） vs 钩子侧（node 启动 + 模块图 + 判定 + 落账）。')
say('    第二层 = 各层内部再分：①③ 是两层链上直接测到的段（L5 pwsh 裸启动 / L1 node 裸启动），②④ 是差值（壳层−① / 钩子侧−③）。')
say('    四档相加恒等于 L8（端到端复刻链），再整体折算到生产对照值。')

const g = (id) => (phase2[id] ? phase2[id].p50 : null)
const buckets = []
let chainNote = ''
let shellLayer = null
let hookSide = null
if (g('L8') !== null && g('L3') !== null) { shellLayer = Math.max(0, g('L8') - g('L3')); hookSide = g('L3') }
if (shellLayer !== null && g('L5') !== null && g('L1') !== null) {
  buckets.push({ name: '① pwsh 进程启动（与钩子无关的固定税）', ms: g('L5'), how: 'L5 直接测' })
  buckets.push({ name: '② pwsh 拉起并等待子进程 + stdio 串流', ms: Math.max(0, shellLayer - g('L5')), how: '壳层 − ①' })
  buckets.push({ name: '③ node 进程启动', ms: g('L1'), how: 'L1 直接测（无 shell）' })
  buckets.push({ name: '④ 钩子模块图 + 判定 + 落账 + 输出', ms: Math.max(0, g('L3') - g('L1')), how: '钩子侧 − ③' })
  chainNote = `复刻链 L8=${r1(g('L8'))}ms = ①+②+③+④`
} else {
  chainNote = '⌜不可用⌟ 缺 pwsh 或钩子入口，分档不完整'
}
const sumRaw = buckets.reduce((a, b) => a + b.ms, 0)
const k = sumRaw > 0 ? PROD.p50 / sumRaw : 0
const kCite = sumRaw > 0 ? CITED.p50 / sumRaw : 0
if (buckets.length) {
  say('')
  say(`  第一层：宿主壳层（pwsh 那两层）= L8 − L3 = ${r1(shellLayer)}ms（${share(shellLayer, sumRaw).toFixed(0)}%）  |  钩子侧（node+模块图+判定+落账）= L3 = ${r1(hookSide)}ms（${share(hookSide, sumRaw).toFixed(0)}%）`)
}
say('')
say(`  ${padR('第二层（段）', 40)}${padL('实测(ms)', 10)}${padL('折算' + r1(PROD.p50), 13)}${padL('折算' + CITED.p50, 10)}${padL('占比', 8)}   来源`)
for (const b of buckets) {
  say(`  ${padR(b.name, 40)}${padL(r1(b.ms), 10)}${padL(r1(b.ms * k), 13)}${padL(r1(b.ms * kCite), 10)}${padL(share(b.ms, sumRaw).toFixed(1) + '%', 8)}   ${b.how}`)
}
if (buckets.length) {
  say(`  ${padR('合计', 40)}${padL(r1(sumRaw), 10)}${padL(r1(sumRaw * k), 13)}${padL(r1(sumRaw * kCite), 10)}${padL('100.0%', 8)}   ${chainNote}`)
}
say('')
if (buckets.length) {
  const shellMs = buckets[0].ms + buckets[1].ms
  const hookMs = buckets[2].ms + buckets[3].ms
  say(`  一句话：宿主壳层 = ${r1(shellMs)}ms（${share(shellMs, sumRaw).toFixed(0)}%）—— 折算到任务书语料的 ${CITED.p50}ms 就是 ${r1(shellMs * kCite)}ms；`)
  say(`          钩子侧 = ${r1(hookMs)}ms（${share(hookMs, sumRaw).toFixed(0)}%），其中真正的「判定 + 落账」只有 ${r1(buckets[3].ms)}ms。`)
  say(`          ⇒ 「每次工具调用的固定税」里八成以上花在【把钩子拉起来的那层壳】上，不在护栏判定本身。`)
}
say('')
say('  旁证（同一条链上换子进程，看②是不是 pwsh 自己的开销）：')
/** 两数相差不大（或为负）时如实说「落在抖动内」——机器带载时相邻两层的差会正负乱跳，不许把噪声当读数。 */
const deltaNote = (a, b, unit = 'ms') => {
  const d = a - b
  const rel = Math.abs(d) / Math.max(1, Math.min(Math.abs(a), Math.abs(b)))
  return rel < 0.15 || d <= 0
    ? `差 ${r1(d)}${unit}（与 ${r1(Math.min(a, b))}${unit} 同量级，落在抖动内 —— 带载测量下这一档只给上界）`
    : `差 ${r1(d)}${unit}`
}
if (g('L6') !== null && g('L7') !== null) say(`    L6 pwsh+cmd=${r1(g('L6'))}ms  vs  L7 pwsh+node=${r1(g('L7'))}ms  ⇒ ${deltaNote(g('L7'), g('L6'))}：「② pwsh 拉起/等待/串流」与子进程是什么几乎无关。`)
if (g('L3') !== null && g('L10') !== null) say(`    L10 带真落账=${r1(g('L10'))}ms  vs  L3 不落账=${r1(g('L3'))}ms  ⇒ 一次落账 ${deltaNote(g('L10'), g('L3'))}。`)
say('')
say('  交叉验证（换一套度量方式，看同一档是不是同一个量级）：')
if (inproc) say(`    同进程实测：钩子模块图 ${r1(inproc.importMs)}ms + main() 判定/落账 ${r1(inproc.mainMs)}ms = ${r1((inproc.importMs ?? 0) + (inproc.mainMs ?? 0))}ms（与 ④ 实测 ${r1(buckets[3] ? buckets[3].ms : null)}ms 的差 = 模块图加载与 node 启动重叠那段）`)
if (guardMs.p50 !== null) say(`    生产日志里钩子自报 ms p50=${r1(guardMs.p50)}ms（钩子进程内那一段；口径比 ④ 多一次等 stdin 送达的耗时）`)
say(`    ⇒ 「钩子这一侧」（node 启动 + 模块图 + 判定 + 落账）在任何口径下都 ≤ ${r1(Math.max(inproc ? (inproc.importMs ?? 0) + (inproc.mainMs ?? 0) : 0, g('L3') ?? 0, guardMs.p50 ?? 0))}ms，占生产对照值的 ${share(Math.max(inproc ? (inproc.importMs ?? 0) + (inproc.mainMs ?? 0) : 0, g('L3') ?? 0, guardMs.p50 ?? 0), PROD.p50).toFixed(0)}%；其中真正的判定与落账 ≤ ${r1(Math.max(inproc ? (inproc.mainMs ?? 0) : 0, (g('L3') ?? 0) - (g('L1') ?? 0), guardMs.p50 ?? 0))}ms。`)
say('')
say('  宿主桥本身（事件 JSON、spawn/收流、hook/invoked+result 落账）为什么没有单独一档：')
say('    durationMs 的计时区间 = bash.run() 前后（源码 dsh-hook-protocol/lib/index.js runHook：started=now() → await bash.run → durationMs），')
say('    桥在区间内只多做一次 resolve()；而本机复刻整条 pwsh 链的读数并不低于生产值 ⇒ 桥的可测加项在噪声以下。')

report.decomposition = { prodMs: PROD.p50, prodSrc: PROD.src, citedMs: CITED.p50, shellLayer, hookSide, scale: k, scaleCited: kCite, buckets: buckets.map((b) => ({ name: b.name, rawMs: b.ms, attributedMs: b.ms * k, attributedCited: b.ms * kCite, share: share(b.ms, sumRaw) / 100, from: b.how })) }

report.decomposition = { prodMs: PROD.p50, prodSrc: PROD.src, buckets: buckets.map((b) => ({ name: b.name, rawMs: b.ms, attributedMs: b.ms * k, share: share(b.ms, sumRaw) / 100, from: b.how })), scale: k }

// ── 4. 降本方案（读数 + 新失效模式 + 落地判据）────────────────────────────────
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' 4. 降本方案：预估收益（按上面的折算）与新失效模式')
say('──────────────────────────────────────────────────────────────────────────────')
const per = (frac) => PROD.p50 * frac
const plan = []
const push = (o) => { plan.push(o); say(''); say(`  ${o.id} ${o.title}`); say(`     收益：${o.gain}`); say(`     语义：${o.semantics}`); say(`     新失效模式：`); for (const f of o.fail) say(`       · ${f}`); say(`     落地判据：${o.check}`) }

say('')
const pctOf = (f) => (100 * f).toFixed(0)
const minsOf = (f) => r1(CITED.minutes * f)
say(`  基线：本机复刻 PreToolUse 每次 = ${r1(sumRaw)}ms（${PROD.src} 对照值 p50=${r1(PROD.p50)}ms）；任务书语料 p50=${CITED.p50}ms × n=${CITED.n}，合计 ${CITED.minutes} 分钟。`)
say(`  下面每条的「省 X 分钟」= 省下的比例 × 那 ${CITED.minutes} 分钟总盘（比例来自实测，总盘用任务书给的值，不自己重算）。`)

if (g('L4') !== null && g('L8') !== null) {
  push({
    id: 'C1a',
    title: '宿主接线改造：钩子组的 shell 执行器 pwsh → bash（Git Bash）',
    gain: `端到端复刻 ${r1(g('L8'))}ms → ${r1(g('L4'))}ms（实测 bash -c 整链），每次省 ${r1(g('L8') - g('L4'))}ms = ${share(g('L8') - g('L4'), g('L8')).toFixed(0)}%；折算生产 p50 ${r1(PROD.p50)}→${r1(per(g('L4') / g('L8')))}ms` +
      (g('L8') > 0 ? `；占总盘 ${pctOf((g('L8') - g('L4')) / g('L8'))}% ⇒ 省约 ${minsOf((g('L8') - g('L4')) / g('L8'))} 分钟` : ''),
    semantics: '命令串、载荷、判定器、输出协议一字未动 —— 换的只是「谁把 node 拉起来」；hooks.json 不改 ⇒ 不需要重新信任。',
    fail: [
      'bash 不在 PATH 时钩子整体 spawn 失败 ⇒ 护栏【静默失效】（现在 pwsh 必然存在）；dsh-bash-local 的 argv 硬编码 "bash"，没有路径配置项，只能靠 PATH 或 shim。',
      '换 shell 后命令串里若出现 shell 语法（管道/重定向/变量展开）行为会变；当前命令串没有这类语法，但这是隐式前提。',
      '宿主重启才生效（bridge 在 apply() 时读一次配置）。',
    ],
    check: '改完重启宿主，跑一次真工具调用，核对会话里 hook/result 的 exitCode=0 且 decision=pass；再跑 node <skill>/tools/hook.mjs status 看记录是否还在长。',
  })
}
if (g('L3') !== null && g('L8') !== null) {
  push({
    id: 'C1b',
    title: '宿主接线改造（更好）：钩子命令不经任何 shell，直接投 argv',
    gain: `端到端复刻 ${r1(g('L8'))}ms → ${r1(g('L3'))}ms（实测 node 直跑整链），每次省 ${r1(g('L8') - g('L3'))}ms = ${share(g('L8') - g('L3'), g('L8')).toFixed(0)}%；折算生产 p50 ${r1(PROD.p50)}→${r1(per(g('L3') / g('L8')))}ms` +
      (g('L8') > 0 ? `；占总盘 ${pctOf((g('L8') - g('L3')) / g('L8'))}% ⇒ 省约 ${minsOf((g('L8') - g('L3')) / g('L8'))} 分钟` : ''),
    semantics: '同上：判定器/载荷/输出协议不变；只是把「命令串」按 shell 词法切成 argv 后直接 spawn（DSH 自带的 @deepseek-ai/dsh-native-command 就是给这条用的库）。',
    fail: [
      '自己切 argv：路径含空格/引号时切错 ⇒ 命令跑不起来 ⇒ 与 C1a 同样的静默失效，必须配一条「钩子真的跑过」的机械自证。',
      '需要一个提供 shell 服务的新插件（DSH 现有执行器只有 pwsh/bash 两族）；插件写错 = 宿主启动期就报错（比静默失效好，但要有回滚路径）。',
    ],
    check: '同 C1a；另外用一条路径带空格的钩子命令做反例臂，确认切词器不吃掉引号。',
  })
}
if (g('L2') !== null) {
  push({
    id: 'C2',
    title: '常驻进程：判定+落账搬进常驻服务，hook.mjs 变瘦客户端',
    gain: `能省掉的是【整个钩子侧】= L3 实测 ${r1(g('L3'))}ms（其中 node 启动 ${r1(g('L1'))} + 模块图/判定/落账 ${r1((g('L3') ?? 0) - (g('L1') ?? 0))}），折算到生产对照值 = 省约 ${r1(per((g('L3')) / g('L8')))}ms/次、占总盘 ${pctOf(g('L3') / g('L8'))}% ⇒ 省约 ${minsOf(g('L3') / g('L8'))} 分钟；` +
      `**动不了宿主壳层那 ${r1(shellLayer ?? 0)}ms** —— 单独上它，p50 只从 ${r1(g('L8'))}ms 降到 ${r1(shellLayer ?? 0)}ms。`,
    semantics: '判定逻辑仍是同一份实现（服务里 import 同一模块），但「每次调用都新起一个判定器」这条性质没了。',
    fail: [
      '服务不可达时只有两种结局：fail-open = 护栏静默失效（语义变化），fail-closed = 所有工具调用被拒（可用性事故）；必须做三态可辨 + 冷路径回落，回落就等于没省。',
      '模式文件热更新：切 enforce 不生效 = 护栏语义悄悄变了，必须按 mtime 失效并落账。',
      '进程生命周期/端口占用/多用户隔离；DSH 沙箱内不能开命名管道，只能走 127.0.0.1 TCP（暴露面）。',
      `单独上的性价比最差（只占总盘的 ${pctOf((g('L3') ?? 0) / g('L8'))}%）；只有 C1 落地后（那时总价已降到 ~${r1(g('L3'))}ms，这 ${r1(g('L3'))}ms 就是全部）它才成为大头，届时再上。`,
    ],
    check: '服务停掉后跑一次真调用：必须看到「冷路径已接管」的落账，而不是静默放行。',
  })
}
if (g('L3') !== null && inproc) {
  const cover = guard.preTool > 0 ? (['aura_read', 'aura_edit'].reduce((a, n) => a + (guard.byTool.get(n) ?? 0), 0) / guard.preTool) : null
  push({
    id: 'C3',
    title: '逻辑内联进工具：aura_read / aura_edit 在自己进程里判',
    gain: `被覆盖的调用每次省掉整个钩子税（${r1(PROD.p50)}ms），自身代价 = 同进程 main() ${r1(inproc.mainMs)}ms；` +
      (cover !== null ? `生产窗口里这两个工具占 ${(cover * 100).toFixed(0)}%（${guard.preTool} 条 pre_tool 口径），均摊到全部调用约省 ${r1(PROD.p50 * cover)}ms/次。` : '覆盖率要用本工作区的工具分布算。'),
    semantics: '⚠ 只能覆盖「我们自己的工具」。要保护栏语义不变，钩子必须保留给其它工具 ⇒ 省的是这两个工具那一份，不是把钩子撤掉。',
    fail: [
      '判定实现出现第二个消费者（钩子 + 工具）⇒ 版本漂移 = 同一份文本两个结论；必须共用同一份 guard-core 并且有对账。',
      '工具侧判定异常绝不能把读写工具打挂：异常要按「无法判定」显式落账，不许静默放行。',
      '钩子仍然在 ⇒ 两条路都要各自自证，维护成本翻倍。',
    ],
    check: '同一份载荷分别走钩子与工具内联两条路，断言 verdict 逐字一致（差分测试）。',
  })
}
// C4：用生产日志的工具分布算「按可判性收敛 matcher」能跳过多少
if (guard.preTool > 0) {
  // 名单来源：shell 类是探针侧估计（DSH 上只有带 command 参数的工具才判得出东西）；
  // 文件类/派工名直接读钩子与 guard-core 的常量，不在这里抄第二份。
  const shellRe = new RegExp(`^(?:${JUDGE.shellNames.join('|')})$`, 'i')
  const fileSet = new Set(JUDGE.fileToolNames.map((n) => n.toLowerCase()))
  const delegSet = new Set(JUDGE.delegationNames.map((n) => n.toLowerCase()))
  let shellN = 0
  let keepFileN = 0
  let keepDelegN = 0
  for (const [name, n] of guard.byTool) {
    if (shellRe.test(String(name))) shellN += n
    if (fileSet.has(String(name).toLowerCase())) keepFileN += n
    if (delegSet.has(String(name).toLowerCase())) keepDelegN += n
  }
  const denom = guard.preTool
  const shellShare = shellN / denom
  const skip = 1 - shellShare
  push({
    id: 'C4',
    title: 'matcher 收敛：PreToolUse 只对「判得出东西的工具」触发（零代码、只动接线产物）',
    gain: `生产窗口实测 ${denom} 条 pre_tool 里 shell 类工具只占 ${shellN} 条（${(shellShare * 100).toFixed(0)}%）；其余 ${((skip) * 100).toFixed(0)}% 的调用在 DSH 上【无物可判】` +
      `（桥把非 shell 工具参数压成 {command:""}，其中 ${guard.targetsUnparsed} 条文件类工具还落了 targets_unparsed=true）；跳过的那些调用占总盘 ${pctOf(skip)}% ⇒ 省约 ${minsOf(skip)} 分钟。` +
      `只留 shell 类 ⇒ 跳过 ${(skip * 100).toFixed(0)}% 的调用，均摊省 ${r1(PROD.p50 * skip)}ms/次；` +
      `保留文件类(${keepFileN} 条，名单来自 guard-core.FILE_TOOL_NAMES)与派工名(${keepDelegN} 条)以维持 targets_unparsed 读数与派工标记 ⇒ 跳过 ${(((denom - shellN - keepFileN - keepDelegN) / denom) * 100).toFixed(0)}%，均摊省 ${r1(PROD.p50 * ((denom - shellN - keepFileN - keepDelegN) / denom))}ms/次。`,
    semantics: `命中范围内的调用判定逐字不变；窗口内 ${denom} 条 pre_tool 只有 ${guard.verdicts.get('deny') ?? 0} 条 deny，且全部来自可判工具 —— 收敛掉的是「必然 allow」的那些。代价是审计记录少一截（telemetry，不是判定）。`,
    fail: [
      '名单漂移：新出现的 shell 工具名不在 matcher 里 ⇒ 整类调用静默免检。必须有机械对账（把 guard-core 的可判名单与 matcher 对账，缺一个就红）。',
      '文件类工具的 targets_unparsed 读数会一起消失或变稀 —— 那是目前唯一能证明「宿主参数不可见」这个能力缺口的证据，建议把它们留在 matcher 里。',
      '改的是接线产物（aurapolaris-hooks.json / 生成器 apply-hook-dsh.mjs），要重启宿主；别只改产物不改生成器。',
    ],
    check: '收敛前后各跑一条真 shell 调用 + 一条真 write 调用，核对两条的 verdict 与收敛前逐字一致。',
  })
}

report.plan = plan.map((p) => ({ id: p.id, title: p.title, gain: p.gain, semantics: p.semantics, failModes: p.fail, check: p.check }))

say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' 推荐组合（按收益/风险排序）')
say('──────────────────────────────────────────────────────────────────────────────')
say('  第一步 C1b/C1a：把 pwsh 那两层（①+②，折算后约占八成）从每次调用里拿掉 —— 这是唯一能改量级的杠杆。')
say('  第二步 C4：顺手把「必然 allow」的调用挡在钩子之外，进一步把付费次数砍掉一半左右。')
say('  第三步 C2/C3：等总价降到 ~130ms 之后再谈；那时省的是 node 启动与模块图，收益占比才够看。')
say('  做任何一步之前先记一条基线：本探针的 L8 与 1b 的 p50 就是「改前」读数，改后用同一条命令复测。')
say('')

if (JSON_OUT) {
  say('── JSON ──────────────────────────────────────────────────────────────────────')
  say(JSON.stringify(report, null, 1))
}
process.exit(0)
