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

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

async function sendPhoto(filePath, caption = "", chatId = CHAT_ID) {
  if (!chatId) throw new Error("No chat ID configured");
  const { readFileSync } = await import("fs");
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([buf]), filePath.split("/").pop());
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  const res = await fetch(`${BASE_URL}/sendPhoto`, { method: "POST", body });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

async function sendVideo(filePath, caption = "", chatId = CHAT_ID) {
  if (!chatId) throw new Error("No chat ID configured");
  const { readFileSync } = await import("fs");
  const buf = readFileSync(filePath);
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("video", new Blob([buf]), filePath.split("/").pop());
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  const res = await fetch(`${BASE_URL}/sendVideo`, { method: "POST", body });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
  return data.result;
}

async function getMe() {
  return tg("getMe");
}

// ─── MCP Protocol (stdio) ────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "send_message",
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
    name: "send_photo",
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
    name: "send_video",
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
    name: "teleg_attach",
    description: "Queue files for next reply (no-op in standalone MCP, extension handles actual sending)",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["paths"],
    },
  },
];

let pendingAttachments = [];

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
      const chatId = args?.chat_id || CHAT_ID;

      switch (name) {
        case "send_message":
          if (!args?.text) throw new Error("Missing text");
          const r1 = await sendMessage(args.text, chatId);
          sendResponse(id, { content: [{ type: "text", text: JSON.stringify(r1) }] });
          break;
        case "send_photo":
          if (!args?.file_path) throw new Error("Missing file_path");
          const r2 = await sendPhoto(args.file_path, args.caption || "", chatId);
          sendResponse(id, { content: [{ type: "text", text: JSON.stringify(r2) }] });
          break;
        case "send_video":
          if (!args?.file_path) throw new Error("Missing file_path");
          const r3 = await sendVideo(args.file_path, args.caption || "", chatId);
          sendResponse(id, { content: [{ type: "text", text: JSON.stringify(r3) }] });
          break;
        case "get_me":
          const r4 = await getMe();
          sendResponse(id, { content: [{ type: "text", text: JSON.stringify(r4) }] });
          break;
        case "teleg_attach":
          if (args?.paths) pendingAttachments.push(...args.paths);
          sendResponse(id, { content: [{ type: "text", text: `Queued ${args?.paths?.length || 0} attachment(s)` }] });
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      return;
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