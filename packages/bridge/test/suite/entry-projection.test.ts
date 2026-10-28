// ============================================================================
// Entry projection — the merge contract between pi's authoritative entry list
// and the live stream of the item in flight.
// ============================================================================

import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyPatch,
	createEntryProjection,
	type Document,
	type Entry,
	type EntrySnapshot,
	initFromEntries,
	isEntrySealed,
	type PatchOp,
} from "../../src/core/index.ts";

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

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: text, timestamp: 0 },
	} as SessionEntry;
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "x",
			provider: "x",
			model: "m",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
			timestamp: 0,
		},
	} as SessionEntry;
}

function snapshot(entries: SessionEntry[], from: number, leafId: string | null): EntrySnapshot {
	return { entries: entries.slice(from), next: entries.length, leafId, version: 1 };
}

function apply(doc: Document, ops: PatchOp[] | undefined): Document {
	return ops ? applyPatch(doc, ops) : doc;
}

describe("entry projection", () => {
	it("installs silent appends without individual entry events", () => {
		// A label persisted by an out-of-band append has no live event at all;
		// the entry list is what makes it visible.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);

		const entries: SessionEntry[] = [userEntry("u1", null, "hi")];
		projection.refresh(snapshot(entries, 0, "u1"));
		expect(holder.document.entries.u1).toBeDefined();
		expect(holder.document.status.leafId).toBe("u1");

		const label: SessionEntry = {
			type: "label",
			id: "l1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02Z",
			targetId: "u1",
			label: "bookmark",
		} as SessionEntry;
		entries.push(label);
		const patch = projection.refresh(snapshot(entries, projection.position, "l1"));

		const after = apply(holder.document, patch?.ops);
		expect(after.entries.l1).toBeDefined();
		expect(after.status.leafId).toBe("l1");
	});

	it("replaces a live form with the persisted entry, content and metadata alike", () => {
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);

		projection.applyEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [],
				api: "x",
				provider: "x",
				model: "m",
				stopReason: null,
				timestamp: 0,
			},
			entryId: "a1",
		} as unknown as AgentSessionEvent);
		expect(isEntrySealed(holder.document.entries.a1!)).toBe(false);

		// Authoritative content the stream never produced (an extension rewrote it).
		const persisted = assistantEntry("a1", null, "from the file");
		projection.refresh(snapshot([persisted], 0, "a1"));

		const installed = holder.document.entries.a1!;
		expect(installed).toEqual(initFromEntries([persisted]).entries.a1);
		expect(isEntrySealed(installed)).toBe(true);
		expect(installed.ord).toBe(0);
	});

	it("ignores a stream that arrives after the entry sealed", () => {
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const persisted = assistantEntry("a1", null, "final");
		projection.refresh(snapshot([persisted], 0, "a1"));

		const patch = projection.applyEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "late" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late" },
			entryId: "a1",
		} as unknown as AgentSessionEvent);

		expect(patch).toBeNull();
		expect((holder.document.entries.a1 as { content: Array<{ text: string }> }).content[0]?.text).toBe("final");
	});

	it("extends the leaf through a live stream and returns to pi's leaf on settle", () => {
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries: SessionEntry[] = [userEntry("u1", null, "hi")];
		projection.refresh(snapshot(entries, 0, "u1"));

		projection.applyEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [],
				api: "x",
				provider: "x",
				model: "m",
				stopReason: null,
				timestamp: 0,
			},
			entryId: "a1",
		} as unknown as AgentSessionEvent);
		expect(holder.document.status.leafId).toBe("a1");

		// The item never persisted: settle drops it and the leaf returns to pi's.
		projection.settle();
		expect(holder.document.entries.a1).toBeUndefined();
		expect(holder.document.status.leafId).toBe("u1");
	});

	it("keeps a persisted live form when it settles", () => {
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries: SessionEntry[] = [userEntry("u1", null, "hi")];
		projection.refresh(snapshot(entries, 0, "u1"));

		projection.applyEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [],
				api: "x",
				provider: "x",
				model: "m",
				stopReason: null,
				timestamp: 0,
			},
			entryId: "a1",
		} as unknown as AgentSessionEvent);
		entries.push(assistantEntry("a1", "u1", "done"));
		projection.refresh(snapshot(entries, projection.position, "a1"));

		projection.settle();
		expect(holder.document.entries.a1).toBeDefined();
		expect(isEntrySealed(holder.document.entries.a1!)).toBe(true);
	});

	it("publishes a parent and child discovered in one snapshot together", () => {
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		projection.refresh(snapshot([userEntry("u1", null, "hi")], 0, "u1"));

		const label: SessionEntry = {
			type: "label",
			id: "l1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02Z",
			targetId: "u1",
			label: "bookmark",
		} as SessionEntry;
		const child: SessionEntry = {
			type: "custom",
			id: "c1",
			parentId: "l1",
			timestamp: "2026-01-01T00:00:03Z",
			customType: "child",
			data: {},
		} as SessionEntry;
		const patch = projection.refresh(
			snapshot([userEntry("u1", null, "hi"), label, child], projection.position, "c1"),
		);
		if (!patch) throw new Error("expected a patch");

		const paths = new Set(patch.ops.map((op) => ("path" in op ? op.path : "")));
		expect(paths.has("/entries/l1")).toBe(true);
		expect(paths.has("/entries/c1")).toBe(true);

		// Applying the patch installs both: the chain resolves immediately.
		const after = applyPatch(holder.document, patch.ops);
		expect(after.entries.c1?.parentId).toBe("l1");
		expect(after.entries.l1?.parentId).toBe("u1");
		expect(after.status.leafId).toBe("c1");
	});

	it("re-reads from the start when the entry list was replaced", () => {
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		projection.refresh(snapshot([userEntry("u1", null, "hi")], 0, "u1"));

		// A branched-session rewrite: new version, new prefix.
		const patch = projection.refresh({
			entries: [userEntry("u2", null, "rewritten")],
			next: 1,
			leafId: "u2",
			version: 2,
		});
		const after = apply(holder.document, patch?.ops);
		expect(after.entries.u1).toBeUndefined();
		expect(after.entries.u2).toBeDefined();
		expect(after.status.leafId).toBe("u2");
	});

	it("re-reads the whole list when a rewrite reaches the reader as a suffix", () => {
		// The Manager reads from the position the projection holds, so after a
		// wholesale rewrite the first read returns a *suffix* of the new list —
		// not a prefix of it. Installing that as the whole list would delete every
		// earlier entry and renumber the rest from zero.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const v1 = [userEntry("u1", null, "a"), userEntry("u2", "u1", "b")];
		projection.refreshFrom((from) => ({ entries: v1.slice(from), next: v1.length, leafId: "u2", version: 1 }));
		expect(projection.position).toBe(2);

		const v2 = [userEntry("n1", null, "x"), userEntry("n2", "n1", "y"), userEntry("n3", "n2", "z")];
		projection.refreshFrom((from) => ({ entries: v2.slice(from), next: v2.length, leafId: "n3", version: 2 }));

		expect(Object.keys(holder.document.entries).sort()).toEqual(["n1", "n2", "n3"]);
		expect(holder.document.entries.n1?.ord).toBe(0);
		expect(holder.document.entries.n3?.ord).toBe(2);
		expect(holder.document.status.leafId).toBe("n3");
	});

	it("is idempotent for an unchanged snapshot", () => {
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries: SessionEntry[] = [userEntry("u1", null, "hi")];
		projection.refresh(snapshot(entries, 0, "u1"));

		const patch = projection.refresh(snapshot(entries, projection.position, "u1"));
		expect(patch).toBeNull();
	});

	it("does not treat a live form on another branch as the selected continuation", () => {
		// pi branches back to the user entry while a live assistant still streams
		// on the abandoned branch. The live form's chain reaches a sealed entry,
		// but not one on the selected path, so pi's leaf — not the live form — is
		// what the Document selects: rendering the live form would show work from
		// a branch pi no longer points at.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries: SessionEntry[] = [userEntry("u1", null, "hi"), assistantEntry("a1", "u1", "done")];
		projection.refresh(snapshot(entries, 0, "a1"));

		// A live assistant parented on the abandoned branch's assistant (the
		// skeleton takes the current leaf as its parent).
		projection.applyEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [],
				api: "x",
				provider: "x",
				model: "m",
				stopReason: null,
				timestamp: 0,
			},
			entryId: "live",
		} as unknown as AgentSessionEvent);
		expect(holder.document.status.leafId).toBe("live");

		// pi selects the user entry — no append, just a branch move.
		projection.refresh(snapshot(entries, projection.position, "u1"));
		expect(holder.document.status.leafId).toBe("u1");
	});

	it("recomputes branch statistics when the leaf moves without an append", () => {
		// A branch switch changes the path the totals describe. Skipping the
		// recompute because no entry was installed would leave the previous
		// branch's message/token/cost rollup on the newly selected branch.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries: SessionEntry[] = [userEntry("u1", null, "hi"), assistantEntry("a1", "u1", "done")];
		projection.refresh(snapshot(entries, 0, "a1"));
		expect(holder.document.status.stats.messages).toBe(1);

		const patch = projection.refresh(snapshot(entries, projection.position, "u1"));
		expect(patch).not.toBeNull();
		expect(holder.document.status.leafId).toBe("u1");
		expect(holder.document.status.stats.messages).toBe(0);
	});

	it("reuses selected ancestry during unchanged refreshes while streaming", () => {
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries = Array.from({ length: 500 }, (_, i) =>
			userEntry(`u${i}`, i === 0 ? null : `u${i - 1}`, "history"),
		);
		projection.refresh(snapshot(entries, 0, "u499"));
		projection.applyEvent({
			type: "message_start",
			entryId: "live",
			message: {
				role: "assistant",
				content: [],
				api: "x",
				provider: "x",
				model: "m",
				timestamp: 0,
			},
		} as unknown as AgentSessionEvent);
		projection.refresh(snapshot(entries, projection.position, "u499"));

		let reads = 0;
		holder.document = {
			...holder.document,
			entries: new Proxy(holder.document.entries, {
				get(target, key, receiver) {
					reads++;
					return Reflect.get(target, key, receiver);
				},
			}),
		};

		expect(projection.refresh(snapshot(entries, projection.position, "u499"))).toBeNull();
		expect(holder.document.status.leafId).toBe("live");
		expect(reads).toBeLessThan(10);
	});

	it("does not copy or enumerate installed entries when a refresh finds nothing new", () => {
		// The Manager refreshes after every event, at token cadence; a refresh
		// with an empty suffix must be O(live forms), never a pass over history.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries: SessionEntry[] = [
			userEntry("u0", null, "a"),
			userEntry("u1", "u0", "b"),
			userEntry("u2", "u1", "c"),
		];
		projection.refresh(snapshot(entries, 0, "u2"));

		let enumerated = 0;
		const watched: Record<string, Entry> = new Proxy(holder.document.entries, {
			ownKeys(target) {
				enumerated++;
				return Reflect.ownKeys(target);
			},
		});
		holder.document = { ...holder.document, entries: watched };

		const patch = projection.refresh(snapshot(entries, projection.position, "u2"));
		expect(patch).toBeNull();
		expect(enumerated).toBe(0);
	});

	it("installs a bootstrap-sized suffix without copying the entry map per entry", () => {
		// Bootstrap installs the whole history in one refresh. Applying that
		// suffix through applyPatch would shallow-copy the entry map once per
		// op — quadratic on every session open. One copy for the whole suffix is
		// the budget; counting the map's key reads bounds the copies.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries = Array.from({ length: 400 }, (_, i) =>
			userEntry(`u${i}`, i === 0 ? null : `u${i - 1}`, "history"),
		);

		let reads = 0;
		const counting: Record<string, Entry> = new Proxy({} as Record<string, Entry>, {
			get(target, key, receiver) {
				if (typeof key === "string") reads++;
				return Reflect.get(target, key, receiver);
			},
			ownKeys(target) {
				reads += Reflect.ownKeys(target).length;
				return Reflect.ownKeys(target);
			},
		});
		holder.document = { ...holder.document, entries: counting };

		projection.refresh(snapshot(entries, 0, `u${entries.length - 1}`));
		expect(Object.keys(holder.document.entries)).toEqual(entries.map((entry) => entry.id));
		// One spread of the (empty) base map plus per-entry reads during the
		// stats walk: linear. The quadratic path costs ~N²/2 reads.
		expect(reads).toBeLessThan(entries.length * 20);
	});

	it("derives the session name from an installed session_info entry", () => {
		// A reopened session's title lives in its session_info entries; the
		// projection is what installs them, so it must publish the name — the
		// rename event only arrives for live renames.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const info: SessionEntry = {
			type: "session_info",
			id: "n1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			name: "Restored title",
		} as SessionEntry;
		projection.refresh(snapshot([info], 0, "n1"));
		expect(holder.document.status.name).toBe("Restored title");

		// A later silent rename (no event of its own) is discovered by the next
		// refresh and published.
		const renamed = { ...info, id: "n2", name: "New title" } as SessionEntry;
		projection.refresh({ entries: [renamed], next: 2, leafId: "n2", version: 1 });
		expect(holder.document.status.name).toBe("New title");

		// An explicit clear (empty name) clears the status name.
		const cleared = { ...info, id: "n3", name: "" } as SessionEntry;
		projection.refresh({ entries: [cleared], next: 3, leafId: "n3", version: 1 });
		expect(holder.document.status.name).toBe("");
	});

	it("a nested tool call owns no entry", () => {
		// A call made through ctx.executeTool carries parentToolCallId and is
		// recorded on the issuing call's result — persisting a live form for it
		// would create an entry that never seals and never settles away.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);
		const entries: SessionEntry[] = [userEntry("u1", null, "hi")];
		projection.refresh(snapshot(entries, 0, "u1"));

		expect(
			projection.applyEvent({
				type: "tool_execution_start",
				toolCallId: "nested",
				toolName: "read",
				args: {},
				parentToolCallId: "outer",
			} as unknown as AgentSessionEvent),
		).toBeNull();
		expect(
			projection.applyEvent({
				type: "tool_execution_end",
				toolCallId: "nested",
				toolName: "read",
				result: { content: [], details: {} },
				isError: false,
				parentToolCallId: "outer",
			} as unknown as AgentSessionEvent),
		).toBeNull();

		projection.refresh(snapshot(entries, projection.position, "u1"));
		projection.settle();
		expect(Object.keys(holder.document.entries)).toEqual(["u1"]);
	});

	it("drops a content event that carries no reserved id", () => {
		// The identity contract: an event for a persisted item names the entry
		// it will be stored as. An id-less event is dropped rather than addressed
		// under an invented identity — a fabricated id can never be sealed, and
		// the fabricated entry would survive settle.
		const holder = { document: emptyDoc() };
		const projection = createEntryProjection(holder);

		expect(
			projection.applyEvent({
				type: "message_start",
				message: {
					role: "assistant",
					content: [],
					api: "x",
					provider: "x",
					model: "m",
					stopReason: null,
					timestamp: 0,
				},
			} as unknown as AgentSessionEvent),
		).toBeNull();
		expect(
			projection.applyEvent({
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "read",
				args: {},
			} as unknown as AgentSessionEvent),
		).toBeNull();

		projection.settle();
		expect(Object.keys(holder.document.entries)).toEqual([]);
	});
});
