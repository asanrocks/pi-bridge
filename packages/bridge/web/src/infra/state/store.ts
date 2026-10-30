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
//   - ui.ts — ephemeral view state: expand/collapse sets, keyboard focus, pull
//     tickers, chrome, toasts
// Slices share one store on purpose: `clearCurrentSession` (protocol) resets
// session-scoped composer/UI state, and `blurDraft` (composer) reads the
// document's streaming status — the seams are documented at each site.
// ============================================================================

import { createStore } from "zustand/vanilla";
import { type ComposerSlice, createComposerSlice } from "./composer.ts";
import { createProtocolSlice, type ProtocolSlice } from "./protocol.ts";
import { createUiSlice, type UiSlice } from "./ui.ts";

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
// The application store — one instance, outside React
// ---------------------------------------------------------------------------

// The imperative connection and event paths (pipeline, navigation, pull
// loop) need the store without a React context; this module is DOM- and
// React-free, so they import it directly and the React context (store.tsx)
// re-exports the same singleton.
const applicationStore = createClientStore();

/** The application store (for actions, outside render). */
export function getStore() {
	return applicationStore;
}

// ---------------------------------------------------------------------------
// Public surface — consumers keep importing from this module.
// ---------------------------------------------------------------------------

export type { ComposerDraft } from "./composer.ts";
export { selectDraftImages } from "./composer.ts";
export type { ConnectionState, SessionFolderPage } from "./protocol.ts";
export type { Toast } from "./ui.ts";
