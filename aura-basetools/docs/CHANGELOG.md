# aura-tools 版本变更表（0.6.2 → 0.13.0）

> **这份表是补记的**：`docs/aura-tools-<版本>.md` 只覆盖到 0.6.1，然后直接跳到 0.6.16/0.6.17；
> 中间的 0.6.2–0.6.15 与 0.6.18 当时只写在交接单与工作单里。C72 收口审计把这 15 个版本的**一句话变更 + 读数**
> 补到这里，尽量给可复核的来源。
>
> - 详细施工记录：`.polaris/读写工具重做-交接单.md`（§三 波1–19、§八 句柄化、§九 多目标、§十 判定内联、§十二 回执准确化）
> - 逐件工作单与回执：`.polaris/workorders/fs-contract-v2.*.json`
> - **口径提醒**：本表里的数字都是**当时实测**；要看当前读数请跑对应探针（交接单 §四 有命令表）。

## 0.13.2（未发布）：安装只走 npm，移除自定义安装器

- **安装面只剩 npm**：MCP 用 `npx -y --package aura-basetools aura basetools mcp`，CLI 用
  `npm i -g aura-basetools`，DSH 用 `dsh plugin --profile <名字> add aura-basetools-dsh`。
- **移除 `install.mjs`、双击壳（`一键安装.cmd` / `.command`）、交付 zip、自定义 manifest、
  升级/回滚命令**：稳定路径、渠道与回滚由 npm 的全局路径、dist-tag 与 `@版本` 完成；
  离线用 `npm i -g ./aura-basetools-<版本>.tgz`。
- README、客户版说明、STATUS 同步；`npx ... aura mcp` 的旧指引修正为 `aura basetools mcp`。

## 0.13.1：`target` 行区间不再越过声明边界

- `target` 的行区间判据从“同作用域兄弟符号”收紧到**声明字节边界**：行内 `import`、尾随调用、嵌套声明、C 家族多行声明头不再被整行替换静默吃掉。
- 共享行拒绝时回执带 `LOCATOR_LINE_SHARED` 与 `shared:{line,side,text}` 证据。
- 多行声明从声明起点替换；Lisp 的 `(ns alpha.core)` 不再把下一 form 的 `(` 当体。
- `single-line-target` 28/28、`lang-coverage` 235/235；全量闸 exit 0。

## 0.13.0：CLI 子命令也进入 `basetools` 命名空间

- CLI 调用统一为 **`aura basetools <verb>`**：`read` / `edit` / `write` / `undo` /
  `transactions` / `mcp` / `doctor` / `capabilities` 全部在 `basetools` 命名空间下。
- 顶层旧动词**不再作为别名执行**：`aura read` 返回 exit 1、`shape:CLI_NAMESPACE_REQUIRED`，
  并提示 `aura basetools read`；不会偷偷改文件。`aura --help` / `aura --version` 仍在顶层。
- MCP 客户端配置改为 `args: ["basetools", "mcp"]`；npx 形式为
  `npx -y --package aura-basetools aura basetools mcp`。
- `capabilities.commands` 改成 `basetools read` 等命名空间写法；安装自检、split/upgrade/
  post-publish、CLI/MCP 端到端与全部 CLI 夹具同步。
- 0.12.0 的“CLI 子命令仍是 `aura read`”只描述当时状态；0.13.0 起以本节为准。
- 全量闸通过：`standalone 227/0`、`range-bytes 218/218`、`write 66/66`、
  `argument-surface 17/17`、`observation-concurrency 9/9`、`public-surface 41/41`、
  `split-package 75/75`、`upgrade 94/94`。

## 0.12.0：对外工具标识统一为 `aura_basetools_*`

- MCP / DSH 工具名、`capabilities` 清单、提示词与安装自检全部改为：
  - `aura_read` → **`aura_basetools_read`**
  - `aura_edit` → **`aura_basetools_edit`**
  - `aura_write` → **`aura_basetools_write`**
  - `aura_undo` → **`aura_basetools_undo`**
  - `aura_transactions` → **`aura_basetools_transactions`**
- CLI 子命令仍是 `aura read / edit / write / undo / transactions`；包名、bin 名与源码目录
  （`aura-read/`、`aura-edit/`、`aura-standalone/`）不变。
- 历史会话日志与 `failure-corpus.json` 保留旧工具名；`failure-replay` 等分析件同时认
  `aura_read` / `aura_basetools_read` 与 `aura_edit` / `aura_basetools_edit`，避免重命名把
  353 条历史条目误判成“读路径”。
- 旧版本 CHANGELOG 与 `docs/aura-tools-0.*.md` 中的旧名是历史记录，未改写。
- 回归：`standalone 228/0`、`real-framework 29/29`、`install/split-package/upgrade`
  全量闸通过；MCP/DSH 工具名断言与安装自检都按新名。

## 0.11.0：参数面 / 寻址 / 回执的静默语义修复

按“先复现、再拒绝而非降级、回执等于最终磁盘状态、三面同一判据”修复：

- **P0 未知参数**：CLI 顶层未知旗标（`--dryrun`）⇒ `USAGE` + `shape:ARGS_UNKNOWN_KEY`、
  exit 1、磁盘不变；MCP 顶层与 `targets` 元素未知键 ⇒ `ok:false / ARGS_UNKNOWN_KEY / isError`。
  MCP 的合法键从 `inputSchema` 派生；CLI/DSH 的 `targets` 元素用 `args.mjs` 同一份
  `MT_READ_ELEMENT_KEYS` / `MT_EDIT_ELEMENT_KEYS`。合法的 `--dry-run` / `dry_run` 行为不变。
- **P0 共享行 / lone CR**：压缩 JS 里 `target=alpha` 落在还有 `beta` 的同一行 ⇒
  `LOCATOR_LINE_SHARED`（带同行候选）；lone CR 文件上的 `target` / `lines` ⇒
  `LOCATOR_LONE_CR`。两者都不再静默替换整行/整文件；`old` 片段仍可安全修改，
  显式整文件写（`aura_write`）是 lone CR 的出口。DSH 判决表把前者映射为 `needs_choice`、
  后者为 `not_found`（正常结果，不是工具故障）。
- **P0 多目标回滚回执**：事务回滚后按最终磁盘重建：`applied:0`、`landed:false`、
  `landed_paths:[]`、`unchanged:true`、`rolled_back:true`；`rollback` 字段不再依赖
  `include_transaction`。回滚有冲突时标 `recovery_required`，不谎称已恢复。
- **P1 多目标读字段**：抽出 `normalizeReadRequest`，单目标与 `targets` 元素共用；
  `offset/limit/context/kind/budget/max_chars` 不再被多目标静默丢掉。DSH 单目标也补上
  分页与 `max_chars/budget`。单目标与多目标逐字节对拍从 10 条扩到 15 条。
- **P1 观测缓存并发**：磁盘观测改为 `observations.json.lock` 下的 read-merge-write，
  查询前按 mtime 刷新；两个/六个并发 `aura read` 不再互相覆盖，随后严格编辑均可成功。
- **P1 MCP 协议版本**：`initialize` 不再原样回显任意字符串。受支持版本（2025-06-18 /
  2025-03-26 / 2024-11-05）原样返回；不支持的字符串返回最新受支持版本并附
  `supportedProtocolVersions`；非字符串 ⇒ `-32602`。
- **CI / 闸门**：新增 Linux + Node 22 完整 `release-check` job（安装公开宿主 peer），
  Node 18/20 的 CLI + MCP 冒烟；`release-check` 把 `0/0 通过（已跳过）` 记 `⏭` 而不是 ✅，
  `CRITICAL_SUITES` 跳过会让闸红。
- 新套件：`argument-surface` 17 项、`single-line-target` 12 项、
  `observation-concurrency` 9 项、`ci-contract` 16 项；`standalone` 227/0、`range-bytes` 218/0、
  `byte-fidelity` 102/102、`multi-read` 64/64。

## 0.10.7：DSH 适配器暴露 `aura_write`

- `aura-edit` 插件现在同时注册 **`aura_write`**（与 `aura_edit` 同一个插件、同一套 `ctx.fs`
  契约）：新建或整份覆写；BOM 与文件既有行尾保留；覆写默认要求当前版本在会话内被读过
  （`PATCH_UNOBSERVED`），`allow_unobserved` 是显式盲写逃生口；`dry_run` 不写盘；
  `no_overwrite` 拒绝已存在文件；`eol: auto|preserve|lf|crlf`。
- DSH 面没有事务/undo/工作区锁（与 `aura_edit` 一致）；能力清单的 `aura_write.writeSafety.dsh`
  只宣称 `stale-region-gate` / `observation-gate` / `byte-verify`。
- 提示段改为：局部改动用 `aura_edit`，整份新建/覆写用 `aura_write`（不再把内置 `write`
  当唯一整份写路径）；读图仍只有 `read_image`。
- 测试：`aura-edit/load` 74/74（新建/覆写/严格拒绝/盲写/`eol`/`no_overwrite`/未知参数），
  `real-framework-smoke` 29/29（三工具的 schema 与真实输出校验全部通过）。

## 0.10.6：复审后续（DSH 预演 + token-only 观测）

0.10.5 的修复经同一评审代理复审，发现并修复：

- **P1 大文件上的陈旧句柄变成 TypeError**：token-only 观测的 `source` 是 `null`，
  `resolveHandleRegion` 直接 `.split`。现在与“没有观测”同一条出路：`PATCH_HANDLE_STALE`。
- **P1 多目标 create 预演谎报已创建**：`receiptKindOf` 先看 `operation === 'create'` 再看
  `dryRun`，于是 `dry_run` 的 create 被算成 `created`、`landed:true`，顶层还进了
  `landed_paths`。现在预演优先；多目标信封顶层也给 `dryRun`，汇总行写
  `dry_run 1 ｜ no files were changed`。
- **P2 DSH 壳的 `create` 路径不看 `dry_run`**：0.10.5 只修了引擎的创建规划，DSH 在
  `info === undefined` 时直接 `writeText`。现在预演在写入前返回
  `operation:"create", dryRun:true` 的同形回执。
- **P2 同文件合并丢掉元素级 `require_observation`**：`groupRequest` 只转发
  `create/identityKey/dryRun`。现在任一成员要求严格 ⇒ 整组严格（安全方向）。
- **P2 非法元素值在 dry-run 下吐 Node 栈、非 dry-run 还先建事务**：类型校验前移到
  `assertEditTargets`（参数面），CLI 得到一行 `USAGE` JSON / exit 1，MCP 得到 `BAD_ARGS`。
- **P2 token-only 观测的 basis 只认最新版本**：当前内容等于“更早读过的某一版”不再冒充
  `observation`；回退场景标 `unverified_region`。
- **P2 `changed` / 增量降级措辞**：>256 KiB 是“按设计不保留全文”（重读也不会改变），
  不再说成“缓存淘汰”；两种原因分开说明。
- 预演回执在无观测基准时也带 `unverified_region`（与真写同一句诚实标注）。
- 测试：`write-test` 66 项（多目标预演信封、盲写预演标注）、`observation-gate-test` 32 项
  （同文件合并、非法元素、大文件陈旧句柄、回退基准、changed 措辞）、`aura-edit/load` 60/60。

## 0.10.5：独立评审 + 缺陷修复

独立评审（只读，未参与 0.10.1–0.10.4 实现）发现并修复：

- **P1 严格闸对 >256 KiB 文件永远无法满足**：磁盘观测存储超过 `MAX_SOURCE` 时整条丢掉，
  于是 `requireObservedRevision` 永远 `never-read`。现在仍记**令牌**（不存全文）；
  `regionGate` 拿不到全文时如实退回 `basis:'none'`，但“这一版读过没有”仍可回答。
- **P2 `replace_all` 多行 `old` 丢空行**：`a\n\nb` 的 `actual` 曾被拼成 `a\nb`，`expect` 随之误拒。
  中间行逐个拼回，不再过滤空串。
- **P2 exact 片段多吞尾随空白**：`old:"ax "` 在 `x ax  y` 上曾替换 `ax  `。片段层现在只替换
  命中跨度本身，不再扩展“与末字相同的后续字符”。
- **P2 `replace_all` + `old` 尾换行退化成全文子串搜索**：`old:"a\n"` 会在 `banana` 里命中。
  这种形状现在直接拒绝（`PATCH_REPLACE_ALL_CONFLICT`），提示去掉换行后重试。
- **P2 整份覆写 TOCTOU**：旧实现先读一次算总行数、规划时再读一次；两次之间文件变长会只替换
  前缀、留下旧尾巴（`allow_unobserved` 下可复现）。现在区间在规划那一次读到的内容上现算。
- **P2 `--allow-unobserved` 被区域闸挡住**：读过旧版后文件又变，逃生口只关了严格闸，
  区域闸仍拒绝。现在 `skipStaleGate` 只与整份覆写同用，显式盲写照实标 `unverified_region`。
- **P2 `targets` 元素的 `require_observation` 被静默丢掉**：参数面收下、引擎前消失。
  `editTargetRequests` 现在转发（元素显式值压过顶层默认；非布尔拒绝）。
- **P2 `--content @不存在` 抛 Node 栈**：改为与其他 `@文件` 参数一致的 `USAGE` JSON 回执
  （`--create @不存在` 同修）。
- **P2 非 UTF-8 覆写返回原始解码错误**：现在复用 `read/edit` 的可执行拒绝，并点名 `aura_write`。
- **P2 `mode` + `offset/limit` 静默换成 `lines`**：显式取景与分页互斥，直接拒绝
  （`mode:"auto"` 除外）。
- **P1（评审顺带发现，0.10.0 前就存在）`edit --create --dry-run` 真的建文件**：规划返回
  `dryRun:false` 且写盘阶段不看预演旗标。现在预演不写、回执 `operation:"create", dryRun:true`。
- 回归：`write-test` 60 项、`replace-all-test` 36 项、`observation-gate-test` 25 项、
  `standalone` 221/0；新增 >256 KiB 严格闸、targets 元素、TOCTOU 单读、create 预演等断言。

## 0.10.4：整份写的换行策略

- `aura_write` 新增 `eol`（CLI `--eol`，MCP `eol`）：`auto`（默认，套用文件已有风格）/
  `preserve`（按 content 原样写，与内置 `Write` 对齐）/ `lf` / `crlf`。
- 新建文件始终按 content 原样写；显式传非 `auto` 的 eol 会以 `WRITE_BAD_ARGS` 拒绝
  （不做静默忽略）。BOM 在覆写时仍保留。
- DSH 提示段补上 `old` 与 `replace_all` 的用法（此前只说了 target/lines/line_cue/anchor）。
- `observation-gate-test` 补一条：`map` / `digest` 读也算观测，不必整份读。
- `write-test` 扩到 51 项（新增 preserve/lf/crlf/非法值/新建非 auto/MCP schema）。

## 0.10.3：严格新鲜度（read-before-write）

- 引擎新增 `requireObservedRevision`：要求**当前这版内容**在本会话被读过（或由本工具写过）；
  否则抛 `PATCH_UNOBSERVED`，`reason` 区分 `never-read` / `changed-since-read`。
- `aura_write` 的**覆写默认开启**这条闸（与内置 `Write` 的 read-before-write 对齐）；
  新建豁免；`--allow-unobserved` / MCP `allow_unobserved` 是显式逃生口，回执照实标
  `unverified_region`。
- `aura_edit` 用 `--require-observation`（MCP/DSH `require_observation: true`）显式开启；
  多目标顶层转发到每一项，任一项未读 ⇒ 整批零写入；**dry-run 执行同一条判决**。
  默认编辑行为不变：有观测就查区域，无观测放行并标 `unverified_region`。
- 写成功后这版内容即进观测账本 ⇒ 连续编辑不必重新读。
- 能力清单：`aura_edit.options` 增加 `require_observation`；`aura_write.writeSafety` 增加
  `observation-gate`（CLI/MCP）。
- 新套件 `observation-gate-test`（22 项：CLI/MCP/引擎）入闸；`write-test` 扩到 44 项
  （新增从未读/已变更/blind dry-run/逃生口/回执标注）。

## 0.10.2：`replace_all` 批量替换

- `aura_edit` 的 hunk 新增 `replace_all: true`（CLI `--replace-all`，MCP/DSH schema 同步）：
  与 `old` 同用，替换**全部非重叠出现**（从左到右；`old:"aa"` 在 `aaaa` 上得到两处）。
  回执 `applied[]` 逐处给 `line` / `afterLine` / `delta` / 新句柄。
- 参数面互斥：`replace_all` 不能与 `target` / `intent` / `lines` / `line_cue` / `anchor` /
  `context` / `handle` / `near` 同用（`PATCH_REPLACE_ALL_CONFLICT`）；缺 `old` 或非布尔值同样拒绝。
- 陈旧闸门：读取后**出现次数变了** ⇒ `PATCH_STALE_REGION`，`occurrence_count {was, now}` 说明
  前后各几处；次数没变、只改无关行 ⇒ 放行（内容地址吸收位移，仍如实标 `unverified_region`）。
- 匹配层序：`replace_all` **优先片段层**（同一段文字在行内出现时不会被整行层漏掉）；
  逐字命中存在时只改逐字那些，一处都没有才回退空白折叠。
- **引擎修复（顺带）**：片段末列计算曾无条件吞掉“与末字相同的后续字符”，
  `old:"a"` 在 `aa` 上会被当成一整段 `aa`。现在只有末字是空白时才扩展同一段空白。
- `FLAT_ADDRESS_KEYS` 吸收 `old`（平铺 CLI 从此可直接 `--old <原文>`）；能力清单新增
  `options: ["replace_all"]`。
- 新套件 `replace-all-test`（33 项：引擎/CLI/MCP/陈旧闸门）入闸；`aura-edit/load` 57/57、
  `arg-shape` 33/33、`capabilities` 23/23。

## 0.10.1：整文件写（对齐内置 `Write`）

- 新增 CLI `aura write --file <路径> --content <文本|@文件>` 与 MCP `aura_write`（`file_path` + `content`）：
  新建或整份覆写；与 `edit` 共用工作区锁、事务日志、落盘回读校验。
- 覆写保留已有 BOM，并把 content 的换行适配成文件已有风格；content 的**有无尾换行精确保留**
  （原文件带尾换行 + content 不带 ⇒ 结果不带；反向亦然）。
- 旗标：`--no-overwrite`（已存在 ⇒ `WRITE_EXISTS`）、`--dry-run` / `--plan`（不建事务、不落盘）、
  `--transaction`（可 `aura undo`；撤销“新建”会删除文件）。
- 回执是紧凑形状（`operation: create|write`、`bytes`、`write_verify`、可选 `transaction`），
  不把整份 old/new 文本塞进 `applied`。覆写预演不报 `bytes`（行尾适配后长度未知，不谎报）。
- MCP 工具数 4 → 5；`capabilities` 的命令表与工具表都包含 `write`；`split-package-test` 装机后同样核对五个工具。
- 新套件 `write-test`（36 项：新建/覆写/BOM+CRLF/尾换行/dry-run/no-overwrite/undo/@file/MCP/能力清单）入闸。

## 0.10.0：对齐内置编辑工具的换行与分页

- `replace` 新增 `eol: auto|preserve|lf|crlf`，默认 **auto**：新行适配被替换区域的行尾
  （CRLF 文件写 CRLF，避免混合行尾）；`preserve` 保留旧的逐字节口径；`lf`/`crlf` 强制统一。
  只作用于替换文本，未触及行与 BOM 不动；回执用 `eolAdapted: true` 披露改写过。
- 读取新增 `offset`（0-based 行偏移）+ `limit`（行数，默认 2000），与 `lines` 互斥；
  补齐内置 `Read` 的分页形状，不越过宿主预算。
- 旧 `byte-fidelity` 段 C 改为显式 `eol: preserve`；新套件 `eol-adapt-test`（15 项）入闸；
  `standalone` 218/0、`aura-edit/load` 57/57、`read` 36/36、`schema` 87/87。
- **行为变更**：默认不再“replace 写什么行尾就落什么行尾”；需要旧口径时显式 `eol: preserve`。

## 0.9.10：独立评审 + 缺陷修复

独立评审（只读，未参与实现）发现并修复：

- **P0 跨行 `old` 片段吞掉末行后缀**：拼接层用首行的 `tail`，`old:"START\nEND"` 会把末行
  `END bb` 的 ` bb` 丢掉，回执还写“只换了列 4-11”。现在用 `fragment.endLineCol` 从**末行**取后缀；
  同时修掉 `old-fragment-fallback` 里把错误输出写成期望的那条断言。
- **P1 无尾换行文件末尾 `position:'after'` 粘连**：`a\nb\nc` 插入 `d` 得到 `a\nb\ncd`；
  现在补分隔行尾、不凭空加尾换行；回执 afterLine/句柄指向真正的新行。
- **P1 `intent` + `near` 用起点距离选错同名符号**：改为“不带 near 解析 → 歧义候选按**跨度包含**
  收敛”，同名长函数 + near 在体内时选对第一个。
- **P1 歧义回执的 `target=name#n` 地址多数不可解析**：`#n` 改为**同名序号**（唯一名字不带 `#`），
  并修掉候选文本里的 `function in null`。
- **P1 `auto` 假称全文完整**：`full` 判据改用**渲染后长度**（含行号前缀）与 `omitted`；
  `suggestMode` 的探针加 `probe:true`，不再写观测账本/触发增量，外层 auto 不会拿到 56 字符的
  “no change”短回执；极小预算不再选渲染 0 字符的空 full。
- **P1 行内 `old` 替换以换行结尾时 afterLine/delta/句柄少算一行**：按 `replace` 末尾换行把后缀
  顶到下一行，句柄覆盖完整新区域。
- **P1 `--dry-run --transaction` 提交空事务遮蔽 undo**：预演不建事务、不写盘；预演回执也不铸
  可复用句柄（盘上没写，句柄必过期）。
- **P2 平铺 CLI `--replace ""` 无法删除**：`flatHunk` 只对 `replace` 放行空串。
- **P2 失败回执带不完整 metrics**：metrics 只对成功信封作承诺。
- **P2 能力面不一致**：构建清单补 `capabilities` 命令；`writeSafety` 按 CLI/MCP/DSH 分入口
  （DSH 不宣称事务/undo/锁）；MCP schema 补 `old`/`context`；`metrics.truncated` 只表示“被预算裁过”。
- **版本记录**：0.9.8 的 metrics 改动与 0.9.9 在同一提交（版本号走过 0.9.8，但未单独切提交/构建），
  已在 0.9.8 段加本地迭代说明；0.9.9 是包含它的下一个独立版本。

## 0.9.9：`aura capabilities`

- 新增 `aura capabilities [--pretty]`：打印版本、两个工具的读模式/地址档/写安全能力、命令表、
  65 种语言、多目标上限/预算/句柄上限。全部从引擎常量派生，不额外发货 JSON。
- 与 `build/capabilities.mjs` 同源：构建期清单给消费方，运行时命令给本机排查。
- `standalone-test` 新增 6 条（212/0）。

## 0.9.8：读取回执 metrics

> 本地迭代说明：0.9.8 的 metrics 改动与 0.9.9 落在同一个提交（版本号走过 0.9.8，但未单独切提交/构建）；
> 0.9.9 是包含它的下一个独立版本。

- `readWith` 每条回执统一附 `metrics: { mode, lines, chars, symbols?, truncated }`（确定性，
  不含墙钟）；三面同形，调用方不必自己数字符或判断有没有被裁剪。
- metrics 进入预算收敛循环（每次 render 后立即附加再量尺寸）：修掉“事后贴 metrics 把 8192 档
  顶到 8250”的回归；schema 与 `PASSTHROUGH_FIELDS` 同步。
- `read-test` 四模式逐条断言 metrics；`aura-read-schema` 87/87；CLI/单目标黄金集重采；
  `standalone` 206/0。

## 0.9.7：Agent 决策指南

- 新增 `docs/agent-guide.md`：读模式决策表、编辑地址优先级（target → intent → lines → old →
  anchor/handle）、回执字段（afterLine/delta/handle）用法、失败码→下一步、事务/回滚、诊断与硬约束。
- 目标是把“什么时候用哪一层”写成可执行表，不再让调用方从散文里猜；README 目录已加链接。
- 本版为文档层，不改运行时行为。

## 0.9.6：`--plan` 同义旗标

- `aura edit` 的 `--plan` 与 `--dry-run` 同义（单目标与 `--targets` 都支持）：完整规划、
  回执照常给 `applied`/`afterLine`/句柄，但**磁盘零写入**（`dryRun: true`）。
- 用途：agent 在真正写之前先看“会落到哪几行、命中哪个 tier、有没有冲突”，比再读一遍便宜。
- USAGE 同步；`standalone-test` 新增两条（206/0）。

## 0.9.5：能力清单（机器可读）

- 新增 `build/capabilities.mjs`：从 `LANGS` / `FLAT_ADDRESS_KEYS` / `MODES` / 预算常量 /
  句柄上限**直接派生** `dist/capabilities.json`，不手抄语言数、地址档或限制。
- 清单含：两个工具与读模式/地址档、CLI 命令、65 种扩展名、多目标上限/池大小/预算/句柄上限、
  核心包 DSH-free 声明。
- `build/make-bundle.mjs --pack` 现在一并产出能力清单；`capabilities-test`（19 项）入闸，
  任何源码常量漂移都会红。
- 读数：`capabilities-test` 19/19。

## 0.9.4：CLI `aura doctor`

- 新增 `aura doctor [--json]`：自检 Node 版本、包版本、MCP 入口/握手（aura_read + aura_edit）、
  缓存目录与锁目录可写；正常 exit 0，任一失败 exit 2 并逐项点名。
- 与安装器的 `--doctor` 区分：这里不假设 DSH profile，只查这个包自己的入口与运行前提。
- 新套件 `doctor-test`（11 项）：正常环境全绿；缓存路径是文件时 cache/lock 检查红、exit 2、
  JSON 可解析。
- 读数：`doctor-test` 11/11。

## 0.9.3：性能包线闸

- 新增 `build/perf-gate.mjs`：1k/10k/100k 行 `map` 冷读/热读（p50/p95）+ 10k 行符号编辑；
  判据是**绝对上限 + 规模比值**，不把某个固定毫秒数写成跨机契约。
- 当前读数：100k 冷读 p50 563ms / p95 585ms；100k 热读 p95 120ms；t(100k)/t(10k)=×6.58；
  10k 符号编辑 p95 56.5ms。
- 基线 `fixtures/perf-baseline.json`，只走 `--capture` 采集；已入 `release-check`。

## 0.9.2：并发与崩溃一致性

- 修工作区锁的两个真实竞态：
  ① 锁文件以空文件创建、PID 尚未写入时，另一个进程会把「空文件」判成陈旧锁并抢走
     ⇒ 两个进程同时进入临界区（实测 4 进程并发改同一文件时偶发丢更新）；
     现在空锁有 2 秒宽限，超过宽限（或 `staleMs`）才回收。
  ② 等待空锁超时时，错误构造直接读 `holder.pid`（holder 为 null）⇒ 抛 TypeError 且没有
     `WORKSPACE_LOCKED` 码；现在错误消息与码都正确。
- 新套件 `concurrency-crash-test`（15 项）：4 进程并发改不同行不丢更新、pending 事务
  （模拟崩溃）回滚到原字节、外部改动后 undo 默认拒绝、空锁宽限/陈旧回收。
- 读数：连跑 5 次 15/15 通过。

## 0.9.1：目标地址失败走结果通道

- 壳层判决表补入 `STRUCT_NOT_FOUND`（→ not_found）、`STRUCT_AMBIGUOUS`（→ needs_choice）、
  `LOCATOR_SPAN_INCOMPLETE` / `LOCATOR_NO_LANGUAGE`（→ not_found）。此前这四种码不在白名单里，
  会被当成工具故障抛出：模型只看到一句 `error.message`，拿不到 `next` 与候选。
- `outcome-test` 新增 A6/A7：`target` 不存在与同名歧义都必须走结果通道、带 `next`/候选、
  且磁盘一个字节不动（含自定义夹具的磁盘比对修正）。
- 读数：`outcome-test` 172/172、`expect-single-source` 44/44、`notfound-receipt` 84/84。

## 0.9.0：T15 分辨实验（结论：不支持漂移补偿）

- 新增 `probes/coordinate-drift-experiment.mjs`：按“同会话内此前成功编辑次数 × 地址类型”统计失败率，
  合成会话自证 + 真实日志流式分析；`--self-test` / `--json` 可用。
- 本机真实读数（排除自测会话）：`lines` **47.8%**（n=416）→ **13.4%**（n=2920）；
  `target` **35.7%**（n=56）→ **21.1%**（n=71）。方向与“绝对坐标随编辑次数变差”**相反**。
- 结论：**不按“漂移自动重投影”立项**；早期失败集中在首次尝试/任务难度，后续按失败构成定位。
- `probes/session-log.mjs` 新增 `iterateSessionsDetailed`（逐会话生成、默认不保留日志/回执正文），
  修掉全量扫描真实日志时的 4GB OOM；`readSessionsDetailed` 行为与排序保持不变。

## 0.8.4：发布后验证与发布记分卡

- 新增 `build/post-publish-check.mjs`：从本地 `dist/npm`（默认）或 npm registry（`--registry`）
  取两个 tgz，解包核对声明与文件边界（核心无 DSH、适配器有 `dsh/` 与三个宿主 peer），
  离线装进临时项目，跑 CLI 取景 / MCP 握手，并做“同版本逐文件哈希一致”（发布物 = 被测物）。
- 产出 `dist/release-scorecard.json`：包 sha256/文件数、DSH-free、adapter peers、安装读数、
  任务基准读数、通过/失败计数。本地模式入 `release-check`；registry 模式需网络，只用于发布后。
- 本地模式不依赖网络；registry 模式用 `npm pack <name>@<version>`，发布后一条命令即可复核。

## 0.8.3：任务级基准与 SLO 闸

- 新增 `build/task-bench.mjs`：8 个真实编辑任务（JS 符号、TS 意图、Python 符号、Go 行区间、
  Rust `pub const`、SQL 行、Erlang 意图、JS 多 hunk），每个任务走“读一次 + 改一次 + 回读校验”。
- 读数：成功率、调用数、token（read 输出 + edit 回执 / 4）、p95 延迟、返工次数；基线在
  `fixtures/task-bench-baseline.json`。
- SLO：8/8 成功、每任务 2 次调用、返工 0、token ≤ 基线 1.2×、p95 ≤ max(5s, 基线 p95×3)
  （墙钟有噪声，只作 sanity ceiling，不当硬指标）。
- 入 `release-check`；基线更新只走 `node build/task-bench.mjs --capture`，不手写。

## 0.8.2：`auto` 选模式用宿主真实预算

- `suggestMode(source, file, budget)` 与 `readWith({mode:'auto', budget})` 改用
  `budget - DEFAULT_ENVELOPE_ALLOWANCE` 判断全文是否装得下；宿主阈值高于默认 8192 时，
  6000+ 字符的文件不再被误判成“装不下”而拿到一个索引。
- `auto` 的理由披露 `host budget` 与 `envelope allowance`，避免“看起来是全文、其实按旧常数算”。
- 预算只影响 `auto` 的选择与渲染；显式 `mode=` 不被改写；不传 `budget` 时回落到 8192。
- 新套件 `auto-budget-test`（16 项）入闸，钉住宽/窄预算、超大文件、显式模式与默认回落。

## 0.8.1：编辑回执自带继续编辑的上下文

- `applied[]` 新增 `afterLine` / `afterEndLine` / `delta` / `handle`：改后坐标、行数变化、改后区间的
  **新句柄**。下一次 `edit` 可直接拿 `handle` 寻址，不必先回读；`line` 仍是改前坐标（契约不变）。
- 片段层（`old` 命中行内一段）另回填 `after`（整行改完的样子，400 字符上限 + `afterTruncated`）；
  整行替换不重复回填——`replaced` 已经是完整的新区域。
- 删除（零行区间）不铸句柄，`delta` 为负；多 hunk 调用里后一条的 `afterLine` 会叠加前一条的 `delta`。
- 修了片段层的行数口径：拼接用的 `parts` 把 prefix/tail 拆成两个数组项，不能当行数；
  按**逻辑行数 + 终态文本**计算，避免把 `old: 'hello'` 这种行内替换误报成“新增一行”。
- 新套件 `receipt-context-test`（27 项）入闸；`single-target` 黄金集按 `--capture` 重采；
  多目标/DSH 渲染对比只归一“句柄身份标签”（不同 identityKey/临时路径是事实，不是渲染分叉）。

## 0.8.0：意图地址（T16）

- `aura_edit` 新增 `intent` 地址：符号名片段 / 短语 / 近似原文，由引擎确定性地收敛成精确区间，
  不再要求模型先知道符号全名、行号或逐字原文。
- 解析次序：精确/限定符号（`resolveTarget`）→ 唯一符号子串（区分大小写优先，忽略大小写兜底）→
  `near` **严格**消歧（跨度包含 near 记距离 0，并列仍拒）→ 文本锚点（复用 `anchor` 的五级引擎）。
- **结构歧义当场拒绝**，绝不落到文本层：符号名已经给出多个候选时，文本匹配「恰好」命中其中一处
  会把「有两个都可能」静默卖成「就是这一个」。歧义回执给符号候选（name/kind/行）或文本候选（行/原文）。
- `intent` 与其余地址字段互斥：同时给 `target` / `lines` / `line_cue` / `anchor` / `old` / `context` /
  `handle` 会在规划期抛 `PATCH_INTENT_CONFLICT`，磁盘一个字节不动；`near` / `expect` / `replace` 允许。
- 三面接线：DSH `HUNK_PROPERTIES`、MCP `HUNK_SCHEMA`、CLI `--intent`；回执 `tier` 为
  `intent~symbol` 或 `intent~text~<档>`，`byNear` 如实透传。
- 新套件 `intent-address-test`（31 项）入 `release-check`；`range-args` / `arg-shape` /
  `public-surface` / `aura-edit/load` / `single-target-nonregression` 等同步更新键表并通过。

## 0.7.1：Erlang/Rust 语言覆盖 + 拆包验收补强

- **T2 Erlang 函数子句可寻址**：`beta(A) ->` 能出 `function:beta`，跨度覆盖整个函数（含多行体与多子句）；
  `when` 守卫、同名多子句、`-spec` 属性不再误收或造重复符号。修了三层：
  ① `attributeClause` 闸门改为按语句边界（`.` / `;`）判定，并在参数组之后找 `->`（允许 `when` 守卫）；
  ② Erlang 的终结符扫描关闭换行停止条件，多行函数体不再截在签名行；找不到 `.` 时 fail-closed；
  ③ 词法器不再把 `1.` 的语句终结符吞进数字（`1.0` 仍是浮点）。
- **T28 Rust `pub const` 可寻址**：`$mods*` 从「全吃 / 不吃」改为逐长度回溯，`pub const X: T = v`
  与 `pub unsafe const` 都能出 `variable:X`；`pub const fn` 仍是 function。`var-binding` /
  `fresh-judgement` 已把当时缺的形状升为正向断言。
- **拆包验收从“字段断言”升级为“装起来真能用”**：新增 `build/split-package-test.mjs`，
  离线安装两个 tgz，从**装出来的核心**跑 CLI `/` MCP `/` npx，并核对适配器的每条
  `aura-basetools/` 导入都解析到核心包（有宿主 peer 时再真 `import` 两个壳与钩子执行器）。已入
  `release-check`（⑥b）与 CI。这套件当场抓出一个真缺口：适配器第一版**漏了 `dsh/` 钩子执行器
  与 `@deepseek-ai/dsh-shell` peer**——症状会是“文件看起来都在、钩子全不触发”（与 T30 那次
  安装事故同形）。现已在拆包产物里补齐，并把三个宿主 peer 标成 optional（安装期不去 registry
  解析私有包，缺 peer 时由真 import 显形）。
- **一致性清单改为单源** `build/bundle-layout.mjs`：此前 `release-check` 手抄的清单漏了
  5 个已发布文件（`handle-core.mjs`、`transaction-store.mjs`、`workspace-lock.mjs`、
  `dsh/argv-shell.mjs`、`dsh/hook-inproc.mjs`），它们进了包却不在“改了源没重建”的射程内。
  现在打包与比对共用一份清单；`make-bundle.mjs --pack` 一条命令同时产出 `dist/npm` 双包。
- 修正文档里**启动不了**的 npx 形式：本包有 `aura` / `aura-mcp` 两个 bin、没有与包名同名的，
  npx 会直接拒绝猜；改成 `npx -y --package aura-basetools aura mcp` 并加断言钉住。
- 拆包元数据不再编造默认仓库地址/作者（与组合包同一政策：环境变量没设就不写）。

## 0.7.0：核心/DSH 拆包

- `aura-basetools` 只含引擎 + CLI + MCP，没有 DSH peer；`aura-basetools-dsh` 是 DSH 适配器，依赖 core。
- core 的 `exports` 开放 `locator-lab/*`，DSH 壳以包名 import，不再靠同一目录布局。
- CI 增加 split 构建与“core 无 DSH”断言；核验 Windows + macOS 15/26。
- 发布 `aura-basetools@0.7.0`、`aura-basetools-dsh@0.7.0`。
  **注意**：已发布的 0.7.0 适配器缺少 `dsh/` 钩子执行器与 `dsh-shell` peer，且文档里的 npx 形式不可用；
  这些缺口在 0.7.1 修好，0.7.0 不应再作为新安装目标。

## 0.6.19：写入边界收紧 + 写事务

- 写事务：`edit` 在第一次写入前记录原始字节；成功后 `--transaction` 返回 id，`aura undo` / `--id` / `--force` 可恢复；多目标部分失败时回滚已落地文件。
- workspace 锁：`~/.aura/locks` 串行化同一工作区的写事务，`AURA_NO_LOCK=1` 可关闭。
- 新增 `aura transactions`、MCP `aura_undo` / `aura_transactions`。

- `fs-provider`：原子替换保留现有文件 mode（POSIX）；符号链接写穿到 realpath；悬空链接与硬链接显式拒绝。
- `fs-provider`：`stat` 改为只读头尾指纹，`readByteRange` 改为真正的区间读；不再为了 1 字节读整份文件。
- `fs-provider` / `ops`：文本读写默认 512 MiB 上限，提供 `AURA_MAX_FILE_BYTES` 覆盖。
- 版本指纹纳入 ctime；rename 前再校验一次目标版本，缩小 check-then-act 窗口。
- `observation-store`：缓存目录 `0700`、文件 `0600`；`AURA_NO_OBSERVATION_CACHE=1` 可关闭。
- 临时文件写后 fsync 再 rename；不支持 fsync 的 FS 退化为尽力而为。
- 新增独立面 N1–N6：mode、symlink、hardlink、range、大小上限、缓存权限。
- 删除外部 AuraPolaris 差分测试；它不属于文件工具的发布门，也不再依赖用户级 hook 路径。
- 新增 Windows/macOS CI（Node 22）覆盖独立面与打包后验收。
- 独立面 O1–O8：单/多目标 transaction、undo、外部改动拒绝、部分失败回滚、锁冲突。

## 0.6.2 → 0.6.9：契约与分发连续推进（同夜多版）

这一段是同一夜里的连续小步发版，主线是三件事：

| 版本 | 变更主线 |
|---|---|
| 0.6.2 – 0.6.3 | 契约 v2 落地：`expect` 从「等于整段区间」改成「被区间包含 + 全文唯一」，并按**地址形态分档**（给了精确坐标就免全文唯一）—— 成功集回归因此从 Z=7 打到 **Z=0** |
| 0.6.4 – 0.6.5 | 写侧四态走**结果通道**（`applied` / `needs_choice` / `not_found` / `already_applied`）；找不到时回执带最近一带真实原文与可执行 `next` |
| 0.6.6 – 0.6.7 | 性能：结构索引与锚点索引改**内容令牌记忆化 + 自适应额度**（原先 32 MiB / 48 MiB 固定上限在 10 万行档直接失效）；同会话重复读只回差量 |
| 0.6.8 – 0.6.9 | **路径同一性**（观测账本按盘上那份文件记账，`realpathSync.native`；跨进程成立）、非 UTF-8 文件四件事齐（哪个文件 / 为什么读不了 / 下一步 / 这次没写盘）、测试不再写用户真实 home |

**最值得记的一处**：0.6.8→0.6.9 的升级引导踩过一次坑 —— 跑「建 peer 链接」的是**上一版**安装器里的硬编码列表，
于是新加的 `@deepseek-ai/dsh-shell` junction 没建出来，症状是钩子**全不触发**。现在有 B2a/B2b 两条判据成对盯着它。

## 0.6.10：多目标并行 + 句柄化 + 修复地址（波MT / 波H）

- **一次调用多目标**：读侧 `readManyWith`、写侧 `applyEditsToProvider`；`MT_POOL = 8`、`MT_MAX_TARGETS = 32`；
  **`N === 1` 直接调用、不走池、不加壳**（这是"不拖累单目标"的实现方式，不是承诺）。
  实测：20 个文件串行 **274 ms → 池化 59 ms（4.6×）**，20/20 落地。
- **句柄化**：读侧在回执**正文的行尾**发不透明区间句柄 `<h9f3ac1b2e4d5:120-160>`，编辑侧接受「句柄 + 相对定位」。
  落点只进**模型看得见的那段 text**（结构化字段到不了模型）。每条句柄净增 **71.1 字符**。
- **修复地址**：失败回执给**可直接粘回去的地址**（`retry: {"handle":…}`），而不是让人重新猜位置。

## 0.6.11：判定内联（PreToolUse 守卫改在宿主进程内跑）

原来每次工具调用要 spawn 一个独立 node 跑守卫钩子（宿主侧 p50 **232.4 ms**，而钩子自己的判定只有 ~6 ms）。
现在同一条守卫在**宿主进程内**跑完，**不需要改接线**（执行器路径没变）。
差分等价的判据是这套改动的核心：同一条载荷两条路各跑一次，比 stdout 字节 / 退出码 / stderr / 结果外壳 / 落账记录。

> ⚠️ 这一版在真实宿主里曾**退化成"每次 spawn"**（`state_signature_changed` 每调用都命中），
> 到 **0.6.15** 才真正修好（见下）。

## 0.6.12：多 hunk 回执指对行（写盘字节一直是对的，错的只有回执）

根因是 `planHunks` 里一处表达式上的两件事：① 数组顺序被底层"从下往上拼接"的实现顺序泄进了回执；
② `replaced` 用 hunk 的**改前**下标去**改完之后**的输出里 slice，只要低位 hunk 改了行数，高位那条就会拿到邻居的行。
规模：全量 5,550 条可观测落点里 **1,264** 条对不回任何 hunk。修后同样的 hunk 形状重放，对不回的 **332 → 0**。

## 0.6.13：多目标写的逐项正文不再说反

两目标的写批，`summary` 写 `applied 2`、盘上真的改了，而**逐项正文**却是
`<path>: nothing was written — outcome: undefined` —— 模型看得见的就是这段正文，它会让人把已经改成功的编辑再改一遍。
根因是边界上两种词汇表对不上（渲染器判 `value.outcome !== 'applied'`，而引擎把逐项 kind 放在**项**上）。
修法是加一层边界适配，**只动渲染层、只改回执、一个字不提写盘**。

## 0.6.14：指导文本与工具描述都说出 `targets`

两处"更好表达"：`aura_read` / `aura_edit` 的指导文本各加一句命令式，工具描述各加一句。
理由是**两段文本里之前一个字都没提 `targets`** —— 而"参数表里有个数组"与"模型会想到要批量"是两回事。

## 0.6.15：判定内联在真实宿主里退化成"每次 spawn" —— 已修

现场（0.6.14 已生效的宿主）：`{"inproc":46,"spawn":103,"reasons":{"state_signature_changed":68}}`，
**每次工具调用 `spawn` 稳定 +1** —— "进程内跑"事实上没有发生，而 `inproc=46` 是上一个宿主留下的假象。
根因这次量到了：漂的那一段是 **`workdir`**（该宿主同时服务两个工作区，钩子调用在两个目录之间来回）。
修法不是拆护栏，而是把"签名一变就退回 spawn"换成"**签名一变就换一份干净模块实例，仍在进程内跑**"。

**实测**：同签名稳态 **1.5 ms**（×167）、每发换签名 **8.0 ms**（×31）、spawn **249.3 ms**。
重启后真机：钩子墙钟 p50 **239.5 → 4.4 ms**，连续两次工具调用之间 `spawn` 增量为 **0**。

## 0.6.16：独立面接 `targets`（CLI + MCP）

按用户裁定（"肯定要 cli 和 mcp 啊"）：CLI 新增 `--targets '<JSON>|@文件'`（与 `--file` 互斥、形状错 exit 1）；
MCP 两个工具的 `inputSchema` 声明 `targets`；`lib/ops.mjs` 成为三面唯一的引擎绑定点。
判据：`standalone-test.mjs` 新增 MT-G/H/I/J/K（83 → 155 条，其中 MT-J 是 12 个单目标调用的**逐字节黄金集**）。

## 0.6.17：句柄寻址补到三个面（验收口径从"采样率"改为"能力面"）

用户裁定："不用管真正的多目标采样率是多少。客户怎么使用 aurabridge 的可能性都有，不应该被现状禁锢。"
⇒ 验收改看**能力面**：同一能力在 DSH 工具面 / CLI / MCP 上都必须**可用且声明过**。
这条口径当场逼出一个真缺口：MCP 的 `HUNK_SCHEMA` 没声明 `handle`/`line`/`position`，CLI 的平铺旗标也没接这三个键 ——
**给得出、用不上**。补完：MCP 参数表 9 键 → **12 键**，CLI `--handle` 配 `--line`/`--position` 实跑成功。

## 0.6.18：修复地址补到第三个面 + 探针未知旗标清欠（本轮）

- **修复地址的 DSH 工具面复核**（能力表最后一条 partial）：新增 `repair-address-shell-test.mjs`（6 条判据，
  取的是**渲染后**的正文文本 —— 引擎里有不算，要眼前有）；CLI/MCP 在 `standalone-test.mjs` 的 MT-M 段（10 条）。
- **拓出并修好一个真缺口**：DSH 失败回执过去**只有正文里那行字**，结构化那半在壳这层被丢了
  （CLI 有 `nearest.retry.handle`、引擎有 `error.retry.handle`，DSH 一个字段都没有）。
  已补进声明面 `retry: { handle }`；**正文写法一字未改**，失败仍是返回不抛错，给地址那一发零写盘。
- **15 个探针补上"未知旗标 ⇒ exit 2 + 点名 + 列支持集"**：原先静默吞掉，会给出"看着完全正常、其实取了默认窗口"的读数
  （`success-regression` 的 `--until` 拼错就会这样）。读数不变当场验过。
- **两处量具修好**：`A5-home-untouched` 改为逐件归因（不再把"活宿主每次工具调用写的钩子计数"算成探针的写）；
  `repair-address-shell` 的变异臂改跑**仓库外的私有副本**（就地改源文件会让闸里并发跑的别的套件读到被改过的引擎）。

> 沿革：0.6.10 的多目标、0.6.15 的内联，都属"先落地、后在真实使用里发现形状问题再修"这一类；
> 本表刻意把**当时的读数**与**后来发现的问题**并列写，免得只看版本号以为一路顺风。
