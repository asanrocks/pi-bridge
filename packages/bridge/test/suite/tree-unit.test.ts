// ============================================================================
// Tree viewmodel unit tests — Pass 1 (computeHistoryTree) + Pass 2
// (computeLaneLayout) + computeActiveUserPath. Pure tests — no mirror, no
// WebSocket, no transport. Mirrors viewmodel-unit.test.ts conventions.
// biome-ignore-all lint/complexity/useLiteralKeys: test fixtures use string-keyed entry names for readability
// ============================================================================

import { describe, expect, it } from "vitest";
import type { Document, Entry } from "../../src/core/types.ts";
import {
	collapseSuperseded,
	computeActiveUserPath,
	computeHistoryTree,
	computeLaneLayout,
	type LaneLayout,
	resolveLabels,
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

function labelEntry(
	id: string,
	parentId: string | null,
	ts: string,
	targetId: string,
	label: string | undefined,
): Entry {
	return {
		kind: "label",
		id,
		parentId,
		timestamp: ts,
		targetId,
		label,
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

	it("resolves labels onto user-message nodes; non-user targets are ignored", () => {
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "root"),
			asstEntry("a1", "u1", "2024-01-01T00:00:30Z"),
			userEntry("u2", "a1", "2024-01-01T00:01:00Z", "labeled"),
			asstEntry("a2", "u2", "2024-01-01T00:01:30Z"),
			labelEntry("l1", "a2", "2024-01-01T00:02:00Z", "u2", "checkpoint"),
			labelEntry("l2", "l1", "2024-01-01T00:03:00Z", "a2", "reply-mark"),
		]);
		const tree = computeHistoryTree(doc);
		expect(tree.roots[0].label).toBeUndefined(); // unlabeled
		expect(tree.roots[0].children[0].label).toBe("checkpoint");
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

describe("resolveLabels", () => {
	it("no label entries yields an empty map", () => {
		const doc = setEntries(emptyDoc(), [userEntry("u1", null, "2024-01-01T00:00:00Z")]);
		expect(resolveLabels(doc.entries).size).toBe(0);
	});

	it("last write wins by timestamp, not insertion order", () => {
		// l1 ("first") is inserted before l2 ("second") but stamped later —
		// chronological order decides, so "first" wins.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			labelEntry("l1", "u1", "2024-01-01T00:02:00Z", "u1", "first"),
			labelEntry("l2", "l1", "2024-01-01T00:01:00Z", "u1", "second"),
		]);
		expect(resolveLabels(doc.entries).get("u1")).toBe("first");
	});

	it("an undefined label clears the target", () => {
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			labelEntry("l1", "u1", "2024-01-01T00:01:00Z", "u1", "first"),
			labelEntry("l2", "l1", "2024-01-01T00:02:00Z", "u1", undefined),
		]);
		expect(resolveLabels(doc.entries).has("u1")).toBe(false);
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

	it("off-path branch point uses newest child as primary (inherits lane)", () => {
		// u1 -> {u2(active→leaf), u3(side, branch point, off path)}.
		// u3 -> {u4, u5} both off path. u5 (newest — where the conversation
		// continued) inherits u3's lane; u4 (the superseded original) forks.
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
		expect(lane.get("u4")).toBe(2); // superseded original → forks right
		expect(lane.get("u5")).toBe(1); // newest, inherits u3's lane
		// Two short forks: u1→u3 (row 0, lane 0→1) and u3→u4 (row 2, lane 1→2).
		expect(layout.forks).toHaveLength(2);
		expect(layout.forks[0]).toEqual({ fromRow: 0, fromLane: 0, toRow: 0.5, toLane: 1 });
		expect(layout.forks[1]).toEqual({ fromRow: 2, fromLane: 1, toRow: 2.5, toLane: 2 });
	});

	it("secondary siblings are assigned lanes newest-nearest (reverse chronological)", () => {
		// u1 -> {u2(active), u3, u4}: the newest secondary (u4) takes the lane
		// nearest the parent; the oldest (u3) is pushed furthest right. This is
		// what lets a re-edit continuation start on the lane next to the spine
		// instead of one lane out per earlier dead sibling.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z"),
			userEntry("u2", "u1", "2024-01-01T00:01:00Z"),
			userEntry("u3", "u1", "2024-01-01T00:02:00Z"),
			userEntry("u4", "u1", "2024-01-01T00:03:00Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "u2");
		const layout = computeLaneLayout(tree, path);

		const lane = lanes(layout);
		expect(lane.get("u2")).toBe(0); // active → inherits
		expect(lane.get("u4")).toBe(1); // newest secondary → nearest lane
		expect(lane.get("u3")).toBe(2); // oldest secondary → furthest lane
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

	it("revisit-edit keeps the chronological spine on one lane (edit → continue pattern)", () => {
		// The re-edit pattern with a history revisit: A; B (edited to B1);
		// C on B1 (edited to C1); D on C1; then B is revisited and edited to
		// B2. Edits fork at the edited message's parent, so B, B1, B2 are all
		// children of A, and C, C1 are both children of B1. Leaf = B2, so the
		// active path is shallow (A→B2) while the chronological spine
		// (B1→C1→D) is deep. Newest-primary + reverse sibling order keep the
		// spine on lane 1 and the superseded originals (B, C) as one-dot
		// stubs reusing lane 2 — instead of each edit cycle forking one lane
		// further right (the pre-fix layout had 4 lanes: B=1, B1=2, C1=3).
		const doc = setEntries(emptyDoc(), [
			userEntry("A", null, "2024-01-01T00:00:00Z", "A"),
			userEntry("B", "A", "2024-01-01T00:01:00Z", "B"),
			userEntry("B1", "A", "2024-01-01T00:02:00Z", "B1"),
			userEntry("C", "B1", "2024-01-01T00:03:00Z", "C"),
			userEntry("C1", "B1", "2024-01-01T00:04:00Z", "C1"),
			userEntry("D", "C1", "2024-01-01T00:05:00Z", "D"),
			userEntry("B2", "A", "2024-01-01T00:06:00Z", "B2"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "B2");
		const layout = computeLaneLayout(tree, path);

		expect(ids(layout)).toEqual(["A", "B", "B1", "C", "C1", "D", "B2"]);
		const lane = lanes(layout);
		expect(lane.get("A")).toBe(0);
		expect(lane.get("B2")).toBe(0); // active branch → the main lane
		expect(lane.get("B1")).toBe(1); // spine start: newest secondary of A
		expect(lane.get("C1")).toBe(1); // newest child of B1 → inherits the spine lane
		expect(lane.get("D")).toBe(1); // only child of C1 → inherits
		expect(lane.get("B")).toBe(2); // superseded original: one-dot stub
		expect(lane.get("C")).toBe(2); // superseded original: one-dot stub (reusing B's lane)
		expect(layout.laneCount).toBe(3); // constant — not one lane per edit cycle
		// Three short forks: A→B1 (lane 1), A→B (lane 2), B1→C (lane 2, reused).
		expect(layout.forks).toHaveLength(3);
		expect(layout.forks[0]).toEqual({ fromRow: 0, fromLane: 0, toRow: 0.5, toLane: 1 });
		expect(layout.forks[1]).toEqual({ fromRow: 0, fromLane: 0, toRow: 0.5, toLane: 2 });
		expect(layout.forks[2]).toEqual({ fromRow: 2, fromLane: 1, toRow: 2.5, toLane: 2 });
		// Lane 1's vertical spans the whole spine (fork landing 0.5 → D, row 5).
		const lane1 = layout.lineages.filter((l) => l.lane === 1);
		expect(lane1).toHaveLength(1);
		expect(lane1[0]).toEqual({ lane: 1, startRow: 0.5, endRow: 5 });
		// Lane 2 hosts two disjoint stub lineages: B (0.5→1) and C (2.5→3).
		const lane2 = layout.lineages.filter((l) => l.lane === 2);
		expect(lane2).toHaveLength(2);
		expect(lane2[0]).toEqual({ lane: 2, startRow: 0.5, endRow: 1 });
		expect(lane2[1]).toEqual({ lane: 2, startRow: 2.5, endRow: 3 });
	});

	it("revisit-edit lane count is constant across edit cycles", () => {
		// Three edit cycles (B→B1, C→C1, D→D1) before the revisit-edit of B.
		// Pre-fix this grew one lane per cycle (5 lanes); the spine now
		// inherits one lane and every superseded original reuses the stub
		// lane, so the width is 3 regardless of the number of cycles.
		const doc = setEntries(emptyDoc(), [
			userEntry("A", null, "2024-01-01T00:00:00Z", "A"),
			userEntry("B", "A", "2024-01-01T00:01:00Z", "B"),
			userEntry("B1", "A", "2024-01-01T00:02:00Z", "B1"),
			userEntry("C", "B1", "2024-01-01T00:03:00Z", "C"),
			userEntry("C1", "B1", "2024-01-01T00:04:00Z", "C1"),
			userEntry("D", "C1", "2024-01-01T00:05:00Z", "D"),
			userEntry("D1", "C1", "2024-01-01T00:06:00Z", "D1"),
			userEntry("B2", "A", "2024-01-01T00:07:00Z", "B2"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "B2");
		const layout = computeLaneLayout(tree, path);

		const lane = lanes(layout);
		// The chronological spine stays on lane 1 end to end.
		expect(lane.get("B1")).toBe(1);
		expect(lane.get("C1")).toBe(1);
		expect(lane.get("D1")).toBe(1);
		// Every superseded original is a one-dot stub reusing lane 2.
		expect(lane.get("B")).toBe(2);
		expect(lane.get("C")).toBe(2);
		expect(lane.get("D")).toBe(2);
		expect(layout.laneCount).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// Draft collapse — collapseDrafts (Pass 1.5)
// ---------------------------------------------------------------------------

describe("collapseSuperseded", () => {
	// Dead-end fan fixture: u1(root, completed) → siblings u2(draft, aborted),
	// u3(draft, aborted), u4(completed leaf), all under effective parent a1.
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

	it("flags every user-message leaf as a dead end (structural, abort-agnostic)", () => {
		const tree = computeHistoryTree(fanDoc());
		const u1 = tree.roots[0];
		expect(u1.deadEnd).toBe(false); // has user children
		const byId = (id: string) => u1.children.find((c) => c.id === id)!;
		expect(byId("u2").deadEnd).toBe(true); // aborted draft
		expect(byId("u3").deadEnd).toBe(true); // aborted draft
		expect(byId("u4").deadEnd).toBe(true); // completed but a leaf — still a structural dead end
	});

	it("a user follow-up below a message clears its dead-end flag", () => {
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
		expect(u2.deadEnd).toBe(false); // not dead-ended
	});

	it("collapses a dead-end run into the following node", () => {
		const tree = computeHistoryTree(fanDoc());
		const path = computeActiveUserPath(fanDoc(), "a4");
		const collapsed = collapseSuperseded(tree, path);
		const u1 = collapsed.roots[0];
		expect(u1.children.map((c) => c.id)).toEqual(["u4"]); // dead ends removed
		expect(u1.children[0].supersededTurns.map((t) => t.id)).toEqual(["u2", "u3"]);
	});

	it("folds a COMPLETED turn that was edited away (thorough fold)", () => {
		// u2 got a full assistant reply, then the user re-edited it into u3 —
		// not aborted, but the branch dead-ended and a later sibling from the
		// same branch point superseded it, so it folds.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "root"),
			asstEntry("a1", "u1", "2024-01-01T00:00:30Z"),
			userEntry("u2", "a1", "2024-01-01T00:01:00Z", "original"),
			asstEntry("a2", "u2", "2024-01-01T00:01:30Z"), // completed reply
			userEntry("u3", "a1", "2024-01-01T00:02:00Z", "re-edit"),
			asstEntry("a3", "u3", "2024-01-01T00:02:30Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "a3");
		const collapsed = collapseSuperseded(tree, path);
		const u1 = collapsed.roots[0];
		expect(u1.children.map((c) => c.id)).toEqual(["u3"]);
		expect(u1.children[0].supersededTurns.map((t) => t.id)).toEqual(["u2"]);
	});

	it("a single trailing dead end stays visible (nothing superseded it)", () => {
		// u2 completed and dead-ended; the user navigated back to u1 (leaf a1)
		// and sent nothing after — no following sibling, so the trailing run
		// promotes its last (only) member and u2 stays a row.
		const doc = setEntries(emptyDoc(), [
			userEntry("u1", null, "2024-01-01T00:00:00Z", "root"),
			asstEntry("a1", "u1", "2024-01-01T00:00:30Z"),
			userEntry("u2", "a1", "2024-01-01T00:01:00Z", "explored"),
			asstEntry("a2", "u2", "2024-01-01T00:01:30Z"),
		]);
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "a1");
		const collapsed = collapseSuperseded(tree, path);
		expect(collapsed.roots[0].children.map((c) => c.id)).toEqual(["u2"]);
		expect(collapsed.roots[0].children[0].supersededTurns).toEqual([]);
	});

	it("trailing all-dead-end fan promotes the last member as the following node", () => {
		// u2, u3 both dead-end; no following node after. u3 promoted, u2 folds into it.
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
		const collapsed = collapseSuperseded(tree, path);
		const u1 = collapsed.roots[0];
		expect(u1.children.map((c) => c.id)).toEqual(["u3"]); // u3 promoted
		expect(u1.children[0].supersededTurns.map((t) => t.id)).toEqual(["u2"]);
	});

	it("on-path dead end stays visible (not collapsed)", () => {
		// Navigate to dead end u2 (leafId a2): u2 is on the active path → not collapsed.
		// u3 (off-path dead end after u2) folds into the following node u4.
		const tree = computeHistoryTree(fanDoc());
		const path = computeActiveUserPath(fanDoc(), "a2");
		const collapsed = collapseSuperseded(tree, path);
		const u1 = collapsed.roots[0];
		expect(u1.children.map((c) => c.id)).toEqual(["u2", "u4"]);
		expect(u1.children.find((c) => c.id === "u2")!.supersededTurns).toEqual([]);
		expect(u1.children.find((c) => c.id === "u4")!.supersededTurns.map((t) => t.id)).toEqual(["u3"]);
	});

	it("a keep-visible id outside the active path stays visible (peek exclusion)", () => {
		// The renderer passes the active path ∪ the rendered (peeked) path, so
		// a dead end pinned by a peek keeps its row and click target.
		const tree = computeHistoryTree(fanDoc());
		const path = computeActiveUserPath(fanDoc(), "a4");
		const keepVisible = new Set([...path, "u2"]);
		const collapsed = collapseSuperseded(tree, keepVisible);
		const u1 = collapsed.roots[0];
		expect(u1.children.map((c) => c.id)).toEqual(["u2", "u4"]);
		expect(u1.children.find((c) => c.id === "u2")!.supersededTurns).toEqual([]);
		expect(u1.children.find((c) => c.id === "u4")!.supersededTurns.map((t) => t.id)).toEqual(["u3"]);
	});

	it("folded turns get no lanes in computeLaneLayout", () => {
		const doc = fanDoc();
		const tree = computeHistoryTree(doc);
		const path = computeActiveUserPath(doc, "a4");
		const collapsed = collapseSuperseded(tree, path);
		const layout = computeLaneLayout(collapsed, path);
		// Dead ends u2, u3 are absent — only u1 and the following node u4 get lanes. u4 is
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
		collapseSuperseded(tree, path);
		expect(JSON.stringify(tree)).toBe(before);
	});
});
