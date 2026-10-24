# aura-basetools@0.19.0 独立测评报告

> 被测物：npm 已发布包 `aura-basetools@0.19.0`（从 https://registry.npmjs.org 安装）。本仓库的 `src/`、`dist/`、任何测试/夹具/黄金集**未被读取，也未参与期望值计算**。

## 摘要

- 用例总数 **163**，通过 **163**，失败 **0**。
- 字节保真：全部通过（12/12）；编辑语义：全部通过（24/24）；读接口：全部通过（10/10）。
- 安全性（陈旧闸 + 多目标原子性 + 跨调用事务）：全部通过（23/23）。
- MCP 面：全部通过（7/7）；随机差分（固定 seed=20261024）：全部通过（80/80）。
- 朴素基线对照：全部通过（7/7）（基线是本测评自己写的朴素实现，不是 DSH 内置工具）。

## 被测物与环境

| 项 | 值 |
|---|---|
| 包 | `aura-basetools@0.19.0` |
| 安装来源 | `npm install --registry=https://registry.npmjs.org`（临时 vendor 目录） |
| 包根目录 | `E:\workspaces\Aura\aura-basetools\eval\independent\.vendor\node_modules\aura-basetools` |
| lockfile resolved | `https://registry.npmjs.org/aura-basetools/-/aura-basetools-0.19.0.tgz` |
| lockfile integrity | `sha512-D77SsJqwVAAsjtwcm5PuCh9h1nn4dC/u99D7TYBytJStsVYWuXfcfxdgcJRh4CxBqn4mtn/Fl6u77qNaMkGoOw==` |
| CLI 入口 sha256 | `2e40ccbf580edb2615469b2876536159f0076169096fb5e191b4c5d9c2725ba3`（`bin/aura.mjs`） |
| Node | `v24.15.0` |
| 平台 | `win32 x64` |
| 运行时依赖 | 无（零依赖，与 README 一致） |
| 运行时间 | 2026-10-24T10:44:28.827Z → 2026-10-24T10:45:37.015Z（68.2s） |
| 工作区隔离 | 每个用例独立 workspace + 独立 `AURA_CACHE_DIR`（观测缓存/锁/事务日志互不串扰） |

## 方法

1. **黑盒入口**：只用发布包的两个公开入口 —— CLI `aura basetools …` 与 MCP stdio（`initialize` / `tools/list` / `tools/call`）。CLI 用 `spawn` 传 argv 数组，不经 shell，避免引号改写输入。
2. **独立 oracle**：期望值全部由本测评自己的 Node `Buffer`/`fs`/字符串操作构造。字节级用例的 oracle 是「自行切分 BOM + 行内容 + 行尾，替换目标行内容后重新拼字节」，与产品实现无关；不拿被测工具的任何回执字段当期望。
3. **逐字节比较**：`Buffer.equals`；不等时给出首个差异偏移与前后 48 字节 hex。
4. **失败即事实**：用例失败不修改产品；记录 id / 目的 / 输入 / 期望 / 实际 / 最小复现 / 回执片段。
5. **随机差分**：自写 mulberry32 PRNG + 固定 seed，随机文本、随机行尾/BOM/尾换行组合、随机单行替换，逐字节比对 oracle。
6. **基线对照**：本测评自己实现「整文件读 → 精确字符串替换 → 整文件写」的朴素基线（**不是** DSH 原生工具，也不代表任何其他客户端），只用来定位 aura 的差异出现在哪。
7. **禁止面**：未读取 `src/**/test*`、`fixtures/`、`build/release-check.mjs`、`dist/` 中的测试/黄金集；未把仓库测试用例当作答案。

## 覆盖矩阵

| 套件 | 覆盖面 | 用例 | 通过 | 失败 |
|---|---|---:|---:|---:|
| `bytes` | 字节保真（BOM / CRLF / 混合行尾 / 无尾换行 / Unicode / 空文件 / BOM-only） | 12 | 12 | 0 |
| `edit` | 编辑语义（lines / line_cue / anchor / target / old / expect / replace_all / dry-run） | 24 | 24 | 0 |
| `stale` | 陈旧安全（读后外部改：区域级拒绝 / 非重叠放行 / 严格新鲜度 / 预演同样判决） | 10 | 10 | 0 |
| `multi` | 多目标原子性（targets：一个规划失败 ⇒ 其他文件零写入；成功时逐项落地） | 6 | 6 | 0 |
| `tx` | 跨调用事务（begin / edit --tx / commit / rollback / verify 失败回滚 / 外部改动合并 / TX_CONFLICT） | 7 | 7 | 0 |
| `read` | 读接口（lines 精确切片 / search / map / digest / changed / offset+limit / 非法 UTF-8） | 10 | 10 | 0 |
| `mcp` | MCP 面（initialize / tools/list / read / edit / tx / 错误封装 / 与 CLI 字节一致） | 7 | 7 | 0 |
| `fuzz` | 随机差分（seed=20261024，80 组随机文本 × 随机单行编辑 × BOM/行尾/尾换行组合） | 80 | 80 | 0 |
| `baseline` | 基线对照（本测评自写的朴素实现；非 DSH 原生工具） | 7 | 7 | 0 |
| **合计** | | **163** | **163** | **0** |

## 失败明细

无。所有用例的独立 oracle 与磁盘字节一致。

## 随机差分

- 固定 seed：**20261024**（mulberry32；报告与 `results.json` 都记录该 seed，重跑同 seed 得到同一批用例）。
- 用例数：80；通过 80，失败 0。
- 生成规则：每例随机行数 3–10、随机 BOM、随机行尾风格（全 LF / 全 CRLF / 混合）、随机有无尾换行；随机选一行做整行替换（`lines` 地址），或向随机行内插入一个**全文件唯一** token 再用 `old` 替换；替换文本可含 CJK/emoji，但不含换行（避免 eol 适配带来的歧义）。
- oracle：自行切分字节 → 替换目标行内容（保留该行原有行尾与 BOM）重新拼字节；`old` 变体用 `Buffer.indexOf` 做唯一子串字节拼接。
- 断言：进程 exit 0、回执 `ok:true`、磁盘字节与 oracle **逐字节相等**；行尾结构不变由字节相等隐式覆盖。

## 基线对照（自己写的朴素实现，非原生工具）

基线标签：**`whole-file readFileSync(utf8)` + 精确字符串替换 + `writeFileSync(utf8)`**（本测评编写；不代表 DSH 内置 `dsh-tool-fs`，也不代表 ZCode/Cursor 等任何客户端）。

| 场景 | 朴素基线结果 | aura 结果 | 是否一致 | 结论 |
|---|---|---|---|---|
| BOM + 单行 token 精确替换 | BOM+"alpha BETA\n" | BOM+"alpha BETA\n" | 一致 | 两者一致：朴素基线在这个写法下不会破坏 BOM，本组不构成 aura 的优势证据 |
| CRLF + 单行 token 精确替换（替换文本无换行） | "one\r\nTWO\r\nthree\r\n" | "one\r\nTWO\r\nthree\r\n" | 一致 | 两者一致：替换文本不含换行时，朴素实现不会改变行尾 |
| 无尾换行 + 末行 token 精确替换 | "a\nB" | "a\nB" | 一致 | 两者一致：纯字符串替换不会增删尾换行 |
| BOM 文件，按行寻址改第 1 行（朴素 split/join） | "FIRST\nsecond\n" | BOM+"FIRST\nsecond\n" | **不一致** | 差异真实存在：朴素按行寻址会把首行的 BOM 当作行内容替换掉 |
| CRLF 文件，按行寻址插入多行（朴素 split/join） | "p1\nP2a\nP2b\np3\n" | "p1\r\nP2a\r\nP2b\r\np3\r\n" | **不一致** | 差异真实存在：split(/\r?\n/)+join("\n") 把整文件行尾统一成 LF |
| 读后外部改同一区域（陈旧安全） | "k1\nK2\nk3\n" | "k1\nk2-EXTERNAL\nk3\n" | **不一致** | 差异真实存在：基线没有陈旧闸，按陈旧文本重写；aura 拒绝且磁盘保持外部版本 |
| 多目标，第二项规划失败（原子性） | "A1\na2\n" | "a1\na2\n" | **不一致** | 差异真实存在：朴素顺序写会留下部分写入；aura 整批零写入 |

基线组用例：7，通过 7，失败 0。这里「通过」指**该用例自身的断言成立**（多数断言是「基线在某方面确实会破坏字节 / aura 不会」），不是「两者一致」。

## MCP 与 CLI 一致性

同一份初始文件、同一处编辑，分别经 MCP `tools/call` 与 CLI 执行，磁盘结果字节比较：**一致**。

- CLI 结果：`ef bb bf 6f 6e 65 0d 0a 54 57 4f 0d 0a 74 68 72 65 65 0d 0a`
- MCP 结果：`ef bb bf 6f 6e 65 0d 0a 54 57 4f 0d 0a 74 68 72 65 65 0d 0a`

## 值得注意的观察（非失败，均为已测行为）

| 观察 | 证据用例 | 对调用方的含义 |
|---|---|---|
| `old` 是**片段地址**：外部改了同一行但片段仍在时，编辑按片段命中继续，不做区域拒绝；回执 `after` 回填整行且标 `unverified_region: true` | `stale/old-fragment-still-matches` | 想按整行语义拒绝陈旧写，请用 `lines` / `handle`，不要用 `old` 片段 |
| `read --mode search` 无命中返回结构化 `READ_NOT_FOUND`（exit 2），不是 `matches: 0` 的 ok 回执 | `read/search-zero-hits` | 不要把 search 的失败当“文件里没有”；要看 `code` |
| 默认编辑允许未读（回执 `unverified_region: true`）；严格新鲜度需显式 `--require-observation`，整份覆写则默认严格 | `stale/no-read-allowed-but-marked`、`stale/require-observation-refused`、`stale/write-overwrite-never-read` | 不读就改会被放行但被标记；要“读后写”保证必须显式开闸 |
| `--eol lf` 只把**替换文本内部**的换行写成 LF，被寻址区域自身的行尾仍原样保留（结果文件可能因此是混合行尾） | `edit/eol-lf-forced` | `--eol` 不是“整文件行尾转换器” |
| `--tx` 的编辑在 `tx commit` 之前就已经落盘；commit 负责校验/三方合并/收口，`tx rollback` 才把字节恢复 | `tx/commit-happy`、`tx/rollback-restores-bytes` | 不要把事务当“延迟写入”；不要用它做未提交预演（用 `--dry-run`） |

## 局限与未验证

以下各项**未验证**，不宣称通过：

- **并发写竞争**：只验证了「单写者 + 外部非重叠/重叠改动 + 三方合并」，没有用两个进程同时写同一文件去压锁；竞态窗口是否为零未测。
- **handle 寻址的完整面**：只覆盖 3 条（整段替换 / 区间内第 k 行 / 句柄失效拒绝）；`position: before|after` 边界插入、跨文件的句柄混用、>256 KiB 文件的句柄未验证。
- **大文件**：未覆盖 >256 KiB 的「仅令牌」观测分支与 512 MiB 文本上限。
- **POSIX 专属行为**：符号链接写穿、硬链接拒绝、文件 mode 保留在 Windows 上无法验证。
- **git 不可用分支**：`tx commit` 的三方合并依赖 `git merge-file`；「Git 不可用 ⇒ TX_CONFLICT」未验证（本机有 Git）。
- **真实 MCP 宿主**：只验证协议帧与工具行为，未接入 Codex/Cursor/DSH 做客户端兼容性验证。
- **编码转换/二进制编辑**：按公开边界不在范围内，仅验证「非法 UTF-8 给结构化拒绝」。

## 最重要的 3 个结论

1. **字节保真可复核地成立**：12/12 条字节用例（BOM、CRLF、混合行尾、无尾换行、CJK/emoji、空文件、BOM-only、`eol auto` / `eol preserve`、整份写）与 80/80 条固定 seed 随机差分，磁盘字节与独立 oracle 逐字节相等。行尾与 BOM 是被测试覆盖的事实，不是回执里的自述。
2. **安全语义是行为而非文档**：陈旧闸（读后外部改被寻址区域 ⇒ 拒绝且磁盘字节不变，改其它位置则正常合并）、多目标「一个失败则零写入」、跨调用事务（commit/rollback/verify 失败回滚/非重叠外部改动三方合并/重叠 `TX_CONFLICT` 零写入）共 23/23 条用例全部按公开承诺表现。
3. **朴素基线的差异是真实且可定位的，但不是「处处更强」**：7 组对照中 4 组出现字节差异；对「整文件读 + 精确字符串替换 + 整文件写」这种朴素做法，BOM/CRLF/无尾换行在**单行 ASCII 替换**下并不会被破坏（Node 的字符串往返本身就保这些字节）——差异出现在按行切分再 `join('\n')`、替换文本含换行、以及缺少陈旧闸/多目标原子性时。MCP 与 CLI 的结果字节一致。因此「aura 更强」的正确表述是：**它在这些破坏性写法上给了结构化的替代路径**，而不是「任何朴素写法都会坏」。

---

复跑：`node eval/independent/run.mjs`（首次会自动从 registry.npmjs.org 安装被测包到 `eval/independent/.vendor`）。机器可读结果见 `results.json`。
