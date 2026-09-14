// pi-bridge service worker — notification vehicle only.
//
// Document-created Notification() does not display while the browser is
// backgrounded on mobile (Firefox Android defers it to foreground; most
// other mobile browsers throw TypeError). ServiceWorkerRegistration.
// showNotification() goes through the OS channel and displays regardless.
//
// Deliberately no fetch handler: this SW never intercepts or caches
// requests, so the dev server and HMR are unaffected.
//
// clients.claim(): take control of the loading page immediately, so
// navigator.serviceWorker.controller is set on first visit without a
// reload — the page can then route notifications through this SW.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
