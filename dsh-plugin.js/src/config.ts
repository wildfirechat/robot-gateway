/**
 * Configuration for the Wildfire IM channel plugin.
 *
 * The config object comes from the dsh profile's patch layer, e.g.
 * `~/.dsh/profiles/web/cordis.patch.yml`:
 *
 *   - insert:
 *       - id: wildfire
 *         name: '@wildfirechat/dsh-wildfire'
 *         config:
 *           gatewayUrl: ws://127.0.0.1:8884/robot/gateway
 *           robotId: your_robot_id
 *           robotSecret: your_robot_secret
 */

import { homedir } from "node:os";
import path from "node:path";

export interface WildfireWhiteListConfig {
  enabled?: boolean;
  allowedUsers?: string[];
  allowedGroups?: string[];
  deniedMessage?: string;
  /**
   * Automatically admit the robot owner (read via `getProfile()`). Default true.
   */
  includeOwner?: boolean;
  /** Persistence file for the dynamic `/allow` list. Default ~/.dsh/wildfire-allowlist.json */
  persistFile?: string;
}

export interface WildfireSessionConfig {
  /** Idle timeout before an agent session is disposed (ms). Default 24h. */
  idleTimeoutMs?: number;
  /** Max concurrent agent sessions. Default 200. */
  maxSessions?: number;
}

export interface WildfireStreamingConfig {
  /** Throttle between streaming updates (ms). Default 300. */
  throttleMs?: number;
  /** Placeholder text sent while the agent is starting. Default "…". */
  initialPlaceholder?: string;
}

/**
 * Workspace (working directory) selection for agent sessions.
 *
 * The agent's `cwd` is fixed when the dsh session is created, so changing the
 * workspace for an existing conversation disposes and recreates that session.
 */
export interface WildfireWorkspaceConfig {
  /**
   * Selection mode:
   * - "global"     (default): every conversation runs in `path`
   * - "per-session": each conversation gets its own dir `sessionDir/<sessionId>`
   * - "mapped"     : conversation keys -> dirs from `map` (fallback to `path`)
   */
  mode?: "global" | "per-session" | "mapped";
  /** Base directory for "global" mode / fallback for other modes. Default process.cwd(). */
  path?: string;
  /** Parent directory for "per-session" mode. */
  sessionDir?: string;
  /** Explicit conversation key -> directory mapping for "mapped" mode. */
  map?: Record<string, string>;
  /**
   * Optional safety fence: every resolved workspace must be inside one of
   * these roots (realpath-compared). Empty = no restriction.
   */
  allowedRoots?: string[];
  /**
   * 项目根目录：所有项目都在此目录下。`/cwd` 的相对路径按此目录解析，
   * `/create-group auto` 的自动目录也默认在此之下。
   * 未配置时回退：`autoRoot` → 第一个 `allowedRoot` → `path`。
   */
  root?: string;
  /** Allow the `/cwd <path>` IM command to switch the conversation workspace. */
  allowCwdCommand?: boolean;
  /**
   * Persist runtime `/cwd` overrides (group -> dir mappings) to disk so they
   * survive restarts. Default true.
   */
  persist?: boolean;
  /** File used for persistence. Default: <dshHome>/wildfire-workspaces.json */
  persistFile?: string;
  /**
   * Preset workspace directories for `/create-group` catalog selection
   * (INTERACTION_DESIGN.md §4.1.3 ②). [{id, path, label}]
   */
  catalog?: Array<{ id: string; path: string; label?: string }>;
  /**
   * Root for auto-assigned workspace directories in `/create-group` (③ auto).
   * Default: first allowedRoot, else `path`.
   */
  autoRoot?: string;
}

/**
 * Access control: who may use the robot and who may run management commands.
 * - Admission (who may trigger the bot) stays in `whiteList`.
 * - `adminUsers`/`adminGroups` gate the management commands
 *   (`/cwd`, `/model`, `/effort`, `/reset`). When empty, commands are allowed
 *   for every admitted user as long as the corresponding feature is enabled.
 */
export interface WildfireAccessConfig {
  /** Admin user IDs allowed to run management commands. */
  adminUsers?: string[];
  /** Admin group IDs allowed to run management commands. */
  adminGroups?: string[];
  /**
   * Allow the group owner to run `/cwd` in their own group (verified via
   * `getGroupInfo`; the robot must be a member of the group). Default true.
   */
  groupOwnerCanManage?: boolean;
}

/** One selectable model preset (a dsh ModelSelection). */
export interface WildfireModelPreset {
  provider: string;
  model: string;
  /** Adapter-owned reasoning effort id (e.g. "low" | "medium" | "high"). */
  reasoningEffort?: string;
}

/**
 * Model / reasoning-effort selection per conversation.
 * - `allowed`: named presets the operator exposes to users.
 * - `default`: preset id used when neither `map` nor a runtime override applies;
 *   when omitted the dsh `agentDefaultModel.currentSelection()` is used.
 * - `map`: conversation key (or bare id) -> preset id.
 * - `allowModelCommand`: enable `/model` and `/effort` commands (admin-gated).
 */
export interface WildfireModelConfig {
  default?: string;
  allowed?: Record<string, WildfireModelPreset>;
  map?: Record<string, string>;
  allowModelCommand?: boolean;
}

/** Media handling: inbound (IM -> agent) and outbound (agent -> IM). */
export interface WildfireMediaConfig {
  /** Directory for downloaded media temp files. Default /tmp/wildfire-media. */
  downloadDir?: string;
  /** Parse `[media:path]` / `[image:path]` markers in replies and send as media. Default true. */
  outboundEnabled?: boolean;
}

/**
 * Interactive seams that need IM-side answers:
 * - ask_user (dsh userQuestions provider)
 * - tool approval (dsh approval answerer)
 */
export interface WildfireInteractionConfig {
  /** Register the userQuestions provider (IM answers agent questions). Default true. */
  askUserEnabled?: boolean;
  /** Register the approval answerer (IM approves/denies tool actions). Default true. */
  approvalEnabled?: boolean;
  /** Timeout waiting for an ask_user answer (ms). Default 300000. */
  askUserTimeoutMs?: number;
  /** Timeout waiting for an approval decision (ms). Default 120000. */
  approvalTimeoutMs?: number;
  /** Label that approves (matched loosely against the IM reply). Default "同意". */
  approvedLabel?: string;
  /** Label that denies (matched loosely against the IM reply). Default "拒绝". */
  deniedLabel?: string;
}

/**
 * Security hardening for the IM channel.
 */
export interface WildfireSecurityConfig {
  /**
   * Per-conversation rate limit (messages per minute). Each agent turn costs
   * real model tokens, so a public robot should set a modest cap (e.g. 10).
   * 0 = unlimited. Default 0.
   */
  maxMessagesPerMinute?: number;
}

export interface WildfireConfig {
  enabled?: boolean;
  /** Wildfire robot-gateway WebSocket URL, e.g. ws://host:8884/robot/gateway */
  gatewayUrl?: string;
  /** Wildfire robot id */
  robotId?: string;
  /** Wildfire robot secret */
  robotSecret?: string;
  /**
   * 机器人平台号（可选覆盖）：默认**不配置**，SDK 按运行环境自动探测
   * （Linux=7 / macOS=4 / Windows=3，见 ProtoConstants.Platform）。
   * 仅当需要把机器人显示为其他平台在线时才配置（如 gatewayPlatform: 5 模拟 WEB）。
   */
  gatewayPlatform?: number;
  /**
   * AI 会话使用的线路（line），默认 2。
   * 设计：单聊（与机器人私聊）= 全局控制面板（管理命令），不进入 AI；
   * AI 对话仅限【群聊会话 line === aiLine】（默认 2）。
   * 群聊消息若线路不对（如 line 0 普通群），会回复提醒且不进入 AI。
   * 回复始终发到消息来源的会话线路。
   */
  aiLine?: number;
  /** Optional ASR endpoint; voice messages are transcribed before dispatch. */
  asrServer?: string;
  /** Group chats: require @mention (or question/keyword) to trigger. Default false = every group message triggers. */
  requireMention?: boolean;
  /** Comma-separated trigger keywords for group chats. */
  helpKeywords?: string;
  whiteList?: WildfireWhiteListConfig;
  session?: WildfireSessionConfig;
  streaming?: WildfireStreamingConfig;
  workspace?: WildfireWorkspaceConfig;
  access?: WildfireAccessConfig;
  model?: WildfireModelConfig;
  media?: WildfireMediaConfig;
  interaction?: WildfireInteractionConfig;
  security?: WildfireSecurityConfig;
}

/**
 * Resolve the plugin config: the loader-provided `config` argument wins,
 * falling back to `ctx.model.config` (Cordis Config-driven plugins).
 */
export function getConfig(ctx: any, config?: any): WildfireConfig {
  const cfg: WildfireConfig = config ?? ctx.model?.config ?? {};
  if (cfg.enabled === false) {
    throw new Error("wildfire plugin is disabled");
  }
  return cfg;
}

/** Validate required fields; returns an error message or null. */
export function validateConfig(config: WildfireConfig): string | null {
  if (!config.gatewayUrl) return "gatewayUrl is required";
  if (!config.robotId) return "robotId is required";
  if (!config.robotSecret) return "robotSecret is required";
  return null;
}

/** Effective AI line (group-chat AI session line). Default 2. */
export function getAiLine(config: WildfireConfig): number {
  return config.aiLine ?? 2;
}

/** Effective whitelist settings with defaults applied. */
export function getWhitelistConfig(config: WildfireConfig): Required<WildfireWhiteListConfig> {
  return {
    enabled: config.whiteList?.enabled ?? false,
    allowedUsers: config.whiteList?.allowedUsers ?? [],
    allowedGroups: config.whiteList?.allowedGroups ?? [],
    deniedMessage: config.whiteList?.deniedMessage ?? "不允许使用",
    includeOwner: config.whiteList?.includeOwner ?? true,
    persistFile:
      config.whiteList?.persistFile ?? path.join(homedir(), ".dsh", "wildfire-allowlist.json"),
  };
}

/** Effective session settings with defaults applied. */
export function getSessionConfig(config: WildfireConfig): Required<WildfireSessionConfig> {
  return {
    idleTimeoutMs: config.session?.idleTimeoutMs ?? 24 * 60 * 60 * 1000,
    maxSessions: config.session?.maxSessions ?? 200,
  };
}

/** Effective streaming settings with defaults applied. */
export function getStreamingConfig(config: WildfireConfig): Required<WildfireStreamingConfig> {
  return {
    throttleMs: config.streaming?.throttleMs ?? 300,
    initialPlaceholder: config.streaming?.initialPlaceholder ?? "…",
  };
}

/** Effective workspace settings with defaults applied. */
export function getWorkspaceConfig(config: WildfireConfig): Required<WildfireWorkspaceConfig> {
  return {
    mode: config.workspace?.mode ?? "global",
    path: config.workspace?.path ?? process.cwd(),
    sessionDir: config.workspace?.sessionDir ?? "",
    map: config.workspace?.map ?? {},
    allowedRoots: config.workspace?.allowedRoots ?? [],
    allowCwdCommand: config.workspace?.allowCwdCommand ?? false,
    persist: config.workspace?.persist ?? true,
    persistFile:
      config.workspace?.persistFile ?? path.join(homedir(), ".dsh", "wildfire-workspaces.json"),
    catalog: config.workspace?.catalog ?? [],
    autoRoot: config.workspace?.autoRoot ?? "",
    // 项目根目录回退链：root → autoRoot → 第一个 allowedRoot → path
    root:
      config.workspace?.root ??
      config.workspace?.autoRoot ??
      config.workspace?.allowedRoots?.[0] ??
      config.workspace?.path ??
      process.cwd(),
  };
}

/** Effective access settings with defaults applied. */
export function getAccessConfig(config: WildfireConfig): Required<WildfireAccessConfig> {
  return {
    adminUsers: config.access?.adminUsers ?? [],
    adminGroups: config.access?.adminGroups ?? [],
    groupOwnerCanManage: config.access?.groupOwnerCanManage ?? true,
  };
}

/** Effective model settings with defaults applied (`default` stays optional). */
export function getModelConfig(
  config: WildfireConfig
): Required<Omit<WildfireModelConfig, "default">> & { default?: string } {
  return {
    default: config.model?.default,
    allowed: config.model?.allowed ?? {},
    map: config.model?.map ?? {},
    allowModelCommand: config.model?.allowModelCommand ?? false,
  };
}

/** Effective media settings with defaults applied. */
export function getMediaConfig(config: WildfireConfig): Required<WildfireMediaConfig> {
  return {
    downloadDir: config.media?.downloadDir ?? "/tmp/wildfire-media",
    outboundEnabled: config.media?.outboundEnabled ?? true,
  };
}

/** Effective interaction settings with defaults applied. */
export function getInteractionConfig(
  config: WildfireConfig
): Required<WildfireInteractionConfig> {
  return {
    askUserEnabled: config.interaction?.askUserEnabled ?? true,
    approvalEnabled: config.interaction?.approvalEnabled ?? true,
    askUserTimeoutMs: config.interaction?.askUserTimeoutMs ?? 300000,
    approvalTimeoutMs: config.interaction?.approvalTimeoutMs ?? 120000,
    approvedLabel: config.interaction?.approvedLabel ?? "同意",
    deniedLabel: config.interaction?.deniedLabel ?? "拒绝",
  };
}

/** Effective security settings with defaults applied. */
export function getSecurityConfig(config: WildfireConfig): Required<WildfireSecurityConfig> {
  return {
    maxMessagesPerMinute: config.security?.maxMessagesPerMinute ?? 0,
  };
}
