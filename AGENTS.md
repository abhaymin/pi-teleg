# AGENTS

## OpenWiki (maintain by default — even when the user does not ask)

Structured repo docs for agents live in [`openwiki/`](openwiki/index.md)
(OKF-style). Cursor rule: `.cursor/rules/openwiki-maintain.mdc` (`alwaysApply`).

**Self-documentation is mandatory default work**, not an optional follow-up.
Do **not** wait for the user to say “update the wiki”, “document this”, or
“touch OpenWiki”. If the change is material (see list below), updating the
matching wiki pages in the **same change** is part of finishing the task —
same bar as making the code compile.

- **Read:** for layout / modules / actions / runtime / automation / invariants —
  start at `openwiki/index.md`, then the linked concept page (do not dump the
  whole wiki into context).
- **Update in the same change** whenever you add/remove/rename or materially
  change modules, tools/commands, config/DB paths, polling/routing, or hard
  invariants. Touch the matching pages under `openwiki/modules|actions|runtime/`,
  plus `architecture.md` / `automation.md` / `gotchas.md` / root `index.md` as
  needed; append `openwiki/log.md` for non-trivial edits. Prefer why/invariants
  over code dumps; never invent paths that are not on disk.
- Finishing a structural or user-visible feature/API/tool change without an
  OpenWiki update is **incomplete work**, whether or not the user mentioned docs.

## Hard invariants (short)

1. One Telegram `getUpdates` consumer per bot token — respect the poll lock.
2. Scope queue/routing by `bot_id`; no cross-bot claims.
3. Pi loads the native extension only — do not dual-load MCP in Pi.
4. Prefer `openwiki/gotchas.md` and `RELAY_UNASSIGNED_BUG.md` before changing drain/claim logic.
