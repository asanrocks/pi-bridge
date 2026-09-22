// ============================================================================
// HistoryPane — git-log-style branch graph of user messages, as the right
// side pane. Container is the shared PaneShell (hidden / docked rail /
// fullscreen overlay, drag-overshoot, edge-reveal, hover-peek — the Sidebar's
// UX, mirrored); this module supplies the pane's bounds, its header chrome,
// and the graph body. Mode lives with useHistoryPaneShell.
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
import { formatTimestamp } from "../../infra/lib/time.ts";
import { useRpc } from "../../infra/net/useRpc.ts";
import { getStore, useStore } from "../../infra/state/store.tsx";
import { resolveRenderLeafTarget, selectRenderDiverged } from "../../infra/state/ui.ts";
import { PaneShell } from "../../render/PaneShell.tsx";
import type { PaneMode } from "../../render/usePaneMode.ts";
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
 *  Published as --history-w so the TopBar and .body right gutter track it. */
const PANE_DEFAULT_W = 400;
const PANE_MIN_W = 280;
const PANE_MAX_W = 560;

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
// HistoryPane — the shared PaneShell on the right side: tri-mode, resizable
// rail, drag-overshoot, edge-reveal, hover-peek. The pane supplies only
// bounds, header chrome, and the graph body.
// ---------------------------------------------------------------------------

export const HistoryPane = memo(function HistoryPane({
	isWide,
	mode,
	setMode,
	historyHover,
}: {
	isWide: boolean;
	mode: PaneMode;
	setMode: React.Dispatch<React.SetStateAction<PaneMode>>;
	/** Raw hover signal from the TopBar history button — drives the peek
	 *  drawer (PaneShell owns it). */
	historyHover: boolean;
}) {
	// The pane is the conversation branch graph. The repository-evolution
	// timeline is now the transcript itself: each user turn's git chip menu
	// lists the commits observed during that turn, and the TopBar's dirty-now
	// badge owns the live worktree comparison.
	return (
		<PaneShell
			side="right"
			isWide={isWide}
			mode={mode}
			setMode={setMode}
			cssVar="--history-w"
			storageKey="pi-bridge:history-w"
			defaultWidth={PANE_DEFAULT_W}
			min={PANE_MIN_W}
			max={PANE_MAX_W}
			label="history"
			hoverSignal={historyHover}
			renderHeader={(variant, actions) => (
				// The peek's pin wears the pane's own clock glyph (the TopBar
				// toggle's icon); rail/fullscreen carry the ✕ close.
				<HistoryHeader
					onClose={variant === "peek" ? actions.pin : variant === "rail" ? actions.hide : actions.dismiss}
					dock={variant === "peek"}
				/>
			)}
		>
			{(api) => <HistoryPaneBody open={mode !== "hidden"} onPick={api.dismissAfterPick} />}
		</PaneShell>
	);
});

// ---------------------------------------------------------------------------
// HistoryPaneBody — the scrollable graph. The layout recomputes
// from the document on each render (the graph is small — tens of nodes — so
// the cost is negligible and the streaming-append case just extends the SVG).
// ---------------------------------------------------------------------------

const HistoryPaneBody = memo(function HistoryPaneBody({
	open,
	onPick,
}: {
	/** True in every open mode (rail / peek / fullscreen) — drives the
	 *  scroll-to-active-row effect on open. */
	open: boolean;
	/** Dismiss transient surfaces after a row pick (PaneShell's
	 *  dismissAfterPick: mobile fullscreen closes, desktop fullscreen backs
	 *  off to the rail, the peek drawer hides). */
	onPick: () => void;
}) {
	const document = useStore((s) => s.document);
	const leafId = document.status.leafId;
	const entries = document.entries;
	const isBusy = useStore((s) => s.document.status.isStreaming || s.document.status.isCompacting);
	const renderLeafId = useStore((s) => s.renderLeafId);
	const rpc = useRpc();

	// The rendered (peeked) user-path set, for the second row highlight. Only
	// user-message rows exist in the graph, so membership of the rendered
	// entry-id chain is the whole check.
	const renderedPathIds = useMemo(() => {
		if (renderLeafId === null) return null;
		const ids = new Set<string>();
		let cursor: string | null = renderLeafId;
		while (cursor) {
			ids.add(cursor);
			cursor = entries[cursor]?.parentId ?? null;
		}
		return ids;
	}, [renderLeafId, entries]);

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

	// Click matrix (peek model):
	//   diverged (rendering leaf pinned)      → re-target the peek: pin the
	//       subtree's newest leaf (setRenderLeaf clamps uncommitted targets);
	//       browse never mutates the session.
	//   synced + busy, on-path node           → look-only anchor scroll (the
	//       node is already rendered; navigating would be a no-op and a fork
	//       mid-turn would race the run — manager.navigate rejects it).
	//   synced + busy, off-path node          → peek (was: disabled row).
	//   synced + idle                          → navigate/branch the active path
	//       to the subtree's newest leaf (today's behavior).
	const diverged = useStore(selectRenderDiverged);
	const selectEntry = useCallback(
		(entryId: string, isOnPath: boolean) => {
			// Any row pick dismisses transient surfaces first — in fullscreen the
			// picked conversation surface is behind the overlay, in the peek the
			// drawer would otherwise linger on its grace delay.
			onPick();
			const s = getStore().getState();
			const targetLeaf = newestLeafInSubtree(entryId, entries);
			if (diverged || (isBusy && !isOnPath)) {
				// Peek re-target. Anchor at what will actually render, not the
				// clicked id: a pending in-flight entry (e.g. the live branch's
				// mid-turn node, clicked while peeking) clamps to a committed
				// ancestor and never appears on the peeked path — anchoring the
				// raw id would strand §4's pending scroll forever. null (the pin
				// normalized to follow-live) means the clicked node sits on the
				// live path and renders after the flip. undefined (pin was a
				// no-op) means the view is unchanged — no anchor at all.
				s.setRenderLeaf(targetLeaf);
				const pinned = resolveRenderLeafTarget(entries, targetLeaf, s.document.status.leafId);
				if (pinned !== undefined) s.setScrollToEntryId(pinned ?? entryId);
				return;
			}
			s.setScrollToEntryId(entryId);
			if (isBusy) return; // on-path look-only: the scroll above is the effect
			void rpc.navigate(targetLeaf).then((reply) => {
				// The daemon is the enforcement point: a turn may have started
				// between the idle check above and the RPC (a steer from the
				// composer, or another tab). The branch never rendered — drop the
				// anchor instead of stranding §4's pending scroll.
				if (!reply?.ok) s.setScrollToEntryId(null);
			});
		},
		[diverged, isBusy, entries, rpc, onPick],
	);

	if (layout.nodes.length === 0) {
		return <div className={styles.empty}>No messages yet.</div>;
	}

	const graphWidth = GRAPH_PAD_LEFT + layout.laneCount * LANE_WIDTH + GRAPH_PAD_RIGHT;
	const gutterWidth = graphWidth + GUTTER_GAP;
	// Canvas width = graph + fixed columns + MIN_TEXT_W of text. When this
	// exceeds the pane, .content grows to it and .scroll scrolls horizontally
	// (the "slider") — text stays readable instead of clipping off-canvas.
	const canvasWidth = gutterWidth + TIME_COL_W + COL_GAP + MIN_TEXT_W + ROW_RIGHT_PAD;
	const totalHeight = layout.rowCount * ROW_HEIGHT;

	return (
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
						isOnRenderedPath={renderedPathIds?.has(n.node.id) ?? false}
						onSelectEntry={selectEntry}
						onToggleDrafts={toggleDrafts}
						expandedDrafts={expandedDrafts}
						entries={entries}
					/>
				))}
			</div>
		</div>
	);
});

// ---------------------------------------------------------------------------
// HistoryHeader — title + toggle. The action is variant-dependent (rail ✕
// hides, fullscreen ✕ dismisses, peek clock pins the rail — the pane's own
// TopBar glyph, the escape hatch from hover-only access); PaneShell passes
// the resolved one. Matches the Sidebar's section-header chrome: a quiet
// uppercase label with an action button in the right slot, no chrome bar /
// border-bottom, so the two panes share a top-edge treatment.
// ---------------------------------------------------------------------------

const HistoryHeader = memo(function HistoryHeader({
	onClose,
	dock,
}: {
	onClose: () => void;
	/** Peek variant — the button pins the rail open rather than closing. */
	dock: boolean;
}) {
	return (
		<div className={styles.header}>
			<span className={styles.title}>History</span>
			<button
				type="button"
				className={styles.closeBtn}
				onClick={onClose}
				aria-label={dock ? "Open history pane" : "Close history"}
				title={dock ? "Open history pane" : "Close history"}
			>
				{dock ? (
					<svg
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						aria-hidden="true"
					>
						<circle cx="12" cy="12" r="9" />
						<path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				) : (
					"×"
				)}
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
// All rows are clickable in every state (peek model): the click matrix in
// selectEntry decides navigate vs peek vs look-only anchor. The rendered
// (peeked) path gets a second row highlight alongside the live-path one.
// ---------------------------------------------------------------------------

const NodeRow = memo(function NodeRow({
	node,
	gutterWidth,
	isCurrentLeaf,
	isOnRenderedPath,
	onSelectEntry,
	onToggleDrafts,
	expandedDrafts,
	entries,
}: {
	node: PlacedNode;
	gutterWidth: number;
	isCurrentLeaf: boolean;
	isOnRenderedPath: boolean;
	onSelectEntry: (entryId: string, isOnPath: boolean) => void;
	onToggleDrafts: (keeperId: string) => void;
	expandedDrafts: Set<string>;
	entries: Record<string, Entry>;
}) {
	const top = node.row * ROW_HEIGHT;
	const dotLeft = laneX(node.lane) - DOT_RADIUS;
	const text = node.node.text || "(empty)";
	const time = formatTimestamp(node.node.timestamp);
	const drafts = node.node.discardedDrafts;
	const hasDrafts = drafts.length > 0;
	const isExpanded = expandedDrafts.has(node.node.id);
	const rowCls = [
		styles.row,
		node.isOnActivePath ? styles.rowOnPath : "",
		isOnRenderedPath ? styles.rowOnRenderedPath : "",
		isCurrentLeaf ? styles.rowCurrent : "",
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
				tabIndex={0}
				aria-label={text === "(empty)" ? "Empty message" : text}
				className={rowCls}
				style={{ top, height: ROW_HEIGHT }}
				onClick={() => onSelectEntry(node.node.id, node.isOnActivePath)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onSelectEntry(node.node.id, node.isOnActivePath);
					}
				}}
				title={fullMessageText(entries, node.node.id) || node.node.text}
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
							title={fullMessageText(entries, d.id) || d.text}
						>
							<span className={styles.draftDot} />
							<span className={styles.draftText}>{d.text || "(empty)"}</span>
							<span className={styles.draftTime}>{formatTimestamp(d.timestamp)}</span>
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
