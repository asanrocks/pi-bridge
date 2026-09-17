// ============================================================================
// Client-side document mirror + BridgeClient — pure, browser-safe.
// Syncs to the server's canonical Document via Replace snapshots + Patches,
// plus lazy-field pull orchestration.
//
// Does NOT include: WebSocket transport, rendering.
// ============================================================================

import { applyPatch, CompactCodec, getAtPath, setAtPath } from "./document.ts";
import type {
	Document,
	ImageContent,
	JsonValue,
	ModelRef,
	PatchOp,
	PrefixCursor,
	RpcReply,
	RpcRequestBody,
	ServerPushMessage,
	SessionListCursor,
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

// ---------------------------------------------------------------------------
// DocumentMirror
// ---------------------------------------------------------------------------

export class DocumentMirror {
	/** The local mirror. Never authoritative — replaced on reconnect. */
	document: Document;

	constructor(document?: Document) {
		this.document = document ?? emptyMirror();
	}

	/**
	 * Replace the entire document with a server snapshot (Replace push).
	 * Called on connect, reconnect, and session switch.
	 * Reassigns the root — consumers holding the old reference see it stale.
	 */
	applyReplace(snapshot: Document): void {
		this.document = snapshot;
	}

	/**
	 * Apply an incremental patch batch from the server.
	 * Produces a new Document root; replaces the mirror reference.
	 * Each Patch is an atomic transaction.
	 */
	applyPatch(ops: PatchOp[]): void {
		this.document = applyPatch(this.document, ops);
	}

	/**
	 * Given a set of lazy field paths the UI wants to display,
	 * return the subset that are still `null` (not yet fetched).
	 *
	 * Call this before sending a PullRequest to the server.
	 * Paths already populated are filtered out — no redundant pulls.
	 */
	needsPull(wants: PullRequestItem[]): PullRequestItem[] {
		return wants.filter((w) => {
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
// planPull — pure batching step for the wants outbox (ADR 09)
// ---------------------------------------------------------------------------

/**
 * Filter a raw wants list down to the items worth pulling: dedupe by
 * fieldPath, drop fields already populated in the mirror (`needsPull`),
 * drop fields with an in-flight pull (`loadingPaths`).
 */
export function planPull(
	wants: PullRequestItem[],
	mirror: DocumentMirror,
	loadingPaths: ReadonlySet<string>,
): PullRequestItem[] {
	const seen = new Set<string>();
	const deduped: PullRequestItem[] = [];
	for (const w of wants) {
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
	private codec = new CompactCodec();
	private _onPush: ((msg: ServerPushMessage) => void) | null = null;

	constructor(transport: BridgeTransport) {
		this.mirror = new DocumentMirror();
		this.transport = transport;

		this.transport.onMessage = (data: string) => {
			try {
				const msg = this.codec.decodeIncoming(data);
				this.handleMessage(msg as unknown as Record<string, unknown>);
			} catch {
				// Ignore malformed messages
			}
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

	prompt(text: string, images?: ImageContent[]): Promise<RpcReply> {
		return images && images.length > 0
			? this.call({ verb: "prompt", text, images })
			: this.call({ verb: "prompt", text });
	}

	abort(): Promise<RpcReply> {
		return this.call({ verb: "abort" });
	}

	discardSteer(): Promise<RpcReply> {
		return this.call({ verb: "discardSteer" });
	}

	setModel(provider: string, model: string): Promise<RpcReply> {
		return this.call({ verb: "setModel", provider, model });
	}

	setThinkingLevel(level: string): Promise<RpcReply> {
		return this.call({ verb: "setThinkingLevel", level });
	}

	renameSession(name: string): Promise<RpcReply> {
		return this.call({ verb: "renameSession", name });
	}

	navigate(entryId: string | null): Promise<RpcReply> {
		return this.call({ verb: "navigate", entryId });
	}

	/** Resolve-or-activate a session by address (ADR 11). */
	openSession(projectId: string, stem: string, cursor?: PrefixCursor): Promise<RpcReply> {
		return this.call(
			cursor ? { verb: "openSession", projectId, stem, cursor } : { verb: "openSession", projectId, stem },
		);
	}

	/** Create a new unflushed session in a Project (ADR 11). The first
	 * prompt's text is admitted before attach (ADR 12 slice); optional
	 * `images` attach to it and `model` is applied before admission (the
	 * Project home's pre-session model choice). */
	newSession(
		projectId: string,
		text: string,
		options?: { images?: ImageContent[]; model?: ModelRef },
	): Promise<RpcReply> {
		return this.call({ verb: "newSession", projectId, text, ...options });
	}

	listSessions(projectId: string, max?: number, cursor?: SessionListCursor | null): Promise<RpcReply> {
		const body: Record<string, unknown> & { verb: string } = { verb: "listSessions", projectId };
		if (max !== undefined) body.max = max;
		if (cursor !== undefined && cursor !== null) body.cursor = cursor;
		return this.call(body as RpcRequestBody);
	}

	listActiveSessions(): Promise<RpcReply> {
		return this.call({ verb: "listActiveSessions" });
	}

	getDaemonInfo(): Promise<RpcReply> {
		return this.call({ verb: "getDaemonInfo" });
	}

	pull(requests: { entryId: string; fieldPath: string }[]): Promise<RpcReply> {
		return this.call({ verb: "pull", requests });
	}

	/** Detach from the attached session (back to the Project home). */
	detach(): Promise<RpcReply> {
		return this.call({ verb: "detach" });
	}

	/** Terminate the live instance for a session address (closeSession verb). */
	closeSession(projectId: string, stem: string): Promise<RpcReply> {
		return this.call({ verb: "closeSession", projectId, stem });
	}

	listFiles(prefix: string): Promise<RpcReply> {
		return this.call({ verb: "listFiles", prefix });
	}

	readFile(path: string): Promise<RpcReply> {
		return this.call({ verb: "readFile", path });
	}

	gitShow(commit: string): Promise<RpcReply> {
		return this.call({ verb: "gitShow", commit });
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

	private call(body: RpcRequestBody): Promise<RpcReply> {
		const id = String(++this.nextId);
		const request: Record<string, unknown> = { id, ...body };
		this.transport.send(JSON.stringify(request));

		return new Promise<RpcReply>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
		});
	}

	private handleMessage(msg: Record<string, unknown>): void {
		// Push frames have no `id`
		if (!("id" in msg) || msg.id === undefined) {
			const push = msg as unknown as ServerPushMessage;
			if (push.kind === "replace") {
				this.mirror.applyReplace(push.document);
			} else if (push.kind === "patch") {
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
		},
		entries: {},
		scopedModels: [],
	};
}
