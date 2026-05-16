/**
 * pi-teleg - Multi-Session Telegram Bridge Extension for Pi
 * 
 * Architecture:
 * - Single shared polling manager (singleton) handles Telegram long polling
 * - Multiple Pi sessions can connect and receive Telegram messages
 * - Messages are dispatched to the session that has an active turn
 * - If no session has an active turn, the message queues until a session starts a turn
 * - Each session has its own turn state but shares the polling infrastructure
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  startRelayServer,
  stopRelayServer,
  setCommandHandler,
  forwardToSession,
  getRelayStatus,
} from "./relay.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ARCHIVE_ROOT = join(homedir(), "pi-teleg-archive");
const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(CONFIG_DIR, "teleg-bridge.json");
const SESSION_REGISTRY_FILE = join(CONFIG_DIR, "teleg-sessions.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "teleg-bridge");
const POLLING_LOCK_FILE = join(TEMP_DIR, "polling.lock");
const POLLING_LOCK_REFRESH_MS = 15000;
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const POLL_TIMEOUT_SECONDS = 60;
const HEALTH_CHECK_INTERVAL_MS = 30000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const MAX_CONSECUTIVE_ERRORS = 5;
const BASE_BACKOFF_MULTIPLIER = 2;

// ============================================================================
// Types
// ============================================================================

interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserIds?: number[];
  lastUpdateId?: number;
  archiveRoot?: string;
}

interface SessionInfo {
  sessionId: string;
  sessionName: string;
  connectedAt: number;
  lastActivity: number;
  isActive: boolean;
  announcedPresence?: boolean; // true after sending the single "connected" message for this session
}

interface SessionRegistry {
  sessions: SessionInfo[];
  primarySessionId?: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

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
  media_group_id?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
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
  twitterUrls?: string[];
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface PollState {
  consecutiveErrors: number;
  reconnectDelay: number;
  lastSuccessfulPoll: number;
  isHealthy: boolean;
  lastHealthCheck: number;
}

// ============================================================================
// System Prompt
// ============================================================================

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the teleg_attach tool with the local file path so the extension can send it with my next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use teleg_attach.

## Twitter/X Download System
- On [telegram] messages with X.com/twitter.com URLs, automatically download the tweet media
- CRITICAL: Download ONLY the main tweet media, NOT replies, threads, or quoted tweets
- CRITICAL: Never send screenshot.png as fallback when no media found
- CRITICAL: If tweet only has screenshot.png, redownload to get actual media
- Archive downloads to {archiveRoot}/tweets/{tweet_id}/
- Send media to Telegram via teleg_attach and send_message tools

## Session Identity
- This is session "{sessionName}". When you reply to Telegram, include your session name so the user knows which instance responded.
- Messages addressed to a specific session (e.g., "@sessionName ...") are routed accordingly.`;

// ============================================================================
// Utility Functions
// ============================================================================

async function readConfig(): Promise<TelegramConfig> {
  try {
    const content = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(content) as TelegramConfig & { allowedUserId?: number };
    // Migrate old allowedUserId (singular) to allowedUserIds (plural array)
    if (parsed.allowedUserId && (!parsed.allowedUserIds || parsed.allowedUserIds.length === 0)) {
      parsed.allowedUserIds = [parsed.allowedUserId];
    }
    delete (parsed as Record<string, unknown>).allowedUserId;
    return parsed;
  } catch {
    return {};
  }
}

async function writeConfig(cfg: TelegramConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, "\t") + "\n", "utf8");
}

async function readSessionRegistry(): Promise<SessionRegistry> {
  try {
    const content = await readFile(SESSION_REGISTRY_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return { sessions: [] };
  }
}

async function writeSessionRegistry(reg: SessionRegistry): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SESSION_REGISTRY_FILE, JSON.stringify(reg, null, "\t") + "\n", "utf8");
}

function getArchiveRoot(config: TelegramConfig): string {
  return config.archiveRoot || DEFAULT_ARCHIVE_ROOT;
}

// Session ID stored in global to persist across turns
const SESSION_ID_KEY = "__teleg_session_id";
function getSessionId(): string {
  const g = globalThis as unknown as Record<string, string | undefined>;
  if (typeof g[SESSION_ID_KEY] === "undefined") {
    g[SESSION_ID_KEY] = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return g[SESSION_ID_KEY]!;
}

function isAllowedUser(config: TelegramConfig, userId: number): boolean {
  if (!config.allowedUserIds || config.allowedUserIds.length === 0) {
    return false;
  }
  return config.allowedUserIds.includes(userId);
}

// ============================================================================
// SHARED POLLING MANAGER (Singleton)
// ============================================================================

interface TurnQueueItem {
  turn: PendingTelegramTurn;
  update: TelegramUpdate;
}

const SharedPollingManager = (() => {
  let config: TelegramConfig = {};
  let pollingController: AbortController | undefined;
  let pollingPromise: Promise<void> | undefined;
  let isPolling = false;
  let lockRefreshInterval: ReturnType<typeof setInterval> | undefined;
  
  async function acquirePollingLock(): Promise<boolean> {
    try {
      await mkdir(TEMP_DIR, { recursive: true });
      try {
        const existing = await readFile(POLLING_LOCK_FILE, "utf8");
        const parts = existing.trim().split("\n");
        const oldPid = parseInt(parts[0], 10);
        const oldTime = parseInt(parts[1] || "0", 10);
        // Check if lock is stale (>30s without refresh)
        if (oldPid && !isNaN(oldPid)) {
          try {
            process.kill(oldPid, 0); // Check if process exists
            // Process alive and lock fresh
            if (Date.now() - oldTime < POLLING_LOCK_REFRESH_MS * 3) {
              return false; // Another process already holds the lock
            }
          } catch {
            // Process dead, lock is stale - we can claim it
          }
        }
      } catch {
        // No lock file exists, we can claim it
      }
      await writeFile(POLLING_LOCK_FILE, `${process.pid}\n${Date.now()}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  }
  
  async function refreshPollingLock(): Promise<void> {
    try {
      await writeFile(POLLING_LOCK_FILE, `${process.pid}\n${Date.now()}\n`, "utf8");
    } catch {
      // Best effort
    }
  }
  
  async function releasePollingLock(): Promise<void> {
    if (lockRefreshInterval) {
      clearInterval(lockRefreshInterval);
      lockRefreshInterval = undefined;
    }
    try {
      const existing = await readFile(POLLING_LOCK_FILE, "utf8");
      if (existing.trim().startsWith(String(process.pid))) {
        await writeFile(POLLING_LOCK_FILE, "", "utf8");
      }
    } catch {
      // Best effort
    }
  }
  
  let pollState: PollState = {
    consecutiveErrors: 0,
    reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
    lastSuccessfulPoll: Date.now(),
    isHealthy: true,
    lastHealthCheck: Date.now(),
  };
  
  let healthCheckInterval: ReturnType<typeof setInterval> | undefined;
  let turnQueue: TurnQueueItem[] = [];
  let activeTurns: Map<string, ActiveTelegramTurn> = new Map();
  let messageHandler: ((turn: PendingTelegramTurn, update: TelegramUpdate) => void) | null = null;
  
  async function callTelegram<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal | null; timeout?: number },
  ): Promise<TResponse> {
    if (!config.botToken) throw new Error("Telegram bot token is not configured");
    
    const controller = new AbortController();
    const timeout = options?.timeout ?? POLL_TIMEOUT_SECONDS * 1000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = (await response.json()) as TelegramApiResponse<TResponse>;
      if (!data.ok || data.result === undefined) {
        throw new Error(data.description || `Telegram API ${method} failed`);
      }
      return data.result;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("TIMEOUT");
      }
      throw error;
    }
  }
  
  async function performHealthCheck(): Promise<boolean> {
    if (!config.botToken) return false;
    
    try {
      await callTelegram<TelegramUser>("getMe", {}, { timeout: 10000 });
      pollState.lastHealthCheck = Date.now();
      pollState.isHealthy = true;
      return true;
    } catch {
      pollState.isHealthy = false;
      pollState.consecutiveErrors++;
      return false;
    }
  }
  
  function startHealthChecks(): void {
    if (healthCheckInterval) return;
    
    healthCheckInterval = setInterval(async () => {
      if (!isPolling || !config.botToken) return;
      
      const now = Date.now();
      const timeSinceLastPoll = now - pollState.lastSuccessfulPoll;
      
      if (timeSinceLastPoll > HEALTH_CHECK_INTERVAL_MS * 2) {
        const healthy = await performHealthCheck();
        if (!healthy) {
          scheduleReconnect();
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }
  
  function stopHealthChecks(): void {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = undefined;
    }
  }
  
  function extractTwitterUrls(text: string): string[] {
    const urlPattern = /https?:\/\/(?:x|twitter)\.com\/[^\s<>"]+\/status\/\d+/gi;
    const matches = text.match(urlPattern) || [];
    return [...new Set(matches)];
  }
  
  function createTurn(sessionId: string, sessionName: string, message: TelegramMessage): PendingTelegramTurn {
    const rawText = (message.text || message.caption || "").trim();
    const content: Array<TextContent | ImageContent> = [];
    const prompt = rawText.length > 0 ? `${TELEGRAM_PREFIX} ${rawText}` : `${TELEGRAM_PREFIX}`;
    content.push({ type: "text", text: prompt });
    
    return {
      sessionId,
      sessionName,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      queuedAttachments: [],
      content,
      historyText: rawText || "(no text)",
      twitterUrls: extractTwitterUrls(rawText),
    };
  }
  
  async function pollLoop(signal: AbortSignal): Promise<void> {
    if (!config.botToken) return;
    
    try {
      await callTelegram("deleteWebhook", { drop_pending_updates: true }, { signal, timeout: 10000 });
    } catch {
      // Continue anyway
    }
    
    if (config.lastUpdateId === undefined) {
      try {
        const updates = await callTelegram<TelegramUpdate[]>(
          "getUpdates",
          { offset: -1, limit: 1, timeout: 5 },
          { signal, timeout: 10000 }
        );
        const last = updates.at(-1);
        if (last) {
          config.lastUpdateId = last.update_id;
          await writeConfig(config);
        }
      } catch {
        // Will use default
      }
    }
    
    startHealthChecks();
    
    while (!signal.aborted) {
      try {
        const updates = await callTelegram<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
            limit: 10,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ["message", "edited_message"],
          },
          { signal },
        );
        
        pollState.consecutiveErrors = 0;
        pollState.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        pollState.lastSuccessfulPoll = Date.now();
        pollState.isHealthy = true;
        
        for (const update of updates) {
          config.lastUpdateId = update.update_id;
          if (update.update_id % 100 === 0) {
            await writeConfig(config);
          }
          
          const message = update.message || update.edited_message;
          if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) {
            continue;
          }
          
          if (!isAllowedUser(config, message.from.id)) {
            continue;
          }
          
          let targetSessionId: string | null = null;
          
          for (const [sid, turn] of activeTurns) {
            if (turn.chatId === message.chat.id) {
              targetSessionId = sid;
              break;
            }
          }
          
          if (!targetSessionId && turnQueue.length > 0) {
            const queuedForChat = turnQueue.find(q => q.turn.chatId === message.chat.id);
            if (queuedForChat) {
              targetSessionId = queuedForChat.turn.sessionId;
            }
          }
          
          // Check if message is addressed to a specific session (e.g., "@teleg do X")
          const text = message.text || message.caption || "";
          const sessionTagMatch = text.match(/^@(\S+)\s*/);
          if (sessionTagMatch) {
            const tagName = sessionTagMatch[1];
            const registry = await readSessionRegistry();
            const namedSession = registry.sessions.find(s => s.sessionName === tagName);
            if (namedSession) {
              targetSessionId = namedSession.sessionId;
            }
          }
          
          if (!targetSessionId) {
            const registry = await readSessionRegistry();
            if (registry.primarySessionId) {
              targetSessionId = registry.primarySessionId;
            } else if (registry.sessions.length > 0) {
              targetSessionId = registry.sessions[0].sessionId;
            }
          }
          
          if (targetSessionId && messageHandler) {
            // Look up session name from registry for routing
            const reg = await readSessionRegistry();
            const sessionInfo = reg.sessions.find(s => s.sessionId === targetSessionId);
            const sName = sessionInfo?.sessionName || targetSessionId;
            const turn = createTurn(targetSessionId, sName, message);
            activeTurns.set(targetSessionId, turn as ActiveTelegramTurn);
            messageHandler(turn, update);
          } else {
            const turn = createTurn("unassigned", "unknown", message);
            turnQueue.push({ turn, update });
            
            if (messageHandler) {
              messageHandler(turn, update);
            }
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        
        const msg = error instanceof Error ? error.message : String(error);
        
        if (msg === "TIMEOUT") {
          pollState.lastSuccessfulPoll = Date.now();
          continue;
        }
        
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        
        pollState.consecutiveErrors++;
        await scheduleReconnect();
      }
    }
  }
  
  async function scheduleReconnect(): Promise<void> {
    if (pollingController?.signal.aborted) return;
    
    if (pollState.consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
      pollState.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      pollState.consecutiveErrors = 0;
      config.lastUpdateId = undefined;
      await writeConfig(config);
    }
    
    await new Promise((resolve) => setTimeout(resolve, pollState.reconnectDelay));
    
    pollState.reconnectDelay = Math.min(
      pollState.reconnectDelay * BASE_BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS
    );
  }
  
  async function startPolling(): Promise<void> {
    if (!config.botToken || isPolling) return;
    
    // Acquire cross-process lock before starting polling
    const hasLock = await acquirePollingLock();
    if (!hasLock) {
      return; // Another process is already polling, skip
    }
    
    pollingController = new AbortController();
    isPolling = true;
    
    // Refresh lock periodically so other processes can detect if we crash
    lockRefreshInterval = setInterval(refreshPollingLock, POLLING_LOCK_REFRESH_MS);
    
    pollingPromise = pollLoop(pollingController.signal).finally(() => {
      pollingPromise = undefined;
      pollingController = undefined;
      isPolling = false;
      stopHealthChecks();
      releasePollingLock();
    });
  }
  
  async function stopPolling(): Promise<void> {
    stopHealthChecks();
    pollingController?.abort();
    pollingController = undefined;
    await pollingPromise?.catch(() => undefined);
    await releasePollingLock();
    isPolling = false;
  }
  
  return {
    async init(): Promise<void> {
      config = await readConfig();
    },
    
    async updateConfig(newConfig: TelegramConfig): Promise<void> {
      config = newConfig;
      await writeConfig(config);
    },
    
    async start(): Promise<void> {
      await this.init();
      if (!isPolling && config.botToken) {
        await startPolling();
      }
    },
    
    async stop(): Promise<void> {
      await stopPolling();
    },
    
    isActive(): boolean {
      return isPolling;
    },
    
    getState(): PollState {
      return { ...pollState };
    },
    
    onMessage(handler: (turn: PendingTelegramTurn, update: TelegramUpdate) => void): void {
      messageHandler = handler;
    },
    
    completeTurn(sessionId: string): void {
      activeTurns.delete(sessionId);
    },
    
    claimNextTurn(sessionId: string): TurnQueueItem | null {
      const idx = turnQueue.findIndex(q => q.turn.sessionId === "unassigned" || q.turn.sessionId === sessionId);
      if (idx >= 0) {
        const item = turnQueue.splice(idx, 1)[0];
        item.turn.sessionId = sessionId;
        activeTurns.set(sessionId, item.turn as ActiveTelegramTurn);
        return item;
      }
      return null;
    },
    
    getQueueDepth(): number {
      return turnQueue.length;
    },
    
    isUserAllowed(userId: number): boolean {
      return isAllowedUser(config, userId);
    },
    
    async addAllowedUser(userId: number): Promise<void> {
      if (!config.allowedUserIds) {
        config.allowedUserIds = [];
      }
      if (!config.allowedUserIds.includes(userId)) {
        config.allowedUserIds.push(userId);
        await writeConfig(config);
      }
    },
    
    getBotInfo(): { username?: string; id?: number } {
      return { username: config.botUsername, id: config.botId };
    },
    
    async sendReply(chatId: string, replyToMsgId: number, text: string): Promise<number | undefined> {
      const chunks: string[] = [];
      let current = "";
      const paragraphs = text.split(/\n\n+/);
      
      for (const para of paragraphs) {
        if (para.length <= MAX_MESSAGE_LENGTH) {
          const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
          if (candidate.length <= MAX_MESSAGE_LENGTH) {
            current = candidate;
            continue;
          }
          if (current) chunks.push(current);
          current = para;
          continue;
        }
        if (current) chunks.push(current);
        current = "";
        for (let i = 0; i < para.length; i += MAX_MESSAGE_LENGTH) {
          chunks.push(para.slice(i, i + MAX_MESSAGE_LENGTH));
        }
      }
      if (current) chunks.push(current);
      
      let lastMessageId: number | undefined;
      for (const chunk of chunks) {
        try {
          const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
            chat_id: chatId,
            text: chunk,
            ...(replyToMsgId ? { reply_to_message_id: replyToMsgId } : {}),
          }, { timeout: 10000 });
          lastMessageId = sent.message_id;
        } catch {
          // Continue
        }
      }
      return lastMessageId;
    },
    
    async sendFile(chatId: string, replyToMsgId: number, filePath: string, fileName: string, isImage: boolean, caption?: string): Promise<boolean> {
      try {
        const method = isImage ? "sendPhoto" : "sendDocument";
        const fieldName = isImage ? "photo" : "document";
        
        const form = new FormData();
        form.set("chat_id", chatId);
        if (caption) form.set("caption", caption);
        const buffer = await readFile(filePath);
        form.set(fieldName, new Blob([buffer]), fileName);
        
        const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
          method: "POST",
          body: form,
        });
        const data = (await response.json()) as TelegramApiResponse<TelegramSentMessage>;
        return data.ok;
      } catch {
        return false;
      }
    },
    
    async verifyToken(token: string): Promise<TelegramUser | null> {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
        if (data.ok && data.result) {
          return data.result;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
})();

// ============================================================================
// Session State
// ============================================================================

interface SessionState {
  sessionId: string;
  config: TelegramConfig;
  activeTurn: ActiveTelegramTurn | undefined;
  typingInterval: ReturnType<typeof setInterval> | undefined;
  setupInProgress: boolean;
}

function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    config: {},
    activeTurn: undefined,
    typingInterval: undefined,
    setupInProgress: false,
  };
}

// ============================================================================
// MAIN EXTENSION
// ============================================================================

export default function (pi: ExtensionAPI): void {
  const sessionId = getSessionId();
  // Derive a human-readable session name from the current working directory
  const cwd = process.cwd();
  const sessionName = cwd.split("/").filter(Boolean).pop() || "default";
  let state: SessionState = createSessionState(sessionId);
  
  function updateStatus(ctx: ExtensionContext, error?: string): void {
    const theme = ctx.ui.theme;
    const label = `${theme.fg("accent", "teleg")}${theme.fg("muted", ":" + sessionName)}`;
    
    const pollState = SharedPollingManager.getState();
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
    if (!SharedPollingManager.isActive()) {
      ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("warning", "reconnecting...")}`);
      return;
    }
    if (!state.config.allowedUserIds || state.config.allowedUserIds.length === 0) {
      ctx.ui.setStatus("teleg-bridge", `${label} ${theme.fg("warning", "awaiting pairing")}`);
      return;
    }
    
    const queueDepth = SharedPollingManager.getQueueDepth();
    const activeIndicator = state.activeTurn
      ? theme.fg("accent", "●")
      : theme.fg("success", healthIndicator);
    const queued = queueDepth > 0
      ? ` +${queueDepth}`
      : "";
    
    ctx.ui.setStatus("teleg-bridge", `${label} ${activeIndicator}${queued}${errorIndicator}`);
  }
  
  async function registerSession(): Promise<void> {
    const registry = await readSessionRegistry();
    
    const oneHourAgo = Date.now() - 3600000;
    registry.sessions = registry.sessions.filter(s => s.lastActivity > oneHourAgo);
    
    const existing = registry.sessions.findIndex(s => s.sessionId === sessionId);
    const sessionInfo: SessionInfo = {
      sessionId,
      sessionName,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isActive: true,
    };
    
    if (existing >= 0) {
      // Preserve announcedPresence flag on reconnection
      sessionInfo.announcedPresence = registry.sessions[existing].announcedPresence;
      registry.sessions[existing] = sessionInfo;
    } else {
      registry.sessions.push(sessionInfo);
    }
    
    if (registry.sessions.length === 1) {
      registry.primarySessionId = sessionId;
    }
    
    await writeSessionRegistry(registry);
  }
  
  async function unregisterSession(): Promise<void> {
    const registry = await readSessionRegistry();
    registry.sessions = registry.sessions.filter(s => s.sessionId !== sessionId);
    
    if (registry.primarySessionId === sessionId && registry.sessions.length > 0) {
      registry.primarySessionId = registry.sessions[0].sessionId;
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
  }
  
  async function promptForConfig(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || state.setupInProgress) return;
    state.setupInProgress = true;
    try {
      const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
      if (!token) return;
      
      const botInfo = await SharedPollingManager.verifyToken(token);
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
      
      await SharedPollingManager.updateConfig(newConfig);
      state.config = newConfig;
      
      ctx.ui.notify(`Teleg-bridge connected: @${botInfo.username}`, "info");
      ctx.ui.notify("Send /start to your bot in Telegram to pair.", "info");
      
      await SharedPollingManager.start();
      updateStatus(ctx);
    } finally {
      state.setupInProgress = false;
    }
  }
  
  function isTelegramPrompt(prompt: string): boolean {
    return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
  }

  async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
    const rawText = message.text || message.caption || "";
    
    // Strip session prefix for routing decisions
    const sessionTagMatch = rawText.match(/^@(\S+)\s*/);
    const cleanText = sessionTagMatch ? rawText.replace(sessionTagMatch[0], "") : rawText;
    const targetSessionName = sessionTagMatch ? sessionTagMatch[1] : null;

    // Check if this message should be forwarded to another session
    if (targetSessionName && targetSessionName !== sessionName) {
      // Forward command to the target session via relay
      const forwardResult = await forwardToSession(
        targetSessionName,
        cleanText,
        { chatId: message.chat.id, messageId: message.message_id },
      );
      if (forwardResult.ok) {
        // Forwarded successfully, target session will handle the reply
        return;
      } else {
        // Could not forward - notify user
        await SharedPollingManager.sendReply(
          String(message.chat.id),
          message.message_id,
          `⚠️ Could not reach @${targetSessionName}: ${forwardResult.error}`,
        );
        return;
      }
    }

    // No prefix or targeting this session — process normally
    const lower = cleanText.toLowerCase();
    
    if (lower === "stop" || lower === "/stop") {
      if (state.activeTurn) {
        state.activeTurn = undefined;
        SharedPollingManager.completeTurn(sessionId);
        updateStatus(ctx);
        await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, "Aborted current turn.");
      } else {
        await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, "No active turn.");
      }
      return;
    }
    
    if (lower === "/help" || lower === "/start") {
      await SharedPollingManager.sendReply(
        String(message.chat.id),
        message.message_id,
        `Teleg-Bridge Active! (this session: ${sessionName})

Send any message to forward to pi.
Prefix with @sessionName to route to a specific session.
Include Twitter/X URLs for automatic media download.

Commands:
/status - Connection status
/compact - Compact memory
/health - Test connection
/healthfull - Full health diagnostic
stop - Abort current turn`,
      );
      
      if (!state.config.allowedUserIds || state.config.allowedUserIds.length === 0) {
        state.config.allowedUserIds = [message.from!.id];
        await SharedPollingManager.updateConfig(state.config);
      }
      return;
    }
    
    if (lower === "/status") {
      const pollState = SharedPollingManager.getState();
      const botInfo = SharedPollingManager.getBotInfo();
      const registry = await readSessionRegistry();
      
      const lines = [
        `bot: ${botInfo.username ? `@${botInfo.username}` : "not configured"}`,
        `user: ${message.from!.id === state.config.allowedUserIds?.[0] ? "paired" : "not paired"}`,
        `polling: ${SharedPollingManager.isActive() ? "running" : "stopped"}`,
        `health: ${pollState.isHealthy ? "OK" : "DEGRADED"}`,
        `consecutive errors: ${pollState.consecutiveErrors}`,
        `sessions: ${registry.sessions.length}${registry.sessions.map(s => `\n  ${s.sessionName === sessionName ? "*" : " "} ${s.sessionName} (${s.sessionId.slice(0, 12)}...)${s.sessionId === sessionId ? " ← you" : ""}`).join("")}`,
        `active: ${state.activeTurn ? "yes" : "no"}`,
        `queued: ${SharedPollingManager.getQueueDepth()}`,
      ];
      await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, lines.join("\n"));
      return;
    }
    
    if (lower === "/health") {
      const health = SharedPollingManager.getState();
      if (health.isHealthy) {
        await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, "✅ Bot connection OK");
      } else {
        await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, "⚠️ Connection issues detected. Auto-reconnecting...");
      }
      return;
    }
    
    if (lower === "/healthfull") {
      const health = SharedPollingManager.getState();
      const lines = [
        `last successful poll: ${new Date(health.lastSuccessfulPoll).toISOString()}`,
        `last health check: ${new Date(health.lastHealthCheck).toISOString()}`,
        `is healthy: ${health.isHealthy}`,
        `consecutive errors: ${health.consecutiveErrors}`,
        `reconnect delay: ${health.reconnectDelay}ms`,
      ];
      await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, lines.join("\n"));
      return;
    }
    
    if (lower === "/compact") {
      if (!ctx.isIdle()) {
        await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, "Cannot compact while busy. Send stop first.");
        return;
      }
      ctx.compact({
        onComplete: () => {
          void SharedPollingManager.sendReply(String(message.chat.id), message.message_id, "Compaction completed.");
        },
        onError: (err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          void SharedPollingManager.sendReply(String(message.chat.id), message.message_id, `Compaction failed: ${errorMessage}`);
        },
      });
      await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, "Compaction started.");
      return;
    }
    
    // Regular message - send to agent
    const turn = {
      sessionId,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      queuedAttachments: [] as QueuedAttachment[],
      content: [{ type: "text" as const, text: `${TELEGRAM_PREFIX} ${rawText}` }] as Array<TextContent | ImageContent>,
      historyText: rawText || "(no text)",
    };
    
    state.activeTurn = turn as ActiveTelegramTurn;
    updateStatus(ctx);
    pi.sendUserMessage(turn.content);
  }
  
  // ========================================================================
  // Commands
  // ========================================================================
  
  pi.registerCommand("teleg-setup", {
    description: "Configure teleg-bridge bot token",
    handler: async (_args, ctx) => {
      await promptForConfig(ctx);
    },
  });
  
  pi.registerCommand("teleg-status", {
    description: "Show teleg-bridge status",
    handler: async (_args, ctx) => {
      const health = SharedPollingManager.getState();
      const botInfo = SharedPollingManager.getBotInfo();
      const registry = await readSessionRegistry();
      
      ctx.ui.notify(
        `bot: ${botInfo.username || "?"} | polling: ${SharedPollingManager.isActive() ? "running" : "stopped"} | sessions: ${registry.sessions.length} | health: ${health.isHealthy ? "OK" : "DEGRADED"}`,
        "info"
      );
    },
  });
  
  pi.registerCommand("teleg-connect", {
    description: "Start teleg-bridge polling",
    handler: async (_args, ctx) => {
      if (!state.config.botToken) {
        await promptForConfig(ctx);
        return;
      }
      
      await SharedPollingManager.start();
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
      await SharedPollingManager.stop();
      updateStatus(ctx);
    },
  });
  
  pi.registerCommand("teleg-reconnect", {
    description: "Force reconnection to Telegram",
    handler: async (_args, ctx) => {
      await SharedPollingManager.stop();
      await SharedPollingManager.start();
      updateStatus(ctx);
      ctx.ui.notify("Reconnecting to Telegram...", "info");
    },
  });
  
  // ========================================================================
  // MCP Tools
  // ========================================================================
  
  pi.registerTool({
    name: "send_message",
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
      if (!targetChatId) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const result = await SharedPollingManager.sendReply(String(targetChatId), 0, params.text);
      return { content: [{ type: "text", text: result ? `Sent message ${result}` : "Message sent" }], details: {} };
    },
  });
  
  pi.registerTool({
    name: "send_photo",
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
      if (!targetChatId) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const stats = await stat(params.file_path);
      if (!stats.isFile()) {
        throw new Error(`Not a file: ${params.file_path}`);
      }
      const success = await SharedPollingManager.sendFile(
        String(targetChatId),
        0,
        params.file_path,
        params.file_path.split("/").pop() || "photo.jpg",
        true,
        params.caption
      );
      if (!success) {
        throw new Error("Failed to send photo");
      }
      return { content: [{ type: "text", text: "Photo sent" }], details: {} };
    },
  });
  
  pi.registerTool({
    name: "send_video",
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
      if (!targetChatId) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const stats = await stat(params.file_path);
      if (!stats.isFile()) {
        throw new Error(`Not a file: ${params.file_path}`);
      }
      const success = await SharedPollingManager.sendFile(
        String(targetChatId),
        0,
        params.file_path,
        params.file_path.split("/").pop() || "video.mp4",
        false,
        params.caption
      );
      if (!success) {
        throw new Error("Failed to send video");
      }
      return { content: [{ type: "text", text: "Video sent" }], details: {} };
    },
  });
  
  pi.registerTool({
    name: "get_me",
    label: "Get Telegram Bot Info",
    description: "Get information about the bot",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const botInfo = SharedPollingManager.getBotInfo();
      return { content: [{ type: "text", text: JSON.stringify(botInfo) }], details: {} };
    },
  });
  
  pi.registerTool({
    name: "teleg_attach",
    label: "Telegram Attach",
    description: "Queue one or more local files to be sent with the next Telegram reply.",
    promptSnippet: "Queue local files to be sent with the next Telegram reply.",
    promptGuidelines: [
      "When handling a [telegram] message and the user asked for a file or generated artifact, call teleg_attach with the local path.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "Local file path to attach" })),
    }),
    async execute(_toolCallId, params) {
      if (!state.activeTurn) {
        throw new Error("teleg_attach can only be used while replying to an active Telegram turn");
      }
      const added: string[] = [];
      for (const inputPath of params.paths) {
        const stats = await stat(inputPath);
        if (!stats.isFile()) {
          throw new Error(`Not a file: ${inputPath}`);
        }
        if (state.activeTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
          throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
        }
        const fileName = inputPath.split("/").pop() || "file";
        state.activeTurn.queuedAttachments.push({ path: inputPath, fileName });
        added.push(inputPath);
      }
      return {
        content: [{ type: "text", text: `Queued ${added.length} attachment(s) for Telegram.` }],
        details: { paths: added },
      };
    },
  });
  
  // ========================================================================
  // Session Events
  // ========================================================================
  
  pi.on("session_start", async (_event, ctx) => {
    await SharedPollingManager.init();
    state.config = await readConfig();
    await mkdir(TEMP_DIR, { recursive: true });
    await registerSession();

    // Announce presence ONCE per session (not on reconnections)
    const registry1 = await readSessionRegistry();
    const sessInfo = registry1.sessions.find(s => s.sessionId === sessionId);
    if (sessInfo && !sessInfo.announcedPresence) {
      const chatId = state.config.allowedUserIds?.[0];
      if (chatId && state.config.botToken) {
        try {
          await fetch(`https://api.telegram.org/bot${state.config.botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `✅ <b>${sessionName}</b> connected`, parse_mode: "HTML" }),
          });
        } catch {
          // Network unavailable — skip announcement, extension still loads
        }
      }
      sessInfo.announcedPresence = true;
      await writeSessionRegistry(registry1);
    }

    // Start the relay server for inter-session command forwarding
    await startRelayServer(sessionName).catch(console.error);
    setCommandHandler(async (text, meta) => {
      // When a forwarded command arrives, process it and return the response
      // For now just echo back for testing
      return `[${sessionName}] Received: ${text}`;
    });

    if (state.config.botToken) {
      await SharedPollingManager.start();
    }
    
    SharedPollingManager.onMessage(async (turn, update) => {
      const message = update.message || update.edited_message;
      if (!message) return;
      
      if (turn.sessionId !== sessionId && turn.sessionId !== "unassigned") {
        return;
      }
      
      await handleAuthorizedTelegramMessage(message, ctx);
    });
    
    setInterval(() => {
      heartbeatSession();
    }, 30000);
    
    updateStatus(ctx);
  });
  
  pi.on("session_shutdown", async (_event, _ctx) => {
    state.activeTurn = undefined;
    SharedPollingManager.completeTurn(sessionId);
    stopRelayServer();
    
    // Announce departure ONCE (before unregister so we still have sessionName)
    const registry2 = await readSessionRegistry();
    const dying = registry2.sessions.find(s => s.sessionId === sessionId);
    if (dying && dying.announcedPresence) {
      const chatId = state.config.allowedUserIds?.[0];
      if (chatId && state.config.botToken) {
        try {
          await fetch(`https://api.telegram.org/bot${state.config.botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `⚠️ <b>${sessionName}</b> disconnected`, parse_mode: "HTML" }),
          });
        } catch {
          // Network unavailable — skip
        }
      }
    }
    
    await unregisterSession();
    
    const registry = await readSessionRegistry();
    if (registry.sessions.length === 0) {
      await SharedPollingManager.stop();
    }
  });
  
  pi.on("before_agent_start", async (event) => {
    const archiveRoot = getArchiveRoot(state.config);
    let suffix = SYSTEM_PROMPT_SUFFIX.replace("{archiveRoot}", archiveRoot);
    suffix = suffix.replace("{sessionName}", sessionName);
    const promptSuffix = isTelegramPrompt(event.prompt)
      ? `${suffix}\n- The current user message came from Telegram.`
      : suffix;
    return {
      systemPrompt: event.systemPrompt + promptSuffix,
    };
  });
  
  pi.on("agent_start", async (_event, ctx) => {
    if (!state.activeTurn) {
      const queued = SharedPollingManager.claimNextTurn(sessionId);
      if (queued) {
        state.activeTurn = queued.turn as ActiveTelegramTurn;
      }
    }
    updateStatus(ctx);
  });
  
  pi.on("agent_end", async (event, ctx) => {
    const turn = state.activeTurn;
    state.activeTurn = undefined;
    SharedPollingManager.completeTurn(sessionId);
    updateStatus(ctx);
    if (!turn) return;
    
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
    
    if (assistantText) {
      await SharedPollingManager.sendReply(String(turn.chatId), turn.replyToMessageId, assistantText);
    } else if (turn.queuedAttachments.length > 0) {
      await SharedPollingManager.sendReply(String(turn.chatId), turn.replyToMessageId, "Attached requested file(s).");
    }
    
    for (const attachment of turn.queuedAttachments) {
      const ext = attachment.fileName.split(".").pop()?.toLowerCase();
      const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext || "");
      await SharedPollingManager.sendFile(
        String(turn.chatId),
        turn.replyToMessageId,
        attachment.path,
        attachment.fileName,
        isImage
      );
    }
    
    const nextTurn = SharedPollingManager.claimNextTurn(sessionId);
    if (nextTurn) {
      state.activeTurn = nextTurn.turn as ActiveTelegramTurn;
      updateStatus(ctx);
      pi.sendUserMessage(nextTurn.turn.content);
    }
  });
}