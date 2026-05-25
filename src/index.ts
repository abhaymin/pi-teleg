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
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
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
  getRelayStatus,
  cleanStaleRelayFiles,
  cleanRelayFilesByPid,
} from "./relay.js";
import * as Db from "./db.js";
import { resolveBotContext, detectSplitDb, type BotContext } from "./config.js";
import { reconcileSessions, electPrimary, checkSessionLiveness, getSessionLivenessSummary, type SessionLiveness } from "./session-registry.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ARCHIVE_ROOT = join(homedir(), "pi-teleg-archive");
const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(CONFIG_DIR, "teleg-bridge.json");
const SESSION_REGISTRY_FILE = join(CONFIG_DIR, "teleg-sessions.json");
const CAPABILITIES_FILE = join(CONFIG_DIR, "teleg-capabilities.json");
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
const DRAIN_INTERVAL_MS = parseInt(process.env.TELEG_DRAIN_INTERVAL_MS || "12000", 10);
const BASE_BACKOFF_MULTIPLIER = 2;

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLL_WORKER_PATH = join(__dirname, "poll-worker.js");

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
  pid: number;                // process ID for liveness checks
  connectedAt: number;
  lastActivity: number;
  isActive: boolean;
  announcedPresence?: boolean; // true after sending the single "connected" message for this session
  botToken?: string;          // optional per-session Telegram bot token
  projectDir?: string;        // working directory of the session
  capabilities?: string[];    // declared capabilities from INFO_REL.md
  description?: string;       // session description
  botId?: number;             // Phase 4: linked bot_id
}

interface CapabilitiesEntry {
  sessionName: string;
  sessionId: string;
  pid: number;
  projectDir: string;
  capabilities: string[];
  description: string;
  registeredAt: number;
}

interface CapabilitiesRegistry {
  entries: CapabilitiesEntry[];
  lastUpdated: number;
}

interface SessionRegistry {
  version: number;              // Phase 4: v2 for multi-bot support
  sessions: SessionInfo[];
  primarySessionId?: string;
  primaryByBot?: Record<string, string>; // Phase 4: primary per bot_id
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
  dbId?: number; // SQLite row ID for the queued message
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface PollState {
  consecutiveErrors: number;
  reconnectDelay: number;
  lastSuccessfulPoll: number;
  isHealthy: boolean;
  lastHealthCheck: number;
  pendingRetries: Map<number, number>; // dbId → retry count for in-progress messages
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
    const data = JSON.parse(content) as Partial<SessionRegistry>;
    // Phase 4: Support v2 format with version, primaryByBot
    // Default values for v1 format files
    return {
      version: data.version ?? 1,
      sessions: data.sessions ?? [],
      primarySessionId: data.primarySessionId,
      primaryByBot: data.primaryByBot ?? {},
    };
  } catch {
    return { version: 2, sessions: [], primaryByBot: {} }; // Phase 4: default to v2
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
// Capabilities
// ============================================================================

function detectProjectCapabilities(projectDir: string): { capabilities: string[]; description: string } {
  const result: { capabilities: string[]; description: string } = { capabilities: [], description: "" };

  const parseCapabilitiesMd = (content: string) => {
    const lines = content.split("\n");
    let currentSection = "";
    let foundCaps = false;
    for (const line of lines) {
      const header = line.match(/^##?\s*(.+)/);
      if (header) {
        currentSection = header[1].trim().toLowerCase();
        foundCaps = false;
        continue;
      }
      if (currentSection === "capabilities" && line.trim()) {
        result.capabilities = line.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        foundCaps = true;
      }
      if (currentSection === "description" && line.trim() && !result.description) {
        result.description = line.trim();
      }
    }
    return foundCaps;
  };

  const tryFile = (filename: string): boolean => {
    try {
      const content = readFileSync(join(projectDir, filename), "utf8");
      return parseCapabilitiesMd(content);
    } catch { return false; }
  };

  if (tryFile("INFO_REL.md")) return result;
  if (tryFile("AGENTS.md")) return result;

  // Last fallback: README.md
  try {
    const content = readFileSync(join(projectDir, "README.md"), "utf8");
    const firstLine = content.split("\n").find((l: string) => l.trim().length > 0 && !l.startsWith("#"))?.trim() || "";
    if (firstLine) result.description = firstLine;
    const folderName = projectDir.split("/").filter(Boolean).pop()?.toLowerCase() || "";
    if (folderName) result.capabilities.push(folderName.replace(/[^a-z0-9-]/g, ""));
  } catch { /* no README */ }

  return result;
}

async function readCapabilitiesRegistry(): Promise<CapabilitiesRegistry> {
  try {
    const content = await readFile(CAPABILITIES_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return { entries: [], lastUpdated: Date.now() };
  }
}

async function writeCapabilitiesRegistry(reg: CapabilitiesRegistry): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  reg.lastUpdated = Date.now();
  await writeFile(CAPABILITIES_FILE, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

async function registerSessionCapabilities(sessionId: string, sessionName: string, pid: number, projectDir: string): Promise<void> {
  const { capabilities, description } = detectProjectCapabilities(projectDir);

  const homeDir = homedir();
  if (projectDir === homeDir || projectDir === "/" || projectDir.startsWith(homeDir + "/.")) return;
  if (capabilities.length === 0 && !description) return;

  const reg = await readCapabilitiesRegistry();
  reg.entries = reg.entries.filter(e => e.sessionId !== sessionId);
  reg.entries.push({ sessionName, sessionId, pid, projectDir, capabilities, description, registeredAt: Date.now() });
  await writeCapabilitiesRegistry(reg);
}

async function unregisterSessionCapabilities(sessionId: string): Promise<void> {
  const reg = await readCapabilitiesRegistry();
  reg.entries = reg.entries.filter(e => e.sessionId !== sessionId);
  await writeCapabilitiesRegistry(reg);
}

async function cleanStaleCapabilities(): Promise<void> {
  const reg = await readCapabilitiesRegistry();
  const before = reg.entries.length;
  reg.entries = reg.entries.filter(e => {
    try { process.kill(e.pid, 0); return true; } catch { return false; }
  });
  if (reg.entries.length !== before) await writeCapabilitiesRegistry(reg);
}

function matchMessageToCapability(text: string, entries: CapabilitiesEntry[]): CapabilitiesEntry | null {
  const lower = text.toLowerCase();
  const twitterRe = /https?:\/\/(?:x|twitter)\.com\/[^\s<>"']+\/status\/\d+/i;
  const youtubeRe = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/i;
  const redditRe = /https?:\/\/(?:www\.)?reddit\.com\/r\/[^\s<>"']+\/comments\/\w+/i;
  const hasTwitter = twitterRe.test(text);
  const hasYoutube = youtubeRe.test(text);
  const hasReddit = redditRe.test(text);

  for (const entry of entries) {
    try { process.kill(entry.pid, 0); } catch { continue; }
    const caps = entry.capabilities.map(c => c.toLowerCase());
    if (hasTwitter && caps.some(c => c.includes("twitter") || c.includes("tweet") || c.includes("media") || c.includes("download"))) return entry;
    if (hasYoutube && caps.some(c => c.includes("youtube") || c.includes("video") || c.includes("media") || c.includes("download"))) return entry;
    if (hasReddit && caps.some(c => c.includes("reddit") || c.includes("media") || c.includes("download"))) return entry;
    if (entry.description) {
      const descLower = entry.description.toLowerCase();
      const keywords = lower.split(/\s+/).filter((w: string) => w.length > 3);
      for (const kw of keywords) {
        if (descLower.includes(kw)) return entry;
      }
    }
  }
  return null;
}

// ============================================================================
// SHARED POLLING MANAGER (Singleton)
// ============================================================================

interface TurnQueueItem {
  turn: PendingTelegramTurn;
  update: TelegramUpdate;
  dbId?: number; // SQLite row ID for persistent queue
}

const SharedPollingManager = (() => {
  let config: TelegramConfig = {};
  let pollWorker: Worker | null = null;
  let isPolling = false;
  let lockRefreshInterval: ReturnType<typeof setInterval> | undefined;
  let messageHandler: ((turn: PendingTelegramTurn, update: TelegramUpdate) => void) | null = null;
  // SharedPollingManager is called from MAIN extension IIFE before state is created.
  // Use a mutable reference so it can be set once state exists.
  let botContextRef: { botContext: { botId: number } | undefined } | null = null;
  
  function getBotId(): number {
    return botContextRef?.botContext?.botId ?? 0;
  }
  function setBotContextRef(ref: { botContext: { botId: number } | undefined }): void {
    botContextRef = ref;
  }
  
  // ─── Session state pulled fresh from SQLite on every call ──────────────────
  // These functions read from DB instead of in-memory state so any session
  // can accurately query/update the queue regardless of which session is polling.

  /**
   * Check if a session has an active turn by looking at DB, not in-memory state.
   * This allows any session to know what's happening without needing the
   * polling session to maintain shared in-memory state.
   */
  function hasActiveTurnInDb(sessionId: string): boolean {
    try {
      const row = Db.getDb().prepare(
        "SELECT 1 FROM message_queue WHERE session_id = ? AND status = 'processing' LIMIT 1"
      ).get(sessionId);
      return !!row;
    } catch { return false; }
  }

  /**
   * Get all message IDs that are currently 'processing' for a given session
   * from the database (source of truth, not in-memory cache).
   */
  function getProcessingMessageIds(sessionId: string): number[] {
    try {
      const rows = Db.getDb().prepare(
        "SELECT id FROM message_queue WHERE session_id = ? AND status = 'processing'"
      ).all(sessionId) as Array<{ id: number }>;
      return rows.map(r => r.id);
    } catch { return []; }
  }

  /**
   * Check the DB for any session already processing a message from this chat.
   * Phase 5: Scoped by bot_id for multi-bot support.
   * Used for chat affinity — ensures messages from the same chat go to the
   * same session even across process boundaries.
   */
  function getSessionProcessingChat(chatId: number): string | null {
    try {
      const botId = SharedPollingManager.getBotId();
      if (botId) {
        // Phase 5: scope query by bot_id
        const row = Db.getDb().prepare(
          "SELECT session_id FROM message_queue WHERE bot_id = ? AND chat_id = ? AND status = 'processing' ORDER BY started_at DESC LIMIT 1"
        ).get(botId, chatId) as { session_id: string } | undefined;
        return row?.session_id ?? null;
      }
      // Fallback for no bot_id (legacy behavior)
      const row = Db.getDb().prepare(
        "SELECT session_id FROM message_queue WHERE chat_id = ? AND status = 'processing' ORDER BY started_at DESC LIMIT 1"
      ).get(chatId) as { session_id: string } | undefined;
      return row?.session_id ?? null;
    } catch { return null; }
  }

  // ─── In-memory turn tracking (per-process cache of DB state) ────────────
  // activeTurns: tracks turns in-flight within this process. Cross-process state
  // lives in SQLite (see hasActiveTurnInDb, getSessionProcessingChat above).
  // turnQueue: NOT needed — ordering is handled by the SQLite queue.
  let activeTurns: Map<string, ActiveTelegramTurn> = new Map();

  let pollState: PollState = {
    consecutiveErrors: 0,
    reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
    lastSuccessfulPoll: Date.now(),
    isHealthy: true,
    lastHealthCheck: Date.now(),
    pendingRetries: new Map<number, number>(),
  };
  
  // ─── Polling Lock (cross-process) ──────────────────────────────────────
  
  async function acquirePollingLock(): Promise<boolean> {
    try {
      await mkdir(TEMP_DIR, { recursive: true });
      try {
        const existing = await readFile(POLLING_LOCK_FILE, "utf8");
        const parts = existing.trim().split("\n");
        const oldPid = parseInt(parts[0], 10);
        const oldTime = parseInt(parts[1] || "0", 10);
        if (oldPid && !isNaN(oldPid)) {
          try {
            process.kill(oldPid, 0);
            if (Date.now() - oldTime < POLLING_LOCK_REFRESH_MS * 3) return false;
          } catch { /* dead process */ }
        }
      } catch { /* no lock file */ }
      await writeFile(POLLING_LOCK_FILE, `${process.pid}\n${Date.now()}\n`, "utf8");
      return true;
    } catch { return false; }
  }
  
  async function refreshPollingLock(): Promise<void> {
    try { await writeFile(POLLING_LOCK_FILE, `${process.pid}\n${Date.now()}\n`, "utf8"); } catch {}
  }
  
  async function releasePollingLock(): Promise<void> {
    if (lockRefreshInterval) { clearInterval(lockRefreshInterval); lockRefreshInterval = undefined; }
    try {
      const existing = await readFile(POLLING_LOCK_FILE, "utf8");
      if (existing.trim().startsWith(String(process.pid))) await writeFile(POLLING_LOCK_FILE, "", "utf8");
    } catch {}
  }
  
  function isPollingLockHeldByOther(): boolean {
    try {
      const existing = readFileSync(POLLING_LOCK_FILE, "utf8");
      const parts = existing.trim().split("\n");
      const oldPid = parseInt(parts[0], 10);
      const oldTime = parseInt(parts[1] || "0", 10);
      if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          if (Date.now() - oldTime < POLLING_LOCK_REFRESH_MS * 3) return true;
        } catch {}
      }
    } catch {}
    return false;
  }
  
  // ─── Telegram API (for sending replies — stays in main thread) ──────
  
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
  
  // ─── Helpers ────────────────────────────────────────────────────────────
  
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
      sessionId, sessionName,
      chatId: message.chat.id,
      replyToMessageId: message.message_id,
      queuedAttachments: [],
      content,
      historyText: rawText || "(no text)",
      twitterUrls: extractTwitterUrls(rawText),
    };
  }
  
  // ─── Worker Thread Message Handler ───────────────────────────────────
  // Runs for EVERY message received by the poll worker.
  // Dispatches to the correct session concurrently — multiple sessions
  // can process in parallel (orchestrator behaviour).
  
  async function handleWorkerMessage(update: TelegramUpdate, dbId: number): Promise<void> {
    const message = update.message || update.edited_message;
    if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;
    if (!isAllowedUser(config, message.from.id)) return;
    
    let targetSessionId: string | null = null;
    
    // 1. Session affinity via DB: if any session is already processing a message from this chat
    // (cross-process awareness — works even if the processing session is a different Pi process)
    const existingSessionForChat = getSessionProcessingChat(message.chat.id);
    if (existingSessionForChat) targetSessionId = existingSessionForChat;
    
    // 3. @sessionName prefix → forward via relay (relay sends final reply to Telegram)
    const text = message.text || message.caption || "";
    const sessionTagMatch = text.match(/^@(\S+)\s*/);
    if (sessionTagMatch) {
      const targetName = sessionTagMatch[1];
      const registry = await readSessionRegistry();
      const targetSession = registry.sessions.find(s => s.sessionName === targetName);

      if (targetSession) {
        // Mark message as processing in DB before forwarding
        try {
          Db.getDb().prepare(
            "UPDATE message_queue SET session_id = ?, session_name = ?, status = 'processing', started_at = ? WHERE id = ?"
          ).run(targetSession.sessionId, targetName, Date.now(), dbId);
        } catch {}

        // Forward via relay — data-scrapper processes and sends reply directly to Telegram
        const relayPath = join(process.env.HOME || "~", ".pi/agent/tmp/teleg-relay", `${targetName}.json`);
        if (existsSync(relayPath)) {
          try {
            const relayInfo = JSON.parse(readFileSync(relayPath, "utf8"));
            try { process.kill(relayInfo.pid, 0); } catch {
              try {
                Db.getDb().prepare(
                  "UPDATE message_queue SET status = 'failed', error = ? WHERE id = ?"
                ).run(`Session "${targetName}" not running`, dbId);
              } catch {}
              return;
            }
            // Clean text (without @prefix) for relay
            const cleanText = text.replace(sessionTagMatch[0], "").trim();
            const res = await fetch(`http://127.0.0.1:${relayInfo.port}/command`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chatId: message.chat.id,
                messageId: message.message_id,
                text: cleanText,
                secret: relayInfo.secret,
                sourceSession: process.cwd().split("/").filter(Boolean).pop() || "teleg",
              }),
            });
            // Forward-and-forget: data-scrapper calls /complete when done processing.
            // We don't wait for a response here — the relay's /complete endpoint handles cleanup.
            return;
          } catch (err) {
            try {
              Db.getDb().prepare(
                "UPDATE message_queue SET status = 'failed', error = ? WHERE id = ?"
              ).run(String(err), dbId);
            } catch {}
            return;
          }
        } else {
          try {
            Db.getDb().prepare(
              "UPDATE message_queue SET status = 'failed', error = ? WHERE id = ?"
            ).run(`Session "${targetName}" relay not found`, dbId);
          } catch {}
          return;
        }
      } else {
        try {
          Db.getDb().prepare(
            "UPDATE message_queue SET status = 'failed', error = ? WHERE id = ?"
          ).run(`Session "${targetName}" not found`, dbId);
        } catch {}
        return;
      }
    }

    // 4. Capability-based smart routing
    if (!targetSessionId) {
      const capReg = await readCapabilitiesRegistry();
      if (capReg.entries.length > 0) {
        const matched = matchMessageToCapability(text || "", capReg.entries);
        if (matched) {
          try {
            process.kill(matched.pid, 0);
            const sessReg = await readSessionRegistry();
            const sessInfo = sessReg.sessions.find(s => s.sessionId === matched.sessionId);
            if (sessInfo) targetSessionId = matched.sessionId;
          } catch { /* dead session */ }
        }
      }
    }
    
    // Phase 5: Scope routing by bot_id, call reconcile before primary fallback
    const botId = SharedPollingManager.getBotId();
    
    // 5. Fallback to primary session (scoped by bot_id)
    if (!targetSessionId) {
      // Phase 5: Reconcile sessions before primary fallback - evict ghosts and re-elect
      if (botId) {
        const report = await reconcileSessions(botId).catch(() => null);
        if (report?.evictedSessions.length) {
          console.log(`[teleg] Evicted during routing: ${report.evictedSessions.join(", ")}`);
        }
      }
      const registry = await readSessionRegistry();
      // Phase 5: Filter by bot_id and prefer linked sessions
      const sameBotSessions = registry.sessions.filter(s => {
        if (botId && s.botId !== botId) return false;
        // Check if session is linked
        return true; // Will be verified in the dispatch step below
      });
      // Prefer primary session for this bot
      const primaryName = botId ? registry.primaryByBot?.[String(botId)] : null;
      const primarySession = primaryName 
        ? sameBotSessions.find(s => s.sessionName === primaryName)
        : null;
      if (primarySession) targetSessionId = primarySession.sessionId;
      else if (sameBotSessions.length > 0) targetSessionId = sameBotSessions[0].sessionId;
    }
    
    // Dispatch — route to the target session.
    // "Active turns" tracked in DB (source of truth for cross-process awareness)
    // and in-memory Map (fast path for current process). See hasActiveTurnInDb().
    if (targetSessionId) {
      const reg = await readSessionRegistry();
      const sessionInfo = reg.sessions.find(s => s.sessionId === targetSessionId);
      const sName = sessionInfo?.sessionName || targetSessionId;
      const turn = createTurn(targetSessionId, sName, message);
      turn.dbId = dbId; // Track the DB row ID
      
      // If the target session is already busy (check DB for cross-process accuracy),
      // mark preferred session and let it claim when free. No in-memory queue.
      const dbBusy = hasActiveTurnInDb(targetSessionId);
      if (dbBusy) {
        try {
          Db.getDb().prepare(
            "UPDATE message_queue SET session_id = ?, session_name = ? WHERE id = ? AND status = 'pending'"
          ).run(targetSessionId, sName, dbId);
        } catch {}
        return;
      }
      
      activeTurns.set(targetSessionId, turn as ActiveTelegramTurn);
      
      // Update SQLite to processing
      try {
        Db.getDb().prepare(
          "UPDATE message_queue SET session_id = ?, session_name = ?, status = 'processing', started_at = ? WHERE id = ?"
        ).run(targetSessionId, sName, Date.now(), dbId);
      } catch {}
      
      // Fire message handler — non-blocking. Each session processes concurrently.
      if (messageHandler) messageHandler(turn, update);
    } else {
      // No target session — leave unassigned in DB
      try {
        Db.getDb().prepare(
          "UPDATE message_queue SET session_id = 'unassigned', session_name = 'unknown' WHERE id = ?"
        ).run(dbId);
      } catch {}
      if (messageHandler) {
        const turn = createTurn("unassigned", "unknown", message);
        messageHandler(turn, update);
      }
    }
  }
  
  // ─── Worker Thread Management ────────────────────────────────────────
  
  function spawnPollWorker(): void {
    if (pollWorker) return;
    
    pollWorker = new Worker(POLL_WORKER_PATH, {
      workerData: {
        dbPath: join(homedir(), ".pi", "agent", "teleg-bridge.db"),
        pollTimeoutSeconds: POLL_TIMEOUT_SECONDS,
        healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
        maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
        initialReconnectDelayMs: INITIAL_RECONNECT_DELAY_MS,
        maxReconnectDelayMs: MAX_RECONNECT_DELAY_MS,
      },
    });
    
    pollWorker.on("message", (msg: { type: string; update?: TelegramUpdate; dbId?: number; healthy?: boolean; consecutiveErrors?: number; error?: string }) => {
      switch (msg.type) {
        case "message":
          if (msg.update && msg.dbId) {
            handleWorkerMessage(msg.update, msg.dbId).catch(err => {
              console.error("[teleg-pm] Dispatch error:", err);
            });
          }
          break;
        case "health":
          if (msg.healthy !== undefined) pollState.isHealthy = msg.healthy;
          if (msg.consecutiveErrors !== undefined) pollState.consecutiveErrors = msg.consecutiveErrors;
          break;
        case "error":
          console.error(`[teleg-pm] Poll worker error: ${msg.error}`);
          break;
      }
    });
    
    pollWorker.on("error", (err) => {
      console.error("[teleg-pm] Poll worker crashed:", err);
      pollWorker = null;
      isPolling = false;
      if (config.botToken) {
        setTimeout(() => {
          console.log("[teleg-pm] Attempting poll worker restart...");
          startPolling().catch(e => console.error("[teleg-pm] Restart failed:", e));
        }, 5000);
      }
    });
    
    pollWorker.on("exit", (code) => {
      if (code !== 0) console.error(`[teleg-pm] Poll worker exited with code ${code}`);
      pollWorker = null;
      isPolling = false;
    });
  }
  
  async function startPolling(): Promise<void> {
    if (!config.botToken || isPolling) return;
    const hasLock = await acquirePollingLock();
    if (!hasLock) return;
    
    isPolling = true;
    lockRefreshInterval = setInterval(refreshPollingLock, POLLING_LOCK_REFRESH_MS);
    
    spawnPollWorker();
    pollWorker!.postMessage({
      type: "start",
      config: { botToken: config.botToken, lastUpdateId: config.lastUpdateId },
    });
  }
  
  async function stopPolling(): Promise<void> {
    if (pollWorker) {
      pollWorker.postMessage({ type: "stop" });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { pollWorker?.terminate(); resolve(); }, 3000);
        pollWorker!.once("exit", () => { clearTimeout(timeout); resolve(); });
        pollWorker!.once("message", (msg: { type: string }) => {
          if (msg.type === "stopped") { clearTimeout(timeout); resolve(); }
        });
      });
      pollWorker = null;
    }
    isPolling = false;
    await releasePollingLock();
  }
  
  // ─── Public API ──────────────────────────────────────────────────────
  
  return {
    setBotContextRef,
    getBotId,
    async init(): Promise<void> { config = await readConfig(); },
    
    async updateConfig(newConfig: TelegramConfig): Promise<void> {
      config = newConfig;
      await writeConfig(config);
      if (pollWorker) {
        pollWorker.postMessage({ type: "update_config", config: { lastUpdateId: newConfig.lastUpdateId } });
      }
    },
    
    async start(): Promise<void> {
      await this.init();
      if (!isPolling && config.botToken) await startPolling();
    },
    
    async stop(): Promise<void> { await stopPolling(); },
    isActive(): boolean { return isPolling; },
    isHeldByOther(): boolean { return isPollingLockHeldByOther(); },
    getState(): PollState { return { ...pollState }; },
    
    onMessage(handler: (turn: PendingTelegramTurn, update: TelegramUpdate) => void): void {
      messageHandler = handler;
    },

    /**
     * Complete a specific message by ID, then cleanup orphans.
     * @param sessionId - The session completing the message
     * @param dbId - The specific message ID to mark completed (optional, resets all if omitted)
     */
    completeTurn(sessionId: string, dbId?: number): void {
      activeTurns.delete(sessionId);
      try {
        if (typeof dbId === 'number') {
          // Mark ONLY this specific message as completed
          Db.getDb().prepare(
            "UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'processing'"
          ).run(Date.now(), dbId);
        } else {
          // No dbId — this happens on crash recovery paths.
          // Reset ALL processing messages to pending so they re-drain.
          Db.getDb().prepare(
            "UPDATE message_queue SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL WHERE session_id = ? AND status = 'processing'"
          ).run(sessionId);
        }
      } catch (err) {
        console.error("[teleg-pm] completeTurn error:", err);
      }
    },

    hasActiveTurnFor(sessionId: string): boolean {
      // DB is source of truth (cross-process), in-memory is a fast shortcut for current process
      if (hasActiveTurnInDb(sessionId)) return true;
      return activeTurns.has(sessionId);
    },

    getProcessingDbIds(sessionId: string): number[] {
      return getProcessingMessageIds(sessionId);
    },

    claimNextTurn(sessionId: string, sName?: string): TurnQueueItem | null {
      // Source of truth is SQLite — any session can atomically claim any pending message.
      // The DB's claimNextMessage prevents race conditions across processes.
      const name = sName || "unknown";
      const botId = getBotId();
      const dbMsg = Db.claimNextMessage(botId, sessionId, name);
      if (dbMsg) {
        const turn: PendingTelegramTurn = {
          sessionId, sessionName: name,
          chatId: dbMsg.chat_id, replyToMessageId: dbMsg.message_id,
          queuedAttachments: [],
          content: [{ type: "text", text: `${TELEGRAM_PREFIX} ${dbMsg.text}` }],
          historyText: dbMsg.text,
          dbId: dbMsg.id, // Track the DB row ID
        };
        activeTurns.set(sessionId, turn as ActiveTelegramTurn);
        const syntheticUpdate: TelegramUpdate = {
          update_id: dbMsg.id,
          message: {
            message_id: dbMsg.message_id,
            from: { id: dbMsg.from_user_id, is_bot: false, first_name: dbMsg.from_username || "User" },
            chat: { id: dbMsg.chat_id, type: "private" },
            text: dbMsg.text,
          },
        };
        return { turn, update: syntheticUpdate, dbId: dbMsg.id };
      }
      return null;
    },

    getQueueDepth(): number {
      const botId = getBotId();
      try { return Db.getQueueDepth(botId); } catch { return 0; }
    },

    /**
     * Claim the next pending message strictly for this session.
     * Does NOT claim unassigned messages — for sessions to actively monitor their own queue.
     */
    claimNextTurnForSession(sessionName: string): TurnQueueItem | null {
      const botId = getBotId();
      const dbMsg = Db.claimNextMessageForSession(botId, sessionName);
      if (dbMsg) {
        const sessionId = `__session__:${sessionName}`;
        const turn: PendingTelegramTurn = {
          sessionId, sessionName,
          chatId: dbMsg.chat_id, replyToMessageId: dbMsg.message_id,
          queuedAttachments: [],
          content: [{ type: "text", text: `${TELEGRAM_PREFIX} ${dbMsg.text}` }],
          historyText: dbMsg.text,
          dbId: dbMsg.id,
        };
        activeTurns.set(sessionId, turn as ActiveTelegramTurn);
        return {
          turn,
          update: {
            update_id: dbMsg.id,
            message: {
              message_id: dbMsg.message_id,
              from: { id: dbMsg.from_user_id, is_bot: false, first_name: dbMsg.from_username || "User" },
              chat: { id: dbMsg.chat_id, type: "private" },
              text: dbMsg.text,
            },
          },
          dbId: dbMsg.id,
        };
      }
      return null;
    },

    /**
     * Get count of pending messages for this session (for status display).
     */
    getPendingCountForSession(sessionName: string): number {
      const botId = getBotId();
      try { return Db.getPendingCountForSession(botId, sessionName); } catch { return 0; }
    },

    isUserAllowed(userId: number): boolean { return isAllowedUser(config, userId); },
    
    async addAllowedUser(userId: number): Promise<void> {
      if (!config.allowedUserIds) config.allowedUserIds = [];
      if (!config.allowedUserIds.includes(userId)) { config.allowedUserIds.push(userId); await writeConfig(config); }
    },
    
    getBotInfo(): { username?: string; id?: number } { return { username: config.botUsername, id: config.botId }; },
    
    async sendReply(chatId: string, replyToMsgId: number, text: string): Promise<number | undefined> {
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
      const MAX_SEND_RETRIES = 2;
      for (const chunk of chunks) {
        for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
          try {
            const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
              chat_id: chatId, text: chunk,
              ...(replyToMsgId ? { reply_to_message_id: replyToMsgId } : {}),
            }, { timeout: 15000 });
            lastMessageId = sent.message_id;
            break; // success, move to next chunk
          } catch (err) {
            if (attempt < MAX_SEND_RETRIES) {
              console.error(`[teleg] sendReply failed (attempt ${attempt}/${MAX_SEND_RETRIES}), retrying...`);
              await new Promise(r => setTimeout(r, attempt * 2000));
            } else {
              console.error(`[teleg] sendReply failed after ${MAX_SEND_RETRIES} attempts:`, err instanceof Error ? err.message : err);
            }
          }
        }
      }
      return lastMessageId;
    },
    
    async sendFile(chatId: string, replyToMsgId: number, filePath: string, fileName: string, isImage: boolean, caption?: string): Promise<boolean> {
      if (!config.botToken) { console.error("[teleg] sendFile: no botToken configured"); return false; }
      // Use curl for file uploads — node fetch is unreliable for large POST bodies
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
            `https://api.telegram.org/bot${config.botToken}/${method}`,
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
            console.error(`[teleg] sendFile API error (attempt ${attempt}/${MAX_RETRIES}):`, result.error);
            if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, attempt * 2000)); continue; }
            return false;
          }
          return true;
        } catch (err) {
          console.error(`[teleg] sendFile failed (attempt ${attempt}/${MAX_RETRIES}):`, err instanceof Error ? err.message : err);
          if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, attempt * 3000)); continue; }
          return false;
        }
      }
      return false;
    },
    
    async verifyToken(token: string): Promise<TelegramUser | null> {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
        if (data.ok && data.result) return data.result;
        return null;
      } catch { return null; }
    },
  };
})();
// ============================================================================
// Pending Forward (relay commands awaiting agent processing)
// ============================================================================

interface PendingForward {
  chatId: number;
  messageId: number;
  text: string;
  sourceSession: string;
}

const pendingForwards: PendingForward[] = [];

// ============================================================================
// Session State
// ============================================================================

interface SessionState {
  sessionId: string;
  botContext: BotContext | undefined; // Resolved bot context (Phase 1)
  config: TelegramConfig;
  activeTurn: ActiveTelegramTurn | undefined;
  typingInterval: ReturnType<typeof setInterval> | undefined;
  drainTimer: ReturnType<typeof setInterval> | undefined; // Phase 6: idle queue drain
  setupInProgress: boolean;
}

function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    botContext: undefined, // Will be set in session_start after resolveBotContext
    config: {},
    activeTurn: undefined,
    typingInterval: undefined,
    drainTimer: undefined, // Phase 6: idle queue drain
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
      if (SharedPollingManager.isHeldByOther()) {
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
    
    // Remove sessions that are older than 1 hour (no heartbeat)
    const oneHourAgo = Date.now() - 3600000;
    registry.sessions = registry.sessions.filter(s => s.lastActivity > oneHourAgo);
    
    // Clean stale relay files for dead PIDs to match registry with reality
    cleanStaleRelayFiles();
    
    // Actively purge orphaned sessions: check PID liveness directly.
    // This removes stale entries from crashes immediately instead of waiting 1 hour.
    // Keeps: current session, and any session whose PID is still alive (other Pi processes).
    registry.sessions = registry.sessions.filter(s => {
      if (s.sessionId === sessionId) return true;        // always keep ourselves
      try {
        process.kill(s.pid, 0);                            // check if PID alive
        return true;                                       // another session is still running
      } catch {
        return false;                                      // PID dead → remove
      }
    });
    
    const existing = registry.sessions.findIndex(s => s.sessionId === sessionId);
    const sessionInfo: SessionInfo = {
      sessionId,
      sessionName,
      pid: process.pid,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      isActive: true,
      botId: state.botContext?.botId, // Phase 4: link session to bot
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
    
    // Phase 4: Primary election per bot_id
    const botId = state.botContext?.botId;
    if (botId) {
      // If no primary exists for this bot, elect this session
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
    
    // Clean up ALL relay files belonging to our PID (handles stale duplicates from crashes)
    cleanRelayFilesByPid(process.pid);
    
    // Also clean any other stale relay files for dead PIDs
    cleanStaleRelayFiles();
    
    if (registry.primarySessionId === sessionId && registry.sessions.length > 0) {
      registry.primarySessionId = registry.sessions[0].sessionId;
    }
    
    // Phase 4: Clean up primaryByBot entry for this session's bot
    const botId = state.botContext?.botId;
    if (botId && registry.primaryByBot) {
      const key = String(botId);
      if (registry.primaryByBot[key] === sessionId) {
        // Elect new primary from remaining sessions for this bot
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
    
    // Phase 4: Also update DB heartbeat for SQLite-backed registry
    const botId = state.botContext?.botId;
    if (botId) {
      Db.heartbeatRelaySession(botId, sessionName);
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
      // Mark the DB row as belonging to the target session BEFORE forwarding.
      // This ensures /queue reports accurately even when the forward is async.
      // (The message will be in the target session's queue in the DB.)
      // Note: the actual claim/processing happens in the target session's relay handler.
      try {
        Db.getDb().prepare(
          "UPDATE message_queue SET session_name = ?, session_id = ? WHERE chat_id = ? AND message_id = ? AND status = 'pending'"
        ).run(targetSessionName, targetSessionName, message.chat.id, message.message_id);
      } catch {}
      
      // Forward command to the target session via relay
      const forwardResult = await forwardToSession(
        targetSessionName,
        cleanText,
        { chatId: message.chat.id, messageId: message.message_id, sourceSession: sessionName },
      );
      if (forwardResult.ok) {
        // Target session processed the command — send its response to Telegram
        if (forwardResult.response) {
          await SharedPollingManager.sendReply(
            String(message.chat.id),
            message.message_id,
            forwardResult.response,
          );
        }
        // If forward was successful but no response body, just acknowledge silently
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
        const turnDbId = state.activeTurn.dbId;
        state.activeTurn = undefined;
        SharedPollingManager.completeTurn(sessionId, turnDbId);
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
/status - All sessions, relay state & queue
/queue [session] - Queue for session (or primary)
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
      const botId = SharedPollingManager.getBotId();
      const queueStats = botId ? Db.getQueueStats(botId) : Db.getQueueStats();
      const relaySessions = botId ? Db.getAliveRelaySessions(botId) : Db.getAliveRelaySessions();
      const relayStatus = await getRelayStatus();
      
      let pollingStatus: string;
      if (SharedPollingManager.isActive()) {
        pollingStatus = "✅ active";
      } else if (SharedPollingManager.isHeldByOther()) {
        pollingStatus = "🔁 passive";
      } else {
        pollingStatus = "⏹ stopped";
      }
      
      const lines: string[] = [
        `<b>═══ Teleg Bridge Status ═══</b>`,
        ``,
        `🤖 <b>Bot:</b> ${botInfo.username ? `@${botInfo.username}` : "not configured"}`,
        `📡 <b>Polling:</b> ${pollingStatus}`,
        `💚 <b>Health:</b> ${pollState.isHealthy ? "OK" : `DEGRADED (${pollState.consecutiveErrors} errs)`}`,
        ``,
        `<b>📊 Queue:</b> ${queueStats.pending} pending · ${queueStats.processing} active · ${queueStats.completed} done · ${queueStats.failed} failed`,
        ``,
        `<b>🖥 Sessions (${registry.sessions.length}):</b>`,
      ];
      
      // Detailed session info from SQLite relay + registry
      for (const s of registry.sessions) {
        const isSelf = s.sessionId === sessionId;
        const hasActiveTurn = SharedPollingManager.hasActiveTurnFor(s.sessionId);
        const role = s.sessionId === sessionId
          ? (SharedPollingManager.isActive() ? "active" : "passive")
          : "relay";
        const relayInfo = relaySessions.find(r => r.session_name === s.sessionName);
        const relayAlive = relayStatus[s.sessionName]?.alive ?? false;
        const capabilities = relayInfo?.capabilities ? JSON.parse(relayInfo.capabilities).join(", ") : "—";
        const capReg = await readCapabilitiesRegistry();
        const capEntry = capReg.entries.find(e => e.sessionName === s.sessionName);
        const caps = capEntry?.capabilities?.join(", ") || capabilities || "—";
        
        // Get per-session queue stats from DB
        const sessPending = Db.getDb().prepare(
          "SELECT COUNT(*) as c FROM message_queue WHERE session_name = ? AND status IN ('pending','processing')"
        ).get(s.sessionName) as { c: number };
        const sessDone = Db.getDb().prepare(
          "SELECT COUNT(*) as c FROM message_queue WHERE session_name = ? AND status = 'completed'"
        ).get(s.sessionName) as { c: number };
        
        const statusIcon = hasActiveTurn ? "●" : (relayAlive ? "○" : "✗");
        const selfTag = isSelf ? " ← you" : "";
        const activeTag = hasActiveTurn ? " ⚡ busy" : "";
        const relayTag = !relayAlive && !isSelf ? " 🔴 offline" : "";
        
        lines.push(`  ${statusIcon} <b>${s.sessionName}</b> [${role}]${activeTag}${relayTag}${selfTag}`);
        lines.push(`    caps: ${caps}`);
        lines.push(`    queue: ${sessPending.c} pending · ${sessDone.c} done · pid:${s.pid}`);
      }
      
      await SharedPollingManager.sendReply(String(message.chat.id), message.message_id, lines.join("\n"));
      return;
    }
    
    if (lower.startsWith("/queue")) {
      const parts = cleanText.trim().split(/\s+/);
      const targetName = parts.length > 1 ? parts[1] : sessionName;
      
      // Find the session name from registry if not this session
      const registry = await readSessionRegistry();
      const targetSession = registry.sessions.find(s => s.sessionName === targetName);
      
      if (!targetSession && targetName !== sessionName) {
        await SharedPollingManager.sendReply(
          String(message.chat.id),
          message.message_id,
          `❌ Session "${targetName}" not found. Active: ${registry.sessions.map(s => s.sessionName).join(", ")}`
        );
        return;
      }
      
      const d = Db.getDb();
      const stats = d.prepare(`
        SELECT status, COUNT(*) as c FROM message_queue WHERE session_name = ? GROUP BY status
      `).all(targetName) as Array<{ status: string; c: number }>;
      
      const pending = stats.find(s => s.status === "pending")?.c || 0;
      const processing = stats.find(s => s.status === "processing")?.c || 0;
      const completed = stats.find(s => s.status === "completed")?.c || 0;
      const failed = stats.find(s => s.status === "failed")?.c || 0;
      
      // Get recent messages for this session
      const recent = d.prepare(`
        SELECT id, text, status, created_at, completed_at, error FROM message_queue
        WHERE session_name = ? ORDER BY id DESC LIMIT 10
      `).all(targetName) as Array<{ id: number; text: string; status: string; created_at: number; completed_at: number | null; error: string | null }>;
      
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
      
      if (recent.length === 0) {
        lines.push("  (empty)");
      }
      
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
      if (!targetChatId) {
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const result = await SharedPollingManager.sendReply(String(targetChatId), 0, params.text);
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
      if (!targetChatId) {
        console.error("[teleg] send_photo: no targetChatId, allowedUserIds=", state.config.allowedUserIds);
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const stats = await stat(params.file_path);
      if (!stats.isFile()) {
        console.error("[teleg] send_photo: not a file:", params.file_path);
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
        console.error("[teleg] send_photo: sendFile returned false for", params.file_path);
        throw new Error("Failed to send photo");
      }
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
      if (!targetChatId) {
        console.error("[teleg] send_video: no targetChatId, allowedUserIds=", state.config.allowedUserIds);
        throw new Error("No chat ID available. Send /start to pair first.");
      }
      const stats = await stat(params.file_path);
      if (!stats.isFile()) {
        console.error("[teleg] send_video: not a file:", params.file_path);
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
        console.error("[teleg] send_video: sendFile returned false for", params.file_path);
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
    name: "get_queue_count",
    label: "Get Queue Count",
    description: "Get the number of pending and processing messages in the queue",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const botId = SharedPollingManager.getBotId();
      const Db = await import("./db.js");
      const depth = Db.getQueueDepth(botId);
      return { content: [{ type: "text", text: `Queue depth: ${depth}` }], details: { count: depth } };
    },
  });

  pi.registerTool({
    name: "get_queue_stats",
    label: "Get Queue Stats",
    description: "Get full queue statistics for messages and downloads",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params) {
      const botId = SharedPollingManager.getBotId();
      const Db = await import("./db.js");
      const stats = botId ? Db.getQueueStats(botId) : Db.getQueueStats();
      const dlStats = botId ? Db.getDownloadStats(botId) : Db.getDownloadStats();
      const text = `Messages: ${stats.pending} pending · ${stats.processing} processing · ${stats.completed} completed · ${stats.failed} failed\nDownloads: ${dlStats.pending} pending · ${dlStats.processing} processing · ${dlStats.completed} completed · ${dlStats.failed} failed`;
      return { content: [{ type: "text", text }], details: { messages: stats, downloads: dlStats } };
    },
  });

  pi.registerTool({
    name: "get_queue_data",
    label: "Get Queue Data",
    description: "Get queue messages data. Returns recent queue messages with optional limit.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 20)" })),
      status: Type.Optional(Type.String({ description: "Filter by status: pending, processing, completed, failed" })),
    }),
    async execute(_toolCallId, params) {
      const Db = await import("./db.js");
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
    parameters: Type.Object({
      id: Type.Number({ description: "Queue message ID" }),
    }),
    async execute(_toolCallId, params) {
      const Db = await import("./db.js");
      const row = Db.getDb().prepare(`SELECT * FROM message_queue WHERE id = ?`).get(params.id) as Record<string, unknown> | undefined;
      if (!row) {
        return { content: [{ type: "text", text: `No message found with id ${params.id}` }], details: { row: null as unknown } };
      }
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }], details: { row: row as unknown } };
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
      const Db = await import("./db.js");
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
    description: "Queue one or more local files to be sent with the next Telegram reply.",
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
  // Backlog / Queue Management
  // ========================================================================

  pi.registerTool({
    name: "teleg-clear_backlog",
    label: "Clear Telegram Backlog",
    description: "Clear/reset the message backlog queue. Use 'reset' to unstick stale processing messages, 'purge' to delete old completed/failed entries, or 'complete' to manually mark a message done.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("reset"), Type.Literal("purge"), Type.Literal("complete"), Type.Literal("fail"), Type.Literal("delete")], {
        description: "Action: 'reset' = unstick stuck processing→pending, 'purge' = delete old completed/failed entries, 'complete' = mark a message completed, 'fail' = mark a message failed, 'delete' = delete pending messages (all or by id)",
      }),
      id: Type.Optional(Type.Number({ description: "Message ID (required for complete/fail actions)" })),
      keep_count: Type.Optional(Type.Number({ description: "How many completed/failed entries to keep on purge (default 500)" })),
    }),
    async execute(_toolCallId, params) {
      const Db = await import("./db.js");
      let count = 0;
      let id: number | undefined;
      switch (params.action) {
        case "reset": {
          count = Db.resetAllProcessing();
          break;
        }
        case "purge": {
          const keep = params.keep_count ?? 500;
          count = Db.purgeOldMessages(keep);
          break;
        }
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
          // Delete pending messages for a specific session, or all pending if no id given
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

  // ========================================================================
  // Session Events
  // ========================================================================

  // Register process signal handlers for graceful cleanup on kill/quit.
  // These ensure relay files and session registry are cleaned even if pi is killed
  // before session_shutdown fires.
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
    
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
      if (!registered.has(sig)) {
        registered.add(sig);
        process.on(sig as NodeJS.Signals, () => {
          cleanup();
        });
      }
    }
  }
  
  registerCleanupHandlers();

  pi.on("session_start", async (_event, ctx) => {
    // Run SQLite startup recovery (recover stale messages, clean dead sessions)
    const recovery = Db.runStartupRecovery();
    if (recovery.recoveredMessages > 0 || recovery.cleanedSessions > 0 || (recovery.mergedFromLocal ?? 0) > 0) {
      console.log(`[teleg:${sessionName}] DB recovery: ${recovery.recoveredMessages} messages recovered, ${recovery.cleanedSessions} stale sessions cleaned, ${recovery.mergedFromLocal ?? 0} session names merged from local DBs`);
    }
    
    // Phase 1: Resolve bot context (multi-bot support)
    // This must happen before any polling or DB access.
    try {
      state.botContext = await resolveBotContext(cwd);
      console.log(`[teleg:${sessionName}] Bot context resolved: @${state.botContext.botUsername} (id=${state.botContext.botId})`);
      
      // Wire bot context into SharedPollingManager so queue ops are scoped
      SharedPollingManager.setBotContextRef(state);
      
      // Check for split DB warning
      const splitDbWarning = await detectSplitDb(state.botContext.botId, state.botContext.dbPath);
      if (splitDbWarning) {
        console.warn(`[teleg:${sessionName}] ${splitDbWarning}`);
      }
    } catch (err) {
      console.error(`[teleg:${sessionName}] Failed to resolve bot context: ${err}`);
      console.error("[teleg] Set TELEG_BOT_TOKEN, TELEG_BOT_ID, or configure .pi/teleg.json");
      // Continue without bot context — some tools (relay) may still work
    }
    
    await SharedPollingManager.init();
    state.config = await readConfig();
    await mkdir(TEMP_DIR, { recursive: true });
    await registerSession();

    // Phase 5: Reconcile sessions on startup - evict ghosts and ensure primary is elected
    const botId = state.botContext?.botId;
    if (botId) {
      const report = await reconcileSessions(botId);
      if (report.evictedSessions.length > 0) {
        console.log(`[teleg:${sessionName}] Evicted ghost sessions: ${report.evictedSessions.join(", ")}`);
      }
      if (report.newPrimary) {
        console.log(`[teleg:${sessionName}] Primary elected: ${report.newPrimary}`);
      }
    }

    // Announce presence ONCE per session (not on reconnections)
    const registry1 = await readSessionRegistry();
    const sessInfo = registry1.sessions.find(s => s.sessionId === sessionId);
    if (sessInfo && !sessInfo.announcedPresence) {
      const chatId = state.config.allowedUserIds?.[0];
      if (chatId && state.config.botToken) {
        // Determine if this session will be active poller or passive
        const isActivePoller = SharedPollingManager.isActive() || !SharedPollingManager.isHeldByOther();
        const icon = isActivePoller ? "✅" : "🔁";
        const role = isActivePoller ? "active" : "passive";
        try {
          await fetch(`https://api.telegram.org/bot${state.config.botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `${icon} <b>${sessionName}</b> connected (${role})`, parse_mode: "HTML" }),
          });
        } catch {
          // Network unavailable — skip announcement, extension still loads
        }
      }
      sessInfo.announcedPresence = true;
      await writeSessionRegistry(registry1);
    }

    // Register session capabilities
    await cleanStaleCapabilities();
    await registerSessionCapabilities(sessionId, sessionName, process.pid, cwd).catch(
      (err: unknown) => console.error('[teleg:' + sessionName + '] Failed to register capabilities:', err)
    );

    // Start the relay server for inter-session command forwarding
    // Phase 4: Pass botId so relay file is linked to a specific bot
    const relayBotId = state.botContext?.botId;
    await startRelayServer(sessionName, 9798, relayBotId).catch(console.error);
    
    // Phase 4: Register in SQLite relay_sessions table with bot_id
    if (relayBotId) {
      Db.registerRelaySession({
        bot_id: relayBotId,
        session_name: sessionName,
        session_id: sessionId,
        pid: process.pid,
        port: 9798, // Will be updated when relay server resolves actual port
        secret: "", // Will be updated when relay server resolves
      });
    }
    
    setCommandHandler(async (text, meta) => {
      // Queue the forward for agent processing on next turn
      pendingForwards.push({
        chatId: meta.chatId,
        messageId: meta.messageId,
        text,
        sourceSession: meta.sourceSession || "unknown",
      });
      // Create a turn as if it came from Telegram to trigger agent processing.
      // Use deliverAs:"steer" to interrupt if the agent is mid-stream — the forwarded
      // command is higher priority since it was explicitly routed via @sessionName.
      const turn: PendingTelegramTurn = {
        sessionId,
        sessionName,
        chatId: meta.chatId,
        replyToMessageId: meta.messageId,
        queuedAttachments: [],
        content: [{ type: "text" as const, text: `${TELEGRAM_PREFIX} ${text}` }] as Array<TextContent | ImageContent>,
        historyText: text,
      };
      state.activeTurn = turn as ActiveTelegramTurn;
      try {
        pi.sendUserMessage(turn.content, { deliverAs: "steer" });
      } catch {
        // Agent is busy streaming — leave the message in the DB queue.
        // It will be claimed via claimNextTurn when the current turn completes.
        state.activeTurn = undefined;
        SharedPollingManager.completeTurn(sessionId);
        SharedPollingManager.claimNextTurn(sessionId, sessionName);
      }
      // Return placeholder — the actual response is sent directly to Telegram from agent_end
      return `[${sessionName}] Processing...`;
    });

    setCompleteHandler((id, sourceSession) => {
      // Called by the relay when the target session signals completion.
      // We look up the message_queue entry by (sourceSession, id) and mark it complete.
      if (!sourceSession || sourceSession === "unknown") return;
      try {
        const db = Db.getDb();
        const row = db.prepare(
          "SELECT id FROM message_queue WHERE session_name = ? AND id = ?"
        ).get(sourceSession, id) as { id: number } | undefined;
        if (row) {
          db.prepare(`UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ?`)
            .run(Date.now(), row.id);
        }
      } catch (err) {
        console.error("[teleg] complete handler error:", err);
      }
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
    
    setInterval(async () => {
      await heartbeatSession();
      // Phase 5: Reconcile sessions periodically to evict ghosts and maintain primary
      if (botId) {
        await reconcileSessions(botId).catch((err) =>
          console.error(`[teleg:${sessionName}] Reconcile failed:`, err)
        );
      }
      if (!SharedPollingManager.isActive() && state.config.botToken) {
        if (SharedPollingManager.isHeldByOther()) {
          // Another process is actively polling — stay passive, no retry needed
          return;
        }
        // No lock holder — try to claim the polling lock
        console.log(`[teleg:${sessionName}] Polling inactive, auto-restarting...`);
        await SharedPollingManager.start().catch((err) =>
          console.error(`[teleg:${sessionName}] Auto-restart failed:`, err)
        );
      }
    }, 30000);

    // Phase 6: Active idle drain timer — check queue periodically when idle
    state.drainTimer = setInterval(async () => {
      // Only drain if session is idle (no active agent turn)
      if (state.activeTurn) return;

      const botId = state.botContext?.botId;
      if (!botId) return;

      try {
        // Priority 1: pendingForwards (relay commands) — already checked in drainOne
        // but we check here for completeness

        // Priority 2: Claim our own session's messages (session-strict)
        const queued = SharedPollingManager.claimNextTurnForSession(sessionName);
        if (queued) {
          state.activeTurn = queued.turn as ActiveTelegramTurn;
          pi.sendUserMessage(queued.turn.content, { deliverAs: "steer" });
          return;
        }

        // Priority 3: Claim unassigned messages for the same bot (cross-session help)
        const queueMsg = SharedPollingManager.claimNextTurn(sessionId, sessionName);
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
  
  pi.on("session_shutdown", async (_event, _ctx) => {
    // Phase 6: Clear drain timer
    if (state.drainTimer) {
      clearInterval(state.drainTimer);
      state.drainTimer = undefined;
    }
    state.activeTurn = undefined;
    pendingForwards.length = 0;
    SharedPollingManager.completeTurn(sessionId);
    stopRelayServer();
    
    // Announce departure ONCE (before unregister so we still have sessionName)
    const registry2 = await readSessionRegistry();
    const dying = registry2.sessions.find(s => s.sessionId === sessionId);
    if (dying && dying.announcedPresence) {
      const chatId = state.config.allowedUserIds?.[0];
      if (chatId && state.config.botToken) {
        const isActivePoller = SharedPollingManager.isActive() || !SharedPollingManager.isHeldByOther();
        const icon = isActivePoller ? "⚠️" : "🔁";
        const role = isActivePoller ? "active" : "passive";
        try {
          await fetch(`https://api.telegram.org/bot${state.config.botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: `${icon} <b>${sessionName}</b> disconnected (${role})`, parse_mode: "HTML" }),
          });
        } catch {
          // Network unavailable — skip
        }
      }
    }
    
    await unregisterSessionCapabilities(sessionId);
    await unregisterSession();
    
    // Phase 4: Also unregister from SQLite relay_sessions table
    const botId = state.botContext?.botId;
    if (botId) {
      Db.unregisterRelaySession(botId, sessionName);
    }
    
    const registry = await readSessionRegistry();
    if (registry.sessions.length === 0) {
      await SharedPollingManager.stop();
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
    return {
      systemPrompt: event.systemPrompt + promptSuffix,
    };
  });
  
  pi.on("agent_start", async (_event, ctx) => {
    if (!state.activeTurn) {
      const queued = SharedPollingManager.claimNextTurn(sessionId, sessionName);
      if (queued) {
        state.activeTurn = queued.turn as ActiveTelegramTurn;
      }
    }
    updateStatus(ctx);
  });
  
  pi.on("agent_end", async (event, ctx) => {
    const turn = state.activeTurn;
    state.activeTurn = undefined;
    // Pass dbId so only this specific message gets completed, not all processing messages
    SharedPollingManager.completeTurn(sessionId, turn?.dbId);
    updateStatus(ctx);
    
    let assistantText = "";
    let hasError = false;
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
    
    // Check for error indicators in messages (agent failed/crashed)
    for (const msg of event.messages as unknown as Array<{role: string; content?: unknown}>) {
      if (msg.role === "system" && typeof msg.content === "string") {
        const lower = msg.content.toLowerCase();
        if (lower.includes("error") || lower.includes("failed") || lower.includes("crash")) {
          hasError = true;
        }
      }
    }
    
    // Check if this turn was from a relay-forwarded command
    const forward = turn && pendingForwards.length > 0 ? pendingForwards.shift() : null;
    
    if (forward) {
      // Relay-forwarded: send response directly to Telegram with session tag
      const response = assistantText || "(no response)";
      const taggedResponse = `[<b>${sessionName}</b>]\n${response}`;
      try {
        await fetch(`https://api.telegram.org/bot${state.config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: forward.chatId,
            text: taggedResponse,
            reply_to_message_id: forward.messageId,
            parse_mode: "HTML",
          }),
        });
      } catch {
        // Best-effort delivery
        console.error(`[teleg:${sessionName}] Failed to deliver relay response:`, forward);
      }
      // Send attachments if any
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
            await fetch(`https://api.telegram.org/bot${state.config.botToken}/${method}`, {
              method: "POST",
              body: form,
            });
          } catch {}
        }
      }
    } else if (turn) {
      // Normal Telegram turn: send via polling manager
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
    }
    
    
    // ─── Active queue draining: continuously claim & process until queue is empty ───
    // This is the key change: sessions now actively monitor and process their own queue,
    // not waiting for manual triggers. This replaces "passive" with "active" behavior.
    
    /**
     * Drain one queued message: claim it, process it, return true if there was one.
     * Clears state.activeTurn after completion so the next call starts fresh.
     */
    const drainOne = async (): Promise<boolean> => {
      // 1. Pending forwards (relay commands from other sessions) — highest priority
      if (pendingForwards.length > 0 && !forward) {
        const next = pendingForwards.shift()!;
        const nextTurn: PendingTelegramTurn = {
          sessionId,
          sessionName,
          chatId: next.chatId,
          replyToMessageId: next.messageId,
          queuedAttachments: [],
          content: [{ type: "text" as const, text: `${TELEGRAM_PREFIX} ${next.text}` }] as Array<TextContent | ImageContent>,
          historyText: next.text,
        };
        state.activeTurn = nextTurn as ActiveTelegramTurn;
        updateStatus(ctx);
        pi.sendUserMessage(nextTurn.content, { deliverAs: "steer" });
        return true;
      }
      
      // 2. Claim our own pending messages (session-strict claiming)
      const queued = SharedPollingManager.claimNextTurnForSession(sessionName);
      if (queued) {
        state.activeTurn = queued.turn as ActiveTelegramTurn;
        updateStatus(ctx);
        pi.sendUserMessage(queued.turn.content, { deliverAs: "steer" });
        return true;
      }
      
      // 3. Fall back to unassigned/generic messages (cross-session help)
      const queueMsg = SharedPollingManager.claimNextTurn(sessionId, sessionName);
      if (queueMsg) {
        state.activeTurn = queueMsg.turn as ActiveTelegramTurn;
        updateStatus(ctx);
        pi.sendUserMessage(queueMsg.turn.content, { deliverAs: "steer" });
        return true;
      }
      
      return false;
    };
    
    // Drain while agent is idle and queue has messages
    if (await drainOne()) {
      // drainOne consumed one message and sent it to the agent.
      // The agent will complete and trigger another agent_end → we drain again.
      // No state.activeTurn cleanup here — agent_end will handle it on next iteration.
    } else {
      // Queue is empty — clean up
      state.activeTurn = undefined;
      updateStatus(ctx);
    }
  });
}