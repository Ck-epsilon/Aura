# Cursor

Cursor supports project-level and global MCP configuration.

Project: `.cursor/mcp.json` in the workspace. Global: `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "aura-argus": {
      "command": "npx",
      "args": ["-y", "aura-argus", "aura_argus_mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "aura-argus": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "aura-argus", "aura_argus_mcp"]
    }
  }
}
```

Restart Cursor or reload the MCP servers, then enable the `aura-argus` tools in the MCP panel.
The tools are `aura_argus_search`, `aura_argus_search_batch`, `aura_argus_fetch`, and `aura_argus_sources`; the client prefixes them. Legacy unprefixed names remain aliases.
