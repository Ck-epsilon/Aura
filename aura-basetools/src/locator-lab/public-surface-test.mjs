/**
 * public-surface-test —— **验收测试**：对外承诺的每一条都成立。
 *
 * ## 它属于哪一类（本项目六类测试的分工）
 *
 * | 类 | 问什么 | 本仓对应 |
 * |----|--------|----------|
 * | 单元 | 这个函数对不对 | `read-test` / `struct-test` / `write-verify` …（最厚的一层）|
 * | 集成 | 几个部件接起来对不对 | `*-load-test`（mock ctx）、`range-args-test`（engine + 壳）|
 * | **验收** | **对外承诺的契约还在不在** | **本套件** + `split-package` |
 * | 冒烟 | 最关键的那条路能不能起来 | `real-framework-smoke-test` / `installed-package-test` |
 * | 回归 | 修过的 bug 没回来 | 每个 bug 都附了一条断言（散在各套件里）|
 * | 端到端 | 用户从入口到结果整条路 | `cli-mcp-e2e-test` + `split-package` |
 *
 * ## 为什么需要它
 *
 * 前三类都在回答“我实现得对不对”，没有一类在回答“**我答应别人的事还在不在**”。
 * 而这一层出事的方式很安静：删掉一个导出、改掉 `inject` 列表、动一个 bin 名，
 * 单元测试与集成测试**都可能全绿**，坏的是别人（DSH / Codex / Claude Code）那侧。
 *
 * 判据一律取“可观测的对外事实”：导出的名字、插件的四件套、bin 名、
 * 参数键与守卫名单是否同源、README 提到的相对路径是否存在。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const pkgRoot = path.resolve(here, '..', '..')
const asUrl = (p) => pathToFileURL(p).href

const say = (m) => process.stdout.write(`${m}\n`)
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  say(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

const read = (rel) => fs.readFileSync(path.join(pkgRoot, rel), 'utf8')

say('=== A. 插件的对外形状（DSH 加载器的契约）===')
const shells = {}
/**
 * 每个壳**必须导出**的名字（对外面的一部分，不是实现细节）。
 *
 * 为什么要逐个点名，而不是只查非空：一条“删掉某个导出”的注入曾让本套件**全绿**——
 * 因为旧断言只检查“apply 是函数”这类最少条件，删掉别的东西它看不见。
 * 对外面一旦少一项，坏的是别人那侧（宿主报 `cannot get property`、别的包 `import` 到 undefined），
 * 而单元/集成套件都可能全绿。
 */
const REQUIRED_EXPORTS = {
  'aura-read': ['name', 'inject', 'Config', 'apply', 'PASSTHROUGH_FIELDS', 'READ_ARG_KEYS'],
  'aura-edit': ['name', 'inject', 'Config', 'apply', 'EDIT_ARG_KEYS'],
}
for (const dir of ['aura-read', 'aura-edit']) {
  const mod = await import(asUrl(path.join(pkgRoot, 'src', dir, 'index.js')))
  shells[dir] = mod
  // Cordis 加载器要的四件套。少一件的失败发生在**宿主启动时**，而那时离开发已经很远。
  check(typeof mod.name === 'string' && mod.name.length > 0, `${dir}: 导出 name（${mod.name}）`)
  check(Array.isArray(mod.inject), `${dir}: 导出 inject 数组`, JSON.stringify(mod.inject))
  check(mod.Config !== undefined, `${dir}: 导出 Config（宿主拿它校验配置）`)
  check(typeof mod.apply === 'function', `${dir}: 导出 apply 函数`)
  // 逐个点名（含“值不能是 undefined”——`export const x = undefined` 也算少了）
  const missing = REQUIRED_EXPORTS[dir].filter((k) => mod[k] === undefined)
  check(missing.length === 0, `${dir}: 对外面齐全（${REQUIRED_EXPORTS[dir].length} 项，缺 ${JSON.stringify(missing)}）`)
}
check(
  JSON.stringify(shells['aura-read'].inject) === JSON.stringify(shells['aura-edit'].inject),
  '两个壳的 inject 相同（同一个宿主要求同一套服务）',
  JSON.stringify(shells['aura-read'].inject),
)
check(
  shells['aura-read'].name !== shells['aura-edit'].name,
  '两个壳的 name 不同（否则加载器会互相覆盖）',
  `${shells['aura-read'].name} / ${shells['aura-edit'].name}`,
)
/**
 * 引擎的纯度：只对**真正的引擎文件**成立。
 *
 * `locator-lab/` 里还住着测试与靶场，而它们**本来就该** import 壳（那些套件测的就是壳）。
 * 第一版把整个目录扫了一遍，于是 5 个测试文件被当成“引擎依赖了壳”——
 * 那是**我的判据边界画错了**，不是代码错。边界要与“哪些文件进包”同一份：
 * `build/bundle-layout.mjs` 的 `ENGINE`（打包与 `src↔dist` 比对也读它）。
 * 这里直接 import 那份清单，不再正则解析源码——清单搬家时正则只会读出 0 个文件，
 * 而那看起来像“判据通过了一个空集合”。
 */
const { ENGINE: engineFiles } = await import(asUrl(path.join(pkgRoot, 'build', 'bundle-layout.mjs')))
check(engineFiles.length >= 7, `从打包清单读出 ${engineFiles.length} 个引擎文件（判据取自 bundle-layout，不是手写）`, engineFiles.join(','))
const impure = engineFiles.filter((f) => /from '\.\.\/aura-(read|edit)/.test(read(`src/locator-lab/${f}`)))
check(impure.length === 0, '引擎文件都不依赖工具壳（依赖方向单向：壳 → 引擎）', impure.join(','))
// 顺带钉住“引擎不许碰 node:fs / process.platform”——打包时也有守卫，但那条只在 `--pack` 时才跑
const impure2 = engineFiles.filter((f) => /from 'node:fs'|require\('fs'\)|process\.platform/.test(read(`src/locator-lab/${f}`)))
check(impure2.length === 0, '引擎文件都不碰 node:fs / process.platform（与打包守卫同一条判据）', impure2.join(','))

say('')
say('=== B. 工具名与注册行为（scope 语义）===')
/** 最小 ctx：只实现 `apply` 真正会碰的那几件。 */
const mkCtx = (registered, hidden) => ({
  fs: {},
  inject: () => {},
  get: () => undefined,
  on: () => {},
  emit: () => {},
  tools: { register: (t) => registered.push(t), get: (n, scope) => (scope === 'hidden' ? undefined : registered.find((t) => t.name === n)) },
  systemPrompt: { section: (s) => registered.push({ __section: s }) },
})
const names = []
const EXPECTED_TOOLS = { 'aura-read': ['aura_basetools_read'], 'aura-edit': ['aura_basetools_edit', 'aura_basetools_write'] }
for (const dir of ['aura-read', 'aura-edit']) {
  const registered = []
  shells[dir].apply(mkCtx(registered, false))
  const tools = registered.filter((r) => r.name !== undefined && r.__section === undefined)
  const got = tools.map((t) => t.name).sort()
  const want = EXPECTED_TOOLS[dir].slice().sort()
  check(JSON.stringify(got) === JSON.stringify(want), `${dir}: 注册的工具恰好是 ${want.join(' / ')}`, `实际 ${got.join(' / ')}`)
  names.push(...tools.map((t) => t.name))
}
check(names.sort().join(',') === 'aura_basetools_edit,aura_basetools_read,aura_basetools_write', '三个工具名恰好是 aura_basetools_read / aura_basetools_edit / aura_basetools_write（模型与文档都按这三个名字调）', names.join(','))

say('')
say('=== C. 参数键的唯一来源：守卫名单 == schema 声明 == 兼容层实装 ===')
{
  // 两个壳各自维护一份“本工具接受哪些顶层键”。它同时被三处消费：
  //   · `parameters` 的 additionalProperties:false（真框架按它放行参数）
  //   · `assertKnownArgs`（运行期守卫）
  //   · `flatHunk`（平铺形状复用其中的地址键）
  // 三处若不同源，症状是“schema 里有、守卫却拒”或反过来的静默丢参数。
  const readKeys = [...shells['aura-read'].READ_ARG_KEYS].sort()
  const editKeys = [...shells['aura-edit'].EDIT_ARG_KEYS].sort()
  check(readKeys.includes('file_path') && readKeys.includes('mode'), 'aura_basetools_read 的名单含 file_path 与 mode', readKeys.join(','))
  check(editKeys.includes('file_path') && editKeys.includes('hunks'), 'aura_basetools_edit 的名单含 file_path 与 hunks', editKeys.join(','))
  // 平铺形状的地址键必须**在名单里**，否则守卫会拒掉模型真在用的形状
  //
  // 这份字面量是**手抄的第三方期望**（不从这里 import `FLAT_ADDRESS_KEYS` 派生）：派生就等于
  // 拿被测物当量具，下面那条"两份名单一致"的判据会永远自洽。`handle` 是 fs-contract-v2 的
  // 地址键（它单独在场就足以定下区间）；`old`（0.10.2）是内容地址，平铺形状可直接
  // `--old <原文>`（`replace_all` 依赖它）。
  // `line` / `position` **不是**地址键——它们只在 `handle` 同时在场时才成立（拒绝那一半在
  // `write-path.mjs` 的 `planHunks` 里）。
  const flat = ['target', 'lines', 'start_line', 'end_line', 'line_cue', 'anchor', 'handle', 'old']
  const missing = flat.filter((k) => !editKeys.includes(k))
  check(missing.length === 0, 'aura_basetools_edit 的名单覆盖全部平铺地址键（否则守卫拒自家实装的形状）', missing.join(','))
  const { FLAT_ADDRESS_KEYS } = await import(asUrl(path.join(pkgRoot, 'src', 'locator-lab', 'args.mjs')))
  check(
    JSON.stringify([...FLAT_ADDRESS_KEYS].sort()) === JSON.stringify(flat.slice().sort()),
    'FLAT_ADDRESS_KEYS 与壳里的平铺键一致（一份名单，不是两份）',
    FLAT_ADDRESS_KEYS.join(','),
  )
}

say('')
say('=== D. bin 名与 package.json 的声明一致 ===')
{
  const pkg = JSON.parse(read('dist/aura-basetools/package.json'))
  const bins = Object.keys(pkg.bin ?? {}).sort()
  check(bins.join(',') === 'aura,aura-mcp', 'bin 恰好是 aura 与 aura-mcp（文档里写的就是这两个）', bins.join(','))
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    check(fs.existsSync(path.join(pkgRoot, 'dist/aura-basetools', target)), `bin ${name} 的目标文件存在（${target}）`)
  }
  // 包名前缀是历史遗留（改名前叫 patch），但版本与 files 面必须自洽
  check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), `版本是语义化版本（${pkg.version}）`)
  const files = pkg.files ?? []
  for (const must of ['aura-read/', 'aura-edit/', 'locator-lab/', 'bin/']) {
    check(files.includes(must), `files 面含 ${must}（否则 npm 打包会漏掉它）`)
  }
  check(!files.includes('install.mjs'), '安装器已移除：files 面不再包含 install.mjs')
}

say('')
say('=== E. README 提到的相对路径必须真实存在 ===')
{
  // 文档里出现一个不存在的路径，是最廉价也最常见的一类“承诺失效”——
  // 而它不会让任何测试变红，只会让照着做的人卡住。
  const texts = ['README.md', 'docs/embed-example/README.md'].filter((p) => fs.existsSync(path.join(pkgRoot, p)))
  /**
   * **反引号内与外一起扫**，按去重后的目标判。
   *
   * 第一版的正则要求路径被反引号包住，实测只覆盖 README 的 16 条引用里的 **1** 条——
   * 因为 README 把脚本清单写在代码围栏里，围栏里是裸路径。于是“引用必须存在”这条断言
   * 几乎全是盲的：一条注入都能让它全绿。放宽到整篇原文后覆盖面变成 16 条，今天 0 条误报。
   * 判据仍是“存在”，与写法无关；真要有示意用的假路径，写成 `src/<名字>.mjs` 即可不被当成引用。
   */
  const TARGET = /(?:src|build|probes|docs)\/[A-Za-z0-9_\-/]+\.(?:mjs|js|md|json|yml)/g
  const refs = new Map()
  for (const rel of texts) {
    for (const m of read(rel).matchAll(TARGET)) if (!refs.has(m[0])) refs.set(m[0], rel)
  }
  const missing = [...refs].filter(([target]) => !fs.existsSync(path.join(pkgRoot, target)))
  check(refs.size > 0, `文档里找到 ${refs.size} 条文件引用（判据非空）`)
  check(missing.length === 0, '文档提到的文件都存在', missing.map(([t, rel]) => `${rel} → ${t}`).join(' | '))
  /**
   * **正面清单**：这几条文档引用必须**在**。
   *
   * 只断言“引用到的都存在”是不够的——一条“往 README 里加一条不存在的引用”的注入曾让本套件全绿，
   * 因为插入只增不减，而旧断言对“少了什么”一无所知（`missing` 只覆盖“写了但不在”）。
   * 这几条是文档的骨架：入口清单、引擎清单、验收清单，被删掉时读者会真的卡住。
   */
  const mustMention = ['build/release-check.mjs', 'src/locator-lab/repo-map.mjs', 'probes/adoption-stats.mjs']
  const allDocText = texts.map((rel) => read(rel)).join('\n')
  const gone = mustMention.filter((m) => !allDocText.includes(m))
  check(gone.length === 0, `文档骨架引用还在（${mustMention.length} 条）`, gone.join(', '))
}

say('')
say('=== F. 独立面提供的命令与文档一致 ===')
{
  const usage = read('src/aura-standalone/bin/aura.mjs')
  for (const cmd of ['aura basetools read', 'aura basetools edit', 'aura basetools mcp']) {
    check(usage.includes(cmd), `CLI 帮助里有 \`${cmd}\``)
  }
  /**
   * 不带参数调用要打印用法、退出码 1。
   *
   * **必须跑构建产物**：`src/aura-standalone/bin/aura.mjs` 里的 `../locator-lab/` 只在**包布局**下存在
   * （`dist/aura-basetools/{bin,locator-lab}`），直接跑源码那份会是 `ERR_MODULE_NOT_FOUND`。
   * 第一版就是这么错的——而那条失败看上去像“CLI 坏了”，实际是**我指错了被测对象**。
   */
  const { spawnSync } = await import('node:child_process')
  const cli = path.join(pkgRoot, 'dist/aura-basetools/bin/aura.mjs')
  if (!fs.existsSync(cli)) {
    check(false, '构建产物存在（先跑 node build/make-bundle.mjs）', cli)
  } else {
    // 不带参数 = **打印用法并以 0 退出**（帮助不是用法错）。实测如此，断言跟着真实契约走。
    const res = spawnSync(process.execPath, [cli], { encoding: 'utf8' })
    check(res.status === 0, `不带参数调用 ⇒ 打印用法并成功退出（实测 ${res.status}）`)
    check(
      /aura basetools read|USAGE|用法/.test(`${res.stdout}${res.stderr}`),
      '不带参数调用会打印用法',
      JSON.stringify(String(res.stdout).slice(0, 80)),
    )
  }
}

say('')
say('=== G. MCP 接线指引里的 npx 必须能解析到 bin ===')
{
  /**
   * 本包有 `aura` / `aura-mcp` 两个 bin，**没有**一个叫 `aura-basetools`。npx 在"多个 bin
   * 且没有与包名同名的"时候会直接拒绝猜（实测 `could not determine executable to run`），
   * 所以指引必须写成 `npx -y --package aura-basetools aura basetools mcp`（0.13.0 起顶层 mcp 被拒）。
   *
   * 这条不是文字洁癖：旧指引写的是 `npx -y aura-basetools mcp`，照着做的人会在启动
   * MCP 之前就失败，而 CLI 本身完全正常——是最容易归错因的一类。
   */
  const mcpDoc = read('src/aura-standalone/bin/aura-mcp.mjs')
  check(!/npx\s+-y\s+aura-basetools/.test(mcpDoc), '指引不再给出 npx 猜不到 bin 的形式')
  check(mcpDoc.includes('npx -y --package aura-basetools aura basetools mcp'), '指引给出的 npx 形式带 --package + basetools 命名空间')
  check(!/\baura mcp\b/.test(mcpDoc), '指引不再给出顶层 `aura mcp`（0.13.0 起 CLI_NAMESPACE_REQUIRED）')
}

say('')
const passed = results.filter((r) => r.ok).length
say(`--- ${passed}/${results.length} 通过 ---`)
for (const r of results.filter((x) => !x.ok)) say(`  FAIL: ${r.label}  ${r.detail}`)
process.exit(passed === results.length ? 0 : 1)
