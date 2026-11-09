// ============================================================================
// useAttentionNotifications — the queue-wide completion signal (ADR 24).
//
// The attached conversation already drives the tab title, the unread count,
// and its own completion notice. This hook covers the rest: a Session the tab
// is NOT reading finishes its turn, and the user has to learn about it without
// polling the switcher.
//
// The signal is an occurrence, not a sampled state: a five-second queue
// publication interval would hide a whole short turn, so the daemon forwards
// `session_completed` immediately and this hook drains the store's notice log
// by sequence.
//
// A visible page is announced by nothing: the TopBar badge already carries both
// facts (how many answers are owed, and which of them arrived since this page
// read them), so a per-completion toast would restate an indicator the user can
// already see — and its click had nowhere to go. Only a hidden page, where that
// badge is not on screen, gets an OS notification, and that notice navigates on
// click because it is the only affordance the user has left.
//
// The decision is made in the store subscription, not in a render effect: a
// backgrounded tab suspends timers, so anything deferred to an effect could
// run after the moment `document.hidden` still described.
// ============================================================================

import { useEffect } from "react";
import { notifyTurnCompletion } from "../infra/lib/userNotification.ts";
import { getStore } from "../infra/state/store.tsx";

export function useAttentionNotifications(): void {
	useEffect(() => {
		const store = getStore();
		// Notices already filed before this hook mounted were announced by the
		// transition that filed them; drain only what arrives from now on.
		let drained = store.getState().completionsSeq;

		return store.subscribe((s) => {
			if (s.completionsSeq === drained) return;
			const attached = attachedKey(s);
			for (const notice of s.completions) {
				if (notice.seq <= drained) continue;
				drained = notice.seq;
				const key = `${notice.session.projectId}/${notice.session.stem}`;
				// The Session this tab reads carries its own completion in the tab
				// title and unread count (`useStatusNotifications`).
				if (key === attached) continue;
				// Only the case the badge cannot cover: no badge is on screen.
				if (!document.hidden) continue;
				const label = notice.name || notice.lastMessageText || notice.session.stem;
				void notifyTurnCompletion({
					label,
					body: `${label} · Ready for your input`,
					address: { projectId: notice.session.projectId, stem: notice.session.stem },
				});
			}
		});
	}, []);
}

function attachedKey(s: { currentProjectId: string | null; currentStem: string | null }): string | null {
	return s.currentProjectId !== null && s.currentStem !== null ? `${s.currentProjectId}/${s.currentStem}` : null;
}
