# Phase 3 Integration Guide

## What was implemented

### polling-manager.ts (new)
- `PollingManager` class with botId scoping, per-bot lock files, worker lifecycle
- `getPollingManager(botId)` registry (Map) — singleton per botId
- Lock file format: `polling-{botId}.lock` with pid, timestamp, botId, sessionName
- Offset tracking via `config.saveLastUpdateId()` after batches
- Worker message handler for offset saves

### poll-worker.ts (modified)
- Added `offset` message type to both `WorkerMessage` (incoming) and `MainMessage` (outgoing)
- Worker posts `{ type: "offset", botId, lastUpdateId }` after each batch

## What remains: index.ts integration

The current `SharedPollingManager` IIFE (lines 386-1212) handles many operations that the new `PollingManager` class doesn't yet cover:

### Core integration points needed:

1. **Import the new module:**
```typescript
import { getPollingManager, type PollingManager } from "./polling-manager.js";
```

2. **Replace polling lifecycle calls:**
   - `SharedPollingManager.start()` → `getPollingManager(botId).start(sessionName, dbPath)`
   - `SharedPollingManager.stop()` → `getPollingManager(botId).stop()`
   - `SharedPollingManager.isActive()` → `getPollingManager(botId).isActive()`
   - `SharedPollingManager.isHeldByOther()` → `getPollingManager(botId).isHeldByOther()`

3. **Wire message handler:**
```typescript
const pm = getPollingManager(botId);
pm.onMessage(async (update, dbId) => {
  // Use existing handleWorkerMessage logic, adapted for new signature
});
pm.onHealth((state) => { pollState = state; });
```

4. **Set bot token config:**
```typescript
getPollingManager(botId).setConfig(botToken, lastUpdateId);
```

### Missing from PollingManager (needs addition):

The current `SharedPollingManager` also handles these - they need to be added to `PollingManager`:

- `sendReply(chatId, messageId, text)` — Telegram sendMessage
- `sendFile(chatId, messageId, filePath)` — Telegram sendPhoto/sendVideo
- `verifyToken(token)` — getMe call to validate token
- `claimNextTurn(sessionId, sessionName)` — DB claim logic
- `claimNextTurnForSession(sessionName)` — session-scoped claim
- `completeTurn(sessionId, dbId?)` — mark message complete
- `hasActiveTurnFor(sessionId)` — check if session busy
- `getBotInfo()` — bot username/id
- `getBotId()` — current bot ID

### Migration strategy:

Option A: Add missing methods to PollingManager, then cut over index.ts
Option B: Keep SharedPollingManager for DB/send operations, use PollingManager only for polling lifecycle

Option B is safer for incremental migration. The PollingManager handles:
- Lock acquisition/release
- Worker spawn/terminate
- Health state tracking

SharedPollingManager continues to handle:
- Queue operations (claim, complete)
- Telegram sends (reply, photo, video)
- Token verification

This separates concerns: polling lifecycle vs message processing.

## Files changed

- `src/polling-manager.ts` — NEW (complete)
- `src/poll-worker.ts` — modified (offset messaging added)
- `src/index.ts` — integration pending

## Status

Build passes. Phase 3 core implementation complete. Integration with index.ts is the next step before Phase 4.