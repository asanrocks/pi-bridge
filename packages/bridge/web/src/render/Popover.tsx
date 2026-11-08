// ============================================================================
// Popover — the one anchored panel: backdrop, Escape, and CSS anchor placement.
//
// Position is CSS, not JavaScript. The trigger is named with an `anchor-name`
// while the panel exists (`useAnchorName`), and the panel resolves its own
// insets from that name plus `position-try-fallbacks` for the flip. Consumers
// therefore pass the trigger *element*, never a `DOMRect` — a rect snapshot
// goes stale on the first scroll, and every hand-written clamp/flip it needed
// was a copy that could disagree with the next one.
//
// Escape is handled in the capture phase, before any host handler (the browser
// portal, the composer), so one press closes the innermost surface only. The
// full-viewport backdrop stays: it is the click target that dismisses.
//
// `className` carries what the shared chrome cannot know — item geometry,
// padding via `--popover-pad`, or a card surface via `--popover-bg`.
//
// A `shell` panel mounts on the document body. A docked pane is itself a
// stacking context at `--z-pane`, so a `position: fixed` panel rendered inside
// the sidebar rail competes at the rail's tier, not at `--z-portal`: the rail's
// own resize handle (`--z-dock`) drew over the row menu and stole the pointer
// along its 12px strip, and the TopBar would have done the same. Leaving the
// pane puts the panel where the shell ladder expects it. Anchor positioning is
// unaffected — the name lives on the trigger and resolves document-wide. The
// `local` layer keeps the old in-place mount on purpose: those panels are the
// viewer's, and they must not lift above the surface that owns them.
// ============================================================================

import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import styles from "./Popover.module.css";
import { useAnchorName } from "./useAnchorName.ts";

/** The anchor name the trigger carries while a panel is open. One anchored
 * panel is open at a time, so one name is enough (names are document-global). */
const ANCHOR_NAME = "--pi-popover";

export function Popover({
	anchor,
	onClose,
	children,
	align = "start",
	placement = "below",
	layer = "shell",
	role,
	label,
	className,
	dismissOnEscape = true,
}: {
	/** The trigger element the panel is positioned from. */
	anchor: HTMLElement | null;
	onClose: () => void;
	children: ReactNode;
	/** Which edge of the anchor the panel aligns to. */
	align?: "start" | "end";
	/** Which side of the anchor the panel opens on. */
	placement?: "below" | "above";
	/** `local` keeps the panel inside its pane's stacking context. */
	layer?: "shell" | "local";
	/** The panel's ARIA role; the primitive owns chrome and dismissal only. */
	role: "menu" | "listbox" | "dialog";
	/** The panel's accessible name; required because the panel is a named
	 * region, and a role without a name is what the a11y lint rejects. */
	label: string;
	/** Consumer chrome: item geometry, or the `--popover-*` overrides. */
	className?: string;
	/** Set false while a nested panel owns Escape (a menu holding a picker). Two
	 * capture-phase document listeners cannot be ordered by nesting, so the outer
	 * one stands down explicitly instead of racing registration order. */
	dismissOnEscape?: boolean;
}) {
	useAnchorName(anchor, ANCHOR_NAME);

	useEffect(() => {
		if (!dismissOnEscape) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [onClose, dismissOnEscape]);

	// The role is one of a closed set and the label is always present, so the
	// pairing is checked at the call site; spreading keeps that guarantee visible
	// to a reader without the lint having to follow a role held in a variable.
	const named = { role, "aria-label": label };

	const chrome = (
		<>
			<button type="button" aria-label="Close" className={styles.backdrop} data-layer={layer} onClick={onClose} />
			<div
				{...named}
				className={className ? `${styles.panel} ${className}` : styles.panel}
				data-align={align}
				data-placement={placement}
				data-layer={layer}
			>
				{children}
			</div>
		</>
	);
	// The document is the boundary: the markup tests render this tree with the
	// server renderer, which has no portals and no stacking to resolve.
	if (layer === "local" || typeof document === "undefined") return chrome;
	return createPortal(chrome, document.body);
}
