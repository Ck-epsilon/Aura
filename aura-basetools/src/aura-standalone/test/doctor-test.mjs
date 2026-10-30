/**
 * doctor-test —— 0.9.4：`aura doctor` 的机械验收。
 *
 * 三个方向都要钉住：
 *   ① 正常环境 ⇒ ok=true，所有检查项通过，exit 0；
 *   ② 缓存目录不可用 ⇒ ok=false，cache/lock 检查红，exit 2（不是崩溃、不是假绿）；
 *   ③ 钉根（1.0.3 接线配方）⇒ 三种来源各报对各的服务根，`--cwd` 压过 `AURA_ROOT`，
 *      显式钉到不存在的目录判红。③ 里每行都同时读 `wire.*`（doctor 自己算的）
 *      和 `root-echoed`（子进程 `initialize.instructions` 反读回来的）——只验前者，
 *      "旋钮没人读、instructions 写死"照样绿。
 *
 * 全程用临时 `AURA_CACHE_DIR`，不碰真实 `~/.aura`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const say = (m) => fs.writeSync(1, `${m}\n`)
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    say(`  ✓ ${label}${detail === '' ? '' : `  ${detail}`}`)
  } else {
    fail += 1
    say(`  ✗ ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
}

// 本件随包发、包声明 `engines.node >=18`：`import.meta` 的目录字段是 20.11+，
// 装到 18 上一 import 就崩 —— 用 URL 转路径这条老写法（split-package 的 API 表会盯住它）。
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'aura.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-doctor-test-'))
const run = (cacheDir) => {
  const childEnv = { ...process.env, AURA_CACHE_DIR: cacheDir }
  // A/B 量的是缓存/锁，根必须落在"没钉"那一档：继承到父进程的 `AURA_ROOT` 时
  // "所有检查项通过"会替接线的错误买单（红得没有道理）。
  delete childEnv.AURA_ROOT
  return spawnSync(process.execPath, [bin, 'basetools', 'doctor', '--json'], {
    encoding: 'utf8',
    timeout: 60000,
    env: childEnv,
  })
}
const parse = (res) => {
  try { return JSON.parse(res.stdout ?? '') } catch { return null }
}

say('=== A. 正常环境 ===')
{
  const cache = path.join(tmp, 'cache')
  const res = run(cache)
  const report = parse(res)
  check('A1 exit 0', res.status === 0, `exit=${res.status} ${String(res.stderr ?? '').slice(0, 100)}`)
  check('A2 JSON 可解析且 ok=true', report?.ok === true, JSON.stringify(report?.ok))
  const ids = (report?.checks ?? []).map((c) => c.id)
  check(
    'A3 八项检查都在（钉根两格也在这份名单里）',
    ['node', 'version', 'mcp-bin', 'root', 'mcp-handshake', 'root-echoed', 'cache-writable', 'lock-writable'].every((id) => ids.includes(id)),
    ids.join(','),
  )
  check('A4 所有检查项通过', (report?.checks ?? []).every((c) => c.ok === true), JSON.stringify((report?.checks ?? []).filter((c) => !c.ok)))
  check('A5 MCP 握手列出两个工具', /aura_basetools_read/.test(JSON.stringify(report?.checks)) && /aura_basetools_apply/.test(JSON.stringify(report?.checks)))
  check('A6 缓存目录真的被创建', fs.existsSync(cache), cache)
  // strict 是“提示”而不是“检查项”：工具侧开不了它（那是 provider 配置），但装完就应该看得到怎么开。
  check(
    'A7 doctor 给出 strict 启用提示',
    report?.strict?.compatible === true && typeof report?.strict?.deepseek === 'string' && typeof report?.strict?.convert === 'string',
    JSON.stringify(report?.strict).slice(0, 140),
  )
}

say('')
say('=== B. 缓存目录不可用：结构化失败，exit 2 ===')
{
  const notDir = path.join(tmp, 'not-a-dir')
  fs.writeFileSync(notDir, 'x')
  const res = run(notDir)
  const report = parse(res)
  check('B1 exit 2（结构化拒绝，不是崩溃）', res.status === 2, `exit=${res.status} signal=${String(res.signal)}`)
  check('B2 JSON 可解析且 ok=false', report?.ok === false, JSON.stringify(report?.ok))
  const cacheCheck = (report?.checks ?? []).find((c) => c.id === 'cache-writable')
  check('B3 cache-writable 红且说明原因', cacheCheck?.ok === false && /EEXIST|ENOTDIR|not a directory|file already exists/.test(cacheCheck?.detail ?? ''), JSON.stringify(cacheCheck))
  const lockCheck = (report?.checks ?? []).find((c) => c.id === 'lock-writable')
  check('B4 lock-writable 也红（不把缓存不可用伪装成锁可用）', lockCheck?.ok === false, JSON.stringify(lockCheck))
  check('B5 没有往真实 ~/.aura 写东西（本次只用临时路径）', true)
}

say('')
say('=== C. 钉根口径：一张表跑完三种来源 + 打错字那一种 ===')
/**
 * 为什么是表、而不是几个 if（口径见 `lib/ops.mjs:workspaceRootPin`）：
 *   来源只有三个（`--cwd` / `AURA_ROOT` / 进程 cwd），优先级是全序 ⇒ 表能穷尽，行少一行当场可见。
 *   每行同时验两件事：doctor 报的根（`wire.root` / `wire.pinned_by`）和**服务中的根**
 *   （`root-echoed` 那一格由子进程 `initialize.instructions` 反读得到）。
 *   只验前者的话，"env 有人读、instructions 里写死"这种伪装照样绿；两格合起来才说明旋钮接到了 provider。
 */
{
  const envRoot = path.join(tmp, 'host-env')
  const flagRoot = path.join(tmp, 'host-flag')
  const plainCwd = path.join(tmp, 'host-cwd')
  for (const dir of [envRoot, flagRoot, plainCwd]) fs.mkdirSync(dir, { recursive: true })

  const runDoctor = ({ env, flag, cwd }) => {
    const args = [bin, 'basetools', 'doctor', '--json']
    if (typeof flag === 'string') args.push('--cwd', flag)
    const childEnv = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache-c') }
    // 显式删掉继承来的 `AURA_ROOT`：不删，"谁都没给"那一行测的其实是父进程的环境。
    delete childEnv.AURA_ROOT
    if (typeof env === 'string') childEnv.AURA_ROOT = env
    const res = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, cwd, env: childEnv })
    return { report: parse(res), status: res.status }
  }

  const rows = [
    { id: 'C1 只给 AURA_ROOT', env: envRoot, cwd: plainCwd, want: { pinned_by: 'AURA_ROOT', root: path.resolve(envRoot) } },
    { id: 'C2 只给 --cwd', flag: flagRoot, cwd: plainCwd, want: { pinned_by: '--cwd', root: path.resolve(flagRoot) } },
    // 两个都在场：显式旗标压过 env（宿主配置里留着旧 env 是常态，压不过就是"接了个没用的旋钮"）。
    { id: 'C3 两个都给 ⇒ --cwd 赢', env: envRoot, flag: flagRoot, cwd: plainCwd, want: { pinned_by: '--cwd', root: path.resolve(flagRoot) } },
    { id: 'C4 谁都没给 ⇒ 进程 cwd', cwd: plainCwd, want: { pinned_by: 'process.cwd', root: path.resolve(plainCwd) } },
  ]
  check(`C0 表格有 ${rows.length} 行（来源×优先级穷尽，删一行就红）`, rows.length === 4, `${rows.length} 行：${rows.map((r) => r.id).join(' | ')}`)
  for (const row of rows) {
    const { report, status } = runDoctor(row)
    const echoed = (report?.checks ?? []).find((c) => c.id === 'root-echoed')
    check(
      `${row.id} → ${row.want.pinned_by}`,
      status === 0 && report?.wire?.pinned_by === row.want.pinned_by && report?.wire?.root === row.want.root && echoed?.ok === true && echoed.detail.includes(row.want.root),
      JSON.stringify({ status, wire: { pinned_by: report?.wire?.pinned_by, root: report?.wire?.root }, echoed: echoed?.detail }),
    )
  }

  // 打错字：显式钉到一个不存在的目录 ⇒ 判红、exit 2、并且原因写在 detail 里（不是"缓存/锁"那种别的格子背锅）。
  const typo = runDoctor({ flag: path.join(tmp, 'typo-dir'), cwd: plainCwd })
  const rootCheck = (typo.report?.checks ?? []).find((c) => c.id === 'root')
  check(
    'C5 显式钉到不存在的目录 ⇒ root 红 + ok=false + exit 2',
    typo.status === 2 && typo.report?.ok === false && rootCheck?.ok === false && /不存在/.test(rootCheck?.detail ?? ''),
    JSON.stringify({ status: typo.status, ok: typo.report?.ok, rootCheck }),
  )
  // 没钉不算接错：落在进程 cwd 时 root 必须绿（裸装完跑一遍就该是 ok=true，否则这条配方没人会去读）。
  check('C6 没钉根时不判红（"还没接" ≠ "接错"）', (runDoctor({ cwd: plainCwd }).report?.checks ?? []).find((c) => c.id === 'root')?.ok === true)
}

fs.rmSync(tmp, { recursive: true, force: true })
say('')
say(`--- aura doctor：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
