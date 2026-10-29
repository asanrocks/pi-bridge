// Navigation — the one owner of browser Session selection. These tests pin
// the transition machinery the old scattered flow could only guarantee by
// guards: optimistic staging, initial-sync commit, failure rollback, boot
// fallback, superseded transitions, alias handling, candidate promotion, and
// the terminal session_closed landing.
//
// The authority rule these tests hold navigation to: a step may read and
// write anything; an effect may only observe and return a message. The
// supersede regressions pin the races that rule exists for — a stale alias
// resolution, a superseded boot's cache seed, a reverse-order cache read —
// each landing after a newer intent committed and each committing nothing.

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
	type NavigationResult,
	navigationBoot,
	navigationBootLatest,
	navigationInitialSync,
	navigationLatest,
	navigationOpen,
	navigationProject,
	navigationSessionClosed,
	resetNavigationForTests,
} from "./navigation.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REF_A: SessionRef = { projectId: "proj", sessionId: "id-a", stem: "a" };
const REF_B: SessionRef = { projectId: "proj", sessionId: "id-b", stem: "b" };
const REF_C: SessionRef = { projectId: "proj", sessionId: "id-c", stem: "c" };

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

/** One microtask-drain tick: lets effect completions queue and apply. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
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

const DELTA_OP: PatchOp = { op: "add", path: "/status/isStreaming", value: false };

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
			lookupSessionId: () => "id-b",
			loadSession: async () => ({ records: recordsFor("id-b"), hint: null }),
		});

		// The server pushes the initial sync before the reply; gate the reply
		// so the sync is processed while the candidate is still pending.
		const replyGate = gate<RpcReply>();
		fake.openReplies.push(replyGate.promise);
		const opened = navigationOpen({ projectId: "proj", stem: "b" }, { sessionId: "id-b" });
		await vi.waitFor(() => expect(fake.openCalls.length).toBe(1));
		expect(fake.openCalls[0].cursor).toEqual(cursor);
		navigationInitialSync(REF_B, [DELTA_OP]);
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
		const openedA = navigationOpen({ projectId: "proj", stem: "a" });
		const openedB = navigationOpen({ projectId: "proj", stem: "b" });
		openA.open({ ok: true, session: REF_A } as unknown as RpcReply);
		openB.open({ ok: true, session: REF_B } as unknown as RpcReply);
		// Let both settlements apply: B committed (defensively, from its
		// reply's ref — no sync arrived yet), A was superseded.
		await openedA;
		await openedB;
		expect(getStore().getState().currentStem).toBe("b");
		expect(getStore().getState().activeSessionId).toBe("id-b");
		// A's late sync must not commit over the committed B view.
		navigationInitialSync(REF_A, null);
		const s = getStore().getState();
		expect(s.currentStem).toBe("b");
		expect(s.activeSessionId).toBe("id-b");
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

	it("an alias resolution superseded by a newer intent commits nothing", async () => {
		// F2: the lookup re-entered as a fresh intent overrode the successor.
		const fake = fakeClient();
		const resolve = gate<SessionInfo | null>();
		resetNavigationForTests({
			getClient: () => fake.client,
			resolveLatest: () => resolve.promise,
		});
		const latest = navigationLatest();
		// A newer intent commits B while the lookup is in flight.
		const openedB = navigationOpen({ projectId: "proj", stem: "b" });
		navigationInitialSync(REF_B, null);
		await openedB;
		expect(getStore().getState().currentStem).toBe("b");

		// The stale lookup now returns A — it must commit nothing: no staged
		// open, no alias route, no address or id change.
		resolve.open({ projectId: "proj", stem: "a", sessionId: "id-a" } as unknown as SessionInfo);
		const result = await latest;
		expect(result.ok).toBe(true);
		const s = getStore().getState();
		expect(s.currentStem).toBe("b");
		expect(s.activeSessionId).toBe("id-b");
		expect(routeWritten()).toBe("/proj/b");
		expect(s.addressViaAlias).toBe(false);
	});

	it("a superseded boot-time alias resolution cannot clear the committed view", async () => {
		// F2b: a stale "nothing to open" answer cleared the committed view.
		const fake = fakeClient();
		const resolve = gate<SessionInfo | null>();
		resetNavigationForTests({
			getClient: () => fake.client,
			resolveLatest: () => resolve.promise,
		});
		const bootLatest = navigationBootLatest();
		// A newer intent commits C while the lookup is in flight.
		const openedC = navigationOpen({ projectId: "proj", stem: "c" });
		navigationInitialSync(REF_C, null);
		await openedC;
		expect(getStore().getState().currentStem).toBe("c");

		resolve.open(null);
		await bootLatest;
		const s = getStore().getState();
		expect(s.currentStem).toBe("c");
		expect(s.activeSessionId).toBe("id-c");
		expect(routeWritten()).toBe("/proj/c");
	});

	it("a superseded open's late cache read never overwrites the successor's candidate", async () => {
		// G1: the seed happened inside the open effect, so a superseded open
		// that finished its cache read last overwrote the successor's
		// candidate — the successor's delta then failed to promote.
		const fake = fakeClient();
		const loadA = gate<{ records: CacheEntryRecord[]; hint: null }>();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: (_projectId, stem) => `id-${stem}`,
			loadSession: async (sessionId) =>
				sessionId === "id-a" ? loadA.promise : { records: recordsFor("id-b"), hint: null },
		});
		// Open A (cache read gated), then supersede with B (cache read
		// immediate): B seeds its candidate and sends its RPC first.
		const replyB = gate<RpcReply>();
		fake.openReplies.push(replyB.promise);
		void navigationOpen({ projectId: "proj", stem: "a" });
		const openedB = navigationOpen({ projectId: "proj", stem: "b" });
		await vi.waitFor(() => expect(fake.openCalls.length).toBe(1));

		// A's cache read resolves AFTER B seeded — the superseded transition
		// must seed nothing.
		loadA.open({ records: recordsFor("id-a"), hint: null });
		await tick();

		// B's delta initial sync still promotes its own candidate; its reply
		// settles afterwards (the server pushes the sync first).
		navigationInitialSync(REF_B, [DELTA_OP]);
		replyB.open({ id: "x", ok: true, session: REF_B } as unknown as RpcReply);
		await openedB;
		expect(cacheBase.value?.sessionId).toBe("id-b");
		expect(fake.applyReplaces.length).toBe(1);
	});

	it("a superseded boot never paints the abandoned session's cache", async () => {
		// G2: the boot effect seeded the live mirror and the store from
		// inside the effect, so a superseded boot painted the abandoned
		// session's cache into the committed view.
		const fake = fakeClient();
		const loadA = gate<{ records: CacheEntryRecord[]; hint: null }>();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: (_projectId, stem) => `id-${stem}`,
			loadSession: async (sessionId) => (sessionId === "id-a" ? loadA.promise : { records: [], hint: null }),
		});
		const bootedA = navigationBoot({ projectId: "proj", stem: "a" });
		// Supersede with an open to B that commits.
		const openedB = navigationOpen({ projectId: "proj", stem: "b" });
		navigationInitialSync(REF_B, null);
		await openedB;
		expect(getStore().getState().currentStem).toBe("b");

		// The abandoned boot's cache read resolves: neither the mirror nor
		// the store may receive A's seed.
		loadA.open({ records: recordsFor("id-a"), hint: null });
		await bootedA;
		expect(fake.applyReplaces).toHaveLength(0);
		const s = getStore().getState();
		expect(s.currentStem).toBe("b");
		expect(Object.keys(s.document.entries)).toEqual([]);
	});

	it("a throwing dependency settles the caller instead of hanging", async () => {
		// G7: every effect path settles the caller — an unexpected throw
		// becomes a failed transition, not a permanently pending RPC.
		const fake = fakeClient();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: () => {
				throw new Error("index bug");
			},
		});
		const opened: Promise<NavigationResult> = navigationOpen({ projectId: "proj", stem: "a" });
		const result = await Promise.race([
			opened,
			new Promise<NavigationResult>((_, reject) => setTimeout(() => reject(new Error("hung")), 300)),
		]);
		expect(result.ok).toBe(false);
		// The failure rolled back to the (empty) committed view.
		expect(getStore().getState().currentStem).toBeNull();
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

	it("a close cancels a pending open to that address: no RPC, settled caller, nothing commits", async () => {
		// F3: the closed push crossed a transition in flight targeting the
		// closed address. The caller must settle, the prepare must admit no
		// RPC (the runtime it targeted is gone), and the view must not carry
		// the optimistically staged address.
		const fake = fakeClient();
		const load = gate<{ records: CacheEntryRecord[]; hint: null }>();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: () => "id-a",
			loadSession: () => load.promise,
		});
		const opened = navigationOpen({ projectId: "proj", stem: "a" });
		expect(getStore().getState().currentStem).toBe("a"); // staged

		navigationSessionClosed("proj", "a");
		const result = await opened;
		expect(result.ok).toBe(false);
		expect(result.error).toBe("session closed");
		// The staged address went with the landing: the rendered Session's
		// runtime ended, so the client shows the Project home.
		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(routeWritten()).toBe("/proj");

		// The cancelled transition's cache read resolves afterwards: its
		// prepare admits no RPC (no server-side open of a dead session) and
		// its late sync commits nothing.
		load.open({ records: recordsFor("id-a"), hint: null });
		await tick();
		expect(fake.openCalls).toHaveLength(0);
		navigationInitialSync(REF_A, null);
		expect(getStore().getState().currentStem).toBeNull();
	});

	it("a close removes the dead session as a rollback target for an in-flight open", async () => {
		// F3's visible failure: a transition in flight to C while its rollback
		// target B was closed could "restore" the dead session on failure.
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		// Commit B: open, sync, settle.
		const okB = gate<RpcReply>();
		fake.openReplies.push(okB.promise);
		const first = navigationOpen({ projectId: "proj", stem: "b" });
		okB.open({ ok: true, session: REF_B } as unknown as RpcReply);
		navigationInitialSync(REF_B, null);
		await first;

		// Open C (fails later); B dies while C is in flight.
		const failC = gate<RpcReply>();
		fake.openReplies.push(failC.promise);
		const openedC = navigationOpen({ projectId: "proj", stem: "c" });
		navigationSessionClosed("proj", "b");
		failC.open({ id: "x", ok: false, error: "no such session" } as unknown as RpcReply);

		const result = await openedC;
		expect(result.ok).toBe(false);
		// The rollback cannot restore the closed B: it lands on the Project
		// home (the same boundary the close used), not the dead session.
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
