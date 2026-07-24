# OpenWiki instructions (human brief)

**Default policy:** agents must maintain this wiki in the same change as
structural repo edits. Enforced via `.cursor/rules/openwiki-maintain.mdc`
(`alwaysApply`).

Scope for wiki updates:

1. Prefer documenting **why** and **invariants** over restating source code. Keep [`architecture.md`](architecture.md) accurate when polling, routing, or relay flow changes.
2. Always keep the hard invariants accurate — one `getUpdates` per token, `bot_id` scoping, extension-vs-MCP dual-load, unassigned-queue orphans — see [`gotchas.md`](gotchas.md).
3. When adding tools, Telegram commands, Pi slash commands, or CLI subcommands, update [`actions/`](actions/index.md) and the root [`index.md`](index.md) roster.
4. When adding/removing `src/` modules or MCP surface, update [`modules/`](modules/index.md).
5. Do not invent folders that are not on disk; mark retired/stale docs explicitly (e.g. `docs/PLAN_ACTION.md` checkboxes vs `TASKS.md`).
6. Keep OKF front matter (`type`, `title`, `description`, `tags`) on concept pages; reserved `index.md` / `log.md` stay reserved.
7. Append `log.md` for non-trivial wiki edits.
