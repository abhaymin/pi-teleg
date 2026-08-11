---
type: concept
title: Orchestrate (multi-session)
description: /orchestrate command for delegating tasks to sub-agent sessions.
tags: [actions, orchestrate, multi-session]
timestamp: 2026-08-10T12:00:00Z
---

# Orchestrate (`/orchestrate`)

Multi-session task delegation. The host session acts as an **orchestrator**, dispatching sub-tasks to other Pi sessions (sub-agents) via the relay system, then aggregating results.

Works from **both** Telegram (`/orchestrate <task>`) and Pi directly (`/orchestrate <task>`).

## Usage

```
/orchestrate <task>
```

### Targeting specific sessions

Use `@sessionName` in the task to target specific sub-agents:

```
/orchestrate download this video and summarize it @data-scrapper and @marketapp
```

### No target specified

Broadcasts to all alive sessions for the bot.

## Architecture

```
Telegram / Pi UI
      │
      ▼
/orchestrate <task>
      │
      ▼
Host session (orchestrator)
      │
      ├─── relay ──► @sessionA (sub-agent)
      ├─── relay ──► @sessionB (sub-agent)
      └─── relay ──► @sessionC (sub-agent)
              │
              ▼
      Aggregated result back to caller
```

Sub-agents are other Pi sessions — they may or may not have teleg loaded. They process relay commands via their HTTP relay server.

## State persistence

Orchestration state is stored in `~/.pi/agent/tmp/teleg-orchestrator/bot-{id}.json`.

## Implementation

- `src/orchestrator.ts` — core orchestration logic
- `src/pi-sys-commands.ts` — Telegram handler
- `src/index.ts` — Pi command registration

## Related

- [Relay](../modules/relay-sessions.md) — inter-session HTTP relay
- [Telegram commands](telegram.md) — `/orchestrate` in Telegram context
- [Pi commands](pi-slash.md) — `/orchestrate` in Pi context
