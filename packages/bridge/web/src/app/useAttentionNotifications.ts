// ============================================================================
// useAttentionNotifications — the queue-wide completion signal (ADR 23).
//
// The attached conversation already drives the tab title, the unread count,
// and its own completion notice. This hook covers the rest: a Session the tab
// is NOT reading finishes its turn, and the user has to learn about it without
// polling the switcher.
//
// Delivery is chosen by what the user can see:
//   - page hidden  → one OS notification naming the Session, whose click opens
//     it (`infra/lib/userNotification.ts` plus the service worker's
//     `notificationclick` handler);
//   - page visible → one quiet in-app toast, keyed by Session so two
//     completions do not overwrite each other.
//
// The decision is made in the store subscription, not in a render effect: a
// backgrounded tab suspends timers, so anything deferred to an effect could
// run after the moment `document.hidden` still described.
// ============================================================================

import { useEffect } from "react";
import { QueueAttention, sessionKey } from "../infra/lib/queueAttention.ts";
import { notifyTurnCompletion } from "../infra/lib/userNotification.ts";
import { getStore } from "../infra/state/store.tsx";

export function useAttentionNotifications(): void {
	useEffect(() => {
		const tracker = new QueueAttention();
		const store = getStore();
		const initial = store.getState();
		tracker.seed(initial.queue);
		tracker.setAttached(attachedKey(initial));

		return store.subscribe((s, prev) => {
			// The address this tab reads decides whether a completion is this
			// hook's to announce at all.
			if (s.currentProjectId !== prev.currentProjectId || s.currentStem !== prev.currentStem) {
				tracker.setAttached(attachedKey(s));
			}
			// A connect or reconnect re-fetches the queue: seed, never announce.
			// Every row of that snapshot is news the client has not seen.
			if (s.connection !== prev.connection) {
				tracker.seed(s.queue);
				return;
			}
			if (s.queue === prev.queue) return;
			// The snapshot itself is compared only once the connection is
			// confirmed: the connect path publishes `listQueue`'s rows before it
			// flips the store to `connected`, so a reconnect's baseline would
			// otherwise read as a burst of completions.
			for (const row of tracker.observe(s.queue, s.connection.kind === "connected")) {
				const label = row.name || row.firstMessageText || row.stem;
				if (document.hidden) {
					void notifyTurnCompletion({
						label,
						body: `${label} · Ready for your input`,
						address: { projectId: row.projectId, stem: row.stem },
					});
				} else {
					store.getState().pushToast(`attention:${sessionKey(row)}`, `${label} · Ready for your input`);
				}
			}
		});
	}, []);
}

function attachedKey(s: { currentProjectId: string | null; currentStem: string | null }): string | null {
	return s.currentProjectId !== null && s.currentStem !== null ? `${s.currentProjectId}/${s.currentStem}` : null;
}
