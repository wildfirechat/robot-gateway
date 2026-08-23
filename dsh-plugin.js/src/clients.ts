/**
 * Wildfire robot-gateway client lifecycle (single account).
 *
 * Uses the same `@wildfirechat/robot-gateway-client-sdk` as the openclaw
 * plugin; only the inbound callback routing differs (dsh dispatch instead of
 * openclaw's runtime).
 */

import { RobotServiceClient } from "@wildfirechat/robot-gateway-client-sdk";
import type { WildfireConfig } from "./config.js";
import { handleIncomingMessage } from "./inbound.js";

let client: RobotServiceClient | null = null;
let connected = false;

export function isClientConnected(): boolean {
  return connected && client !== null;
}

export function getClient(): RobotServiceClient | null {
  return client;
}

export function getConnectedClient(): RobotServiceClient | null {
  return client && connected ? client : null;
}

/** Connect to the Wildfire gateway as the configured robot. */
export async function startClient(api: any, config: WildfireConfig): Promise<void> {
  if (client) {
    api.logger?.warn?.("[wildfire] client already exists");
    return;
  }

  client = new RobotServiceClient(
    config.gatewayUrl!,
    {
      onMessage: (message: any) => handleIncomingMessage(api, message, config),
      onConnectionChanged: (isConnected: boolean) => {
        connected = isConnected;
        api.logger?.info?.(`[wildfire] connection changed: ${isConnected}`);
      },
      onError: (error: Error) => {
        api.logger?.error?.("[wildfire] error:", error);
      },
    },
    {
      timeout: 30,
      reconnectInterval: 5000,
      heartbeatInterval: 180000,
      // 平台号：默认不配置 —— SDK 按运行环境自动探测（Linux=7 / macOS=4 / Windows=3），
      // 网关据此设置 im-server 的机器人在线平台（/robot/set_online）。
      // 仅特殊场景需要覆盖时配置 config.gatewayPlatform。
      platform: config.gatewayPlatform,
    }
  );

  const isConn = await client.connect(
    config.robotId!,
    config.robotSecret!,
    30,
    config.gatewayPlatform
  );
  if (isConn) {
    connected = true;
    api.logger?.info?.(`[wildfire] connected as ${config.robotId}`);
  } else {
    api.logger?.error?.("[wildfire] failed to connect");
    client = null;
    throw new Error("Failed to connect to Wildfire IM");
  }
}

/** Disconnect and release the client. */
export async function stopClient(api?: any): Promise<void> {
  if (client) {
    try {
      client.close();
      api?.logger?.info?.("[wildfire] disconnected");
    } catch (err) {
      api?.logger?.error?.("[wildfire] error stopping:", err);
    }
    client = null;
    connected = false;
  }
}
