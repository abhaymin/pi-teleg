# pi-teleg

**Telegram Bridge Extension for Pi** — Multi-session Telegram bridge with smart capability-based routing.

## Features

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

## Configuration

### 1. Create a Telegram Bot
1. Talk to **@BotFather** on Telegram
2. `/newbot` → copy the token
3. In Pi: `/teleg-setup` → paste token → `/start` to your bot

## Commands (via Telegram)

| Command | Description |
|---------|-------------|
| `/start` or `/help` | Show help |
| `/status` | Show connection, sessions, queue |
| `/health` | Test connection |
| `/healthfull` | Full diagnostic |
| `/compact` | Compact Pi memory |

## Pi Commands

| Command | Description |
|---------|-------------|
| `/teleg-setup` | Configure bot token |
| `/teleg-status` | Show status |
| `/teleg-connect` | Start polling |
| `/teleg-disconnect` | Stop polling |
| `/teleg-reconnect` | Force reconnect |

## MCP Tools (for agents)

- `send_message` — Send text to Telegram
- `send_photo` — Send photo to Telegram
- `send_video` — Send video to Telegram
- `get_me` — Get bot info
- `teleg_attach` — Queue files to send with reply

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
