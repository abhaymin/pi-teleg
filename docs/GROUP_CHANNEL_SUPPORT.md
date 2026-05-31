# Telegram Groups, Supergroups, Channels, and Saved Messages

This document explains how `teleg-bridge` handles Telegram requests outside a direct private chat.

## Supported chat types

| Chat type | Supported | Authorization | Notes |
|---|---:|---|---|
| Private chat | Yes | `from.id` in `allowedUserIds` | First `/start` or `/help` can pair the first user when no users are configured. |
| Group | Yes | Requesting `from.id` in `allowedUserIds`, or group `chat.id` in `allowedChatIds` | BotFather privacy mode controls whether normal messages are delivered. |
| Supergroup | Yes | Requesting `from.id` in `allowedUserIds`, or supergroup `chat.id` in `allowedChatIds` | Supergroup IDs are usually negative and start with `-100`. |
| Channel | Yes, for configured channels | `chat.id` in `allowedChatIds` | Channel posts usually do not expose a posting user ID to bots. |
| Saved Messages | No, not via Bot API | N/A | Bots cannot access a user's Saved Messages history. Export or forward content instead. |

## Authorization model

`teleg-bridge` intentionally separates user authorization from chat authorization.

### `allowedUserIds`

Use this for trusted Telegram users.

If a configured user sends a request from a private chat, group, or supergroup, the bridge can process it and respond in that same chat.

```json
{
  "allowedUserIds": [987654321]
}
```

### `allowedChatIds`

Use this for trusted chats where individual author identity may not be available or should not matter.

This is required for channels, because Telegram channel posts usually do not provide `message.from` to bots.

```json
{
  "allowedChatIds": [-1001234567890]
}
```

Be careful: adding a group/supergroup to `allowedChatIds` authorizes the chat itself. If the bot receives a message from that chat, it can be processed even when the sender is not individually listed in `allowedUserIds`.

## Configuration example

Global config: `~/.pi/agent/teleg-bridge.json`

```json
{
  "version": 2,
  "defaultBotId": 123456789,
  "bots": {
    "123456789": {
      "botToken": "TOKEN",
      "botUsername": "my_bot",
      "allowedUserIds": [987654321],
      "allowedChatIds": [-1001234567890],
      "lastUpdateId": 0
    }
  }
}
```

Project config: `.pi/teleg.json`

```json
{
  "botToken": "TOKEN",
  "allowedUserIds": [987654321],
  "allowedChatIds": [-1001234567890]
}
```

## Discovering IDs

Use this command in a private chat, group, or supergroup:

```text
/chatid
```

The bridge replies with:

- current `chat.id`
- current `chat.type`
- requesting `from.id` when Telegram provides one

For channels, the bot may not receive normal posts unless it is an admin or has the necessary permissions. Channel posts generally need `allowedChatIds` configured manually.

## BotFather privacy mode

For groups and supergroups, Telegram delivery depends on BotFather privacy mode.

If privacy mode is enabled, bots usually receive only:

- commands such as `/status`
- commands addressed to the bot, such as `/status@YourBot`
- replies to the bot
- messages that mention the bot

To receive all normal group messages:

1. Open `@BotFather`.
2. Run `/setprivacy`.
3. Select the bot.
4. Choose `Disable`.

`teleg-bridge` normalizes commands like `/status@YourBot` to `/status` so group commands work naturally.

## Historical group content

The Telegram Bot API cannot fetch arbitrary historical group messages. The bridge can only process messages Telegram delivers after the bot is present, configured, and polling.

For old group history, use one of these approaches:

1. Export the chat from Telegram Desktop and analyze the exported files with Pi.
2. Forward selected historical messages to the bot.
3. Build a separate MTProto user-client importer, such as Telethon or Pyrogram, when you explicitly want user-account history access.

## Saved Messages

Bots cannot scan your personal Saved Messages via the Telegram Bot API.

Recommended alternatives:

1. Forward Saved Messages to the bot.
2. Export Saved Messages from Telegram Desktop and give the export to Pi.
3. Use a separate MTProto user-client importer with explicit user login and consent.

## Implementation notes

Current bridge behavior:

- Polls `message`, `edited_message`, `channel_post`, and `edited_channel_post` updates.
- Accepts non-private chats instead of filtering to private only.
- Authorizes by `allowedUserIds` when `message.from` is available.
- Authorizes by `allowedChatIds` for configured groups/channels.
- Replies to the original `chat.id` and `message_id`, so group requests receive group replies.
- Keeps queue rows scoped by `bot_id`, `chat_id`, and `message_id`.
