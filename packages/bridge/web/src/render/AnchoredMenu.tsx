// ============================================================================
// AnchoredMenu — a small anchored action list, the shared primitive for the
// transcript's git menus and the TopBar's dirty-now badge.
//
// Position is CSS, not JavaScript: the trigger is named with an `anchor-name`
// while the menu exists, and the panel resolves its own insets from that name
// (`anchor(bottom)`, `anchor(inline-start)`, plus `position-try-fallbacks` for
// the edges). The component therefore takes the trigger *element*, not a
// `DOMRect` snapshot — a rect goes stale the moment the page scrolls, and the
// flip/clamp arithmetic it used to carry is what the platform does now.
//
// The full-viewport overlay stays: it is the click target that dismisses, and
// Escape is handled here in the capture phase, before any host Escape handler
// (the browser portal, the composer), so one press closes only the menu.
// ============================================================================

import { useEffect } from "react";
import styles from "./AnchoredMenu.module.css";
import { useAnchorName } from "./useAnchorName.ts";

export interface MenuItem {
	key: string;
	label: string;
	/** Secondary text — the commit subject or the endpoint pair. */
	detail?: string;
	onSelect: () => void;
}

/** The anchor name the trigger carries while a menu is open. One menu exists at
 * a time, so one name is enough. */
const ANCHOR_NAME = "--pi-menu";

export function AnchoredMenu({
	anchor,
	items,
	onClose,
	align = "start",
	label,
}: {
	/** The trigger element: the menu is positioned from its box. */
	anchor: HTMLElement | null;
	items: readonly MenuItem[];
	onClose: () => void;
	/** Which edge of the anchor the panel aligns to. */
	align?: "start" | "end";
	label?: string;
}) {
	useAnchorName(anchor, ANCHOR_NAME);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	return (
		<>
			<button type="button" aria-label="Close menu" className={styles.overlay} onClick={onClose} />
			<div role="menu" aria-label={label} className={styles.menu} data-align={align}>
				{items.map((item) => (
					<button
						key={item.key}
						type="button"
						role="menuitem"
						className={styles.item}
						onClick={() => {
							onClose();
							item.onSelect();
						}}
					>
						<span className={styles.itemLabel}>{item.label}</span>
						{item.detail && <span className={styles.itemDetail}>{item.detail}</span>}
					</button>
				))}
			</div>
		</>
	);
}
