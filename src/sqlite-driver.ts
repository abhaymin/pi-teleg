/**
 * Runtime-agnostic SQLite driver.
 *
 * omp (Oh My Pi) loads extensions under Bun, which has no `node:sqlite`; Pi runs
 * under Node, which has it. Both runtimes expose a compatible statement surface
 * (exec / prepare / get / all / run / close), so resolve the right builtin once
 * at module load and re-export a single constructor. The rest of the codebase
 * imports `openSqlite` instead of `node:sqlite` directly and stays runtime-neutral.
 *
 * Types come from `node:sqlite` (erased at compile time, so Bun never sees them);
 * the runtime object under Bun is a structurally-compatible `bun:sqlite` Database.
 */

import "./suppress-sqlite-warning.js";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
export { suppressNodeSqliteExperimentalWarning } from "./suppress-sqlite-warning.js";

const require = createRequire(import.meta.url);
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

type DatabaseSyncCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => DatabaseSync;

function resolveDriver(): DatabaseSyncCtor {
  if (isBun) {
    // Named const (not an inline member access): the require result is `any`,
    // so we assert the shape once and read from the binding.
    const mod = require("bun:sqlite") as { Database: DatabaseSyncCtor };
    return mod.Database;
  }
  const mod = require("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };
  return mod.DatabaseSync;
}

export const openSqlite = resolveDriver();
