/**
 * teleg-bridge MCP server
 * 
 * This is a standalone MCP server that exposes Telegram bridge tools
 * (send_message, send_photo, send_video, get_me, teleg_attach) to any AI session.
 * 
 * It connects to the same Telegram bot via the shared config at:
 *   ~/.pi/agent/teleg-bridge.json
 * 
 * Architecture options:
 * A) MCP server does its own polling (simpler but less integrated with extension lifecycle)
 * B) MCP server delegates to extension's HTTP API (more complex but unified)
 * 
 * Option A is implemented: MCP server runs its own long-polling loop and shares
 * the polling lock file with the extension to avoid conflicts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(process.env.HOME || "~", ".pi/agent/teleg-bridge.json");
const LOCK_PATH = join(process.env.HOME || "~", ".pi/agent/tmp/teleg-bridge/polling.lock");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  try {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {}
}

let config = loadConfig();
if (!config) {
  console.error("teleg-bridge-mcp: No config found at", CONFIG_PATH);
  console.error("Run the teleg extension first to set up the bot token.");
  process.exit(1);
}

const BOT_TOKEN = config.botToken;
if (!BOT_TOKEN) {
  console.error("teleg-bridge-mcp: No botToken in config");
  process.exit(1);
}

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Polling Lock (shared with extension) ────────────────────────────────────

let lockPid = null;
let lockTs = null;

function acquireLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      const lockContent = readFileSync(LOCK_PATH, "utf8").trim();
      const [pid, ts] = lockContent.split("\n");
      lockPid = parseInt(pid);
      lockTs = parseInt(ts);
      
      // Check if the lock holder is still alive
      if (lockPid && lockTs) {
        try {
          process.kill(lockPid, 0); // Signal 0 just checks if process exists
          // Lock holder is alive and polling - we skip
          return false;
        } catch {
          // Lock holder is dead - we can take over
        }
      }
    }
  } catch {}
  
  // Write our own lock
  const dir = dirname(LOCK_PATH);
  if (!existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
  writeFileSync(LOCK_PATH, `${process.pid}\n${Date.now()}`);
  return true;
}

function refreshLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      const content = readFileSync(LOCK_PATH, "utf8").trim();
      const [pid] = content.split("\n");
      if (parseInt(pid) === process.pid) {
        writeFileSync(LOCK_PATH, `${process.pid}\n${Date.now()}`);
      }
    }
  } catch {}
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      const content = readFileSync(LOCK_PATH, "utf8").trim();
      const [pid] = content.split("\n");
      if (parseInt(pid) === process.pid) {
        require("fs").unlinkSync(LOCK_PATH);
      }
    }
  } catch {}
}

// ─── Telegram API (pure fetch) ───────────────────────────────────────────────

async function tg(method, body = {}) {
  const res = await fetch(`${BASE_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

async function sendMessage(chatId, text, replyToMessageId = null, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    parse_mode: "HTML",
    ...extra,
  });
}

async function sendPhoto(chatId, filePath, caption = "", replyToMessageId = null) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("photo", await fileToBlob(filePath));
  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");
  if (replyToMessageId) formData.append("reply_to_message_id", replyToMessageId);
  
  const res = await fetch(`${BASE_URL}/sendPhoto`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

async function sendVideo(chatId, filePath, caption = "", replyToMessageId = null) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("video", await fileToBlob(filePath));
  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");
  if (replyToMessageId) formData.append("reply_to_message_id", replyToMessageId);
  
  const res = await fetch(`${BASE_URL}/sendVideo`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

async function fileToBlob(filePath) {
  const { readFileSync } = await import("fs");
  const buf = readFileSync(filePath);
  return new Blob([buf], { type: "application/octet-stream" });
}

async function getMe() {
  return tg("getMe");
}

async function sendDocument(chatId, filePath, caption = "", replyToMessageId = null) {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", await fileToBlob(filePath));
  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");
  if (replyToMessageId) formData.append("reply_to_message_id", replyToMessageId);
  
  const res = await fetch(`${BASE_URL}/sendDocument`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}

// ─── MCP Protocol ─────────────────────────────────────────────────────────────

// MCP server state
let updateOffset = config.lastUpdateId || 0;
const pendingAttachments = []; // files queued via teleg_attach

const TOOL_DEFINITIONS = [
  {
    name: "send_message",
    description: "Send a text message to Telegram chat",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text to send" },
        chat_id: { type: "string", description: "Target chat ID (optional, uses default if not provided)" },
      },
      required: ["text"],
    },
  },
  {
    name: "send_photo",
    description: "Send a photo to Telegram chat",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local file path to image" },
        caption: { type: "string", description: "Optional caption" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "send_video",
    description: "Send a video to Telegram chat",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Local file path to video" },
        caption: { type: "string", description: "Optional caption" },
        chat_id: { type: "string", description: "Target chat ID (optional)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_me",
    description: "Get information about the bot",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "teleg_attach",
    description: "Queue local files to be sent with the next Telegram reply",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Local file paths to attach",
        },
      },
      required: ["paths"],
    },
  },
];

// Send MCP response
function sendJson(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res, code, message) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

let polling = false;
let pollingController = null;

async function poll() {
  const controller = new AbortController();
  pollingController = controller;
  
  while (!controller.signal.aborted) {
    try {
      const updates = await tg("getUpdates", {
        offset: updateOffset + 1,
        timeout: 30,
        allowed_updates: ["message"],
      });
      
      for (const update of updates) {
        updateOffset = Math.max(updateOffset, update.update_id);
        
        if (update.message && config.allowedUserIds?.includes(String(update.message.from?.id))) {
          console.log(`[teleg-mcp] Incoming from ${update.message.from.id}: ${update.message.text?.substring(0, 50)}`);
          
          // Handle commands (non-tool calls)
          const text = update.message.text || "";
          const chatId = update.message.chat.id;
          
          if (text === "/start" || text === "/help") {
            await sendMessage(chatId, "teleg-bridge MCP server is running.\nPrefix messages with @sessionName to route to a specific session.");
          } else if (text === "/status") {
            await sendMessage(chatId, `teleg-mcp running (pid=${process.pid})\nlastUpdateId=${updateOffset}`);
          } else if (!text.startsWith("/")) {
            // Not a command - the AI agent will handle it via tool calls
            // For now just acknowledge
            console.log(`[teleg-mcp] Non-command message: ${text.substring(0, 100)}`);
          }
        }
      }
      
      // Save lastUpdateId periodically
      if (updates.length > 0) {
        config.lastUpdateId = updateOffset;
        saveConfig(config);
      }
    } catch (err) {
      if (err.message?.includes("TIMEOUT")) continue;
      console.error("[teleg-mcp] Poll error:", err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ─── HTTP Server (stdio alternative via HTTP) ────────────────────────────────

// Start polling if we got the lock
if (acquireLock()) {
  console.log("[teleg-mcp] Acquired polling lock, starting poll loop");
  refreshLock();
  setInterval(refreshLock, 15000);
  
  polling = true;
  poll().catch(console.error).finally(() => {
    releaseLock();
  });
} else {
  console.log("[teleg-mcp] Polling lock held by another process, MCP server running in agent-only mode");
  console.log("[teleg-mcp] (Use extension for polling, this MCP provides tools only)");
}

// ─── Main: HTTP server for MCP tool calls ─────────────────────────────────────

const PORT = parseInt(process.env.MCP_PORT || "9797");
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
    sendError(res, 404, "Not found");
    return;
  }
  
  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", async () => {
    try {
      const req = JSON.parse(body);
      const response = await handleMcpRequest(req);
      sendJson(res, response);
    } catch (err) {
      sendError(res, 400, err.message);
    }
  });
});

async function handleMcpRequest(req) {
  const { method, params } = req;
  
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "teleg-bridge-mcp", version: "1.0.0" },
    };
  }
  
  if (method === "tools/list") {
    return { tools: TOOL_DEFINITIONS };
  }
  
  if (method === "tools/call") {
    const { name, arguments: args } = params;
    const chatId = args?.chat_id || config.allowedUserIds?.[0] || "0";
    
    switch (name) {
      case "send_message":
        return { content: [{ type: "text", text: JSON.stringify(await sendMessage(chatId, args.text)) }] };
      case "send_photo":
        return { content: [{ type: "text", text: JSON.stringify(await sendPhoto(chatId, args.file_path, args.caption)) }] };
      case "send_video":
        return { content: [{ type: "text", text: JSON.stringify(await sendVideo(chatId, args.file_path, args.caption)) }] };
      case "get_me":
        return { content: [{ type: "text", text: JSON.stringify(await getMe()) }] };
      case "teleg_attach":
        if (args.paths) pendingAttachments.push(...args.paths);
        return { content: [{ type: "text", text: `Queued ${args.paths?.length || 0} attachment(s)` }] };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
  
  if (method === "notifications/initialized") {
    return {}; // Ack
  }
  
  throw new Error(`Unknown method: ${method}`);
}

const getMe = () => tg("getMe");

server.listen(PORT, () => {
  console.log(`[teleg-mcp] HTTP MCP server running on port ${PORT}`);
  console.log(`[teleg-mcp] Config: ${CONFIG_PATH}`);
  getMe().then(bot => console.log(`[teleg-mcp] Bot: @${bot.username}`));
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  releaseLock();
  process.exit(0);
});

process.on("exit", () => {
  releaseLock();
});