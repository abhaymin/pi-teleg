/**
 * teleg-bridge MCP server (stdio transport)
 *
 * Exposes send_message, send_photo, send_video, get_me, teleg_attach via stdio JSON-RPC.
 * Polling is handled by the extension — this server provides tools only.
 *
 * Add to ~/.pi/agent/mcp.json:
 * {
 *   "mcpServers": {
 *     "teleg-bridge": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-server/index.js"]
 *     }
 *   }
 * }
 */

import { readFileSync, writeFileSync, existsSync, createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(process.env.HOME || "~", ".pi/agent/teleg-bridge.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

const config = loadConfig();
if (!config || !config.botToken) {
  // Silent fail — allow MCP to load even without config
}

const BOT_TOKEN = config?.botToken;
const BASE_URL = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const CHAT_ID = config?.allowedUserIds?.[0] || null;

const DEFAULT_DB_PATH = join(process.env.HOME || "~", ".pi", "agent", "teleg-bridge.db");
const DB_PATH = process.env.TELEG_DB_PATH || DEFAULT_DB_PATH;

// ─── Telegram API ────────────────────────────────────────────────────────────

async function tg(method, body = {}) {
  if (!BASE_URL) throw new Error("No bot token configured");
  const res = await fetch(`${BASE_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

async function sendMessage(text, chatId = CHAT_ID) {
  if (!chatId) throw new Error("No chat ID configured");
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

// ─── Streaming Upload Helpers ────────────────────────────────────────────────

/**
 * Build a multipart/form-data body using streaming for large files.
 * Avoids loading entire file into memory.
 */
async function streamUpload(filePath, fieldName, extraFields = {}) {
  const fileName = filePath.split("/").pop();
  const fileSize = (await import("fs")).statSync(filePath).size;
  
  // Generate boundary
  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
  
  // Build header (non-streaming, small)
  let header = `--${boundary}\r\n`;
  for (const [key, value] of Object.entries(extraFields)) {
    header += `Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n--${boundary}\r\n`;
  }
  header += `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`;
  header += `Content-Type: application/octet-stream\r\n\r\n`;
  
  // Create readable stream for header + file + footer
  const { Readable } = await import("stream");
  const footer = `\r\n--${boundary}--\r\n`;
  
  const headerStream = Readable.from([Buffer.from(header)]);
  const fileStream = createReadStream(filePath);
  const footerStream = Readable.from([Buffer.from(footer)]);
  
  const combined = Readable.from([
    headerStream,
    fileStream,
    footerStream
  ]);
  
  const res = await fetch(`${BASE_URL}/${fieldName}`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(Buffer.byteLength(header) + fileSize + Buffer.byteLength(footer)),
    },
    body: combined,
    // Increase timeout for large files
    signal: AbortSignal.timeout(300_000), // 5 min timeout
  });
  
  return res;
}

async function sendPhoto(filePath, caption = "", chatId = CHAT_ID) {
  if (!chatId) throw new Error("No chat ID configured");
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  
  const res = await streamUpload(filePath, "sendPhoto", {
    chat_id: chatId,
    caption,
    parse_mode: "HTML",
  });
  
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

async function sendVideo(filePath, caption = "", chatId = CHAT_ID) {
  if (!chatId) throw new Error("No chat ID configured");
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  
  const res = await streamUpload(filePath, "sendVideo", {
    chat_id: chatId,
    caption,
    parse_mode: "HTML",
  });
  
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

async function getMe() {
  return tg("getMe");
}

// ─── Queue Stats ────────────────────────────────────────────────────────────

function getQueueStats() {
  const db = new DatabaseSync(DB_PATH, { readonly: true, fileMustExist: false });
  try {
    const rows = db.prepare(`SELECT status, COUNT(*) as count FROM message_queue GROUP BY status`).all();
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 };
    for (const row of rows) {
      if (row.status in stats) stats[row.status] = row.count;
      stats.total += row.count;
    }
    const depth = db.prepare(`SELECT COUNT(*) as count FROM message_queue WHERE status IN ('pending','processing')`).get();
    return { ...stats, depth: depth?.count ?? 0 };
  } finally {
    db.close();
  }
}

function getDownloadStats() {
  const db = new DatabaseSync(DB_PATH, { readonly: true, fileMustExist: false });
  try {
    const rows = db.prepare(`SELECT status, COUNT(*) as count FROM download_queue GROUP BY status`).all();
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

// ─── MCP Protocol (stdio) ────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "teleg-send_message",
    description: "Send a text message to Telegram",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
      },
      required: ["text"],
    },
  },
  {
    name: "teleg-send_photo",
    description: "Send a photo to Telegram",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local file path" },
        caption: { type: "string", description: "Caption (optional)" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "teleg-send_video",
    description: "Send a video to Telegram",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local file path" },
        caption: { type: "string", description: "Caption (optional)" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_me",
    description: "Get bot info",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_queue_count",
    description: "Get the number of pending and processing messages in the queue",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_queue_stats",
    description: "Get full queue statistics for messages and downloads",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "teleg-attach",
    description: "Queue files for next reply (no-op in standalone MCP, extension handles actual sending)",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["paths"],
    },
  },
  {
    name: "teleg-clear_backlog",
    description: "Clear/reset the message backlog queue. Use 'reset' to unstick stale processing messages, 'purge' to delete old completed/failed entries, or 'complete' to manually mark a message done.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["reset", "purge", "complete", "fail"],
          description: "Action: 'reset' = unstick stuck processing→pending, 'purge' = delete old completed/failed entries, 'complete' = mark a message completed, 'fail' = mark a message failed",
        },
        id: { type: "number", description: "Message ID (required for complete/fail actions)" },
        keep_count: { type: "number", description: "How many completed/failed entries to keep on purge (default 500)" },
      },
      required: ["action"],
    },
  },
];

let pendingAttachments = [];

// NOTE: teleg_attach is registered by the extension via pi.registerTool().
// The MCP server does NOT handle file attachments — the extension does that
// at agent_end via state.activeTurn.queuedAttachments.

// Read JSON-RPC request from stdin
function readRequest() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      data += chunk;
      // Try to parse complete JSON objects (JSON-RPC messages end with \n)
      const lines = data.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line) {
          try {
            resolve(JSON.parse(line));
            return;
          } catch {}
        }
      }
      // Last chunk may be incomplete
      const last = lines[lines.length - 1];
      if (last.endsWith("\n") || last.endsWith("\r")) {
        try {
          resolve(JSON.parse(last.trim()));
        } catch (e) {
          reject(e);
        }
      }
      // else wait for more data
    });
    process.stdin.on("end", () => reject(new Error("EOF")));
  });
}

// Write JSON-RPC response to stdout
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
        serverInfo: { name: "teleg-bridge-mcp", version: "1.0.0" },
      });
      return;
    }

    if (method === "notifications/initialized") {
      // Ack, no response needed
      return;
    }

    if (method === "tools/list") {
      sendResponse(id, { tools: TOOL_DEFINITIONS });
      return;
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};

      // All actual Telegram tools are handled by the extension.
      // The MCP server only receives the teleg_attach definition in its manifest
      // for backward compatibility, but never executes it — the extension owns that.
      if (name === "teleg-send_message") {
        sendResponse(id, await sendMessage(args.text, args.chat_id));
        return;
      }
      if (name === "teleg-send_photo") {
        sendResponse(id, await sendPhoto(args.file_path, args.caption, args.chat_id));
        return;
      }
      if (name === "teleg-send_video") {
        sendResponse(id, await sendVideo(args.file_path, args.caption, args.chat_id));
        return;
      }
      if (name === "get_me") {
        sendResponse(id, await getMe());
        return;
      }
      if (name === "get_queue_count") {
        const stats = getQueueStats();
        sendResponse(id, { count: stats.depth, pending: stats.pending, processing: stats.processing });
        return;
      }
      if (name === "get_queue_stats") {
        sendResponse(id, { messages: getQueueStats(), downloads: getDownloadStats() });
        return;
      }
      if (name === "teleg-attach") {
        pendingAttachments = args.paths ?? [];
        sendResponse(id, { queued: pendingAttachments.length });
        return;
      }
      if (name === "teleg-clear_backlog") {
        const db = new DatabaseSync(DB_PATH);
        let count = 0;
        let action = args.action;
        try {
          if (action === "reset") {
            count = db.prepare("UPDATE message_queue SET status = 'pending', session_id = 'unassigned', session_name = 'unknown', started_at = NULL WHERE status = 'processing'").run().changes;
          } else if (action === "purge") {
            const keep = args.keep_count ?? 500;
            const row = db.prepare("SELECT id FROM message_queue WHERE status IN ('completed','failed') ORDER BY id DESC LIMIT 1 OFFSET ?").get(keep);
            if (row) {
              count = db.prepare("DELETE FROM message_queue WHERE status IN ('completed','failed') AND id < ?").run(row.id).changes;
            }
          } else if (action === "complete") {
            if (!args.id) throw new Error("id required for complete action");
            db.prepare("UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), args.id);
            count = 1;
          } else if (action === "fail") {
            if (!args.id) throw new Error("id required for fail action");
            db.prepare("UPDATE message_queue SET status = 'failed', completed_at = ?, error = ? WHERE id = ?").run(Date.now(), "Manually marked as failed", args.id);
            count = 1;
          }
        } finally {
          db.close();
        }
        sendResponse(id, { action, count });
        return;
      }

      throw new Error(`Unknown tool: ${name}`);
    }

    // Unknown method
    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    sendError(id, -32603, err.message);
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main() {
  // Send initial manifest (some MCP clients expect this)
  if (process.env.MCP_SERVER_NAME || process.env.MANIFEST) {
    // Optional: emit capabilities on startup
  }

  try {
    while (true) {
      try {
        const req = await readRequest();
        await handleRequest(req);
      } catch (err) {
        if (err.message === "EOF") break;
        // Try to send error for JSON parse failures
        console.error("[teleg-mcp] Error:", err.message);
      }
    }
  } catch {
    // Exit on stdin close
  }
}

main();