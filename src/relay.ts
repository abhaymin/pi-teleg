/**
 * Command forwarding between pi sessions via HTTP relay.
 * 
 * Architecture:
 * - Each session runs a small HTTP server on a unique port (relay server)
 * - Relay port + secret stored in ~/.pi/agent/tmp/teleg-relay/{sessionName}.json
 * - When polling session receives @otherSession command, it POSTs to that session's relay
 * - Target session processes and responds, polling session forwards to Telegram
 */

import { createServer } from "http";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const RELAY_DIR = join(process.env.HOME || "~", ".pi/agent/tmp/teleg-relay");

function ensureRelayDir() {
  if (!existsSync(RELAY_DIR)) mkdirSync(RELAY_DIR, { recursive: true, mode: 0o700 });
}

function sanitizeSessionName(name: string): string {
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid session name: ${name}`);
  }
  return name;
}

function getRelayPath(sessionName: string, botId?: number): string {
  const safe = sanitizeSessionName(sessionName);
  const prefix = botId ? `${botId}-` : "";
  return join(RELAY_DIR, `${prefix}${safe}.json`);
}

/**
 * Find a relay file by session name, searching across all botId namespaces.
 * Used for cross-session lookups where the caller doesn't know the target's botId.
 */
function findRelayPath(sessionName: string): string | null {
  // First try exact name (legacy / no botId)
  const direct = getRelayPath(sessionName);
  if (existsSync(direct)) return direct;
  // Search for any botId-prefixed match
  ensureRelayDir();
  try {
    const suffix = `-${sessionName}.json`;
    for (const file of readdirSync(RELAY_DIR)) {
      if (file.endsWith(suffix)) return join(RELAY_DIR, file);
    }
  } catch {}
  return null;
}

export interface RelayInfo {
  port: number;
  secret: string;
  sessionName: string;
  pid: number;
  botId?: number; // Added in Phase 4
}

export interface StartRelayOptions {
  sessionName: string;
  basePort?: number;
  botId?: number; // Phase 4: link relay to a specific bot
}

// ─── Relay Server ─────────────────────────────────────────────────────────────

let relayServer: ReturnType<typeof createServer> | null = null;
let currentRelayInfo: RelayInfo | null = null;
function generateSecret(length = 32): string {
  const bytes = randomBytes(length);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i]! % chars.length];
  }
  return result;
}

/**
 * Remove relay files for PIDs that are no longer alive.
 * Called on startup to prevent stale relay files from accumulating.
 */
export function cleanStaleRelayFiles(): void {
  ensureRelayDir();
  try {
    const files = readdirSync(RELAY_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const relayPath = join(RELAY_DIR, file);
        const info = JSON.parse(readFileSync(relayPath, "utf8")) as RelayInfo;
        try {
          process.kill(info.pid, 0);
          // PID is alive, keep this relay file
        } catch {
          // PID is dead, remove stale relay file
          unlinkSync(relayPath);
        }
      } catch {
        // Corrupted relay file, remove it
        try { unlinkSync(join(RELAY_DIR, file)); } catch {}
      }
    }
  } catch {}
}

/**
 * Return the set of session names that have alive relay servers.
 * Used to cross-check against the session registry.
 */
export function getAliveSessionNames(): Set<string> {
  const alive = new Set<string>();
  ensureRelayDir();
  try {
    const files = readdirSync(RELAY_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const relayPath = join(RELAY_DIR, file);
        const info = JSON.parse(readFileSync(relayPath, "utf8")) as RelayInfo;
        try {
          process.kill(info.pid, 0);
          alive.add(info.sessionName);
        } catch {
          // PID is dead, skip
        }
      } catch {}
    }
  } catch {}
  return alive;
}

/**
 * Remove ALL relay files belonging to this PID.
 * Called on shutdown to clean up duplicates from crashes.
 */
export function cleanRelayFilesByPid(pid: number): void {
  ensureRelayDir();
  try {
    const files = readdirSync(RELAY_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const relayPath = join(RELAY_DIR, file);
        const info = JSON.parse(readFileSync(relayPath, "utf8")) as RelayInfo;
        if (info.pid === pid) {
          unlinkSync(relayPath);
        }
      } catch {}
    }
  } catch {}
}

export function startRelayServer(
  sessionName: string,
  basePort = 9798,
  botId?: number
): Promise<RelayInfo> {
  return new Promise((resolve, reject) => {
    // Guard: this module uses singleton state — only one relay per process
    if (relayServer || currentRelayInfo) {
      reject(new Error(
        `Relay already active for session "${currentRelayInfo?.sessionName}". ` +
        `Only one relay server per process is supported.`
      ));
      return;
    }

    ensureRelayDir();

    // Clean stale relay files for dead PIDs before registering
    cleanStaleRelayFiles();

    // Find an available port starting from basePort
    let port = basePort;

    function tryPort(portToTry: number): void {
      const server = createServer();
      
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          tryPort(portToTry + 1);
        } else {
          reject(err);
        }
      });
      
      server.listen(portToTry, "127.0.0.1", () => {
        const secret = generateSecret();
        const relayInfo: RelayInfo = {
          port: portToTry,
          secret,
          sessionName,
          pid: process.pid,
          botId, // Phase 4: link relay to a specific bot
        };
        currentRelayInfo = relayInfo;
        relayServer = server;  // Track so stopRelayServer can close it

        // Write relay info file so other sessions can find us
        const relayPath = getRelayPath(sessionName, botId);
        writeFileSync(relayPath, JSON.stringify(relayInfo, null, 2), { mode: 0o600 });

        // Handle incoming command requests
        server.on("request", async (req, res) => {
          if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          }
          
          if (req.url === "/command" && req.method === "POST") {
            let body = "";
            req.on("data", (chunk: Buffer) => (body += chunk.toString()));
            req.on("end", async () => {
              try {
                const { chatId, messageId, text, secret: incomingSecret, sourceSession } = JSON.parse(body);
                
                if (incomingSecret !== secret) {
                  res.writeHead(401, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "Unauthorized" }));
                  return;
                }
                
                // Dispatch to command handler
                if (onCommand) {
                  const response = await onCommand(text, { chatId, messageId, sourceSession });
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ ok: true, response }));
                } else {
                  res.writeHead(404, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "No command handler registered" }));
                }
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Bad request" }));
              }
            });
            return;
          }
          
          // Mark a message as completed in the source teleg session's DB
          if (req.url === "/complete" && req.method === "POST") {
            let body = "";
            req.on("data", (chunk: Buffer) => (body += chunk.toString()));
            req.on("end", () => {
              try {
                const { id, sourceSession, secret: incomingSecret } = JSON.parse(body);
                if (incomingSecret !== secret) {
                  res.writeHead(401, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "Unauthorized" }));
                  return;
                }
                if (onComplete) {
                  onComplete(id, sourceSession);
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ ok: true }));
                } else {
                  res.writeHead(404, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "No complete handler registered" }));
                }
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Bad request" }));
              }
            });
            return;
          }
          
          // Shutdown signal — other sessions tell us to disconnect
          if (req.url === "/shutdown" && req.method === "POST") {
            let body = "";
            req.on("data", (chunk: Buffer) => (body += chunk.toString()));
            req.on("end", async () => {
              try {
                const { secret: incomingSecret } = JSON.parse(body);
                if (incomingSecret !== secret) {
                  res.writeHead(401, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "Unauthorized" }));
                  return;
                }
                if (onShutdown) {
                  onShutdown();
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ ok: true, sessionName }));
                } else {
                  res.writeHead(404, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "No shutdown handler" }));
                }
              } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Bad request" }));
              }
            });
            return;
          }

          // CORS preflight
          if (req.method === "OPTIONS") {
            res.writeHead(204, {
              "Access-Control-Allow-Origin": "http://127.0.0.1",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
            return;
          }
          
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        });
        

        resolve(relayInfo);
      });
    }
    
    tryPort(port);
  });
}

export function stopRelayServer(): void {
  if (relayServer) {
    relayServer.close();
    relayServer = null;
  }
  if (currentRelayInfo) {
    try {
      const relayPath = getRelayPath(currentRelayInfo.sessionName, currentRelayInfo.botId);
      if (existsSync(relayPath)) {
        const info = JSON.parse(readFileSync(relayPath, "utf8"));
        if (info.pid === process.pid) {
          unlinkSync(relayPath);
        }
      }
    } catch {}
    currentRelayInfo = null;
  }
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

type CommandHandler = (text: string, meta: { chatId: number; messageId: number; sourceSession?: string }) => Promise<string>;
let onCommand: CommandHandler | null = null;

export function setCommandHandler(handler: CommandHandler): void {
  onCommand = handler;
}

// ─── Forward command to another session ──────────────────────────────────────

export async function forwardToSession(
  targetSessionName: string,
  text: string,
  meta: { chatId: number; messageId: number; sourceSession?: string }
): Promise<{ ok: boolean; response?: string; error?: string }> {
  const relayPath = findRelayPath(targetSessionName);
  
  if (!relayPath) {
    return { ok: false, error: `Session "${targetSessionName}" has no relay (not connected?)` };
  }
  
  let relayInfo: RelayInfo;
  try {
    relayInfo = JSON.parse(readFileSync(relayPath, "utf8"));
  } catch {
    return { ok: false, error: "Failed to read relay info" };
  }
  
  // Check if the session's relay process is still alive
  try {
    process.kill(relayInfo.pid, 0);
  } catch {
    return { ok: false, error: `Session "${targetSessionName}" is not running (stale relay)` };
  }
  
  try {
    const res = await fetch(`http://127.0.0.1:${relayInfo.port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: meta.chatId,
        messageId: meta.messageId,
        text,
        secret: relayInfo.secret,
        sourceSession: meta.sourceSession,
      }),
    });
    
    const data = await res.json() as { ok: boolean; response?: string; error?: string };
    return data;
  } catch (err) {
    return { ok: false, error: `Connection failed: ${err}` };
  }
}

// ─── Health check all sessions ────────────────────────────────────────────────

export async function getRelayStatus(): Promise<Record<string, { port: number; alive: boolean }>> {
  ensureRelayDir();
  const status: Record<string, { port: number; alive: boolean }> = {};
  
  try {
    const files = readdirSync(RELAY_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const info = JSON.parse(readFileSync(join(RELAY_DIR, file), "utf8"));
        let alive = false;
        try {
          process.kill(info.pid, 0);
          alive = true;
        } catch {}
        status[info.sessionName] = { port: info.port, alive };
      } catch {}
    }
  } catch {}
  
  return status;
}

// ─── Complete callback (called when target session finishes processing) ────────

type CompleteHandler = (id: number, sourceSession?: string) => void;
let onComplete: CompleteHandler | null = null;

export function setCompleteHandler(handler: CompleteHandler): void {
  onComplete = handler;
}

type ShutdownHandler = () => void;
let onShutdown: ShutdownHandler | null = null;

export function setShutdownHandler(handler: ShutdownHandler): void {
  onShutdown = handler;
}

/**
 * Signal completion of a message back to the source teleg session.
 * Called by the session (e.g. data-scrapper) after processing.
 * The message ID is the teleg bridge's message_queue.id (passed via sourceSession in the original command).
 */
export async function completeMessageOnSource(
  sourceSession: string,
  messageId: number,
  sourceSecret: string
): Promise<boolean> {
  const relayPath = findRelayPath(sourceSession);
  if (!relayPath) return false;
  let relayInfo: RelayInfo;
  try {
    relayInfo = JSON.parse(readFileSync(relayPath, "utf8"));
  } catch { return false; }
  try {
    process.kill(relayInfo.pid, 0);
  } catch { return false; }
  try {
    const res = await fetch(`http://127.0.0.1:${relayInfo.port}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: messageId, sourceSession, secret: sourceSecret }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    return data.ok;
  } catch { return false; }
}