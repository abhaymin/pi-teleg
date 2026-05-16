# pi-teleg

**Telegram Bridge Extension for Pi** - A Pi extension that bridges Telegram messages to the AI agent and vice versa.

## Features

- **Telegram Bot Integration**: Receive messages from Telegram and forward them to the AI agent
- **Bi-directional Communication**: Send AI responses back to Telegram
- **Twitter/X Media Download**: Automatically detect and download media from Twitter/X URLs
- **Typing Indicators**: Shows "typing..." in Telegram while waiting for AI responses
- **File Attachments**: Send files back to Telegram via the `teleg_attach` tool
- **Auto-reconnect**: Automatic reconnection with exponential backoff on connection failures
- **Health Monitoring**: Periodic health checks to detect dead connections
- **Status Display**: Visual status indicators in Pi's UI

## Installation

### From npm

```bash
npm install pi-teleg
```

### From source

```bash
git clone <repository-url>
cd pi-teleg
npm install
npm run build
```

## Configuration

### 1. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the bot token (format: `123456789:ABCdef...`)

### 2. Configure in Pi

1. In Pi, run the setup command:
   ```
   /teleg-setup
   ```
2. Enter your Telegram bot token when prompted
3. Send `/start` to your bot from the Telegram account you want to use

## Commands (via Telegram)

| Command | Description |
|---------|-------------|
| `/start` or `/help` | Show help message |
| `/status` | Show connection status |
| `/health` | Test Telegram connection |
| `/healthfull` | Full health diagnostic |
| `/compact` | Compact Pi memory |
| `stop` | Abort current AI turn |

## Pi Commands

| Command | Description |
|---------|-------------|
| `/teleg-setup` | Configure bot token |
| `/teleg-status` | Show status |
| `/teleg-connect` | Start polling |
| `/teleg-disconnect` | Stop polling |
| `/teleg-reconnect` | Force reconnect |

## MCP Tools

The extension registers the following tools for use by subagents:

- `send_message` - Send text to Telegram
- `send_photo` - Send photo to Telegram
- `send_video` - Send video to Telegram
- `get_me` - Get bot info
- `check_archive` - Check if tweet is archived
- `extract_twitter_urls` - Extract URLs from text
- `send_tweet_result` - Send archived tweet to Telegram
- `teleg_attach` - Queue files to send with reply

## Twitter/X Download Integration

When a message from Telegram contains Twitter/X URLs:

1. The extension extracts the URLs
2. Forwards them to the AI agent for download processing
3. The agent uses browserOS + chrome-devtools to download media
4. Media is archived and sent back to Telegram

**Rules**:
- Downloads ONLY main tweet media (not replies/threads)
- Never sends screenshots as fallback
- Redownloads if no actual media found

## Architecture

```
[Telegram] --> [Bot API] --> [pi-teleg Extension] --> [Pi Agent]
                    ^                                      |
                    |                                      |
                    └──────── [teleg_attach/send_*] <──────┘
```

## Files

- `src/index.ts` - Main extension source (TypeScript)
- `dist/` - Compiled JavaScript output
- `package.json` - Package configuration

## Dependencies

- `@earendil-works/pi-ai` - Pi AI types
- `@earendil-works/pi-coding-agent` - Pi extension API
- `@sinclair/typebox` - Schema type definitions

## License

MIT