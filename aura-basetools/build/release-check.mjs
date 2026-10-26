#!/usr/bin/env node
/**
 * release-check.mjs —— 发布前的**全量测试闸**：一条命令跑完所有该跑的东西，并给一个总判定。
 *
 *   node build/release-check.mjs            # 人看
 *   node build/release-check.mjs --json     # 机器看
 *
 * 为什么要有它：发布前"应该跑什么"如果靠人记，漏一项就是一次事故（本轮已经吃过一次：
 * 改了源没重建 dist，于是同一个版本号下有两份不同字节）。这里把清单**固定**下来：
 *   ① 套件（闸内逐件实跑）② 三套靶场 ③ 包内自带验收 ④ src↔dist 一致性
 *   ⑤ **拆包**（两个 npm 包装起来真能用）⑥ 版本一致性 ⑦ DSH 就绪 ⑧ **普查完整性**（C32）
 *
 * 它只汇总与判定，不替任何套件做判断：每个套件自己打印汇总行并以退出码表态。
 * 明确不在检查范围的一件事：**DSH 工具面要重启宿主才生效**（那是人的动作，不是构建产物的问题）。
 *
 * ⑩ 是 C32 加的，因为 ① 的清单是**人手抄的**：`byte-fidelity.mjs` 自带 102 条断言与退出码，
 * 却因为文件名不匹配 `*-test.mjs` 长期落在闸外，红了很久（90/94）才被偶然发现。
 * ⑩ 用**文件形态**（而不是文件名）反查清单：自带判据却不被枚举到的文件，闸当场变红并点名。
 *
 * ⑩ 的扫描根由 C37 从 `src/**` 抬到整个仓根 `/**`（跳过 `dist/`、`fixtures/`、`node_modules/`
 * —— 派生物与冻结数据）：抬之前，`probes/` 下 18 件自带断言形态的文件、`build/` 下 6 件里 5 件
 * 全在闸外，上一波两个带病探针就是这么通关的。跳过什么、每个命中的文件归哪张表、这条机检
 * 抓不到什么，都写在 §⑩ 那一段注释里（包括“登记了不等于判得动”这类盲区）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { runtimePairs } from './bundle-layout.mjs'

const root = path.resolve(import.meta.dirname, '..')
const json = process.argv.includes('--json')

const rows = []
/** C37：**闸内实跑过的每一个套件文件**（`SUITES` 循环与 §③/⑤ 单独调用的都算）。
 *  §⑩ 的普查拿它当“枚举名单”—— 这样“登记了”就不再是一份人手抄的第二张表，而是**闸真的跑过它**
 *  这件事本身。 */
const ranSuites = []
/**
 * 这些套件在闸内**必须真的跑出断言**。它们跳过时按失败计（`⏭` 仍显示，但闸红）；
 * 环境依赖型（缺 peer / 缺 dist / 平台不支持硬链接）的其他套件跳过只记 `⏭`，不算通过。
 */
const CRITICAL_SUITES = new Set([
  'write-verify', 'stale-gate', 'byte-fidelity', 'encoding-fidelity', 'span-fidelity', 'arg-shape', 'read-schema', 'range-args', 'standalone', 'write', 'replace-all', 'observation-gate', 'verify-edit', 'tx-session', 'argument-surface', 'single-line-target', 'observation-concurrency', 'range-bytes', 'aura-read/load', 'aura-edit/load', 'capabilities', 'public-surface', 'ci-contract', 'entity-apply', 'docs-surface',
])
const run = (relative, args = []) =>
  spawnSync(process.execPath, [path.join(root, relative), ...args], { cwd: root, encoding: 'utf8', timeout: 1800000 })

/** 跑一个"自报成绩"的套件：取最后一行含"通过"的文本作为摘要，退出码为准。 */
function suite(name, relative, group = '套件') {
  ranSuites.push(relative)
  if (!fs.existsSync(path.join(root, relative))) {
    rows.push({ group, name, status: 'missing', summary: '(文件不存在)' })
    return
  }
  const res = run(relative)
  const outputLines = (res.stdout ?? '').trim().split('\n').filter((line) => line.trim() !== '')
  const summary = outputLines.filter((line) => line.includes('通过') || line.includes('失败')).pop()
  // 失败时把子进程里有信息量的行带出来。否则 CI 上只能看到“N/M 通过”，
  // 具体哪条断言红了还得本地复现；runner 平台调查正是被这一点卡住的。
  const failedLines = outputLines.filter((line) => /✗|FAIL|not found|ENOENT|Error|错误/i.test(line))
  const failTail = (failedLines.length > 0 ? failedLines : outputLines).slice(-3).map((line) => line.trim()).join(' | ')
  const stderrTail = (res.stderr ?? '').trim().split('\n').filter(Boolean).slice(-2).join(' | ')
  /**
   * 跳过 ≠ 通过。若干套件在缺 DSH peer / 缺 dist / 平台不允许硬链接时自报
   * `--- 0/0 通过（已跳过）---` 并以 exit 0 结束；旧版把它们记成 ✅。
   * 现在统一记 `skipped`，可执行的部分由 `CRITICAL_SUITES` 兜底。
   */
  const skipped = res.status === 0 && /0\/0|已跳过|skipped/i.test(summary ?? '')
  const isCritical = CRITICAL_SUITES.has(name)
  const status = res.status !== 0 ? 'fail' : skipped ? (isCritical ? 'fail' : 'skipped') : 'ok'
  rows.push({
    group,
    name,
    status,
    summary: skipped && isCritical
      ? `critical suite skipped: ${(summary ?? '').trim()}`
      : status === 'fail'
        ? `${(summary ?? '').trim()}${failTail ? ` | ${failTail}` : ''}${stderrTail ? ` | stderr: ${stderrTail}` : ''}`
        : (summary ?? '').trim(),
    stderr: (res.stderr ?? '').trim().split('\n').slice(0, 2).join(' | '),
  })
}

// ① 既有套件（顺序固定：先引擎、再工具壳）
const SUITES = [
  // 测试分层（2026-10-27 起）：只保留 interface / integration / system 三层。
  // 单元层已从闸门移除并归档到 docs/archive/unit-tests（不运行、不发货）。
  // 新增套件必须属于三层之一；纯函数/单内部函数断言不进这里。
  ['write-verify', 'src/locator-lab/write-verify-test.mjs'],
  ['stale-gate', 'src/locator-lab/stale-gate-test.mjs'],
  ['byte-fidelity', 'src/locator-lab/byte-fidelity-test.mjs'],
  ['encoding-fidelity', 'src/locator-lab/encoding-fidelity.mjs'],
  ['span-fidelity', 'src/locator-lab/span-fidelity.mjs'],
  ['policy-arg', 'src/locator-lab/policy-arg-test.mjs'],
  ['read-schema', 'src/locator-lab/aura-read-schema-test.mjs'],
  ['read2', 'src/locator-lab/read-test2.mjs'],
  ['adapters', 'src/locator-lab/adapters.mjs'],
  ['arg-shape', 'src/locator-lab/arg-shape-test.mjs'],
  ['real-framework', 'src/locator-lab/real-framework-smoke-test.mjs'],
  ['public-surface', 'src/locator-lab/public-surface-test.mjs'],
  ['embeddability', 'src/locator-lab/embeddability-test.mjs'],
  ['cli-mcp-e2e', 'src/locator-lab/cli-mcp-e2e-test.mjs'],
  ['schema-portability', 'src/locator-lab/schema-portability-test.mjs'],
  ['encoding', 'src/locator-lab/encoding-test.mjs'],
  ['preflight', 'src/locator-lab/preflight-test.mjs'],
  ['retry', 'src/locator-lab/retry-test.mjs'],
  ['coverage', 'src/locator-lab/coverage-test.mjs'],
  ['structure', 'src/locator-lab/structure-test.mjs'],
  ['probe', 'src/locator-lab/probe-test.mjs'],
  ['surface-parity', 'src/locator-lab/surface-parity-test.mjs'],
  ['interrupt-posture', 'probes/interrupt-matrix.mjs'],
  ['installed-package', 'src/locator-lab/installed-package-test.mjs'],
  ['range-args', 'src/locator-lab/range-args-test.mjs'],
  ['range-error-lifecycle', 'src/locator-lab/range-error-lifecycle-test.mjs'],
  ['standalone', 'src/aura-standalone/test/standalone-test.mjs'],
  ['argument-surface', 'src/aura-standalone/test/argument-surface-test.mjs'],
  ['observation-concurrency', 'src/aura-standalone/test/observation-concurrency-test.mjs'],
  ['write', 'src/aura-standalone/test/write-test.mjs'],
  ['range-bytes', 'src/aura-standalone/test/range-bytes-test.mjs'],
  ['aura-read/outcome', 'src/aura-read/outcome-test.mjs'],
  ['aura-edit/outcome', 'src/aura-edit/outcome-test.mjs'],
  ['aura-read/load', 'src/aura-read/load-test.mjs'],
  ['aura-edit/load', 'src/aura-edit/load-test.mjs'],
  ['aura-edit/align', 'src/aura-edit/align-test.mjs'],
  ['already-applied-shell', 'src/aura-edit/already-applied-shell-test.mjs'],
  ['encoding-refusal', 'src/locator-lab/encoding-refusal-test.mjs'],
  ['observation-store-identity', 'src/locator-lab/observation-store-identity-test.mjs'],
  ['index-scaling', 'src/locator-lab/index-scaling-test.mjs'],
  ['alias-identity', 'src/locator-lab/alias-identity-test.mjs'],
  ['repair-address-shell', 'src/aura-edit/repair-address-shell-test.mjs'],
  ['verify-edit', 'src/locator-lab/verify-edit-test.mjs'],
  ['tx-session', 'src/locator-lab/tx-session-test.mjs'],
  ['replace-all', 'src/locator-lab/replace-all-test.mjs'],
  ['single-line-target', 'src/locator-lab/single-line-target-test.mjs'],
  ['observation-gate', 'src/locator-lab/observation-gate-test.mjs'],
  ['concurrency-crash', 'src/locator-lab/concurrency-crash-test.mjs'],
  ['task-bench', 'build/task-bench.mjs'],
  ['post-publish', 'build/post-publish-check.mjs'],
  ['perf-gate', 'build/perf-gate.mjs'],
  ['doctor', 'src/aura-standalone/test/doctor-test.mjs'],
  ['capabilities', 'build/capabilities-test.mjs'],
  ['docs-surface', 'src/locator-lab/docs-surface-test.mjs'],
  ['ci-contract', 'build/ci-contract-test.mjs'],
  ['entity-apply', 'src/aura-standalone/test/entity-apply-test.mjs'],
]
for (const [name, relative] of SUITES) suite(name, relative)

// ② 三套靶场（range-all 自己做汇总与退出码）
{
  const res = run('build/range-all.mjs')
  const lines = (res.stdout ?? '').trim().split('\n')
  for (const line of lines.filter((l) => /[✅❌⚪]/.test(l))) {
    const status = line.includes('✅') ? 'ok' : line.includes('⚪') ? 'missing' : 'fail'
    rows.push({ group: '靶场', name: line.replace(/[✅❌⚪]/g, '').trim().split(/\s{2,}/)[0], status, summary: '' })
  }
  if (rows.filter((r) => r.group === '靶场').length === 0) {
    rows.push({ group: '靶场', name: '(range-all 没有输出)', status: 'fail', summary: (res.stderr ?? '').trim().slice(0, 120) })
  }
}

// ③ 包内自带验收（发出去的那一份）
{
  const manifest = path.join(root, 'dist', 'aura-basetools', 'package.json')
  if (!fs.existsSync(manifest)) {
    rows.push({ group: '包内', name: 'standalone-test', status: 'missing', summary: '(dist/aura-basetools 还没构建)' })
  } else {
    const res = spawnSync(process.execPath, [path.join(root, 'dist', 'aura-basetools', 'test', 'standalone-test.mjs')], {
      cwd: path.join(root, 'dist', 'aura-basetools'),
      encoding: 'utf8',
      timeout: 600000,
    })
    const summary = (res.stdout ?? '').trim().split('\n').filter((l) => l.includes('通过')).pop()
    rows.push({ group: '包内', name: 'standalone-test', status: res.status === 0 ? 'ok' : 'fail', summary: (summary ?? '').trim() })
  }
}

// ④ src ↔ dist 一致性：包里的每个运行时文件都必须与 src 逐字节相同（本轮吃过它的亏）
//
// 清单从 `bundle-layout.mjs` 的 `runtimePairs()` 派生，**不再手抄**。手抄的那一版漏了 5 个
// 已经发出去的文件（`handle-core.mjs`、`transaction-store.mjs`、`workspace-lock.mjs`、
// `dsh/argv-shell.mjs`、`dsh/hook-inproc.mjs`）—— 它们进了包，却一直不在"改了源没重建"的射程内。
// 现在打包与比对共用同一份清单：往包里加文件只改一处。
{
  const pairs = runtimePairs()
  const sha = (p) => (fs.existsSync(path.join(root, p)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex') : null)
  // `runtimePairs()` 的第二格是**包内相对路径**（与 make-bundle 的 out 目录对齐），
  // 所以这里补上 `dist/aura-basetools/` 前缀——少了它会把每个文件都读成不存在。
  const drift = pairs.filter(([source, bundled]) => sha(source) !== sha(`dist/aura-basetools/${bundled}`)).map(([source]) => source)
  rows.push({
    group: '一致性',
    name: 'src↔dist',
    status: drift.length === 0 ? 'ok' : 'fail',
    summary: drift.length === 0 ? `${pairs.length} 个运行时文件逐字节一致` : `不一致：${drift.join(', ')}（改源没重建？）`,
  })
}

// ⑥b 拆包（0.7.0）：两个 npm 包从 .tgz **装出来之后**还能不能用。
//
// 为什么不是⑥的一部分：⑥ 比的是"源 → 组合产物"的字节；拆包是**另一条分发形态**
// （核心包没有 DSH 依赖、适配器按包名 import 核心）。CI 原先只断言核心的 package.json
// 里没有 DSH 字段 —— 那是**声明**，不是"装起来真能用"。本套件离线装两个 tgz，
// 从装出来的那份跑 CLI / MCP / npx，并核对适配器的 import 全部解析到核心包。
suite('split-package', 'build/split-package-test.mjs', '拆包')

// ⑦ 源侧版本位点：这一份清单是**唯一**的，`make-bundle.mjs` 的 `SHELLS` 必须与它同集合。
//
// C43 为什么单列这一条：上面⑧只比三处，而三处里的 `dist/aura-basetools/package.json` 是
// `build/make-bundle.mjs` **生成**的（它按 `SHELLS` 读两个壳的 package.json，把版本抄进
// `dist/aura-basetools/package.json` 与生成的 README）—— 也就是说，包内那一处**不是版本位点**，
// 拿它当"位点"会掩盖真实位点漏抬。真正的源侧位点只有下面这两个壳的 package.json。
// 漏抬一个的后果不是当场报错：`make-bundle.mjs` 第 63-65 行那句
// `两个包的版本不一致` 只会在**打包时**才炸，而版本号一旦发出去就不能再改。
//
// 为什么**刻意不包含** `fixtures/frozen-engine-0.6.1-217798da/package.json`：那是三条测量线的
// **冻结基准**，它按设计就该停在旧版本（旧的、与现树不同源的那一份字节）。把它拉进
// "版本必须一致"，抬版本就会逼着人去改冻结基准 —— 而那正是两条测量线赖以成立的东西。
// 它不在清单里，但下面按**相反方向**单独断言：它必须仍留在旧版本，抬上来了就红。
{
  const SVC_READ_VERSION = (p) => {
    const abs = path.join(root, p)
    if (!fs.existsSync(abs)) return { present: false, version: null }
    try {
      return { present: true, version: JSON.parse(fs.readFileSync(abs, 'utf8')).version ?? null }
    } catch (error) {
      return { present: true, version: null, error: String(error?.message ?? error) }
    }
  }
  const SOURCE_VERSION_SITES = ['src/aura-read/package.json', 'src/aura-edit/package.json']
  const versionProblems = []
  const versionSitesSeen = {}
  for (const site of SOURCE_VERSION_SITES) {
    const one = SVC_READ_VERSION(site)
    versionSitesSeen[site] = one.present ? one.version : '(文件不存在)'
    if (!one.present) versionProblems.push(`${site} 不存在`)
    else if (one.error !== undefined) versionProblems.push(`${site} 不是合法 JSON：${one.error}`)
    else if (typeof one.version !== 'string') versionProblems.push(`${site} 没有 version`)
  }
  const sourceVersionValues = [...new Set(Object.values(versionSitesSeen).filter((v) => typeof v === 'string'))]
  if (sourceVersionValues.length > 1) versionProblems.push(`源侧版本位点不一致：${JSON.stringify(versionSitesSeen)}`)
  const frozenVersion = SVC_READ_VERSION('fixtures/frozen-engine-0.6.1-217798da/package.json')
  if (!frozenVersion.present) versionProblems.push('冻结基准 fixtures/frozen-engine-0.6.1-217798da/package.json 不存在')
  else if (sourceVersionValues.length === 1 && frozenVersion.version === sourceVersionValues[0]) {
    versionProblems.push(`冻结基准被抬到了现树版本 ${frozenVersion.version} —— 那会把两条测量线的基准弄成与现树同源`)
  }
  rows.push({
    group: '一致性',
    name: '源侧版本',
    status: versionProblems.length === 0 ? 'ok' : 'fail',
    summary:
      versionProblems.length === 0
        ? `${SOURCE_VERSION_SITES.length} 处一致 = ${sourceVersionValues[0]}；冻结基准仍在 ${frozenVersion.version}（不在清单里，按相反方向断言）`
        : versionProblems.join('；'),
  })
}

// ⑧ 版本一致性：两个壳的 package.json 与包内 package.json 必须同一个版本
{
  const read = (p) => (fs.existsSync(path.join(root, p)) ? JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')).version : null)
  const versions = {
    'aura-read': read('src/aura-read/package.json'),
    'aura-edit': read('src/aura-edit/package.json'),
    'dist/aura-basetools': read('dist/aura-basetools/package.json'),
  }
  const unique = [...new Set(Object.values(versions))]
  rows.push({
    group: '一致性',
    name: '版本',
    status: unique.length === 1 && unique[0] !== null ? 'ok' : 'fail',
    summary: JSON.stringify(versions),
  })
}

// ⑧ DSH 就绪（**不启动 dsh** 也能查的那部分）：补丁指向的两个模块今天还加载得起来吗？
// 为什么加这一条：DSH 侧要重启才生效，所以"重启之后能不能起来"必须在重启前就有证据——
// 否则用户重启后才发现在等一个加载不了的模块，而那是我们本可以提前发现的。
for (const [name, relative] of [
  ['aura-read', 'src/aura-read/index.js'],
  ['aura-edit', 'src/aura-edit/index.js'],
]) {
  try {
    const module = await import(pathToFileURL(path.join(root, relative)).href)
    const shape = module.default ?? module
    const ok = typeof shape?.apply === 'function' && typeof shape?.name === 'string'
    rows.push({
      group: 'DSH 就绪',
      name,
      status: ok ? 'ok' : 'fail',
      summary: ok ? `${shape.name} · apply=function（重启宿主后即可生效）` : `插件形状不对：导出 ${Object.keys(module).join(',')}`,
    })
  } catch (error) {
    rows.push({ group: 'DSH 就绪', name, status: 'fail', summary: `加载失败：${String(error?.message ?? error).slice(0, 140)}` })
  }
}

// ⑩ 普查完整性（C32 立，C37 把扫描根抬到整个仓根 `/**`）：**自带判据的文件必须在普查名单里**，
//    否则闸门有一条谁也看不见的盲区。
//
// 为什么单列一项（真事）：`byte-fidelity.mjs` 自带 102 条断言与退出码，却因为文件名不匹配
// `*-test.mjs` 长期落在全量普查之外——它红了很久（90/94）才被偶然发现。这不是一个文件的问题，
// 是**普查口径靠文件名猜**的问题。所以这条机检**不按文件名判**，按文件的形态判（三个形态）：
//   · S1「自有判据」：源码里出现 check( / assert( / assertX( / verifyX( / mustX( / failX( …
//     这类判据函数调用；`(?<![\w$.])` 保证不是 `obj.check(` / `this.assert(` 这种别人家的方法；
//   · S1b「判定标记」：源码里出现 `✓` / `✗`——那是"逐条打印判据结论"的形状；
//   · S2「自己打印通过/失败汇总」：**末尾 80 行**里有一行非注释代码在打印 通过/失败，
//     且那一行带计数拼接（`${…}` / `+`）或字面量「判据通过」。
// 命中任一形态 = "这个文件看起来会自己判自己"，必须出现在下面两张登记表之一：
//   ① `SUITES`（闸内**实跑**：逐件打印汇总行 + 用退出码表态）；
//   ② `CENSUS_EXEMPT`（**逐条写明理由**的非套件：引擎模块 / 只打印读数不判定的探针 / 产物本体）。
//      它可带第三格 `{ ranAs }`：表示"它确实在闸内跑，只是不走 `suite()` 那条路"（C37 加）。
// 两边都没有 ⇒ 本项红，并把文件名逐个点出来（新放一个套件忘了登记，就是这条抓住的）。
//
// ### C37：扫描根从 `src/**` 抬到仓根 `/**`（为什么必须抬）
//
// C32 只扫 `src/**`。C37 独立复算（同一套谓词、同一份源码）：
//   · `src/**`    82 个 .mjs/.js → 命中 60 = 闸内套件 51 + 豁免 9（0 未登记）✓
//   · `probes/**` 23 个 → 命中 18，**闸内 0 件**
//   · `build/**`   8 个 → 命中 6，其中 2 件未登记（`install.mjs` 与 `release-check.mjs` 自己）
//   · `docs/**`、`dsh/**` 各 1 个 → 各命中 1 件
// 上一波两个探针（`address-form-census` / `quote-hygiene`）就是这样带病通关的：一个印出真缺口
// （Y=3）而退出码仍是 0，一个把去污函数换成恒等（Δ0）也照样绿 —— 而闸门**根本不知道这两个文件
// 存在**。「清单靠人手抄」这个病，只要扫描根比人眼窄就会复发；所以根抬到整个仓根。
//
// 跳过（**派生物与数据**，扫它们只会制造假要求）：
//   · `dist/**`     构建产物：里面的 .js/.mjs 是 `src` 的副本，§⑥ 已逐字节比对；扫它等于把同一份
//                   套件按第二条路径再要一次登记，而那条路径**永远**是"未登记"。
//   · `fixtures/**` 冻结基准**数据**（`frozen-engine-0.6.1-217798da/`）：故意的旧快照，它**不该**
//                   跟着源演进，也就不该被要求登记（由 `failure-replay.mjs` 按摘要自校）。
//   · `**/node_modules/**` 第三方（任意深度）。
//   · `docs/archive/**` **退休件存放处**（C2 加）：内容冻结的旧件（规矩见 `docs/archive/README.md`）——
//                       扫它只会制造假要求（形态判据对归档件是恒真的）。谁扫、扫到几件、为什么不判见 `SKIP_NESTED`。
// 跳过的代价如实声明（见下面盲区清单第一条）。**不**跳过的两个非套件目录：`docs/`（文档示例，
// 由 §① 的 `embeddability` 套件实跑；`docs/archive/` 除外，见上）与 `dsh/`（落地的宿主执行器）—— 它们各命中一个形态，
// 于是按规矩进豁免台账，而不是靠"不扫"消音。
//
// ### C37：probes/ 与 build/ 的逐件定性口径（"红了该改什么"决定它进哪张表）
//
//   · **真套件**（自带判据 + 通过/失败汇总行 + 失败非零退出，且离线自足）⇒ 登记进 `SUITES`
//     真跑。分界线再收紧一格：**判据必须是不随波演进的不变式** —— 引擎按契约改进之后它仍然
//     绿，红了就该去看代码。C37 收进 3 件（见 `SUITES` 尾部那一段注释）。
//   · **探针 / 量具** ⇒ 进豁免台账，逐条给理由。三类典型：
//     ① 只读数不判定（没有退出码，或恒 exit 0）；
//     ② **判定，但钉住的是"本波绝对读数"**：引擎一改进它就红，而那时人要改的是手抄的数字、
//        不是缺陷 —— 它是一次审计件，不是回归线（`quote-hygiene` 的 `EXPECT.cleanFail` = 146、
//        `residual-census` 对账的 143/147/15/27/17/4 都是这一类）；
//     ③ 判据挂在**本机活状态**上（会话日志 / 宿主进程 / 安装副本 / "钩子那一行还没被改"）：
//        红不红取决于环境，不取决于本仓的代码。
//   · **边界模糊的 ⇒ 宁可登记让它跑**，也不要静默豁免 —— 登记了它每次真跑，红得看得见。
//
// ### C37：豁免台账的过期判据（两条，都会红）
//   ① 文件**不再命中任何形态** ⇒ 这条豁免已经没有对象了（C32 已有）；
//   ② 带 `{ ranAs }` 的条目 ⇒ 它说的那一组读数在本次闸里**没出现**：说明"它在闸内别处实跑"
//      这句话已经不成立，它现在是真·闸外。
//
// ### C37：每个被扫的根都有「归属·X」读数行
// `src` / `probes` / `build` / `docs` / `dsh` 各一行，逐个文件落在四格里（登记 / 闸内别处实跑 /
// 豁免 / 无断言形态），**两个数（总数与命中数）都印出来** —— 终态的判据是"probes/ 23 件逐个有
// 归属"，那就得让人在一行里数得出来，而不是靠信。
//
// ### 这条机检抓得到什么、抓不到什么（**边界**：宁可多报让人工确认，也不要漏报）
//
// 抓得到：
//   · 新放一个自带 check()/assert() 判据的套件、却忘了登记 —— 红并点名（C32 段A 的变异反证用就是它）；
//   · 新放一个**不叫** `*-test.mjs` 的同形文件 —— 形态判据与文件名无关，照样红并点名
//     （`byte-fidelity.mjs` 当初就是这么漏的）；
//   · 只打印汇总行、一条判据都没有的「假套件」—— 一样红（它看上去会表态，却什么都没验）；
//   · 登记过的文件被删（枚举数 ≠ 实际数）—— 红并点名；
//   · `CENSUS_EXEMPT` 里的豁免过期（文件不再有断言形态）—— 红并点名，免得登记表变成一句旧话。
//
// 抓不到（**已知盲区**，写在这里而不是假装没有）：
//   · **判据函数名不在名单里**的形态：`t(cond)`、`ok(…)`、`bad(…)`、`ensureX(…)` 之外的自造缩写；
//     手写 `if (bad) { fail += 1 }` 而不调用任何判据函数的文件，三个形态一个都不命中；
//   · **判据来自别处**：断言封装在 import 进来的公共库里，本文件一次都不出现判据调用；
//   · **表驱动 / DSL 断言**：期望值写在数据里，运行期才拼出调用（名字可能一次都不出现）；
//   · **汇总行不在末尾 80 行内**（比如只在异常分支打印），或汇总行的计数不是 `${…}`/`+` 拼的；
//   · **`src/**` 之外**的文件：本机检只扫 `src`（C32 施工单口径）。`build/` 的靶场与
//     套件由 §②/§④/§⑤ 另行登记，`probes/` 不在闸内（那是探针台账的事）；
//   · **同名遮蔽**：`foo.assert(...)` 被 `(?<![\w$.])` 排除，所以一个只靠对象方法做判据的文件
//     不会命中——宁可漏这一个，也不要让全仓的 `Promise.all` 之类变成噪声；
//   · **完全不在源码里留痕**的套件（运行时从别处加载）：形态匹配天生看不见；
//   · **C37 新增盲区一：跳过根里的同形文件**。`dist/`、`fixtures/`、`node_modules/`、`docs/archive/`
//     里的 .mjs/.js 一个都不看（故意：派生物 · 冻结数据 · 第三方 · 退休件）。代价是"有人把真套件
//     放进 `fixtures/` 或 `docs/archive/`"这种形态看不见 —— 跳过是**尺度上的取舍**，不等于
//     "那里一定没有问题"；
//   · **C37 新增盲区二：只按扩展名收文件**。`.mjs` / `.js`；`.cjs` / `.mts` / `.ts`、
//     或者 shell / python 写的判据一律看不见；
//   · **C37 新增盲区三："登记了"不等于"判得动"**。本机检只保证文件**出现在名单里**，不保证
//     它的判据有判定力。`address-form-census` 上一波就是"在名单外"与"判据判不了自己的结论"
//     同时发生的 —— 后者是每件套件自己的事，机检管不了；
//   · **C37 新增盲区四：台账是人工写的**。`{ ranAs }` 是弱耦合（它只证明"那一组读数出现过"，
//     不证明"那组读数是这个文件产生的"）；豁免理由的真伪、以及"该登记还是该豁免"，都是人的
//     判断。机检只能保证"每条都有归属，且归属不会悄悄过期"。
//
// 误伤（**多报是设计的一部分**）：
//   · 引擎模块里内部守卫的 `assertThrow(...)`、探针的 `hardFail(...)` 都会命中 S1。这不是错报，
//     是**要求人工把它登记进 `CENSUS_EXEMPT` 并写明"它不是套件"**——登记一次之后，
//     当时的 30 条豁免全是这类（C32 立表时 9 条，C37 抬根后按同一规矩补到 29 条，M0 又补 1 条）。
//     那个「30」**是历史读数、不是现值**：唯一真值来源是 `CENSUS_EXEMPT` 表的表长 ——
//     闸输出那一行会印「非套件豁免 N 件（逐条理由写在 CENSUS_EXEMPT 里…）」，要引用就抄那一行。
//     下面的分侧读数同样是**当时快照**、不是现值：`src` 侧 9 条 + `probes` 侧 16 条 + `build` 侧 3 条 +
//     `docs`/`dsh` 各 1 条（M0 补的那条是 `probes/multi-target-adoption.mjs`，理由写在它自己那一行）。
//   · 反向的一类：**登记在 SUITES 里却没有任何断言形态**的文件（写这句时这一件是 `read-fidelity.mjs`；完整名单以闸输出「只读数不判定（不红，但要看得见）：…」那一行为准，别当现值抄）。
//     它**不红**（它本来就只读数、永远 exit 0，列入闸内是为了留住那份读数），但要在
//     §“口径”那一行里点名让人看见：
//     “这一件其实判不了红”。
/**
 * 非套件登记表：命中判据形态、但**本身不是套件**（或不在 `suite()` 那条路上跑）的文件，逐条写明为什么。
 * 规则：往这里加一条 = 人工确认过“它不会红、也不该被当套件跑”。理由不写的登记不算登记。
 * 第三格 `{ ranAs }`（可选，C37 加）= 它**在闸内以哪一组读数现身**（不走 `suite()` 的那件）；
 * 机检会验证那一组读数真的出现过，没出现就红 —— “它在闸内别处实跑”这句话过期了。
 */
const CENSUS_EXEMPT = [
  // 2026-10-27：单元层移除后，以下测量/支持件不再进闸；它们不是回归测试。
  ['probes/name-addressing.mjs', '测量探针（按名寻址可达面）：判据是探针自检；按三层策略移出闸门，保留读数能力'],
  ['probes/address-form-census.mjs', '测量探针（地址形态普查）：判据是探针自检；按三层策略移出闸门'],
  ['probes/tool-error-rate.mjs', '测量探针（工具错误率）：判据是探针自检；按三层策略移出闸门'],
  ['probes/entity-bench.mjs', '1.0 性能探针：只打印 entity/apply/repo-grep/image 的墙钟读数，无判据、无退出码；不进闸'],
  ['src/locator-lab/failure-replay.mjs', '失败语料重放/被其它探针 import 的支持件，不是回归测试；按三层策略移出闸门'],
  // ── src/：写这句时是 9 条；现值以表里 `src/` 前缀条目计 = 10 条（8 条非套件豁免 + 本波新增的 `src/aura-standalone/bin/` 那 2 条同属 src 侧）──
  ['src/aura-read/index.js', 'DSH 壳：apply 里用 assert 抛参数错（对内守卫），没有自己的汇总行与退出码'],
  ['src/aura-edit/index.js', 'DSH 壳：同上（hunk schema 守卫用 assert）'],
  ['src/locator-lab/args.mjs', '引擎模块：参数归一化，内部 assert 守卫'],
  ['src/locator-lab/locator-api.mjs', '引擎模块：定位入口，内部 assert 守卫'],
  ['src/locator-lab/write-path.mjs', '引擎模块：写回计划，内部 verify* 助手（不是判据）'],
  ['src/aura-edit/ab-real.mjs', '取证探针：在真实源码上跑 A/B 并打印统计，没有判据、恒 exit 0'],
  ['src/locator-lab/disable-check.mjs', '一次性探针：查“停掉 tool-fs 前”的两个缺口，只打印读数'],
  // C42：`src/locator-lab/gate-asymmetry-probe.mjs` **已从这张表里删掉** —— 它不是“不再是探针”了，
  // 而是 S2 收紧之后它**不再命中任何断言形态**（全文没有 process.exit/exitCode、没有 ✓/✗、
  // 没有 check() 调用；它印的 A/B/C/D 四行是 `${r.ok ? '通过' : '被拒'}` 这种**插值里的**读数，
  // 判据词不在模板字面文本里）。机检自己点名要的就是这个动作：
  // “CENSUS_EXEMPT 已过期（文件不再有断言形态，登记表要跟着改）”。留一条命中不了形态的豁免，
  // 等于在账上多算一件“非套件”；删掉之后它会出现在「无断言形态」那一列，那才是它的真实归属。
  // 说明：这张表记的是“命中形态但不是套件”，不是“所有非套件文件” —— 所以此处是删除而非改理由。
  ['src/locator-lab/recoverable.mjs', '读数探针：量“失败回执附符号目录”的可救率，无判据'],
  ['src/aura-standalone/lib/transaction-store.mjs', '事务日志/回滚实现：内部用 throw 表达拒绝，没有套件的 ✓/✗ 汇总；行为由 standalone-test 的 O1–O8 覆盖'],
  ['src/aura-standalone/lib/ops.mjs', 'CLI/MCP 共用产品库：`ok` 字段是回执，不是判据/汇总；行为由 standalone/write/verify-edit/cli-mcp-e2e 覆盖'],
  // ── probes/：C37 逐件定性 —— 写这句时命中形态 18 件（3 件已登记进 `SUITES`，收件理由写在
  //    那边；其余 15 件逐条写在这里，每条都注明它为什么"不是回归线"，口径见文件头 §⑩）。
  //    这三个数都是**当时快照**、不是现值：真值来源是闸输出「归属·probes」那一行的四格
  //    （登记 / 闸内别处实跑 / 豁免 / 无断言形态）逐条点名，别当现值抄。
  //    C42：删掉一条 —— `probes/name-addressing.mjs` **本来就在 SUITES 里、本来就有退出码**，
  //    它出现在这张表上是**误登记**：C37 当时只按 S1/S2 两个谓词逐件定性，按那份读数就把它
  //    当成了“只读数不判定的探针”。它不是：`process.exit(undefinedLines.length === 0 ? 0 : 1)`
  //    是**真判据**（那一行不是 undefined 就红），只是它没有 `check(` 调用、也没有 `✓/✗` 标记。
  //    所以 C42 的正确修法是**补谓词（S1c 退出码判据）而不是留豁免**：豁免一条实际在判的套件，
  //    等于把它的判定力从账上抹掉；留在豁免表里还会让“只读数不判定”那一列多算一件。
  //    恢复后必须两处都不会假红：它既不能被 A7（登记套件缺退出码接线）点名 —— 它有接线；
  //    也不能被“CENSUS_EXEMPT 已过期”点名 —— 它已经不在豁免表里了。
  ['probes/activate-and-verify.mjs', '激活验收件：判据问的是**本机当下**的激活状态（宿主进程表 / ~/.aura 安装副本 vs 源树 / 钩子那一行）—— C37 当次跑 --check 就是 exit 1（宿主还没重启）。红不红取决于"重启了没有"，不是回归线'],
  ['probes/adoption-stats.mjs', '采用率读数器：打印覆盖率与模式分布，唯一的退出码是**用法错**（exit 2）。真正会出错的地方（会话筛选口径 / hunk 级寻址 / 失败判定 / 自测会话过滤）判据随单元层移除；探针本身只读数'],
  ['probes/coordinate-drift-experiment.mjs', 'T15 分辨实验：合成自证 9 条可复现，但默认还会扫 ~/.dsh/sessions（活语料，随日志增长而变）；读数用于判读“漂移补偿要不要立项”，不是引擎回归线。'],
  // C49 改理由：这条原本写「无判据」——而 C47 给它加了 `--split-at` 的**守恒自检**、
  // C48 又把那条自检接到了退出码上，所以「无判据」与「恒 exit 0」两句都已经过期。
  // 它仍然不是**可复现回归线**，理由换成三条与本单无关、不会随波漂的：
  //   ① 判据只在 `--split-at` 分支里跑（`printSplitWindow`，默认路径根本不经过那个分支，
  //      探针自己会印「—（本次没判）」）；
  //   ② 它判的是**本探针自己的分窗记账自洽性**（两窗计数之和 == 不切窗总计数）——
  //      红了要修的是探针的定窗、不是引擎，与「引擎行为回归」是两件事；
  //   ③ 读数挂在**活语料**上（现扫 `~/.dsh/sessions`，随日志增长而变，本波数字只是快照）。
  ['probes/change-cost.mjs', '变更成本量具：读会话日志打印逐条成本。守恒自检（C47 加、C48 接退出码：`--split-at` 下两窗计数之和 != 不切窗总计数 ⇒ exitCode=1）只在切窗分支里跑，判的是探针自己的分窗记账自洽性，读数又挂在活语料上 ⇒ 不是可复现回归线'],
  ['probes/edit-failure-census.mjs', '失败计数普查：只打印"同一 (判据,文件) 撞 ≥2 次"的分组计数，没有退出码'],
  ['probes/error-lifecycle.mjs', '错误闭环基线探针：注入 12 类故障，只打印 预检/定位/一次修复 矩阵与汇总（恒 exit 0）；等预检/写后校验落地后，再把关键行提升成闸内 range'],
  // C61 新增：缩进吞噬普查（问的是「`old` 省掉行首空白 ⇒ 归一化命中 ⇒ 整行被替换 ⇒ 缩进没了」
  // 这个机制在真实会话里有多频繁）。它不是回归线，三条理由都不随波漂：
  //   ① 读数挂在**活语料**上（现扫 ~/.dsh/sessions，660MB / 1,527 个会话文件、全量一趟 ~40s，
  //      还要再跑一遍上游解析器对账 ⇒ ~80s），语料一变这组数就变；
  //   ② 判据全是**自洽/口径**判据（人口非空、人口 = isError=false − 无落盘标志、上游五项口径逐一相等、
  //      两个单位的桶之和各等于分母、交叉表逐格自洽、判决数由交叉表重算且与逐条谓词同数、两档之和 = 桶、
  //      合成自检五条 + 真引擎复现一条），**一条绝对条数都没写死** ⇒ 它红了说的是"量具坏了或入口分叉了"，
  //      不是"引擎回归了"；
  //   ③ 它量的是**机制频率**这个假设（模型真的会写不带缩进的 `old`），不是交付后的效果 ——
  //      实测全量 11,273 条写盘编辑里，空白折叠整行命中的只有 31 个落点，真正会改变字节的 3 个。
  // 判定力：退出码挂钩全部 20 条判据（0 绿 / 1 红 / 2 用法错），其中一条当场跑 `planHunks`
  // 重现题面样例（引擎改了口径它就变红）。
  ['probes/indent-loss-census.mjs', 'C61 **缩进吞噬普查**（问的是「`old` 省掉行首空白 ⇒ 空白折叠命中 ⇒ 整行被替换 ⇒ 缩进没了」这个机制在真实会话里有多频繁）：按任务口径把人回执报出来的 `applied[]` 分进 indent-lost / indent-added / indent-other / indent-same / unobservable 五桶（落点级与调用级两张表），再把 indent-lost 按命中层、按调用方 `old` 是否以空白开头、按“整行删掉 vs 真去缩进”细分，最后给一个判决数（改成“保留行首前缀/直接拒”会写出不同字节的编辑数）。不是回归线：① 读数挂在**活语料**上（现扫 ~/.dsh/sessions，660MB / 1,527 个会话文件，全量 ~40s，还要再跑一遍上游解析器对账 ⇒ ~80s；且 `--until` 一钉死同一批文件两次跑才逐字相同）；② 20 条判据全是**自洽/口径**判据（人口非空、人口 = isError=false − 无落盘标志、上游五项口径逐一相等、两个单位的桶之和各等于分母、交叉表逐格自洽、判决数由交叉表重算且与逐条谓词同数、两档之和 = 桶、可核性记账、调用级结构、合成自检 5 条 + **真引擎复现** 1 条），**一条绝对条数都没写死** ⇒ 它红了说的是“量具坏了或入口分叉了”，不是“引擎回归了”；③ 它量的是**机制频率**这个假设（模型真的会写不带缩进的 `old`），不是交付后的效果 —— 本波实测全量 11,273 条写盘编辑里，空白折叠 + 整行对齐只有 31 个落点，真正会改变字节的 3 个落点 / 2 条调用（0.02%）。判定力：退出码挂钩全部 20 条判据（0 绿 / 1 红 / 2 用法错）'],
  // H0b 新增：句柄化**上界量具**。它**不是**回归线，三条理由都不随波漂：
  //   ① 读数挂在**本次语料 × 现树引擎**这份快照上（现场还起只读子进程把 failure-replay --json
  //      的活读数重算一遍），引擎一改进（本波的目的就是改进它）这组数就变，那时要改的是回执不是缺陷；
  //   ② 8 条判据全是**自洽**判据（严格口径 ⊆ 宽松口径 / 计进上界的每条都落过盘 / 计入+排除+量了没救回
  //      = 残余分母 / 与上游活读数逐格一致 / 退化对照掉回 0 / 替换非空且按字节还原 / 探针没动引擎与语料），
  //      **一条绝对条数都没写死** ⇒ 它红了说的是"量具坏了或入口分叉了"，不是"引擎回归了"；
  //   ③ 它量的是**机制容量**这个假设（调用方手里恰好有一个覆盖目标区间的句柄），不是交付后的效果。
  // 判定力：退出码挂钩全部 8 条判据（--no-assert 才关）。
  ['probes/handle-upper-bound.mjs', 'H0b 句柄化**上界量具**（钉住本波绝对读数，口径②）：量"把工具账本里那份逐字节区间原文当 old"能把残余 PATCH_NOT_FOUND 救回多少条，并给出严格（调用方自己的坐标，零自由度）/ 宽松（语料能确定的区域原文，自由度逐条写明）两个口径与不可确定排除项。不是回归线：① 读数挂在本次语料 × 现树引擎的快照上，现场还把上游 failure-replay --json 的活读数重算一遍对账 ⇒ 引擎一改进这组数就变，红了要改的是回执；② 8 条判据全是自洽判据（严格 ⊆ 宽松 / 计进上界的每条都 writes ≥ 1 且副本 sha256 变了 / 计入+排除+量了没救回 = 残余分母 / 与上游活读数逐格一致 / 退化对照掉回 0 / 替换非空且按字节还原 / 探针没动引擎与语料），一条绝对条数都没写死；③ 它量的是"机制容量"这个**假设**，不是交付后的效果'],
  // M0 新增：多目标采用量具（本单预注册的问题：装上"一次调用多目标"之后 agent 到底会不会用它）。
  // 它不是回归线，三条理由都不随波漂：
  //   ① 读数挂在**活语料**上（现扫 ~/.dsh/sessions 里两个真实任务工作区，会话文件还在长）；
  //   ② 判据全是**自洽判据 + 口径判据**（三个数的分子分母自洽、逐工作区汇总 = 全局、人群口径自检两条），
  //      一条绝对条数都没写死 ⇒ 它红了说的是"量具坏了或取样取错了"，不是"引擎回归了"；
  //   ③ `--expect-baseline` 对的那份基线现在是**本量具自己 --capture-baseline 采的**，口径（工作区集 / N /
  //      since/until / 样本指纹）逐字段钉在基线里；口径不符时印 `⊘` 并**不判**（不假红），
  //      只有口径一致才逐格对账（容差 ±20% 一字未动）。
  //      【为什么改】旧版对的是「先前手写脚本量到的快照」—— 那是**第二个实现**：它的写回合口径与
  //      本量具不同（+400% 量级的差），于是这组对账恒红；而一条永远红的自检等于没有自检。
  //      同一课在 `anchor-cache` 上刚学过：参考值必须由同一把尺子产，且口径要能当场对。
  // 判定力：退出码挂钩全部三类判据（记账自洽 / 人群口径 / 基线对账；0 绿 1 红 2 用法错）。
  ['probes/multi-target-adoption.mjs', 'M0 **多目标采用量具**（钉住"装上多目标之后 agent 会不会用它"这组读数）：读会话日志量①每回合调用数②跨文件回合占比③每次调用携带目标数 + 调用构成 + aura_basetools_edit vs 内置 edit，并自报样本范围。不是回归线：① 读数挂在**活语料**上（现扫 ~/.dsh/sessions，随日志增长而变）；② 判据全是自洽/口径判据（三个数的分子分母自洽、逐工作区汇总 = 全局、人群口径自检两条），一条绝对条数都没写死；③ `--expect-baseline` 的基线由本量具 `--capture-baseline` 自采，口径（root/工作区集/N/since/until/样本指纹 + 逐文件取样清单）钉在基线里，口径不符印 `⊘` 并**不判**（不假红），口径一致才逐格对账（±20% 一字未动；容差未被收窄由变异证明：+19.0% 绿 / +21.0% 红）。另：`--since=<T>` 一条命令自产前后对照（镜像窗 `--until=T`，同一份取样/计数代码）。判定力：退出码挂钩全部判据（0 绿 / 1 红 / 2 用法错）'],
  ['probes/hook-activation-check.mjs', '激活件验收：段B 要求真 profile 里那行 name 恰好出现 1 次（L384 B0-anchor），并在副本上断言"那一行确实变了"（L424 after.sha256 !== before.sha256）。操作者一旦按它的交割单激活那条命令（本项目既定终态），它**按设计**当场变红 ⇒ 红不红取决于"激活了没有"。（C37 当次跑 exit 0、5.3s，段A 落仓件一致性与段B 往返都绿）'],
  ['probes/hook-wiring-plan.mjs', '接线方案 + 非激活实测：C37 当次跑 exit 1（它自己印"退出码 1（全量：看全部硬判据）"）；硬判据同样挂在"宿主还没改那一行"这个状态上，激活后即失效'],
  ['probes/perf-baseline.mjs', '性能基线量具：按 JOB 分派子进程写读数，本体没有退出码（无判据）'],
  ['probes/perf-recheck.mjs', '性能复量具：同 perf-baseline，只写读数，本体无退出码'],
  // C53 改理由：原文写的是「判据是 EXPECT.cleanFail = 173 / …、退出码挂钩全部 13 条判据」——
  // 两句都已过期：C53 把它的判据层复刻件（toContentAddress / neighbourContext / locateQuiet /
  // legacyRequest）删了，改 import 上游 failure-replay.mjs 导出的 replayNewContract，分桶随之
  // 由五格换成上游的六格（143/147/15/27/17/4，其中第四态 already_applied 27 条原先是算进 fail 的），
  // 判据也从 15 条加到 18 条。它仍然不是回归线：读数挂在**本次语料 × 现树引擎**上（期望值手抄）。
  ['probes/quote-hygiene.mjs', '审计件（钉住本次语料×现树引擎的绝对读数，口径②）：判据是 EXPECT.cleanFail = 146 / 洗活集恰为 {F0275} / allFormsOk = 122 —— 引擎一按它自己的建议改进（比如那条 ⏎ 污染原生修好、fail 147→146），它就红，而那时人要改的是**手抄的期望值**、不是缺陷 ⇒ 不是回归线。C53 起重放不再自带判据层复刻件，改走 import 的上游导出 replayNewContract（与 residual-census / address-form-census / already-applied-census 同形），分桶是上游的六格；判定力：退出码挂钩全部 18 条判据，其中「入口同一性」一条静态盯住这个入口没被换回本地复刻（登记表这里不重复它的判定）'],
  // C49 改理由：同 change-cost —— C47 给它加了同形的守恒自检（10 项）、C48 同样把它接到了
  // 退出码上（「无判据」与「恒 exit 0」两句都过期了）；三条理由同上。
  ['probes/reread-cause.mjs', '复读归因器：读会话日志做归因。守恒自检（C47 加、C48 接退出码：`--split-at` 下两窗计数之和 != 不切窗总计数 ⇒ exitCode=1）只在切窗分支里跑，判的是探针自己的分窗记账自洽性，读数又挂在活语料上 ⇒ 不是可复现回归线'],
  // C53 改理由：口径由五格换成上游的六格（C51 起已接上第四态 already_applied）——
  // 「手抄的 143/174/15/17/4」整句已过期，换成它现在真的在比对的那六格。理由本身不变。
  ['probes/residual-census.mjs', '本波测量线（钉住本波绝对读数，口径②）：默认（断言档）把"现树·新契约列"与 143/147/15/27/17/4 逐格对账 —— 引擎一改进（本波的目的就是改进它）这组数就变、它就红，红了要改的是那几个数 ⇒ 是台账，不是回归线。支持的旗标只有 --json / --show=N / --no-assert / --no-upstream 四个；未知旗标与缺失值现在都**点名 + exit 2**（原先静默吞掉 —— 历史文档里那个 `--assert` 就是个不存在的旗标，却一直照跑照绿）。'],
  // C2 改理由：`probes/residual-recheck.mjs` **已退休**（2026-10-16，用户裁定）—— 本条目从表里删掉，
  // 件原样移进 `docs/archive/probes/residual-recheck.mjs`（内容一字未改，只在顶部追加一段退休说明）。
  // 它原本为什么是空判：判定挂在 `tmp/recheck-r1-json.txt` 这份**一次性产物**上 —— 产物在才逐格对账；
  // 产物缺席时它只印一句“未做逐格对账”（:501），而退出码 `process.exit(assertMode && differ.length > 0 ? 1 : 0)`
  // （:543）拿不到 `differ` ⇒ **exit 0** —— C37 当次跑（测量方 JSON 缺席）就是这个结果。
  // 为什么不是回归线：它判的是“这一次那一份产物与现树读数逐格相符”，产物缺席时判据根本不存在 ⇒
  // 进闸只会给一个恒真的绿，把“没判”伪装成“判过了”。本表不再点它的名；普查口径怎么跟着改见 `SKIP_NESTED`。
  // C53 改理由：原文那句「它自己那份 replayNew 是**逐字复刻**（上游没导出）；failure-replay 的
  // 内部重放一改，它就红，而那时要改的是复刻件」已经过期 —— C52 已删掉那三个复刻件、改 import
  // 上游导出的 replayNewContract（本单 C53 又把 quote-hygiene 这最后一件同形缝收了口）。
  // 它仍不是回归线，理由换成不会随波漂的两条：读数挂在活读数 + 本次语料×引擎的快照上；
  // 真正的不变式在 SUITES 里那三条。
  ['probes/already-applied-census.mjs', 'C45 的**测量线**（残余 147 条里有多少条其实是“这次编辑已经落地了”），不是回归线：① 它的读数（本波 27/144/2 + 编号集）是这一次语料×引擎的快照，只打印、不手抄进判据；② 它判绿的两条里有一条挂在**活状态**上 —— 现场起只读子进程 `failure-replay.mjs --json` 取上游六格读数（columns.treeNew）与已落地编号集做逐格对账，而它自己那份重放已经是 import 上游导出的 `replayNewContract`（C52 起不再自带复刻件；上游那一列一改，它仍会红，而那时要对的是它内嵌的 pin 与记账适配、不是引擎，口径③）；③ 真正该当回归线的那三条不变式（不许误判 / 磁盘不动 / 幂等）由接口层 `already-applied-shell` 覆盖；原单元套件已归档'],
  // MT4 新增：编辑返工量具（本单预注册的问题：agent 调编辑工具要返工几次、错了能不能自己修回来）。
  // 它不是回归线，三条理由都不随波漂：
  //   ① 读数挂在**活语料**上（现扫 ~/.dsh/sessions 里两个真实任务工作区，会话文件还在长）；
  //   ② 判据全是**自洽判据 + 口径判据 + 分层自检**（编辑总数 = 首次 + 返工 / 自我修正率分子 ≤ 分母 /
  //      真落盘 ≤ isError=false ≤ 编辑总数 / 三层桶之和 = 编辑总数 / 逐工作区汇总 = 全局 /
  //      人群口径（默认运行时元会话占比 > 50% ⇒ 红）/ 合成回执四类必须分到四个不同的桶），
  //      **一条绝对条数都没写死** ⇒ 它红了说的是“量具坏了或取样取错了”，不是“引擎回归了”；
  //   ③ 与参考读数（aura_basetools_edit 占 20%、平均 1.67 hunk）的对照**只印不判**（语料一变该改的是那份读数）。
  // 判定力：退出码挂钩全部判据（0 绿 / 1 红 / 2 用法错；--selftest 整轮可跑且 exit 0）。
  ['probes/retry-discipline.mjs', '重试纪律读数：读会话日志打印重试分布，无退出码'],
  ['probes/rework-rate.mjs', 'MT4 **编辑返工量具**（钉住“一次就改好”这组读数）：读会话日志量①(会话,回合,文件)三元组的一次成功率②返工次数与有返工的三元组占比③失败后自我修正率④返工是否落到同一文件；两层成功判据（`isError=false` 与“从回执正文分出真落盘”）各占一格，并自报样本范围与时间窗。不是回归线：① 读数挂在**活语料**上（现扫 ~/.dsh/sessions，随日志增长而变）；② 判据全是自洽/口径/分层判据（记账三段闭合、人群口径自检、合成回执四类分四个不同的桶），一条绝对条数都没写死；③ 与参考读数（aura_basetools_edit 占 20%、平均 1.67 hunk）的对照只印不判。判定力：退出码挂钩全部判据（0 绿 / 1 红 / 2 用法错）'],
  ['probes/shadow-probe2.mjs', '影子调用计数：读会话日志打印调用计数表，无退出码'],
  ['probes/success-regression.mjs', '成功集回归量具：语料要现扫会话日志（~/.dsh/sessions 下的 zstd 流，600MB 级、几分钟）并随日志增长而变 ⇒ 判据挂在活状态上，不是可复现回归线（本波读数 Z = 0）'],
  // ── build/：C37（件数以闸输出「闸内实跑套件 N 件」那一行为准）──
  ['build/capabilities.mjs', '能力清单生成器：从源码导出常量并写 dist/capabilities.json；判据在 capabilities-test.mjs，生成器自身不判定。'],
  ['build/release-check.mjs', '闸本体：§①–§⑩ 就是它在跑。自我登记会递归（它跑自己），所以它只能在这里被点名'],
  ['build/range-all.mjs', '三套靶场的汇总器（有自己的退出码）：§② 已经**直跑**它，它的三行读数就在本闸的「靶场」组里。登记进 SUITES 等于每次让三套靶场多跑一遍', { ranAs: '靶场' }],
  // ── docs/ 与 dsh/：C37 抬根之后新进普查的两件（各命中一个形态）────────────────
  ['docs/embed-example/demo.mjs', '文档示例：命中的 S1b 是它打印的一句人话（磁盘"没动 ✓"），没有判据、没有退出码；它的可跑性由 §① 的 embeddability 套件负责（那一件照文档真跑一遍）'],
  ['dsh/argv-shell.mjs', '落地的宿主执行器（产物）：命中的 S1 是配置守卫 assertPositiveFinite(...)；没有汇总行与退出码。它的行为由 probes/hook-activation-check 段A（真 import + 与 --emit-shim 逐字节一致）与 hook-wiring-plan §3.2 负责，那两件都在上面的豁免台账里'],
  // ── src/aura-standalone/bin/：本波（独立面接 `targets`）新进普查的两件 —— 它们是**产品入口本体**
  //    （CLI 与 MCP 服务），命中的 S1 是它们**调用**的引擎形状守卫，不是它们自己的判据；两件都按
  //    C32 的规矩进豁免台账。不写第三格 `{ ranAs }`：那格是给“以别组读数在闸里现身”的件用的，
  //    而这两件的读数就在 `standalone-test` 那一组里，登记成 `ranAs` 只会让口径更绕。
  ['src/aura-standalone/bin/aura.mjs', '**产品入口（CLI 本体）**，不是套件：命中的 S1 是它调用的引擎形状守卫 —— `assertKnownArgs(...)`（:169，顶层未知键）与 `assertShape(...)`（:177，实参 :222 = `assertReadTargets` / :258 = `assertEditTargets`）；形状判据一条都不在这里（注释 :114 明说判据只有一处），本件只把该守卫抛的参数面错接到 exit 1。为什么不算判据：全文 0 个 ✓/✗、没有通过/失败汇总行、`process.exit(code)` 的退出码说的是“这次调用成没成”，不是“判据接在退出码上”（S1c 要的是 `process.exit(算出来的比较或三元)`）。行为由 `src/aura-standalone/test/standalone-test.mjs` 负责（那一件在 `SUITES` 里逐件**真跑**）：本波 src 侧读数「独立面：154 通过 / 0 失败」，同一份文件在 §③ 以 dist 形态跑「包内」那一组读数「155 通过 / 0 失败」—— 两个读数都是真跑出来的。'],
  ['src/aura-standalone/bin/aura-mcp.mjs', '**产品入口（MCP 服务本体）**，不是套件：命中的 S1 是它调用的引擎形状守卫 —— `assertReadTargets(...)`（:185）、`assertEditTargets(...)`（:201）、`assertTargetShape(...)`（:217），三处都是“与 DSH 壳、CLI 共用同一份判据”的调用点（注释 :49 / :174 / :211 明说判据不在这里），本件只把错码换成这一面的回执。为什么不算判据：全文 0 个 ✓/✗、没有通过/失败汇总行、**连一个 `process.exit` / `exitCode` 都没有**（它靠 stdout 的 JSON-RPC 回执表态，进程退出码不承载判据）。行为由 `src/aura-standalone/test/standalone-test.mjs` 负责（那一件在 `SUITES` 里逐件**真跑**，F 段真起服务做 initialize / tools/list / tools/call 往返）：本波 src 侧读数「独立面：154 通过 / 0 失败」，同一份文件在 §③ 以 dist 形态跑「包内」那一组读数「155 通过 / 0 失败」。'],
]
{
  /** S1：自有判据调用。名字表故意写得宽——漏报比误报贵，误报由 CENSUS_EXEMPT 人工确认。 */
  const S1 = /(?<![\w$.])(?:check|assert|expect|verify|must|should|ensure|hardFail|fail)[A-Za-z0-9_$]*\s*\(/
  /** S1b：逐条判定标记。 */
  const S1b = /[✓✗]/
  /** S1c（C42）：**把判据接在退出码上**的终局调用 —— `process.exit(<三元/比较>)`。
   *  它替 S2 收下 `probes/name-addressing.mjs`：那一件没有 S1 调用、也没有 ✓/✗ 标记，
   *  只有一个算出来的退出条件（`process.exit(undefinedLines.length === 0 ? 0 : 1)`），
   *  却是**真套件** —— 严格化的 S2 不再命中它之后，没有 S1c 就会把它降级成“只读数不判定”。
   *  只认“算出来的”那种（含 `?` 或比较符 ⇒ 不是硬写的 `process.exit(0)`）：恒 0 的探针不算判据。 */
  const S1c = /process\.exit\s*\([^)]*(?:\?|===|!==)/
  /** S2（C42 收紧）：末尾自己打印**通过/失败汇总行**。
   *
   *  收紧的动机是一条实测反例 —— 旧谓词（判据词 + `${` / `+`）把下面这一行读成了“有汇总行”：
   *      src/locator-lab/corpus-test.mjs:157
   *      check(totalBroken === 0, `无一文件建索引失败`, `${totalFiles} 个文件，坏 ${totalBroken}`)
   *  它只是**判据的标签文本**里带“失败”二字加一个模板串，根本没有汇总行 ——
   *  于是普查被同一形状骗过去，把一件“哑线”算进了「自带判据 58 件」（C42 实测）。
   *
   *  收紧后的判据 = 两个条件**同时**成立（少任何一个，那条反例都能继续骗过去 —— C42 两版实测）：
   *   ① 这一行是**打印调用**（`say(` / `console.log(` / `process.stdout.write(` …）直接带模板实参；
   *   ② 判据词在该模板的**字面文本**里（`${…}` 插值去掉之后还在）。
   *  只满足②不满足① ⇒ 标签骗得过去（`check(a, b, `字面…`)`）；只满足①不满足② ⇒ 读数行骗得过去
   *  （`say(`调用 ${n} 次；失败 ${e} 次`)`：判据词只在插值外的人话里、不在模板字面文本里）。逐条对照：
   *   · 正样本 `say(`--- ${n}/${m} 通过 ---`)` ⇒ 打印调用 + 字面文本含「通过」⇒ 命中；
   *   · 正样本 `console.log(`${n}/${m} 判据通过`)` ⇒ 命中（`判据通过` 是字面文本）；
   *   · 正样本 `process.stdout.write(`\n--- ${n}/${m} 通过 ---\n`)` ⇒ 命中；
   *   · 负样本 corpus-test.mjs:157 ⇒ 是 `check(...)` 调用、不是打印调用 ⇒ 不命中；
   *   · 负样本 probes/adoption-stats.mjs:197 读数行 ⇒ 判据词不在模板字面文本里 ⇒ 不命中。
   *  本仓实测：改前末 80 行内含判据词且非注释的行 144 条（含上述两条负样本），
   *  改后命中 57 条、逐条看过全是真汇总行。 */
  const S2 = (source) =>
    source
      .split('\n')
      .slice(-80)
      .some((line) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return false
        if (!/通过|失败/.test(line)) return false
        // 两个条件都必要（C42 实测：少任何一个都还会被骗）：
        //   ① 这一行的**打印调用**带的模板实参 —— 挡住 `check(a, b, `字面…`)` 这种“标签里带判据词”；
        //   ② 判据词在模板的**字面文本**里 —— 挡住“判据词只在 `${}` 插值里”（那是别人印的）。
        const printed =
          /(?:^|[^\w$.])(?:say|out|log|writeln|print|echo)\s*\(\s*`/.test(line) || // 裸打印函数
          /console\.(?:log|info|warn|error)\s*\(\s*`/.test(line) || // 带 owner 的那种（`console.log(` 不匹配上面那条）
          /process\.(?:stdout|stderr)\.write\s*\(/.test(line) // 写裸流（实参可以是三元/拼接，不要求紧跟反引号）
        return printed && /通过|失败/.test(templateLiteralTextOf(line))
      })
  /** 取那一行里**第一个完整模板字面量**的字面文本（去掉 `${…}` 插值）。
   *  必须是“第一个完整”的 —— 一行里可以有好几个反引号串：
   *      check(totalBroken === 0, `无一文件建索引失败`, `${totalFiles} 个文件，坏 ${totalBroken}`)
   *  从**第一个**反引号切到**最后一个**，会把两个串中间的 `, ` 连起来，字面文本里就凭空多出
   *  “无一文件建索引失败……个文件，坏” —— 正是那条负样本（C42 第一次改就是这样，读数仍是 true）。
   *  正确做法：从头扫，`${…}`（含嵌套）整段跳过，遇到配对的收尾反引号就停。 */
  /** 取那一行里**所有完整模板字面量**的字面文本（去掉 `${…}` 插值），拼接返回。
   *  三个坑都是 C42 实测踩出来的，逐个钉住：
   *   ① 一行里可以有好几个反引号串（`check(a, `标签`, `模板`)`）。从**第一个**反引号切到
   *      **最后一个**，会把中间的 `, ` 连起来，字面文本里凭空多出“无一文件建索引失败……个文件，坏”
   *      —— 正是那条负样本（第一版就是这么写的，读数仍是 true）。所以只能逐串扫。
   *   ② `${…}` 里可以**嵌套**模板（`${failed === 0 ? '全部通过' : `${failed} 项失败`}`）。
   *      `${` 之后必须整段跳到配对的 `}`，否则嵌套里的反引号会被当成外层模板的收尾；
   *      不这样处理，`standalone-test` / `range-bytes-test` 那类真汇总行会被误杀。
   *   ③ 收尾反引号只认 **depth === 0** 那个。
   *  另外：字符串字面量里的转义反引号（`` \`#N\` ``）会让扫描提前收尾，但那只会**少**读一段
   *  字面文本 —— 对“这行是不是汇总行”这个判断是安全方向（不会凭空多出判据词）。 */
  /** 取那一行里**所有模板字面量**的字面文本（去掉 `${…}` 插值），拼接返回。
   *  四个坑都是 C42 实测踩出来的，逐个钉住：
   *   ① 一行里可以有好几个反引号串（`check(a, `标签`, `模板`)`）。从**第一个**反引号切到
   *      **最后一个**，会把中间的 `, ` 连起来，字面文本里凭空多出“无一文件建索引失败……个文件，坏”
   *      —— 正是那条负样本（第一版就是这么写的，读数仍是 true）。所以只能逐串扫。
   *   ② `${…}` 里可以**嵌套**模板（`${failed === 0 ? '全部通过' : `${failed} 项失败`}`）。
   *      `${` 之后必须整段跳到配对的 `}`；不这样处理，嵌套里的反引号会被当成外层模板的收尾，
   *      `standalone-test` / `range-bytes-test` 那类真汇总行会被误杀。
   *   ③ 嵌套模板的**字面文本也要读**（`adoption-stats-test:104` 的「通过」「失败」就只在嵌套那层里）：
   *      所以进了 `${…}` 之后递归扫，而不是整段丢掉。
   *   ④ 收尾反引号只认 **depth === 0** 那个。
   *  另外：字符串字面量里的转义反引号（`` \`#N\` ``）会让扫描提前收尾，但那只会**少**读一段
   *  字面文本 —— 对“这行是不是汇总行”这个判断是安全方向（不会凭空多出判据词）。 */
  function templateLiteralTextOf(line) {
    let out = ''
    let i = 0
    while (i < line.length) {
      if (line[i] !== '`') {
        i += 1
        continue
      }
      let lit = ''
      let nested = ''
      let depth = 0
      let j = i + 1
      let closed = false
      for (; j < line.length; j += 1) {
        const c = line[j]
        if (c === '$' && line[j + 1] === '{') {
          // 找配对的 `}`，把整段插值交回给本函数递归（它自己会跳过其中的字符串字面量）
          let d = 1
          let k = j + 2
          for (; k < line.length && d > 0; k += 1) {
            const e = line[k]
            if (e === '\\') {
              k += 1
              continue
            }
            if (e === '{') d += 1
            else if (e === '}') d -= 1
          }
          const inner = line.slice(j + 2, k - 1)
          if (inner.includes('`')) nested += templateLiteralTextOf(inner)
          j = k - 1
          continue
        }
        if (c === '`') {
          closed = true
          break
        }
        lit += c
      }
      out += ` ${lit} ${nested} `
      i = closed ? j + 1 : i + 1
    }
    return out
  }
  /** C42：登记套件有没有**真的**把判据接到退出码上（静态扫；边界与豁免见下面 `unwired` 那一段）。
   *  只认“写法”，不认“提到” —— 三种合法写法：
   *    · `process.exit(`            —— 直接退（含 `process.exit(failed ? 1 : 0)`）
   *    · `process.exitCode = …`     —— 赋值
   *    · `process.exitCode ??= …`   —— 复合赋值
   *  为什么不能写宽（C42 实测到的洞，第一版就是这么栽的）：宽写成 /process\.exit\(|exitCode/ 时，
   *  只要文件里**任何位置**出现这两个词就算“有接线” —— 而 `corpus-test.mjs` 的注释里恰好写着
   *  「全文 0 处 process.exit / exitCode」。于是“把那一行拔掉 ⇒ 它仍算有接线 ⇒ 机检不红”，**假绿**。
   *  所以必须匹配到赋值/调用的**形状**。另外刻意不剥注释：剥了反而会把“注释里说没接线”当成接线。 */
  const EXIT_WIRE = /process\.exit\s*\(|process\.exitCode\s*(?:=|\+=|\?\?=)/
  /** 判据名 -> 形态。`S1判据调用`/`S1c退出码判据` 才算“自有判据”（能实际表态的那种）。 */
  const shapesOf = (source) =>
    [
      S1.test(source) ? 'S1判据调用' : null,
      S1b.test(source) ? 'S1b判定标记' : null,
      S1c.test(source) ? 'S1c退出码判据' : null,
      S2(source) ? 'S2汇总行' : null,
    ].filter(Boolean)

  // C37：扫描根 = 仓根 `/**`（原来是 `src/**`）。跳过的是**派生物与冻结件**，不是"没问题的代码"：
  //   · `dist/`     —— `src` 的副本，§⑥ 已逐字节比对；扫它会把每件套件按第二条路径再要一次登记。
  //   · `fixtures/` —— 冻结基准数据（故意的旧快照，不该跟着源演进）。
  //   · `node_modules/`（任意深度）—— 第三方。
  //   · `docs/archive/` —— **退休件存放处**（C2 加；逐条说明见下面的 `SKIP_NESTED`）。
  //   · `eval/`     —— **独立测评集**（`eval/independent`）：黑盒评测已发布 npm 包，不是产品内
  //                   套件；它会 npm install/联网、故意不登记进发布闸（否则离线 gate 不可复跑）。
  const SKIP_TOP = new Set(['dist', 'fixtures', 'eval'])
  // C2（2026-10-16）：`docs/archive/**` = **退休件存放处**（规矩见 `docs/archive/README.md`）。显式跳过，
  // 与上面三个根同一个机制，逐个交代：
  //   · 谁扫：本项（§⑩ 普查）扫仓根 `/**`，按相对路径把 `docs/archive` 这一级整个跳过；
  //   · 扫到几件：该目录下现在 1 个 .mjs（`docs/archive/probes/residual-recheck.mjs`；同目录那份
  //     `README.md` 扩展名不在收集范围）—— 跳过件数计入下面「完整性」/「口径」两行的“未扫”读数
  //     （跳过是**记在账上**的：数一变就看得见，不是把目录从扫描根里悄悄拿掉）；
  //   · 为什么不判：归档件的**内容冻结**（退休即不再维护、不随源演进）⇒ 形态判据对它是恒真的一件事：
  //     它永远命中 S1/S1c，又永远不会变回套件；在豁免台账里给它留一条，那条豁免也**永远不会过期**
  //     （过期判据查的是“文件不再有断言形态”），只会在账上多算一件“非套件”。这与 `fixtures/` 是
  //     同一条规矩（冻结的旧快照不该被要求登记）；代价照旧声明：这是一个盲区（见上面盲区一）。
  const SKIP_NESTED = new Set(['docs/archive'])
  const walk = (dir, acc, { skip, top }) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        if (skip && top && SKIP_TOP.has(entry.name)) continue
        // C2：`docs/archive` 这一级整个跳过（谁扫 / 扫到几件 / 为什么不判见上面的 `SKIP_NESTED`）。
        if (skip && SKIP_NESTED.has(path.relative(root, full).replaceAll(path.sep, '/'))) continue
        walk(full, acc, { skip, top: false })
      } else if (/\.(mjs|js)$/.test(entry.name)) acc.push(full)
    }
    return acc
  }
  const relativeOf = (file) => path.relative(root, file).replaceAll('\\', '/')
  const auditedFiles = walk(root, [], { skip: true, top: true }).sort()
  const allFiles = walk(root, [], { skip: false, top: true }).sort()

  const hits = new Map()
  for (const file of auditedFiles) {
    const shapes = shapesOf(fs.readFileSync(file, 'utf8'))
    if (shapes.length > 0) hits.set(relativeOf(file), shapes)
  }
  // C37：枚举名单 = `ranSuites`（闸内**真的跑过**的套件文件），而不是 `SUITES` 那一份子集。
  const enumerated = new Set(ranSuites)
  const exempt = new Map(CENSUS_EXEMPT.map(([relativeFile, reason, wire]) => [relativeFile, { reason, ranAs: wire?.ranAs }]))
  // 两个方向各查一次（**两个数都印出来**）：
  //   · 扫到却没登记（`unregistered`）——“多”；
  //   · 枚举了却没文件（`vanished`）——“缺”。
  // “枚举数 = 实际数”不是另写一条恒真的断言，而是由这两条方向相反的检查共同保证：
  // 两边都空时，`枚举名单 ∩ 扫描命中` 恰好就是扫描命中的全集去掉豁免。
  const unregistered = [...hits.keys()].filter((rel) => !enumerated.has(rel) && !exempt.has(rel)).sort()
  const suiteHits = [...enumerated].filter((rel) => hits.has(rel)).sort()
  const exemptHits = CENSUS_EXEMPT.filter(([rel]) => hits.has(rel)).map(([rel]) => rel)
  const wiredHits = CENSUS_EXEMPT.filter(([rel, , wire]) => wire?.ranAs !== undefined && hits.has(rel)).map(([rel]) => rel)
  const vanished = [...enumerated].filter((rel) => !fs.existsSync(path.join(root, rel))).sort()
  const shapeless = [...enumerated].filter((rel) => fs.existsSync(path.join(root, rel)) && !hits.has(rel)).sort()
  // ── C42 A7：“登记在册 + 自带判据”的套件，必须**真的能用退出码表态** ──────────────
  // 为什么加这一条：`src/locator-lab/corpus-test.mjs` 被 SUITES 登记、有 5 条自有判据、
  // 有 ✓/✗ 打印，却**全文没有 process.exit / exitCode**。把 `struct-core` 换成空桩，它照印 3 条 ✗
  // 而进程仍是 exit 0 ⇒ `suite()` 看退出码 ⇒ 闸看到的是 ✅。**一个登记在册的红线，实际上是哑的。**
  // 上面两条机检（未登记 / 已过期）都查不到它：它登记得好好的，形态也齐全。
  // 所以单加这一条 —— 判的是“表态通道”，不是“有没有判据”：
  //   · 名单 = `suiteRuns`（**只有**走 `suite()` 那条路、退出码被看的那些文件）；
  //   · 只在“自带判据”（S1 判据调用 / S1b 判定标记 / S1c 退出码判据）里查。
  // 边界（静态扫会误伤的那一类，逐个说清）：
  //   · 把退出码封装在**共享 runner** 里的套件 —— 写这句时是 59 件里 58 件自带
  //     `process.exit`/`exitCode`（剩下 1 件 `read-fidelity.mjs` 本来就只读数、不判定），
  //     现值以闸输出「C42 退出码接线：登记且自带判据 N 件 → 有接线 N + 豁免 N + 缺接线 N」
  //     那一行为准。将来真出现，就在下面的 EXIT_WIRE_EXEMPT 里逐条登记；
  //   · 经 import 间接表态（`import { run } from './runner.mjs'` 后由 runner 设 exitCode）
  //     —— 同上，留给豁免表，不在静态扫描里猜。
  const EXIT_WIRE_EXEMPT = new Map([
    // （当前为空。加一条 = 人工确认过“它的退出码确实由别处统一设置”，理由不写不算登记。）
  ])
  const suiteRuns = ranSuites.filter((rel) => fs.existsSync(path.join(root, rel)))
  const hasOwnJudgement = (rel) => {
    const shapes = hits.get(rel) ?? []
    return shapes.includes('S1判据调用') || shapes.includes('S1b判定标记') || shapes.includes('S1c退出码判据')
  }
  const judgedSuites = suiteRuns.filter(hasOwnJudgement)
  const unwiredExemptSuites = judgedSuites.filter((rel) => EXIT_WIRE_EXEMPT.has(rel))
  const unwired = judgedSuites
    .filter((rel) => !EXIT_WIRE.test(fs.readFileSync(path.join(root, rel), 'utf8')))
    .filter((rel) => !EXIT_WIRE_EXEMPT.has(rel))
    .sort()
  const wiredSuites = judgedSuites.filter((rel) => !unwiredExemptSuites.includes(rel) && !unwired.includes(rel))
  const staleExempt = CENSUS_EXEMPT.filter(([rel]) => !hits.has(rel)).map(([rel]) => rel)
  // C37 过期判据②：`{ ranAs }` 说的那一组读数必须真的在本次闸里出现过（弱耦合，口径见文件头）。
  const unwiredExempt = CENSUS_EXEMPT.filter(([, , wire]) => wire?.ranAs !== undefined && !rows.some((row) => row.group === wire.ranAs)).map(
    ([rel]) => rel,
  )

  const problems = []
  if (unregistered.length > 0) {
    problems.push(
      `未登记：${unregistered.join(', ')}（自带判据/汇总却不在普查名单里：要么加进 SUITES 让它真跑，要么写进 CENSUS_EXEMPT 说明它不是套件）`,
    )
  }
  if (vanished.length > 0) problems.push(`枚举了但文件不存在：${vanished.join(', ')}`)
  if (staleExempt.length > 0) problems.push(`CENSUS_EXEMPT 已过期（文件不再有断言形态，登记表要跟着改）：${staleExempt.join(', ')}`)
  if (unwiredExempt.length > 0) {
    problems.push(`CENSUS_EXEMPT 的「闸内别处实跑」已过期（{ ranAs } 说的那一组读数本次没出现，它现在是真·闸外）：${unwiredExempt.join(', ')}`)
  }
  // C42 A7：这条就是防“哑线”复发的那一条 —— 点名 + 写明“换空桩也不会红”这件事已经成立过。
  if (unwired.length > 0) {
    problems.push(
      `登记套件缺退出码接线：${unwired.join(', ')}（已被 SUITES 登记、自带判据，却全文没有 process.exit / exitCode ⇒ 判据红而闸是绿的：把它依赖的引擎换成空桩，它照印 ✗、进程仍 exit 0。接上退出码，或写进 EXIT_WIRE_EXEMPT 说明退出码由别处统一设置）`,
    )
  }
  rows.push({
    group: '普查',
    name: '完整性',
    status: problems.length === 0 ? 'ok' : 'fail',
    summary:
      problems.length === 0
        ? `闸内实跑套件 ${ranSuites.length} 件 = 自带判据 ${suiteHits.length} + 只读数不判定 ${shapeless.length}；扫描根 仓根/** 扫到 ${auditedFiles.length} 个 .mjs/.js（另有 ${allFiles.length - auditedFiles.length} 个在 dist/ fixtures/ node_modules/ docs/archive/ 里被跳过）→ 命中断言形态 ${hits.size} = 套件 ${suiteHits.length} + 闸内别处实跑 ${wiredHits.length} + 非套件豁免 ${exemptHits.length - wiredHits.length} + 未登记 0；两个数相符（0 缺 0 多）` +
`；C42 退出码接线：登记且自带判据 ${judgedSuites.length} 件 → 有接线 ${wiredSuites.length} + 豁免 ${unwiredExemptSuites.length} + 缺接线 ${unwired.length}${unwired.length > 0 ? `（**${unwired.join(', ')}**）` : ''}`
        : problems.join('；'),
  })
  rows.push({
    group: '普查',
    name: '口径',
    status: 'skipped',
    summary: `谓词=S1判据调用|S1b判定标记|S1c退出码判据|S2末尾汇总行（C42 收紧：判据词必须在打印调用的模板实参**字面文本**里 —— 旧谓词把 corpus-test:157 那条判据标签误读成了汇总行）；另加闸门 A7：登记且自带判据的套件必须有退出码接线（静态扫 process.exit/exitCode，豁免 ${EXIT_WIRE_EXEMPT.size} 件）；扫描根=仓根/**（跳过 dist/ fixtures/ node_modules/ docs/archive/：派生物 · 冻结数据 · 第三方 · 退休件（不参与判定），${allFiles.length - auditedFiles.length} 个 .mjs/.js 未扫）；只读数不判定（不红，但要看得见）：${shapeless.length === 0 ? '(无)' : shapeless.join(', ')}；非套件豁免 ${CENSUS_EXEMPT.length} 件（逐条理由写在 CENSUS_EXEMPT 里，逐个归属见下面的「归属·X」行）`,
  })

  // ── C37 段B：每个被扫的根**逐个文件有归属** ──────────────────────────────
  // 四格：登记（在 SUITES 里真跑）/ 闸内别处实跑（`{ ranAs }`）/ 豁免（非套件）/ 无断言形态
  //（按形态判据不需要归属，但件数要印出来，好让"23 件里 18 件命中"这类账当场可核）。
  // 名单超过 24 件的桶只印件数（`src` 那 51 件套件逐个都在上面的套件行里）。
  // 这些行只读数，但某个根出现「未登记」时也跟着红 —— 好让人一眼看见是哪个根漏了。
  const CAP = 24
  const list = (names) =>
    names.length === 0 ? '(无)' : names.length <= CAP ? names.join(', ') : `${names.length} 件（>${CAP}，名单见上面的逐件读数）`
  const rootOf = (rel) => (rel.includes('/') ? rel.split('/')[0] : '(根)')
  const rels = auditedFiles.map(relativeOf)
  for (const dir of [...new Set(rels.map(rootOf))].sort()) {
    const here = rels.filter((rel) => rootOf(rel) === dir)
    const hit = here.filter((rel) => hits.has(rel))
    const registered = hit.filter((rel) => enumerated.has(rel))
    const elsewhere = hit.filter((rel) => !enumerated.has(rel) && exempt.get(rel)?.ranAs !== undefined)
    const exempted = hit.filter((rel) => !enumerated.has(rel) && exempt.has(rel) && exempt.get(rel)?.ranAs === undefined)
    const missingHere = hit.filter((rel) => !enumerated.has(rel) && !exempt.has(rel))
    rows.push({
      group: '普查',
      name: `归属·${dir}`,
      status: missingHere.length === 0 ? 'skipped' : 'fail',
      summary: `${here.length} 个 .mjs/.js → 命中断言形态 ${hit.length} = 登记 ${registered.length} + 闸内别处实跑 ${elsewhere.length} + 豁免 ${exempted.length} + 未登记 ${missingHere.length} ｜ 四格逐个点名：登记：[${list(registered)}] ｜ 闸内别处实跑：[${list(elsewhere)}] ｜ 豁免：[${list(exempted)}] ｜ 无断言形态（按形态判据不需要归属；列出来是为了让“${here.length} 件”这个数当场可核）：[${list(here.filter((rel) => !hits.has(rel)))}]${missingHere.length > 0 ? ` ｜ **未登记：[${missingHere.join(', ')}]**` : ''}`,
    })
  }
}


const hardFail = rows.filter((row) => row.status === 'fail' || row.status === 'missing')
if (json) {
  process.stdout.write(`${JSON.stringify({ ok: hardFail.length === 0, version: null, checks: rows }, null, 2)}\n`)
} else {
  let group = ''
  for (const row of rows) {
    if (row.group !== group) {
      group = row.group
      process.stdout.write(`\n=== ${group} ===\n`)
    }
    const mark = row.status === 'ok' ? '✅' : row.status === 'skipped' ? '⏭' : row.status === 'missing' ? '⚪' : '❌'
    process.stdout.write(`  ${mark} ${row.name.padEnd(16)} ${row.summary}\n`)
    if (row.stderr !== undefined && row.stderr !== '') process.stdout.write(`       stderr: ${row.stderr}\n`)
  }
  process.stdout.write(
    hardFail.length === 0
      ? '\n全量测试通过 —— 可以发布（DSH 工具面仍需重启宿主才生效，那是人的动作）\n'
      : `\n全量测试**未通过**：${hardFail.length} 项（${hardFail.map((r) => r.name).join(', ')}）\n`,
  )
}
process.exitCode = hardFail.length === 0 ? 0 : 1
