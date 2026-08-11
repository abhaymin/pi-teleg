---
okf_version: "0.1"
title: pi-teleg OpenWiki
description: Agent-oriented map of teleg-bridge — multi-bot Telegram↔Pi bridging, queue routing, relay, tools/actions, and hard invariants.
---

# pi-teleg / teleg-bridge

**Telegram bridge extension for Pi** (package `teleg-bridge` v1.0.3). Multi-bot, multi-session control plane: poll Telegram once per bot token, route into the right Pi session (direct `@session`, capability match, or primary), and send replies/media back.

Start here when you need repo context. Prefer this wiki over grepping blindly; then open the linked concept pages and the real source files they name.

## Mental model

```
Telegram User
      │  Bot API getUpdates
      ▼
PollingManager (one lock + worker per botId)
      │  poll-worker → media cache + INSERT message_queue (unassigned/pending)
      ▼
Router (primary handler + per-session drainTimer)
  ├── @sessionName        → assign to named live session (same bot)
  ├── capability match    → INFO_REL / caps registry
  ├── group stickiness    → last owner session
  └── primary fallback    → default session for bot
      │
      ▼
Authenticated HTTP relay  →  target Pi session  →  tools / MCP  →  Telegram reply
```

Runtime state lives under **`~/.pi/agent/`** (DB, config, locks, relay, media) — not in this git tree.

## Wiki map

| Area | Index |
|---|---|
| [Architecture](architecture.md) | Layers, polling→queue→route→relay, boundaries |
| [Overview](overview.md) | Purpose, surfaces (extension / MCP / CLI), stack |
| [Modules](modules/index.md) | `src/*`, MCP server roles |
| [Actions](actions/index.md) | Telegram cmds, Pi slash, tools, `teleg` CLI |
| [Runtime data](runtime/index.md) | Config JSON, SQLite, locks, media, env |
| [Reply context](runtime/reply-context.md) | Recover parent media on Telegram replies |
| [Plans](plans/index.md) | Multi-bot PLAN_ACTION vs shipped reality |
| [Automation](automation.md) | `install.sh` / `deploy.sh` / channels |
| [Gotchas](gotchas.md) | Polling lock, dual-load, reply media, orphans, SQLite warning |

**Pi:** native extension only (no teleg MCP). **Other apps:** standalone MCP via `teleg mcp --app …`. **Missing CLI?** `./install.sh install` builds + deploys (see [automation](automation.md)).

## Top-level on disk (scanned 2026-07-25)

| Path | Role |
|---|---|
| `src/` | TypeScript extension + poll worker (~9.6k LOC) |
| `src/sqlite-driver.ts` | Bun/Node-neutral SQLite open |
| `src/suppress-sqlite-warning.ts` | Drop Node SQLite `ExperimentalWarning` (Pi console) |
| `src/pi-sys-commands.ts` | Telegram → Pi system controls (model, think, tools, agent, orchestrate, …) |
| `src/orchestrator.ts` | Multi-session orchestration (delegates to sub-agents) |
| `dist/` | Compiled JS + `.d.ts` — what Pi loads |
| `mcp-server/` | Standalone stdio MCP (same tools; **no** polling) |
| `install.sh` | Git lifecycle CLI → `~/.local/bin/teleg` (build + deploy) |
| `deploy.sh` | Build + wire extension into Pi `settings.json`; strip MCP from Pi |
| `docs/` | Design notes (`PLAN_ACTION`, install, groups/channels) |
| `test/db.test.js` | SQLite tests (`npm test`) |
| `worker/` | Ops notes (e.g. polling0-fix) |
| `INFO_REL.md` | Capability declaration for *this* repo session |
| `TASKS.md` | Multi-bot phases marked **ALL COMPLETE** |
| `RELAY_UNASSIGNED_BUG.md` | Open reliability issue: orphaned `unknown` queue rows |
| `README.md` | Product documentation |
| `graphify-out/` | Code-graph artifacts (not runtime) |
| `openwiki/` | This wiki (OKF) |

**Absent / external:** live DB and bot tokens under `~/.pi/agent/` — never invent in-repo copies as canonical.

## How agents should use this

1. Start with [architecture](architecture.md) + [gotchas](gotchas.md) before changing polling, routing, or DB claims.
2. For a task, open the matching [modules](modules/index.md) or [actions](actions/index.md) page, then the named `.ts` / `.js` file.
3. Treat [`TASKS.md`](../TASKS.md) + source as “done”; [`docs/PLAN_ACTION.md`](../docs/PLAN_ACTION.md) checkboxes are a stale draft header.
4. Build with `npm run build` (`tsc` → `dist/`). Deploy to local Pi with `./deploy.sh` (restart Pi after). First-time host: `./install.sh install` also builds, deploys, and installs `teleg`.
