// ============================================================================
// Session-location wiring: the Worker's transitions between the admission
// seams and the durable location store — driven through the Worker service
// contract. The Manager is a controllable stand-in, so these tests pin the
// wiring's decisions: a submission's Inbox promotion and its rollback, the
// queue's membership and order, moves that leave execution alone, Archive and
// Trash stopping the runtime, browsing invariance, and restart recovery.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRef } from "../../src/core/index.ts";
import type { ConnectionHandle, Manager, SettlementBoundary } from "../../src/host/manager.ts";
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

/** A Manager stand-in the tests drive: the next admitted prompt can be
 * refused before admission (mimicking the real Manager's contract), and the
 * liveness the listing reads — the activity phase and the Document's streaming
 * flag — is moved by the test. */
interface FakeManager extends Manager {
	/** Refuse the next admitted prompt before admission (one-shot). */
	refuseNextPrompt: () => void;
	/** Report a new runtime activity (fires the Manager's listener, as the
	 * real runtime does on a phase transition). */
	setActivity: (phase: "idle" | "wait" | "stream" | "tool" | "compact", tool?: string) => void;
	/** Flip the Document's streaming flag (the fake never streams on its own). */
	setStreaming: (streaming: boolean) => void;
	/** The whole execution settled (pi's `agent_settled`): the Manager's
	 * completion signal. */
	settle: () => void;
	/** One pi turn ended mid-execution (i.e. an assistant step with its tool
	 * results, before the loop continues): the metadata rescan signal only. */
	turnEnd: () => void;
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
	let refuseNext = false;
	let disposed = 0;
	// Mutable liveness the actor reads: `activity()` reports the phase word and
	// `document.status.isStreaming` the Document's own flag (ADR 23's listing
	// facts). The tests move both.
	let activityPhase: "idle" | "wait" | "stream" | "tool" | "compact" = "idle";
	let activityTool: string | null = null;
	const activityListeners = new Set<() => void>();
	const settledListeners = new Set<(boundary: SettlementBoundary) => void>();
	const status = {
		leafId: null,
		name: "",
		model: { provider: "", modelId: "" },
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
		contextUsage: null,
		pendingSteer: [] as string[],
	};
	const base = {
		document: {
			status,
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
		onSettled(listener: (boundary: SettlementBoundary) => void) {
			settledListeners.add(listener);
			return () => settledListeners.delete(listener);
		},
		activity: () => ({ phase: activityPhase, tool: activityTool, recoverable: false }),
		onActivityChange(listener: () => void) {
			activityListeners.add(listener);
			return () => activityListeners.delete(listener);
		},
		prompt: async () => {},
		promptAdmitted: async (_text: string, _images?: unknown, _model?: unknown, _level?: unknown) => {
			if (refuseNext) {
				refuseNext = false;
				throw new Error("preflight refused");
			}
		},
		executeBash: async () => {},
		abort: async () => {
			// The real runtime's abort settles the execution (pi emits
			// `agent_settled` before the abort's idle wait resolves).
			for (const listener of settledListeners) listener("execution");
		},
		discardSteer: async () => {},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		renameSession: async () => {},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async () => "retry" as const,
		dispose: async () => {
			disposed += 1;
			// Disposal aborts the in-flight turn, which settles the execution —
			// the boundary a disposal-induced completion would be derived from.
			for (const listener of settledListeners) listener("execution");
		},
	};
	return {
		...(base as unknown as Manager),
		refuseNextPrompt: () => {
			refuseNext = true;
		},
		setActivity: (phase, tool) => {
			activityPhase = phase;
			activityTool = tool ?? null;
			for (const listener of activityListeners) listener();
		},
		setStreaming: (streaming) => {
			status.isStreaming = streaming;
		},
		settle: () => {
			for (const listener of settledListeners) listener("execution");
		},
		turnEnd: () => {
			for (const listener of settledListeners) listener("turn");
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

/** The queue as seen through the contract: [location, stem] rows. */
async function queueOf(worker: LocalWorker): Promise<Array<[string, string]>> {
	return (await worker.listQueue()).sessions.map((row) => [row.location, row.stem]);
}

/** Whether the row reports a running execution (its activity, which is the
 * one running fact on the wire). */
async function runningOf(worker: LocalWorker, stem: string): Promise<boolean> {
	return (await worker.listQueue()).sessions.some((row) => row.stem === stem && row.activity !== undefined);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

describe("session-location wiring: transitions", () => {
	it("a submitted message places the session in Inbox — running or not", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		expect(await queueOf(fx.worker)).toEqual([]);

		await fx.worker.prompt(target, "hello");
		expect(await queueOf(fx.worker)).toEqual([["inbox", "a"]]);
		// The turn ends: the placement is untouched, the running fact clears.
		expect(await runningOf(fx.worker, "a")).toBe(false);
	});

	it("the queue_changed event carries each placement transition as a changed row", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const events: string[] = [];
		fx.worker.onEvent((event) => {
			if (event.kind === "queue_changed") {
				events.push(event.upsert.map((s) => `${s.stem}:${s.location}`).join(","));
			}
		});

		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "a" }, "later");

		// Admission and the move are each one complete row; no snapshot is
		// pushed, so an unchanged row never repeats.
		expect(events).toContain("a:inbox");
		expect(events[events.length - 1]).toBe("a:later");
	});

	it("Later is not sticky: the next message brings the session back to Inbox", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "one");
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "a" }, "later");
		expect(await queueOf(fx.worker)).toEqual([["later", "a"]]);

		await fx.worker.prompt(target, "two");
		expect(await queueOf(fx.worker)).toEqual([["inbox", "a"]]);
	});

	it("a refused admission restores the placement it replaced", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "one");
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "a" }, "later");

		fx.managers[0].refuseNextPrompt();
		await expect(fx.worker.prompt(target, "two")).rejects.toThrow(/preflight refused/);
		// The promotion is rolled back: the user's Later placement stands.
		expect(await queueOf(fx.worker)).toEqual([["later", "a"]]);
	});

	it("recoverTurn places the session in Inbox like any other submitted work", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.recoverTurn(target);
		expect(await queueOf(fx.worker)).toEqual([["inbox", "a"]]);
	});

	// Dormant rows read their own file for content; archived history is
	// never touched.
	const userMessage = (text: string): string =>
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-02T00:00:00Z",
			message: { role: "user", content: [{ type: "text", text }] },
		});

	it("a dormant queued row carries its file's content; history stays out of the queue", async () => {
		const fx = makeFixture();
		// Many archived sessions — none may cost the queue anything.
		for (let i = 0; i < 50; i++) fx.addSession(`id-h${i}`, `history-${i}`);
		// The queued dormant session has a name and a first message in its file.
		writeFileSync(
			join(fx.project.sessionDir, "queued.jsonl"),
			`${[JSON.stringify({ type: "session", id: "id-queued" }), JSON.stringify({ type: "session_info", name: "The one that matters" }), userMessage("pick this up")].join("\n")}\n`,
		);
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "queued" }, "later");

		const rows = (await fx.worker.listQueue()).sessions;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			stem: "queued",
			sessionId: "id-queued",
			location: "later",
			name: "The one that matters",
			firstMessageText: "pick this up",
		});

		// A queued record whose file is gone after the record was written
		// renders no row — the next boot's recovery prunes it.
		rmSync(join(fx.project.sessionDir, "queued.jsonl"));
		expect((await fx.worker.listQueue()).sessions).toEqual([]);
	});

	it("moves are legal while running and on a dormant session", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		// Running: the manager reports a tool, and the move still lands without
		// pretending the execution ended.
		fx.managers[0].setActivity("tool", "Bash");
		expect(await runningOf(fx.worker, "a")).toBe(true);
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "a" }, "later");
		expect(await queueOf(fx.worker)).toEqual([["later", "a"]]);
		expect(await runningOf(fx.worker, "a")).toBe(true);

		// Dormant: a session that was never opened at all.
		fx.addSession("id-b", "b");
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "b" }, "inbox");
		expect(await queueOf(fx.worker)).toEqual([
			["inbox", "b"],
			["later", "a"],
		]);
	});

	it("browsing is inert: opening and detaching a dormant session changes nothing", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		fx.addSession("id-b", "b");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		const before = await fx.worker.listQueue();

		const observed = await fx.worker.observeSession({ projectId: "proj", stem: "b" }, { sink: () => {} });
		await observed.observation.release();
		const observedA = await fx.worker.observeSession({ projectId: "proj", stem: "a" }, { sink: () => {} });
		await observedA.observation.release();

		expect(await fx.worker.listQueue()).toEqual(before);
	});

	it("the queue is ordered Inbox → Later, newest placement first", async () => {
		const fx = makeFixture();
		fx.addSession("id-n1", "n1");
		fx.addSession("id-n2", "n2");
		fx.addSession("id-b1", "b1");
		fx.addSession("id-d1", "d1");
		// n1 is submitted first and n2 second, so the newer placement leads: the
		// pair comes out in the reverse of the activity order a recency sort gave.
		// The stamps are wall clock, so the submissions are spaced by a millisecond
		// they can differ by.
		for (const stem of ["n1", "n2"]) {
			const target = await fx.open(stem);
			await fx.worker.prompt(target, "hi");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		// A running Inbox row ranks with the Inbox group, not above it: b1 leads
		// because its placement is the newest, not because it is executing.
		const runningTarget = await fx.open("b1");
		await fx.worker.prompt(runningTarget, "running");
		fx.managers[fx.managers.length - 1].setActivity("tool", "Bash");
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "d1" }, "later");

		expect(await queueOf(fx.worker)).toEqual([
			["inbox", "b1"],
			["inbox", "n2"],
			["inbox", "n1"],
			["later", "d1"],
		]);
	});

	it("a running turn does not reorder the queue", async () => {
		const fx = makeFixture();
		fx.addSession("id-first", "first");
		fx.addSession("id-second", "second");
		const first = await fx.open("first");
		await fx.worker.prompt(first, "hi");
		const second = await fx.open("second");
		await fx.worker.prompt(second, "hi");
		const placed = await queueOf(fx.worker);

		// The older placement streams and reports a phase: activity is temporal, so
		// the order stays exactly what the two submissions decided.
		fx.managers[0].setActivity("tool", "Bash");
		fx.managers[0].setStreaming(true);
		expect(await queueOf(fx.worker)).toEqual(placed);
	});

	it("a queued row whose file is unparseable still carries its durable location", async () => {
		const fx = makeFixture();
		// Present and contained, but no session header: the catalog cannot parse
		// it, so the row's metadata is empty while its location is not.
		writeFileSync(join(fx.project.sessionDir, "broken.jsonl"), "not json\n");
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "broken" }, "later");
		expect((await fx.worker.listQueue()).sessions.map((row) => [row.stem, row.location])).toEqual([
			["broken", "later"],
		]);
	});
});

// ---------------------------------------------------------------------------
// Archive, trash, and stop
// ---------------------------------------------------------------------------

describe("session-location wiring: archive, trash, and stop", () => {
	it("archive ends the runtime and keeps the session browsable", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		expect(await queueOf(fx.worker)).toEqual([["inbox", "a"]]);

		await fx.worker.setSessionLocation({ projectId: "proj", stem: "a" }, "archive");
		expect(await queueOf(fx.worker)).toEqual([]);
		expect(fx.managers[0].disposeCalls()).toBe(1);
		// The file is still discoverable: archived history is browsable.
		expect(existsSync(join(fx.project.sessionDir, "a.jsonl"))).toBe(true);
		const page = await fx.worker.listSessions("proj");
		expect(page.sessions.map((row) => [row.stem, row.location])).toEqual([["a", "archive"]]);
	});

	it("a stop ends the runtime without moving the session", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		await fx.worker.closeSession({ projectId: "proj", stem: "a" });
		expect(fx.managers[0].disposeCalls()).toBe(1);
		expect(await queueOf(fx.worker)).toEqual([["inbox", "a"]]);
	});

	it("a stop of a stem with no session at all is an error", async () => {
		const fx = makeFixture();
		await expect(fx.worker.closeSession({ projectId: "proj", stem: "ghost" })).rejects.toThrow(/No such session/);
	});

	it("trash ends the runtime, moves the file, and drops the placement", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		expect(await queueOf(fx.worker)).toEqual([["inbox", "a"]]);

		await fx.worker.trashSession({ projectId: "proj", stem: "a" });
		expect(fx.managers[0].disposeCalls()).toBe(1);
		expect(await queueOf(fx.worker)).toEqual([]);
		expect(existsSync(join(fx.project.sessionDir, ".trash", "a.jsonl"))).toBe(true);
		expect(existsSync(join(fx.project.sessionDir, "a.jsonl"))).toBe(false);
		expect((await fx.worker.listSessions("proj")).sessions).toEqual([]);
	});

	it("trash of a dormant session moves the file without a runtime", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		await fx.worker.trashSession({ projectId: "proj", stem: "a" });
		expect(fx.managers).toHaveLength(0);
		expect(existsSync(join(fx.project.sessionDir, ".trash", "a.jsonl"))).toBe(true);
	});
});

describe("session-state wiring: queue activity (ADR 23)", () => {
	/** The queue rows with their activity words, as the wire carries them. */
	async function activityOf(worker: LocalWorker, stem: string) {
		return (await worker.listQueue()).sessions.find((row) => row.stem === stem)?.activity;
	}

	it("a running tool reaches the queue with its name and start instant", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		fx.managers[0].setActivity("tool", "Bash");

		const activity = await activityOf(fx.worker, "a");
		expect(activity?.kind).toBe("tool");
		if (activity?.kind !== "tool") throw new Error("expected a tool activity");
		expect(activity.name).toBe("Bash");
		// The instant the phase began, not the elapsed: the client rebases it
		// onto its own clock.
		expect(Number.isNaN(Date.parse(activity.startedAt))).toBe(false);
		expect(Date.now() - Date.parse(activity.startedAt)).toBeLessThan(60_000);
	});

	it("a streaming session without a tool reports responding, and idle reports nothing", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");

		fx.managers[0].setStreaming(true);
		fx.managers[0].setActivity("stream");
		expect(await activityOf(fx.worker, "a")).toEqual({ kind: "responding" });

		fx.managers[0].setStreaming(false);
		fx.managers[0].setActivity("idle");
		expect(await activityOf(fx.worker, "a")).toBeUndefined();
	});

	it("compaction reports its own word", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		fx.managers[0].setStreaming(true);
		fx.managers[0].setActivity("compact");
		expect(await activityOf(fx.worker, "a")).toEqual({ kind: "compacting" });
	});

	it("keeps the phase clock across a tool change, so a sibling's end is not a restart", async () => {
		// Parallel tools share the `tool` phase: one ending while the other runs
		// changes the name but not the phase, and the elapsed the row shows is
		// the phase's — restarting it would read `0m` for a tool that has been
		// running for minutes.
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");
		fx.managers[0].setActivity("tool", "Bash");
		const first = await activityOf(fx.worker, "a");
		if (first?.kind !== "tool") throw new Error("expected a tool activity");

		await new Promise((resolve) => setTimeout(resolve, 15));
		fx.managers[0].setActivity("tool", "Read");
		const second = await activityOf(fx.worker, "a");
		if (second?.kind !== "tool") throw new Error("expected a tool activity");
		expect(second.name).toBe("Read");
		expect(second.startedAt).toBe(first.startedAt);

		// A real phase change does restart the clock (and drops the tool line).
		fx.managers[0].setStreaming(true);
		fx.managers[0].setActivity("stream");
		await new Promise((resolve) => setTimeout(resolve, 15));
		const responding = await activityOf(fx.worker, "a");
		expect(responding).toEqual({ kind: "responding" });
	});

	it("an activity change pushes the queue; a dormant row carries no activity", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");

		const pushes: Array<string | null> = [];
		fx.worker.onEvent((event) => {
			if (event.kind !== "queue_changed") return;
			const row = event.upsert.find((r) => r.stem === "a");
			pushes.push(row?.activity?.kind ?? null);
		});
		fx.managers[0].setActivity("tool", "Read");
		expect(pushes).toContain("tool");

		// The row outlives its runtime: a stopped session keeps its Inbox
		// placement and loses the activity line the runtime owned.
		fx.managers[0].setStreaming(false);
		await fx.worker.closeSession({ projectId: "proj", stem: "a" });
		expect(await activityOf(fx.worker, "a")).toBeUndefined();
		expect(await queueOf(fx.worker)).toEqual([["inbox", "a"]]);
	});
});

describe("session-location wiring: restart recovery", () => {
	it("the placements survive a Worker rebuild; nothing about execution is stored", async () => {
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
		for (const stem of ["n", "b"]) {
			const observed = await first.worker.observeSession({ projectId: "proj", stem }, { sink: () => {} });
			await first.worker.prompt(observed.target, "hello");
		}
		await first.worker.setSessionLocation({ projectId: "proj", stem: "d" }, "later");
		// Leave "b" running: the execution is a runtime fact, never persisted.
		first.managers[first.managers.length - 1].setActivity("tool", "Bash");
		await first.worker.dispose();

		const second = build();
		// "b" has the newest file mtime, so it leads the Inbox group; no row
		// reports running after the restart, because nothing was stored.
		expect(await queueOf(second.worker)).toEqual([
			["inbox", "b"],
			["inbox", "n"],
			["later", "d"],
		]);
		expect((await second.worker.listQueue()).sessions.every((row) => row.activity === undefined)).toBe(true);
		await second.worker.dispose();
	});
});

describe("session-state wiring: queue deltas and completions (ADR 24)", () => {
	it("an unchanged refresh publishes nothing; a change publishes one complete row", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");

		const deltas: Array<{ upsert: string[]; remove: string[] }> = [];
		fx.worker.onEvent((event) => {
			if (event.kind !== "queue_changed") return;
			deltas.push({
				upsert: event.upsert.map((row) => `${row.stem}:${row.location}:${row.activity?.kind ?? "idle"}`),
				remove: event.remove.map((address) => address.stem),
			});
		});

		// Two full queries in a row observe the same state: the duplicate
		// emission that dominated the old snapshot traffic is gone.
		await fx.worker.listQueue();
		await fx.worker.listQueue();
		expect(deltas).toEqual([]);

		fx.managers[0].setActivity("tool", "Bash");
		expect(deltas).toEqual([{ upsert: ["a:inbox:tool"], remove: [] }]);

		// A move changes the location field; the runtime's activity is untouched
		// by it, so the row keeps reporting the tool.
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "a" }, "later");
		expect(deltas[deltas.length - 1]).toEqual({ upsert: ["a:later:tool"], remove: [] });
	});

	it("a queue delta says whether a person's gesture or execution state caused it", async () => {
		// The Daemon publishes a gesture at a short floor and execution state at
		// the interval, so the origin is the urgency it needs.
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");

		const origins: Array<[string, string]> = [];
		fx.worker.onEvent((event) => {
			if (event.kind !== "queue_changed") return;
			origins.push([event.upsert.map((row) => `${row.stem}:${row.location}`).join(","), event.origin]);
		});

		// An activity phase is execution state: the row's running line moved.
		fx.managers[0].setActivity("tool", "Bash");
		expect(origins).toEqual([["a:inbox", "runtime"]]);

		// A settle is execution state too.
		fx.managers[0].turnEnd();
		origins.length = 0;
		fx.managers[0].settle();
		expect(origins.every(([, origin]) => origin === "runtime")).toBe(true);

		// A placement is the user's own gesture, even though it shares the frame.
		origins.length = 0;
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "a" }, "later");
		expect(origins).toContainEqual(["a:later", "user"]);
	});

	it("a settle in a queued Session announces one completion, carrying the row's label", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");

		const completions: Array<{ stem: string; name?: string; text?: string }> = [];
		fx.worker.onEvent((event) => {
			if (event.kind !== "session_completed") return;
			completions.push({ stem: event.session.stem, name: event.name, text: event.lastMessageText });
		});

		fx.managers[0].settle();
		expect(completions).toHaveLength(1);
		// The notice repeats the row the settlement just refreshed, so a
		// notification never waits for the next queue delta.
		const row = (await fx.worker.listQueue()).sessions.find((entry) => entry.stem === "a");
		expect(completions[0]).toEqual({ stem: "a", name: row?.name, text: row?.lastMessageText });
	});

	it("a mid-execution turn boundary announces no completion", async () => {
		// pi emits `turn_end` after every assistant step, so a tool-using turn has
		// one per batch. Only the execution boundary is a completion: deriving it
		// from the turn boundary announced "ready for your input" while the agent
		// was still streaming.
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");

		const completions: string[] = [];
		fx.worker.onEvent((event) => {
			if (event.kind === "session_completed") completions.push(event.session.stem);
		});

		fx.managers[0].turnEnd();
		fx.managers[0].turnEnd();
		expect(completions).toEqual([]);

		// The execution's own end still announces exactly one.
		fx.managers[0].settle();
		expect(completions).toEqual(["a"]);
	});

	it("a user stop announces no completion", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");

		const completions: string[] = [];
		fx.worker.onEvent((event) => {
			if (event.kind === "session_completed") completions.push(event.session.stem);
		});

		// Stop aborts the run, and pi's abort settles the execution while the verb
		// is still running; the user asked for it, so it is not news that the
		// Session is ready for input.
		await fx.worker.abort(target);
		expect(completions).toEqual([]);
	});

	it("a Session outside the queue settles without a completion notice", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		await fx.open("a");

		let completed = 0;
		fx.worker.onEvent((event) => {
			if (event.kind === "session_completed") completed += 1;
		});
		fx.managers[0].settle();
		expect(completed).toBe(0);
	});

	it("archive and trash suppress the disposal's completion for that address only", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		fx.addSession("id-b", "b");
		const first = await fx.open("a");
		const second = await fx.open("b");
		await fx.worker.prompt(first, "hello");
		await fx.worker.prompt(second, "hello");

		const completions: string[] = [];
		fx.worker.onEvent((event) => {
			if (event.kind === "session_completed") completions.push(event.session.stem);
		});

		// Disposing a runtime finalizes its turn; the user asked for the move,
		// so that is not a completion to announce.
		await fx.worker.setSessionLocation({ projectId: "proj", stem: "a" }, "archive");
		expect(completions).toEqual([]);

		// Another Session's genuine completion still arrives immediately.
		fx.managers[fx.managers.length - 1].settle();
		expect(completions).toEqual(["b"]);
	});

	it("a failed move leaves the Session's completions intact", async () => {
		const fx = makeFixture();
		fx.addSession("id-a", "a");
		const target = await fx.open("a");
		await fx.worker.prompt(target, "hello");

		const completions: string[] = [];
		fx.worker.onEvent((event) => {
			if (event.kind === "session_completed") completions.push(event.session.stem);
		});

		await expect(fx.worker.trashSession({ projectId: "proj", stem: "no-such-session" })).rejects.toThrow();
		fx.managers[0].settle();
		expect(completions).toEqual(["a"]);
	});
});
