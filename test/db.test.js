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
  writeFileSync(join(relayDir, `${sessionName}.json`), `${JSON.stringify(info, null, 2)}\n`, "utf8");
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
    assert.deepEqual(projectContext.allowedUserIds, []);

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
      },
    });

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
    assert.deepEqual(await Config.listConfiguredBots(), [{ botId: 1, botUsername: "bot-one", lastUpdateId: 99 }]);
    assert.equal(await Config.getConfigVersion(), 2);
    assert.equal(await Config.detectSplitDb(1, dbPath), null);
    assert.match((await Config.detectSplitDb(1, join(tempHome, "other.db"))) ?? "", /non-default DB path/);
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

    Db.setPrimary(1, "alive");
    assert.equal(Db.getPrimarySession(1)?.session_name, "alive");
    assert.equal(Db.getRelaySession(1, "alive")?.session_id, "alive-id");

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
    assert.equal(existsSync(join(relayDir, "alive.json")), true);
    assert.equal(existsSync(join(relayDir, "dead.json")), false);
    assert.equal(existsSync(join(relayDir, "bad.json")), false);
    assert.deepEqual(Array.from(Relay.getAliveSessionNames()), ["alive"]);

    Relay.cleanRelayFilesByPid(process.pid);
    assert.equal(existsSync(join(relayDir, "alive.json")), false);
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
    const relayInfo = readJson(join(relayDir, "relay-main.json"));
    assert.equal(relayInfo.port, info.port);

    const health = await fetch(`http://127.0.0.1:${info.port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", sessionName: "relay-main" });

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
      body: JSON.stringify({ id: 7, sourceSession: "source-a" }),
    });
    assert.equal(completeNoHandler.status, 404);

    let completed = null;
    Relay.setCompleteHandler((id, sourceSession) => {
      completed = { id, sourceSession };
    });
    const complete = await fetch(`http://127.0.0.1:${info.port}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 7, sourceSession: "source-a" }),
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
    assert.deepEqual(captured.complete, { id: 55, secret: "secret-target" });

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
});
