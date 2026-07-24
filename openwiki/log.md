# OpenWiki log

## 2026-07-25 — Shared-bot instance links

- Schema v7: `relay_sessions.linked_chat_ids` / `linked_user_ids`.
- Poller authorizes via any alive instance’s links; routes by chat/user ownership + INFO_REL when ambiguous.
- Drain claims linked unassigned first; primary catch-all skips other-owned channels.
- INFO_REL supports `## linked_chats` / `## linked_users`.

## 2026-07-25 — Trust complete local teleg.json

- Do not re-prompt for bot token / allowlist when `.pi/teleg.json` is already complete.
- Soft-trust local config if `getMe` is unreachable; prefer project `botId` over global default.
- Empty local allowlist `[]` no longer wipes non-empty global IDs.

## 2026-07-25 — Auto-fix health when enabled

- Enabled Pi folders auto-run `fixDegradedHealth` on session_start, health events, and the 30s timer (60s cooldown).
- Disabled projects (`teleg-disabled.json`) skip auto-repair with the rest of the engine.
- MCP heartbeat uses the same full repair path.

## 2026-07-25 — Fix degraded health

- Added `/teleg-fix-health`, Pi slash `/teleg-fix-health`, tool `teleg-fix-health` (extension + MCP).
- Repairs: Telegram getMe probe, stale processing recovery, session reconcile, poller restart when lock free.
- Auto-restart loop now also recovers DEGRADED pollers (`consecutiveErrors >= 3`).
- Updated telegram / pi-slash / tools / gotchas.

## 2026-07-25 — MCP outbound media parity

- MCP `teleg-send_photo/video/document` and `teleg-attach` now record `outbound_messages.attachments` (same as extension).
- Updated `modules/mcp.md` and `runtime/reply-context.md`.

## 2026-07-25 — Reply-context media recovery

- Added `runtime/reply-context.md`; updated architecture, overview, extension, polling, database, config-db, gotchas, index.
- Documents poll-worker parent backfill, chain helpers, outbound attachments (schema v6), and agent path guidance.

## 2026-07-24 — Initial OKF OpenWiki

- Created `openwiki/` for pi-teleg / teleg-bridge after full codebase scan.
- Covered architecture, modules (`src/` + MCP), actions (Telegram / Pi slash / tools / CLI), runtime paths, multi-bot plan status vs `TASKS.md`, automation, and gotchas (including `RELAY_UNASSIGNED_BUG.md`).
- Added `.cursor/rules/openwiki-maintain.mdc` (`alwaysApply`).
