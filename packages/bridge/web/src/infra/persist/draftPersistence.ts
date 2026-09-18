// ============================================================================
// useDraftGuard — durable compose drafts: localStorage persistence scoped
// per draft slot + beforeunload warning on unsent text.
//
// The slot is derived from the address the tab is watching (ADR 11): an open
// session keys by its durable session id (globally unique, and what the ADR
// 09 cache and the initial-sync SessionRef already carry), the Project home
// keys by projectId (the pre-session "floating draft", an ADR 12 slice), and
// the global launcher has none. The session id is set on every
// openSession/newSession, before any draft write.
//
// Persistence is imperative (store.subscribe), not a reactive effect: a
// reactive persist effect would race the restore effect on scope switch
// (stale draft + new key = leak into the wrong slot). The subscribe callback
// reads keyRef, which the restore effect sets synchronously before loading
// the saved draft, so writes always land in the correct slot.
// ============================================================================

import { useEffect, useRef } from "react";
import { getStore, useStore } from "../state/store.tsx";

const DRAFT_PREFIX = "pi-bridge:draft:";

/** The localStorage slot for the current address, or null when none. */
function draftKey(state: {
	currentProjectId: string | null;
	currentStem: string | null;
	activeSessionId: string | null;
}): string | null {
	// Session first: an open session may transiently coexist with a stale
	// project binding (openProject leaves the old attachment in place).
	if (state.currentStem !== null) {
		return state.activeSessionId !== null ? `s:${state.activeSessionId}` : null;
	}
	return state.currentProjectId !== null ? `p:${state.currentProjectId}` : null;
}

export function useDraftGuard(): void {
	const currentProjectId = useStore((s) => s.currentProjectId);
	const currentStem = useStore((s) => s.currentStem);
	const activeSessionId = useStore((s) => s.activeSessionId);
	const key = draftKey({ currentProjectId, currentStem, activeSessionId });

	// Set by the restore effect before any draft write so the persist
	// subscriber always targets the correct slot.
	const keyRef = useRef<string | null>(null);

	// ── Restore on scope switch ──────────────────────────────────────────
	// Loads the saved compose draft (dormant — the session composer stays
	// collapsed until the user focuses it) or clears a stale draft from the
	// previous slot. Edit drafts are session-live and never restored here.
	useEffect(() => {
		if (key === null) {
			keyRef.current = null;
			return;
		}
		keyRef.current = key;
		const store = getStore().getState();
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(DRAFT_PREFIX + key);
		} catch {
			// Private mode / disabled storage — degrade to in-memory drafts.
		}
		if (saved != null && saved.length > 0) {
			store.setDraft({ kind: "compose", text: saved });
		} else {
			store.clearDraft();
		}
	}, [key]);

	// ── Persist compose-draft text on change ────────────────────────────
	// Subscribed once. Filters to compose-text changes; edit drafts are not
	// persisted (session-live). keyRef gates writes until a scope is open.
	// Image attachments are deliberately not persisted (localStorage quota
	// vs. base64 payloads); text is the recoverable work.
	useEffect(() => {
		const unsub = getStore().subscribe((state, prev) => {
			const slot = keyRef.current;
			if (slot === null) return;
			const cur = state.draft.kind === "compose" ? state.draft.text : null;
			const old = prev.draft.kind === "compose" ? prev.draft.text : null;
			if (cur === old) return;
			try {
				if (cur != null && cur.trim().length > 0) {
					localStorage.setItem(DRAFT_PREFIX + slot, cur);
				} else {
					localStorage.removeItem(DRAFT_PREFIX + slot);
				}
			} catch {
				// Quota / private mode — silently drop; the in-memory draft stands.
			}
		});
		return unsub;
	}, []);

	// ── Warn on tab close with unsent text ───────────────────────────────
	// Reads fresh store state at event time. Fires for any non-empty draft
	// (compose or edit) — edit text is user work too.
	useEffect(() => {
		const handler = (e: BeforeUnloadEvent) => {
			const draft = getStore().getState().draft;
			const text = draft.kind === "idle" ? "" : draft.text;
			if (text.trim()) {
				e.preventDefault();
				e.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, []);
}
