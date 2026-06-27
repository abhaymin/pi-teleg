/**
 * Multi-bot configuration and context resolution for teleg-bridge.
 * 
 * Every Pi session resolves a BotContext before touching Telegram or DB.
 * Supports multiple bots on one machine via bot_id scoping.
 * 
 * Resolution order:
 *   1. TELEG_BOT_TOKEN env var (force token for this process)
 *   2. TELEG_BOT_ID env var (select bot from global config)
 *   3. Project .pi/teleg.json (project-specific config)
 *   4. Global ~/.pi/agent/teleg-bridge.json (shared config)
 * 
 * Config migration:
 *   - Legacy v1 (flat botToken at root) auto-migrates to v2 (bots object)
 *   - Uses getMe to discover botId for legacy configs
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(CONFIG_DIR, "teleg-bridge.json");

// ============================================================================
// Types
// ============================================================================

export interface BotEntry {
  botToken: string;
  botUsername?: string;
  botId?: number;
  allowedUserIds: number[];
  allowedChatIds?: number[];
  lastUpdateId: number;
}

export interface GlobalConfigV2 {
  version: 2;
  defaultBotId: number;
  bots: Record<string, BotEntry>; // keyed by botId as string
}

export interface ProjectConfig {
  botId?: number;
  botUsername?: string;
  botToken?: string;
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  lastUpdateId?: number;
  dbPath?: string;
}

export interface BotContext {
  botId: number;           // Telegram bot user ID (from getMe)
  botToken: string;
  botUsername: string;
  allowedUserIds: number[];
  allowedChatIds: number[];
  dbPath: string;          // Path to shared SQLite DB
  lastUpdateId: number;
  projectDir: string;      // Where we resolved from
  isLegacy: boolean;       // True if migrated from v1 config
}

// Legacy config shape (v1)
interface TelegramConfigV1 {
  botToken?: string;
  botUsername?: string;
  botId?: number;
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  allowedUserId?: number; // old singular form
  lastUpdateId?: number;
  archiveRoot?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_DB_PATH = join(CONFIG_DIR, "teleg-bridge.db");
const CURRENT_VERSION = 2;

// ============================================================================
// Telegram API helpers
// ============================================================================

interface TelegramGetMeResponse {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  };
  description?: string;
  error_code?: number;
}

export async function getMeFromToken(token: string): Promise<{ botId: number; botUsername: string } | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as TelegramGetMeResponse;
    if (data.ok && data.result) {
      return {
        botId: data.result.id,
        botUsername: data.result.username || data.result.first_name,
      };
    }
    console.error(`[config] getMe failed: ${data.description}`);
    return null;
  } catch (err) {
    console.error(`[config] getMe error: ${err}`);
    return null;
  }
}

// ============================================================================
// Config file I/O
// ============================================================================

async function readGlobalConfig(): Promise<GlobalConfigV2 | null> {
  try {
    const content = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(content);
    // Handle legacy v1 format (flat botToken at root)
    if ("botToken" in parsed && !("bots" in parsed)) {
      return null; // Legacy v1 — handled separately in resolveFromToken
    }
    return parsed as GlobalConfigV2;
  } catch {
    return null;
  }
}

// Sync version for use in migrations
export function readGlobalConfigSync(): GlobalConfigV2 | null {
  try {
    const content = readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(content) as GlobalConfigV2;
  } catch {
    return null;
  }
}

async function writeGlobalConfig(cfg: GlobalConfigV2): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, "\t") + "\n", "utf8");
}

function readProjectConfig(projectDir: string): ProjectConfig {
  const projectCfgPath = join(projectDir, ".pi", "teleg.json");
  try {
    const content = readFileSync(projectCfgPath, "utf8");
    return JSON.parse(content) as ProjectConfig;
  } catch {
    return {};
  }
}
export async function writeProjectConfig(projectDir: string, cfg: ProjectConfig): Promise<void> {
  const projectCfgDir = join(projectDir, ".pi");
  const projectCfgPath = join(projectCfgDir, "teleg.json");
  const existing = readProjectConfig(projectDir);
  const next: ProjectConfig = {
    ...existing,
    ...cfg,
    botId: cfg.botId ?? existing.botId,
    botUsername: cfg.botUsername ?? existing.botUsername,
    botToken: cfg.botToken ?? existing.botToken,
    allowedUserIds: cfg.allowedUserIds ?? existing.allowedUserIds,
    allowedChatIds: cfg.allowedChatIds ?? existing.allowedChatIds,
    lastUpdateId: cfg.lastUpdateId ?? existing.lastUpdateId,
    dbPath: cfg.dbPath ?? existing.dbPath,
  };

  await mkdir(projectCfgDir, { recursive: true });
  await writeFile(projectCfgPath, JSON.stringify(next, null, "\t") + "\n", "utf8");
}

function applyProjectConfig(context: BotContext, projectCfg: ProjectConfig, projectDir: string): BotContext {
  return {
    ...context,
    projectDir,
    allowedUserIds: projectCfg.allowedUserIds ?? context.allowedUserIds,
    allowedChatIds: projectCfg.allowedChatIds ?? context.allowedChatIds,
    lastUpdateId: projectCfg.lastUpdateId ?? context.lastUpdateId,
    dbPath: projectCfg.dbPath ?? context.dbPath,
  };
}

// ============================================================================
// Legacy migration
// ============================================================================

// Background migration to v2 (no need to block on getMe)
async function migrateToV2(legacy: TelegramConfigV1): Promise<void> {
  const me = await getMeFromToken(legacy.botToken!);
  const botId = legacy.botId!;
  const newConfig: GlobalConfigV2 = {
    version: CURRENT_VERSION,
    defaultBotId: botId,
    bots: {
      [botId]: {
        botToken: legacy.botToken!,
        botUsername: me?.botUsername ?? legacy.botUsername ?? "unknown",
        botId,
        allowedUserIds: legacy.allowedUserIds || [],
        allowedChatIds: legacy.allowedChatIds || [],
        lastUpdateId: legacy.lastUpdateId || 0,
      },
    },
  };
  await writeGlobalConfig(newConfig);
}

/**
 * Migrate legacy v1 config (flat botToken at root) to v2 (bots object).
 * Uses getMe to discover the botId for the legacy token.
 */
async function migrateLegacyConfig(token: string): Promise<BotContext> {

  const me = await getMeFromToken(token);
  if (!me) {
    throw new Error(`Cannot migrate legacy config: getMe failed for token`);
  }

  const legacyConfig: TelegramConfigV1 = {
    botToken: token,
    botUsername: me.botUsername,
    botId: me.botId,
    allowedUserIds: [],
    allowedChatIds: [],
    lastUpdateId: 0,
  };

  // Preserve allowedUserId (singular) if present
  const existing = await readGlobalConfig();
  if (existing) {
    legacyConfig.allowedUserIds = existing.bots[String(me.botId)]?.allowedUserIds || [];
  }

  const newConfig: GlobalConfigV2 = {
    version: CURRENT_VERSION,
    defaultBotId: me.botId,
    bots: {
      [me.botId]: {
        botToken: legacyConfig.botToken!,
        botUsername: legacyConfig.botUsername,
        botId: legacyConfig.botId,
        allowedUserIds: legacyConfig.allowedUserIds || [],
        allowedChatIds: legacyConfig.allowedChatIds || [],
        lastUpdateId: legacyConfig.lastUpdateId || 0,
      },
    },
  };

  await writeGlobalConfig(newConfig);

  return buildBotContext(newConfig.bots[String(me.botId)], process.cwd(), false);
}

// ============================================================================
// BotContext resolution
// ============================================================================

/**
 * Resolve BotContext for a given project directory.
 * 
 * Resolution order:
 *   1. TELEG_BOT_TOKEN env var → use directly, register in global config if needed
 *   2. TELEG_BOT_ID env var → select from global config's bots
 *   3. Project .pi/teleg.json → use token, register if not in global
 *   4. Global config → use defaultBotId
 * 
 * @param projectDir Working directory of the Pi session
 * @returns Resolved BotContext
 * @throws Error if no valid configuration found
 */
export async function resolveBotContext(projectDir: string): Promise<BotContext> {
  // 1. Check TELEG_BOT_TOKEN (highest priority — force token for this process)
  const envToken = process.env.TELEG_BOT_TOKEN;
  if (envToken) {
    return resolveFromToken(envToken, projectDir, "env");
  }

  // 2. Check TELEG_BOT_ID (select specific bot from global config)
  const envBotId = process.env.TELEG_BOT_ID;
  if (envBotId) {
    const botId = parseInt(envBotId, 10);
    if (isNaN(botId)) {
      throw new Error(`TELEG_BOT_ID is not a valid number: ${envBotId}`);
    }
    const context = await resolveFromBotId(botId, projectDir);
    if (context) return context;
    throw new Error(`Bot ${botId} not found in global config`);
  }

  const projectCfg = readProjectConfig(projectDir);

  // 3. Project .pi/teleg.json pin for this folder
  if (projectCfg.botToken) {
    const context = await resolveFromToken(projectCfg.botToken, projectDir, "project");
    if (projectCfg.botId && context.botId !== projectCfg.botId) {
      throw new Error(`Project config botId ${projectCfg.botId} does not match bot token ${context.botId}`);
    }
    return applyProjectConfig(context, projectCfg, projectDir);
  }
  if (projectCfg.botId && projectCfg.botId > 0) {
    const context = await resolveFromBotId(projectCfg.botId, projectDir);
    if (!context) {
      throw new Error(`Project config pins bot ${projectCfg.botId}, but it is not present in global config`);
    }
    return applyProjectConfig(context, projectCfg, projectDir);
  }

  // 4. Fall back to global config (try v2 first, then legacy v1)
  const globalCfg = await readGlobalConfig();
  if (globalCfg && globalCfg.defaultBotId) {
    const context = await resolveFromBotId(globalCfg.defaultBotId, projectDir);
    if (context) return applyProjectConfig(context, projectCfg, projectDir);
  }
  // Try legacy v1 config (flat format with botToken at root)
  try {
    const legacyContent = readFileSync(CONFIG_FILE, "utf8");
    const legacy = JSON.parse(legacyContent) as TelegramConfigV1;
    if (legacy.botToken && legacy.botId) {
      // Use legacy config directly — we already have botId and token
      const entry: BotEntry = {
        botToken: legacy.botToken,
        botUsername: legacy.botUsername,
        botId: legacy.botId,
        allowedUserIds: legacy.allowedUserIds || [],
        allowedChatIds: legacy.allowedChatIds || [],
        lastUpdateId: legacy.lastUpdateId || 0,
      };
      // Migrate to v2 in background
      migrateToV2(legacy).catch(() => {});
      return applyProjectConfig(buildBotContext(entry, projectDir, false), projectCfg, projectDir);
    }
  } catch {
    // No legacy config either
  }

  throw new Error("No valid bot configuration found. Set TELEG_BOT_TOKEN, TELEG_BOT_ID, or configure .pi/teleg.json");
}

export type BotResolutionSource = "env" | "local" | "global" | "none";

export interface BotResolutionResult {
  context?: BotContext;
  source: BotResolutionSource;
  /** Why resolution failed (set when source === "none"). */
  reason?: string;
}

/**
 * Intelligent, explicit bot resolution with a structured result so the caller
 * can drive the Pi harness (e.g. prompt the user) when nothing resolves.
 *
 * Order:
 *   1. TELEG_BOT_TOKEN / TELEG_BOT_ID env (explicit force-override)
 *   2. LOCAL project `.pi/teleg.json` — botToken verified against the Telegram
 *      API; an invalid local token FALLS THROUGH to global instead of throwing.
 *      API-confirmed botId/botUsername are written back if the file drifted.
 *   3. GLOBAL `~/.pi/agent/teleg-bridge.json` (defaultBotId)
 *   4. none — caller should ask the user for a bot token.
 *
 * Never throws: failures are reported as { source: "none", reason }.
 */
export async function resolveBotContextInteractive(projectDir: string): Promise<BotResolutionResult> {
  // 1a. Force-override via TELEG_BOT_TOKEN.
  const envToken = process.env.TELEG_BOT_TOKEN;
  if (envToken) {
    try {
      return { context: await resolveFromToken(envToken, projectDir, "env"), source: "env" };
    } catch (err) {
      return { source: "none", reason: `TELEG_BOT_TOKEN is set but invalid: ${err instanceof Error ? err.message : err}` };
    }
  }
  // 1b. Force-select via TELEG_BOT_ID.
  const envBotId = process.env.TELEG_BOT_ID;
  if (envBotId) {
    const botId = parseInt(envBotId, 10);
    if (!isNaN(botId)) {
      const context = await resolveFromBotId(botId, projectDir);
      if (context) return { context, source: "env" };
      return { source: "none", reason: `TELEG_BOT_ID ${botId} is not registered in global config` };
    }
    return { source: "none", reason: `TELEG_BOT_ID is not a valid number: ${envBotId}` };
  }

  const projectCfg = readProjectConfig(projectDir);

  // 2. LOCAL first: a botToken in .pi/teleg.json, verified against the API.
  const localToken = projectCfg.botToken?.trim();
  if (localToken) {
    const me = await getMeFromToken(localToken);
    if (me) {
      try {
        let context = await resolveFromToken(localToken, projectDir, "project");
        context = applyProjectConfig(context, projectCfg, projectDir);
        // Honour the API as source of truth: correct drifted id/username locally.
        if (projectCfg.botId !== me.botId || projectCfg.botUsername !== me.botUsername) {
          await writeProjectConfig(projectDir, { botId: me.botId, botUsername: me.botUsername, botToken: localToken });
        }
        return { context, source: "local" };
      } catch (err) {
        return { source: "none", reason: `Local token verified by getMe but context build failed: ${err instanceof Error ? err.message : err}` };
      }
    }
    // Local token present but rejected by the API → fall through to global.
  }

  // 3. GLOBAL config (default bot).
  const globalCfg = await readGlobalConfig();
  if (globalCfg?.defaultBotId) {
    const context = await resolveFromBotId(globalCfg.defaultBotId, projectDir);
    if (context) return { context: applyProjectConfig(context, projectCfg, projectDir), source: "global" };
  }

  // 4. Nothing resolved — caller asks the user.
  return { source: "none", reason: "No valid bot in local .pi/teleg.json or global ~/.pi/agent/teleg-bridge.json" };
}

/**
 * Resolve from a bot token. Register in global config if not present.
 */
async function resolveFromToken(
  token: string,
  projectDir: string,
  source: "env" | "project"
): Promise<BotContext> {
  const me = await getMeFromToken(token);
  if (!me) {
    throw new Error(`Invalid bot token: cannot call getMe`);
  }

  const globalCfg = await readGlobalConfig();
  let botEntry = globalCfg?.bots[String(me.botId)];

  if (!botEntry) {
    // Register this bot in global config

    const newCfg: GlobalConfigV2 = globalCfg || {
      version: CURRENT_VERSION,
      defaultBotId: me.botId,
      bots: {},
    };

    // If upgrading from v1, preserve the old config for migration
    if (!globalCfg) {
      // Fresh v2 config
    } else if (globalCfg.version !== CURRENT_VERSION) {
      console.warn("[config] Upgrading config to v2 format");
    }

    newCfg.defaultBotId = me.botId;
    newCfg.bots[String(me.botId)] = {
      botToken: token,
      botUsername: me.botUsername,
      botId: me.botId,
      allowedUserIds: [],
      allowedChatIds: [],
      lastUpdateId: 0,
    };
    await writeGlobalConfig(newCfg);
    botEntry = newCfg.bots[String(me.botId)];
  }

  return buildBotContext(botEntry, projectDir, source === "env");
}

/**
 * Resolve a full BotContext for a specific botId from the global config.
 * Used by the bot-selection flow to activate a chosen bot without re-entering
 * its token. Returns null if the bot is not registered.
 */
export async function resolveFromBotId(botId: number, projectDir: string): Promise<BotContext | null> {
  const globalCfg = await readGlobalConfig();
  if (!globalCfg) {
    // Try legacy v1 config
    try {
      const legacyContent = readFileSync(CONFIG_FILE, "utf8");
      const legacy = JSON.parse(legacyContent) as TelegramConfigV1;
      if (legacy.botToken && legacy.botId === botId) {
        const entry: BotEntry = {
          botToken: legacy.botToken,
          botUsername: legacy.botUsername,
          botId: legacy.botId,
          allowedUserIds: legacy.allowedUserIds || [],
          allowedChatIds: legacy.allowedChatIds || [],
          lastUpdateId: legacy.lastUpdateId || 0,
        };
        return buildBotContext(entry, projectDir, false);
      }
    } catch { /* no legacy config */ }
    return null;
  }

  const botEntry = globalCfg.bots[String(botId)];
  if (!botEntry) return null;

  return buildBotContext(botEntry, projectDir, false);
}

/**
 * Build BotContext from a BotEntry.
 */
function buildBotContext(entry: BotEntry, projectDir: string, isFromEnv: boolean): BotContext {
  // Resolve dbPath
  const dbPath = process.env.TELEG_DB_PATH || DEFAULT_DB_PATH;

  return {
    botId: entry.botId || 0,
    botToken: entry.botToken,
    botUsername: entry.botUsername || "unknown",
    allowedUserIds: entry.allowedUserIds || [],
    allowedChatIds: entry.allowedChatIds || [],
    dbPath,
    lastUpdateId: entry.lastUpdateId || 0,
    projectDir,
    isLegacy: isFromEnv && !entry.botId,
  };
}

// ============================================================================
// Bot config CRUD (per-bot operations)
// ============================================================================

/**
 * Save the last update ID for a specific bot.
 * Updates the global config file (atomically via write).
 */
export async function saveLastUpdateId(botId: number, offset: number): Promise<void> {
  const cfg = await readGlobalConfig();
  if (!cfg) {
    console.warn("[config] Cannot save lastUpdateId: no global config");
    return;
  }

  const key = String(botId);
  if (!cfg.bots[key]) {
    console.warn(`[config] Cannot save lastUpdateId: bot ${botId} not in config`);
    return;
  }

  cfg.bots[key].lastUpdateId = offset;
  await writeGlobalConfig(cfg);
}

/**
 * Load the full BotEntry for a specific bot.
 */
export async function loadBotConfig(botId: number): Promise<BotEntry | null> {
  const cfg = await readGlobalConfig();
  if (!cfg) return null;
  return cfg.bots[String(botId)] || null;
}

/**
 * Update allowed users for a specific bot.
 */
export async function updateAllowedUsers(botId: number, userIds: number[]): Promise<void> {
  const cfg = await readGlobalConfig();
  if (!cfg) return;

  const key = String(botId);
  if (!cfg.bots[key]) return;

  cfg.bots[key].allowedUserIds = userIds;
  await writeGlobalConfig(cfg);
}

// ============================================================================
// Split DB detection
// ============================================================================

/**
 * Detect if the same botId is configured with different DB paths across sessions.
 * Returns a warning message if split DB detected, null otherwise.
 */
export async function detectSplitDb(botId: number, currentDbPath: string): Promise<string | null> {
  const globalCfg = await readGlobalConfig();
  if (!globalCfg) return null;

  const entry = globalCfg.bots[String(botId)];
  if (!entry) return null;

  // Note: We can't actually detect other sessions' DB paths without shared state.
  // This is a heuristic check that compares current path to default.
  // In practice, all sessions using the same botId should use the same DB path.
  const defaultPath = DEFAULT_DB_PATH;
  
  if (currentDbPath !== defaultPath) {
    return `Warning: bot ${botId} using non-default DB path: ${currentDbPath} (expected: ${defaultPath}). ` +
           `Multiple sessions with same bot but different DB paths will have isolated queues and won't see each other's messages.`;
  }

  return null;
}

// ============================================================================
// Config inspection utilities
// ============================================================================

/**
 * Get list of all configured bots from global config.
 */
export async function listConfiguredBots(): Promise<Array<{ botId: number; botUsername: string; lastUpdateId: number }>> {
  const cfg = await readGlobalConfig();
  if (!cfg) return [];

  return Object.entries(cfg.bots).map(([id, entry]) => ({
    botId: parseInt(id, 10),
    botUsername: entry.botUsername || "unknown",
    lastUpdateId: entry.lastUpdateId,
  }));
}

/**
 * Get the default bot ID from global config.
 */
export async function getDefaultBotId(): Promise<number | null> {
  const cfg = await readGlobalConfig();
  return cfg?.defaultBotId ?? null;
}

/**
 * Set the default bot ID in the global config (the bot used when no project
 * pin or env override applies). Silently no-ops when no global config exists.
 */
export async function setDefaultBotId(botId: number): Promise<void> {
  const cfg = await readGlobalConfig();
  if (!cfg) return;
  cfg.defaultBotId = botId;
  await writeGlobalConfig(cfg);
}

/**
 * Check if a config file exists and its version.
 */
export async function getConfigVersion(): Promise<1 | 2 | null> {
  const globalCfg = await readGlobalConfig();
  if (!globalCfg) {
    // Check for legacy v1 by looking for botToken at root level
    try {
      const content = readFileSync(CONFIG_FILE, "utf8");
      const parsed = JSON.parse(content) as TelegramConfigV1;
      if (parsed.botToken) return 1;
    } catch {
      // File doesn't exist or invalid JSON
    }
    return null;
  }
  return globalCfg.version as 2;
}