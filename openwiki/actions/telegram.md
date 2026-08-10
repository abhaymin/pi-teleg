---
type: concept
title: Telegram chat commands
description: Authorized chat commands including Pi system controls (model, think, agent, …).
tags: [actions, telegram, commands, pi-sys]
timestamp: 2026-08-10T12:00:00Z
---

# Telegram chat commands

Handled in `src/index.ts` after allowlist checks (user and/or chat). Pi system controls live in `src/pi-sys-commands.ts`.

## Pi system commands (`/pi`)

Pi’s TUI-only slash commands (`/model`, `/settings`, …) do **not** run if sent as a normal user message. teleg binds ExtensionAPI equivalents so Telegram can drive the same session:

| Command | Purpose |
|---|---|
| `/pi` | Help for Pi system commands |
| `/model` | Show current model |
| `/models [query]` | List available / scoped models |
| `/model <provider/id\|id>` | Switch model (`pi.setModel`) |
| `/think` / `/think <level>` | Get/set thinking level |
| `/compact [instructions]` | Compact context (`ctx.compact`) |
| `/tools` / `/tools all` / `/tools set a b c` | Active tool set |
| `/cmds [query]` | List extension / skill / prompt commands |
| `/cmd <name> [args]` | Best-effort run of a listed command (agent-mediated; `sendUserMessage` cannot expand slash commands) |
| `/agent <task>` | Focused sub-task (uses sub-agent tools if present) |
| `/session` | Snapshot: model, thinking, tools, idle |
| `/new [kickoff]` | New session when command context exposes `newSession` |
| `/reload` | Reload extensions/skills when `reload` is available |
| `stop` | Abort turn / agent run |

## Bridge / ops commands

| Command | Purpose |
|---|---|
| `/start`, `/help` | Pair / help; first `/start` may seed allowlist |
| `/status` | Sessions, relay, queue, poller role |
| `/chatid` | Show chat/user IDs (group/channel setup) |
| `/queue [session]` | Queue for session or primary |
| `/health`, `/healthfull` | Connectivity / full diagnostic |
| `/teleg-fix-health [force]` | Repair DEGRADED health |
| `stop` / `/stop` | Abort active turn |
| `/teleg-dc` | Disconnect this session |
| `/teleg-dc-all` | Disconnect all sessions on this bot (DB kept) |
| `/teleg-clean-db` | Reset processing + purge old queue rows |
| `/teleg-remove-sessions` | Remove dead registry rows |
| `/teleg-reconcile` | Ghost eviction + primary re-elect |
| `/teleg-sessions` | List sessions / liveness |
| `/teleg-set-primary <name>` | Force primary |
| `/teleg-bots` | List configured bots |

Free-form messages (not commands) go through routing: `@session`, capability match, stickiness, primary. See [architecture](../architecture.md) and [gotchas](../gotchas.md).

Groups/channels: [`docs/GROUP_CHANNEL_SUPPORT.md`](../../docs/GROUP_CHANNEL_SUPPORT.md).
