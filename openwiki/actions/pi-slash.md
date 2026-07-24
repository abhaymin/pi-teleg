---
type: concept
title: Pi slash commands
description: In-Pi slash commands registered via pi.registerCommand.
tags: [actions, pi, slash]
timestamp: 2026-07-24T16:00:00Z
---

# Pi slash commands

| Command | Purpose |
|---|---|
| `/teleg-setup` | Interactive bot setup |
| `/teleg-status` | Extension status UI |
| `/teleg-connect` / `/teleg-reconnect` | Start / restart polling |
| `/teleg-disconnect` | Stop this session’s bridge |
| `/teleg-disable` / `/teleg-enable` | Persist disable in `teleg-disabled.json` |
| `/teleg-switch-bot` | Switch among registered bots |

Disable persists across restarts until enable + session restart.
