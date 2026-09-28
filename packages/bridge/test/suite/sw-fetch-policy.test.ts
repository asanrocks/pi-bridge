// ============================================================================
// Service worker fetch-policy tests. The test executes the shipped
// web/public/sw.js (read from disk, run in a Function scope with stubbed
// self, caches, and fetch) — so the tested artifact is exactly what the
// browser runs, with no duplicated policy module. The notification handlers
// are browser-lifecycle glue and stay untested here. Unit category: pure
// function over injected deps, no daemon, no DOM.
// ============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const swSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../web/public/sw.js"), "utf8");

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface FakeResponse {
	ok: boolean;
	status: number;
	body: string;
	clone(): FakeResponse;
}

function makeResponse(ok: boolean, body: string): FakeResponse {
	return { ok, status: ok ? 200 : 500, body, clone: () => makeResponse(ok, body) };
}

interface FakeRequest {
	method: string;
	mode: string;
	url: string;
}

function makeRequest(path: string, opts: { method?: string; mode?: string } = {}): FakeRequest {
	return {
		method: opts.method ?? "GET",
		mode: opts.mode ?? "no-cors",
		url: `http://localhost:8080${path}`,
	};
}

function makeCaches() {
	const store = new Map<string, FakeResponse>();
	const keyOf = (k: FakeRequest | string) => (typeof k === "string" ? k : k.url);
	const cache = {
		match: (k: FakeRequest | string) => Promise.resolve(store.get(keyOf(k))),
		put: (k: FakeRequest | string, res: FakeResponse) => {
			store.set(keyOf(k), res);
			return Promise.resolve();
		},
	};
	return {
		store,
		open: () => Promise.resolve(cache),
		keys: () => Promise.resolve([] as string[]),
	};
}

interface Worker {
	listeners: Record<string, (event: unknown) => void>;
	fetchPolicy: (request: FakeRequest, deps: unknown) => Promise<FakeResponse> | null;
}

function loadWorker(
	fetchImpl: (request: FakeRequest) => Promise<FakeResponse>,
	cachesImpl: ReturnType<typeof makeCaches>,
): Worker {
	const listeners: Record<string, (event: unknown) => void> = {};
	const self = {
		location: { origin: "http://localhost:8080" },
		addEventListener: (type: string, fn: (event: unknown) => void) => {
			listeners[type] = fn;
		},
		skipWaiting: () => {},
		clients: { claim: () => {}, matchAll: () => Promise.resolve([]) },
	};
	// Emulate a WebIDL global: the real `fetch` rejects a call whose receiver
	// is not the worker global ("does not implement interface
	// WorkerGlobalScope"). Plain-function stubs cannot catch the
	// unbound-extraction bug this guards against — sw.js must pass
	// fetch.bind(self) into the policy.
	const globalFetch = function (this: unknown, request: FakeRequest): Promise<FakeResponse> {
		if (this !== self) {
			return Promise.reject(
				new TypeError("'fetch' called on an object that does not implement interface WorkerGlobalScope."),
			);
		}
		return fetchImpl(request);
	};
	const factory = new Function("self", "caches", "fetch", "URL", `${swSource}\n;return { fetchPolicy };`) as (
		s: typeof self,
		c: typeof cachesImpl,
		f: typeof globalFetch,
		u: typeof URL,
	) => { fetchPolicy: Worker["fetchPolicy"] };
	const { fetchPolicy } = factory(self, cachesImpl, globalFetch, URL);
	return { listeners, fetchPolicy };
}

/** Fire the registered fetch listener; returns the respondWith promise, or
 *  null when the worker let the request pass through. */
function fireFetch(worker: Worker, request: FakeRequest): Promise<FakeResponse> | null {
	let responded: Promise<FakeResponse> | null = null;
	worker.listeners.fetch({
		request,
		respondWith: (p: Promise<FakeResponse>) => {
			responded = p;
		},
		waitUntil: () => {},
	});
	return responded;
}

const ORIGIN = "http://localhost:8080";

// ---------------------------------------------------------------------------
// Navigations
// ---------------------------------------------------------------------------

describe("sw fetch policy — navigations", () => {
	it("serves from the network and caches the shell", async () => {
		const caches = makeCaches();
		let fetched = 0;
		const worker = loadWorker(async () => {
			fetched += 1;
			return makeResponse(true, "SHELL-A");
		}, caches);

		const res = await fireFetch(worker, makeRequest("/proj/stem", { mode: "navigate" }));
		expect(fetched).toBe(1);
		expect(res?.body).toBe("SHELL-A");
		expect(caches.store.get("/index.html")?.body).toBe("SHELL-A");
	});

	it("falls back to the cached shell when the network fails", async () => {
		const caches = makeCaches();
		caches.store.set("/index.html", makeResponse(true, "CACHED-SHELL"));
		const worker = loadWorker(() => Promise.reject(new Error("daemon down")), caches);

		const res = await fireFetch(worker, makeRequest("/proj/stem", { mode: "navigate" }));
		expect(res?.body).toBe("CACHED-SHELL");
	});

	it("rejects when offline with no cached shell", async () => {
		const worker = loadWorker(() => Promise.reject(new Error("daemon down")), makeCaches());
		const res = fireFetch(worker, makeRequest("/proj/stem", { mode: "navigate" }));
		await expect(res).rejects.toThrow("no cached shell");
	});

	it("does not cache a non-ok navigation response", async () => {
		const caches = makeCaches();
		caches.store.set("/index.html", makeResponse(true, "GOOD-SHELL"));
		const worker = loadWorker(async () => makeResponse(false, "broken"), caches);

		const res = await fireFetch(worker, makeRequest("/proj/stem", { mode: "navigate" }));
		expect(res?.ok).toBe(false);
		expect(caches.store.get("/index.html")?.body).toBe("GOOD-SHELL");
	});

	it("keeps serving the navigation when the cache write fails", async () => {
		const caches = makeCaches();
		const broken = {
			...caches,
			open: () => Promise.reject(new Error("quota")),
		};
		const worker = loadWorker(async () => makeResponse(true, "SHELL-B"), broken);

		const res = await fireFetch(worker, makeRequest("/", { mode: "navigate" }));
		expect(res?.body).toBe("SHELL-B");
	});
});

// ---------------------------------------------------------------------------
// Hashed assets
// ---------------------------------------------------------------------------

describe("sw fetch policy — assets", () => {
	it("serves a cache hit without touching the network", async () => {
		const caches = makeCaches();
		caches.store.set(`${ORIGIN}/assets/index-abc.js`, makeResponse(true, "CACHED-JS"));
		let fetched = 0;
		const worker = loadWorker(async () => {
			fetched += 1;
			return makeResponse(true, "NET-JS");
		}, caches);

		const res = await fireFetch(worker, makeRequest("/assets/index-abc.js"));
		expect(fetched).toBe(0);
		expect(res?.body).toBe("CACHED-JS");
	});

	it("fetches a miss from the network and caches it", async () => {
		const caches = makeCaches();
		const worker = loadWorker(async () => makeResponse(true, "NET-JS"), caches);

		const res = await fireFetch(worker, makeRequest("/assets/index-abc.js"));
		expect(res?.body).toBe("NET-JS");
		expect(caches.store.get(`${ORIGIN}/assets/index-abc.js`)?.body).toBe("NET-JS");
	});

	it("does not cache a non-ok asset response", async () => {
		const caches = makeCaches();
		const worker = loadWorker(async () => makeResponse(false, "missing"), caches);

		const res = await fireFetch(worker, makeRequest("/assets/missing.js"));
		expect(res?.ok).toBe(false);
		expect(caches.store.has(`${ORIGIN}/assets/missing.js`)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Pass-through
// ---------------------------------------------------------------------------

describe("sw fetch policy — pass-through", () => {
	it("does not intercept non-GET requests", () => {
		const worker = loadWorker(async () => makeResponse(true, "x"), makeCaches());
		expect(fireFetch(worker, makeRequest("/assets/index-abc.js", { method: "POST" }))).toBeNull();
	});

	it("does not intercept cross-origin requests", () => {
		const worker = loadWorker(async () => makeResponse(true, "x"), makeCaches());
		const foreign: FakeRequest = { method: "GET", mode: "navigate", url: "https://example.com/page" };
		expect(fireFetch(worker, foreign)).toBeNull();
	});

	it("does not intercept same-origin non-asset GETs", () => {
		const worker = loadWorker(async () => makeResponse(true, "x"), makeCaches());
		expect(fireFetch(worker, makeRequest("/sw.js"))).toBeNull();
		expect(fireFetch(worker, makeRequest("/some/rpc/like/path"))).toBeNull();
	});
});
