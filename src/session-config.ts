/**
 * Session configuration and registry management for teleg-bridge.
 * 
 * Handles:
 * - Global config (bot tokens, allowed users) — ~/.pi/agent/teleg-bridge.json
 * - Session registry (live sessions, primary election) — ~/.pi/agent/teleg-sessions.json
 * - Session ID generation (persists across turns via global)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const SESSION_REGISTRY_FILE = join(CONFIG_DIR, "teleg-sessions.json");

// ============================================================================
// Session ID (persists across turns via global)
// ============================================================================

const SESSION_ID_KEY = "__teleg_session_id";

export function getSessionId(): string {
  const g = globalThis as unknown as Record<string, string | undefined>;
  if (typeof g[SESSION_ID_KEY] === "undefined") {
    g[SESSION_ID_KEY] = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return g[SESSION_ID_KEY]!;
}

// ============================================================================
// Types
// ============================================================================

export interface TelegramConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserIds?: number[];
  lastUpdateId?: number;
  archiveRoot?: string;
}

export interface SessionInfo {
  sessionId: string;
  sessionName: string;
  pid: number;
  connectedAt: number;
  lastActivity: number;
  isActive: boolean;
  announcedPresence?: boolean;
  botToken?: string;
  projectDir?: string;
  capabilities?: string[];
  description?: string;
  botId?: number;
}

export interface SessionRegistry {
  version: number;
  sessions: SessionInfo[];
  primarySessionId?: string;
  primaryByBot?: Record<string, string>;
}

// ============================================================================
// Config I/O
// ============================================================================

export async function readConfig(): Promise<TelegramConfig> {
  const CONFIG_FILE = join(CONFIG_DIR, "teleg-bridge.json");
  try {
    const content = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(content) as TelegramConfig & { allowedUserId?: number };
    // Migrate old allowedUserId (singular) to allowedUserIds (plural array)
    if (parsed.allowedUserId && (!parsed.allowedUserIds || parsed.allowedUserIds.length === 0)) {
      parsed.allowedUserIds = [parsed.allowedUserId];
    }
    delete (parsed as Record<string, unknown>).allowedUserId;
    return parsed;
  } catch {
    return {};
  }
}

export async function writeConfig(cfg: TelegramConfig): Promise<void> {
  const CONFIG_FILE = join(CONFIG_DIR, "teleg-bridge.json");
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, "\t") + "\n", "utf8");
}

// ============================================================================
// Session Registry I/O
// ============================================================================

export async function readSessionRegistry(): Promise<SessionRegistry> {
  try {
    const content = await readFile(SESSION_REGISTRY_FILE, "utf8");
    const data = JSON.parse(content) as Partial<SessionRegistry>;
    return {
      version: data.version ?? 1,
      sessions: data.sessions ?? [],
      primarySessionId: data.primarySessionId,
      primaryByBot: data.primaryByBot ?? {},
    };
  } catch {
    return { version: 2, sessions: [], primaryByBot: {} };
  }
}

export async function writeSessionRegistry(reg: SessionRegistry): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SESSION_REGISTRY_FILE, JSON.stringify(reg, null, "\t") + "\n", "utf8");
}

// ============================================================================
// User Allowlist
// ============================================================================

export function isAllowedUser(config: TelegramConfig, userId: number): boolean {
  if (!config.allowedUserIds || config.allowedUserIds.length === 0) {
    return false;
  }
  return config.allowedUserIds.includes(userId);
}

// ============================================================================
// Archive
// ============================================================================

const DEFAULT_ARCHIVE_ROOT = join(homedir(), "pi-teleg-archive");

export function getArchiveRoot(config: TelegramConfig): string {
  return config.archiveRoot || DEFAULT_ARCHIVE_ROOT;
}