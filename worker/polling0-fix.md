# polling:0 fix implementation

## Summary
Implemented the focused polling:0 fix. The runtime now centralizes effective bot identity/token resolution in `src/index.ts`, avoids operational `getPollingManager(... ?? 0)` usage, and makes `src/session-config.ts` v2-aware so default-bot config no longer reads as an empty flat config.

## Changed files
- `src/index.ts`
  - Added runtime helpers: `normalizeConfigFromBotContext`, `currentBotId`, `currentBotToken`, `currentAllowedUserIds`, `currentDbPath`, `currentPollingManager`, `refreshBotContext`.
  - Added focused helpers for verified-token save/start flows.
  - Updated `teleg-setup`, `teleg-connect`, and `teleg-reconnect` so existing v2 token/id config does not prompt unnecessarily and starts only with a non-zero resolved bot id.
  - Updated startup normalization and polling start/auto-restart to use current bot id/token and `currentDbPath()`.
  - Updated status/health/queue/turn/shutdown paths to use guarded polling manager access instead of botId 0 fallback.
  - Updated `/start` pairing to persist allowlist through `updateAllowedUsers(botId, ids)` when a bot id is known.
  - Updated MCP send tools to use resolved token and allowed user ids.
- `src/session-config.ts`
  - `readConfig()` now detects global v2 config and returns a flat `TelegramConfig` for `defaultBotId`.
  - `writeConfig()` now preserves existing v2 config by upserting the active bot entry and preserving other bots instead of flattening the file.

Note: pre-existing uncommitted edits in other files were left untouched except where already present in the working tree before this task.

## Validation
- `npm run build` passes.
- Focused grep confirms no operational bot-0 polling starts remain:
  - No `getPollingManager(... ?? 0)` or `getPollingManager(botId ?? 0)` in `src/index.ts`.
  - Remaining `pm.start(sessionName, ...)` calls use `currentDbPath()` and are reached through helpers/guards with resolved non-zero bot ids.
- V2 session-config smoke test passed using a temporary HOME: `readConfig()` flattened the default bot and `writeConfig()` preserved the second bot while updating the default bot allowlist.

## Remaining risks / out of scope
- This does not implement schema v3 or rebuild legacy `relay_sessions` tables; that was explicitly out of scope.
- Some Telegram reply paths still use `state.config.botToken` directly where unrelated to polling starts. The high-risk operational polling-manager paths were fixed.
