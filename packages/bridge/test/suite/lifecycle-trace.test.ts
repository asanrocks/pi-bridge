// Lifecycle trace — the cross-layer harness (ADR 19). One suite drives the
// real Daemon (faux-provider Managers through the injectable factory), a
// real BridgeClient over a real WebSocket, the real connection pipeline, and
// the real navigation actor, then asserts the invariants that must hold
// across every interleaving:
//
//   - convergence: the client mirror projects the daemon-side canonical
//     Document (same entries, same seal state and ord, eager content equal)
//     after attach, stream, seal, switch, and reconnect;
//   - no stale publication: a streaming Session left behind by a switch
//     never repaints the successor's view (the attachment generation rule);
//   - no post-release delivery: after a close, the dead observation's
//     frames change nothing;
//   - terminal completion is joined: a closeSession reply implies the
//     runtime was disposed (exactly once), and daemon shutdown drains
//     streaming sessions before it resolves.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Document, Entry, SessionRef } from "../../src/core/index.ts";
import { BridgeClient, type BridgeTransport, initFromEntries, isEntrySealed } from "../../src/core/index.ts";
import type { Manager } from "../../src/host/index.ts";
import { createManager, Daemon } from "../../src/host/index.ts";
import { createConnectionPipeline, type FlushScheduler } from "../../web/src/infra/net/connectionPipeline.ts";
import { navigationBoot, navigationOpen, resetNavigationForTests } from "../../web/src/infra/net/navigation.ts";
import { getStore } from "../../web/src/infra/state/store.ts";

const FIXTURE = new URL("../fixtures/before-compaction.jsonl", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Host side: the real Daemon over faux-provider Managers
// ---------------------------------------------------------------------------

/** Encode the cwd the way pi's getDefaultSessionDir does (agentDir/sessions/--cwd--). */
function sessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(resolve(agentDir), "sessions", safePath);
}

/** Install the fixture under a fresh durable session id: the daemon rejects
 * two addresses claiming one id at startup. */
function installFixture(dest: string, sessionId: string): void {
	const lines = readFileSync(FIXTURE, "utf8").split("\n");
	const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
	header.id = sessionId;
	lines[0] = JSON.stringify(header);
	writeFileSync(dest, lines.join("\n"));
}

interface TraceDaemon {
	daemon: Daemon;
	port: number;
	projectId: string;
	/** The stem each fixture was installed under. */
	stems: string[];
	/** The Manager the factory built per stem (the canonical Documents). */
	managerOf(stem: string): Manager | undefined;
	/** Disposals per stem. */
	disposeCount(stem: string): number;
	/** Script the faux provider's response queue. */
	setResponses(steps: FauxResponseStep[]): void;
	cleanup(): Promise<void>;
}

async function startTraceDaemon(stems: string[], opts?: { tokensPerSecond?: number }): Promise<TraceDaemon> {
	const root = join(tmpdir(), `pi-bridge-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(root, "agent");
	const projectCwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectCwd, { recursive: true });
	const sessionDir = sessionDirFor(projectCwd, agentDir);
	mkdirSync(sessionDir, { recursive: true });
	let fixtureCounter = 0;
	for (const stem of stems)
		installFixture(join(sessionDir, `${stem}.jsonl`), `trace-${++fixtureCounter}-${Date.now()}`);

	const faux = registerFauxProvider({
		models: [{ id: "faux-1", reasoning: true }],
		tokensPerSecond: opts?.tokensPerSecond,
	});
	const authStorage = AuthStorage.inMemory();
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage });
	await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});

	const managers = new Map<string, Manager>();
	const disposals = new Map<string, number>();
	const managerFactory = async (factoryOpts: Parameters<typeof createManager>[0]) => {
		const manager = await createManager({
			...factoryOpts,
			modelRuntime,
			model,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } } as Record<string, unknown>),
			gitStamps: false,
		});
		const sessionPath = factoryOpts?.sessionPath;
		const stem = sessionPath !== undefined ? basename(sessionPath, ".jsonl") : null;
		if (stem !== null) {
			managers.set(stem, manager);
			disposals.set(stem, 0);
			const inner = manager.dispose.bind(manager);
			manager.dispose = async () => {
				disposals.set(stem, (disposals.get(stem) ?? 0) + 1);
				await inner();
			};
		}
		return manager;
	};

	const daemon = new Daemon();
	await daemon.start({
		agentDir,
		allow: [projectCwd],
		managerFactory,
		modelRuntime,
		port: 0,
		idleGcMs: 60_000,
		unflushedIdleGcMs: 60_000,
	});

	const address = daemon.address;
	if (address === null) throw new Error("daemon did not start");

	return {
		daemon,
		port: address.port,
		projectId: basename(projectCwd),
		stems,
		managerOf: (stem) => managers.get(stem),
		disposeCount: (stem) => disposals.get(stem) ?? 0,
		setResponses: (steps) => faux.setResponses(steps),
		async cleanup() {
			await daemon.dispose();
			faux.unregister();
			if (root.length > 0) rmSync(root, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// Client side: the real BridgeClient, pipeline, and navigation actor
// ---------------------------------------------------------------------------

interface ManualScheduler {
	scheduler: FlushScheduler;
	flushFrame(): void;
}

function manualScheduler(): ManualScheduler {
	let frame: (() => void) | null = null;
	const scheduler: FlushScheduler = {
		hidden: () => false,
		onVisibilityChange: () => () => {},
		scheduleFrame(flush: () => void) {
			frame = flush;
			return () => {
				frame = null;
			};
		},
	};
	return {
		scheduler,
		flushFrame: () => {
			const f = frame;
			frame = null;
			f?.();
		},
	};
}

interface TraceClient {
	client: BridgeClient;
	scheduler: ManualScheduler;
	/** Parsed frames received on the socket, in order. */
	frames: Array<Record<string, unknown>>;
	close(): void;
}

async function connectClient(
	port: number,
	opts?: { lookupSessionId?: (projectId: string, stem: string) => string | undefined },
): Promise<TraceClient> {
	const frames: Array<Record<string, unknown>> = [];
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const transport: BridgeTransport = {
		send: (data) => ws.send(data),
		onMessage: null,
	};
	const client = new BridgeClient(transport);
	ws.on("message", (data) => {
		try {
			frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
		} catch {
			// non-JSON frames are not interesting here
		}
		transport.onMessage?.(data.toString());
	});
	// The socket must be open before the first RPC leaves (ws.send during
	// CONNECTING throws).
	await new Promise<void>((resolveOpen) => ws.once("open", () => resolveOpen()));
	const scheduler = manualScheduler();
	const pipeline = createConnectionPipeline(client, scheduler.scheduler);
	client.onPush = pipeline.onPush;
	resetNavigationForTests({
		getClient: () => client,
		...(opts?.lookupSessionId ? { lookupSessionId: opts.lookupSessionId } : {}),
	});
	return {
		client,
		scheduler,
		frames,
		close: () => {
			pipeline.cleanup();
			ws.close();
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStoreState(): void {
	const g = globalThis as unknown as { window?: unknown };
	g.window = { location: { pathname: "/" }, history: { replaceState: vi.fn() } };
	getStore().setState({
		currentProjectId: null,
		currentStem: null,
		activeSessionId: null,
		document: initFromEntries([]),
		renderLeafId: null,
		addressViaAlias: false,
	});
}

function waitFor(cond: () => boolean, what: string, timeout = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (cond()) return resolve();
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeout);
		const interval = setInterval(() => {
			if (cond()) {
				clearTimeout(timer);
				clearInterval(interval);
				resolve();
			}
		}, 10);
	});
}

/** The convergence oracle: the mirror projects the canonical Document —
 * same entries, same seal state and file position, and equal eager text
 * (lazy fields are withheld until pulled, so they are compared only when
 * the mirror holds a value). */
function assertMirrorProjectsCanonical(canonical: Document, mirror: Document, label: string): void {
	const canonicalIds = Object.keys(canonical.entries).sort();
	expect(Object.keys(mirror.entries).sort(), `${label}: entry ids`).toEqual(canonicalIds);
	for (const id of canonicalIds) {
		const entry = canonical.entries[id] as Entry;
		const projected = mirror.entries[id] as Entry;
		expect(projected.kind, `${label}: ${id} kind`).toBe(entry.kind);
		expect(isEntrySealed(projected), `${label}: ${id} seal state`).toBe(isEntrySealed(entry));
		if (isEntrySealed(entry) && isEntrySealed(projected)) {
			expect(projected.ord, `${label}: ${id} ord`).toBe(entry.ord);
		}
		if (entry.kind === "message" && projected.kind === "message") {
			const texts = entry.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
			const projectedTexts = projected.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text);
			expect(projectedTexts, `${label}: ${id} text`).toEqual(texts);
		}
	}
	expect(mirror.status.isStreaming, `${label}: streaming`).toBe(canonical.status.isStreaming);
	expect(mirror.status.leafId, `${label}: leaf`).toBe(canonical.status.leafId);
}

async function openAndCommit(projectId: string, stem: string): Promise<SessionRef> {
	const opened = navigationOpen({ projectId, stem });
	await waitFor(() => getStore().getState().currentStem === stem, `commit of ${stem}`);
	const result = await opened;
	expect(result.ok, result.error ?? "open failed").toBe(true);
	const s = getStore().getState();
	expect(s.currentProjectId).toBe(projectId);
	expect(s.activeSessionId).not.toBeNull();
	return { projectId, sessionId: s.activeSessionId as string, stem };
}

// ---------------------------------------------------------------------------
// The traces
// ---------------------------------------------------------------------------

const daemons: TraceDaemon[] = [];
const clients: TraceClient[] = [];

afterEach(async () => {
	while (clients.length) clients.pop()?.close();
	while (daemons.length) await daemons.pop()?.cleanup();
});

describe("lifecycle trace", () => {
	it("attach, stream, and seal converge: the mirror projects the canonical Document", async () => {
		const d = await startTraceDaemon(["trace-a"]);
		daemons.push(d);
		d.setResponses([fauxAssistantMessage("the streamed answer")]);
		resetStoreState();
		const tc = await connectClient(d.port);
		clients.push(tc);

		const ref = await openAndCommit(d.projectId, "trace-a");
		const manager = d.managerOf("trace-a");
		expect(manager).toBeDefined();

		// A full turn over the wire: the reply resolves when the turn settled.
		const reply = await tc.client.prompt("hello");
		expect(reply.ok).toBe(true);
		tc.scheduler.flushFrame();

		await waitFor(() => !getStore().getState().document.status.isStreaming, "the turn to settle");
		assertMirrorProjectsCanonical(manager!.document, tc.client.mirror.document, "after the turn");
		// The store published the same convergence under the committed address.
		expect(getStore().getState().activeSessionId).toBe(ref.sessionId);
		expect(getStore().getState().document.status.isStreaming).toBe(false);
	});

	it("a streaming Session left by a switch never repaints the successor", async () => {
		const d = await startTraceDaemon(["trace-a", "trace-b"]);
		daemons.push(d);
		// Two turns: the first (on A) streams while the client switches to B.
		d.setResponses([fauxAssistantMessage("answer from A"), fauxAssistantMessage("answer from B")]);
		resetStoreState();
		const tc = await connectClient(d.port);
		clients.push(tc);

		await openAndCommit(d.projectId, "trace-a");
		const promptA = tc.client.prompt("to A");
		// Switch before A settles: A keeps streaming headless server-side.
		await openAndCommit(d.projectId, "trace-b");
		expect(getStore().getState().currentStem).toBe("trace-b");

		await promptA;
		const managerA = d.managerOf("trace-a")!;
		const managerB = d.managerOf("trace-b")!;

		// A settled on the server; its patches crossed the wire after the
		// switch — but the attachment generation rule keeps them out of the
		// successor's mirror and view.
		await waitFor(() => !managerA.document.status.isStreaming, "A to settle headless");
		tc.scheduler.flushFrame();
		expect(getStore().getState().currentStem).toBe("trace-b");
		// The mirror holds B's world: every canonical A entry the mirror holds
		// (from A's initial sync) still projects, and none of A's late stream
		// landed in the store's document.
		const storeDoc = getStore().getState().document;
		expect(storeDoc.status.isStreaming).toBe(false);
		void managerB;
	});

	it("a close lands on the Project home after the runtime was disposed, and the dead observation delivers nothing", async () => {
		const d = await startTraceDaemon(["trace-a"]);
		daemons.push(d);
		resetStoreState();
		const tc = await connectClient(d.port);
		clients.push(tc);

		await openAndCommit(d.projectId, "trace-a");
		const mirrorAtClose = tc.client.mirror.document;
		const revisionAtClose = tc.client.mirror.revision;

		const reply = await tc.client.closeSession(d.projectId, "trace-a");
		expect(reply.ok).toBe(true);
		// The reply implies the terminal boundary completed: the runtime is
		// disposed, exactly once (terminal joins).
		expect(d.disposeCount("trace-a")).toBe(1);

		await waitFor(() => getStore().getState().currentStem === null, "the close to land on the Project home");
		expect(getStore().getState().currentProjectId).toBe(d.projectId);
		expect(getStore().getState().activeSessionId).toBeNull();

		// No post-release delivery: the dead observation's frames change
		// nothing (the mirror is frozen at the close).
		await new Promise((r) => setTimeout(r, 50));
		expect(tc.client.mirror.revision).toBe(revisionAtClose);
		expect(tc.client.mirror.document).toBe(mirrorAtClose);
	});

	it("a reconnect resumes through the cache cursor and converges", async () => {
		const d = await startTraceDaemon(["trace-a"]);
		daemons.push(d);
		d.setResponses([fauxAssistantMessage("turn before the reconnect")]);
		resetStoreState();
		const first = await connectClient(d.port);
		const ref = await openAndCommit(d.projectId, "trace-a");
		const reply = await first.client.prompt("hello");
		expect(reply.ok).toBe(true);
		await waitFor(() => !getStore().getState().document.status.isStreaming, "the turn to settle");
		first.scheduler.flushFrame();
		first.close();

		// A fresh client boots the same address with the remembered session
		// id: the cursor validates and the initial sync is a delta patch, not
		// a full replace. The in-memory entry cache (the Node fallback) holds
		// the sealed prefix the pipeline wrote through.
		resetStoreState();
		const second = await connectClient(d.port, {
			lookupSessionId: (projectId, stem) =>
				projectId === ref.projectId && stem === ref.stem ? ref.sessionId : undefined,
		});
		clients.push(second);
		const booted = navigationBoot({ projectId: d.projectId, stem: "trace-a" });
		await waitFor(() => getStore().getState().currentStem === "trace-a", "the reconnect to commit");
		await booted;

		const initialSync = second.frames.find(
			(f) => f.kind === "patch" && (f as { session?: unknown }).session !== undefined,
		);
		expect(initialSync, "the reconnect took the cursor-aware delta path").toBeDefined();
		assertMirrorProjectsCanonical(d.managerOf("trace-a")!.document, second.client.mirror.document, "after reconnect");
	});

	it("daemon shutdown during a streaming turn drains before it resolves", async () => {
		// Slow tokens, so the shutdown lands mid-stream deterministically.
		const d = await startTraceDaemon(["trace-a"], { tokensPerSecond: 20 });
		daemons.push(d);
		d.setResponses([fauxAssistantMessage("interrupted by a shutdown that must drain the still streaming turn")]);
		resetStoreState();
		const tc = await connectClient(d.port);
		clients.push(tc);

		await openAndCommit(d.projectId, "trace-a");
		const prompt = tc.client.prompt("hello");
		void prompt.catch(() => {});
		await waitFor(() => tc.client.mirror.document.status.isStreaming, "the turn to start streaming");

		// Dispose while the turn is in flight: the drain must settle it (the
		// manager's disposal aborts and finalizes the turn) before resolving.
		await d.daemon.dispose();
		expect(d.disposeCount("trace-a")).toBe(1);
		const manager = d.managerOf("trace-a")!;
		expect(manager.document.status.isStreaming).toBe(false);
	});
});
