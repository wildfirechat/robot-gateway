/**
 * Current-user IM bridge tools.
 *
 * Electron main runs a loopback HTTP bridge for the logged-in wfc session and
 * passes its URL/token to this Host through env. These tools never read or
 * persist IM data themselves: every call goes through the bridge, which is
 * live-scoped to the current login and revoked on logout.
 */

import { assertConfigSendablePath, requireOwnerTurn } from "./toolSecurity.js";

type BridgeConfig = {
  url: string;
  token: string;
  readEnabled: boolean;
  sendEnabled: boolean;
};

function bridgeConfig(): BridgeConfig | null {
  const url = String(process.env.WF_IM_BRIDGE_URL || "").trim();
  const token = String(process.env.WF_IM_BRIDGE_TOKEN || "").trim();
  if (!url || !token) return null;
  return {
    url: url.replace(/\/+$/, ""),
    token,
    readEnabled: process.env.WF_IM_BRIDGE_READ !== "0",
    sendEnabled: process.env.WF_IM_BRIDGE_SEND === "1",
  };
}

async function bridgeRequest(
  method: "GET" | "POST",
  path: string,
  query?: Record<string, string | number | undefined>,
  body?: unknown
): Promise<any> {
  // Re-read env per request: the Electron bridge hands out a fresh token when
  // the app restarts, and a start-time snapshot would keep 401-ing.
  const config = bridgeConfig();
  if (!config) throw new Error("IM bridge is not configured (WF_IM_BRIDGE_URL/TOKEN missing)");
  const url = new URL(config.url + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("IM bridge timeout")), 20000);
  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        "X-DSH-Bridge-Token": config.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.error || data?.message || `IM bridge HTTP ${response.status}`;
      throw new Error(String(message));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

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

export function registerImBridgeTools(api: any): void {
  const config = bridgeConfig();
  if (!config) {
    api.logger?.info?.("[wildfire] IM user bridge unavailable (WF_IM_BRIDGE_URL/TOKEN missing)");
    return;
  }
  let tools: any;
  try {
    tools = api.ctx?.get?.("tools");
  } catch (e) {
    api.logger?.warn?.("[wildfire] tools service unavailable; IM bridge tools not registered");
    return;
  }
  if (!tools?.register) {
    api.logger?.warn?.("[wildfire] tools registry unavailable; IM bridge tools not registered");
    return;
  }

  api.logger?.info?.(
    `[wildfire] IM user bridge tools: read=${config.readEnabled}, send=${config.sendEnabled}`
  );

  /** Every current-user tool reads/sends the host user's IM data: owner/admin only. */
  const secureTool = (name: string, description: string, parameters: any, execute: (args: any, exec: any) => Promise<any>) =>
    rawTool(name, description, parameters, async (args: any, exec: any) => {
      requireOwnerTurn(api, exec, name);
      return execute(args, exec);
    });

  if (config.readEnabled) {
    tools.register(secureTool(
      "im_user_contacts",
      "List or search the current IM user's contacts. Use this for personal-assistant questions about contacts.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional name or user-id keyword." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum contacts to return." },
          offset: { type: "integer", minimum: 0, description: "Pagination offset." },
        },
        additionalProperties: false,
      },
      async (args: any) => {
        const data = await bridgeRequest("GET", "/im/contacts", {
          query: args?.query,
          limit: args?.limit,
          offset: args?.offset,
        });
        return data;
      }
    ));

    tools.register(secureTool(
      "im_user_contact",
      "Get one current-user contact's profile by user id.",
      {
        type: "object",
        properties: { userId: { type: "string", description: "IM user id." } },
        required: ["userId"],
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest(
        "GET",
        `/im/contacts/${encodeURIComponent(String(args?.userId || ""))}`
      )
    ));

    tools.register(secureTool(
      "im_user_groups",
      "List or search the current IM user's groups.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional group name or id keyword." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum groups to return." },
          offset: { type: "integer", minimum: 0, description: "Pagination offset." },
        },
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest("GET", "/im/groups", {
        query: args?.query,
        limit: args?.limit,
        offset: args?.offset,
      })
    ));

    tools.register(secureTool(
      "im_user_group",
      "Get one current-user group's details by group id.",
      {
        type: "object",
        properties: { groupId: { type: "string", description: "IM group id." } },
        required: ["groupId"],
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest(
        "GET",
        `/im/groups/${encodeURIComponent(String(args?.groupId || ""))}`
      )
    ));

    tools.register(secureTool(
      "im_user_group_members",
      "List members of one of the current IM user's groups.",
      {
        type: "object",
        properties: {
          groupId: { type: "string", description: "Group id." },
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum members to return." },
        },
        required: ["groupId"],
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest(
        "GET",
        `/im/groups/${encodeURIComponent(String(args.groupId || ""))}/members`,
        { limit: args?.limit }
      )
    ));

    tools.register(secureTool(
      "im_user_organization_root",
      "Get the root organization of the current user's organization directory.",
      { type: "object", properties: {}, additionalProperties: false },
      async () => bridgeRequest("GET", "/im/organization/root")
    ));

    tools.register(secureTool(
      "im_user_organization",
      "Get one organization node and its sub-organizations.",
      {
        type: "object",
        properties: { organizationId: { type: "string" } },
        required: ["organizationId"],
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest(
        "GET",
        `/im/organization/${encodeURIComponent(String(args?.organizationId || ""))}`
      )
    ));

    tools.register(secureTool(
      "im_user_organization_employees",
      "List employees directly under one organization node.",
      {
        type: "object",
        properties: { organizationId: { type: "string" } },
        required: ["organizationId"],
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest(
        "GET",
        `/im/organization/${encodeURIComponent(String(args?.organizationId || ""))}/employees`
      )
    ));

    tools.register(secureTool(
      "im_user_search_employee",
      "Search employees in the organization directory.",
      {
        type: "object",
        properties: {
          query: { type: "string" },
          organizationId: { type: "string", description: "Optional organization node; defaults to root." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest("GET", "/im/employees/search", {
        query: args?.query,
        organizationId: args?.organizationId,
      })
    ));

    tools.register(secureTool(
      "im_user_channels",
      "List or search channels joined by the current IM user.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional channel name or id keyword." },
          limit: { type: "integer", minimum: 1, maximum: 200 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest("GET", "/im/channels", {
        query: args?.query,
        limit: args?.limit,
        offset: args?.offset,
      })
    ));

    tools.register(secureTool(
      "im_user_channel",
      "Get one current-user channel's details by channel id.",
      {
        type: "object",
        properties: { channelId: { type: "string" } },
        required: ["channelId"],
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest(
        "GET",
        `/im/channels/${encodeURIComponent(String(args?.channelId || ""))}`
      )
    ));

    tools.register(secureTool(
      "im_user_conversations",
      "List recent conversations of the current IM user with last-message summaries and unread counts.",
      {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum conversations to return." },
          offset: { type: "integer", minimum: 0, description: "Pagination offset." },
        },
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest("GET", "/im/conversations", {
        limit: args?.limit,
        offset: args?.offset,
      })
    ));

    tools.register(secureTool(
      "im_user_messages",
      "Read messages in one current-user IM conversation, newest first.",
      {
        type: "object",
        properties: {
          conversation: {
            type: "object",
            properties: {
              type: { type: "integer", description: "0 single, 1 group, 2 chatroom, 3 channel, 5 secret chat." },
              target: { type: "string" },
              line: { type: "integer", minimum: 0 },
            },
            required: ["type", "target"],
            additionalProperties: false,
          },
          before: { type: "string", description: "Message id cursor as a numeric string; omit for latest." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum messages." },
        },
        required: ["conversation"],
        additionalProperties: false,
      },
      async (args: any) => {
        const conv = args?.conversation || {};
        const key = `${conv.type}:${conv.target}:${conv.line ?? 0}`;
        return bridgeRequest("GET", `/im/conversations/${encodeURIComponent(key)}/messages`, {
          before: args?.before,
          limit: args?.limit,
        });
      }
    ));

    tools.register(secureTool(
      "im_user_search_messages",
      "Search all local IM history of the current user; optionally restrict to one conversation.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword to search, at least one character." },
          conversation: {
            type: "object",
            properties: {
              type: { type: "integer" },
              target: { type: "string" },
              line: { type: "integer", minimum: 0 },
            },
            required: ["type", "target"],
            additionalProperties: false,
          },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          offset: { type: "integer", minimum: 0, description: "Pagination offset." },
          from: { type: "integer", description: "Optional start timestamp (ms)." },
          to: { type: "integer", description: "Optional end timestamp (ms)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async (args: any) => {
        const conv = args?.conversation;
        return bridgeRequest("GET", "/im/messages/search", {
          query: args?.query,
          limit: args?.limit,
          offset: args?.offset,
          from: args?.from,
          to: args?.to,
          conversation: conv ? `${conv.type}:${conv.target}:${conv.line ?? 0}` : undefined,
        });
      }
    ));
  }

  if (config.sendEnabled) {
    tools.register(secureTool(
      "im_user_recall_message",
      "Recall one message as the current IM user. Only messages the user sent within the recall window can be recalled.",
      {
        type: "object",
        properties: {
          messageUid: { type: "string", description: "Message UID from im_user_messages / search results." },
        },
        required: ["messageUid"],
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest("POST", "/im/messages/recall", undefined, {
        messageUid: args?.messageUid,
      })
    ));

    tools.register(secureTool(
      "im_user_send_file",
      "Send a local file as the current IM user. The path must be readable by the client process.",
      {
        type: "object",
        properties: {
          conversation: {
            type: "object",
            properties: {
              type: { type: "integer", description: "0 single, 1 group." },
              target: { type: "string" },
              line: { type: "integer", minimum: 0 },
            },
            required: ["type", "target"],
            additionalProperties: false,
          },
          path: { type: "string", description: "Absolute local file path." },
          name: { type: "string", description: "Optional display name." },
        },
        required: ["conversation", "path"],
        additionalProperties: false,
      },
      async (args: any) => {
        const localPath = await assertConfigSendablePath(
          String(args?.path || ""),
          api?.config || {},
          [(() => { try { const r = api?.workspace?.root?.(); return typeof r === "string" ? r : ""; } catch { return ""; } })()]
        );
        return bridgeRequest("POST", "/im/messages/send_file", undefined, {
          conversation: args?.conversation,
          path: localPath,
          name: args?.name,
        });
      }
    ));

    tools.register(secureTool(
      "im_user_send_message",
      "Send a text message as the current IM user. Owner/admin only; also requires the user's global send switch to be enabled.",
      {
        type: "object",
        properties: {
          conversation: {
            type: "object",
            properties: {
              type: { type: "integer", description: "0 single, 1 group." },
              target: { type: "string" },
              line: { type: "integer", minimum: 0 },
            },
            required: ["type", "target"],
            additionalProperties: false,
          },
          text: { type: "string", description: "Message text." },
        },
        required: ["conversation", "text"],
        additionalProperties: false,
      },
      async (args: any) => {
        return bridgeRequest("POST", "/im/messages/send", undefined, {
          conversation: args?.conversation,
          text: args?.text,
        });
      }
    ));
  }
}
