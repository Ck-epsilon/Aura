# Hermes

Tested with `Hermes Agent v0.21.3 (2026.9.14)` on Windows.

## Add the MCP server

Back up `%LOCALAPPDATA%\hermes\config.yaml` first. `hermes mcp add` asks which tools to enable
(interactive); pipe `Y` for a non-interactive run:

```powershell
"Y" | hermes mcp add aura-argus --command node --args E:/workspaces/aura-argus/src/cli.mjs aura_argus_mcp
```

After publishing:

```powershell
"Y" | hermes mcp add aura-argus --command npx --args -y aura-argus aura_argus_mcp
```

Check it:

```bash
hermes mcp list
hermes mcp test aura-argus
```

Observed on 2026-10-21:

```
✓ Connected (1937ms)
✓ Tools discovered: 4
  aura_argus_search / aura_argus_search_batch / aura_argus_fetch / aura_argus_sources
```

Remove it with `hermes mcp remove aura-argus`.

## Smoke test

```bash
hermes -z "Use the aura-argus MCP server's search tool (not shell, not any other search) to answer: SearXNG 对 429 的冷却时间是多少秒？ Return the numeric seconds and the source URL."
```

The response explicitly reported using the `aura-argus` MCP `search` tool and returned
**3600 秒** with the official URL. Start a new Hermes session after adding the server.
