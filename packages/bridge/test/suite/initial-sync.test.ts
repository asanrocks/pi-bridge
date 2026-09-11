import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyEvent,
	applyPatch,
	buildInitialSync,
	type CacheEntryRecord,
	CompactCodec,
	computeCursor,
	type Document,
	initFromEntries,
	reconcile,
	seedDocument,
	validateCursor,
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

function assistantEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2024-01-01T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `answer of ${id}` }],
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
}

function labelEntry(id: string, targetId: string): SessionEntry {
	return se("label", { id, targetId, label: "pinned" });
}

/** A canonical Document mid-turn: committed prefix + in-flight provisionals. */
function midTurnDoc(): { doc: Document; piEntries: SessionEntry[] } {
	const committed = [userEntry("a"), userEntry("b", "a")];
	let doc = initFromEntries(committed);
	const userStarted = applyEvent(doc, {
		type: "message_start",
		message: { role: "user", content: "steering note", timestamp: 0 },
	} as AgentSessionEvent);
	if (!userStarted) throw new Error("expected a patch");
	doc = applyPatch(doc, userStarted.ops);
	const assistantStarted = applyEvent(doc, {
		type: "message_start",
		message: { role: "assistant", content: [], api: "anthropic", provider: "anthropic", model: "claude" },
	} as unknown as AgentSessionEvent);
	if (!assistantStarted) throw new Error("expected a patch");
	doc = applyPatch(doc, assistantStarted.ops);

	// pi persists the user message at message_end; the bridge holds it as
	// pending:user:1 until the turn-end reconcile.
	const piEntries = [...committed, userEntry("u3", "b")];
	return { doc, piEntries };
}

function committedRecords(sessionId: string, doc: Document): CacheEntryRecord[] {
	const records: CacheEntryRecord[] = [];
	for (const [id, entry] of Object.entries(doc.entries)) {
		if (id.startsWith("pending:")) continue;
		if (entry.ord === undefined) continue;
		records.push({ sessionId, ord: entry.ord, entryId: id, entry });
	}
	return records.sort((a, b) => a.ord - b.ord);
}

// ---------------------------------------------------------------------------
// validateCursor
// ---------------------------------------------------------------------------

describe("validateCursor", () => {
	const piEntries = [userEntry("a"), userEntry("b"), userEntry("c")];

	it("accepts a matching prefix", () => {
		expect(validateCursor(piEntries, { sessionId: "s", lastKnownId: "b", entryCount: 2 }, "s")).toBe(true);
	});

	it("rejects a wrong session", () => {
		expect(validateCursor(piEntries, { sessionId: "other", lastKnownId: "b", entryCount: 2 }, "s")).toBe(false);
	});

	it("rejects a zero count", () => {
		expect(validateCursor(piEntries, { sessionId: "s", lastKnownId: "a", entryCount: 0 }, "s")).toBe(false);
	});

	it("rejects a count beyond the file", () => {
		expect(validateCursor(piEntries, { sessionId: "s", lastKnownId: "c", entryCount: 4 }, "s")).toBe(false);
	});

	it("rejects a bad anchor", () => {
		expect(validateCursor(piEntries, { sessionId: "s", lastKnownId: "c", entryCount: 2 }, "s")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildInitialSync — full replacement
// ---------------------------------------------------------------------------

describe("buildInitialSync: full replacement", () => {
	it("sends every committed entry with ord, lazy fields null, plus provisionals, status, and scoped models", () => {
		const { doc, piEntries } = midTurnDoc();
		const frame = buildInitialSync(doc, piEntries, "s", null);
		expect(frame.kind).toBe("replace");
		if (frame.kind !== "replace") return;
		expect(frame.sessionId).toBe("s");

		const entries = frame.document.entries;
		expect(entries.a?.ord).toBe(0);
		expect(entries.b?.ord).toBe(1);
		// The committed user message pairs with pending:user:1 — excluded.
		expect(entries.u3).toBeUndefined();
		expect(entries["pending:user:1"]).toBeDefined();
		expect(entries["pending:message"]).toBeDefined();
		expect(frame.document.status).toEqual(doc.status);
		expect(frame.document.scopedModels).toEqual(doc.scopedModels);
	});

	it("keeps prior committed assistant messages when a new turn is in flight", () => {
		// Regression: findProvisional pairs ANY assistant piEntry with the
		// pending:message singleton by existence. Consulting it for entries the
		// Document already holds dropped every previously committed assistant
		// message from a mid-turn replace — and the cache gap it produced
		// degraded every later attach to a replace that still dropped them.
		const settled = [userEntry("a"), assistantEntry("a1", "a"), userEntry("b", "a1")];
		let doc = initFromEntries(settled);
		// A real turn: the user message starts the turn (pending:user:1, committed
		// in the file at message_end), then the assistant reply streams.
		const userStarted = applyEvent(doc, {
			type: "message_start",
			message: { role: "user", content: "next question", timestamp: 0 },
		} as unknown as AgentSessionEvent);
		if (!userStarted) throw new Error("expected a patch");
		doc = applyPatch(doc, userStarted.ops);
		const started = applyEvent(doc, {
			type: "message_start",
			message: { role: "assistant", content: [], api: "anthropic", provider: "anthropic", model: "claude" },
		} as unknown as AgentSessionEvent);
		if (!started) throw new Error("expected a patch");
		doc = applyPatch(doc, started.ops);
		expect(doc.entries["pending:message"]).toBeDefined();

		// The current turn's user message is committed in the file mid-turn.
		const piEntries = [...settled, userEntry("u3", "b")];
		const frame = buildInitialSync(doc, piEntries, "s", null);
		if (frame.kind !== "replace") throw new Error("expected replace");
		expect(frame.document.entries.a1?.ord).toBe(1);
		expect(frame.document.entries.b?.ord).toBe(2);
		expect(frame.document.entries.u3).toBeUndefined();
		expect(frame.document.entries["pending:message"]).toBeDefined();
	});

	it("includes silently-appended entries the canonical Document does not know yet", () => {
		const doc = initFromEntries([userEntry("a")]);
		const piEntries = [userEntry("a"), labelEntry("silent", "a"), userEntry("c", "silent")];
		const frame = buildInitialSync(doc, piEntries, "s", null);
		if (frame.kind !== "replace") throw new Error("expected replace");
		expect(frame.document.entries.silent?.ord).toBe(1);
		expect(frame.document.entries.c?.ord).toBe(2);
	});

	it("strips lazy values from committed content", () => {
		const doc = initFromEntries([
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoning", timestamp: 0 },
						{ type: "text", text: "answer", timestamp: 0 },
					],
					api: "anthropic",
					provider: "anthropic",
					model: "claude",
					stopReason: "stop",
					timestamp: 0,
				},
			} as unknown as SessionEntry,
		]);
		const frame = buildInitialSync(doc, [se("message", { id: "a1", role: "assistant" })], "s", null);
		if (frame.kind !== "replace") throw new Error("expected replace");
		const content = frame.document.entries.a1 as unknown as { content: Array<Record<string, unknown>> };
		expect(content.content[0]?.thinking).toBeNull();
		expect(content.content[1]?.text).toBe("answer");
	});

	it("falls back to replace when the cursor is invalid", () => {
		const { doc, piEntries } = midTurnDoc();
		const frame = buildInitialSync(doc, piEntries, "s", {
			sessionId: "s",
			lastKnownId: "wrong-anchor",
			entryCount: 2,
		});
		expect(frame.kind).toBe("replace");
	});
});

// ---------------------------------------------------------------------------
// buildInitialSync — delta patch
// ---------------------------------------------------------------------------

describe("buildInitialSync: delta patch", () => {
	function settledFixture() {
		// Committed conversation in both the Document and the file, with a
		// suffix beyond a two-entry cached prefix.
		const piEntries = [userEntry("a"), userEntry("b", "a"), labelEntry("l1", "b"), userEntry("c", "l1")];
		const doc = initFromEntries([userEntry("a"), userEntry("b", "a")]);
		const sealed = reconcile(doc, piEntries);
		return sealed ? applyPatch(doc, sealed.ops) : doc;
	}

	it("sends only the committed suffix plus status and scoped models", () => {
		const doc = settledFixture();
		const piEntries = [userEntry("a"), userEntry("b", "a"), labelEntry("l1", "b"), userEntry("c", "l1")];
		const frame = buildInitialSync(doc, piEntries, "s", { sessionId: "s", lastKnownId: "b", entryCount: 2 });
		expect(frame.kind).toBe("patch");
		if (frame.kind !== "patch") return;
		expect(frame.sessionId).toBe("s");

		const addPaths = frame.ops.filter((o) => o.op === "add").map((o) => o.path);
		expect(addPaths).toEqual(["/entries/l1", "/entries/c"]);
		// Adds carry their ord.
		const cAdd = frame.ops.find((o) => o.path === "/entries/c");
		expect(cAdd && "value" in cAdd ? (cAdd.value as { ord?: number }).ord : undefined).toBe(3);
		// Complete status and scoped models, unconditionally.
		expect(frame.ops).toContainEqual({ op: "replace", path: "/status", value: doc.status });
		expect(frame.ops).toContainEqual({ op: "replace", path: "/scopedModels", value: doc.scopedModels });
	});

	it("includes provisional skeletons during a mid-turn reconnect", () => {
		const { doc, piEntries } = midTurnDoc();
		const frame = buildInitialSync(doc, piEntries, "s", { sessionId: "s", lastKnownId: "b", entryCount: 2 });
		expect(frame.kind).toBe("patch");
		if (frame.kind !== "patch") return;
		const addPaths = frame.ops.filter((o) => o.op === "add").map((o) => o.path);
		// The committed u3 pairs with pending:user:1 — the provisional is sent,
		// not the committed entry.
		expect(addPaths).toContain("/entries/pending:user:1");
		expect(addPaths).toContain("/entries/pending:message");
		expect(addPaths).not.toContain("/entries/u3");
	});

	it("is never a compact single-append frame", () => {
		const doc = initFromEntries([userEntry("a")]);
		const piEntries = [userEntry("a")];
		// Cursor covers the whole file: no committed adds, no provisionals —
		// still two unconditional replaces.
		const frame = buildInitialSync(doc, piEntries, "s", { sessionId: "s", lastKnownId: "a", entryCount: 1 });
		if (frame.kind !== "patch") throw new Error("expected patch");
		expect(frame.ops.length).toBeGreaterThanOrEqual(2);
		expect(frame.ops.every((o) => o.op === "append")).toBe(false);
	});

	it("resets CompactCodec state in both frame forms", () => {
		const codec = new CompactCodec();
		const { doc, piEntries } = midTurnDoc();
		const delta = buildInitialSync(doc, piEntries, "s", { sessionId: "s", lastKnownId: "b", entryCount: 2 });
		const decodedDelta = codec.decodeIncoming(codec.encodeOutgoing(delta as unknown as Record<string, unknown>));
		expect(decodedDelta).toEqual(delta);
		// Codec state was reset: a compact bare-string frame has no remembered
		// path to restore.
		expect(() => codec.decodeIncoming(JSON.stringify("x"))).toThrow();

		const replaceFrame = buildInitialSync(doc, piEntries, "s", null);
		const decodedReplace = codec.decodeIncoming(
			codec.encodeOutgoing(replaceFrame as unknown as Record<string, unknown>),
		);
		expect(decodedReplace).toEqual(replaceFrame);
		expect(() => codec.decodeIncoming(JSON.stringify("x"))).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Convergence: cache seed + delta == full snapshot
// ---------------------------------------------------------------------------

describe("initial sync convergence", () => {
	it("seeded cache plus delta converges to the full initial-sync projection", () => {
		const piEntries = [userEntry("a"), userEntry("b", "a"), labelEntry("l1", "b"), userEntry("c", "l1")];
		const doc = initFromEntries(piEntries);

		const full = buildInitialSync(doc, piEntries, "s", null);
		if (full.kind !== "replace") throw new Error("expected replace");

		// Simulate a client that cached only the first two entries.
		const records = committedRecords("s", full.document).filter((r) => r.ord < 2);
		const cursor = computeCursor(records);
		expect(cursor).toEqual({ sessionId: "s", lastKnownId: "b", entryCount: 2 });

		const delta = buildInitialSync(doc, piEntries, "s", cursor);
		if (delta.kind !== "patch") throw new Error("expected patch");

		const seeded = seedDocument(records);
		const result = applyPatch(seeded, delta.ops);
		expect(result).toEqual(full.document);
	});

	it("converges mid-turn with a committed assistant in the cached prefix", () => {
		// Regression companion of the dropped-assistant bug: the cached
		// prefix contains an assistant message and a new turn is in flight.
		// The full snapshot must keep the assistant, or the cached ords get a
		// gap and the cursor degrades on every attach.
		const settled = [userEntry("a"), assistantEntry("a1", "a"), userEntry("b", "a1")];
		let doc = initFromEntries(settled);
		const userStarted = applyEvent(doc, {
			type: "message_start",
			message: { role: "user", content: "next question", timestamp: 0 },
		} as unknown as AgentSessionEvent);
		if (!userStarted) throw new Error("expected a patch");
		doc = applyPatch(doc, userStarted.ops);
		const started = applyEvent(doc, {
			type: "message_start",
			message: { role: "assistant", content: [], api: "anthropic", provider: "anthropic", model: "claude" },
		} as unknown as AgentSessionEvent);
		if (!started) throw new Error("expected a patch");
		doc = applyPatch(doc, started.ops);
		const piEntries = [...settled, userEntry("u3", "b")];

		const full = buildInitialSync(doc, piEntries, "s", null);
		if (full.kind !== "replace") throw new Error("expected replace");
		expect(full.document.entries.a1?.ord).toBe(1);

		const records = committedRecords("s", full.document);
		expect(records.map((r) => r.entryId)).toEqual(["a", "a1", "b"]);
		const cursor = computeCursor(records);
		expect(cursor).toEqual({ sessionId: "s", lastKnownId: "b", entryCount: 3 });

		const delta = buildInitialSync(doc, piEntries, "s", cursor);
		if (delta.kind !== "patch") throw new Error("expected patch");
		const seeded = seedDocument(records);
		expect(applyPatch(seeded, delta.ops)).toEqual(full.document);
	});

	it("delta merge is idempotent", () => {
		const piEntries = [userEntry("a"), userEntry("b", "a"), labelEntry("l1", "b"), userEntry("c", "l1")];
		const doc = initFromEntries(piEntries);
		const delta = buildInitialSync(doc, piEntries, "s", { sessionId: "s", lastKnownId: "b", entryCount: 2 });
		if (delta.kind !== "patch") throw new Error("expected patch");

		const seeded = seedDocument(committedRecords("s", doc).filter((r) => r.ord < 2));
		const once = applyPatch(seeded, delta.ops);
		// Re-delivery (e.g. client retry) is a no-op: adds are overwrite-shaped.
		const twice = applyPatch(once, delta.ops);
		expect(twice).toEqual(once);
	});

	it("settles the in-flight turn and keeps cached ords contiguous", () => {
		const { doc, piEntries } = midTurnDoc();
		// Attach mid-turn: u3 is excluded (paired), so cached records are
		// a(0), b(1) — contiguous, cursor valid. After the turn settles, the
		// seal assigns u3 ord 2 and the next snapshot's records stay contiguous.
		const settled = reconcile(doc, [...piEntries, userEntry("c4", "u3")]);
		const doc2 = settled ? applyPatch(doc, settled.ops) : doc;
		const full = buildInitialSync(doc2, [...piEntries, userEntry("c4", "u3")], "s", null);
		if (full.kind !== "replace") throw new Error("expected replace");

		const records = committedRecords("s", full.document);
		expect(records.map((r) => r.entryId)).toEqual(["a", "b", "u3", "c4"]);
		const cursor = computeCursor(records);
		expect(cursor?.entryCount).toBe(4);
	});
});
