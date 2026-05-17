/**
 * Persistent SQLite database for teleg-bridge.
 *
 * Stores:
 *   - Message queue (survives crashes/restarts, shared across relay sessions)
 *   - Relay session registry (replaces JSON files in ~/.pi/agent/tmp/teleg-relay/)
 *   - Queue processing history (completed/failed items for status reporting)
 *
 * DB location: <projectRoot>/teleg-bridge.db
 *   (alongside the extension code, created on first run)
 */

import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// DB lives next to dist/ (in the project root)
const DB_PATH = join(__dirname, "..", "teleg-bridge.db");

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
 * Claim the next pending message for a session.
 * Sets status to 'processing' and returns the message.
 */
export function claimNextMessage(sessionId: string, sessionName: string): QueuedMessage | null {
  const d = getDb();
  // Find next pending message (prefer unassigned, then matching session)
  const row = d.prepare(`
    SELECT * FROM message_queue
    WHERE status = 'pending'
    ORDER BY
      CASE WHEN session_id = 'unassigned' THEN 0 ELSE 1 END,
      created_at ASC
    LIMIT 1
  `).get() as unknown as QueuedMessage | undefined;

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

// Export the getDb function so index.ts can use it for ad-hoc queries
export { getDb };

/**
 * Run all startup recovery tasks.
 * Returns a summary of what was recovered.
 */
export function runStartupRecovery(): {
  recoveredMessages: number;
  cleanedSessions: number;
} {
  const recoveredMessages = recoverStaleMessages();
  const cleanedSessions = cleanStaleRelaySessions();

  // Also purge old completed/failed messages (keep last 1000)
  purgeOldMessages(1000);

  return { recoveredMessages, cleanedSessions };
}
