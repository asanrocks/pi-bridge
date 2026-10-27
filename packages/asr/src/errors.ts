/** Status codes the server returns in-band; anything else is passed through. */
export const ServerStatus = {
	ok: 20_000_000,
	/** Sent a `StartTask` the server could not parse — usually a wire-format mismatch. */
	startTaskExpected: 40_100_003,
	/** Missing, expired, or unusable credential (§7.1 of the protocol doc). */
	authExpired: 40_200_001,
	/** The credential is valid but has no permission for this resource (§1.2, §7.1). */
	noAccessRight: 40_000_000,
} as const;

export type AsrErrorCode =
	| "auth_expired"
	| "connection"
	| "protocol"
	| "server"
	| "timeout"
	| "aborted"
	/** The server ended the task on its own, e.g. it expired after ~20 s of silence. */
	| "expired"
	/** The microphone could not be opened: permission, missing device, or audio graph. */
	| "capture"
	| "config"
	| "unsupported";

export interface AsrErrorInit {
	/** Server status code, when the failure came back in-band. */
	status?: number;
	cause?: unknown;
	/** Overrides the per-code default; see {@link AsrError.retryable}. */
	retryable?: boolean;
}

/**
 * Whether a fresh attempt can plausibly succeed, per code.
 *
 * `docs/protocol.md` §7.1 requires this hint on every failure: a caller must not
 * have to string-match a message to decide whether to offer a retry, and §7.2
 * makes the answer part of the UI contract (retry invisibly, wind down, or
 * rotate credentials).
 */
const RETRYABLE_BY_CODE = {
	auth_expired: true, // mint a new token and start again
	connection: true,
	timeout: true,
	expired: true, // the task lapsed; a new session is the whole remedy
	// Default for transient audio-graph failures; permission and missing-device
	// errors override it with `retryable: false`. See `mic/capture.ts`.
	capture: true,
	protocol: false, // resending the same frames fails the same way
	server: false, // refined per status by retryableForStatus()
	config: false,
	unsupported: false,
	aborted: false, // the caller did this
} as const satisfies Record<AsrErrorCode, boolean>;

export class AsrError extends Error {
	readonly code: AsrErrorCode;
	readonly status: number | undefined;
	/**
	 * True when another attempt may succeed without changing the configuration.
	 * A mid-session failure is still retryable *as a new session*; §7.2 asks the
	 * caller to bound the attempts rather than the SDK to refuse them.
	 */
	readonly retryable: boolean;

	constructor(code: AsrErrorCode, message: string, init: AsrErrorInit = {}) {
		super(message, init.cause === undefined ? undefined : { cause: init.cause });
		this.name = "AsrError";
		this.code = code;
		this.status = init.status;
		this.retryable = init.retryable ?? RETRYABLE_BY_CODE[code];
	}
}

/** True for the "token expired, mint a new one" case, which is routine, not fatal. */
export function isAuthExpired(status: number | undefined): boolean {
	return status === ServerStatus.authExpired;
}

/** Map an in-band status code onto the error taxonomy. */
export function codeForStatus(status: number): AsrErrorCode {
	if (isAuthExpired(status)) return "auth_expired";
	if (status === ServerStatus.startTaskExpected) return "protocol";
	return "server";
}

/**
 * The retry hint for an in-band status (§7.1).
 *
 * The known codes are classified explicitly. Anything unknown keeps the hint:
 * this is a private endpoint whose new codes are at least as likely to be
 * transient as permanent, and swallowing the code — or answering "never retry"
 * without knowing — is what §7.1 forbids.
 */
export function retryableForStatus(status: number): boolean {
	switch (status) {
		case ServerStatus.authExpired:
			return true;
		case ServerStatus.startTaskExpected:
			return false;
		case ServerStatus.noAccessRight:
			return false;
		default:
			return status !== ServerStatus.ok;
	}
}
