# aura-basetools {{VERSION}}

Byte-exact file tools for coding agents: read by intent, edit by intent, and write whole files without corrupting bytes. One engine shared by a standalone CLI and an MCP server.

面向 coding agent 的逐字节文件工具：按意图读取、按意图编辑、整文件写入；CLI 与 MCP 共用同一套引擎。

---

## English

### What it is

`aura-basetools` is a Node.js (>=18) package with no runtime dependencies. It provides:

- **CLI** — `aura basetools <verb>`
- **MCP server** — five tools over stdio
- **No DSH requirement** — the DeepSeek Harness adapter is a separate optional package, `aura-basetools-dsh`

The engine is intentionally not a general file manager: it reads and edits UTF-8 text, preserves byte-level formatting, and refuses edits when the addressed region changed after the read that authorized them.

### Install

```bash
npm i -g aura-basetools@{{VERSION}}
aura --version
```

### CLI

```bash
aura basetools read  --file src/app.ts --mode map
aura basetools edit  --file src/app.ts --hunks '[{"target":"main","replace":"..."}]'
aura basetools write --file generated.ts --content @body.ts
aura basetools undo
aura basetools transactions
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
| `aura_basetools_read` | Intent-based views: `map`, `digest`, `full`, `around`, `lines`, `search`, `changed`, `auto` |
| `aura_basetools_edit` | Anchored multi-hunk edits; `old` + `replace_all`; optional transaction |
| `aura_basetools_write` | Whole-file create/overwrite with read-before-write and read-back verification |
| `aura_basetools_undo` | Undo the latest or a named write transaction |
| `aura_basetools_transactions` | List write transactions for the current workspace |

The older tool names (`aura_read`, `aura_edit`, `aura_write`, ...) are no longer exposed by MCP or DSH.

### Guarantees and verification

The 0.13.0 release gate was run on Windows and reported:

| Suite | Result |
|---|---|
| `standalone` | 228 / 0 |
| `range-bytes` | 218 / 218 |
| `write` | 66 / 66 |
| `argument-surface` | 18 / 18 |
| `split-package` | 75 / 75 |
| `upgrade` | 94 / 94 |

The guarantees the tests exercise:

- UTF-8 decoding is fatal; invalid UTF-8 is rejected rather than silently replaced.
- Leading BOM and per-line endings are preserved.
- Writes go through a temporary file, flush, rename, and a byte-for-byte read-back check.
- A region-level stale gate and an optional strict read-before-write policy reject edits whose basis changed.
- Write transactions record original bytes, support rollback/undo, and reject undo when a file changed after the transaction.
- Multi-target writes plan first; if planning fails, no file is written.

Linux CI is configured but was not executed on the local Windows machine used for the 0.13.0 gate. Do not read that sentence as a Linux pass.

### Boundaries

- UTF-8 text only; binary editing and encoding conversion are out of scope.
- Image reading is not provided; keep the host's image tool.
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
- **MCP 服务**：stdio 上的五个工具
- **不依赖 DSH**：DeepSeek Harness 适配器是独立的可选包 `aura-basetools-dsh`

它不是通用文件管理器：只处理 UTF-8 文本，保留字节级格式；如果被寻址区域在“授权读取”之后被改动，编辑会被拒绝。

### 安装

```bash
npm i -g aura-basetools@{{VERSION}}
aura --version
```

### CLI

```bash
aura basetools read  --file src/app.ts --mode map
aura basetools edit  --file src/app.ts --hunks '[{"target":"main","replace":"..."}]'
aura basetools write --file generated.ts --content @body.ts
aura basetools undo
aura basetools transactions
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
| `aura_basetools_read` | `map` / `digest` / `full` / `around` / `lines` / `search` / `changed` / `auto` |
| `aura_basetools_edit` | 多 hunk 锚点编辑；`old` + `replace_all`；可选事务 |
| `aura_basetools_write` | 整文件新建/覆写；覆写默认要求先读，写后回读校验 |
| `aura_basetools_undo` | 撤销最近一次或指定写事务 |
| `aura_basetools_transactions` | 列出当前工作区写事务 |

旧工具名（`aura_read`、`aura_edit`、`aura_write` 等）不再由 MCP/DSH 暴露。

### 保证与验证

0.13.0 发布闸在 Windows 上实跑，读数：

| 套件 | 结果 |
|---|---|
| `standalone` | 228 / 0 |
| `range-bytes` | 218 / 218 |
| `write` | 66 / 66 |
| `argument-surface` | 18 / 18 |
| `split-package` | 75 / 75 |
| `upgrade` | 94 / 94 |

这些套件实际检查：

- UTF-8 解码使用 fatal 模式；非法字节被拒绝，不做静默替换。
- 保留前导 BOM 与逐行行尾。
- 写入走同目录临时文件、flush、rename，并做逐字节回读校验。
- 区域级陈旧闸门；可选的严格“先读后写”策略会拒绝依据已变化的编辑。
- 写事务记录原始字节，支持回滚/undo；事务后文件又被改过时拒绝 undo。
- 多目标写入先全量规划；规划失败则一个文件都不写。

Linux CI 已配置，但本机 0.13.0 发布闸是 Windows 实跑；不能据此声称 Linux 已通过。

### 边界

- 只支持 UTF-8 文本；不编辑二进制，不做编码转换。
- 不提供图片读取；保留宿主的图片工具。
- 不做根目录约束或 capability sandbox；工具作用于调用方给出的路径。
- DSH 安装后需要重启宿主；MCP 客户端升级后需要重新拉取 `tools/list`。
- 不遵守协议的并发写者仍可能绕开工作区锁；陈旧闸门与写后校验降低风险，但不会消除该冲突。

### 许可证

MIT.
