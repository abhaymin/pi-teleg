import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamUpload } from "../mcp-server/upload.js";

test("media uploads stream multipart bytes with the correct Telegram field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teleg-upload-"));
  const filePath = join(dir, "sample.bin");
  const bytes = Buffer.from([0, 1, 255, 13, 10, 42]);
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { message_id: 123 } }));
  });
  try {
    await writeFile(filePath, bytes);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const bot = { baseUrl: `http://127.0.0.1:${server.address().port}/bot-test` };
    for (const [method, field] of Object.entries({ sendPhoto: "photo", sendVideo: "video", sendDocument: "document" })) {
      const res = await streamUpload(bot, filePath, method, { chat_id: "42", caption: "Test café" });
      assert.equal((await res.json()).ok, true);
      const request = requests.at(-1);
      assert.equal(request.url, `/bot-test/${method}`);
      assert.equal(Number(request.headers["content-length"]), request.body.length);
      const form = await new Response(request.body, { headers: { "content-type": request.headers["content-type"] } }).formData();
      assert.equal(form.get("chat_id"), "42");
      assert.equal(form.get("caption"), "Test café");
      assert.deepEqual([...form.keys()].sort(), ["caption", "chat_id", field].sort());
      assert.equal(form.get(field).name, "sample.bin");
      assert.deepEqual(Buffer.from(await form.get(field).arrayBuffer()), bytes);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
