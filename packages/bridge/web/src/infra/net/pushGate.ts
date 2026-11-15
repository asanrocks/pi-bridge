// ============================================================================
// pushGate — holds a Connection's pushes until its build check has decided.
//
// The Daemon's first frame on a socket is the queue snapshot, sent before the
// browser has asked anything; `getDaemonInfo` is an RPC and its reply lands
// later. A client that is a different build must not apply a frame first and
// ask afterwards, so ingestion is gated: frames are held, then replayed in
// order once the builds agree, or dropped when they do not.
//
// The gate owns no socket and no store — it is the ordering rule alone, so it
// can be tested without either. `overflow` is the one failure it reports: a
// Daemon that ships this many frames without answering an RPC is not a peer
// worth parsing, and the caller replaces the connection.
// ============================================================================

import type { ServerPushMessage } from "../../../../src/core/index.ts";

/** How many frames may be held. The window is one RPC round trip; a backlog
 * this deep means the Daemon is not answering at all. */
export const PUSH_GATE_LIMIT = 512;

export type PushGateRoute = "held" | "applied" | "overflow";

/** What the gate replays through: the pipeline's push handler. */
export type ApplyPush = (push: ServerPushMessage) => void;

export interface PushGate {
	/** Route one push: held while the check runs, applied after. */
	route(push: ServerPushMessage, apply: ApplyPush): PushGateRoute;
	/** Apply everything held, in arrival order, and pass later pushes through.
	 * Idempotent: reopening an open gate replays nothing. */
	open(apply: ApplyPush): void;
	/** Forget everything held and stay closed. The frames belong to a build this
	 * client cannot trust, so nothing is applied. */
	abandon(): void;
}

type State = { kind: "closed"; held: ServerPushMessage[] } | { kind: "open" } | { kind: "lost" };

export function createPushGate(limit = PUSH_GATE_LIMIT): PushGate {
	let state: State = { kind: "closed", held: [] };

	return {
		route(push, apply) {
			if (state.kind === "open") {
				apply(push);
				return "applied";
			}
			if (state.kind === "lost") return "overflow";
			state.held.push(push);
			if (state.held.length <= limit) return "held";
			state = { kind: "lost" };
			return "overflow";
		},

		open(apply) {
			if (state.kind !== "closed") return;
			const held = state.held;
			state = { kind: "open" };
			for (const push of held) apply(push);
		},

		abandon() {
			state = { kind: "lost" };
		},
	};
}
