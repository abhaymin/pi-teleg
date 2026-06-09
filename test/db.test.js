import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "teleg-db-test-"));
const dbPath = join(tempRoot, "teleg-bridge.db");

function bootstrapDb() {
  const bootstrap = new DatabaseSync(dbPath);
  bootstrap.exec("PRAGMA user_version = 2");
  bootstrap.close();
}

bootstrapDb();
process.env.TELEG_DB_PATH = dbPath;
const Db = await import("../dist/db.js");
function resetDb() {
  Db.closeDb();
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  bootstrapDb();
}

function seedRelaySession(d, row) {
  d.prepare(`
    INSERT INTO relay_sessions (
      bot_id, session_name, session_id, pid, port, secret,
      project_dir, capabilities, description, role, registered_at, last_heartbeat
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.bot_id,
    row.session_name,
    row.session_id,
    row.pid,
    row.port,
    row.secret,
    row.project_dir,
    row.capabilities,
    row.description,
    row.role,
    row.registered_at,
    row.last_heartbeat,
  );
}

after(() => {
  Db.closeDb();
  rmSync(tempRoot, { recursive: true, force: true });
});

test("relay session cleanup", async (t) => {
  await t.test("removes dead sessions and keeps live ones", () => {
    resetDb();
    const d = Db.getDb();
    const now = Date.now();

    seedRelaySession(d, {
      bot_id: 1,
      session_name: "alive-session",
      session_id: "alive-session-id",
      pid: process.pid,
      port: 9001,
      secret: "secret-1",
      project_dir: null,
      capabilities: null,
      description: null,
      role: "drain",
      registered_at: now,
      last_heartbeat: now,
    });
    seedRelaySession(d, {
      bot_id: 1,
      session_name: "dead-session",
      session_id: "dead-session-id",
      pid: 999999,
      port: 9002,
      secret: "secret-2",
      project_dir: null,
      capabilities: null,
      description: null,
      role: "drain",
      registered_at: now,
      last_heartbeat: now,
    });
    seedRelaySession(d, {
      bot_id: 2,
      session_name: "dead-session-2",
      session_id: "dead-session-id-2",
      pid: 999998,
      port: 9003,
      secret: "secret-3",
      project_dir: null,
      capabilities: null,
      description: null,
      role: "drain",
      registered_at: now,
      last_heartbeat: now,
    });

    const removed = Db.cleanStaleRelaySessions();
    assert.equal(removed, 2);
    assert.deepEqual(
      d.prepare("SELECT bot_id, session_name, pid FROM relay_sessions ORDER BY bot_id, session_name").all().map((row) => ({ ...row })),
      [{ bot_id: 1, session_name: "alive-session", pid: process.pid }],
    );
  });

  await t.test("scoped cleanup only removes rows for one bot", () => {
    resetDb();
    const d = Db.getDb();
    const now = Date.now();

    seedRelaySession(d, {
      bot_id: 1,
      session_name: "dead-scoped-session",
      session_id: "dead-scoped-session-id",
      pid: 999997,
      port: 9004,
      secret: "secret-4",
      project_dir: null,
      capabilities: null,
      description: null,
      role: "drain",
      registered_at: now,
      last_heartbeat: now,
    });
    seedRelaySession(d, {
      bot_id: 2,
      session_name: "live-other-bot",
      session_id: "live-other-bot-id",
      pid: process.pid,
      port: 9005,
      secret: "secret-5",
      project_dir: null,
      capabilities: null,
      description: null,
      role: "drain",
      registered_at: now,
      last_heartbeat: now,
    });

    const removed = Db.cleanStaleRelaySessions(1);
    assert.equal(removed, 1);
    assert.deepEqual(
      d.prepare("SELECT bot_id, session_name FROM relay_sessions ORDER BY bot_id, session_name").all().map((row) => ({ ...row })),
      [{ bot_id: 2, session_name: "live-other-bot" }],
    );
  });
});
