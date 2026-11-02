// ============================================================================
// Worker process — the execution half as its own OS process.
//
// It owns Project configuration, Session storage, the Activation registry, pi
// runtimes, and the repository surface; it serves them over one socket and owns
// no browser protocol. The Daemon that connects to it learns its Projects from
// the handshake, so a Worker can be started independently and survive a Daemon
// restart.
//
// Exclusion is acquired before the socket is served (see `storage-lock.ts`): a
// directory another live Worker holds fails the start rather than being written
// unsynchronized.
// ============================================================================

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WebSocket } from "ws";
import { openWorkerSocket } from "./daemon-socket.ts";
import { createManager } from "./manager.ts";
import { buildProjects } from "./projects.ts";
import { DEFAULT_IDLE_GC_MS, DEFAULT_UNFLUSHED_IDLE_GC_MS } from "./session-actor.ts";
import type { WorkerInfo } from "./worker-contract.ts";
import { type LocalManagerFactory, type LocalWorker, startLocalWorker } from "./worker-local.ts";
import { WORKER_REJECTED_CLOSE_CODE } from "./worker-protocol.ts";
import { createWorkerSocketServer, serveWorkerConnection, type WorkerSocketServer } from "./worker-server.ts";

export interface WorkerProcessOptions {
	/** `--allow` entries: `<path>` or `<id>=<path>`. */
	readonly allow: string[];
	readonly agentDir?: string;
	/** Listen here (a Unix socket path). */
	readonly socketPath: string;
	/** Project ids the serving surface has reserved (web asset roots). */
	readonly reservedProjectIds?: string[];
	readonly idleGcMs?: number;
	readonly unflushedIdleGcMs?: number;
}

export interface WorkerProcess {
	readonly endpoint: string;
	readonly worker: LocalWorker;
	dispose(): Promise<void>;
}

/** Start the Worker: build Projects, claim their directories, then serve. A
 * Project-set failure or a lost exclusion claim rejects before any socket
 * exists, so a caller never observes a partially served Worker. */
export async function runWorkerProcess(options: WorkerProcessOptions): Promise<WorkerProcess> {
	const agentDir = options.agentDir ?? getAgentDir();
	const projects = buildProjects(options.allow, agentDir, options.reservedProjectIds);
	const worker = await startLocalWorker({
		projects,
		agentDir,
		managerFactory: createManager,
		idleGcMs: options.idleGcMs ?? DEFAULT_IDLE_GC_MS,
		unflushedIdleGcMs: options.unflushedIdleGcMs ?? DEFAULT_UNFLUSHED_IDLE_GC_MS,
	});
	const server: WorkerSocketServer = await createWorkerSocketServer({
		service: worker,
		socketPath: options.socketPath,
	});

	let disposed: Promise<void> | null = null;
	return {
		endpoint: server.endpoint,
		worker,
		dispose: () => {
			if (disposed !== null) return disposed;
			disposed = (async () => {
				await server.close();
				await worker.dispose();
			})();
			return disposed;
		},
	};
}

// ============================================================================
// Worker client — the same execution half, dialed into a running Daemon.
// ============================================================================

export interface WorkerClientOptions {
	/** `--allow` entries: `<path>` or `<id>=<path>`. */
	readonly allow: string[];
	readonly agentDir?: string;
	/** The daemon to register with: `unix:/path` or a `ws://` URL. */
	readonly endpoint: string;
	readonly idleGcMs?: number;
	readonly unflushedIdleGcMs?: number;
	/** Bounded backoff after a lost link. */
	readonly retryMinMs?: number;
	readonly retryMaxMs?: number;
	readonly onLinkLost?: (error: Error) => void;
	readonly onLinkUp?: (info: WorkerInfo) => void;
	/** Injectable Manager factory and model runtime (test seam). */
	readonly managerFactory?: LocalManagerFactory;
	readonly modelRuntime?: ModelRuntime;
}

export interface WorkerClientProcess {
	readonly endpoint: string;
	readonly worker: LocalWorker;
	/** Resolves when this process stops serving: a dispose, or a terminal
	 * registration refusal. */
	readonly closed: Promise<void>;
	dispose(): Promise<void>;
}

const DEFAULT_RETRY_MIN_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5_000;

function retryDelay(attempt: number, minMs: number, maxMs: number): number {
	return Math.min(minMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

/**
 * Serve this process's Projects to a Daemon that is already running.
 *
 * The first registration must succeed: an explicit worker launch has no daemon
 * to wait for, so a failure is reported instead of retried. After that a lost
 * link is not a crash — the Worker keeps its runtimes (an admitted turn must
 * survive a Daemon restart) and reconnects with bounded backoff, letting clients
 * rebuild their observations from a fresh replace.
 *
 * A registration the Daemon refuses arrives as the rejected close code and is
 * terminal: the same handshake cannot pass on a retry, so the process stops
 * instead of looping.
 */
export async function runWorkerClient(options: WorkerClientOptions): Promise<WorkerClientProcess> {
	const agentDir = options.agentDir ?? getAgentDir();
	const projects = buildProjects(options.allow, agentDir, undefined);
	const worker = await startLocalWorker({
		projects,
		agentDir,
		managerFactory: options.managerFactory ?? createManager,
		idleGcMs: options.idleGcMs ?? DEFAULT_IDLE_GC_MS,
		unflushedIdleGcMs: options.unflushedIdleGcMs ?? DEFAULT_UNFLUSHED_IDLE_GC_MS,
		...(options.modelRuntime !== undefined ? { modelRuntime: options.modelRuntime } : {}),
	});

	const retryMinMs = options.retryMinMs ?? DEFAULT_RETRY_MIN_MS;
	const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
	let socket: WebSocket | null = null;
	let stopping = false;
	let resolveClosed: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	const connectOnce = async (): Promise<{ ws: WebSocket; lost: Promise<{ code: number; reason: string }> }> => {
		const ws = await openWorkerSocket(options.endpoint);
		// The close listener is installed before the handshake so a refusal is
		// observed even when it arrives immediately after `hello`.
		const lost = new Promise<{ code: number; reason: string }>((resolve) => {
			ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
		});
		socket = ws;
		await serveWorkerConnection(ws, worker);
		worker.setLink("up");
		return { ws, lost };
	};

	let first: { ws: WebSocket; lost: Promise<{ code: number; reason: string }> };
	try {
		first = await connectOnce();
	} catch (error) {
		await worker.dispose().catch(() => {});
		throw error;
	}
	options.onLinkUp?.(await worker.info());

	void (async () => {
		let current = first;
		let attempt = 0;
		let terminal: Error | null = null;
		for (;;) {
			const outcome = await current.lost;
			socket = null;
			if (stopping) break;
			worker.setLink("down");
			if (outcome.code === WORKER_REJECTED_CLOSE_CODE) {
				terminal = new Error(outcome.reason === "" ? "worker registration refused" : outcome.reason);
				break;
			}
			options.onLinkLost?.(
				new Error(outcome.reason === "" ? "worker link closed" : `worker link lost: ${outcome.reason}`),
			);

			let next: { ws: WebSocket; lost: Promise<{ code: number; reason: string }> } | null = null;
			while (!stopping) {
				attempt += 1;
				await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, retryMinMs, retryMaxMs)));
				if (stopping) break;
				try {
					next = await connectOnce();
					break;
				} catch {
					// The daemon is not back yet; keep the runtimes and retry.
				}
			}
			if (next === null) break;
			current = next;
			attempt = 0;
			options.onLinkUp?.(await worker.info());
		}
		if (terminal !== null) await worker.dispose().catch(() => {});
		resolveClosed();
	})();

	let disposed: Promise<void> | null = null;
	return {
		endpoint: options.endpoint,
		worker,
		closed,
		dispose: () => {
			if (disposed !== null) return disposed;
			disposed = (async () => {
				stopping = true;
				socket?.terminate();
				await closed.catch(() => {});
				await worker.dispose();
			})();
			return disposed;
		},
	};
}
