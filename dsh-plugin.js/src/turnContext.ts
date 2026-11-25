/**
 * Per-conversation turn ownership and untrusted-context tracking.
 *
 * The IM sender who started the in-flight agent turn for a conversation key.
 * Used for interaction ownership and for gating privileged tools (the tool
 * execution context only exposes the DSH session id, so we map it back to the
 * IM conversation via AgentSessionManager.keyForSessionId()).
 */
export const turnOwners = new Map<string, string>();

export interface TurnWriteTrust {
    /** The turn started from a direct text message authored by the robot owner. */
    ownerDirectText: boolean;
    /** The turn has consumed read/search/group-history content. */
    tainted: boolean;
    /** The turn originated from an ASR transcript; names may be misrecognized. */
    voice?: boolean;
}

export const turnWriteTrust = new Map<string, TurnWriteTrust>();

/** Reset trust at the start of one agent turn. */
export function markTurnSource(key: string, ownerDirectText: boolean): void {
    turnWriteTrust.set(String(key), { ownerDirectText: ownerDirectText === true, tainted: false, voice: false });
}

/** Downgrade the current turn after reading untrusted IM/bridge content. */
export function markTurnTainted(key: string): void {
    const k = String(key || '');
    if (!k) return;
    const current = turnWriteTrust.get(k);
    if (current) current.tainted = true;
    else turnWriteTrust.set(k, { ownerDirectText: false, tainted: true, voice: false });
}


/** Mark the current turn as originating from ASR/voice. */
export function markTurnVoice(key: string): void {
    const k = String(key || '');
    if (!k) return;
    const current = turnWriteTrust.get(k);
    if (current) current.voice = true;
    else turnWriteTrust.set(k, { ownerDirectText: false, tainted: false, voice: true });
}

/** Whether the current turn came from a voice/ASR message. */
export function isVoiceTurn(key: string): boolean {
    return turnWriteTrust.get(String(key || ''))?.voice === true;
}

export function clearTurnTrust(key: string): void {
    turnWriteTrust.delete(String(key || ''));
}
