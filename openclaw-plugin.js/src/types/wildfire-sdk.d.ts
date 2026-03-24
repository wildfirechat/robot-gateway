/**
 * Type declarations for @wildfirechat/server-sdk
 */

declare module "@wildfirechat/server-sdk" {
  export class RobotService {
    constructor(url: string, robotId: string, robotSecret: string, timeout?: number);
    sendMessage(sender: string, conversation: any, payload: any): Promise<any>;
    sendMessageWithOptions(
      sender: string,
      conversation: any,
      payload: any,
      toUsers?: string[] | null,
    ): Promise<any>;
    uploadFile(filePathOrFileBuffer: string | Buffer, mediaType?: number, contentType?: string): Promise<any>;
  }

  export class MessageContent {
    constructor(type?: number);
    encode(): any;
    decode(payload: any): void;
  }

  export class TextMessageContent extends MessageContent {
    constructor();
    content: string;
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

  export class ImageMessageContent extends MessageContent {
    constructor(mediaType: any, remoteUrl: string | null, localPath: string | null);
  }

  export interface Conversation {
    type: number;
    target: string;
    line: number;
  }

  export function init(url: string, secret: string): void;
}
