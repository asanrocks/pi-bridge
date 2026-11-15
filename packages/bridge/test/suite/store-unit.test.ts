// ============================================================================
// Store unit tests — Zustand store selectors, action purity, expand-key migration.
// Tests drive set({ document: syntheticDoc }) directly — no mirror needed.
// ============================================================================

import { describe, expect, it } from "vitest";
import type { DaemonInfo, Document, ImageContent, ProjectInfo } from "../../src/core/types.ts";
import { createClientStore, selectDraftImages } from "../../web/src/infra/state/store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One daemon aggregate frame (a `getDaemonInfo` baseline or a
 * `daemon_info_changed` push): the store applies the whole snapshot and orders
 * two that crossed by `revision`. */
function daemonInfo(revision: number, projects: ProjectInfo[] = []): DaemonInfo {
	return {
		revision,
		build: { version: "1.5.0", commit: "test", date: "2026-01-01" },
		projects,
		models: [],
		pinnedModels: [],
		visibleModels: [],
		thinkingLevels: [],
	};
}

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
		entries: {},
	};
}

function docWithStatus(overrides: Partial<Document["status"]>): Document {
	return {
		status: { ...emptyDoc().status, ...overrides },
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
		expect(state.currentProjectId).toBeNull();
		expect(state.currentStem).toBeNull();
		expect(state.projects).toEqual([]);
		expect(state.queue).toEqual([]);
		expect(state.expandedActionGroups).toEqual(new Set());
		expect(state.expandedActions).toEqual(new Set());
		expect(state.frozenActionGroups).toEqual(new Set());
		expect(state.frozenActions).toEqual(new Set());
		expect(state.loadingPaths).toEqual(new Set());
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

	it("applyDaemonInfo seeds the registries; the queue snapshot stays separate", () => {
		const store = createClientStore();

		const projects = [
			{ id: "a", cwd: "/a", defaultModel: null, defaultThinkingLevel: null },
			{ id: "b", cwd: "/b", defaultModel: null, defaultThinkingLevel: null },
		];
		store.getState().applyDaemonInfo(daemonInfo(1, projects));
		expect(store.getState().projects).toEqual(projects);

		const queue = [
			{
				projectId: "a",
				sessionId: "s1",
				stem: "2024-01-01_s1",
				location: "inbox" as const,
				timestamp: new Date(0).toISOString(),
			},
		];
		store.getState().applyQueueSnapshot(queue, 1);
		expect(store.getState().queue).toEqual(queue);
	});

	it("a daemon-info frame older than the held one is dropped", () => {
		// The Daemon serializes its aggregate reads, and a `getDaemonInfo` reply can
		// land after a push that describes a later read: the revision decides.
		const store = createClientStore();
		store.getState().applyDaemonInfo(daemonInfo(2, []));
		store
			.getState()
			.applyDaemonInfo(
				daemonInfo(1, [{ id: "stale", cwd: "/stale", defaultModel: null, defaultThinkingLevel: null }]),
			);

		expect(store.getState().projects).toEqual([]);
		expect(store.getState().daemonInfoRevision).toBe(2);
	});

	it("a removed Project drops its cached pages and queue rows", () => {
		const store = createClientStore();
		const a = { id: "a", cwd: "/a", defaultModel: null, defaultThinkingLevel: null };
		const b = { id: "b", cwd: "/b", defaultModel: null, defaultThinkingLevel: null };
		store.getState().applyDaemonInfo(daemonInfo(1, [a, b]));
		store.getState().setSessionPage("a", [], false, null);
		store.getState().setSessionPage("b", [], false, null);
		store.getState().applyQueueSnapshot(
			[
				{ projectId: "a", sessionId: "s1", stem: "one", location: "inbox", timestamp: new Date(0).toISOString() },
				{ projectId: "b", sessionId: "s2", stem: "two", location: "inbox", timestamp: new Date(0).toISOString() },
			],
			1,
		);

		store.getState().applyDaemonInfo(daemonInfo(2, [a]));

		// No Worker serves `b` any more, so neither its page nor its rows can be
		// valid; `a` keeps both.
		expect(Object.keys(store.getState().sessionPages)).toEqual(["a"]);
		expect(store.getState().queue.map((row) => row.projectId)).toEqual(["a"]);
	});

	it("clearCurrentSession resets to initial state but keeps the registries", () => {
		const store = createClientStore();

		store
			.getState()
			.applyDaemonInfo(daemonInfo(1, [{ id: "a", cwd: "/a", defaultModel: null, defaultThinkingLevel: null }]));
		store.getState().setCurrentSession("a", "2024-01-01_s1");
		store.getState().toggleActionGroup("e1:0");

		store.getState().clearCurrentSession();

		const state = store.getState();
		expect(state.currentProjectId).toBeNull();
		expect(state.projects).toEqual([{ id: "a", cwd: "/a", defaultModel: null, defaultThinkingLevel: null }]);
		expect(state.expandedActionGroups).toEqual(new Set());
		expect(state.loadingPaths).toEqual(new Set());
	});

	it("applyDaemonInfo carries the catalogue and the pinned scope", () => {
		const store = createClientStore();
		const models = [{ provider: "faux", id: "faux-1", name: "Faux 1", reasoning: false }];
		const pinnedModels = [{ provider: "faux", id: "faux-1", name: "Faux 1" }];
		const visibleModels = ["faux/faux-1"];
		store.getState().applyDaemonInfo({
			revision: 1,
			build: { version: "1.5.0", commit: "test", date: "2026-01-01" },
			projects: [],
			models,
			pinnedModels,
			visibleModels,
			thinkingLevels: ["off", "low", "high"],
		});
		expect(store.getState().models).toEqual(models);
		expect(store.getState().thinkingLevels).toEqual(["off", "low", "high"]);
		expect(store.getState().pinnedModels).toEqual(pinnedModels);
		expect(store.getState().visibleModels).toEqual(visibleModels);
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

	it("toggleActionGroup resets the group's actions to collapsed (header is master toggle)", () => {
		const store = createClientStore();
		const actionKeys = ["e1:b0", "e1:b1", "e1:b2"];

		// Cards expanded independently (user opened two of three).
		store.getState().toggleAction("e1:b0");
		store.getState().toggleAction("e1:b1");
		expect(store.getState().expandedActions).toEqual(new Set(["e1:b0", "e1:b1"]));
		expect(store.getState().frozenActions).toEqual(new Set(["e1:b0", "e1:b1"]));

		// Open the group header — all actions reset to collapsed, so reopening
		// shows descendants collapsed rather than the pre-collapse state.
		store.getState().toggleActionGroup("e1:0", actionKeys);
		expect(store.getState().expandedActions).toEqual(new Set());
		expect(store.getState().frozenActions).toEqual(new Set());
		expect(store.getState().expandedActionGroups).toEqual(new Set(["e1:0"]));

		// Re-expand an action, then collapse the group — same reset on collapse.
		store.getState().toggleAction("e1:b2");
		store.getState().toggleActionGroup("e1:0", actionKeys);
		expect(store.getState().expandedActions).toEqual(new Set());
		expect(store.getState().frozenActions).toEqual(new Set());
		expect(store.getState().expandedActionGroups).toEqual(new Set());
	});

	it("toggleActionGroup without actionKeys leaves action state untouched (legacy)", () => {
		const store = createClientStore();
		store.getState().toggleAction("e1:b0");
		store.getState().toggleActionGroup("e1:0");
		expect(store.getState().expandedActions).toEqual(new Set(["e1:b0"]));
	});

	it("toggleActionGroup opening a single-action group auto-expands the lone action", () => {
		const store = createClientStore();

		// Open a one-action group — the lone action's details auto-expand (a collapsed group
		// with a single element is a wasted click).
		store.getState().toggleActionGroup("e1:0", ["e1:b0"]);
		expect(store.getState().expandedActionGroups).toEqual(new Set(["e1:0"]));
		expect(store.getState().expandedActions).toEqual(new Set(["e1:b0"]));

		// Collapse the group — the lone action resets to collapsed with the rest.
		store.getState().toggleActionGroup("e1:0", ["e1:b0"]);
		expect(store.getState().expandedActions).toEqual(new Set());
	});

	it("toggleAction adds to expanded and frozen sets", () => {
		const store = createClientStore();

		store.getState().toggleAction("e1:b0");
		expect(store.getState().expandedActions).toEqual(new Set(["e1:b0"]));
		expect(store.getState().frozenActions).toEqual(new Set(["e1:b0"]));

		store.getState().toggleAction("e1:b0");
		expect(store.getState().expandedActions).toEqual(new Set());
		expect(store.getState().frozenActions).toEqual(new Set(["e1:b0"]));
	});

	it("setLoadingPaths replaces loading set", () => {
		const store = createClientStore();

		store.getState().setLoadingPaths(new Set(["/entries/e1/content/0/text"]));
		expect(store.getState().loadingPaths).toEqual(new Set(["/entries/e1/content/0/text"]));

		store.getState().setLoadingPaths(new Set());
		expect(store.getState().loadingPaths).toEqual(new Set());
	});
});

// ---------------------------------------------------------------------------
// selectDraftImages — snapshot stability. A useStore selector that returns a
// fresh reference per call makes useSyncExternalStore treat every render as
// a change ("getSnapshot should be cached" → max update depth loop).
// Regression: useImageAttachments inlined `?? []` in its selector.
// ---------------------------------------------------------------------------

describe("selectDraftImages", () => {
	it("returns a reference-stable empty list for imageless drafts", () => {
		const store = createClientStore();
		store.getState().setDraftText("hello"); // idle → compose, no images
		const state = store.getState();
		expect(Object.is(selectDraftImages(state), selectDraftImages(state))).toBe(true);
		expect(selectDraftImages(state)).toEqual([]);
		// idle and edit drafts share the same stable empty list
		store.getState().clearDraft();
		expect(Object.is(selectDraftImages(store.getState()), selectDraftImages(state))).toBe(true);
	});

	it("returns the draft's own images array (identity follows the draft)", () => {
		const store = createClientStore();
		const images = [{ type: "image", mimeType: "image/png", data: "aGk=" }] satisfies ImageContent[];
		store.getState().addDraftImages(images);
		const selected = selectDraftImages(store.getState());
		expect(selected).toBe(images);
	});
});
