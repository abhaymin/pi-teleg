---
type: concept
title: Gotchas
description: Hard traps — polling lock, dual-load, unassigned orphans, split DB, attach/media limits.
tags: [gotchas, pitfalls, invariants]
timestamp: 2026-07-24T16:00:00Z
---

# Gotchas

## One `getUpdates` per bot token

Telegram allows a single consumer. Starting a second poller for the same `botId` (second Pi instance without lock, or MCP that polls) causes missed/stolen updates. Respect `~/.pi/agent/tmp/teleg-bridge/polling-{botId}.lock`.

## Never dual-load extension + MCP in Pi

Identical tool names → Pi redirects MCP calls to the native tool with warnings. `deploy.sh` removes `teleg-bridge` from `~/.pi/agent/mcp.json`. Use MCP only for non-Pi clients (`teleg mcp --app … --write`).

## All state is `bot_id`-scoped

Queue claims, relay sessions, locks, media dirs, and primary election are per bot. Cross-bot routing is forbidden. Split `TELEG_DB_PATH` for the same bot → silent isolated queues (`detectSplitDb` warns).

## Unassigned / unknown orphans (open bug)

Worker always inserts `session_name='unknown'`, `session_id='unassigned'`. Capable sessions on **non-default** bots only claim unassigned rows that pass `matchMessageToCapability` (keyword/URL heuristics). Free-form replies (`yes`, `1`, `Any update?`) can sit `pending` forever.

See [`RELAY_UNASSIGNED_BUG.md`](../RELAY_UNASSIGNED_BUG.md). Mitigations in drain: primary catch-all (partial), silent-session claim, `TELEG_CLAIM_OTHERS=1`.

## Capability matching is not free-text NLP

`matchMessageToCapability` uses Twitter/YouTube/Reddit URL heuristics plus description keyword overlap (words >3 chars). Declaring a capability does **not** mean every chat message routes to that session.

## Kill-switches are not interchangeable

| Action | Effect |
|---|---|
| `/teleg-dc` / `teleg-disconnect` | This session leaves bridge |
| `/teleg-dc-all` / `teleg-disconnect-all` | All sessions on bot disconnect; DB kept |
| `/teleg-clean-db` / `teleg-clean-db` tool | Reset processing + purge old queue rows |
| `/teleg-remove-sessions` | Drop dead registry rows |
| `/teleg-reconcile` | Ghost eviction + primary re-elect |

## `teleg-attach` needs an active turn

Extension attach queues files onto the **current** Telegram turn reply. MCP `teleg-attach` sends immediately (no Pi turn). Calling attach with no active turn fails.

## Media size limit

Telegram Bot API `getFile` ≈ **20 MB**. Larger inbound media will not land in the cache.

## Stale processing recovery

Stuck `processing` rows reset after ~60s (bot-scoped). Do not blanket-reset live sessions’ in-flight work (cross-session steal).

## Disable persists across restarts

`/teleg-disable` writes `~/.pi/agent/teleg-disabled.json`. Needs `/teleg-enable` + session restart.

## Stale plan docs

[`docs/PLAN_ACTION.md`](../docs/PLAN_ACTION.md) header still says “Draft — implementation not started”. [`TASKS.md`](../TASKS.md) + code say Phases 1–7 + R are done. Prefer TASKS + source.

## PYTHONHOME / uv on deploy

`deploy.sh` / install use `uv` and strip AppImage `PYTHONHOME` leaks when building. Host shells with poisoned `PYTHONHOME` can break helper Python — unset if you see encoding errors.

## Related

- [Architecture](architecture.md)
- [Runtime](runtime/index.md)
- [Plans](plans/index.md)
