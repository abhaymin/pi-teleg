---
okf_version: "0.1"
title: Actions index
description: All user- and agent-facing actions — Telegram commands, Pi slash, tools, CLI.
---

# Actions

Everything an agent or operator can invoke.

| Page | Surface |
|---|---|
| [Telegram commands](telegram.md) | Chat `/…` handled by the extension |
| [Pi slash commands](pi-slash.md) | `pi.registerCommand` inside Pi |
| [Tools](tools.md) | Extension + MCP `registerTool` set |
| [CLI](cli.md) | `teleg` from `install.sh` |
| [Orchestrate](orchestrate.md) | `/orchestrate` multi-session delegation |

## Quick mental map

```
Human in Telegram  →  telegram.md commands  (+ free-form routed turns)
Human/agent in Pi  →  pi-slash.md + tools.md
Third-party agent  →  tools.md via MCP (+ teleg_listen / teleg_reply)
Host operator      →  cli.md
```

## Related

- [Modules — extension](../modules/extension.md)
- [Gotchas](../gotchas.md)
