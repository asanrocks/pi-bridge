// Daemon → Worker routing (commits 6–8 of the Worker split).
//
// The Daemon is a delivery layer: Project configuration, the model catalogue,
// the repository surface, and every Session runtime belong to the Worker. These
// tests run the real Daemon against a Worker reached over a real socket, so the
// routing table is the accepted registration rather than a local guess.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Document } from "../../src/core/index.ts";
import { Daemon } from "../../src/host/daemon.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import { buildProjects, type ProjectConfig } from "../../src/host/projects.ts";
import { createLocalWorker, type LocalWorker } from "../../src/host/worker-local.ts";
import { createWorkerSocketServer } from "../../src/host/worker-server.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface StubManager extends Manager {
	calls: string[];
}

function stubManager(sessionPath: string | undefined): StubManager {
	const sessionId = sessionPath ? basename(sessionPath, ".jsonl") : `fresh-${Math.random().toString(36).slice(2)}`;
	const calls: string[] = [];
	const handles = new Set<ConnectionHandle>();
	const document = {
		status: {
			leafId: "m1",
			name: "",
			model: { provider: "faux", modelId: "faux" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
			contextUsage: null,
			pendingSteer: [],
		},
		entries: {
			m1: {
				kind: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				isSealed: true,
				ord: 1,
				role: "user",
				content: [{ type: "text", text: "hello" }],
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
		activity: () => ({ phase: "idle" as const, tool: null, recoverable: false }),
		onActivityChange: () => () => {},
		prompt: async (text: string) => {
			calls.push(`prompt:${text}`);
		},
		promptAdmitted: async (text: string) => {
			calls.push(`admitted:${text}`);
		},
		executeBash: async () => {},
		abort: async () => {
			calls.push("abort");
		},
		discardSteer: async () => {},
		compact: async () => ({ tokensBefore: 0, estimatedTokensAfter: 0 }),
		setModel: async () => {},
		setThinkingLevel: async () => {},
		renameSession: async () => {},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async () => "retry" as const,
		dispose: async () => {},
	};
	return { ...base, calls } as unknown as StubManager;
}

function stubModelRuntime(): ModelRuntime {
	return {
		getAvailableSnapshot: () => [
			{
				provider: "faux",
				id: "faux",
				name: "Faux",
				reasoning: false,
				contextWindow: 1000,
			},
		],
		getProvider: () => ({ name: "Faux" }),
	} as unknown as ModelRuntime;
}

interface Fixture {
	endpoint: string;
	project: ProjectConfig;
	managers: StubManager[];
	/** The Worker service behind the endpoint. */
	worker: LocalWorker;
	/** Drop the Worker link (a crash, from the Daemon's point of view). */
	close(): Promise<void>;
}

async function serveWorker(projectId = "worker-proj"): Promise<Fixture> {
	const root = join(tmpdir(), `pi-bridge-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	const [project] = buildProjects([`${projectId}=${root}`], root);
	if (project === undefined) throw new Error("project fixture missing");
	mkdirSync(project.sessionDir, { recursive: true });
	writeFileSync(
		join(project.sessionDir, "s1.jsonl"),
		`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: root })}\n`,
	);

	const managers: StubManager[] = [];
	const worker = createLocalWorker({
		projects: [project],
		agentDir: root,
		modelRuntime: stubModelRuntime(),
		managerFactory: async (opts) => {
			const manager = stubManager(opts?.sessionPath);
			managers.push(manager);
			return manager;
		},
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		requestedThinkingLevel: () => "off",
	});
	const server = await createWorkerSocketServer({ service: worker });
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	cleanups.push(async () => {
		await server.close().catch(() => {});
		await worker.dispose().catch(() => {});
	});
	return {
		endpoint: server.endpoint,
		project,
		managers,
		worker,
		close: async () => {
			await server.close();
		},
	};
}

async function startDaemon(...endpoints: string[]): Promise<{ port: number; daemon: Daemon }> {
	const daemon = new Daemon();
	cleanups.push(() => daemon.dispose());
	// The publication interval is a test seam: five seconds (the default) would
	// make every queue assertion a wait.
	await daemon.start({
		workerModes: endpoints.map((endpoint) => ({ kind: "connect" as const, endpoint })),
		queuePublishIntervalMs: 10,
	});
	const address = daemon.address;
	if (!address) throw new Error("daemon not listening");
	return { port: address.port, daemon };
}

/** Frames each socket received, collected from construction: the Daemon sends
 * the queue snapshot immediately on connection, so a listener attached after
 * `open` would miss the Connection's baseline. */
const framesBySocket = new WeakMap<WebSocket, unknown[]>();

function openClient(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const frames: unknown[] = [];
		framesBySocket.set(ws, frames);
		ws.on("message", (data) => {
			try {
				frames.push(JSON.parse(data.toString()));
			} catch {
				// ignore
			}
		});
		ws.on("open", () => resolve(ws));
		ws.on("error", reject);
	});
}

function collect(ws: WebSocket): unknown[] {
	return framesBySocket.get(ws) ?? [];
}

let seq = 0;
function send(ws: WebSocket, frame: Record<string, unknown>): string {
	const id = String(++seq);
	ws.send(JSON.stringify({ id, ...frame }));
	return id;
}

/** Poll until a condition holds (worker-side effects are not wire frames). */
function waitUntil(pred: () => boolean, timeout = 2_000): Promise<void> {
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
				reject(new Error("timed out waiting for a condition"));
			}
		}, 10);
	});
}

function waitFor(
	frames: unknown[],
	pred: (frame: Record<string, unknown>) => boolean,
	timeout = 5_000,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const existing = frames.find((frame) => pred(frame as Record<string, unknown>));
		if (existing) return resolve(existing as Record<string, unknown>);
		const timer = setTimeout(() => {
			clearInterval(poll);
			reject(new Error(`timed out waiting for a frame; saw ${JSON.stringify(frames)}`));
		}, timeout);
		const poll = setInterval(() => {
			const found = frames.find((frame) => pred(frame as Record<string, unknown>));
			if (!found) return;
			clearTimeout(timer);
			clearInterval(poll);
			resolve(found as Record<string, unknown>);
		}, 10);
	});
}

describe("daemon routing through several workers", () => {
	it("claims each registration's Projects and routes by Project id", async () => {
		const first = await serveWorker("alpha");
		const second = await serveWorker("beta");
		const { port } = await startDaemon(first.endpoint, second.endpoint);
		const ws = await openClient(port);
		cleanups.push(() => ws.close());
		const frames = collect(ws);

		send(ws, { verb: "getDaemonInfo" });
		const info = await waitFor(frames, (frame) => frame.ok === true && Array.isArray(frame.projects));
		// The Daemon holds no Project configuration: both rows came from the two
		// registrations, and the merged report is what the picker sees.
		expect((info.projects as Array<{ id: string }>).map((p) => p.id).sort()).toEqual(["alpha", "beta"]);

		// Opening a Project reaches the Worker that claimed it.
		send(ws, { verb: "openSession", projectId: "alpha", stem: "s1" });
		const opened = await waitFor(frames, (frame) => frame.kind === "replace");
		expect((opened.session as { projectId: string }).projectId).toBe("alpha");
		expect(first.managers).toHaveLength(1);
		expect(second.managers).toHaveLength(0);
	});

	it("refuses a second registration that claims a Project already served, and disposes the claim's loser", async () => {
		const first = await serveWorker("alpha");
		const second = await serveWorker("alpha");
		await expect(startDaemon(first.endpoint, second.endpoint)).rejects.toThrow(/already served/);

		// The claim's loser is withdrawn with the rest: its link was disposed, so
		// a spawned Worker cannot leak past a failed startup holding its socket
		// and its session-directory claims. A refused observeSession is how a
		// disposed service answers.
		for (const fixture of [first, second]) {
			await expect(
				fixture.worker.observeSession({ projectId: "alpha", stem: "s1" }, { cursor: null, sink: () => {} }),
			).rejects.toThrow(/shutting down/);
		}
	});

	it("aggregates the queue in one global order, seeded from persisted state", async () => {
		const first = await serveWorker("alpha");
		const second = await serveWorker("beta");
		// alpha arrives holding persisted queue state: s1 parked before the
		// Daemon ever connected — a dial-in Worker whose storage outlived the
		// previous Daemon.
		await first.worker.setSessionLocation({ projectId: "alpha", stem: "s1" }, "later");
		const { port } = await startDaemon(first.endpoint, second.endpoint);
		const ws = await openClient(port);
		cleanups.push(() => ws.close());
		const frames = collect(ws);

		// The Connection's baseline carries alpha's persisted slice: an empty
		// start would hide it until alpha published its first delta.
		const snapshot = await waitFor(frames, (frame) => frame.kind === "queue_changed" && frame.mode === "snapshot");
		expect(
			(snapshot.sessions as Array<{ projectId: string; location: string }>).map(
				(row) => `${row.projectId}:${row.location}`,
			),
		).toEqual(["alpha:later"]);

		// A transition on beta publishes one changed row; the order stays global
		// across the registration boundary (the aggregate re-sorts with the
		// shared comparator instead of concatenating per-Worker blocks).
		const toggle = send(ws, { verb: "setSessionLocation", projectId: "beta", stem: "s1", location: "inbox" });
		await waitFor(frames, (frame) => frame.id === toggle && frame.ok === true);
		const push = await waitFor(
			frames,
			(frame) =>
				frame.kind === "queue_changed" &&
				frame.mode === "delta" &&
				(frame.upsert as Array<{ projectId: string }>).some((row) => row.projectId === "beta"),
		);
		expect(
			(push.upsert as Array<{ projectId: string; location: string }>).map(
				(row) => `${row.projectId}:${row.location}`,
			),
		).toEqual(["beta:inbox"]);

		// The RPC aggregate carries the same global order.
		send(ws, { verb: "listQueue" });
		const list = await waitFor(frames, (frame) => frame.ok === true && Array.isArray(frame.sessions));
		expect(
			(list.sessions as Array<{ projectId: string; location: string }>).map((r) => `${r.projectId}:${r.location}`),
		).toEqual(["beta:inbox", "alpha:later"]);
	});

	it("withdraws only the failed Worker's Projects", async () => {
		const first = await serveWorker("alpha");
		const second = await serveWorker("beta");
		const { port, daemon } = await startDaemon(first.endpoint, second.endpoint);
		const ws = await openClient(port);
		cleanups.push(() => ws.close());
		const frames = collect(ws);

		expect(daemon.registrations).toHaveLength(2);

		// The `alpha` registration dies; `beta` must keep serving.
		await first.close();
		await new Promise((resolve) => setTimeout(resolve, 150));

		const alphaId = send(ws, { verb: "openSession", projectId: "alpha", stem: "s1" });
		const refused = await waitFor(frames, (frame) => frame.id === alphaId);
		expect(String(refused.error)).toMatch(/Unknown project/);

		const betaId = send(ws, { verb: "openSession", projectId: "beta", stem: "s1" });
		await waitFor(frames, (frame) => frame.id === betaId);
		const opened = await waitFor(
			frames,
			(frame) => frame.kind === "replace" && (frame.session as { projectId: string }).projectId === "beta",
		);
		expect(opened.kind).toBe("replace");
	});
});

describe("daemon routing through a remote worker", () => {
	it("serves the Worker's Project set and catalogue", async () => {
		const fixture = await serveWorker();
		const { port } = await startDaemon(fixture.endpoint);
		const ws = await openClient(port);
		cleanups.push(() => ws.close());
		const frames = collect(ws);

		send(ws, { verb: "getDaemonInfo" });
		const reply = await waitFor(frames, (frame) => frame.ok === true && Array.isArray(frame.projects));

		// The Daemon has no Project configuration of its own: these rows came
		// across the socket.
		expect((reply.projects as Array<{ id: string }>).map((p) => p.id)).toEqual([fixture.project.id]);
		expect((reply.models as Array<{ id: string }>).map((m) => m.id)).toEqual(["faux"]);
	});

	it("opens, streams, and commands a Session entirely through the Worker", async () => {
		const fixture = await serveWorker();
		const { port } = await startDaemon(fixture.endpoint);
		const ws = await openClient(port);
		cleanups.push(() => ws.close());
		const frames = collect(ws);

		send(ws, { verb: "openSession", projectId: fixture.project.id, stem: "s1" });
		// The initial sync crosses Worker → Daemon → browser and carries the
		// browser attachment generation the Daemon minted.
		const replace = await waitFor(frames, (frame) => frame.kind === "replace");
		expect(replace.generation).toBe(1);
		expect((replace.session as { stem: string }).stem).toBe("s1");

		send(ws, { verb: "prompt", text: "hi" });
		// The command travelled browser → Daemon → Worker and reached the runtime
		// at admission (ADR 12 Reply semantics): the wire verb must not use the
		// completion path, whose reply waits for the whole turn.
		await waitUntil(() => fixture.managers[0]?.calls.includes("admitted:hi") === true);
		expect(fixture.managers[0]?.calls).not.toContain("prompt:hi");
	});

	it("refuses a Project outside the accepted registration", async () => {
		const fixture = await serveWorker();
		const { port } = await startDaemon(fixture.endpoint);
		const ws = await openClient(port);
		cleanups.push(() => ws.close());
		const frames = collect(ws);

		send(ws, { verb: "openSession", projectId: "not-served", stem: "s1" });
		const reply = await waitFor(frames, (frame) => frame.ok === false);
		expect(String(reply.error)).toMatch(/Unknown project/);
	});

	it("withdraws routes when the Worker goes away", async () => {
		const fixture = await serveWorker();
		const { port } = await startDaemon(fixture.endpoint);
		const ws = await openClient(port);
		cleanups.push(() => ws.close());
		const frames = collect(ws);

		// The link dies: the Daemon must stop advertising the Worker's Projects
		// instead of answering every operation with a refusal.
		await fixture.close();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const id = send(ws, { verb: "openSession", projectId: fixture.project.id, stem: "s1" });
		const reply = await waitFor(frames, (frame) => frame.id === id);
		expect(String(reply.error)).toMatch(/Unknown project/);
	});
});
