# Cursor

Cursor supports project-level and global MCP configuration.

Project: `.cursor/mcp.json` in the workspace. Global: `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "aura-argus": {
      "command": "npx",
      "args": ["-y", "aura-argus", "mcp"]
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
      "args": ["/c", "npx", "-y", "aura-argus", "mcp"]
    }
  }
}
```

Restart Cursor or reload the MCP servers, then enable the `aura-argus` tools in the MCP panel.
The tools are `search`, `search_batch`, `fetch`, and `sources`; the client prefixes them.
