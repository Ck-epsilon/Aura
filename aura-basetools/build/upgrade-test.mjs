#!/usr/bin/env node
/**
 * build/upgrade-test.mjs —— 服务化升级（P0）的机械验收：设计文档 §七 的 7 条 + 工作令的硬性要求。
 *
 *   node build/upgrade-test.mjs
 *
 * 怎么做到"真验"而不是"看着像"：
 *   · 每个用例都在 os.tmpdir() 里的**假 HOME** 里真装、真升、真回滚，结束前删干净（绝不碰真实 $HOME）
 *   · 判"完整旧版 / 完整新版 / 半新半旧"用的是**本文件自己的整树哈希**（算法与被测实现的
 *     treeHash 不同），所以"实现自己说自己对"不算数；幂等还额外比 mtime —— 重写一遍内容相同
 *     冒充不了幂等
 *   · 中断安全既走故障缝（AURA_UPGRADE_FAULT=<阶段>），也有**从外面真 SIGKILL** 的用例
 *   · "默认不联网"用 NODE_OPTIONS 注入哨兵替换 fetch：真发请求会被记录下来并使该次调用失败
 *
 * 覆盖：① 幂等 ② 配置零改动 ③ 中断安全 ④ 坏包自动回滚 ⑤ 版本可见（含同版不同字节）
 *       ⑥ 离线可升（本地 zip + 本地清单 + 死代理端口）⑦ 默认不联网，外加边界与退出码契约。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { walkFiles, writeZip } from './zip.mjs'

const installer = path.join(import.meta.dirname, 'install.mjs')
const payload = path.join(process.env.AURA_UPGRADE_TEST_PAYLOAD ?? path.resolve(import.meta.dirname, '..', 'dist', 'aura-basetools'))

// 基准版本从**包体**读，不在测试里写死。
// 教训（0.5.0 发布前的全量闸）：写死的 BASE_VERSION/NEXT_VERSION 在版本一升就与现网同版相撞，
// 安装器正确地报 UPGRADE_SAME_VERSION_DIFFERENT_BYTES，而整套断言因此连锁变红（94 → 63）。
const BASE_VERSION = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8')).version
const NEXT_VERSION = BASE_VERSION.replace(/(\d+)$/, (n) => String(Number(n) + 1))

const checks = []
const check = (label, ok, detail = '') => {
  checks.push(ok)
  process.stdout.write(`${ok ? '✅' : '❌'} ${label}${detail === '' ? '' : `   ${detail}`}\n`)
}
const say = (line) => process.stdout.write(`${line}\n`)

if (!fs.existsSync(path.join(payload, 'package.json'))) {
  say(`❌ 找不到包体：${payload}（先构建 dist/aura-basetools，或用 AURA_UPGRADE_TEST_PAYLOAD 指定）`)
  say('\n--- 0/1 通过 ---')
  process.exit(1)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-upgrade-test-'))
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// ── 假 HOME 与运行器 ─────────────────────────────────────────────────────────

const SEED = {
  toml: '[mcp_servers.existing]\ncommand = "node"\nargs = ["x.mjs"]\n',
  claude: '{"mcpServers":{"tavily":{"command":"npx","args":["-y","tavily-mcp"]}},"numStartups":7}',
  cursor: '{"mcpServers":{}}',
}
const configFiles = (home) => [
  path.join(home, '.codex', 'config.toml'),
  path.join(home, '.claude.json'),
  path.join(home, '.cursor', 'mcp.json'),
]

function makeHome(tag) {
  const home = fs.mkdtempSync(path.join(scratch, `home-${tag}-`))
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  fs.writeFileSync(configFiles(home)[0], SEED.toml)
  fs.writeFileSync(configFiles(home)[1], SEED.claude)
  fs.writeFileSync(configFiles(home)[2], SEED.cursor)
  return home
}

// 联网哨兵：替换 fetch。真发请求 → 记一笔 + 抛错（于是"偷偷联网"不可能静默通过）。
const netLog = path.join(scratch, 'net-attempts.log')
const guardFile = path.join(scratch, 'net-guard.mjs')
fs.writeFileSync(
  guardFile,
  [
    "import fs from 'node:fs'",
    'const log = process.env.AURA_UPGRADE_TEST_NET_LOG',
    'globalThis.fetch = async (url) => {',
    "  fs.appendFileSync(log, `${process.pid} fetch ${String(url)}\\n`)",
    '  throw new Error(`升级测试的联网哨兵：这次调用不允许联网（${String(url)}）`)',
    '}',
    '',
  ].join('\n'),
)
const netEnv = {
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(guardFile).href}`.trim(),
  AURA_UPGRADE_TEST_NET_LOG: netLog,
}
const netAttempts = () => (fs.existsSync(netLog) ? fs.readFileSync(netLog, 'utf8').trim().split('\n').filter((line) => line !== '') : [])

const run = (home, args, extraEnv = {}) =>
  spawnSync(process.execPath, [installer, '--home', home, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...netEnv, AURA_CACHE_DIR: path.join(home, '.aura', 'cache'), ...extraEnv },
  })

const runJson = (home, args, extraEnv = {}) => {
  const res = run(home, args, extraEnv)
  let env = null
  try {
    env = JSON.parse(res.stdout ?? '')
  } catch {
    env = null
  }
  return { status: res.status, env, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** 从外面真杀：等 predicate 成立就 SIGKILL —— 不是让被测程序自己体面退出。 */
async function killWhen(home, args, extraEnv, predicate, timeoutMs = 30000) {
  const child = spawn(process.execPath, [installer, '--home', home, ...args], {
    env: { ...process.env, ...netEnv, AURA_CACHE_DIR: path.join(home, '.aura', 'cache'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const deadline = Date.now() + timeoutMs
  let hit = false
  while (Date.now() < deadline) {
    if (predicate()) {
      hit = true
      break
    }
    if (child.exitCode !== null || child.signalCode !== null) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  const end = await exited
  return { hit, ...end }
}

// ── 路径与判据 ───────────────────────────────────────────────────────────────

const prefixOf = (home, prefix = null) => prefix ?? path.join(home, '.aura', 'pkg')
const pkgDir = (home, prefix = null) => path.join(prefixOf(home, prefix), 'node_modules', 'aura-basetools')
const previousDir = (home, prefix = null) => path.join(prefixOf(home, prefix), 'previous', 'aura-basetools')
const stagingDir = (home, prefix = null) => path.join(prefixOf(home, prefix), 'staging')
const statePathOf = (home, prefix = null) => path.join(prefixOf(home, prefix), 'install.json')
const stateOf = (home, prefix = null) => (fs.existsSync(statePathOf(home, prefix)) ? JSON.parse(fs.readFileSync(statePathOf(home, prefix), 'utf8')) : null)
const versionOf = (dir) => {
  const file = path.join(dir, 'package.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).version : null
}

/** 本文件自己的整树哈希：`相对路径:sha256` 排序后哈希（与被测实现的 treeHash 算法**不同**）。 */
function digest(dir) {
  if (!fs.existsSync(dir)) return null
  const rows = []
  const walk = (current, base = current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, base)
      else rows.push(`${path.relative(base, full).replaceAll('\\', '/')}:${sha(full)}`)
    }
  }
  walk(dir)
  return crypto.createHash('sha256').update(rows.sort().join('\n')).digest('hex')
}

/** 内容 + 每个文件的 mtime/大小：识破"重写一遍内容相同"的假幂等。 */
function fingerprint(dir) {
  if (!fs.existsSync(dir)) return '(缺失)'
  const rows = []
  const walk = (current, base = current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, base)
      else {
        const stat = fs.statSync(full)
        rows.push(`${path.relative(base, full).replaceAll('\\', '/')}:${Math.round(stat.mtimeMs)}:${stat.size}`)
      }
    }
  }
  walk(dir)
  return `${digest(dir)}|${rows.sort().join(',')}`
}

const configDigest = (home) => configFiles(home).map((file) => `${file}:${sha(file)}`).join('|')
/** 只读清单（路径 + 大小 + mtime）：用来证明"真实 $HOME 一个字节没动"。 */
function listing(dir) {
  if (!fs.existsSync(dir)) return '(不存在)'
  const rows = []
  const walk = (current, base = current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, base)
      else {
        const stat = fs.statSync(full)
        rows.push(`${path.relative(base, full)}:${stat.size}:${Math.round(stat.mtimeMs)}`)
      }
    }
  }
  walk(dir)
  return rows.sort().join('\n')
}

// ── 造包体 / 清单 ────────────────────────────────────────────────────────────

/** 基于 dist/aura-basetools 改版本号造一份包体；breakCli 用来造"能解包但预检必失败"的坏包。 */
function makePkg(tag, version, { breakCli = false } = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, `pkg-${tag}-`))
  fs.cpSync(payload, dir, { recursive: true })
  const manifestFile = path.join(dir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  manifest.version = version
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  if (breakCli) fs.writeFileSync(path.join(dir, 'bin', 'aura.mjs'), 'process.exit(3)\n')
  return dir
}

/** 交付包形状的 zip：包体挂在 `aura-basetools/` 下，旁边还躺着别的东西（真实交付包就是这样）。 */
function makeZip(srcDir, outFile) {
  const entries = walkFiles(srcDir).map((item) => ({ name: `aura-basetools/${item.relative}`, data: fs.readFileSync(item.absolute), mode: 0o644 }))
  entries.push({ name: 'aura-basetools-0.0.0-安装说明.md', data: Buffer.from('# 说明\n'), mode: 0o644 })
  entries.push({ name: '一键安装.cmd', data: Buffer.from('@echo off\n'), mode: 0o644 })
  writeZip(entries, outFile)
  return outFile
}

/** 只改第一个条目的 CRC（本地头 + 中央目录）：长度不变、内容一个字节没动，CRC 必然对不上。 */
function patchFirstEntryCrc(file) {
  const raw = fs.readFileSync(file)
  let eocd = -1
  for (let i = raw.length - 22; i >= 0; i -= 1) {
    if (raw.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  const central = raw.readUInt32LE(eocd + 16)
  const local = raw.readUInt32LE(central + 42)
  raw.writeUInt32LE(0xdeadbeef, central + 16)
  raw.writeUInt32LE(0xdeadbeef, local + 14)
  fs.writeFileSync(file, raw)
}

const writeManifest = (file, channel) => fs.writeFileSync(file, `${JSON.stringify({ tool: 'aura-basetools', channels: { stable: channel } }, null, 2)}\n`)

/** 现网那份还能用吗：真 CLI 取景 + 真 MCP 握手（§7.4 要求回滚后两者都可用）。 */
function health(dir) {
  const sample = path.join(scratch, 'sample.mjs')
  if (!fs.existsSync(sample)) fs.writeFileSync(sample, 'export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n')
  const env = { ...process.env, ...netEnv, AURA_CACHE_DIR: path.join(scratch, 'cache') }
  const cli = spawnSync(process.execPath, [path.join(dir, 'bin', 'aura.mjs'), 'read', '--file', sample, '--mode', 'map'], { encoding: 'utf8', timeout: 30000, env })
  const frames = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'upgrade-test', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n')
  const mcp = spawnSync(process.execPath, [path.join(dir, 'bin', 'aura-mcp.mjs')], { input: frames, encoding: 'utf8', timeout: 30000, env })
  const replies = (mcp.stdout ?? '')
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((msg) => msg !== null)
  const names = replies.filter((msg) => Array.isArray(msg.result?.tools)).flatMap((msg) => msg.result.tools.map((tool) => tool.name))
  return {
    cliOk: cli.status === 0 && (cli.stdout ?? '').includes('alpha'),
    mcpOk: names.includes('aura_read') && names.includes('aura_edit'),
    serverInfo: replies.find((msg) => msg.result?.serverInfo !== undefined)?.result.serverInfo ?? null,
  }
}

const realAura = path.join(os.homedir(), '.aura')
const realAuraBefore = listing(realAura)
const install = (home, from = payload, extra = []) => runJson(home, ['--yes', '--from', from, ...extra])

try {
  // ── ① 幂等：同版本 --upgrade → 不写盘、报"已是最新"（§7.1） ──────────────────
  {
    const home = makeHome('idem')
    install(home)
    const live = pkgDir(home)
    const before = { tree: fingerprint(live), state: fs.readFileSync(statePathOf(home), 'utf8') }

    const dirSame = runJson(home, ['--upgrade', '--from', payload, '--json'])
    check(
      '① 幂等：同版本升级（目录来源）退出码 0、upgraded=false、reason=up-to-date',
      dirSame.status === 0 && dirSame.env?.upgraded === false && dirSame.env?.reason === 'up-to-date',
      `exit=${dirSame.status} reason=${String(dirSame.env?.reason)}`,
    )
    check(
      '① 幂等：报"已是最新"，且现网文件内容与 mtime 一个都没变',
      dirSame.stdout.includes('已是最新') && fingerprint(live) === before.tree,
      `指纹${fingerprint(live) === before.tree ? '不变' : '变了'}`,
    )
    check('① 幂等：install.json 一个字节没改', fs.readFileSync(statePathOf(home), 'utf8') === before.state)

    // 归档来源走的是"解包 → 预检 → 版本比对"那条路，同样不许把现网写一遍
    const sameZip = makeZip(payload, path.join(scratch, 'same-version.zip'))
    const zipSame = runJson(home, ['--upgrade', '--from', sameZip, '--json'])
    check(
      '① 幂等：同版本升级（zip 来源）也报"已是最新"、现网与 install.json 仍未变',
      zipSame.status === 0 && zipSame.stdout.includes('已是最新') && fingerprint(live) === before.tree && fs.readFileSync(statePathOf(home), 'utf8') === before.state,
      `exit=${zipSame.status}`,
    )
    check('① 幂等：之后 staging 没留下东西（落脚点自己清掉）', !fs.existsSync(stagingDir(home)))
  }

  // ── ② 配置零改动：升级只换稳定路径里的内容（§7.2） ──────────────────────────
  {
    const home = makeHome('config')
    install(home)
    const live = pkgDir(home)
    const before = { configs: configDigest(home), state: stateOf(home), oldDigest: digest(live) }
    const target = makePkg('config-new', NEXT_VERSION)
    const up = runJson(home, ['--upgrade', '--from', target, '--json'])

    check('② 真升级：退出码 0、版本已升到下一版', up.status === 0 && versionOf(live) === NEXT_VERSION, `exit=${up.status} 版本=${String(versionOf(live))}`)
    check('② 配置零改动：三份客户端配置逐字节相同（路径稳定，升级不用改配置）', configDigest(home) === before.configs)
    check(
      '② 注册项沿用旧那份（否则升级一次就再也卸不干净）',
      JSON.stringify(stateOf(home)?.registrations) === JSON.stringify(before.state?.registrations),
      `registrations=${(stateOf(home)?.registrations ?? []).map((item) => `${item.agent}:${item.action}`).join(',')}`,
    )
    check(
      '② 稳定路径：注册项指的仍是同一个 node_modules/aura-basetools/bin/aura-mcp.mjs',
      fs.readFileSync(configFiles(home)[0], 'utf8').includes(JSON.stringify(path.join(live, 'bin', 'aura-mcp.mjs'))),
    )
    check('② previousVersion 记的是升级前的版本（只有真走升级路径才写这个字段）', stateOf(home)?.previousVersion === BASE_VERSION, `previousVersion=${String(stateOf(home)?.previousVersion)}`)
    check(
      '② 回滚点是完整旧版（逐文件与升级前一致）',
      digest(previousDir(home)) === before.oldDigest,
      `previous=${digest(previousDir(home))?.slice(0, 12)} 旧版=${before.oldDigest?.slice(0, 12)}`,
    )

    const back = runJson(home, ['--uninstall', '--json'])
    check(
      '② 升级后仍能卸干净：三家注册项都撤掉、安装目录清掉',
      back.status === 0 && (back.env?.touched ?? []).join(',') === 'codex:removed,claude:removed,cursor:removed' && !fs.existsSync(path.join(prefixOf(home), 'node_modules')),
      JSON.stringify(back.env?.touched),
    )
    check('② 卸载把 previous/ 与 staging/ 也清了（不留几十 MB 残渣）', !fs.existsSync(path.dirname(previousDir(home))) && !fs.existsSync(stagingDir(home)))
  }

  // ── ③ 中断安全：换名前后的任何时刻被杀，磁盘只能是完整旧版或完整新版（§7.3） ──
  const FAULT_EXPECT = {
    'after-staging': { live: 'old', doctor: 0, why: '解包完成、还没预检，现网没动' },
    'after-precheck': { live: 'old', doctor: 0, why: '预检通过、还没备份，现网没动' },
    'after-backup': { live: 'old', doctor: 0, why: '备份是复制：现网与 previous/ 各有一份完整旧版' },
    'after-clear': { live: 'gap', doctor: 2, why: '两次 rename 之间：现网缺席，previous/ 完整' },
    'after-swap': { live: 'new', doctor: 2, why: '换名完成、终检没跑：现网已是完整新版' },
  }
  for (const [stage, expect] of Object.entries(FAULT_EXPECT)) {
    const home = makeHome(`fault-${stage}`)
    install(home)
    const live = pkgDir(home)
    const oldDigest = digest(live)
    const target = makePkg(`fault-${stage}-new`, NEXT_VERSION)
    const newDigest = digest(target)
    const killed = runJson(home, ['--upgrade', '--from', target, '--json'], { AURA_UPGRADE_FAULT: stage })
    const now = digest(live)
    const doctor = runJson(home, ['--doctor', '--json'])

    check(
      `③ ${stage}：中止时也给 --json 回执（不是"未知参数"）`,
      killed.env !== null && killed.env?.aborted === true,
      `exit=${killed.status} aborted=${String(killed.env?.aborted)}`,
    )
    const liveState = now === oldDigest ? 'old' : now === newDigest ? 'new' : now === null ? 'gap' : 'torn'
    check(`③ ${stage}：现网是「${expect.live === 'old' ? '完整旧版' : expect.live === 'new' ? '完整新版' : '缺席但 previous 完整'}」（${expect.why}）`, liveState === expect.live, `实际=${liveState}`)
    if (expect.live === 'gap') {
      check('③ after-clear：previous/ 里是完整旧版（有东西可恢复）', digest(previousDir(home)) === oldDigest)
      check('③ after-clear：--doctor 退出码 2 且指出 --rollback', doctor.status === 2 && doctor.stdout.includes('--rollback'), `exit=${doctor.status}`)
      const back = runJson(home, ['--rollback', '--json'])
      const healed = health(live)
      check(
        '③ after-clear：--rollback 一步恢复完整旧版，CLI+MCP 立即可用',
        back.status === 0 && digest(live) === oldDigest && versionOf(live) === BASE_VERSION && healed.cliOk && healed.mcpOk,
        `exit=${back.status} 版本=${String(versionOf(live))} cli=${healed.cliOk} mcp=${healed.mcpOk}`,
      )
      check('③ after-clear：恢复后 --doctor 全部正常', runJson(home, ['--doctor', '--json']).env?.ok === true)
    } else if (expect.live === 'old') {
      check(`③ ${stage}：现网 old 且 --doctor 全部正常`, doctor.status === 0 && doctor.env?.ok === true, `exit=${doctor.status}`)
    } else {
      check('③ after-swap：previous/ 里仍是完整旧版（还能退回去）', digest(previousDir(home)) === oldDigest)
      check('③ after-swap：--doctor 退出码 2 并指出下一步命令', doctor.status === 2 && /--upgrade|--rollback/.test(doctor.stdout), `exit=${doctor.status}`)
      const heal = runJson(home, ['--upgrade', '--from', target, '--json'])
      check(
        '③ after-swap：重跑 --upgrade 自己收尾（补终检与状态），之后 --doctor 全部正常',
        heal.status === 0 && runJson(home, ['--doctor', '--json']).env?.ok === true && versionOf(live) === NEXT_VERSION,
        `exit=${heal.status} 版本=${String(versionOf(live))}`,
      )
    }
  }

  // 故障缝是"程序自己体面退出"；真正的中断是**外面把进程杀掉**。
  // AURA_UPGRADE_FAULT_DELAY_MS 让它在那一刻同步停住，测试据此从外面 SIGKILL。
  {
    const home = makeHome('kill-gap')
    install(home)
    const live = pkgDir(home)
    const oldDigest = digest(live)
    const target = makePkg('kill-gap-new', NEXT_VERSION)
    const killed = await killWhen(home, ['--upgrade', '--from', target, '--json'], { AURA_UPGRADE_FAULT: 'after-clear', AURA_UPGRADE_FAULT_DELAY_MS: '30000' }, () => !fs.existsSync(live))
    check(
      '③ 真 SIGKILL（换名中间那一瞬）：是外部杀掉的中途状态，不是程序自己走完',
      killed.hit && killed.code !== 0,
      `hit=${killed.hit} code=${String(killed.code)} signal=${String(killed.signal)}`,
    )
    check('③ 真 SIGKILL 后：现网缺席但 previous/ 里是完整旧版（没有半新半旧）', !fs.existsSync(live) && digest(previousDir(home)) === oldDigest)
    const doctor = runJson(home, ['--doctor', '--json'])
    check('③ 真 SIGKILL 后：--doctor 认得出这个局面并给出 --rollback', doctor.status === 2 && doctor.stdout.includes('--rollback'), `exit=${doctor.status}`)
    const back = runJson(home, ['--rollback', '--json'])
    const healed = health(live)
    check(
      '③ 真 SIGKILL 后：--rollback 恢复完整旧版且 CLI+MCP 可用',
      back.status === 0 && digest(live) === oldDigest && healed.cliOk && healed.mcpOk,
      `exit=${back.status} cli=${healed.cliOk} mcp=${healed.mcpOk}`,
    )
  }
  {
    const home = makeHome('kill-swap')
    install(home)
    const live = pkgDir(home)
    const oldDigest = digest(live)
    const target = makePkg('kill-swap-new', NEXT_VERSION)
    const newDigest = digest(target)
    const killed = await killWhen(home, ['--upgrade', '--from', target, '--json'], { AURA_UPGRADE_FAULT: 'after-swap', AURA_UPGRADE_FAULT_DELAY_MS: '30000' }, () => versionOf(live) === NEXT_VERSION)
    check('③ 真 SIGKILL（换名完成之后）：现网是完整新版、previous/ 是完整旧版', killed.hit && digest(live) === newDigest && digest(previousDir(home)) === oldDigest)
    const back = runJson(home, ['--rollback', '--json'])
    const healed = health(live)
    check(
      '③ 真 SIGKILL 后还能 --rollback 退回完整旧版（CLI+MCP 可用）',
      back.status === 0 && digest(live) === oldDigest && healed.cliOk && healed.mcpOk,
      `exit=${back.status}`,
    )
    check('③ 真 SIGKILL 后 --rollback 收尾干净：--doctor 全部正常', runJson(home, ['--doctor', '--json']).env?.ok === true)
  }

  // ── ④ 坏包自动回滚（§7.4） ──────────────────────────────────────────────────
  {
    const home = makeHome('bad-pkg')
    install(home)
    const live = pkgDir(home)
    const before = { tree: fingerprint(live), state: fs.readFileSync(statePathOf(home), 'utf8') }
    const bad = makePkg('bad-cli', NEXT_VERSION, { breakCli: true })
    const rejected = runJson(home, ['--upgrade', '--from', bad, '--json'])

    check(
      '④ 坏包（预检必失败）：结构化拒绝 退出码 2 / ok=false / code=UPGRADE_PRECHECK_FAILED',
      rejected.status === 2 && rejected.env?.ok === false && rejected.env?.code === 'UPGRADE_PRECHECK_FAILED',
      `exit=${rejected.status} code=${String(rejected.env?.code)}`,
    )
    check(
      '④ 坏包：回执带原始失败原因 + stage/from/to/liveUntouched',
      rejected.env?.stage === 'precheck' &&
        rejected.env?.from === BASE_VERSION &&
        rejected.env?.to === NEXT_VERSION &&
        rejected.env?.liveUntouched === true &&
        String(rejected.env?.cli).includes('exit=3'),
      `stage=${String(rejected.env?.stage)} from=${String(rejected.env?.from)} to=${String(rejected.env?.to)} cli=${String(rejected.env?.cli)}`,
    )
    check(
      '④ 坏包：现网一个字节都没变（含 mtime）且 install.json 未改',
      fingerprint(live) === before.tree && fs.readFileSync(statePathOf(home), 'utf8') === before.state,
    )
    const afterReject = health(live)
    check('④ 坏包：旧版仍可用（CLI 与 MCP 自检都过）', afterReject.cliOk && afterReject.mcpOk, `cli=${afterReject.cliOk} mcp=${afterReject.mcpOk}`)
    check('④ 坏包：--doctor 仍报全部正常', runJson(home, ['--doctor', '--json']).env?.ok === true)
    check('④ 坏包：坏的那份留在 staging 供排查（不删证据）', versionOf(path.join(stagingDir(home), 'aura-basetools')) === NEXT_VERSION)

    // 坏包的第二、三种：CRC 被改（长度对、内容被翻）与截断的 zip
    const goodZip = makeZip(makePkg('zip-good', NEXT_VERSION), path.join(scratch, 'good-0.5.0.zip'))
    const crcZip = path.join(scratch, 'crc-broken-0.5.0.zip')
    fs.copyFileSync(goodZip, crcZip)
    patchFirstEntryCrc(crcZip)
    const crcRun = runJson(home, ['--upgrade', '--from', crcZip, '--json'])
    check(
      '④ 坏 zip（CRC 对不上、长度没变）：拒绝并说出期望/实际 CRC',
      crcRun.status === 2 && /CRC 对不上/.test(String(crcRun.env?.reason)) && /期望 [0-9a-f]{8}，实际 [0-9a-f]{8}/.test(String(crcRun.env?.reason)),
      String(crcRun.env?.reason).slice(0, 110),
    )
    const fullZip = fs.readFileSync(goodZip)
    const shortZip = path.join(scratch, 'short-0.5.0.zip')
    fs.writeFileSync(shortZip, fullZip.subarray(0, Math.floor(fullZip.length / 2)))
    const shortRun = runJson(home, ['--upgrade', '--from', shortZip, '--json'])
    check(
      '④ 截断的 zip：转成结构化拒绝（不是裸 RangeError）',
      shortRun.status === 2 && shortRun.env?.code === 'PAYLOAD_REJECTED' && !/RangeError/.test(String(shortRun.env?.reason)) && /截断|断掉/.test(String(shortRun.env?.reason)),
      String(shortRun.env?.reason).slice(0, 110),
    )
    check('④ 三次坏包之后：现网仍是完整当前版，指纹一个字节没变', versionOf(live) === BASE_VERSION && fingerprint(live) === before.tree)
  }

  // 终检失败 → 自动回滚（§4.2 第 9 步；坏的那份不进 previous/）
  {
    const home = makeHome('final-check')
    install(home)
    const live = pkgDir(home)
    const oldDigest = digest(live)
    const target = makePkg('final-check-new', NEXT_VERSION)
    const failed = runJson(home, ['--upgrade', '--from', target, '--json'], { AURA_UPGRADE_FAULT: 'final-check' })

    check(
      '④ 终检失败：退出码 2、回执说"终检失败 → 已回滚到旧版"',
      failed.status === 2 && failed.env?.code === 'UPGRADE_FINAL_CHECK_FAILED_ROLLED_BACK' && failed.env?.rolledBackTo === BASE_VERSION && /终检失败/.test(String(failed.env?.reason)),
      `exit=${failed.status} code=${String(failed.env?.code)} rolledBackTo=${String(failed.env?.rolledBackTo)}`,
    )
    check(
      '④ 终检失败：磁盘回到完整旧版（坏的那份没进 previous/）',
      digest(live) === oldDigest && versionOf(live) === BASE_VERSION && !fs.existsSync(previousDir(home)),
      `版本=${String(versionOf(live))}`,
    )
    const healed = health(live)
    check('④ 终检失败：旧版 CLI + MCP 立刻可用，--doctor 全部正常', healed.cliOk && healed.mcpOk && runJson(home, ['--doctor', '--json']).env?.ok === true, `cli=${healed.cliOk} mcp=${healed.mcpOk}`)
    const parked = fs.existsSync(stagingDir(home)) ? fs.readdirSync(stagingDir(home)).filter((name) => name.startsWith('failed-')) : []
    check(
      '④ 终检失败：坏的那份留在 staging/failed-* 供排查',
      parked.length === 1 && versionOf(path.join(stagingDir(home), parked[0])) === NEXT_VERSION,
      `parked=${parked.join(',') || '(无)'}`,
    )
    const refuse = runJson(home, ['--rollback', '--json'])
    check('④ 终检失败后 --rollback 不会把坏的那份换上来（退出码 2、ROLLBACK_NO_PREVIOUS）', refuse.status === 2 && refuse.env?.code === 'ROLLBACK_NO_PREVIOUS', `exit=${refuse.status} code=${String(refuse.env?.code)}`)
  }

  // 换名被占用（Windows 实测的那种痛点：正在跑的 MCP 会话 / DSH 宿主还开着包里的文件）：
  // 必须明确报出 + 保持现网不动，绝不硬来、绝不半换。
  {
    const home = makeHome('occupied')
    install(home)
    const live = pkgDir(home)
    const before = { tree: fingerprint(live), state: fs.readFileSync(statePathOf(home), 'utf8') }
    const target = makePkg('occupied-new', NEXT_VERSION)
    // 本测试进程开着现网里的一个文件：Windows 上这就足以让目录 rename 失败（EPERM）
    const held = fs.openSync(path.join(live, 'lib', 'ops.mjs'), 'r')
    const occupied = runJson(home, ['--upgrade', '--from', target, '--json'])
    fs.closeSync(held)
    check(
      '换名被占用：退出码 2 + code=UPGRADE_SWAP_OCCUPIED，并说清"让开哪个面"',
      occupied.status === 2 && occupied.env?.code === 'UPGRADE_SWAP_OCCUPIED' && /被占用/.test(String(occupied.env?.reason)) && /重开|重启/.test(String(occupied.env?.reason)),
      `exit=${occupied.status} code=${String(occupied.env?.code)}`,
    )
    check(
      '换名被占用：现网一个字节没变（含 mtime）、install.json 未改、没留下半新半旧',
      fingerprint(live) === before.tree && fs.readFileSync(statePathOf(home), 'utf8') === before.state && versionOf(live) === BASE_VERSION,
      `版本=${String(versionOf(live))}`,
    )
    check('换名被占用：没有留下"与现网相同"的假 previous（升级没发生就不该有回滚点）', !fs.existsSync(previousDir(home)))
    check('换名被占用：--doctor 仍报全部正常（没留下未收尾的残局）', runJson(home, ['--doctor', '--json']).env?.ok === true)
    const retry = runJson(home, ['--upgrade', '--from', target, '--json'])
    check('换名被占用：占用让开后重跑同一条升级就成功', retry.status === 0 && versionOf(live) === NEXT_VERSION, `exit=${retry.status} 版本=${String(versionOf(live))}`)
  }

  // ── ⑤ 版本可见：构建戳/树哈希/三面版本（§7.5） ──────────────────────────────
  {
    const home = makeHome('visible')
    install(home)
    const live = pkgDir(home)
    const versionText = run(home, ['--version'])
    const versionJson = runJson(home, ['--version', '--json'])
    check(
      '⑤ --version 文本里看得到构建戳与完整树哈希',
      /构建戳/.test(versionText.stdout) && /内容哈希/.test(versionText.stdout) && versionText.stdout.includes(String(versionJson.env?.treeHash)),
      versionText.stdout.trim().split('\n')[0] ?? '',
    )
    check(
      '⑤ --version --json 的 treeHash/buildStamp 与 install.json 记录一致',
      typeof versionJson.env?.treeHash === 'string' && versionJson.env.treeHash.length === 64 && versionJson.env.buildStamp === stateOf(home)?.buildStamp && versionJson.env.treeHash === stateOf(home)?.treeHash,
      `buildStamp=${String(versionJson.env?.buildStamp)}`,
    )

    const target = makePkg('visible-new', NEXT_VERSION)
    runJson(home, ['--upgrade', '--from', target, '--json'])
    const doctor = runJson(home, ['--doctor', '--json'])
    check(
      '⑤ --doctor --json 三面版本齐全，且 CLI/MCP/DSH 都是新装版本',
      doctor.env?.surfaces?.cli?.version === NEXT_VERSION && doctor.env?.surfaces?.mcp?.version === NEXT_VERSION && doctor.env?.surfaces?.dsh?.version === NEXT_VERSION,
      JSON.stringify({ cli: doctor.env?.surfaces?.cli?.version, mcp: doctor.env?.surfaces?.mcp?.version, dsh: doctor.env?.surfaces?.dsh?.version }),
    )
    check(
      '⑤ 握手里的 serverInfo.version 与新装版本一致（正在应答的进程就是磁盘这一份）',
      doctor.env?.surfaces?.mcp?.serverInfo?.version === NEXT_VERSION,
      `serverInfo=${JSON.stringify(doctor.env?.surfaces?.mcp?.serverInfo)}`,
    )
    check(
      '⑤ --doctor 的 treeHash/buildStamp 与 install.json 记录一致，且 DSH 补丁路径可达',
      doctor.env?.treeHash === stateOf(home)?.treeHash && doctor.env?.buildStamp === stateOf(home)?.buildStamp && doctor.env?.surfaces?.dsh?.reachable === true,
    )

    // 同版不同字节：版本号一样、内容不一样 → 必须判出来（§九 P0 必做）
    const twin = makePkg('visible-twin', NEXT_VERSION)
    fs.writeFileSync(path.join(twin, 'TWIN.txt'), 'same version, different bytes\n')
    const twinRun = runJson(home, ['--upgrade', '--from', twin, '--json'])
    check(
      '⑤ 同版不同字节：拒绝换（退出码 2、code=UPGRADE_SAME_VERSION_DIFFERENT_BYTES）',
      twinRun.status === 2 && twinRun.env?.code === 'UPGRADE_SAME_VERSION_DIFFERENT_BYTES',
      `exit=${twinRun.status} code=${String(twinRun.env?.code)}`,
    )
    check('⑤ 同版不同字节之后现网没被动（版本与树哈希都不变）', versionOf(live) === NEXT_VERSION && doctor.env?.treeHash === stateOf(home)?.treeHash)

    // 装完之后被人改过：体检必须抓得到（treeHash 与清单同时报警）
    fs.appendFileSync(path.join(live, 'lib', 'ops.mjs'), '\n// tampered by upgrade-test\n')
    const tampered = runJson(home, ['--doctor', '--json'])
    check(
      '⑤ 装完后被动过：--doctor 抓得到（exit 2、ok=false、磁盘树哈希变了）',
      tampered.status === 2 && tampered.env?.ok === false && tampered.env?.treeHash !== doctor.env?.treeHash,
      `exit=${tampered.status} 哈希${tampered.env?.treeHash === doctor.env?.treeHash ? '没变' : '变了'}`,
    )
  }

  // ── ⑥ 离线可升：本地 zip + 本地清单 + 死代理端口（§7.6） ────────────────────
  {
    const deadProxy = { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' }
    const home = makeHome('offline')
    install(home)
    const live = pkgDir(home)
    const zip = makeZip(makePkg('offline-new', NEXT_VERSION), path.join(scratch, 'offline-0.5.0.zip'))
    const otherZip = makeZip(makePkg('offline-other', '0.5.1'), path.join(scratch, 'offline-0.5.1.zip'))
    const manifestFile = path.join(scratch, 'manifest-0.5.0.json')
    writeManifest(manifestFile, { version: NEXT_VERSION, url: './offline-0.5.0.zip', sha256: sha(zip), minNode: '18' })

    const pre = runJson(home, ['--check', '--manifest', manifestFile, '--json'], deadProxy)
    check(
      '⑥ --check（本地清单，死代理）：退出码 0、current/available/upgrade 齐全',
      pre.status === 0 && pre.env?.current?.version === BASE_VERSION && pre.env?.available?.version === NEXT_VERSION && pre.env?.upgrade === true,
      `exit=${pre.status} current=${String(pre.env?.current?.version)} available=${String(pre.env?.available?.version)}`,
    )
    check('⑥ --check：回执 network=false（清单是本地文件，没碰网络）', pre.env?.network === false, `network=${String(pre.env?.network)}`)

    const up = runJson(home, ['--upgrade', '--from', zip, '--manifest', manifestFile, '--json'], deadProxy)
    check(
      '⑥ 离线升级（--from 本地 zip + --manifest 本地清单）：退出码 0、版本到下一版',
      up.status === 0 && versionOf(live) === NEXT_VERSION && up.env?.network === false,
      `exit=${up.status} 版本=${String(versionOf(live))}`,
    )
    const post = runJson(home, ['--check', '--manifest', manifestFile, '--json'], deadProxy)
    check('⑥ 升级后再 --check：报不可升（当前=可用）', post.status === 0 && post.env?.upgrade === false, `upgrade=${String(post.env?.upgrade)}`)

    // 清单驱动的纯离线升级（不给 --from，url 用相对路径）
    const home2 = makeHome('offline-manifest-only')
    install(home2)
    const up2 = runJson(home2, ['--upgrade', '--manifest', manifestFile, '--json'], deadProxy)
    check(
      '⑥ 只给 --manifest（url 是相对路径）也能离线升上去',
      up2.status === 0 && versionOf(pkgDir(home2)) === NEXT_VERSION,
      `exit=${up2.status} 版本=${String(versionOf(pkgDir(home2)))}`,
    )

    const badManifest = path.join(scratch, 'manifest-sha-mismatch.json')
    // 这一条要测的是"清单 sha256 与实际字节不符"：用**明确更高**的版本（避开与现网同版的 up-to-date 短路），
    // 引用的包体就用手上这份**存在**的 zip，sha256 故意给错的。版本写死过 '0.5.1'，发布一升版本就自撞。
    writeManifest(badManifest, { version: '9.9.9', url: zip, sha256: 'deadbeef'.repeat(8), minNode: '18' })
    const shaRun = runJson(home2, ['--upgrade', '--manifest', badManifest, '--json'], deadProxy)
    check(
      '⑥ 包体字节对不上清单 sha256：拒绝（退出码 2、期望与实际都给出）',
      shaRun.status === 2 && shaRun.env?.code === 'UPGRADE_SHA256_MISMATCH' && /期望 sha256 [0-9a-f]{64}/.test(String(shaRun.env?.reason)) && /实际 [0-9a-f]{64}/.test(String(shaRun.env?.reason)),
      String(shaRun.env?.reason).slice(0, 110),
    )
    check('⑥ 校验失败后现网没动（版本仍是当前版）', versionOf(pkgDir(home2)) === NEXT_VERSION)

    // 相对 url 的解析基准：清单放子目录、zip 与它并排，CWD 是项目根、--home 是另一个临时目录
    // —— 只有"相对清单自己"这个基准能让这条通过（相对 CWD 或相对 --home 都会找不到包体）
    // 清单的其余字段也要真的起作用：不是我们的清单 / 没这个渠道 / Node 版本不够
    const alienManifest = path.join(scratch, 'manifest-alien.json')
    fs.writeFileSync(alienManifest, `${JSON.stringify({ tool: 'someone-else', channels: { stable: { version: '9.9.9', url: './offline-0.5.0.zip' } } }, null, 2)}\n`)
    const alien = runJson(home2, ['--check', '--manifest', alienManifest, '--json'])
    check('⑥ 清单不是 aura-basetools 的：结构化拒绝（MANIFEST_REJECTED）', alien.status === 2 && alien.env?.code === 'MANIFEST_REJECTED', `exit=${alien.status} code=${String(alien.env?.code)}`)
    const noChannel = runJson(home2, ['--check', '--manifest', manifestFile, '--channel', 'beta', '--json'])
    check('⑥ 清单里没有 beta 渠道：结构化拒绝并列出有哪些渠道', noChannel.status === 2 && noChannel.env?.code === 'MANIFEST_REJECTED' && /stable/.test(String(noChannel.env?.reason)), String(noChannel.env?.reason).slice(0, 80))
    const needNewNode = path.join(scratch, 'manifest-min-node.json')
    writeManifest(needNewNode, { version: NEXT_VERSION, url: './offline-0.5.0.zip', sha256: sha(zip), minNode: '999' })
    const minNode = runJson(home2, ['--upgrade', '--manifest', needNewNode, '--json'])
    check(
      '⑥ 清单要求 Node ≥999：升级被拒（UPGRADE_MIN_NODE，带上要求与当前版本）',
      minNode.status === 2 && minNode.env?.code === 'UPGRADE_MIN_NODE' && /999/.test(String(minNode.env?.reason)) && /当前是/.test(String(minNode.env?.reason)),
      String(minNode.env?.reason).slice(0, 80),
    )
    const minNodeCheck = runJson(home2, ['--check', '--manifest', needNewNode, '--json'])
    check(
      '⑥ --check 遇到 Node 要求不满足：只如实报要求（按 §4.3，--check 仍退出码 0）',
      minNodeCheck.status === 0 && minNodeCheck.env?.available?.minNode === '999',
      `exit=${minNodeCheck.status} minNode=${String(minNodeCheck.env?.available?.minNode)}`,
    )

    const nested = path.join(scratch, 'nested', 'inner')
    fs.mkdirSync(nested, { recursive: true })
    fs.copyFileSync(zip, path.join(nested, 'aura-basetools-0.5.0.zip'))
    const nestedManifest = path.join(nested, 'manifest.json')
    writeManifest(nestedManifest, { version: NEXT_VERSION, url: './aura-basetools-0.5.0.zip', sha256: sha(zip), minNode: '18' })
    const home3 = makeHome('offline-nested')
    install(home3)
    const up3 = runJson(home3, ['--upgrade', '--manifest', nestedManifest, '--json'], deadProxy)
    check(
      '⑥ 相对 url 的基准是"清单自己"（清单在子目录里、zip 与它并排）',
      up3.status === 0 && versionOf(pkgDir(home3)) === NEXT_VERSION && /来源      : 清单里的/.test(up3.stdout),
      `exit=${up3.status} 版本=${String(versionOf(pkgDir(home3)))}`,
    )
    check('⑥ 离线流程里 sh256/清单都对不上时也没联网（哨兵日志为空）', netAttempts().length === 0, JSON.stringify(netAttempts().slice(0, 3)))
  }

  // ── ⑦ 默认不联网（§7.7） ────────────────────────────────────────────────────
  {
    const home = makeHome('nofetch')
    install(home)
    const noManifest = runJson(home, ['--check', '--json'])
    check(
      '⑦ --check（没给清单）：退出码 0，且明说"默认不联网、这次不回答有没有新版"',
      noManifest.status === 0 && noManifest.env?.available === null && /不联网/.test(String(noManifest.env?.note)),
      String(noManifest.env?.note).slice(0, 80),
    )
    check(
      '⑦ 源码里只有 download() 一处 await fetch（新增联网点会在这里被抓住）',
      (fs.readFileSync(installer, 'utf8').match(/await fetch\(/g) ?? []).length === 1,
      `await fetch 出现 ${(fs.readFileSync(installer, 'utf8').match(/await fetch\(/g) ?? []).length} 次`,
    )
    check(
      '⑦ 整条套件零联网尝试（装/升/回滚/check/doctor/version 的哨兵日志为空）',
      netAttempts().length === 0,
      JSON.stringify(netAttempts().slice(0, 3)),
    )
    // 正向对照：如果哨兵根本没生效、"日志为空"就什么也证明不了。
    // --check-url 是唯一的显式联网开关，它必须真的去联网（被哨兵挡下并记一笔）。
    const viaUrl = runJson(home, ['--check-url', 'https://example.invalid/aura-basetools-manifest.json', '--json'])
    check(
      '⑦ 正向对照：--check-url（唯一的显式联网开关）确实去联网了（被哨兵挡下并记账）',
      viaUrl.status === 2 && viaUrl.env?.code === 'MANIFEST_REJECTED' && netAttempts().length > 0,
      `exit=${viaUrl.status} code=${String(viaUrl.env?.code)} 联网尝试=${netAttempts().length}`,
    )
  }

  // ── 边界与退出码契约（工作令的硬性要求） ────────────────────────────────────
  {
    // 只在 --prefix 之内动手：给了 --prefix，<home>/.aura 根本不该出现
    const home = makeHome('prefix')
    const prefix = path.join(scratch, 'external-prefix')
    const fresh = install(home, payload, ['--prefix', prefix, '--json'])
    // 配置的指纹要在**装完之后**取：装的时候本来就会写注册项，那是本次安装的动作，不是升级造成的
    const configsBefore = configDigest(home)
    const target = makePkg('prefix-new', NEXT_VERSION)
    const up = runJson(home, ['--upgrade', '--from', target, '--prefix', prefix, '--json'])
    check(
      '边界：--prefix 生效（文件只落在 prefix 里，<home>/.aura 没被建出来）',
      fresh.status === 0 && up.status === 0 && !fs.existsSync(path.join(home, '.aura')) && versionOf(pkgDir(home, prefix)) === NEXT_VERSION,
      `fresh=${fresh.status} upgrade=${up.status} 版本=${String(versionOf(pkgDir(home, prefix)))}`,
    )
    check('边界：给了 --prefix 时三份客户端配置仍逐字节未动', configDigest(home) === configsBefore)
    check(
      '边界：整个套件没往真实 $HOME 写东西（~/.aura 清单逐项含 mtime 不变）',
      listing(realAura) === realAuraBefore,
      realAuraBefore === '(不存在)' ? '~/.aura 之前不存在、现在仍不存在' : '逐项比对一致',
    )

    const noSource = run(home, ['--upgrade'])
    check('退出码：--upgrade 缺来源 → 1（用法错，不是结构化拒绝）', noSource.status === 1 && /用法错误/.test(noSource.stderr), `exit=${noSource.status}`)
    const unknownFlag = run(home, ['--frobnicate'])
    check('退出码：不认识的参数 → 1（用法错）', unknownFlag.status === 1 && /用法错误/.test(unknownFlag.stderr), `exit=${unknownFlag.status}`)
    const twoActions = run(home, ['--version', '--doctor'])
    check('退出码：一次给两个动作 → 1（用法错）', twoActions.status === 1, `exit=${twoActions.status}`)
    const manifestAlone = run(home, ['--manifest', 'x.json'])
    check('退出码：--manifest 没配 --check/--upgrade → 1（用法错）', manifestAlone.status === 1, `exit=${manifestAlone.status}`)
    const noPrevious = runJson(home, ['--rollback', '--json'])
    check('退出码：没有 previous 就 --rollback → 2（结构化拒绝 + ok=false）', noPrevious.status === 2 && noPrevious.env?.ok === false, `exit=${noPrevious.status}`)

    const dryHome = makeHome('dry-run')
    const dry = runJson(dryHome, ['--upgrade', '--from', target, '--dry-run', '--json'])
    check(
      '预演：--upgrade --dry-run 退出码 0 且一个文件都没建（连 --home 下的 .aura 都没有）',
      dry.status === 0 && dry.env?.dryRun === true && !fs.existsSync(path.join(dryHome, '.aura')),
      `exit=${dry.status} dryRun=${String(dry.env?.dryRun)}`,
    )
    const plan = (dry.env?.notes ?? []).join('\n')
    check('预演：把 1–10 步都列出来了', /备份/.test(plan) && /换名/.test(plan) && /终检/.test(plan) && /回滚/.test(plan), `计划的 ${(dry.env?.notes ?? []).length} 行`)
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

const passed = checks.filter(Boolean).length
say(`\n--- ${passed}/${checks.length} 通过 ---`)
process.exitCode = passed === checks.length ? 0 : 1
