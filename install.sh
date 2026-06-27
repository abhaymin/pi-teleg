#!/usr/bin/env bash
# teleg-bridge — git-based install / update / remove lifecycle.
#
# A single dispatcher script, versioned with the code. Git ops are host-agnostic,
# so the same flow works for GitHub, gitlab.com, and self-hosted GitLab.
#
#   teleg install   [--repo OWNER/REPO] [--host HOST] [--channel stable|edge]
#   teleg update    [--channel stable|edge] [--keep]
#   teleg uninstall [--home PATH] [--purge] [-y]        (alias: remove)
#   teleg status
#   teleg version
#
# Piped from curl with no args → `install` (bootstrap). See docs/INSTALL_PLAN.md.

set -uo pipefail

# ── Canonical upstream (overridable via --repo / --host) ─────────────────────
DEFAULT_HOST="gitlab.abhaymenon.com"
DEFAULT_REPO="abhaymin/pi-teleg"
DEFAULT_CHANNEL="edge"          # edge until releases are tagged
SHIM_NAME="teleg"
SHIM_DIR="$HOME/.local/bin"
export GIT_TERMINAL_PROMPT=0          # never prompt for git credentials

# ── Logging / control ────────────────────────────────────────────────────────
log()  { printf '%s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
die()  { printf '✖  %s\n' "$*" >&2; exit 1; }

script_dir_abs() {
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || d="$PWD"
  printf '%s\n' "$d"
}

# ── Managed-home resolution ──────────────────────────────────────────────────
# Order: $TELEG_HOME env → meta's `home` field → default managed location.
resolve_home() {
  if [[ -n "${TELEG_HOME:-}" ]]; then printf '%s\n' "$TELEG_HOME"; return; fi
  local sd; sd="$(script_dir_abs)"
  if [[ -f "$sd/.teleg-meta.json" ]]; then
    local h; h="$(META_FILE="$sd/.teleg-meta.json" meta_read home)"
    printf '%s\n' "${h:-$sd}"; return
  fi
  printf '%s\n' "$HOME/.teleg-bridge"
}

# ── Meta file (.teleg-meta.json) read/write via python3 (no jq dependency) ───
meta_read() {  # $1 = key   (reads $META_FILE)
  python3 - "$1" <<'PY'
import json, os, sys
try:
    d = json.load(open(os.environ["META_FILE"]))
except Exception:
    d = {}
v = d.get(sys.argv[1], "")
print(v if v is not None else "")
PY
}

meta_write() {  # args: key=val ...   (merges into $META_FILE)
  python3 - "$@" <<'PY'
import json, os, sys
try:
    d = json.load(open(os.environ["META_FILE"]))
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
for kv in sys.argv[1:]:
    k, _, v = kv.partition("=")
    d[k] = v
json.dump(d, open(os.environ["META_FILE"], "w"), indent=2)
PY
}

# ── Default-branch discovery (never assume main / master / dev) ──────────────
resolve_default_branch() {
  local branch=""
  # 1. Local record of origin's HEAD (instant; reliable for a fresh clone).
  branch="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)"
  branch="${branch#origin/}"
  [[ -n "$branch" ]] && { printf '%s\n' "$branch"; return; }
  # 2. Ask the remote (authoritative; needs network — used as fallback).
  branch="$(git remote show origin 2>/dev/null \
            | sed -n 's/.*HEAD branch: //p' | head -n1 | tr -d '[:space:]')"
  [[ -n "$branch" ]] && { printf '%s\n' "$branch"; return; }
  # 3. Any origin/* ref.
  branch="$(git for-each-ref --format='%(refname:short)' refs/remotes/origin 2>/dev/null \
            | grep -v '^origin/HEAD$' | head -n1)"
  branch="${branch#origin/}"
  printf '%s\n' "${branch:-main}"
}

# Highest semver tag reachable from the default branch (empty if none).
latest_tag() {
  local def t
  def="origin/$(resolve_default_branch)"
  t="$(git tag --sort=-v:refname --merged "$def" 2>/dev/null | head -n1 | tr -d '[:space:]')"
  [[ -n "$t" ]] && { printf '%s\n' "$t"; return; }
  t="$(git tag --sort=-v:refname 2>/dev/null | head -n1 | tr -d '[:space:]')"
  printf '%s\n' "$t"
}

# ── Preflight ────────────────────────────────────────────────────────────────
preflight() {
  local missing=()
  for c in git node npm python3; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    missing+=("curl/wget")
  fi
  if ((${#missing[@]})); then
    die "Missing required commands: ${missing[*]}. Install them, then re-run."
  fi
  local maj; maj="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  (( maj >= 18 )) || die "Node.js >=18 required (found $(node -v 2>/dev/null || echo unknown))."
  mkdir -p "$SHIM_DIR"
  case ":$PATH:" in
    *":$SHIM_DIR:"*) ;;
    *) warn "$SHIM_DIR is not on PATH. Add:  export PATH=\"$SHIM_DIR:\$PATH\"";;
  esac
}

install_shim() {
  local home; home="$(resolve_home)"
  mkdir -p "$SHIM_DIR"
  cat > "$SHIM_DIR/$SHIM_NAME" <<EOF
#!/usr/bin/env bash
# Managed by teleg-bridge lifecycle — do not edit.
exec bash "$home/install.sh" "\$@"
EOF
  chmod +x "$SHIM_DIR/$SHIM_NAME"
}

# Build the checkout in CWD, then re-wire Pi config via deploy.sh.
build_and_deploy() {
  local home; home="$(resolve_home)"
  log "[build] npm install"
  npm install --no-audit --no-fund
  log "[build] npm run build"
  npm run build
  log "[build] npm run build:mcp"
  npm run build:mcp
  log "[deploy] deploy.sh (wires ~/.pi/agent config)"
  bash "$home/deploy.sh"
}

# Advance checkout to the channel's target ref. Echoes the resolved ref label.
# Returns 0 if HEAD moved, 1 if it was already there (used for "up to date").
checkout_channel() {  # $1 = channel
  local channel="$1" before after
  before="$(git rev-parse HEAD 2>/dev/null || echo "")"

  if [[ "$channel" == "stable" ]]; then
    local tag; tag="$(latest_tag)"
    if [[ -z "$tag" ]]; then
      warn "No release tags found — falling back to edge channel."
      channel="edge"
    else
      git checkout --quiet "$tag"
    fi
  fi
  if [[ "$channel" == "edge" ]]; then
    local def; def="$(resolve_default_branch)"
    git reset --quiet --hard "origin/$def"
  fi

  after="$(git rev-parse HEAD 2>/dev/null || echo "")"
  if [[ "$before" != "$after" ]]; then return 0; else return 1; fi
}

# Actual origin URL recorded in .git/config (authoritative after first clone).
origin_url() { git remote get-url origin 2>/dev/null | head -n1; }

# Parse a host out of an https or SSH git URL (empty if not a remote URL).
url_host() {  # $1 = url
  local u="$1"
  [[ "$u" =~ ^https?://([^/]+) ]] && { printf '%s\n' "${BASH_REMATCH[1]}"; return; }
  [[ "$u" =~ ^[^[:space:]]+@([^:]+): ]] && { printf '%s\n' "${BASH_REMATCH[1]}"; return; }
}

ref_label_for() {  # $1 = channel   (echoes a human-readable ref label)
  local channel="$1" def lbl
  def="$(resolve_default_branch)"
  if [[ "$channel" == "stable" ]]; then
    lbl="$(latest_tag)"; [[ -z "$lbl" ]] && lbl="$def"
  else
    lbl="$def"
  fi
  printf '%s\n' "$lbl"
}

write_meta() {  # $1=phase(install|update) $2=home $3=url $4=host $5=channel $6=ref $7=commit $8=default
  local phase="$1" home="$2" url="$3" host="$4" channel="$5" ref="$6" commit="$7" def="$8"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export META_FILE="$home/.teleg-meta.json"
  if [[ "$phase" == "install" && ! -f "$META_FILE" ]]; then
    meta_write "home=$home" "remote=$url" "host=$host" "channel=$channel" \
               "ref=$ref" "commit=$commit" "default_branch=$def" \
               "shim=$SHIM_DIR/$SHIM_NAME" "installed_at=$now" "last_updated=$now"
  else
    meta_write "home=$home" "remote=$url" "host=$host" "channel=$channel" \
               "ref=$ref" "commit=$commit" "default_branch=$def" \
               "shim=$SHIM_DIR/$SHIM_NAME" "last_updated=$now"
  fi
}

# ── install ──────────────────────────────────────────────────────────────────
cmd_install() {
  local orig=("${@:+$@}")
  local repo="$DEFAULT_REPO" host="" channel=""
  while (($#)); do
    case "$1" in
      --repo)   repo="${2:-}"; shift 2 || die "--repo needs a value";;
      --host)   host="${2:-}"; shift 2 || die "--host needs a value";;
      --channel) channel="${2:-}"; shift 2 || die "--channel needs a value";;
      -h|--help) usage; exit 0 ;;
      *) die "install: unknown argument '$1'";;
    esac
  done
  [[ -n "$channel" ]] || channel="$DEFAULT_CHANNEL"
  { [[ "$channel" == "stable" || "$channel" == "edge" ]]; } || die "channel must be 'stable' or 'edge'"

  preflight

  local home; home="$(resolve_home)"
  local sd; sd="$(script_dir_abs)"

  # Bootstrap: clone a fresh managed checkout, then re-exec the in-checkout script
  # so the version of install.sh that runs is the one shipped in the code.
  if [[ "$home" != "$sd" ]] && [[ ! -d "$home/.git" ]]; then
    if [[ -e "$home" ]] && [[ -n "$(ls -A "$home" 2>/dev/null)" ]]; then
      die "$home exists and is not a teleg checkout. Remove it or set TELEG_HOME."
    fi
    local url="https://${host:-$DEFAULT_HOST}/${repo:-$DEFAULT_REPO}.git"
    log "[install] cloning $url → $home"
    GIT_TERMINAL_PROMPT=0 git clone --filter=blob:none "$url" "$home" \
      || die "clone failed (private repo? configure a token/SSH remote, or pass --repo/--host)."
    # Re-exec the in-checkout script (authoritative copy) with TELEG_HOME pinned.
    exec env TELEG_HOME="$home" bash "$home/install.sh" install "${orig[@]+"${orig[@]}"}"
  fi

  # In-place: managed checkout or dev self-install. origin is authoritative.
  cd "$home" || die "cannot cd to $home"
  local ourl; ourl="$(origin_url)"
  local meta_host
  if [[ -n "$host" ]]; then meta_host="$host"; else meta_host="$(url_host "$ourl")"; fi
  [[ -n "$meta_host" ]] || meta_host="$DEFAULT_HOST"

  export GIT_TERMINAL_PROMPT=0
  log "[install] fetching origin"
  git fetch origin --tags 2>/dev/null \
    || die "git fetch failed (private repo? configure a credentialed or SSH remote)."

  log "[install] channel=$channel → advancing to target ref"
  checkout_channel "$channel" || true

  build_and_deploy
  install_shim

  local def ref commit
  def="$(resolve_default_branch)"
  ref="$(ref_label_for "$channel")"
  commit="$(git rev-parse --short HEAD)"
  write_meta install "$home" "$ourl" "$meta_host" "$channel" "$ref" "$commit" "$def"

  log ""
  log "✓ teleg-bridge installed at $home"
  log "  channel: $channel   ref: $ref   commit: $commit"
  log "  shim:    $SHIM_DIR/$SHIM_NAME"
  log "  Restart Pi — extension + MCP server load automatically."
}

# ── update ───────────────────────────────────────────────────────────────────
cmd_update() {
  local channel="" keep=false
  while (($#)); do
    case "$1" in
      --channel) channel="${2:-}"; shift 2 || die "--channel needs a value";;
      --keep) keep=true; shift;;
      -h|--help) usage; exit 0 ;;
      *) die "update: unknown argument '$1'";;
    esac
  done

  local home; home="$(resolve_home)"
  [[ -d "$home/.git" ]] || die "No teleg checkout at $home. Run 'teleg install' first."
  cd "$home" || die "cannot cd to $home"

  export META_FILE="$home/.teleg-meta.json"
  export GIT_TERMINAL_PROMPT=0
  [[ -n "$channel" ]] || channel="$(meta_read channel)"
  [[ -n "$channel" ]] || channel="$DEFAULT_CHANNEL"
  { [[ "$channel" == "stable" || "$channel" == "edge" ]]; } || die "channel must be 'stable' or 'edge'"

  log "[update] fetching origin"
  git fetch origin --tags 2>/dev/null \
    || die "git fetch failed (private repo? configure a credentialed or SSH remote)."

  # Guard local edits in the managed checkout (it is not for hand edits).
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    if $keep; then
      warn "Local edits present; stashing uncommitted + untracked (--keep)."
      git stash --include-untracked --quiet || warn "stash failed; continuing"
    else
      warn "Local edits present in managed checkout; discarding (use --keep to stash)."
      git reset --hard --quiet || true
      git clean -fdq
    fi
  fi

  local moved=false
  if checkout_channel "$channel"; then moved=true; fi
  local ourl meta_host def ref commit
  ourl="$(origin_url)"
  meta_host="$(url_host "$ourl")"; [[ -n "$meta_host" ]] || meta_host="$DEFAULT_HOST"
  def="$(resolve_default_branch)"
  ref="$(ref_label_for "$channel")"
  commit="$(git rev-parse --short HEAD)"

  if $moved; then
    build_and_deploy
    log "✓ teleg-bridge updated — $channel, $ref @ $commit"
  else
    log "teleg-bridge already up to date ($channel, $ref @ $commit)."
  fi

  install_shim
  write_meta update "$home" "$ourl" "$meta_host" "$channel" "$ref" "$commit" "$def"
}

# ── uninstall (alias: remove) ────────────────────────────────────────────────
prune_settings() {  # $1 = checkout home   $2 = settings.json
  CHECKOUT_HOME="$1" SETTINGS_JSON="$2" python3 <<'PY'
import json, os
home = os.path.realpath(os.environ["CHECKOUT_HOME"])
try:
    s = json.load(open(os.environ["SETTINGS_JSON"]))
except Exception:
    s = {}
if not isinstance(s, dict):
    s = {}
pkgs = s.get("packages", [])
kept = []
for p in pkgs:
    real = os.path.realpath(p) if os.path.exists(p) else p
    if real == home:
        continue
    if "teleg" in p.lower() and not os.path.exists(p):
        continue
    kept.append(p)
s["packages"] = kept
json.dump(s, open(os.environ["SETTINGS_JSON"], "w"), indent=2)
PY
}

prune_mcp() {  # $1 = mcp.json   (remove only mcpServers["teleg-bridge"])
  MCP_JSON="$1" python3 <<'PY'
import json, os
try:
    m = json.load(open(os.environ["MCP_JSON"]))
except Exception:
    m = {}
if not isinstance(m, dict):
    m = {}
servers = m.get("mcpServers", {})
if isinstance(servers, dict):
    servers.pop("teleg-bridge", None)
    m["mcpServers"] = servers
json.dump(m, open(os.environ["MCP_JSON"], "w"), indent=2)
PY
}

cmd_uninstall() {
  local purge=false yes=false home_override=""
  while (($#)); do
    case "$1" in
      --home) home_override="${2:-}"; shift 2 || die "--home needs a value";;
      --purge) purge=true; shift;;
      -y|--yes) yes=true; shift;;
      -h|--help) usage; exit 0 ;;
      *) die "uninstall: unknown argument '$1'";;
    esac
  done

  local home
  if [[ -n "$home_override" ]]; then home="$home_override"; else home="$(resolve_home)"; fi
  export META_FILE="$home/.teleg-meta.json"

  local agent_dir="$HOME/.pi/agent"

  if [[ -f "$agent_dir/settings.json" ]]; then
    prune_settings "$home" "$agent_dir/settings.json"
    log "  pruned teleg from $agent_dir/settings.json"
  fi
  if [[ -f "$agent_dir/mcp.json" ]]; then
    prune_mcp "$agent_dir/mcp.json"
    log "  removed teleg-bridge from $agent_dir/mcp.json"
  fi

  rm -f "$SHIM_DIR/$SHIM_NAME"
  log "  removed shim $SHIM_DIR/$SHIM_NAME"

  if $purge; then
    local bot_cfg="$agent_dir/teleg-bridge.json" db="$agent_dir/teleg-bridge.db"
    if ! $yes; then
      if [[ -t 0 ]]; then
        printf 'This will delete %s and %s[-shm,-wal]. Proceed? [y/N] ' "$bot_cfg" "$db"
        local r; read -r r || r=""
        [[ "$r" =~ ^[Yy]$ ]] || { log "Aborted (nothing purged)."; }
        [[ "$r" =~ ^[Yy]$ ]] || purge=false
      else
        die "Refusing to --purge non-interactively without -y."
      fi
    fi
    if $purge; then
      rm -f "$bot_cfg" "$db" "$db-shm" "$db-wal"
      log "  purged bot config + database"
    fi
  fi

  # Remove the managed checkout. Sanity-check the path first (never blow away $HOME/"/").
  if [[ -z "$home" || "$home" == "/" || "$home" == "$HOME" ]]; then
    warn "Refusing to remove checkout at '$home' (looks unsafe); remove it manually."
  else
    rm -rf "$home"
    log "  removed checkout $home"
  fi

  if $purge; then
    log "✓ teleg-bridge uninstalled (user data purged)."
  else
    log "✓ teleg-bridge uninstalled (bot config + database preserved)."
  fi
}

# ── status ───────────────────────────────────────────────────────────────────
cmd_status() {
  local home; home="$(resolve_home)"
  if [[ ! -d "$home/.git" ]]; then
    log "teleg-bridge is not installed (no checkout at $home)."
    exit 0
  fi
  cd "$home" || die "cannot cd to $home"
  export META_FILE="$home/.teleg-meta.json"

  local remote host channel commit def ref
  remote="$(origin_url)"; [[ -z "$remote" ]] && remote="?"
  host="$(meta_read host)"; [[ -z "$host" ]] && host="$(url_host "$remote")"
  channel="$(meta_read channel)"; [[ -z "$channel" ]] && channel="$DEFAULT_CHANNEL"
  commit="$(git rev-parse --short HEAD)"
  def="$(resolve_default_branch)"
  if [[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" == "HEAD" ]]; then
    ref="$(git describe --tags --exact-match 2>/dev/null || echo "$commit (detached)")"
  else
    ref="$(git rev-parse --abbrev-ref HEAD)"
  fi

  log "teleg-bridge status"
  log "  home:            $home"
  log "  remote:          $remote"
  log "  host:            $host"
  log "  channel:         $channel"
  log "  current ref:     $ref ($commit)"
  log "  default branch:  $def"

  export GIT_TERMINAL_PROMPT=0
  local update_line="  update:          (could not reach remote)"
  if git fetch origin --tags -q 2>/dev/null; then
    local target_commit=""
    if [[ "$channel" == "stable" ]]; then
      local t; t="$(latest_tag)"
      [[ -n "$t" ]] && target_commit="$(git rev-parse "${t}^{commit}" 2>/dev/null)"
    else
      target_commit="$(git rev-parse "origin/$def" 2>/dev/null)"
    fi
    if [[ -n "$target_commit" ]]; then
      if [[ "$target_commit" == "$(git rev-parse HEAD)" ]]; then
        update_line="  update:          up to date"
      else
        update_line="  update:          UPDATE AVAILABLE"
      fi
    fi
  fi
  log "$update_line"
}

# ── version ──────────────────────────────────────────────────────────────────
cmd_version() {
  local home; home="$(resolve_home)"
  local pkg_ver="?" git_desc=""
  if [[ -f "$home/package.json" ]]; then
    pkg_ver="$(PKG="$home/package.json" python3 -c \
      'import json,os;print(json.load(open(os.environ["PKG"])).get("version","?"))' 2>/dev/null || echo "?")"
  fi
  if [[ -d "$home/.git" ]]; then
    git_desc="$(cd "$home" 2>/dev/null && git describe --tags --always --dirty 2>/dev/null || true)"
  fi
  log "teleg-bridge ${pkg_ver}${git_desc:+ ($git_desc)}"
}

# ── mcp: emit / install the standalone MCP config for third-party clients ────
# The Pi extension is wired separately by deploy.sh. This command only deals
# with the standalone stdio MCP server (mcp-server/index.js) for other apps:
# omp, opencode, Claude Code, Kilo Code, or any mcpServers-style client.
mcp_server_path() { printf '%s/mcp-server/index.js\n' "$(resolve_home)"; }

cmd_mcp() {
  local app="" do_write=false mcp_path
  mcp_path="$(mcp_server_path)"
  while (($#)); do
    case "$1" in
      --app)   app="${2:-}"; shift 2 ;;
      --write) do_write=true; shift ;;
      --path)  mcp_path="$2"; shift 2 ;;
      -h|--help)
        grep -q 'teleg mcp' "$0" 2>/dev/null && sed -n '/^  teleg mcp/,/^$/p' "$0" | sed 's/^  //'
        return 0 ;;
      *) die "Unknown flag '$1' (see: teleg mcp -h)" ;;
    esac
  done

  [[ -f "$mcp_path" ]] || warn "MCP server not found at $mcp_path (still emitting config)."

  local entry
  entry="$(MCP_PATH="$mcp_path" python3 - <<'PY'
import json, os
p = os.environ["MCP_PATH"]
print(json.dumps({"command": "node", "args": [p]}))
PY
)"

  # No --app: print the standard mcpServers block (Claude Code / omp / generic).
  if [[ -z "$app" ]]; then
    log "Add this to your MCP client config under \"mcpServers\":"
    log ""
    MCP_PATH="$mcp_path" python3 - <<'PY'
import json, os
p = os.environ["MCP_PATH"]
print(json.dumps({"mcpServers": {"teleg-bridge": {"command": "node", "args": [p]}}}, indent=2))
PY
    log ""
    log "App-specific hints:"
    log "  claude   teleg mcp --app claude --write   →  ~/.claude.json (mcpServers)"
    log "  omp/pi   already wired by deploy.sh        →  ~/.pi/agent/mcp.json"
    log "  opencode teleg mcp --app opencode          →  print opencode format"
    log "  kilo     teleg mcp --app kilo              →  print kilo format"
    return 0
  fi

  local target kind
  case "$app" in
    claude|claude-code)
      target="$HOME/.claude.json"; kind="mcpServers" ;;
    pi|omp)
      target="$HOME/.pi/agent/mcp.json"; kind="mcpServers" ;;
    opencode)
      # opencode uses a top-level "mcp" object with type/command/enabled entries.
      log "opencode snippet (merge into opencode.json under \"mcp\"):"
      log ""
      MCP_PATH="$mcp_path" python3 - <<'PY'
import json, os
print(json.dumps({"mcp": {"teleg-bridge": {"type": "local", "command": ["node", os.environ["MCP_PATH"]], "enabled": True}}}, indent=2))
PY
      [[ "$do_write" == true ]] && warn "opencode config locations vary — copy the snippet above into your opencode.json."
      return 0 ;;
    kilo|kilo-code)
      log "Kilo Code snippet (merge into Kilo Code settings under \"mcpServers\"):"
      log ""
      MCP_PATH="$mcp_path" python3 - <<'PY'
import json, os
print(json.dumps({"mcpServers": {"teleg-bridge": {"command": "node", "args": [os.environ["MCP_PATH"]], "disabled": False, "autoApprove": []}}}, indent=2))
PY
      [[ "$do_write" == true ]] && warn "Kilo Code stores MCP via its UI/extension settings — copy the snippet above."
      return 0 ;;
    *) die "Unknown app '$app'. Try: claude, pi, omp, opencode, kilo" ;;
  esac

  # mcpServers-style targets (claude, pi/omp): merge non-clobberingly on --write.
  if [[ "$do_write" == true ]]; then
    [[ -n "$target" ]] || die "no target path for app '$app'"
    mkdir -p "$(dirname "$target")"
    TARGET="$target" KIND="$kind" ENTRY="$entry" python3 - <<'PY'
import json, os
path = os.environ["TARGET"]; kind = os.environ["KIND"]; entry = json.loads(os.environ["ENTRY"])
try:
    with open(path) as f: cfg = json.load(f)
except Exception:
    cfg = {}
if not isinstance(cfg, dict): cfg = {}
cfg.setdefault(kind, {})
cfg[kind]["teleg-bridge"] = entry
with open(path, "w") as f: json.dump(cfg, f, indent=2)
print(f"wrote teleg-bridge → {path}:{kind}")
PY
  else
    log "Preview for $app (pass --write to merge into $target):"
    log ""
    ENTRY="$entry" KIND="$kind" python3 -c "import json,os; print(json.dumps({os.environ['KIND']:{'teleg-bridge':json.loads(os.environ['ENTRY'])}}, indent=2))"
  fi
}

usage() {
  cat <<'EOF'
teleg — teleg-bridge lifecycle (git-based install / update / remove)

Usage:
  teleg install   [--repo OWNER/REPO] [--host HOST] [--channel stable|edge]
  teleg update    [--channel stable|edge] [--keep]
  teleg uninstall [--home PATH] [--purge] [-y]      (alias: remove)
  teleg status
  teleg version
  teleg mcp [--app claude|pi|omp|opencode|kilo] [--write] [--path PATH]
  teleg help

Channels:
  edge    track the remote default branch (default until releases are tagged)
  stable  pin to the highest semver tag reachable from the default branch

Environment:
  TELEG_HOME   override the managed checkout (default ~/.teleg-bridge)

After the first clone the remote is fixed in .git/config, so updates work
identically for GitHub, gitlab.com, and self-hosted GitLab remotes.
EOF
}

main() {
  local sub="${1:-}"
  case "$sub" in
    install)         shift; cmd_install "$@" ;;
    update)          shift; cmd_update "$@" ;;
    uninstall|remove) shift; cmd_uninstall "$@" ;;
    status)          shift; cmd_status "$@" ;;
    version)        shift; cmd_version "$@" ;;
    mcp)            shift; cmd_mcp "$@" ;;
    help|-h|--help)  usage; exit 0 ;;
    "")              cmd_install ;;        # piped / no args → bootstrap install
    -*)              cmd_install "$@" ;;   # flags only → install
    *) die "Unknown command '$sub'. Run 'teleg help'." ;;
  esac
}

main "$@"
