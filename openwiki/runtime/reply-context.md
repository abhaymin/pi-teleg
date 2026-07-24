---
type: concept
title: Reply context media
description: How reply-to Telegram messages recover parent text and local media so users need not re-send images.
tags: [reply, media, attachments, chain]
timestamp: 2026-07-25T00:45:00Z
---

# Reply context media

When a Telegram user **replies** to an earlier message (especially a photo/document), the bridge must surface that parent content to the agent — including local file paths — so the user does not re-upload the same media.

## Flow

```
User sends image
  → poll-worker downloadMedia → ~/.pi/agent/tmp/teleg-media/{botId}/
  → message_queue.attachments = [{path, fileName, type}]

User replies "what's in this?" (reply_to that message)
  → ensureReplyParentMedia(parent):
       prefer existing DB paths if files still on disk
       else download from nested reply_to_message file_ids
       backfill parent row (or insert completed _reply_context row)
  → turn builder:
       buildReplyChainText + collectReplyContextAttachments
       merge own + parent paths → "Available media"
  → agent reads the local file(s)
```

## Key code

| Piece | Path |
|---|---|
| Parent media ensure | `src/poll-worker.ts` → `ensureReplyParentMedia` |
| Chain helpers | `src/db.ts` → `lookupMessageForChain`, `buildReplyChainText`, `collectReplyContextAttachments`, `formatChainLine` |
| Live turn | `src/index.ts` → `buildReplyChain` |
| Drain turn | `src/polling-manager.ts` → `buildTurn` |
| MCP payload | `mcp-server/index.js` → `buildListenPayload` |
| Outbound media record | `recordOutboundMessage(..., attachments)` after `teleg-send_photo/video/document` and attach sends (extension **and** MCP) |

## Schema (v6)

`outbound_messages.attachments` stores JSON paths for bot-sent media so a later user reply to a bot photo still resolves.

## Limits

- Telegram Bot API `getFile` ≤ ~20 MB.
- Cache lives under `~/.pi/agent/tmp/teleg-media/` — if purged and Telegram no longer exposes the file_id, recovery fails.
- System prompt tells the agent to open `Referenced media` / `Available media` paths.

## Related

- [Polling](../modules/polling.md)
- [Database](database.md)
- [Gotchas](../gotchas.md)
