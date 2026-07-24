# BUG: User replies orphaned in queue — never relayed to the pi session

**Date:** 2026-07-02  **Severity:** High (silent message loss)  **Component:** message routing / drainTimer (`dist/index.js`)

## Summary
Incoming Telegram messages whose text does **not** contain a declared capability keyword are **never claimed by any session**. They sit in `message_queue` at `status='pending'`, `session_name='unknown'` forever and are never relayed to the pi session. The user's replies appear to vanish; the session occasionally receives an empty `[telegram]` ping instead.

## Symptoms (observed)
- User's free-form replies never reach the session as live `[telegram]` text. Examples that **vanished** (found stuck in the DB):
  - `yes purge`
  - `1`
  - `Any update?`
  - `use the browser token of x.com from browseros and can try from curl`
  - `or try force install yt-dlp`
  - `generate a bug log and save so that I can fix on the main code`
  - `I had asked you to use browseros when you are directly able to download`
- Messages that **do** contain a capability keyword (e.g. an `x.com/…` URL, "download", "scan") are claimed and relayed correctly.
- The session receives empty `[telegram] (no text)` pings even when the corresponding queue row has real text.
- Telegram **poll votes** never reach the session at all (poll_answer updates have no message text).

## Evidence (`~/.pi/agent/teleg-bridge.db`)
```
status x session_name counts:
  completed | data-scrapper | 159
  completed | unknown       | 51      ← completed but never assigned to a session
  pending   | unknown       | 1       ← orphaned (current: id 245 "generate a bug log…")
  processing| data-scrapper | 2       ← stuck mid-flight (ids 232, 244; both empty text)
```
Stuck rows at time of report:
- `id=245 pending session=unknown text='generate a bug log and save so that I can fix on the main code'`
- `id=244 processing session=data-scrapper text=''` (empty)
- `id=232 processing session=data-scrapper text=''` (empty, ~20h old)
Earlier orphans (now completed only because the agent read the DB manually): ids 233–237, 240.

## Architecture (how a message is supposed to flow)
1. `dist/poll-worker.js:148-153` — worker polls `getUpdates`, **inserts every message with `session_id='unassigned'`, `session_name='unknown'`, `status='pending'`**, then `post({type:"message"})` to the main thread.
2. `dist/poll-worker.js:192-193` — startup recovery resets stale `processing` (>60s) back to `pending`/`unknown`.
3. `dist/index.js` main thread — per-session **drainTimer** (`setInterval`, ~line 2424) is the only thing that promotes `pending→processing` and relays to the session.

## Root cause
`dist/index.js` drainTimer, the capability-scan block (lines ~2456–2483):

```js
const myCaps = capReg.entries.find(e => e.sessionId === sessionId);
if (myCaps && myCaps.capabilities.length > 0) {
  const unassignedRows = Db.getDb().prepare(
    "SELECT * FROM message_queue WHERE bot_id=? AND status='pending' AND (session_name='unknown' OR session_name IS NULL) ORDER BY id ASC LIMIT 25"
  ).all(botId);
  for (const unassigned of unassignedRows) {
    const text = unassigned.text || "";
    const match = matchMessageToCapability(text, [myCaps]);   // ← only keyword matches are claimed
    if (match) { /* UPDATE → processing + session_name; activateTurn; sendUserMessage */ }
  }
}
```

A session **with declared capabilities** (data-scrapper) will only claim an unassigned message if `matchMessageToCapability(text)` returns true — i.e. the text contains one of the session's capability keywords (e.g. `x.com`, `reddit`, `download`, `scan`, …). **Any reply without such a keyword is skipped and remains `unknown`/`pending` indefinitely.**

The two fallbacks below it do **not** cover this case:
- `claimNextTurnForSilentSession()` (line 2484) — only drains for sessions **without** capabilities ("silent" sessions). data-scrapper has caps → not eligible.
- `if (CLAIM_OTHERS) claimNextTurn()` (line 2490) — gated by a flag and aimed at *other sessions'* tagged work, not at unassigned `unknown` rows.

Net effect: with a single capable session on the bot, every non-keyword user reply is an orphan.

Secondary issues seen alongside:
- `processing` rows stuck with empty text (ids 232, 244): a turn was activated (claimed) but never completed — no completion safety-net for a turn whose delivery/ack fails.
- Empty `[telegram]` pings: the session is fed an empty content payload in some claim path even when the DB row has text (likely a separate serialization/extraction issue worth tracing, but the primary loss is the unclaimed rows above).
- Poll votes (`poll_answer`) are forwarded to the main thread (`poll-worker.js:219`) but there is no path that turns them into a relayed `[telegram]` message for the session.

## Suggested fixes (pick by preference)
1. **Primary-session catch-all (recommended).** In the drainTimer, after the capability-scan loop, if this session is the **default/primary bot session** (or the only alive session on the bot), claim the next remaining `unknown`/`pending` row unconditionally:
   ```js
   // after the capability for-loop, before claimNextTurnForSilentSession
   const isPrimary = await isPrimarySession(botId, sessionName); // or aliveSessions.length === 1
   if (isPrimary) {
     const row = Db.getDb().prepare(
       "SELECT * FROM message_queue WHERE bot_id=? AND status='pending' AND (session_name='unknown' OR session_name IS NULL) ORDER BY id ASC LIMIT 1"
     ).get(botId);
     if (row) { /* claim → processing + session_name; activateTurn with text */ }
   }
   ```
   This guarantees every user message reaches the primary session even when it carries no capability keyword — which matches user expectation for a single-session bot.
2. **Broaden `matchMessageToCapability`** to always return a match for the primary/default session (so the existing scan claims everything).
3. **Treat "no capabilities match" as fallback-to-primary** instead of dropping: if no capable session matches an unassigned row within N seconds, route it to the primary session.
4. **Completion safety-net:** add a watchdog that completes/republishes `processing` rows whose turn never acked (the empty `processing` rows 232/244). The 60s recovery in poll-worker only handles the worker side; an activated turn that never completes needs its own timeout.
5. **Poll votes:** convert `poll_answer` (and `poll`) forwards into a relayed `[telegram]` content line (e.g. `[telegram] [poll vote] option: "<text>"`) so votes reach the session.

## Reproduction
1. Bot with one capable session (data-scrapper). Session is live (relay linked).
2. From Telegram, send a plain reply with no capability keyword, e.g. `hello world` or `yes`.
3. Observe: session never receives it; row stays `pending`/`unknown` in `message_queue`.
4. Send a keyword message, e.g. `https://x.com/foo/status/123` → claimed + relayed promptly.

## Files / line references (dist)
- `dist/poll-worker.js:148-153` — insert as `unknown`/pending.
- `dist/poll-worker.js:192-193` — stale-processing recovery (worker-scoped).
- `dist/index.js:2424-2501` — per-session drainTimer.
- `dist/index.js:2456-2483` — capability-only claim of unassigned rows (**primary bug site**).
- `dist/index.js:2484-2489` — `claimNextTurnForSilentSession` (silent-session fallback; doesn't help capable sessions).
- `dist/index.js:2490-2496` — `CLAIM_OTHERS` catch-all (gated; not for unassigned `unknown`).
- `matchMessageToCapability` (capabilities module) — keyword matcher that gates claiming.
- INFO_REL.md (data-scrapper) — the declared capability keywords that DO match.

## Quick mitigation (operator-side, no code)
Until fixed, the agent can recover orphaned replies by reading `message_queue` directly:
`SELECT id,text FROM message_queue WHERE status='pending' AND session_name='unknown' ORDER BY id;`
(and `processing` rows stuck >60s). A cron that re-posts these to the session, or a `/replay` command, would paper over it.
