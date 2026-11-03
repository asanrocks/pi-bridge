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
	currentCacheBase,
	type NavigationResult,
	navigationBoot,
	navigationBootLatest,
	navigationCreate,
	navigationLatest,
	navigationObservation,
	navigationOpen,
	navigationProject,
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
	/** Recorded newSession requests (the operation id is what the tests
	 * attribute the transition's initial sync with, like the server does). */
	createCalls: Array<{ projectId: string; text: string; operationId: string }>;
	detachReplies: Array<RpcReply>;
	/** Configure the next openSession replies, in order. */
	openReplies: Array<Promise<RpcReply>>;
	/** Configure the next newSession replies, in order. */
	createReplies: Array<Promise<RpcReply>>;
}

function fakeClient(): FakeClient {
	const fake = {} as FakeClient;
	const applyReplaces: Document[] = [];
	const openCalls: FakeClient["openCalls"] = [];
	const createCalls: FakeClient["createCalls"] = [];
	fake.openReplies = [];
	fake.createReplies = [];
	fake.detachReplies = [];
	fake.applyReplaces = applyReplaces;
	fake.openCalls = openCalls;
	fake.createCalls = createCalls;
	// A minimal DocumentMirror: `document`/`revision` are what navigation's
	// atomic observation commit publishes, `applyReplace` is what seeding
	// and promotion install.
	const mirror = {
		document: emptyDocument(),
		revision: 0,
		applyReplace(doc: Document) {
			mirror.document = doc;
			mirror.revision++;
			applyReplaces.push(doc);
		},
	};
	fake.client = {
		mirror,
		openSession: async (projectId: string, stem: string, cursor?: PrefixCursor) => {
			openCalls.push({ projectId, stem, cursor });
			const reply = fake.openReplies.shift();
			if (reply) return reply;
			return { ok: true, session: { projectId, sessionId: `id-${stem}`, stem } } as unknown as RpcReply;
		},
		newSession: async (projectId: string, text: string, options: { operationId: string }) => {
			createCalls.push({ projectId, text, operationId: options.operationId });
			const reply = fake.createReplies.shift();
			if (reply) return reply;
			return {
				ok: true,
				session: { projectId, sessionId: `id-new-${createCalls.length}`, stem: `new-${createCalls.length}` },
				operationId: options.operationId,
			} as unknown as RpcReply;
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

		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
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
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
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

	it("an open superseded before its prepare completes sends no RPC and settles superseded", async () => {
		const fake = fakeClient();
		const loadA = gate<{ records: CacheEntryRecord[]; hint: null }>();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: (_projectId, stem) => `id-${stem}`,
			loadSession: async (sessionId) => (sessionId === "id-a" ? loadA.promise : { records: [], hint: null }),
		});
		const openedA = navigationOpen({ projectId: "proj", stem: "a" });
		const openedB = navigationOpen({ projectId: "proj", stem: "b" });
		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: null, generation: 1 });
		expect((await openedB).ok).toBe(true);
		// A's cache read lands after B committed: no RPC was admitted, nothing
		// was seeded, and the caller learns the transition never ran —
		// superseded by a newer intent, not failed.
		loadA.open({ records: recordsFor("id-a"), hint: null });
		const result = await openedA;
		expect(result.superseded).toBe(true);
		expect(result.ok).toBe(false);
		expect(fake.openCalls.filter((c) => c.stem === "a")).toHaveLength(0);
	});

	it("an open superseded after its RPC was admitted commits nothing", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });

		// A's prepare completes while it owns the view, so its RPC is admitted
		// (already-admitted commands run to completion server-side).
		const openA = gate<RpcReply>();
		fake.openReplies.push(openA.promise);
		const openedA = navigationOpen({ projectId: "proj", stem: "a" });
		await vi.waitFor(() => expect(fake.openCalls.length).toBe(1));

		// B supersedes A before A settles.
		const openB = gate<RpcReply>();
		fake.openReplies.push(openB.promise);
		const openedB = navigationOpen({ projectId: "proj", stem: "b" });

		// The server serialized both transitions: A's initial sync arrives first
		// and must commit nothing.
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		expect(getStore().getState().activeSessionId).toBeNull();

		// A's reply fails; a naive rollback would have restored the launcher
		// while B was still in flight.
		openA.open({ id: "x", ok: false, error: "gone" } as unknown as RpcReply);
		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: null, generation: 1 });
		openB.open({ ok: true, session: REF_B } as unknown as RpcReply);

		const result = await openedB;
		expect(result.ok).toBe(true);
		const s = getStore().getState();
		expect(s.currentStem).toBe("b");
		expect(s.activeSessionId).toBe("id-b");
		await openedA;
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
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		expect((await booted).ok).toBe(true);
		// The cache seed painted the store before the wire answered.
		expect(Object.keys(getStore().getState().document.entries)).toEqual(["e0"]);
		expect(currentCacheBase()?.sessionId).toBe("id-a");
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
		expect(fake.openCalls[0]!.cursor).toEqual(cursor);
		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: [DELTA_OP], generation: 1 });
		replyGate.open({ id: "x", ok: true, session: REF_B } as unknown as RpcReply);
		expect((await opened).ok).toBe(true);
		// The promoted candidate document replaced the mirror, and the cache
		// base is the pre-promotion seed.
		expect(fake.applyReplaces.length).toBe(1);
		expect(currentCacheBase()?.sessionId).toBe("id-b");
	});

	it("paints the target's cached prefix on a navigate (the instant switch)", async () => {
		const fake = fakeClient();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: (_projectId, stem) => `id-${stem}`,
			// Only the target has a cached prefix — the committed view being
			// switched from stays the wire's.
			loadSession: async (sessionId) =>
				sessionId === "id-b" ? { records: recordsFor("id-b"), hint: null } : { records: [], hint: null },
		});
		// A committed view to switch from.
		const openedA = navigationOpen({ projectId: "proj", stem: "a" });
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		await openedA;

		// Gate the reply so the seeded paint is observable before the commit.
		const replyGate = gate<RpcReply>();
		fake.openReplies.push(replyGate.promise);
		const openedB = navigationOpen({ projectId: "proj", stem: "b" }, { sessionId: "id-b" });
		await vi.waitFor(() => expect(fake.openCalls.length).toBe(2));
		// The cache paint replaced the previous session's document before the
		// wire answered: the switch reads as immediate, marked seeded.
		const mid = getStore().getState();
		expect(Object.keys(mid.document.entries)).toEqual(["e0"]);
		expect(mid.docAuthority).toBe("seeded");

		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: [DELTA_OP], generation: 1 });
		replyGate.open({ id: "x", ok: true, session: REF_B } as unknown as RpcReply);
		expect((await openedB).ok).toBe(true);
		const s = getStore().getState();
		expect(Object.keys(s.document.entries)).toEqual(["e0"]);
		expect(s.docAuthority).toBe("authoritative");
	});

	it("a failed navigate repaints the previous view's document", async () => {
		const fake = fakeClient();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: (_projectId, stem) => `id-${stem}`,
			loadSession: async (sessionId) => ({ records: recordsFor(sessionId), hint: null }),
		});
		const openedA = navigationOpen({ projectId: "proj", stem: "a" });
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		await openedA;
		const docA = getStore().getState().document;

		const fail = gate<RpcReply>();
		fake.openReplies.push(fail.promise);
		const openedB = navigationOpen({ projectId: "proj", stem: "b" }, { sessionId: "id-b" });
		// The instant-switch paint landed (the store shows the target's seed).
		await vi.waitFor(() => {
			expect(Object.keys(getStore().getState().document.entries)).toEqual(["e0"]);
			expect(getStore().getState().docAuthority).toBe("seeded");
		});
		fail.open({ id: "x", ok: false, error: "no such session" } as unknown as RpcReply);

		expect((await openedB).ok).toBe(false);
		const s = getStore().getState();
		expect(s.currentStem).toBe("a");
		expect(s.activeSessionId).toBe("id-a");
		// The mirror still held the last committed view's root — the paint's
		// snapshot does not survive the failed switch.
		expect(s.document).toBe(docA);
		expect(s.docAuthority).toBe("authoritative");
	});

	it("a re-navigate onto the committed view does not downgrade the live document", async () => {
		const fake = fakeClient();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: () => "id-a",
			loadSession: async () => ({ records: recordsFor("id-a"), hint: null }),
		});
		const openedA = navigationOpen({ projectId: "proj", stem: "a" });
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		await openedA;
		const docA = getStore().getState().document;

		const openedAgain = navigationOpen({ projectId: "proj", stem: "a" }, { sessionId: "id-a" });
		await vi.waitFor(() => expect(fake.openCalls.length).toBe(2));
		// No paint: the committed view's authoritative document stays — a
		// cache snapshot must not replace it.
		const mid = getStore().getState();
		expect(mid.document).toBe(docA);
		expect(mid.docAuthority).toBe("authoritative");

		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		expect((await openedAgain).ok).toBe(true);
		expect(getStore().getState().document).toBe(docA);
	});

	it("commits a creation's initial sync when its operation owns the view", async () => {
		const fake = fakeClient();
		const reply = gate<RpcReply>();
		fake.createReplies.push(reply.promise);
		resetNavigationForTests({ getClient: () => fake.client });
		const created = navigationCreate("proj", "first prompt");
		// The operation id crossed on the request; the server pushes the
		// attributed initial sync before the reply, like the wire does.
		await vi.waitFor(() => expect(fake.createCalls).toHaveLength(1));
		const op = fake.createCalls[0]!.operationId;
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, operationId: op, generation: 1 });
		reply.open({ ok: true, session: REF_A } as unknown as RpcReply);
		expect((await created).ok).toBe(true);
		const s = getStore().getState();
		expect(s.currentStem).toBe("a");
		expect(s.activeSessionId).toBe("id-a");
	});

	it("a creation sync with a stale operation id commits nothing", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		// Commit the Project home, then let a creation's attributed sync arrive
		// for an operation that is no longer the current creation intent.
		await navigationProject("proj", "boot");
		navigationObservation({
			kind: "initial_sync",
			ref: REF_A,
			ops: null,
			operationId: "create-stale",
			generation: 1,
		});
		const s = getStore().getState();
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
	});

	it("a creation reply commits defensively only while it owns the view", async () => {
		const fake = fakeClient();
		const reply = gate<RpcReply>();
		fake.createReplies.push(reply.promise);
		resetNavigationForTests({ getClient: () => fake.client });
		const created = navigationCreate("proj", "first prompt");
		await vi.waitFor(() => expect(fake.createCalls).toHaveLength(1));
		// A newer intent replaces the view before the creation's reply lands.
		const openedB = navigationOpen({ projectId: "proj", stem: "b" });
		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: null, generation: 1 });
		await openedB;
		expect(getStore().getState().currentStem).toBe("b");
		reply.open({ ok: true, session: REF_A } as unknown as RpcReply);
		expect((await created).ok).toBe(true); // the RPC itself succeeded
		// Its settlement committed nothing over the newer view.
		const s = getStore().getState();
		expect(s.currentStem).toBe("b");
		expect(s.activeSessionId).toBe("id-b");
	});

	it("a creation supersedes a pending open: no RPC, nothing commits", async () => {
		const fake = fakeClient();
		const loadA = gate<{ records: CacheEntryRecord[]; hint: null }>();
		resetNavigationForTests({
			getClient: () => fake.client,
			lookupSessionId: () => "id-a",
			loadSession: () => loadA.promise,
		});
		const openedA = navigationOpen({ projectId: "proj", stem: "a" });
		const created = navigationCreate("proj", "first prompt");
		// A's cache read lands after the creation superseded it: no open RPC.
		loadA.open({ records: recordsFor("id-a"), hint: null });
		const superseded = await openedA;
		expect(superseded.superseded).toBe(true);
		expect(fake.openCalls).toHaveLength(0);
		expect((await created).ok).toBe(true);
	});

	it("an abandoned target's late sync commits nothing", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		const openA = gate<RpcReply>();
		const openB = gate<RpcReply>();
		fake.openReplies.push(openA.promise, openB.promise);
		const openedA = navigationOpen({ projectId: "proj", stem: "a" });
		// A's RPC is admitted before B supersedes it.
		await vi.waitFor(() => expect(fake.openCalls.length).toBe(1));
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
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
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
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		expect((await opened).ok).toBe(true);
		const calls = replaceState.mock.calls.filter((c) => c[2] === "/proj/a");
		expect(calls).toHaveLength(0);
		expect(getStore().getState().addressViaAlias).toBe(true);
	});

	it("a Project-scoped alias resolves inside that Project and keeps its URL", async () => {
		const fake = fakeClient();
		const resolveLatest = vi.fn(async () => ({ projectId: "proj", stem: "a", sessionId: "id-a" }) as SessionInfo);
		resetNavigationForTests({ getClient: () => fake.client, resolveLatest });
		const booted = navigationBootLatest("proj");
		await vi.waitFor(() => expect(fake.openCalls.length).toBe(1));
		// The scope reached the resolver, and the resolved address is not written
		// back: the URL keeps the alias form.
		expect(resolveLatest).toHaveBeenCalledWith(fake.client, "proj");
		expect(fake.openCalls[0]).toMatchObject({ projectId: "proj", stem: "a" });
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		expect((await booted).ok).toBe(true);
		expect(replaceState.mock.calls.filter((c) => c[2] === "/proj/a")).toHaveLength(0);
		expect(getStore().getState().addressViaAlias).toBe(true);
	});

	it("a Project-scoped alias press writes the scoped URL", async () => {
		const fake = fakeClient();
		resetNavigationForTests({
			getClient: () => fake.client,
			resolveLatest: async () => ({ projectId: "proj", stem: "a", sessionId: "id-a" }) as SessionInfo,
		});
		const opened = navigationLatest("proj");
		await vi.waitFor(() => expect(routeWritten()).toBe("/proj/@latest"));
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		expect((await opened).ok).toBe(true);
		expect(getStore().getState().addressViaAlias).toBe(true);
	});

	it("a Project-scoped alias with nothing to open lands on that Project home", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client, resolveLatest: async () => null });
		const booted = navigationBootLatest("proj");
		expect((await booted).ok).toBe(true);
		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBeNull();
		expect(s.addressViaAlias).toBe(false);
		expect(routeWritten()).toBe("/proj");
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
		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: null, generation: 1 });
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
		navigationObservation({ kind: "initial_sync", ref: REF_C, ops: null, generation: 1 });
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
		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: [DELTA_OP], generation: 1 });
		replyB.open({ id: "x", ok: true, session: REF_B } as unknown as RpcReply);
		await openedB;
		expect(currentCacheBase()?.sessionId).toBe("id-b");
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
		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: null, generation: 1 });
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
		// Commit a view for A (generation 1), as a real attach would.
		const opened = navigationOpen({ projectId: "proj", stem: "a" });
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		await opened;
		expect(getStore().getState().currentStem).toBe("a");

		// A close of some other address ends nothing here.
		navigationObservation({ kind: "session_closed", projectId: "proj", stem: "other", generation: 1 });
		expect(getStore().getState().currentStem).toBe("a");

		navigationObservation({ kind: "session_closed", projectId: "proj", stem: "a", generation: 1 });
		const s = getStore().getState();
		expect(s.currentProjectId).toBe("proj");
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(routeWritten()).toBe("/proj");
	});

	it("an unattributed re-assert from an older attachment never commits (ADR 19)", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		// Commit a view through a generation-2 sync (a reattach on this socket).
		const opened = navigationOpen({ projectId: "proj", stem: "a" });
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 2 });
		await opened;
		expect(getStore().getState().currentStem).toBe("a");

		// The reactor's committed view is still A, but the rendered address
		// moved on (the store is the observable). A late frame from the
		// superseded attachment (generation 1) names the same address —
		// same-address staleness is exactly what the generation decides.
		resetStore({ currentProjectId: "proj", currentStem: null, activeSessionId: null });
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		await tick();
		expect(getStore().getState().currentStem).toBeNull();

		// The committed attachment's frame still re-asserts.
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 2 });
		await tick();
		expect(getStore().getState().currentStem).toBe("a");
	});

	it("a stale-generation session_closed is ignored (ADR 19)", async () => {
		const fake = fakeClient();
		resetNavigationForTests({ getClient: () => fake.client });
		const opened = navigationOpen({ projectId: "proj", stem: "a" });
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 2 });
		await opened;
		expect(getStore().getState().currentStem).toBe("a");

		// The close of an older attachment — even naming the rendered address —
		// never ends the committed view.
		navigationObservation({ kind: "session_closed", projectId: "proj", stem: "a", generation: 1 });
		await tick();
		expect(getStore().getState().currentStem).toBe("a");

		// The committed attachment's close lands.
		navigationObservation({ kind: "session_closed", projectId: "proj", stem: "a", generation: 2 });
		await tick();
		expect(getStore().getState().currentStem).toBeNull();
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

		navigationObservation({ kind: "session_closed", projectId: "proj", stem: "a", generation: 1 });
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
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
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
		navigationObservation({ kind: "initial_sync", ref: REF_B, ops: null, generation: 1 });
		await first;

		// Open C (fails later); B dies while C is in flight.
		const failC = gate<RpcReply>();
		fake.openReplies.push(failC.promise);
		const openedC = navigationOpen({ projectId: "proj", stem: "c" });
		navigationObservation({ kind: "session_closed", projectId: "proj", stem: "b", generation: 1 });
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
		navigationObservation({ kind: "initial_sync", ref: REF_A, ops: null, generation: 1 });
		await first;

		const result = await navigationProject("proj");
		expect(result.ok).toBe(true);
		const s = getStore().getState();
		expect(s.currentStem).toBeNull();
		expect(s.activeSessionId).toBeNull();
		expect(routeWritten()).toBe("/proj");
	});
});
