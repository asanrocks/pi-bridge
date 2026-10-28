import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyEvent, type Document, initFromEntries, isEntrySealed } from "../../src/core/index.ts";
import { createDriver } from "./projection-driver.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function labelEntry(id: string, targetId: string): SessionEntry {
	return se("label", { id, targetId, label: "pinned" });
}

function hasOp(ops: Array<{ op: string; path: string }>, op: string, path: string): boolean {
	return ops.some((o) => o.op === op && o.path === path);
}

// ---------------------------------------------------------------------------
// ord assignment (ADR 09)
// ---------------------------------------------------------------------------

describe("ord: file position assignment", () => {
	it("initFromEntries assigns sequential ord values", () => {
		const doc = initFromEntries([userEntry("a"), labelEntry("b", "a"), userEntry("c", "b")]);
		expect(doc.entries.a?.ord).toBe(0);
		expect(doc.entries.b?.ord).toBe(1);
		expect(doc.entries.c?.ord).toBe(2);
	});

	it("an append installs nothing until the refresh assigns the position", () => {
		const doc = initFromEntries([]);
		const event = { type: "entry_appended", entry: labelEntry("L1", "x") } as AgentSessionEvent;
		// An append is a hint; content and position arrive together from the file.
		expect(applyEvent(doc, event)).toBeNull();
		expect(doc.entries.L1).toBeUndefined();
	});

	it("a refresh discovers a silent hole and positions it and the entries after it in one patch", () => {
		// File order: a b [silent label] e5. The silent label has no event of its
		// own; the refresh discovers it from the entry list and positions both it
		// and the entry after it in one patch.
		const driver = createDriver(emptyDoc());
		driver.refresh([userEntry("a"), userEntry("b")]);

		const piEntries = [userEntry("a"), userEntry("b"), labelEntry("silent", "a"), userEntry("e5")];
		const patch = driver.refresh(piEntries);
		if (!patch) throw new Error("expected a patch");

		// One atomic patch: the silent entry is added with its ord, and the
		// entry after it receives its position.
		expect(hasOp(patch.ops, "add", "/entries/silent")).toBe(true);
		expect(hasOp(patch.ops, "add", "/entries/e5")).toBe(true);

		expect(driver.document.entries.silent?.ord).toBe(2);
		expect(driver.document.entries.e5?.ord).toBe(3);
		// The add carries its ord in the op value.
		const addOp = patch.ops.find((o) => o.path === "/entries/silent");
		expect(addOp && "value" in addOp ? (addOp.value as { ord?: number }).ord : undefined).toBe(2);
	});

	it("an unchanged refresh is a no-op for positions", () => {
		const piEntries = [userEntry("a"), userEntry("b")];
		const driver = createDriver(emptyDoc());
		driver.refresh(piEntries);
		expect(driver.refresh(piEntries)).toBeNull();
	});

	it("sealing installs ord and the sealed lifecycle together", () => {
		const driver = createDriver(emptyDoc());
		const started = driver.applyEvent({
			type: "message_start",
			entryId: "u1",
			message: { role: "user", content: "hi", timestamp: 0 },
		} as unknown as AgentSessionEvent);
		if (!started) throw new Error("expected a patch");
		expect(isEntrySealed(driver.document.entries.u1!)).toBe(false);
		expect(driver.document.entries.u1?.ord).toBeUndefined();

		const patch = driver.refresh([userEntry("u1")]);
		if (!patch) throw new Error("expected a patch");
		// No identity move: the entry keeps its id and gains its file position.
		expect(patch.ops.some((op) => op.op === "move")).toBe(false);

		expect(driver.document.entries.u1?.ord).toBe(0);
		expect(isEntrySealed(driver.document.entries.u1!)).toBe(true);
	});

	it("a wholesale rewrite reassigns positions from the new list", () => {
		// A rewritten entry list (fork/reload) carries a new version, so the
		// projection re-reads from zero: every position comes from the new
		// list, whatever the old document held.
		const driver = createDriver(emptyDoc());
		driver.refresh([userEntry("a"), userEntry("b")]);

		const patch = driver.rewrite([userEntry("b"), userEntry("a")]);
		expect(patch).not.toBeNull();
		expect(driver.document.entries.a?.ord).toBe(1);
		expect(driver.document.entries.b?.ord).toBe(0);
	});
});
