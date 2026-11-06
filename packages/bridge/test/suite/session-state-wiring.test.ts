// ============================================================================
// Session-state wiring (ADR 22): the Worker's transitions between the
// admission seams, the full-settlement relay, and the durable store — driven
// through the Worker service contract. The Manager is a controllable stand-in
// (the real Manager's settlement signal is covered by full-settlement.test.ts
// and one end-to-end turn below), so these tests pin the wiring's decisions:
// the queue's membership and order, browsing invariance, the toggle's busy
// precondition, close-wins, dormant closes, and restart recovery.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRef } from "../../src/core/index.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { createLocalWorker, type LocalManagerFactory, type LocalWorker } from "../../src/host/worker-local.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
	while (roots.length) {
		const root = roots.pop();
		if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
	}
});

/** A Manager stand-in the tests drive: admissions are captured, full
 * settlement fires only when the test says the execution settled. */
interface FakeManager extends Manager {
	/** The execution tag of the last admitted dispatch. */
	lastExecution: () => string | undefined;
	/** The execution fully settled: fire the Manager's signal. */
	settle: (execution?: string) => void;
	disposeCalls: () => number;
}

function fakeManager(sessionPath: string | undefined): FakeManager {
	// The durable id is the file header's (the cache key, never the path):
	// the state store is keyed by it, and the catalog resolves queue rows
	// through it, so the stand-in must read it the way the real Manager does.
	const durableId = (path: string): string => {
		try {
			const first = readFileSync(path, "utf8").split("\n", 1)[0];
			const parsed = JSON.parse(first) as { type?: string; id?: string };
			if (parsed.type === "session" && typeof parsed.id === "string") return parsed.id;
		} catch {
			// fall through to the basename
		}
		return basename(path, ".jsonl");
	};
	const sessionId = sessionPath ? durableId(sessionPath) : `fresh-${Math.random().toString(36).slice(2)}`;
	const fullySettled = new Set<(execution: string | undefined) => void>();
	let execution: string | undefined;
	let disposed = 0;
	const base = {
		document: {
			status: {
				leafId: null,
				name: "",
				model: { provider: "", modelId: "" },
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
				contextUsage: null,
				pendingSteer: [],
			},
			entries: {},
		},
		liveSessionId: sessionId,
		cwd: "/proj",
		sessionFile: sessionPath ?? `/proj/${sessionId}.jsonl`,
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle, session: SessionRef) {
			handle.onInitialSync({
				kind: "replace",
				session,
				document: base.document,
			});
		},
		removeConnection: () => {},
		onSettled: () => () => {},
		onFullySettled(listener: (execution: string | undefined) => void) {
			fullySettled.add(listener);
			return () => fullySettled.delete(listener);
		},
		activity: () => ({ phase: "idle" as const, tool: null, recoverable: false }),
		onActivityChange: () => () => {},
		prompt: async () => {},
		promptAdmitted: async (_text: string, _images?: unknown, _model?: unknown, _level?: unknown, exec?: string) => {
			execution = exec;
		},
		executeBash: async () => {},
		abort: async () => {},
		discardSteer: async () => {},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		renameSession: async () => {},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async (exec?: string) => {
			execution = exec;
			return "retry" as const;
		},
		dispose: async () => {
			disposed += 1;
		},
	};
	return {
		...(base as unknown as Manager),
		lastExecution: () => execution,
		settle: (exec?: string) => {
			const tag = exec ?? execution;
			for (const listener of fullySettled) listener(tag);
		},
		disposeCalls: () => disposed,
	} as FakeManager;
}

interface Fixture {
	worker: LocalWorker;
	project: ProjectConfig;
	managers: FakeManager[];
	/** Write a durable session file with a header id; returns its stem. */
	addSession: (sessionId: string, stem: string) => void;
	/** Open (activate) a session and return its target. */
	open: (stem: string) => Promise<Parameters<LocalWorker["prompt"]>[0]>;
}

function makeFixture(): Fixture {
	const root = join(tmpdir(), `pi-bridge-states-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	roots.push(root);
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const project: ProjectConfig = { id: "proj", cwd: root, sessionDir };
	const managers: FakeManager[] = [];
	const factory: LocalManagerFactory = async (opts) => {
		const manager = fakeManager(opts?.sessionPath);
		managers.push(manager);
		return manager;
	};
	const worker = createLocalWorker({
		projects: [project],
		agentDir: join(root, "agent"),
		modelRuntime: {} as ModelRuntime,
		managerFactory: factory,
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		requestedThinkingLevel: () => "off",
	});
	return {
		worker,
		project,
		managers,
		addSession(sessionId, stem) {
			writeFileSync(join(sessionDir, `${stem}.jsonl`), `${JSON.stringify({ type: "session", id: sessionId })}\n`);
		},
		async open(stem) {
			const observed = await worker.observeSession({ projectId: "proj", stem }, { sink: () => {} });
			return observed.target;
		},
	};
}

/** The queue as seen through the contract: [state, stem] rows. */
async function queueOf(worker: LocalWorker): Promise<Array<[string, string]>> {
	return (await worker.listQueue()).map((row) => [row.state ?? "inactive", row.stem]);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe("session-state wiring: transitions", () => {
	it("an admitted prompt lands busy; full settlement lands notified", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		expect(await queueOf(fx.worker)).toEqual([]);

		await fx.worker.prompt(target, "hello");
		expect(await queueOf(fx.worker)).toEqual([["busy", "a"]]);

		fx.managers[0].settle();
		expect(await queueOf(fx.worker)).toEqual([["notified", "a"]]);
	});

	it("the queue_changed event fires on every transition", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const events: string[] = [];
		fx.worker.onEvent((event) => {
			if (event.kind === "queue_changed") events.push(event.sessions.map((s) => `${s.stem}:${s.state}`).join(","));
		});

		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		fx.managers[0].settle();
		await fx.worker.setSessionState({ projectId: "proj", stem: "a" }, "deferred");

		expect(events.length).toBeGreaterThanOrEqual(3);
		expect(events.some((e) => e.includes("a:busy"))).toBe(true);
		expect(events.some((e) => e.includes("a:notified"))).toBe(true);
		expect(events[events.length - 1]).toContain("a:deferred");
	});

	it("deferred is not sticky: a new prompt makes it busy, its settle notified", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "one");
		fx.managers[0].settle();
		await fx.worker.setSessionState({ projectId: "proj", stem: "a" }, "deferred");
		expect(await queueOf(fx.worker)).toEqual([["deferred", "a"]]);

		await fx.worker.prompt(target, "two");
		expect(await queueOf(fx.worker)).toEqual([["busy", "a"]]);
		fx.managers[0].settle();
		expect(await queueOf(fx.worker)).toEqual([["notified", "a"]]);
	});

	it("the toggle is refused while busy and legal on a dormant session", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		await expect(fx.worker.setSessionState({ projectId: "proj", stem: "a" }, "deferred")).rejects.toThrow(/busy/);
		fx.managers[0].settle();

		// Dormant: release the observation, let the activation stay — and also
		// toggle a session that was never opened at all.
		const observed = await fx.worker.observeSession({ projectId: "proj", stem: "a" }, { sink: () => {} });
		await observed.observation.release();
		await fx.worker.setSessionState({ projectId: "proj", stem: "a" }, "deferred");
		expect(await queueOf(fx.worker)).toEqual([["deferred", "a"]]);

		fx.addSession("id-b", "b");
		await fx.worker.setSessionState({ projectId: "proj", stem: "b" }, "notified");
		expect(await queueOf(fx.worker)).toEqual([
			["notified", "b"],
			["deferred", "a"],
		]);
	});

	it("browsing is inert: opening and detaching a dormant session changes nothing", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		fx.addSession("id-b", "b");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		fx.managers[0].settle();
		const before = await fx.worker.listQueue();

		const observed = await fx.worker.observeSession({ projectId: "proj", stem: "b" }, { sink: () => {} });
		await observed.observation.release();
		const observedA = await fx.worker.observeSession({ projectId: "proj", stem: "a" }, { sink: () => {} });
		await observedA.observation.release();

		expect(await fx.worker.listQueue()).toEqual(before);
	});

	it("the queue is ordered notified → busy → deferred, then activity", async () => {
		const fx = makeFixture();
		// Later mtimes sort later within a group (activity desc), so write the
		// notified rows in reverse to prove the state rank dominates.
		fx.addSession("id-n1", "n1");
		fx.addSession("id-n2", "n2");
		// Distinct mtimes: n2 is the more recently active of the two.
		const t0 = Date.now() / 1000;
		utimesSync(join(fx.project.sessionDir, "n1.jsonl"), t0 - 60, t0 - 60);
		utimesSync(join(fx.project.sessionDir, "n2.jsonl"), t0, t0);
		fx.addSession("id-b1", "b1");
		fx.addSession("id-d1", "d1");
		for (const stem of ["n2", "n1"]) {
			const target = await fx.open(stem);
			await fx.worker.prompt(target, "hi");
			fx.managers[fx.managers.length - 1].settle();
		}
		const busyTarget = await fx.open("b1");
		await fx.worker.prompt(busyTarget, "running");
		await fx.worker.setSessionState({ projectId: "proj", stem: "d1" }, "deferred");

		expect(await queueOf(fx.worker)).toEqual([
			["notified", "n2"],
			["notified", "n1"],
			["busy", "b1"],
			["deferred", "d1"],
		]);
	});

	it("a refused admission restores the pre-admission state", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "one");
		fx.managers[0].settle();

		// A dispatch that refuses preflight rejects the wrapper's promise.
		const manager = fx.managers[0] as unknown as { promptAdmitted: (t: string) => Promise<void> };
		const refuse = async () => {
			throw new Error("no model");
		};
		const original = manager.promptAdmitted;
		(manager as unknown as { promptAdmitted: typeof refuse }).promptAdmitted = refuse;
		const target2 = await fx.open("a");
		await expect(fx.worker.prompt(target2, "two")).rejects.toThrow(/no model/);
		(manager as unknown as { promptAdmitted: typeof original }).promptAdmitted = original;

		expect(await queueOf(fx.worker)).toEqual([["notified", "a"]]);
	});

	it("recoverTurn is an execution: busy at admission, notified at its settle", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.recoverTurn(target);
		expect(await queueOf(fx.worker)).toEqual([["busy", "a"]]);
		fx.managers[0].settle();
		expect(await queueOf(fx.worker)).toEqual([["notified", "a"]]);
	});
});

// ---------------------------------------------------------------------------
// Close and archive
// ---------------------------------------------------------------------------

describe("session-state wiring: close and archive", () => {
	it("close of a busy session is the last write for that execution", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		expect(await queueOf(fx.worker)).toEqual([["busy", "a"]]);

		// Disposal finalizes the turn: the abort's settle fires during the
		// collection the close awaits, so the close's inactive lands after it.
		const manager = fx.managers[0];
		const originalDispose = manager.dispose;
		(manager as unknown as { dispose: () => Promise<void> }).dispose = async () => {
			manager.settle();
			await originalDispose.call(manager);
		};

		await fx.worker.closeSession({ projectId: "proj", stem: "a" });
		expect(manager.disposeCalls()).toBe(1);
		expect(await queueOf(fx.worker)).toEqual([]);
	});

	it("close of a dormant session is legal and clears the queue", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		fx.managers[0].settle();
		// The activation is still live here — close it so only the state write
		// remains, then re-close dormant: idempotent, still legal.
		await fx.worker.closeSession({ projectId: "proj", stem: "a" });
		expect(await queueOf(fx.worker)).toEqual([]);
		await expect(fx.worker.closeSession({ projectId: "proj", stem: "a" })).resolves.toBe(undefined);
	});

	it("close of a stem with no session at all is an error", async () => {
		const fx = makeFixture();
		await expect(fx.worker.closeSession({ projectId: "proj", stem: "ghost" })).rejects.toThrow(/No such session/);
	});

	it("archive prunes the queue record", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		fx.managers[0].settle();
		expect(await queueOf(fx.worker)).toEqual([["notified", "a"]]);

		await fx.worker.archiveSession({ projectId: "proj", stem: "a" });
		expect(await queueOf(fx.worker)).toEqual([]);
		expect(existsSync(join(fx.project.sessionDir, ".archive", "a.jsonl"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Persistence across a Worker restart
// ---------------------------------------------------------------------------

describe("session-state wiring: restart recovery", () => {
	it("the queue survives a Worker rebuild; a persisted busy recovers to notified", async () => {
		const root = join(tmpdir(), `pi-bridge-states-restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const project: ProjectConfig = { id: "proj", cwd: root, sessionDir };
		for (const [sessionId, stem] of [
			["id-n", "n"],
			["id-d", "d"],
			["id-b", "b"],
		] as const) {
			writeFileSync(join(sessionDir, `${stem}.jsonl`), `${JSON.stringify({ type: "session", id: sessionId })}\n`);
		}

		const build = () => {
			const managers: FakeManager[] = [];
			const factory: LocalManagerFactory = async (opts) => {
				const manager = fakeManager(opts?.sessionPath);
				managers.push(manager);
				return manager;
			};
			return {
				worker: createLocalWorker({
					projects: [project],
					agentDir: join(root, "agent"),
					modelRuntime: {} as ModelRuntime,
					managerFactory: factory,
					idleGcMs: 60_000,
					unflushedIdleGcMs: 60_000,
					requestedThinkingLevel: () => "off",
				}),
				managers,
			};
		};

		const first = build();
		for (const stem of ["n", "d", "b"]) {
			const observed = await first.worker.observeSession({ projectId: "proj", stem }, { sink: () => {} });
			await first.worker.prompt(observed.target, "hello");
			first.managers[first.managers.length - 1].settle();
		}
		await first.worker.setSessionState({ projectId: "proj", stem: "d" }, "deferred");
		// Leave "b" mid-execution: admitted, never settled.
		const observed = await first.worker.observeSession({ projectId: "proj", stem: "b" }, { sink: () => {} });
		await first.worker.prompt(observed.target, "still running");
		await first.worker.dispose();

		const second = build();
		// "b" has the newest file mtime, so it leads the notified group.
		expect(await queueOf(second.worker)).toEqual([
			["notified", "b"],
			["notified", "n"],
			["deferred", "d"],
		]);
		await second.worker.dispose();
	});
});
