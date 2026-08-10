---
okf_version: "0.1"
title: Modules index
description: Source modules under src/ and the standalone MCP server.
---

# Modules

| Page | Paths | Role |
|---|---|---|
| [Extension entry](extension.md) | `src/index.ts` | Pi extension: commands, tools, drain, Telegram turns |
| [Config & DB](config-db.md) | `config.ts`, `db.ts`, `sqlite-driver.ts`, `suppress-sqlite-warning.ts` | BotContext, SQLite schema/API, Node warning filter |
| [Polling](polling.md) | `polling-manager.ts`, `poll-worker.ts` | Lock, worker thread, persist |
| [Relay & sessions](relay-sessions.md) | `relay.ts`, `session-registry.ts`, `session-config.ts`, `capabilities.ts` | HTTP relay, liveness, caps |
| [MCP server](mcp.md) | `mcp-server/index.js` | Stdio tools for non-Pi clients |
| [MCP install](mcp-install.md) | `install-mcp.sh` | Wire MCP into Cursor / Claude / IDE / CLI (skip Pi) |

Approx sizes (LOC): `index.ts` ~3.0k · `db.ts` ~1.6k · MCP ~1.5k · others &lt;700 each.

## Related

- [Architecture](../architecture.md)
- [Actions](../actions/index.md)
