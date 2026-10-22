# aura 工具 0.3.0 —— 一个包，两条路进：DSH 插件 **或** 独立 CLI / MCP

**日期**：2026-09-22 ｜ **包**：`aura-tools@0.3.0`（源码树里 `dsh-tool-aura-read` / `dsh-tool-patch` 同步到 0.3.0）
**这一版的重点**：**不再要求对方装 DSH**。同一个包，Codex / Claude Code / Cursor / 任何能跑命令的 agent
都能用；Windows / macOS / Linux 同一套命令（纯 Node ≥18，无原生依赖）。

## 两条安装路径

**① 别的 agent（不需要 DSH）**

```bash
codex mcp add aura -- npx -y aura-tools mcp        # MCP 服务，一次配置长期可用
claude mcp add aura -- npx -y aura-tools mcp
# Cursor / Zed / 其它 MCP 客户端：command = npx, args = ["-y","aura-tools","mcp"]
npx -y aura-tools read --file src/app.ts --mode map   # 或者直接用 CLI
```

**② DSH 用户**

```bash
dsh plugin --profile web add ./aura-tools-0.3.0.tgz   # 或 npm 名 / git / 目录
```
包内 `cordis.patch.yml` 用 **patch 相对路径**（`./aura-read/index.js`），加载器把它转成包内 file URL
（`dsh-app-boot/README.md:59`）⇒ **不再有开发机绝对路径**，换机器/换平台都成立。内置
`read`/`write`/`edit`/`read_image` 一个都没停用（只加不减）。

## 为做到这点，先做了一次**判据提取**（不是复制）

写路径的保真、陈旧闸门、回读校验原本住在 DSH 壳 `aura-edit/index.js` 里——那是适配器，顶部 import 了
`@deepseek-ai/dsh-tools`，独立服务没法复用，只能抄一份（而"两套判据"本仓库已经因此抓出过一次 BOM
接缝缺陷）。这一版把它们**机械搬进引擎** `locator-lab/write-path.mjs`：

| | 之前 | 现在 |
|---|---|---|
| 判据位置 | DSH 壳（`aura-edit/index.js`，973 行） | 引擎 `locator-lab/write-path.mjs`；壳 **582 行** |
| 搬运方式 | — | `tools/_extract-write-path.mjs` 用**引擎自己的 `outline()`** 取符号跨度搬（不手抄），搬完即删 |
| 观测缓存 | 进程内 `Map` 写死 | **可替换的存储缝** `setObservationStore()`：DSH 用内存，CLI/MCP 用落盘（`~/.aura/observations.json`，`AURA_CACHE_DIR` 可改） |
| 编排 | 只有 DSH 一份 | 新增 `applyEditToProvider(provider, …)`：读→规划→闸门→逐字节写(CAS)→回读→刷新观测，两面前端共用 |

## 证据

- **DSH 侧 11 个套件全绿**（提取前后逐条对比）：`write-verify 42/42` · `stale-gate 49/49` ·
  `byte-fidelity 94/94` · `encoding 32/32` · `span 95/95` · `policy-arg 12/12` · `aura-read 50/50` ·
  `aura-edit 41/41` · `struct 28/28` · `align 12/12` · `corpus 44`；`aura-read-schema-test 56/56`。
- **独立面验收 33/33**（`aura-standalone/test/standalone-test.mjs`，随包发布，跑的是**包里那份**）：
  - 字节保真 10 种形态（BOM / 双 BOM / CRLF / 混合行尾两向 / 无尾换行 / 中文 / 尾 BOM …）改第 4 行后
    **除目标行外逐字节不变**；
  - **陈旧闸门**：读完之后那一行被别人改过 ⇒ `PATCH_STALE_REGION` 拒绝且磁盘保留外部改动；没被动过的
    区域照常可编辑（不误杀）；
  - `create` 撞已存在文件 ⇒ 拒绝（不再有"零改动成功"）；`dry_run` 不落盘；
  - **MCP 往返**：`initialize`（回显协议版本）/ `tools/list`（两个工具）/ `tools/call` 读与改都落盘。

## 跨平台是怎么保证的（不是声明，是守卫）

打包脚本对**要发出去的每个文件**做机械检查，命中即中止：真盘符路径（`X:\…`）、`process.platform`，
引擎文件另外禁止直接 `node:fs`（文件读写只能经 provider）。独立面只用
`node:fs` / `node:os` / `node:path`，缓存目录走 `os.homedir()`。

## 还没做的（诚实）

- **DSH 壳仍在用它自己那份编排**（`registerTools` 里的执行体，带沙箱策略与 `fs/observed` 事件）；
  与独立面**共用同一批判据**（规划、闸门、BOM、回读），但编排尚未合并到 `applyEditToProvider`。
  合并是后续项，不是缺口：DSH 那边多出的两件事（策略第 5 参、观测事件）本来就只有它有。
- 单 `\r` 行尾不支持；二进制两侧都拒绝；**>256 KiB 的文件不进观测缓存**（此时回执带
  `unverified_region`，闸门放行而不误拒）。
- 本机 provider 的版本指纹是 `size:mtimeMs:头尾各 4KB 的哈希`（不整份读）；与 DSH 提供方的
  `dev:ino:size:mtimeNs:ctimeNs` 形状不同，但都是"写时比对、不符即拒"的 CAS。
