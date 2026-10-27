/**
 * Layer 1, browser entry point.
 *
 * Two platform facts live here. A page cannot set the `proto-version` header, so
 * the protobuf wire is unavailable: the default transport says so, which makes
 * `connect()` reject with `unsupported` instead of letting a plain
 * `new WebSocket(url, { headers })` blow up as a `TypeError` (browsers read the
 * second argument as the subprotocol list). A page is also the only place where
 * `getUserMedia` exists, so the recording provider is exported from here rather
 * than from the neutral entry. Everything else is identical.
 */

import type { AsrSessionOptions } from "./session.ts";
import { AsrSession as NeutralAsrSession } from "./session.ts";
import type { Transport } from "./transport.ts";
import { webSocketTransport } from "./transport.ts";

export * from "./index.ts";
export type { Microphone, MicrophoneOptions } from "./mic/capture.ts";
/**
 * The one thing a page cannot do for itself: record. Kept in this entry so the
 * neutral `@earendil-works/pi-asr` stays runtime-agnostic, and so there is no fifth export
 * path for a single provider. It knows nothing about the wire — its only output
 * is `onPcm`, which is what `AsrSession.push` consumes.
 */
export { openMicrophone } from "./mic/capture.ts";

/** A transport that advertises its real capability (no custom headers). */
export function browserTransport(): Transport {
	return webSocketTransport({ headers: false });
}

/**
 * Same session, with the browser's transport capabilities baked in.
 *
 * Shadowing the re-exported neutral class is intentional: importing from
 * `@earendil-works/pi-asr/browser` should never hand you a session that silently claims it
 * can set request headers.
 */
export class AsrSession extends NeutralAsrSession {
	constructor(options: AsrSessionOptions) {
		// `??` after the spread: an explicitly undefined `transport` must not win.
		super({ ...options, transport: options.transport ?? browserTransport() });
	}
}
