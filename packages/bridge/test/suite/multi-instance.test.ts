// Multi-instance integration test — drives the Daemon's routing verbs
// (switchInstance / newInstance / killInstance / listInstances) through the
// injectable managerFactory seam, over a real WS client to the Daemon's
// server. The faux Managers are stubs (not running pi) — this test covers the
// Daemon's routing/registry logic + the detach-before-attach ordering, not pi.
//
// Complements connection-daemon.test.ts which mocks DaemonVerbs (and so
// covers the Connection's demux but not the Daemon's verb implementations).

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type {
	Document,
	ListInstancesReply,
	MessageEntry,
	NewInstanceReply,
	Patch,
	RpcReply,
} from "../../src/core/index.ts";
import { type ConnectionHandle, Daemon, type DaemonOptions, type Manager } from "../../src/host/index.ts";

// ---------------------------------------------------------------------------
// Stub Manager — satisfies the Manager interface with controllable emit
// handles, so the test can trigger patches/exits without running pi.
// ---------------------------------------------------------------------------

interface StubHandles {
	/** Call all registered patch listeners with `patch` (simulates a pi event). */
	emitPatch: (patch: Patch) => void;
	/** Call all registered exit listeners (simulates the onExit step of dispose). */
	emitExit: () => void;
	/** Patch listeners registered via addConnection + onPatch. */
	patchListenerCount: () => number;
}

/** Minimal sealed message entry for document-content tests. */
function messageEntry(
	id: string,
	role: "user" | "assistant",
	text: string,
	ts: string,
	content?: MessageEntry["content"],
): MessageEntry {
	return {
		kind: "message",
		id,
		parentId: null,
		timestamp: ts,
		role,
		content: content ?? [{ type: "text", text }],
	};
}

function emptyStubDocument(name: string, isStreaming: boolean): Document {
	return {
		status: {
			leafId: null,
			name,
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming,
			isCompacting: false,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: { total: 0 },
				messages: 0,
			},
			contextUsage: null,
			pendingSteer: [],
		},
		scopedModels: [],
		entries: {},
	};
}

function makeStubManager(opts: { cwd: string; liveSessionId: string; name?: string; isStreaming?: boolean }): {
	manager: Manager;
	handles: StubHandles;
} {
	const patchListeners = new Set<(patch: Patch) => void>();
	const replaceListeners = new Set<(document: Document) => void>();
	const exitListeners = new Set<() => void>();
	const settledListeners = new Set<() => void>();
	const connectionHandles = new Set<ConnectionHandle>();
	const document = emptyStubDocument(opts.name ?? "", opts.isStreaming ?? false);

	const manager: Manager = {
		get document() {
			return document;
		},
		liveSessionId: opts.liveSessionId,
		cwd: opts.cwd,
		onPatch(listener) {
			patchListeners.add(listener);
			return () => patchListeners.delete(listener);
		},
		onReplace(listener) {
			replaceListeners.add(listener);
			return () => replaceListeners.delete(listener);
		},
		onExit(listener) {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onSettled(listener) {
			settledListeners.add(listener);
			return () => settledListeners.delete(listener);
		},
		addConnection(handle) {
			connectionHandles.add(handle);
			// Initial sync — mirrors the real Manager's replace path.
			handle.onInitialSync({ kind: "replace", sessionId: opts.liveSessionId, document });
		},
		removeConnection(handle) {
			connectionHandles.delete(handle);
		},
		async prompt() {},
		async abort() {},
		async discardSteer() {},
		async setModel() {},
		async setThinkingLevel() {},
		async renameSession() {},
		async navigate() {},
		async switchSession() {},
		async newSession() {},
		async dispose() {
			// Match the real dispose's onExit step (skip session.abort — stub has
			// no pi session; the ordering-invariant test in connection-daemon.test
			// covers the abort→onExit sequence against a real Manager).
			for (const l of exitListeners) l();
			for (const h of connectionHandles) h.onExit();
		},
	};

	const handles: StubHandles = {
		emitPatch: (patch: Patch) => {
			for (const l of patchListeners) l(patch);
			for (const h of connectionHandles) h.onPatch(patch);
		},
		emitExit: () => {
			for (const l of exitListeners) l();
		},
		patchListenerCount: () => patchListeners.size + connectionHandles.size,
	};

	return { manager, handles };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const daemons: Daemon[] = [];

afterEach(async () => {
	while (daemons.length) {
		const d = daemons.pop();
		if (d) await d.dispose();
	}
});

async function startDaemon(opts: DaemonOptions): Promise<{ port: number }> {
	const daemon = new Daemon();
	daemons.push(daemon);
	await daemon.start(opts);
	const addr = daemon.address;
	if (!addr) throw new Error("daemon not listening");
	return { port: addr.port };
}

function openClient(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		ws.on("open", () => resolve(ws));
		ws.on("error", reject);
	});
}

let rpcId = 0;
function nextId(): string {
	return String(++rpcId);
}

function send(ws: WebSocket, frame: Record<string, unknown>): string {
	const id = nextId();
	ws.send(JSON.stringify({ id, ...frame }));
	return id;
}

function collectFrames(ws: WebSocket): unknown[] {
	const frames: unknown[] = [];
	ws.on("message", (data) => {
		try {
			frames.push(JSON.parse(data.toString()));
		} catch {
			// ignore malformed
		}
	});
	return frames;
}

function findReply(frames: unknown[], id: string): RpcReply | undefined {
	return frames.find((f) => (f as Record<string, unknown>).id === id) as RpcReply | undefined;
}

function findPush(frames: unknown[], kind: string): unknown | undefined {
	return frames.find((f) => (f as Record<string, unknown>).kind === kind);
}

function waitForReply(frames: unknown[], id: string, timeout = 5000): Promise<RpcReply> {
	return new Promise((resolve, reject) => {
		const existing = findReply(frames, id);
		if (existing) return resolve(existing);
		const timer = setTimeout(() => reject(new Error(`timeout waiting for reply ${id}`)), timeout);
		const interval = setInterval(() => {
			const match = findReply(frames, id);
			if (match) {
				clearTimeout(timer);
				clearInterval(interval);
				resolve(match);
			}
		}, 20);
	});
}

function waitForPush(frames: unknown[], kind: string, timeout = 5000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const existing = findPush(frames, kind);
		if (existing) return resolve(existing);
		const timer = setTimeout(() => reject(new Error(`timeout waiting for push ${kind}`)), timeout);
		const interval = setInterval(() => {
			const match = findPush(frames, kind);
			if (match) {
				clearTimeout(timer);
				clearInterval(interval);
				resolve(match);
			}
		}, 20);
	});
}

async function settle(ms = 80): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("multi-instance daemon routing", () => {
	it("listInstances is empty on a fresh daemon", async () => {
		const { port } = await startDaemon({
			cwdAllowlist: ["/proj-a", "/proj-b"],
			managerFactory: async (opts) => makeStubManager({ cwd: opts?.cwd ?? "", liveSessionId: "" }).manager,
		});

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const id = send(ws, { verb: "listInstances" });
		const reply = (await waitForReply(frames, id)) as unknown as ListInstancesReply;
		expect(reply.ok).toBe(true);
		expect(reply.instances).toEqual([]);

		ws.close();
	});

	it("newInstance validates against the allowlist and attaches the caller", async () => {
		const { port } = await startDaemon({
			cwdAllowlist: ["/proj-a"],
			managerFactory: async (opts) =>
				makeStubManager({ cwd: opts?.cwd ?? "", liveSessionId: `sess-${opts?.cwd ?? ""}` }).manager,
		});

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		// Invalid cwd → rejected
		const badId = send(ws, { verb: "newInstance", cwd: "/not-allowed" });
		const badReply = await waitForReply(frames, badId);
		expect(badReply.ok).toBe(false);

		// Valid cwd → ok, instanceId returned, replace push arrives (attach)
		const okId = send(ws, { verb: "newInstance", cwd: "/proj-a" });
		const okReply = (await waitForReply(frames, okId)) as unknown as NewInstanceReply;
		expect(okReply.ok).toBe(true);
		expect(typeof okReply.instanceId).toBe("string");
		const instanceId = okReply.instanceId;
		await waitForPush(frames, "replace");

		// listInstances now shows the created instance
		const listId = send(ws, { verb: "listInstances" });
		const listReply = (await waitForReply(frames, listId)) as unknown as ListInstancesReply;
		expect(listReply.instances).toHaveLength(1);
		expect(listReply.instances[0].instanceId).toBe(instanceId);
		expect(listReply.instances[0].cwd).toBe("/proj-a");

		ws.close();
	});

	it("listInstances previews the most recent message text (any role)", async () => {
		const stubs = new Map<string, { manager: Manager; handles: StubHandles }>();
		const { port } = await startDaemon({
			cwdAllowlist: ["/proj-a"],
			managerFactory: async (opts) => {
				const cwd = opts?.cwd ?? "";
				const entry = makeStubManager({ cwd, liveSessionId: `sess-${cwd}` });
				stubs.set(cwd, entry);
				return entry.manager;
			},
		});

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const createId = send(ws, { verb: "newInstance", cwd: "/proj-a" });
		await waitForReply(frames, createId);
		await waitForPush(frames, "replace");

		const stub = stubs.get("/proj-a");
		if (!stub) throw new Error("stub not found");
		// The stub's document getter hands out the live closure object — mutate
		// entries directly to simulate a conversation in progress.
		const doc = stub.manager.document;
		doc.entries = {
			u1: messageEntry("u1", "user", "fix the login bug", "2026-01-01T10:00:00Z"),
			a1: messageEntry("a1", "assistant", "I fixed it in auth.ts", "2026-01-01T10:01:00Z"),
			// Tool-call-only assistant turn, newer than a1 — no text, so the
			// preview must stay on a1 (last message WITH text).
			a2: messageEntry("a2", "assistant", "", "2026-01-01T10:02:00Z", [
				{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
			]),
		};
		doc.status.stats.messages = 3;

		const listId = send(ws, { verb: "listInstances" });
		const listReply = (await waitForReply(frames, listId)) as unknown as ListInstancesReply;
		expect(listReply.instances).toHaveLength(1);
		const inst = listReply.instances[0];
		expect(inst.preview).toBe("I fixed it in auth.ts");
		expect(inst.lastActivityAt).toBe("2026-01-01T10:02:00Z");
		expect(inst.messageCount).toBe(3);

		ws.close();
	});

	it("switchInstance rebinds the Connection: detach-before-attach puts no stale patches on the wire", async () => {
		// Factory tracks created stubs + handles so the test can emit patches.
		const stubs = new Map<string, { manager: Manager; handles: StubHandles }>();
		const { port } = await startDaemon({
			cwdAllowlist: ["/proj-a", "/proj-b"],
			managerFactory: async (opts) => {
				const cwd = opts?.cwd ?? "";
				const entry = makeStubManager({ cwd, liveSessionId: `sess-${cwd}`, name: cwd });
				stubs.set(cwd, entry);
				return entry.manager;
			},
		});

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		// Create two instances (each attach pushes a replace from that stub)
		const aId = send(ws, { verb: "newInstance", cwd: "/proj-a" });
		const aReply = (await waitForReply(frames, aId)) as unknown as NewInstanceReply;
		await waitForPush(frames, "replace"); // replace from A
		const stubA = stubs.get("/proj-a");
		if (!stubA) throw new Error("stub A not found");

		const bId = send(ws, { verb: "newInstance", cwd: "/proj-b" });
		await waitForReply(frames, bId);
		await waitForPush(frames, "replace"); // replace from B (detach A, attach B)
		const instanceAId = aReply.instanceId;

		// After attaching to B, A's patch listeners must not include the
		// Connection's onPatch (detach ran before attach).
		expect(stubA.handles.patchListenerCount()).toBe(0);

		// Emit a patch on A — it must NOT reach the Connection's wire.
		const framesBefore = frames.length;
		stubA.handles.emitPatch({ ops: [{ op: "replace", path: "/status/isStreaming", value: true }] });
		await settle();
		expect(frames.length).toBe(framesBefore); // no frame from A leaked

		// switchInstance back to A succeeds and pushes a fresh replace
		const reattachId = send(ws, { verb: "switchInstance", instanceId: instanceAId });
		await waitForReply(frames, reattachId);
		const replaceAfterReattach = await waitForPush(frames, "replace");
		expect(replaceAfterReattach).toBeDefined();
		expect(stubA.handles.patchListenerCount()).toBe(1); // A now has our onPatch

		ws.close();
	});

	it("switchInstance to a nonexistent id fails", async () => {
		const { port } = await startDaemon({
			cwdAllowlist: ["/proj-a"],
			managerFactory: async (opts) =>
				makeStubManager({ cwd: opts?.cwd ?? "", liveSessionId: `sess-${opts?.cwd ?? ""}` }).manager,
		});

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const id = send(ws, { verb: "switchInstance", instanceId: "does-not-exist" });
		const reply = await waitForReply(frames, id);
		expect(reply.ok).toBe(false);

		ws.close();
	});

	it("killInstance emits instance_exit and removes the instance from the registry", async () => {
		const { port } = await startDaemon({
			cwdAllowlist: ["/proj-a"],
			managerFactory: async (opts) =>
				makeStubManager({ cwd: opts?.cwd ?? "", liveSessionId: `sess-${opts?.cwd ?? ""}` }).manager,
		});

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		const createId = send(ws, { verb: "newInstance", cwd: "/proj-a" });
		const createReply = (await waitForReply(frames, createId)) as unknown as NewInstanceReply;
		await waitForPush(frames, "replace");
		const instanceId = createReply.instanceId;

		// kill → instance_exit push arrives
		const killId = send(ws, { verb: "killInstance", instanceId });
		await waitForReply(frames, killId);
		const exit = (await waitForPush(frames, "instance_exit")) as Record<string, unknown>;
		expect(exit.instanceId).toBe(instanceId);

		// instance_exit is the last PUSH on the wire — no stale patch/replace/
		// sessions_changed leaks after it on the killed tab. (The killer's
		// killInstance RPC reply, which carries no `kind`, may trail; that's
		// expected — the client awaits the reply after instance_exit clears.)
		await settle();
		const exitIndex = frames.indexOf(exit);
		const trailingPushes = frames.slice(exitIndex + 1).filter((f) => "kind" in (f as Record<string, unknown>));
		expect(trailingPushes.length).toBe(0);

		// Registry no longer has it
		const listId = send(ws, { verb: "listInstances" });
		const listReply = (await waitForReply(frames, listId)) as unknown as ListInstancesReply;
		expect(listReply.instances).toEqual([]);

		// Re-attaching to the killed id fails
		const reattachId = send(ws, { verb: "switchInstance", instanceId });
		const reattachReply = await waitForReply(frames, reattachId);
		expect(reattachReply.ok).toBe(false);

		ws.close();
	});

	it("a second Connection is independent — attaching one does not attach the other", async () => {
		const stubs = new Map<string, { manager: Manager; handles: StubHandles }>();
		const { port } = await startDaemon({
			cwdAllowlist: ["/proj-a", "/proj-b"],
			managerFactory: async (opts) => {
				const cwd = opts?.cwd ?? "";
				const entry = makeStubManager({ cwd, liveSessionId: `sess-${cwd}`, name: cwd });
				stubs.set(cwd, entry);
				return entry.manager;
			},
		});

		const ws1 = await openClient(port);
		const frames1 = collectFrames(ws1);
		const ws2 = await openClient(port);
		const frames2 = collectFrames(ws2);

		// ws1 creates + attaches to A
		const aId = send(ws1, { verb: "newInstance", cwd: "/proj-a" });
		const aReply = (await waitForReply(frames1, aId)) as unknown as NewInstanceReply;
		await waitForPush(frames1, "replace");
		const instanceAId = aReply.instanceId;

		// ws2 is a fresh Connection — it has received no replace (not attached)
		await settle();
		expect(findPush(frames2, "replace")).toBeUndefined();

		// ws2 explicitly switches to A — gets a replace
		const attId = send(ws2, { verb: "switchInstance", instanceId: instanceAId });
		await waitForReply(frames2, attId);
		await waitForPush(frames2, "replace");

		// Both Connections are now subscribed to A: a patch from A reaches both.
		const stubA = stubs.get("/proj-a");
		if (!stubA) throw new Error("stub A not found");
		const w1Before = frames1.length;
		const w2Before = frames2.length;
		stubA.handles.emitPatch({ ops: [{ op: "replace", path: "/status/isStreaming", value: true }] });
		await settle();
		expect(frames1.length).toBeGreaterThan(w1Before);
		expect(frames2.length).toBeGreaterThan(w2Before);

		ws1.close();
		ws2.close();
	});

	it("detachInstance unbinds the Connection — no patches on the wire, re-attach works", async () => {
		const stubs = new Map<string, { manager: Manager; handles: StubHandles }>();
		const { port } = await startDaemon({
			cwdAllowlist: ["/proj-a"],
			managerFactory: async (opts) => {
				const cwd = opts?.cwd ?? "";
				const entry = makeStubManager({ cwd, liveSessionId: `sess-${cwd}`, name: cwd });
				stubs.set(cwd, entry);
				return entry.manager;
			},
		});

		const ws = await openClient(port);
		const frames = collectFrames(ws);

		// Create + attach
		const createId = send(ws, { verb: "newInstance", cwd: "/proj-a" });
		const createReply = (await waitForReply(frames, createId)) as unknown as NewInstanceReply;
		await waitForPush(frames, "replace");
		const instanceId = createReply.instanceId;
		const stub = stubs.get("/proj-a");
		if (!stub) throw new Error("stub not found");
		expect(stub.handles.patchListenerCount()).toBe(1);

		// Detach → ok, no exit push, connection handles removed
		const detachId = send(ws, { verb: "detachInstance" });
		expect((await waitForReply(frames, detachId)).ok).toBe(true);
		expect(stub.handles.patchListenerCount()).toBe(0);

		// Patches from the (still running) instance must not reach the wire
		const framesBefore = frames.length;
		stub.handles.emitPatch({ ops: [{ op: "replace", path: "/status/isStreaming", value: true }] });
		await settle();
		expect(frames.length).toBe(framesBefore);

		// Session verbs require an attached instance again
		const promptId = send(ws, { verb: "prompt", text: "hi" });
		expect((await waitForReply(frames, promptId)).ok).toBe(false);

		// The instance is still alive in the registry — re-attach works
		const reattachId = send(ws, { verb: "switchInstance", instanceId });
		expect((await waitForReply(frames, reattachId)).ok).toBe(true);
		expect(stub.handles.patchListenerCount()).toBe(1);

		ws.close();
	});
}, 30000);
