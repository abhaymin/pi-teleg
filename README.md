# pi-teleg / teleg-bridge

**Telegram Bridge Extension for Pi** — a multi-bot, multi-session Telegram bridge that connects Telegram chats to Pi agent sessions and routes messages to the best available project session by explicit address, declared capabilities, or primary-session fallback.

## Repository

- Public install/update: see [Installation](#installation)


## Intent

`teleg-bridge` exists to make Telegram a practical control plane for Pi:

- Forward Telegram private, group, supergroup, and configured channel messages into active Pi sessions as `[telegram]` turns.
- Let several Pi sessions share one Telegram bot safely without duplicate polling.
- Route work to the session that owns the relevant project or capability.
- Send responses, generated files, photos, and videos back to Telegram.
- Keep queue and session state recoverable across crashes and restarts.
- Support more than one Telegram bot on the same host, scoped by `bot_id`.

The project is especially useful when you keep multiple specialized Pi sessions open, such as a media downloader, code workspace, scraping workspace, analysis workspace, and operations workspace, then want Telegram messages to land in the right one automatically.

## Core Capabilities

### Messaging and Telegram I/O

| Capability | Description |
|---|---|
| Telegram polling | Uses Telegram `getUpdates` through one active poller per bot token. |
| Message forwarding | Converts authorized Telegram messages into Pi turns prefixed with `[telegram]`. |
| Reply delivery | Sends final agent responses back to Telegram. |
| Chunked text replies | Handles Telegram message length constraints. |
| Photo and video sending | `teleg-send_photo` and `teleg-send_video` send local media files. |
| File attachments | `teleg-attach` queues local files to send with the next Telegram reply. |
| Typing indicator | Keeps Telegram chat informed while a turn is being processed. |

### Multi-session Routing

| Capability | Description |
|---|---|
| Direct routing | `@sessionName message` is relayed to the named live session. |
| Capability routing | Sessions declare capabilities in `INFO_REL.md`; messages are matched to live sessions. |
| URL-aware matching | Twitter/X, YouTube, and Reddit URLs can route to media/download-capable sessions. |
| Primary fallback | If no direct/capability match exists, the primary session for the bot handles the message. |
| Active queue workers | Linked sessions drain their own pending queue and can process assigned work. |
| Cross-session relay | Sessions communicate over local authenticated HTTP relay endpoints. |

### Reliability and Operations

| Capability | Description |
|---|---|
| Persistent queue | SQLite stores pending, processing, completed, and failed messages. |
| Bot-scoped state | Queue, relay sessions, downloads, locks, and stats are scoped by `bot_id`. |
| Polling lock | One lock file per bot prevents duplicate Telegram `getUpdates` consumers. |
| Crash recovery | Startup recovery can reset stale processing rows and clean old sessions. |
| Liveness checks | Validates PID, relay file, relay PID match, relay HTTP health, heartbeat, and DB row. |
| Ghost eviction | Dead sessions can be reconciled and evicted automatically or by command/tool. |
| Primary election | Elects or sets a primary session per bot. |
| Split-DB detection | Warns when the same bot is used with isolated databases. |

### Configuration

| Capability | Description |
|---|---|
| Global config | `~/.pi/agent/teleg-bridge.json` supports multiple bots. |
| Project config | `.pi/teleg.json` can provide project-local bot setup. |
| Environment override | `TELEG_BOT_TOKEN`, `TELEG_BOT_ID`, and `TELEG_DB_PATH` override defaults. |
| Session capability declaration | `INFO_REL.md` declares what a project/session handles. |

## High-level Architecture

```mermaid
flowchart LR
  User[Telegram User] --> Bot[Telegram Bot API]
  Bot --> Poller[Per-bot PollingManager]
  Poller --> Worker[Poll Worker Thread]
  Worker --> Queue[(SQLite message_queue)]
  Queue --> Router[Routing Decision]
  Router --> Direct[Session Route]
  Router --> Caps[Capability Match]
  Router --> Primary[Primary Fallback]
  Direct --> Relay[Authenticated HTTP Relay]
  Caps --> Relay
  Relay --> Session[Target Pi Session]
  Primary --> Session
  Session --> Tools[MCP / Pi Tools]
  Tools --> Bot
  Bot --> User
```

### Runtime Components

| Component | Path | Responsibility |
|---|---|---|
| Extension entrypoint | `src/index.ts` | Registers Pi commands/tools, manages session lifecycle, drains queue, handles Telegram turns. |
| Configuration | `src/config.ts` | Resolves bot context, global/project config, DB path, bot migration, split-DB checks. |
| SQLite persistence | `src/db.ts` | Stores message queue, relay sessions, downloads, pub-sub, stats, and schema migrations. |
| Polling manager | `src/polling-manager.ts` | Starts/stops one worker per bot and maintains bot-specific polling locks. |
| Poll worker | `src/poll-worker.ts` | Long-polls Telegram and persists updates into SQLite. |
| Relay server/client | `src/relay.ts` | Runs local HTTP relay endpoints and forwards commands between sessions. |
| Session registry | `src/session-registry.ts` | Checks liveness, reconciles sessions, evicts ghosts, elects primary. |
| Session config | `src/session-config.ts` | Reads/writes session registry and user allowlist/archive settings. |
| Capability registry | `src/capabilities.ts` | Detects capabilities from project docs and matches messages to sessions. |
| MCP helper server | `mcp-server/index.js` | Exposes bridge operations as MCP tools. |
| Build output | `dist/` | Compiled JavaScript and TypeScript declarations. |

## SQLite Database Architecture

`teleg-bridge` uses a local SQLite database as the durable coordination layer between the poll worker, routing logic, relay sessions, queue drainers, and operational tools.

### Storage location and runtime mode

| Setting | Value / Behavior |
|---|---|
| Default path | `~/.pi/agent/teleg-bridge.db` |
| Override | `TELEG_DB_PATH=/path/to/teleg-bridge.db` |
| Journal mode | `PRAGMA journal_mode=WAL` for safer concurrent session access. |
| Busy timeout | `PRAGMA busy_timeout=5000` to reduce write-contention failures. |
| Sync mode | `PRAGMA synchronous=NORMAL` for WAL-friendly durability/performance balance. |
| Schema version | `PRAGMA user_version = 2` after migration. |
| Scope key | Most runtime tables are scoped by `bot_id`. |

### Database responsibility diagram

```mermaid
flowchart TD
  Telegram[Telegram Bot API] --> Worker[poll-worker.ts]
  Worker --> MQ[(message_queue)]
  Router[index.ts routing] --> MQ
  Router --> RS[(relay_sessions)]
  Router --> RH[(relay_history)]
  Relay[relay.ts HTTP relay] --> RS
  Sessions[Pi sessions] --> RS
  Sessions --> MQ
  Sessions --> PS[(pubsub)]
  Tools[MCP tools / Telegram commands] --> MQ
  Tools --> RS
  Tools --> DQ[(download_queue)]
  Tools --> PS
  Registry[session-registry.ts] --> RS
  Registry --> MQ
```

### Logical schema

```mermaid
erDiagram
  BOT {
    text logical_parent
  }
  BOT ||--o{ MESSAGE_QUEUE : scopes
  BOT ||--o{ DOWNLOAD_QUEUE : scopes
  BOT ||--o{ RELAY_SESSIONS : scopes
  BOT ||--o{ PUBSUB : scopes
  RELAY_SESSIONS ||--o{ MESSAGE_QUEUE : claims_by_session_name
  RELAY_SESSIONS ||--o{ RELAY_HISTORY : from_or_to_session

  MESSAGE_QUEUE {
    integer id PK
    integer bot_id
    integer chat_id
    integer message_id
    integer from_user_id
    text from_username
    text text
    text session_id
    text session_name
    text status "pending|processing|completed|failed"
    text source "telegram|relay"
    text source_session
    integer created_at
    integer started_at
    integer completed_at
    text error
    text response
  }

  DOWNLOAD_QUEUE {
    integer id PK
    integer bot_id
    integer chat_id
    integer message_id
    text url
    text source "twitter|youtube|reddit|gallery|other"
    text session_name
    text status "pending|processing|completed|failed"
    integer retry_count
    text error
    text result
    integer created_at
    integer started_at
    integer completed_at
  }

  RELAY_SESSIONS {
    integer id PK
    integer bot_id
    text session_name
    text session_id
    integer pid
    integer port
    text secret
    text project_dir
    text capabilities "JSON array"
    text description
    text role "active|drain"
    integer is_primary
    integer registered_at
    integer last_heartbeat
  }

  RELAY_HISTORY {
    integer id PK
    text from_session
    text to_session
    integer chat_id
    text command
    integer success
    text error
    integer created_at
  }

  PUBSUB {
    integer id PK
    integer bot_id
    text channel
    text publisher
    text payload
    text target_session
    text consumed_by
    integer created_at
    integer consumed_at
  }
```

> `BOT` is a logical parent from global/project configuration, not a physical SQLite table. Relationships are enforced by query patterns and indexes rather than foreign-key constraints.

### Tables and indexes

| Table | Purpose | Important indexes / constraints |
|---|---|---|
| `message_queue` | Durable Telegram/relay work queue and processing history. | `idx_queue_status`, `idx_queue_session`, `idx_queue_chat`, `idx_queue_bot_id`, unique `idx_queue_dedup(bot_id, chat_id, message_id)`. |
| `download_queue` | Durable queue for media/download jobs discovered from messages. | `idx_dl_status`, `idx_dl_session`, `idx_dl_created`, `idx_dl_url`, `idx_dl_bot_id`. |
| `relay_sessions` | Live session registry mirrored from relay endpoints and heartbeats. | unique `idx_relay_name(bot_id, session_name)`, `idx_relay_pid`, `idx_relay_bot_id`. |
| `relay_history` | Audit trail for inter-session command relay attempts. | `idx_relay_history_time(created_at)`. |
| `pubsub` | Lightweight inter-session publish/subscribe queue. | `idx_pubsub_channel(channel, consumed_at)`, `idx_pubsub_target(target_session, consumed_at)`, `idx_pubsub_bot(bot_id, channel)`. |

### Queue state machine

```mermaid
stateDiagram-v2
  [*] --> pending: insert from Telegram/relay
  pending --> processing: claimNextMessage / markMessageProcessing
  processing --> completed: completeMessage(response)
  processing --> failed: failMessage(error)
  processing --> pending: recoverStaleMessages / resetProcessingForSession
  failed --> [*]
  completed --> [*]
```
### Main database flows

| Flow | Read / Write Path |
|---|---|
| Incoming Telegram update | `poll-worker.ts` inserts or deduplicates into `message_queue` by `(bot_id, chat_id, message_id)`. |
| Session claim | Queue drainers call `claimNextMessage` / `claimNextMessageForSession`, moving rows from `pending` to `processing`. |
| Route assignment | Router assigns `session_name` and synthetic `session_id` like `__session__:name` for targeted delivery. |
| Completion | Active turn completion updates `message_queue.status`, `completed_at`, `response`, or `error`. |
| Relay registration | Session startup writes `relay_sessions` with PID, port, secret, capabilities, role, and heartbeat. |
| Liveness reconciliation | `session-registry.ts` reads `relay_sessions`, validates relay/PID/heartbeat, evicts ghosts, and resets stuck queue rows. |
| Pub-sub delegation | `teleg-publish` inserts into `pubsub`; sessions consume rows by channel or target session. |
| Download tracking | URL/media jobs are tracked in `download_queue` with retry count, result, and error details. |

## Workflow

### 1. Setup workflow

```mermaid
sequenceDiagram
  participant Dev as Developer
  participant Pi as Pi Session
  participant Config as teleg config
  participant TG as Telegram API

  Dev->>Pi: /teleg-setup
  Pi->>Config: Save bot token / allowed users
  Pi->>TG: getMe / pairing checks
  TG-->>Pi: Bot identity
  Pi->>Config: Store botId, botUsername, lastUpdateId
```

1. Install dependencies with `npm install`.
2. Build with `npm run build`.
3. Deploy with `./deploy.sh`.
4. Run `/teleg-setup` inside Pi, or provide config/env variables.
5. Send `/start` or `/help` to the Telegram bot from an allowed user.

### 2. Session registration workflow

```mermaid
flowchart TD
  Start[Pi session_start] --> Resolve[Resolve BotContext]
  Resolve --> Detect[Detect project capabilities]
  Detect --> Relay[Start local relay server]
  Relay --> DB[Register relay_sessions row]
  DB --> Caps[Write capability registry]
  Caps --> Poll{Polling lock available?}
  Poll -- yes --> Active[Become active poller / primary candidate]
  Poll -- no --> Drain[Stay linked as queue-draining session]
  Active --> Heartbeat[Heartbeat + liveness timer]
  Drain --> Heartbeat
```

A session registers only when it has meaningful project context. The preferred declaration file is `INFO_REL.md`; fallback detection can use `AGENTS.md` or `README.md`.

### 3. Incoming message workflow

```mermaid
flowchart TD
  Msg[Telegram message] --> Auth{Allowed user?}
  Auth -- no --> Reject[Ignore / reject]
  Auth -- yes --> Command{Bridge command?}
  Command -- yes --> Cmd[Run command handler]
  Command -- no --> Persist[Persist to SQLite queue]
  Persist --> Direct[Session-name route?]
  Direct -- yes --> LiveTarget{Target live?}
  LiveTarget -- yes --> Relay[Forward via HTTP relay]
  LiveTarget -- no --> Fallback[Primary fallback]
  Direct -- no --> Match{Capability match?}
  Match -- yes --> CapLive{Matched session live?}
  CapLive -- yes --> Relay
  CapLive -- no --> Fallback
  Match -- no --> Fallback
  Fallback --> Primary[Assign to primary session]
  Relay --> Turn[Create telegram Pi turn]
  Primary --> Turn
  Turn --> Reply[Send response / attachments to Telegram]
```

Routing order is intentionally deterministic:

1. Telegram administrative and bridge commands.
2. Explicit `@sessionName` route.
3. Capability match from the active session registry.
4. Primary session fallback.

### 4. Response workflow

```mermaid
sequenceDiagram
  participant Session as Pi Session
  participant Tool as teleg tools
  participant Queue as SQLite
  participant TG as Telegram API
  participant User as Telegram User

  Session->>Tool: teleg-send_message / teleg-attach / final reply
  Tool->>TG: sendMessage / sendPhoto / sendVideo / document upload
  TG-->>User: Delivered response
  Session->>Queue: Mark message completed or failed
```

If a Telegram user asks for a generated file, the handling agent should call `teleg-attach` with the local file path before returning its final text response.

### 5. Reconciliation and recovery workflow

```mermaid
flowchart TD
  Timer[Startup / timer / manual reconcile] --> Sessions[Read relay_sessions]
  Sessions --> Checks[Run liveness checks]
  Checks --> Classify{linked / stale / ghost}
  Classify -- linked --> Keep[Keep routeable]
  Classify -- stale --> Monitor[Keep but report stale]
  Classify -- ghost --> Evict[Remove DB row, registry, relay file]
  Evict --> Reset[Reset stuck processing rows]
  Reset --> Elect[Elect new primary if needed]
```

Liveness checks include:

- `pid_alive`
- `relay_file`
- `relay_pid_match`
- `relay_http`
- `heartbeat_fresh`
- `db_row`

## Routing and Capability Declaration

Create `INFO_REL.md` in a project root to describe what a Pi session should handle:

```markdown
# INFO_REL

## capabilities
media-download, twitter, youtube, reddit, gallery

## description
Downloads and archives media from various online sources.
```

This repository declares:

```markdown
# INFO_REL

## capabilities
telegram-bridge, messaging, relay, routing

## description
Multi-session Telegram bridge extension for Pi. Handles polling, session routing, message relay, and capability-based smart message distribution between Pi sessions.
```

Capability matching uses:

- Direct URL patterns for Twitter/X, YouTube, and Reddit.
- Capability keywords such as `twitter`, `youtube`, `reddit`, `media`, `download`, or `video`.
- Generic keyword matching against session descriptions.
- Live-process checks before selecting a route.

## Commands via Telegram

| Command | Description |
|---|---|
| `/start` or `/help` | Show help and pairing information. |
| `/status` | Show connection, sessions, relay state, queue, and bot info. |
| `/chatid` | Show current chat/user IDs for group/channel setup. |
| `/queue [session]` | Show queue information for a session or primary. |
| `/health` | Test connection. |
| `/healthfull` | Full diagnostic. |
| `/compact` | Compact Pi memory. |
| `stop` | Abort current turn. |
| `/teleg-setup` | Register or switch Telegram bots, with picker if multiple are configured. |
| `/teleg-connect` | Connect / choose bot and start polling. |
| `/teleg-reconnect` | Reconnect polling, optionally choosing a bot. |
| `/teleg-switch-bot` | Switch the active bot for this session. |

## State and Data Files

| File / Directory | Purpose |
|---|---|
| `~/.pi/agent/teleg-bridge.db` | Default shared SQLite database. |
| `~/.pi/agent/teleg-bridge.json` | Global multi-bot configuration. |
| `~/.pi/agent/teleg-capabilities.json` | Runtime capability registry. |
| `~/.pi/agent/tmp/teleg-bridge/polling-{botId}.lock` | Per-bot polling lock. |
| `.pi/teleg.json` | Optional project-local bot pin used by the extension and MCP server. |
| `INFO_REL.md` | Project capability declaration. |

## Deployment Scenarios

### Same host, multiple Pi sessions, one bot

```mermaid
flowchart TD
  Bot[Bot 123456] --> Poller[One active poller]
  Poller --> DB[(Shared SQLite DB)]
  DB --> A[Pi Session A]
  DB --> B[Pi Session B]
  DB --> C[Pi Session C]
  A <--> Relay[Local relay files + HTTP]
  B <--> Relay
  C <--> Relay
```

All sessions must share the same `TELEG_DB_PATH`. Only one session polls Telegram; all linked sessions can process work routed or assigned to them.

### Same host, multiple bots

```mermaid
flowchart TD
  Bot1[Bot 123456] --> Lock1[polling-123456.lock]
  Bot2[Bot 789012] --> Lock2[polling-789012.lock]
  Lock1 --> DB[(Shared or isolated SQLite DB)]
  Lock2 --> DB
  DB --> Sessions[Pi Sessions]
```

Each bot has independent polling, lock, offset, queue scoping, and primary session selection.

### Mixed shared / isolated deployments

Use separate `TELEG_DB_PATH` values for intentionally isolated environments, such as dev and prod. Do **not** split the DB for sessions that are meant to share the same bot and queue.

## Anti-patterns and Fixes

### Same bot, split DB

```text
Wrong: Session A uses /path/a.db and Session B uses /path/b.db with the same bot token.
Result: isolated queues, no shared routing, confusing primary ownership.
Fix: set the same TELEG_DB_PATH for all sessions sharing a bot.
```

### Ghost primary

```text
Wrong: primary session is killed and stale rows remain processing forever.
Fix: run /teleg-reconcile, /teleg-clean-db, or use teleg-evict_session.
```

### Missing INFO_REL.md

```text
Wrong: project session has no clear capabilities, so routing falls back to primary.
Fix: add INFO_REL.md with capabilities and a concise description.
```

## Installation

`teleg-bridge` ships a single `install.sh` dispatcher that handles the full
git-based lifecycle: **install / update / uninstall / status / version**.

### Public install

```bash
# GitHub
curl -fsSL https://raw.githubusercontent.com/abhaymin/pi-teleg/HEAD/install.sh | bash

# GitLab
curl -fsSL https://gitlab.abhaymenon.com/abhaymin/pi-teleg/-/raw/HEAD/install.sh | bash
```

This clones the canonical upstream to **`~/.teleg-bridge`** (override with
`TELEG_HOME`), runs `npm install` + build, wires `~/.pi/agent/settings.json` and
`~/.pi/agent/mcp.json`, and installs a `teleg` shim at `~/.local/bin/teleg`.
Re-running the one-liner is always safe — it acts as an update.

### Lifecycle commands

After install, the `teleg` shim is on your `PATH`:

| Command | Description |
|---|---|
| `teleg status` | Show install path, remote, channel, ref, and whether an update is available. |
| `teleg version` | Print `package.json` version + `git describe`. |
| `teleg update` | `git fetch` → advance to the channel's latest ref → rebuild → re-wire config. |
| `teleg update --channel stable` | Switch to the highest semver tag (falls back to edge with a warning if none are tagged yet). |
| `teleg update --keep` | Stash (instead of discarding) any local edits in the managed checkout. |
| `teleg uninstall` | Remove the checkout, prune Pi config keys, remove the shim — **preserve bot config + database**. |
| `teleg uninstall --purge -y` | Also delete `~/.pi/agent/teleg-bridge.json` and `teleg-bridge.db`. |

### Channels

- **`edge`** (default): track the remote's default branch (discovered dynamically — never assumed to be `main`/`master`/`dev`).
- **`stable`**: pin to the highest semver tag reachable from the default branch. Requires releases to be tagged; until then it falls back to `edge` with a one-time warning.

### Private repositories

If your GitLab/GitHub repo is private, use either:

- an SSH remote (`git@host:owner/repo.git`), or
- a tokenized HTTPS remote / credential helper available to `git`.

The installer runs with `GIT_TERMINAL_PROMPT=0`, so it will fail fast rather than prompting interactively.

## License

MIT

## Status

This repository is actively maintained and tracks the current Pi-facing local deployment workflow plus the git-based public install/update path.

## License

MIT

## Status

This repository is actively maintained and tracks the current Pi-facing local deployment workflow plus the git-based public install/update path.


