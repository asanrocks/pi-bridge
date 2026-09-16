import type { WebSocket } from "ws";
import type {
	ClientMessage,
	GetDaemonInfoReply,
	GitShowRequest,
	ImageContent,
	JsonValue,
	ListFilesRequest,
	ListSessionsRequest,
	NavigateRequest,
	NewSessionRequest,
	OpenSessionRequest,
	PrefixCursor,
	ProjectInfo,
	PromptRequest,
	PullRequest,
	ReadFileRequest,
	RenameSessionRequest,
	SessionInfo,
	SessionListCursor,
	SessionRef,
	SetModelRequest,
	SetThinkingLevelRequest,
} from "../core/index.ts";
import {
	CompactCodec,
	filterPatchForSocket,
	MAX_IMAGE_BASE64_LENGTH,
	MAX_IMAGES_PER_MESSAGE,
	type Patch,
	resolveFieldPath,
} from "../core/index.ts";
import type { TrafficLogger } from "./logger.ts";
import type { ConnectionHandle, Manager } from "./manager.ts";

// ============================================================================
// DaemonVerbs — the Connection → Daemon seam (ADR 11)
// ============================================================================

export interface DaemonVerbs {
	/** Static Project configuration (ADR 11). Never a cwd allowlist: clients
	 * address sessions by `(projectId, stem)`. */
	getDaemonInfo: () => {
		projects: ProjectInfo[];
		models: {
			provider: string;
			id: string;
			name: string;
			reasoning: boolean;
			supportedThinkingLevels?: string[];
		}[];
		thinkingLevels: string[];
		devMode: boolean;
	};
	/** Paginated history query for one Project. */
	listSessions: (
		projectId: string,
		max?: number,
		cursor?: SessionListCursor | null,
	) => Promise<{ sessions: SessionInfo[]; hasMore: boolean; nextCursor?: SessionListCursor }>;
	/** Global active/streaming snapshot. */
	listActiveSessions: () => SessionInfo[];
	/** Resolve-or-activate `(projectId, stem)` and attach this Connection. */
	openSession: (
		projectId: string,
		stem: string,
		conn: Connection,
		cursor?: PrefixCursor | null,
	) => Promise<{ ok: boolean; error?: string; session?: SessionRef }>;
	/** Create a new unflushed session in a Project and attach this Connection. */
	newSession: (projectId: string, conn: Connection) => Promise<{ ok: boolean; error?: string; session?: SessionRef }>;
	/** Release this Connection's attachment (activation stays alive for GC). */
	detach: (conn: Connection) => void;
	/** Broadcast a Project's refreshed first page (rename, settle). */
	sessionsChanged: (projectId: string) => void;
	listFiles: (prefix: string, cwd?: string) => Array<{ path: string; isDirectory: boolean }>;
	/** Read a file for the web viewer. Throws on missing/unreadable paths
	 * (converted to an ok:false reply). Relative paths resolve against cwd. */
	readFile: (path: string, cwd?: string) => { path: string; content: string; truncated: boolean; bytes: number };
	/** Show a commit (`git show --stat`) for an ADR 10 change card. Throws on
	 * invalid commits and spawn failures (converted to an ok:false reply). */
	gitShow: (commit: string, cwd?: string) => Promise<{ output: string; truncated: boolean }>;
}

// ============================================================================
// Connection — owns one WebSocket, attached to at most one Manager
// ============================================================================

export class Connection {
	private ws: WebSocket;
	private daemonVerbs: DaemonVerbs;
	private logger: TrafficLogger | null;
	private devMode: boolean;
	private subscriptions = new Set<string>();
	private codec = new CompactCodec();
	private handle: ConnectionHandle;
	private _attachedManager: Manager | null = null;
	private _attachedSession: SessionRef | null = null;
	private _disposed = false;

	constructor(ws: WebSocket, daemonVerbs: DaemonVerbs, logger: TrafficLogger | null, devMode: boolean) {
		this.ws = ws;
		this.daemonVerbs = daemonVerbs;
		this.logger = logger;
		this.devMode = devMode;

		// The Manager-facing handle (ADR 09). Initial-sync frames are sent
		// unfiltered — construction already stripped lazy fields — and reset
		// connection-local lazy subscriptions.
		this.handle = {
			onPatch: (patch: Patch) => {
				const filtered = filterPatchForSocket(patch.ops, this.subscriptions);
				if (filtered.length > 0) {
					const frame = { kind: "patch", ops: filtered };
					this.send(frame);
				}
			},
			onInitialSync: (frame) => {
				this.subscriptions.clear();
				this.send(frame as unknown as Record<string, unknown>);
			},
		};

		// A Connection starts unattached. The Daemon attaches it via openSession.
		ws.on("message", (data) => {
			try {
				const msg = JSON.parse(data.toString()) as ClientMessage;
				this.logger?.log("in", msg as unknown as Record<string, unknown>);
				this.handleMessage(msg);
			} catch {
				// Ignore malformed messages
			}
		});
	}

	// ── Attachment state ──────────────────────────────────────────────────

	get attachedManager(): Manager | null {
		return this._attachedManager;
	}

	/** The address + identity of the attached session (ADR 11). */
	get attachedSession(): SessionRef | null {
		return this._attachedSession;
	}

	/** True once the socket closed and the Connection was disposed. A disposed
	 * Connection must never be attached: nothing would ever release it, so the
	 * daemon skips the attach and lets the activation idle-collect instead. */
	get isDisposed(): boolean {
		return this._disposed;
	}

	attach(manager: Manager, session: SessionRef, cursor?: PrefixCursor | null): void {
		this.detach();
		this._attachedManager = manager;
		this._attachedSession = session;
		// A stale remembered append path must not survive an attach (ADR 11):
		// initial-sync frames carry `session` and are never compacted.
		this.codec.reset();
		manager.addConnection(this.handle, session, cursor ?? null);
	}

	detach(): void {
		if (!this._attachedManager) return;
		this._attachedManager.removeConnection(this.handle);
		this._attachedManager = null;
		this._attachedSession = null;
	}

	dispose(): void {
		this._disposed = true;
		this.detach();
	}

	/** Push a daemon-originated frame (sessions_changed / active_sessions_changed). */
	push(frame: Record<string, unknown>): void {
		this.send(frame);
	}

	// ── Message handler ──────────────────────────────────────────────────

	private async handleMessage(msg: ClientMessage): Promise<void> {
		const { id, verb } = msg;

		try {
			switch (verb) {
				// ── Attached session verbs ─────────────────────────────────
				case "prompt": {
					if (!this._attachedManager) throw new Error("no session attached");
					const m = msg as unknown as PromptRequest;
					if (typeof m.text !== "string") throw new Error("Missing `text`");
					// Light shape validation: images are opaque base64 blobs relayed
					// to the provider; only the envelope fields and wire limits are
					// checked here.
					const images = m.images;
					if (
						images !== undefined &&
						(!Array.isArray(images) ||
							images.length > MAX_IMAGES_PER_MESSAGE ||
							images.some(
								(i) =>
									i === null ||
									typeof i !== "object" ||
									typeof (i as ImageContent).data !== "string" ||
									(i as ImageContent).data.length > MAX_IMAGE_BASE64_LENGTH ||
									typeof (i as ImageContent).mimeType !== "string",
							))
					) {
						throw new Error("Invalid `images`");
					}
					await this._attachedManager.prompt(m.text, images);
					this.sendReply(id, true);
					break;
				}
				case "abort": {
					if (!this._attachedManager) throw new Error("no session attached");
					await this._attachedManager.abort();
					this.sendReply(id, true);
					break;
				}
				case "discardSteer": {
					if (!this._attachedManager) throw new Error("no session attached");
					await this._attachedManager.discardSteer();
					this.sendReply(id, true);
					break;
				}
				case "setModel": {
					if (!this._attachedManager) throw new Error("no session attached");
					const m = msg as unknown as SetModelRequest;
					await this._attachedManager.setModel(m.provider, m.model);
					this.sendReply(id, true);
					break;
				}
				case "setThinkingLevel": {
					if (!this._attachedManager) throw new Error("no session attached");
					const m = msg as unknown as SetThinkingLevelRequest;
					await this._attachedManager.setThinkingLevel(m.level);
					this.sendReply(id, true);
					break;
				}
				case "renameSession": {
					if (!this._attachedManager || !this._attachedSession) throw new Error("no session attached");
					const m = msg as unknown as RenameSessionRequest;
					if (typeof m.name !== "string") throw new Error("Missing `name`");
					await this._attachedManager.renameSession(m.name);
					this.sendReply(id, true);
					this.daemonVerbs.sessionsChanged(this._attachedSession.projectId);
					break;
				}
				case "navigate": {
					if (!this._attachedManager) throw new Error("no session attached");
					const m = msg as unknown as NavigateRequest;
					if (m.entryId !== null && typeof m.entryId !== "string") throw new Error("Missing `entryId`");
					await this._attachedManager.navigate(m.entryId);
					this.sendReply(id, true);
					break;
				}

				// ── Navigation verbs (Daemon, side-effectful) ──────────────
				case "openSession": {
					const m = msg as unknown as OpenSessionRequest;
					if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
					if (typeof m.stem !== "string" || m.stem === "") throw new Error("Missing `stem`");
					const result = await this.daemonVerbs.openSession(m.projectId, m.stem, this, m.cursor ?? null);
					if (result.ok) this.send({ id, ok: true, session: (result.session ?? null) as unknown as JsonValue });
					else this.sendReply(id, false, result.error);
					break;
				}
				case "newSession": {
					const m = msg as unknown as NewSessionRequest;
					if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
					const result = await this.daemonVerbs.newSession(m.projectId, this);
					if (result.ok) this.send({ id, ok: true, session: (result.session ?? null) as unknown as JsonValue });
					else this.sendReply(id, false, result.error);
					break;
				}
				case "detach": {
					this.daemonVerbs.detach(this);
					this.sendReply(id, true);
					break;
				}

				// ── Daemon query verbs ─────────────────────────────────────
				case "listSessions": {
					const m = msg as unknown as ListSessionsRequest;
					if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
					const result = await this.daemonVerbs.listSessions(m.projectId, m.max ?? undefined, m.cursor ?? null);
					const reply: Record<string, unknown> = {
						id,
						ok: true,
						sessions: result.sessions,
						hasMore: result.hasMore,
					};
					if (result.nextCursor) reply.nextCursor = result.nextCursor;
					this.send(reply);
					break;
				}
				case "listActiveSessions": {
					this.send({ id, ok: true, sessions: this.daemonVerbs.listActiveSessions() });
					break;
				}
				case "getDaemonInfo": {
					const info = this.daemonVerbs.getDaemonInfo();
					const reply: GetDaemonInfoReply = { id, ok: true, ...info };
					this.send(reply as unknown as Record<string, unknown>);
					break;
				}
				case "listFiles": {
					const m = msg as unknown as ListFilesRequest;
					if (typeof m.prefix !== "string") throw new Error("Missing `prefix`");
					if (!this._attachedManager) throw new Error("no session attached");
					const entries = this.daemonVerbs.listFiles(m.prefix, this._attachedManager.cwd);
					this.send({ id, ok: true, entries });
					break;
				}
				case "readFile": {
					const m = msg as unknown as ReadFileRequest;
					if (typeof m.path !== "string" || m.path === "") throw new Error("Missing `path`");
					// Requires an attachment: relative links resolve against the
					// attached session's Project cwd.
					if (!this._attachedManager) throw new Error("no session attached");
					const result = this.daemonVerbs.readFile(m.path, this._attachedManager.cwd);
					this.send({ id, ok: true, ...result });
					break;
				}
				case "gitShow": {
					const m = msg as unknown as GitShowRequest;
					if (typeof m.commit !== "string" || m.commit === "") throw new Error("Missing `commit`");
					// Requires an attachment: the recorded commit belongs to the
					// attached session's repository, so its cwd is the query base.
					if (!this._attachedManager) throw new Error("no session attached");
					const result = await this.daemonVerbs.gitShow(m.commit, this._attachedManager.cwd);
					this.send({ id, ok: true, ...result });
					break;
				}

				// ── Dev-mode console relay ─────────────────────────────────
				case "console": {
					if (!this.devMode) throw new Error("console verb requires --dev mode");
					this.sendReply(id, true);
					break;
				}

				// ── Connection-local verb ──────────────────────────────────
				case "pull": {
					if (!this._attachedManager) throw new Error("no session attached");
					const m = msg as unknown as PullRequest;
					if (!m.requests || !Array.isArray(m.requests)) throw new Error("Missing `requests` array");
					const values: { entryId: string; fieldPath: string; value: JsonValue }[] = [];
					for (const req of m.requests) {
						const entry = this._attachedManager.document.entries[req.entryId];
						if (!entry) continue;
						const value = resolveFieldPath(entry as unknown as Record<string, unknown>, req.fieldPath);
						if (value !== undefined) {
							values.push({ entryId: req.entryId, fieldPath: req.fieldPath, value: value as JsonValue });
							if (req.entryId.startsWith("pending:")) {
								this.subscriptions.add(req.fieldPath);
							}
						}
					}
					this.send({ id, ok: true, values });
					break;
				}

				default:
					throw new Error(`Unknown verb: ${verb}`);
			}
		} catch (err) {
			this.sendReply(id, false, (err as Error).message);
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────

	private send(data: Record<string, unknown>): void {
		try {
			this.ws.send(this.codec.encodeOutgoing(data));
			this.logger?.log("out", data);
		} catch {
			// Socket closed
		}
	}

	private sendReply(id: string, ok: boolean, error?: string): void {
		const reply: Record<string, unknown> = { id, ok };
		if (error) reply.error = error;
		this.send(reply);
	}
}
