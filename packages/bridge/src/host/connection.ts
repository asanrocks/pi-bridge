// ============================================================================
// Connection — the serialized protocol actor for one WebSocket.
//
// It owns the socket, RPC correlation, its own attachment-transition line,
// and the SessionCapability that is its current attachment. It interprets no
// Session state and enforces no navigation policy: every verb that is not an
// attachment transition is a typed handler in connection-verbs.ts, reached
// through a context that exposes only the daemon seam, the attachment
// capture, subscription registration, and the reply path. The three
// attachment-changing transitions (openSession, newSession, detach) are the
// serialized line itself and stay here:
//
//   Connection transitions (openSession, newSession, detach): serialized
//     among themselves, in arrival order (this.transitions).
//   Session work (commands, mutations): serialized by the Session actor
//     behind the capability; the Connection adds no ordering of its own.
// ============================================================================

import type { WebSocket } from "ws";
import type {
	ClientMessage,
	JsonValue,
	NewSessionRequest,
	OpenSessionRequest,
	PrefixCursor,
	SessionRef,
} from "../core/index.ts";
import { CompactCodec, filterPatchForSocket, type Patch } from "../core/index.ts";
import { connectionVerbHandler, type DaemonVerbs, type VerbContext } from "./connection-verbs.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import type { TrafficLogger } from "./logger.ts";
import type { ConnectionHandle } from "./manager.ts";
import type { SessionCapability } from "./session-actor.ts";

export class Connection {
	private ws: WebSocket;
	private daemonVerbs: DaemonVerbs;
	private logger: TrafficLogger | null;
	private subscriptions = new Set<string>();
	private codec = new CompactCodec();
	private handle: ConnectionHandle;
	/** The current attachment: a Session actor-issued capability, never the
	 * Session's runtime itself. Raw Manager access is a type error by
	 * construction. */
	private capability: SessionCapability | null = null;
	/** The operation id of the newSession transition currently in flight, if
	 * any: the transition's attach happens synchronously inside the verb
	 * (transitions serialize on this Connection), so the initial-sync frame
	 * the handle emits in that window is exactly that creation's — and gets
	 * its operation id stamped here, where the wire envelope is built. */
	private syncAttribution: string | null = null;
	private _disposed = false;
	/** Serialized attachment-changing transitions (see runTransition),
	 * drained at disposal so a transition still in flight when the socket
	 * closed settles before the Connection is gone. */
	private transitions = createLifecycleScope();
	/** The verb handlers' context: the daemon seam, the attachment capture,
	 * subscription registration, and the reply path — nothing else of the
	 * Connection's state. */
	private verbs: VerbContext;

	constructor(ws: WebSocket, daemonVerbs: DaemonVerbs, logger: TrafficLogger | null, devMode: boolean) {
		this.ws = ws;
		this.daemonVerbs = daemonVerbs;
		this.logger = logger;

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
				// A creation's initial sync carries its operation id, so the
				// client's selection owner can attribute the frame (see
				// NewSessionRequest.operationId).
				const attributed = this.syncAttribution !== null ? { ...frame, operationId: this.syncAttribution } : frame;
				this.send(attributed as unknown as Record<string, unknown>);
			},
		};

		this.verbs = {
			daemonVerbs,
			devMode,
			requireAttachment: () => this.requireAttachment(),
			subscribe: (fieldPath) => {
				this.subscriptions.add(fieldPath);
			},
			reply: (id, ok, error) => this.sendReply(id, ok, error),
			send: (data) => this.send(data),
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

	/** True while a Session capability is held. */
	get isAttached(): boolean {
		return this.capability !== null;
	}

	/** The address + identity of the attached session (ADR 11). */
	get attachedSession(): SessionRef | null {
		return this.capability?.ref ?? null;
	}

	/** True once the socket closed and the Connection was disposed. A disposed
	 * Connection must never be attached: nothing would ever release it, so the
	 * daemon skips the attach and lets the activation idle-collect instead. */
	get isDisposed(): boolean {
		return this._disposed;
	}

	/** Accept a Session actor-issued capability as this Connection's
	 * attachment. The codec is reset before the observer is installed, so the
	 * initial-sync frame the installation emits cannot reuse a remembered
	 * append path from the previous session (ADR 11). */
	attachCapability(capability: SessionCapability, cursor: PrefixCursor | null): void {
		this.detach();
		this.capability = capability;
		this.codec.reset();
		capability.observe(this.handle, cursor);
	}

	/** Release the current attachment: the capability removes its observer from
	 * the runtime and ends its admission; the activation stays alive for idle
	 * collection. */
	detach(): void {
		void this.capability?.release();
		this.capability = null;
	}

	/** Release the current attachment and drain the transition chain.
	 * Resolves once every admitted transition settled — the daemon's teardown
	 * awaits this, so a transition still in flight when the socket closed
	 * settles before the Connection is gone. Idempotent: the socket-close
	 * handler and the teardown both call it, and every caller observes the
	 * same drain. */
	dispose(): Promise<void> {
		this._disposed = true;
		this.detach();
		// A queued transition is refused with "connection closed" rather than
		// run — the socket is gone, so nothing is replied; the send no-ops.
		return this.transitions.close();
	}

	/** Push a daemon-originated frame (sessions_changed / active_sessions_changed). */
	push(frame: Record<string, unknown>): void {
		this.send(frame);
	}

	// ── Message handler ──────────────────────────────────────────────────

	/**
	 * Run one attachment-changing verb (openSession, newSession, detach).
	 * Transitions are serialized: each runs to completion before the next
	 * begins, in arrival order. A connection has at most one attachment, so
	 * two concurrent transitions deciding independently which manager ends
	 * up attached — the last writer winning — would make the reply the
	 * client trusts and the attachment the server keeps different operations'
	 * results. A disposed connection refuses admission: a transition that
	 * arrives after the socket closed, or that reaches its turn after it,
	 * replies with an error instead of attaching something nothing would
	 * ever release.
	 */
	private runTransition(id: string, op: () => Promise<void>): void {
		void this.transitions
			.run(async () => {
				if (this._disposed) {
					this.sendReply(id, false, "connection closed");
					return;
				}
				try {
					await op();
				} catch (err) {
					this.sendReply(id, false, (err as Error).message);
				}
			})
			.catch(() => {
				// Refused by the scope after dispose: reply exactly as the
				// in-flight check above does. The socket is normally gone with
				// the disposal (send then no-ops), but a transition that queued
				// behind disposal must not hang its caller without an answer.
				this.sendReply(id, false, "connection closed");
			});
	}

	/**
	 * The attachment a session command addresses, captured at handler entry —
	 * before any await. A transition that completes while the command runs
	 * cannot retarget it: the command executes against, and reports on, the
	 * session that was attached when the request arrived.
	 */
	private requireAttachment(): SessionCapability {
		if (!this.capability) throw new Error("no session attached");
		return this.capability;
	}

	private async handleMessage(msg: ClientMessage): Promise<void> {
		const { id, verb } = msg;

		try {
			switch (verb) {
				// ── Attachment transitions (the serialized line itself) ──────
				case "openSession": {
					const m = msg as unknown as OpenSessionRequest;
					this.runTransition(id, async () => {
						if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
						if (typeof m.stem !== "string" || m.stem === "") throw new Error("Missing `stem`");
						const result = await this.daemonVerbs.openSession(m.projectId, m.stem, this, m.cursor ?? null);
						if (result.ok) this.send({ id, ok: true, session: (result.session ?? null) as unknown as JsonValue });
						else this.sendReply(id, false, result.error);
					});
					break;
				}
				case "newSession": {
					const m = msg as unknown as NewSessionRequest;
					this.runTransition(id, async () => {
						if (typeof m.projectId !== "string" || m.projectId === "") throw new Error("Missing `projectId`");
						if (typeof m.text !== "string" || m.text.trim() === "") throw new Error("Missing `text`");
						if (typeof m.operationId !== "string" || m.operationId === "") {
							throw new Error("Missing `operationId`");
						}
						if (m.images !== undefined && !Array.isArray(m.images)) throw new Error("Invalid `images`");
						if (
							m.model !== undefined &&
							(typeof m.model !== "object" ||
								m.model === null ||
								typeof m.model.provider !== "string" ||
								typeof m.model.modelId !== "string")
						) {
							throw new Error("Invalid `model`");
						}
						if (m.thinkingLevel !== undefined && typeof m.thinkingLevel !== "string") {
							throw new Error("Invalid `thinkingLevel`");
						}
						// Attribute this transition's initial sync: the attach happens
						// synchronously inside the verb (this Connection's transitions
						// serialize), so the frame the handle emits in this window is
						// exactly this creation's. The finally clears the window before
						// any later transition runs.
						this.syncAttribution = m.operationId;
						try {
							const result = await this.daemonVerbs.newSession(m.projectId, this, m.text, {
								images: m.images,
								model: m.model,
								thinkingLevel: m.thinkingLevel,
							});
							if (result.ok) {
								this.send({
									id,
									ok: true,
									session: (result.session ?? null) as unknown as JsonValue,
									operationId: m.operationId,
								});
							} else {
								this.sendReply(id, false, result.error);
							}
						} finally {
							this.syncAttribution = null;
						}
					});
					break;
				}
				case "detach": {
					this.runTransition(id, async () => {
						this.daemonVerbs.detach(this);
						this.sendReply(id, true);
					});
					break;
				}

				// ── Every other verb: a typed handler (connection-verbs.ts) ─
				default: {
					const handler = connectionVerbHandler(verb);
					if (handler === undefined) throw new Error(`Unknown verb: ${verb}`);
					await handler(this.verbs, msg);
				}
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
