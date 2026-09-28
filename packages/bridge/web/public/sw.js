// pi-bridge service worker — two jobs.
//
// 1. Notification vehicle. Document-created Notification() does not display
//    while the browser is backgrounded on mobile (Firefox Android defers it
//    to foreground; most other mobile browsers throw TypeError).
//    ServiceWorkerRegistration.showNotification() goes through the OS channel
//    and displays regardless.
//
// 2. Offline app shell. The daemon serves the SPA, so a reload while it is
//    down would die on the network before the client's cache-first boot
//    could render anything. The fetch handler keeps the page loadable:
//      - navigations: network-first (deploy freshness — the shell is served
//        no-cache), falling back to the last cached shell;
//      - /assets/*: cache-first (vite content-hashes them and the daemon
//        serves them immutable);
//      - everything else (the WebSocket RPC is not a fetch at all): never
//        intercepted, never cached.
//    Requests are discriminated by mode and URL, never by re-implementing
//    the server's resource-vs-address path rule — the daemon stays the
//    single authority for what a path means. The vite dev server is
//    unaffected: it serves no /assets/* paths, and network-first
//    navigations pass through whenever it is up.
//
// clients.claim(): take control of the loading page immediately, so
// navigator.serviceWorker.controller is set on first visit without a
// reload — the page can then route notifications through this SW.
const SHELL_CACHE = "pi-bridge-shell-v1";
const SHELL_KEY = "/index.html";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) => Promise.all(names.filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
			for (const client of clients) {
				if ("focus" in client) return client.focus();
			}
		}),
	);
});

// The fetch policy as a directly testable function: `deps` injects `fetch`
// and the Cache API so unit tests can run this file with stubs. Returns a
// Response promise, or null when the request must pass through untouched.
function fetchPolicy(request, deps) {
	if (request.method !== "GET") return null;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return null;

	if (request.mode === "navigate") {
		return deps.fetch(request).then((response) => {
			if (!response.ok) return response;
			// The daemon answers every navigation with the same shell; keep the
			// newest one for the offline fallback. A failed cache write must
			// not fail the navigation.
			const copy = response.clone();
			return deps.caches
				.open(SHELL_CACHE)
				.then((cache) => cache.put(SHELL_KEY, copy))
				.then(() => response, () => response);
		}, () =>
			deps.caches.open(SHELL_CACHE).then((cache) => cache.match(SHELL_KEY)).then((shell) => {
				if (shell) return shell;
				throw new Error("offline and no cached shell");
			}),
		);
	}

	if (url.pathname.startsWith("/assets/")) {
		return deps.caches.open(SHELL_CACHE).then((cache) =>
			cache.match(request).then((hit) => {
				if (hit) return hit;
				return deps.fetch(request).then((response) => {
					if (!response.ok) return response;
					const copy = response.clone();
					return cache.put(request, copy).then(() => response, () => response);
				});
			}),
		);
	}

	return null;
}

self.addEventListener("fetch", (event) => {
	// `fetch` is a WebIDL operation, not a plain function: extracted and
	// called unbound (deps.fetch(request)) its receiver is `deps`, and the
	// binding rejects it — "fetch called on an object that does not implement
	// interface WorkerGlobalScope" — so every cache miss failed. Bind it to
	// the worker global before handing it to the policy.
	const handler = fetchPolicy(event.request, { fetch: fetch.bind(self), caches });
	if (handler !== null) event.respondWith(handler);
});
