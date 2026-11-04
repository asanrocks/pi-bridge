// ============================================================================
// AnchoredMenu — the shared primitive for a small anchored action list (the
// transcript's git menus and the TopBar's dirty-now badge).
//
// Chrome, placement, and dismissal are `Popover`'s; this file owns only the
// item list. The item anatomy (a label plus an optional detail line) is the
// one spec every anchored menu shares, so a host supplies `MenuItem[]` rather
// than its own buttons.
// ============================================================================

import styles from "./AnchoredMenu.module.css";
import { Popover } from "./Popover.tsx";

export interface MenuItem {
	key: string;
	label: string;
	/** Secondary text — the commit subject or the endpoint pair. */
	detail?: string;
	onSelect: () => void;
}

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
	/** The menu's accessible name — every host names its own action list. */
	label: string;
}) {
	return (
		<Popover anchor={anchor} onClose={onClose} align={align} role="menu" label={label} className={styles.menu}>
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
		</Popover>
	);
}
