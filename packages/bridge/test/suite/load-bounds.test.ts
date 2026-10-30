// Load bounds — the wire and store cost of a large streamed tool payload,
// measured through the real stack (Daemon, BridgeClient, pipeline,
// navigation; see trace-harness.ts). A tool that reports a progressively
// growing body must cost the wire linearly in the body, not quadratically in
// the update count: each progressive update is encoded as a lazy-marked
// append of its suffix (delivered only to a client that pulled the streaming
// body — laziness holds for everyone else), and the store is repainted at
// the flush cadence, not the update cadence.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalClient } from "../../web/src/infra/net/client.ts";
import { flushPullQueue } from "../../web/src/infra/net/pullLoop.ts";
import { enqueuePulls } from "../../web/src/infra/net/pullQueue.ts";
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

const UPDATES = 50;
const CHUNK = "x".repeat(2048); // 2 KiB per update → ~100 KiB body

/** A tool whose partial updates report the body accumulated so far (pi's
 * progressive-partial semantics), like a long-running command streaming
 * output. */
const accumulatingTool: ToolDefinition = {
	name: "accumulating-echo",
	label: "Accumulating Echo",
	description: "Streams a growing body across many updates.",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, signal, onUpdate) {
		let body = "";
		for (let i = 1; i <= UPDATES; i++) {
			if (signal?.aborted) throw new Error("Operation aborted");
			body += CHUNK;
			onUpdate?.({ content: [{ type: "text", text: body }], details: { chunk: i } });
			// A paced stream (20 ms per update) keeps a deterministic window
			// for the client's pull to subscribe the live field mid-stream.
			await new Promise((r) => setTimeout(r, 20));
		}
		return { content: [{ type: "text", text: body }], details: { chunks: UPDATES } };
	},
};

const daemons: TraceDaemon[] = [];
const clients: TraceClient[] = [];

afterEach(async () => {
	while (clients.length) clients.pop()?.close();
	while (daemons.length) await daemons.pop()?.cleanup();
	setGlobalClient(null);
});

describe("streamed tool payload bounds", () => {
	it("the wire cost is linear in the body, and the store repaints at the flush cadence", async () => {
		const d = await startTraceDaemon(["load-a"], { customTools: [accumulatingTool] });
		daemons.push(d);
		d.setResponses([
			fauxAssistantMessage(fauxToolCall("accumulating-echo", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		resetStoreState();
		const tc = await connectClient(d.port);
		clients.push(tc);
		await openAndCommit(d.projectId, "load-a");
		const manager = d.managerOf("load-a")!;

		let storeWrites = 0;
		const unsub = getStore().subscribe(() => {
			storeWrites += 1;
		});
		const framesBefore = tc.frames.length;

		// A client viewing the streaming tool card pulls the live body once:
		// the pull fills what has streamed so far and subscribes the field,
		// so the remaining updates arrive as suffix appends. A client that
		// never pulled receives none of them (the lazy-marked append is
		// withheld like the full-field replace it encodes).
		setGlobalClient(tc.client);
		const prompt = tc.client.prompt("run it");
		// The fixture carries its own (sealed) tool results; the probe targets
		// the accumulating tool's own live form.
		const isStreamingBody = (e: { kind: string; toolName?: string; isSealed?: boolean }) =>
			e.kind === "tool_result" && e.toolName === "accumulating-echo" && e.isSealed !== true;
		await waitFor(
			() =>
				Object.values(manager.document.entries).some((e) => isStreamingBody(e as typeof e & { toolName?: string })),
			"the tool body to start streaming",
		);
		// Only the id is captured mid-stream: the entry object is replaced at
		// the seal (immutable structural sharing), so the canonical form is
		// re-read after the turn settles.
		const toolResultId = Object.values(manager.document.entries).find(
			(e) => (e as { kind: string; toolName?: string }).toolName === "accumulating-echo",
		)!.id;
		enqueuePulls([{ entryId: toolResultId, fieldPath: `/entries/${toolResultId}/content` }]);
		await flushPullQueue();

		const reply = await prompt;
		expect(reply.ok).toBe(true);
		await waitFor(() => !getStore().getState().document.status.isStreaming, "the turn to settle");
		tc.scheduler.flushFrame();
		unsub();

		// ── Convergence: the mirror projects the canonical Document. ──────
		assertMirrorProjectsCanonical(manager.document, tc.client.mirror.document, "after the load turn");
		const toolResult = manager.document.entries[toolResultId] as {
			content: Array<{ type: string; text: string }>;
		};
		const canonicalText = toolResult.content[0]!.text;
		const filled = tc.client.mirror.document.entries[toolResultId] as {
			content: Array<{ type: string; text: string | null }>;
		};
		expect(filled.content[0]?.text).toBe(canonicalText);

		// ── Wire cost: the streamed body crossed as suffix appends. ────────
		// A full-content replace per update would re-send everything so far:
		// ~2 KiB × (1 + 2 + … + 50) ≈ 2.5 MiB of payload before envelopes.
		// The bounded encoding sends each 2 KiB suffix once, plus the full
		// body at the tool's end and the seal.
		const turnFrames = tc.frames.slice(framesBefore);
		const patchBytes = turnFrames.reduce(
			(sum, f, i) => (f.kind === "patch" ? sum + (tc.frameSizes[framesBefore + i] ?? 0) : sum),
			0,
		);
		const bodyBytes = UPDATES * CHUNK.length;
		expect(patchBytes).toBeLessThan(bodyBytes * 4);

		const streamedOps = turnFrames.flatMap((f) =>
			f.kind === "patch" ? ((f.ops ?? []) as Array<{ op: string; path: string }>) : [],
		);
		const bodyReplaces = streamedOps.filter(
			(op) => op.op === "replace" && /^\/entries\/[^/]+\/content$/.test(op.path),
		);
		// The tool's final result replace is the only full-body frame — not
		// one per streamed update.
		expect(bodyReplaces.length).toBeLessThanOrEqual(2);
		const appends = streamedOps.filter((op) => op.op === "append" && /\/content\/\d+\/text$/.test(op.path));

		// The updates after the pull subscribed the field all arrived as
		// suffix appends.
		expect(appends.length).toBeGreaterThanOrEqual(10);

		// ── Store cadence: coalescing held the repaint rate at the flush
		// cadence (status flushes, the pull ingest, and the manual flush), not
		// the update cadence.
		expect(storeWrites).toBeLessThanOrEqual(UPDATES / 2);

		// ── One pull filled the body: exactly one pull reply crossed the wire
		// (the frames record server→client traffic; a pull reply carries
		// `values`).
		const pulls = tc.frames.filter((f) => Array.isArray((f as { values?: unknown }).values));
		expect(pulls).toHaveLength(1);
	});
});
