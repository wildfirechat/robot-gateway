import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

const PLATFORM = 'wildfire';

/**
 * Build a cc-connect Bridge `message` frame from a UnifiedMessage.
 */
export function toBridgeMessage(unifiedMessage) {
  const { sessionId, senderId, senderName, text, mediaUrl, mediaType, mentions, extra } = unifiedMessage;
  const { scope, userId } = parseSessionId(sessionId, senderId);
  const streamId = extra?.streamId || `stream-${randomUUID()}`;

  const message = {
    type: 'message',
    msg_id: unifiedMessage.id,
    session_key: `${PLATFORM}:${scope}:${userId}`,
    user_id: userId,
    user_name: senderName || userId,
    content: text || '',
    reply_ctx: streamId,
  };

  if (mediaUrl) {
    if (mediaType === 'image') {
      message.images = [{ url: mediaUrl }];
    } else if (mediaType === 'audio' || mediaType === 'voice') {
      message.audio = { url: mediaUrl };
    } else {
      message.files = [{ url: mediaUrl, file_name: fileNameFromUrl(mediaUrl) }];
    }
  }

  return { message, streamId };
}

/**
 * Convert an incoming cc-connect frame to a UnifiedMessage (or array of them).
 * Returns null for frames that don't carry user-visible content.
 */
export function fromBridgeMessage(frame) {
  switch (frame.type) {
    case 'reply':
      return {
        id: `cc-reply-${Date.now()}`,
        sessionId: sessionIdFromBridge(frame.session_key),
        senderId: '',
        isGroup: isGroupSessionKey(frame.session_key),
        text: frame.content || '',
        timestamp: Date.now(),
        extra: {
          streamId: frame.reply_ctx,
          state: 'completed',
          format: frame.format || 'text',
        },
      };

    case 'reply_stream':
      return {
        id: `cc-stream-${Date.now()}`,
        sessionId: sessionIdFromBridge(frame.session_key),
        senderId: '',
        isGroup: isGroupSessionKey(frame.session_key),
        text: frame.full_text || frame.delta || '',
        timestamp: Date.now(),
        extra: {
          streamId: frame.reply_ctx || frame.preview_handle,
          state: frame.done ? 'completed' : 'generating',
          delta: frame.delta,
          done: frame.done,
        },
      };

    case 'update_message':
      return {
        id: `cc-update-${Date.now()}`,
        sessionId: sessionIdFromBridge(frame.session_key),
        senderId: '',
        isGroup: isGroupSessionKey(frame.session_key),
        text: frame.content || '',
        timestamp: Date.now(),
        extra: {
          streamId: frame.preview_handle,
          state: 'generating',
        },
      };

    case 'image':
      return {
        id: `cc-image-${Date.now()}`,
        sessionId: sessionIdFromBridge(frame.session_key),
        senderId: '',
        isGroup: isGroupSessionKey(frame.session_key),
        text: '',
        mediaUrl: dataUrlFromBase64(frame.data, frame.mime_type, frame.file_name),
        mediaType: 'image',
        timestamp: Date.now(),
        extra: {
          streamId: frame.reply_ctx,
          state: 'completed',
          base64: frame.data,
          mimeType: frame.mime_type,
          fileName: frame.file_name,
        },
      };

    case 'file':
      return {
        id: `cc-file-${Date.now()}`,
        sessionId: sessionIdFromBridge(frame.session_key),
        senderId: '',
        isGroup: isGroupSessionKey(frame.session_key),
        text: '',
        mediaUrl: dataUrlFromBase64(frame.data, frame.mime_type, frame.file_name),
        mediaType: 'file',
        timestamp: Date.now(),
        extra: {
          streamId: frame.reply_ctx,
          state: 'completed',
          base64: frame.data,
          mimeType: frame.mime_type,
          fileName: frame.file_name,
        },
      };

    case 'audio':
      return {
        id: `cc-audio-${Date.now()}`,
        sessionId: sessionIdFromBridge(frame.session_key),
        senderId: '',
        isGroup: isGroupSessionKey(frame.session_key),
        text: '',
        mediaUrl: dataUrlFromBase64(frame.data, frame.format ? `audio/${frame.format}` : 'audio/mpeg', 'audio'),
        mediaType: 'audio',
        timestamp: Date.now(),
        extra: {
          streamId: frame.reply_ctx,
          state: 'completed',
          base64: frame.data,
          format: frame.format,
        },
      };

    case 'card':
      return {
        id: `cc-card-${Date.now()}`,
        sessionId: sessionIdFromBridge(frame.session_key),
        senderId: '',
        isGroup: isGroupSessionKey(frame.session_key),
        text: cardToText(frame.card),
        timestamp: Date.now(),
        extra: {
          streamId: frame.reply_ctx,
          state: 'completed',
          card: frame.card,
        },
      };

    case 'buttons':
      return {
        id: `cc-buttons-${Date.now()}`,
        sessionId: sessionIdFromBridge(frame.session_key),
        senderId: '',
        isGroup: isGroupSessionKey(frame.session_key),
        text: buttonsToText(frame.content, frame.buttons),
        timestamp: Date.now(),
        extra: {
          streamId: frame.reply_ctx,
          state: 'completed',
          buttons: frame.buttons,
        },
      };

    case 'typing_start':
    case 'typing_stop':
    case 'preview_start':
    case 'delete_message':
    case 'error':
    default:
      return null;
  }
}

function parseSessionId(sessionId, senderId) {
  if (sessionId.startsWith('group:')) {
    return { scope: sessionId.slice(6), userId: senderId };
  }
  if (sessionId.startsWith('user:')) {
    const id = sessionId.slice(5);
    return { scope: id, userId: id };
  }
  return { scope: sessionId, userId: senderId || sessionId };
}

function sessionIdFromBridge(sessionKey) {
  const parts = sessionKey.split(':');
  if (parts.length < 3) return sessionKey;
  const platform = parts[0];
  const scope = parts[1];
  const userId = parts[2];
  // In direct chat, scope === userId. We normalize back to internal user:
  if (scope === userId) {
    return `user:${userId}`;
  }
  return `group:${scope}`;
}

function isGroupSessionKey(sessionKey) {
  const parts = sessionKey.split(':');
  if (parts.length < 3) return false;
  return parts[1] !== parts[2];
}

function fileNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split('/').pop() || 'file';
  } catch {
    return 'file';
  }
}

function dataUrlFromBase64(data, mimeType, fileName) {
  if (!data) return null;
  const mime = mimeType || 'application/octet-stream';
  return `data:${mime};base64,${data}`;
}

function cardToText(card) {
  if (!card) return '';
  const lines = [];
  if (card.header?.title) {
    lines.push(card.header.title);
  }
  if (Array.isArray(card.elements)) {
    for (const el of card.elements) {
      switch (el.type) {
        case 'markdown':
          lines.push(el.content || '');
          break;
        case 'note':
          lines.push(el.text || '');
          break;
        case 'actions':
          if (Array.isArray(el.buttons)) {
            lines.push(el.buttons.map((b) => `[${b.text}](${b.value})`).join(' | '));
          }
          break;
        case 'list_item':
          lines.push(`${el.text} [${el.btn_text}](${el.btn_value})`);
          break;
        case 'select':
          lines.push(
            `${el.placeholder || ''}: ` +
              (Array.isArray(el.options) ? el.options.map((o) => `${o.text}(${o.value})`).join(' | ') : '')
          );
          break;
        case 'divider':
          lines.push('---');
          break;
        default:
          break;
      }
    }
  }
  return lines.join('\n');
}

function buttonsToText(content, buttons) {
  const lines = [content || ''];
  if (Array.isArray(buttons)) {
    for (const row of buttons) {
      if (Array.isArray(row)) {
        lines.push(row.map((b) => `[${b.text}](${b.data})`).join(' | '));
      }
    }
  }
  return lines.join('\n');
}

/**
 * Decode a base64 data URL / plain base64 string into a Buffer and extract mime type + file name.
 */
export function decodeBase64Media(input, fallbackMimeType = 'application/octet-stream', fallbackFileName = 'file') {
  let data = input;
  let mimeType = fallbackMimeType;
  let fileName = fallbackFileName;

  if (typeof input === 'string' && input.startsWith('data:')) {
    const match = input.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      data = match[2];
    }
  }

  const buffer = Buffer.from(data, 'base64');
  return { buffer, mimeType, fileName };
}
