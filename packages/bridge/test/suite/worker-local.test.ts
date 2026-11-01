// Local Worker — the in-process implementation of the Worker service contract.
// It owns the Activation registry and the per-session choreography; these
// tests drive it through the contract (as a remote implementation would be
// driven), pinning the registration identity, the observation lifetime, the
// admission/drain behavior, and the terminal boundary the Daemon relies on.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { Document, Patch, SessionRef } from "../../src/core/index.ts";
import { Connection } from "../../src/host/connection.ts";
import type { DaemonVerbs } from "../../src/host/connection-verbs.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { bindWorkerCommands } from "../../src/host/session-commands.ts";
import { createLocalWorker, type LocalManagerFactory, type LocalWorker } from "../../src/host/worker-local.ts";
import { collectFrames, createWsPair, waitForFrame, waitForOpen } from "./conn-helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A Manager stand-in: only the members the registry path under test reads. */
interface StubManager extends Manager {
	calls: string[];
	disposeCalls: () => number;
	/** Emit a live patch to every installed observer handle. */
	emitPatch: (patch: Patch) => void;
}

function stubManager(sessionPath: string | undefined): StubManager {
	const sessionId = sessionPath ? basename(sessionPath, ".jsonl") : `fresh-${Math.random().toString(36).slice(2)}`;
	const connectionHandles = new Set<ConnectionHandle>();
	const calls: string[] = [];
	let disposed = 0;
	const base = {
		document: {
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
				// A live form with a lazy body: the unit of observation demand.
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
		} as unknown as Document,
		liveSessionId: sessionId,
		cwd: "/proj",
		sessionFile: sessionPath ?? `/proj/${sessionId}.jsonl`,
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle, session: Parameters<Manager["addConnection"]>[1]) {
			connectionHandles.add(handle);
			handle.onInitialSync({
				kind: "replace",
				session,
				document: base.document,
			});
		},
		removeConnection(handle: ConnectionHandle) {
			connectionHandles.delete(handle);
		},
		onSettled: () => () => {},
		prompt: async () => {},
		promptAdmitted: async () => {},
		executeBash: async () => {},
		abort: async () => {},
		discardSteer: async () => {},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		renameSession: async () => {
			calls.push("rename");
		},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async () => "retry" as const,
		dispose: async () => {
			disposed += 1;
		},
	};
	return {
		...base,
		calls,
		disposeCalls: () => disposed,
		emitPatch: (patch: Patch) => {
			for (const handle of connectionHandles) handle.onPatch(patch);
		},
	} as unknown as StubManager;
}

interface StubBundle {
	worker: LocalWorker;
	project: ProjectConfig;
	managers: StubManager[];
}

function makeWorker(): StubBundle {
	const root = join(tmpdir(), `pi-bridge-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		modelRuntime: {} as ModelRuntime,
		managerFactory: factory,
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		requestedThinkingLevel: () => "off",
	});
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return { worker, project, managers };
}

/** Minimal verb surface: the Connection exists to be attached, detached, and
 * notified — no verb is exercised through it here. */
const stubVerbs: DaemonVerbs = {
	listSessions: async () => ({ sessions: [], hasMore: false }),
	listActiveSessions: async () => [],
	getDaemonInfo: async () => ({
		projects: [],
		models: [],
		pinnedModels: [],
		visibleModels: [],
		thinkingLevels: [],
		devMode: false,
	}),
	setModelPinned: async () => {},
	asrCredentials: async () => ({ kind: "device", deviceId: "d" }),
	textPolish: async (text: string) => text,
	openSession: async () => ({ ok: false, error: "unused" }),
	newSession: async () => ({ ok: false, error: "unused" }),
	detach: () => {},
	closeSession: async () => ({ ok: false, error: "unused" }),
	archiveSession: async () => ({ ok: false, error: "unused" }),
	sessionsChanged: () => {},
	listFiles: async () => [],
	readFile: () => {
		throw new Error("unused");
	},
	listDirectory: () => {
		throw new Error("unused");
	},
	gitShow: () => {
		throw new Error("unused");
	},
	gitBase: () => {
		throw new Error("unused");
	},
	gitDiff: () => {
		throw new Error("unused");
	},
};

function writeSession(bundle: StubBundle, stem: string): string {
	const abs = join(bundle.project.sessionDir, `${stem}.jsonl`);
	writeFileSync(
		abs,
		`${JSON.stringify({ type: "session", version: 3, id: stem, timestamp: "2026-01-01T00:00:00Z", cwd: bundle.project.cwd })}\n`,
	);
	return abs;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

/** Attach a Connection to one address through the contract, exactly as the
 * Daemon does: the Connection supplies the sink before the observation exists. */
async function connectTo(
	worker: LocalWorker,
	bundle: StubBundle,
	stem: string,
): Promise<{ conn: Connection; clientWs: WebSocket; frames: unknown[]; ref: SessionRef }> {
	writeSession(bundle, stem);
	const { serverWs, clientWs } = await createWsPair();
	// Wait for the client's open before returning: the test may end without a
	// macrotask, and closing a still-connecting socket is an async error.
	await waitForOpen(clientWs);
	const frames = collectFrames(clientWs);
	const conn = new Connection(serverWs, stubVerbs, null, false);
	cleanups.push(() => {
		serverWs.close();
		clientWs.close();
	});
	const target = await conn.attach(async (sink) => {
		const observed = await worker.observeSession({ projectId: "proj", stem }, { cursor: null, sink });
		return {
			target: observed.target,
			observation: observed.observation,
			commands: bindWorkerCommands(worker, observed.target, observed.observation),
		};
	});
	return {
		conn,
		clientWs,
		frames,
		ref: { projectId: target.projectId, stem: target.stem, sessionId: target.sessionId },
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LocalWorker (contract)", () => {
	it("assigns each activation a generation unique within the registration's incarnation", async () => {
		const bundle = makeWorker();
		const worker = bundle.worker;

		await connectTo(worker, bundle, "gen-a");
		await connectTo(worker, bundle, "gen-b");
		const live = worker.liveRecords();
		const byStem = new Map(live.map((record) => [record.ref.stem, record]));
		expect(byStem.get("gen-a")!.authorization.incarnation).toBe(worker.registration.incarnation);
		expect(byStem.get("gen-a")!.authorization.generation).toBe(1);
		expect(byStem.get("gen-b")!.authorization.generation).toBe(2);

		// A replaced registration never reuses its predecessor's generation.
		await worker.closeSession({ projectId: "proj", stem: "gen-a" });
		await connectTo(worker, bundle, "gen-a");
		const reopened = worker.liveRecords().find((record) => record.ref.stem === "gen-a")!;
		expect(reopened.authorization.generation).toBe(3);

		// Each Worker is its own incarnation: generations are scoped to it.
		const other = makeWorker();
		expect(other.worker.registration.incarnation).not.toBe(worker.registration.incarnation);
	});

	it("a target names its activation, and the address alone does not", async () => {
		const bundle = makeWorker();
		const { ref } = await connectTo(bundle.worker, bundle, "tgt-1");
		const record = bundle.worker.liveRecords().find((r) => r.ref.stem === "tgt-1")!;
		expect(ref.sessionId).toBe(record.ref.sessionId);

		// The Worker serves the target's commands.
		const target = {
			projectId: "proj",
			stem: "tgt-1",
			sessionId: record.ref.sessionId,
			cwd: "/proj",
			worker: bundle.worker.registration,
			activation: record.authorization.generation,
		};
		await expect(bundle.worker.renameSession(target, "renamed")).resolves.toBeUndefined();
	});

	it("closeSession ends the observation and pushes session_closed", async () => {
		const bundle = makeWorker();
		const worker = bundle.worker;
		const { conn, frames } = await connectTo(worker, bundle, "term-1");
		expect(conn.isAttached).toBe(true);

		await worker.closeSession({ projectId: "proj", stem: "term-1" });

		// The terminal ownership boundary: the attachment is severed and the
		// client learns the runtime ended.
		expect(conn.isAttached).toBe(false);
		const closed = await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "session_closed");
		expect((closed as Record<string, unknown>).stem).toBe("term-1");
		expect((closed as Record<string, unknown>).projectId).toBe("proj");
		// Live listings drop the address after collection.
		expect(worker.liveRecords().some((r) => r.ref.stem === "term-1")).toBe(false);
	});

	it("a session command after collection is refused, not run against the dead runtime", async () => {
		const bundle = makeWorker();
		const worker = bundle.worker;
		const { clientWs, frames } = await connectTo(worker, bundle, "term-2");

		await worker.closeSession({ projectId: "proj", stem: "term-2" });
		clientWs.send(JSON.stringify({ id: "rpc-1", verb: "prompt", text: "late" }));
		const reply = (await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === "rpc-1")) as Record<
			string,
			unknown
		>;
		expect(reply.ok).toBe(false);
		expect(reply.error).toBe("no session attached");
	});

	it("releasing an observation detaches without disposing the activation", async () => {
		const bundle = makeWorker();
		const { conn } = await connectTo(bundle.worker, bundle, "rel-1");
		const record = bundle.worker.liveRecords().find((r) => r.ref.stem === "rel-1")!;

		conn.detach();
		expect(conn.isAttached).toBe(false);
		// Detach is not a kill: the activation stays live (for idle collection).
		expect(bundle.worker.liveRecords()).toContain(record);
		expect(bundle.managers[0]!.disposeCalls()).toBe(0);
	});

	it("demand belongs to the observation: a sibling never receives withheld content", async () => {
		const bundle = makeWorker();
		const a = await connectTo(bundle.worker, bundle, "demand-1");
		const b = await connectTo(bundle.worker, bundle, "demand-1");
		const manager = bundle.managers[0]!;
		const lazyPath = "/entries/pending:m/content/0/thinking";
		const patch: Patch = { ops: [{ op: "replace", path: lazyPath, value: "streamed" }] };

		// Neither observation asked for the streamed body: it is withheld.
		manager.emitPatch(patch);
		expect(a.frames.filter((f) => (f as { kind?: string }).kind === "patch")).toHaveLength(0);
		expect(b.frames.filter((f) => (f as { kind?: string }).kind === "patch")).toHaveLength(0);

		// A pulls: the value is a live form, so its path becomes A's demand.
		a.clientWs.send(
			JSON.stringify({ id: "pull-a", verb: "pull", requests: [{ entryId: "pending:m", fieldPath: lazyPath }] }),
		);
		await waitForFrame(a.frames, (f) => (f as Record<string, unknown>).id === "pull-a");
		manager.emitPatch(patch);

		// Only A receives it. B's stream is independent, even though both
		// observations serve the same Activation.
		await waitForFrame(a.frames, (f) => (f as { kind?: string }).kind === "patch");
		expect(b.frames.filter((f) => (f as { kind?: string }).kind === "patch")).toHaveLength(0);

		await bundle.worker.closeSession({ projectId: "proj", stem: "demand-1" });
	});

	it("refuses a target whose activation was replaced instead of retargeting it", async () => {
		const bundle = makeWorker();
		const worker = bundle.worker;
		await connectTo(worker, bundle, "stale-1");
		const first = worker.liveRecords().find((r) => r.ref.stem === "stale-1")!;
		const staleTarget = {
			projectId: "proj",
			stem: "stale-1",
			sessionId: first.ref.sessionId,
			cwd: "/proj",
			worker: worker.registration,
			activation: first.authorization.generation,
		};

		// The runtime is replaced by a new registration for the same address.
		await worker.closeSession({ projectId: "proj", stem: "stale-1" });
		await connectTo(worker, bundle, "stale-1");
		const second = worker.liveRecords().find((r) => r.ref.stem === "stale-1")!;
		expect(second.authorization.generation).not.toBe(first.authorization.generation);

		// Work composed against the dead activation is refused, not delivered to
		// its successor: the durable session id and the activation generation are
		// both part of the identity a target names.
		await expect(worker.renameSession(staleTarget, "wrong")).rejects.toThrow(/replaced activation/);
		expect(bundle.managers[1]!.calls).not.toContain("rename");
	});

	it("refuses a target from another Worker incarnation", async () => {
		const bundle = makeWorker();
		const { ref } = await connectTo(bundle.worker, bundle, "foreign-1");
		const record = bundle.worker.liveRecords().find((r) => r.ref.stem === "foreign-1")!;
		const foreign = {
			projectId: "proj",
			stem: "foreign-1",
			sessionId: ref.sessionId,
			cwd: "/proj",
			worker: { id: "other", incarnation: "another-run", generation: 1 },
			activation: record.authorization.generation,
		};
		await expect(bundle.worker.setModel(foreign, "faux", "faux-1")).rejects.toThrow(/replaced registration/);
	});

	it("refuses a target whose durable session changed under the same address", async () => {
		const bundle = makeWorker();
		const { ref } = await connectTo(bundle.worker, bundle, "moved-1");
		const record = bundle.worker.liveRecords().find((r) => r.ref.stem === "moved-1")!;
		const wrongSession = {
			projectId: "proj",
			stem: "moved-1",
			sessionId: `${ref.sessionId}-other`,
			cwd: "/proj",
			worker: bundle.worker.registration,
			activation: record.authorization.generation,
		};
		await expect(bundle.worker.navigate(wrongSession, null)).rejects.toThrow(/session changed/);
	});

	it("dispose refuses further work and disposes the remaining Managers", async () => {
		const bundle = makeWorker();
		const worker = bundle.worker;
		await connectTo(worker, bundle, "shut-1");
		expect(existsSync(join(bundle.project.sessionDir, "shut-1.jsonl"))).toBe(true);

		await worker.dispose();
		expect(bundle.managers[0]!.disposeCalls()).toBe(1);

		// Admission ends with the drain: nothing registers afterwards.
		writeSession(bundle, "shut-2");
		await expect(
			worker.observeSession({ projectId: "proj", stem: "shut-2" }, { cursor: null, sink: () => {} }),
		).rejects.toThrow(/shutting down/);
		expect(worker.liveRecords()).toHaveLength(0);
	});
});
