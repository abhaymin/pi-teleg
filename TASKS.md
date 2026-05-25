# Multi-bot Polling Implementation Tasks

## Status: Phase 1 Complete

## Task 1: Phase 1 — Bot Context and Configuration ✅
- **Status:** DONE (commit e5b1a5de)
- **Files:** src/config.ts (new), src/index.ts (modified)
- **Summary:** Created BotContext type, resolveBotContext(), multi-bot config v2, legacy migration

## Task 2: Phase 2 — Database Schema v2
- **Status:** Pending
- **Depends on:** Task 1 ✅

## Task 3: Phase 3 — Per-bot Polling Manager
- **Status:** Pending
- **Depends on:** Task 2

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