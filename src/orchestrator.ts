/**
 * Orchestrator mode — multi-session task delegation.
 *
 * Works from BOTH Telegram (`/orchestrate <task>`) and Pi directly
 * (`/orchestrate <task>`). The host session acts as orchestrator:
 * it delegates sub-tasks to other Pi sessions (sub-agents) via the
 * relay system, tracks in-flight work, and reports the aggregated
 * result back to the caller (Telegram or Pi UI).
 *
 * Sub-agents are other Pi sessions (with or without teleg loaded) —
 * they process relay commands directly via their HTTP relay server.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { forwardToSession } from "./relay.js";

// ============================================================================
// Types
// ============================================================================

export interface OrchestrationTask {
  id: string;
  botId: number;
  chatId: number;
  messageId: number;
  originalText: string;
  sourceSession: string;
  subtasks: Subtask[];
  status: "pending" | "running" | "done" | "failed";
  createdAt: number;
  updatedAt: number;
  results: Record<string, string>; // subtask_id → result
}

export interface Subtask {
  id: string;
  targetSession: string;
  payload: string;
  status: "pending" | "dispatched" | "done" | "failed";
  dispatchedAt?: number;
  doneAt?: number;
  result?: string;
  error?: string;
}

export interface OrchestrationState {
  tasks: Map<string, OrchestrationTask>;
}

export interface OrchestrateResult {
  task: OrchestrationTask;
  /** Formatted HTML string for display */
  formatted: string;
}

// ============================================================================
// Persistence (in-memory + optional disk)
// ============================================================================

const STATE_DIR = join(homedir(), ".pi", "agent", "tmp", "teleg-orchestrator");

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function statePath(botId: number): string {
  return join(STATE_DIR, `bot-${botId}.json`);
}

function loadOrchestrationState(botId: number): OrchestrationState {
  ensureStateDir();
  const path = statePath(botId);
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as { tasks: Record<string, OrchestrationTask> };
    return { tasks: new Map(Object.entries(data.tasks)) };
  } catch {
    return { tasks: new Map() };
  }
}

function persistOrchestrationState(botId: number, state: OrchestrationState): void {
  ensureStateDir();
  const path = statePath(botId);
  const data = { tasks: Object.fromEntries(state.tasks) };
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// ============================================================================
// Task creation
// ============================================================================

function createOrchestrationTask(
  botId: number,
  chatId: number,
  messageId: number,
  originalText: string,
  sourceSession: string,
): OrchestrationTask {
  const id = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  return {
    id,
    botId,
    chatId,
    messageId,
    originalText,
    sourceSession,
    subtasks: [],
    status: "pending",
    createdAt: now,
    updatedAt: now,
    results: {},
  };
}

// ============================================================================
// Subtask management
// ============================================================================

function addSubtask(task: OrchestrationTask, targetSession: string, payload: string): Subtask {
  const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const subtask: Subtask = {
    id,
    targetSession,
    payload,
    status: "pending",
  };
  task.subtasks.push(subtask);
  task.updatedAt = Date.now();
  return subtask;
}

async function dispatchSubtask(
  subtask: Subtask,
  chatId: number,
  messageId: number,
): Promise<{ ok: boolean; response?: string; error?: string }> {
  subtask.status = "dispatched";
  subtask.dispatchedAt = Date.now();

  const result = await forwardToSession(subtask.targetSession, subtask.payload, {
    chatId,
    messageId,
    sourceSession: "orchestrator",
  });

  if (result.ok && result.response) {
    subtask.status = "done";
    subtask.result = result.response;
    subtask.doneAt = Date.now();
  } else {
    subtask.status = "failed";
    subtask.error = result.error ?? "Unknown error";
  }

  return result;
}

// ============================================================================
// Result aggregation
// ============================================================================

function markTaskDone(task: OrchestrationTask): void {
  task.status = "done";
  task.updatedAt = Date.now();
  // Collect all subtask results
  for (const st of task.subtasks) {
    if (st.status === "done" && st.result) {
      task.results[st.id] = st.result;
    }
  }
}

function markTaskFailed(task: OrchestrationTask, error: string): void {
  task.status = "failed";
  task.updatedAt = Date.now();
  task.results["_error"] = error;
}

function formatOrchestrationResult(task: OrchestrationTask): string {
  const lines = [
    `<b>📋 Orchestration Result</b>`,
    `<code>${task.id}</code>`,
    "",
    `<b>Original task:</b> ${escapeHtml(task.originalText.slice(0, 200))}${task.originalText.length > 200 ? "…" : ""}`,
    "",
    `<b>Status:</b> ${task.status === "done" ? "✅ Done" : task.status === "failed" ? "❌ Failed" : "⏳ " + task.status}`,
    "",
  ];

  if (task.subtasks.length > 0) {
    lines.push("<b>Subtasks:</b>");
    for (const st of task.subtasks) {
      const icon = st.status === "done" ? "✅" : st.status === "failed" ? "❌" : "⏳";
      lines.push(`• ${icon} <code>@${st.targetSession}</code> — ${st.status}`);
      if (st.result) {
        const preview = st.result.slice(0, 300);
        lines.push(`  ${escapeHtml(preview)}${st.result.length > 300 ? "…" : ""}`);
      }
      if (st.error) {
        lines.push(`  <i>Error: ${escapeHtml(st.error)}</i>`);
      }
    }
    lines.push("");
  }

  if (task.results["_error"]) {
    lines.push(`<i>Aggregate error: ${escapeHtml(task.results["_error"])}</i>`);
  }

  return lines.join("\n");
}

// ============================================================================
// Public API — source-agnostic orchestration
// ============================================================================

/**
 * Run an orchestration task from any source (Telegram or Pi).
 *
 * @param opts.botId - current bot ID
 * @param opts.text - the user's task text
 * @param opts.sourceSession - name of the calling session
 * @param opts.chatId - Telegram chat ID (0 for Pi-direct calls)
 * @param opts.messageId - Telegram message ID (0 for Pi-direct calls)
 * @param opts.notify - optional async callback for progress updates
 */
export async function runOrchestration(opts: {
  botId: number;
  text: string;
  sourceSession: string;
  chatId: number;
  messageId: number;
  notify?: (message: string) => void | Promise<void>;
}): Promise<OrchestrateResult> {
  const { botId, text, sourceSession, chatId, messageId, notify } = opts;

  // Create task
  const task = createOrchestrationTask(botId, chatId, messageId, text, sourceSession);
  const state = loadOrchestrationState(botId);
  state.tasks.set(task.id, task);
  persistOrchestrationState(botId, state);

  await notify?.(`📋 Orchestration started: <code>${task.id}</code>`);

  // Parse the task and identify sub-sessions
  await notify?.(`Analyzing task and dispatching sub-tasks...`);

  // Try to identify sub-sessions from the task text
  const targets = extractSubSessionTargets(text);

  if (targets.length > 0) {
    for (const target of targets) {
      const subtask = addSubtask(task, target, buildSubtaskPayload(text, target));
      await notify?.(`Dispatching to <code>@${target}</code>...`);
      const result = await dispatchSubtask(subtask, chatId, messageId);
      if (notify) {
        await notify(result.ok ? `✅ <code>@${target}</code> completed` : `❌ <code>@${target}</code> failed: ${result.error}`);
      }
    }
  } else {
    // Broadcast to all alive sessions
    await notify?.(`No specific targets identified, broadcasting to all sessions...`);
    const broadcasts = await broadcastToSessions(buildSubtaskPayload(text, "*"), botId);
    for (const br of broadcasts) {
      const st = addSubtask(task, br.session, buildSubtaskPayload(text, br.session));
      if (br.ok && br.response) {
        st.status = "done";
        st.result = br.response;
      } else {
        st.status = "failed";
        st.error = br.error ?? "Unknown error";
      }
      await notify?.(br.ok ? `✅ <code>@${br.session}</code> completed` : `❌ <code>@${br.session}</code> failed`);
    }
  }

  // Mark task done
  markTaskDone(task);
  state.tasks.set(task.id, task);
  persistOrchestrationState(botId, state);

  const formatted = formatOrchestrationResult(task);
  return { task, formatted };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract potential sub-session targets from task text.
 * Looks for @sessionName patterns.
 */
function extractSubSessionTargets(text: string): string[] {
  const targets: string[] = [];
  const sessionMatch = text.match(/@(\w+)/g);
  if (sessionMatch) {
    for (const m of sessionMatch) {
      const name = m.slice(1); // strip @
      if (name && !targets.includes(name)) targets.push(name);
    }
  }
  return targets;
}

/**
 * Build the payload to send to a sub-agent session.
 */
function buildSubtaskPayload(originalText: string, targetSession: string): string {
  return [
    `<b>[teleg-subagent]</b>`,
    `You are a sub-agent being called by the orchestrator.`,
    ``,
    `The orchestrator (<code>@${targetSession}</code> is NOT you) needs you to handle this task:`,
    `<code>${escapeHtml(originalText)}</code>`,
    ``,
    `<b>Your instructions:</b>`,
    `1. Handle this task to the best of your ability.`,
    `2. Return a clear, concise result.`,
    `3. If you cannot complete it, explain why.`,
    ``,
    `Do NOT send this back to Telegram — just return your result to the orchestrator.`,
  ].join("\n");
}

/**
 * Broadcast a payload to all alive sessions for this bot.
 */
async function broadcastToSessions(
  payload: string,
  _botId: number,
): Promise<Array<{ session: string; ok: boolean; response?: string; error?: string }>> {
  const results: Array<{ session: string; ok: boolean; response?: string; error?: string }> = [];
  const relayDir = join(homedir(), ".pi", "agent", "tmp", "teleg-relay");

  if (!existsSync(relayDir)) return results;

  try {
    const files = readdirSync(relayDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const relayPath = join(relayDir, file);
        const info = JSON.parse(readFileSync(relayPath, "utf8")) as {
          sessionName: string;
          pid: number;
          port: number;
          secret: string;
        };
        // Check if PID is alive
        try {
          process.kill(info.pid, 0);
        } catch {
          continue; // dead session
        }

        const res = await forwardToSession(info.sessionName, payload, {
          chatId: 0,
          messageId: 0,
          sourceSession: "orchestrator",
        });
        results.push({ session: info.sessionName, ok: res.ok, response: res.response, error: res.error });
      } catch {
        // skip corrupted relay file
      }
    }
  } catch {
    // relay dir doesn't exist yet
  }

  return results;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
