/**
 * Session capabilities detection and registry.
 *
 * Detects capabilities from INFO_REL.md, AGENTS.md, or README.md in project directories.
 * Tracks capabilities per session in a JSON registry.
 * Also parses optional linked_chats / linked_users for shared-bot multi-instance routing.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CAPABILITIES_FILE = join(CONFIG_DIR, "teleg-capabilities.json");

// ============================================================================
// Types
// ============================================================================

export interface CapabilitiesEntry {
  sessionName: string;
  sessionId: string;
  pid: number;
  projectDir: string;
  capabilities: string[];
  description: string;
  linkedChatIds?: number[];
  linkedUserIds?: number[];
  registeredAt: number;
  botId?: number;
}

export interface CapabilitiesRegistry {
  entries: CapabilitiesEntry[];
  lastUpdated: number;
}

export interface ProjectCapabilityInfo {
  capabilities: string[];
  description: string;
  linkedChatIds: number[];
  linkedUserIds: number[];
}

export interface InstanceLinkCandidate {
  sessionName: string;
  linkedChatIds: number[];
  linkedUserIds: number[];
  capabilities: string[];
  description: string;
}

// ============================================================================
// Capability Detection
// ============================================================================

function parseIdListLine(line: string): number[] {
  return line
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

/**
 * Parse capabilities from a markdown file content.
 * Looks for:
 *   ## capabilities
 *     keyword1, keyword2, ...
 *   ## description
 *     What this session does
 *   ## linked_chats  (optional — Telegram chat/channel ids this instance owns)
 *     1100787134, -1001234567890
 *   ## linked_users  (optional — DM user ids)
 *     123456789
 */
function parseCapabilitiesMd(content: string): ProjectCapabilityInfo {
  const result: ProjectCapabilityInfo = {
    capabilities: [],
    description: "",
    linkedChatIds: [],
    linkedUserIds: [],
  };
  let currentSection = "";

  const lines = content.split("\n");
  for (const line of lines) {
    const header = line.match(/^##?\s*(.+)/);
    if (header) {
      currentSection = header[1].trim().toLowerCase().replace(/\s+/g, "_");
      continue;
    }

    if (!line.trim()) continue;

    if (currentSection === "capabilities") {
      result.capabilities = line.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    if (currentSection === "description" && !result.description) {
      result.description = line.trim();
    }
    if (currentSection === "linked_chats" || currentSection === "chats" || currentSection === "channels") {
      result.linkedChatIds.push(...parseIdListLine(line));
    }
    if (currentSection === "linked_users" || currentSection === "users") {
      result.linkedUserIds.push(...parseIdListLine(line));
    }
  }
  result.linkedChatIds = [...new Set(result.linkedChatIds)];
  result.linkedUserIds = [...new Set(result.linkedUserIds)];
  return result;
}

function tryReadFile(projectDir: string, filename: string): string | null {
  const path = join(projectDir, filename);
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Detect capabilities from a project's documentation files.
 * Looks for INFO_REL.md, AGENTS.md, or README.md.
 */
export function detectProjectCapabilities(projectDir: string): ProjectCapabilityInfo {
  const infoRel = tryReadFile(projectDir, "INFO_REL.md");
  if (infoRel) {
    const result = parseCapabilitiesMd(infoRel);
    if (result.capabilities.length > 0 || result.linkedChatIds.length > 0 || result.linkedUserIds.length > 0) {
      return result;
    }
  }

  const agentsMd = tryReadFile(projectDir, "AGENTS.md");
  if (agentsMd) {
    const result = parseCapabilitiesMd(agentsMd);
    if (result.capabilities.length > 0 || result.linkedChatIds.length > 0) return result;
  }

  const readme = tryReadFile(projectDir, "README.md");
  if (readme) {
    const result: ProjectCapabilityInfo = {
      capabilities: [],
      description: "",
      linkedChatIds: [],
      linkedUserIds: [],
    };
    const firstLine = readme.split("\n").find((l) => l.trim().length > 0 && !l.startsWith("#"))?.trim() || "";
    if (firstLine) result.description = firstLine;
    const folderName = projectDir.split("/").filter(Boolean).pop()?.toLowerCase() || "";
    if (folderName) result.capabilities.push(folderName.replace(/[^a-z0-9-]/g, ""));
    return result;
  }

  return { capabilities: [], description: "", linkedChatIds: [], linkedUserIds: [] };
}

// ============================================================================
// Capabilities Registry (JSON)
// ============================================================================

export async function readCapabilitiesRegistry(): Promise<CapabilitiesRegistry> {
  try {
    const content = await readFile(CAPABILITIES_FILE, "utf8");
    return JSON.parse(content);
  } catch {
    return { entries: [], lastUpdated: Date.now() };
  }
}

export async function writeCapabilitiesRegistry(reg: CapabilitiesRegistry): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  reg.lastUpdated = Date.now();
  await writeFile(CAPABILITIES_FILE, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

export async function registerSessionCapabilities(
  sessionId: string,
  sessionName: string,
  pid: number,
  projectDir: string,
  botId?: number,
): Promise<void> {
  const { capabilities, description, linkedChatIds, linkedUserIds } = detectProjectCapabilities(projectDir);

  const homeDir = homedir();
  if (projectDir === homeDir || projectDir === "/" || projectDir.startsWith(homeDir + "/.")) return;
  if (capabilities.length === 0 && !description && linkedChatIds.length === 0 && linkedUserIds.length === 0) return;

  const reg = await readCapabilitiesRegistry();
  reg.entries = reg.entries.filter((e) => e.sessionId !== sessionId);
  reg.entries.push({
    sessionName,
    sessionId,
    pid,
    projectDir,
    capabilities,
    description,
    linkedChatIds,
    linkedUserIds,
    registeredAt: Date.now(),
    botId,
  });
  await writeCapabilitiesRegistry(reg);
}

export async function unregisterSessionCapabilities(sessionId: string): Promise<void> {
  const reg = await readCapabilitiesRegistry();
  reg.entries = reg.entries.filter((e) => e.sessionId !== sessionId);
  await writeCapabilitiesRegistry(reg);
}

export async function cleanStaleCapabilities(): Promise<void> {
  const reg = await readCapabilitiesRegistry();
  const before = reg.entries.length;
  reg.entries = reg.entries.filter((e) => {
    try {
      process.kill(e.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (reg.entries.length !== before) await writeCapabilitiesRegistry(reg);
}

// ============================================================================
// Capability Matching
// ============================================================================

export function matchMessageToCapability(text: string, entries: CapabilitiesEntry[]): CapabilitiesEntry | null {
  const twitterRe = /https?:\/\/(?:x|twitter)\.com\/[^\s<>"']+\/status\/\d+/i;
  const youtubeRe = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/i;
  const redditRe = /https?:\/\/(?:www\.)?reddit\.com\/r\/[^\s<>"']+\/comments\/\w+/i;

  const hasTwitter = twitterRe.test(text);
  const hasYoutube = youtubeRe.test(text);
  const hasReddit = redditRe.test(text);

  for (const entry of entries) {
    try {
      process.kill(entry.pid, 0);
    } catch {
      continue;
    }
    const caps = entry.capabilities.map((c) => c.toLowerCase());

    if (hasTwitter && caps.some((c) => c.includes("twitter") || c.includes("tweet") || c.includes("media") || c.includes("download"))) return entry;
    if (hasYoutube && caps.some((c) => c.includes("youtube") || c.includes("video") || c.includes("media") || c.includes("download"))) return entry;
    if (hasReddit && caps.some((c) => c.includes("reddit") || c.includes("media") || c.includes("download"))) return entry;

    if (entry.description) {
      const descLower = entry.description.toLowerCase();
      const keywords = text.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      for (const kw of keywords) {
        if (descLower.includes(kw)) return entry;
      }
    }
  }
  return null;
}

/**
 * Pick which teleg instance should handle an inbound message when the same bot
 * is shared across multiple Pi folders / Telegram channels.
 *
 * Priority:
 *   1. Unique chat link (teleg.json allowedChatIds ∪ INFO_REL linked_chats)
 *   2. Unique DM user link
 *   3. Among multi-link owners → INFO_REL capability / description match
 *   4. null (caller falls through to sticky / primary)
 */
export function resolveInstanceForMessage(
  chatId: number,
  userId: number | undefined,
  text: string,
  candidates: InstanceLinkCandidate[],
): { sessionName: string; reason: string } | null {
  if (candidates.length === 0) return null;

  const byChat = candidates.filter((c) => c.linkedChatIds.includes(chatId));
  if (byChat.length === 1) {
    return { sessionName: byChat[0].sessionName, reason: "chat_link" };
  }
  if (byChat.length > 1) {
    const asCaps: CapabilitiesEntry[] = byChat.map((c) => ({
      sessionName: c.sessionName,
      sessionId: "",
      pid: process.pid,
      projectDir: "",
      capabilities: c.capabilities,
      description: c.description,
      registeredAt: 0,
    }));
    const match = matchMessageToCapability(text, asCaps);
    if (match) return { sessionName: match.sessionName, reason: "chat_link+info_rel" };
    return { sessionName: byChat[0].sessionName, reason: "chat_link_ambiguous" };
  }

  if (userId) {
    const byUser = candidates.filter((c) => c.linkedUserIds.includes(userId));
    if (byUser.length === 1) {
      return { sessionName: byUser[0].sessionName, reason: "user_link" };
    }
    if (byUser.length > 1) {
      const asCaps: CapabilitiesEntry[] = byUser.map((c) => ({
        sessionName: c.sessionName,
        sessionId: "",
        pid: process.pid,
        projectDir: "",
        capabilities: c.capabilities,
        description: c.description,
        registeredAt: 0,
      }));
      const match = matchMessageToCapability(text, asCaps);
      if (match) return { sessionName: match.sessionName, reason: "user_link+info_rel" };
      return { sessionName: byUser[0].sessionName, reason: "user_link_ambiguous" };
    }
  }

  return null;
}

/** Merge teleg.json allowlists with INFO_REL linked_* lists (unique). */
export function mergeInstanceLinks(
  fromConfig: { chatIds?: number[]; userIds?: number[] },
  fromInfoRel: { linkedChatIds?: number[]; linkedUserIds?: number[] },
): { chatIds: number[]; userIds: number[] } {
  return {
    chatIds: [...new Set([...(fromConfig.chatIds || []), ...(fromInfoRel.linkedChatIds || [])])],
    userIds: [...new Set([...(fromConfig.userIds || []), ...(fromInfoRel.linkedUserIds || [])])],
  };
}
