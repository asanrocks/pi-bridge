// ============================================================================
// nextSelection tests — the stateless client API's send-time heuristic:
// pick precedence, path inheritance (compose from the live leaf, edit from
// the fork point), catalogue validation, and the display fallbacks.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Document, Entry, MessageEntry, ModelInfo } from "../../../../src/core/index.ts";
import type { ComposerDraft, SelectionPick } from "../../infra/state/composer.ts";
import { nextSelectionOf } from "./nextSelection.ts";

function messageEntry(id: string, parentId: string | null, ord: number, extra: Partial<MessageEntry> = {}): Entry {
	return { kind: "message", id, parentId, timestamp: `t${ord}`, role: "user", content: [], ord, ...extra };
}

function documentOf(entries: Record<string, Entry>, leafId: string | null): Document {
	return {
		status: {
			leafId,
			name: "",
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "medium",
			isStreaming: false,
			isCompacting: false,
			stats: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: { total: 0 },
				messages: 0,
			},
			contextUsage: null,
			pendingSteer: [],
		},
		entries,
	};
}

const MODELS: ModelInfo[] = [
	{
		provider: "faux",
		providerName: "Faux",
		id: "faux-1",
		name: "Faux 1",
		reasoning: false,
		supportedThinkingLevels: ["off", "low", "medium", "high"],
		contextWindow: 100000,
	},
	{
		provider: "faux",
		providerName: "Faux",
		id: "faux-2",
		name: "Faux 2",
		reasoning: true,
		supportedThinkingLevels: ["off", "medium", "high"],
		contextWindow: 100000,
	},
];

const IDLE: ComposerDraft = { kind: "idle" };

describe("nextSelection — compose", () => {
	it("inherits the path's last model_change and carries it", () => {
		const entries: Record<string, Entry> = {
			mc: {
				kind: "model_change",
				id: "mc",
				parentId: null,
				timestamp: "t0",
				provider: "faux",
				modelId: "faux-2",
				ord: 0,
			},
			user: messageEntry("user", "mc", 1),
		};
		const sel = nextSelectionOf({ document: documentOf(entries, "user"), draft: IDLE, pick: null, models: MODELS });
		expect(sel.model).toEqual({ provider: "faux", modelId: "faux-2" });
		expect(sel.carryModel).toEqual({ provider: "faux", modelId: "faux-2" });
	});

	it("falls back to the live model for display but carries nothing when the path records no model", () => {
		const entries: Record<string, Entry> = { user: messageEntry("user", null, 0) };
		const sel = nextSelectionOf({ document: documentOf(entries, "user"), draft: IDLE, pick: null, models: MODELS });
		expect(sel.model).toEqual({ provider: "faux", modelId: "faux-1" });
		expect(sel.carryModel).toBeUndefined();
		expect(sel.level).toBe("medium");
		expect(sel.carryLevel).toBeUndefined();
	});

	it("drops an inherited model the catalogue no longer resolves", () => {
		const entries: Record<string, Entry> = {
			mc: {
				kind: "model_change",
				id: "mc",
				parentId: null,
				timestamp: "t0",
				provider: "gone",
				modelId: "gone-1",
				ord: 0,
			},
			user: messageEntry("user", "mc", 1),
		};
		const sel = nextSelectionOf({ document: documentOf(entries, "user"), draft: IDLE, pick: null, models: MODELS });
		expect(sel.carryModel).toBeUndefined();
		expect(sel.model).toEqual({ provider: "faux", modelId: "faux-1" });
	});

	it("inherits the path's thinking_level_change", () => {
		const entries: Record<string, Entry> = {
			tlc: {
				kind: "thinking_level_change",
				id: "tlc",
				parentId: null,
				timestamp: "t0",
				thinkingLevel: "high",
				ord: 0,
			},
			user: messageEntry("user", "tlc", 1),
		};
		const sel = nextSelectionOf({ document: documentOf(entries, "user"), draft: IDLE, pick: null, models: MODELS });
		expect(sel.carryLevel).toBe("high");
		expect(sel.level).toBe("high");
	});
});

describe("nextSelection — edit", () => {
	it("inherits from the fork point, not the live leaf", () => {
		// root → mcA → edited user message, with the live leaf continuing to a
		// later model_change: an edit of the user message forks at its parent,
		// so it inherits mcA's model, not the leaf's.
		const entries: Record<string, Entry> = {
			mcA: {
				kind: "model_change",
				id: "mcA",
				parentId: null,
				timestamp: "t0",
				provider: "faux",
				modelId: "faux-1",
				ord: 0,
			},
			edited: messageEntry("edited", "mcA", 1),
			mcB: {
				kind: "model_change",
				id: "mcB",
				parentId: "edited",
				timestamp: "t2",
				provider: "faux",
				modelId: "faux-2",
				ord: 2,
			},
			leaf: messageEntry("leaf", "mcB", 3),
		};
		const draft: ComposerDraft = { kind: "edit", entryId: "edited", index: 0, text: "hi", initialText: "hi" };
		const sel = nextSelectionOf({ document: documentOf(entries, "leaf"), draft, pick: null, models: MODELS });
		expect(sel.carryModel).toEqual({ provider: "faux", modelId: "faux-1" });
	});
});

describe("nextSelection — pick precedence", () => {
	it("the pick wins over inheritance and is carried", () => {
		const entries: Record<string, Entry> = {
			mc: {
				kind: "model_change",
				id: "mc",
				parentId: null,
				timestamp: "t0",
				provider: "faux",
				modelId: "faux-2",
				ord: 0,
			},
			user: messageEntry("user", "mc", 1),
		};
		const pick: SelectionPick = { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "low" };
		const sel = nextSelectionOf({ document: documentOf(entries, "user"), draft: IDLE, pick, models: MODELS });
		expect(sel.model).toEqual({ provider: "faux", modelId: "faux-1" });
		expect(sel.carryModel).toEqual({ provider: "faux", modelId: "faux-1" });
		expect(sel.carryLevel).toBe("low");
	});

	it("a level-only pick carries the level while the model inherits", () => {
		const entries: Record<string, Entry> = {
			mc: {
				kind: "model_change",
				id: "mc",
				parentId: null,
				timestamp: "t0",
				provider: "faux",
				modelId: "faux-2",
				ord: 0,
			},
			user: messageEntry("user", "mc", 1),
		};
		const pick: SelectionPick = { model: null, thinkingLevel: "low" };
		const sel = nextSelectionOf({ document: documentOf(entries, "user"), draft: IDLE, pick, models: MODELS });
		expect(sel.carryModel).toEqual({ provider: "faux", modelId: "faux-2" });
		// The level applies to the inherited model, so the clamp decides: faux-2
		// has no "low".
		expect(sel.carryLevel).toBe("medium");
	});

	it("clamps the displayed level to the display model's supported levels", () => {
		const pick: SelectionPick = { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "low" };
		const sel = nextSelectionOf({ document: documentOf({}, null), draft: IDLE, pick, models: MODELS });
		// faux-2 supports off/medium/high: low clamps up to medium — and the
		// carry takes the clamped value, so the wire never names a level the
		// picker is not already showing.
		expect(sel.level).toBe("medium");
		expect(sel.carryLevel).toBe("medium");
	});

	it("keeps an explicit pick across a fork (a pick is not a fork-point default)", () => {
		// Picking is an override; inheriting is the default. A pick made before a
		// rewind therefore still rides the next send, even though the fork point
		// records a different model.
		const entries: Record<string, Entry> = {
			mcA: {
				kind: "model_change",
				id: "mcA",
				parentId: null,
				timestamp: "t0",
				provider: "faux",
				modelId: "faux-1",
				ord: 0,
			},
			edited: messageEntry("edited", "mcA", 1),
		};
		const draft: ComposerDraft = { kind: "edit", entryId: "edited", index: 0, text: "hi", initialText: "hi" };
		const pick: SelectionPick = { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: null };
		const sel = nextSelectionOf({ document: documentOf(entries, "edited"), draft, pick, models: MODELS });
		expect(sel.model).toEqual({ provider: "faux", modelId: "faux-2" });
		expect(sel.carryModel).toEqual({ provider: "faux", modelId: "faux-2" });
	});
});

describe("nextSelection — a busy session carries nothing", () => {
	// The worker applies a carry only while idle, so a steer must not spend the
	// selection: the turn in flight keeps its model and the pick stays for the
	// next idle send. The display keeps showing what the picker holds.
	const streaming = (entries: Record<string, Entry>, leafId: string | null): Document => {
		const doc = documentOf(entries, leafId);
		return { ...doc, status: { ...doc.status, isStreaming: true } };
	};

	it("drops both carries while a turn streams", () => {
		const entries: Record<string, Entry> = {
			mc: {
				kind: "model_change",
				id: "mc",
				parentId: null,
				timestamp: "t0",
				provider: "faux",
				modelId: "faux-2",
				ord: 0,
			},
			user: messageEntry("user", "mc", 1),
		};
		const pick: SelectionPick = { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "high" };
		const sel = nextSelectionOf({ document: streaming(entries, "user"), draft: IDLE, pick, models: MODELS });
		expect(sel.carryModel).toBeUndefined();
		expect(sel.carryLevel).toBeUndefined();
		// The display is unaffected: the pick is still what the next idle send
		// will carry.
		expect(sel.model).toEqual({ provider: "faux", modelId: "faux-1" });
		expect(sel.level).toBe("high");
	});

	it("drops an inherited carry while compacting too", () => {
		const doc = documentOf({}, null);
		const compacting: Document = { ...doc, status: { ...doc.status, isCompacting: true } };
		const sel = nextSelectionOf({ document: compacting, draft: IDLE, pick: null, models: MODELS });
		expect(sel.carryModel).toBeUndefined();
		expect(sel.carryLevel).toBeUndefined();
	});
});
