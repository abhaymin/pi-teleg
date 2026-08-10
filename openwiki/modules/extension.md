---
type: concept
title: Extension entry (index.ts)
description: Pi extension wiring — session lifecycle, Telegram handling, drain timer, tools and slash commands.
tags: [modules, extension, index]
timestamp: 2026-07-25T11:50:00Z
---

# Extension entry — `src/index.ts`

Default export: `function (pi: ExtensionAPI)` — registers Pi commands/tools and owns the live bridge for a session.

## Responsibilities

- Resolve / refresh `BotContext` on `session_start`; warn on split-DB.
- Start relay server; register in DB + JSON session registry.
- Acquire or skip poll lock via `PollingManager` (only one active poller per bot).
- `handleAuthorizedTelegramMessage` — auth, `/` commands, `@session` relay, capability route, group stickiness, activate turn.
- `drainTimer` (~12s) — claim queued work when idle; linked-chat claim; capability-scan unassigned; silent/CLAIM_OTHERS fallbacks.
- Reply context — reconstruct `reply_to_message` + outbound history into the `[telegram]` turn, including **local paths for parent media** (`buildReplyChain` + `collectReplyContextAttachments`) so users need not re-send images.
- Outbound media — `teleg-send_photo/video/document` and attach sends record local paths on `outbound_messages` (schema v6). Chat target: active turn → `allowedChatIds` → `allowedUserIds`.
- Poll-answer / reaction forwarding as steer or context.
- Footer health via `ctx.ui.setStatus` (glyphs only — never dump DEGRADED countdowns into the prompt).
- Telegram Pi system controls: `src/pi-sys-commands.ts` (`/pi`, `/model`, `/think`, `/agent`, …).
- `session_shutdown` — heartbeat stop, unregister, release lock if held.

## Status bar glyphs

| Glyph | Meaning |
|---|---|
| `✓` | healthy |
| `⚠` | degraded (extended auto-fix window) |
| `↻` | poller stopped / reconnecting |
| `🔧` | auto-fix in flight |
| `●` | active Telegram turn |
| `○` | not configured / soft warning |

## Env knobs (session)

| Var | Default | Effect |
|---|---|---|
| `TELEG_DRAIN_INTERVAL_MS` | 12000 | Drain cadence |
| `TELEG_CLAIM_OTHERS` | unset | If `1`, claim other sessions’ pending |
| `TELEG_LIVENESS_MS` | 5m | Heartbeat freshness for registry |
| `TELEG_AUTO_FIX_DEGRADED_MS` | 300000 (5m) | Wait before auto health repair |

## Invariants

- Do not start a second poller if lock held elsewhere.
- Complete or fail every activated queue row (`completeMessage` / `failMessage`).
- Keep tool names in sync with MCP (see [actions/tools](../actions/tools.md)).
- Health ambient state → footer only; detailed repair → `/teleg-fix-health` on demand.

## Related

- [Polling](polling.md)
- [Relay & sessions](relay-sessions.md)
- [Gotchas — auto health](../gotchas.md)

- [Polling](polling.md)
- [Reply context media](../runtime/reply-context.md)
- [Actions](../actions/index.md)
- [Gotchas — orphans / reply media](../gotchas.md)
