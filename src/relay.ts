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
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const RELAY_DIR = join(process.env.HOME || "~", ".pi/agent/tmp/teleg-relay");

function ensureRelayDir() {
  if (!existsSync(RELAY_DIR)) mkdirSync(RELAY_DIR, { recursive: true });
}

function getRelayPath(sessionName: string): string {
  return join(RELAY_DIR, `${sessionName}.json`);
}

export interface RelayInfo {
  port: number;
  secret: string;
  sessionName: string;
  pid: number;
}

// ─── Relay Server ─────────────────────────────────────────────────────────────

let relayServer: ReturnType<typeof createServer> | null = null;
let currentRelayInfo: RelayInfo | null = null;

function generateSecret(length = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
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

export function startRelayServer(sessionName: string, basePort = 9798): Promise<RelayInfo> {
  return new Promise((resolve, reject) => {
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
        };
        
        currentRelayInfo = relayInfo;
        
        // Write relay info file so other sessions can find us
        const relayPath = getRelayPath(sessionName);
        writeFileSync(relayPath, JSON.stringify(relayInfo, null, 2));
        
        // Handle incoming command requests
        server.on("request", async (req, res) => {
          if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", sessionName }));
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
              } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
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
                const { id, sourceSession } = JSON.parse(body);
                // Signal the parent process to complete the message — handled via onComplete callback
                if (onComplete) {
                  onComplete(id, sourceSession);
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ ok: true }));
                } else {
                  res.writeHead(404, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "No complete handler registered" }));
                }
              } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
              }
            });
            return;
          }
          
          // CORS preflight
          if (req.method === "OPTIONS") {
            res.writeHead(204, {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            });
            res.end();
            return;
          }
          
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        });
        
        console.log(`[teleg-relay] Relay server running at http://127.0.0.1:${portToTry} for session "${sessionName}"`);
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
      const relayPath = getRelayPath(currentRelayInfo.sessionName);
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
  const relayPath = getRelayPath(targetSessionName);
  
  if (!existsSync(relayPath)) {
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
  const relayPath = getRelayPath(sourceSession);
  if (!existsSync(relayPath)) return false;
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
      body: JSON.stringify({ id: messageId, secret: sourceSecret }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    return data.ok;
  } catch { return false; }
}