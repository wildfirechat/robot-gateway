/**
 * DSH Agent session manager.
 *
 * Maps a Wildfire IM conversation to a dedicated dsh Agent session so that a
 * multi-turn dialogue keeps its context, and bridges the durable
 * `session/event` firehose to per-conversation stream handlers.
 *
 * DSH core surface used (see `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session`):
 * - `ctx.agents.create({sessionId, meta, agentOptions, setup}) -> { agent, dispose }`
 * - `ctx.agents.get(SessionId)`, `ctx.agents.resume({sessionId, ...})`
 * - `agent.followup(userMessage)`, `agent.whenIdle()`
 * - `ctx.on('session/event', (session, event) => ...)` with
 *   `assistant/chunk` / `assistant/message` / `turn/end` events
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { WildfireSessionConfig } from "./config.js";
import type { ModelSelection } from "./model.js";

type RequiredSessionConfig = Required<WildfireSessionConfig>;

/** Resolves the working directory for a conversation before agent creation. */
export type CwdProvider = (key: string, sessionId: string) => Promise<string>;

/** Resolves the model selection for a conversation before agent creation. */
export type ModelProvider = (key: string) => Promise<ModelSelection>;

/** Extra content blocks for a user turn (images via the attachment service). */
export interface DispatchExtras {
  /** Image blocks: `{ type: "image", attachment }` in content order. */
  images?: Array<{ attachment: any }>;
}

/**
 * 绑定一个 agent scope 的回调（由 index.ts 注入 InteractionManager.bindAgentScope）：
 * 在 agent 创建/resume 的 setup(agentCtx) 里调用，用于监听该 agent 的 scoped
 * subagent 事件（全局 ctx.on 收不到 scoped 事件）。
 */
export type AgentScopeBinder = (agentCtx: any) => void;

/** Live turn state notifications (mapped to the scope=31 conversation state / DSH_Goal card). */
export interface TurnHandlers {
  /** Session state changed (idle/running/waiting_user/done). */
  onStatus?: (state: "running" | "done") => void;
  /** Agent activity (thinking / tool execution). */
  onProgress?: (data: { phase: "thinking" | "tool" | "done"; toolName?: string; detail?: string }) => void;
  /** Goal changed via the goal tool (mapped to DSH_Goal card). */
  onGoal?: (data: { gid: string; objective: string; phase: string; roundsStarted: number }) => void;
}

/** A dsh session event as delivered by the `session/event` firehose. */
export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: any;
}

/** Outcome of one dispatched user turn. */
export interface TurnOutcome {
  /** Aggregated assistant text (text blocks only). */
  text: string;
  /** Raw `turn/end` reason, when the turn ended. */
  reason?: any;
  /** Token/context metrics for the turn (from token-meter projections + local timing). */
  metrics?: TurnMetrics;
}

/**
 * Token/context metrics pushed to Wildfire after a turn:
 * - `usage`      — cumulative session usage (provider-reported, token-meter)
 * - `turn`       — this turn's deltas (projection diff) + wall time
 * - `context`    — next-request prompt cost vs model window (occupancy)
 * - `cacheHitRatePct` — cumulative cache-hit ratio (cacheRead/(cacheRead+uncached))
 * - `speed`      — this turn's decode speed + time-to-first-token (local timing)
 */
export interface TurnMetrics {
  usage: { promptTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };
  turn: { inputTokens: number; outputTokens: number; cacheHitTokens: number; durationMs: number };
  context?: { usedTokens: number; windowTokens: number; usedPct: number };
  cacheHitRatePct: number;
  speed: { tokensPerSec: number; ttftMs: number };
}

/** A token-meter projection snapshot (usage + context occupancy). */
interface ProjectionSnapshot {
  usage?: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  context?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number };
}

type SessionEventHandler = (event: SessionEvent) => void;

interface ManagedSession {
  key: string;
  sessionId: string;
  epoch: number;
  handle: { agent: any; dispose: () => Promise<void> };
  /** Live model selection installed at creation; `.current` may be mutated. */
  selection: { current: ModelSelection | undefined; assembled: any };
  lastActivity: number;
  subscribers: Set<SessionEventHandler>;
}

/**
 * Deterministic dsh SessionId from an IM conversation key (LEGACY format).
 * `wildfire:user:<userId>` / `wildfire:group:<groupId>` -> `wildfire-<sha256[:20]>[-<epoch>]`
 *
 * 旧格式保留用途：
 * - `/create` 的 wsId（自动目录名）生成
 * - per-session workspace 模式下的预览 id（cwdProvider 需要）
 * - 迁移回退：新格式 id 不存在时尝试用旧 id resume 已有会话
 */
export function sessionIdForConversation(key: string, epoch = 0): string {
  const hash = createHash("sha256").update(key.toLowerCase()).digest("hex");
  const base = hash.slice(0, 20);
  return epoch > 0 ? `wildfire-${base}-${epoch}` : `wildfire-${base}`;
}

/**
 * Deterministic dsh SessionId keyed by (IM conversation key, workspace cwd).
 * `wildfire-<sha256(key)[:20]>-<sha256(cwd)[:16]>[-<epoch>]`
 *
 * 目录哈希进入 id：切到别的目录 → 不同 id（各目录会话独立、可并存于磁盘）；
 * 切回已访问过的目录 → 相同 id → `resume` 恢复该目录的上下文。
 * `epoch` 仅在会话 log 损坏/冲突重建时递增（按 目录 维度）。
 */
export function sessionIdForConversationWithCwd(key: string, cwd: string, epoch = 0): string {
  const hash = createHash("sha256").update(key.toLowerCase()).digest("hex");
  const dirHash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const base = `wildfire-${hash.slice(0, 20)}-${dirHash}`;
  return epoch > 0 ? `${base}-${epoch}` : base;
}

/** 规范化目录路径（词法），保证同一目录的不同写法派生同一 sessionId。 */
export function normalizeCwd(cwd: string): string {
  return path.resolve(cwd);
}

export class AgentSessionManager {
  private ctx: any;
  private logger: any;
  private config: RequiredSessionConfig;
  private cwdProvider: CwdProvider;
  private modelProvider: ModelProvider;
  /** 绑定 agent scope 的回调（subagent 事件等 scoped 监听，index.ts 注入）。 */
  private agentScopeBinder?: AgentScopeBinder;
  private sessions = new Map<string, ManagedSession>();
  /** 会话重建计数：key → cwd → epoch（仅 log 损坏/冲突时递增）。 */
  private epochByKeyCwd = new Map<string, Map<string, number>>();
  /** 旧格式（epoch 派生）会话 id 的持久化 epoch（迁移用，仅旧配置文件有值）。 */
  private legacyEpochByKey = new Map<string, number>();
  /** 迁移后的旧格式 sessionId：key → 旧 id（该会话继续用旧 id，上下文保留）。 */
  private legacySessionByKey = new Map<string, string>();
  /** 最近一次 getAgent 解析的 cwd（peekSessionId 用，不持久化）。 */
  private cwdByKey = new Map<string, string>();
  private sessionIdToKey = new Map<string, string>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  // 会话状态持久化：epoch（按目录维度）+ 迁移映射，落盘后进程重启不丢；
  // 目录哈希进入 sessionId 后，"切回目录恢复上下文"依赖这些记录的稳定性。
  private epochFile = "";
  private epochSaveTimer: NodeJS.Timeout | undefined;
  private epochLoaded = false;

  /** Load persisted session epochs (call once at startup). */
  async init(): Promise<void> {
    if (this.epochLoaded) return;
    this.epochLoaded = true;
    this.epochFile = path.join(homedir(), ".dsh", "wildfire-sessions.json");
    try {
      const raw = await readFile(this.epochFile, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        // 新格式：{ epochs: { key: { cwd: epoch } }, legacy: { key: oldSessionId } }
        if (data.epochs) {
          for (const [key, entry] of Object.entries<any>(data.epochs)) {
            if (entry && typeof entry === "object" && !Array.isArray(entry)) {
              const byCwd = new Map<string, number>();
              for (const [cwd, ep] of Object.entries<number>(entry)) {
                byCwd.set(cwd, ep);
              }
              this.epochByKeyCwd.set(key, byCwd);
            } else {
              // 旧格式：{ epochs: { key: number } } —— 保留为 legacy epoch（迁移用）
              this.legacyEpochByKey.set(key, Number(entry) || 0);
            }
          }
        }
        if (data.legacy) {
          for (const [key, sid] of Object.entries<string>(data.legacy)) {
            this.legacySessionByKey.set(key, sid);
          }
        }
        this.logger?.info?.(
          `[wildfire-agent] loaded persisted session state from ${this.epochFile} (${this.epochByKeyCwd.size} keys, ${this.legacySessionByKey.size} legacy)`
        );
      }
    } catch (err: any) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn?.(`[wildfire-agent] failed to load session state: ${err.message}`);
      }
    }
  }

  /** Persist session state to disk (debounced). */
  private persistEpochs(): void {
    if (this.epochSaveTimer) return;
    this.epochSaveTimer = setTimeout(() => {
      this.epochSaveTimer = undefined;
      this.flushEpochs().catch(() => {});
    }, 500);
  }

  /** Write the session state now (debounce flush / plugin stop). */
  async flushEpochs(): Promise<void> {
    if (!this.epochFile) return;
    await mkdir(path.dirname(this.epochFile), { recursive: true });
    const epochs: Record<string, Record<string, number>> = {};
    for (const [key, byCwd] of this.epochByKeyCwd) {
      epochs[key] = Object.fromEntries(byCwd);
    }
    await writeFile(
      this.epochFile,
      JSON.stringify({ epochs, legacy: Object.fromEntries(this.legacySessionByKey) }, null, 2)
    );
  }

  /** Epoch for (key, cwd); default 0. */
  private epochOf(key: string, cwd: string): number {
    return this.epochByKeyCwd.get(key)?.get(cwd) ?? 0;
  }

  /** Bump the rebuild epoch for (key, cwd) and persist. */
  private bumpEpoch(key: string, cwd: string): number {
    let byCwd = this.epochByKeyCwd.get(key);
    if (!byCwd) {
      byCwd = new Map<string, number>();
      this.epochByKeyCwd.set(key, byCwd);
    }
    const next = (byCwd.get(cwd) ?? 0) + 1;
    byCwd.set(cwd, next);
    this.persistEpochs();
    return next;
  }

  constructor(
    ctx: any,
    logger: any,
    config: RequiredSessionConfig,
    cwdProvider: CwdProvider,
    modelProvider: ModelProvider,
    agentScopeBinder?: AgentScopeBinder
  ) {
    this.ctx = ctx;
    this.logger = logger;
    this.config = config;
    this.cwdProvider = cwdProvider;
    this.modelProvider = modelProvider;
    this.agentScopeBinder = agentScopeBinder;

    // Bridge the durable session firehose to per-conversation subscribers.
    ctx.on("session/event", (session: any, event: SessionEvent) => {
      const managed = this.sessions.get(String(session.id));
      if (!managed) return;
      managed.lastActivity = Date.now();
      for (const handler of managed.subscribers) {
        try {
          handler(event);
        } catch (err) {
          this.logger?.warn?.(`[wildfire-agent] subscriber error: ${String(err)}`);
        }
      }
    });

    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    this.sweepTimer.unref?.();
  }

  /**
   * Get (create on demand) the live Agent for a conversation key.
   *
   * 会话 id 由 (群, 工作目录) 派生：切目录 = 换 id（各目录会话独立并存于磁盘）；
   * 切回已访问目录 → 同一 id → resume 恢复该目录上下文。内存中每次只活跃
   * 一个（切目录时 dispose 旧会话，log 保留可恢复）。
   */
  async getAgent(key: string): Promise<any> {
    // 先解析当前工作目录（global/override 模式不依赖 sessionId；per-session
    // 模式用旧格式预览 id 生成默认目录）。
    const previewId = sessionIdForConversation(key, 0);
    const cwd = await this.cwdProvider(key, previewId);
    const norm = normalizeCwd(cwd);
    this.cwdByKey.set(key, norm);
    const epoch = this.epochOf(key, norm);
    // 迁移优先：已迁移到旧 id 的会话继续用旧 id（保留切换目录前的上下文）
    let sessionId = this.legacySessionByKey.get(key) ?? sessionIdForConversationWithCwd(key, norm, epoch);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing.handle.agent;
    }

    // 切目录：同 key 的其他活跃会话先 dispose（log 保留，可切回恢复）
    await this.evictKeyOthers(key, sessionId);
    this.evictIfNeeded();

    const agents = this.ctx.get("agents");
    if (!agents) {
      throw new Error("dsh core services (agents) not available");
    }

    const selection = await this.modelProvider(key);
    const selectionRef: { current: ModelSelection | undefined; assembled: any } = {
      current: selection,
      assembled: undefined,
    };
    // The dispose capability is owned by the AgentHandle returned from create
    // (a bare `ctx.agents.get()` entry cannot tear the agent down).
    // Resume-first: recreating a session whose deterministic id already has an
    // on-disk log would collide ("id collision" turn error). `persistence.has()`
    // is a lazy in-memory index that may not see logs written by a previous
    // process, so probe via resume itself — it throws `session not found`
    // when nothing is persisted.
    const resumeOptions = {
      resumeSessionId: SessionId(sessionId),
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup: (agentCtx: any) => {
        installModelSelection(agentCtx, selectionRef);
        this.agentScopeBinder?.(agentCtx);
      },
    };
    const createOptions = {
      sessionId: SessionId(sessionId),
      meta: { cwd: norm },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup: (agentCtx: any) => {
        installModelSelection(agentCtx, selectionRef);
        this.agentScopeBinder?.(agentCtx);
      },
    };

    let handle: any;
    try {
      handle = await agents.resume(resumeOptions);
      this.logger?.info?.(
        `[wildfire-agent] session resumed: key=${key}, sessionId=${sessionId}, cwd=${norm}`
      );
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (message.includes("not found")) {
        // 新格式 id 不存在：尝试旧格式 id（迁移部署前已有的会话，保留其上下文）。
        // 仅当旧会话的 cwd 与当前目录一致时才迁移，否则丢弃旧 id 正常新建。
        const migrated = await this.tryMigrateLegacy(key, norm, agents, resumeOptions, createOptions);
        if (migrated) {
          handle = migrated.handle;
          sessionId = migrated.sessionId;
        } else {
          handle = await agents.create(createOptions);
        }
      } else {
        // Resume failed for another reason (corrupt/torn log, cwd mismatch, ...).
        // Bump the epoch for (key, cwd) and create under a fresh id; the id may
        // still collide if the cwd itself changed shape, so keep bumping (bounded).
        this.logger?.warn?.(
          `[wildfire-agent] resume failed for ${sessionId}, bumping epoch & creating fresh: ${message}`
        );
        let created = false;
        let attempts = 0;
        let freshSessionId = sessionId;
        while (!created && attempts < 20) {
          attempts += 1;
          const nextEpoch = this.bumpEpoch(key, norm);
          freshSessionId = sessionIdForConversationWithCwd(key, norm, nextEpoch);
          const freshOptions = {
            ...createOptions,
            sessionId: SessionId(freshSessionId),
          };
          try {
            handle = await agents.create(freshOptions);
            created = true;
          } catch (createErr: any) {
            const m = String(createErr?.message ?? createErr);
            if (m.includes("collision") || m.includes("persisted")) {
              this.logger?.warn?.(
                `[wildfire-agent] session id ${freshSessionId} collides (${m.slice(0, 100)}), bumping again`
              );
              continue;
            }
            throw createErr;
          }
        }
        if (!created) {
          throw new Error(`unable to create a fresh session for ${key} after ${attempts} epoch bumps`);
        }
        this.persistEpochs();
        sessionId = freshSessionId;
      }
    }

    const managed: ManagedSession = {
      key,
      sessionId,
      epoch: this.epochOf(key, norm),
      handle: { agent: handle.agent, dispose: () => handle.dispose() },
      selection: selectionRef,
      lastActivity: Date.now(),
      subscribers: new Set(),
    };
    this.sessions.set(sessionId, managed);
    this.sessionIdToKey.set(sessionId, key);
    this.logger?.info?.(
      `[wildfire-agent] session created: key=${key}, sessionId=${sessionId}, cwd=${norm}, model=${selection.provider}/${selection.model}${selection.reasoningEffort ? ` (effort=${selection.reasoningEffort})` : ""}`
    );
    return handle.agent;
  }

  /**
   * 迁移回退：尝试用旧格式（epoch 派生）id resume 部署前的既有会话。
   * 成功且旧会话 cwd 与当前目录一致 → 登记 legacySessionByKey（持久化），
   * 后续一直沿用旧 id（上下文保留）；否则返回 null（调用方正常新建）。
   */
  private async tryMigrateLegacy(
    key: string,
    norm: string,
    agents: any,
    resumeOptions: any,
    createOptions: any
  ): Promise<{ handle: any; sessionId: string } | null> {
    if (this.legacySessionByKey.has(key)) return null;
    const oldEpoch = this.legacyEpochByKey.get(key) ?? 0;
    const oldId = sessionIdForConversation(key, oldEpoch);
    if (oldId === String(resumeOptions.resumeSessionId ?? "")) return null;
    try {
      const oldHandle = await agents.resume({ ...resumeOptions, resumeSessionId: SessionId(oldId) });
      // dsh-session 的 Session 暴露的是 header（含创建时写入的 cwd），
      // 没有 meta 字段——之前读 session.meta.cwd 恒为 undefined，导致
      // "cwd 不一致则丢弃"的分支永远不执行（死代码）。
      const oldCwd = oldHandle?.agent?.session?.header?.cwd;
      if (oldCwd === undefined || normalizeCwd(String(oldCwd)) === norm) {
        this.legacySessionByKey.set(key, oldId);
        this.persistEpochs();
        this.logger?.info?.(
          `[wildfire-agent] migrated legacy session: key=${key}, sessionId=${oldId}, cwd=${oldCwd}`
        );
        return { handle: oldHandle, sessionId: oldId };
      }
      // 旧会话属于其他目录：不要它（log 保留，切回该目录时自然恢复）
      this.logger?.info?.(
        `[wildfire-agent] legacy session ${oldId} cwd=${oldCwd} != ${norm}, discarding for fresh create`
      );
      await oldHandle.dispose().catch(() => {});
      return null;
    } catch (oldErr: any) {
      const om = String(oldErr?.message ?? oldErr);
      if (!om.includes("not found")) {
        this.logger?.warn?.(`[wildfire-agent] legacy resume failed for ${oldId}: ${om.slice(0, 120)}`);
      }
      return null;
    }
  }

  /** 切换目录：dispose 同 key 的其他活跃会话（log 保留，切回可恢复）。 */
  private async evictKeyOthers(key: string, keepSessionId: string): Promise<void> {
    for (const [sid, managed] of [...this.sessions]) {
      if (sid === keepSessionId || managed.key !== key) continue;
      this.sessions.delete(sid);
      this.sessionIdToKey.delete(sid);
      await managed.handle.dispose().catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire-agent] evict ${sid}: ${String(err)}`)
      );
      this.logger?.info?.(`[wildfire-agent] switched workspace session: key=${key}, disposed=${sid}`);
    }
  }

  /** Reverse lookup: IM conversation key for a dsh session id. */
  keyForSessionId(sessionId: string): string | undefined {
    return this.sessionIdToKey.get(sessionId);
  }

  /**
   * All live sessions as `[{key, agent}]` — for cross-workspace queries like
   * `/jobs` that must see jobs owned by every conversation's agent, not just
   * the control panel session's.
   */
  listLiveAgents(): Array<{ key: string; agent: any }> {
    return [...this.sessions.values()].map((managed) => ({
      key: managed.key,
      agent: managed.handle.agent,
    }));
  }

  /**
   * Apply a new model selection to a live conversation. The selection is
   * session-LIVE: it takes effect on the agent's next request without resetting
   * the conversation. Returns false when no live session exists (the override
   * still applies to the next created session via `modelProvider`).
   */
  applyModelLive(key: string, selection: ModelSelection): boolean {
    const sessionId = this.peekSessionId(key);
    const managed = this.sessions.get(sessionId);
    if (!managed) return false;
    managed.selection.current = { ...selection };
    this.logger?.info?.(
      `[wildfire-agent] model applied live: key=${key}, ${selection.provider}/${selection.model}${selection.reasoningEffort ? ` (effort=${selection.reasoningEffort})` : ""}`
    );
    return true;
  }

  /**
   * 显式重置会话（`/reset`、`/new`、dispatch 的 cwd 冲突重试）：dispose 当前
   * 活跃会话并 bump (key, cwd) 的 epoch —— 下次消息用新 id，旧上下文不再恢复。
   * 与 `/cwd` 切换（`switchWorkspace`，保留上下文）语义不同。
   */
  async resetSession(key: string): Promise<void> {
    const norm = await this.currentCwdOf(key);
    const epoch = this.epochOf(key, norm);
    const sessionId = this.legacySessionByKey.get(key) ?? sessionIdForConversationWithCwd(key, norm, epoch);
    const managed = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.sessionIdToKey.delete(sessionId);
    // 显式重置：不再沿用旧 id/旧上下文
    this.legacySessionByKey.delete(key);
    this.bumpEpoch(key, norm);
    if (managed) {
      await managed.handle.dispose().catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire-agent] reset ${sessionId}: ${String(err)}`)
      );
    }
    this.logger?.info?.(
      `[wildfire-agent] session reset: key=${key}, old=${sessionId}, cwd=${norm}, nextEpoch=${this.epochOf(key, norm)}`
    );
  }

  /**
   * 切换工作区（`/cwd` 绑定/清除）：dispose 该 key 的全部活跃会话但**不** bump
   * epoch —— 下次消息按新 cwd 派生 id（resume 恢复该目录上下文，或新建）。
   */
  async switchWorkspace(key: string): Promise<void> {
    const disposed: string[] = [];
    for (const [sid, managed] of [...this.sessions]) {
      if (managed.key !== key) continue;
      this.sessions.delete(sid);
      this.sessionIdToKey.delete(sid);
      await managed.handle.dispose().catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire-agent] switch ${sid}: ${String(err)}`)
      );
      disposed.push(sid);
    }
    this.cwdByKey.delete(key); // 强制下次按新 cwd 派生
    this.logger?.info?.(
      `[wildfire-agent] workspace switched: key=${key}, disposed=[${disposed.join(", ")}]`
    );
  }

  /** 当前会话 id（不创建 agent）：优先最近解析的 cwd，未激活时用旧格式预览 id。 */
  peekSessionId(key: string): string {
    const cwd = this.cwdByKey.get(key);
    if (!cwd) return sessionIdForConversation(key, this.legacyEpochByKey.get(key) ?? 0);
    const norm = normalizeCwd(cwd);
    const epoch = this.epochOf(key, norm);
    return this.legacySessionByKey.get(key) ?? sessionIdForConversationWithCwd(key, norm, epoch);
  }

  /** 解析 (key, cwd)：优先缓存，否则走 cwdProvider（per-session 模式用旧格式预览 id）。 */
  private async currentCwdOf(key: string): Promise<string> {
    const cached = this.cwdByKey.get(key);
    if (cached) return normalizeCwd(cached);
    const previewId = sessionIdForConversation(key, this.legacyEpochByKey.get(key) ?? 0);
    const cwd = await this.cwdProvider(key, previewId);
    const norm = normalizeCwd(cwd);
    this.cwdByKey.set(key, norm);
    return norm;
  }

  /**
   * Dispose the conversation's agent AND forget it entirely (workspace
   * destruction). Removes all memory of the key so a later message starts
   * fresh (epoch 0, new directory-derived id).
   */
  async disposeWorkspace(key: string): Promise<void> {
    for (const [sid, managed] of [...this.sessions]) {
      if (managed.key !== key) continue;
      this.sessions.delete(sid);
      this.sessionIdToKey.delete(sid);
      await managed.handle.dispose().catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire-agent] disposeWorkspace ${sid}: ${String(err)}`)
      );
    }
    this.epochByKeyCwd.delete(key);
    this.legacyEpochByKey.delete(key);
    this.legacySessionByKey.delete(key);
    this.cwdByKey.delete(key);
    this.persistEpochs();
    this.logger?.info?.(`[wildfire-agent] workspace session disposed: key=${key}`);
  }

  /**
   * Dispatch one user turn into the conversation's Agent and resolve when its
   * turn reaches quiescence. `onDelta` receives each streamed text delta so the
   * caller can push generating updates to Wildfire. `extras.images` become
   * image content blocks (via the dsh attachment service).
   */
  async dispatch(
    key: string,
    text: string,
    onDelta: (delta: string) => void,
    extras?: DispatchExtras,
    handlers?: TurnHandlers
  ): Promise<TurnOutcome> {
    const agent = await this.getAgent(key);
    const session = agent.session;
    const startSeq = session.seq;
    const startedAt = Date.now();
    let firstChunkAt: number | undefined;
    // 回合开始时的 token 计量快照（token-meter 投影是累计值，结束时差分）。
    const startProjection = this.readProjections(session);
    let started = false;
    let finalText = "";
    let reason: any;
    let deltaCount = 0;

    handlers?.onStatus?.("running");
    handlers?.onProgress?.({ phase: "thinking" });

    const handler = (event: SessionEvent) => {
      if (event.seq < startSeq) return;
      if (event.type === "turn/start") {
        started = true;
        handlers?.onStatus?.("running");
        return;
      }
      if (!started) return;
      switch (event.type) {
        case "assistant/chunk": {
          const chunk = event.data?.chunk;
          if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
            if (firstChunkAt === undefined) firstChunkAt = Date.now();
            finalText += chunk.text;
            deltaCount++;
            onDelta(chunk.text);
          }
          break;
        }
        case "tool/call": {
          handlers?.onProgress?.({
            phase: "tool",
            toolName: String(event.data?.name ?? ""),
            detail: event.data?.arguments ? String(event.data.arguments).slice(0, 80) : undefined,
          });
          break;
        }
        case "assistant/message": {
          const joined = (event.data?.message?.content ?? [])
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("");
          if (joined !== "") finalText = joined;
          break;
        }
        case "goal/change": {
          const g = event.data?.goal;
          if (g && handlers?.onGoal) {
            handlers.onGoal({
              gid: String(g.id ?? ""),
              objective: String(g.objective ?? ""),
              phase: String(g.phase ?? ""),
              roundsStarted: Number(event.data?.roundsStarted ?? 0),
            });
          }
          break;
        }
        case "turn/end":
          reason = event.data?.reason;
          handlers?.onProgress?.({ phase: "done" });
          handlers?.onStatus?.("done");
          break;
        default:
          break;
      }
    };

    const unsubscribe = this.subscribe(session.id, handler);
    try {
      const content: Array<any> = [];
      for (const image of extras?.images ?? []) {
        content.push({ type: "image", attachment: image.attachment });
      }
      content.push({ type: "text", text });
      agent.followup(
        createUserMessage({
          content,
          source: { kind: "user" },
        })
      );
      await agent.whenIdle();
    } catch (err: any) {
      const m = String(err?.message ?? err);
      // cwd 碰撞：DSH 对 session log 的 cwd 校验是懒的（followup/写日志时才抛
      // "already persisted at a different cwd"）。create 阶段的 bump 循环抓不到，
      // 这里在 turn 提交失败时按同样模式重建（bump epoch 后重试一次）。
      if (
        (m.includes("persisted at a different cwd") || (m.includes("collision") && m.includes("persisted"))) &&
        !(handlers as any)?.__cwdRetried
      ) {
        this.logger?.warn?.(
          `[wildfire-agent] turn failed with cwd collision (${m.slice(0, 120)}), bumping epoch & retrying once`
        );
        const retryHandlers = { ...handlers, __cwdRetried: true } as any;
        await this.resetSession(key);
        unsubscribe();
        return this.dispatch(key, text, onDelta, extras, retryHandlers);
      }
      throw err;
    } finally {
      unsubscribe();
      this.logger?.debug?.(
        `[wildfire-agent] turn done: key=${key}, deltas=${deltaCount}, textLen=${finalText.length}`
      );
    }
    const endProjection = this.readProjections(session);
    const metrics = this.computeMetrics(startProjection, endProjection, startedAt, firstChunkAt);
    if (metrics) {
      this.logger?.info?.(
        `[wildfire-agent] turn metrics: key=${key}, out=${metrics.turn.outputTokens} (${metrics.speed.tokensPerSec} tok/s, ttft=${metrics.speed.ttftMs}ms), cacheHit=${metrics.cacheHitRatePct}%, context=${metrics.context ? `${metrics.context.usedPct}%` : "n/a"}`
      );
    }
    return { text: finalText, reason, metrics };
  }

  /**
   * Read the current token-meter projections for a session (best effort).
   * Requires `ctx.sessionProjections` + the dsh-token-meter units, both part
   * of the dsh-base bundle; returns undefined when unavailable so callers
   * degrade gracefully (no metrics pushed).
   */
  private readProjections(session: any): ProjectionSnapshot | undefined {
    try {
      const registry = this.ctx.get?.("sessionProjections");
      if (!registry) return undefined;
      const snap = registry.snapshot(session);
      const values = snap?.values ?? {};
      return {
        usage: values.tokenUsage,
        context: values.contextPressure,
      };
    } catch (err: any) {
      this.logger?.debug?.(`[wildfire-agent] projection read failed: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * 读取指定会话的【累计】统计（激活会话后读 token-meter 投影）。
   * 用于工作目录切换后：立即显示目标目录会话的统计——
   * 切回已访问目录（resume）显示其历史累计；全新目录（create 空会话）无
   * usage 则返回 undefined（客户端不显示统计，等首回合结束）。
   * 不含 turn/speed（那是"本轮"增量，切目录时没有本轮）。
   */
  async snapshotMetrics(key: string): Promise<Partial<TurnMetrics> | undefined> {
    const agent = await this.getAgent(key);
    const snap = this.readProjections(agent?.session);
    if (!snap?.usage) return undefined;
    const usage = snap.usage;
    const ctx = snap.context;
    const context: TurnMetrics["context"] =
      ctx && typeof ctx.projectedTokens === "number" && typeof ctx.contextWindow === "number" && ctx.contextWindow > 0
        ? {
            usedTokens: Math.round(ctx.projectedTokens),
            windowTokens: ctx.contextWindow,
            usedPct: Math.round((ctx.projectedTokens / ctx.contextWindow) * 1000) / 10,
          }
        : undefined;
    const cacheHitRatePct =
      usage.cacheReadTokens + usage.uncachedInputTokens > 0
        ? Math.round((usage.cacheReadTokens / (usage.cacheReadTokens + usage.uncachedInputTokens)) * 1000) / 10
        : 0;
    return {
      usage: {
        promptTokens: usage.uncachedInputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens:
          usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      },
      ...(context ? { context } : {}),
      cacheHitRatePct,
    };
  }

  /**
   * Diff the turn-start and turn-end projections into the pushed metrics.
   * Returns undefined when no provider usage has landed yet (brand-new
   * session, first request in flight).
   */
  private computeMetrics(
    start: ProjectionSnapshot | undefined,
    end: ProjectionSnapshot | undefined,
    startedAt: number,
    firstChunkAt: number | undefined
  ): TurnMetrics | undefined {
    if (!end?.usage) return undefined;
    const usage = end.usage;
    const durationMs = Date.now() - startedAt;

    const turn = {
      inputTokens: 0,
      outputTokens: usage.outputTokens,
      cacheHitTokens: usage.cacheReadTokens,
      durationMs,
    };
    if (start?.usage) {
      turn.outputTokens = Math.max(0, usage.outputTokens - start.usage.outputTokens);
      turn.cacheHitTokens = Math.max(0, usage.cacheReadTokens - start.usage.cacheReadTokens);
      turn.inputTokens = Math.max(
        0,
        usage.uncachedInputTokens + usage.cacheWriteTokens - start.usage.uncachedInputTokens - start.usage.cacheWriteTokens
      );
    }

    const speed: TurnMetrics["speed"] = {
      tokensPerSec:
        turn.outputTokens > 0 && durationMs > 0
          ? Math.round((turn.outputTokens / durationMs) * 1000 * 10) / 10
          : 0,
      ttftMs: firstChunkAt !== undefined ? firstChunkAt - startedAt : 0,
    };

    // 上下文占用：projectedTokens（下一请求预估成本）/ contextWindow。
    const ctx = end.context;
    const context: TurnMetrics["context"] =
      ctx && typeof ctx.projectedTokens === "number" && typeof ctx.contextWindow === "number" && ctx.contextWindow > 0
        ? {
            usedTokens: Math.round(ctx.projectedTokens),
            windowTokens: ctx.contextWindow,
            usedPct: Math.round((ctx.projectedTokens / ctx.contextWindow) * 1000) / 10,
          }
        : undefined;

    const cacheHitRatePct =
      usage.cacheReadTokens + usage.uncachedInputTokens > 0
        ? Math.round((usage.cacheReadTokens / (usage.cacheReadTokens + usage.uncachedInputTokens)) * 1000) / 10
        : 0;

    return {
      usage: {
        promptTokens: usage.uncachedInputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens:
          usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      },
      turn,
      ...(context ? { context } : {}),
      cacheHitRatePct,
      speed,
    };
  }

  /** Subscribe to session events for one dsh session id. */
  subscribe(sessionId: string, handler: SessionEventHandler): () => void {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`no managed session: ${sessionId}`);
    managed.subscribers.add(handler);
    return () => managed.subscribers.delete(handler);
  }

  /** Disconnect all managed sessions (plugin stop / shutdown). */
  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.epochSaveTimer) clearTimeout(this.epochSaveTimer);
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    this.sessionIdToKey.clear();
    await Promise.allSettled(
      entries.map((managed) =>
        managed.handle.dispose().catch((err: unknown) =>
          this.logger?.warn?.(`[wildfire-agent] dispose ${managed.sessionId}: ${String(err)}`)
        )
      )
    );
    await this.flushEpochs().catch(() => {});
  }

  /** Evict the least recently used idle session when over the cap. */
  private evictIfNeeded(): void {
    if (this.sessions.size < this.config.maxSessions) return;
    // 只驱逐空闲会话：dispose 会 cancel 正在运行的 turn（machine.cancel），
    // 若把运行中的会话当 LRU 驱逐，用户正在执行的任务会被静默取消。
    const idle = [...this.sessions.values()]
      .filter((managed) => managed.handle.agent?.status !== "running")
      .sort((a, b) => a.lastActivity - b.lastActivity);
    const oldest = idle[0];
    if (!oldest) return; // 全部运行中：不驱逐，避免打断进行中的任务
    this.sessions.delete(oldest.sessionId);
    this.sessionIdToKey.delete(oldest.sessionId);
    oldest.handle.dispose().catch((err: unknown) =>
      this.logger?.warn?.(`[wildfire-agent] evict ${oldest.sessionId}: ${String(err)}`)
    );
    this.logger?.info?.(`[wildfire-agent] evicted idle session: ${oldest.sessionId}`);
  }

  /** Reap sessions idle longer than the configured timeout. */
  private sweep(): void {
    if (this.disposed) return;
    const now = Date.now();
    for (const managed of [...this.sessions.values()]) {
      if (now - managed.lastActivity > this.config.idleTimeoutMs) {
        this.sessions.delete(managed.sessionId);
        this.sessionIdToKey.delete(managed.sessionId);
        managed.handle.dispose().catch((err: unknown) =>
          this.logger?.warn?.(`[wildfire-agent] sweep ${managed.sessionId}: ${String(err)}`)
        );
        this.logger?.info?.(`[wildfire-agent] swept idle session: ${managed.sessionId}`);
      }
    }
  }
}
