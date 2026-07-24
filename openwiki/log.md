# OpenWiki log

## 2026-07-25 — Reply-context media recovery

- Added `runtime/reply-context.md`; updated architecture, overview, extension, polling, database, config-db, gotchas, index.
- Documents poll-worker parent backfill, chain helpers, outbound attachments (schema v6), and agent path guidance.

## 2026-07-24 — Initial OKF OpenWiki

- Created `openwiki/` for pi-teleg / teleg-bridge after full codebase scan.
- Covered architecture, modules (`src/` + MCP), actions (Telegram / Pi slash / tools / CLI), runtime paths, multi-bot plan status vs `TASKS.md`, automation, and gotchas (including `RELAY_UNASSIGNED_BUG.md`).
- Added `.cursor/rules/openwiki-maintain.mdc` (`alwaysApply`).
