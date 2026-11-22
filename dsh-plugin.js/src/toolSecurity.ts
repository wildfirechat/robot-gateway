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
import { turnOwners } from "./turnContext.js";

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
        if (resolvedFile === resolvedRoot) return resolvedFile;
        if (resolvedFile.startsWith(resolvedRoot + path.sep)) return resolvedFile;
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
