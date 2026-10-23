# DSH

DSH has two integration layers. Use either or both:

## Provider adapter (replaces the engine behind DSH's web tools)

`adapters/dsh/index.mjs` registers `aura-argus` / `aura-argus-http`. DSH keeps its existing
`web_search` / `web_fetch` tool contract (1–4 queries, merged sources, snippets).

The profile patch lives at `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`; see the main
README for the exact insert. Verify with:

```bash
node eval/verify-dsh.mjs --live   # 9/9
```

## MCP server (full AuraArgus contract)

The same patch can insert `mcp-aura-argus` (`@deepseek-ai/dsh-mcp-client`) pointing at
`node <repo>/src/cli.mjs aura_argus_mcp`. Then DSH sessions get:

```
mcp__aura-argus__aura_argus_search
mcp__aura-argus__aura_argus_search_batch
mcp__aura-argus__aura_argus_fetch
mcp__aura-argus__aura_argus_sources
```

The MCP client injects the server's `initialize.instructions` as a `mcp:aura-argus`
system-prompt section. To force the native tools, disable `tool-web` in the patch; keep it as a
fallback if you prefer the two-tool coexistence.

DSH is optional: the same MCP server and CLI work with Codex, Hermes, Claude Desktop, Cursor, and
any shell/HTTP agent.
