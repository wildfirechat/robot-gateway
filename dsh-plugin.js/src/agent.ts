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
 * Deterministic dsh SessionId from an IM conversation key.
 * `wildfire:user:<userId>` / `wildfire:group:<groupId>` -> `wildfire-<sha256[:20]>[-<epoch>]`
 *
 * `epoch` starts at 0 (no suffix). A workspace switch disposes the old session
 * and bumps the epoch so the recreated session gets a fresh, collision-free id.
 */
export function sessionIdForConversation(key: string, epoch = 0): string {
  const hash = createHash("sha256").update(key.toLowerCase()).digest("hex");
  const base = hash.slice(0, 20);
  return epoch > 0 ? `wildfire-${base}-${epoch}` : `wildfire-${base}`;
}

export class AgentSessionManager {
  private ctx: any;
  private logger: any;
  private config: RequiredSessionConfig;
  private cwdProvider: CwdProvider;
  private modelProvider: ModelProvider;
  private sessions = new Map<string, ManagedSession>();
  private epochs = new Map<string, number>();
  private sessionIdToKey = new Map<string, string>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  // epoch 持久化：epoch 递增由 /cwd 切换、reset、resume 失败触发，落盘后
  // 进程重启不再归零 —— 否则重启后从 epoch 0 重新 resume 旧 cwd 的日志，
  // 会撞上"同一 sessionId 已持久化在不同 cwd"的 id collision。
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
      if (data && typeof data === "object" && data.epochs) {
        for (const [key, ep] of Object.entries<number>(data.epochs)) {
          this.epochs.set(key, ep);
        }
        this.logger?.info?.(
          `[wildfire-agent] loaded ${this.epochs.size} persisted session epochs from ${this.epochFile}`
        );
      }
    } catch (err: any) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn?.(`[wildfire-agent] failed to load session epochs: ${err.message}`);
      }
    }
  }

  /** Persist epochs to disk (debounced). */
  private persistEpochs(): void {
    if (this.epochSaveTimer) return;
    this.epochSaveTimer = setTimeout(() => {
      this.epochSaveTimer = undefined;
      this.flushEpochs().catch(() => {});
    }, 500);
  }

  /** Write the epoch map now (debounce flush / plugin stop). */
  async flushEpochs(): Promise<void> {
    if (!this.epochFile) return;
    await mkdir(path.dirname(this.epochFile), { recursive: true });
    await writeFile(
      this.epochFile,
      JSON.stringify({ epochs: Object.fromEntries(this.epochs) }, null, 2)
    );
  }

  constructor(
    ctx: any,
    logger: any,
    config: RequiredSessionConfig,
    cwdProvider: CwdProvider,
    modelProvider: ModelProvider
  ) {
    this.ctx = ctx;
    this.logger = logger;
    this.config = config;
    this.cwdProvider = cwdProvider;
    this.modelProvider = modelProvider;

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
   * A live agent is reused when present (its cwd is fixed); otherwise a fresh
   * agent is created with the workspace resolved by `cwdProvider`.
   */
  async getAgent(key: string): Promise<any> {
    let epoch = this.epochs.get(key) ?? 0;
    let sessionId = sessionIdForConversation(key, epoch);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing.handle.agent;
    }

    this.evictIfNeeded();

    const agents = this.ctx.get("agents");
    if (!agents) {
      throw new Error("dsh core services (agents) not available");
    }

    const cwd = await this.cwdProvider(key, sessionId);
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
      },
    };
    const createOptions = {
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup: (agentCtx: any) => {
        installModelSelection(agentCtx, selectionRef);
      },
    };

    let handle: any;
    try {
      handle = await agents.resume(resumeOptions);
      this.logger?.info?.(`[wildfire-agent] session resumed: key=${key}, sessionId=${sessionId}`);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (message.includes("not found")) {
        handle = await agents.create(createOptions);
      } else {
        // Resume failed for another reason (corrupt/torn log, cwd mismatch, ...).
        // Bump the epoch and create under a fresh id; the deterministic id may
        // already be persisted at a different cwd (id collision), so keep
        // bumping until create succeeds (bounded).
        this.logger?.warn?.(
          `[wildfire-agent] resume failed for ${sessionId}, bumping epoch & creating fresh: ${message}`
        );
        let created = false;
        let attempts = 0;
        while (!created && attempts < 20) {
          attempts += 1;
          const nextEpoch = (this.epochs.get(key) ?? 0) + 1;
          this.epochs.set(key, nextEpoch);
          const freshSessionId = sessionIdForConversation(key, nextEpoch);
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
        // 实际创建的 session 以最新 epoch 为准：managed 表必须以它登记，
        // 否则 dispatch 的 subscribe(session.id) 会查不到（"no managed session"）
        epoch = this.epochs.get(key) ?? 0;
        sessionId = sessionIdForConversation(key, epoch);
      }
    }

    const managed: ManagedSession = {
      key,
      sessionId,
      epoch,
      handle: { agent: handle.agent, dispose: () => handle.dispose() },
      selection: selectionRef,
      lastActivity: Date.now(),
      subscribers: new Set(),
    };
    this.sessions.set(sessionId, managed);
    this.sessionIdToKey.set(sessionId, key);
    this.logger?.info?.(
      `[wildfire-agent] session created: key=${key}, sessionId=${sessionId}, cwd=${cwd}, model=${selection.provider}/${selection.model}${selection.reasoningEffort ? ` (effort=${selection.reasoningEffort})` : ""}`
    );
    return handle.agent;
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
   * Dispose the conversation's live agent (e.g. after a `/cwd` workspace
   * switch). The next dispatch recreates the session under the new cwd with a
   * fresh session id (epoch bumped). Multi-turn context from the old session is
   * intentionally lost.
   */
  async resetSession(key: string): Promise<void> {
    const epoch = this.epochs.get(key) ?? 0;
    const sessionId = sessionIdForConversation(key, epoch);
    const managed = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.sessionIdToKey.delete(sessionId);
    this.epochs.set(key, epoch + 1);
    this.persistEpochs();
    if (managed) {
      await managed.handle.dispose().catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire-agent] reset ${sessionId}: ${String(err)}`)
      );
      this.logger?.info?.(`[wildfire-agent] session reset: key=${key}, old=${sessionId}`);
    }
  }

  /** Current session id for a conversation key (without creating an agent). */
  peekSessionId(key: string): string {
    const epoch = this.epochs.get(key) ?? 0;
    return sessionIdForConversation(key, epoch);
  }

  /**
   * Dispose the conversation's agent AND forget it entirely (workspace
   * destruction). Unlike `resetSession` (which bumps the epoch for a fresh
   * same-id session), this removes all memory of the key so a later message
   * starts from epoch 0.
   */
  async disposeWorkspace(key: string): Promise<void> {
    const epoch = this.epochs.get(key) ?? 0;
    const sessionId = sessionIdForConversation(key, epoch);
    const managed = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.sessionIdToKey.delete(sessionId);
    this.epochs.delete(key);
    this.persistEpochs();
    if (managed) {
      await managed.handle.dispose().catch((err: unknown) =>
        this.logger?.warn?.(`[wildfire-agent] disposeWorkspace ${sessionId}: ${String(err)}`)
      );
      this.logger?.info?.(`[wildfire-agent] workspace session disposed: key=${key}, sessionId=${sessionId}`);
    }
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
    return { text: finalText, reason };
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

  /** Evict the least recently used session when over the cap. */
  private evictIfNeeded(): void {
    if (this.sessions.size < this.config.maxSessions) return;
    const oldest = [...this.sessions.values()].sort(
      (a, b) => a.lastActivity - b.lastActivity
    )[0];
    if (!oldest) return;
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
