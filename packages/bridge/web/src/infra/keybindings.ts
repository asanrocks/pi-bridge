// ============================================================================
// useAppKeybindings — single document-level keydown listener for the web UI.
//
// Scope rules (the reason this exists rather than per-component listeners):
//
//   - Bare reading keys (j/k/g/G/e/y/h/l/Enter-when-not-on-a-button) BAIL
//     when the keydown target is a text input (INPUT/TEXTAREA/SELECT or
//     contentEditable). You're typing; the textarea owns those keystrokes.
//     The one exception is `/`: it bails in text inputs too (you want to
//     type a slash), so it lives here as a bare key.
//
//   - Modifier combos (Ctrl/Cmd+P, Alt+Arrow, Alt+N) are global intents,
//     NOT text input. They bypass the text-input bail so model-cycling and
//     project-switching work while the composer textarea is focused. The
//     one carve-out is Ctrl/Cmd+P: it bails in a text input because the
//     Composer's textarea handler already owns it there (avoids double-
//     firing — the document listener fires after React's root-delegated
//     textarea handler, and both would cycle).
//
//   - A focusable control whose Enter/Space should activate it, not be hijacked
//     for app nav, is guarded by isInteractiveTarget (BUTTON/A/SUMMARY or a
//     [role='button'] ancestor) — that covers HistoryPane rows too, so the
//     non-modal pane coexists with app shortcuts without a blanket suppress.
//
// `handlers` is kept in a ref and read at event time, so the listener is
// attached once (empty-deps effect) while always dispatching against the
// latest callbacks — which read fresh store state via getStore().
// ============================================================================

import { useEffect, useRef } from "react";

export interface AppKeyHandlers {
	onCycleModel: (direction: "forward" | "backward") => void;
	onExpandComposer: () => void;
	onNavigateTurn: (direction: "prev" | "next") => void;
	onJumpTurn: (edge: "first" | "last") => void;
	onToggleFocusedGroup: () => void;
	onEditFocused: () => void;
	onCopyFocused: () => void;
	onBranchSibling: (direction: "prev" | "next") => void;
	onCycleProject: (direction: "prev" | "next") => void;
	onNewSession: () => void;
	onToggleSidebar: () => void;
	onToggleHistory: () => void;
}

function isTextInput(el: EventTarget | null): boolean {
	const tag = (el as HTMLElement | null)?.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return (el as HTMLElement | null)?.isContentEditable === true;
}

/** A focusable control whose Enter/Space should activate it, not be hijacked
 *  for app nav. Bare letters never activate a control, so they don't need
 *  this guard — only Enter does. */
function isInteractiveTarget(el: EventTarget | null): boolean {
	const node = el as HTMLElement | null;
	if (!node) return false;
	const tag = node.tagName;
	if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return true;
	return node.closest("[role='button']") !== null;
}

export function useAppKeybindings(handlers: AppKeyHandlers): void {
	const ref = useRef(handlers);
	ref.current = handlers;

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const h = ref.current;
			const inText = isTextInput(e.target);

			// ── Ctrl/Cmd+P — model cycle ──────────────────────────────────
			// Bail in a text input: the Composer's textarea handler owns it
			// there (avoids a double-cycle: this listener fires after the
			// root-delegated textarea handler).
			if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "p" || e.key === "P")) {
				if (inText) return;
				e.preventDefault();
				h.onCycleModel(e.shiftKey ? "backward" : "forward");
				return;
			}

			// ── Ctrl/Cmd+B — toggle left Sidebar (browser/IDE convention) ───
			// ── Ctrl/Cmd+H — toggle right HistoryPane (H=history convention) ──
			// Both are global chrome toggles: they work while typing (like Alt
			// combos), unlike Ctrl+P which bails in a text input.
			if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
				if (e.key === "b" || e.key === "B") {
					e.preventDefault();
					h.onToggleSidebar();
					return;
				}
				if (e.key === "h" || e.key === "H") {
					e.preventDefault();
					h.onToggleHistory();
					return;
				}
			}

			// ── Alt combos — global, work while typing ─────────────────────
			if (e.altKey && !e.ctrlKey && !e.metaKey) {
				if (e.key === "ArrowUp") {
					e.preventDefault();
					h.onCycleProject("prev");
					return;
				}
				if (e.key === "ArrowDown") {
					e.preventDefault();
					h.onCycleProject("next");
					return;
				}
				if (e.key === "n" || e.key === "N") {
					e.preventDefault();
					h.onNewSession();
					return;
				}
			}

			// ── Bare reading keys — bail when typing or holding a modifier ─
			if (inText) return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;

			switch (e.key) {
				case "/":
					e.preventDefault();
					h.onExpandComposer();
					return;
				case "j":
					e.preventDefault();
					h.onNavigateTurn("next");
					return;
				case "k":
					e.preventDefault();
					h.onNavigateTurn("prev");
					return;
				case "g":
					e.preventDefault();
					h.onJumpTurn("first");
					return;
				case "G":
					e.preventDefault();
					h.onJumpTurn("last");
					return;
				case "Enter":
					// Don't hijack button/link activation (tab-focused controls).
					if (isInteractiveTarget(e.target)) return;
					e.preventDefault();
					h.onToggleFocusedGroup();
					return;
				case "e":
					e.preventDefault();
					h.onEditFocused();
					return;
				case "y":
					e.preventDefault();
					h.onCopyFocused();
					return;
				case "h":
					e.preventDefault();
					h.onBranchSibling("prev");
					return;
				case "l":
					e.preventDefault();
					h.onBranchSibling("next");
					return;
			}
		};

		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);
}
