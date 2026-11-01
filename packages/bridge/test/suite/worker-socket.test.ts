// Worker socket transport (commit 5 of the Worker split).
//
// The transport is pinned against the contract, not against the encoding: the
// Daemon-visible behavior of a remote Worker must match the in-process one.
// These tests drive a real WebSocket pair through `serveWorkerConnection` and
// `connectWorker`, covering the handshake, observation delivery, pull scoping,
// release, target-addressed commands, terminal close, and withdrawal.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Document, Patch } from "../../src/core/index.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { connectWorker } from "../../src/host/worker-client.ts";
import type { WorkerObservationFrame } from "../../src/host/worker-contract.ts";
import type { LocalManagerFactory, LocalWorker } from "../../src/host/worker-local.ts";
import { createLocalWorker } from "../../src/host/worker-local.ts";
import { WORKER_PROTOCOL_VERSION } from "../../src/host/worker-protocol.ts";
import { createWorkerSocketServer } from "../../src/host/worker-server.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface StubManager extends Manager {
	emitPatch: (patch: Patch) => void;
	disposeCalls: () => number;
}

function stubManager(sessionPath: string | undefined): StubManager {
	const sessionId = sessionPath ? basename(sessionPath, ".jsonl") : `fresh-${Math.random().toString(36).slice(2)}`;
	const handles = new Set<ConnectionHandle>();
	let disposed = 0;
	const document = {
		status: {
			leafId: "pending:m",
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
			contextUsage: null,
			pendingSteer: [],
		},
		entries: {
			"pending:m": {
				kind: "message",
				id: "pending:m",
				parentId: null,
				timestamp: "",
				isSealed: false,
				role: "assistant",
				content: [{ type: "thinking", thinking: "partial" }],
			},
		},
	} as unknown as Document;

	const base = {
		document,
		liveSessionId: sessionId,
		cwd: "/proj",
		sessionFile: sessionPath ?? `/proj/${sessionId}.jsonl`,
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle, session: Parameters<Manager["addConnection"]>[1]) {
			handles.add(handle);
			handle.onInitialSync({ kind: "replace", session, document });
		},
		removeConnection(handle: ConnectionHandle) {
			handles.delete(handle);
		},
		onSettled: () => () => {},
		prompt: async () => {},
		promptAdmitted: async () => {},
		executeBash: async () => {},
		abort: async () => {},
		discardSteer: async () => {},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		renameSession: async () => {},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async () => "retry" as const,
		dispose: async () => {
			disposed += 1;
		},
	};
	return {
		...base,
		emitPatch: (patch: Patch) => {
			for (const handle of handles) handle.onPatch(patch);
		},
		disposeCalls: () => disposed,
	} as unknown as StubManager;
}

/** The environment surface is not under test here; the handshake only needs a
 * runtime that can report an empty catalogue. */
function stubModelRuntime(): ModelRuntime {
	return {
		getAvailableSnapshot: () => [],
		getProvider: () => undefined,
	} as unknown as ModelRuntime;
}

interface Fixture {
	worker: LocalWorker;
	project: ProjectConfig;
	endpoint: string;
	managers: StubManager[];
}

async function makeServedWorker(): Promise<Fixture> {
	const root = join(tmpdir(), `pi-bridge-socket-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const project: ProjectConfig = { id: "proj", cwd: root, sessionDir };
	const managers: StubManager[] = [];
	const factory: LocalManagerFactory = async (opts) => {
		const manager = stubManager(opts?.sessionPath);
		managers.push(manager);
		return manager;
	};
	const worker = createLocalWorker({
		projects: [project],
		agentDir: root,
		modelRuntime: stubModelRuntime(),
		managerFactory: factory,
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		requestedThinkingLevel: () => "off",
	});
	const server = await createWorkerSocketServer({ service: worker });
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	cleanups.push(async () => {
		await server.close();
		await worker.dispose();
	});
	return { worker, project, endpoint: server.endpoint, managers };
}

/** A durable Session file: `openSession` requires the address to exist. The
 * stub Manager reads nothing from it (the header only names the session). */
function writeSession(fixture: Fixture, stem: string): void {
	writeFileSync(
		join(fixture.project.sessionDir, `${stem}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: stem, timestamp: "2026-01-01T00:00:00Z", cwd: fixture.project.cwd })}\n`,
	);
}

/** Record frames per observation. */
function framesOf(): { frames: WorkerObservationFrame[]; sink: (frame: WorkerObservationFrame) => void } {
	const frames: WorkerObservationFrame[] = [];
	return { frames, sink: (frame) => frames.push(frame) };
}

describe("worker socket transport", () => {
	it("greets with the registration and environment before any reply", async () => {
		const fixture = await makeServedWorker();
		const remote = await connectWorker({ endpoint: fixture.endpoint });
		cleanups.push(() => remote.dispose());

		expect(remote.registration.incarnation).toBe(fixture.worker.registration.incarnation);
		expect(remote.hello.info.projects.map((p) => p.id)).toEqual(["proj"]);
	});

	it("delivers the initial sync before the observation is returned, then live patches", async () => {
		const fixture = await makeServedWorker();
		writeSession(fixture, "s1");
		const remote = await connectWorker({ endpoint: fixture.endpoint });
		cleanups.push(() => remote.dispose());

		const { frames, sink } = framesOf();
		const observed = await remote.observeSession({ projectId: "proj", stem: "s1" }, { cursor: null, sink });

		// The replace arrived during acquisition, before observeSession resolved.
		expect(frames).toHaveLength(1);
		expect(frames[0]?.kind).toBe("replace");
		expect(observed.target.sessionId).toBe("s1");

		// A live patch crosses the link and reaches the same sink.
		fixture.managers[0]?.emitPatch({ ops: [{ op: "replace", path: "/status/isStreaming", value: true }] });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(frames.slice(1).some((frame) => frame.kind === "patch")).toBe(true);
	});

	it("scopes lazy demand to the observation that pulled it", async () => {
		const fixture = await makeServedWorker();
		writeSession(fixture, "s2");
		const remote = await connectWorker({ endpoint: fixture.endpoint });
		cleanups.push(() => remote.dispose());

		const first = framesOf();
		const second = framesOf();
		const a = await remote.observeSession({ projectId: "proj", stem: "s2" }, { cursor: null, sink: first.sink });
		await remote.observeSession({ projectId: "proj", stem: "s2" }, { cursor: null, sink: second.sink });

		const pulled = await a.observation.pull([
			{ entryId: "pending:m", fieldPath: "/entries/pending:m/content/0/thinking" },
		]);
		expect(pulled).toEqual([
			{ entryId: "pending:m", fieldPath: "/entries/pending:m/content/0/thinking", value: "partial", live: true },
		]);

		// Only the pulling observation keeps receiving that path.
		fixture.managers[0]?.emitPatch({
			ops: [{ op: "replace", path: "/entries/pending:m/content/0/thinking", value: "more" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		const firstHas = first.frames.some(
			(frame) => frame.kind === "patch" && frame.ops.some((op) => op.path.includes("thinking")),
		);
		const secondHas = second.frames.some(
			(frame) => frame.kind === "patch" && frame.ops.some((op) => op.path.includes("thinking")),
		);
		expect(firstHas).toBe(true);
		expect(secondHas).toBe(false);
	});

	it("releasing one observation leaves the sibling and the Session serving", async () => {
		const fixture = await makeServedWorker();
		writeSession(fixture, "s3");
		const remote = await connectWorker({ endpoint: fixture.endpoint });
		cleanups.push(() => remote.dispose());

		const first = framesOf();
		const second = framesOf();
		const a = await remote.observeSession({ projectId: "proj", stem: "s3" }, { cursor: null, sink: first.sink });
		await remote.observeSession({ projectId: "proj", stem: "s3" }, { cursor: null, sink: second.sink });

		await a.observation.release();
		fixture.managers[0]?.emitPatch({ ops: [{ op: "replace", path: "/status/isStreaming", value: true }] });
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(first.frames).toHaveLength(1);
		expect(second.frames.length).toBeGreaterThan(1);

		// The runtime is still serving commands after an observation release.
		await remote.abort(a.target);
		expect(fixture.managers[0]?.disposeCalls()).toBe(0);
	});

	it("refuses a target whose activation was replaced, and ends observations on close", async () => {
		const fixture = await makeServedWorker();
		writeSession(fixture, "s4");
		const remote = await connectWorker({ endpoint: fixture.endpoint });
		cleanups.push(() => remote.dispose());

		const { frames, sink } = framesOf();
		const observed = await remote.observeSession({ projectId: "proj", stem: "s4" }, { cursor: null, sink });
		await remote.closeSession({ projectId: "proj", stem: "s4" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The terminal frame crossed the link.
		expect(frames.some((frame) => frame.kind === "closed")).toBe(true);
		// The target now names an Activation that ended.
		await expect(remote.abort(observed.target)).rejects.toThrow(/closed|stale/);
	});

	it("a shutdown drains and disposes the Worker through the link", async () => {
		const fixture = await makeServedWorker();
		writeSession(fixture, "s5");
		const remote = await connectWorker({ endpoint: fixture.endpoint });
		const { sink } = framesOf();
		await remote.observeSession({ projectId: "proj", stem: "s5" }, { cursor: null, sink });

		await remote.dispose();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fixture.managers[0]?.disposeCalls()).toBe(1);
	});
});

describe("worker link liveness", () => {
	it("treats a peer that stops answering heartbeats as lost", async () => {
		// `autoPong: false` gives a peer that greets and then goes silent, which is
		// what a half-open socket looks like from the client.
		const wss = new WebSocketServer({ port: 0, autoPong: false });
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
					protocol: WORKER_PROTOCOL_VERSION,
					registration: { id: "reg", incarnation: "inc", generation: 1 },
					info: {
						projects: [],
						models: [],
						pinnedModels: [],
						visibleModels: [],
						thinkingLevels: [],
					},
				}),
			);
		});
		await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
		const port = (wss.address() as { port: number }).port;

		const remote = await connectWorker({
			endpoint: `ws://127.0.0.1:${port}`,
			heartbeatIntervalMs: 20,
			heartbeatTimeoutMs: 60,
		});
		const reasons: string[] = [];
		remote.onUnavailable((reason) => reasons.push(reason));

		await new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = setInterval(() => {
				if (reasons.length > 0) {
					clearInterval(poll);
					resolve();
					return;
				}
				if (Date.now() - started > 3_000) {
					clearInterval(poll);
					reject(new Error("heartbeat timeout was not detected"));
				}
			}, 10);
		});

		expect(reasons[0]).toMatch(/heartbeat timeout/);
	});

	it("answers an unknown request kind instead of leaving the caller pending", async () => {
		const fixture = await makeServedWorker();
		const ws = new WebSocket(fixture.endpoint);
		cleanups.push(() => ws.close());
		const frames: Array<Record<string, unknown>> = [];
		ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
		await new Promise<void>((resolve) => ws.once("open", () => resolve()));

		ws.send(JSON.stringify({ id: "bogus-1", kind: "not-a-verb" }));
		await new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = setInterval(() => {
				if (frames.some((frame) => frame.id === "bogus-1")) {
					clearInterval(poll);
					resolve();
					return;
				}
				if (Date.now() - started > 2_000) {
					clearInterval(poll);
					reject(new Error("unknown request wedged the link"));
				}
			}, 10);
		});

		const reply = frames.find((frame) => frame.id === "bogus-1") as { ok: boolean; error?: string };
		expect(reply.ok).toBe(false);
		expect(String(reply.error)).toMatch(/unknown worker request/);

		// The link is still usable: the failure is scoped to the request.
		ws.send(JSON.stringify({ id: "info-1", kind: "info" }));
		await new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = setInterval(() => {
				const found = frames.find((frame) => frame.id === "info-1") as { ok?: boolean } | undefined;
				if (found?.ok === true) {
					clearInterval(poll);
					resolve();
					return;
				}
				if (Date.now() - started > 2_000) {
					clearInterval(poll);
					reject(new Error("link unusable after an unknown request"));
				}
			}, 10);
		});
	});
});
