# OpenWiki log

## 2026-08-10 — Pi system commands via Telegram

- Added `src/pi-sys-commands.ts`: `/pi`, `/model`, `/models`, `/think`, `/compact`, `/tools`, `/cmds`, `/cmd`, `/agent`, `/orchestrate`, `/session`, `/new`, `/reload`, `stop`.
- Wired in `handleAuthorizedTelegramMessage` after allowlist; uses ExtensionAPI (`setModel`, thinking, tools) because TUI slash commands do not run through `sendUserMessage`.
- `/cmd` and `/agent` are agent-mediated (sub-agent tools when present). Documented in `actions/telegram.md`.
- `stop` also aborts agent runs (not just turns).

## 2026-08-10 — CLI remove shim + MCP install script

- Added `teleg remove-cli` / `teleg undeploy-cli` (also `npm run remove:cli`, `./remove-cli.sh`, `./deploy-cli.sh --remove`) — deletes only `~/.local/bin/teleg` shim; does **not** touch Pi or MCP. Full teardown stays `teleg uninstall`.
- Added `install-mcp.sh` / `npm run install:mcp` — wires standalone MCP into non-Pi clients (Cursor, Claude, OpenCode, Kilo, custom paths). New page: `modules/mcp-install.md`.
- Updated `actions/cli.md`, `automation.md`, `modules/index.md`, `index.md`.

## 2026-08-10 — Orchestration mode

- Added `src/orchestrator.ts`: multi-session orchestration logic.
- Added `/orchestrate <task>` Pi command (works from both Telegram and Pi directly).
- Uses relay system to dispatch sub-tasks to other Pi sessions (sub-agents).
- Sub-agents process relay commands directly; results aggregated and returned.
- State persisted in `~/.pi/agent/tmp/teleg-orchestrator/bot-{id}.json`.
- New page: `actions/orchestrate.md`.
- Updated: `actions/index.md`, `automation.md`, `index.md`, `log.md`.

## 2026-07-25 — CLI bootstrap + SQLite cross-links

- Documented: when `teleg` is missing, `./install.sh install` builds + deploys + shim (`actions/cli.md`, `automation.md`, `overview.md`, `index.md`).
- Indexed `suppress-sqlite-warning.ts`; Node ≈22.5+ / Bun notes on overview package table.
- Modules index lists the suppress module under Config & DB.

## 2026-07-25 — SQLite surfaces / runtime docs

- Documented which surfaces open SQLite (extension, poll-worker, MCP) vs CLI (does not).
- Clarified Node ≈22.5+ / `node:sqlite` requirement; Bun uses `bun:sqlite` (no Node ExperimentalWarning).
- MCP docs: `node:sqlite` + suppress (was stale `better-sqlite3`); `database.md` schema note → v7.
- Matrix in `gotchas.md`; entrypoint table in `modules/config-db.md`.

## 2026-07-25 — SQLite ExperimentalWarning race cover

`suppress-sqlite-warning` now also replaces the default `process` `warning` listener so a parallel `node:sqlite` import cannot still print the experimental warning after emitWarning was patched too late.

## 2026-07-25 — Suppress Node SQLite ExperimentalWarning

- Added `src/suppress-sqlite-warning.ts`; imported first from extension, poll-worker, sqlite-driver, and MCP.
- Stops `ExperimentalWarning: SQLite is an experimental feature…` from leaking into the Pi content console.
- Documented in `gotchas.md`.

## 2026-07-25 — Health status in footer only

- Auto health repair no longer dumps countdown / fix lines into the Pi content/prompt area.
- Ambient health uses extension footer glyphs via `ctx.ui.setStatus` (`✓` / `⚠` / `↻` / `🔧` / `●`).
- Auto-fix still waits ~5m (`TELEG_AUTO_FIX_DEGRADED_MS`); manual `/teleg-fix-health` is immediate.
- Outbound tools resolve chat via active turn → `allowedChatIds` → `allowedUserIds`.
- Updated `gotchas.md` (glyph table) and `modules/extension.md`.

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

- Enabled folders auto-repair after an **extended** DEGRADED window (default 5m), not on every blip.
- Status is footer-only (see “Health status in footer only”); no prompt spam.
- Disabled projects (`teleg-disabled.json`) skip auto-repair with the rest of the engine.

## 2026-07-25 — Fix degraded health

- Added `/teleg-fix-health`, Pi slash `/teleg-fix-health`, tool `teleg-fix-health` (extension + MCP).
- Repairs: Telegram getMe probe, stale processing recovery, session reconcile, poller restart when lock free.
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
