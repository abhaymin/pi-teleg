import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { getGlobalDispatcher } from "undici";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "teleg-app-tests-"));
const agentDir = join(tempHome, ".pi", "agent");
const relayDir = join(agentDir, "tmp", "teleg-relay");
const configFile = join(agentDir, "teleg-bridge.json");
const sessionRegistryFile = join(agentDir, "teleg-sessions.json");
const dbPath = join(agentDir, "teleg-bridge.db");

process.env.HOME = tempHome;
process.env.TELEG_DB_PATH = dbPath;
process.env.TELEG_LIVENESS_MS = "1000";

function bootstrapDb() {
  mkdirSync(agentDir, { recursive: true });
  const seed = new DatabaseSync(dbPath);
  seed.exec("PRAGMA user_version = 2");
  seed.close();
}

function resetState() {
  Relay.stopRelayServer();
  Db.closeDb();
  rmSync(tempHome, { recursive: true, force: true });
  mkdirSync(relayDir, { recursive: true });
  bootstrapDb();
  delete process.env.TELEG_BOT_TOKEN;
  delete process.env.TELEG_BOT_ID;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeRelayInfo(sessionName, info) {
  mkdirSync(relayDir, { recursive: true });
  const prefix = info.botId ? `${info.botId}-` : "";
  writeFileSync(join(relayDir, `${prefix}${sessionName}.json`), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

function mockTelegramGetMe(result) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, result }),
  });
  return () => {
    global.fetch = originalFetch;
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function startHttpServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address available");
  return { server, port: address.port };
}

function makeLocalFetch() {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
    return await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          method: options.method || "GET",
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          headers: options.headers,
          agent: false,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({
              ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
              status: res.statusCode || 0,
              json: async () => (data ? JSON.parse(data) : null),
              text: async () => data,
            });
          });
        },
      );
      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : Buffer.from(options.body));
      }
      req.end();
    });
  };
}

async function closeActiveServers() {
  const handles = process._getActiveHandles();
  for (const handle of handles) {
    if (handle && handle.constructor && handle.constructor.name === "Server") {
      await new Promise((resolve) => handle.close(() => resolve()));
    }
  }
}

bootstrapDb();

const Db = await import("../dist/db.js");
const Config = await import("../dist/config.js");
const SessionConfig = await import("../dist/session-config.js");
const Capabilities = await import("../dist/capabilities.js");
const Relay = await import("../dist/relay.js");
const SessionRegistry = await import("../dist/session-registry.js");
const PollingManager = await import("../dist/polling-manager.js");

after(async () => {
  Relay.stopRelayServer();
  try {
    await getGlobalDispatcher().close();
  } catch {
    // best effort
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  Db.closeDb();
  rmSync(tempHome, { recursive: true, force: true });
});

test("app coverage", async (t) => {
  await t.test("config resolution and CRUD", async () => {
    resetState();

    const projectEnvDir = join(tempHome, "project-env");
    mkdirSync(projectEnvDir, { recursive: true });
    const restoreEnvFetch = mockTelegramGetMe({ id: 12345, username: "envbot" });
    process.env.TELEG_BOT_TOKEN = "ENV_TOKEN";

    const envContext = await Config.resolveBotContext(projectEnvDir);
    assert.equal(envContext.botId, 12345);
    assert.equal(envContext.botToken, "ENV_TOKEN");
    assert.equal(envContext.botUsername, "envbot");
    assert.equal(envContext.dbPath, dbPath);
    assert.equal(envContext.projectDir, projectEnvDir);
    assert.equal(envContext.isLegacy, false);

    const globalCfg = Config.readGlobalConfigSync();
    assert.equal(globalCfg?.version, 2);
    assert.equal(globalCfg?.defaultBotId, 12345);
    assert.equal(globalCfg?.bots?.["12345"].botToken, "ENV_TOKEN");

    restoreEnvFetch();
    delete process.env.TELEG_BOT_TOKEN;

    const projectCfgDir = join(tempHome, "project-cfg");
    mkdirSync(join(projectCfgDir, ".pi"), { recursive: true });
    writeJson(join(projectCfgDir, ".pi", "teleg.json"), { botToken: "PROJECT_TOKEN", allowedUserIds: [7] });
    const restoreProjectFetch = mockTelegramGetMe({ id: 45678, username: "projectbot" });

    const projectContext = await Config.resolveBotContext(projectCfgDir);
    assert.equal(projectContext.botId, 45678);
    assert.equal(projectContext.botToken, "PROJECT_TOKEN");
    assert.equal(projectContext.botUsername, "projectbot");
    assert.deepEqual(projectContext.allowedUserIds, [7]);

    restoreProjectFetch();

    const legacyDir = join(tempHome, "project-legacy");
    mkdirSync(legacyDir, { recursive: true });
    writeJson(configFile, {
      botToken: "LEGACY_TOKEN",
      botUsername: "legacybot",
      botId: 99887,
      allowedUserIds: [1, 2],
      allowedChatIds: [9],
      lastUpdateId: 12,
    });
    const restoreLegacyFetch = mockTelegramGetMe({ id: 99887, username: "legacybot" });
    const legacyContext = await Config.resolveBotContext(legacyDir);
    assert.equal(legacyContext.botId, 99887);
    assert.equal(legacyContext.botToken, "LEGACY_TOKEN");
    assert.equal(legacyContext.botUsername, "legacybot");
    assert.equal(await waitFor(async () => (await Config.getConfigVersion()) === 2), true);
    restoreLegacyFetch();

    writeJson(configFile, {
      version: 2,
      defaultBotId: 1,
      bots: {
        "1": {
          botToken: "TOKEN-1",
          botUsername: "bot-one",
          botId: 1,
          allowedUserIds: [10],
          allowedChatIds: [20],
          lastUpdateId: 30,
        },
        "45678": {
          botToken: "TOKEN-2",
          botUsername: "projectbot",
          botId: 45678,
          allowedUserIds: [99],
          allowedChatIds: [98],
          lastUpdateId: 97,
        },
      },
    });
    const pinnedDir = join(tempHome, "project-pinned");
    const pinnedDbPath = join(tempHome, "project-pinned.db");
    mkdirSync(pinnedDir, { recursive: true });
    await Config.writeProjectConfig(pinnedDir, {
      botId: 45678,
      allowedUserIds: [7],
      dbPath: pinnedDbPath,
    });

    const pinnedContext = await Config.resolveBotContext(pinnedDir);
    assert.equal(pinnedContext.botId, 45678);
    assert.equal(pinnedContext.botUsername, "projectbot");
    assert.equal(pinnedContext.dbPath, pinnedDbPath);
    assert.deepEqual(pinnedContext.allowedUserIds, [7]);
    assert.equal(await Config.getDefaultBotId(), 1);
    assert.deepEqual(await Config.loadBotConfig(1), {
      botToken: "TOKEN-1",
      botUsername: "bot-one",
      botId: 1,
      allowedUserIds: [10],
      allowedChatIds: [20],
      lastUpdateId: 30,
    });

    await Config.saveLastUpdateId(1, 99);
    await Config.updateAllowedUsers(1, [88, 77]);

    const updatedGlobalCfg = Config.readGlobalConfigSync();
    assert.equal(updatedGlobalCfg?.bots?.["1"].lastUpdateId, 99);
    assert.deepEqual(updatedGlobalCfg?.bots?.["1"].allowedUserIds, [88, 77]);
    assert.deepEqual(await Config.listConfiguredBots(), [
      { botId: 1, botUsername: "bot-one", lastUpdateId: 99 },
      { botId: 45678, botUsername: "projectbot", lastUpdateId: 97 },
    ]);
    assert.equal(await Config.getConfigVersion(), 2);
    assert.equal(await Config.detectSplitDb(1, dbPath), null);
    assert.match((await Config.detectSplitDb(1, join(tempHome, "other.db"))) ?? "", /non-default DB path/);
    // resolveFromBotId: activate a registered bot by id without a token prompt
    const resolvedBot = await Config.resolveFromBotId(45678, pinnedDir);
    assert.equal(resolvedBot.botId, 45678);
    assert.equal(resolvedBot.botUsername, "projectbot");
    assert.equal(resolvedBot.botToken, "TOKEN-2");
    assert.equal(await Config.resolveFromBotId(999999, pinnedDir), null); // unregistered

    // setDefaultBotId: change the global default used by un-pinned projects
    await Config.setDefaultBotId(45678);
    assert.equal(await Config.getDefaultBotId(), 45678);
    await Config.setDefaultBotId(1); // restore for any later assertions
  });

  await t.test("session config and registry helpers", async () => {
    resetState();

    writeJson(configFile, {
      version: 2,
      defaultBotId: 12,
      archiveRoot: "/tmp/archive-root",
      bots: {
        "12": {
          botToken: "TOKEN-12",
          botUsername: "bot-twelve",
          botId: 12,
          allowedUserIds: [11],
          allowedChatIds: [22],
          lastUpdateId: 33,
        },
      },
    });

    assert.deepEqual(await SessionConfig.readConfig(), {
      botToken: "TOKEN-12",
      botUsername: "bot-twelve",
      botId: 12,
      allowedUserIds: [11],
      allowedChatIds: [22],
      lastUpdateId: 33,
      archiveRoot: "/tmp/archive-root",
    });

    await SessionConfig.writeConfig({
      botToken: "TOKEN-13",
      botUsername: "bot-thirteen",
      botId: 13,
      allowedUserIds: [44],
      allowedChatIds: [55],
      lastUpdateId: 66,
      archiveRoot: "/tmp/new-archive-root",
    });

    const writtenConfig = readJson(configFile);
    assert.equal(writtenConfig.defaultBotId, 13);
    assert.equal(writtenConfig.bots["13"].botToken, "TOKEN-13");

    writeJson(configFile, {
      botToken: "LEGACY-ROOT",
      allowedUserId: 91,
      allowedChatIds: [92],
      lastUpdateId: 93,
    });

    const legacyRead = await SessionConfig.readConfig();
    assert.deepEqual(legacyRead.allowedUserIds, [91]);
    assert.deepEqual(legacyRead.allowedChatIds, [92]);
    assert.equal(legacyRead.lastUpdateId, 93);

    const sessionId1 = SessionConfig.getSessionId();
    const sessionId2 = SessionConfig.getSessionId();
    assert.equal(sessionId1, sessionId2);
    assert.ok(sessionId1.length > 8);

    assert.equal(SessionConfig.isAllowedUser({ allowedUserIds: [1, 2] }, 2), true);
    assert.equal(SessionConfig.isAllowedUser({ allowedUserIds: [] }, 2), false);
    assert.equal(SessionConfig.isAllowedChat({ allowedChatIds: [9] }, 9), true);
    assert.equal(SessionConfig.isAllowedChat({}, 9), false);
    assert.equal(SessionConfig.getArchiveRoot({}), join(tempHome, "pi-teleg-archive"));
    assert.equal(SessionConfig.getArchiveRoot({ archiveRoot: "/custom/archive" }), "/custom/archive");

    const registry = {
      version: 2,
      sessions: [
        {
          sessionId: "session-1",
          sessionName: "alpha",
          pid: process.pid,
          connectedAt: 1,
          lastActivity: 2,
          isActive: true,
          announcedPresence: true,
          botToken: "TOKEN-1",
          projectDir: "/project/alpha",
          capabilities: ["relay"],
          description: "Relay worker",
          botId: 12,
        },
      ],
      primarySessionId: "session-1",
      primaryByBot: { "12": "alpha" },
    };

    await SessionConfig.writeSessionRegistry(registry);
    assert.deepEqual(await SessionConfig.readSessionRegistry(), registry);
    rmSync(sessionRegistryFile, { force: true });
    assert.deepEqual(await SessionConfig.readSessionRegistry(), { version: 2, sessions: [], primaryByBot: {} });
  });

  await t.test("capabilities detection and registry", async () => {
    resetState();

    const projectA = join(tempHome, "cap-proj-a");
    mkdirSync(projectA, { recursive: true });
    writeFileSync(
      join(projectA, "INFO_REL.md"),
      "## capabilities\nrelay, twitter, download\n\n## description\nRelay and media worker\n",
      "utf8",
    );

    assert.deepEqual(Capabilities.detectProjectCapabilities(projectA), {
      capabilities: ["relay", "twitter", "download"],
      description: "Relay and media worker",
    });

    await Capabilities.registerSessionCapabilities("session-a", "alpha", process.pid, projectA);
    let registry = await Capabilities.readCapabilitiesRegistry();
    assert.equal(registry.entries.length, 1);
    assert.equal(registry.entries[0].sessionName, "alpha");

    await Capabilities.unregisterSessionCapabilities("session-a");
    registry = await Capabilities.readCapabilitiesRegistry();
    assert.equal(registry.entries.length, 0);

    const projectB = join(tempHome, "cap-proj-b");
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(projectB, "README.md"), "# title\n\nVideo downloader worker\n", "utf8");
    assert.deepEqual(Capabilities.detectProjectCapabilities(projectB), {
      capabilities: ["cap-proj-b"],
      description: "Video downloader worker",
    });

    const aliveEntry = {
      sessionName: "alive",
      sessionId: "alive-id",
      pid: process.pid,
      projectDir: projectA,
      capabilities: ["youtube"],
      description: "YouTube downloader",
      registeredAt: 1,
    };
    const deadEntry = {
      sessionName: "dead",
      sessionId: "dead-id",
      pid: 999999,
      projectDir: projectB,
      capabilities: ["twitter"],
      description: "Twitter downloader",
      registeredAt: 1,
    };
    await Capabilities.writeCapabilitiesRegistry({ entries: [aliveEntry, deadEntry], lastUpdated: 1 });
    await Capabilities.cleanStaleCapabilities();
    registry = await Capabilities.readCapabilitiesRegistry();
    assert.deepEqual(registry.entries.map((entry) => entry.sessionId), ["alive-id"]);

    const twitterEntry = Capabilities.matchMessageToCapability(
      "check this https://x.com/example/status/12345",
      [
        { ...aliveEntry, capabilities: ["tweet media"], description: "Twitter video worker" },
        { ...deadEntry, pid: process.pid, capabilities: ["reddit download"], description: "Reddit worker" },
      ],
    );
    assert.equal(twitterEntry?.sessionId, "alive-id");

    const genericEntry = Capabilities.matchMessageToCapability(
      "need a quick alpha fix",
      [
        { ...aliveEntry, capabilities: ["something else"], description: "alpha fix worker" },
        { ...deadEntry, pid: process.pid, capabilities: ["something else"], description: "beta worker" },
      ],
    );
    assert.equal(genericEntry?.sessionId, "alive-id");
  });

  await t.test("database queue and recovery operations", async () => {
    resetState();
    const d = Db.getDb();
    const now = Date.now();

    const unassigned = Db.enqueueMessage({
      bot_id: 1,
      chat_id: 100,
      message_id: 1,
      from_user_id: 11,
      text: "unassigned message",
    });
    const sessionSpecific = Db.enqueueMessage({
      bot_id: 1,
      chat_id: 100,
      message_id: 2,
      from_user_id: 11,
      text: "session-specific",
      session_id: "__session__:alpha",
      session_name: "alpha",
    });
    Db.enqueueMessage({
      bot_id: 2,
      chat_id: 200,
      message_id: 3,
      from_user_id: 22,
      text: "other bot",
    });

    assert.equal(Db.getQueueDepth(1), 2);
    assert.equal(Db.getQueueStats(1).pending, 2);
    assert.equal(Db.getQueueStats(2).pending, 1);

    const claim = Db.claimNextMessage(1, "session-alpha-id", "alpha");
    assert.equal(claim?.id, unassigned);
    assert.equal(claim?.session_name, "alpha");
    assert.equal(Db.getSessionProcessingChat(1, 100), "alpha");
    assert.equal(Db.getPendingCountForSession(1, "alpha"), 1);
    assert.deepEqual(
      d.prepare("SELECT id FROM message_queue WHERE session_id = ? AND status = 'processing'").all("session-alpha-id").map((row) => row.id),
      [unassigned],
    );

    Db.completeMessage(unassigned, "done");
    Db.failMessage(sessionSpecific, "failed");

    const firstRow = d.prepare("SELECT status, response FROM message_queue WHERE id = ?").get(unassigned);
    const secondRow = d.prepare("SELECT status, error FROM message_queue WHERE id = ?").get(sessionSpecific);
    assert.equal(firstRow.status, "completed");
    assert.equal(firstRow.response, "done");
    assert.equal(secondRow.status, "failed");
    assert.equal(secondRow.error, "failed");

    const beta = Db.enqueueMessage({
      bot_id: 1,
      chat_id: 101,
      message_id: 4,
      from_user_id: 11,
      text: "beta",
      session_name: "beta",
    });
    Db.markMessageProcessing(beta, "beta-id", "beta");
    assert.equal(Db.resetProcessingForSession(1, "beta"), 1);
    assert.equal(Db.getQueueStatsForSession(1, "beta").pending, 0);

    const stale = Db.enqueueMessage({
      bot_id: 1,
      chat_id: 102,
      message_id: 5,
      from_user_id: 11,
      text: "stale",
      session_name: "gamma",
    });
    Db.markMessageProcessing(stale, "gamma-id", "gamma");
    d.prepare("UPDATE message_queue SET started_at = ? WHERE id = ?").run(now - 120000, stale);
    assert.equal(Db.recoverStaleMessages(60000, 1), 1);
    const staleRow = d.prepare("SELECT status, session_name, session_id FROM message_queue WHERE id = ?").get(stale);
    assert.equal(staleRow.status, "pending");
    assert.equal(staleRow.session_name, "unknown");
    assert.equal(staleRow.session_id, "unassigned");

    assert.equal(Db.getQueueStatsForSession(1, "alpha").completed, 1);
    assert.equal(Db.getQueueStatsForSession(1, "beta").pending, 0);
    assert.equal(Db.getQueueStats(2).pending, 1);
  });

  await t.test("v4 migration adds attachments + poll_id to an existing v3 message_queue", async () => {
    resetState();
    // Simulate a pre-v4 DB: create message_queue WITHOUT the new columns,
    // stamp user_version=3, then re-open so the migration runs.
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id INTEGER NOT NULL DEFAULT 0,
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        reply_to_message_id INTEGER,
        from_user_id INTEGER NOT NULL,
        from_username TEXT,
        text TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT 'unassigned',
        session_name TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'pending',
        source TEXT NOT NULL DEFAULT 'telegram',
        source_session TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        response TEXT
      );
    `);
    seed.exec(`INSERT INTO message_queue (bot_id, chat_id, message_id, from_user_id, text) VALUES (1, 1, 1, 5, 'pre-v4 row')`);
    seed.exec(`PRAGMA user_version = 3`);
    seed.close();
    Db.closeDb();

    const d = Db.getDb(); // migrateToV4 → ALTER TABLE ADD COLUMN attachments, poll_id
    const cols = d.prepare("PRAGMA table_info(message_queue)").all().map((c) => c.name);
    assert.ok(cols.includes("attachments"), "attachments column added by v4 migration");
    assert.ok(cols.includes("poll_id"), "poll_id column added by v4 migration");

    // Existing rows survive and the new columns are nullable.
    const row = d.prepare("SELECT text, attachments, poll_id FROM message_queue WHERE message_id = 1").get();
    assert.equal(row.text, "pre-v4 row");
    assert.equal(row.attachments, null);
    assert.equal(row.poll_id, null);
    assert.equal(d.prepare("PRAGMA user_version").get().user_version, 4);
  });

  await t.test("attachments and poll_id persist and resolve (media + poll capture)", async () => {
    resetState();
    const d = Db.getDb();

    // A poll-bearing message: poll_id links later poll_answer updates to this chat.
    const pollText = "📊 Poll: Tea or coffee?\n  1. Tea\n  2. Coffee";
    const pollId = Db.enqueueMessage({
      bot_id: 7, chat_id: 300, message_id: 50, from_user_id: 99,
      text: pollText, poll_id: "poll-abc",
    });

    // A media-bearing message: attachments is the JSON array the poll worker writes
    // (local file paths downloaded via getFile).
    const media = JSON.stringify([
      { path: "/tmp/teleg-media/7/photo-x.jpg", fileName: "photo.jpg", type: "image" },
      { path: "/tmp/teleg-media/7/doc-y.pdf", fileName: "report.pdf", type: "document" },
    ]);
    const mediaId = Db.enqueueMessage({
      bot_id: 7, chat_id: 300, message_id: 51, from_user_id: 99,
      text: "here is the photo", attachments: media,
    });

    // Columns persist verbatim.
    assert.equal(d.prepare("SELECT poll_id, attachments FROM message_queue WHERE id = ?").get(pollId).poll_id, "poll-abc");
    assert.equal(d.prepare("SELECT attachments FROM message_queue WHERE id = ?").get(pollId).attachments, null);
    const mediaRow = d.prepare("SELECT poll_id, attachments FROM message_queue WHERE id = ?").get(mediaId);
    assert.equal(mediaRow.poll_id, null);
    assert.deepEqual(JSON.parse(mediaRow.attachments), JSON.parse(media));

    // claimNextMessage surfaces the new fields on the returned row (draining
    // sessions read attachments from here to populate incomingAttachments).
    const first = Db.claimNextMessage(7, "session-7", "worker-7");
    const second = Db.claimNextMessage(7, "session-7", "worker-7");
    for (const row of [first, second]) {
      assert.ok(row, "claimed row present");
      assert.ok(Object.prototype.hasOwnProperty.call(row, "attachments"), "claimed row carries attachments");
      assert.ok(Object.prototype.hasOwnProperty.call(row, "poll_id"), "claimed row carries poll_id");
    }
    assert.equal([first, second].find((r) => r.message_id === 50).poll_id, "poll-abc");
    assert.deepEqual(JSON.parse([first, second].find((r) => r.message_id === 51).attachments), JSON.parse(media));

    // poll_answer resolution mirrors index.ts onPollAnswer: link a vote back to
    // its chat via poll_id, bot-scoped (a poll_id on another bot must not leak).
    const lookup = d.prepare("SELECT chat_id, message_id, text FROM message_queue WHERE bot_id = ? AND poll_id = ? ORDER BY id DESC LIMIT 1").get(7, "poll-abc");
    assert.equal(lookup.chat_id, 300);
    assert.equal(lookup.message_id, 50);
    assert.equal(lookup.text, pollText);
    assert.equal(d.prepare("SELECT chat_id FROM message_queue WHERE bot_id = ? AND poll_id = ?").get(8, "poll-abc"), undefined);
  });

  await t.test("fallback claim for silent sessions is bot-scoped and linked-only", async () => {
    resetState();
    const d = Db.getDb();

    // Bot 1: a message queued for a silent session "ghost", a message for an
    // alive session "alpha", and an unassigned message. Bot 2 holds a ghost
    // message that must never be claimed across bots.
    const ghostMsg = Db.enqueueMessage({
      bot_id: 1, chat_id: 100, message_id: 10, from_user_id: 11,
      text: "ghost message", session_id: "__session__:ghost", session_name: "ghost",
    });
    const aliveMsg = Db.enqueueMessage({
      bot_id: 1, chat_id: 100, message_id: 11, from_user_id: 11,
      text: "alive message", session_id: "__session__:alpha", session_name: "alpha",
    });
    const unassignedMsg = Db.enqueueMessage({
      bot_id: 1, chat_id: 100, message_id: 12, from_user_id: 11,
      text: "unassigned message",
    });
    const otherBotMsg = Db.enqueueMessage({
      bot_id: 2, chat_id: 100, message_id: 13, from_user_id: 11,
      text: "other bot ghost", session_id: "__session__:ghost", session_name: "ghost",
    });

    // "rescuer" and "alpha" are alive/linked; "ghost" is silent.
    const aliveNames = ["rescuer", "alpha"];

    // rescuer (linked) claims ghost's orphaned message.
    const claimed = Db.claimNextMessageForSilentSession(1, "__session__:rescuer", "rescuer", aliveNames);
    assert.equal(claimed?.id, ghostMsg);
    assert.equal(claimed?.session_name, "rescuer");
    assert.equal(claimed?.status, "processing");
    assert.equal(Db.getSessionProcessingChat(1, 100), "rescuer");

    // The alive session's own message is NOT stolen (it drains its own queue).
    const aliveRow = d.prepare("SELECT status, session_name FROM message_queue WHERE id = ?").get(aliveMsg);
    assert.equal(aliveRow.status, "pending");
    assert.equal(aliveRow.session_name, "alpha");

    // Unassigned messages flow through a different path and are left alone here.
    const unassignedRow = d.prepare("SELECT status FROM message_queue WHERE id = ?").get(unassignedMsg);
    assert.equal(unassignedRow.status, "pending");

    // Cross-bot message is untouched (queue is bot-scoped).
    const otherRow = d.prepare("SELECT status FROM message_queue WHERE id = ?").get(otherBotMsg);
    assert.equal(otherRow.status, "pending");

    // Nothing left to rescue for rescuer (alive + unassigned excluded).
    const second = Db.claimNextMessageForSilentSession(1, "__session__:rescuer", "rescuer", aliveNames);
    assert.equal(second, null);
  });

  await t.test("relay session operations and startup recovery", async () => {
    resetState();
    const d = Db.getDb();
    const now = Date.now();

    Db.registerRelaySession({
      bot_id: 1,
      session_name: "alive",
      session_id: "alive-id",
      pid: process.pid,
      port: 9000,
      secret: "secret-alive",
      role: "active",
    });
    Db.registerRelaySession({
      bot_id: 1,
      session_name: "dead",
      session_id: "dead-id",
      pid: 999999,
      port: 9001,
      secret: "secret-dead",
      role: "drain",
    });
    Db.registerRelaySession({
      bot_id: 1,
      session_name: "orphan",
      session_id: "orphan-id",
      pid: process.pid,
      port: 9002,
      secret: "secret-orphan",
      role: "drain",
    });

    Db.setPrimary(1, "alive");
    assert.equal(Db.getPrimarySession(1)?.session_name, "alive");
    assert.equal(Db.getRelaySession(1, "alive")?.session_id, "alive-id");
    const orphanSession = Db.getRelaySession(1, "orphan");
    assert.equal((await SessionRegistry.checkSessionLiveness(orphanSession)).liveness, SessionRegistry.SessionLiveness.STALE);

    const processing = Db.enqueueMessage({
      bot_id: 1,
      chat_id: 77,
      message_id: 10,
      from_user_id: 11,
      text: "processing",
      session_name: "alive",
      session_id: "alive-id",
    });
    Db.markMessageProcessing(processing, "alive-id", "alive");
    d.prepare("UPDATE message_queue SET started_at = ? WHERE id = ?").run(now - 120000, processing);

    const recovery = Db.runStartupRecovery(1);
    assert.equal(recovery.cleanedSessions, 1);
    assert.equal(recovery.recoveredMessages, 1);
    assert.equal(Db.getRelaySession(1, "dead"), undefined);
    assert.equal(Db.getRelaySession(1, "orphan")?.session_id, "orphan-id");
    assert.equal(Db.getPrimarySession(1)?.session_name, "alive");
    assert.equal(Db.getSessionProcessingChat(1, 77), null);
    const recoveredRow = d.prepare("SELECT status, session_name, session_id FROM message_queue WHERE id = ?").get(processing);
    assert.equal(recoveredRow.status, "pending");
    assert.equal(recoveredRow.session_name, "unknown");
    assert.equal(recoveredRow.session_id, "unassigned");
  });

  await t.test("relay cleanup, status, and HTTP lifecycle", async () => {
    resetState();
    const restoreFetch = global.fetch;
    global.fetch = makeLocalFetch();
    try {

    writeRelayInfo("alive", { pid: process.pid, port: 1111, secret: "secret-alive", sessionName: "alive", botId: 1 });
    writeRelayInfo("dead", { pid: 999999, port: 1112, secret: "secret-dead", sessionName: "dead", botId: 1 });
    writeFileSync(join(relayDir, "bad.json"), "{not json", "utf8");

    Relay.cleanStaleRelayFiles();
    assert.equal(existsSync(join(relayDir, "1-alive.json")), true);
    assert.equal(existsSync(join(relayDir, "1-dead.json")), false);
    assert.equal(existsSync(join(relayDir, "bad.json")), false);
    assert.deepEqual(Array.from(Relay.getAliveSessionNames()), ["alive"]);

    Relay.cleanRelayFilesByPid(process.pid);
    assert.equal(existsSync(join(relayDir, "1-alive.json")), false);
    assert.deepEqual(await Relay.getRelayStatus(), {});

    const blocker = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("busy");
    });
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(9940, "127.0.0.1", () => resolve());
    });

    const info = await Relay.startRelayServer("relay-main", 9940, 1);
    assert.notEqual(info.port, 9940);
    const relayInfo = readJson(join(relayDir, "1-relay-main.json"));
    assert.equal(relayInfo.port, info.port);

    const health = await fetch(`http://127.0.0.1:${info.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const noHandler = await fetch(`http://127.0.0.1:${info.port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: 1, messageId: 2, text: "hello", secret: info.secret }),
    });
    assert.equal(noHandler.status, 404);

    const options = await fetch(`http://127.0.0.1:${info.port}/anything`, { method: "OPTIONS" });
    assert.equal(options.status, 204);

    const wrongSecret = await fetch(`http://127.0.0.1:${info.port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: 1, messageId: 2, text: "hello", secret: "wrong" }),
    });
    assert.equal(wrongSecret.status, 401);

    let commandMeta = null;
    Relay.setCommandHandler(async (text, meta) => {
      commandMeta = meta;
      return `handled:${text}`;
    });
    const command = await fetch(`http://127.0.0.1:${info.port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: 9, messageId: 10, text: "ping", secret: info.secret, sourceSession: "source-a" }),
    });
    assert.equal(command.status, 200);
    assert.deepEqual(await command.json(), { ok: true, response: "handled:ping" });
    assert.deepEqual(commandMeta, { chatId: 9, messageId: 10, sourceSession: "source-a" });

    const completeNoHandler = await fetch(`http://127.0.0.1:${info.port}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 7, sourceSession: "source-a", secret: info.secret }),
    });
    assert.equal(completeNoHandler.status, 404);

    let completed = null;
    Relay.setCompleteHandler((id, sourceSession) => {
      completed = { id, sourceSession };
    });
    const complete = await fetch(`http://127.0.0.1:${info.port}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 7, sourceSession: "source-a", secret: info.secret }),
    });
    assert.equal(complete.status, 200);
    assert.deepEqual(await complete.json(), { ok: true });
    assert.deepEqual(completed, { id: 7, sourceSession: "source-a" });

    const shutdownNoHandler = await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: info.secret }),
    });
    assert.equal(shutdownNoHandler.status, 404);

    let shutdownCalled = false;
    Relay.setShutdownHandler(() => {
      shutdownCalled = true;
    });
    const shutdown = await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: info.secret }),
    });
    assert.equal(shutdown.status, 200);
    assert.deepEqual(await shutdown.json(), { ok: true, sessionName: "relay-main" });
    assert.equal(shutdownCalled, true);

    const unknown = await fetch(`http://127.0.0.1:${info.port}/nope`);
    assert.equal(unknown.status, 404);

    Relay.stopRelayServer();
    await new Promise((resolve) => blocker.close(() => resolve()));
    await closeActiveServers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      global.fetch = restoreFetch;
    }
  });

  await t.test("relay client helpers", async () => {
    resetState();
    const restoreFetch = global.fetch;
    global.fetch = makeLocalFetch();
    try {

    const captured = {};
    const { server, port } = await startHttpServer((req, res) => {
      if (req.url === "/command" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk.toString()));
        req.on("end", () => {
          captured.command = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, response: "forwarded" }));
        });
        return;
      }
      if (req.url === "/complete" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk.toString()));
        req.on("end", () => {
          captured.complete = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    writeRelayInfo("target", { pid: process.pid, port, secret: "secret-target", sessionName: "target", botId: 1 });
    const forwarded = await Relay.forwardToSession("target", "hello", { chatId: 33, messageId: 44, sourceSession: "source" });
    assert.equal(forwarded.ok, true);
    assert.equal(forwarded.response, "forwarded");
    assert.deepEqual(captured.command, {
      chatId: 33,
      messageId: 44,
      text: "hello",
      secret: "secret-target",
      sourceSession: "source",
    });
    assert.equal(await Relay.completeMessageOnSource("target", 55, "secret-target"), true);
    assert.deepEqual(captured.complete, { id: 55, sourceSession: "target", secret: "secret-target" });

    writeRelayInfo("stale", { pid: 999999, port, secret: "secret-stale", sessionName: "stale", botId: 1 });
    const stale = await Relay.forwardToSession("stale", "hello", { chatId: 1, messageId: 2 });
    assert.match(stale.error ?? "", /stale relay/);

    assert.equal((await Relay.getRelayStatus()).target.alive, true);
    await new Promise((resolve) => server.close(() => resolve()));
    await closeActiveServers();
    } finally {
      global.fetch = restoreFetch;
    }
  });

  await t.test("session registry liveness and reconciliation", async () => {
    resetState();
    const restoreFetch = global.fetch;
    global.fetch = makeLocalFetch();
    try {
    const info = await Relay.startRelayServer("primary", 9990, 5);

    writeRelayInfo("stale", { pid: process.pid, port: info.port, secret: info.secret, sessionName: "stale", botId: 5 });
    writeRelayInfo("ghost", { pid: 999999, port: info.port, secret: info.secret, sessionName: "ghost", botId: 5 });

    Db.registerRelaySession({
      bot_id: 5,
      session_name: "primary",
      session_id: "primary-id",
      pid: process.pid,
      port: info.port,
      secret: info.secret,
      role: "active",
    });
    Db.registerRelaySession({
      bot_id: 5,
      session_name: "stale",
      session_id: "stale-id",
      pid: process.pid,
      port: info.port,
      secret: info.secret,
      role: "drain",
    });
    Db.registerRelaySession({
      bot_id: 5,
      session_name: "ghost",
      session_id: "ghost-id",
      pid: 999999,
      port: info.port,
      secret: info.secret,
      role: "drain",
    });

    Db.getDb().prepare("UPDATE relay_sessions SET last_heartbeat = ? WHERE bot_id = ? AND session_name = ?").run(Date.now() - 120000, 5, "stale");
    Db.getDb().prepare("UPDATE relay_sessions SET last_heartbeat = ? WHERE bot_id = ? AND session_name = ?").run(Date.now(), 5, "primary");
    Db.setPrimary(5, "primary");

    const liveSession = Db.getRelaySession(5, "primary");
    const staleSession = Db.getRelaySession(5, "stale");
    const ghostSession = Db.getRelaySession(5, "ghost");
    assert.equal((await SessionRegistry.checkSessionLiveness(liveSession)).liveness, SessionRegistry.SessionLiveness.LINKED);
    assert.equal((await SessionRegistry.checkSessionLiveness(staleSession)).liveness, SessionRegistry.SessionLiveness.STALE);
    assert.equal((await SessionRegistry.checkSessionLiveness(ghostSession)).liveness, SessionRegistry.SessionLiveness.GHOST);

    const pending = Db.enqueueMessage({
      bot_id: 5,
      chat_id: 77,
      message_id: 1,
      from_user_id: 1,
      text: "stale message",
      session_name: "stale",
    });
    Db.assignMessageToSession(pending, "stale");
    assert.ok(Db.claimNextMessageForSession(5, "stale"));
    assert.equal(Db.getSessionProcessingChat(5, 77), "stale");

    assert.deepEqual((await SessionRegistry.getLinkedSessions(5)).map((session) => session.session_name), ["primary"]);
    assert.equal(await SessionRegistry.isSessionLinked(5, "primary"), true);
    assert.equal(await SessionRegistry.isSessionLinked(5, "ghost"), false);
    assert.deepEqual(await SessionRegistry.getSessionLivenessSummary(5), { linked: ["primary"], stale: ["stale"], ghost: ["ghost"] });

    const report = await SessionRegistry.reconcileSessions(5);
    assert.equal(report.checkedSessions, 3);
    assert.equal(report.evictedSessions.includes("ghost"), true);
    assert.equal(report.newPrimary, "primary");
    assert.equal(Db.getRelaySession(5, "ghost"), undefined);
    assert.equal(Db.getPrimarySession(5)?.session_name, "primary");
    assert.equal(Db.getSessionProcessingChat(5, 77), null);
    assert.equal(Db.getDb().prepare("SELECT status FROM message_queue WHERE id = ?").get(pending).status, "pending");

    Relay.stopRelayServer();
    await closeActiveServers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      global.fetch = restoreFetch;
    }
  });

  await t.test("polling manager state and queue handling", async () => {
    resetState();

    const manager = PollingManager.getPollingManager(71);
    assert.strictEqual(PollingManager.getPollingManager(71), manager);
    assert.notStrictEqual(PollingManager.getPollingManager(72), manager);

    manager.setConfig("TOKEN-71", 3);
    manager.setBotInfo({ username: "bot71", displayName: "Bot 71" });
    assert.deepEqual(manager.getConfig(), { botToken: "TOKEN-71", lastUpdateId: 3 });
    assert.deepEqual(manager.getBotInfo(), { botId: 71, username: "bot71", displayName: "Bot 71" });
    assert.equal(manager.isActive(), false);

    const otherManager = PollingManager.getPollingManager(72);
    otherManager.setConfig("", 0);
    assert.equal(await otherManager.start("session-72", dbPath), false);

    const unassigned = Db.enqueueMessage({
      bot_id: 71,
      chat_id: 100,
      message_id: 1,
      from_user_id: 10,
      text: "unassigned",
    });
    const sessionSpecific = Db.enqueueMessage({
      bot_id: 71,
      chat_id: 100,
      message_id: 2,
      from_user_id: 10,
      text: "session specific",
      session_id: "__session__:alpha",
      session_name: "alpha",
    });

    assert.equal(manager.getQueueDepth(), 2);
    const claim = manager.claimNextTurn("session-71", "alpha");
    assert.ok(claim);
    assert.equal(claim.dbId, unassigned);
    assert.equal(claim.turn.sessionName, "alpha");
    assert.equal(manager.hasActiveTurnFor("session-71"), true);
    assert.equal(manager.hasActiveTurnInDb("session-71"), true);
    assert.deepEqual(manager.getProcessingMessageIds("session-71"), [unassigned]);
    assert.equal(manager.getSessionProcessingChat(100), "session-71");
    manager.completeTurn("session-71", claim.dbId);
    assert.equal(manager.hasActiveTurnFor("session-71"), false);

    const strict = manager.claimNextTurnForSession("alpha");
    assert.ok(strict);
    assert.equal(strict.dbId, sessionSpecific);
    manager.completeTurn(strict.turn.sessionId, strict.dbId);

    assert.equal(manager.getPendingCountForSession("alpha"), 0);
    assert.equal(manager.getQueueDepth(), 0);
    assert.equal(Db.getQueueStats(71).completed, 2);
  });

  await t.test("polling manager fallback claim for a silent session", async () => {
    resetState();
    const manager = PollingManager.getPollingManager(71);
    manager.setConfig("TOKEN-71", 3);

    // A message queued for a silent session "ghost" on bot 71, plus a message
    // for an alive session "alpha" that must not be stolen.
    const ghostMsg = Db.enqueueMessage({
      bot_id: 71, chat_id: 100, message_id: 21, from_user_id: 10,
      text: "ghost message", session_id: "__session__:ghost", session_name: "ghost",
    });
    Db.enqueueMessage({
      bot_id: 71, chat_id: 100, message_id: 22, from_user_id: 10,
      text: "alive message", session_id: "__session__:alpha", session_name: "alpha",
    });

    // "rescuer" is linked/alive; "ghost" is silent. The alive set excludes the
    // rescuer's own messages (drained separately) and alpha's (self-draining).
    const claim = manager.claimNextTurnForSilentSession("rescuer", ["rescuer", "alpha"]);
    assert.ok(claim);
    assert.equal(claim.dbId, ghostMsg);
    assert.equal(claim.turn.sessionName, "rescuer");
    assert.equal(manager.hasActiveTurnFor("__session__:rescuer"), true);
    assert.equal(manager.getPendingCountForSession("alpha"), 1);
    manager.completeTurn(claim.turn.sessionId, claim.dbId);

    // alpha's message is still pending for alpha to drain itself.
    assert.equal(Db.getQueueStats(71).pending, 1);
  });
});
