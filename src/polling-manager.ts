/**
 * Per-bot polling manager.
 *
 * Invariants:
 * - one manager per botId
 * - one lock per botId
 * - worker failures degrade to a stopped state, not silent corruption
 */

import { Worker } from "node:worker_threads";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile as readFileAsync, writeFile as writeFileAsync, rm as rmAsync } from "node:fs/promises";
import * as Db from "./db.js";
import { saveLastUpdateId } from "./config.js";
export interface PollState {
  consecutiveErrors: number;
  reconnectDelay: number;
  lastSuccessfulPoll: number;
  isHealthy: boolean;
  lastHealthCheck: number;
}

export interface BotInfo {
  botId: number;
  username: string | null;
  displayName: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramReactionType {
  type: string;
  emoji: string;
}

export interface TelegramMessageReactionUpdated {
  chat: TelegramChat;
  message_id: number;
  user?: TelegramUser;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  message_reaction?: TelegramMessageReactionUpdated;
}

export interface PendingTelegramTurn {
  sessionId: string;
  sessionName: string;
  chatId: number;
  replyToMessageId: number;
  queuedAttachments: { path: string; fileName: string }[];
  content: Array<{ type: "text" | string; text: string }>;
  historyText: string;
  replyChainText?: string;
  dbId?: number;
}

export interface TurnQueueItem {
  turn: PendingTelegramTurn;
  update: TelegramUpdate;
  dbId: number;
}

interface WorkerMessage {
  type: "started" | "stopped" | "health" | "error" | "offset" | "message" | "reaction";
  healthy?: boolean;
  consecutiveErrors?: number;
  error?: string;
  botId?: number;
  lastUpdateId?: number;
  update?: TelegramUpdate;
  dbId?: number;
}

interface PollWorkerData {
  botToken: string;
  botId: number;
  dbPath: string;
  pollTimeoutSeconds: number;
  healthCheckIntervalMs: number;
  maxConsecutiveErrors: number;
  initialReconnectDelayMs: number;
  maxReconnectDelayMs: number;
}

const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "teleg-bridge");
const POLLING_LOCK_REFRESH_MS = 30000;

function lockPath(botId: number): string {
  return join(TEMP_DIR, `polling-${botId}.lock`);
}

function workerPath(): string {
  return join(dirname(new URL(import.meta.url).pathname), "poll-worker.js");
}

function now(): number {
  return Date.now();
}

function normalizeSessionKey(sessionName: string): string {
  return sessionName.startsWith("__session__:") ? sessionName.slice("__session__:".length) : sessionName;
}

export class PollingManager {
  readonly botId: number;
  private worker: Worker | null = null;
  private lockRefreshInterval: ReturnType<typeof setInterval> | undefined;
  private readonly lockFile: string;
  private readonly workerFile: string;
  private config = { botToken: "", lastUpdateId: 0 };
  private pollState: PollState = { consecutiveErrors: 0, reconnectDelay: 1000, lastSuccessfulPoll: now(), isHealthy: true, lastHealthCheck: now() };
  private activeTurns = new Map<string, PendingTelegramTurn>();
  private messageHandler: ((update: TelegramUpdate, dbId: number) => void) | null = null;
  private reactionHandler: ((update: TelegramUpdate) => void) | null = null;
  private healthHandler: ((state: PollState) => void) | null = null;
  private errorHandler: ((error: string) => void) | null = null;
  private botInfo: BotInfo = { botId: 0, username: null, displayName: "" };

  constructor(botId: number) {
    this.botId = botId;
    this.botInfo.botId = botId;
    this.lockFile = lockPath(botId);
    this.workerFile = workerPath();
  }

  async start(sessionName: string, dbPath: string): Promise<boolean> {
    if (this.worker) return true;
    if (!this.config.botToken) return false;
    if (!(await this.acquireLock(sessionName, dbPath))) return false;
    await mkdir(TEMP_DIR, { recursive: true });
    this.lockRefreshInterval = setInterval(() => void this.refreshLock(), POLLING_LOCK_REFRESH_MS);
    const workerData: PollWorkerData = {
      botToken: this.config.botToken,
      botId: this.botId,
      dbPath,
      pollTimeoutSeconds: 55,
      healthCheckIntervalMs: 30000,
      maxConsecutiveErrors: 5,
      initialReconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
    };
    this.worker = new Worker(this.workerFile, { workerData });
    this.worker.on("message", (msg: WorkerMessage) => void this.handleWorkerMessage(msg));
    this.worker.on("error", (err) => this.failWorker(err));
    this.worker.on("exit", () => this.handleWorkerExit());
    this.worker.postMessage({ type: "start", config: { botToken: this.config.botToken, lastUpdateId: this.config.lastUpdateId } });
    return true;
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.activeTurns.clear();
    await this.releaseLock();
    if (worker) worker.postMessage({ type: "stop" });
  }

  isHeldByOther(): boolean {
    try {
      return this.isLockHeldByLiveOther(this.readLockSync());
    } catch {
      return false;
    }
  }

  setConfig(botToken: string, lastUpdateId: number): void {
    this.config = { botToken, lastUpdateId };
  }

  setBotInfo(botInfo: { username: string | null; displayName: string }): void {
    this.botInfo = { botId: this.botId, username: botInfo.username, displayName: botInfo.displayName };
  }

  getConfig(): { botToken: string; lastUpdateId: number } {
    return { ...this.config };
  }

  getBotInfo(): BotInfo {
    return { ...this.botInfo };
  }

  isActive(): boolean {
    return this.worker !== null;
  }

  getState(): PollState {
    return { ...this.pollState };
  }

  getQueueDepth(): number {
    return Db.getQueueDepth(this.botId);
  }

  hasActiveTurnInDb(sessionId: string): boolean {
    try {
      return !!Db.getDb().prepare("SELECT 1 FROM message_queue WHERE bot_id = ? AND session_id = ? AND status = 'processing' LIMIT 1").get(this.botId, sessionId);
    } catch {
      return false;
    }
  }

  hasActiveTurnFor(sessionId: string): boolean {
    return this.activeTurns.has(sessionId) || this.hasActiveTurnInDb(sessionId);
  }

  completeTurn(sessionId: string, dbId?: number): void {
    this.activeTurns.delete(sessionId);
    try {
      if (typeof dbId === "number") {
        Db.completeMessage(dbId);
      } else {
        Db.resetProcessingForSession(this.botId, sessionId);
      }
    } catch (err) {
      this.failWorker(err);
    }
  }

  getProcessingMessageIds(sessionId: string): number[] {
    try {
      const rows = Db.getDb().prepare("SELECT id FROM message_queue WHERE bot_id = ? AND session_id = ? AND status = 'processing'").all(this.botId, sessionId) as Array<{ id: number }>;
      return rows.map((row) => row.id);
    } catch {
      return [];
    }
  }

  getSessionProcessingChat(chatId: number): string | null {
    try {
      const row = Db.getDb().prepare("SELECT session_id FROM message_queue WHERE bot_id = ? AND chat_id = ? AND status = 'processing' ORDER BY started_at DESC LIMIT 1").get(this.botId, chatId) as { session_id: string } | undefined;
      return row?.session_id ? normalizeSessionKey(row.session_id) : null;
    } catch {
      return null;
    }
  }

  claimNextTurn(sessionId: string, sessionName?: string): TurnQueueItem | null {
    const name = sessionName || "unknown";
    const dbMsg = Db.claimNextMessage(this.botId, sessionId, name);
    return dbMsg ? this.buildTurn(dbMsg, sessionId, name) : null;
  }

  claimNextTurnForSession(sessionName: string): TurnQueueItem | null {
    const normalized = normalizeSessionKey(sessionName);
    const dbMsg = Db.claimNextMessageForSession(this.botId, normalized);
    return dbMsg ? this.buildTurn(dbMsg, `__session__:${normalized}`, normalized) : null;
  }

  claimNextTurnForSilentSession(sessionName: string, aliveSessionNames: string[]): TurnQueueItem | null {
    const normalized = normalizeSessionKey(sessionName);
    const dbMsg = Db.claimNextMessageForSilentSession(this.botId, `__session__:${normalized}`, normalized, aliveSessionNames);
    return dbMsg ? this.buildTurn(dbMsg, `__session__:${normalized}`, normalized) : null;
  }

  getPendingCountForSession(sessionName: string): number {
    return Db.getPendingCountForSession(this.botId, normalizeSessionKey(sessionName));
  }

  onMessage(handler: (update: TelegramUpdate, dbId: number) => void): void {
    this.messageHandler = handler;
  }

  onReaction(handler: (update: TelegramUpdate) => void): void {
    this.reactionHandler = handler;
  }

  onHealth(handler: (state: PollState) => void): void {
    this.healthHandler = handler;
  }

  onError(handler: (error: string) => void): void {
    this.errorHandler = handler;
  }

  async recoverCrashState(): Promise<number> {
    const recovered = Db.recoverStaleMessages(60000, this.botId);
    if (recovered > 0) this.pollState.lastHealthCheck = now();
    return recovered;
  }

  private buildTurn(dbMsg: Db.QueuedMessage, sessionId: string, sessionName: string): TurnQueueItem {
    const replyChainText = this.resolveReplyChain(dbMsg.chat_id, dbMsg.reply_to_message_id);
    const historyText = replyChainText ? `${replyChainText}\n${dbMsg.text}` : dbMsg.text;
    const turn: PendingTelegramTurn = {
      sessionId,
      sessionName,
      chatId: dbMsg.chat_id,
      replyToMessageId: dbMsg.message_id,
      queuedAttachments: [],
      content: [{ type: "text", text: `[telegram] ${historyText}` }],
      historyText,
      replyChainText,
      dbId: dbMsg.id,
    };
    this.activeTurns.set(sessionId, turn);
    return {
      turn,
      dbId: dbMsg.id,
      update: { update_id: dbMsg.id, message: { message_id: dbMsg.message_id, from: { id: dbMsg.from_user_id, is_bot: false, first_name: dbMsg.from_username || "User" }, chat: { id: dbMsg.chat_id, type: "private" }, text: dbMsg.text } },
    };
  }

  /** Walk reply_to_message_id chain in message_queue and return formatted context. */
  private resolveReplyChain(chatId: number, replyToMessageId: number | null): string {
    if (!replyToMessageId) return "";
    const parts: string[] = [];
    let currentReplyTo: number | null = replyToMessageId;
    const MAX_CHAIN = 10;
    let depth = 0;
    while (currentReplyTo && depth < MAX_CHAIN) {
      const row = Db.getDb().prepare(
        "SELECT message_id, from_username, text, reply_to_message_id FROM message_queue WHERE bot_id = ? AND chat_id = ? AND message_id = ?"
      ).get(this.botId, chatId, currentReplyTo) as { message_id: number; from_username: string | null; text: string; reply_to_message_id: number | null } | undefined;
      if (!row) break;
      parts.unshift(`[${row.from_username || "User"}]: ${row.text}`);
      currentReplyTo = row.reply_to_message_id;
      depth++;
    }
    return parts.length > 0 ? parts.join("\n") : "";
  }

  private async acquireLock(sessionName: string, dbPath: string): Promise<boolean> {
    try {
      await mkdir(TEMP_DIR, { recursive: true });
      if (this.isLockHeldByLiveOther(this.readLockSync())) return false;
      await writeFileAsync(this.lockFile, JSON.stringify({ pid: process.pid, timestamp: now(), botId: this.botId, sessionName, dbPath }) + "\n", "utf8");
      return true;
    } catch {
      return false;
    }
  }

  private async refreshLock(): Promise<void> {
    try {
      const existing = this.readLockSync();
      if (!existing || existing.pid !== process.pid) return;
      await writeFileAsync(this.lockFile, JSON.stringify({ ...existing, timestamp: now() }) + "\n", "utf8");
    } catch {
    }
  }

  private async releaseLock(): Promise<void> {
    if (this.lockRefreshInterval) {
      clearInterval(this.lockRefreshInterval);
      this.lockRefreshInterval = undefined;
    }
    try {
      const existing = this.readLockSync();
      if (existing && existing.pid === process.pid) await rmAsync(this.lockFile, { force: true });
    } catch {
    }
  }

  private readLockSync(): { pid: number; timestamp: number; botId: number; sessionName: string; dbPath: string } | null {
    try {
      const text = require("node:fs").readFileSync(this.lockFile, "utf8").trim();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  /**
   * A polling lock blocks us only when it is fresh (recently refreshed) AND owned
   * by a process that is still alive. Stale locks or dead-owner locks are treated
   * as free so a crashed poller can be replaced instead of permanently blocking
   * restart. Shared by acquireLock() and isHeldByOther() so they stay consistent.
   */
  private isLockHeldByLiveOther(existing: { pid: number; timestamp: number } | null): boolean {
    if (!existing) return false;
    if (existing.pid === process.pid) return false;
    if (Date.now() - existing.timestamp >= POLLING_LOCK_REFRESH_MS * 3) return false;
    return this.isPidAlive(existing.pid);
  }

  /** true if `pid` is a running process. EPERM (no permission) counts as alive. */
  private isPidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err instanceof Error && (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private failWorker(err: unknown): void {
    this.pollState.isHealthy = false;
    this.pollState.consecutiveErrors += 1;
    this.pollState.lastHealthCheck = now();
    if (this.errorHandler) this.errorHandler(String(err));
    const worker = this.worker;
    this.worker = null;
    if (worker) worker.postMessage({ type: "stop" });
  }

  private handleWorkerExit(): void {
    this.worker = null;
    this.pollState.isHealthy = false;
    void this.releaseLock();
  }

  private async handleWorkerMessage(msg: WorkerMessage): Promise<void> {
    switch (msg.type) {
      case "started":
        this.pollState.isHealthy = true;
        this.pollState.lastSuccessfulPoll = now();
        break;
      case "stopped":
        this.handleWorkerExit();
        break;
      case "health":
        this.pollState.isHealthy = msg.healthy ?? true;
        this.pollState.consecutiveErrors = msg.consecutiveErrors ?? 0;
        this.pollState.lastHealthCheck = now();
        if (this.healthHandler) this.healthHandler(this.pollState);
        break;
      case "error":
        this.failWorker(msg.error ?? "worker error");
        break;
      case "offset":
        if (msg.botId === this.botId && msg.lastUpdateId !== undefined) {
          await saveLastUpdateId(this.botId, msg.lastUpdateId);
        }
        break;
      case "reaction":
        if (msg.update && this.reactionHandler) {
          this.reactionHandler(msg.update);
        }
        break;
      default:
        if (msg.update && msg.dbId !== undefined && this.messageHandler) {
          this.messageHandler(msg.update, msg.dbId);
        }
    }
  }
}

const managers = new Map<number, PollingManager>();
let noopManager: PollingManager | null = null;

export function getPollingManager(botId: number): PollingManager {
  if (!botId) {
    if (!noopManager) noopManager = new PollingManager(0);
    return noopManager;
  }
  let manager = managers.get(botId);
  if (!manager) {
    manager = new PollingManager(botId);
    managers.set(botId, manager);
  }
  return manager;
}

export function getAllPollingManagers(): PollingManager[] {
  return Array.from(managers.values());
}

export function getPollingManagerStats(): Array<{ botId: number; isActive: boolean; isHealthy: boolean }> {
  return Array.from(managers.entries()).map(([botId, manager]) => ({ botId, isActive: manager.isActive(), isHealthy: manager.getState().isHealthy }));
}
