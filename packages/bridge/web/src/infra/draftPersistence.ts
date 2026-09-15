// ============================================================================
// useDraftGuard — durable composer drafts: localStorage persistence scoped
// per session + beforeunload warning on unsent text.
//
// Why session id (not instance id): an instance's *current* session changes
// on switchSession/newSession, so an instance-keyed slot would conflate
// drafts across sessions of the same project. Session ids are globally
// unique, so the draft slot is the conversation identity. The session id is
// derived from the (fresh) instances list — switchSession/newSession refresh
// listInstances so the derived id tracks the server's current session.
//
// Persistence is imperative (store.subscribe), not a reactive effect: a
// reactive persist effect would race the restore effect on session switch
// (stale draft + new key = leak into the wrong slot). The subscribe callback
// reads keyRef, which the restore effect sets synchronously before loading
// the saved draft, so writes always land in the correct slot.
// ============================================================================

import { useEffect, useRef } from "react";
import { getStore, useStore } from "./store.tsx";

const DRAFT_PREFIX = "pi-bridge:draft:";

export function useDraftGuard(): void {
	const hasSession = useStore((s) => s.currentStem !== null);
	const activeSessionId = useStore((s) => s.activeSessionId);

	// The localStorage key for the currently-open session, or null when none.
	// Set by the restore effect before any draft write so the persist
	// subscriber always targets the correct slot.
	const keyRef = useRef<string | null>(null);

	// ── Restore on open / switch ────────────────────────────────────────
	// Loads the saved compose draft (dormant — composer stays collapsed
	// until the user focuses it) or clears a stale draft from the previous
	// session. Edit drafts are session-live and never restored here.
	useEffect(() => {
		if (!hasSession || !activeSessionId) {
			keyRef.current = null;
			return;
		}
		const key = DRAFT_PREFIX + activeSessionId;
		keyRef.current = key;
		const store = getStore().getState();
		let saved: string | null = null;
		try {
			saved = localStorage.getItem(key);
		} catch {
			// Private mode / disabled storage — degrade to in-memory drafts.
		}
		if (saved != null && saved.length > 0) {
			store.setDraft({ kind: "compose", text: saved });
		} else {
			store.clearDraft();
		}
	}, [hasSession, activeSessionId]);

	// ── Persist compose-draft text on change ────────────────────────────
	// Subscribed once. Filters to compose-text changes; edit drafts are not
	// persisted (session-live). keyRef gates writes until a session is open,
	// so pre-attach typing (impossible in practice — the composer only mounts
	// for an open session) is a no-op.
	useEffect(() => {
		const unsub = getStore().subscribe((state, prev) => {
			const key = keyRef.current;
			if (key === null) return;
			const cur = state.draft.kind === "compose" ? state.draft.text : null;
			const old = prev.draft.kind === "compose" ? prev.draft.text : null;
			if (cur === old) return;
			try {
				if (cur != null && cur.trim().length > 0) {
					localStorage.setItem(key, cur);
				} else {
					localStorage.removeItem(key);
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
