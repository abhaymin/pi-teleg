/**
 * teleg-bridge MCP server (stdio transport)
 *
 * Standalone MCP server that exposes the SAME capabilities as the Pi native
 * extension (src/index.ts). It is intended for THIRD-PARTY MCP clients
 * (Oh My Pi / omp, opencode, Claude Code, Kilo Code, Roo, Cline, etc.).
 *
 * In Pi itself, pi-teleg ships as a NATIVE extension — do NOT also load this
 * MCP server into Pi (it would duplicate every tool). deploy.sh therefore wires
 * only the extension into ~/.pi/agent/settings.json and intentionally does NOT
 * add this server to ~/.pi/agent/mcp.json. Use `teleg mcp` to emit the config
 * snippet for a third-party client.
 *
 * This server provides tools only (no Telegram polling). It shares the same
 * SQLite database (~/.pi/agent/teleg-bridge.db) and config files as the
 * extension, so it can be used alongside running extension sessions to inspect
 * and manage queue / relay state, or fully standalone without any extension.
 *
 * Config resolution mirrors src/config.ts:
 *   env TELEG_BOT_TOKEN / TELEG_BOT_ID / TELEG_DB_PATH
 *   > project .pi/teleg.json
 *   > global  ~/.pi/agent/teleg-bridge.json (multi-bot via `bots`)
 */

import "../dist/suppress-sqlite-warning.js";
import { readFileSync, writeFileSync, existsSync, createReadStream, unlinkSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";
import * as Db from "../dist/db.js";
import { getPollingManager } from "../dist/polling-manager.js";
import { startRelayServer, stopRelayServer, cleanRelayFilesByPid } from "../dist/relay.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Paths / Constants ───────────────────────────────────────────────────────

const HOME_DIR = process.env.HOME || "~";
const AGENT_DIR = join(HOME_DIR, ".pi", "agent");
const GLOBAL_CONFIG_PATH = join(AGENT_DIR, "teleg-bridge.json");
const PROJECT_DIR = process.env.TELEG_PROJECT_DIR || process.cwd();
const PROJECT_CONFIG_PATH = join(PROJECT_DIR, ".pi", "teleg.json");
const SESSION_REGISTRY_PATH = join(AGENT_DIR, "teleg-sessions.json");
const RELAY_DIR = join(AGENT_DIR, "tmp", "teleg-relay");
const CAPABILITIES_PATH = join(AGENT_DIR, "teleg-capabilities.json");

const DEFAULT_DB_PATH = join(AGENT_DIR, "teleg-bridge.db");
const DB_PATH = process.env.TELEG_DB_PATH || DEFAULT_DB_PATH;

const DEFAULT_LIVENESS_MS = Number(process.env.TELEG_LIVENESS_MS) || 300000; // 5 min

// ─── Config ──────────────────────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function loadGlobalConfig() {
  return readJson(GLOBAL_CONFIG_PATH);
}

function loadProjectConfig() {
  return readJson(PROJECT_CONFIG_PATH);
}

function loadConfig() {
  const globalCfg = loadGlobalConfig() || {};
  const projectCfg = loadProjectConfig() || {};
  const envBotId = process.env.TELEG_BOT_ID ? parseInt(process.env.TELEG_BOT_ID, 10) : 0;
  const selectedBotId = envBotId || projectCfg.botId || globalCfg.defaultBotId || globalCfg.botId || 0;
  const selectedEntry = selectedBotId ? { ...(globalCfg.bots?.[String(selectedBotId)] || {}) } : {};
  const botToken = process.env.TELEG_BOT_TOKEN || projectCfg.botToken || selectedEntry.botToken || globalCfg.botToken || null;
  const botUsername = projectCfg.botUsername || selectedEntry.botUsername || globalCfg.botUsername || null;
  const allowedUserIds = projectCfg.allowedUserIds || selectedEntry.allowedUserIds || globalCfg.allowedUserIds || [];
  const allowedChatIds = projectCfg.allowedChatIds || selectedEntry.allowedChatIds || globalCfg.allowedChatIds || [];
  const lastUpdateId = projectCfg.lastUpdateId ?? selectedEntry.lastUpdateId ?? globalCfg.lastUpdateId ?? 0;
  const defaultBotId = selectedBotId || selectedEntry.botId || projectCfg.botId || globalCfg.defaultBotId || 0;
  const botId = selectedBotId || selectedEntry.botId || projectCfg.botId || globalCfg.botId || 0;

  const bots = { ...(globalCfg.bots || {}) };
  if (botId) {
    bots[String(botId)] = {
      ...(bots[String(botId)] || {}),
      botId,
      botToken: botToken || bots[String(botId)]?.botToken,
      botUsername: botUsername || bots[String(botId)]?.botUsername,
      allowedUserIds,
      allowedChatIds,
      lastUpdateId,
    };
  }

  return {
    ...globalCfg,
    ...projectCfg,
    botId,
    botToken,
    botUsername,
    allowedUserIds,
    allowedChatIds,
    lastUpdateId,
    defaultBotId,
    bots,
  };
}

const config = loadConfig();

/**
 * Resolve a bot to a usable { botId, botToken, baseUrl, chatId, botUsername }.
 * Falls back through: explicit bot_id arg > env > project > global default.
 * Returns null when no token is configured for the requested bot.
 */
function resolveBot(botIdArg) {
  const cfg = loadConfig();
  const bots = cfg.bots || {};
  const id = botIdArg
    ? Number(botIdArg)
    : (cfg.defaultBotId || cfg.botId || 0);
  let entry;
  if (id && bots[String(id)]) {
    entry = { ...bots[String(id)] };
  } else {
    entry = {
      botId: cfg.botId,
      botToken: cfg.botToken,
      botUsername: cfg.botUsername,
      allowedUserIds: cfg.allowedUserIds,
      allowedChatIds: cfg.allowedChatIds,
    };
  }
  const token = process.env.TELEG_BOT_TOKEN || entry.botToken || cfg.botToken;
  if (!token) return null;
  const chatId = entry.allowedChatIds?.[0] ?? entry.allowedUserIds?.[0]
    ?? cfg.allowedChatIds?.[0] ?? cfg.allowedUserIds?.[0]
    ?? null;
  return {
    botId: id || entry.botId || cfg.botId || 0,
    botToken: token,
    baseUrl: `https://api.telegram.org/bot${token}`,
    chatId,
    botUsername: entry.botUsername || cfg.botUsername || null,
  };
}

// ─── Telegram API ────────────────────────────────────────────────────────────

async function tg(bot, method, body = {}) {
  if (!bot?.baseUrl) throw new Error("No bot token configured");
  const res = await fetch(`${bot.baseUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

async function sendMessage(bot, text, chatId) {
  const target = chatId ?? bot.chatId;
  if (!target) throw new Error("No chat ID configured (send /start to the bot from an allowed user, or pass chat_id)");
  return tg(bot, "sendMessage", { chat_id: target, text, parse_mode: "HTML" });
}

// ─── Streaming Upload Helpers ────────────────────────────────────────────────

/**
 * Build a multipart/form-data body using streaming for large files.
 * Avoids loading entire file into memory.
 */
async function streamUpload(bot, filePath, fieldName, extraFields = {}) {
  const fileName = filePath.split("/").pop();
  const fileSize = (await import("fs")).statSync(filePath).size;

  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;

  let header = `--${boundary}\r\n`;
  for (const [key, value] of Object.entries(extraFields)) {
    header += `Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n--${boundary}\r\n`;
  }
  header += `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`;
  header += `Content-Type: application/octet-stream\r\n\r\n`;

  const { Readable } = await import("stream");
  const footer = `\r\n--${boundary}--\r\n`;

  const headerStream = Readable.from([Buffer.from(header)]);
  const fileStream = createReadStream(filePath);
  const footerStream = Readable.from([Buffer.from(footer)]);

  const combined = Readable.from([headerStream, fileStream, footerStream]);

  const res = await fetch(`${bot.baseUrl}/${fieldName}`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(Buffer.byteLength(header) + fileSize + Buffer.byteLength(footer)),
    },
    body: combined,
    signal: AbortSignal.timeout(300_000), // 5 min timeout
  });

  return res;
}

async function sendPhoto(bot, filePath, caption = "", chatId) {
  const target = chatId ?? bot.chatId;
  if (!target) throw new Error("No chat ID configured");
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const res = await streamUpload(bot, filePath, "sendPhoto", {
    chat_id: target,
    caption,
    parse_mode: "HTML",
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

async function sendVideo(bot, filePath, caption = "", chatId) {
  const target = chatId ?? bot.chatId;
  if (!target) throw new Error("No chat ID configured");
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const res = await streamUpload(bot, filePath, "sendVideo", {
    chat_id: target,
    caption,
    parse_mode: "HTML",
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

async function sendDocument(bot, filePath, caption = "", chatId) {
  const target = chatId ?? bot.chatId;
  if (!target) throw new Error("No chat ID configured");
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const res = await streamUpload(bot, filePath, "sendDocument", {
    chat_id: target,
    caption,
    parse_mode: "HTML",
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

/** Infer attachment type from path when the caller does not force one. */
function mediaTypeForPath(filePath) {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) return "video";
  return "document";
}

/**
 * Persist bot-sent media so a later user reply-to can resolve local paths
 * (parity with the Pi extension's outbound_messages.attachments recording).
 */
function recordOutboundMedia(bot, sentResult, filePath, type, caption, chatId) {
  const messageId = sentResult?.message_id;
  if (!messageId || !bot?.botId) return;
  const target = Number(chatId ?? bot.chatId);
  if (!Number.isFinite(target) || !target) return;
  const fileName = basename(filePath);
  const kind = type || mediaTypeForPath(filePath);
  try {
    Db.recordOutboundMessage({
      bot_id: bot.botId,
      chat_id: target,
      message_id: messageId,
      from_session: SESSION_NAME,
      text: (caption && String(caption).trim()) || `(${kind}: ${fileName})`,
      attachments: JSON.stringify([{ path: filePath, fileName, type: kind }]),
    });
  } catch { /* best-effort — never fail the send */ }
}

async function getMe(bot) {
  return tg(bot, "getMe");
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function openDb(readonly = false) {
  const db = new DatabaseSync(DB_PATH, { readonly, fileMustExist: false });
  if (!readonly) { try { db.exec("PRAGMA busy_timeout=5000"); } catch { /* older sqlite */ } }
  return db;
}

/** Resolve a bot id for queue scoping. 0 means "all bots" (legacy/global). */
function scopeBot(args) {
  if (args?.bot_id) return Number(args.bot_id);
  return config.defaultBotId || config.botId || 0;
}

function getQueueStats(botId = 0) {
  const db = openDb(true);
  try {
    let rows;
    if (botId) {
      rows = db.prepare(`SELECT status, COUNT(*) as count FROM message_queue WHERE bot_id = ? GROUP BY status`).all(botId);
    } else {
      rows = db.prepare(`SELECT status, COUNT(*) as count FROM message_queue GROUP BY status`).all();
    }
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
    for (const row of rows) {
      if (row.status in stats) stats[row.status] = row.count;
      stats.total += row.count;
    }
    const depthQ = botId
      ? `SELECT COUNT(*) as count FROM message_queue WHERE bot_id = ? AND status IN ('pending','processing')`
      : `SELECT COUNT(*) as count FROM message_queue WHERE status IN ('pending','processing')`;
    const depth = botId ? db.prepare(depthQ).get(botId) : db.prepare(depthQ).get();
    return { ...stats, depth: depth?.count ?? 0 };
  } finally {
    db.close();
  }
}

function getDownloadStats(botId = 0) {
  const db = openDb(true);
  try {
    let rows;
    if (botId) {
      rows = db.prepare(`SELECT status, COUNT(*) as count FROM download_queue WHERE bot_id = ? GROUP BY status`).all(botId);
    } else {
      rows = db.prepare(`SELECT status, COUNT(*) as count FROM download_queue GROUP BY status`).all();
    }
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
    for (const row of rows) {
      if (row.status in stats) stats[row.status] = row.count;
      stats.total += row.count;
    }
    return stats;
  } finally {
    db.close();
  }
}

// ─── Relay / Liveness helpers (parity with src/session-registry.ts) ──────────

function getRelayPath(sessionName, botId) {
  const prefix = botId ? `${botId}-` : "";
  return join(RELAY_DIR, `${prefix}${sessionName}.json`);
}

function readRelayInfo(sessionName, botId) {
  const p = getRelayPath(sessionName, botId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Check session liveness. Mirrors checkSessionLiveness() in the extension.
 * Classifies as "linked" | "stale" | "ghost".
 */
async function checkLiveness(session) {
  const failed = [];

  // 1. pid_alive
  let pidAlive = false;
  try { process.kill(session.pid, 0); pidAlive = true; } catch { failed.push("pid_alive"); }

  // 2. relay_file
  const relayInfo = readRelayInfo(session.session_name, session.bot_id);
  if (!relayInfo) failed.push("relay_file");

  // 3. relay_pid_match
  let relayPidMatch = false;
  if (relayInfo) {
    relayPidMatch = relayInfo.pid === session.pid;
    if (!relayPidMatch) failed.push("relay_pid_match");
  }

  // 4. relay_http
  let relayHttp = false;
  if (relayInfo) {
    try {
      const response = await fetch(`http://127.0.0.1:${relayInfo.port}/health`);
      relayHttp = response.ok;
      if (!relayHttp) failed.push("relay_http");
    } catch { failed.push("relay_http"); }
  }

  // 5. heartbeat_fresh
  const heartbeatFresh = (Date.now() - (session.last_heartbeat || 0)) < DEFAULT_LIVENESS_MS;
  if (!heartbeatFresh) failed.push("heartbeat_fresh");

  let liveness;
  if (!pidAlive) liveness = "ghost";
  else if (!relayInfo || !relayPidMatch || !relayHttp || !heartbeatFresh) liveness = "stale";
  else liveness = "linked";

  return { liveness, failed, checks: { pid_alive: pidAlive, relay_file: !!relayInfo, relay_pid_match: relayPidMatch, relay_http: relayHttp, heartbeat_fresh: heartbeatFresh } };
}

function readSessionRegistryJson() {
  return readJson(SESSION_REGISTRY_PATH) || { sessions: [], primarySessionId: null, primaryByBot: {} };
}

function writeSessionRegistryJson(reg) {
  try { writeFileSync(SESSION_REGISTRY_PATH, JSON.stringify(reg, null, 2)); } catch { /* best effort */ }
}

function resetProcessingForSession(botId, sessionName) {
  const db = openDb();
  try {
    return db.prepare(
      "UPDATE message_queue SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL WHERE session_name = ? AND status = 'processing' AND bot_id = ?"
    ).run(sessionName, botId).changes;
  } finally { db.close(); }
}

/**
 * Evict a session from every system, mirroring evictSession() in the extension:
 * reset its processing messages, remove the DB row, delete its relay file, and
 * drop it from the JSON session registry.
 */
function evictSessionStandalone(botId, sessionName) {
  resetProcessingForSession(botId, sessionName);

  const db = openDb();
  try {
    db.prepare("DELETE FROM relay_sessions WHERE bot_id = ? AND session_name = ?").run(botId, sessionName);
  } finally { db.close(); }

  const relayPath = getRelayPath(sessionName, botId);
  try { if (existsSync(relayPath)) unlinkSync(relayPath); } catch { /* already gone */ }

  const reg = readSessionRegistryJson();
  const before = reg.sessions.length;
  reg.sessions = reg.sessions.filter(s => !(s.sessionName === sessionName && s.botId === botId));
  if (reg.primaryByBot?.[String(botId)]) {
    const sameBot = reg.sessions.filter(s => s.botId === botId);
    if (sameBot.length > 0) reg.primaryByBot[String(botId)] = sameBot[0].sessionId;
    else delete reg.primaryByBot[String(botId)];
  }
  if (reg.sessions.length !== before) writeSessionRegistryJson(reg);
}

/**
 * Elect a primary session for a bot from the currently linked sessions.
 * Mirrors electPrimary() in the extension. Returns the new primary name or null.
 */
async function electPrimaryStandalone(botId) {
  const db = openDb();
  let sessions;
  try {
    sessions = db.prepare("SELECT * FROM relay_sessions WHERE bot_id = ? ORDER BY registered_at ASC").all(botId);
  } finally { db.close(); }
  if (!sessions.length) return null;

  // Prefer an already-primary session that is still alive.
  for (const s of sessions) {
    if (!s.is_primary) continue;
    try { process.kill(s.pid, 0); return s.session_name; } catch { /* dead primary */ }
  }

  // Otherwise pick the first alive session.
  for (const s of sessions) {
    try { process.kill(s.pid, 0); } catch { continue; }
    const db2 = openDb();
    try {
      db2.exec("BEGIN IMMEDIATE");
      db2.prepare("UPDATE relay_sessions SET is_primary = 0 WHERE bot_id = ?").run(botId);
      db2.prepare("UPDATE relay_sessions SET is_primary = 1 WHERE bot_id = ? AND session_name = ?").run(botId, s.session_name);
      db2.exec("COMMIT");
    } catch {
      try { db2.exec("ROLLBACK"); } catch {}
    } finally { db2.close(); }
    return s.session_name;
  }
  return null;
}

/**
 * Reconcile all sessions for a bot: evict ghosts, reset stale processing rows,
 * and re-elect a primary if needed. Mirrors reconcileForSingleBot().
 */
async function reconcileBot(botId) {
  const report = { botId, checkedSessions: 0, evictedSessions: [], newPrimary: null, errors: [] };
  const db = openDb(true);
  let sessions;
  try {
    sessions = db.prepare("SELECT * FROM relay_sessions WHERE bot_id = ? ORDER BY registered_at ASC").all(botId);
  } finally { db.close(); }
  report.checkedSessions = sessions.length;

  for (const session of sessions) {
    try {
      const { liveness } = await checkLiveness(session);
      if (liveness === "ghost") {
        try { evictSessionStandalone(botId, session.session_name); report.evictedSessions.push(session.session_name); }
        catch (err) { report.errors.push(`Failed to evict ${session.session_name}: ${err}`); }
      } else if (liveness === "stale") {
        try { resetProcessingForSession(botId, session.session_name); }
        catch (err) { report.errors.push(`Failed to reset processing for ${session.session_name}: ${err}`); }
      }
    } catch (err) {
      report.errors.push(`Failed to check ${session.session_name}: ${err}`);
    }
  }

  report.newPrimary = await electPrimaryStandalone(botId);
  return report;
}

/**
 * Repair DEGRADED / stuck health for a bot: probe Telegram, recover stale queue
 * rows, reconcile ghosts, and restart the poller when this process can own it.
 */
async function fixDegradedHealth(botId, { force = false } = {}) {
  const token = botTokenFor(botId);
  const steps = [];
  const details = { bot_id: botId, force };
  if (!botId || !token) {
    return { ok: false, steps: ["No bot configured"], details: { ...details, error: "no_bot" } };
  }

  let apiOk = false;
  try {
    const bot = resolveBot(botId);
    const me = await getMe(bot);
    apiOk = !!me?.id;
    steps.push(apiOk ? `Telegram API OK (@${me.username || me.first_name})` : "Telegram API getMe failed");
    details.api = me || null;
  } catch (err) {
    steps.push(`Telegram API error: ${err?.message || err}`);
  }
  details.apiOk = apiOk;

  let recovered = 0;
  try {
    if (typeof Db.recoverStaleMessages === "function") {
      recovered = Db.recoverStaleMessages(60000, botId) || 0;
    } else {
      const db = openDb();
      try {
        const cutoff = Date.now() - 60000;
        const r = db.prepare(
          `UPDATE message_queue SET status='pending', started_at=NULL
           WHERE bot_id=? AND status='processing' AND started_at IS NOT NULL AND started_at < ?`
        ).run(botId, cutoff);
        recovered = r.changes || 0;
      } finally { db.close(); }
    }
  } catch (err) {
    steps.push(`Stale recovery error: ${err?.message || err}`);
  }
  steps.push(recovered > 0 ? `Reset ${recovered} stale processing row(s)` : "No stale processing rows");
  details.recoveredMessages = recovered;

  let reconcile;
  try {
    reconcile = await reconcileBot(botId);
    steps.push(
      `Reconcile: checked=${reconcile.checkedSessions}, evicted=${reconcile.evictedSessions.length}, primary=${reconcile.newPrimary ?? "unchanged"}`,
    );
    details.reconcile = reconcile;
  } catch (err) {
    steps.push(`Reconcile error: ${err?.message || err}`);
  }

  let pollingAction = "none";
  try {
    const pm = getPollingManager(botId);
    const before = pm.getState();
    details.before = before;
    const heldByOther = pm.isHeldByOther();
    const degraded = !before.isHealthy || before.consecutiveErrors >= 3 || !pm.isActive();
    if (heldByOther && !pm.isActive()) {
      pollingAction = "skipped_lock_held";
      steps.push("Polling lock held by another live session — skipped poller restart");
      if (apiOk && typeof pm.resetHealthCounters === "function") pm.resetHealthCounters();
    } else if (force || degraded || !apiOk) {
      pm.setConfig(token, readLastUpdateId(botId));
      const started = typeof pm.restart === "function"
        ? await pm.restart(SESSION_NAME, DB_PATH)
        : (await pm.stop(), await pm.start(SESSION_NAME, DB_PATH));
      engineState.polling = !!started;
      pollingAction = started ? "restarted" : "restart_failed";
      steps.push(started ? "Poller restarted" : "Poller restart failed");
    } else if (apiOk && typeof pm.resetHealthCounters === "function") {
      pm.resetHealthCounters();
      pollingAction = "counters_reset";
      steps.push("Poller healthy — counters cleared");
    }
    details.after = pm.getState();
    details.polling = pm.isActive();
  } catch (err) {
    pollingAction = "error";
    steps.push(`Poller repair error: ${err?.message || err}`);
  }
  details.pollingAction = pollingAction;

  const ok = apiOk && (details.polling === true || pollingAction === "skipped_lock_held" || details.after?.isHealthy !== false);
  steps.push(ok ? "Health repair complete" : "Health still degraded — check token/network/lock");
  details.ok = ok;
  return { ok, steps, details };
}

// ─── MCP Engine: omp / standalone receive path ───────────────────────────────
// The native Pi extension owns polling + turn injection (pi.sendUserMessage).
// MCP clients (omp, opencode, Claude Code, …) have no Pi runtime, so this
// standalone server runs the SAME engine itself: it polls Telegram, registers
// as a live relay session, and exposes a blocking teleg_listen tool that hands
// each incoming message to the agent loop. Reuses the Pi-free ../dist engine.
const SESSION_NAME = (process.env.TELEG_SESSION_NAME || basename(PROJECT_DIR) || "mcp").replace(/\s+/g, "-").toLowerCase();
const SESSION_ID = `__session__:${SESSION_NAME}`;
const POLL_INTERVAL_MS = 300;
const HEARTBEAT_INTERVAL_MS = 30000;
const LISTEN_DEFAULT_MS = 20000;
const LISTEN_MAX_MS = 120000;

const engineState = { started: false, polling: false, port: 0, botId: 0 };
let heartbeatTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Last Telegram update offset for a bot: global bots[id] → project → 0. */
function readLastUpdateId(botId) {
  const cfg = loadConfig();
  const entry = cfg.bots?.[String(botId)] || {};
  return Number(entry.lastUpdateId ?? cfg.lastUpdateId ?? 0) || 0;
}

/** Token for a bot id (falls back to the configured default bot). */
function botTokenFor(botId) {
  return resolveBot(botId)?.botToken || "";
}

/** True iff THIS process holds the per-bot polling lock (is the active poller). */
function amIPrimary(botId) {
  try { return getPollingManager(botId).isActive(); } catch { return false; }
}

/** Fresh-heartbeat session names for a bot — drives @name routing. */
function aliveSessionNames(botId) {
  const db = openDb(true);
  try {
    const rows = db.prepare("SELECT session_name FROM relay_sessions WHERE bot_id = ? AND last_heartbeat > ?").all(botId, Date.now() - DEFAULT_LIVENESS_MS);
    return new Set(rows.map((r) => r.session_name));
  } catch {
    return new Set();
  } finally {
    db.close();
  }
}

/**
 * Routing hook fired by the poller for each newly-inserted message. Direct
 * @name messages are assigned to the named live session (its teleg_listen claims
 * them); everything else stays unassigned and is claimed by the primary poller.
 */
function routeMessage(botId, _update, dbId) {
  try {
    const db = openDb();
    try {
      const row = db.prepare("SELECT text, chat_id, from_user_id FROM message_queue WHERE id = ?").get(dbId);
      if (!row) return;
      // 1) Explicit @sessionName
      const m = row?.text?.match(/^\s*@([A-Za-z0-9_.\-]+)\b/);
      if (m) {
        const target = m[1].toLowerCase();
        if (target !== SESSION_NAME && aliveSessionNames(botId).has(target)) {
          db.prepare("UPDATE message_queue SET session_id = ?, session_name = ? WHERE id = ? AND status = 'pending'")
            .run(`__session__:${target}`, target, dbId);
          return;
        }
      }
      // 2) Shared-bot instance links (chat/user ownership on relay_sessions)
      try {
        const sessions = Db.getAliveRelaySessions(botId) || [];
        const candidates = sessions.map((s) => ({
          sessionName: s.session_name,
          linkedChatIds: Db.getRelayLinkedChatIds?.(s) || [],
          linkedUserIds: Db.getRelayLinkedUserIds?.(s) || [],
          capabilities: (() => { try { return JSON.parse(s.capabilities || "[]"); } catch { return []; } })(),
          description: s.description || "",
        }));
        // Prefer unique chat/user owner without pulling in the full resolver if unused.
        const chatOwners = candidates.filter((c) => c.linkedChatIds.includes(Number(row.chat_id)));
        let target = chatOwners.length === 1 ? chatOwners[0].sessionName : null;
        if (!target && row.from_user_id) {
          const userOwners = candidates.filter((c) => c.linkedUserIds.includes(Number(row.from_user_id)));
          if (userOwners.length === 1) target = userOwners[0].sessionName;
        }
        if (target && target !== SESSION_NAME && aliveSessionNames(botId).has(target)) {
          db.prepare("UPDATE message_queue SET session_id = ?, session_name = ? WHERE id = ? AND status = 'pending'")
            .run(`__session__:${target}`, target, dbId);
        }
      } catch { /* best effort */ }
    } finally { db.close(); }
  } catch { /* best effort */ }
}

/** Append/refresh this session in the JSON registry (parity with the extension). */
function touchJsonRegistry(botId) {
  const reg = readSessionRegistryJson();
  let s = reg.sessions.find((x) => x.sessionName === SESSION_NAME && x.botId === botId);
  if (!s) { s = { sessionId: SESSION_ID, sessionName: SESSION_NAME, botId, pid: process.pid, projectDir: PROJECT_DIR }; reg.sessions.push(s); }
  s.lastHeartbeat = Date.now(); s.pid = process.pid;
  writeSessionRegistryJson(reg);
}

function removeFromJsonRegistry(botId) {
  const reg = readSessionRegistryJson();
  const before = reg.sessions.length;
  reg.sessions = reg.sessions.filter((s) => !(s.sessionName === SESSION_NAME && s.botId === botId));
  if (reg.primaryByBot?.[String(botId)] === SESSION_ID) delete reg.primaryByBot[String(botId)];
  if (reg.sessions.length !== before) writeSessionRegistryJson(reg);
}

/** Start the receive engine: relay server + session registration + poller. */
async function startEngine() {
  if (engineState.started) return;
  const botId = Number(config.defaultBotId || config.botId) || 0;
  if (!botId) return; // send-only mode (no bot configured)
  const token = botTokenFor(botId);
  if (!token) return;
  engineState.botId = botId;
  try {
    // 1. Local relay HTTP server → relay file + /health (liveness checks).
    const relay = await startRelayServer(SESSION_NAME, 9798, botId).catch((e) => { console.error(`[teleg-mcp:${SESSION_NAME}] relay start failed: ${e?.message || e}`); return null; });
    engineState.port = relay?.port || 0;
    // 2. Register as a live relay session (DB is source of truth for liveness).
    Db.registerRelaySession({
      bot_id: botId, session_name: SESSION_NAME, session_id: SESSION_ID,
      pid: process.pid, port: engineState.port, secret: relay?.secret || "",
      project_dir: PROJECT_DIR, description: "omp/mcp standalone", role: "drain",
    });
    touchJsonRegistry(botId);
    // 3. Poller (per-bot lock: a single Telegram getUpdates consumer).
    const pm = getPollingManager(botId);
    pm.setConfig(token, readLastUpdateId(botId));
    pm.onMessage((update, dbId) => routeMessage(botId, update, dbId));
    pm.onError((e) => console.error(`[teleg-mcp:${SESSION_NAME}] poller error: ${e}`));
    engineState.polling = await pm.start(SESSION_NAME, DB_PATH);
    // 4. Heartbeat + failover (take over polling if the lock frees up).
    heartbeatTimer = setInterval(() => heartbeat(botId), HEARTBEAT_INTERVAL_MS);
    engineState.started = true;
    console.error(`[teleg-mcp:${SESSION_NAME}] engine up (polling=${engineState.polling}, port=${engineState.port})`);
  } catch (err) {
    console.error(`[teleg-mcp:${SESSION_NAME}] engine start failed: ${err?.message || err}`);
  }
}

let degradedSinceMs = null;
let lastAutoFixAtMs = 0;
let autoFixInFlight = false;
const AUTO_FIX_COOLDOWN_MS = 60_000;
const AUTO_FIX_DEGRADED_FOR_MS = Number(process.env.TELEG_AUTO_FIX_DEGRADED_MS || 5 * 60_000);

function heartbeat(botId) {
  try { Db.heartbeatRelaySession(botId, SESSION_NAME); } catch {}
  try { touchJsonRegistry(botId); } catch {}
  try {
    const pm = getPollingManager(botId);
    const health = pm.getState?.() || { isHealthy: true, consecutiveErrors: 0 };
    if (pm.isHeldByOther() && !pm.isActive()) {
      engineState.polling = false;
      degradedSinceMs = null;
      return;
    }
    const needsRepair = !pm.isActive() || !health.isHealthy || health.consecutiveErrors >= 3;
    if (!needsRepair) {
      degradedSinceMs = null;
      engineState.polling = pm.isActive();
      return;
    }
    if (degradedSinceMs == null) degradedSinceMs = Date.now();
    const waited = Date.now() - degradedSinceMs;
    if (waited < AUTO_FIX_DEGRADED_FOR_MS) {
      engineState.polling = pm.isActive();
      return;
    }
    if (autoFixInFlight || Date.now() - lastAutoFixAtMs < AUTO_FIX_COOLDOWN_MS) {
      engineState.polling = pm.isActive();
      return;
    }
    autoFixInFlight = true;
    lastAutoFixAtMs = Date.now();
    fixDegradedHealth(botId, { force: false }).then((r) => {
      engineState.polling = !!r.details?.polling || getPollingManager(botId).isActive();
      if (r.ok) degradedSinceMs = null;
      else degradedSinceMs = Date.now();
    }).catch((err) => {
      console.error(`[teleg-mcp:${SESSION_NAME}] auto-fix health failed:`, err?.message || err);
    }).finally(() => { autoFixInFlight = false; });
  } catch {}
}

function stopEngine() {
  try { clearInterval(heartbeatTimer); } catch {}
  heartbeatTimer = null;
  const botId = engineState.botId || Number(config.defaultBotId || config.botId) || 0;
  try { if (botId) getPollingManager(botId)?.stop?.(); } catch {}
  try { if (botId) unlinkSync(join(AGENT_DIR, "tmp", "teleg-bridge", `polling-${botId}.lock`)); } catch {}
  try { stopRelayServer(); } catch {}
  try { cleanRelayFilesByPid(process.pid); } catch {}
  if (botId) {
    try { Db.unregisterRelaySession(botId, SESSION_NAME); } catch {}
    try { removeFromJsonRegistry(botId); } catch {}
  }
  engineState.started = false;
}

/** Build the agent-facing payload for a claimed queue row (reply chain + media). */
function buildListenPayload(botId, row) {
  let replyContext = "";
  let replyAttachments = [];
  try {
    if (row.reply_to_message_id) {
      replyContext = Db.buildReplyChainText(botId, row.chat_id, row.reply_to_message_id) || "";
      replyAttachments = Db.collectReplyContextAttachments(botId, row.chat_id, row.reply_to_message_id) || [];
    }
  } catch {}
  let attachments = [];
  try { if (row.attachments) attachments = JSON.parse(row.attachments) || []; } catch {}
  const seen = new Set();
  const merged = [];
  for (const a of [...attachments, ...replyAttachments]) {
    const path = a && a.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    merged.push(a);
  }
  return {
    id: row.id,
    chat_id: row.chat_id,
    message_id: row.message_id,
    from_user_id: row.from_user_id,
    from_username: row.from_username,
    text: row.text,
    reply_context: replyContext,
    attachments: merged,
    session: SESSION_NAME,
    assigned_to_me: true,
  };
}

/**
 * Claim the next pending message for this session. The primary (active poller)
 * also drains the unassigned queue; non-primary sessions claim only @routed rows.
 */
function claimListenItem(botId) {
  const primary = amIPrimary(botId);
  let row = Db.claimNextMessageForSession(botId, SESSION_NAME);
  if (!row && primary) row = Db.claimNextMessage(botId, SESSION_ID, SESSION_NAME);
  if (!row) return null;
  const payload = buildListenPayload(botId, row);
  payload.primary = primary;
  return payload;
}

// ─── MCP Protocol (stdio) ────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "teleg_listen",
    description: "Blocking long-poll for the next incoming Telegram message routed to this session. CALL THIS IN A LOOP: it blocks until a message arrives (then returns it) or the timeout elapses (then returns {timed_out:true}). When you get a message, handle it using your tools, send the answer with teleg_reply, then call teleg_listen again — keep the loop running so the bot stays responsive. The session that holds the Telegram polling lock (the primary) also receives unassigned messages; prefix a message with @<session> to route it to a named live session. This is how omp / standalone MCP clients receive and process Telegram — no Pi app required.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: { type: "number", description: "Max ms to block waiting for a message (default 20000; max 120000). On timeout, re-call teleg_listen." },
        bot_id: { type: "number", description: "Bot ID (optional; defaults to configured default bot)" },
      },
    },
  },
  {
    name: "teleg_reply",
    description: "Reply to an incoming Telegram message and mark it handled. Sends `text` as a Telegram reply to the original message, records the outbound message, and marks the queue item completed. If you already delivered files via teleg-attach, pass empty text to simply mark the item complete. If handling failed, call set_queue_status with status 'failed' (and an error) instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Queue message id returned by teleg_listen" },
        text: { type: "string", description: "Reply text (omit or empty if you only sent attachments)" },
        bot_id: { type: "number", description: "Bot ID (optional; defaults to configured default bot)" },
      },
      required: ["id"],
    },
  },
  {
    name: "teleg-send_message",
    description: "Send a text message to a Telegram chat",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text" },
        chat_id: { type: "string", description: "Target chat ID (optional; defaults to the bot's first allowed user)" },
        bot_id: { type: "number", description: "Bot ID to use (optional; defaults to the configured default bot)" },
      },
      required: ["text"],
    },
  },
  {
    name: "teleg-send_photo",
    description: "Send a photo (local file) to a Telegram chat",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local file path" },
        caption: { type: "string", description: "Caption (optional)" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
        bot_id: { type: "number", description: "Bot ID to use (optional)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "teleg-send_video",
    description: "Send a video (local file) to a Telegram chat",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local file path" },
        caption: { type: "string", description: "Caption (optional)" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
        bot_id: { type: "number", description: "Bot ID to use (optional)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "teleg-send_document",
    description: "Send an arbitrary file as a Telegram document (local file)",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local file path" },
        caption: { type: "string", description: "Caption (optional)" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
        bot_id: { type: "number", description: "Bot ID to use (optional)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_me",
    description: "Get bot identity (getMe)",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "number", description: "Bot ID (optional)" } },
    },
  },
  {
    name: "get_queue_count",
    description: "Get the number of pending and processing messages in the queue",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "number", description: "Bot ID (optional; defaults to configured default bot)" } },
    },
  },
  {
    name: "get_queue_stats",
    description: "Get full queue statistics for messages and downloads",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "number", description: "Bot ID (optional)" } },
    },
  },
  {
    name: "teleg-attach",
    description: "Send local files to Telegram. Standalone MCP sends them immediately to the target chat. (When this tool is registered by the Pi extension instead, the extension queues the files onto the active turn's next reply.)",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Local file paths to send" },
        caption: { type: "string", description: "Caption for the first file (optional)" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
        bot_id: { type: "number", description: "Bot ID to use (optional)" },
      },
      required: ["paths"],
    },
  },
  {
    name: "get_queue_data",
    description: "Get queue messages data",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max messages to return (default 20)" },
        status: { type: "string", description: "Filter by status: pending, processing, completed, failed" },
        bot_id: { type: "number", description: "Bot ID (optional)" },
      },
    },
  },
  {
    name: "get_queue_data_id",
    description: "Get a specific queue message by its ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Queue message ID" },
        bot_id: { type: "number", description: "Bot ID (optional)" },
      },
      required: ["id"],
    },
  },
  {
    name: "set_queue_status",
    description: "Update the status of a queue message",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Queue message ID" },
        status: {
          type: "string",
          enum: ["pending", "processing", "completed", "failed"],
          description: "New status for the message",
        },
        error: { type: "string", description: "Error message if status is 'failed'" },
        bot_id: { type: "number", description: "Bot ID (optional)" },
      },
      required: ["id", "status"],
    },
  },
  {
    name: "teleg-clear_backlog",
    description: "Clear/reset the message backlog queue. Use 'reset' to unstick stale processing messages, 'purge' to delete old completed/failed entries, 'complete' to manually mark a message done, 'fail' to mark a message failed, or 'delete' to remove pending messages.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["reset", "purge", "complete", "fail", "delete"],
          description: "Action: 'reset' = unstick stuck processing→pending, 'purge' = delete old completed/failed entries, 'complete' = mark a message completed, 'fail' = mark a message failed, 'delete' = delete pending messages",
        },
        id: { type: "number", description: "Message ID (required for complete/fail actions)" },
        keep_count: { type: "number", description: "How many completed/failed entries to keep on purge (default 500)" },
        bot_id: { type: "number", description: "Bot ID to scope the operation (optional)" },
      },
      required: ["action"],
    },
  },
  {
    name: "teleg-publish",
    description: "Publish a message to a PUB-SUB channel for another session to pick up. Use to delegate tasks between pi sessions without Telegram.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name (e.g., a capability like 'download', 'scrape', 'analyze')" },
        payload: { type: "string", description: "Message payload / task description" },
        target_session: { type: "string", description: "Target session name (omit for broadcast to any capable session)" },
        bot_id: { type: "number", description: "Bot ID (optional)" },
      },
      required: ["channel", "payload"],
    },
  },
  // ─── Session Management Tools ─────────────────────────────────────────
  {
    name: "teleg-reconcile",
    description: "Check all relay sessions for liveness and evict ghosts. Resets stale processing rows and re-elects a primary.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "number", description: "Bot ID to reconcile (optional; defaults to the configured default bot, or all bots if none configured)" },
      },
    },
  },
  {
    name: "teleg-fix-health",
    description: "Repair DEGRADED bridge health: Telegram getMe probe, reset stale processing rows, reconcile ghost sessions, and restart the poller when the lock is free. Pass force=true to always restart the poller.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "number", description: "Bot ID (optional; defaults to configured default bot)" },
        force: { type: "boolean", description: "Force poller restart even if currently healthy" },
      },
    },
  },
  {
    name: "teleg-list_sessions",
    description: "List all relay sessions for a bot with liveness status (linked / stale / ghost).",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "number", description: "Bot ID (optional; defaults to configured default bot)" },
        include_ghosts: { type: "boolean", description: "Include ghost sessions in results" },
      },
    },
  },
  {
    name: "teleg-evict_session",
    description: "Evict a session from the registry. Resets its processing messages, removes the DB row, deletes its relay file, and drops it from the JSON session registry; optionally kills the PID.",
    inputSchema: {
      type: "object",
      properties: {
        session_name: { type: "string", description: "Name of the session to evict" },
        bot_id: { type: "number", description: "Bot ID (optional)" },
        reset_queue: { type: "boolean", description: "Reset processing messages for this session" },
        force_kill_pid: { type: "boolean", description: "Force kill the session's PID" },
      },
      required: ["session_name"],
    },
  },
  {
    name: "teleg-list_bots",
    description: "List all configured bots from the global config.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "teleg-set_primary",
    description: "Manually set a session as primary for a bot.",
    inputSchema: {
      type: "object",
      properties: {
        session_name: { type: "string", description: "Name of the session to make primary" },
        bot_id: { type: "number", description: "Bot ID (optional)" },
      },
      required: ["session_name"],
    },
  },
  // ─── Kill-Switch Tools ──────────────────────────────────────────────
  {
    name: "teleg-disconnect",
    description: "Disconnect the primary relay session for a bot (kills its PID). Queue DB state and other sessions are unaffected. Standalone MCP has no own session lifecycle, so it targets the bot's current primary.",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "number", description: "Bot ID (optional)" } },
    },
  },
  {
    name: "teleg-disconnect-all",
    description: "Disconnect ALL relay sessions for a bot (terminates their PIDs). Does NOT clean queue DB or remove registry records.",
    inputSchema: {
      type: "object",
      properties: { bot_id: { type: "number", description: "Bot ID (optional)" } },
    },
  },
  {
    name: "teleg-clean-db",
    description: "Clean queue DB state separately from disconnect. Resets processing messages to pending and purges old completed/failed messages.",
    inputSchema: {
      type: "object",
      properties: {
        keep_count: { type: "number", description: "How many completed/failed messages to keep (default 500)" },
        bot_id: { type: "number", description: "Bot ID (optional)" },
      },
    },
  },
  {
    name: "teleg-remove-sessions",
    description: "Remove session records separately from disconnect. By default removes dead sessions only; pass all=true to remove all relay session rows for a bot.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "number", description: "Bot ID to scope (optional; defaults to configured default bot)" },
        all: { type: "boolean", description: "Remove all sessions for the bot, even if alive" },
      },
    },
  },
];

// Read JSON-RPC messages from stdin (newline-delimited).
// Uses ONE persistent data listener + a module-level line buffer + a FIFO
// waiter queue, so pipelined requests and notifications are never lost
// across calls (the previous per-call listener approach swallowed bytes).
let _stdinBuffer = "";
const _stdinLines = [];     // parsed messages that arrived before a reader was waiting
const _stdinWaiters = [];   // readers awaiting a message
let _stdinListening = false;

function _ensureStdinListener() {
  if (_stdinListening) return;
  _stdinListening = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    _stdinBuffer += chunk;
    let idx;
    while ((idx = _stdinBuffer.indexOf("\n")) >= 0) {
      const line = _stdinBuffer.slice(0, idx).trim();
      _stdinBuffer = _stdinBuffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const waiter = _stdinWaiters.shift();
        if (waiter) waiter.resolve(msg);
        else _stdinLines.push(msg); // no reader YET — buffer instead of dropping
      } catch (err) {
        const waiter = _stdinWaiters.shift();
        if (waiter) waiter.reject(err);
      }
    }
  });
  process.stdin.on("end", () => {
    while (_stdinWaiters.length) _stdinWaiters.shift().reject(new Error("EOF"));
  });
}

function readRequest() {
  return new Promise((resolve, reject) => {
    _ensureStdinListener();
    // Drain a buffered message first so pipelined requests are never lost.
    if (_stdinLines.length) { resolve(_stdinLines.shift()); return; }
    _stdinWaiters.push({ resolve, reject });
  });
}

function sendResponse(id, result) {
  const resp = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(resp + "\n");
}

function sendError(id, code, message) {
  const resp = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(resp + "\n");
}

// ─── Request Handler ─────────────────────────────────────────────────────────

async function handleRequest(req) {
  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "teleg-bridge-mcp", version: "2.0.0" },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      sendResponse(id, { tools: TOOL_DEFINITIONS });
      return;
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};

      // ─── Send tools ───────────────────────────────────────────────
      if (name === "teleg-send_message") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        sendResponse(id, await sendMessage(bot, args.text, args.chat_id));
        return;
      }
      if (name === "teleg-send_photo") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        const result = await sendPhoto(bot, args.file_path, args.caption ?? "", args.chat_id);
        recordOutboundMedia(bot, result, args.file_path, "image", args.caption ?? "", args.chat_id);
        sendResponse(id, result);
        return;
      }
      if (name === "teleg-send_video") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        const result = await sendVideo(bot, args.file_path, args.caption ?? "", args.chat_id);
        recordOutboundMedia(bot, result, args.file_path, "video", args.caption ?? "", args.chat_id);
        sendResponse(id, result);
        return;
      }
      if (name === "teleg-send_document") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        const result = await sendDocument(bot, args.file_path, args.caption ?? "", args.chat_id);
        recordOutboundMedia(bot, result, args.file_path, "document", args.caption ?? "", args.chat_id);
        sendResponse(id, result);
        return;
      }
      if (name === "get_me") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        sendResponse(id, await getMe(bot));
        return;
      }

      // ─── teleg-attach: send immediately in standalone mode ─────────
      if (name === "teleg-attach") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        const paths = args.paths ?? [];
        if (!paths.length) throw new Error("paths required");
        const target = args.chat_id ?? bot.chatId;
        if (!target) throw new Error("No chat ID configured");
        const sent = [];
        for (let i = 0; i < paths.length; i++) {
          const p = paths[i];
          if (!existsSync(p)) throw new Error(`File not found: ${p}`);
          const ext = (p.split(".").pop() || "").toLowerCase();
          const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);
          const isVideo = ["mp4", "mov", "mkv", "webm", "avi"].includes(ext);
          const caption = i === 0 ? (args.caption ?? "") : "";
          let result;
          let kind;
          if (isImage) { result = await sendPhoto(bot, p, caption, target); kind = "image"; }
          else if (isVideo) { result = await sendVideo(bot, p, caption, target); kind = "video"; }
          else { result = await sendDocument(bot, p, caption, target); kind = "document"; }
          recordOutboundMedia(bot, result, p, kind, caption, target);
          sent.push(p);
        }
        sendResponse(id, { sent, count: sent.length, chat_id: target });
        return;
      }

      // ─── Queue tools (bot-scoped for parity) ──────────────────────
      if (name === "get_queue_count") {
        const botId = scopeBot(args);
        const stats = getQueueStats(botId);
        sendResponse(id, { count: stats.depth, pending: stats.pending, processing: stats.processing, bot_id: botId });
        return;
      }
      if (name === "get_queue_stats") {
        const botId = scopeBot(args);
        sendResponse(id, { messages: getQueueStats(botId), downloads: getDownloadStats(botId), bot_id: botId });
        return;
      }
      if (name === "get_queue_data") {
        const botId = scopeBot(args);
        const db = openDb(true);
        try {
          const limit = args.limit ?? 20;
          let rows;
          if (args.status && botId) {
            rows = db.prepare("SELECT * FROM message_queue WHERE bot_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?").all(botId, args.status, limit);
          } else if (args.status) {
            rows = db.prepare("SELECT * FROM message_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(args.status, limit);
          } else if (botId) {
            rows = db.prepare("SELECT * FROM message_queue WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?").all(botId, limit);
          } else {
            rows = db.prepare("SELECT * FROM message_queue ORDER BY created_at DESC LIMIT ?").all(limit);
          }
          sendResponse(id, { rows, bot_id: botId });
        } finally { db.close(); }
        return;
      }
      if (name === "get_queue_data_id") {
        const botId = scopeBot(args);
        const db = openDb(true);
        try {
          const row = botId
            ? db.prepare("SELECT * FROM message_queue WHERE id = ? AND bot_id = ?").get(args.id, botId)
            : db.prepare("SELECT * FROM message_queue WHERE id = ?").get(args.id);
          sendResponse(id, { row: row ?? null });
        } finally { db.close(); }
        return;
      }
      if (name === "set_queue_status") {
        const botId = scopeBot(args);
        const db = openDb();
        try {
          const now = Date.now();
          let query = `UPDATE message_queue SET status = ?`;
          const sqlArgs = [args.status];
          if (args.status === "completed") {
            query += `, completed_at = ?`;
            sqlArgs.push(now);
          } else if (args.status === "failed" && args.error) {
            query += `, error = ?`;
            sqlArgs.push(args.error);
          } else if (args.status === "pending") {
            query += `, started_at = NULL, session_id = 'unassigned', session_name = 'unknown'`;
          }
          if (botId) { query += ` WHERE id = ? AND bot_id = ?`; sqlArgs.push(args.id, botId); }
          else { query += ` WHERE id = ?`; sqlArgs.push(args.id); }
          const result = db.prepare(query).run(...sqlArgs);
          sendResponse(id, { changes: result.changes, status: args.status });
        } finally { db.close(); }
        return;
      }
      if (name === "teleg-clear_backlog") {
        const botId = scopeBot(args);
        const db = openDb();
        let count = 0;
        let action = args.action;
        const scope = (sql) => botId ? `${sql} AND bot_id = ?` : sql;
        try {
          if (action === "reset") {
            count = botId
              ? db.prepare("UPDATE message_queue SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL WHERE status = 'processing' AND bot_id = ?").run(botId).changes
              : db.prepare("UPDATE message_queue SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL WHERE status = 'processing'").run().changes;
          } else if (action === "purge") {
            const keep = args.keep_count ?? 500;
            const row = botId
              ? db.prepare("SELECT id FROM message_queue WHERE status IN ('completed','failed') AND bot_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?").get(botId, keep)
              : db.prepare("SELECT id FROM message_queue WHERE status IN ('completed','failed') ORDER BY id DESC LIMIT 1 OFFSET ?").get(keep);
            if (row) {
              count = botId
                ? db.prepare("DELETE FROM message_queue WHERE status IN ('completed','failed') AND bot_id = ? AND id < ?").run(botId, row.id).changes
                : db.prepare("DELETE FROM message_queue WHERE status IN ('completed','failed') AND id < ?").run(row.id).changes;
            }
          } else if (action === "complete") {
            if (!args.id) throw new Error("id required for complete action");
            if (botId) db.prepare("UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ? AND bot_id = ?").run(Date.now(), args.id, botId);
            else db.prepare("UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), args.id);
            count = 1;
          } else if (action === "fail") {
            if (!args.id) throw new Error("id required for fail action");
            if (botId) db.prepare("UPDATE message_queue SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND bot_id = ?").run(Date.now(), "Manually marked as failed", args.id, botId);
            else db.prepare("UPDATE message_queue SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(Date.now(), "Manually marked as failed", args.id);
            count = 1;
          } else if (action === "delete") {
            if (args.id) {
              if (botId) db.prepare("DELETE FROM message_queue WHERE id = ? AND bot_id = ?").run(args.id, botId);
              else db.prepare("DELETE FROM message_queue WHERE id = ?").run(args.id);
              count = 1;
            } else {
              count = botId
                ? db.prepare("DELETE FROM message_queue WHERE status = 'pending' AND bot_id = ?").run(botId).changes
                : db.prepare("DELETE FROM message_queue WHERE status = 'pending'").run().changes;
            }
          }
        } finally { db.close(); }
        sendResponse(id, { action, count, bot_id: botId });
        return;
      }

      if (name === "teleg-publish") {
        const botId = scopeBot(args);
        const db = openDb();
        try {
          const result = db.prepare(
            "INSERT INTO pubsub (bot_id, channel, publisher, payload, target_session) VALUES (?, ?, ?, ?, ?)"
          ).run(botId, args.channel, "mcp-server", args.payload, args.target_session || null);
          sendResponse(id, { id: result.lastInsertRowid, channel: args.channel, target_session: args.target_session ?? null, bot_id: botId });
        } finally { db.close(); }
        return;
      }

      // ─── Session Management Tools ─────────────────────────────────
      if (name === "teleg-reconcile") {
        let botId = args?.bot_id ? Number(args.bot_id) : (config.defaultBotId || 0);
        let report;
        if (!botId) {
          // No default bot — reconcile every bot that has sessions.
          const db = openDb(true);
          let allBots;
          try { allBots = db.prepare("SELECT DISTINCT bot_id FROM relay_sessions").all(); } finally { db.close(); }
          if (!allBots.length) {
            sendResponse(id, { botId: 0, checkedSessions: 0, evictedSessions: [], newPrimary: null, errors: [] });
            return;
          }
          const reports = [];
          for (const r of allBots) reports.push(await reconcileBot(r.bot_id));
          sendResponse(id, { reports, bot_id: null });
          return;
        }
        report = await reconcileBot(botId);
        sendResponse(id, report);
        return;
      }

      if (name === "teleg-fix-health") {
        const botId = args?.bot_id ? Number(args.bot_id) : (config.defaultBotId || config.botId || 0);
        const result = await fixDegradedHealth(botId, { force: !!args?.force });
        sendResponse(id, result);
        return;
      }

      if (name === "teleg-list_sessions") {
        const botId = args?.bot_id ? Number(args.bot_id) : (config.defaultBotId || config.botId || 0);
        if (!botId) { sendResponse(id, { sessions: [], bot_id: 0 }); return; }
        const db = openDb(true);
        let sessions;
        try { sessions = db.prepare("SELECT * FROM relay_sessions WHERE bot_id = ?").all(botId); } finally { db.close(); }
        const includeGhosts = args.include_ghosts ?? false;
        const result = [];
        for (const s of sessions) {
          const { liveness, failed } = await checkLiveness(s);
          if (liveness === "ghost" && !includeGhosts) continue;
          result.push({
            session_name: s.session_name,
            pid: s.pid,
            is_primary: s.is_primary,
            liveness,
            failed_checks: failed,
            heartbeat_age_ms: Date.now() - (s.last_heartbeat || 0),
            role: s.role,
          });
        }
        sendResponse(id, { sessions: result, bot_id: botId });
        return;
      }

      if (name === "teleg-evict_session") {
        const botId = args?.bot_id ? Number(args.bot_id) : (config.defaultBotId || config.botId || 0);
        if (!botId) throw new Error("bot_id required (no default bot configured)");
        const db = openDb();
        try {
          if (args.force_kill_pid) {
            const session = db.prepare("SELECT pid FROM relay_sessions WHERE bot_id = ? AND session_name = ?").get(botId, args.session_name);
            if (session) { try { process.kill(session.pid, 9); } catch { /* already dead */ } }
          }
        } finally { db.close(); }
        evictSessionStandalone(botId, args.session_name);
        sendResponse(id, { evicted: args.session_name, bot_id: botId });
        return;
      }

      if (name === "teleg-list_bots") {
        const cfg = loadConfig();
        if (!cfg || !cfg.bots) { sendResponse(id, { bots: [] }); return; }
        const bots = Object.entries(cfg.bots).map(([bid, entry]) => ({
          bot_id: parseInt(bid, 10),
          bot_username: entry.botUsername || "unknown",
          lastUpdateId: entry.lastUpdateId,
        }));
        sendResponse(id, { bots, defaultBotId: cfg.defaultBotId });
        return;
      }

      if (name === "teleg-set_primary") {
        const botId = args?.bot_id ? Number(args.bot_id) : (config.defaultBotId || config.botId || 0);
        if (!botId) throw new Error("bot_id required (no default bot configured)");
        const db = openDb();
        try {
          db.exec("BEGIN IMMEDIATE");
          db.prepare("UPDATE relay_sessions SET is_primary = 0 WHERE bot_id = ?").run(botId);
          const result = db.prepare("UPDATE relay_sessions SET is_primary = 1 WHERE bot_id = ? AND session_name = ?").run(botId, args.session_name);
          db.exec("COMMIT");
          sendResponse(id, { session_name: args.session_name, bot_id: botId, updated: result.changes });
        } catch {
          try { db.exec("ROLLBACK"); } catch {}
          throw new Error("Failed to set primary session");
        } finally { db.close(); }
        return;
      }

      // ─── Kill-Switch Tools ────────────────────────────────────────
      if (name === "teleg-disconnect") {
        const botId = args?.bot_id ? Number(args.bot_id) : (config.defaultBotId || config.botId || 0);
        const db = openDb();
        try {
          const session = botId
            ? db.prepare("SELECT session_name, pid FROM relay_sessions WHERE bot_id = ? AND is_primary = 1 LIMIT 1").get(botId)
            : db.prepare("SELECT session_name, pid FROM relay_sessions WHERE is_primary = 1 LIMIT 1").get();
          const killed = session?.session_name ?? null;
          if (session) { try { process.kill(session.pid, 9); } catch { /* already dead */ } }
          sendResponse(id, { disconnected: killed, bot_id: botId, db_cleaned: false, removed: false });
        } finally { db.close(); }
        return;
      }

      if (name === "teleg-disconnect-all") {
        const botId = args?.bot_id ? Number(args.bot_id) : (config.defaultBotId || config.botId || 0);
        const db = openDb();
        try {
          const sessions = botId
            ? db.prepare("SELECT session_name, pid FROM relay_sessions WHERE bot_id = ?").all(botId)
            : db.prepare("SELECT session_name, pid FROM relay_sessions").all();
          const killed = sessions.map(s => s.session_name);
          for (const s of sessions) { try { process.kill(s.pid, 9); } catch { /* already dead */ } }
          sendResponse(id, { killed, bot_id: botId, total: killed.length, db_cleaned: false, removed: false });
        } finally { db.close(); }
        return;
      }

      if (name === "teleg-clean-db") {
        const botId = scopeBot(args);
        const db = openDb();
        try {
          const reset = botId
            ? db.prepare("UPDATE message_queue SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL WHERE status = 'processing' AND bot_id = ?").run(botId).changes
            : db.prepare("UPDATE message_queue SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL WHERE status = 'processing'").run().changes;
          const keep = args.keep_count ?? 500;
          let purged = 0;
          const row = botId
            ? db.prepare("SELECT id FROM message_queue WHERE status IN ('completed','failed') AND bot_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?").get(botId, keep)
            : db.prepare("SELECT id FROM message_queue WHERE status IN ('completed','failed') ORDER BY id DESC LIMIT 1 OFFSET ?").get(keep);
          if (row) {
            purged = botId
              ? db.prepare("DELETE FROM message_queue WHERE status IN ('completed','failed') AND bot_id = ? AND id < ?").run(botId, row.id).changes
              : db.prepare("DELETE FROM message_queue WHERE status IN ('completed','failed') AND id < ?").run(row.id).changes;
          }
          sendResponse(id, { reset, purged, bot_id: botId });
        } finally { db.close(); }
        return;
      }

      if (name === "teleg-remove-sessions") {
        const botId = args?.bot_id ? Number(args.bot_id) : (config.defaultBotId || config.botId || 0);
        const db = openDb();
        try {
          const sessions = botId
            ? db.prepare("SELECT session_name, pid FROM relay_sessions WHERE bot_id = ?").all(botId)
            : db.prepare("SELECT session_name, pid FROM relay_sessions").all();
          const removed = [];
          for (const s of sessions) {
            let alive = true;
            try { process.kill(s.pid, 0); } catch { alive = false; }
            if (!args.all && alive) continue;
            removed.push(s.session_name);
            if (botId) db.prepare("DELETE FROM relay_sessions WHERE bot_id = ? AND session_name = ?").run(botId, s.session_name);
            else db.prepare("DELETE FROM relay_sessions WHERE session_name = ?").run(s.session_name);
          }
          sendResponse(id, { removed, bot_id: botId, total: removed.length });
        } finally { db.close(); }
        return;
      }

      // ─── Receive-path tools (omp / standalone MCP) ──────────────────────
      if (name === "teleg_listen") {
        const botId = scopeBot(args);
        if (!botId) throw new Error("No bot configured for teleg_listen");
        const timeoutMs = Math.min(Math.max(Number(args?.timeout_ms) || LISTEN_DEFAULT_MS, 1000), LISTEN_MAX_MS);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const item = claimListenItem(botId);
          if (item) { sendResponse(id, item); return; }
          await sleep(POLL_INTERVAL_MS);
        }
        sendResponse(id, { timed_out: true, session: SESSION_NAME, primary: amIPrimary(botId) });
        return;
      }
      if (name === "teleg_reply") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        const msgId = Number(args?.id);
        if (!msgId || !Number.isFinite(msgId)) throw new Error("id (queue message id) required");
        const text = typeof args?.text === "string" ? args.text : "";
        let row;
        try { row = Db.getDb().prepare("SELECT chat_id, message_id, status FROM message_queue WHERE id = ?").get(msgId); }
        catch (e) { throw new Error(`Failed to read message ${msgId}: ${e.message}`); }
        if (!row) throw new Error(`No queue message with id ${msgId}`);
        let sentMessageId = null;
        if (text.trim().length > 0) {
          const sent = await tg(bot, "sendMessage", { chat_id: row.chat_id, text, parse_mode: "HTML", reply_to_message_id: row.message_id });
          sentMessageId = sent?.message_id ?? null;
          if (sentMessageId) {
            try { Db.recordOutboundMessage({ bot_id: bot.botId, chat_id: row.chat_id, message_id: sentMessageId, reply_to_message_id: row.message_id, from_session: SESSION_NAME, text }); } catch {}
          }
        }
        try { Db.completeMessage(msgId, text || null); } catch {}
        sendResponse(id, { ok: true, id: msgId, sent_message_id: sentMessageId, completed: true });
        return;
      }
      throw new Error(`Unknown tool: ${name}`);
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    sendError(id, -32603, err.message);
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main() {
  try {
    void startEngine(); // omp/standalone receive path: poll + register + route
    while (true) {
      try {
        const req = await readRequest();
        await handleRequest(req);
      } catch (err) {
        if (err.message === "EOF") break;
        console.error("[teleg-mcp] Error:", err.message);
      }
    }
    // stdin closed — tear down the engine and exit so the poller worker, relay
    // server, and heartbeat timer don't keep the process alive as a zombie.
    stopEngine();
    process.exit(0);
  } catch {
    // Exit on stdin close
  }
}

main();

// Graceful engine teardown on shutdown: release the polling lock, stop the
// relay server, and unregister the session so peers/reconcile see us gone.
function shutdown(code) { try { stopEngine(); } catch {} process.exit(code); }
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(130));
process.on("beforeExit", () => { try { stopEngine(); } catch {} });
