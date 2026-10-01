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
//          branch points (nodes with >1 child) fork to new lanes. Off-path
//          branch points pick the NEWEST child as primary (where the
//          conversation continued), and secondary lanes are assigned in
//          reverse chronological order — together these keep the re-edit
//          pattern (edit, continue, edit, continue …) on one lane instead
//          of forking one lane further right per cycle.
//
// The renderer (web/HistoryPane) consumes LaneLayout and draws SVG verticals
// + Bezier fork curves + positioned DOM dots/labels. No topology reasoning
// in the renderer.
//
// Browser-safe: no node:* imports, no DOM. Pure functions only. Lives in
// viewmodel/ alongside computeViewModel; exported from src/index.ts and
// exercised by scripts/browser-smoke-entry.ts.
// ============================================================================

import type { Document, Entry, LabelEntry, MessageEntry } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Pass 1 — History tree (logical structure)
// ---------------------------------------------------------------------------

export interface HistoryNode {
	id: string;
	/** First line of the user message's text content, truncated for one-line display. */
	text: string;
	timestamp: string;
	/**
	 * True when no user message exists anywhere in this message's subtree —
	 * the conversation never continued below it: an aborted draft, or a
	 * completed turn abandoned for (or edited into) a later sibling from the
	 * same branch point. Structural signal only; the keep-visible exclusion
	 * (a dead end you navigated back to stays expanded) is applied in
	 * `collapseSuperseded`, not here.
	 */
	deadEnd: boolean;
	/** Effective children (user messages whose nearest user ancestor is this node). */
	children: HistoryNode[];
	/**
	 * Superseded turns folded into this node: consecutive off-path dead-end
	 * siblings that preceded this node chronologically and were hidden from
	 * the lane graph to keep sibling dead ends from fanning into separate
	 * lanes. Empty for nodes that receive none and nodes with no preceding
	 * dead ends. The renderer shows a "+N" affordance when non-empty.
	 */
	supersededTurns: HistoryNode[];
	/**
	 * User-defined label resolved onto this message (see `resolveLabels`);
	 * undefined when unlabeled. Labels target user messages only here —
	 * labels on other entry kinds are never looked up.
	 */
	label?: string;
}

export interface HistoryTree {
	roots: HistoryNode[];
}

/** Truncate a user message to a one-line preview for the graph label. */
const PREVIEW_MAX = 80;

// ---------------------------------------------------------------------------
// Entry labels — user-defined bookmarks (pi LabelEntry), resolved for display
// ---------------------------------------------------------------------------

/**
 * Resolve label entries into a targetId → label map.
 *
 * A label is a user-defined bookmark set from pi's TUI tree selector
 * (`SessionManager.appendLabelChange`); it never enters LLM context. The
 * fold is chronological last-write-wins — the same rule as pi's
 * SessionManager — and an empty/undefined label clears the target's label.
 * The map holds every target; callers decide which targets they render
 * (both surfaces here render user messages only — labels on other entry
 * kinds are resolved but never looked up, best-effort by construction).
 */
export function resolveLabels(entries: Record<string, Entry>): Map<string, string> {
	const labelEntries: LabelEntry[] = [];
	for (const e of Object.values(entries)) {
		if (e.kind === "label") labelEntries.push(e);
	}
	if (labelEntries.length === 0) return new Map();
	labelEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
	const labels = new Map<string, string>();
	for (const e of labelEntries) {
		if (e.label) labels.set(e.targetId, e.label);
		else labels.delete(e.targetId);
	}
	return labels;
}

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

	const nodes = new Map<string, HistoryNode>();
	const effectiveParent = new Map<string, string | null>();
	for (const ue of userEntries) {
		nodes.set(ue.id, {
			id: ue.id,
			text: previewText(ue),
			timestamp: ue.timestamp,
			deadEnd: false,
			children: [],
			supersededTurns: [],
		});
		effectiveParent.set(ue.id, nearestUserAncestor(ue.id, doc.entries));
	}

	// A user message is a structural dead end when no other user message has
	// it as its nearest user ancestor: any user message in its subtree would
	// surface through the ancestor walk, so "no user-tree children" is
	// exactly "the conversation never continued below this message". Whether
	// a dead end actually folds is decided later in `collapseSuperseded` (the
	// keep-visible exclusion — a dead end you navigated back to stays a row).
	const hasUserTreeChild = new Set<string>();
	for (const p of effectiveParent.values()) if (p !== null) hasUserTreeChild.add(p);
	for (const ue of userEntries) nodes.get(ue.id)!.deadEnd = !hasUserTreeChild.has(ue.id);

	// Best-effort label resolution: user messages are the only labeled
	// surface here, so labels targeting other entry kinds resolve in the map
	// but are never looked up.
	const labels = resolveLabels(doc.entries);
	for (const ue of userEntries) {
		const label = labels.get(ue.id);
		if (label !== undefined) nodes.get(ue.id)!.label = label;
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
// Superseded-turn collapse — fold dead-end siblings into the following node
// ---------------------------------------------------------------------------

/**
 * Collapse superseded dead-end sibling runs into the following node.
 *
 * A "superseded turn" is a sibling user message that dead-ended
 * (`deadEnd: true` — no user message anywhere in its subtree: an aborted
 * draft, or a completed turn abandoned for / edited into a later sibling)
 * AND whose id is not in `keepVisible` (the active path, plus any branch the
 * caller is pinning — a dead end you navigated back to, or are peeking,
 * stays a row). Maximal runs of consecutive dead ends are removed from the
 * parent's children and attached to the following node's `supersededTurns`.
 * A trailing run with no following node promotes its chronologically-last
 * member to be the node (the most recent attempt stays visible) and attaches
 * the rest to it.
 *
 * This runs after `computeHistoryTree` and before `computeLaneLayout`: Pass 2
 * iterates `children`, so removing folded turns from children keeps them out
 * of the lane graph (no lane per dead end, no fan). The renderer surfaces
 * them via the following node's `supersededTurns` as an expandable "+N"
 * affordance — a UI overlay, not a graph relayout.
 *
 * Pure: returns a new tree; does not mutate the input.
 */
export function collapseSuperseded(tree: HistoryTree, keepVisible: Set<string>): HistoryTree {
	const collapseNode = (n: HistoryNode): HistoryNode => ({
		...n,
		children: collapseSiblings(n.children.map(collapseNode), keepVisible),
	});
	return { roots: collapseSiblings(tree.roots.map(collapseNode), keepVisible) };
}

/**
 * Collapse one sibling list. Dead ends (structural dead end + not kept
 * visible) are pulled out and attached to the following node's
 * `supersededTurns`; a trailing run promotes its last member. `siblings`
 * must be sorted chronologically (Pass 1 sorts roots and children).
 */
function collapseSiblings(siblings: HistoryNode[], keepVisible: Set<string>): HistoryNode[] {
	const result: HistoryNode[] = [];
	let run: HistoryNode[] = []; // consecutive dead ends awaiting a node to attach to

	for (const s of siblings) {
		if (s.deadEnd && !keepVisible.has(s.id)) {
			run.push(s);
			continue;
		}
		// s is a continued sibling. Attach the pending run to it.
		if (run.length > 0) {
			result.push({ ...s, supersededTurns: [...s.supersededTurns, ...run] });
			run = [];
		} else {
			result.push(s);
		}
	}

	// Trailing run with no following node: promote the chronologically-last
	// member (siblings are sorted) as the node, attach the rest to it.
	if (run.length > 0) {
		const last = run[run.length - 1];
		const rest = run.slice(0, -1);
		result.push({ ...last, supersededTurns: [...last.supersededTurns, ...rest] });
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
 * 2. **Primary child** (the child on the active path, or the NEWEST child
 *    when the branch point is off the active path) → inherits the parent's
 *    lane. No fork is drawn. This is what keeps linear follow-ups on one
 *    vertical line. Newest, not oldest: in the re-edit pattern the
 *    conversation continues on the last edit, so the newest sibling is
 *    where history went. If the oldest (the superseded original) inherited
 *    the lane, the continuation chain would be a chain of secondaries, each
 *    forking one lane further right per edit cycle — unbounded lane growth
 *    whenever the active leaf is shallower than the chronological spine
 *    (i.e. after a revisit-edit of a history node).
 * 3. **Secondary child** → a lane reserved for it when its branch point is
 *    placed (not when the child itself is placed), assigned in REVERSE
 *    chronological order (the newest secondary takes the lane nearest the
 *    parent) so the continuation sibling is not pushed one lane out per
 *    earlier dead sibling. The reservation emits a
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

	// Primary child per node: the child on the active path, or the newest
	// child (children are sorted by timestamp in Pass 1). Newest, not oldest:
	// the newest sibling is where the conversation chronologically continued;
	// making it inherit keeps the continuation chain on one lane instead of
	// cascading one lane further right per re-edit cycle (see the rules above).
	const primaryChildOf = new Map<string, string | null>();
	for (const n of all) {
		if (n.children.length === 0) {
			primaryChildOf.set(n.id, null);
			continue;
		}
		const onPath = n.children.find((c) => activePath.has(c.id));
		primaryChildOf.set(n.id, onPath ? onPath.id : n.children[n.children.length - 1].id);
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
		// run, so a later fork can't grab it before the child arrives. Children
		// are visited in REVERSE chronological order so the newest secondary
		// takes the lane nearest the parent — the re-edit continuation starts
		// as close to the spine as possible instead of being pushed one lane
		// out per earlier dead sibling. Sibling secondary children of the same
		// branch point get separate lanes (no intra-branch-point reuse); freed
		// lanes are reused only by later branch points' secondary children.
		const primary = primaryChildOf.get(n.id);
		for (let i = n.children.length - 1; i >= 0; i--) {
			const child = n.children[i];
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
