/**
 * Inbound message handling: Wildfire PushMessage -> dsh Agent dispatch with
 * streaming replies back to Wildfire.
 *
 * Mirrors the openclaw plugin's `inbound.ts` for filtering/serialization and
 * replaces the openclaw reply dispatch with the dsh AgentSessionManager.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readdir, realpath, stat, rm } from "node:fs/promises";
import {
  TextMessageContent,
  ImageMessageContent,
  FileMessageContent,
  StreamingTextGeneratingMessageContent,
  StreamingTextGeneratedMessageContent,
} from "@wildfirechat/server-sdk";
import type { WildfireConfig } from "./config.js";
import { getStreamingConfig, getMediaConfig, getSecurityConfig, getWorkspaceConfig, getWhitelistConfig } from "./config.js";
import { getClient } from "./clients.js";
import { WhitelistFilter } from "./whitelist.js";
import { AgentSessionManager } from "./agent.js";
import {
  CONV_TYPE_GROUP,
  CONV_TYPE_CHANNEL,
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_VOICE,
  conversationKey,
  extractPayloadInfo,
  safePreview,
  shouldRespondToGroupMessage,
} from "./utils.js";
import {
  cleanupTemp,
  extractOutboundMedia,
  prepareInboundMedia,
  resolveAllowedLocalPath,
  uploadToWildfire,
  type PreparedMedia,
} from "./media.js";
import {
  DSH_TYPE,
  parseContent,
  type DSHAnswerPayload,
  type DSHApprovalResultPayload,
} from "./protocol.js";
import { SANDBOX_MODES, setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { sessionIdForConversation } from "./agent.js";

const pathJoin = path.join;
// Per-session serialization: only one agent turn per IM conversation at a time.
const sessionQueues = new Map<string, Promise<void>>();

// Sender who owns the in-flight turn per conversation (for interaction ownership).
export const turnOwners = new Map<string, string>();

// Per-conversation rate-limit windows (timestamps of the last minute).
const rateWindows = new Map<string, number[]>();

/** Throttled full-text streamer for Wildfire streaming messages. */
class ThrottledStream {
  private fullText = "";
  private timer: NodeJS.Timeout | undefined;
  private lastFlush = 0;

  constructor(
    private flush: (text: string) => Promise<void>,
    private throttleMs: number
  ) {}

  push(delta: string): void {
    this.fullText += delta;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.throttleMs - (Date.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushNow().catch(() => {});
    }, wait);
  }

  private async flushNow(): Promise<void> {
    if (!this.fullText) return;
    const text = this.fullText;
    this.fullText = "";
    this.lastFlush = Date.now();
    await this.flush(text);
  }

  /** Flush remaining text (called at turn end). */
  async finish(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flushNow();
  }
}

export async function handleIncomingMessage(
  api: any,
  message: any,
  config: WildfireConfig
): Promise<void> {
  const agents: AgentSessionManager | undefined = api.wildfireAgents;
  if (!agents) {
    api.logger?.warn?.("[wildfire] agent manager not ready");
    return;
  }

  const data = message?.data;
  if (!data) return;
  const sender: string = data.sender;
  const conv = data.conv;
  const payload = data.payload;
  if (!sender || !conv || !payload) return;

  // Skip non-content messages, but keep the DSH interaction segment (200-209)
  // and the group-notification segment (104-125) flowing so they can be
  // handled before dispatch.
  const payloadType = payload.type;
  const isDshType = payloadType >= 200 && payloadType <= 209;
  const isGroupNotification = payloadType >= 104 && payloadType <= 125;
  if (
    payloadType <= 0 ||
    payloadType === 14 ||
    (payloadType > 15 && payloadType < 100 && !isGroupNotification) ||
    (payloadType > 209)
  ) {
    return;
  }

  const isGroup = conv.type === CONV_TYPE_GROUP || conv.type === CONV_TYPE_CHANNEL;
  const { text, mediaUrl } = extractPayloadInfo(payload);
  const key = conversationKey(isGroup, isGroup ? conv.target : sender);

  api.logger?.info?.(
    `[wildfire] message: sender=${sender}, convType=${conv.type}, target=${conv.target}, type=${payloadType}, key=${key}, text=${safePreview(text)}`
  );

  // Group notifications (104-125) are system events: handle lifecycle before
  // whitelist / filters / dispatch (see INTERACTION_DESIGN.md §4.3.1).
  if (isGroupNotification) {
    await handleGroupNotification(api, payloadType, conv, key);
    return;
  }

  // Whitelist (owner + static + dynamic /allow list).
  const whitelist: WhitelistFilter = api.whitelist ?? new WhitelistFilter(config);
  if (!whitelist.shouldProcess(String(sender), String(conv.target), isGroup)) {
    api.logger?.info?.(`[wildfire] blocked by whitelist: sender=${sender}`);
    await sendDirectReply(sender, conv, whitelist.deniedMessage, api);
    return;
  }

  // Rate limit (cost/resource protection): per-conversation sliding window.
  const security = getSecurityConfig(config);
  if (security.maxMessagesPerMinute > 0) {
    const now = Date.now();
    const window = (rateWindows.get(key) ?? []).filter((t) => now - t < 60_000);
    if (window.length >= security.maxMessagesPerMinute) {
      api.logger?.info?.(`[wildfire] rate limited: key=${key}`);
      await sendDirectReply(sender, conv, "请求过于频繁，请稍后再试", api);
      return;
    }
    window.push(now);
    rateWindows.set(key, window);
  }

  // Remember the conversation target for interactive seams (ask_user / approval).
  api.interactions?.remember(key, String(sender), { type: conv.type, target: String(conv.target), line: conv.line });

  // Structured DSH replies (201 DSH_Answer / 203 DSH_ApprovalResult).
  if (isDshType) {
    const isAdmin = api.access?.canRunCommand?.(String(sender)) ?? false;
    if (payloadType === DSH_TYPE.ANSWER) {
      const answer = parseContent<DSHAnswerPayload>(payload);
      if (answer && api.interactions?.handleAnswer(key, answer, String(sender), isAdmin)) {
        api.logger?.info?.(`[wildfire] DSH_Answer consumed: key=${key}`);
        return;
      }
    } else if (payloadType === DSH_TYPE.APPROVAL_RESULT) {
      const result = parseContent<DSHApprovalResultPayload>(payload);
      if (result && api.interactions?.handleApprovalResult(key, result, String(sender), isAdmin)) {
        api.logger?.info?.(`[wildfire] DSH_ApprovalResult consumed: key=${key}`);
        return;
      }
    }
    // An unmatched DSH_* message is not for this plugin — drop it.
    api.logger?.debug?.(`[wildfire] unmatched DSH_* message type=${payloadType}, key=${key}`);
    return;
  }

  // DSH workspace groups: only groups in the plugin registry are processed.
  // (The group extra marker alone is NOT trusted — see registry.ts.)
  if (isGroup && !api.registry?.isDshGroup?.(String(conv.target))) {
    api.logger?.debug?.(`[wildfire] non-DSH group ignored: ${conv.target}`);
    return;
  }

  // Slash commands are always addressed at the robot: they take priority over
  // a pending card's custom answer (a `/` prefix is a command, not natural
  // language) and skip the group trigger policy below (which would silently
  // drop e.g. `/cwd /path` — no @mention, no question mark, no keyword).
  const trimmed = text.trim();
  const isSlashCommand = trimmed.startsWith("/");

  // `/stop` must interrupt a running turn, so it cannot wait behind the
  // per-conversation queue (the running turn holds the slot) nor be consumed
  // as a pending card's text answer. Any admitted session member may stop.
  if (/^\/stop\b/.test(trimmed)) {
    await handleStopCommand(api, key, sender, conv);
    return;
  }

  // A pending question/approval: this message IS the answer. Consume it BEFORE
  // the group-trigger policy, otherwise a plain reply (no @mention, no
  // question mark, no keyword) would be dropped and the question would hang
  // until its timeout. Only the turn's owner (or an admin) may answer.
  if (!isSlashCommand && api.interactions?.handleTextReply(key, text, String(sender), api.access?.canRunCommand?.(String(sender)))) {
    api.logger?.info?.(`[wildfire] message consumed as interaction reply: key=${key}`);
    return;
  }

  // Serialize per conversation: agent turns AND management commands share the
  // queue, so a `/reset` cannot dispose an agent mid-turn.
  const prev = sessionQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => (release = resolve));
  sessionQueues.set(key, slot);
  await prev.catch(() => {});

  // Group trigger policy (normal chat only; interaction replies already
  // consumed, slash commands always pass).
  if (isGroup && !isSlashCommand && !shouldRespondToGroupMessage(text, data, config)) {
    release();
    if (sessionQueues.get(key) === slot) {
      sessionQueues.delete(key);
    }
    return;
  }

  // Management commands: `/cwd` works in private and group chat; the rest are
  // private-chat only. All are admin-gated when admins are configured.
  const cmdMatch = trimmed.match(/^\/(cwd|ls|model|effort|reset|allow|disallow|allowlist|create-group|destroy-group|workspaces|goal|help|jobs|new|plan|compact|sandbox)\b/);

  // Unknown `/xxx` commands get a hint instead of being sent to the agent.
  if (!cmdMatch && trimmed.startsWith("/")) {
    await sendDirectReply(sender, conv, "未知命令，发送 /help 查看可用命令", api);
    release();
    if (sessionQueues.get(key) === slot) {
      sessionQueues.delete(key);
    }
    return;
  }
  if (cmdMatch) {
    try {
      const cmd = cmdMatch[1];
      // Per-command feature gate: /cwd and /ls need the workspace feature,
      // /model and /effort need the model feature; /reset needs either;
      // allowlist and workspace-lifecycle commands are always available (access-gated).
      const featureOn =
        cmd === "cwd" || cmd === "ls"
          ? config.workspace?.allowCwdCommand
          : cmd === "model" || cmd === "effort"
            ? config.model?.allowModelCommand
            : cmd === "reset"
              ? config.workspace?.allowCwdCommand || config.model?.allowModelCommand
              : true;
      if (!featureOn) {
        // Command feature disabled: tell the user instead of silently dropping.
        const flag =
          cmd === "cwd" || cmd === "ls"
            ? "workspace.allowCwdCommand"
            : cmd === "model" || cmd === "effort"
              ? "model.allowModelCommand"
              : "workspace.allowCwdCommand 或 model.allowModelCommand";
        await sendDirectReply(sender, conv, `/${cmd} 命令未启用（需配置 ${flag}）`, api);
        return;
      }

      const access = api.access;
      const senderId = String(sender);
      const convTarget = String(conv.target);

      // /help is open to every admitted user, in private and group chat; the
      // listing itself filters by the caller's permissions.
      if (cmd === "help") {
        await handleCommand(api, key, cmd, trimmed, sender, conv, isGroup);
        return;
      }

      if (cmd === "cwd" || cmd === "ls") {
        // Querying/listing is open to every admitted member; setting /cwd
        // requires the admin role or the group owner.
        const isSet = cmd === "cwd" && trimmed.replace(/^\/cwd\s*/, "").trim().length > 0;
        const canManage = isGroup
          ? (await access.canManageWorkspace(senderId, convTarget, true)) || isDshGroupCreator(api, convTarget, senderId)
          : access.canRunCommand(senderId);
        if (isSet && !canManage) {
          await sendDirectReply(sender, conv, "无权限修改本会话的工作目录（需要创建者或管理员）", api);
          return;
        }
        await handleCommand(api, key, cmd, trimmed, sender, conv, isGroup);
        return;
      }

      // Workspace lifecycle commands (create/destroy/list/reset-by-id), jobs
      // and goal management are single-chat control-panel commands, admin-gated.
      if (cmd === "create-group" || cmd === "destroy-group" || cmd === "workspaces" || cmd === "goal" || cmd === "jobs" || cmd === "new") {
        if (isGroup) {
          await sendDirectReply(sender, conv, `/${cmd} 仅支持私聊（控制面板）`, api);
          return;
        }
        if (!access.canRunCommand(senderId)) {
          await sendDirectReply(sender, conv, "无权限执行（需要管理员或机器人 owner）", api);
          return;
        }
        await handleCommand(api, key, cmd, trimmed, sender, conv, false);
        return;
      }

      if (cmd === "allow" || cmd === "disallow" || cmd === "allowlist") {
        // Allowlist management: private = admin, group = group owner / admin.
        const permitted = isGroup
          ? await access.canManageWorkspace(senderId, convTarget, true)
          : access.canRunCommand(senderId);
        if (!permitted) {
          await sendDirectReply(sender, conv, "无权限管理白名单（需要管理员或群主）", api);
          return;
        }
        await handleCommand(api, key, cmd, trimmed, sender, conv, isGroup);
        return;
      }

      // /model /effort /reset /plan /compact /sandbox: private = admin; in a DSH group = creator/admin.
      if (isGroup) {
        const canGroupManage =
          (await access.canManageWorkspace(senderId, convTarget, true)) ||
          isDshGroupCreator(api, convTarget, senderId);
        if (!canGroupManage) {
          await sendDirectReply(sender, conv, `/${cmd} 需要群创建者或管理员执行`, api);
          return;
        }
      } else if (!access.canRunCommand(senderId)) {
        await sendDirectReply(sender, conv, "无权限执行管理命令（请联系管理员）", api);
        return;
      }
      await handleCommand(api, key, cmd, trimmed, sender, conv, isGroup);
      return;
    } finally {
      release();
      if (sessionQueues.get(key) === slot) {
        sessionQueues.delete(key);
      }
    }
  }

  const streamId = `wildfire-stream-${randomUUID()}`;
  const streaming = getStreamingConfig(config);
  const logger = api.logger;
  let media: PreparedMedia | undefined;
  let transcript: string | undefined;

  // This conversation's turn is owned by the sender until the turn completes.
  turnOwners.set(key, String(sender));

  try {
    // Voice + ASR: transcribe first so the agent gets the spoken text.
    if (payloadType === MESSAGE_TYPE_VOICE && mediaUrl && config.asrServer) {
      transcript = await transcribeWithAsrServer(config.asrServer, mediaUrl, logger);
      api.logger?.info?.(
        `[wildfire] ASR transcript: len=${transcript?.length ?? 0}, preview=${safePreview(transcript ?? "")}`
      );
    }

    // Inbound media: images become content blocks; other files become path notes.
    if (mediaUrl) {
      const prepared = await prepareInboundMedia({
        mediaUrl,
        payloadType,
        downloadDir: getMediaConfig(config).downloadDir,
        attachments: api.ctx?.attachments,
        logger,
        transcript,
      });
      media = prepared;
    }

    // Immediate placeholder so the client shows a waiting state.
    try {
      await sendStreamingReply(sender, conv, streaming.initialPlaceholder, streamId, "generating", logger);
    } catch (e: any) {
      logger?.warn?.(`[wildfire] placeholder failed: ${e.message}`);
    }

    const stream = new ThrottledStream(
      async (fullText: string) => {
        if (fullText.includes("NO_REPLY")) return;
        await sendStreamingReply(sender, conv, fullText, streamId, "generating", logger);
      },
      streaming.throttleMs
    );

    let bodyText = transcript || media?.text || text;
    // File messages: keep the file name from the payload alongside the path note.
    if (payloadType === MESSAGE_TYPE_FILE && media && text && !transcript) {
      bodyText = `${text}；${media.text}`;
    }
    const outcome = await agents.dispatch(
      key,
      bodyText,
      (delta) => stream.push(delta),
      { images: media?.images },
      {
        onStatus: (state) => api.interactions?.pushStatus(key, { state }),
        onProgress: (data) => api.interactions?.pushProgress(key, data),
        onGoal: (data) => api.interactions?.sendGoal(key, data),
      }
    );
    await stream.finish();

    let finalText = outcome.text || "(no response)";
    logger.info?.(
      `[wildfire] turn finished: key=${key}, text="${finalText.slice(0, 100)}", reason=${JSON.stringify(outcome.reason)?.slice(0, 300)}, sending reply`
    );

    // Outbound media: extract [image:path] / [media:path] markers and send them.
    if (getMediaConfig(config).outboundEnabled) {
      const extracted = extractOutboundMedia(finalText);
      if (extracted.media.length > 0) {
        // Fence: only files inside the conversation workspace or the
        // configured allowedRoots may leave the machine.
        const workspaceCfg = getWorkspaceConfig(config);
        const cwd = await api.workspace.peek(key, agents.peekSessionId(key));
        const allowedDirs = [cwd, ...workspaceCfg.allowedRoots];
        await sendOutboundMedia(sender, conv, extracted.media, api, allowedDirs);
        finalText = extracted.text.trim();
      }
    }
    // Always finalize the stream: without the completed message the client
    // keeps showing the typing state forever (media-only replies included).
    await sendStreamingReply(
      sender,
      conv,
      finalText || "📎",
      streamId,
      "completed",
      logger
    );
  } catch (err: any) {
    logger?.error?.(`[wildfire] dispatch failed: ${err.message}`);
    try {
      const errorText = `Processing failed: ${err.message.slice(0, 80)}`;
      await sendStreamingReply(sender, conv, errorText, streamId, "completed", logger);
    } catch {
      // ignore secondary send errors
    }
  } finally {
    release();
    if (sessionQueues.get(key) === slot) {
      sessionQueues.delete(key);
    }
    turnOwners.delete(key);
    cleanupTemp(media?.tempPath);
  }
}

/**
 * Send agent-produced local files to Wildfire as media messages
 * (image/file by extension).
 */
async function sendOutboundMedia(
  sender: string,
  conv: { type: number; target: string; line: number },
  mediaList: Array<{ path: string; isImage: boolean }>,
  api: any,
  allowedDirs: string[]
): Promise<void> {
  const client = getClient();
  if (!client) return;

  const conversation = {
    type: conv.type,
    target: conv.type === 0 ? sender : conv.target,
    line: conv.line,
  };

  for (const item of mediaList) {
    // Resolve and enforce the allowed-directory fence before reading anything.
    const safePath = await resolveAllowedLocalPath(item.path, allowedDirs, api.logger);
    if (!safePath) continue;

    const remoteUrl = await uploadToWildfire(
      safePath,
      async (data, fileName) => {
        const result = await client.uploadFile(data, fileName, 4, "application/octet-stream");
        return result?.isSuccess?.() ? (result.getResult?.() ?? null) : null;
      },
      api.logger
    );
    if (!remoteUrl) continue;

    const fileName = safePath.split("/").pop() ?? "file";
    let payload: any;
    if (item.isImage) {
      const imageContent = new ImageMessageContent(null, remoteUrl, null);
      payload = imageContent.encode();
    } else {
      let fileSize = 0;
      try {
        fileSize = (await stat(safePath)).size;
      } catch {
        // keep 0 when the size cannot be read
      }
      const fileContent = new FileMessageContent(null, remoteUrl, fileName, fileSize);
      payload = fileContent.encode();
    }
    const result = await client.sendMessage(conversation, payload);
    api.logger?.info?.(
      `[wildfire] outbound media sent: ${fileName}, success=${result?.isSuccess?.()}`
    );
  }
}

/**
 * Transcribe a voice message via the ASR server (SSE or plain text).
 * Same contract as the openclaw plugin.
 */
async function transcribeWithAsrServer(
  asrServer: string,
  mediaUrl: string,
  logger?: any
): Promise<string | undefined> {
  try {
    const res = await fetch(asrServer, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify({ url: mediaUrl, noReuse: false, noLlm: false }),
    });
    if (!res.ok) {
      logger?.warn?.(`[wildfire] ASR request failed: status=${res.status}`);
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
        result += trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
      }
    }
    if (pending.trim()) {
      const tail = pending.trim();
      result += tail.startsWith("data:") ? tail.slice(5).trim() : tail;
    }
    const cleaned = result.trim();
    return cleaned || undefined;
  } catch (e: any) {
    logger?.warn?.(`[wildfire] ASR request error: ${e.message}`);
    return undefined;
  }
}


/** Whether the sender is the creator (manager) of a DSH workspace group. */
function isDshGroupCreator(api: any, groupId: string, senderId: string): boolean {
  return api.registry?.get?.(groupId)?.creatorUserId === senderId;
}

/**
 * Dispatch a management command (`/help`, `/cwd`, `/model`, `/effort`, `/reset`,
 * `/plan`, `/compact`, `/sandbox`, `/allow`, `/disallow`, `/allowlist`,
 * `/create-group`, `/destroy-group`, `/workspaces`, `/goal`, `/jobs`, `/new`).
 * Callers must have already checked the feature gate and permissions.
 */
async function handleCommand(
  api: any,
  key: string,
  cmd: string,
  text: string,
  sender: string,
  conv: { type: number; target: string; line: number },
  isGroup: boolean
): Promise<void> {
  const arg = text.replace(/^\/(cwd|ls|model|effort|reset|allow|disallow|allowlist|create-group|destroy-group|workspaces|goal|help|jobs|new|plan|compact|sandbox)\s*/, "").trim();
  switch (cmd) {
    case "help":
      await handleHelpCommand(api, sender, conv, isGroup);
      return;
    case "cwd":
      await handleCwdCommand(api, key, arg, sender, conv, isGroup);
      return;
    case "ls":
      await handleListCommand(api, key, arg, sender, conv, isGroup);
      return;
    case "model":
      await handleModelCommand(api, key, arg, sender, conv);
      return;
    case "effort":
      await handleEffortCommand(api, key, arg, sender, conv);
      return;
    case "plan":
      await handlePlanCommand(api, key, arg, sender, conv);
      return;
    case "compact":
      await handleCompactCommand(api, key, sender, conv);
      return;
    case "sandbox":
      await handleSandboxCommand(api, key, arg, sender, conv);
      return;
    case "reset":
      await api.wildfireAgents.resetSession(key);
      await sendDirectReply(sender, conv, "会话已重置（上下文清空）", api);
      return;
    case "create-group":
      await handleCreateGroupCommand(api, arg, sender, conv);
      return;
    case "destroy-group":
      await handleDestroyGroupCommand(api, arg, sender, conv);
      return;
    case "workspaces":
      await handleWorkspacesCommand(api, sender, conv);
      return;
    case "goal":
      await handleGoalCommand(api, arg, sender, conv);
      return;
    case "jobs":
      await handleJobsCommand(api, sender, conv);
      return;
    case "new":
      await handleNewCommand(api, arg, sender, conv);
      return;
    case "allow":
      await handleAllowCommand(api, arg, sender, conv, true);
      return;
    case "disallow":
      await handleAllowCommand(api, arg, sender, conv, false);
      return;
    case "allowlist": {
      const whitelist: WhitelistFilter | undefined = api.whitelist;
      const wl = getWhitelistConfig(api.config);
      const dynamic = whitelist?.listExtraUsers() ?? [];
      const ownerLine = whitelist && wl.includeOwner && api.robotOwner ? `owner: ${api.robotOwner}` : "";
      const lines = [
        `白名单已${wl.enabled ? "启用" : "禁用"}`,
        ownerLine,
        `静态用户: ${wl.allowedUsers.join(", ") || "无"}`,
        `动态用户: ${dynamic.join(", ") || "无"}`,
        `允许群组: ${wl.allowedGroups.join(", ") || "无"}`,
      ].filter(Boolean);
      await sendDirectReply(sender, conv, lines.join("\n"), api);
      return;
    }
  }
}

/**
 * `/help` — list the commands the caller is actually allowed to run
 * (private + group; open to every admitted user).
 */
async function handleHelpCommand(
  api: any,
  sender: string,
  conv: { type: number; target: string; line: number },
  isGroup: boolean
): Promise<void> {
  const config: WildfireConfig = api.config;
  const senderId = String(sender);
  const isAdmin = api.access?.canRunCommand(senderId) ?? false;
  const canManage = isGroup
    ? (await api.access?.canManageWorkspace(senderId, String(conv.target), true)) ||
      isDshGroupCreator(api, String(conv.target), senderId)
    : isAdmin;

  const lines = [
    "/help — 查看可用命令",
    "/stop — 停止当前会话正在运行的任务",
  ];
  if (config.workspace?.allowCwdCommand) {
    lines.push("/cwd [目录|clear] — 查看/切换工作目录（相对路径按项目根目录解析；目录不存在时询问创建；切换需创建者或管理员）");
    lines.push("/ls [子目录] — 列出项目根目录内容（相对路径按根目录解析）");
  }
  if (canManage) {
    if (config.model?.allowModelCommand) {
      lines.push("/model [provider/模型|预设] — 查看/切换模型（保留推理等级）");
      lines.push("/effort [等级] — 查看/设置推理等级");
    }
    lines.push("/plan [on|off] — 查看/开关计划模式");
    lines.push("/compact — 压缩会话上下文");
    lines.push("/sandbox [模式] — 查看/切换沙箱权限模式");
    if (config.workspace?.allowCwdCommand || config.model?.allowModelCommand) {
      lines.push("/reset — 重置本会话（上下文清空）");
    }
    lines.push("/allow|/disallow <userId>、/allowlist — 白名单管理");
  }
  if (!isGroup && isAdmin) {
    lines.push("/create-group [工作区] — 创建 DSH 工作区群");
    lines.push("/destroy-group <groupId> — 销毁工作区群（删除目录）");
    lines.push("/new <groupId> — 重置指定群的会话");
    lines.push("/workspaces — 列出所有 DSH 工作区群");
    lines.push("/goal <groupId> [pause|resume|目标描述] — 查看/创建/暂停/恢复目标");
    lines.push("/jobs — 查看后台任务");
  }
  await sendDirectReply(sender, conv, `可用命令：\n${lines.join("\n")}`, api);
}

/**
 * `/stop` — cancel the conversation's running agent turn (private + group;
 * any admitted session member). Pending cards are expired and the runtime
 * state goes back to idle; the in-flight streaming reply is finalized by the
 * dispatch path itself when the cancelled turn ends.
 */
async function handleStopCommand(
  api: any,
  key: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  const agents = api.ctx?.get?.("agents");
  const agent = agents?.get?.(api.wildfireAgents.peekSessionId(key));
  if (!agent || agent.status !== "running") {
    await sendDirectReply(sender, conv, "当前没有正在运行的任务", api);
    return;
  }
  try {
    agent.cancel({ kind: "user" });
  } catch (err: any) {
    await sendDirectReply(sender, conv, `停止失败: ${err?.message ?? String(err)}`, api);
    return;
  }
  const expired = api.interactions?.expirePending(key) ?? 0;
  api.interactions?.pushStatus(key, { state: "idle" });
  api.logger?.info?.(`[wildfire] /stop: key=${key}, by=${sender}, expiredCards=${expired}`);
  await sendDirectReply(
    sender,
    conv,
    `⏹ 已停止当前任务${expired > 0 ? `，${expired} 张待处理卡片已过期` : ""}`,
    api
  );
}

/**
 * `/jobs` — list background jobs across ALL live sessions (single-chat
 * control panel, admin-gated). Jobs are owned by the workspace agents of the
 * group sessions, so every live agent is queried and the results merged
 * (unowned jobs appear in every agent's list — deduped by id). Each line is
 * annotated with the owning conversation (group id / private user id).
 */
async function handleJobsCommand(
  api: any,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  let jobs: any;
  try {
    jobs = api.ctx?.get?.("jobs");
  } catch {
    jobs = undefined;
  }
  if (!jobs) {
    await sendDirectReply(sender, conv, "jobs 服务不可用（当前 profile 未加载后台任务服务）", api);
    return;
  }
  try {
    const statusText: Record<string, string> = {
      running: "运行中",
      stopping: "停止中",
      completed: "已完成",
      killed: "已终止",
      failed: "失败",
    };
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const { key: sessionKey, agent } of api.wildfireAgents.listLiveAgents()) {
      let list: any[];
      try {
        list = jobs.list(agent) ?? [];
      } catch (err: any) {
        api.logger?.warn?.(`[wildfire] /jobs list failed for ${sessionKey}: ${err?.message ?? String(err)}`);
        continue;
      }
      const where = sessionKey.startsWith("wildfire:group:")
        ? `群 ${sessionKey.slice("wildfire:group:".length)}`
        : sessionKey.startsWith("wildfire:user:")
          ? `私聊 ${sessionKey.slice("wildfire:user:".length)}`
          : sessionKey;
      for (const job of list) {
        if (seen.has(String(job.id))) continue; // unowned jobs repeat per caller
        seen.add(String(job.id));
        lines.push(
          `${job.id} | ${job.kind} | ${statusText[job.status] ?? job.status} | ${job.label ?? ""} | ${where}`
        );
      }
    }
    if (lines.length === 0) {
      await sendDirectReply(sender, conv, "当前没有后台任务", api);
      return;
    }
    await sendDirectReply(sender, conv, `📋 后台任务（${lines.length}）:\n${lines.join("\n")}`, api);
  } catch (err: any) {
    await sendDirectReply(sender, conv, `查询后台任务失败: ${err?.message ?? String(err)}`, api);
  }
}

/**
 * `/new <groupId>` — reset the agent session of a DSH workspace group from
 * the control panel (same effect as an in-group `/reset`: epoch++ rebuild;
 * the workspace directory is kept).
 */
async function handleNewCommand(
  api: any,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  const groupId = arg.trim();
  if (!groupId) {
    await sendDirectReply(sender, conv, "用法: /new <groupId>", api);
    return;
  }
  if (!api.registry?.isDshGroup?.(groupId)) {
    await sendDirectReply(sender, conv, `非 DSH 工作区群: ${groupId}`, api);
    return;
  }
  await api.wildfireAgents.resetSession(`wildfire:group:${groupId}`);
  await sendDirectReply(sender, conv, `🔄 群 ${groupId} 的会话已重置（上下文清空，工作区保留）`, api);
}

/**
 * `/plan [on|off]` — read or switch the conversation's plan mode
 * (`ctx.planMode`, dsh-plan-mode). No arg = query; on/off = select. While the
 * plan is being executed, leaving plan mode goes through the exit_plan_mode
 * tool whose plan-review question arrives via the userQuestions seam.
 */
async function handlePlanCommand(
  api: any,
  key: string,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  let planMode: any;
  try {
    planMode = api.ctx?.get?.("planMode");
  } catch {
    planMode = undefined;
  }
  if (!planMode) {
    await sendDirectReply(sender, conv, "plan 服务不可用（当前 profile 未加载 plan-mode）", api);
    return;
  }
  const agents = api.ctx?.get?.("agents");
  const agent = agents?.get?.(api.wildfireAgents.peekSessionId(key));
  if (!agent) {
    await sendDirectReply(sender, conv, "会话未激活（请先发送一条消息）", api);
    return;
  }
  try {
    if (!arg) {
      const current = planMode.get(agent);
      const pending = current.pending !== undefined ? `，待生效: ${current.pending ? "开启" : "关闭"}` : "";
      await sendDirectReply(
        sender,
        conv,
        `当前计划模式: ${current.active ? "已开启" : "已关闭"}${pending}\n用法: /plan on|off`,
        api
      );
      return;
    }
    const on = arg === "on" || arg === "开";
    const off = arg === "off" || arg === "关";
    if (!on && !off) {
      await sendDirectReply(sender, conv, "用法: /plan on|off", api);
      return;
    }
    const result = planMode.set(agent, on);
    const target = on ? "开启" : "关闭";
    const text =
      result === "committed"
        ? `计划模式已${target}`
        : result === "queued"
          ? `计划模式将${target}（当前任务进行中，下一步生效）`
          : result === "cancelled"
            ? `已取消待生效的切换，计划模式保持${on ? "关闭" : "开启"}`
            : `计划模式已经是${on ? "开启" : "关闭"}状态`;
    await sendDirectReply(sender, conv, text, api);
  } catch (err: any) {
    await sendDirectReply(sender, conv, `计划模式操作失败: ${err?.message ?? String(err)}`, api);
  }
}

/**
 * `/compact` — manually compact the conversation's context
 * (`ctx.compaction.compactNow`, dsh-compaction). Replies with the shadowed
 * node/token counts; a busy agent (running turn) is reported as such.
 */
async function handleCompactCommand(
  api: any,
  key: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  let compaction: any;
  try {
    compaction = api.ctx?.get?.("compaction");
  } catch {
    compaction = undefined;
  }
  if (!compaction) {
    await sendDirectReply(sender, conv, "compaction 服务不可用（当前 profile 未加载压缩服务）", api);
    return;
  }
  const agents = api.ctx?.get?.("agents");
  const agent = agents?.get?.(api.wildfireAgents.peekSessionId(key));
  if (!agent) {
    await sendDirectReply(sender, conv, "会话未激活（请先发送一条消息）", api);
    return;
  }
  try {
    const result = await compaction.compactNow(agent, new AbortController().signal);
    if (!result) {
      await sendDirectReply(sender, conv, "当前没有可压缩的历史内容", api);
      return;
    }
    await sendDirectReply(
      sender,
      conv,
      `✅ 上下文已压缩：折叠 ${result.shadowedSeqs?.length ?? 0} 个节点（约 ${result.shadowedTokenCount ?? 0} tokens）`,
      api
    );
  } catch (err: any) {
    if (err?.code === "busy") {
      await sendDirectReply(sender, conv, "当前会话正在运行任务，请稍后再试（或先 /stop）", api);
      return;
    }
    await sendDirectReply(sender, conv, `压缩失败: ${err?.message ?? String(err)}`, api);
  }
}

/** Human labels for the sandbox modes (`SANDBOX_MODES`). */
const SANDBOX_MODE_LABELS: Record<string, string> = {
  "read-only": "只读",
  "workspace-write": "仅写工作区",
  "danger-full-access": "完全放开",
};

/**
 * `/sandbox [mode]` — read or switch the conversation's sandbox permission
 * mode (`ctx.sandboxPolicy`, dsh-sandbox-policy). The override is one
 * `sandbox/mode` event on the session log: it takes effect on the next
 * confined call (bash/fs) and survives resume.
 */
async function handleSandboxCommand(
  api: any,
  key: string,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  let policy: any;
  try {
    policy = api.ctx?.get?.("sandboxPolicy");
  } catch {
    policy = undefined;
  }
  if (!policy) {
    await sendDirectReply(sender, conv, "sandbox 服务不可用（当前 profile 未加载 sandbox-policy）", api);
    return;
  }
  const modeLabel = (m: string) => `${m}（${SANDBOX_MODE_LABELS[m] ?? m}）`;
  const modeList = SANDBOX_MODES.map(modeLabel).join(" / ");

  const agents = api.ctx?.get?.("agents");
  const agent = agents?.get?.(api.wildfireAgents.peekSessionId(key));
  const session = agent?.session;

  if (!arg) {
    if (!session) {
      await sendDirectReply(
        sender,
        conv,
        `当前沙箱模式: ${modeLabel(policy.defaultMode)}（部署默认；会话激活后可按会话覆盖）\n可选: ${modeList}`,
        api
      );
      return;
    }
    const override = policy.overrideOf(session);
    const effective = override ?? policy.defaultMode;
    await sendDirectReply(
      sender,
      conv,
      `当前沙箱模式: ${modeLabel(effective)}（${override ? "会话覆盖" : "部署默认"}）\n可选: ${modeList}\n用法: /sandbox <mode>`,
      api
    );
    return;
  }

  if (!SANDBOX_MODES.includes(arg)) {
    await sendDirectReply(sender, conv, `无效沙箱模式: ${arg}\n可选: ${modeList}`, api);
    return;
  }
  if (!session) {
    await sendDirectReply(sender, conv, "会话未激活（请先发送一条消息激活会话）", api);
    return;
  }
  try {
    setSandboxMode(session, arg);
  } catch (err: any) {
    await sendDirectReply(sender, conv, `沙箱模式切换失败: ${err?.message ?? String(err)}`, api);
    return;
  }
  api.logger?.info?.(`[wildfire] /sandbox: key=${key}, mode=${arg}, by=${sender}`);
  await sendDirectReply(
    sender,
    conv,
    `沙箱模式已切换为 ${modeLabel(arg)}，下一次工具调用生效（随会话持久化）`,
    api
  );
}

/**
 * `/allow <userId>` / `/disallow <userId>` — manage the dynamic whitelist.
 */
async function handleAllowCommand(
  api: any,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number },
  allow: boolean
): Promise<void> {
  const whitelist: WhitelistFilter | undefined = api.whitelist;
  if (!whitelist) {
    await sendDirectReply(sender, conv, "白名单组件不可用", api);
    return;
  }
  if (!arg) {
    await sendDirectReply(sender, conv, `用法: /${allow ? "allow" : "disallow"} <userId>`, api);
    return;
  }
  if (allow) {
    whitelist.addUser(arg);
    await sendDirectReply(sender, conv, `已将 ${arg} 加入白名单`, api);
  } else {
    whitelist.removeUser(arg);
    await sendDirectReply(sender, conv, `已将 ${arg} 移出白名单`, api);
  }
}

/**
 * `/create-group [工作区]` — create a DSH workspace group via the robot
 * (single-chat control panel, admin-gated). Workspace selection (4.1.3):
 *   /create-group            → catalog list if configured, else auto
 *   /create-group <编号>     → pick catalog entry
 *   /create-group auto       → auto-assign <autoRoot>/<workspaceId>
 *   /create-group <路径>     → explicit path (allowedRoots validated)
 */
async function handleCreateGroupCommand(
  api: any,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  const client = getClient();
  if (!client) {
    await sendDirectReply(sender, conv, "机器人未连接", api);
    return;
  }
  const config: WildfireConfig = api.config;
  const workspaceCfg = getWorkspaceConfig(config);
  const catalog = workspaceCfg.catalog ?? [];

  // 1. resolve the workspace directory choice
  let dir: string | null = null;
  let dirLabel = "自动分配";
  if (arg) {
    const num = Number(arg);
    if (!Number.isNaN(num) && catalog[num - 1]) {
      dir = catalog[num - 1].path;
      dirLabel = `catalog:${catalog[num - 1].id}`;
    } else if (arg === "auto") {
      // auto — resolved after the group exists (id derives from groupId)
    } else {
      const canon = await api.workspace.validateUserPath(arg);
      if (!canon) {
        await sendDirectReply(sender, conv, "无效目录，或不在允许的工作目录范围内", api);
        return;
      }
      dir = canon;
      dirLabel = "显式路径";
    }
  } else if (catalog.length > 0) {
    // no arg + catalog configured → list for selection
    const lines = catalog.map((c: any, i: number) => `${i + 1}. ${c.label ?? c.id}（${c.path}）`);
    await sendDirectReply(
      sender,
      conv,
      `请选择工作区目录（回复编号），或 /create-group auto 自动分配：\n${lines.join("\n")}`,
      api
    );
    return;
  }
  if (arg && !Number.isNaN(Number(arg)) && catalog.length === 0) {
    await sendDirectReply(sender, conv, "未配置可选工作区目录（workspace.catalog）", api);
    return;
  }

  // 2. create the group (owner is the robot; members = creator + robot)
  const groupName = arg && !Number.isNaN(Number(arg)) && catalog[Number(arg) - 1]
    ? `DSH-${catalog[Number(arg) - 1].label ?? catalog[Number(arg) - 1].id}`
    : `DSH-工作区`;
  const groupInfo = {
    name: groupName,
    portrait: "",
    extra: JSON.stringify({ dsh: true }),
    // 仅成员邀请（Wildfire JoinType: 0=开放, 1=验证, 2=仅成员邀请）——INTERACTION_DESIGN §4.1.1
    join_type: 2,
  };
  const members = [
    { member_id: sender, type: 0 },
    { member_id: String(config.robotId), type: 0 },
  ];
  const result = await client.createGroup(groupInfo, members, sender, [0], null);
  const groupId = result?.result?.group_id;
  if (result?.code !== 0 || !groupId) {
    await sendDirectReply(sender, conv, `创建群失败: ${result?.msg ?? "unknown"}`, api);
    return;
  }

  // 3. resolve auto directory now that the group id exists
  if (!dir) {
    const wsId = sessionIdForConversation(`wildfire:group:${groupId}`, 0).slice("wildfire-".length);
    const root = api.workspace.root(); // 项目根目录（root → autoRoot → 第一个 allowedRoot → path）
    dir = pathJoin(root, wsId);
    dirLabel = "自动分配";
  }
  await api.workspace.resolve(`wildfire:group:${groupId}`, sessionIdForConversation(`wildfire:group:${groupId}`, 0));

  // 4. register and reply
  api.registry?.register(groupId, String(sender), dir);
  api.logger?.info?.(
    `[wildfire] /create-group done: group=${groupId}, creator=${sender}, dir=${dir} (${dirLabel})`
  );
  await sendDirectReply(
    sender,
    conv,
    `✅ 工作区群已创建：\n群ID: ${groupId}\n工作区: ${dir}（${dirLabel}）\n\n请搜索群 ID 加入，进群后发第一条消息即激活`,
    api
  );
}

/**
 * `/destroy-group <groupId>` — dismiss the group and destroy its workspace
 * (single-chat control panel, admin-gated; see INTERACTION_DESIGN.md §4.1.4).
 */
async function handleDestroyGroupCommand(
  api: any,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  const client = getClient();
  const groupId = arg.trim();
  if (!client || !groupId) {
    await sendDirectReply(sender, conv, "用法: /destroy-group <groupId>", api);
    return;
  }
  const record = api.registry?.get(groupId);
  if (!record) {
    await sendDirectReply(sender, conv, `非 DSH 工作区群: ${groupId}`, api);
    return;
  }

  // dismiss the group (members lose access)
  const dismissResult = await client.dismissGroup(groupId);
  if (dismissResult?.code !== 0) {
    api.logger?.warn?.(`[wildfire] dismissGroup failed: ${dismissResult?.msg}`);
  }

  // dispose agent session + remove memory
  await api.wildfireAgents.disposeWorkspace(`wildfire:group:${groupId}`);

  // delete the workspace directory
  if (record.workspaceDir) {
    await rm(record.workspaceDir, { recursive: true, force: true }).catch((err: unknown) =>
      api.logger?.warn?.(`[wildfire] failed to remove workspace dir: ${String(err)}`)
    );
  }

  api.registry?.unregister(groupId);
  await sendDirectReply(sender, conv, `🗑 工作区群已销毁: ${groupId}（目录已删除）`, api);
}

/**
 * `/workspaces` — list all DSH workspace groups (single-chat control panel).
 */
async function handleWorkspacesCommand(
  api: any,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  const list = api.registry?.list() ?? [];
  if (list.length === 0) {
    await sendDirectReply(sender, conv, "暂无 DSH 工作区群。用 /create-group 创建", api);
    return;
  }
  const lines = list.map(({ groupId, record }: { groupId: string; record: any }) => {
    const creator = record.creatorUserId === sender ? "（我创建）" : "";
    return `${groupId} | 创建者: ${record.creatorUserId}${creator}\n  目录: ${record.workspaceDir}`;
  });
  await sendDirectReply(sender, conv, `📋 DSH 工作区群（${list.length}）:\n${lines.join("\n")}`, api);
}

/**
 * Handle group notification messages (104-125) before any dispatch.
 * 108 DismissGroup → destroy the workspace; 105 AddGroupMember and others are
 * reflected by the IM group membership (no plugin action).
 */
/**
 * `/goal <groupId> [pause|resume|objective]` — view, create, pause or resume
 * the goal of a workspace group (single-chat control panel). Replies with a
 * DSH_Goal card.
 */
async function handleGoalCommand(
  api: any,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  const parts = arg.split(/\s+/).filter(Boolean);
  const groupId = parts[0];
  const sub = parts[1];
  const objective = parts.slice(1).join(" ");
  if (!groupId) {
    await sendDirectReply(
      sender,
      conv,
      "用法: /goal <groupId> [pause|resume|目标描述]\n  无子命令 = 查看当前目标",
      api
    );
    return;
  }
  const key = `wildfire:group:${groupId}`;
  if (!api.registry?.isDshGroup?.(groupId)) {
    await sendDirectReply(sender, conv, `非 DSH 工作区群: ${groupId}`, api);
    return;
  }
  const agents = api.ctx?.get?.("agents");
  const goals = api.ctx?.get?.("goals");
  if (!agents || !goals) {
    await sendDirectReply(sender, conv, "goals 服务不可用", api);
    return;
  }
  const sessionId = api.wildfireAgents.peekSessionId(key);
  const agent = agents.get(sessionId);
  if (!agent) {
    await sendDirectReply(sender, conv, "该群会话未激活（请先在群里发消息）", api);
    return;
  }
  try {
    if (sub === "pause" || sub === "resume") {
      const current = goals.get(agent);
      if (!current) {
        await sendDirectReply(sender, conv, "该群暂无目标", api);
        return;
      }
      if (sub === "pause") {
        if (current.phase !== "active") {
          await sendDirectReply(sender, conv, `目标当前状态为 ${current.phase}，仅进行中的目标可暂停`, api);
          return;
        }
        const updated = goals.pause(agent, current);
        api.interactions?.sendGoal(key, {
          gid: updated.id,
          objective: updated.objective,
          phase: updated.phase,
          roundsStarted: updated.roundsStarted,
        });
        await sendDirectReply(sender, conv, `⏸ 目标已暂停: ${updated.objective}`, api);
      } else {
        if (current.phase === "active") {
          await sendDirectReply(sender, conv, "目标已在运行中", api);
          return;
        }
        if (current.phase === "complete") {
          await sendDirectReply(sender, conv, "目标已完成，无法恢复（可创建新目标）", api);
          return;
        }
        const updated = goals.resume(agent, current);
        api.interactions?.sendGoal(key, {
          gid: updated.id,
          objective: updated.objective,
          phase: updated.phase,
          roundsStarted: updated.roundsStarted,
        });
        await sendDirectReply(sender, conv, `▶️ 目标已恢复: ${updated.objective}`, api);
      }
      return;
    }
    if (objective) {
      const existing = goals.get(agent);
      if (existing && existing.phase !== "complete") {
        await sendDirectReply(sender, conv, `该群已有进行中的目标（${existing.phase}），先完成后才能新建`, api);
        return;
      }
      await goals.create(agent, { objective });
    }
    const view = goals.get(agent);
    if (!view) {
      await sendDirectReply(sender, conv, "该群暂无目标。用法: /goal <groupId> <目标描述>", api);
      return;
    }
    api.interactions?.sendGoal(key, {
      gid: view.id,
      objective: view.objective,
      phase: view.phase,
      roundsStarted: view.roundsStarted,
    });
  } catch (err: any) {
    await sendDirectReply(sender, conv, `目标操作失败: ${err?.message ?? String(err)}`, api);
  }
}

async function handleGroupNotification(
  api: any,
  payloadType: number,
  conv: { type: number; target: string; line: number },
  key: string
): Promise<void> {
  if (payloadType !== 108) {
    api.logger?.debug?.(`[wildfire] group notification type=${payloadType} ignored, group=${conv.target}`);
    return;
  }
  const groupId = String(conv.target);
  const record = api.registry?.get(groupId);
  if (!record) {
    api.logger?.debug?.(`[wildfire] dismiss notification for non-DSH group: ${groupId}`);
    return;
  }
  api.logger?.info?.(`[wildfire] group dismissed, destroying workspace: ${groupId}`);
  await api.wildfireAgents.disposeWorkspace(key);
  if (record.workspaceDir) {
    await rm(record.workspaceDir, { recursive: true, force: true }).catch((err: unknown) =>
      api.logger?.warn?.(`[wildfire] failed to remove workspace dir: ${String(err)}`)
    );
  }
  api.registry?.unregister(groupId);
}

/**
 * `/cwd` command:
 * - `/cwd`            -> reply with the conversation's current workspace
 * - `/cwd <path>`     -> bind the workspace to this conversation (persisted);
 *                        relative paths resolve under the project root
 *                        (`workspace.root`); when the directory does not
 *                        exist, a confirmation card asks: create / cancel
 *                        (or type a new path as the custom answer)
 * - `/cwd clear`      -> drop the binding, back to the configured default
 */
async function handleCwdCommand(
  api: any,
  key: string,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number },
  isGroup: boolean
): Promise<void> {
  const workspace = api.workspace;
  const agents: AgentSessionManager = api.wildfireAgents;
  const sessionId = agents.peekSessionId(key);
  const label = isGroup ? `群 ${conv.target}` : `会话 ${key}`;

  if (!arg) {
    try {
      const dir = await workspace.peek(key, sessionId);
      const lines = [`${label} 当前工作目录: ${dir}`, `项目根目录: ${workspace.root()}`, `相对路径按根目录解析，如 /cwd my-project；/ls 可浏览根目录内容`];
      await sendDirectReply(sender, conv, lines.join("\n"), api);
    } catch (e: any) {
      await sendDirectReply(sender, conv, `获取工作目录失败: ${e.message}`, api);
    }
    return;
  }

  if (arg === "clear") {
    workspace.clearOverride(key);
    await agents.resetSession(key);
    api.logger?.info?.(`[wildfire] /cwd cleared: key=${key}`);
    await sendDirectReply(sender, conv, "已清除自定义工作目录，恢复默认配置（会话已重置）", api);
    return;
  }

  await bindWorkspacePath(api, key, arg, sender, conv, label, 0);
}

/**
 * Bind a workspace path for a conversation (`/cwd <path>` internals), with the
 * create-or-reselect confirmation loop:
 * - path exists & is a directory  -> bind directly (realpath), reset session
 * - path exists & is a file       -> error
 * - path missing                  -> DSH_Question card: [✅ 创建] [❌ 取消],
 *   custom text answer = a new path (re-enters the flow, depth-guarded)
 * Permission checks happen in the caller (handleCwdCommand routing).
 */
async function bindWorkspacePath(
  api: any,
  key: string,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number },
  label: string,
  depth: number
): Promise<void> {
  const workspace = api.workspace;
  const agents: AgentSessionManager = api.wildfireAgents;
  const MAX_DEPTH = 3;

  const info = await workspace.resolveUserPath(arg);
  if (!info) {
    await sendDirectReply(sender, conv, "无效路径，或不在允许的工作目录范围内（allowedRoots）", api);
    return;
  }

  if (info.exists && info.isDir) {
    let canon = info.resolved;
    try {
      canon = await realpath(info.resolved);
    } catch {
      // keep the normalized path when realpath fails (shouldn't happen for an existing dir)
    }
    workspace.setOverride(key, canon);
    await agents.resetSession(key);
    api.logger?.info?.(`[wildfire] /cwd bound: key=${key} -> ${canon}`);
    await sendDirectReply(sender, conv, `${label} 工作目录已绑定: ${canon}（已持久化，会话上下文已重置）`, api);
    return;
  }

  if (info.exists && !info.isDir) {
    await sendDirectReply(sender, conv, `已存在同名文件（非目录），无法绑定: ${info.resolved}`, api);
    return;
  }

  // Directory does not exist yet: ask create / cancel / type a new path.
  if (depth >= MAX_DEPTH) {
    await sendDirectReply(sender, conv, `目录不存在且确认次数过多，已取消: ${info.resolved}`, api);
    return;
  }
  api.logger?.info?.(`[wildfire] /cwd create-confirm: key=${key}, target=${info.resolved}, by=${sender}, depth=${depth}`);
  const answer = await api.interactions?.askDirect?.(
    key,
    [
      {
        id: "cwd-create",
        question: `目录不存在：\n${info.resolved}\n\n是否创建？`,
        header: "工作目录",
        options: [{ label: "✅ 创建" }, { label: "❌ 取消" }],
        multiSelect: false,
      },
    ],
    { ownerSender: String(sender), timeoutMs: 60_000 }
  );
  if (!answer) {
    await sendDirectReply(sender, conv, `已取消绑定（目录未创建）: ${info.resolved}`, api);
    return;
  }
  const first = answer.answers?.[0];
  const selected = (first?.selected ?? [])[0] ?? "";
  const custom = (first?.custom ?? "").trim();
  if (selected === "✅ 创建") {
    try {
      await mkdir(info.resolved, { recursive: true });
    } catch (err: any) {
      await sendDirectReply(sender, conv, `创建目录失败: ${err?.message ?? String(err)}`, api);
      return;
    }
    workspace.setOverride(key, info.resolved);
    await agents.resetSession(key);
    api.logger?.info?.(`[wildfire] /cwd created+bound: key=${key} -> ${info.resolved}`);
    await sendDirectReply(sender, conv, `${label} 目录已创建并绑定: ${info.resolved}（已持久化，会话上下文已重置）`, api);
    return;
  }
  if (selected === "❌ 取消") {
    await sendDirectReply(sender, conv, `已取消绑定（目录未创建）: ${info.resolved}`, api);
    return;
  }
  if (custom) {
    // 自定义回答 = 新的路径：重新进入绑定流程（深度保护）
    await sendDirectReply(sender, conv, `重新选择: ${custom}`, api);
    await bindWorkspacePath(api, key, custom, sender, conv, label, depth + 1);
    return;
  }
  await sendDirectReply(sender, conv, `未识别选择，已取消: ${info.resolved}`, api);
}

/** Human-readable file size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `/ls [path]` — list the project root (`workspace.root`) or a subdirectory.
 * Relative paths resolve under the root; missing paths show an error.
 * Open to every admitted member (read-only browse).
 */
async function handleListCommand(
  api: any,
  _key: string,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number },
  _isGroup: boolean
): Promise<void> {
  const workspace = api.workspace;
  const root = workspace.root();
  const info = arg ? await workspace.resolveUserPath(arg) : { resolved: root, exists: true, isDir: true };
  if (!info || !info.exists) {
    await sendDirectReply(sender, conv, `目录不存在: ${arg ? info?.resolved : root}（可用 /cwd <路径> 创建）`, api);
    return;
  }
  if (!info.isDir) {
    try {
      const st = await stat(info.resolved);
      await sendDirectReply(sender, conv, `📄 ${path.basename(info.resolved)}  (${formatSize(st.size)})`, api);
    } catch {
      await sendDirectReply(sender, conv, `文件: ${info.resolved}`, api);
    }
    return;
  }
  try {
    const entries = await readdir(info.resolved, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    const lines = [`📁 ${info.resolved === root ? "项目根目录" : info.resolved}（共 ${entries.length} 项）`];
    if (dirs.length > 0) lines.push(...dirs.map((d) => `  📂 ${d}/`));
    if (files.length > 0) lines.push(...files.map((f) => `  📄 ${f}`));
    if (entries.length === 0) lines.push("  （空目录）");
    lines.push(`用法: /ls [子目录]（相对路径按项目根目录解析）`);
    await sendDirectReply(sender, conv, lines.join("\n"), api);
  } catch (err: any) {
    await sendDirectReply(sender, conv, `列出目录失败: ${err?.message ?? String(err)}`, api);
  }
}

/**
 * `/model` command:
 * - `/model`                        -> show current selection + the DSH runtime
 *                                      model catalog (same source as the web UI
 *                                      selector), plus presets when configured
 * - `/model <provider/model|id>`    -> switch model via the runtime catalog
 *                                      (keeps the current reasoning effort)
 * - `/model <preset>`               -> backward-compatible preset shortcut
 * Switching is live: the next message takes effect, context is preserved.
 */
async function handleModelCommand(
  api: any,
  key: string,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  const selector = api.models;
  if (!arg) {
    try {
      const current = await selector.peek(key);
      const lines = [
        `当前模型: ${current.provider}/${current.model}${current.reasoningEffort ? ` (推理等级=${current.reasoningEffort})` : ""}`,
      ];
      const catalog = await selector.listCatalog();
      if (catalog.length > 0) {
        const byProvider = new Map<string, Array<{ id: string; name: string }>>();
        for (const entry of catalog) {
          const group = byProvider.get(entry.provider) ?? [];
          group.push({ id: entry.id, name: entry.name });
          byProvider.set(entry.provider, group);
        }
        lines.push("可用模型（运行时目录）:");
        for (const [provider, models] of byProvider) {
          lines.push(`  ${provider}:`);
          for (const model of models) {
            lines.push(`    ${provider}/${model.id}（${model.name}）`);
          }
        }
      }
      const presets = selector.listPresets();
      if (presets.length > 0) {
        lines.push(`预设快捷方式:\n${presets.join("\n")}`);
      }
      await sendDirectReply(sender, conv, lines.join("\n"), api);
    } catch (e: any) {
      await sendDirectReply(sender, conv, `获取模型信息失败: ${e.message}`, api);
    }
    return;
  }

  // Match the runtime catalog first: `provider/model` or a bare model id
  // (a bare id matching multiple providers needs disambiguation).
  const catalog: Array<{ provider: string; id: string; name: string }> = await selector.listCatalog();
  let match: { provider: string; id: string; name: string } | undefined;
  const slashIdx = arg.indexOf("/");
  if (slashIdx > 0) {
    const provider = arg.slice(0, slashIdx);
    const modelId = arg.slice(slashIdx + 1);
    match = catalog.find((e) => e.provider === provider && e.id === modelId);
  } else {
    const candidates = catalog.filter((e) => e.id === arg);
    if (candidates.length > 1) {
      await sendDirectReply(
        sender,
        conv,
        `模型 "${arg}" 存在于多个 provider，请指明: ${candidates.map((e) => `${e.provider}/${e.id}`).join(", ")}`,
        api
      );
      return;
    }
    match = candidates[0];
  }
  if (match) {
    // Catalog path: switch provider/model only, keep the current effort.
    const selection = await selector.applyModel(key, match.provider, match.id);
    const live = api.wildfireAgents.applyModelLive(key, selection);
    await sendDirectReply(
      sender,
      conv,
      `模型已切换: ${selection.provider}/${selection.model}${selection.reasoningEffort ? `（推理等级保留=${selection.reasoningEffort}）` : ""}${live ? "，下一条消息生效" : "，下次会话生效"}`, api
    );
    return;
  }

  // Backward compatible: configured preset id.
  const selection = selector.applyPreset(key, arg);
  if (!selection) {
    await sendDirectReply(sender, conv, `未找到模型: ${arg}，发 /model 查看可用列表`, api);
    return;
  }
  const live = api.wildfireAgents.applyModelLive(key, selection);
  await sendDirectReply(
    sender,
    conv,
    `模型已切换: ${selection.provider}/${selection.model}${selection.reasoningEffort ? ` (推理等级=${selection.reasoningEffort})` : ""}${live ? "，下一条消息生效" : "，下次会话生效"}`, api
  );
}

/**
 * Fetch the current model's supported reasoning efforts via
 * `ctx.llm.resolveModelInfo`. Returns undefined when the llm service is
 * missing, the lookup fails, or the model exposes no effort list (callers
 * degrade gracefully in all three cases).
 */
async function resolveEffortInfo(
  api: any,
  current: { provider: string; model: string }
): Promise<{ efforts: Array<{ id: string; name: string }>; defaultEffort?: string } | undefined> {
  let llm: any;
  try {
    llm = api.ctx?.get?.("llm");
  } catch {
    return undefined;
  }
  if (!llm) return undefined;
  try {
    const info = await llm.resolveModelInfo(current.provider, current.model);
    const efforts = info?.reasoning?.efforts;
    if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
    return {
      efforts: efforts.map((e: any) => ({ id: String(e.id), name: String(e.name ?? e.id) })),
      defaultEffort: info.reasoning.defaultEffort,
    };
  } catch {
    return undefined;
  }
}

/**
 * `/effort <level>` command: set the reasoning effort on the current model.
 * When the model exposes an effort list (`ctx.llm.resolveModelInfo`), the
 * level is validated against it before the override is touched.
 */
async function handleEffortCommand(
  api: any,
  key: string,
  arg: string,
  sender: string,
  conv: { type: number; target: string; line: number }
): Promise<void> {
  const selector = api.models;
  if (!arg) {
    try {
      const current = await selector.peek(key);
      const lines = [`当前推理等级: ${current.reasoningEffort ?? "默认"}`];
      const support = await resolveEffortInfo(api, current);
      if (support) {
        lines.push(
          `当前模型支持: ${support.efforts.map((e) => e.id).join(" / ")}${support.defaultEffort ? `（默认: ${support.defaultEffort}）` : ""}`
        );
      } else {
        lines.push("当前模型未声明可选推理等级");
      }
      await sendDirectReply(sender, conv, lines.join("\n"), api);
    } catch (e: any) {
      await sendDirectReply(sender, conv, `获取推理等级失败: ${e.message}`, api);
    }
    return;
  }

  const current = await selector.peek(key);
  // Validate against the exposed effort list when available; models without
  // one are set unchecked (nothing to validate against).
  const support = await resolveEffortInfo(api, current);
  const hit = support?.efforts.find((e) => e.id === arg);
  if (support && !hit) {
    await sendDirectReply(
      sender,
      conv,
      `不支持的推理等级: ${arg}，可选: ${support.efforts.map((e) => e.id).join(" / ")}`,
      api
    );
    return;
  }
  const selection = { ...current, reasoningEffort: arg };
  selector.setOverride(key, selection);
  const live = api.wildfireAgents.applyModelLive(key, selection);
  await sendDirectReply(
    sender,
    conv,
    `推理等级已设为 ${arg}${hit ? `（${hit.name}）` : ""}${live ? "，下一条消息生效" : "，下次会话生效"}`, api
  );
}

/** Send a streaming message to Wildfire.
 * - generating: StreamingTextGeneratingMessageContent (same streamId, client replaces content)
 * - completed:  StreamingTextGeneratedMessageContent (final)
 */
async function sendStreamingReply(
  sender: string,
  conv: { type: number; target: string; line: number },
  text: string,
  streamId: string,
  state: "generating" | "completed",
  logger?: any
): Promise<void> {
  const client = getClient();
  if (!client) throw new Error("Wildfire client not connected");

  const conversation = {
    type: conv.type,
    target: conv.type === 0 ? sender : conv.target,
    line: conv.line,
  };

  let payload: any;
  if (state === "generating") {
    const generating = new StreamingTextGeneratingMessageContent();
    generating.text = text;
    generating.streamId = streamId;
    payload = generating.encode();
  } else {
    const generated = new StreamingTextGeneratedMessageContent();
    generated.text = text;
    generated.streamId = streamId;
    payload = generated.encode();
  }

  const result = await client.sendMessage(conversation, payload);
  logger?.info?.(
    `[wildfire] sendStreamingReply(${state}) sent: textLen=${text.length}, success=${result?.isSuccess?.()}${result?.getMsg?.() ? `, msg=${result.getMsg()}` : ""}`
  );
  if (!result.isSuccess()) {
    throw new Error(result.getMsg?.() ?? "send failed");
  }
}

/** Send a plain text reply (whitelist rejection, etc.). */
async function sendDirectReply(
  sender: string,
  conv: { type: number; target: string; line: number },
  text: string,
  api?: any
): Promise<void> {
  const client = getClient();
  if (!client) throw new Error("Wildfire client not connected");

  const conversation = {
    type: conv.type,
    target: conv.type === 0 ? sender : conv.target,
    line: conv.line,
  };
  const content = new TextMessageContent();
  content.content = text;
  const result = await client.sendMessage(conversation, content.encode());
  if (!result.isSuccess()) {
    api?.logger?.warn?.(`[wildfire] direct reply failed: ${result.getMsg?.()}`);
  }
}
