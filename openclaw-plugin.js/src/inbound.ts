/**
 * Handle incoming messages from Wildfire IM
 */

import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { WildfireConfig } from "./config.js";
// @ts-ignore - runtime may not be fully typed
import { shouldRespondToGroupMessage } from "./utils.js";
import { getClient } from "./clients.js";
import { WhitelistFilter } from "./whitelist.js";
import {
  TextMessageContent,
  ImageMessageContent,
  VideoMessageContent,
  FileMessageContent,
  StreamingTextGeneratingMessageContent,
  StreamingTextGeneratedMessageContent,
  Conversation,
} from "@wildfirechat/server-sdk";

// Message type constants
const MESSAGE_TYPE_TEXT = 1;
const MESSAGE_TYPE_VOICE = 2;
const MESSAGE_TYPE_IMAGE = 3;
const MESSAGE_TYPE_VIDEO = 4;
const MESSAGE_TYPE_FILE = 5;

// Conversation type constants
const CONV_TYPE_SINGLE = 0;
const CONV_TYPE_GROUP = 1;
const CONV_TYPE_CHANNEL = 2;

// Per-session serialization: only one AI request per session may be in-flight at a time.
const sessionQueues = new Map<string, Promise<void>>();
/**
 * Process incoming message from Wildfire IM
 */
export async function handleIncomingMessage(
  api: any,
  message: any,
  config: WildfireConfig
): Promise<void> {
  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[wildfire] runtime.channel.reply not available");
    return;
  }

  const data = message.data;
  if (!data) return;

  const sender = data.sender;
  const conv = data.conv;
  const payload = data.payload;

  if (!sender || !conv || !payload) return;

  // Skip non-content messages
  const payloadType = payload.type;
  if (payloadType <= 0 || payloadType === 14 ||  (payloadType > 15 && payloadType < 100) || payloadType > 200) {
    return;
  }

  const isGroup = conv.type === CONV_TYPE_GROUP || conv.type === CONV_TYPE_CHANNEL;
  const { text, mediaUrl } = extractPayloadInfo(payload);

  api.logger?.info?.(
    `[wildfire-inbound] message received: sender=${sender}, convType=${conv.type}, target=${conv.target}, payloadType=${payloadType}, textPreview=${safePreview(text)}, mediaUrl=${mediaUrl || ""}`
  );
  api.logger?.debug?.(
    `[wildfire-inbound] payload snapshot: ${JSON.stringify({
      type: payload?.type,
      searchableContent: payload?.searchableContent,
      content: payload?.content,
      remoteMediaUrl: payload?.remoteMediaUrl,
      mediaUrl: payload?.mediaUrl,
      remoteUrl: payload?.remoteUrl,
      url: payload?.url,
      extra: payload?.extra,
      duration: payload?.duration,
      keys: Object.keys(payload || {}),
    })}`
  );

  // Check if should respond (group filtering)
  if (isGroup && !shouldRespondToGroupMessage(text, data, config)) {
    return;
  }

  // Check whitelist
  const whitelistFilter = new WhitelistFilter(config);
  if (!whitelistFilter.shouldProcess(String(sender), String(conv.target), isGroup)) {
    api.logger?.info?.(`[wildfire] message from ${sender} blocked by whitelist`);
    // Send denied message
    try {
      const deniedMessage = config.whiteList?.deniedMessage || "不允许使用";
      await sendDirectReply(sender, conv, deniedMessage, api);
    } catch (e: any) {
      api.logger?.error?.(`[wildfire] failed to send denied message: ${e.message}`);
    }
    return;
  }

  const baseSessionKey = isGroup
    ? `wildfire:group:${conv.target}`.toLowerCase()
    : `wildfire:user:${sender}`.toLowerCase();

  const cfg = api.config;
  const routePeer = isGroup
    ? { kind: "group" as const, id: String(conv.target) }
    : { kind: "direct" as const, id: String(sender) };

  const route =
    runtime.channel.routing?.resolveAgentRoute?.({
      cfg,
      channel: "wildfire",
      accountId: "default",
      peer: routePeer,
    }) ?? { agentId: "main", sessionKey: baseSessionKey };

  const sessionKey = String(route?.sessionKey ?? baseSessionKey).trim() || baseSessionKey;

  // Wait for any in-flight request on this session to finish before starting a new one.
  const prevRequest = sessionQueues.get(sessionKey) ?? Promise.resolve();
  let releaseSession!: () => void;
  const sessionSlot = new Promise<void>(resolve => { releaseSession = resolve; });
  sessionQueues.set(sessionKey, sessionSlot);
  await prevRequest.catch(() => {});
  let mediaTempPath: string | undefined;
  try {
    const storePath =
      runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
        agentId: route.agentId,
      }) ?? "";

    const chatType = isGroup ? "group" : "direct";
    const fromLabel = String(sender);
    const conversationLabel = isGroup ? `group:${conv.target}` : `user:${sender}`;
    const senderId = String(sender);
    const timestamp = Date.now();
    const asrServer = resolveAsrServer(config);

  // 生成唯一的 streamId 用于流式消息（每条用户消息有独立的流）
  const streamId = `stream-${randomUUID()}`;
  let finalText = "";
  let hasCompleted = false;

  // 先发送一个空的 generating 消息显示转圈等待，让客户端立即看到响应
  try {
    await sendStreamingReply(sender, conv, "...", streamId, "generating", api);
  } catch (e: any) {
    api.logger?.error?.(`[wildfire] initial stream failed: ${e.message}`);
  }

    let transcript: string | undefined;
    if (payloadType === MESSAGE_TYPE_VOICE && mediaUrl && asrServer) {
      transcript = await transcribeWithAsrServer({
        asrServer,
        mediaUrl,
        logger: api.logger,
      });
      if (transcript) {
        api.logger?.info?.(
          `[wildfire-inbound] ASR transcript ready: len=${transcript.length}, preview=${safePreview(transcript)}`
        );
      } else {
        api.logger?.warn?.("[wildfire-inbound] ASR transcript empty, fallback to voice placeholder text");
      }
    }

    const bodyText = transcript || text;

    const ctxPayload: Record<string, any> = {
      Body: bodyText,
      RawBody: bodyText,
      From: isGroup ? `wildfire:group:${conv.target}` : `wildfire:user:${sender}`,
      To: isGroup ? `wildfire:group:${conv.target}` : `wildfire:user:${sender}`,
      SessionKey: sessionKey,
      AccountId: "default",
      ChatType: chatType,
      ConversationLabel: conversationLabel,
      SenderName: fromLabel,
      SenderId: senderId,
      Provider: "wildfire",
      Surface: "wildfire",
      // Use real message ID when available; fall back to UUID to avoid collisions
      MessageSid: `wildfire-${(data.messageId ?? data.msgId ?? data.mid) || randomUUID()}`,
      Timestamp: timestamp,
      OriginatingChannel: "wildfire",
      OriginatingTo: `wildfire:user:${sender}`,
      CommandAuthorized: true,
      _wildfire: {
        accountId: "default",
        isGroup,
        senderId,
        conversationId: conv.target,
        messageType: payloadType,
        mediaUrl: mediaUrl ?? null,
      },
    };

    if (transcript) {
      ctxPayload.Transcript = transcript;
    }

  // Download remote media to a local temp file so openclaw can read it via MediaPath.
  // openclaw expects MediaPath to be a local filesystem path, not a remote URL.
  const shouldDownloadMedia = Boolean(mediaUrl) && !(payloadType === MESSAGE_TYPE_VOICE && transcript);
  if (shouldDownloadMedia && mediaUrl) {
    const downloaded = await downloadMediaToTemp(mediaUrl, payloadType, api.logger);
    if (downloaded) {
      mediaTempPath = downloaded.localPath;
      ctxPayload.MediaPath = downloaded.localPath;
      ctxPayload.MediaUrl = downloaded.localPath;   // legacy alias — must equal MediaPath
      ctxPayload.MediaType = downloaded.contentType;
      api.logger?.info?.(
        `[wildfire-inbound] media downloaded: remoteUrl=${mediaUrl}, localPath=${downloaded.localPath}, contentType=${downloaded.contentType}`
      );
    } else {
      api.logger?.warn?.(`[wildfire-inbound] media download failed, dispatching without media: remoteUrl=${mediaUrl}`);
    }
  }

  if (payloadType === MESSAGE_TYPE_VOICE && !asrServer) {
    api.logger?.debug?.("[wildfire-inbound] asrServer not configured; skip speech-to-text");
  }

  api.logger?.info?.(
    `[wildfire-inbound] dispatch ctx: sessionKey=${sessionKey}, bodyPreview=${safePreview(String(ctxPayload.Body || ""))}, MediaPath=${ctxPayload.MediaPath || ""}, MediaType=${ctxPayload.MediaType || ""}`
  );
  api.logger?.debug?.(
    `[wildfire-inbound] dispatch ctx keys: ${Object.keys(ctxPayload).join(",")}`
  );

  // Record session
  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !isGroup
        ? {
            sessionKey,
            channel: "wildfire",
            to: `wildfire:user:${senderId}`,
            accountId: "default",
          }
        : undefined,
      onRecordError: (err: unknown) =>
        api.logger?.warn?.(`[wildfire] recordInboundSession: ${String(err)}`),
    });
  }

  // Record activity
  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "wildfire",
      accountId: "default",
      direction: "inbound",
    });
  }

  // Dispatch to OpenClaw - 使用真正的流式回复（onPartialReply）
  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        // deliver is called once per block (paragraph) with that block's text only — NOT cumulative.
        deliver: async (_payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) => {
          if (!_payload) return;
          // Handle media (file/image/video) delivery
          const mediaUrl = _payload.mediaUrl || (_payload.mediaUrls && _payload.mediaUrls[0]);
          const mediaClient = getClient();
          if (mediaUrl && mediaClient) {
            api.logger?.info?.(`[wildfire] deliver: mediaUrl=${mediaUrl}`);
            try {
              // Read the file
              let fileData: Buffer;
              let fileName = 'file';
              try {
                const urlPath = mediaUrl.split('?')[0];
                fileName = urlPath.split('/').pop() || 'file';
                fileData = readFileSync(mediaUrl);
              } catch (readErr: any) {
                api.logger?.warn?.(`[wildfire] deliver: media read failed for ${mediaUrl}: ${readErr.message}`);
                return;
              }

              const fileSize = fileData.length;

              // Upload file
              api.logger?.info?.(`[wildfire] deliver: uploading ${fileName} (${fileSize} bytes)...`);
              const uploadResult = await mediaClient.uploadFile(fileData, fileName, 4, 'application/octet-stream');
              if (!uploadResult.isSuccess()) {
                api.logger?.error?.(`[wildfire] deliver: upload failed: ${uploadResult.getMsg()}`);
                return;
              }

              const remoteUrl = uploadResult.getResult();
              api.logger?.info?.(`[wildfire] deliver: file uploaded: ${remoteUrl}`);

              // Detect media type and send
              const ext = fileName.toLowerCase();
              const conversation = {
                type: conv.type,
                target: conv.type === 0 ? sender : conv.target,
                line: conv.line,
              };

              let payload: any;
              if (ext.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/)) {
                const imageContent = new ImageMessageContent(null, remoteUrl, null);
                payload = imageContent.encode();
              } else if (ext.match(/\.(mp4|mov|avi|mkv|webm)$/)) {
                const videoContent = new VideoMessageContent(null, remoteUrl, null, 0);
                payload = videoContent.encode();
              } else {
                const fileContent = new FileMessageContent(null, remoteUrl, fileName, fileSize);
                payload = fileContent.encode();
              }

              const sendResult = await mediaClient.sendMessage(conversation, payload);
              api.logger?.info?.(`[wildfire] deliver: send result: success=${sendResult.isSuccess()}`);

              // If we sent media, suppress the text-only streaming reply
              if (_payload.text && finalText.length > 0) {
                // Keep the text in finalText so the completed message has context
                // but don't send additional text-only message
              }
            } catch (e: any) {
              api.logger?.error?.(`[wildfire] deliver: media send error: ${e.message}`);
            }
          }
        },
        onError: (err: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[wildfire] ${info?.kind || "reply"} failed: ${String(err)}`);
        },
      },
      replyOptions: {
        disableBlockStreaming: false,
        // 真正的流式回调：每次生成新内容时触发
        onPartialReply: async (payload: { text?: string }) => {
          if (!payload.text) return;
          
          // 更新最终文本
          finalText = payload.text;
          
          api.logger?.debug?.(`[wildfire-debug] onPartialReply: ${payload.text.substring(0, 30)}...`);

          try {
            // 发送 generating 消息更新同一条消息
            await sendStreamingReply(sender, conv, payload.text, streamId, "generating", api);
          } catch (e: any) {
            api.logger?.error?.(`[wildfire] stream update failed: ${e.message}`);
          }
        },
      },
    });

    // 流式完成，发送 completed 消息
    if (!hasCompleted) {
      hasCompleted = true;
      api.logger?.debug?.(`[wildfire-debug] stream completed, text=${finalText?.substring(0, 30)}`);
      
      // 如果有内容就发送 completed，否则发送错误提示
      const textToSend = finalText || "(no response)";
      await sendStreamingReply(sender, conv, textToSend, streamId, "completed", api);
    }
  } catch (err: any) {
    api.logger?.error?.(`[wildfire] dispatch failed: ${err.message}`);
    try {
      const errorText = `Processing failed: ${err.message.slice(0, 80)}`;
      await sendStreamingReply(sender, conv, errorText, streamId, "completed", api);
    } catch {
      // ignore secondary send errors
    }
  }

  } finally {
    releaseSession();
    if (sessionQueues.get(sessionKey) === sessionSlot) {
      sessionQueues.delete(sessionKey);
    }
    if (mediaTempPath) {
      unlink(mediaTempPath).catch((e: any) =>
        api.logger?.warn?.(`[wildfire-inbound] temp file cleanup failed: ${e.message}`)
      );
    }
  }
}
/**
 * Send streaming reply back to Wildfire IM
 * 
 * 流式消息分为三种状态：
 * - start: 流式开始，发送首段内容
 * - generating: 流式生成中，发送增量内容
 * - completed: 流式完成，发送最终完整内容
 */
async function sendStreamingReply(
  sender: string,
  conv: { type: number; target: string; line: number },
  text: string,
  streamId: string,
  state: "start" | "generating" | "completed",
  api?: any
): Promise<void> {
  api?.logger?.debug?.(`[wildfire-debug] sendStreamingReply called, state=${state}, text=${text?.substring(0, 30)}`);
  const client = getClient();
  if (!client) {
    api?.logger?.error?.("[wildfire-debug] client not connected");
    throw new Error("Wildfire client not connected");
  }

  const conversation: Conversation = {
    type: conv.type,
    target: conv.type === 0 ? sender : conv.target,
    line: conv.line,
  };

  let payload;
  if (state === "generating" || state === "start") {
    // 流式生成中 - 使用 StreamingTextGeneratingMessageContent
    const generatingContent = new StreamingTextGeneratingMessageContent();
    generatingContent.text = text;
    generatingContent.streamId = streamId;
    payload = generatingContent.encode();
  } else if (state === "completed") {
    // 流式生成完成 - 使用 StreamingTextGeneratedMessageContent
    const generatedContent = new StreamingTextGeneratedMessageContent();
    generatedContent.text = text;
    generatedContent.streamId = streamId;
    payload = generatedContent.encode();
  } else {
    // 其他情况使用普通文本消息
    const textContent = new TextMessageContent();
    textContent.content = text;
    payload = textContent.encode();
  }

  api?.logger?.debug?.(`[wildfire-debug] sending streaming message: state=${state}, streamId=${streamId}`);

  try {
    const result = await client.sendMessage(conversation, payload);
    api?.logger?.debug?.(`[wildfire-debug] sendMessage result: success=${result.isSuccess()}, msg=${result.getMsg()}`);

    if (!result.isSuccess()) {
      throw new Error(result.getMsg());
    }
    api?.logger?.debug?.(`[wildfire-debug] streaming message sent successfully`);
  } catch (e: any) {
    api?.logger?.error?.(`[wildfire-debug] sendMessage error: ${e.message}`);
    throw e;
  }
}

/**
 * Extract text and optional media URL from payload
 */
function extractPayloadInfo(payload: any): { text: string; mediaUrl?: string } {
  const mediaUrl = pickMediaUrl(payload);

  switch (payload.type) {
    case MESSAGE_TYPE_TEXT:
      return { text: payload.searchableContent || payload.content || "" };
    case MESSAGE_TYPE_VOICE: {
      const duration = payload.duration ? ` ${payload.duration}s` : "";
      return {
        text: `[语音${duration}]`,
        mediaUrl,
      };
    }
    case MESSAGE_TYPE_IMAGE:
      return { text: "[图片]", mediaUrl };
    case MESSAGE_TYPE_VIDEO:
      return { text: "[视频]", mediaUrl };
    case MESSAGE_TYPE_FILE:
      return { text: `[文件] ${payload.searchableContent || ""}`, mediaUrl };
    default:
      return { text: `[消息类型:${payload.type}]` };
  }
}

function pickMediaUrl(payload: any): string | undefined {
  const candidates = [
    payload?.remoteMediaUrl,
    payload?.mediaUrl,
    payload?.remoteUrl,
    payload?.url,
  ];

  const normalized = candidates
    .map(v => (typeof v === "string" ? v.trim() : ""))
    .find(v => !!v);

  return normalized || undefined;
}

function safePreview(value: string, maxLen = 120): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

function resolveAsrServer(config: WildfireConfig): string | undefined {
  const asr = config.asrServer;
  if (!asr || typeof asr !== "string") return undefined;
  const trimmed = asr.trim();
  return trimmed || undefined;
}

async function transcribeWithAsrServer(params: {
  asrServer: string;
  mediaUrl: string;
  logger?: any;
}): Promise<string | undefined> {
  try {
    const res = await fetch(params.asrServer, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
      },
      body: JSON.stringify({
        url: params.mediaUrl,
        noReuse: false,
        noLlm: false,
      }),
    });

    if (!res.ok) {
      params.logger?.warn?.(`[wildfire-inbound] ASR request failed: status=${res.status}`);
      return undefined;
    }

    if (!res.body) {
      const plainText = (await res.text()).trim();
      return plainText || undefined;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let result = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r\n|\n|\r/g);
      pending = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("data:")) {
          result += trimmed.slice(5).trim();
        } else {
          result += trimmed;
        }
      }
    }

    if (pending.trim()) {
      const tail = pending.trim();
      result += tail.startsWith("data:") ? tail.slice(5).trim() : tail;
    }

    const cleaned = result.trim();
    return cleaned || undefined;
  } catch (e: any) {
    params.logger?.warn?.(`[wildfire-inbound] ASR request error: ${e.message}`);
    return undefined;
  }
}

/** Maps a remote media URL to a best-guess MIME type using the URL extension. */
function mimeFromUrl(url: string, payloadType: number): string {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    amr: "audio/amr",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    opus: "audio/opus",
    aac: "audio/aac",
    wav: "audio/wav",
    flac: "audio/flac",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
  };
  if (map[ext]) return map[ext];
  if (payloadType === MESSAGE_TYPE_VOICE) return "audio/amr";
  if (payloadType === MESSAGE_TYPE_IMAGE) return "image/jpeg";
  if (payloadType === MESSAGE_TYPE_VIDEO) return "video/mp4";
  return "application/octet-stream";
}

/**
 * Download a remote media URL to /tmp/openclaw/ so openclaw can access it as a local file.
 * openclaw's MediaPath must be a local filesystem path in an allowed root directory.
 */
async function downloadMediaToTemp(
  remoteUrl: string,
  payloadType: number,
  logger?: any
): Promise<{ localPath: string; contentType: string } | undefined> {
  try {
    const tmpDir = "/tmp/openclaw";
    await mkdir(tmpDir, { recursive: true });

    const urlPath = remoteUrl.split("?")[0];
    const ext = urlPath.split(".").pop()?.toLowerCase() ?? "bin";
    const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
    const localPath = path.join(tmpDir, `wildfire-${randomUUID()}.${safeExt}`);

    const resp = await fetch(remoteUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    await writeFile(localPath, buf);

    const contentType =
      resp.headers.get("content-type")?.split(";")[0].trim() ||
      mimeFromUrl(remoteUrl, payloadType);

    return { localPath, contentType };
  } catch (e: any) {
    logger?.warn?.(`[wildfire-inbound] downloadMediaToTemp failed for ${remoteUrl}: ${e.message}`);
    return undefined;
  }
}

/**
 * Send direct reply back to Wildfire IM (for whitelist rejection, etc.)
 */
async function sendDirectReply(
  sender: string,
  conv: { type: number; target: string; line: number },
  text: string,
  api?: any
): Promise<void> {
  api?.logger?.debug?.(`[wildfire-debug] sendDirectReply called, text=${text?.substring(0, 30)}`);
  const client = getClient();
  if (!client) {
    api?.logger?.error?.("[wildfire-debug] client not connected");
    throw new Error("Wildfire client not connected");
  }

  const conversation: Conversation = {
    type: conv.type,
    target: conv.type === 0 ? sender : conv.target,
    line: conv.line,
  };

  api?.logger?.debug?.(`[wildfire-debug] sendDirectReply conversation: type=${conv.type}, target=${conversation.target}, line=${conv.line}`);

  const content = new TextMessageContent();
  content.content = text;

  try {
    const result = await client.sendMessage(conversation, content.encode());
    api?.logger?.debug?.(`[wildfire-debug] sendDirectReply result: success=${result.isSuccess()}, msg=${result.getMsg()}`);
    
    if (!result.isSuccess()) {
      throw new Error(result.getMsg());
    }
    api?.logger?.debug?.(`[wildfire-debug] direct reply sent successfully`);
  } catch (e: any) {
    api?.logger?.error?.(`[wildfire-debug] sendDirectReply error: ${e.message}`);
    throw e;
  }
}
