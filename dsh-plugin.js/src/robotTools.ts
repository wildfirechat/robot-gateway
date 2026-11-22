/**
 * Robot-identity tools. These use the protected robot-gateway client only;
 * they never expose robotSecret to the model and never touch the current IM
 * user's local data (that is the separate im_user_* bridge).
 *
 * Security: send/file/group-mutation/generic-API tools are owner/admin-only
 * (`toolSecurity.requireOwnerTurn`), and file sends are restricted to the
 * configured workspace roots (realpath-checked), so a prompt-injected guest
 * cannot use the robot as an arbitrary local-file exfiltration channel.
 */

import { readFile } from "node:fs/promises";
import { TextMessageContent, FileMessageContent } from "@wildfirechat/server-sdk";
import { getConnectedClient } from "./clients.js";
import { getAiLine } from "./config.js";
import { assertConfigSendablePath, confirmWriteAction, markReadResultTainted, requireOwnerTurn, requireWriteTurn } from "./toolSecurity.js";

function rawTool(name: string, description: string, parameters: any, execute: (args: any, exec: any) => Promise<any>) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: "object", additionalProperties: true },
      // DSH expects render() to return tool-result content blocks; returning
      // null makes the session surface read .some on null and fails the tool.
      render: (_args: any, value: any) => [{
        type: "text",
        text: (() => {
          try {
            const text = JSON.stringify(value);
            return text.length > 20000 ? `${text.slice(0, 20000)}…` : text;
          } catch {
            return String(value);
          }
        })(),
      }],
    },
    async execute(args: any, exec: any) {
      return execute(args, exec);
    },
  };
}

/** IMResult code (works for both the SDK class and plain objects). */
function imCode(result: any): number {
  if (result == null) return -1;
  try {
    if (typeof result.getCode === "function") return Number(result.getCode());
  } catch {
    return -1;
  }
  return Number(result.code ?? -1);
}

function imMsg(result: any): string {
  if (result == null) return "";
  try {
    if (typeof result.getMsg === "function") return String(result.getMsg() ?? "");
  } catch {
    return "";
  }
  return String(result.msg ?? "");
}

function imValue(result: any): any {
  if (result == null) return null;
  try {
    if (typeof result.getResult === "function") return result.getResult();
  } catch {
    return null;
  }
  return result.result ?? null;
}

/** Throw on IM errors so the model sees a failure instead of "ok:true, null". */
function unwrap(result: any, label: string): any {
  const code = imCode(result);
  if (code !== 0) {
    const msg = imMsg(result);
    throw new Error(`${label} failed: code=${code}${msg ? ` msg=${msg}` : ""}`);
  }
  return imValue(result);
}

/** Generic dispatch keeps the IM code visible while marking failures as ok:false. */
function describeResult(result: any): any {
  return { ok: imCode(result) === 0, code: imCode(result), msg: imMsg(result), result: toPlain(imValue(result)) };
}

function requireClient() {
  const client = getConnectedClient();
  if (!client) throw new Error("Wildfire robot is not connected");
  return client;
}

/**
 * Advanced robot APIs exposed to the model. Privacy-sensitive owner/account
 * APIs (getOwnerFriendList / getUserRobots / applicationGetUserInfo) are
 * deliberately excluded: they leak data about the robot owner or other users.
 */
const ROBOT_API_METHODS = [
  "getMessage", "sendMessage", "sendMessageToUsers", "replyMessage", "recallMessage", "updateMessage",
  "updateConversationUserSetting",
  "getUserInfo", "getUserInfoByMobile", "getUserInfoByName", "getUserInfoByEmail", "getBatchUsers",
  "searchUserByDisplayName",
  "getProfile", "updateProfile",
  "createGroup", "getGroupInfo", "dismissGroup", "transferGroup", "modifyGroupInfo",
  "getGroupMembers", "getGroupMember", "addGroupMembers", "setGroupManager", "muteGroupMember",
  "allowGroupMember", "kickoffGroupMembers", "quitGroup", "setGroupMemberAlias", "setGroupMemberExtra",
  "postMomentsFeed", "updateMomentsFeed", "getMomentsFeeds", "getMomentsFeed", "deleteMomentsFeed",
  "postMomentsComment", "deleteMomentsComment", "getUserMomentsProfile", "updateMomentsBackgroundUrl",
  "updateMomentsStrangerVisibleCount", "updateMomentsVisibleScope", "updateMomentsBlackList",
  "updateMomentsBlockList", "getPresignedUploadUrl", "uploadFile", "uploadToQiniu", "uploadToOther",
];

function toPlain(value: any, depth = 0): any {
  if (value == null || depth > 6) return value ?? null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Buffer.isBuffer(value)) return { bufferBytes: value.length };
  if (Array.isArray(value)) return value.map((v) => toPlain(v, depth + 1));
  if (typeof value === "object") {
    if (typeof value.getResult === "function") {
      try { return toPlain(value.getResult(), depth + 1); } catch { /* fall through */ }
    }
    if (typeof value.toJSON === "function") {
      try { return toPlain(value.toJSON(), depth + 1); } catch { /* fall through */ }
    }
    const out: any = {};
    for (const key of Object.keys(value)) {
      const v = value[key];
      if (typeof v === "function") continue;
      out[key] = toPlain(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Normalize the different group-member list shapes to a plain array. */
function memberListOf(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.members)) return value.members;
  return [];
}

function currentWorkspaceRoot(api: any): string {
  try {
    const root = api?.workspace?.root?.();
    return typeof root === "string" ? root : "";
  } catch {
    return "";
  }
}

export function registerRobotTools(api: any): void {
  let tools: any;
  try {
    tools = api.ctx?.get?.("tools");
  } catch {
    api.logger?.warn?.("[wildfire] tools service unavailable; robot tools not registered");
    return;
  }
  if (!tools?.register) {
    api.logger?.warn?.("[wildfire] tools registry unavailable; robot tools not registered");
    return;
  }

const secureReadTool = (name: string, description: string, parameters: any, execute: (args: any, exec: any) => Promise<any>) =>
  rawTool(name, description, parameters, async (args: any, exec: any) => {
    requireOwnerTurn(api, exec, name);
    try {
      return await execute(args, exec);
    } finally {
      markReadResultTainted(api, exec);
    }
  });

const secureWriteTool = (name: string, description: string, parameters: any, execute: (args: any, exec: any) => Promise<any>) =>
  rawTool(name, description, parameters, async (args: any, exec: any) => {
    requireWriteTurn(api, exec, name);
    await confirmWriteAction(api, exec, name, formatWritePreview(name, args));
    return execute(args, exec);
  });

function jsonPreview(value: any): string {
  try { return JSON.stringify(value).slice(0, 600); } catch { return ""; }
}

function memberIdsOf(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: any) => typeof item === "string"
    ? item
    : String(item?.member_id ?? item?.memberId ?? item?.userId ?? "").trim())
    .filter(Boolean);
}

function formatMemberLine(label: string, value: any): string {
  const ids = memberIdsOf(value);
  return `${label}：${ids.length ? ids.join("、") : "(无)"}`;
}

/**
 * Human-readable text for the approval card. The model-facing tool args are
 * JSON, but the owner must be able to read WHAT will happen without decoding
 * nested arrays.
 */
function formatWritePreview(name: string, args: any): string {
  const a = args || {};
  if (name === "im_bot_create_group") {
    return [
      "机器人创建群聊",
      `群名：${String(a.name || "(未命名)")}`,
      formatMemberLine("邀请成员", a.memberIds),
      `邀请人：${String(a.to || "(机器人 owner)")}`,
    ].join("\n");
  }
  if (name === "im_bot_add_group_members") {
    return `机器人添加群成员\n群 ID：${String(a.groupId || "")}\n${formatMemberLine("成员", a.memberIds)}`;
  }
  if (name === "im_bot_remove_group_members") {
    return `机器人移出群成员\n群 ID：${String(a.groupId || "")}\n${formatMemberLine("成员", a.memberIds)}`;
  }
  if (name === "im_bot_transfer_group") {
    return `机器人转让群主\n群 ID：${String(a.groupId || "")}\n新群主：${String(a.newOwnerId || "")}`;
  }
  if (name === "im_bot_dismiss_group") {
    return `机器人解散群聊\n群 ID：${String(a.groupId || "")}`;
  }
  if (name === "im_bot_send_message") {
    return `机器人发送消息\n目标：${String(a.type) === "0" ? "用户" : "群"} ${String(a.target || "")}\n内容：${String(a.text || "").slice(0, 400)}`;
  }
  if (name === "im_bot_send_file") {
    return `机器人发送文件\n目标：${String(a.type) === "0" ? "用户" : "群"} ${String(a.target || "")}\n文件：${String(a.path || "")}`;
  }
  if (name === "im_bot_recall_message") {
    return `机器人撤回消息\n消息 ID：${String(a.messageUid || "")}`;
  }
  if (name === "im_bot_api") {
    const method = String(a.method || "");
    const list = Array.isArray(a.args) ? a.args : [];
    if (method === "createGroup") {
      const info: any = list[0] || {};
      return [
        "机器人创建群聊",
        `群名：${String(info.name || info.groupName || "(未命名)")}`,
        formatMemberLine("邀请成员", list[1]),
        `邀请人：${String(list[2] || "(机器人 owner)")}`,
      ].join("\n");
    }
    if (method === "addGroupMembers") {
      return `机器人添加群成员\n群 ID：${String(list[0] || "")}\n${formatMemberLine("成员", list[1])}`;
    }
    if (method === "kickoffGroupMembers") {
      return `机器人移出群成员\n群 ID：${String(list[0] || "")}\n${formatMemberLine("成员", list[1])}`;
    }
    if (method === "transferGroup") {
      return `机器人转让群主\n群 ID：${String(list[0] || "")}\n新群主：${String(list[1] || "")}`;
    }
    if (method === "dismissGroup") {
      return `机器人解散群聊\n群 ID：${String(list[0] || "")}`;
    }
    if (method === "recallMessage") {
      return `机器人撤回消息\n消息 ID：${String(list[0] || "")}`;
    }
    if (method === "sendMessage") {
      const conv: any = list[0] || {};
      const payload: any = list[1] || {};
      return `机器人发送消息\n目标：${Number(conv.type) === 0 ? "用户" : "群"} ${String(conv.target || "")}\n内容：${String(payload.searchableContent || payload.content || "").slice(0, 400)}`;
    }
    return `机器人 API 写操作：${method || name}\n${jsonPreview(list)}`;
  }
  return `机器人写操作：${name}\n${jsonPreview(a)}`;
}


  const robotId = String(api?.config?.robotId || "");
  const ownerId = String(api?.robotOwner || process.env.WF_OWNER_USER_ID || "");
  const aiLines = [getAiLine(api?.config || {})];

  const memberObjects = (ids: string[]) => ids
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .map((id) => ({ member_id: id, type: 0 }));

  tools.register(secureWriteTool(
    "im_bot_create_group",
    "Create a Wildfire group as the robot. Owner/admin only. memberIds are user ids (strings); the robot and `to` are added automatically. Returns a verified group id.",
    {
      type: "object",
      properties: {
        name: { type: "string", description: "Group name." },
        memberIds: { type: "array", items: { type: "string" }, description: "User ids to invite." },
        to: { type: "string", description: "Inviter / owner user id; defaults to the robot owner." },
        notifyText: { type: "string", description: "Optional group creation notification text." },
      },
      required: ["name", "memberIds"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_create_group");
      const client = requireClient();
      const name = String(args?.name || "").trim();
      if (!name) throw new Error("name is required");
      const to = String(args?.to || ownerId || "").trim();
      if (!to) throw new Error("to (owner user id) is required");
      const requested = memberObjects(Array.isArray(args?.memberIds) ? args.memberIds : []);
      if (robotId && !requested.some((m) => m.member_id === robotId)) requested.push({ member_id: robotId, type: 0 });
      if (!requested.some((m) => m.member_id === to)) requested.push({ member_id: to, type: 0 });
      const result = await client.createGroup(
        { name, portrait: "", join_type: 2 },
        requested,
        to,
        aiLines,
        null
      );
      const created = unwrap(result, "createGroup");
      const groupId = String(created?.group_id || "").trim();
      if (!groupId) throw new Error("createGroup returned success but no group_id");
      let verified = false;
      try {
        const members = memberListOf(unwrap(await client.getGroupMembers(groupId), "getGroupMembers"));
        const ids = new Set(members.map((m: any) => String(m?.member_id || m?.memberId || "")));
        verified = requested.every((m) => ids.has(m.member_id));
      } catch {
        verified = false;
      }
      return { ok: true, groupId, verified, members: requested.map((m) => m.member_id) };
    }
  ));

  tools.register(secureWriteTool(
    "im_bot_add_group_members",
    "Add users to a Wildfire group as the robot. Owner/admin only. memberIds are user-id strings; membership is read back to verify.",
    {
      type: "object",
      properties: {
        groupId: { type: "string" },
        memberIds: { type: "array", items: { type: "string" } },
      },
      required: ["groupId", "memberIds"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_add_group_members");
      const client = requireClient();
      const groupId = String(args?.groupId || "").trim();
      const members = memberObjects(Array.isArray(args?.memberIds) ? args.memberIds : []);
      if (!groupId || !members.length) throw new Error("groupId and non-empty memberIds are required");
      unwrap(await client.addGroupMembers(groupId, members, ownerId, aiLines, null), "addGroupMembers");
      let verified = false;
      try {
        const list = memberListOf(unwrap(await client.getGroupMembers(groupId), "getGroupMembers"));
        const ids = new Set(list.map((m: any) => String(m?.member_id || m?.memberId || "")));
        verified = members.every((m) => ids.has(m.member_id));
      } catch {
        verified = false;
      }
      return { ok: true, groupId, members: members.map((m) => m.member_id), verified };
    }
  ));

  tools.register(secureWriteTool(
    "im_bot_remove_group_members",
    "Remove users from a Wildfire group as the robot. Owner/admin only. memberIds are user-id strings.",
    {
      type: "object",
      properties: {
        groupId: { type: "string" },
        memberIds: { type: "array", items: { type: "string" } },
      },
      required: ["groupId", "memberIds"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_remove_group_members");
      const client = requireClient();
      const groupId = String(args?.groupId || "").trim();
      const ids = (Array.isArray(args?.memberIds) ? args.memberIds : []).map((v: any) => String(v || "").trim()).filter(Boolean);
      if (!groupId || !ids.length) throw new Error("groupId and non-empty memberIds are required");
      unwrap(await client.kickoffGroupMembers(groupId, ids, aiLines, null), "kickoffGroupMembers");
      return { ok: true, groupId, members: ids };
    }
  ));

  tools.register(secureWriteTool(
    "im_bot_transfer_group",
    "Transfer a Wildfire group to a new owner as the robot. Owner/admin only.",
    {
      type: "object",
      properties: {
        groupId: { type: "string" },
        newOwnerId: { type: "string" },
      },
      required: ["groupId", "newOwnerId"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_transfer_group");
      const client = requireClient();
      unwrap(await client.transferGroup(
        String(args?.groupId || "").trim(),
        String(args?.newOwnerId || "").trim(),
        aiLines,
        null
      ), "transferGroup");
      return { ok: true };
    }
  ));

  tools.register(secureWriteTool(
    "im_bot_dismiss_group",
    "Dismiss a Wildfire group as the robot. Owner/admin only.",
    {
      type: "object",
      properties: { groupId: { type: "string" } },
      required: ["groupId"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_dismiss_group");
      const client = requireClient();
      unwrap(await client.dismissGroup(String(args?.groupId || "").trim(), aiLines, null), "dismissGroup");
      return { ok: true };
    }
  ));

  tools.register(secureWriteTool(
    "im_bot_recall_message",
    "Recall a message sent by the robot. Owner/admin only. messageUid must be a string.",
    {
      type: "object",
      properties: { messageUid: { type: "string" } },
      required: ["messageUid"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_recall_message");
      const client = requireClient();
      const messageUid = String(args?.messageUid || "");
      unwrap(await client.recallMessage(messageUid), "recallMessage");
      return { ok: true, messageUid };
    }
  ));

  tools.register(secureWriteTool(
    "im_bot_send_message",
    "Send a text message as the Wildfire robot. Owner/admin only. This is the robot identity, not the logged-in user.",
    {
      type: "object",
      properties: {
        type: { type: "integer", enum: [0, 1], description: "0 single user, 1 group." },
        target: { type: "string", description: "User id or group id." },
        line: { type: "integer", minimum: 0, description: "Conversation line, default 0." },
        text: { type: "string", description: "Message text." },
      },
      required: ["type", "target", "text"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_send_message");
      const client = requireClient();
      const content = new TextMessageContent();
      content.content = String(args?.text || "");
      const conversation = {
        type: Number(args?.type) === 1 ? 1 : 0,
        target: String(args?.target || ""),
        line: Number(args?.line) || 0,
      };
      const result = await client.sendMessage(conversation, content.encode());
      const out = unwrap(result, "robot sendMessage") || {};
      return { ok: true, messageUid: String(out.messageUidString ?? out.messageUid ?? "") };
    }
  ));

  tools.register(secureReadTool(
    "im_bot_user_info",
    "Get a Wildfire user profile visible to the robot.",
    {
      type: "object",
      properties: { userId: { type: "string", description: "Wildfire user id." } },
      required: ["userId"],
      additionalProperties: false,
    },
    async (args: any) => {
      const client = requireClient();
      return { user: unwrap(await client.getUserInfo(String(args?.userId || "")), "getUserInfo") };
    }
  ));

  tools.register(secureReadTool(
    "im_bot_group_info",
    "Get Wildfire group information visible to the robot.",
    {
      type: "object",
      properties: { groupId: { type: "string", description: "Wildfire group id." } },
      required: ["groupId"],
      additionalProperties: false,
    },
    async (args: any) => {
      const client = requireClient();
      return { group: unwrap(await client.getGroupInfo(String(args?.groupId || "")), "getGroupInfo") };
    }
  ));

  tools.register(secureReadTool(
    "im_bot_group_members",
    "List members of a Wildfire group visible to the robot.",
    {
      type: "object",
      properties: { groupId: { type: "string", description: "Wildfire group id." } },
      required: ["groupId"],
      additionalProperties: false,
    },
    async (args: any) => {
      const client = requireClient();
      const groupId = String(args?.groupId || "");
      const value = unwrap(await client.getGroupMembers(groupId), "getGroupMembers");
      return { groupId, members: memberListOf(value) };
    }
  ));

  tools.register(secureWriteTool(
    "im_bot_send_file",
    "Send a local file as the robot. Owner/admin only. The path must be inside the agent workspace.",
    {
      type: "object",
      properties: {
        type: { type: "integer", enum: [0, 1], description: "0 single user, 1 group." },
        target: { type: "string" },
        line: { type: "integer", minimum: 0 },
        path: { type: "string", description: "Local file path inside the workspace." },
        name: { type: "string", description: "Optional display file name." },
      },
      required: ["type", "target", "path"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_send_file");
      const client = requireClient();
      // Restrict to workspace roots: arbitrary local files must not be exfiltrated.
      const localPath = await assertConfigSendablePath(
        String(args?.path || ""),
        api?.config || {},
        [currentWorkspaceRoot(api)]
      );
      const data = await readFile(localPath);
      const name = String(args?.name || localPath.split(/[\\/]/).pop() || "file");
      const mediaType = 4; // MessageContentMediaType.File
      const upload = await client.uploadFile(data, name, mediaType, "application/octet-stream");
      const remote = unwrap(upload, "uploadFile") || "";
      if (!remote) throw new Error("robot file upload failed: empty remote URL");
      const content = new FileMessageContent(null, remote, name, data.length);
      const result = await client.sendMessage({
        type: Number(args?.type) === 1 ? 1 : 0,
        target: String(args?.target || ""),
        line: Number(args?.line) || 0,
      }, content.encode());
      const sent = unwrap(result, "robot sendMessage") || {};
      return { ok: true, remoteUrl: remote, messageUid: String(sent.messageUidString ?? "") };
    }
  ));

  tools.register(secureWriteTool(
    "im_bot_api",
    "Call a RobotServiceClient method directly. Owner/admin only. Use this for advanced robot APIs not covered by the typed tools. `args` is the positional argument array. Returns {ok, code, msg, result}; ok=false carries the IM error code.",
    {
      type: "object",
      properties: {
        method: { type: "string", enum: ROBOT_API_METHODS, description: "RobotServiceClient method name." },
        args: { type: "array", description: "Positional arguments for the method." },
      },
      required: ["method"],
      additionalProperties: false,
    },
    async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, "im_bot_api");
      const client = requireClient();
      const method = String(args?.method || "");
      if (!ROBOT_API_METHODS.includes(method)) throw new Error(`unsupported robot API method: ${method}`);
      const fn = (client as any)[method];
      if (typeof fn !== "function") throw new Error(`robot API method not available: ${method}`);
      const params = Array.isArray(args?.args) ? args.args : [];
      const result = await fn.apply(client, params);
      return describeResult(result);
    }
  ));

  api.logger?.info?.(
    "[wildfire] robot tools registered (owner-gated send/file/group/api): send_message, send_file, user_info, group_info, group_members, create_group/add/remove/transfer/dismiss/recall, api"
  );
}
