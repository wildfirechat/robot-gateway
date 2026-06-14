/**
 * Wildfire IM client management (Single Account)
 */

import { RobotServiceClient } from "@wildfirechat/robot-gateway-client-sdk";
import type { WildfireConfig } from "./config.js";
import { handleIncomingMessage } from "./inbound.js";

// Single client instance
let client: RobotServiceClient | null = null;
let connected = false;

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
      heartbeatInterval: 270000,
    }
  );

  const isConn = await client.connect(config.robotId!, config.robotSecret!);

  if (isConn) {
    connected = true;
    api.logger?.info?.(`[wildfire] connected as ${config.robotId}`);
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
  }
}

