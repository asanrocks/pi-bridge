import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { Document, SessionRef } from "../../src/core/index.ts";
import { MAX_IMAGE_BASE64_LENGTH, MAX_IMAGES_PER_MESSAGE } from "../../src/core/index.ts";
import type { DaemonVerbs } from "../../src/host/connection.ts";
import { Connection } from "../../src/host/connection.ts";
import type { Manager } from "../../src/host/manager.ts";
import {
	collectFrames,
	createWsPair,
	mockDaemonVerbs,
	mockSessionRef,
	waitForFrame,
	waitForOpen,
} from "./conn-helpers.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

/** A Manager stand-in: only the members the Connection path under test reads. */
function fakeManager(overrides: Partial<Manager> = {}): Manager {
	return {
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
		liveSessionId: "s",
		cwd: "/proj",
		sessionFile: "/proj/s.jsonl",
		createdAt: new Date(0).toISOString(),
		onPatch: () => () => {},
		addConnection: () => {},
		removeConnection: () => {},
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
		recoverTurn: async () => "retry",
		dispose: async () => {},
		...overrides,
	} as unknown as Manager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Connection + Daemon", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	// ── replace on attach ────────────────────────────────────────────────

	it("sends replace push on attach", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		const replace = await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");
		expect(replace).toBeDefined();

		const doc = (replace as Record<string, unknown>).document as Record<string, unknown>;
		expect(doc).toBeDefined();
		expect((doc as { status: Record<string, unknown> }).status).toBeDefined();
		expect(doc.entries).toBeDefined();

		serverWs.close();
		clientWs.close();
	});

	// ── prompt via RPC ───────────────────────────────────────────────────

	it("handles prompt RPC and receives patches", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("Hello from faux!")],
		});
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		// Wait for initial replace
		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		// Send prompt RPC
		clientWs.send(JSON.stringify({ id: "1", verb: "prompt", text: "Say hello" }));

		// Should receive patch frames during streaming
		const patch = await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "patch");
		expect(patch).toBeDefined();

		// Should receive RPC reply
		const reply = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === "1" && r.ok !== undefined;
		});
		expect((reply as Record<string, unknown>).ok).toBe(true);

		serverWs.close();
		clientWs.close();
	});

	// ── prompt image limits ─────────────────────────────────────────────

	it("rejects prompt RPC with too many images", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);
		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		const images = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => ({
			type: "image",
			data: "aGk=",
			mimeType: "image/png",
		}));
		clientWs.send(JSON.stringify({ id: "1", verb: "prompt", text: "go", images }));

		const reply = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === "1" && r.ok !== undefined;
		});
		expect((reply as Record<string, unknown>).ok).toBe(false);

		serverWs.close();
		clientWs.close();
	});

	it("rejects prompt RPC with an oversized image", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);
		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		const images = [{ type: "image", data: "a".repeat(MAX_IMAGE_BASE64_LENGTH + 1), mimeType: "image/png" }];
		clientWs.send(JSON.stringify({ id: "1", verb: "prompt", text: "go", images }));

		const reply = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === "1" && r.ok !== undefined;
		});
		expect((reply as Record<string, unknown>).ok).toBe(false);

		serverWs.close();
		clientWs.close();
	});

	// ── daemon verbs via RPC ─────────────────────────────────────────────

	it("listSessions returns session list", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		// Wait for replace
		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		clientWs.send(JSON.stringify({ id: "2", verb: "listSessions", projectId: "proj" }));

		const reply = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === "2" && r.ok !== undefined;
		});
		const r = reply as Record<string, unknown>;
		expect(r.ok).toBe(true);
		expect(r.sessions).toBeDefined();
		expect(Array.isArray(r.sessions)).toBe(true);

		serverWs.close();
		clientWs.close();
	});

	// ADR 12: listFiles is Project-addressed, not attachment-scoped — the
	// Project home completes pre-send with nothing attached.
	it("listFiles forwards projectId and needs no attachment", async () => {
		const calls: Array<[string, string]> = [];
		const verbs = {
			...mockDaemonVerbs,
			listFiles: (prefix: string, projectId: string) => {
				calls.push([prefix, projectId]);
				return [{ path: "src/index.ts", isDirectory: false }];
			},
		};

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);
		// Deliberately never attach.
		new Connection(serverWs, verbs, null, false);
		await waitForOpen(clientWs);

		clientWs.send(JSON.stringify({ id: "lf1", verb: "listFiles", prefix: "src/", projectId: "proj" }));
		const reply = (await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).id === "lf1")) as Record<
			string,
			unknown
		>;
		expect(reply.ok).toBe(true);
		expect(reply.entries).toEqual([{ path: "src/index.ts", isDirectory: false }]);
		expect(calls).toEqual([["src/", "proj"]]);

		serverWs.close();
		clientWs.close();
	});

	it("listFiles rejects a missing projectId", async () => {
		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);
		new Connection(serverWs, mockDaemonVerbs, null, false);
		await waitForOpen(clientWs);

		clientWs.send(JSON.stringify({ id: "lf2", verb: "listFiles", prefix: "src/" }));
		const reply = (await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).id === "lf2")) as Record<
			string,
			unknown
		>;
		expect(reply.ok).toBe(false);
		expect(String(reply.error)).toContain("projectId");

		serverWs.close();
		clientWs.close();
	});

	it("getDaemonInfo returns models and thinking levels", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		clientWs.send(JSON.stringify({ id: "3", verb: "getDaemonInfo" }));

		const reply = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === "3" && r.ok !== undefined;
		});
		const r = reply as Record<string, unknown>;
		expect(r.ok).toBe(true);
		expect(r.models).toBeDefined();
		expect(r.thinkingLevels).toBeDefined();
		// liveSessionId was removed from GetDaemonInfoReply
		expect((r as Record<string, unknown>).liveSessionId).toBeUndefined();

		serverWs.close();
		clientWs.close();
	});

	// ── pull via RPC ─────────────────────────────────────────────────────

	it("pull resolves lazy content from the canonical document", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		// Pick a real entry that has lazy content
		const entryIds = Object.keys(bh.manager.document.entries).filter((id) => !id.startsWith("pending:"));
		const testId = entryIds[0];

		clientWs.send(
			JSON.stringify({
				id: "4",
				verb: "pull",
				requests: [{ entryId: testId, fieldPath: `/entries/${testId}/content/0/text` }],
			}),
		);

		const reply = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === "4" && r.ok !== undefined;
		});
		const r = reply as Record<string, unknown>;
		expect(r.ok).toBe(true);

		serverWs.close();
		clientWs.close();
	});

	// ── error handling ───────────────────────────────────────────────────

	it("returns error for unknown verb", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		clientWs.send(JSON.stringify({ id: "99", verb: "nonexistentVerb" }));

		const reply = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === "99";
		});
		const r = reply as Record<string, unknown>;
		expect(r.ok).toBe(false);
		expect(r.error).toBeDefined();

		serverWs.close();
		clientWs.close();
	});

	// ── subscription filtering ───────────────────────────────────────────

	it("patch pushes are filtered against pull-based subscriptions", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("Hello!")],
		});
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		// Start a turn — should receive patches (non-lazy ops pass filter)
		clientWs.send(JSON.stringify({ id: "1", verb: "prompt", text: "go" }));

		const patch = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.kind === "patch";
		});
		expect(patch).toBeDefined();

		serverWs.close();
		clientWs.close();
	});

	// ── setModel via Connection ──────────────────────────────────────────

	it("setModel RPC routes through Connection to Manager", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		const patchCountBefore = bh.patches.length;

		// setModel RPC — uses the faux model from harness
		clientWs.send(JSON.stringify({ id: "5", verb: "setModel", provider: "faux", model: "faux-1" }));

		const reply = await waitForFrame(clientFrames, (f) => {
			const r = f as Record<string, unknown>;
			return r.id === "5" && r.ok !== undefined;
		});
		const r = reply as Record<string, unknown>;
		expect(r.ok).toBe(true);

		// Patches should be emitted for model_change entry
		expect(bh.patches.length).toBeGreaterThan(patchCountBefore);

		serverWs.close();
		clientWs.close();
	});

	// ── dispose + detach ─────────────────────────────────────────────────

	it("dispose removes listeners from Manager", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		// Count initial listeners
		let patchFired = false;
		const unsub = bh.manager.onPatch(() => {
			patchFired = true;
		});

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		// Wait for replace push (proves Connection listener is attached)
		await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");

		// Detach the connection
		conn.detach();

		// Trigger a patch emission on the Manager (navigate is cheap + synchronous)
		patchFired = false;
		await bh.manager.navigate(null);

		// Our test listener should still fire (proves Manager still works)
		expect(patchFired).toBe(true);

		// The detached Connection's socket should receive no new frames
		const framesAfter = clientFrames.length;
		// Brief settle time for any async delivery
		await new Promise((r) => setTimeout(r, 50));
		expect(clientFrames.length).toBe(framesAfter);

		unsub();
		serverWs.close();
		clientWs.close();
	});

	// ── initial-sync address (ADR 11) ────────────────────────────────────

	it("the initial-sync replace carries the session reference", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const conn = new Connection(serverWs, mockDaemonVerbs, null, false);
		conn.attach(bh.manager, mockSessionRef);

		const replace = await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).kind === "replace");
		const session = (replace as { session: Record<string, unknown> }).session;
		expect(session.projectId).toBe("proj");
		expect(session.stem).toBe("2024-01-01_s1");
		expect(session.sessionId).toBe(mockSessionRef.sessionId);

		serverWs.close();
		clientWs.close();
	});

	// ── command target capture ──────────────────────────────────────────

	it("a command started for one session cannot be retargeted by a transition completing during it", async () => {
		// A rename is in flight when an openSession transition completes and
		// moves the attachment to another session. The rename must finish
		// against — and broadcast for — the session it was started for. The
		// broadcast previously read the live attachment after its await, so the
		// Project refresh went to the successor session's Project.
		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		const refA: SessionRef = { projectId: "proj-a", sessionId: "sa", stem: "a" };
		const refB: SessionRef = { projectId: "proj-b", sessionId: "sb", stem: "b" };

		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const managerA = fakeManager({
			renameSession: async () => {
				await renameGate;
			},
		});
		const managerB = fakeManager();

		let releaseOpen: () => void = () => {};
		const openGate = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const sessionsChanged: string[] = [];
		const verbs: DaemonVerbs = {
			...mockDaemonVerbs,
			openSession: async (_projectId, _stem, conn) => {
				await openGate;
				conn.attach(managerB, refB);
				return { ok: true, session: refB };
			},
			sessionsChanged: (projectId) => sessionsChanged.push(projectId),
		};

		const conn = new Connection(serverWs, verbs, null, false);
		conn.attach(managerA, refA);
		await waitForOpen(clientWs);

		clientWs.send(JSON.stringify({ id: "1", verb: "openSession", projectId: "proj-b", stem: "b" }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		clientWs.send(JSON.stringify({ id: "2", verb: "renameSession", name: "renamed" }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The transition completes and moves the attachment.
		releaseOpen();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(conn.attachedSession?.projectId).toBe("proj-b");

		// The rename completes against its captured target.
		releaseRename();
		const reply = await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).id === "2");
		expect((reply as Record<string, unknown>).ok).toBe(true);
		expect(sessionsChanged).toEqual(["proj-a"]);

		serverWs.close();
		clientWs.close();
	}, 30000);

	// ── transition serialization ────────────────────────────────────────

	it("serializes concurrent openSession RPCs in arrival order", async () => {
		// The first open is slow (a manager being created); the second arrives
		// while it is in flight. Without serialization both run concurrently and
		// the second replies first — the client then trusts a reply order the
		// server's attachment does not follow. Serialized, each transition runs
		// to completion before the next: reply order equals arrival order.
		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const opened: string[] = [];
		const verbs: DaemonVerbs = {
			...mockDaemonVerbs,
			openSession: async (_projectId, stem) => {
				opened.push(stem);
				if (opened.length === 1) await firstGate;
				return { ok: true, session: { ...mockSessionRef, stem } };
			},
		};
		new Connection(serverWs, verbs, null, false);
		await waitForOpen(clientWs);

		clientWs.send(JSON.stringify({ id: "1", verb: "openSession", projectId: "proj", stem: "first" }));
		clientWs.send(JSON.stringify({ id: "2", verb: "openSession", projectId: "proj", stem: "second" }));
		// Both messages are handled; the first transition is parked on its gate.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(opened).toEqual(["first"]);

		releaseFirst();

		const reply1 = await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).id === "1");
		const reply2 = await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).id === "2");
		expect((reply1 as Record<string, unknown>).ok).toBe(true);
		expect((reply2 as Record<string, unknown>).ok).toBe(true);
		// Arrival order: the first request replied before the second.
		expect(clientFrames.indexOf(reply1)).toBeLessThan(clientFrames.indexOf(reply2));
		expect(opened).toEqual(["first", "second"]);

		serverWs.close();
		clientWs.close();
	}, 30000);

	it("refuses transitions that reach their turn after the connection is disposed", async () => {
		// A socket can close while a transition is in flight and more can be
		// queued behind it. A disposed connection must never attach: nothing
		// would ever release it. The queued transition replies with an error
		// instead of running.
		const { serverWs, clientWs } = await createWsPair();
		const clientFrames = collectFrames(clientWs);

		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const opened: string[] = [];
		const verbs: DaemonVerbs = {
			...mockDaemonVerbs,
			openSession: async (_projectId, stem) => {
				opened.push(stem);
				if (opened.length === 1) await firstGate;
				return { ok: true, session: { ...mockSessionRef, stem } };
			},
		};
		const conn = new Connection(serverWs, verbs, null, false);
		await waitForOpen(clientWs);

		clientWs.send(JSON.stringify({ id: "1", verb: "openSession", projectId: "proj", stem: "in-flight" }));
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The socket closes mid-transition (the daemon's close handler disposes).
		conn.dispose();
		clientWs.send(JSON.stringify({ id: "2", verb: "openSession", projectId: "proj", stem: "queued" }));
		releaseFirst();

		// The in-flight transition completes; the queued one is refused and the
		// verb is never called for it.
		const reply1 = await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).id === "1");
		expect((reply1 as Record<string, unknown>).ok).toBe(true);
		const reply2 = await waitForFrame(clientFrames, (f) => (f as Record<string, unknown>).id === "2");
		expect((reply2 as Record<string, unknown>).ok).toBe(false);
		expect(opened).toEqual(["in-flight"]);

		serverWs.close();
		clientWs.close();
	}, 30000);
}, 30000);
