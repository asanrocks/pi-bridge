// ============================================================================
// Session-state wiring: the Worker's transitions between the
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
 * settlement fires only when the test says the execution settled, and the
 * next admitted prompt can be refused before admission (mimicking the real
 * Manager's contract: a refused dispatch rejects and never keeps the
 * execution tag). */
interface FakeManager extends Manager {
	/** The execution tag of the last admitted dispatch. */
	lastExecution: () => string | undefined;
	/** The execution fully settled: fire the Manager's signal. */
	settle: (execution?: string) => void;
	/** Refuse the next admitted prompt before admission (one-shot). */
	refuseNextPrompt: () => void;
	disposeCalls: () => number;
}

function fakeManager(sessionPath: string | undefined): FakeManager {
	// The durable id is the file header's (the cache key, never the path):
	// rows carry it, and the catalog resolves them through it — the state
	// store is keyed by the stem, but the stand-in must read the header the
	// way the real Manager does so the row shape matches.
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
	let refuseNext = false;
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
			if (refuseNext) {
				// Refused before admission: reject, and never record the tag — the
				// real Manager rolls its tag back on the same path.
				refuseNext = false;
				throw new Error("preflight refused");
			}
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
		refuseNextPrompt: () => {
			refuseNext = true;
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

	it("a prompt refused mid-execution strands nothing: the running execution keeps the queue busy and its settle lands", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "one");
		expect(await queueOf(fx.worker)).toEqual([["busy", "a"]]);

		// A second prompt is refused at preflight while the first execution
		// still runs: the abandon must restore that execution — not a busy row
		// whose token no settle will ever carry (the fake refuses the way the
		// real Manager does: the refused tag is never recorded).
		fx.managers[0].refuseNextPrompt();
		await expect(fx.worker.prompt(target, "two")).rejects.toThrow(/preflight refused/);
		expect(await queueOf(fx.worker)).toEqual([["busy", "a"]]);

		// The first execution settles under its own tag and the queue lands
		// notified — not stuck busy until restart.
		fx.managers[0].settle();
		expect(await queueOf(fx.worker)).toEqual([["notified", "a"]]);
	});

	// Dormant rows read their own file for content; inactive history is
	// never touched.
	const userMessage = (text: string): string =>
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-02T00:00:00Z",
			message: { role: "user", content: [{ type: "text", text }] },
		});

	it("a dormant queued row carries its file's content; history stays out of the queue", async () => {
		const fx = makeFixture();
		// Many inactive sessions — none may cost the queue anything.
		for (let i = 0; i < 50; i++) fx.addSession(`id-h${i}`, `history-${i}`);
		// The queued dormant session has a name and a first message in its file.
		writeFileSync(
			join(fx.project.sessionDir, "queued.jsonl"),
			`${[JSON.stringify({ type: "session", id: "id-queued" }), JSON.stringify({ type: "session_info", name: "The one that matters" }), userMessage("pick this up")].join("\n")}\n`,
		);
		await fx.worker.setSessionState({ projectId: "proj", stem: "queued" }, "notified");

		const rows = await fx.worker.listQueue();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			stem: "queued",
			sessionId: "id-queued",
			state: "notified",
			name: "The one that matters",
			firstMessageText: "pick this up",
		});

		// A queued record whose file is gone after the record was written
		// renders no row — the next boot's recovery prunes it.
		rmSync(join(fx.project.sessionDir, "queued.jsonl"));
		expect(await fx.worker.listQueue()).toEqual([]);
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

	it("a queued row whose file is unparseable still carries its durable state", async () => {
		const fx = makeFixture();
		// Present and contained, but no session header: the catalog cannot parse
		// it, so the row's metadata is empty while its queue state is not.
		writeFileSync(join(fx.project.sessionDir, "broken.jsonl"), "not json\n");
		await fx.worker.setSessionState({ projectId: "proj", stem: "broken" }, "deferred");
		expect((await fx.worker.listQueue()).map((row) => [row.stem, row.state])).toEqual([["broken", "deferred"]]);
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
