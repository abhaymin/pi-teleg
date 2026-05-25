# Multi-bot Polling Implementation Tasks

## Status: Phase 1 Complete

## Task 1: Phase 1 — Bot Context and Configuration ✅
- **Status:** DONE (commit e5b1a5de)
- **Files:** src/config.ts (new), src/index.ts (modified)
- **Summary:** Created BotContext type, resolveBotContext(), multi-bot config v2, legacy migration

## Task 2: Phase 2 — Database Schema v2 ✅
- **Status:** DONE (commit 28522040)
- **Files:** src/db.ts, src/poll-worker.ts, src/index.ts, src/config.ts
- **Summary:** Added bot_id columns, schema version tracking, migration, all DB functions updated to scope by botId

## Task 3: Phase 3 — Per-bot Polling Manager
- **Status:** 🔄 In Progress (Integration Phase)
- **Files:** src/polling-manager.ts (new), src/poll-worker.ts (modified)
- **Summary:** Created PollingManager class, getPollingManager registry, offset messaging. Integration with index.ts in progress.

## Task 4: Phase 4 — Registry Unification
- **Status:** Pending
- **Depends on:** Task 2

## Task 5: Phase 5 — Liveness, Reconcile, Routing Guards
- **Status:** Pending
- **Depends on:** Task 3, Task 4

## Task 6: Phase 6 — Active Idle Drain
- **Status:** Pending
- **Depends on:** Task 5

## Task 7: Phase 7 — Extension Commands, MCP Tools
- **Status:** Pending
- **Depends on:** Task 5, Task 6

## Task 8: Phase R — Refactor (parallel-safe)
- **Status:** Pending
- **Depends on:** Task 7