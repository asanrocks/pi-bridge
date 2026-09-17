// ============================================================================
// ViewModel key/navigation/phase unit tests — the pure seams the web client
// hooks (useViewModel, useKeyboardRing) are built on. Pure tests — no store,
// no DOM.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Document } from "../../src/core/types.ts";
import {
	computeViewModel,
	leafTextKey,
	liveActivityPhase,
	nextFocusedTurnKey,
	viewModelCacheKey,
} from "../../src/viewmodel/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function doc(overrides: Partial<Document["status"]> = {}): Document {
	return {
		status: {
			leafId: null,
			name: "",
			model: { provider: "p", modelId: "m" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
			contextUsage: null,
			pendingSteer: [],
			...overrides,
		},
		scopedModels: [],
		entries: {},
	};
}

function vmOf(entries: Document["entries"], leafId: string | null): ReturnType<typeof computeViewModel> {
	return computeViewModel({ document: { ...doc(), entries, status: { ...doc().status, leafId } }, models: [] });
}

// ---------------------------------------------------------------------------
// viewModelCacheKey — must contain every input that affects the projection
// (a missing field = stale VM; an extra field = needless recompute)
// ---------------------------------------------------------------------------

describe("viewModelCacheKey", () => {
	it("changes when a projected status field changes", () => {
		const base = viewModelCacheKey(doc(), "stem", 0);
		expect(viewModelCacheKey(doc({ name: "renamed" }), "stem", 0)).not.toBe(base);
		expect(viewModelCacheKey(doc({ model: { provider: "p", modelId: "other" } }), "stem", 0)).not.toBe(base);
		expect(viewModelCacheKey(doc({ thinkingLevel: "high" }), "stem", 0)).not.toBe(base);
		expect(viewModelCacheKey(doc({ isStreaming: true }), "stem", 0)).not.toBe(base);
		expect(viewModelCacheKey(doc({ isCompacting: true }), "stem", 0)).not.toBe(base);
		expect(
			viewModelCacheKey(doc({ contextUsage: { tokens: 100, contextWindow: 240, percent: 42 } }), "stem", 0),
		).not.toBe(base);
	});

	it("changes when the external inputs change (scope, pullTick)", () => {
		const base = viewModelCacheKey(doc(), "stem", 0);
		expect(viewModelCacheKey(doc(), "other-stem", 0)).not.toBe(base);
		expect(viewModelCacheKey(doc(), null, 0)).not.toBe(base);
		expect(viewModelCacheKey(doc(), "stem", 1)).not.toBe(base);
	});

	it("is stable across fields the projection does not read", () => {
		const base = viewModelCacheKey(doc(), "stem", 0);
		// pendingSteer/scopedModels are not projected (the renderer reads them
		// from the store directly) — flipping them must not re-key the VM.
		expect(viewModelCacheKey(doc({ pendingSteer: ["queued"] }), "stem", 0)).toBe(base);
	});
});

// ---------------------------------------------------------------------------
// leafTextKey — the jump-to-bottom notifier's "new content" signal
// ---------------------------------------------------------------------------

describe("leafTextKey", () => {
	function docOf(entries: Document["entries"], leafId: string | null): Document {
		return { ...doc(), entries, status: { ...doc().status, leafId } };
	}

	const entry = (over: Record<string, unknown>): Document["entries"][string] =>
		({
			id: "x",
			parentId: null,
			timestamp: "1",
			kind: "message",
			role: "assistant",
			content: [],
			...over,
		}) as unknown as Document["entries"][string];

	it("counts only text blocks, walking leaf->root", () => {
		const entries = {
			u1: entry({ id: "u1", role: "user", content: [{ type: "text", text: "hi" }] }),
			a1: entry({
				id: "a1",
				parentId: "u1",
				content: [
					{ type: "thinking", thinking: "hmm", signature: "s" },
					{ type: "text", text: "yo" },
					{ type: "toolCall", id: "t", name: "bash", arguments: null },
				],
			}),
		} as Document["entries"];
		expect(leafTextKey(docOf(entries, "a1"))).toBe("a1:2|u1:2");
	});

	it("is unchanged by thinking/tool growth", () => {
		const before = {
			a1: entry({
				id: "a1",
				content: [
					{ type: "text", text: "yo" },
					{ type: "thinking", thinking: "hmm", signature: "s" },
				],
			}),
		} as Document["entries"];
		const after = {
			a1: entry({
				id: "a1",
				content: [
					{ type: "text", text: "yo" },
					{ type: "thinking", thinking: "hmm hmm hmm", signature: "s" },
					{ type: "toolCall", id: "t", name: "bash", arguments: null },
				],
			}),
		} as Document["entries"];
		expect(leafTextKey(docOf(after, "a1"))).toBe(leafTextKey(docOf(before, "a1")));
	});

	it("changes on text growth and on a new user message", () => {
		const before = {
			a1: entry({ id: "a1", content: [{ type: "text", text: "yo" }] }),
		} as Document["entries"];
		const grown = {
			a1: entry({ id: "a1", content: [{ type: "text", text: "yo yo" }] }),
		} as Document["entries"];
		expect(leafTextKey(docOf(grown, "a1"))).not.toBe(leafTextKey(docOf(before, "a1")));

		const withUser = {
			...before,
			u1: entry({ id: "u1", parentId: "a1", role: "user", content: [{ type: "text", text: "?" }] }),
		} as Document["entries"];
		expect(leafTextKey(docOf(withUser, "u1"))).not.toBe(leafTextKey(docOf(before, "a1")));
	});
});

// ---------------------------------------------------------------------------
// nextFocusedTurnKey — j/k step navigation
// ---------------------------------------------------------------------------

describe("nextFocusedTurnKey", () => {
	// user -> assistant -> user -> assistant
	const entries: Document["entries"] = {
		u1: {
			id: "u1",
			parentId: null,
			timestamp: "1",
			kind: "message",
			role: "user",
			content: [{ type: "text", text: "hi" }],
		},
		a1: {
			id: "a1",
			parentId: "u1",
			timestamp: "2",
			kind: "message",
			role: "assistant",
			content: [{ type: "text", text: "yo" }],
		},
		u2: {
			id: "u2",
			parentId: "a1",
			timestamp: "3",
			kind: "message",
			role: "user",
			content: [{ type: "text", text: "?" }],
		},
		a2: {
			id: "a2",
			parentId: "u2",
			timestamp: "4",
			kind: "message",
			role: "assistant",
			content: [{ type: "text", text: "!" }],
		},
	} as unknown as Document["entries"];
	const vm = vmOf(entries, "a2");

	it("steps by turn key identity", () => {
		expect(nextFocusedTurnKey(vm.turns, "u2", "prev", () => 0)).toBe("a1");
		expect(nextFocusedTurnKey(vm.turns, "a1", "next", () => 0)).toBe("u2");
	});

	it("clamps at both ends", () => {
		expect(nextFocusedTurnKey(vm.turns, "u1", "prev", () => 0)).toBe("u1");
		expect(nextFocusedTurnKey(vm.turns, "a2", "next", () => 0)).toBe("a2");
	});

	it("falls back to the lazy index when the focus is stale or missing", () => {
		let called = 0;
		// fallback index 1 + next → nav[2] ("u2")
		expect(
			nextFocusedTurnKey(vm.turns, null, "next", () => {
				called++;
				return 1;
			}),
		).toBe("u2");
		expect(called).toBe(1); // fallback is paid only when needed
		expect(
			nextFocusedTurnKey(vm.turns, "u1", "next", () => {
				called++;
				return 99;
			}),
		).toBe("a1");
		expect(called).toBe(1); // focused turn found — fallback not invoked
	});

	it("returns null for an empty list", () => {
		expect(nextFocusedTurnKey([], null, "next", () => 0)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// liveActivityPhase — what the streaming run is doing
// ---------------------------------------------------------------------------

describe("liveActivityPhase", () => {
	function assistantVm(
		blocks: unknown[],
		extraEntries: Document["entries"] = {},
		leafId = "a1",
	): ReturnType<typeof computeViewModel> {
		const entries: Document["entries"] = {
			u1: {
				id: "u1",
				parentId: null,
				timestamp: "1",
				kind: "message",
				role: "user",
				content: [{ type: "text", text: "hi" }],
			},
			a1: {
				id: "a1",
				parentId: "u1",
				timestamp: "2",
				kind: "message",
				role: "assistant",
				content: blocks,
			},
			...extraEntries,
		} as unknown as Document["entries"];
		return vmOf(entries, leafId);
	}

	it("returns text when the last turn is a user turn or the list is empty", () => {
		const userLeaf = vmOf(
			{
				u1: {
					id: "u1",
					parentId: null,
					timestamp: "1",
					kind: "message",
					role: "user",
					content: [{ type: "text", text: "hi" }],
				},
			} as unknown as Document["entries"],
			"u1",
		);
		expect(liveActivityPhase(userLeaf)).toBe("text");
		expect(liveActivityPhase({ turns: [], leafEntryId: null, pathKey: "", streamingKey: "", textKey: "" })).toBe(
			"text",
		);
	});

	it("walks backwards to the latest block with a live signal", () => {
		// live tool last (dispatched, no result yet)
		expect(
			liveActivityPhase(
				assistantVm([
					{ type: "text", text: "running" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: null },
				]),
			),
		).toBe("tool");
		// finished tool (durable result entry attached) skipped → text
		expect(
			liveActivityPhase(
				assistantVm(
					[
						{ type: "text", text: "done" },
						{ type: "toolCall", id: "t2", name: "read", arguments: "{}" },
					],
					{
						tr2: {
							kind: "tool_result",
							id: "tr2",
							parentId: "a1",
							timestamp: "3",
							toolCallId: "t2",
							toolName: "read",
							content: [{ type: "text", text: "ok" }],
							details: null,
							isError: false,
						},
					},
					"tr2",
				),
			),
		).toBe("text");
		// unredacted thinking
		expect(liveActivityPhase(assistantVm([{ type: "thinking", thinking: "hmm", signature: "s" }]))).toBe("thinking");
	});

	it("falls back to text when every block is done/redacted", () => {
		expect(
			liveActivityPhase(assistantVm([{ type: "thinking", thinking: "hmm", signature: "s", redacted: true }])),
		).toBe("text");
	});
});
