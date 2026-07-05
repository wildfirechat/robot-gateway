import { WildfireClient } from '../wildfire/WildfireClient.js';
import { toUnified } from '../wildfire/MessageConverter.js';
import { CcConnectClient } from '../ccconnect/CcConnectClient.js';
import { toBridgeMessage, fromBridgeMessage, decodeBase64Media } from '../ccconnect/MessageConverter.js';
import { WhitelistFilter } from '../filter/WhitelistFilter.js';
import { GroupFilter } from '../filter/GroupFilter.js';
import { SessionManager } from '../session/SessionManager.js';

export class CcConnectBridge {
  constructor(config) {
    this.config = config;
    this.wildfireConfig = config.getWildfireConfig();
    this.ccConnectConfig = config.getCcConnectConfig();
    this.filterConfig = config.getFilterConfig();

    this.whitelistFilter = new WhitelistFilter(this.filterConfig);
    this.groupFilter = new GroupFilter(this.filterConfig);
    this.sessionManager = new SessionManager();

    this.wildfireClient = null;
    this.ccConnectClient = null;
  }

  async start() {
    console.log('[bridge] starting...');

    this.wildfireClient = new WildfireClient(this.wildfireConfig, (msg) =>
      this.handleWildfireMessage(msg)
    );
    await this.wildfireClient.connect();

    try {
      this.ccConnectClient = new CcConnectClient(this.ccConnectConfig, {
        onMessage: (frame) => this.handleCcConnectFrame(frame),
        onPreviewStart: (frame) => this.handlePreviewStart(frame),
        onConnectionChanged: (connected) => {
          console.log(`[cc-connect] connection changed: ${connected}`);
        },
        onError: (error) => {
          console.error('[cc-connect] error:', error.message);
        },
      });
      await this.ccConnectClient.connect();
    } catch (error) {
      this.wildfireClient?.close();
      throw error;
    }

    console.log('[bridge] started');
  }

  async stop() {
    console.log('[bridge] stopping...');
    this.ccConnectClient?.close();
    this.wildfireClient?.close();
    console.log('[bridge] stopped');
  }

  async handleWildfireMessage(pushMessage) {
    try {
      const unified = toUnified(pushMessage);
      if (!unified) return;

      const { senderId, sessionId, isGroup, extra } = unified;
      const targetId = extra?.wildfire?.target || '';
      const messageId = unified.id;

      // Skip self messages
      if (String(senderId) === this.wildfireConfig.robotId) return;

      // Deduplication
      if (this.sessionManager.isDuplicate(messageId)) {
        console.log(`[bridge] duplicate message ignored: ${messageId}`);
        return;
      }

      // Whitelist
      if (!this.whitelistFilter.shouldProcess(senderId, targetId, isGroup)) {
        console.log(`[bridge] message blocked by whitelist: ${senderId} / ${targetId}`);
        await this.sendDeniedMessage(sessionId);
        return;
      }

      // Group filter
      const messageData = pushMessage.data || pushMessage;
      if (isGroup && !this.groupFilter.shouldRespond(unified.text, messageData, this.wildfireConfig.robotId)) {
        console.log(`[bridge] group message ignored by filter: ${sessionId}`);
        return;
      }

      // Record session for outbound routing
      this.sessionManager.recordInbound(unified);

      // Build cc-connect bridge message and forward it
      const { message, streamId } = toBridgeMessage(unified);
      this.sessionManager.recordStream(streamId, { sessionId, senderId, isGroup });

      console.log(`[bridge] wildfire -> cc-connect: session=${sessionId}, stream=${streamId}`);
      this.ccConnectClient.sendMessage(message);
    } catch (error) {
      console.error('[bridge] handle wildfire message error:', error);
    }
  }

  async handlePreviewStart(frame) {
    try {
      const streamId = frame.reply_ctx;
      const ctx = this.sessionManager.resolveStream(streamId);
      if (!ctx) {
        console.warn(`[bridge] preview_start for unknown stream: ${streamId}`);
        return;
      }

      // Create a streaming placeholder in IM
      await this.sendToWildfire({
        id: `stream-start-${Date.now()}`,
        sessionId: ctx.sessionId,
        senderId: ctx.senderId,
        isGroup: ctx.isGroup,
        text: frame.content || '...',
        timestamp: Date.now(),
        extra: { streamId, state: 'start' },
      });

      // Acknowledge with our IM message handle (streamId)
      this.ccConnectClient.sendPreviewAck(frame.ref_id, streamId);
    } catch (error) {
      console.error('[bridge] handle preview_start error:', error);
    }
  }

  async handleCcConnectFrame(frame) {
    try {
      const type = frame.type;

      if (type === 'reply_stream') {
        const streamId = frame.reply_ctx || frame.preview_handle;
        const ctx = this.sessionManager.resolveStream(streamId);
        if (!ctx) {
          console.warn(`[bridge] reply_stream for unknown stream: ${streamId}`);
          return;
        }
        await this.sendToWildfire({
          id: `cc-stream-${Date.now()}`,
          sessionId: ctx.sessionId,
          senderId: ctx.senderId,
          isGroup: ctx.isGroup,
          text: frame.full_text || frame.delta || '',
          timestamp: Date.now(),
          extra: { streamId, state: frame.done ? 'completed' : 'generating', delta: frame.delta, done: frame.done },
        });
        if (frame.done) {
          this.sessionManager.releaseStream(streamId);
        }
        return;
      }

      const unified = fromBridgeMessage(frame);
      if (!unified) {
        console.log(`[bridge] cc-connect frame ignored: ${type}`);
        return;
      }

      const streamId = unified.extra?.streamId;
      const ctx = streamId ? this.sessionManager.resolveStream(streamId) : null;

      // Resolve session context from stream or session_key
      let resolvedSessionId = unified.sessionId;
      let resolvedSenderId = unified.senderId;
      let resolvedIsGroup = unified.isGroup;

      if (ctx) {
        resolvedSessionId = ctx.sessionId;
        resolvedSenderId = ctx.senderId;
        resolvedIsGroup = ctx.isGroup;
      } else if (unified.sessionId) {
        const session = this.sessionManager.resolve(unified.sessionId);
        if (session) {
          resolvedSessionId = session.sessionId;
          resolvedSenderId = session.senderId;
          resolvedIsGroup = session.isGroup;
        } else {
          // Fallback: parse from cc-connect session_key
          const parsed = parseSessionKey(unified.sessionId);
          resolvedSessionId = parsed.sessionId;
          resolvedSenderId = parsed.senderId;
          resolvedIsGroup = parsed.isGroup;
        }
      }

      unified.sessionId = resolvedSessionId;
      unified.senderId = resolvedSenderId;
      unified.isGroup = resolvedIsGroup;

      // Base64 media from cc-connect needs to be uploaded to Wildfire
      if (unified.mediaUrl && unified.extra?.base64) {
        const uploadedUrl = await this.uploadMediaToWildfire(unified.extra);
        if (uploadedUrl) {
          unified.mediaUrl = uploadedUrl;
        }
      }

      await this.sendToWildfire(unified);

      if (unified.extra?.state === 'completed') {
        this.sessionManager.releaseStream(streamId);
      }
    } catch (error) {
      console.error('[bridge] handle cc-connect frame error:', error);
    }
  }

  async sendToWildfire(unified) {
    try {
      if (unified.text) {
        unified.text = unified.text.replace(/\r/g, '');
      }
      await this.wildfireClient.send(unified);
    } catch (error) {
      console.error('[bridge] send to wildfire error:', error);
    }
  }

  async sendDeniedMessage(sessionId) {
    try {
      const session = this.sessionManager.resolve(sessionId);
      await this.sendToWildfire({
        id: `deny-${Date.now()}`,
        sessionId,
        senderId: session?.senderId || '',
        isGroup: session?.isGroup ?? sessionId.startsWith('group:'),
        text: this.whitelistFilter.getDeniedMessage(),
        timestamp: Date.now(),
        extra: {},
      });
    } catch (error) {
      console.error('[bridge] send denied message error:', error);
    }
  }

  async uploadMediaToWildfire(extra) {
    try {
      const { buffer, mimeType, fileName } = decodeBase64Media(
        extra.base64,
        extra.mimeType || 'application/octet-stream',
        extra.fileName || 'file'
      );
      const mediaType = mediaTypeFromMime(mimeType);
      const result = await this.wildfireClient.uploadFile(buffer, fileName, mediaType, mimeType);
      return result;
    } catch (error) {
      console.error('[bridge] upload media to wildfire error:', error);
      return null;
    }
  }

  isHealthy() {
    return this.wildfireClient?.isConnected() === true && this.ccConnectClient?.isConnected() === true;
  }

  getStatus() {
    return {
      wildfire: {
        connected: this.wildfireClient?.isConnected() === true,
      },
      ccconnect: {
        connected: this.ccConnectClient?.isConnected() === true,
      },
      healthy: this.isHealthy(),
      sessions: this.sessionManager.sessions.size,
    };
  }
}

function mediaTypeFromMime(mimeType) {
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 3;
  if (mime.startsWith('video/')) return 6;
  if (mime.startsWith('audio/')) return 4; // Wildfire uses file/voice generic; send as file
  return 4;
}

function parseSessionKey(sessionId) {
  // cc-connect session_key format: {platform}:{scope}:{user_id}
  // For direct chat: scope === user_id
  // For group chat: scope is group_id, user_id is sender
  const parts = sessionId.split(':');
  if (parts.length < 3) {
    return { sessionId, senderId: '', isGroup: false };
  }
  const scope = parts[1];
  const userId = parts[2];

  if (scope === userId) {
    return {
      sessionId: `user:${userId}`,
      senderId: userId,
      isGroup: false,
    };
  }
  return {
    sessionId: `group:${scope}`,
    senderId: userId,
    isGroup: true,
  };
}
