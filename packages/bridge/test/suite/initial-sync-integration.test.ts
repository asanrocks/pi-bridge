// ADR 09 stage-4 integration tests: initial sync through the wired stack
// (Manager connection handles + Connection + Daemon). The pure decision logic
// is covered by initial-sync.test.ts / cache-policy.test.ts; these tests
// verify the host plumbing: cursor pass-through, per-connection emission at
// attach and rebind, subscription reset on initial sync, and the durable
// session id in session listing.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Document, Entry, Patch, PatchMessage, PrefixCursor, ReplaceMessage } from "../../src/core/index.ts";
import { Connection } from "../../src/host/connection.ts";
import { type ConnectionHandle, Daemon, type DaemonOptions, type Manager } from "../../src/host/index.ts";
import { collectFrames, createWsPair, mockDaemonVerbs, waitFor, waitForFrame } from "./conn-helpers.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collecting handle for raw (no-WebSocket) Manager attachment. */
class FrameCollector implements ConnectionHandle {
	frames: Array<PatchMessage | ReplaceMessage> = [];
	patches: Patch[] = [];
	onPatch(patch: Patch): void {
		this.patches.push(patch);
	}
	onInitialSync(frame: PatchMessage | ReplaceMessage): void {
		this.frames.push(frame);
	}
	onExit(): void {}
}

/** Committed entries of an initial-sync document, in ord order. */
function committedOf(doc: Document): Entry[] {
	return Object.values(doc.entries)
		.filter((e) => !e.id.startsWith("pending:") && e.ord !== undefined)
		.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
}

/** Write a minimal two-message session file; returns its path and entry ids. */
function writeSecondSession(dir: string): { path: string; sessionId: string; first: string; second: string } {
	const path = join(dir, "other-session.jsonl");
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "other-session-id",
			timestamp: "2024-01-01T00:00:00Z",
			cwd: dir,
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "off",
		}),
		JSON.stringify({
			type: "message",
			id: "o1",
			parentId: null,
			timestamp: "2024-01-01T00:00:01Z",
			message: { role: "user", content: "hello other", timestamp: 0 },
		}),
		JSON.stringify({
			type: "message",
			id: "o2",
			parentId: "o1",
			timestamp: "2024-01-01T00:00:02Z",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 0 },
		}),
	];
	writeFileSync(path, `${lines.join("\n")}\n`);
	return { path, sessionId: "other-session-id", first: "o1", second: "o2" };
}

/** Encode a cwd the way getDefaultSessionDir does (agentDir/sessions/--cwd--). */
function sessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return join(resolve(agentDir), "sessions", safePath);
}

// ---------------------------------------------------------------------------
// Attach-time initial sync
// ---------------------------------------------------------------------------

describe("initial sync: attach", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("first attach sends a full replace with sessionId and ord; a cursor attach receives a delta", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		// Connection A: no cursor → full replace.
		const pairA = await createWsPair();
		const framesA = collectFrames(pairA.clientWs);
		const connA = new Connection(pairA.serverWs, mockDaemonVerbs, null, false);
		connA.attach(bh.manager, "test-mgr");

		const replace = (await waitForFrame(framesA, (f) => (f as { kind?: string }).kind === "replace")) as {
			sessionId?: string;
			document: Document;
		};
		expect(replace.sessionId).toBe(bh.manager.liveSessionId);
		const committed = committedOf(replace.document);
		expect(committed.length).toBeGreaterThan(2);
		// ord is dense and zero-based.
		expect(committed.map((e) => e.ord)).toEqual(committed.map((_, i) => i));
		// Snapshot of the pre-turn committed set (ids are immutable).
		const _bootstrapIds = new Set(committed.map((e) => e.id));

		// Connection B: cursor covering all but the last two entries → delta.
		const entryCount = committed.length - 2;
		const cursor: PrefixCursor = {
			sessionId: replace.sessionId as string,
			lastKnownId: committed[entryCount - 1].id,
			entryCount,
		};

		const pairB = await createWsPair();
		const framesB = collectFrames(pairB.clientWs);
		const connB = new Connection(pairB.serverWs, mockDaemonVerbs, null, false);
		connB.attach(bh.manager, "test-mgr", cursor);

		const delta = (await waitForFrame(framesB, (f) => (f as { kind?: string }).kind === "patch")) as PatchMessage;
		expect(delta.sessionId).toBe(bh.manager.liveSessionId);
		const entryAdds = delta.ops.filter((op) => op.op === "add" && op.path.startsWith("/entries/"));
		expect(entryAdds.map((op) => op.path)).toEqual([
			`/entries/${committed[entryCount].id}`,
			`/entries/${committed[entryCount + 1].id}`,
		]);
		// Complete status and scoped models are always present.
		expect(delta.ops.some((op) => op.path === "/status")).toBe(true);
		expect(delta.ops.some((op) => op.path === "/scopedModels")).toBe(true);

		pairA.serverWs.close();
		pairA.clientWs.close();
		pairB.serverWs.close();
		pairB.clientWs.close();
	});

	it("an invalid cursor (bad anchor) receives a full replacement", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const pair = await createWsPair();
		const frames = collectFrames(pair.clientWs);
		const conn = new Connection(pair.serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, "test-mgr", {
			sessionId: bh.manager.liveSessionId,
			lastKnownId: "no-such-entry",
			entryCount: 1,
		});

		const frame = await waitForFrame(frames, (f) => (f as { kind?: string }).kind === "replace");
		const doc = (frame as { document: Document }).document;
		expect(Object.keys(doc.entries).length).toBeGreaterThan(1);

		pair.serverWs.close();
		pair.clientWs.close();
	});

	it("mid-turn attach includes provisional skeletons and only doc-held committed entries", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("Streaming reply.")],
			tokensPerSecond: 100,
		});
		harnesses.push(bh);

		const pair = await createWsPair();
		const frames = collectFrames(pair.clientWs);
		const conn = new Connection(pair.serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, "test-mgr");
		const firstReplace = (await waitForFrame(frames, (f) => (f as { kind?: string }).kind === "replace")) as {
			document: Document;
		};
		// Snapshot of the pre-turn committed set (ids are immutable).
		const bootstrapIds = new Set(committedOf(firstReplace.document).map((e) => e.id));

		// Start a turn, wait until the assistant provisional exists.
		pair.clientWs.send(JSON.stringify({ id: "1", verb: "prompt", text: "go" }));
		await waitFor(() => bh.manager.document.entries["pending:message"] !== undefined, 5000, "pending:message");

		// A second connection attaching mid-term gets the provisional
		// skeletons — later streaming appends target paths inside them.
		const pair2 = await createWsPair();
		const frames2 = collectFrames(pair2.clientWs);
		const conn2 = new Connection(pair2.serverWs, mockDaemonVerbs, null, false);
		conn2.attach(bh.manager, "test-mgr-2");

		const frame = await waitForFrame(frames2, (f) => (f as { kind?: string }).kind === "replace");
		const doc = (frame as { document: Document }).document;
		expect(doc.entries["pending:message"]).toBeDefined();
		expect(doc.entries["pending:user:1"]).toBeDefined();

		// Mid-turn pairing: the frame's committed set is exactly the pre-turn
		// committed set — the in-flight messages (committed in the file, held as
		// provisionals) are represented by the pending skeletons, not duplicated.
		const frameIds = new Set(committedOf(doc).map((e) => e.id));
		expect(frameIds).toEqual(bootstrapIds);

		pair.serverWs.close();
		pair.clientWs.close();
		pair2.serverWs.close();
		pair2.clientWs.close();
	});
});

// ---------------------------------------------------------------------------
// Rebind: switchSession initiator delta vs other-connection replace
// ---------------------------------------------------------------------------

describe("initial sync: switchSession rebind", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("sends the initiator a cursor delta and other connections a full replace", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);
		const target = writeSecondSession(bh.tempCwd);

		const initiator = new FrameCollector();
		const other = new FrameCollector();
		bh.manager.addConnection(initiator);
		bh.manager.addConnection(other);
		initiator.frames.length = 0;
		other.frames.length = 0;

		await bh.manager.switchSession(
			target.path,
			{ sessionId: target.sessionId, lastKnownId: target.first, entryCount: 1 },
			initiator,
		);

		expect(bh.manager.liveSessionId).toBe(target.sessionId);

		// Initiator: delta patch with the missing suffix (the cached prefix is
		// not resent; the runtime may append its own entries post-open — they
		// are legitimately part of the suffix).
		expect(initiator.frames.length).toBe(1);
		const delta = initiator.frames[0] as PatchMessage;
		expect(delta.kind).toBe("patch");
		expect(delta.sessionId).toBe(target.sessionId);
		const entryAdds = delta.ops.filter((op) => op.op === "add" && op.path.startsWith("/entries/"));
		expect(entryAdds.map((op) => op.path)).toContain(`/entries/${target.second}`);
		expect(entryAdds.map((op) => op.path)).not.toContain(`/entries/${target.first}`);

		// Other connection: full replace covering the whole target session.
		expect(other.frames.length).toBe(1);
		const replace = other.frames[0] as ReplaceMessage;
		expect(replace.kind).toBe("replace");
		expect(replace.sessionId).toBe(target.sessionId);
		expect(replace.document.entries[target.first]?.ord).toBe(0);
		expect(replace.document.entries[target.second]?.ord).toBe(1);
	});

	it("a switchSession failure sends no initial sync", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const collector = new FrameCollector();
		bh.manager.addConnection(collector);
		collector.frames.length = 0;

		// An existing non-session file fails SessionManager.open's validity
		// check before any rebind runs.
		const garbage = join(bh.tempCwd, "garbage.jsonl");
		writeFileSync(garbage, "not a session file\n");

		const before = bh.manager.liveSessionId;
		await expect(bh.manager.switchSession(garbage, null, collector)).rejects.toThrow();
		expect(collector.frames.length).toBe(0);
		expect(bh.manager.liveSessionId).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// Subscription reset on initial sync (Connection-level)
// ---------------------------------------------------------------------------

describe("initial sync: subscription reset", () => {
	it("re-attach clears pull-based lazy subscriptions", async () => {
		// A stub Manager with a pending entry whose lazy field can be pulled,
		// and a controllable patch emitter.
		const document: Document = {
			status: {
				leafId: "pending:message",
				name: "",
				model: { provider: "", modelId: "" },
				thinkingLevel: "off",
				isStreaming: true,
				isCompacting: false,
				stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
				contextUsage: null,
				pendingSteer: [],
			},
			entries: {
				"pending:message": {
					kind: "message",
					id: "pending:message",
					parentId: null,
					timestamp: "",
					role: "assistant",
					content: [{ type: "thinking", thinking: "partial" }],
				},
			},
			scopedModels: [],
		};
		const handles = new Set<ConnectionHandle>();
		const manager: Manager = {
			get document() {
				return document;
			},
			liveSessionId: "s-stub",
			cwd: "/tmp",
			onPatch: () => () => {},
			onReplace: () => () => {},
			onExit: () => () => {},
			onSettled: () => () => {},
			addConnection(handle) {
				handles.add(handle);
				handle.onInitialSync({ kind: "replace", sessionId: "s-stub", document });
			},
			removeConnection(handle) {
				handles.delete(handle);
			},
			prompt: async () => {},
			executeBash: async () => {},
			abort: async () => {},
			discardSteer: async () => {},
			setModel: async () => {},
			setThinkingLevel: async () => {},
			renameSession: async () => {},
			navigate: async () => {},
			switchSession: async () => {},
			newSession: async () => {},
			dispose: async () => {
				for (const h of handles) h.onExit();
			},
		};

		const pair = await createWsPair();
		const frames = collectFrames(pair.clientWs);
		const conn = new Connection(pair.serverWs, mockDaemonVerbs, null, false);
		conn.attach(manager, "stub");
		await waitForFrame(frames, (f) => (f as { kind?: string }).kind === "replace");

		const lazyPatch: Patch = {
			ops: [{ op: "replace", path: "/entries/pending:message/content/0/thinking", value: "more" }],
		};

		// Before the pull, the lazy patch is filtered out.
		for (const h of handles) h.onPatch(lazyPatch);
		expect(frames.filter((f) => (f as { kind?: string }).kind === "patch")).toHaveLength(0);

		// Pull subscribes the lazy path (pending entries only), then the lazy
		// patch is delivered.
		pair.clientWs.send(
			JSON.stringify({
				id: "1",
				verb: "pull",
				requests: [{ entryId: "pending:message", fieldPath: "/entries/pending:message/content/0/thinking" }],
			}),
		);
		await waitForFrame(frames, (f) => (f as { id?: string }).id === "1");
		for (const h of handles) h.onPatch(lazyPatch);
		await waitForFrame(frames, (f) => (f as { kind?: string }).kind === "patch");

		// Re-attach: the initial sync resets subscriptions, so the same lazy
		// patch is filtered again.
		const mark = frames.length;
		conn.attach(manager, "stub");
		await waitForFrame(frames, (f) => (f as { kind?: string }).kind === "replace" && frames.indexOf(f) >= mark);
		for (const h of handles) h.onPatch(lazyPatch);
		// WS delivery is async — allow time for a frame that must not arrive.
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(frames.slice(mark).filter((f) => (f as { kind?: string }).kind === "patch")).toHaveLength(0);

		pair.serverWs.close();
		pair.clientWs.close();
	});
});

// ---------------------------------------------------------------------------
// Daemon: durable session identity in session listing
// ---------------------------------------------------------------------------

describe("initial sync: session listing identity", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("listSessions reports the header sessionId and the file sessionPath", async () => {
		const root = join(tmpdir(), `pi-bridge-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(root, "agent");
		// The Daemon scans getDefaultSessionDir(process.cwd(), agentDir) — it has
		// no cwd option; the temp agentDir keeps the scan off the real one.
		const sessionDir = sessionDirFor(process.cwd(), agentDir);
		mkdirSync(sessionDir, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const sessionPath = join(sessionDir, "2024-01-01T00-00-00-000Z_durable-id-1234.jsonl");
		writeFileSync(
			sessionPath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "durable-id-1234",
					timestamp: "2024-01-01T00:00:00Z",
					cwd: process.cwd(),
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2024-01-01T00:00:01Z",
					message: { role: "user", content: "first message", timestamp: 0 },
				}),
			].join("\n")}\n`,
		);

		const daemon = new Daemon();
		cleanups.push(() => {
			void daemon.dispose();
		});
		const opts: DaemonOptions = { agentDir, cwdAllowlist: [process.cwd()] };
		await daemon.start(opts);
		const addr = daemon.address;
		if (!addr) throw new Error("daemon not listening");

		const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
		await new Promise<void>((resolve, reject) => {
			ws.on("open", () => resolve());
			ws.on("error", reject);
		});
		cleanups.push(() => ws.close());
		const frames = collectFrames(ws);
		ws.send(JSON.stringify({ id: "1", verb: "listSessions" }));

		const reply = (await waitForFrame(frames, (f) => (f as { id?: string }).id === "1")) as {
			ok: boolean;
			sessions: Array<{ sessionId: string; sessionPath: string | null }>;
		};
		expect(reply.ok).toBe(true);
		expect(reply.sessions.length).toBe(1);
		expect(reply.sessions[0].sessionId).toBe("durable-id-1234");
		expect(reply.sessions[0].sessionPath).toBe(sessionPath);
	});
});
