import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterAll, describe, expect, it } from "vitest";
import { type BridgeHarness, createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

describe("patch round-trip", () => {
	let harness: BridgeHarness;

	afterAll(() => {
		harness?.cleanup();
	});

	it("patches survive JSON round-trip", async () => {
		harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("Hello from the faux provider!")],
		});

		await harness.manager.prompt("Say exactly: Hello from the faux provider!");

		expect(harness.patches.length).toBeGreaterThan(0);

		for (const patch of harness.patches) {
			const roundtripped = JSON.parse(JSON.stringify(patch));
			expect(Array.isArray(roundtripped.ops)).toBe(true);
			for (const op of roundtripped.ops) {
				expect(typeof op.op).toBe("string");
				// Each op shape matches the PatchOp union
				if (op.op === "move") {
					expect(typeof op.from).toBe("string");
					expect(typeof op.path).toBe("string");
				} else if (op.op !== "remove") {
					expect(typeof op.path).toBe("string");
					expect("value" in op).toBe(true);
				}
			}
		}
	});
}, 30000);
