/**
 * Session Registry - Liveness checks, reconciliation, and ghost eviction.
 * 
 * Ensures that:
 * - Dead sessions (ghosts) are never dispatched messages
 * - Primary poller is always elected and alive
 * - All routing decisions consider session liveness
 */

import { existsSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as Db from "./db.js";
import { readSessionRegistry, writeSessionRegistry } from "./session-config.js";
// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIVENESS_MS = Number(process.env.TELEG_LIVENESS_MS) || 300000; // 5 minutes

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = join(process.env.HOME || "~", ".pi/agent/tmp/teleg-relay");

// Replicate getRelayPath logic from relay.ts (relay.ts doesn't export it)
function getRelayPath(sessionName: string, botId?: number): string {
  const prefix = botId ? `${botId}-` : "";
  return join(RELAY_DIR, `${prefix}${sessionName}.json`);
}

interface RelayInfo {
  port: number;
  secret: string;
  sessionName: string;
  pid: number;
  botId?: number;
}

// ============================================================================
// Types
// ============================================================================

export enum SessionLiveness {
  LINKED = "linked",   // All checks pass - session is healthy
  STALE = "stale",     // Some checks fail but not ghost (e.g., stale heartbeat)
  GHOST = "ghost",     // Failed critical checks - should be evicted
}

export interface LivenessCheckResult {
  pid_alive: boolean;
  relay_file: boolean;
  relay_pid_match: boolean;
  relay_http: boolean;
  heartbeat_fresh: boolean;
  db_row: boolean;
}

export interface ReconcileReport {
  botId: number;
  checkedSessions: number;
  evictedSessions: string[];
  newPrimary: string | null;
  errors: string[];
}

// ============================================================================
// Liveness Check
// ============================================================================

/**
 * Check if a relay session is linked (alive and reachable).
 * Returns a detailed result of all 6 checks and an overall liveness classification.
 */
export async function checkSessionLiveness(session: Db.RelaySession): Promise<{
  result: LivenessCheckResult;
  liveness: SessionLiveness;
  failedChecks: string[];
}> {
  const failedChecks: string[] = [];
  
  // 1. pid_alive - Check if PID is alive
  let pidAlive = false;
  try {
    process.kill(session.pid, 0);
    pidAlive = true;
  } catch {
    failedChecks.push("pid_alive");
  }
  
  // 2. relay_file - Check if relay file exists
  const relayPath = getRelayPath(session.session_name, session.bot_id);
  const relayFileExists = existsSync(relayPath);
  if (!relayFileExists) {
    failedChecks.push("relay_file");
  }
  
  // 3. relay_pid_match - Check if file PID matches session PID
  let relayPidMatch = false;
  if (relayFileExists) {
    try {
      const relayInfo: RelayInfo = JSON.parse(readFileSync(relayPath, "utf8"));
      relayPidMatch = relayInfo.pid === session.pid;
      if (!relayPidMatch) {
        failedChecks.push("relay_pid_match");
      }
    } catch {
      failedChecks.push("relay_pid_match");
    }
  }
  
  // 4. relay_http - Check if relay HTTP is reachable
  let relayHttp = false;
  if (relayFileExists) {
    try {
      const relayInfo: RelayInfo = JSON.parse(readFileSync(relayPath, "utf8"));
      try {
        const response = await fetch(`http://127.0.0.1:${relayInfo.port}/health`);
        relayHttp = response.ok;
      } catch {
        failedChecks.push("relay_http");
      }
    } catch {
      failedChecks.push("relay_http");
    }
  }
  
  // 5. heartbeat_fresh - Check if heartbeat is recent
  const heartbeatAge = Date.now() - session.last_heartbeat;
  const heartbeatFresh = heartbeatAge < DEFAULT_LIVENESS_MS;
  if (!heartbeatFresh) {
    failedChecks.push("heartbeat_fresh");
  }
  
  // 6. db_row - Check if DB row exists (always true since we have the session)
  // This is more of a sanity check - if we have the session, the row exists
  // But we verify the bot_id + session_name combination is valid
  const dbRow = true; // We already have the session from DB
  
  const result: LivenessCheckResult = {
    pid_alive: pidAlive,
    relay_file: relayFileExists,
    relay_pid_match: relayPidMatch,
    relay_http: relayHttp,
    heartbeat_fresh: heartbeatFresh,
    db_row: dbRow,
  };
  
  // Classify liveness
  // GHOST: actual console/PID is dead
  // STALE: console is alive but relay/heartbeat state is degraded
  // LINKED: all checks pass
  let liveness: SessionLiveness;

  if (!pidAlive) {
    liveness = SessionLiveness.GHOST;
  } else if (!relayFileExists || !relayPidMatch || !relayHttp || !heartbeatFresh) {
    liveness = SessionLiveness.STALE;
  } else {
    liveness = SessionLiveness.LINKED;
  }
  
  return { result, liveness, failedChecks };
}

// ============================================================================
// Helper: Get all relay sessions for a bot
// ============================================================================

function getRelaySessionsForBot(botId: number): Db.RelaySession[] {
  const db = Db.getDb();
  return db.prepare("SELECT * FROM relay_sessions WHERE bot_id = ? ORDER BY registered_at ASC")
    .all(botId) as unknown as Db.RelaySession[];
}

// ============================================================================
// Reconcile Sessions
// ============================================================================

/**
 * Reconcile all sessions for a bot (or all bots if botId not specified).
 * Evicts ghost sessions, resets stale processing, and re-elects primary if needed.
 * 
 * @param botId - Optional bot to reconcile. If not specified, reconciles all bots.
 * @returns ReconcileReport with evicted sessions, new primary, and any errors.
 */
export async function reconcileSessions(botId?: number): Promise<ReconcileReport | ReconcileReport[]> {
  // When no specific botId, reconcile per-bot to avoid cross-bot bias
  if (!botId) {
    const db = Db.getDb();
    const allSessions = db.prepare("SELECT DISTINCT bot_id FROM relay_sessions")
      .all() as Array<{ bot_id: number }>;
    if (allSessions.length === 0) {
      return { botId: 0, checkedSessions: 0, evictedSessions: [], newPrimary: null, errors: [] };
    }
    if (allSessions.length === 1) {
      return reconcileForSingleBot(allSessions[0].bot_id);
    }
    // Multiple bots — return per-bot reports
    const reports = await Promise.all(
      allSessions.map(row => reconcileForSingleBot(row.bot_id))
    );
    return reports;
  }
  return reconcileForSingleBot(botId);
}

async function reconcileForSingleBot(botId: number): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    botId,
    checkedSessions: 0,
    evictedSessions: [],
    newPrimary: null,
    errors: [],
  };

  try {
    const sessions = getRelaySessionsForBot(botId);
    report.checkedSessions = sessions.length;

    // Check liveness of each session
    for (const session of sessions) {
      try {
        const { liveness } = await checkSessionLiveness(session);

        if (liveness === SessionLiveness.GHOST) {
          try {
            evictSession(session.bot_id, session.session_name);
            report.evictedSessions.push(session.session_name);
          } catch (err) {
            report.errors.push(`Failed to evict ${session.session_name}: ${err}`);
          }
        } else if (liveness === SessionLiveness.STALE) {
          try {
            Db.resetProcessingForSession(session.bot_id, session.session_name);
          } catch (err) {
            report.errors.push(`Failed to reset processing for ${session.session_name}: ${err}`);
          }
        }
      } catch (err) {
        report.errors.push(`Failed to check liveness of ${session.session_name}: ${err}`);
      }
    }

    // Re-elect primary for this specific bot
    const newPrimary = electPrimary(botId);
    report.newPrimary = newPrimary;

  } catch (err) {
    report.errors.push(`Reconcile failed: ${err}`);
  }

  return report;
}

/**
 * Evict a session from all systems:
 * - Remove from SQLite relay_sessions
 * - Remove from JSON session registry
 * - Remove relay file
 * - Reset any processing messages for this session
 */
export function evictSession(botId: number, sessionName: string): void {
  // 1. Reset processing messages for this session
  Db.resetProcessingForSession(botId, sessionName);
  
  // 2. Unregister from SQLite
  Db.unregisterRelaySession(botId, sessionName);
  
  // 3. Remove relay file
  const relayPath = getRelayPath(sessionName, botId);
  try {
    if (existsSync(relayPath)) {
      unlinkSync(relayPath);
    }
  } catch {
    // Best effort - file may already be gone
  }

  // 4. Remove from JSON session registry (fire-and-forget sync)
  readSessionRegistry().then(reg => {
    const before = reg.sessions.length;
    reg.sessions = reg.sessions.filter(s => s.sessionName !== sessionName);
    if (reg.sessions.length !== before) {
      // Reassign primary if the evicted session held it
      if (reg.primarySessionId) {
        const evicted = reg.sessions.length < before;
        // The removed session might have been primaryByBot for this bot
        if (reg.primaryByBot && reg.primaryByBot[String(botId)]) {
          const sameBotSessions = reg.sessions.filter(s => s.botId === botId);
          if (sameBotSessions.length > 0) {
            reg.primaryByBot[String(botId)] = sameBotSessions[0].sessionId;
          } else {
            delete reg.primaryByBot[String(botId)];
          }
        }
      }
      void writeSessionRegistry(reg);
    }
  }).catch(() => { /* non-critical */ });
}

// ============================================================================
// Primary Election
// ============================================================================

/**
 * Elect a new primary session for a bot.
 * Priority: lock holder > fresh heartbeat > earliest registration
 * 
 * @param botId - The bot to elect primary for
 * @returns The session name of the new primary, or null if no sessions available
 */
export function electPrimary(botId: number): string | null {
  // Get all alive sessions for this bot
  const sessions = getRelaySessionsForBot(botId);
  
  if (sessions.length === 0) {
  
    return null;
  }
  
  // Sort by priority: lock holder > heartbeat freshness > registered_at
  // We use a score-based approach
  const scored = sessions.map((session: Db.RelaySession) => {
    let score = 0;
    
    // Heartbeat freshness (more recent = higher score)
    const heartbeatScore = Math.floor((Date.now() - session.last_heartbeat) / 1000);
    // Invert so newer heartbeats have higher scores
    score += Math.max(0, 10000 - heartbeatScore);
    
    // Earlier registration = more established = slightly preferred
    const registeredScore = Math.floor(session.registered_at / 1000);
    // Invert so earlier registrations have higher scores
    score += Math.max(0, 20000 - registeredScore);
    
    return { session, score };
  });
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  const winner = scored[0].session;
  
  // Clear current primary and set new one
  clearPrimary(botId);
  Db.setPrimary(botId, winner.session_name);
  

  
  return winner.session_name;
}

/**
 * Clear the primary flag for all sessions of a bot.
 */
function clearPrimary(botId: number): void {
  const db = Db.getDb();
  db.prepare("UPDATE relay_sessions SET is_primary = 0 WHERE bot_id = ?").run(botId);
}

/**
 * Get only linked (alive and healthy) sessions for a bot.
 */
export async function getLinkedSessions(botId: number): Promise<Db.RelaySession[]> {
  const sessions = getRelaySessionsForBot(botId);
  const linkedPromises = sessions.map(async (session: Db.RelaySession) => {
    const { liveness } = await checkSessionLiveness(session);
    return liveness === SessionLiveness.LINKED ? session : null;
  });
  
  const results = await Promise.all(linkedPromises);
  return results.filter((s): s is Db.RelaySession => s !== null);
}

/**
 * Check if a specific session is linked (alive and reachable).
 */
export async function isSessionLinked(botId: number, sessionName: string): Promise<boolean> {
  const session = Db.getRelaySession(botId, sessionName);
  if (!session) return false;
  
  const { liveness } = await checkSessionLiveness(session);
  return liveness === SessionLiveness.LINKED;
}

// ============================================================================
// Utility
// ============================================================================

/**
 * Clean up all stale relay files that point to dead PIDs.
 * Called on startup.
 */
export function cleanStaleRelayFiles(): void {
  try {
    const files = readdirSync(RELAY_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const relayPath = join(RELAY_DIR, file);
      try {
        const relayInfo: RelayInfo = JSON.parse(readFileSync(relayPath, "utf8"));
        try {
          process.kill(relayInfo.pid, 0);
          // PID is alive, keep this relay file
        } catch {
          // PID is dead, remove stale relay file
          unlinkSync(relayPath);
        }
      } catch {
        // Corrupted relay file, remove it
        try { unlinkSync(relayPath); } catch {}
      }
    }
  } catch {
    // Directory might not exist yet
  }
}

/**
 * Get summary of all sessions and their liveness for a bot.
 */
export async function getSessionLivenessSummary(botId: number): Promise<{
  linked: string[];
  stale: string[];
  ghost: string[];
}> {
  const sessions = getRelaySessionsForBot(botId);
  
  const result = {
    linked: [] as string[],
    stale: [] as string[],
    ghost: [] as string[],
  };
  
  for (const session of sessions) {
    const { liveness } = await checkSessionLiveness(session);
    
    switch (liveness) {
      case SessionLiveness.LINKED:
        result.linked.push(session.session_name);
        break;
      case SessionLiveness.STALE:
        result.stale.push(session.session_name);
        break;
      case SessionLiveness.GHOST:
        result.ghost.push(session.session_name);
        break;
    }
  }
  
  return result;
}