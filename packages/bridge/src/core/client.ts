// ============================================================================
// Client-side document mirror + BridgeClient — pure, browser-safe.
// Syncs to the server's canonical Document via Replace snapshots + Patches,
// plus lazy-field pull orchestration.
//
// Does NOT include: WebSocket transport, rendering.
// ============================================================================

import { CompactCodec } from "./compact-codec.ts";
import { applyPatch, getAtPath, setAtPath } from "./document.ts";
import type {
	Document,
	GitDiffState,
	ImageContent,
	JsonValue,
	ModelRef,
	PatchOp,
	PinnedModelSelection,
	PrefixCursor,
	PromptRequest,
	RpcReply,
	RpcRequestBody,
	ServerPushMessage,
	SessionListCursor,
	SessionLocation,
	SnapshotState,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PullRequestItem {
	entryId: string;
	fieldPath: string;
}

export interface PullResponseItem {
	entryId: string;
	fieldPath: string;
	value: JsonValue;
}

/** An op that addresses a whole entry (`/entries/<id>`), not a field in it. */
const ENTRY_ROOT_PREFIX = "/entries/";
const isEntryRootPath = (path: string): boolean => /^\/entries\/[^/]+$/.test(path);

/** The push kinds on the wire (`ServerPushMessage`): an object frame with no
 * `id` and a kind outside this set is a protocol violation — the daemon and
 * the app ship together, so an unrecognized kind is version skew. */
const PUSH_KINDS = new Set([
	"replace",
	"patch",
	"queue_changed",
	"session_completed",
	"pinned_models_changed",
	"session_closed",
]);

// ---------------------------------------------------------------------------
// DocumentMirror
// ---------------------------------------------------------------------------

export class DocumentMirror {
	/** The local mirror. Never authoritative — replaced on reconnect. */
	document: Document;

	/** Monotonic revision of this mirror's document. Advanced by a wholesale
	 * `applyReplace` and by any patch that replaces an entry root an earlier
	 * revision had already installed. Structural identity (paths, block
	 * counts, text lengths) cannot see a same-id replacement that differs
	 * only in content those never read, so consumers gate re-projection on
	 * the revision instead. */
	revision = 0;

	private _generation: number | null = null;

	constructor(document?: Document) {
		this.document = document ?? emptyMirror();
	}

	/** The attachment generation of the last address-bearing frame applied
	 * (ADR 19): the observation stream this mirror currently replicates.
	 * Null before one arrives (a seeded cache mirror). Live frames are
	 * admitted only while they match it — see BridgeClient's ingestion rule. */
	get generation(): number | null {
		return this._generation;
	}

	/** Record the attachment generation an address-bearing frame (an initial
	 * sync) carries. Direct document applications (candidate promotion, cache
	 * seeding) leave it unchanged: they replicate the same stream. */
	setGeneration(generation: number): void {
		this._generation = generation;
	}

	/**
	 * Replace the entire document with a server snapshot (Replace push).
	 * Called on connect, reconnect, and session switch.
	 * Reassigns the root — consumers holding the old reference see it stale.
	 */
	applyReplace(snapshot: Document): void {
		this.document = snapshot;
		this.revision++;
	}

	/**
	 * Apply an incremental patch batch from the server.
	 * Produces a new Document root; replaces the mirror reference.
	 * Each Patch is an atomic transaction.
	 */
	applyPatch(ops: PatchOp[]): void {
		for (const op of ops) {
			if (
				(op.op === "add" || op.op === "replace") &&
				isEntryRootPath(op.path) &&
				this.document.entries[op.path.slice(ENTRY_ROOT_PREFIX.length)] !== undefined
			) {
				this.revision++;
			}
		}
		this.document = applyPatch(this.document, ops);
	}

	/**
	 * Given a set of lazy field paths the UI needs to display,
	 * return the subset that are still `null` (not yet fetched).
	 *
	 * Call this before sending a PullRequest to the server.
	 * Paths already populated are filtered out — no redundant pulls.
	 */
	needsPull(pending: PullRequestItem[]): PullRequestItem[] {
		return pending.filter((w) => {
			const value = getAtPath(this.document, w.fieldPath);
			return value === null || value === undefined;
		});
	}

	/**
	 * Merge pull response values into the document.
	 * Produces a new Document root with each field set; replaces the mirror.
	 */
	ingestPullResponse(values: PullResponseItem[]): void {
		this.document = values.reduce((doc, v) => setAtPath(doc, v.fieldPath, v.value), this.document);
	}
}

// ---------------------------------------------------------------------------
// planPull — pure batching step for the pull queue (ADR 09)
// ---------------------------------------------------------------------------

/**
 * Filter a raw pending list down to the items worth pulling: dedupe by
 * fieldPath, drop fields already populated in the mirror (`needsPull`),
 * drop fields with an in-flight pull (`loadingPaths`).
 */
export function planPull(
	pending: PullRequestItem[],
	mirror: DocumentMirror,
	loadingPaths: ReadonlySet<string>,
): PullRequestItem[] {
	const seen = new Set<string>();
	const deduped: PullRequestItem[] = [];
	for (const w of pending) {
		if (seen.has(w.fieldPath)) continue;
		seen.add(w.fieldPath);
		deduped.push(w);
	}
	return mirror.needsPull(deduped).filter((w) => !loadingPaths.has(w.fieldPath));
}

// ---------------------------------------------------------------------------
// Transport interface (constructor-injected, browser-safe)
// ---------------------------------------------------------------------------

export interface BridgeTransport {
	send(data: string): void;
	onMessage: ((data: string) => void) | null;
}

/** Construction options. */
export interface BridgeClientOptions {
	/** A message the client could not decode or did not recognize: malformed
	 * JSON, a compacted frame with no established run, or a frame shape
	 * outside the protocol. Fired at most once per client — a violation is
	 * never silently tolerated — and the caller owns the recovery: the web
	 * client toasts and closes the socket, so the reconnect path's initial
	 * sync repairs the stream. */
	onProtocolError?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// BridgeClient — typed RPC + push demux
// ---------------------------------------------------------------------------

type PendingRpc = {
	resolve: (reply: RpcReply) => void;
	reject: (err: Error) => void;
};

export class BridgeClient {
	readonly mirror: DocumentMirror;
	private transport: BridgeTransport;
	private pending = new Map<string, PendingRpc>();
	private nextId = 0;
	private _onPush: ((msg: ServerPushMessage) => void) | null = null;
	private onProtocolError: ((message: string) => void) | undefined;
	/** The compact-frame decoder (core/compact-codec.ts): holds the template
	 * the full-form frames on this socket prime. */
	private codec = new CompactCodec();
	/** Latched: one violation surfaces once; the caller closes the transport. */
	private violated = false;

	constructor(transport: BridgeTransport, options: BridgeClientOptions = {}) {
		this.mirror = new DocumentMirror();
		this.transport = transport;
		this.onProtocolError = options.onProtocolError;

		this.transport.onMessage = (data: string) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(data);
			} catch {
				this.protocolError("malformed message");
				return;
			}
			// A bare JSON string is a compacted frame (core/compact-codec.ts):
			// the appended value of the run the held template established.
			if (typeof parsed === "string") {
				const frame = this.codec.decode(parsed);
				if (frame === null) {
					this.protocolError("compacted frame with no established run");
					return;
				}
				this.handleMessage(frame);
				return;
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				this.protocolError("message is not a frame");
				return;
			}
			this.codec.observe(parsed as Record<string, unknown>);
			this.handleMessage(parsed as Record<string, unknown>);
		};
	}

	/** Register a push listener (replace + patch). Called by the UI. */
	set onPush(listener: ((msg: ServerPushMessage) => void) | null) {
		this._onPush = listener;
	}

	/** The underlying DocumentMirror (read-only convenience). */
	get document(): DocumentMirror {
		return this.mirror;
	}

	// ── Verb methods ─────────────────────────────────────────────────────

	prompt(text: string, images?: ImageContent[], model?: ModelRef, thinkingLevel?: string): Promise<RpcReply> {
		// Carries ride only when present: an omitted model/level leaves pi's
		// session selection (the last applied one) in force.
		const body: PromptRequest = { verb: "prompt", text };
		if (images && images.length > 0) body.images = images;
		if (model) body.model = model;
		if (thinkingLevel !== undefined) body.thinkingLevel = thinkingLevel;
		return this.call(body);
	}

	abort(): Promise<RpcReply> {
		return this.call({ verb: "abort" });
	}

	/** Compact the context now (pi's manual `compact()`). Completion-style: the
	 * reply arrives after the summary was appended, and carries pi's
	 * `tokensBefore` / `estimatedTokensAfter`; failures are `ok: false` with pi's
	 * reason ("Nothing to compact", "Already compacted", "Compaction
	 * cancelled"). `customInstructions` focuses the summary. */
	compact(customInstructions?: string): Promise<RpcReply> {
		return this.call(
			customInstructions !== undefined && customInstructions !== ""
				? { verb: "compact", customInstructions }
				: { verb: "compact" },
		);
	}

	discardSteer(): Promise<RpcReply> {
		return this.call({ verb: "discardSteer" });
	}

	/** Replace the daemon-global pinned list, in order (ADR 20). The result —
	 * filtered to what the catalogue resolves — arrives as a
	 * `pinned_models_changed` push. */
	setPinnedModels(models: PinnedModelSelection[]): Promise<RpcReply> {
		return this.call({ verb: "setPinnedModels", models });
	}

	renameSession(name: string): Promise<RpcReply> {
		return this.call({ verb: "renameSession", name });
	}

	setLabel(entryId: string, label: string): Promise<RpcReply> {
		return this.call({ verb: "setLabel", entryId, label });
	}

	navigate(entryId: string | null): Promise<RpcReply> {
		return this.call({ verb: "navigate", entryId });
	}

	/** Recover the broken tail turn (ADR 16). The reply's `action` carries
	 * what ran: "retry" (silent re-request from a clean boundary — a failed
	 * turn is branched past, an unfinished run is bare-continued) or
	 * "continue" (branch past the dead turn and send a visible "Continue."
	 * message — dangling or mid-run-terminated tools). */
	recoverTurn(): Promise<RpcReply> {
		return this.call({ verb: "recoverTurn" });
	}

	/** Resolve-or-activate a session by address (ADR 11). */
	openSession(projectId: string, stem: string, cursor?: PrefixCursor): Promise<RpcReply> {
		return this.call(
			cursor ? { verb: "openSession", projectId, stem, cursor } : { verb: "openSession", projectId, stem },
		);
	}

	/** Create a new unflushed session in a Project (ADR 11). The first
	 * prompt's text is admitted before attach (ADR 12 slice); optional
	 * `images` attach to it and `model`/`thinkingLevel` are applied before
	 * admission (the Project home's pre-session choices). `operationId` is
	 * the creation's identity: the host stamps it onto the transition's
	 * initial-sync frame and reply so the client's selection owner can
	 * attribute them. */
	newSession(
		projectId: string,
		text: string,
		options: {
			operationId: string;
			images?: ImageContent[];
			model?: ModelRef;
			thinkingLevel?: string;
		},
	): Promise<RpcReply> {
		return this.call({ verb: "newSession", projectId, text, ...options });
	}

	listSessions(projectId: string, max?: number, cursor?: SessionListCursor | null): Promise<RpcReply> {
		const body: Record<string, unknown> & { verb: string } = { verb: "listSessions", projectId };
		if (max !== undefined) body.max = max;
		if (cursor !== undefined && cursor !== null) body.cursor = cursor;
		return this.call(body as RpcRequestBody);
	}

	/** The queue: the global Inbox-and-Later listing, ordered Inbox → Later,
	 * then placement stamp descending. A query: the browser's live queue comes
	 * from pushes (ADR 24). */
	listQueue(): Promise<RpcReply> {
		return this.call({ verb: "listQueue" });
	}

	/** Place a session: Inbox, Later, or Archive. Moving to Archive also ends
	 * the runtime. The result arrives in the next queue delta (ADR 24). */
	setSessionLocation(projectId: string, stem: string, location: SessionLocation): Promise<RpcReply> {
		return this.call({ verb: "setSessionLocation", projectId, stem, location });
	}

	getDaemonInfo(): Promise<RpcReply> {
		return this.call({ verb: "getDaemonInfo" });
	}

	/** Daemon-held dictation credentials (see AsrCredentialsRequest). The page
	 * never holds an ASR secret; a registered device or a minted token is all
	 * it receives. */
	asrCredentials(): Promise<RpcReply> {
		return this.call({ verb: "asrCredentials" });
	}

	/** Rewrite one composer draft (see TextPolishRequest). The daemon speaks the
	 * upstream protocol because a page cannot; only the text crosses the wire,
	 * and only when the operator enabled the feature. */
	textPolish(text: string): Promise<RpcReply> {
		return this.call({ verb: "textPolish", text });
	}

	pull(requests: { entryId: string; fieldPath: string }[]): Promise<RpcReply> {
		return this.call({ verb: "pull", requests });
	}

	/** Detach from the attached session (back to the Project home). */
	detach(): Promise<RpcReply> {
		return this.call({ verb: "detach" });
	}

	/** End the session's runtime, then move its file under the trash prefix
	 * (trashSession verb). The file survives; it is no longer discovered. */
	trashSession(projectId: string, stem: string): Promise<RpcReply> {
		return this.call({ verb: "trashSession", projectId, stem });
	}

	/** Path completion (ADR 12): `prefix` is resolved against the Project's
	 * cwd, so the Project home can complete before anything is attached. */
	listFiles(projectId: string, prefix: string): Promise<RpcReply> {
		return this.call({ verb: "listFiles", projectId, prefix });
	}

	/** Read one absolute path's content at a repository state (see
	 * ReadFileRequest): omitted or "worktree" from the filesystem, a pinned
	 * object id / "head" / "index" from git. */
	readFile(path: string, state?: SnapshotState): Promise<RpcReply> {
		return this.call(state === undefined ? { verb: "readFile", path } : { verb: "readFile", path, state });
	}

	/** List one absolute directory's immediate children at a repository state
	 * (see ListDirectoryRequest). Lazy: one directory per call. */
	listDirectory(path: string, state?: SnapshotState): Promise<RpcReply> {
		return this.call(state === undefined ? { verb: "listDirectory", path } : { verb: "listDirectory", path, state });
	}

	gitShow(commit: string): Promise<RpcReply> {
		return this.call({ verb: "gitShow", commit });
	}

	/** The comparison base for reviewing one commit (see GitBaseRequest): the
	 * commit's first parent, or the repository's empty-tree oid for a root
	 * commit. Attachment-free, like the browser's read queries. */
	gitBase(directory: string, commit: string): Promise<RpcReply> {
		return this.call({ verb: "gitBase", directory, commit });
	}

	/** The browser's diff *directive* — the file list, statuses, and line counts
	 * between two repository states under an absolute directory (see
	 * GitDiffRequest). Content is fetched per file with `readFile`. */
	gitDiff(directory: string, oldState: GitDiffState, newState: GitDiffState): Promise<RpcReply> {
		return this.call({ verb: "gitDiff", directory, old: oldState, new: newState });
	}

	console(level: "log" | "warn" | "error", args: JsonValue[]): Promise<RpcReply> {
		return this.call({ verb: "console", level, args });
	}

	// ── Disconnect ───────────────────────────────────────────────────────

	/** Reject all pending RPCs. Called on transport close. */
	disconnect(): void {
		for (const [, pending] of this.pending) {
			pending.reject(new Error("Disconnected"));
		}
		this.pending.clear();
	}

	// ── Internal ─────────────────────────────────────────────────────────

	/** Surface one undecodable or unrecognized message. Fired once: the
	 * caller closes the transport, so a burst before the close cannot stack. */
	private protocolError(message: string): void {
		if (this.violated) return;
		this.violated = true;
		this.onProtocolError?.(message);
	}

	private call(body: RpcRequestBody): Promise<RpcReply> {
		const id = String(++this.nextId);
		const request: Record<string, unknown> = { id, ...body };
		return new Promise<RpcReply>((resolve, reject) => {
			// Correlation precedes transmission: a transport may deliver a reply
			// inside `send` (an in-process link) or fail synchronously (a closed
			// socket). Installing the pending record first means a synchronous
			// reply finds its caller; a throwing `send` removes the record and
			// rejects exactly once, so a failed request leaves nothing pending.
			this.pending.set(id, { resolve, reject });
			try {
				this.transport.send(JSON.stringify(request));
			} catch (err) {
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private handleMessage(msg: Record<string, unknown>): void {
		// Push frames have no `id`
		if (!("id" in msg) || msg.id === undefined) {
			// The daemon and the app ship together; an unrecognized frame means a
			// version skew nothing below this seam can recover from.
			if (typeof msg.kind !== "string" || !PUSH_KINDS.has(msg.kind)) {
				this.protocolError(`unknown frame kind: ${String(msg.kind)}`);
				return;
			}
			const push = msg as unknown as ServerPushMessage;
			if (push.kind === "replace") {
				// A replace is an address-bearing initial sync: it establishes the
				// attachment generation this mirror replicates (ADR 19). The
				// generation is required on every observation frame.
				this.mirror.setGeneration(push.generation);
				this.mirror.applyReplace(push.document);
			} else if (push.kind === "patch") {
				if (push.session !== undefined) {
					// Address-bearing: a cursor-aware initial sync — it establishes
					// the generation like a replace.
					this.mirror.setGeneration(push.generation);
				} else {
					// A live patch belongs to the attachment the mirror replicates
					// (ADR 19): one from any other attachment — same address or
					// not — must not touch the mirror. A mirror with no
					// established generation holds no observation, so it admits
					// nothing either.
					if (this.mirror.generation === null || push.generation !== this.mirror.generation) {
						return;
					}
				}
				this.mirror.applyPatch(push.ops);
			}
			if (this._onPush) this._onPush(push);
			return;
		}

		// RPC reply — resolve pending promise
		const reply = msg as unknown as RpcReply;
		const pending = this.pending.get(reply.id);
		if (pending) {
			this.pending.delete(reply.id);
			pending.resolve(reply);
		}
	}
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function emptyMirror(): Document {
	return {
		status: {
			leafId: null,
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: { total: 0 },
				messages: 0,
			},
			contextUsage: null,
			pendingSteer: [],
			inFlightTools: {},
		},
		entries: {},
	};
}
