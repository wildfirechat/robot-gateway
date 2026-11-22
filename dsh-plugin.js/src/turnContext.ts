/**
 * Per-conversation turn ownership.
 *
 * The IM sender who started the in-flight agent turn for a conversation key.
 * Used for interaction ownership and for gating privileged tools (the tool
 * execution context only exposes the DSH session id, so we map it back to the
 * IM conversation via AgentSessionManager.keyForSessionId()).
 */
export const turnOwners = new Map<string, string>();
