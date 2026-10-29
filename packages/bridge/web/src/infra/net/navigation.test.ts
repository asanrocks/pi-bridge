// Navigation — the one owner of browser Session selection. These tests pin
// the transition machinery the old scattered flow could only guarantee by
// guards: optimistic staging, initial-sync commit, failure rollback, boot
// fallback, superseded transitions, alias handling, candidate promotion, and
// the terminal session_closed landing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	BridgeClient,
	CacheEntryRecord,
	Document,
	PatchOp,
	PrefixCursor,
	RpcReply,
	SessionInfo,
	SessionRef,
} from "../../../../src/core/index.ts";
import { initFromEntries } from "../../../../src/core/index.ts";
import { getStore } from "../state/store.tsx";
import {
	cacheBase,
	navigationBoot,
	navigationInitialSync,
	navigationLatest,
	navigationOpen,
	navigationProject,
	navigationSessionClosed,
	resetNavigationForTests,
} from "./navigation.ts";
import { beginSessionCandidate, discardSessionCandidate } from "./sessionCandidate.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REF_A: SessionRef = { projectId: "proj", sessionId: "id-a", stem: "a" };
const REF_B: SessionRef = { projectId: "proj", sessionId: "id-b", stem: "b" };

function emptyDocument(): Document {
	return initFromEntries([]);
}

function resetStore(overrides: Record<string, unknown> = {}): void {
	getStore().setState({
		currentProjectId: null,
		currentStem: null,
		activeSessionId: null,
		addressViaAlias: false,
		document: emptyDocument(),
		renderLeafId: null,
		...overrides,
	});
}

/** A deferred the tests control. */
function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
	let open!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

interface FakeClient {
	client: BridgeClient;
	applyReplaces: Document[];
	openCalls: Array<{ projectId: string; stem: string; cursor?: PrefixCursor }>;
	detachReplies: Array<RpcReply>;
	/** Configure the next openSession replies, in order. */
	openReplies: Array<Promise<RpcReply>>;
}

function fakeClient(): FakeClient {
	const fake = {} as FakeClient;
	const applyReplaces: Document[] = [];
	const openCalls: FakeClient["openCalls"] = [];
	fake.openReplies = [];
	fake.detachReplies = [];
	fake.applyReplaces = applyReplaces;
	fake.openCalls = openCalls;
	fake.client = {
		mirror: {
			applyReplace: (doc: Document) => applyReplaces.push(doc),
		},
		openSession: async (projectId: string, stem: string, cursor?: PrefixCursor) => {
			openCalls.push({ projectId, stem, cursor });
			const reply = fake.openReplies.shift();
			if (reply) return reply;
			return { ok: true, session: { projectId, sessionId: `id-${stem}`, stem } } as unknown as RpcReply;
		},
		detach: async () => (fake.detachReplies.shift() ?? { ok: true }) as RpcReply,
	} as unknown as BridgeClient;
	return fake;
}

const g = globalThis as unknown as { window?: unknown };
let replaceState: ReturnType<typeof vi.fn>;

function installWindow(pathname: string): void {
	replaceState = vi.fn();
	g.window = { location: { pathname }, history: { replaceState } };
}

function routeWritten(): string | undefined {
	const call = replaceState.mock.calls.at(-1);
	return call ? (call[2] as string) : undefined;
}

beforeEach(() => {
	resetStore();
	installWindow("/");
});

afterEach(() => {
	delete g.window;
	resetStore();
	discardSessionCandidate();
});

function recordsFor(sessionId: string): CacheEntryRecord[] {
	return [
		{
			sessionId,
			ord: 0,
			entryId: "e0",
			entry: {
				kind: "message",
				id: "e0",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				ord: 0,
				role: "user",
				content: [{ type: "text", text: "seed" }],
			} as unknown as CacheEntryRecord["entry"],
		},
	];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Navigation", () => {
	it("commits the view on the address-bearing initial sync", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });

		const opened = navigationOpen({ projectId: "proj", stem: "a" });
		// Optimistic staging: the address and the route name the target before
		// the RPC resolves.
		expect(getStore().getState().currentStem).toBe("a");
		expect(routeWritten()).toBe("/proj/a");

		navigationInitialSync(REF_A, null);
		const result = await opened;
		expect(result.ok).toBe(true);
		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBe("a");
		expect(s.activeSessionId).toBe("id-a");
	});

	it("rolls back to the last committed view when a navigate open fails", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		// Commit a view to restore: open A, sync A, settle A.
		const okA = gate<RpcReply>();
		fake.openReplies.push(okA.promise);
		const first = navigationOpen({ projectId: "proj", stem: "a" });
		okA.open({ ok: true, session: REF_A } as unknown as RpcReply);
		navigationInitialSync(REF_A, null);
		await first;

		const fail = gate<RpcReply>();
		fake.openReplies.push(fail.promise);
		const opened = navigationOpen({ projectId: "proj", stem: "b" });
		fail.open({ id: "x", ok: false, error: "no such session" } as unknown as RpcReply);

		const result = await opened;
		expect(result.ok).toBe(false);
		const s = getStore().getState();
		// The server left the previous attachment untouched, so the client
		// restores the previous address, id, and route.
		expect(s.currentStem).toBe("a");
		expect(s.activeSessionId).toBe("id-a");
		expect(routeWritten()).toBe("/proj/a");
	});

	it("a superseded open commits nothing: its sync and its failure are ignored", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });

		// Open A, then supersede it with B before either settles.
		const openA = gate<RpcReply>();
		const openB = gate<RpcReply>();
		fake.openReplies.push(openA.promise, openB.promise);
		void navigationOpen({ projectId: "proj", stem: "a" });
		const openedB = navigationOpen({ projectId: "proj", stem: "b" });

		// The server serialized both transitions: A's initial sync arrives
		// first and must commit nothing.
		navigationInitialSync(REF_A, null);
		expect(getStore().getState().activeSessionId).toBeNull();

		// A's reply fails; a naive rollback would have restored the launcher
		// while B was still in flight.
		openA.open({ id: "x", ok: false, error: "gone" } as unknown as RpcReply);
		navigationInitialSync(REF_B, null);
		openB.open({ ok: true, session: REF_B } as unknown as RpcReply);

		const result = await openedB;
		expect(result.ok).toBe(true);
		const s = getStore().getState();
		expect(s.currentStem).toBe("b");
		expect(s.activeSessionId).toBe("id-b");
	});

	it("a boot failure lands on the Project home", async () => {
		const fake = fakeClient();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: () => "id-a",
			loadSession: async () => ({ records: recordsFor("id-a"), hint: null }),
		});
		const fail = gate<RpcReply>();
		fake.openReplies.push(fail.promise);

		const booted = navigationBoot({ projectId: "proj", stem: "a" });
		// The boot seeds the mirror and the store from the cache before the
		// RPC resolves.
		await vi.waitFor(() => expect(fake.applyReplaces.length).toBe(1));
		fail.open({ id: "x", ok: false, error: "no such session" } as unknown as RpcReply);

		const result = await booted;
		expect(result.ok).toBe(false);
		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(routeWritten()).toBe("/proj");
	});

	it("seeds the mirror and the store from the cache on boot", async () => {
		const fake = fakeClient();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: () => "id-a",
			loadSession: async () => ({ records: recordsFor("id-a"), hint: null }),
		});
		const booted = navigationBoot({ projectId: "proj", stem: "a" });
		navigationInitialSync(REF_A, null);
		expect((await booted).ok).toBe(true);
		// The cache seed painted the store before the wire answered.
		expect(Object.keys(getStore().getState().document.entries)).toEqual(["e0"]);
		expect(cacheBase.value?.sessionId).toBe("id-a");
	});

	it("promotes the candidate on a matching initial-sync delta", async () => {
		const fake = fakeClient();
		const cursor: PrefixCursor = { sessionId: "id-b", lastKnownId: "e0", entryCount: 1 };
		resetNavigationForTests({
			getClient: () => fake.client,
			prepareSwitch: async (sessionId) => {
				// Mirrors the real prepareSwitch: seed the candidate, derive
				// the cursor.
				beginSessionCandidate(sessionId, emptyDocument());
				return cursor;
			},
		});

		// The server pushes the initial sync before the reply; gate the reply
		// so the sync is processed while the candidate is still pending.
		const replyGate = gate<RpcReply>();
		fake.openReplies.push(replyGate.promise);
		const opened = navigationOpen({ projectId: "proj", stem: "b" }, { sessionId: "id-b" });
		await vi.waitFor(() => expect(fake.openCalls.length).toBe(1));
		expect(fake.openCalls[0].cursor).toEqual(cursor);
		navigationInitialSync(REF_B, [{ op: "add", path: "/status/isStreaming", value: false } as PatchOp]);
		replyGate.open({ id: "x", ok: true, session: REF_B } as unknown as RpcReply);
		expect((await opened).ok).toBe(true);
		// The promoted candidate document replaced the mirror, and the cache
		// base is the pre-promotion seed.
		expect(fake.applyReplaces.length).toBe(1);
		expect(cacheBase.value?.sessionId).toBe("id-b");
	});

	it("commits a no-pending sync (a newSession's initial sync)", () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		navigationInitialSync(REF_A, null);
		const s = getStore().getState();
		expect(s.currentStem).toBe("a");
		expect(s.activeSessionId).toBe("id-a");
	});

	it("an abandoned target's late sync commits nothing", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		const openA = gate<RpcReply>();
		const openB = gate<RpcReply>();
		fake.openReplies.push(openA.promise, openB.promise);
		void navigationOpen({ projectId: "proj", stem: "a" });
		void navigationOpen({ projectId: "proj", stem: "b" });
		openA.open({ ok: true, session: REF_A } as unknown as RpcReply);
		openB.open({ ok: true, session: REF_B } as unknown as RpcReply);
		await vi.waitFor(() => expect(getStore().getState().currentStem).toBe("b"));
		// Both opens settled with no sync yet; A's late sync must not commit
		// over the committed B view.
		navigationInitialSync(REF_A, null);
		expect(getStore().getState().activeSessionId).toBeNull();
	});

	it("resolves the /@latest alias and keeps the alias URL", async () => {
		const fake = fakeClient();
		resetNavigationForTests({
			getClient: () => fake.client,
			resolveLatest: async () => ({ projectId: "proj", stem: "a", sessionId: "id-a" }) as unknown as SessionInfo,
		});
		const opened = navigationLatest();
		// The alias route is written at staging; the alias flag suppresses
		// route writes on the sync commit.
		await vi.waitFor(() => expect(routeWritten()).toBe("/@latest"));
		expect(getStore().getState().addressViaAlias).toBe(true);
		navigationInitialSync(REF_A, null);
		expect((await opened).ok).toBe(true);
		const calls = replaceState.mock.calls.filter((c) => c[2] === "/proj/a");
		expect(calls).toHaveLength(0);
		expect(getStore().getState().addressViaAlias).toBe(true);
	});

	it("session_closed lands on the Project home only for the rendered Session", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		resetStore({ currentProjectId: "proj", currentStem: "a", activeSessionId: "id-a" });

		navigationSessionClosed("proj", "other");
		expect(getStore().getState().currentStem).toBe("a");

		navigationSessionClosed("proj", "a");
		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(routeWritten()).toBe("/proj");
	});

	it("Project home (navigate) commits after the detach and is not conditional on it", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		// Commit a session view to leave: open A, sync, settle.
		const okA = gate<RpcReply>();
		fake.openReplies.push(okA.promise);
		const first = navigationOpen({ projectId: "proj", stem: "a" });
		okA.open({ ok: true, session: REF_A } as unknown as RpcReply);
		navigationInitialSync(REF_A, null);
		await first;

		const result = await navigationProject("proj");
		expect(result.ok).toBe(true);
		const s = getStore().getState();
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(routeWritten()).toBe("/proj");
	});
});
