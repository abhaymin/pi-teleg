# Plan Action Document: Multi-bot polling, active workers, session eviction

**Status:** Draft — implementation not started  
**Source plan:** `.cursor/plans/multi-bot_polling_and_sessions_0b74e7b9.plan.md`  
**Primary deployment:** Same host, multiple Pi sessions (A)  
**Secondary deployment:** Mixed shared/isolated (D)  
**Last updated:** 2026-05-25

---

## Executive summary

Teleg today uses one global polling lock, one shared bot config, and fragmented session registries (JSON + unused SQLite). This action doc sequences work to:

1. Scope all state by **`bot_id`** (config, DB, locks, routing).
2. Allow **multiple pollers on one machine** (one per distinct bot).
3. Keep **one poller per bot** but make every linked Pi session an **active queue worker** (idle drain).
4. **Reconcile and evict** ghost sessions—including stale **primary**—via extension + MCP tools.

**Hard rule:** Telegram allows only one `getUpdates` consumer per bot token. Multiple Pi sessions on the same bot share one poller and compete/cooperate via SQLite queue claims.

---

## Prerequisites

- [ ] Node 20+, TypeScript build passes (`npm run build`)
- [ ] Backup `~/.pi/agent/teleg-bridge.db` and `teleg-bridge.json` before migration
- [ ] Note current `sessionName` values (folder names) for relay paths
- [ ] Two bot tokens available for multi-bot tests (optional but recommended)

---

## Dependency graph

```
Phase 1 (config) ──┬──> Phase 2 (db)
                   │
Phase 2 (db) ──────┼──> Phase 3 (polling)
                   │
Phase 3 (polling) ─┼──> Phase 5 (routing) ──> Phase 6 (drain)
                   │
Phase 2 (db) ──────┴──> Phase 4 (registry) ──> Phase 5 (reconcile)
                   │
Phase 5 + 6 ─────────────> Phase 7 (MCP/tools/docs)
                   │
Phase 3 (optional parallel) ──> Phase R (refactor index.ts)
```

---

## Phase 1 — Bot context and configuration

**Goal:** Every Pi session resolves a `BotContext` before touching Telegram or DB.  
**Exit criteria:** `resolveBotContext(cwd)` returns consistent `botId` for env, project, and global config; legacy JSON migrates on read.

### Actions

| ID | Action | File(s) | Done |
|----|--------|---------|------|
| 1.1 | Create `BotContext` type and `resolveBotContext(projectDir)` | `src/config.ts` (new) | [ ] |
| 1.2 | Implement resolution order: `TELEG_BOT_TOKEN` → `TELEG_BOT_ID` → project `teleg.json` → global JSON | `src/config.ts` | [ ] |
| 1.3 | Add multi-bot global shape `bots: Record<string, BotEntry>`, `defaultBotId`, `version: 2` | `src/config.ts` | [ ] |
| 1.4 | Legacy migration: flat `botToken` at root → single entry in `bots` via `getMe` | `src/config.ts` | [ ] |
| 1.5 | `saveLastUpdateId(botId, offset)` / `loadBotConfig(botId)` — no global overwrite | `src/config.ts` | [ ] |
| 1.6 | Resolve `dbPath`: `TELEG_DB_PATH` → project `dbPath` in teleg.json → default `~/.pi/agent/teleg-bridge.db` | `src/config.ts` | [ ] |
| 1.7 | Wire `session_start`: resolve context, store on session state (no polling change yet) | `src/index.ts` | [ ] |
| 1.8 | Startup warning: same `botId` detected with different `dbPath` across sessions | `src/config.ts`, `src/index.ts` | [ ] |

### Config file templates

**Global** `~/.pi/agent/teleg-bridge.json`:

```json
{
  "version": 2,
  "defaultBotId": 123456789,
  "bots": {
    "123456789": {
      "botToken": "TOKEN",
      "botUsername": "my_bot",
      "allowedUserIds": [987654321],
      "lastUpdateId": 0
    }
  }
}
```

**Project** `.pi/teleg.json`:

```json
{
  "botToken": "TOKEN",
  "allowedUserIds": [987654321]
}
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEG_BOT_TOKEN` | — | Force token for process |
| `TELEG_BOT_ID` | — | Select bot from global config |
| `TELEG_DB_PATH` | `~/.pi/agent/teleg-bridge.db` | Shared DB (D) |
| `TELEG_LIVENESS_MS` | `300000` | Max heartbeat age for linked session |
| `TELEG_DRAIN_INTERVAL_MS` | `12000` | Idle queue drain interval |
| `TELEG_CLAIM_OTHERS` | `0` | Allow claiming other sessions' pending |

---

## Phase 2 — Database schema v2

**Goal:** All queue/relay/download rows and queries scoped by `bot_id`.  
**Exit criteria:** Migration runs on existing DB; `npm run build` passes; enqueue/claim/stats require `botId`.

### Actions

| ID | Action | File(s) | Done |
|----|--------|---------|------|
| 2.1 | Add `schema_version` or user_version tracking | `src/db.ts` | [ ] |
| 2.2 | Migration: `message_queue.bot_id`, new unique index `(bot_id, chat_id, message_id)` | `src/db.ts` | [ ] |
| 2.3 | Migration: `relay_sessions.bot_id`, `is_primary`, unique `(bot_id, session_name)` | `src/db.ts` | [ ] |
| 2.4 | Migration: `download_queue.bot_id` | `src/db.ts` | [ ] |
| 2.5 | Backfill `bot_id` from default bot at migration time | `src/db.ts` | [ ] |
| 2.6 | Update `enqueueMessage`, `claimNextMessage`, `claimNextMessageForSession` | `src/db.ts` | [ ] |
| 2.7 | Update `getQueueDepth`, `getQueueStats`, `recoverStaleMessages`, `resetProcessingForSession` | `src/db.ts` | [ ] |
| 2.8 | Add `getSessionProcessingChat(botId, chatId)` | `src/db.ts` | [ ] |
| 2.9 | Update `registerRelaySession` to require `bot_id`; primary helpers `setPrimary(botId, name)` | `src/db.ts` | [ ] |
| 2.10 | Pass `bot_id` in poll-worker `INSERT` | `src/poll-worker.ts` | [ ] |

---

## Phase 3 — Per-bot polling manager

**Goal:** Multiple bots poll concurrently on one host; one lock per `bot_id`.  
**Exit criteria:** Two bots → two lock files, two workers; same bot → one lock; `lastUpdateId` per bot.

### Actions

| ID | Action | File(s) | Done |
|----|--------|---------|------|
| 3.1 | Extract `SharedPollingManager` → `PollingManager` class | `src/polling-manager.ts` (new) | [ ] |
| 3.2 | `getPollingManager(botId: number): PollingManager` registry (Map) | `src/polling-manager.ts` | [ ] |
| 3.3 | Lock path: `polling-{botId}.lock` with lines: pid, ts, botId, sessionName | `src/polling-manager.ts` | [ ] |
| 3.4 | Worker `workerData`: `botId`, `dbPath`; parent saves offset via `config.saveLastUpdateId` | `src/polling-manager.ts`, `src/poll-worker.ts` | [ ] |
| 3.5 | Worker posts `{ type: "offset", botId, lastUpdateId }` after batch | `src/poll-worker.ts` | [ ] |
| 3.6 | Duplicate insert: skip dispatch if row `completed`/`processing` for same `bot_id` | `src/poll-worker.ts`, `src/polling-manager.ts` | [ ] |
| 3.7 | Replace `SharedPollingManager` usage in `index.ts` with `getPollingManager(ctx.botId)` | `src/index.ts` | [ ] |
| 3.8 | Status UI: show poller role `active` vs `passive` per bot | `src/index.ts` | [ ] |

### Lock file format

```
{pid}
{timestamp_ms}
{botId}
{sessionName}
```

---

## Phase 4 — Registry unification

**Goal:** SQLite `relay_sessions` is populated and kept in sync with JSON registry.  
**Exit criteria:** `/status` relay section matches live processes; heartbeat updates every 30s.

### Actions

| ID | Action | File(s) | Done |
|----|--------|---------|------|
| 4.1 | On `startRelayServer`: call `registerRelaySession({ bot_id, ... })` | `src/index.ts`, `src/relay.ts` | [ ] |
| 4.2 | Heartbeat interval: `heartbeatRelaySession` + update JSON `lastActivity` | `src/index.ts` | [ ] |
| 4.3 | On shutdown: `unregisterRelaySession` + existing relay file cleanup | `src/index.ts` | [ ] |
| 4.4 | Extend relay JSON with `botId` | `src/relay.ts` | [ ] |
| 4.5 | JSON registry v2: `version`, `primaryByBot`, `SessionInfo.botId` | `src/index.ts` | [ ] |
| 4.6 | Mirror capabilities into `relay_sessions.capabilities` (reduce `teleg-capabilities.json` reliance) | `src/index.ts`, `src/db.ts` | [ ] |

---

## Phase 5 — Liveness, reconcile, routing guards

**Goal:** Ghost sessions (including ghost primary) never receive messages.  
**Exit criteria:** `reconcileSessions` evicts dead PID; primary re-elected; routing calls reconcile before primary fallback.

### Actions

| ID | Action | File(s) | Done |
|----|--------|---------|------|
| 5.1 | Create `checkSessionLiveness(session)` — pid, relay file, relay HTTP, heartbeat, db row | `src/session-registry.ts` (new) | [ ] |
| 5.2 | Implement `reconcileSessions(botId?)` → `ReconcileReport` | `src/session-registry.ts` | [ ] |
| 5.3 | Ghost eviction: unregister SQL, JSON, relay file, `resetProcessingForSession` | `src/session-registry.ts` | [ ] |
| 5.4 | Primary election: lock holder > heartbeat > registered_at; `is_primary` in SQL | `src/session-registry.ts`, `src/db.ts` | [ ] |
| 5.5 | Call `reconcileSessions` on: `session_start`, 30s timer, pre-primary in `handleWorkerMessage` | `src/index.ts` | [ ] |
| 5.6 | Scope routing: `@session`, capabilities, primary — all filter `bot_id` | `src/index.ts` | [ ] |
| 5.7 | Scope `getSessionProcessingChat` by `bot_id` | `src/index.ts`, `src/db.ts` | [ ] |

### Liveness checks (all required for "linked")

| Check | Method |
|-------|--------|
| `pid_alive` | `process.kill(pid, 0)` |
| `relay_file` | `teleg-relay/{sessionName}.json` exists |
| `relay_pid_match` | file.pid === session.pid |
| `relay_http` | GET `http://127.0.0.1:{port}/health` → 200 |
| `heartbeat_fresh` | `now - last_heartbeat < TELEG_LIVENESS_MS` |
| `db_row` | row in `relay_sessions` for `(bot_id, session_name)` |

---

## Phase 6 — Active idle drain

**Goal:** Passive sessions process their queue without waiting for another session's `agent_end`.  
**Exit criteria:** Pending message picked up within `TELEG_DRAIN_INTERVAL_MS` when session idle.

### Actions

| ID | Action | File(s) | Done |
|----|--------|---------|------|
| 6.1 | `setInterval` drain on `session_start`, clear on `session_shutdown` | `src/index.ts` | [ ] |
| 6.2 | Drain only if `ctx.isIdle()` and no `state.activeTurn` | `src/index.ts` | [ ] |
| 6.3 | Claim order: `pendingForwards` → `claimNextTurnForSession` → unassigned (same bot) | `src/index.ts` | [ ] |
| 6.4 | Use `pi.sendUserMessage(..., { deliverAs: "steer" })` for drained items | `src/index.ts` | [ ] |

---

## Phase 7 — Extension commands, MCP tools, documentation

**Goal:** Operators and agents can reconcile/evict without hand-editing JSON.  
**Exit criteria:** Tool parity extension ↔ MCP; README deployment matrix published.

### Extension commands

| Command | Done |
|---------|------|
| `/teleg-reconcile` | [ ] |
| `/teleg-sessions` | [ ] |
| `/teleg-set-primary <name>` | [ ] |
| `/teleg-bots` | [ ] |

### Extension tools (`pi.registerTool`)

| Tool | Parameters | Done |
|------|------------|------|
| `teleg-reconcile` | `bot_id?` | [ ] |
| `teleg-list_sessions` | `bot_id?`, `include_ghosts?` | [ ] |
| `teleg-evict_session` | `session_name`, `bot_id?`, `reset_queue?`, `force_kill_pid?` | [ ] |
| `teleg-list_bots` | — | [ ] |
| `teleg-set_primary` | `session_name`, `bot_id?` | [ ] |
| Update send/queue tools | optional `bot_id` | [ ] |

### MCP tools (`mcp-server/index.js`)

| Tool | Done |
|------|------|
| Mirror reconcile / list / evict / list_bots | [ ] |
| `TELEG_BOT_ID` / `TELEG_BOT_TOKEN` at MCP process init | [ ] |
| Document multi-entry `mcp.json` in README + deploy comment | [ ] |

### Telegram `/status` additions

- [ ] Per-bot poller holder (session + pid)
- [ ] Linked vs ghost session lists
- [ ] Per-bot primary name
- [ ] Queue counts scoped by `bot_id`

### Documentation

| Doc | Done |
|-----|------|
| README: deployment A + D matrix | [ ] |
| README: env var table | [ ] |
| README: anti-pattern (same bot, split DB) | [ ] |
| README: ghost primary troubleshooting | [ ] |

---

## Phase R — Refactor (parallel-safe)

**Goal:** Shrink `index.ts` for maintainability without behavior change.  
**Exit criteria:** `index.ts` < ~1200 lines; build + manual smoke pass.

| ID | Action | Done |
|----|--------|------|
| R.1 | Move polling IIFE to `src/polling-manager.ts` | [ ] |
| R.2 | Move config to `src/config.ts` | [ ] |
| R.3 | Move registry/reconcile to `src/session-registry.ts` | [ ] |
| R.4 | Keep only Pi wiring + `handleAuthorizedTelegramMessage` in `index.ts` | [ ] |

---

## Verification matrix (manual)

Run after Phases 1–7.

| ID | Scenario | Steps | Expected | Pass |
|----|----------|-------|----------|------|
| T1 | Two bots, shared DB | Open Pi in project A and B with different tokens | Two `polling-*.lock` files; both receive messages | [ ] |
| T2 | Same bot, two projects | Same token, same `TELEG_DB_PATH` | One lock; both sessions show queue; both drain when idle | [ ] |
| T3 | Ghost passive session | `kill -9` passive Pi PID, `/teleg-reconcile` | Session evicted; pending reset | [ ] |
| T4 | Ghost primary | `kill -9` poller PID, wait 45s | New primary elected; polling resumes | [ ] |
| T5 | `@deadSession` | Message with `@deadSession` prefix | User-visible error; not stuck `processing` | [ ] |
| T6 | MCP evict | Call `teleg-evict_session` from MCP | Registry + SQL row removed | [ ] |
| T7 | Split DB warning | Same token, different `TELEG_DB_PATH` | Warning on session_start | [ ] |
| T8 | Legacy config | Flat `teleg-bridge.json` v1 | Migrates; polling still works | [ ] |

---

## File checklist (create / modify)

| Path | Action |
|------|--------|
| `docs/PLAN_ACTION.md` | This document |
| `src/config.ts` | **Create** |
| `src/session-registry.ts` | **Create** |
| `src/polling-manager.ts` | **Create** |
| `src/db.ts` | **Modify** — schema + scoped APIs |
| `src/index.ts` | **Modify** — wire context, drain, tools |
| `src/poll-worker.ts` | **Modify** — bot_id, offset events |
| `src/relay.ts` | **Modify** — botId in relay JSON |
| `mcp-server/index.js` | **Modify** — new tools, env context |
| `README.md` | **Modify** — deployment docs |
| `deploy.sh` | **Modify** — comment multi-MCP optional |

---

## Rollback plan

1. Stop all Pi sessions using teleg.
2. Restore `teleg-bridge.db.bak` and `teleg-bridge.json.bak`.
3. Remove `polling-*.lock` files under `~/.pi/agent/tmp/teleg-bridge/`.
4. Checkout previous extension build / redeploy prior `dist/`.

---

## Sign-off

| Role | Name | Date | Approved |
|------|------|------|----------|
| Owner | | | [ ] |
| Reviewer | | | [ ] |

---

## Related links

- Expanded design: `.cursor/plans/multi-bot_polling_and_sessions_0b74e7b9.plan.md`
- Product README: [README.md](../README.md)
- Capabilities example: [INFO_REL.md](../INFO_REL.md)
