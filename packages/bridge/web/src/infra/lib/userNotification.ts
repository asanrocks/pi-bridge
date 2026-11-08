// ============================================================================
// userNotification — the one path that posts an OS-level notification.
//
// Two callers post turn-completion notices: the attached Session's own flow
// (title + unread count, then a notification when the page is hidden) and the
// queue-wide attention tracker (a Session finishing while another is read).
// Both need the same mechanics, so they share this module:
//
//  - Service-worker first: `showNotification` goes through the OS channel and
//    displays while the browser is backgrounded on mobile, where the document
//    constructor is deferred (Firefox Android) or throws (most others).
//  - One notice per completion: a notice carries its Session's tag
//    (`notificationTag`), so two Sessions finishing together stay individually
//    clickable instead of the later one replacing the earlier.
//  - Visibility re-checked after the async registration hop: a completion that
//    arrived in the narrow resume window saw a stale hidden flag. Returning to
//    the page closes every notice this app posted.
//  - `data` rides along: the service worker's click handler opens the Session
//    the notice named, which is the whole point of a queue-wide notice.
// ============================================================================

import { notificationPermissionGranted } from "./notificationPermission.ts";

/** The payload a click handler needs to open the Session. */
export interface NotificationAddress {
	projectId: string;
	stem: string;
}

const TAG_PREFIX = "pi-bridge-turn-complete";

/** One tag per Session: simultaneous completions are separate notices, each
 * opening the Session it names. A single app-wide tag would make the last
 * completion replace the others, so a click could not reach them. */
export function notificationTag(address: NotificationAddress): string {
	return `${TAG_PREFIX}:${address.projectId}/${address.stem}`;
}

/** Notifications this app posted (any tag generation), so focus-close takes
 * back every completion notice rather than only the newest. */
function isOwnTag(tag: string): boolean {
	return tag === TAG_PREFIX || tag.startsWith(`${TAG_PREFIX}:`);
}

/** The document-constructor fallback's live handles; several can coexist now
 * that tags are per Session. */
const activeNotifications = new Set<Notification>();

export function closeUserNotification(): void {
	for (const notification of activeNotifications) notification.close();
	activeNotifications.clear();
	// SW-displayed notifications have no JS-side handle; close them by tag.
	if (typeof navigator !== "undefined" && navigator.serviceWorker) {
		navigator.serviceWorker
			.getRegistration()
			.then((reg) => reg?.getNotifications())
			.then((list) => {
				list?.forEach((n) => {
					if (isOwnTag(n.tag)) n.close();
				});
			})
			.catch(() => {});
	}
}

/** Post a completion notice. A no-op without permission, without the API, or
 * when the page is (again) visible — a reader who is back does not need it. */
export async function notifyTurnCompletion({
	label,
	body,
	address,
}: {
	/** The Session's display name; the notification's title. */
	label: string;
	body: string;
	/** The Session a click opens, and the notice's identity. */
	address: NotificationAddress;
}): Promise<void> {
	if (!notificationPermissionGranted()) return;
	if (typeof Notification === "undefined") return;

	const tag = notificationTag(address);
	const options: NotificationOptions = { body, tag, data: address };

	// Only use the SW if one already controls the page — getRegistration()
	// can wait on a registration that never finishes installing.
	const swReg = navigator.serviceWorker?.controller ? await navigator.serviceWorker.getRegistration() : null;
	// Re-check after the async hop: a completion that arrived in the resume
	// window (before the visibilitychange task) saw a stale hidden=true. The
	// user is back and looking at the completed turn; a notification is noise.
	if (!document.hidden) return;
	if (swReg) {
		try {
			await swReg.showNotification(label, options);
			return;
		} catch {
			// Fall through to the constructor
		}
	}

	try {
		const n = new Notification(label, options);
		activeNotifications.add(n);
		n.addEventListener("close", () => {
			activeNotifications.delete(n);
		});
	} catch {
		// Mobile browsers throw TypeError here; nothing to show.
	}
}
