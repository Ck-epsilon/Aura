# aura-tools 0.6.1

一个包，两条路进 —— 读文件按意图取景、改文件按意图寻址，**逐字节保真**（前导 BOM 与每行行尾都不动），
改完还会**读回来验一遍**；区域在你读之后被别人动过时**结构化拒绝**，而不是静默覆盖。

## 一、一键安装（推荐：人双击，agent 一条命令）

交付包（zip）里除了本包，还有 `一键安装.cmd`（Windows 双击）、`一键安装.command`（macOS 双击）与 `install.mjs`：

```bash
node install.mjs --yes --json     # 人 / 脚本 / agent 都用这一条：非交互、幂等、结果机器可读
node install.mjs --dry-run        # 先看它要动哪些文件
node install.mjs --uninstall      # 撤销（只撤它自己加的东西）
```

它把包复制到 `~/.aura/pkg`、生成 `aura` / `aura-mcp`、把 MCP 服务器注册进检测到的 agent 配置
（Codex / Claude Code / Cursor，每个文件先备份成 `*.bak-aura-<时间戳>`），最后跑一次真自检。
只有手上**只有 .tgz、没有解压目录**时，才需要下面的手工路线。

## 二、手工路线（Codex / Claude Code / Cursor / 任何能跑命令的 agent）—— 不需要 DSH

拿到的是 .tgz 时（未发布到 npm）——先装一次，两个 bin 就上 PATH：

```bash
npm i -g ./aura-tools-0.6.1.tgz      # 或者项目内 npm i ./aura-tools-0.6.1.tgz（之后用 npx aura …）
```

然后接进你的 agent：

```bash
# Codex（子命令形状已实测：codex mcp add <NAME> -- <COMMAND>…）
codex mcp add aura -- aura mcp

# Claude Code（同形：claude mcp add [options] <name> -- <command> [args…]）
claude mcp add aura -- aura mcp
```

其它 MCP 客户端（Cursor / Zed / …）写进自己的配置，形状都一样：

```json
{ "mcpServers": { "aura": { "command": "aura", "args": ["mcp"] } } }
```

没做全局安装时：把 command 换成 npx、args 换成 ["aura", "mcp"]（项目内安装）。
**已发布到 npm** 时才有 npx -y aura-tools … 这种写法（本包当前按 tarball 分发）。

CLI 也可以直接调：

```bash
aura read  --file src/app.ts --mode map
aura edit  --file src/app.ts --hunks '[{"target":"main","replace":"…"}]'
aura --help
```

Windows / macOS / Linux 同一套命令（纯 Node，≥18，无原生依赖）。

**先读后改**：`aura read` 会给出一个 `version` 令牌；`aura edit` 会核对"这块区域在你读之后有没有被改过"。
观测缓存默认落在 `~/.aura/observations.json`，可用环境变量 `AURA_CACHE_DIR` 改（CI 里建议设成临时目录）。

## 三、DSH 用户（DeepSeek Harness）

```bash
dsh plugin --profile web add ./aura-tools-0.6.1.tgz
# 或：dsh plugin --profile web add aura-tools          （已发布到 npm）
# 或：dsh plugin --profile web add github:<user>/<repo>
```

装完重启 dsh。内置 `read` / `write` / `edit` / `read_image` **一个都没停用**：只加不减。

验证与回滚：

```bash
dsh --profile web --dump-config | grep tool-aura     # 应看到两行
dsh plugin --profile web remove aura-tools
```

## 它带来什么

- `aura_read`（MCP 工具 / `aura read`）：`map` 符号目录、`digest` 接口、`full`、`around`、`lines`、
七种取景；65 种源码扩展名的符号表（由引擎语言表决定）；未索引扩展名自动退到整份内容。
- `aura_edit`（MCP 工具 / `aura edit`）：`target` / `lines` / `line_cue` / `anchor` 四层寻址，
  `expect` 断言、`dry_run` 预演、多 hunk 原子（任一失败则磁盘不变）、逐字节写回、
  区域级新鲜度闸门、落盘后整份回读校验。

## 已知边界

单 `\r`（老 Mac）行尾不支持（行号是跨层共享判据）；二进制文件两侧都拒绝；超大文件（>256 KiB）不进
观测缓存（此时回执带 `unverified_region`，闸门放行而不误拒）。
