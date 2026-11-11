// ============================================================================
// protocolSkew — the app's half of the version check.
//
// The daemon owns PROTOCOL_VERSION (core/protocol-version.ts) and reports it in
// `getDaemonInfo`. This app was built against the same constant, so any
// difference means the two halves of one deployment are not the same build.
// A daemon that reports no version at all is older than the check, which is the
// same verdict — `null`, never a guessed number.
// ============================================================================

import type { GetDaemonInfoReply } from "../../../../src/core/index.ts";
import { PROTOCOL_VERSION } from "../../../../src/core/index.ts";

export interface ProtocolSkew {
	/** The daemon's reported version, null when its reply carried none. */
	readonly daemon: number | null;
	/** The version this app's build carries. */
	readonly app: number;
}

/** Null when the daemon speaks this app's protocol. */
export function detectProtocolSkew(reply: GetDaemonInfoReply): ProtocolSkew | null {
	const daemon = reportedProtocol(reply);
	if (daemon === PROTOCOL_VERSION) return null;
	return { daemon, app: PROTOCOL_VERSION };
}

/** Wire input: the field is required by the reply type, but a daemon built
 * before this check omits it — exactly the skew the comparison exists to name. */
function reportedProtocol(reply: GetDaemonInfoReply): number | null {
	const reported: unknown = reply.protocol;
	return typeof reported === "number" && Number.isInteger(reported) ? reported : null;
}
