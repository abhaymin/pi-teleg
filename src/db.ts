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

const __dirname = dirname(fileURLToPath(import.meta.url));

// DB path: env override → shared default
const DEFAULT_DB_PATH = join(process.env.HOME || "~", ".pi", "agent", "teleg-bridge.db");
const DB_PATH = process.env.TELEG_DB_PATH || DEFAULT_DB_PATH;

// ============================================================================
// Types
// ============================================================================

export interface QueuedMessage {
  id: number;
  chat_id: number;
  message_id: number;
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
}

export interface RelaySession {
  id: number;
  session_name: string;
  session_id: string;
  pid: number;
  port: number;
  secret: string;
  project_dir: string | null;
  capabilities: string | null; // JSON array
  description: string | null;
  role: "active" | "passive";
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
    initSchema(db);
  }
  return db;
}

function initSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id           INTEGER NOT NULL,
      message_id        INTEGER NOT NULL,
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
      response          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON message_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_session ON message_queue(session_id);
    CREATE INDEX IF NOT EXISTS idx_queue_chat ON message_queue(chat_id);
    -- Prevent duplicate message insertions (Telegram redelivers on reconnect)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_dedup ON message_queue(chat_id, message_id);

    CREATE TABLE IF NOT EXISTS download_queue (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
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

    CREATE TABLE IF NOT EXISTS relay_sessions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      session_name      TEXT NOT NULL UNIQUE,
      session_id        TEXT NOT NULL,
      pid               INTEGER NOT NULL,
      port              INTEGER NOT NULL,
      secret            TEXT NOT NULL,
      project_dir       TEXT,
      capabilities      TEXT,
      description       TEXT,
      role              TEXT NOT NULL DEFAULT 'passive' CHECK (role IN ('active', 'passive')),
      registered_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      last_heartbeat    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_relay_pid ON relay_sessions(pid);
    CREATE INDEX IF NOT EXISTS idx_relay_name ON relay_sessions(session_name);

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
 */
export function enqueueMessage(params: {
  chat_id: number;
  message_id: number;
  from_user_id: number;
  from_username?: string | null;
  text: string;
  session_id?: string;
  session_name?: string;
  source?: "telegram" | "relay";
  source_session?: string | null;
}): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO message_queue (chat_id, message_id, from_user_id, from_username, text, session_id, session_name, source, source_session)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.chat_id,
    params.message_id,
    params.from_user_id,
    params.from_username || null,
    params.text,
    params.session_id || "unassigned",
    params.session_name || "unknown",
    params.source || "telegram",
    params.source_session || null,
  );
  // Get the last inserted row ID
  const row = d.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
  return row.id;
}

/**
 * Claim the next pending message for this session.
 * Also claims unassigned messages if this session has no pending ones (cross-session help).
 * Sets status to 'processing' and returns the message.
 */
export function claimNextMessage(
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
      WHERE status = 'pending'
        AND (session_name = ? OR session_id = 'unassigned')
      ORDER BY
        CASE WHEN session_id = 'unassigned' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT 1
    `;
  } else {
    sql = `
      SELECT * FROM message_queue
      WHERE status = 'pending'
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

  const args: string[] = onlyForSession ? [sessionName] : [sessionId, sessionName];
  const row = d.prepare(sql).get(...args) as unknown as QueuedMessage | undefined;

  if (!row) return null;

  const now = Date.now();
  d.prepare(`
    UPDATE message_queue
    SET status = 'processing', session_id = ?, session_name = ?, started_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(sessionId, sessionName, now, row.id);

  row.session_id = sessionId;
  row.session_name = sessionName;
  row.status = "processing";
  row.started_at = now;
  return row;
}

/**
 * Claim the next pending message strictly for this session.
 * Does NOT skip ahead to unassigned messages — strict session affinity.
 */
export function claimNextMessageForSession(sessionName: string): QueuedMessage | null {
  return claimNextMessage(`__session__:${sessionName}`, sessionName, { onlyForSession: true });
}

/**
 * Get count of pending messages for a specific session.
 */
export function getPendingCountForSession(sessionName: string): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as count FROM message_queue
    WHERE status = 'pending'
      AND (session_name = ? OR session_id = ?)
  `).get(sessionName, `__session__:${sessionName}`) as { count: number };
  return row.count;
}

/**
 * Reset ALL processing messages for a session back to pending.
 * Used for crash recovery when a session loses its active turns unexpectedly.
 */
export function resetProcessingForSession(sessionName: string): number {
  const result = getDb().prepare(`
    UPDATE message_queue
    SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL
    WHERE status = 'processing'
      AND (session_name = ? OR session_id = ?)
  `).run(sessionName, `__session__:${sessionName}`);
  return result.changes;
}

/**
 * Mark a message as completed with an optional response.
 */
export function completeMessage(id: number, response?: string): void {
  getDb().prepare(`
    UPDATE message_queue
    SET status = 'completed', completed_at = ?, response = ?
    WHERE id = ?
  `).run(Date.now(), response || null, id);
}

/**
 * Mark a message as failed with an error.
 */
export function failMessage(id: number, error: string): void {
  getDb().prepare(`
    UPDATE message_queue
    SET status = 'failed', completed_at = ?, error = ?
    WHERE id = ?
  `).run(Date.now(), error, id);
}

/**
 * Get the current queue depth (pending + processing).
 */
export function getQueueDepth(): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as count FROM message_queue WHERE status IN ('pending', 'processing')
  `).get() as { count: number };
  return row.count;
}

/**
 * Get queue statistics.
 */
export function getQueueStats(): QueueStats {
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) as count FROM message_queue GROUP BY status
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
 * Recover stale "processing" messages back to "pending".
 * Called on startup to handle messages that were being processed when a crash occurred.
 * Returns the number of recovered messages.
 */
export function recoverStaleMessages(olderThanMs: number = 60000): number {
  const cutoff = Date.now() - olderThanMs;
  const result = getDb().prepare(`
    UPDATE message_queue
    SET status = 'pending', started_at = NULL, session_id = 'unassigned', session_name = 'unknown'
    WHERE status = 'processing' AND (started_at IS NULL OR started_at < ?)
  `).run(cutoff);
  return result.changes;
}

/**
 * Get recent messages (for status display and debugging).
 */
export function getRecentMessages(limit: number = 20): QueuedMessage[] {
  return getDb().prepare(`
    SELECT * FROM message_queue ORDER BY created_at DESC LIMIT ?
  `).all(limit) as unknown as QueuedMessage[];
}

/**
 * Get pending messages for a specific chat (used for session affinity).
 */
export function getPendingForChat(chatId: number): QueuedMessage | null {
  return getDb().prepare(`
    SELECT * FROM message_queue
    WHERE chat_id = ? AND status IN ('pending', 'processing')
    ORDER BY created_at ASC LIMIT 1
  `).get(chatId) as unknown as QueuedMessage | null;
}

/**
 * Purge old completed/failed messages (housekeeping).
 * Keeps the most recent `keepCount` items.
 */
export function purgeOldMessages(keepCount: number = 1000): number {
  const d = getDb();
  // Find the ID threshold
  const row = d.prepare(`
    SELECT id FROM message_queue
    WHERE status IN ('completed', 'failed')
    ORDER BY id DESC LIMIT 1 OFFSET ?
  `).get(keepCount) as { id: number } | undefined;

  if (!row) return 0;

  const result = d.prepare(`
    DELETE FROM message_queue WHERE status IN ('completed', 'failed') AND id < ?
  `).run(row.id);
  return result.changes;
}

/**
 * Reset all processing messages to pending (for manual recovery).
 */
export function resetAllProcessing(): number {
  const result = getDb().prepare(`
    UPDATE message_queue
    SET status = 'pending', started_at = NULL, session_id = 'unassigned', session_name = 'unknown'
    WHERE status = 'processing'
  `).run();
  return result.changes;
}

// ============================================================================
// Relay Session Operations
// ============================================================================

/**
 * Register or update a relay session.
 */
export function registerRelaySession(params: {
  session_name: string;
  session_id: string;
  pid: number;
  port: number;
  secret: string;
  project_dir?: string | null;
  capabilities?: string | null;
  description?: string | null;
  role?: "active" | "passive";
}): void {
  getDb().prepare(`
    INSERT INTO relay_sessions (session_name, session_id, pid, port, secret, project_dir, capabilities, description, role, registered_at, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_name) DO UPDATE SET
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
    params.session_name,
    params.session_id,
    params.pid,
    params.port,
    params.secret,
    params.project_dir || null,
    params.capabilities || null,
    params.description || null,
    params.role || "passive",
    Date.now(),
    Date.now(),
  );
}

/**
 * Update heartbeat for a relay session.
 */
export function heartbeatRelaySession(sessionName: string): void {
  getDb().prepare(`
    UPDATE relay_sessions SET last_heartbeat = ? WHERE session_name = ?
  `).run(Date.now(), sessionName);
}

/**
 * Unregister a relay session.
 */
export function unregisterRelaySession(sessionName: string): void {
  getDb().prepare(`
    DELETE FROM relay_sessions WHERE session_name = ?
  `).run(sessionName);
}

/**
 * Get all alive relay sessions.
 */
export function getAliveRelaySessions(): RelaySession[] {
  const sessions = getDb().prepare(`
    SELECT * FROM relay_sessions ORDER BY registered_at ASC
  `).all() as unknown as RelaySession[];

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
 */
export function getRelaySession(sessionName: string): RelaySession | null {
  return getDb().prepare(`
    SELECT * FROM relay_sessions WHERE session_name = ?
  `).get(sessionName) as unknown as RelaySession | null;
}

/**
 * Clean stale relay sessions (dead PIDs).
 * Returns the number of removed sessions.
 */
export function cleanStaleRelaySessions(): number {
  const sessions = getDb().prepare(`
    SELECT session_name, pid FROM relay_sessions
  `).all() as Array<{ session_name: string; pid: number }>;

  let removed = 0;
  for (const s of sessions) {
    try {
      process.kill(s.pid, 0);
    } catch {
      getDb().prepare(`DELETE FROM relay_sessions WHERE session_name = ?`).run(s.session_name);
      removed++;
    }
  }
  return removed;
}

/**
 * Update capabilities for a relay session.
 */
export function updateRelayCapabilities(sessionName: string, capabilities: string, description: string): void {
  getDb().prepare(`
    UPDATE relay_sessions SET capabilities = ?, description = ? WHERE session_name = ?
  `).run(capabilities, description, sessionName);
}

/**
 * Update role for a relay session.
 */
export function updateRelayRole(sessionName: string, role: "active" | "passive"): void {
  getDb().prepare(`
    UPDATE relay_sessions SET role = ? WHERE session_name = ?
  `).run(role, sessionName);
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
 */
export function enqueueDownload(params: {
  chat_id: number;
  message_id: number;
  url: string;
  source?: string;
  session_name?: string;
}): number {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO download_queue (chat_id, message_id, url, source, session_name)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
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
 */
export function enqueueDownloads(params: Array<{
  chat_id: number;
  message_id: number;
  url: string;
  source?: string;
  session_name?: string;
}>): number {
  if (params.length === 0) return 0;
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO download_queue (chat_id, message_id, url, source, session_name)
    VALUES (?, ?, ?, ?, ?)
  `);
  let count = 0;
  d.exec("BEGIN TRANSACTION");
  try {
    for (const p of params) {
      stmt.run(p.chat_id, p.message_id, p.url, p.source || "twitter", p.session_name || "data-scrapper");
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
 */
export function claimNextDownload(sessionName: string): DownloadItem | null {
  const d = getDb();
  const row = d.prepare(`
    SELECT * FROM download_queue
    WHERE status = 'pending'
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
 */
export function getDownloadStats(): QueueStats {
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) as count FROM download_queue GROUP BY status
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
 */
export function getDownloadDepth(): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) as count FROM download_queue WHERE status IN ('pending', 'processing')
  `).get() as { count: number };
  return row.count;
}

/**
 * Recover stale "processing" downloads back to "pending".
 */
export function recoverStaleDownloads(olderThanMs: number = 120000): number {
  const cutoff = Date.now() - olderThanMs;
  const result = getDb().prepare(`
    UPDATE download_queue
    SET status = 'pending', started_at = NULL
    WHERE status = 'processing' AND (started_at IS NULL OR started_at < ?)
  `).run(cutoff);
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
 */
export function resetAllFailedDownloads(): number {
  const result = getDb().prepare(`
    UPDATE download_queue
    SET status = 'pending', retry_count = 0, error = NULL
    WHERE status = 'failed'
  `).run();
  return result.changes;
}

/**
 * Get recent downloads (for status display).
 */
export function getRecentDownloads(limit: number = 50): DownloadItem[] {
  return getDb().prepare(`
    SELECT * FROM download_queue ORDER BY created_at DESC LIMIT ?
  `).all(limit) as unknown as DownloadItem[];
}

// Export the getDb function so index.ts can use it for ad-hoc queries
export { getDb };

/**
 * Run all startup recovery tasks.
 * Returns a summary of what was recovered.
 */
export function runStartupRecovery(): {
  recoveredMessages: number;
  cleanedSessions: number;
  recoveredDownloads: number;
  mergedFromLocal?: number;
} {
  const recoveredMessages = recoverStaleMessages();
  const cleanedSessions = cleanStaleRelaySessions();
  const recoveredDownloads = recoverStaleDownloads();

  // Also purge old completed/failed messages (keep last 1000)
  purgeOldMessages(1000);

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
  // Known local DB paths from before the dbPath fix
  const localDbPaths = [
    join(process.env.HOME || "~", "Development", "PTGD", "teleg", "teleg-bridge.db"),
    join(process.env.HOME || "~", "Development", "PTGD", "data-scrapper", "teleg-bridge.db"),
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
