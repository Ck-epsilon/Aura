# Codex CLI

Tested with `codex-cli 0.163.0-alpha.10.2` on Windows.

## Add the MCP server

Back up `~/.codex/config.toml` first, then:

```bash
codex mcp add aura-argus -- node E:/workspaces/aura-argus/src/cli.mjs mcp
```

After publishing, the same with npm:

```bash
codex mcp add aura-argus -- npx -y aura-argus mcp
```

Check it:

```bash
codex mcp list
codex mcp get aura-argus
```

Remove it with `codex mcp remove aura-argus`.

## Smoke test

```bash
codex exec -C E:/workspaces/aura-argus --skip-git-repo-check -s danger-full-access --json \
  "Use the aura-argus MCP server's search tool (not shell, not any other search) to answer: SearXNG 对 429 的冷却时间是多少秒？ Return the numeric seconds and the source URL."
```

Observed on 2026-10-21:

```json
{"type":"item.started","item":{"type":"mcp_tool_call","server":"aura-argus","tool":"search","arguments":{"question":"SearXNG 收到 HTTP 429 后的冷却时间是多少秒？…","maxSources":5}}}
{"type":"item.completed","item":{"type":"agent_message","text":"**3600 秒**（即 1 小时）。来源：https://docs.searxng.org/admin/settings/settings_search.html"}}
```

Codex exposes the server-qualified tool (`mcp_tool_call` with `server: "aura-argus"`, `tool: "search"`).
It does not require DSH, the provider adapter, or any API key.
