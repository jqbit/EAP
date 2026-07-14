# eap-signal-shrink

MCP stdio proxy. Wrap any MCP server; compress `description` (and similar) prose fields with EAP-Signal boundaries. Adapted from TLDR `tldr-shrink` (MIT).

## Use

```jsonc
{
  "mcpServers": {
    "fs-shrunk": {
      "command": "node",
      "args": [
        "/path/to/EAP/layers/eap-signal/mcp-servers/eap-signal-shrink/index.mjs",
        "npx", "@modelcontextprotocol/server-filesystem", "/some/path"
      ]
    }
  }
}
```

Or via installer: `node bin/eap-install.mjs --with-mcp-shrink="npx @modelcontextprotocol/server-filesystem /path"`.

## Env

| Var | Default | Meaning |
|---|---|---|
| `EAP_SIGNAL_SHRINK_FIELDS` | `description` | Comma-separated fields to compress |
| `EAP_SIGNAL_SHRINK_DEBUG` | `0` | `1` = log deltas to stderr |

## Does not touch

Request bodies; `tools/call` results; identifiers/URLs/paths/code tokens inside prose.

## License

MIT.
