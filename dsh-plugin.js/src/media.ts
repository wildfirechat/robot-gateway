/**
 * Media handling:
 * - inbound: download IM media (image/voice/video/file) to a local temp file;
 *   images are saved through the dsh attachment service so the model can see
 *   them; other files are exposed to the agent as a local path in the text.
 * - outbound: parse `[image:path]` / `[media:path]` / `[file:path]` markers in
 *   the final reply, upload the file to Wildfire and send it as a media
 *   message, stripping the marker from the text.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, realpath, stat, writeFile, unlink } from "node:fs/promises";

export interface PreparedMedia {
  /** Text to include in the agent message (path note / transcript). */
  text: string;
  /** Image blocks ready for the user message (already saved via attachments). */
  images?: Array<{ attachment: any }>;
  /** Temp file to clean up after the turn. */
  tempPath?: string;
}

export interface OutboundMedia {
  path: string;
  isImage: boolean;
}

/** MIME type from the URL/file extension (best effort). */
function mimeFromExt(name: string, fallback: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    amr: "audio/amr",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    opus: "audio/opus",
    aac: "audio/aac",
    wav: "audio/wav",
    flac: "audio/flac",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    webm: "video/webm",
  };
  return map[ext] ?? fallback;
}

/** Whether a file name looks like a raster image the attachment service accepts. */
function isImageExt(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/**
 * Download a remote media URL to a local temp file.
 * Returns the local path, or null on failure.
 */
export async function downloadToTemp(
  remoteUrl: string,
  downloadDir: string,
  logger?: any
): Promise<{ path: string; ext: string } | null> {
  try {
    await mkdir(downloadDir, { recursive: true });
    const urlPath = remoteUrl.split("?")[0];
    const ext = (urlPath.split(".").pop()?.toLowerCase() ?? "bin").replace(/[^a-z0-9]/g, "");
    const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
    const localPath = path.join(downloadDir, `wildfire-${randomUUID()}.${safeExt}`);
    const resp = await fetch(remoteUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await writeFile(localPath, buf);
    return { path: localPath, ext: safeExt };
  } catch (e: any) {
    logger?.warn?.(`[wildfire-media] download failed for ${remoteUrl}: ${e.message}`);
    return null;
  }
}

/**
 * Prepare an inbound media message for the agent.
 * - image: save via `ctx.attachments.saveImages` -> image content block
 * - other: keep the local path as a text note (the agent reads it with fs tools)
 */
export async function prepareInboundMedia(params: {
  mediaUrl: string;
  payloadType: number;
  downloadDir: string;
  attachments: any; // ctx.attachments
  logger?: any;
  transcript?: string; // ASR result for voice
  /** Whether the current model accepts image content blocks. When false,
   * images are exposed as a local path note instead (agent reads with tools). */
  supportsImage?: boolean;
}): Promise<PreparedMedia> {
  const { mediaUrl, payloadType, downloadDir, attachments, logger, transcript, supportsImage = true } = params;

  // Voice with an ASR transcript: text only, no download needed.
  if (payloadType === 2 && transcript) {
    return { text: transcript };
  }

  const downloaded = await downloadToTemp(mediaUrl, downloadDir, logger);
  if (!downloaded) {
    return { text: payloadType === 3 ? "[图片]" : "[附件]" };
  }

  try {
    if (payloadType === 3 && isImageExt(downloaded.path)) {
      // 模型不支持视觉：给本地路径，agent 用文件工具读取/分析（不走图片内容块）
      if (!supportsImage) {
        return {
          text: `[图片] 本地路径: ${downloaded.path}`,
          tempPath: downloaded.path,
        };
      }
      const data = await readFile(downloaded.path);
      const mediaType = mimeFromExt(downloaded.path, "image/jpeg");
      try {
        const refs = await attachments.saveImages([{ data, mediaType, name: path.basename(downloaded.path) }]);
        return {
          text: "[图片]",
          images: [{ attachment: refs[0] }],
          tempPath: downloaded.path,
        };
      } catch (e: any) {
        logger?.warn?.(`[wildfire-media] attachment save failed, fallback to path: ${e.message}`);
        return {
          text: `[图片] 本地路径: ${downloaded.path}`,
          tempPath: downloaded.path,
        };
      }
    }
    return {
      text: `[附件] 本地路径: ${downloaded.path}`,
      tempPath: downloaded.path,
    };
  } catch (e: any) {
    logger?.warn?.(`[wildfire-media] prepare failed: ${e.message}`);
    return { text: `[附件] 本地路径: ${downloaded.path}`, tempPath: downloaded.path };
  }
}

/** Parse `[image:path]` / `[media:path]` / `[file:path]` markers out of text. */
export function extractOutboundMedia(text: string): { text: string; media: OutboundMedia[] } {
  const media: OutboundMedia[] = [];
  const cleaned = text.replace(/\[(image|media|file):([^\]]+)\]/g, (_all, kind: string, p: string) => {
    const pth = p.trim();
    if (pth) {
      media.push({ path: pth, isImage: kind === "image" || isImageExt(pth) });
    }
    return "";
  });
  return { text: cleaned, media };
}

/**
 * Security fence for outbound media: resolve a marker path to its realpath and
 * require it to sit inside one of the allowed directories (typically the
 * conversation workspace and/or the configured `workspace.allowedRoots`).
 * Without this, a prompt-injected agent could exfiltrate arbitrary local
 * files (e.g. `[image:/etc/passwd]`) into the IM chat.
 */
export async function resolveAllowedLocalPath(
  pth: string,
  allowedDirs: string[],
  logger?: any
): Promise<string | null> {
  try {
    const canon = await realpath(pth);
    const statInfo = await stat(canon);
    if (!statInfo.isFile()) return null;
    for (const dir of allowedDirs) {
      const root = await realpath(dir).catch(() => null);
      if (root === null) continue;
      if (canon === root || canon.startsWith(root + path.sep)) return canon;
    }
    logger?.warn?.(`[wildfire-media] outbound path rejected (outside allowed dirs): ${pth}`);
    return null;
  } catch {
    return null;
  }
}

/** Read a local file and upload it to Wildfire; returns the remote URL. */
export async function uploadToWildfire(
  filePath: string,
  upload: (data: Buffer, fileName: string) => Promise<string | null>,
  logger?: any
): Promise<string | null> {
  try {
    const data = await readFile(filePath);
    const fileName = filePath.split("/").pop() ?? "file";
    return await upload(data, fileName);
  } catch (e: any) {
    logger?.warn?.(`[wildfire-media] upload failed for ${filePath}: ${e.message}`);
    return null;
  }
}

/** Remove a temp file (best effort). */
export function cleanupTemp(tempPath?: string): void {
  if (!tempPath) return;
  unlink(tempPath).catch(() => {});
}

export { mimeFromExt, isImageExt };
