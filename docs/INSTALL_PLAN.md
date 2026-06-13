# teleg — Git-based public Install / Update / Remove plan

Status: **plan (not yet implemented)**. Scope: a public, git-based lifecycle for
`teleg-bridge` that wraps the existing `deploy.sh` and `~/.pi/agent/` config
wiring, supporting **any git remote — GitHub, gitlab.com, or self-hosted
GitLab** (the current upstream is a self-hosted GitLab at
`gitlab.abhaymenon.com/abhaymin/pi-teleg`, default branch `dev`).

Design principle: **boring.** No package manager, no binary releases, no service
files. One shell script in the repo + `git` + `deploy.sh`. After the first clone,
the remote is recorded in `.git/config`, so every update is just
`git fetch` → rebuild → redeploy against `origin`.

---

## 0. Grounding facts (current repo)

- `deploy.sh` (3 steps): `npx tsc` → writes `~/.pi/agent/settings.json.packages[]`
  (removes any `teleg` entry, appends absolute checkout path, dedupes by realpath)
  → writes `~/.pi/agent/mcp.json`.
- **Two latent blockers for public use**, both in `deploy.sh`, both fixed in
  Phase 0:
  1. `mcp.json` is written with a `cat > file <<EOF` that **hardcodes**
     `/home/abhaym/Development/PTGD/teleg/mcp-server/index.js` (dev's path).
  2. That same write **clobbers the whole file**, destroying any other
     `mcpServers`/`imports` the user configured.
  `settings.json` writing is already portable and non-destructive — untouched.
- `package.json` has `build` (`tsc`), `build:mcp` (`cd mcp-server && npm install`),
  `deploy` (`./deploy.sh`). No `npm install` is run by `deploy.sh` today, so the
  installer owns dependency install; `deploy.sh` stays build+config only.
- No `install.sh`, no `bin/` dir today — clean to add.
- Remote default branch is **`dev`** (not `main`), and **no tags exist yet** →
  the installer must resolve the remote's default branch dynamically, and the
  "stable" (tag) channel is **opt-in once releases are tagged**; until then only
  the "edge" (track-default-branch) channel is available.

---

## 1. Layout & checkout location

- Checkout lives at **`$TELEG_HOME`**, default **`~/.teleg-bridge`**, overridable
  by `TELEG_HOME` env var (recorded in the meta file after first install so later
  commands find it even if the env is unset — see §6).
- `~/.teleg-bridge/` is a **managed checkout**: it is the `git clone`, holds
  `node_modules`, `dist/`, and `mcp-server/node_modules`. Users must not hand-edit
  files there (updates do `git reset --hard`).
- A stable PATH shim is installed at **`~/.local/bin/teleg`** so `teleg update`
  / `teleg remove` work from anywhere.

Final on-disk shape after install:

```
~/.teleg-bridge/                      # = $TELEG_HOME (the git clone)
  .teleg-meta.json                    # install record (see §6)
  install.sh                          # the script (also the entrypoint)
  src/, dist/, mcp-server/, node_modules/ ...
~/.local/bin/teleg                    # shim -> exec bash $TELEG_HOME/install.sh "$@"
~/.pi/agent/settings.json             # packages[] gains the checkout path (via deploy.sh)
~/.pi/agent/mcp.json                  # mcpServers["teleg-bridge"] added (via deploy.sh)
~/.pi/agent/teleg-bridge.json         # user's bot config — NEVER touched by lifecycle
~/.pi/agent/teleg-bridge.db           # user's SQLite data — NEVER touched by lifecycle
```

---

## 2. The single entrypoint: `install.sh` (lives in repo root)

One script, versioned with the code, dispatching subcommands. Idempotent.
When fetched via the one-liner (§5) and run with **no recognized subcommand** it
defaults to `install`.

```
teleg install    [--repo OWNER/REPO] [--host HOST] [--channel stable|edge]   # clone+build+deploy+shim (idempotent → acts as update if already present)
teleg update     [--channel stable|edge]                                      # in-place git pull + rebuild + redeploy
teleg uninstall  [--purge]            (alias: remove)                         # remove checkout + prune config + deshim
teleg status                                                            # read-only: path/remote/ref/channel/update-available
teleg version                                                           # package.json version + git describe
```

Flags default to the **canonical upstream baked into the script** at release
time (`DEFAULT_REPO`, `DEFAULT_HOST`). Forks override with `--repo`/`--host`.
**No flag is ever host-specific in code** — `git` clone/fetch/pull are identical
for GitHub, gitlab.com, and self-hosted GitLab. The only host-aware piece is the
**first-time raw-fetch URL** in the README one-liner (§5).

Dispatch logic:
- If `$TELEG_HOME/.teleg-meta.json` exists OR script is invoked from inside a
  checkout → operate in "managed" mode using the recorded `$TELEG_HOME`.
- Fresh (no meta, piped from curl, no args) → bootstrap `install`.

---

## 3. `install` (bootstrap + idempotent upgrade)

1. **Preflight** — verify `git`, `node` (≥18), `npm`, `python3`, `curl`/`wget`
   exist; fail fast with a clear message if any missing (install is not attempted
   for the user). Verify `~/.local/bin` is creatable; if not on `PATH`, print the
   `export PATH` hint (don't block).
2. **Resolve remote**: `--repo`/`--host` flags, else baked-in canonical defaults.
   Build clone URL: `https://<host>/<owner>/<repo>.git`.
3. **Clone or reuse**:
   - If `$TELEG_HOME` absent → `git clone --filter=blob:none <url> "$TELEG_HOME"`.
   - If present → treated as an upgrade: `git fetch origin` then proceed to step 5.
4. **cd "$TELEG_HOME"**.
5. **Resolve target ref** (channel-aware, §7):
   - `edge` (default until tags exist) → resolve default branch via
     `git remote show origin | sed -n 's/.*HEAD branch: //p'` (fallback `git symbolic-ref refs/remotes/origin/HEAD`); then
     `git reset --hard origin/<default>`.
   - `stable` → `git fetch --tags`; pick highest semver tag reachable from the
     default branch (`git tag --sort=-v:refname`); `git checkout <tag>` (detached
     HEAD is fine for a managed checkout). If no tags exist → fall back to edge
     with a warning.
   - Never hardcode `main`/`master`/`dev`.
6. **Build**: `npm install`, `npm run build`, `npm run build:mcp`.
7. **Wire Pi config**: `bash ./deploy.sh` (Phase 0 makes it portable + non-clobbering).
8. **Install shim**: write `~/.local/bin/teleg` → `exec bash "$TELEG_HOME/install.sh" "$@"`, `chmod +x`.
9. **Write meta file** (§6) with remote/host/channel/ref/commit/installed_at.
10. **Print restart hint**: "Restart Pi — extension + MCP server load automatically."

`install` on an existing checkout is equivalent to `update`, so re-running the
one-liner is always safe.

---

## 4. `update`

From `$TELEG_HOME`:

1. `git fetch origin --tags` (no auth prompt: `GIT_TERMINAL_PROMPT=0`; a 401/403
   → clear "private repo: set a credentialed remote" message, exit non-zero).
2. **Guard local edits**: if `git status --porcelain` is non-empty, warn that the
   managed checkout is not for edits, and `git reset --hard` unless the user
   passed `--keep` (then `git stash`). Default = reset (managed dir guarantees a
   clean state).
3. **Resolve + advance ref** by channel (§7), same rules as install step 5.
   If already at the latest ref → no-op with "already up to date".
4. `npm install` (deps may have changed), `npm run build`, `npm run build:mcp`.
5. `bash ./deploy.sh` (re-wires config idempotently).
6. Update meta file (`ref`, `commit`, `last_updated`).
7. Restart hint.

`teleg update --channel stable|edge` switches channel and advances to that
channel's latest ref in the same pass.

---

## 5. Public one-liners (GitHub + GitLab, incl. self-hosted)

`install.sh` is fetched raw from the remote the user chooses. Two URL shapes;
the README publishes both, substituting `<owner>/<repo>` (and `<host>` for
self-hosted GitLab):

```
# GitHub
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/HEAD/install.sh | bash

# GitLab (gitlab.com OR self-hosted — same shape)
curl -fsSL https://<host>/<owner>/<repo>/-/raw/HEAD/install.sh | bash
```

Notes baked into README:
- These fetch the script and run it with no args → `install`, cloning the
  **canonical** upstream (or pass `--repo`/`--host` to target a fork).
- To review before running: append `-o install.sh && less install.sh && bash install.sh`.
- For **private repos**, `curl` must carry a token; document
  `curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" …` (GitLab) / the GitHub
  `Authorization: Bearer` variant, and that the cloned remote should likewise be
  credentialed or SSH.
- After first clone, `origin` is fixed in `.git/config`; `teleg update` never
  re-derives the URL, so it works identically across hosts.

---

## 6. Meta file: `$TELEG_HOME/.teleg-meta.json`

The single source of truth for managed state (so `update`/`uninstall`/`status`
work without env vars or `.git` archaeology):

```json
{
  "home": "/home/user/.teleg-bridge",
  "remote": "https://gitlab.abhaymenon.com/abhaymin/pi-teleg.git",
  "host": "gitlab.abhaymenon.com",
  "channel": "edge",
  "ref": "dev",
  "commit": "abc1234",
  "default_branch": "dev",
  "shim": "/home/user/.local/bin/teleg",
  "installed_at": "2026-06-13T12:00:00Z",
  "last_updated": "2026-06-13T12:00:00Z"
}
```

Presence of this file is how `install.sh` distinguishes "managed checkout" from
"fresh bootstrap". If it is missing but `origin` exists, the script reconstructs
`remote`/`host` from `git remote get-url origin` and writes the meta file — this
makes the workflow self-healing if a user hand-cloned first.

---

## 7. Channel & ref resolution (no `main` assumption)

- **Default branch** is discovered, never assumed:
  `git remote show origin | sed -n 's/.*HEAD branch: //p'` → currently `dev`.
- **edge** = track the default branch (`git reset --hard origin/<default>`).
- **stable** = highest semver tag reachable from default branch; detached
  `git checkout <tag>`. **Requires releases to be tagged** (none exist yet —
  see Phase 0 prereq). If no tags → fall back to edge with a one-time warning.
- `teleg status` reports which channel is active and whether an update is
  available (`git fetch` then compare local vs remote ref/tag).

---

## 8. `uninstall` (alias `remove`)

Default = remove code + config wiring, **preserve user data**.

1. Read `$TELEG_HOME` from meta file (arg `--home` overrides).
2. **Prune `~/.pi/agent/settings.json`** (Python, mirror of deploy.sh filter):
   drop any entry from `packages[]` whose path equals the checkout's realpath
   (or, defensively, any `"teleg"`-containing path that no longer exists).
3. **Prune `~/.pi/agent/mcp.json`**: remove the `mcpServers["teleg-bridge"]` key
   only (Phase 0 made this key the only one deploy.sh writes). Leave
   `imports` and all other servers intact.
4. **Remove shim** `~/.local/bin/teleg`.
5. **Remove checkout** `rm -rf "$TELEG_HOME"`.
6. **Preserve** `~/.pi/agent/teleg-bridge.json` (bot config) and
   `~/.pi/agent/teleg-bridge.db` (SQLite data).
7. `--purge` flag additionally deletes those two files (with a confirm prompt
   in interactive mode, or requires `-y` in scripted mode).

---

## 9. Required `deploy.sh` changes (Phase 0 — backward compatible)

Only two edits; both strictly improve current behavior and keep the exact same
files/keys, so the "Pi config wiring" contract is preserved:

1. **Dynamic mcp-server path.** Replace the hardcoded path inside the `mcp.json`
   heredoc with a variable derived from `$SCRIPT_DIR`:
   `TELEG_MCP="$SCRIPT_DIR/mcp-server/index.js"` and reference `"$TELEG_MCP"`
   in an *unquoted* heredoc delimiter (so expansion applies). Fixes the
   dev-machine-only path for everyone.
2. **Non-clobbering `mcp.json`.** Replace `cat > "$MCP_CONFIG_FILE"` (whole-file
   overwrite) with the same Python-load/merge/dump pattern already used for
   `settings.json`: load existing `mcp.json` (or `{}`), ensure `mcpServers`
   exists, set/replace **only** the `teleg-bridge` entry, leave `imports` and all
   other servers untouched, write back. Idempotent and no longer destroys the
   user's other MCPs.

No change to `settings.json` handling (already correct). `deploy.sh` remains the
thing the installer calls for build+config; the installer just adds
dependency install + git lifecycle around it.

---

## 10. `package.json` additions

Add convenience proxies so `npm run …` mirrors `teleg …` for dev use:

```jsonc
"install:cli": "./install.sh install",
"update:cli": "./install.sh update",
"uninstall:cli": "./install.sh uninstall"
```

(Names avoid clashing with npm's reserved `install`. Optional; the `teleg` shim
is the public entrypoint.)

---

## 11. Implementation phases (each independently shippable)

- **Phase 0 — prerequisites.** (a) Make `deploy.sh` portable + non-clobbering
  (§9). (b) Tag the first release (`v0.1.0`) off the default branch so the
  `stable` channel is usable. Verify by running `./deploy.sh` on a clean clone
  in a temp dir and confirming `settings.json` + `mcp.json` are correct and
  non-destructive.
- **Phase 1 — core script.** Add repo-root `install.sh` (dispatcher +
  install/update/uninstall/status/version) and write the `~/.local/bin/teleg`
  shim. No README changes yet. Verify install/update/uninstall cycle locally.
- **Phase 2 — meta + channels.** Add `.teleg-meta.json` read/write, default-branch
  discovery, `stable`/`edge` channel switching, `--purge` data removal,
  self-heal from `origin`. Verify across a github-style remote and the existing
  self-hosted GitLab remote.
- **Phase 3 — docs.** Add an **Install** section to README with the GitHub +
  GitLab (incl. self-hosted) one-liners (§5), private-repo token notes, and the
  `teleg status/version/update/uninstall` reference. Commit `install.sh` so the
  raw-URL one-liners resolve.

---

## 12. Verification matrix (definition of done)

| Scenario | Expected |
|---|---|
| Fresh `curl \| bash` (no args) | Clones to `$TELEG_HOME`, builds, runs deploy.sh, installs shim, meta written |
| `teleg update` (edge) | `git fetch` + `reset --hard origin/<default>`, rebuild, redeploy, meta updated |
| `teleg update` when already latest | No-op message, exit 0 |
| `teleg update --channel stable` | Checks out latest tag (Phase 0); no tags → edge fallback + warning |
| `teleg uninstall` | Checkout + config keys + shim gone; db + bot config preserved |
| `teleg uninstall --purge -y` | Also removes db + bot config |
| Reinstall after uninstall | Clean install, no stale entries |
| GitHub remote one-liner | Installs from github raw, updates via github origin |
| Self-hosted GitLab remote (current upstream) | Installs from `<host>/-/raw/HEAD`, updates via gitlab origin |
| Private repo w/o token | Clear 401 message, exit non-zero, no partial config |
| Missing `git`/`node`/`npm`/`python3` | Fail fast with a hint, before any clone/config change |
| `~/.local/bin` not on PATH | Installs shim, prints export hint |
| Local edits in managed checkout on update | Warn, `reset --hard` (or `--keep` stash) |

## 13. Acceptance mapping

- **"Specified clearly enough to implement directly"** — §2 dispatch, §3 install,
  §4 update, §8 uninstall, §9 deploy.sh edits, §6 meta format, §11 phases.
- **"Supports GitHub and GitLab remotes"** — host-agnostic git ops (§3/§4); raw
  one-liners for GitHub + GitLab incl. self-hosted (§5); the live upstream is
  self-hosted GitLab, proving the arbitrary-host case.
- **"Says where the checkout lives and how updates are applied"** —
  `$TELEG_HOME` (default `~/.teleg-bridge`, §1); updates are in-place
  `git fetch` → channel-aware ref advance → rebuild → `deploy.sh` (§4/§7).
