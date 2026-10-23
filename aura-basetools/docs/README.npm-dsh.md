# aura-basetools-dsh {{VERSION}}

DeepSeek Harness adapter for `aura-basetools`. The core package is DSH-free; this package adds the `aura_basetools_*` tools and the hook executor.

`aura-basetools` 的 DeepSeek Harness 适配器。核心包不依赖 DSH；本包只添加 `aura_basetools_*` 工具与钩子执行器。

---

## English

### Install

```bash
npm i aura-basetools-dsh@{{VERSION}}
# or:
dsh plugin --profile web add aura-basetools-dsh@{{VERSION}}
```

Requires a DSH host that provides `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-shell`, and `@deepseek-ai/schemastery`. These peers are declared optional so a plain npm install does not try to fetch private packages; a missing peer fails loudly when the module is imported.

### Tools

- `aura_basetools_read`
- `aura_basetools_edit`
- `aura_basetools_write`
- `aura_basetools_undo`
- `aura_basetools_transactions`

Built-in DSH `read` / `write` / `edit` / `read_image` remain enabled. Restart the DSH host after installation so the new tool names are registered.

### Hook executor

The package ships `dsh/argv-shell.mjs` and `dsh/hook-inproc.mjs`. Point the profile's `polaris-hooks-shell` entry at the installed copy:

```yaml
        - id: polaris-hooks-shell
          name: '<profile>/node_modules/aura-basetools-dsh/dsh/argv-shell.mjs'
```

### Boundary

This package is only the DSH adapter. Core behavior, CLI, MCP, byte-fidelity guarantees, and transaction semantics are documented and tested in `aura-basetools`.

---

## 中文

### 安装

```bash
npm i aura-basetools-dsh@{{VERSION}}
# 或：
dsh plugin --profile web add aura-basetools-dsh@{{VERSION}}
```

需要 DSH 宿主提供 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-shell`、`@deepseek-ai/schemastery`。这些 peer 标为 optional，避免普通 npm 安装去解析私有包；缺 peer 时在 import 阶段明确失败。

### 工具

- `aura_basetools_read`
- `aura_basetools_edit`
- `aura_basetools_write`
- `aura_basetools_undo`
- `aura_basetools_transactions`

DSH 内置的 `read` / `write` / `edit` / `read_image` 保持启用。安装后需要重启 DSH 宿主，新工具名才会注册。

### 钩子执行器

包内包含 `dsh/argv-shell.mjs` 与 `dsh/hook-inproc.mjs`。profile 中 `polaris-hooks-shell` 应指向安装副本：

```yaml
        - id: polaris-hooks-shell
          name: '<profile>/node_modules/aura-basetools-dsh/dsh/argv-shell.mjs'
```

### 边界

本包只负责 DSH 适配。核心行为、CLI、MCP、字节保真保证与事务语义由 `aura-basetools` 提供并测试。
