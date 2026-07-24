---
type: concept
title: Architecture
description: Layers, polling→queue→routing→relay data flow, and system boundaries for teleg-bridge.
tags: [architecture, data-flow, boundaries, multi-bot]
timestamp: 2026-07-25T00:45:00Z
---

# Architecture

## Layers

| Layer | Responsibility | Boundary |
|---|---|---|
| **Bot context** | Resolve `botId` + token + DB path per session | `src/config.ts` — env → project → global |
| **Poller** | One long-poll worker per bot | `PollingManager` + lock file; Telegram hard rule: one `getUpdates` consumer per token |
| **Persist** | Insert inbound messages + media paths | Worker writes `message_queue` as `unassigned` / `unknown` / `pending` |
| **Router** | Assign to a live session | Primary handler + every session’s `drainTimer` |
| **Relay** | Cross-session HTTP forward | `~/.pi/agent/tmp/teleg-relay/{botId-}{session}.json` |
| **Session registry** | Liveness, ghosts, primary election | SQLite `relay_sessions` + JSON mirrors |
| **Tools** | Outbound Telegram + ops | Extension `registerTool` ≡ MCP tools (shared DB) |

## Entry points

1. **Pi session start** — `session_start` resolves `BotContext`, registers relay, may acquire poll lock, starts drain timer.
2. **Telegram update** — lock-holding worker → DB insert → `postMessage` → primary `handleAuthorizedTelegramMessage`.
3. **Idle drain** — every linked session (~12s, `TELEG_DRAIN_INTERVAL_MS`) claims queued work.
4. **MCP client** — third-party agents call tools / `teleg_listen` against the same DB (no poller).
5. **CLI** — `teleg install|update|mcp` for host wiring.

## Data flow (happy path)

```
getUpdates (worker thread)
  → download media → ~/.pi/agent/tmp/teleg-media/{botId}/
  → if reply_to_message: ensureReplyParentMedia (reuse/backfill parent attachments)
  → INSERT message_queue (session=unassigned/unknown, pending)
  → notify PollingManager
       │
       ├─ primary: handleAuthorizedTelegramMessage
       │     /commands | @session | capability | stickiness | activateTurn
       │     (reply chain text + Available media paths for parent + self)
       │
       └─ drainTimer (all linked sessions):
             pubsub → claim own / unassigned (rules differ by default bot)
             → capability-scan unassigned → silent fallback → optional CLAIM_OTHERS
             → activateTurn → agent → teleg-send_* → completeMessage
             → outbound media recorded with local paths (schema v6)
```

## Multi-bot / multi-session rules

- **One poller per `botId`** via `polling-{botId}.lock` (pid + sessionName).
- Many Pi sessions may share a bot: one **active** (lock + worker), others **queue workers** only.
- Cross-bot `@session` is rejected.
- Session name ≈ project folder name; relay keyed by `{botId}-{sessionName}`.
- Almost every DB op takes `botId` — never claim/route across bots.

## Boundaries / invariants

- Extension owns polling; MCP does not start workers.
- Worker **does not route** — only persist + notify (+ reply-parent media ensure).
- Allowlists: `allowedUserIds` (DMs) vs `allowedChatIds` (groups/channels).
- Schema version: `PRAGMA user_version = 6` after migrations (`src/db.ts`).
- Bun/Node SQLite via `src/sqlite-driver.ts` only — do not import `node:sqlite` in shared paths.
- Reply-to media: agent must read local paths from the turn; users should not need to re-send images.

## Related

- [Modules](modules/index.md)
- [Runtime data](runtime/index.md)
- [Reply context media](runtime/reply-context.md)
- [Gotchas](gotchas.md)
- [Unassigned orphan bug](../RELAY_UNASSIGNED_BUG.md)
