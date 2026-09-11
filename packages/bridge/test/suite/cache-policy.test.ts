import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectEntry } from "../../src/core/document.ts";
import {
	applyEvent,
	applyPatch,
	type CacheEntryRecord,
	computeCursor,
	type Entry,
	initFromEntries,
	planCacheWrites,
	projectCacheEntry,
	reconcile,
	seedDocument,
} from "../../src/core/index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function se(type: string, overrides: Record<string, unknown> = {}): SessionEntry {
	if (type === "message") {
		return {
			type: "message",
			id: (overrides.id as string) ?? "m1",
			parentId: (overrides.parentId as string) ?? null,
			timestamp: (overrides.timestamp as string) ?? "2024-01-01T00:00:00Z",
			message: {
				role: (overrides.role as string) ?? "user",
				content: (overrides.content as string) ?? "hello",
				timestamp: 0,
			},
		} as SessionEntry;
	}
	return {
		type,
		id: (overrides.id as string) ?? "e1",
		parentId: (overrides.parentId as string) ?? null,
		timestamp: (overrides.timestamp as string) ?? "2024-01-01T00:00:00Z",
		...overrides,
	} as unknown as SessionEntry;
}

function userEntry(id: string, parentId: string | null = null): SessionEntry {
	return se("message", { id, parentId, role: "user", content: `text of ${id}` });
}

function record(sessionId: string, ord: number, entryId: string): CacheEntryRecord {
	return {
		sessionId,
		ord,
		entryId,
		entry: initFromEntries([userEntry(entryId)]).entries[entryId] as Entry,
	};
}

// ---------------------------------------------------------------------------
// computeCursor
// ---------------------------------------------------------------------------

describe("computeCursor", () => {
	it("derives a cursor from a contiguous 0..n-1 prefix", () => {
		const cursor = computeCursor([record("s", 0, "a"), record("s", 1, "b"), record("s", 2, "c")]);
		expect(cursor).toEqual({ sessionId: "s", lastKnownId: "c", entryCount: 3 });
	});

	it("accepts a single record", () => {
		expect(computeCursor([record("s", 0, "a")])).toEqual({
			sessionId: "s",
			lastKnownId: "a",
			entryCount: 1,
		});
	});

	it("rejects empty records", () => {
		expect(computeCursor([])).toBeNull();
	});

	it("rejects a gap", () => {
		expect(computeCursor([record("s", 0, "a"), record("s", 2, "c")])).toBeNull();
	});

	it("rejects duplicates", () => {
		expect(computeCursor([record("s", 0, "a"), record("s", 0, "a2")])).toBeNull();
	});

	it("rejects mixed sessions", () => {
		expect(computeCursor([record("s1", 0, "a"), record("s2", 1, "b")])).toBeNull();
	});

	it("rejects a non-integer or negative ord", () => {
		expect(computeCursor([{ ...record("s", 0, "a"), ord: 1.5 }])).toBeNull();
		expect(computeCursor([{ ...record("s", 0, "a"), ord: -1 }])).toBeNull();
	});

	it("rejects a non-contiguous start", () => {
		expect(computeCursor([record("s", 1, "a"), record("s", 2, "b")])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// projectCacheEntry
// ---------------------------------------------------------------------------

describe("projectCacheEntry", () => {
	it("strips all lazy values but keeps wire-eager content and ord", () => {
		const doc = initFromEntries([
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "secret reasoning", timestamp: 0 },
						{ type: "text", text: "answer", timestamp: 0 },
						{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" }, timestamp: 0 },
					],
					api: "anthropic",
					provider: "anthropic",
					model: "claude",
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 0,
				},
			} as unknown as SessionEntry,
		]);
		const entry = doc.entries.a1 as unknown as { ord?: number; content: Array<Record<string, unknown>> };
		expect(entry.ord).toBe(0);

		const cached = projectCacheEntry(doc.entries.a1 as Entry);
		const c = cached as unknown as { content: Array<Record<string, unknown>>; ord?: number };
		expect(c.content[0]?.thinking).toBeNull();
		expect(c.content[1]?.text).toBe("answer");
		expect(c.content[2]?.arguments).toBeNull();
		expect(c.ord).toBe(0);
	});

	it("strips tool result content and details", () => {
		const doc = initFromEntries([
			{
				type: "message",
				id: "t1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				message: {
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "output" }],
					details: { exitCode: 0 },
					isError: false,
					timestamp: 0,
				},
			} as unknown as SessionEntry,
		]);
		const cached = projectCacheEntry(doc.entries.t1 as Entry) as unknown as Record<string, unknown>;
		expect(cached.content).toBeNull();
		expect(cached.details).toBeNull();
		expect(cached.isError).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// planCacheWrites
// ---------------------------------------------------------------------------

describe("planCacheWrites", () => {
	it("produces no writes for an unchanged document", () => {
		const doc = initFromEntries([userEntry("a"), userEntry("b")]);
		expect(planCacheWrites("s", doc, doc)).toEqual([]);
	});

	it("writes changed and new committed entries with ord, in ord order", () => {
		const before = initFromEntries([userEntry("a"), userEntry("b")]);
		// Seal a new user message: applyEvent creates the provisional,
		// reconcile seals it with ord 2.
		let after = before;
		const started = applyEvent(after, {
			type: "message_start",
			message: { role: "user", content: "hi", timestamp: 0 },
		} as unknown as AgentSessionEvent);
		if (!started) throw new Error("expected a patch");
		after = applyPatch(after, started.ops);
		const sealed = reconcile(after, [userEntry("a"), userEntry("b"), userEntry("c")]);
		if (!sealed) throw new Error("expected a patch");
		after = applyPatch(after, sealed.ops);

		const writes = planCacheWrites("s", before, after);
		expect(writes.map((w) => w.entryId)).toEqual(["c"]);
		expect(writes[0]?.ord).toBe(2);
		expect(writes[0]?.sessionId).toBe("s");
		// The write is already cache-projected (lazy-stripped).
		expect((writes[0]?.entry as unknown as Record<string, unknown>).ord).toBe(2);
	});

	it("excludes provisional entries", () => {
		const before = initFromEntries([]);
		const started = applyEvent(before, {
			type: "message_start",
			message: { role: "user", content: "hi", timestamp: 0 },
		} as unknown as AgentSessionEvent);
		if (!started) throw new Error("expected a patch");
		const after = applyPatch(before, started.ops);
		expect(after.entries["pending:user:1"]).toBeDefined();
		expect(planCacheWrites("s", before, after)).toEqual([]);
	});

	it("excludes committed entries without ord", () => {
		const before = initFromEntries([]);
		const appended = applyEvent(before, {
			type: "entry_appended",
			entry: userEntry("x"),
		} as unknown as AgentSessionEvent);
		if (!appended) throw new Error("expected a patch");
		const after = applyPatch(before, appended.ops);
		expect(after.entries.x).toBeDefined();
		expect((after.entries.x as { ord?: number }).ord).toBeUndefined();
		expect(planCacheWrites("s", before, after)).toEqual([]);
	});

	it("a lazy-field pull (reference change, identical projection) produces no write", () => {
		// Regression (log3): pull replies fill lazy fields via replace ops on
		// lazy paths; the entry reference changes but projectCacheEntry strips
		// those fields, so the cached record is byte-identical. A 408-request
		// pull wave once rewrote 393 identical records.
		const doc = initFromEntries([
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: null, timestamp: 0 }],
					api: "anthropic",
					provider: "anthropic",
					model: "claude",
					stopReason: "stop",
					timestamp: 0,
				},
			} as unknown as SessionEntry,
		]);
		const after = applyPatch(doc, [
			{ op: "replace", path: "/entries/a1/content/0/thinking", value: "pulled reasoning" as never },
		]);
		expect(after.entries.a1).not.toBe(doc.entries.a1); // reference changed
		expect(planCacheWrites("s", doc, after)).toEqual([]); // projection identical
	});
});

// ---------------------------------------------------------------------------
// Projection determinism: sealed streaming entry vs file projection
// ---------------------------------------------------------------------------

describe("cache determinism", () => {
	it("a sealed streaming entry projects identically to the file entry", () => {
		// Multi-tab invariant: a tab that lived through the turn caches the
		// streaming-derived sealed entry; a fresh attach caches the file
		// projection. Both must produce the same cache record at (sessionId, ord).
		let doc = initFromEntries([]);
		const events: Array<Record<string, unknown>> = [
			{ type: "message_start", message: { role: "user", content: "question", timestamp: 0 } },
			{
				type: "message_start",
				message: { role: "assistant", content: [], api: "anthropic", provider: "anthropic", model: "claude" },
			},
			{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ans" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "answer" } },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					api: "anthropic",
					provider: "anthropic",
					model: "claude",
					stopReason: "stop",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 0,
				},
			},
		];
		for (const event of events) {
			const patch = applyEvent(doc, event as unknown as AgentSessionEvent);
			if (patch) doc = applyPatch(doc, patch.ops);
		}

		const userFile: SessionEntry = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2024-01-01T00:00:00Z",
			message: { role: "user", content: "question", timestamp: 0 },
		} as SessionEntry;
		const assistantFile: SessionEntry = {
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2024-01-01T00:00:01Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: "anthropic",
				provider: "anthropic",
				model: "claude",
				stopReason: "stop",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 0,
			},
		} as unknown as SessionEntry;

		const sealed = reconcile(doc, [userFile, assistantFile]);
		if (!sealed) throw new Error("expected a patch");
		doc = applyPatch(doc, sealed.ops);

		expect(doc.entries.a1).toBeDefined();
		expect(doc.entries.u1).toBeDefined();
		const fromStream = projectCacheEntry(doc.entries.a1 as Entry);
		const fromFile = { ...projectCacheEntry(projectEntry(assistantFile)), ord: 1 };
		expect(fromStream).toEqual(fromFile);
	});
});

// ---------------------------------------------------------------------------
// seedDocument
// ---------------------------------------------------------------------------

describe("seedDocument", () => {
	it("seeds entries in ord order with derived status", () => {
		const name = se("session_info", { id: "n1", name: "my session" });
		const records: CacheEntryRecord[] = [
			record("s", 1, "b"),
			{ ...record("s", 0, "a"), entry: initFromEntries([name, userEntry("a")]).entries.a as Entry },
			{
				...record("s", 2, "n1"),
				entry: initFromEntries([name, userEntry("a")]).entries.n1 as Entry,
			},
		];
		const doc = seedDocument(records);
		expect(Object.keys(doc.entries)).toEqual(["a", "b", "n1"]);
		expect(doc.status.leafId).toBe("n1");
		expect(doc.status.name).toBe("my session");
		expect(doc.scopedModels).toEqual([]);
	});

	it("overlays the status hint without letting undefined fields regress derived values", () => {
		const records = [record("s", 0, "a"), record("s", 1, "b")];
		const derived = seedDocument(records);
		const hinted = seedDocument(records, {
			leafId: "a",
			model: { provider: "anthropic", modelId: "claude" },
			name: undefined,
		});
		expect(hinted.status.leafId).toBe("a");
		expect(hinted.status.model).toEqual({ provider: "anthropic", modelId: "claude" });
		expect(hinted.status.name).toBe(derived.status.name);
	});
});
