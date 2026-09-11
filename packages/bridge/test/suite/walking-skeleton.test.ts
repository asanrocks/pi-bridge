import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeHarness } from "./harness.ts";
import { assertMirrorInSync, createBridgeHarness, createMirrorHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

describe("bridge walking skeleton", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("bootstrap: client mirror receives Init with entries from the fixture", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
		});
		harnesses.push(harness);

		const mh = createMirrorHarness(harness);

		assertMirrorInSync(mh, "bootstrap");

		const entryIds = Object.keys(mh.mirror.document.entries);
		expect(entryIds.length).toBeGreaterThan(0);

		// All entries are committed (no provisionals at bootstrap)
		const provisionals = entryIds.filter((id) => id.startsWith("pending:"));
		expect(provisionals).toEqual([]);

		// Domain validity: committed entries have parentId and timestamp
		for (const id of entryIds) {
			expect(mh.mirror.document.entries[id].parentId).toBeDefined();
			expect(mh.mirror.document.entries[id].timestamp).toBeTruthy();
		}
	});

	it("streaming: client receives patches and mirror matches canonical after turn", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("ok")],
		});
		harnesses.push(harness);

		const mh = createMirrorHarness(harness);

		await mh.manager.prompt("continue");

		assertMirrorInSync(mh, "after streaming turn");

		// Mirror has a committed assistant message
		const hasAssistant = Object.values(mh.mirror.document.entries).some(
			(e) => e.kind === "message" && e.role === "assistant" && !e.id.startsWith("pending:"),
		);
		expect(hasAssistant).toBe(true);

		// No provisional entries left after sealing
		const provisionals = Object.keys(mh.mirror.document.entries).filter((id) => id.startsWith("pending:"));
		expect(provisionals).toEqual([]);

		// leafId is a committed entry (not ordering-dependent — Object.keys order
		// is insertion order, not necessarily chronological)
		const committedIds = Object.keys(mh.mirror.document.entries).filter((id) => !id.startsWith("pending:"));
		expect(committedIds).toContain(mh.mirror.document.status.leafId);
	});

	it("tool-call turn: mirror matches canonical with committed tool_result", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage(fauxToolCall("read", { path: "/nonexistent" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		harnesses.push(harness);

		const mh = createMirrorHarness(harness);

		await mh.manager.prompt("run");

		assertMirrorInSync(mh, "after tool-call turn");

		// Client mirror has a committed tool_result entry
		const hasToolResult = Object.values(mh.mirror.document.entries).some(
			(e) => e.kind === "tool_result" && !e.id.startsWith("pending:"),
		);
		expect(hasToolResult).toBe(true);

		// No provisional entries left
		const provisionals = Object.keys(mh.mirror.document.entries).filter((id) => id.startsWith("pending:"));
		expect(provisionals).toEqual([]);

		// leafId is a committed entry (not ordering-dependent — Object.keys order
		// is insertion order, not necessarily chronological)
		const committedIds = Object.keys(mh.mirror.document.entries).filter((id) => !id.startsWith("pending:"));
		expect(committedIds).toContain(mh.mirror.document.status.leafId);
	});
}, 60000);
