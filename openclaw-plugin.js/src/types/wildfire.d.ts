declare module '@wildfirechat/robot-gateway-client-sdk' {
  export class RobotServiceClient {
    constructor(
      gatewayUrl: string,
      messageHandler: {
        onMessage?: (message: any) => void;
        onConnectionChanged?: (connected: boolean) => void;
        onError?: (error: Error) => void;
      },
      options?: {
        timeout?: number;
        reconnectInterval?: number;
        heartbeatInterval?: number;
        /** 机器人平台号（ProtoConstants.Platform：7=Linux, 5=WEB ...），连接网关时上报。 */
        platform?: number;
      }
    );
    connect(robotId: string, robotSecret: string, timeoutSeconds?: number, platform?: number): Promise<boolean>;
    close(): void;
    sendMessage(conversation: any, payload: any): Promise<IMResult<any>>;
    uploadFile(fileData: Buffer, fileName: string, fileType: number, mimeType: string): Promise<IMResult<string>>;
    getUserInfo(userId: string): Promise<IMResult<any>>;
    getProfile(): Promise<IMResult<any>>;
    isConnected(): boolean;
    isAuthenticated(): boolean;
  }

  export interface IMResult<T> {
    isSuccess(): boolean;
    getCode(): number;
    getMsg(): string;
    getResult(): T;
  }
}

declare module '@wildfirechat/server-sdk' {
  export class Conversation {
    type: number;
    target: string;
    line: number;
  }

  export enum ConversationType {
    Single = 0,
    Group = 1,
    ChatRoom = 2,
    Channel = 3
  }

  export class MessagePayload {
    type: number;
    searchableContent?: string;
    content?: string;
    remoteMediaUrl?: string;
    extra?: string;
  }

  export class MessageContent {
    encode(): MessagePayload;
  }

  export class TextMessageContent extends MessageContent {
    content: string;
  }

  export class ImageMessageContent extends MessageContent {
    constructor(localPath: string | null, remoteUrl: string | null, extra: any);
  }

  export class VideoMessageContent extends MessageContent {
    constructor(localPath: string | null, remoteUrl: string | null, thumbnail: any, duration: number);
  }

  export class FileMessageContent extends MessageContent {
    constructor(localPath: string | null, remoteUrl: string | null, name: string, size: number);
  }

  export function init(serverUrl: string, adminSecret: string): void;
}
