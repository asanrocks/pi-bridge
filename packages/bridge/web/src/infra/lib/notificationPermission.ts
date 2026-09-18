// ============================================================================
// notificationPermission — the browser notification-permission state, split
// out of useStatusNotifications (app) so the composer's send path can request
// permission from its user gesture without importing the app shell. The
// module cache is shared: the hook's fire path reads the same state the
// request path writes.
// ============================================================================

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

/** Whether a browser notification may be posted right now (syncs first). */
export function notificationPermissionGranted(): boolean {
	syncPermissionState();
	return permissionState === "granted";
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
