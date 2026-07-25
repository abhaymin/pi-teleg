/**
 * Filter Node's `ExperimentalWarning: SQLite is an experimental feature…`
 * before any code loads `node:sqlite`. Pi captures process warnings into the
 * content console — without this filter, teleg's first DB open looks like a
 * pi-lens / UI error dump.
 *
 * Import this module first (before `node:sqlite` / `openSqlite`) in every
 * entrypoint. Safe to call repeatedly.
 *
 * Dual defense:
 * 1. Monkey-patch `process.emitWarning` (catches warnings when we load first).
 * 2. Replace the default `warning` listener (catches warnings already queued
 *    when `node:sqlite` raced in parallel with this module — Node may emit
 *    before our emitWarning patch is installed).
 */

let installed = false;

function isNodeSqliteExperimentalWarning(
  warning: string | Error,
  args: unknown[],
): boolean {
  const msg = typeof warning === "string" ? warning : (warning?.message ?? "");
  const name =
    typeof warning === "object" && warning && "name" in warning
      ? String((warning as Error).name)
      : "";
  const typeArg = typeof args[0] === "string" ? args[0] : "";
  const typeObj =
    typeof args[0] === "object" && args[0] !== null
      ? String((args[0] as { type?: string }).type ?? "")
      : "";
  const isExperimental =
    name === "ExperimentalWarning" ||
    typeArg === "ExperimentalWarning" ||
    typeObj === "ExperimentalWarning";
  if (isExperimental && /sqlite/i.test(msg)) return true;
  if (/SQLite is an experimental feature/i.test(msg)) return true;
  return false;
}

function isWarningEventSqliteExperimental(warning: Error): boolean {
  const msg = String(warning?.message ?? "");
  if (warning?.name === "ExperimentalWarning" && /sqlite/i.test(msg)) return true;
  if (/SQLite is an experimental feature/i.test(msg)) return true;
  return false;
}

export function suppressNodeSqliteExperimentalWarning(): void {
  if (installed) return;
  installed = true;
  if (typeof process === "undefined" || typeof process.emitWarning !== "function") return;

  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    if (isNodeSqliteExperimentalWarning(warning, args)) return;
    return (original as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;

  // Race cover: if node:sqlite already called the unpatched emitWarning, the
  // default onWarning listener may still print on a later tick. Filter there.
  if (typeof process.listeners === "function" && typeof process.on === "function") {
    const prior = process.listeners("warning").slice() as Array<(w: Error) => void>;
    process.removeAllListeners("warning");
    process.on("warning", (warning: Error) => {
      if (isWarningEventSqliteExperimental(warning)) return;
      for (const listener of prior) listener.call(process, warning);
    });
  }
}

suppressNodeSqliteExperimentalWarning();
