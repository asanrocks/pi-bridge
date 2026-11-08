// ============================================================================
// Worker server — serves one `WorkerService` over a socket.
//
// The server owns one connection's observation table: every observation the
// Daemon allocates is registered here, its frames are forwarded as pushes tagged
// with that id, and releasing it (or losing the socket) ends it. The service
// itself knows nothing about sockets, so the same `LocalWorker` runs in-process
// for tests and behind this server for a separate process.
//
// A dropped socket ends every observation it owned. The Worker keeps running —
// losing a Daemon is not a reason to kill in-flight turns — and a reconnecting
// Daemon re-observes. Only `shutdown` disposes the service.
//
// Ordering: `hello` is sent before the message listener is installed, so a
// Daemon that waits for it (the client does) can never have an early request
// dropped.
// ============================================================================

import { unlink } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { JsonValue } from "../core/index.ts";
import type {
	ObservedSession,
	WorkerObservation,
	WorkerObservationFrame,
	WorkerObservationSink,
	WorkerService,
} from "./worker-contract.ts";
import {
	parseWorkerFrame,
	WORKER_HEARTBEAT_INTERVAL_MS,
	WORKER_HEARTBEAT_TIMEOUT_MS,
	WORKER_PROTOCOL_VERSION,
	type WorkerReply,
	type WorkerRequest,
} from "./worker-protocol.ts";

interface ConnectionState {
	/** Installed observations, released when the connection ends. */
	observations: Map<string, WorkerObservation>;
	/** In-flight acquisitions: a socket that closes while one is awaiting must
	 * still release the observation it produces, or its actor capability would
	 * pin the Activation with nothing left to release it. */
	acquiring: Map<string, { cancelled: boolean }>;
	/** Admitted requests, drained before `shutdown` disposes the service. */
	inflight: Set<Promise<void>>;
	unsubscribeEvents: () => void;
	/** Request admission. Cleared synchronously when shutdown begins, so no new
	 * work is admitted while the drain runs. */
	accepting: boolean;
	/** The socket is gone: sends stop and every observation is released. */
	closed: boolean;
	/** Link liveness from this end (see the heartbeat block below). */
	heartbeat: ReturnType<typeof setInterval> | null;
	lastPong: number;
}

export interface ServeWorkerConnectionOptions {
	/** How often this end pings an idle link, and how long silence may last.
	 * Defaults: the protocol's heartbeat constants. Injectable for tests. */
	heartbeatIntervalMs?: number;
	heartbeatTimeoutMs?: number;
}

/** Serve one socket. Resolves once the handshake is out and the request loop is
 * installed, so a caller can close the socket deterministically afterwards. */
export async function serveWorkerConnection(
	ws: WebSocket,
	service: WorkerService,
	options: ServeWorkerConnectionOptions = {},
): Promise<void> {
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
	const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? WORKER_HEARTBEAT_TIMEOUT_MS;
	const state: ConnectionState = {
		observations: new Map(),
		acquiring: new Map(),
		inflight: new Set(),
		unsubscribeEvents: () => {},
		accepting: true,
		closed: false,
		heartbeat: null,
		lastPong: 0,
	};

	const send = (frame: unknown): void => {
		if (state.closed) return;
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			// The socket died; the close handler releases the observations.
		}
	};

	const replyOk = (id: string, result: JsonValue): void => send({ id, ok: true, result } satisfies WorkerReply);
	const replyError = (id: string, error: unknown): void =>
		send({
			id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		} satisfies WorkerReply);

	const sinkFor =
		(observation: string): WorkerObservationSink =>
		(frame: WorkerObservationFrame) => {
			// A terminal frame ends the observation on both sides; the Worker has
			// already released it.
			if (frame.kind === "closed") state.observations.delete(observation);
			send({ kind: "observation", observation, frame });
		};

	const releaseObservation = async (observation: string): Promise<void> => {
		const held = state.observations.get(observation);
		if (held === undefined) return;
		state.observations.delete(observation);
		await held.release();
	};

	async function endConnection(): Promise<void> {
		// Admission stops before anything is torn down: a request arriving during
		// the drain must not create work nothing would release.
		state.accepting = false;
		if (state.closed) return;
		state.closed = true;
		state.unsubscribeEvents();
		// An acquisition that is still awaiting cannot be released here; it marks
		// itself cancelled and releases whatever it produces when it completes.
		for (const pending of state.acquiring.values()) pending.cancelled = true;
		const held = [...state.observations.values()];
		state.observations.clear();
		await Promise.allSettled(held.map((observation) => observation.release()));
	}

	/** Install one acquired observation, or release it when the socket went away
	 * while the acquisition was in flight. */
	async function installAcquired(
		observationId: string,
		pending: { cancelled: boolean },
		observed: ObservedSession,
	): Promise<boolean> {
		state.acquiring.delete(observationId);
		if (pending.cancelled || state.closed) {
			// Nothing would ever release this observation: the connection it
			// belonged to is gone.
			await observed.observation.release().catch(() => {});
			return false;
		}
		state.observations.set(observationId, observed.observation);
		return true;
	}

	async function dispatch(request: WorkerRequest): Promise<void> {
		switch (request.kind) {
			case "observeSession": {
				// The acquisition is registered before the await so a close during it
				// can mark it cancelled (see `installAcquired`).
				const pending = { cancelled: false };
				state.acquiring.set(request.observation, pending);
				let observed: ObservedSession;
				try {
					// The initial sync is emitted to the sink synchronously inside
					// observeSession, so it reaches the Daemon before this reply — the
					// ordering the contract promises.
					observed = await service.observeSession(request.address, {
						cursor: request.cursor,
						sink: sinkFor(request.observation),
					});
				} catch (error) {
					state.acquiring.delete(request.observation);
					throw error;
				}
				if (!(await installAcquired(request.observation, pending, observed))) return;
				replyOk(request.id, observed.target as unknown as JsonValue);
				return;
			}
			case "createSession": {
				const pending = { cancelled: false };
				state.acquiring.set(request.observation, pending);
				let observed: ObservedSession;
				try {
					observed = await service.createSession(request.projectId, {
						text: request.options.text,
						images: request.options.images as never,
						model: request.options.model,
						thinkingLevel: request.options.thinkingLevel,
						sink: sinkFor(request.observation),
					});
				} catch (error) {
					state.acquiring.delete(request.observation);
					throw error;
				}
				if (!(await installAcquired(request.observation, pending, observed))) return;
				replyOk(request.id, observed.target as unknown as JsonValue);
				return;
			}
			case "releaseObservation":
				await releaseObservation(request.observation);
				replyOk(request.id, null);
				return;
			case "pull": {
				const held = state.observations.get(request.observation);
				if (held === undefined) throw new Error("observation is not active");
				replyOk(request.id, (await held.pull(request.requests)) as unknown as JsonValue);
				return;
			}
			case "prompt":
				await service.prompt(
					request.target,
					request.text,
					request.images as never,
					request.model,
					request.thinkingLevel,
				);
				replyOk(request.id, null);
				return;
			case "abort":
				await service.abort(request.target);
				replyOk(request.id, null);
				return;
			case "discardSteer":
				await service.discardSteer(request.target);
				replyOk(request.id, null);
				return;
			case "renameSession":
				await service.renameSession(request.target, request.name);
				replyOk(request.id, null);
				return;
			case "setLabel":
				await service.setLabel(request.target, request.entryId, request.label);
				replyOk(request.id, null);
				return;
			case "navigate":
				await service.navigate(request.target, request.entryId);
				replyOk(request.id, null);
				return;
			case "recoverTurn":
				replyOk(request.id, await service.recoverTurn(request.target));
				return;
			case "closeSession":
				await service.closeSession(request.address);
				replyOk(request.id, null);
				return;
			case "trashSession":
				await service.trashSession(request.address);
				replyOk(request.id, null);
				return;
			case "listSessions":
				replyOk(
					request.id,
					(await service.listSessions(
						request.projectId,
						request.max,
						request.cursor ?? null,
					)) as unknown as JsonValue,
				);
				return;
			case "listQueue":
				replyOk(request.id, (await service.listQueue()) as unknown as JsonValue);
				return;
			case "setSessionLocation":
				await service.setSessionLocation(request.address, request.location);
				replyOk(request.id, null);
				return;
			case "info":
				replyOk(request.id, (await service.info()) as unknown as JsonValue);
				return;
			case "setPinnedModels":
				await service.setPinnedModels(request.models);
				replyOk(request.id, null);
				return;
			case "listFiles":
				replyOk(request.id, (await service.listFiles(request.prefix, request.projectId)) as unknown as JsonValue);
				return;
			case "readFile":
				replyOk(request.id, (await service.readFile(request.path, request.state)) as unknown as JsonValue);
				return;
			case "listDirectory":
				replyOk(request.id, (await service.listDirectory(request.path, request.state)) as unknown as JsonValue);
				return;
			case "gitShow":
				replyOk(request.id, (await service.gitShow(request.commit, request.cwd)) as unknown as JsonValue);
				return;
			case "gitBase":
				replyOk(request.id, (await service.gitBase(request.directory, request.commit)) as unknown as JsonValue);
				return;
			case "gitDiff":
				replyOk(
					request.id,
					(await service.gitDiff(request.directory, request.oldState, request.newState)) as unknown as JsonValue,
				);
				return;
			default:
				// An unknown kind is a peer/version mismatch. Answering it is what
				// keeps the link usable: a request with no reply would leave the
				// caller's promise pending for the life of the process.
				throw new Error(`unknown worker request: ${(request as { kind: string }).kind}`);
		}
	}

	// Handshake first, then the request loop (see the ordering note above). A
	// Worker that cannot describe itself refuses the link instead of accepting
	// requests it could not serve.
	let info: Awaited<ReturnType<WorkerService["info"]>>;
	try {
		info = await service.info();
	} catch (error) {
		state.closed = true;
		ws.close(1011, error instanceof Error ? error.message : "worker init failed");
		return;
	}
	send({
		kind: "hello",
		protocol: WORKER_PROTOCOL_VERSION,
		registration: service.registration,
		info,
	});
	state.unsubscribeEvents = service.onEvent((event) => {
		// A terminal Worker report is not a state-change event: it is the
		// dedicated one-shot frame the Daemon withdraws the registration on. It is
		// terminal for this connection too — the registration it describes can
		// serve nothing more, so the stream and its observations end with it.
		if (event.kind === "unavailable") {
			send({ kind: "unavailable", reason: event.reason });
			void endConnection();
			return;
		}
		send({ kind: "event", event });
	});

	// Link liveness from this end too: the peer's client pings, but a peer that
	// went silent must not pin this connection's registrations forever — over
	// TCP (a remote daemon) a half-open link is otherwise noticed only when a
	// write fails, and an idle link never writes. A silent peer takes the same
	// terminal path a socket error does; the socket is terminated afterwards
	// because a peer that ignores pings will not complete a close handshake.
	state.lastPong = Date.now();
	ws.on("pong", () => {
		state.lastPong = Date.now();
	});
	state.heartbeat = setInterval(() => {
		if (Date.now() - state.lastPong > heartbeatTimeoutMs) {
			void endConnection().finally(() => ws.terminate());
			return;
		}
		try {
			ws.ping();
		} catch {
			// The close handler ends the connection.
		}
	}, heartbeatIntervalMs);

	ws.on("message", (data) => {
		const frame = parseWorkerFrame(data.toString());
		if (frame === null || !("id" in frame)) return;
		const request = frame as WorkerRequest;
		// No admission once the connection is ending (a close, a terminal
		// withdrawal, or a shutdown drain): a late request would create work
		// nothing would own.
		if (!state.accepting || state.closed) return;

		if (request.kind === "shutdown") {
			// Shutdown is not ordinary admitted work: it stops admission, drains
			// everything already admitted, disposes the service, and only then
			// replies. The reply means the Worker finished — runtimes disposed,
			// exclusion claims released — not merely that it agreed to stop; a
			// spawned parent kills the child on that reply, so it must not outrun
			// the drain. (The reply precedes `endConnection`, which seals the
			// socket for further sends.)
			state.accepting = false;
			void (async () => {
				await Promise.allSettled([...state.inflight]);
				await service.dispose().catch(() => {
					// A failed disposal still ends the link; the reply must not hang
					// a caller that wanted the Worker gone.
				});
				replyOk(request.id, null);
				await endConnection();
			})();
			return;
		}

		const work = dispatch(request).catch((error) => replyError(request.id, error));
		state.inflight.add(work);
		void work.then(
			() => state.inflight.delete(work),
			() => state.inflight.delete(work),
		);
	});
	ws.on("close", () => {
		void endConnection();
	});
	ws.on("error", () => {
		void endConnection();
	});
}

export interface WorkerSocketServerOptions {
	readonly service: WorkerService;
	/** Listen on this Unix socket path (a Worker process) or on TCP. */
	readonly socketPath?: string;
	readonly port?: number;
	readonly host?: string;
}

export interface WorkerSocketServer {
	/** Where to connect: a `unix:` path or a `ws://` URL. */
	readonly endpoint: string;
	close(): Promise<void>;
}

/** Serve a Worker on its own listener. */
export async function createWorkerSocketServer(options: WorkerSocketServerOptions): Promise<WorkerSocketServer> {
	const wss = new WebSocketServer({ noServer: true });
	const server: HttpServer = createServer();

	server.on("upgrade", (request, socket, head) => {
		wss.handleUpgrade(request, socket, head, (ws) => {
			void serveWorkerConnection(ws, options.service);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		if (options.socketPath !== undefined) server.listen(options.socketPath, () => resolve());
		else server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
	});

	const endpoint =
		options.socketPath !== undefined
			? `unix:${options.socketPath}`
			: `ws://${options.host ?? "127.0.0.1"}:${(server.address() as AddressInfo).port}`;

	return {
		endpoint,
		close: async () => {
			// Terminate rather than close: a peer mid-handshake may never complete
			// the closing handshake, and `server.close()` would then wait for a
			// connection that can never end.
			for (const ws of wss.clients) ws.terminate();
			wss.close();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			// A Unix socket path outlives the listener; leaving the file behind
			// makes the next start fail with EADDRINUSE instead of binding.
			if (options.socketPath !== undefined) await unlink(options.socketPath).catch(() => {});
		},
	};
}
