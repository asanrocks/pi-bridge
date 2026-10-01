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
// showNotification after its async registration hop; focus-close cleans
// up any near-miss by tag.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { notificationPermissionGranted } from "../infra/lib/notificationPermission.ts";
import { UnreadMessageCounter } from "../infra/lib/unreadCounter.ts";
import { getStore } from "../infra/state/store.tsx";

// ---------------------------------------------------------------------------
// Activity signal
// ---------------------------------------------------------------------------

export interface ActivitySignal {
	emoji: string; // 🔧 🧠 💬
}

// ---------------------------------------------------------------------------
// Module-level state (one app, one notification)
// ---------------------------------------------------------------------------

const NOTIFICATION_TAG = "pi-bridge-turn-complete";

let activeNotification: Notification | null = null;

function closeNotification(): void {
	if (activeNotification) {
		activeNotification.close();
		activeNotification = null;
	}
	// SW-displayed notifications have no JS-side handle; close them by tag.
	if (typeof navigator !== "undefined" && navigator.serviceWorker) {
		navigator.serviceWorker
			.getRegistration()
			.then((reg) => reg?.getNotifications({ tag: NOTIFICATION_TAG }))
			.then((list) => {
				list?.forEach((n) => {
					n.close();
				});
			})
			.catch(() => {});
	}
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
	const turnStartRef = useRef<number | null>(null);
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
				turnStartRef.current = null;
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
				if (!was && now) {
					turnStartRef.current = Date.now();
				} else if (was && !now && turnStartRef.current !== null) {
					const durationMs = Date.now() - turnStartRef.current;
					turnStartRef.current = null;
					if (document.hidden) {
						fireNotification(s.document.status.name || "pi-bridge", durationMs);
					}
				}
			}
		});
	}, []);

	// Reset count + close notification on focus
	useEffect(() => {
		const onFocus = () => {
			setUnreadCount(0);
			closeNotification();
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

// ---------------------------------------------------------------------------
// Fire browser notification
// ---------------------------------------------------------------------------

function fireNotification(sessionName: string, durationMs: number): void {
	if (!notificationPermissionGranted()) return;
	if (typeof Notification === "undefined") return;

	const seconds = Math.round(durationMs / 1000);
	closeNotification();
	void showNotification(`${sessionName} · Completed (${seconds}s)`);
}

/**
 * Post the notification. Prefers the service-worker path: SW-shown
 * notifications go through the OS channel and display while the browser
 * itself is backgrounded. The document constructor is only a fallback —
 * Firefox Android defers it to foreground and most other mobile browsers
 * throw TypeError on it.
 */
async function showNotification(body: string): Promise<void> {
	const options = { body, tag: NOTIFICATION_TAG };

	// Only use the SW if one already controls the page — getRegistration()
	// can wait on a registration that never finishes installing.
	const swReg = navigator.serviceWorker?.controller ? await navigator.serviceWorker.getRegistration() : null;
	// Re-check after the async hop: a completion frame that arrived in the
	// resume window (before the visibilitychange task) saw a stale
	// hidden=true. The user is back and looking at the completed turn; a
	// notification now would be noise.
	if (!document.hidden) return;
	if (swReg) {
		try {
			await swReg.showNotification("pi-bridge", options);
			return;
		} catch {
			// Fall through to the constructor
		}
	}

	try {
		const n = new Notification("pi-bridge", options);
		activeNotification = n;
		n.addEventListener("close", () => {
			if (activeNotification === n) activeNotification = null;
		});
	} catch {
		// Mobile browsers throw TypeError here; nothing to show.
	}
}
