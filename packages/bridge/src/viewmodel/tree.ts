// ============================================================================
// Tree viewmodel — git-log-style branch graph projection.
//
// Two-pass design (mirrors the DOM → render-tree separation):
//   Pass 1 (computeHistoryTree): Document → user-message tree (logical
//          structure). Only user messages appear as nodes; the parent of
//          each user message in the tree is its nearest user-message
//          ancestor (assistant/tool_result/compaction entries are skipped
//          by walking up `parentId` until a user message is found).
//   Pass 2 (computeLaneLayout):  user-message tree → lane topology (visual
//          structure). Lane-based, not depth-based — linear follow-ups
//          inherit the parent's lane (a straight vertical line); only
//          branch points (nodes with >1 child) fork to new lanes.
//
// The renderer (web/HistoryPane) consumes LaneLayout and draws SVG verticals
// + Bezier fork curves + positioned DOM dots/labels. No topology reasoning
// in the renderer.
//
// Browser-safe: no node:* imports, no DOM. Pure functions only. Lives in
// viewmodel/ alongside computeViewModel; exported from src/index.ts and
// exercised by scripts/browser-smoke-entry.ts.
// ============================================================================

import type { Document, Entry, MessageEntry } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Pass 1 — History tree (logical structure)
// ---------------------------------------------------------------------------

export interface HistoryNode {
	id: string;
	/** First line of the user message's text content, truncated for one-line display. */
	text: string;
	timestamp: string;
	/**
	 * True if this user message's assistant turn aborted and dead-ended — the
	 * assistant child committed with `stopReason: "aborted"` and produced no
	 * user-message follow-up down that branch. This is the structural
	 * "discarded draft" signal; the active-path exclusion (a draft you
	 * navigated back to stays visible) is applied in `collapseDrafts`, not here.
	 */
	abortedDraft: boolean;
	/** Effective children (user messages whose nearest user ancestor is this node). */
	children: HistoryNode[];
	/**
	 * Drafts collapsed into this node: consecutive aborted-dead-end
	 * siblings that preceded this node chronologically and were hidden from
	 * the lane graph to keep sibling drafts from fanning into separate lanes.
	 * Empty for nodes that receive no drafts and nodes with no preceding drafts. The
	 * renderer shows a "+N drafts" affordance when non-empty.
	 */
	discardedDrafts: HistoryNode[];
}

export interface HistoryTree {
	roots: HistoryNode[];
}

/** Truncate a user message to a one-line preview for the graph label. */
const PREVIEW_MAX = 80;

function previewText(entry: MessageEntry): string {
	const text = entry.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string | null }).text ?? "")
		.join(" ")
		.trim();
	const firstLine = text.split("\n")[0] ?? "";
	return firstLine.length > PREVIEW_MAX ? `${firstLine.slice(0, PREVIEW_MAX - 1)}\u2026` : firstLine;
}

/**
 * Walk up the `parentId` chain from a user message, skipping non-user
 * entries, to find the nearest user-message ancestor. Returns null for
 * roots. This is the "effective parent" in the user-message tree — the
 * node a branch fork hangs off of.
 */
function nearestUserAncestor(entryId: string, entries: Record<string, Entry>): string | null {
	let cursor = entries[entryId]?.parentId ?? null;
	while (cursor) {
		const e: Entry | undefined = entries[cursor];
		if (!e) break;
		if (e.kind === "message" && e.role === "user") return cursor;
		cursor = e.parentId;
	}
	return null;
}

/**
 * Pass 1: build the user-message tree from a Document.
 *
 * Only user messages appear as nodes. The parent of each user message in the
 * tree is its nearest user-message ancestor — assistant messages, tool
 * results, compactions, and other non-user entries are skipped by walking
 * up `parentId` until a user message is found. Branch points are user
 * messages with multiple effective children.
 *
 * Roots and children are sorted by timestamp (then id) for stable ordering.
 */
export function computeHistoryTree(doc: Document): HistoryTree {
	const userEntries: MessageEntry[] = [];
	for (const e of Object.values(doc.entries)) {
		if (e.kind === "message" && e.role === "user") userEntries.push(e);
	}

	// Direct-children map (all entry kinds). Used to detect aborted-dead-end
	// drafts: a user message whose assistant child aborted and produced no
	// user-message follow-up down that branch.
	const childrenOf = new Map<string, Entry[]>();
	for (const e of Object.values(doc.entries)) {
		if (e.parentId !== null) {
			const arr = childrenOf.get(e.parentId);
			if (arr) arr.push(e);
			else childrenOf.set(e.parentId, [e]);
		}
	}

	// A user message is a structural "discarded draft" candidate if its
	// assistant turn aborted and dead-ended — the assistant child committed
	// with stopReason "aborted" and has no user-message child (the user
	// re-edited into a sibling rather than continuing from the abort). The
	// active-path exclusion (a draft you navigated back to stays visible) is
	// applied later in `collapseDrafts`, not here.
	const isAbortedDraft = (ue: MessageEntry): boolean => {
		const kids = childrenOf.get(ue.id) ?? [];
		const asst = kids.find((k) => k.kind === "message" && k.role === "assistant") as MessageEntry | undefined;
		if (!asst || asst.stopReason !== "aborted") return false;
		const asstKids = childrenOf.get(asst.id) ?? [];
		return !asstKids.some((k) => k.kind === "message" && k.role === "user");
	};

	const nodes = new Map<string, HistoryNode>();
	const effectiveParent = new Map<string, string | null>();
	for (const ue of userEntries) {
		nodes.set(ue.id, {
			id: ue.id,
			text: previewText(ue),
			timestamp: ue.timestamp,
			abortedDraft: isAbortedDraft(ue),
			children: [],
			discardedDrafts: [],
		});
		effectiveParent.set(ue.id, nearestUserAncestor(ue.id, doc.entries));
	}

	const roots: HistoryNode[] = [];
	for (const ue of userEntries) {
		const node = nodes.get(ue.id)!;
		const parentId = effectiveParent.get(ue.id) ?? null;
		if (parentId === null) {
			roots.push(node);
		} else {
			nodes.get(parentId)?.children.push(node);
		}
	}

	const byTs = (a: HistoryNode, b: HistoryNode) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);
	roots.sort(byTs);
	for (const n of nodes.values()) n.children.sort(byTs);

	return { roots };
}

// ---------------------------------------------------------------------------
// Active-path helper — the set of user messages on the path from any root
// to `leafId`. Drives "primary child" selection in Pass 2: the child on this
// path inherits the parent's lane, keeping the active thread a straight
// vertical line and all detours forking to the right.
// ---------------------------------------------------------------------------

/**
 * The set of user-message ids that are ancestors of `leafId` (inclusive of
 * `leafId` itself when it is a user message). Walks up the Document's
 * `parentId` chain from `leafId`, collecting user messages. Returns the
 * empty set when `leafId` is null.
 */
export function computeActiveUserPath(doc: Document, leafId: string | null): Set<string> {
	const path = new Set<string>();
	if (!leafId) return path;
	let cursor: string | null = leafId;
	while (cursor) {
		const e: Entry | undefined = doc.entries[cursor];
		if (!e) break;
		if (e.kind === "message" && e.role === "user") path.add(cursor);
		cursor = e.parentId;
	}
	return path;
}

// ---------------------------------------------------------------------------
// Draft collapse — hide aborted sibling drafts in the following node
// ---------------------------------------------------------------------------

/**
 * Collapse aborted-dead-end sibling runs into the following node.
 *
 * A "discarded draft" is a sibling user message whose assistant turn aborted
 * and dead-ended (`abortedDraft: true`) AND which is not on the active path
 * (a draft you navigated back to stays visible). Maximal runs of consecutive
 * drafts are removed from the parent's children and attached to the following
 * following node's `discardedDrafts`. A trailing run with no following node
 * promotes its chronologically-last draft to be the node (the most recent attempt
 * stays visible) and attaches the rest to it.
 *
 * This runs after `computeHistoryTree` and before `computeLaneLayout`: Pass 2
 * iterates `children`, so removing drafts from children keeps them out of the
 * lane graph (no lane per draft, no fan). The renderer surfaces them via the
 * following node's `discardedDrafts` as an expandable "+N drafts" affordance — a UI
 * overlay, not a graph relayout.
 *
 * Pure: returns a new tree; does not mutate the input.
 */
export function collapseDrafts(tree: HistoryTree, activePath: Set<string>): HistoryTree {
	const collapseNode = (n: HistoryNode): HistoryNode => ({
		...n,
		children: collapseSiblings(n.children.map(collapseNode), activePath),
	});
	return { roots: collapseSiblings(tree.roots.map(collapseNode), activePath) };
}

/**
 * Collapse one sibling list. Drafts (aborted + off-path) are pulled out and
 * attached to the following node's `discardedDrafts`; a trailing run
 * promotes its last draft. `siblings` must be sorted chronologically (Pass 1
 * sorts roots and children).
 */
function collapseSiblings(siblings: HistoryNode[], activePath: Set<string>): HistoryNode[] {
	const result: HistoryNode[] = [];
	let run: HistoryNode[] = []; // consecutive drafts awaiting a node to attach to

	for (const s of siblings) {
		if (s.abortedDraft && !activePath.has(s.id)) {
			run.push(s);
			continue;
		}
		// s is a completed sibling. Attach the pending run to it.
		if (run.length > 0) {
			result.push({ ...s, discardedDrafts: [...s.discardedDrafts, ...run] });
			run = [];
		} else {
			result.push(s);
		}
	}

	// Trailing run with no following node: promote the chronologically-last
	// draft (siblings are sorted) as the node, attach the rest to it.
	if (run.length > 0) {
		const last = run[run.length - 1];
		const rest = run.slice(0, -1);
		result.push({ ...last, discardedDrafts: [...last.discardedDrafts, ...rest] });
	}

	return result;
}

// ---------------------------------------------------------------------------
// Pass 2 — Lane layout (visual structure)
// ---------------------------------------------------------------------------

export interface PlacedNode {
	node: HistoryNode;
	/** Lane (column) index, 0-based from the left. */
	lane: number;
	/** Chronological row index, 0-based top to bottom. */
	row: number;
	/** True if this node is on the path from a root to the active leaf. */
	isOnActivePath: boolean;
}

/**
 * One connected vertical run on a lane. For roots and primary descendants,
 * `startRow` is the node's own row. For secondary (forked) lineages,
 * `startRow` is the branch point's row + 0.5 — where the fork arc lands —
 * and the vertical runs from there down to the child's primary-chain end.
 * The renderer draws one vertical `<line>` per lineage, from `rowY(startRow)`
 * to `rowY(endRow)`. Lane reuse (a freed lane hosting a later fork) produces
 * multiple disjoint lineages on the same lane index.
 *
 * `endRow` is the last primary descendant's row (following `primaryChildOf`
 * to a leaf). The vertical ends at a dot, never bare. Git draws forks as
 * short arcs at the branch point; the new lane's vertical carries the
 * connection down to the child, offset a full lane width from the parent's
 * nodes — no long curve riding the parent's lane.
 */
export interface Lineage {
	lane: number;
	/** Row the vertical starts at. For roots/primary, the node's own row; for
	 * forked lineages, the branch point's row + 0.5 (the fork landing). */
	startRow: number;
	/** Row of the last primary descendant on this lineage. The vertical
	 * `<line>` ends here — at a dot, never bare. */
	endRow: number;
}

/**
 * A fork: a secondary child branching off a branch point. The renderer draws
 * one cubic-Bezier `<path>` per fork — a SHORT arc at the branch point's row,
 * landing half a row below on the new lane. The new lane's vertical (a
 * separate Lineage) runs from that landing point down to the child. This is
 * the git/VScode model: the fork is local to the branch point, and the
 * connection to a far child is via the new lane's vertical (offset a full
 * lane width from the parent's nodes), not a long curve that would ride the
 * parent's lane and graze intermediate dots.
 */
export interface Fork {
	/** Row of the branch point (where the fork originates). */
	fromRow: number;
	/** Lane of the branch point. */
	fromLane: number;
	/** Row where the fork lands on the new lane — `fromRow + 0.5` (half a row
	 * below the branch dot). Fractional; `rowY` handles it. */
	toRow: number;
	/** Lane of the secondary child. */
	toLane: number;
}

export interface LaneLayout {
	/** Nodes in row order (chronological). */
	nodes: PlacedNode[];
	/** Vertical runs — one `<line>` each. */
	lineages: Lineage[];
	/** Fork transitions — one Bezier `<path>` each. */
	forks: Fork[];
	/** Total lane count (graph width in lanes). */
	laneCount: number;
	/** Total row count (graph height in rows). */
	rowCount: number;
}

/**
 * Pass 2: assign lanes to user-message nodes and emit the lane topology.
 *
 * Lane-assignment rules (git-style, producing vertical lines for linear
 * history):
 *
 * 1. **Root** → leftmost free lane (typically lane 0 for a single-root tree).
 * 2. **Primary child** (the child on the active path, or the oldest child
 *    when the branch point is off the active path) → inherits the parent's
 *    lane. No fork is drawn. This is what keeps linear follow-ups on one
 *    vertical line.
 * 3. **Secondary child** → a lane reserved for it when its branch point is
 *    placed (not when the child itself is placed). The reservation emits a
 *    short fork arc (landing half a row below the branch dot) and creates
 *    the child's lineage (vertical from the fork landing down to the
 *    child's primary-chain end). Reserving at the branch point's row keeps
 *    the lane occupied through the rows where the new lane's vertical must
 *    run, so a later fork can't grab it before the child arrives.
 *
 * **Git-style short fork + new-lane vertical.** The fork is a short arc at
 * the branch point's row; the new lane's vertical (offset a full lane width
 * right of the parent's nodes) carries the connection down to the child.
 * This replaces a long curve from branch point to far child, which would
 * ride the parent's lane and graze intermediate dots.
 *
 * Lane freeing: a lane is freed once the chronological row reaches the
 * lineage's `endRow` — the last primary descendant's row (precomputed by
 * walking `primaryChildOf` to a leaf). The vertical ends at a dot, never
 * bare.
 *
 * The active path is the set of user-message ids from a root to `leafId`
 * (see `computeActiveUserPath`). The primary-child rule makes that path an
 * unbroken vertical; every detour forks right.
 */
export function computeLaneLayout(tree: HistoryTree, activePath: Set<string>): LaneLayout {
	// Flatten the tree, sort chronologically (timestamp then id for stable ties).
	const all: HistoryNode[] = [];
	const collect = (n: HistoryNode) => {
		all.push(n);
		for (const c of n.children) collect(c);
	};
	for (const r of tree.roots) collect(r);
	all.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));

	if (all.length === 0) {
		return { nodes: [], lineages: [], forks: [], laneCount: 0, rowCount: 0 };
	}

	// Parent in the user tree (nearest user ancestor) + per-node row index.
	const parentOf = new Map<string, string | null>();
	const rowOf = new Map<string, number>();
	for (let i = 0; i < all.length; i++) rowOf.set(all[i].id, i);
	const dfsParent = (n: HistoryNode, parent: string | null) => {
		parentOf.set(n.id, parent);
		for (const c of n.children) dfsParent(c, n.id);
	};
	for (const r of tree.roots) dfsParent(r, null);

	// Primary child per node: the child on the active path, or the oldest
	// (children are sorted by timestamp in Pass 1).
	const primaryChildOf = new Map<string, string | null>();
	for (const n of all) {
		if (n.children.length === 0) {
			primaryChildOf.set(n.id, null);
			continue;
		}
		const onPath = n.children.find((c) => activePath.has(c.id));
		primaryChildOf.set(n.id, onPath ? onPath.id : n.children[0].id);
	}

	// Last primary descendant's row: walk the primary chain (following
	// primaryChildOf) to its leaf. This is where a lineage's vertical ends —
	// at a dot, never bare.
	const primaryChainLastRow = new Map<string, number>();
	const computePCLR = (id: string): number => {
		if (primaryChainLastRow.has(id)) return primaryChainLastRow.get(id)!;
		const pc = primaryChildOf.get(id);
		const r = pc ? computePCLR(pc) : rowOf.get(id)!;
		primaryChainLastRow.set(id, r);
		return r;
	};
	for (const n of all) computePCLR(n.id);

	// Chronological lane assignment.
	const nodes: PlacedNode[] = [];
	const lineages: Lineage[] = [];
	const forks: Fork[] = [];
	const nodeLane = new Map<string, number>();
	// childLane: pre-reserved lanes for secondary children, populated when
	// their branch point is placed. Looked up when the child itself is placed
	// so the dot lands on the reserved lane. A child is either a primary
	// child (inherits, not in this map) or a secondary child (in this map).
	const childLane = new Map<string, number>();
	// activeLanes: lane → the lineage occupying it. A lane leaves activeLanes
	// once the chronological row reaches the lineage's endRow (the last
	// primary descendant's row).
	const activeLanes = new Map<number, Lineage>();

	const leftmostFreeLane = () => {
		let i = 0;
		while (activeLanes.has(i)) i++;
		return i;
	};
	const leftmostFreeLaneAbove = (above: number) => {
		let i = above + 1;
		while (activeLanes.has(i)) i++;
		return i;
	};

	for (let row = 0; row < all.length; row++) {
		const n = all[row];
		const parentId = parentOf.get(n.id) ?? null;
		let lane: number;

		if (parentId === null) {
			// Root — begin a new lineage on the leftmost free lane.
			lane = leftmostFreeLane();
			const lineage: Lineage = { lane, startRow: row, endRow: primaryChainLastRow.get(n.id)! };
			lineages.push(lineage);
			activeLanes.set(lane, lineage);
		} else if (childLane.has(n.id)) {
			// Pre-reserved secondary child — its lane and lineage were created
			// when the branch point was placed. Just record the lane for the dot.
			lane = childLane.get(n.id)!;
		} else {
			// Primary child — inherit the parent's lane. The lineage's endRow is
			// already the primary-chain last row; nothing to extend.
			lane = nodeLane.get(parentId)!;
		}

		nodeLane.set(n.id, lane);
		nodes.push({ node: n, lane, row, isOnActivePath: activePath.has(n.id) });

		// Branch point: for each secondary child, reserve a lane, emit a short
		// fork arc (landing half a row below this dot), and create the child's
		// lineage (vertical from the fork landing down to the child's primary-
		// chain end). Reserving here — at the branch point's row — keeps the
		// lane occupied through the rows where the new lane's vertical must
		// run, so a later fork can't grab it before the child arrives. Sibling
		// secondary children of the same branch point get separate lanes (no
		// intra-branch-point reuse); freed lanes are reused only by later
		// branch points' secondary children.
		const primary = primaryChildOf.get(n.id);
		for (const child of n.children) {
			if (child.id === primary) continue;
			const childLaneVal = leftmostFreeLaneAbove(lane);
			childLane.set(child.id, childLaneVal);
			const forkToRow = row + 0.5;
			forks.push({ fromRow: row, fromLane: lane, toRow: forkToRow, toLane: childLaneVal });
			const childLineage: Lineage = {
				lane: childLaneVal,
				startRow: forkToRow,
				endRow: primaryChainLastRow.get(child.id)!,
			};
			lineages.push(childLineage);
			activeLanes.set(childLaneVal, childLineage);
		}

		// Free lanes whose primary chain has ended. Git-correct: the vertical
		// ends at the last primary descendant's dot; later forks arc off the
		// branch point directly, not off a bare vertical.
		const freed: number[] = [];
		for (const [l, lin] of activeLanes) {
			if (row >= lin.endRow) freed.push(l);
		}
		for (const l of freed) activeLanes.delete(l);
	}

	// laneCount: max assigned lane + 1. nodeLane covers all nodes (roots,
	// primary inheritors, and secondary children whose lane was reserved then
	// looked up).
	let laneCount = 0;
	for (const l of nodeLane.values()) if (l + 1 > laneCount) laneCount = l + 1;

	return { nodes, lineages, forks, laneCount, rowCount: all.length };
}
