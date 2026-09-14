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
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { getStore } from "./store.tsx";
import { UnreadMessageCounter } from "./unreadCounter.ts";

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
// Permission
// ---------------------------------------------------------------------------

type PermissionState = "granted" | "denied" | "unavailable";

let permissionState: PermissionState = "unavailable";
let permissionRequested = false;

/** Sync the browser's current permission state into the module cache. */
function syncPermissionState(): void {
	if (typeof Notification === "undefined") {
		permissionState = "unavailable";
		return;
	}
	permissionState = Notification.permission as PermissionState;
}

/**
 * Request notification permission. Must be called from a user gesture
 * (e.g. send): browsers gate `requestPermission()` on transient activation,
 * so deferring to a later arbitrary click fails on mobile. Once-only — a
 * denial or dismiss is not re-promitted.
 */
export function requestNotificationPermission(): void {
	if (permissionRequested) return;
	permissionRequested = true;
	if (typeof Notification === "undefined") {
		permissionState = "unavailable";
		return;
	}
	// Already decided on a previous visit (granted/denied)
	if (Notification.permission !== "default") {
		permissionState = Notification.permission as PermissionState;
		return;
	}
	Notification.requestPermission().then((r) => {
		permissionState = r as PermissionState;
	});
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

	// Per-message unread counting. Subscribe at store level (not useStore)
	// so counting never re-renders; gated on document identity so draft
	// typing and UI toggles don't trigger entry scans.
	useEffect(() => {
		const counter = new UnreadMessageCounter();
		return getStore().subscribe((s, prev) => {
			if (counter.switchedInstance(s.attachedInstanceId)) {
				// Attach/instance switch: baseline the existing history —
				// pre-existing messages never count as unread.
				counter.rebase(s.document.entries);
				setUnreadCount(0);
			} else if (s.document !== prev.document) {
				const fresh = counter.sync(s.document.entries);
				// Unfocused covers hidden (a hidden tab cannot hold focus).
				// Focused: the user is watching — absorb silently.
				if (fresh > 0 && !document.hasFocus()) setUnreadCount((c) => c + fresh);
			}
		});
	}, []);

	// Turn duration tracking + browser notification on hidden completion.
	// The count itself is NOT touched here — it accumulates per message via
	// the store subscription above and clears only on focus.
	useEffect(() => {
		const was = wasStreamingRef.current;
		wasStreamingRef.current = isStreaming;

		if (!was && isStreaming) {
			turnStartRef.current = Date.now();
		} else if (was && !isStreaming && turnStartRef.current !== null) {
			const durationMs = Date.now() - turnStartRef.current;
			turnStartRef.current = null;

			if (document.hidden) {
				fireNotification(statusName || "pi-bridge", durationMs);
			}
		}
	}, [isStreaming, statusName]);

	// Reset count + close notification on focus
	useEffect(() => {
		const onFocus = () => {
			setUnreadCount(0);
			closeNotification();
		};
		// Cancel a pending fire when the tab becomes visible. A page resumed
		// from background freeze processes its queued WebSocket frames *before*
		// the visibilitychange (visible) task, so document.hidden is stale-true
		// during that burst — the grace timer alone can still lose that race.
		const onVisibility = () => {
			if (document.visibilityState === "visible") cancelPendingFire();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
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

// Grace window before actually posting a Notification. A tab resumed from
// background freeze flushes queued WebSocket frames before its
// visibilitychange (visible) task, so a completion seen "while hidden" may
// really be a foregrounding user. Deferring the fire gives the visibility
// task time to cancel it; a genuinely hidden tab just fires ~1s late
// (background timer clamping is >= 1s anyway).
const NOTIFY_GRACE_MS = 1000;

let fireTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingFire(): void {
	if (fireTimer !== null) {
		clearTimeout(fireTimer);
		fireTimer = null;
	}
}

function fireNotification(sessionName: string, durationMs: number): void {
	syncPermissionState();
	if (permissionState !== "granted") return;
	if (typeof Notification === "undefined") return;

	const seconds = Math.round(durationMs / 1000);
	cancelPendingFire();
	fireTimer = setTimeout(() => {
		fireTimer = null;
		// Foregrounded during the grace window: the user is looking at the
		// completed turn; a notification now would be noise.
		if (!document.hidden) return;

		closeNotification();
		void showNotification(`${sessionName} · Completed (${seconds}s)`);
	}, NOTIFY_GRACE_MS);
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
