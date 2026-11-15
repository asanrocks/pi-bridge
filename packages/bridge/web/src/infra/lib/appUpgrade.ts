// ============================================================================
// appUpgrade — replace this app with the copy the Daemon currently serves.
//
// Two callers, one action. A tab whose build is not the Daemon's (a window left
// open across an upgrade, an installed PWA resumed from a cached shell) reloads
// on boot by itself; a tab that has already been running when the Daemon came
// back as another build shows the amber connection control, and its click is the
// same reload.
//
// Reloading is the whole fix — `/index.html` is served no-cache and vite
// content-hashes everything under `/assets/` — but the service worker's cached
// shell would survive as the offline fallback, so the caches go first.
//
// The boot reload is claimed once per Daemon build in `sessionStorage`, because
// a reload creates a document with no memory: a Daemon whose *served* assets are
// not its own build (a web bundle rebuilt under a running process) would
// otherwise reload forever. When the claim is refused, the caller states the
// stuck case instead. Storage that cannot be written (private mode) refuses the
// claim too: a visible state the reader can act on beats a reload loop.
// ============================================================================

import type { BuildStamp } from "../../../../src/core/index.ts";

let reloadInFlight = false;

/** The Daemon build a boot reload was already attempted for. */
const RELOAD_CLAIM_KEY = "pi-bridge:build-reload";

/** The worker refresh is best-effort and bounded: a slow or offline update check
 * must not hold the reload the user asked for. */
const WORKER_UPDATE_TIMEOUT_MS = 2_000;

/** True while `reloadFromDaemon` runs: the draft guard must not raise the
 * browser's "leave site?" prompt for a reload this app decided on. Drafts are
 * persisted per address, so nothing is lost either way. */
export function isAppReloadInFlight(): boolean {
	return reloadInFlight;
}

/** Clear the shell caches, refresh the worker, then reload into the Daemon's
 * app. Best-effort on both steps: a failure leaves the cached shell at worst,
 * which the navigation's network-first policy still repairs. */
export async function reloadFromDaemon(): Promise<void> {
	if (reloadInFlight) return;
	reloadInFlight = true;
	await Promise.all([updateServiceWorker(), clearCaches()]);
	window.location.reload();
}

/** Claim the one boot reload allowed for `build`, the Daemon build this page
 * found itself talking to. False when it was already claimed — this document
 * has reloaded into that build and still disagrees, so another reload cannot
 * help. The claim is released by `clearReloadClaim` once the builds agree. */
export function claimBootReload(build: BuildStamp): boolean {
	const claim = build.commit;
	try {
		if (sessionStorage.getItem(RELOAD_CLAIM_KEY) === claim) return false;
		sessionStorage.setItem(RELOAD_CLAIM_KEY, claim);
		return true;
	} catch {
		return false;
	}
}

/** Release the claim: this document agrees with its Daemon, so the next boot
 * mismatch (a later upgrade) may reload once again. */
export function clearReloadClaim(): void {
	try {
		sessionStorage.removeItem(RELOAD_CLAIM_KEY);
	} catch {
		// No storage: nothing was ever claimed.
	}
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
