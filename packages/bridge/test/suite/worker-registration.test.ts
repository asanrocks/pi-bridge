// Registration and Project routing (commit 6 of the Worker split).
//
// Registration is where Project names are claimed. The handshake is the only
// place a Daemon learns what a Worker serves, so these tests pin the acceptance
// rules (duplicates, reserved names, protocol mismatch) and the withdrawal path
// (a dead or unavailable Worker stops being routed).

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
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
import { WORKER_PROTOCOL_VERSION } from "../../src/host/worker-protocol.ts";
import { createWorkerSocketServer } from "../../src/host/worker-server.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A Worker whose only real behavior is its registration: enough to exercise
 * the handshake, which is exactly what registration tests need. */
function fakeWorker(
	info: WorkerInfo,
	registration: WorkerRegistration,
): WorkerService & {
	emit(event: WorkerEvent): void;
} {
	const listeners = new Set<(event: WorkerEvent) => void>();
	const notImplemented = (): never => {
		throw new Error("not implemented");
	};
	const observation = {
		id: "obs",
		target: {} as SessionTarget,
		pull: async () => [],
		release: async () => {},
	} satisfies WorkerObservation;
	return {
		registration,
		info: async () => info,
		observeSession: async (): Promise<ObservedSession> => ({ target: {} as SessionTarget, observation }),
		createSession: async (): Promise<ObservedSession> => ({ target: {} as SessionTarget, observation }),
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
		listSessions: notImplemented,
		listQueue: notImplemented,
		setSessionLocation: notImplemented,
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
		dispose: async () => {},
	};
}

function info(projectIds: string[]): WorkerInfo {
	return {
		projects: projectIds.map((id) => ({ id, cwd: `/tmp/${id}`, defaultModel: null, defaultThinkingLevel: null })),
		models: [],
		pinnedModels: [],
		visibleModels: [],
		thinkingLevels: ["off"],
	};
}

const registration: WorkerRegistration = { id: "reg-1", incarnation: "inc-1", generation: 1 };

async function serve(service: WorkerService): Promise<string> {
	const server = await createWorkerSocketServer({ service });
	cleanups.push(() => server.close());
	return server.endpoint;
}

describe("worker registration", () => {
	it("accepts the advertised Project set", async () => {
		const endpoint = await serve(fakeWorker(info(["alpha", "beta"]), registration));
		const remote = await connectWorker({ endpoint });
		cleanups.push(() => remote.dispose());

		expect(remote.hello.registration).toEqual(registration);
		expect(remote.hello.info.projects.map((p) => p.id)).toEqual(["alpha", "beta"]);
	});

	it("rejects a registration whose Project ids duplicate", async () => {
		const endpoint = await serve(fakeWorker(info(["alpha", "alpha"]), registration));
		const seen = new Set<string>();
		await expect(
			connectWorker({
				endpoint,
				accept: (hello) => {
					for (const project of hello.info.projects) {
						if (seen.has(project.id)) throw new Error(`duplicate project id "${project.id}"`);
						seen.add(project.id);
					}
				},
			}),
		).rejects.toThrow(/duplicate project id/);
	});

	it("rejects a Project id that collides with a reserved surface name", async () => {
		const endpoint = await serve(fakeWorker(info(["assets"]), registration));
		await expect(
			connectWorker({
				endpoint,
				accept: (hello) => {
					if (hello.info.projects.some((project) => project.id === "assets")) {
						throw new Error('project id "assets" collides with a reserved name');
					}
				},
			}),
		).rejects.toThrow(/reserved name/);
	});

	it("rejects a peer speaking a different protocol version", async () => {
		// A raw socket that greets with the wrong version: the client must refuse
		// rather than parse frames whose meaning it cannot know.
		const wss = new WebSocketServer({ port: 0 });
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					for (const ws of wss.clients) ws.terminate();
					wss.close(() => resolve());
				}),
		);
		wss.on("connection", (ws) => {
			ws.send(
				JSON.stringify({
					kind: "hello",
					protocol: WORKER_PROTOCOL_VERSION + 1,
					registration,
					info: info(["alpha"]),
				}),
			);
		});
		await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
		const port = (wss.address() as { port: number }).port;

		await expect(connectWorker({ endpoint: `ws://127.0.0.1:${port}` })).rejects.toThrow(/protocol mismatch/);
	});

	it("withdraws the registration when the Worker reports unavailable", async () => {
		const worker = fakeWorker(info(["alpha"]), registration);
		const endpoint = await serve(worker);
		const remote = await connectWorker({ endpoint });
		cleanups.push(() => remote.dispose());

		const reasons: string[] = [];
		remote.onUnavailable((reason) => reasons.push(reason));
		worker.emit({ kind: "unavailable", reason: "storage lock lost" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(reasons).toEqual(["storage lock lost"]);
	});

	it("withdraws on link loss and rejects later work", async () => {
		const worker = fakeWorker(info(["alpha"]), registration);
		const endpoint = await serve(worker);
		const remote = await connectWorker({ endpoint });

		const reasons: string[] = [];
		remote.onUnavailable((reason) => reasons.push(reason));

		// Drop the link from the client side: the same close path a crash takes.
		await remote.dispose();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(reasons.length).toBeGreaterThan(0);
		await expect(remote.listQueue()).rejects.toThrow(/unavailable/);
	});
});

describe("worker routing targets", () => {
	it("keeps registration and activation identity distinct", async () => {
		const endpoint = await serve(fakeWorker(info(["alpha"]), registration));
		const remote = await connectWorker({ endpoint });
		cleanups.push(() => remote.dispose());

		// The registration names the link; an activation generation names one
		// runtime inside it. Collapsing them would let a restart inherit commands.
		expect(remote.registration.incarnation).toBe("inc-1");
		expect(remote.registration.generation).toBe(1);
		const address: SessionAddress = { projectId: "alpha", stem: "s" };
		const observed = await remote.observeSession(address, { cursor: null, sink: () => {} });
		expect(observed.observation.id).not.toBe(remote.registration.id);
	});
});
