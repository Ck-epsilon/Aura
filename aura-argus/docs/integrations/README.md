# Agent integrations

AuraArgus is one local engine with four plugs. Pick the one your agent already speaks.

| Agent | Surface | Status |
|---|---|---|
| [Codex CLI](codex.md) | MCP stdio | Tested 2026-10-21 (0.163.0-alpha.10.2) |
| [Hermes](hermes.md) | MCP stdio | Tested 2026-10-21 (0.21.3) |
| [ZCode](zcode.md) | MCP stdio + CLI/skill | Config supported via `mcp.servers`; restart pending |
| [Claude Desktop](claude-desktop.md) | MCP stdio | Standard config; client smoke pending |
| [Cursor](cursor.md) | MCP stdio | Standard config; client smoke pending |
| [Generic shell agent](generic-cli.md) | CLI + JSON | Universal |
| [Generic HTTP agent](generic-http.md) | HTTP + OpenAPI | Universal |
| [JS client](js-client.md) | `aura-argus/client` | Node 20+ / browser |
| [DSH](dsh.md) | provider + MCP | Tested; see README |

## After publishing

Until the npm package is published, use the local absolute path:

```bash
node E:/workspaces/aura-argus/src/cli.mjs aura_argus_mcp
```

After publishing:

```bash
npx -y aura-argus aura_argus_mcp
```

Windows clients that fail to spawn `npx` directly usually need:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "aura-argus", "aura_argus_mcp"] }
```

## What the agent gets

- `aura_argus_search` — one question → evidence passages + source URLs.
- `aura_argus_search_batch` — up to 20 questions → per-question results.
- `aura_argus_fetch` — one public URL → clean Markdown.
- `aura_argus_sources` — registry coverage.

Official sources first; CLI/MCP/HTTP default `fallback=auto`. Legacy tool names remain aliases.
