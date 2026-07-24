---
type: concept
title: Polling
description: Per-bot PollingManager, lock files, and poll-worker persistence including reply-parent media.
tags: [modules, polling, worker, lock, reply-context]
timestamp: 2026-07-25T00:30:00Z
---

# Polling

## `src/polling-manager.ts`

One `PollingManager` instance per `botId` (registry via `getPollingManager` / `getAllPollingManagers`).

- `start` / `stop` — spawn/stop worker thread.
- `acquireLock` — `~/.pi/agent/tmp/teleg-bridge/polling-{botId}.lock` (pid, ts, botId, sessionName); refresh ~30s.
- Event hooks: `onMessage`, `onReaction`, `onPoll`, `onPollAnswer`.
- Claim helpers used by drain: `claimNextTurn`, `claimNextTurnForSession`, `claimNextTurnForSilentSession`.
- `recoverCrashState` — bot-scoped stale `processing` reset.
- `buildTurn` — reply chain via `Db.buildReplyChainText` + merges own + reply-parent attachments into the turn.

## `src/poll-worker.ts`

Runs in a **worker thread**. Long-polls `getUpdates`, downloads inbound media, persists, posts to main.

| Behavior | Detail |
|---|---|
| Insert | Always `session_id='unassigned'`, `session_name='unknown'`, `status='pending'` |
| Media | `~/.pi/agent/tmp/teleg-media/{botId}/` (Bot API ~20MB limit) |
| Reply parent | `ensureReplyParentMedia` — reuse DB paths or download from nested `reply_to_message`, backfill parent row |
| Events | `message`, `reaction`, `poll`, `poll_answer`, `offset`, `health` |
| Offset | Main persists via `saveLastUpdateId(botId, …)` |

**Invariant:** worker does **not** route. Routing is primary handler + drainTimer on the main thread.

## Related

- [Extension](extension.md)
- [Architecture](../architecture.md)
- [Gotchas](../gotchas.md)
