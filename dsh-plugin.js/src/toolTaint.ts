/**
 * Taint every tool result in the current agent scope.
 *
 * The turn trust gate only lets write tools run after owner-direct-text. A
 * read/search/fetch/MCP/subagent tool result can carry prompt-injected content,
 * so once any tool result lands in this turn, later write tools must be denied
 * until the owner starts a new direct-text turn.
 */

import { markReadResultTainted } from "./toolSecurity.js";

export function bindToolResultTaint(api: any, agentCtx: any): void {
    if (!agentCtx || typeof agentCtx.on !== "function") return;
    try {
        agentCtx.on("tools/result", (exec: any, _result: any) => {
            markReadResultTainted(api, exec);
        });
    } catch (e: any) {
        api?.logger?.warn?.(`[wildfire] tool taint binder failed: ${String(e?.message ?? e)}`);
    }
}
