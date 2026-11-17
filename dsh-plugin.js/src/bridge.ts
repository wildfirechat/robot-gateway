/**
 * Phase 0 spike: DSH Web UI ↔ 野火 IM 会话桥接。
 *
 * 目标（仅在 WF_BRIDGE_SPIKE=1 时启用）：
 *  - 监听官方 Web UI 新建的 session（session/created），自动创建 line2 IM 群；
 *  - 记录 group ↔ session 映射（用于后续消息路由与审批/提问卡片）；
 *  - IM 群消息通过 ctx.sessionController.prompt 注入同一个 session；
 *  - 官方 UI 的用户消息 / 助手最终回复镜像回 IM 群；
 *  - 官方 UI 的回合状态（running/thinking/tool/waiting_user/done）镜像到
 *    scope=31 type=1 会话用户设置，手机端零改动即可显示状态点/状态条。
 *
 * 注意：这是验证链路用的最小实现，不做附件、流式输出、标题同步，
 * 也不接管 IM 插件自己创建的 wildfire-* 会话。
 */

import fs from "node:fs";
import path from "node:path";
import {
    StreamingTextGeneratedMessageContent,
    StreamingTextGeneratingMessageContent,
    TextMessageContent,
} from "@wildfirechat/server-sdk";
import { getConnectedClient } from "./clients.js";
import { getAiLine } from "./config.js";
import type { WildfireConfig } from "./config.js";
import { conversationKey, dshHomePath } from "./utils.js";
import { turnOwners } from "./inbound.js";
import { describeTurnFailure, extractTurnFailure, turnReasonKind } from "./failures.js";
import { applyAsrHint } from "./asrPrompt.js";

const GROUP_TYPE = 1;
const SPIKE_PREFIX = "wildfire:";

interface BridgeRecord {
    sessionId: string;
    groupId: string;
    key: string;
    cwd: string;
    title: string;
    line: number;
    createdAt: number;
}

/** 桥接群里手机端消息的附加信息（目前用于语音的 ASR 结果）。 */
export interface BridgeInboundOptions {
    /** ASR 转写结果（语音消息且 ASR 成功时）。 */
    transcript?: string;
    /** 是否对这条消息尝试过 ASR（配置了 asrServer 的语音消息）。 */
    asrAttempted?: boolean;
    /** 消息 payload type（2 = 语音）。 */
    payloadType?: number;
}

export interface SessionBridge {
    isBridged(key: string): boolean;
    handleImMessage(
        key: string,
        sender: string,
        text: string,
        options?: BridgeInboundOptions,
    ): Promise<void>;
    dispose(): void;
}

/**
 * 手机端消息 → 注入官方 UI 会话的正文。
 * 语音消息的 ASR 结果会加上「这是识别文本，请结合上下文静默纠正」的提示；
 * 未转写成功的语音则提示模型不要猜测。普通文本原样返回。
 */
export function buildBridgedPrompt(
    bodyText: string,
    options?: BridgeInboundOptions,
): string {
    const text = String(bodyText || "").trim();
    if (!text) return "";
    if (options?.transcript || options?.asrAttempted) {
        return applyAsrHint(text, {
            transcript: options.transcript,
            attempted: !!options.asrAttempted,
        });
    }
    return text;
}

interface BridgeState {
    records: Record<string, BridgeRecord>;
}

function bridgeFile(): string {
    return dshHomePath("wildfire-session-bridge.json");
}

function loadState(): BridgeState {
    try {
        const raw = JSON.parse(fs.readFileSync(bridgeFile(), "utf8"));
        if (raw && typeof raw === "object" && raw.records && typeof raw.records === "object") {
            return { records: raw.records };
        }
    } catch {
        // first run
    }
    return { records: {} };
}

function contentText(content: any): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((c: any) => c && typeof c.type === "string")
        .map((c: any) => {
            if (c.type === "text" && typeof c.text === "string") return c.text;
            return "";
        })
        .join("");
}

async function sendGroupText(groupId: string, line: number, text: string): Promise<void> {
    const client = getConnectedClient();
    if (!client || !text) return;
    const content = new TextMessageContent();
    content.content = text;
    try {
        await client.sendMessage({ type: GROUP_TYPE, target: groupId, line }, content.encode());
    } catch {
        // best effort
    }
}

/**
 * 流式回复（野火 14/15/20 协议，按 streamId 全量替换）：
 * - generating(14)：生成中，客户端按 streamId 替换气泡内容（全量文本）；
 * - completed(15)：最终文本；
 * - cancelled(20)：取消生成（客户端按 streamId 删除生成中/已生成气泡）。
 */
async function sendGroupStream(
    groupId: string,
    line: number,
    text: string,
    streamId: string,
    state: "generating" | "completed" | "cancelled"
): Promise<void> {
    const client = getConnectedClient();
    if (!client) return;
    const conversation = { type: GROUP_TYPE, target: groupId, line };
    let payload: any;
    try {
        if (state === "generating") {
            const generating = new StreamingTextGeneratingMessageContent();
            generating.text = text;
            generating.streamId = streamId;
            payload = generating.encode();
        } else if (state === "cancelled") {
            payload = { type: 20, searchableContent: text || "生成已取消", content: streamId };
        } else {
            const generated = new StreamingTextGeneratedMessageContent();
            generated.text = text;
            generated.streamId = streamId;
            payload = generated.encode();
        }
        await client.sendMessage(conversation, payload);
    } catch {
        // best effort
    }
}

export function registerSessionBridge(api: any, ctx: any, logger: any): SessionBridge {
    const state = loadState();
    const byKey = new Map<string, BridgeRecord>();
    const bySession = new Map<string, BridgeRecord>();
    for (const rec of Object.values(state.records)) {
        if (!rec || !rec.sessionId || !rec.groupId) continue;
        if (!rec.key) rec.key = conversationKey(true, rec.groupId);
        if (!rec.line) rec.line = getAiLine(api.config);
        byKey.set(rec.key, rec);
        bySession.set(rec.sessionId, rec);
    }
    const disposers: Array<() => void> = [];
    let sessionController: any;

    const persist = () => {
        try {
            fs.mkdirSync(path.dirname(bridgeFile()), { recursive: true });
            fs.writeFileSync(bridgeFile(), JSON.stringify({ records: state.records }, null, 2), {
                mode: 0o600,
            });
        } catch (err: any) {
            logger?.warn?.(`[wildfire-bridge] persist failed: ${String(err?.message ?? err)}`);
        }
    };

    const addRecord = (rec: BridgeRecord) => {
        state.records[rec.groupId] = rec;
        byKey.set(rec.key, rec);
        bySession.set(rec.sessionId, rec);
        persist();
    };

    // 把映射重新登记到插件运行时（IM 回复目标 / 工作区 / 外部会话路由）。
    // 进程内新建的会话与重启后从文件加载的会话都必须登记：否则 pushStatus
    // 找不到 ConversationTarget 会静默丢弃状态，IM 消息也找不到会话。
    const ownerUserId = () => String(api.robotOwner || process.env.WF_OWNER_USER_ID || "");
    const registerRecord = (rec: BridgeRecord) => {
        const owner = ownerUserId();
        try { api.registry?.register?.(rec.groupId, owner, rec.cwd); } catch { /* ignore */ }
        try { api.workspace?.setOverride?.(rec.key, rec.cwd); } catch { /* ignore */ }
        try {
            api.interactions?.remember?.(rec.key, owner, {
                type: GROUP_TYPE,
                target: rec.groupId,
                line: rec.line,
            });
        } catch { /* ignore */ }
        try { api.wildfireAgents?.bindExternalSession?.(rec.key, rec.sessionId); } catch { /* ignore */ }
    };
    // 启动时把历史上已建群的会话重新登记（重启后状态/消息路由仍然有效）。
    for (const rec of bySession.values()) registerRecord(rec);
    if (bySession.size) logger?.info?.(`[wildfire-bridge] re-registered ${bySession.size} bridged session(s)`);

    // Session controller is provided by the Web composition; inject lazily so
    // a chat-only profile (without dsh-web-app) still loads the plugin.
    try {
        ctx.inject?.(["sessionController"], (scope: any) => {
            sessionController = scope.sessionController;
            logger?.info?.("[wildfire-bridge] sessionController ready");
        });
    } catch (err: any) {
        logger?.warn?.(`[wildfire-bridge] sessionController inject failed: ${String(err?.message ?? err)}`);
    }

    // ── 状态镜像（scope=31 type=1）─────────────────────────────────────────
    // 官方 UI 里创建的会话只有 DSH 自己的 session 状态；手机端读的是 IM 的
    // scope=31 会话级用户设置。建群时已经 remember(key, ...)，这里把回合事件
    // 映射成 RuntimeState，PC/Android/iOS/Flutter 客户端无需改动即可显示状态。
    const pushStatus = (rec: BridgeRecord, patch: Record<string, unknown>) => {
        try {
            api.interactions?.pushStatus?.(rec.key, patch);
        } catch (err: any) {
            logger?.warn?.(
                `[wildfire-bridge] status push failed key=${rec.key}: ${String(err?.message ?? err)}`
            );
        }
    };

    /** 回合开始：刷新会话信息（sessionId/cwd/model，best effort）并置 running。 */
    const pushTurnStart = async (session: any, rec: BridgeRecord): Promise<void> => {
        const patch: Record<string, unknown> = {
            state: "running",
            sessionId: rec.sessionId,
            ...(rec.cwd ? { cwd: rec.cwd } : {}),
        };
        try {
            const selection = await api.models?.peek?.(rec.key, session);
            if (selection?.provider && selection?.model) {
                patch.model = `${selection.provider}/${selection.model}`;
                if (selection.reasoningEffort) patch.reasoningEffort = String(selection.reasoningEffort);
            }
        } catch {
            // 模型信息拿不到不影响状态推送
        }
        pushStatus(rec, patch);
    };

    // ── 流式回复镜像（14/15/20，按 streamId 全量替换）────────────────────
    // 官方 UI 的助手增量在 session/event 的 assistant/chunk 里；按会话节流成
    // generating 消息，回合结束用最终文本补一条 completed。NO_REPLY（模型决定
    // 不回复）或取消则发 cancelled(20) 让客户端删掉气泡。
    const STREAM_THROTTLE_MS = 300;
    interface BridgeStream {
        streamId: string;
        text: string;
        timer?: NodeJS.Timeout;
        lastFlush: number;
    }
    const streams = new Map<string, BridgeStream>();
    /** 实时增量帧去重（dsh 可能按 revision 重放同一帧）：`attemptId:index`。 */
    const streamFrames = new Map<string, Set<string>>();
    const newStreamId = () =>
        `wildfire-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const flushStream = (rec: BridgeRecord, st: BridgeStream): void => {
        const text = st.text.trim();
        if (!text) return;
        // 与 IM 会话路径一致：整段文本精确等于 NO_REPLY 时不显示、最后取消。
        if (text.toUpperCase() === "NO_REPLY") return;
        st.lastFlush = Date.now();
        logger?.info?.(`[wildfire-bridge] stream flush: len=${text.length}`);
        void sendGroupStream(rec.groupId, rec.line, text, st.streamId, "generating");
    };

    const pushStreamChunk = (rec: BridgeRecord, delta: string): void => {
        let st = streams.get(rec.sessionId);
        if (!st) {
            st = { streamId: newStreamId(), text: "", lastFlush: 0 };
            streams.set(rec.sessionId, st);
            logger?.info?.(`[wildfire-bridge] stream start: session=${rec.sessionId}`);
            void sendGroupStream(rec.groupId, rec.line, "…", st.streamId, "generating");
        }
        st.text += delta;
        if (st.timer) return;
        const wait = Math.max(0, STREAM_THROTTLE_MS - (Date.now() - st.lastFlush));
        const cur = st;
        cur.timer = setTimeout(() => {
            cur.timer = undefined;
            flushStream(rec, cur);
        }, wait);
        cur.timer.unref?.();
    };

    const finishStream = (rec: BridgeRecord, kind: string, failureText?: string): void => {
        const st = streams.get(rec.sessionId);
        streams.delete(rec.sessionId);
        if (st?.timer) clearTimeout(st.timer);
        const streamId = st?.streamId ?? newStreamId();
        const text = (st?.text ?? "").trim();
        const cancelled = ["aborted", "interrupted", "cancelled"].includes(kind);
        const noReply = text.toUpperCase() === "NO_REPLY";
        const action: "generating" | "completed" | "cancelled" =
            kind === "error" ? "completed" : cancelled || noReply || !text ? "cancelled" : "completed";
        logger?.info?.(
            `[wildfire-bridge] stream finish: action=${action}, kind=${kind}, len=${text.length}, text=${JSON.stringify(text.slice(0, 60))}`
        );
        if (action === "completed") {
            void sendGroupStream(rec.groupId, rec.line, text || failureText || "⚠️ 本轮失败", streamId, "completed");
        } else {
            void sendGroupStream(rec.groupId, rec.line, "生成已取消", streamId, "cancelled");
        }
    };

    // 建群是异步的：会话刚创建时第一回合的 turn/start 可能早于 BridgeRecord。
    // 先按 sessionId 记住最新状态，建群完成后补推一次，避免首个回合没有状态。
    const pendingStatus = new Map<string, Record<string, unknown>>();
    const pendingPatchFor = (sessionId: string, event: any): Record<string, unknown> | undefined => {
        switch (event?.type) {
            case "turn/start":
                return { state: "running", ...(sessionId ? { sessionId } : {}) };
            case "step/start":
                return { state: "running", phase: "thinking" };
            case "tool/call":
                return { phase: "tool", toolName: String(event.data?.name ?? "") };
            case "tool/result":
                return { phase: "thinking" };
            case "turn/end": {
                const kind = turnReasonKind(event.data?.reason);
                if (kind === "error") {
                    const failure = extractTurnFailure(event.data?.reason);
                    return {
                        state: "done",
                        phase: "done",
                        reason: "error",
                        error: failure ? describeTurnFailure(failure) : "回合失败",
                    };
                }
                if (["aborted", "interrupted", "cancelled"].includes(kind)) {
                    return { state: "done", phase: "done", reason: "cancelled" };
                }
                return { state: "done", phase: "done", reason: "completed" };
            }
            default:
                return undefined;
        }
    };

    const createGroupForSession = async (session: any): Promise<void> => {
        const client = getConnectedClient();
        const owner = String(api.robotOwner || process.env.WF_OWNER_USER_ID || "");
        const robotId = String(api.config?.robotId || "");
        if (!client || !owner || !robotId) {
            logger?.warn?.(
                `[wildfire-bridge] skip session ${String(session?.id)}: client/owner/robot not ready`
            );
            return;
        }
        const cwd = String(session?.header?.cwd || "");
        const title = path.basename(cwd) || "DSH Web 会话";
        const line = getAiLine(api.config);
        try {
            const result = await client.createGroup(
                { name: title, portrait: "", join_type: 2 },
                [
                    { member_id: owner, type: 0 },
                    { member_id: robotId, type: 0 },
                ],
                owner,
                [line],
                null
            );
            const groupId = result?.result?.group_id;
            if (result?.code !== 0 || !groupId) {
                logger?.warn?.(
                    `[wildfire-bridge] create group failed for session ${String(session?.id)}: ${String(result?.msg ?? result?.code)}`
                );
                return;
            }
            const key = conversationKey(true, groupId);
            const record: BridgeRecord = {
                sessionId: String(session.id),
                groupId,
                key,
                cwd,
                title,
                line,
                createdAt: Date.now(),
            };
            addRecord(record);
            registerRecord(record);
            const pending = pendingStatus.get(record.sessionId);
            if (pending) {
                pendingStatus.delete(record.sessionId);
                pushStatus(record, pending);
            }
            logger?.info?.(
                `[wildfire-bridge] web session ${String(session.id)} -> group ${groupId} (${title})`
            );
        } catch (err: any) {
            logger?.warn?.(
                `[wildfire-bridge] create group for session ${String(session?.id)} failed: ${String(err?.message ?? err)}`
            );
        }
    };

    // New sessions created by the official Web UI (the IM plugin's own ids start
    // with "wildfire-"; subagent children carry a parentSession).
    const onCreated = (session: any) => {
        try {
            const id = String(session?.id || "");
            if (!id || id.startsWith("wildfire-")) return;
            if (session?.header?.parentSession) return;
            if (bySession.has(id)) return;
            logger?.info?.(`[wildfire-bridge] web session created: id=${id}, cwd=${session?.header?.cwd ?? "-"}`);
            void createGroupForSession(session);
        } catch (err: any) {
            logger?.warn?.(`[wildfire-bridge] session/created handling failed: ${String(err?.message ?? err)}`);
        }
    };
    ctx.on?.("session/created", onCreated, { global: true });
    disposers.push(() => {
        // cordis returns no disposer from ctx.on; listeners are owned by the plugin
        // scope and disposed with it.
    });

    // Mirror Web-origin user prompts and final assistant replies into IM, and
    // project turn lifecycle events onto the scope=31 status channel.
    const onEvent = (session: any, event: any) => {
        try {
            const sessionId = String(session?.id ?? "");
            const rec = bySession.get(sessionId);
            if (!rec) {
                const patch = pendingPatchFor(sessionId, event);
                if (patch && sessionId) {
                    pendingStatus.set(sessionId, { ...(pendingStatus.get(sessionId) ?? {}), ...patch });
                }
                return;
            }
            switch (event?.type) {
                case "user/message": {
                    const message = event.data;
                    const rpcId = String(message?.source?.rpcId || "");
                    // IM-origin prompts are injected by this bridge; don't echo them
                    // back into the same group.
                    if (rpcId.startsWith(SPIKE_PREFIX)) return;
                    const text = contentText(message?.content).trim();
                    if (text) void sendGroupText(rec.groupId, rec.line, `【桌面】${text}`);
                    return;
                }
                case "assistant/message": {
                    // 该 step 的完整助手消息：作为流式气泡的权威全文（后续 steps 覆盖）。
                    const text = contentText(event?.data?.message?.content).trim();
                    const st = streams.get(sessionId);
                    if (text && st) st.text = text;
                    return;
                }
                // ── 流式回复：turn 开始的占位气泡 ──
                case "turn/start": {
                    const stream = { streamId: newStreamId(), text: "", lastFlush: 0 } as BridgeStream;
                    streams.set(sessionId, stream);
                    streamFrames.delete(sessionId);
                    void sendGroupStream(rec.groupId, rec.line, "…", stream.streamId, "generating");
                    void pushTurnStart(session, rec);
                    return;
                }
                case "assistant/chunk": {
                    const chunk = event.data?.chunk;
                    if (chunk?.type === "text-delta" && typeof chunk.text === "string" && chunk.text) {
                        pushStreamChunk(rec, chunk.text);
                    }
                    return;
                }
                case "step/start":
                    pushStatus(rec, { state: "running", phase: "thinking" });
                    return;
                case "tool/call":
                    // 工具调用：状态栏显示具体工具名
                    pushStatus(rec, { phase: "tool", toolName: String(event.data?.name ?? "") });
                    return;
                case "tool/result":
                    // 工具结束 → 模型继续思考，活动相切回 thinking
                    pushStatus(rec, { phase: "thinking" });
                    return;
                case "turn/end": {
                    const reason = event.data?.reason;
                    const kind = turnReasonKind(reason);
                    if (kind === "error") {
                        const failure = extractTurnFailure(reason);
                        const notice = failure ? describeTurnFailure(failure) : "回合失败";
                        finishStream(rec, kind, notice);
                        pushStatus(rec, {
                            state: "done",
                            phase: "done",
                            reason: "error",
                            error: notice,
                        });
                    } else if (["aborted", "interrupted", "cancelled"].includes(kind)) {
                        finishStream(rec, kind);
                        pushStatus(rec, { state: "done", phase: "done", reason: "cancelled" });
                    } else {
                        finishStream(rec, kind);
                        pushStatus(rec, { state: "done", phase: "done", reason: "completed" });
                    }
                    return;
                }
                default:
                    return;
            }
        } catch (err: any) {
            logger?.warn?.(`[wildfire-bridge] session event mirror failed: ${String(err?.message ?? err)}`);
        }
    };
    ctx.on?.("session/event", onEvent, { global: true });

    // dsh >= 0.1.3 的实时模型增量走 process-local 的 `agent/assistant-stream`
    // （会话事件里的 assistant/chunk 已移除）。这里按 payload.agent.session.id
    // 路由到桥接会话，合成流式增量；frame 带 (attemptId, index) 时去重。
    ctx.on?.("agent/assistant-stream", (payload: any) => {
        try {
            const frame = payload?.frame;
            if (frame?.type !== "chunk") return;
            const chunk = frame.chunk;
            if (chunk?.type !== "text-delta" || typeof chunk.text !== "string" || !chunk.text) return;
            const sessionId = String(payload?.agent?.session?.id ?? "");
            const rec = bySession.get(sessionId);
            if (!rec) return;
            if (frame.attemptId !== undefined && frame.index !== undefined) {
                const frameKey = `${String(frame.attemptId)}:${String(frame.index)}`;
                let seen = streamFrames.get(sessionId);
                if (!seen) {
                    seen = new Set();
                    streamFrames.set(sessionId, seen);
                }
                if (seen.has(frameKey)) return;
                seen.add(frameKey);
            }
            pushStreamChunk(rec, chunk.text);
        } catch (err: any) {
            logger?.warn?.(`[wildfire-bridge] assistant-stream handling failed: ${String(err?.message ?? err)}`);
        }
    });

    // 等待审批/提问时同步 waiting_user（手机端显示"等待审批/等待确认"）。
    // 只旁观，不注册 answerer：回答仍由官方 Web UI 处理，这里只把 next() 透传。
    const observeInteraction = (eventName: string, interaction: "question" | "approval") => {
        try {
            ctx.on?.(eventName, async (request: any, next: () => Promise<any>) => {
                const rec = bySession.get(String(request?.agent?.session?.id ?? ""));
                if (!rec) return next();
                pushStatus(rec, { state: "waiting_user", interaction });
                try {
                    return await next();
                } finally {
                    pushStatus(rec, { state: "running" });
                }
            });
        } catch (err: any) {
            logger?.warn?.(`[wildfire-bridge] ${eventName} observer failed: ${String(err?.message ?? err)}`);
        }
    };
    observeInteraction("user-questions/request", "question");
    observeInteraction("approval/request", "approval");

    logger?.info?.(`[wildfire-bridge] spike registered (records=${bySession.size})`);

    return {
        isBridged(key: string): boolean {
            return byKey.has(key);
        },
        async handleImMessage(
            key: string,
            sender: string,
            text: string,
            options?: BridgeInboundOptions,
        ): Promise<void> {
            const rec = byKey.get(key);
            if (!rec) return;
            const body = buildBridgedPrompt(text, options);
            if (!body) return;
            if (options?.asrAttempted) {
                logger?.info?.(
                    `[wildfire-bridge] inbound voice: group=${rec.groupId}, asr=${options.transcript ? "ok" : "failed"}, bodyLen=${body.length}`
                );
            }
            if (!sessionController?.prompt) {
                logger?.warn?.("[wildfire-bridge] sessionController unavailable; cannot prompt");
                await sendGroupText(rec.groupId, rec.line, "桥接会话暂不可用（sessionController 未就绪）");
                return;
            }
            turnOwners.set(key, String(sender));
            // 手机端发起的回合：立刻置 running（turn/start 事件随后也会推一次）
            pushStatus(rec, {
                state: "running",
                sessionId: rec.sessionId,
                ...(rec.cwd ? { cwd: rec.cwd } : {}),
            });
            try {
                // The injected session controller is the Remote-backed facade:
                // prompt(request, signal) requires a caller cancellation signal.
                const signal = new AbortController().signal;
                await sessionController.prompt({
                    sessionId: rec.sessionId,
                    content: [{ type: "text", text: body }],
                    requestId: `${SPIKE_PREFIX}${rec.groupId}:${Date.now()}`,
                }, signal);
                logger?.info?.(`[wildfire-bridge] IM -> session: group=${rec.groupId}, session=${rec.sessionId}`);
            } catch (err: any) {
                logger?.warn?.(
                    `[wildfire-bridge] prompt failed group=${rec.groupId}: ${String(err?.message ?? err)}`
                );
                await sendGroupText(rec.groupId, rec.line, `桥接调用失败：${String(err?.message ?? err).slice(0, 200)}`);
            }
        },
        dispose(): void {
            for (const fn of disposers) {
                try {
                    fn();
                } catch {
                    // ignore
                }
            }
            byKey.clear();
            bySession.clear();
        },
    };
}
