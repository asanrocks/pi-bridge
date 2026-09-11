import type { AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyEvent, applyPatch, initFromEntries, reconcile } from "../../src/core/index.ts";

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

	it("applyEvent entry_appended does not assign ord", () => {
		let doc = initFromEntries([]);
		const event = {
			type: "entry_appended",
			entry: labelEntry("L1", "x"),
		} as AgentSessionEvent;
		const patch = applyEvent(doc, event);
		if (!patch) throw new Error("expected a patch");
		doc = applyPatch(doc, patch.ops);
		expect(doc.entries.L1).toBeDefined();
		expect(doc.entries.L1?.ord).toBeUndefined();
	});

	it("reconcile discovers a silent hole and assigns positions to the hole and already-known later entries in one patch", () => {
		// File order: a b [silent label] e5. The bridge learned e5 via
		// entry_appended (no ord) before discovering the silent label — the
		// ADR 09 ordering problem.
		let doc = initFromEntries([userEntry("a"), userEntry("b")]);
		const appended = applyEvent(doc, { type: "entry_appended", entry: userEntry("e5") } as AgentSessionEvent);
		if (!appended) throw new Error("expected a patch");
		doc = applyPatch(doc, appended.ops);

		const piEntries = [userEntry("a"), userEntry("b"), labelEntry("silent", "a"), userEntry("e5")];
		const patch = reconcile(doc, piEntries);
		if (!patch) throw new Error("expected a patch");

		// One atomic patch: the hole is added with its ord, and the
		// already-known later entry receives its position.
		expect(hasOp(patch.ops, "add", "/entries/silent")).toBe(true);
		expect(hasOp(patch.ops, "replace", "/entries/e5/ord")).toBe(true);

		const doc2 = applyPatch(doc, patch.ops);
		expect(doc2.entries.silent?.ord).toBe(2);
		expect(doc2.entries.e5?.ord).toBe(3);
		// The add carries its ord in the op value.
		const addOp = patch.ops.find((o) => o.path === "/entries/silent");
		expect(addOp && "value" in addOp ? (addOp.value as { ord?: number }).ord : undefined).toBe(2);
	});

	it("reconcile ord assignment is idempotent", () => {
		const piEntries = [userEntry("a"), userEntry("b")];
		const doc = initFromEntries(piEntries);
		const patch = reconcile(doc, piEntries);
		const ordOps = patch?.ops.filter((o) => o.path.endsWith("/ord")) ?? [];
		expect(ordOps).toEqual([]);
	});

	it("a seal move assigns ord to the committed entry", () => {
		let doc = initFromEntries([]);
		const started = applyEvent(doc, {
			type: "message_start",
			message: { role: "user", content: "hi", timestamp: 0 },
		} as unknown as AgentSessionEvent);
		if (!started) throw new Error("expected a patch");
		doc = applyPatch(doc, started.ops);
		expect(doc.entries["pending:user:1"]).toBeDefined();

		const patch = reconcile(doc, [userEntry("u1")]);
		if (!patch) throw new Error("expected a patch");
		expect(hasOp(patch.ops, "move", "/entries/u1")).toBe(true);
		expect(hasOp(patch.ops, "add", "/entries/u1/ord")).toBe(true);

		const doc2 = applyPatch(doc, patch.ops);
		expect(doc2.entries.u1?.ord).toBe(0);
		expect(doc2.entries["pending:user:1"]).toBeUndefined();
	});

	it("reconcile corrects an ord that no longer matches the file position", () => {
		// Hand-edited history: the file was rewritten so a known entry now
		// sits at a different position. reconcile must emit the correction.
		const doc = initFromEntries([userEntry("a"), userEntry("b")]);
		const piEntries = [userEntry("b"), userEntry("a")];
		const patch = reconcile(doc, piEntries);
		expect(hasOp(patch?.ops ?? [], "replace", "/entries/a/ord")).toBe(true);
		expect(hasOp(patch?.ops ?? [], "replace", "/entries/b/ord")).toBe(true);
	});
});
