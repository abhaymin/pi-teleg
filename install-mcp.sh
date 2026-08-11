#!/usr/bin/env bash
# Install teleg-bridge MCP for MCP-compliant CLIs/IDEs (skip Pi).
# Usage: ./install-mcp.sh [--app omp|cursor|claude|…] [--write] [--list] [--print]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_NAME="teleg-bridge"
CHECKOUT="${TELEG_HOME:-$SCRIPT_DIR}"
MCP_PATH="$CHECKOUT/mcp-server/index.js"

log()  { printf '%s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
die()  { printf '✖  %s\n' "$*" >&2; exit 1; }

entry_cmd() {
  MCP_PATH="$1" python3 - <<'PY'
import json, os
print(json.dumps({"command": "node", "args": [os.environ["MCP_PATH"]]}))
PY
}
entry_stdio() {
  MCP_PATH="$1" python3 - <<'PY'
import json, os
print(json.dumps({"type": "stdio", "command": "node", "args": [os.environ["MCP_PATH"]]}))
PY
}
merge_json() {
  local path="$1" kind="$2" entry="$3"
  mkdir -p "$(dirname "$path")"
  TARGET="$path" KIND="$kind" ENTRY="$entry" NAME="$SERVER_NAME" python3 - <<'PY'
import json, os
path, kind, name = os.environ["TARGET"], os.environ["KIND"], os.environ["NAME"]
entry = json.loads(os.environ["ENTRY"])
try: cfg = json.load(open(path))
except Exception: cfg = {}
if not isinstance(cfg, dict): cfg = {}
cfg.setdefault(kind, {})
if not isinstance(cfg[kind], dict): cfg[kind] = {}
cfg[kind][name] = entry
json.dump(cfg, open(path, "w"), indent=2)
print(f"  wrote {name} → {path}:{kind}")
PY
}

APP=""; DO_WRITE=false; PRINT=false; LIST=false
while (($#)); do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --write) DO_WRITE=true; shift ;;
    --print) PRINT=true; shift ;;
    --list) LIST=true; shift ;;
    --path) MCP_PATH="${2:-}"; shift 2 ;;
    --home) CHECKOUT="${2:-}"; MCP_PATH="$CHECKOUT/mcp-server/index.js"; shift 2 ;;
    -h|--help) sed -n '2,4p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "Unknown arg $1" ;;
  esac
done

[[ -f "$MCP_PATH" ]] || warn "MCP server missing at $MCP_PATH"

if $LIST || { [[ -z "$APP" ]] && ! $PRINT && ! $DO_WRITE; }; then
  log "Apps: cursor, claude, claude-desktop, omp, vscode, windsurf, cline, continue, opencode, kilo, generic, all"
  log "Server: $MCP_PATH"
  log "Pi: skipped (native extension only)"
  $LIST && exit 0
fi

if $PRINT || [[ -z "$APP" ]]; then
  MCP_PATH="$MCP_PATH" python3 - <<'PY'
import json, os
print(json.dumps({"mcpServers": {"teleg-bridge": {"command": "node", "args": [os.environ["MCP_PATH"]]}}}, indent=2))
PY
  [[ -z "$APP" ]] && exit 0
fi

case "$APP" in
  pi|pi-agent) die "Pi is skipped — use ./deploy.sh for the native extension." ;;
  cursor) path="$HOME/.cursor/mcp.json"; kind="mcpServers"; entry="$(entry_cmd "$MCP_PATH")" ;;
  claude|claude-code) path="$HOME/.claude.json"; kind="mcpServers"; entry="$(entry_cmd "$MCP_PATH")" ;;
  omp|oh-my-pi) path="$HOME/.omp/agent/mcp.json"; kind="mcpServers"; entry="$(entry_stdio "$MCP_PATH")" ;;
  vscode|code) path="$HOME/.vscode/mcp.json"; kind="servers"; entry="$(entry_stdio "$MCP_PATH")" ;;
  windsurf) path="$HOME/.codeium/windsurf/mcp_config.json"; kind="mcpServers"; entry="$(entry_cmd "$MCP_PATH")" ;;
  *) die "Unknown app '$APP' (see --list)" ;;
esac

if $DO_WRITE; then
  merge_json "$path" "$kind" "$entry"
else
  log "Preview → $path ($kind). Pass --write to merge."
  KIND="$kind" ENTRY="$entry" NAME="$SERVER_NAME" python3 -c 'import json,os; print(json.dumps({os.environ["KIND"]:{os.environ["NAME"]:json.loads(os.environ["ENTRY"])}}, indent=2))'
fi
