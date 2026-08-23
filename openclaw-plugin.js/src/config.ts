/**
 * Configuration for Wildfire IM channel (Single Account)
 */

export interface WildfireConfig {
  enabled?: boolean;
  gatewayUrl?: string;
  robotId?: string;
  robotSecret?: string;
  /** 机器人平台号（可选覆盖）：默认不配置，SDK 按运行环境自动探测（Linux=7 / macOS=4 / Windows=3）。 */
  gatewayPlatform?: number;
  asrServer?: string;
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
      gatewayUrl: account.gatewayUrl ?? cfg.gatewayUrl,
      robotId: account.robotId ?? cfg.robotId,
      robotSecret: account.robotSecret ?? cfg.robotSecret,
      gatewayPlatform: account.gatewayPlatform ?? cfg.gatewayPlatform,
      asrServer: account.asrServer ?? cfg.asrServer,
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
      gatewayUrl: cfg.gatewayUrl,
      robotId: cfg.robotId,
      robotSecret: cfg.robotSecret,
      asrServer: cfg.asrServer,
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
  if (!config.gatewayUrl) {
    return "gatewayUrl is required";
  }
  if (!config.robotId) {
    return "robotId is required";
  }
  if (!config.robotSecret) {
    return "robotSecret is required";
  }
  return null;
}
