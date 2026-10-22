# aura-basetools —— 项目总览

给 AI coding agent 用的文件读写工具：`aura_read`（按意图取景：符号目录 / 接口 / 窗口 / 搜索 / 差异）与
`aura_edit`（按意图寻址：符号名 / 行号 / 唯一词 / 记忆原文；逐字节保真、陈旧区域闸门、落盘后回读校验）。
**一个包，四条路进**：DSH 插件 · MCP 服务（Codex / Claude Code / Cursor）· CLI · 一键安装器。

## 目录

```
src/aura-read/         DSH 工具壳（aura_read）
src/aura-edit/         DSH 工具壳（aura_edit）
src/locator-lab/       引擎：框架无关、不许用 node:fs（结构 / 读 / 锚点 / 写路径）
src/aura-standalone/   独立面：CLI + MCP + node:fs 提供方 + 落盘观测缓存 + 自带验收
build/make-bundle.mjs  打包：dist/aura-basetools/ + .tgz + 交付包 zip + 一页说明
build/install.mjs      一键安装器（双击 / agent 一条命令；幂等、可卸载、装完真自检）
build/install-test.mjs 安装器的机械验收（假 HOME 里真装真卸真卸载，52 项）
build/zip.mjs          自带模式位的 ZIP 写入器（macOS 双击 .command 要 0755，系统压缩工具不写）
build/range-all.mjs    一条命令跑完三套靶场（格式矩阵 / 字节形态 / 参数形态）并汇总
build/release-check.mjs 发布前的**全量测试闸**：34 套（单元/集成/验收/冒烟/端到端）+ 三套靶场
                       + 包内验收 + 安装器 + 服务化升级 + src↔dist 一致性 + 发布清单 + 版本一致性
                       + DSH 就绪（不启动宿主也能查的部分）
dsh/*.yml              DSH 补丁夹具（验证用，非 live）
probes/adoption-stats.mjs  采用率统计（按会话算覆盖率；读 ~/.dsh/sessions，只读）
probes/which-tools.mjs     会话日志里实际用过哪些工具（最近 25 个 + 全量合计）
probes/session-log.mjs     上面几个共用的日志读取（zstd 多帧解压 + 回执正文）
probes/edit-failure-census.mjs  写失败的**构成**：把 16–18% 拆到分类级，再决定修哪一个
probes/weight-profile.mjs  重尾分布与载荷上限（结论带被测文件哈希，只在哈希下有效）
probes/retry-discipline.mjs   同一文件反复修补的检测（真信号：失败后不读又改）
probes/name-addressing.mjs    按名寻址的可达面（重名 25%；失败回执里必须带可用地址）

src/locator-lab/repo-map.mjs  仓库级粗粒度地图（T26）：`aura_read <目录>` 的输出形式与判据
probes/probe-*.mjs         模式选择 / 采用率专题分析
probes/shadow-probe*.mjs   shadow 实验数据

docs/测试分层.md         六类测试各问什么、本仓由谁回答、每类的**已知缺口**、以及跑法
                        （“哪几类没有”就是“哪几种 bug 看不见”）
docs/aura-客户版-优势说明.md 对外（客户/评估者）版优势说明：收益优先、含交付/回滚/合规/验收清单
                            构建时会以 aura-basetools-<版本>-优势说明.md 的名义放进交付包
docs/aura-vs-内置三件套.md 内部工程版对照说明（字节证据、源码行号、采用数据、复跑命令）
docs/服务化升级设计.md      从“一键安装”到“可升级”：方案对比、稳定路径 + 原子交换 + 自动回滚、
                           --version/--doctor/--upgrade/--rollback 接口、失败矩阵、升级验收标准
docs/待办.md              持久待办：现状/影响/怎么做/前提风险/验收（T1 = 把 DSH 接线钉到已发布产物）
docs/aura-tools-0.*.md     逐版本版本说明（0.2.0 → 0.6.1；0.5.0 = 服务化升级 + 语言表 44→62；
                           0.5.1 = nim/zig；0.5.2 = 新原语 $rest → hrl；0.5.3 = 新守卫 topLevel → hs，
                           21 种目标格式全部登记、语言表 65 种；0.6.0 = 目录即地图 + 地址一致性闸门 +
                           未知参数不再被静默吞掉 + 六类测试分层；0.6.1 = 体检能看见 profile 那一侧的第二份安装；
                           0.6.16 = 独立面（CLI + MCP）也接上 `targets`：一次调用多目标，三个面同一份判据；
                           0.6.17 = 句柄寻址也补到 CLI 与 MCP 的声明面（能力面按可能性给全，不按采样率）)
dist/                  产出（派生物，随时可重建）
```

## 构建与验收

```bash
node build/make-bundle.mjs --pack                  # 重建 dist/（含交付包 zip）
node build/install-test.mjs                        # 安装器验收（含 --version / --doctor）：52/52 才算过
node build/range-all.mjs                           # 三套靶场全跑（持续打用）
node build/release-check.mjs                       # 发布前必跑：全量测试闸（一项不过就不算通过）
node build/upgrade-test.mjs                        # 服务化升级验收（升级/回滚/断电安全）
node dist/aura-basetools/test/standalone-test.mjs  # 包内自带验收：测"要发出去的那一份"
```

引擎与工具壳的既有套件在 `src/locator-lab/`（write-verify 42 · stale-gate 95 · byte-fidelity 102 ·
encoding 32 · span 95 · policy-arg 12 · struct 28 · corpus 44 · schema 56 · read 33/59 · lang 21 ·
layers 29 · regex-lex 51）与 `src/aura-{read,edit}/`（load 50/41 · align 12）。

## 开发与测试前提

测试依赖 DSH 0.2.x 的 API 形状（`dsh-agent-preset` 包名、`@deepseek-ai/dsh-hook-protocol` 不再随宿主发布 ⇒ 套件内用钉住的 0.0.1-rc.1 解码器副本，见 `THIRD-PARTY-NOTICES.md`）。


## 写事务（journal / undo）

每次 `edit` 在第一次写之前把原始字节记到 `~/.aura/transactions/<workspace>/<id>/`；写成功后标记 committed，写失败则按 `afterVersion` 校验后回滚已落地的文件。

```bash
aura edit --file a.js --lines 10 --replace 'const x = 1' --transaction
aura edit --targets '[{"file_path":"a.js","hunks":[...]},{"file_path":"b.js","hunks":[...]}]' --transaction
aura transactions
aura undo                      # 最近一次 committed
aura undo --id <id>            # 指定事务
aura undo --id <id> --force    # 文件在事务后又被改过也强制恢复
```

- 默认 `edit` **不把 transaction id 放进回执**（保持 CLI/MCP 输出稳定）；需要 id 时加 `--transaction`（MCP 用 `include_transaction: true`）。
- 多目标写：一个目标写失败，已落地的目标会被回滚；回执里带 `transaction` 与 `rollback`。
- undo 默认拒绝覆盖“事务后又被外部改过”的文件（`TRANSACTION_STALE`）；`--force` 才强制。
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

## 发布

```bash
node build/make-bundle.mjs --pack       # 重建 dist/aura-basetools/ 并打 .tgz
cd dist/aura-basetools && npm publish   # 先 npm login
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

`dist/aura-basetools-<版本>-交付包.zip`。收件人解压后：

- **人**：双击 `一键安装.cmd`（Windows）/ `一键安装.command`（macOS）
- **agent**：`node aura-basetools/install.mjs --yes --json`
- **手工**：`npm i -g ./aura-basetools-<版本>.tgz && codex mcp add aura -- aura mcp`
- **DSH**：`dsh plugin --profile <名字> add ./aura-basetools-<版本>.tgz`

撤销：`node aura-basetools/install.mjs --uninstall`。

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
