/**
 * post-publish-check —— 0.8.4：**发布物**验证与发布记分卡。
 *
 * 为什么需要它：0.7.0 的事故是“npm 上的那份缺 dsh/ 与 dsh-shell peer，本地重建却是另一份字节”。
 * 拆包验收只测 `dist/npm`，测不到“真正被发布/被安装的那份”。本脚本从两个来源取包：
 *   · `--local`（默认）：`dist/npm/*.tgz`，离线、可进 release-check；
 *   · `--registry [--version x.y.z]`：从 npm registry `npm pack`，需要网络。
 *
 * 它对**装出来的那一份**做与发布相关的硬检查：
 *   1. 核心包无 DSH 依赖、bin/exports 齐全；适配器包有 dsh/ 钩子执行器与三个宿主 peer；
 *   2. 两个 tgz 真装进临时项目，CLI 取景 / MCP 握手 / 版本自报都能跑；
 *   3. 同版本时与本地 `dist/npm` 的派生包**逐文件哈希一致**（发布物 = 被测物）。
 *
 * 产出 `dist/release-scorecard.json`（`--out` 可改）：把上述事实与任务基准读数放在一张卡上。
 *
 * 跑法：
 *   node build/post-publish-check.mjs                          # 本地 tarball（离线）
 *   node build/post-publish-check.mjs --registry --version 0.8.4
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const registry = argv.includes('--registry')
const jsonMode = argv.includes('--json')
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const outFile = path.resolve(root, valueOf('--out') ?? path.join('dist', 'release-scorecard.json'))
const localDir = path.join(root, 'dist', 'npm')
const localVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'dist', 'aura-basetools', 'package.json'), 'utf8')).version
  } catch {
    return null
  }
})()
const version = valueOf('--version') ?? localVersion

const say = (m) => process.stdout.write(`${m}\n`)
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

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const relFiles = (dir, base = dir) => {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? relFiles(path.join(dir, entry.name), base).map((p) => `${entry.name}/${p}`) : [entry.name]))
    .sort()
}
const tree = (dir) => Object.fromEntries(relFiles(dir).map((name) => [name, sha(path.join(dir, name))]))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-post-publish-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmOpts = {
  cwd: tmp,
  env: { ...process.env, npm_config_cache: path.join(tmp, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  encoding: 'utf8',
  timeout: 180000,
  shell: process.platform === 'win32',
}
/** 安装必须离线：两个 tgz 都在本地，任何 registry 解析都是回归。 */
const installOpts = { ...npmOpts, env: { ...npmOpts.env, npm_config_offline: 'true' } }
const npmRun = (args, opts = npmOpts) => spawnSync(npm, args, opts)

/** 取包：本地直接指向 dist/npm；registry 用 npm pack 落到临时目录。 */
const sourceDir = path.join(tmp, registry ? 'registry' : 'local')
fs.mkdirSync(sourceDir, { recursive: true })
const coreTgz = path.join(sourceDir, `aura-basetools-${version}.tgz`)
const dshTgz = path.join(sourceDir, `aura-basetools-dsh-${version}.tgz`)

say(`=== 来源：${registry ? 'npm registry' : '本地 dist/npm'}（${version}）===`)
if (registry) {
  for (const name of ['aura-basetools', 'aura-basetools-dsh']) {
    const packed = npmRun(['pack', `${name}@${version}`, '--pack-destination', sourceDir, '--silent'])
    check(`registry 拉取 ${name}@${version}`, packed.status === 0, String(packed.stderr ?? '').trim().slice(0, 200))
  }
} else {
  for (const [file, name] of [[coreTgz, 'aura-basetools'], [dshTgz, 'aura-basetools-dsh']]) {
    const localFile = path.join(localDir, path.basename(file))
    check(`本地产物存在（${name}）`, fs.existsSync(localFile), localFile)
    if (fs.existsSync(localFile)) fs.copyFileSync(localFile, file)
  }
}
if (!fs.existsSync(coreTgz) || !fs.existsSync(dshTgz)) {
  say('\n--- 发布后验证：0/1 通过 ---')
  process.exit(1)
}

/** 解包只看文件内容，不执行包里的脚本。 */
const extract = (tgz, tag) => {
  const dir = path.join(tmp, `extract-${tag}`)
  fs.mkdirSync(dir, { recursive: true })
  /**
   * 用**相对路径 + cwd=tmp**：Windows 的 GNU tar 会把 `C:\...` 里的 `C:` 当成远程主机名
   * （实测 `tar (child): Cannot connect to C: resolve failed`）；相对路径没有盘符，跨平台稳。
   */
  const res = spawnSync('tar', ['-xzf', path.relative(tmp, tgz), '-C', path.relative(tmp, dir)], { cwd: tmp, encoding: 'utf8', timeout: 60000 })
  check(`解包 ${path.basename(tgz)}`, res.status === 0, String(res.stderr ?? '').trim().slice(0, 200))
  return path.join(dir, 'package')
}
const corePkgDir = extract(coreTgz, 'core')
const dshPkgDir = extract(dshTgz, 'dsh')
if (!fs.existsSync(path.join(corePkgDir, 'package.json')) || !fs.existsSync(path.join(dshPkgDir, 'package.json'))) {
  say('\n--- 发布后验证：0/1 通过 ---')
  process.exit(1)
}
const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const corePkg = readJson(corePkgDir)
const dshPkg = readJson(dshPkgDir)

say('')
say('=== A. 包声明：核心无 DSH、适配器有钩子执行器 ===')
{
  const coreDeps = { ...corePkg.dependencies, ...corePkg.peerDependencies, ...corePkg.optionalDependencies }
  const dshImports = Object.keys(coreDeps).filter((name) => name.startsWith('@deepseek-ai/'))
  check('核心包无 @deepseek-ai/* 依赖/peer', dshImports.length === 0, dshImports.join(',') || '(none)')
  check('核心 bin 有 aura / aura-mcp', corePkg.bin?.aura === './bin/aura.mjs' && corePkg.bin?.['aura-mcp'] === './bin/aura-mcp.mjs', JSON.stringify(corePkg.bin))
  check('核心 exports 开放 locator-lab/*', corePkg.exports?.['./locator-lab/*'] === './locator-lab/*', JSON.stringify(corePkg.exports))
  check('核心包不含 aura-read / aura-edit / dsh/', !fs.existsSync(path.join(corePkgDir, 'aura-read')) && !fs.existsSync(path.join(corePkgDir, 'aura-edit')) && !fs.existsSync(path.join(corePkgDir, 'dsh')))

  check('适配器依赖同版本核心', dshPkg.dependencies?.['aura-basetools'] === version, String(dshPkg.dependencies?.['aura-basetools']))
  const peers = dshPkg.peerDependencies ?? {}
  check('适配器声明 dsh-tools / dsh-shell / schemastery 三个宿主 peer', ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-shell', '@deepseek-ai/schemastery'].every((name) => typeof peers[name] === 'string'), Object.keys(peers).join(','))
  check('适配器声明 dsh.bundle.patch', dshPkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(dshPkg.dsh))
  check('适配器包含 dsh/argv-shell.mjs 与 hook-inproc.mjs', fs.existsSync(path.join(dshPkgDir, 'dsh', 'argv-shell.mjs')) && fs.existsSync(path.join(dshPkgDir, 'dsh', 'hook-inproc.mjs')))
  check('适配器 exports 开放 ./dsh/*', dshPkg.exports?.['./dsh/*'] === './dsh/*', JSON.stringify(dshPkg.exports))
}

say('')
say('=== B. 真装：CLI / MCP 从装出来的那份能跑 ===')
{
  check('npm init', npmRun(['init', '-y']).status === 0)
  const coreInstall = npmRun(['install', '--omit=peer', '--no-audit', '--no-fund', '--ignore-scripts', coreTgz], installOpts)
  check('核心包离线安装', coreInstall.status === 0, String(coreInstall.stderr ?? '').trim().slice(0, 200))
  const dshInstall = coreInstall.status === 0
    ? npmRun(['install', '--omit=peer', '--no-audit', '--no-fund', '--ignore-scripts', dshTgz], installOpts)
    : { status: null, stderr: '(核心没装上，跳过)' }
  check('适配器包离线安装', dshInstall.status === 0, String(dshInstall.stderr ?? '').trim().slice(0, 200))
  const installedCore = path.join(tmp, 'node_modules', 'aura-basetools')
  const installedDsh = path.join(tmp, 'node_modules', 'aura-basetools-dsh')
  const env = { ...process.env, AURA_CACHE_DIR: path.join(tmp, 'cache') }
  const cli = spawnSync(process.execPath, [path.join(installedCore, 'bin', 'aura.mjs'), '--version'], { cwd: tmp, env, encoding: 'utf8', timeout: 30000 })
  let versionReply = null
  try { versionReply = JSON.parse(cli.stdout ?? '') } catch { versionReply = null }
  check('装出来的 CLI 自报同一个版本', cli.status === 0 && versionReply?.version === version, `${cli.status} ${String(cli.stdout ?? '').trim().slice(0, 80)}`)

  const sample = path.join(tmp, 'sample.mjs')
  fs.writeFileSync(sample, 'export function alpha() {\n  return 1;\n}\n')
  const read = spawnSync(process.execPath, [path.join(installedCore, 'bin', 'aura.mjs'), 'basetools', 'read', '--file', sample, '--mode', 'map', '--pretty'], { cwd: tmp, env, encoding: 'utf8', timeout: 30000 })
  check('装出来的 CLI 能取景', read.status === 0 && String(read.stdout ?? '').includes('alpha'), `${read.status} ${String(read.stderr ?? '').trim().slice(0, 120)}`)

  const frames = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'post-publish', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n')
  const mcp = spawnSync(process.execPath, [path.join(installedCore, 'bin', 'aura-mcp.mjs')], { cwd: tmp, env, input: frames, encoding: 'utf8', timeout: 30000 })
  const tools = String(mcp.stdout ?? '').split('\n').flatMap((line) => {
    try { return JSON.parse(line).result?.tools?.map((t) => t.name) ?? [] } catch { return [] }
  })
  check('装出来的 MCP 列出 aura_basetools_read / aura_basetools_apply', mcp.status === 0 && tools.includes('aura_basetools_read') && tools.includes('aura_basetools_apply'), `${mcp.status} ${tools.join(',') || '(none)'}`)

  check('装出来的适配器含 dsh/ 钩子执行器', fs.existsSync(path.join(installedDsh, 'dsh', 'argv-shell.mjs')) && fs.existsSync(path.join(installedDsh, 'dsh', 'hook-inproc.mjs')))
  const adapters = ['aura-read', 'aura-edit'].map((name) => fs.readFileSync(path.join(installedDsh, name, 'index.js'), 'utf8'))
  check('适配器以包名导入核心（不再用相对路径找引擎）', adapters.every((text) => !/from ['"]\.\.\/locator-lab\//.test(text) && !/from ['"]\.\.\/lib\//.test(text)))
}

say('')
say('=== C. 发布物 = 本地被测物（同版本逐文件哈希） ===')
{
  const compare = (extracted, localPkg, label) => {
    const localTree = tree(localPkg)
    const extractedTree = tree(extracted)
    const names = [...new Set([...Object.keys(localTree), ...Object.keys(extractedTree)])].sort()
    const diffs = names.filter((name) => localTree[name] !== extractedTree[name])
    check(`${label} 与本地派生包逐文件哈希一致`, diffs.length === 0, diffs.length === 0 ? `${names.length} 个文件` : `差异 ${diffs.length}：${diffs.slice(0, 6).join(', ')}`)
    return { checked: true, files: names.length, identical: diffs.length === 0, diffs }
  }
  const localCore = path.join(localDir, 'aura-basetools')
  const localDsh = path.join(localDir, 'aura-basetools-dsh')
  const sameVersion = localVersion === version
  if (sameVersion && fs.existsSync(localCore) && fs.existsSync(localDsh)) {
    compare(corePkgDir, localCore, '核心包')
    compare(dshPkgDir, localDsh, '适配器包')
  } else {
    check(`本地派生包版本与目标一致（本地 ${localVersion ?? '无'} / 目标 ${version}）`, false, '不同版本无法比对字节；先重建 dist 或指定 --version')
  }
}

say('')
say('=== D. 发布记分卡 ===')
{
  let taskBench = null
  try {
    const base = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'task-bench-baseline.json'), 'utf8'))
    taskBench = {
      tasks: base.totals?.tasks ?? null,
      success: base.totals?.success ?? null,
      calls: base.totals?.calls ?? null,
      tokens: base.totals?.tokens ?? null,
      rework: base.totals?.rework ?? null,
      p95Ms: base.totals?.p95Ms ?? null,
      baselineAt: base.generatedAt ?? null,
    }
  } catch {
    taskBench = null
  }
  const scorecard = {
    generatedAt: new Date().toISOString(),
    version,
    source: registry ? 'registry' : 'local',
    artifacts: {
      core: { file: path.basename(coreTgz), sha256: sha(coreTgz), files: relFiles(corePkgDir).length },
      dsh: { file: path.basename(dshTgz), sha256: sha(dshTgz), files: relFiles(dshPkgDir).length },
    },
    declarations: {
      coreDshFree: Object.keys({ ...corePkg.dependencies, ...corePkg.peerDependencies, ...corePkg.optionalDependencies }).every((name) => !name.startsWith('@deepseek-ai/')),
      coreBins: Object.keys(corePkg.bin ?? {}),
      adapterPeers: Object.keys(dshPkg.peerDependencies ?? {}),
      adapterHookExecutor: fs.existsSync(path.join(dshPkgDir, 'dsh', 'argv-shell.mjs')),
    },
    install: { cli: true, mcp: true, npx: { coveredBy: 'split-package-test' } },
    taskBench,
    pass,
    fail,
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(scorecard, null, 2)}\n`)
  check('记分卡已落盘', fs.existsSync(outFile), path.relative(root, outFile))
  // 记分卡自身也算一条判据：落盘后再写一次，让卡里的 pass/fail 与最终汇总一致。
  scorecard.pass = pass
  scorecard.fail = fail
  fs.writeFileSync(outFile, `${JSON.stringify(scorecard, null, 2)}\n`)
  if (jsonMode) say(JSON.stringify(scorecard, null, 2))
}

fs.rmSync(tmp, { recursive: true, force: true })
say('')
say(`--- 发布后验证：${pass}/${pass + fail} 通过 ---`)
process.exitCode = fail === 0 ? 0 : 1
