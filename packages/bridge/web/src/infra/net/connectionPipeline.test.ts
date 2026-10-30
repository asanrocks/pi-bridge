// connectionPipeline — the live-patch flush policy. Status ops are urgent:
// they flush the store synchronously, bypassing the coalescing timer.
// Everything else defers to the rAF/1s schedule. Backgrounded tabs suspend
// those timers, so a deferred status write would only land at the resume
// flush — the turn-completion notification (observed at store level by
// useStatusNotifications) depends on seeing the transition at arrival.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient, PatchOp, ServerPushMessage } from "../../../../src/core/index.ts";
import { initFromEntries } from "../../../../src/core/index.ts";
import { getStore } from "../state/store.tsx";
import { type ConnectionPipeline, createConnectionPipeline, type FlushScheduler } from "./connectionPipeline.ts";
import { navigationOpen, resetNavigationForTests } from "./navigation.ts";

// The pipeline's scheduling is an injected FlushScheduler; the manual fake
// records the requested frame without firing it, so deferred flushes stay
// pending for the assertions below (and `flushFrame` settles one on demand).
function manualScheduler(): { scheduler: FlushScheduler; frameRequested(): boolean; flushFrame(): void } {
	let frame: (() => void) | null = null;
	let requested = false;
	const scheduler: FlushScheduler = {
		hidden: () => false,
		onVisibilityChange: () => () => {},
		scheduleFrame(flush: () => void) {
			requested = true;
			frame = flush;
			return () => {
				frame = null;
			};
		},
	};
	return {
		scheduler,
		frameRequested: () => requested,
		flushFrame: () => {
			const f = frame;
			frame = null;
			f?.();
		},
	};
}

// The pipeline reads client.mirror.document at flush time (the real
// BridgeClient has already applied the patch to the mirror before onPush
// fires), so the fake swaps the mirror document between pushes and bumps
// `revision` the way DocumentMirror does when a patch replaces an entry root.
function fakeClient(): {
	client: BridgeClient;
	mirror: { document: ReturnType<typeof initFromEntries>; revision: number };
} {
	const mirror = { document: initFromEntries([]), revision: 0 };
	// openSession/newSession succeed immediately, so an address-bearing frame
	// pushed right after a navigation intent arrives while its transition is
	// still pending — the wire order (the server pushes the initial sync
	// before the RPC reply).
	const client = {
		mirror,
		openSession: async (projectId: string, stem: string) => ({
			ok: true,
			session: { projectId, sessionId: `id-${stem}`, stem },
		}),
		newSession: async (projectId: string, _text: string, options: { operationId: string }) => ({
			ok: true,
			session: { projectId, sessionId: "s2", stem: "next" },
			operationId: options.operationId,
		}),
	} as unknown as BridgeClient;
	return { client, mirror };
}

function patch(ops: PatchOp[]): ServerPushMessage {
	return { kind: "patch", ops, generation: 1 };
}

describe("connectionPipeline live-patch flush policy", () => {
	let pipeline: ConnectionPipeline | null = null;

	afterEach(() => {
		pipeline?.cleanup();
		pipeline = null;
	});

	it("flushes a status-op patch synchronously", () => {
		const sched = manualScheduler();
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client, sched.scheduler);
		const next = initFromEntries([]);
		mirror.document = next;

		pipeline.onPush(patch([{ op: "replace", path: "/status/isStreaming", value: false }]));

		// No frame/timer yield: the store must already hold the new document.
		expect(getStore().getState().document).toBe(next);
		expect(sched.frameRequested()).toBe(false);
	});

	it("flushes a mixed status + append batch synchronously", () => {
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client, manualScheduler().scheduler);
		const next = initFromEntries([]);
		mirror.document = next;

		pipeline.onPush(
			patch([
				{ op: "append", path: "/entries/e1/content/0/text", value: "hi" },
				{ op: "replace", path: "/status/isStreaming", value: false },
			]),
		);

		expect(getStore().getState().document).toBe(next);
	});

	it("defers a non-status patch to the coalescing schedule", () => {
		const sched = manualScheduler();
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client, sched.scheduler);
		const next = initFromEntries([]);
		mirror.document = next;

		pipeline.onPush(patch([{ op: "append", path: "/entries/e1/content/0/text", value: "hi" }]));

		// Scheduled (a frame requested), not applied — the store still holds
		// the previous document until the coalescing flush fires.
		expect(getStore().getState().document).not.toBe(next);
		expect(sched.frameRequested()).toBe(true);
	});

	it("publishes the mirror revision when a live patch replaces an entry root", () => {
		// A same-id content replacement can be invisible to the structural
		// ViewModel cache key (same ids, same lengths), so re-projection is
		// gated on the document revision — a declared projection input the
		// pipeline publishes from the mirror, with the document it describes.
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client, manualScheduler().scheduler);
		const next = initFromEntries([]);
		mirror.document = next;

		const pullBefore = getStore().getState().pullTick;
		// An ordinary append-only patch defers; nothing publishes yet.
		pipeline.onPush(patch([{ op: "append", path: "/entries/e1/content/0/text", value: "hi" }]));
		expect(getStore().getState().docRevision).toBe(mirror.revision);
		expect(getStore().getState().pullTick).toBe(pullBefore);

		// The mirror counted a replacement (sealing in place, or a rewrite):
		// the flush publishes the document together with its revision, and the
		// pull tick is not the channel for it anymore.
		mirror.revision += 1;
		const replaced = initFromEntries([]);
		mirror.document = replaced;
		pipeline.onPush(
			patch([
				{ op: "add", path: "/entries/e1", value: {} },
				{ op: "replace", path: "/status/isStreaming", value: false },
			]),
		);
		expect(getStore().getState().document).toBe(replaced);
		expect(getStore().getState().docRevision).toBe(mirror.revision);
		expect(getStore().getState().pullTick).toBe(pullBefore);
	});

	it("an address-bearing replace is never observed torn: the address, the id, the document, and the revision land in one store write", async () => {
		// G3: the replace path used to publish the new session's document
		// before the address committed (and the delta path committed the
		// address before the document), so a store subscriber could observe
		// the new document under the old address or the reverse. The
		// publication is now the navigation reactor's — one store write — and
		// this subscriber asserts the pair is never torn.
		const w = globalThis as unknown as { window?: unknown };
		w.window = { location: { pathname: "/" }, history: { replaceState: vi.fn() } };
		const { client, mirror } = fakeClient();
		resetNavigationForTests({ getClient: () => client });
		pipeline = createConnectionPipeline(client, manualScheduler().scheduler);

		const observed: Array<{ stem: string | null; sessionId: string | null; doc: unknown }> = [];
		const unsubscribe = getStore().subscribe((s) => {
			observed.push({ stem: s.currentStem, sessionId: s.activeSessionId, doc: s.document });
		});
		try {
			const next = initFromEntries([]);
			mirror.document = next;
			mirror.revision += 1;

			// The frame arrives while an open transition for the target is
			// pending — the wire order. (An unattributed frame with no owning
			// transition can no longer select a new address at all.)
			const opened = navigationOpen({ projectId: "proj", stem: "next" });
			pipeline.onPush({
				kind: "replace",
				generation: 1,
				session: { projectId: "proj", sessionId: "s2", stem: "next" },
				document: next,
			});
			await opened;

			const s = getStore().getState();
			expect(s.currentStem).toBe("next");
			expect(s.activeSessionId).toBe("s2");
			expect(s.document).toBe(next);
			// The optimistic stage may publish the new address while the old
			// document still shows (the id is null until the initial sync), so
			// the untorn-pairing invariant is about the frame's publication:
			// the new document never appears under another address, and the
			// durable id never appears without its document.
			expect(observed.length).toBeGreaterThan(0);
			for (const o of observed) {
				if (o.doc === next) expect(o.stem).toBe("next");
				else expect(o.sessionId).not.toBe("s2");
			}
		} finally {
			unsubscribe();
			delete w.window;
		}
	});
});

// ---------------------------------------------------------------------------
// session_closed — terminal ownership from the host. The live runtime behind
// an address ended; the server already severed the attachment.
// ---------------------------------------------------------------------------

describe("connectionPipeline session_closed handling", () => {
	const g = globalThis as unknown as { window?: unknown };
	let pipeline: ConnectionPipeline | null = null;
	let replaceState: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		// writeRoute reads window.location and writes history — stub both, as
		// no other test in this file routes.
		replaceState = vi.fn();
		g.window = { location: { pathname: "/proj/stem" }, history: { replaceState } };
		getStore().setState({
			currentProjectId: "proj",
			currentStem: "stem",
			activeSessionId: "s1",
			renderLeafId: null,
		});
	});

	afterEach(() => {
		pipeline?.cleanup();
		pipeline = null;
		delete g.window;
		getStore().setState({ currentProjectId: null, currentStem: null, activeSessionId: null });
	});

	it("lands on the Project home when the closed Session is the rendered one", async () => {
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client, manualScheduler().scheduler);
		// Commit the rendered view through a real attach (generation 1), as
		// the wire would: a close may end only the committed observation.
		const opened = navigationOpen({ projectId: "proj", stem: "stem" });
		const committed = initFromEntries([]);
		mirror.document = committed;
		pipeline.onPush({
			kind: "replace",
			session: { projectId: "proj", sessionId: "s1", stem: "stem" },
			document: committed,
			generation: 1,
		});
		await opened;
		expect(getStore().getState().currentStem).toBe("stem");

		pipeline.onPush({ kind: "session_closed", projectId: "proj", stem: "stem", generation: 1 });

		// The document can never progress again: the address, the durable
		// session id, and the route all go, retaining the Project to land on
		// its home (the same boundary a failed open uses).
		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(replaceState).toHaveBeenCalledWith(null, "", "/proj");
	});

	it("ignores a close of some other Session", async () => {
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client, manualScheduler().scheduler);
		const opened = navigationOpen({ projectId: "proj", stem: "stem" });
		const committed = initFromEntries([]);
		mirror.document = committed;
		pipeline.onPush({
			kind: "replace",
			session: { projectId: "proj", sessionId: "s1", stem: "stem" },
			document: committed,
			generation: 1,
		});
		await opened;

		pipeline.onPush({ kind: "session_closed", projectId: "proj", stem: "other", generation: 1 });
		pipeline.onPush({ kind: "session_closed", projectId: "other", stem: "stem", generation: 2 });

		const s = getStore().getState();
		expect(s.currentStem).toBe("stem");
		expect(s.activeSessionId).toBe("s1");
		expect(replaceState).not.toHaveBeenCalled();
	});
});
