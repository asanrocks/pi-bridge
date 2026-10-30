// ExecutionLink — the seam between the Daemon and Session execution. The
// local implementation owns the Activation registry and the per-session
// choreography; these tests drive it through the interface (as a future
// remote link would be driven), pinning the registration authorization
// identity and the admission/drain behavior the seam promises.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { Document } from "../../src/core/index.ts";
import { Connection } from "../../src/host/connection.ts";
import type { DaemonVerbs } from "../../src/host/connection-verbs.ts";
import { createLocalExecutionLink, type ExecutionLink, type ManagerFactory } from "../../src/host/execution-link.ts";
import type { ConnectionHandle, Manager } from "../../src/host/manager.ts";
import type { ProjectConfig } from "../../src/host/projects.ts";
import { collectFrames, createWsPair, waitForFrame, waitForOpen } from "./conn-helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A Manager stand-in: only the members the registry path under test reads. */
function stubManager(sessionPath: string | undefined): Manager & { disposeCalls: () => number } {
	const sessionId = sessionPath ? basename(sessionPath, ".jsonl") : `fresh-${Math.random().toString(36).slice(2)}`;
	const connectionHandles = new Set<ConnectionHandle>();
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
		} as Document,
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
		renameSession: async () => {},
		setLabel: async () => {},
		navigate: async () => {},
		recoverTurn: async () => "retry" as const,
		dispose: async () => {
			disposed += 1;
		},
	};
	return { ...base, disposeCalls: () => disposed } as unknown as Manager & { disposeCalls: () => number };
}

interface StubBundle {
	link: ExecutionLink;
	project: ProjectConfig;
	managers: Array<Manager & { disposeCalls: () => number }>;
}

function makeLink(): StubBundle {
	const root = join(tmpdir(), `pi-bridge-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const project: ProjectConfig = { id: "proj", cwd: root, sessionDir };
	const managers: Array<Manager & { disposeCalls: () => number }> = [];
	const factory: ManagerFactory = async (opts) => {
		const manager = stubManager(opts?.sessionPath);
		managers.push(manager);
		return manager;
	};
	const link = createLocalExecutionLink({
		openManager: async (p, abs) => factory({ cwd: p.cwd, sessionPath: abs }),
		createManager: async (p) => factory({ cwd: p.cwd }),
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
		requestedThinkingLevel: () => "off",
		onSettled: () => {},
		onStreamingChange: () => {},
		onRegistryChange: () => {},
	});
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return { link, project, managers };
}

/** Minimal verb surface: the Connection exists to be attached, detached, and
 * notified — no verb is exercised through it here. */
const stubVerbs: DaemonVerbs = {
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
	openSession: async () => ({ ok: false, error: "unused" }),
	newSession: async () => ({ ok: false, error: "unused" }),
	detach: () => {},
	closeSession: async () => ({ ok: false, error: "unused" }),
	archiveSession: async () => ({ ok: false, error: "unused" }),
	sessionsChanged: () => {},
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

async function connectTo(
	link: ExecutionLink,
	bundle: StubBundle,
	stem: string,
): Promise<{ conn: Connection; clientWs: WebSocket; frames: unknown[] }> {
	const abs = writeSession(bundle, stem);
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
	await link.open(conn, bundle.project, stem, abs, null);
	return { conn, clientWs, frames };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionLink (local)", () => {
	it("assigns each activation a generation unique within the link's incarnation", async () => {
		const bundle = makeLink();
		const { link } = bundle;

		await connectTo(link, bundle, "gen-a");
		await connectTo(link, bundle, "gen-b");
		const recA = link.byAddressAny("proj", "gen-a")!;
		const recB = link.byAddressAny("proj", "gen-b")!;
		expect(recA.authorization.incarnation).toBe(link.incarnation);
		expect(recA.authorization.generation).toBe(1);
		expect(recB.authorization.generation).toBe(2);

		// A replaced registration never reuses its predecessor's generation.
		await link.collect(recA);
		await connectTo(link, bundle, "gen-a");
		expect(link.byAddressAny("proj", "gen-a")!.authorization.generation).toBe(3);

		// Each link is its own incarnation: generations are scoped to it.
		const other = makeLink();
		expect(other.link.incarnation).not.toBe(link.incarnation);
	});

	it("collect detaches the connection and pushes session_closed", async () => {
		const bundle = makeLink();
		const { link } = bundle;
		const { conn, frames } = await connectTo(link, bundle, "term-1");
		const record = link.byAddressAny("proj", "term-1")!;
		expect(conn.isAttached).toBe(true);

		await link.collect(record);

		// The terminal ownership boundary: the attachment is severed and the
		// client learns the runtime ended.
		expect(conn.isAttached).toBe(false);
		const closed = await waitForFrame(frames, (f) => (f as Record<string, unknown>).kind === "session_closed");
		expect((closed as Record<string, unknown>).stem).toBe("term-1");
		expect((closed as Record<string, unknown>).projectId).toBe("proj");
		// Live listings drop the address after collection.
		expect(link.live().some((r) => r.ref.stem === "term-1")).toBe(false);
	});

	it("a session command after collection is refused, not run against the dead runtime", async () => {
		const bundle = makeLink();
		const { link } = bundle;
		const { clientWs, frames } = await connectTo(link, bundle, "term-2");
		const record = link.byAddressAny("proj", "term-2")!;

		// A prompt RPC arrives after the terminal boundary: the lease the
		// command would address is gone, so it fails loudly instead of
		// reaching a disposed Manager.
		await link.collect(record);
		clientWs.send(JSON.stringify({ id: "rpc-1", verb: "prompt", text: "late" }));
		const reply = (await waitForFrame(frames, (f) => (f as Record<string, unknown>).id === "rpc-1")) as Record<
			string,
			unknown
		>;
		expect(reply.ok).toBe(false);
		expect(reply.error).toBe("no session attached");
	});

	it("release detaches without disposing the activation", async () => {
		const bundle = makeLink();
		const { link } = bundle;
		const { conn } = await connectTo(link, bundle, "rel-1");
		const record = link.byAddressAny("proj", "rel-1")!;

		link.release(conn);
		expect(conn.isAttached).toBe(false);
		// Detach is not a kill: the activation stays live (for idle collection).
		expect(link.live()).toContain(record);
		expect((record.actor.manager as unknown as { disposeCalls: () => number }).disposeCalls()).toBe(0);
	});

	it("dispose refuses further work and disposes the remaining Managers", async () => {
		const bundle = makeLink();
		const { link } = bundle;
		await connectTo(link, bundle, "shut-1");
		const record = link.byAddressAny("proj", "shut-1")!;
		expect(existsSync(join(bundle.project.sessionDir, "shut-1.jsonl"))).toBe(true);

		await link.dispose();
		expect((record.actor.manager as unknown as { disposeCalls: () => number }).disposeCalls()).toBe(1);

		// Admission ends with the drain: nothing registers afterwards.
		const abs = writeSession(bundle, "shut-2");
		const { serverWs, clientWs } = await createWsPair();
		await waitForOpen(clientWs);
		const conn2 = new Connection(serverWs, stubVerbs, null, false);
		cleanups.push(() => {
			serverWs.close();
			clientWs.close();
		});
		await expect(link.open(conn2, bundle.project, "shut-2", abs, null)).rejects.toThrow(/shutting down/);
		expect(link.byAddressAny("proj", "shut-2")).toBeUndefined();
	});
});
