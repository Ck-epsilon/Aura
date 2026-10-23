# Claude Desktop

Claude Desktop supports stdio MCP servers. Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

Windows fallback if `npx` is not spawned correctly:

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

Restart Claude Desktop. The client namespaces the tools (for example `aura-argus__search`); the
server's `initialize.instructions` (when supported by the client) tell the model to prefer them.
Registry-only by default; the 360/Sogou fallback is not exposed through this MCP server.
