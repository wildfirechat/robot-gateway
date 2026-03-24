/**
 * Wildfire IM client management (Single Account)
 */

import { RobotServiceClient } from "@wildfirechat/robot-gateway-client-sdk";
import { RobotService } from "@wildfirechat/server-sdk";
import type { WildfireConfig } from "./config.js";
import { handleIncomingMessage } from "./inbound.js";

// Single client instance
let client: RobotServiceClient | null = null;
let connected = false;

type RobotServiceSender = {
  sendMessage: (conversation: any, payload: any, toUsers?: string[] | null) => Promise<any>;
  uploadFile: (filePathOrFileBuffer: string | Buffer, mediaType?: number, contentType?: string) => Promise<any>;
};

let robotServiceSender: RobotServiceSender | null = null;

/**
 * Check if client is connected
 */
export function isClientConnected(): boolean {
  return connected && client !== null;
}

/**
 * Start the client
 */
export async function startClient(api: any, config: WildfireConfig): Promise<void> {
  if (client) {
    api.logger?.warn?.("[wildfire] client already exists");
    return;
  }

  client = new RobotServiceClient(
    config.imUrl!,
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
      heartbeatInterval: 270000,
    }
  );

  const isConn = await client.connect(config.robotId!, config.robotSecret!);

  const robotService = new RobotService(config.imUrl!, config.robotId!, config.robotSecret!);
  robotServiceSender = {
    sendMessage: (conversation: any, payload: any, toUsers?: string[] | null) =>
      robotService.sendMessageWithOptions(config.robotId!, conversation, payload, toUsers ?? null),
    uploadFile: (filePathOrFileBuffer: string | Buffer, mediaType?: number, contentType?: string) =>
      robotService.uploadFile(filePathOrFileBuffer, mediaType, contentType),
  };

  if (isConn) {
    connected = true;
    api.logger?.info?.(`[wildfire] connected as ${config.robotId}`);
    api.logger?.info?.(`[wildfire] robot service sender ready: ${config.imUrl}`);
  } else {
    api.logger?.error?.(`[wildfire] failed to connect`);
    throw new Error("Failed to connect to Wildfire IM");
  }
}

/**
 * Get the client instance
 */
export function getClient(): RobotServiceClient | null {
  return client;
}

/**
 * Get connected client (checks connection status)
 */
export function getConnectedClient(): RobotServiceClient | null {
  if (client && connected) {
    return client;
  }
  return null;
}

/**
 * Get RobotService sender for outbound sendText/sendMedia
 */
export function getRobotServiceSender(): RobotServiceSender | null {
  return robotServiceSender;
}

/**
 * Stop the client
 */
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
    robotServiceSender = null;
  }
}

