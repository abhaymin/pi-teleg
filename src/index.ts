/**
 * pi-teleg - Multi-Session Telegram Bridge Extension for Pi
 * 
 * Architecture:
 * - Per-bot polling via PollingManager (one manager per botId)
 * - Sessions are isolated by bot context and session scope
 * - Messages are queued and dispatched to sessions with active turns
 * - Each session has its own turn state and its own session-scoped queue claims
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
  setShutdownHandler,
  cleanStaleRelayFiles,
  cleanRelayFilesByPid,
} from "./relay.js";
import * as Db from "./db.js";
import { reconcileSessions, getSessionLivenessSummary, evictSession, electPrimary } from "./session-registry.js";
import {
  resolveBotContext,
  resolveFromBotId,
  setDefaultBotId,
  listConfiguredBots,
  getDefaultBotId,
  detectSplitDb,
  updateAllowedUsers,
  writeProjectConfig,
  type BotContext,
  type ProjectConfig,
} from "./config.js";
import {
  readConfig,
  writeConfig,
  readSessionRegistry,
  writeSessionRegistry,
  getSessionId,
  isAllowedUser,
  isAllowedChat,
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
import { getPollingManager, getAllPollingManagers, type PollState } from "./polling-manager.js";

// ============================================================================
// Constants
// ============================================================================

const DRAIN_INTERVAL_MS = parseInt(process.env.TELEG_DRAIN_INTERVAL_MS || "12000", 10);
const CLAIM_OTHERS = process.env.TELEG_CLAIM_OTHERS === "1";
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
  poll?: { id: string; question: string; options: Array<{ text: string }> };
  reply_to_message?: TelegramMessage;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  video?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number; file_size?: number };
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_unique_id: string; duration: number; performer?: string; title?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
}

interface TelegramReactionType {
  type: string;
  emoji: string;
}

interface TelegramMessageReactionUpdated {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
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


interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  message_reaction?: TelegramMessageReactionUpdated;
  poll?: { id: string; question: string; options: Array<{ text: string }> };
  poll_answer?: { poll_id: string; user?: { id: number; username?: string; first_name?: string }; option_ids: number[] };
}

interface PendingTelegramTurn {
  sessionId: string;
  sessionName: string;
  chatId: number;
  replyToMessageId: number;
  queuedAttachments: QueuedAttachment[];
  // Media the Telegram user sent IN (downloaded by the poll worker). Local file
  // paths the agent may read; never re-sent outbound on reply (unlike queuedAttachments).
  incomingAttachments: QueuedAttachment[];
  content: Array<TextContent | ImageContent>;
  historyText: string;
  replyChainText?: string;
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
  livenessTimer: ReturnType<typeof setInterval> | undefined;
  setupInProgress: boolean;
}

interface PendingForward {
  chatId: number;
  messageId: number;
  text: string;
  sourceSession: string;
}

// ============================================================================
// Attachment / poll helpers
// ============================================================================

// Read the worker-downloaded local media paths persisted on the message row.
// The poll worker downloads via getFile and stores a JSON array here; these are
// real readable local paths (never Telegram file_ids).
function readIncomingAttachments(dbId?: number): QueuedAttachment[] {
  if (!dbId) return [];
  try {
    const row = Db.getDb().prepare("SELECT attachments FROM message_queue WHERE id = ?").get(dbId) as { attachments: string | null } | undefined;
    if (!row?.attachments) return [];
    const parsed = JSON.parse(row.attachments) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a): a is { path: string; fileName: string } =>
        typeof a === "object" && a !== null && typeof (a as { path?: unknown }).path === "string" && typeof (a as { fileName?: unknown }).fileName === "string")
      .map((a) => ({ path: a.path, fileName: a.fileName }));
  } catch {
    return [];
  }
}

function describePoll(message: TelegramMessage): string {
  if (!message.poll) return "";
  const options = message.poll.options.map((option, index) => `${index + 1}. ${option.text}`).join("\n");
  return [`[poll] ${message.poll.question}`, options].join("\n");
}

// Recover option labels from a stored poll text block (produced by formatPollText
// or describePoll) so a poll_answer's numeric option_ids can be shown by label.
function parsePollOptions(pollText: string): string[] {
  const out: string[] = [];
  for (const line of pollText.split("\n")) {
    const m = line.match(/^\s*\d+\.\s+(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
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
- This session has registered its capabilities with the teleg bridge based on INFO_REL.md.
- To declare what this session handles, create an INFO_REL.md in the project root with:
  # INFO_REL
  ## capabilities
  keyword1, keyword2, ...
  ## description
  What this session does
- Other sessions with matching capabilities will get relevant messages relayed to them automatically.
- Messages addressed to a specific session (e.g., "@sessionName ...") are routed directly.
- If you receive a relayed message from Telegram, process the request and send results back using teleg-send_message, teleg-send_photo, teleg-send_video, or teleg-attach tools.

## Sub-Agent & Multi-Session Routing
- This extension supports multi-session routing. Multiple pi sessions can connect to the same bot.
- Each session reads its INFO_REL.md to declare capabilities. Messages are auto-routed based on content.
- To delegate work to another session from Telegram, use @sessionName prefix (e.g., "@data-scrapper download this video").
- To delegate work programmatically, use teleg-send_message to notify the user and forward messages via the relay.
- All connected sessions are active. Each session independently drains its queue based on capabilities.
- Kill-switches: /teleg-dc disconnects this session, /teleg-dc-all disconnects all sessions without cleaning DB state.
- Cleanup switches are separate: /teleg-clean-db resets queue state; /teleg-remove-sessions removes stale session registry records.
- teleg-disconnect, teleg-disconnect-all, teleg-clean-db, and teleg-remove-sessions MCP tools provide the same from any pi session.`;

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
async function selectBotForSession(projectDir: string): Promise<BotContext | undefined> {
  try {
    return await resolveBotContext(projectDir);
  } catch {
    return undefined;
  }
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
    livenessTimer: undefined,
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

  function normalizeConfigFromBotContext(botContext: BotContext): void {
    state.config = {
      ...state.config,
      botToken: botContext.botToken,
      botUsername: botContext.botUsername,
      botId: botContext.botId,
      allowedUserIds: botContext.allowedUserIds || [],
      allowedChatIds: botContext.allowedChatIds || [],
      lastUpdateId: botContext.lastUpdateId,
    };
  }

  function currentBotId(): number | undefined {
    const botId = state.botContext?.botId ?? state.config.botId;
    return botId && botId > 0 ? botId : undefined;
  }

  function currentBotToken(): string | undefined {
    return state.botContext?.botToken || state.config.botToken;
  }

  function currentAllowedUserIds(): number[] {
    return state.botContext?.allowedUserIds || state.config.allowedUserIds || [];
  }

  function currentAllowedChatIds(): number[] {
    return state.botContext?.allowedChatIds || state.config.allowedChatIds || [];
  }

  function getUpdateMessage(update: TelegramUpdate): TelegramMessage | undefined {
    return update.message || update.edited_message || update.channel_post || update.edited_channel_post;
  }

  function normalizeTelegramCommand(text: string): string {
    return text.replace(/^\/([a-z0-9_-]+)@[^\s]+/i, "/$1");
  }

  function isAuthorizedTelegramMessage(message: TelegramMessage): boolean {
    const text = normalizeTelegramCommand((message.text || message.caption || "").toLowerCase());

    // Initial pairing: only when no users are configured yet AND the message
    // is a private /start or /help from a real (non-bot) user.  This is the
    // one-time bootstrap window — once any user is registered, this path
    // closes permanently for this bot.
    const allowInitialPrivatePairing =
      currentAllowedUserIds().length === 0 &&
      message.chat.type === "private" &&
      message.from && !message.from.is_bot &&
      (text === "/start" || text === "/help");

    if (allowInitialPrivatePairing) return true;
    if (message.from && !message.from.is_bot && isAllowedUser(state.config, message.from.id)) return true;
    return isAllowedChat(state.config, message.chat.id);
  }

  function currentDbPath(): string {
    return state.botContext?.dbPath ?? join(homedir(), ".pi", "agent", "teleg-bridge.db");
  }

  function currentPollingManager(): import("./polling-manager.js").PollingManager | null {
    const botId = currentBotId();
    return botId ? getPollingManager(botId) : null;
  }

  async function refreshBotContext(): Promise<void> {
    const previousBotId = state.botContext?.botId;
    state.botContext = await resolveBotContext(cwd);
    // Enforce: one instance, one bot. Reject if the resolved bot changed.
    if (previousBotId && state.botContext.botId !== previousBotId) {
      throw new Error(
        `Bot identity conflict: was ${previousBotId}, resolved ${state.botContext.botId}. ` +
        `One instance must use a single bot. Check TELEG_BOT_TOKEN / .pi/teleg.json.`
      );
    }
    normalizeConfigFromBotContext(state.botContext);
    const pm = getPollingManager(state.botContext.botId);
    pm.setConfig(state.botContext.botToken, state.botContext.lastUpdateId);
    pm.setBotInfo({ username: state.botContext.botUsername, displayName: state.botContext.botUsername });
  }

  async function persistProjectConfig(patch: ProjectConfig): Promise<void> {
    await writeProjectConfig(cwd, {
      botId: patch.botId ?? currentBotId(),
      botUsername: patch.botUsername ?? state.botContext?.botUsername ?? state.config.botUsername,
      botToken: patch.botToken ?? currentBotToken(),
      allowedUserIds: patch.allowedUserIds ?? currentAllowedUserIds(),
      allowedChatIds: patch.allowedChatIds ?? currentAllowedChatIds(),
      lastUpdateId: patch.lastUpdateId ?? state.botContext?.lastUpdateId ?? state.config.lastUpdateId ?? 0,
      dbPath: patch.dbPath ?? currentDbPath(),
    });
  }

  // ─── Status UI ────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext, error?: string): void {
    const theme = ctx.ui.theme;
    const label = `${theme.fg("accent", "teleg")}${theme.fg("muted", ":" + sessionName)}`;

    const pm = currentPollingManager();
    const pollState = pm?.getState() ?? {
      consecutiveErrors: 0,
      reconnectDelay: 1000,
      lastSuccessfulPoll: Date.now(),
      isHealthy: true,
      lastHealthCheck: Date.now(),
    };
    const healthIndicator = pollState.isHealthy ? "✓" : "✗";
    const errorIndicator = pollState.consecutiveErrors > 0
      ? ` [${pollState.consecutiveErrors} errs]`
      : "";

    if (error) {
      ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}${errorIndicator}`);
      return;
    }
    if (!currentBotToken() || !pm) {
      ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("muted", "not configured")}`);
      return;
    }
    if (!pm.isActive() && !pm.isHeldByOther()) {
      ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("warning", "reconnecting...")}`);
      return;
    }
    // All sessions are active — show queue depth whether polling or drain-only
    const queueDepth = pm.getQueueDepth();
    const selfQueue = Db.getPendingCountForSession(pm.botId, sessionName);
    const activeIndicator = state.activeTurn
      ? theme.fg("accent", "●")
      : theme.fg("success", healthIndicator);
    const queued = queueDepth > 0 ? ` +${queueDepth}` : "";
    const selfQ = selfQueue > 0 ? ` [${selfQueue}]` : "";
    ctx.ui.setStatus("teleg-bridge", `${label} ${activeIndicator}${queued}${selfQ}${errorIndicator}`);
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

  function assignIncomingToSession(message: TelegramMessage, targetSessionName: string, dbId?: number): void {
    if (typeof dbId === "number") {
      Db.assignMessageToSession(dbId, targetSessionName);
      return;
    }
    const botId = currentBotId();
    if (!botId) return;
    Db.assignTelegramMessageToSession(botId, message.chat.id, message.message_id, targetSessionName);
  }

  function markIncomingProcessing(dbId: number | undefined): void {
    if (typeof dbId !== "number") return;
    Db.markMessageProcessing(dbId, sessionId, sessionName);
  }

  function completeIncoming(dbId: number | undefined): void {
    if (typeof dbId !== "number") return;
    Db.completeMessage(dbId);
  }

  async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext, dbId?: number): Promise<void> {
    const rawText = message.text || message.caption || "";
    const sessionTagMatch = rawText.match(/^@(\S+)\s*/);
    const cleanText = sessionTagMatch ? rawText.replace(sessionTagMatch[0], "") : rawText;
    const targetSessionName = sessionTagMatch ? sessionTagMatch[1] : null;

    // @sessionName prefix → queue the message for that session.
    // Queue-based delivery gives the target session reliable queue management,
    // service activeness, retries/recovery, and status visibility.
    if (targetSessionName) {
      const myBotId = currentBotId();
      const registry = await readSessionRegistry();
      // Scope lookup to sessions under this bot first
      const targetSession = registry.sessions.find(s => s.sessionName === targetSessionName && s.botId === myBotId);
      if (targetSession) {
        // Registered on this bot — but only queue if the target is actually
        // alive and able to drain its queue. A dead-but-registered session
        // would accept the message yet never process it, so reject explicitly
        // instead of queueing indefinitely. Liveness reuses the same PID
        // check the shared-chat tier relies on (Db.getAliveRelaySessions).
        const aliveSessionNames = myBotId != null
          ? Db.getAliveRelaySessions(myBotId).map(s => s.session_name)
          : [];
        if (aliveSessionNames.includes(targetSessionName)) {
          assignIncomingToSession(message, targetSessionName, dbId);
          if (state.config.botToken) {
            const pending = Db.getPendingCountForSession(myBotId!, targetSessionName);
            await sendReply(state.config.botToken, String(message.chat.id), message.message_id,
              `📥 Queued for @${targetSessionName} (${pending} pending)`);
          }
          return;
        }
        // Registered on this bot but silent (not currently linked). Keep the
        // message queued for it so the session drains it when it reconnects,
        // or another linked session on this bot claims it via the
        // fallback-claim path. Rejecting would lose the message; queuing keeps
        // it recoverable while staying bot-scoped (no cross-bot routing).
        assignIncomingToSession(message, targetSessionName, dbId);
        if (state.config.botToken) {
          const pending = Db.getPendingCountForSession(myBotId!, targetSessionName);
          await sendReply(state.config.botToken, String(message.chat.id), message.message_id,
            `📥 @${targetSessionName} is silent. Queued (${pending} pending) — a linked session may respond.\nLive: ${aliveSessionNames.join(", ") || "none"}`);
        }
        return;
      }
      // Not found on this bot — check if it exists on another bot
      const otherBotSession = registry.sessions.find(s => s.sessionName === targetSessionName);
      if (otherBotSession && otherBotSession.botId !== myBotId) {
        if (state.config.botToken) {
          await sendReply(state.config.botToken, String(message.chat.id), message.message_id,
            `❌ @${targetSessionName} is connected to a different bot. Cross-bot routing is not supported.`);
        }
        completeIncoming(dbId);
        return;
      }
      // Session not found at all — reject explicitly, don't fall through
      if (state.config.botToken) {
        const activeSessions = registry.sessions.filter(s => s.botId === myBotId).map(s => s.sessionName);
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id,
          `❌ @${targetSessionName} not found. Active: ${activeSessions.join(", ") || "none"}`);
      }
      completeIncoming(dbId);
      return;
    }

    if (!targetSessionName) {
      const botId = state.botContext?.botId;
      if (botId) {
        const capReg = await readCapabilitiesRegistry();
        const aliveEntries = capReg.entries.filter(e => {
          if (e.sessionName === sessionName) return false;
          try { process.kill(e.pid, 0); return true; } catch { return false; }
        }).filter(e => e.botId === botId);

        const match = matchMessageToCapability(cleanText, aliveEntries);
        if (match) {
          assignIncomingToSession(message, match.sessionName, dbId);
          if (state.config.botToken) {
            const pending = Db.getPendingCountForSession(botId, match.sessionName);
            await sendReply(state.config.botToken, String(message.chat.id), message.message_id,
              `📥 Queued for @${match.sessionName} (${match.capabilities.join(", ")}; ${pending} pending)`);
          }
          return;
        }
      }
    }

    const lower = normalizeTelegramCommand(cleanText.toLowerCase());
    if (lower === "stop" || lower.startsWith("/")) completeIncoming(dbId);

    if (lower === "stop" || lower === "/stop") {
      if (state.activeTurn) {
        const turnDbId = state.activeTurn.dbId;
        deactivateTurn();
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

    // ─── Kill-switch commands ────────────────────────────────────────

    if (lower === "/teleg-dc" || lower === "/teleg-disconnect") {
      // Kill THIS session only
      if (state.activeTurn) {
        completeTurn(state.activeTurn.dbId);
        deactivateTurn();
      }
      if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = undefined; }
      if (state.livenessTimer) { clearInterval(state.livenessTimer); state.livenessTimer = undefined; }
      const pm = currentPollingManager();
      if (pm && pm.isActive()) await pm.stop();
      stopRelayServer();
      stopTyping();
      await unregisterSessionCapabilities(sessionId);
      await unregisterSession();
      const botId = currentBotId();
      if (botId) Db.unregisterRelaySession(botId, sessionName);
      const botToken = currentBotToken();
      if (botToken) {
        await sendReply(botToken, String(message.chat.id), message.message_id, `🔌 Disconnected session: <b>${sessionName}</b>`);
      }
      updateStatus(ctx);
      return;
    }

    if (lower === "/teleg-dc-all" || lower === "/teleg-disconnect-all") {
      // Kill ALL sessions for THIS bot only. Do NOT clean queue DB or remove
      // registry records here. Scoping to the current bot prevents a cross-bot
      // blast radius where one bot's kill-switch terminates another bot's sessions.
      if (state.activeTurn) {
        completeTurn(state.activeTurn.dbId);
        deactivateTurn();
      }
      if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = undefined; }
      if (state.livenessTimer) { clearInterval(state.livenessTimer); state.livenessTimer = undefined; }
      const pm = currentPollingManager();
      if (pm && pm.isActive()) await pm.stop();
      const botId = currentBotId();
      const registry = await readSessionRegistry();
      const targets = botId
        ? registry.sessions.filter((s) => s.botId === botId && s.sessionId !== sessionId)
        : registry.sessions.filter((s) => s.sessionId !== sessionId);
      for (const s of targets) {
        try { process.kill(s.pid, 9); } catch { /* already dead */ }
        cleanRelayFilesByPid(s.pid);
      }
      stopRelayServer();
      stopTyping();
      await unregisterSessionCapabilities(sessionId);
      await unregisterSession();
      const botToken = currentBotToken();
      if (botToken) {
        await sendReply(botToken, String(message.chat.id), message.message_id, `🔌 Disconnected ${targets.length} session${targets.length === 1 ? "" : "s"} for bot ${botId ?? "?"}. DB unchanged.`);
      }
      updateStatus(ctx);
      return;
    }

    if (lower === "/teleg-clean-db") {
      // Scope to the current bot so this cleanup can't reset another bot's
      // in-flight work (cross-bot blast radius). No-op if no bot is bound here.
      const botId = currentBotId();
      const reset = botId ? Db.resetAllProcessing(botId) : 0;
      const purged = botId ? Db.purgeOldMessages(500, botId) : 0;
      const botToken = currentBotToken();
      if (botToken) {
        await sendReply(botToken, String(message.chat.id), message.message_id, `🧹 DB cleaned (bot ${botId ?? "none"}): ${reset} processing reset, ${purged} old messages purged.`);
      }
      return;
    }

    if (lower === "/teleg-remove-sessions") {
      const botId = currentBotId();
      const registry = await readSessionRegistry();
      const removed: string[] = [];
      for (const s of registry.sessions) {
        try { process.kill(s.pid, 0); } catch {
          removed.push(s.sessionName);
          cleanRelayFilesByPid(s.pid);
          if (botId) Db.unregisterRelaySession(botId, s.sessionName);
        }
      }
      registry.sessions = registry.sessions.filter(s => !removed.includes(s.sessionName));
      await writeSessionRegistry(registry);
      const botToken = currentBotToken();
      if (botToken) {
        await sendReply(botToken, String(message.chat.id), message.message_id, `🗑 Removed ${removed.length} dead session(s): ${removed.join(", ") || "none"}`);
      }
      updateStatus(ctx);
      return;
    }

    if (lower === "/help" || lower === "/start") {
      const botToken = currentBotToken();
      if (botToken) {
        await sendReply(botToken, String(message.chat.id), message.message_id, `Teleg-Bridge Active! (this session: ${sessionName})\n\nSend any message to forward to pi.\nPrefix with @sessionName to route to a specific session.\nInclude Twitter/X URLs for automatic media download.\n\nCommands:\n/status - All sessions, relay state & queue\n/chatid - Show current chat/user IDs for group/channel setup\n/queue [session] - Queue for session (or primary)\n/teleg-dc - Disconnect THIS session\n/teleg-dc-all - Disconnect ALL sessions, DB unchanged\n/teleg-clean-db - Reset processing queue + purge old entries\n/teleg-remove-sessions - Remove dead session registry records\n/compact - Compact memory\n/health - Test connection\n/healthfull - Full health diagnostic\nstop - Abort current turn`);
      }
      if (currentAllowedUserIds().length === 0) {
        const ids = [message.from!.id];
        const botId = currentBotId();
        state.config.allowedUserIds = ids;
        if (state.botContext) state.botContext.allowedUserIds = ids;
        if (botId) {
          await updateAllowedUsers(botId, ids);
          await persistProjectConfig({ allowedUserIds: ids });
        } else {
          await writeConfig(state.config);
        }
      }
      return;
    }

    if (lower === "/chatid") {
      const botToken = currentBotToken();
      if (botToken) {
        await sendReply(botToken, String(message.chat.id), message.message_id, [
          `<b>Chat</b>: ${message.chat.id}`,
          `<b>Type</b>: ${message.chat.type}`,
          message.from ? `<b>User</b>: ${message.from.id}${message.from.username ? ` (@${message.from.username})` : ""}` : `<b>User</b>: unavailable (channel/anonymous post)`,
        ].join("\n"));
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
      const pm = currentPollingManager();
      const health = pm?.getState();
      const botToken = currentBotToken();
      if (botToken) {
        await sendReply(botToken, String(message.chat.id), message.message_id,
          health?.isHealthy !== false ? "✅ Bot connection OK" : "⚠️ Connection issues detected. Auto-reconnecting...");
      }
      return;
    }

    if (lower === "/healthfull") {
      const pm = currentPollingManager();
      const health = pm?.getState();
      const botToken = currentBotToken();
      if (botToken && health) {
        await sendReply(botToken, String(message.chat.id), message.message_id, [
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
      const raw = await reconcileSessions(botId);
      const reports = Array.isArray(raw) ? raw : [raw];
      if (state.config.botToken) {
        const lines: string[] = [`<b>📊 Reconcile Report</b>`, ``];
        for (const report of reports) {
          if (reports.length > 1) lines.push(`<b>Bot ${report.botId}</b>`);
          lines.push(
            `Checked: ${report.checkedSessions} sessions`,
            `Evicted: ${report.evictedSessions.length > 0 ? report.evictedSessions.join(", ") : "none"}`,
            `New primary: ${report.newPrimary ?? "unchanged"}`,
            ...(report.errors.length ? [`⚠️ Errors: ${report.errors.join("; ")}`] : []),
          );
        }
        await sendReply(state.config.botToken, String(message.chat.id), message.message_id, lines.join("\n"));
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

    // ─── Shared-bot group/channel coordination ────────────────────────────
    // For non-private chats, prefer the session on THIS bot that already has
    // context for this chat, so a shared group/channel conversation stays with
    // one session instead of fragmenting across sessions. This tier sits below
    // explicit @session and capability routing, and above the current-session
    // fallback. Every candidate is scoped to the current bot, so routing never
    // crosses bots.
    {
      const botId = currentBotId();
      const chatType = message.chat.type;
      if (botId && (chatType === "group" || chatType === "supergroup" || chatType === "channel")) {
        const ownerSession = Db.getLastSessionForChat(botId, message.chat.id);
        if (ownerSession && ownerSession !== sessionName) {
          // Only route to the owner if it is still alive and registered on this bot
          const ownerAlive = Db.getAliveRelaySessions(botId).some(s => s.session_name === ownerSession);
          if (ownerAlive) {
            assignIncomingToSession(message, ownerSession, dbId);
            if (state.config.botToken) {
              const pending = Db.getPendingCountForSession(botId, ownerSession);
              await sendReply(
                state.config.botToken,
                String(message.chat.id),
                message.message_id,
                `📥 Queued for @${ownerSession} (shared ${chatType} context${pending > 0 ? `; ${pending} pending` : ""})`,
              );
            }
            return;
          }
        }
      }
    }

    // Regular message — queue if this session is already processing, otherwise send to the agent immediately.
    if (!ctx.isIdle() || state.activeTurn) {
      assignIncomingToSession(message, sessionName, dbId);
      if (state.config.botToken) {
        const botId = currentBotId();
        const pending = botId ? Db.getPendingCountForSession(botId, sessionName) : 0;
        await sendReply(
          state.config.botToken,
          String(message.chat.id),
          message.message_id,
          `📥 Queued for @${sessionName}${pending > 0 ? ` (${pending} pending)` : ""}`,
        );
      }
      return;
    }
    // Build reply chain context from the nested reply_to_message and DB
    const replyChainText = buildReplyChain(message);
    // Incoming media is downloaded by the poll worker and persisted on the row;
    // read the real local paths here (never Telegram file_ids).
    const incomingAttachments = readIncomingAttachments(dbId);
    const mediaText = incomingAttachments.length > 0
      ? `📎 Incoming media:\n${incomingAttachments.map(a => `- ${a.path} (${a.fileName})`).join("\n")}`
      : "";
    const pollText = describePoll(message);
    const bodyText = [replyChainText, mediaText, pollText, rawText || "(no text)"]
      .filter(Boolean)
      .join("\n");
    const turn: PendingTelegramTurn = {
      sessionId,
      sessionName,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      queuedAttachments: [],
      incomingAttachments,
      content: [{ type: "text", text: `${TELEGRAM_PREFIX} ${bodyText}` }],
      historyText: bodyText,
      replyChainText,
      dbId,
    };

    activateTurn(turn as ActiveTelegramTurn);
    updateStatus(ctx);
    pi.sendUserMessage(turn.content);
  }

  /** Build reply chain context from the inline reply_to_message (from Telegram API) and DB history. */
  function buildReplyChain(message: TelegramMessage): string {
    if (!message.reply_to_message) return "";
    const botId = currentBotId();
    const chatId = message.chat.id;
    const parts: string[] = [];

    // Start with the inline reply_to_message from the Telegram API payload
    const inline = message.reply_to_message;
    parts.unshift(`[${inline.from?.username || inline.from?.first_name || "User"}]: ${inline.text || inline.caption || ""}`);

    // Walk deeper chain from DB if there's a further reply
    if (botId && inline.reply_to_message) {
      let currentMsgId: number | undefined = inline.reply_to_message.message_id;
      const MAX_CHAIN = 10;
      let depth = 0;
      while (currentMsgId && depth < MAX_CHAIN) {
        const row = Db.getDb().prepare(
          "SELECT message_id, from_username, text, reply_to_message_id FROM message_queue WHERE bot_id = ? AND chat_id = ? AND message_id = ?"
        ).get(botId, chatId, currentMsgId) as { message_id: number; from_username: string | null; text: string; reply_to_message_id: number | null } | undefined;
        if (!row) break;
        parts.unshift(`[${row.from_username || "User"}]: ${row.text}`);
        currentMsgId = row.reply_to_message_id ?? undefined;
        depth++;
      }
    }

    return parts.join("\n");
  }

  // ─── Command handlers ─────────────────────────────────────────────────

  async function handleStatusCommand(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
    const botToken = currentBotToken();
    if (!botToken) return;

    const pm = currentPollingManager();
    const pollState = pm?.getState() ?? {
      consecutiveErrors: 0,
      reconnectDelay: 1000,
      lastSuccessfulPoll: Date.now(),
      isHealthy: true,
      lastHealthCheck: Date.now(),
    };
    const botInfo = pm?.getBotInfo();
    const botId = currentBotId();
    const { listConfiguredBots } = await import("./config.js");
    const allBots = await listConfiguredBots();

    const pollingStatus = pm?.isActive() ? "✅ polling"
      : pm?.isHeldByOther() ? "✅ active (shared bot)"
      : "⏹ stopped";

    let pollerInfo = "";
    const primary = botId ? Db.getPrimarySession(botId) : null;
    if (primary) {
      pollerInfo = ` (primary: ${primary.session_name}, pid:${primary.pid})`;
    }

    const lines: string[] = [
      `<b>═══ Teleg Bridge Status ═══</b>`,
      ``,
      `🤖 <b>Bot:</b> ${botInfo?.username ? `@${botInfo.username}` : state.config.botUsername || "not configured"}${botId ? ` [id:${botId}]` : ""}`,
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
      const relayInfo = botId ? Db.getRelaySession(botId, s.sessionName) : null;
      const q = botId ? Db.getQueueStatsForSession(botId, s.sessionName) : { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
      const hasActiveTurn = q.processing > 0;
      const role = relayInfo?.role === "active" || relayInfo?.is_primary ? "poller" : "drain";
      const queueTag = q.pending > 0 || q.processing > 0 ? ` (${q.pending} queued, ${q.processing} active)` : "";
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
      lines.push(`    role: ${role}${queueTag} | caps: ${capList}`);
      lines.push(`    queue: ${q.pending} pending · ${q.processing} active · ${q.completed} done · ${q.failed} failed`);
      lines.push(`    pid: ${s.pid}`);
    }

    await sendReply(botToken, String(message.chat.id), message.message_id, lines.join("\n"));
  }

  async function handleQueueCommand(message: TelegramMessage, cleanText: string): Promise<void> {
    const botToken = currentBotToken();
    if (!botToken) return;

    const parts = cleanText.trim().split(/\s+/);
    const targetName = parts.length > 1 ? parts[1] : sessionName;

    const registry = await readSessionRegistry();
    const targetSession = registry.sessions.find(s => s.sessionName === targetName);

    if (!targetSession && targetName !== sessionName) {
      await sendReply(botToken, String(message.chat.id), message.message_id,
        `❌ Session "${targetName}" not found. Active: ${registry.sessions.map(s => s.sessionName).join(", ")}`);
      return;
    }

    const botId = currentBotId();
    if (!botId) {
      await sendReply(botToken, String(message.chat.id), message.message_id, `❌ No Telegram bot is configured for this session.`);
      return;
    }
    const d = Db.getDb();
    const normalizedTarget = Db.normalizeSessionName(targetName);
    const queueStats = Db.getQueueStatsForSession(botId, normalizedTarget);

    const pending = queueStats.pending;
    const processing = queueStats.processing;
    const completed = queueStats.completed;
    const failed = queueStats.failed;

    const recent = d.prepare(
      `SELECT id, text, status, created_at, completed_at, error FROM message_queue
       WHERE bot_id = ? AND (session_name = ? OR session_id = ? OR session_name = ?)
       ORDER BY id DESC LIMIT 10`
    ).all(botId, normalizedTarget, `__session__:${normalizedTarget}`, `__session__:${normalizedTarget}`) as Array<{ id: number; text: string; status: string; created_at: number; completed_at: number | null; error: string | null }>;

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

    await sendReply(botToken, String(message.chat.id), message.message_id, lines.join("\n"));
  }

  // ─── Turn completion ─────────────────────────────────────────────────

  function completeTurn(dbId?: number): void {
    const pm = currentPollingManager();
    if (!pm) return;
    pm.completeTurn(sessionId, dbId);
  }

  function claimNextTurn(): { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number } | null {
    const pm = currentPollingManager();
    if (!pm) return null;
    const result = pm.claimNextTurn(sessionId, sessionName);
    if (!result) return null;
    // Cast to match our internal PendingTelegramTurn which uses Array<{type: "text" | string}> for content
    return result as { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number };
  }

  function claimNextTurnForSession(): { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number } | null {
    const pm = currentPollingManager();
    if (!pm) return null;
    const result = pm.claimNextTurnForSession(sessionName);
    if (!result) return null;
    return result as { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number };
  }

  function claimNextTurnForSilentSession(): { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number } | null {
    const pm = currentPollingManager();
    if (!pm) return null;
    const botId = currentBotId();
    if (!botId) return null;
    // Policy 3: the common queue is bot-scoped and may only be claimed by a
    // linked (alive) session on this bot. An unlinked/unhealthy session must
    // ignore it entirely — it only drains messages explicitly tagged for itself.
    const aliveNames = Db.getAliveRelaySessions(botId).map(s => s.session_name);
    if (!aliveNames.includes(sessionName)) return null;
    const result = pm.claimNextTurnForSilentSession(sessionName, aliveNames);
    if (!result) return null;
    return result as { turn: PendingTelegramTurn; update: TelegramUpdate; dbId: number };
  }

  // ─── Typing indicator ──────────────────────────────────────────────

  function startTyping(chatId: number): void {
    if (state.typingInterval) return;
    const botToken = currentBotToken();
    if (!botToken) return;
    const send = async () => {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, action: "typing" }),
        });
      } catch {}
    };
    void send();
    state.typingInterval = setInterval(() => void send(), 4000);
  }

  function stopTyping(): void {
    if (!state.typingInterval) return;
    clearInterval(state.typingInterval);
    state.typingInterval = undefined;
  }

  // ─── Turn activation helper ──────────────────────────────────────

  function activateTurn(turn: ActiveTelegramTurn): void {
    state.activeTurn = turn;
    startTyping(turn.chatId);
  }

  function deactivateTurn(): void {
    stopTyping();
    state.activeTurn = undefined;
  }

  async function monitorDeadSessions(): Promise<{ removed: string[] }>{
    const botId = state.botContext?.botId;
    if (!botId) return { removed: [] };
    const registry = await readSessionRegistry();
    const removed: string[] = [];
    for (const s of registry.sessions) {
      if (s.sessionId === sessionId) continue;
      try { process.kill(s.pid, 0); } catch {
        // Dead session — clean up immediately
        removed.push(s.sessionName);
        cleanRelayFilesByPid(s.pid);
        Db.unregisterRelaySession(botId, s.sessionName);
        Db.resetProcessingForSession(botId, s.sessionName);
      }
    }
    if (removed.length > 0) {
      registry.sessions = registry.sessions.filter(s => !removed.includes(s.sessionName));
      await writeSessionRegistry(registry);
    }
    return { removed };
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
        incomingAttachments: [],
        content: [{ type: "text", text: `${TELEGRAM_PREFIX} ${next.text}` }],
        historyText: next.text,
      };
      activateTurn(turn as ActiveTelegramTurn);
      pi.sendUserMessage(turn.content, { deliverAs: "steer" });
      return true;
    }

    // 2. Our own session's pending messages
    const queued = claimNextTurnForSession();
    if (queued) {
      activateTurn(queued.turn as ActiveTelegramTurn);
      pi.sendUserMessage(queued.turn.content, { deliverAs: "steer" });
      return true;
    }
    // 3. Fallback: rescue messages whose owner session is silent/dead. Only a
    //    linked session on this bot may claim the common queue (policy 3).
    const fallback = claimNextTurnForSilentSession();
    if (fallback) {
      activateTurn(fallback.turn as ActiveTelegramTurn);
      pi.sendUserMessage(fallback.turn.content, { deliverAs: "steer" });
      return true;
    }

    // 4. Optional unassigned messages (cross-session help)
    if (CLAIM_OTHERS) {
      const queueMsg = claimNextTurn();
      if (queueMsg) {
        activateTurn(queueMsg.turn as ActiveTelegramTurn);
        pi.sendUserMessage(queueMsg.turn.content, { deliverAs: "steer" });
        return true;
      }
    }

    return false;
  }

  async function saveVerifiedBotConfig(token: string, botInfo: TelegramUser): Promise<void> {
    const projectCfg: ProjectConfig = {
      botId: botInfo.id,
      botUsername: botInfo.username,
      botToken: token.trim(),
      allowedUserIds: currentAllowedUserIds(),
      allowedChatIds: currentAllowedChatIds(),
      lastUpdateId: state.config.lastUpdateId ?? 0,
      dbPath: currentDbPath(),
    };

    const newConfig: TelegramConfig = {
      ...state.config,
      botToken: token.trim(),
      botUsername: botInfo.username,
      botId: botInfo.id,
      allowedUserIds: currentAllowedUserIds(),
    };

    await writeConfig(newConfig);
    await writeProjectConfig(cwd, projectCfg);
    state.config = newConfig;
    await refreshBotContext().catch(() => {
      state.config = newConfig;
      const pm = getPollingManager(botInfo.id);
      pm.setConfig(newConfig.botToken ?? "", newConfig.lastUpdateId ?? 0);
      pm.setBotInfo({ username: botInfo.username ?? null, displayName: botInfo.username ?? botInfo.first_name });
    });
  }

  async function startCurrentPolling(ctx: ExtensionContext, message = "Reconnecting to Telegram..."): Promise<void> {
    const pm = currentPollingManager();
    const token = currentBotToken();
    if (!pm || !token) {
      ctx.ui.notify("No Telegram bot token configured. Run /teleg-setup first.", "error");
      updateStatus(ctx);
      return;
    }
    pm.setConfig(token, state.config.lastUpdateId ?? state.botContext?.lastUpdateId ?? 0);
    const started = await pm.start(sessionName, currentDbPath());
    const botId = currentBotId();
    if (botId) {
      Db.updateRelayRole(botId, sessionName, started ? "active" : "drain");
      if (started) Db.setPrimary(botId, sessionName);
    }
    updateStatus(ctx);
    ctx.ui.notify(message, "info");
  }

  // ─── Bot selection / activation ──────────────────────────────────────

  /**
   * Register a brand-new bot from a token entered by the user.
   * Returns true when a bot is now active, false if the user cancelled or the
   * token was invalid.
   */
  async function registerNewBot(ctx: ExtensionContext): Promise<boolean> {
    const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
    if (!token) return false;
    const botInfo = await verifyToken(token);
    if (!botInfo) {
      ctx.ui.notify("Invalid Telegram bot token", "error");
      return false;
    }
    await saveVerifiedBotConfig(token, botInfo);
    ctx.ui.notify(`Teleg-bridge connected: @${botInfo.username}`, "info");
    ctx.ui.notify("Send /start to your bot in Telegram to pair.", "info");
    return true;
  }

  /**
   * Ask the user to pick from the already-registered bots.
   * - No bots → null (caller falls back to token setup).
   * - One bot, or headless session → that bot is used directly.
   * - Several bots → a selector; the user may also opt to register a new bot.
   */
  async function promptForBot(
    ctx: ExtensionContext
  ): Promise<{ botId: number; botUsername: string } | "new" | null> {
    const bots = await listConfiguredBots();
    if (bots.length === 0) return null;
    if (bots.length === 1 || !ctx.hasUI) {
      // Single bot → use directly. Headless → can't show a selector, so prefer
      // the configured default bot (falling back to the first registered one).
      if (!ctx.hasUI) {
        const defaultId = await getDefaultBotId();
        const def = bots.find((b) => b.botId === defaultId);
        if (def) return def;
      }
      return bots[0];
    }

    const options = bots.map((b) => `@${b.botUsername} (id: ${b.botId})`);
    options.push("➕ Register a new bot");
    const choice = await ctx.ui.select("Select a Telegram bot", options);
    if (!choice) return null; // cancelled
    if (choice === "➕ Register a new bot") return "new";
    const idx = options.indexOf(choice);
    return bots[idx] ?? null;
  }

  /**
   * Make the chosen bot the active bot for this session: stop the previous
   * bot's polling, switch the context, persist the selection (project pin +
   * global default) and reconfigure the polling manager.
   */
  async function switchActiveBot(botId: number, ctx: ExtensionContext): Promise<boolean> {
    const newContext = await resolveFromBotId(botId, cwd);
    if (!newContext) {
      ctx.ui.notify(`Bot ${botId} is not registered.`, "error");
      return false;
    }
    const oldBotId = currentBotId();
    if (oldBotId && oldBotId !== botId) {
      const oldPm = getPollingManager(oldBotId);
      if (oldPm.isActive()) await oldPm.stop();
    }
    state.botContext = newContext;
    normalizeConfigFromBotContext(newContext);
    await persistProjectConfig({
      botId: newContext.botId,
      botUsername: newContext.botUsername,
      botToken: newContext.botToken,
      allowedUserIds: newContext.allowedUserIds,
      allowedChatIds: newContext.allowedChatIds,
      lastUpdateId: newContext.lastUpdateId,
      dbPath: newContext.dbPath,
    });
    await setDefaultBotId(newContext.botId);
    const pm = getPollingManager(newContext.botId);
    pm.setConfig(newContext.botToken, newContext.lastUpdateId);
    pm.setBotInfo({ username: newContext.botUsername, displayName: newContext.botUsername });
    updateStatus(ctx);
    ctx.ui.notify(`Active bot: @${newContext.botUsername}`, "info");
    return true;
  }

  /**
   * Ensure a bot is active for this session, selecting from existing bots or
   * falling back to token setup. Returns true when a bot is now active.
   */
  async function ensureBotSelected(ctx: ExtensionContext): Promise<boolean> {
    const choice = await promptForBot(ctx);
    if (choice === null || choice === "new") return registerNewBot(ctx);
    return switchActiveBot(choice.botId, ctx);
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

        await saveVerifiedBotConfig(token, botInfo);
        ctx.ui.notify(`Teleg-bridge connected: @${botInfo.username}`, "info");
        ctx.ui.notify("Send /start to your bot in Telegram to pair.", "info");
        await startCurrentPolling(ctx, "Polling started.");
      } finally {
        state.setupInProgress = false;
      }
    },
  });

  pi.registerCommand("teleg-status", {
    description: "Show teleg-bridge status",
    handler: async (_args, ctx) => {
      const pm = currentPollingManager();
      const health = pm?.getState();
      const botInfo = pm?.getBotInfo();
      const registry = await readSessionRegistry();
      ctx.ui.notify(
        `bot: ${botInfo?.username || state.config.botUsername || "?"} | polling: ${pm?.isActive() ? "running" : "stopped"} | sessions: ${registry.sessions.length} | health: ${health?.isHealthy !== false ? "OK" : "DEGRADED"}`,
        "info"
      );
    },
  });

  pi.registerCommand("teleg-connect", {
    description: "Start teleg-bridge polling",
    handler: async (_args, ctx) => {
      if (!currentBotToken()) {
        if (!(await ensureBotSelected(ctx))) return;
      }
      await startCurrentPolling(ctx, "Polling started.");
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
      const pm = currentPollingManager();
      if (pm) await pm.stop();
      updateStatus(ctx);
    },
  });

  pi.registerCommand("teleg-reconnect", {
    description: "Force reconnection to Telegram",
    handler: async (_args, ctx) => {
      if (!currentBotToken()) {
        if (!(await ensureBotSelected(ctx))) return;
      }
      const pm = currentPollingManager();
      if (!pm || !currentBotToken()) {
        ctx.ui.notify("No Telegram bot token configured. Run /teleg-setup first.", "error");
        updateStatus(ctx);
        return;
      }
      await pm.stop();
      await startCurrentPolling(ctx, "Reconnecting to Telegram...");
    },
  });

  pi.registerCommand("teleg-switch-bot", {
    description: "Switch the active Telegram bot for this session",
    handler: async (_args, ctx) => {
      const choice = await promptForBot(ctx);
      if (choice === null) {
        ctx.ui.notify("No bots registered yet. Use /teleg-setup or /teleg-connect to add one.", "info");
        return;
      }
      if (choice === "new") {
        if (await registerNewBot(ctx)) await startCurrentPolling(ctx, "Polling started.");
        return;
      }
      if (await switchActiveBot(choice.botId, ctx)) {
        await startCurrentPolling(ctx, "Switched bot — polling started.");
      }
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
        : currentAllowedUserIds()[0];
      const botToken = currentBotToken();
      if (!targetChatId || !botToken) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const result = await sendReply(botToken, String(targetChatId), 0, params.text);
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
        : currentAllowedUserIds()[0];
      const botToken = currentBotToken();
      if (!targetChatId || !botToken) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const stats = await stat(params.file_path);
      if (!stats.isFile()) throw new Error(`Not a file: ${params.file_path}`);
      const fileName = params.file_path.split("/").pop() || "photo.jpg";
      const success = await sendFile(botToken, String(targetChatId), 0, params.file_path, fileName, true, params.caption);
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
        : currentAllowedUserIds()[0];
      const botToken = currentBotToken();
      if (!targetChatId || !botToken) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const stats = await stat(params.file_path);
      if (!stats.isFile()) throw new Error(`Not a file: ${params.file_path}`);
      const fileName = params.file_path.split("/").pop() || "video.mp4";
      const success = await sendFile(botToken, String(targetChatId), 0, params.file_path, fileName, false, params.caption);
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
      const pm = currentPollingManager();
      const botInfo = pm?.getBotInfo() ?? { botId: currentBotId() ?? 0, username: state.config.botUsername ?? null, displayName: state.config.botUsername ?? "" };
      return { content: [{ type: "text", text: JSON.stringify(botInfo) }], details: {} };
    },
  });

  pi.registerTool({
    name: "get_queue_count",
    label: "Get Queue Count",
    description: "Get the number of pending and processing messages in the queue",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const pm = currentPollingManager();
      const depth = pm?.getQueueDepth() ?? 0;
      return { content: [{ type: "text", text: `Queue depth: ${depth}` }], details: { count: depth } };
    },
  });

  pi.registerTool({
    name: "get_queue_stats",
    label: "Get Queue Stats",
    description: "Get full queue statistics for messages and downloads",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const botId = currentBotId();
      if (!botId) {
        return { content: [{ type: "text", text: "No Telegram bot is configured for this session." }], details: { messages: { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 }, downloads: { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 } } };
      }
      const stats = Db.getQueueStats(botId);
      const dlStats = Db.getDownloadStats(botId);
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
      const botId = currentBotId();
      let rows;
      if (params.status) {
        rows = Db.getDb().prepare(`SELECT * FROM message_queue WHERE bot_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`).all(botId, params.status, limit);
      } else {
        rows = Db.getRecentMessages(limit, botId);
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
      const botId = currentBotId();
      if (!botId) {
        return { content: [{ type: "text", text: `No message found with id ${params.id}` }], details: { row: null } };
      }
      const row = Db.getDb().prepare(`SELECT * FROM message_queue WHERE id = ? AND bot_id = ?`).get(params.id, botId) as Record<string, unknown> | undefined;
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
      const botId = currentBotId();
      const now = Date.now();
      let query = `UPDATE message_queue SET status = ?`;
      const args: (string | number | undefined)[] = [params.status];
      if (params.status === "completed") {
        query += `, completed_at = ?`;
        args.push(now);
      } else if (params.status === "failed" && params.error) {
        query += `, error = ?`;
        args.push(params.error);
      } else if (params.status === "pending") {
        query += `, started_at = NULL, session_id = 'unassigned', session_name = 'unknown'`;
      }
      query += ` WHERE id = ? AND bot_id = ?`;
      args.push(params.id, botId);
      const result = Db.getDb().prepare(query).run(...args as (string | number)[]);
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

  // ─── PUB-SUB Tool ──────────────────────────────────────────────────

  pi.registerTool({
    name: "teleg-publish",
    label: "Publish to Session Channel",
    description: "Publish a message to a PUB-SUB channel for another session to pick up. Use to delegate tasks between pi sessions without Telegram.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name (e.g., a capability like 'download', 'scrape', 'analyze')" }),
      payload: Type.String({ description: "Message payload / task description" }),
      target_session: Type.Optional(Type.String({ description: "Target session name (omit for broadcast to any capable session)" })),
    }),
    async execute(_toolCallId, params) {
      const botId = state.botContext?.botId;
      if (!botId) throw new Error("No bot ID available");
      const id = Db.publish(botId, params.channel, sessionName, params.payload, params.target_session);
      return { content: [{ type: "text", text: `Published to #${params.channel} (id:${id}${params.target_session ? ` → @${params.target_session}` : " (broadcast)"})` }], details: { id, channel: params.channel } };
    },
  });

  // ─── Kill-Switch Tools ──────────────────────────────────────────────

  pi.registerTool({
    name: "teleg-disconnect",
    label: "Disconnect Session",
    description: "Disconnect THIS pi session from the Telegram bridge. Stops polling and unregisters this session. Other sessions and queued DB data are unaffected.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      if (state.activeTurn) {
        completeTurn(state.activeTurn.dbId);
        deactivateTurn();
      }
      if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = undefined; }
      if (state.livenessTimer) { clearInterval(state.livenessTimer); state.livenessTimer = undefined; }
      const pm = currentPollingManager();
      if (pm && pm.isActive()) await pm.stop();
      stopRelayServer();
      stopTyping();
      await unregisterSessionCapabilities(sessionId);
      await unregisterSession();
      const botId = currentBotId();
      if (botId) Db.unregisterRelaySession(botId, sessionName);
      return { content: [{ type: "text", text: `Disconnected session: ${sessionName}` }], details: { session_name: sessionName } };
    },
  });

  pi.registerTool({
    name: "teleg-disconnect-all",
    label: "Disconnect All Sessions",
    description: "Disconnect ALL pi sessions connected to the Telegram bridge. Terminates session PIDs but does NOT clean queue DB or remove registry records.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      if (state.activeTurn) {
        completeTurn(state.activeTurn.dbId);
        deactivateTurn();
      }
      if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = undefined; }
      if (state.livenessTimer) { clearInterval(state.livenessTimer); state.livenessTimer = undefined; }
      const pm = currentPollingManager();
      if (pm && pm.isActive()) await pm.stop();
      const botId = currentBotId();
      const registry = await readSessionRegistry();
      const killed: string[] = [];
      // Scope to the current bot to avoid a cross-bot blast radius.
      for (const s of registry.sessions) {
        if (botId && s.botId !== botId) continue;
        killed.push(s.sessionName);
        if (s.sessionId === sessionId) continue;
        try { process.kill(s.pid, 9); } catch { /* already dead */ }
        cleanRelayFilesByPid(s.pid);
      }
      stopRelayServer();
      stopTyping();
      await unregisterSessionCapabilities(sessionId);
      await unregisterSession();
      return { content: [{ type: "text", text: `Disconnected ${killed.length} sessions without DB cleanup: ${killed.join(", ")}` }], details: { killed, db_cleaned: false } };
    },
  });

  pi.registerTool({
    name: "teleg-clean-db",
    label: "Clean Teleg DB",
    description: "Clean queue DB state separately from disconnect. Resets processing messages to pending and purges old completed/failed entries.",
    parameters: Type.Object({
      keep_count: Type.Optional(Type.Number({ description: "How many completed/failed messages to keep (default 500)" })),
    }),
    async execute(_toolCallId, params) {
      const botId = currentBotId();
      const reset = botId ? Db.resetAllProcessing(botId) : 0;
      const purged = botId ? Db.purgeOldMessages(params.keep_count ?? 500, botId) : 0;
      return { content: [{ type: "text", text: `DB cleaned (bot ${botId ?? "none"}): ${reset} processing reset, ${purged} old messages purged.` }], details: { reset, purged } };
    },
  });

  pi.registerTool({
    name: "teleg-remove-sessions",
    label: "Remove Dead Sessions",
    description: "Remove dead session registry records and relay DB entries separately from disconnect.",
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ description: "Remove all sessions except this one, even if PIDs are alive" })),
    }),
    async execute(_toolCallId, params) {
      const botId = currentBotId();
      const registry = await readSessionRegistry();
      const removed: string[] = [];
      registry.sessions = registry.sessions.filter(s => {
        if (s.sessionId === sessionId) return true;
        let alive = true;
        try { process.kill(s.pid, 0); } catch { alive = false; }
        if (!params.all && alive) return true;
        removed.push(s.sessionName);
        cleanRelayFilesByPid(s.pid);
        if (botId) Db.unregisterRelaySession(botId, s.sessionName);
        return false;
      });
      await writeSessionRegistry(registry);
      return { content: [{ type: "text", text: `Removed ${removed.length} session(s): ${removed.join(", ") || "none"}` }], details: { removed } };
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
      const raw = await reconcileSessions(botId);
      const reports = Array.isArray(raw) ? raw : [raw];
      const lines: string[] = [`📊 Reconcile Report${botId ? ` (bot ${botId})` : ""}`, ``];
      for (const report of reports) {
        if (reports.length > 1) lines.push(`Bot ${report.botId}:`);
        lines.push(
          `Checked: ${report.checkedSessions} sessions`,
          `Evicted: ${report.evictedSessions.length > 0 ? report.evictedSessions.join(", ") : "none"}`,
          `New primary: ${report.newPrimary ?? "unchanged"}`,
          ...(report.errors.length ? [`Errors: ${report.errors.join("; ")}`] : []),
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: reports.length === 1 ? reports[0] : reports };
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
    try {
      state.botContext = await selectBotForSession(cwd);
      if (!state.botContext && cwd !== process.cwd()) {
        state.botContext = await selectBotForSession(process.cwd());
      }

      // No preconfigured bot — try interactive setup if UI is available.

      // No preconfigured bot — try interactive setup if UI is available.
      // Important: only prompt when there is truly no project or global bot pin.
      if (!state.botContext && ctx.hasUI && !state.setupInProgress) {
        state.setupInProgress = true;
        try {
          const token = await ctx.ui.input("No Telegram bot configured. Enter bot token to set up", "123456:ABCDEF...");
          if (token) {
            const botInfo = await verifyToken(token);
            if (botInfo) {
              await saveVerifiedBotConfig(token, botInfo);
              state.botContext = await resolveBotContext(cwd);
              ctx.ui.notify(`Teleg-bridge connected: @${botInfo.username}`, "info");
              ctx.ui.notify("Send /start to your bot in Telegram to pair.", "info");
            } else {
              ctx.ui.notify("Invalid Telegram bot token", "error");
            }
          }
        } finally {
          state.setupInProgress = false;
        }
      }

      if (!state.botContext) {
        console.error(`[teleg:${sessionName}] No Telegram bot selected or configured.`);
        return;
      }
      // Enforce: one instance, one bot. If another polling manager is active for a
      // different botId in this process, refuse to proceed — mixing bots in one
      // process causes queue/polling cross-contamination.
      const existingManagers = getAllPollingManagers();
      const conflictingBot = existingManagers.find(m => m.isActive() && m.botId !== state.botContext!.botId);
      if (conflictingBot) {
        console.error(
          `[teleg:${sessionName}] Bot conflict: bot ${conflictingBot.botId} is already polling in this process. ` +
          `Cannot also serve bot ${state.botContext!.botId}. Use separate processes per bot.`
        );
        ctx.ui.notify(
          `Cannot start: bot ${state.botContext!.botId} conflicts with active bot ${conflictingBot.botId}. ` +
          `Each process must serve only one bot.`,
          "error"
        );
        return;
      }

      state.config = await readConfig();
      normalizeConfigFromBotContext(state.botContext);

      const splitDbWarning = await detectSplitDb(state.botContext.botId, state.botContext.dbPath);
      if (splitDbWarning) console.warn(`[teleg:${sessionName}] ${splitDbWarning}`);
    } catch (err) {
      console.error(`[teleg:${sessionName}] Failed to resolve bot context: ${err}`);
      console.error("[teleg] Set TELEG_BOT_TOKEN, TELEG_BOT_ID, or configure .pi/teleg.json");
    }

    state.config = await readConfig();
    if (state.botContext) normalizeConfigFromBotContext(state.botContext);

    const botId = currentBotId();
    const botToken = currentBotToken();

    // Run scoped startup recovery for this bot
    if (botId) {
      const recovery = Db.runStartupRecovery(botId);
      if (recovery.recoveredMessages > 0 || recovery.cleanedSessions > 0 || (recovery.mergedFromLocal ?? 0) > 0) {
        console.log(`[teleg:${sessionName}] Startup recovery (bot ${botId}): ${recovery.recoveredMessages} messages, ${recovery.cleanedSessions} sessions recovered`);
      }
      Db.normalizeLegacyBotIds(botId);
    }
    if (botId && botToken) {
      const pm = getPollingManager(botId);
      pm.setConfig(botToken, state.botContext?.lastUpdateId ?? state.config.lastUpdateId ?? 0);
      pm.setBotInfo({ username: state.config.botUsername ?? null, displayName: state.config.botUsername ?? "" });
    }

    await registerSession();

    // Phase 5: Reconcile on startup
    if (botId) {
      const report = await reconcileSessions(botId);


    }

    // Announce presence ONCE per session
    const registry1 = await readSessionRegistry();
    const sessInfo = registry1.sessions.find(s => s.sessionId === sessionId);
    if (sessInfo && !sessInfo.announcedPresence) {
      const chatId = currentAllowedUserIds()[0];
      const announceToken = currentBotToken();
      if (chatId && announceToken && botId) {
        try {
          await fetch(`https://api.telegram.org/bot${announceToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `✅ <b>${sessionName}</b> connected`, parse_mode: "HTML" }),
          });
        } catch { /* Network unavailable — skip */ }
      }
      sessInfo.announcedPresence = true;
      await writeSessionRegistry(registry1);
    }

    // Register session capabilities
    await cleanStaleCapabilities();
    const { capabilities: detectedCaps, description: detectedDesc } = detectProjectCapabilities(cwd);
    await registerSessionCapabilities(sessionId, sessionName, process.pid, cwd, botId).catch(
      (err: unknown) => console.error(`[teleg:${sessionName}] Failed to register capabilities:`, err)
    );
    // Also store capabilities in SQLite relay_sessions for cross-session routing
    if (botId && detectedCaps.length > 0) {
      Db.updateRelayCapabilities(botId, sessionName, JSON.stringify(detectedCaps), detectedDesc || "");
    }

    // Start relay server
    const relayInfo = await startRelayServer(sessionName, 9798, botId);

    // Register in SQLite relay_sessions table with actual port and secret
    if (botId) {
      Db.registerRelaySession({ bot_id: botId, session_name: sessionName, session_id: sessionId, pid: process.pid, port: relayInfo.port, secret: relayInfo.secret });
    }

    setCommandHandler(async (text, meta) => {
      pendingForwards.push({
        chatId: meta.chatId,
        messageId: meta.messageId,
        text,
        sourceSession: meta.sourceSession || "unknown",
      });

      if (state.activeTurn) {
        return `[${sessionName}] Queued...`;
      }

      const started = await drainOne();
      return started ? `[${sessionName}] Processing...` : `[${sessionName}] Queued...`;
    });

    setCompleteHandler((id, sourceSession) => {
      if (!sourceSession || sourceSession === "unknown") return;
      const handlerBotId = currentBotId();
      try {
        const db = Db.getDb();
        const row = db.prepare(
          "SELECT id FROM message_queue WHERE bot_id = ? AND (session_name = ? OR session_id = ? OR session_id = ?) AND id = ?"
        ).get(handlerBotId, sourceSession, sourceSession, `__session__:${sourceSession}`, id) as { id: number } | undefined;
        if (row) db.prepare(`UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ? AND bot_id = ?`).run(Date.now(), row.id, handlerBotId);
      } catch (err) {
        console.error("[teleg] complete handler error:", err);
      }
    });

    // Handle shutdown signal from other sessions (PUB-SUB /teleg-dc-all)
    setShutdownHandler(async () => {
      console.log(`[teleg:${sessionName}] Received shutdown signal`);
      if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = undefined; }
      if (state.livenessTimer) { clearInterval(state.livenessTimer); state.livenessTimer = undefined; }
      stopTyping();
      deactivateTurn();
      const pm = botId ? getPollingManager(botId) : null;
      if (pm?.isActive()) await pm.stop();
      stopRelayServer();
      void unregisterSessionCapabilities(sessionId);
      void unregisterSession();
    });

    if (botToken && botId) {
      const pm = getPollingManager(botId);
      const pollingStarted = await pm.start(sessionName, currentDbPath());
      Db.updateRelayRole(botId, sessionName, pollingStarted ? "active" : "drain");
      if (pollingStarted) Db.setPrimary(botId, sessionName);
    }

    // Wire up polling message handler
    const pm = botId ? getPollingManager(botId) : null;
    pm?.onMessage(async (update, dbId) => {
      const message = getUpdateMessage(update);
      if (!message) return;
      if (!isAuthorizedTelegramMessage(message)) {
        Db.completeMessage(dbId, "ignored: unauthorized telegram user/chat");
        return;
      }
      const activeSessionId = state.activeTurn?.sessionId;
      if (activeSessionId && activeSessionId !== sessionId && activeSessionId !== "unassigned") return;
      await handleAuthorizedTelegramMessage(message, ctx, dbId);
    });

    // Wire up polling reaction handler
    pm?.onReaction((update) => {
      if (!update.message_reaction) return;
      const reaction = update.message_reaction;
      const userId = reaction.user?.id;
      const emojis = reaction.new_reaction.map(r => r.emoji).join(", ");
      if (!emojis) return;
      // Surface reaction event as a log message — it does not create a turn but is visible
      console.log(`[teleg:${sessionName}] Reaction on msg ${reaction.message_id} in chat ${reaction.chat.id}: ${emojis} by ${reaction.user?.username || userId || "unknown"}`);
    });

    // Wire up polling poll-answer handler. A poll_answer has no chat/message id,
    // so link it back via the stored poll_id and surface the vote to this session
    // as a steer turn when idle (ephemeral, like reactions — not durable in the queue).
    pm?.onPollAnswer((update) => {
      const pa = update.poll_answer;
      if (!pa) return;
      const paBotId = currentBotId();
      if (!paBotId) return;
      try {
        const pollRow = Db.getDb().prepare(
          "SELECT chat_id, message_id, text FROM message_queue WHERE bot_id = ? AND poll_id = ? ORDER BY id DESC LIMIT 1"
        ).get(paBotId, pa.poll_id) as { chat_id: number; message_id: number; text: string } | undefined;
        const voter = pa.user?.username || pa.user?.first_name || pa.user?.id || "someone";
        if (!pollRow) {
          console.log(`[teleg:${sessionName}] Poll answer for unknown poll ${pa.poll_id} by ${voter}: options ${pa.option_ids.join(",")}`);
          return;
        }
        const optionLabels = parsePollOptions(pollRow.text);
        const picked = pa.option_ids.map((i) => optionLabels[i] ?? `option ${i + 1}`).join(", ");
        const answerText = `📊 Poll vote from ${voter} on:\n${pollRow.text}\nVoted: ${picked}`;
        console.log(`[teleg:${sessionName}] poll_answer ${pa.poll_id} by ${voter}: ${picked}`);
        if (!state.activeTurn && ctx.isIdle()) {
          const turn: PendingTelegramTurn = {
            sessionId,
            sessionName,
            chatId: pollRow.chat_id,
            replyToMessageId: pollRow.message_id,
            queuedAttachments: [],
            incomingAttachments: [],
            content: [{ type: "text", text: `${TELEGRAM_PREFIX} ${answerText}` }],
            historyText: answerText,
          };
          activateTurn(turn as ActiveTelegramTurn);
          pi.sendUserMessage(turn.content, { deliverAs: "steer" });
        }
      } catch (err) {
        console.error(`[teleg:${sessionName}] poll_answer handling failed:`, err);
      }
    });

    // Periodic tasks: heartbeat, reconcile, polling restart
    setInterval(async () => {
      await heartbeatSession();
      if (botId) {
        await reconcileSessions(botId).catch((err) => console.error(`[teleg:${sessionName}] Reconcile failed:`, err));
      }
      if (!botId) return;
      const pm2 = getPollingManager(botId);
      if (!pm2.isActive() && currentBotToken()) {
        if (!pm2.isHeldByOther()) {

          const restarted = await pm2.start(sessionName, currentDbPath()).catch((err) => {
            console.error(`[teleg:${sessionName}] Auto-restart failed:`, err);
            return false;
          });
          Db.updateRelayRole(botId, sessionName, restarted ? "active" : "drain");
          if (restarted) Db.setPrimary(botId, sessionName);
        }
      }
    }, 30000);

    // Phase 6: Active idle drain timer
    // Each session independently polls for:
    //   1. Messages explicitly tagged for this session (session_name match)
    //   2. Unassigned messages that match this session's capabilities
    //   3. Any remaining unassigned messages (cross-session help)
    state.drainTimer = setInterval(async () => {
      if (state.activeTurn) return;
      if (!botId) return;
      try {
        const defaultBotId = await getDefaultBotId();
        const isDefaultBot = defaultBotId === botId;

        if (detectedCaps.length > 0) {
          const pubsubMsgs = Db.subscribe(botId, sessionName, detectedCaps);
          for (const msg of pubsubMsgs) {
            const turn: PendingTelegramTurn = {
              sessionId,
              sessionName,
              chatId: 0,
              replyToMessageId: 0,
              queuedAttachments: [],
              incomingAttachments: [],
              content: [{ type: "text", text: `[telegram] [pubsub:${msg.channel}] ${msg.payload}` }],
              historyText: msg.payload,
            };
            activateTurn(turn as ActiveTelegramTurn);
            pi.sendUserMessage(turn.content, { deliverAs: "steer" });
            return;
          }
        }

        const queued = isDefaultBot ? claimNextTurn() : claimNextTurnForSession();
        if (queued) {
          activateTurn(queued.turn as ActiveTelegramTurn);
          pi.sendUserMessage(queued.turn.content, { deliverAs: "steer" });
          return;
        }

        const capReg = await readCapabilitiesRegistry();
        const myCaps = capReg.entries.find(e => e.sessionId === sessionId);
        if (myCaps && myCaps.capabilities.length > 0) {
          const unassignedRows = Db.getDb().prepare(
            "SELECT * FROM message_queue WHERE bot_id = ? AND status = 'pending' AND (session_name = 'unknown' OR session_name IS NULL) ORDER BY id ASC LIMIT 25"
          ).all(botId) as unknown as Db.QueuedMessage[];
          for (const unassigned of unassignedRows) {
            const text = unassigned.text || "";
            const match = matchMessageToCapability(text, [myCaps]);
            if (match) {
              const claimed = Db.getDb().prepare(
                "UPDATE message_queue SET status = 'processing', session_id = ?, session_name = ?, started_at = ? WHERE id = ? AND status = 'pending'"
              ).run(sessionId, sessionName, Date.now(), unassigned.id).changes;
              if (claimed === 0) continue;
              const turn: PendingTelegramTurn = {
                sessionId,
                sessionName,
                chatId: unassigned.chat_id,
                replyToMessageId: unassigned.message_id,
                queuedAttachments: [],
                incomingAttachments: [],
                content: [{ type: "text", text: `[telegram] ${text}` }],
                historyText: text,
                dbId: unassigned.id,
              };
              activateTurn(turn as ActiveTelegramTurn);
              pi.sendUserMessage(turn.content, { deliverAs: "steer" });
              return;
            }
          }
        }

        const fallback = claimNextTurnForSilentSession();
        if (fallback) {
          activateTurn(fallback.turn as ActiveTelegramTurn);
          pi.sendUserMessage(fallback.turn.content, { deliverAs: "steer" });
          return;
        }

        if (CLAIM_OTHERS) {
          const queueMsg = claimNextTurn();
          if (queueMsg) {
            activateTurn(queueMsg.turn as ActiveTelegramTurn);
            pi.sendUserMessage(queueMsg.turn.content, { deliverAs: "steer" });
          }
        }
      } catch (err) {
        console.error(`[teleg:${sessionName}] Drain error:`, err);
      }
    }, DRAIN_INTERVAL_MS);

    if (botId && !state.activeTurn) {
      try {
        const defaultBotId = await getDefaultBotId();
        const isDefaultBot = defaultBotId === botId;
        const queued = isDefaultBot ? claimNextTurn() : claimNextTurnForSession() || claimNextTurnForSilentSession();
        if (queued) {
          activateTurn(queued.turn as ActiveTelegramTurn);
          pi.sendUserMessage(queued.turn.content, { deliverAs: "steer" });
        }
      } catch (err) {
        console.error(`[teleg:${sessionName}] Startup drain error:`, err);
      }
    }
    state.livenessTimer = setInterval(async () => {
      const { removed } = await monitorDeadSessions();
      if (removed.length > 0) {
        console.log(`[teleg:${sessionName}] Removed dead sessions: ${removed.join(", ")}`);
        if (!state.activeTurn && botId) {
          const queued = claimNextTurnForSilentSession();
          if (queued) {
            activateTurn(queued.turn as ActiveTelegramTurn);
            pi.sendUserMessage(queued.turn.content, { deliverAs: "steer" });
          }
        }
        updateStatus(ctx);
      }
    }, 5000);

    updateStatus(ctx);
  });

  // ─── Session Events ───────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (state.drainTimer) { clearInterval(state.drainTimer); state.drainTimer = undefined; }
    if (state.livenessTimer) { clearInterval(state.livenessTimer); state.livenessTimer = undefined; }
    deactivateTurn();
    pendingForwards.length = 0;
    completeTurn();
    stopRelayServer();

    const registry2 = await readSessionRegistry();
    const dying = registry2.sessions.find(s => s.sessionId === sessionId);
    if (dying && dying.announcedPresence) {
      const chatId = currentAllowedUserIds()[0];
      const botToken = currentBotToken();
      if (chatId && botToken) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `⚠️ <b>${sessionName}</b> disconnected`, parse_mode: "HTML" }),
          });
        } catch { /* Network unavailable — skip */ }
      }
    }

    await unregisterSessionCapabilities(sessionId);
    await unregisterSession();

    const botId = currentBotId();
    if (botId) {
      Db.unregisterRelaySession(botId, sessionName);
      electPrimary(botId);
    }

    const registry = await readSessionRegistry();
    if (registry.sessions.length === 0) {
      const pm = currentPollingManager();
      if (pm) await pm.stop();
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
      const queued = claimNextTurnForSession() || claimNextTurnForSilentSession() || (CLAIM_OTHERS ? claimNextTurn() : null);
      if (queued) activateTurn(queued.turn as ActiveTelegramTurn);
    }
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const turn = state.activeTurn;
    deactivateTurn();
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
      deactivateTurn();
      updateStatus(ctx);
    }
  });
}