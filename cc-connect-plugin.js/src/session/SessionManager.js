import { randomUUID } from 'node:crypto';

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.streams = new Map();
    this.recentMessageIds = new Set();
    this.recentTimestamps = [];
  }

  recordInbound(unifiedMessage) {
    const { sessionId, senderId, isGroup, extra } = unifiedMessage;
    const wf = extra?.wildfire || {};
    this.sessions.set(sessionId, {
      sessionId,
      senderId,
      isGroup,
      conversationType: wf.conversationType,
      target: wf.target,
      line: wf.line || 0,
      lastActiveAt: Date.now(),
    });
  }

  resolve(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  recordStream(streamId, context) {
    this.streams.set(streamId, {
      ...context,
      createdAt: Date.now(),
    });
  }

  resolveStream(streamId) {
    const ctx = this.streams.get(streamId);
    if (ctx) return ctx;

    // Fallback: if the stream was not explicitly recorded (e.g. cc-connect sends
    // update_message without preview_start), try to reconstruct context from the
    // streamId itself if it embeds a session reference. Not used currently.
    return null;
  }

  releaseStream(streamId) {
    this.streams.delete(streamId);
  }

  isDuplicate(messageId) {
    if (!messageId) return false;
    this._cleanupOldEntries();

    if (this.recentMessageIds.has(messageId)) {
      return true;
    }

    this.recentMessageIds.add(messageId);
    this.recentTimestamps.push({ id: messageId, ts: Date.now() });
    return false;
  }

  _cleanupOldEntries() {
    const cutoff = Date.now() - 5 * 60 * 1000; // 5 minutes
    while (this.recentTimestamps.length > 0 && this.recentTimestamps[0].ts < cutoff) {
      const entry = this.recentTimestamps.shift();
      this.recentMessageIds.delete(entry.id);
    }
  }

  generateStreamId() {
    return `stream-${randomUUID()}`;
  }
}
