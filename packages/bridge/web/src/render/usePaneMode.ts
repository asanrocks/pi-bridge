// ============================================================================
// usePaneMode — the tri-mode state machine shared by the docked side panes
// (Sidebar, HistoryPane): hidden / rail / fullscreen, with the rail
// desktop-only. Owns rail-visibility persistence, the breakpoint collapse
// (rail → hidden on narrow; a deliberately hidden pane never reopens on
// breakpoint changes), and the imperative toggle handle the pane's shell
// populates (TopBar button, keyboard ring). The mode lives with the pane's
// shell hook (always mounted), so unmounting the pane — e.g. the HistoryPane
// when no session is open — never loses or orphans the state.
//
// The surfaces that render each mode (and the drag gestures between them)
// live in PaneShell; usePaneMode is the policy, PaneShell the mechanism.
// ============================================================================

import { useEffect, useState } from "react";

/** Pane display mode. `rail` (docked, resizable column) is desktop-only;
 *  mobile offers just hidden / fullscreen. */
export type PaneMode = "hidden" | "rail" | "fullscreen";

export function usePaneMode({
	isWide,
	persistenceKey,
	toggleRef,
	openRef,
}: {
	/** Desktop breakpoint state — the rail exists only while wide. */
	isWide: boolean;
	/** localStorage key for the desktop rail-visibility preference. */
	persistenceKey: string;
	/** Imperative toggle handle (TopBar button, keyboard ring). The shell
	 *  hook creates the ref; this hook populates it. */
	toggleRef: React.MutableRefObject<() => void>;
	/** Optional imperative "ensure open" handle: opens the pane if hidden
	 *  (the sidebar's Alt+N — the project list must be reachable). */
	openRef?: React.MutableRefObject<() => void>;
}): {
	mode: PaneMode;
	setMode: React.Dispatch<React.SetStateAction<PaneMode>>;
	/** Fullscreen dismissal (close button / post-selection): returns to the
	 *  prior mode — rail on desktop, hidden on mobile. */
	dismissOverlay: () => void;
} {
	const [mode, setMode] = useState<PaneMode>(() => {
		if (isWide) {
			try {
				const stored = localStorage.getItem(persistenceKey);
				if (stored !== null) return stored === "true" ? "rail" : "hidden";
			} catch {
				/* ignore */
			}
			return "rail";
		}
		return "hidden";
	});

	// "Ensure open": only a hidden pane needs opening.
	useEffect(() => {
		if (!openRef) return;
		openRef.current = () => {
			if (mode === "hidden") setMode(isWide ? "rail" : "fullscreen");
		};
	}, [mode, isWide, openRef]);

	// Mobile has no rail: crossing to narrow collapses a rail to hidden
	// (hidden/fullscreen stay valid). Crossing back to wide preserves the
	// mode — a deliberately hidden pane must not reopen on breakpoint
	// changes.
	useEffect(() => {
		if (!isWide) setMode((m) => (m === "rail" ? "hidden" : m));
	}, [isWide]);

	useEffect(() => {
		toggleRef.current = () => {
			setMode((m) => {
				// Desktop: hidden ↔ rail; fullscreen backs off to the rail (the
				// toggle dismisses the overlay). Mobile: hidden ↔ fullscreen.
				if (isWide) return m === "hidden" ? "rail" : m === "rail" ? "hidden" : "rail";
				return m === "hidden" ? "fullscreen" : "hidden";
			});
		};
	}, [isWide, toggleRef]);

	// Desktop rail visibility only — fullscreen is transient, and a mobile
	// session must not leak its fullscreen into the desktop preference.
	useEffect(() => {
		try {
			if (isWide) localStorage.setItem(persistenceKey, String(mode !== "hidden"));
		} catch {
			/* ignore */
		}
	}, [mode, isWide, persistenceKey]);

	// Fullscreen dismissal via Esc lives with the surfaces (PaneShell); the
	// programmatic form is exported here for pane-level policy.
	const dismissOverlay = () => setMode((m) => (m === "fullscreen" ? (isWide ? "rail" : "hidden") : m));

	return { mode, setMode, dismissOverlay };
}
