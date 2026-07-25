---
type: concept
title: MCP server
description: Standalone stdio MCP mirroring extension tools for non-Pi clients.
tags: [modules, mcp, omp]
timestamp: 2026-07-24T16:00:00Z
---

# MCP server — `mcp-server/index.js`

Plain Node stdio JSON-RPC MCP. Uses built-in `node:sqlite` (same as Pi) and the **same** `~/.pi/agent/teleg-bridge.{json,db}` as the extension. Imports `dist/suppress-sqlite-warning.js` first so Node’s SQLite `ExperimentalWarning` does not leak to the host console (see [gotchas](../gotchas.md)).

## Parity

| | Extension | MCP |
|---|---|---|
| Tools | Full set | Same names + `teleg_listen`, `teleg_reply` |
| Polling | Yes | **No** |
| `teleg-attach` | Queue onto active turn | Send immediately |
| Reply-to media (inbound) | Live + drain turns | `teleg_listen` merges `reply_context` + parent paths |
| Outbound media record | Yes (schema v6) | Yes — send_photo/video/document + attach via `recordOutboundMedia` |

Parent media **download/backfill** still runs in the poll worker (usually Pi). MCP reads the shared DB afterward.

## When to use

- omp, Claude Code, OpenCode, Kilo Code, etc. via `teleg mcp --app … --write`.
- **Not** alongside the Pi extension in the same Pi session.

## Related

- [Overview — surfaces](../overview.md)
- [Actions — tools](../actions/tools.md)
- [Automation](../automation.md)
