// ============================================================================
// dictationPolicy — the composer's dictation decisions, without React.
//
// Three questions the hook would otherwise answer inline: may the microphone
// run (a capability answer, never a toast), how a failed credential request
// retries, and how the non-fatal endings are worded. Pure, so the rules are
// testable without a DOM, a store, or a daemon.
// ============================================================================

import type { AsrCredential } from "../../../../src/core/index.ts";

export type DictationAvailability = { ready: true } | { ready: false; reason: string };

/** First retry after a failed credential request; doubles up to the cap. */
const CREDENTIAL_RETRY_BASE_MS = 2_000;
const CREDENTIAL_RETRY_CAP_MS = 30_000;

/** Refresh a minted token this long before its advisory expiry.
 *
 * Deliberately *shorter* than the daemon's own refresh margin (60 s in
 * `src/host/asr-credentials.ts`): the daemon only mints a replacement once its
 * window is open, so asking earlier would hand back the cached token and leave
 * this effect with no new deadline to schedule. Inside the window the answer is
 * always a new token, which re-arms the timer. */
export const TOKEN_REFRESH_MARGIN_MS = 30_000;

/**
 * Whether the microphone may start, and why not when it may not.
 *
 * The order is the order of unfixability. A plain-HTTP origin withholds
 * `getUserMedia` outright, so it outranks everything: a connection cannot help.
 * A credential outlives the socket (a device id never expires, a token lasts
 * hours), so the connection is checked separately — a control that could start
 * an utterance the daemon cannot authorize is disabled rather than attempted.
 */
export function dictationAvailability(input: {
	connected: boolean;
	insecure: boolean;
	/** The credential, or null before the first answer arrives. */
	credential: AsrCredential | null;
	/** Why the last credential request failed, or null. */
	credentialError: string | null;
}): DictationAvailability {
	if (input.insecure) {
		return { ready: false, reason: "Dictation needs a secure context (https or localhost)" };
	}
	if (!input.connected) return { ready: false, reason: "Dictation needs a daemon connection" };
	if (input.credential !== null) return { ready: true };
	if (input.credentialError !== null) {
		return { ready: false, reason: `Dictation is unavailable: ${input.credentialError}` };
	}
	return { ready: false, reason: "Dictation is starting up" };
}

/**
 * Backoff for a credential request that failed: a provider that is briefly
 * unreachable must not leave dictation disabled until the tab reloads. The
 * retry is a cost, not a correctness question — the control shows the reason
 * while it waits.
 */
export function credentialRetryDelay(attempt: number): number {
	return Math.min(CREDENTIAL_RETRY_BASE_MS * 2 ** attempt, CREDENTIAL_RETRY_CAP_MS);
}

/**
 * The non-fatal endings, in the composer's terms. The ASR package classifies
 * them (`isFatalError`); these are the three that still keep what the server
 * confirmed, so the composer reports them as a notice and not a failure.
 */
export type DictationEnding = "expired" | "timeout" | "aborted";

export function asDictationEnding(code: string): DictationEnding | null {
	return code === "expired" || code === "timeout" || code === "aborted" ? code : null;
}

/** What a normal ending reports. The package's messages name the mechanism
 * ("session: no terminal message within 8000ms…"); this says what the user
 * kept, because nothing on screen marks the end other than the text itself. */
export function dictationEndingNotice(ending: DictationEnding): string {
	switch (ending) {
		case "expired":
			return "Dictation stopped after a pause. The text was kept.";
		case "timeout":
			return "Dictation ended without a final transcript. The text was kept.";
		case "aborted":
			return "Dictation was interrupted. The text was kept.";
	}
}
