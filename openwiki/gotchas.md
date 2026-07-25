---
type: concept
title: Gotchas
description: Hard traps — polling lock, dual-load, unassigned orphans, split DB, attach/media limits, health UX.
tags: [gotchas, pitfalls, invariants]
timestamp: 2026-07-25T11:50:00Z
---

# Gotchas

## One `getUpdates` per bot token

Telegram allows a single consumer. Starting a second poller for the same `botId` (second Pi instance without lock, or MCP that polls) causes missed/stolen updates. Respect `~/.pi/agent/tmp/teleg-bridge/polling-{botId}.lock`.

## Never dual-load extension + MCP in Pi

Identical tool names → Pi redirects MCP calls to the native tool with warnings. `deploy.sh` removes `teleg-bridge` from `~/.pi/agent/mcp.json`. Use MCP only for non-Pi clients (`teleg mcp --app … --write`).

## All state is `bot_id`-scoped

Queue claims, relay sessions, locks, media dirs, and primary election are per bot. Cross-bot routing is forbidden. Split `TELEG_DB_PATH` for the same bot → silent isolated queues (`detectSplitDb` warns).

## Reply-to media is recovered automatically

When a user **replies** to a prior Telegram message (especially an image), the bridge:

1. Looks up parent attachments in `message_queue` / `outbound_messages`.
2. If missing, downloads media from Telegram's nested `reply_to_message` (poll worker + main-thread recovery) and backfills a `_reply_context` row.
3. Surfaces local paths in the reply chain + turn `Available media` list.

**Why you sometimes only see caption text** (e.g. collage `🧩 r/… — 17 new`):

- Bot-sent photos were historically **not** written to `outbound_messages` (only text replies were). The collage message id never hit the DB.
- Recovery then depends on Telegram including `photo[]` on `reply_to_message`. If nested media fields are missing or `getFile` fails (≤20MB limit), the turn gets caption-only until you forward the image.
- After schema v6 + outbound recording, **new** `teleg-send_photo` / attach sends store local paths so later replies resolve without Telegram re-download.

The agent should **read those paths** when present. Media still subject to Telegram `getFile` ≤20MB and cache under `~/.pi/agent/tmp/teleg-media/`.

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
| `/teleg-fix-health` | Repair DEGRADED poll/session health |

## `teleg-attach` needs an active turn

Extension attach queues files onto the **current** Telegram turn reply. MCP `teleg-attach` sends immediately (no Pi turn). Calling attach with no active turn fails.

## Media size limit

Telegram Bot API `getFile` ≈ **20 MB**. Larger inbound media will not land in the cache.

## Stale processing recovery

Stuck `processing` rows reset after ~60s (bot-scoped). Do not blanket-reset live sessions’ in-flight work (cross-session steal).

## Shared-bot multi-instance routing

When the **same bot token** is used in multiple Pi folders with different channels:

1. Each folder’s `.pi/teleg.json` `allowedChatIds` / `allowedUserIds` plus INFO_REL `## linked_chats` / `## linked_users` are published on `relay_sessions`.
2. The lock-holding poller accepts a message if **any** alive instance links that chat/user (not only the primary’s local allowlist).
3. Queue assignment prefers the linked instance; INFO_REL capabilities break ties when multiple owners list the same chat.
4. Drain never steals another alive instance’s linked unassigned rows.

## Local `.pi/teleg.json` is authoritative

When a project folder has `.pi/teleg.json` with a usable `botToken` (and optional `botId` / `allowedUserIds` / `allowedChatIds`), teleg:

- Resolves that bot without re-prompting for the token or allowlist IDs
- Soft-trusts the file if Telegram `getMe` is unreachable (no setup UI loop)
- Prefers the pinned `botId` over the global default when selecting bots

Empty local allowlist arrays do not wipe non-empty global allowlists.

## Auto health repair (enabled folders)

When teleg is **not** disabled, DEGRADED / stopped polling is repaired **only after it stays bad ~5 minutes** (`TELEG_AUTO_FIX_DEGRADED_MS`).

**UX (do not dump into the prompt):** health is shown only on the extension footer via `ctx.ui.setStatus`:

| Glyph | Meaning |
|---|---|
| `✓` | healthy |
| `⚠` | degraded (waiting / errors) |
| `↻` | poller stopped, reconnecting |
| `🔧` | auto-fix in flight |
| `●` | active Telegram turn |

No countdown `console.log` into the content edit area. Manual `/teleg-fix-health` still repairs immediately and may notify once.

Disabled folders skip the engine entirely.

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
