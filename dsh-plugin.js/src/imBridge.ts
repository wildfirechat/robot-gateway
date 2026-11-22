/**
 * Current-user IM bridge tools.
 *
 * Electron main runs a loopback HTTP bridge for the logged-in wfc session and
 * passes its URL/token to this Host through env. These tools never read or
 * persist IM data themselves: every call goes through the bridge, which is
 * live-scoped to the current login and revoked on logout.
 */

type BridgeConfig = {
  url: string;
  token: string;
  readEnabled: boolean;
  sendEnabled: boolean;
  approvalRequired: boolean;
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
    approvalRequired: process.env.WF_IM_BRIDGE_APPROVAL !== "0",
  };
}

async function bridgeRequest(
  config: BridgeConfig,
  method: "GET" | "POST",
  path: string,
  query?: Record<string, string | number | undefined>,
  body?: unknown
): Promise<any> {
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
      render: () => null,
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
    `[wildfire] IM user bridge tools: read=${config.readEnabled}, send=${config.sendEnabled}, approval=${config.approvalRequired}`
  );

  if (config.readEnabled) {
    tools.register(rawTool(
      "im_user_contacts",
      "List or search the current IM user's contacts. Use this for personal-assistant questions about contacts.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional name or user-id keyword." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum contacts to return." },
        },
        additionalProperties: false,
      },
      async (args: any) => {
        const data = await bridgeRequest(config, "GET", "/im/contacts", {
          query: args?.query,
          limit: args?.limit,
        });
        return data;
      }
    ));

    tools.register(rawTool(
      "im_user_groups",
      "List or search the current IM user's groups.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional group name or id keyword." },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum groups to return." },
        },
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest(config, "GET", "/im/groups", {
        query: args?.query,
        limit: args?.limit,
      })
    ));

    tools.register(rawTool(
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
        config,
        "GET",
        `/im/groups/${encodeURIComponent(String(args.groupId || ""))}/members`,
        { limit: args?.limit }
      )
    ));

    tools.register(rawTool(
      "im_user_conversations",
      "List recent conversations of the current IM user with last-message summaries and unread counts.",
      {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum conversations to return." },
        },
        additionalProperties: false,
      },
      async (args: any) => bridgeRequest(config, "GET", "/im/conversations", { limit: args?.limit })
    ));

    tools.register(rawTool(
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
          before: { type: "integer", description: "Message id cursor; omit for latest." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum messages." },
        },
        required: ["conversation"],
        additionalProperties: false,
      },
      async (args: any) => {
        const conv = args?.conversation || {};
        const key = `${conv.type}:${conv.target}:${conv.line ?? 0}`;
        return bridgeRequest(config, "GET", `/im/conversations/${encodeURIComponent(key)}/messages`, {
          before: args?.before,
          limit: args?.limit,
        });
      }
    ));

    tools.register(rawTool(
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
        },
        required: ["query"],
        additionalProperties: false,
      },
      async (args: any) => {
        const conv = args?.conversation;
        return bridgeRequest(config, "GET", "/im/messages/search", {
          query: args?.query,
          limit: args?.limit,
          conversation: conv ? `${conv.type}:${conv.target}:${conv.line ?? 0}` : undefined,
        });
      }
    ));
  }

  if (config.sendEnabled) {
    tools.register(rawTool(
      "im_user_send_message",
      "Send a text message as the current IM user. Requires the user's global send setting; approval may be required.",
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
      async (args: any, exec: any) => {
        if (config.approvalRequired) {
          let approval: any;
          try { approval = api.ctx?.get?.("approval"); } catch { approval = null; }
          if (!approval?.request || !exec?.agent) {
            throw new Error("IM send approval is required but no approval service/agent is available");
          }
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: "im_user_send_message",
            callId: exec.callId,
            reason: "以当前 IM 用户身份发送消息",
            signal: exec.signal,
          });
          if (outcome !== "allowed-once") {
            throw new Error(`IM send was not approved (${String(outcome)})`);
          }
        }
        return bridgeRequest(config, "POST", "/im/messages/send", undefined, {
          conversation: args?.conversation,
          text: args?.text,
        });
      }
    ));
  }
}
