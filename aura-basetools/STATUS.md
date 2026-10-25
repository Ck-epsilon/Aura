# aura-basetools 状态说明与提交注意事项

> 当前版本：**0.21.0（已发布到 npm；安装只走 npm）**
> 发布提交：本地 `d31e58c`（本检出没有 remote，尚未推送 / 打 tag）
> 工作树：干净；最近一次全量闸 `node build/release-check.mjs` **exit 0**
> npm：`aura-basetools@0.21.0`、`aura-basetools-dsh@0.21.0` 已发布（registry.npmjs.org）
> GitHub Release：**未发布** —— 本检出无 `origin`；需在 monorepo 检出里推送并建 Release

---

## 1. 一句话状态

`aura-basetools` 已具备可直接替代内置文本 `Read` / `Edit` / `Write` 的读写能力：三个入口
（MCP / DSH / CLI）共用同一份字节保真引擎，文本读写、整份写、`replace_all`、严格新鲜度、
并发观测缓存和失败回滚回执都已落地并有回归测试。安装只走 npm
（`npx` / `npm i -g` / `dsh plugin`）；自定义安装器与交付 zip 已在 0.13.2 移除。

---

## 2. 当前公开接口

### 2.1 工具标识（MCP / DSH / capabilities）

| 工具标识 | 作用 |
|---|---|
| `aura_basetools_read` | 按意图取景：`map` / `digest` / `full` / `around` / `lines` / `search` / `changed` / `auto` |
| `aura_basetools_edit` | 按地址编辑；`old` + `replace_all`；0.14.0 起无 intent / 公开事务面 |
| `aura_basetools_write` | 整文件新建/覆写；BOM/行尾保留；覆写默认要求先读 |

旧工具名 `aura_read` / `aura_edit` / `aura_write` / `aura_undo` / `aura_transactions`
**不再作为 MCP/DSH API 暴露**。历史会话日志与 `failure-corpus.json` 仍保留旧名；
`failure-replay` 等分析件同时识别旧名与新名。

### 2.2 CLI

统一使用 **`aura basetools <verb>`**：

```bash
aura basetools read  --file src/app.ts --mode map
aura basetools edit  --file src/app.ts --hunks '[...]'
aura basetools write --file new.ts --content @body.ts
aura basetools mcp
aura basetools doctor
aura basetools capabilities
```

- 顶层 `aura read` / `edit` / `write` / `mcp` / `doctor` /
  `capabilities` **不再作为别名执行**：返回 exit 1、`shape:"CLI_NAMESPACE_REQUIRED"`，
  不会执行写操作。
- `aura --help` / `aura --version` 仍在顶层。
- 包名 `aura-basetools`、bin 名 `aura` / `aura-mcp`、源码目录名不变。
- MCP 客户端配置：`args: ["basetools", "mcp"]`；
  npx 形式：`npx -y --package aura-basetools aura basetools mcp`。

---

## 3. 最近完成的关键变更

- **0.20.0（已发布）**：MCP `initialize.instructions`（优先 aura + tx）；DSH/Codex/ZCode/Hermes 旧工具名清理；
  Windows 观测缓存 rename 重试（6 并发不再丢条目）。GitHub Actions run `40091182890` 四平台全绿。
- **0.19.0（已发布）**：三平台全量闸对齐。`.gitattributes` 固定 LF（除故意 CRLF 夹具）；源码探针归一 CRLF；
  大小写敏感 FS / POSIX inode 复用 / 8.3 短路径 / 慢 runner 地板标定逐项修正。
  GitHub Actions run `40082103753`：Windows / Ubuntu / macOS 15 / macOS 26 **四格全绿**。
- **0.18.0（已发布）**：跨调用事务的并发合并（非重叠行改动 `git merge-file`；冲突 `TX_CONFLICT` 零写入）。
- **0.17.0（已发布）**：MCP 事务面（`aura_basetools_tx` + edit/write 的 `transaction`）。
- **0.16.0（已发布）**：跨调用事务。`tx begin` / `tx commit [--verify]` / `tx rollback` / `tx status`；
  `edit/write --tx <id>` 多次追加；commit 前 afterVersion 校验（`TX_STALE`），verify 失败整事务回滚。
  新套件 `tx-session` 14 项。
- **0.15.0（已发布）**：写后验证闭环。`edit` / `write` 接受显式 `verify`（CLI `--verify`、MCP `verify`）；
  非零退出/超时 ⇒ 事务自动回滚，回执 `PATCH_VERIFY_FAILED` + `verification` + `rollback`。
  不自动发现/执行仓库脚本；单/多目标/write 三条路共用；新套件 `verify-edit` 17 项。
- **0.14.0（已发布）**：按 642 会话采用率做减法，只删采用率为 0 的两项：`intent` 模糊地址
  （0 次，-755 行，套件 89→88）与公开 `undo`/`transactions`（0 次，MCP 5→3，内部事务日志
  只保留失败回滚）。`handle`(1)/`multi-read`(8)/`changed`(15)/`digest`(37)/`around`(106)/
  `edit --create`(78) 采用率非零，留待 0.15。
- **0.13.3（已发布）**：npm README 去掉手抄的过期闸读数、加中英双语 Why；`encoding-refusal`
  的 E3 改为源码静态守卫（闸可在并发会话下运行）；`which-tools` 与 `adoption-stats --stream`
  改为流式（512 MB）；CI 保留跨平台子集 + Node 18/20 冒烟，全量闸改为手动 workflow
  （GitHub runner 平台债列为 0.14.0）。
- **0.13.2（已发布）**：安装只走 npm。移除 `install.mjs`、双击壳、交付 zip、自定义 manifest 与
  升级/回滚命令；`npx ... aura mcp` 旧指引修正为 `aura basetools mcp`。
- **2026-10-24（0.13.0 后，未发版）**：`target` 整行区间的剩余越界形状。
  - 行内**非符号**内容（`import` / 指令 / 尾随调用 / 嵌套声明）以前仍会被整行替换吃掉；
    现在 `LOCATOR_LINE_SHARED` 拒绝并给出 `shared:{line,side,text}` 证据。
  - 多行声明头（`export function\nalpha()`）改为从声明起点替换，不再留下悬空前缀；
    C 家族把返回类型留在上一行时（`static int\nalpha`）明确拒绝。
  - Lisp 的 `(ns alpha.core)` 不再把下一行 `(defn …)` 的 `(` 当体：namespace 跨度从 1-4
    修为 1-1，`target=alpha` 不会再连函数一起删。
  - `single-line-target` 扩到 28 条；`terminator-scan` 的黄金摘要因 `startLine` 口径变更重钉
    （整表 diff 只有 10 行 `startLine` 前移，手写意图 pin 未动）；`lang-coverage` 235/235。
- **0.11.0**：参数面静默语义修复。
  - CLI/MCP/`targets` 元素未知参数拒绝，不再把 `--dryrun` 当合法调用真写盘。
  - 压缩 JS 共享行 `target` → `LOCATOR_LINE_SHARED`；lone CR 文件 `target`/`lines` →
    `LOCATOR_LONE_CR`。
  - 多目标回滚后回执按最终磁盘重建：`applied:0`、`landed:false`、`landed_paths:[]`、
    `rolled_back:true`；`rollback` 不依赖 `--transaction`。
  - 单/多目标读共用 `normalizeReadRequest`；并发观测缓存改锁 + read-merge-write；
    MCP `initialize` 不再回显不存在的协议版本。
  - CI 增加 Linux Node 22 全量闸与 Node 18/20 冒烟；跳过套件显示 `⏭`，关键套件跳过即红。
- **0.12.0**：MCP/DSH 工具标识统一为 `aura_basetools_*`。
- **0.13.0**：CLI 子命令统一为 `aura basetools <verb>`；顶层旧动词拒绝并给迁移提示。

---

## 4. 验证状态

最近一次全量闸（0.20.0，MCP instructions + 并发观测修复后）：

```bash
node build/make-bundle.mjs --pack
node build/release-check.mjs    # exit 0
```

关键读数：

| 套件 | 结果 |
|---|---|
| `standalone` | 216 / 0 |
| `write` | 61 / 61 |
| `range-bytes` | 218 / 218 |
| `multi-read` | 64 / 64 |
| `public-surface` | 42 / 42 |
| `split-package` | 75 / 75 |
| `post-publish` | 24 / 24 |
| `failure-replay` | 15 / 15 |

其他事实：

- `dist/npm/aura-basetools` 与 `dist/npm/aura-basetools-dsh` 版本都是 `0.20.0`（已发布）。
- 闸内实跑套件 90 件；`src↔dist` 24 个运行时文件逐字节一致。
- `installed-package` 在本机有 0.13.1 安装时跑 19/19；没有安装时显示 `⏭`（跳过），不再记 ✅。
- CI 工作流配置了 Linux + Node 22 全量闸和 Node 18/20 冒烟；**本机是 Windows，Linux runner 尚未实际执行过**。
  （实际运行的 monorepo workflow 目前只跑 3 个 OS 的子集；这是已知缺口。）

---

## 5. 已知边界与未完成

- **图片读取不在范围内**：`read_image` 仍只能用内置工具。
- **DSH 需要重启宿主**：工具模块在宿主启动时导入，改名后必须重启才会加载新名字。
- **MCP 客户端需要重新拉取 `tools/list`**：旧工具名不再存在。
- **已发布**：npm `aura-basetools@0.20.0` / `aura-basetools-dsh@0.20.0` 与 GitHub Release `aura-basetools-v0.20.0`；0.20.0 加 MCP instructions 与客户端清理，0.19.0 三平台全绿，0.18.0 并发合并，0.17.0 MCP 事务，0.16.0 跨调用事务，0.15.0 写后验证；不再做使用率减法。0.14.0 只删了采用率为 0 的 `intent` 与公开 `undo`/`transactions`；`handle`(1)/`multi-read`(8)/`changed`(15)/`digest`(37)/`around`(106)/`edit --create`(78) 保留。
- **安装只走 npm（0.13.2）**：自定义 `install.mjs`、交付 zip、manifest 与升级/回滚命令已移除；`~/.aura/pkg` 旧安装不再由本项目维护，改用 `npm i -g aura-basetools`。
- **历史分析件**：`probes/`、`failure-corpus.json`、旧版本 CHANGELOG 与
  `docs/aura-tools-0.*.md` 中的旧工具名是历史数据，不应批量改写；需要读取历史日志的分析件
  应同时识别旧名与新名。
- **平台覆盖**：本机 Windows（Node 24）与 **macOS 15/26（GitHub-hosted）全量闸通过**；
  Windows/Ubuntu runner 仍有套件失败，单独记录，不阻塞 macOS 目标。
- **CI 全量闸仍是 report-only**：手动 workflow `.github/workflows/aura-basetools-full-gate.yml`；
  CI 的阻塞项是跨平台子集 + Node 18/20 冒烟。

## 5.1 绝对路径检查

- **npm 发布产物**：`dist/npm/aura-basetools` 与 `dist/npm/aura-basetools-dsh` 严格扫描为 **0 个绝对路径**。
- **仓库源码中的历史证据**：仍有 34 处 / 14 个文件包含 `C:\Users\...`、`E:\workspaces\...`、`/Users/...` 或 `file:///...`，集中在 `docs/待办.md`、`probes/`、`failure-corpus.json`、`fixtures/README.md`、旧版 README 与旧分析记录。
- 这些是冻结的历史证据/旧安装说明，不进入 npm 包；按“不改历史语料”的规则保留。若要求整个仓库零绝对路径，需要单独清理并重钉历史夹具，不能把它当成当前版本的发布产物检查。

---

## 6. 提交前检查清单

按顺序执行；每一步都以实际输出为准，不凭记忆。

1. **确认工作树**
   ```bash
   git status --short
   ```
   只包含本次预期修改；不把 `dist/`、`node_modules/`、临时日志带进提交。

2. **确认版本**
   - `src/aura-read/package.json` 与 `src/aura-edit/package.json` 版本必须一致。
   - 版本变更同步写入 `docs/CHANGELOG.md` 顶部条目与 README（若涉及公开接口/行为）。
   - 破坏性变更（工具名、CLI 命名空间、默认安全语义）升 minor；纯修复升 patch。

3. **新增/修改测试**
   - 新套件必须登记到 `build/release-check.mjs` 的 `SUITES`。
   - 安全/契约类套件同时加入 `CRITICAL_SUITES`，跳过时闸必须变红。
   - 新文件必须被 CENSUS 扫到且归属明确（登记 / 闸内实跑 / 豁免理由）。
   - 先写能复现 bug 的断言，再改实现；禁止把当前错误输出写成黄金期望。

4. **构建**
   ```bash
   node build/make-bundle.mjs --pack
   ```
   该命令会重建 `dist/`、拆分 npm 双包、生成 `dist/capabilities.json`。
   `dist/` 是派生目录（已在 `.gitignore`），不要手改、不要提交。

5. **语法检查**
   ```bash
   node --check <改动过的 .mjs/.js>
   ```

6. **全量闸**
   ```bash
   node build/release-check.mjs
   ```
   要求：exit 0；关键套件没有 `⏭`；新增套件读数不是 0/0。
   如果只有环境依赖型套件显示 `⏭`，可以接受；但要在交付说明里点名。

7. **提交**
   ```bash
   git add -A
   git commit -m "Release X.Y.Z: <一句话变更>"
   ```
   只做本地提交。除非用户明确授权，不执行 `git push`、`npm publish`、`npm install -g`。

8. **提交后**
   ```bash
   git status --short
   git log --oneline -1
   ```
   工作树应为空；记录提交哈希与闸读数。

---

## 7. 提交注意事项（容易踩的坑）

### 7.1 命名与兼容

- 工具标识是 `aura_basetools_*`；CLI 是 `aura basetools <verb>`。
  **不要**在新增文档、测试、提示词里恢复 `aura_read` / `aura_edit` 或顶层 `aura read`。
- 历史日志、冻结夹具、旧版本文档保留旧名是**有意**的；只有需要解析历史日志的代码才加别名，
  不要把历史文件本身改名。
- DSH 插件模块名 `dsh-tool-aura-edit`、包名 `aura-basetools-dsh` 是内部/包标识，不是工具 API。

### 7.2 版本与产物

- 两个壳的 `package.json` 版本必须一起改；`make-split-packages` 会拒绝不一致。
- `dist/`、`*.tgz`、`*.zip` 都是派生物；提交源码 + 构建脚本 + 测试，不提交产物。
- 发布清单、`dist/capabilities.json`、README 的版本由构建生成，不要手抄。

### 7.3 测试与闸门

- 跳过 ≠ 通过：看到 `0/0 通过（已跳过）` 时确认它在 `CRITICAL_SUITES` 之外。
- 不要为了提高读数删断言、放宽 `stale-gate` / `require-observation` / `write_verify`。
- 契约确实变化时，更新旧断言并在提交说明里写清“为什么旧期望不再成立”；
  不要只改期望值让它变绿。
- 测试里的观测缓存必须指向临时 `AURA_CACHE_DIR`，不要写真实 `~/.aura`。
- 跨进程测试（并发、锁、观测缓存）至少要覆盖“两个进程”和“外部改动后仍拒绝”两个方向。

### 7.4 行尾与仓库机制

- Git 会提示 `LF will be replaced by CRLF`；这是仓库换行策略，不要为了消警告批量转码。
- 修改文件后不要顺手格式化整个文件；保持最小 diff，避免把无关行带进提交。
- 提交前跑 `git diff --check`，避免空白错误。

### 7.5 发布边界

- **默认只做本地提交。** push、npm publish、全局安装、修改用户 `~/.dsh` 配置都必须有明确授权。
- 改名属于破坏性变更：发布说明要写清旧名不再可用、DSH 需重启、MCP 客户端需重新拉取工具列表。
- 发布后验证用 `build/post-publish-check.mjs`；本地打包验证不能替代 registry 验证。

---

## 8. 常用命令速查

```bash
# 构建 + 全量闸
node build/make-bundle.mjs --pack
node build/release-check.mjs

# 单套件
node src/aura-standalone/test/standalone-test.mjs
node src/aura-standalone/test/argument-surface-test.mjs
node src/locator-lab/multi-read-test.mjs
node src/locator-lab/failure-replay.mjs

# CLI 自检
aura basetools --help
aura basetools doctor --json
aura basetools capabilities --pretty

# 本地产物版本
node -e "console.log(require('./dist/npm/aura-basetools/package.json').version)"
```
