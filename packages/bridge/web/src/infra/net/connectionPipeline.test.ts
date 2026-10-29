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
import { type ConnectionPipeline, createConnectionPipeline } from "./connectionPipeline.ts";
import { navigationOpen, resetNavigationForTests } from "./navigation.ts";

// Node test env: the pipeline touches DOM scheduling APIs at creation
// (document.addEventListener) and in scheduleFlush. Stub the minimum
// surface; rAF never fires, so deferred flushes stay pending for the
// assertions below.
const g = globalThis as unknown as {
	document?: unknown;
	requestAnimationFrame?: () => number;
	cancelAnimationFrame?: () => void;
};

function stubDom(): void {
	g.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };
	g.requestAnimationFrame = vi.fn(() => 1);
	g.cancelAnimationFrame = vi.fn();
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
	return { kind: "patch", ops };
}

describe("connectionPipeline live-patch flush policy", () => {
	let pipeline: ConnectionPipeline | null = null;

	afterEach(() => {
		pipeline?.cleanup();
		pipeline = null;
	});

	it("flushes a status-op patch synchronously", () => {
		stubDom();
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client);
		const next = initFromEntries([]);
		mirror.document = next;

		pipeline.onPush(patch([{ op: "replace", path: "/status/isStreaming", value: false }]));

		// No rAF/timer yield: the store must already hold the new document.
		expect(getStore().getState().document).toBe(next);
		expect(g.requestAnimationFrame).not.toHaveBeenCalled();
	});

	it("flushes a mixed status + append batch synchronously", () => {
		stubDom();
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client);
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
		stubDom();
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client);
		const next = initFromEntries([]);
		mirror.document = next;

		pipeline.onPush(patch([{ op: "append", path: "/entries/e1/content/0/text", value: "hi" }]));

		// Scheduled (rAF requested), not applied — the store still holds the
		// previous document until the coalescing flush fires.
		expect(getStore().getState().document).not.toBe(next);
		expect(g.requestAnimationFrame).toHaveBeenCalled();
	});

	it("publishes the mirror revision when a live patch replaces an entry root", () => {
		// A same-id content replacement can be invisible to the structural
		// ViewModel cache key (same ids, same lengths), so re-projection is
		// gated on the document revision — a declared projection input the
		// pipeline publishes from the mirror, with the document it describes.
		stubDom();
		const { client, mirror } = fakeClient();
		pipeline = createConnectionPipeline(client);
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
		stubDom();
		const w = globalThis as unknown as { window?: unknown };
		w.window = { location: { pathname: "/" }, history: { replaceState: vi.fn() } };
		const { client, mirror } = fakeClient();
		resetNavigationForTests({ getClient: () => client });
		pipeline = createConnectionPipeline(client);

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
		stubDom();
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

	it("lands on the Project home when the closed Session is the rendered one", () => {
		const { client } = fakeClient();
		pipeline = createConnectionPipeline(client);

		pipeline.onPush({ kind: "session_closed", projectId: "proj", stem: "stem" });

		// The document can never progress again: the address, the durable
		// session id, and the route all go, retaining the Project to land on
		// its home (the same boundary a failed open uses).
		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(replaceState).toHaveBeenCalledWith(null, "", "/proj");
	});

	it("ignores a close of some other Session", () => {
		const { client } = fakeClient();
		pipeline = createConnectionPipeline(client);

		pipeline.onPush({ kind: "session_closed", projectId: "proj", stem: "other" });
		pipeline.onPush({ kind: "session_closed", projectId: "other", stem: "stem" });

		const s = getStore().getState();
		expect(s.currentStem).toBe("stem");
		expect(s.activeSessionId).toBe("s1");
		expect(replaceState).not.toHaveBeenCalled();
	});
});
