#!/usr/bin/env node
// =============================================================================
// aura-tools/probes/activate-and-verify.mjs —— fs-contract-v2 波9 / C30：激活与验证【可执行件】
//
// 【这是什么】把「重启宿主之前该确认什么、重启之后该验证什么」变成一条命令能跑的东西。
//   三种模式，一条命令一种：
//     --check         打印**当前激活状态与就绪度**（安装副本、宿主进程、引擎侧是否已生效、钩子那一行、
//                     落地件、回滚链），每条判据都给【期望值 vs 实际值】。对**被观测的树**全程只读
//                     （`~/.aura` 整棵由 A5-home-untouched 逐件实测：哈希+字节数+mtime 跑前跑后差异必须 0）；
//                     本模式唯一的写入是仓库内那一个哨兵旁路索引，逐条列在结尾「写盘清单」里。
//     --apply         **打印出将要执行的精确操作**（文件 / 行号 / 替换前后 / 备份路径 / 回滚命令），
//     --rollback      默认 dry-run；真执行要显式 `--yes`。
//     --post-restart  重启之后跑：自动回收真机读数 + 打印清单（每条：命令 / 期望读数 / 判红条件）。
//     --selftest      变异反证：逐条把期望值改坏，断言对应判据必须变红（否则那条判据等于永远绿的）。
//
// 【为什么】引擎侧已构建安装到 0.6.6+b4b7aca8bc3a（previous/ 现在是 0.6.5+56c941ddffe2 —— 升到 0.6.6（C63）那一步
//   把旧的 0.6.5+56c941ddffe2 对调进了 previous/），但宿主进程启动于安装之前 ⇒ 宿主内存里还是旧字节；
//   钩子那一行（profile:51）仍是 `@deepseek-ai/dsh-pwsh-local` ⇒ 每个工具调用照付 686ms 壳税。
//   两件事都要重启宿主才生效，而重启会终止当轮会话 —— 所以「确认什么 / 验证什么」必须在重启**之前**
//   就变成可执行、可复核、有期望值与判红条件的东西，而不是留一段文字给人临场回忆。
//
// 【本脚本不做什么（硬边界）】
//   · **绝不自动执行应用**：不带 `--yes` 时任何模式下都不写 `C:\Users\cxk\.dsh\**` 一个字节；
//     本文件从落仓到验收全程只跑过 `--check` / `--apply`(dry) / `--rollback`(dry) / `--post-restart` / `--selftest`。
//   · 不重启、不杀任何进程：宿主进程只被**只读枚举**（Win32_Process）。
//   · 不改 ~/.aura/pkg：安装副本与 previous/ 全程只读（哈希是重算出来对的，不是信 install.json）。
//   · 【C57 修正的自述】以前这里写的是「唯一会写盘的地方是暂存箱」—— **不准确**：`--check` 还会增量写
//     仓库内那一个哨兵旁路索引（`.polaris/activate-b4-sentinel.json`，见 §3.7 的 writeSentinelIndex 与 WRITES）。
//     准确的写法是：**被观测的那些树全程只读**（`~/.aura` 整棵、`~/.dsh`、安装副本、previous/、宿主 profile、
//     落地件），会写盘的只有下面这几处，且都逐条列在结尾的「写盘清单」里 ——
//       ① %TEMP% 里的一次性暂存箱（退出前删除）；
//       ② 仓库内的哨兵旁路索引（增量；`--sentinel-index=` 空串或 `--mutate=sentinel-lost` 时连它也不写）；
//       ③ `--yes` 时的那一个 profile 写入（`--apply` / `--rollback` 专用，`--check` 永不涉及）。
//   · 【`~/.aura/observations.json` 是谁写的（C57 定位结论）】**不是本脚本**。写它的是**独立面**
//     （`aura` CLI / `aura-mcp`）的观测账本落盘实现：`src/aura-standalone/lib/ops.mjs` 第 192 行
//     `setObservationStore(createDiskStore())` → `src/aura-standalone/lib/observation-store.mjs` 的
//     `save()` → `~/.aura/observations.json`（`AURA_CACHE_DIR` 可改）。它每次调用都是**新进程**，上一轮的观测
//     必须活到进程外（区域级新鲜度闸门的基准），所以每次成功取景都会 `remember()` 并落盘。
//     本脚本从不 spawn 独立面：`--check` 会 spawn 的只有 `where.exe`（找 pwsh）、`pwsh`（只读进程表）、
//     两个 `node` 行为指纹子进程（合成 ctx，只读引擎）、以及 `hook-wiring-plan.mjs --emit-shim` —— 逐条见 §3。
//     所以 `~/.aura` 的写入与本脚本无关；这条自述现在由 A5-home-untouched **实测**，不再只是声明。
//     本机实测到的**具体触发点**（2026-10-15，C57）：跑 `node aura-tools/build/release-check.mjs` 一次，
//     `~/.aura/observations.json` 就被追加一条 —— 时间戳能对上：闸里 `encoding-refusal` 那一套件
//     （`src/locator-lab/encoding-refusal-test.mjs:175-178`）spawnSync 真 CLI 子进程时**没有**把
//     `AURA_CACHE_DIR` 指到临时目录（同闸的 `observation-store-identity` / `cli-mcp-e2e` / 三套靶场都指了），
//     于是子进程的 `createDiskStore()` 落在真 home。
//     它不在本脚本的写范围里，所以这里只记事实、不改它；`--check` 不跑那套件，A5 因此必须是 0。
//
// 【口径与证据来源（都是**实测**，不是抄来的断言）】
//   ① 引擎侧生效指纹 = 「必然找不到的读」的回执形状，判据从两个根现跑得出，不是写死的字符串：
//        旧壳（**冻结夹具** `aura-tools/fixtures/frozen-engine-0.6.1-217798da/`）：`mode=search` + 必然不存在的串
//          ⇒ **抛错**（`threw:true`），message `READ_NOT_FOUND: no line contains …`
//        新壳（安装副本 = 现树）：同一次调用 ⇒ **正常结果**，带 `outcome=not_found` / `code` / `next`，回执正文 `Error (READ_NOT_FOUND): …`
//      【为什么对照根不是 previous/】升到 0.6.2 时 previous/ 就被换成了当时的新壳（0.6.1+0d07d8b23ae3），
//        升到 0.6.3 换成 0.6.2+f089fa1d4115，升到 0.6.4 换成 0.6.3+3d303772b749，升到 0.6.5（C60）换成 0.6.4+206f9ce2c08e，
//        升到 0.6.6（C63）换成 0.6.5+56c941ddffe2
//        —— 每一份都**已经是新壳**
//        （实测 `result:not_found`，与安装副本同形）。
//        拿它当「旧壳」对照，两边形状一模一样，判定力自证（B3）就成了恒真的空话。
//        真正还带旧壳的只剩冻结夹具，故 B3 的旧壳锚点改钉在它上面。
//        夹具缺失、清单对不上、或被换成现树任何一份（0.6.6+b4b7aca8bc3a / previous/）
//        一律判红并点名（B3a-fixture-intact），**不静默放过**。
//      两壳分叉点在源码里可核：旧 `frozen-engine…/aura-read/index.js` 无条件 throw；
//      新 `aura-tools/src/aura-read/index.js:145-152`（OUTCOME_BY_CODE）+ `:668-683`（intentVerdict 非空 ⇒ 走正常结果）。
//   ② 钩子侧生效指纹 = **钩子进程的命令行**：旧路（pwsh-local）每个钩子都多一个
//        `pwsh.exe -NoLogo -NoProfile -NonInteractive -Command "…node \"…/hook.mjs\" --event=PreToolUse…"`
//      进程，钩子本体（node）的父进程是 pwsh.exe；直投 argv 路下钩子由宿主直接 spawn，父进程是 node。
//      本探针用 `--watch-hooks=N` 采样进程表来抓这个形状（采样不到就如实报「未观测」，不猜）；
//      只看 `hook.mjs` 会把别人的钩子也算进来（实测本机另有 guard-test 直投 node 跑 hook），
//      所以判据入口取**宿主自己 hooks.json 里那条命令的入口路径**。
//   ⑥ 引擎侧指纹的**实测**读数（B4）= 从会话日志回收「宿主自己造的那一发」——
//      唯一的识别物是那个独特哨兵串（默认 `ZZZ_C30_ABSENT_TOKEN_ZZZ`，要用别的串给 `--absent-token=`）。
//      只认 `name === 'aura_read'` 且**参数里带哨兵串**的那一发；其余任何失败回执（比如别的
//      `cannot read "…": not found`）都**不**能当它的替身 —— 那种回执两种壳都可能产生，形状判不出新旧，
//      拿它顶包会把「未观测」伪装成一个看起来像读数的 `unknown`（2026-10-14 实测就是被 C43 那一发顶了包）。
//      真的没观测到就如实报「未观测」（不判红：没人发那一发不是失败；但 `--mutate=engine-fingerprint` 时
//      「未观测」本身就是红 —— 那正是这条判据有判定力的证明）。
//   ⑦ 【C46 修的退化】B4 原来靠「按 mtime 倒序取前 maxFiles=32 个会话文件、扫到哨兵就停」来找那一发 ——
//      那个 32 是**绝对的**：每新开一个会话，哨兵那一发就上顶一格（2026-10-15 实测它已排到 32 名之外，
//      B4 当场退化成「未观测」并丢掉实测读数）。现在改成**旁路索引 + 有界增量深扫**：
//        · 索引（`--sentinel-index=`，默认 `.polaris/activate-b4-sentinel.json`）只记「哪个会话文件里有那一发」
//          （按 路径 + 字节数 + mtime 认账），每次运行把新开/长大的文件增量补进去；
//        · **索引里点过名的那一份永远在候选集里**（它按 mtime 早就不在最近 32 个里了，但读数一刻也不会丢）；
//        · 深扫有界：每次运行最多深读 `--sentinel-scan-window=` 个文件（默认 32）、合计不超过 `--sentinel-budget-mb=`
//          （默认 48MB）。因为索引把「已判过」的会话记住了，这个窗口是**一次性回填**用的，稳态下每轮只深读新开的那几个。
//        · 【为什么不用「只读文件头」的便宜全扫】实测过：会话日志是 971 个 zstd 帧拼起来的（首帧只有 176–233 字节，
//          286 字符），哨兵串落第 11–842 帧、解压后字符偏移 6.9 万–453 万；**在 8 份含哨兵的会话里，压过的原始字节里
//          一次都搜不到哨兵串**（0/8）⇒ 文件头/原始字节探测在这个格式上恒假阴性，不能当「宿主从没发过那一发」的证据。
//          所以「找不到」的诚实说法只能是「没观测到」，而**能变红的那一格**必须是「我确知它存在、却没读进窗口」。
//   ⑧ 判据怎么分工（C46 新增两条，条数只增不减）：
//        B4-engine-fingerprint  形状判红绿（跟以前一样；未观测不判红，除非 --mutate=engine-fingerprint）。
//        B4a-sentinel-not-lost  **C46 新增的硬判据**：索引/本轮扫描任一处确知哨兵那一发存在，而窗口里一发都没有
//                              ⇒ 变红并**点名**被挤掉的那一份（这正是以前会静默退化成「未观测」的那一格）。
//        B4b-sentinel-census    口径读数：候选集怎么来的、深扫了几个、索引记住了几份哨兵会话、回填还欠多少。
//      索引读写全程只碰仓库内这一个 JSON（scope=repo）；索引读不出/删掉都不影响判定 —— 那时退化成
//      「拿有界窗口现扫一遍」，并且**如实报未观测**，绝不报错、绝不编读数。
//   ⑤ 安装器里有一条已证只读的预检命令 `install.mjs --rollback --dry-run`（C28/integrate8 跑过 exit 0），
//      它在 --run=rollback-dryrun 时会被真跑；默认只打印。`--run=all` = 护栏 + 三条测量线 + 回滚预检。
//   ③ 墙钟同一口径 = 宿主自己的账 `hook/result.durationMs`（point=PreToolUse，会话日志）与
//      钩子自己的账 `pre_tool.ms`（.polaris/polaris-guard.log.jsonl）。两者之差就是外层壳税。
//      重启前实测：宿主侧 p50≈688ms / 钩子侧 p50≈69ms ⇒ 壳税 ≈ 619ms（与 C6 的 686ms 同源）。
//   ④ 安装副本的「版本/构建戳」不是读状态文件复述，而是按 `build/install.mjs` 的
//      hashTree + treeDigest + buildStampOf **逐件重算**（20 行独立实现），再与 install.json 对账。
//      三份树的实测戳（2026-10-15 升到 0.6.6（C63）后；逐件重算）：
//        安装副本  0.6.6+b4b7aca8bc3a  （treeHash b4b7aca8…505，19 件）
//        previous/ 0.6.5+56c941ddffe2  （treeHash 56c941dd…078，19 件）—— 升 0.6.6 那步把这份对调进来的
//        冻结夹具  0.6.1+217798da5117  （treeHash 217798da…61a，19 件）—— 唯一还带旧壳的一份
//      差异件数（D2）实测 6：aura-read/index.js、aura-edit/index.js、locator-lab/read-core.mjs、
//      locator-lab/write-path.mjs、package.json、README.md。
//      升 0.6.6 跨了 C60 之后的几个单元：read-core.mjs 是 C62 的「身份键优先、折叠只当兜底」、
//      两个壳与 write-path.mjs 是同批落在源树上的壳/写路径改动、package.json 是 version 0.6.5→0.6.6、
//      README.md 是随之刷新的版本说明；其余 13 件与 previous/ 逐字节相同。
//      （C63 只改了源树上的两处 package.json 版本与本探针的期望值，没动引擎件。）
//
// 【怎么复跑】
//   node aura-tools/probes/activate-and-verify.mjs --check                  # 只读现状（退出 0 = 全部硬判据绿）
//   node aura-tools/probes/activate-and-verify.mjs --apply                  # dry-run：打印精确操作
//   node aura-tools/probes/activate-and-verify.mjs --apply --yes            # 真执行（**本单从未跑过**）
//   node aura-tools/probes/activate-and-verify.mjs --rollback               # dry-run：打印精确回滚
//   node aura-tools/probes/activate-and-verify.mjs --post-restart           # 重启后：回收读数 + 清单
//   node aura-tools/probes/activate-and-verify.mjs --post-restart --watch-hooks=20   # 附带进程表采样
//   node aura-tools/probes/activate-and-verify.mjs --post-restart --run=all # 连外部命令一起真跑（护栏 + 三条测量线）
//   node aura-tools/probes/activate-and-verify.mjs --post-restart --run=all # 连外部命令一起真跑（护栏 + 三条测量线 + 回滚预检；--deep 是它的别名）
//   node aura-tools/probes/activate-and-verify.mjs --selftest               # 变异反证：逐条把期望改坏，断言对应判据变红（含四条无变异基线）
//   node aura-tools/probes/activate-and-verify.mjs --check --mutate=install-stamp   # 单条变异：本轮必须点名那条判据变红
//   node aura-tools/probes/activate-and-verify.mjs --check --mutate=fixture-intact  # 把夹具完整性判据改坏：B3a 必须变红
//   node aura-tools/probes/activate-and-verify.mjs --check --fixture-engine=<dir>   # 换一个「旧壳」对照根（默认冻结夹具）
//   node aura-tools/probes/activate-and-verify.mjs --check --mutate=sentinel-lost --sentinel-budget-mb=2048   # 变异反证 B4a：关索引 + 预算给足（深扫扫完候选）⇒ 哨兵那一发进候选集但进不了 0 发的读数窗口 ⇒ 必须变红并点名
//   退出码：0 = 全部硬判据绿 / 1 = 有硬判据红（逐条点名 + 修法）/ 2 = 用法错。
//
// 【变异反证怎么用】任何模式加 `--mutate=<判据名>` 就把那条判据的**期望值**故意改坏，
//   于是本轮必须变红（这就是「判据有判定力」的证明）。判据名见 §2 的 MUT_IDS，或跑 `--selftest` 一次看全表。
// =============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pkgPath } from '../build/pkg-root.mjs'

const say = (m = '') => fs.writeSync(1, `${m}\n`)
const SELF = fileURLToPath(import.meta.url)

// ═════════════════════════════════════════════════════════════════════════════
// §0 参数
// ═════════════════════════════════════════════════════════════════════════════
const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? def : hit.slice(name.length + 3)
}
const has = (name) => argv.includes(`--${name}`)
// 注（C46）：以前写的是 argOf(name, '')，而 `Number('') === 0` ⇒ **参数根本不写时也会返回 0、默认值 v 形同虚设**
// （当时只有 --watch-hooks 用，它的默认正好就是 0，所以一直没人看出来；C46 的哨兵窗口默认 32，当场踩到）。
// 现在：参数没写就返回默认值；写了 `--name=` 空串也当没写（跟 --sentinel-scan-window= 的语义一致）。
const numOf = (name, def) => {
  const raw = argOf(name, '')
  if (raw.trim() === '') return def
  return Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : def
}
/**
 * 仓库根：默认 = 本脚本往上两级（`<repo>/aura-tools/probes/…`），`--repo=<dir>` 可换。
 *
 * 【修的是一个「登记了却没人消费」的潜伏缺陷】`repo` 一直在 KNOWN 名单里（所以 `--repo=<dir>` 不会被当成
 * 未知参数拒掉），但**从来没有任何地方读它** —— 传了它等于什么都没发生，而且不报错（静默失效）。
 * 修法上有个顺序约束：`REPO` 必须在 `argOf` 之后才算得出来，而 `argOf` 又需要 `argv`，所以这一行从
 * `SELF` 旁边搬到参数解析之后；`const REPO` 改成 `let REPO` 是因为“默认值 + 可覆盖”只能这样写。
 * 【行为不变性】在这份文件的真实用法（不带 --repo）下，`path.resolve(argOf('repo', D))` 与 `path.resolve(D)`
 * 是同一个值：`argOf` 没命中时原样返回默认值，`resolve` 对已经是绝对路径的默认值是恒等变换。
 * 其余读 `REPO` 的位置全在参数解析之后（`--help` 那条出口只打印用法，不碰 REPO）。
 */
let REPO = path.resolve(path.dirname(SELF), '..', '..')
REPO = path.resolve(argOf('repo', REPO))
/**
 * 包根 = 本脚本所在的那一层（`<包根>/probes/activate-and-verify.mjs`），从**文件位置**推导。
 *
 * 与 `REPO` 分开：`REPO` 是宿主 workspace / 仓根（`.polaris` 索引、会话目录名、子进程 cwd 都靠它），
 * 包自己的文件一律走 `pkgPath(…)` —— 于是包目录叫 `aura-tools` / `aura-basetools` / 随机名都成立。
 * 旧写法是 `path.join(REPO, 'aura-tools', …)`，只在 workspace 布局成立。
 */
/**
 * 安装目录名（`<prefix>/node_modules/<PKG_NAME>`、`<prefix>/previous/<PKG_NAME>`）的**唯一来源**：
 * 安装器源码 `build/install.mjs` 的 `PKG_NAME`。这里只读源码里的那一行，不执行安装器，也不手抄第三份。
 */
const INSTALLER_SRC = pkgPath('build', 'install.mjs')
const PKG_NAME = (/^const PKG_NAME = '([^']+)'$/m.exec(fs.readFileSync(INSTALLER_SRC, 'utf8')) ?? [])[1]
if (typeof PKG_NAME !== 'string' || PKG_NAME === '') {
  say(`✗ 从 ${INSTALLER_SRC} 读不到 PKG_NAME（安装器形状变了？）`)
  process.exit(2)
}

/** 变异反证的判据名（`--mutate=<id>`）：--help 与 §2 的校验读同一份，避免两处漂。 */
const MUT_IDS = ['install-stamp', 'install-record', 'src-vs-install', 'dist-vs-install', 'artifact-sha', 'artifact-import',
  'artifact-generator', 'artifact-tokenize', 'profile-line', 'prev-stamp', 'prev-differs', 'rollback-path',
  'fixture-intact', 'home-readonly',
  'fingerprint-power', 'engine-fingerprint', 'sentinel-lost', 'hook-process', 'hook-p50', 'hook-window', 'line-apply', 'line-rollback',
  'require-observed', 'guard-verify', 'measure-lines']

const MODES = ['check', 'apply', 'rollback', 'post-restart', 'selftest']
const KNOWN = ['check', 'apply', 'rollback', 'post-restart', 'selftest', 'yes', 'json', 'deep', 'help', 'keep-tmp',
  'watch-hooks', 'run', 'mutate', 'dsh-home', 'profile', 'prefix', 'shim', 'repo', 'sessions-root', 'absent-token',
  'fixture', 'fixture-engine', 'simulate-restart', 'sentinel-index', 'sentinel-scan-window', 'sentinel-budget-mb', 'sentinel-keep',
  'shim-src']

if (has('help')) {
  say('用法: node aura-tools/probes/activate-and-verify.mjs <模式> [开关]')
  say('  模式（必选其一）: --check | --apply | --rollback | --post-restart | --selftest')
  say('  开关: [--yes] [--json] [--keep-tmp] [--run=all|id,id] [--deep] [--watch-hooks=N]')
  say('        [--mutate=<判据名>[,<判据名>…]] [--dsh-home=<dir>] [--sessions-root=<dir>]')
  say('        [--prefix=<~/.aura/pkg>] [--shim=<argv-shell.mjs>] [--shim-src=<argv-shell.mjs>]')
  say('        [--profile=<cordis.patch.yml>]  只处理这一个 profile（窄口径）；不给则扫 --dsh-home 下**所有** profile')
  say('  接线目标是**安装副本**里那份：<prefix>/node_modules/aura-tools/dsh/argv-shell.mjs（不是仓库工作区）。')
  say('        [--fixture=post-restart-ok|post-restart-bad] [--simulate-restart=<ms|ISO>]')
  say('        [--fixture-engine=<dir>]  旧壳对照根（默认仓库内冻结基准夹具 frozen-engine-0.6.1-217798da）')
  say('        [--sentinel-index=<file>] 哨兵旁路索引（默认 .polaris/activate-b4-sentinel.json；给空串 = 不读不写，退回有界窗口）')
  say('        [--sentinel-scan-window=N] [--sentinel-budget-mb=M] [--sentinel-keep=N]')
  say('                                   深扫文件数(0=不限) / 字节预算MB / 读数窗口留几发(不给=全留)')
  say('        （后四个是**合成夹具/调试**用的接缝：用了它们，结论只证明判定链会判，不是真机读数）')
  say('')
  say('  --yes 只对 --apply / --rollback 有意义：不带它一律 dry-run（只打印，不写盘）。')
  say('  变异反证：--mutate=<判据名> 把该判据的期望值故意改坏，本轮必须变红。')
  say(`  判据名: ${MUT_IDS.join(' ')}`)
  process.exit(0)
}
const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN.includes(a.replace(/^--/, '').split('=')[0]))
if (unknown.length > 0) {
  say(`用法错：未知参数 ${unknown.join(' ')}（--help 看用法）`)
  process.exit(2)
}
const MODE = MODES.find((m) => has(m)) ?? null
if (MODE === null) {
  say(`用法错：必须显式给一个模式（${MODES.map((m) => `--${m}`).join(' | ')}）—— 本脚本没有「默认动作」。`)
  process.exit(2)
}
const YES = has('yes')
const JSON_OUT = has('json')
const KEEP_TMP = has('keep-tmp')
const DEEP = has('deep')
const RUN_IDS = String(argOf('run', DEEP ? 'all' : '')).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
const WATCH_HOOKS = numOf('watch-hooks', 0)
const MUT = new Set(String(argOf('mutate', '')).split(',').map((s) => s.trim()).filter((s) => s.length > 0))
/** 合成夹具：只用于**证明重启后的判定链真会判**（真机读数一概不经过它）。 */
const FIXTURE = argOf('fixture', '')
/**
 * 「旧壳」对照根（行为指纹的旧壳那一半）。默认 = 仓库内的**冻结基准夹具**。
 * 【为什么是它】从升 0.6.2 起 previous/ 就已经是新壳了（0.6.3 换进来的 0.6.2+f089fa1d4115 同样是新壳），
 * 唯一还带旧壳的只剩这份冻结副本。
 * 注意与 `--fixture=<kind>` 区分：那个造的是**合成会话夹具**（给 --post-restart 用），这个是**换对照根**。
 */
const FIXTURE_ENGINE = path.resolve(argOf('fixture-engine', pkgPath('fixtures', 'frozen-engine-0.6.1-217798da')))

const DSH_HOME = path.resolve(argOf('dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')))
const PROFILES_DIR = path.join(DSH_HOME, 'profiles')
/**
 * `--profile=<path>` = **只处理这一个**（窄口径：测试与单点操作用）；不给就扫 `--dsh-home` 下所有 profile。
 *
 * 【为什么默认口径必须是「全部」】本机有 `web` / `headless` / `aura-exp` 三个 profile，其中**两个**带
 * `polaris-hooks-shell` 这条组。只判一个的话，另一个会**静默**留在 pwsh-local 上 —— 漏接从来不会自己报
 * （2026-10-15 实测：`headless:26` 的下一行仍是 `@deepseek-ai/dsh-pwsh-local`，而当时的口径对它一无所知）。
 */
const PROFILE_ARG = argOf('profile', '')
const PROFILE = PROFILE_ARG === '' ? path.join(PROFILES_DIR, 'web', 'cordis.patch.yml') : path.resolve(PROFILE_ARG)
const PREFIX = path.resolve(argOf('prefix', path.join(os.homedir(), '.aura', 'pkg')))
const INSTALL_DIR = path.join(PREFIX, 'node_modules', PKG_NAME)
const PREV_DIR = path.join(PREFIX, 'previous', PKG_NAME)
const STATE_FILE = path.join(PREFIX, 'install.json')
/**
 * 接线目标（`--apply` 写进 profile 的那个路径）= **安装副本**里那份。
 *
 * 【为什么不是仓库那份】profile 里那两行工具壳指的就是安装副本
 * （`<prefix>/node_modules/aura-tools/aura-read/index.js`）。指仓库工作区等于把整套东西绑在
 * 「这个仓库必须存在、必须在这个路径」上 —— 仓库被移动/改名/清理或那个文件被删，宿主下次组合
 * 就直接 import 失败。随包发货、指向安装副本，这套东西才对**整个 dsh** 成立。
 */
const SHIM = path.resolve(argOf('shim', path.join(INSTALL_DIR, 'dsh', 'argv-shell.mjs')))
/** 仓库落仓件（`--emit-shim` 的唯一真源落地处）：判据必须把**这一份**与安装副本那份分开说。 */
const SHIM_SRC = path.resolve(argOf('shim-src', pkgPath('dsh', 'argv-shell.mjs')))
/** 本轮要判的 profile 文件清单：`--profile` 给了就只这一个，否则扫 `--dsh-home/profiles/*​/cordis.patch.yml`。 */
const PROFILE_FILES = (() => {
  if (PROFILE_ARG !== '') return [PROFILE]
  let dirs = []
  try { dirs = fs.readdirSync(PROFILES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() } catch { return [] }
  return dirs.map((n) => path.join(PROFILES_DIR, n, 'cordis.patch.yml')).filter((f) => fs.existsSync(f))
})()
const profileNameOf = (file) => path.basename(path.dirname(path.resolve(file)))
let SESSIONS_ROOT = path.resolve(argOf('sessions-root', path.join(DSH_HOME, 'sessions')))
/** 时间线用的宿主启动时间：默认取真进程表；`--simulate-restart=<ms|ISO>` 只给夹具用。 */
let SIM_START = null
const ABSENT_TOKEN = argOf('absent-token', 'ZZZ_C30_ABSENT_TOKEN_ZZZ')
/** 只认这个工具名 + 参数里带哨兵串（见 sentinelCallOf）。 */
const ABSENT_TOKEN_TOOL = 'aura_read'
const SENTINEL_INDEX_DEFAULT = path.join(REPO, '.polaris', 'activate-b4-sentinel.json')
const GUARD_LOG = path.join(REPO, '.polaris', 'polaris-guard.log.jsonl')
const GUARD_PROBE = pkgPath('probes', 'hook-wiring-plan.mjs')
const EMIT_SHIM_PROBE = GUARD_PROBE
const INSTALLER = path.join(INSTALL_DIR, 'install.mjs')

// 期望值（可被 --mutate 故意改坏的都在 §2 的 E()/me() 里取值，这里只放「真值」）
//
// 【C64：落地件的字节数/sha256 不再手抄】原先这里钉了 `SHIM_SHA_EXPECT = 'bd0d68f4…'` 与
// `SHIM_BYTES_EXPECT = 8868` 两个常量，C1a 拿它们当期望。执行器（dsh/argv-shell.mjs）是**活的**：
// 2026-10-16 另一个单元把它从 8868B/bd0d68f4… 改成 13707B/df12d69b… ⇒ 这两个常量当场过期，
// C1a 会把「安装副本还是旧的那一份」和「常量本身旧了」两种完全不同的情况报成同一个红。
// （本仓因为「手抄预期值」已经咬人多次 —— 版本号、件数、差异数各一次，这次是字节数/sha。）
// 现口径：**期望从源头派生** —— 落地件有两份（仓库落仓件 SHIM_SRC 与安装副本 SHIM），
// 判据 = 「两份都在、都非空、且逐字节相同」（C1e 已经是这个命题，C1a 现在与它同源）。
// 它照样咬人：安副本那份不在/被改一字节/被换成另一版 ⇒ sha 不再等于仓库那份 ⇒ 红（同一条判据）。
const SHIM_EXPORT_EXPECT = 'ArgvShellExecutor'
/**
 * C1a/AP-pre 的**派生期望**（不手抄）：仓库落仓件那份的字节数与 sha256。
 * 只在 `art.src` 侧也读到了字节时才算得出来；读不出 ⇒ 期望为 null（判据照旧判红：另一份读不到就没法对账）。
 * @returns {{bytes: number, sha256: string}|null}
 */
function shimSourceExpectOf (art) {
  if (art?.src?.exists !== true || typeof art.src.sha256 !== 'string' || !Number.isFinite(art.src.bytes)) return null
  return { bytes: art.src.bytes, sha256: art.src.sha256 }
}
// ── 三份树的构建戳（都是按 install.mjs 的 hashTree+treeDigest 逐件重算出来的，不是抄 install.json）──
// 安装副本：宿主将要加载的那份字节（treeHash b4b7aca8…505，19 件）；2026-10-15 抬 0.6.5→0.6.6 重装到它（C63）。
// 【波15 起不再手抄版本号】安装副本与 previous/ 的**期望值**从源头读：
//   install.json.buildStamp / .previousVersion（安装器每次升级自己写）；只有状态文件缺这一格时，
//   才退到安装副本自带 package.json 里的声明。
// 「实际值」那一侧仍是 hashTree+treeDigest **逐件重算**（独立的一半）—— 判的因此是
// 「声明 vs 重算」这条不变式，而不是某个版本号：换版本它自动跟，不再每次发布手工刷常量。
// 冻结夹具仍钉死 0.6.1+…（FIXTURE_STAMP_EXPECT）：它**故意**与现版不同（唯一还带旧壳的对照基准）。
// previous/（回滚目标）：升 0.6.6 那一步把 0.6.5+56c941ddffe2 对调进来的那一份；**它已经是新壳**。
// 回滚目标的期望值不再钉死：从 install.json.previousVersion 派生（见 declaredPrevVersionOf）。
// previous/ 与安装副本的差异件数：**不再手抄**（2026-10-15 第三单：同一族预期值已咬人三次）。
//
// 历史（留档，不是为了继续手抄）：波9 时差 10 件；换 0.6.1+0d07d8b23ae3 后 4 件；
// 0.6.2 / 0.6.3 各 4 件；0.6.4 是 8 件；0.6.5 是 3 件；0.6.6 是 6 件；
// 而 0.6.8（句柄化落地）是 **8 件** —— 正是这个数把 D2 咬红了。
// 每次抬版本它都可能变，所以它根本不该是一个常量。
//
// D2 要证的命题是「previous/ 与安装副本**不同源** ⇒ 回滚真的会换掉东西」，
// 它由三条判据完全钉住，**没有一条需要知道件数**：
//   ① previous/ 的版本 == 状态文件声明的 previousVersion（declaredPrevVersionOf）；
//   ② 差异件数 > 0（同源时「回滚」等于什么都没换）；
//   ③ 差异件数 ≥ **同一对树里内容真的变了的件数**（下面就地算的 contentChanged）。
// ③ 是就地派生的，不是版本常量：它问的是「差异数有没有小得可疑 —— 小到连
// 两份树里自己哈希对不上的那些件都盖不住」。同源时它是 0（此时④由②拦），
// 互相矛盾时它 > differ（此时③独立报红）。

// 冻结基准夹具（**唯一还带旧壳的一份**）：0.6.1+217798da5117，treeHash 217798da…61a，19 件。
// 它不在升级路径上 —— 任何升级都不会碰它，所以它能当「旧壳」的稳定对照根（B3）。
const FIXTURE_STAMP_EXPECT = '0.6.1+217798da5117'
const FIXTURE_TREEHASH_EXPECT = '217798da5117394474de1cebd309bb69338b1986306720ee5c52e8e254a8f61a'
const FIXTURE_FILECOUNT_EXPECT = 19
// 夹具清单：从它自己的 JSON 读（不在夹具目录里，所以不参与树哈希），用来报「清单外的文件」。
// 读不出来就给空对象 —— 那时 B3a 会因为树哈希对不上而变红，不会静默放过。
const FIXTURE_MANIFEST_FILES = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(pkgPath('fixtures', `${path.basename(FIXTURE_ENGINE)}.json`), 'utf8'))
    return j?.files ?? {}
  } catch { return {} }
})()
const OLD_LINE = "name: '@deepseek-ai/dsh-pwsh-local'"
const NEW_LINE = `name: '${SHIM}'`
/** 曾经的（错位）接线：指向**仓库工作区**里那份。它是已知取值，不是「第三种取值」——要能被改指回来。 */
const REPO_SHIM_LINE = `name: '${SHIM_SRC}'`
const ID_LINE = '- id: polaris-hooks-shell'
/** 每个 profile 的那一行落在哪一格（`stateLabel` 是给人看的）。 */
const WIRE_LABEL = {
  wired: '已接线（安装副本）',
  unwired: '未接线（pwsh-local）',
  misrouted: '接线到仓库路径（要改指安装副本）',
  'no-group': '没有这条组',
  third: '第三种取值（不认识）',
  unreadable: '不可读',
}
const HOOK_P50_PASS = 200      // 重启后宿主侧 durationMs p50 的合格线（≈ 纯 node 启动 + 判定落账）
const HOOK_P50_RED = 450       // 越过它 = 外层壳税还在（壳税 ≈ 620ms，见头部 §口径③）
const PRE_TOOL_CITED = 686     // 任务书语料 p50（n=58,139）；本机实测值另行打印

// ═════════════════════════════════════════════════════════════════════════════
// §1 小工具
// ═════════════════════════════════════════════════════════════════════════════
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex')
const sha256buf = (b) => crypto.createHash('sha256').update(b).digest('hex')
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => (String(s).length <= n ? String(s) : `${String(s).slice(0, n)}…(+${String(s).length - n})`)
const padR = (s, n) => String(s ?? '').padEnd(n)
const padL = (s, n) => String(s ?? '').padStart(n)
const sorted = (xs) => [...xs].sort((a, b) => a - b)
/** 分位数（与原仓探针同口径：向上取整的最近秩，不插值）。 */
function pct (xs, p) {
  if (!Array.isArray(xs) || xs.length === 0) return null
  const s = sorted(xs)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}
const r1 = (v) => (v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toFixed(1))
const relRepo = (p) => (path.resolve(p).startsWith(REPO) ? path.relative(REPO, path.resolve(p)).split(path.sep).join('/') : String(p))

function readText (file) {
  try { return { ok: true, text: fs.readFileSync(file, 'utf8') } } catch (e) { return { ok: false, why: oneLine(e?.message ?? e) } }
}
function snapFile (file) {
  try {
    const b = fs.readFileSync(file)
    const st = fs.statSync(file)
    return { exists: true, bytes: b.length, sha256: sha256buf(b), mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString() }
  } catch (e) { return { exists: false, why: oneLine(e?.message ?? e) } }
}
/** 1-based 行号；找不到返回 null。 */
function lineOf (text, needle) {
  const i = text.indexOf(needle)
  return i < 0 ? null : text.slice(0, i).split('\n').length
}
function countOf (text, needle) {
  let n = 0
  let i = text.indexOf(needle)
  while (i >= 0) { n++; i = text.indexOf(needle, i + needle.length) }
  return n
}
function nthLine (text, n) { return String(text).split('\n')[n - 1] ?? null }

// ── 「--check 真的只读」的**实测**底座（C57）：跑前跑后对 ~/.aura 整棵树重算，差异件数就是 A5 的实际值 ──
/**
 * 【为什么要量它，而不是写一句「只读」】自述不是证据。2026-10-15 的单子上挂着
 * 「activate-and-verify --check 会改写 ~/.aura/observations.json」；定位结果是**不是它**
 * （写它的是独立面 CLI/MCP 的观测账本，见头部那条注释）。但「不是它」这句话本身也得有可复跑的读数撑着 ——
 * 所以这里在本进程**任何 spawn 之前**快照一次、在所有探测跑完之后再快照一次，逐件比 哈希+字节数+mtime。
 *
 * 【为什么比 mtime】内容相同但被重写（同字节覆写）也是一次写盘，只比哈希会漏掉它。
 * 【为什么不比 atime】读一次就会动它，而读正是本脚本要做的事。
 * 【为什么快照点必须在任何 spawn 之前】--check 会 spawn 子进程；若把「跑前」取在某个 spawn 之后，
 * 那个子进程的写入就会被算进「跑前」而漏掉。
 */
const AURA_HOME = path.join(os.homedir(), '.aura')
const AURA_CACHE_DIR = (process.env.AURA_CACHE_DIR ?? '').trim() === '' ? null : path.resolve(process.env.AURA_CACHE_DIR)
/** 被观测的树：`~/.aura` 整棵；`AURA_CACHE_DIR` 指到别处时把它也算上（那才是独立面真正落盘的地方）。 */
const HOME_WATCH = [...new Set([AURA_HOME, ...(AURA_CACHE_DIR === null ? [] : [AURA_CACHE_DIR])])]
function watchSnapshot () {
  const out = {}
  // 【为什么不复用 hashTree】实测：`~/.aura/pkg/node_modules/@deepseek-ai/{dsh-tools,schemastery}` 是
  // **目录联接（Junction）** —— `readdirSync(withFileTypes)` 对它们既不是 `isDirectory()`、也不能当文件读，
  // hashTree 直接抛 EISDIR；被 catch 吞掉后整棵树变成「0 件」⇒ 判据当场空过（首跑实测就是这么红的）。
  // 所以这里自带一个能认链接、能逐件降级的走查：链接只记目标、**不跟进去**（跟进去就走出了被观测的树）。
  const walk = (dir, base) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(base, full).replaceAll('\\', '/')
      let st = null
      try { st = fs.lstatSync(full) } catch { out[`${base}\u0000${rel}`] = 'gone'; continue }
      if (st.isSymbolicLink()) {
        let target = '?'
        try { target = fs.readlinkSync(full) } catch { /* 读不到目标就只记「这里有链接」 */ }
        out[`${base}\u0000${rel}`] = `symlink:${target}`
        continue
      }
      if (st.isDirectory()) { walk(full, base); continue }
      let value = 'unreadable'
      try { value = `${sha256buf(fs.readFileSync(full))}:${st.size}:${Math.round(st.mtimeMs)}` } catch (e) { value = `unreadable:${oneLine(e?.message ?? e)}` }
      out[`${base}\u0000${rel}`] = value
    }
  }
  for (const dir of HOME_WATCH) walk(dir, dir)
  return out
}
function watchDiff (before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const rows = []
  for (const n of names) {
    if (before[n] !== after[n]) rows.push({ file: n.split('\u0000').slice(1).join('\u0000'), before: before[n] ?? '(原本不存在)', after: after[n] ?? '(已被删除)' })
  }
  return rows
}
/**
 * 跑前快照：取在第一个 spawn（whichPwsh 里的 where.exe）之前。
 * `WATCH_T0` 与它同刻 —— 后面判「这次写入发生在被观测窗口内还是窗口外」用它（C72）。
 */
const WATCH_T0 = Date.now()
const HOME_WATCH_BEFORE = watchSnapshot()
/** 被观测窗口的收尾时刻（A5 注册时填） —— 只有落在 [`WATCH_T0`, `watchT1`] 内的写入才可能是本脚本写的。 */
let watchT1 = null

/**
 * 【为什么必须比 mtime 而不是只看"有没有变化"】
 *
 * 实测（2026-10-16，波C72）：本探针**跑在活宿主里**（它是宿主那个会话的子进程），而
 * `~/.aura/pkg/.cache/aura-hook-inproc.json` 是**宿主自己**的红针 —— 每一次工具调用都会写它一次。
 * 于是 A5 在本会话里必然变红：它把"宿主因为我在调用工具而写盘"算成了"本脚本写了盘"。
 * 判别两者只需一个事实：**被观测窗口的两端**。落在窗口内的写入本脚本跑不了；
 * 落在窗口**外**（快照之前就存在、或写发生在收尾之后）的那次变化，写者不可能是本脚本。
 *
 * 注意这**不是**放宽判据：窗口内的任何变化（包括计数文件被写）仍然算本脚本的账；
 * 只把"时间上不可能由本进程产生"的那些变化点出来。变异 `home-readonly` 依旧必红（它改的是期望值）。
 */
/** 本进程的祖先链（pid 集合）—— 用来判"某个写者是不是承载本次运行的活宿主"。 */
function ancestorPids () {
  const out = new Set([process.pid])
  let pid = process.ppid
  for (let i = 0; i < 12 && Number.isInteger(pid) && pid > 0; i++) {
    if (out.has(pid)) break
    out.add(pid)
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const next = Number(String(r.stdout ?? '').trim())
    if (!Number.isFinite(next) || next <= 0) break
    pid = next
  }
  return out
}

/**
 * 钩子分派计数文件：`{ inproc, spawn, pid, at }` —— 它的 `pid` 就是**写者**。
 * @returns `{ pid }` 或 null（读不出/没有 pid）
 */
function hookCounterWriter (file) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(AURA_HOME, file), 'utf8'))
    return Number.isInteger(j?.pid) ? { pid: j.pid } : null
  } catch { return null }
}

/**
 * 【为什么归因要分两类，而不是只看"变没变"】
 *
 * 实测（2026-10-16，波C72）：本探针**常跑在活宿主里**（合成/基线那几条更是 spawn 出的子进程），而
 * `~/.aura/pkg/.cache/aura-hook-inproc.json` 是**宿主自己**的红针 —— 每一次工具调用都会写它一次。
 * 于是 A5 在这种环境下必红：它把"宿主因为我在调用工具而写盘"算成了"本脚本写了盘"。
 * 归因只用两件可核的事实，**不靠猜**：
 *   ① **写者是谁**：计数文件里的 `pid` 在**本进程的祖先链**上（用 powershell 逐级取 ParentProcessId）；
 *   ② **写发生在窗口外**：文件的 mtime 早于本次快照（早于快照的写入不可能是本进程产生的）。
 * 两条都不成立的变化一律算本脚本的账 —— 窗口内、写者又不是宿主的，一条都不放过。
 * 变异 `home-readonly` 仍旧必红（它改的是期望值，与归因无关）。
 */
function attributeWatchRows (rows) {
  const ancestors = ancestorPids()
  const inside = []
  const outside = []
  for (const r of rows) {
    let mtime = null
    try { mtime = Math.round(fs.statSync(path.join(AURA_HOME, r.file)).mtimeMs) } catch { mtime = null }
    // 拿不到 mtime（被删/读不出）一律算"窗口内"——偏向严格，不借这个口子放行
    if (mtime !== null && watchT1 !== null && mtime < WATCH_T0) { outside.push({ ...r, why: '写入早于本次快照', mtime }); continue }
    const writer = hookCounterWriter(r.file)
    if (writer !== null && ancestors.has(writer.pid) && writer.pid !== process.pid) {
      outside.push({ ...r, why: `写者是承载本次运行的活宿主 pid=${writer.pid}（工具调用计数）` })
      continue
    }
    inside.push(r)
  }
  return { inside, outside }
}

function whichPwsh () {
  const r = spawnSync('where.exe', ['pwsh'], { encoding: 'utf8', windowsHide: true })
  const first = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (first && fs.existsSync(first)) return first
  for (const c of ['E:\\software\\ps7\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) {
    if (fs.existsSync(c)) return c
  }
  return null
}
const PWSH = whichPwsh()
function runPwsh (script, timeoutMs = 120000) {
  if (PWSH === null) return { status: null, stdout: '', stderr: 'pwsh 不可用' }
  return spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 26,
  })
}

// ── 暂存箱 + 写入守卫：本脚本的每一次写盘都必须落在箱里（--yes 时那一个 profile 写入除外）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'c30-activate-'))
const WRITES = []
const GUARD_HITS = []
process.on('exit', () => { if (!KEEP_TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 收不掉不影响判定 */ } } })
function tmpWrite (p, what) {
  const abs = path.resolve(p)
  if (abs !== TMP && !abs.startsWith(TMP + path.sep)) throw new Error(`写入守卫：只允许写暂存箱（${TMP}），拒绝（${what}）：${abs}`)
  WRITES.push({ path: abs, what, scope: 'tmp' })
  return abs
}
function hostWrite (p, what) {
  const abs = path.resolve(p)
  // 允许面 = **本轮扫到的那几个 profile** 与它们各自的备份：`--profile` 是窄口径，
  // 扫描口径则是「--dsh-home 下的全部」——两者都不越出这个集合，别的路径一律拒。
  const allowed = PROFILE_FILES.flatMap((f) => [f, `${f}.bak-before-argv-shell`])
  if (!YES) { GUARD_HITS.push({ path: abs, what }); throw new Error(`写入守卫：不带 --yes 时拒绝写宿主任何文件（${what}）：${abs}`) }
  if (!allowed.includes(abs)) { GUARD_HITS.push({ path: abs, what }); throw new Error(`写入守卫：--yes 也只允许写本轮扫到的 profile 与它们的备份（${what}）：${abs}`) }
  WRITES.push({ path: abs, what, scope: 'host' })
  return abs
}

// ═════════════════════════════════════════════════════════════════════════════
// §2 判据骨架 + 变异反证
// ═════════════════════════════════════════════════════════════════════════════
const CRIT = []
for (const m of MUT) {
  if (!MUT_IDS.includes(m)) {
    say(`用法错：--mutate=${m} 不是已知判据名（--help 看全表）`)
    process.exit(2)
  }
}
const isMut = (id) => MUT.has(id)
/** 期望值：变异时换成故意错的；`wrong` 给了就用它，否则用统一哨兵（保证与真值不同）。 */
const me = (id, good, wrong = '@@MUTATED@@') => (isMut(id) ? wrong : good)
/**
 * 哨兵旁路索引（C46）：路径 → 「这份会话日志里有没有那一发」+ 认账用的字节数/mtime。
 * 只记「有/没有」与认账指纹，不记正文；索引丢了/读不出 ⇔ 退化成「拿有界窗口现扫」，判定照旧、不报错。
 * `--sentinel-index=`（空串）与 `--mutate=sentinel-lost` 都把它置空 ⇒ 不读不写。
 * （定义在这里而不是 §0：它依赖 isMut，§0 阶段那个 const 还没初始化。）
 */
const SENTINEL_MUT = isMut('sentinel-lost')
const SENTINEL_INDEX = (!SENTINEL_MUT && argOf('sentinel-index', null) !== '') ? path.resolve(argOf('sentinel-index', SENTINEL_INDEX_DEFAULT)) : null
// 【扫描窗口】默认 0 = 不限个数，**只由字节预算卡**：索引把「判过」的会话记住了，所以每个文件一辈子只被深读一次，
// 每轮真实开销 = 新开的那几个（稳态 1–4 个）；只有头一轮要回填全史（本机实测 174 个文件 ≈ 4.5s）。
// 给 N>0 时才是「只深扫最新的 N 个」——N 太小就会把哨兵那一发挤出候选集，B4a 抓的就是这一格。
// ⚠ 但 B4a 的**反证**不要再靠这个窗口：它按 mtime 排，而哨兵会话的 mtime 是固定的历史时刻，
// 之后的会话越多、它掉得越靠后 —— 降到「压根没轮到」时 `allHits === 0`，B4a 会走
// 「真的还没发过」分支而**不判红**（自检报「期望被改坏却没变红」）。反证现在改用字节预算饥饿，
// 理由与实测读数写在 `SELFTEST_CASES` 那条 `sentinel-lost` 上。
// 【读数窗口】默认 -1 = 不限（扫到的全留着）；给 N(>=0) 时只留时间上最新的 N 发 —— 变异反证靠它把「扫到了」
// 与「读数窗口留了几发」分开，才证得出「存在却被挤掉」与「真的没发过」不是一回事。
// 变异那一格（--mutate=sentinel-lost）：关掉索引 + 读数窗口留 0 发 —— 深扫照样把那一发找出来，但它进不了读数窗口：
// 这才是真的「挤出窗口」（判据要能区分「找得到却丢掉」与「根本没有」）。
const keepFlag = argOf('sentinel-keep', null)
let SENTINEL_SCAN_WINDOW = numOf('sentinel-scan-window', 0)

const SENTINEL_KEEP = keepFlag !== null ? numOf('sentinel-keep', 0) : (SENTINEL_MUT ? 0 : -1)
const SENTINEL_BUDGET_MB = numOf('sentinel-budget-mb', 48)

const report = { at: new Date().toISOString(), mode: MODE, repo: REPO, node: process.version, tmp: TMP, mutations: [...MUT], crit: [], writes: WRITES, guardHits: GUARD_HITS }
function crit (id, title, { expect, actual, ok, fix = null, soft = false, note = null }) {
  const rec = { id, title, expect: String(expect), actual: String(actual), ok: !!ok, soft, note }
  if (!ok && fix !== null) rec.fix = fix
  CRIT.push(rec)
  say(` ${ok ? '✓' : (soft ? '⚠' : '✗')} ${id}  ${title}`)
  say(`      期望 : ${rec.expect}`)
  say(`      实际 : ${rec.actual}`)
  if (note !== null) say(`      说明 : ${note}`)
  if (!ok && fix !== null) say(`      修法 : ${fix}`)
  return rec.ok
}
/** 只打印读数、不判红绿的那一类（口径基线）。 */
function noted (id, title, { value, note = null }) {
  const rec = { id, title, expect: '(口径读数，无期望)', actual: String(value), ok: true, soft: true, note }
  CRIT.push(rec)
  say(` · ${id}  ${title}`)
  say(`      读数 : ${rec.actual}`)
  if (note !== null) say(`      说明 : ${note}`)
  return true
}
const reds = () => CRIT.filter((c) => !c.ok && !c.soft)
const warns = () => CRIT.filter((c) => !c.ok && c.soft)
const hr = (t) => { say(''); say('─'.repeat(78)); say(` ${t}`); say('─'.repeat(78)); say('') }

// ═════════════════════════════════════════════════════════════════════════════
// §3 只读探测件
// ═════════════════════════════════════════════════════════════════════════════

// ── 3.1 树哈希：按 build/install.mjs:1003-1010 + 1318-1323 逐字重算（不是读状态文件复述）──
function hashTree (dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) hashTree(full, base, out)
    else out[path.relative(base, full).replaceAll('\\', '/')] = sha256buf(fs.readFileSync(full))
  }
  return out
}
const treeDigest = (files) => crypto.createHash('sha256').update(Object.keys(files).sort().map((n) => `${n}\0${files[n]}\n`).join('')).digest('hex')
const buildStampOf = (version, treeHash) => `${version}+${treeHash.slice(0, 12)}`
/**
 * 安装副本的**声明**构建戳（期望值那一侧的源头；纯函数，不读盘）。
 * @returns {{stamp:string, where:string}|null} null = 状态文件与安装副本 package.json 都没声明（不判红，只如实报）
 */
function declaredBuildStampOf (state, installed) {
  for (const [where, v] of [['install.json.buildStamp', state?.buildStamp], ['安装副本 package.json 的 buildStamp', installed?.manifest?.buildStamp]]) {
    if (typeof v === 'string' && v.trim() !== '') return { stamp: v.trim(), where }
  }
  return null
}
/** 安装副本声明的**版本**（退路：package.json.version 是引擎自带的版本位点）：允许与构建戳不同源。 */
function declaredVersionOf (state, installed) {
  for (const [where, v] of [['install.json.version', state?.version], ['安装副本 package.json 的 version', installed?.manifest?.version]]) {
    if (typeof v === 'string' && v.trim() !== '') return { version: v.trim(), where }
  }
  return null
}
/**
 * previous/（回滚目标）声明的**版本**：期望值从 install.json.previousVersion 派生 ——
 * 「安装器把升级前那一份对调进 previous/」这条不变式里，能声明出来的就只有版本段。
 * 退路：previous/ 自带 package.json 的 version（两份都有、又不相等时，下面会当分歧当场点名）。
 */
function declaredPrevVersionOf (state, prev) {
  if (prev.ok !== true && prev.manifest === null) return null
  const declared = typeof state?.previousVersion === 'string' && state.previousVersion.trim() !== '' ? state.previousVersion.trim() : null
  const selfReport = typeof prev?.manifest?.version === 'string' && prev.manifest.version.trim() !== '' ? prev.manifest.version.trim() : null
  if (declared !== null) return { version: declared, source: 'install.json.previousVersion', selfReport, selfReportAgrees: selfReport === declared }
  if (selfReport !== null) return { version: selfReport, source: 'previous/package.json 的 version（状态文件未声明 previousVersion）', selfReport, selfReportAgrees: true }
  return null
}
/** previous/ 的**实测**戳串（版本段 + 重算树哈希前 12 位；不抄任何版本号）。 */
function prevStampOf (prev) {
  if (prev.ok !== true) return '(previous/ 读不出)'
  return `${prev.version ?? '?'}+${String(prev.treeHash).slice(0, 12)}`
}
/**
 * 只给**模块加载期**的说明文字用（段F 的外部件清单）：单独读一次 install.json 拿声明的回滚目标版本。
 * 【为什么不能直接用 collect() 的结果】那些常量在模块加载时就求值，那时 BASE 还没采集；
 * 这里只读一个 JSON、不碰磁盘上的树，不引入任何写路径。
 */
function declaredPrevVersionNow () {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return typeof s?.previousVersion === 'string' && s.previousVersion.trim() !== '' ? s.previousVersion.trim() : '(状态文件未声明 previousVersion)'
  } catch { return '(install.json 读不出)' }
}
function treeInfoOf (dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const files = hashTree(dir)
    const treeHash = treeDigest(files)
    // manifest 一并带出去：期望值要能从「安装副本自己的 package.json」读声明（波15）
    return { ok: true, dir, manifest, version: manifest.version, name: manifest.name, files, treeHash, buildStamp: buildStampOf(manifest.version, treeHash) }
  } catch (e) { return { ok: false, dir, manifest: null, why: oneLine(e?.message ?? e) } }
}

// ── 3.2 源树 → 安装副本的映射表（make-bundle 的四张表里「与源树同名同内容」的那些件）──
// 【这不是件数，是**名单**】判据是「名单里每一项都在包里、且逐字节相同」（缺一件/差一字节即红），
// 不是「一共 N 件」：件数随包长大而变，名单只需要在**加了新件**时跟着加一行。
// 所以新增的 `dsh/argv-shell.mjs`（钩子执行器）必须在这里有名字 —— 没有名字的件对「改了源没重建」是瞎的。
const SRC_TO_PACK = [
  'dsh/argv-shell.mjs',
  'aura-read/index.js',
  'aura-edit/index.js',
  'locator-lab/anchor-core.mjs',
  'locator-lab/args.mjs',
  'locator-lab/locator-api.mjs',
  'locator-lab/read-core.mjs',
  'locator-lab/repo-map.mjs',
  'locator-lab/struct-core.mjs',
  'locator-lab/write-path.mjs',
  'aura-standalone/bin/aura.mjs',
  'aura-standalone/bin/aura-mcp.mjs',
  'aura-standalone/lib/ops.mjs',
  'aura-standalone/lib/fs-provider.mjs',
  'aura-standalone/lib/observation-store.mjs',
  'aura-standalone/test/standalone-test.mjs',
]
/** src 侧相对路径 → 安装副本侧相对路径（standalone 三目录改名、installer 提到包根）。 */
function packPathOf (rel) {
  if (rel.startsWith('aura-standalone/')) return rel.slice('aura-standalone/'.length)
  if (rel === 'build/install.mjs') return 'install.mjs'
  return rel
}

// ── 3.3 profile：把「那一行」定位成 (id 行号, name 行号, 当前值)，而不是盲目全局替换 ──
/**
 * 一行 profile 里那个模块引用（`name:` 后面那个路径）—— 钩子组的**执行器**就在这一行上。
 * 【为什么单独抠出来】`polaris-hooks-shell` 这一组的值就是「谁来承载钩子命令串」的答案：
 *   指到 `argv-shell.mjs` ⇒ 命令串被 tokenize 成 argv 直投（链上没有 pwsh）；
 *   还是 `@deepseek-ai/dsh-pwsh-local`（或任何别的模块名）⇒ 仍然经 pwsh -Command。
 * 拿不到这一行就返回 null —— **不猜**。
 * @returns {{raw: string, base: string, file: string|null}|null}
 */
function executorRefIn (line) {
  if (line === null || line === undefined) return null
  const s = String(line).trim()
  if (s === '') return null
  const quoted = s.match(/(['"])(.+?)\1/)   // YAML 的单/双引号写法（本机那两个 profile 都是 `name: '…'`）
  const raw = quoted !== null ? quoted[2].trim() : (s.match(/name:\s*(.+)$/) ?? [null, s])[1].trim()
  if (raw === '') return null
  const base = path.basename(raw).toLowerCase()
  let file = null
  try { file = fs.existsSync(raw) } catch { file = null }
  return { raw, base, file }
}
function readProfile (file) {
  const profile = profileNameOf(file)
  const raw = readText(file)
const bad = (why) => ({ ok: false, file, profile, why, state: 'unreadable', stateLabel: WIRE_LABEL.unreadable, hasGroup: false, wired: false, text: null, nameLine: null, nameLineNo: null, idCount: 0, executor: null })
  if (!raw.ok) return bad(raw.why)
  const text = raw.text
  const buf = fs.readFileSync(file)
  const idCount = countOf(text, ID_LINE)
  const idLineNo = lineOf(text, ID_LINE)
  const nameLineNo = idLineNo === null ? null : idLineNo + 1
  const nameLine = nameLineNo === null ? null : nthLine(text, nameLineNo)
  const cur = nameLine === null ? null : nameLine.trim()
  const hasGroup = idCount > 0
  // 逐格判：**没有这条组**的 profile 不该被算作「未接线」（它压根不该有这一行）
  const state = !hasGroup ? 'no-group'
    : cur === OLD_LINE.trim() ? 'unwired'
      : cur === NEW_LINE.trim() ? 'wired'
        : /argv-shell\.mjs/.test(String(cur)) ? 'misrouted'
          : 'third'
  return {
    ok: true, file, profile, text, bytes: buf.length, sha256: sha256buf(buf),
    idCount, idLineNo, nameLineNo, nameLine, cur, hasGroup, state, stateLabel: WIRE_LABEL[state],
    wired: state === 'wired',
    // 钩子组**执行器**那一行的解析结果（见 executorRefIn）：谁承载钩子命令串就由它决定，
    // 与「装了哪一版包」无关 —— C4 的期望从这里派生。
    executor: executorRefIn(nameLine),
    oldCount: countOf(text, OLD_LINE), newCount: countOf(text, NEW_LINE),
    crlf: (text.match(/\r\n/g) ?? []).length, lf: (text.match(/(?<!\r)\n/g) ?? []).length,
    bom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    endsWithNewline: text.endsWith('\n'), mtimeMs: fs.statSync(file).mtimeMs,
  }
}

// ── 3.4 落地件冒烟：存在 + 语法 + **真 import** + tokenize + 与生成器逐字节一致 ──
function artifactSmoke () {
  const st = snapFile(SHIM)
  const src = snapFile(SHIM_SRC)
  const out = { stat: st, src, syntax: null, import: null, tokenize: null, generator: null }
  if (!st.exists) return out
  const chk = spawnSync(process.execPath, ['--check', SHIM], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  out.syntax = { exit: chk.status, stderr: oneLine(chk.stderr) }
  const childSrc = [
    "import { pathToFileURL } from 'node:url'",
    `const m = await import(pathToFileURL(${JSON.stringify(SHIM)}).href)`,
    "const argv = typeof m.tokenizeArgv === 'function'",
    "  ? m.tokenizeArgv('node \"C:/Users/cxk/.dsh/skills/aurapolaris/tools/hook.mjs\" --event=PreToolUse --host=dsh --state=workspace')",
    '  : null',
    "process.stdout.write(JSON.stringify({ defaultName: m.default?.name ?? null, exports: Object.keys(m).sort(), argv }))",
  ].join('\n')
  const childFile = tmpWrite(path.join(TMP, 'artifact-import.mjs'), '落地件 import 冒烟子进程')
  fs.writeFileSync(childFile, childSrc)
  const r = spawnSync(process.execPath, [childFile], { encoding: 'utf8', windowsHide: true, timeout: 60000, cwd: REPO })
  if (r.status === 0) {
    try { out.import = JSON.parse(r.stdout) } catch (e) { out.import = { parseError: oneLine(e?.message ?? e), raw: clip(r.stdout, 200) } }
  } else {
    out.import = { error: clip(oneLine(r.stderr), 300) }
  }
  if (out.import?.argv !== undefined && out.import?.argv !== null) out.tokenize = out.import.argv
  // 与生成它的探针 --emit-shim 的输出逐字节比：**安装副本那份**与**仓库落仓件那份**都要对上
  const gen = spawnSync(process.execPath, [EMIT_SHIM_PROBE, '--emit-shim'], { encoding: 'buffer', windowsHide: true, timeout: 120000, maxBuffer: 1 << 26 })
  if (gen.status === 0) {
    const a = sha256buf(gen.stdout)
    const b = sha256buf(fs.readFileSync(SHIM))
    const c = src.exists ? sha256buf(fs.readFileSync(SHIM_SRC)) : null
    const cPath = tmpWrite(path.join(TMP, 'emit-shim.mjs'), '--emit-shim 输出落盘（比对用）')
    fs.writeFileSync(cPath, gen.stdout)
    out.generator = { exit: 0, bytes: gen.stdout.length, sha256: a, same: a === b, sameSrc: c !== null && a === c, srcSha: c }
  } else {
    out.generator = { exit: gen.status, error: clip(oneLine(gen.stderr), 300) }
  }
  return out
}

// ── 3.5 进程表：只读枚举（宿主定位 + 钩子进程形状采样）──
const PROC_PS = [
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '  [pscustomobject]@{',
  '    pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name;',
  '    startMs=[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();',
  '    cmd=[string]$_.CommandLine } } | ConvertTo-Json -Compress -Depth 3',
].join('\n')
function processTable () {
  const r = runPwsh(PROC_PS, 120000)
  if (r.status !== 0) return { ok: false, why: clip(oneLine(r.stderr), 200), rows: [] }
  let j = null
  try { j = JSON.parse(r.stdout) } catch (e) { return { ok: false, why: `ConvertTo-Json 解析失败：${oneLine(e?.message ?? e)}`, rows: [] } }
  const rows = (Array.isArray(j) ? j : [j]).filter((x) => x && typeof x.pid === 'number')
  return { ok: true, rows }
}
const DSH_HOST_RE = /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i
/** 宿主定位：先走本进程的祖先链（本脚本通常由宿主的工具调用 spawn），再退回全表扫。 */
function findHost (table) {
  const byId = new Map(table.rows.map((r) => [r.pid, r]))
  const chain = []
  let cur = process.pid
  const seen = new Set()
  while (cur !== undefined && cur !== null && cur !== 0 && !seen.has(cur)) {
    seen.add(cur)
    const row = byId.get(cur)
    if (row === undefined) break
    chain.push(row)
    cur = row.ppid
  }
  const inChain = chain.find((r) => DSH_HOST_RE.test(String(r.cmd ?? '')))
  if (inChain !== undefined) return { how: '祖先链（本进程 → …）', host: inChain, chain }
  const scanned = table.rows.filter((r) => DSH_HOST_RE.test(String(r.cmd ?? ''))).sort((a, b) => a.startMs - b.startMs)
  if (scanned.length > 0) return { how: '全表扫（cmd 匹配 dsh/lib/bin.js）', host: scanned[0], chain, candidates: scanned.length }
  return { how: '找不到', host: null, chain }
}

// ── 3.6 钩子进程形状采样：抓「谁在承载 hook.mjs」= pwsh（旧路）还是 node（直投 argv）──
/**
 * 进程表采样脚本。
 *
 * 【为什么要 -Entries 这组路径】只看 `hook.mjs` 会把**别人的钩子**也算进来：实测本机同时跑着
 * `E:\workspaces\AuraPolaris\skills\...\hook.mjs`（另一个 agent 的 guard-test 直接用 node spawn 的），
 * 那个形状恰好是「node 的父进程是 node」，会被误判成「argv 直投已生效」。
 * 所以判据取**宿主自己 hooks.json 里那几条命令的入口路径**（本探针从 <DSH_HOME>/aurapolaris-hooks.json
 * 现读，四个事件各一条），只有命令行里真含这些入口的进程才算宿主的钩子调用。
 * 【为什么是一个数组】原先只取 PreToolUse 那一条，于是同一份 hooks.json 里 SessionStart/Stop 的
 * 钩子调用一概漏掉（采样窗口里只有那两类事件时就报「未观测」）—— 入口本来就是「同一份配置的几条命令」。
 */
const WATCH_PS = [
  'param([int]$Seconds = 15, [int]$IntervalMs = 150, [string]$Entries = \'[]\')',
  '# $Entries = 宿主钩子入口路径的 JSON 数组（本探针从 <DSH_HOME>/aurapolaris-hooks.json 现读，',
  '# 调用点见 hostHookEntry）。空数组 = 一个入口都读不出 ⇒ 本轮不猜、采样不命中。',
  '$needles = @()',
  'try { $needles = @((ConvertFrom-Json -InputObject $Entries) | ForEach-Object { ([string]$_).Replace("\\", "/").ToLower() } | Where-Object { $_ -ne \'\' }) } catch { $needles = @() }',
  '$deadline = (Get-Date).AddSeconds($Seconds)',
  '$seen = @{}',
  'while ((Get-Date) -lt $deadline) {',
  '  try { $procs = Get-CimInstance Win32_Process -ErrorAction Stop } catch { Start-Sleep -Milliseconds 250; continue }',
  '  $byId = @{}; foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }',
  '  foreach ($p in $procs) {',
  '    $c = [string]$p.CommandLine',
  '    if ($c -eq \'\') { continue }',
  '    $norm = $c.Replace("\\", "/").ToLower()',
  '    $hit = $false',
  '    foreach ($n in $needles) { if ($norm.Contains($n)) { $hit = $true; break } }',
  '    if (-not $hit) { continue }',
  '    # 排除本探针自己与采样脚本自己：它们的命令行里也会出现入口路径（-Entries 那个字符串）。',
  '    if ($norm.Contains(\'activate-and-verify\') -or $norm.Contains(\'watch-hooks.ps1\') -or $norm.Contains(\'needle-compare\')) { continue }',
  '    $k = "$($p.ProcessId)"',
  '    if ($seen.ContainsKey($k)) { continue }',
  '    $par = if ($byId.ContainsKey([int]$p.ParentProcessId)) { $byId[[int]$p.ParentProcessId] } else { $null }',
  '    $pn = if ($par -ne $null) { [string]$par.Name } else { \'\' }',
  '    $pc = if ($par -ne $null) { [string]$par.CommandLine } else { \'\' }',
  '    $seen[$k] = [pscustomobject]@{ pid=[int]$p.ProcessId; name=[string]$p.Name; ppid=[int]$p.ParentProcessId; parentName=$pn; parentCmd=$pc.Substring(0,[Math]::Min(160,$pc.Length)); cmd=$c }',
  '  }',
  '  Start-Sleep -Milliseconds $IntervalMs',
  '}',
  'ConvertTo-Json -Compress -Depth 3 -InputObject @($seen.Values)',
].join('\n')
/**
 * 从一份 hooks 配置里抠出**每条钩子命令的入口脚本路径**（去重、保序）。
 * 入口 = 命令串里第一个带脚本扩展名的 token（`node "…/hook.mjs" …` ⇒ `…/hook.mjs`）。
 * 四个事件（PreToolUse/SessionStart/UserPromptSubmit/Stop）逐条取 —— 它们本来就是同一份配置的几条命令。
 * @returns {string[]}
 */
function hookEntryPathsIn (text) {
  const out = []
  try {
    const j = JSON.parse(text)
    for (const groups of Object.values(j?.hooks ?? {})) {
      if (!Array.isArray(groups)) continue
      for (const g of groups) {
        for (const h of (Array.isArray(g?.hooks) ? g.hooks : [])) {
          const m = String(h?.command ?? '').match(/[^\s"']+\.(?:mjs|js|cjs)/i)
          if (m !== null && !out.includes(m[0])) out.push(m[0])
        }
      }
    }
  } catch { /* 解析失败 = 一个入口都没有，由调用方如实报 */ }
  return out
}
/**
 * 宿主钩子入口（**采样针**）：从 <DSH_HOME>/aurapolaris-hooks.json 现读每条钩子命令的入口路径。
 *
 * 【为什么不回落成 `--host=dsh`】那个片段**过宽**：它只是钩子命令末尾的一个普通开关，
 * 凡是用同一套模板接线的钩子（别的仓库、别人的 guard-test）命令行里都有它 ⇒ 采样会把
 * **别人的钩子进程**当成宿主的读数。读不出 hooks.json 时**一个入口都不给**（采样不命中、如实报未观测）
 * —— 「没有可信的针」不该用一根会误伤的针顶替。
 */
function hostHookEntry () {
  const cfg = readText(path.join(DSH_HOME, 'aurapolaris-hooks.json'))
  if (!cfg.ok) return { entries: [], entry: null, source: `hooks.json 读不出（${cfg.why}）⇒ 本轮不给采样针（不拿过宽的回落常量顶替）` }
  const entries = hookEntryPathsIn(cfg.text)
  if (entries.length === 0) return { entries: [], entry: null, source: 'hooks.json 里没找到任何钩子入口（命令串里没有 .mjs/.js 路径）' }
  const which = hookEventsWithEntryIn(cfg.text)
  return { entries, entry: entries[0], source: `hooks.json 的钩子命令入口 ${entries.length} 条${which.length > 0 ? `（事件：${which.join('/')}）` : ''}` }
}
/**
 * 同一份 hooks 配置里「哪些事件那条命令抠得出入口」—— 只用于把采样针的来源说清楚（PreToolUse/…）。
 * @returns {string[]}
 */
function hookEventsWithEntryIn (text) {
  const out = []
  try {
    const j = JSON.parse(text)
    for (const [ev, groups] of Object.entries(j?.hooks ?? {})) {
      if (Array.isArray(groups) && hookEntryPathsIn(JSON.stringify({ hooks: { [ev]: groups } })).length > 0) out.push(ev)
    }
  } catch { /* 解析失败已在 hookEntryPathsIn 那边担过 */ }
  return out
}
/**
 * 分类一条观测：谁在承载钩子。
 *   旧路（pwsh-local）：① pwsh.exe 的命令行里带 hook.mjs；② 钩子本体 node 的父进程 = pwsh.exe；
 *                        ③ dsh-subprocess-local 的 runner.js 命令行里 `-- pwsh.exe … hook.mjs …`。
 *   新路（argv 直投）：钩子 node 由宿主（经 runner）直接 spawn ⇒ 父进程是 node；runner.js 里 `-- node … hook.mjs …`。
 */
function classifyHookProc (row) {
  const cmd = String(row.cmd ?? '')
  const name = String(row.name ?? '').toLowerCase()
  if (name === 'pwsh.exe' || name === 'powershell.exe') return { kind: 'shell-carrier', verdict: 'old', why: '钩子命令串被 pwsh 承载（-Command）' }
  if (/runner\.js/i.test(cmd)) {
    const m = cmd.match(/runner\.js\s+--\s+"?([^\s"]+)/i)
    const prog = m === null ? '' : path.basename(m[1]).toLowerCase()
    if (prog.startsWith('pwsh') || prog.startsWith('powershell')) return { kind: 'runner-wrapper', verdict: 'old', why: `runner.js 直投给 ${prog}` }
    if (prog.startsWith('node')) return { kind: 'runner-wrapper', verdict: 'new', why: `runner.js 直投给 ${prog}` }
    return { kind: 'runner-wrapper', verdict: 'unknown', why: `runner.js 直投给 ${prog || '(认不出)'}` }
  }
  const parent = String(row.parentName ?? '').toLowerCase()
  if (parent === 'pwsh.exe' || parent === 'powershell.exe') return { kind: 'hook-child', verdict: 'old', why: '钩子 node 的父进程是 pwsh.exe' }
  if (parent === 'node.exe') return { kind: 'hook-child', verdict: 'new', why: '钩子 node 的父进程是 node（宿主直接 spawn）' }
  return { kind: 'hook-child', verdict: 'unknown', why: `父进程 ${parent || '(未知)'}` }
}
/**
 * 一次采样的**读数**（纯计算，只吃已抓到的观测 —— 不再读盘、不再采样，供 C4/P2 共用）：
 *   verdict   = 「谁在承载 hook.mjs」的实测形状：old（pwsh 链）/ new（argv 直投）/ unknown（认不出）；
 *               旧路压过新路：抓到一个 pwsh 承载就是旧路还在（同一个窗口里两种都出现 = 还没换干净）。
 *   observed  = 这一轮到底抓没抓到可判形状的钩子进程（没抓到 ⇒ 本轮没有读数）。
 * 【为什么把这一段抠出来】原先 C4 与 P2 各写一遍同一套 old/new 统计，两处 observed 口径还不一样
 *   （P2 要求形状可判、C4 只要求抓到）—— 同一个采样能在两个判据里给出不同读数。
 * @returns {{obs: object[], oldN: number, newN: number, unknownN: number, verdict: string, observed: boolean}}
 */
function carrierReadingOf (w) {
  const obs = (w !== undefined && w !== null && Array.isArray(w.obs)) ? w.obs : []
  const oldN = obs.filter((o) => o.verdict === 'old').length
  const newN = obs.filter((o) => o.verdict === 'new').length
  const unknownN = obs.length - oldN - newN
  return {
    obs, oldN, newN, unknownN,
    verdict: !w?.ok ? '采样失败' : obs.length === 0 ? '未观测（窗口里没有钩子进程）' : oldN > 0 ? 'old' : newN > 0 ? 'new' : 'unknown',
    observed: w?.ok === true && oldN + newN > 0,
  }
}
function watchHooks (seconds) {
  const ps1 = tmpWrite(path.join(TMP, 'watch-hooks.ps1'), '进程表采样脚本')
  fs.writeFileSync(ps1, WATCH_PS, 'utf8')
  const entry = hostHookEntry()
  if (PWSH === null) return { ok: false, why: 'pwsh 不可用', seconds, obs: [], entry }
  const r = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', ps1, '-Seconds', String(seconds), '-IntervalMs', '150', '-Entries', JSON.stringify(entry.entries ?? [])], {
    encoding: 'utf8', windowsHide: true, timeout: (seconds + 30) * 1000, maxBuffer: 1 << 26,
  })
  if (r.status !== 0) return { ok: false, why: clip(oneLine(r.stderr), 200), seconds, obs: [], entry }
  let j = null
  try { j = r.stdout.trim() === '' ? [] : JSON.parse(r.stdout) } catch (e) { return { ok: false, why: `采样输出解析失败：${oneLine(e?.message ?? e)}`, seconds, obs: [], entry } }
  const rows = (Array.isArray(j) ? j : [j]).filter((x) => x && typeof x.pid === 'number')
  const obs = rows.map((row) => ({ ...row, ...classifyHookProc(row) }))
  return { ok: true, seconds, obs, entry, reading: carrierReadingOf({ ok: true, obs }) }
}

// ── 3.7 会话日志：一次遍历回收两条线（引擎侧回执形状 + 宿主侧钩子墙钟）──
const ZMAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function frameOffsets (buf) {
  const offs = []
  let i = 0
  for (;;) { const q = buf.indexOf(ZMAGIC, i); if (q < 0) break; offs.push(q); i = q + 4 }
  return offs
}
function walkSessionFiles (dir, depth = 0, out = []) {
  if (depth > 5) return out
  let es = []
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of es) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkSessionFiles(p, depth + 1, out)
    else if (e.name === 'session.v3.jsonl.zstd') out.push(p)
  }
  return out
}
const sessionDirOf = (repo) => path.join(SESSIONS_ROOT, `--${repo.replace(/[:\\/]+/g, '-')}--`)
function textOfParts (parts) {
  const one = (p) => [typeof p?.text === 'string' ? p.text : '',
    ...(Array.isArray(p?.content) ? p.content.map((i) => (typeof i?.text === 'string' ? i.text : '')) : [])].filter((t) => t.length > 0).join('\n')
  return (parts ?? []).map(one).filter((t) => t.length > 0).join('\n')
}
/**
 * 一行会话事件里跟指纹/墙钟有关的那几个字段（readSessions 与 sentinelCensus **共用同一份解析**：
 * 两处各写一份的话，B4 读出来的东西就可能跟 E1 的墙钟口径不一）。
 * 只认三种 type；其余一律 null（返回体里的 kind 就是「这行是什么」）。
 */
function callFieldsOf (line) {
  if (!line.startsWith('{')) return null
  if (!line.includes('"tool/') && !line.includes('"hook/result"')) return null
  let j = null
  try { j = JSON.parse(line) } catch { return null }
  if (j.type === 'hook/result') {
    const d = j.data ?? {}
    const ms = typeof d.durationMs === 'number' && Number.isFinite(d.durationMs) ? d.durationMs : null
    return { kind: 'hook', time: typeof j.time === 'number' ? j.time : null, point: d.point ?? null, ms, decision: d.decision ?? null, handlerId: d.handlerId ?? null }
  }
  if (j.type === 'tool/call') {
    const name = j.data?.name
    const id = j.data?.callId
    if (typeof name !== 'string' || typeof id !== 'string') return null
    return { kind: 'call', id, name, argsText: typeof j.data?.arguments === 'string' ? j.data.arguments : JSON.stringify(j.data?.arguments ?? null), time: typeof j.time === 'number' ? j.time : null }
  }
  if (j.type === 'tool/result') {
    const id = j.data?.message?.source?.callId
    if (typeof id !== 'string') return null
    const parts = j.data?.message?.content ?? []
    const isError = parts.some((p) => p?.isError === true)
    return { kind: 'result', id, isError, text: textOfParts(parts), time: typeof j.time === 'number' ? j.time : null }
  }
  return null
}
/**
 * C46 的唯一性约束（与旧实现逐字等价）：
 * 哨兵串会被写进**别的**调用的参数里（写本探针那一发就带着它），所以只认 `name === 'aura_read'`
 * 且**参数里带哨兵串**的那一发 —— 不筛工具名会抓到假阳性。两个分支（readSessions / 全史普查）共用它。
 */
const sentinelCallOf = (c) => c.name === ABSENT_TOKEN_TOOL && c.argsText.includes(ABSENT_TOKEN)
/** 回执形状判定：旧壳把 READ_* 抛成异常 ⇒ DSH 标 isError=true 且正文 `Error: CODE: …`；新壳走正常结果 ⇒ 正文 `Error (CODE): …`。 */
function shapeOfReceipt ({ isError, text }) {
  const t = String(text ?? '')
  if (isError === true && /^Error:\s*[A-Z0-9_]+:/.test(t)) return 'old'
  if (isError === false && /^Error\s*\([A-Z0-9_]+\)/.test(t)) return 'new'
  return 'unknown'
}
// maxFiles=32（原为 6）：标记串那一发可能落在最近几个会话文件之外 —— 2026-10-14 实测它排在第 30 位
// （那一发在 16:15:23，之后又开了 29 个会话）。扫描是「按 mtime 倒序 + 扫到标记就停」，
// 所以找得到时不会多花时间，找不到时才扫满这 32 个（再用 48MB 预算卡一道：实测前 32 个合计约 17MB）。
function readSessions ({ sinceMs = 0, budgetMB = 48, maxFiles = 32, wantMarker = null }) {
  const dir = sessionDirOf(REPO)
  // hooksBeforeWindow / hooksNoTime 是 C58 的窗口对账格：窗口内收了几条、窗口外剔了几条必须能自报 ——
  // 这次的事故正是「窗口不对，但读数看着像结论」，没有这两个计数就无从当场发现。
  const out = { dir, exists: fs.existsSync(dir), files: [], scanned: [], calls: [], failures: [], hooks: [], marker: null, notes: [], hooksBeforeWindow: 0, hooksNoTime: 0 }
  if (!out.exists) { out.notes.push(`会话目录不存在：${dir}（宿主可能不在本机跑 / 换过 DSH_HOME）`); return out }
  const all = walkSessionFiles(dir).map((f) => ({ f, st: fs.statSync(f) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  out.files = all.length
  let budget = budgetMB * 1024 * 1024
  const chosen = []
  for (const x of all) {
    if (chosen.length >= maxFiles) break
    if (sinceMs > 0 && x.st.mtimeMs < sinceMs) continue
    if (budget - x.st.size < 0) continue
    budget -= x.st.size
    chosen.push(x)
  }
  // 「标记串那一发」的唯一性要求**全史**去找：它可能远早于最近几个会话文件。
  // 所以扫到它就可以停：chosen 是按 mtime 倒序的，第一个找到的就是时间上最新的那一发（停在哪记进 notes）。
  let stopScan = null
  out.cappedBy = chosen.length < all.length ? 'maxFiles/预算' : null
  const byId = new Map()
  for (const x of chosen) {
    if (wantMarker !== null && out.marker !== null) { stopScan = '已找到标记串那一发'; break }
    out.scanned.push({ file: path.basename(path.dirname(x.f)), mb: Math.round((x.st.size / 1048576) * 100) / 100, mtime: x.st.mtime.toISOString() })
    let buf = null
    try { buf = fs.readFileSync(x.f) } catch { continue }
    const offs = frameOffsets(buf)
    for (let k = 0; k < offs.length; k++) {
      const end = k + 1 < offs.length ? offs[k + 1] : buf.length
      let text = ''
      try { text = zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue
        const f = callFieldsOf(line)
        if (f === null) continue
        if (f.kind === 'hook') {
          // 【C58 修的窗口缺陷 —— 就是这一格】原先这里**只有文件级 mtime 过滤（上面 chosen 的 sinceMs 那一步），
          //   没有按事件时间过滤**：sinceMs 在 readSessions 里只生效过两处 —— ① 按文件 mtime 跳文件；
          //   ② 下面 tool/result 那一支的 `rec.time < sinceMs`。hook/result 这一支直接 push ⇒
          //   所谓的「重启后窗口」实际装的是「这些文件里的**全部历史**钩子」。
          //   2026-10-15 实测：n=1062 p50=658.6ms（看着像壳税还在 ⇒ 硬红），而真落在窗口内的只有 ~20 条
          //   p50=230.7ms（警告档）。两组数出自同一份会话文件 ⇒ 这是量具缺陷，不是钩子没生效。
          // 【为什么 mtime 与 event.time 两者都要】mtime 只够做**便宜的文件级跳过**（文件最后一次写早于
          //   宿主启动，里面不可能有窗口内事件）；窗口的**准确定义**只能比事件自己的 `f.time`——
          //   同一份文件横跨重启（宿主正在写的这一份就是），只按 mtime 筛必然把它整份算进来。
          //   `f.time` 与 hostStartMs 同源：callFieldsOf 的 hook 分支取的是 `typeof j.time === 'number'`
          //   （会话里就是数字毫秒，例如 "time":1791893314658），没有任何一处按字符串读它。
          if (f.point === 'PreToolUse' && f.ms !== null) {
            if (sinceMs > 0 && f.time === null) { out.hooksNoTime += 1; continue }
            if (sinceMs > 0 && f.time < sinceMs) { out.hooksBeforeWindow += 1; continue }
            out.hooks.push({ time: f.time, ms: f.ms, decision: f.decision, handlerId: f.handlerId })
          }
          continue
        }
        if (f.kind === 'call') { byId.set(f.id, { name: f.name, argsText: f.argsText, time: f.time }); continue }
        const call = byId.get(f.id)
        if (call === undefined) continue
        const rec = { time: call.time, name: call.name, argsText: call.argsText, isError: f.isError, text: f.text, shape: shapeOfReceipt({ isError: f.isError, text: f.text }) }
        if (sinceMs > 0 && (rec.time === null || rec.time < sinceMs)) continue
        out.calls.push(rec)
        if (/^Error/.test(f.text) || f.isError) out.failures.push(rec)
        // wantMarker 那条路（标注串那一发）C46 已搬到 sentinelCensus 的旁路索引里，不再靠这个窗口逮它；
        // 这里保留的是「E1 墙钟 + 近期失败清单」那两条线。
        if (wantMarker !== null && sentinelCallOf(call) && (out.marker === null || (rec.time ?? 0) > (out.marker.time ?? 0))) out.marker = rec
      }
    }
  }
  if (stopScan !== null) out.notes.push(`${stopScan}（扫了 ${out.scanned.length} 个会话文件就停；共 ${out.files} 个）`)
  else if (wantMarker !== null && out.marker === null && out.scanned.length < out.files) {
    out.notes.push(`扫了 ${out.scanned.length}/${out.files} 个会话文件（受 maxFiles=${maxFiles} 与 ${budgetMB}MB 预算限制），没找到带标记串的那一发`)
  }
  // 按事件时间排序：engineReadingOf 取「最近一次」靠它，不靠扫描顺序
  const byTime = (a, b) => (a.time ?? 0) - (b.time ?? 0)
  out.calls.sort(byTime)
  out.failures.sort(byTime)
  out.hooks.sort(byTime)
  return out
}

// ── 3.7b 哨兵那一发的**不随会话数退化**的定位（C46）：旁路索引 + 有界增量深扫 ──
//
// 【这一格在修什么】旧路是「按 mtime 倒序取前 32 个会话文件、扫到哨兵就停」。32 是绝对数：
//   每新开一个会话，哨兵那一发就上顶一格 —— 2026-10-15 实测它已经掉到 32 名之外，B4 当场变成「未观测」。
// 【索引认账靠什么】不是靠「解析过就算数」，而是靠**会话文件自己的字节数与 mtime**（两者任一变了就重扫）。
//   所以索引写坏/写旧都不会把一份含哨兵的会话误判成「没有」：mtime 一变就重扫。
// 【索引丢了怎么办】不报错：退回「有界窗口现扫一遍」，并把「没读到的」如实计入 unproven（不当「不存在」用）。
// 【为什么不做「只读文件头」的便宜全扫】实测：哨兵串在压过的原始字节里 0/8 命中（zstd 帧只有 176–233 字节，
//   哨兵落第 11–842 帧），所以文件头探测恒假阴性 —— 它只能当「便宜兜底」，绝不能当「宿主没发过」的证据。
//   本轮保留它只用在一个地方：把**从未判过的老会话**排在回填队列前面（多一个候选，不影响已判结论）。
const SENTINEL_INDEX_HEAD = 24     // 索引里最多记多少份「含哨兵」的会话（最新的保，只影响索引自身体量）
const SENTINEL_INDEX_BYTES = 4 * 1024 * 1024


function readSentinelIndex () {
  const out = { exists: false, ok: false, path: SENTINEL_INDEX, entries: {}, why: null, lastScan: null }
  if (SENTINEL_INDEX === null) { out.why = '本轮不用索引（--sentinel-index= 空串，或 --mutate=sentinel-lost）'; return out }
  let raw = null
  try { out.exists = fs.existsSync(SENTINEL_INDEX); if (!out.exists) { out.why = '索引不在（首次运行 / 被删）；本轮退化成有界窗口现扫'; return out } } catch (e) { out.why = `索引探测失败：${oneLine(e?.message ?? e)}`; return out }
  try { raw = fs.readFileSync(SENTINEL_INDEX, 'utf8') } catch (e) { out.why = `索引读不出：${oneLine(e?.message ?? e)}`; return out }
  if (raw.length > SENTINEL_INDEX_BYTES) { out.why = `索引体积 ${raw.length} 字节 > ${SENTINEL_INDEX_BYTES} 上限（不当读数用）`; return out }
  try {
    const j = JSON.parse(raw)
    if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new Error('顶层不是对象')
    const bad = []
    for (const [k, v] of Object.entries(j.files ?? {})) {
      if (v === null || typeof v !== 'object') { bad.push(k); continue }
      out.entries[k] = { size: Number(v.size), mtimeMs: Number(v.mtimeMs), verdict: v.verdict === 'sentinel' ? 'sentinel' : 'clean' }
    }
    if (bad.length > 0) out.why = `${bad.length} 条条目形状不对，已丢（其余照旧可用）`
    out.ok = true
    out.lastScan = typeof j.lastScan === 'string' ? j.lastScan : null
  } catch (e) { out.why = `索引解析失败（已当不存在处理，不报错）：${oneLine(e?.message ?? e)}` }
  return out
}

/** 索引落盘：只写仓库内这一个 JSON（scope=repo；不是宿主目录，也不是暂存箱）。 */
function writeSentinelIndex (entries, hitsInWindow, lastScan) {
  // 变异跑一律不落盘：否则 --mutate 那一轮会把索引写窄，下一轮正常跑就得白回填一遍。
  if (SENTINEL_INDEX === null || SENTINEL_MUT) return false
  const topHit = hitsInWindow.length > 0 ? hitsInWindow[0] : null
  const doc = {
    what: 'C46 · B4 哨兵旁路索引：哪些会话日志里出现「aura_read + 参数带哨兵串」的那一发（认账靠 size+mtimeMs）',
    updatedAt: new Date().toISOString(),
    sentinel: ABSENT_TOKEN,
    lastScan: lastScan ?? null,
    lastReading: topHit === null ? null : { time: topHit.time ?? null, shape: topHit.shape, isError: topHit.isError, file: topHit.file ?? null },
    note: '本文件由 aura-tools/probes/activate-and-verify.mjs 在 --check/--post-restart 时增量更新；删掉它不会让判定报错，只会让下一次运行重新回填。',
    files: Object.fromEntries(Object.entries(entries).sort((a, b) => (b[1].mtimeMs ?? 0) - (a[1].mtimeMs ?? 0)).slice(0, SENTINEL_INDEX_BYTES)),
  }
  let text = JSON.stringify(doc, null, 1)
  if (text.length > SENTINEL_INDEX_BYTES) {
    const keep = Object.entries(entries).filter(([, v]) => v.verdict === 'sentinel')
      .sort((a, b) => (b[1].mtimeMs ?? 0) - (a[1].mtimeMs ?? 0)).slice(0, SENTINEL_INDEX_HEAD)
    doc.files = Object.fromEntries(keep)
    doc.truncated = `只留了 ${keep.length} 份含哨兵的会话（体积上限 ${SENTINEL_INDEX_BYTES} 字节）`
    text = JSON.stringify(doc, null, 1)
  }
  try {
    fs.mkdirSync(path.dirname(SENTINEL_INDEX), { recursive: true })   // 默认落在仓库的 .polaris/（已存在；这行只为 --sentinel-index= 指到新目录时兜底）
    fs.writeFileSync(SENTINEL_INDEX, text)
    WRITES.push({ path: SENTINEL_INDEX, what: '哨兵旁路索引（增量，供 B4 下轮不重扫）', scope: 'repo' })
    return true
  } catch { return false }
}

/** 深读一个会话文件，把里面「aura_read + 带哨兵串」的那几发全收出来（同一文件可能有多发）。 */
function sentinelHitsInFile (x) {
  const hits = []
  let buf = null
  try { buf = fs.readFileSync(x.f) } catch { return hits }
  const offs = frameOffsets(buf)
  const byId = new Map()
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    let text = ''
    try { text = zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const f = callFieldsOf(line)
      if (f === null) continue
      if (f.kind === 'hook') continue
      if (f.kind === 'call') { byId.set(f.id, { name: f.name, argsText: f.argsText, time: f.time }); continue }
      const call = byId.get(f.id)
      if (call === undefined) continue
      if (!sentinelCallOf(call)) continue
      hits.push({
        time: call.time, name: call.name, argsText: call.argsText, isError: f.isError, text: f.text,
        shape: shapeOfReceipt({ isError: f.isError, text: f.text }), file: x.f, fileKey: x.key,
        size: x.st.size, mtimeMs: x.st.mtimeMs, mtime: x.st.mtime.toISOString(),
      })
    }
  }
  return hits
}

/**
 * 全史普查（有界）：返回候选集里所有哨兵那一发 + 索引/深扫的来龙去脉。
 *
 * 候选集 = 「索引点过名的含哨兵会话」（永久保留，不随会话数掉出）∪「本轮深扫窗口」。
 * 索引缺席/被清空时退化成「按 mtime 取最新的 N 个」—— 那时才可能真被窗口挤掉，也正是 B4a 要抓的那一格。
 * 全程不抛错：读不了的文件计入 unread，没深扫到的计入 unproven（两者都不当「不存在」用）。
 */
function sentinelCensus () {
  const dir = sessionDirOf(REPO)
  const idx = readSentinelIndex()
  const out = {
    dir, exists: fs.existsSync(dir), files: 0, index: { path: SENTINEL_INDEX, exists: idx.exists, ok: idx.ok, why: idx.why, entries: Object.keys(idx.entries).length, sentinel: 0 },
    hits: [], hitsInWindow: [], row: null, knownSentinel: 0, knownFiles: [], candidates: 0, probed: [], unproven: 0, unread: [], notes: [], window: SENTINEL_SCAN_WINDOW, keep: SENTINEL_KEEP, budgetMB: SENTINEL_BUDGET_MB,
  }
  if (!out.exists) { out.notes.push(`会话目录不存在：${dir}（宿主可能不在本机跑 / 换过 DSH_HOME）`); return out }
  const all = walkSessionFiles(dir).map((f) => ({ f, st: fs.statSync(f), key: path.resolve(f) }))
  out.files = all.length
  const eOf = (x) => idx.entries[x.key]
  const unchanged = (x, e) => e !== undefined && Number.isFinite(e.size) && Number.isFinite(e.mtimeMs) && e.size === x.st.size && e.mtimeMs === x.st.mtimeMs
  // 「能在索引里留账」的深扫才算数：只深扫了最新 N 个（SENTINEL_SCAN_WINDOW>0）的那一轮，
  // 它没扫到的文件是「没查过」而不是「查过、没有」—— 那种轮次一律不落判定，否则一轮窄扫就能把索引写脏，
  // 而索引一脏，B4 的读数就静默降级（比退化更难查）。窗口默认 0=不限 ⇒ 正常轮都是完整轮。
  const fullyScanned = SENTINEL_SCAN_WINDOW === 0
  const picked = new Map()
  // 索引认过账的哨兵会话：它们按 mtime 早就掉出任何窗口了，但**永远进候选集**（这就是不退化那一半）
  const known = all.filter((x) => { const e = eOf(x); return e !== undefined && e.verdict === 'sentinel' && unchanged(x, e) })
  out.knownSentinel = known.length
  out.knownFiles = known.map((x) => `${path.basename(path.dirname(x.f)).slice(0, 8)}@${x.st.mtime.toISOString()}`)
  out.index.sentinel = Object.values(idx.entries).filter((e) => e.verdict === 'sentinel').length
  for (const x of known) if (!picked.has(x.f)) picked.set(x.f, { x, why: '索引点名的含哨兵会话' })
  // ② 本轮深扫窗口：索引没账 / 账对不上的文件，按 mtime 新的先来。
  //    挑不出来（窗口=0）时不静默：下面照实记一条 note，B4a 靠它变红。
  const stale = all.filter((x) => !unchanged(x, eOf(x))).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  out.staleTotal = stale.length
  out.unproven = stale.length
  // 窗口 0 = 不限个数（只由字节预算卡）：索引已经记住「判过的」，所以每个文件一辈子只被深读一次。
  const room = SENTINEL_SCAN_WINDOW > 0 ? Math.max(0, SENTINEL_SCAN_WINDOW - picked.size) : stale.length
  const windowLabel = SENTINEL_SCAN_WINDOW > 0 ? String(SENTINEL_SCAN_WINDOW) : '不限（受字节预算卡）'
  for (const x of stale.slice(0, room)) if (!picked.has(x.f)) picked.set(x.f, { x, why: '本轮深扫窗口（索引里没账/账对不上）' })
  if (stale.length > room) out.notes.push(`本轮只深扫了 ${room} 个没账的会话文件（窗口 ${windowLabel}），还剩 ${stale.length - room} 个没深扫（不当「哨兵不存在」用）`)
  out.candidates = picked.size
  out.partialScan = !fullyScanned
  out.partialScannedClean = 0
  // ③ 深扫（字节预算卡一道；被预算挡下的文件留在索引外面，下轮再来）
  let budget = SENTINEL_BUDGET_MB * 1024 * 1024
  let skipped = 0
  const fresh = []
  for (const { x, why } of [...picked.values()].sort((a, b) => b.x.st.mtimeMs - a.x.st.mtimeMs)) {
    if (budget - x.st.size < 0) { skipped += 1; continue }
    budget -= x.st.size
    const before = idx.entries[x.key]
    let hits = []
    try { hits = sentinelHitsInFile(x) } catch (e) { out.unread.push({ file: x.f, why: oneLine(e?.message ?? e) }); continue }
    out.probed.push({ file: path.basename(path.dirname(x.f)), mb: Math.round((x.st.size / 1048576) * 100) / 100, mtime: x.st.mtime.toISOString(), why, hits: hits.length })
    if (hits.length > 0) {
      // 认账靠「读过的那份字节」的 size+mtime（不是最后一次 stat：扫描期间文件可能又长了）
      idx.entries[x.key] = { size: x.st.size, mtimeMs: x.st.mtimeMs, verdict: 'sentinel' }
      for (const h of hits) fresh.push(h)
    } else if (fullyScanned) {
      // 只在「完整轮」里才敢写 clean；而且**绝不把已有的 sentinel 降级**（宁可多深读一次，不可丢掉已知的那一发）
      if (before === undefined || before.verdict !== 'sentinel') idx.entries[x.key] = { size: x.st.size, mtimeMs: x.st.mtimeMs, verdict: 'clean' }
    } else out.partialScannedClean += 1
  }
  out.skippedByBudget = skipped
  if (skipped > 0) out.notes.push(`${skipped} 个候选被 ${SENTINEL_BUDGET_MB}MB 字节预算挡下（没读，下轮再来；不当「哨兵不存在」用）`)
  // ④ 合并：索引认账的含哨兵会话**每轮都重读**（读数永远来自会话日志本身，不是索引里的旧值）+ 本轮新发现的
  const byKey = new Map()
  for (const h of [...fresh, ...out.hits]) if (!byKey.has(h.fileKey)) byKey.set(h.fileKey, h)
  const merged = [...byKey.values()].sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
  out.allHits = merged.length
  out.hits = merged
  out.undecided = merged.filter((h) => h.shape === 'unknown').length
  out.hitsInWindow = SENTINEL_KEEP < 0 ? merged : merged.slice(0, SENTINEL_KEEP)
  out.excluded = merged.slice(out.hitsInWindow.length)
  out.row = out.hitsInWindow.length > 0 ? out.hitsInWindow[0] : null
  out.lastScanBefore = idx.lastScan
  out.updatedAt = new Date().toISOString()
  out.updated = writeSentinelIndex(idx.entries, out.hitsInWindow, out.updatedAt)
  if (idx.why !== null) out.notes.push(`索引：${idx.why}`)
  out.notes.push(`候选集 ${out.candidates} 个（索引点名 ${out.knownSentinel} + 本轮深扫 ${out.probed.length}${out.partialScan ? '；本轮回填轮偏窄，不落判定' : ''}）；深扫 ${out.probed.length} 个、命中含哨兵会话 ${out.allHits} 份、读数窗口留 ${out.hitsInWindow.length} 份；没查过的 ${out.unproven} 个、读不出的 ${out.unread.length} 个（都不当「哨兵不存在」用）`)
  return out
}

const hookStats = (hooks) => {
  const ms = hooks.map((h) => h.ms)
  return { n: ms.length, p50: pct(ms, 0.5), p90: pct(ms, 0.9), min: ms.length ? sorted(ms)[0] : null, max: ms.length ? sorted(ms)[ms.length - 1] : null }
}

// ── 3.8 钩子自己的账：pre_tool.ms（只读 .polaris/polaris-guard.log.jsonl）──
function guardLogStats () {
  const st = snapFile(GUARD_LOG)
  if (!st.exists) return { exists: false, n: 0 }
  const raw = (() => { try { return fs.readFileSync(GUARD_LOG, 'utf8') } catch { return '' } })()
  const ms = []
  const verdicts = new Map()
  let preTool = 0
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let j = null
    try { j = JSON.parse(line) } catch { continue }
    if (j.kind !== 'pre_tool') continue
    preTool++
    if (typeof j.ms === 'number' && Number.isFinite(j.ms)) ms.push(j.ms)
    verdicts.set(j.verdict ?? '?', (verdicts.get(j.verdict ?? '?') ?? 0) + 1)
  }
  return { exists: true, bytes: st.bytes, preTool, ...hookStats(ms.map((x) => ({ ms: x }))), verdicts: Object.fromEntries(verdicts) }
}

// ── 3.9 引擎侧行为指纹：从两个根**现跑**得出（不是抄字符串）；顺带证明判据有判定力 ──
const FP_CHILD_SRC = [
  "import fs from 'node:fs'",
  "import os from 'node:os'",
  "import path from 'node:path'",
  "import { pathToFileURL } from 'node:url'",
  'const root = process.argv[2]',
  'const TOKEN = process.argv[3]',
  "const BOX = fs.mkdtempSync(path.join(os.tmpdir(), 'c30-fp-'))",
  "const FIX = path.join(BOX, 'fixture.mjs')",
  "fs.writeFileSync(FIX, 'export function alpha (a) {\\n  return a\\n}\\n\\nexport function beta (b) {\\n  return b\\n}\\n', 'utf8')",
  'let version = 1',
  'let registered = null',
  'const ctx = {',
  '  fs: {',
  "    resolve: async (p, opts) => ({ displayPath: p, targetKey: path.isAbsolute(p) ? p : path.join(opts?.cwd ?? process.cwd(), p) }),",
  "    stat: async (t) => (fs.existsSync(t.targetKey) ? { version: 'v' + version } : undefined),",
  "    readText: async (t) => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(t.targetKey)),",
  '    readByteRange: async (t, o) => new Uint8Array(fs.readFileSync(t.targetKey).subarray(o.offset, o.offset + o.length)),',
  "    writeText: async (t, c) => { fs.writeFileSync(t.targetKey, c, 'utf8'); version += 1; return { version: 'v' + version, operation: 'update', after: c } },",
  "    editText: async () => { throw new Error('unused') },",
  '  },',
  '  get: () => undefined,',
  '  inject: () => {},',
  '  tools: { register: (t) => { registered = t } },',
  '  emit: () => {},',
  '  systemPrompt: { section: () => () => {} },',
  '}',
  'const fin = (o) => { try { fs.rmSync(BOX, { recursive: true, force: true }) } catch {} process.stdout.write(JSON.stringify(o)) }',
  'try {',
  "  const mod = await import(pathToFileURL(path.join(root, 'aura-read', 'index.js')).href)",
  '  mod.apply(ctx)',
  '} catch (e) { fin({ fatal: String(e?.message ?? e) }); process.exit(0) }',
  "const exec = { agent: { session: { header: { cwd: BOX } } }, signal: undefined }",
  'try {',
  "  const o = await registered.execute({ file_path: FIX, mode: 'search', search: TOKEN }, exec)",
  '  fin({ threw: false, keys: Object.keys(o).sort(), outcome: o.outcome ?? null, code: o.code ?? null,',
  "    text: String(o.text ?? '').slice(0, 220) })",
  '} catch (e) {',
  '  fin({ threw: true, keys: Object.keys(e ?? {}).sort(), code: e?.code ?? null,',
  "    message: String(e?.message ?? e).slice(0, 220) })",
  '}',
].join('\n')
function fingerprintShapeOf (root) {
  const child = tmpWrite(path.join(TMP, `fp-${sha256(root).slice(0, 8)}.mjs`), `行为指纹子进程（根=${relRepo(root)}）`)
  fs.writeFileSync(child, FP_CHILD_SRC, 'utf8')
  const r = spawnSync(process.execPath, [child, root, ABSENT_TOKEN], { encoding: 'utf8', windowsHide: true, timeout: 120000, cwd: REPO })
  if (r.status !== 0) return { ok: false, why: clip(oneLine(r.stderr), 300) }
  let res = null
  try { res = JSON.parse(r.stdout) } catch (e) { return { ok: false, why: `子进程输出解析失败：${oneLine(e?.message ?? e)}` } }
  if (res.fatal !== undefined) return { ok: false, why: `从 ${relRepo(root)} import 失败：${res.fatal}` }
  const shape = res.threw
    ? `threw:${(res.code ?? String(res.message ?? '').split(':')[0].trim()) || '(none)'}`
    : `result:${res.outcome ?? '(none)'}`
  // 「形状」有两种读法，两者都要：
  //   `shape`   = **原始**形状（`threw:READ_NOT_FOUND` / `result:not_found`），B3b 用它比两个根能否区分；
  //   `verdict` = 用**与哨兵那一发同一把尺子**（shapeOfReceipt）量出来的新旧判定 old/new/unknown ——
  //               它才能拿来与会话日志里那一发的 shape 逐字对比（B4 现口径的期望就是拿它派生的）。
  // 少了这一格，B4 会拿 `result:not_found` 去比 'new'：期望永远对不上，判据变假红。
  const verdict = shapeOfReceipt({ isError: res.threw === true, text: String(res.text ?? res.message ?? '') })
  return { ok: true, root, shape, verdict, threw: res.threw, outcome: res.outcome ?? null, code: res.code ?? null, text: res.text ?? res.message ?? '', raw: res }
}
/**
 * `previous/` 这棵树**什么时候落到盘上的**（= 它作为「上一版」被写出来的那一刻）。只 stat，不猜。
 *
 * 【为什么需要它】B4 的期望要回答「宿主启动时盘上那一份是哪一份」。宿主启动早于本次安装生效时间时，
 * 升级就是在**宿主启动之后**把盘上那份换下来的 —— 但只有 previous/ 确实是那时写出来的才成立；
 * 若 previous/ 比宿主启动还早就躺在那儿，它是更早一次升级留下的，认不出宿主加载的是哪一份。
 * 【为什么取三者最大值】三个证人的含义不同：目录 mtime = 这份树被写进这个目录的时刻；
 * package.json 的 mtime 可能是**打包时保留**的原件时间（本机实测：目录 17:21:18 / 文件 mtime 13:36:19），
 * birthtime = 这个文件在本机出现的时刻。取最大值 = 「这棵树在本盘上最后一次被写」的上界，
 * 只有它 > 宿主启动时间，才谈得上「宿主启动之后才换的盘」。
 *
 * @returns {{ms: number|null, witness: string|null, why: string|null}}
 */
function prevTreeCaptureMs () {
  const out = { ms: null, witness: null, why: null }
  const take = (ms, what) => {
    if (!Number.isFinite(ms)) return
    if (out.ms === null || ms > out.ms) { out.ms = ms; out.witness = what }
  }
  try {
    const st = fs.statSync(PREV_DIR)
    take(st.mtimeMs, `目录 mtime ${st.mtime.toISOString()}`)
  } catch (e) { out.why = `目录 stat 失败：${oneLine(e?.message ?? e)}` }
  try {
    const st = fs.statSync(path.join(PREV_DIR, 'package.json'))
    take(st.mtimeMs, `package.json mtime ${st.mtime.toISOString()}`)
    take(st.birthtimeMs, `package.json birthtime ${st.birthtime.toISOString()}`)
  } catch (e) { if (out.why === null) out.why = `package.json stat 失败：${oneLine(e?.message ?? e)}` }
  return out
}
/**
 * 钩子**承载链**的期望：宿主启动时加载的那个 profile 里，钩子组的 shell 执行器是谁。
 *
 * 【为什么不能拿安装时间线当期望（就是本格要修的缺陷类）】安装时间线（B2）回答的是
 *   「宿主加载的是**哪一份包**」；它回答不了「钩子命令串由**谁**承载」—— 后者由宿主加载的
 *   profile 那一行（`polaris-hooks-shell` 的 `name:`）决定，而那一行可以在任何一次安装之外被改。
 *   2026-10-15 真机就是这一格：宿主启动 22:44:49（本地）早于本次升级 upgradedAt=01:21:18（次日）
 *   ⇒ 时间线说「未重启 ⇒ 期望 old」，而 profile 那两行（21:37 写的）指的已是 argv-shell.mjs
 *   ⇒ 实测 new。反过来，宿主启动晚于 upgradedAt 时，时间线又会给出**期望 new**，
 *   而那时 profile 那一行可能仍指向 pwsh-local ⇒ 期望错、读数对，判据只能靠 soft 遮着。
 *
 * 【口径：三支】
 *   ① restartedVsProfile === true（宿主启动晚于该行的 mtime）⇒ 宿主加载的就是盘上这一行
 *      ⇒ 期望 = 这一行的执行器所蕴含的链（argv-shell.mjs/runner.js/node ⇒ direct；其余 ⇒ wrapped）。
 *   ② restartedVsProfile === false ⇒ 宿主启动早于这一行，它加载的是**更早的一行**，而那一行的内容
 *      盘上读不到（已被覆写）⇒ **没有诚实期望**：不判红，只如实报实测形状（carrier=null）。
 *   ③ 读不出（profile 没这条组 / 行里抠不出执行器 / 宿主启动时间缺失）⇒ 同上，没有诚实期望。
 *   不许用「安装时间线 + 装了哪一版」硬凑一个期望顶上（那正是要被修掉的那类错）。
 *
 * @returns {{carrier: 'direct'|'wrapped'|null, restartedVsProfile: boolean|null, why: string, executor: string|null, file: boolean|null, source: string}}
 */
function hostCarrierOf (profile, restartedVsProfile) {
  const line = profile?.ok === true ? profile.nameLine : null
  const ex = profile?.ok === true ? profile.executor : null
  if (ex === null || ex === undefined) {
    return { carrier: null, verdict: null, restartedVsProfile, executor: null, file: null, source: '读不出（profile 里没有这条组 / 抠不出那一行的执行器）', why: 'profile 那一行读不出 ⇒ 宿主用的是哪条承载链认不出（不判红，只报实测形状）' }
  }
  const direct = ex.base === 'argv-shell.mjs' || ex.base === 'runner.js' || ex.base.startsWith('node')
  const how = direct ? '命令串被 tokenize 成 argv 直投（链上没有 pwsh）' : `这个执行器不是 argv 直投（预期仍经 pwsh -Command 一类的外层壳）：${ex.raw}`
  const source = `profile 那一行（${String(line ?? '').trim()}）的执行器 ${ex.base}${ex.file === false ? '（**盘上不在**）' : ''}`
  if (restartedVsProfile !== true) {
    return {
      carrier: null,
      verdict: null,
      restartedVsProfile,
      executor: ex.base,
      file: ex.file,
      source,
      why: restartedVsProfile === false
        ? '宿主启动早于 profile 那一行的 mtime ⇒ 它加载的是**更早的一行**（那一行的内容已被覆写，盘上读不到）⇒ 没有诚实期望（不判红）'
        : '宿主启动时间读不出 ⇒ 无法判断宿主加载的是不是盘上这一行 ⇒ 没有诚实期望（不判红）',
    }
  }
  return {
    carrier: direct ? 'direct' : 'wrapped',
    // 两个词表在**同一个地方**翻译一次（'direct' ↔ 'new'、'wrapped' ↔ 'old'）：调用点（C4 与 P2）
    // 共用这一个值，两处不再各写一遍 —— 否则一处写对、一处写错就会出现「同一份采样两个判据两个结论」
    // （本单的穷举证明当场抓到过一次：C4 判绿而 P2 判红，就因为两处各算了一遍映射）。
    verdict: direct ? 'new' : 'old',
    restartedVsProfile,
    executor: ex.base,
    file: ex.file,
    source,
    why: `宿主启动晚于 profile 那一行的 mtime ⇒ 宿主加载的就是这一行 ⇒ ${how}`,
  }
}


/**
 * 旧壳对照根（冻结夹具）的完整性读数：**重算**树哈希 + 逐项对账清单，不信任何说明文件。
 * 这是「夹具不见了 / 被换成现树」的判据底座 —— 两者都让 B3 的判定力归零，必须点名而不是消过去。
 * 判「被换成现树」不靠文件名：直接比树哈希 —— 与安装副本或 previous/ 相等就是现树。
 *
 * @returns 夹具的 { ok, dir, why, version, treeHash, buildStamp, fileCount, unlisted }
 */
function fixtureIntactOf () {
  const info = treeInfoOf(FIXTURE_ENGINE)
  if (!info.ok) return { ok: false, dir: FIXTURE_ENGINE, why: info.why }
  // manifest 里列的那 19 件是「应该有哪些」；磁盘上多出来的（比如谁塞了个说明文件）记为 unlisted
  const listed = new Set(Object.keys(FIXTURE_MANIFEST_FILES))
  const unlisted = Object.keys(info.files).filter((n) => !listed.has(n))
  return { ok: true, dir: FIXTURE_ENGINE, version: info.version, treeHash: info.treeHash, stamp: info.buildStamp, fileCount: Object.keys(info.files).length, unlisted, files: info.files }
}

// ═════════════════════════════════════════════════════════════════════════════
// §4 读数采集（三种模式共用；一次采集，避免同一件事量两遍）
// ═════════════════════════════════════════════════════════════════════════════
/**
 * 状态文件里所有同类「安装/升级」时间戳字段名（**字段名清单，不是硬编码单个字段**）。
 * 【为什么是一组】安装器正规的 `--upgrade` 路径会**同时**写下：
 *   - `installedAt`：**首次安装**时间，跨升级保持不变；
 *   - `upgradedAt` ：**本次升级**时间，较新（0.6.6 升级态实测两个都在）。
 * 只取 `installedAt` 会把「宿主启动于首次安装之后、但早于本次升级」误判成「已生效」（假绿）。
 * 后两个是同类字段的守卫：真出现同名日期字段也一并纳入最大值，缺就跳过。
 */
const STATE_TS_FIELDS = ['installedAt', 'upgradedAt', 'reinstalledAt', 'builtAt']
/**
 * 「本次安装生效时间」= 同类时间戳字段的**最大值**（纯计算、无副作用、不读不写盘）。
 * 取最大值而非某一个字段的理由：升级会在状态文件里同时留下「首次安装」与「本次升级」两个时间戳，
 * 「这一份字节是什么时候落盘的」= 两者中较新的那个；只有宿主启动**晚于这个最大值**，
 * 才谈得上「宿主加载的是这一份」。
 * @returns {{ms: number|null, field: string|null, fieldName: string, maxOf: string|null}}
 */
function effectiveInstallMsOf (state) {
  const src = state !== null && typeof state === 'object' ? state : {}
  let ms = null
  let field = null
  const found = []
  for (const f of STATE_TS_FIELDS) {
    if (src[f] === undefined || src[f] === null || src[f] === '') continue
    const t = Date.parse(src[f])
    if (!Number.isFinite(t)) continue
    found.push(`${f}=${new Date(t).toISOString()}`)
    if (ms === null || t > ms) { ms = t; field = f }
  }
  return {
    ms,
    field,
    fieldName: field === null ? `(状态文件里 ${STATE_TS_FIELDS.join('/')} 都没有)` : field,
    maxOf: found.length > 0 ? found.join(' ') : null,
  }
}
/**
 * B2 时间线判据的纯计算内核（只吃一个状态对象，**不读进程表、不读盘、不写盘**）。
 * 存在的理由：让「宿主启动 vs 本次安装生效时间」这一格能被**合成输入**直接证伪 ——
 * 不必先造一份真安装副本去跑 --check（因此也就没有任何写宿主配置的路径）。
 * @returns {{ms: number|null, field: string|null, maxOf: string|null, verdict: 'effective'|'not-effective'|'unobserved'}}
 */
function timelineVerdictOf (state, hostStart) {
  const eff = effectiveInstallMsOf(state)
  const hsN = hostStart === null || hostStart === undefined ? NaN : Number(hostStart)
  const hs = Number.isFinite(hsN) ? hsN : null
  return {
    ms: eff.ms,
    field: eff.field,
    maxOf: eff.maxOf,
    verdict: eff.ms === null || hs === null ? 'unobserved' : (hs > eff.ms ? 'effective' : 'not-effective'),
  }
}
function collect () {
  const base = {}
  base.state = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null } })()
  base.install = treeInfoOf(INSTALL_DIR)
  base.prev = treeInfoOf(PREV_DIR)
  // 逐个 profile 判；`base.profile` 保留为「主 profile」（--profile 给的就是它；否则优先 web）——
  // post-restart 那几条判据（行值 / mtime）历史上只看一个 profile，保持口径不变。
  base.profiles = PROFILE_FILES.map((f) => readProfile(f))
  base.profile = base.profiles.find((p) => p.profile === 'web') ?? base.profiles.find((p) => p.hasGroup) ?? base.profiles[0] ?? readProfile(PROFILE)
  base.table = processTable()
  base.host = base.table.ok ? findHost(base.table) : { how: '进程表不可读', host: null, chain: [] }
  // 本次安装生效时间 = installedAt / upgradedAt（及同类字段）的**最大值**：升级后只认 installedAt 会假绿
  const effInstall = effectiveInstallMsOf(base.state)
  base.installedAtMs = effInstall.ms
  base.installTimeField = effInstall.field
  base.installTimeMaxOf = effInstall.maxOf
  // 时间线：默认取真宿主进程的启动时间；--simulate-restart / --fixture 只给合成夹具用
  const hostStartMs = SIM_START !== null ? SIM_START : (base.host.host !== null ? Number(base.host.host.startMs) : null)
  base.simulated = SIM_START !== null
  base.hostStartMs = hostStartMs
  // 「宿主是否晚于安装/接线启动」= 引擎侧与钩子侧是否**可能**已生效的时间线判据
  base.restartedVsInstall = base.installedAtMs !== null && hostStartMs !== null ? hostStartMs > base.installedAtMs : null
  base.restartedVsProfile = base.profile.ok ? (hostStartMs !== null ? hostStartMs > base.profile.mtimeMs : null) : null
  base.restarted = base.restartedVsInstall === true
  // 钩子**承载链**的期望：从 profile 那一行的执行器 + 宿主钩子配置派生（见 hostCarrierOf）——
  // 与「装了哪一版包」无关，所以它不读安装时间线，只读 profile.mtimeMs 与宿主启动时间的先后。
  base.carrier = hostCarrierOf(base.profile, base.restartedVsProfile)
  // 会话日志：引擎侧回执形状（含标记串那一发）+ 宿主侧钩子墙钟
  // E1/E3 那两条线（钩子墙钟 + 近期失败清单）走有界窗口；B4 的哨兵那一发走旁路索引普查（C46）——
  // 两条线分开的理由：墙钟要的是「最近一段」，哨兵要的是「不随会话数退化」，用同一个窗口会把两边的需求都弄坏。
  base.sessionsAll = readSessions({ sinceMs: 0 })
  base.sessionsSince = base.restarted ? readSessions({ sinceMs: hostStartMs }) : null
  base.sentinel = sentinelCensus()
  base.hooksAll = hookStats(base.sessionsAll.hooks)
  base.hooksSince = base.sessionsSince === null ? null : hookStats(base.sessionsSince.hooks)
  base.guard = guardLogStats()
  return base
}

/**
 * 引擎侧指纹的**实测**读数：只认「宿主自己造的那一发」—— 唯一的识别物是那个独特哨兵串。
 *
 * 【为什么只认哨兵、不再退到「最近一次失败回执」】
 *   别的 aura_read 失败回执（比如 `cannot read "…fs-contract-v2.C43.json": not found`）**两种壳都可能产生**，
 *   它的形状判不出新旧（shapeOfReceipt 给 `unknown`）。拿它顶包会把「还没观测到」伪装成一个看起来像读数的
 *   `unknown`，并附上一条与指纹毫无关系的正文 —— 2026-10-14 实测就是被 C43 那一发顶了包（B4 报 unknown）。
 *   哨兵那边卡了两道（`sentinelCallOf` 一份实现、两处共用）：`name === 'aura_read'` 且参数里带哨兵串
 *   （写本探针那一发也带哨兵，但它是 write，被工具名筛掉）。
 *
 * 【判定范围：C46 起 = 全史普查】候选集 = 索引点过名的含哨兵会话 ∪ 本轮有界深扫窗口（见 sentinelCensus）。
 *   那发也是宿主自己造的，且宿主进程未重启 ⇒ 它加载的字节至今没变，所以它仍是当前引擎的有效读数。
 *   候选集里一发都没有 ⇒ null = 如实报「未观测」，不编读数（**也不报错**：索引读不出、目录不在，都只降级）。
 *   ⚠ 区分「宿主从没发过那一发」与「发过但我没读到」不归它管 —— 那是 B4a-sentinel-not-lost 的活。
 */
function engineReadingOf (base) {
  const c = base.sentinel
  if (c === undefined || c === null) return null
  // 优先取**形状可判定**（old/new）的最新一发：哨兵串在参数里出现的那一发也可能来自别的调用者
  // （实测本机就有：B3b 的行为指纹子进程会留下「aura_read + 哨兵」的会话，但那几发没有回执、形状是 unknown）。
  // 若让「更新的 unknown」顶上去，B4 会从有读数退化成 unknown —— 那正是这条判据最不该有的退化。
  const row = c.hitsInWindow.find((h) => h.shape === 'old' || h.shape === 'new') ?? c.row
  if (row === undefined || row === null) return null
  return { ...row, via: '哨兵串那一发（aura_read + 参数带哨兵）', viaFile: row.file === undefined || row.file === null ? null : path.basename(path.dirname(row.file)), window: '全史普查（旁路索引 + 有界深扫）' }
}

// ═════════════════════════════════════════════════════════════════════════════
// §5 判据登记（--check 与 --post-restart 共用底座）
// ═════════════════════════════════════════════════════════════════════════════
function registerInstallCriteria (base, wantRestart) {
  hr('段A  引擎侧：安装副本 = 宿主将要加载的那份字节')
  // A1 构建戳：**期望值从源头读**（install.json.buildStamp，退到安装副本 package.json），
  // 「实际值」仍是逐件重算 —— 判的是「声明 vs 重算」这条不变式，不是某个手抄的版本号（波15）。
  {
    const declared = declaredBuildStampOf(base.state, base.install)
    const expectRaw = declared === null ? '@@MUTATED@@' : declared.stamp
    const expect = me('install-stamp', expectRaw)
    const actual = base.install.ok ? base.install.buildStamp : `(读不出：${base.install.why})`
    const declaredVer = declaredVersionOf(base.state, base.install)
    const verWhere = declaredVer === null ? '状态文件与 package.json 都没版本位点' : `版本声明来自 ${declaredVer.where}`
    const ok = declared !== null && actual === expect
    crit('A1-install-stamp', '安装副本构建戳（按 install.mjs 的 hashTree+treeDigest 逐件重算，对照安装器声明的构建戳）', {
      expect: declared === null
        ? '安装器声明的构建戳（install.json.buildStamp，退路：安装副本 package.json 的 buildStamp）'
        : `${expect}（期望值来自 ${declared.where}；${verWhere}）`,
      actual: declared === null
        ? `${actual}；但两边都没声明构建戳 ⇒ 这条无从对账（不判红，如实报）`
        : actual,
      ok,
      soft: declared === null,
      fix: '安装副本与它自己的声明对不上：重跑 node aura-tools/build/make-bundle.mjs 再按安装器流程装一次（C28 的口径）；装之前别重启宿主。（注：期望值读自 install.json.buildStamp／安装副本 package.json，不读本文件里的常量。）',
    })
  }
  // A2 install.json 记的 19 件 vs 磁盘
  {
    const expect = me('install-record', 0, 1)
    const recorded = base.state?.files ?? null
    let mismatch = null
    if (recorded === null) mismatch = null
    else if (base.install.ok !== true) mismatch = null
    else {
      const disk = base.install.files
      const names = new Set([...Object.keys(recorded), ...Object.keys(disk)])
      mismatch = 0
      for (const n of names) if (recorded[n] !== disk[n]) mismatch++
    }
    crit('A2-install-record', '安装记录（install.json.files）vs 磁盘逐文件', {
      expect: `${expect} 处不一致`,
      actual: mismatch === null ? '（无法对账：状态文件或安装副本读不出）' : `${mismatch} 处不一致（记录 ${Object.keys(recorded ?? {}).length} 件 / 磁盘 ${base.install.ok ? Object.keys(base.install.files).length : 0} 件）`,
      ok: mismatch === expect,
      soft: mismatch === null,
      fix: '安装副本被动过或装了一半：先 node "<prefix>/node_modules/aura-tools/install.mjs" --doctor 看体检，再决定重装还是回滚。',
    })
  }
  // A3 源树 vs 安装副本（**名单**逐字节，不钉件数：件数随包长大而变，名单只在加了新件时加一行）
  {
    const expect = me('src-vs-install', 0, 3)
    const rows = []
    let differ = 0
    let missing = 0
    for (const rel of [...SRC_TO_PACK, 'build/install.mjs']) {
      // 安装器源码不在 src/ 下（build/install.mjs → 包根 install.mjs），路径映射与 packPathOf 同一份口径
      // 源侧的两种例外：安装器在 build/ 下（包里提到包根），钩子执行器在包根的 dsh/ 下
      // —— 两者都不在 src/ 下。漏了这一格，`dsh/argv-shell.mjs` 会被报成「缺件」（本单实测：1 件缺）。
      const src = rel === 'build/install.mjs'
        ? pkgPath('build', 'install.mjs')
        : rel.startsWith('dsh/')
          ? pkgPath(rel)
          : pkgPath('src', rel)
      const dst = path.join(INSTALL_DIR, packPathOf(rel))
      const a = snapFile(src)
      const b = snapFile(dst)
      if (!a.exists || !b.exists) { missing++; rows.push(`${rel}: 缺件（src=${a.exists} 装=${b.exists}）`); continue }
      if (a.sha256 !== b.sha256) { differ++; rows.push(`${rel}: ${a.sha256.slice(0, 16)} ≠ ${b.sha256.slice(0, 16)}`); continue }
      rows.push(`${rel}: ${a.sha256.slice(0, 16)}`)
    }
    crit('A3-src-vs-install', '源树引擎件 vs 安装副本（逐字节；安装副本应等于现树）', {
      expect: `${expect} 件不同、0 件缺`,
      actual: `${differ} 件不同、${missing} 件缺（共比 ${rows.length} 件）`,
      ok: differ === expect && missing === 0,
      fix: '现树有未装进包的改动（或安装副本被换过）：重跑 make-bundle + 安装流程让两边同步；如果你是有意在源树上继续改，先把本读数如实记档再重启。',
      note: differ === 0 && missing === 0 ? `全部一致：${rows.slice(0, 4).join('  ')}  …` : rows.filter((r) => r.includes('≠') || r.includes('缺件')).slice(0, 6).join('  '),
    })
  }
  // A6 包内清单：`package.json.files` 声明的每一项都在包里，且包里没有清单外的多余额外件
  // 【为什么是这条不变式，而不是「包内 N 件」】件数随包长大而变（20 → 21），手抄的数字必然漂；
  // 而 `files` 是**产物自己的声明**（npm pack 也只发它列到的东西），磁盘是实测那一侧 ——
  // 判的因此是「声明 vs 磁盘」，两侧都不手抄。
  {
    const decl = base.install.ok ? (base.install.manifest?.files ?? null) : null
    const disk = base.install.ok ? Object.keys(base.install.files) : []
    let missing = null
    let extra = []
    if (decl !== null) {
      missing = []
      for (const entry of decl) {
        if (entry.endsWith('/')) { if (!disk.some((n) => n.startsWith(entry))) missing.push(`${entry}（整目录缺失）`) } else if (!disk.includes(entry)) missing.push(entry)
      }
      const always = new Set(['package.json', 'README.md'])
      extra = disk.filter((n) => !always.has(n) && !decl.some((e) => (e.endsWith('/') ? n.startsWith(e) : n === e)))
    }
    crit('A6-pkg-manifest', '包内清单：package.json.files 声明的每一项都在包里，且包里没有清单外的多余额外件', {
      expect: '缺件 0（含整目录）；清单外多余额外件 0（声明与磁盘两侧都从产物派生，不手抄件数）',
      actual: missing === null ? '（无法对账：安装副本读不出）' : `缺件 ${missing.length}${missing.length > 0 ? `（${missing.join('、')}）` : ''}；清单外多余额外件 ${extra.length}${extra.length > 0 ? `（${extra.join('、')}）` : ''}；磁盘共 ${disk.length} 件`,
      ok: missing !== null && missing.length === 0 && extra.length === 0,
      soft: missing === null,
      fix: '包内清单与声明不符：像 `dsh/` 这样的新目录必须**同时**进 make-bundle 的复制循环与 package.json 的 `files` —— 只加了一处，npm pack 会把整个目录丢掉（装完看着一切正常，宿主组合时才炸）。',
    })
  }
  // A4 dist 暂存 vs 安装副本（有 dist 才算，缺了不判红）
  {
    const distDir = pkgPath('dist', PKG_NAME)
    const dist = treeInfoOf(distDir)
    const same = dist.ok && base.install.ok ? dist.treeHash === base.install.treeHash : null
    crit('A4-dist-vs-install', 'dist 暂存树 vs 安装副本树（派生物有没有分叉）', {
      expect: `${me('dist-vs-install', declaredBuildStampOf(base.state, base.install)?.stamp ?? '(状态文件未声明构建戳)')}（同树哈希）`,
      actual: dist.ok ? `${dist.buildStamp}${same === null ? '' : same ? '（同）' : '（分叉）'}` : `(dist 暂存不可读：${dist.why})`,
      ok: same === true && !isMut('dist-vs-install'),
      soft: same === null,
      fix: 'dist 与安装副本分叉：以源树为准重建 dist（make-bundle），别拿旧 tgz 去装。',
    })
  }
}

function registerHostCriteria (base, wantRestart) {
  hr('段B  宿主进程与「生效了没有」')
  // B1 宿主定位（读数）
  const host = base.host.host
  if (host === null) {
    crit('B1-host-found', '宿主进程定位', {
      expect: '找到一个跑 dsh/lib/bin.js 的 node 进程',
      actual: `没找到（${base.host.how}；进程表 ${base.table.ok ? `${base.table.rows.length} 行` : `不可读：${base.table.why}`}）`,
      ok: false, soft: true,
      fix: '本脚本可能不在宿主里跑：不影响其余判据；宿主相关的两条（时间线/指纹）会退化成未观测。',
    })
  } else {
    const cmd = clip(String(host.cmd ?? ''), 150)
    crit('B1-host-found', `宿主进程（${base.host.how}）`, {
      expect: '一个跑 dsh/lib/bin.js 的 node 进程 + 启动时间 + 命令行',
      actual: `pid=${host.pid} 启动=${new Date(Number(host.startMs)).toISOString()}（本地 ${new Date(Number(host.startMs)).toLocaleString('zh-CN')}）  ${cmd}`,
      ok: true,
    })
  }
  // B2 时间线：取的是**同类时间戳字段的最大值**（installedAt 首次安装 / upgradedAt 本次升级 / …），
  // 不是某一个写死的字段名 —— 升级后 installedAt 停留不动，拿它单独比会假绿。
  const installIso = base.installedAtMs === null ? `(状态文件里 ${STATE_TS_FIELDS.join('/')} 都没有)` : new Date(base.installedAtMs).toISOString()
  const deltaMin = (base.installedAtMs !== null && base.hostStartMs !== null) ? Math.round((base.hostStartMs - base.installedAtMs) / 60000) : null
  const fieldIso = base.installTimeMaxOf === null
    ? `同类字段（${STATE_TS_FIELDS.join('/')}）都缺失`
    : `同类字段最大值取自 ${base.installTimeField}：${base.installTimeMaxOf}`
  const timeline = base.restartedVsInstall === null ? '未观测（缺宿主或安装时间）' : base.restartedVsInstall ? '已生效（宿主启动晚于安装）' : '未生效（宿主启动早于安装）'
  crit('B2-timeline', '时间线：宿主启动 vs 安装时间（引擎侧是否可能已生效）', {
    expect: `宿主启动时间 > 本次安装生效时间 ⇒ 宿主加载的是安装副本这一份；后者 = ${STATE_TS_FIELDS.join('/')} 里所有**存在且可解析**的时间戳的**最大值**`,
    actual: `${timeline}；本次安装生效时间 ${installIso}（${fieldIso}）、宿主启动 ${base.hostStartMs === null ? '未知' : new Date(base.hostStartMs).toISOString()}（差 ${deltaMin === null ? '—' : `${deltaMin} 分钟`}）`,
    ok: base.restartedVsInstall !== null,
    soft: base.restartedVsInstall === null,
    fix: '拿不到时间线：确认本脚本在宿主里跑（B1），或手工比对 Get-CimInstance 的 CreationDate 与 install.json。',
    note: '这一条只说「可能已生效」，真正判生效的是 B4（行为指纹实测）。',
  })
  // B3a 旧壳对照根（冻结夹具）的完整性：不见了 / 被换成现树，都要当场点名
  {
    const fx = fixtureIntactOf()
    // 「被换成现树」的形态：树哈希等于安装副本或 previous/（两者都是新壳）
    const sameAs = fx.ok && base.install.ok && fx.treeHash === base.install.treeHash ? `安装副本（${base.install.buildStamp}）`
      : (fx.ok && base.prev.ok && fx.treeHash === base.prev.treeHash ? `previous/（${prevStampOf(base.prev)}）` : null)
    const wantStamp = me('fixture-intact', FIXTURE_STAMP_EXPECT)
    const ok = fx.ok && fx.stamp === wantStamp && sameAs === null && fx.fileCount === FIXTURE_FILECOUNT_EXPECT
    const why = []
    if (!fx.ok) why.push(`夹具不在/读不出：${fx.why ?? '目录不存在'}`)
    else {
      if (fx.stamp !== wantStamp) why.push(`构建戳是 ${fx.stamp}，不是 ${wantStamp}`)
      if (sameAs !== null) why.push(`它的树哈希与${sameAs}逐字节相同 ⇒ 已被换成带新壳的现树，不再是旧壳对照`)
      if (fx.fileCount !== FIXTURE_FILECOUNT_EXPECT) why.push(`文件数 ${fx.fileCount}，不是 ${FIXTURE_FILECOUNT_EXPECT}`)
    }
    crit('B3a-fixture-intact', '旧壳对照根：冻结基准夹具在不在、是不是原来那一份（不是现树）', {
      expect: `${relRepo(FIXTURE_ENGINE)} 夹具在 + 构建戳 ${wantStamp} + ${FIXTURE_FILECOUNT_EXPECT} 件 + 与现树不同源`,
      actual: fx.ok
        ? `构建戳 ${fx.stamp}（版本 ${fx.version}）目录 ${fx.fileCount} 件，树哈希 ${fx.treeHash.slice(0, 12)}${sameAs === null ? '（与现树不同源）' : `，与${sameAs}同源`}`
        : `不在/读不出：${fx.why ?? '目录不存在'}`,
      ok,
      fix: why.length > 0
        ? `${why.join('；')}。—— 这份夹具是 B3 判定力的唯一支柱（previous/ 已经是新壳，当不了旧壳对照），必须从 dist 里取 0.6.1 包体重新冻结一份，不许静默放过。`
        : null,
      note: '这份夹具不在升级路径上（任何升级都不会碰它），所以它能稳定当「旧壳」那一半；被换成现树则 B3 的判定力当场作废。',
    })
    base.fixture = fx
  }
  // B3b 指纹判定力自证：两个根现跑，形状必须不同（旧壳根 = 冻结夹具，不是 previous/）
  {
    const newRoot = INSTALL_DIR
    // 变异：把两个根都指到安装副本 ⇒ 形状必然相同 ⇒ 必须变红
    const oldRoot = isMut('fingerprint-power') ? INSTALL_DIR : FIXTURE_ENGINE
    const fpNew = fingerprintShapeOf(newRoot)
    const fpOld = fingerprintShapeOf(oldRoot)
    const distinct = fpNew.ok && fpOld.ok ? fpNew.shape !== fpOld.shape : false
    // 任何一边判成 unknown ⇒ 这条指纹本来就没法下结论，必须红（不能拿一个「判不出」当「判过了」）
    const unknownSide = fpNew.ok && fpNew.shape === 'unknown' ? '安装副本' : (fpOld.ok && fpOld.shape === 'unknown' ? '旧壳对照根' : null)
    crit('B3b-fingerprint-power', '行为指纹的判定力自证（同一发「必然找不到的读」打两个根，形状必须不同）', {
      expect: `安装副本[${base.install.ok ? base.install.buildStamp : '(读不出)'}] 的形状 ≠ 旧壳对照根[${relRepo(FIXTURE_ENGINE)}] 的形状，且两者都不是 unknown`,
      actual: `安装副本[${relRepo(newRoot)}] = ${fpNew.ok ? fpNew.shape : `(跑不出：${fpNew.why})`}；旧壳对照根[${relRepo(oldRoot)}] = ${fpOld.ok ? fpOld.shape : `(跑不出：${fpOld.why})`}`,
      ok: distinct && unknownSide === null,
      fix: !fpOld.ok
        ? `旧壳对照根跑不出结果（${clip(oneLine(fpOld.why), 120)}）⇒ 没有可比的旧壳那一半：先看 B3a（夹具在不在），再查该根的 aura-read/index.js 能不能 import。`
        : !fpNew.ok
          ? `安装副本跑不出结果（${clip(oneLine(fpNew.why), 120)}）⇒ 连新壳那一半都没读数：先看 A1/A3（安装副本是不是好的），再谈指纹。`
          : unknownSide !== null
            ? `${unknownSide}的回执形状判不出新旧（unknown）⇒ 这条指纹不能用来判生效：先查该根能不能加载 aura-read，再查 shapeOfReceipt 的正则对不对得上。`
            : '两个根的失败回执形状一样 ⇒ 这条指纹区分不了新旧引擎，不能用它判生效：先看 B3a（旧壳对照根是不是真旧壳），再谈换判据。',
      note: fpNew.ok ? `期望读数（新壳 = 正常结果）：${clip(oneLine(fpNew.text), 120)}${fpOld.ok ? `  ｜  旧壳 = ${clip(oneLine(fpOld.text), 90)}` : ''}` : null,
    })
    base.fpNew = fpNew
    base.fpOld = fpOld
  }
  // B4 行为指纹实测（只认哨兵那一发；未观测如实报，不判红）+ B4a/b 哨兵余量（C46 新增）
  {
    const r = engineReadingOf(base)
    const c = base.sentinel
    // 【这一格的期望修过两次，两次都是「期望的来源问错了问题」——两笔都留档】
    //  ①【C58 修的：按**模式名**取期望】原先写 `wantRestart ? 'new' : 'old'`，而跑本段（registerHostCriteria）
    //    的模式里 `--check` 的 wantRestart 恒为 false ⇒ **宿主真重启之后，它还要求哨兵那一发是旧形状**。
    //    2026-10-15 实测：宿主启动 14:44:49、最新哨兵读 14:48:28（重启后发的，shape=new）⇒ B4 当场判红
    //    （--check exit 1，--selftest 另有三条个案跟着红）—— 而这与钩子/引擎无关。
    //  ②【C58 的替代口径仍然不对：拿时间线当行为】C58 把期望改成按**实测时间线**取：
    //    「宿主启动晚于本次安装生效时间 ⇒ new，否则 old」。但时间线只能回答「宿主加载的是**哪一份**」，
    //    回答不了「那一份的回执长什么样」—— 后者必须**现跑那一份**问出来。2026-10-15 真机反例（就是本单）：
    //    宿主启动 14:44:49、本次升级 upgradedAt=17:21:18 ⇒ restartedVsInstall=false ⇒ C58 口径期望 old；
    //    而宿主启动时盘上那份是 previous/（0.6.9，升级时被换下来的），**0.6.9 本来就讲新契约**
    //    （哨兵那一发实测 result:not_found / isError=false）⇒ 期望 old 是错的 ⇒ B4 假红（--check exit 1，
    //    --selftest 五条个案跟着红）。教训与 B2 同源：时间线只用来认「哪一份」，不用来认「那一份的行为」。
    //
    // 【现口径】期望 = 「宿主启动时盘上那一份」的**实测形状**，三支：
    //   ① restartedVsInstall === true ⇒ 宿主启动晚于本次安装生效 ⇒ 它加载的就是 INSTALL_DIR
    //      ⇒ 期望 = base.fpNew.shape（B3b 已经现跑过这一份，**不额外 spawn**）。
    //   ② 否则（宿主启动早于本次安装）⇒ 升级就是在宿主启动之后把盘上那份换下来的，所以启动时在盘上的那份
    //      是 previous/ —— 但只有 previous/ **确实是在宿主启动之后才落盘**时才成立（见 prevTreeCaptureMs：
    //      目录 mtime / package.json 的 mtime·birthtime 三者最大值 > hostStartMs）。这一支**才**现跑
    //      fingerprintShapeOf(PREV_DIR)（常见路径不加子进程）；跑不出来 ⇒ 没有可信期望（走③，不判红）。
    //   ③ 其余 ⇒ 时间线指不出宿主启动时加载的是哪一份：**没有可信期望**，如实报实测形状、不判红。
    //      （不许拿时间线硬凑一个期望出来 —— 那正是 C58 假红的来源。）
    // 【判定力】变异 engine-fingerprint 把派生期望**反过来**：绿要求 r.shape === 派生期望 ⇒ 反过来必红。
    //   没有派生期望时用**实测形状**的反面（连实测都没有才用常量 'old'）—— 不许出现「登记在册却不咬人」的变异。
    const prevCap = prevTreeCaptureMs()
    const hostIso = base.hostStartMs === null ? '未知' : new Date(base.hostStartMs).toISOString()
    const installIso = base.installedAtMs === null ? '未知' : new Date(base.installedAtMs).toISOString()
    const prevIsHostCopy = base.restartedVsInstall === false && base.prev.ok && base.hostStartMs !== null
      && prevCap.ms !== null && prevCap.ms > base.hostStartMs
    /** 现跑出来的那一份 → 与哨兵那一发同一把尺子的新旧判定；没跑成 / 判不出（unknown）一律返回 null。 */
    const shapeVerdictOf = (fp) => (fp !== undefined && fp.ok === true && (fp.verdict === 'old' || fp.verdict === 'new') ? fp.verdict : null)
    /** 那一份为什么给不出判定（追在 derivedWhy 后面，只说清是「没跑成」还是「跑成了但形状判不出」）。 */
    const noVerdictWhy = (fp) => (fp === undefined || fp.ok !== true
      ? `但那一份现跑不出结果（${clip(oneLine(fp?.why ?? '(没跑过)'), 120)}）⇒ 没有可信期望`
      : `但那一份的回执形状判不出新旧（verdict=${fp.verdict ?? 'undefined'}，原始形状 ${fp.shape}）⇒ 没有可信期望`)
    let derived = null
    let derivedWhy = ''
    if (base.restartedVsInstall === true) {
      const fp = base.fpNew
      derived = shapeVerdictOf(fp)
      derivedWhy = `宿主启动（${hostIso}）晚于本次安装生效时间（${installIso}）⇒ 宿主启动时盘上那一份 = 安装副本`
        + (derived === null ? `；${noVerdictWhy(fp)}` : `，形状现跑自 ${relRepo(INSTALL_DIR)}：${derived}`)
    } else if (prevIsHostCopy) {
      const fpPrev = fingerprintShapeOf(PREV_DIR)   // 只在走上这一支时才 spawn（常见路径不加子进程）
      base.fpPrev = fpPrev
      derived = shapeVerdictOf(fpPrev)
      derivedWhy = `宿主启动（${hostIso}）早于本次安装生效时间（${installIso}），而 previous/ 是宿主启动之后才落盘的（${prevCap.witness}）⇒ 宿主启动时盘上那一份 = previous/`
        + (derived === null ? `；${noVerdictWhy(fpPrev)}` : `，形状现跑自 ${relRepo(PREV_DIR)}：${derived}`)
    } else {
      derivedWhy = `时间线指不出宿主启动时加载的是哪一份字节：${base.restartedVsInstall === null ? '宿主启动时间或本次安装生效时间缺失' : `宿主启动（${hostIso}）早于本次安装生效时间（${installIso}）`}`
        + (base.prev.ok ? '' : `；previous/ 读不出（${base.prev.why ?? '目录不在'}）`)
        + (prevCap.ms === null
            ? `；previous/ 的落盘时间读不出（${prevCap.why ?? 'stat 失败'}）`
            : (base.hostStartMs !== null && prevCap.ms <= base.hostStartMs ? `；previous/ 早于宿主启动就已落盘（${prevCap.witness} ≤ ${hostIso}），它认不出宿主加载的那一份` : ''))
    }
    const oppositeShape = (s) => (s === 'new' ? 'old' : s === 'old' ? 'new' : null)
    const measuredShape = r === null ? null : (r.shape === 'old' || r.shape === 'new' ? r.shape : null)
    const expectShape = isMut('engine-fingerprint')
      ? (oppositeShape(derived) ?? oppositeShape(measuredShape) ?? 'old')
      : derived
    const expectLabel = expectShape === 'new' ? '新壳（正常结果 + outcome/code/next）' : expectShape === 'old' ? '旧壳（抛 READ_NOT_FOUND）' : '（无期望：时间线指不出宿主启动时加载的是哪一份）'
    // 未观测不算红（没人发那一发读数不是失败）；没有可信期望也不算红（如实报读数）。
    // 但变异反证要求「必须观测到 / 必须要有个对不上的期望」：那时这两种退化本身就是红。
    const ok = r === null
      ? !isMut('engine-fingerprint')
      : (expectShape === null ? !isMut('engine-fingerprint') : r.shape === expectShape)
    const histNote = c.notes.length === 0 ? '' : `；${c.notes.join('；')}`
    const windowLabel = c.window > 0 ? `${c.window}（只深扫最新的 ${c.window} 个文件）` : '深扫不限（只由字节预算卡）'
    const censusScope = `候选集 ${c.candidates} 个＝索引点名 ${c.knownSentinel} + 本轮深扫 ${c.probed.length}（共 ${c.files} 个会话文件；本轮深扫窗口 ${windowLabel}/字节预算 ${c.budgetMB}MB）`
    const undecidedNote = c.undecided > 0 ? `；另有 ${c.undecided} 发带哨兵串但形状判不出（unknown，不当读数用）` : ''
    // 「哨兵存在但被窗口挤掉」= 确知它存在（索引认过账 / 候选集里确实扫到），但一发都没进窗口。
    // 这就是 2026-10-15 那一格：窗口按 mtime 排，它排到 32 名之外 ⇒ 旧版静默退化成「未观测」并丢掉实测读数。
    const knownSentinelBefore = c.index.ok && c.index.sentinel > 0
    const existsEvidence = c.allHits > 0 || knownSentinelBefore
    const squeezed = existsEvidence && c.hitsInWindow.length === 0
    const loseWhich = (c.excluded.length > 0 ? c.excluded : c.hits).slice(0, 3).map((h) => `${h.file === null || h.file === undefined ? '(未知文件)' : path.basename(path.dirname(h.file))}@${h.mtime}`)
    crit('B4a-sentinel-not-lost', '哨兵余量：那一发存在却一发都没进读数窗口（必须点名，不许静默退回「未观测」）', {
      expect: `候选集里存在的哨兵那一发，读数窗口（${windowLabel}）里至少留一发`,
      actual: c.allHits === 0
        ? (knownSentinelBefore
            ? `✗ 哨兵那一发确实存在（索引记了 ${c.index.sentinel} 份含哨兵的会话），但本轮一发都没读进窗口，而且候选集里也没重读到 ⇒ 读数丢了：被挤掉的是 ${loseWhich.join('、') || '(索引点名的那几份没进候选集)'}`
            : `✓ 全史与索引都没有「aura_read + 参数带哨兵」的那一发（不是被窗口挤掉，是真的还没发过）`)
        : (squeezed
            ? `✗ 存在但被窗口挤掉：候选集命中共 ${c.allHits} 份，窗口内留了 0 份；被挤掉的是 ${loseWhich.join('、')}`
            : `✓ ${c.allHits} 份含哨兵会话全部落在窗口内（窗口 ${c.hitsInWindow.length}/${c.allHits}）`),
      ok: c.allHits === 0 ? !knownSentinelBefore : !squeezed,
      fix: knownSentinelBefore && c.allHits === 0
        ? `候选集里应该一直留着索引点名的含哨兵会话 —— 它没进候选集就是索引或文件不在（索引 ${SENTINEL_INDEX === null ? '本轮被关（--sentinel-index= 空串 / --mutate=sentinel-lost）' : relRepo(SENTINEL_INDEX)}：${c.index.why ?? '在'}）；会话文件被删了就去会话目录里确认，别把「读不到」当「没发生过」。`
        : '把 --sentinel-scan-window 调大（或删掉索引重跑一轮回填），让那个含哨兵的会话进候选集；若它已经被 mtime 挤出有界窗口，索引就是唯一的保障（别把索引删了不重建）。',
      note: `判据分工：这条只判「存在却被丢掉」；「真的还没发过」不算红（没人发那一发不是失败），要强制观测用 --mutate=engine-fingerprint。`,
    })
    noted('B4b-sentinel-census', '哨兵普查口径：候选集怎么来的、深扫了几个、索引记了几份（读数，不计红）', {
      value: `${censusScope}；索引 ${c.index.ok ? `可用（记了 ${c.index.entries} 条，其中含哨兵 ${c.index.sentinel} 份）` : `不可用 — ${c.index.why ?? '不存在'}`}；命中含哨兵会话 ${c.allHits} 份、时间上最新一发 ${c.hits.length === 0 ? '无' : `${c.hits[0].file === null || c.hits[0].file === undefined ? '?' : path.basename(path.dirname(c.hits[0].file))}@${c.hits[0].mtime}`}、进了读数窗口 ${c.hitsInWindow.length} 份${c.index.updated === true ? '；索引已增量更新' : ''}`,
      note: `为什么不用「只读文件头」的便宜全扫：实测哨兵串在压过的字节里 0/8 命中（zstd 帧仅 176–233 字节，哨兵落第 11–842 帧）⇒ 那种探测只会假阴性，不能当「没发过」的证据。`,
    })
    // 那一发是在当前宿主进程启动**之前**还是之后发的 —— 这才是决定性的那次分裂：
    //   after  宿主启动后发的 ⇒ 它记的就是**当前驻留内存的那份字节**，是真正的实测读数。
    //   before 宿主启动前发的 ⇒ 上一代宿主进程的读数，只能当历史参考，不能当「已生效」的证据。
    // 判据就是时间戳比（日志里 time 是 epoch 毫秒，已逐条核过：1791994416630 ↔ 2026-10-14T16:13:36.630Z）。
    const preHost = r !== null && base.hostStartMs !== null && r.time !== null && r.time < base.hostStartMs
    const sinceNote = (r === null || base.hostStartMs === null || r.time === null)
      ? ''
      : (preHost
          ? `；⚠ 这一发早于当前宿主进程启动（${new Date(base.hostStartMs).toISOString()}）⇒ 是上一代宿主的读数，只能当历史参考`
          : `；✅ 这一发晚于当前宿主进程启动（${hostIso}）⇒ 它是**当前宿主进程**造的读数（不是上一代宿主留下的历史读数）—— 时间戳比只能证明「谁造的」，证明不了「那一份讲哪种契约」（后者看期望那栏）`)
    base.engineReadingPreHost = preHost
    crit('B4-engine-fingerprint', `行为指纹实测（${r === null ? '未观测' : r.window}；只认宿主自己造的那一发哨兵读）`, {
      expect: expectShape === null
        ? `无期望（时间线指不出宿主启动时加载的是哪一份字节）⇒ 只如实报实测形状、不判红${isMut('engine-fingerprint') ? '；本轮变异把它当「必须对不上」用' : ''}`
        : `${expectLabel}；期望来源：${derivedWhy}`,
      actual: r === null
        ? `未观测 —— ${censusScope}，候选集里没有「aura_read + 参数带哨兵串 ${ABSENT_TOKEN}」的那一发（别的 aura_read 失败回执一律不当替身：它们两种壳都可能产生，形状判不出新旧）${undecidedNote}${histNote}`
        : `${r.shape}（isError=${r.isError}，via ${r.via}，来自会话 ${r.viaFile ?? '?'}@${r.mtime ?? '无时间戳'}，${r.time === null ? '无时间戳' : new Date(r.time).toISOString()}）正文：${clip(oneLine(r.text), 130)}${sinceNote}${undecidedNote}`,
      ok,
      soft: (r === null || expectShape === null) && !isMut('engine-fingerprint'),
      fix: isMut('engine-fingerprint')
        ? '（--mutate=engine-fingerprint）本轮期望被故意反了过来 ⇒ 本条必须红。若这是真机读数，先按 B2 的时间线与 previous/ 的落盘时间弄清宿主启动时盘上的是哪一份。'
        : expectShape === null
          ? null
          : expectShape === 'new'
            ? `宿主启动时盘上那份 = 安装副本这一份（${derivedWhy}），哨兵那一发却还是旧形状 ⇒ 它加载的不是你以为的那份字节：核对 A1/A3（安装副本）与 profile 那一行指到的路径，再重启。`
            : `宿主启动时盘上那份 = previous/ 这一份（${derivedWhy}），哨兵那一发却是新形状 ⇒ 宿主启动之后有人换过盘上的字节、或有第二个宿主在跑：先弄清是哪一个进程在服务本会话（B1 的 pid）。`,
      note: r === null
        ? `取一发读数：在宿主里调 aura_read(file_path="aura-tools/README.md", mode="search", search="${ABSENT_TOKEN}")，然后重跑本模式。${expectShape === null ? ` ｜ ${derivedWhy}` : ''}`
        : (expectShape === null ? derivedWhy : null),
    })
    base.engineReading = r
  }
}

function registerHookCriteria (base, wantRestart) {
  hr('段C  钩子侧：落地件 / 那一行 / 备份')
  // C1 落地件（四项分开判，便于变异反证逐条打）
  const art = artifactSmoke()
  base.artifact = art
  const st = art.stat
  // C1a：期望**派生自仓库落仓件**（见 shimSourceExpectOf 上方那段：不再手抄字节数/sha）。
  const srcExpect = shimSourceExpectOf(art)
  crit('C1a-artifact-sha', '接线目标（**安装副本**里那份）：**必须存在** + 与仓库落仓件**逐字节相同**（字节数与 sha256 都从仓库那份派生，不手抄）', {
    expect: srcExpect === null
      ? `${relRepo(SHIM)} 必须存在且非空，并与仓库落仓件 ${relRepo(SHIM_SRC)} 逐字节相同 —— 但后者读不出（${art.src.why ?? '不在'}）⇒ 无从对账（判红）`
      : `${relRepo(SHIM)} 必须存在且非空，且 == 仓库落仓件 ${relRepo(SHIM_SRC)}：bytes=${me('artifact-sha', srcExpect.bytes, -1)}  sha256=${me('artifact-sha', srcExpect.sha256, 'deadbeef'.repeat(8))}`,
    actual: st.exists ? `bytes=${st.bytes}  sha256=${st.sha256}` : `**不在**（${st.why}）⇒ 宿主下次组合会 import 失败`,
    ok: st.exists && st.bytes > 0 && srcExpect !== null && st.bytes === srcExpect.bytes && st.sha256 === srcExpect.sha256 && !isMut('artifact-sha'),
    fix: '目标文件不在/被改过：「回滚到没带这个文件的旧版」就是这个形状（宿主下次组合直接失败）。先用 node aura-tools/build/make-bundle.mjs 重建（包必须带 dsh/argv-shell.mjs，且它在 package.json 的 files 里），再装一次（node dist/aura-tools/install.mjs --from dist/aura-tools --yes），**最后**才轮到改 profile 那一行——顺序反了就是一个「指向不存在模块」的组合失败窗口。',
  })
  // C1e：两份**分开说**（与 C1a 同一条不变式，但把两条路径各自的读数都印出来）。
  // 【两条为什么不合并】C1a 说的是「接线目标那一个文件必须是对的」（咬：不在 / 被改一字节 / 换成另一版），
  // C1e 说的是「仓库落仓件与安装副本这两份的关系」（咬：仓库那份被单独改动而安副本没跟上）。
  // 两者的 sha 来源**同一个**（srcExpect 派生自仓库那份）—— 刻意如此：以前 C1a 钉手抄常量、
  // C1e 比两份，执行器一改就出现「C1a 红而 C1e 绿」这种自相矛盾的读数。
  crit('C1e-two-copies', '两份字节分开说：仓库落仓件（生成器落地处）vs 安装副本（接线目标）', {
    expect: '两份都在，且 sha256 相同（期望不再是手抄常量：就是「这两份相等」这条不变式本身）',
    actual: `仓库 ${relRepo(SHIM_SRC)}：${art.src.exists ? art.src.sha256 : `**不在**（${art.src.why}）`}；安装副本 ${relRepo(SHIM)}：${st.exists ? st.sha256 : `**不在**（${st.why}）`}`,
    ok: art.src.exists && st.exists && art.src.sha256 === st.sha256,
    fix: '两份不同 ⇒ 装的是另一个版本（或被人改过）：以生成器（--emit-shim）为准重落仓库那份，重建包再装一次。别在宿主上跑手改版。',
  })
  crit('C1b-artifact-import', '落地件：语法 + **真实 import 一次**（顺序要求：先证可 import，再改行）', {
    expect: `node --check exit=0 且 import 后 default.name === ${me('artifact-import', SHIM_EXPORT_EXPECT)}`,
    actual: art.syntax === null ? '未跑（文件不在）' : `node --check exit=${art.syntax.exit}；import 后 default.name=${art.import?.defaultName ?? `(失败：${art.import?.error ?? '未知'})`}`,
    ok: art.syntax !== null && art.syntax.exit === 0 && art.import?.defaultName === me('artifact-import', SHIM_EXPORT_EXPECT),
    fix: 'import 起不来 ⇒ 绝不能改 profile 那一行（会出现「指向不存在模块」的组合失败窗口）：先修依赖（@deepseek-ai/dsh-shell / schemastery 从 repo 根可达）。',
  })
  crit('C1c-artifact-generator', '落地件 vs 生成器 --emit-shim：逐字节一致', {
    expect: me('artifact-generator', '一致（同一 sha256）', '不一致'),
    actual: art.generator === null ? '未跑' : art.generator.exit !== 0 ? `--emit-shim exit=${art.generator.exit}` : `安装副本 ${art.generator.same ? '一致' : '不一致'} / 仓库那份 ${art.generator.sameSrc === true ? '一致' : art.generator.sameSrc === null ? '不在' : '不一致'}（${art.generator.sha256}）`,
    ok: art.generator !== null && art.generator.same === true && art.generator.sameSrc === true && !isMut('artifact-generator'),
    fix: '落仓件与生成器输出不同 ⇒ 有人手改了落地件：以生成器为准重落，别在宿主上跑手改版。',
  })
  crit('C1d-artifact-tokenize', '落地件：tokenizeArgv 对现网 PreToolUse 命令串的切分', {
    expect: '["node","C:/Users/cxk/.dsh/skills/aurapolaris/tools/hook.mjs","--event=PreToolUse","--host=dsh","--state=workspace"]',
    actual: art.tokenize === null ? '未跑' : JSON.stringify(me('artifact-tokenize', art.tokenize, ['pwsh', '-Command', 'whatever'])),
    ok: art.tokenize !== null && art.tokenize.length === 5 && art.tokenize[0] === 'node' && art.tokenize[2] === '--event=PreToolUse' && !isMut('artifact-tokenize'),
    fix: '切分不对 ⇒ 钩子命令串会被喂错 argv（判定/落账会静默失效）：核对 hook.mjs 的路径与引号写法。',
  })
  // C2 每个带这条组的 profile 的那一行（默认口径 = `--dsh-home` 下全部；`--profile` 是窄口径的那一个）
  const profs = base.profiles
  const groups = profs.filter((x) => x.hasGroup)
  const wireAllowed = me('profile-line', [NEW_LINE.trim()], ["name: '@deepseek-ai/dsh-nonsense-local'"])
  const notWired = groups.filter((x) => !wireAllowed.includes(String(x.nameLine ?? '').trim()))
  const detail = profs.map((x) => `${x.profile}:${x.stateLabel}`).join(' ｜ ')
  crit('C2-profile-line', `宿主 profile 的那一行（${ID_LINE} 的下一行；带这条组的**逐个**判：已接线 / 未接线 / 没有这条组）`, {
    expect: `带这条组的每个 profile 取值都是 ${NEW_LINE.trim()}（本轮扫 ${profs.length} 个 profile：${profs.map((x) => x.profile).join(', ') || '(一个都没有)'}）`,
    actual: groups.length === 0
      ? `没有 profile 带这条组 ⇒ 这条无从对账（不判红）：${detail}`
      : `${groups.length} 个带组、${groups.length - notWired.length} 个已接线${notWired.length > 0 ? `；**未接线**：${notWired.map((x) => `${x.profile}（${x.stateLabel}）`).join('、')}` : ''} ｜ ${detail}`,
    ok: groups.length > 0 && notWired.length === 0,
    soft: groups.length === 0,
    fix: '有 profile 没接上（或那一行还指着**仓库工作区**那份）⇒ 那个 profile 的钩子仍走 pwsh 外层壳税：node aura-tools/probes/activate-and-verify.mjs --apply（不带 --yes 先看精确操作），加 --yes 才真写；每个 profile 各建自己的 .bak-before-argv-shell。',
    note: groups.map((x) => `${x.profile}: ${x.ok ? `L${x.nameLineNo} ${String(x.nameLine ?? '').trim()}` : `读不出（${x.why}）`}`).join(' ； '),
  })
  // C3 备份：**每个 profile 各一份**，与它自己的接线状态自洽
  {
    const rows = groups.map((x) => ({ p: x, bak: snapFile(`${x.file}.bak-before-argv-shell`) }))
    const missing = rows.filter((r) => r.p.wired && !r.bak.exists).map((r) => r.p.profile)
    const stray = rows.filter((r) => !r.p.wired && r.bak.exists).map((r) => r.p.profile)
    crit('C3-backup-state', '备份（回滚点）：每个 profile 各一份，与它自己的接线状态自洽', {
      expect: '已接线的 profile ⇒ 备份必须在；未接线的 profile ⇒ 备份不该在（有则是上次演练留下的）',
      actual: rows.length === 0 ? '没有带这条组的 profile' : rows.map((r) => `${r.p.profile}: ${r.p.stateLabel}，备份${r.bak.exists ? `在（${r.bak.bytes}B sha256=${r.bak.sha256.slice(0, 16)}）` : '不在'}`).join(' ｜ '),
      ok: missing.length === 0,
      soft: missing.length === 0 && stray.length > 0,
      fix: `已接线却没有备份（${missing.join('、') || '—'}）⇒ 回滚只能靠「把那一行改回 pwsh-local」那条不依赖备份的路（--rollback 会打印它）；先补一份备份再继续。`,
    })
    base.backups = rows
    base.backup = (rows.find((r) => r.p.profile === base.profile?.profile) ?? rows[0])?.bak ?? snapFile(`${PROFILE}.bak-before-argv-shell`)
  }
  // C4 钩子进程形状（采样；未采样/未观测都不判红）
  if (WATCH_HOOKS > 0) {
    const w = watchHooks(WATCH_HOOKS)
    base.watch = w
    // 读数（verdict/observed）统一走 carrierReadingOf —— P2 用同一份，两处不再各算一遍。
    const reading = w.reading ?? carrierReadingOf(w)
    // 【这一格的期望从前问错了问题（与 B4 同一类缺陷，C59 只修了注入那一半）】
    //   旧口径：`expectV = restarted ? 'new' : 'old'`，而 `restarted = wantRestart && base.restarted`
    //   = 「宿主启动晚于**本次安装**生效时间」。那是**安装时间线**：它回答「宿主加载的是哪一份包」，
    //   回答不了「钩子命令串由谁承载」—— 承载者由宿主启动时加载的 **profile 那一行**决定
    //   （`polaris-hooks-shell` 的 `name:`），那一行可以在任何一次安装之外被改。
    //   2026-10-15 真机实测（本单的起因）：C4 期望 old（宿主启动 22:44:49 早于 upgradedAt 次日 01:21:18），
    //   而采样读到 runner-wrapper/new —— 因为 profile 那两行（21:37 写的）指的已是 argv-shell.mjs。
    //   旧口径靠 `soft` 把这一格遮成 ⚠（不计红）⇒ 期望错而没人看得见；post-restart 那次运行正是靠它。
    //   现口径：期望只从**盘上的事实**派生（profile 那一行的执行器 + `restartedVsProfile`），见 hostCarrierOf。
    //     ① 宿主启动晚于那一行的 mtime ⇒ 期望 = 那一行蕴含的链（direct/wrapped）；
    //     ② 否则 ⇒ **没有诚实期望**（carrier=null）⇒ 不判红、如实报实测形状。
    const restarted = wantRestart && base.restarted === true
    const cr = base.carrier ?? { carrier: null, verdict: null, why: 'profile 那一行没派生过（本模式没跑 collect）', source: '—' }
    // 【两个词表别搞混】派生那一侧说的是**链的形状**（direct/wrapped），采样读数那一侧说的是**进程形状**
    //   （new/old）。映射**只在 hostCarrierOf 里做一次**（cr.verdict），C4 与 P2 共用同一个值 —— 本单的
    //   穷举证明当场抓到过“两处各写一遍映射”导致的分歧（C4 判绿而 P2 判红，同一份采样两个结论）。
    const derived = cr.carrier
    const expectFromCarrier = cr.verdict ?? null
    const observed = reading.observed
    //   2026-10-15 实测反例：本机钩子链本来就是新路（runner.js 直投 node，采样读数 runner-wrapper/new），
    //   而旧口径的注入值恰好也能取到 new ⇒ `--mutate=hook-process` 退化成「抓到就永绿」的空操作。
    //   现口径：有实测形状时就注入它的**反面**（抓到了就一定对不上）；没抓到（未观测）时靠
    //   `ok: !observed ? !isMut(...)` 强制变红 —— 两条路都不再依赖「猜得准不准」。
    //   `mutated` 另外只用来把 C4 的期望文本标清楚（它不再决定任何 ok/soft）。
    const mutated = isMut('hook-process')
    const measuredCarrier = observed && (reading.verdict === 'old' || reading.verdict === 'new') ? reading.verdict : null
    //   没抓到（未观测）或派生不出期望时，注入值取一个**不可能与实测相等**的哨兵：
    //   原先它退化成了 `reading.verdict`（= 实测形状本身）⇒ 注入值与实测读**一样**，
    //   “期望被改坏”这句话当场变成假的（穷举证明抓到的第二格）。
    const expectV = mutated
      ? (measuredCarrier === 'new' ? 'old' : measuredCarrier === 'old' ? 'new' : '@@MUTATED:不可能与实测相等@@')
      : expectFromCarrier
    const expectText = mutated && measuredCarrier === null
      ? '【注入】期望与实测不可能相等（本轮是变异反证：真机读数看实际）'
      : expectV === 'new' ? 'new = 钩子 node 由宿主直接 spawn（父进程 node，链上没有 pwsh）'
        : expectV === 'old' ? 'old = 钩子命令串仍经 pwsh -Command（父进程 pwsh.exe）'
          : '（无期望：宿主启动早于 profile 那一行 ⇒ 它加载的那一行读不到，不判红）'
    crit('C4-hook-process', `钩子进程形状（采样 ${WATCH_HOOKS}s；谁在承载 hook.mjs）`, {
      expect: `${mutated ? '【注入】' : ''}${expectText} ｜ ${cr.why}（${cr.source}；主 profile ${base.profile?.profile ?? '?'} mtime=${base.profile?.ok === true ? new Date(base.profile.mtimeMs).toISOString() : '读不出'}，宿主启动${base.restartedVsProfile === true ? '晚于' : base.restartedVsProfile === false ? '早于' : '对不上'}它）`,
      actual: `${reading.verdict}；抓到 ${reading.obs.length} 个${reading.obs.length > 0 ? `：${reading.obs.slice(0, 3).map((o) => `${o.name}(pid ${o.pid}, 父 ${o.parentName || '?'}) → ${o.kind}/${o.verdict}`).join('；')}` : ''}${w.ok ? '' : `（${w.why}）`}`,
      // 采样不到不判红（窗口里没有工具调用就没有钩子）；没有诚实期望也不判红（如实报读数）。
      // 但 --mutate=hook-process 要求这两条退化本身必须变红，否则这一格的判定力无从证明。
      ok: !observed ? !mutated : (expectFromCarrier === null ? !mutated : reading.verdict === expectV),
      soft: !mutated && (expectFromCarrier === null || !observed),
      fix: derived === null
        ? '宿主启动早于 profile 那一行 ⇒ 它加载的是哪一行读不到（没有诚实期望）：让宿主重启一次（重启后宿主必然加载盘上这一行），或把本命令与另一条工具调用放进同一个 tool-call 块里再跑一次拿到实测形状。看实测：抓到 pwsh 承载就是旧路，抓到 node 直投就是新路。'
        : '仍抓到 pwsh 承载钩子 ⇒ 那一行没生效：核对 C2（行值）+ 宿主是否在改行之后重启（restartedVsProfile）。',
      note: `${mutated ? '本轮带 --mutate=hook-process：期望文本被改坏，只用来证「改坏就必红」；真机读数看 actual。' : ''}${reading.verdict === '未观测（窗口里没有钩子进程）' ? '采样窗口里没有工具调用就没有钩子：把本命令与**另一条工具调用放进同一个 tool-call 块**再跑一次。' : ''}采样针取 ${w.entry?.source ?? '?'}：${(w.entry?.entries ?? (w.entry?.entry === null || w.entry?.entry === undefined ? [] : [w.entry.entry])).join(' ｜ ') || '(没有可信入口)'}`,
    })
  } else {
    noted('C4-hook-process', '钩子进程形状（本模式没采样；要采样加 --watch-hooks=N）', {
      value: '未采样', note: `采样的判据形状：旧路 = pwsh.exe 承载 hook.mjs 且钩子 node 的父进程是 pwsh.exe；新路 = 钩子 node 的父进程是 node。期望从 profile 那一行的执行器派生（${base.carrier?.source ?? '—'}）。`,
    })
  }
}

function registerRollbackChain (base) {
  hr('段D  回滚链（引擎侧 previous/ + 钩子侧备份）')
  {
    // 期望值从源头派生：install.json.previousVersion（声明）+ previous/ 自己的版本位点。
    // 实测那一侧 = 重算 previous/ 那棵树的戳（treeInfoOf）。判的是「回滚目标 == 安装器声明的上一版」。
    const decl = declaredPrevVersionOf(base.state, base.prev)
    const measured = base.prev.ok ? base.prev.buildStamp : `(不存在/读不出：${base.prev.why ?? '目录不在'})`
    const measuredVer = base.prev.ok ? base.prev.version : null
    const expectRaw = decl === null ? '@@MUTATED@@' : decl.version
    const expect = me('prev-stamp', expectRaw)
    const ok = decl !== null && base.prev.ok && measuredVer === expect
    crit('D1-prev-stamp', '回滚目标 previous/aura-tools 的构建戳（重算，对照安装器声明的回滚目标版本 previousVersion）', {
      expect: decl === null
        ? 'install.json.previousVersion（退路：previous/package.json 的 version）—— 两边都没声明 ⇒ 本条无从对账'
        : `${expect}（期望值来自 ${decl.source}；实测 ${measured}）`,
      actual: decl === null
        ? `${measured}；但状态文件与 previous/package.json 都没声明回滚目标版本（不判红，如实报）`
        : `${measuredVer ?? '(版本读不出)'}${decl.selfReportAgrees ? '' : `（previous/package.json 说自己是 ${decl.selfReport ?? '?'}，与 install.json.previousVersion=${decl.version} 不一致）`}`,
      ok,
      soft: decl === null,
      fix: 'previous/ 不是安装器声明的上一版（或已被换掉）：回滚链断了 —— 从 dist 里取上一版（版本段应为 install.json.previousVersion）包体重装一份把 previous/ 复位，再谈回滚。（注：期望值读自 install.json.previousVersion，不读本文件里的常量。）',
    })
  }
  {
    let differ = null
    /** 两份树里「内容真的变了」的件数：同名且两侧都有哈希、但哈希不同（增/删件不算）。 */
    let contentChanged = null
    if (base.prev.ok && base.install.ok) {
      const names = new Set([...Object.keys(base.prev.files), ...Object.keys(base.install.files)])
      differ = 0
      contentChanged = 0
      for (const n of names) {
        if (base.prev.files[n] === base.install.files[n]) continue
        differ++
        if (typeof base.prev.files[n] === 'string' && typeof base.install.files[n] === 'string') contentChanged++
      }
    }
    // 三条**自洽**不变式，没有一条钉版本号、也没有一条钉件数：
    //   ① previous/ 的版本 == 状态文件声明的 previousVersion；
    //   ② 两份树必须真的不同（差异件数 > 0）—— previous/ 与安装副本同源时「回滚」等于什么都没换；
    //   ③ 差异件数 ≥ 同一对树里内容真的变了的件数 —— 门槛**就地派生**（见上面那段长注释）。
    const declPrev = declaredPrevVersionOf(base.state, base.prev)
    const measuredPrevVer = base.prev.ok ? base.prev.version : null
    const versionOk = declPrev === null ? null : measuredPrevVer === declPrev.version
    const differOk = differ === null ? null : differ > 0
    /**
     * 门槛就地派生，但**仍要留一个可注入的点**：`prev-differs` 是一个既有的 mutation id
     * （见上面 MUT_IDS 与 `--selftest` 里那条 `{ mut: 'prev-differs', red: 'D2-prev-differs' }`）。
     * 删掉手抄件数时如果把 `me(...)` 一起删了，这个 mutation 会变成**永绿的空操作**——
     * 一条登记在册、实际不咬人的判据（本仓已因为这类事裁过一次）。
     * 所以注入落在**门槛**上：注一个不可能达到的下限 ⇒ `floorOk` 变 false ⇒ D2 红。
     *
     * 【C59 修掉的缺陷：派生门槛自己多加了 1】这里原先写的是 `contentChanged + 1`，于是判据实际查的是
     *   「差异件数 ≥ 内容实变数 **+ 1**」—— 与它上面那条不变式③（差异件数 ≥ 内容实变数）以及本判据
     *   自报的期望文本（「未注入时应 == 内容实变数」）**互相矛盾**。而 contentChanged 按定义是 differ 的
     *   子集：只要两份树没有增/删件（differ === contentChanged），`differ >= contentChanged + 1` 必然为假
     *   ⇒ 硬红。2026-10-15 真机实测：differ=7、contentChanged=7、增/删 0 件 ⇒ 门槛 8 ⇒ 7 >= 8 假
     *   ⇒ D2 硬红（--check 与 --selftest 里五条个案跟着红），而安装副本与回滚点其实都没问题 —— 纯假红。
     *   修法：派生门槛**就是**那条被文档化的不变式 `differ >= contentChanged`（无 +1），不许比它更严。
     */
    const derivedFloor = contentChanged === null ? null : contentChanged
    // 注入值必须**是数字且不可能达到**：`me()` 的缺省坏值是字符串 '@@MUTATED@@'，
    // 直接当门槛用会让 `differ >= floor` 永远为 true（NaN 比较恒 false ⇒ 其实会红，
    // 但形状含糊）；而早先 `me(id, N, 0)` 那种「坏值 = 0」反而是最安全的数——
    // `differ >= 0` 恒真，等于注入了个空操作（本仓已因这类事裁过一次）。
    // 所以传 `differ + 1`：**比实测差异数还大 1** —— 这是唯一与「两份树到底差了几件」无关的注入形状。
    // （早先传的是 `contentChanged + 2`，它默认了「增/删件恰好 1 件」；一旦两份树多差一件，
    //  `differ` 就等于那个门槛，注入退化成空操作 —— 本文件的合成环境第一次就撞上了这一格。）
    const floor = me('prev-differs', derivedFloor, differ === null ? 0 : differ + 1)
    const floorOk = differ === null || floor === null ? null : differ >= floor
    const whyD2 = []
    if (versionOk === false) whyD2.push(`previous/ 的版本是 ${measuredPrevVer ?? '(读不出)'}，不是状态文件声明的 ${declPrev.version}`)
    if (differOk === false) whyD2.push('两份树逐字节同源 ⇒ 回滚过去等于没回滚')
    if (floorOk === false) whyD2.push(`差异件数 ${differ} 小于门槛 ${floor}（门槛就地派生 + mutation 注入；未注入时应 == 内容实变数 ${contentChanged}）`)
    crit('D2-prev-differs', 'previous/ 与安装副本不同源（>0 = 回滚真的会换掉东西）+ 版本自洽（= 状态文件声明的 previousVersion）+ 差异数不小于内容实变数', {
      expect: 'previous/ 版本 == 状态文件声明的 previousVersion；差异件数 > 0；且差异件数 ≥ 同一对树里内容真的变了的件数（门槛就地派生，本文件不再手抄件数）',
      actual: differ === null
        ? '（有一边读不出）'
        : `${differ} 件不同（其中内容实变 ${contentChanged} 件、增/删 ${differ - contentChanged} 件）；previous/ 版本 ${measuredPrevVer ?? '(读不出)'} vs 状态声明 ${declPrev === null ? '(未声明)' : declPrev.version}`,
      ok: versionOk !== false && differOk !== false && floorOk !== false,
      soft: differ === null,
      fix: `两份同源 ⇒ previous/ 不是旧引擎，回滚过去等于没回滚：先弄清楚升级流程写 previous/ 的那一步为什么没生效。${whyD2.length > 0 ? `（实测：${whyD2.join('；')}）` : ''}（件数本身不判红 —— 它随版本变；判红的是上面三条不变式。）`,
    })
  }
  {
    const marker = me('rollback-path', 'swapWithPrevious', 'NO_SUCH_ROLLBACK_PATH')
    const src = readText(INSTALLER)
    const hits = src.ok ? countOf(src.text, marker) : 0
    crit('D3-rollback-path', '安装器里的回滚路径（只读 grep，不执行）', {
      expect: `install.mjs 里出现 ${marker}`,
      actual: src.ok ? `${hits} 处` : `install.mjs 读不出：${src.why}`,
      ok: hits > 0,
      fix: '安装器里没有回滚路径 ⇒ 只能手工对调 previous/ 与安装目录（风险高）：先把两边树哈希记档再动手。',
      note: '真跑一遍只读预检（--rollback --dry-run）用：--post-restart --run=rollback-dryrun',
    })
  }
}

function registerClockCriteria (base) {
  hr('段E  墙钟口径（重启后要拿同一口径对照的基线）')
  const h = base.hooksAll
  noted('E1-host-hook-p50', '宿主自己的账：hook/result.durationMs（point=PreToolUse，会话日志全史）', {
    value: h.n === 0 ? `不可用（扫了 ${base.sessionsAll.files} 个会话文件、${base.sessionsAll.scanned.length} 个在预算内，没有 PreToolUse 记录）` : `n=${h.n}  p50=${r1(h.p50)}ms  p90=${r1(h.p90)}ms  min=${r1(h.min)}ms  max=${r1(h.max)}ms`,
    note: `任务书语料 p50=${PRE_TOOL_CITED}ms（n=58,139）；本机读数与之同量级即为同一口径。`,
  })
  const g = base.guard
  noted('E2-hook-internal-p50', '钩子自己的账：pre_tool.ms（.polaris/polaris-guard.log.jsonl）', {
    value: g.exists ? `记录 ${g.preTool} 条  p50=${r1(g.p50)}ms  p90=${r1(g.p90)}ms  min=${r1(g.min)}ms  max=${r1(g.max)}ms  判定分布 ${JSON.stringify(g.verdicts)}` : '不可用（账本不在）',
  })
  const tax = h.n > 0 && g.exists && g.p50 !== null ? h.p50 - g.p50 : null
  noted('E3-shell-tax', '外层壳税 = E1 - E2（重启后这一格应当塌掉）', {
    value: tax === null ? '不可算（缺 E1 或 E2）' : `≈ ${r1(tax)}ms（占宿主侧 ${h.p50 === 0 ? '—' : Math.round((tax / h.p50) * 100)}%）`,
    note: '重启后合格线：宿主侧 p50 < 200ms；越过 450ms 判红（壳税还在）。',
  })
}

/**
 * 段G（C57 新增）：`--check` 的副作用账 —— 把「只读」这句**自述**变成**实测判据**。
 *
 * A5-home-untouched：`~/.aura`（+ `AURA_CACHE_DIR`）整棵树，跑前跑后逐件比 哈希+字节数+mtime，差异必须 0。
 * 反空过：两轮快照一件都没比到（目录不在 / 读不出）同样判红 ——「没比到」不等于「没变化」。
 * 判定力：--mutate=home-readonly 把期望值改成 1 ⇒ 本条必须变红（--selftest 用例同）。
 * 只装在 `--check` 上：--post-restart 的 --run= 会真跑安装器的 --rollback --dry-run 等外部件，
 * 那些件的写入不在本条的保证范围内，混在一起会变成假红。
 */
function registerSideEffectCriteria () {
  hr('段G  副作用账：自述的「只读」是不是真的（C57）')
  const after = watchSnapshot()
  watchT1 = Date.now()
  const allRows = watchDiff(HOME_WATCH_BEFORE, after)
  const { inside: rows, outside } = attributeWatchRows(allRows)
  const compared = Object.keys(HOME_WATCH_BEFORE).length
  const comparedAfter = Object.keys(after).length
  // 【注入值必须是**不可能达到**的】原先注入的是 1（`me('home-readonly', 0, 1)`）——
  //   它的本意是「把 0 件改成 1 件」，但 1 是**实测真能取到的值**：只要跑这一轮的窗口里
  //   有**别人**在写 ~/.aura（比如安装器正在写 ~/.aura/pkg/install.json），`rows.length` 就是 1
  //   ⇒ `rows.length === expect` 成立 ⇒ 这一格反而变绿。实测：01:57 那一轮（安装器活跃）标了 ✓，
  //   02:22 那一轮（~/.aura 安静）标了 ✗ —— 一条已登记的变异随别人写不写盘时红时绿。
  //   这与本文件已有两处教训同源（D2 的门槛、C4 的注入值）：注入值必须与「被观测的那件事」无关。
  //   「变化件数」是**非负整数** ⇒ -1 是唯一与实测天然互斥的注入值（0 也红、1 也红）。
  //   注意：这条**不允许**用 `compared + 1` 那种就地派生的注入——`compared` 恒 == rows.length 的上界，
  //   安静时同样撞上（0+1 = 1 就是原来那个坑的翻版）。
  const expect = me('home-readonly', 0, -1)
  const empty = compared === 0 || comparedAfter === 0
  const trees = HOME_WATCH.map((d) => relRepo(d)).join('、')
  crit('A5-home-untouched', '`--check` 的只读自述（实测）：~/.aura 整棵树跑前跑后逐件比 哈希+字节数+mtime', {
    expect: `${expect} 件变化（只读 ⇒ 0；新建/删除/改内容/同字节重写，任何一种都会红）`,
    actual: empty
      ? `没比到任何文件（跑前 ${compared} 件 / 跑后 ${comparedAfter} 件；被观测的树：${trees}）`
      : `${rows.length} 件变化（跑前 ${compared} 件 / 跑后 ${comparedAfter} 件；被观测的树：${trees}）${rows.length === 0 ? '' : `；${rows.slice(0, 5).map((r) => `${r.file}（${r.before} → ${r.after}）`).join('  ')}`}`
        + (outside.length === 0
          ? ''
          : `｜另有 ${outside.length} 件变化不计入（已逐件归因）：${outside.slice(0, 3).map((r) => `${r.file}（${r.why}）`).join('  ')}`),
    ok: !empty && rows.length === expect,
    fix: rows.length > 0
      ? '本脚本在 --check 里动了被观测的树 —— 这是它自述「只读」的反例，必须当场定位：先看结尾「写盘清单」里有没有这一件。'
        + '若变化的是 observations.json，先分清是谁写的：独立面 CLI/MCP（aura / aura-mcp，每次调用都是新进程）本来就会写它，'
        + '用 `node "<prefix>/node_modules/aura-tools/bin/aura.mjs" read --file <file>` 单独跑一发就能复现；'
        + '排掉外部写者之后仍复现 ⇒ 是本脚本的 bug：改掉写它的那条路径，别改判据。'
      : '被观测的树一件都没比到（目录不在 / 读不出）：这条判据正在空过 —— 先查 ~/.aura 是否存在、--dsh-home/--prefix 是否指向了别处。',
    note: '口径：比 哈希+字节数+mtime（同字节重写也算一次写盘）；不比 atime（读一次就会动它）。'
      + ' `~/.aura/observations.json` 的**正当写者**是独立面（`src/aura-standalone/lib/ops.mjs` → `createDiskStore()`），'
      + '不是本脚本；本脚本从不 spawn 独立面。'
      + ` 另：跑在活宿主里时，\`~/.aura/pkg/.cache/aura-hook-inproc.json\` 由**宿主**每次工具调用重写一次 ——`
      + ' 这类**修改时间早于本次快照**的变化不计入（它们不可能是本进程产生的）；窗口内照旧一件都算。',
  })
  return after
}

// ═════════════════════════════════════════════════════════════════════════════
// §6 模式：--check
// ═════════════════════════════════════════════════════════════════════════════
function runCheck () {
  const base = collect()
  registerInstallCriteria(base, false)
  registerHostCriteria(base, false)
  registerHookCriteria(base, false)
  registerRollbackChain(base)
  registerClockCriteria(base)
  // C57：副作用账排在所有探测之后 —— 它的「跑后」快照必须覆盖本轮的全部 spawn。
  registerSideEffectCriteria()
  hr('段F  就绪度：现在能做什么、重启后验什么')
  const groups = base.profiles.filter((x) => x.hasGroup)
  const unwired = groups.filter((x) => !x.wired)
  const wired = groups.length > 0 && unwired.length === 0
  const engineReady = base.restarted === true
  const r = base.engineReading
  say(` · 引擎侧：${engineReady ? '时间线上已生效' : '未生效（宿主启动早于安装）'}${r === null ? '；行为指纹未观测（哨兵那一发还没发过）' : `；行为指纹实测 = ${r.shape}（${r.window}）`}`)
  say(` · 钩子侧：${groups.length === 0 ? '没有 profile 带这条组（无从接线）' : wired ? `${groups.length} 个带这条组的 profile 全部已接线` : `未接线：${unwired.map((x) => `${x.profile}（${x.stateLabel}）`).join('、')}`}${base.watch !== undefined && base.watch.ok ? `；采样判定 = ${base.watch.obs.length === 0 ? '未观测' : base.watch.obs.some((o) => o.verdict === 'old') ? 'old' : 'new'}` : ''}`)
  say(` · profile 逐个：${base.profiles.map((x) => `${x.profile}=${x.stateLabel}`).join(' ｜ ') || '(一个都没扫到)'}`)
  say(' · 下一步（三件，按顺序）：')
  if (!wired) say(`     ① 接线：node aura-tools/probes/activate-and-verify.mjs --apply            # 先看 dry-run 的精确操作（默认把${groups.length}个带这条组的 profile 全接上）`)
  if (!wired) say(`        （要真写加 --yes —— 会写 ${unwired.map((x) => x.file).join('、') || '(本轮没有要写的)'}；只处理这一个 profile 用 --profile=<path>）`)
  else say('     ① 接线：已完成（C2 = 带这条组的 profile 全部已接线）')
  say('     ② 重启宿主（会终止本会话，必须由人在会话边界做）：')
  say('        Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*dsh*bin.js*web*\' } | Select-Object ProcessId,CreationDate')
  say('     ③ 重启后：node aura-tools/probes/activate-and-verify.mjs --post-restart [--watch-hooks=20]')
  say('')
  say(' · 三条测量线（C29 已交付；真跑用 --post-restart --run=failure-replay,success-regression,residual-census）：')
    say('     node aura-tools/src/locator-lab/failure-replay.mjs        # 期望 exit 0')
  say('     （三条我都用 --run 真跑过：exit 0；见 --post-restart 清单 P5 的逐条命令与期望读数）')
  say('     node aura-tools/probes/success-regression.mjs             # 期望 exit 0')
  say('     node aura-tools/probes/residual-census.mjs                # 期望 exit 0')
  return base
}

// ═════════════════════════════════════════════════════════════════════════════
// §7 模式：--apply / --rollback（默认 dry-run；--yes 才真写）
// ═════════════════════════════════════════════════════════════════════════════
/** `from` 默认是 pwsh-local 那一行；profile 错位接线时传它当前那一行（同样是字面替换，不是正则）。 */
const PS_APPLY = (P, S, from = OLD_LINE) => [
  `$P='${P}'; $S='${S}'`,
  `if (-not (Test-Path "\${P}.bak-before-argv-shell")) { Copy-Item $P "\${P}.bak-before-argv-shell" }`,
  '$t=[IO.File]::ReadAllText($P)',
  `$n=$t.Replace("${from}", "name: '$S'")`,
  `if ($n -eq $t) { throw 'APPLY: 目标行没有变化（profile 里已经不是那一行？）' }`,
  '[IO.File]::WriteAllText($P, $n, [Text.UTF8Encoding]::new($false))',
  `Select-String -Path $P -Pattern 'polaris-hooks-shell' -Context 0,1`,
].join('; ')
const PS_ROLLBACK_BAK = (P) => [
  `$P='${P}'`,
  `Copy-Item "\${P}.bak-before-argv-shell" "$P" -Force`,
  '(Get-FileHash -Algorithm SHA256 "$P").Hash.ToLower()',
].join('; ')
const PS_ROLLBACK_NOLINE = (P, S) => [
  `$P='${P}'; $S='${S}'`,
  '$t=[IO.File]::ReadAllText($P)',
  `[IO.File]::WriteAllText($P, $t.Replace("name: '$S'", "${OLD_LINE}"), [Text.UTF8Encoding]::new($false))`,
  `Select-String -Path $P -Pattern 'polaris-hooks-shell' -Context 0,1`,
].join('; ')

function runApply () {
  hr('段B  --apply：将要执行的精确操作')
  say(` 模式：${YES ? '**真执行（--yes）**' : 'dry-run（不带 --yes ⇒ 一个字节都不写）'}`)
  say(` 范围：${PROFILE_ARG === '' ? `扫 ${PROFILES_DIR} 下**所有** profile（本轮 ${PROFILE_FILES.length} 个）` : `只处理 --profile 指定的这一个：${PROFILE}`}`)
  say('')
  const base = collect()
  // 前置①：先证**接线目标**（安装副本那份）可 import（顺序写死：证书在前，改行在后）
  const art = artifactSmoke()
  base.artifact = art
  // 期望同样派生自仓库落仓件（不再手抄 sha；安装副本那一份由 `generator.sameSrc` 那两条与它对齐）。
  const srcExpect = shimSourceExpectOf(art)
  const importOk = art.syntax?.exit === 0 && art.import?.defaultName === me('artifact-import', SHIM_EXPORT_EXPECT) &&
    srcExpect !== null && art.stat.sha256 === me('artifact-sha', srcExpect.sha256, 'deadbeef'.repeat(8)) &&
    art.generator?.same === true && art.generator?.sameSrc === true
  crit('AP-pre-artifact', '前置①：接线目标（安装副本）存在 + 语法 + 真实 import + 与仓库落仓件/生成器逐字节一致', {
    expect: `${relRepo(SHIM)} sha256=${(srcExpect === null ? '(仓库那份读不出)' : me('artifact-sha', srcExpect.sha256, 'deadbeef'.repeat(8)).slice(0, 16))}…  import 后 default.name=${me('artifact-import', SHIM_EXPORT_EXPECT)}  两份都与 --emit-shim 一致`,
    actual: `bytes=${art.stat.bytes ?? '—'} sha256=${(art.stat.sha256 ?? '—').slice(0, 16)}…  node --check exit=${art.syntax?.exit ?? '—'}  import=${art.import?.defaultName ?? `失败(${art.import?.error ?? '未知'})`}  --emit-shim 一致：安装副本=${art.generator?.same ?? '未跑'} 仓库=${art.generator?.sameSrc ?? '未跑'}`,
    ok: importOk,
    fix: '接线目标没证住 ⇒ 拒绝改任何一行（会出现「指向不存在模块」的組合失败窗口）：先用 node aura-tools/build/make-bundle.mjs 重建并装一次（包必须带 dsh/argv-shell.mjs），再回来 --apply。',
  })
  // 前置②：每个带这条组的 profile 各有一个可写取值（已接线 = 幂等空操作也箿可写）
  const groups = base.profiles.filter((x) => x.hasGroup)
  const writable = me('line-apply', ['wired', 'unwired', 'misrouted'], ['nonsense-state'])
  const plans = groups.map((x) => ({
    pf: x,
    act: x.state === 'wired' ? '幂等空操作（已是新值，不写盘）'
      : x.state === 'unwired' ? `替换 ${OLD_LINE.trim()} → ${NEW_LINE.trim()}`
        : x.state === 'misrouted' ? `替换 ${String(x.cur ?? '').slice(0, 60)}（指向仓库工作区）→ ${NEW_LINE.trim()}`
          : '拒绝（取值不认识，先人工看一眼那一行）',
  }))
  const badProfs = groups.filter((x) => x.idCount !== 1 || !writable.includes(x.state))
  crit('AP-pre-line', '前置②：每个带这条组的 profile 各有一处可写的取值（id 出现且仅出现一次）', {
    expect: `带这条组的每个 profile 取值属于 {${writable.join(' | ')}}，且 ${ID_LINE} 各出现一次（共 ${groups.length} 个带组）`,
    actual: groups.length === 0
      ? `没有 profile 带这条组（${base.profiles.map((x) => `${x.profile}:${x.stateLabel}`).join(' ｜ ')}）`
      : plans.map((r) => `${r.pf.profile}: L${r.pf.nameLineNo ?? '?'} ${String(r.pf.cur ?? '(读不出)')} ⇒ ${r.act}（id×${r.pf.idCount}）`).join(' ｜ '),
    ok: groups.length > 0 && badProfs.length === 0,
    fix: '有 profile 的目标行与期望不符（第三种取值）⇒ 先 --rollback（dry-run）看清状态；不要盲写：写错一行等于把别的插件的 shell 换掉。',
  })
  // 前置③：备份（每个 profile 各一份）
  const baks = groups.map((x) => ({ pf: x, bak: snapFile(`${x.file}.bak-before-argv-shell`) }))
  base.backups = baks
  crit('AP-pre-backup', '前置③：每个 profile 各一份备份（回滚点）的处置', {
    expect: '不存在则先逐字节复制一份；已存在则原样保留（不覆盖已被改过的备份）',
    actual: baks.length === 0 ? '没有要写的 profile' : baks.map((r) => `${r.pf.profile}: ${r.bak.exists ? `已在（${r.bak.bytes}B sha256=${r.bak.sha256.slice(0, 16)}…）⇒ 保留不动` : '不在 ⇒ 本次会先建'}`).join(' ｜ '),
    ok: groups.every((x) => x.ok),
    fix: 'profile 读不出：确认 --dsh-home/--profile 指对。',
  })
  const preOk = reds().length === 0
  say('')
  say(' 【将要执行的操作（精确到行 / 字节 / 路径）】')
  for (const r of plans) {
    const x = r.pf
    const bak = baks.find((b) => b.pf.file === x.file)?.bak
    say(`   ── ${x.profile}`)
    say(`   文件      : ${x.file}`)
    say(`   行号      : L${x.nameLineNo ?? '?'}（1-based；由 ${ID_LINE} 的下一行定位，不经全文盲替换）`)
    say(`   替换前    : ${String(x.cur ?? '(读不出)')}`)
    say(`   替换后    : ${NEW_LINE.trim()}`)
    say(`   动作      : ${r.act}`)
    say(`   备份      : ${x.file}.bak-before-argv-shell${bak?.exists ? '（已在，保留）' : '（不在，写入前先建）'}`)
    say(`   行尾/BOM  : LF=${x.lf} / CRLF=${x.crlf} / BOM=${x.bom ? '有' : '无'}（原样保留，不重编码）`)
    if (x.state === 'misrouted') say('   注        : 这一行原来指**仓库工作区**那份：本次是把接线从仓库挪到包里（同一套字节，但不再依赖仓库在不在）。')
    say(`   等价手工命令: ${x.state === 'wired' ? '(无需执行——已是新值)' : PS_APPLY(x.file, SHIM, x.cur)}`)
    say(`   回滚命令  : ${PS_ROLLBACK_BAK(x.file)}`)
    say(`              ${PS_ROLLBACK_NOLINE(x.file, SHIM)}`)
  }
  say('')
  say('   本脚本路径: 读入全部字节 → 定位唯一一处「替换前」→ 只把这一段换成「替换后」→ 其余字节原样写回')
  say(`   真执行开关: --yes（本行没有它 ⇒ 上面这些只是打印，没有写盘）`)
  if (!preOk) {
    say('')
    say('   ✗ 前置判据有红 ⇒ **拒绝执行**（即使带 --yes）：先把上面点名的修法做掉。')
    return base
  }
  if (!YES) {
    say('')
    say('   ✓ 前置全绿、操作已打印完毕；dry-run 到此为止（exit 0）。')
    return base
  }
  // ── 真执行（--yes）：每个带组的 profile 各一份备份、各自回读 ──
  hr('段B-2  真执行（--yes）')
  const results = []
  for (const x of groups) {
    if (x.state === 'wired') {
      say(` ${x.profile}: 已是新值 ⇒ 幂等空操作，未写盘。`)
      results.push({ pf: x, wrote: false, same: true })
      continue
    }
    const bakPath = `${x.file}.bak-before-argv-shell`
    const preBuf = fs.readFileSync(x.file)
    if (!fs.existsSync(bakPath)) {
      const wrote = hostWrite(bakPath, `APPLY 步骤 1/3：逐字节备份（${x.profile}）`)
      fs.copyFileSync(x.file, wrote)
      say(` ${x.profile} 步骤 1/3 备份：${wrote}（${preBuf.length} 字节，sha256=${sha256buf(preBuf).slice(0, 16)}…）`)
    } else {
      say(` ${x.profile} 步骤 1/3 备份：已在，原样保留`)
    }
    const from = String(x.cur ?? '')
    const idx = preBuf.indexOf(Buffer.from(from, 'utf8'))
    if (idx < 0) throw new Error(`APPLY：写入阶段找不到目标串（${x.profile} 在本进程读它之后被改过？）—— 未写盘`)
    const after = Buffer.concat([preBuf.subarray(0, idx), Buffer.from(NEW_LINE, 'utf8'), preBuf.subarray(idx + Buffer.byteLength(from, 'utf8'))])
    const profPath = hostWrite(x.file, `APPLY 步骤 2/3：写回 profile（${x.profile}）`)
    fs.writeFileSync(profPath, after)
    say(` ${x.profile} 步骤 2/3 写回：${profPath}（${preBuf.length} → ${after.length} 字节）`)
    const back = fs.readFileSync(x.file)
    const roundTrip = Buffer.concat([back.subarray(0, idx), Buffer.from(from, 'utf8'), back.subarray(idx + Buffer.byteLength(NEW_LINE, 'utf8'))])
    const same = roundTrip.equals(preBuf)
    const line = String(nthLine(back.toString('utf8'), x.nameLineNo)).trim()
    say(` ${x.profile} 步骤 3/3 回读：sha256=${sha256buf(back).slice(0, 16)}…  「把新值换回原值后与写前逐字节相等」=${same}；行值=${line}`)
    results.push({ pf: x, wrote: true, same, line })
  }
  crit('AP-write-verify', '真执行后自检（每个 profile 各自回读 + 往返逐字节）', {
    expect: '每个被写的 profile：那一行 = 新值，且「新值→原值」回替换后与写前字节逐字节相等',
    actual: results.length === 0 ? '没有带这条组的 profile' : results.map((r) => `${r.pf.profile}: ${r.wrote ? `往返相等=${r.same} 行值=${String(r.line).slice(0, 60)}` : '幂等空操作'}`).join(' ｜ '),
    ok: results.every((r) => r.same === true && (!r.wrote || String(r.line).trim() === NEW_LINE.trim())),
    fix: '往返不等 ⇒ 立刻用上面第一条回滚命令还原（备份是逐字节的），并把读数留档。',
    note: `被写 ${results.filter((r) => r.wrote).length} 个 / 幂等空操作 ${results.filter((r) => !r.wrote).length} 个`,
  })
  return base
}

function runRollback () {
  hr('段B  --rollback：将要执行的精确操作')
  say(` 模式：${YES ? '**真执行（--yes）**' : 'dry-run（不带 --yes ⇒ 一个字节都不写）'}`)
  say(` 范围：${PROFILE_ARG === '' ? `扫 ${PROFILES_DIR} 下**所有** profile（本轮 ${PROFILE_FILES.length} 个）` : `只处理 --profile 指定的这一个：${PROFILE}`}`)
  say('')
  const base = collect()
  const groups = base.profiles.filter((x) => x.hasGroup)
  // 三种已知取值都箿「有对象可回滚/幂等空操作」：错位接线（仓库路径）也在其中 —— 它正是要撤掉的那一种。
  const allowed = me('line-rollback', ['wired', 'unwired', 'misrouted'], ['nonsense-state'])
  const rows = groups.map((x) => ({ pf: x, bak: snapFile(`${x.file}.bak-before-argv-shell`) }))
  base.backups = rows
  const bad = groups.filter((x) => x.idCount !== 1 || !allowed.includes(x.state))
  crit('RB-state', '回滚对象：每个带这条组的 profile 那一行都属于已知状态', {
    expect: `取值属于 {${allowed.join(' | ')}}（wired / unwired / misrouted 三种都认识）`,
    actual: groups.length === 0
      ? `没有 profile 带这条组（${base.profiles.map((x) => `${x.profile}:${x.stateLabel}`).join(' ｜ ')}）`
      : groups.map((x) => `${x.profile}: L${x.nameLineNo ?? '?'} ${x.stateLabel}`).join(' ｜ '),
    ok: groups.length > 0 && bad.length === 0,
    fix: '取值不认识 ⇒ 先人工看一眼那一行（它决定钩子经不经 shell）：不要盲写，先把当前值抄进回执。',
  })
  say(' 【将要执行的操作（精确到行 / 路径）】')
  for (const r of rows) {
    const x = r.pf
    const plan = x.state === 'unwired' ? '无需回滚：那一行已经是 pwsh-local（幂等空操作，不写盘）'
      : r.bak.exists ? `备份优先：用 ${x.file}.bak-before-argv-shell 逐字节覆盖回去（sha256 回到 ${r.bak.sha256.slice(0, 16)}…）`
        : `备份不在：用「把当前的${x.stateLabel}换回 pwsh-local」的等价最小回滚`
    say(`   ── ${x.profile}`)
    say(`   文件      : ${x.file}`)
    say(`   行号      : L${x.nameLineNo ?? '?'}`)
    say(`   当前值    : ${String(x.cur ?? '(读不出)')}`)
    say(`   目标值    : ${OLD_LINE.trim()}`)
    say(`   计划      : ${plan}`)
    say(`   备份      : ${x.file}.bak-before-argv-shell${r.bak.exists ? `（在，${r.bak.bytes}B）` : '（不在）'}`)
    say(`   等价手工命令: ${PS_ROLLBACK_BAK(x.file)}`)
    say(`              ${PS_ROLLBACK_NOLINE(x.file, SHIM)}`)
  }
  say('   落地件    : 不回滚（没人指向它就不会被 import；留着便于再接线）')
  say(`   真执行开关: --yes（本行没有它 ⇒ 只打印）`)
  if (reds().length > 0) { say('   ✗ 前置红 ⇒ 拒绝执行。'); return base }
  if (!YES) { say('   ✓ dry-run 完毕（exit 0）。'); return base }
  hr('段B-2  真执行（--yes）')
  const out = []
  for (const r of rows) {
    const x = r.pf
    if (x.state === 'unwired') {
      say(` ${x.profile}: 无需回滚（已是 pwsh-local），未写盘。`)
      out.push({ pf: x, how: '无操作', ok: true, line: OLD_LINE.trim() })
      continue
    }
    const before = fs.readFileSync(x.file)
    let after
    let how
    if (r.bak.exists) {
      after = fs.readFileSync(`${x.file}.bak-before-argv-shell`)
      how = '备份逐字节覆盖'
    } else {
      const from = String(x.cur ?? '')
      const i = before.indexOf(Buffer.from(from, 'utf8'))
      if (i < 0) throw new Error(`ROLLBACK：找不到目标串（${x.profile}）—— 未写盘`)
      after = Buffer.concat([before.subarray(0, i), Buffer.from(OLD_LINE, 'utf8'), before.subarray(i + Buffer.byteLength(from, 'utf8'))])
      how = `等价最小回滚（${x.stateLabel} → pwsh-local）`
    }
    fs.writeFileSync(hostWrite(x.file, `ROLLBACK：写回 profile（${x.profile}）`), after)
    const back = fs.readFileSync(x.file)
    const line = String(nthLine(back.toString('utf8'), x.nameLineNo)).trim()
    const ok = line === OLD_LINE.trim() && (!r.bak.exists || sha256buf(back) === r.bak.sha256)
    say(` ${x.profile}: ${how}；回读 sha256=${sha256buf(back)}；行值=${line}`)
    out.push({ pf: x, how, ok, line })
  }
  crit('RB-write-verify', '真执行后自检（每个 profile 各自回读）', {
    expect: `每个 profile 那一行 = ${OLD_LINE.trim()}；有备份的还要 sha256 逐字节回到备份`,
    actual: out.length === 0 ? '没有带这条组的 profile' : out.map((r) => `${r.pf.profile}: ${r.how}；行值=${String(r.line ?? '(无操作)').slice(0, 50)}`).join(' ｜ '),
    ok: out.every((r) => r.ok),
    fix: '回读不符 ⇒ 备份还在，再执行一次覆盖；仍不符就人工看那一行。',
    note: out.map((r) => `${r.pf.profile}:${r.how}`).join(' ； '),
  })
  return base
}

// ═════════════════════════════════════════════════════════════════════════════
// §8 模式：--post-restart（回收真机读数 + 清单）
// ═════════════════════════════════════════════════════════════════════════════
/** 外部命令（默认只打印；`--run=<id|all>` 才真跑）。argv 与 cmd 同一份声明，不做字符串再切分。 */
const EXT = [
  {
    id: 'guard-verify', title: '护栏仍在（激活后验护栏）', mut: 'guard-verify',
    argv: [GUARD_PROBE, '--verify-guard'],
    cmd: `node "${GUARD_PROBE}" --verify-guard`,
    expect: 'exit 0，且输出里出现 `=== --verify-guard（激活后验护栏）: PASS ===`',
    bad: 'exit≠0 或末行不是 PASS（判决/落账随 transport 变了 —— 立刻回滚那一行）',
    // 判据在**输出里**而不是末行：--verify-guard 的 PASS 行不在末尾（末尾是它自己的「退出码」小结）
    outCheck: (out) => /===\s*--verify-guard（激活后验护栏）:\s*PASS\s*===/.test(out),
  },
  {
    id: 'failure-replay', title: '测量线①：失败重放（冻结基准列）', mut: 'measure-lines',
    argv: [pkgPath('src', 'locator-lab', 'failure-replay.mjs')],
    cmd: 'node src/locator-lab/failure-replay.mjs',
    expect: 'exit 0；冻结基准列与波7 对照逐格一致（C29 修完之后）',
    bad: 'exit≠0；判据⑬（基准必须与现树不同源）红 = 冻结基准又被安装刷新覆盖',
  },
  {
    id: 'success-regression', title: '测量线②：成功集回归', mut: 'measure-lines',
    argv: [pkgPath('probes', 'success-regression.mjs')],
    cmd: 'node probes/success-regression.mjs',
    expect: 'exit 0；Z=0 且基准来历判据绿（C29 修完之后）',
    bad: 'exit≠0；Z>0 = 真的回归',
  },
  {
    id: 'residual-census', title: '测量线③：残留普查', mut: 'measure-lines',
    argv: [pkgPath('probes', 'residual-census.mjs')],
    cmd: 'node probes/residual-census.mjs',
    expect: 'exit 0（现树·旧入参 92/260/1）',
    bad: 'exit≠0 = 内嵌期望仍陈旧或现树读数漂了',
  },
  {
    id: 'rollback-dryrun', title: '回滚链只读预检', mut: 'measure-lines',
    argv: [INSTALLER, '--rollback', '--dry-run'],
    cmd: `node "${INSTALLER}" --rollback --dry-run`,
    // 期望值从源头读：状态文件声明的回滚目标版本（不再钉死具体版本号）
    expect: `exit 0，且打印 \`回滚目标  : ${declaredPrevVersionNow()}（构建戳 …）\``,
    bad: 'exit≠0 或目标戳变了 = previous/ 被换掉，回滚链断',
  },
]

function runExternalItems (base) {
  const wanted = RUN_IDS.includes('all') ? EXT.map((e) => e.id) : RUN_IDS
  const results = []
  for (const e of EXT) {
    if (!wanted.includes(e.id)) { results.push({ id: e.id, ran: false }); continue }
    const started = Date.now()
    const r = spawnSync(process.execPath, e.argv, { encoding: 'utf8', windowsHide: true, timeout: 1800000, maxBuffer: 1 << 26, cwd: REPO })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '')
    const tail = lines.slice(-3).join('  |  ')
    const exitExpect = isMut(e.mut) ? 7 : 0
    // 判据 = 退出码 + （若声明了）输出里的标记行；两者都要对，不看「末行」这种位置假设
    const pass = r.status === exitExpect && (typeof e.outCheck !== 'function' || e.outCheck(out))
    results.push({ id: e.id, ran: true, exit: r.status, ms: Date.now() - started, tail: clip(oneLine(tail), 300), pass })
    crit(`X-${e.id}`, `${e.title}（--run 真跑）`, {
      expect: `exit ${exitExpect}；${e.expect}`,
      actual: `exit=${r.status}（${Math.round((Date.now() - started) / 1000)}s）${typeof e.outCheck === 'function' ? ` 含判据行=${e.outCheck(out)}` : ''}  尾部：${clip(oneLine(tail), 170)}`,
      ok: pass,
      fix: e.bad,
    })
  }
  return results
}

function runPostRestart () {
  say('══════════════════════════════════════════════════════════════════════════════')
  say(' C30 · 重启后：真机读数自动回收 + 验证清单')
  say('══════════════════════════════════════════════════════════════════════════════')
  say('')
  say(` 自动回收自：① 本工作区会话日志（~/.dsh/sessions/--E-workspaces-deepseekharness--）`)
  say('             ② 钩子自己的账（.polaris/polaris-guard.log.jsonl）')
  say('             ③ 进程表只读枚举（Win32_Process）④ profile / 安装副本 / previous 的字节')
  say(` 不能自动回收的只有一件：**工具在宿主进程内**（本脚本代跑不了），清单里都标了「谁跑」。`)
  say('')
  const base = collect()
  // ── 清单 ──
  const wantRestart = true
  // 本模式不跑 registerHostCriteria（它那条 B4 行为指纹与下面的 P1 同源：C59 起 B4 的期望按
  // 「宿主启动时盘上那一份」现跑派生，与 wantRestart 无关了；本模式的同一件事由 P1 判），
  // 但清单与 P1 要用到这两份读数
  base.engineReading = engineReadingOf(base)
  if (base.fpNew === undefined) base.fpNew = fingerprintShapeOf(INSTALL_DIR)
  const restartedNow = base.restarted === true
  const item = (n, title, who, cmd, expect, bad, auto, cur) => {
    say(` ┌ P${n} ${title}`)
    say(` │ 谁跑     : ${who}`)
    if (cmd !== null) say(` │ 命令     : ${cmd}`)
    say(` │ 期望读数 : ${expect}`)
    say(` │ 判红条件 : ${bad}`)
    say(` │ 自动回收 : ${auto}`)
    say(` │ 当前     : ${cur}`)
    say(' └')
    say('')
  }
  const r = base.engineReading
  const fpNew = base.fpNew
  item(1, '引擎侧生效指纹 ·「必然找不到的读」的回执形状', '你（agent）在宿主里发一次工具调用',
    `aura_read(file_path="aura-tools/README.md", mode="search", search="${ABSENT_TOKEN}")`,
    `正常结果（不是报错）：首行 \`Error (READ_NOT_FOUND): no line contains "${ABSENT_TOKEN}"\`，随后一行 \`next: …\`；会话日志里这一次 tool/result 的 isError=false`,
    `回执是抛错 \`Error: READ_NOT_FOUND: …\`（isError=true）⇒ 宿主仍跑旧字节（重启没生效 / 装错份 / 有第二个宿主）`,
    `扫会话日志里带标记串「${ABSENT_TOKEN}」的那一发，按形状判 old/new`,
    r === null ? '未观测（重启后按上面命令发一发，再重跑本模式即可回收）' : `${r.shape}（${r.window}）${clip(oneLine(r.text), 90)}`)
  item(2, '钩子侧生效指纹 · 钩子进程的命令行不再是 pwsh -Command', '本脚本（采样进程表）',
    `node aura-tools/probes/activate-and-verify.mjs --post-restart --watch-hooks=20`,
    '抓到 hook.mjs 的进程里：钩子 node 的父进程是 node（宿主直接 spawn），且没有任何 pwsh.exe 承载 hook 命令串；runner.js 的直投目标是 node',
    '抓到 pwsh.exe 承载 hook.mjs（或 runner.js 仍 `-- pwsh.exe … hook.mjs …`）⇒ 那一行没生效',
    WATCH_HOOKS > 0 ? '采样进程表（本模式已开）' : '加 --watch-hooks=N 才采样；不加则只做结构性核对（C2 行值 + 时间线）',
    `实测：${WATCH_HOOKS > 0 && base.watch !== undefined
      ? (base.watch.obs.length === 0
          ? '未观测（窗口里没有钩子进程）'
          : `${base.watch.obs.filter((o) => o.verdict === 'old').length} 个 old / ${base.watch.obs.filter((o) => o.verdict === 'new').length} 个 new`)
      : '（未采样）'}｜ 期望：${base.carrier?.carrier === 'direct' ? 'direct（宿主直接 spawn node，链上没有 pwsh）'
      : base.carrier?.carrier === 'wrapped' ? 'wrapped（仍经 pwsh -Command 一类外层壳）'
        : `无期望（不判红）—— ${base.carrier?.why ?? 'profile 那一行没派生过'}`}`)
  // hooksSince 在 collect() 里已经算成统计对象了（别再 hookStats 一次：夹具那一轮就是这么把它变成 TypeError 的）
  const hwStats = base.hooksSince
  item(3, '单次调用墙钟（同一口径：宿主自己的 hook/result.durationMs）', '本脚本（会话日志回收）',
    null,
    `重启后窗口内 PreToolUse durationMs p50 < ${HOOK_P50_PASS}ms（钩子侧自记 p50≈${r1(base.guard.p50)}ms，两者之差 = 外层壳税，应当塌到个位数%）`,
    `p50 ≥ ${HOOK_P50_RED}ms ⇒ 壳税还在（仍是 pwsh 承载钩子）；${HOOK_P50_PASS}–${HOOK_P50_RED}ms 之间记警告`,
    `重启后窗口（event.time ≥ 宿主启动时间）内的 hook/result 全量统计`,
    hwStats === null ? `未观测（宿主未重启：重启前基线 n=${base.hooksAll.n} p50=${r1(base.hooksAll.p50)}ms）` : `窗口内 n=${hwStats.n} p50=${r1(hwStats.p50)}ms（基线 n=${base.hooksAll.n} p50=${r1(base.hooksAll.p50)}ms）`)
  item(4, '护栏仍在（激活后验护栏）', '本脚本或你（--run=guard-verify 真跑）',
    `node "${GUARD_PROBE}" --verify-guard`,
    'exit 0，末行 `=== --verify-guard（激活后验护栏）: PASS ===`（同载荷 × 两种 transport 的判决与落账逐字一致）',
    'exit≠0 / 末行不是 PASS ⇒ 判定或落账随 transport 变了，立刻回滚那一行',
    '默认只打印（约 16.5s，重启前实测 exit 0）；要真跑加 --run=guard-verify',
    '重启前基线：exit 0（2026-10-14 实测）')
  item(5, '三条测量线（C29 的交付面）', '本脚本或你（--run=all 真跑）',
    'failure-replay / success-regression / residual-census（逐条命令见下表）',
    '三条都 exit 0；冻结基准列与波7 对照逐格一致',
    '任一条 exit≠0 ⇒ 先看是不是 C29 的冻结基准又被安装刷新覆盖（判据⑬），再判引擎',
    '默认只打印；--run=all 或 --run=failure-replay,success-regression,residual-census 真跑',
    '重启前基线：见 --check 的段F')
  for (const e of EXT) say(`     · ${padR(e.id, 20)} ${e.cmd}   ⇒ ${e.expect}`)
  say('')
  item(6, '回滚链待命（随时能翻回去）', '本脚本（只读重算）',
    `node "${INSTALLER}" --rollback --dry-run   # 只读预检，--run=rollback-dryrun 可代跑`,
    `previous/ 实测戳 = ${base.prev.ok ? base.prev.buildStamp : '读不出'}（应为状态文件声明的 previousVersion=${base.state?.previousVersion ?? '(未声明)'}）；安装副本实测戳 = ${base.install.ok ? base.install.buildStamp : '读不出'}（声明=${base.state?.buildStamp ?? '(未声明)'}）；备份文件在`,
    'previous/ 戳变了 / 备份丢了 ⇒ 回滚链断，先在回滚之前把它复位',
    '安装副本与 previous 的树哈希每次都重算（段A/D）',
    `previous=${base.prev.ok ? base.prev.buildStamp : '读不出'}；备份=${base.backup?.exists ? '在' : (base.profile.ok && String(base.profile.nameLine ?? '').trim() === NEW_LINE.trim() ? '不在（已接线！）' : '不在（未接线，正常）')}`)
  // ── 判据（只判「现在能判的」；判不了的一律不判红）──
  hr('底座：与 --check 同源的只读判据（下面 A / C / D 三段逐条相同）')
  registerInstallCriteria(base, wantRestart)
  registerHookCriteria(base, wantRestart)
  registerRollbackChain(base)
  hr('重启后专用判据（P1/P3；P2 只在 --watch-hooks>0 时判）')
  // P1 引擎指纹
  {
    const expectShape = me('engine-fingerprint', 'new', 'old')
    // 【C50 修的退化】C46 把读数源换成「全史普查」之后，engineReadingOf 返回的 window 恒为
    // 「全史普查（旁路索引 + 有界深扫）」（见它的 return）——`r.window === '重启后窗口'` 这一格
    // 因此**永远为假**，observed 恒 false ⇒ 「宿主已重启」时 P1 永远绿（C50 跑 --selftest 时，
    // 夹具反证 post-restart-bad 当场把它抓了出来：形状实测 old、期望 new，却判了绿）。
    // 现在只要求「有可判形状的读数」：候选集按事件时间倒序（sentinelCensus 的 merged），
    // 取到的最新那一发就是宿主重启后自己造的那一发，所以这不存在拿旧读数误判的风险。
    const observed = r !== null
    const ok = !observed || r.shape === expectShape
    crit('P1-engine-fingerprint', '引擎侧生效：回执形状（实测自会话日志）', {
      expect: restartedNow
        ? `${expectShape} = 新壳（正常结果 + outcome/code/next，不抛错）`
        : `宿主尚未重启 ⇒ 本项待重启（重启前形状应为 old）`,
      actual: r === null
        ? `未观测（候选集 ${base.sentinel?.candidates ?? '?'} 个里没有带标记串「${ABSENT_TOKEN}」的那一发）`
        : `${r.shape}（${r.window}，来自会话 ${r.viaFile ?? '?'}@${r.mtime ?? '无时间戳'}，${r.time === null ? '无时间戳' : new Date(r.time).toISOString()}）`,
      ok: restartedNow ? ok : true,
      soft: !restartedNow || r === null,
      fix: '宿主重启了、标记那一发却还是旧形状 ⇒ 它加载的不是安装副本这一份：核对 A1/A3 与 profile:38/41 指到的路径，再重启一次。',
      note: r === null ? `发一发读数：aura_read(file_path="aura-tools/README.md", mode="search", search="${ABSENT_TOKEN}")；新壳的期望首行：${clip(oneLine(fpNew.text), 110)}` : null,
    })
  }
  // P2 钩子进程形状
  //
  // 【与 C4 同一类缺陷：期望从前问错了问题】旧口径 `expect = restartedNow ? 'new' : 'old'` ——
  //   两处都错在拿**安装时间线**（宿主启动 vs 本次安装生效时间）去推**承载链**：
  //   ① 宿主未重启时说「现在应为 old」，可是 profile 那一行（改行在前）早指到 argv-shell.mjs 了
  //      ⇒ 期望错；旧口径又用 `ok: restartedNow ? oldN === 0 : true` 把未重启那一支整个短路成 true，
  //      于是这个错期望永远不会变成红 —— 它只是被印出来误导读回执的人（本单 post-restart 那次运行就是）。
  //   ② 宿主已重启时的 `oldN === 0` 把「读数是 new」等同于「profile 那一行就是 argv-shell」，
  //      而这件事只有 profile 那一行能回答。
  //   现口径：与 C4 共用同一份派生（base.carrier / carrierReadingOf），判的也是同一件事：
  //   宿主加载的那一行的执行器蕴含 direct 还是 wrapped；派生不出期望时如实报读数、不判红。
  if (WATCH_HOOKS > 0 && base.watch !== undefined) {
    const w = base.watch
    const reading = w.reading ?? carrierReadingOf(w)
    const { oldN, newN, observed } = reading
    const derived = base.carrier?.carrier ?? null
    const mutated = isMut('hook-process')
    // 词表映射与 C4 **同一处**（hostCarrierOf 里算一次）：这里不再自己再译一遍。
    const expectFromCarrier = base.carrier?.verdict ?? null
    // 变异注入值与 C4 逐字同形（抓到就取**实测的反面**；没抓到取一个不可能与实测相等的哨兵）：
    // 两处必须一致 —— 否则同一条登记的变异在两个判据里会给出不同结论。
    const measuredCarrier = observed && (reading.verdict === 'old' || reading.verdict === 'new') ? reading.verdict : null
    const expectV = mutated
      ? (measuredCarrier === 'new' ? 'old' : measuredCarrier === 'old' ? 'new' : '@@MUTATED:不可能与实测相等@@')
      : expectFromCarrier
    crit('P2-hook-process', '钩子侧生效：承载 hook.mjs 的进程（采样）', {
      expect: `${mutated ? '【注入】期望被改坏（本轮是变异反证：真机读数看实际）' : expectFromCarrier === null
        ? `（无期望：${base.carrier?.why ?? 'profile 那一行没派生过'}）⇒ 只如实报实测形状，不判红`
        : expectFromCarrier === 'new' ? 'new = 钩子 node 由宿主直接 spawn（父进程 node，链上没有 pwsh）' : 'old = 钩子命令串仍经 pwsh -Command（父进程 pwsh.exe）'}${expectFromCarrier === null ? '' : `（期望从 ${base.carrier?.source ?? 'profile 那一行'}派生：宿主启动${base.restartedVsProfile === true ? '晚于' : '早于'}该行 mtime${restartedNow ? '；且宿主启动晚于本次安装' : '；本次安装晚于宿主启动（引擎侧那一半未生效）'}）`}`,
      actual: !w.ok ? `采样失败：${w.why}` : reading.obs.length === 0 ? '未观测（窗口里没有钩子进程）' : `old ${oldN} 个 / new ${newN} 个：${reading.obs.slice(0, 2).map((o) => `${o.name}(pid ${o.pid}, 父 ${o.parentName || '?'}) ${o.verdict}`).join('；')}`,
      // 未观测 / 没有诚实期望都不判红（如实报读数就是唯一诚实的动作）；变异反证时这两条退化本身必须红。
      // 比较统一走 expectV（非变异时它 === expectFromCarrier）；词表映射见 C4 那段注释。
      ok: !observed ? !mutated : (expectFromCarrier === null ? !mutated : reading.verdict === expectV),
      soft: !mutated && (expectFromCarrier === null || !observed),
      fix: derived === null
        ? '宿主启动早于 profile 那一行 ⇒ 它加载的是哪一行读不到（没有诚实期望，不判红）：让宿主重启一次（重启后必然加载盘上这一行）。'
        : '实测形状与 profile 那一行蕴含的链不一致 ⇒ 那一行没生效（或有第二个宿主/别的接线在服务本会话）：核对 C2（行值）与宿主启动是否晚于该行 mtime。',
      note: !observed ? '采样窗口里没有钩子进程：把本命令与另一条工具调用放进同一个 tool-call 块再跑一次。' : `采样针取 ${w.entry?.source ?? '?'}：${(w.entry?.entries ?? (w.entry?.entry === null || w.entry?.entry === undefined ? [] : [w.entry.entry])).join(' ｜ ') || '(没有可信入口)'}`,
    })
  }
  // P3 墙钟
  //
  // 【窗口必须自报（C58）】这一格出过一次「读数看着像结论、其实窗口不对」的事故：窗口里混进了重启前的
  //   历史钩子 ⇒ 印出 658.6ms「像壳税还在」，而真正落在窗口内的是 230.7ms（警告档）。所以 actual 里现在
  //   必须印全：**用的哪个窗口 / 取自几份会话 / 窗口内几条 / 窗口外剔除几条** —— 窗口错了要当场看得出来。
  // 【阈值不动】HOOK_P50_PASS / HOOK_P50_RED 一字未改：修完落在 200–450 之间就该是 soft（警告，不计红），
  //   靠在阈值上凑绿是禁止的；`soft: p50 < HOOK_P50_RED` 这一行决定了「警告不算硬红」。
  // 【这一格的证伪开关】`--mutate=hook-window` 把窗口边界人为推早到 0（= 假装 hostStartMs 是很早以前）
  //   ⇒ 读数必须变回硬红，且 actual 点名「窗口被放宽」—— 这才证明它判的是**窗口**，不是全史。
  // 【C59 修的判定力缺口：放宽窗口本身就得是判红理由】原先这一格只有在「全史 p50 自己越过 450ms」时才硬红
  //   （上一版注释里就把这个前提写出来了）。2026-10-15 实测：本机全史 p50=250.6ms 落在 200–450 的**警告档**
  //   ⇒ 放宽窗口后读数根本进不了硬红分支 ⇒ `--mutate=hook-window` 退化成「exit 只因**别的**判据红、
  //   点名里没有 P3」（--selftest 那条个案报「期望被改坏却没变红」）—— 一条登记在册的变异悄悄失去判定力，
  //   而且它红不红取决于真机上那几个数字碰巧落在哪一档。
  //   修法不是去凑数字，而是把「窗口无效」本身当判红理由：**窗口不对的读数答不了这个问题**
  //   （C58 那起事故就是拿错窗口的读数当结论）。阈值 HOOK_P50_PASS / HOOK_P50_RED 一字未动；
  //   未变异的任何一轮都不受影响（winWidened 只可能由 --mutate=hook-window 打开，见 base.hookWindow.widened）。
  const winWidened = isMut('hook-window')
  const p3 = winWidened ? hookStats(base.sessionsAll.hooks) : hwStats
  const winRef = winWidened ? base.sessionsAll : base.sessionsSince
  const winLabel = winWidened
    ? '窗口=被放宽（--mutate=hook-window：把窗口边界推早到 0 ⇒ 全史）'
    : base.hostStartMs === null
      ? '窗口=未定义（读不到新宿主进程的启动时间）'
      : `窗口=宿主启动后（event.time ≥ ${new Date(base.hostStartMs).toISOString()}）`
  const winScope = winRef === null || winRef === undefined
    ? '未读窗口（宿主未重启 ⇒ 没有「重启后窗口」）'
    : `取自 ${winRef.scanned.length} 份会话（会话目录共 ${winRef.files} 份）`
  const winDropped = p3 === null ? 0 : Math.max(0, base.hooksAll.n - p3.n)
  const p3Window = `${winLabel} ｜ ${winScope} ｜ 窗口内 hook/result ${p3 === null ? '未观测' : `${p3.n} 条`}（窗口外已剔除 ${winDropped} 条）`
  base.hookWindow = {
    widened: winWidened,
    sinceMs: winWidened ? 0 : base.hostStartMs,
    sinceISO: winWidened || base.hostStartMs === null ? null : new Date(base.hostStartMs).toISOString(),
    files: winRef === null || winRef === undefined ? null : winRef.scanned.length,
    totalFiles: winRef === null || winRef === undefined ? null : winRef.files,
    n: p3 === null ? null : p3.n,
    p50: p3 === null ? null : p3.p50,
    droppedOutside: winDropped,
    hooksBeforeWindow: winRef === null || winRef === undefined ? null : winRef.hooksBeforeWindow,
    hooksNoTime: winRef === null || winRef === undefined ? null : winRef.hooksNoTime,
    label: p3Window,
  }
  // 窗口无效（被放宽）也算「已有读数」：它必须进判定、且必须红 —— 否则放宽窗口的变异就是不咬人的空操作。
  if (p3 !== null && (p3.n >= 10 || winWidened)) {
    const p50 = p3.p50
    const enough = p3.n >= 10
    // --mutate=hook-p50 把合格线改成「必须 < 1ms」：只靠这一条变异就能证明该判据真会红（重启后用）
    const pass = isMut('hook-p50') ? 1 : HOOK_P50_PASS
    // 判红两条独立理由，任一条成立即硬红：① 窗口无效（p50 数字再好看，它答的也不是这个问题）；
    // ② 样本够且 p50 越过合格线。两条都不成立才谈得上「合格」——注意没有第三条「未观测就不判」的路：
    // 走到这里就意味着已经有读数了（窗口无效时即便样本不足也不许静默降级成读数）。
    const ok = !winWidened && enough && p50 !== null && p50 < pass
    crit('P3-hook-p50', '单次调用墙钟（重启后窗口，同一口径）', {
      expect: `重启后窗口内 PreToolUse durationMs p50 < ${HOOK_P50_PASS}ms（基线 ${r1(base.hooksAll.p50)}ms）${winWidened ? '；本轮窗口被放宽 ⇒ 本读数只用于证伪，不是真机读数（无效窗口一律判红）' : ''}`,
      actual: `${p3Window} ｜ n=${p3.n}  p50=${r1(p50)}ms  p90=${r1(p3.p90)}ms  基线差 ${p50 === null || base.hooksAll.p50 === null ? '—' : r1(base.hooksAll.p50 - p50)}ms`
        + (winWidened
            ? ' ｜ 判红理由：窗口被放宽（--mutate=hook-window）⇒ 这一发答不了「重启后窗口合格吗」'
            : (enough ? '' : ` ｜ 判红理由：窗口内只有 n=${p3.n} 条（<10）⇒ 样本不足不许当合格`)),
      ok,
      soft: !winWidened && enough && p50 !== null && p50 < HOOK_P50_RED && !isMut('hook-p50'),
      fix: winWidened
        ? '窗口被放宽（--mutate=hook-window）⇒ 这不是真机读数：去掉变异重跑，拿到「宿主启动后」那个窗口的读数再谈阈值。'
        : 'p50 还在旧量级 ⇒ 先看本行印出的窗口对不对（窗口被放宽 / 混进重启前历史都会虚高），窗口没错再看 C2/C4（那一行是否真的指向落地件、宿主是否重启过）。',
    })
  } else {
    noted('P3-hook-p50', '单次调用墙钟（重启后窗口）', {
      value: p3 === null ? `未观测（宿主尚未重启）｜ ${p3Window}` : `窗口内只有 n=${p3.n} 条（<10，样本不足不下判；**不回落成全史**）｜ ${p3Window}`,
      note: `重启前基线：宿主侧 p50=${r1(base.hooksAll.p50)}ms（n=${base.hooksAll.n}）/ 钩子自记 p50=${r1(base.guard.p50)}ms ⇒ 壳税 ≈ ${base.hooksAll.p50 !== null && base.guard.p50 !== null ? r1(base.hooksAll.p50 - base.guard.p50) : '—'}ms`,
    })
  }
  // P7 把「未观测」当红的变异开关：证明本模式的判定链真能红
  if (isMut('require-observed')) {
    const unobserved = [r === null, WATCH_HOOKS === 0 || base.watch?.obs.length === 0, hwStats === null || hwStats.n < 10]
    crit('P7-require-observed', '（变异反证）要求「真机读数必须已观测」', {
      expect: '引擎指纹 / 钩子进程 / 墙钟 三项都已有实测读数',
      actual: `未观测项 ${unobserved.filter(Boolean).length}/3：${unobserved.map((u, i) => (u ? ['引擎指纹', '钩子进程', '墙钟'][i] : null)).filter(Boolean).join('、') || '（无）'}`,
      ok: unobserved.every((u) => u === false),
      fix: '发布前的 --post-restart 必须三项都有实测读数：按 P1/P2/P3 的命令各取一发。',
    })
  }
  // 外部命令
  if (RUN_IDS.length > 0) {
    hr('外部命令（--run 真跑）')
    report.external = runExternalItems(base)
  } else {
    hr('外部命令（默认不跑）')
    say(' 要真跑：--run=all，或 --run=guard-verify,rollback-dryrun,…。逐条命令与期望读数见上面 P4/P5/P6。')
    report.external = EXT.map((e) => ({ id: e.id, ran: false }))
  }
  return base
}

// ═════════════════════════════════════════════════════════════════════════════
// §9 模式：--selftest（变异反证：逐条把期望改坏，断言对应判据必须变红）
// ═════════════════════════════════════════════════════════════════════════════
const SELFTEST_CASES = [
  { mode: '--check', mut: 'install-stamp', red: 'A1-install-stamp' },
  { mode: '--check', mut: 'install-record', red: 'A2-install-record' },
  { mode: '--check', mut: 'src-vs-install', red: 'A3-src-vs-install' },
  { mode: '--check', mut: 'dist-vs-install', red: 'A4-dist-vs-install' },
  // C57 新增：「--check 只读」那句自述的实测判据（~/.aura 跑前跑后差异必须 0），变异即变红。
  { mode: '--check', mut: 'home-readonly', red: 'A5-home-untouched' },
  { mode: '--check', mut: 'artifact-sha', red: 'C1a-artifact-sha' },
  { mode: '--check', mut: 'artifact-import', red: 'C1b-artifact-import' },
  { mode: '--check', mut: 'artifact-generator', red: 'C1c-artifact-generator' },
  { mode: '--check', mut: 'artifact-tokenize', red: 'C1d-artifact-tokenize' },
  { mode: '--check', mut: 'profile-line', red: 'C2-profile-line' },
  { mode: '--check', mut: 'prev-stamp', red: 'D1-prev-stamp' },
  { mode: '--check', mut: 'prev-differs', red: 'D2-prev-differs' },
  { mode: '--check', mut: 'rollback-path', red: 'D3-rollback-path' },
  { mode: '--check', mut: 'fixture-intact', red: 'B3a-fixture-intact' },
  { mode: '--check', mut: 'fingerprint-power', red: 'B3b-fingerprint-power' },
  { mode: '--check', mut: 'engine-fingerprint', red: 'B4-engine-fingerprint' },
  // C46 新增：把哨兵那一发人为挤出读数窗口 ⇒ B4a 必须变红并点名。
  // 这一格正是「哨兵存在但被窗口挤掉」——修之前它只会静默退化成「未观测」（按设计不判红）。
  //
  // 【为什么要多带一个预算开关（2026-10-15 实测修正）】原先的配方是
  // 「不读索引 + `--sentinel-scan-window=1`」，靠「哨兵那份按 mtime 不在最新 1 个里」把它挤出候选集。
  // 那条**已经失效了**：哨兵会话的 mtime 固定在 2026-10-14，之后又长出了 82 个更新的会话文件
  // ⇒ 有界窗口里根本没有它不是「被挤掉」，而是「压根没轮到」（`allHits === 0`）
  // ⇒ B4a 走「真的还没发过」分支 ⇒ **不判红**（自检因此报「期望被改坏却没变红」）。
  // 现行配方改成**字节预算饥饿**：关掉索引（全部 228 个都算「没账」）+ 预算给足
  // ⇒ 深扫扫完全部候选、哨兵那一发确实进了候选集（`allHits === 1`），
  // 而读数窗口仍是 0 发（`SENTINEL_KEEP = 0`）⇒ 这才是名副其实的「存在却被挤掉」。
  // 这一格现在与「哪份文件 mtime 最新」无关：只要哨兵那一发还在会话目录里，它就必红。
  // 实测：2048MB 预算下深扫 228/228、命中 1 份、窗口 0 份，`--check` exit 1 并点名（约 9 秒）。
  { mode: '--check', mut: 'sentinel-lost', red: 'B4a-sentinel-not-lost', extra: ['--sentinel-budget-mb=2048'] },
  { mode: '--apply', mut: 'artifact-import', red: 'AP-pre-artifact' },
  { mode: '--apply', mut: 'line-apply', red: 'AP-pre-line' },
  { mode: '--rollback', mut: 'line-rollback', red: 'RB-state' },
  { mode: '--post-restart', mut: 'artifact-sha', red: 'C1a-artifact-sha' },
  { mode: '--post-restart', mut: 'profile-line', red: 'C2-profile-line' },
  { mode: '--post-restart', mut: 'require-observed', red: 'P7-require-observed' },
  // 带额外开关的一例：C4/P2 的变异在「未观测」时强制变红，所以采样窗口里没有钩子也能证
  // —— 这正好是「判据有判定力」该被证的那一格。
  // 【C59 修的空操作】注入值原先取「时间线推断出来的反面」，而本机钩子入口本来就是新路（采样读 new）
  //   ⇒ 注入值撞上实测值 ⇒ 抓到钩子时这一格变成永绿的空操作（时红时绿）。现在注入值取实测形状的反面
  //   （见 C4 那段注释）：抓到了必对不上、没抓到走「未观测 ⇒ 强制红」—— 两条路都与时间线猜得准不准无关。
  { mode: '--post-restart', mut: 'hook-process', red: 'C4-hook-process', extra: ['--watch-hooks=2'] },
  // C58 新增：把 P3 的窗口边界人为推早到 0（= 假装 hostStartMs 是很早以前）⇒ 全史读数必须变回硬红并点名 P3。
  // 这一格证的是「P3 判的是窗口，不是全史」。
  // 【C59 修的判定力缺口】原先这一格的红**依赖真机全史读数自己越过 450ms**（旧注释也承认了这个前提）。
  //   2026-10-15 实测：本机全史 p50=250.6ms（落在 200–450 警告档）⇒ 放宽窗口后读数不进硬红分支
  //   ⇒ 个案报「exit=1 但没点名 P3」（exit 是别的红判据给的），而且它随真机数字的涨落时红时绿。
  //   现在 P3 把「窗口无效」本身当判红理由（见 P3 那段注释：读数不是重启后窗口的，就不许拿去对阈值），
  //   这一格因此与真机那几个数字无关：只要 winWidened 成立，P3 必红。
  { mode: '--post-restart', mut: 'hook-window', red: 'P3-hook-p50' },
]
/**
 * 夹具反证：把「重启之后」的两种形状各喂一遍，断言判定链**两边都会判**。
 * 这两例不是变异（没改任何期望值），而是把 P1/P3 的输入换成一个合成状态 ——
 * 没有它，那几条只在「已重启」时才硬的判据在本机就永远是「未观测」。
 */
const SELFTEST_FIXTURES = [
  { kind: 'post-restart-ok', exit: 0, reds: [] },
  { kind: 'post-restart-bad', exit: 1, reds: ['P1-engine-fingerprint', 'P3-hook-p50'] },
]
/**
 * B2 时间线的合成状态证伪（纯计算路径，不 spawn、不读不写盘、碰不到宿主配置）：
 * 安装器正规 `--upgrade` 会同时写下「首次安装」与「本次升级」两个时间戳，于是有这么一种形状：
 *   宿主启动早于**本次升级**、却晚于**首次安装**。
 * 只取 installedAt 会把这种形状判成「已生效」（假绿），取「同类字段的最大值」才是「未生效」。
 * 这格存在的意义就是让 B2 **可被证伪**：把 max 退回只取 installedAt，它当场变红。
 */
const SYNTH_HOST_START = '2026-06-01T00:00:00.000Z'
const SYNTH_INSTALLED_AT = '2026-01-01T00:00:00.000Z'
const SYNTH_UPGRADED_AT = '2026-09-01T00:00:00.000Z'
const SYNTH_BEFORE_HOST = '2025-11-01T00:00:00.000Z'
const SYNTH_AFTER_UPGRADE = '2026-10-01T00:00:00.000Z'
function checkSyntheticTimeline () {
  const state = { installedAt: SYNTH_INSTALLED_AT, upgradedAt: SYNTH_UPGRADED_AT }
  const r = timelineVerdictOf(state, Date.parse(SYNTH_HOST_START))
  const want = Date.parse(SYNTH_UPGRADED_AT)
  const verdictZh = r.verdict === 'effective' ? '已生效' : r.verdict === 'not-effective' ? '未生效' : '未观测'
  // 旧口径（只取 installedAt）在同一份合成状态上会给出什么：拿来把「假绿」当场演示出来
  const legacyEffective = Date.parse(SYNTH_HOST_START) > Date.parse(SYNTH_INSTALLED_AT)
  const ok = r.verdict === 'not-effective' && r.ms === want && r.field === 'upgradedAt'
  // 宿主早于两个时间戳 ⇒ 必须「未生效」（这是 B2 的本义）；晚于最大值 ⇒ 「已生效」；两个时间戳都没有 ⇒ 「未观测」
  const okEarly = timelineVerdictOf(state, Date.parse(SYNTH_BEFORE_HOST)).verdict === 'not-effective'
  const okLate = timelineVerdictOf(state, Date.parse(SYNTH_AFTER_UPGRADE)).verdict === 'effective'
  const okNone = timelineVerdictOf({}, Date.parse(SYNTH_HOST_START)).verdict === 'unobserved'
  return { r, verdictZh, legacyEffective, ok, okEarly, okLate, okNone, okAll: ok && okEarly && okLate && okNone }
}
const SYNTH = checkSyntheticTimeline()
// 供外部检查用（例如 `node --check` 之外的自证脚本直接 import 本文件读这一格）：不改任何判定行为。
export { timelineVerdictOf, effectiveInstallMsOf, STATE_TS_FIELDS, checkSyntheticTimeline, hostCarrierOf, carrierReadingOf }
/**
 * 宿主的 peer 包可能藏在哪些目录（与 `bulk/install.mjs` 的 `hostPeerRoots()` 同法）。
 *
 * 只在真 prefix 的 junction 取不到 realpath 时兜底用（本机常态是取得到）。不拼路径而要探测，
 * 理由见 install.mjs 的那段注释：node 与 npm 全局根可能不在同一棵树，且 peer 藏在
 * **dsh 自己的嵌套 node_modules** 里（`<全局根>/@deepseek-ai/dsh/node_modules/@deepseek-ai`）。
 */
function hostPeerRootsForProbe () {
  const roots = []
  const add = (p) => { if (typeof p === 'string' && p !== '' && fs.existsSync(p) && !roots.includes(p)) roots.push(p) }
  const globals = []
  try {
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' })
    const out = String(r.stdout ?? '').trim().split('\n').pop()
    if (typeof out === 'string' && out !== '') globals.push(out.trim())
  } catch { /* 没 npm 也能继续：下面的候选够用 */ }
  globals.push(
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
    path.join(path.dirname(process.execPath), 'node_modules'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'),
  )
  for (const g of globals) {
    add(path.join(g, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    add(path.join(g, '@deepseek-ai'))
  }
  return roots
}

/**
 * 合成/基线环境的**宿主 peer 层**：按**真机安装的形状**建 junction，而不是把 peer 拷成真目录。
 *
 * 【为什么必须是 junction（本单实测的根因）】旧写法把真 prefix 的 `node_modules/@deepseek-ai`
 * 整个 `cpSync` 过来。实测：`fs.cpSync` 在 Windows 上**会把 junction 解引用成真目录**
 * （拷完三个 peer 的 `lstat` 全是 DIR，不是 SYMLINK）——于是合成环境里的 `dsh-shell` 是一份**真副本**，
 * 而它顶层就 `import { ShellExecutor } from '@deepseek-ai/dsh-shell'`、后者又要 `@deepseek-ai/cordis`，
 * 而 cordis 是宿主 `<…>/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下的**兄弟**：只有沿 junction
 * **落到真身、再从真身向上找**才够得着。副本把这唯一一条路径截断了，实测报：
 *   `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis' imported from <合成>/…/dsh-shell/lib/index.js`
 * 于是四条在合成环境里**假红**：C1b（真 import 一次）/ C1d（tokenizeArgv）/ B3b（行为指纹，靠
 * `aura-read/index.js` 真 import）/ AP-pre-artifact（接线目标真实 import）。
 * 真机是 junction —— `linkHostPeers` 就是 `fs.symlinkSync(found, target, 'junction')` —— 所以合成环境
 * 建 junction 才叫「**复刻真机形状**」；不建才是伪造（会拿一个真机上不存在的形状去判真机的判据）。
 *
 * 【peer 清单从哪来（不是硬编码一个孤立名字）】三处取并集，每一处都指向「安装器在真机上会接什么」：
 *   ① `build/install.mjs` 的 `HOST_PEERS` —— **权威清单**，`linkHostPeers` 的输入，真机上建的就是它；
 *   ② 包 `package.json` 的 `peerDependencies` —— 声明面；install.mjs 的注释要求这两处必须一致，
 *      取并集就同时覆盖「清单加了没声明」与「声明了没进清单」两种漂移；
 *   ③ 真 prefix 作用域里**当下真实存在**的条目 —— 即真机此刻的形状，逐个复刻。
 * （①/② 派生 ⇒ 安装器清单以后再加第四个 peer，这里自动跟上；不用回来改本文件。）
 *
 * 【源目录从哪来】先取真 prefix 那条 junction 的 `realpath`（真机真正指到的那一份，最忠实），
 * 取不到再按 install.mjs 的探测法兜底。**都找不到就不静默通过**：记进 `missing`，
 * 由调用方判红并说明「合成环境没能复刻真机的 peer 链接」——
 * 那种情况下的基线红是**环境缺陷**，不能拿来当判据的判定力。
 *
 * @param scopeDir - 合成 prefix 的 `node_modules/@deepseek-ai`
 * @returns `{ peers, derivedFrom, linked, missing, sources, realScope }`
 */
function syntheticHostPeerLinks (scopeDir) {
  const peers = new Set()
  const notes = []
  for (const rel of [path.relative(REPO, pkgPath('build', 'install.mjs')), path.relative(REPO, pkgPath('dist', PKG_NAME, 'install.mjs'))]) {
    const f = path.resolve(REPO, rel)
    if (!fs.existsSync(f)) continue
    const m = /const HOST_PEERS\s*=\s*\[([^\]]*)\]/.exec(fs.readFileSync(f, 'utf8'))
    if (m === null) continue
    const found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    for (const n of found) peers.add(n)
    notes.push(`install.mjs HOST_PEERS=${found.length}`)
    break
  }
  let declared = []
  const manifestPath = pkgPath('dist', PKG_NAME, 'package.json')
  if (fs.existsSync(manifestPath)) {
    declared = Object.keys(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).peerDependencies ?? {})
    for (const n of declared) peers.add(n)
    notes.push(`pkg.peerDependencies=${declared.length}`)
  }
  const realScope = path.join(PREFIX, 'node_modules', '@deepseek-ai')
  const onReal = fs.existsSync(realScope) ? fs.readdirSync(realScope) : []
  for (const n of onReal) peers.add(`@deepseek-ai/${n}`)
  notes.push(`真机作用域现存=${onReal.length}`)
  const sourceOf = (peer) => {
    const name = peer.slice('@deepseek-ai/'.length)
    try {
      const viaReal = path.join(realScope, name)
      if (fs.existsSync(viaReal)) {
        const rp = fs.realpathSync(viaReal)
        if (fs.existsSync(path.join(rp, 'package.json'))) return { from: '真 prefix junction 的 realpath', dir: rp }
      }
    } catch { /* 落回探测 */ }
    for (const root of hostPeerRootsForProbe()) {
      const c = path.join(root, name)
      if (fs.existsSync(path.join(c, 'package.json'))) return { from: `探测：${root}`, dir: c }
    }
    return null
  }
  const linked = []
  const missing = []
  const sources = {}
  try { fs.mkdirSync(scopeDir, { recursive: true }) } catch { /* 建不出下面会如实报 */ }
  for (const peer of [...peers].sort()) {
    const name = peer.slice('@deepseek-ai/'.length)
    const src = sourceOf(peer)
    if (src === null) { missing.push(`${peer}（找不到 peer 源目录）`); continue }
    try {
      const target = path.join(scopeDir, name)
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
      fs.symlinkSync(src.dir, target, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(peer)
      sources[peer] = { dir: src.dir, from: src.from }
    } catch (e) {
      missing.push(`${peer}（建链失败：${oneLine(e?.message ?? e)}）`)
    }
  }
  return { peers: [...peers].sort(), derivedFrom: notes.join(' + '), linked, missing, sources, realScope }
}

/**
 * 合成环境里的**宿主钩子配置**：把真机 `<DSH_HOME>/aurapolaris-hooks.json` 原样拿过来，
 * 只把「真家目录那条绝对路径」替换成**合成家目录**（与 profile 里那个 shim 路径同法重写）。
 *
 * 【为什么非要有它（环境保真度）】`hostHookEntry()` 的采样针是从 `<DSH_HOME>/aurapolaris-hooks.json`
 * 现读的入口路径。合成 DSH_HOME 里没有这份文件时，旧口径会回落到 `--host=dsh` 这根**过宽的针**
 * （它只是每条钩子命令末尾的一个普通开关）⇒ 合成跑里拿到的“实测形状”其实是**真机**那些钩子
 * （实测：同一窗口下 `--host=dsh` 命中 16–32 个真机钩子进程，而合成自己的入口一个都不在）。
 * 那样 C4/P2 在合成环境里读的根本不是合成环境的东西，基线也就不再是基线的读数。
 * 现在：针 = 合成家目录里那条路径 ⇒ 合成跑**不会**把真机钩子当成自己的读数（合成环境里本来
 * 就没有真宿主在跑钩子，如实报「未观测」就是对的口径）。
 *
 * @returns {{path: string|null, entries: string[], events: string[], why: string|null, realEntries: string[]}}
 */
function writeSyntheticHooksConfig (dshHome) {
  const out = { path: null, entries: [], events: [], why: null, realEntries: [] }
  const realPath = path.join(DSH_HOME, 'aurapolaris-hooks.json')
  let text = null
  try { text = fs.readFileSync(realPath, 'utf8') } catch (e) { out.why = `真机 hooks 配置读不出：${oneLine(e?.message ?? e)}`; return out }
  const realEntries = hookEntryPathsIn(text)
  out.realEntries = realEntries
  // 两个写法都要换：这份模板的实际路径用正斜杠（跨 shell 同形），但家目录在别的写法下也可能出现反斜杠
  const roots = [DSH_HOME.replace(/\\/g, '/'), DSH_HOME.replace(/\//g, '\\')].filter((r) => r !== '')
  const synthRoot = dshHome.replace(/\\/g, '/')
  let rewritten = text
  for (const r of roots) rewritten = rewritten.split(r).join(synthRoot)
  const dest = path.join(dshHome, 'aurapolaris-hooks.json')
  try {
    fs.mkdirSync(dshHome, { recursive: true })
    fs.writeFileSync(dest, rewritten)
  } catch (e) { out.why = `合成 hooks 配置写不出：${oneLine(e?.message ?? e)}`; return out }
  out.path = dest
  out.entries = hookEntryPathsIn(rewritten)
  out.events = hookEventsWithEntryIn(rewritten)
  // 自证：重写后不该再有任何一条入口留在真家目录下（留了就说明替换没盖全）
  const stale = out.entries.filter((p) => p.toLowerCase().includes(DSH_HOME.replace(/\\/g, '/').toLowerCase()))
  if (stale.length > 0) out.why = `重写后有入口仍指向真家目录（${stale.join('、')}）`
  if (out.entries.length === 0) out.why = '重写后一个入口都抠不出来（钩子配置形状变了？）'
  return out
}

/**
 * 合成环境（**基线**用）：把「接线目标 + 装机清单 + profile 那一行」整体换成一个可复现的副本。
 *
 * 【为什么基线不能直接跑真机】基线要证的命题是「无变异时判据链会绿」。而本单把判定面
 * 扩到了「每个带这条组的 profile 都接上了」与「接线目标（安装副本里那份）必须存在」——
 * 真机当下恰好两件都不满足（有一个 profile 未接线、安装副本还没带 dsh/argv-shell.mjs），
 * 于是真机基线必红。红是对的（那正是要暴露的两件事），但它证不了「无变异时全绿」。
 * 所以基线跑在一个**合成副本**上：prefix 整份拷过来 + 添上 dsh/argv-shell.mjs 并把
 * install.json 的两处声明用本文件自己那份 hashTree/treeDigest/buildStampOf 重算到自洽；
 * profile 家目录里一个已接线、一个**没有这条组**（负样本：它不该被判红）。
 * 会话日志那一侧仍用真机的 `--sessions-root`（哨兵/墙钟读数不能凭空造）。
 */
function buildSelftestEnv () {
  const root = path.join(TMP, 'selftest-prefix')
  const dshHome = path.join(TMP, 'selftest-dshhome')
  const noGroupHome = path.join(TMP, 'selftest-dshhome-nogroup')
  const out = { prefix: root, dshHome, noGroupHome, realSessions: SESSIONS_ROOT, shim: null, shimSha: null, prefixOk: false, why: null, peers: null, hooksConfig: null, noGroupHooksConfig: null }
  const group = (line) => `- insert:\n    - id: polaris-hooks-unconfined\n      name: cordis:group\n      group: true\n      isolate:\n        shell: true\n      config:\n        - id: polaris-hooks-shell\n          ${line}\n`
  const mk = (home, dir, text, backup = false) => {
    const d = path.join(home, 'profiles', dir)
    fs.mkdirSync(d, { recursive: true })
    const f = path.join(d, 'cordis.patch.yml')
    fs.writeFileSync(f, text)
    if (backup) fs.copyFileSync(f, `${f}.bak-before-argv-shell`)
    return f
  }
  try {
    // 包体从 **dist 暂存**拷，不从真安装副本拷：真安装副本是**上一次装机**的字节，
    // README.md / package.json 都可能已经旧了（本单就撞上了）——A3/A4/A6 会因此报红，
    // 而那是合成环境的假红，不是判据要抓的东西。dist 就是「现在这一版包里应该有什么」的产物。
    const pkgDir = path.join(root, 'node_modules', PKG_NAME)
    fs.mkdirSync(path.dirname(pkgDir), { recursive: true })
    fs.cpSync(pkgPath('dist', PKG_NAME), pkgDir, { recursive: true, force: true })
    const shim = path.join(pkgDir, 'dsh', 'argv-shell.mjs')
    if (!fs.existsSync(shim)) throw new Error('dist 暂存里没有 dsh/argv-shell.mjs —— 先跑 node build/make-bundle.mjs')
    // peer 层（@deepseek-ai/*）：**junction 到宿主真身**，与真机同形；**不是拷贝**（拷会把 junction
    // 解引用成真目录，`cordis` 那条兄弟链就断了 ⇒ C1b/C1d/B3b/AP-pre-artifact 假红）。
    // 清单从 install.mjs 的 HOST_PEERS 与包 peerDependencies 派生，理由与实测见 syntheticHostPeerLinks。
    const peerInfo = syntheticHostPeerLinks(path.join(root, 'node_modules', '@deepseek-ai'))
    out.peers = peerInfo
    if (peerInfo.missing.length > 0) throw new Error(`合成环境没能复刻真机的 peer 链接：${peerInfo.missing.join('、')}`)
    if (peerInfo.linked.length === 0) throw new Error('合成环境一条 peer 链接都没建起来（真机的形状不是这样）')
    // previous/（回滚目标）仍从真 prefix 拷：D1/D2 判的是「安装器声明的回滚目标」那一对树，合成不出来
    const prevSrc = path.join(PREFIX, 'previous')
    if (fs.existsSync(prevSrc)) fs.cpSync(prevSrc, path.join(root, 'previous'), { recursive: true, force: true })
    const files = hashTree(pkgDir)
    const treeHash = treeDigest(files)
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    // 状态文件：真那份的**时间戳/previousVersion 等字段照搬**（B2/D1 读它们），只有 files/treeHash/buildStamp 重算到与合成树自洽
    const realStatePath = path.join(PREFIX, 'install.json')
    const realState = fs.existsSync(realStatePath) ? JSON.parse(fs.readFileSync(realStatePath, 'utf8')) : {}
    fs.writeFileSync(path.join(root, 'install.json'), `${JSON.stringify({ ...realState, files, treeHash, buildStamp: buildStampOf(manifest.version, treeHash) }, null, 2)}\n`)
    mk(dshHome, 'web', `# selftest 合成 profile（已接线）\n${group(`name: '${shim}'`)}`, true)
    mk(dshHome, 'aura-exp', "# selftest 合成 profile（**没有**这条组：负样本）\n- insert:\n    - id: tool-aura-read\n      name: './aura-read/index.js'\n")
    mk(noGroupHome, 'aura-exp', "# selftest 合成 profile（没有这条组）\n")
    // 宿主钩子配置：合成一份（路径改成合成家目录）。少了它，采样针会回落到过宽的 `--host=dsh`
    // ⇒ 合成跑会把**真机**的钩子进程当成自己的读数（见 writeSyntheticHooksConfig 的注释）。
    out.hooksConfig = writeSyntheticHooksConfig(dshHome)
    out.noGroupHooksConfig = writeSyntheticHooksConfig(noGroupHome)
    out.shim = shim
    out.shimSha = sha256buf(fs.readFileSync(shim))
    out.prefixOk = fs.existsSync(shim)
    if (!out.prefixOk) out.why = '合成 shim 没落盘'
  } catch (e) {
    out.why = oneLine(e?.message ?? e)
  }
  return out
}

/**
 * 接线判据的**文件级**反证（与 `--mutate` 互补）：改的不是期望值，而是**被观测的文件**。
 * 三格对应三个真事故形状：① 某个 profile 的接线行改回 pwsh-local（漏接）；
 * ② 目标文件不在（回滚到没带这个文件的旧版）；③ 目标文件被改一字节。
 */
function runWiringDrills (rows, env) {
  say('')
  say(' 接线判据的文件级反证（改文件，不改期望值）：三个真事故形状各喂一遍')
  if (!env.prefixOk) {
    CRIT.push({ id: 'SELFTEST-DRILL:env', title: '合成环境建不起来', expect: '合成 prefix 里有一份可用的 shim', actual: `建不起来：${env.why}`, ok: false, soft: false, fix: '先看临时目录与真 prefix 能不能拷（盘满/权限/链接）：合成环境不建，基线就退回了真机口径。' })
    say(` ✗ 合成环境建不起来：${env.why}`)
    return
  }
  const drill = (id, title, args, wantIds, wantTexts = [], mode = '--check', wantExit = 1) => {
    const r = spawnSync(process.execPath, [SELF, mode, ...args], { encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 1 << 26, cwd: REPO })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const named = wantIds.every((x) => out.includes(`✗ ${x}`))
    const said = wantTexts.every((t) => out.includes(t))
    const ok = r.status === wantExit && named && said
    say(` ${ok ? '✓' : '✗'} ${padR(id, 22)} ⇒ ${mode} exit=${r.status}（要求 ${wantExit}）点名 ${wantIds.join('/')}：${named ? '是' : '否'}${wantTexts.length > 0 ? ` 含「${wantTexts.join('、')}」：${said ? '是' : '否'}` : ''}`)
    CRIT.push({ id: `SELFTEST-DRILL:${id}`, title, expect: `${mode} exit ${wantExit} 且点名 ${wantIds.join('/')}${wantTexts.length > 0 ? `，输出里出现「${wantTexts.join('、')}」` : ''}`, actual: `exit=${r.status} 点名=${named} 文本=${said}`, ok, soft: false, fix: '判据没有判定力（或方向反了）：这一格是「文件真的被动过」的反证，不是「期望值被改坏」。' })
    rows.push({ drill: id, mode, exit: r.status, ok })
    return { r, out, ok }
  }
  // `--shim-src` 也指到合成 prefix 里那份：理由与 runSelftest 的 wireArgs 同一段注释（C1a 的期望
  // 派生自仓库落仓件，合成跑里两边都该落在合成树内）。
  const baseArgs = [`--prefix=${env.prefix}`, `--sessions-root=${env.realSessions}`, `--shim-src=${env.shim}`]
  // ① 某个 profile 的接线行改回 pwsh-local（web 仍已接线，headless 故意留成未接线）
  {
    const home = path.join(TMP, 'drill-dshhome')
    const d = path.join(home, 'profiles')
    const mkp = (name, text, backup = false) => {
      const dir = path.join(d, name)
      fs.mkdirSync(dir, { recursive: true })
      const f = path.join(dir, 'cordis.patch.yml')
      fs.writeFileSync(f, text)
      if (backup) fs.copyFileSync(f, `${f}.bak-before-argv-shell`)
    }
    const web = fs.readFileSync(path.join(env.dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    mkp('web', web, true)
    mkp('headless', `# selftest 合成 profile（**未接线**）\n${web.slice(web.indexOf('- insert:'))}`.replace(`name: '${env.shim}'`, OLD_LINE))
    mkp('aura-exp', "# selftest 合成 profile（没有这条组）\n")
    drill('unwired-profile', '某个 profile 的接线行改回 pwsh-local ⇒ 必须红并点名那个 profile', [`--dsh-home=${home}`, ...baseArgs], ['C2-profile-line'], ['headless'])
  }
  // ② 目标文件不在（回滚到没带这个文件的旧版）
  drill('shim-missing', '接线目标不在（旧版包不带这个文件）⇒ 必须红并点名 C1a', [`--dsh-home=${env.noGroupHome}`, `--shim=${path.join(TMP, 'no-such-dir', 'argv-shell.mjs')}`, ...baseArgs], ['C1a-artifact-sha'])
  // ③ 目标文件被改一字节（同样字节数、同样可解析：只差一个空格）
  {
    const text = fs.readFileSync(env.shim, 'utf8')
    // 【为什么放在**合成 prefix 的 node_modules 下**、而不是 TMP】落地件的真 import 要沿
    // 「自己所在目录向上找 node_modules」解析 peer：放 TMP 时那条链是 `%TEMP%\node_modules` → … → 盘根，
    // 一个 peer 都碰不到 ⇒ C1b **因为位置**而不是因为被改的字节变红（实测：插一个空格它也跟着红）。
    // 放到 `<合成 prefix>/node_modules/` 下，peer 解析与落地件**同形**（上一层就是 `@deepseek-ai/*`），
    // 红/绿才真由**字节**决定。也不放进 `aura-tools/` 里：那会改到被观测的包树（A2/A4/C1e 当场变红）。
    const altered = path.join(env.prefix, 'node_modules', 'argv-shell-altered.mjs')
    fs.writeFileSync(altered, text.includes('//') ? text.replace('//', '// ') : `${text}\n`)
    const ob = drill('shim-one-byte', '接线目标被改一字节 ⇒ 必须红并点名 C1a', [`--dsh-home=${env.noGroupHome}`, `--shim=${altered}`, ...baseArgs], ['C1a-artifact-sha'])
    const lastOneByteOut = ob.out
    CRIT.push({ id: 'SELFTEST-DRILL:shim-one-byte-scope', title: '「插一个空格」这一格只该惊动 C1a/C1c（import 照样成功 ⇒ C1b/C1d 不该红）', expect: '输出里点 C1a-artifact-sha，但**不**点 C1b-artifact-import', actual: `C1a=${lastOneByteOut.includes('✗ C1a-artifact-sha')} C1b=${lastOneByteOut.includes('✗ C1b-artifact-import')}`, ok: lastOneByteOut.includes('✗ C1a-artifact-sha') && !lastOneByteOut.includes('✗ C1b-artifact-import'), soft: false, fix: 'C1b 跟着 C1a 一起红 ⇒ 它可能只是搭了「哈希变了」的顺风车，而不是真的在证「import 得起」：看 C1b 的实际读数里那条 import 错误。' })
    rows.push({ drill: 'shim-one-byte-scope', exit: null, ok: lastOneByteOut.includes('✗ C1a-artifact-sha') && !lastOneByteOut.includes('✗ C1b-artifact-import') })
  }
  /**
   * ④ **落地件「真 import」那一族的判定力**（C1b / C1d / AP-pre-artifact）。
   *
   * 【为什么单开这一格】本单之前，这四条基线在合成环境里是红的 —— 而红的理由是
   * **合成环境缺 peer 链接**（环境缺陷），不是判据有判定力。把它们修绿之后，必须重新证一次
   * 「落地件真坏了它仍然会红」，否则「修绿」与「把判据改松」在回执上长得一样。
   * 反证改的是**文件**（不是期望值）：把落地件 import 说明符改**一个字节**
   * （`'@deepseek-ai/dsh-shell'` → `'@deepseek-ai/dsh-shelX'`）——语法仍然合法（`node --check` 过），
   * 只有**真 import** 会失败。这正是真事故形状：peer 不可达 ≠ 文件不在。
   * ③ 那一格（插一个空格）证不了这一族：它 import 照样成功，只有 C1a/C1c 会红 ——
   * 两格合起来才能说明 C1b/C1d 不是搭 C1a 的顺风车。
   * 每格都要给 sha256 三元组（原件 / 改坏 / 还原后重读），还原后必须是同一串。
   */
  {
    const NEEDLE = "'@deepseek-ai/dsh-shell'"
    const before = fs.readFileSync(env.shim)
    const shaBefore = sha256buf(before)
    const text = before.toString('utf8')
    const at = text.indexOf(NEEDLE)
    const broken = at < 0
      ? null
      : Buffer.from(`${text.slice(0, at + NEEDLE.length - 2)}X${text.slice(at + NEEDLE.length - 1)}`, 'utf8')
    // 同上：必须与落地件同层（peer 解析同形），否则红的是位置不是字节。
    const brokenPath = path.join(env.prefix, 'node_modules', 'argv-shell-import-broken.mjs')
    if (broken === null) {
      say(` ✗ 落地件 import 反证构造不出来：文件里没有 ${NEEDLE}`)
      CRIT.push({ id: 'SELFTEST-DRILL:shim-import-broken', title: '落地件 import 说明符改一字节 ⇒ C1b/C1d/AP-pre-artifact 必须红', expect: `落地件里有 ${NEEDLE}（执行器的那条 peer 依赖）`, actual: '文件里找不到这条 import ⇒ 无法构造反证', ok: false, soft: false, fix: '落地件的 peer 依赖写法变了（或生成器输出变了）：先核对 dsh/argv-shell.mjs 顶层那条 import，再改这一格。' })
      rows.push({ drill: 'shim-import-broken', exit: null, ok: false })
    } else {
      fs.writeFileSync(brokenPath, broken)
      const shaBroken = sha256buf(broken)
      const syntaxOk = spawnSync(process.execPath, ['--check', brokenPath], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).status === 0
      say(`         落地件反证：sha256 前置=${shaBefore.slice(0, 16)}… → 改一字节后=${shaBroken.slice(0, 16)}…（\`node --check\` exit=${syntaxOk ? 0 : '非 0'}，语法仍合法）`)
      drill('shim-import-broken', '落地件 import 说明符改一字节（语法仍合法）⇒ --check 必须红并点名 C1b/C1d', [`--dsh-home=${env.noGroupHome}`, `--shim=${brokenPath}`, ...baseArgs], ['C1b-artifact-import', 'C1d-artifact-tokenize'])
      drill('shim-import-broken-apply', '同一发改坏的落地件 ⇒ --apply 必须拒绝执行并点名 AP-pre-artifact（不许把钩子指向一个 import 不起来的件）', [`--dsh-home=${env.noGroupHome}`, `--shim=${brokenPath}`, ...baseArgs], ['AP-pre-artifact'], [], '--apply')
      // 还原：把件换回原件（一个字节都不改），必须重新绿；再重读盘上那份核对 sha 与前置一致。
      drill('shim-import-restored', '还原成原件（未动一字节）⇒ 必须重新绿（证「变红」不是普遍性的红）', [`--dsh-home=${env.noGroupHome}`, `--shim=${env.shim}`, ...baseArgs], [], [], '--check', 0)
      const shaAfter = sha256buf(fs.readFileSync(env.shim))
      say(`         sha256 三元组：前置 ${shaBefore.slice(0, 16)}… / 改坏 ${shaBroken.slice(0, 16)}… / 还原后重读 ${shaAfter.slice(0, 16)}…（原件未被动过：${shaAfter === shaBefore ? '是' : '否'}）`)
      CRIT.push({ id: 'SELFTEST-DRILL:shim-import-sha-triple', title: '落地件反证的 sha256 三元组自洽（原件 / 改坏 / 还原后重读）', expect: '前两段不同（改坏确实改了字节），且«还原后重读» == «原件»（反证全程没碰过被观测的那棵树）', actual: `sha256 前置=${shaBefore} 改坏=${shaBroken} 还原后重读=${shaAfter}`, ok: shaBefore !== shaBroken && shaAfter === shaBefore, soft: false, fix: '三元组不自洽 ⇒ 这一格改的不是「临时副本」而是被观测的那个件（合成环境被污染，后续判据全部不可信）。' })
      rows.push({ drill: 'shim-import-sha-triple', exit: null, ok: shaBefore !== shaBroken && shaAfter === shaBefore })
    }
  }
}

function runSelftest () {
  say('══════════════════════════════════════════════════════════════════════════════')
  say(' C30 --selftest：变异反证（把每条判据的期望改坏，断言它必须变红）')
  say('══════════════════════════════════════════════════════════════════════════════')
  say('')
  say(' 口径：每一例都 spawn 本脚本自身，带 --mutate=<判据名>；要求 (a) exit=1 (b) 输出里点名那条判据。')
  say('       末尾另跑四条**不带变异**的基线，要求 exit=0（证明「变红」不是普遍性的红）。')
  say('       基线跑在**合成环境**上（prefix/profile/shim 都是副本，会话日志仍用真机的）：')
  const env = buildSelftestEnv()
  say(`         合成 prefix=${env.prefixOk ? env.prefix : `(建不起来：${env.why})`}`)
  say(`         合成 dsh-home=${env.dshHome}；合成接线目标=${env.shim ?? '(无)'}（${env.shimSha === null ? '不在' : `sha256=${env.shimSha.slice(0, 16)}…`}）`)
  say(`         会话日志仍用真机的 --sessions-root=${env.realSessions}`)
  // 合成环境**与真机同形**这一条自己要能说清：peer 层是 junction 到宿主真身，不是拷贝。
  // 这一格是本单新增的：四条基线原本红的理由就是「合成环境缺 peer 链接」——那是环境缺陷。
  {
    const pe = env.peers
    const shape = pe === null
      ? `没建起来：${env.why ?? '未知'}`
      : `清单（派生自 ${pe.derivedFrom}）= ${pe.peers.join('、')}；已接 ${pe.linked.length} 个 junction：${pe.linked.join('、') || '(无)'}${pe.missing.length > 0 ? `；**没接上**：${pe.missing.join('、')}` : ''}`
    say(`         合成 peer 层=${shape}`)
    CRIT.push({
      id: 'SELFTEST:ENV:peer-shape',
      title: '合成环境复刻真机的 peer 形状（junction 到宿主真身，不是拷贝）',
      expect: `从 install.mjs 的 HOST_PEERS 与包 peerDependencies 派生的每个 peer 都建出 junction（真机 linkHostPeers 建的就是这些），一个不缺`,
      actual: shape,
      ok: pe !== null && pe.peers.length > 0 && pe.missing.length === 0 && pe.linked.length === pe.peers.length,
      soft: false,
      fix: '找不到 peer 源目录 / 建链失败 ⇒ **合成环境没能复刻真机的 peer 链接**，此时基线的红是环境缺陷不是判据的判定力：先看真 prefix 那几条 junction 的 realpath 在不在，再看 `npm root -g` 下 `<…>/@deepseek-ai/dsh/node_modules/@deepseek-ai` 里有没有同名包。',
    })
  }
  // 同理：**宿主钩子配置**也得在合成家目录里（路径重写成合成家目录）。
  // 缺了它，采样针就只能回落到过宽的 `--host=dsh` ⇒ 合成跑的「实测形状」其实是真机那些钩子。
  {
    const hc = env.hooksConfig
    const shape = hc === null
      ? `没建起来（${env.why ?? '未知'}）`
      : `${hc.path}；入口 ${hc.entries.length} 条（事件：${hc.events.join('/') || '无'}）= ${hc.entries.join('、') || '(空)'}${hc.why === null ? '' : `；**有问题**：${hc.why}`}`
    say(`         合成宿主 hooks 配置=${shape}`)
    CRIT.push({
      id: 'SELFTEST:ENV:hooks-config',
      title: '合成环境里也有宿主的钩子配置（路径重写成合成家目录）——采样针因此指向合成环境自己',
      expect: '合成 dsh-home 下有一份 aurapolaris-hooks.json，抠得出 ≥1 条入口，且没有一条仍指向真家目录',
      actual: `入口 ${hc?.entries.length ?? 0} 条（真机那份抠出 ${hc?.realEntries.length ?? 0} 条）；${hc?.why ?? '路径重写没盖全'}`,
      ok: hc !== null && hc.why === null && hc.entries.length > 0 && hc.realEntries.length > 0,
      soft: false,
      fix: '合成环境没复刻宿主的钩子配置 ⇒ 采样针会回落到过宽的 `--host=dsh`，合成跑读到的是**真机**的钩子进程（环境缺陷，不是判据的判定力）：核对真机 <DSH_HOME>/aurapolaris-hooks.json 在不在、家目录路径重写规则有没有盖全（正/反斜杠两种写法都要换）。',
    })
  }
  say('')
  // 【C64 加的那一个开关】合成跑里「仓库落仓件」也改指**合成 prefix 里那份**：C1a 的期望现在派生自
  //   仓库落仓件（不再手抄 sha），而合成环境里的安装副本是从 `dist` 拷进去的 —— 让两边都落在合成树内，
  //   C1a/C1e 证的才是「合成环境里这两份一致」这条不变式。不这么指的话，合成跑会拿**真仓库**那份
  //   去比**合成安副本**：执行器一旦被改而 dist 还没重建，就变成「C1a 红」而那不是合成环境的缺陷。
  const wireArgs = env.prefixOk ? [`--dsh-home=${env.dshHome}`, `--prefix=${env.prefix}`, `--sessions-root=${env.realSessions}`, `--shim-src=${env.shim}`] : []
  const rows = []
  for (const c of SELFTEST_CASES) {
    const r = spawnSync(process.execPath, [SELF, c.mode, `--mutate=${c.mut}`, ...wireArgs, ...(c.extra ?? [])], { encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 1 << 26, cwd: REPO })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const named = out.includes(`✗ ${c.red}`)
    const ok = r.status === 1 && named
    rows.push({ ...c, exit: r.status, named, ok })
    say(` ${ok ? '✓' : '✗'} ${padR(c.mode, 15)} --mutate=${padR(c.mut, 20)} ⇒ exit=${r.status} 点名 ${c.red}：${named ? '是' : '否'}`)
    CRIT.push({ id: `SELFTEST:${c.mode}:${c.mut}`, title: `变异反证 ${c.mut} → ${c.red}`, expect: 'exit 1 且点名该判据', actual: `exit=${r.status} 点名=${named}`, ok, soft: false, fix: '这条判据没有判定力：期望被改坏却没变红 —— 等于它永远是绿的。' })
  }
  say('')
  say('')
  say(' B2 时间线合成状态证伪（纯计算，不 spawn、不读写盘）：installedAt=旧、upgradedAt=新、hostStart 落在两者之间')
  say(`         合成状态 installedAt=${SYNTH_INSTALLED_AT}、upgradedAt=${SYNTH_UPGRADED_AT}、hostStart=${SYNTH_HOST_START}`)
  say(`         旧口径（只取 installedAt）→ ${SYNTH.legacyEffective ? '已生效（假绿）' : '未生效（不假绿）'}；` +
      `B2 现口径（取同类字段最大值 ${SYNTH.r.ms === null ? '—' : new Date(SYNTH.r.ms).toISOString()} 取自 ${SYNTH.r.field}）→ ${SYNTH.verdictZh}`)
  say(` ${SYNTH.ok ? '✓' : '✗'} 合成时间线  宿主落在 installedAt 与 upgradedAt 之间 ⇒ 要求结论=未生效`)
  say(` ${SYNTH.okEarly && SYNTH.okLate && SYNTH.okNone ? '✓' : '✗'} 合成时间线  宿主早于两个时间戳 ⇒ 要求未生效；晚于最大值 ⇒ 要求已生效；合成空状态 ⇒ 要求未观测`)
  CRIT.push({
    id: 'SELFTEST:B2-timeline:synthetic-upgraded-between',
    title: '合成状态：installedAt=旧 + upgradedAt=新，hostStart 落在两者之间 ⇒ B2 必须说「未生效」',
    expect: `取同类时间戳（${STATE_TS_FIELDS.join('/')}）的最大值 ${new Date(Date.parse(SYNTH_UPGRADED_AT)).toISOString()}（= upgradedAt 那个点）且结论 = 未生效`,
    actual: `结论=${SYNTH.verdictZh} 生效时间=${SYNTH.r.ms === null ? '—' : new Date(SYNTH.r.ms).toISOString()} 取自字段=${SYNTH.r.field ?? '—'}；同输入下旧口径（只取 installedAt）= ${SYNTH.legacyEffective ? '已生效（假绿）' : '未生效'}`,
    ok: SYNTH.ok,
    soft: false,
    fix: 'B2 又变成只看某一个字段了（只取 installedAt 会对「首次安装后、本次升级前启动的宿主」假绿）：把生效时间改回「同类时间戳字段的最大值」。',
  })
  CRIT.push({
    id: 'SELFTEST:B2-timeline:synthetic-neighbors',
    title: '合成状态边界：宿主早于两个时间戳 ⇒ 未生效；晚于最大值 ⇒ 已生效；无时间戳 ⇒ 未观测',
    expect: '早于两个时间戳=未生效 / 晚于最大值=已生效 / 空状态=未观测（三格都要判对）',
    actual: `早于（${SYNTH_BEFORE_HOST}）=${SYNTH.okEarly ? '未生效' : '不是未生效'} 晚于（${SYNTH_AFTER_UPGRADE}）=${SYNTH.okLate ? '已生效' : '不是已生效'} 空状态=${SYNTH.okNone ? '未观测' : '不是未观测'}`,
    ok: SYNTH.okEarly && SYNTH.okLate && SYNTH.okNone,
    soft: false,
    fix: 'B2 的判定方向或「都缺失 ⇒ 未观测」的分支被改坏了：核对 timelineVerdictOf 的三条出口。',
  })
  say('')
  say(' 夹具反证：--fixture=<kind>（合成「重启后」形状）—— 期望 ok ⇒ exit 0、bad ⇒ exit 1 且点名 P1/P3')
  for (const f of SELFTEST_FIXTURES) {
    if (!env.prefixOk) {
      rows.push({ mode: '--post-restart', fixture: f.kind, exit: null, ok: false })
      say(` ✗ 夹具 ${padR(f.kind, 18)} ⇒ 未跑（合成环境没建起来：${env.why}）`)
      CRIT.push({ id: `SELFTEST:FIXTURE:${f.kind}`, title: `夹具反证 ${f.kind}`, expect: `exit ${f.exit}`, actual: `未跑：合成环境没建起来（${env.why}）`, ok: false, soft: false, fix: '合成环境没建起来就不许拿真机读数冒充「判定链会判」：先修合成环境（peer junction），再跑这一格。' })
      continue
    }
    const rf = spawnSync(process.execPath, [SELF, '--post-restart', `--fixture=${f.kind}`, ...wireArgs], { encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 1 << 26, cwd: REPO })
    const outF = `${rf.stdout ?? ''}${rf.stderr ?? ''}`
    const namedF = f.reds.every((id) => outF.includes(`✗ ${id}`))
    const okF = rf.status === f.exit && namedF
    rows.push({ mode: '--post-restart', fixture: f.kind, exit: rf.status, ok: okF })
    say(` ${okF ? '✓' : '✗'} 夹具 ${padR(f.kind, 18)} ⇒ exit=${rf.status}（要求 ${f.exit}）${f.reds.length > 0 ? ` 点名 ${f.reds.join('/')}：${namedF ? '是' : '否'}` : ''}`)
    CRIT.push({ id: `SELFTEST:FIXTURE:${f.kind}`, title: `夹具反证 ${f.kind}`, expect: `exit ${f.exit}${f.reds.length > 0 ? ` 且点名 ${f.reds.join('/')}` : ''}`, actual: `exit=${rf.status} 点名=${namedF}`, ok: okF, soft: false, fix: '判定链对这一种「重启后」形状判错了：检查 P1/P3 的判据方向与阈值。' })
  }
  say('')
  for (const m of ['--check', '--apply', '--rollback', '--post-restart']) {
    if (!env.prefixOk) {
      rows.push({ mode: m, mut: '(基线)', exit: null, ok: false })
      say(` ✗ 基线 ${padR(m, 15)} ⇒ 未跑（合成环境没建起来：${env.why}）`)
      CRIT.push({ id: `SELFTEST:BASE:${m}`, title: `基线 ${m}`, expect: 'exit 0（无变异时在合成环境上全绿）', actual: `未跑：合成环境没建起来（${env.why}）`, ok: false, soft: false, fix: '合成环境建不起来时不许退回真机口径：真机当下可能恰好满足/不满足，两种读数都证明不了「无变异时全绿」。先修合成环境。' })
      continue
    }
    const r = spawnSync(process.execPath, [SELF, m, ...wireArgs], { encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 1 << 26, cwd: REPO })
    const ok = r.status === 0
    const why = ok ? '' : oneLine(String(r.stdout ?? '').split('\n').filter((l) => l.includes('✗')).slice(0, 3).join(' / ')).slice(0, 200)
    rows.push({ mode: m, mut: '(基线)', exit: r.status, ok })
    say(` ${ok ? '✓' : '✗'} 基线 ${padR(m, 15)} ⇒ exit=${r.status}（要求 0）${ok ? '' : ` 红判据：${why}`}`)
    CRIT.push({ id: `SELFTEST:BASE:${m}`, title: `基线 ${m}`, expect: 'exit 0（无变异时在合成环境上全绿）', actual: `exit=${r.status}${ok ? '' : `；红判据：${why}`}`, ok, soft: false, fix: '基线不为 0：先把 --check 的红判据修掉，再谈变异反证（合成环境本身也可能是原因）。' })
  }
  runWiringDrills(rows, env)
  report.selftest = rows
}

// ═════════════════════════════════════════════════════════════════════════════
// §11 合成夹具（只给 --fixture 用）：证明 --post-restart 的判定链**两种形状都会判**
// ═════════════════════════════════════════════════════════════════════════════
/**
 * 造一份「重启之后」形状的会话日志（引擎侧回执 + 钩子墙钟），并把这轮的时间线钉到「刚重启」上。
 *
 * 【为什么需要它】P1/P2/P3 三条判据只在「宿主已重启」时才是硬的；而本机现在还没重启 ——
 * 那段判定代码会处于「从未见过重启形状输入」的状态。合成夹具把两种形状各跑一遍，
 * 能证明的是：**判定链会判**（ok ⇒ 绿；bad ⇒ 命中它自己写的判红条件）。
 * 它证明不了真机读数 —— 所以用了夹具时头部与小结都会打「合成夹具」。
 *
 * @param kind - `post-restart-ok`（新壳正常回执 + 80ms 量级钩子）| `post-restart-bad`（旧壳抛错 + 690ms 量级钩子）
 */
function buildFixture (kind) {
  if (MODE !== 'post-restart') throw new Error('--fixture 只与 --post-restart 合用（它造的就是重启后的形状）')
  const fresh = String(kind).includes('ok')
  const dir = path.join(TMP, 'fixture-sessions', `--${REPO.replace(/[:\\/]+/g, '-')}--`)
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const t0 = now - 30000
  SIM_START = now - 60000
  const lines = []
  const push = (o) => lines.push(JSON.stringify(o))
  const callId = 'call_c30_fixture'
  push({ type: 'tool/call', time: t0 + 1000, data: { name: 'aura_read', callId, arguments: JSON.stringify({ file_path: 'aura-tools/README.md', mode: 'search', search: ABSENT_TOKEN }) } })
  const receipt = fresh
    ? `Error (READ_NOT_FOUND): no line contains "${ABSENT_TOKEN}"\nnext: re-read with mode=map and ask for something that is there`
    : `Error: READ_NOT_FOUND: no line contains "${ABSENT_TOKEN}"`
  push({ type: 'tool/result', time: t0 + 1500, data: { message: { source: { callId }, content: [{ type: 'tool-result', isError: !fresh, content: [{ type: 'text', text: receipt }] }] } } })
  for (let i = 0; i < 24; i += 1) {
    push({ type: 'hook/result', time: t0 + 2000 + i * 10, data: { point: 'PreToolUse', handlerId: 'codex:PreToolUse:2840', decision: 'pass', exitCode: 0, durationMs: fresh ? 78 + (i % 7) : 686 + (i % 11) } })
  }
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')))
  SESSIONS_ROOT = path.join(TMP, 'fixture-sessions')
  return { kind, fresh, events: lines.length, simStart: SIM_START, sessionsRoot: SESSIONS_ROOT }
}

// ═════════════════════════════════════════════════════════════════════════════
// §12 主流程
// ═════════════════════════════════════════════════════════════════════════════
let FIXTURE_INFO = null
if (FIXTURE !== '') FIXTURE_INFO = buildFixture(FIXTURE)
if (SIM_START === null && argOf('simulate-restart', '') !== '') {
  const raw = argOf('simulate-restart', '')
  const ms = Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(raw)
  if (!Number.isFinite(ms)) { say(`用法错：--simulate-restart=${raw} 既不是毫秒也不是可解析的时间`); process.exit(2) }
  SIM_START = ms
}
say('══════════════════════════════════════════════════════════════════════════════')
say(` C30 激活与验证可执行件 —— 模式 --${MODE}`)
say('══════════════════════════════════════════════════════════════════════════════')
say('')
say(` 仓库      : ${REPO}`)
say(` 本脚本    : ${relRepo(SELF)}`)
say(` node      : ${process.version}   时间: ${report.at}`)
say(` DSH_HOME  : ${DSH_HOME}`)
say(` 宿主 profile : ${PROFILE}`)
say(` 安装前缀  : ${PREFIX}`)
say(` pwsh      : ${PWSH ?? '(不可用)'}`)
say(` 暂存箱    : ${TMP}${KEEP_TMP ? '（保留）' : '（退出前删除）'}`)
if (MUT.size > 0) say(` ⚠ 变异反证 : 期望被故意改坏的判据 = ${[...MUT].join(', ')}（本轮必须逐条变红）`)
say(` 口径      : 被观测的树全程只读（~/.aura 整棵 —— C57 起由 A5-home-untouched 逐件实测、~/.dsh、安装副本、previous/、宿主 profile、落地件）；写盘只有 ${YES && (MODE === 'apply' || MODE === 'rollback') ? '暂存箱 + 仓库内哨兵旁路索引 + 显式 --yes 的那一个 profile 写入' : '暂存箱与仓库内哨兵旁路索引（两者都不含 ~/.aura）'} —— 逐条见末尾「写盘清单」`)
if (FIXTURE_INFO !== null) {
  say(` ⚠ 合成夹具 : --fixture=${FIXTURE_INFO.kind}（真机读数一概不经过它；它只证「判定链会判」）`)
  say(`              合成会话日志 = ${FIXTURE_INFO.events} 条事件，时间线钉在 ${new Date(FIXTURE_INFO.simStart).toISOString()}`)
} else if (SIM_START !== null) {
  say(` ⚠ 时间线被覆盖 : --simulate-restart=${new Date(SIM_START).toISOString()}（只给夹具/调试用，不当作真机读数）`)
}
report.fixture = FIXTURE_INFO
report.simulatedStart = SIM_START === null ? null : new Date(SIM_START).toISOString()

let BASE = null
switch (MODE) {
  case 'check': BASE = runCheck(); break
  case 'apply': BASE = runApply(); break
  case 'rollback': BASE = runRollback(); break
  case 'post-restart': BASE = runPostRestart(); break
  case 'selftest': runSelftest(); break
  default: say(`内部错：模式 ${MODE} 没有实现`); process.exit(2)
}

// ── 小结 ──
hr('小结')
const R = reds()
const W = warns()
const NOTED = CRIT.filter((c) => c.ok && c.soft).length
// 回执要能直接引用的那几格读数（--json 里也有一份，供机器取）
report.readings = BASE === null || BASE === undefined
  ? null
  : {
      installStamp: BASE.install?.ok ? BASE.install.buildStamp : null,
      prevStamp: BASE.prev?.ok ? BASE.prev.buildStamp : null,
      host: BASE.host?.host === null || BASE.host?.host === undefined ? null : { pid: BASE.host.host.pid, startMs: Number(BASE.host.host.startMs), cmd: clip(String(BASE.host.host.cmd ?? ''), 160) },
      installedAt: BASE.state?.installedAt ?? null,
      upgradedAt: BASE.state?.upgradedAt ?? null,
      // B2 真正用的那一格：同类时间戳字段的最大值 + 取自哪个字段（installedAt 单独一格只能当参考）
      installEffective: { ms: BASE.installedAtMs ?? null, field: BASE.installTimeField ?? null, maxOf: BASE.installTimeMaxOf ?? null, fields: STATE_TS_FIELDS },
      engineShapeFromLog: BASE.engineReading === null || BASE.engineReading === undefined ? null : { shape: BASE.engineReading.shape, isError: BASE.engineReading.isError, time: BASE.engineReading.time, via: BASE.engineReading.via },
      fingerprintShapes: { installed: BASE.fpNew?.shape ?? null, previous: BASE.fpOld?.shape ?? null },
      profileLine: BASE.profile?.ok ? { line: BASE.profile.nameLineNo, value: String(BASE.profile.nameLine ?? '').trim(), sha256: BASE.profile.sha256, bytes: BASE.profile.bytes } : null,
      artifact: BASE.artifact === undefined ? null : { bytes: BASE.artifact.stat?.bytes ?? null, sha256: BASE.artifact.stat?.sha256 ?? null, importName: BASE.artifact.import?.defaultName ?? null, generatorSame: BASE.artifact.generator?.same ?? null },
      hookP50All: BASE.hooksAll ?? null,
      hookP50Post: BASE.hooksSince ?? null,
      // C58：P3 到底用的哪个窗口（起始时刻 / 取自几份会话 / 窗口内几条 / 窗口外剔除几条）—— 机器可读的一份
      hookWindow: BASE.hookWindow ?? null,
      sentinelCensus: BASE.sentinel === undefined || BASE.sentinel === null
        ? null
        : { candidates: BASE.sentinel.candidates, files: BASE.sentinel.files, knownSentinel: BASE.sentinel.knownSentinel, probed: BASE.sentinel.probed.length, allHits: BASE.sentinel.allHits, hitsInWindow: BASE.sentinel.hitsInWindow.length, window: BASE.sentinel.window, index: BASE.sentinel.index, indexUpdated: BASE.sentinel.updated === true, readingFile: BASE.sentinel.row === null ? null : path.basename(path.dirname(BASE.sentinel.row.file)) },
      hookInternalP50: BASE.guard?.p50 ?? null,
      shellTaxMs: BASE.hooksAll?.p50 !== null && BASE.hooksAll?.p50 !== undefined && BASE.guard?.p50 !== null && BASE.guard?.p50 !== undefined ? Math.round((BASE.hooksAll.p50 - BASE.guard.p50) * 10) / 10 : null,
      watch: BASE.watch === undefined ? null : { seconds: BASE.watch.seconds, entry: BASE.watch.entry ?? null, old: BASE.watch.obs.filter((o) => o.verdict === 'old').length, new: BASE.watch.obs.filter((o) => o.verdict === 'new').length },
    }
say(` 判据：绿 ${CRIT.length - R.length - W.length}（其中口径读数/不计红 ${NOTED} 条）/ 红 ${R.length}${W.length > 0 ? ` / 待观测(不计红) ${W.length}` : ''}`)
if (R.length > 0) {
  say('')
  for (const c of R) say(` ✗ ${c.id}  ${c.title}\n     期望 ${c.expect}\n     实际 ${c.actual}\n     修法 ${c.fix ?? '(无)'}`)
  say('')
  say(' ⇒ 有硬判据红：先按上面的修法逐条处理（退出码 1）。')
} else {
  say(' ⇒ 全部硬判据绿（退出码 0）。')
}
if (W.length > 0) say(` · 待观测/不计红：${W.map((c) => c.id).join('、')}`)
say(` 写盘清单：${WRITES.length === 0 ? '本次没有写盘' : WRITES.map((w) => `${w.scope}:${relRepo(w.path)}（${w.what}）`).join('；')}`)
if (GUARD_HITS.length > 0) say(` 写入守卫拦下：${GUARD_HITS.map((g) => `${relRepo(g.path)}（${g.what}）`).join('；')}`)
say(` 退出码：${R.length > 0 ? 1 : 0}`)

report.crit = CRIT
report.red = R.map((c) => c.id)
report.warn = W.map((c) => c.id)
report.exit = R.length > 0 ? 1 : 0
if (JSON_OUT) {
  say('')
  say('--- JSON ---')
  say(JSON.stringify(report, null, 2))
}
process.exit(report.exit)
