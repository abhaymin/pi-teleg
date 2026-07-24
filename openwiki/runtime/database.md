---
type: concept
title: SQLite database
description: Schema version, tables, and coordination role of teleg-bridge.db.
tags: [runtime, sqlite, queue]
timestamp: 2026-07-24T16:00:00Z
---

# SQLite database

Default: `~/.pi/agent/teleg-bridge.db`. Pragmas: WAL, `busy_timeout=5000`, `synchronous=NORMAL`. `user_version = 6`.

## Tables

| Table | Role |
|---|---|
| `message_queue` | Inbound Telegram work (pending → processing → completed/failed); `attachments` JSON for local media |
| `download_queue` | Download jobs |
| `relay_sessions` | Live session rows + primary |
| `relay_history` | Historical relay events |
| `pubsub` | Cross-session notifications |
| `outbound_messages` | Sent messages for reply-chain reconstruction; v6+ `attachments` for bot-sent media paths |
| `poll_answers` | Poll vote records |

## `message_queue` highlights

`bot_id`, `chat_id`, `message_id`, `reply_to_message_id`, `text`, `session_id`, `session_name`, `status`, `source`, `attachments` (JSON paths), `poll_id`.

Unique on `(bot_id, chat_id, message_id)`.

Worker inserts as `unassigned` / `unknown` / `pending`. Claim APIs and drainTimer promote to a real session. Reply parents may be backfilled as `status='completed'`, `session_name='_reply_context'` when media is recovered from a nested `reply_to_message`.

## Reply-chain helpers (`src/db.ts`)

- `lookupMessageForChain` — text + attachments from incoming or outbound
- `buildReplyChainText` / `formatChainLine` — human-readable chain with referenced media paths
- `collectReplyContextAttachments` — unique local paths for the agent to open

## Related

- [Modules — db](../modules/config-db.md)
- [Gotchas — reply media](../gotchas.md)
