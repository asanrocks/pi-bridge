// Worker lifecycle guarantees (commits 5–9 of the Worker split).
//
// Each case pins a failure mode that the transport review found: an acquisition
// that outlives its socket, a terminal withdrawal that leaves callers waiting, a
// shutdown that answers before admitted work finished, and a standalone Worker
// that never entered pi-core's offline mode.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { connectWorker } from "../../src/host/worker-client.ts";
import type {
	ObservedSession,
	SessionAddress,
	SessionTarget,
	WorkerEvent,
	WorkerInfo,
	WorkerObservation,
	WorkerRegistration,
	WorkerService,
} from "../../src/host/worker-contract.ts";
import type { LocalManagerFactory } from "../../src/host/worker-local.ts";
import { startLocalWorker } from "../../src/host/worker-local.ts";
import { createWorkerSocketServer } from "../../src/host/worker-server.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const registration: WorkerRegistration = { id: "reg", incarnation: "inc", generation: 1 };

function info(): WorkerInfo {
	return {
		projects: [{ id: "alpha", cwd: "/tmp/alpha", defaultModel: null, defaultThinkingLevel: null }],
		models: [],
		pinnedModels: [],
		visibleModels: [],
		thinkingLevels: ["off"],
	};
}

/** A Worker whose behavior each test scripts, and which records what happened. */
interface FakeWorker extends WorkerService {
	readonly order: string[];
	readonly released: string[];
	emit(event: WorkerEvent): void;
	/** Hold the next `observeSession` until `openObserve()`. */
	gateObserve(): void;
	openObserve(): void;
	/** `listSessions` always waits; this releases it. */
	openList(): void;
}

function fakeWorker(): FakeWorker {
	const order: string[] = [];
	const released: string[] = [];
	const listeners = new Set<(event: WorkerEvent) => void>();
	// `observeSession` is gated only when a test asks for it (the disconnect case);
	// `listSessions` always waits so a test can observe the admission window.
	let observeGate: Promise<void> | null = null;
	let openObserve: () => void = () => {};
	const listGate: { promise: Promise<void>; open: () => void } = (() => {
		let open: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { promise, open };
	})();

	const target = {
		projectId: "alpha",
		stem: "s",
		sessionId: "s",
		cwd: "/tmp/alpha",
		worker: registration,
		activation: 1,
	};
	const observationOf = (id: string): WorkerObservation => ({
		id,
		target: target as SessionTarget,
		pull: async () => [],
		release: async () => {
			released.push(id);
		},
	});
	const notImplemented = (): never => {
		throw new Error("not implemented");
	};

	return {
		registration,
		order,
		released,
		gateObserve: () => {
			observeGate = new Promise<void>((resolve) => {
				openObserve = resolve;
			});
		},
		openObserve: () => openObserve(),
		openList: () => listGate.open(),
		info: async () => info(),
		observeSession: async (address: SessionAddress): Promise<ObservedSession> => {
			order.push("observe:start");
			if (observeGate !== null) await observeGate;
			order.push("observe:done");
			return {
				target: { ...target, stem: address.stem } as SessionTarget,
				observation: observationOf("obs-acquired"),
			};
		},
		createSession: notImplemented,
		closeSession: notImplemented,
		trashSession: notImplemented,
		prompt: notImplemented,
		abort: notImplemented,
		discardSteer: notImplemented,
		compact: notImplemented,
		renameSession: notImplemented,
		setLabel: notImplemented,
		navigate: notImplemented,
		recoverTurn: notImplemented,
		listSessions: async () => {
			order.push("list:start");
			await listGate.promise;
			order.push("list:done");
			return { sessions: [], hasMore: false };
		},
		listQueue: async () => ({ sessions: [], version: 0 }),
		setSessionLocation: async () => {},
		setPinnedModels: notImplemented,
		listFiles: notImplemented,
		readFile: notImplemented,
		listDirectory: notImplemented,
		gitShow: notImplemented,
		gitBase: notImplemented,
		gitDiff: notImplemented,
		onEvent: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		dispose: async () => {
			order.push("dispose");
		},
	} satisfies FakeWorker;
}

async function serve(service: WorkerService): Promise<string> {
	const server = await createWorkerSocketServer({ service });
	cleanups.push(() => server.close());
	return server.endpoint;
}

function wsUrl(endpoint: string): string {
	return endpoint;
}

async function openRaw(endpoint: string): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
	const ws = new WebSocket(wsUrl(endpoint));
	const frames: Array<Record<string, unknown>> = [];
	ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
	cleanups.push(() => ws.close());
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return { ws, frames };
}

function waitUntil(pred: () => boolean, label: string, timeout = 3_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const poll = setInterval(() => {
			if (pred()) {
				clearInterval(poll);
				resolve();
				return;
			}
			if (Date.now() - started > timeout) {
				clearInterval(poll);
				reject(new Error(`timed out waiting for ${label}`));
			}
		}, 5);
	});
}

describe("worker acquisition cancellation", () => {
	it("releases an observation whose socket closed while acquisition was in flight", async () => {
		const service = fakeWorker();
		service.gateObserve();
		const endpoint = await serve(service);
		const { ws } = await openRaw(endpoint);

		ws.send(
			JSON.stringify({
				id: "o1",
				kind: "observeSession",
				address: { projectId: "alpha", stem: "s" },
				cursor: null,
				observation: "obs-acquired",
			}),
		);
		await waitUntil(() => service.order.includes("observe:start"), "acquisition to start");

		// The browser's socket dies mid-acquisition: nothing would ever release
		// the observation this produces.
		ws.close();
		service.openObserve();

		await waitUntil(() => service.released.includes("obs-acquired"), "the observation to be released");
		expect(service.released).toContain("obs-acquired");
	});
});

describe("worker terminal withdrawal", () => {
	it("settles pending requests and ends observations when a Worker reports unavailable", async () => {
		const service = fakeWorker();
		const endpoint = await serve(service);
		const remote = await connectWorker({ endpoint });
		cleanups.push(() => remote.dispose());

		const frames: string[] = [];
		await remote.observeSession(
			{ projectId: "alpha", stem: "s" },
			{
				cursor: null,
				sink: (frame) => frames.push(frame.kind),
			},
		);

		// A request admitted before the push can never be answered after it.
		const pending = remote.listSessions("alpha");
		await waitUntil(() => service.order.includes("list:start"), "the request to be admitted");

		service.emit({ kind: "unavailable", reason: "storage lock lost" });

		await expect(pending).rejects.toThrow(/storage lock lost/);
		// The observation ends with the registration, so the Daemon learns its
		// stream is gone instead of holding an attachment that cannot progress.
		await waitUntil(() => frames.includes("closed"), "the observation's terminal frame");
		// Release the fake's blocked call so teardown cannot wait on it.
		service.openList();
	});
});

describe("worker shutdown drain", () => {
	it("drains admitted requests before replying, then disposes", async () => {
		const service = fakeWorker();
		const endpoint = await serve(service);
		const { ws, frames } = await openRaw(endpoint);
		await waitUntil(() => frames.some((frame) => frame.kind === "hello"), "the handshake");

		ws.send(JSON.stringify({ id: "slow", kind: "listSessions", projectId: "alpha" }));
		await waitUntil(() => service.order.includes("list:start"), "the request to be admitted");

		ws.send(JSON.stringify({ id: "stop", kind: "shutdown" }));
		service.openList();

		await waitUntil(() => frames.some((frame) => frame.id === "stop" && frame.ok === true), "the shutdown reply");
		// The reply means "finished", not "agreed to stop".
		expect(service.order).toContain("list:done");
		await waitUntil(() => service.order.includes("dispose"), "the service to be disposed");

		// Admission is closed: a request after shutdown begins is not dispatched.
		const before = service.order.filter((entry) => entry === "list:start").length;
		ws.send(JSON.stringify({ id: "late", kind: "listSessions", projectId: "alpha" }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(service.order.filter((entry) => entry === "list:start")).toHaveLength(before);
	});

	it("the shutdown reply arrives only after the service finished disposing", async () => {
		const service = fakeWorker();
		const endpoint = await serve(service);
		const { ws, frames } = await openRaw(endpoint);
		await waitUntil(() => frames.some((frame) => frame.kind === "hello"), "the handshake");

		ws.send(JSON.stringify({ id: "stop", kind: "shutdown" }));
		await waitUntil(() => frames.some((frame) => frame.id === "stop" && frame.ok === true), "the shutdown reply");

		// A spawned parent kills the child on this reply, so it must mean the
		// Worker finished — runtimes disposed, exclusion claims released — not
		// merely that it agreed to stop.
		expect(service.order).toContain("dispose");
	});
});

describe("worker offline mode", () => {
	it("establishes pi-core's offline mode in the Worker startup path", async () => {
		const root = join(tmpdir(), `pi-bridge-offline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const project: ProjectConfig = { id: "alpha", cwd: root, sessionDir };

		const saved = {
			offline: process.env.PI_OFFLINE,
			skip: process.env.PI_SKIP_VERSION_CHECK,
		};
		delete process.env.PI_OFFLINE;
		delete process.env.PI_SKIP_VERSION_CHECK;
		cleanups.push(() => {
			if (saved.offline === undefined || saved.skip === undefined) return;
			process.env.PI_OFFLINE = saved.offline;
			process.env.PI_SKIP_VERSION_CHECK = saved.skip;
		});

		const factory: LocalManagerFactory = async () => {
			throw new Error("no manager is created here");
		};
		const worker = await startLocalWorker({
			projects: [project],
			agentDir: root,
			modelRuntime: { getAvailableSnapshot: () => [], getProvider: () => undefined } as unknown as ModelRuntime,
			managerFactory: factory,
			skipStorageLock: true,
			idleGcMs: 60_000,
			unflushedIdleGcMs: 60_000,
		});
		cleanups.push(() => worker.dispose());

		// A standalone `--worker-serve` process takes this path, so the mode must
		// be set here and not only in the Daemon.
		expect(process.env.PI_OFFLINE).toBe("1");
		expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
	});
});
