/**
 * Download Telegram message media to the local teleg-media cache via getFile.
 * Shared by the extension (reply-parent recovery) — the poll worker keeps its
 * own copy to avoid Worker bundling issues.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const MEDIA_DIR = join(homedir(), ".pi", "agent", "tmp", "teleg-media");
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export interface TelegramFileRef {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_name?: string;
}

export interface TelegramMediaMessage {
  photo?: Array<TelegramFileRef & { width?: number; height?: number }>;
  video?: TelegramFileRef;
  animation?: TelegramFileRef;
  document?: TelegramFileRef & { file_name?: string };
  audio?: TelegramFileRef;
  voice?: TelegramFileRef;
  sticker?: TelegramFileRef;
  text?: string;
  caption?: string;
}

export interface DownloadedAttachment {
  path: string;
  fileName: string;
  type: string;
}

export function messageHasMedia(message: TelegramMediaMessage | null | undefined): boolean {
  if (!message) return false;
  return !!(
    (message.photo && message.photo.length > 0) ||
    message.video || message.animation || message.document ||
    message.audio || message.voice || message.sticker
  );
}

export function describeMediaTypes(message: TelegramMediaMessage | null | undefined): string[] {
  if (!message) return [];
  const types: string[] = [];
  if (message.photo && message.photo.length > 0) types.push("image");
  if (message.video) types.push("video");
  if (message.animation) types.push("animation");
  if (message.document) types.push("document");
  if (message.audio) types.push("audio");
  if (message.voice) types.push("voice");
  if (message.sticker) types.push("sticker");
  return types;
}

/** Best-effort download of all media on a Telegram message (Bot API getFile ≤20MB). */
export async function downloadTelegramMedia(
  botToken: string,
  botId: number,
  message: TelegramMediaMessage,
): Promise<DownloadedAttachment[]> {
  const refs: Array<{ file_id: string; type: string; fileName?: string; file_size?: number; file_unique_id?: string }> = [];
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo.reduce((a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a));
    refs.push({ file_id: largest.file_id, type: "image", file_size: largest.file_size, file_unique_id: largest.file_unique_id });
  }
  if (message.video) refs.push({ file_id: message.video.file_id, type: "video", file_size: message.video.file_size, file_unique_id: message.video.file_unique_id });
  if (message.animation) refs.push({ file_id: message.animation.file_id, type: "animation", file_size: message.animation.file_size, file_unique_id: message.animation.file_unique_id });
  if (message.document) refs.push({ file_id: message.document.file_id, type: "document", fileName: message.document.file_name, file_size: message.document.file_size, file_unique_id: message.document.file_unique_id });
  if (message.audio) refs.push({ file_id: message.audio.file_id, type: "audio", file_size: message.audio.file_size, file_unique_id: message.audio.file_unique_id });
  if (message.voice) refs.push({ file_id: message.voice.file_id, type: "voice", file_size: message.voice.file_size, file_unique_id: message.voice.file_unique_id });
  if (message.sticker) refs.push({ file_id: message.sticker.file_id, type: "sticker", file_size: message.sticker.file_size, file_unique_id: message.sticker.file_unique_id });

  const out: DownloadedAttachment[] = [];
  for (const ref of refs) {
    if (ref.file_size && ref.file_size > MAX_DOWNLOAD_BYTES) {
      console.error(`[teleg-media] skip ${ref.type}: file_size ${ref.file_size} > ${MAX_DOWNLOAD_BYTES}`);
      continue;
    }
    try {
      const metaRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: ref.file_id }),
        signal: AbortSignal.timeout(15000),
      });
      const meta = (await metaRes.json()) as { ok?: boolean; result?: { file_path?: string; file_unique_id?: string }; description?: string };
      if (!meta.ok || !meta.result?.file_path) {
        console.error(`[teleg-media] getFile failed (${ref.type}):`, meta.description || metaRes.status);
        continue;
      }
      const dir = join(MEDIA_DIR, String(botId));
      mkdirSync(dir, { recursive: true });
      const baseName = ref.fileName || meta.result.file_path.split("/").pop() || ref.file_id;
      const unique = meta.result.file_unique_id || ref.file_unique_id || ref.file_id;
      const safeName = `${ref.type}-${unique}-${baseName}`.replace(/[^A-Za-z0-9._-]/g, "_");
      const path = join(dir, safeName);
      if (existsSync(path)) {
        out.push({ path, fileName: baseName, type: ref.type });
        continue;
      }
      const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!fileRes.ok) {
        console.error(`[teleg-media] download HTTP ${fileRes.status} for ${ref.type}`);
        continue;
      }
      const buf = Buffer.from(await fileRes.arrayBuffer());
      writeFileSync(path, buf);
      out.push({ path, fileName: baseName, type: ref.type });
    } catch (err) {
      console.error(`[teleg-media] download failed (${ref.type}):`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
