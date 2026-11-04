// ============================================================================
// Worker service contract — the Daemon → execution boundary.
//
// A **Daemon** owns browser Connections, the HTTP/WebSocket surface, attachment
// generations, and delivery. A **Worker** owns Project configuration, Session
// storage, the Activation registry, pi runtimes, and repository reads. The two
// halves live in one process today; this module is the contract they would use
// if the Worker moved behind a socket, so it carries only values and opaque
// ids: no `Connection`, `Manager`, `ActivationRecord`, filesystem handle, or
// registry object crosses it.
//
// Three identities are deliberately distinct:
//
//   - `WorkerRegistration` names one Daemon↔Worker link relationship. A
//     replaced registration (a restarted Worker) mints a new incarnation, so
//     a late reply or command from the previous one cannot be mistaken for
//     the successor's.
//   - `SessionTarget` names one Activation: the address, the durable session
//     id resolved when it was opened, the registration that resolved it, and
//     that registration's Activation generation. Work composed against a
//     target names the Activation it was composed for.
//   - `ObservationId` names one Document observation of one target. Frames and
//     pulls are scoped to it, so two Connections observing the same Session
//     receive independently releasable streams.
//
// The wire still carries attachment generations (`core/types.ts`): the Daemon
// mints one per browser attach and stamps outgoing frames. Frames crossing
// this boundary carry no generation, because a Worker serves many attachments
// and must not encode a client's identity.
// ============================================================================

import type {
	DirectoryListing,
	Document,
	GitDiffFileStat,
	ImageContent,
	JsonValue,
	ModelInfo,
	ModelRef,
	PatchOp,
	PinnedModelInfo,
	PrefixCursor,
	ProjectInfo,
	PullRequestItem,
	SessionInfo,
	SessionListCursor,
	SessionRef,
	SnapshotFile,
} from "../core/index.ts";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** One Daemon↔Worker registration. `incarnation` changes when the serving
 * process run changes; `generation` is never reused within an incarnation. */
export interface WorkerRegistration {
	/** Daemon-assigned id of this registration. Opaque. */
	readonly id: string;
	/** One serving process run. A restart mints a new incarnation. */
	readonly incarnation: string;
	/** The registration's generation within the incarnation. */
	readonly generation: number;
}

/** A Session's client-facing address: the address space and the normalized
 * relative stem below the Project's Session directory. Remote-safe by
 * construction — resolving it to a file is the Worker's business. */
export interface SessionAddress {
	readonly projectId: string;
	readonly stem: string;
}

/** One Session a caller may command.
 *
 * `sessionId` is the durable identity from pi's Session header: the address
 * alone can outlive an Activation (a close followed by a reopen), so commands
 * name both. `activation` is the registration's generation within
 * `worker.incarnation`; a command whose activation is no longer live is
 * refused rather than retargeted at a successor. `cwd` is identity data the
 * Worker reports for attachment-bound repository reads (the `gitShow` query
 * base), not a runtime handle. */
export interface SessionTarget extends SessionAddress {
	readonly sessionId: string;
	readonly cwd: string;
	readonly worker: WorkerRegistration;
	readonly activation: number;
}

/** Opaque id of one Document observation. */
export type ObservationId = string;

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/** One frame a Worker emits for one observation. The Worker emits what its
 * attachment-generation-free stream contains; the Daemon stamps the browser
 * attachment generation when it forwards the frame.
 *
 * `replace` carries a complete wire-projected Document (lazy fields stripped)
 * and is the observation's first frame. `patch` carries ordered operations
 * already filtered for this observation's demand. `closed` is the terminal
 * frame: the runtime behind the address ended, and nothing more will arrive
 * for this observation. */
export type WorkerObservationFrame =
	| { readonly kind: "replace"; readonly session: SessionRef; readonly document: Document }
	/** `session` is present only on the address-bearing initial-sync delta (a
	 * cursor-validated attach); later live patches carry ops alone. */
	| { readonly kind: "patch"; readonly session?: SessionRef; readonly ops: readonly PatchOp[] }
	| { readonly kind: "closed"; readonly address: SessionAddress };

/** Where a Worker delivers one observation's frames. A synchronous sink: the
 * initial sync reaches it during acquisition, before the observation is
 * returned, so a caller never observes an established stream without its
 * baseline. */
export type WorkerObservationSink = (frame: WorkerObservationFrame) => void;

/** One lazy value read for an observation, plus whether the entry it came
 * from is still live (unsealed): a live value keeps streaming, so later
 * patches on that path stay part of the observation's demand. */
export interface WorkerPulledValue {
	readonly entryId: string;
	readonly fieldPath: string;
	readonly value: JsonValue;
	readonly live: boolean;
}

/** One observation's lifetime. Releasing is idempotent and releases nothing
 * else: sibling observations keep delivering and the Session keeps serving
 * commands. Releasing during acquisition is safe — the acquisition completes
 * or is discarded, and no frame is published to a released sink. */
export interface WorkerObservation {
	readonly id: ObservationId;
	readonly target: SessionTarget;
	/** Fetch withheld content. A live value also becomes part of this
	 * observation's demand, so later patches for it are delivered here. */
	pull(requests: readonly PullRequestItem[]): Promise<WorkerPulledValue[]>;
	/** Stop this observation. Idempotent. */
	release(): Promise<void>;
}

/** An observed Session: the target commands address, and the observation the
 * caller receives frames on. */
export interface ObservedSession {
	readonly target: SessionTarget;
	readonly observation: WorkerObservation;
}

export interface ObserveSessionOptions {
	/** The client's cached prefix, or null for a full replace. Validated by
	 * the Worker against the current durable entry list. */
	readonly cursor?: PrefixCursor | null;
	readonly sink: WorkerObservationSink;
}

export interface CreateSessionOptions {
	/** The first prompt's text. Required: a Session with no admitted turn is
	 * never created (ADR 12). */
	readonly text: string;
	readonly images?: ImageContent[];
	/** The Project home's pre-session choices, applied before admission. */
	readonly model?: ModelRef;
	readonly thinkingLevel?: string;
	readonly sink: WorkerObservationSink;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** One page of a Project's Session history. */
export interface SessionPage {
	readonly sessions: SessionInfo[];
	readonly hasMore: boolean;
	readonly nextCursor?: SessionListCursor;
}

/** The environment a Worker owns and a Daemon serves verbatim: Project
 * configuration, the model catalogue, the pinned and visible scopes, and the
 * repository read surface. The Daemon must not read Project files or keep a
 * second model runtime, because a remote Worker's filesystem is not the
 * Daemon's. */
export interface WorkerInfo {
	readonly projects: ProjectInfo[];
	readonly models: ModelInfo[];
	readonly pinnedModels: PinnedModelInfo[];
	readonly visibleModels: string[];
	readonly thinkingLevels: string[];
}

/** Worker-owned reads and daemon-global settings. Every call is addressed by
 * Project or by absolute path, never by a runtime handle. */
export interface WorkerEnvironment {
	info(): Promise<WorkerInfo>;
	/** Pin or unpin one model in the global `enabledModels` scope. */
	setModelPinned(provider: string, modelId: string, pinned: boolean): Promise<void>;
	/** Project-cwd path completion. */
	listFiles(prefix: string, projectId: string): Promise<Array<{ path: string; isDirectory: boolean }>>;
	readFile(path: string, state?: string): Promise<SnapshotFile>;
	listDirectory(path: string, state?: string): Promise<DirectoryListing>;
	gitShow(commit: string, cwd: string): Promise<{ output: string; truncated: boolean }>;
	gitBase(directory: string, commit: string): Promise<{ baseline: string }>;
	gitDiff(
		directory: string,
		oldState: string,
		newState: string,
	): Promise<{ files: GitDiffFileStat[]; filesOmitted?: number; untrackedOmitted: number }>;
}

/** What a Worker reports when its served state changes. Delivery is the
 * Daemon's job: a Worker never encodes browser frames. */
export type WorkerEvent =
	| { readonly kind: "sessions_changed"; readonly projectId: string; readonly page: SessionPage }
	| { readonly kind: "active_sessions_changed"; readonly sessions: SessionInfo[] }
	/** The global pinned list changed (a `setModelPinned` mutation). */
	| { readonly kind: "pinned_models_changed"; readonly pinnedModels: PinnedModelInfo[] }
	/** The Worker can serve nothing more (its execution scope is terminal).
	 * Emitted once; the Daemon withdraws the registration instead of leaving
	 * Projects that answer every operation with a refusal. */
	| { readonly kind: "unavailable"; readonly reason: string };

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Everything the Daemon needs from one serving Worker.
 *
 * Ordering rules a remote implementation must preserve:
 *
 *   - `observeSession`/`createSession` deliver the initial sync to the sink
 *     before they resolve, so a caller that receives the returned
 *     observation has its baseline.
 *   - A command is admitted against the target it names. A command admitted
 *     before its Activation ended completes against the runtime it captured;
 *     one admitted after is rejected, never retargeted.
 *   - `release` (on an observation) and `closeSession` are the only ways a
 *     caller ends delivery; `closeSession` also ends the runtime.
 */
export interface WorkerService extends WorkerEnvironment {
	readonly registration: WorkerRegistration;

	/** Resolve-or-activate the address and start one observation. */
	observeSession(address: SessionAddress, options: ObserveSessionOptions): Promise<ObservedSession>;
	/** Create a fresh Session in `projectId`, admit its first prompt, and
	 * start the observation. Nothing is created when admission is refused. */
	createSession(projectId: string, options: CreateSessionOptions): Promise<ObservedSession>;

	/** Terminate the live Activation for the address: a kill, not an idle
	 * collection. Every observation's terminal frame is delivered before this
	 * resolves. */
	closeSession(address: SessionAddress): Promise<void>;
	/** Close the Session, then move its file into the reserved archive prefix. */
	archiveSession(address: SessionAddress): Promise<void>;

	// ── Session commands (target-addressed) ─────────────────────────────
	/** A turn: immediate admitted work, so a Stop never queues behind it.
	 * Carries the send's model selection (the stateless client API). */
	prompt(
		target: SessionTarget,
		text: string,
		images?: ImageContent[],
		model?: ModelRef,
		thinkingLevel?: string,
	): Promise<void>;
	abort(target: SessionTarget): Promise<void>;
	discardSteer(target: SessionTarget): Promise<void>;
	/** Serialized mutations: one at a time, in admission order. */
	renameSession(target: SessionTarget, name: string): Promise<void>;
	setLabel(target: SessionTarget, entryId: string, label: string): Promise<void>;
	navigate(target: SessionTarget, entryId: string | null): Promise<void>;
	/** Recover the broken tail turn (ADR 16); reports which repair ran. */
	recoverTurn(target: SessionTarget): Promise<"retry" | "continue">;

	// ── Project and Session queries ─────────────────────────────────────
	listSessions(projectId: string, max?: number, cursor?: SessionListCursor | null): Promise<SessionPage>;
	listActiveSessions(): Promise<SessionInfo[]>;

	/** Served-state changes. Returns an unsubscribe. */
	onEvent(listener: (event: WorkerEvent) => void): () => void;
	/** Stop admitting, drain observations and admitted work, dispose every
	 * runtime. Idempotent and joinable. */
	dispose(): Promise<void>;
}
