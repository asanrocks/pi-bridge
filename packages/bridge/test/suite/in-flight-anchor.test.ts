// In-flight tool anchor (bridge-only, ephemeral): the Manager stamps a tool's
// start and projects an elapsed into `status.inFlightTools`, so a client that
// attaches mid-run — including a reconnect after the browser closed — recovers
// how long the tool has already run instead of starting the clock at attach.
// Nothing here is persisted or reaches pi's domain model.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionHandle } from "../../src/host/index.ts";
import type { BridgeHarness } from "./harness.ts";
import { createBridgeHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

/** Rebound by each test: the tool reports its start, then blocks on release. */
let markStarted: () => void = () => {};
let releaseTool: () => void = () => {};

function installGate(): Promise<void> {
	let resolveStart = () => {};
	const started = new Promise<void>((resolve) => {
		resolveStart = resolve;
	});
	markStarted = resolveStart;
	return started;
}

const slowTool: ToolDefinition = {
	name: "slow",
	label: "Slow",
	description: "Blocks until the test releases it.",
	parameters: Type.Object({}),
	async execute() {
		markStarted();
		await new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		return { content: [{ type: "text", text: "done" }], details: {} };
	},
};

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("in-flight tool anchor", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(async () => {
		// Release any still-blocked tool and let the turn settle before removing
		// the temp session dir, so the harness teardown cannot race a persist.
		releaseTool();
		for (const h of harnesses) {
			try {
				await waitFor(
					() =>
						!h.manager.document.status.isStreaming &&
						Object.keys(h.manager.document.status.inFlightTools ?? {}).length === 0,
					2000,
				);
			} catch {
				// best effort — cleanup still runs
			}
		}
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function runningTool(): Promise<{ h: BridgeHarness; toolCallId: string }> {
		const started = installGate();
		const h = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			customTools: [slowTool],
			responses: [
				fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("finished"),
			],
		});
		harnesses.push(h);
		void h.manager.prompt("run the slow tool");
		await started;
		const ids = Object.keys(h.manager.document.status.inFlightTools ?? {});
		expect(ids).toHaveLength(1);
		return { h, toolCallId: ids[0]! };
	}

	it("stamps the anchor at tool start", async () => {
		const { h, toolCallId } = await runningTool();
		const elapsed = h.manager.document.status.inFlightTools?.[toolCallId];
		expect(typeof elapsed).toBe("number");
		expect(elapsed).toBeGreaterThanOrEqual(0);
		expect(h.hasOp((op) => op.op === "replace" && op.path === "/status/inFlightTools")).toBe(true);
	});

	it("clears the anchor when the tool ends", async () => {
		const { h, toolCallId } = await runningTool();
		releaseTool();
		await waitFor(() => h.manager.document.status.inFlightTools?.[toolCallId] === undefined);
		expect(h.manager.document.status.inFlightTools?.[toolCallId]).toBeUndefined();
	});

	it("recovers the elapsed for a client attaching mid-run", async () => {
		const { h, toolCallId } = await runningTool();
		await new Promise((r) => setTimeout(r, 30));
		let frame: unknown;
		const handle: ConnectionHandle = {
			onInitialSync: (f) => {
				frame = f;
			},
			onPatch: () => {},
		};
		h.manager.addConnection(handle, {
			projectId: "p",
			sessionId: h.manager.liveSessionId,
			stem: "s",
		});
		const snapshot = frame as {
			document: { status: { inFlightTools?: Record<string, number> }; entries: Record<string, unknown> };
		};
		expect(snapshot.document.status.inFlightTools?.[toolCallId]).toBeGreaterThanOrEqual(25);
		// The tool-result entry's live form travels in the same snapshot, so the
		// client can associate the anchor with the running tool.
		const liveResult = Object.values(snapshot.document.entries).find(
			(entry) => (entry as { kind?: string; toolCallId?: string }).kind === "tool_result",
		);
		expect(liveResult).toBeDefined();
		releaseTool();
	});
});
