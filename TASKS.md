# Multi-bot Polling Implementation Tasks

## Status: Phase 5 Complete

## Task 1: Phase 1 — Bot Context and Configuration ✅
- **Status:** DONE (commit e5b1a5de)
- **Files:** src/config.ts (new), src/index.ts (modified)
- **Summary:** Created BotContext type, resolveBotContext(), multi-bot config v2, legacy migration

## Task 2: Phase 2 — Database Schema v2 ✅
- **Status:** DONE (commit 28522040)
- **Files:** src/db.ts (modified)
- **Summary:** Added bot_id columns, migration, scoped query functions

## Task 3: Phase 3 — Per-bot Polling Manager ✅
- **Status:** DONE (commit 33d21dea)
- **Files:** src/index.ts (modified)
- **Summary:** Per-bot PollingManager registry, lock files per bot

## Task 4: Phase 4 — Registry Unification ✅
- **Status:** DONE (commit ea1e494f)
- **Files:** src/relay.ts, src/index.ts
- **Summary:** botId in relay JSON, SessionRegistry v2 with primaryByBot, DB sync

## Task 5: Phase 5 — Liveness, Reconcile, Routing Guards ✅
- **Status:** DONE (commit 93555d8d)
- **Files:** src/session-registry.ts (new), src/index.ts (modified)
- **Summary:** Created session-registry.ts with liveness checks (6 checks), ghost eviction, primary election, reconcile

## Task 6: Phase 6 — Active Idle Drain
- **Status:** Pending
- **Depends on:** Task 5 ✅

## Task 7: Phase 7 — Extension Commands, MCP Tools
- **Status:** Pending
- **Depends on:** Task 5 ✅, Task 6

## Task 8: Phase R — Refactor (parallel-safe)
- **Status:** Pending
- **Depends on:** Task 7