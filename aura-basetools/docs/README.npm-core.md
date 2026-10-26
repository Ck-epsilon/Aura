# aura-basetools {{VERSION}}

Byte-exact file tools for coding agents: read by intent, edit by address, and write whole files without corrupting bytes. One engine shared by a standalone CLI and an MCP server.

面向 coding agent 的逐字节文件工具：按意图读取、按地址编辑、整文件写入；CLI 与 MCP 共用同一套引擎。

---

## English

### What it is

`aura-basetools` is a Node.js (>=18) package with no runtime dependencies. It provides:

- **CLI** — `aura basetools <verb>`
- **MCP server** — two tools over stdio
- **No DSH requirement** — the DeepSeek Harness adapter is a separate optional package, `aura-basetools-dsh`

The engine is intentionally not a general file manager: it reads and writes text (UTF-8 plus detected legacy encodings), directories and images, preserves byte-level formatting, and refuses writes when the addressed entity/region changed after the evidence that authorized them.

### Install

```bash
npm i -g aura-basetools@{{VERSION}}
aura --version
```

### CLI

```bash
aura basetools read  --file src/app.ts --mode map
aura basetools read  --file src/app.ts --entity function:main
aura basetools apply --file src/app.ts --entity function:main --op rename --new-name run
aura basetools apply --file src/app.ts --op patch --hunks '[{"target":"main","replace":"..."}]'
aura basetools mcp
```

Top-level legacy verbs (`aura read`, `aura edit`, `aura write`, `aura mcp`, ...) are rejected with exit code 1 and `shape: "CLI_NAMESPACE_REQUIRED"`. Migration is mechanical: insert `basetools` after `aura`.

### MCP

Installed globally:

```json
{
  "mcpServers": {
    "aura": {
      "command": "aura",
      "args": ["basetools", "mcp"]
    }
  }
}
```

Without a global install, the one-line form is:

```bash
npx -y --package aura-basetools aura basetools mcp
```

Equivalent client configuration:

```json
{
  "mcpServers": {
    "aura": {
      "command": "npx",
      "args": ["-y", "--package", "aura-basetools", "aura", "basetools", "mcp"]
    }
  }
}
```

The server exposes:

| Tool | Purpose |
|---|---|
| `aura_basetools_read` | Text views (`map`, `digest`, `full`, `around`, `lines`, `search`, `changed`, `probe`, `auto`), `entity` (definition + references + evidence), directory map/repository grep, and image metadata/content |
| `aura_basetools_apply` | Entity-first writes (`replace-body`, `rename`) plus `patch`, `write`, `convert`, `tx` operations; evidence-guarded, atomic, read-back verified |

0.14.0 removed the public `undo` / `transactions` tools (0 uses in 642 sessions); failure rollback remains internal and automatic.

The older tool names (`aura_read`, `aura_edit`, `aura_write`, ...) are no longer exposed by MCP or DSH.

### Why aura-basetools

Compared with the DSH built-in `dsh-tool-fs` tools, the differences are deliberate:

- **Byte fidelity, not text normalization.** Leading BOM and per-line endings are preserved; only the addressed bytes change. The byte-fidelity suite asserts this with 102 checks.
- **Read by intent, not whole file.** `map` / `digest` / `lines` / `search` return the structural slice you ask for; the customer comparison measured about 1/24 of the context for the same file.
- **Edits refuse stale bases.** A region-level gate rejects an edit when the addressed region changed after the read that authorized it, and points at the lines to re-read; `expect` makes the intended text explicit.
- **Writes are verified, not assumed.** Every write goes through a temp file, flush, rename, and a byte-for-byte read-back; multi-target edits plan first and write nothing if any target fails.
- **Changes can prove themselves.** `edit` / `write` accept an explicit `verify` command; a non-zero exit or timeout rolls the transaction back and returns the command output plus the rollback state. No auto-discovery of repo scripts.
- **MCP clients get a server-side nudge.** `initialize.instructions` asks the client to prefer `aura_basetools_*` (read + apply) and to use `apply` with `op=tx` for multi-call changes; whether it is honored is the client's choice.
- **Changes can span calls, and concurrent changes merge.** `apply` with `op=tx, action=begin` opens a transaction; writes with `transaction` append to it; commit three-way-merges non-overlapping external edits, refuses overlapping ones (`TX_CONFLICT`) without writing, and can run `verify`; rollback restores all of them.
- **Addressing is structural.** `target` / `lines` / `old` / `expect` / handles replace "copy the literal text exactly"; failure receipts include ready-to-use retry addresses.
- **The core is DSH-free.** `aura-basetools` has no runtime dependencies and no DSH imports; the DSH adapter is a separate optional package.

Scope note: the byte-level comparison is against the DSH built-in tools. Other clients may already preserve BOM/CRLF (for example ZCode's built-in `Edit`); do not generalize this comparison to every editor.

### Verification

The release gate is the source of truth:

```bash
node build/release-check.mjs
```

It runs the full suite set, range fixtures, packaged tests, split-package install, and consistency checks. Exact counts and pass/fail are recorded in the GitHub release notes; they are not copied here, so they cannot go stale.

### Boundaries

- Text read/write supports UTF-8 and detected legacy encodings (GB18030, Shift_JIS, EUC-KR, Big5, UTF-16, windows-125x); `apply op=convert` normalizes encoding/EOL/BOM. Binary editing is not supported.
- Images are read as metadata plus image content where the host/MCP client supports it; repository-wide search is `read` with a directory path and `search`.
- No root-directory confinement or capability sandbox: the tool operates on the paths it is given.
- DSH requires a host restart after installation; MCP clients must refresh `tools/list` after upgrading.
- A non-cooperating writer can still race outside the workspace lock; the stale gate and post-write verification reduce, but do not eliminate, that class of conflict.

### License

MIT.

---

## 中文

### 是什么

`aura-basetools` 是一个 Node.js（>=18）包，运行时零依赖，提供：

- **CLI**：`aura basetools <verb>`
- **MCP 服务**：stdio 上的两个工具
- **不依赖 DSH**：DeepSeek Harness 适配器是独立可选包 `aura-basetools-dsh`

它不是通用文件管理器：读/写 UTF-8 与探测到的旧编码文本、目录与图片，保留字节级格式；被寻址的实体/区域在授权证据之后发生变化时，写入会被拒绝。

### 安装

```bash
npm i -g aura-basetools@{{VERSION}}
aura --version
```

### CLI

```bash
aura basetools read  --file src/app.ts --mode map
aura basetools read  --file src/app.ts --entity function:main
aura basetools apply --file src/app.ts --entity function:main --op rename --new-name run
aura basetools apply --file src/app.ts --op patch --hunks '[{"target":"main","replace":"..."}]'
aura basetools mcp
```

顶层旧动词（`aura read`、`aura edit`、`aura write`、`aura mcp` 等）不再执行；会返回 exit 1 和 `shape: "CLI_NAMESPACE_REQUIRED"`。迁移方式是在 `aura` 后插入 `basetools`。

### MCP

全局安装后：

```json
{
  "mcpServers": {
    "aura": {
      "command": "aura",
      "args": ["basetools", "mcp"]
    }
  }
}
```

未全局安装时，一行命令是：

```bash
npx -y --package aura-basetools aura basetools mcp
```

等价的客户端配置：

```json
{
  "mcpServers": {
    "aura": {
      "command": "npx",
      "args": ["-y", "--package", "aura-basetools", "aura", "basetools", "mcp"]
    }
  }
}
```

工具标识：

| 工具 | 作用 |
|---|---|
| `aura_basetools_read` | 文本取景（`map` / `digest` / `full` / `around` / `lines` / `search` / `changed` / `probe` / `auto`）、`entity`（定义 + 引用 + 证据）、目录地图/仓库 grep、图片元数据/内容 |
| `aura_basetools_apply` | 实体优先写（`replace-body` / `rename`）+ `patch` / `write` / `convert` / `tx` 操作；证据校验、原子写、回读验证 |

0.14.0 移除了公开 `undo` / `transactions`（642 个会话中 0 次使用）；失败回滚仍是内部自动行为。

旧工具名（`aura_read`、`aura_edit`、`aura_write` 等）不再由 MCP/DSH 暴露。

### 为什么是 aura-basetools

与 DSH 内置 `dsh-tool-fs` 相比，差异是刻意设计的：

- **字节保真，不做文本归一化。** 保留前导 BOM 与逐行行尾，只改被寻址的字节；字节保真套件用 102 条断言守着。
- **按意图读，不读整份。** `map` / `digest` / `lines` / `search` 只返回你要的结构切片；客户版对照实测同一文件上下文约 1/24。
- **依据过期就拒绝。** 区域级陈旧闸门在“授权读取之后该区域被改过”时拒绝，并指出重读哪几行；`expect` 让目标原文显式化。
- **写完要验，不靠相信。** 每次写盘走临时文件、flush、rename，再做逐字节回读；多目标先全量规划，任一失败则一个字节都不写。
- **变更可以自证。** `edit` / `write` 接受显式 `verify` 命令；非零退出或超时会把整个事务回滚，回执带命令输出与回滚状态。不自动发现仓库脚本。
- **变更可以跨调用，也可以并发合并。** `apply` 的 `op=tx, action=begin` 开事务；带 `transaction` 的写追加；commit 对外部非重叠改动做三方合并，重叠则 `TX_CONFLICT` 且零写入，可带 `verify`；rollback 恢复全部。
- **寻址是结构化的。** `target` / `lines` / `old` / `expect` / 句柄替代“把原文一字不差抄对”；失败回执带可直接用的重试地址。
- **核心不依赖 DSH。** `aura-basetools` 零运行时依赖、无 DSH import；DSH 适配器是独立可选包。

范围说明：字节级对照的对象是 DSH 内置工具；其他客户端可能本来就保留 BOM/CRLF（例如 ZCode 内置 `Edit`），不要把该对照泛化到所有编辑器。

### 验证

发布闸是唯一事实源：

```bash
node build/release-check.mjs
```

它跑完整套件、三套靶场、包内验收、拆包安装与一致性检查。本次发布的精确读数与通过/失败记录在 GitHub Release notes 里，本文不手抄，避免过期。

### 边界

- 文本读写支持 UTF-8 与探测到的旧编码（GB18030 / Shift_JIS / EUC-KR / Big5 / UTF-16 / windows-125x）；`apply op=convert` 处理编码/行尾/BOM。不编辑二进制。
- 图片读取返回元数据，并在宿主/MCP 客户端支持时附带图片内容；仓库级搜索用 `read` 传目录 + `search`。
- 不做根目录约束或 capability sandbox；工具作用于调用方给出的路径。
- DSH 安装后需要重启宿主；MCP 客户端升级后需要重新拉取 `tools/list`。
- 不遵守协议的并发写者仍可能绕开工作区锁；陈旧闸门与写后校验降低风险，但不会消除该冲突。

### 许可证

MIT.
