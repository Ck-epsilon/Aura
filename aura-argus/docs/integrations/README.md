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
| [DSH](dsh.md) | provider + MCP | Tested; see README |

## After publishing

Until the npm package is published, use the local absolute path:

```bash
node E:/workspaces/aura-argus/src/cli.mjs mcp
```

After publishing:

```bash
npx -y aura-argus mcp
```

Windows clients that fail to spawn `npx` directly usually need:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "aura-argus", "mcp"] }
```

## What the agent gets

- `search` — one question → evidence passages + source URLs.
- `search_batch` — up to 20 questions → per-question results.
- `fetch` — one public URL → clean Markdown.
- `sources` — registry coverage.

Registry-only by default. `fallback` (360/Sogou) is opt-in and may be anti-bot blocked.
