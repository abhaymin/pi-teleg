---
type: concept
title: teleg CLI
description: Host lifecycle CLI from install.sh — install, update, MCP wiring.
tags: [actions, cli, install]
timestamp: 2026-07-24T16:00:00Z
---

# `teleg` CLI (`install.sh`)

Shim: `~/.local/bin/teleg`. Managed tree: `$TELEG_HOME` (default `~/.teleg-bridge`). Ensure `~/.local/bin` is on `PATH`.

The CLI **does not open SQLite** — it only installs/updates and wires MCP. The extension and MCP open the shared DB (see [gotchas — SQLite](../gotchas.md)).

## Bootstrap when `teleg` is missing

From a checkout (or after cloning the repo):

```bash
./install.sh install          # or: npm run install:cli
# same as no-args ./install.sh — builds (tsc), runs deploy.sh, installs shim
```

That is enough on a host with Node (use a build that provides `node:sqlite`, ≈**22.5+**) and npm. `teleg install` / `teleg update` always **build + deploy**; a separate `./deploy.sh` is only needed for day-to-day local `src/` iteration without going through `$TELEG_HOME`.

| Subcommand | Purpose |
|---|---|
| `teleg install [--repo] [--host] [--channel edge\|stable]` | Clone, build, deploy, install shim |
| `teleg update [--channel] [--keep]` | Fetch + redeploy |
| `teleg uninstall\|remove [--purge] [-y]` | Remove |
| `teleg status` | Install health |
| `teleg version` | Version / commit |
| `teleg mcp [--app claude\|pi\|omp\|opencode\|kilo] [--write] [--path …]` | Print or merge MCP config |

Also exposed via npm: `install:cli`, `update:cli`, `uninstall:cli`.

See [automation](../automation.md) for deploy vs install distinction.
