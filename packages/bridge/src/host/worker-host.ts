// ============================================================================
// Worker host — how a Daemon obtains its Worker.
//
// The Daemon routes through `WorkerService` only. This module is the deployment
// seam that produces one: in-process (tests, single-binary default), connected
// to an already-running Worker, or spawned as a child process.
//
// Registration is where Project names are claimed. Whichever mode produced the
// Worker, the Daemon validates the advertised set before routing anything:
// duplicate ids, a collision with a reserved surface name (a web asset root), or
// an empty id reject the whole registration and close the link. All-or-nothing
// claiming is what keeps `/<projectId>` unambiguous.
// ============================================================================

import { type ChildProcess, spawn } from "node:child_process";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createManager } from "./manager.ts";
import type { ProjectConfig } from "./projects.ts";
import { DEFAULT_IDLE_GC_MS, DEFAULT_UNFLUSHED_IDLE_GC_MS } from "./session-actor.ts";
import { connectWorker, type RemoteWorker, WorkerRegistrationError } from "./worker-client.ts";
import type { WorkerEvent, WorkerInfo, WorkerService } from "./worker-contract.ts";
import type { LocalManagerFactory } from "./worker-local.ts";
import { startLocalWorker } from "./worker-local.ts";

export type WorkerHostMode =
	/** The Worker runs in the Daemon's process (default, tests). */
	| { readonly kind: "in-process"; readonly projects: ProjectConfig[] }
	/** A Worker already running somewhere reachable. */
	| { readonly kind: "connect"; readonly endpoint: string }
	/** Start a Worker as a child process of this one. */
	| {
			readonly kind: "spawn";
			readonly allow: string[];
			readonly socketPath: string;
			/** The script to run as the Worker. Defaults to this process's CLI
			 * entry (`process.argv[1]`), so a single-binary install needs no
			 * second entry point. An embedder or a test that has no CLI argv
			 * supplies one. */
			readonly workerEntry?: string;
	  };

export interface WorkerHostOptions {
	readonly mode: WorkerHostMode;
	readonly agentDir: string;
	/** Names the serving surface owns; a Project may not claim one. */
	readonly reservedProjectIds: Iterable<string>;
	readonly modelRuntime?: ModelRuntime;
	readonly managerFactory?: LocalManagerFactory;
	readonly idleGcMs?: number;
	readonly unflushedIdleGcMs?: number;
	readonly onEvent: (event: WorkerEvent) => void;
	readonly onUnavailable: (reason: string) => void;
	/** Spawn mode: how long to wait for the child to greet. */
	readonly spawnTimeoutMs?: number;
}

export interface WorkerHost {
	readonly service: WorkerService;
	/** The environment the handshake reported. */
	readonly info: WorkerInfo;
	/** The endpoint a remote Worker serves (diagnostics). */
	readonly endpoint: string | null;
	dispose(): Promise<void>;
}

/** Reject a registration whose Projects the Daemon cannot route unambiguously. */
function validateRegistration(info: WorkerInfo, reserved: Iterable<string>): void {
	const reservedIds = new Set(reserved);
	const seen = new Set<string>();
	for (const project of info.projects) {
		if (typeof project.id !== "string" || project.id === "") {
			throw new Error("worker registration rejected: empty project id");
		}
		if (reservedIds.has(project.id)) {
			throw new Error(`worker registration rejected: project id "${project.id}" collides with a reserved name`);
		}
		if (seen.has(project.id)) {
			throw new Error(`worker registration rejected: duplicate project id "${project.id}"`);
		}
		seen.add(project.id);
	}
}

export async function createWorkerHost(options: WorkerHostOptions): Promise<WorkerHost> {
	const reserved = [...options.reservedProjectIds];
	const accept = (info: WorkerInfo): void => validateRegistration(info, reserved);

	if (options.mode.kind === "in-process") {
		const worker = await startLocalWorker({
			projects: options.mode.projects,
			agentDir: options.agentDir,
			managerFactory: options.managerFactory ?? createManager,
			idleGcMs: options.idleGcMs ?? DEFAULT_IDLE_GC_MS,
			unflushedIdleGcMs: options.unflushedIdleGcMs ?? DEFAULT_UNFLUSHED_IDLE_GC_MS,
			...(options.modelRuntime !== undefined ? { modelRuntime: options.modelRuntime } : {}),
		});
		const info = await worker.info();
		accept(info);
		worker.onEvent(options.onEvent);
		return {
			service: worker,
			info,
			endpoint: null,
			dispose: () => worker.dispose(),
		};
	}

	if (options.mode.kind === "connect") {
		return connectRemote(options, options.mode.endpoint, null);
	}

	const socketPath = options.mode.socketPath;
	const child = spawnWorkerProcess(options, options.mode.allow, socketPath, options.mode.workerEntry);
	try {
		return await connectRemote(options, `unix:${socketPath}`, child, options.spawnTimeoutMs ?? 20_000);
	} catch (error) {
		child.kill("SIGTERM");
		throw error;
	}
}

async function connectRemote(
	options: WorkerHostOptions,
	endpoint: string,
	child: ChildProcess | null,
	timeoutMs = 10_000,
): Promise<WorkerHost> {
	const reserved = [...options.reservedProjectIds];
	let remote: RemoteWorker | null = null;
	let lastError: Error | null = null;
	const deadline = Date.now() + timeoutMs;

	// A spawned Worker needs a moment before its socket exists; a connect-mode
	// peer is expected to be up, so one attempt is enough there.
	while (remote === null) {
		try {
			remote = await connectWorker({
				endpoint,
				accept: (hello) => validateRegistration(hello.info, reserved),
				handshakeTimeoutMs: Math.max(1_000, deadline - Date.now()),
			});
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			// A refused registration is terminal: the same handshake cannot pass.
			if (lastError instanceof WorkerRegistrationError) throw lastError;
			if (child === null || Date.now() >= deadline) throw lastError;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	const worker = remote;
	worker.onEvent(options.onEvent);
	worker.onUnavailable((reason) => options.onUnavailable(reason));
	void worker.closed.then(() => options.onUnavailable("worker link closed"));

	return {
		service: worker,
		info: worker.hello.info,
		endpoint,
		dispose: async () => {
			await worker.dispose();
			if (child !== null && child.exitCode === null) {
				child.kill("SIGTERM");
			}
		},
	};
}

/** Start the Worker as a child of this process, serving on `socketPath`.
 *
 * The child runs this package's CLI with `--worker-serve`, so a single-binary
 * install needs no second entry point. An embedding host with no CLI argv cannot
 * spawn and must use connect mode instead. */
function spawnWorkerProcess(
	options: WorkerHostOptions,
	allow: string[],
	socketPath: string,
	workerEntry: string | undefined,
): ChildProcess {
	const entry = workerEntry ?? process.argv[1];
	if (entry === undefined) {
		throw new Error("cannot spawn a worker: no CLI entry point (use connect mode)");
	}
	const args = [
		entry,
		"--worker-serve",
		"--socket",
		socketPath,
		"--agent-dir",
		options.agentDir,
		...allow.flatMap((value) => ["--allow", value]),
		...[...options.reservedProjectIds].flatMap((id) => ["--reserved-id", id]),
	];
	return spawn(process.execPath, args, {
		// Keep the child's diagnostics visible; its stdout is not protocol.
		stdio: ["ignore", "inherit", "inherit"],
		env: process.env,
	});
}
