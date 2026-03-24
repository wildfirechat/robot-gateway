/**
 * Configuration for Wildfire IM channel (Single Account)
 */

export interface WildfireConfig {
  enabled?: boolean;
  imUrl?: string;
  robotId?: string;
  robotSecret?: string;
  requireMention?: boolean;
  helpKeywords?: string;
  accounts?: Record<string, WildfireConfig>;
  whiteList?: {
    enabled?: boolean;
    allowedUsers?: string[];
    allowedGroups?: string[];
    deniedMessage?: string;
  };
}

/**
 * Get the effective configuration for an account
 */
export function getAccountConfig(api: any, accountId: string = "default"): WildfireConfig | null {
  const cfg: WildfireConfig = api.config.channels.wildfire || {};
  
  // If using multi-account config
  if (cfg.accounts?.[accountId]) {
    const account = cfg.accounts[accountId];
    if (account.enabled === false) return null;
    return {
      imUrl: account.imUrl ?? cfg.imUrl,
      robotId: account.robotId ?? cfg.robotId,
      robotSecret: account.robotSecret ?? cfg.robotSecret,
      requireMention: account.requireMention ?? cfg.requireMention ?? true,
      helpKeywords: account.helpKeywords ?? cfg.helpKeywords ?? "帮,请,分析,总结",
      whiteList: {
        enabled: account.whiteList?.enabled ?? cfg.whiteList?.enabled ?? false,
        allowedUsers: account.whiteList?.allowedUsers ?? cfg.whiteList?.allowedUsers ?? [],
        allowedGroups: account.whiteList?.allowedGroups ?? cfg.whiteList?.allowedGroups ?? [],
        deniedMessage: account.whiteList?.deniedMessage ?? cfg.whiteList?.deniedMessage ?? "不允许使用",
      },
    };
  }
  
  // Single account (legacy) config
  if (accountId === "default") {
    if (cfg.enabled === false) return null;
    return {
      imUrl: cfg.imUrl,
      robotId: cfg.robotId,
      robotSecret: cfg.robotSecret,
      requireMention: cfg.requireMention ?? true,
      helpKeywords: cfg.helpKeywords ?? "帮,请,分析,总结",
      whiteList: {
        enabled: cfg.whiteList?.enabled ?? false,
        allowedUsers: cfg.whiteList?.allowedUsers ?? [],
        allowedGroups: cfg.whiteList?.allowedGroups ?? [],
        deniedMessage: cfg.whiteList?.deniedMessage ?? "不允许使用",
      },
    };
  }
  
  return null;
}

/**
 * List all enabled account configurations
 */
export function listEnabledAccountConfigs(api: any): Array<{ id: string; config: WildfireConfig }> {
  const cfg: WildfireConfig = api.config.channels.wildfire || {};
  const accounts: Array<{ id: string; config: WildfireConfig }> = [];
  
  // Check multi-account config
  if (cfg.accounts) {
    for (const [id, account] of Object.entries(cfg.accounts)) {
      if (account.enabled !== false) {
        const effective = getAccountConfig(api, id);
        if (effective) {
          accounts.push({ id, config: effective });
        }
      }
    }
  }
  
  // Check single account config
  if (accounts.length === 0 && cfg.enabled !== false) {
    const defaultConfig = getAccountConfig(api, "default");
    if (defaultConfig) {
      accounts.push({ id: "default", config: defaultConfig });
    }
  }
  
  return accounts;
}

/**
 * Validate account configuration
 */
export function validateConfig(config: WildfireConfig): string | null {
  if (!config.imUrl) {
    return "imUrl is required";
  }
  if (!config.robotId) {
    return "robotId is required";
  }
  if (!config.robotSecret) {
    return "robotSecret is required";
  }
  return null;
}
