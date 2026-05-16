#!/bin/bash
# Deploy teleg monorepo: extension + MCP server (stdio)
# Both are part of the same source tree at /home/abhaym/Development/PTGD/teleg/
#
# Architecture:
#   - Extension (dist/)          → polls Telegram, handles message routing, @sessionName routing
#   - MCP server (mcp-server/)   → stdio JSON-RPC tools (send_message, send_photo, send_video, get_me, teleg_attach)
#
# The extension owns the polling lock. The MCP server provides tools only (no polling).
# MCP server can be used standalone (without the extension) OR with the extension.
#
# Usage:
#   ./deploy.sh          → one-time deploy
#   ./deploy.sh --watch  → watch mode (tsc --watch)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WATCH_MODE=false
[[ "$1" == "--watch" ]] && WATCH_MODE=true

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

python3 << 'PYEOF'
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

# ── Update agent mcp.json (includes teleg-bridge as stdio MCP) ────────────────
MCP_CONFIG_FILE="$AGENT_DIR/mcp.json"
echo ""
echo "[3] Updating $MCP_CONFIG_FILE (extension + stdio MCP servers)..."

cat > "$MCP_CONFIG_FILE" << 'EOF'
{
  "imports": ["cursor", "claude-code", "opencode", "kilo"],
  "mcpServers": {
    "browserOS": {
      "command": "npx",
      "args": ["mcp-remote", "http://127.0.0.1:9000/mcp"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "browsermcp": {
      "command": "npx",
      "args": ["@browsermcp/mcp@latest"]
    },
    "teleg-bridge": {
      "command": "node",
      "args": ["/home/abhaym/Development/PTGD/teleg/mcp-server/index.js"]
    }
  }
}
EOF
echo "  browser MCPs + teleg-bridge stdio MCP configured"

echo ""
echo "=== Deploy complete ==="
echo ""
echo "Restart pi — extension + MCP server load automatically."
echo ""
echo "Sessions:"
echo "  - Extension polls Telegram, handles @sessionName routing"
echo "  - MCP server (stdio) provides send_message/send_photo/send_video tools"
echo "  - teleg-bridge MCP works standalone OR with the extension"
echo ""
echo "Start in watch mode: ./deploy.sh --watch"