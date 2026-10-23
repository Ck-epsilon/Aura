#!/usr/bin/env node
/**
 * split-package-test.mjs —— 0.7.0 拆包的**安装级**验收。
 *
 * 拆包后真正的承诺不是"两个目录里有文件"，而是：
 *   ① 核心包（`aura-basetools`）**没有** DSH 依赖，单装也能跑 CLI / MCP；
 *   ② 适配器包（`aura-basetools-dsh`）**按包名**找到核心（`aura-basetools/locator-lab/…`），
 *      装到任意目录都能 import，并且把 DSH 面的钩子执行器一起带上；
 *   ③ 两个包一起装时版本与依赖钉得住。
 *
 * 这三条都在**装出来的那一份**上验：把 `dist/npm/*.tgz` 离线装进一个临时项目，
 * 再从 `node_modules/aura-basetools/...` 运行。只读源码树或只断言 package.json 字段，
 * 证明不了第②条——那正是"文件在 ≠ 能加载"那一类假绿。
 *
 * 判据分段：
 *   A 产物与新鲜度：版本、核心是否是组合产物的忠实子集、DSH 壳 = 源 + 规定改写
 *   B 安装与边界：两个 tgz 离线装成功；核心不含 DSH 面，适配器不含 CLI/引擎
 *   C 从装出来的核心真用：CLI read/edit、MCP 往返、文档里的 npx 形式
 *   D 适配器：每个 `aura-basetools/` 导入都解析到核心包；有宿主 peer 时再真 import
 *
 * 宿主 peer（`@deepseek-ai/{dsh-tools,schemastery}`）不可用时，D 段的**真 import** 会
 * 显眼地跳过并退出 0（与 real-framework 同一约定）；静态解析照跑，且"坏的 specifier
 * 必须被点名"的反证始终跑——否则"全部解析成功"可能只是没扫到东西。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rewriteShellImports, SHELLS } from './bundle-layout.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let pass = 0
let fail = 0
const check = (ok, label, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : `  ${detail}`}`)
}
const say = (message) => console.log(`\n=== ${message} ===`)
const lastJson = (text) => {
  const lines = String(text ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i])
    } catch {
      // 继续往前找：CLI 偶尔会在 JSON 前面打印一行提示
    }
  }
  return null
}
const relFiles = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory() ? relFiles(path.join(dir, entry.name)).map((p) => `${entry.name}/${p}`) : [entry.name]))
        .sort()
    : []

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-split-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const env = {
  ...process.env,
  AURA_CACHE_DIR: path.join(tmp, 'cache'),
  npm_config_cache: path.join(tmp, 'npm-cache'),
  npm_config_offline: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
}
const baseOpts = { cwd: tmp, env, encoding: 'utf8', timeout: 180000 }
// npm/npx 在 Windows 上是 .cmd 包装：不带 shell 直接 spawn 会 ENOENT（仓内既有先例）。
const npmOpts = { ...baseOpts, shell: process.platform === 'win32' }
const npmRun = (args) => spawnSync(npm, args, npmOpts)
const npxRun = (args) => spawnSync(npx, args, { ...npmOpts, timeout: 60000 })
const runNode = (script, args, extra = {}) => spawnSync(process.execPath, [script, ...args], { ...baseOpts, ...extra })

say('A. 产物与新鲜度')
const combinedDir = path.join(root, 'dist', 'aura-basetools')
const npmRoot = path.join(root, 'dist', 'npm')
const combinedPkgPath = path.join(combinedDir, 'package.json')
if (!fs.existsSync(combinedPkgPath)) {
  check(false, '组合产物存在（先跑 node build/make-bundle.mjs --pack）', combinedPkgPath)
  console.log(`\n--- 拆包：${pass} 通过 / ${fail} 失败 ---`)
  process.exit(1)
}
const version = JSON.parse(fs.readFileSync(combinedPkgPath, 'utf8')).version
const coreTgz = path.join(npmRoot, `aura-basetools-${version}.tgz`)
const dshTgz = path.join(npmRoot, `aura-basetools-dsh-${version}.tgz`)
for (const file of [coreTgz, dshTgz]) {
  check(fs.existsSync(file), `拆包产物存在（${path.basename(file)}）`, file)
}
if (!fs.existsSync(coreTgz) || !fs.existsSync(dshTgz)) {
  console.log(`\n--- 拆包：${pass} 通过 / ${fail} 失败 ---`)
  process.exit(1)
}

say('B. 离线安装与文件边界')
{
  const init = npmRun(['init', '-y'])
  check(init.status === 0, `npm init 成功（exit ${init.status}）`, String(init.stderr ?? '').trim().slice(0, 160))
  const coreInstall = npmRun(['install', '--omit=peer', '--no-audit', '--no-fund', '--ignore-scripts', coreTgz])
  check(coreInstall.status === 0, `核心包离线安装成功（exit ${coreInstall.status}）`, String(coreInstall.stderr ?? '').trim().slice(0, 200))
  const dshInstall = coreInstall.status === 0
    ? npmRun(['install', '--omit=peer', '--no-audit', '--no-fund', '--ignore-scripts', dshTgz])
    : { status: null, stderr: '(核心包没装上，跳过)' }
  check(dshInstall.status === 0, `适配器包离线安装成功（exit ${dshInstall.status}）`, String(dshInstall.stderr ?? '').trim().slice(0, 200))
  if (coreInstall.status !== 0 || dshInstall.status !== 0) {
    console.log(`\n--- 拆包：${pass} 通过 / ${fail} 失败 ---`)
    process.exit(1)
  }
}
const coreDir = path.join(tmp, 'node_modules', 'aura-basetools')
const dshDir = path.join(tmp, 'node_modules', 'aura-basetools-dsh')
const corePkg = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8'))
const dshPkg = JSON.parse(fs.readFileSync(path.join(dshDir, 'package.json'), 'utf8'))

check(corePkg.version === version && dshPkg.version === version, `两个包版本一致（${version}）`, `${corePkg.version} / ${dshPkg.version}`)
check(dshPkg.dependencies?.['aura-basetools'] === version, `适配器把核心钉在同一版本（${version}）`, JSON.stringify(dshPkg.dependencies))
check(corePkg.bin?.aura === './bin/aura.mjs' && corePkg.bin?.['aura-mcp'] === './bin/aura-mcp.mjs', '核心包的两个 bin 与文档一致', JSON.stringify(corePkg.bin))
check(dshPkg.peerDependencies?.['@deepseek-ai/dsh-shell'] === '*', '适配器声明了 dsh-shell peer（钩子执行器要用）')
check(
  ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-shell', '@deepseek-ai/schemastery'].every((name) => dshPkg.peerDependenciesMeta?.[name]?.optional === true),
  '三个宿主 peer 都标了 optional（安装期不去 registry 解析私有包）',
  JSON.stringify(dshPkg.peerDependenciesMeta),
)
check(!corePkg.peerDependencies && !corePkg.dependencies && !corePkg.dsh, '核心包 package.json 没有 DSH 依赖/peer', JSON.stringify({ peer: corePkg.peerDependencies, deps: corePkg.dependencies, dsh: corePkg.dsh }))

for (const must of [
  'bin/aura.mjs',
  'bin/aura-mcp.mjs',
  'lib/ops.mjs',
  'lib/fs-provider.mjs',
  'lib/observation-store.mjs',
  'lib/transaction-store.mjs',
  'lib/workspace-lock.mjs',
  'locator-lab/read-core.mjs',
  'locator-lab/struct-core.mjs',
  'locator-lab/handle-core.mjs',
  'test/standalone-test.mjs',
]) {
  check(fs.existsSync(path.join(coreDir, must)), `核心包含 ${must}`)
}
for (const mustNot of ['aura-read', 'aura-edit', 'dsh', 'install.mjs', 'cordis.patch.yml']) {
  check(!fs.existsSync(path.join(coreDir, mustNot)), `核心不含 ${mustNot}（拆开了）`)
}
for (const must of ['aura-read/index.js', 'aura-edit/index.js', 'dsh/argv-shell.mjs', 'dsh/hook-inproc.mjs', 'cordis.patch.yml', 'LICENSE']) {
  check(fs.existsSync(path.join(dshDir, must)), `适配器包含 ${must}`)
}
for (const mustNot of ['bin', 'lib', 'locator-lab', 'test', 'install.mjs']) {
  check(!fs.existsSync(path.join(dshDir, mustNot)), `适配器不含 ${mustNot}（只带壳）`)
}

// 核心包必须是组合产物的**忠实子集**：少一个文件或差一个字节，都是"拆包时漏拷/停在旧字节"。
for (const sub of ['bin', 'lib', 'locator-lab', 'test']) {
  const coreFiles = relFiles(path.join(coreDir, sub))
  const combinedFiles = relFiles(path.join(combinedDir, sub))
  const missing = combinedFiles.filter((file) => !coreFiles.includes(file))
  const extra = coreFiles.filter((file) => !combinedFiles.includes(file))
  const drift = coreFiles.filter((file) => {
    if (!combinedFiles.includes(file)) return true
    return !fs.readFileSync(path.join(coreDir, sub, file)).equals(fs.readFileSync(path.join(combinedDir, sub, file)))
  })
  check(
    missing.length === 0 && extra.length === 0 && drift.length === 0,
    `核心的 ${sub}/ 与组合产物逐字节一致（${coreFiles.length} 个文件）`,
    `少 ${missing.join(',')} 多 ${extra.join(',')} 异 ${drift.join(',')}`,
  )
}

// 适配器的壳是"源 + 规定改写"；不一致 = dist/npm 陈旧或有人手改了产物。
for (const [name] of SHELLS) {
  const expected = rewriteShellImports(fs.readFileSync(path.join(root, 'src', name, 'index.js'), 'utf8'))
  const actual = fs.readFileSync(path.join(dshDir, name, 'index.js'), 'utf8')
  check(actual === expected, `${name} 是源 + 规定改写（不是旧产物）`)
  check(!/(?:from\s*|import\s*\(\s*)['"]\.\.\/(?:lib|locator-lab)\//.test(actual), `${name} 不再用相对路径找引擎`)
}
{
  const patch = fs.readFileSync(path.join(dshDir, 'cordis.patch.yml'), 'utf8')
  check(patch === fs.readFileSync(path.join(combinedDir, 'cordis.patch.yml'), 'utf8'), 'cordis.patch.yml 与组合产物同一份')
  check(dshPkg.dsh?.bundle?.patch === './cordis.patch.yml', '适配器声明了 dsh.bundle.patch')
  for (const target of ['./aura-read/index.js', './aura-edit/index.js']) {
    check(patch.includes(`name: '${target}'`) && fs.existsSync(path.join(dshDir, target)), `patch 指向的 ${target} 在包内`)
  }
}

// 钩子执行器是 DSH 面的产品入口：漏了它，钩子会"看起来装好了、实际全不触发"。
{
  const dshFiles = relFiles(path.join(dshDir, 'dsh'))
  const combinedFiles = relFiles(path.join(combinedDir, 'dsh'))
  const drift = combinedFiles.filter((file) => !dshFiles.includes(file) || !fs.readFileSync(path.join(dshDir, 'dsh', file)).equals(fs.readFileSync(path.join(combinedDir, 'dsh', file))))
  check(combinedFiles.length > 0 && drift.length === 0, `适配器的 dsh/ 与组合产物逐字节一致（${dshFiles.length} 个文件）`, drift.join(','))
  const hooksReadme = fs.readFileSync(path.join(dshDir, 'README.md'), 'utf8')
  check(hooksReadme.includes('dsh/argv-shell.mjs'), '适配器 README 说明了钩子执行器的安装副本路径')
}

// 发布元数据政策：接受环境变量传入的地址，或**已知的官方 Aura 仓库/作者**；
// 不接受为了“看起来像发布”而临时编造的第三方地址。
{
  const officialRepo = 'https://github.com/Ck-epsilon/Aura'
  const officialHome = `${officialRepo}/tree/main/aura-basetools`
  const officialAuthor = 'Ck-epsilon'
  const repoUrl = process.env.AURA_REPO_URL?.trim()
  const author = process.env.AURA_AUTHOR?.trim()
  for (const [label, pkg] of [['核心', corePkg], ['适配器', dshPkg]]) {
    const expectedRepo = repoUrl || officialRepo
    const expectedHome = repoUrl ? `${repoUrl.replace(/\/+$/, '')}/tree/main/aura-basetools` : officialHome
    check(pkg.repository?.url === expectedRepo && pkg.homepage === expectedHome, `${label}包的仓库地址是官方地址或 AURA_REPO_URL`, JSON.stringify({ repo: pkg.repository, homepage: pkg.homepage }))
    check(pkg.author === (author || officialAuthor), `${label}包的 author 是官方作者或 AURA_AUTHOR`, String(pkg.author))
  }
}

// 核心包里不能出现任何 DSH import（注释里提到 DSH 不算）。
{
  const offenders = []
  const scan = (dir) => {
    for (const file of relFiles(dir)) {
      const abs = path.join(dir, file)
      if (!abs.endsWith('.mjs') && !abs.endsWith('.js')) continue
      const text = fs.readFileSync(abs, 'utf8')
      if (/(?:from\s*|import\s*\(\s*)['"]@deepseek-ai\//.test(text)) offenders.push(path.relative(coreDir, abs))
    }
  }
  for (const sub of ['bin', 'lib', 'locator-lab', 'test']) scan(path.join(coreDir, sub))
  check(offenders.length === 0, '核心运行时没有任何 @deepseek-ai import', offenders.join(','))
}

say('C. 从装出来的核心真用：CLI / MCP / npx')
{
  const cli = path.join(coreDir, 'bin', 'aura.mjs')
  const runCli = (args, cwd = tmp) => runNode(cli, args, { cwd })

  const versionRes = runCli(['--version'])
  const versionOut = lastJson(versionRes.stdout)
  check(versionRes.status === 0 && versionOut?.ok === true && versionOut.version === version, `装出来的 CLI 自报 ${version}`, `${versionRes.status} ${String(versionRes.stdout).trim().slice(0, 80)}`)

  const source = path.join(tmp, 'sample.mjs')
  fs.writeFileSync(source, 'export function alpha() {\n  return 1\n}\n')
  const mapRes = runCli(['basetools', 'read', '--file', source, '--mode', 'map'])
  const mapOut = lastJson(mapRes.stdout)
  check(mapRes.status === 0 && mapOut?.ok === true && String(mapRes.stdout).includes('alpha'), '装出来的 CLI 能读符号目录', String(mapRes.stdout).trim().slice(0, 100))

  const editRes = runCli(['basetools', 'edit', '--file', source, '--lines', '2', '--replace', '  return 42', '--expect', '  return 1'])
  const editOut = lastJson(editRes.stdout)
  check(editRes.status === 0 && editOut?.ok === true && fs.readFileSync(source, 'utf8').includes('return 42'), '装出来的 CLI 能按行改并落盘', String(editRes.stdout).trim().slice(0, 100))

  const mcpFile = path.join(tmp, 'mcp-target.mjs')
  fs.writeFileSync(mcpFile, 'export function beta() {\n  return 1\n}\n')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aura_basetools_edit', arguments: { file_path: mcpFile, hunks: [{ lines: [2, 2], replace: '  return 7' }] } } },
  ]
  const mcpRes = runNode(path.join(coreDir, 'bin', 'aura-mcp.mjs'), [], {
    input: `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    maxBuffer: 64 * 1024 * 1024,
  })
  const replies = String(mcpRes.stdout)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const byId = new Map(replies.map((reply) => [reply.id, reply]))
  const tools = byId.get(2)?.result?.tools?.map((tool) => tool.name) ?? []
  check(byId.get(1)?.result?.serverInfo?.name === 'aura-basetools' && byId.get(1)?.result?.serverInfo?.version === version, '装出来的 MCP 握手带对名字与版本', JSON.stringify(byId.get(1)?.result?.serverInfo ?? null))
  check(['aura_basetools_read', 'aura_basetools_edit', 'aura_basetools_write', 'aura_basetools_undo', 'aura_basetools_transactions'].every((name) => tools.includes(name)), '装出来的 MCP 列出五个工具', tools.join(','))
  check(byId.get(3)?.result?.isError !== true && fs.readFileSync(mcpFile, 'utf8').includes('return 7'), '装出来的 MCP 能改盘', JSON.stringify(byId.get(3)?.result ?? null).slice(0, 100))
  check(String(mcpRes.stderr).trim() === '', 'MCP 全程没有走 stderr 兜底', String(mcpRes.stderr).trim().slice(0, 120))

  // 文档里的 npx 形式必须在**装出来的这一份**上可执行（两个 bin 都不叫包名，必须 --package）。
  const npxRes = npxRun(['--no-install', '--package', 'aura-basetools', 'aura', '--version'])
  const npxOut = lastJson(npxRes.stdout)
  check(npxRes.status === 0 && npxOut?.version === version, '文档里的 npx 形式（--package aura-basetools aura）能起来', `${npxRes.status} ${String(npxRes.stdout || npxRes.stderr).trim().slice(0, 120)}`)
  const readme = fs.readFileSync(path.join(coreDir, 'README.md'), 'utf8')
  check(readme.includes('npx -y --package aura-basetools aura basetools mcp'), '核心包 README 给出可用的 npx 形式')
  check(!/npx -y aura-basetools mcp/.test(readme), '核心包 README 不再给出启动不了的 npx 形式')
}

say('D. 适配器按包名找到核心（静态解析 + 真 import）')
const specifiersOf = (file) =>
  [...fs.readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1])
const resolveSpecs = (specs, fromFile) => {
  const require = createRequire(pathToFileURL(fromFile))
  const failures = []
  // Windows 路径大小写不敏感：盘符/目录大小写不同不代表解析到了包外。
  const normalize = (p) => path.resolve(process.platform === 'win32' ? p.toLowerCase() : p)
  for (const spec of specs) {
    try {
      const resolved = require.resolve(spec)
      const relative = path.relative(normalize(coreDir), normalize(resolved))
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) failures.push(`${spec} → 核心包外：${resolved}`)
    } catch (error) {
      failures.push(`${spec}（${error?.code ?? String(error?.message ?? error)}）`)
    }
  }
  return failures
}
{
  const coreSpecs = []
  for (const [name] of SHELLS) {
    const specs = specifiersOf(path.join(dshDir, name, 'index.js')).filter((spec) => spec.startsWith('aura-basetools/'))
    check(specs.length > 0, `${name} 有按包名导入核心（${specs.length} 条）`, specs.join(','))
    coreSpecs.push(...specs)
  }
  const failures = resolveSpecs(coreSpecs, path.join(dshDir, SHELLS[0][0], 'index.js'))
  check(failures.length === 0, `适配器的 ${coreSpecs.length} 条 aura-basetools/ 导入全部解析到核心包`, failures.join(' | '))

  // 反证：同一个解析器必须能点名一个不存在的子路径。否则"全部解析成功"可能只是没扫到东西。
  const probe = resolveSpecs(['aura-basetools/locator-lab/read-core.mjs', 'aura-basetools/locator-lab/definitely-not-shipped.mjs'], path.join(dshDir, SHELLS[0][0], 'index.js'))
  check(probe.length === 1 && probe[0].includes('definitely-not-shipped'), '静态解析器能判出坏的 specifier（反证）', probe.join(' | '))
}

const linkedPeers = []
{
  const peerNames = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-shell', '@deepseek-ai/schemastery']
  const peerSources = peerNames.map((name) => path.join(root, 'node_modules', ...name.split('/')))
  const peersAvailable = peerSources.every((dir) => fs.existsSync(dir))
  if (!peersAvailable) {
    console.log('⚪ 宿主 peer 不可用 ⇒ 跳过 DSH 适配器的真 import（这不等于通过；上面的静态解析已跑全）')
  } else {
    const peerRoot = path.join(tmp, 'node_modules', '@deepseek-ai')
    fs.mkdirSync(peerRoot, { recursive: true })
    for (let i = 0; i < peerNames.length; i += 1) {
      const link = path.join(peerRoot, ...peerNames[i].split('/').slice(1))
      fs.symlinkSync(peerSources[i], link, process.platform === 'win32' ? 'junction' : 'dir')
      linkedPeers.push(link)
    }
    for (const [name] of SHELLS) {
      try {
        const module = await import(pathToFileURL(path.join(dshDir, name, 'index.js')).href)
        check(
          typeof module.apply === 'function' && typeof module.name === 'string' && Array.isArray(module.inject),
          `${name} 从安装位置真 import，插件四件套齐全`,
          Object.keys(module).join(','),
        )
      } catch (error) {
        check(false, `${name} 从安装位置真 import`, `${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 160)}`)
      }
    }
    try {
      const executor = await import(pathToFileURL(path.join(dshDir, 'dsh', 'argv-shell.mjs')).href)
      check(typeof executor.default === 'function', '钩子执行器从安装位置真 import（缺 dsh-shell peer 会在这里现形）', Object.keys(executor).join(','))
    } catch (error) {
      check(false, '钩子执行器从安装位置真 import', `${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 160)}`)
    }
    try {
      const inproc = await import(pathToFileURL(path.join(dshDir, 'dsh', 'hook-inproc.mjs')).href)
      check(typeof inproc.runPreToolUseHookInProcess === 'function' && typeof inproc.recognizePreToolUseHook === 'function', 'hook-inproc 从安装位置真 import，两个入口都在', Object.keys(inproc).join(','))
    } catch (error) {
      check(false, 'hook-inproc 从安装位置真 import', `${error?.code ?? ''} ${String(error?.message ?? error).slice(0, 160)}`)
    }
  }
}

console.log('')
console.log(`--- 拆包：${pass} 通过 / ${fail} 失败 ---`)
if (fail === 0) {
  for (const link of linkedPeers) {
    try {
      fs.unlinkSync(link)
    } catch {
      // 链接清不掉不影响判定；临时目录随系统回收
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
} else {
  console.log(`临时目录保留：${tmp}`)
}
process.exit(fail === 0 ? 0 : 1)
