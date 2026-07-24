# INFO_REL

## capabilities
telegram-bridge, messaging, relay, routing, multi-instance

## description
Multi-session Telegram bridge extension for Pi. Handles polling, session routing, message relay, and capability-based smart message distribution between Pi sessions. When the same bot is shared across multiple Pi folders / Telegram channels, instance links (teleg.json allowlists ∪ INFO_REL linked_chats/users) decide which session owns each chat.

## linked_chats
# Optional: Telegram chat / group / channel ids this instance owns when sharing a bot.
# Example: 1100787134, -1001234567890

## linked_users
# Optional: DM user ids this instance owns when sharing a bot.
