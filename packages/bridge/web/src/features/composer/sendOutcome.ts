// ============================================================================
// sendOutcome — the composer's taxonomy for one send's RPC result.
//
// The prompt reply is an *admission* acknowledgement (ADR 12 Reply semantics):
// it says whether the daemon accepted the message, never how the turn went.
// That splits a missing `ok` from `ok: false`, which the draft's fate depends
// on — a refusal proves nothing ran (restore the text, the user retries), while
// a request that never got an answer may still be a running turn (restoring
// would duplicate the send). "No reply" is the transport's shape, not the
// daemon's: `BridgeClient` rejects pending calls on a socket close, so the
// caller sees `undefined`.
// ============================================================================

/** What one send's RPC outcome establishes about the message. */
export type SendOutcome =
	/** `ok: true` — the message passed preflight (queued or started). */
	| "admitted"
	/** `ok: false` — refused before admission; no turn state exists. */
	| "refused"
	/** No usable reply — the outcome is unknown and may already be a run. */
	| "unknown";

export function sendOutcomeOf(reply: unknown): SendOutcome {
	if (typeof reply === "object" && reply !== null) {
		const ok = (reply as { ok?: unknown }).ok;
		if (ok === true) return "admitted";
		if (ok === false) return "refused";
	}
	return "unknown";
}
