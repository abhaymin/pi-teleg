---
type: concept
title: MCP server
description: Standalone stdio MCP mirroring extension tools for non-Pi clients.
tags: [modules, mcp, omp]
timestamp: 2026-07-24T16:00:00Z
---

# MCP server — `mcp-server/index.js`

Plain Node stdio JSON-RPC MCP. Uses `better-sqlite3` and the **same** `~/.pi/agent/teleg-bridge.{json,db}` as the extension.

## Parity

| | Extension | MCP |
|---|---|---|
| Tools | Full set | Same names + `teleg_listen`, `teleg_reply` |
| Polling | Yes | **No** |
| `teleg-attach` | Queue onto active turn | Send immediately |

## When to use

- omp, Claude Code, OpenCode, Kilo Code, etc. via `teleg mcp --app … --write`.
- **Not** alongside the Pi extension in the same Pi session.

## Related

- [Overview — surfaces](../overview.md)
- [Actions — tools](../actions/tools.md)
- [Automation](../automation.md)
