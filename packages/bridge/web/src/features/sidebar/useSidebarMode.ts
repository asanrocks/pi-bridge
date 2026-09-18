// ============================================================================
// useSidebarMode — the tri-mode state machine (ADR 11): hidden / rail /
// fullscreen, with the rail desktop-only. Owns desktop rail-visibility
// persistence, the breakpoint collapse (rail → hidden on narrow; a
// deliberately hidden sidebar never reopens on breakpoint changes), the
// imperative handles (hamburger toggle + Alt+N open), Esc dismissal of the
// fullscreen overlay, and the mode report to the App shell.
// ============================================================================

import { useCallback, useEffect, useState } from "react";

/** Sidebar display mode. `rail` (docked, resizable column) is desktop-only;
 *  mobile offers just hidden / fullscreen. */
export type SidebarMode = "hidden" | "rail" | "fullscreen";

const LS_KEY = "pi-bridge:sidebar-open";

export function useSidebarMode({
	isWide,
	toggleRef,
	newSessionRef,
	onModeChange,
}: {
	/** Desktop breakpoint state — the rail exists only while wide. */
	isWide: boolean;
	/** Imperative toggle handle the Sidebar populates (TopBar hamburger). */
	toggleRef: React.MutableRefObject<() => void>;
	/** Imperative open-sidebar handle for Alt+N with several Projects
	 * configured — the project list lives in the sidebar; a session is
	 * started by sending a prompt from a Project's home. */
	newSessionRef: React.MutableRefObject<() => void>;
	/** Mode report for the App shell (TopBar hamburger visibility). Called
	 *  on every mode change after mount. */
	onModeChange?: (mode: SidebarMode) => void;
}): {
	mode: SidebarMode;
	setMode: React.Dispatch<React.SetStateAction<SidebarMode>>;
	/** Fullscreen dismissal (close button / Esc / post-selection): returns
	 *  to the prior mode — rail on desktop, hidden on mobile. */
	dismissOverlay: () => void;
} {
	const [mode, setMode] = useState<SidebarMode>(() => {
		if (isWide) {
			try {
				const stored = localStorage.getItem(LS_KEY);
				if (stored !== null) return stored === "true" ? "rail" : "hidden";
			} catch {
				/* ignore */
			}
			return "rail";
		}
		return "hidden";
	});

	// Alt+N with several Projects: ensure the sidebar is open so its project
	// list is reachable (a session is started from a Project's home prompt).
	useEffect(() => {
		newSessionRef.current = () => {
			if (mode === "hidden") setMode(isWide ? "rail" : "fullscreen");
		};
	}, [mode, isWide, newSessionRef]);

	// Mobile has no rail: crossing to narrow collapses a rail to hidden
	// (hidden/fullscreen stay valid). Crossing back to wide preserves the
	// mode — a deliberately hidden sidebar must not reopen on breakpoint
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
			if (isWide) localStorage.setItem(LS_KEY, String(mode !== "hidden"));
		} catch {
			/* ignore */
		}
	}, [mode, isWide]);

	useEffect(() => {
		onModeChange?.(mode);
	}, [mode, onModeChange]);

	// Fullscreen dismissal via Esc (the close button and post-selection
	// dismissal live with their callers in Sidebar). Desktop returns to the
	// rail (the mode it was dragged from); mobile returns to hidden (its
	// only other mode).
	const dismissOverlay = useCallback(() => {
		setMode((m) => (m === "fullscreen" ? (isWide ? "rail" : "hidden") : m));
	}, [isWide]);
	useEffect(() => {
		if (mode !== "fullscreen") return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") dismissOverlay();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [mode, dismissOverlay]);

	return { mode, setMode, dismissOverlay };
}
