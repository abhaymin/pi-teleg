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
  allowedChatIds?: number[];
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

interface BotEntryConfig {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  lastUpdateId?: number;
}

interface GlobalConfigV2 {
  version: 2;
  defaultBotId?: number;
  bots?: Record<string, BotEntryConfig>;
  archiveRoot?: string;
}

// ============================================================================
// Config I/O
// ============================================================================

function flattenV2Config(parsed: GlobalConfigV2): TelegramConfig {
  const defaultBotId = parsed.defaultBotId;
  const botEntry = defaultBotId ? parsed.bots?.[String(defaultBotId)] : undefined;
  if (!botEntry) return { archiveRoot: parsed.archiveRoot };
  return {
    botToken: botEntry.botToken,
    botUsername: botEntry.botUsername,
    botId: botEntry.botId ?? defaultBotId,
    allowedUserIds: botEntry.allowedUserIds || [],
    allowedChatIds: botEntry.allowedChatIds || [],
    lastUpdateId: botEntry.lastUpdateId || 0,
    archiveRoot: parsed.archiveRoot,
  };
}

export async function readConfig(): Promise<TelegramConfig> {
  const CONFIG_FILE = join(CONFIG_DIR, "teleg-bridge.json");
  try {
    const content = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(content) as (TelegramConfig & { allowedUserId?: number }) | GlobalConfigV2;
    if ((parsed as GlobalConfigV2).version === 2 && (parsed as GlobalConfigV2).bots) {
      return flattenV2Config(parsed as GlobalConfigV2);
    }
    const legacy = parsed as TelegramConfig & { allowedUserId?: number };
    // Migrate old allowedUserId (singular) to allowedUserIds (plural array)
    if (legacy.allowedUserId && (!legacy.allowedUserIds || legacy.allowedUserIds.length === 0)) {
      legacy.allowedUserIds = [legacy.allowedUserId];
    }
    delete (legacy as Record<string, unknown>).allowedUserId;
    return legacy;
  } catch {
    return {};
  }
}

export async function writeConfig(cfg: TelegramConfig): Promise<void> {
  const CONFIG_FILE = join(CONFIG_DIR, "teleg-bridge.json");
  await mkdir(CONFIG_DIR, { recursive: true });
  try {
    const existing = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as GlobalConfigV2;
    if (existing.version === 2 && existing.bots && cfg.botToken && cfg.botId) {
      const key = String(cfg.botId);
      const current = existing.bots[key] || {};
      const next: GlobalConfigV2 = {
        ...existing,
        version: 2,
        defaultBotId: cfg.botId,
        bots: {
          ...existing.bots,
          [key]: {
            ...current,
            botToken: cfg.botToken,
            botUsername: cfg.botUsername ?? current.botUsername,
            botId: cfg.botId,
            allowedUserIds: cfg.allowedUserIds ?? current.allowedUserIds ?? [],
            allowedChatIds: cfg.allowedChatIds ?? current.allowedChatIds ?? [],
            lastUpdateId: cfg.lastUpdateId ?? current.lastUpdateId ?? 0,
          },
        },
        archiveRoot: cfg.archiveRoot ?? existing.archiveRoot,
      };
      await writeFile(CONFIG_FILE, JSON.stringify(next, null, "\t") + "\n", "utf8");
      return;
    }
  } catch {
    // Fall through to legacy flat write.
  }
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

export function isAllowedChat(config: TelegramConfig, chatId: number): boolean {
  if (!config.allowedChatIds || config.allowedChatIds.length === 0) {
    return false;
  }
  return config.allowedChatIds.includes(chatId);
}

// ============================================================================
// Archive
// ============================================================================

const DEFAULT_ARCHIVE_ROOT = join(homedir(), "pi-teleg-archive");

export function getArchiveRoot(config: TelegramConfig): string {
  return config.archiveRoot || DEFAULT_ARCHIVE_ROOT;
}