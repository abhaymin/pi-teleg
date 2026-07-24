---
type: concept
title: Tools
description: Shared extension/MCP toolset for send, queue, session, and bot ops.
tags: [actions, tools, mcp]
timestamp: 2026-07-24T16:00:00Z
---

# Tools (extension ≡ MCP)

Registered in `src/index.ts` via `pi.registerTool` and mirrored in `mcp-server/index.js`.

## Outbound

| Tool | Purpose |
|---|---|
| `teleg-send_message` | Send text |
| `teleg-send_photo` | Send local image |
| `teleg-send_video` | Send local video |
| `teleg-send_document` | Send local file |
| `teleg-attach` | Extension: queue onto **active turn** reply; MCP: send now |
| `get_me` | Bot identity |

## Queue

| Tool | Purpose |
|---|---|
| `get_queue_count` | Depth |
| `get_queue_stats` | Aggregate stats |
| `get_queue_data` / `get_queue_data_id` | Inspect rows |
| `set_queue_status` | Force row status |
| `teleg-clear_backlog` | reset / purge / complete / fail / delete |

## Sessions / bots

| Tool | Purpose |
|---|---|
| `teleg-publish` | Inter-session pubsub |
| `teleg-list_sessions` | List + liveness |
| `teleg-evict_session` | Evict one |
| `teleg-reconcile` | Ghost eviction + primary elect |
| `teleg-list_bots` | Configured bots |
| `teleg-set_primary` | Force primary |

## Kill / cleanup

| Tool | Purpose |
|---|---|
| `teleg-disconnect` | This session |
| `teleg-disconnect-all` | All on bot |
| `teleg-clean-db` | Queue cleanup |
| `teleg-remove-sessions` | Dead registry rows |

## MCP-only

| Tool | Purpose |
|---|---|
| `teleg_listen` | Blocking long-poll for next routed message (omp loop) |
| `teleg_reply` | Reply + complete queue item |

Keep names identical across surfaces when adding tools — update both `src/index.ts` and `mcp-server/index.js`, then this page.
