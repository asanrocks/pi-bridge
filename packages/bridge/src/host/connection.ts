import type { WebSocket } from "ws";
import type {
	ClientMessage,
	GetDaemonInfoReply,
	ImageContent,
	InstanceInfo,
	JsonValue,
	KillInstanceRequest,
	ListFilesRequest,
	ListSessionsRequest,
	NavigateRequest,
	NewInstanceRequest,
	PrefixCursor,
	PromptRequest,
	PullRequest,
	ReadFileRequest,
	RenameSessionRequest,
	SessionInfo,
	SetModelRequest,
	SetThinkingLevelRequest,
	SwitchInstanceRequest,
	SwitchSessionRequest,
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
// Connection — owns one WebSocket, attached to one Manager (or none)
// ============================================================================

export interface DaemonVerbs {
	listSessions: (opts?: { max?: number; ts?: string; cwd?: string }) => Promise<{
		sessions: SessionInfo[];
		hasMore: boolean;
	}>;
	getDaemonInfo: () => {
		models: {
			provider: string;
			id: string;
			name: string;
			reasoning: boolean;
			supportedThinkingLevels?: string[];
		}[];
		thinkingLevels: string[];
		cwdAllowlist: string[];
		devMode: boolean;
	};
	listFiles: (prefix: string, cwd?: string) => Array<{ path: string; isDirectory: boolean }>;
	/** Read a file for the web viewer. Throws on missing/unreadable paths
	 * (converted to an ok:false reply). Relative paths resolve against cwd. */
	readFile: (path: string, cwd?: string) => { path: string; content: string; truncated: boolean; bytes: number };
	listInstances: () => InstanceInfo[];
	switchInstance: (
		instanceId: string,
		conn: Connection,
		cursor?: PrefixCursor | null,
	) => Promise<{ ok: boolean; error?: string }>;
	newInstance: (cwd: string, conn: Connection) => Promise<{ ok: boolean; error?: string; instanceId?: string }>;
	killInstance: (instanceId: string, conn: Connection) => Promise<{ ok: boolean; error?: string }>;
}

// ============================================================================
// Connection — owns one WebSocket, attached to one Manager (or none)
// ============================================================================

export class Connection {
	private ws: WebSocket;
	private daemonVerbs: DaemonVerbs;
	private logger: TrafficLogger | null;
	private devMode: boolean;
	private subscriptions = new Set<string>();
	private codec = new CompactCodec();
	private handle: ConnectionHandle;
	private onSettledUnsubscribe: (() => void) | null = null;
	private _attachedManager: Manager | null = null;
	private _attachedInstanceId: string | null = null;

	constructor(ws: WebSocket, daemonVerbs: DaemonVerbs, logger: TrafficLogger | null, devMode: boolean) {
		this.ws = ws;
		this.daemonVerbs = daemonVerbs;
		this.logger = logger;
		this.devMode = devMode;

		// The Manager-facing handle (ADR 09). Initial-sync frames are sent
		// unfiltered — construction already stripped lazy fields — and reset
		// connection-local lazy subscriptions (attach + session rebind).
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
			onExit: () => {
				this.send({ kind: "instance_exit", instanceId: this._attachedInstanceId ?? "" });
				this._attachedManager = null;
				this._attachedInstanceId = null;
			},
		};

		// Connection starts unattached (no Manager). The Daemon calls attach()
		// when the client selects an instance.

		// Listen for WS messages
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

	get attachedInstanceId(): string | null {
		return this._attachedInstanceId;
	}

	attach(manager: Manager, instanceId: string, cursor?: PrefixCursor | null): void {
		this.detach();
		this._attachedManager = manager;
		this._attachedInstanceId = instanceId;
		manager.addConnection(this.handle, cursor ?? null);
		this.onSettledUnsubscribe = manager.onSettled(async () => {
			await this.pushSessionsChanged();
		});
	}

	detach(): void {
		if (!this._attachedManager) return;
		this._attachedInstanceId = null;
		this._attachedManager.removeConnection(this.handle);
		if (this.onSettledUnsubscribe) {
			this.onSettledUnsubscribe();
			this.onSettledUnsubscribe = null;
		}
		this._attachedManager = null;
	}

	dispose(): void {
		this.detach();
	}

	// ── Message handler ──────────────────────────────────────────────────

	private async handleMessage(msg: ClientMessage): Promise<void> {
		const { id, verb } = msg;

		try {
			switch (verb) {
				// ── Session verbs (require attached Manager) ────────────────
				case "prompt": {
					if (!this._attachedManager) throw new Error("no instance attached");
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
					if (!this._attachedManager) throw new Error("no instance attached");
					await this._attachedManager.abort();
					this.sendReply(id, true);
					break;
				}
				case "discardSteer": {
					if (!this._attachedManager) throw new Error("no instance attached");
					await this._attachedManager.discardSteer();
					this.sendReply(id, true);
					break;
				}
				case "setModel": {
					if (!this._attachedManager) throw new Error("no instance attached");
					const m = msg as unknown as SetModelRequest;
					await this._attachedManager.setModel(m.provider, m.model);
					this.sendReply(id, true);
					break;
				}
				case "setThinkingLevel": {
					if (!this._attachedManager) throw new Error("no instance attached");
					const m = msg as unknown as SetThinkingLevelRequest;
					await this._attachedManager.setThinkingLevel(m.level);
					this.sendReply(id, true);
					break;
				}
				case "renameSession": {
					if (!this._attachedManager) throw new Error("no instance attached");
					const m = msg as unknown as RenameSessionRequest;
					if (typeof m.name !== "string") throw new Error("Missing `name`");
					await this._attachedManager.renameSession(m.name);
					this.sendReply(id, true);
					await this.pushSessionsChanged();
					break;
				}
				case "navigate": {
					if (!this._attachedManager) throw new Error("no instance attached");
					const m = msg as unknown as NavigateRequest;
					if (m.entryId !== null && typeof m.entryId !== "string") throw new Error("Missing `entryId`");
					await this._attachedManager.navigate(m.entryId);
					this.sendReply(id, true);
					break;
				}
				case "switchSession": {
					if (!this._attachedManager) throw new Error("no instance attached");
					const m = msg as unknown as SwitchSessionRequest;
					if (typeof m.sessionPath !== "string") throw new Error("Missing `sessionPath`");
					await this._attachedManager.switchSession(m.sessionPath, m.cursor ?? null, this.handle);
					this.sendReply(id, true);
					await this.pushSessionsChanged();
					break;
				}
				case "newSession": {
					if (!this._attachedManager) throw new Error("no instance attached");
					await this._attachedManager.newSession();
					this.sendReply(id, true);
					// Push updated sessions list (with stub entry for new session)
					const cwd = this._attachedManager.cwd;
					const updated = await this.daemonVerbs.listSessions({ max: 10, cwd });
					const liveId = this._attachedManager.liveSessionId;
					if (liveId && !updated.sessions.some((s) => s.sessionId === liveId)) {
						updated.sessions.push({
							sessionId: liveId,
							sessionPath: null,
							name: "",
							timestamp: new Date().toISOString(),
							firstMessageText: undefined,
							messageCount: 0,
						});
					}
					this.send({ kind: "sessions_changed", sessions: updated.sessions, hasMore: updated.hasMore });
					break;
				}

				// ── Instance routing verbs (Daemon, side-effectful) ───────
				case "switchInstance": {
					const m = msg as unknown as SwitchInstanceRequest;
					if (typeof m.instanceId !== "string") throw new Error("Missing `instanceId`");
					const result = await this.daemonVerbs.switchInstance(m.instanceId, this, m.cursor ?? null);
					if (result.ok) this.sendReply(id, true);
					else this.sendReply(id, false, result.error);
					break;
				}
				case "newInstance": {
					const m = msg as unknown as NewInstanceRequest;
					if (typeof m.cwd !== "string") throw new Error("Missing `cwd`");
					const result = await this.daemonVerbs.newInstance(m.cwd, this);
					if (result.ok) {
						this.send({ id, ok: true, instanceId: result.instanceId } as Record<string, unknown>);
					} else {
						this.sendReply(id, false, result.error);
					}
					break;
				}
				case "killInstance": {
					const m = msg as unknown as KillInstanceRequest;
					if (typeof m.instanceId !== "string") throw new Error("Missing `instanceId`");
					const result = await this.daemonVerbs.killInstance(m.instanceId, this);
					if (result.ok) this.sendReply(id, true);
					else this.sendReply(id, false, result.error);
					break;
				}

				// ── Daemon query verbs ─────────────────────────────────────
				case "listSessions": {
					const m = msg as unknown as ListSessionsRequest;
					const ts = m.ts ?? undefined;
					const max = m.max ?? undefined;
					const cwd = this._attachedManager?.cwd;
					const result = await this.daemonVerbs.listSessions(
						max !== undefined || ts !== undefined || cwd !== undefined ? { max, ts, cwd } : undefined,
					);
					this.send({ id, ok: true, sessions: result.sessions, hasMore: result.hasMore });
					break;
				}
				case "getDaemonInfo": {
					const info = this.daemonVerbs.getDaemonInfo();
					const reply: GetDaemonInfoReply = { id, ok: true, ...info };
					this.send(reply as unknown as Record<string, unknown>);
					break;
				}
				case "listInstances": {
					const instances = this.daemonVerbs.listInstances();
					this.send({ id, ok: true, instances });
					break;
				}
				case "listFiles": {
					const m = msg as unknown as ListFilesRequest;
					if (typeof m.prefix !== "string") throw new Error("Missing `prefix`");
					const cwd = this._attachedManager?.cwd;
					const entries = this.daemonVerbs.listFiles(m.prefix, cwd);
					this.send({ id, ok: true, entries });
					break;
				}
				case "readFile": {
					const m = msg as unknown as ReadFileRequest;
					if (typeof m.path !== "string" || m.path === "") throw new Error("Missing `path`");
					// Requires an attached instance: relative links resolve against
					// its cwd, so an unattached read has no authoritative base.
					if (!this._attachedManager) throw new Error("no instance attached");
					const result = this.daemonVerbs.readFile(m.path, this._attachedManager.cwd);
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
					if (!this._attachedManager) throw new Error("no instance attached");
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

				case "detachInstance": {
					// Back to the instance list: unbind from the Manager so its
					// patches stop flowing. The instance keeps running headless.
					this.detach();
					this.sendReply(id, true);
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

	private async pushSessionsChanged(): Promise<void> {
		const cwd = this._attachedManager?.cwd;
		const updated = await this.daemonVerbs.listSessions({ max: 10, cwd });
		this.send({ kind: "sessions_changed", sessions: updated.sessions, hasMore: updated.hasMore });
	}

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
