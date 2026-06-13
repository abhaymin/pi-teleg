/**
 * Telegram Poll Worker - runs in a dedicated worker thread.
 *
 * Responsibilities:
 *   - Long-polls Telegram API for new messages
 *   - Persists each message to SQLite immediately
 *   - Posts each valid message to the main thread via MessagePort
 *   - Handles health checks and reconnect logic autonomously
 *
 * The main thread is free to process/dispatch messages concurrently
 * while this worker handles the blocking HTTP long-poll.
 *
 * DB path: env TELEG_DB_PATH → workerData.dbPath → ~/.pi/agent/teleg-bridge.db
 */

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

// DB path: env override → workerData → shared default
const DEFAULT_DB_PATH = join(process.env.HOME || "~", ".pi", "agent", "teleg-bridge.db");
const DB_PATH = process.env.TELEG_DB_PATH || ((workerData as { dbPath?: string } | undefined)?.dbPath) || DEFAULT_DB_PATH;

// ============================================================================
// Types
// ============================================================================

interface PollWorkerData {
  botToken: string;
  botId: number; // Telegram bot user ID for scoping
  dbPath: string;
  pollTimeoutSeconds: number;
  healthCheckIntervalMs: number;
  maxConsecutiveErrors: number;
  initialReconnectDelayMs: number;
  maxReconnectDelayMs: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
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
  reply_to_message?: TelegramMessage;
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

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  message_reaction?: TelegramMessageReactionUpdated;
}

type WorkerMessage =
  | { type: "start"; config: { botToken: string; lastUpdateId?: number } }
  | { type: "stop" }
  | { type: "update_config"; config: { lastUpdateId?: number } }
  | { type: "offset"; botId: number; lastUpdateId: number };

type MainMessage =
  | { type: "message"; update: TelegramUpdate; dbId: number }
  | { type: "reaction"; update: TelegramUpdate }
  | { type: "health"; healthy: boolean; consecutiveErrors: number }
  | { type: "error"; error: string }
  | { type: "started" }
  | { type: "stopped" }
  | { type: "offset"; botId: number; lastUpdateId: number };

// ============================================================================
// Worker Logic
// ============================================================================

const POLL_TIMEOUT = workerData?.pollTimeoutSeconds ?? 60;
const HEALTH_CHECK_MS = workerData?.healthCheckIntervalMs ?? 30000;
const MAX_ERRORS = workerData?.maxConsecutiveErrors ?? 5;
const INITIAL_RECONNECT = workerData?.initialReconnectDelayMs ?? 1000;
const MAX_RECONNECT = workerData?.maxReconnectDelayMs ?? 30000;

let botToken = "";
let botId = 0;
let lastUpdateId: number | undefined;
let aborted = false;
let consecutiveErrors = 0;
let reconnectDelay = INITIAL_RECONNECT;
let lastSuccessfulPoll = Date.now();
let isHealthy = true;

let db: DatabaseSync | null = null;
let healthInterval: ReturnType<typeof setInterval> | undefined;

function getDb(): DatabaseSync {
  if (!db) {
    const dir = dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    // Schema is initialized by the main thread's db.ts migrations.
    // We only ensure the tables exist so the worker can function if started
    // before the main thread (e.g. during development).
    db.exec(`CREATE TABLE IF NOT EXISTS message_queue (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS download_queue (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  }
  return db;
}

function post(msg: MainMessage): void {
  parentPort?.postMessage(msg);
}

async function callTelegram<T>(
  method: string,
  body: Record<string, unknown>,
  timeout?: number,
): Promise<T> {
  const controller = new AbortController();
  const t = timeout ?? POLL_TIMEOUT * 1000;
  const tid = setTimeout(() => controller.abort(), t);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    clearTimeout(tid);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as TelegramApiResponse<T>;
    if (!data.ok || data.result === undefined) {
      throw new Error(data.description || `Telegram API ${method} failed`);
    }
    return data.result;
  } catch (error) {
    clearTimeout(tid);
    throw error;
  }
}

function persistMessage(message: TelegramMessage): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO message_queue (bot_id, chat_id, message_id, reply_to_message_id, from_user_id, from_username, text, session_id, session_name, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'unassigned', 'unknown', 'telegram')
  `);
  try {
    stmt.run(
      botId,
      message.chat.id,
      message.message_id,
      message.reply_to_message?.message_id ?? null,
      message.from?.id ?? 0,
      message.from?.username ?? null,
      message.text || message.caption || "",
    );
    const row = d.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    return row.id;
  } catch (err) {
    // Duplicate (bot_id, chat_id, message_id) — Telegram redelivered after a reconnect.
    // Return the existing ID so we skip re-processing this message.
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      const existing = d.prepare(
        "SELECT id FROM message_queue WHERE bot_id = ? AND chat_id = ? AND message_id = ?"
      ).get(botId, message.chat.id, message.message_id) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    throw err;
  }
}

async function pollLoop(): Promise<void> {
  // Reset webhook
  try {
    await callTelegram("deleteWebhook", { drop_pending_updates: true }, 10000);
  } catch { /* continue */ }

  // Catch up on last update ID
  if (lastUpdateId === undefined) {
    try {
      const updates = await callTelegram<TelegramUpdate[]>(
        "getUpdates",
        { offset: -1, limit: 1, timeout: 5 },
        10000,
      );
      const last = updates.at(-1);
      if (last) lastUpdateId = last.update_id;
    } catch { /* use default */ }
  }

  post({ type: "started" });

  // Drain only STALE processing messages before starting the poll loop.
  // A blanket reset here would steal in-flight work from other live sessions
  // attached to the same bot (cross-session work stealing). Truly stale rows
  // (started_at older than the cutoff, or NULL) are already recovered by
  // runStartupRecovery on the main thread; this is a bot-scoped safety net for
  // the same condition so a crashed worker's stuck rows can be reclaimed.
  try {
    const staleCutoff = Date.now() - 60000;
    getDb().prepare(
      "UPDATE message_queue SET status = 'pending', started_at = NULL, session_id = 'unassigned', session_name = 'unknown' WHERE status = 'processing' AND bot_id = ? AND (started_at IS NULL OR started_at < ?)"
    ).run(botId, staleCutoff);
  } catch (e) {
    console.error("[teleg-poll] Recovery error:", e);
  }

  while (!aborted) {
    try {
      const updates = await callTelegram<TelegramUpdate[]>("getUpdates", {
        offset: lastUpdateId !== undefined ? lastUpdateId + 1 : undefined,
        limit: 10,
        timeout: POLL_TIMEOUT,
        allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "message_reaction"],
      });

      consecutiveErrors = 0;
      reconnectDelay = INITIAL_RECONNECT;
      lastSuccessfulPoll = Date.now();
      isHealthy = true;

      for (const update of updates) {
        lastUpdateId = update.update_id;

        // Handle reaction updates — forward to main thread without persisting
        if (update.message_reaction) {
          post({ type: "reaction", update });
          continue;
        }

        const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
        if (!message || (message.from && message.from.is_bot)) {
          continue;
        }

        // Persist to SQLite immediately
        const dbId = persistMessage(message);

        // Post to main thread for routing and dispatch
        post({ type: "message", update, dbId });
      }

      // Report offset after batch (action 3.5)
      if (updates.length > 0 && lastUpdateId !== undefined) {
        post({ type: "offset", botId, lastUpdateId });
      }
    } catch (error) {
      if (aborted) return;

      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "TIMEOUT") {
        lastSuccessfulPoll = Date.now();
        continue;
      }

      consecutiveErrors++;
      isHealthy = false;
      post({ type: "health", healthy: false, consecutiveErrors });

      if (consecutiveErrors > MAX_ERRORS) {
        reconnectDelay = INITIAL_RECONNECT;
        consecutiveErrors = 0;
        lastUpdateId = undefined;
      }

      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
    }
  }
}

function startHealthChecks(): void {
  if (healthInterval) return;
  healthInterval = setInterval(async () => {
    if (aborted || !botToken) return;
    const since = Date.now() - lastSuccessfulPoll;
    if (since > HEALTH_CHECK_MS * 2) {
      try {
        await callTelegram<TelegramUser>("getMe", {}, 10000);
        lastSuccessfulPoll = Date.now();
        isHealthy = true;
      } catch {
        isHealthy = false;
        post({ type: "health", healthy: false, consecutiveErrors });
      }
    }
  }, HEALTH_CHECK_MS);
}

// ============================================================================
// Message handling from main thread
// ============================================================================

parentPort?.on("message", (msg: WorkerMessage) => {
  switch (msg.type) {
    case "start":
      botToken = msg.config.botToken;
      botId = (workerData as PollWorkerData)?.botId ?? 0;
      lastUpdateId = msg.config.lastUpdateId;
      aborted = false;
      startHealthChecks();
      pollLoop().catch((err) => {
        post({ type: "error", error: String(err) });
      });
      break;

    case "stop":
      aborted = true;
      if (healthInterval) {
        clearInterval(healthInterval);
        healthInterval = undefined;
      }
      if (db) {
        try { db.close(); } catch { /* best effort */ }
        db = null;
      }
      post({ type: "stopped" });
      break;

    case "update_config":
      if (msg.config.lastUpdateId !== undefined) {
        lastUpdateId = msg.config.lastUpdateId;
      }
      break;
  }
});
