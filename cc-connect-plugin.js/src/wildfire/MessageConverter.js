import { randomUUID } from 'node:crypto';

const MESSAGE_TYPE_TEXT = 1;
const MESSAGE_TYPE_VOICE = 2;
const MESSAGE_TYPE_IMAGE = 3;
const MESSAGE_TYPE_VIDEO = 4;
const MESSAGE_TYPE_FILE = 5;

const CONV_TYPE_SINGLE = 0;
const CONV_TYPE_GROUP = 1;
const CONV_TYPE_CHANNEL = 2;

/**
 * Convert a Wildfire PushMessage to UnifiedMessage.
 */
export function toUnified(pushMessage) {
  const data = pushMessage.data || pushMessage;
  const sender = data.sender;
  const conv = data.conv;
  const payload = data.payload;

  if (!sender || !conv || !payload) {
    return null;
  }

  const payloadType = payload.type;
  if (payloadType <= 0 || payloadType === 14 || (payloadType > 15 && payloadType < 100) || payloadType > 200) {
    return null;
  }

  const isGroup = conv.type === CONV_TYPE_GROUP || conv.type === CONV_TYPE_CHANNEL;
  const sessionId = isGroup ? `group:${conv.target}` : `user:${sender}`;
  const { text, mediaUrl, mediaType } = extractPayloadInfo(payload);

  const mentions = [];
  if (payload.mentionedType === 2) {
    mentions.push('@all');
  } else if (payload.mentionedType === 1 && Array.isArray(payload.mentionedTarget)) {
    mentions.push(...payload.mentionedTarget);
  }

  return {
    id: generateMessageId(data),
    sessionId,
    threadId: isGroup ? sessionId : undefined,
    senderId: String(sender),
    senderName: String(sender),
    isGroup,
    text,
    mediaUrl,
    mediaType,
    mentions,
    timestamp: Date.now(),
    extra: {
      wildfire: {
        messageId: data.messageId || data.msgId || data.mid || '',
        messageType: payloadType,
        conversationType: conv.type,
        target: conv.target,
        line: conv.line || 0,
      },
    },
  };
}

function extractPayloadInfo(payload) {
  const type = payload.type;
  let text = '';
  let mediaUrl = null;
  let mediaType = null;

  switch (type) {
    case MESSAGE_TYPE_TEXT:
      text = payload.searchableContent || payload.content || '';
      break;
    case MESSAGE_TYPE_VOICE:
      text = '[语音]';
      mediaUrl = payload.remoteMediaUrl || payload.mediaUrl || payload.remoteUrl || payload.url || '';
      mediaType = 'voice';
      break;
    case MESSAGE_TYPE_IMAGE:
      text = payload.searchableContent || '[图片]';
      mediaUrl = payload.remoteMediaUrl || payload.mediaUrl || payload.remoteUrl || payload.url || '';
      mediaType = 'image';
      break;
    case MESSAGE_TYPE_VIDEO:
      text = payload.searchableContent || '[视频]';
      mediaUrl = payload.remoteMediaUrl || payload.mediaUrl || payload.remoteUrl || payload.url || '';
      mediaType = 'video';
      break;
    case MESSAGE_TYPE_FILE:
      text = payload.searchableContent || '[文件]';
      mediaUrl = payload.remoteMediaUrl || payload.mediaUrl || payload.remoteUrl || payload.url || '';
      mediaType = 'file';
      break;
    default:
      text = payload.searchableContent || payload.content || '';
      break;
  }

  return { text, mediaUrl, mediaType };
}

function generateMessageId(data) {
  const raw = data.messageId || data.msgId || data.mid || randomUUID();
  return `wildfire-${raw}`;
}

/**
 * Check if the payload type is a media message.
 */
export function isMediaPayload(payloadType) {
  return [MESSAGE_TYPE_IMAGE, MESSAGE_TYPE_VIDEO, MESSAGE_TYPE_FILE, MESSAGE_TYPE_VOICE].includes(payloadType);
}
