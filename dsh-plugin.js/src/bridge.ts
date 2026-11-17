/**
 * Phase 0 spike: DSH Web UI ↔ 野火 IM 会话桥接。
 *
 * 目标（仅在 WF_BRIDGE_SPIKE=1 时启用）：
 *  - 监听官方 Web UI 新建的 session（session/created），自动创建 line2 IM 群；
 *  - 记录 group ↔ session 映射（用于后续消息路由与审批/提问卡片）；
 *  - IM 群消息通过 ctx.sessionController.prompt 注入同一个 session；
 *  - 官方 UI 的用户消息 / 助手最终回复镜像回 IM 群。
 *
 * 注意：这是验证链路用的最小实现，不做附件、流式输出、标题同步，
 * 也不接管 IM 插件自己创建的 wildfire-* 会话。
 */

import fs from "node:fs";
import path from "node:path";
import { TextMessageContent } from "@wildfirechat/server-sdk";
import { getConnectedClient } from "./clients.js";
import { getAiLine } from "./config.js";
import type { WildfireConfig } from "./config.js";
import { conversationKey, dshHomePath } from "./utils.js";
import { turnOwners } from "./inbound.js";

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

export interface SessionBridge {
    isBridged(key: string): boolean;
    handleImMessage(key: string, sender: string, text: string): Promise<void>;
    dispose(): void;
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
            api.registry?.register?.(groupId, owner, cwd);
            try {
                api.workspace?.setOverride?.(key, cwd);
            } catch {
                // ignore
            }
            api.interactions?.remember?.(key, owner, { type: GROUP_TYPE, target: groupId, line });
            api.wildfireAgents?.bindExternalSession?.(key, String(session.id));
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

    // Mirror Web-origin user prompts and final assistant replies into IM.
    const onEvent = (session: any, event: any) => {
        try {
            const rec = bySession.get(String(session?.id));
            if (!rec) return;
            if (event?.type === "user/message") {
                const message = event.data;
                const rpcId = String(message?.source?.rpcId || "");
                // IM-origin prompts are injected by this bridge; don't echo them
                // back into the same group.
                if (rpcId.startsWith(SPIKE_PREFIX)) return;
                const text = contentText(message?.content).trim();
                if (text) void sendGroupText(rec.groupId, rec.line, `【桌面】${text}`);
            } else if (event?.type === "assistant/message") {
                const text = contentText(event?.data?.message?.content).trim();
                if (text) void sendGroupText(rec.groupId, rec.line, text);
            }
        } catch (err: any) {
            logger?.warn?.(`[wildfire-bridge] session event mirror failed: ${String(err?.message ?? err)}`);
        }
    };
    ctx.on?.("session/event", onEvent, { global: true });

    logger?.info?.(`[wildfire-bridge] spike registered (records=${bySession.size})`);

    return {
        isBridged(key: string): boolean {
            return byKey.has(key);
        },
        async handleImMessage(key: string, sender: string, text: string): Promise<void> {
            const rec = byKey.get(key);
            if (!rec) return;
            const body = String(text || "").trim();
            if (!body) return;
            if (!sessionController?.prompt) {
                logger?.warn?.("[wildfire-bridge] sessionController unavailable; cannot prompt");
                await sendGroupText(rec.groupId, rec.line, "桥接会话暂不可用（sessionController 未就绪）");
                return;
            }
            turnOwners.set(key, String(sender));
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
