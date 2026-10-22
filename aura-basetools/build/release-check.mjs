#!/usr/bin/env node
/**
 * release-check.mjs —— 发布前的**全量测试闸**：一条命令跑完所有该跑的东西，并给一个总判定。
 *
 *   node build/release-check.mjs            # 人看
 *   node build/release-check.mjs --json     # 机器看
 *   node build/release-check.mjs --skip-upgrade   # 升级套件还没建好时的过渡（发布时不许跳）
 *
 * 为什么要有它：发布前"应该跑什么"如果靠人记，漏一项就是一次事故（本轮已经吃过一次：
 * 改了源没重建 dist，于是同一个版本号下有两份不同字节）。这里把清单**固定**下来：
 *   ① 套件（闸内逐件实跑）② 三套靶场 ③ 包内自带验收 ④ 一键安装器 ⑤ 服务化升级（+独立审计探针）
 *   ⑥ src↔dist 一致性 ⑦ 发布清单新鲜度 ⑧ 版本一致性 ⑨ DSH 就绪 ⑩ **普查完整性**（C32）
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

const root = path.resolve(import.meta.dirname, '..')
const json = process.argv.includes('--json')
const skipUpgrade = process.argv.includes('--skip-upgrade')

const rows = []
/** C37：**闸内实跑过的每一个套件文件**（不管它是从 `SUITES` 那一条循环来的，还是 §④/§⑤ 单独调的）。
 *  §⑩ 的普查拿它当“枚举名单”—— 这样“登记了”就不再是一份人手抄的第二张表，而是**闸真的跑过它**
 *  这件事本身；把 `build/install-test.mjs` 这类单独调用的套件也算进来，才不会有“明明在跑、
 *  普查却说你没登记”的假红。 */
const ranSuites = []
const run = (relative, args = []) =>
  spawnSync(process.execPath, [path.join(root, relative), ...args], { cwd: root, encoding: 'utf8', timeout: 1800000 })

/** 跑一个"自报成绩"的套件：取最后一行含"通过"的文本作为摘要，退出码为准。 */
function suite(name, relative) {
  ranSuites.push(relative)
  if (!fs.existsSync(path.join(root, relative))) {
    rows.push({ group: '套件', name, status: 'missing', summary: '(文件不存在)' })
    return
  }
  const res = run(relative)
  const summary = (res.stdout ?? '')
    .trim()
    .split('\n')
    .filter((line) => line.includes('通过') || line.includes('失败'))
    .pop()
  rows.push({
    group: '套件',
    name,
    status: res.status === 0 ? 'ok' : 'fail',
    summary: (summary ?? '').trim(),
    stderr: (res.stderr ?? '').trim().split('\n').slice(0, 2).join(' | '),
  })
}

// ① 既有套件（顺序固定：先引擎、再工具壳）
const SUITES = [
  ['write-verify', 'src/locator-lab/write-verify-test.mjs'],
  ['stale-gate', 'src/locator-lab/stale-gate-test.mjs'],
  // C32：文件已按普查口径改名（`*-test.mjs`），断言仍 102 条；旧名 `byte-fidelity.mjs` 不再存在。
  ['byte-fidelity', 'src/locator-lab/byte-fidelity-test.mjs'],
  ['encoding-fidelity', 'src/locator-lab/encoding-fidelity.mjs'],
  ['span-fidelity', 'src/locator-lab/span-fidelity.mjs'],
  ['policy-arg', 'src/locator-lab/policy-arg-test.mjs'],
  ['struct', 'src/locator-lab/struct-test.mjs'],
  ['corpus', 'src/locator-lab/corpus-test.mjs'],
  ['read-schema', 'src/locator-lab/aura-read-schema-test.mjs'],
  ['read-fidelity', 'src/locator-lab/read-fidelity.mjs'],
  ['read', 'src/locator-lab/read-test.mjs'],
  ['read2', 'src/locator-lab/read-test2.mjs'],
  ['lang', 'src/locator-lab/lang-test.mjs'],
  ['layers', 'src/locator-lab/layers-test.mjs'],
  ['regex-lex', 'src/locator-lab/regex-lex-test.mjs'],
  // 语言覆盖测试：每个新语言的符号/跨度/`target=`/负向断言（F1 的专用验收）
  ['lang-coverage', 'src/locator-lab/lang-coverage-test.mjs'],
  // 带修饰符/导出的变量绑定（T7）：`export const X` 必须可按名寻址，
  // 且补 `$mods*` 不得让多修饰符声明报出重复符号。
  ['var-binding', 'src/locator-lab/var-binding-test.mjs'],
  // 适配器面（裸函数 / OpenAI / MCP）与"未配置语言必须被拒"。
  // 此前它**不在本清单里**，所以恒红的两条断言（拿 .hs 当"未配置"样本，
  // 而语言表后来把 Haskell 登记了）一直没人发现——一个不进闸门的套件等于不存在。
  ['adapters', 'src/locator-lab/adapters.mjs'],
  // 写路径的物理前提：原子发布必换 inode，因此版本令牌能区分同尺寸改动。
  // 没有这一条时，“必须原子发布”只能靠人记得（T20）。
  ['atomic-publish', 'src/locator-lab/atomic-publish-test.mjs'],
  // 差分测试：期望值由**两个独立实现互相提供**，不靠人写。
  // 它抓的是"测试与代码共享同一个盲区"——本项目已因此三次全绿带真 bug。
  ['differential', 'src/locator-lab/differential-test.mjs'],
  // 导出面是一等公民：`map` 必须能用**常数成本**回答"这个模块给别人什么"（T25）。
  ['export-surface', 'src/locator-lab/export-surface-test.mjs'],
  // 新鲜度判据（时间戳不可用）与 Rust `pub const` 的已知形状（T23 / T28）。
  ['fresh-judgement', 'src/locator-lab/fresh-judgement-test.mjs'],
  // 行号地址的漂移判据（T21）：位移后“同址文本恰好相符”这一类**没有**被老判据拦住，
  // 而修补它的四版判据各自误杀过一例真实场景——四例与四版都钉在套件里，免得重做。
  ['coordinate-drift', 'src/locator-lab/coordinate-drift-test.mjs'],
  // 入参形状的容错面（T29）：日志里 27 次失败是“单个 hunk 平铺在顶层”。
  // 它同时钉住**分界**：宽容形状，但不宽容拼写（未声明字段仍由 schema 拒）。
  ['arg-shape', 'src/locator-lab/arg-shape-test.mjs'],
  // 属性测试（T18）：不变式而不是行为断言。随机扰动真实语料，断言“扰动前后哪些符号能寻到”
  // 是同一个集合、跨度可信、解析幂等。已验证它在“命中区域平移一行”的注入下会红。
  ['symbol-invariant', 'src/locator-lab/symbol-invariant-test.mjs'],
  // 仓库级粗粒度地图（T26）：`aura_read <目录>` 的判据——预算、跨语言依赖方向、忽略规则、
  // 候选选择（只读被选中的文件）、以及“预算不够时从后往前丢并自报”。
  ['repo-map', 'src/locator-lab/repo-map-test.mjs'],
  // **真框架冒烟**：把两个插件注册进真的 @deepseek-ai/dsh-tools，并用真校验器验 execute 的返回值。
  // 它补的是 mock 套件看不见的那一格：mock 不校验 schema，而本仓被这一形态咬过三次
  // （`text` 未声明 / `dry_run` 未声明 / 未声明字段被拒），每次都是**每条成功路径被框架拒**而套件全绿。
  // 解析不到宿主 peer 时它自报跳过（exit 0）——但会把“跳过”印得显眼。
  ['real-framework', 'src/locator-lab/real-framework-smoke-test.mjs'],
  // ↓ 四类各一块，按“问的问题”分，而不是按文件分（见 public-surface-test 头部那张表）：
  //   验收·接口 —— 对外承诺的每一条还在不在（导出面 / 插件四件套 / bin / 参数键同源 / 文档路径）
  ['public-surface', 'src/locator-lab/public-surface-test.mjs'],
  //   验收·文档 —— `docs/embed-example` 说的做法**照做真能跑**（空目录、零安装）
  ['embeddability', 'src/locator-lab/embeddability-test.mjs'],
  //   端到端+集成 —— CLI / MCP 当**真进程**驱动，多次调用串起来（含令牌跨进程、并发多进程）
  ['cli-mcp-e2e', 'src/locator-lab/cli-mcp-e2e-test.mjs'],
  //   冒烟·部署 —— **装出来的那一份**能不能用（每个 .mjs 真 import / peer 从装包位置可解析）
  ['installed-package', 'src/locator-lab/installed-package-test.mjs'],
  // ── C32 补登：以下 18 件**本来就在 `src` 下自带判据与汇总行**，却因为"清单靠人手抄"而没进闸。
  //    一半的漏网原因是文件名：老口径把"普查"理解成"名字匹配 `*-test.mjs`"（`byte-fidelity.mjs`
  //    就是这么漏的），另一半是纯粹没人登记（17 个 `*-test.mjs` 一直在闸外红着也没人知道）。
  //    口径与 §⑩ 的机检同源：判定权在**文件的形态**（自有判据调用 / 退出码判据 / 打印通过·失败汇总行），
  //    不在文件名。补登后闸内 52 件，其中 51 件自带判据、1 件（`read-fidelity`）只读数不判定。
  //    C42 提醒：这里的“自带判据”是**算出来的**（见 §⑩ 的 S1/S1b/S1c/S2）——
  //    而“自带判据”曾把一件没有退出码接线的套件（`corpus`）也算进去，所以 §⑩ 另加了闸门 A7。
  // 引擎侧（locator-lab）：
  ['anchor-cache', 'src/locator-lab/anchor-cache-test.mjs'],
  ['assert-contains', 'src/locator-lab/assert-contains-test.mjs'],
  ['content-address', 'src/locator-lab/content-address-test.mjs'],
  ['expect-address-form', 'src/locator-lab/expect-address-form-test.mjs'],
  ['expect-single-source', 'src/locator-lab/expect-single-source-test.mjs'],
  ['incremental-read', 'src/locator-lab/incremental-read-test.mjs'],
  ['index-cache', 'src/locator-lab/index-cache-test.mjs'],
  ['notfound-receipt', 'src/locator-lab/notfound-receipt-test.mjs'],
  ['old-fragment-fallback', 'src/locator-lab/old-fragment-fallback-test.mjs'],
  ['range-args', 'src/locator-lab/range-args-test.mjs'],
  ['range-formats', 'src/locator-lab/range-formats-test.mjs'],
  ['read-continuation', 'src/locator-lab/read-continuation-test.mjs'],
  ['write-gate-cost', 'src/locator-lab/write-gate-cost-test.mjs'],
  // **探针形状**：文件名不匹配 `*-test.mjs`，但有 13 条自有判据并以退出码表态
  //（冻结基准夹具的完整性、三列分桶和、语料账本）。它一直是"自带判据却不进闸"的第二例。
  ['failure-replay', 'src/locator-lab/failure-replay.mjs'],
  // 独立面（包内那份 `standalone-test` 在 §③ 以 dist 形态跑；这里跑的是 src 那一份，
  // 两份逐字节相同——§⑥ 保证——所以两边都不能省：一处查"包里那份能用"，一处查"源这侧能过"）：
  ['standalone', 'src/aura-standalone/test/standalone-test.mjs'],
  ['range-bytes', 'src/aura-standalone/test/range-bytes-test.mjs'],
  // 壳侧：
  ['aura-read/outcome', 'src/aura-read/outcome-test.mjs'],
  ['aura-edit/outcome', 'src/aura-edit/outcome-test.mjs'],
  ['aura-read/load', 'src/aura-read/load-test.mjs'],
  ['aura-edit/load', 'src/aura-edit/load-test.mjs'],
  ['aura-edit/align', 'src/aura-edit/align-test.mjs'],
  // ── C37 补登：`probes/` 下的 3 件**真套件**（自带判据 + 通过/失败汇总行 + 失败非零退出，
  //    且离线自足）。此前它们一件都不在闸内 —— 闸只扫 `src/`，探针坏了也没人知道：
  //    上一波两个探针正是「判据坏了」与「不在闸内」两件事同时发生，于是一路带病通关。
  //    收件的分界线（与 §⑩ 豁免台账同源，理由逐条写在那边）：**判据必须是不随波演进的不变式**
  //    —— 引擎按契约改进之后它仍然绿，红了就该去看代码。下面三件都满足：
  //      · `adoption-stats-test`：统计逻辑的纯函数判据（会话筛选口径 / 寻址分布 / 失败判定），
  //        不需要会话日志，209ms；
  //      · `name-addressing`：判据是「按名寻址失败的回执里必须给出下一步」（行号不是 undefined），
  //        与失败条数无关，仓内固定语料，558ms；
  //      · `address-form-census`：11 条判据（含载体自证 R11/R12/R13），其中 R08 钉的是
  //        「anchor / line_cue / target 三种地址形态入口齐备」（Y=0）这个契约不变式，4.8s。
  ['probes/adoption-stats-test', 'probes/adoption-stats-test.mjs'],
  ['probes/name-addressing', 'probes/name-addressing.mjs'],
  ['probes/address-form-census', 'probes/address-form-census.mjs'],
  // C38 新建的套件（错误回执里那段「原文是什么」要能回抄命中原文）：它落地时没登记，是 §⑩ 当场
  // 点名「未登记」才补进来的 —— 这正是这条机检的用法：新放一个自带判据的文件，不问文件名、
  // 按形态发现它，然后要么登记要么写清豁免。
  ['quote-render', 'src/locator-lab/quote-render-test.mjs'],
  // C45（fs-contract-v2 波15）：编辑路径的第四条出路 —— “你要改的原文不在，但结果已经是你给的
  // 样子了，这次不用改”（`outcome: 'already_applied'`，判据是 `write-path.mjs` 的
  // `alreadyAppliedHits`）。收它的理由按 §⑩ 的分界线逐条对：
  //   · 判据是**不变式**，不是本波绝对读数：三条 —— 不得把真的找不到误判成已落地（六条负向）、
  //     磁盘一个字节都不许动（写调用数恒 0 + sha256/字节逐项不变）、重复应用同一编辑必须幂等
  //     （连打三次，写次数恒为 1）。引擎以后再改（这一类多几条少几条）它照样绿；
  //   · 离线自足：段落用仓内夹具 + 只读消费 `failure-corpus.json`，不起任何外网/子进程；
  //   · 自带通过/失败汇总行与退出码接线（末行 `process.exitCode = 1`）。
  // 与它同源的**普查件**（probes/already-applied-census.mjs）是量具，登记在下面的豁免台账里。
  ['already-applied', 'src/locator-lab/already-applied-test.mjs'],
  // C49（fs-contract-v2 波16）：第四态接到**工具面**。C45 把 `already_applied` 做进了引擎
  // 编排层（`applyEditToProvider`），而 DSH 壳的 `OUTCOMES` 里没有它 —— 同一个
  // `PATCH_NOT_FOUND` 一律折成 `not_found`，于是模型看到的仍是「找不到你要改的原文」。
  // 这一件钉的就是最后一公里，收件理由按 §⑩ 的分界线逐条对：
  //   · 判据是**不变式**，不是本波绝对读数：已落地 ⇒ 第四态 + 写调用恒 0 + 磁盘逐字节不变；
  //     真找不到 ⇒ 仍 not_found（含多 hunk 半落地）；危险短串（`}`/`ok`/`return`/`};`）
  //     一个都不许误判；第四态在 output.schema 的 enum 与字段面里声明过。它不钉"本波多少条"，
  //     引擎以后多认几条少认几条它照样绿（绿了就该去看代码）；
  //   · 离线自足：仓内 mock ctx + 临时夹具，不起子进程、不读会话日志、不碰外网；
  //   · 每段都带**反向对照**（同一份夹具换一个真在文件里的 replace ⇒ already_applied），
  //     所以"全判 not_found"的实现过不了它；
  //   · 自带通过/失败汇总行与退出码接线（末行 `process.exitCode = 1`）。
  ['already-applied-shell', 'src/aura-edit/already-applied-shell-test.mjs'],
  // C55（fs-contract-v2 波20）：非 UTF-8 文件给的是**可执行的拒绝**，不是裸的 Node 错误。
  // 收件理由按 §⑩ 的分界线逐条对：
  //   · 判据是**不变式**，不是本波绝对读数：① 四件事必须同一次说清（哪个文件 / 为什么读不了 /
  //     下一步怎么办 / 这次没写盘）；② 通道不变（DSH 侧仍抛错、独立面仍 ok:false + exit 2，
  //     不许被伪装成结果通道的意图判决）；③ **不误伤**——带 BOM 的 UTF-8 照常成功、
  //     含 NUL 的二进制仍用自己那句；④ 三个面的判据与那句话逐字同源。夹具的 sha256
  //     逐条前后复验，与具体文案无关（文案改了仍绿）；
  //   · 离线自足：临时夹具 + 仓内 mock ctx，只多起两个自己的 CLI 子进程（与 cli-mcp-e2e 同形）；
  //   · 自带通过/失败汇总行与退出码接线（末行 `process.exitCode = 1`）。
  ['encoding-refusal', 'src/locator-lab/encoding-refusal-test.mjs'],
  // C56（fs-contract-v2 波21）：账本的路径同一性要**跨进程**成立。C54 把归一化做进了引擎，
  // 但那一半的证据挂在**会话内**的折叠别名索引上（`read-core.mjs` 的 `PATH_ALIASES`）——
  // DSH 壳是长进程所以有效，而**独立面 CLI / MCP 每次调用都是新进程**：读 `Beta.js`（进程1）
  // → 第三方改掉被寻址行 → 用仅大小写不同的 `beta.js` 发无 `expect` 编辑（进程2）
  // ⇒ 改前实测 `ok:true, unverified_region:true`（**静默覆盖**，点斜线写法在同实验里被正确拒）。
  // 收件理由按 §⑩ 的分界线逐条对：
  //   · 判据是**不变式**，不是本波绝对读数：① 跨进程换写法 + 被寻址行被第三方改过 ⇒ 必须
  //     `PATCH_STALE_REGION` 且磁盘一字节不落；② **正向对照**（同一个文件换写法、无第三方改动
  //     ⇒ 照常成功且不许谎称 `unverified_region`）—— 没有它，"一律拒绝"这种实现也能让①全绿；
  //     ③ 两个**真不同**的文件（大小写敏感目录里 `Beta.js` 与 `beta.js` 并存）不许并成一个键；
  //     ④ DSH 侧进程内那条路不退化（换写法编辑成功 / 被第三方改过就拒）。引擎以后再改它照样绿；
  //   · **离线自足**：临时夹具 + 只多起自己的 CLI 子进程（与 `cli-mcp-e2e` / `encoding-refusal` 同形），
  //     缓存用 `AURA_CACHE_DIR` 指到临时目录，不碰 `~/.aura`、不读会话日志、不碰外网；
  //   · 自带通过/失败汇总行与退出码接线（末行 `process.exitCode = 1`）。
  // 为什么必须起**真进程**："每次调用都是新进程"正是这条洞的**成因**，进程内跑等于把成因抹掉。
  ['observation-store-identity', 'src/locator-lab/observation-store-identity-test.mjs'],
  // C59（fs-contract-v2 波23）：结构索引的**归属归因（`enclosing`）不再二次**。施工前实测：
  // 平坦文件里没有任何符号包含别的符号 ⇒ 旧实现「每个符号扫一遍按宽度排序的整张符号表」退化为
  // 完整 O(n²)，100000 符号档冷索引 **50510 ms**（本机复跑 67579 ms），而 `--cpu-prof` 行级 tick
  // 说那段占 `buildStructure` 自身耗时的 **99.2%** —— 「一次 read 卡几十秒」的全部来源。
  // 收件理由按 §⑩ 的分界线逐条对：
  //   · 判据是**不变式**，不是本波绝对读数：① 10 万符号档冷索引 ≤ 2 秒（施工单终态；改前 33 倍于它，
  //     必红）；② 五档每行成本不再随规模上升（末档 ≤ 首档 ×1.5；改前是 30.4 倍）；③ `enclosing`
  //     与「改前那段判据逐字照抄」的 oracle 逐符号零不一致（真实语料 2217 个符号 + 钉住形状 189 个
  //     + 确定性模糊 317 个），并且交叉覆盖是**自证**的（语料里真的出现过「重叠但不包含」的区间对）；
  //     ④ 零符号的对照文件仍走平（证明扫描器没被改坏）。引擎以后再改它照样绿，红了就该去看代码；
  //   · **离线自足**：只用仓内语料（本目录的 *.mjs）+ 仓内确定性生成器（xorshift32 固定种子），
  //     不起子进程、不读会话日志、不碰外网；冷路径靠 `import('…?scaling=N')` 拿全新模块实例；
  //   · 自带通过/失败汇总行与退出码接线（末行 `process.exitCode = 1`）。
  ['index-scaling', 'src/locator-lab/index-scaling-test.mjs'],
  // C61（fs-contract-v2 波25）：**路径别名**（junction / 符号链接）下的陈旧闸门。
  // C54 修的是"同一个文件的不同**词法**写法"（`.` 段 / 冗余分隔符 / 盘符大小写 / 进程内折叠大小写），
  // C56 修的是独立面 CLI/MCP 的**跨进程**那半（磁盘存储自己做 realpath）。DSH 壳这一侧两半都没走到：
  // 壳按 `target.displayPath` 记账，而它是 `ctx.fs.resolve()` 里 `path.resolve(cwd, p)` 的产物（纯词法）
  // ⇒ junction 两种写法在账本里是两个键：读别名、第三方改被寻址行、用真实路径发无 expect 编辑
  // ⇒ 改前 `outcome=applied`、磁盘被静默覆盖（两个方向各自复现过一次）。
  // 事实来源是宿主本来就拿着的 `ctx.fs.resolve().targetKey`（`dsh-fs` 契约："stale guards and
  // target lookup" 用的不透明键；本地后端 = `realpath`），引擎拿不到它（ENGINE 守卫禁 `node:fs`）。
  // 本套件跑的是**真壳**（两个 `apply(ctx)` + `registered.execute`）配与 `dsh-fs-local` 同形的 `ctx.fs`，
  // 在真文件系统上真建 junction；跑环境自带：
  //   · 靶场在 `os.tmpdir()` 下自建自删，不碰 `~/.aura`、不读会话日志、不起子进程、不碰外网；
  //   · 每个段先 `setObservationStore(null)`（换存储 = 换会话），段与段不互相污染；
  //   · 自带通过/失败汇总行与退出码接线（末行 `process.exitCode = 1`）。
  // 与它同源的两条：`stale-gate-test`（词法那一半）、`observation-store-identity-test`（跨进程那一半）。
  ['alias-identity', 'src/locator-lab/alias-identity-test.mjs'],
  // C62（fs-contract-v2 波29）：「工具级报错率」变成可复现、可证伪的读数。
  // 此前的语料读数只印「失败码分布」——「引擎抛错（真报错）」与「如实返回回执（不是报错）」
  // 在码分布里长得一样，却是性质相反的两件事，这一格此前没有任何判据钉住它。
  // 收件理由按 §⑩ 的分界线逐条对：
  //   · 判据是**不变式**，不是本波绝对读数：① 进了错误通道（引擎真的抛了）的每一条都必须在
  //     `probes/tool-error-rate.mjs` 那份**手写台账**里、且码逐条对得上（新抛一个码 ⇒ 红并点名，
  //     强迫人决定“它确实是工具级故障”还是“它其实可判定、该进白名单”）；② 台账的判定必须与
  //     实测通道一致（`code ∈ INTENT_CODES` ⇔ 判“可判定”）—— 把壳层白名单里的一条删掉，这一条
  //     必红（变异实测：删 `PATCH_NOT_FOUND` ⇒ exit 1 并点名 147 条）；③ 表外码的条数就是头条
  //     读数那一格（本波 Y=0），但它**不写进判据**：引擎以后多抛/少抛，台账跟着改即可，判据照绿；
  //   · 判据与读数**不同源**：重放走 `src/locator-lab/failure-replay.mjs` 导出的
  //     `replayNewContract`（与「现树·新契约」列同一个入口，没有第二份复刻的判定层）；白名单走
  //     壳层新导出的 `INTENT_CODES`，同一趟里再用**文本正则**把壳层那张表解析一遍、断言两边逐字
  //     相等 —— 导出面漂移、或壳层“表外 ⇒ 抛”那条边界被改，都会红；
  //   · 离线自足：只读仓内 `failure-corpus.json`，重放落在 `os.tmpdir()` 的临时副本上，
  //     不起子进程、不读会话日志、不碰 `~/.aura`、不碰外网；
  //   · 自带通过/失败汇总行与退出码接线（`process.exit(bad === 0 ? 0 : 1)`）。
  ['probes/tool-error-rate', 'probes/tool-error-rate.mjs'],
  // fs-contract-v2 · w28 + w30：`terminatorBlockEnd`（SQL / Erlang / Vim / HCL 的块体终结）**不再二次**。
  // 退化形状 = 整份文件一行、且语料里没有终结符 ⇒「终结符」与「换行」两条停止条件永不成立，
  // 每个声明都一路扫到 token 流末尾（改前 1k/4k/8k = 76.9 / 1145.8 / 5709.9 ms，每翻一倍 ×3.6~×5.0）；
  // w28 改成两张后缀最小值表 + 一张链尾表（每次建索引只建一次），改后 14.6 / 51.6 / 87.2 ms（×1.69~×1.99）。
  // 收件理由按 §⑩ 的分界线逐条对：
  //   · 判据是**不变式**，不是本波绝对读数：① 手写样本的**想要的跨度**逐字段写死（`;` 在下一行也要
  //     盖到它、括号组整层跨过、整份文件一行时的落点、找不到收尾时 fail-closed）——这一部分是**意图**：
  //     将来引擎真改好了要人来改期望值，那是对的；② 大批量确定性夹具的整表摘要 sha256 + 符号数 +
  //     用例数（漂移报警器，抓「没人想改却被改坏」）；③ 退化形状 1k/4k/8k **只看比值**：主判据
  //     t(8k)/t(4k) ≤ 3（线性约 1.7~2.0、二次约 5）、兜底 t(4k)/t(1k) ≤ 12；原始毫秒照印但不做判据
  //     （读数时机上可能有并行负载）；
  //   · **判定力**（变异实测）：把跳表的终结符判据短路（`isTerminatorToken(t, terminators) || …` →
  //     `false || …`）⇒ 本套件 exit 1 并逐条点名差异；按字节还原（sha256 前后一致）⇒ 立刻绿；
  //   · **覆盖事实**：仓库真实语料里**一件 `.sql` / `.erl` / `.vim` 都没有**（w28 等价性对照扫过 2000 件
  //     真实文件 / 52759 个符号，终结符型语言 **0 件**；那条路径的覆盖全部来自 128 件夹具 / 1311 个符号）
  //     ⇒ 这条路径在闸内**只有本套件**守着，所以语料全部就地生成；
  //   · **离线自足**：不读 %TEMP%、不依赖机器状态、不起子进程、不碰外网；冷路径靠 `import('…?suite=N')`
  //     拿全新模块实例（与 `index-scaling` 同一手法）；
  //   · 自带通过/失败汇总行与退出码接线（末行 `process.exitCode = …`）。
  ['terminator-scan', 'src/locator-lab/terminator-scan-test.mjs'],
  // 读侧发句柄（HD1）：句柄的确定性（同一段未变字节重读得同一个柄）/ 一字节敏感性 / 可还原 /
  //   落在 windowEnvelope 那一层而**不是正文 text**（正文才是宿主剪枝器量的东西）/ search 超上限只报数 /
  //   形状 = `15 + 起始行位数 + 结束行位数`（120-160 那一档恰 21 字符；**不补零** —— 补零会改坐标语义）。
  //   靶子用 os.tmpdir 临时文件（要真改字节），退出前删除；离线自足、不起子进程。
  //   判定力（变异实测）：把 `regionFingerprint` 改成常量 `'00000000'` ⇒ 3 条断言变红（44→41）、exit 非 0；
  //   §6b **单源**：摘要与 `contentToken` 同一哈希（行为断言只能钉口径一致），且引擎 8 个模块里
  //   **只有 handle-core.mjs 在算 FNV-1a** —— 那 3 条是**静态**断言（按 ENGINE 名单读源文件扫“FNV 质数
  //   16777619 且真出现 `Math.imul(` 调用”），因为**逐字相同的副本行为上必然全绿**。
  //   判定力（变异实测，两条）：① `regionFingerprint` 改成常量 `'00000000'` ⇒ 3 条断言变红；
  //   ② 把 FNV 循环**原样搬回** `read-core.mjs`（选这个而不是改常数，后者红得没信息量）⇒ 另 3 条静态
  //   断言变红（49/52）、而四条行为断言仍全绿 —— 这就是“行为断言看不见重复实现”的现场证据。
  //   两次都按字节还原（sha256 前后一致）⇒ **52/52** 绿。
  //   遗留提示：那 3 条静态断言的 ENGINE 名单是**手抄**自 `make-bundle.mjs` 的（import 它会执行打包
  //   脚本，红线禁止），引擎模块增减时名单要跟着改。
  ['handle-read', 'src/locator-lab/handle-read-test.mjs'],
  // 编辑侧解析句柄（HD2）：四种相对定位（整段 / 段内第 k 行 / 段内内容 / 边界插入）各自命中且**真落盘**；
  //   身份标签不符 ⇒ PATCH_HANDLE_IDENTITY_MISMATCH；区间被改坏 ⇒ PATCH_HANDLE_STALE（磁盘不动）；
  //   区间搬迁 ⇒ 按新坐标成功并在 applied[].tier 里披露 `region moved: lines A-B → C-D`；
  //   `{handle, old}` 而引文在区间外 ⇒ PATCH_HANDLE_QUOTE_OUTSIDE；形状不对 ⇒ **抛错**（参数面，刻意不进白名单）。
  //   句柄 hunk **照旧进 regionGate**（不是绕过 PATCH_STALE_REGION 的第一条路），且有对照断言钉住非句柄 hunk 一字未改。
  //   另钉一条**回归守卫**（集成时现场发现并修掉的真回归）：`line`/`position` **只有配 `handle` 才成立** ——
  //   裸 `{line: 3, replace}` 必须抛 `PATCH_NO_ADDRESS`，**不许**被规范成 `lines:[3,3]`（否则“lines 误写成
  //   line”这个最常见手误会从报错变成一次成功的错误编辑；守卫落在 `planHunks` 引擎级，因为入口不止一个）。
  //   判定力（变异实测，两条）：① 把身份标签核对短路成 `false && …` ⇒ 对应断言变红；
  //   ② 把新守卫短路成 `if (false && …)` ⇒ 段K 共 4 条变红。两次都按字节还原 ⇒ **58/58** 绿。
  ['handle-edit', 'src/locator-lab/handle-edit-test.mjs'],
  // fs-contract-v2 · mt1（红线）：**单目标不许回归**。接下来的改造是「一次调用多目标 + 调用内并发池」，
  // 全部风险都压在同一个方向上：为了多目标把单目标那条路重写一遍（多跑一次 / 多读一次 / 多建一次索引 /
  // 回执里多一个字段），而验收只看新功能通不通 ⇒ “单目标悄悄变大变慢变了形状”没有一台机器会发现。
  // 这一件就是那台机器：黄金集采自 0.6.9 现树（`fixtures/golden-single-target-0.6.9.json`，
  // 采集与比对共用同一份用例定义，所以不可能漂移），每次跑都现场重算并逐字节比对。
  // 收件理由按 §⑩ 的分界线逐条对：
  //   · 判据是**不变式**，不是本波绝对读数：四类 —— ① `readWith` 在 3 份仓内夹具 ×
  //     lines/search/digest/map 上的**整个信封逐字节**不变（12 条）；② `applyEditToProvider` +
  //     真 provider 的单 hunk 编辑：回执逐字节 + **落盘字节逐字节** + 写次数 = 1；③ 计数 provider
  //     钉住 N=1 的调用**序列与次数**（读两形状 + 写一形状）—— 这一条就是“多目标改造不许在 N=1 上
  //     偷偷多跑一遍”的把柄；④ `indexCacheStats()`：100k 行档读一遍只多一条索引且被准入，第二遍
  //     不新增条目，并用**内层数组身份**（命中时 `indexStructure` 返回浅拷贝 ⇒ `tokens` 还是同一批
  //     对象）证明第二遍**没有重建** —— 全是结构量，一个 wall-clock 阈值都没有（本仓被按可用内存
  //     估额度的计时判据咬过两次；这里连唯一与内存有关的那一格也钉死在进程里：`AURA_INDEX_CACHE_MB`）；
  //   · **判定力**（变异实测）：① 回执里多加一个字段（临时改 `read-core.mjs` 的分支）⇒ ①类红并
  //     逐条点名，按字节还原（sha256 前后一致）⇒ 立刻绿；② 把计数 provider 的记账改成“只数一次”
  //     ⇒ ③类红。另有一套**合成变异自证**（段E：对内存里的黄金回执改一个字符 / 多一个字段，
  //     断言比较器必须判红），防的是“比较器被写空而套件照印全绿”；
  //   · **离线自足**：只用仓内夹具 + `os.tmpdir()` 下自建自删的靶场，不起子进程、不读会话日志、
  //     不碰 `~/.aura`（只读一份 install.json 记指纹）、不碰外网；
  //   · 自带通过/失败汇总行与退出码接线（末行 `process.exit(failed === 0 ? 0 : 1)`）。
  ['single-target-nonregression', 'src/locator-lab/single-target-nonregression-test.mjs'],
  // 读侧多目标（mt2）：`readManyWith` 一次读多个目标/区间。收件理由：
  //   · 判据是**不变式**：① 逐项回执与「同一目标单独跑一次」逐字节相同（10 组，含行寻址三写法与 CRLF+BOM 档）；
  //     ② 结果序 = 输入序 —— 用可控延迟假 provider 把完成顺序钉成与输入序相反（30/12/0ms，`onFinish` 记真实完成序），
  //     输出必须仍是输入序；同批倒过来跑一遍双向对账，防「恰好倒序也对」；③ N===1 零池零包装：`trace` 零触发
  //     + 关 BOM 探针后调用序列恰为 `resolve→stat→readText`（连跑 3 次逐项相同）+ 回执与单目标入口逐字节相同；
  //     ④ N>1 只并发 I/O 与纯计算，并发是**结构观测**不是计时（N=12 在飞峰值 = MT_POOL(8)、池宽压 3 时峰值 = 3）；
  //     ⑤ 失败走结果通道（三目标中间那个不存在 ⇒ true,false,true；汇总行只在 `summary`）；
  //     上限/形状错一律抛并报出实得数（`MT_TOO_MANY_TARGETS` 带 got/max）。
  //   · **判定力**（变异实测）：① 改成「按完成顺序装配」⇒ 段B 四条红；② 「N===1 ⇒ 直调」改成永远走池
  //     ⇒ 段C 的 trace 条红（55/56），而同次**红线 26/26 仍绿** —— 后者正是「单目标那条路未被碰」的证据。
  //   · 没有一条计时判据；退出码接线齐全，现读数 56/56。
  ['multi-read', 'src/locator-lab/multi-read-test.mjs'],
  // 写侧多目标（mt3）：`applyEditsToProvider` 一次改多个文件。收件理由：
  //   · 判据是**不变式**：① 逐项 `edits[i].receipt` 就是单目标回执本体（A6 逐字节比对守着）；
  //     ② **三阶段**：全量规划（只读）→ 全部可落才提交 → 写后回读校验；阶段一任一失败 ⇒ `writeText=0`、
  //     汇总行收 `no files were changed` + `aborted:'plan'`（与单调用“任一 hunk 不成立就一个字节不写”同一条纪律）；
  //     阶段二三中途失败 ⇒ 逐项 `landed`/`stage` + `landed_paths`/`not_landed_paths` + `partial:true`；
  //     ③ **同一文件多目标合并成一次提交**（分组键 `ledgerIdentityKey`，D1 断言 `writeText===1` 且两处改动都在）；
  //     ④ 结果序 = 输入序（按完成顺序装配会被段B 点名）；⑤ N===1 直调既有单目标入口，零池零包装。
  //   · **判定力**（变异实测）：① 「规划一个提交一个」⇒ C3/C4 红（`writeText=2`、三个文件逐字节被改）；
  //     ② 「按完成顺序装配」⇒ B1 红（点名 `third,second,first`）；两次都按字节还原 ⇒ 42/42 绿。
  //   · 没有一条计时判据；退出码接线齐全，现读数 42/42。
  ['multi-edit', 'src/locator-lab/multi-edit-test.mjs'],
  // 失败回执的**可修复地址**（mt6）：`PATCH_NOT_FOUND` 在“Closest region + `!N|` 边距行”之后多一段
  //   `retry: {"handle":"h…"}`，`PATCH_AMBIGUOUS`/`needs_choice` 在**每条候选**后各跟一行同样的 retry。
  //   目的：失败之后的**那一次重试不必重抄原文** —— 而“转述错”正是本工具最大的一类失败来源
  //   （残余 147 里 B03 55 + B04 46 都是这一类）。
  //   · 句柄怎么铸：身份标签 = 这一次编辑的 `ledgerKey`（与读侧同一 `ledgerIdentityKey` 口径）；
  //     指纹 = **文件里那几行的原始字节**（未裁剪、未加行号）；行号 = 绝对行号（与 `!N|` 同一把尺子）。
  //   · 体积有上限：候选柄最多 5 条、修法段最多 220 字符（越限整段不印，`next` 照旧）。
  //   · **判定一条没放宽**：码、`writeText=0`、磁盘逐字节不变照旧；另有一条反而**收紧**（从“存在一个
  //     throw 调用点”改成“恰好 1 处”）。
  //   · **判定力（本单最重的一条）**：回环测试 —— 造一个必然 not_found 的编辑 ⇒ 从**正文**（模型唯一
  //     看得见的那一段）解析出 `retry:` ⇒ 配上自己的 `replace` 再发 ⇒ **必须真的落盘且落点就是那段**；
  //     needs_choice 同形（取第 3 个候选的柄 ⇒ 只动那一行）。变异（把铸柄步短路）⇒ 回环必红
  //     （`PATCH_HANDLE_IDENTITY_MISMATCH`、writes=0），按字节还原 ⇒ 绿。
  //   · 退出码接线齐全，现读数 36/36。
  ['repair-address', 'src/locator-lab/repair-address-test.mjs'],
  // 能力面对齐（C71）：修复地址的**第三条面** —— DSH 工具面上模型看得见的那段文本里地址在不在，
  //   并与回执的结构化 `retry.handle` 同源同名。收件理由：① 判的是**渲染后**的 text（引擎里有不算 ——
  //   句柄化落地时就是靠这条发现“结构化字段到不了模型”）；② 变异臂 `--mutation=no-address` 把引擎那条
  //   地址行拿掉 ⇒ R1/R3/R4 按名变红（变异跑在**仓库外的私有副本**上：就地改源文件会让闸里并发跑的
  //   别的套件读到被改过的引擎，实测踩过）；③ 退出码接线齐全，现读数 6/6。
  ['repair-address-shell', 'src/aura-edit/repair-address-shell-test.mjs'],
  // 能力面对齐（C71）：修复地址的**第三条面** —— DSH 工具面上模型看得见的那段文本里地址在不在，
  //   并与回执的结构化 `retry.handle` 同源同名。收件理由：① 判的是**渲染后**的 text（引擎里有不算 ——
  //   句柄化落地时就是靠这条发现"结构化字段到不了模型"）；② 变异臂 `--mutation=no-address` 在**导入前**
  //   把引擎那条地址行拿掉 ⇒ R1/R3/R4 按名变红，按字节还原 ⇒ 回绿（第一版变异落在 import 之后：
  //   ESM 已缓存 ⇒ 空变异 ⇒ 假绿，已修）；③ 退出码接线齐全，现读数 6/6。
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

// ④ 一键安装器
suite('install', 'build/install-test.mjs')

// ⑤ 服务化升级（发布时必须有；过渡期可以 --skip-upgrade）
if (skipUpgrade) {
  // C37：跳过的两件**照样登记进枚举名单**（ranSuites）—— 普查问的是"这两个文件归谁管"，
  // 而不是"这一趟跑没跑"；不登记的话，`--skip-upgrade` 会把两件真套件报成"未登记"的假红。
  ranSuites.push('build/upgrade-test.mjs', 'build/audit-upgrade-probe.mjs')
  rows.push({ group: '升级', name: 'upgrade', status: 'skipped', summary: '(--skip-upgrade)' })
} else {
  suite('upgrade', 'build/upgrade-test.mjs')
  // ⑤b **独立**审计探针（审计方写的，不由实现者提供）：专打 upgrade-test 容易漏的破坏性场景
  //（换名前/后中断、坏包必须被预检挡住、死代理端口下离线升级）。两份都要绿才算这一项过。
  suite('upgrade/审计探针', 'build/audit-upgrade-probe.mjs')
}

// ⑥ src ↔ dist 一致性：包里的每个运行时文件都必须与 src 逐字节相同（本轮吃过它的亏）
{
  const pairs = [
    ['src/aura-read/index.js', 'dist/aura-basetools/aura-read/index.js'],
    ['src/aura-edit/index.js', 'dist/aura-basetools/aura-edit/index.js'],
    ['src/aura-standalone/bin/aura.mjs', 'dist/aura-basetools/bin/aura.mjs'],
    ['src/aura-standalone/bin/aura-mcp.mjs', 'dist/aura-basetools/bin/aura-mcp.mjs'],
    ['src/aura-standalone/lib/ops.mjs', 'dist/aura-basetools/lib/ops.mjs'],
    ['src/aura-standalone/lib/fs-provider.mjs', 'dist/aura-basetools/lib/fs-provider.mjs'],
    ['src/aura-standalone/lib/observation-store.mjs', 'dist/aura-basetools/lib/observation-store.mjs'],
    ['src/aura-standalone/test/standalone-test.mjs', 'dist/aura-basetools/test/standalone-test.mjs'],
    ['build/install.mjs', 'dist/aura-basetools/install.mjs'],
  ]
  // 这个清单必须与 make-bundle 的 `ENGINE` **同一个集合**——
  // 漏一个，那个文件就永远不会被比对（`repo-map.mjs` 就是这样漏了一轮：
  // 它进了包、却在一致性检查之外，即“改了源没重建”对它是瞎的）。
  for (const file of ['read-core', 'locator-api', 'struct-core', 'anchor-core', 'write-path', 'args', 'repo-map']) {
    pairs.push([`src/locator-lab/${file}.mjs`, `dist/aura-basetools/locator-lab/${file}.mjs`])
  }
  const sha = (p) => (fs.existsSync(path.join(root, p)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex') : null)
  const drift = pairs.filter(([a, b]) => sha(a) !== sha(b)).map(([a]) => a)
  rows.push({
    group: '一致性',
    name: 'src↔dist',
    status: drift.length === 0 ? 'ok' : 'fail',
    summary: drift.length === 0 ? `${pairs.length} 个文件逐字节一致` : `不一致：${drift.join(', ')}（改源没重建？）`,
  })
}

// ⑦ 发布清单新鲜度：`dist/manifest.json` 里的 sha256 必须等于旁边那份 .tgz 的真实哈希
//
// 为什么单列一项：清单是**服务化安装的版本发现入口**，而它的判据就是 sha256。
// 清单旧了不会报错，只会让 `--upgrade` 在“校验”一步被拒——那个报错看起来像“包坏了”，
// 不像“清单没跟上重建”。所以拿它跟产物比一次，比完才敢说它能用。
{
  const manifestPath = path.join(root, 'dist', 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    rows.push({ group: '一致性', name: '发布清单', status: 'fail', summary: 'dist/manifest.json 不存在（跑 node build/make-bundle.mjs --pack）' })
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const entry = manifest?.channels?.stable
    const tgzPath = entry === undefined ? null : path.join(root, 'dist', path.basename(String(entry.url)))
    const problems = []
    if (manifest?.tool !== 'aura-basetools') problems.push(`tool=${JSON.stringify(manifest?.tool)}（应为 aura-basetools）`)
    if (entry === undefined) problems.push('没有 channels.stable')
    if (entry !== undefined && !fs.existsSync(tgzPath)) problems.push(`url 指向的包体不在 dist/：${entry.url}`)
    if (entry !== undefined && fs.existsSync(tgzPath)) {
      const real = crypto.createHash('sha256').update(fs.readFileSync(tgzPath)).digest('hex')
      if (real !== entry.sha256) problems.push(`sha256 与 ${path.basename(tgzPath)} 不符（清单 ${String(entry.sha256).slice(0, 12)}… vs 实际 ${real.slice(0, 12)}…）`)
    }
    const version = JSON.parse(fs.readFileSync(path.join(root, 'dist/aura-basetools/package.json'), 'utf8')).version
    if (entry !== undefined && entry.version !== version) problems.push(`清单版本 ${entry.version} ≠ 包版本 ${version}`)
    rows.push({
      group: '一致性',
      name: '发布清单',
      status: problems.length === 0 ? 'ok' : 'fail',
      summary: problems.length === 0 ? `stable ${entry.version}，sha256 与产物一致` : problems.join('；'),
    })
  }
}

// ⑧a 源侧版本位点：这一份清单是**唯一**的，`make-bundle.mjs` 的 `SHELLS` 必须与它同集合。
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

// ⑧ 版本一致性：两个壳的 package.json、包内 package.json、交付物文件名，必须同一个版本
{
  const read = (p) => (fs.existsSync(path.join(root, p)) ? JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')).version : null)
  const versions = {
    'aura-read': read('src/aura-read/package.json'),
    'aura-edit': read('src/aura-edit/package.json'),
    'dist/aura-basetools': read('dist/aura-basetools/package.json'),
  }
  const unique = [...new Set(Object.values(versions))]
  const artifacts = fs.existsSync(path.join(root, 'dist')) ? fs.readdirSync(path.join(root, 'dist')).filter((n) => n.includes(unique[0] ?? '\u0000')) : []
  rows.push({
    group: '一致性',
    name: '版本',
    status: unique.length === 1 && unique[0] !== null ? 'ok' : 'fail',
    summary: `${JSON.stringify(versions)}；同名交付物 ${artifacts.length} 个`,
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
  ['probes/adoption-stats.mjs', '采用率读数器：打印覆盖率与模式分布，唯一的退出码是**用法错**（exit 2）。真正会出错的地方（会话筛选口径 / hunk 级寻址 / 失败判定 / 自测会话过滤）由 adoption-stats-test.mjs 判，那一件已由 C37 登记进 SUITES'],
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
  ['probes/multi-target-adoption.mjs', 'M0 **多目标采用量具**（钉住"装上多目标之后 agent 会不会用它"这组读数）：读会话日志量①每回合调用数②跨文件回合占比③每次调用携带目标数 + 调用构成 + aura_edit vs 内置 edit，并自报样本范围。不是回归线：① 读数挂在**活语料**上（现扫 ~/.dsh/sessions，随日志增长而变）；② 判据全是自洽/口径判据（三个数的分子分母自洽、逐工作区汇总 = 全局、人群口径自检两条），一条绝对条数都没写死；③ `--expect-baseline` 的基线由本量具 `--capture-baseline` 自采，口径（root/工作区集/N/since/until/样本指纹 + 逐文件取样清单）钉在基线里，口径不符印 `⊘` 并**不判**（不假红），口径一致才逐格对账（±20% 一字未动；容差未被收窄由变异证明：+19.0% 绿 / +21.0% 红）。另：`--since=<T>` 一条命令自产前后对照（镜像窗 `--until=T`，同一份取样/计数代码）。判定力：退出码挂钩全部判据（0 绿 / 1 红 / 2 用法错）'],
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
  ['probes/already-applied-census.mjs', 'C45 的**测量线**（残余 147 条里有多少条其实是“这次编辑已经落地了”），不是回归线：① 它的读数（本波 27/144/2 + 编号集）是这一次语料×引擎的快照，只打印、不手抄进判据；② 它判绿的两条里有一条挂在**活状态**上 —— 现场起只读子进程 `failure-replay.mjs --json` 取上游六格读数（columns.treeNew）与已落地编号集做逐格对账，而它自己那份重放已经是 import 上游导出的 `replayNewContract`（C52 起不再自带复刻件；上游那一列一改，它仍会红，而那时要对的是它内嵌的 pin 与记账适配、不是引擎，口径③）；③ 真正该当回归线的那三条不变式（不许误判 / 磁盘不动 / 幂等）已经由 `src/locator-lab/already-applied-test.mjs` 在 SUITES 里逐条钉住，不需要这一件再钉一遍'],
  // MT4 新增：编辑返工量具（本单预注册的问题：agent 调编辑工具要返工几次、错了能不能自己修回来）。
  // 它不是回归线，三条理由都不随波漂：
  //   ① 读数挂在**活语料**上（现扫 ~/.dsh/sessions 里两个真实任务工作区，会话文件还在长）；
  //   ② 判据全是**自洽判据 + 口径判据 + 分层自检**（编辑总数 = 首次 + 返工 / 自我修正率分子 ≤ 分母 /
  //      真落盘 ≤ isError=false ≤ 编辑总数 / 三层桶之和 = 编辑总数 / 逐工作区汇总 = 全局 /
  //      人群口径（默认运行时元会话占比 > 50% ⇒ 红）/ 合成回执四类必须分到四个不同的桶），
  //      **一条绝对条数都没写死** ⇒ 它红了说的是“量具坏了或取样取错了”，不是“引擎回归了”；
  //   ③ 与参考读数（aura_edit 占 20%、平均 1.67 hunk）的对照**只印不判**（语料一变该改的是那份读数）。
  // 判定力：退出码挂钩全部判据（0 绿 / 1 红 / 2 用法错；--selftest 整轮可跑且 exit 0）。
  ['probes/retry-discipline.mjs', '重试纪律读数：读会话日志打印重试分布，无退出码'],
  ['probes/rework-rate.mjs', 'MT4 **编辑返工量具**（钉住“一次就改好”这组读数）：读会话日志量①(会话,回合,文件)三元组的一次成功率②返工次数与有返工的三元组占比③失败后自我修正率④返工是否落到同一文件；两层成功判据（`isError=false` 与“从回执正文分出真落盘”）各占一格，并自报样本范围与时间窗。不是回归线：① 读数挂在**活语料**上（现扫 ~/.dsh/sessions，随日志增长而变）；② 判据全是自洽/口径/分层判据（记账三段闭合、人群口径自检、合成回执四类分四个不同的桶），一条绝对条数都没写死；③ 与参考读数（aura_edit 占 20%、平均 1.67 hunk）的对照只印不判。判定力：退出码挂钩全部判据（0 绿 / 1 红 / 2 用法错）'],
  ['probes/shadow-probe2.mjs', '影子调用计数：读会话日志打印调用计数表，无退出码'],
  ['probes/success-regression.mjs', '成功集回归量具：语料要现扫会话日志（~/.dsh/sessions 下的 zstd 流，600MB 级、几分钟）并随日志增长而变 ⇒ 判据挂在活状态上，不是可复现回归线（本波读数 Z = 0）'],
  // ── build/：C37（另外 3 件 install-test / upgrade-test / audit-upgrade-probe 不在 `SUITES` 那
  //    份字面量里，而是 §④/§⑤ 单独调 `suite()`、照样登记进 `ranSuites`；件数以闸输出「闸内实跑
  //    套件 N 件」那一行为准）──
  ['build/install.mjs', '安装器**产物本体**：§④ install-test.mjs 驱动它、§⑥ 拿它与 dist 那一份逐字节比对。它自己的 checkUpdate( / ✗ / 汇总行是"装完自检"的打印（命中 S1 的是函数名 checkUpdate，不是判据调用），不是回归判据'],
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
  const SKIP_TOP = new Set(['dist', 'fixtures'])
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
  // C37：枚举名单 = `ranSuites`（闸内**真的跑过**的套件文件），而不是 `SUITES` 那一份子集 ——
  // §④/§⑤ 单独调 `suite()` 的三件（install-test / upgrade-test / audit-upgrade-probe）也在里面。
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
