// Connection protocol traces — the cross-boundary acceptance cases for the
// lease-based attachment model: a close that lands while a command runs, a
// switch that completes under a running command, a pull reply that describes
// the session it was issued against, and the terminal-ownership ordering of
// `session_closed` against command replies. These run the real verb →
// ExecutionLink → registry path, not stubs of it.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { Document, SessionRef } from "../../src/core/index.ts";
import type { DaemonVerbs } from "../../src/host/connection.ts";
import { Connection } from "../../src/host/connection.ts";
import { createLocalExecutionLink, type ExecutionLink } from "../../src/host/execution-link.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { collectFrames, createWsPair, waitForFrame, waitForOpen } from "./conn-helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TraceManager {
	manager: Manager;
	calls: string[];
	/** Release a gated operation (rename). */
	release: () => void;
	disposeCalls: () => number;
}

/** A Manager stand-in: records calls; `prompt` settles when disposal
 * releases it (as a real abort would); `renameSession` is gated. */
function traceManager(stem: string): TraceManager {
	const calls: string[] = [];
	let disposed = 0;
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
		sessionFile: `/proj/sessions/${stem}.jsonl`,
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection(handle: ConnectionHandle) {
			handle.onInitialSync({ kind: "replace", session: ref, document });
		},
		removeConnection: () => {},
		onSettled: () => () => {},
		prompt: async () => {
			calls.push("prompt");
			await gate(); // released by disposal (the abort path) or by hand
		},
		promptAdmitted: async () => {},
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
		disposeCalls: () => disposed,
	};
}

interface Bundle {
	link: ExecutionLink;
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
	const link = createLocalExecutionLink({
		openManager: async (_p, abs) => {
			const stem = basename(abs, ".jsonl");
			const tm = traceManager(stem);
			managers.set(stem, tm);
			return tm.manager;
		},
		createManager: async () => {
			throw new Error("not used");
		},
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		requestedThinkingLevel: () => "off",
		onSettled: () => {},
		onStreamingChange: () => {},
		onRegistryChange: () => {},
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
		listActiveSessions: () => [],
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
		openSession: async (_projectId, stem, conn, cursor) => {
			const abs = writeSession(stem);
			const activation = await link.open(conn, project, stem, abs, cursor ?? null);
			return { ok: true, session: activation.ref };
		},
		newSession: async () => ({ ok: false, error: "unused" }),
		detach: (conn) => link.release(conn),
		closeSession: async (projectId, stem) => {
			const activation = await link.awaitSettled(projectId, stem);
			if (!activation) return { ok: false, error: `Session is not active: ${stem}` };
			await link.collect(activation);
			return { ok: true };
		},
		archiveSession: async () => ({ ok: false, error: "unused" }),
		sessionsChanged: (projectId) => sessionsChanged.push(projectId),
		listFiles: () => [],
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

	return { link, project, managers, verbs, sessionsChanged };
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
	await bundle.link.open(conn, bundle.project, stem, abs, null);
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

		clientWs.send(JSON.stringify({ id: "p1", verb: "prompt", text: "hi" }));
		await waitForCall(tm, "prompt");

		// The kill lands while the command runs: disposal aborts the turn, the
		// admitted command settles against the runtime it captured, and the
		// terminal ownership boundary follows.
		await bundle.link.collect(bundle.link.byAddressAny("proj", "s1")!);

		const promptReply = await replyFor(frames, "p1");
		expect(promptReply.ok).toBe(true);
		const closed = await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "session_closed");
		expect((closed as Record<string, unknown>).stem).toBe("s1");
		// The Connection no longer holds the dead runtime's lease.
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

	it("session_closed precedes the close reply on the closing Connection", async () => {
		const bundle = makeBundle();
		const { clientWs, frames } = await connect(bundle, "s4");

		clientWs.send(JSON.stringify({ id: "c1", verb: "closeSession", projectId: "proj", stem: "s4" }));
		await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "session_closed");
		const closeReply = await replyFor(frames, "c1");
		expect(closeReply.ok).toBe(true);
		// The terminal push landed first: the client learns the runtime ended
		// before the operation it requested is acknowledged.
		const closedIndex = frames.findIndex((f) => (f as Record<string, unknown>).kind === "session_closed");
		const replyIndex = frames.findIndex((f) => (f as Record<string, unknown>).id === "c1");
		expect(closedIndex).toBeLessThan(replyIndex);
	});
});
