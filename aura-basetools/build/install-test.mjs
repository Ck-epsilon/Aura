#!/usr/bin/env node
/**
 * install.mjs 的机械验收 —— 在**假 HOME** 里真装、真卸、真跑自检，不碰任何真实配置。
 *
 *   node tools/install-test.mjs [包目录|.tgz]
 *
 * 为什么要有它：安装器会改别人的 agent 配置，属于"必须每次改动都重跑"的东西。
 * 这里覆盖九件事：装 / 幂等 / 写入内容 / 卸载复原 / 别人写的同名项不许动 /
 * .tgz 路线与目录路线等价 / --json 可用 / --dry-run 不落盘 / 卸载可重入。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const installer = path.join(import.meta.dirname, 'install.mjs')
const defaultPayload = path.join(root, 'dist', 'aura-basetools')
const payload = process.argv[2] ?? defaultPayload

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  process.stdout.write(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : `   ${detail}`}\n`)
}

const SEED = {
  toml: '[mcp_servers.existing]\ncommand = "node"\nargs = ["x.mjs"]\n',
  claude: '{"mcpServers":{"tavily":{"command":"npx","args":["-y","tavily-mcp"]}},"numStartups":7}',
  cursor: '{"mcpServers":{}}',
}

const files = (home) => ({
  codex: path.join(home, '.codex', 'config.toml'),
  claude: path.join(home, '.claude.json'),
  cursor: path.join(home, '.cursor', 'mcp.json'),
})

/** 本跑建过的临时目录（假 home 与 J 段的两三个夹具目录），结束前一律删掉。
 * 为什么要记这个：这个套件跑了很多次，每跑一次造 6–10 个 home，而**从没清理过**——
 * 实测在 %TEMP% 里积了 170+ 个 `aura-install-test-*`（测试在别人机器上留垃圾，是低级但真实的毛病）。
 * 升级测试与我的审计探针都是用 `finally` 清干净的，这里对齐。 */
const createdHomes = []

function freshHome(seed = SEED) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-install-test-'))
  createdHomes.push(home)
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  fs.writeFileSync(files(home).codex, seed.toml)
  fs.writeFileSync(files(home).claude, seed.claude)
  fs.writeFileSync(files(home).cursor, seed.cursor)
  return home
}

const run = (home, args, from = payload) =>
  spawnSync(process.execPath, [installer, '--home', home, '--from', from, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AURA_CACHE_DIR: path.join(home, '.aura', 'cache') },
  })

function runJson(home, args, from = payload) {
  const result = run(home, [...args, '--json'], from)
  let parsed = null
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = null
  }
  return { status: result.status, out: parsed, stderr: result.stderr }
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const hashes = (home) => {
  const all = files(home)
  return all.codex + sha(all.codex) + all.claude + sha(all.claude) + all.cursor + sha(all.cursor)
}
const normalize = (value) => ({ ...value, mcpServers: value.mcpServers ?? {} })
const jsonOf = (file) => normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
const backupCount = (home) =>
  fs
    .readdirSync(home, { recursive: true })
    .filter((name) => String(name).includes('.bak-aura-'))
    .length

// ── A 装 ─────────────────────────────────────────────────────────────────────
const home = freshHome()
const installDir = path.join(home, '.aura', 'pkg', 'node_modules', 'aura-basetools')
const first = runJson(home, ['--yes'])
check('A1 装：退出码 0、ok=true', first.status === 0 && first.out?.ok === true, `exit=${first.status} ${first.stderr.trim().split('\n')[0] ?? ''}`)
// 基线没过就**提前结束**：否则"什么都没发生"会让一批否定式断言（配置没丢、目录已删…）**假通过**，
// 把通过数抬上去、把失败藏在下面（实测：安装路径报错时 A8/C3–C7 全绿）。
if (first.status !== 0 || first.out?.ok !== true) {
  process.stdout.write('\n--- install-test：基线安装失败，后续断言无意义，提前结束 ---\n')
  process.exit(1)
}
check('A2 装：CLI 自检 ok', first.out?.selftest?.cli === 'ok', String(first.out?.selftest?.cli))
check('A3 装：MCP 自检列出两个工具', String(first.out?.selftest?.mcp).startsWith('ok: aura_read, aura_edit'), String(first.out?.selftest?.mcp))
check(
  'A4 装：三家配置都写入',
  first.out?.registrations?.map((r) => `${r.agent}:${r.action}`).join(',') === 'codex:added,claude:added,cursor:added',
  JSON.stringify(first.out?.registrations?.map((r) => `${r.agent}:${r.action}`)),
)
check('A5 装：四个命令壳都在', ['aura', 'aura.cmd', 'aura-mcp', 'aura-mcp.cmd'].every((n) => fs.existsSync(path.join(home, '.aura', 'pkg', 'bin', n))))
check('A6 装：配置已备份', backupCount(home) === 3, `备份数=${backupCount(home)}`)
check('A7 内容：codex 表指向本安装目录', fs.readFileSync(files(home).codex, 'utf8').includes(JSON.stringify(path.join(installDir, 'bin/aura-mcp.mjs'))))
check('A8 内容：claude 别的键没丢', jsonOf(files(home).claude).numStartups === 7 && jsonOf(files(home).claude).mcpServers.tavily !== undefined)

// ── B 幂等 ───────────────────────────────────────────────────────────────────
const afterFirst = hashes(home)
const backupsAfterFirst = backupCount(home)
const second = runJson(home, ['--yes'])
check(
  'B1 重装：报"已是本安装器的"、不再是 added',
  second.status === 0 && second.out?.registrations?.every((r) => r.action === 'present'),
  JSON.stringify(second.out?.registrations?.map((r) => `${r.agent}:${r.action}`)),
)
check('B2 重装：三份配置逐字节不变', hashes(home) === afterFirst)
check('B3 重装：不再重复备份', backupCount(home) === backupsAfterFirst, `备份数=${backupCount(home)}`)

// ── C 卸载复原 ───────────────────────────────────────────────────────────────
const remove = runJson(home, ['--uninstall'])
check('C1 卸载：退出码 0', remove.status === 0)
check('C2 卸载：三家都撤掉', remove.out?.touched?.join(',') === 'codex:removed,claude:removed,cursor:removed', JSON.stringify(remove.out?.touched))
check('C3 卸载：codex 表与注释都没了', !fs.readFileSync(files(home).codex, 'utf8').includes('aura'))
check('C4 卸载：codex 其余内容原样', fs.readFileSync(files(home).codex, 'utf8').trim() === SEED.toml.trim())
check('C5 卸载：claude 语义回到原始', JSON.stringify(jsonOf(files(home).claude)) === JSON.stringify(normalize(JSON.parse(SEED.claude))))
check('C6 卸载：cursor 语义回到原始', JSON.stringify(jsonOf(files(home).cursor)) === JSON.stringify(normalize(JSON.parse(SEED.cursor))))
check('C7 卸载：安装目录已删', !fs.existsSync(path.join(home, '.aura', 'pkg', 'node_modules')))
const again = runJson(home, ['--uninstall'])
check('C8 卸载可重入：再卸一次仍 0 且无项可撤', again.status === 0 && (again.out?.touched ?? []).length === 0, JSON.stringify(again.out?.touched))

// ── D 别人写的同名项不许动 ───────────────────────────────────────────────────
const foreignHome = freshHome({
  toml: '[mcp_servers.aura]\ncommand = "node"\nargs = ["/opt/other/aura-mcp.mjs"]\n',
  claude: '{"mcpServers":{"aura":{"command":"node","args":["/opt/other/aura-mcp.mjs"]}}}',
  cursor: '{"mcpServers":{"aura":{"command":"node","args":["/opt/other/aura-mcp.mjs"]}}}',
})
const foreignBefore = hashes(foreignHome)
const foreignInstall = runJson(foreignHome, ['--yes'])
check(
  'D1 他人在先：识别为 foreign（不是我们的）',
  foreignInstall.status === 0 && foreignInstall.out?.registrations?.every((r) => r.action === 'foreign'),
  JSON.stringify(foreignInstall.out?.registrations?.map((r) => `${r.agent}:${r.action}`)),
)
check('D2 他人在先：装的时候没改他的配置', hashes(foreignHome) === foreignBefore)
const foreignRemove = runJson(foreignHome, ['--uninstall'])
check(
  'D3 他人在先：卸载后他的项还在',
  foreignRemove.status === 0 && fs.readFileSync(files(foreignHome).codex, 'utf8').includes('/opt/other/aura-mcp.mjs') && fs.readFileSync(files(foreignHome).claude, 'utf8').includes('/opt/other/aura-mcp.mjs'),
)

// ── E .tgz 路线 ──────────────────────────────────────────────────────────────
/** 在 dist/ 里挑"最新"的包体。返回 undefined 表示一个 .tgz 都没有（E1 走失败路径）。
 * 为什么按文件名里的 semver **逐段数值**比较，而不是 `.sort().pop()`：字符串序是字典序，
 * `'aura-basetools-0.6.9.tgz' > 'aura-basetools-0.6.10.tgz'`（逐位 `'9' > '1'`），多版本共存时
 * 它会选中**旧**包 —— 量具挑错包，然后红在 E3（内容不一致），看起来像产物缺陷。
 * 为什么不用 mtime：mtime 是文件系统的元数据，复制 / 检出 / 解压 / 还原都会把它重写，
 * 它描述的是"谁最后落盘"而不是"谁版本更高"；semver 是产物自己的身份，可复现、可解释。 */
function pickLatestTarball(dir) {
  const versioned = []
  let lastByString = undefined
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^aura-basetools-.*\.tgz$/.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (lastByString === undefined || entry.name > path.basename(lastByString)) lastByString = full
    const m = /^aura-basetools-(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\.tgz$/.exec(entry.name)
    if (m !== null) versioned.push({ full, parts: [Number(m[1]), Number(m[2]), Number(m[3])] })
  }
  if (versioned.length === 0) return lastByString // 没有 semver 命名的（手改名）：退回字典序，至少结果是确定的
  versioned.sort((a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2])
  return versioned[versioned.length - 1].full
}

const tgz = pickLatestTarball(path.join(root, 'dist'))
if (tgz === undefined) {
  check('E1 .tgz 路线：dist/ 下有 aura-basetools-*.tgz', false, '先跑 node tools/make-bundle.mjs --pack')
} else {
  // 对比要在两份**干净**的安装上做：上面的 home 已经被卸载过了
  const dirSource = fs.existsSync(path.join(defaultPayload, 'package.json')) ? defaultPayload : payload
  const dirHome = freshHome()
  runJson(dirHome, ['--yes'], dirSource)
  const tgzHome = freshHome()
  const tgzInstall = runJson(tgzHome, ['--yes'], tgz)
  check('E1 .tgz 路线：装成功且自检 ok', tgzInstall.status === 0 && tgzInstall.out?.selftest?.cli === 'ok' && String(tgzInstall.out?.selftest?.mcp).startsWith('ok'), `exit=${tgzInstall.status} ← ${path.basename(tgz)}`)
  const walk = (dir, base = dir) => {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full, base))
      else out.push(path.relative(base, full).replaceAll('\\', '/'))
    }
    return out.sort()
  }
  const dirPkg = path.join(dirHome, '.aura', 'pkg', 'node_modules', 'aura-basetools')
  const tgzPkg = path.join(tgzHome, '.aura', 'pkg', 'node_modules', 'aura-basetools')
  const dirFiles = walk(dirPkg).filter((name) => !name.endsWith('.tgz'))
  const tgzFiles = walk(tgzPkg)
  check('E2 .tgz 路线：解出的文件清单与目录路线一致', JSON.stringify(dirFiles) === JSON.stringify(tgzFiles), `目录 ${dirFiles.length} 个 / tgz ${tgzFiles.length} 个`)
  const digest = (dir, names) => crypto.createHash('sha256').update(names.map((name) => name + sha(path.join(dir, name))).join('|')).digest('hex')
  check('E3 .tgz 路线：每个文件内容一致', digest(dirPkg, dirFiles) === digest(tgzPkg, tgzFiles))
}

// ── F --dry-run 不落盘 ───────────────────────────────────────────────────────
const dryHome = freshHome()
const dryBefore = hashes(dryHome)
const dry = runJson(dryHome, ['--dry-run'])
check('F1 预演：退出码 0 且什么都没装', dry.status === 0 && !fs.existsSync(path.join(dryHome, '.aura')))
check('F2 预演：配置一字未动', hashes(dryHome) === dryBefore)
check('F3 预演：列出了将成为目标的配置文件', (dry.out?.planned ?? []).length >= 3, `planned=${(dry.out?.planned ?? []).length}`)

// ── G 体检与版本（升级的前置能力：没有体检，升级就是盲开车） ────────────────
const doctorHome = freshHome()
runJson(doctorHome, ['--yes'])
const version = run(doctorHome, ['--version'])
const doctorOk = run(doctorHome, ['--doctor'])
check('G1 --version 报得出已装版本', version.status === 0 && /aura-basetools \d+\.\d+\.\d+/.test(version.stdout), version.stdout.trim().split('\n')[0] ?? '')
/**
 * G1b：`--version` 的三面说明不能是 `undefined`。
 *
 * 实测踩到的形状（已修）：`SURFACES` 是二元组列表 `[名字, 时机]`，而渲染那一行写成了**对象解构**
 * `{ name, when }`——数组上取不存在的属性**不报错**，只印出三行 `· undefined：undefined`。
 * 而 G1 只看第一行是否含版本号，自然全绿。这正是“只看成败的断言抓不到错”的典型：
 * 退出码 0、首行也对，错在**内容**里。所以这里把“不许出现 undefined”单独钉一条。
 * 同一个列表在 `--doctor` 里用的是正确的数组解构，两处写法不一致就是入口。
 */
check(
  'G1b --version 的三面说明有实义（不出现 undefined）',
  !/undefined/.test(version.stdout) && /CLI（aura \/ aura-mcp）/.test(version.stdout),
  version.stdout.includes('undefined') ? version.stdout.split('\n').find((l) => l.includes('undefined')) ?? '' : '',
)
check('G2 --doctor 全新安装体检全部正常', doctorOk.status === 0 && doctorOk.stdout.includes('全部正常'), doctorOk.stdout.trim().split('\n').pop() ?? '')
check(
  'G2b --doctor 的三面说明同样不出现 undefined',
  !/undefined/.test(doctorOk.stdout),
  doctorOk.stdout.includes('undefined') ? doctorOk.stdout.split('\n').find((l) => l.includes('undefined')) ?? '' : '',
)

// ── H 目录来源的包体：交付包解开后就是“目录 + .tgz 并列”这个形状 ─────────────
// 实测踩到的缺陷：旧版拿到 `--from` 就原样返回，于是把**父目录**当包体拷进
// `node_modules/aura-basetools/`，包里多一层 `aura-basetools/`、顶层没有 package.json，
// 随即被安装器自己的“像不像 aura-basetools”校验拒掉（exit=2）。
// 而那是主路径（`一键安装.cmd` 旁边就是那个形状），不是边角情形。
{
  const dirHome = freshHome()
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-install-test-bundle-'))
  createdHomes.push(bundle)
  // 造“交付包解开后”的形状：一个含 aura-basetools/ 子目录（+ 一份 .tgz）的父目录。
  // 源用 `payload`（它在本测试里是**目录** `dist/aura-basetools`）——
  // 不能用 A 段的 `installDir`：它在 C 段卸载时已经删了（第一版那么写直接 ENOENT）。
  fs.cpSync(payload, path.join(bundle, 'aura-basetools'), { recursive: true })
  const siblingTgz = fs.readdirSync(path.dirname(payload)).find((n) => /^aura-basetools-.*\.tgz$/.test(n))
  if (siblingTgz !== undefined) fs.copyFileSync(path.join(path.dirname(payload), siblingTgz), path.join(bundle, siblingTgz))
  const fromBundle = runJson(dirHome, ['--yes'], bundle)
  check(
    'H1 从“发布目录”（目录 + .tgz 并列）能装上',
    fromBundle.status === 0 && fromBundle.out?.ok === true,
    `exit=${fromBundle.status} ${String(fromBundle.stderr).trim().split('\n')[0] ?? ''}`,
  )
  const installedHere = path.join(dirHome, '.aura', 'pkg', 'node_modules', 'aura-basetools')
  check('H2 装出来的顶层就是包本身（不多一层 aura-basetools/）', fs.existsSync(path.join(installedHere, 'package.json')) && !fs.existsSync(path.join(installedHere, 'aura-basetools')))
  fs.rmSync(bundle, { recursive: true, force: true })
}

// ── I DSH 注册：路径必须指向安装目录，且 --doctor 认得出它 ─────────────────
// 两个实测过的缺陷：
//   ① 旧版写相对路径 `'./aura-read/index.js'`——Cordis 对非 `.` 开头直接 import、
//      而 `.` 开头走的是 `new URL(name, baseUrl)`，baseUrl 是 dsh bundle 所在目录，
//      跟 profile 目录、安装目录都无关；实测那条路径不可达。
//   ② --doctor 对 dsh 也按 MCP 的 JSON 判据查 `mcpServers.aura`，而 dsh 注册的是 YAML patch，
//      于是**必然**误报“不对劲”并计进 problems（全新安装却报“不是全部正常”）。
{
  const dshHome = freshHome()
  const profileDir = path.join(dshHome, '.dsh', 'profiles', 'web')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]')
  const reg = runJson(dshHome, ['--yes', '--agents', 'dsh', '--dsh-profile', 'web'])
  check(
    'I1 注册 dsh：写入两个工具行',
    reg.status === 0 && reg.out?.registrations?.some((r) => r.agent === 'dsh' && r.action === 'added'),
    JSON.stringify(reg.out?.registrations?.map((r) => `${r.agent}:${r.action}`)),
  )
  const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  const dshInstall = path.join(dshHome, '.aura', 'pkg', 'node_modules', 'aura-basetools')
  const wantRead = path.join(dshInstall, 'aura-read', 'index.js')
  const wantEdit = path.join(dshInstall, 'aura-edit', 'index.js')
  check('I2 注册 dsh：写的是绝对路径，且指向安装目录', patch.includes(wantRead) && patch.includes(wantEdit), patch.split('\n').filter((l) => l.includes('name:')).join(' | '))
  check('I3 注册 dsh：两条路径都真实可达', fs.existsSync(wantRead) && fs.existsSync(wantEdit))
  check('I4 注册 dsh：不用相对路径（那会相对 dsh 自己的 bundle 目录解析）', !patch.includes("'./aura-read") && !patch.includes('"' + './aura-read'))
  const dshDoctor = spawnSync(process.execPath, [installer, '--home', dshHome, '--doctor'], { encoding: 'utf8' })
  check('I5 --doctor 认得出 dsh 注册（不误报“不对劲”）', dshDoctor.stdout.includes('注册      : dsh 正常'), dshDoctor.stdout.split('\n').find((l) => l.includes('注册')) ?? '')
  check('I6 --doctor 结论仍是全部正常', dshDoctor.stdout.includes('全部正常'), dshDoctor.stdout.trim().split('\n').pop() ?? '')
  check('I7 --doctor 报告插件可加载（不是“文件在”）', dshDoctor.stdout.includes('DSH 加载  : 两个插件都能 import'), dshDoctor.stdout.split('\n').find((l) => l.includes('DSH 加载')) ?? '')

  // I8–I9：**假绿**。`reachable` 曾经只是 `fs.existsSync`：两个 index.js 确实都在，
  // 而宿主 peer（@deepseek-ai/schemastery、dsh-tools）缺失时重启 dsh 会在 import 一步报
  // ERR_MODULE_NOT_FOUND——因为 dsh 只在启动时导入插件模块，这个错要到重启才现形。
  // 实测过的完整链路：安装器报“reachable: true、重启 dsh 生效”，而真实结果是启动报错。
  const peerScope = path.join(dshInstall, '..', '@deepseek-ai')
  const peerHidden = path.join(dshInstall, '..', '_peers-hidden')
  let hid = false
  if (fs.existsSync(peerScope)) {
    fs.renameSync(peerScope, peerHidden)
    hid = true
  }
  const withoutPeers = spawnSync(process.execPath, [installer, '--home', dshHome, '--doctor'], { encoding: 'utf8' })
  const brokenOut = withoutPeers.stdout
  if (hid) fs.renameSync(peerHidden, peerScope)
  check(
    'I8 --doctor 在 peer 缺失时**不再**说全部正常（假绿已修）',
    brokenOut.includes('加载不了') || brokenOut.includes('hostPeers') || withoutPeers.status === 2,
    brokenOut.split('\n').find((l) => l.includes('加载不了')) ?? brokenOut.trim().split('\n').pop() ?? '',
  )
  check('I9 peer 缺失时退出码 2', withoutPeers.status === 2, `exit=${withoutPeers.status}`)
}

// 篡改一个已装文件：体检必须抓到（否则完整性检查就是装饰）
const tampered = path.join(doctorHome, '.aura', 'pkg', 'node_modules', 'aura-basetools', 'lib', 'ops.mjs')
fs.appendFileSync(tampered, '\n// tampered by test\n')
const doctorBad = run(doctorHome, ['--doctor'])
check('G3 --doctor 抓到安装目录被改动（退出码 2）', doctorBad.status === 2 && doctorBad.stdout.includes('不一致'), `exit=${doctorBad.status}`)

// 卸载后体检必须报“不可用”，而不是装作没事
runJson(doctorHome, ['--uninstall'])
const doctorGone = run(doctorHome, ['--doctor'])
check('G4 --doctor 卸载后报安装目录不可用（退出码 2）', doctorGone.status === 2 && doctorGone.stdout.includes('不可用'), `exit=${doctorGone.status}`)
const versionJson = JSON.parse(run(doctorHome, ['--version', '--json']).stdout)
check('G5 --version --json 可解析（卸载后 ok=false）', versionJson.ok === false && versionJson.version === null, JSON.stringify(versionJson).slice(0, 80))

// ── J 默认来源：目录里同时躺着多个 .tgz 时，取**版本号数值最大**的那个 ────────────────
//
// 防的是一个只在**跨大版本**时才现形的错误：旧实现是 `.sort().pop()`（字典序），
// 而字典序里 `0.9.0` 排在 `0.10.0` **后面**（'9' > '1'）——发布目录里同时放着 0.9.0 与 0.10.0 时，
// 默认来源会挑中**旧的那个**。夹具因此故意让“字典序最大”的那个是坏包：
// 挑对了（数值最大 = 好包）⇒ 装成功；回退成字典序 ⇒ 挑中坏包 ⇒ 装失败。
{
  const good = payload.endsWith('.tgz')
    ? payload
    : path.join(root, 'dist', `aura-basetools-${JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8')).version}.tgz`)
  const picksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-install-pick-'))
  createdHomes.push(picksDir)
  fs.copyFileSync(good, path.join(picksDir, 'aura-basetools-0.10.0.tgz'))
  fs.writeFileSync(path.join(picksDir, 'aura-basetools-0.9.0.tgz'), 'not a tarball')
  const pick = runJson(freshHome(), ['--yes'], picksDir)
  check(
    'J1 默认来源：并存多个 .tgz 时取版本号**数值最大**的',
    pick.status === 0 && pick.out?.ok === true,
    `exit=${pick.status} ${String(pick.out?.code ?? pick.out?.reason ?? '').slice(0, 60)}`,
  )

  // 判据对照：那个坏包**真的**装不上。少了这条，J1 通过也可能只是“两个都能装”。
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-install-pick-'))
  createdHomes.push(badDir)
  fs.writeFileSync(path.join(badDir, 'aura-basetools-0.9.0.tgz'), 'not a tarball')
  const badOnly = runJson(freshHome(), ['--yes'], badDir)
  check('J2 判据对照：只有坏 .tgz 时必须失败（证明 J1 不是假绿）', badOnly.status !== 0, `exit=${badOnly.status} ${String(badOnly.out?.code ?? '')}`)
}

// ── K 别的 profile 里藏着的第二份 aura-basetools ─────────────────────────────────
//
// 真事，不是假想：本机 `~/.dsh/profiles/auratest` 是 9/21 23:07 建的实验 profile，
// 依赖 `dist/aura-tools/aura-tools-0.2.1.tgz`（那个 dist 目录后来整个没了），而
// `dsh --profile auratest` **真的会**加载那份 0.2.1 的 aura_read / aura_edit。
// 它躺了 8 天，而三面版本、完整性、注册项、CLI/MCP 自检、全部测试**都是绿的**——
// 因为那些判据都只看得见**本安装目录**，没有一条会往 profile 那一侧看一眼。
// K 段把那一侧钉进体检，三种形态各一条（三种病，三种修法）。
{
  const kHome = freshHome()
  const webDir = path.join(kHome, '.dsh', 'profiles', 'web')
  fs.mkdirSync(webDir, { recursive: true })
  fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), '[]')
  runJson(kHome, ['--yes', '--agents', 'dsh', '--dsh-profile', 'web'])
  const doctor = () => spawnSync(process.execPath, [installer, '--home', kHome, '--doctor'], { encoding: 'utf8' })
  const line = (out) => out.split('\n').find((l) => l.includes('其它安装  :')) ?? ''

  const clean = doctor()
  check(
    'K1 没有第二份时，明说“看了哪几处”而不是静默跳过',
    clean.status === 0 && clean.stdout.includes('看了 2 处（共享 node_modules、web）') && clean.stdout.includes('全部正常'),
    line(clean.stdout),
  )

  // 造一份和真事同形的残留：node_modules 里躺着 0.2.1，声明的包体却已经不存在
  const staleDir = path.join(kHome, '.dsh', 'profiles', 'auratest')
  const gone = path.join(kHome, 'gone', 'aura-basetools-0.2.1.tgz')
  fs.mkdirSync(path.join(staleDir, 'node_modules', 'aura-basetools'), { recursive: true })
  fs.writeFileSync(
    path.join(staleDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-auratest',
      private: true,
      dependencies: { 'aura-basetools': `file:${gone}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'aura-basetools'] } },
    }),
  )
  fs.writeFileSync(
    path.join(staleDir, 'node_modules', 'aura-basetools', 'package.json'),
    JSON.stringify({ name: 'aura-basetools', version: '0.2.1' }),
  )
  const stale = doctor()
  check(
    'K2 残留旧版被点名：退出码 2，且带上 profile 名与那个版本号',
    stale.status === 2 && stale.stdout.includes('profile auratest') && stale.stdout.includes('0.2.1') && stale.stdout.includes('补不回来'),
    line(stale.stdout).trim(),
  )

  // 形态二：包体在、只是版本不是本安装那一份 ⇒ 另一份字节（安装器升级不到它）
  fs.mkdirSync(path.dirname(gone), { recursive: true })
  fs.writeFileSync(gone, 'not a tarball')
  const other = doctor()
  check(
    'K3 版本不同时说的是“另一份字节”，不是“补不回来”（两种病两种修法）',
    other.status === 2 && other.stdout.includes('另一份字节') && !other.stdout.includes('补不回来'),
    line(other.stdout).trim(),
  )

  // 形态三：声明了却根本没装 ⇒ 那个 profile 现在起不来
  fs.rmSync(path.join(staleDir, 'node_modules'), { recursive: true, force: true })
  const missing = doctor()
  check('K4 仅声明未安装时另说一句（起不来）', missing.status === 2 && missing.stdout.includes('但没装'), line(missing.stdout).trim())
}

// 自清：无论前面成败，临时目录（home 与夹具目录）一个都不留
for (const home of createdHomes) fs.rmSync(home, { recursive: true, force: true })

const passed = checks.filter(Boolean).length
process.stdout.write(`\ninstall-test：${passed}/${checks.length} 通过\n`)
process.exitCode = passed === checks.length ? 0 : 1
