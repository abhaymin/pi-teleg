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
import { homedir } from "node:os";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

// DB path: env override → workerData → shared default
const DEFAULT_DB_PATH = join(process.env.HOME || "~", ".pi", "agent", "teleg-bridge.db");
const DB_PATH = process.env.TELEG_DB_PATH || ((workerData as { dbPath?: string } | undefined)?.dbPath) || DEFAULT_DB_PATH;

// Incoming media (photos/videos/documents/...) is downloaded here so any draining
// session can read the local files referenced by the turn payload.
const MEDIA_DIR = join(homedir(), ".pi", "agent", "tmp", "teleg-media");

// Bot API getFile only serves files up to 20 MB; larger files cannot be fetched.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

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

interface TelegramFileRef {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  poll?: TelegramPoll;
  photo?: Array<TelegramFileRef & { width: number; height: number }>;
  video?: TelegramFileRef & { width: number; height: number; duration: number };
  animation?: TelegramFileRef & { width: number; height: number; duration: number };
  document?: TelegramFileRef & { file_name?: string; mime_type?: string };
  audio?: TelegramFileRef & { duration: number; performer?: string; title?: string; mime_type?: string };
  voice?: TelegramFileRef & { duration: number; mime_type?: string };
  sticker?: TelegramFileRef & { width: number; height: number; emoji?: string; is_animated?: boolean; is_video?: boolean };
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

interface TelegramPollOption {
  text: string;
  voter_count?: number;
}

interface TelegramPoll {
  id: string;
  question: string;
  options: TelegramPollOption[];
  is_anonymous?: boolean;
  allows_multiple_answers?: boolean;
}

interface TelegramPollAnswer {
  poll_id: string;
 user?: TelegramUser;
 option_ids: number[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  message_reaction?: TelegramMessageReactionUpdated;
  poll?: TelegramPoll;
  poll_answer?: TelegramPollAnswer;
}

type WorkerMessage =
  | { type: "start"; config: { botToken: string; lastUpdateId?: number } }
  | { type: "stop" }
  | { type: "update_config"; config: { lastUpdateId?: number } }
  | { type: "offset"; botId: number; lastUpdateId: number };

type MainMessage =
  | { type: "message"; update: TelegramUpdate; dbId: number }
  | { type: "reaction"; update: TelegramUpdate }
  | { type: "poll_answer"; update: TelegramUpdate }
  | { type: "poll"; update: TelegramUpdate }
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

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

interface QueuedAttachment {
  path: string;
  fileName: string;
  type: string;
}

/** Format a Telegram poll into a readable text block (question + numbered options). */
function formatPollText(poll: TelegramPoll): string {
  const options = poll.options.map((opt, i) => `  ${i + 1}. ${opt.text}`).join("\n");
  const multi = poll.allows_multiple_answers ? " (multiple answers)" : "";
  return `📊 Poll${multi}: ${poll.question}\n${options}`;
}

/** Best-effort download of all media attached to a message via the Bot API getFile endpoint. */
async function downloadMedia(message: TelegramMessage): Promise<QueuedAttachment[]> {
  const refs: Array<{ file_id: string; type: string; fileName?: string; file_size?: number }> = [];
  if (message.photo && message.photo.length > 0) {
    // photo is an array of sizes — keep the largest.
    const largest = message.photo.reduce((a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a));
    refs.push({ file_id: largest.file_id, type: "image", file_size: largest.file_size });
  }
  if (message.video) refs.push({ file_id: message.video.file_id, type: "video", file_size: message.video.file_size });
  if (message.animation) refs.push({ file_id: message.animation.file_id, type: "animation", file_size: message.animation.file_size });
  if (message.document) refs.push({ file_id: message.document.file_id, type: "document", fileName: message.document.file_name, file_size: message.document.file_size });
  if (message.audio) refs.push({ file_id: message.audio.file_id, type: "audio", file_size: message.audio.file_size });
  if (message.voice) refs.push({ file_id: message.voice.file_id, type: "voice", file_size: message.voice.file_size });
  if (message.sticker) refs.push({ file_id: message.sticker.file_id, type: "sticker", file_size: message.sticker.file_size });

  const out: QueuedAttachment[] = [];
  for (const ref of refs) {
    // getFile only works for files ≤ 20 MB; skip larger ones up front.
    if (ref.file_size && ref.file_size > MAX_DOWNLOAD_BYTES) continue;
    try {
      const file = await callTelegram<TelegramFile>("getFile", { file_id: ref.file_id }, 15000);
      if (!file.file_path) continue;
      const dir = join(MEDIA_DIR, String(botId));
      mkdirSync(dir, { recursive: true });
      const baseName = ref.fileName || file.file_path.split("/").pop() || ref.file_id;
      const safeName = `${ref.type}-${file.file_unique_id || ref.file_id}-${baseName}`.replace(/[^A-Za-z0-9._-]/g, "_");
      const path = join(dir, safeName);
      const resp = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      writeFileSync(path, buf);
      out.push({ path, fileName: baseName, type: ref.type });
    } catch (err) {
      console.error(`[teleg-poll] media download failed (${ref.type}):`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

function persistMessage(message: TelegramMessage, attachments: QueuedAttachment[] = [], pollId: string | null = null): number {
  const d = getDb();
  const text = message.text || message.caption || (message.poll ? formatPollText(message.poll) : "");
  const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null;
  const stmt = d.prepare(`
    INSERT INTO message_queue (bot_id, chat_id, message_id, reply_to_message_id, from_user_id, from_username, text, session_id, session_name, source, attachments, poll_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'unassigned', 'unknown', 'telegram', ?, ?)
  `);
  try {
    stmt.run(
      botId,
      message.chat.id,
      message.message_id,
      message.reply_to_message?.message_id ?? null,
      message.from?.id ?? 0,
      message.from?.username ?? null,
      text,
      attachmentsJson,
      pollId,
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
        allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "message_reaction", "poll", "poll_answer"],
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

        // Poll answers and standalone poll-state changes are not chat messages;
        // forward them to the main thread which links them back to a chat.
        if (update.poll_answer) {
          post({ type: "poll_answer", update });
          continue;
        }
        if (update.poll) {
          post({ type: "poll", update });
          continue;
        }

        const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
        if (!message || (message.from && message.from.is_bot)) {
          continue;
        }

        // Download any attached media (best-effort) before persisting so the
        // local file paths survive the queue and reach any draining session.
        let attachments: QueuedAttachment[] = [];
        try {
          attachments = await downloadMedia(message);
        } catch (e) {
          console.error("[teleg-poll] media capture error:", e);
        }

        // Persist to SQLite immediately
        const dbId = persistMessage(message, attachments, message.poll ? message.poll.id : null);

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
