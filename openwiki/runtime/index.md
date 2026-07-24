---
okf_version: "0.1"
title: Runtime data index
description: On-disk config, SQLite, locks, relay files, media cache, and env vars.
---

# Runtime data

All live state is under **`~/.pi/agent/`** (override DB with `TELEG_DB_PATH`). Not in git.

| Page | Contents |
|---|---|
| [Config files](config-files.md) | JSON configs, registries, env |
| [Database](database.md) | Tables, schema version, key columns |

## Path cheat sheet

| Path | Role |
|---|---|
| `~/.pi/agent/teleg-bridge.json` | Multi-bot global config (v2) |
| `~/.pi/agent/teleg-bridge.db` | Shared SQLite |
| `~/.pi/agent/teleg-sessions.json` | Session registry mirror |
| `~/.pi/agent/teleg-capabilities.json` | Caps registry |
| `~/.pi/agent/teleg-disabled.json` | Disabled project dirs |
| `~/.pi/agent/tmp/teleg-bridge/polling-{botId}.lock` | Poll lock |
| `~/.pi/agent/tmp/teleg-relay/{botId-}{name}.json` | Relay endpoint |
| `~/.pi/agent/tmp/teleg-media/{botId}/` | Inbound media cache |
| `<project>/.pi/teleg.json` | Project bot pin |
| `<project>/INFO_REL.md` | Capability declaration |
| `~/pi-teleg-archive` | Default archive root |

## Related

- [Modules — config-db](../modules/config-db.md)
- [Gotchas](../gotchas.md)
