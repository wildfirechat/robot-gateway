/**
 * Minimal ambient type declarations for the plain-JS wildfire SDK packages.
 * Only the surface used by this plugin is declared.
 */

declare module "@wildfirechat/robot-gateway-client-sdk" {
  export interface MessageHandler {
    onMessage?(message: any): void;
    onConnectionChanged?(connected: boolean): void;
    onError?(error: Error): void;
  }

  export interface ClientOptions {
    timeout?: number;
    reconnectInterval?: number;
    heartbeatInterval?: number;
  }

  export class RobotServiceClient {
    constructor(gatewayUrl: string, messageHandler?: MessageHandler | null, options?: ClientOptions);
    connect(robotId: string, robotSecret: string, timeoutSeconds?: number): Promise<boolean>;
    close(): void;
    isConnected(): boolean;
    isAuthenticated(): boolean;
    sendMessage(conversation: any, payload: any): Promise<any>;
    uploadFile(fileData: Buffer, fileName: string, messageContentMediaType?: number, mimeType?: string): Promise<any>;
    getGroupInfo(groupId: string): Promise<{ code: number; msg?: string; result?: any }>;
    getProfile(): Promise<{ code: number; msg?: string; result?: { owner?: string } & Record<string, any> }>;
    createGroup(groupInfo: any, members: any[], to: string, lines: number[], payload: any): Promise<{ code: number; msg?: string; result?: { group_id?: string } }>;
    updateConversationUserSetting(conversation: any, type: number, value: string): Promise<{ code: number; msg?: string }>;
    dismissGroup(groupId: string): Promise<{ code: number; msg?: string }>;
    updateMessage(messageId: string, payload: any): Promise<{ code: number; msg?: string }>;
  }
}

declare module "@wildfirechat/server-sdk" {
  export class MessageContent {
    constructor(type?: number);
    encode(): any;
    decode(payload: any): void;
  }

  export class TextMessageContent extends MessageContent {
    constructor();
    content: string;
  }

  export class ImageMessageContent extends MessageContent {
    constructor(mediaType: any, remoteUrl: string | null, localPath: string | null);
  }

  export class FileMessageContent extends MessageContent {
    constructor(mediaType: any, remoteUrl: string | null, name: string | null, size: number);
  }

  export class StreamingTextGeneratingMessageContent extends MessageContent {
    constructor();
    text: string;
    streamId: string;
  }

  export class StreamingTextGeneratedMessageContent extends MessageContent {
    constructor();
    text: string;
    streamId: string;
  }

  export interface Conversation {
    type: number;
    target: string;
    line: number;
  }
}
