# Graph Report - src  (2026-05-29)

## Corpus Check
- 10 files · ~24,664 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 313 nodes · 584 edges · 14 communities (13 shown, 1 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `edb15c0b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]

## God Nodes (most connected - your core abstractions)
1. `getDb()` - 49 edges
2. `handleAuthorizedTelegramMessage()` - 32 edges
3. `PollingManager` - 27 edges
4. `execute()` - 21 edges
5. `readGlobalConfig()` - 12 edges
6. `currentPollingManager()` - 11 edges
7. `handleStatusCommand()` - 11 edges
8. `readSessionRegistry()` - 10 edges
9. `resolveBotContext()` - 9 edges
10. `reconcileSessions()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `handleAuthorizedTelegramMessage()` --calls--> `stopRelayServer()`  [EXTRACTED]
  index.ts → relay.ts
- `execute()` --calls--> `stopRelayServer()`  [EXTRACTED]
  index.ts → relay.ts
- `refreshBotContext()` --calls--> `resolveBotContext()`  [EXTRACTED]
  index.ts → config.ts
- `handleAuthorizedTelegramMessage()` --calls--> `updateAllowedUsers()`  [EXTRACTED]
  index.ts → config.ts
- `currentPollingManager()` --calls--> `getPollingManager()`  [EXTRACTED]
  index.ts → polling-manager.ts

## Communities (14 total, 1 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (63): readGlobalConfigSync(), assignMessageToSession(), assignTelegramMessageToSession(), claimNextDownload(), claimNextMessage(), claimNextMessageForSession(), cleanStaleRelaySessions(), completeDownload() (+55 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (41): ActiveTelegramTurn, announceToken, archiveRoot, botId, botInfo, botToken, { capabilities: detectedCaps, description: detectedDesc }, cwd (+33 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (34): matchMessageToCapability(), listConfiguredBots(), activateTurn(), assignIncomingToSession(), claimNextTurn(), claimNextTurnForSession(), completeIncoming(), completeTurn() (+26 more)

### Community 3 - "Community 3"
Cohesion: 0.16
Nodes (24): BotEntry, buildBotContext(), CONFIG_DIR, CONFIG_FILE, DEFAULT_DB_PATH, detectSplitDb(), getConfigVersion(), getDefaultBotId() (+16 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (19): cleanStaleRelayFiles(), CommandHandler, CompleteHandler, completeMessageOnSource(), __dirname, ensureRelayDir(), forwardToSession(), getAliveSessionNames() (+11 more)

### Community 6 - "Community 6"
Cohesion: 0.19
Nodes (16): checkSessionLiveness(), clearPrimary(), __dirname, electPrimary(), evictSession(), getLinkedSessions(), getRelayPath(), getRelaySessionsForBot() (+8 more)

### Community 7 - "Community 7"
Cohesion: 0.15
Nodes (15): callTelegram(), DEFAULT_DB_PATH, getDb(), lastSuccessfulPoll, MainMessage, persistMessage(), pollLoop(), PollWorkerData (+7 more)

### Community 8 - "Community 8"
Cohesion: 0.14
Nodes (15): isAuthorizedTelegramMessage(), normalizeTelegramCommand(), BotEntryConfig, CONFIG_DIR, DEFAULT_ARCHIVE_ROOT, flattenV2Config(), getArchiveRoot(), getSessionId() (+7 more)

### Community 9 - "Community 9"
Cohesion: 0.12
Nodes (13): BotInfo, managers, NOOP_MANAGER, PendingTelegramTurn, PollState, PollWorkerData, TelegramChat, TelegramMessage (+5 more)

### Community 10 - "Community 10"
Cohesion: 0.27
Nodes (12): CAPABILITIES_FILE, CapabilitiesEntry, CapabilitiesRegistry, cleanStaleCapabilities(), CONFIG_DIR, detectProjectCapabilities(), parseCapabilitiesMd(), readCapabilitiesRegistry() (+4 more)

### Community 11 - "Community 11"
Cohesion: 0.40
Nodes (5): normalizeConfigFromBotContext(), refreshBotContext(), saveVerifiedBotConfig(), getPollingManager(), writeConfig()

### Community 12 - "Community 12"
Cohesion: 0.50
Nodes (3): DatabaseSync, DatabaseSyncOptions, StatementSync

### Community 13 - "Community 13"
Cohesion: 0.67
Nodes (3): BotContext, SessionState, TelegramConfig

## Knowledge Gaps
- **104 isolated node(s):** `__dirname`, `RELAY_DIR`, `RelayInfo`, `StartRelayOptions`, `CommandHandler` (+99 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PollingManager` connect `Community 4` to `Community 9`, `Community 3`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **Why does `handleAuthorizedTelegramMessage()` connect `Community 2` to `Community 1`, `Community 3`, `Community 5`, `Community 6`, `Community 8`, `Community 10`, `Community 11`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `__dirname`, `RELAY_DIR`, `RelayInfo` to the rest of the system?**
  _104 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06201923076923077 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.04081632653061224 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.13368983957219252 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.08615384615384615 - nodes in this community are weakly interconnected._