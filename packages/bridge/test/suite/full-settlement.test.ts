// ============================================================================
// Full execution settlement (ADR 22): the Manager's onFullySettled signal —
// `agent_settled` (never `turn_end` alone), the admitted dispatch that
// completes without a run of its own, and the recovery continuation's
// compensated end — each carrying the execution tag the dispatch was
// admitted with, so a superseded execution's settle is recognizable.
// ============================================================================

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);
const INTERRUPTED_TOOLS = new URL("../fixtures/interrupted-tools.jsonl", import.meta.url);

const noopTool: ToolDefinition = {
	name: "noop",
	label: "No-op",
	description: "Returns immediately.",
	parameters: Type.Object({ id: Type.String() }),
	async execute(_toolCallId, params) {
		const id = (params as { id: string }).id;
		return { content: [{ type: "text", text: `noop: ${id}` }], details: { id } };
	},
};

const harnesses: BridgeHarness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

/** The fires of one full settlement, in order. */
interface Fires {
	tags: Array<string | undefined>;
	unsubscribe: () => void;
}

function trackSettlement(bh: BridgeHarness): Fires {
	const tags: Array<string | undefined> = [];
	bh.manager.onFullySettled((execution) => tags.push(execution));
	return { tags, unsubscribe: () => {} };
}

const until = async (pred: () => boolean): Promise<void> => {
	for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
	if (!pred()) throw new Error("condition not reached");
};

describe("full settlement (integration)", () => {
	it("fires on agent_settled with the dispatch's tag, never on turn_end alone", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			// One run, two turns: the tool result sends the run back to the
			// model, so turn_end fires while the execution continues.
			responses: [
				fauxAssistantMessage(fauxToolCall("noop", { id: "a" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done after the tool"),
			],
			customTools: [noopTool],
		});
		harnesses.push(bh);
		const fires = trackSettlement(bh);

		await bh.manager.prompt("hello", undefined, undefined, undefined, "exec-1");

		// One fire at full settlement; the mid-run turn_end did not settle.
		expect(fires.tags).toEqual(["exec-1"]);
	});

	it("does not fire while streaming", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("a slow reply")],
			tokensPerSecond: 50,
		});
		harnesses.push(bh);
		const fires = trackSettlement(bh);

		const done = bh.manager.prompt("hello", undefined, undefined, undefined, "exec-1").then(
			() => {},
			() => {},
		);
		await until(() => bh.manager.document.status.isStreaming);
		expect(fires.tags).toEqual([]);

		await done;
		expect(fires.tags).toEqual(["exec-1"]);
	});

	it("a queued steer settles once, under the newest admission's tag", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("first turn"), fauxAssistantMessage("steer turn")],
			tokensPerSecond: 50,
		});
		harnesses.push(bh);
		const fires = trackSettlement(bh);

		const first = bh.manager.prompt("hello", undefined, undefined, undefined, "exec-1").then(
			() => {},
			() => {},
		);
		await until(() => bh.manager.document.status.isStreaming);
		// Admitted mid-run: the steer joins the execution as one continuing run.
		await bh.manager.promptAdmitted("steer please", undefined, undefined, undefined, "exec-2");
		await first;
		await until(() => !bh.manager.document.status.isStreaming);

		// Every fire names the newest admission: the combined run settles as
		// exec-2, never as the superseded exec-1.
		expect(fires.tags.length).toBeGreaterThanOrEqual(1);
		expect(fires.tags.every((tag) => tag === "exec-2")).toBe(true);
	});

	it("a dispatch completing while a run is in flight does not settle", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("a slow reply"), fauxAssistantMessage("steer turn")],
			tokensPerSecond: 50,
		});
		harnesses.push(bh);
		const fires = trackSettlement(bh);

		const first = bh.manager.prompt("hello", undefined, undefined, undefined, "exec-1").then(
			() => {},
			() => {},
		);
		await until(() => bh.manager.document.status.isStreaming);
		// The steer's own dispatch completes after its turn; the first turn's
		// dispatch completes while the queued steer still runs.
		const steer = bh.manager.promptAdmitted("steer please", undefined, undefined, undefined, "exec-2").then(
			() => {},
			() => {},
		);
		await first;
		await steer;
		await until(() => !bh.manager.document.status.isStreaming);

		expect(fires.tags.length).toBeGreaterThanOrEqual(1);
		expect(fires.tags.every((tag) => tag === "exec-2")).toBe(true);
	});

	it("abort settles the interrupted execution with its tag", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("a slow reply that will be stopped")],
			tokensPerSecond: 50,
		});
		harnesses.push(bh);
		const fires = trackSettlement(bh);

		const done = bh.manager.prompt("hello", undefined, undefined, undefined, "exec-1").then(
			() => {},
			() => {},
		);
		await until(() => bh.manager.document.status.isStreaming);
		await bh.manager.abort();
		await done;

		// pi emits agent_settled (aborted) from the run wrapper's finally, so
		// the interrupted execution still reports full settlement.
		expect(fires.tags).toContain("exec-1");
	});

	it("a failed turn settles too (the outcome is visible document state)", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("broken", { stopReason: "error", errorMessage: "persistent 529" })],
			settings: { retry: { enabled: false, provider: { maxRetries: 0 } } },
		});
		harnesses.push(bh);
		const fires = trackSettlement(bh);

		await bh.manager.prompt("hello", undefined, undefined, undefined, "exec-1").then(
			() => {},
			() => {},
		);

		expect(fires.tags).toContain("exec-1");
		expect(bh.manager.document.status.recoverableTurn).toBe("failedTurn");
	});

	it("the silent recovery continuation settles at its compensated end", async () => {
		const bh = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage("broken", { stopReason: "error", errorMessage: "persistent 529" }),
				fauxAssistantMessage("Recovered response."),
			],
			settings: { retry: { enabled: false, provider: { maxRetries: 0 } } },
		});
		harnesses.push(bh);
		const fires = trackSettlement(bh);

		await bh.manager.prompt("hello", undefined, undefined, undefined, "exec-1").then(
			() => {},
			() => {},
		);
		expect(fires.tags).toContain("exec-1");
		fires.tags.length = 0;

		// The retry runs agent.continue() — no agent_settled fires for it, so
		// the compensation is the only settlement the recovery gets.
		const action = await bh.manager.recoverTurn("exec-2");
		expect(action).toBe("retry");
		expect(fires.tags).toEqual(["exec-2"]);
	});

	it("the relay recovery settles through the run's agent_settled", async () => {
		const bh = await createBridgeHarness({
			fixturePath: INTERRUPTED_TOOLS.pathname,
			responses: [fauxAssistantMessage("Recovered response.")],
			customTools: [noopTool],
			settings: { retry: { enabled: false, provider: { maxRetries: 0 } } },
		});
		harnesses.push(bh);
		const fires = trackSettlement(bh);

		const action = await bh.manager.recoverTurn("exec-r");
		expect(action).toBe("continue");
		expect(fires.tags).toContain("exec-r");
	});
});
