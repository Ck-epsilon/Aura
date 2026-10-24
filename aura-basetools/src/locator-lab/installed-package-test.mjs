/**
 * installed-package-test —— **冒烟测试（部署面）**：装出来的那一份，在它的位置上能不能用。
 *
 * ## 它为什么不能被别的套件替代
 *
 * `real-framework-smoke-test` 验的是**源码树里**的插件能不能被真框架注册 —— 那证明代码对。
 * 它证明不了**装出来的那一份**对：装完是另一棵树（`<prefix>/node_modules/aura-basetools`），
 * 依赖从那棵树向上解析，bin 从那棵树启动。一次真实的启动事故正是这个形状：
 *
 * > 装完一切正常、`--version`/`--doctor` 全绿，而 dsh 重启后 `import()` 抛
 * > `ERR_MODULE_NOT_FOUND` —— 因为插件的两个宿主 peer 在**装包位置**不可达。
 *
 * 所以本套件只对着**装出来的目录**判，判据是四条可观测事实：
 *   ① 每个 `.mjs` 都能从它的真实位置被 `import()`（不只是“文件在”）；
 *   ② 声明为 peer 的宿主包从**装包位置**可解析（这正是事故的那一格）；
 *   ③ bin 目标存在且真能起来（不是 0KB 或指向不存在的路径）；
 *   ④ `install.json` 记的文件清单与磁盘一致（体检靠它回答“被动过吗”）。
 *
 * 找不到安装目录时**自报跳过**并印得显眼——一个悄悄跳过的套件等于不存在。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..')
const asUrl = (p) => pathToFileURL(p).href

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

/** 装到哪儿：默认 `~/.aura/pkg`；`AURA_PKG_DIR` 可指到别处（测试、CI）。 */
const prefix = process.env.AURA_PKG_DIR ?? path.join(os.homedir(), '.aura', 'pkg')
const installDir = path.join(prefix, 'node_modules', 'aura-basetools')
const statePath = path.join(prefix, 'install.json')

if (!fs.existsSync(path.join(installDir, 'package.json'))) {
  say('')
  say(`⚠️  跳过 installed-package：装出来的包不存在（${installDir}）。`)
  say('    这不等于通过——它只说明本机还没装（`npm i -g aura-basetools` 装一次即可）。')
  say('')
  say('--- 0/0 通过（已跳过）---')
  process.exit(0)
}

const pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'))
say(`安装位置：${installDir}（${pkg.name} ${pkg.version}）`)
say('')

say('=== A. 每个库模块都能从它的真实位置被 import ===')
{
  /**
   * 判据是 **import()**，不是 fs.existsSync——后者是这一格曾经的假绿（“文件在”≠“能加载”）。
   *
   * **但入口文件不能 import**：`bin/*.mjs` 与旧交付包的 `install.mjs` 的顶层是“被执行”的代码
   * （无参数时打用法并 `process.exit(0)`）。第一版把它们也 import 了一遍，
   * 结果**把本测试进程自己跑死了**——段 A 之后的断言一条都没执行，而输出看起来只是
   * “A 段没印结果”（看上去像打印问题）。入口是**该被跑**的，由段 C 用子进程验证。
   */
  const isEntrypoint = (rel) => rel.startsWith('bin/') || rel.startsWith('test/') || rel === 'install.mjs'
  const files = []
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      const abs = path.join(dir, e.name)
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(abs, r)
      else if (e.name.endsWith('.mjs')) files.push(r)
    }
  }
  walk(installDir, '')
  const libraries = files.filter((r) => !isEntrypoint(r))
  check(libraries.length >= 8, `扫到 ${libraries.length} 个库模块（判据非空）`, libraries.join(', '))
  check(files.length > libraries.length, `另有 ${files.length - libraries.length} 个入口文件（由段 C 用子进程验）`, files.filter(isEntrypoint).join(', '))
  const failed = []
  for (const rel of libraries) {
    try {
      await import(asUrl(path.join(installDir, rel)))
    } catch (error) {
      failed.push(`${rel}: ${String(error.code ?? error.message).split('\n')[0]}`)
    }
  }
  check(failed.length === 0, '全部库模块都能从装包位置 import', failed.slice(0, 4).join(' | '))
}

say('')
say('=== B. peer 声明必须从**装包位置**可解析（历史事故的那一格）===')
{
  const req = createRequire(path.join(installDir, 'aura-read', 'index.js'))
  const peers = Object.keys(pkg.peerDependencies ?? {})
  check(peers.length > 0, `包声明了 ${peers.length} 个 peer`, peers.join(', '))
  for (const peer of peers) {
    let resolved = null
    try {
      resolved = req.resolve(peer)
    } catch (error) {
      check(false, `peer 可从装包位置解析：${peer}`, `${String(error.code ?? error.message).split('\n')[0]}（dsh 面需要它；只跑 CLI 的机器上可忽略）`)
      continue
    }
    // 解析到还不够——要真能 import（版本不匹配时 resolve 会过、import 会炸）
    let importable = true
    let why = ''
    try {
      await import(asUrl(resolved))
    } catch (error) {
      importable = false
      why = String(error.message).split('\n')[0]
    }
    check(importable, `peer 可解析且可 import：${peer}`, importable ? resolved.replace(installDir, '<pkg>') : why)
  }

  /**
   * B2. **执行器那一格** —— 上面那个循环只盖到「声明过的 peer」（链的**输入**），
   * 这里盖的是**症状**：`dsh/argv-shell.mjs` 顶层那句 `import { ShellExecutor }` 能不能成立。
   *
   * 为什么单独列一条：这一格坏掉时**不报错到这里**——钩子全不触发，看上去像“钩子没注册”，
   * 而真因是 peer 不可达。实测过一次：只把 dsh-shell 写进 package.json 的 peerDependencies，
   * 临时前缀里就是没有 `@deepseek-ai/dsh-shell` junction（安装器的 HOST_PEERS 是另一份清单），
   * 那句 import 直接 ERR_MODULE_NOT_FOUND。所以两个判据必须成对：
   *   B2a —— 声明在（链的输入），B2b —— 真能 import（症状）。删掉任一边，这一对都会红。
   */
  const shellRange = pkg.peerDependencies?.['@deepseek-ai/dsh-shell']
  const shellMeta = pkg.peerDependenciesMeta?.['@deepseek-ai/dsh-shell']
  check(
    Boolean(shellRange) && shellMeta?.optional === true,
    'B2a 声明了执行器要的 peer：@deepseek-ai/dsh-shell（与 dsh-tools 同形 optional）',
    `peer=${JSON.stringify(shellRange ?? null)} meta=${JSON.stringify(shellMeta ?? null)}`,
  )
  let shellKind = ''
  let shellWhy = ''
  try {
    const m = await import(asUrl(path.join(installDir, 'dsh', 'argv-shell.mjs')))
    shellKind = typeof m.default
  } catch (error) {
    shellWhy = String(error.code ?? error.message).split('\n')[0]
  }
  check(
    shellKind === 'object' || shellKind === 'function',
    'B2b 执行器从装包位置能真 import（dsh/argv-shell.mjs ⇒ @deepseek-ai/dsh-shell 可达）',
    shellKind ? `default: ${shellKind}` : `${shellWhy}（钩子会全不触发）`,
  )
}

say('')
say('=== C. bin 目标存在且真能起来 ===')
{
  const bins = Object.entries(pkg.bin ?? {})
  check(bins.length > 0, `包声明了 ${bins.length} 个 bin`, bins.map(([n]) => n).join(','))
  for (const [name, target] of bins) {
    const abs = path.join(installDir, target)
    check(fs.existsSync(abs) && fs.statSync(abs).size > 0, `bin ${name} 的目标存在且非空（${target}）`)
    /**
     * 两个 bin 的“起来”是**两件事**，不能共用一个判据：
     *   · `aura` —— CLI，`--version` 回 `{ok:true,version}`；
     *   `aura-mcp` —— MCP 服务器，**不认命令行**，直接等 stdin（`--version` 什么都不印）。
     * 拿 `--version` 去测 MCP 会得到“没输出”，而那是**正确行为**（第一版就这么误判的）。
     * 对它的真判据是：喂一个 `initialize`，必须回包。
     */
    if (name === 'aura') {
      // `stdio` 第二三项显式指定：`--version` 的 stdout 里带整段 usage（几千字符），
      // 不让它冲着测试日志。
      const res = spawnSync(process.execPath, [abs, '--version'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
      // 取**第一行**：`--pretty` 下最后一行是 `}`（本仓已两次踩过“json() 取最后一行”）。
      let parsed = null
      try {
        parsed = JSON.parse(String(res.stdout).trim().split('\n')[0])
      } catch {
        parsed = null
      }
      check(res.status === 0 && parsed?.ok === true, `bin aura --version 回 {ok:true,version}（exit ${res.status}）`, JSON.stringify(parsed ?? String(res.stderr).slice(0, 80)))
      check(parsed?.version === pkg.version, `bin 自报版本与包版本一致（${parsed?.version} vs ${pkg.version}）`)
    } else {
      // MCP：喂一帧 initialize，必须收到带 serverInfo 的回包
      const frame = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })}\n`
      const res = spawnSync(process.execPath, [abs], { input: frame, encoding: 'utf8', timeout: 30000 })
      let reply = null
      try {
        reply = JSON.parse(String(res.stdout).trim().split('\n').filter(Boolean)[0])
      } catch {
        reply = null
      }
      check(reply?.result?.serverInfo?.name === 'aura-basetools', `bin ${name} 对 initialize 回包（MCP 面能起来）`, JSON.stringify(reply?.result?.serverInfo ?? String(res.stdout).slice(0, 80)))
    }
  }
}

say('')
say('=== D. 状态文件记的文件清单与磁盘一致（体检靠它回答“被动过吗”）===')
{
  if (!fs.existsSync(statePath)) {
    check(false, 'install.json 存在（体检与升级都靠它）', statePath)
  } else {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    const recorded = Object.keys(state.files ?? {})
    check(recorded.length > 10, `install.json 记了 ${recorded.length} 个文件的哈希`, state.buildStamp ?? '')
    check(typeof state.treeHash === 'string' && state.treeHash.length === 64, '记了整棵树的哈希（升级时用来判“同版不同字节”）')
    // 抽查：记录里的哈希与磁盘当前内容一致
    const crypto = await import('node:crypto')
    const drift = []
    for (const rel of recorded.slice(0, 40)) {
      const abs = path.join(installDir, rel)
      if (!fs.existsSync(abs)) {
        drift.push(`${rel}(缺失)`)
        continue
      }
      const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
      if (hash !== state.files[rel]) drift.push(`${rel}(哈希不符)`)
    }
    check(drift.length === 0, '抽查 40 个文件：磁盘内容与记录一致', drift.slice(0, 4).join(', '))
  }
}

say('')
say('=== E. 装出来的包与被测源码树是同一份字节 ===')
{
  // 这一条把“开发树 vs 装出来的那份”的漂移变成红色。
  // 它**允许**不同（用户可能装着旧版），但那时会明确说出来，而不是让两份悄悄分叉。
  const pairs = [
    ['aura-read/index.js', 'src/aura-read/index.js'],
    ['aura-edit/index.js', 'src/aura-edit/index.js'],
    ['locator-lab/args.mjs', 'src/locator-lab/args.mjs'],
    ['locator-lab/write-path.mjs', 'src/locator-lab/write-path.mjs'],
  ]
  const crypto = await import('node:crypto')
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  const differs = []
  for (const [inPkg, inSrc] of pairs) {
    const a = path.join(installDir, inPkg)
    const b = path.join(pkgRoot, inSrc)
    if (!fs.existsSync(a) || !fs.existsSync(b)) continue
    if (sha(a) !== sha(b)) differs.push(inPkg)
  }
  // 不作“必须相同”的硬断言：装的是发布版、开发树可能已往前走了，那是正常状态。
  // 但**必须说出来**——这条信息的价值在于“你现在验的是哪一份”。
  if (differs.length === 0) {
    check(true, '装出来的包与当前源码树逐字节相同（本轮验的就是正在跑的那一份）')
  } else {
    say(`· 提示：装出来的包与当前源码树不同：${differs.join(', ')}`)
    // 不写版本号：这条提示曾经写死 `aura-tools-0.5.3.tgz`，而它的读者正是“两者已经不同”的时候——
    // 那时版本号必然已经变了。指向**目录**既不需要版本，也照样能装。
    say('  （正常状态：装的是发布版，开发树已往前走了。要让两者同步：npm i -g aura-basetools）')
    check(true, '已如实区分“装出来的那份”与“源码树”：不把它们当成同一份')
  }
}

say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
