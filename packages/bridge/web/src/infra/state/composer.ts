// ============================================================================
// Composer slice — the draft, the single source of truth for the textarea
// content. Discriminated by kind so the conversation (dimming) and the
// composer (textarea value/placeholder) read one field. It survives composer
// collapse (local React state did not), which is what makes durable drafts
// possible: blur-salvage, offline-tolerant commit, and localStorage
// persistence.
// Browser-safe: no node:* imports, no DOM.
// ============================================================================

import type { StateCreator } from "zustand/vanilla";
import { type ImageContent, MAX_IMAGES_PER_MESSAGE } from "../../../../src/core/types.ts";
import type { ClientStore } from "./store.ts";

export type ComposerDraft =
	| { kind: "idle" }
	| { kind: "compose"; text: string; images?: ImageContent[] }
	| { kind: "edit"; entryId: string; index: number; text: string; initialText: string };

/** Stable empty attachment list — a selector returning a fresh `[]` on every
 * call makes `useStore` (useSyncExternalStore) see the snapshot as changed
 * after each render and loop to the max update depth. */
const NO_IMAGES: ImageContent[] = [];

/** Stable view of the active draft's attachments (empty for idle/edit —
 * edit carries the edited entry's images implicitly). */
export function selectDraftImages(state: { draft: ComposerDraft }): ImageContent[] {
	return state.draft.kind === "compose" ? (state.draft.images ?? NO_IMAGES) : NO_IMAGES;
}

export interface ComposerSlice {
	/** Composer draft — the single source of truth for the textarea content.
	    Discriminated by kind: idle (nothing), compose (new message), edit
	    (forking a past user message). Owned in the store so it survives
	    composer collapse and powers durable-draft behavior (blur salvage,
	    offline-tolerant commit, localStorage persistence). */
	draft: ComposerDraft;
	/** Composer expanded state. Visual only — decoupled from draft: the bar
	    can collapse while a compose draft stays dormant, re-expanding to the
	    saved text. Owned in the store (not local Composer state) so the
	    app-level keybinding layer can drive `/` to expand + focus the
	    textarea without reaching into Composer. */
	composerExpanded: boolean;

	/** Direct draft replacement (restore-from-localStorage, internal). */
	setDraft: (draft: ComposerDraft) => void;
	/** Update the active draft's text; promotes idle → compose on first keystroke. */
	setDraftText: (text: string) => void;
	/** Append prepared image attachments to a compose draft (promotes idle → compose). */
	addDraftImages: (images: ImageContent[]) => void;
	/** Remove one image attachment from the compose draft by index. */
	removeDraftImage: (index: number) => void;
	/** Enter edit mode for a past user message; pre-fills with the original text. */
	beginEdit: (entryId: string, index: number, text: string) => void;
	/** Blur salvage/discard: modified edit → compose draft; unmodified/empty → idle. Collapses the composer unless streaming/steers keep it up. */
	blurDraft: () => void;
	/** Clear the draft to idle (commit success, instance exit, Escape-on-edit). */
	clearDraft: () => void;
	setComposerExpanded: (expanded: boolean) => void;
}

export const createComposerSlice: StateCreator<ClientStore, [], [], ComposerSlice> = (set) => ({
	draft: { kind: "idle" },
	composerExpanded: false,

	setDraft: (draft) => set({ draft }),

	setDraftText: (text) =>
		set((s) => {
			if (s.draft.kind === "idle") return { draft: { kind: "compose", text } };
			// Spread, not rebuild: attachments must survive every keystroke.
			if (s.draft.kind === "compose") return { draft: { ...s.draft, text } };
			return {
				draft: {
					kind: "edit",
					entryId: s.draft.entryId,
					index: s.draft.index,
					text,
					initialText: s.draft.initialText,
				},
			};
		}),

	addDraftImages: (images) =>
		set((s) => {
			if (images.length === 0) return {};
			if (s.draft.kind === "compose") {
				// Clamp to the wire limit: two rapid addFiles calls can both compute
				// the same `room` before the async prep lands.
				const merged = [...(s.draft.images ?? []), ...images].slice(0, MAX_IMAGES_PER_MESSAGE);
				return { draft: { ...s.draft, images: merged } };
			}
			if (s.draft.kind === "idle") {
				return { draft: { kind: "compose", text: "", images }, composerExpanded: true };
			}
			// Edit drafts carry the edited entry's images implicitly (the fork
			// re-sends them); new attachments in edit mode are not supported.
			return {};
		}),

	removeDraftImage: (index) =>
		set((s) => {
			if (s.draft.kind !== "compose" || !s.draft.images) return {};
			const images = s.draft.images.filter((_, i) => i !== index);
			return { draft: { ...s.draft, images } };
		}),

	beginEdit: (entryId, index, text) =>
		set({ draft: { kind: "edit", entryId, index, text, initialText: text }, composerExpanded: true }),

	// Blur rule:
	//  - edit draft → no-op. Edit is a sticky mode, decoupled from
	//    textarea focus: window-switch/copy/click-away blur must NOT drop
	//    the edit target, or a later send takes the compose branch
	//    (fork from the leaf = append) instead of the edit branch (fork
	//    from the edited message's parent). Exit paths are explicit Cancel
	//    (Escape / the composer Cancel button) and successful commit.
	//  - compose draft, non-empty → keep, keep expanded
	//  - compose draft, empty → discard to idle, collapse
	// Streaming or queued steers keep the bar up regardless. This reads the
	// protocol slice's document status — the only cross-slice read here.
	blurDraft: () =>
		set((s) => {
			const streaming = s.document.status.isStreaming || s.document.status.pendingSteer.length > 0;
			if (s.draft.kind === "edit") return {};
			if (s.draft.kind === "compose") {
				const hasImages = s.draft.images !== undefined && s.draft.images.length > 0;
				if (s.draft.text.trim() || hasImages) return {};
				return { draft: { kind: "idle" }, composerExpanded: streaming };
			}
			return { composerExpanded: streaming };
		}),

	clearDraft: () => set({ draft: { kind: "idle" } }),

	setComposerExpanded: (composerExpanded) => set({ composerExpanded }),
});
