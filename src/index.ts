/**
 * pi-teleg - Multi-Session Telegram Bridge Extension for Pi
 * 
 * Architecture:
 * - Per-bot polling via PollingManager (one manager per botId)
 * - Multiple Pi sessions share the same DB and polling infrastructure
 * - Messages are queued and dispatched to sessions with active turns
 * - Each session has its own turn state but shares the polling infrastructure
 * 
 * File organization:
 * - src/config.ts: BotContext resolution, multi-bot config v2
 * - src/polling-manager.ts: Per-bot polling lifecycle, lock management
 * - src/session-registry.ts: Liveness checks, reconciliation, ghost eviction
 * - src/session-config.ts: Session registry I/O, user allowlist
 * - src/capabilities.ts: Capability detection and matching
 * - src/db.ts: SQLite queue, relay sessions
 * - src/relay.ts: Inter-session command forwarding
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  startRelayServer,
  stopRelayServer,
  setCommandHandler,
  setCompleteHandler,
  forwardToSession,
  cleanStaleRelayFiles,
  cleanRelayFilesByPid,
} from "./relay.js";
import * as Db from "./db.js";
import { resolveBotContext, detectSplitDb, type BotContext } from "./config.js";
import {
  reconcileSessions,
  getSessionLivenessSummary,
  evictSession,
} from "./session-registry.js";
import {
  readConfig,
  writeConfig,
  readSessionRegistry,
  writeSessionRegistry,
  getSessionId,
  isAllowedUser,
  getArchiveRoot,
  type TelegramConfig,
  type SessionInfo,
} from "./session-config.js";
import {
  detectProjectCapabilities,
  readCapabilitiesRegistry,
  writeCapabilitiesRegistry,
  registerSessionCapabilities,
  unregisterSessionCapabilities,
  cleanStaleCapabilities,
  matchMessageToCapability,
} from "./capabilities.js";
import { getPollingManager, type PollState } from "./polling-manager.js";

// ============================================================================
// Constants
// ============================================================================

const DRAIN_INTERVAL_MS = parseInt(process.env.TELEG_DRAIN_INTERVAL_MS || "12000", 10);
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;

// ============================================================================
// Types
// ============================================================================

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramSentMessage {
  message_id: number;
}

interface QueuedAttachment {
  path: string;
  fileName: string;
}

interface PendingTelegramTurn {
  sessionId: string;
  sessionName: string;
  chatId: number;
  replyToMessageId: number;
  queuedAttachments: QueuedAttachment[];
  content: Array<TextContent | ImageContent>;
  historyText: string;
  dbId?: number;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface SessionState {
  sessionId: string;
  botContext: BotContext | undefined;
  config: TelegramConfig;
  activeTurn: ActiveTelegramTurn | undefined;
  typingInterval: ReturnType<typeof setInterval> | undefined;
  drainTimer: ReturnType<typeof setInterval> | undefined;
  setupInProgress: boolean;
}

interface PendingForward {
  chatId: number;
  messageId: number;
  text: string;
  sourceSession: string;
}

// ============================================================================
// System Prompt
// ============================================================================

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the teleg-attach tool with the local file path so the extension can send it with my next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use teleg-attach.

## Session Identity & Capabilities
- This is session "{sessionName}" running in {projectDir}.
- This session has registered its capabilities with the teleg bridge based on project documentation.
- To declare what this session handles, create an INFO_REL.md in the project root with:
  # INFO_REL
  ## capabilities
  keyword1, keyword2, ...
  ## description
  What this session does
- Other sessions with matching capabilities will get relevant messages relayed to them automatically.
- Messages addressed to a specific session (e.g., "@sessionName ...") are routed directly.
- If you receive a relayed message from Telegram, process the request and send results back using teleg-send_message, teleg-send_photo, teleg-send_video, or teleg-attach tools.`;

// ============================================================================
// Pending Forward Queue (relay commands awaiting agent processing)
// ============================================================================

const pendingForwards: PendingForward[] = [];

// ============================================================================
// Telegram API helpers (main-thread only — file sending, reply chunks)
// ============================================================================

const POLL_TIMEOUT_SECONDS = 60;

async function callTelegram<TResponse>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal | null; timeout?: number },
): Promise<TResponse> {
  const controller = new AbortController();
  const timeout = options?.timeout ?? POLL_TIMEOUT_SECONDS * 1000;
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const data = (await response.json()) as TelegramApiResponse<TResponse>;
    if (!data.ok || data.result === undefined) throw new Error(data.description || `Telegram API ${method} failed`);
    return data.result;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") throw new Error("TIMEOUT");
    throw error;
  }
}

async function sendReply(botToken: string, chatId: string, replyToMsgId: number, text: string): Promise<number | undefined> {
  const chunks: string[] = [];
  let current = "";
  const paragraphs = text.split(/\n\n+/);
  for (const para of paragraphs) {
    if (para.length <= MAX_MESSAGE_LENGTH) {
      const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
      if (candidate.length <= MAX_MESSAGE_LENGTH) { current = candidate; continue; }
      if (current) chunks.push(current);
      current = para; continue;
    }
    if (current) chunks.push(current);
    current = "";
    for (let i = 0; i < para.length; i += MAX_MESSAGE_LENGTH) chunks.push(para.slice(i, i + MAX_MESSAGE_LENGTH));
  }
  if (current) chunks.push(current);

  let lastMessageId: number | undefined;
  const MAX_RETRIES = 2;
  for (const chunk of chunks) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const sent = await callTelegram<TelegramSentMessage>(botToken, "sendMessage", {
          chat_id: chatId, text: chunk,
          ...(replyToMsgId ? { reply_to_message_id: replyToMsgId } : {}),
        }, { timeout: 15000 });
        lastMessageId = sent.message_id;
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          console.error(`[teleg] sendReply failed (attempt ${attempt}/${MAX_RETRIES}), retrying...`);
          await new Promise(r => setTimeout(r, attempt * 2000));
        } else {
          console.error(`[teleg] sendReply failed after ${MAX_RETRIES} attempts:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }
  return lastMessageId;
}

async function sendFile(
  botToken: string,
  chatId: string,
  replyToMsgId: number,
  filePath: string,
  fileName: string,
  isImage: boolean,
  caption?: string,
): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const method = isImage ? "sendPhoto" : "sendDocument";
  const fieldName = isImage ? "photo" : "document";
  const ext = fileName.split(".").pop() || (isImage ? "jpeg" : "bin");
  const mimeType = isImage ? `image/${ext}` : "application/octet-stream";
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const args = [
        "-s", "-S", "--max-time", "120",
        "-F", `chat_id=${chatId}`,
        ...(replyToMsgId ? ["-F", `reply_to_message_id=${replyToMsgId}`] : []),
        ...(caption ? ["-F", `caption=${caption}`] : []),
        "-F", `${fieldName}=@${filePath};filename=${fileName};type=${mimeType}`,
        `https://api.telegram.org/bot${botToken}/${method}`,
      ];
      const result = await new Promise<{ ok: boolean; error: string }>((resolve) => {
        execFile("curl", args, { timeout: 125_000 }, (err, stdout, stderr) => {
          if (err) { resolve({ ok: false, error: stderr || err.message }); }
          else {
            try { const data = JSON.parse(stdout); resolve({ ok: data.ok, error: data.description }); }
            catch { resolve({ ok: false, error: stdout.slice(0, 200) }); }
          }
        });
      });
      if (!result.ok) {
        console.error(`[teleg] sendFile error (attempt ${attempt}/${MAX_RETRIES}):`, result.error);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, attempt * 2000)); continue; }
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[teleg] sendFile failed (attempt ${attempt}/${MAX_RETRIES}):`, err instanceof Error ? err.message : err);
      if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, attempt * 3000)); continue; }
    }
  }
  return false;
}

async function verifyToken(token: string): Promise<TelegramUser | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
    if (data.ok && data.result) return data.result;
    return null;
  } catch { return null; }
}

// ============================================================================
// Session State
// ============================================================================

function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    botContext: undefined,
    config: {},
    activeTurn: undefined,
    typingInterval: undefined,
    drainTimer: undefined,
    setupInProgress: false,
  };
}

// ============================================================================
// MAIN EXTENSION
// ============================================================================

export default function (pi: ExtensionAPI): void {
  const sessionId = getSessionId();
  const cwd = process.cwd();
  const sessionName = cwd.split("/").filter(Boolean).pop() || "default";
  let state: SessionState = createSessionState(sessionId);

  // ─── Status UI ────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext, error?: string): void {
    const theme = ctx.ui.theme;
    const label = `${theme.fg("accent", "teleg")}${theme.fg("muted", ":" + sessionName)}`;

    const pm = getPollingManager(state.botContext?.botId ?? 0);
    const pollState = pm.getState();
    const healthIndicator = pollState.isHealthy ? "✓" : "✗";
    const errorIndicator = pollState.consecutiveErrors > 0
      ? ` [${pollState.consecutiveErrors} errs]`
      : "";

    if (error) {
      ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}${errorIndicator}`);
      return;
    }
    if (!state.config.botToken) {
      ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("muted", "not configured")}`);
      return;
    }
    if (!pm.isActive()) {
      if (pm.isHeldByOther()) {
        ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("muted", "passive")}`);
      } else {
        ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("warning", "reconnecting...")}`);
      }
      return;
    }
    if (!state.config.allowedUserIds || state.config.allowedUserIds.length === 0) {
      ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("warning", "awaiting pairing")}`);
      return;
    }

    const queueDepth = pm.getQueueDepth();
    const activeIndicator = state.activeTurn
      ? theme.fg("accent", "●")
      : theme.fg("success", healthIndicator);
    const queued = queueDepth > 0 ? ` +${queueDepth}` : "";

    ctx.ui.setStatus("teleg-bridge", `${label} ${activeIndicator}${queued}${errorIndicator}`);
  }

  // ─── Session lifecycle ────────────────────────────────────────────────

  async function registerSession(): Promise<void> {
    const registry = await readSessionRegistry();

    // Remove sessions older than 1 hour (no heartbeat)
    const oneHourAgo = Date.now() - 3600000;
    registry.sessions = registry.sessions.filter(s => s.lastActivity > oneHourAgo);

    // Clean stale relay files for dead PIDs
    cleanStaleRelayFiles();

    // Purge orphaned sessions: remove entries whose PID is dead
    registry.sessions = registry.sessions.filter(s => {
      if (s.sessionId === sessionId) return true;
      try { process.kill(s.pid, 0); return true; } catch { return false; }
    });

    const existing = registry.sessions.findIndex(s => s.sessionId === sessionId);
    const sessionInfo: SessionInfo = {
      sessionId,
      sessionName,
      pid: process.pid,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isActive: true,
      botId: state.botContext?.botId,
    };

    if (existing >= 0) {
      sessionInfo.announcedPresence = registry.sessions[existing].announcedPresence;
      registry.sessions[existing] = sessionInfo;
    } else {
      registry.sessions.push(sessionInfo);
    }

    if (registry.sessions.length === 1) {
      registry.primarySessionId = sessionId;
    }

    const botId = state.botContext?.botId;
    if (botId) {
      if (!registry.primaryByBot) registry.primaryByBot = {};
      if (!registry.primaryByBot[String(botId)]) {
        registry.primaryByBot[String(botId)] = sessionId;
      }
    }

    await writeSessionRegistry(registry);
  }

  async function unregisterSession(): Promise<void> {
    const registry = await readSessionRegistry();
    registry.sessions = registry.sessions.filter(s => s.sessionId !== sessionId);
    cleanRelayFilesByPid(process.pid);
    cleanStaleRelayFiles();

    if (registry.primarySessionId === sessionId && registry.sessions.length > 0) {
      registry.primarySessionId = registry.sessions[0].sessionId;
    }

    const botId = state.botContext?.botId;
    if (botId && registry.primaryByBot) {
      const key = String(botId);
      if (registry.primaryByBot[key] === sessionId) {
        const sameBotSessions = registry.sessions.filter(s => s.botId === botId);
        if (sameBotSessions.length > 0) {
          registry.primaryByBot[key] = sameBotSessions[0].sessionId;
        } else {
          delete registry.primaryByBot[key];
        }
      }
    }

    await writeSessionRegistry(registry);
  }

  async function heartbeatSession(): Promise<void> {
    const registry = await readSessionRegistry();
    const existing = registry.sessions.findIndex(s => s.sessionId === sessionId);
    if (existing >= 0) {
      registry.sessions[existing].lastActivity = Date.now();
      await writeSessionRegistry(registry);
    }

    const botId = state.botContext?.botId;
    if (botId) {
      Db.heartbeatRelaySession(botId, sessionName);
    }
  }

  // ─── Message handling ─────────────────────────────────────────────────

  async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
    const rawText = message.text || message.caption || "";
    const sessionTagMatch = rawText.match(/^@(\S+)\s*/);
    const cleanText = sessionTagMatch ? rawText.replace(sessionTagMatch[0], "") : rawText;
    const targetSessionName = sessionTagMatch ? sessionTagMatch[1] : null;

    // @sessionName prefix → forward via relay
    if (targetSessionName && targetSessionName !== sessionName) {
      try {
        Db.getDb().prepare(
          "UPDATE message_queue SET session_name = ?, session_id = ? WHERE chat_id = ? AND message_id = ? AND status = 'pending'"
        ).run(targetSessionName, targetSessionName, message.chat.id, message.message_id);
      } catch {}

      const forwardResult = await forwardToSession(
        targetSessionName,
        cleanText,
        { chatId: message.chat.id, messageId: message.message_id, sourceSession: sessionName },
      );
      if (forwardResult.ok) {
        if (forwardResult.response && state.config.botToken) {
          await sendReply(state.config.botToken, String(message.chat.id), message.message_id, forwardResult.response);
        }
        return;
      } else {
        if (state.config.botToken) {
          await sendReply(state.config.botToken, String(message.chat.id), message.message_id, `⚠️ Could not reach @${targetSessionName}: ${forwardResult.error}`);
        }
        return;
      }
    }

    const lower = cleanText.toLowerCase();

    if (lower === "stop" || lower === "/stop") {
      if (state.activeTurn) {
        const turnDbId = state.activeTurn.dbId;
        state.activeTurn = undefined;
        completeTurn(turnDbId);
        updateStatus(ctx);
        if (state.config.botToken) {
          await sendReply(state.config.botToken, String(message.chat.id), message.message_id, "Aborted current turn.");
        }
      } else {
        if (state.config.botToken) {
          await sendReply(state.config.botToken, String(message.chat.id), message.message_id, "No active turn.");
        }
      }
      return;
    }

    if (lower === "/help" || lower === "/start") {
      if (state.config.botToken) {
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id, `Teleg-Bridge Active! (this session: ${sessionName})\n\nSend any message to forward to pi.\nPrefix with @sessionName to route to a specific session.\nInclude Twitter/X URLs for automatic media download.\n\nCommands:\n/status - All sessions, relay state & queue\n/queue [session] - Queue for session (or primary)\n/compact - Compact memory\n/health - Test connection\n/healthfull - Full health diagnostic\nstop - Abort current turn`);
      }
      if (!state.config.allowedUserIds || state.config.allowedUserIds.length === 0) {
        state.config.allowedUserIds = [message.from!.id];
        await writeConfig(state.config);
      }
      return;
    }

    if (lower === "/status") {
      await handleStatusCommand(message, ctx);
      return;
    }

    if (lower.startsWith("/queue")) {
      await handleQueueCommand(message, cleanText);
      return;
    }

    if (lower === "/health") {
      const pm = getPollingManager(state.botContext?.botId ?? 0);
      const health = pm.getState();
      if (state.config.botToken) {
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id,
          health.isHealthy ? "✅ Bot connection OK" : "⚠️ Connection issues detected. Auto-reconnecting...");
      }
      return;
    }

    if (lower === "/healthfull") {
      const pm = getPollingManager(state.botContext?.botId ?? 0);
      const health = pm.getState();
      if (state.config.botToken) {
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id, [
          `last successful poll: ${new Date(health.lastSuccessfulPoll).toISOString()}`,
          `last health check: ${new Date(health.lastHealthCheck).toISOString()}`,
          `is healthy: ${health.isHealthy}`,
          `consecutive errors: ${health.consecutiveErrors}`,
          `reconnect delay: ${health.reconnectDelay}ms`,
        ].join("\n"));
      }
      return;
    }

    if (lower === "/compact") {
      if (!ctx.isIdle()) {
        if (state.config.botToken) {
          await sendReply(state.config.botToken, String(message.chat.id), message.message_id, "Cannot compact while busy. Send stop first.");
        }
        return;
      }
      ctx.compact({
        onComplete: () => {
          if (state.config.botToken) {
            void sendReply(state.config.botToken, String(message.chat.id), message.message_id, "Compaction completed.");
          }
        },
        onError: (err) => {
          if (state.config.botToken) {
            void sendReply(state.config.botToken, String(message.chat.id), message.message_id, `Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      });
      if (state.config.botToken) {
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id, "Compaction started.");
      }
      return;
    }

    // ─── Phase 7 Commands ──────────────────────────────────────────────

    if (lower === "/teleg-reconcile") {
      const botId = state.botContext?.botId;
      const report = await reconcileSessions(botId);
      if (state.config.botToken) {
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id, [
          `<b>📊 Reconcile Report</b>`,
          ``,
          `Checked: ${report.checkedSessions} sessions`,
          `Evicted: ${report.evictedSessions.length > 0 ? report.evictedSessions.join(", ") : "none"}`,
          `New primary: ${report.newPrimary ?? "unchanged"}`,
          ...(report.errors.length ? [`⚠️ Errors: ${report.errors.join("; ")}`] : []),
        ].join("\n"));
      }
      return;
    }

    if (lower.startsWith("/teleg-sessions")) {
      const botId = state.botContext?.botId;
      if (!botId || !state.config.botToken) {
        await sendReply(state.config.botToken!, String(message.chat.id), message.message_id, "❌ No bot ID");
        return;
      }
      const summary = await getSessionLivenessSummary(botId);
      const relaySessions = Db.getAliveRelaySessions(botId);
      await sendReply(state.config.botToken, String(message.chat.id), message.message_id, [
        `<b>🖥 Sessions (${relaySessions.length})</b>`,
        ``,
        `<b>Linked (${summary.linked.length}):</b>`,
        ...(summary.linked.length ? summary.linked.map(n => `  ✅ ${n}`) : ["  (none)"]),
        ``,
        `<b>Stale (${summary.stale.length}):</b>`,
        ...(summary.stale.length ? summary.stale.map(n => `  ⚠️ ${n}`) : ["  (none)"]),
        ``,
        `<b>Ghost (${summary.ghost.length}):</b>`,
        ...(summary.ghost.length ? summary.ghost.map(n => `  ❌ ${n}`) : ["  (none)"]),
      ].join("\n"));
      return;
    }

    if (lower.startsWith("/teleg-set-primary")) {
      const parts = cleanText.trim().split(/\s+/);
      const targetName = parts[1];
      if (!targetName || !state.config.botToken) {
        await sendReply(state.config.botToken!, String(message.chat.id), message.message_id, "Usage: /teleg-set-primary <session_name>");
        return;
      }
      const botId = state.botContext?.botId;
      if (!botId) {
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id, "❌ No bot ID");
        return;
      }
      const session = Db.getRelaySession(botId, targetName);
      if (!session) {
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id, `❌ Session "${targetName}" not found`);
        return;
      }
      Db.setPrimary(botId, targetName);
      await sendReply(state.config.botToken, String(message.chat.id), message.message_id, `✅ Primary set to: ${targetName}`);
      return;
    }

    if (lower === "/teleg-bots") {
      const { listConfiguredBots } = await import("./config.js");
      const bots = await listConfiguredBots();
      if (!state.config.botToken) {
        await sendReply(state.config.botToken!, String(message.chat.id), message.message_id, "❌ No bots configured");
        return;
      }
      if (bots.length === 0) {
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id, "❌ No bots configured");
        return;
      }
      await sendReply(state.config.botToken, String(message.chat.id), message.message_id, [
        `<b>🤖 Configured Bots (${bots.length})</b>`,
        ``,
        ...bots.map(b => `  ${b.botId} · @${b.botUsername} · lastUpdateId=${b.lastUpdateId}`),
      ].join("\n"));
      return;
    }

    // Regular message — send to agent
    const turn: PendingTelegramTurn = {
      sessionId,
      sessionName,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      queuedAttachments: [],
      content: [{ type: "text", text: `${TELEGRAM_PREFIX} ${rawText}` }],
      historyText: rawText || "(no text)",
    };

    state.activeTurn = turn as ActiveTelegramTurn;
    updateStatus(ctx);
    pi.sendUserMessage(turn.content);
  }

  // ─── Command handlers ─────────────────────────────────────────────────

  async function handleStatusCommand(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
    if (!state.config.botToken) return;

    const pm = getPollingManager(state.botContext?.botId ?? 0);
    const pollState = pm.getState();
    const botInfo = pm.getBotInfo();
    const botId = state.botContext?.botId;
    const { listConfiguredBots } = await import("./config.js");
    const allBots = await listConfiguredBots();

    const pollingStatus = pm.isActive() ? "✅ active"
      : pm.isHeldByOther() ? "🔁 passive"
      : "⏹ stopped";

    let pollerInfo = "";
    const primary = botId ? Db.getPrimarySession(botId) : null;
    if (primary) {
      pollerInfo = ` (primary: ${primary.session_name}, pid:${primary.pid})`;
    }

    const lines: string[] = [
      `<b>═══ Teleg Bridge Status ═══</b>`,
      ``,
      `🤖 <b>Bot:</b> ${botInfo.username ? `@${botInfo.username}` : "not configured"}${botId ? ` [id:${botId}]` : ""}`,
      `📡 <b>Polling:</b> ${pollingStatus}${pollerInfo}`,
      `💚 <b>Health:</b> ${pollState.isHealthy ? "OK" : `DEGRADED (${pollState.consecutiveErrors} errs)`}`,
    ];

    if (allBots.length > 0) {
      lines.push(``);
      lines.push(`<b>🤖 Bots (${allBots.length}):</b>`);
      for (const b of allBots) {
        const isDefault = b.botId === botId;
        const qStats = Db.getQueueStats(b.botId);
        const bp = Db.getPrimarySession(b.botId);
        const primaryName = bp ? bp.session_name : "none";
        lines.push(`  ${isDefault ? "◆" : "◇"} Bot ${b.botId}: @${b.botUsername} | primary: ${primaryName} | queue: ${qStats.pending}↓ ${qStats.processing}⚡`);
      }
    }

    if (botId) {
      const queueStats = Db.getQueueStats(botId);
      lines.push(``);
      lines.push(`<b>📊 Queue (bot ${botId}):</b> ${queueStats.pending} pending · ${queueStats.processing} active · ${queueStats.completed} done · ${queueStats.failed} failed`);
    }

    if (botId) {
      const summary = await getSessionLivenessSummary(botId);
      const relaySessions = Db.getAliveRelaySessions(botId);
      lines.push(``);
      lines.push(`<b>🖥 Sessions (${relaySessions.length}):</b>`);
      lines.push(`  Linked: ${summary.linked.length > 0 ? summary.linked.join(", ") : "none"}`);
      lines.push(`  Stale: ${summary.stale.length > 0 ? summary.stale.join(", ") : "none"}`);
      lines.push(`  Ghost: ${summary.ghost.length > 0 ? summary.ghost.join(", ") : "none"}`);
    }

    const registry = await readSessionRegistry();
    for (const s of registry.sessions) {
      const isSelf = s.sessionId === sessionId;
      const pm2 = getPollingManager(state.botContext?.botId ?? 0);
      const hasActiveTurn = pm2.hasActiveTurnFor(s.sessionId);
      const role = s.sessionId === sessionId ? (pm2.isActive() ? "active" : "passive") : "relay";
      const relayInfo = botId ? Db.getRelaySession(botId, s.sessionName) : null;
      const relayAlive = relayInfo !== null;
      const isPrimary = relayInfo?.is_primary ?? false;
      const caps = relayInfo?.capabilities ? JSON.parse(relayInfo.capabilities).join(", ") : "—";
      const capReg = await readCapabilitiesRegistry();
      const capEntry = capReg.entries.find(e => e.sessionName === s.sessionName);
      const capList = capEntry?.capabilities?.join(", ") || caps || "—";

      const statusIcon = hasActiveTurn ? "●" : (relayAlive ? "○" : "✗");
      const selfTag = isSelf ? " ← you" : "";
      const primaryTag = isPrimary ? " 👑" : "";
      const activeTag = hasActiveTurn ? " ⚡ busy" : "";

      lines.push(``);
      lines.push(`  ${statusIcon} <b>${s.sessionName}</b>${primaryTag}${activeTag}${selfTag}`);
      lines.push(`    role: ${role} | caps: ${capList}`);
      lines.push(`    pid: ${s.pid}`);
    }

    await sendReply(state.config.botToken, String(message.chat.id), message.message_id, lines.join("\n"));
  }

  async function handleQueueCommand(message: TelegramMessage, cleanText: string): Promise<void> {
    if (!state.config.botToken) return;

    const parts = cleanText.trim().split(/\s+/);
    const targetName = parts.length > 1 ? parts[1] : sessionName;

    const registry = await readSessionRegistry();
    const targetSession = registry.sessions.find(s => s.sessionName === targetName);

    if (!targetSession && targetName !== sessionName) {
      await sendReply(state.config.botToken, String(message.chat.id), message.message_id,
        `❌ Session "${targetName}" not found. Active: ${registry.sessions.map(s => s.sessionName).join(", ")}`);
      return;
    }

    const d = Db.getDb();
    const stats = d.prepare(
      `SELECT status, COUNT(*) as c FROM message_queue WHERE session_name = ? GROUP BY status`
    ).all(targetName) as Array<{ status: string; c: number }>;

    const pending = stats.find(s => s.status === "pending")?.c || 0;
    const processing = stats.find(s => s.status === "processing")?.c || 0;
    const completed = stats.find(s => s.status === "completed")?.c || 0;
    const failed = stats.find(s => s.status === "failed")?.c || 0;

    const recent = d.prepare(
      `SELECT id, text, status, created_at, completed_at, error FROM message_queue WHERE session_name = ? ORDER BY id DESC LIMIT 10`
    ).all(targetName) as Array<{ id: number; text: string; status: string; created_at: number; completed_at: number | null; error: string | null }>;

    const lines: string[] = [
      `<b>📋 Queue: ${targetName}</b>`,
      ``,
      `Pending: ${pending} · Processing: ${processing} · Done: ${completed} · Failed: ${failed}`,
      ``,
      `<b>Recent:</b>`,
    ];

    for (const msg of recent) {
      const time = new Date(msg.created_at).toLocaleTimeString();
      const preview = msg.text.length > 60 ? msg.text.slice(0, 57) + "..." : msg.text;
      const icon = msg.status === "completed" ? "✅" : msg.status === "failed" ? "❌" : msg.status === "processing" ? "⏳" : "⏸";
      const err = msg.error ? ` (${msg.error.slice(0, 40)})` : "";
      lines.push(`  ${icon} <code>#${msg.id}</code> ${time} ${preview}${err}`);
    }

    if (recent.length === 0) lines.push("  (empty)");

    await sendReply(state.config.botToken, String(message.chat.id), message.message_id, lines.join("\n"));
  }

  // ─── Turn completion ─────────────────────────────────────────────────

  function completeTurn(dbId?: number): void {
    const pm = getPollingManager(state.botContext?.botId ?? 0);
    pm.completeTurn(sessionId, dbId);
  }

  function claimNextTurn(): { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number } | null {
    const pm = getPollingManager(state.botContext?.botId ?? 0);
    const result = pm.claimNextTurn(sessionId, sessionName);
    if (!result) return null;
    // Cast to match our internal PendingTelegramTurn which uses Array<{type: "text" | string}> for content
    return result as { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number };
  }

  function claimNextTurnForSession(): { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number } | null {
    const pm = getPollingManager(state.botContext?.botId ?? 0);
    const result = pm.claimNextTurnForSession(sessionName);
    if (!result) return null;
    return result as { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number };
  }

  // ─── Drain one (used in agent_end) ───────────────────────────────────

  async function drainOne(): Promise<boolean> {
    // 1. Pending forwards (relay commands) — highest priority
    if (pendingForwards.length > 0) {
      const next = pendingForwards.shift()!;
      const turn: PendingTelegramTurn = {
        sessionId,
        sessionName,
        chatId: next.chatId,
        replyToMessageId: next.messageId,
        queuedAttachments: [],
        content: [{ type: "text", text: `${TELEGRAM_PREFIX} ${next.text}` }],
        historyText: next.text,
      };
      state.activeTurn = turn as ActiveTelegramTurn;
      pi.sendUserMessage(turn.content, { deliverAs: "steer" });
      return true;
    }

    // 2. Our own session's pending messages
    const queued = claimNextTurnForSession();
    if (queued) {
      state.activeTurn = queued.turn as ActiveTelegramTurn;
      pi.sendUserMessage(queued.turn.content, { deliverAs: "steer" });
      return true;
    }

    // 3. Unassigned messages (cross-session help)
    const queueMsg = claimNextTurn();
    if (queueMsg) {
      state.activeTurn = queueMsg.turn as ActiveTelegramTurn;
      pi.sendUserMessage(queueMsg.turn.content, { deliverAs: "steer" });
      return true;
    }

    return false;
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("teleg-setup", {
    description: "Configure teleg-bridge bot token",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || state.setupInProgress) return;
      state.setupInProgress = true;
      try {
        const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
        if (!token) return;

        const botInfo = await verifyToken(token);
        if (!botInfo) {
          ctx.ui.notify("Invalid Telegram bot token", "error");
          return;
        }

        const newConfig: TelegramConfig = {
          ...state.config,
          botToken: token.trim(),
          botUsername: botInfo.username,
          botId: botInfo.id,
          allowedUserIds: state.config.allowedUserIds || [],
        };

        await writeConfig(newConfig);
        state.config = newConfig;

        ctx.ui.notify(`Teleg-bridge connected: @${botInfo.username}`, "info");
        ctx.ui.notify("Send /start to your bot in Telegram to pair.", "info");

        // Wire config into polling manager
        const pm = getPollingManager(newConfig.botId ?? 0);
        pm.setConfig(newConfig.botToken ?? "", newConfig.lastUpdateId ?? 0);
        pm.setBotInfo({ username: botInfo.username ?? null, displayName: botInfo.username ?? botInfo.first_name });
        await pm.start(sessionName, state.botContext?.dbPath ?? join(homedir(), ".pi", "agent", "teleg-bridge.db"));
        updateStatus(ctx);
      } finally {
        state.setupInProgress = false;
      }
    },
  });

  pi.registerCommand("teleg-status", {
    description: "Show teleg-bridge status",
    handler: async (_args, ctx) => {
      const pm = getPollingManager(state.botContext?.botId ?? 0);
      const health = pm.getState();
      const botInfo = pm.getBotInfo();
      const registry = await readSessionRegistry();
      ctx.ui.notify(
        `bot: ${botInfo.username || "?"} | polling: ${pm.isActive() ? "running" : "stopped"} | sessions: ${registry.sessions.length} | health: ${health.isHealthy ? "OK" : "DEGRADED"}`,
        "info"
      );
    },
  });

  pi.registerCommand("teleg-connect", {
    description: "Start teleg-bridge polling",
    handler: async (_args, ctx) => {
      if (!state.config.botToken) {
        await ctx.ui.input("Telegram bot token", "123456:ABCDEF...").then(async (token) => {
          if (!token) return;
          const botInfo = await verifyToken(token);
          if (!botInfo) { ctx.ui.notify("Invalid Telegram bot token", "error"); return; }
          const newConfig: TelegramConfig = {
            ...state.config,
            botToken: token.trim(),
            botUsername: botInfo.username,
            botId: botInfo.id,
            allowedUserIds: state.config.allowedUserIds || [],
          };
          await writeConfig(newConfig);
          state.config = newConfig;
          ctx.ui.notify(`Teleg-bridge connected: @${botInfo.username}`, "info");
          ctx.ui.notify("Send /start to your bot in Telegram to pair.", "info");
          const pm2 = getPollingManager(newConfig.botId ?? 0);
          pm2.setConfig(newConfig.botToken ?? "", newConfig.lastUpdateId ?? 0);
          pm2.setBotInfo({ username: botInfo.username ?? null, displayName: botInfo.username ?? botInfo.first_name });
          await pm2.start(sessionName, state.botContext?.dbPath ?? join(homedir(), ".pi", "agent", "teleg-bridge.db"));
          updateStatus(ctx);
        });
        return;
      }
      const pm = getPollingManager(state.botContext?.botId ?? 0);
      await pm.start(sessionName, state.botContext?.dbPath ?? join(homedir(), ".pi", "agent", "teleg-bridge.db"));
      updateStatus(ctx);
    },
  });

  pi.registerCommand("teleg-disconnect", {
    description: "Stop teleg-bridge polling (only if last session)",
    handler: async (_args, ctx) => {
      const registry = await readSessionRegistry();
      if (registry.sessions.length > 1) {
        ctx.ui.notify("Cannot stop - other sessions still connected", "info");
        return;
      }
      const pm = getPollingManager(state.botContext?.botId ?? 0);
      await pm.stop();
      updateStatus(ctx);
    },
  });

  pi.registerCommand("teleg-reconnect", {
    description: "Force reconnection to Telegram",
    handler: async (_args, ctx) => {
      const pm = getPollingManager(state.botContext?.botId ?? 0);
      await pm.stop();
      await pm.start(sessionName, state.botContext?.dbPath ?? join(homedir(), ".pi", "agent", "teleg-bridge.db"));
      updateStatus(ctx);
      ctx.ui.notify("Reconnecting to Telegram...", "info");
    },
  });

  // ─── MCP Tools ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "teleg-send_message",
    label: "Send Telegram Message",
    description: "Send a text message to Telegram chat",
    parameters: Type.Object({
      text: Type.String({ description: "Message text to send" }),
      chat_id: Type.Optional(Type.String({ description: "Target chat ID (optional)" })),
    }),
    async execute(_toolCallId, params) {
      const targetChatId = params.chat_id
        ? parseInt(params.chat_id)
        : state.config.allowedUserIds?.[0];
      if (!targetChatId || !state.config.botToken) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const result = await sendReply(state.config.botToken, String(targetChatId), 0, params.text);
      return { content: [{ type: "text", text: result ? `Sent message ${result}` : "Message sent" }], details: {} };
    },
  });

  pi.registerTool({
    name: "teleg-send_photo",
    label: "Send Telegram Photo",
    description: "Send a photo to Telegram chat",
    parameters: Type.Object({
      file_path: Type.String({ description: "Local file path to image" }),
      caption: Type.Optional(Type.String({ description: "Optional caption for the photo" })),
      chat_id: Type.Optional(Type.String({ description: "Target chat ID (optional)" })),
    }),
    async execute(_toolCallId, params) {
      const targetChatId = params.chat_id
        ? parseInt(params.chat_id)
        : state.config.allowedUserIds?.[0];
      if (!targetChatId || !state.config.botToken) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const stats = await stat(params.file_path);
      if (!stats.isFile()) throw new Error(`Not a file: ${params.file_path}`);
      const fileName = params.file_path.split("/").pop() || "photo.jpg";
      const success = await sendFile(state.config.botToken, String(targetChatId), 0, params.file_path, fileName, true, params.caption);
      if (!success) throw new Error("Failed to send photo");
      return { content: [{ type: "text", text: "Photo sent" }], details: {} };
    },
  });

  pi.registerTool({
    name: "teleg-send_video",
    label: "Send Telegram Video",
    description: "Send a video to Telegram chat",
    parameters: Type.Object({
      file_path: Type.String({ description: "Local file path to video" }),
      caption: Type.Optional(Type.String({ description: "Optional caption for the video" })),
      chat_id: Type.Optional(Type.String({ description: "Target chat ID (optional)" })),
    }),
    async execute(_toolCallId, params) {
      const targetChatId = params.chat_id
        ? parseInt(params.chat_id)
        : state.config.allowedUserIds?.[0];
      if (!targetChatId || !state.config.botToken) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const stats = await stat(params.file_path);
      if (!stats.isFile()) throw new Error(`Not a file: ${params.file_path}`);
      const fileName = params.file_path.split("/").pop() || "video.mp4";
      const success = await sendFile(state.config.botToken, String(targetChatId), 0, params.file_path, fileName, false, params.caption);
      if (!success) throw new Error("Failed to send video");
      return { content: [{ type: "text", text: "Video sent" }], details: {} };
    },
  });

  pi.registerTool({
    name: "get_me",
    label: "Get Telegram Bot Info",
    description: "Get information about the bot",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const pm = getPollingManager(state.botContext?.botId ?? 0);
      const botInfo = pm.getBotInfo();
      return { content: [{ type: "text", text: JSON.stringify(botInfo) }], details: {} };
    },
  });

  pi.registerTool({
    name: "get_queue_count",
    label: "Get Queue Count",
    description: "Get the number of pending and processing messages in the queue",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const pm = getPollingManager(state.botContext?.botId ?? 0);
      const depth = pm.getQueueDepth();
      return { content: [{ type: "text", text: `Queue depth: ${depth}` }], details: { count: depth } };
    },
  });

  pi.registerTool({
    name: "get_queue_stats",
    label: "Get Queue Stats",
    description: "Get full queue statistics for messages and downloads",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const botId = state.botContext?.botId;
      const stats = botId ? Db.getQueueStats(botId) : Db.getQueueStats();
      const dlStats = botId ? Db.getDownloadStats(botId) : Db.getDownloadStats();
      const text = `Messages: ${stats.pending} pending · ${stats.processing} processing · ${stats.completed} completed · ${stats.failed} failed\nDownloads: ${dlStats.pending} pending · ${dlStats.processing} processing · ${dlStats.completed} completed · ${dlStats.failed} failed`;
      return { content: [{ type: "text", text }], details: { messages: stats, downloads: dlStats } };
    },
  });

  pi.registerTool({
    name: "get_queue_data",
    label: "Get Queue Data",
    description: "Get queue messages data",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 20)" })),
      status: Type.Optional(Type.String({ description: "Filter by status: pending, processing, completed, failed" })),
    }),
    async execute(_toolCallId, params) {
      const limit = params.limit ?? 20;
      let rows;
      if (params.status) {
        rows = Db.getDb().prepare(`SELECT * FROM message_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(params.status, limit);
      } else {
        rows = Db.getRecentMessages(limit);
      }
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { rows } };
    },
  });

  pi.registerTool({
    name: "get_queue_data_id",
    label: "Get Queue Data By ID",
    description: "Get a specific queue message by its ID",
    parameters: Type.Object({ id: Type.Number({ description: "Queue message ID" }) }),
    async execute(_toolCallId, params) {
      const row = Db.getDb().prepare(`SELECT * FROM message_queue WHERE id = ?`).get(params.id) as Record<string, unknown> | undefined;
      return { content: [{ type: "text", text: row ? JSON.stringify(row, null, 2) : `No message found with id ${params.id}` }], details: { row: row ?? null } };
    },
  });

  pi.registerTool({
    name: "set_queue_status",
    label: "Set Queue Status",
    description: "Update the status of a queue message",
    parameters: Type.Object({
      id: Type.Number({ description: "Queue message ID" }),
      status: Type.Union([Type.Literal("pending"), Type.Literal("processing"), Type.Literal("completed"), Type.Literal("failed")], {
        description: "New status for the message",
      }),
      error: Type.Optional(Type.String({ description: "Error message if status is 'failed'" })),
    }),
    async execute(_toolCallId, params) {
      const now = Date.now();
      let query = `UPDATE message_queue SET status = ?`;
      const args: (string | number)[] = [params.status];
      if (params.status === "completed") {
        query += `, completed_at = ?`;
        args.push(now);
      } else if (params.status === "failed" && params.error) {
        query += `, error = ?`;
        args.push(params.error);
      } else if (params.status === "pending") {
        query += `, started_at = NULL, session_id = 'unassigned', session_name = 'unknown'`;
      }
      query += ` WHERE id = ?`;
      args.push(params.id);
      const result = Db.getDb().prepare(query).run(...args);
      return { content: [{ type: "text", text: `Updated ${result.changes} message(s) to status '${params.status}'` }], details: { changes: result.changes } };
    },
  });

  pi.registerTool({
    name: "teleg-attach",
    label: "Telegram Attach",
    description: "Queue local files to be sent with the next Telegram reply.",
    promptSnippet: "Queue local files to be sent with the next Telegram reply.",
    promptGuidelines: [
      "When handling a [telegram] message and the user asked for a file or generated artifact, call teleg-attach with the local path.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Local file path to attach" })),
    }),
    async execute(_toolCallId, params) {
      if (!state.activeTurn) {
        throw new Error("teleg-attach can only be used while replying to an active Telegram turn");
      }
      const added: string[] = [];
      for (const inputPath of params.paths) {
        const stats = await stat(inputPath);
        if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`);
        if (state.activeTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
          throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
        }
        const fileName = inputPath.split("/").pop() || "file";
        state.activeTurn.queuedAttachments.push({ path: inputPath, fileName });
        added.push(inputPath);
      }
      return { content: [{ type: "text", text: `Queued ${added.length} attachment(s) for Telegram.` }], details: { paths: added } };
    },
  });

  pi.registerTool({
    name: "teleg-clear_backlog",
    label: "Clear Telegram Backlog",
    description: "Clear/reset the message backlog queue.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("reset"), Type.Literal("purge"), Type.Literal("complete"), Type.Literal("fail"), Type.Literal("delete")], {
        description: "Action: 'reset' = unstick stuck processing→pending, 'purge' = delete old completed/failed entries, 'complete' = mark a message completed, 'fail' = mark a message failed, 'delete' = delete pending messages",
      }),
      id: Type.Optional(Type.Number({ description: "Message ID (required for complete/fail actions)" })),
      keep_count: Type.Optional(Type.Number({ description: "How many completed/failed entries to keep on purge (default 500)" })),
    }),
    async execute(_toolCallId, params) {
      let count = 0;
      let id: number | undefined;
      switch (params.action) {
        case "reset": { count = Db.resetAllProcessing(); break; }
        case "purge": { count = Db.purgeOldMessages(params.keep_count ?? 500); break; }
        case "complete": {
          if (!params.id) throw new Error("id required for complete action");
          count = 1; id = params.id;
          Db.completeMessage(params.id);
          break;
        }
        case "fail": {
          if (!params.id) throw new Error("id required for fail action");
          count = 1; id = params.id;
          Db.failMessage(params.id, "Manually marked as failed via clear_backlog tool");
          break;
        }
        case "delete": {
          const d = Db.getDb();
          if (params.id) {
            d.prepare("DELETE FROM message_queue WHERE id = ?").run(params.id);
            count = 1; id = params.id;
          } else {
            const result = d.prepare("DELETE FROM message_queue WHERE status = 'pending'").run();
            count = result.changes;
          }
          break;
        }
      }
      return { content: [{ type: "text", text: `Done (action=${params.action}, count=${count})` }], details: { count, id } };
    },
  });

  // ─── Session Management Tools (Phase 7) ───────────────────────────────

  pi.registerTool({
    name: "teleg-reconcile",
    label: "Reconcile Sessions",
    description: "Check all relay sessions for liveness and evict ghosts.",
    parameters: Type.Object({
      bot_id: Type.Optional(Type.Number({ description: "Bot ID to reconcile (defaults to current bot)" })),
    }),
    async execute(_toolCallId, params) {
      const botId = params.bot_id ?? state.botContext?.botId;
      const report = await reconcileSessions(botId);
      const lines = [
        `📊 Reconcile Report${botId ? ` (bot ${botId})` : ""}`,
        ``,
        `Checked: ${report.checkedSessions} sessions`,
        `Evicted: ${report.evictedSessions.length > 0 ? report.evictedSessions.join(", ") : "none"}`,
        `New primary: ${report.newPrimary ?? "unchanged"}`,
        ...(report.errors.length ? [`Errors: ${report.errors.join("; ")}`] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: report };
    },
  });

  pi.registerTool({
    name: "teleg-list_sessions",
    label: "List Sessions",
    description: "List all relay sessions for a bot with liveness status.",
    parameters: Type.Object({
      bot_id: Type.Optional(Type.Number({ description: "Bot ID (defaults to current bot)" })),
      include_ghosts: Type.Optional(Type.Boolean({ description: "Include ghost sessions in results" })),
    }),
    async execute(_toolCallId, params) {
      const botId = params.bot_id ?? state.botContext?.botId;
      if (!botId) throw new Error("No bot ID available");
      const summary = await getSessionLivenessSummary(botId);
      const db = Db.getDb();
      const allSessions = db.prepare("SELECT * FROM relay_sessions WHERE bot_id = ?").all(botId) as unknown as Db.RelaySession[];
      const result: Record<string, unknown>[] = [];
      for (const s of allSessions) {
        const liveness = summary.ghost.includes(s.session_name) ? "ghost"
          : summary.stale.includes(s.session_name) ? "stale"
          : summary.linked.includes(s.session_name) ? "linked"
          : "unknown";
        if (liveness === "ghost" && !params.include_ghosts) continue;
        result.push({ session_name: s.session_name, pid: s.pid, is_primary: s.is_primary, liveness, heartbeat_age_ms: Date.now() - s.last_heartbeat, role: s.role });
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { sessions: result } };
    },
  });

  pi.registerTool({
    name: "teleg-evict_session",
    label: "Evict Session",
    description: "Evict a session from the registry. Removes from DB, JSON registry, relay file, and optionally kills the PID.",
    parameters: Type.Object({
      session_name: Type.String({ description: "Name of the session to evict" }),
      bot_id: Type.Optional(Type.Number({ description: "Bot ID (defaults to current bot)" })),
      reset_queue: Type.Optional(Type.Boolean({ description: "Reset processing messages for this session" })),
      force_kill_pid: Type.Optional(Type.Boolean({ description: "Force kill the session's PID" })),
    }),
    async execute(_toolCallId, params) {
      const botId = params.bot_id ?? state.botContext?.botId;
      if (!botId) throw new Error("No bot ID available");
      if (params.force_kill_pid) {
        const session = Db.getRelaySession(botId, params.session_name);
        if (session) {
          try { process.kill(session.pid, 9); } catch { /* PID already dead */ }
        }
      }
      evictSession(botId, params.session_name);
      return { content: [{ type: "text", text: `Evicted session: ${params.session_name}` }], details: { session_name: params.session_name, bot_id: botId } };
    },
  });

  pi.registerTool({
    name: "teleg-list_bots",
    label: "List Bots",
    description: "List all configured bots from the global config.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const { listConfiguredBots } = await import("./config.js");
      const bots = await listConfiguredBots();
      if (bots.length === 0) return { content: [{ type: "text", text: "No bots configured" }], details: { bots: [] } };
      const lines = bots.map(b => `- Bot ${b.botId} (@${b.botUsername}) lastUpdateId=${b.lastUpdateId}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { bots } };
    },
  });

  pi.registerTool({
    name: "teleg-set_primary",
    label: "Set Primary Session",
    description: "Manually set a session as primary for a bot.",
    parameters: Type.Object({
      session_name: Type.String({ description: "Name of the session to make primary" }),
      bot_id: Type.Optional(Type.Number({ description: "Bot ID (defaults to current bot)" })),
    }),
    async execute(_toolCallId, params) {
      const botId = params.bot_id ?? state.botContext?.botId;
      if (!botId) throw new Error("No bot ID available");
      Db.setPrimary(botId, params.session_name);
      return { content: [{ type: "text", text: `Set primary to: ${params.session_name}` }], details: { session_name: params.session_name, bot_id: botId } };
    },
  });

  // ─── Session Events ───────────────────────────────────────────────────

  function registerCleanupHandlers(): void {
    const registered = new Set<string>();
    function cleanup(): void {
      try {
        stopRelayServer();
        cleanRelayFilesByPid(process.pid);
        cleanStaleRelayFiles();
      } catch (err) {
        console.error(`[teleg:${sessionName}] Cleanup error:`, err);
      }
    }
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
      if (!registered.has(sig)) {
        registered.add(sig);
        process.on(sig, () => cleanup());
      }
    }
  }
  registerCleanupHandlers();

  pi.on("session_start", async (_event, ctx) => {
    // Run SQLite startup recovery
    const recovery = Db.runStartupRecovery();
    if (recovery.recoveredMessages > 0 || recovery.cleanedSessions > 0 || (recovery.mergedFromLocal ?? 0) > 0) {
      console.log(`[teleg:${sessionName}] DB recovery: ${recovery.recoveredMessages} messages recovered, ${recovery.cleanedSessions} stale sessions cleaned, ${recovery.mergedFromLocal ?? 0} session names merged from local DBs`);
    }

    // Phase 1: Resolve bot context
    try {
      state.botContext = await resolveBotContext(cwd);
      console.log(`[teleg:${sessionName}] Bot context resolved: @${state.botContext.botUsername} (id=${state.botContext.botId})`);

      // Wire bot context into polling manager
      const pm = getPollingManager(state.botContext.botId);
      pm.setConfig(state.botContext.botToken, state.botContext.lastUpdateId);
      pm.setBotInfo({ username: state.botContext.botUsername, displayName: state.botContext.botUsername });

      // Check for split DB warning
      const splitDbWarning = await detectSplitDb(state.botContext.botId, state.botContext.dbPath);
      if (splitDbWarning) console.warn(`[teleg:${sessionName}] ${splitDbWarning}`);
    } catch (err) {
      console.error(`[teleg:${sessionName}] Failed to resolve bot context: ${err}`);
      console.error("[teleg] Set TELEG_BOT_TOKEN, TELEG_BOT_ID, or configure .pi/teleg.json");
    }

    state.config = await readConfig();

    const botId = state.botContext?.botId;

    await registerSession();

    // Phase 5: Reconcile on startup
    if (botId) {
      const report = await reconcileSessions(botId);
      if (report.evictedSessions.length > 0) console.log(`[teleg:${sessionName}] Evicted ghost sessions: ${report.evictedSessions.join(", ")}`);
      if (report.newPrimary) console.log(`[teleg:${sessionName}] Primary elected: ${report.newPrimary}`);
    }

    // Announce presence ONCE per session
    const registry1 = await readSessionRegistry();
    const sessInfo = registry1.sessions.find(s => s.sessionId === sessionId);
    if (sessInfo && !sessInfo.announcedPresence) {
      const chatId = state.config.allowedUserIds?.[0];
      if (chatId && state.config.botToken) {
        const pm = getPollingManager(botId ?? 0);
        const isActivePoller = pm.isActive() || !pm.isHeldByOther();
        const icon = isActivePoller ? "✅" : "🔁";
        const role = isActivePoller ? "active" : "passive";
        try {
          await fetch(`https://api.telegram.org/bot${state.config.botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `${icon} <b>${sessionName}</b> connected (${role})`, parse_mode: "HTML" }),
          });
        } catch { /* Network unavailable — skip */ }
      }
      sessInfo.announcedPresence = true;
      await writeSessionRegistry(registry1);
    }

    // Register session capabilities
    await cleanStaleCapabilities();
    await registerSessionCapabilities(sessionId, sessionName, process.pid, cwd).catch(
      (err: unknown) => console.error(`[teleg:${sessionName}] Failed to register capabilities:`, err)
    );

    // Start relay server
    await startRelayServer(sessionName, 9798, botId).catch(console.error);

    // Register in SQLite relay_sessions table
    if (botId) {
      Db.registerRelaySession({ bot_id: botId, session_name: sessionName, session_id: sessionId, pid: process.pid, port: 9798, secret: "" });
    }

    setCommandHandler(async (text, meta) => {
      pendingForwards.push({
        chatId: meta.chatId,
        messageId: meta.messageId,
        text,
        sourceSession: meta.sourceSession || "unknown",
      });
      const turn: PendingTelegramTurn = {
        sessionId,
        sessionName,
        chatId: meta.chatId,
        replyToMessageId: meta.messageId,
        queuedAttachments: [],
        content: [{ type: "text", text: `${TELEGRAM_PREFIX} ${text}` }],
        historyText: text,
      };
      state.activeTurn = turn as ActiveTelegramTurn;
      try {
        pi.sendUserMessage(turn.content, { deliverAs: "steer" });
      } catch {
        state.activeTurn = undefined;
        completeTurn();
        claimNextTurn();
      }
      return `[${sessionName}] Processing...`;
    });

    setCompleteHandler((id, sourceSession) => {
      if (!sourceSession || sourceSession === "unknown") return;
      try {
        const db = Db.getDb();
        const row = db.prepare("SELECT id FROM message_queue WHERE session_name = ? AND id = ?").get(sourceSession, id) as { id: number } | undefined;
        if (row) db.prepare(`UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ?`).run(Date.now(), row.id);
      } catch (err) {
        console.error("[teleg] complete handler error:", err);
      }
    });

    if (state.config.botToken) {
      const pm = getPollingManager(botId ?? 0);
      await pm.start(sessionName, state.botContext?.dbPath ?? join(homedir(), ".pi", "agent", "teleg-bridge.db"));
    }

    // Wire up polling message handler
    const pm = getPollingManager(botId ?? 0);
    pm.onMessage(async (update, dbId) => {
      const message = update.message || update.edited_message;
      if (!message) return;
      const activeSessionId = state.activeTurn?.sessionId;
      if (activeSessionId && activeSessionId !== sessionId && activeSessionId !== "unassigned") return;
      await handleAuthorizedTelegramMessage(message, ctx);
    });

    // Periodic tasks: heartbeat, reconcile, polling restart
    setInterval(async () => {
      await heartbeatSession();
      if (botId) {
        await reconcileSessions(botId).catch((err) => console.error(`[teleg:${sessionName}] Reconcile failed:`, err));
      }
      const pm2 = getPollingManager(botId ?? 0);
      if (!pm2.isActive() && state.config.botToken) {
        if (!pm2.isHeldByOther()) {
          console.log(`[teleg:${sessionName}] Polling inactive, auto-restarting...`);
          await pm2.start(sessionName, state.botContext?.dbPath ?? join(homedir(), ".pi", "agent", "teleg-bridge.db")).catch((err) =>
            console.error(`[teleg:${sessionName}] Auto-restart failed:`, err)
          );
        }
      }
    }, 30000);

    // Phase 6: Active idle drain timer
    state.drainTimer = setInterval(async () => {
      if (state.activeTurn) return;
      if (!botId) return;
      try {
        const queued = claimNextTurnForSession();
        if (queued) {
          state.activeTurn = queued.turn as ActiveTelegramTurn;
          pi.sendUserMessage(queued.turn.content, { deliverAs: "steer" });
          return;
        }
        const queueMsg = claimNextTurn();
        if (queueMsg) {
          state.activeTurn = queueMsg.turn as ActiveTelegramTurn;
          pi.sendUserMessage(queueMsg.turn.content, { deliverAs: "steer" });
        }
      } catch (err) {
        console.error(`[teleg:${sessionName}] Drain error:`, err);
      }
    }, DRAIN_INTERVAL_MS);

    updateStatus(ctx);
  });

  // ─── Session Events ───────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = undefined; }
    state.activeTurn = undefined;
    pendingForwards.length = 0;
    completeTurn();
    stopRelayServer();

    const registry2 = await readSessionRegistry();
    const dying = registry2.sessions.find(s => s.sessionId === sessionId);
    if (dying && dying.announcedPresence) {
      const chatId = state.config.allowedUserIds?.[0];
      if (chatId && state.config.botToken) {
        const pm = getPollingManager(state.botContext?.botId ?? 0);
        const isActivePoller = pm.isActive() || !pm.isHeldByOther();
        const icon = isActivePoller ? "⚠️" : "🔁";
        const role = isActivePoller ? "active" : "passive";
        try {
          await fetch(`https://api.telegram.org/bot${state.config.botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `${icon} <b>${sessionName}</b> disconnected (${role})`, parse_mode: "HTML" }),
          });
        } catch { /* Network unavailable — skip */ }
      }
    }

    await unregisterSessionCapabilities(sessionId);
    await unregisterSession();

    const botId = state.botContext?.botId;
    if (botId) Db.unregisterRelaySession(botId, sessionName);

    const registry = await readSessionRegistry();
    if (registry.sessions.length === 0) {
      const pm = getPollingManager(botId ?? 0);
      await pm.stop();
    }
  });

  pi.on("before_agent_start", async (event) => {
    const archiveRoot = getArchiveRoot(state.config);
    let suffix = SYSTEM_PROMPT_SUFFIX.replace("{archiveRoot}", archiveRoot);
    suffix = suffix.replace("{sessionName}", sessionName);
    suffix = suffix.replace("{projectDir}", process.cwd());
    const promptSuffix = isTelegramPrompt(event.prompt)
      ? `${suffix}\n- The current user message came from Telegram.`
      : suffix;
    return { systemPrompt: event.systemPrompt + promptSuffix };
  });

  function isTelegramPrompt(prompt: string): boolean {
    return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
  }

  pi.on("agent_start", async (_event, ctx) => {
    if (!state.activeTurn) {
      const queued = claimNextTurn();
      if (queued) state.activeTurn = queued.turn as ActiveTelegramTurn;
    }
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const turn = state.activeTurn;
    state.activeTurn = undefined;
    completeTurn(turn?.dbId);
    updateStatus(ctx);

    let assistantText = "";
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i] as unknown as Record<string, unknown>;
      if (msg.role === "assistant") {
        const content = Array.isArray(msg.content) ? msg.content : [];
        assistantText = content
          .filter((block): block is { type: string; text?: string } =>
            typeof block === "object" && block !== null && "type" in block && block.type === "text" && typeof block.text === "string"
          )
          .map(block => block.text)
          .join("")
          .trim();
        break;
      }
    }

    const forward = pendingForwards.length > 0 ? pendingForwards.shift() : null;

    if (forward && state.config.botToken) {
      const response = assistantText || "(no response)";
      const taggedResponse = `[<b>${sessionName}</b>]\n${response}`;
      try {
        await fetch(`https://api.telegram.org/bot${state.config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: forward.chatId, text: taggedResponse, reply_to_message_id: forward.messageId, parse_mode: "HTML" }),
        });
      } catch {
        console.error(`[teleg:${sessionName}] Failed to deliver relay response:`, forward);
      }
      if (turn) {
        for (const attachment of turn.queuedAttachments) {
          const ext = attachment.fileName.split(".").pop()?.toLowerCase();
          const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext || "");
          try {
            const method = isImage ? "sendPhoto" : "sendDocument";
            const fieldName = isImage ? "photo" : "document";
            const form = new FormData();
            form.set("chat_id", String(forward.chatId));
            const buffer = await readFile(attachment.path);
            form.set(fieldName, new Blob([buffer]), attachment.fileName);
            await fetch(`https://api.telegram.org/bot${state.config.botToken}/${method}`, { method: "POST", body: form });
          } catch {}
        }
      }
    } else if (turn && state.config.botToken) {
      if (assistantText) {
        await sendReply(state.config.botToken, String(turn.chatId), turn.replyToMessageId, assistantText);
      } else if (turn.queuedAttachments.length > 0) {
        await sendReply(state.config.botToken, String(turn.chatId), turn.replyToMessageId, "Attached requested file(s).");
      }
      for (const attachment of turn.queuedAttachments) {
        const ext = attachment.fileName.split(".").pop()?.toLowerCase();
        const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext || "");
        await sendFile(state.config.botToken, String(turn.chatId), turn.replyToMessageId, attachment.path, attachment.fileName, isImage);
      }
    }

    // Drain queue until empty
    if (await drainOne()) {
      // Message sent to agent, will trigger another agent_end
    } else {
      state.activeTurn = undefined;
      updateStatus(ctx);
    }
  });
}