// ============================================================================
// Composer draft — regression tests for the durable-draft model: the store
// actions (beginEdit, setDraftText, blurDraft, clearDraft) that replaced the
// old split between local Composer state and `editingEntryId`. The blur
// salvage/discard rule is the heart of the litmus tests:
//   - modified edit  → salvage as compose draft (keep text)
//   - unmodified edit → discard to idle (empty bar)
//   - compose empty   → discard to idle
//   - compose content → keep
//   - streaming/steers keep the bar up regardless
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Document } from "../../src/core/types.ts";
import { MAX_IMAGES_PER_MESSAGE } from "../../src/core/types.ts";
import { createClientStore } from "../../web/src/infra/store.ts";

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

/** Apply a status-only document (entries stay empty — tests don't need them). */
function withStatus(overrides: Partial<Document["status"]>): Document {
	return { ...emptyDoc(), status: { ...emptyDoc().status, ...overrides } };
}

// ---------------------------------------------------------------------------
// setDraftText — promotion + update
// ---------------------------------------------------------------------------

describe("composer draft: setDraftText", () => {
	it("promotes idle → compose on first keystroke", () => {
		const store = createClientStore();
		expect(store.getState().draft).toEqual({ kind: "idle" });

		store.getState().setDraftText("h");
		expect(store.getState().draft).toEqual({ kind: "compose", text: "h" });
	});

	it("updates compose text without changing kind", () => {
		const store = createClientStore();
		store.getState().setDraftText("hello");
		store.getState().setDraftText("hello world");
		expect(store.getState().draft).toEqual({ kind: "compose", text: "hello world" });
	});

	it("updates edit text and preserves initialText", () => {
		const store = createClientStore();
		store.getState().beginEdit("e1", 2, "original");
		store.getState().setDraftText("modified");
		const draft = store.getState().draft;
		expect(draft.kind).toBe("edit");
		if (draft.kind === "edit") {
			expect(draft.text).toBe("modified");
			expect(draft.initialText).toBe("original");
			expect(draft.entryId).toBe("e1");
			expect(draft.index).toBe(2);
		}
	});
});

// ---------------------------------------------------------------------------
// Image attachments
// ---------------------------------------------------------------------------

describe("composer draft: image attachments", () => {
	const img = { type: "image" as const, data: "aGk=", mimeType: "image/png" };
	const img2 = { type: "image" as const, data: "aGkx", mimeType: "image/jpeg" };

	it("addDraftImages promotes idle → compose with images and expands", () => {
		const store = createClientStore();
		store.getState().addDraftImages([img]);
		const draft = store.getState().draft;
		expect(draft.kind).toBe("compose");
		if (draft.kind === "compose") {
			expect(draft.text).toBe("");
			expect(draft.images).toEqual([img]);
		}
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("addDraftImages appends to an existing compose draft", () => {
		const store = createClientStore();
		store.getState().setDraftText("look at this");
		store.getState().addDraftImages([img]);
		const draft = store.getState().draft;
		if (draft.kind === "compose") {
			expect(draft.text).toBe("look at this");
			expect(draft.images).toEqual([img]);
		}
		store.getState().addDraftImages([img2]);
		const afterAppend = store.getState().draft;
		if (afterAppend.kind === "compose") {
			expect(afterAppend.images).toEqual([img, img2]);
		}
	});

	it("setDraftText preserves attached images (regression: first keystroke wiped them)", () => {
		const store = createClientStore();
		store.getState().addDraftImages([img]);
		store.getState().setDraftText("what is this?");
		const draft = store.getState().draft;
		expect(draft.kind).toBe("compose");
		if (draft.kind === "compose") {
			expect(draft.text).toBe("what is this?");
			expect(draft.images).toEqual([img]);
		}
	});

	it("removeDraftImage removes by index", () => {
		const store = createClientStore();
		store.getState().addDraftImages([img, img2]);
		store.getState().removeDraftImage(0);
		const afterRemove = store.getState().draft;
		if (afterRemove.kind === "compose") {
			expect(afterRemove.images).toEqual([img2]);
		}
	});

	it("addDraftImages is a no-op on edit drafts (forks re-send entry images)", () => {
		const store = createClientStore();
		store.getState().beginEdit("e1", 0, "original");
		store.getState().addDraftImages([img]);
		expect(store.getState().draft.kind).toBe("edit");
	});

	it("addDraftImages clamps to the wire limit across rapid async adds", () => {
		const store = createClientStore();
		store.getState().addDraftImages([img]);
		store.getState().addDraftImages(
			Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, i) => ({
				type: "image" as const,
				data: `aGk${i}`,
				mimeType: "image/png",
			})),
		);
		const draft = store.getState().draft;
		if (draft.kind === "compose") expect(draft.images).toHaveLength(MAX_IMAGES_PER_MESSAGE);
	});

	it("blurDraft keeps an image-only compose draft", () => {
		const store = createClientStore();
		store.getState().addDraftImages([img]);
		store.getState().blurDraft();
		expect(store.getState().draft.kind).toBe("compose");
	});
});

// ---------------------------------------------------------------------------
// beginEdit / clearDraft
// ---------------------------------------------------------------------------

describe("composer draft: beginEdit / clearDraft", () => {
	it("beginEdit sets an edit draft pre-filled with the original and expands", () => {
		const store = createClientStore();
		store.getState().beginEdit("e1", 3, "hello");
		const draft = store.getState().draft;
		expect(draft).toEqual({
			kind: "edit",
			entryId: "e1",
			index: 3,
			text: "hello",
			initialText: "hello",
		});
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("clearDraft returns to idle from any draft kind", () => {
		const store = createClientStore();
		store.getState().beginEdit("e1", 0, "x");
		store.getState().clearDraft();
		expect(store.getState().draft).toEqual({ kind: "idle" });

		store.getState().setDraftText("compose text");
		store.getState().clearDraft();
		expect(store.getState().draft).toEqual({ kind: "idle" });
	});
});

// ---------------------------------------------------------------------------
// blurDraft — the salvage/discard rule (litmus tests)
// ---------------------------------------------------------------------------

describe("composer draft: blurDraft — edit survives blur, compose salvages", () => {
	it("litmus 1: edit + modified → survives blur (stays edit, target intact)", () => {
		const store = createClientStore();
		store.getState().setComposerExpanded(true);
		store.getState().beginEdit("e1", 1, "original");
		store.getState().setDraftText("original + edits");

		store.getState().blurDraft();

		// Edit is a sticky mode decoupled from focus: window-switch/copy/click-away
		// blur must NOT drop the edit target, or a later send silently forks
		// from the leaf (append) instead of the edited message's parent.
		expect(store.getState().draft).toEqual({
			kind: "edit",
			entryId: "e1",
			index: 1,
			text: "original + edits",
			initialText: "original",
		});
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("litmus 2: edit + unmodified → survives blur (stays edit, bar stays up)", () => {
		const store = createClientStore();
		store.getState().setComposerExpanded(true);
		// beginEdit pre-fills text == initialText; no setDraftText ⇒ unmodified.
		store.getState().beginEdit("e1", 1, "original");

		store.getState().blurDraft();

		// Unmodified edits also survive — explicit Cancel (Escape / the
		// composer Cancel button) is the only exit, not focus loss.
		expect(store.getState().draft).toEqual({
			kind: "edit",
			entryId: "e1",
			index: 1,
			text: "original",
			initialText: "original",
		});
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("edit + modified back to original → survives blur (stays edit)", () => {
		// text === initialText is still an edit draft; blur no longer discards.
		const store = createClientStore();
		store.getState().setComposerExpanded(true);
		store.getState().beginEdit("e1", 1, "original");
		store.getState().setDraftText("original");

		store.getState().blurDraft();

		expect(store.getState().draft).toEqual({
			kind: "edit",
			entryId: "e1",
			index: 1,
			text: "original",
			initialText: "original",
		});
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("compose + empty → discard to idle, collapse", () => {
		const store = createClientStore();
		store.getState().setComposerExpanded(true);
		store.getState().setDraftText("  "); // whitespace-only

		store.getState().blurDraft();

		expect(store.getState().draft).toEqual({ kind: "idle" });
		expect(store.getState().composerExpanded).toBe(false);
	});

	it("compose + content → keep draft, keep expanded", () => {
		const store = createClientStore();
		store.getState().setComposerExpanded(true);
		store.getState().setDraftText("real text");

		store.getState().blurDraft();

		expect(store.getState().draft).toEqual({ kind: "compose", text: "real text" });
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("idle → collapse (no draft to lose)", () => {
		const store = createClientStore();
		store.getState().setComposerExpanded(true);

		store.getState().blurDraft();

		expect(store.getState().draft).toEqual({ kind: "idle" });
		expect(store.getState().composerExpanded).toBe(false);
	});

	// ── streaming / steer guards keep the bar up ──────────────────────────

	it("streaming: edit blur → survives (stays edit, bar stays up)", () => {
		const store = createClientStore();
		store.getState().applyReplace(withStatus({ isStreaming: true }));
		store.getState().setComposerExpanded(true);
		store.getState().beginEdit("e1", 1, "original");
		// (Editing during streaming is normally blocked upstream; blurDraft
		// is a no-op for edit regardless of streaming.)

		store.getState().blurDraft();

		expect(store.getState().draft).toEqual({
			kind: "edit",
			entryId: "e1",
			index: 1,
			text: "original",
			initialText: "original",
		});
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("streaming: compose-empty blur → discard draft but keep bar up", () => {
		const store = createClientStore();
		store.getState().applyReplace(withStatus({ isStreaming: true }));
		store.getState().setComposerExpanded(true);
		store.getState().setDraftText("");

		store.getState().blurDraft();

		expect(store.getState().draft).toEqual({ kind: "idle" });
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("pending steers: edit blur → survives (stays edit, bar stays up)", () => {
		const store = createClientStore();
		store.getState().applyReplace(withStatus({ pendingSteer: ["queued"] }));
		store.getState().setComposerExpanded(true);
		store.getState().beginEdit("e1", 1, "original");

		store.getState().blurDraft();

		expect(store.getState().draft).toEqual({
			kind: "edit",
			entryId: "e1",
			index: 1,
			text: "original",
			initialText: "original",
		});
		expect(store.getState().composerExpanded).toBe(true);
	});

	it("streaming does not suppress edit survival", () => {
		const store = createClientStore();
		store.getState().applyReplace(withStatus({ isStreaming: true }));
		store.getState().setComposerExpanded(true);
		store.getState().beginEdit("e1", 1, "original");
		store.getState().setDraftText("modified");

		store.getState().blurDraft();

		// Edit survives blur regardless of streaming; the streaming guard only
		// keeps the bar up, it doesn't change the sticky-edit decision.
		expect(store.getState().draft).toEqual({
			kind: "edit",
			entryId: "e1",
			index: 1,
			text: "modified",
			initialText: "original",
		});
		expect(store.getState().composerExpanded).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// clearInstance resets the draft (no orphaned edit state across instances)
// ---------------------------------------------------------------------------

describe("composer draft: clearInstance", () => {
	it("resets an in-flight edit draft to idle", () => {
		const store = createClientStore();
		store.getState().beginEdit("e1", 1, "editing");
		expect(store.getState().draft.kind).toBe("edit");

		store.getState().clearInstance();

		expect(store.getState().draft).toEqual({ kind: "idle" });
		expect(store.getState().composerExpanded).toBe(false);
	});

	it("resets a compose draft to idle", () => {
		const store = createClientStore();
		store.getState().setDraftText("unsent");
		store.getState().setComposerExpanded(true);

		store.getState().clearInstance();

		expect(store.getState().draft).toEqual({ kind: "idle" });
	});
});
