// ADR 09 stage-5 tests: client cache plumbing that is testable without a
// DOM — the in-memory EntryCacheStore (policy-facing storage semantics), the
// document→record helpers, and the candidate-mirror registry. The IndexedDB
// adapter (web/src/infra/persist/entryCache.ts) uses DOM types and is checked by
// web/tsconfig only.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyPatch,
	type CacheEntryRecord,
	cacheRecordsOfDocument,
	computeCursor,
	type Document,
	type EntryCacheStore,
	InMemoryEntryCacheStore,
	initFromEntries,
	planCacheWrites,
	seedDocument,
	statusHintOfDocument,
} from "../../src/core/index.ts";
import {
	beginSessionCandidate,
	discardSessionCandidate,
	promoteSessionCandidate,
	sessionCandidatePending,
} from "../../web/src/infra/net/sessionCandidate.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function userEntry(id: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2024-01-01T00:00:00Z",
		message: { role: "user", content: `text of ${id}`, timestamp: 0 },
	} as SessionEntry;
}

function docOf(entries: SessionEntry[]): Document {
	return initFromEntries(entries);
}

function recordsOf(sessionId: string, doc: Document): CacheEntryRecord[] {
	return cacheRecordsOfDocument(sessionId, doc);
}

// ---------------------------------------------------------------------------
// InMemoryEntryCacheStore
// ---------------------------------------------------------------------------

describe("InMemoryEntryCacheStore", () => {
	it("returns empty for an unknown session", async () => {
		const store = new InMemoryEntryCacheStore();
		const { records, hint } = await store.loadSession("s");
		expect(records).toEqual([]);
		expect(hint).toBeNull();
	});

	it("persists delta writes and keeps sessions isolated", async () => {
		const store = new InMemoryEntryCacheStore();
		const docA = docOf([userEntry("a1"), userEntry("a2", "a1")]);
		const docB = docOf([userEntry("b1")]);
		await store.writeEntries("A", recordsOf("A", docA));
		await store.writeEntries("B", recordsOf("B", docB));

		const a = await store.loadSession("A");
		const b = await store.loadSession("B");
		expect(a.records.map((r) => r.entryId)).toEqual(["a1", "a2"]);
		expect(b.records.map((r) => r.entryId)).toEqual(["b1"]);
	});

	it("replaceSession removes stale records beyond the new set", async () => {
		const store = new InMemoryEntryCacheStore();
		await store.writeEntries("s", recordsOf("s", docOf([userEntry("a"), userEntry("b", "a")])));

		// Server rewrote the session to just one entry.
		await store.replaceSession("s", recordsOf("s", docOf([userEntry("a")])));
		const { records } = await store.loadSession("s");
		expect(records.map((r) => r.entryId)).toEqual(["a"]);
	});

	it("stores the status hint last-write-wins", async () => {
		const store = new InMemoryEntryCacheStore();
		const doc = docOf([userEntry("a")]);
		await store.writeEntries("s", recordsOf("s", doc), statusHintOfDocument(doc));
		const first = await store.loadSession("s");
		expect(first.hint).not.toBeNull();

		const renamed = { ...doc, status: { ...doc.status, name: "renamed" } };
		await store.writeEntries("s", [], statusHintOfDocument(renamed));
		const second = await store.loadSession("s");
		expect(second.hint?.name).toBe("renamed");
		expect(second.records.length).toBe(1); // entries untouched
	});

	it("satisfies the EntryCacheStore interface contract", () => {
		const store: EntryCacheStore = new InMemoryEntryCacheStore();
		expect(typeof store.loadSession).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

describe("cacheRecordsOfDocument / statusHintOfDocument", () => {
	it("projects only committed ord-bearing entries, in ord order", () => {
		const base = docOf([userEntry("a"), userEntry("b", "a")]);
		// A pending entry (no ord) and a committed entry without ord.
		const withPending = applyPatch(base, [
			{
				op: "add",
				path: "/entries/pending:message",
				value: {
					kind: "message",
					id: "pending:message",
					parentId: "b",
					timestamp: "",
					role: "assistant",
					content: [],
				},
			},
		]);
		const records = recordsOf("s", withPending);
		expect(records.map((r) => r.entryId)).toEqual(["a", "b"]);
		expect(records[0].entry.ord).toBe(0);
	});

	it("hint carries the paint fields, not stats", () => {
		const doc = docOf([userEntry("a")]);
		const hint = statusHintOfDocument(doc);
		expect(hint).toEqual({
			name: doc.status.name,
			model: doc.status.model,
			thinkingLevel: doc.status.thinkingLevel,
			contextUsage: doc.status.contextUsage,
		});
		expect("stats" in (hint as Record<string, unknown>)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Candidate mirror registry
// ---------------------------------------------------------------------------

describe("sessionCandidate", () => {
	it("tracks a pending candidate and promotes on matching delta", () => {
		const base = seedDocument(recordsOf("s2", docOf([userEntry("a")])));
		beginSessionCandidate("s2", base);
		expect(sessionCandidatePending()).toBe(true);

		const promoted = promoteSessionCandidate("s2", [
			{
				op: "add",
				path: "/entries/new",
				value: { kind: "message", id: "new", parentId: "a", timestamp: "t", role: "user", content: [] },
			},
		]);
		expect(promoted).not.toBeNull();
		expect(promoted?.doc.entries.new).toBeDefined();
		// `before` is the pre-promotion seed — the cache-write base.
		expect(promoted?.before.entries.new).toBeUndefined();
		// Promotion clears the candidate — a second switch may start.
		expect(sessionCandidatePending()).toBe(false);
		expect(promoteSessionCandidate("s2", [])).toBeNull();
	});

	it("does not promote on a session mismatch — the candidate survives", () => {
		beginSessionCandidate("s2", seedDocument([]));
		expect(promoteSessionCandidate("other", [])).toBeNull();
		expect(sessionCandidatePending()).toBe(true);
		discardSessionCandidate();
		expect(sessionCandidatePending()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Client-restore convergence: store → seed → candidate promote == full doc
// ---------------------------------------------------------------------------

describe("client restore convergence", () => {
	it("cache + candidate promotion converges to the full document", async () => {
		const full = docOf([userEntry("a"), userEntry("b", "a"), userEntry("c", "b")]);
		const store = new InMemoryEntryCacheStore();

		// First visit: write-through the full document, then simulate a later
		// visit that cached only the first two entries.
		const records = recordsOf("s", full).filter((r) => r.ord < 2);
		await store.writeEntries("s", records, statusHintOfDocument(full));

		const { records: loaded, hint } = await store.loadSession("s");
		const cursor = computeCursor(loaded);
		expect(cursor).toEqual({ sessionId: "s", lastKnownId: "b", entryCount: 2 });

		// prepareSwitch equivalent: seed the candidate.
		const candidate = seedDocument(loaded, hint ?? undefined);
		beginSessionCandidate("s", candidate);

		// The server's delta for the missing suffix + current status.
		const promoted = promoteSessionCandidate("s", [
			{ op: "add", path: "/entries/c", value: { ...full.entries.c } as never },
			{ op: "replace", path: "/status", value: full.status as never },
		]);
		expect(promoted).not.toBeNull();

		// Everything but lazy fields (none here) matches the full document.
		expect(promoted?.doc).toEqual(full);
	});

	it("planCacheWrites from the promoted document persists the new suffix", async () => {
		const store = new InMemoryEntryCacheStore();
		const before = seedDocument(recordsOf("s", docOf([userEntry("a")])));
		await store.writeEntries("s", cacheRecordsOfDocument("s", before));

		const after = applyPatch(before, [
			{
				op: "add",
				path: "/entries/b",
				value: { ...docOf([userEntry("b")]).entries.b, ord: 1, parentId: "a" } as never,
			},
		]);
		const writes = planCacheWrites("s", before, after);
		await store.writeEntries("s", writes);

		const { records } = await store.loadSession("s");
		expect(records.map((r) => r.entryId)).toEqual(["a", "b"]);
	});

	it("planning against another session's document rewrites everything — the base must match the session", () => {
		// Regression (log2): the flush used the store's previous document as
		// the `before` for planCacheWrites. On a session switch that is the OLD
		// session's document — zero shared references — so a 2-op delta flushed
		// full-session writes. The base must be the target session's
		// cache-derived seed (promoted.before), not the store's document.
		const cached = seedDocument(recordsOf("s2", docOf([userEntry("a"), userEntry("b", "a")])));
		const promoted = applyPatch(cached, [{ op: "replace", path: "/status", value: cached.status as never }]);

		// Correct base: the candidate seed — a status-only delta writes nothing.
		expect(planCacheWrites("s2", cached, promoted)).toEqual([]);

		// Wrong base (the old session's document): every entry looks new.
		const oldSession = seedDocument(recordsOf("s1", docOf([userEntry("x")])));
		expect(planCacheWrites("s2", oldSession, promoted)).toHaveLength(2);
	});
});
