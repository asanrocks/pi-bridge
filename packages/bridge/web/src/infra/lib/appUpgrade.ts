// ============================================================================
// appUpgrade — replace this app with the copy the daemon currently serves.
//
// `connectionStatus` offers this for one state: the app is older than the daemon
// it speaks to (a tab left open across a daemon upgrade, or an installed PWA
// resumed from a cached shell). Reloading is enough by itself — `/index.html` is
// served no-cache and vite content-hashes everything under `/assets/` — but the
// service worker's cached shell would survive as the offline fallback, so the
// caches go first.
//
// The Cache API is origin-wide, so the page clears what the worker wrote without
// a message channel to it, and the worker's own activate step already deletes
// every foreign cache: there is exactly one owner of this origin's caches and no
// name to keep in sync across the two files.
// ============================================================================

let reloadInFlight = false;

/** The worker refresh is best-effort and bounded: a slow or offline update check
 * must not hold the reload the user asked for. */
const WORKER_UPDATE_TIMEOUT_MS = 2_000;

/** True while `reloadFromDaemon` runs: the draft guard must not raise the
 * browser's "leave site?" prompt for a reload the user asked for. Drafts are
 * persisted per address, so nothing is lost either way. */
export function isAppReloadInFlight(): boolean {
	return reloadInFlight;
}

/** Clear the shell caches, refresh the worker, then reload into the daemon's
 * app. Best-effort on both steps: a failure leaves the cached shell at worst,
 * which the navigation's network-first policy still repairs. */
export async function reloadFromDaemon(): Promise<void> {
	if (reloadInFlight) return;
	reloadInFlight = true;
	await Promise.all([updateServiceWorker(), clearCaches()]);
	window.location.reload();
}

async function updateServiceWorker(): Promise<void> {
	const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
	if (registration === undefined) return;
	await Promise.race([
		registration.update().catch(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, WORKER_UPDATE_TIMEOUT_MS)),
	]);
}

async function clearCaches(): Promise<void> {
	try {
		const names = await caches.keys();
		await Promise.all(names.map((name) => caches.delete(name)));
	} catch {
		// No Cache API (or it refused): nothing of ours to clear.
	}
}
