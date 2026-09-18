// ============================================================================
// Zustand store — single source of truth for the web UI.
// Holds a Document root (not the DocumentMirror).
// Browser-safe: no node:* imports, no DOM.
// Lives in web/src/ because this is web-app state, not protocol.
//
// One store, composed of three slices (files under ./store/):
//   - protocol.ts — wire/daemon-driven state: Document mirror, connection,
//     address (ADR 11), registries, sidebar folder pages
//   - composer.ts — the draft (the textarea's single source of truth) and
//     composer expansion
//   - ui.ts — ephemeral view state: expand/fold sets, keyboard focus, pull
//     tickers, chrome, toasts
// Slices share one store on purpose: `clearCurrentSession` (protocol) resets
// session-scoped composer/UI state, and `blurDraft` (composer) reads the
// document's streaming status — the seams are documented at each site.
// ============================================================================

import { createStore } from "zustand/vanilla";
import { type ComposerSlice, createComposerSlice } from "./store/composer.ts";
import { createProtocolSlice, type ProtocolSlice } from "./store/protocol.ts";
import { createUiSlice, type UiSlice } from "./store/ui.ts";

export type ClientStore = ProtocolSlice & ComposerSlice & UiSlice;

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createClientStore() {
	return createStore<ClientStore>((...a) => ({
		...createProtocolSlice(...a),
		...createComposerSlice(...a),
		...createUiSlice(...a),
	}));
}

// ---------------------------------------------------------------------------
// Public surface — consumers keep importing from this module.
// ---------------------------------------------------------------------------

export type { ComposerDraft } from "./store/composer.ts";
export { selectDraftImages } from "./store/composer.ts";
export type { ConnectionState, SessionFolderPage } from "./store/protocol.ts";
export type { ExpandKeySets, Toast } from "./store/ui.ts";
export { migrateExpandKeys } from "./store/ui.ts";
