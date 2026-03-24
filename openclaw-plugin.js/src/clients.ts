/**
 * Wildfire IM client management (Single Account)
 */

import { RobotService } from "@wildfirechat/server-sdk";
import type { WildfireConfig } from "./config.js";


type RobotServiceSender = {
  sendMessage: (conversation: any, payload: any, toUsers?: string[] | null) => Promise<any>;
  uploadFile: (filePathOrFileBuffer: string | Buffer, mediaType?: number, contentType?: string) => Promise<any>;
};

let robotServiceSender: RobotServiceSender | null = null;

/**
 * Start the client
 */
export async function startClient(api: any, config: WildfireConfig): Promise<void> {
  if (robotServiceSender) {
    api.logger?.warn?.("[wildfire] client already exists");
    return;
  }


  const robotService = new RobotService(config.imUrl!, config.robotId!, config.robotSecret!);
  robotServiceSender = {
    sendMessage: (conversation: any, payload: any, toUsers?: string[] | null) =>
      robotService.sendMessageWithOptions(config.robotId!, conversation, payload, toUsers ?? null),
    uploadFile: (filePathOrFileBuffer: string | Buffer, mediaType?: number, contentType?: string) =>
      robotService.uploadFile(filePathOrFileBuffer, mediaType, contentType),
  };

}

/**
 * Get RobotService sender for outbound sendText/sendMedia
 */
export function getRobotServiceSender(): RobotServiceSender | null {
  return robotServiceSender;
}
