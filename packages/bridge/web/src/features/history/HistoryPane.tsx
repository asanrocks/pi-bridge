// ============================================================================
// HistoryPane — git-log-style branch graph of user messages, as a docked
// right pane (desktop) / right drawer (mobile). Replaces the prior centered
// modal: history is a spatial reference you orient by, not a transient
// action — so it stays open, shares the viewport with the conversation, and
// publishes --history-w so the TopBar and .body gutter track it.
//
// Graph rendering (lane layout, fork curves, node rows) is unchanged from the
// former TreeDialog; only the container changed (docked pane / drawer vs.
// modal) and the click semantics (see selectEntry).
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, TextContent } from "../../../../src/core/types.ts";
import {
	collapseDrafts,
	computeActiveUserPath,
	computeHistoryTree,
	computeLaneLayout,
	type Fork,
	type HistoryNode,
	type LaneLayout,
	type Lineage,
	newestLeafInSubtree,
	type PlacedNode,
} from "../../../../src/viewmodel/index.ts";
import { useMediaQuery } from "../../infra/lib/useMediaQuery.ts";
import { useRpc } from "../../infra/net/useRpc.ts";
import { getStore, useStore } from "../../infra/state/store.tsx";
import { type PaneResizeController, ResizeHandle, usePaneResize } from "../../render/ResizeHandle.tsx";
import styles from "./HistoryPane.module.css";

// ---------------------------------------------------------------------------
// Geometry — fixed for the whole pane so SVG coordinates are computable
// upfront without DOM measurement. The conversation tree is bounded (tens
// of user messages), so fixed row height is not a constraint.
// ---------------------------------------------------------------------------

const LANE_WIDTH = 24;
const ROW_HEIGHT = 32;
const DOT_RADIUS = 5;
const GRAPH_PAD_LEFT = 12;
const GRAPH_PAD_RIGHT = 12;
const GUTTER_GAP = 12;
const TIME_COL_W = 44;
const COL_GAP = 8;
const DRAFTS_BADGE_W = 28;
const ROW_RIGHT_PAD = 12;

/** Minimum width the message text column keeps even when the lane graph is
 *  wide. Combined with --canvas-w, wide graphs overflow the .scroll container
 *  (which then scrolls horizontally) instead of squeezing the text to nothing. */
const MIN_TEXT_W = 220;

/** Default desktop docked-pane width (also the resize double-click reset).
 *  Bounds keep the graph's fixed columns (gutter + time + MIN_TEXT_W)
 *  reachable; the upper bound is additionally viewport-capped at 45%.
 *  Published as --history-w so the TopBar and .body right gutter track it.
 *  Mobile uses a drawer (no gutter, no handle). */
const PANE_DEFAULT_W = 400;
const PANE_MIN_W = 280;
const PANE_MAX_W = 560;

const PANE_BREAKPOINT = "(min-width: 768px)";

function laneX(lane: number): number {
	return GRAPH_PAD_LEFT + lane * LANE_WIDTH;
}

function rowY(row: number): number {
	return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** Smooth cubic-Bezier fork arc with vertical tangents at both ends. See the
 *  former TreeDialog for the geometry rationale (git/VScode local fork). */
function forkPath(f: Fork): string {
	const x0 = laneX(f.fromLane);
	const y0 = rowY(f.fromRow);
	const x1 = laneX(f.toLane);
	const y1 = rowY(f.toRow);
	const dy = y1 - y0;
	if (dy <= 0) return `M ${x0} ${y0} L ${x1} ${y1}`;
	const cp = dy / 2;
	return `M ${x0} ${y0} C ${x0} ${y0 + cp} ${x1} ${y1 - cp} ${x1} ${y1}`;
}

// ---------------------------------------------------------------------------
// HistoryPane
// ---------------------------------------------------------------------------

export const HistoryPane = memo(function HistoryPane() {
	const open = useStore((s) => s.historyOpen);
	const isWide = useMediaQuery(PANE_BREAKPOINT);

	// Resizable pane (desktop): owns the width, persists it, and publishes
	// --history-w so the TopBar (left/right bindings) and .body (right
	// gutter) clear the docked pane. 0 when closed or mobile (drawer is
	// off-canvas, like the sidebar overlay).
	const resize = usePaneResize({
		cssVar: "--history-w",
		storageKey: "pi-bridge:history-w",
		defaultWidth: PANE_DEFAULT_W,
		min: PANE_MIN_W,
		max: PANE_MAX_W,
		active: isWide && open,
	});

	if (!open) return null;
	if (isWide) return <HistoryPaneDocked resize={resize} />;
	return <HistoryPaneDrawer />;
});

// ---------------------------------------------------------------------------
// HistoryPaneDocked — desktop: fixed right rail, full height, inline chrome.
// The handle is a fixed-position sibling (not a child) so the pane's
// overflow: hidden can't clip it; it centers on the pane border.
// ---------------------------------------------------------------------------

const HistoryPaneDocked = memo(function HistoryPaneDocked({ resize }: { resize: PaneResizeController }) {
	return (
		<>
			<div className={styles.pane} style={{ width: resize.width }}>
				<HistoryPaneBody />
			</div>
			<ResizeHandle controller={resize} edge="left" label="Resize history pane" />
		</>
	);
});

// ---------------------------------------------------------------------------
// HistoryPaneDrawer — mobile: slide-over from the right + dismiss backdrop.
// ---------------------------------------------------------------------------

const HistoryPaneDrawer = memo(function HistoryPaneDrawer() {
	const close = useCallback(() => getStore().getState().setHistoryOpen(false), []);
	return (
		<>
			<button type="button" className={styles.backdrop} onClick={close} aria-label="Close history" />
			<div className={styles.drawer}>
				<HistoryPaneBody />
			</div>
		</>
	);
});

// ---------------------------------------------------------------------------
// HistoryPaneBody — shared header + scrollable graph. The layout recomputes
// from the document on each render (the graph is small — tens of nodes — so
// the cost is negligible and the streaming-append case just extends the SVG).
// ---------------------------------------------------------------------------

const HistoryPaneBody = memo(function HistoryPaneBody() {
	const document = useStore((s) => s.document);
	const leafId = document.status.leafId;
	const entries = document.entries;
	const isBusy = useStore((s) => s.document.status.isStreaming || s.document.status.isCompacting);
	const rpc = useRpc();

	const layout: LaneLayout = useMemo(() => {
		const tree = computeHistoryTree(document);
		const activePath = computeActiveUserPath(document, leafId);
		const collapsed = collapseDrafts(tree, activePath);
		return computeLaneLayout(collapsed, activePath);
	}, [document, leafId]);

	const containerRef = useRef<HTMLDivElement | null>(null);
	// The deepest on-path node — the user message closest to the active leaf.
	// After an assistant reply, leafId is an assistant message, so `id === leafId`
	// would match nothing; anchoring the "current" dot to the deepest on-path
	// node keeps the position marker stable across assistant turns.
	const currentRow = useMemo(() => {
		let deepest = -1;
		for (let i = 0; i < layout.nodes.length; i++) {
			if (layout.nodes[i].isOnActivePath) deepest = i;
		}
		return deepest;
	}, [layout]);

	const currentNodeId = useMemo(() => {
		if (currentRow < 0) return null;
		return layout.nodes[currentRow].node.id;
	}, [layout, currentRow]);

	// Scroll the active-leaf row into view on open only. Re-scrolling on
	// every leaf change while open would fight a user who scrolled up to
	// browse older branches; the "current" dot highlight (currentNodeId,
	// computed in render) tracks the leaf without moving the scroll.
	const open = useStore((s) => s.historyOpen);
	useEffect(() => {
		if (!open || currentRow < 0) return;
		const el = containerRef.current;
		if (!el) return;
		const target = currentRow * ROW_HEIGHT + ROW_HEIGHT / 2;
		el.scrollTop = Math.max(0, target - el.clientHeight / 2);
	}, [open, currentRow]);

	// Draft-expand state is local to this pane instance (not the store) —
	// it resets on close, so re-opening starts with all drafts collapsed.
	const [expandedDrafts, setExpandedDrafts] = useState<Set<string>>(new Set());
	const toggleDrafts = useCallback((keeperId: string) => {
		setExpandedDrafts((s) => {
			const next = new Set(s);
			if (next.has(keeperId)) next.delete(keeperId);
			else next.add(keeperId);
			return next;
		});
	}, []);

	// Decoupled look/go (Q3): clicking a node has two possible effects —
	//   (a) look: anchor-scroll the conversation to it (setScrollToEntryId),
	//       always safe — pure client scroll;
	//   (b) go:   navigate/branch the active path to the subtree's newest leaf,
	//       racy mid-stream — navigate rewrites agent.state.messages while a
	//       turn is in-flight (manager.ts:431) and tryReconcile is suppressed
	//       during streaming (manager.ts:330).
	// During streaming: on-path nodes do look-only (they're already on the
	// active branch, so `go` would be a no-op anyway — the scroll is the
	// whole effect). Off-path nodes can't be scrolled (not rendered — the VM
	// only projects the active path) and branching is the racy part, so they
	// stay disabled (NodeRow disabled flag) with a "jump after reply" tooltip.
	// newestLeafInSubtree is NOT computed for the look-only path: it can
	// return an off-path leaf even for an on-path ancestor (a sibling subtree
	// with a newer timestamp), which is irrelevant to a pure scroll.
	const selectEntry = useCallback(
		(entryId: string, isOnPath: boolean) => {
			if (isBusy) {
				if (!isOnPath) return; // safety net; off-path rows are disabled at the row
				getStore().getState().setScrollToEntryId(entryId);
				return;
			}
			const targetLeaf = newestLeafInSubtree(entryId, entries);
			getStore().getState().setScrollToEntryId(entryId);
			void rpc.navigate(targetLeaf);
		},
		[isBusy, entries, rpc],
	);

	if (layout.nodes.length === 0) {
		return (
			<>
				<HistoryHeader />
				<div className={styles.empty}>No messages yet.</div>
			</>
		);
	}

	const graphWidth = GRAPH_PAD_LEFT + layout.laneCount * LANE_WIDTH + GRAPH_PAD_RIGHT;
	const gutterWidth = graphWidth + GUTTER_GAP;
	// Canvas width = graph + fixed columns + MIN_TEXT_W of text. When this
	// exceeds the pane, .content grows to it and .scroll scrolls horizontally
	// (the "slider") — text stays readable instead of clipping off-canvas.
	const canvasWidth = gutterWidth + TIME_COL_W + COL_GAP + MIN_TEXT_W + ROW_RIGHT_PAD;
	const totalHeight = layout.rowCount * ROW_HEIGHT;

	return (
		<>
			<HistoryHeader />
			<div className={styles.scroll} ref={containerRef}>
				<div
					className={styles.content}
					style={
						{
							height: totalHeight,
							["--canvas-w" as string]: `${canvasWidth}px`,
							["--gutter-width" as string]: `${gutterWidth}px`,
							["--time-col-w" as string]: `${TIME_COL_W}px`,
							["--col-gap" as string]: `${COL_GAP}px`,
							["--drafts-badge-w" as string]: `${DRAFTS_BADGE_W}px`,
							["--row-right-pad" as string]: `${ROW_RIGHT_PAD}px`,
						} as React.CSSProperties
					}
				>
					<svg className={styles.graph} width={graphWidth} height={totalHeight} aria-hidden="true">
						{/* Vertical lineage lines */}
						{layout.lineages.map((l: Lineage) => (
							<line
								key={`line-${l.lane}:${l.startRow}-${l.endRow}`}
								x1={laneX(l.lane)}
								y1={rowY(l.startRow)}
								x2={laneX(l.lane)}
								y2={rowY(l.endRow)}
								className={styles.lineageLine}
							/>
						))}
						{/* Fork curves */}
						{layout.forks.map((f: Fork) => (
							<path
								key={`fork-${f.fromLane}:${f.fromRow}-${f.toLane}:${f.toRow}`}
								d={forkPath(f)}
								className={styles.forkCurve}
								fill="none"
							/>
						))}
					</svg>
					{/* DOM rows — dots + meta + text, absolutely positioned over the SVG */}
					{layout.nodes.map((n) => (
						<NodeRow
							key={n.node.id}
							node={n}
							gutterWidth={gutterWidth}
							isCurrentLeaf={n.node.id === currentNodeId}
							onSelectEntry={selectEntry}
							onToggleDrafts={toggleDrafts}
							expandedDrafts={expandedDrafts}
							isBusy={isBusy}
							entries={entries}
						/>
					))}
				</div>
			</div>
		</>
	);
});

// ---------------------------------------------------------------------------
// HistoryHeader — title + close. The close button toggles historyOpen in the
// store (the TopBar button does the same from the other end).
// ---------------------------------------------------------------------------

const HistoryHeader = memo(function HistoryHeader() {
	const close = useCallback(() => getStore().getState().setHistoryOpen(false), []);
	return (
		<div className={styles.header}>
			<span className={styles.title}>History</span>
			<button type="button" className={styles.closeBtn} onClick={close} aria-label="Close history">
				×
			</button>
		</div>
	);
});

// ---------------------------------------------------------------------------
// NodeRow — one row: dot (in the graph gutter) + time + drafts chip + text.
//
// The row is a flex container (graph gutter spacer + meta + text). The dot
// stays absolutely positioned in the gutter at the node's lane so it aligns
// with the SVG coordinate space; the spacer reserves the gutter width so
// the flex columns start after the graph. Text owns the flex remainder and
// truncates with CSS ellipsis — no JS preview slicing.
//
// Disabled logic (Q3): during streaming, off-path rows are disabled (can't
// branch mid-stream; not rendered so can't scroll either); on-path rows stay
// clickable for look-only anchoring. Non-streaming: all rows clickable (full
// navigate). The drafts badge stays interactive even on a disabled row so a
// draft's popover can still open — drafts are off-path by definition and
// their rows are individually disabled, not the badge.
// ---------------------------------------------------------------------------

const NodeRow = memo(function NodeRow({
	node,
	gutterWidth,
	isCurrentLeaf,
	onSelectEntry,
	onToggleDrafts,
	expandedDrafts,
	isBusy,
	entries,
}: {
	node: PlacedNode;
	gutterWidth: number;
	isCurrentLeaf: boolean;
	onSelectEntry: (entryId: string, isOnPath: boolean) => void;
	onToggleDrafts: (keeperId: string) => void;
	expandedDrafts: Set<string>;
	isBusy: boolean;
	entries: Record<string, Entry>;
}) {
	const top = node.row * ROW_HEIGHT;
	const dotLeft = laneX(node.lane) - DOT_RADIUS;
	const text = node.node.text || "(empty)";
	const time = formatTime(node.node.timestamp);
	const drafts = node.node.discardedDrafts;
	const hasDrafts = drafts.length > 0;
	const isExpanded = expandedDrafts.has(node.node.id);
	// Off-path rows are disabled during streaming (can't branch mid-turn).
	// On-path rows stay clickable for look-only anchoring.
	const disabledByStreaming = isBusy && !node.isOnActivePath;
	const rowCls = [
		styles.row,
		node.isOnActivePath ? styles.rowOnPath : "",
		isCurrentLeaf ? styles.rowCurrent : "",
		disabledByStreaming ? styles.rowDisabled : "",
	]
		.filter(Boolean)
		.join(" ");

	// The row is a div role=button (not a <button>) so the drafts badge and
	// the popover's draft buttons don't nest interactive content inside a
	// button — invalid interactive-content nesting, same constraint the
	// backdrop works around; a div role=button is the semantic compromise.
	return (
		<>
			{/* biome-ignore lint/a11y/useSemanticElements: a real <button> can't contain the drafts badge <button> — invalid interactive-content nesting, same constraint backdropBtn works around; a div role=button is the semantic compromise */}
			<div
				role="button"
				tabIndex={disabledByStreaming ? -1 : 0}
				aria-disabled={disabledByStreaming || undefined}
				aria-label={text === "(empty)" ? "Empty message" : text}
				className={rowCls}
				style={{ top, height: ROW_HEIGHT }}
				onClick={() => {
					if (!disabledByStreaming) onSelectEntry(node.node.id, node.isOnActivePath);
				}}
				onKeyDown={(e) => {
					if (disabledByStreaming) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSelectEntry(node.node.id, node.isOnActivePath);
					}
				}}
				title={disabledByStreaming ? "Jump after reply" : fullMessageText(entries, node.node.id) || node.node.text}
			>
				<span className={styles.dotCell} style={{ left: dotLeft, width: DOT_RADIUS * 2 }}>
					<span
						className={`${styles.dot} ${node.isOnActivePath ? styles.dotOnPath : ""} ${isCurrentLeaf ? styles.dotCurrent : ""}`}
					/>
				</span>
				<span className={styles.graphGutter} aria-hidden="true" />
				<span className={styles.timeCol}>
					<span className={styles.timeText}>{time}</span>
				</span>
				{hasDrafts && (
					<button
						type="button"
						className={`${styles.draftsBadge} ${isExpanded ? styles.draftsBadgeOpen : ""}`}
						onClick={(e) => {
							e.stopPropagation();
							onToggleDrafts(node.node.id);
						}}
						aria-expanded={isExpanded}
						aria-label={`${drafts.length} discarded draft${drafts.length > 1 ? "s" : ""}`}
						title={`${drafts.length} aborted re-edit${drafts.length > 1 ? "s" : ""}`}
					>
						+{drafts.length}
					</button>
				)}
				<span className={styles.textCol}>
					<span className={styles.textInner}>{text}</span>
				</span>
			</div>
			{hasDrafts && isExpanded && (
				// Popover anchors at the gutter's right edge (under the +N chip's
				// column) and extends rightward into the text area where the
				// visual mass is, capped so it can't run off the right edge.
				<div
					className={styles.draftsPopover}
					style={{ top: top + ROW_HEIGHT, left: gutterWidth + TIME_COL_W + COL_GAP }}
				>
					{drafts.map((d: HistoryNode) => (
						<button
							key={d.id}
							type="button"
							className={styles.draftRow}
							onClick={() => onSelectEntry(d.id, false)}
							disabled={isBusy}
							title={isBusy ? "Jump after reply" : fullMessageText(entries, d.id) || d.text}
						>
							<span className={styles.draftDot} />
							<span className={styles.draftText}>{d.text || "(empty)"}</span>
							<span className={styles.draftTime}>{formatTime(d.timestamp)}</span>
						</button>
					))}
				</div>
			)}
		</>
	);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
	try {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "";
		const hh = String(d.getHours()).padStart(2, "0");
		const mm = String(d.getMinutes()).padStart(2, "0");
		return `${hh}:${mm}`;
	} catch {
		return "";
	}
}

/** Full message text for hover tooltips. Unlike the viewmodel's previewText
 *  (first line, ≤80 chars — the right thing for the row label), this joins
 *  all text blocks preserving newlines so the native title tooltip reveals
 *  the whole message, not the truncated label. */
function fullMessageText(entries: Record<string, Entry>, entryId: string): string {
	const e = entries[entryId];
	if (!e || e.kind !== "message") return "";
	return e.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n\n")
		.trim();
}
