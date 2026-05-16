#!/bin/bash
# Deploy teleg monorepo: extension + MCP server
# Both are part of the same source tree at /home/abhaym/Development/PTGD/teleg/
#
# Architecture:
#   - Extension (src/extension/)      → registers tools, polls Telegram, handles message routing
#   - MCP server (mcp-server/)        → exposes send_* tools via HTTP, NO polling
#
# The extension owns the polling lock. The MCP server provides tools only.
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

# ── Install MCP server deps ──────────────────────────────────────────────────
echo ""
echo "[2] Installing MCP server dependencies"
cd mcp-server
npm install --silent 2>/dev/null || npm install
cd ..

# ── Update agent settings.json ──────────────────────────────────────────────
AGENT_DIR="${HOME}/.pi/agent"
SETTINGS_FILE="$AGENT_DIR/settings.json"
mkdir -p "$AGENT_DIR"

echo ""
echo "[3] Updating $SETTINGS_FILE..."

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

# Add extension and MCP server (extension first, then MCP)
settings["packages"].append(teleg_path)
settings["packages"].append(mcp_path)

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

# ── Update agent mcp.json (browser MCPs only) ───────────────────────────────
MCP_CONFIG_FILE="$AGENT_DIR/mcp.json"
echo ""
echo "[4] Updating $MCP_CONFIG_FILE..."

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
    }
  }
}
EOF
echo "  browser MCPs configured (teleg-bridge is an extension, not an MCP server)"

echo ""
echo "=== Deploy complete ==="
echo ""
echo "Restart pi from ANY directory — extension + MCP server load automatically."
echo ""
echo "Sessions:"
echo "  - Extension polls Telegram, handles @sessionName routing"
echo "  - MCP server provides send_message/send_photo/send_video tools"
echo "  - Only the session with the polling lock handles incoming Telegram messages"
echo ""
echo "Start in watch mode: ./deploy.sh --watch"