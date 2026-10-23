# ZCode

ZCode supports first-party MCP through `~/.zcode/cli/config.json` under `mcp.servers`. The file
originally contained only `plugins` and `hooks`; a missing `mcp` key meant "not configured", not
"unsupported". Add `mcp` alongside the existing keys.

## MCP config

```json
{
  "mcp": {
    "servers": {
      "aura-argus": {
        "type": "stdio",
        "command": "E:\\software\\nodejs\\node.exe",
        "args": ["E:\\workspaces\\aura-argus\\src\\cli.mjs", "aura_argus_mcp"],
        "timeoutMs": 60000
      }
    }
  }
}
```

- Use `node` + an absolute path until the package is published. After publishing:
  ```json
  { "type": "stdio", "command": "npx", "args": ["-y", "aura-argus", "aura_argus_mcp"], "timeoutMs": 60000 }
  ```
- Windows `npx` fallback: `"command": "cmd", "args": ["/c", "npx", "-y", "aura-argus", "aura_argus_mcp"]`.
- `timeoutMs: 60000` is recommended. `aura_argus_search_batch` can take tens of seconds; 30000 may cut it.
- Restart ZCode (or start a new app session) after editing; the config is read at startup.

## Status

2026-10-21: `mcp.servers.aura-argus` was added to `~/.zcode/cli/config.json`, but the running
ZCode process started before that edit. No `aura-argus` MCP child process or log entry was observed,
so **a ZCode restart is still required** to load it. Verify after restart by asking for the MCP
tools, or by checking that a `node .../cli.mjs aura_argus_mcp` child process is alive.

The tools are `aura_argus_search`, `aura_argus_search_batch`, `aura_argus_fetch`, and `aura_argus_sources`; ZCode namespaces them. Legacy names remain aliases.

## CLI + skill fallback

If the MCP server cannot be loaded, use the CLI from ZCode's Bash tool:

```bash
node E:/workspaces/aura-argus/src/cli.mjs aura_argus_search "Node.js 怎么用 http 模块创建服务器？" --json
```

After publishing:

```bash
npx -y aura-argus aura_argus_search "Node.js 怎么用 http 模块创建服务器？" --json
```

Parse `evidence[].passages[].text` and cite `evidence[].url`. `mode: "none"` means the question
is outside the registry; do not invent URLs.

A local skill is installed at `~/.zcode/skills/aura-argus/SKILL.md` (versioned here as
`docs/integrations/zcode-skill.md`). It is additive: no global config or hooks are changed.
Start a new ZCode session to load it.
