import { RobotServiceClient } from '@wildfirechat/robot-gateway-client-sdk';
import {
  init,
  TextMessageContent,
  ImageMessageContent,
  VideoMessageContent,
  FileMessageContent,
  StreamingTextGeneratingMessageContent,
  StreamingTextGeneratedMessageContent,
} from '@wildfirechat/server-sdk';

// Initialize server-sdk model factory.
// The actual IM calls go through the gateway WebSocket; admin URL/secret are placeholders.
init('http://localhost:18080', 'dummy');

const CONV_TYPE_SINGLE = 0;
const CONV_TYPE_GROUP = 1;

export class WildfireClient {
  constructor(config, messageHandler) {
    this.config = config;
    this.connected = false;
    this.client = new RobotServiceClient(
      config.gatewayUrl,
      {
        onMessage: (message) => messageHandler?.(message),
        onConnectionChanged: (isConnected) => {
          this.connected = isConnected;
          console.log(`[wildfire] connection changed: ${isConnected}`);
        },
        onError: (error) => {
          console.error('[wildfire] client error:', error);
        },
      },
      {
        timeout: 30,
        reconnectInterval: 5000,
        heartbeatInterval: 180000,
      }
    );
  }

  async connect() {
    const ok = await this.client.connect(this.config.robotId, this.config.robotSecret);
    if (ok) {
      this.connected = true;
      console.log(`[wildfire] connected as ${this.config.robotId}`);
    } else {
      throw new Error('[wildfire] failed to connect');
    }
    return ok;
  }

  close() {
    this.client.close();
    this.connected = false;
  }

  isConnected() {
    return this.connected && this.client.isConnected();
  }

  /**
   * Send a unified message to Wildfire IM.
   * @param {object} unified - UnifiedMessage
   */
  async send(unified) {
    const { conversation } = resolveConversation(unified);
    const payload = buildPayload(unified);
    const result = await this.client.sendMessage(conversation, payload);
    if (!result.isSuccess()) {
      throw new Error(`[wildfire] send failed: ${result.getMsg()}`);
    }
    return result.getResult();
  }

  async uploadFile(buffer, fileName, mediaType = 4, mimeType = 'application/octet-stream') {
    const result = await this.client.uploadFile(buffer, fileName, mediaType, mimeType);
    if (!result.isSuccess()) {
      throw new Error(`[wildfire] upload failed: ${result.getMsg()}`);
    }
    return result.getResult();
  }
}

function resolveConversation(unified) {
  const isGroup = unified.isGroup;
  const target = isGroup ? unified.sessionId.replace(/^group:/, '') : unified.senderId;
  const conversation = {
    type: isGroup ? CONV_TYPE_GROUP : CONV_TYPE_SINGLE,
    target,
    line: 0,
  };
  return { conversation, target };
}

function buildPayload(unified) {
  const { streamId, state } = unified.extra || {};

  if (streamId) {
    if (state === 'generating' || state === 'start') {
      const content = new StreamingTextGeneratingMessageContent();
      content.text = unified.text || '';
      content.streamId = streamId;
      return content.encode();
    }
    if (state === 'completed') {
      const content = new StreamingTextGeneratedMessageContent();
      content.text = unified.text || '';
      content.streamId = streamId;
      return content.encode();
    }
  }

  if (unified.mediaUrl) {
    return buildMediaPayload(unified);
  }

  const content = new TextMessageContent();
  content.content = unified.text || '';
  return content.encode();
}

function buildMediaPayload(unified) {
  const mediaType = unified.mediaType?.toLowerCase();
  const url = unified.mediaUrl;

  if (mediaType === 'image') {
    const content = new ImageMessageContent();
    content.remoteMediaUrl = url;
    content.searchableContent = unified.text || '[图片]';
    return content.encode();
  }

  if (mediaType === 'video') {
    const content = new VideoMessageContent();
    content.remoteMediaUrl = url;
    content.searchableContent = unified.text || '[视频]';
    return content.encode();
  }

  const content = new FileMessageContent();
  content.remoteMediaUrl = url;
  content.searchableContent = unified.text || '[文件]';
  return content.encode();
}

export function parseWildfireTarget(sessionId) {
  if (sessionId.startsWith('group:')) {
    return { id: sessionId.slice(6), isGroup: true };
  }
  if (sessionId.startsWith('user:')) {
    return { id: sessionId.slice(5), isGroup: false };
  }
  return { id: sessionId, isGroup: false };
}
