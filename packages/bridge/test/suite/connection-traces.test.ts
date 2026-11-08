// Connection protocol traces — the cross-boundary acceptance cases for the
// observation-based attachment model: a close that lands while a command runs,
// a switch that completes under a running command, a pull reply that describes
// the session it was issued against, and the terminal-ownership ordering of
// `session_closed` against command replies. These run the real verb → Worker
// → registry path, not stubs of it.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { Document, SessionRef } from "../../src/core/index.ts";
import { Connection } from "../../src/host/connection.ts";
import type { DaemonVerbs } from "../../src/host/connection-verbs.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { bindWorkerCommands } from "../../src/host/session-commands.ts";
import type { ObservedSession, WorkerObservationSink } from "../../src/host/worker-contract.ts";
import { createLocalWorker, type LocalManagerFactory, type LocalWorker } from "../../src/host/worker-local.ts";
import { collectFrames, createWsPair, waitForFrame, waitForOpen } from "./conn-helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TraceManager {
	manager: Manager;
	calls: string[];
	/** Release a gated operation (rename). */
	release: () => void;
	/** Hold the next prompt's preflight, so a kill can land in the
	 * admitted-work window. One-shot: the following admissions resolve. */
	holdNextAdmission: () => void;
	disposeCalls: () => number;
}

/** A Manager stand-in: records calls; the admitted prompt's preflight is
 * gated so a kill can land inside the admitted-work window (as a slow input
 * extension's would); `renameSession` is gated too. */
function traceManager(stem: string, sessionFile = `/proj/sessions/${stem}.jsonl`): TraceManager {
	const calls: string[] = [];
	let disposed = 0;
	let holdAdmission = false;
	const gates: Array<() => void> = [];
	const gate = (): Promise<void> =>
		new Promise<void>((resolve) => {
			gates.push(resolve);
		});
	const release = () => {
		while (gates.length) gates.shift()?.();
	};
	const ref: SessionRef = { projectId: "proj", sessionId: stem, stem };
	const document: Document = {
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
		entries: {
			e1: { id: "e1", kind: "message", isSealed: true, ord: 0, content: [{ type: "text", text: `body-${stem}` }] },
		},
	} as unknown as Document;
	const base = {
		document,
		liveSessionId: stem,
		cwd: `/proj`,
		sessionFile,
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle) {
			handle.onInitialSync({ kind: "replace", session: ref, document });
		},
		removeConnection: () => {},
		onSettled: () => () => {},
		activity: () => ({ phase: "idle" as const, tool: null, recoverable: false }),
		onActivityChange: () => () => {},
		prompt: async () => {
			calls.push("prompt:turn");
			await gate(); // released by disposal (the abort path) or by hand
		},
		promptAdmitted: async () => {
			calls.push("prompt");
			if (!holdAdmission) return;
			holdAdmission = false;
			await gate(); // the admitted-work window: a kill inside preflight
		},
		executeBash: async () => {},
		abort: async () => {},
		discardSteer: async () => {},
		setModel: async () => {},
		setThinkingLevel: async () => {},
		renameSession: async () => {
			calls.push("rename");
			await gate();
		},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async () => "retry" as const,
		dispose: async () => {
			disposed++;
			calls.push("dispose");
			release();
		},
	};
	return {
		manager: base as unknown as Manager,
		calls,
		release,
		holdNextAdmission: () => {
			holdAdmission = true;
		},
		disposeCalls: () => disposed,
	};
}

interface Bundle {
	worker: LocalWorker;
	project: ProjectConfig;
	managers: Map<string, TraceManager>;
	verbs: DaemonVerbs;
	sessionsChanged: string[];
}

function makeBundle(): Bundle {
	const root = join(tmpdir(), `pi-bridge-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const project: ProjectConfig = { id: "proj", cwd: root, sessionDir };
	const managers = new Map<string, TraceManager>();
	const sessionsChanged: string[] = [];
	let freshCount = 0;
	const factory: LocalManagerFactory = async (opts) => {
		const resumed = opts?.sessionPath;
		if (resumed) {
			const stem = basename(resumed, ".jsonl");
			const tm = traceManager(stem);
			managers.set(stem, tm);
			return tm.manager;
		}
		freshCount += 1;
		const stem = `new-${freshCount}`;
		const tm = traceManager(stem, join(sessionDir, `${stem}.jsonl`));
		managers.set(stem, tm);
		return tm.manager;
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

	const writeSession = (stem: string) => {
		const abs = join(sessionDir, `${stem}.jsonl`);
		writeFileSync(
			abs,
			`${JSON.stringify({ type: "session", version: 3, id: stem, timestamp: "2026-01-01T00:00:00Z", cwd: root })}\n`,
		);
		return abs;
	};

	const verbs: DaemonVerbs = {
		listSessions: async () => ({ sessions: [], hasMore: false }),
		listQueue: async () => [],
		// Archive ends the runtime, so the shim stops it the way the Daemon's
		// verb does; Inbox and Later are the Worker's storage write.
		setSessionLocation: async (projectId, stem, location) => {
			if (location !== "archive") return { ok: true };
			try {
				await worker.closeSession({ projectId, stem });
				return { ok: true };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},
		getDaemonInfo: async () => ({
			projects: [],
			models: [],
			pinnedModels: [],
			visibleModels: [],
			thinkingLevels: [],
			devMode: false,
		}),
		setPinnedModels: async () => {},
		asrCredentials: async () => ({ kind: "device", deviceId: "d" }),
		textPolish: async (text: string) => text,
		openSession: async (_projectId, stem, conn, cursor) => {
			writeSession(stem);
			const ref = await attachObserved(conn, worker, (sink) =>
				worker.observeSession({ projectId: "proj", stem }, { cursor: cursor ?? null, sink }),
			);
			return { ok: true, session: ref };
		},
		newSession: async (_projectId, conn, text) => {
			const ref = await attachObserved(conn, worker, (sink) => worker.createSession("proj", { text, sink }));
			return { ok: true, session: ref };
		},
		detach: (conn) => conn.detach(),
		trashSession: async () => ({ ok: false, error: "unused" }),
		sessionsChanged: (projectId) => sessionsChanged.push(projectId),
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

	return { worker, project, managers, verbs, sessionsChanged };
}

/** The Daemon's attach shape: the Connection supplies the sink before the
 * observation exists, so the initial sync already belongs to the attachment. */
async function attachObserved(
	conn: Connection,
	worker: LocalWorker,
	open: (sink: WorkerObservationSink) => Promise<ObservedSession>,
): Promise<SessionRef> {
	const target = await conn.attach(async (sink) => {
		const observed = await open(sink);
		return {
			target: observed.target,
			observation: observed.observation,
			commands: bindWorkerCommands(worker, observed.target, observed.observation),
		};
	});
	return { projectId: target.projectId, stem: target.stem, sessionId: target.sessionId };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

async function connect(
	bundle: Bundle,
	stem: string,
): Promise<{ conn: Connection; clientWs: WebSocket; frames: unknown[] }> {
	const { serverWs, clientWs } = await createWsPair();
	await waitForOpen(clientWs);
	const frames = collectFrames(clientWs);
	const conn = new Connection(serverWs, bundle.verbs, null, false);
	cleanups.push(() => {
		serverWs.close();
		clientWs.close();
	});
	const abs = join(bundle.project.sessionDir, `${stem}.jsonl`);
	if (!existsSync(abs))
		writeFileSync(
			abs,
			`${JSON.stringify({ type: "session", version: 3, id: stem, timestamp: "2026-01-01T00:00:00Z", cwd: bundle.project.cwd })}\n`,
		);
	await attachObserved(conn, bundle.worker, (sink) =>
		bundle.worker.observeSession({ projectId: "proj", stem }, { cursor: null, sink }),
	);
	return { conn, clientWs, frames };
}

function replyFor(frames: unknown[], id: string): Promise<Record<string, unknown>> {
	return waitForFrame(frames, (f) => (f as Record<string, unknown>).id === id) as Promise<Record<string, unknown>>;
}

async function waitForCall(tm: TraceManager, call: string): Promise<void> {
	for (let i = 0; i < 200 && !tm.calls.includes(call); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(tm.calls).toContain(call);
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

describe("Connection protocol traces", () => {
	it("close during prompt: the command settles, then the terminal boundary arrives", async () => {
		const bundle = makeBundle();
		const { conn, clientWs, frames } = await connect(bundle, "s1");
		const tm = bundle.managers.get("s1")!;
		tm.holdNextAdmission();

		clientWs.send(JSON.stringify({ id: "p1", verb: "prompt", text: "hi" }));
		await waitForCall(tm, "prompt");

		// The kill lands while the prompt's preflight is still running: disposal
		// releases the admitted command, which settles against the runtime it
		// captured, and the terminal ownership boundary follows.
		await bundle.worker.closeSession({ projectId: "proj", stem: "s1" });

		const promptReply = await replyFor(frames, "p1");
		expect(promptReply.ok).toBe(true);
		const closed = await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "session_closed");
		expect((closed as Record<string, unknown>).stem).toBe("s1");
		// The Connection no longer holds the dead runtime's observation.
		expect(conn.isAttached).toBe(false);
		expect(tm.disposeCalls()).toBe(1);
	});

	it("switch during rename: the command reports on the session it named", async () => {
		const bundle = makeBundle();
		const { clientWs, frames } = await connect(bundle, "a");
		const tmA = bundle.managers.get("a")!;

		clientWs.send(JSON.stringify({ id: "r1", verb: "renameSession", name: "new-name" }));
		await waitForCall(tmA, "rename");

		// The switch completes under the running rename.
		clientWs.send(JSON.stringify({ id: "o1", verb: "openSession", projectId: "proj", stem: "b" }));
		const openReply = await replyFor(frames, "o1");
		expect(openReply.ok).toBe(true);

		// The rename finishes against the session it was issued for — never
		// retargeted by the switch — and the broadcast belongs to that session.
		tmA.release();
		const renameReply = await replyFor(frames, "r1");
		expect(renameReply.ok).toBe(true);
		expect(bundle.managers.get("a")!.calls).toContain("rename");
		expect(bundle.sessionsChanged).toEqual(["proj"]);
	});

	it("a pull reply describes the session it was issued against", async () => {
		const bundle = makeBundle();
		const { clientWs, frames } = await connect(bundle, "a");

		// The pull is computed synchronously at handler entry, so a switch that
		// arrives after it cannot change what the reply reports.
		clientWs.send(
			JSON.stringify({
				id: "pull1",
				verb: "pull",
				requests: [{ entryId: "e1", fieldPath: "/entries/e1/content/0/text" }],
			}),
		);
		clientWs.send(JSON.stringify({ id: "o1", verb: "openSession", projectId: "proj", stem: "b" }));
		const openReply = await replyFor(frames, "o1");
		expect(openReply.ok).toBe(true);

		const pullReply = (await replyFor(frames, "pull1")) as { values: { value: string }[] };
		expect(pullReply.values[0].value).toBe("body-a");
	});

	it("a Session's full lifecycle crosses every owner exactly once", async () => {
		const bundle = makeBundle();
		// Connection 1 opens the address; Connection 2 joins the same
		// Activation (one registration, two observations).
		const c1 = await connect(bundle, "life");
		const c2 = await connect(bundle, "life");
		const tm = bundle.managers.get("life")!;
		expect(bundle.worker.liveRecords()).toHaveLength(1);
		tm.holdNextAdmission();

		// A turn runs on conn 1; conn 2 reads a lazy value while it streams.
		c1.clientWs.send(JSON.stringify({ id: "p1", verb: "prompt", text: "hi" }));
		await waitForCall(tm, "prompt");
		c2.clientWs.send(
			JSON.stringify({
				id: "pull1",
				verb: "pull",
				requests: [{ entryId: "e1", fieldPath: "/entries/e1/content/0/text" }],
			}),
		);
		const pullReply = (await replyFor(c2.frames, "pull1")) as { ok: boolean; values: unknown[] };
		expect(pullReply.ok).toBe(true);
		expect(pullReply.values.length).toBe(1);

		// The close crosses the terminal boundary: the admitted turn settles
		// (disposal aborts it), both observations end, both clients learn, and
		// the runtime is disposed exactly once.
		await bundle.worker.closeSession({ projectId: "proj", stem: "life" });
		const promptReply = await replyFor(c1.frames, "p1");
		expect(promptReply.ok).toBe(true);
		await waitForFrame(c1.frames, (f) => (f as Record<string, unknown>).kind === "session_closed");
		await waitForFrame(c2.frames, (f) => (f as Record<string, unknown>).kind === "session_closed");
		expect(c1.conn.isAttached).toBe(false);
		expect(c2.conn.isAttached).toBe(false);
		expect(tm.disposeCalls()).toBe(1);

		// A late command on either Connection is refused, not run.
		c2.clientWs.send(JSON.stringify({ id: "p2", verb: "prompt", text: "late" }));
		const late = await replyFor(c2.frames, "p2");
		expect(late.ok).toBe(false);
		expect(late.error).toBe("no session attached");

		// Shutdown drains what remains: nothing registers afterwards.
		await bundle.worker.dispose();
		expect(tm.disposeCalls()).toBe(1);
	});

	it("newSession attributes its initial sync and reply with the operation id", async () => {
		const bundle = makeBundle();
		const { serverWs, clientWs } = await createWsPair();
		await waitForOpen(clientWs);
		const frames = collectFrames(clientWs);
		new Connection(serverWs, bundle.verbs, null, false);
		cleanups.push(() => {
			serverWs.close();
			clientWs.close();
		});

		// An unattributed creation is refused before anything is created.
		clientWs.send(JSON.stringify({ id: "n1", verb: "newSession", projectId: "proj", text: "hello" }));
		const missing = await replyFor(frames, "n1");
		expect(missing.ok).toBe(false);
		expect(missing.error).toBe("Missing `operationId`");

		// The creation's initial sync carries the operation id (the frame is
		// emitted inside the transition, so the attribution window is exact),
		// and so does the reply.
		clientWs.send(
			JSON.stringify({ id: "n2", verb: "newSession", projectId: "proj", text: "hello", operationId: "op-9" }),
		);
		const sync = (await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "replace")) as Record<
			string,
			unknown
		>;
		expect(sync.operationId).toBe("op-9");
		const reply = await replyFor(frames, "n2");
		expect(reply.ok).toBe(true);
		expect(reply.operationId).toBe("op-9");

		// A plain open's initial sync stays unattributed.
		clientWs.send(JSON.stringify({ id: "o1", verb: "openSession", projectId: "proj", stem: "plain" }));
		const sync2 = (await waitForFrame(
			frames,
			(f) => (f as Record<string, unknown>).kind === "replace" && f !== sync,
		)) as Record<string, unknown>;
		expect(sync2.operationId).toBeUndefined();
	});

	it("session_closed precedes the archive reply on the closing Connection", async () => {
		const bundle = makeBundle();
		const { clientWs, frames } = await connect(bundle, "s4");

		clientWs.send(
			JSON.stringify({ id: "c1", verb: "setSessionLocation", projectId: "proj", stem: "s4", location: "archive" }),
		);
		await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "session_closed");
		const closeReply = await replyFor(frames, "c1");
		expect(closeReply.ok).toBe(true);
		// The terminal push landed first: the client learns the runtime ended
		// before the operation it requested is acknowledged.
		const closedIndex = frames.findIndex((f) => (f as Record<string, unknown>).kind === "session_closed");
		const replyIndex = frames.findIndex((f) => (f as Record<string, unknown>).id === "c1");
		expect(closedIndex).toBeLessThan(replyIndex);
	});

	it("a stale terminal frame never detaches the successor attachment", async () => {
		const bundle = makeBundle();
		const { serverWs, clientWs } = await createWsPair();
		await waitForOpen(clientWs);
		const frames = collectFrames(clientWs);
		const conn = new Connection(serverWs, bundle.verbs, null, false);
		cleanups.push(() => {
			serverWs.close();
			clientWs.close();
		});

		const writeHeader = (stem: string) => {
			writeFileSync(
				join(bundle.project.sessionDir, `${stem}.jsonl`),
				`${JSON.stringify({ type: "session", version: 3, id: stem, timestamp: "2026-01-01T00:00:00Z", cwd: bundle.project.cwd })}\n`,
			);
		};
		// The Daemon's attach shape, with the observation's sink captured so the
		// test can deliver a terminal frame by hand — exactly as the Worker does
		// when an archive move of the switched-away session races the switch.
		const attach = async (stem: string, capture: { sink?: WorkerObservationSink }) => {
			await conn.attach(async (sink) => {
				capture.sink = sink;
				const observed = await bundle.worker.observeSession({ projectId: "proj", stem }, { cursor: null, sink });
				return {
					target: observed.target,
					observation: observed.observation,
					commands: bindWorkerCommands(bundle.worker, observed.target, observed.observation),
				};
			});
		};

		writeHeader("stale-a");
		writeHeader("stale-b");
		const a: { sink?: WorkerObservationSink } = {};
		const b: { sink?: WorkerObservationSink } = {};
		await attach("stale-a", a);
		await attach("stale-b", b);
		expect(conn.attachedSession?.stem).toBe("stale-b");

		// A's late terminal frame (generation 1) crosses the wire — the client
		// drops it there by its generation — and must not detach B server-side.
		a.sink!({ kind: "closed", address: { projectId: "proj", stem: "stale-a" } });
		const staleClosed = (await waitForFrame(
			frames,
			(f) => (f as Record<string, unknown>).kind === "session_closed",
		)) as Record<string, unknown>;
		expect(staleClosed.stem).toBe("stale-a");
		expect(staleClosed.generation).toBe(1);
		expect(conn.isAttached).toBe(true);
		expect(conn.attachedSession?.stem).toBe("stale-b");

		// B's attachment still serves commands.
		clientWs.send(JSON.stringify({ id: "d1", verb: "discardSteer" }));
		const reply = await replyFor(frames, "d1");
		expect(reply.ok).toBe(true);

		// The current attachment's terminal frame (generation 2) does end it.
		b.sink!({ kind: "closed", address: { projectId: "proj", stem: "stale-b" } });
		const currentClosed = (await waitForFrame(
			frames,
			(f) => (f as Record<string, unknown>).kind === "session_closed" && f !== staleClosed,
		)) as Record<string, unknown>;
		expect(currentClosed.generation).toBe(2);
		expect(conn.isAttached).toBe(false);
	});
});
