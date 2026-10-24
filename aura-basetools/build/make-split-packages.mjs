/**
 * make-split-packages.mjs —— 从组合产物派生两个 npm 包：
 *
 *   dist/npm/aura-basetools       纯核心：CLI + MCP + 引擎，无 DSH 依赖
 *   dist/npm/aura-basetools-dsh   DSH 适配器：两个壳 + patch，依赖核心
 *
 * 组合产物 `dist/aura-basetools` 是拆包的中间产物；npm 官方源只发这两个包。
 * 这样“不用 DSH 也行”不再靠 optional peer 的约定，而是安装形态本身。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { BIN_ENTRIES, SHELLS, rewriteShellImports } from './bundle-layout.mjs'

const root = path.resolve(import.meta.dirname, '..')
const combined = path.join(root, 'dist', 'aura-basetools')
const npmRoot = path.join(root, 'dist', 'npm')
const coreOut = path.join(npmRoot, 'aura-basetools')
const dshOut = path.join(npmRoot, 'aura-basetools-dsh')

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const version = readJson(path.join(combined, 'package.json')).version
// 发布元数据只在环境变量**真的设了**时才写：不编一个假仓库地址（与 make-bundle 同一政策）。
const repoUrl = process.env.AURA_REPO_URL?.trim() || 'https://github.com/Ck-epsilon/Aura'
const author = process.env.AURA_AUTHOR?.trim() || 'Ck-epsilon'

const addPublishMeta = (pkg) => {
  if (repoUrl) {
    pkg.repository = { type: 'git', url: repoUrl, directory: 'aura-basetools' }
    pkg.homepage = `${repoUrl.replace(/\/+$/, '')}/tree/main/aura-basetools`
    pkg.bugs = { url: `${repoUrl.replace(/\/+$/, '')}/issues` }
  }
  if (author) pkg.author = author
  return pkg
}

// 低于这一行就删产物太危险：先确认组合产物与两个壳是**同一个版本**，
// 否则拆出来的 dsh 包会依赖一个不存在的核心版本（或一个同号不同字节的核心）。
const shellVersions = new Set(SHELLS.map(([dir]) => readJson(path.join(root, 'src', dir, 'package.json')).version))
if (shellVersions.size !== 1 || [...shellVersions][0] !== version) {
  throw new Error(`拆包版本不一致：组合产物 ${version}，壳 ${[...shellVersions].join(' / ')} —— 先跑 node build/make-bundle.mjs --pack`)
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

fs.rmSync(npmRoot, { recursive: true, force: true })

// ── 核心包：只装 CLI/MCP 需要的文件 ──────────────────────────────────────
for (const name of ['bin', 'lib', 'locator-lab', 'test']) copy(path.join(combined, name), path.join(coreOut, name))
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) copy(path.join(combined, name), path.join(coreOut, name))

const corePkg = {
  name: 'aura-basetools',
  version,
  description:
    'Byte-exact read, edit and write tools for coding agents. Standalone CLI and MCP server; no DSH required. 面向 coding agent 的逐字节读写工具；独立 CLI / MCP，可选 DSH 适配器。',
  license: 'MIT',
  type: 'module',
  engines: { node: '>=18' },
  bin: BIN_ENTRIES,
  exports: {
    './package.json': './package.json',
    './locator-lab/*': './locator-lab/*',
    './lib/*': './lib/*',
  },
  keywords: ['mcp', 'cli', 'read', 'edit', 'agent', 'codex', 'claude-code', 'cursor'],
  files: ['bin/', 'lib/', 'locator-lab/', 'test/', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
}
addPublishMeta(corePkg)
write(path.join(coreOut, 'package.json'), `${JSON.stringify(corePkg, null, 2)}\n`)
write(path.join(coreOut, 'README.md'), fs.readFileSync(path.join(root, 'docs', 'README.npm-core.md'), 'utf8').replaceAll('{{VERSION}}', version))

// ── DSH 适配器：两个壳 + patch + 钩子执行器，依赖核心 ─────────────────────
for (const [name] of SHELLS) {
  const from = path.join(root, 'src', name, 'index.js')
  const text = rewriteShellImports(fs.readFileSync(from, 'utf8'))
  write(path.join(dshOut, name, 'index.js'), text)
}
// 钩子执行器是 DSH 面的产品入口（profile 里的 `ctx.shell` 指到它），不是可选附件。
// 拆包第一版漏了 `dsh/` 与 `@deepseek-ai/dsh-shell` peer —— 症状会是"钩子全不触发"，
// 与 T30 记的那次安装事故同形（文件看起来都在，宿主组合时才报 ERR_MODULE_NOT_FOUND）。
copy(path.join(combined, 'dsh'), path.join(dshOut, 'dsh'))
copy(path.join(combined, 'LICENSE'), path.join(dshOut, 'LICENSE'))
copy(path.join(combined, 'cordis.patch.yml'), path.join(dshOut, 'cordis.patch.yml'))
write(path.join(dshOut, 'README.md'), fs.readFileSync(path.join(root, 'docs', 'README.npm-dsh.md'), 'utf8').replaceAll('{{VERSION}}', version))

const dshPkg = {
  name: 'aura-basetools-dsh',
  version,
  description: 'DeepSeek Harness adapter for aura-basetools: aura_basetools_* tools and hook executor. Depends on the DSH-free core package. / aura-basetools 的 DSH 适配器。',
  license: 'MIT',
  type: 'module',
  dependencies: { 'aura-basetools': version },
  peerDependencies: {
    '@deepseek-ai/dsh-tools': '*',
    '@deepseek-ai/dsh-shell': '*',
    '@deepseek-ai/schemastery': '*',
  },
  // 宿主提供这三个 peer；标 optional 是为了不在安装期去 registry 解析私有包。
  // 缺失时由真实 import 显形（本仓的 installed-package / split-package 都做真 import），
  // 而不是让 npm 死在一次看起来像"包坏了"的 404 上。
  peerDependenciesMeta: {
    '@deepseek-ai/dsh-tools': { optional: true },
    '@deepseek-ai/dsh-shell': { optional: true },
    '@deepseek-ai/schemastery': { optional: true },
  },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  exports: {
    './package.json': './package.json',
    './aura-read/index.js': './aura-read/index.js',
    './aura-edit/index.js': './aura-edit/index.js',
    './dsh/*': './dsh/*',
    './cordis.patch.yml': './cordis.patch.yml',
  },
  files: ['aura-read/', 'aura-edit/', 'dsh/', 'cordis.patch.yml', 'README.md', 'LICENSE'],
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
}
addPublishMeta(dshPkg)
write(path.join(dshOut, 'package.json'), `${JSON.stringify(dshPkg, null, 2)}\n`)

console.log(`核心包 → ${path.relative(root, coreOut)}  (${version})`)
console.log(`DSH 包 → ${path.relative(root, dshOut)}  (${version})`)

if (process.argv.includes('--pack')) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const dir of [coreOut, dshOut]) {
    const name = execFileSync(npm, ['pack', '--pack-destination', npmRoot], { cwd: dir, encoding: 'utf8', shell: true }).trim().split('\n').pop()
    console.log(`npm pack → ${path.relative(root, path.join(npmRoot, name))}`)
  }
}
