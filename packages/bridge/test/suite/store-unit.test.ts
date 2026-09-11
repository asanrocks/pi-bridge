// ============================================================================
// Store unit tests — Zustand store selectors, action purity, expand-key migration.
// Tests drive set({ document: syntheticDoc }) directly — no mirror needed.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Document } from "../../src/core/types.ts";
import { createClientStore, type ExpandKeySets, migrateExpandKeys } from "../../web/src/infra/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyDoc(): Document {
	return {
		status: {
			leafId: null,
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: {
				tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
				cost: { total: 0 },
				messages: 0,
			},
			contextUsage: null,
			pendingSteer: [],
		},
		scopedModels: [],
		entries: {},
	};
}

function docWithStatus(overrides: Partial<Document["status"]>): Document {
	return {
		status: { ...emptyDoc().status, ...overrides },
		scopedModels: [],
		entries: {},
	};
}

// ---------------------------------------------------------------------------
// createClientStore
// ---------------------------------------------------------------------------

describe("createClientStore", () => {
	it("initial state matches expectations", () => {
		const store = createClientStore();
		const state = store.getState();

		expect(state.document).toEqual(emptyDoc());
		expect(state.connection).toEqual({ kind: "connecting" });
		expect(state.attachedInstanceId).toBeNull();
		expect(state.instances).toEqual([]);
		expect(state.expandedActionGroups).toEqual(new Set());
		expect(state.expandedSteps).toEqual(new Set());
		expect(state.frozenActionGroups).toEqual(new Set());
		expect(state.frozenSteps).toEqual(new Set());
		expect(state.loadingPaths).toEqual(new Set());
		expect(state.sessions).toEqual([]);
		expect(state.cwdAllowlist).toEqual([]);
		expect(state.models).toEqual([]);
		expect(state.thinkingLevels).toEqual([]);
		expect(state.cardWrap).toBe(true);
		expect(state.cardMarkdown).toBe(true);
	});

	it("card content-view toggles flip", () => {
		const store = createClientStore();
		store.getState().toggleCardWrap();
		expect(store.getState().cardWrap).toBe(false);
		store.getState().toggleCardMarkdown();
		expect(store.getState().cardMarkdown).toBe(false);
		store.getState().toggleCardWrap();
		store.getState().toggleCardMarkdown();
		expect(store.getState().cardWrap).toBe(true);
		expect(store.getState().cardMarkdown).toBe(true);
	});

	it("setConnectionState updates connection state", () => {
		const store = createClientStore();
		store.getState().setConnectionState({ kind: "connected" });
		expect(store.getState().connection).toEqual({ kind: "connected" });

		store.getState().setConnectionState({ kind: "reconnecting", attempt: 1 });
		expect(store.getState().connection).toEqual({ kind: "reconnecting", attempt: 1 });

		store.getState().setConnectionState({ kind: "unreachable", attempt: 5 });
		expect(store.getState().connection).toEqual({ kind: "unreachable", attempt: 5 });

		store.getState().setConnectionState({ kind: "init_failed", error: "boom" });
		expect(store.getState().connection).toEqual({ kind: "init_failed", error: "boom" });
	});

	it("syncInstances updates instances and attachedInstanceId", () => {
		const store = createClientStore();

		const instances = [
			{ instanceId: "m1", sessionId: "s1", cwd: "/a", name: "Instance A", isStreaming: false },
			{ instanceId: "m2", sessionId: "s2", cwd: "/b", name: "Instance B", isStreaming: true },
		];
		store.getState().syncInstances({ instances });
		expect(store.getState().instances).toEqual(instances);

		// Set attachedInstanceId independently
		store.getState().syncInstances({ attachedInstanceId: "m1" });
		expect(store.getState().attachedInstanceId).toBe("m1");

		// Null it
		store.getState().syncInstances({ attachedInstanceId: null });
		expect(store.getState().attachedInstanceId).toBeNull();
	});

	it("clearInstance resets to initial state", () => {
		const store = createClientStore();

		// Set up some state
		store.getState().syncInstances({
			attachedInstanceId: "m1",
			instances: [{ instanceId: "m1", sessionId: "s1", cwd: "/a", name: "P", isStreaming: false }],
		});
		store.getState().toggleActionGroup("e1:0");

		store.getState().clearInstance();

		const state = store.getState();
		expect(state.attachedInstanceId).toBeNull();
		expect(state.expandedActionGroups).toEqual(new Set());
		expect(state.loadingPaths).toEqual(new Set());
	});

	it("setModels updates models and thinking levels", () => {
		const store = createClientStore();
		const models = [{ provider: "faux", id: "faux-1", name: "Faux 1", reasoning: false }];
		store.getState().setModels(models, ["off", "low", "high"]);
		expect(store.getState().models).toEqual(models);
		expect(store.getState().thinkingLevels).toEqual(["off", "low", "high"]);
	});

	it("applyReplace replaces document root", () => {
		const store = createClientStore();
		const doc = docWithStatus({ name: "test-session" });

		store.getState().applyReplace(doc);
		expect(store.getState().document).toBe(doc); // Same reference (root-flip)
		expect(store.getState().document.status.name).toBe("test-session");
	});

	it("applyReplace changes root reference", () => {
		const store = createClientStore();
		const doc1 = docWithStatus({ name: "first" });
		const doc2 = docWithStatus({ name: "second" });

		store.getState().applyReplace(doc1);
		expect(store.getState().document).toBe(doc1);

		store.getState().applyReplace(doc2);
		expect(store.getState().document).toBe(doc2);
		expect(store.getState().document).not.toBe(doc1);
	});

	it("toggleActionGroup adds to expanded and frozen sets", () => {
		const store = createClientStore();

		store.getState().toggleActionGroup("e1:0");
		expect(store.getState().expandedActionGroups).toEqual(new Set(["e1:0"]));
		expect(store.getState().frozenActionGroups).toEqual(new Set(["e1:0"]));

		// Same key toggles off expanded but stays frozen (permanent)
		store.getState().toggleActionGroup("e1:0");
		expect(store.getState().expandedActionGroups).toEqual(new Set());
		expect(store.getState().frozenActionGroups).toEqual(new Set(["e1:0"]));
	});

	it("toggleActionGroup resets the group's steps to folded (header is master toggle)", () => {
		const store = createClientStore();
		const stepKeys = ["e1:b0", "e1:b1", "e1:b2"];

		// Cards expanded independently (user opened two of three).
		store.getState().toggleStep("e1:b0");
		store.getState().toggleStep("e1:b1");
		expect(store.getState().expandedSteps).toEqual(new Set(["e1:b0", "e1:b1"]));
		expect(store.getState().frozenSteps).toEqual(new Set(["e1:b0", "e1:b1"]));

		// Open the group header — all steps reset to folded, so reopening
		// shows descendants folded rather than the pre-fold state.
		store.getState().toggleActionGroup("e1:0", stepKeys);
		expect(store.getState().expandedSteps).toEqual(new Set());
		expect(store.getState().frozenSteps).toEqual(new Set());
		expect(store.getState().expandedActionGroups).toEqual(new Set(["e1:0"]));

		// Re-expand a step, then fold the group — same reset on fold.
		store.getState().toggleStep("e1:b2");
		store.getState().toggleActionGroup("e1:0", stepKeys);
		expect(store.getState().expandedSteps).toEqual(new Set());
		expect(store.getState().frozenSteps).toEqual(new Set());
		expect(store.getState().expandedActionGroups).toEqual(new Set());
	});

	it("toggleActionGroup without stepKeys leaves step state untouched (legacy)", () => {
		const store = createClientStore();
		store.getState().toggleStep("e1:b0");
		store.getState().toggleActionGroup("e1:0");
		expect(store.getState().expandedSteps).toEqual(new Set(["e1:b0"]));
	});

	it("toggleActionGroup opening a single-step group auto-expands the lone step", () => {
		const store = createClientStore();

		// Open a one-step group — the lone step's details auto-expand (a folded group
		// with a single element is a wasted click).
		store.getState().toggleActionGroup("e1:0", ["e1:b0"]);
		expect(store.getState().expandedActionGroups).toEqual(new Set(["e1:0"]));
		expect(store.getState().expandedSteps).toEqual(new Set(["e1:b0"]));

		// Fold the group — the lone step resets to folded with the rest.
		store.getState().toggleActionGroup("e1:0", ["e1:b0"]);
		expect(store.getState().expandedSteps).toEqual(new Set());
	});

	it("toggleStep adds to expanded and frozen sets", () => {
		const store = createClientStore();

		store.getState().toggleStep("e1:b0");
		expect(store.getState().expandedSteps).toEqual(new Set(["e1:b0"]));
		expect(store.getState().frozenSteps).toEqual(new Set(["e1:b0"]));

		store.getState().toggleStep("e1:b0");
		expect(store.getState().expandedSteps).toEqual(new Set());
		expect(store.getState().frozenSteps).toEqual(new Set(["e1:b0"]));
	});

	it("setLoadingPaths replaces loading set", () => {
		const store = createClientStore();

		store.getState().setLoadingPaths(new Set(["/entries/e1/content/0/text"]));
		expect(store.getState().loadingPaths).toEqual(new Set(["/entries/e1/content/0/text"]));

		store.getState().setLoadingPaths(new Set());
		expect(store.getState().loadingPaths).toEqual(new Set());
	});

	it("migrateExpandKeys rewrites keys on move", () => {
		const store = createClientStore();

		// Pre-populate expand state with pending keys
		store.getState().toggleActionGroup("pending:message:0");
		store.getState().toggleActionGroup("pending:message:3");
		store.getState().toggleStep("pending:message:b0");
		store.getState().setLoadingPaths(new Set(["/entries/pending:message/content/0/text"]));

		// Also add a key that doesn't match (should be left alone)
		store.getState().toggleActionGroup("other-entry:0");

		// Migrate pending:message → durable-id
		store.getState().migrateExpandKeys("pending:message", "msg_001");

		const state = store.getState();
		expect(state.expandedActionGroups).toEqual(new Set(["msg_001:0", "msg_001:3", "other-entry:0"]));
		expect(state.expandedSteps).toEqual(new Set(["msg_001:b0"]));
		expect(state.frozenActionGroups).toEqual(new Set(["msg_001:0", "msg_001:3", "other-entry:0"]));
		expect(state.frozenSteps).toEqual(new Set(["msg_001:b0"]));
		expect(state.loadingPaths).toEqual(new Set(["/entries/msg_001/content/0/text"]));
	});

	it("focusedTurnId tracks a provisionally focused turn across the seal (move)", () => {
		const store = createClientStore();
		store.getState().setFocusedTurnId("pending:message");
		store.getState().migrateFocusedTurnId("pending:message", "msg_001");
		expect(store.getState().focusedTurnId).toBe("msg_001");
	});

	it("focusedTurnId tracks a mid-entry sub-turn (turnKey with :b suffix) across the seal", () => {
		// Turn separation: a split entry's trailing-tool turn is keyed
		// entryId:b<index> — the rewrite must preserve the block suffix.
		const store = createClientStore();
		store.getState().setFocusedTurnId("pending:message:b1");
		store.getState().migrateFocusedTurnId("pending:message", "msg_001");
		expect(store.getState().focusedTurnId).toBe("msg_001:b1");
	});

	it("focusedTurnId on an unrelated turn is untouched by a move", () => {
		const store = createClientStore();
		store.getState().setFocusedTurnId("msg_000");
		store.getState().migrateFocusedTurnId("pending:message", "msg_001");
		expect(store.getState().focusedTurnId).toBe("msg_000");
	});
});

// ---------------------------------------------------------------------------
// migrateExpandKeys — pure function tests
// ---------------------------------------------------------------------------

describe("migrateExpandKeys (pure)", () => {
	function emptySets(): ExpandKeySets {
		return {
			expandedActionGroups: new Set(),
			expandedSteps: new Set(),
			uncappedDetails: new Set(),
			frozenActionGroups: new Set(),
			frozenSteps: new Set(),
			loadingPaths: new Set(),
		};
	}

	it("rewrites action group keys with entryId prefix", () => {
		const result = migrateExpandKeys(
			{
				...emptySets(),
				expandedActionGroups: new Set(["pending:msg:0", "pending:msg:5", "other:1"]),
			},
			"pending:msg",
			"real-001",
		);
		expect(result.expandedActionGroups).toEqual(new Set(["real-001:0", "real-001:5", "other:1"]));
	});

	it("rewrites action keys with entryId:b prefix", () => {
		const result = migrateExpandKeys(
			{
				...emptySets(),
				expandedSteps: new Set(["pending:msg:b0", "pending:msg:b3"]),
			},
			"pending:msg",
			"real-001",
		);
		expect(result.expandedSteps).toEqual(new Set(["real-001:b0", "real-001:b3"]));
	});

	it("rewrites loading paths with /entries/entryId/ prefix", () => {
		const result = migrateExpandKeys(
			{
				...emptySets(),
				loadingPaths: new Set(["/entries/pending:tool_abc/content/0/text", "/entries/pending:tool_abc/details"]),
			},
			"pending:tool_abc",
			"tool_001",
		);
		expect(result.loadingPaths).toEqual(new Set(["/entries/tool_001/content/0/text", "/entries/tool_001/details"]));
	});

	it("rewrites frozen sets too", () => {
		const result = migrateExpandKeys(
			{
				...emptySets(),
				frozenActionGroups: new Set(["pending:msg:0"]),
				frozenSteps: new Set(["pending:msg:b1"]),
			},
			"pending:msg",
			"real",
		);
		expect(result.frozenActionGroups).toEqual(new Set(["real:0"]));
		expect(result.frozenSteps).toEqual(new Set(["real:b1"]));
	});

	it("does not touch keys that don't match the old prefix", () => {
		const result = migrateExpandKeys(
			{
				...emptySets(),
				expandedActionGroups: new Set(["other:id:0", "pending:other:0"]),
			},
			"pending:msg",
			"real-001",
		);
		expect(result.expandedActionGroups).toEqual(new Set(["other:id:0", "pending:other:0"]));
	});

	it("handles empty input sets", () => {
		const result = migrateExpandKeys(emptySets(), "old", "new");
		expect(result.expandedActionGroups).toEqual(new Set());
		expect(result.expandedSteps).toEqual(new Set());
		expect(result.frozenActionGroups).toEqual(new Set());
		expect(result.frozenSteps).toEqual(new Set());
		expect(result.loadingPaths).toEqual(new Set());
	});
});
