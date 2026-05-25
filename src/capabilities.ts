/**
 * Session capabilities detection and registry.
 * 
 * Detects capabilities from INFO_REL.md, AGENTS.md, or README.md in project directories.
 * Tracks capabilities per session in a JSON registry.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
  registeredAt: number;
}

export interface CapabilitiesRegistry {
  entries: CapabilitiesEntry[];
  lastUpdated: number;
}

// ============================================================================
// Capability Detection
// ============================================================================

/**
 * Parse capabilities from a markdown file content.
 * Looks for:
 *   ## capabilities
 *     keyword1, keyword2, ...
 *   ## description
 *     What this session does
 */
function parseCapabilitiesMd(content: string): { capabilities: string[]; description: string } {
  const result: { capabilities: string[]; description: string } = { capabilities: [], description: "" };
  let currentSection = "";
  
  const lines = content.split("\n");
  for (const line of lines) {
    const header = line.match(/^##?\s*(.+)/);
    if (header) {
      currentSection = header[1].trim().toLowerCase();
      continue;
    }
    
    if (currentSection === "capabilities" && line.trim()) {
      result.capabilities = line.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    if (currentSection === "description" && line.trim() && !result.description) {
      result.description = line.trim();
    }
  }
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
export function detectProjectCapabilities(projectDir: string): { capabilities: string[]; description: string } {
  // Try INFO_REL.md first
  const infoRel = tryReadFile(projectDir, "INFO_REL.md");
  if (infoRel) {
    const result = parseCapabilitiesMd(infoRel);
    if (result.capabilities.length > 0) return result;
  }
  
  // Try AGENTS.md
  const agentsMd = tryReadFile(projectDir, "AGENTS.md");
  if (agentsMd) {
    const result = parseCapabilitiesMd(agentsMd);
    if (result.capabilities.length > 0) return result;
  }
  
  // Fallback: README.md
  const readme = tryReadFile(projectDir, "README.md");
  if (readme) {
    const result = { capabilities: [] as string[], description: "" as string };
    // First non-header line as description
    const firstLine = readme.split("\n").find(l => l.trim().length > 0 && !l.startsWith("#"))?.trim() || "";
    if (firstLine) result.description = firstLine;
    // Use folder name as capability
    const folderName = projectDir.split("/").filter(Boolean).pop()?.toLowerCase() || "";
    if (folderName) result.capabilities.push(folderName.replace(/[^a-z0-9-]/g, ""));
    return result;
  }
  
  return { capabilities: [], description: "" };
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
): Promise<void> {
  const { capabilities, description } = detectProjectCapabilities(projectDir);
  
  const homeDir = homedir();
  // Skip home directory and sensitive paths
  if (projectDir === homeDir || projectDir === "/" || projectDir.startsWith(homeDir + "/.")) return;
  if (capabilities.length === 0 && !description) return;
  
  const reg = await readCapabilitiesRegistry();
  reg.entries = reg.entries.filter(e => e.sessionId !== sessionId);
  reg.entries.push({ sessionName, sessionId, pid, projectDir, capabilities, description, registeredAt: Date.now() });
  await writeCapabilitiesRegistry(reg);
}

export async function unregisterSessionCapabilities(sessionId: string): Promise<void> {
  const reg = await readCapabilitiesRegistry();
  reg.entries = reg.entries.filter(e => e.sessionId !== sessionId);
  await writeCapabilitiesRegistry(reg);
}

export async function cleanStaleCapabilities(): Promise<void> {
  const reg = await readCapabilitiesRegistry();
  const before = reg.entries.length;
  reg.entries = reg.entries.filter(e => {
    try { process.kill(e.pid, 0); return true; } catch { return false; }
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
    try { process.kill(entry.pid, 0); } catch { continue; }
    const caps = entry.capabilities.map(c => c.toLowerCase());
    
    if (hasTwitter && caps.some(c => c.includes("twitter") || c.includes("tweet") || c.includes("media") || c.includes("download"))) return entry;
    if (hasYoutube && caps.some(c => c.includes("youtube") || c.includes("video") || c.includes("media") || c.includes("download"))) return entry;
    if (hasReddit && caps.some(c => c.includes("reddit") || c.includes("media") || c.includes("download"))) return entry;
    
    // Generic keyword match
    if (entry.description) {
      const descLower = entry.description.toLowerCase();
      const keywords = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      for (const kw of keywords) {
        if (descLower.includes(kw)) return entry;
      }
    }
  }
  return null;
}