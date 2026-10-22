/**
 * make-bundle.mjs —— 把 aura 读写工具打成**一个可安装的包**，同时服务两拨用户：
 *
 *   ① DSH 用户：`dsh plugin --profile web add <包名|tarball|git|目录>` —— 包里带
 *      `dsh.bundle.patch`（`cordis.patch.yml`），装上就是 aura_read / aura_edit 两个工具；
 *   ② 别的 agent（Codex / Claude Code / Cursor …）：`npx -y aura-basetools mcp` 起 MCP stdio 服务，
 *      或直接用 `aura` CLI —— **不要求对方装 DSH**，也不要求任何操作系统特定的东西。
 *
 * 两种用法的路径因此都必须是可移植的：
 *   · patch 里的 `name` 用 **patch 相对路径**（`./aura-read/index.js`）——加载器把它转成相对
 *     本 patch 文件的 file URL（`dsh-app-boot/README.md:59`），包装在哪儿都成立；
 *   · 独立面只依赖 `node:fs` / `node:os` / `node:path`，没有盘符、没有平台分支。
 *
 * 项目内布局（本脚本假定自己住在 <项目>/build/）：
 *   src/{aura-read,aura-edit,locator-lab,aura-standalone}/   源
 *   dist/                                产出（.tgz / 交付包 zip / 一页说明 / 解压包体）
 *
 * 产出是**派生物**：`dist/aura-basetools/` 整个目录由本脚本生成，不要手改；改源再重跑。
 *
 *   node build/make-bundle.mjs            # 生成 dist/aura-basetools/
 *   node build/make-bundle.mjs --pack     # 再打 .tgz 与交付包 zip
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { walkFiles, writeZip } from './zip.mjs'
// 语言表直接读引擎：生成的 README 里那个"N 种源码扩展名"必须与引擎一致，
// 写死的数字会漂（F1 扩了 21 种格式，文档里就得多改几处）。
import { LANGS } from '../src/locator-lab/struct-core.mjs'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'dist', 'aura-basetools')
/** 源都在 <项目>/src/ 下：四个目录是相对引用的一套，整体搬动不影响彼此。 */
const src = path.join(root, 'src')

/** 引擎：四个判据/结构文件 + 写路径（C9–C14 的保真、闸门、回读都在最后这个里）。 */
const ENGINE = [
  'read-core.mjs',
  'locator-api.mjs',
  'struct-core.mjs',
  'anchor-core.mjs',
  'write-path.mjs',
  'args.mjs',
  // 仓库级地图（T26）：`aura_read` 传目录时由它渲染。两个壳都 import 它，漏打包 = 包内直接崩。
  'repo-map.mjs',
  // 区间句柄（HD1）：`aura_read` 发、`aura_edit` 解析。两个壳都经引擎碰到它，漏打包 = 包内直接崩。
  'handle-core.mjs',
]
/** DSH 面：两个工具壳（宿主代码，走 ctx.fs）。 */
const SHELLS = [
  ['aura-read', 'index.js'],
  ['aura-edit', 'index.js'],
]
/**
 * 钩子执行器（宿主面）：`ctx.shell` 的替代实现，摘掉每次工具调用的外层壳税。
 *
 * 【为什么要随包发货】profile 里那一行 `name:` 指到哪儿，宿主就从哪儿 import。
 * 指向仓库工作区（`dsh/argv-shell.mjs`）等于把整套东西绑在
 * 「这个仓库必须存在、必须在这个路径」上；指向安装副本才与两个工具壳同一条先例 ——
 * 包装在哪儿都成立（`<prefix>/node_modules/aura-basetools/aura-read/index.js` 就是这么指的）。
 *
 * 它要 spawn 子进程（钩子命令串 → argv），所以 kind 用 'host'：允许 node:fs，
 * 仍禁盘符与平台分支（与两个壳同一档守卫）。
 * 包内路径与源树**同名**（`dsh/argv-shell.mjs`），安装副本里因此不多出一层相对布局。
 */
const HOOK_SHELL = ['dsh/argv-shell.mjs', 'dsh/hook-inproc.mjs']
/** 独立面：CLI + MCP + node:fs 提供方（宿主代码，允许直接用 node:fs）。 */
const STANDALONE = [
  ['aura-standalone/bin', 'bin'],
  ['aura-standalone/lib', 'lib'],
  ['aura-standalone/test', 'test'],
]
/** 一键安装器：跟包一起发（`node install.mjs`），它自己带平台分支，因此走 installer 档守卫。 */
const INSTALLER = ['build/install.mjs', 'install.mjs']

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
  // 安装器是唯一允许写平台分支的：它要生成 .cmd 壳（Windows）还是 sh 壳（POSIX）
  if (kind !== 'installer' && /process\.platform/.test(text)) bad.push('process.platform')
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
    // 靶场（`range-*.mjs`）是**项目级**的：它们按项目布局（`dist/`、`src/`）找路径，塞进包里跑不起来。
    // 包里只留真能在包内跑的验收（`standalone-test.mjs`）——不发一份跑不动的东西。
    if (!name.endsWith('.mjs') || name.startsWith('range-')) continue
    copyFile(path.join(abs, name), path.join(out, toDir, name), 'host')
  }
}
for (const rel of HOOK_SHELL) copyFile(path.join(root, rel), path.join(out, rel), 'host')
copyFile(path.join(root, INSTALLER[0]), path.join(out, INSTALLER[1]), 'installer')
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
    'Aura read/edit tools — one package, two ways in: install it as a DeepSeek Harness bundle (aura_read / aura_edit), or run the standalone `aura` CLI / MCP server from Codex, Claude Code, Cursor or any other agent. Symbol-aware reading, intent-addressed byte-exact editing, stale-region gate, read-back verification.',
  license: 'MIT',
  type: 'module',
  engines: { node: '>=18' },
  bin: { aura: './bin/aura.mjs', 'aura-mcp': './bin/aura-mcp.mjs' },
  keywords: ['dsh', 'deepseek-harness', 'plugin', 'bundle', 'mcp', 'read', 'edit', 'codex'],
  // test/ 也发：用户与 CI 能直接跑包里那份验收（"测你真正要发的东西" —— 开发树里路径不对，跑不起来）
  // dsh/ 必须在这一行里：npm pack 只发 files 列到的东西 —— 漏了它，包里就没有那个执行器，
  // 而 profile 指向它 ⇒ 宿主下次组合直接 import 失败（装完看着一切正常的那种坏）。
  files: ['aura-read/', 'aura-edit/', 'locator-lab/', 'bin/', 'lib/', 'test/', 'dsh/', 'install.mjs', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  // `@deepseek-ai/dsh-shell` 与另两个一样，必须是**声明过的 peer**：`dsh/argv-shell.mjs` 顶层
  // 就 `import { ShellExecutor }` 它（执行器借宿主的壳跑命令），而 DSH 用**绝对路径** import 插件
  // ⇒ 依赖只从 `<prefix>/node_modules/` 往上找。安装器与 npm 的 peer 链接都只认**声明过的** peer：
  // 漏了这行 ⇒ 装完一切看起来正常，宿主组合时那一行 import 报 ERR_MODULE_NOT_FOUND，
  // 而症状只是“钩子全不触发”（没有堆栈指向这里），极难查。
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

const readme = `# aura-basetools ${version}

一个包，两条路进 —— 读文件按意图取景、改文件按意图寻址，**逐字节保真**（前导 BOM 与每行行尾都不动），
改完还会**读回来验一遍**；区域在你读之后被别人动过时**结构化拒绝**，而不是静默覆盖。

## 一、一键安装（推荐：人双击，agent 一条命令）

交付包（zip）里除了本包，还有 \`一键安装.cmd\`（Windows 双击）、\`一键安装.command\`（macOS 双击）与 \`install.mjs\`：

\`\`\`bash
node install.mjs --yes --json     # 人 / 脚本 / agent 都用这一条：非交互、幂等、结果机器可读
node install.mjs --dry-run        # 先看它要动哪些文件
node install.mjs --uninstall      # 撤销（只撤它自己加的东西）
\`\`\`

它把包复制到 \`~/.aura/pkg\`、生成 \`aura\` / \`aura-mcp\`、把 MCP 服务器注册进检测到的 agent 配置
（Codex / Claude Code / Cursor，每个文件先备份成 \`*.bak-aura-<时间戳>\`），最后跑一次真自检。
只有手上**只有 .tgz、没有解压目录**时，才需要下面的手工路线。

## 二、手工路线（Codex / Claude Code / Cursor / 任何能跑命令的 agent）—— 不需要 DSH

拿到的是 .tgz 时（未发布到 npm）——先装一次，两个 bin 就上 PATH：

\`\`\`bash
npm i -g ./aura-basetools-${version}.tgz      # 或者项目内 npm i ./aura-basetools-${version}.tgz（之后用 npx aura …）
\`\`\`

然后接进你的 agent：

\`\`\`bash
# Codex（子命令形状已实测：codex mcp add <NAME> -- <COMMAND>…）
codex mcp add aura -- aura mcp

# Claude Code（同形：claude mcp add [options] <name> -- <command> [args…]）
claude mcp add aura -- aura mcp
\`\`\`

其它 MCP 客户端（Cursor / Zed / …）写进自己的配置，形状都一样：

\`\`\`json
{ "mcpServers": { "aura": { "command": "aura", "args": ["mcp"] } } }
\`\`\`

没做全局安装时：把 command 换成 npx、args 换成 ["aura", "mcp"]（项目内安装）。
**已发布到 npm** 时才有 npx -y aura-basetools … 这种写法（本包当前按 tarball 分发）。

CLI 也可以直接调：

\`\`\`bash
aura read  --file src/app.ts --mode map
aura edit  --file src/app.ts --hunks '[{"target":"main","replace":"…"}]'
aura --help
\`\`\`

Windows / macOS / Linux 同一套命令（纯 Node，≥18，无原生依赖）。

**先读后改**：\`aura read\` 会给出一个 \`version\` 令牌；\`aura edit\` 会核对"这块区域在你读之后有没有被改过"。
观测缓存默认落在 \`~/.aura/observations.json\`，可用环境变量 \`AURA_CACHE_DIR\` 改（CI 里建议设成临时目录）。

## 三、DSH 用户（DeepSeek Harness）

\`\`\`bash
dsh plugin --profile web add ./aura-basetools-${version}.tgz
# 或：dsh plugin --profile web add aura-basetools          （已发布到 npm）
# 或：dsh plugin --profile web add github:<user>/<repo>
\`\`\`

装完重启 dsh。内置 \`read\` / \`write\` / \`edit\` / \`read_image\` **一个都没停用**：只加不减。

包里还带一个钩子执行器 \`dsh/argv-shell.mjs\`（\`ctx.shell\` 的替代实现，摘掉每次工具调用的外层壳税）。
profile 里那一行要指**安装副本**，不要指仓库工作区：

\`\`\`yaml
        - id: polaris-hooks-shell
          name: '<prefix>/node_modules/aura-basetools/dsh/argv-shell.mjs'
\`\`\`

（\`<prefix>\` 默认 \`~/.aura/pkg\`。指仓库路径等于把这套东西绑在「这个仓库必须在、必须在这个路径」上。）

验证与回滚：

\`\`\`bash
dsh --profile web --dump-config | grep tool-aura     # 应看到两行
dsh plugin --profile web remove aura-basetools
\`\`\`

## 它带来什么

- \`aura_read\`（MCP 工具 / \`aura read\`）：\`map\` 符号目录、\`digest\` 接口、\`full\`、\`around\`、\`lines\`、
七种取景；${Object.keys(LANGS).length} 种源码扩展名的符号表（由引擎语言表决定）；未索引扩展名自动退到整份内容。
- \`aura_edit\`（MCP 工具 / \`aura edit\`）：\`target\` / \`lines\` / \`line_cue\` / \`anchor\` 四层寻址，
  \`expect\` 断言、\`dry_run\` 预演、多 hunk 原子（任一失败则磁盘不变）、逐字节写回、
  区域级新鲜度闸门、落盘后整份回读校验。

## 已知边界

单 \`\\r\`（老 Mac）行尾不支持（行号是跨层共享判据）；二进制文件两侧都拒绝；超大文件（>256 KiB）不进
观测缓存（此时回执带 \`unverified_region\`，闸门放行而不误拒）。
`
fs.writeFileSync(path.join(out, 'README.md'), readme)
copied.push({ file: 'README.md', bytes: Buffer.byteLength(readme) })

/** "发给对方"的一页说明：收件人拿到 .tgz 时读不到包里的 README（还没解包），所以把它放在包旁边一起发。 */
const handoff = `# aura-basetools ${version} —— 一页说明（整个文件夹发给对方即可）

**这是什么**：给 AI coding agent 用的文件读写工具。读按意图取景（符号目录 / 接口 / 窗口 / 搜索 / 差异），
改按意图寻址（符号名 / 行号 / 唯一词 / 记忆原文），**逐字节保真**（UTF-8 BOM 与每行行尾都不动），
它**拒绝**并告诉你重读哪几行
而不是静默覆盖。**不依赖任何特定 harness、不需要 npm**，纯 Node（≥18），Windows / macOS / Linux 同一套。

## 装（三种，任选一种）

**① 人：双击**

Windows 双击 \`一键安装.cmd\`；macOS 双击 \`一键安装.command\`。macOS 若提示
“来自身份不明的开发者”：右键 → 打开；或者直接把这句贴进终端：

\`\`\`bash
cd <解压目录> && node aura-basetools/install.mjs --yes
\`\`\`

**② 交给 agent：一句话**

把解压后的文件夹丢给 Codex / Claude Code / Cursor，然后说：

> 读 <目录>/aura-basetools/install.mjs 的开头注释，然后跑 \`node <目录>/aura-basetools/install.mjs --yes --json\`，
> 把 JSON 结果念给我听。

安装器非交互、幂等、结果机器可读（装到哪、注册了哪些 agent、自检过没过都在 JSON 里）。

**③ 手工（只想用 .tgz、或已经会用命令行）**

\`\`\`bash
npm i -g ./aura-basetools-${version}.tgz       # 两个命令就上 PATH：aura、aura-mcp
codex mcp add aura -- aura mcp            # Codex（codex mcp add <NAME> -- <COMMAND>…）
claude mcp add aura -- aura mcp           # Claude Code（同形）
\`\`\`

其它 MCP 客户端写进自己的配置即可：

\`\`\`json
{ "mcpServers": { "aura": { "command": "aura", "args": ["mcp"] } } }
\`\`\`

**④ 你用 DeepSeek Harness**

\`\`\`bash
dsh plugin --profile web add ./aura-basetools-${version}.tgz     # 装完重启 dsh
\`\`\`

## 安装器做了什么

1. 包体复制到 \`~/.aura/pkg/node_modules/aura-basetools\`（自带解包，不需要 npm）
2. 生成 \`aura\` / \`aura-mcp\` 命令（sh 壳与 .cmd 壳都生成）
3. 把 MCP 服务器注册进**检测到的** agent：Codex \`~/.codex/config.toml\`、Claude Code \`~/.claude.json\`、
   Cursor \`~/.cursor/mcp.json\`；一个都没检测到就打印一段 JSON 片段给你贴
4. 跑一次真自检：CLI 取景 + MCP 握手（两个工具都在才算过，不是“看着像成功了”）

每个被改的配置文件都先备份成 \`<文件>.bak-aura-<时间戳>\`；**默认不碰 DSH 配置**
已有别的补丁内容时会拒绝并打印该加的行

## 撤销

\`\`\`bash
node aura-basetools/install.mjs --uninstall     # 只撤它自己加的东西；别人写的同名项一律不碰
\`\`\`

## 自检（30 秒）

\`\`\`bash
aura read --file <随便一个源码文件> --mode map      # 应列出符号名与行号
\`\`\`

## 同目录还有一份

\`aura-basetools-${version}-优势说明.md\`：与常规 read / write / edit 的对照（含可在自己机器上复跑的字节对照实验），
给评估者/决策者看的那一份。

## 它不做什么

不删文件、不改名、不写二进制；单 \`\\r\`（老 Mac）行尾不支持；\`aura edit\` 刻意不能整份覆写
（要整份写就用你的编辑器）。
`
const handoffPath = path.join(root, 'dist', `aura-basetools-${version}-安装说明.md`)
fs.writeFileSync(handoffPath, handoff)
console.log(`\n一页说明 → ${path.relative(root, handoffPath)}`)

const total = copied.reduce((sum, item) => sum + item.bytes, 0)
console.log(`生成 ${path.relative(root, out)}  （${copied.length} 个文件，${(total / 1024).toFixed(1)} KB，version=${version}）`)
for (const c of copied) console.log(`  ${String(c.bytes).padStart(7)}  ${c.file}`)

if (process.argv.includes('--pack')) {
  // Windows 上 npm 是个 .cmd 包装：不带 shell 直接 spawn 会先 ENOENT、再（点名 npm.cmd 后）EINVAL
  // —— Node 对 .cmd 要求经 shell 启动。三次尝试的结论：shell:true 是唯一稳的那条（实测）。
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  // 打进 dist/（包的**外面**）：包里不留 .tgz，免得它被当成运行时文件一起装进去
  const tgz = execFileSync(npmBin, ['pack', '--pack-destination', path.join(root, 'dist')], { cwd: out, encoding: 'utf8', shell: true })
    .trim()
    .split('\n')
    .pop()
  const file = path.join(root, 'dist', tgz)
  console.log(`\nnpm pack → ${path.relative(root, file)}  (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`)

  /**
   * 发布清单（服务化安装的“版本发现”入口）。
   *
   * ## 为什么由构建生成，而不是手写一份
   *
   * `--check` / `--upgrade --manifest` 靠它答“有没有新版”，而判据是 **sha256**：
   * 手写的清单必然与产物跑偏（改一行源码、重打包，哈希就变了，而清单没人改），
   * 后果是升级在“校验”那一步被拒——而那个报错看起来像“包坏了”，不像“清单旧了”。
   * 所以它跟 `.tgz` 一起、在同一处、按**同一份字节**生成。
   *
   * ## 默认只指本地，不指网络
   *
   * `url` 默认写成旁边那个 `.tgz` 的**文件名**（相对路径）——安装器两种都支持，
   * 所以离线/内网直接可用；要发布到 https 时把这份清单的 url 换成真实地址即可。
   * 默认不填一个假域名：一个“看起来像能联网”的地址比空着更坏。
   *
   * ## 只写 stable
   *
   * `beta` 要真实存在一份不同的产物才有意义；凭空多一个渠道等于让人以为有两条路。
   */
  const sha256Of = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  const minNode = String(readJson(path.join(out, 'package.json'))?.engines?.node ?? '>=18').replace(/[^0-9]/g, '') || '18'
  const manifestPath = path.join(root, 'dist', 'manifest.json')
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        tool: 'aura-basetools',
        generatedAt: new Date().toISOString(),
        generatedBy: 'build/make-bundle.mjs',
        // 字段名对齐 install.mjs 的 pickChannel：tool + channels[渠道].{version,url,sha256,minNode}
        channels: { stable: { version, url: tgz, sha256: sha256Of(file), minNode } },
      },
      null,
      2,
    )}\n`,
  )
  console.log(`发布清单 → ${path.relative(root, manifestPath)}（stable ${version}，sha256 ${sha256Of(file).slice(0, 16)}…）`)
  console.log(`\nnpm pack → ${path.relative(root, file)}  (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`)
  try {
    console.log(execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim())
  } catch {
    console.log('(tar 不可用，跳过内容清单；用 npm pack 的产物自行核对)')
  }

  // 双击壳：人这条路的入口。参数透传（--dry-run / --home / --json 都能用），双击时就是 --yes 默认行为。
  const commandSh = [
    '#!/bin/sh',
    '# macOS 双击运行；也可以 ./一键安装.command --dry-run',
    'cd "$(dirname "$0")" || exit 1',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "需要先安装 Node.js 18 或更高版本：https://nodejs.org/（或 brew install node）"',
    '  echo "装好后再次双击本文件。"',
    '  printf "按回车关闭…"; read -r _',
    '  exit 1',
    'fi',
    'echo "aura-basetools 一键安装"',
    'node "aura-basetools/install.mjs" --yes "$@"',
    'status=$?',
    'if [ "$status" -ne 0 ]; then echo "安装器退出码 $status —— 把上面的输出发给提供者"; fi',
    'printf "\\n按回车关闭…"; read -r _',
    '',
  ].join('\n')
  const commandCmd = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo 需要先安装 Node.js 18 或更高版本：https://nodejs.org/',
    '  echo 装好后再次双击本文件。',
    '  pause',
    '  exit /b 1',
    ')',
    'echo aura-basetools 一键安装',
    'node "aura-basetools\\install.mjs" --yes %*',
    'if errorlevel 1 echo 安装器失败了，把上面的输出发给提供者',
    'echo.',
    'pause',
    '',
  ].join('\r\n')

  // 交付包：收件人拿到的就这一个 zip —— 里面有解压好的包体（不需要 npm）、.tgz（npm/DSH 路线）、
  // 双击壳（人类路线）、一页说明。.command 带 0755：zip 里不写模式位，macOS 双击会说不可执行。
  const zipPath = path.join(root, 'dist', `aura-basetools-${version}-交付包.zip`)
  const entries = walkFiles(out).map((item) => ({
    name: `aura-basetools/${item.relative}`,
    data: fs.readFileSync(item.absolute),
    mode: 0o644,
  }))
  entries.push({ name: tgz, data: fs.readFileSync(file), mode: 0o644 })
  entries.push({ name: `aura-basetools-${version}-安装说明.md`, data: Buffer.from(handoff), mode: 0o644 })
  // 客户/评估者版对照说明（源在 docs/，随交付包一起发；没有就跳过，不让构建挂掉）
  const prosPath = path.join(root, 'docs', 'aura-客户版-优势说明.md')
  if (fs.existsSync(prosPath)) {
    entries.push({ name: `aura-basetools-${version}-优势说明.md`, data: fs.readFileSync(prosPath), mode: 0o644 })
  } else {
    console.log('（没找到 docs/aura-客户版-优势说明.md，交付包里不含优势说明）')
  }
  entries.push({ name: '一键安装.command', data: Buffer.from(commandSh), mode: 0o755 })
  entries.push({ name: '一键安装.cmd', data: Buffer.from(commandCmd), mode: 0o644 })
  const zipResult = writeZip(entries, zipPath)
  console.log(`\n交付包 → ${path.relative(root, zipPath)}  (${(zipResult.bytes / 1024).toFixed(1)} KB, ${zipResult.entries} 项)`)
  for (const entry of entries) console.log(`  ${entry.name}`)
}
