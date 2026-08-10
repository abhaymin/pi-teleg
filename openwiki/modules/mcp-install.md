---
type: concept
title: MCP install
description: install-mcp.sh — wires standalone MCP server into non-Pi clients.
tags: [modules, mcp, install]
timestamp: 2026-08-10T12:00:00Z
---

# MCP install (`install-mcp.sh`)

Wires the standalone MCP server (`mcp-server/index.js`) into third-party clients **without** touching Pi's extension or `mcp.json`.

```bash
npm run install:mcp
# or: ./install-mcp.sh
```

Target clients: Cursor, Claude Desktop, OpenCode, Kilo, custom paths. Use `teleg mcp --app <client> --write` for the same effect from the CLI.

**Never** use this for Pi — Pi loads the native extension only. See [gotchas — dual-load](../gotchas.md).
