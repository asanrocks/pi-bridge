// ============================================================================
// useEdgeReveal — the edge-reveal strip (desktop, hidden mode): drag from
// the screen edge on the pane's side to open + resize the rail. The implied
// width is the pointer's distance from that edge (the pane's inner border
// chases the pointer), and the rail appears only once that width exceeds
// min; before that the drag previews closed, same snap semantics as the
// rail's own resize handle. A release below min keeps it hidden with the
// pre-drag stored width restored. The strip stays mounted for the whole
// gesture: its pointerdown flips the mode to "rail", and unmounting the
// strip would silently release the pointer capture mid-drag.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneResizeController } from "./ResizeHandle.tsx";
import type { PaneMode } from "./usePaneMode.ts";

export function useEdgeReveal({
	side,
	resize,
	setMode,
	setDragPreview,
}: {
	/** Which screen edge the strip hugs — the pane's docking side. */
	side: "left" | "right";
	/** The rail's resize controller (width + bounds + commit). */
	resize: PaneResizeController;
	/** Mode setter — the drag opens the rail ("rail") and a below-min
	 *  release closes it ("hidden"). */
	setMode: React.Dispatch<React.SetStateAction<PaneMode>>;
	/** Overshoot-preview setter, shared with the rail's resize handle: the
	 *  reveal drag previews closed below min with the same signal. */
	setDragPreview: React.Dispatch<React.SetStateAction<"min" | "max" | null>>;
}): {
	/** True for the whole gesture — the strip must stay mounted (it holds
	 *  the pointer capture) even after its pointerdown flipped the mode. */
	revealDragging: boolean;
	onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
	onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
	onPointerEnd: (e: React.PointerEvent<HTMLDivElement>) => void;
} {
	const [revealDragging, setRevealDragging] = useState(false);
	// Watchdog: the strip adds pane-resizing on pointerdown and normally
	// removes it on pointerup — but if it unmounts mid-drag (breakpoint
	// crossing), clear it whenever no reveal drag is active. Idempotent.
	useEffect(() => {
		if (!revealDragging) document.documentElement.classList.remove("pane-resizing");
	}, [revealDragging]);

	const revealBaseWidth = useRef<number | null>(null);
	// The implied width is the pointer's distance from the pane's edge —
	// its x for a left-docked pane, the viewport remainder for a right-docked
	// one (dragging left widens).
	const impliedWidth = useCallback(
		(clientX: number) => (side === "left" ? clientX : window.innerWidth - clientX),
		[side],
	);
	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.currentTarget.setPointerCapture(e.pointerId);
			revealBaseWidth.current = resize.width;
			setRevealDragging(true);
			setMode("rail");
			// At the far edge the implied width is already below min — start
			// snapped shut so the rail is never shown more eagerly than the drag.
			setDragPreview(impliedWidth(e.clientX) < resize.min ? "min" : null);
			document.documentElement.classList.add("pane-resizing");
		},
		[resize, setMode, setDragPreview, impliedWidth],
	);
	const onPointerMove = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (revealBaseWidth.current === null || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
			const raw = impliedWidth(e.clientX);
			resize.setWidth(raw);
			setDragPreview(raw < resize.min ? "min" : null);
		},
		[resize, setDragPreview, impliedWidth],
	);
	const onPointerEnd = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
			const base = revealBaseWidth.current;
			revealBaseWidth.current = null;
			e.currentTarget.releasePointerCapture(e.pointerId);
			document.documentElement.classList.remove("pane-resizing");
			setRevealDragging(false);
			setDragPreview(null);
			if (base === null) return;
			// Release decides on the pointer's position (exact even if the last
			// pointermove's state update hasn't flushed): below min → hide with
			// the pre-drag stored width restored; at/above → commit the dragged
			// width.
			if (impliedWidth(e.clientX) < resize.min) {
				resize.setWidth(base);
				setMode("hidden");
			} else {
				resize.commitCurrent();
			}
		},
		[resize, setMode, setDragPreview, impliedWidth],
	);

	return { revealDragging, onPointerDown, onPointerMove, onPointerEnd };
}
