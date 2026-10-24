/**
 * make-bundle.mjs —— 把 aura 读写工具打成两个 npm 包的**中间产物**。
 *
 * 产出：
 *   dist/aura-basetools/          组合产物（拆包输入；不发布、不再打交付 zip）
 *   dist/npm/aura-basetools       核心包（`--pack` 时由 make-split-packages 派生）
 *   dist/npm/aura-basetools-dsh   DSH 适配器（同上）
 *
 * 安装只走 npm，不再有自定义安装器：
 *   npx -y --package aura-basetools aura basetools mcp    # MCP，零安装
 *   npm i -g aura-basetools                                # CLI
 *   dsh plugin --profile web add aura-basetools-dsh        # DSH
 *
 * 自定义 install.mjs（稳定路径 / 客户端注册 / 升级回滚 / 交付 zip）已在 0.13.2 移除：
 * 那些能力要么 npm 已经提供（全局路径、dist-tag、`@版本` 回滚、`npm pack` 离线包），
 * 要么该由调用它的 agent 自己做（写五行 MCP 配置）。
 *
 * 产出是**派生物**：`dist/` 由本脚本生成，不要手改；改源再重跑。
 *
 *   node build/make-bundle.mjs            # 只生成 dist/aura-basetools/
 *   node build/make-bundle.mjs --pack     # 再派生 dist/npm 双包 + capabilities.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { BIN_ENTRIES, ENGINE, HOOK_SHELL, SHELLS, STANDALONE, shipsStandaloneFile } from './bundle-layout.mjs'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'dist', 'aura-basetools')
/** 源都在 <项目>/src/ 下：四个目录是相对引用的一套，整体搬动不影响彼此。 */
const src = path.join(root, 'src')

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const versions = new Set(SHELLS.map(([dir]) => readJson(path.join(src, dir, 'package.json')).version))
if (versions.size !== 1) throw new Error(`两个包的版本不一致：${[...versions].join(' / ')} —— 先对齐再打包`)
const version = [...versions][0]

const copied = []
/**
 * 复制一个运行时文件，并做**打包前的守卫**。
 * @param kind - 'engine'（不许 node:fs / 盘符 / 平台分支）或 'host'（宿主代码：允许 node:fs，仍禁盘符与平台分支）
 */
const copyFile = (from, to, kind) => {
  const text = fs.readFileSync(from, 'utf8')
  const bad = []
  // 只认**真盘符路径**：`…text:\n` 里的 `t:\` 是转义序列，朴素写法会误抓（实测踩过一次）
  if (/[A-Za-z]:\\(?![nrtbfv0xu'"\\/])/.test(text)) bad.push('绝对路径')
  if (/process\.platform/.test(text)) bad.push('process.platform')
  if (kind === 'engine' && /from 'node:fs'|require\('fs'\)/.test(text)) bad.push('引擎里直接使用 node:fs')
  if (bad.length > 0) throw new Error(`${path.relative(root, from)} 含不可移植内容（${bad.join('、')}）——包不能带它`)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, text)
  copied.push({ file: path.relative(out, to).replaceAll('\\', '/'), bytes: Buffer.byteLength(text) })
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
for (const [dir, entry] of SHELLS) copyFile(path.join(src, dir, entry), path.join(out, dir, entry), 'host')
for (const f of ENGINE) copyFile(path.join(src, 'locator-lab', f), path.join(out, 'locator-lab', f), 'engine')
for (const [fromDir, toDir] of STANDALONE) {
  const abs = path.join(src, fromDir)
  for (const name of fs.readdirSync(abs)) {
    if (!shipsStandaloneFile(name)) continue
    copyFile(path.join(abs, name), path.join(out, toDir, name), 'host')
  }
}
for (const rel of HOOK_SHELL) copyFile(path.join(root, rel), path.join(out, rel), 'host')

// MIT 许可证随包发：源树根那一份是唯一来源。设了 AURA_AUTHOR 时版权行换成作者，
// 否则用 contributors（不写假人名）。
const license = fs
  .readFileSync(path.join(root, 'LICENSE'), 'utf8')
  .replace(/^Copyright \(c\) 2026 .*$/m, `Copyright (c) 2026 ${process.env.AURA_AUTHOR?.trim() || 'aura-basetools contributors'}`)
fs.writeFileSync(path.join(out, 'LICENSE'), license)
copied.push({ file: 'LICENSE', bytes: Buffer.byteLength(license) })
// 第三方声明与 LICENSE 同处随包发，内容**逐字不改**：BSD-3-Clause 要求再分发时保留
// 版权声明、三条款与免责声明全文（只留一行归属不够）。
const thirdPartyNotices = fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8')
fs.writeFileSync(path.join(out, 'THIRD-PARTY-NOTICES.md'), thirdPartyNotices)
copied.push({ file: 'THIRD-PARTY-NOTICES.md', bytes: Buffer.byteLength(thirdPartyNotices) })

const patch = `# 由 build/make-bundle.mjs 生成 —— 不要手改（改源：src/aura-read/ · src/aura-edit/ · src/locator-lab/）。
#
# \`name\` 用 **patch 相对路径**：加载器把 ./ 与 ../ 转成相对本文件的 file URL
# （dsh-app-boot/README.md:59），因此包装在 Windows / macOS / Linux、装在任意目录都成立。
#
# 内置 read / write / edit / read_image 一个都没停用：只加不减。
# aura_basetools_write 与 aura_basetools_edit 由同一个插件模块注册（只多一个工具，不多一行 patch）。
# read_image 没有 Aura 替代品，停用 tool-fs 会净损失读图能力。
- insert:
    - id: tool-aura-read
      name: './aura-read/index.js'

    - id: tool-aura-edit
      name: './aura-edit/index.js'
`
fs.writeFileSync(path.join(out, 'cordis.patch.yml'), patch)
copied.push({ file: 'cordis.patch.yml', bytes: Buffer.byteLength(patch) })

// 发布元数据只在环境变量**真的设了**时才写：不编一个假仓库地址。
const repoUrl = process.env.AURA_REPO_URL?.trim()
const author = process.env.AURA_AUTHOR?.trim()
const pkg = {
  name: 'aura-basetools',
  version,
  description:
    'Byte-exact read, edit and write tools for coding agents. Standalone CLI and MCP server; optional DeepSeek Harness adapter. 面向 coding agent 的逐字节读写工具；独立 CLI / MCP，可选 DSH 适配器。',
  license: 'MIT',
  type: 'module',
  engines: { node: '>=18' },
  bin: BIN_ENTRIES,
  keywords: ['mcp', 'cli', 'read', 'edit', 'agent', 'codex', 'claude-code', 'cursor'],
  // test/ 也发：用户与 CI 能直接跑包里那份验收（"测你真正要发的东西"）。
  // dsh/ 必须在这一行里：npm pack 只发 files 列到的东西 —— 漏了它，包里就没有那个执行器，
  // 而 profile 指向它 ⇒ 宿主下次组合直接 import 失败（装完看着一切正常的那种坏）。
  files: ['aura-read/', 'aura-edit/', 'locator-lab/', 'bin/', 'lib/', 'test/', 'dsh/', 'cordis.patch.yml', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  // 三个 peer 必须声明：`dsh/argv-shell.mjs` 顶层 import `@deepseek-ai/dsh-shell`，
  // 宿主按绝对路径 import 插件，只从 `<prefix>/node_modules/` 往上找。
  peerDependencies: {
    '@deepseek-ai/dsh-tools': '*',
    '@deepseek-ai/dsh-shell': '*',
    '@deepseek-ai/schemastery': '*',
  },
  peerDependenciesMeta: {
    '@deepseek-ai/dsh-tools': { optional: true },
    '@deepseek-ai/dsh-shell': { optional: true },
    '@deepseek-ai/schemastery': { optional: true },
  },
}
if (repoUrl) {
  pkg.repository = { type: 'git', url: repoUrl }
  pkg.homepage = repoUrl
  pkg.bugs = { url: `${repoUrl.replace(/\/+$/, '')}/issues` }
}
if (author) pkg.author = author
if (!repoUrl && !author) console.log('未设 AURA_REPO_URL / AURA_AUTHOR，package.json 里不写 repository/author')
const pkgText = `${JSON.stringify(pkg, null, 2)}\n`
fs.writeFileSync(path.join(out, 'package.json'), pkgText)
copied.push({ file: 'package.json', bytes: Buffer.byteLength(pkgText) })

const total = copied.reduce((sum, item) => sum + item.bytes, 0)
console.log(`生成 ${path.relative(root, out)}  （${copied.length} 个文件，${(total / 1024).toFixed(1)} KB，version=${version}）`)
for (const c of copied) console.log(`  ${String(c.bytes).padStart(7)}  ${c.file}`)

if (process.argv.includes('--pack')) {
  // 拆包产物从**刚打好的这份**派生。分成两条命令时，`dist/npm` 会静默停在旧字节上
  // （与 manifest 陈旧同形：包看起来叫 0.7.0，里面是上一版）。一条重建命令 = 一份完整产物。
  console.log('\n—— 由组合产物派生 npm 双包 ——')
  execFileSync(process.execPath, [path.join(root, 'build', 'make-split-packages.mjs'), '--pack'], { cwd: root, stdio: 'inherit' })
  // 能力清单也从同一份构建产物派生：语言表/地址档/限制全部读源码导出，不手抄。
  console.log('\n—— 能力清单 ——')
  execFileSync(process.execPath, [path.join(root, 'build', 'capabilities.mjs'), '--write'], { cwd: root, stdio: 'inherit' })
}
