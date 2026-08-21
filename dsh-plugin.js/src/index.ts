/**
 * Wildfire IM channel plugin for DeepSeek Harness.
 *
 * Cordis plugin — install into a dsh profile and activate via the profile's
 * patch layer (see README.md / DSH_INTEGRATION.md).
 */

import { startClient, stopClient, getConnectedClient, isClientConnected } from "./clients.js";
import { turnOwners } from "./inbound.js";
import { getConfig, getSessionConfig, validateConfig } from "./config.js";
import type { WildfireConfig } from "./config.js";
import { AgentSessionManager } from "./agent.js";
import { WorkspaceResolver } from "./workspace.js";
import { AccessController } from "./access.js";
import { ModelSelector } from "./model.js";
import { InteractionManager, type CardSender, type ConversationTarget } from "./interactive.js";
import { DshGroupRegistry } from "./registry.js";
import { buildPayload } from "./protocol.js";
import { WhitelistFilter } from "./whitelist.js";
import { TextMessageContent } from "@wildfirechat/server-sdk";

export const name = "wildfire";

// cordis 4: accessing an undeclared service property throws
// (`cannot get property "x" without inject`), so every service used must be
// injected. `userQuestions` / `attachments` / `sessionPersistence` / `goals`
// are provided by the base bundle.
export const inject = ["agents", "sessions", "agentDefaultModel", "userQuestions", "attachments", "sessionPersistence", "goals"];

/**
 * Plugin entry.
 * @param ctx - Cordis context of the dsh process.
 * @param config - config from the profile patch row (`config` field).
 */
export function apply(ctx: any, config: any): void {
  // dsh's default logger only buffers messages (no console sink), so in a
  // GUI-less profile nothing would be visible. Export to stderr ourselves.
  try {
    ctx.logger?.exporter?.({
      export: (message: any) => {
        const time = new Date(message.ts).toISOString().slice(11, 19);
        const args = (message.args ?? [])
          .map((a: any) => (a instanceof Error ? a.message : String(a)))
          .join(" ");
        process.stderr.write(`[${time}] [${message.type}] [${message.name}] ${args}\n`);
      },
    });
  } catch {
    // logger exporter unavailable — ignore
  }

  const logger = ctx.logger("wildfire");
  const cfg = getConfig(ctx, config);

  // Connection watchdog (assigned inside the init IIFE; cleared on dispose).
  let watchdog: ReturnType<typeof setInterval> | null = null;

  // Group-owner lookup for `/cwd` authorization in group chats (the robot must
  // be a member of the group for getGroupInfo to succeed).
  const resolveGroupOwner = async (groupId: string): Promise<string | null> => {
    const client = getConnectedClient();
    if (!client) return null;
    try {
      const info = await client.getGroupInfo(groupId);
      return info?.code === 0 ? (info?.result?.owner ?? null) : null;
    } catch {
      return null;
    }
  };

  // The API object handed to clients/inbound (mirrors openclaw's `api`).
  const api: {
    logger: any;
    config: WildfireConfig;
    ctx: any;
    wildfireAgents: AgentSessionManager;
    workspace: WorkspaceResolver;
    access: AccessController;
    models: ModelSelector;
    interactions: InteractionManager;
    whitelist: WhitelistFilter;
    registry: DshGroupRegistry;
    robotOwner: string | undefined;
  } = {
    logger,
    config: cfg,
    ctx,
    workspace: new WorkspaceResolver(cfg, logger),
    access: new AccessController(cfg, resolveGroupOwner),
    models: new ModelSelector(cfg, ctx, logger),
    whitelist: new WhitelistFilter(cfg, logger),
    registry: new DshGroupRegistry(logger),
    robotOwner: undefined,
    interactions: new InteractionManager(
      cfg,
      logger,
      {
        sendText: async (target: ConversationTarget, text: string) => {
          const client = getConnectedClient();
          if (!client) throw new Error("Wildfire not connected");
          const content = new TextMessageContent();
          content.content = text;
          const conversation = {
            type: target.conv.type,
            target: target.conv.type === 0 ? target.sender : target.conv.target,
            line: target.conv.line,
          };
          const result = await client.sendMessage(conversation, content.encode());
          if (!result?.isSuccess?.()) {
            logger.warn?.(`[wildfire] interaction send failed: ${result?.getMsg?.() ?? "unknown"}`);
          }
        },
        sendCard: async (
          target: ConversationTarget,
          type: number,
          data: unknown,
          summary: string,
          persistFlag: number
        ) => {
          const client = getConnectedClient();
          if (!client) throw new Error("Wildfire not connected");
          const payload = buildPayload(type, data, summary, persistFlag);
          const conversation = {
            type: target.conv.type,
            target: target.conv.type === 0 ? target.sender : target.conv.target,
            line: target.conv.line,
          };
          const result = await client.sendMessage(conversation, payload);
          if (!result?.isSuccess?.()) {
            throw new Error(result?.getMsg?.() ?? "card send failed");
          }
          const uid = String(result?.getResult()?.messageUid ?? "");
          logger.info?.(
            `[wildfire] card sent: type=${type}, uid=${uid}, summary=${summary.slice(0, 60)}`
          );
          return uid;
        },
        updateCard: async (messageId: string, type: number, data: unknown, summary: string) => {
          const client = getConnectedClient();
          if (!client) return;
          const payload = buildPayload(type, data, summary, 1);
          await client.updateMessage(messageId, payload);
        },
        setConversationState: async (key: string, payload: Record<string, unknown>) => {
          const client = getConnectedClient();
          if (!client) return;
          const target = api.interactions.getConversation(key);
          if (!target) return;
          // scope=31 conversation user setting: private → target = the other
          // user; group → target = groupId. type=1 = 状态 (business convention).
          const conversation =
            target.conv.type === 0
              ? { type: 0, target: target.sender, line: 0 }
              : { type: target.conv.type, target: target.conv.target, line: target.conv.line };
          const result = await client.updateConversationUserSetting(
            conversation,
            1,
            JSON.stringify(payload)
          );
          if (result?.code !== 0) {
            logger.warn?.(`[wildfire] conversation state set failed: ${result?.msg ?? result?.code}`);
          } else {
            logger.info?.(
              `[wildfire] conversation state set: key=${key}, type=${conversation.type}, target=${conversation.target}, value=${JSON.stringify(payload)}`
            );
          }
        },
      } satisfies CardSender,
      (sessionId: string) => api.wildfireAgents.keyForSessionId(sessionId),
      (key: string) => turnOwners.get(key)
    ),
    wildfireAgents: new AgentSessionManager(
      ctx,
      logger,
      getSessionConfig(cfg),
      // Resolve the working directory for each conversation before agent creation.
      (key, sessionId) => api.workspace.resolve(key, sessionId),
      // Resolve the model selection for each conversation before agent creation.
      (key) => api.models.resolve(key)
    ),
  };

  // cordis 4 has no `ready` event — initialize after the loader tree settles,
  // exactly like the web-runtime and headless runner (fire-and-forget so the
  // loader does not deadlock waiting on this apply).
  void (async () => {
    try {
      await ctx.get("loader")?.await?.();
    } catch (err) {
      logger.warn?.(`[wildfire] loader await failed: ${String(err)}`);
    }

    const error = validateConfig(cfg);
    if (error) {
      logger.error(`[wildfire] invalid config: ${error}`);
      return;
    }
    try {
      // Register the interactive seams AFTER the loader tree settled: in the
      // web profile the Host apiproxy has already claimed the userQuestions
      // provider, and registering first would crash ITS activation instead.
      api.interactions.register(ctx);
      // Load persisted state (workspace bindings + dynamic allowlist + DSH registry).
      await api.workspace.init();
      await api.whitelist.init();
      await api.registry.init();

      // Connect with retry: the gateway may be briefly down (restart, network).
      // The SDK auto-reconnects once connected; a failed FIRST connect needs
      // our own exponential backoff so the robot recovers when the gateway
      // comes back. Reused by the watchdog below (belt-and-braces against a
      // stuck SDK reconnect).
      let connectPromise: Promise<void> | null = null;
      const connectWithRetry = (): Promise<void> => {
        if (connectPromise) return connectPromise;
        connectPromise = (async () => {
          let attempt = 0;
          for (;;) {
            try {
              await startClient(api, cfg);
              break;
            } catch (err) {
              attempt += 1;
              const delay = Math.min(30_000, 5_000 * 2 ** Math.min(attempt - 1, 4));
              // error level: dsh's default logger level hides warn in GUI-less profiles
              logger.error?.(
                `[wildfire] connect failed (attempt ${attempt}), retrying in ${delay}ms: ${String(err)}`
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        })().finally(() => {
          connectPromise = null;
        });
        return connectPromise;
      };

      await connectWithRetry();

      // Watchdog: if the connection drops and neither the SDK reconnect nor the
      // first-connect loop recovers within the window, tear down and reconnect
      // from scratch. Guards against the SDK's "Already authenticated" zombie
      // (gateway restarts previously left the client permanently dead).
      const WATCHDOG_MS = 15_000;
      watchdog = setInterval(() => {
        void (async () => {
          if (isClientConnected()) return;
          if (connectPromise) return; // a connect/reconnect is already in flight
          logger.warn?.("[wildfire] watchdog: connection lost, reconnecting...");
          await stopClient(api).catch(() => {});
          await connectWithRetry().catch(() => {});
        })();
      }, WATCHDOG_MS);

      // Fetch the robot profile to learn its owner (whitelist auto-admission).
      try {
        const profile = await getConnectedClient()?.getProfile();
        const owner = profile?.code === 0 ? (profile?.result?.owner ?? undefined) : undefined;
        api.whitelist.setOwner(owner);
        api.robotOwner = owner;
      } catch (err: any) {
        logger.warn?.(`[wildfire] failed to fetch robot profile: ${err.message}`);
      }

      logger.info("[wildfire] service started");
    } catch (err) {
      logger.error("[wildfire] failed to start:", err);
    }
  })();

  ctx.on("dispose", async () => {
    if (watchdog) clearInterval(watchdog);
    await stopClient(api);
    api.interactions.dispose();
    await api.workspace.flush().catch(() => {});
    await api.whitelist.flush().catch(() => {});
    await api.registry.flush().catch(() => {});
    await api.wildfireAgents.disposeAll();
    logger.info("[wildfire] service stopped");
  });

  logger.info("[wildfire] plugin loaded");
}

export default apply;
