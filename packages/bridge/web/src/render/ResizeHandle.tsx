// ============================================================================
// ResizeHandle — shared pane-resize affordance for the docked desktop panes
// (Sidebar, HistoryPane). An invisible 12px hit strip centered on the pane
// border; a 2px accent strip reveals on hover/focus/drag. Dragging (pointer
// capture) rewrites the pane's width live; everything that binds the pane's
// CSS var (TopBar edges, .body gutters) follows automatically because the
// same var is the single source of truth. Widths persist per pane in
// localStorage; double-click restores the default width.
// ============================================================================

import { type CSSProperties, memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import styles from "./ResizeHandle.module.css";

/** Hit-strip width. The visible indicator (2px) centers inside it. */
const HIT_W = 12;

/** Keyboard step (px) per arrow press. */
const KEY_STEP = 16;

/** A pane may never claim more than 45% of the viewport, so the
 *  conversation keeps a usable center column at any stored width. */
const MAX_VIEWPORT_FRACTION = 0.45;

// ---------------------------------------------------------------------------
// Hook — width state + clamping + persistence + CSS-var publishing
// ---------------------------------------------------------------------------

export interface PaneResizeOptions {
	/** CSS variable the pane width is published to (e.g. "--sidebar-w"). */
	cssVar: string;
	/** localStorage key the width persists under. */
	storageKey: string;
	defaultWidth: number;
	min: number;
	max: number;
	/** Publish `width` (desktop pane open) or 0 (closed / mobile drawer).
	 *  Unmounting the owner also resets the var to 0 — a closed or mobile
	 *  pane must not leave a stale gutter behind. */
	active: boolean;
}

export interface PaneResizeController {
	width: number;
	min: number;
	max: number;
	defaultWidth: number;
	/** Clamped setter. Does NOT persist — the drag path calls this ~60x/s. */
	setWidth: (w: number) => void;
	/** Clamped setter + persist. Terminal actions: arrow keys, reset. */
	commit: (w: number) => void;
	/** Persist the current width as-is. Terminal action: drag end — the
	 *  value lives in the hook's ref, so it's exact even if the pointerup
	 *  lands before React re-renders the last pointermove. */
	commitCurrent: () => void;
	/** Restore the default width (double-click). */
	reset: () => void;
}

function clampWidth(w: number, min: number, max: number): number {
	const vwCap = Math.floor(window.innerWidth * MAX_VIEWPORT_FRACTION);
	return Math.round(Math.max(min, Math.min(max, vwCap, w)));
}

export function usePaneResize(opts: PaneResizeOptions): PaneResizeController {
	const { cssVar, storageKey, defaultWidth, min, max, active } = opts;

	const [width, setWidthState] = useState(() => {
		try {
			const stored = Number(localStorage.getItem(storageKey));
			if (Number.isFinite(stored) && stored > 0) return clampWidth(stored, min, max);
		} catch {
			/* ignore */
		}
		return defaultWidth;
	});
	// Latest-width ref so terminal actions (pointerup) persist the exact
	// final value even if the last pointermove's state update hasn't
	// flushed yet. Kept in sync by the setters, not by render.
	const widthRef = useRef(width);

	const persist = useCallback(
		(w: number) => {
			try {
				localStorage.setItem(storageKey, String(w));
			} catch {
				/* ignore */
			}
		},
		[storageKey],
	);

	const setWidth = useCallback(
		(w: number) => {
			const clamped = clampWidth(w, min, max);
			widthRef.current = clamped;
			setWidthState(clamped);
		},
		[min, max],
	);
	const commit = useCallback(
		(w: number) => {
			const clamped = clampWidth(w, min, max);
			widthRef.current = clamped;
			setWidthState(clamped);
			persist(clamped);
		},
		[min, max, persist],
	);
	const commitCurrent = useCallback(() => persist(widthRef.current), [persist]);
	const reset = useCallback(() => commit(defaultWidth), [commit, defaultWidth]);

	// Publish the gutter width. useLayoutEffect runs before paint so the
	// first desktop frame carries the persisted width (no one-frame flash),
	// and the cleanup resets the var when the pane closes, goes mobile,
	// or unmounts.
	useLayoutEffect(() => {
		document.documentElement.style.setProperty(cssVar, active ? `${width}px` : "0px");
		return () => document.documentElement.style.setProperty(cssVar, "0px");
	}, [cssVar, active, width]);

	return { width, min, max, defaultWidth, setWidth, commit, commitCurrent, reset };
}

// ---------------------------------------------------------------------------
// Handle — the drag surface
// ---------------------------------------------------------------------------

/**
 * The visible affordance. Rendered as a sibling of the pane (position:
 * fixed), so the pane's `overflow: hidden` can't clip it and it centers
 * exactly on the pane border.
 *
 * `edge` is the pane edge the handle rides: "right" for the left-docked
 * Sidebar (dragging right widens), "left" for the right-docked HistoryPane
 * (dragging left widens).
 */
export const ResizeHandle = memo(function ResizeHandle({
	controller,
	edge,
	label,
}: {
	controller: PaneResizeController;
	edge: "left" | "right";
	label: string;
}) {
	const [dragging, setDragging] = useState(false);
	// Anchor of the live drag: pointer x + pane width at pointerdown.
	const dragStart = useRef<{ x: number; w: number } | null>(null);

	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			dragStart.current = { x: e.clientX, w: controller.width };
			setDragging(true);
			// Capture keeps move/up flowing to the handle when the pointer
			// travels off it (over the conversation, off-window edges).
			e.currentTarget.setPointerCapture(e.pointerId);
			document.documentElement.classList.add("pane-resizing");
		},
		[controller.width],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			const start = dragStart.current;
			if (!start) return;
			const dx = e.clientX - start.x;
			controller.setWidth(start.w + (edge === "right" ? dx : -dx));
		},
		[controller, edge],
	);

	const endDrag = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			if (!dragStart.current) return;
			dragStart.current = null;
			setDragging(false);
			document.documentElement.classList.remove("pane-resizing");
			// pointerup implicitly releases capture right after this handler;
			// releasing here too is belt-and-braces for pointercancel paths.
			if (e.currentTarget.hasPointerCapture(e.pointerId)) {
				e.currentTarget.releasePointerCapture(e.pointerId);
			}
			controller.commitCurrent();
		},
		[controller],
	);

	// Keyboard: arrows move the separator (16px steps, toward the pane's
	// widening direction), Home/End clamp to min/max. The controller ref
	// pattern isn't needed — the handler closes over the current render's
	// controller, and width changes re-render.
	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLElement>) => {
			const dir = edge === "right" ? 1 : -1;
			if (e.key === "ArrowRight") {
				e.preventDefault();
				controller.commit(controller.width + KEY_STEP * dir);
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				controller.commit(controller.width - KEY_STEP * dir);
			} else if (e.key === "Home") {
				e.preventDefault();
				controller.commit(controller.min);
			} else if (e.key === "End") {
				e.preventDefault();
				controller.commit(controller.max);
			}
		},
		[controller, edge],
	);

	// The offset is the live pane width minus half the hit strip, so the
	// strip centers on the pane border. Inline because it changes every
	// pointermove; left offset for the left-docked pane, right for the
	// right-docked one.
	const style: CSSProperties =
		edge === "right"
			? { left: controller.width - HIT_W / 2, width: HIT_W }
			: { right: controller.width - HIT_W / 2, width: HIT_W };

	return (
		// <hr> carries the separator role natively (biome's useSemanticElements);
		// the value triple makes it a proper focusable separator widget per
		// WAI-ARIA — screen readers announce the width like a slider.
		<hr
			aria-orientation="vertical"
			aria-label={label}
			aria-valuemin={controller.min}
			aria-valuemax={controller.max}
			aria-valuenow={controller.width}
			title={`${label} (drag or arrow keys; double-click resets)`}
			tabIndex={0}
			className={styles.handle}
			style={style}
			data-dragging={dragging || undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onDoubleClick={controller.reset}
			onKeyDown={onKeyDown}
		/>
	);
});
