/**
 * Per-bot Polling Manager for teleg-bridge.
 *
 * Manages multiple Telegram poll workers concurrently — one per distinct botId.
 * Each bot has its own lock file, worker, and offset tracking.
 *
 * Lock file: `~/.pi/agent/tmp/teleg-bridge/polling-{botId}.lock`
 * Format: pid, timestamp_ms, botId, sessionName
 */

import { Worker } from "node:worker_threads";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFile, readFile } from "node:fs";
import { homedir } from "node:os";
import { mkdir, readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises";

// ============================================================================
// Types
// ============================================================================

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

interface WorkerMessage {
  type: "started" | "stopped" | "health" | "error" | "offset";
  healthy?: boolean;
  consecutiveErrors?: number;
  error?: string;
  botId?: number;
  lastUpdateId?: number;
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

// ============================================================================
// Constants
// ============================================================================

const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "teleg-bridge");
const POLLING_LOCK_REFRESH_MS = 30000;

// ============================================================================
// Polling Manager Class
// ============================================================================

class PollingManager {
  readonly botId: number;
  private readonly lockFile: string;
  private readonly workerFile: string;
  private worker: Worker | null = null;
  private isPolling = false;
  private lockRefreshInterval: ReturnType<typeof setInterval> | undefined;
  private config: { botToken: string; lastUpdateId: number } = { botToken: "", lastUpdateId: 0 };
  private messageHandler: ((update: TelegramUpdate, dbId: number) => void) | null = null;
  private healthHandler: ((state: PollState) => void) | null = null;
  private errorHandler: ((error: string) => void) | null = null;

  private pollState: PollState = {
    consecutiveErrors: 0,
    reconnectDelay: 1000,
    lastSuccessfulPoll: Date.now(),
    isHealthy: true,
    lastHealthCheck: Date.now(),
  };

  constructor(botId: number) {
    this.botId = botId;
    this.lockFile = join(TEMP_DIR, `polling-${botId}.lock`);
    this.workerFile = join(dirname(new URL(import.meta.url).pathname), "poll-worker.js");
  }

  // ─── Lock file management ──────────────────────────────────────────────

  private async acquireLock(sessionName: string): Promise<boolean> {
    try {
      await mkdir(TEMP_DIR, { recursive: true });
      
      // Check existing lock
      try {
        const existing = await readFileAsync(this.lockFile, "utf8");
        const parts = existing.trim().split("\n");
        const oldPid = parseInt(parts[0], 10);
        const oldTime = parseInt(parts[1] || "0", 10);
        
        if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
          try {
            process.kill(oldPid, 0);
            // Lock is fresh — another process is actively polling
            if (Date.now() - oldTime < POLLING_LOCK_REFRESH_MS * 3) {
              return false;
            }
          } catch {
            // Dead process — stale lock, we can take it
          }
        }
      } catch {
        // No existing lock file
      }
      
      // Write our lock
      const lockContent = `${process.pid}\n${Date.now()}\n${this.botId}\n${sessionName}\n`;
      await writeFileAsync(this.lockFile, lockContent, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  private async refreshLock(): Promise<void> {
    try {
      const existing = await readFileAsync(this.lockFile, "utf8");
      if (existing.trim().startsWith(String(process.pid))) {
        await writeFileAsync(this.lockFile, `${process.pid}\n${Date.now()}\n${this.botId}\n`, "utf8");
      }
    } catch {}
  }

  private async releaseLock(): Promise<void> {
    if (this.lockRefreshInterval) {
      clearInterval(this.lockRefreshInterval);
      this.lockRefreshInterval = undefined;
    }
    try {
      const existing = await readFileAsync(this.lockFile, "utf8");
      if (existing.trim().startsWith(String(process.pid))) {
        await writeFileAsync(this.lockFile, "", "utf8");
      }
    } catch {}
  }

  isHeldByOther(): boolean {
    try {
      const existing = readFileSync(this.lockFile, "utf8");
      const parts = existing.trim().split("\n");
      const oldPid = parseInt(parts[0], 10);
      const oldTime = parseInt(parts[1] || "0", 10);
      
      if (oldPid && !isNaN(oldPid) && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0);
          if (Date.now() - oldTime < POLLING_LOCK_REFRESH_MS * 3) {
            return true;
          }
        } catch {}
      }
    } catch {}
    return false;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async start(sessionName: string, dbPath: string): Promise<boolean> {
    if (this.isPolling) return true;
    if (!this.config.botToken) {
      console.error(`[polling:${this.botId}] No bot token configured`);
      return false;
    }

    // Acquire lock
    if (!(await this.acquireLock(sessionName))) {
      console.log(`[polling:${this.botId}] Lock held by another process`);
      return false;
    }

    // Start lock refresh interval
    this.lockRefreshInterval = setInterval(() => this.refreshLock(), POLLING_LOCK_REFRESH_MS);

    // Create worker
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

    this.worker.on("message", (msg: WorkerMessage) => this.handleWorkerMessage(msg));

    this.worker.on("error", (err) => {
      console.error(`[polling:${this.botId}] Worker error:`, err);
      if (this.errorHandler) this.errorHandler(String(err));
    });

    this.worker.on("exit", (code) => {
      console.log(`[polling:${this.botId}] Worker exited with code ${code}`);
      this.isPolling = false;
    });

    // Send start message to worker
    this.worker.postMessage({
      type: "start",
      config: { botToken: this.config.botToken, lastUpdateId: this.config.lastUpdateId },
    });

    this.isPolling = true;
    return true;
  }

  async stop(): Promise<void> {
    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      this.worker = null;
    }
    await this.releaseLock();
    this.isPolling = false;
  }

  // ─── Configuration ─────────────────────────────────────────────────────

  setConfig(botToken: string, lastUpdateId: number): void {
    this.config = { botToken, lastUpdateId };
  }

  getConfig(): { botToken: string; lastUpdateId: number } {
    return { ...this.config };
  }

  setBotInfo(botInfo: { username: string | null; displayName: string }): void {
    this._botInfo = botInfo;
  }

  private _botInfo: { username: string | null; displayName: string } = { username: null, displayName: "" };

  getBotInfo(): BotInfo {
    return { botId: this.botId, ...this._botInfo };
  }

  // ─── State ─────────────────────────────────────────────────────────────

  isActive(): boolean {
    return this.isPolling && this.worker !== null;
  }

  getState(): PollState {
    return { ...this.pollState };
  }

  getQueueDepth(): number {
    // This will be called from index.ts, which has access to Db
    // Import lazily to avoid circular deps
    return 0; // Placeholder — actual value comes from Db.getQueueDepth(botId)
  }

  // ─── Handlers ─────────────────────────────────────────────────────────

  onMessage(handler: (update: TelegramUpdate, dbId: number) => void): void {
    this.messageHandler = handler;
  }

  onHealth(handler: (state: PollState) => void): void {
    this.healthHandler = handler;
  }

  onError(handler: (error: string) => void): void {
    this.errorHandler = handler;
  }

  // ─── Worker message handling ───────────────────────────────────────────

  private async handleWorkerMessage(msg: WorkerMessage): Promise<void> {
    switch (msg.type) {
      case "started":
        console.log(`[polling:${this.botId}] Polling started`);
        break;

      case "stopped":
        console.log(`[polling:${this.botId}] Polling stopped`);
        this.isPolling = false;
        break;

      case "health":
        if (msg.healthy !== undefined) {
          this.pollState.isHealthy = msg.healthy;
          this.pollState.consecutiveErrors = msg.consecutiveErrors ?? 0;
          this.pollState.lastHealthCheck = Date.now();
          if (this.healthHandler) this.healthHandler(this.pollState);
        }
        break;

      case "error":
        console.error(`[polling:${this.botId}] Error:`, msg.error);
        if (this.errorHandler && msg.error) this.errorHandler(msg.error);
        break;

      case "offset":
        // Worker signals new offset after processing a batch
        if (msg.botId === this.botId && msg.lastUpdateId !== undefined) {
          this.config.lastUpdateId = msg.lastUpdateId;
          // Save to config via the config module
          const { saveLastUpdateId } = await import("./config.js");
          await saveLastUpdateId(this.botId, msg.lastUpdateId);
        }
        break;

      default:
        // Forward message to handler if it's a Telegram update (type guard)
        const msgAny = msg as { type: string; update?: TelegramUpdate; dbId?: number };
        if (this.messageHandler && msgAny.update && msgAny.dbId !== undefined) {
          this.messageHandler(msgAny.update, msgAny.dbId);
        }
    }
  }
}

// ============================================================================
// PollingManager Registry (singleton per botId)
// ============================================================================

const managers = new Map<number, PollingManager>();

export function getPollingManager(botId: number): PollingManager {
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
  return Array.from(managers.entries()).map(([botId, mgr]) => {
    const state = mgr.getState();
    return { botId, isActive: mgr.isActive(), isHealthy: state.isHealthy };
  });
}

// ============================================================================
// Telegram types (for message handler signatures)
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