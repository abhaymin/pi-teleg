#!/bin/bash
# Deploy teleg monorepo: Pi extension + standalone MCP server (stdio)
# Both ship the SAME toolset (full parity): send_message/photo/video/document,
# teleg-attach, queue + session + relay management, kill-switches.
#
# Architecture:
#   - Extension (dist/)        → native Pi extension: polls Telegram, routes
#                                 messages, drains the queue, AND registers every
#                                 tool via pi.registerTool(). Validates recorded
#                                 config (bot token/id, db path, allowlist) so it
#                                 agrees with the MCP.
#   - MCP server (mcp-server/) → standalone stdio MCP exposing the identical
#                                 toolset for THIRD-PARTY clients (omp, opencode,
#                                 Claude Code, Kilo Code, …). NOT loaded in Pi by
#                                 default (would duplicate native tool names); wire
#                                 it in explicitly with `teleg mcp --app pi --write`.
#
# Both honour the same recorded state: ~/.pi/agent/teleg-bridge.{json,db} and
# .pi/teleg.json. In Pi the native extension is the sole tool surface (it also
# owns polling); the MCP is for clients that don't have the extension.
# Usage:
#   ./deploy.sh          → one-time deploy
#   ./deploy.sh --watch  → watch mode (tsc --watch)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WATCH_MODE=false
[[ "$1" == "--watch" ]] && WATCH_MODE=true

# ── Isolated Python via uv ───────────────────────────────────────────────────
# A mounted AppImage leaks PYTHONHOME/PYTHONPATH into the shell, which makes any
# system python3 fail ("No module named encodings"). uv provisions a clean
# interpreter; we strip the leaked vars at invocation so it is immune.
TELEG_VENV="${TELEG_VENV:-$HOME/.cache/teleg-bridge/venv}"
run_py() { env -u PYTHONHOME -u PYTHONPATH "${TELEG_VENV}/bin/python" - "$@"; }
if ! command -v uv >/dev/null 2>&1; then
  echo "[!] 'uv' not found. Install it (https://docs.astral.sh/uv/) or export a working PYTHONHOME." >&2
  exit 1
fi
uv venv --quiet "$TELEG_VENV" >/dev/null 2>&1 || true

echo "=== teleg monorepo deploy ==="
echo "Source: $SCRIPT_DIR"

# ── Build extension ──────────────────────────────────────────────────────────
echo ""
echo "[1] Building extension (TypeScript → dist/)"
npx tsc

# ── Update agent settings.json (extension only) ──────────────────────────────
AGENT_DIR="${HOME}/.pi/agent"
SETTINGS_FILE="$AGENT_DIR/settings.json"
mkdir -p "$AGENT_DIR"

echo ""
echo "[2] Updating $SETTINGS_FILE (extension only)..."
run_py << 'PYEOF'
import json, os, sys

teleg_path = os.path.abspath(".")
mcp_path = os.path.abspath("mcp-server")

settings_file = os.path.expanduser("~/.pi/agent/settings.json")

try:
  with open(settings_file) as f:
    settings = json.load(f)
except:
  settings = {"packages": []}

if "packages" not in settings:
  settings["packages"] = []

# Remove old teleg references (by path or name)
settings["packages"] = [
  p for p in settings["packages"]
  if "teleg" not in p.lower()
]

# Add extension path only (mcp-server is a stdio MCP tool, NOT a pi extension)
settings["packages"].append(teleg_path)

# Deduplicate while preserving order
seen = set()
deduped = []
for p in settings["packages"]:
  real = os.path.realpath(p) if os.path.exists(p) else p
  if real not in seen:
    seen.add(real)
    deduped.append(p)

settings["packages"] = deduped

with open(settings_file, "w") as f:
  json.dump(settings, f, indent=2)

print(f"  Updated {len(deduped)} packages in settings.json")
PYEOF

# ── Pi runs the NATIVE extension only — drop any stale teleg-bridge MCP ───────
# The extension exposes the full toolset natively (it also owns polling).
# Loading the MCP alongside it in Pi created duplicate tool names, so Pi kept
# redirecting mcp({tool:...}) calls to the native tool with a warning. The MCP
# server stays installed for third-party clients (omp, opencode, Claude Code,
# Kilo Code); wire it into Pi explicitly only if you really want it:
#   teleg mcp --app pi --write
MCP_CONFIG_FILE="$AGENT_DIR/mcp.json"
if [[ -f "$MCP_CONFIG_FILE" ]]; then
  echo ""
  echo "[3] Ensuring $MCP_CONFIG_FILE has no teleg-bridge (native extension is authoritative)..."
  MCP_CONFIG_FILE="$MCP_CONFIG_FILE" run_py <<'PYEOF'
import json, os
path = os.environ["MCP_CONFIG_FILE"]
try:
    with open(path) as f:
        m = json.load(f)
except Exception:
    m = {}
if isinstance(m, dict):
    servers = m.get("mcpServers")
    if isinstance(servers, dict) and "teleg-bridge" in servers:
        del servers["teleg-bridge"]
        with open(path, "w") as f:
            json.dump(m, f, indent=2)
        print("  removed stale teleg-bridge entry")
    else:
        print("  no teleg-bridge entry (ok)")
PYEOF
fi

echo ""
echo "=== Deploy complete ==="
echo ""
echo "Sessions:"
echo "  - Native extension is the sole tool surface in Pi: polls, routes, drains queue, all 22 tools"
echo "  - Standalone MCP (same toolset) is installed for OTHER apps: teleg mcp --app {claude|opencode|kilo|...}"
echo "  - Both share ~/.pi/agent/teleg-bridge.{json,db}; the extension validates recorded config at startup"
echo ""
echo "Restart pi — the native extension loads automatically (MCP is not loaded in Pi)."
echo ""
echo "Start in watch mode: ./deploy.sh --watch"