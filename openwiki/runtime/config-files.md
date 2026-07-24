---
type: concept
title: Config files and env
description: Global/project JSON shapes, registries, and environment overrides.
tags: [runtime, config, env]
timestamp: 2026-07-24T16:00:00Z
---

# Config files & env

## Global `~/.pi/agent/teleg-bridge.json` (v2)

```json
{
  "version": 2,
  "defaultBotId": 123456789,
  "bots": {
    "123456789": {
      "botToken": "SECRET",
      "botUsername": "my_bot",
      "botId": 123456789,
      "allowedUserIds": [],
      "allowedChatIds": [],
      "lastUpdateId": 0
    }
  }
}
```

Treat tokens as secrets — never commit real values.

## Project `.pi/teleg.json`

May pin `botToken` / `botId` / allowlists / optional `dbPath`. Resolution prefers env, then project, then global default.

## Env

| Variable | Purpose |
|---|---|
| `TELEG_BOT_TOKEN` | Force bot by token |
| `TELEG_BOT_ID` | Force bot by id |
| `TELEG_DB_PATH` | Override SQLite path (split-DB risk) |
| `TELEG_HOME` | Managed install root for CLI |
| `TELEG_LIVENESS_MS` | Heartbeat window |
| `TELEG_DRAIN_INTERVAL_MS` | Drain cadence |
| `TELEG_CLAIM_OTHERS` | Claim other sessions’ pending if `1` |

## Related

- [Database](database.md)
- [Modules — config](../modules/config-db.md)
