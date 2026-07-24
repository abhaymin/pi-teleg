---
type: concept
title: Config and database
description: BotContext resolution, global/project config v2, and SQLite persistence APIs.
tags: [modules, config, db, sqlite]
timestamp: 2026-07-24T16:00:00Z
---

# Config & DB

## `src/sqlite-driver.ts`

Runtime-neutral open: Node `node:sqlite` vs Bun `bun:sqlite`. **All** DB opens go through `openSqlite` — never import `node:sqlite` directly in shared code (omp/Bun vs Pi/Node).

## `src/config.ts`

| Export (selected) | Role |
|---|---|
| `resolveBotContext` / `resolveBotContextInteractive` | Bind session to a bot |
| `resolveFromBotId`, `listConfiguredBots` | Multi-bot ops |
| `saveLastUpdateId`, `loadBotConfig` | Per-bot offset / entry |
| `updateAllowedUsers`, `detectSplitDb` | Allowlist + split-DB warn |
| `getDefaultBotId`, `setDefaultBotId` | Global default |

**Resolution order:** `TELEG_BOT_TOKEN` → `TELEG_BOT_ID` → project `.pi/teleg.json` → global `defaultBotId` → legacy v1 migrate to v2 `bots` map.

## `src/db.ts`

- `SCHEMA_VERSION = 6` (v2 bot_id → v3 reply_to → v4 attachments/poll_id → v5 relay repair → v6 outbound attachments).
- WAL + `busy_timeout=5000` + `synchronous=NORMAL`.
- Tables: `message_queue`, `download_queue`, `relay_sessions`, `relay_history`, `pubsub`, `outbound_messages`, `poll_answers`.

| API group | Examples |
|---|---|
| Queue | `enqueueMessage`, `claimNextMessage*`, `completeMessage`, `failMessage` |
| Relay | `registerRelaySession`, `heartbeatRelaySession`, `setPrimary` |
| Recovery | `runStartupRecovery` |
| Outbound / polls | `recordOutboundMessage` (optional attachments JSON), `recordPollAnswer` |
| Reply chain | `lookupMessageForChain`, `buildReplyChainText`, `collectReplyContextAttachments`, `formatChainLine` |
| Pubsub | `publish`, `subscribe` |

**Invariant:** unique `(bot_id, chat_id, message_id)` dedupes Telegram redeliveries; almost all ops take `botId`.

## Related

- [Runtime data](../runtime/index.md)
- [Polling](polling.md)
