/**
 * Persistent SQLite database for teleg-bridge.
 *
 * Stores:
 *   - Message queue (survives crashes/restarts, shared across pi sessions)
 *   - Relay session registry
 *   - Queue processing history (completed/failed items for status reporting)
 *   - Download queue
 *
 * DB location: configurable via TELEG_DB_PATH env var.
 *   - Default: ~/.pi/agent/teleg-bridge.db (shared across all sessions on this machine)
 *   - Override with: TELEG_DB_PATH=/path/to/db  (for remote deployments)
 *   - Works on any machine: pi sessions read from the same DB wherever they run.
 */

import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { readGlobalConfigSync } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Schema version for migrations
const SCHEMA_VERSION = 4;

// DB path: env override → shared default
const DEFAULT_DB_PATH = join(process.env.HOME || "~", ".pi", "agent", "teleg-bridge.db");
const DB_PATH = process.env.TELEG_DB_PATH || DEFAULT_DB_PATH;

// ============================================================================
// Types
// ============================================================================

export interface QueuedMessage {
  id: number;
  bot_id: number; // Telegram bot user ID that received this message
  chat_id: number;
  message_id: number;
  reply_to_message_id: number | null;
  from_user_id: number;
  from_username: string | null;
  text: string;
  session_id: string;
  session_name: string;
  status: "pending" | "processing" | "completed" | "failed";
  source: "telegram" | "relay";
  source_session: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  response: string | null;
  // v4: JSON array of downloaded incoming media [{path, fileName, type}]
  attachments: string | null;
  // v4: Telegram poll id linking a poll message to its poll_answer updates
  poll_id: string | null;
}

export interface RelaySession {
  id: number;
  bot_id: number; // Telegram bot user ID this session is linked to
  session_name: string;
  session_id: string;
  pid: number;
  port: number;
  secret: string;
  project_dir: string | null;
  capabilities: string | null; // JSON array
  description: string | null;
  role: "active" | "drain";
  is_primary: boolean; // True if this session holds the polling lock for this bot
  registered_at: number;
  last_heartbeat: number;
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

export interface DownloadItem {
  id: number;
  bot_id: number; // Telegram bot user ID that received the message with this download
  chat_id: number;
  message_id: number;
  url: string;
  source: string;
  session_name: string;
  status: "pending" | "processing" | "completed" | "failed";
  retry_count: number;
  error: string | null;
  result: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

// ============================================================================
// Database Singleton
// ============================================================================

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!db) {
    // Ensure parent directory exists
    const dir = dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA synchronous=NORMAL");
    
    // Check and run migrations
    runMigrations(db);
  }
  return db;
}

function runMigrations(database: DatabaseSync): void {
  // Get current schema version
  const versionRow = database.prepare("PRAGMA user_version").get() as { user_version: number };
  let currentVersion = versionRow.user_version;

  if (currentVersion >= SCHEMA_VERSION) {
    // Already up to date, just ensure tables exist and repair legacy constraints.
    initSchema(database);
    repairLegacyRelaySessionsSchema(database);
    return;
  }

  // Migration from v0/v1 to v2: Add bot_id columns
  if (currentVersion < 2) {
    migrateToV2(database);
  }

  // Migration from v2 to v3: Add reply_to_message_id column
  if (currentVersion < 3) {
    migrateToV3(database);
  }

  // Migration from v3 to v4: Add attachments (incoming media JSON) + poll_id
  if (currentVersion < 4) {
    migrateToV4(database);
  }

  initSchema(database);
  repairLegacyRelaySessionsSchema(database);

  // Set the final version
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

}

function migrateToV2(database: DatabaseSync): void {
  // Get default bot_id for backfill
  let defaultBotId = 0;
  try {
    const cfg = readGlobalConfigSync();
    if (cfg && cfg.defaultBotId) {
      defaultBotId = cfg.defaultBotId;
    }
  } catch {
    console.warn("[db] Could not read global config for default bot_id, using 0");
  }
  if (!Number.isFinite(defaultBotId)) defaultBotId = 0;

  // Add bot_id column to message_queue if it doesn't exist
  try {
    database.exec(`ALTER TABLE message_queue ADD COLUMN bot_id INTEGER NOT NULL DEFAULT ${defaultBotId}`);
  } catch (err) {
    // Column might already exist (in case of partial migration)
    if (!(err instanceof Error && err.message.includes("duplicate column"))) {
      console.error("[db] Error adding bot_id to message_queue:", err);
    }
  }

  // Add bot_id column to relay_sessions if it doesn't exist
  try {
    database.exec(`ALTER TABLE relay_sessions ADD COLUMN bot_id INTEGER NOT NULL DEFAULT ${defaultBotId}`);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("duplicate column"))) {
      console.error("[db] Error adding bot_id to relay_sessions:", err);
    }
  }

  // Add is_primary column to relay_sessions
  try {
    database.exec(`ALTER TABLE relay_sessions ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0`);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("duplicate column"))) {
      console.error("[db] Error adding is_primary to relay_sessions:", err);
    }
  }

  // Add bot_id column to download_queue
  try {
    database.exec(`ALTER TABLE download_queue ADD COLUMN bot_id INTEGER NOT NULL DEFAULT ${defaultBotId}`);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("duplicate column"))) {
      console.error("[db] Error adding bot_id to download_queue:", err);
    }
  }

  // Drop old unique index and create new scoped index for message_queue
  try {
    database.exec(`DROP INDEX IF EXISTS idx_queue_dedup`);
  } catch { /* ignore */ }
  try {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_dedup ON message_queue(bot_id, chat_id, message_id)`);
  } catch (err) {
    console.error("[db] Error creating idx_queue_dedup:", err);
  }

  // Drop auto-index on old UNIQUE(session_name) constraint before creating new compound index
  try {
    database.exec(`DROP INDEX IF EXISTS sqlite_autoindex_relay_sessions_1`);
  } catch { /* ignore */ }
  // Drop old relay_sessions unique constraint and create new scoped one
  try {
    database.exec(`DROP INDEX IF EXISTS idx_relay_name`);
  } catch { /* ignore */ }
  try {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_name ON relay_sessions(bot_id, session_name)`);
  } catch (err) {
    console.error("[db] Error creating idx_relay_name:", err);
  }

  // Create indexes for bot_id columns
  try {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_queue_bot_id ON message_queue(bot_id)`);
  } catch { /* ignore */ }
  try {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_relay_bot_id ON relay_sessions(bot_id)`);
  } catch { /* ignore */ }
  try {
    database.exec(`CREATE INDEX IF NOT EXISTS idx_dl_bot_id ON download_queue(bot_id)`);
  } catch { /* ignore */ }


}

function migrateToV3(database: DatabaseSync): void {
  try {
    const tableExists = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_queue'").get() as { name: string } | undefined) != null;
    if (!tableExists) return; // initSchema will create the table with the column
    database.exec(`ALTER TABLE message_queue ADD COLUMN reply_to_message_id INTEGER`);
  } catch (err) {
    if (!(err instanceof Error && (err.message.includes("duplicate column") || err.message.includes("no such table")))) {
      console.error("[db] Error adding reply_to_message_id to message_queue:", err);
    }
  }
}
function migrateToV4(database: DatabaseSync): void {
  const tableExists = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_queue'").get() as { name: string } | undefined) != null;
  if (!tableExists) return; // initSchema will create the table with the columns

  // JSON array of downloaded incoming media: [{path, fileName, type}]
  try {
    database.exec(`ALTER TABLE message_queue ADD COLUMN attachments TEXT`);
  } catch (err) {
    if (!(err instanceof Error && (err.message.includes("duplicate column") || err.message.includes("no such table")))) {
      console.error("[db] Error adding attachments to message_queue:", err);
    }
  }

  // Telegram poll id linking a poll message to its poll_answer updates
  try {
    database.exec(`ALTER TABLE message_queue ADD COLUMN poll_id TEXT`);
  } catch (err) {
    if (!(err instanceof Error && (err.message.includes("duplicate column") || err.message.includes("no such table")))) {
      console.error("[db] Error adding poll_id to message_queue:", err);
    }
  }
}

function repairLegacyRelaySessionsSchema(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'relay_sessions'").get() as { sql?: string } | undefined;
  const createSql = row?.sql ?? "";
  const hasLegacyNameConstraint = /session_name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(createSql);
  const hasLegacyRoleConstraint = /role\s+IN\s*\(\s*'active'\s*,\s*'passive'\s*\)/i.test(createSql);

  if (!hasLegacyNameConstraint && !hasLegacyRoleConstraint) return;

  const oldTable = `relay_sessions_legacy_${Date.now()}`;
  database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE relay_sessions RENAME TO ${oldTable};
    CREATE TABLE relay_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id            INTEGER NOT NULL DEFAULT 0,
      session_name      TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      pid               INTEGER NOT NULL,
      port              INTEGER NOT NULL,
      secret            TEXT NOT NULL,
      project_dir       TEXT,
      capabilities      TEXT,
      description       TEXT,
      role              TEXT NOT NULL DEFAULT 'drain' CHECK (role IN ('active', 'drain')),
      is_primary        INTEGER NOT NULL DEFAULT 0,
      registered_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      last_heartbeat    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );
    INSERT OR IGNORE INTO relay_sessions (id, bot_id, session_name, session_id, pid, port, secret, project_dir, capabilities, description, role, is_primary, registered_at, last_heartbeat)
      SELECT id, bot_id, session_name, session_id, pid, port, secret, project_dir, capabilities, description,
        CASE role WHEN 'passive' THEN 'drain' ELSE role END,
        is_primary, registered_at, last_heartbeat
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY bot_id, session_name ORDER BY last_heartbeat DESC, id DESC) AS relay_row_number
        FROM ${oldTable}
      )
      WHERE relay_row_number = 1
      ORDER BY last_heartbeat DESC;
    DROP TABLE ${oldTable};
    CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_name ON relay_sessions(bot_id, session_name);
    CREATE INDEX IF NOT EXISTS idx_relay_pid ON relay_sessions(pid);
    CREATE INDEX IF NOT EXISTS idx_relay_bot_id ON relay_sessions(bot_id);
    COMMIT;
  `);
}

function initSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id            INTEGER NOT NULL DEFAULT 0,
      chat_id           INTEGER NOT NULL,
      message_id        INTEGER NOT NULL,
      reply_to_message_id INTEGER,
      from_user_id      INTEGER NOT NULL,
      from_username     TEXT,
      text              TEXT NOT NULL DEFAULT '',
      session_id        TEXT NOT NULL DEFAULT 'unassigned',
      session_name      TEXT NOT NULL DEFAULT 'unknown',
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      source            TEXT NOT NULL DEFAULT 'telegram' CHECK (source IN ('telegram', 'relay')),
      source_session    TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      started_at        INTEGER,
      completed_at      INTEGER,
      error             TEXT,
      response          TEXT,
      attachments       TEXT,
      poll_id           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON message_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_session ON message_queue(session_id);
    CREATE INDEX IF NOT EXISTS idx_queue_chat ON message_queue(chat_id);
    CREATE INDEX IF NOT EXISTS idx_queue_bot_id ON message_queue(bot_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_dedup ON message_queue(bot_id, chat_id, message_id);

    CREATE TABLE IF NOT EXISTS download_queue (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id            INTEGER NOT NULL DEFAULT 0,
      chat_id           INTEGER NOT NULL,
      message_id        INTEGER NOT NULL,
      url               TEXT NOT NULL,
      source            TEXT NOT NULL DEFAULT 'twitter' CHECK (source IN ('twitter', 'youtube', 'reddit', 'gallery', 'other')),
      session_name      TEXT NOT NULL DEFAULT 'data-scrapper',
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      retry_count       INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      result            TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      started_at        INTEGER,
      completed_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_dl_status ON download_queue(status);
    CREATE INDEX IF NOT EXISTS idx_dl_session ON download_queue(session_name);
    CREATE INDEX IF NOT EXISTS idx_dl_created ON download_queue(created_at);
    CREATE INDEX IF NOT EXISTS idx_dl_url ON download_queue(url);
    CREATE INDEX IF NOT EXISTS idx_dl_bot_id ON download_queue(bot_id);

    CREATE TABLE IF NOT EXISTS relay_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id            INTEGER NOT NULL DEFAULT 0,
      session_name      TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      pid               INTEGER NOT NULL,
      port              INTEGER NOT NULL,
      secret            TEXT NOT NULL,
      project_dir       TEXT,
      capabilities      TEXT,
      description       TEXT,
      role              TEXT NOT NULL DEFAULT 'drain' CHECK (role IN ('active', 'drain')),
      is_primary        INTEGER NOT NULL DEFAULT 0,
      registered_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      last_heartbeat    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_name ON relay_sessions(bot_id, session_name);
    CREATE INDEX IF NOT EXISTS idx_relay_pid ON relay_sessions(pid);
    CREATE INDEX IF NOT EXISTS idx_relay_bot_id ON relay_sessions(bot_id);

    CREATE TABLE IF NOT EXISTS relay_history (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_session      TEXT NOT NULL,
      to_session        TEXT NOT NULL,
      chat_id           INTEGER NOT NULL,
      command           TEXT NOT NULL,
      success           INTEGER NOT NULL DEFAULT 0,
      error             TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_relay_history_time ON relay_history(created_at);

    -- PUB-SUB: inter-session messages
    CREATE TABLE IF NOT EXISTS pubsub (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id            INTEGER NOT NULL DEFAULT 0,
      channel           TEXT NOT NULL,
      publisher         TEXT NOT NULL,
      payload           TEXT NOT NULL DEFAULT '',
      target_session    TEXT,
      consumed_by       TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      consumed_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pubsub_channel ON pubsub(channel, consumed_at);
    CREATE INDEX IF NOT EXISTS idx_pubsub_target ON pubsub(target_session, consumed_at);
    CREATE INDEX IF NOT EXISTS idx_pubsub_bot ON pubsub(bot_id, channel);
    -- OUTBOUND: bot replies, so reply-chains and reactions can resolve the
    -- message a user reacted to / replied to (incl. the bot's own earlier post).
    CREATE TABLE IF NOT EXISTS outbound_messages (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id             INTEGER NOT NULL,
      chat_id            INTEGER NOT NULL,
      message_id         INTEGER NOT NULL,
      reply_to_message_id INTEGER,
      from_session       TEXT,
      text               TEXT NOT NULL DEFAULT '',
      created_at         INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_lookup ON outbound_messages(bot_id, chat_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_outbound_bot ON outbound_messages(bot_id);
  `);
}

// ============================================================================
// Close / Cleanup
// ============================================================================

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // best effort
    }
    db = null;
  }
}

// ============================================================================
// Message Queue Operations
// ============================================================================

/**
 * Enqueue a new message from Telegram or relay.
 * Returns the auto-generated row ID.
 * @param botId - The bot that received this message
 */
export function enqueueMessage(params: {
  bot_id: number;
  chat_id: number;
  message_id: number;
  reply_to_message_id?: number | null;
  from_user_id: number;
  from_username?: string | null;
  text: string;
  session_id?: string;
  session_name?: string;
  source?: "telegram" | "relay";
  source_session?: string | null;
  attachments?: string | null;
  poll_id?: string | null;
}): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO message_queue (bot_id, chat_id, message_id, reply_to_message_id, from_user_id, from_username, text, session_id, session_name, source, source_session, attachments, poll_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.bot_id,
    params.chat_id,
    params.message_id,
    params.reply_to_message_id ?? null,
    params.from_user_id,
    params.from_username || null,
    params.text,
    params.session_id || "unassigned",
    params.session_name || "unknown",
    params.source || "telegram",
    params.source_session || null,
    params.attachments ?? null,
    params.poll_id ?? null,
  );
  // Get the last inserted row ID
  const row = d.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
  return row.id;
}

/**
 * Record a bot outbound reply so later reply-chains and reactions can resolve
 * the message the user reacted to / replied to (including the bot's own post).
 * Re-recording the same (bot_id, chat_id, message_id) replaces the prior row.
 */
export function recordOutboundMessage(params: {
  bot_id: number;
  chat_id: number;
  message_id: number;
  reply_to_message_id?: number | null;
  from_session?: string | null;
  text: string;
}): void {
  getDb().prepare(`
    INSERT INTO outbound_messages (bot_id, chat_id, message_id, reply_to_message_id, from_session, text)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, chat_id, message_id) DO UPDATE SET
      reply_to_message_id = excluded.reply_to_message_id,
      from_session = excluded.from_session,
      text = excluded.text,
      created_at = (unixepoch('now') * 1000)
  `).run(
    params.bot_id,
    params.chat_id,
    params.message_id,
    params.reply_to_message_id ?? null,
    params.from_session ?? null,
    params.text,
  );
}

export interface ChainMessage {
  /** Display author label for the message. */
  author: string;
  text: string;
  replyToMessageId: number | null;
}

/**
 * Resolve a single message by id across BOTH stores — incoming (message_queue)
 * and the bot's own outbound replies (outbound_messages). Returns null if the
 * message is unknown to this bridge. Used to build reply chains and to surface
 * the post a reaction refers to.
 */
export function lookupMessageForChain(botId: number, chatId: number, messageId: number): ChainMessage | null {
  const incoming = getDb().prepare(
    "SELECT from_username AS author, text, reply_to_message_id FROM message_queue WHERE bot_id = ? AND chat_id = ? AND message_id = ?"
  ).get(botId, chatId, messageId) as { author: string | null; text: string; reply_to_message_id: number | null } | undefined;
  if (incoming) {
    return { author: incoming.author || "User", text: incoming.text, replyToMessageId: incoming.reply_to_message_id ?? null };
  }
  const outbound = getDb().prepare(
    "SELECT from_session AS author, text, reply_to_message_id FROM outbound_messages WHERE bot_id = ? AND chat_id = ? AND message_id = ?"
  ).get(botId, chatId, messageId) as { author: string | null; text: string; reply_to_message_id: number | null } | undefined;
  if (outbound) {
    return { author: outbound.author ? `@${outbound.author}` : "Assistant", text: outbound.text, replyToMessageId: outbound.reply_to_message_id ?? null };
  }
  return null;
}

/**
 * Bound growth of the outbound store: drop old rows beyond a keep window.
 * Mirrors purgeOldMessages semantics. Returns the number of rows removed.
 */
export function purgeOldOutboundMessages(keepCount: number = 1000, botId?: number): number {
  const d = getDb();
  const row = botId !== undefined
    ? d.prepare(`SELECT id FROM outbound_messages WHERE bot_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`).get(botId, keepCount) as { id: number } | undefined
    : d.prepare(`SELECT id FROM outbound_messages ORDER BY id DESC LIMIT 1 OFFSET ?`).get(keepCount) as { id: number } | undefined;
  if (!row) return 0;
  const result = botId !== undefined
    ? d.prepare(`DELETE FROM outbound_messages WHERE bot_id = ? AND id < ?`).run(botId, row.id)
    : d.prepare(`DELETE FROM outbound_messages WHERE id < ?`).run(row.id);
  return result.changes;
}

/**
 * Claim the next pending message for this session.
 * Also claims unassigned messages if this session has no pending ones (cross-session help).
 * Sets status to 'processing' and returns the message.
 * @param botId - Scope to messages for this bot
 */
export function claimNextMessage(
  botId: number,
  sessionId: string,
  sessionName: string,
  options?: { onlyForSession?: boolean },
): QueuedMessage | null {
  const d = getDb();
  const onlyForSession = options?.onlyForSession ?? false;

  let sql: string;
  if (onlyForSession) {
    sql = `
      SELECT * FROM message_queue
      WHERE bot_id = ? AND status = 'pending'
        AND (session_name = ? OR session_id = ? OR session_name = ?)
      ORDER BY created_at ASC
      LIMIT 1
    `;
  } else {
    sql = `
      SELECT * FROM message_queue
      WHERE bot_id = ? AND status = 'pending'
        AND (
          (session_id = 'unassigned' OR session_name = 'unknown')
          OR session_id = ?
          OR session_name = ?
        )
      ORDER BY
        CASE WHEN session_id = 'unassigned' OR session_name = 'unknown' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT 1
    `;
  }

  const normalizedName = normalizeSessionName(sessionName);
  const args: (string | number)[] = onlyForSession
    ? [botId, normalizedName, `__session__:${normalizedName}`, `__session__:${normalizedName}`]
    : [botId, sessionId, sessionName];

  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d.prepare(sql).get(...args) as unknown as QueuedMessage | undefined;
    if (!row) {
      d.exec("COMMIT");
      return null;
    }

    const now = Date.now();
    const changes = d.prepare(`
      UPDATE message_queue
      SET status = 'processing', session_id = ?, session_name = ?, started_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(sessionId, sessionName, now, row.id).changes;

    d.exec("COMMIT");

    if (changes === 0) return null; // Lost the race

    row.session_id = sessionId;
    row.session_name = sessionName;
    row.status = "processing";
    row.started_at = now;
    return row;
  } catch (err) {
    try { d.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

export function claimNextMessageForSession(botId: number, sessionName: string): QueuedMessage | null {
  return claimNextMessage(botId, `__session__:${sessionName}`, sessionName, { onlyForSession: true });
}

/**
 * Claim the next pending message assigned to a *silent* session — one not in
 * the supplied alive set — so a linked session on the same bot can respond on
 * the silent session's behalf (fallback-claim policy).
 *
 * The queue is common but bot-scoped, so this never touches another bot's
 * messages, never claims a message whose owner is still alive (that owner
 * drains its own queue), and never claims unassigned messages (those flow
 * through the dedicated unassigned-claim path). The caller must itself be a
 * linked/alive session — index.ts enforces that before calling.
 */
export function claimNextMessageForSilentSession(
  botId: number,
  sessionId: string,
  sessionName: string,
  aliveSessionNames: string[],
): QueuedMessage | null {
  const d = getDb();
  const normalizedName = normalizeSessionName(sessionName);

  // Exclude the caller's own queue (drained separately), every alive session
  // (still draining itself), and the unassigned bucket (owned by another path).
  const exclude = new Set<string>(aliveSessionNames);
  exclude.add(normalizedName);
  exclude.add("unknown");
  const placeholders = Array.from(exclude).map(() => "?").join(", ");

  const sql = `
    SELECT * FROM message_queue
    WHERE bot_id = ? AND status = 'pending'
      AND session_name NOT IN (${placeholders})
    ORDER BY created_at ASC
    LIMIT 1
  `;

  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d.prepare(sql).get(botId, ...exclude) as unknown as QueuedMessage | undefined;
    if (!row) {
      d.exec("COMMIT");
      return null;
    }

    const now = Date.now();
    const changes = d.prepare(`
      UPDATE message_queue
      SET status = 'processing', session_id = ?, session_name = ?, started_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(sessionId, sessionName, now, row.id).changes;

    d.exec("COMMIT");

    if (changes === 0) return null; // Lost the race

    row.session_id = sessionId;
    row.session_name = sessionName;
    row.status = "processing";
    row.started_at = now;
    return row;
  } catch (err) {
    try { d.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
    throw err;
  }
}

export function getPendingCountForSession(botId: number, sessionName: string): number {
  const normalizedName = normalizeSessionName(sessionName);
  const row = getDb().prepare(`
    SELECT COUNT(*) as count FROM message_queue
    WHERE bot_id = ? AND status = 'pending'
      AND (session_name = ? OR session_id = ? OR session_name = ?)
  `).get(botId, normalizedName, `__session__:${normalizedName}`, `__session__:${normalizedName}`) as { count: number };
  return row.count;
}

export function resetProcessingForSession(botId: number, sessionName: string): number {
  const normalizedName = normalizeSessionName(sessionName);
  const result = getDb().prepare(`
    UPDATE message_queue
    SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL
    WHERE bot_id = ? AND status = 'processing'
      AND (session_name = ? OR session_id = ? OR session_name = ?)
  `).run(botId, normalizedName, `__session__:${normalizedName}`, `__session__:${normalizedName}`);
  return result.changes;
}

export function completeMessage(id: number, response?: string): void {
  getDb().prepare(`
    UPDATE message_queue
    SET status = 'completed', completed_at = ?, response = ?
    WHERE id = ?
  `).run(Date.now(), response || null, id);
}

export function failMessage(id: number, error: string): void {
  getDb().prepare(`
    UPDATE message_queue
    SET status = 'failed', completed_at = ?, error = ?
    WHERE id = ?
  `).run(Date.now(), error, id);
}

export function normalizeSessionName(sessionName: string): string {
  return sessionName.startsWith("__session__:") ? sessionName.slice("__session__:".length) : sessionName;
}

export function getRecentMessages(limit: number = 20, botId?: number): QueuedMessage[] {
  const whereClause = botId !== undefined ? `WHERE bot_id = ${botId}` : "";
  return getDb().prepare(`
    SELECT * FROM message_queue ${whereClause} ORDER BY created_at DESC LIMIT ?
  `).all(limit) as unknown as QueuedMessage[];
}

export function getPendingForChat(botId: number, chatId: number): QueuedMessage | null {
  return getDb().prepare(`
    SELECT * FROM message_queue
    WHERE bot_id = ? AND chat_id = ? AND status IN ('pending', 'processing')
    ORDER BY created_at ASC LIMIT 1
  `).get(botId, chatId) as unknown as QueuedMessage | null;
}

export function getSessionProcessingChat(botId: number, chatId: number): string | null {
  const row = getDb().prepare(`
    SELECT session_name FROM message_queue
    WHERE bot_id = ? AND chat_id = ? AND status = 'processing'
    LIMIT 1
  `).get(botId, chatId) as { session_name: string } | undefined;
  return row?.session_name ?? null;
}

/**
 * Find the most recent session that handled a message in a given chat on a
 * given bot. Used for shared-bot group/channel context continuity: a follow-up
 * message in a group/channel is routed to the session that already has context
 * for that chat. Scoped to a single bot — never crosses bots.
 * @returns The normalized session name, or null if no session has handled it.
 */
export function getLastSessionForChat(botId: number, chatId: number): string | null {
  const row = getDb().prepare(`
    SELECT session_name FROM message_queue
    WHERE bot_id = ? AND chat_id = ?
      AND session_name IS NOT NULL
      AND session_name NOT IN ('unknown', 'unassigned')
    ORDER BY id DESC LIMIT 1
  `).get(botId, chatId) as { session_name: string } | undefined;
  return row ? normalizeSessionName(row.session_name) : null;
}

export function recoverStaleMessages(olderThanMs: number = 60000, botId?: number): number {
  const cutoff = Date.now() - olderThanMs;
  const rows = botId !== undefined
    ? getDb().prepare(`SELECT id FROM message_queue WHERE bot_id = ? AND status = 'processing' AND (started_at IS NULL OR started_at < ?)`).all(botId, cutoff) as Array<{ id: number }>
    : getDb().prepare(`SELECT id FROM message_queue WHERE status = 'processing' AND (started_at IS NULL OR started_at < ?)`).all(cutoff) as Array<{ id: number }>;
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  getDb().prepare(`UPDATE message_queue SET status = 'pending', started_at = NULL, session_id = 'unassigned', session_name = 'unknown' WHERE id IN (${placeholders})`).run(...ids);
  return ids.length;
}

export function assignMessageToSession(id: number, sessionName: string): number {
  const normalizedName = normalizeSessionName(sessionName);
  return getDb().prepare(`UPDATE message_queue SET session_name = ?, session_id = ? WHERE id = ? AND status = 'pending'`).run(normalizedName, `__session__:${normalizedName}`, id).changes;
}

export function assignTelegramMessageToSession(botId: number, chatId: number, messageId: number, sessionName: string): number {
  const normalizedName = normalizeSessionName(sessionName);
  return getDb().prepare(`UPDATE message_queue SET session_name = ?, session_id = ? WHERE bot_id = ? AND chat_id = ? AND message_id = ? AND status = 'pending'`).run(normalizedName, `__session__:${normalizedName}`, botId, chatId, messageId).changes;
}

export function markMessageProcessing(id: number, sessionId: string, sessionName: string): number {
  const normalizedName = normalizeSessionName(sessionName);
  return getDb().prepare(`UPDATE message_queue SET status = 'processing', session_id = ?, session_name = ?, started_at = ? WHERE id = ? AND status = 'pending'`).run(sessionId, normalizedName, Date.now(), id).changes;
}

export function getQueueStats(botId?: number): QueueStats {
  const rows = (botId !== undefined
    ? getDb().prepare(`SELECT status, COUNT(*) as count FROM message_queue WHERE bot_id = ? GROUP BY status`).all(botId)
    : getDb().prepare(`SELECT status, COUNT(*) as count FROM message_queue GROUP BY status`).all()) as Array<{ status: string; count: number }>;
  const stats: QueueStats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
  for (const row of rows) {
    const key = row.status as keyof QueueStats;
    if (key in stats) stats[key] = row.count;
    stats.total += row.count;
  }
  return stats;
}

export function getQueueStatsForSession(botId: number, sessionName: string): QueueStats {
  const normalizedName = normalizeSessionName(sessionName);
  const rows = getDb().prepare(`SELECT status, COUNT(*) as count FROM message_queue WHERE bot_id = ? AND (session_name = ? OR session_id = ? OR session_name = ?) GROUP BY status`).all(botId, normalizedName, `__session__:${normalizedName}`, `__session__:${normalizedName}`) as Array<{ status: string; count: number }>;
  const stats: QueueStats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
  for (const row of rows) {
    const key = row.status as keyof QueueStats;
    if (key in stats) stats[key] = row.count;
    stats.total += row.count;
  }
  return stats;
}

export function normalizeLegacyBotIds(botId: number): number {
  if (!botId) return 0;
  const result = getDb().prepare(`UPDATE message_queue SET bot_id = ? WHERE bot_id = 0 AND status IN ('pending', 'processing')`).run(botId);
  const dlResult = getDb().prepare(`UPDATE download_queue SET bot_id = ? WHERE bot_id = 0 AND status IN ('pending', 'processing')`).run(botId);
  return result.changes + dlResult.changes;
}

export function getQueueDepth(botId: number): number {
  return (getDb().prepare(`SELECT COUNT(*) as count FROM message_queue WHERE bot_id = ? AND status IN ('pending', 'processing')`).get(botId) as { count: number }).count;
}

export function resetAllProcessing(botId?: number): number {
  return botId !== undefined
    ? getDb().prepare(`UPDATE message_queue SET status = 'pending', started_at = NULL, session_id = 'unassigned', session_name = 'unknown' WHERE bot_id = ? AND status = 'processing'`).run(botId).changes
    : getDb().prepare(`UPDATE message_queue SET status = 'pending', started_at = NULL, session_id = 'unassigned', session_name = 'unknown' WHERE status = 'processing'`).run().changes;
}

export function purgeOldMessages(keepCount: number = 1000, botId?: number): number {
  const d = getDb();
  const row = botId !== undefined
    ? d.prepare(`SELECT id FROM message_queue WHERE status IN ('completed', 'failed') AND bot_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`).get(botId, keepCount) as { id: number } | undefined
    : d.prepare(`SELECT id FROM message_queue WHERE status IN ('completed', 'failed') ORDER BY id DESC LIMIT 1 OFFSET ?`).get(keepCount) as { id: number } | undefined;
  if (!row) return 0;
  const result = botId !== undefined
    ? d.prepare(`DELETE FROM message_queue WHERE status IN ('completed', 'failed') AND bot_id = ? AND id < ?`).run(botId, row.id)
    : d.prepare(`DELETE FROM message_queue WHERE status IN ('completed', 'failed') AND id < ?`).run(row.id);
  return result.changes;
}

// ============================================================================
// Relay Session Operations
// ============================================================================

/**
 * Register or update a relay session.
 * @param botId - The bot this session is linked to
 */
export function registerRelaySession(params: {
  bot_id: number;
  session_name: string;
  session_id: string;
  pid: number;
  port: number;
  secret: string;
  project_dir?: string | null;
  capabilities?: string | null;
  description?: string | null;
  role?: "active" | "drain";
}): void {
  const d = getDb();
  const upsert = (): void => {
    d.prepare(`
    INSERT INTO relay_sessions (bot_id, session_name, session_id, pid, port, secret, project_dir, capabilities, description, role, registered_at, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, session_name) DO UPDATE SET
      session_id = excluded.session_id,
      pid = excluded.pid,
      port = excluded.port,
      secret = excluded.secret,
      project_dir = excluded.project_dir,
      capabilities = excluded.capabilities,
      description = excluded.description,
      role = excluded.role,
      last_heartbeat = excluded.last_heartbeat
  `).run(
      params.bot_id,
      params.session_name,
      params.session_id,
      params.pid,
      params.port,
      params.secret,
      params.project_dir || null,
      params.capabilities || null,
      params.description || null,
      params.role || "drain",
      Date.now(),
      Date.now(),
    );
  };

  try {
    d.exec("BEGIN IMMEDIATE");
    if (params.pid > 0) {
      d.prepare(`DELETE FROM relay_sessions WHERE session_name = ? AND pid = ? AND bot_id <> ?`).run(
        params.session_name,
        params.pid,
        params.bot_id,
      );
    }
    upsert();
    d.exec("COMMIT");
  } catch (err) {
    try { d.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }

    // Fallback for DBs that still have the old auto-index (session_name UNIQUE) — drop it and retry
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed: relay_sessions.session_name")) {
      try {
        d.exec(`DROP INDEX IF EXISTS sqlite_autoindex_relay_sessions_1`);
        d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_name ON relay_sessions(bot_id, session_name)`);
      } catch { /* ignore if index already exists */ }

      d.exec("BEGIN IMMEDIATE");
      try {
        if (params.pid > 0) {
          d.prepare(`DELETE FROM relay_sessions WHERE session_name = ? AND pid = ? AND bot_id <> ?`).run(
            params.session_name,
            params.pid,
            params.bot_id,
          );
        }
        upsert();
        d.exec("COMMIT");
      } catch (retryErr) {
        try { d.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }
}

/**
 * Update heartbeat for a relay session.
 * @param botId - Scope to this bot
 * @param sessionName - The session to update
 */
export function heartbeatRelaySession(botId: number, sessionName: string): void {
  getDb().prepare(`
    UPDATE relay_sessions SET last_heartbeat = ? WHERE bot_id = ? AND session_name = ?
  `).run(Date.now(), botId, sessionName);
}

/**
 * Unregister a relay session.
 * @param botId - Scope to this bot
 * @param sessionName - The session to unregister
 */
export function unregisterRelaySession(botId: number, sessionName: string): void {
  getDb().prepare(`
    DELETE FROM relay_sessions WHERE bot_id = ? AND session_name = ?
  `).run(botId, sessionName);
}

/**
 * Get all alive relay sessions for a specific bot.
 * @param botId - Scope to this bot (null for all bots)
 */
export function getAliveRelaySessions(botId?: number): RelaySession[] {
  const sessions = botId !== undefined
    ? getDb().prepare(`SELECT * FROM relay_sessions WHERE bot_id = ? ORDER BY registered_at ASC`).all(botId) as unknown as RelaySession[]
    : getDb().prepare(`SELECT * FROM relay_sessions ORDER BY registered_at ASC`).all() as unknown as RelaySession[];

  // Filter to only alive PIDs
  return sessions.filter(s => {
    try {
      process.kill(s.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Get a specific relay session by name.
 * @param botId - Scope to this bot
 * @param sessionName - The session name
 */
export function getRelaySession(botId: number, sessionName: string): RelaySession | null {
  return getDb().prepare(`
    SELECT * FROM relay_sessions WHERE bot_id = ? AND session_name = ?
  `).get(botId, sessionName) as unknown as RelaySession | null;
}

/**
 * Get the primary session for a bot.
 * @param botId - The bot to query
 * @returns The session marked as primary, or null if none
 */
export function getPrimarySession(botId: number): RelaySession | null {
  return getDb().prepare(`
    SELECT * FROM relay_sessions WHERE bot_id = ? AND is_primary = 1
  `).get(botId) as unknown as RelaySession | null;
}

/**
 * Set a session as primary for a bot.
 * Clears the is_primary flag from all other sessions for this bot first.
 * @param botId - The bot
 * @param sessionName - The session to make primary
 */
export function setPrimary(botId: number, sessionName: string): void {
  const d = getDb();
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare(`UPDATE relay_sessions SET is_primary = 0 WHERE bot_id = ?`).run(botId);
    d.prepare(`UPDATE relay_sessions SET is_primary = 1 WHERE bot_id = ? AND session_name = ?`).run(botId, sessionName);
    d.exec("COMMIT");
  } catch {
    d.exec("ROLLBACK");
    throw new Error(`Failed to set primary session: ${sessionName} for bot ${botId}`);
  }
}
/**
 * Clean stale relay sessions (dead PIDs).
 * Returns the number of removed sessions.
 * @param botId - Scope to this bot (null for all bots)
 */
export function cleanStaleRelaySessions(botId?: number): number {
  const sessions = botId !== undefined
    ? getDb().prepare(`SELECT bot_id, session_name, pid FROM relay_sessions WHERE bot_id = ?`).all(botId) as Array<{ session_name: string; pid: number; bot_id: number }>
    : getDb().prepare(`SELECT bot_id, session_name, pid FROM relay_sessions`).all() as Array<{ session_name: string; pid: number; bot_id: number }>;

  let removed = 0;
  for (const s of sessions) {
    try {
      process.kill(s.pid, 0);
    } catch {
      getDb().prepare(`DELETE FROM relay_sessions WHERE bot_id = ? AND session_name = ?`).run(s.bot_id, s.session_name);
      removed++;
    }
  }
  return removed;
}

/**
 * Update capabilities for a relay session.
 * @param botId - Scope to this bot
 * @param sessionName - The session to update
 */
export function updateRelayCapabilities(botId: number, sessionName: string, capabilities: string, description: string): void {
  getDb().prepare(`
    UPDATE relay_sessions SET capabilities = ?, description = ? WHERE bot_id = ? AND session_name = ?
  `).run(capabilities, description, botId, sessionName);
}

/**
 * Update role for a relay session.
 * @param botId - Scope to this bot
 * @param sessionName - The session to update
 */
export function updateRelayRole(botId: number, sessionName: string, role: "active" | "drain"): void {
  getDb().prepare(`
    UPDATE relay_sessions SET role = ? WHERE bot_id = ? AND session_name = ?
  `).run(role, botId, sessionName);
}

// ============================================================================
// Relay History Operations
// ============================================================================

/**
 * Log a relay forward event.
 */
export function logRelayForward(params: {
  from_session: string;
  to_session: string;
  chat_id: number;
  command: string;
  success: boolean;
  error?: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO relay_history (from_session, to_session, chat_id, command, success, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.from_session,
    params.to_session,
    params.chat_id,
    params.command,
    params.success ? 1 : 0,
    params.error || null,
  );
}

/**
 * Get recent relay history.
 */
export function getRecentRelayHistory(limit: number = 50): Array<{
  from_session: string;
  to_session: string;
  chat_id: number;
  command: string;
  success: number;
  error: string | null;
  created_at: number;
}> {
  return getDb().prepare(`
    SELECT * FROM relay_history ORDER BY created_at DESC LIMIT ?
  `).all(limit) as Array<{
    from_session: string;
    to_session: string;
    chat_id: number;
    command: string;
    success: number;
    error: string | null;
    created_at: number;
  }>;
}

// ============================================================================
// Download Queue Operations
// ============================================================================

const MAX_DOWNLOAD_RETRIES = 3;

/**
 * Enqueue a download URL.
 * Returns the row ID.
 * @param botId - The bot that received the message containing this download
 */
export function enqueueDownload(params: {
  bot_id: number;
  chat_id: number;
  message_id: number;
  url: string;
  source?: string;
  session_name?: string;
}): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO download_queue (bot_id, chat_id, message_id, url, source, session_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.bot_id,
    params.chat_id,
    params.message_id,
    params.url,
    params.source || "twitter",
    params.session_name || "data-scrapper",
  );
  const row = d.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
  return row.id;
}

/**
 * Add multiple download URLs at once (batch insert).
 * Returns the count of items inserted.
 * @param botId - The bot that received the messages containing these downloads
 */
export function enqueueDownloads(botId: number, params: Array<{
  chat_id: number;
  message_id: number;
  url: string;
  source?: string;
  session_name?: string;
}>): number {
  if (params.length === 0) return 0;
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO download_queue (bot_id, chat_id, message_id, url, source, session_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  d.exec("BEGIN TRANSACTION");
  try {
    for (const p of params) {
      stmt.run(botId, p.chat_id, p.message_id, p.url, p.source || "twitter", p.session_name || "data-scrapper");
      count++;
    }
    d.exec("COMMIT");
  } catch {
    d.exec("ROLLBACK");
    throw new Error(`Batch insert failed: ${count}/${params.length} inserted before error`);
  }
  return count;
}

/**
 * Claim the next pending download for a session.
 * @param botId - Scope to this bot's queue (null for any bot)
 */
export function claimNextDownload(botId?: number): DownloadItem | null {
  const d = getDb();
  const whereClause = botId !== undefined ? `WHERE bot_id = ${botId} AND` : "WHERE";
  const row = d.prepare(`
    SELECT * FROM download_queue
    ${whereClause} status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as unknown as DownloadItem | undefined;

  if (!row) return null;

  const now = Date.now();
  d.prepare(`
    UPDATE download_queue
    SET status = 'processing', started_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, row.id);

  row.status = "processing";
  row.started_at = now;
  return row;
}

/**
 * Mark a download as completed with a result (JSON string of media paths).
 */
export function completeDownload(id: number, result: string): void {
  getDb().prepare(`
    UPDATE download_queue
    SET status = 'completed', completed_at = ?, result = ?
    WHERE id = ?
  `).run(Date.now(), result, id);
}

/**
 * Mark a download as failed. Increments retry_count.
 * If retry_count >= MAX_DOWNLOAD_RETRIES, marks as permanently failed.
 */
export function failDownload(id: number, error: string): void {
  const d = getDb();
  const row = d.prepare(`SELECT retry_count FROM download_queue WHERE id = ?`).get(id) as { retry_count: number } | undefined;
  if (!row) return;

  const newCount = row.retry_count + 1;
  if (newCount >= MAX_DOWNLOAD_RETRIES) {
    d.prepare(`
      UPDATE download_queue
      SET status = 'failed', completed_at = ?, error = ?
      WHERE id = ?
    `).run(Date.now(), error, id);
  } else {
    d.prepare(`
      UPDATE download_queue
      SET status = 'pending', retry_count = ?, error = ?
      WHERE id = ?
    `).run(newCount, error, id);
  }
}

/**
 * Get download queue statistics.
 * @param botId - Scope to this bot's queue (null for all bots)
 */
export function getDownloadStats(botId?: number): QueueStats {
  const whereClause = botId !== undefined ? `WHERE bot_id = ${botId}` : "";
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) as count FROM download_queue ${whereClause} GROUP BY status
  `).all() as Array<{ status: string; count: number }>;


  const stats: QueueStats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
  for (const row of rows) {
    const key = row.status as keyof QueueStats;
    if (key in stats) stats[key] = row.count;
    stats.total += row.count;
  }
  return stats;
}

/**
 * Get download queue depth (pending + processing).
 * @param botId - Scope to this bot's queue (null for all bots)
 */
export function getDownloadDepth(botId?: number): number {
  const whereClause = botId !== undefined ? `WHERE bot_id = ${botId} AND` : "WHERE";
  const row = getDb().prepare(`
    SELECT COUNT(*) as count FROM download_queue ${whereClause} status IN ('pending', 'processing')
  `).get() as { count: number };
  return row.count;
}

/**
 * Recover stale "processing" downloads back to "pending".
 * @param botId - Scope to this bot's queue (null for all bots)
 */
export function recoverStaleDownloads(olderThanMs: number = 120000, botId?: number): number {
  const cutoff = Date.now() - olderThanMs;
  let sql = `
    UPDATE download_queue
    SET status = 'pending', started_at = NULL
    WHERE status = 'processing' AND (started_at IS NULL OR started_at < ?)
  `;
  const args: (number | undefined)[] = [cutoff];
  
  if (botId !== undefined) {
    sql = `
      UPDATE download_queue
      SET status = 'pending', started_at = NULL
      WHERE bot_id = ? AND status = 'processing' AND (started_at IS NULL OR started_at < ?)
    `;
    args.unshift(botId);
  }

  const result = getDb().prepare(sql).run(...args);
  return result.changes;
}

/**
 * Reset a download to pending (manual retry).
 */
export function resetDownload(id: number): void {
  getDb().prepare(`
    UPDATE download_queue
    SET status = 'pending', retry_count = 0, error = NULL
    WHERE id = ?
  `).run(id);
}

/**
 * Reset all failed downloads to pending.
 * @param botId - Scope to this bot's queue (null for all bots)
 */
export function resetAllFailedDownloads(botId?: number): number {
  let sql = `
    UPDATE download_queue
    SET status = 'pending', retry_count = 0, error = NULL
    WHERE status = 'failed'
  `;
  const args: number[] = [];
  
  if (botId !== undefined) {
    sql = `
      UPDATE download_queue
      SET status = 'pending', retry_count = 0, error = NULL
      WHERE bot_id = ? AND status = 'failed'
    `;
    args.push(botId);
  }

  const result = getDb().prepare(sql).run(...args);
  return result.changes;
}

/**
 * Get recent downloads (for status display).
 * @param botId - Scope to this bot's queue (null for all bots)
 */
export function getRecentDownloads(limit: number = 50, botId?: number): DownloadItem[] {
  const whereClause = botId !== undefined ? `WHERE bot_id = ${botId}` : "";
  return getDb().prepare(`
    SELECT * FROM download_queue ${whereClause} ORDER BY created_at DESC LIMIT ?
  `).all(limit) as unknown as DownloadItem[];
}

// Export the getDb function so index.ts can use it for ad-hoc queries
export { getDb };

/**
 * Run all startup recovery tasks.
 * Returns a summary of what was recovered.
 * @param botId - Optional bot to scope recovery to (null for all bots)
 */
export function runStartupRecovery(botId?: number): {
  recoveredMessages: number;
  cleanedSessions: number;
  recoveredDownloads: number;
  mergedFromLocal?: number;
} {
  const recoveredMessages = recoverStaleMessages(60000, botId);
  const cleanedSessions = cleanStaleRelaySessions(botId);
  const recoveredDownloads = recoverStaleDownloads(120000, botId);

  // Also purge old completed/failed messages (keep last 1000)
  purgeOldMessages(1000, botId);
  purgeOldOutboundMessages(1000, botId);

  // Merge session_name from local DB if it differs from shared DB.
  // This handles the case where the poll worker was writing to a local DB
  // (before the dbPath fix) while session_name was populated by index.ts.
  // On startup, we sync the authoritative session_name from the local DB.
  const mergedFromLocal = mergeLocalSessionNames();

  return { recoveredMessages, cleanedSessions, recoveredDownloads, mergedFromLocal };
}

/**
 * Merge session_name from local project DBs into the shared DB.
 *
 * Before the dbPath fix, the poll worker wrote to a local `./teleg-bridge.db`
 * while session_name was correctly populated by index.ts in that local DB.
 * The shared DB would have the same message rows but with session_name='unknown'.
 *
 * This function syncs session_name from any detected local DBs for rows in the
 * shared DB that have session_name='unknown' but the same message_id in the local DB.
 */
function mergeLocalSessionNames(): number {
  const db = getDb();
  // Legacy recovery should only look at the DB alongside the deployed extension,
  // not at arbitrary development checkouts.
  const localDbPaths = [
    join(dirname(__dirname), "teleg-bridge.db"),
  ];
  let merged = 0;
  for (const localPath of localDbPaths) {
    if (!existsSync(localPath)) continue;
    try {
      const localDb = new DatabaseSync(localPath);
      localDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const localRows = localDb.prepare(
        "SELECT message_id, session_name, status FROM message_queue WHERE session_name != 'unknown'"
      ).all() as Array<{ message_id: number; session_name: string; status: string }>;
      for (const row of localRows) {
        const result = db.prepare(
          "UPDATE message_queue SET session_name = ?, session_id = ? WHERE message_id = ? AND session_name = 'unknown'"
        ).run(row.session_name, row.session_name, row.message_id);
        if (result.changes > 0) merged++;
      }
      localDb.close();
    } catch { /* best effort */ }
  }
  return merged;
}

// ═══════════════════════════════════════════════════════════════════════
// PUB-SUB: Inter-session messaging
// ═══════════════════════════════════════════════════════════════════════

export interface PubSubMessage {
  id: number;
  bot_id: number;
  channel: string;
  publisher: string;
  payload: string;
  target_session: string | null;
  consumed_by: string | null;
  created_at: number;
  consumed_at: number | null;
}

/** Publish a message to a channel */
export function publish(botId: number, channel: string, publisher: string, payload: string, targetSession?: string): number {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO pubsub (bot_id, channel, publisher, payload, target_session) VALUES (?, ?, ?, ?, ?)"
  ).run(botId, channel, publisher, payload, targetSession || null);
  return Number(result.lastInsertRowid);
}

/** Subscribe: consume all unconsumed messages for a channel (or targeted at this session) */
export function subscribe(botId: number, sessionName: string, channels: string[]): PubSubMessage[] {
  const db = getDb();
  const placeholders = channels.map(() => "?").join(",");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Get unconsumed messages for our channels OR targeted at us
    const rows = db.prepare(
      `SELECT * FROM pubsub WHERE bot_id = ? AND consumed_at IS NULL AND (
        channel IN (${placeholders}) AND (target_session IS NULL OR target_session = ?)
      ) ORDER BY id ASC`
    ).all(botId, ...channels, sessionName) as unknown as PubSubMessage[];
    // Mark as consumed
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      db.prepare(
        `UPDATE pubsub SET consumed_by = ?, consumed_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`
      ).run(sessionName, Date.now(), ...ids);
    }
    db.exec("COMMIT");
    return rows;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Scan: like subscribe but doesn't consume — just peek */
export function pubsubScan(botId: number, channels: string[]): PubSubMessage[] {
  const db = getDb();
  const placeholders = channels.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM pubsub WHERE bot_id = ? AND consumed_at IS NULL AND channel IN (${placeholders}) ORDER BY id ASC`
  ).all(botId, ...channels) as unknown as PubSubMessage[];
}

/** Clean up old consumed messages */
export function pubsubPurge(olderThanMs: number = 86400000): number {
  const db = getDb();
  const cutoff = Date.now() - olderThanMs;
  return db.prepare("DELETE FROM pubsub WHERE consumed_at IS NOT NULL AND consumed_at < ?").run(cutoff).changes;
}
