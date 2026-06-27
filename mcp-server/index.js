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

import { readFileSync, writeFileSync, existsSync, createReadStream, unlinkSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";

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
  const chatId = entry.allowedUserIds?.[0] ?? cfg.allowedUserIds?.[0] ?? null;
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

async function getMe(bot) {
  return tg(bot, "getMe");
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function openDb(readonly = false) {
  return new DatabaseSync(DB_PATH, { readonly, fileMustExist: false });
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
  const prefix = botId ? `bot${botId}-` : "";
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

// ─── MCP Protocol (stdio) ────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
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
const _stdinWaiters = [];
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
      const waiter = _stdinWaiters.shift();
      if (!waiter) continue; // no reader waiting — drop (req/resp clients shouldn't hit this)
      try { waiter.resolve(JSON.parse(line)); }
      catch (err) { waiter.reject(err); }
    }
  });
  process.stdin.on("end", () => {
    while (_stdinWaiters.length) _stdinWaiters.shift().reject(new Error("EOF"));
  });
}

function readRequest() {
  return new Promise((resolve, reject) => {
    _ensureStdinListener();
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
        sendResponse(id, await sendPhoto(bot, args.file_path, args.caption ?? "", args.chat_id));
        return;
      }
      if (name === "teleg-send_video") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        sendResponse(id, await sendVideo(bot, args.file_path, args.caption ?? "", args.chat_id));
        return;
      }
      if (name === "teleg-send_document") {
        const bot = resolveBot(args?.bot_id);
        if (!bot) throw new Error("No bot token configured");
        sendResponse(id, await sendDocument(bot, args.file_path, args.caption ?? "", args.chat_id));
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
          if (isImage) await sendPhoto(bot, p, caption, target);
          else if (isVideo) await sendVideo(bot, p, caption, target);
          else await sendDocument(bot, p, caption, target);
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
    while (true) {
      try {
        const req = await readRequest();
        await handleRequest(req);
      } catch (err) {
        if (err.message === "EOF") break;
        console.error("[teleg-mcp] Error:", err.message);
      }
    }
  } catch {
    // Exit on stdin close
  }
}

main();
