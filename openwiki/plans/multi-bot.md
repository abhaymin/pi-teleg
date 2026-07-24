---
type: concept
title: Multi-bot plan status
description: PLAN_ACTION phases vs TASKS.md and code evidence.
tags: [plans, multi-bot, status]
timestamp: 2026-07-24T16:00:00Z
---

# Multi-bot plan status

[`docs/PLAN_ACTION.md`](../../docs/PLAN_ACTION.md) is the original sequenced plan (header still says draft / not started, dated 2026-05-25).  
[`TASKS.md`](../../TASKS.md) marks **ALL COMPLETE**. Prefer TASKS + source.

| Phase | Goal | Status |
|---|---|---|
| 1 | BotContext + config v2 | Done — `src/config.ts` |
| 2 | DB `bot_id` schema | Done — `db.ts` schema v5 |
| 3 | Per-bot PollingManager | Done — `polling-manager.ts` |
| 4 | Registry unification | Done — SQL + JSON sync |
| 5 | Liveness / reconcile | Done — `session-registry.ts` |
| 6 | Idle drain | Done — drainTimer in `index.ts` |
| 7 | Tools / MCP / docs | Done — tools + MCP mirror |
| R | Refactor `index.ts` | Done historically; file has grown again (~3k LOC) |
| T1–T8 verification | Manual matrix | Not signed off in PLAN |
| Sign-off | PLAN footer | Open |

## Still open (not PLAN phases)

- Primary catch-all for unassigned free-form replies on capable non-default sessions — [`RELAY_UNASSIGNED_BUG.md`](../../RELAY_UNASSIGNED_BUG.md).
- Keep PLAN_ACTION header/checkboxes honest if anyone revisits that doc.

## Related

- [Architecture](../architecture.md)
- [Gotchas](../gotchas.md)
