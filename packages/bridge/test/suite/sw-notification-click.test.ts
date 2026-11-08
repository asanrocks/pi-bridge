// ============================================================================
// Service worker notification-click tests (ADR 23). The shipped
// web/public/sw.js is executed with stubbed `self.clients`, so the tested
// artifact is what the browser runs. What matters here: a completion notice
// names a Session, and a click lands on it — focusing the open client and
// handing it the address (the page owns navigation), or opening the address
// directly when no client exists. Unit category: pure handler over injected
// deps, no daemon, no DOM.
// ============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const swSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../web/public/sw.js"), "utf8");

interface FakeClient {
	focused: number;
	messages: unknown[];
	focus: () => Promise<void>;
	postMessage: (message: unknown) => void;
}

interface ClickHarness {
	/** Fire the registered notificationclick listener and await its work. */
	click: (data: unknown) => Promise<void>;
	openedWindows: string[];
	clients: FakeClient[];
}

function loadClickHarness({ withClient }: { withClient: boolean }): ClickHarness {
	const listeners: Record<string, (event: unknown) => void> = {};
	const openedWindows: string[] = [];
	const client: FakeClient = {
		focused: 0,
		messages: [],
		focus() {
			this.focused += 1;
			return Promise.resolve();
		},
		postMessage(message) {
			this.messages.push(message);
		},
	};
	const clients = withClient ? [client] : [];
	const self = {
		location: { origin: "http://localhost:8080" },
		addEventListener: (type: string, fn: (event: unknown) => void) => {
			listeners[type] = fn;
		},
		skipWaiting: () => {},
		clients: {
			claim: () => {},
			matchAll: () => Promise.resolve(clients),
			openWindow: (url: string) => {
				openedWindows.push(url);
				return Promise.resolve(null);
			},
		},
	};
	const factory = new Function("self", "caches", "fetch", "URL", swSource) as (
		s: unknown,
		c: unknown,
		f: unknown,
		u: unknown,
	) => void;
	factory(self, {}, () => Promise.resolve(), URL);

	return {
		openedWindows,
		clients,
		async click(data) {
			let work: Promise<unknown> = Promise.resolve();
			listeners.notificationclick({
				notification: { close: () => {}, data },
				waitUntil: (p: Promise<unknown>) => {
					work = p;
				},
			});
			await work;
		},
	};
}

describe("sw notificationclick", () => {
	it("focuses an open client and hands it the Session address", async () => {
		const h = loadClickHarness({ withClient: true });
		await h.click({ projectId: "acme", stem: "work/review" });
		expect(h.clients[0].focused).toBe(1);
		expect(h.clients[0].messages).toEqual([{ type: "open-session", projectId: "acme", stem: "work/review" }]);
		expect(h.openedWindows).toEqual([]);
	});

	it("opens the Session's route when no client is open", async () => {
		const h = loadClickHarness({ withClient: false });
		await h.click({ projectId: "acme", stem: "work/review" });
		// The stem is a relative path: each segment is encoded, and the
		// separators survive.
		expect(h.openedWindows).toEqual(["/acme/work/review"]);
	});

	it("opens the app root when the notice carries no usable address", async () => {
		const h = loadClickHarness({ withClient: false });
		await h.click({});
		expect(h.openedWindows).toEqual([]);
	});

	it("encodes a segment that is not URL-safe", async () => {
		const h = loadClickHarness({ withClient: false });
		await h.click({ projectId: "a b", stem: "x/y z" });
		expect(h.openedWindows).toEqual(["/a%20b/x/y%20z"]);
	});
});
