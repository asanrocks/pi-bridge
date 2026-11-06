// ============================================================================
// Worker protocol — the frames one Daemon↔Worker socket carries.
//
// The Worker service contract (`worker-contract.ts`) is the semantic boundary;
// this module is only its encoding. Every request carries an `id` the reply
// echoes, so the Daemon can correlate out-of-order replies. Observation frames
// and Worker events are pushes: they name the observation they belong to (or,
// for events, no observation at all), never a browser attachment.
//
// The handshake is the Worker's `hello` push. It is sent immediately after the
// socket opens and before any request is answered, so a Daemon never routes a
// Project it has not accepted. A Daemon that rejects the advertised Project set
// closes the socket: registration is all-or-nothing, which is what makes Project
// name claiming atomic without a second protocol round trip.
// ============================================================================

import type {
	JsonValue,
	ModelRef,
	PinnedModelSelection,
	PrefixCursor,
	PullRequestItem,
	SessionListCursor,
} from "../core/index.ts";
import type {
	ObservationId,
	SessionAddress,
	SessionTarget,
	WorkerEvent,
	WorkerInfo,
	WorkerObservationFrame,
	WorkerRegistration,
} from "./worker-contract.ts";

/** Bumped when a frame's meaning changes in a way an older peer would
 * misinterpret. A mismatch is a failed registration, not a best-effort parse. */
export const WORKER_PROTOCOL_VERSION = 1;

/** Close code a Daemon uses when it refuses a Worker's registration. A refused
 * registration is terminal — the same handshake cannot succeed on a retry — so
 * a Worker that sees this code stops instead of reconnecting forever. */
export const WORKER_REJECTED_CLOSE_CODE = 4403;

/** Discovery probe: one request/reply over a throwaway socket. The probe is not
 * part of the worker protocol proper — it only answers "is this path a
 * compatible pi-bridge daemon?" before a Worker or a launch commits to it. */
export const WORKER_PROBE_ID = "probe";

/** The probe request a launcher sends as the first frame on a candidate socket. */
export function workerProbeRequest(): string {
	return JSON.stringify({ id: WORKER_PROBE_ID, verb: "ping" });
}

/** True for the probe request. A daemon socket answers it and keeps the socket
 * open: the probe closes it, a Worker sends `hello` next. */
export function isWorkerProbeRequest(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const frame = value as { id?: unknown; verb?: unknown };
	return frame.id === WORKER_PROBE_ID && frame.verb === "ping";
}

/** The probe reply. `ok` is false for an incompatible peer, which the launcher
 * reports instead of guessing. `web` is the daemon's browser base URL: the
 * probe is the only daemon→launcher reply that exists, and a Worker cannot
 * derive the port from a UNIX socket path, so this is where a joining Worker
 * learns where to look. Null while the listener is not bound yet. */
export interface WorkerProbeReply {
	readonly id: string;
	readonly ok: boolean;
	readonly protocol?: number;
	readonly error?: string;
	readonly web?: string | null;
}

export function workerProbeReply(web: string | null): string {
	return JSON.stringify({ id: WORKER_PROBE_ID, ok: true, protocol: WORKER_PROTOCOL_VERSION, web });
}

/** How often the Daemon probes an idle link, and how long a silent link may
 * stay open. An idle Session produces no traffic, so absence of work is not
 * evidence of a live peer. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_TIMEOUT_MS = 15_000;

/** One Unit of work the Daemon asks of a Worker. */
export type WorkerRequest =
	// ── Observations ────────────────────────────────────────────────────
	| {
			readonly id: string;
			readonly kind: "observeSession";
			readonly address: SessionAddress;
			readonly cursor: PrefixCursor | null;
			/** Allocated by the Daemon; frames for it carry this id. */
			readonly observation: ObservationId;
	  }
	| {
			readonly id: string;
			readonly kind: "createSession";
			readonly projectId: string;
			readonly observation: ObservationId;
			readonly options: {
				readonly text: string;
				readonly images?: JsonValue;
				readonly model?: { readonly provider: string; readonly modelId: string };
				readonly thinkingLevel?: string;
			};
	  }
	| { readonly id: string; readonly kind: "releaseObservation"; readonly observation: ObservationId }
	| {
			readonly id: string;
			readonly kind: "pull";
			readonly observation: ObservationId;
			readonly requests: readonly PullRequestItem[];
	  }
	// ── Session commands (target-addressed) ─────────────────────────────
	| {
			readonly id: string;
			readonly kind: "prompt";
			readonly target: SessionTarget;
			readonly text: string;
			readonly images?: JsonValue;
			readonly model?: ModelRef;
			readonly thinkingLevel?: string;
	  }
	| { readonly id: string; readonly kind: "abort"; readonly target: SessionTarget }
	| { readonly id: string; readonly kind: "discardSteer"; readonly target: SessionTarget }
	| { readonly id: string; readonly kind: "renameSession"; readonly target: SessionTarget; readonly name: string }
	| {
			readonly id: string;
			readonly kind: "setLabel";
			readonly target: SessionTarget;
			readonly entryId: string;
			readonly label: string;
	  }
	| { readonly id: string; readonly kind: "navigate"; readonly target: SessionTarget; readonly entryId: string | null }
	| { readonly id: string; readonly kind: "recoverTurn"; readonly target: SessionTarget }
	// ── Lifecycle ───────────────────────────────────────────────────────
	| { readonly id: string; readonly kind: "closeSession"; readonly address: SessionAddress }
	| { readonly id: string; readonly kind: "archiveSession"; readonly address: SessionAddress }
	// ── Queries and environment ─────────────────────────────────────────
	| {
			readonly id: string;
			readonly kind: "listSessions";
			readonly projectId: string;
			readonly max?: number;
			readonly cursor?: SessionListCursor | null;
	  }
	| { readonly id: string; readonly kind: "listQueue" }
	| {
			readonly id: string;
			readonly kind: "setSessionState";
			readonly address: SessionAddress;
			readonly state: "notified" | "deferred";
	  }
	| { readonly id: string; readonly kind: "info" }
	| {
			readonly id: string;
			readonly kind: "setPinnedModels";
			readonly models: PinnedModelSelection[];
	  }
	| { readonly id: string; readonly kind: "listFiles"; readonly prefix: string; readonly projectId: string }
	| { readonly id: string; readonly kind: "readFile"; readonly path: string; readonly state?: string }
	| { readonly id: string; readonly kind: "listDirectory"; readonly path: string; readonly state?: string }
	| { readonly id: string; readonly kind: "gitShow"; readonly commit: string; readonly cwd: string }
	| { readonly id: string; readonly kind: "gitBase"; readonly directory: string; readonly commit: string }
	| {
			readonly id: string;
			readonly kind: "gitDiff";
			readonly directory: string;
			readonly oldState: string;
			readonly newState: string;
	  }
	/** Stop serving: drain, dispose, then close the socket. */
	| { readonly id: string; readonly kind: "shutdown" };

/** A request before the caller mints its correlation id. A distributive omit
 * is required: the request is a union, and `Omit` over a union collapses the
 * discriminants. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type WorkerRequestInput = WithoutId<WorkerRequest>;

/** One reply. `result` is the request's value; a rejecting request carries the
 * message the Daemon surfaces to the browser. */
export type WorkerReply =
	| { readonly id: string; readonly ok: true; readonly result: JsonValue }
	| { readonly id: string; readonly ok: false; readonly error: string };

/** Worker → Daemon, not a reply to any request. */
export type WorkerPush =
	/** The registration handshake. Sent once, before any reply. */
	| {
			readonly kind: "hello";
			readonly protocol: number;
			readonly registration: WorkerRegistration;
			readonly info: WorkerInfo;
	  }
	/** One observation frame. The Daemon stamps the browser attachment
	 * generation when it forwards it; a Worker serves many attachments and must
	 * not encode a client's identity. */
	| {
			readonly kind: "observation";
			readonly observation: ObservationId;
			readonly frame: WorkerObservationFrame;
	  }
	| { readonly kind: "event"; readonly event: WorkerEvent }
	/** Terminal: the Worker can serve nothing more. Sent once, before the socket
	 * closes, so the Daemon can withdraw the registration deliberately instead
	 * of treating a lost link as a crash. */
	| { readonly kind: "unavailable"; readonly reason: string };

export type WorkerFrame = WorkerRequest | WorkerReply | WorkerPush;

/** Structural discrimination of an inbound frame. Nothing here trusts a field's
 * type beyond what routing requires; the handler validates its own request
 * shape, exactly like the browser protocol's verb handlers. */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
	if (typeof value !== "object" || value === null) return false;
	const frame = value as { id?: unknown; kind?: unknown };
	return typeof frame.id === "string" && typeof frame.kind === "string" && frame.kind !== "hello";
}

export function isWorkerReply(value: unknown): value is WorkerReply {
	if (typeof value !== "object" || value === null) return false;
	const frame = value as { id?: unknown; ok?: unknown; kind?: unknown };
	return typeof frame.id === "string" && typeof frame.ok === "boolean" && frame.kind === undefined;
}

export function isWorkerPush(value: unknown): value is WorkerPush {
	if (typeof value !== "object" || value === null) return false;
	const frame = value as { kind?: unknown; id?: unknown };
	if (frame.id !== undefined) return false;
	return (
		frame.kind === "hello" || frame.kind === "observation" || frame.kind === "event" || frame.kind === "unavailable"
	);
}

/** Parse one socket message. Returns null for JSON that is not a frame, so a
 * malformed peer costs the connection and not the process. */
export function parseWorkerFrame(data: string): WorkerFrame | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (isWorkerRequest(parsed) || isWorkerReply(parsed) || isWorkerPush(parsed)) return parsed;
	return null;
}

/** The minimal shape a Worker checks on an inbound request before dispatch. */
export function requestTarget(request: WorkerRequest): SessionTarget | null {
	return "target" in request ? request.target : null;
}
