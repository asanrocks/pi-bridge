// ============================================================================
// Tree viewmodel unit tests — Pass 1 (computeHistoryTree) + Pass 2
// (computeLaneLayout) + computeActiveUserPath. Pure tests — no mirror, no
// WebSocket, no transport. Mirrors viewmodel-unit.test.ts conventions.
// biome-ignore-all lint/complexity/useLiteralKeys: test fixtures use string-keyed entry names for readability
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Document, Entry } from "../../src/core/types.ts";
import {
	collapseDrafts,
	computeActiveUserPath,
	computeHistoryTree,
	computeLaneLayout,
	type LaneLayout,
} from "../../src/viewmodel/index.ts";

// ---------------------------------------------------------------------------
// Helpers — build synthetic Documents
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

function userEntry(id: string, parentId: string | null, ts: string, text = ""): Entry {
	return {
		kind: "message",
		id,
		parentId,
		timestamp: ts,
		role: "user",
		content: [{ type: "text", text }],
	} as unknown as Entry;
}

function asstEntry(id: string, parentId: string | null, ts: string): Entry {
	return {
		kind: "message",
		id,
		parentId,
		timestamp: ts,
		role: "assistant",
		content: [{ type: "text", text: "..." }],
	} as unknown as Entry;
}

function abortedAsst(id: string, parentId: string | null, ts: string): Entry {
	return {
		kind: "message",
		id,
		parentId,
		timestamp: ts,
		role: "assistant",
		content: [{ type: "text", text: "..." }],
		stopReason: "aborted",
	} as unknown as Entry;
}

function setEntries(doc: Document, entries: Entry[]): Document {
	for (const e of entries) doc.entries[e.id] = e;
	return doc;
}

function ids(layout: LaneLayout): string[] {
	return layout.nodes.map((n) => n.node.id);
}

function lanes(layout: LaneLayout): Map<string, number> {
	const m = new Map<string, number>();
	for (const n of layout.nodes) m.set(n.node.id, n.lane);
	return m;
}

// ---------------------------------------------------------------------------
// Pass 1 — computeHistoryTree
// ---------------------------------------------------------------------------

describe("computeHistoryTree", () => {
	it("returns empty roots for empty document", () => {
		const tree = computeHistoryTree(emptyDoc());
		expect(tree.roots).toEqual([]);
	});

	it("single user message is a single root with no children", () => {
		const doc = setEntries(emptyDoc(), [userEntry("u1", null, "2024-01-01T00:00:00Z", "Hello")]);
		const tree = computeHistoryTree(doc);
		expect(tree.roots).toHaveLength(1);
		expect(tree.roots[0].id).toBe("u1");
		expect(tree.roots[0].children).toEqual([]);
		expect(tree.roots[0].text).toBe("Hello");
	});

	it("skips assistant entries — effective parent is the nearest user ancestor", () => {
		// u1 (root) -> a1 -> u2 : u2's effective parent is u1 (skipping a1)
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "first"),
			asstEntry("a1", "u1", "2024-01-01T00:01:00Z"),
			userEntry("u2", "a1", "2024-01-01T00:02:00Z", "second"),
		]);
		const tree = computeHistoryTree(doc);
		expect(tree.roots).toHaveLength(1);
		expect(tree.roots[0].id).toBe("u1");
		expect(tree.roots[0].children).toHaveLength(1);
		expect(tree.roots[0].children[0].id).toBe("u2");
	});

	it("siblings sharing an effective parent form a branch point", () => {
		// u1 -> a1; u2 and u3 both children of a1 → effective parent u1 (branch)
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "root"),
			asstEntry("a1", "u1", "2024-01-01T00:01:00Z"),
			userEntry("u2", "a1", "2024-01-01T00:02:00Z", "branch A"),
			userEntry("u3", "a1", "2024-01-01T00:03:00Z", "branch B"),
		]);
		const tree = computeHistoryTree(doc);
		expect(tree.roots[0].children).toHaveLength(2);
		expect(tree.roots[0].children.map((c) => c.id)).toEqual(["u2", "u3"]);
	});

	it("skips compaction entries when walking up for the effective parent", () => {
		// u1 -> compaction -> u2: u2's effective parent is u1
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "root"),
			{
				kind: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp: "2024-01-01T00:00:30Z",
				summary: "",
				firstKeptEntryId: "u1",
				tokensBefore: 100,
				details: null,
				fromHook: false,
			} as unknown as Entry,
			userEntry("u2", "c1", "2024-01-01T00:01:00Z", "after compact"),
		]);
		const tree = computeHistoryTree(doc);
		expect(tree.roots[0].children).toHaveLength(1);
		expect(tree.roots[0].children[0].id).toBe("u2");
	});

	it("truncates long message text to a one-line preview", () => {
		const long = "x".repeat(200);
		const doc = setEntries(emptyDoc(), [userEntry("u1", null, "2024-01-01T00:00:00Z", long)]);
		const tree = computeHistoryTree(doc);
		expect(tree.roots[0].text.length).toBeLessThanOrEqual(80);
		expect(tree.roots[0].text.endsWith("\u2026")).toBe(true);
	});

	it("uses only the first line of multi-line user text", () => {
		const doc = setEntries(emptyDoc(), [userEntry("u1", null, "2024-01-01T00:00:00Z", "first line\nsecond line")]);
		const tree = computeHistoryTree(doc);
		expect(tree.roots[0].text).toBe("first line");
	});

	it("sorts roots and children by timestamp", () => {
		// u2 earlier than u1 as roots
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:02:00Z", "later root"),
			userEntry("u2", null, "2024-01-01T00:00:00Z", "earlier root"),
		]);
		const tree = computeHistoryTree(doc);
		expect(tree.roots.map((r) => r.id)).toEqual(["u2", "u1"]);
	});
});

// ---------------------------------------------------------------------------
// computeActiveUserPath
// ---------------------------------------------------------------------------

describe("computeActiveUserPath", () => {
	it("empty when leafId is null", () => {
		const doc = emptyDoc();
		expect(computeActiveUserPath(doc, null).size).toBe(0);
	});

	it("collects user-message ancestors of the leaf, skipping non-user entries", () => {
		// u1 -> a1 -> u2 -> a2(leaf). Active path user ids: {u2, u1}.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			asstEntry("a1", "u1", "2024-01-01T00:01:00Z"),
			userEntry("u2", "a1", "2024-01-01T00:02:00Z"),
			asstEntry("a2", "u2", "2024-01-01T00:03:00Z"),
		]);
		const path = computeActiveUserPath(doc, "a2");
		expect(path.size).toBe(2);
		expect(path.has("u1")).toBe(true);
		expect(path.has("u2")).toBe(true);
		expect(path.has("a1")).toBe(false);
	});

	it("includes the leaf when the leaf is itself a user message", () => {
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			userEntry("u2", "u1", "2024-01-01T00:01:00Z"),
		]);
		const path = computeActiveUserPath(doc, "u2");
		expect([...path]).toEqual(["u2", "u1"]);
	});
});

// ---------------------------------------------------------------------------
// Pass 2 — computeLaneLayout
// ---------------------------------------------------------------------------

describe("computeLaneLayout", () => {
	it("empty tree yields empty layout", () => {
		const layout = computeLaneLayout({ roots: [] }, new Set());
		expect(layout.nodes).toEqual([]);
		expect(layout.lineages).toEqual([]);
		expect(layout.forks).toEqual([]);
		expect(layout.laneCount).toBe(0);
	});

	it("linear chain stays on lane 0 — vertical line, no forks", () => {
		// u1 -> u2 -> u3 (all primary, linear)
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			userEntry("u2", "u1", "2024-01-01T00:01:00Z"),
			userEntry("u3", "u2", "2024-01-01T00:02:00Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "u3");
		const layout = computeLaneLayout(tree, path);

		expect(ids(layout)).toEqual(["u1", "u2", "u3"]);
		const lane = lanes(layout);
		expect(lane.get("u1")).toBe(0);
		expect(lane.get("u2")).toBe(0);
		expect(lane.get("u3")).toBe(0);
		expect(layout.forks).toEqual([]);
		expect(layout.laneCount).toBe(1);
		// One lineage spanning rows 0..2. endRow is the last primary
		// descendant's row (u3, a leaf) — no empty region.
		expect(layout.lineages).toHaveLength(1);
		expect(layout.lineages[0]).toEqual({ lane: 0, startRow: 0, endRow: 2 });
	});

	it("active-path child inherits parent's lane; sibling forks to a new lane", () => {
		// u1(root) -> {u2(active), u3(sibling)}.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "root"),
			userEntry("u2", "u1", "2024-01-01T00:01:00Z", "active branch"),
			userEntry("u3", "u1", "2024-01-01T00:02:00Z", "sibling branch"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "u2");
		const layout = computeLaneLayout(tree, path);

		const lane = lanes(layout);
		expect(lane.get("u1")).toBe(0);
		expect(lane.get("u2")).toBe(0); // active → inherits
		expect(lane.get("u3")).toBe(1); // sibling → forks right
		// One short fork arc: from u1 (row 0, lane 0) landing half a row below
		// on lane 1 (the git-style short fork; the new lane's vertical runs
		// from there down to u3).
		expect(layout.forks).toHaveLength(1);
		expect(layout.forks[0]).toEqual({ fromRow: 0, fromLane: 0, toRow: 0.5, toLane: 1 });
		expect(layout.laneCount).toBe(2);
		// Lane 0: u1→u2 (primary chain, rows 0..1). Lane 1: u3's lineage starts
		// at the fork landing (row 0.5) and runs to u3 (row 2, leaf).
		expect(layout.lineages).toHaveLength(2);
		expect(layout.lineages[0]).toEqual({ lane: 0, startRow: 0, endRow: 1 });
		expect(layout.lineages[1]).toEqual({ lane: 1, startRow: 0.5, endRow: 2 });
	});

	it("active path is an unbroken vertical (lane 0) even when a side branch is explored between", () => {
		// The "Child A again" topology: u1 -> u2(A) -> u4(A continues);
		// u3(B) is a sibling of u2; u5(A again) continues A's line AFTER u3.
		// Chronological: u1, u2, u4, u3, u5. A's lane (0) must stay reserved.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "BP"),
			userEntry("u2", "u1", "2024-01-01T00:01:00Z", "A"),
			userEntry("u4", "u2", "2024-01-01T00:02:00Z", "A continues"),
			userEntry("u3", "u1", "2024-01-01T00:03:00Z", "B"),
			userEntry("u5", "u4", "2024-01-01T00:04:00Z", "A again"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "u5");
		const layout = computeLaneLayout(tree, path);

		expect(ids(layout)).toEqual(["u1", "u2", "u4", "u3", "u5"]);
		const lane = lanes(layout);
		expect(lane.get("u1")).toBe(0);
		expect(lane.get("u2")).toBe(0);
		expect(lane.get("u4")).toBe(0);
		expect(lane.get("u3")).toBe(1); // sibling B forks right
		expect(lane.get("u5")).toBe(0); // A returns to lane 0 (reserved, not reused)
		expect(layout.forks).toHaveLength(1);
		expect(layout.forks[0]).toEqual({ fromRow: 0, fromLane: 0, toRow: 0.5, toLane: 1 });
		// Lane 0 spans rows 0..4 (the whole active path, primary chain u1→u2→u4→u5).
		// Lane 1 (u3) starts at the fork landing (row 0.5) and runs to u3 (row 3).
		const lane0 = layout.lineages.filter((l) => l.lane === 0);
		expect(lane0).toHaveLength(1);
		expect(lane0[0]).toEqual({ lane: 0, startRow: 0, endRow: 4 });
		const lane1 = layout.lineages.filter((l) => l.lane === 1);
		expect(lane1).toHaveLength(1);
		expect(lane1[0]).toEqual({ lane: 1, startRow: 0.5, endRow: 3 });
	});

	it("marks nodes on the active path", () => {
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			userEntry("u2", "u1", "2024-01-01T00:01:00Z"),
			userEntry("u3", "u1", "2024-01-01T00:02:00Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "u3");
		const layout = computeLaneLayout(tree, path);
		const onPath = layout.nodes.filter((n) => n.isOnActivePath).map((n) => n.node.id);
		expect(onPath).toEqual(["u1", "u3"]);
	});

	it("off-path branch point uses oldest child as primary (inherits lane)", () => {
		// u1 -> {u2(active→leaf), u3(side, branch point, off path)}.
		// u3 -> {u4, u5} both off path. u4 (oldest) inherits u3's lane.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			userEntry("u2", "u1", "2024-01-01T00:01:00Z"),
			userEntry("u3", "u1", "2024-01-01T00:02:00Z"),
			userEntry("u4", "u3", "2024-01-01T00:03:00Z"),
			userEntry("u5", "u3", "2024-01-01T00:04:00Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "u2");
		const layout = computeLaneLayout(tree, path);

		const lane = lanes(layout);
		expect(lane.get("u3")).toBe(1); // forked off u1
		expect(lane.get("u4")).toBe(1); // oldest, inherits u3's lane
		expect(lane.get("u5")).toBe(2); // secondary → forks further right
		// Two short forks: u1→u3 (row 0, lane 0→1) and u3→u5 (row 2, lane 1→2).
		expect(layout.forks).toHaveLength(2);
		expect(layout.forks[0]).toEqual({ fromRow: 0, fromLane: 0, toRow: 0.5, toLane: 1 });
		expect(layout.forks[1]).toEqual({ fromRow: 2, fromLane: 1, toRow: 2.5, toLane: 2 });
	});

	it("multiple roots each start a lineage", () => {
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			userEntry("u2", null, "2024-01-01T00:01:00Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "u2");
		const layout = computeLaneLayout(tree, path);

		// Both roots on lane 0 (u1 frees lane 0 as a leaf before u2 starts).
		expect(lanes(layout).get("u1")).toBe(0);
		expect(lanes(layout).get("u2")).toBe(0);
		// Two disjoint lineages on lane 0.
		const lane0 = layout.lineages.filter((l) => l.lane === 0);
		expect(lane0).toHaveLength(2);
		expect(layout.rowCount).toBe(2);
	});

	it("reuses a freed lane for a later branch point's secondary child", () => {
		// u1(root, BP, row0) → u2(primary, row1) → u4(primary, BP, row3) → u5(primary, leaf, row4);
		//   u3(secondary of u1, leaf, row2).
		// u4 → u6(secondary, leaf, row5). u3 frees lane 1 after row 2; u4's
		// secondary child u6 reuses lane 1 (freed, > u4's lane 0) instead of a
		// fresh lane 2 — so laneCount stays 2. (Sibling secondary children of
		// the SAME branch point get separate lanes; reuse only crosses branch
		// points, since a lane is reserved for a child at its branch point's
		// row and can't be freed until that child's primary chain ends.)
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			userEntry("u2", "u1", "2024-01-01T00:01:00Z"),
			userEntry("u3", "u1", "2024-01-01T00:02:00Z"),
			userEntry("u4", "u2", "2024-01-01T00:03:00Z"),
			userEntry("u5", "u4", "2024-01-01T00:04:00Z"),
			userEntry("u6", "u4", "2024-01-01T00:05:00Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "u5");
		const layout = computeLaneLayout(tree, path);

		const lane = lanes(layout);
		expect(lane.get("u1")).toBe(0);
		expect(lane.get("u2")).toBe(0);
		expect(lane.get("u3")).toBe(1); // first secondary fork → lane 1
		expect(lane.get("u4")).toBe(0); // primary, inherits u2's lane 0
		expect(lane.get("u5")).toBe(0); // primary, inherits u4's lane 0
		expect(lane.get("u6")).toBe(1); // reuses freed lane 1 (> u4's lane 0)
		expect(layout.laneCount).toBe(2); // compact — not 3
		// Lane 0 spans rows 0..4 (primary chain u1→u2→u4→u5). Lane 1 hosts
		// two disjoint lineages: u3 (fork landing 0.5 → row 2) and u6
		// (fork landing 3.5 → row 5) — the second reuses the first's lane.
		const lane0 = layout.lineages.filter((l) => l.lane === 0);
		expect(lane0).toHaveLength(1);
		expect(lane0[0]).toEqual({ lane: 0, startRow: 0, endRow: 4 });
		const lane1 = layout.lineages.filter((l) => l.lane === 1);
		expect(lane1).toHaveLength(2);
		expect(lane1[0]).toEqual({ lane: 1, startRow: 0.5, endRow: 2 });
		expect(lane1[1]).toEqual({ lane: 1, startRow: 3.5, endRow: 5 });
		// Forks: u1→u3 (row 0, lane 0→1) and u4→u6 (row 3, lane 0→1, reused).
		expect(layout.forks).toHaveLength(2);
		expect(layout.forks[0]).toEqual({ fromRow: 0, fromLane: 0, toRow: 0.5, toLane: 1 });
		expect(layout.forks[1]).toEqual({ fromRow: 3, fromLane: 0, toRow: 3.5, toLane: 1 });
	});
});

// ---------------------------------------------------------------------------
// Draft collapse — collapseDrafts (Pass 1.5)
// ---------------------------------------------------------------------------

describe("collapseDrafts", () => {
	// Draft-fan fixture: u1(root, completed) → siblings u2(draft), u3(draft),
	// u4(completed), all under effective parent a1.
	function fanDoc(): Document {
		return setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "root"),
			asstEntry("a1", "u1", "2024-01-01T00:00:30Z"),
			userEntry("u2", "a1", "2024-01-01T00:01:00Z", "draft1"),
			abortedAsst("a2", "u2", "2024-01-01T00:01:05Z"),
			userEntry("u3", "a1", "2024-01-01T00:02:00Z", "draft2"),
			abortedAsst("a3", "u3", "2024-01-01T00:02:05Z"),
			userEntry("u4", "a1", "2024-01-01T00:03:00Z", "follow-up"),
			asstEntry("a4", "u4", "2024-01-01T00:03:05Z"),
		]);
	}

	it("flags aborted+dead-end user messages as drafts", () => {
		const tree = computeHistoryTree(fanDoc());
		const u1 = tree.roots[0];
		expect(u1.abortedDraft).toBe(false); // completed assistant
		const byId = (id: string) => u1.children.find((c) => c.id === id)!;
		expect(byId("u2").abortedDraft).toBe(true);
		expect(byId("u3").abortedDraft).toBe(true);
		expect(byId("u4").abortedDraft).toBe(false); // completed → not an aborted draft
	});

	it("abort + continue (user follow-up under the aborted assistant) is NOT a draft", () => {
		// u2's assistant a2 aborts, but the user continues from a2 (u3 child of a2)
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			asstEntry("a1", "u1", "2024-01-01T00:00:30Z"),
			userEntry("u2", "a1", "2024-01-01T00:01:00Z"),
			abortedAsst("a2", "u2", "2024-01-01T00:01:05Z"),
			userEntry("u3", "a2", "2024-01-01T00:02:00Z"), // branch continues
			asstEntry("a3", "u3", "2024-01-01T00:02:05Z"),
		]);
		const tree = computeHistoryTree(doc);
		const u2 = tree.roots[0].children.find((c) => c.id === "u2")!;
		expect(u2.abortedDraft).toBe(false); // not dead-ended
	});

	it("collapses a draft run into the following node", () => {
		const tree = computeHistoryTree(fanDoc());
		const path = computeActiveUserPath(fanDoc(), "a4");
		const collapsed = collapseDrafts(tree, path);
		const u1 = collapsed.roots[0];
		expect(u1.children.map((c) => c.id)).toEqual(["u4"]); // drafts removed
		expect(u1.children[0].discardedDrafts.map((d) => d.id)).toEqual(["u2", "u3"]);
	});

	it("trailing all-aborted fan promotes the last draft as the following node", () => {
		// u2, u3 both abort+dead-end; no following node after. u3 promoted, u2 collapses into it.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			asstEntry("a1", "u1", "2024-01-01T00:00:30Z"),
			userEntry("u2", "a1", "2024-01-01T00:01:00Z", "draft1"),
			abortedAsst("a2", "u2", "2024-01-01T00:01:05Z"),
			userEntry("u3", "a1", "2024-01-01T00:02:00Z", "draft2"),
			abortedAsst("a3", "u3", "2024-01-01T00:02:05Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "a1"); // leaf elsewhere
		const collapsed = collapseDrafts(tree, path);
		const u1 = collapsed.roots[0];
		expect(u1.children.map((c) => c.id)).toEqual(["u3"]); // u3 promoted
		expect(u1.children[0].discardedDrafts.map((d) => d.id)).toEqual(["u2"]);
	});

	it("on-path draft stays visible (not collapsed)", () => {
		// Navigate to draft u2 (leafId a2): u2 is on the active path → not collapsed.
		// u3 (off-path draft after u2) collapses into the following node u4.
		const tree = computeHistoryTree(fanDoc());
		const path = computeActiveUserPath(fanDoc(), "a2");
		const collapsed = collapseDrafts(tree, path);
		const u1 = collapsed.roots[0];
		expect(u1.children.map((c) => c.id)).toEqual(["u2", "u4"]);
		expect(u1.children.find((c) => c.id === "u2")!.discardedDrafts).toEqual([]);
		expect(u1.children.find((c) => c.id === "u4")!.discardedDrafts.map((d) => d.id)).toEqual(["u3"]);
	});

	it("collapsed drafts get no lanes in computeLaneLayout", () => {
		const doc = fanDoc();
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "a4");
		const collapsed = collapseDrafts(tree, path);
		const layout = computeLaneLayout(collapsed, path);
		// Drafts u2, u3 are absent — only u1 and the following node u4 get lanes. u4 is
		// u1's only kept child → primary → inherits lane 0, no fork.
		expect(ids(layout)).toEqual(["u1", "u4"]);
		expect(layout.laneCount).toBe(1);
		expect(layout.forks).toEqual([]);
	});

	it("does not mutate the input tree", () => {
		const doc = fanDoc();
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "a4");
		const before = JSON.stringify(tree);
		collapseDrafts(tree, path);
		expect(JSON.stringify(tree)).toBe(before);
	});
});
