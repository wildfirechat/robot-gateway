export class WhitelistFilter {
  constructor(config) {
    this.config = config.whitelist || {};
  }

  shouldProcess(senderId, targetId, isGroup) {
    if (!this.config.enabled) return true;

    const allowedUsers = this.config.allowedUsers || [];
    if (allowedUsers.length > 0 && allowedUsers.includes(String(senderId))) {
      return true;
    }

    if (isGroup) {
      const allowedGroups = this.config.allowedGroups || [];
      if (allowedGroups.length > 0 && allowedGroups.includes(String(targetId))) {
        return true;
      }
    }

    return false;
  }

  getDeniedMessage() {
    return this.config.deniedMessage || '未授权使用';
  }
}
