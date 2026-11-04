// ============================================================================
// Worker client — the Daemon's `WorkerService` over a socket.
//
// It is the mirror of `worker-server.ts`: requests are correlated by an id the
// Daemon mints, observation frames are routed to the sink that allocated the
// observation, and Worker events are handed to the Daemon's listeners. The
// Daemon cannot tell this implementation from the in-process one, which is the
// property the whole split exists for.
//
// Liveness: an idle Session produces no traffic, so silence is not evidence of
// a dead peer. The client pings on an interval and treats a link that has not
// ponged within the timeout as lost — the same close path as a socket error —
// so a half-open socket cannot pin a Registration, its Projects, or its
// observations.
//
// A lost link is not a crash: pending requests reject, every observation ends,
// and `unavailable` listeners fire once. The Daemon withdraws the registration
// and can reconnect; the Worker keeps its runtimes (losing a Daemon is not a
// reason to kill in-flight turns).
// ============================================================================

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ImageContent, JsonValue, PullRequestItem, SessionInfo } from "../core/index.ts";
import type {
	ObservedSession,
	ObserveSessionOptions,
	SessionAddress,
	SessionPage,
	SessionTarget,
	WorkerEvent,
	WorkerInfo,
	WorkerObservation,
	WorkerObservationSink,
	WorkerPulledValue,
	WorkerRegistration,
	WorkerService,
} from "./worker-contract.ts";
import {
	parseWorkerFrame,
	WORKER_HEARTBEAT_INTERVAL_MS,
	WORKER_HEARTBEAT_TIMEOUT_MS,
	WORKER_PROTOCOL_VERSION,
	WORKER_REJECTED_CLOSE_CODE,
	type WorkerPush,
	type WorkerReply,
	type WorkerRequestInput,
} from "./worker-protocol.ts";

/** A registration the Daemon refused (or a peer it cannot speak to). It is
 * terminal for the link: retrying the same handshake cannot succeed, so a
 * spawning caller must fail instead of waiting out its start deadline. */
export class WorkerRegistrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerRegistrationError";
	}
}

/** The handshake a caller may reject: throwing withdraws the registration
 * before any Project is routed. */
export interface WorkerHello {
	readonly protocol: number;
	readonly registration: WorkerRegistration;
	readonly info: WorkerInfo;
}

export interface ConnectWorkerOptions extends AdoptWorkerOptions {
	/** `unix:/path/to.sock` or `ws://host:port`. */
	readonly endpoint: string;
}

/** How a Daemon adopts a socket it did not dial: a Worker's registration
 * arrives on it, so handshake validation and the heartbeat are the same as for
 * a dialed link. */
export interface AdoptWorkerOptions {
	/** Validate the advertised registration; throw to reject it. A rejected
	 * registration closes the socket and rejects the adoption. */
	readonly accept?: (hello: WorkerHello) => void;
	/** The handshake frame the caller already read. A registration socket peeks
	 * its first frame to tell a probe from a Worker, so the hello may be consumed
	 * before adoption starts; seeding it keeps handshake ordering intact. */
	readonly hello?: WorkerHello;
	readonly heartbeatIntervalMs?: number;
	readonly heartbeatTimeoutMs?: number;
	/** Handshake deadline. */
	readonly handshakeTimeoutMs?: number;
}

export interface RemoteWorker extends WorkerService {
	/** The registration and environment reported by the handshake. */
	readonly hello: WorkerHello;
	/** Resolves once the link is gone (socket close, error, or heartbeat loss). */
	readonly closed: Promise<void>;
	onUnavailable(listener: (reason: string) => void): () => void;
	/** Drop this link without asking the Worker to stop. A Daemon disposes a
	 * Worker it spawned; a Worker that dialed in owns its own lifetime, so losing
	 * the Daemon must not end its runtimes. */
	closeLink(): void;
}

interface Pending {
	resolve: (result: JsonValue) => void;
	reject: (error: Error) => void;
}

function connectUrl(endpoint: string): string {
	if (!endpoint.startsWith("unix:")) return endpoint;
	// `ws` speaks Unix sockets through its own URL form; the trailing path is the
	// HTTP request target, which the serving side ignores.
	return `ws+unix://${endpoint.slice("unix:".length)}:/`;
}

export function connectWorker(options: ConnectWorkerOptions): Promise<RemoteWorker> {
	return adoptWorkerConnection(new WebSocket(connectUrl(options.endpoint)), options);
}

/**
 * Wrap a socket the caller already has — dialed by `connectWorker`, or accepted
 * by a registration listener — as a `WorkerService`. The two directions differ
 * only in who opened the socket: correlation, observation routing, the
 * heartbeat, and the handshake are identical, so they share one implementation.
 */
export function adoptWorkerConnection(ws: WebSocket, options: AdoptWorkerOptions = {}): Promise<RemoteWorker> {
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
	const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? WORKER_HEARTBEAT_TIMEOUT_MS;
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;

	return new Promise<RemoteWorker>((resolveConnect, rejectConnect) => {
		const pending = new Map<string, Pending>();
		/** Live observations, with the address their terminal frame names. */
		const observations = new Map<string, { sink: WorkerObservationSink; address: SessionAddress | null }>();
		const eventListeners = new Set<(event: WorkerEvent) => void>();
		const unavailableListeners = new Set<(reason: string) => void>();
		let hello: WorkerHello | null = null;
		let settled = false;
		let closedResolve: () => void = () => {};
		const closed = new Promise<void>((resolve) => {
			closedResolve = resolve;
		});
		let lastPong = Date.now();
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		let unavailable = false;

		const fail = (error: Error): void => {
			if (!settled) {
				settled = true;
				rejectConnect(error);
				return;
			}
			for (const [, entry] of pending) entry.reject(error);
			pending.clear();
			observations.clear();
		};

		const withdraw = (reason: string): void => {
			if (unavailable) return;
			unavailable = true;
			for (const listener of unavailableListeners) {
				try {
					listener(reason);
				} catch {
					// A throwing listener cannot defeat the withdrawal.
				}
			}
		};

		/**
		 * End the link: withdraw the registration, settle everything that was
		 * waiting on it, and drop the socket. `unavailable` is terminal for the
		 * same reason a socket close is — the registration it names can serve
		 * nothing more — so both take this one path. Without it, requests admitted
		 * before the push would wait for replies that can never come.
		 */
		const terminate = (reason: string): void => {
			withdraw(reason);
			// Every observation ends with the registration: the Daemon must learn
			// that its Session's stream is gone, or the browser keeps an attachment
			// that can never progress.
			for (const [, held] of observations) {
				if (held.address === null) continue;
				try {
					held.sink({ kind: "closed", address: held.address });
				} catch {
					// A throwing sink is the Daemon's bug, not the link's.
				}
			}
			fail(new Error(reason));
			if (heartbeat !== null) clearInterval(heartbeat);
			heartbeat = null;
			try {
				ws.terminate();
			} catch {
				// Already gone.
			}
		};

		const request = <R>(body: WorkerRequestInput): Promise<R> => {
			if (unavailable) return Promise.reject(new Error("worker is unavailable"));
			const id = randomUUID();
			return new Promise<R>((resolve, reject) => {
				pending.set(id, {
					resolve: (result) => resolve(result as R),
					reject,
				});
				try {
					ws.send(JSON.stringify({ ...body, id }));
				} catch (error) {
					pending.delete(id);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		};

		const handlePush = (push: WorkerPush): void => {
			if (push.kind === "observation") {
				const held = observations.get(push.observation);
				if (held === undefined) return;
				// A terminal frame ends the observation on both sides.
				if (push.frame.kind === "closed") observations.delete(push.observation);
				try {
					held.sink(push.frame);
				} catch {
					// A throwing sink is the Daemon's bug, not the link's.
				}
				return;
			}
			if (push.kind === "event") {
				for (const listener of eventListeners) {
					try {
						listener(push.event);
					} catch {
						// see above
					}
				}
				return;
			}
			if (push.kind === "unavailable") terminate(push.reason);
		};

		/** Validate one handshake and make the link live. A rejection is terminal
		 * for the registration, so the socket closes with the rejected code and the
		 * caller's promise rejects with `WorkerRegistrationError`. */
		const acceptHello = (candidate: WorkerHello): void => {
			if (hello !== null || settled) return;
			if (candidate.protocol !== WORKER_PROTOCOL_VERSION) {
				settled = true;
				const reason = `worker protocol mismatch: peer ${candidate.protocol}, expected ${WORKER_PROTOCOL_VERSION}`;
				ws.close(WORKER_REJECTED_CLOSE_CODE, reason);
				rejectConnect(new WorkerRegistrationError(reason));
				return;
			}
			try {
				options.accept?.(candidate);
			} catch (error) {
				settled = true;
				const reason = error instanceof Error ? error.message : String(error);
				// The caller's `accept` rejected the registration: terminal, not
				// transient, so a spawning host fails instead of polling and a
				// dialed-in Worker stops instead of reconnecting forever.
				ws.close(WORKER_REJECTED_CLOSE_CODE, reason);
				rejectConnect(new WorkerRegistrationError(reason));
				return;
			}
			hello = candidate;
			settled = true;
			clearTimeout(handshakeTimer);
			lastPong = Date.now();
			heartbeat = setInterval(() => {
				if (Date.now() - lastPong > heartbeatTimeoutMs) {
					terminate("worker link lost: heartbeat timeout");
					return;
				}
				try {
					ws.ping();
				} catch {
					// The close handler settles the link.
				}
			}, heartbeatIntervalMs);
			resolveConnect(worker);
		};

		ws.on("message", (data) => {
			const frame = parseWorkerFrame(data.toString());
			if (frame === null) return;

			// Replies carry `ok`; the handshake is the first push.
			if ("ok" in frame) {
				const reply = frame as WorkerReply;
				const entry = pending.get(reply.id);
				if (entry === undefined) return;
				pending.delete(reply.id);
				if (reply.ok) entry.resolve(reply.result);
				else entry.reject(new Error(reply.error));
				return;
			}

			const push = frame as WorkerPush;
			if (push.kind === "hello") {
				acceptHello({ protocol: push.protocol, registration: push.registration, info: push.info });
				return;
			}
			handlePush(push);
		});

		ws.on("pong", () => {
			lastPong = Date.now();
		});

		ws.on("close", () => {
			if (heartbeat !== null) clearInterval(heartbeat);
			heartbeat = null;
			withdraw("worker link closed");
			fail(new Error("worker link closed"));
			closedResolve();
		});

		ws.on("error", (error) => {
			if (!settled) {
				settled = true;
				rejectConnect(error instanceof Error ? error : new Error(String(error)));
			}
		});

		const handshakeTimer = setTimeout(() => {
			if (settled) return;
			settled = true;
			ws.terminate();
			rejectConnect(new Error("worker handshake timed out"));
		}, handshakeTimeoutMs);
		ws.once("open", () => {
			// The timer covers a peer that accepts TCP but never greets.
			ws.once("close", () => clearTimeout(handshakeTimer));
		});
		ws.once("close", () => clearTimeout(handshakeTimer));

		// A registration socket peeks its first frame and hands the hello over;
		// validate and settle the same way an in-band handshake does.
		const seeded = options.hello;

		const worker: RemoteWorker = {
			get registration(): WorkerRegistration {
				// `hello` is assigned before `resolveConnect`, so a caller that
				// holds the worker always sees it.
				return (hello as WorkerHello).registration;
			},
			get hello(): WorkerHello {
				return hello as WorkerHello;
			},
			closed,
			onUnavailable: (listener) => {
				unavailableListeners.add(listener);
				return () => unavailableListeners.delete(listener);
			},

			observeSession: async (
				address: SessionAddress,
				observeOptions: ObserveSessionOptions,
			): Promise<ObservedSession> => {
				const observation = randomUUID();
				observations.set(observation, { sink: observeOptions.sink, address });
				try {
					const target = await request<SessionTarget>({
						kind: "observeSession",
						address,
						cursor: observeOptions.cursor ?? null,
						observation,
					});
					return { target, observation: observationOf(observation, target) };
				} catch (error) {
					observations.delete(observation);
					throw error;
				}
			},

			createSession: async (projectId, createOptions): Promise<ObservedSession> => {
				const observation = randomUUID();
				observations.set(observation, { sink: createOptions.sink, address: null });
				try {
					const target = await request<SessionTarget>({
						kind: "createSession",
						projectId,
						observation,
						options: {
							text: createOptions.text,
							images: createOptions.images as unknown as JsonValue,
							model: createOptions.model,
							thinkingLevel: createOptions.thinkingLevel,
						},
					});
					// The created Session's address is only known now.
					observations.set(observation, { sink: createOptions.sink, address: { projectId, stem: target.stem } });
					return { target, observation: observationOf(observation, target) };
				} catch (error) {
					observations.delete(observation);
					throw error;
				}
			},

			closeSession: (address) => request<void>({ kind: "closeSession", address }),
			archiveSession: (address) => request<void>({ kind: "archiveSession", address }),

			prompt: (target, text, images, model, thinkingLevel) =>
				request<void>({
					kind: "prompt",
					target,
					text,
					images: images as unknown as JsonValue,
					model,
					thinkingLevel,
				}),
			abort: (target) => request<void>({ kind: "abort", target }),
			discardSteer: (target) => request<void>({ kind: "discardSteer", target }),
			renameSession: (target, name) => request<void>({ kind: "renameSession", target, name }),
			setLabel: (target, entryId, label) => request<void>({ kind: "setLabel", target, entryId, label }),
			navigate: (target, entryId) => request<void>({ kind: "navigate", target, entryId }),
			recoverTurn: async (target) => request<"retry" | "continue">({ kind: "recoverTurn", target }),

			listSessions: (projectId, max, cursor) =>
				request<SessionPage>({ kind: "listSessions", projectId, max, cursor: cursor ?? null }),
			listActiveSessions: () => request<SessionInfo[]>({ kind: "listActiveSessions" }),

			info: () => request<WorkerInfo>({ kind: "info" }),
			setPinnedModels: (models) => request<void>({ kind: "setPinnedModels", models }),
			listFiles: (prefix, projectId) => request({ kind: "listFiles", prefix, projectId }),
			readFile: (path, state) => request({ kind: "readFile", path, state }),
			listDirectory: (path, state) => request({ kind: "listDirectory", path, state }),
			gitShow: (commit, cwd) => request({ kind: "gitShow", commit, cwd }),
			gitBase: (directory, commit) => request({ kind: "gitBase", directory, commit }),
			gitDiff: (directory, oldState, newState) => request({ kind: "gitDiff", directory, oldState, newState }),

			onEvent: (listener) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},

			closeLink: () => {
				if (heartbeat !== null) clearInterval(heartbeat);
				heartbeat = null;
				observations.clear();
				try {
					if (ws.readyState === WebSocket.OPEN) ws.close();
					else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
					// CLOSING: a close handshake is already in flight. Terminating
					// here would abort it and strip the close code the peer needs —
					// a refused registration reads its verdict from that code, so the
					// handshake must be allowed to finish.
				} catch {
					// Already gone.
				}
			},

			dispose: async () => {
				try {
					await request<void>({ kind: "shutdown" });
				} catch {
					// An already-dead link is not an error for the caller that wanted
					// it gone.
				}
				if (heartbeat !== null) clearInterval(heartbeat);
				heartbeat = null;
				observations.clear();
				try {
					// Graceful close only on a live socket. After a terminal
					// withdrawal (`unavailable`, heartbeat loss) the socket is already
					// being destroyed, and `close()` would arm ws's close timer and
					// keep the process alive waiting for a handshake that cannot finish.
					if (ws.readyState === WebSocket.OPEN) ws.close();
					else ws.terminate();
				} catch {
					// see above
				}
			},
		};

		function observationOf(id: string, target: SessionTarget): WorkerObservation {
			return {
				id,
				target,
				pull: (requests: readonly PullRequestItem[]) =>
					request<WorkerPulledValue[]>({ kind: "pull", observation: id, requests }),
				release: async () => {
					if (!observations.delete(id)) return;
					try {
						await request<void>({ kind: "releaseObservation", observation: id });
					} catch {
						// The link is gone; the server side released it with the socket.
					}
				},
			};
		}

		// Seeded after `worker` exists: `acceptHello` hands the settled link to the
		// caller through `resolveConnect`.
		if (seeded !== undefined) acceptHello(seeded);
	});
}

/** Convenience for the Daemon's typed verbs: images travel as opaque JSON. */
export type WorkerImages = ImageContent[];
