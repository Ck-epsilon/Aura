/**
 * make-split-packages.mjs —— 从组合产物派生两个 npm 包：
 *
 *   dist/npm/aura-basetools       纯核心：CLI + MCP + 引擎，无 DSH 依赖
 *   dist/npm/aura-basetools-dsh   DSH 适配器：两个壳 + patch，依赖核心
 *
 * 组合产物 `dist/aura-basetools` 仍保留给一键安装/旧交付包；npm 官方源只发这两个包。
 * 这样“不用 DSH 也行”不再靠 optional peer 的约定，而是安装形态本身。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const combined = path.join(root, 'dist', 'aura-basetools')
const npmRoot = path.join(root, 'dist', 'npm')
const coreOut = path.join(npmRoot, 'aura-basetools')
const dshOut = path.join(npmRoot, 'aura-basetools-dsh')

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const version = readJson(path.join(combined, 'package.json')).version
const repoUrl = process.env.AURA_REPO_URL?.trim() || 'https://github.com/Ck-epsilon/Aura'
const author = process.env.AURA_AUTHOR?.trim() || 'Ck-epsilon'

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
    'Byte-fidelity read/edit engine for coding agents. Standalone CLI and MCP server; no harness or DSH required.',
  license: 'MIT',
  type: 'module',
  engines: { node: '>=18' },
  bin: { aura: './bin/aura.mjs', 'aura-mcp': './bin/aura-mcp.mjs' },
  exports: {
    './package.json': './package.json',
    './locator-lab/*': './locator-lab/*',
    './lib/*': './lib/*',
  },
  keywords: ['mcp', 'cli', 'read', 'edit', 'agent', 'codex', 'claude-code', 'cursor'],
  files: ['bin/', 'lib/', 'locator-lab/', 'test/', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
  repository: { type: 'git', url: repoUrl, directory: 'aura-basetools' },
  homepage: `${repoUrl.replace(/\/+$/, '')}/tree/main/aura-basetools#readme`,
  bugs: { url: `${repoUrl.replace(/\/+$/, '')}/issues` },
  author,
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
}
write(path.join(coreOut, 'package.json'), `${JSON.stringify(corePkg, null, 2)}\n`)
write(path.join(coreOut, 'README.md'), `# aura-basetools ${version}

给 coding agent 用的文件读写工具。**不依赖 DSH**：纯 Node（>=18），CLI + MCP 两条入口。

## CLI

\`\`\`bash
aura read --file src/app.ts --mode map
aura edit --file src/app.ts --hunks '[{"target":"main","replace":"…"}]'
aura --help
\`\`\`

## MCP

\`\`\`json
{ "mcpServers": { "aura": { "command": "aura", "args": ["mcp"] } } }
\`\`\`

或 \`npx -y aura-basetools mcp\`。

## DSH

DSH 用户安装适配器包：\`aura-basetools-dsh\`。

## 写事务

\`aura edit ... --transaction\` 返回事务 id；\`aura undo [--id id]\` 回滚；\`aura transactions\` 列出。
`)

// ── DSH 适配器：只装两个壳 + patch，依赖核心 ─────────────────────────────
for (const name of ['aura-read', 'aura-edit']) {
  const from = path.join(root, 'src', name, 'index.js')
  const text = fs
    .readFileSync(from, 'utf8')
    .replaceAll("from '../locator-lab/", "from 'aura-basetools/locator-lab/")
    .replaceAll("from '../lib/", "from 'aura-basetools/lib/")
  write(path.join(dshOut, name, 'index.js'), text)
}
copy(path.join(combined, 'LICENSE'), path.join(dshOut, 'LICENSE'))
copy(path.join(combined, 'cordis.patch.yml'), path.join(dshOut, 'cordis.patch.yml'))
write(path.join(dshOut, 'README.md'), `# aura-basetools-dsh ${version}

Aura read/edit tools as a DeepSeek Harness bundle. It depends on \`aura-basetools\`; the core package has no DSH dependency.

\`\`\`bash
npm i aura-basetools-dsh
# or: dsh plugin --profile web add aura-basetools-dsh@${version}
\`\`\`

The installed bundle exposes \`aura_read\` and \`aura_edit\`; built-in DSH read/write/edit/read_image stay enabled.
`)

const dshPkg = {
  name: 'aura-basetools-dsh',
  version,
  description: 'DeepSeek Harness adapter for aura-basetools (aura_read / aura_edit). Depends on the DSH-free core package.',
  license: 'MIT',
  type: 'module',
  dependencies: { 'aura-basetools': version },
  peerDependencies: {
    '@deepseek-ai/dsh-tools': '*',
    '@deepseek-ai/schemastery': '*',
  },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  exports: {
    './package.json': './package.json',
    './aura-read/index.js': './aura-read/index.js',
    './aura-edit/index.js': './aura-edit/index.js',
    './cordis.patch.yml': './cordis.patch.yml',
  },
  files: ['aura-read/', 'aura-edit/', 'cordis.patch.yml', 'README.md', 'LICENSE'],
  repository: { type: 'git', url: repoUrl, directory: 'aura-basetools' },
  homepage: `${repoUrl.replace(/\/+$/, '')}/tree/main/aura-basetools#readme`,
  bugs: { url: `${repoUrl.replace(/\/+$/, '')}/issues` },
  author,
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
}
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
