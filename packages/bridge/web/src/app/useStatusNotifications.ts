// ============================================================================
// useStatusNotifications — tab title (activity emoji + unread count) and
// browser notification on turn completion.
//
// Title composition (agreed UX):
//   streaming:  "🔧 (+3) name" — emoji reflects what's running, (+N) what
//               finished unread while away (counts show even mid-stream)
//   idle+unread: "🔔 (+5) name" — bell replaces the emoji only when idle
//   otherwise:  "name"
// The count accumulates per settled agent message (sealed text-bearing
// assistant entry — see UnreadMessageCounter), survives turn transitions,
// counts completions in hidden tabs too (a browser notification fires as
// well), and resets to 0 when the window regains focus.
//
// The completion notification is decided in the store subscription below,
// not in a render effect: backgrounded tabs suspend their timers (and
// rAF), so anything decided after render — or deferred via setTimeout,
// such as a grace window — cannot run while hidden. The pipeline flushes
// status-op patches synchronously (see connectionPipeline), so the
// subscription observes the streaming→idle transition at frame-arrival
// time, when document.hidden is still trustworthy. The remaining race —
// a completion frame arriving in the narrow resume window, before the
// visibilitychange task — is covered by re-checking document.hidden inside
// `notifyTurnCompletion` after its async registration hop; focus-close cleans
// up any near-miss by tag. The notification mechanics themselves live in
// `infra/lib/userNotification.ts`, shared with the queue-wide attention
// tracker (ADR 23): one path posts OS notices, so the two cannot drift.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { UnreadMessageCounter } from "../infra/lib/unreadCounter.ts";
import { closeUserNotification, notifyTurnCompletion } from "../infra/lib/userNotification.ts";
import { getStore } from "../infra/state/store.tsx";

// ---------------------------------------------------------------------------
// Activity signal
// ---------------------------------------------------------------------------

export interface ActivitySignal {
	emoji: string; // 🔧 🧠 💬
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStatusNotifications({
	isStreaming,
	statusName,
	activity,
}: {
	isStreaming: boolean;
	statusName: string;
	activity: ActivitySignal;
}) {
	const [unreadCount, setUnreadCount] = useState(0);
	const wasStreamingRef = useRef(isStreaming);

	// Per-message unread counting + turn tracking. Subscribe at store level
	// (not useStore) so neither ever re-renders; gated on document identity
	// so draft typing and UI toggles don't trigger entry scans.
	useEffect(() => {
		const counter = new UnreadMessageCounter();
		return getStore().subscribe((s, prev) => {
			if (counter.switchedSession(s.activeSessionId)) {
				// Attach/session switch: baseline the existing history —
				// pre-existing messages never count as unread — and re-baseline
				// the turn tracker so a mid-turn state from the previous
				// session cannot leak across.
				counter.rebase(s.document.entries);
				setUnreadCount(0);
				wasStreamingRef.current = s.document.status.isStreaming;
			} else if (s.document !== prev.document) {
				const fresh = counter.sync(s.document.entries);
				// Unfocused covers hidden (a hidden tab cannot hold focus).
				// Focused: the user is watching — absorb silently.
				if (fresh > 0 && !document.hasFocus()) setUnreadCount((c) => c + fresh);

				// Turn transition. Status-op patches flush synchronously in
				// the pipeline, so this runs at frame-arrival time — the
				// timer/rAF suspension of a backgrounded tab cannot delay it
				// past the point where document.hidden is still accurate.
				const was = wasStreamingRef.current;
				const now = s.document.status.isStreaming;
				wasStreamingRef.current = now;
				if (was && !now && document.hidden) {
					void notifyTurnCompletion({
						label: s.document.status.name || "pi-bridge",
						body: `${s.document.status.name || "pi-bridge"} · Completed`,
						address: { projectId: s.currentProjectId ?? "", stem: s.currentStem ?? "" },
					});
				}
			}
		});
	}, []);

	// Reset count + close notification on focus
	useEffect(() => {
		const onFocus = () => {
			setUnreadCount(0);
			closeUserNotification();
		};
		window.addEventListener("focus", onFocus);
		return () => {
			window.removeEventListener("focus", onFocus);
		};
	}, []);

	// Tab title
	const countLabel = unreadCount > 0 ? ` (+${unreadCount > 99 ? "99+" : unreadCount})` : "";
	useEffect(() => {
		const name = statusName || "pi-bridge";
		if (isStreaming) {
			document.title = `${activity.emoji}${countLabel} ${name}`;
		} else if (unreadCount > 0 && !document.hasFocus()) {
			document.title = `\uD83D\uDD14${countLabel} ${name}`; // 🔔
		} else {
			document.title = name;
		}
	}, [statusName, isStreaming, unreadCount, activity.emoji, countLabel]);
}
