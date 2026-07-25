---
type: concept
title: Repository overview
description: What teleg-bridge is, which surfaces exist, and the runtime stack.
tags: [overview, surfaces, stack]
timestamp: 2026-07-24T16:00:00Z
---

# Repository overview

## Purpose

Make Telegram a practical control plane for Pi coding agents:

- Forward authorized private / group / channel messages into Pi as `[telegram]` turns.
- Share one bot across many Pi sessions without duplicate `getUpdates`.
- Route work by `@session`, declared capabilities (`INFO_REL.md`), or primary fallback.
- Recover **reply-to** parent text and media (local cache paths) so users need not re-send images.
- Send text, photos, videos, and documents back to Telegram.
- Keep queue + session state recoverable across crashes.

## Surfaces (pick the right one)

| Surface | Path | Polling | Tools | Audience |
|---|---|---|---|---|
| **Pi extension** | `src/index.ts` → `dist/` | Yes (owns lock) | Full toolset + slash cmds | Pi agent sessions |
| **Standalone MCP** | `mcp-server/index.js` | No | Same tools + `teleg_listen` / `teleg_reply` | omp, Claude Code, OpenCode, Kilo, … |
| **CLI** | `install.sh` → `teleg` | n/a | install / update / mcp wire (no DB open) | Host ops |

**Pi must load the extension only.** Dual-loading extension + MCP duplicates tool names. `deploy.sh` strips `teleg-bridge` from `~/.pi/agent/mcp.json`. `teleg mcp --app pi` refuses to write MCP into Pi and only prunes a stale entry. Use `teleg mcp --app omp|claude|…` for other apps.

If `teleg` is not on the machine yet, `./install.sh install` builds, deploys the extension, and installs the shim (see [automation](automation.md)).

## Package / build

| Item | Value |
|---|---|
| npm name | `teleg-bridge` |
| version | `1.0.3` (see `package.json`) |
| build | `npm run build` → `tsc` → `dist/` |
| test | `npm test` (build + `node --test`) |
| Node (Pi / MCP) | Prefer ≈**22.5+** (`node:sqlite`); filter in `suppress-sqlite-warning.ts` |
| Bun (omp) | `bun:sqlite` via `sqlite-driver` — no Node SQLite ExperimentalWarning |
| peer deps | `@earendil-works/pi-ai`, `pi-coding-agent`, `@sinclair/typebox` |

## This repo’s `INFO_REL.md`

```
capabilities: telegram-bridge, messaging, relay, routing
description: Multi-session Telegram bridge extension for Pi…
```

Other projects declare their own caps so the bridge can capability-route into them.

## Related

- [Architecture](architecture.md)
- [Modules](modules/index.md)
- [Actions](actions/index.md)
- [Runtime data](runtime/index.md)
