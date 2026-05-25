# pi-teleg

**Telegram Bridge Extension for Pi** — Multi-session, multi-bot Telegram bridge with smart capability-based routing.

## Features

- **Multi-Bot Support**: Run multiple Telegram bots on one machine, each with isolated queues
- **Telegram Bot Integration**: Poll Telegram, receive messages, forward to Pi agent
- **Multi-Session**: Multiple Pi sessions can share one bot via the relay system
- **Smart Routing**: Messages are automatically routed to the session best equipped to handle them based on declared capabilities
- **Capability Registry**: Each session declares its purpose via `INFO_REL.md`, teleg routes relevant messages to it
- **Direct @sessionName Routing**: Prefix messages with `@sessionName` to target a specific session
- **Fallback to Primary**: If the ideal session is offline, the primary session handles it
- **Cross-Session Relay**: Forward messages between Pi sessions via HTTP relay
- **Bi-directional Communication**: Send AI responses back to Telegram
- **File Attachments**: Send files via `teleg_attach` tool
- **Auto-reconnect**: Exponential backoff on connection failures
- **Health Monitoring**: Periodic health checks
- **Status Display**: Visual status with queue depth in Pi's UI
- **Ghost Eviction**: Automatic detection and removal of dead sessions

## How Smart Routing Works

1. Each Pi session running on a project folder registers with teleg:
   - Scans `INFO_REL.md` (preferred), `AGENTS.md`, or `README.md` for capabilities
   - A session in a bare/home directory with no docs **does not register**
   - Only meaningful project directories are registered
2. When a Telegram message arrives:
   - `@sessionName` prefix → relay directly to that session
   - Check capability registry → if a live session matches (e.g., Twitter URL → "data-scrapper" session) → relay
   - If matched session is dead → primary handles it
   - No match → primary handles it
3. The registry is ephemeral — maintained by the primary session, cleaned on disconnect/crash

## Deployment Scenarios

### Scenario A: Same Host, Multiple Pi Sessions (Default)

```
┌─────────────────────────────────────────────────────┐
│  Host machine                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ Pi Session  │  │ Pi Session  │  │ Pi Session  │  │
│  │    (A)      │  │    (B)     │  │    (C)     │  │
│  │  Bot 123456 │  │  Bot 123456 │  │  Bot 789012 │  │
│  │   (same)    │  │   (same)   │  │  (diff)    │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
│         │               │               │          │
│         └───────────────┴───────────────┘          │
│                         │                          │
│                    Shared DB                        │
│              ~/.pi/agent/teleg-bridge.db           │
└─────────────────────────────────────────────────────┘
```

**Configuration:**
- All sessions share the same `TELEG_DB_PATH` (default)
- Sessions with same `botId` share one polling lock
- Sessions with different `botId` have independent polling

### Scenario D: Mixed Shared/Isolated Deployments

```
┌─────────────────────┐  ┌─────────────────────┐
│  Host 1             │  │  Host 2             │
│  Bot 123456 (prod)  │  │  Bot 789012 (dev)   │
│  Shared DB          │  │  Shared DB          │
│  Multiple sessions   │  │  Multiple sessions   │
└─────────────────────┘  └─────────────────────┘
```

**Configuration:**
- Set `TELEG_BOT_TOKEN` or `TELEG_BOT_ID` for each host
- Set `TELEG_DB_PATH` for isolation if needed

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEG_BOT_TOKEN` | — | Force token for process (overrides config) |
| `TELEG_BOT_ID` | — | Select bot from global config |
| `TELEG_DB_PATH` | `~/.pi/agent/teleg-bridge.db` | Shared SQLite DB |
| `TELEG_LIVENESS_MS` | `300000` | Max heartbeat age (5 min) |
| `TELEG_DRAIN_INTERVAL_MS` | `12000` | Idle queue drain interval |
| `TELEG_CLAIM_OTHERS` | `0` | Allow claiming other sessions' pending |

## Configuration Files

### Global Config (`~/.pi/agent/teleg-bridge.json`)

```json
{
  "version": 2,
  "defaultBotId": 123456789,
  "bots": {
    "123456789": {
      "botToken": "TOKEN",
      "botUsername": "my_bot",
      "allowedUserIds": [987654321],
      "lastUpdateId": 0
    }
  }
}
```

### Project Config (`.pi/teleg.json`)

```json
{
  "botToken": "TOKEN",
  "allowedUserIds": [987654321]
}
```

## Anti-Patterns

### ⚠️ Same Bot, Split DB

```
WRONG:  Session A (TELEG_DB_PATH=/path/a) + Session B (TELEG_DB_PATH=/path/b)
        Both using same bot token → isolated queues, no message sharing
```

**Fix:** Use the same `TELEG_DB_PATH` for all sessions sharing a bot.

### ⚠️ Ghost Primary

```
WRONG:  Primary session killed → messages stuck in processing forever
```

**Fix:** Run `/teleg-reconcile` or call `teleg-evict_session` to evict ghost and re-elect primary.

## INFO_REL.md Format

Create in your project root to declare capabilities:

```markdown
# INFO_REL

## capabilities
media-download, twitter, youtube, reddit, gallery

## description
Downloads and archives media from various online sources
```

## Installation

```bash
git clone <repository-url>
cd pi-teleg
npm install
npm run build
./deploy.sh
```

## Commands (via Telegram)

| Command | Description |
|---------|-------------|
| `/start` or `/help` | Show help |
| `/status` | Show connection, sessions, queue (enhanced with per-bot info) |
| `/health` | Test connection |
| `/healthfull` | Full diagnostic |
| `/compact` | Compact Pi memory |
| `/teleg-reconcile` | Reconcile sessions, evict ghosts |
| `/teleg-sessions` | List sessions with liveness |
| `/teleg-set-primary <name>` | Set primary session |
| `/teleg-bots` | List configured bots |

## Pi Commands

| Command | Description |
|---------|-------------|
| `/teleg-setup` | Configure bot token |
| `/teleg-status` | Show status |
| `/teleg-connect` | Start polling |
| `/teleg-disconnect` | Stop polling |
| `/teleg-reconnect` | Force reconnect |

## MCP Tools (for agents)

### Core Tools
- `teleg-send_message` — Send text to Telegram
- `teleg-send_photo` — Send photo to Telegram
- `teleg-send_video` — Send video to Telegram
- `get_me` — Get bot info
- `teleg-attach` — Queue files to send with reply

### Session Management (Phase 7)
- `teleg-reconcile(bot_id?)` — Check sessions for liveness, evict ghosts
- `teleg-list_sessions(bot_id?, include_ghosts?)` — List sessions with status
- `teleg-evict_session(session_name, bot_id?, reset_queue?, force_kill_pid?)` — Evict a session
- `teleg-list_bots()` — List configured bots
- `teleg-set_primary(session_name, bot_id?)` — Set primary session
- `teleg-clear_backlog` — Reset/purge queue

## Architecture

```
Telegram ─→ teleg (polling + routing)
                │
         ┌──────┴──────┐
         │             │
    @sessionName   capability match
         │             │
         ▼             ▼
    target session   best-fit session
         │             │
         └──────┬──────┘
                ▼
         sends response via teleg MCP tools
```

## License

MIT
