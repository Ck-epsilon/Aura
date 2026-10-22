#!/usr/bin/env node
// =============================================================================
// aura-tools/probes/hook-activation-check.mjs —— C27：钩子接线【激活件】落地验收
//
// 【这是什么】三件事，一条命令全跑完：
//   段A 落地件：仓库里那份 `aura-tools/dsh/argv-shell.mjs` 存在、语法通过、**真实 import 一次**、
//        并与生成它的探针 `--emit-shim` 输出【逐字节一致】；现网 4 条钩子命令串在它下面切成 argv 后语义不变。
//   段B 暂存演练：在一份**假 DSH_HOME**（%TEMP% 里的暂存目录）里把宿主 profile 复制一份，应用那一行改动、
//        断言这一行确实变了（并且只变了这一行）、按回滚办法还原、断言 sha256 **逐字节**回到原值；
//        再跑一次只读 `--dump-config` 证明改后那一行真的进组合树。
//   段C 交割单：把「激活一条命令 / 回滚一条命令 / 激活需要什么（给证据）/ 激活后怎么验护栏」逐字打出来。
//   段D 失效模式：复核 C25 的 M1–M6，并补 M7–M9。
//
// 【为什么】C25 把机制查清了、把 shim 在临时箱里实测跑通了，但那份 shim 当时【还没落进仓库】，
//   所以「落地后真 import 一次」这道冒烟没有读数。本探针就是补这一格 + 把激活/回滚做成可复审的读数。
//
// 【怎么复跑】node aura-tools/probes/hook-activation-check.mjs              # 全量（默认）
//            node aura-tools/probes/hook-activation-check.mjs --json       # 末尾附机器可读 JSON
//            node aura-tools/probes/hook-activation-check.mjs --keep-stage # 保留暂存目录（默认退出前删）
//            node aura-tools/probes/hook-activation-check.mjs --dsh-home=<dir> --profile=<yml> --shim=<mjs>
//   退出码：0 = 全部硬判据通过 / 1 = 有硬判据红（逐条点名）/ 2 = 用法错。
//
// 【怎么关掉】本探针**不激活**：它从不写 `<DSH_HOME>` 下的任何文件（真 profile 只读，字节/mtime 对账），
//   全部写盘都发生在 %TEMP% 的一次性暂存目录里，且每一次写盘都先过写入守卫（见 §0.3）。
//   宿主正在运行（本会话就跑在里面），激活要改那一行 —— 那件事交给操作者，命令在 §C 逐字给出。
//
// 【边界（如实声明）】
//   · 本探针只覆盖「落地件可加载 + 那一行可应用可还原」；桥级语义（判定/落账是否随 transport 变）
//     是 C25 `--verify-guard` 的判据，本探针不重复它的读数，只把它当激活后验证命令打印。
//   · 暂存演练用的 profile 是**副本**：副本改了不会影响运行中的宿主（宿主监视的是真路径，见 M8）。
//   · `--dump-config` 只组装、不 import：它证明「那一行能进组合树」，证明不了「模块能被 import」——
//     后者由段A 的真实 import 负责。两件事都必须成立，所以两条都跑。
//   · 硬判据依赖 [A] 仓库内 argv-shell.mjs、[B] 真 profile 字节、[C] 真 pwsh。
//     `--dump-config` 那一段依赖 [D] 找得到 dsh 的 bin：找不到只告警不判红（可移植性）。
// =============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { pkgPath } from '../build/pkg-root.mjs'

const say = (m = '') => fs.writeSync(1, `${m}\n`)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? def : hit.slice(name.length + 3)
}
const has = (name) => argv.includes(`--${name}`)

if (has('help')) {
  say('用法: node aura-tools/probes/hook-activation-check.mjs [--json] [--keep-stage]')
  say('      [--dsh-home=<dir>] [--profile=<cordis.patch.yml>] [--hooks-json=<file>] [--shim=<argv-shell.mjs>]')
  say('      [--emitter=<hook-wiring-plan.mjs>] [--generator=<apply-hook-dsh.mjs>]')
  process.exit(0)
}
const KNOWN = ['json', 'keep-stage', 'help', 'dsh-home', 'profile', 'hooks-json', 'shim', 'emitter', 'generator']
const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN.includes(a.replace(/^--/, '').split('=')[0]))
if (unknown.length > 0) {
  say(`用法错：未知参数 ${unknown.join(' ')}`)
  say('（--help 看用法）')
  process.exit(2)
}
const KEEP_STAGE = has('keep-stage')
const JSON_OUT = has('json')

const DSH_HOME = path.resolve(argOf('dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const PROFILE = path.resolve(argOf('profile', path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')))
const HOOKS_JSON = path.resolve(argOf('hooks-json', path.join(DSH_HOME, 'aurapolaris-hooks.json')))
const SHIM = path.resolve(argOf('shim', pkgPath('dsh', 'argv-shell.mjs')))
const EMITTER = path.resolve(argOf('emitter', pkgPath('probes', 'hook-wiring-plan.mjs')))
const GENERATOR = path.resolve(argOf('generator', 'E:\\workspaces\\AuraPolaris\\tools\\apply-hook-dsh.mjs'))

/** 宿主现行那一行的值（改动前）。 */
const OLD_LINE = "name: '@deepseek-ai/dsh-pwsh-local'"
/** 改动后那一行的值（单引号 YAML 标量 —— 见 M7，引号种类是安全边界的一部分）。 */
const NEW_LINE = `name: '${SHIM}'`
/** 只读合成检查的判据串：组装树里那一行会被规范成 file:// URL。 */
const NEW_URL = `file:///${SHIM.replace(/\\/g, '/')}`

// ── 小工具 ────────────────────────────────────────────────────────────────────
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex')
const sha256buf = (b) => crypto.createHash('sha256').update(b).digest('hex')
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => (String(s).length <= n ? String(s) : `${String(s).slice(0, n)}…(+${String(s).length - n})`)
const padR = (s, n) => String(s ?? '').padEnd(n)
const relRepo = (p) => (path.resolve(p).startsWith(REPO) ? path.relative(REPO, path.resolve(p)).split(path.sep).join('/') : String(p))

function readText (file) {
  try { return { ok: true, text: fs.readFileSync(file, 'utf8') } } catch (e) { return { ok: false, why: oneLine(e?.message ?? e) } }
}
/** 1-based 行号；找不到返回 null。 */
function lineOf (text, needle) {
  const i = text.indexOf(needle)
  return i < 0 ? null : text.slice(0, i).split('\n').length
}
function countOf (text, needle) {
  let n = 0
  let i = text.indexOf(needle)
  while (i >= 0) { n++; i = text.indexOf(needle, i + needle.length) }
  return n
}
/** 文件快照：字节数 + sha256 + mtime。读不出就 exists:false（拿它做「一个字节没动」的对账）。 */
function snapFile (file) {
  try {
    const b = fs.readFileSync(file)
    const st = fs.statSync(file)
    return { exists: true, bytes: b.length, sha256: sha256buf(b), mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString() }
  } catch (e) { return { exists: false, why: oneLine(e?.message ?? e) } }
}
/** 目录快照：每个条目的名字/类型/字节/sha（只列一层，不递归 —— 避开 node_modules）。 */
function snapDir (dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return { name: e.name, kind: 'dir', link: e.isSymbolicLink() ? 'link' : null }
      const s = snapFile(p)
      return { name: e.name, kind: 'file', bytes: s.bytes, sha256: s.sha256 }
    }).sort((a, b) => (a.name < b.name ? -1 : 1))
  } catch (e) { return { error: oneLine(e?.message ?? e) } }
}
const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── 判据骨架 ──────────────────────────────────────────────────────────────────
const HARD = []
const WARN = []
const hardFail = (id, detail) => { HARD.push({ id, detail }); say(`  ✗ 硬判据红 ${id}: ${detail}`) }
const warn = (id, detail) => { WARN.push({ id, detail }); say(`  ⚠ ${id}: ${detail}`) }
const okLine = (ok) => (ok ? '✓' : '✗')

// ── §0.3 写入守卫：本探针的每一次写盘都必须落在暂存目录里 ─────────────────────
const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'c27-activation-'))
const WRITES = []
const GUARD_HITS = []
/** 断言在任何写盘之前调用；返回绝对路径方便直接串进 fs.* 调用。 */
function stageWrite (p, what) {
  const abs = path.resolve(p)
  if (abs === DSH_HOME || abs.startsWith(DSH_HOME + path.sep)) {
    GUARD_HITS.push({ path: abs, what })
    throw new Error(`写入守卫：拒绝对 DSH_HOME 下的路径写盘（${what}）：${abs}`)
  }
  if (abs !== STAGE && !abs.startsWith(STAGE + path.sep)) {
    throw new Error(`写入守卫：本探针只允许写暂存目录（${STAGE}），拒绝（${what}）：${abs}`)
  }
  WRITES.push({ path: abs, what, stageRelative: path.relative(STAGE, abs).split(path.sep).join('/') })
  return abs
}

// ── 执行器：真 pwsh / 真 node ─────────────────────────────────────────────────
function whichPwsh () {
  const r = spawnSync('where.exe', ['pwsh'], { encoding: 'utf8', windowsHide: true })
  const first = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (first && fs.existsSync(first)) return first
  for (const c of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')]) {
    if (fs.existsSync(c)) return c
  }
  return null
}
const PWSH = whichPwsh()
function runPwsh (cmd) {
  if (PWSH === null) return { status: null, stdout: '', stderr: 'pwsh 不可用' }
  return spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1 << 24,
  })
}
function findDshBin () {
  const r = spawnSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true })
  const first = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (first) {
    const cand = path.join(path.dirname(first), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(cand)) return { bin: cand, via: `where.exe dsh -> ${first}` }
  }
  const repo = path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(repo)) return { bin: repo, via: '仓库 node_modules（兜底）' }
  return { bin: null, via: '找不到（where.exe dsh 与仓库 node_modules 都没有）' }
}

// ── 待演练的两条 APPLY 形态 + 一条 ROLLBACK（三条都是【一条命令】）────────────
/** 主形态：显式 UTF-8 无 BOM 写回（不依赖 PowerShell 版本的 -Encoding 语义）。 */
const applyCmd = (P, S) => [
  `$P='${P}'; $S='${S}'`,
  `if (-not (Test-Path "\${P}.bak-before-argv-shell")) { Copy-Item $P "\${P}.bak-before-argv-shell" }`,
  `$t=[IO.File]::ReadAllText($P)`,
  `$n=$t.Replace("${OLD_LINE}", "name: '$S'")`,
  `if ($n -eq $t) { throw 'APPLY: 目标行没有变化（profile 里已经不是那一行？）' }`,
  `[IO.File]::WriteAllText($P, $n, [Text.UTF8Encoding]::new($false))`,
  `Select-String -Path $P -Pattern 'polaris-hooks-shell' -Context 0,1`,
].join('; ')
/** 对照形态：C25 §5 那条（Get-Content -Raw + -replace + Set-Content -NoNewline），在 PS7 下同效。 */
const applyCmdB = (P, S) => [
  `$P='${P}'; $S='${S}'`,
  `if (-not (Test-Path "\${P}.bak-before-argv-shell")) { Copy-Item $P "\${P}.bak-before-argv-shell" }`,
  `(Get-Content -Raw $P) -replace [regex]::Escape("${OLD_LINE}"), "name: '$S'" | Set-Content -Encoding utf8 -NoNewline $P`,
  `Select-String -Path $P -Pattern 'polaris-hooks-shell' -Context 0,1`,
].join('; ')
/** 回滚：备份逐字节覆盖回去，再回读 sha256。 */
const rollbackCmd = (P) => [
  `$P='${P}'`,
  `Copy-Item "\${P}.bak-before-argv-shell" "$P" -Force`,
  `(Get-FileHash -Algorithm SHA256 "$P").Hash.ToLower()`,
].join('; ')

// ═════════════════════════════════════════════════════════════════════════════
say('══════════════════════════════════════════════════════════════════════════════')
say(' C27 钩子接线激活件验收 —— 落仓件 / 暂存往返 / 激活与回滚交割单 / 失效模式')
say('══════════════════════════════════════════════════════════════════════════════')
say('')
say(` 仓库     : ${REPO}`)
say(` 落地件   : ${relRepo(SHIM)}`)
say(` DSH_HOME : ${DSH_HOME}`)
say(` 真 profile: ${PROFILE}`)
say(` pwsh     : ${PWSH ?? '(不可用)'}`)
say(` 暂存目录 : ${STAGE}${KEEP_STAGE ? '（保留）' : '（退出前删除）'}`)
say(' 口径     : 本探针不激活 —— 真 profile 与 hooks.json 全程只读，写盘只在暂存目录（§0.3 守卫）。')

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' 段A  ① 落地件：落仓 + 语法 + 【真实 import】+ 与 --emit-shim 逐字节一致')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
const report = { at: new Date().toISOString(), repo: REPO, node: process.version, stage: STAGE, A: {}, B: {}, C: {}, D: {}, hard: [], warn: [] }

// A1 存在
const shimStat = snapFile(SHIM)
say(` A1 存在性：${relRepo(SHIM)}`)
say(`      ${okLine(shimStat.exists)} ${shimStat.exists ? `bytes=${shimStat.bytes}  sha256=${shimStat.sha256}` : `读不出：${shimStat.why}`}`)
if (!shimStat.exists) hardFail('A1-exists', `仓库里没有落地件：${SHIM}`)
report.A.exists = shimStat

// A2 语法
const checkRun = shimStat.exists ? spawnSync(process.execPath, ['--check', SHIM], { encoding: 'utf8', windowsHide: true }) : { status: null, stderr: '跳过（文件不存在）' }
say(' A2 语法：$ node --check ' + relRepo(SHIM))
say(`      ${okLine(checkRun.status === 0)} exit=${checkRun.status}${checkRun.status === 0 ? '' : `  stderr=${clip(oneLine(checkRun.stderr), 160)}`}`)
if (checkRun.status !== 0) hardFail('A2-syntax', `node --check exit=${checkRun.status}`)
report.A.syntax = { exit: checkRun.status }

// A3 真实 import（本单补的那一格冒烟）
const req = createRequire(SHIM)
let shimMod = null
let shimImportErr = null
try { shimMod = await import(pathToFileURL(SHIM).href) } catch (e) { shimImportErr = oneLine(e?.message ?? e) }
let shellMod = null
let shellResolved = null
let shellImportErr = null
try {
  shellResolved = req.resolve('@deepseek-ai/dsh-shell')
  shellMod = await import(pathToFileURL(shellResolved).href)
} catch (e) { shellImportErr = oneLine(e?.message ?? e) }
const schemaResolved = (() => { try { return req.resolve('@deepseek-ai/schemastery') } catch { return null } })()
const schemaPkg = (() => { try { return req.resolve('@deepseek-ai/schemastery/package.json') } catch { return null } })()
const schemaVersion = schemaPkg === null ? null : (() => { try { return JSON.parse(fs.readFileSync(schemaPkg, 'utf8')).version } catch { return null } })()

say(' A3 真实 import（在仓库内、按落地件自己的解析链，不是临时箱）：')
say(`      $ node -e "await import('${pathToFileURL(SHIM).href}')"`)
say(`      ${okLine(shimMod !== null)} import ${shimMod === null ? `失败：${shimImportErr}` : '成功'}`)
let protoOk = false
let tokenizeOk = false
let argvSample = null
if (shimMod !== null) {
  protoOk = shellMod !== null && Object.getPrototypeOf(shimMod.default) === shellMod.ShellExecutor
  tokenizeOk = typeof shimMod.tokenizeArgv === 'function'
  const sample = 'node "C:/Users/cxk/.dsh/skills/aurapolaris/tools/hook.mjs" --event=PreToolUse --host=dsh --state=workspace'
  try { argvSample = shimMod.tokenizeArgv(sample) } catch (e) { argvSample = `throw: ${oneLine(e?.message ?? e)}` }
  say(`      ✓ 默认导出 = ${typeof shimMod.default} ${shimMod.default?.name ?? ''}；具名导出 tokenizeArgv = ${typeof shimMod.tokenizeArgv}`)
  say(`      ${okLine(protoOk)} 继承自【同一个】ShellExecutor 模块实例（protoIsShellExecutor=${protoOk}）`)
  say(`      ✓ static inject = ${JSON.stringify(shimMod.default?.inject)}`)
  say(`      ✓ 行为冒烟 tokenizeArgv(现网命令串) = ${JSON.stringify(argvSample)}`)
  say(`      ✓ 两条裸包名 import 的解析结果（落地件所在目录的解析链）：`)
  say(`          @deepseek-ai/dsh-shell     → ${shellResolved ?? `解析失败：${shellImportErr}`}`)
  say(`          @deepseek-ai/schemastery   → ${schemaResolved ?? '解析失败'}${schemaVersion === null ? '' : `（v${schemaVersion}）`}`)
      const inRepo = shellResolved !== null && path.resolve(shellResolved).startsWith(REPO + path.sep)
      const realpath = (() => { try { return fs.realpathSync(shellResolved) } catch { return null } })()
      say(`          落点：物理路径 = ${realpath ?? '(读不出)'}`)
      say(`          ${inRepo ? '在仓库 node_modules 内' : '字面在仓库 node_modules 下，但整个 @deepseek-ai 目录是宿主安装的联接 ⇒ realpath 落到宿主那一份字节（与宿主加载的是同一个模块实例）'}；本判据只认「能加载 + 是同一个 ShellExecutor」。`)
}
if (shimMod === null) hardFail('A3-import', `真实 import 失败：${shimImportErr}`)
else {
  if (!tokenizeOk) hardFail('A3-tokenize', '落地件没有导出 tokenizeArgv')
  if (!protoOk) hardFail('A3-superclass', `默认导出不是同一个 ShellExecutor 的子类（shellMod=${shellMod !== null}）`)
  if (!Array.isArray(argvSample) || argvSample.length !== 5 || argvSample[0] !== 'node') {
    hardFail('A3-behavior', `tokenizeArgv 对现网命令串的读数不对：${JSON.stringify(argvSample)}`)
  }
}
report.A.import = { ok: shimMod !== null, protoOk, tokenizeOk, argvSample, shellResolved, schemaResolved, schemaVersion, error: shimImportErr }

// A4 与 --emit-shim 逐字节一致（落地 = 取生成器输出，不许手抄）
const emitRun = spawnSync(process.execPath, [EMITTER, '--emit-shim'], { maxBuffer: 1 << 26, windowsHide: true })
const emitBuf = Buffer.isBuffer(emitRun.stdout) ? emitRun.stdout : Buffer.from(emitRun.stdout ?? '')
const emitSha = sha256buf(emitBuf)
const diskBuf = shimStat.exists ? fs.readFileSync(SHIM) : Buffer.alloc(0)
const diskSha = sha256buf(diskBuf)
say(' A4 逐字节：$ node ' + relRepo(EMITTER) + ' --emit-shim  vs  仓库文件')
say(`      emit-shim : bytes=${emitBuf.length}  sha256=${emitSha}  exit=${emitRun.status}`)
say(`      仓库文件  : bytes=${diskBuf.length}  sha256=${diskSha}`)
const bytesEqual = emitBuf.length === diskBuf.length && emitBuf.equals(diskBuf)
say(`      ${okLine(bytesEqual)} 逐字节一致=${bytesEqual}`)
if (!bytesEqual || emitRun.status !== 0) hardFail('A4-byte-fidelity', `落地件与 --emit-shim 输出不一致（emit exit=${emitRun.status}）`)

// A5 落地版 vs C25 临时箱实测版的唯一差异（两条 import）
const shimText = shimStat.exists ? diskBuf.toString('utf8') : ''
const bareShell = shimText.includes("import { ShellExecutor } from '@deepseek-ai/dsh-shell'")
const bareSchema = shimText.includes("import z from '@deepseek-ai/schemastery'")
const noAbsRewrite = !/from 'file:\/\/\//.test(shimText)
say(' A5 落地版形状：')
say(`      ${okLine(bareShell && bareSchema && noAbsRewrite)} 两条 import 都是仓库内可解析的裸包名（临时箱实测版是绝对 file://，落地版改回裸包名）`)
say(`      ${okLine(shimText.endsWith('\n'))} 结尾换行；导出行 = ${shimText.split('\n').filter((l) => l.startsWith('export')).map((l) => clip(l, 40)).join(' / ')}`)
if (!(bareShell && bareSchema && noAbsRewrite)) hardFail('A5-shim-shape', '落地件的 import 形状不是裸包名/或残留 file:// 改写')
report.A.emit = { emitBytes: emitBuf.length, emitSha256: emitSha, diskBytes: diskBuf.length, diskSha256: diskSha, bytesEqual }

// A6 现网命令串 argv-clean（M1 的前提，用【落地后的真模块】判）
const hooksTxt = readText(HOOKS_JSON)
const cmdStrings = []
if (hooksTxt.ok) {
  try {
    const j = JSON.parse(hooksTxt.text)
    for (const [event, groups] of Object.entries(j.hooks ?? {})) {
      for (const g of groups ?? []) for (const h of g.hooks ?? []) if (typeof h.command === 'string') cmdStrings.push({ event, command: h.command })
    }
  } catch (e) { warn('A6-parse', `hooks.json 解析失败：${oneLine(e?.message ?? e)}`) }
} else {
  warn('A6-read', `读不出 ${HOOKS_JSON}：${hooksTxt.why}`)
}
say(' A6 现网命令串在 argv 路径下的形状（M1 的前提，逐条机器判据）：')
const META = ['|', '&', ';', '$', '>', '<', '`', '%', '(', ')', '\n']
const cmdRows = []
if (cmdStrings.length === 0) {
  say('      （跳过：没读到命令串）')
} else if (shimMod === null) {
  say('      （跳过：落地件没 import 成功）')
} else {
  for (const { event, command } of cmdStrings) {
    let toks = null
    let err = null
    try { toks = shimMod.tokenizeArgv(command) } catch (e) { err = oneLine(e?.message ?? e) }
    const meta = err === null ? toks.filter((t) => META.some((m) => t.includes(m))) : []
    const clean = err === null && toks[0] === 'node' && meta.length === 0 && toks.every((t) => !/\\\s*$/.test(t))
    cmdRows.push({ event, tokens: toks, meta, ok: clean, error: err })
    say(`      ${okLine(clean)} ${padR(event, 18)} argv=[${(toks ?? []).join(' ')}]${err === null ? '' : `  抛错：${err}`}`)
  }
  const allClean = cmdRows.every((r) => r.ok)
  say(`      ⇒ ${cmdRows.filter((r) => r.ok).length}/${cmdRows.length} 条命令串「程序 + 引号路径 + --k=v」，不含任何 shell 元字符 ⇒ 换 argv 路径后语义逐字不变`)
  if (!allClean) hardFail('A6-argv-clean', `有 ${cmdRows.filter((r) => !r.ok).length} 条命令串在 argv 路径下形状不对`)
}
report.A.commands = cmdRows

// A7 否定对照：argv 路径【不再】解释元字符（证明 A6 的「语义不变」不是碰巧）
if (shimMod !== null) {
  let injected = null
  let unbalancedThrew = false
  try { injected = shimMod.tokenizeArgv("node -e \"process.stdout.write('X')\" ; Write-Output INJECTED") } catch { /* 见下 */ }
  try { shimMod.tokenizeArgv('node "C:\\dir\\"') } catch { unbalancedThrew = true }
  const noSplit = Array.isArray(injected) && injected.includes(';') && injected.includes('Write-Output') && injected.includes('INJECTED')
  say('')
  say(' A7 否定对照（同一条命令串，两种 transport 的差别就在这里）：')
  say(`      ${okLine(noSplit)} "…; Write-Output INJECTED" ⇒ argv 里 \`;\` 是【普通参数】，不再被当语句分隔符`)
  say(`          ${JSON.stringify(injected)}`)
  say(`      ${okLine(unbalancedThrew)} 反斜杠结尾 + 收尾引号（"C:\\dir\\"）⇒ 当场抛错（不猜一个"大概是这个意思"的 argv，M3 兜底）`)
  if (!noSplit || !unbalancedThrew) hardFail('A7-negative-control', `否定对照不成立（noSplit=${noSplit} unbalancedThrew=${unbalancedThrew}）`)
  report.A.negative = { noSplit, unbalancedThrew, injected }
}

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' 段B  ③ 暂存演练：应用 → 断言那一行变了 → 回滚 → sha256 逐字节回到原值')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
const B0_PROFILE = snapFile(PROFILE)
const B0_HOOKS = snapFile(HOOKS_JSON)
const B0_DIR = snapDir(path.dirname(PROFILE))
const profTxt0 = readText(PROFILE)
const oldCount = profTxt0.ok ? countOf(profTxt0.text, OLD_LINE) : 0
say(` B0 真 profile（只读快照）：${PROFILE}`)
say(`      exists=${B0_PROFILE.exists}  bytes=${B0_PROFILE.bytes}  sha256=${B0_PROFILE.sha256}`)
say(`      mtime=${B0_PROFILE.mtime}  那一行出现次数=${oldCount}（第 ${profTxt0.ok ? lineOf(profTxt0.text, OLD_LINE) : '?'} 行）`)
say(`      目录条目=${Array.isArray(B0_DIR) ? B0_DIR.length : '?'}；已有 .bak-before-argv-shell = ${Array.isArray(B0_DIR) && B0_DIR.some((e) => e.name.endsWith('.bak-before-argv-shell'))}`)
if (!B0_PROFILE.exists) hardFail('B0-profile', `真 profile 读不出：${B0_PROFILE.why}`)
if (oldCount !== 1) hardFail('B0-anchor', `真 profile 里 ${OLD_LINE} 出现 ${oldCount} 次（要求恰好 1 次）`)
report.B.profileBefore = B0_PROFILE

// B1 暂存：整场演练都在一份假 DSH_HOME 里（宿主监视的是真路径，副本改了不影响它）
const stageProfiles = path.join(STAGE, 'profiles', 'web')
stageWrite(stageProfiles, 'mkdir staged profile dir')
fs.mkdirSync(stageProfiles, { recursive: true })
const stagedProfile = stageWrite(path.join(stageProfiles, 'cordis.patch.yml'), 'copy real profile')
if (B0_PROFILE.exists) fs.copyFileSync(PROFILE, stagedProfile)
for (const f of ['package.json', 'cordis.yml']) {
  const src = path.join(path.dirname(PROFILE), f)
  if (fs.existsSync(src)) fs.copyFileSync(src, stageWrite(path.join(stageProfiles, f), `copy ${f}`))
}
const staged0 = snapFile(stagedProfile)
say('')
say(` B1 暂存（假 DSH_HOME，副本）：${stagedProfile}`)
say(`      bytes=${staged0.bytes}  sha256=${staged0.sha256}  ${okLine(staged0.sha256 === B0_PROFILE.sha256)} 与真 profile 逐字节相同`)
if (staged0.sha256 !== B0_PROFILE.sha256) hardFail('B1-stage-copy', '暂存副本与真 profile 不一致')

/** 对暂存文件跑一次 APPLY → 断言「只有那一行变了」→ 返回读数。 */
function applyAndAssert (label, cmd) {
  const before = snapFile(stagedProfile)
  const beforeRead = readText(stagedProfile)
  if (!beforeRead.ok) {
    hardFail('B2-staged-unreadable', `暂存 profile 读不出（${label}）：${beforeRead.why}`)
    say(`      ✗ ${label}：暂存 profile 读不出 —— ${beforeRead.why}`)
    return { label, cmd, exit: null, before, after: before, diff: [], lineNo: null, ok: false, stdout: '', stderr: beforeRead.why }
  }
  const beforeTxt = beforeRead.text
  const r = runPwsh(cmd)
  const after = snapFile(stagedProfile)
  const afterRead = readText(stagedProfile)
  const afterTxt = afterRead.ok ? afterRead.text : ''
  const lineNo = afterRead.ok ? lineOf(afterTxt, NEW_LINE) : null
  const oldGone = afterRead.ok && countOf(afterTxt, OLD_LINE) === 0
  const a = beforeTxt.split('\n')
  const b = afterTxt.split('\n')
  const diff = a.length === b.length ? a.map((l, i) => (l === b[i] ? null : i + 1)).filter((x) => x !== null) : ['行数变了']
  const onlyOneLine = Array.isArray(diff) && diff.length === 1
  const singleOccurrence = countOf(afterTxt, NEW_LINE) === 1
  const ok = r.status === 0 && after.sha256 !== before.sha256 && oldGone && lineNo !== null && onlyOneLine && singleOccurrence
  say(`      ${okLine(ok)} ${label}：exit=${r.status}  sha256 ${String(before.sha256).slice(0, 16)}… → ${String(after.sha256).slice(0, 16)}…  bytes ${before.bytes} → ${after.bytes}`)
  say(`          改动落在第 ${JSON.stringify(diff)} 行；那一行现在是 \`${NEW_LINE}\`（出现 ${countOf(afterTxt, NEW_LINE)} 次）；原行残留=${!oldGone}`)
  const receipt = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (receipt.length > 0) say(`          pwsh 回执（末 ${Math.min(2, receipt.length)} 行）：${receipt.slice(-2).map((l) => clip(l, 110)).join('  ⟂  ')}`)
  if (r.status !== 0) say(`          stderr：${clip(oneLine(r.stderr), 200)}`)
  return { label, cmd, exit: r.status, before, after, diff, lineNo, ok, stdout: oneLine(r.stdout), stderr: oneLine(r.stderr) }
}
/** 对暂存文件跑一次 ROLLBACK → 断言 sha256 回到原值。 */
function rollbackAndAssert (label) {
  const r = runPwsh(rollbackCmd(stagedProfile))
  const after = snapFile(stagedProfile)
  const read = readText(stagedProfile)
  const same = after.sha256 === B0_PROFILE.sha256 && after.bytes === B0_PROFILE.bytes
  const lineBack = read.ok && countOf(read.text, OLD_LINE) === 1
  say(`      ${okLine(same && lineBack)} ${label}：exit=${r.status}  ${read.ok ? `sha256=${after.sha256} ${okLine(same)} 与开工值逐字节相同；那一行回到 \`${OLD_LINE}\`（${lineBack}）` : `暂存 profile 读不出：${read.why}`}`)
  if (!(same && lineBack)) hardFail('B3-rollback', `${label} 没有逐字节还原（sha=${after.sha256} 期望=${B0_PROFILE.sha256}）`)
  return { label, exit: r.status, after, same, lineBack }
}

say('')
say(' B2 主形态 APPLY（一条命令；写盘用 [IO.File]::WriteAllText + 显式无 BOM UTF-8，不依赖 PS 版本的 -Encoding 语义）：')
say(`      ${applyCmd(stagedProfile, SHIM)}`)
const appliedA = applyAndAssert('应用', applyCmd(stagedProfile, SHIM))
if (!appliedA.ok) hardFail('B2-apply', `暂存应用没有达到「只改那一行」：exit=${appliedA.exit} diff=${JSON.stringify(appliedA.diff)}`)
say('')
say(' B3 回滚（一条命令；备份逐字节覆盖回去 + 回读 sha256）：')
say(`      ${rollbackCmd(stagedProfile)}`)
const rolledA = rollbackAndAssert('还原')
report.B.roundTripA = { apply: appliedA, rollback: rolledA }

say('')
say(' B4 对照形态 APPLY（C25 §5 那条 Get-Content/-replace/Set-Content，PS7 下应同效）：')
say(`      ${applyCmdB(stagedProfile, SHIM)}`)
const appliedB = applyAndAssert('应用（对照形态）', applyCmdB(stagedProfile, SHIM))
if (!appliedB.ok) hardFail('B4-applyB', `对照形态应用失败：exit=${appliedB.exit}`)
const sameProduct = appliedB.after.sha256 === appliedA.after.sha256
say(`      ${okLine(sameProduct)} 两条 APPLY 形态的产物 sha256 相同=${sameProduct} ⇒ 两条命令在本文件上等效`)
if (!sameProduct) hardFail('B4-equivalent', '两条 APPLY 形态的产物不同')
rollbackAndAssert('还原（对照形态）')
const stagedFinal = snapFile(stagedProfile)
say(`      收尾：暂存文件 sha256=${stagedFinal.sha256} ${okLine(stagedFinal.sha256 === B0_PROFILE.sha256)} 回到原值`)
report.B.roundTripB = { apply: appliedB, sameProduct, final: stagedFinal }

// B5 只读合成检查：改后那一行真的进组合树（--dump-config 只组装、不 import）
say('')
say(' B5 只读合成检查（真 dsh 加载器，假 DSH_HOME；证明那一行能进组合树）：')
const dshBin = findDshBin()
let compose = { skipped: true, why: dshBin.via }
if (dshBin.bin === null) {
  warn('B5-no-dsh', `找不到 dsh 的 bin：${dshBin.via} —— 本段跳过（不判红）`)
} else {
  const realNodeModules = path.join(path.dirname(PROFILE), 'node_modules')
  let linkNote = '无（暂存 profile 直接复用真 node_modules 的联接）'
  try {
    const linkPath = path.join(stageProfiles, 'node_modules')
    if (!fs.existsSync(linkPath) && fs.existsSync(realNodeModules)) {
      stageWrite(linkPath, 'junction to real profile node_modules')
      fs.symlinkSync(realNodeModules, linkPath, 'junction')
      linkNote = '新建（指向真 profile 的 node_modules，只读解析用）'
    }
  } catch (e) { linkNote = `建不了（${oneLine(e?.message ?? e)}）` }
  const shellLineIn = (out) => {
    const lines = String(out).split(/\r?\n/)
    const i = lines.findIndex((l) => l.includes('id: polaris-hooks-shell'))
    if (i < 0) return null
    const next = lines.slice(i + 1).find((l) => l.trim().startsWith('name:'))
    return next === undefined ? null : next.trim()
  }
  const dump = () => spawnSync(process.execPath, [dshBin.bin, '--profile', 'web', '--dump-config'], {
    encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1 << 26, env: { ...process.env, DSH_HOME: STAGE },
  })
  say(`      $ node <dsh>/lib/bin.js --profile web --dump-config   （DSH_HOME=${STAGE}）`)
  say(`      node_modules 联接：${linkNote}`)
  const beforeOut = dump()
  const beforeLine = shellLineIn(beforeOut.stdout)
  say(`      ${okLine(beforeOut.status === 0 && beforeLine === OLD_LINE)} 改前（副本原样）：exit=${beforeOut.status}  那一行 = ${beforeLine}`)
  applyAndAssert('应用（合成检查用）', applyCmd(stagedProfile, SHIM))
  const afterOut = dump()
  const afterLine = shellLineIn(afterOut.stdout)
  const urlOk = String(afterOut.stdout).includes(NEW_URL)
  say(`      ${okLine(afterOut.status === 0 && urlOk)} 改后：exit=${afterOut.status}  那一行 = ${afterLine}`)
  say(`          规范成模块 URL：${NEW_URL} ⇒ ${urlOk}`)
  const hmrPresent = /name: '@deepseek-ai\/cordis-plugin-hmr'/.test(String(afterOut.stdout))
  say(`      ${okLine(hmrPresent)} 组合树里 hmr 服务在场（M8 的前提：live 重载靠它）：${hmrPresent}`)
  compose = { skipped: false, bin: dshBin.bin, via: dshBin.via, beforeExit: beforeOut.status, beforeLine, afterExit: afterOut.status, afterLine, urlOk, hmrPresent, linkNote }
  if (beforeOut.status !== 0 || afterOut.status !== 0) hardFail('B5-dump-exit', `--dump-config exit≠0（${beforeOut.status}/${afterOut.status}）`)
  else {
    if (beforeLine !== OLD_LINE) hardFail('B5-before', `改前组合树里那一行不是 pwsh-local：${beforeLine}`)
    if (!urlOk) hardFail('B5-after', `改后组合树里那一行没有指向落地件：${afterLine}`)
  }
  rollbackAndAssert('还原（合成检查后）')
}
report.B.compose = compose

// B6 只读对账：真 profile / hooks.json / 目录 一个字节没动；没有 .bak 落到 .dsh；写盘全在暂存目录
say('')
say(' B6 只读对账（本探针的「不写宿主」不是声明，是读数）：')
const B1_PROFILE = snapFile(PROFILE)
const B1_HOOKS = snapFile(HOOKS_JSON)
const B1_DIR = snapDir(path.dirname(PROFILE))
const profSame = sameSnap(B0_PROFILE, B1_PROFILE)
const hooksSame = sameSnap(B0_HOOKS, B1_HOOKS)
const dirSame = sameSnap(B0_DIR, B1_DIR)
const dshBaks = Array.isArray(B1_DIR) ? B1_DIR.filter((e) => e.name.endsWith('.bak-before-argv-shell')).map((e) => e.name) : ['(目录读不出)']
say(`      ${okLine(profSame)} 真 profile：bytes=${B1_PROFILE.bytes} sha256=${B1_PROFILE.sha256} mtime=${B1_PROFILE.mtime}`)
say(`          ${profSame ? '与开工快照逐字段相同（bytes/sha256/mtime）' : `变了！开工=${JSON.stringify(B0_PROFILE)}`}`)
say(`      ${okLine(hooksSame)} hooks.json：${B1_HOOKS.exists ? `bytes=${B1_HOOKS.bytes} sha256=${B1_HOOKS.sha256}` : '（不存在）'} ${hooksSame ? '未变' : '变了！'}`)
say(`      ${okLine(dirSame)} .dsh 下 profile 目录条目（${Array.isArray(B1_DIR) ? B1_DIR.length : '?'} 条）未增未减`)
say(`      ${okLine(dshBaks.length === 0)} 目录里 .bak-before-argv-shell 命中 = ${dshBaks.length}${dshBaks.length === 0 ? '（备份只出现在暂存目录）' : `：${dshBaks.join(',')}`}`)
say(`      ${okLine(GUARD_HITS.length === 0)} 写入守卫：命中 DSH_HOME 的写盘尝试 = ${GUARD_HITS.length}；本次实际写盘 ${WRITES.length} 次，全部在暂存目录内`)
for (const w of WRITES) say(`          · ${padR(w.what, 26)} → ${w.stageRelative || '.'}`)
if (!profSame) hardFail('B6-profile-untouched', '真 profile 的快照变了 —— 本探针不该写它')
if (!hooksSame) hardFail('B6-hooks-untouched', 'hooks.json 的快照变了')
if (!dirSame) hardFail('B6-dir-untouched', 'profile 目录条目变了')
if (dshBaks.length !== 0) hardFail('B6-stray-bak', `DSH_HOME 下出现了备份文件：${dshBaks.join(',')}`)
if (GUARD_HITS.length !== 0) hardFail('B6-guard', '写入守卫拦到过 DSH_HOME 写盘尝试')
report.B.readOnly = { profileSame: profSame, hooksSame, dirSame, dshBaks, guardHits: GUARD_HITS.length, writes: WRITES }

// ═════════════════════════════════════════════════════════════════════════════
say('')
say('──────────────────────────────────────────────────────────────────────────────')
say(' 段C  ④ 交割单：激活一条命令 / 回滚一条命令 / 激活需要什么 / 激活后怎么验')
say('──────────────────────────────────────────────────────────────────────────────')
say('')

// C-evidence：这个 profile 的重载语义（决定「要不要重启宿主」）
const bootTxt = readText(path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))
const webPkg = readText(path.join(path.dirname(PROFILE), 'package.json'))
let pbFile = null
{
  const libDir = dshBin.bin === null ? null : path.join(path.dirname(dshBin.bin))
  if (libDir !== null && fs.existsSync(libDir)) {
    // 同一个 lib 目录里有多个 profile-boot-*.js 分块（其中只有一块含监视代码）——按内容挑，不按名字挑。
    const cands = fs.readdirSync(libDir).filter((f) => /^profile-boot-.*\.js$/.test(f))
    for (const c of cands) {
      const t = readText(path.join(libDir, c))
      if (t.ok && t.text.includes('watchUserPatches')) { pbFile = c; break }
    }
    if (pbFile === null) pbFile = cands[0] ?? null
  }
}
const pbTxt = pbFile === null
  ? { ok: false, why: '找不到含 watchUserPatches 的 profile-boot-*.js' }
  : readText(path.join(path.dirname(dshBin.bin), pbFile))
const evLines = []
if (bootTxt.ok) {
  const l1 = lineOf(bootTxt.text, 'const patchReload = rawPatchReload ?? "live"')
  const l2 = lineOf(bootTxt.text, 'patchReload: "live"')
  const l3 = lineOf(bootTxt.text, 'async function watchUserPatches')
  const l4 = lineOf(bootTxt.text, 'hmr.registerConfig(filename')
  if (l1 !== null) evLines.push({ file: 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', line: l1, text: bootTxt.text.split('\n')[l1 - 1].trim() })
  if (l2 !== null) evLines.push({ file: 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', line: l2, text: bootTxt.text.split('\n')[l2 - 1].trim() })
  if (l3 !== null) evLines.push({ file: 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', line: l3, text: bootTxt.text.split('\n')[l3 - 1].trim() })
  if (l4 !== null) evLines.push({ file: 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', line: l4, text: bootTxt.text.split('\n')[l4 - 1].trim() })
}
if (pbTxt.ok) {
  const l5 = lineOf(pbTxt.text, 'composed.profile.patchReload === "live"')
  const l6 = lineOf(pbTxt.text, 'filename: composed.profile.patchPath')
  if (l5 !== null) evLines.push({ file: `dsh/lib/${pbFile}`, line: l5, text: pbTxt.text.split('\n')[l5 - 1].trim() })
  if (l6 !== null) evLines.push({ file: `dsh/lib/${pbFile}`, line: l6, text: pbTxt.text.split('\n')[l6 - 1].trim() })
}
let reloadPolicy = null
if (webPkg.ok) {
  try { reloadPolicy = JSON.parse(webPkg.text).dsh?.profile?.patchReload ?? null } catch { reloadPolicy = null }
}

say(' C1 激活步骤（在**真** profile 上；本探针不执行，只逐字给出）：')
say('')
say('   STEP-1（先落件：文件已在仓库里，这条只是复核它可加载）')
say(`     node --check "${SHIM}"`)
say(`     node -e "import('${pathToFileURL(SHIM).href}').then(m=>console.log(m.default.name))"`)
say('')
say('   STEP-2（备份 + 改那一行 + 回执；一条命令）')
say(`     ${applyCmd(PROFILE, SHIM)}`)
say('')
say('   STEP-3（只读合成检查：那一行确实进组合树；DSH_HOME 指向真 home，只组装不启动）')
say(`     node "${dshBin.bin ?? '<dsh>/lib/bin.js'}" --profile web --dump-config | Select-String -Pattern 'polaris-hooks-shell' -Context 0,1`)
say(`     ⇒ 下一行应是 name: ${NEW_URL}`)
say('')
say(' C2 回滚步骤（一条命令；不需要 git）：')
say(`     ${rollbackCmd(PROFILE)}`)
say(`     ⇒ 回读 sha256 应等于 ${B0_PROFILE.sha256}（开工值）；落地件可以留着：没人指向它就不会被 import`)
say('')
say('   最小回滚（只把那一行改回去，备份不想留时用）：')
say(`     $P='${PROFILE}'; $t=[IO.File]::ReadAllText($P); [IO.File]::WriteAllText($P, $t.Replace("${NEW_LINE}", "${OLD_LINE}"), [Text.UTF8Encoding]::new($false))`)
say('')
say('   回滚判据（改回后这条必须成立）：')
say(`     Select-String -Path '${PROFILE}' -Pattern 'polaris-hooks-shell' -Context 0,1`)
say(`     ⇒ 下一行必须是 ${OLD_LINE}`)
say('')
say(' C3 激活需要什么（复核 C25 的结论，本单给出了【不同】的读数）：')
const liveLikely = reloadPolicy === null && evLines.length >= 4
say(`     本 profile 的 dsh.profile.patchReload = ${reloadPolicy === null ? '(未声明 ⇒ 默认 live)' : JSON.stringify(reloadPolicy)}`)
say('     证据（只读读出的源码行，逐条打印）：')
for (const e of evLines) say(`       · ${e.file}:${e.line}   ${clip(e.text, 150)}`)
say(`     ${okLine(liveLikely)} ⇒ 结论：重启【不是】结构上的必要条件（C25 写的「新会话不生效、必须重启宿主」在这一条上说过头了）。`)
say('       证据链：① profile 未声明 patchReload ⇒ 默认 live（app-boot:848）；② web 模板就是 live（app-boot:335）；')
say('               ③ launcher 在 boot 之后对【这个文件】挂 HMR 监视并事务性重放 patch 列表（profile-boot:321/331 → watchUserPatches）；')
say('               ④ 段B B5 的只读 --dump-config 证明改后那一行确实进组合树（副本上实测）。')
say('       本单【没有】端到端证明的一格：运行中的宿主把同一个 id 的 insert 条目从 pwsh-local 换成 argv-shell 时，')
say('         loader 是否真的 dispose 旧模块 + 载入新模块（要证明它得写真 profile 或另起一个 dsh 实例——两件都越界）。')
say('       所以判据仍以实测为准：--verify-guard 若显示已换过来 ⇒ 不用重启；没换过来 ⇒ 重启宿主（重启是充分兜底，')
say('         不是必要条件：那一行总会在下次启动时被读一次）。')
say('       含义（双向）：① 改完可能立刻生效，--verify-guard 立刻可验；② 若立刻生效，则激活/回滚都在运行中即时改变行为 ——')
say('         所以【先落件、后改行】（顺序反了会有一个"指向不存在模块"的组合失败窗口），改完立刻验。')
report.C.reload = { policy: reloadPolicy, evidence: evLines, live: liveLikely, needsRestart: false, residualUnproven: 'id 不变、name 变化的 insert 条目在 live 重放下是否 swap 模块实例（需写真 profile 或另起 dsh 实例，本单不做）' }
say('')
say(' C4 激活后验证护栏仍在（一条命令，可重复跑）：')
say(`     node "${pkgPath('probes', 'hook-wiring-plan.mjs')}" --verify-guard`)
say('     ⇒ 同一批载荷 × 两种 transport（pwsh-local ↔ argv-shell）的判决与落账逐字比对；')
say('       PASS = 打印「=== --verify-guard（激活后验护栏）: PASS ===」且 exit 0；任一不一致 exit 1 并点名。')
say('')
say('   人工双保险（读宿主自己的账，不看探针）：')
say(`     node -e "const fs=require('fs');const L=fs.readFileSync('${path.join(REPO, '.polaris', 'polaris-guard.log.jsonl').replace(/\\/g, '/')}','utf8').trim().split('\\n');console.log(L.slice(-3).join('\\n'))"`)
say('     ⇒ 让宿主随便跑一次工具调用，看新落的那条：state_root 仍是工作区、verdict 与刷新前同形、ms 应明显下降。')
say('')

// ═════════════════════════════════════════════════════════════════════════════
say('──────────────────────────────────────────────────────────────────────────────')
say(' 段D  ⑤ 失效模式复核（C25 的 M1–M6 逐条核对 + 本单新增 M7–M9）')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
// M2 的现场读数：生成器那一行（只读；跨仓库，不在写范围）
const genTxt = readText(GENERATOR)
let genLineNo = null
let genLineTxt = null
if (genTxt.ok) {
  genLineNo = lineOf(genTxt.text, 'const SHELL_LOCAL = process.platform')
  if (genLineNo !== null) genLineTxt = genTxt.text.split('\n')[genLineNo - 1].trim()
}
const m2Live = genTxt.ok ? `生成器在（${GENERATOR}），${genLineNo ?? '?'} 行仍是：${clip(genLineTxt, 140)}` : `读不出生成器：${genTxt.why}`
report.D.generator = { path: GENERATOR, exists: genTxt.ok, line: genLineNo, text: genLineTxt }

const FAIL_MODES = [
  ['M1 命令串里出现 shell 语法（复核：仍成立，但本单把它变成机器判据）',
    `现网 ${cmdRows.length || '?'} 条命令串（宿主 aurapolaris-hooks.json）逐条用【落仓后的真模块】切成 argv：全部是 node + 引号路径 + --k=v，一条都不含 | & ; $ > < \` % ( )（段A A6 是判据）。`,
    '替换面向后，`;`/`|` 不再被当语句分隔符（A7 有否定对照）——这是本方案【故意】的语义差别：要写 shell 语法就不该走 argv 路径。引号不配对当场抛错，不猜。'],
  ['M2 生成器把这一行改回去（复核：仍在）',
    m2Live,
    `回退是 fail-safe 的：护栏与落账不受影响，只是每次调用又付 686ms（C25 §3.5 的 p50 一测就露）。兜底=把该行改成 process.env.POLARIS_ARGV_SHELL ?? (...)（C25 §4③ 给了改后文本）——**本单没改**：跨仓库、不在写范围。`],
  ['M3 反斜杠/引号边界（复核：仍成立，且已被 A7 覆盖）',
    '词法规矩「反斜杠只在紧跟本段引号时转义」⇒ 路径以反斜杠结尾又包在引号里（"C:\\dir\\"）会被判成转义引号 ⇒ 抛错。现网命令串用正斜杠、不以反斜杠结尾，不受影响。',
    '抛错而不是猜一个"大概是这个意思"的 argv；报错串里带原命令串，改成正斜杠或去掉尾反斜杠即可。'],
  ['M4 执行世界差异（复核：成立；本单不重复 C25 的桥级读数）',
    'pwsh-local 会在子进程里钉 UTF-8 输出编码（ENCODING_PREAMBLE），argv 路径没有这一层。钩子入口只用 node + 参数，判定与落账不读 shell 编码。',
    '本探针只证到「落地件可加载 + 那一行可应用可还原」；「判定与落账逐字未变」由 C25 §3.2 的落账读数与 --verify-guard 负责，本单按前提引用，没有重测。'],
  ['M5 平台（复核：成立）',
    '同一行在 posix 上由生成器投影成 @deepseek-ai/dsh-bash-local（生成器那一行的三元表达式就是证据）⇒ 收益只在 win32 生效；shim 本身平台无关（argv 直投）。',
    '要 posix 也吃到，需一并改生成器那行（C25 §4③ 的条件表达式）。'],
  ['M6 落点假设（复核：成立，且与本单无关）',
    '本单只换 ctx.shell 的提供者，不动 --state=workspace 的落点语义：workdir 由 bridge 的 session workdir 给，回落顺序与 pwsh-local 同款。',
    'C25 §3.2 的落账逐字为证；本单不重复。'],
  ['M7【新增】那一行 YAML 的引号种类 = 安全边界',
    `改动后的值是 YAML 【单引号】标量：单引号里 \\ 是字面量 ⇒ Windows 路径原样交给 cordis，再被规范成 ${NEW_URL}（段B B5 的前后读数就是它）。若谁把单引号换成双引号，YAML 会解释 \\w \\t \\n \\x 之类转义 ⇒ 路径静默变形或直接解析失败；路径里出现空格/#/: 组合时裸标量也不再安全。`,
    '保持单引号 + 绝对路径（APPLY 模板只替换引号【内】的内容）；改完立刻跑 C1 STEP-3 的只读合成检查（本探针 B5 同款）。'],
  ['M8【新增】「激活要重启宿主」这个前提被推翻了一半 —— live 重载',
    `本 profile 未声明 dsh.profile.patchReload ⇒ 默认 live（C1 打印的 app-boot 行）；launcher 在 boot 之后对 profile 的 patch 文件挂 HMR 监视并事务性重放（C1 证据行）⇒ 有效编辑很可能**无需重启**就被运行中的宿主重新组合；无效编辑保留上一个可用组合。未证的一格见 C3（id 不变、name 变化时是否 swap 模块实例）。`,
    '① 好消息：重启不是必要条件，改完先跑 --verify-guard；② 坏消息：若已即时生效，则没有"改了没生效"的安全缓冲 ⇒ 必须先落件再改行（顺序反了有一个组合失败窗口），改完立刻验；--verify-guard 没换过来就重启宿主。'],
  ['M9【新增】接线锚在 dev tree 上（不是安装副本）',
    `那一行指向 ${relRepo(SHIM)}（仓库工作区），而 aura-read/aura-edit 两行钉的是安装副本 ~/.aura/pkg。仓库被移动/改名/清理，或那个文件被删/改坏 ⇒ 宿主下次组合时 import 失败（live 重载下则是编辑被拒、保留上一个可用组合）。`,
    `① 本探针段A 每次 3 秒内就能证明「文件在、能 import、与生成器逐字节一致」；② 长期正解是把 shim 收进 aura-tools 包、那一行指向安装副本（C28 的安装副本路线），届时三行同锚。`],
]
for (const [id, what, fallback] of FAIL_MODES) {
  say(` · ${id}`)
  say(`   新形态: ${what}`)
  say(`   兜底  : ${fallback}`)
  say('')
}
report.D.failModes = FAIL_MODES.map(([id, what, fallback]) => ({ id, what, fallback }))

// ═════════════════════════════════════════════════════════════════════════════
say('──────────────────────────────────────────────────────────────────────────────')
say(' 汇总')
say('──────────────────────────────────────────────────────────────────────────────')
say('')
say(` 落地件           : ${relRepo(SHIM)}  bytes=${diskBuf.length}  sha256=${diskSha}`)
say(`                 与 --emit-shim 逐字节一致=${bytesEqual}；node --check exit=${checkRun.status}；真实 import=${shimMod !== null}`)
say(` 暂存往返         : 应用（主形态）exit=${appliedA.exit} sha 变了=${appliedA.after.sha256 !== appliedA.before.sha256}；`)
say(`                 还原 sha256=${rolledA.after.sha256} 与开工值逐字节相同=${rolledA.same}`)
say(`                 对照形态（C25 §5）产物同 sha=${sameProduct}；收尾回到原值=${stagedFinal.sha256 === B0_PROFILE.sha256}`)
say(` 只读对账         : 真 profile/.dsh 目录/hooks.json 全部未变=${profSame && dirSame && hooksSame}；DSH_HOME 下 .bak 命中=${dshBaks.length}`)
say(` 激活需要什么     : 重启不是必要条件（patchReload=live；证据 ${evLines.length} 行；未证的一格见 C3）；顺序=先落件后改行`)
say(` 激活后验证       : node aura-tools/probes/hook-wiring-plan.mjs --verify-guard`)
say(` 硬判据           : ${HARD.length === 0 ? '全绿' : `${HARD.length} 条红`}${WARN.length === 0 ? '' : `；告警 ${WARN.length} 条`}`)
for (const h of HARD) say(`      ✗ ${h.id}: ${h.detail}`)
for (const w of WARN) say(`      ⚠ ${w.id}: ${w.detail}`)
say(` 暂存目录         : ${STAGE}${KEEP_STAGE ? '（保留）' : '（退出前删除）'}`)
say('')
report.hard = HARD
report.warn = WARN
report.exit = HARD.length === 0 ? 0 : 1
say(` 退出码           : ${report.exit}（全量：看全部硬判据）`)

if (JSON_OUT) {
  say('')
  say('--- JSON ---')
  say(JSON.stringify(report, null, 1))
}
if (!KEEP_STAGE) {
  try { fs.rmSync(STAGE, { recursive: true, force: true }) } catch { /* 删不掉就留着，路径已打印 */ }
}
process.exit(report.exit)
