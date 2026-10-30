// ============================================================================
// viewPort — the typed seam between the browser view actor and the store,
// route, and address index it publishes to (ADR 19).
//
// The navigation reactor owns every view decision; this port is the complete
// inventory of what those decisions may read and write. The actor's steps
// call the port instead of touching the Zustand store, the history API, or
// the address index, so the store/route/index mechanics live in one adapter
// and the actor's inputs and outputs are explicit:
//
//   - reads answer "what did the last decision publish" (the rendered
//     address, the durable session id, whether the rendered document is
//     empty) — the race guards that must observe published state read them
//     here, never from the store directly;
//   - writes are the decisions themselves (stage, commit, restore, clear,
//     paint), each mapping to exactly one adapter behavior.
//
// The port is injectable (NavigationDeps.port), so the actor's tests can run
// against a recording fake and production runs the default adapter below.
// ============================================================================

import type { Document, SessionRef } from "../../../../src/core/index.ts";
import type { Route } from "../lib/routes.ts";
import { writeRoute } from "../lib/routes.ts";
import { rememberAddress } from "../persist/addressIndex.ts";
import { getStore } from "../state/store.tsx";

/** What a step may ask about the currently published view. */
export interface ViewPublication {
	readonly projectId: string | null;
	readonly stem: string | null;
}

/** The view shapes the port restores and routes. Structurally compatible
 * with navigation's `NavigationView`. */
export type ViewTarget =
	| { kind: "launcher" }
	| { kind: "project"; projectId: string }
	| { kind: "session"; projectId: string; stem: string };

export interface NavigationViewPort {
	// ── Reads: the actor's explicit inputs ───────────────────────────────

	/** The rendered address — the store's publication of the committed view,
	 * or the optimistic stage while a transition is in flight. */
	renderedAddress(): ViewPublication;
	/** The durable session id the store published (null until an
	 * address-bearing frame landed — the local-seed guard reads it). */
	renderedSessionId(): string | null;
	/** True when the rendered document holds no entries (a local-seed paint
	 * target: an empty wire-committed document is already authoritative). */
	renderedDocumentEmpty(): boolean;
	/** The rendered document (the store's copy of the mirror). A reconnect
	 * reuses the richer in-memory document over the cache when the session id
	 * matches. */
	renderedDocument(): Document;

	// ── Writes: the actor's decisions ────────────────────────────────────

	/** The alias flag (ADR 13): while set, address-bearing commits keep the
	 * alias URL instead of writing the resolved address. */
	setAddressViaAlias(viaAlias: boolean): void;
	/** Stage an address optimistically (a transition in flight), or a
	 * Project home when the stem is null. */
	stageAddress(projectId: string, stem: string | null): void;
	/** Commit an observation: remember the address, publish the address, the
	 * durable session id, the document, and its revision as one store write
	 * (no subscriber sees a new document under an old address or the
	 * reverse), and write the route unless the alias view holds it. */
	commitObservation(ref: SessionRef, doc: Document, revision: number): void;
	/** Commit an observation's identity without a document (no mirror — the
	 * document publishes with the next frame). */
	commitAddress(ref: SessionRef): void;
	/** Publish the durable session id alone (the local-seed pair: the address
	 * is staged first, then the id — `setCurrentSession` unbinds a stale id
	 * on an address change, so the order is load-bearing). */
	publishSessionId(sessionId: string | null): void;
	/** Paint a locally restored document (cache-first boot): a publication
	 * outside the mirror, advancing the store's own revision counter. */
	paintLocalDocument(doc: Document): void;
	/** Restore a previously committed view (a failed navigate's rollback):
	 * the address, the session id, and the route all describe the view the
	 * client actually holds. */
	restoreView(view: ViewTarget, sessionId: string | null): void;
	/** Clear the rendered Session — the address, the session id, the
	 * session-scoped UI state — optionally retaining a Project to land on
	 * its home. */
	clearSession(retainProjectId?: string): void;
	/** Write the URL route (the navigation source of truth). */
	writeRoute(route: Route): void;
}

/** The production port: the store, the route, and the address index. */
export function createNavigationViewPort(): NavigationViewPort {
	return {
		renderedAddress() {
			const s = getStore().getState();
			return { projectId: s.currentProjectId, stem: s.currentStem };
		},
		renderedSessionId() {
			return getStore().getState().activeSessionId;
		},
		renderedDocumentEmpty() {
			return Object.keys(getStore().getState().document.entries).length === 0;
		},
		renderedDocument() {
			return getStore().getState().document;
		},
		setAddressViaAlias(viaAlias) {
			getStore().getState().setAddressViaAlias(viaAlias);
		},
		stageAddress(projectId, stem) {
			getStore().getState().setCurrentSession(projectId, stem);
		},
		commitObservation(ref, doc, revision) {
			rememberAddress(ref.projectId, ref.stem, ref.sessionId);
			getStore().getState().commitObservation(ref, doc, revision);
			if (!getStore().getState().addressViaAlias) {
				writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
			}
		},
		commitAddress(ref) {
			rememberAddress(ref.projectId, ref.stem, ref.sessionId);
			getStore().getState().setCurrentSession(ref.projectId, ref.stem);
			getStore().getState().setActiveSessionId(ref.sessionId);
			if (!getStore().getState().addressViaAlias) {
				writeRoute({ kind: "session", projectId: ref.projectId, stem: ref.stem });
			}
		},
		publishSessionId(sessionId) {
			getStore().getState().setActiveSessionId(sessionId);
		},
		paintLocalDocument(doc) {
			// A local paint is a publication outside the mirror: the store's
			// own revision counter advances, exactly like a cache restore.
			getStore().getState().applyReplace(doc);
		},
		restoreView(view, sessionId) {
			if (view.kind === "session") {
				getStore().getState().setCurrentSession(view.projectId, view.stem);
			} else if (view.kind === "project") {
				getStore().getState().setCurrentSession(view.projectId, null);
			} else {
				getStore().getState().setCurrentSession(null, null);
			}
			getStore().getState().setActiveSessionId(sessionId);
			writeRoute(view);
		},
		clearSession(retainProjectId) {
			getStore().getState().clearCurrentSession(retainProjectId);
		},
		writeRoute(route) {
			writeRoute(route);
		},
	};
}
