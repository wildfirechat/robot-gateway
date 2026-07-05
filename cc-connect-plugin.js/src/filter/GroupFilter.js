export class GroupFilter {
  constructor(config) {
    this.config = config.group || {};
  }

  shouldRespond(text, messageData, robotId) {
    if (!this.config.enabled) return true;

    const targetId = messageData?.conv?.target;
    const allowedGroupIds = this.config.allowedGroupIds || [];
    if (allowedGroupIds.length > 0 && !allowedGroupIds.includes(String(targetId))) {
      return false;
    }

    if (this.config.requireMention !== false) {
      if (isMentioned(messageData, robotId)) return true;
    }

    if (this.config.respondOnQuestion !== false) {
      if (/.*[？?]$/.test(String(text || '').trim())) return true;
    }

    const keywords = (this.config.helpKeywords || '帮,请,分析,总结')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (keywords.some((k) => String(text || '').includes(k))) return true;

    if (this.config.requireMention !== false) return false;

    return true;
  }
}

function isMentioned(messageData, robotId) {
  try {
    const payload = messageData?.payload;
    if (!payload) return false;

    if (payload.mentionedType === 2) return true;
    if (payload.mentionedType === 1) {
      const targets = payload.mentionedTarget;
      if (Array.isArray(targets) && targets.length > 0) {
        return robotId ? targets.includes(robotId) : true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
