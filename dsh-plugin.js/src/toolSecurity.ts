/**
 * Security helpers for model-facing tools.
 *
 * The DSH agent exposes tools globally, so every tool that reads the local
 * user's IM data or the host filesystem must check WHO started the current
 * turn. The tool execution context carries only the DSH session id, so we map
 * it back to the IM conversation key and look up the sender recorded by the
 * inbound dispatcher (see turnContext.ts).
 *
 * Policy:
 *  - Privileged tools are owner/admin-only by default (`security.toolsOwnerOnly`).
 *    Guest turns and sub-agent turns (unmapped session ids) are denied.
 *  - File-sending tools may only read files inside the configured workspace
 *    roots (realpath-compared), which blocks arbitrary local-file exfiltration.
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { getAccessConfig, getSecurityConfig, getWorkspaceConfig, type WildfireConfig } from "./config.js";
import { turnOwners, turnWriteTrust, markTurnTainted, isVoiceTurn } from "./turnContext.js";

/** Maximum size of a file handed to the IM send tools (100 MB). */
export const MAX_SEND_FILE_BYTES = 100 * 1024 * 1024;

/** DSH session id carried by a tool execution. */
function sessionIdOf(exec: any): string {
    return String(exec?.agent?.id ?? exec?.agent?.session?.id ?? exec?.sessionId ?? "").trim();
}

/** IM conversation key mapped to the executing DSH session, when known. */
export function resolveSessionKey(api: any, exec: any): string | undefined {
    const sessionId = sessionIdOf(exec);
    if (!sessionId) return undefined;
    const key = api?.wildfireAgents?.keyForSessionId?.(sessionId);
    return key ? String(key) : undefined;
}

/** Resolve the IM sender that started the current tool call, when known. */
export function resolveTurnSender(api: any, exec: any): string | undefined {
    const key = resolveSessionKey(api, exec);
    if (!key) return undefined;
    const sender = turnOwners.get(key);
    return sender ? String(sender) : undefined;
}

/** Whether *sender* is the robot owner or an entry of access.adminUsers. */
export function isOwnerOrAdmin(api: any, sender: string | undefined): boolean {
    const value = String(sender || "").trim();
    if (!value) return false;
    const owner = String(api?.robotOwner || process.env.WF_OWNER_USER_ID || "").trim();
    if (owner && value === owner) return true;
    const admins = getAccessConfig((api?.config || {}) as WildfireConfig).adminUsers;
    return Array.isArray(admins) && admins.map(String).includes(value);
}

function toolsOwnerOnly(config: WildfireConfig): boolean {
    const security = getSecurityConfig(config) as unknown as { toolsOwnerOnly?: boolean };
    if (process.env.WF_TOOLS_OWNER_ONLY === "0") return false;
    return security.toolsOwnerOnly !== false;
}

/**
 * Throw unless the current turn was started by the robot owner or an admin.
 * No-op when `security.toolsOwnerOnly` is explicitly disabled.
 */
export function requireOwnerTurn(api: any, exec: any, feature: string): void {
    const config = (api?.config || {}) as WildfireConfig;
    if (!toolsOwnerOnly(config)) return;
    const sender = resolveTurnSender(api, exec);
    if (!sender) {
        // Bridged sessions are created by the desktop owner and driven locally
        // (web UI) when no IM sender is recorded; IM-driven turns always record
        // the sender above. Everything else (sub-agent sessions etc.) is denied.
        const key = resolveSessionKey(api, exec);
        if (key && api?.bridge?.isBridged?.(key)) return;
        throw new Error(
            `${feature}: 仅限机器人 owner/管理员在 IM 会话或本地桥接会话中触发（当前会话未关联发送者）`
        );
    }
    if (!isOwnerOrAdmin(api, sender)) {
        throw new Error(`${feature}: 仅限机器人 owner/管理员使用（当前发送者 ${sender}）`);
    }
}

/**
 * Mark the current turn as tainted after a tool returns IM/search/group data.
 * No-op for sessions without a mapped IM conversation.
 */
export function markReadResultTainted(api: any, exec: any): void {
    const key = resolveSessionKey(api, exec);
    if (key) markTurnTainted(key);
}

/**
 * Write tools are stricter than owner-only: the turn must have started from
 * the owner's direct text message and must not have consumed untrusted read
 * results. Bridged local sessions (official DSH Web UI) are owner-driven and
 * have no IM sender, so they stay allowed.
 */
export function requireWriteTurn(api: any, exec: any, feature: string): void {
    requireOwnerTurn(api, exec, feature);
    const key = resolveSessionKey(api, exec);
    if (!key) {
        if (api?.bridge?.isBridged?.(key)) return;
        return;
    }
    if (api?.bridge?.isBridged?.(key)) return;
    const trust = turnWriteTrust.get(String(key));
    // Voice/ASR turns are allowed to reach write tools, but every write tool
    // still asks for owner confirmation; the ASR prompt also requires explicit
    // confirmation for names/recipients before a user-related action.
    if (trust?.voice === true) return;
    if (!trust || trust.ownerDirectText !== true) {
        throw new Error(
            `${feature}: 写操作仅允许由机器人 owner 的直接文本指令发起；当前回合不是 owner 直接文本，已拒绝`
        );
    }
    if (trust.tainted && process.env.WF_IM_BRIDGE_WRITE_CONFIRM === "0") {
        // 写确认关闭时保留旧的严格 taint 拦截；开启时由 owner 的
        // 一次性确认卡承担最终授权（主会话需要先查群历史再写）。
        throw new Error(
            `${feature}: 本回合已读取不可信内容，写操作需要 owner 确认或在新回合重新下达指令`
        );
    }
}

/**
 * Ask for one write confirmation.
 *
 * Bridged official DSH Web UI sessions use the DSH approval seam first, so the
 * card appears in the Web UI. If the UI has no approval answerer (or the
 * session policy is temporarily forced to ask but no client is attached), the
 * existing IM 202 card remains the fallback, which keeps mobile working.
 */
export async function confirmWriteAction(api: any, exec: any, action: string, preview: string): Promise<void> {
    if (process.env.WF_IM_BRIDGE_WRITE_CONFIRM === "0") return;
    const key = resolveSessionKey(api, exec) || "";
    const bridged = !!key && api?.bridge?.isBridged?.(key) === true;
    // A voice transcript can misrecognize names/recipients. Make the approval
    // card say so, so the owner checks the actual users before approving.
    if (key && isVoiceTurn(key)) {
        preview = `[语音输入] ASR 可能误识别人名/收件人/群成员，请核对后确认。\n${preview}`;
    }

    if (bridged) {
        const dshOutcome = await requestDshApproval(api, exec, action, preview);
        if (dshOutcome === "allowed-once") return;
        if (dshOutcome === "rejected") {
            throw new Error(`${action}: owner 在 DSH 界面拒绝了写操作`);
        }
        if (dshOutcome === "cancelled") {
            throw new Error(`${action}: DSH 写操作确认已取消`);
        }
        // unavailable: fall through to the IM 202 card (mobile fallback).
    }

    const interactions = api?.interactions;
    if (!interactions || typeof interactions.requestWriteConfirmation !== "function") {
        throw new Error(`${action}: 写操作确认服务不可用，已拒绝`);
    }
    const outcome = await interactions.requestWriteConfirmation(key, {
        toolName: action,
        action,
        preview,
    });
    if (outcome !== "allowed-once") {
        throw new Error(`${action}: owner 未批准写操作（${String(outcome)}）`);
    }
}

/**
 * Request the official DSH approval card for a bridged Web UI session.
 * Returns null when this DSH build/session has no approval seam or no answerer.
 * A session policy of `never` is temporarily switched to `ask` for this one
 * request, then restored, so the user's global policy is not permanently
 * changed.
 */
async function requestDshApproval(
    api: any,
    exec: any,
    action: string,
    preview: string
): Promise<string | null> {
    const approval = api?.ctx?.get?.("approval");
    const agent = exec?.agent;
    if (!approval || typeof approval.request !== "function" || !agent) return null;
    const session = agent.session;
    let previous: string | undefined;
    try {
        previous = typeof approval.overrideOf === "function" && session ? approval.overrideOf(session) : undefined;
    } catch {
        previous = undefined;
    }
    let defaultPolicy: string | undefined;
    try { defaultPolicy = approval?.config?.policy; } catch { defaultPolicy = undefined; }
    const forcedAsk = (previous ?? defaultPolicy) === "never";
    if (forcedAsk && typeof approval.setPolicy === "function") {
        try { approval.setPolicy(agent, "ask"); } catch { return null; }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("DSH write confirmation timeout")), 120_000);
    timer.unref?.();
    try {
        const outcome = await approval.request({
            agent,
            toolName: action,
            reason: preview,
            signal: controller.signal,
        });
        return outcome === "allowed-once" || outcome === "rejected" || outcome === "cancelled"
            ? outcome
            : null;
    } catch (err: any) {
        api?.logger?.warn?.(`[wildfire] DSH approval unavailable: ${String(err?.message ?? err)}`);
        return null;
    } finally {
        clearTimeout(timer);
        if (forcedAsk && typeof approval.setPolicy === "function") {
            try { approval.setPolicy(agent, "never"); } catch { /* ignore */ }
        }
    }
}

/** Directories the file-send tools are allowed to read from (realpath-checked). */
export function resolveSendRoots(config: WildfireConfig): string[] {
    const workspace = getWorkspaceConfig(config);
    const security = getSecurityConfig(config) as unknown as { fileSendRoots?: string[] };
    const extraEnv = String(process.env.WF_FILE_SEND_ROOTS || "")
        .split(/[,:]/)
        .map((s) => s.trim())
        .filter(Boolean);
    const roots = [
        workspace.root,
        workspace.path,
        workspace.autoRoot,
        ...workspace.allowedRoots,
        ...workspace.catalog.map((entry) => entry.path),
        ...(Array.isArray(security.fileSendRoots) ? security.fileSendRoots : []),
        ...extraEnv,
    ];
    const seen = new Set<string>();
    return roots
        .map((root) => String(root || "").trim())
        .filter((root) => root && !seen.has(root) && seen.add(root))
        .map((root) => path.resolve(root));
}

/** Case-insensitive path comparison on Windows. */
function samePath(a: string, b: string): boolean {
    const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    return fold(a) === fold(b);
}

function pathInside(file: string, root: string): boolean {
    const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    return samePath(file, root) || fold(file).startsWith(fold(root) + path.sep);
}

/** Resolve *filePath* and ensure it lives under one of *roots*; returns the real path. */
export async function assertSendablePath(filePath: string, roots: string[]): Promise<string> {
    const requested = String(filePath || "").trim();
    if (!requested) throw new Error("path is required");
    let resolvedFile: string;
    try {
        resolvedFile = await realpath(requested);
    } catch {
        throw new Error(`file not found: ${requested}`);
    }
    let fileStat;
    try {
        fileStat = await stat(resolvedFile);
    } catch {
        throw new Error(`cannot read file: ${requested}`);
    }
    if (!fileStat.isFile()) throw new Error(`not a regular file: ${requested}`);
    if (fileStat.size > MAX_SEND_FILE_BYTES) {
        throw new Error(`file too large (max ${MAX_SEND_FILE_BYTES} bytes): ${requested}`);
    }
    for (const root of roots) {
        let resolvedRoot: string;
        try {
            resolvedRoot = await realpath(root);
        } catch {
            continue;
        }
        if (pathInside(resolvedFile, resolvedRoot)) return resolvedFile;
    }
    throw new Error(
        `file path is outside the workspace; allowed roots: ${roots.join(", ") || "(none)"}`
    );
}

/** Convenience wrapper: resolve roots from config and validate one path. */
export async function assertConfigSendablePath(
    filePath: string,
    config: WildfireConfig,
    extraRoots: Array<string | undefined | null> = []
): Promise<string> {
    const roots = [
        ...extraRoots.map((root) => String(root || "").trim()).filter(Boolean),
        ...resolveSendRoots(config),
    ];
    return assertSendablePath(filePath, roots);
}
