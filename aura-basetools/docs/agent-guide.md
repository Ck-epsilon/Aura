# Agent 决策指南：什么时候用哪一层

> 给调用方（agent）的**可执行**决策表，不解释内部实现。目标：用最少的调用与 token，
> 把改动**正确、可验证、可回滚**地落到磁盘。所有入口（CLI / MCP / DSH）共用同一份判据。

## 1. 读：先选模式，再选区间

| 你知道什么 | 用什么 | 备注 |
|---|---|---|
| 只想先看结构 / 符号 | `mode=map` | 大文件首选；输出有符号目录 |
| 先判断值不值得读 | `mode=probe` | 行数/字节/行尾/编码/语言/结构规模，一行摘要、不发正文 |
| 文档 / 配置（.md/.json/.yaml/.toml） | `mode=map` | 标题树 / 键路径 + 行号区间；下一步用 `mode=lines` 取一节 |
| 想要签名与少量正文 | `mode=digest` | 中等文件；文档/配置返回结构目录（与 map 同源） |
| 文件很小 / 要全文 | `mode=auto` | 引擎按宿主 `budget` 判断全文是否装得下；装得下直接给全文 |
| 要某个函数体 | `mode=lines` 或 `mode=around <符号>` | 从 map/digest 的行号直接抄 |
| 找某个词 | `mode=search` | 命中行号可直接用于下一次编辑 |
| 刚改过，想看差异 | `mode=changed --since <令牌>` | 令牌来自上一次读回执的 `version` |
| 要整文件/分段读完 | `--offset <0-based> --limit <行数>` | 与 `lines` 互斥；默认 limit 2000；与显式 `mode`（`auto` 除外）也互斥；`targets` 元素同样支持 |

`context` / `kind` / `budget` / `max_chars` 在单目标、`targets` 元素和 DSH 面都走同一个
`normalizeReadRequest`；同一个元素单独读与放进 `targets` 读必须给出同一份回执。

**预算**：MCP/DSH 会把宿主的剪枝阈值作为 `budget` 传入；CLI 可用 `--max-chars`。
不要自己猜 8 KiB——预算不是常数。

## 2. 改：地址从“最确定”到“最自然”

先记一条**安全等级**（`capabilities` 的 `addressSafety` 同源）：`old` 是内容地址、`handle` 绑定版本，
两者自带校验；`target` 是结构定位；`lines` / `line_cue` / `anchor` 只是坐标/线索——**未读过的文件也能写**，
回执会标 `unverified_region: true`，要强制先读用 `require_observation`（`--require-observation`）。

优先顺序（越靠前越不容易错）：

1. `target`：符号全名 / `kind:name` / `Outer/Inner` / `name#2`。不读文本，对记错内容免疫。
   同一行还有别的同级符号（压缩代码）时会被拒（`LOCATOR_LINE_SHARED`，带同行候选）；
   lone CR（老式 Mac 行尾）文件上的 `target` / `lines` 也会被拒（`LOCATOR_LONE_CR`）——
   改用 `old` 片段或 `aura_basetools_write` 整份定稿。
2. `lines` / `start_line`+`end_line`：刚从 read 回执抄来的绝对行号。
3. `old`（+ `context`）：你手里有逐字原文；比坐标更接近“你想改的是这里”。
   `old` + `replace_all: true`（CLI `--replace-all`）改**全部非重叠出现**，见 §2.2。
4. `anchor` / `line_cue`：记得一段原文 / 一个唯一词；容错最高，但最容易指错。
5. `handle`：`aura_basetools_read` 发的不透明区间句柄。**下一次编辑首选**；区间与字节由工具账本保证。

规则：

- **地址优先级**：`handle` 在场时其余地址只作披露；`old` 优先于坐标/符号名；
  `replace_all` 只认 `old` + 动作字段。`intent` 已在 0.14.0 移除。
- **高风险编辑带 `expect`**：它是“我以为这里是什么”的断言；不符会整批拒绝，磁盘不动。
- **换行风格**：`replace` 默认 `eol: "auto"`，新行跟被替换区域（CRLF 文件写 CRLF）。
  要保留输入原样用 `"preserve"`；要强制统一用 `"lf"` / `"crlf"`。回执的 `eolAdapted`
  说明这次有没有改写过换行。
- **先 plan 再写**：`aura basetools edit --plan`（或 `dry_run` / MCP `dry_run: true`）给完整的
  `applied[]`（tier、行号、改后坐标、句柄），但零写入。确定地址后再去掉 `--plan`。
  预演**不铸可复用句柄**（盘上没写，句柄必过期）；要句柄就真写，或写完再读。
- **多文件用 `targets`**：一次调用、逐项回执；任一规划失败 ⇒ 整批零写入。上限 32 项。
- **严格新鲜度**：`require_observation: true`（CLI `--require-observation`）要求**当前这版**
  被本会话读过或写过；否则 `PATCH_UNOBSERVED`（`reason: never-read` / `changed-since-read`）。
  默认不强制，但没观测过的编辑会在回执里标 `unverified_region`；预演同样执行严格判决。

### 2.1 整份写：只在没有可寻址的局部时用

CLI `aura basetools write --file <路径> --content <文本|@文件>` / MCP 与 DSH `aura_basetools_write`（`file_path` + `content`）：

- **新建或整份覆写**，不改局部；已有文件会保留 BOM，content 的换行适配成文件已有风格，
  有无尾换行精确保留。能定位到局部时仍优先 `edit`（整份写会重写所有字节）。
- **覆写默认要求先读过这一版**：没读过 ⇒ `PATCH_UNOBSERVED`。`allow_unobserved: true`
  （CLI `--allow-unobserved`）才允许盲写，**同时越过区域陈旧闸**，回执照实标
  `unverified_region`；新建文件豁免。
- **换行**：`eol: auto`（默认）套用文件已有风格；`preserve` 按 content 原样写（要逐字节
  对齐内置 `Write` 时用它）；`lf` / `crlf` 强制。新建文件始终原样写，显式非 `auto` 会拒绝。
- `no_overwrite: true`（CLI `--no-overwrite`）：文件已存在就拒绝（`WRITE_EXISTS`），不覆盖。
- `dry_run: true`（CLI `--dry-run` / `--plan`）：不落盘；覆写预演不回 `bytes`，因为它可能被行尾适配改写。
- 与 `edit` 共用工作区锁与落盘回读；0.14.0 起没有公开事务 id / `undo` / `transactions`。
- **写后验证**：`verify: "<命令>"`（CLI `--verify`）在 workspace 根下执行；非零/超时 ⇒ 自动回滚，
  回执 `PATCH_VERIFY_FAILED` + `verification`。只跑你显式给的命令，不自动发现仓库脚本。
- 回执是紧凑形状：`result.{path, operation: create|write, bytes, dryRun, write_verify}`，
  不带整份 `applied` 文本。

### 2.2 批量替换：`old` + `replace_all`

- **只给 `old` 与动作字段**（`replace` / `expect` / `eol`）；与 `target` / `lines` /
  `line_cue` / `anchor` / `context` / `handle` / `near` 同用会被拒（`PATCH_REPLACE_ALL_CONFLICT`）——
  它们都是“收敛到一处”的工具，和“全改”没有共同答案。
- 匹配按 **非重叠、从左到右**：`old: "aa"` 在 `aaaa` 上改 2 处，不是 3 处。
- 回执 `applied[]` 逐处给 `line` / `afterLine` / `delta` / `handle`；同一行多处各有自己的列。
- **读取后出现次数变了会整体拒绝**（`PATCH_STALE_REGION` + `occurrence_count: {was, now}`）；
  次数没变、只改了无关行时会放行。没有读过也能写，但回执标 `unverified_region`。
- `old` 的匹配仍保持两档：存在逐字命中时只改逐字命中；一处逐字都没有时才用空白折叠。
  因此 `old` 不要带首/尾换行：片段层会把它们去掉（`replace_all` 直接拒绝这种形状，
  避免 `old:"a\n"` 退化成在 `banana` 里也命中）。

### 2.3 JSON/JSONC：把转义面压到最小

改 JSON 文件时，模型要写的每个 `"` 都会变成 `\"`；`old` 与 `replace` 加起来，约一半字符是转义。
实测过一次真实的失败：一条 552 字符的 edit 在收尾处少了一个 `}`，模型输出的 tool 参数在第 549 位
解析失败，**整轮任务中止**（工具一次都没被调用）。因此改 JSON/JSONC 时：

- **优先 `lines` / `start_line`+`end_line` 定位，不要 `old`**：`replace` 只放新文本，转义面积减半；
- **单 hunk 可以平铺在顶层**（`{file_path, start_line, end_line, replace}`），不必包进 `hunks: […]`：
  少一层 `}` / `]`，收尾处就少一个出错点；
- hunk 尽量小（一次一块），别把整个文件塞进 `replace`。

这几条改变的是**模型写 JSON 的难度**，不是工具的能力边界——两种形状工具都收。

### 2.4 编码：非 UTF-8 也能改，但“能读”不等于“能写”

- 自动探测：UTF-8、UTF-16LE/BE（BOM）、GB18030（GBK）、Shift_JIS、EUC-KR、Big5、Windows-1252。
  回执里的 `encoding` 是探测结果；非 UTF-8 还会给 `encoding_confidence`。
- 写回用**读时那次探测的编码**，未改动的行逐字节保留。
- 猜不准（medium/low）或编码不可逆时，**写会被拒绝**（`ENCODING_AMBIGUOUS` / `ENCODING_NOT_ROUNDTRIP_SAFE`）；
  用 `AURA_ENCODING=gb18030`（或服务配置的 env）显式指定即可继续。
- 目标编码表示不了的字符（如 GBK 里没有的扩展区汉字）⇒ `ENCODING_UNREPRESENTABLE`，零写入。

## 3. 看回执：不要回读，直接用句柄

成功回执的 `applied[]` 每项包含：

- `line`：**改前**行号（与其它 hunk 可比）；
- `afterLine` / `afterEndLine`：**改后**行号；多 hunk 时已叠加前一条的 `delta`；
- `delta`：这条 hunk 增删了几行；
- `handle`：改后区间的**新句柄**；下一次编辑直接用它，不必先读；
- `actual` / `replaced`：改前 / 改后文本；片段层另有 `after`（整行改完的样子）。

**下一次编辑**：`{handle, replace}`；要改区间内第 k 行用 `{handle, line:k}`；边界插入用
`{handle, position:'before'|'after'}`。

## 4. 失败：按码走，不盲重试

| 回执 | 含义 | 下一步 |
|---|---|---|
| `outcome: needs_choice` + `candidates` | 多处都能对上 | 从候选里选一个；或加 `near`；或改用 `target` |
| `outcome: not_found` | 地址/原文不在 | 看 `message` 里的实际内容与 `next`；重读后再给地址 |
| `PATCH_STALE_REGION` | 读后被外部改过（区域级 / replace_all 次数变了） | 重新读，用新行号/句柄；不要原样重试 |
| `PATCH_UNOBSERVED` | 严格新鲜度开启，但当前这版没读过（或已变） | 先 `aura_basetools_read` 同一文件，再原样重试 |
| `LOCATOR_SPAN_INCOMPLETE` | 符号跨度覆盖不了函数体 | 改用 `lines=` 或 `line_cue=` |
| `LOCATOR_LINE_SHARED` | 目标符号所在行还有别的同级符号 | 用 `old` 唯一片段 / `handle`，或整份写 |
| `LOCATOR_LONE_CR` | 文件是 lone CR 行尾，行号模型不可信 | 用 `old` 片段 / `handle`，或 `aura_basetools_write` 整份写 |
| `LOCATOR_CUE_AMBIGUOUS` | 线索出现多次 | 加 `near`，或换更长的片段 |
| `WORKSPACE_LOCKED` | 同工作区另一个写事务持锁 | 等锁超时后重试；不要删锁文件 |

失败回执一律 `applied: []`、正文说“nothing was written”；磁盘没动。不要用“看文件变没变”
来猜成败——看 `outcome`。

## 5. 并发与内部回滚

- 0.14.0 移除了公开 `--transaction` / `undo` / `transactions`（642 个会话中 0 次使用）。
- 写失败仍会自动回滚已落地的目标；事务日志是内部实现，不需要调用方操作。
- 同一工作区的并发写由锁串行化；`AURA_NO_LOCK=1` 只用于明确知道没有并发者的场景。
- **跨调用事务不是隔离**：`tx begin` 后带 `--tx` 的写入**立刻落盘**（`tx status` 仍是 pending），外部进程能看到新内容；`rollback` 才按 afterVersion 恢复。要“改完再验证再提交”，把 `verify` 放在 `tx commit --verify`。
- **跨调用事务**：`tx begin` → 多次 `edit/write --tx <id>` → `tx commit --id <id> [--verify]`；
  失败/外部改动/verify 失败都可 `tx rollback --id <id>`。commit 前做 afterVersion 校验与三方合并；
  非重叠外部改动自动合并，重叠/不可合并为 `TX_CONFLICT`（零写入）。
  MCP 用 `aura_basetools_tx`（action=begin/commit/rollback/status）与 edit/write 的 `transaction`。
- MCP `initialize.instructions` 会请求客户端优先 aura 工具；这是标准提示位，不是强制。

## 6. 诊断

装完先跑 `aura basetools doctor --json`：Node/版本/MCP 握手/缓存与锁目录。MCP 侧可用 `aura_basetools_read` /
`aura_basetools_edit` / `aura_basetools_write` 三个工具自检。
DSH 面提供 `aura_basetools_read` / `aura_basetools_edit` / `aura_basetools_write` 三个工具（没有事务/undo 入口）。

## 7. 硬约束（不要交易）

- 逐字节保真：编码、BOM、逐行行尾、mode 在原子替换后保留；符号链接写穿、硬链接拒绝。
- 地址对不上就拒绝；歧义不猜；失败不写盘。
- 写后回读校验；`write_verify.level` 说明是字节级还是文本级。
- 发布物必须等于被测物（`build/post-publish-check.mjs`）。

## 8. 参数总是写坏：让 provider 强制 strict

`MALFORMED_RESPONSE`（tool 参数不是合法 JSON）发生在**工具被调用之前**：工具收不到字节，也兜不住。
能归零的是 provider 的约束解码：DeepSeek `/beta` + 每个 function `"strict": true`；OpenAI `strict: true`。
本包的 schema 可直接转换（`locator-lab/strict-schema.mjs` 的 `toStrictSchema` / `strictToolList`），
`aura basetools doctor` 会打出 recipe。不开 strict 时能做的只有降低概率：
JSON/JSONC 用 `lines` 定位、hunk 拆小（见 2.3）。
