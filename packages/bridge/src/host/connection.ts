// ============================================================================
// Connection — the serialized protocol actor for one WebSocket.
//
// It owns the socket, RPC correlation, its own attachment-transition line,
// and the observation that is its current attachment. It interprets no
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
//     behind the target-bound commands; the Connection adds no ordering of its own.
// ============================================================================

import type { WebSocket } from "ws";
import type { ClientMessage, JsonValue, NewSessionRequest, OpenSessionRequest, SessionRef } from "../core/index.ts";
import { connectionVerbHandler, type DaemonVerbs, type VerbContext } from "./connection-verbs.ts";
import { createLifecycleScope } from "./lifecycle-scope.ts";
import type { TrafficLogger } from "./logger.ts";
import type { SessionCommands } from "./session-commands.ts";
import type {
	SessionTarget,
	WorkerObservation,
	WorkerObservationFrame,
	WorkerObservationSink,
} from "./worker-contract.ts";

/** One attached Session: the target its verbs address, the Worker observation
 * delivering its Document, and the typed commands bound to that target. The
 * Connection holds no runtime and no admission object — only these. */
export interface AttachedSession {
	readonly target: SessionTarget;
	readonly observation: WorkerObservation;
	readonly commands: SessionCommands;
}

/** What an attachment transition supplies: given the frame sink the Connection
 * will deliver on, establish the observation and report what it attached. */
export type SessionOpener = (sink: WorkerObservationSink) => Promise<AttachedSession>;

export class Connection {
	private ws: WebSocket;
	private daemonVerbs: DaemonVerbs;
	private logger: TrafficLogger | null;
	private devMode: boolean;
	/** The current attachment: a Worker observation and the target it serves,
	 * never a Session runtime. Raw Manager access is a type error by
	 * construction. */
	private attachment: AttachedSession | null = null;
	/** The attachment generation (ADR 19): minted per attach, so every
	 * observation frame this Connection emits names the attachment whose
	 * stream it belongs to — even when the address is unchanged. */
	private attachmentGeneration = 0;
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

	constructor(ws: WebSocket, daemonVerbs: DaemonVerbs, logger: TrafficLogger | null, devMode: boolean) {
		this.ws = ws;
		this.daemonVerbs = daemonVerbs;
		this.logger = logger;
		this.devMode = devMode;

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

	/** True while an observation is held. */
	get isAttached(): boolean {
		return this.attachment !== null;
	}

	/** The address + identity of the attached session (ADR 11). */
	get attachedSession(): SessionRef | null {
		const target = this.attachment?.target;
		return target === undefined
			? null
			: { projectId: target.projectId, stem: target.stem, sessionId: target.sessionId };
	}

	/** The edit target a session verb addresses (this slice's admission seam). */
	get attachedTarget(): SessionTarget | null {
		return this.attachment?.target ?? null;
	}

	/** True once the socket closed and the Connection was disposed. A disposed
	 * Connection must never be attached: nothing would ever release it, so the
	 * daemon skips the attach and lets the activation idle-collect instead. */
	get isDisposed(): boolean {
		return this._disposed;
	}

	/** Establish this Connection's attachment. The generation is minted before
	 * the opening transition runs, so the initial-sync frame it emits during
	 * acquisition already names the new attachment (ADR 19); a socket that
	 * closed while the transition was in flight releases the observation it
	 * produced instead of pinning a runtime nothing would ever release. */
	async attach(open: SessionOpener): Promise<SessionTarget> {
		// The generation is minted before the transition runs, so the frames the
		// new observation emits during acquisition already belong to it. The
		// previous attachment stays installed until the new one exists: a failed
		// open must leave the Connection on the Session it still holds.
		const generation = this.attachmentGeneration + 1;
		const attached = await open((frame) => this.deliverObservation(frame, generation));
		if (this._disposed) {
			await attached.observation.release();
			throw new Error("connection closed");
		}
		const previous = this.attachment;
		this.attachmentGeneration = generation;
		this.attachment = attached;
		// The predecessor is released before the transition resolves: a caller
		// that follows an attach with a stream observation must not still see the
		// old stream delivering (the Worker filters per observation, so a held
		// predecessor would keep its own demand alive).
		try {
			await previous?.observation.release();
		} catch {
			// An already-released observation (a terminal close) is not an error.
		}
		return attached.target;
	}

	/** Deliver one Worker frame, stamped with the attachment generation that
	 * produced it. A terminal frame always crosses the wire — the client's
	 * generation rule drops a stale one — but only the current attachment's
	 * terminal frame may end the attachment: a close of the observation a
	 * switch just left (its release can race a concurrent closeSession) must
	 * not detach the successor server-side. */
	private deliverObservation(frame: WorkerObservationFrame, generation: number): void {
		if (frame.kind === "replace") {
			this.send({
				...frame,
				generation,
				...(this.syncAttribution !== null ? { operationId: this.syncAttribution } : {}),
			} as unknown as Record<string, unknown>);
			return;
		}
		if (frame.kind === "patch") {
			// Already filtered for the observation's demand by the Worker. An
			// address-bearing delta (the initial sync) also carries its SessionRef
			// and, for a creation, the operation id that admitted it.
			const attributed = {
				...frame,
				generation,
				...(frame.session !== undefined && this.syncAttribution !== null
					? { operationId: this.syncAttribution }
					: {}),
			};
			this.send(attributed as unknown as Record<string, unknown>);
			return;
		}
		this.send({ kind: "session_closed", projectId: frame.address.projectId, stem: frame.address.stem, generation });
		// Only the current attachment's terminal frame ends it: a stale one names
		// a generation the attachment has advanced past. The Worker already ended
		// that observation; releasing the current one is idempotent and keeps the
		// Connection from holding a dead stream.
		if (generation !== this.attachmentGeneration) return;
		const current = this.attachment;
		this.attachment = null;
		void current?.observation.release();
	}

	/** Release the current attachment: the observation ends and its actor capability
	 * leaves, so the Activation idles out if nothing else holds it. */
	detach(): void {
		void this.attachment?.observation.release();
		this.attachment = null;
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
	/** The commands of the attachment a session verb addresses, captured at
	 * handler entry. They name the target they were bound to, so a transition
	 * that completes while a command runs cannot retarget it. */
	private requireCommands(): SessionCommands {
		if (!this.attachment) throw new Error("no session attached");
		return this.attachment.commands;
	}

	/** The attachment's target: the address, identity, and reported cwd a verb
	 * needs for attachment-bound reads. */
	private requireTarget(): SessionTarget {
		if (!this.attachment) throw new Error("no session attached");
		return this.attachment.target;
	}

	/** The verb handlers' context for one request: the daemon seam, the
	 * attachment capture, subscription registration, the reply path, and the
	 * attachment generation current when the request was admitted — nothing
	 * else of the Connection's state. */
	private verbsFor(attachmentGeneration: number): VerbContext {
		return {
			daemonVerbs: this.daemonVerbs,
			devMode: this.devMode,
			requireCommands: () => this.requireCommands(),
			requireTarget: () => this.requireTarget(),
			reply: (id, ok, error) => this.sendReply(id, ok, error),
			send: (data) => this.send(data),
			attachmentGeneration,
		};
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
					await handler(this.verbsFor(this.attachmentGeneration), msg);
				}
			}
		} catch (err) {
			this.sendReply(id, false, (err as Error).message);
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────

	private send(data: Record<string, unknown>): void {
		try {
			// Plain JSON frames: transport compaction is retired from the live
			// path, because a compacted frame cannot carry the attachment
			// generation every observation frame must name (ADR 19).
			this.ws.send(JSON.stringify(data));
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
