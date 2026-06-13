# Multi-bot Polling Implementation Tasks

## Status: ALL COMPLETE ✅

## Task 1: Phase 1 — Bot Context and Configuration ✅
- **Status:** DONE (commit e5b1a5de)
- **Files:** src/config.ts (new), src/index.ts (modified)
- **Summary:** Created BotContext type, resolveBotContext(), multi-bot config v2, legacy migration

## Task 2: Phase 2 — Database Schema v2 ✅
- **Status:** DONE
- **Summary:** Added bot_id columns, migration, scoped queue/relay operations

## Task 3: Phase 3 — Per-bot Polling Manager ✅
- **Status:** DONE
- **Summary:** PollingManager registry, per-bot locks, offset events

## Task 4: Phase 4 — Registry Unification ✅
- **Status:** DONE
- **Summary:** SQLite ↔ JSON sync, heartbeats, capabilities mirroring

## Task 5: Phase 5 — Liveness, Reconcile, Routing Guards ✅
- **Status:** DONE
- **Summary:** Ghost eviction, primary election, routing guards

## Task 6: Phase 6 — Active Idle Drain ✅
- **Status:** DONE
- **Summary:** Idle drain interval, claim order, steer delivery

## Task 7: Phase 7 — Extension Commands, MCP Tools, Documentation ✅
- **Status:** DONE (commit 3d2c6dab)
- **Files:** src/index.ts (modified), mcp-server/index.js (modified), README.md (modified)
- **Summary:** Session management tools, Telegram commands, enhanced /status, MCP mirroring

## Task R: Phase R — Refactor (parallel-safe) ✅
- **Status:** DONE (commit f0b2a3fe)
- **Files:** src/capabilities.ts (new), src/session-config.ts (new), src/index.ts (refactored)
- **Summary:** index.ts 2686→1687 lines (37% reduction)

---

## Summary

All 7 phases + refactor complete! The teleg bridge now supports:

- **Multi-bot:** One poller per bot, scoped state by `bot_id`
- **Active workers:** All sessions drain queues when idle
- **Ghost eviction:** Automatic reconcile and primary re-election
- **Management tools:** Extension tools, Telegram commands, MCP mirroring
- **Clean architecture:** Modular design with separate config, polling, registry modules

### Commits
| Phase | Commit | Description |
|-------|--------|-------------|
| 1 | e5b1a5de | Bot context and multi-bot config |
| 2 | (multiple) | Database schema v2 migration |
| 3 | 33d21dea | Per-bot polling manager |
| 4 | ea1e494f | Registry unification |
| 5 | 93555d8d | Liveness reconcile and ghost eviction |
| 6 | 55584d56 | Active idle queue drain |
| 7 | 3d2c6dab | Extension commands and MCP tools |
| R | f0b2a3fe | Refactor index.ts shrink |

### Next Steps
1. Manual smoke test: start extension, check `/status` works
2. Test with two bots (verification matrix T1-T8)
3. Update PLAN_ACTION.md sign-off section