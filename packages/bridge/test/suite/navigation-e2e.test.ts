import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentMirror, snapshotForWire } from "../../src/core/index.ts";
import type { BridgeHarness } from "./harness.ts";
import { assertMirrorInSync, createBridgeHarness, createMirrorHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

describe("navigation end-to-end", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("navigate updates leafId on the client mirror", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		// Create a client mirror subscribed to Manager patches
		const mirror = new DocumentMirror();
		mirror.applyReplace(snapshotForWire(bh.manager.document));
		bh.manager.onPatch((p) => mirror.applyPatch(p.ops));

		// Pick an entry that is NOT the last committed entry
		const committedIds = Object.keys(bh.manager.document.entries).filter((id) => !id.startsWith("pending:"));
		expect(committedIds.length).toBeGreaterThan(2);

		const originalLeafId = bh.manager.document.status.leafId;
		const targetId = committedIds[0]; // first committed entry

		await bh.manager.navigate(targetId);

		// Manager document has new leafId
		expect(bh.manager.document.status.leafId).toBe(targetId);
		expect(bh.manager.document.status.leafId).not.toBe(originalLeafId);

		// Client mirror matches manager
		expect(mirror.document.status.leafId).toBe(targetId);

		// No entries were added or removed
		expect(Object.keys(mirror.document.entries).length).toBe(Object.keys(bh.manager.document.entries).length);
	});

	it("navigate then prompt: turn starts from branch point, mirror stays in sync", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("Response from branch point.")],
		});
		harnesses.push(bh);

		const mh = createMirrorHarness(bh);
		assertMirrorInSync(mh, "bootstrap");

		// Navigate to first committed entry (branch point)
		const committedIds = Object.keys(bh.manager.document.entries).filter((id) => !id.startsWith("pending:"));
		const targetId = committedIds[0];
		await bh.manager.navigate(targetId);

		assertMirrorInSync(mh, "after navigate");

		// leafId is now the branch target
		expect(mh.mirror.document.status.leafId).toBe(targetId);

		// Prompt from the branch point
		await bh.manager.prompt("continue from branch");

		assertMirrorInSync(mh, "after prompt from branch");

		// New entries were added (the assistant response)
		const currentIds = Object.keys(mh.mirror.document.entries);
		expect(currentIds.length).toBeGreaterThan(committedIds.length);

		// leafId points to the new turn's last entry
		const lastCommitted = currentIds.filter((id) => !id.startsWith("pending:")).pop();
		expect(mh.mirror.document.status.leafId).toBe(lastCommitted);

		// Streaming is settled
		expect(mh.mirror.document.status.isStreaming).toBe(false);
	});

	it("navigate to leaf (no-op) does not change leafId", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const mirror = new DocumentMirror();
		mirror.applyReplace(snapshotForWire(bh.manager.document));
		bh.manager.onPatch((p) => mirror.applyPatch(p.ops));

		const originalLeafId = bh.manager.document.status.leafId;

		// Navigate to the current leaf — should be a no-op
		await bh.manager.navigate(originalLeafId!);

		// leafId unchanged
		expect(bh.manager.document.status.leafId).toBe(originalLeafId);
		expect(mirror.document.status.leafId).toBe(originalLeafId);
	});

	it("navigate multiple times: each emit patches the client mirror consumes", async () => {
		const bh = await createBridgeHarness({ fixturePath: FIXTURE_URL.pathname });
		harnesses.push(bh);

		const mirror = new DocumentMirror();
		mirror.applyReplace(snapshotForWire(bh.manager.document));

		const patchLeafOps: string[] = [];
		bh.manager.onPatch((p) => {
			mirror.applyPatch(p.ops);
			for (const op of p.ops) {
				if (op.op === "replace" && op.path === "/status/leafId") {
					patchLeafOps.push(op.value as string);
				}
			}
		});

		const committedIds = Object.keys(bh.manager.document.entries).filter((id) => !id.startsWith("pending:"));
		expect(committedIds.length).toBeGreaterThan(2);

		// Navigate to first, then second, then last
		await bh.manager.navigate(committedIds[0]);
		await bh.manager.navigate(committedIds[1]);
		const lastId = committedIds[committedIds.length - 1];
		await bh.manager.navigate(lastId);

		// Each navigate emitted a leafId patch
		expect(patchLeafOps.length).toBe(3);
		expect(patchLeafOps).toEqual([committedIds[0], committedIds[1], lastId]);

		// Mirror and manager agree
		expect(mirror.document.status.leafId).toBe(lastId);
		expect(bh.manager.document.status.leafId).toBe(lastId);
	});
}, 30000);
