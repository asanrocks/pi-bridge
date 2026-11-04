// ============================================================================
// AnchoredMenu — the shared primitive for a small anchored action list (a turn
// header's overflow menu, the TopBar's dirty-now badge).
//
// Chrome, placement, and dismissal are `Popover`'s; this file owns only the
// item list. The item anatomy (a label plus an optional detail line) is the
// one spec every anchored menu shares, so a host supplies `MenuItem[]` rather
// than its own buttons.
//
// Keyboard: the menu is a keyboard surface, so opening it moves focus to the
// first item and arrows/Home/End roam (`role="menu"` with `menuitem` children,
// per the WAI menu-button pattern). Dismissal returns focus to the trigger,
// including the Escape path that `Popover` owns — otherwise a keyboard reader
// who closes the menu lands at the top of the document.
// ============================================================================

import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef } from "react";
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
	const listRef = useRef<HTMLDivElement | null>(null);

	// First item on open, so the arrows work immediately instead of moving
	// nothing until Tab is pressed.
	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
	}, []);

	// Focus goes back to the trigger whenever the menu leaves the tree — the
	// item's own action may take it somewhere else afterwards, which is why this
	// runs on unmount rather than in the close handler.
	useEffect(() => {
		const trigger = anchor;
		return () => trigger?.focus();
	}, [anchor]);

	const rove = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const nodes = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
		if (nodes.length === 0) return;
		const at = nodes.indexOf(document.activeElement as HTMLElement);
		const focus = (index: number) => nodes[(index + nodes.length) % nodes.length].focus();
		if (e.key === "ArrowDown") {
			e.preventDefault();
			focus(at + 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			focus(at - 1);
		} else if (e.key === "Home") {
			e.preventDefault();
			focus(0);
		} else if (e.key === "End") {
			e.preventDefault();
			focus(nodes.length - 1);
		}
	};

	return (
		<Popover anchor={anchor} onClose={onClose} align={align} role="menu" label={label} className={styles.menu}>
			{/* `role="none"`: the wrapper exists to own focus/arrow handling, not to
			    stand between the menu and its items in the a11y tree. */}
			<div role="none" ref={listRef} onKeyDown={rove}>
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
		</Popover>
	);
}
