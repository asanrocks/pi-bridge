/**
 * Wants outbox + planPull unit tests (ADR 09).
 * Tests the pure batching step (planPull) and per-step wants derivation
 * (stepWants), plus the microtask-scheduled drainer lifecycle.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DocumentMirror, type PullRequestItem, planPull } from "../../src/core/index.ts";
import type { Document } from "../../src/core/types.ts";
import type { ThinkActionStepVM, ToolActionStepVM } from "../../src/viewmodel/index.ts";
import { stepWants } from "../../src/viewmodel/index.ts";
import { setWantsDrainer, takeWants, wantPull } from "../../web/src/infra/net/wants.ts";

// ── planPull (pure batching step) ──────────────────────────────────────────

function emptyMirror(doc?: Document): DocumentMirror {
	return new DocumentMirror(doc);
}

function defaultStatus(): Document["status"] {
	return {
		leafId: null,
		name: "",
		model: { provider: "", modelId: "" },
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
		contextUsage: null,
		pendingSteer: [],
	};
}

function makeDoc(overrides: Partial<Document> = {}): Document {
	const doc: Document = { status: defaultStatus(), scopedModels: [], entries: {} };
	Object.assign(doc, overrides);
	return doc;
}

function wants(item: { entryId: string; fieldPath: string }): PullRequestItem {
	return item;
}

describe("planPull", () => {
	it("deduplicates by fieldPath", () => {
		const mirror = emptyMirror();
		const items = [
			wants({ entryId: "a1", fieldPath: "/entries/a1/content/0/arguments" }),
			wants({ entryId: "a1", fieldPath: "/entries/a1/content/0/arguments" }),
			wants({ entryId: "a1", fieldPath: "/entries/a1/content/1/arguments" }),
		];
		const result = planPull(items, mirror, new Set());
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.fieldPath).sort()).toEqual([
			"/entries/a1/content/0/arguments",
			"/entries/a1/content/1/arguments",
		]);
	});

	it("filters out already-populated fields (needsPull)", () => {
		const doc = makeDoc({
			entries: {
				a1: {
					kind: "message",
					id: "a1",
					parentId: null,
					timestamp: "t",
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: '{"path":"/x"}' },
						{ type: "toolCall", id: "tc2", name: "write", arguments: null },
					],
				},
			},
		});
		const mirror = emptyMirror(doc);

		const items = [
			wants({ entryId: "a1", fieldPath: "/entries/a1/content/0/arguments" }), // populated
			wants({ entryId: "a1", fieldPath: "/entries/a1/content/1/arguments" }), // null — keep
		];
		const result = planPull(items, mirror, new Set());
		expect(result).toHaveLength(1);
		expect(result[0].fieldPath).toBe("/entries/a1/content/1/arguments");
	});

	it("filters out paths with in-flight pulls (loadingPaths)", () => {
		const doc = makeDoc({
			entries: {
				a1: {
					kind: "message",
					id: "a1",
					parentId: null,
					timestamp: "t",
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read", arguments: null }],
				},
			},
		});
		const mirror = emptyMirror(doc);

		const items = [wants({ entryId: "a1", fieldPath: "/entries/a1/content/0/arguments" })];
		const result = planPull(items, mirror, new Set(["/entries/a1/content/0/arguments"]));
		expect(result).toHaveLength(0);
	});
});

// ── stepWants ───────────────────────────────────────────────────────────

function thinkStep(overrides: Partial<ThinkActionStepVM> = {}): ThinkActionStepVM {
	return {
		blockType: "thinking",
		entryId: "a1",
		blockIndex: 0,
		thinking: null,
		isProvisional: false,
		redacted: false,
		...overrides,
	};
}

function toolStep(overrides: Partial<ToolActionStepVM> = {}): ToolActionStepVM {
	return {
		blockType: "tool",
		entryId: "a1",
		blockIndex: 1,
		toolName: "read",
		toolCallId: "tc1",
		arguments: null,
		result: null,
		summary: "read",
		status: "done",
		...overrides,
	};
}

describe("stepWants", () => {
	it("think step wants thinking (collapsed or expanded)", () => {
		const h = thinkStep();
		expect(stepWants(h, false)).toEqual([{ entryId: "a1", fieldPath: "/entries/a1/content/0/thinking" }]);
		expect(stepWants(h, true)).toEqual([{ entryId: "a1", fieldPath: "/entries/a1/content/0/thinking" }]);
	});

	it("redacted think step wants nothing", () => {
		const h = thinkStep({ redacted: true });
		expect(stepWants(h, false)).toEqual([]);
	});

	it("tool step wants arguments always, result only when expanded", () => {
		const h = toolStep({ result: { entryId: "tr1", isError: false } });
		const collapsed = stepWants(h, false);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0].fieldPath).toBe("/entries/a1/content/1/arguments");

		const expanded = stepWants(h, true);
		expect(expanded).toHaveLength(3);
		expect(expanded.map((w) => w.fieldPath).sort()).toEqual(
			["/entries/a1/content/1/arguments", "/entries/tr1/content", "/entries/tr1/details"].sort(),
		);
	});

	it("tool step without result wants arguments even when expanded", () => {
		const h = toolStep();
		expect(stepWants(h, true)).toEqual([{ entryId: "a1", fieldPath: "/entries/a1/content/1/arguments" }]);
	});
});

// ── Wants outbox (scheduling) ──────────────────────────────────────────────

describe("wants outbox", () => {
	afterEach(() => {
		setWantsDrainer(null);
		takeWants(); // clear leftover
	});

	it("wantPull appends items and schedules drain via microtask", async () => {
		const drained: PullRequestItem[][] = [];
		setWantsDrainer(() => {
			drained.push(takeWants());
		});

		wantPull([{ entryId: "a1", fieldPath: "/entries/a1/content/0/arguments" }]);
		wantPull([{ entryId: "a1", fieldPath: "/entries/a1/content/1/arguments" }]);

		// Drain scheduled but not yet executed (microtask)
		expect(drained).toHaveLength(0);

		// Await microtask
		await new Promise<void>((r) => queueMicrotask(r));

		expect(drained).toHaveLength(1);
		expect(drained[0]).toHaveLength(2);
	});

	it("takeWants clears the outbox", () => {
		setWantsDrainer(() => {});
		wantPull([{ entryId: "a1", fieldPath: "/entries/a1/content/0/thinking" }]);
		const items = takeWants();
		expect(items).toHaveLength(1);
		expect(takeWants()).toHaveLength(0);
	});

	it("drain is a no-op when no drainer is registered", async () => {
		wantPull([{ entryId: "a1", fieldPath: "/entries/a1/content/0/thinking" }]);
		await new Promise<void>((r) => queueMicrotask(r));
		// Items remain in outbox (no drainer to consume them)
		expect(takeWants()).toHaveLength(1);
	});

	it("two renders before microtask fire accumulate (dedup handled by planPull)", () => {
		const drained: PullRequestItem[][] = [];
		setWantsDrainer(() => {
			drained.push(takeWants());
		});

		// Same fieldPath appended twice across two "renders"
		wantPull([{ entryId: "a1", fieldPath: "/entries/a1/content/0/arguments" }]);
		wantPull([{ entryId: "a1", fieldPath: "/entries/a1/content/0/arguments" }]);

		// Still only one drain scheduled (second call skipped scheduling)
		expect(drained).toHaveLength(0);
	});
});
