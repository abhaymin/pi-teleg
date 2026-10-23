import { createReadStream } from "node:fs";

/**
 * Build a multipart/form-data body using streaming for large files.
 * Avoids loading entire file into memory.
 */
export async function streamUpload(bot, filePath, method, extraFields = {}) {
  const fieldName = { sendPhoto: "photo", sendVideo: "video", sendDocument: "document" }[method];
  if (!fieldName) throw new Error(`Unsupported upload method: ${method}`);
  const fileName = filePath.split("/").pop();
  const fileSize = (await import("fs")).statSync(filePath).size;

  const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;

  let header = `--${boundary}\r\n`;
  for (const [key, value] of Object.entries(extraFields)) {
    header += `Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n--${boundary}\r\n`;
  }
  header += `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n`;
  header += `Content-Type: application/octet-stream\r\n\r\n`;

  const { Readable } = await import("stream");
  const footer = `\r\n--${boundary}--\r\n`;

  const headerStream = Readable.from([Buffer.from(header)]);
  const fileStream = createReadStream(filePath);
  const footerStream = Readable.from([Buffer.from(footer)]);

  const combined = Readable.from((async function* () {
    for (const stream of [headerStream, fileStream, footerStream]) {
      yield* stream;
    }
  })());

  const res = await fetch(`${bot.baseUrl}/${method}`, {
    method: "POST",
    duplex: "half",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(Buffer.byteLength(header) + fileSize + Buffer.byteLength(footer)),
    },
    body: combined,
    signal: AbortSignal.timeout(300_000), // 5 min timeout
  });

  return res;
}

