---
type: concept
title: Automation
description: install.sh / teleg CLI channels, deploy.sh Pi wiring, and build/restart workflow.
tags: [automation, deploy, install, cli]
timestamp: 2026-07-24T16:00:00Z
---

# Automation

## Local develop → Pi

```bash
npm run build          # tsc → dist/
./deploy.sh            # packages[] += repo path; strip MCP from Pi mcp.json
# restart Pi session to load extension
./deploy.sh --watch    # optional tsc --watch
```

`deploy.sh` also prefers a `uv` venv and clears AppImage `PYTHONHOME` pollution.

## Host install (`teleg` CLI)

`install.sh` installs as `~/.local/bin/teleg` and clones managed checkout to `$TELEG_HOME` (default `~/.teleg-bridge`).

| Command | Purpose |
|---|---|
| `teleg install [--repo] [--host] [--channel edge\|stable]` | Clone, build, deploy, shim |
| `teleg update [--channel] [--keep]` | Fetch + redeploy |
| `teleg uninstall\|remove [--purge] [-y]` | Remove install |
| `teleg status` / `teleg version` | Health / version |
| `teleg mcp [--app …] [--write]` | Wire MCP into third-party clients |

Channels: **edge** = default branch; **stable** = highest semver tag. Meta: `$TELEG_HOME/.teleg-meta.json`.

## MCP wiring (non-Pi)

```bash
teleg mcp                              # print mcpServers block
teleg mcp --app claude --write         # ~/.claude.json
teleg mcp --app opencode               # print opencode snippet
teleg mcp --app kilo
teleg mcp --path /custom/mcp-server/index.js
```

Do **not** leave teleg-bridge in Pi’s `mcp.json` alongside the extension.

## npm scripts

| Script | Action |
|---|---|
| `build` | `tsc` |
| `build:mcp` | no-op note (MCP is plain JS) |
| `test` | build + `node --test` |
| `deploy` / `deploy:watch` | `./deploy.sh` |
| `install:cli` / `update:cli` / `uninstall:cli` | `./install.sh …` |

## Related

- [Actions → CLI](actions/cli.md)
- [Overview](overview.md)
- [Gotchas](gotchas.md) (dual-load)
