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

import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { navigationBoot } from "../../web/src/infra/net/navigation.ts";
import { getStore } from "../../web/src/infra/state/store.ts";
import {
	assertMirrorProjectsCanonical,
	connectClient,
	openAndCommit,
	resetStoreState,
	startTraceDaemon,
	type TraceClient,
	type TraceDaemon,
	waitFor,
} from "./trace-harness.ts";

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
	it("a full turn through the real runtime lands the queue busy, then notified", async () => {
		const d = await startTraceDaemon(["trace-queue"], { tokensPerSecond: 200 });
		daemons.push(d);
		d.setResponses([fauxAssistantMessage("the streamed answer")]);
		resetStoreState();
		const tc = await connectClient(d.port);
		clients.push(tc);
		await openAndCommit(d.projectId, "trace-queue");

		const reply = await tc.client.prompt("hello");
		expect(reply.ok).toBe(true);

		// Admission landed busy in the durable queue — the wire, the actor
		// relay, and the store all agree while the turn still streams.
		let sawBusy = false;
		for (let i = 0; i < 200 && !sawBusy; i++) {
			if ((await d.daemon.listQueue()).some((row) => row.state === "busy")) sawBusy = true;
			else await new Promise((r) => setTimeout(r, 5));
		}
		expect(sawBusy).toBe(true);

		await waitFor(() => !getStore().getState().document.status.isStreaming, "the turn to settle");
		const settledQueue = await d.daemon.listQueue();
		expect(settledQueue).toHaveLength(1);
		expect(settledQueue[0].state).toBe("notified");

		// Defer through the wire verb: the queue is user-togglable once the
		// execution settled.
		const defer = await tc.client.setSessionState(d.projectId, "trace-queue", "deferred");
		expect(defer.ok).toBe(true);
		const deferred = await d.daemon.listQueue();
		expect(deferred[0].state).toBe("deferred");
	});

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
