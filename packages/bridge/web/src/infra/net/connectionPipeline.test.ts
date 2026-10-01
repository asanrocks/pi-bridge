// connectionPipeline — the live-patch flush policy. Status ops are urgent:
// they flush the store synchronously, bypassing the coalescing timer.
// Everything else defers to the rAF/1s schedule. Backgrounded tabs suspend
// those timers, so a deferred status write would only land at the resume
// flush — the turn-completion notification (observed at store level by
// useStatusNotifications) depends on seeing the transition at arrival.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient, PatchOp, ServerPushMessage } from "../../../../src/core/index.ts";
import { initFromEntries } from "../../../../src/core/index.ts";
import { getStore } from "../state/store.tsx";
import { type ConnectionPipeline, createConnectionPipeline } from "./connectionPipeline.ts";

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
// fires), so the fake just swaps the mirror document between pushes.
function fakeClient(): { client: BridgeClient; mirror: { document: ReturnType<typeof initFromEntries> } } {
	const mirror = { document: initFromEntries([]) };
	return { client: { mirror } as unknown as BridgeClient, mirror };
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
});
