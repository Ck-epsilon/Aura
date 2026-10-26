# aura-basetools —— 项目总览

给 AI coding agent 用的文件读写工具：`aura_basetools_read`（按意图取景：符号目录 / 接口 / 窗口 / 搜索 / 差异）、
`aura_basetools_edit`（按意图寻址：模糊意图 / 符号名 / 行号 / 唯一词 / 记忆原文；逐字节保真、陈旧区域闸门、落盘后回读校验）
与 `aura_basetools_write`（整文件新建/覆写；同一事务与回读校验，保留 BOM 与文件既有行尾）。
**0.7.0 起拆成两个 npm 包**：

- `aura-basetools`：引擎 + CLI + MCP，**不依赖 DSH**；
- `aura-basetools-dsh`：DSH 的 `aura_basetools_read` / `aura_basetools_edit` / `aura_basetools_write` / `aura_basetools_convert` 适配器，依赖 core。

DSH 插件 · MCP 服务（Codex / Claude Code / Cursor）· CLI 三条入口共用同一份引擎。

## 安装（只走 npm）

```bash
npx -y --package aura-basetools aura basetools mcp   # MCP：零安装
npm i -g aura-basetools                              # CLI
dsh plugin --profile web add aura-basetools-dsh      # DSH 插件
```

MCP 客户端只写一段配置（agent 自己就能加）。`aura basetools mcp` 与 `aura-mcp` 是**同一个服务器**：前者是 CLI 子命令，后者是它调用的 bin（`doctor` 报的 `mcp-bin` 是后者路径），升级时两条入口一起变，不需要分别维护：

```json
{"mcpServers":{"aura":{"command":"npx","args":["-y","--package","aura-basetools","aura","basetools","mcp"]}}}
```

**可选：在 provider 侧开 strict——把“工具参数不是合法 JSON”归零**

模型输出的工具参数坏掉时（`MALFORMED_RESPONSE`：`tool input is invalid JSON`），请求在到达工具之前就失败了：
工具看不到那段字节，只能降低概率。能做“归零”的只有 provider 的约束解码：

- **DeepSeek**：`base_url` 用 `https://api.deepseek.com/beta`，每个 function 加 `"strict": true`（服务端会先校验 schema）；
- **OpenAI**：`strict: true`（schema 需全 required + `additionalProperties: false`）。

本包的 schema 可直接转成 strict 变体（全 required + 可选字段写成 `anyOf[类型, null]` + `anyOf` 取代 `oneOf`）：

```js
import { strictToolList } from 'aura-basetools/locator-lab/strict-schema.mjs'
```

`aura basetools doctor` 会把这条 recipe 打出来。代价：每次调用多输出一批 `null` 字段（按 15 天用量估算 ≈ +9M output tokens）。

**安全保证的真实边界（别读成更多）**

- **写入立即可见**：`tx begin` 之后的 `edit/write --tx` 改完就在盘上（`tx status` 仍是 pending）。`tx` 是跨文件**回滚日志**，不是隔离事务；`rollback` 按 afterVersion 恢复。要“改完再验证再提交”，把 `verify` 放在 `tx commit --verify`，并接受 pending 期间外部可见。
- **`edit` 默认不要求先读**：`old`（内容地址）与 `handle`（版本绑定的字节区间）自带校验；`target` 按符号名定位；`lines` / `line_cue` / `anchor` 只按坐标/线索定位——未读过的文件也能写，回执标 `unverified_region: true`。需要强制新鲜度时加 `--require-observation`（MCP `require_observation: true`）。`write` 覆写默认要求先读（`PATCH_UNOBSERVED`）。
- **`full` = up to budget**：默认约 7.5k 字符（`capabilities` 的 `limits.contentBudget`），`budget` 可顶大，但没有“一次给全”的保证。
- **`verify` 只给命令**：在**工作区根目录**执行、无超时参数；MCP 传输上限 30s，慢命令别放进 verify。
- **`probe` 模式（0.21 起）**：`mode=probe` 只回元信息——行数、字节数、行尾风格、编码、语言/文档类型、结构规模（符号或节/键数），**一个正文字节都不发**；用来先判断“值不值得读”。
- **文档结构（0.21 起）**：`map` 对 `.md` / `.json` / `.jsonc` / `.yaml` / `.toml` 也给目录（标题树 / 键路径 + 行号区间），不再回一句 “unsupported extension”；实测 22% 的读取目标是这几类。
- **编码（0.21 起）**：自动探测 UTF-8 / UTF-16LE/BE（BOM）/ GB18030（GBK）/ Shift_JIS / EUC-KR / Big5 / Windows-1252；回执带 `encoding`（非 UTF-8 另带 `encoding_confidence`）。写回沿用读时那次探测的编码，**未改动的行逐字节保留**；不可逆或猜不准时拒绝写（`ENCODING_NOT_ROUNDTRIP_SAFE` / `ENCODING_AMBIGUOUS`），用 `AURA_ENCODING` 显式指定；目标编码表示不了的字符 ⇒ `ENCODING_UNREPRESENTABLE`，零写入。

离线：`npm i -g ./aura-basetools-<版本>.tgz`；回滚：`npm i -g aura-basetools@<旧版本>`。
自定义安装器与交付 zip 已在 0.13.2 移除——稳定路径/升级/客户端注册由 npm 与 agent 自己完成。


**0.14.0 起移除 `intent` 模糊地址**：采用率 census 为 0（642 个真实会话 / 10,974 次 edit），
地址面保留 `target` / `lines` / `line_cue` / `anchor` / `old` / `handle`。
`near` / `expect` / `replace` 仍可与这些地址同用。

**0.8.1 起**，成功编辑的 `applied[]` 还带 `afterLine` / `afterEndLine` / `delta` / `handle`：
下一次编辑直接拿 `handle` 寻址即可，不必先回读；片段层（`old` 命中行内一段）另回填整行 `after`。
`--plan` / `dry_run` 不铸可复用句柄（盘上没写，句柄必过期）。

**0.8.2 起** `auto` 用调用方传入的 `budget`（宿主剪枝阈值）判断全文是否装得下，并在 `auto`
理由里披露预算来源；不传则回落到 8192。显式 `mode=` 不受这个选择影响。

**0.10.0 起** `replace` 的换行默认跟**被替换区域**（CRLF 文件写 CRLF，避免混合行尾）；
要保留输入原样用 `eol: "preserve"`，强制统一用 `"lf"` / `"crlf"`。读取支持内置 `Read` 的
`offset`（0-based）+ `limit`（行数）分页形状，与 `lines` 互斥。

**0.10.1 起新增整文件写**：CLI `aura basetools write --file <路径> --content <文本|@文件>`、
MCP `aura_basetools_write`。新建与覆写都走 `edit` 同一条工作区锁、原子写与落盘回读校验；覆写保留
已有 BOM，并把 content 的换行适配成文件已有风格，**有无尾换行也精确保留**。
`--no-overwrite` 拒绝覆盖，`--dry-run` / `--plan` 只规划。
整份写仍比 `edit` 粗：能改局部就不要整份写。

**0.15.0 起 `edit` / `write` 支持 `--verify "命令"`**（MCP `verify`）：写后执行调用方显式给出的命令；
非零退出或超时 ⇒ 整个事务自动回滚，回执 `PATCH_VERIFY_FAILED` 带命令输出与回滚状态。
不自动发现/执行仓库脚本；命令在 workspace 根下跑，默认 120s 超时。

**0.16.0 起支持跨调用事务**：`tx begin` 拿 id，后续 `edit/write --tx <id>` 写进同一份日志，
`tx commit --id <id> [--verify "命令"]` 提交，`tx rollback --id <id>` 回滚，`tx status --id <id>` 查状态。
MCP 对应 `aura_basetools_tx`（`action`）与 `edit/write` 的 `transaction` 字段。
MCP `initialize` 还带 `instructions`，明确要求优先 `aura_basetools_*`；客户端是否采用由客户端决定。
commit 前会按 afterVersion 检查；外部非重叠改动用三方合并，重叠/不可合并 ⇒ `TX_CONFLICT`，不会静默覆盖。


**0.10.2 起 `old` 可配 `replace_all`**（CLI `--replace-all`、MCP/DSH `replace_all: true`）：
一次替换全部**非重叠**出现（从左到右；`aa` 在 `aaaa` 上得到两处）。不能与
`target` / `lines` / `line_cue` / `anchor` / `context` / `handle` / `near` 同用
（它们都是“收敛到一处”的地址）；读取后出现次数变了 ⇒ `PATCH_STALE_REGION`，
回执的 `occurrence_count` 给出 `{was, now}`。`old` 仍走两档匹配：有逐字命中时只改逐字那些，
没有时才回退空白折叠。

**0.10.3 起有严格新鲜度（read-before-write）**：`aura_basetools_write` 的覆写默认要求**当前这版文件**
在本会话里被读过（或由本工具写过），否则 `PATCH_UNOBSERVED`（`reason: never-read` /
`changed-since-read`）；`--allow-unobserved` 才允许盲写，回执标 `unverified_region`；新建豁免。
`aura_basetools_edit` 用 `--require-observation`（MCP/DSH `require_observation: true`）显式开启，
`dry_run` 也执行同一条判决（预演不撒谎）。普通编辑的默认行为不变：有观测就查区域，
没有观测则放行并如实标 `unverified_region`。

**0.10.4 起整份写的换行可控**：`--eol auto`（默认，套用文件已有风格）/
`preserve`（按 content 原样写，与内置 `Write` 的“给什么写什么”对齐）/ `lf` / `crlf`；
新建文件始终按 content 原样写，显式传非 `auto` 会拒绝（不静默忽略）。

**0.10.5 是独立评审后的缺陷修复版**：>256 KiB 的文件仍记观测令牌（严格闸不再永远
`never-read`）；整份覆写的行区间与规划同源（不再有“先读一次算行数”的 TOCTOU 尾巴），
`--allow-unobserved` 同时越过区域闸；`replace_all` 保留多行 `old` 中间的空行、只替换
exact 命中的那一段、拒绝带首/尾换行的 `old`；`targets` 元素上的 `require_observation`
真正生效；`--content @不存在` 回 JSON 回执；非 UTF-8 覆写点名 `aura_basetools_write`；
`mode` 与 `offset/limit` 同给被拒；`edit --create --dry-run` 不再真的建文件。

**0.10.6 是同一评审的复审后续**：DSH 壳的 `create` 预演、>256 KiB token-only 观测上的
陈旧句柄/基准/降级措辞、多目标 `dry_run` 信封（不再谎报 `created`/`landed`）与同文件合并的
`require_observation`，以及非法元素值的参数面拒绝（不再吐 Node 栈或先建事务）。

**0.12.0 起对外工具标识统一为 `aura_basetools_*`**：MCP / DSH 工具名为
`aura_basetools_read`、`aura_basetools_edit`、`aura_basetools_write`、`aura_basetools_convert`（MCP 面另有 `aura_basetools_tx`）。包名与 bin 名不变。
历史会话日志仍含旧名；分析件同时认旧名与新名。0.14.0 移除了公开
`aura_basetools_undo` / `aura_basetools_transactions`（采用率 0）。

**0.13.0 起 CLI 也进入 `basetools` 命名空间**：统一写成 `aura basetools <verb>`
（`read` / `edit` / `write` / `mcp` / `doctor` / `capabilities`；0.14.0 移除 `undo` / `transactions`）。
顶层旧动词不再作为别名执行，会返回 `CLI_NAMESPACE_REQUIRED` 并提示新写法；
`aura --help` / `aura --version` 仍在顶层。MCP 配置的 args 改为 `["basetools", "mcp"]`。

**0.11.0 起参数面、寻址与回执不再静默**：未知旗标/参数（含 `--dryrun`、`targets` 元素）
一律拒绝且不写盘；压缩代码里共享行的 `target` 与 lone CR 文件上的 `target`/`lines`
分别以 `LOCATOR_LINE_SHARED` / `LOCATOR_LONE_CR` 拒绝；多目标回滚后回执按最终磁盘重建
（`applied:0` / `landed_paths:[]` / `rolled_back:true`）；多目标读与单目标共用
`offset/limit/context/kind/budget/max_chars` 映射；并发读不再覆盖观测缓存；
MCP `initialize` 不再回显不存在的协议版本。CI 增加 Linux Node 22 全量闸与 Node 18/20 冒烟。

## 目录

> 当前版本、公开接口、已知边界与**提交前检查清单**见 `STATUS.md`。

```
src/aura-read/         DSH 工具壳（aura_basetools_read）
src/aura-edit/         DSH 工具壳（aura_basetools_edit）
src/locator-lab/       引擎：框架无关、不许用 node:fs（结构 / 读 / 锚点 / 写路径）
src/aura-standalone/   独立面：CLI + MCP + node:fs 提供方 + 落盘观测缓存 + 自带验收
build/make-bundle.mjs  构建：dist/aura-basetools/（拆包中间产物）；
                       --pack 时派生 dist/npm/ 的两个 npm 包与 capabilities.json
build/bundle-layout.mjs 包内运行时文件的**唯一清单**：打包按它复制，发布闸按它比对 src↔dist
build/make-split-packages.mjs 从组合产物派生 aura-basetools（核心）/ aura-basetools-dsh（DSH 适配器）
build/split-package-test.mjs  拆包的**安装级**验收：离线装两个 tgz，从装出来的那份跑 CLI/MCP/npx，
                              并核对适配器按包名解析核心（入 release-check + CI）
build/range-all.mjs    一条命令跑完三套靶场（格式矩阵 / 字节形态 / 参数形态）并汇总
build/release-check.mjs 发布前的**全量测试闸**：全量套件（单元/集成/验收/冒烟/端到端；件数以闸输出为准）
                       + 三套靶场 + 包内验收 + 拆包安装级验收 + src↔dist 一致性
                       + 发布清单 + 版本一致性 + DSH 就绪（不启动宿主也能查的部分）
dsh/*.yml              DSH 补丁夹具（验证用，非 live）
probes/adoption-stats.mjs  采用率统计（按会话算覆盖率；读 ~/.dsh/sessions，只读）
probes/which-tools.mjs     会话日志里实际用过哪些工具（最近 25 个 + 全量合计）
probes/session-log.mjs     上面几个共用的日志读取（zstd 多帧解压 + 回执正文）
probes/edit-failure-census.mjs  写失败的**构成**：把 16–18% 拆到分类级，再决定修哪一个
probes/weight-profile.mjs  重尾分布与载荷上限（结论带被测文件哈希，只在哈希下有效）
probes/retry-discipline.mjs   同一文件反复修补的检测（真信号：失败后不读又改）
probes/name-addressing.mjs    按名寻址的可达面（重名 25%；失败回执里必须带可用地址）
probes/coordinate-drift-experiment.mjs  T15 分辨实验：失败率 × 此前成功编辑次数 × 地址类型（流式读日志）

src/locator-lab/repo-map.mjs  仓库级粗粒度地图（T26）：`aura_basetools_read <目录>` 的输出形式与判据
probes/probe-*.mjs         模式选择 / 采用率专题分析
probes/shadow-probe*.mjs   shadow 实验数据

docs/测试分层.md         六类测试各问什么、本仓由谁回答、每类的**已知缺口**、以及跑法
docs/agent-guide.md      给调用方的决策表：读模式/地址选择/回执/失败恢复/事务
                        （“哪几类没有”就是“哪几种 bug 看不见”）
docs/aura-客户版-优势说明.md 对外（客户/评估者）版优势说明：收益优先、含交付/回滚/合规/验收清单
docs/aura-vs-内置三件套.md 内部工程版对照说明（字节证据、源码行号、采用数据、复跑命令）
docs/archive/服务化升级设计.md  已废弃：自定义安装器已移除（0.13.2），保留为历史设计记录
docs/待办.md              持久待办：现状/影响/怎么做/前提风险/验收（T1 = 把 DSH 接线钉到已发布产物）
docs/aura-tools-0.*.md     逐版本版本说明（0.2.0 → 0.6.1；0.5.0 = 服务化升级 + 语言表 44→62；
                           0.5.1 = nim/zig；0.5.2 = 新原语 $rest → hrl；0.5.3 = 新守卫 topLevel → hs，
                           21 种目标格式全部登记、语言表 65 种；0.6.0 = 目录即地图 + 地址一致性闸门 +
                           未知参数不再被静默吞掉 + 六类测试分层；0.6.1 = 体检能看见 profile 那一侧的第二份安装；
                           0.6.16 = 独立面（CLI + MCP）也接上 `targets`：一次调用多目标，三个面同一份判据；
                           0.6.17 = 句柄寻址也补到 CLI 与 MCP 的声明面（能力面按可能性给全，不按采样率）)
dist/                  产出（派生物，随时可重建；npm 双包在 dist/npm/）
```

## 构建与验收

```bash
node build/make-bundle.mjs --pack                  # 重建 dist/（组合产物 + dist/npm 双包）
node build/split-package-test.mjs                  # 拆包安装级验收：两个 tgz 装起来真能用
node build/range-all.mjs                           # 三套靶场全跑（持续打用）
node build/release-check.mjs                       # 发布前必跑：全量测试闸（一项不过就不算通过）
node build/task-bench.mjs                          # 任务级基准：8 个读+改任务对照基线（SLO 闸）
node build/post-publish-check.mjs                  # 发布物验证 + dist/release-scorecard.json（--registry 用于发布后）
node build/perf-gate.mjs                           # 性能包线：1k/10k/100k 行冷/热读 + 10k 编辑（绝对上限 + 规模比值）
node build/capabilities.mjs --write                # 能力清单 dist/capabilities.json（make-bundle --pack 会自动跑）
node dist/aura-basetools/test/standalone-test.mjs  # 包内自带验收：测"要发出去的那一份"
```

引擎与工具壳的既有套件在 `src/locator-lab/`（write-verify 42 · stale-gate 95 · byte-fidelity 102 ·
encoding 32 · span 95 · policy-arg 12 · struct 28 · corpus 44 · schema 56 · read 33/59 · lang 21 ·
layers 29 · regex-lex 51）与 `src/aura-{read,edit}/`（load 50/41 · align 12）。

## 开发与测试前提

测试依赖 DSH 0.2.x 的 API 形状（`dsh-agent-preset` 包名、`@deepseek-ai/dsh-hook-protocol` 不再随宿主发布 ⇒ 套件内用钉住的 0.0.1-rc.1 解码器副本，见 `THIRD-PARTY-NOTICES.md`）。


## 写事务（内部回滚，无公开 undo）

0.14.0 移除公开 `undo` / `transactions`（642 个会话中 0 次使用）。事务日志仍是**内部实现**：
每次 `edit` 在第一次写之前把原始字节记到 `~/.aura/transactions/<workspace>/<id>/`，
写成功标记 committed，写失败则按 `afterVersion` 校验后回滚已落地的文件。

```bash
# 不再有 --transaction / undo / transactions；失败回滚仍然自动发生
aura basetools edit --file a.js --lines 10 --replace 'const x = 1'
```

- 多目标写：一个目标写失败，已落地的目标会被事务回滚；回执按**最终磁盘**重建
  （`applied:0` / `landed:false` / `landed_paths:[]` / `rolled_back:true`）。回滚有冲突时标 `recovery_required`。
- 同一工作区的并发编辑由 `~/.aura/locks/<workspace>.lock` 串行化；`AURA_NO_LOCK=1` 可关闭，`AURA_LOCK_TIMEOUT_MS` / `AURA_LOCK_STALE_MS` 可调。
- `AURA_CACHE_DIR` 同时覆盖观测缓存、事务日志和锁目录。

## 写入边界（0.6.19）

- 现有文件的 mode 在原子替换后保留（POSIX）；Windows 的 mode 只承载可写位。ACL / xattr 不在保全范围。
- 符号链接**写穿**到 realpath，链接本身保留；悬空链接拒绝。
- 硬链接（`nlink > 1`）拒绝：rename 会换 inode，静默分叉比拒绝更坏。
- 文本读/写默认上限 512 MiB；可用 `AURA_MAX_FILE_BYTES` 覆盖。`readByteRange` 不受文本上限阻断。
- 版本指纹纳入 ctime；rename 前再校验一次目标版本，缩小 check-then-act 窗口。
- 观测缓存目录 `0700`、文件 `0600`（POSIX）；`AURA_NO_OBSERVATION_CACHE=1` 可完全关闭落盘缓存。
- 临时文件写完后执行 fsync，再 rename；不支持 fsync 的文件系统上退化为尽力而为。

## 错误闭环（0.22）

这一版的重点不是“更多格式”，而是**把错误压缩成一次调用内被看见、一次调用内被改回**。

- **写前预检**（`edit`/`write`，写盘之前）：
  - JSON：改前可解析、改后会不可解析 ⇒ `PATCH_STRUCTURE_BROKEN`，零写入；
  - Markdown：围栏配平 → 不配平 ⇒ 同上；
  - 替换文本引入 lone CR ⇒ `PATCH_LONE_CR`；
  - 未读过的文件一次删掉 ≥30 行且 ≥30% ⇒ `PATCH_DESTRUCTIVE_UNOBSERVED`；
  - 整份替换（`write`）是**显式逃生口**：同样的坏结构只降为 `preflight_warnings`，
    写后回执带 `structure: broken`。
- **漂移重定位** `edit --retry`（MCP/DSH 同名参数）：地址过期时，用上次读到的原文在当前内容里
  整行精确匹配；**全文唯一**才重放，回执带 `rebased: [{from, to}]`；找不到或多处命中仍拒绝。
- **只读体检** `aura basetools diagnose --file <路径>`：编码/置信度/来源、BOM、crlf/lf/cr 普查、
  lone CR、结构是否可解析（JSON / Markdown）、行数。它不做判定，exit 0。
- **零 token 转换** `aura basetools convert --file <路径> --to <编码> [--from] [--bom keep|yes|no]
  [--eol keep|lf|crlf] [--dry-run]`：换编码 / 换行尾 / 增删 BOM，内容不经过模型；
  原子写 + 文本相等校验，目标编码表示不了的字符 ⇒ `ENCODING_UNREPRESENTABLE`，零写入。
- **编码补全**：单字节代码页（cp1250–1258、ISO-8859-2/5/7/9/15、KOI8-R/U）可显式读写；
  无 BOM 的 UTF-16 按 NUL 奇偶位推断端序（纯 CJK 的 UTF-16 仍拒绝：信息上不可判）；
  短 CJK 文件在“猜不准”时用**同目录高置信兄弟**投票（≥5 个样本、≥90% 一致），
  再按逐字节可逆复核；`read` 回执会标 `encoding_source: "directory-prior"`。
- **覆盖集** `read --coverage`（MCP/DSH 同名参数）：回执带 `coverage: {totalLines, covered,
  notCovered}`（区间字符串，如 `"1-9"`）；只有显式请求才出现，既有回执形状不变。

判据在闸里：`preflight-test`（29）、`retry-test`（19）、`coverage-test`（7）、
`encoding-test`（54），以及**错误闭环靶场** `range-error-lifecycle-test`（13 类故障：预检/定位全中、
误拒 0、除两条按设计例外均可一次修复）；只读探针 `probes/error-lifecycle.mjs` 负责打印完整矩阵。

## 结构地址 / 结构句柄 / 双重编码（0.23）

- **改文件不必先落到坐标**：`edit` 接受 `structure`——`symbol:<名字>` / `section:<标题>` /
  `key:<点号路径>`。行号漂移、甚至**整段正文被外部改写**，按结构仍指得到；歧义/找不到直接拒绝。
- **结构句柄**：`read --structure-handle` 在窗口恰好覆盖一个符号时发 `s…:symbol=<name>`，
  与行号句柄同族（身份标签 + 区间指纹），编辑侧按符号重定位。
- **双重编码修复**：`diagnose` 报 `doubleEncoding`；`convert --repair-double-encoding` 还原
  “UTF-8 字节被当 Latin-1/GBK 再存一次”的可逆损坏；`锟斤拷` 这类不可逆的明确拒绝。
- **convert 三面可用**：CLI 全编码；MCP `aura_basetools_convert` 全编码；DSH 同名工具目标只支持
  UTF-8（宿主 fs 只能写 UTF-8 文本），其余目标编码走 CLI。

## 发布

```bash
node build/make-bundle.mjs --pack       # 重建 dist/（含 dist/npm 两个包）
cd dist/npm/aura-basetools && npm publish       # 先 npm login
cd ../aura-basetools-dsh && npm publish
```

可选 `AURA_REPO_URL` / `AURA_AUTHOR` 环境变量决定生成的 `repository` / `author` 字段；不设则不写（也不写假值）。

```bash
node probes/adoption-stats.mjs                     # 唯一入口：覆盖率 + 调用量 + 模式/寻址分布 + 失败率
node probes/adoption-stats.mjs --include-meta      # 把“在测工具本身”的自测会话也合并进来
node probes/adoption-stats.mjs --json              # 机器可读（给别的脚本用）
node probes/adoption-stats-test.mjs                # 判据：统计逻辑的纯函数断言，不需要日志
node probes/which-tools.mjs                        # 逐会话列出用过哪些工具
```

**只有一个统计入口。** 此前有两个（按会话算覆盖率 / 另算一遍模式分布），两边各自筛
“哪些会话算数”且口径不同，同一批日志能读出两个不同的采用率。现在：一次读日志、一份筛选
口径（自测会话单列并可合并）、一份判据测试。

读日志本身在 `probes/session-log.mjs`（多帧 zstd 解压、工具参数解析、`isError` 结构化
失败判定），三个入口共用——避免两处解析漂移。`which-tools.mjs` 的范围不同：它**不筛**
自测会话，因为它回答的是“这个会话碰过哪些工具”，不是“真实采用率”。

自测会话的判据锚在路径分隔符上（`/[\\/](?:aura-tools|locator-lab|aura-read|aura-edit|deepseekharness)(?=[\\/]|$)/`）：
未加锚的子串匹配会把 `agent-browser-bridge` 这类真实项目误判成自测会话。

## 发出去的东西

两个 npm 包（`dist/npm/`）：

- **MCP**：`npx -y --package aura-basetools aura basetools mcp`（零安装；客户端写 `mcpServers` 一段即可）
- **CLI**：`npm i -g aura-basetools`（离线用 `npm i -g ./aura-basetools-<版本>.tgz`）
- **DSH**：`dsh plugin --profile <名字> add aura-basetools-dsh`

卸载：`npm uninstall -g aura-basetools`；DSH 用 `dsh plugin --profile <名字> remove aura-basetools-dsh`。

装完先跑 `aura basetools doctor`（机器读 `--json`）：Node/版本/MCP 握手/缓存与锁目录，任一失败 exit 2。
查本机能力用 `aura basetools capabilities --pretty`（读模式/地址档/语言/限制，全部来自引擎常量）。

npm 官方源发**两个包**（构建在 `dist/npm/`，由 `make-bundle.mjs --pack` 一并产出）：

| 包 | 内容 | 入口 |
|---|---|---|
| `aura-basetools` | 核心：引擎 + CLI + MCP，**无 DSH 依赖** | `aura` / `aura-mcp`；`npx -y --package aura-basetools aura basetools mcp` |
| `aura-basetools-dsh` | DSH 适配器：四个工具壳（`aura_basetools_read` / `aura_basetools_edit` / `aura_basetools_write` / `aura_basetools_convert`）+ patch，依赖同版本核心 | `dsh plugin add aura-basetools-dsh` |

发布顺序：先核心、后适配器。两包都能装上且适配器按包名解析核心，由
`build/split-package-test.mjs` 守着（已入 `release-check` 与 CI）。

## 目录之外的两件事（重要）

1. `E:\workspaces\deepseekharness\aura-read` 与 `aura-edit` 是**目录联接（Junction）**，指向本目录
   `src/` 下的同名目录。原因：两个 profile 的 `cordis.patch.yml` 用**绝对路径**指着它们，而 `web` 是
   自定义 profile → 补丁默认 **live reload**，改路径会当场重载正在跑的会话。留联接 = 一个字节都不碰
   `~/.dsh`，在跑的会话无感。
   想彻底清掉联接（**等 dsh 重启之后**）：把两个补丁里的 `name:` 换成
   `src/aura-{read,edit}/index.js`（仓内相对写法；写进 profile 时补成绝对路径），再删掉那两个联接目录。
2. `locator-lab/` 与 `aura-standalone/` 没有被任何外部绝对路径引用（只被源码相对引用），已直接搬走。

## 搬动须知

`src/` 下四个目录互相是**相对引用**，必须整体搬动，单个搬会断链。DSH 侧的 `@deepseek-ai/dsh-tools` /
`@deepseek-ai/schemastery` 等 peer 依赖靠向上查找 `node_modules` 解析，新位置仍在仓库根之下，照常解析。

本机 Codex 的 MCP 注册指向 `dist/aura-basetools/bin/aura-mcp.mjs`（绝对路径）；重建 dist 不会改变这个路径，但
**再搬项目目录就要同步改注册**：`codex mcp remove aura && codex mcp add aura -- node <新路径>\bin\aura-mcp.mjs`。
