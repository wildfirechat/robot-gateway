/**
 * OpenClaw Wildfire IM Channel Plugin
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { WildfireChannelPlugin } from "./channel.js";
import { startClient} from "./clients.js";
import { getAccountConfig, validateConfig } from "./config.js";
import { handleIncomingMessage } from "./inbound.js";

type WfConversation = {
  type: number;
  target: string;
  line: number;
};

type WfMessage = {
  messageId: number | string;
  conversation: WfConversation;
  sender: string;
  timestamp: number;
  payload: Record<string, unknown>;
  toUsers: string[];
  toRobotId: string;
};

/**
 * 解析 Webhook 消息
 */
function parseWebhookMessage(body: any): WfMessage | null {
  try {
    // 验证基本字段
    if (!body || body.messageId == null || !body.conv || !body.sender) {
      return null;
    }

    return {
      messageId: body.messageId,
      conversation: {
        type: body.conv.type,
        target: body.conv.target,
        line: body.conv.line,
      },
      sender: String(body.sender),
      timestamp: body.timestamp || Date.now(),
      payload: body.payload || {},
      toUsers: Array.isArray(body.toUsers) ? body.toUsers.map(String) : [],
      toRobotId: body.toRobotId ? String(body.toRobotId) : "",
    };
  } catch {
    return null;
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getRequestBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }

  const raw = await readRequestBody(req);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default function register(api: any): void {
  // Register channel
  api.registerChannel({ plugin: WildfireChannelPlugin });

  api.registerHttpRoute({
    path: "/plugins/wildfire/webhook",
    auth: "plugin",
    handler: async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.end("Method Not Allowed");
        return true;
      }

      const config = getAccountConfig(api);
      if (!config) {
        writeJson(res, 503, { ok: false, error: "wildfire channel is not configured" });
        return true;
      }

      const body = await getRequestBody(req);
      const message = parseWebhookMessage(body);
      if (!message) {
        writeJson(res, 400, { ok: false, error: "invalid webhook payload" });
        return true;
      }

      handleIncomingMessage(
        api,
        {
          data: {
            messageId: message.messageId,
            conv: message.conversation,
            sender: message.sender,
            timestamp: message.timestamp,
            payload: message.payload,
            toUsers: message.toUsers,
            toRobotId: message.toRobotId,
          },
        },
        config,
      );

      writeJson(res, 200, { ok: true, messageId: message.messageId });
      return true;
    },
  });

  // Register service for lifecycle management
  api.registerService({
    id: "wildfire",
    start: async () => {

      const config = getAccountConfig(api);
      if (!config) {
        api.logger?.warn?.("[wildfire] plugin disabled or no config");
        return;
      }

      // Validate config
      const error = validateConfig(config);
      if (error) {
        api.logger?.error?.(`[wildfire] invalid config: ${error}`);
        throw new Error(`Wildfire config error: ${error}`);
      }

      try {
        await startClient(api, config);
        api.logger?.info?.("[wildfire] service started");
      } catch (err) {
        api.logger?.error?.("[wildfire] failed to start:", err);
        throw err;
      }
    },
    stop: async () => {
      api.logger?.info?.("[wildfire] service stopped");
    },
  });

  api.logger?.info?.("[wildfire] plugin loaded");
}
