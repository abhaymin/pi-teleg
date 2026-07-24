---
type: concept
title: Telegram chat commands
description: Authorized chat commands handled by handleAuthorizedTelegramMessage.
tags: [actions, telegram, commands]
timestamp: 2026-07-24T16:00:00Z
---

# Telegram chat commands

Handled in `src/index.ts` after allowlist checks (user and/or chat).

| Command | Purpose |
|---|---|
| `/start`, `/help` | Pair / help; first `/start` may seed allowlist |
| `/status` | Sessions, relay, queue, poller role |
| `/chatid` | Show chat/user IDs (group/channel setup) |
| `/queue [session]` | Queue for session or primary |
| `/health`, `/healthfull` | Connectivity / full diagnostic |
| `/compact` | Compact memory |
| `stop` / `/stop` | Abort active turn |
| `/teleg-dc` | Disconnect this session |
| `/teleg-dc-all` | Disconnect all sessions on this bot (DB kept) |
| `/teleg-clean-db` | Reset processing + purge old queue rows |
| `/teleg-remove-sessions` | Remove dead registry rows |
| `/teleg-reconcile` | Ghost eviction + primary re-elect |
| `/teleg-sessions` | List sessions / liveness |
| `/teleg-set-primary <name>` | Force primary |
| `/teleg-bots` | List configured bots |

Free-form messages (not commands) go through routing: `@session`, capability match, stickiness, primary. See [architecture](../architecture.md) and [gotchas](../gotchas.md) for orphan risk.

Groups/channels: also see [`docs/GROUP_CHANNEL_SUPPORT.md`](../../docs/GROUP_CHANNEL_SUPPORT.md) (`allowedChatIds`).
