// ============================================================================
// PaneShell — the shared container for the docked side panes (Sidebar left,
// HistoryPane right). Owns everything mode-adjacent that a pane would
// otherwise have to re-derive — and get subtly wrong — per pane:
//
//   - the resize controller (width, bounds, persistence, --pane-w publishing,
//     with `active` correctly coupled to mode/drag state)
//   - the drag-overshoot choreography: crossing below min snaps the rail
//     shut, above max snaps the fullscreen overlay in — live mid-drag, with
//     the release deciding on the same predicate, so the on-screen state
//     never lies about what a release would do
//   - the edge-reveal strip (drag open from the pane's screen edge)
//   - the hover-peek drawer (driven by the pane's TopBar toggle hover)
//   - Esc dismissal of the fullscreen overlay
//
// The pane supplies policy, not layout: mode comes in as a prop (the pane's
// shell hook owns it via usePaneMode, so it survives pane unmounts), the
// header is a render prop (the pane's own chrome, e.g. the sidebar's
// TopBar-aligned corner toggle), and the content is a children render
// function whose `dismissAfterPick` closes transient surfaces after a
// navigation pick — mobile fullscreen closes, desktop fullscreen backs off
// to the rail, the peek drawer hides now.
//
// Mount invariants (previously prose in the sidebar, now structure):
// the desktop fragment renders all five surfaces through one return path —
// an early return would unmount the ResizeHandle mid-drag, silently
// releasing its pointer capture (stuck overlay + stuck resize cursor). The
// handle stays mounted beneath the fullscreen overlay of a max preview
// (pointer capture ignores hit-testing); only the rail div swaps out.
// ============================================================================

import { memo, useCallback, useEffect, useState } from "react";
import styles from "./PaneShell.module.css";
import { ResizeHandle, usePaneResize } from "./ResizeHandle.tsx";
import { useEdgeReveal } from "./useEdgeReveal.ts";
import type { PaneMode } from "./usePaneMode.ts";
import { usePeekDrawer } from "./usePeekDrawer.ts";

/** Which screen edge the pane docks to. */
export type PaneSide = "left" | "right";

/** Which surface the header/content render into. */
export type PaneVariant = "rail" | "peek" | "fullscreen";

export interface PaneShellHeaderActions {
	/** Close the pane → hidden (rail/peek headers). */
	hide: () => void;
	/** Pin the rail open → rail (peek headers — the escape hatch from
	 *  hover-only access). */
	pin: () => void;
	/** Dismiss the fullscreen overlay → rail on desktop, hidden on mobile. */
	dismiss: () => void;
}

export interface PaneShellContentApi {
	/** Post-pick dismissal: mobile fullscreen closes, desktop fullscreen
	 *  backs off to the rail (the picked surface is behind the overlay),
	 *  the peek drawer hides immediately. A no-op in rail mode. */
	dismissAfterPick: () => void;
}

export const PaneShell = memo(function PaneShell({
	side,
	isWide,
	mode,
	setMode,
	cssVar,
	storageKey,
	defaultWidth,
	min,
	max,
	label,
	hoverSignal,
	renderHeader,
	children,
}: {
	side: PaneSide;
	/** Desktop breakpoint state — the rail exists only while wide. */
	isWide: boolean;
	mode: PaneMode;
	setMode: React.Dispatch<React.SetStateAction<PaneMode>>;
	/** Remaining props configure the pane's resize controller. */
	cssVar: string;
	storageKey: string;
	defaultWidth: number;
	min: number;
	max: number;
	/** Pane name for affordance labels ("sidebar", "history"). */
	label: string;
	/** Raw hover signal from the pane's TopBar toggle button: true while
	 *  the pointer is over it. Drives the peek drawer; absent/false means
	 *  no peek. */
	hoverSignal: boolean;
	/** The pane's header chrome, rendered at the top of every surface.
	 *  One row per variant so the toggle affordance can differ (the
	 *  sidebar's peek shows its pin, rail/fullscreen an ✕). */
	renderHeader: (variant: PaneVariant, actions: PaneShellHeaderActions) => React.ReactNode;
	/** The pane body, shared by every surface. A render function so picks
	 *  inside the content can call dismissAfterPick. */
	children: (api: PaneShellContentApi) => React.ReactNode;
}) {
	// Live overshoot preview from the rail's resize handle: crossing below
	// min snaps the rail shut (and back open when dragged wider); crossing
	// above max snaps the fullscreen overlay in (and back out) — the on-screen
	// state always matches what a release at that moment would do. The handle
	// stays mounted through both previews (only the rail div swaps out), so
	// the drag keeps its pointer capture even under the fullscreen overlay.
	// The "min" side is also driven by the edge-reveal drag.
	const [dragPreview, setDragPreview] = useState<"min" | "max" | null>(null);
	// dragPreview is only meaningful mid-drag in rail mode; any mode change
	// clears it so an interrupted gesture can't leave the rail invisibly
	// "open" (the entry drags reset it too — belt and braces).
	useEffect(() => {
		if (mode !== "rail" && dragPreview !== null) setDragPreview(null);
	}, [mode, dragPreview]);

	// Drag overshoot release on the rail's resize handle: below min hides,
	// above max fullscreens. The handle restores the pre-drag width first
	// (both directions), so backing out of either state is an undo.
	const handleOvershoot = useCallback(
		(dir: "min" | "max") => {
			setMode(dir === "min" ? "hidden" : "fullscreen");
		},
		[setMode],
	);
	const handleOvershootPreview = useCallback((dir: "min" | "max" | null) => setDragPreview(dir), []);

	// Resizable rail (desktop): owns the width, persists it, and publishes
	// the cssVar so .body and the TopBar clear the gutter. 0 unless the
	// desktop rail is up — fullscreen and the peek drawer are overlays (the
	// conversation keeps full width underneath), and mobile is off-canvas.
	// An overshoot preview takes the rail off-canvas the same way (collapsed
	// or fullscreened): active goes false so the gutter snaps to 0 with it.
	const resize = usePaneResize({
		cssVar,
		storageKey,
		defaultWidth,
		min,
		max,
		active: isWide && mode === "rail" && dragPreview === null,
	});

	const peek = usePeekDrawer(mode, hoverSignal);
	const reveal = useEdgeReveal({ side, resize, setMode, setDragPreview });

	// Fullscreen dismissal via Esc (the close button and post-pick dismissal
	// live with the header actions / content api). Desktop returns to the
	// rail (the mode it was dragged from); mobile returns to hidden (its
	// only other mode).
	useEffect(() => {
		if (mode !== "fullscreen") return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMode((m) => (m === "fullscreen" ? (isWide ? "rail" : "hidden") : m));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [mode, isWide, setMode]);

	const headerActions: PaneShellHeaderActions = {
		hide: () => setMode("hidden"),
		pin: () => setMode("rail"),
		dismiss: () => setMode((m) => (m === "fullscreen" ? (isWide ? "rail" : "hidden") : m)),
	};

	// A navigation pick inside the content (session row, graph node):
	// mobile fullscreen closes outright; desktop fullscreen backs off to the
	// rail so the picked surface is visible; the peek drawer closes now.
	const dismissAfterPick = useCallback(() => {
		if (!isWide) setMode("hidden");
		else if (mode === "fullscreen") setMode("rail");
		else peek.hideNow();
	}, [isWide, mode, setMode, peek.hideNow]);

	const content = children({ dismissAfterPick });

	// Pure overlay above the whole shell (TopBar included): the conversation
	// keeps its full width — the cssVar stays 0. Used both for the real
	// fullscreen mode and, rendered inside the desktop fragment, for the live
	// max-overshoot drag preview — the snap-in is the honest feedback for
	// crossing the threshold.
	const fullscreenPane = (
		<div className={styles.paneFullscreen}>
			{renderHeader("fullscreen", headerActions)}
			{content}
		</div>
	);

	if (mode === "fullscreen") {
		return fullscreenPane;
	}

	if (isWide) {
		return (
			<>
				{/* Max-overshoot preview: the fullscreen overlay snaps in
				    mid-drag. It MUST render inside this fragment — an early
				    return would unmount the ResizeHandle, silently releasing
				    the drag's pointer capture (stuck overlay + stuck
				    pane-resizing cursor). The handle stays mounted beneath
				    the overlay and keeps receiving the drag's moves. */}
				{dragPreview === "max" && fullscreenPane}
				{/* Hover-peek drawer: the pane content, overlaid beside the
				    TopBar toggle button. Hides (grace-delayed) when the pointer
				    leaves the button or the drawer. */}
				{mode === "hidden" && peek.peekOpen && (
					<nav
						ref={peek.peekDrawerRef}
						className={styles.panePeek}
						data-side={side}
						style={{ width: resize.width }}
						onMouseEnter={() => peek.showPeek(true)}
						onMouseLeave={() => peek.showPeek(false)}
					>
						{renderHeader("peek", headerActions)}
						{content}
					</nav>
				)}
				{/* Edge-reveal strip: drag from the pane's screen edge to open
				    + resize the rail. Pointer-only affordance — keyboard users
				    have the TopBar toggle. Skipped while the peek drawer is open
				    so its resize cursor doesn't sit on the drawer's inner edge;
				    kept mounted during its own drag (revealDragging) because its
				    pointerdown flips the mode to "rail" — unmounting would
				    silently release the pointer capture mid-gesture. */}
				{((mode === "hidden" && !peek.peekOpen) || reveal.revealDragging) && (
					<div
						className={styles.revealStrip}
						data-side={side}
						aria-hidden="true"
						title={`Drag to open ${label}`}
						onPointerDown={reveal.onPointerDown}
						onPointerMove={reveal.onPointerMove}
						onPointerUp={reveal.onPointerEnd}
						onPointerCancel={reveal.onPointerEnd}
					/>
				)}
				{/* The rail. Unmounted during either overshoot preview — a min
				    preview snaps it shut for real (pane and gutter disappear
				    together); a max preview replaces it with the fullscreen
				    overlay, so the content renders once. */}
				{mode === "rail" && dragPreview === null && (
					<div className={styles.pane} data-side={side} style={{ width: resize.width }}>
						{renderHeader("rail", headerActions)}
						{content}
					</div>
				)}
				{/* The handle is a fixed-position sibling (not a child) so the
				    pane's overflow: hidden can't clip it; it centers on the pane
				    border. Stays mounted through both overshoot previews — it
				    owns the drag's pointer capture, even under the fullscreen
				    overlay of a max preview (pointer capture ignores
				    hit-testing). */}
				{mode === "rail" && (
					<ResizeHandle
						controller={resize}
						edge={side === "left" ? "right" : "left"}
						label={`Resize ${label}`}
						onOvershoot={handleOvershoot}
						onOvershootChange={handleOvershootPreview}
					/>
				)}
			</>
		);
	}

	return null;
});
