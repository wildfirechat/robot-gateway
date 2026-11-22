/**
 * Robot-identity tools. These use the protected robot-gateway client only;
 * they never expose robotSecret to the model and never touch the current IM
 * user's local data (that is the separate im_user_* bridge).
 */

import { readFile } from "node:fs/promises";
import { TextMessageContent, FileMessageContent } from "@wildfirechat/server-sdk";
import { getConnectedClient } from "./clients.js";

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

function resultOf(response: any): any {
  if (response == null) return null;
  if (typeof response.getResult === "function") {
    try { return response.getResult(); } catch { return null; }
  }
  return response.result ?? response;
}

function requireClient() {
  const client = getConnectedClient();
  if (!client) throw new Error("Wildfire robot is not connected");
  return client;
}

const ROBOT_API_METHODS = [
  "getMessage", "sendMessage", "sendMessageToUsers", "replyMessage", "recallMessage", "updateMessage",
  "updateConversationUserSetting",
  "getUserInfo", "getUserInfoByMobile", "getUserInfoByName", "getUserInfoByEmail", "getBatchUsers",
  "applicationGetUserInfo", "getOwnerFriendList", "searchUserByDisplayName", "getUserRobots",
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

  tools.register(rawTool(
    "im_bot_send_message",
    "Send a text message as the Wildfire robot. This is the robot identity, not the logged-in user.",
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
    async (args: any) => {
      const client = requireClient();
      const content = new TextMessageContent();
      content.content = String(args?.text || "");
      const conversation = {
        type: Number(args?.type) === 1 ? 1 : 0,
        target: String(args?.target || ""),
        line: Number(args?.line) || 0,
      };
      const result = await client.sendMessage(conversation, content.encode());
      if (!result?.isSuccess?.()) throw new Error(result?.getMsg?.() || "robot send failed");
      const out = resultOf(result) || {};
      return { ok: true, messageUid: String(out.messageUidString ?? out.messageUid ?? "") };
    }
  ));

  tools.register(rawTool(
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
      return { user: resultOf(await client.getUserInfo(String(args?.userId || ""))) };
    }
  ));

  tools.register(rawTool(
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
      return { group: resultOf(await client.getGroupInfo(String(args?.groupId || ""))) };
    }
  ));

  tools.register(rawTool(
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
      return { groupId: String(args?.groupId || ""), members: resultOf(await client.getGroupMembers(String(args?.groupId || ""))) || [] };
    }
  ));

  tools.register(rawTool(
    "im_bot_send_file",
    "Send a local file as the robot to a user or group. The path must be readable by the Host process.",
    {
      type: "object",
      properties: {
        type: { type: "integer", enum: [0, 1], description: "0 single user, 1 group." },
        target: { type: "string" },
        line: { type: "integer", minimum: 0 },
        path: { type: "string", description: "Absolute local file path." },
        name: { type: "string", description: "Optional display file name." },
      },
      required: ["type", "target", "path"],
      additionalProperties: false,
    },
    async (args: any) => {
      const client = requireClient();
      const localPath = String(args?.path || "");
      const data = await readFile(localPath);
      const name = String(args?.name || localPath.split(/[\\/]/).pop() || "file");
      const mediaType = 4; // MessageContentMediaType.File
      const upload = await client.uploadFile(data, name, mediaType, "application/octet-stream");
      const remote = upload?.isSuccess?.() ? (upload.getResult?.() || "") : "";
      if (!remote) throw new Error(upload?.getMsg?.() || "robot file upload failed");
      const content = new FileMessageContent(null, remote, name, data.length);
      const result = await client.sendMessage({
        type: Number(args?.type) === 1 ? 1 : 0,
        target: String(args?.target || ""),
        line: Number(args?.line) || 0,
      }, content.encode());
      if (!result?.isSuccess?.()) throw new Error(result?.getMsg?.() || "robot file send failed");
      return { ok: true, remoteUrl: remote, messageUid: String(resultOf(result)?.messageUidString ?? "") };
    }
  ));

  tools.register(rawTool(
    "im_bot_api",
    "Call a RobotServiceClient method directly. Use this for advanced robot APIs not covered by the typed tools. `args` is the positional argument array.",
    {
      type: "object",
      properties: {
        method: { type: "string", enum: ROBOT_API_METHODS, description: "RobotServiceClient method name." },
        args: { type: "array", description: "Positional arguments for the method." },
      },
      required: ["method"],
      additionalProperties: false,
    },
    async (args: any) => {
      const client = requireClient();
      const method = String(args?.method || "");
      if (!ROBOT_API_METHODS.includes(method)) throw new Error(`unsupported robot API method: ${method}`);
      const fn = (client as any)[method];
      if (typeof fn !== "function") throw new Error(`robot API method not available: ${method}`);
      const params = Array.isArray(args?.args) ? args.args : [];
      const result = await fn.apply(client, params);
      return { ok: true, result: toPlain(result) };
    }
  ));

  api.logger?.info?.("[wildfire] robot tools registered: send_message, send_file, user_info, group_info, group_members, api");
}
