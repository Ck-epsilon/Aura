#!/usr/bin/env node
/**
 * audit-upgrade-probe.mjs —— **审计方自己写**的升级验收探针（不是实现者提供的那份）。
 *
 *   node build/audit-upgrade-probe.mjs
 *
 * 为什么另写一份：实现者写的测试天然偏向自己实现的语义（"作者自己写测试"是循环论证）。
 * 这里按**外部可观察行为**独立打，并且刻意防住两种"假通过"：
 *   ① 「指令没实现、落回普通安装」——用 mtime 指纹识破：普通安装会**重写**安装树（内容相同、mtime 变），
 *      真幂等必须一个文件都不碰；并且要求 `install.json.previousVersion` 这类只有升级路径才会写的字段。
 *   ② 「未知参数退出 2」冒充「正确地拒绝坏包」——每条功能断言先要求**结构化 JSON 回包**。
 *
 * 六件事：① 幂等不写盘 ② 真升级且配置零改动 ③ 坏包被预检挡住、现网一字节不变
 *        ④ 中断安全（按阶段断言**期望状态**，不是"要么旧要么新"这种宽判据）⑤ 离线可升（死代理端口）⑥ 回滚
 *
 * 对接口尚未实现的状态这个探针会红——它是我这边的验收规格，不是产品测试。
 * 纪律：只用 `--home <临时目录>`；**绝不触碰真实 $HOME**；结束前删净临时目录。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const installer = path.join(root, 'build', 'install.mjs')
const goodPayload = path.join(root, 'dist', 'aura-basetools')

const checks = []
const say = (line) => process.stdout.write(`${line}\n`)
const check = (label, ok, detail = '') => {
  checks.push(ok)
  say(`${ok ? '✅' : '❌'} ${label}${detail === '' ? '' : `   ${detail}`}`)
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const treeHash = (dir, base = dir, out = {}) => {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) treeHash(full, base, out)
    else out[path.relative(base, full).replaceAll('\\', '/')] = sha(full)
  }
  return out
}
const treeDigest = (dir) => crypto.createHash('sha256').update(JSON.stringify(treeHash(dir))).digest('hex')

/**
 * 内容哈希 + 每个文件的 mtime。
 * 为什么要带 mtime：`--upgrade` 若没实现、落回普通安装，安装树会被**重写**——内容一样、时间不一样。
 * 只比内容哈希的话，"假升级"会冒充"幂等"（我第一次跑就是这么被骗过去的）。
 */
const fingerprint = (dir) => {
  const rows = []
  const walk = (current, base = current) => {
    if (!fs.existsSync(current)) return
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
  return `${treeDigest(dir)}|${rows.sort().join(',')}`
}
const statePathOf = (dir) => path.join(dir, '.aura', 'pkg', 'install.json')
const stateOf = (dir) => (fs.existsSync(statePathOf(dir)) ? JSON.parse(fs.readFileSync(statePathOf(dir), 'utf8')) : null)
const versionOf = (dir) => {
  const manifest = path.join(dir, '.aura', 'pkg', 'node_modules', 'aura-basetools', 'package.json')
  return fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).version : null
}

function home(seed = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-upgrade-'))
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true })
  if (seed) {
    fs.writeFileSync(path.join(dir, '.codex', 'config.toml'), '[mcp_servers.existing]\ncommand = "node"\n')
    fs.writeFileSync(path.join(dir, '.claude.json'), '{"mcpServers":{"tavily":{"command":"npx"}},"numStartups":7}')
    fs.writeFileSync(path.join(dir, '.cursor', 'mcp.json'), '{"mcpServers":{}}')
  }
  return dir
}
const run = (dir, args, extraEnv = {}) =>
  spawnSync(process.execPath, [installer, '--home', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AURA_CACHE_DIR: path.join(dir, '.aura', 'cache'), ...extraEnv },
  })
/**
 * 跑一条命令并**要求它给出结构化 JSON 回包**。
 * 为什么必要：`--upgrade` 这类开关在实现之前会被当成"不认识的参数"退出 2，而"拒绝"也退出 2
 * —— 不做这层区分，"未知参数"会伪装成"正确地拒绝了坏包"（我第一次跑就踩到）。
 */
const runJson = (dir, args, extraEnv = {}) => {
  const res = run(dir, args, extraEnv)
  let env = null
  try {
    env = JSON.parse(res.stdout)
  } catch {
    env = null
  }
  return { status: res.status, env, stderr: res.stderr }
}
const configHashes = (dir) =>
  [path.join(dir, '.codex', 'config.toml'), path.join(dir, '.claude.json'), path.join(dir, '.cursor', 'mcp.json')]
    .map(sha)
    .join(':')
/** 造一份"版本更高、自检能过"的包（用于真升级）或"预检必失败"的包（用于坏包）。 */
function makePayload(tag, version, { breakCli = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `audit-${tag}-`))
  fs.cpSync(goodPayload, dir, { recursive: true })
  const manifest = path.join(dir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  pkg.version = version
  fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
  if (breakCli) fs.writeFileSync(path.join(dir, 'bin', 'aura.mjs'), 'process.exit(3)\n')
  return dir
}

/**
 * 真实 home 的清单快照（含 mtime）。
 * 为什么探针必须有这一条：本轮真实事故就是"某次外部运行忘了 `--home`"，
 * 把一整套安装写进了真实 `~/.aura/pkg`（B 的升级测试靠同款断言抓到了，我的探针当时没有）。
 * 写入真实 home 是**事故**，不是副作用——所以它必须能把探针判红。
 */
const listingOf = (dir) => {
  if (!fs.existsSync(dir)) return '(不存在)'
  const rows = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        const stat = fs.statSync(full)
        rows.push(`${path.relative(dir, full)}:${Math.round(stat.mtimeMs)}:${stat.size}`)
      }
    }
  }
  walk(dir)
  return rows.sort().join('|')
}
const realAura = path.join(os.homedir(), '.aura')
const realAuraBefore = listingOf(realAura)
const realCodex = path.join(os.homedir(), '.codex', 'config.toml')
const realCodexBefore = fs.existsSync(realCodex) ? sha(realCodex) : null

const cleanup = []
try {
  // ── 0 基线 ────────────────────────────────────────────────────────────────
  const h1 = home()
  cleanup.push(h1)
  const first = runJson(h1, ['--yes', '--from', goodPayload, '--json'])
  check('0 基线：装得上且自检过', first.status === 0 && first.env !== null, `exit=${first.status}`)
  // 基线装不上就**干净退出**：探针在实现中途跑是常态（重构会把安装路径暂时弄坏），
  // 崩在 `.split of null` 上只会给出一堆栈，不如直接说清"基线装不上、后面的判据无意义"。
  const baseVersion = versionOf(h1)
  if (baseVersion === null) {
    say(`\n基线安装失败（exit=${first.status}）—— 后面的判据都没意义，先修安装路径：`)
    say((first.stderr ?? '').trim().split('\n').slice(0, 4).join('\n'))
    process.exitCode = 1
    throw new Error('baseline-install-failed')
  }
  const [maj, min] = baseVersion.split('.').map(Number)
  const before = {
    fingerprint: fingerprint(path.join(h1, '.aura', 'pkg', 'node_modules', 'aura-basetools')),
    configs: configHashes(h1),
    state: fs.readFileSync(statePathOf(h1), 'utf8'),
  }

  // ── ① 幂等：同版本升级必须一个文件都不碰 ──────────────────────────────────
  const same = runJson(h1, ['--upgrade', '--from', goodPayload, '--json'])
  check(
    '① 同版本 --upgrade 有结构化回包且退出码 0（不是"未知参数"）',
    same.status === 0 && same.env !== null,
    `exit=${same.status} 回包=${same.env === null ? '(无 JSON)' : 'JSON'}`,
  )
  check(
    '① 同版本升级**一个文件都没碰**（含 mtime，识破"重写一遍内容相同"）',
    fingerprint(path.join(h1, '.aura', 'pkg', 'node_modules', 'aura-basetools')) === before.fingerprint &&
      fs.readFileSync(statePathOf(h1), 'utf8') === before.state,
    '内容与 mtime、install.json 都必须不变',
  )

  // ── ② 真升级：配置零改动 + 只有升级路径才写的字段 ──────────────────────────
  const nextVersion = `${maj}.${min + 1}.0`
  const staged = makePayload('payload', nextVersion)
  cleanup.push(staged)
  const upgraded = runJson(h1, ['--upgrade', '--from', staged, '--json'])
  check('② 真升级：有结构化回包且退出码 0', upgraded.status === 0 && upgraded.env !== null, `exit=${upgraded.status}`)
  check('② 版本已变成新包里的版本', versionOf(h1) === nextVersion, `${baseVersion} → ${versionOf(h1)}`)
  check('② 三份客户端配置逐字节未变（升级不动配置）', configHashes(h1) === before.configs)
  check(
    '② install.json 记下了 previousVersion（这是"真走了升级路径"的判据）',
    stateOf(h1)?.previousVersion === baseVersion,
    `previousVersion=${String(stateOf(h1)?.previousVersion)}`,
  )
  check('② install.json 里记了树哈希/构建戳', typeof (stateOf(h1)?.treeHash ?? stateOf(h1)?.buildStamp) === 'string', `字段=${Object.keys(stateOf(h1) ?? {}).join(',')}`)
  const afterUpgrade = { fingerprint: fingerprint(path.join(h1, '.aura', 'pkg', 'node_modules', 'aura-basetools')), state: fs.readFileSync(statePathOf(h1), 'utf8') }

  // ── ③ 坏包：预检必须挡住，现网一个字节不许变 ──────────────────────────────
  const bad = makePayload('bad', `${maj}.${min + 5}.0`, { breakCli: true })
  cleanup.push(bad)
  const badRun = runJson(h1, ['--upgrade', '--from', bad, '--json'])
  check(
    '③ 坏包被拒：结构化拒绝（退出码 2 且回包 ok=false）',
    badRun.status === 2 && badRun.env?.ok === false,
    `exit=${badRun.status} ok=${String(badRun.env?.ok)}`,
  )
  check(
    '③ 坏包被拒后现网**一个字节都没变**（含 mtime）',
    fingerprint(path.join(h1, '.aura', 'pkg', 'node_modules', 'aura-basetools')) === afterUpgrade.fingerprint &&
      fs.readFileSync(statePathOf(h1), 'utf8') === afterUpgrade.state,
    '预检失败必须发生在任何写入之前',
  )

  // ── ④ 中断安全：按阶段断言**期望状态** ────────────────────────────────────
  // after-backup：备份完、还没换名 → 必须仍是旧版
  // after-swap  ：换名完、终检没跑 → 必须是完整新版
  // final-check ：终检失败 → 必须**自动回滚**成旧版
  const EXPECT_AFTER = { 'after-backup': 'old', 'after-swap': 'new', 'final-check': 'old' }
  for (const [stage, expect] of Object.entries(EXPECT_AFTER)) {
    const h = home()
    cleanup.push(h)
    run(h, ['--yes', '--from', goodPayload, '--json'])
    const oldTree = treeDigest(path.join(h, '.aura', 'pkg', 'node_modules', 'aura-basetools'))
    const target = makePayload(`t-${stage}`, `${maj}.${min + 2}.0`)
    cleanup.push(target)
    const newTree = treeDigest(target)
    const killed = runJson(h, ['--upgrade', '--from', target, '--json'], { AURA_UPGRADE_FAULT: stage })
    const now = treeDigest(path.join(h, '.aura', 'pkg', 'node_modules', 'aura-basetools'))
    const actual = now === oldTree ? 'old' : now === newTree ? 'new' : 'torn'
    check(
      `④ 在 ${stage} 中断后是「完整${expect === 'old' ? '旧版' : '新版'}」（不半新半旧）`,
      killed.env !== null && actual === expect,
      `exit=${killed.status} 实际=${actual} 期望=${expect}`,
    )
    const doctor = runJson(h, ['--doctor', '--json'])
    check(`④ ${stage} 中断后 --doctor 能给出结论`, doctor.status === 0 || doctor.status === 2, `exit=${doctor.status}`)
    if (stage === 'final-check') {
      check(
        '④ final-check 失败后真的**自动回滚**了（版本退回旧版，且旧版自检可用）',
        versionOf(h) === baseVersion && (runJson(h, ['--doctor', '--json']).env?.ok === true || false),
        `版本=${versionOf(h)}`,
      )
    }
  }

  // ── ⑤ 离线可升：本地 manifest + 死代理端口 ────────────────────────────────
  const h2 = home()
  cleanup.push(h2)
  run(h2, ['--yes', '--from', goodPayload, '--json'])
  const manifestFile = path.join(staged, 'manifest.json')
  fs.writeFileSync(
    manifestFile,
    `${JSON.stringify(
      { tool: 'aura-basetools', channels: { stable: { version: nextVersion, url: staged, sha256: treeDigest(staged) } } },
      null,
      2,
    )}\n`,
  )
  const deadProxy = { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' }
  const offline = runJson(h2, ['--check', '--manifest', manifestFile, '--json'], deadProxy)
  check(
    '⑤ 本地 manifest 的 --check 在断网代理下也是结构化回包且退出码 0（说明没走网络）',
    offline.status === 0 && offline.env !== null,
    `exit=${offline.status}`,
  )
  const offlineUp = runJson(h2, ['--upgrade', '--manifest', manifestFile, '--json'], deadProxy)
  check('⑤ 用 manifest 离线升级成功', offlineUp.status === 0 && offlineUp.env !== null && versionOf(h2) === nextVersion, `exit=${offlineUp.status} 版本=${versionOf(h2)}`)

  // ── ⑥ 回滚 ────────────────────────────────────────────────────────────────
  const rolled = runJson(h2, ['--rollback', '--json'])
  check(
    '⑥ --rollback 结构化回包、退出码 0，且退回上一版',
    rolled.status === 0 && rolled.env !== null && versionOf(h2) === baseVersion,
    `exit=${rolled.status} 版本=${versionOf(h2)}`,
  )
  const doctor2 = runJson(h2, ['--doctor', '--json'])
  check('⑥ 回滚后 --doctor 自检通过（旧版可用）', doctor2.status === 0 && doctor2.env?.ok === true, `exit=${doctor2.status} ok=${String(doctor2.env?.ok)}`)

  // ── ⑦ 校验与防呆：四道"不应该动现网"的路径 ────────────────────────────
  const { writeZip, walkFiles } = await import('./zip.mjs')
  const h3 = home()
  cleanup.push(h3)
  run(h3, ['--yes', '--from', goodPayload, '--json'])
  const liveDir = path.join(h3, '.aura', 'pkg', 'node_modules', 'aura-basetools')
  const liveFinger = fingerprint(liveDir)
  const liveState = fs.readFileSync(statePathOf(h3), 'utf8')

  // ⑦a 坏 zip（数据区翻一个 bit）—— CRC 应当拦住它，且**不写盘**
  const zipPath = path.join(h3, 'payload.zip')
  writeZip(
    walkFiles(goodPayload).map((item) => ({ name: `aura-basetools/${item.relative}`, data: fs.readFileSync(item.absolute), mode: 0o644 })),
    zipPath,
  )
  const zipBytes = fs.readFileSync(zipPath)
  const flipAt = Math.floor(zipBytes.length / 2)
  zipBytes[flipAt] ^= 0xff
  fs.writeFileSync(zipPath, zipBytes)
  const corrupt = runJson(h3, ['--upgrade', '--from', zipPath, '--json'])
  check(
    '⑦a 坏 zip（翻一个 bit）被结构化拒绝',
    corrupt.status === 2 && corrupt.env?.ok === false,
    `exit=${corrupt.status} code=${String(corrupt.env?.code)}`,
  )
  check(
    '⑦a 坏 zip 被拒后现网一个字节没变',
    fingerprint(liveDir) === liveFinger && fs.readFileSync(statePathOf(h3), 'utf8') === liveState,
    'CRC/解包失败必须发生在写盘之前',
  )

  // ⑦b 清单里的 sha256 不符 —— **必须对归档载荷验字节**。
  // 注：载荷是**目录**时归档 sha256 无意义，安装器会如实写"跳过字节校验"（那是诚实的降级）；
  // 所以这一条要用**归档**载荷（zip），否则测的不是同一件事（我第一次就搞错了输入）。
  const h4 = home()
  cleanup.push(h4)
  run(h4, ['--yes', '--from', goodPayload, '--json'])
  const live4 = path.join(h4, '.aura', 'pkg', 'node_modules', 'aura-basetools')
  const finger4 = fingerprint(live4)
  const version4 = versionOf(h4)
  const goodZip = path.join(h4, 'good.zip')
  writeZip(
    walkFiles(staged).map((item) => ({ name: `aura-basetools/${item.relative}`, data: fs.readFileSync(item.absolute), mode: 0o644 })),
    goodZip,
  )
  const wrongManifest = path.join(h4, 'wrong.json')
  fs.writeFileSync(
    wrongManifest,
    `${JSON.stringify({ tool: 'aura-basetools', channels: { stable: { version: nextVersion, url: goodZip, sha256: 'deadbeef'.repeat(8) } } }, null, 2)}\n`,
  )
  const shaBad = runJson(h4, ['--upgrade', '--manifest', wrongManifest, '--json'], deadProxy)
  check(
    '⑦b 归档载荷 + 清单 sha256 不符 → 结构化拒绝且报 UPGRADE_SHA256_MISMATCH',
    shaBad.status === 2 && String(shaBad.env?.code) === 'UPGRADE_SHA256_MISMATCH',
    `exit=${shaBad.status} code=${String(shaBad.env?.code)}`,
  )
  check(
    '⑦b sha256 不符时现网未动（指纹 + 版本）',
    fingerprint(live4) === finger4 && versionOf(h4) === version4,
    `版本=${versionOf(h4)} 期望=${version4}`,
  )

  // ⑦c 同版本、不同字节 —— 必须报"同版不同字节"，不能静默覆盖（独立 home，避免状态串味）
  const h5 = home()
  cleanup.push(h5)
  run(h5, ['--yes', '--from', goodPayload, '--json'])
  const live5 = path.join(h5, '.aura', 'pkg', 'node_modules', 'aura-basetools')
  const finger5 = fingerprint(live5)
  check('⑦c 前置：h5 装的就是基线版本', versionOf(h5) === baseVersion, `版本=${versionOf(h5)}`)
  const sameVersionDifferentBytes = makePayload('same-diff', baseVersion)
  cleanup.push(sameVersionDifferentBytes)
  fs.appendFileSync(path.join(sameVersionDifferentBytes, 'bin', 'aura.mjs'), '\n// 同版本不同字节\n')
  const sameDiff = runJson(h5, ['--upgrade', '--from', sameVersionDifferentBytes, '--json'])
  check(
    '⑦c 同版本不同字节被拒（UPGRADE_SAME_VERSION_DIFFERENT_BYTES）',
    sameDiff.status === 2 && String(sameDiff.env?.code) === 'UPGRADE_SAME_VERSION_DIFFERENT_BYTES',
    `exit=${sameDiff.status} code=${String(sameDiff.env?.code)}`,
  )
  check('⑦c 同版不同字节时现网未动', fingerprint(live5) === finger5)

  // ⑦d --uninstall 要把 previous/ 与 staging/ 一起清掉（不然会在用户 home 里留垃圾）
  const prefix = path.join(h3, '.aura', 'pkg')
  const leftoversBefore = ['previous', 'staging'].filter((name) => fs.existsSync(path.join(prefix, name)))
  run(h3, ['--uninstall', '--json'])
  const leftoversAfter = ['previous', 'staging'].filter((name) => fs.existsSync(path.join(prefix, name)))
  check(
    '⑦d --uninstall 清掉 previous/ 与 staging/',
    leftoversAfter.length === 0,
    `卸载前存在 [${leftoversBefore.join(', ') || '无'}]，卸载后 [${leftoversAfter.join(', ') || '无'}]`,
  )
  // ── ⑧ 边界：整个探针没碰真实 $HOME（本轮真实事故的守卫） ──────────────────
  check(
    '⑧ 探针全程没往真实 ~/.aura 写东西（清单含 mtime 逐项不变）',
    listingOf(realAura) === realAuraBefore,
    realAuraBefore === '(不存在)' ? '~/.aura 之前不存在、现在仍不存在' : '逐项比对一致',
  )
  check(
    '⑧ 探针全程没碰真实 ~/.codex/config.toml',
    realCodexBefore === null ? !fs.existsSync(realCodex) : fs.existsSync(realCodex) && sha(realCodex) === realCodexBefore,
  )
} catch (error) {
  if (String(error?.message ?? error) !== 'baseline-install-failed') throw error
} finally {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true })
}

const passed = checks.filter(Boolean).length
say(`\n--- 升级审计探针：${passed}/${checks.length} 通过 ---`)
process.exitCode = passed === checks.length ? 0 : 1
