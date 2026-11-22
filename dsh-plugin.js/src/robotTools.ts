/**
 * Robot-identity tools. These use the protected robot-gateway client only;
 * they never expose robotSecret to the model and never touch the current IM
 * user's local data (that is the separate im_user_* bridge).
 */

import { TextMessageContent } from "@wildfirechat/server-sdk";
import { getConnectedClient } from "./clients.js";

function rawTool(name: string, description: string, parameters: any, execute: (args: any, exec: any) => Promise<any>) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: "object", additionalProperties: true },
      render: () => null,
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

  api.logger?.info?.("[wildfire] robot tools registered: send_message, user_info, group_info, group_members");
}
