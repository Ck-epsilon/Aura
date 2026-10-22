# aura-tools 0.6.16 —— 独立面也有 `targets`：CLI 与 MCP 补上「一次多个目标」

0.6.10 起 DSH 工具面（`aura_read` / `aura_edit` 两个壳）已经支持一次调用给多个目标，
但那时**只有 DSH 面**有 —— CLI（`aura read` / `aura edit`）与 MCP（`aura_read` / `aura_edit` 服务）
还是一次一个文件。后果是走 MCP 的宿主（Codex / Cursor / Zed …）拿不到这个形状。

用户裁定（2026-10-16，原话）：「**肯定要 cli 和 mcp 啊，做完再发版。这不对吧现在？aurabridge 本来应该就要包含。**」
⇒ 这一版把同一份契约补到另外两个面，三个面的参数形状与判据**一字不差**。

## 改了什么

| 面 | 形状 |
|---|---|
| CLI 读 | `aura read --targets '<JSON>'` 或 `--targets @spec.json`（spec 是 `[...]`，或 `{"targets": […], "dryRun": false}`） |
| CLI 写 | `aura edit --targets '<JSON>' \| @文件`，`--dry-run` 与 spec 里的 `dryRun` 都认 |
| MCP | 两个工具的 `inputSchema` 声明 `targets`（`array of object`），每项就是原来那套单目标参数 |

- **与单目标形状互斥**：`--file` / `file_path` 与 `targets` 同时给 ⇒ 参数面拒绝（CLI exit 1、MCP 回结构化错）。
  递进去的是 `file_path`，判的是引擎那**同一份** `assertReadTargets` / `assertEditTargets` —— 三个面不各写一份。
- **引擎位置单源**：CLI 与 MCP 都从 `lib/ops.mjs` 拿引擎绑定（`readManyWith` / `applyEditsToProvider`
  以及四个形状守卫），`bin/` 里不再各自 `import` 引擎 —— 否则「引擎在哪」就有了三个答案。
- **写侧仍是三阶段**：全量规划 → 全部可落才提交 → 逐文件回读校验；任一目标规划失败 ⇒ **一个字都不写**，
  汇总行明说 `no files were changed`。
- **单目标零回归**：12 个单目标调用的输出做成了逐字节黄金集（MT-J），改前/改后逐字节相同。

## 判据

`src/aura-standalone/test/standalone-test.mjs`：**83 → 155 条**（只增不减），新增 MT-G（多目标读：顺序=输入序、
一项失败不连坐、汇总行）/ MT-H（多目标写：真落盘、规划失败零写入、同文件合并、dryRun）/ MT-I（形状与边界：
互斥 exit 1、超 32 项、空数组、非法 JSON）/ MT-J（单目标黄金集，逐字节）/ MT-K（MCP 多目标）。

读数为两段成对证据：跑本版之前的代码 ⇒ `108 通过 / 48 失败`（MT-G/H/I/K 全红并点名）；本版 ⇒
`155 通过 / 0 失败`。变异反证：把「`--file` 递成 `file_path`」这一处停掉 ⇒ 5 条按名变红且变异下写真的落盘；
按字节还原后回绿。

## 一处闸内记账（不是判据改动）

新加的形状守卫让两个 bin 命中了普查的 S1 谓词（`assert…(`）—— 那条谓词的设计是「漏报比误报贵，
误报由豁免台账人工确认」（先例：`dsh/argv-shell.mjs`）。这两个文件是**产品入口**，不是套件；
它们的行为由闸内真跑的 `standalone-test.mjs` 以子进程方式覆盖。已在 `CENSUS_EXEMPT` 里逐条写明，
**判据、阈值、谓词、SUITES 一行未动**。

## 仍然没解决的

- **多目标采用率**：真实宿主里只量到 2 次（占文件工具调用 0.4%）。形状现在三个面都有了，
  但「模型会不会用」还是一条未闭合的线 —— 反驳条件写死为「真实任务窗里仍 ≈0 ⇒ 改形状，而不是再堆措辞」。
- **句柄化的真实回收率**仍不可测（只有类别上界：严格 97 / 宽松 107，分母 147）。
