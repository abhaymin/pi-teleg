---
type: concept
title: teleg CLI
description: Host lifecycle CLI from install.sh — install, update, MCP wiring.
tags: [actions, cli, install]
timestamp: 2026-07-24T16:00:00Z
---

# `teleg` CLI (`install.sh`)

Shim: `~/.local/bin/teleg`. Managed tree: `$TELEG_HOME` (default `~/.teleg-bridge`).

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
