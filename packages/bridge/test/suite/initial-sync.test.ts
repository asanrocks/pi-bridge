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
	isEntrySealed,
	type SessionRef,
	seedDocument,
	validateCursor,
} from "../../src/core/index.ts";
import { createDriver, type ProjectionDriver } from "./projection-driver.ts";

/** Synthetic session address for the initial-sync frames. */
const REF: SessionRef = { projectId: "p", sessionId: "s", stem: "2026-01-01_s" };

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

function emptyDoc(): Document {
	return {
		status: {
			leafId: null,
			name: "",
			model: { provider: "", modelId: "" },
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			stats: { tokens: { input: 0, output: 0, total: 0 }, cost: { total: 0 }, messages: 0 },
			contextUsage: null,
			pendingSteer: [],
		},
		entries: {},
	};
}

/** A canonical Document mid-turn: committed prefix plus the live forms of the
 * entries the turn is streaming under the ids pi reserved for them. */
function midTurnDoc(): { doc: Document; piEntries: SessionEntry[]; driver: ProjectionDriver } {
	const committed = [userEntry("a"), userEntry("b", "a")];
	const driver = createDriver(emptyDoc());
	if (!driver.refresh(committed)) throw new Error("expected a bootstrap patch");
	const userStarted = driver.applyEvent({
		type: "message_start",
		entryId: "u3",
		message: { role: "user", content: "steering note", timestamp: 0 },
	} as unknown as AgentSessionEvent);
	if (!userStarted) throw new Error("expected a patch");
	const assistantStarted = driver.applyEvent({
		type: "message_start",
		entryId: "a2",
		message: { role: "assistant", content: [], api: "anthropic", provider: "anthropic", model: "claude" },
	} as unknown as AgentSessionEvent);
	if (!assistantStarted) throw new Error("expected a patch");

	// pi persists the user message at message_end, under the id it streamed as.
	const piEntries = [...committed, userEntry("u3", "b")];
	return { doc: driver.document, piEntries, driver };
}

function committedRecords(sessionId: string, doc: Document): CacheEntryRecord[] {
	const records: CacheEntryRecord[] = [];
	for (const [id, entry] of Object.entries(doc.entries)) {
		if (!isEntrySealed(entry)) continue;
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
	it("sends every committed entry with ord, lazy fields null, plus live forms, status, and scoped models", () => {
		const { doc, piEntries } = midTurnDoc();
		const frame = buildInitialSync(doc, piEntries, REF, null);
		expect(frame.kind).toBe("replace");
		if (frame.kind !== "replace") return;
		expect(frame.session?.sessionId).toBe("s");

		const entries = frame.document.entries;
		expect(entries.a?.ord).toBe(0);
		expect(entries.b?.ord).toBe(1);
		// The committed user message travels as its persisted form; the
		// assistant is still live, under the id it will keep.
		expect(entries.u3?.ord).toBe(2);
		expect(entries.a2).toBeDefined();
		expect(isEntrySealed(entries.a2!)).toBe(false);
		expect(frame.document.status).toEqual(doc.status);
	});

	it("keeps prior committed assistant messages when a new turn is in flight", () => {
		// A mid-turn replace must never drop an earlier committed assistant
		// message: the live form of the current reply is a different identity.
		const settled = [userEntry("a"), assistantEntry("a1", "a"), userEntry("b", "a1")];
		let doc = initFromEntries(settled);
		const userStarted = applyEvent(doc, {
			type: "message_start",
			entryId: "u3",
			message: { role: "user", content: "next question", timestamp: 0 },
		} as unknown as AgentSessionEvent);
		if (!userStarted) throw new Error("expected a patch");
		doc = applyPatch(doc, userStarted.ops);
		const started = applyEvent(doc, {
			type: "message_start",
			entryId: "a2",
			message: { role: "assistant", content: [], api: "anthropic", provider: "anthropic", model: "claude" },
		} as unknown as AgentSessionEvent);
		if (!started) throw new Error("expected a patch");
		doc = applyPatch(doc, started.ops);
		expect(doc.entries.a2).toBeDefined();

		// The current turn's user message is committed in the file mid-turn.
		const piEntries = [...settled, userEntry("u3", "b")];
		const frame = buildInitialSync(doc, piEntries, REF, null);
		if (frame.kind !== "replace") throw new Error("expected replace");
		expect(frame.document.entries.a1?.ord).toBe(1);
		expect(frame.document.entries.b?.ord).toBe(2);
		expect(frame.document.entries.u3?.ord).toBe(3);
		expect(frame.document.entries.a2).toBeDefined();
		expect(isEntrySealed(frame.document.entries.a2!)).toBe(false);
	});

	it("includes silently-appended entries the canonical Document does not know yet", () => {
		const doc = initFromEntries([userEntry("a")]);
		const piEntries = [userEntry("a"), labelEntry("silent", "a"), userEntry("c", "silent")];
		const frame = buildInitialSync(doc, piEntries, REF, null);
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
		const frame = buildInitialSync(doc, [se("message", { id: "a1", role: "assistant" })], REF, null);
		if (frame.kind !== "replace") throw new Error("expected replace");
		const content = frame.document.entries.a1 as unknown as { content: Array<Record<string, unknown>> };
		expect(content.content[0]?.thinking).toBeNull();
		expect(content.content[1]?.text).toBe("answer");
	});

	it("falls back to replace when the cursor is invalid", () => {
		const { doc, piEntries } = midTurnDoc();
		const frame = buildInitialSync(doc, piEntries, REF, {
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
		const driver = createDriver(emptyDoc());
		driver.refresh(piEntries.slice(0, 2));
		driver.refresh(piEntries);
		return driver.document;
	}

	it("sends only the committed suffix plus status and scoped models", () => {
		const doc = settledFixture();
		const piEntries = [userEntry("a"), userEntry("b", "a"), labelEntry("l1", "b"), userEntry("c", "l1")];
		const frame = buildInitialSync(doc, piEntries, REF, { sessionId: "s", lastKnownId: "b", entryCount: 2 });
		expect(frame.kind).toBe("patch");
		if (frame.kind !== "patch") return;
		expect(frame.session?.sessionId).toBe("s");

		const addPaths = frame.ops.filter((o) => o.op === "add").map((o) => o.path);
		expect(addPaths).toEqual(["/entries/l1", "/entries/c"]);
		// Adds carry their ord.
		const cAdd = frame.ops.find((o) => o.path === "/entries/c");
		expect(cAdd && "value" in cAdd ? (cAdd.value as { ord?: number }).ord : undefined).toBe(3);
		// Complete status, unconditionally.
		expect(frame.ops).toContainEqual({ op: "replace", path: "/status", value: doc.status });
	});

	it("includes the live form plus the committed suffix during a mid-turn reconnect", () => {
		const { doc, piEntries } = midTurnDoc();
		const frame = buildInitialSync(doc, piEntries, REF, { sessionId: "s", lastKnownId: "b", entryCount: 2 });
		expect(frame.kind).toBe("patch");
		if (frame.kind !== "patch") return;
		const addPaths = frame.ops.filter((o) => o.op === "add").map((o) => o.path);
		// The persisted user message is part of the committed suffix; the
		// assistant is still live, addressed by the id it will keep.
		expect(addPaths).toContain("/entries/u3");
		expect(addPaths).toContain("/entries/a2");
		expect(addPaths.some((path) => path.includes("pending:"))).toBe(false);
	});

	it("is never a compact single-append frame", () => {
		const doc = initFromEntries([userEntry("a")]);
		const piEntries = [userEntry("a")];
		// Cursor covers the whole file: no committed adds, no provisionals —
		// still the unconditional status replace.
		const frame = buildInitialSync(doc, piEntries, REF, { sessionId: "s", lastKnownId: "a", entryCount: 1 });
		if (frame.kind !== "patch") throw new Error("expected patch");
		expect(frame.ops).toContainEqual({ op: "replace", path: "/status", value: doc.status });
		expect(frame.ops.every((o) => o.op === "append")).toBe(false);
	});

	it("resets CompactCodec state in both frame forms", () => {
		const codec = new CompactCodec();
		const { doc, piEntries } = midTurnDoc();
		const delta = buildInitialSync(doc, piEntries, REF, { sessionId: "s", lastKnownId: "b", entryCount: 2 });
		const decodedDelta = codec.decodeIncoming(codec.encodeOutgoing(delta as unknown as Record<string, unknown>));
		expect(decodedDelta).toEqual(delta);
		// Codec state was reset: a compact bare-string frame has no remembered
		// path to restore.
		expect(() => codec.decodeIncoming(JSON.stringify("x"))).toThrow();

		const replaceFrame = buildInitialSync(doc, piEntries, REF, null);
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

		const full = buildInitialSync(doc, piEntries, REF, null);
		if (full.kind !== "replace") throw new Error("expected replace");

		// Simulate a client that cached only the first two entries.
		const records = committedRecords("s", full.document).filter((r) => r.ord < 2);
		const cursor = computeCursor(records);
		expect(cursor).toEqual({ sessionId: "s", lastKnownId: "b", entryCount: 2 });

		const delta = buildInitialSync(doc, piEntries, REF, cursor);
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
			entryId: "u3",
			message: { role: "user", content: "next question", timestamp: 0 },
		} as unknown as AgentSessionEvent);
		if (!userStarted) throw new Error("expected a patch");
		doc = applyPatch(doc, userStarted.ops);
		const started = applyEvent(doc, {
			type: "message_start",
			entryId: "a2",
			message: { role: "assistant", content: [], api: "anthropic", provider: "anthropic", model: "claude" },
		} as unknown as AgentSessionEvent);
		if (!started) throw new Error("expected a patch");
		doc = applyPatch(doc, started.ops);
		const piEntries = [...settled, userEntry("u3", "b")];

		const full = buildInitialSync(doc, piEntries, REF, null);
		if (full.kind !== "replace") throw new Error("expected replace");
		expect(full.document.entries.a1?.ord).toBe(1);

		const records = committedRecords("s", full.document);
		expect(records.map((r) => r.entryId)).toEqual(["a", "a1", "b", "u3"]);
		const cursor = computeCursor(records);
		expect(cursor).toEqual({ sessionId: "s", lastKnownId: "u3", entryCount: 4 });

		const delta = buildInitialSync(doc, piEntries, REF, cursor);
		if (delta.kind !== "patch") throw new Error("expected patch");
		const seeded = seedDocument(records);
		expect(applyPatch(seeded, delta.ops)).toEqual(full.document);
	});

	it("delta merge is idempotent", () => {
		const piEntries = [userEntry("a"), userEntry("b", "a"), labelEntry("l1", "b"), userEntry("c", "l1")];
		const doc = initFromEntries(piEntries);
		const delta = buildInitialSync(doc, piEntries, REF, { sessionId: "s", lastKnownId: "b", entryCount: 2 });
		if (delta.kind !== "patch") throw new Error("expected patch");

		const seeded = seedDocument(committedRecords("s", doc).filter((r) => r.ord < 2));
		const once = applyPatch(seeded, delta.ops);
		// Re-delivery (e.g. client retry) is a no-op: adds are overwrite-shaped.
		const twice = applyPatch(once, delta.ops);
		expect(twice).toEqual(once);
	});

	it("settles the in-flight turn and keeps cached ords contiguous", () => {
		const { piEntries, driver } = midTurnDoc();
		// Attach mid-turn: the persisted user message is part of the committed
		// prefix, so cached records are a(0), b(1), u3(2) — contiguous and the
		// cursor stays valid. After the turn settles, the refresh assigns the
		// assistant its position and the next snapshot's records stay contiguous.
		driver.refresh([...piEntries, userEntry("c4", "u3")]);
		const doc2 = driver.document;
		const full = buildInitialSync(doc2, [...piEntries, userEntry("c4", "u3")], REF, null);
		if (full.kind !== "replace") throw new Error("expected replace");

		const records = committedRecords("s", full.document);
		expect(records.map((r) => r.entryId)).toEqual(["a", "b", "u3", "c4"]);
		const cursor = computeCursor(records);
		expect(cursor?.entryCount).toBe(4);
	});
});
