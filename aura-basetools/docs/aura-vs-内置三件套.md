# aura 读写工具 vs 内置 read / write / edit

> **一句话**：内置三件套是**通用文件接口**（读整份、整份覆写、按字面文本替换）；aura 是**给 agent 的意图接口**
> （读按意图取景、改按意图寻址），并在**字节保真、并发粒度、失败可见性**三处给了可验证的硬保证。
> 不是替换，是分层：`aura_basetools_read` / `aura_basetools_edit` / `aura_basetools_write` 当主力，内置 `read_image`（无替代品）
> 与“编辑前默认必须先 Read”的强闸兜底。

实测环境：Windows，Node v24.15.0，DSH 内置工具来自 `dsh-tool-fs` + `dsh-fs-local`（随宿主发行版）。
下面的每个数字都是本次在一台机器上**跑出来**的，命令写在 §7，可复跑。

> **范围提醒（2026-10-23 补）**：本文件比较的是 **DSH 内置 `dsh-tool-fs`**，不是 ZCode 客户端的
> `Read` / `Edit` / `Write`。ZCode 内置 `Edit` 实测**保留 BOM 与 CRLF**，并会把多行 `replace` 的
> LF 适配成文件已有的 CRLF；不要把下面“内置 edit 丢 BOM / 整份 CRLF→LF”的结论套到 ZCode 内置工具上。
> aura 0.10.0 已用 `eol: auto` 对齐 ZCode 的换行行为；0.10.1 的 `aura_basetools_write` 已覆盖整份新建/覆写
> （BOM 与文件既有行尾保留、失败自动回滚、no-overwrite），0.10.2 的 `replace_all` 覆盖批量替换。
> ZCode 内置工具仍独有的只剩读图，以及 **edit 默认的 read-before-edit**（aura 的
> `require_observation` 是 opt-in；`aura_basetools_write` 覆写默认已对齐）。aura 另提供符号/句柄寻址、
> 失败自动回滚、多目标、区域级陈旧闸门与“出现次数变了就拒”的 replace_all 闸。

---

## 1. 同一改动，两条路的字节结果（最直观的对照）

夹具（`%TEMP%\aura-vs-builtin\`）：

| 夹具 | 改前 | 说明 |
| --- | --- | --- |
| `bom.js` | 29 B，`EF BB BF` 开头（UTF-8 BOM） | 与 `bom.aura.js` 逐字节相同 |
| `mixed.js` | 54 B，CRLF×2、LF×2（第 1、4 行 CRLF） | 与 `mixed.aura.js` 逐字节相同 |

改动完全一样：把 `const b = 2;` 改成 `const b = 22;`（第二行）。内置走 `edit`（`old_string`/`new_string`），
aura 走 `aura basetools read` → `aura basetools edit`（`anchor` 寻址）。

| | 内置 `edit` | `aura_basetools_edit` |
| --- | --- | --- |
| `bom.js` 字节 | 29 → **27**（少 2） | 29 → **30**（多 1，正是这次改动） |
| `bom.js` BOM | **消失**（前 3 字节变成 `63 6f 6e`） | **保留**（前 3 字节仍 `ef bb bf`） |
| `mixed.js` 字节 | 54 → **53** | 54 → **55**（多 1，正是这次改动） |
| `mixed.js` 行尾 | CRLF×2 → **0**，LF×2 → **4** | CRLF **仍是 2**，LF **仍是 2** |
| 被改行之外的行 | **第 1、4 行被重写**（CRLF→LF） | **一字未动** |
| 工具回执 | “文件已更新” | `ok:true` + `write_verify {level:"bytes", bytes:42}` |

也就是说：内置 `edit` 报的是成功，但**你只改一行，它把整份按"多数行尾"重排了一遍**，顺手把 BOM 抹掉。
两个改动都不会有任何提示。

### 根因（不是"实现粗糙"，是设计如此）

`dsh-fs-local/lib/index.js`：

```
:566-567  normalizeLineEndings(content)      // 把内容里所有 \r\n 塌成 \n —— "the canonical in-memory form
                                             // every edit/diff basis"
:569-572  detectLineEndings(raw)             // 在样本里数 CRLF，按**多数**判定整份风格 CRLF 或 LF
:582-583  restoreLineEndings(content, style) // LF 原样；CRLF 则先归一化再整份 join("\r\n")
:610-611  readForEdit() → {content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw)}
:840      editText(target, edit, expected)   // 内置 edit 走这条：读 → 归一化 → 改 → 整份还原
:821      writeText(target, content, expected) // aura 走这条：逐字节写 + 版本 CAS（:825 replaceIfVersion）
```

`:569-572` 的多数判定解释了 `mixed.js` 的实测：CRLF=2、LF=2，`2 > (4-2)` 不成立 → 判成 LF → 整份写成 LF。
另外在这个文件里 `grep 'BOM|byteOrderMark|\uFEFF'` **零命中** —— 它根本没有 BOM 这个概念，
所以"保 BOM"不可能由它保证。

### 为什么这些差异会真的咬人

- **BOM 丢失**：有的工具链（部分 PHP/Java/Gradle、Excel 打开的 CSV、做哈希戳的构建）看 BOM 决定编码；
  丢一次是静默的，重新加上也是静默的，只有下游报错时才追得回来。
- **行尾重排**：CRLF 仓库里改一行 → **整份文件进 diff**，`git blame` 全废，每个分支都冲突，
  CI 的行尾检查直接红。这类"看起来只是改了五行、实际改了 900 行"的事故最难查。
- **两者都是静默的**：回执只说"成功"，没有任何字段告诉你"别处的字节变了"。

---

## 2. 六条硬保证（逐条对照）

### A. 逐字节保真
- **主张**：只改你寻址到的那些字节；前导 BOM 的数量、每一行各自的行尾都原样保留。
- **机制**：写回走 `writeText`（逐字节）而不是 `editText`（整份按多数行尾重排）；BOM 用"计数 + 只补不吞"处理
  （C10 审计里修掉了用 bool 判定、导致双 BOM 文件反而掉一个 BOM 的问题）。
- **实测**：`byte-fidelity` 94/94（含 15 种字节形态矩阵：只有被寻址的字节变化）、`encoding-fidelity` 32/32、
  `span-fidelity` 95/95；§1 那张表就是这套保证的现场演示。

### B. 区域级新鲜度闸门（对并发的粒度）
- **内置不是没有保护**，实测它很好：我读过文件后第三方改了内容，内置 `edit` 明确拒绝 ——
  `file changed since it was read — re-read the file, then retry`。它查的是**整份版本**
  （`:143`，`dev:ino:size:mtimeNs:ctimeNs`）。
- **差别在粒度与可操作性**：
  - 整份版本 → 别人改了**任何一个无关字节**，你这条合法改动就被挡住，只能把整份重读一遍（再吃一次整份上下文）。
  - aura 是**区域级**：只在你寻址的那块变过时才拒，并在消息里**指名行号**：
    ```
    { "ok": false, "code": "PATCH_STALE_REGION",
      "error": "… the addressed region (lines 1-1) changed after the last observation — re-read those lines, then retry" }
    ```
    你要重读的是"那几行"，不是整份。实测：盲改（`lines=[1,1]`，读的是旧内容）被拒，磁盘上第三方内容完好。

### C. 落盘后回读校验
- **主张**：写完不是"相信提供方"，而是把文件读回来与预期逐字节比对，不一致就结构化报错。
- **实测回执**：`"write_verify": { "level": "bytes", "bytes": 42 }`。
- **内置**：写回即结束，回执里没有等价字段（它信任 provider）。

### D. 四层寻址 + 断言 + 原子
| 能力 | 内置 `edit` | `aura_basetools_edit` |
| --- | --- | --- |
| 定位方式 | 只有字面文本 `old_string`（唯一匹配） | `target`（符号名）/ `lines`（行区间）/ `line_cue`（唯一词）/ `anchor`（记忆原文，容忍漂移）/ `near`（歧义行号提示） |
| 要读多少才能改 | 必须读到能拼出**精确字面**（因此常要整份读） | 知道符号名或行号即可，不必先把原文抄准 |
| 落位断言 | 无 | `expect`：断言该处"应该是什么"，对不上则整批失败 |
| 预演 | 无 | `dry_run`：只定位不落盘 |
| 多 hunk | 一次调用一处；多处就是多轮写盘，中途失败就是半成品 | 一次调用多 hunk，**任一不定位则磁盘完全不变** |
| 歧义 | 文本不唯一则报错 | `LOCATOR_CUE_AMBIGUOUS`（实测：`"value" appears on 2 lines`），另有 `near` 消歧 |
| 建新文件 | 用 `write`（会覆盖） | `create`：已存在则 `PATCH_EXISTS` 拒绝，绝不覆盖（实测）；整份新建/覆写见 `aura_basetools_write` |
| 回执 | 文本 | 结构化：`applied[]` 带 `line` / `tier:"symbol"` / `byNear` / `actual`（它实际找到的原文）/ `replaced` |

`actual` 那一栏值得单独说：回执会告诉你"我按这条线索找到的是这段原文" —— 落位错了当场看得见，
这是"改错地方"这类事故的第一道拦截。

### E. 读：按意图取景（上下文成本）
同一个真实文件（`src/locator-lab/struct-core.mjs`，**84,837 B / 1,848 行 / 204 个符号**）：

| 调用 | 回来多少 | 占比 |
| --- | --- | --- |
| 内置 `read`（契约就是返回文件内容） | 全文 1,848 行 ≈ 84.8 KB（行号前缀另计） | 100% |
| `aura basetools read --mode map` | 3,555 字符（符号目录，65 个符号带行号） | **4.2%** |
| `aura basetools read --mode digest` | 2,885 字符（只要接口签名） | **3.4%** |

七种取景：`map` / `digest` / `full` / `around` / `lines` / `search` / `changed`，外加 `auto` 自动选；
65 种源码扩展名有符号表（数字由引擎语言表决定并随版本增长，包内 README 自动渲染）
`changed` 模式可以用上次的令牌给出**差异**（内置 read 没有差异模式，重读就是整份）。

### F. 失败可见性（这是我们做这套工具的第一动机）
内置三件套的失败分两类：**报错的**（找不到 / 不唯一 / 版本变了）和**不报错的**（§1 的字节损伤）。
aura 把每次调用都变成一条结构化回执：`ok` / `code` / `error` / 可选的 `detail` / `next`，
MCP 面与 CLI 面同形。实测在这套工具上钉住的坏输入矩阵（6/6 都回包，服务不挂）：

| 输入 | 回执 |
| --- | --- |
| 参数名写错（`file` 而非 `file_path`） | `BAD_ARGS` + 一句话说明 |
| `mode` 写错 | `READ_BAD_MODE` + 全部合法值 |
| 文件不存在 | `FS_NOT_FOUND` |
| `hunks` 不是数组 | `BAD_ARGS` |
| 未知工具 | `UNKNOWN_TOOL` |
| 连续 5 次坏输入之后 | 正常调用仍然可用（服务没死） |

---

## 3. 该用哪个（分工，不是替代）

| 场景 | 用什么 | 为什么 |
| --- | --- | --- |
| 找代码 / 看接口 / 定位符号 | `aura_basetools_read`（`map`/`digest`/`around`/`search`） | 4% 上下文拿到符号目录，不用整份读 |
| 改已有文本文件 | `aura_basetools_edit` | 逐字节、区域闸门、回读校验、原子多 hunk |
| 看一眼上次读之后变了什么 | `aura_basetools_read --mode changed` | 内置没有差异模式 |
| **整份重写 / 生成新文件** | **`aura_basetools_write`** | 0.10.1 起与内置 `write` 对齐：整份新建/覆写、BOM 与既有行尾保留、落盘回读、失败自动回滚、`no_overwrite`；0.10.3 起覆写默认要求先读过这一版（`PATCH_UNOBSERVED`），`allow_unobserved` 才盲写；0.10.4 的 `eol: preserve` 可按 content 逐字节写 |
| **读图** | **内置 `read_image`** | aura 没有替代品 —— 所以**不要停用 `tool-fs`**，那会净损失能力 |
| 要原始字节窗口 / 超过一次回复的大窗口 | 内置 `read` | aura 有内容预算，超了会截 |
| 单 `\r`（老 Mac）行尾的文件 | 内置工具 | aura 明确拒绝并给替代方案（行号是跨层共享判据） |
| 二进制文件 | 都不行 | 两侧都拒绝 |

**建议的默认**：`aura_*` 主力，内置三件套补缺口；提示词里明确写“改文件优先 `aura_basetools_edit`
（批量替换用 `old` + `replace_all`），只有整份定稿/新建才用 `aura_basetools_write`；读图仍用内置工具”。

---

## 4. 边界与代价（诚实清单）

- 整份定稿用 `aura_basetools_write`；`aura_basetools_edit` 仍按区域寻址。`aura_basetools_write` 覆写默认要求先读，
  盲写要显式 `allow_unobserved`（回执标 `unverified_region`）；`aura_basetools_edit` 的严格闸
  （`require_observation`）默认关闭，开启后与内置 `Edit` 的 read-before-edit 同形。
- 单 `\r` 行尾不支持；二进制两侧都拒绝。
- **大于 256 KiB 的文件只记观测令牌、不存全文**：读后未变时回执不降级；读后又被外部改动时
  无法做区域级比对，回执带 `unverified_region`，闸门**放行而不误拒**（宁可少拦，不可误拦）。
- 陈旧闸门只在"经本工具观测过"的区域内生效；跨进程/跨机器的最后一道是写盘时的版本 CAS。
- 内置实现的行为**随宿主版本变化**：本文的数字是当前发行版上的实测，升级后应重跑 §7。
- aura 需要 Node ≥18；独立面（CLI/MCP）还需要一个可写目录放观测缓存（默认 `~/.aura`，可用 `AURA_CACHE_DIR` 改）。
- 内置三件套的提示词段是硬编码在发行包里的，**没有开关能关掉** —— 所以"优先用 aura"只能靠提示词措辞，别指望配置。

---

## 5. 采用数据（来自你自己的会话日志）

一条命令可复现（只读 `~/.dsh/sessions`，不写任何东西）：`node probes/adoption-stats.mjs [since]`

| 口径 | 会话数 | 用过 `aura_*` | 只用内置三件套 | 只用 aura |
| --- | --- | --- | --- | --- |
| 全部含工具调用的会话 | 78 | 35（45%） | 43 | 17 |
| **web profile 打上 aura 补丁之后**（`2026-09-21T07:26` 起） | 26 | **25（96%）** | 1 | 9 |

调用次数合计（同一份日志）：`aura_basetools_read` 456 + `aura_basetools_edit` 387 = **843**；
`read` 3344 + `edit` 3476 + `write` 703 = **7523**。

三点如实说明：

1. **调用总量不是覆盖率**。7523 次内置调用里，很大一块来自少数几个“批量建文件 / 别的项目根本不需要 aura”的
   会话（`write` 独占 703 次；这组数据采集时 aura 还没有整份写，0.10.1 的 `aura_basetools_write` 之后未重采）。
   问“遇到读写任务会不会想到 aura”，看的是覆盖率；问“省了多少上下文”，看的是 §1/§E 的那些单次对照。
2. 两个口径的差距（45% → 96%）主要是**时间**造成的：那 52 个更早的会话全在补丁之前（aura 还没进 profile，
   自然不可能被用到）。
   换句话说：工具在那儿不等于会被用，**补丁与提示词才是决定因素**。
3. 补丁后唯一没用 aura 的那个会话，是我刻意跑的**中性对照任务**（提示词里不提 aura，日志里只有
   `read×1 edit×1`）—— 它的作用就是量"不提会怎样"。提示词收紧后同一类任务：`aura_basetools_edit` 3/3、
   `aura_basetools_read` 2/3（琐碎任务）；结构性任务 `aura_basetools_read` 2/2（正确答出符号区间 `595-972`）。

> 数字会随你继续用而变：本次刷新时就比上一次多了 3 次 `write`、1 次 `aura_basetools_read`（都是这个会话自己产生的）。

---

## 6. 验收这套保证的套件（都在 `src/` 下，可复跑）

| 套件 | 结果 |
| --- | --- |
| `locator-lab/write-verify-test.mjs` | 42/42（写回 + 回读校验） |
| `locator-lab/stale-gate-test.mjs` | 49/49（区域闸门） |
| `locator-lab/byte-fidelity.mjs` | 94/94（字节保真） |
| `locator-lab/span-fidelity.mjs` | 95/95（寻址跨度） |
| `locator-lab/encoding-fidelity.mjs` | 32/32（编码/BOM/EOL） |
| `locator-lab/aura-read-schema-test.mjs` | 56/56 |
| `aura-standalone/test/standalone-test.mjs`（包内自带） | 42/42（含 MCP 坏输入矩阵） |

---

## 7. 自己复跑（十分钟）

```powershell
$d="$env:TEMP\aura-vs-builtin"; New-Item -ItemType Directory -Force $d | Out-Null
# 1) BOM 夹具与混合行尾夹具
[System.IO.File]::WriteAllBytes("$d\bom.js",      [byte[]](0xEF,0xBB,0xBF) + [System.Text.Encoding]::UTF8.GetBytes("const a = 1;`nconst b = 2;`n"))
[System.IO.File]::WriteAllBytes("$d\mixed.js",    [System.Text.Encoding]::UTF8.GetBytes("const a = 1;`r`nconst b = 2;`nconst c = 3;`nconst d = 4;`r`n"))
Copy-Item "$d\bom.js" "$d\bom.aura.js"; Copy-Item "$d\mixed.js" "$d\mixed.aura.js"
# 2) 用内置 read + edit 改 bom.js / mixed.js（各把 const b = 2; 改成 const b = 22;），再量字节
# 3) aura 那一侧：
$aura='<项目>\dist\aura-tools\bin\aura.mjs'; $env:AURA_CACHE_DIR="$d\cache"
node $aura basetools read --file "$d\bom.aura.js" --mode map
node $aura basetools edit --file "$d\bom.aura.js" --hunks '[{"anchor":"const b = 2;","replace":"const b = 22;"}]'
# 4) 量：字节数 / 前 3 字节 / CRLF 与 LF 计数（期望：内置 -2 B 且 BOM 消失、整份 CRLF→LF；aura +1 B 且只改一行）
```

---

## 8. 可以直接粘给别人/给 agent 的一段话

> 读写文件请优先用 `aura_basetools_read` / `aura_basetools_edit`：`aura_basetools_read` 按意图取景（`map` 符号目录 / `digest` 接口 /
> `around` 开窗 / `lines` / `search` / `changed` 差异），别整份读；`aura_basetools_edit` 按意图寻址
> （符号名 / 行号 / 唯一词 / 记忆原文）并**逐字节保真**（BOM 与每行行尾都不动）、改完**回读校验**、
> 你要改的区域在你读之后被别人动过时**结构化拒绝并告诉你重读哪几行**，多 hunk 一次原子落盘。
> 内置 `read` / `write` / `edit` 补缺口：**读图**仍只有内置工具有（`read_image` 无替代品）；
> 整份新建/覆写由 `aura_basetools_write` 覆盖（失败自动回滚、BOM 与行尾保留、`no_overwrite`），
> 批量替换由 `aura_basetools_edit` 的 `old` + `replace_all` 覆盖（次数变化会拒绝）。
> 已知边界：单 `\r` 行尾不支持；二进制不写；>256 KiB 只记令牌不存全文（读后又被外部改动时
> 闸门放行并标注 `unverified_region`）。
