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

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createManager } from "./manager.ts";
import { buildProjects } from "./projects.ts";
import { DEFAULT_IDLE_GC_MS, DEFAULT_UNFLUSHED_IDLE_GC_MS } from "./session-actor.ts";
import { type LocalWorker, startLocalWorker } from "./worker-local.ts";
import { createWorkerSocketServer, type WorkerSocketServer } from "./worker-server.ts";

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
