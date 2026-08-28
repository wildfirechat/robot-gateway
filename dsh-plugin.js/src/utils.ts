/**
 * Utility functions: group-chat trigger policy and payload extraction.
 * Logic mirrors the openclaw plugin (`openclaw-plugin.js/src/utils.ts`).
 */

import type { WildfireConfig } from "./config.js";

/** Message payload type constants (Wildfire IM). */
export const MESSAGE_TYPE_TEXT = 1;
export const MESSAGE_TYPE_VOICE = 2;
export const MESSAGE_TYPE_IMAGE = 3;
export const MESSAGE_TYPE_VIDEO = 4;
export const MESSAGE_TYPE_FILE = 5;

/** Conversation type constants (Wildfire IM). */
export const CONV_TYPE_SINGLE = 0;
export const CONV_TYPE_GROUP = 1;
export const CONV_TYPE_CHANNEL = 2;

/**
 * Decide whether a group message should trigger a reply.
 *
 * Default (`requireMention` unset or false): every group message triggers —
 * no @mention required.
 * With `requireMention: true`: @mention / question-mark suffix / help
 * keywords trigger, otherwise the group stays quiet.
 */
export function shouldRespondToGroupMessage(
  text: string,
  messageData: any,
  config: WildfireConfig
): boolean {
  const mentionRequired = config.requireMention === true;

  // mention mode: @mention, question mark suffix, or help keywords trigger
  if (mentionRequired) {
    if (isMentioned(messageData, config.robotId)) {
      return true;
    }
    if (/.*[？?]$/.test(text)) {
      return true;
    }
    const keywords = (config.helpKeywords || "帮,请,分析,总结")
      .split(",")
      .map((k: string) => k.trim())
      .filter(Boolean);
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return true;
      }
    }
    return false;
  }

  // default: all group messages trigger
  return true;
}

/**
 * Wildfire IM mention rules:
 * - mentionedType === 2: @everyone -> reply
 * - mentionedType === 1: @specific users -> reply only when the bot is among them
 */
function isMentioned(messageData: any, robotId?: string): boolean {
  try {
    const payload = messageData.payload;
    if (!payload) return false;
    const mentionedType = payload.mentionedType;
    if (mentionedType === 2) return true;
    if (mentionedType === 1) {
      const targets = payload.mentionedTarget;
      if (Array.isArray(targets) && targets.length > 0) {
        if (robotId) return targets.includes(robotId);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Extract text and optional media URL from a message payload. */
export function extractPayloadInfo(payload: any): { text: string; mediaUrl?: string } {
  const mediaUrl = pickMediaUrl(payload);
  switch (payload?.type) {
    case MESSAGE_TYPE_TEXT:
      return { text: payload.searchableContent || payload.content || "" };
    case MESSAGE_TYPE_VOICE: {
      const duration = payload.duration ? ` ${payload.duration}s` : "";
      return { text: `[语音${duration}]`, mediaUrl };
    }
    case MESSAGE_TYPE_IMAGE:
      return { text: "[图片]", mediaUrl };
    case MESSAGE_TYPE_VIDEO:
      return { text: "[视频]", mediaUrl };
    case MESSAGE_TYPE_FILE:
      return { text: `[文件] ${payload.searchableContent || ""}`, mediaUrl };
    default:
      return { text: `${payload?.searchableContent || "暂不支持的消息类型: " + payload?.type}` };
  }
}

function pickMediaUrl(payload: any): string | undefined {
  const candidates = [
    payload?.remoteMediaUrl,
    payload?.mediaUrl,
    payload?.remoteUrl,
    payload?.url,
  ];
  const normalized = candidates
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .find((v) => !!v);
  return normalized || undefined;
}

/** Compact preview for log lines. */
export function safePreview(value: string, maxLen = 120): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

/**
 * IM conversation key for a message. Lowercased so the key is stable across
 * client casings and matches the deterministic dsh SessionId derivation.
 */
export function conversationKey(isGroup: boolean, targetId: string): string {
  return (isGroup ? `wildfire:group:${targetId}` : `wildfire:user:${targetId}`).toLowerCase();
}

/** 结构化深比较（键顺序无关），用于状态去重等场景。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}
