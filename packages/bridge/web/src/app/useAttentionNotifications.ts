// ============================================================================
// useAttentionNotifications — the queue-wide completion signal (ADR 24).
//
// The attached conversation already drives the tab title, the unread count,
// and its own completion notice. This hook covers the rest: a Session the tab
// is NOT reading settles, and the user has to learn about it without polling
// the switcher.
//
// The signal is an occurrence, not a sampled state: a five-second queue
// publication interval would hide a whole short run, so the daemon forwards
// `session_settled` immediately — with the execution's outcome, because the
// queue cannot report one (a stopped run and a finished run both leave an idle
// row). Which outcomes are news is decided here, in the client: a run that
// finished is the case this hook exists for, a failure is worth saying out
// loud, and an abort is the reader's own gesture.
//
// A visible page is announced by nothing: the TopBar badge already carries both
// facts (how many answers are owed, and which of them arrived since this page
// read them), so a per-settlement toast would restate an indicator the user can
// already see — and its click had nowhere to go. Only a hidden page, where that
// badge is not on screen, gets an OS notification, and that notice navigates on
// click because it is the only affordance the user has left.
//
// The decision is made in the store subscription, not in a render effect: a
// backgrounded tab suspends timers, so anything deferred to an effect could
// run after the moment `document.hidden` still described.
// ============================================================================

import { useEffect } from "react";
import type { SessionInfo } from "../../../src/core/index.ts";
import { notifyTurnCompletion } from "../infra/lib/userNotification.ts";
import type { SettlementNotice } from "../infra/state/protocol.ts";
import { getStore } from "../infra/state/store.tsx";

export function useAttentionNotifications(): void {
	useEffect(() => {
		const store = getStore();
		// Notices already filed before this hook mounted were announced by the
		// transition that filed them; drain only what arrives from now on.
		let drained = store.getState().settlementsSeq;

		return store.subscribe((s) => {
			if (s.settlementsSeq === drained) return;
			const attached = attachedKey(s);
			for (const notice of s.settlements) {
				if (notice.seq <= drained) continue;
				drained = notice.seq;
				// The reader stopped it: they already know, and they did it.
				if (notice.outcome === "aborted") continue;
				const key = `${notice.session.projectId}/${notice.session.stem}`;
				// The Session this tab reads carries its own completion in the tab
				// title and unread count (`useStatusNotifications`).
				if (key === attached) continue;
				// Only the case the badge cannot cover: no badge is on screen.
				if (!document.hidden) continue;
				const label = labelFor(s.queue, notice);
				void notifyTurnCompletion({
					label,
					body: `${label} · ${notice.outcome === "error" ? "Failed" : "Ready for your input"}`,
					address: { projectId: notice.session.projectId, stem: notice.session.stem },
				});
			}
		});
	}, []);
}

/** The Session's label: the name the Worker reported, else the queue row's own
 * name or first message, else the address's stem. The row is this page's own
 * display data, so a settle never carries a second copy of it. */
function labelFor(queue: readonly SessionInfo[], notice: SettlementNotice): string {
	if (notice.name !== undefined) return notice.name;
	const key = `${notice.session.projectId}/${notice.session.stem}`;
	const row = queue.find((entry) => `${entry.projectId}/${entry.stem}` === key);
	return row?.name || row?.firstMessageText || notice.session.stem;
}

function attachedKey(s: { currentProjectId: string | null; currentStem: string | null }): string | null {
	return s.currentProjectId !== null && s.currentStem !== null ? `${s.currentProjectId}/${s.currentStem}` : null;
}
