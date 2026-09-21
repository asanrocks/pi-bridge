// ============================================================================
// usePeekDrawer — the hover-peek drawer (desktop, hidden mode): the pane's
// content overlaid beside the TopBar toggle button while the pointer is over
// the button or the drawer. Shown immediately; hidden on a grace delay — the
// delay exists because the drawer mounts directly over the toggle button, so
// the button's mouseleave fires while the pointer hasn't moved at all, and
// the ordering of that leave vs the drawer's mouseenter is not something we
// can rely on. So the hide never trusts events alone: when the timer fires
// it asks the browser where the pointer is (:hover) and keeps the drawer if
// it's still over it. Any mode change cancels it outright.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneMode } from "./usePaneMode.ts";

/** Grace delay before an un-hovered peek drawer hides, so the pointer can
 *  cross the toggle button → drawer gap without a flicker. */
const PEEK_CLOSE_MS = 200;

export function usePeekDrawer(
	mode: PaneMode,
	/** Raw hover signal from the pane's TopBar toggle button (the App just
	 *  forwards it): true while the pointer is over the button. */
	hoverSignal: boolean,
): {
	peekOpen: boolean;
	/** Show immediately; hide on the grace delay (with the :hover re-check). */
	showPeek: (show: boolean) => void;
	/** Hide immediately (selection, mode change) — no grace delay. */
	hideNow: () => void;
	/** Ref for the drawer element; the delayed hide :hover-checks it. */
	peekDrawerRef: React.RefObject<HTMLElement | null>;
} {
	const [peekOpen, setPeekOpen] = useState(false);
	const peekTimerRef = useRef<number | undefined>(undefined);
	const peekDrawerRef = useRef<HTMLElement | null>(null);

	const cancelTimer = useCallback(() => {
		if (peekTimerRef.current !== undefined) {
			window.clearTimeout(peekTimerRef.current);
			peekTimerRef.current = undefined;
		}
	}, []);

	const showPeek = useCallback(
		(show: boolean) => {
			cancelTimer();
			if (show) setPeekOpen(true);
			else
				peekTimerRef.current = window.setTimeout(() => {
					peekTimerRef.current = undefined;
					if (!peekDrawerRef.current?.matches(":hover")) setPeekOpen(false);
				}, PEEK_CLOSE_MS);
		},
		[cancelTimer],
	);

	const hideNow = useCallback(() => {
		cancelTimer();
		setPeekOpen(false);
	}, [cancelTimer]);

	useEffect(() => {
		showPeek(hoverSignal);
	}, [hoverSignal, showPeek]);

	// The peek exists only in hidden mode; any mode change cancels it outright.
	useEffect(() => {
		if (mode !== "hidden") hideNow();
	}, [mode, hideNow]);

	useEffect(() => cancelTimer, [cancelTimer]);

	return { peekOpen, showPeek, hideNow, peekDrawerRef };
}
