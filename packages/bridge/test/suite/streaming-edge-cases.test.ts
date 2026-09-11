import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AddOp, PatchOp } from "../../src/core/index.ts";
import type { BridgeHarness, MirrorHarness } from "./harness.ts";
import { assertMirrorInSync, createBridgeHarness, createMirrorHarness } from "./harness.ts";

const FIXTURE_URL = new URL("../../../coding-agent/test/fixtures/before-compaction.jsonl", import.meta.url);

// ---------------------------------------------------------------------------
// Test tools
// ---------------------------------------------------------------------------

const streamingEchoTool: ToolDefinition = {
	name: "streaming-echo",
	label: "Streaming Echo",
	description: "Echoes text back with streaming updates.",
	parameters: Type.Object({ text: Type.String() }),
	async execute(_toolCallId, params, signal, onUpdate) {
		const text = (params as { text: string }).text;
		const steps = 3;
		for (let i = 1; i <= steps; i++) {
			if (signal?.aborted) throw new Error("Operation aborted");
			onUpdate?.({
				content: [{ type: "text", text: `streaming chunk ${i}/${steps}` }],
				details: { chunk: i, total: steps },
			});
			await new Promise((r) => setTimeout(r, 10));
		}
		return {
			content: [{ type: "text", text: `final: ${text}` }],
			details: { chunk: steps, total: steps, done: true },
		};
	},
};

const noopTool: ToolDefinition = {
	name: "noop",
	label: "No-op",
	description: "Returns immediately.",
	parameters: Type.Object({ id: Type.String() }),
	async execute(_toolCallId, params) {
		const id = (params as { id: string }).id;
		return {
			content: [{ type: "text", text: `noop: ${id}` }],
			details: { id },
		};
	},
};

const errorTool: ToolDefinition = {
	name: "error-tool",
	label: "Error Tool",
	description: "Always throws.",
	parameters: Type.Object({ message: Type.String() }),
	async execute(_toolCallId, params) {
		throw new Error((params as { message: string }).message);
	},
};

// ---------------------------------------------------------------------------
// Client harness with op tracking (keeps per-op assertions for streaming tests)
// ---------------------------------------------------------------------------

interface TrackedMirror {
	mh: MirrorHarness;
	/** Patches received from the bus after init. */
	patches: Array<{ ops: PatchOp[] }>;
	/** All ops across all patches. */
	ops: PatchOp[];
	cleanup: () => void;
}

function createTrackedMirror(bh: BridgeHarness): TrackedMirror {
	const mh = createMirrorHarness(bh);

	const patches: Array<{ ops: PatchOp[] }> = [];
	const allOps: PatchOp[] = [];

	// Subscribe an additional listener for op tracking
	bh.manager.onPatch((patch) => {
		patches.push(patch);
		allOps.push(...patch.ops);
	});

	return { mh, patches, ops: allOps, cleanup: bh.cleanup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streaming edge cases", () => {
	const harnesses: BridgeHarness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	// ── tool execution streaming ──────────────────────────────────────────

	it("streaming tool execution delivers incremental updates to the client", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage(fauxToolCall("streaming-echo", { text: "hello" }), { stopReason: "toolUse" }),
			],
			customTools: [streamingEchoTool],
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		await tm.mh.manager.prompt("run streaming-echo");

		assertMirrorInSync(tm.mh, "after streaming tool turn");

		// The client receives replace ops on tool result content during streaming
		const toolContentOps = tm.ops.filter(
			(op) => op.path.includes("pending:") && op.path.includes("/content") && op.op === "replace",
		);
		expect(toolContentOps.length).toBeGreaterThanOrEqual(3);

		// After the turn, the client mirror has the final tool result
		const toolResults = Object.values(tm.mh.mirror.document.entries).filter(
			(e) => e.kind === "tool_result" && e.toolName === "streaming-echo",
		);
		expect(toolResults.length).toBe(1);
		const tr = toolResults[0];
		if (tr.kind === "tool_result" && Array.isArray(tr.content)) {
			const textBlocks = tr.content.filter((b: { type: string }) => b.type === "text");
			expect(textBlocks.length).toBeGreaterThan(0);
			expect((textBlocks[0] as { text: string }).text).toContain("final: hello");
		}

		// No provisional entries left in the mirror
		const provisionalIds = Object.keys(tm.mh.mirror.document.entries).filter((id) => id.startsWith("pending:"));
		expect(provisionalIds).toEqual([]);
	}, 60000);

	// ── concurrent tool execution ─────────────────────────────────────────

	it("concurrent tool calls produce multiple tool results in the client mirror", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage([fauxToolCall("noop", { id: "a" }), fauxToolCall("noop", { id: "b" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
			customTools: [noopTool],
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		await tm.mh.manager.prompt("run two noops");

		assertMirrorInSync(tm.mh, "after concurrent tools");

		// The client received add ops for two pending tool result entries
		const addOps = tm.ops.filter(
			(op) =>
				op.op === "add" &&
				op.path.startsWith("/entries/pending:") &&
				!op.path.includes("/content") &&
				!op.path.includes("/details"),
		);
		const toolPendingAdds = addOps.filter((op) => {
			const val = (op as AddOp).value as { kind?: string } | undefined;
			return val?.kind === "tool_result";
		});
		expect(toolPendingAdds.length).toBe(2);

		// After the turn, two noop results in the mirror
		const noopResults = Object.values(tm.mh.mirror.document.entries).filter(
			(e) => e.kind === "tool_result" && e.toolName === "noop",
		);
		expect(noopResults.length).toBe(2);
	}, 60000);

	// ── tool execution error ──────────────────────────────────────────────

	it("throwing tool produces tool_result with isError true in the client mirror", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage(fauxToolCall("error-tool", { message: "tool failed" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done after error"),
			],
			customTools: [errorTool],
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		await tm.mh.manager.prompt("run error tool");

		assertMirrorInSync(tm.mh, "after error tool turn");

		const errorResults = Object.values(tm.mh.mirror.document.entries).filter(
			(e) => e.kind === "tool_result" && e.toolName === "error-tool",
		);
		expect(errorResults.length).toBe(1);
		const tr = errorResults[0];
		expect(tr.kind).toBe("tool_result");
		if (tr.kind === "tool_result") {
			expect(tr.isError).toBe(true);
			if (Array.isArray(tr.content) && tr.content.length > 0) {
				const tb = tr.content.filter((b: { type: string }) => b.type === "text")[0] as {
					text: string;
				};
				expect(tb.text).toContain("tool failed");
			}
		}
	}, 60000);

	// ── cancel / abort mid-stream ─────────────────────────────────────────

	it("abort mid-stream delivers aborted stopReason to the client", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("This is a longer response that streams across multiple macrotasks.")],
			tokensPerSecond: 1,
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		const promptPromise = tm.mh.manager.prompt("abort test");

		await new Promise((r) => setTimeout(r, 200));
		await tm.mh.manager.abort();
		await promptPromise;

		assertMirrorInSync(tm.mh, "after abort");

		// After abort, the client mirror has an assistant with stopReason "aborted"
		const assistants = Object.values(tm.mh.mirror.document.entries).filter(
			(e) => e.kind === "message" && e.role === "assistant",
		);
		expect(assistants.length).toBeGreaterThan(0);
		const last = assistants[assistants.length - 1];
		expect(last.kind).toBe("message");
		if (last.kind === "message") {
			expect(last.stopReason).toBe("aborted");
		}

		// No provisional entries left
		const provisionals = Object.keys(tm.mh.mirror.document.entries).filter((id) => id.startsWith("pending:"));
		expect(provisionals).toEqual([]);

		// Status settled
		expect(tm.mh.mirror.document.status.isStreaming).toBe(false);
	}, 60000);

	// ── abort during tool execution ───────────────────────────────────────

	it("abort during tool execution delivers isError tool result to the client", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage([fauxToolCall("streaming-echo", { text: "long-running" })], {
					stopReason: "toolUse",
				}),
			],
			customTools: [streamingEchoTool],
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		const promptPromise = tm.mh.manager.prompt("abort during tool");

		await new Promise((r) => setTimeout(r, 5));
		await tm.mh.manager.abort();
		await promptPromise;

		assertMirrorInSync(tm.mh, "after tool abort");

		const echoResults = Object.values(tm.mh.mirror.document.entries).filter(
			(e) => e.kind === "tool_result" && e.toolName === "streaming-echo",
		);
		expect(echoResults.length).toBeGreaterThan(0);
		const tr = echoResults[echoResults.length - 1];
		if (tr.kind === "tool_result") {
			expect(tr.isError).toBe(true);
		}
	}, 60000);

	// ── provider error ────────────────────────────────────────────────────

	it("provider error delivers stopReason and errorMessage to the client mirror", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [
				fauxAssistantMessage("partial content before error", {
					stopReason: "error",
					errorMessage: "Simulated API error",
				}),
			],
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		await tm.mh.manager.prompt("trigger error");

		assertMirrorInSync(tm.mh, "after provider error");

		const assistants = Object.values(tm.mh.mirror.document.entries).filter(
			(e) => e.kind === "message" && e.role === "assistant",
		);
		const last = assistants[assistants.length - 1];
		expect(last.kind).toBe("message");
		if (last.kind === "message") {
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe("Simulated API error");
		}

		// No provisional entries left
		const provisionals = Object.keys(tm.mh.mirror.document.entries).filter((id) => id.startsWith("pending:"));
		expect(provisionals).toEqual([]);
	}, 60000);

	// ── silent entries (thinking_level_change via reconcile) ──────────────

	it("thinking_level_change appears in client mirror and status updated", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("ok")],
		});
		harnesses.push(harness);
		const mh = createMirrorHarness(harness);

		mh.manager.setThinkingLevel("high");

		await mh.manager.prompt("test");

		assertMirrorInSync(mh, "after thinking level change");

		// The client mirror has the thinking_level_change entry
		const thinkingEntries = Object.values(mh.mirror.document.entries).filter(
			(e) => e.kind === "thinking_level_change",
		);
		expect(thinkingEntries.length).toBeGreaterThan(0);

		// The mirror's status reflects the change
		expect(mh.mirror.document.status.thinkingLevel).toBe("high");
	}, 60000);

	// ── steering: concurrent user messages ───────────────────────────────

	it("steered user messages arrive as committed entries in the client mirror", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("processing...")],
			tokensPerSecond: 1,
			settings: { steeringMode: "all" },
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		const turnPromise = tm.mh.manager.prompt("first message");

		await new Promise((r) => setTimeout(r, 50));
		const s1 = tm.mh.manager.prompt("steer msg 1");
		await new Promise((r) => setTimeout(r, 50));
		const s2 = tm.mh.manager.prompt("steer msg 2");

		await Promise.all([turnPromise, s1, s2]);

		assertMirrorInSync(tm.mh, "after steering");

		// All three user messages are committed in the mirror
		const userMessages = Object.values(tm.mh.mirror.document.entries).filter(
			(e) => e.kind === "message" && e.role === "user",
		);
		expect(userMessages.length).toBeGreaterThanOrEqual(3);

		// No provisional entries left
		const provisionals = Object.keys(tm.mh.mirror.document.entries).filter((id) => id.startsWith("pending:"));
		expect(provisionals).toEqual([]);
	}, 60000);

	// ── steering: pending-queue visibility + discard ──────────────────────

	it("pending steers surface in status and discardSteer clears them", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("processing...")],
			tokensPerSecond: 1,
			settings: { steeringMode: "all" },
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		const turnPromise = tm.mh.manager.prompt("first message");
		await new Promise((r) => setTimeout(r, 50));

		// Queue a steer mid-stream. queue_update fires synchronously during
		// session.prompt, so the /status/pendingSteer patch reaches the mirror
		// before the call resolves.
		await tm.mh.manager.prompt("steer msg");
		expect(tm.mh.mirror.document.status.pendingSteer).toEqual(["steer msg"]);
		expect(tm.ops.some((op) => op.op === "replace" && op.path === "/status/pendingSteer")).toBe(true);
		assertMirrorInSync(tm.mh, "after queueing steer");

		// Discard clears the queue without delivering the steer.
		await tm.mh.manager.discardSteer();
		expect(tm.mh.mirror.document.status.pendingSteer).toEqual([]);
		assertMirrorInSync(tm.mh, "after discardSteer");

		// No user message for the discarded steer was committed.
		const steered = Object.values(tm.mh.mirror.document.entries).filter(
			(e) =>
				e.kind === "message" &&
				e.role === "user" &&
				e.content.some((c) => c.type === "text" && c.text.includes("steer msg")),
		);
		expect(steered).toEqual([]);

		// Let the in-flight turn settle so afterEach cleanup is clean.
		await tm.mh.manager.abort();
		await turnPromise;
	}, 60000);

	// ── steering: server Stop contract (stop + clear, no auto-deliver) ──

	it("abort stops the assistant and clears the steer queue (no auto-delivery)", async () => {
		const harness = await createBridgeHarness({
			fixturePath: FIXTURE_URL.pathname,
			responses: [fauxAssistantMessage("processing...")],
			tokensPerSecond: 1,
			settings: { steeringMode: "all" },
		});
		harnesses.push(harness);
		const tm = createTrackedMirror(harness);

		const turnPromise = tm.mh.manager.prompt("first message");
		await new Promise((r) => setTimeout(r, 50));

		// Queue a steer mid-stream.
		await tm.mh.manager.prompt("steer msg");
		expect(tm.mh.mirror.document.status.pendingSteer).toEqual(["steer msg"]);

		// Server Stop contract: abort clears the steer queue before the
		// idle-wait, so the post-abort auto-continue
		// (_handlePostAgentRun → hasQueuedMessages → agent.continue →
		// steeringQueue.drain) does not deliver the steer as a new turn.
		// The clear is destructive by design — draft refill is a client
		// concern (out of scope for this raw-object server test).
		await tm.mh.manager.abort();
		await turnPromise;

		expect(tm.mh.mirror.document.status.pendingSteer).toEqual([]);

		// No user message for the steer was committed.
		const steered = Object.values(tm.mh.mirror.document.entries).filter(
			(e) =>
				e.kind === "message" &&
				e.role === "user" &&
				e.content.some((c) => c.type === "text" && c.text.includes("steer msg")),
		);
		expect(steered).toEqual([]);

		assertMirrorInSync(tm.mh, "after abort");
	}, 60000);
}, 60000);
