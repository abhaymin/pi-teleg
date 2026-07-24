---
type: concept
title: Relay and sessions
description: HTTP relay, liveness/reconcile, session registry JSON, and capability matching.
tags: [modules, relay, sessions, capabilities]
timestamp: 2026-07-24T16:00:00Z
---

# Relay & sessions

## `src/relay.ts`

Per-session local HTTP relay for `@otherSession` and cross-session forward.

- Paths: `~/.pi/agent/tmp/teleg-relay/{botId-}{sessionName}.json` (port, secret, pid).
- Exports: `startRelayServer`, `stopRelayServer`, `forwardToSession`, handlers for command/complete/shutdown, `getAliveSessionNames`, `cleanStaleRelayFiles`.

## `src/session-registry.ts`

Liveness pipeline: pid → relay file → pid match → HTTP `/health` → heartbeat (`TELEG_LIVENESS_MS`) → DB row.

| Class | Meaning |
|---|---|
| GHOST | Dead PID |
| STALE | Degraded relay/heartbeat |
| LINKED | Healthy |

Exports: `checkSessionLiveness`, `reconcileSessions`, `evictSession`, `electPrimary`, `getLinkedSessions`, `isSessionLinked`, …

## `src/session-config.ts`

Legacy flat helpers + JSON registry I/O: `~/.pi/agent/teleg-sessions.json` (`sessions`, `primaryByBot`). Allowlist helpers: `isAllowedUser`, `isAllowedChat`. Archive root: default `~/pi-teleg-archive`.

## `src/capabilities.ts`

Detect caps from project `INFO_REL.md` / `AGENTS.md` / README → `~/.pi/agent/teleg-capabilities.json`.

`matchMessageToCapability`: URL heuristics (Twitter/YouTube/Reddit) + description keyword overlap. Does **not** treat arbitrary free text as a match just because a session declared caps.

## Related

- [Gotchas — orphans](../gotchas.md)
- [Runtime](../runtime/index.md)
- [Actions — session tools](../actions/tools.md)
