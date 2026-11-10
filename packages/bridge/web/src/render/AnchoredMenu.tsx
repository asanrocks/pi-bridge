// ============================================================================
// AnchoredMenu — the shared primitive for a small anchored action list (a turn
// header's overflow menu, the TopBar's dirty-now badge).
//
// Chrome, placement, and dismissal are `Popover`'s; this file owns only the
// item list. The item anatomy — one line: a label and an optional inline
// detail — is the one spec every anchored menu shares, so a host supplies
// `MenuItem[]` rather than its own buttons. Two lines per row was the earlier
// anatomy and it made the item count unreadable: a wrapped label plus a detail
// line renders as three rows, so readers counted more items than existed.
//
// There is no checkbox item. An item that flips a setting is an *instant*
// effect, and a menu row cannot say so: a `menuitemcheckbox`'s only state cue is
// a check mark that is absent when the setting is off, which makes an off
// toggle look like a command. Such a control is a `role="switch"` in a dialog
// (see docs/web/design.md, "One anchored panel"). What a row may carry is a
// state the press *chooses*, never a state the press *changes*.
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
	/** Inline secondary text — an oid pair, a count, the reason this command is
	 * unavailable. Short by convention: it never wraps and never truncates the
	 * label out of the row. */
	detail?: string;
	/** Refuse without closing: the item stays reachable (and focusable) so its
	 * `detail` can name the reason, which is the only explanation touch users
	 * get. */
	disabled?: boolean;
	/** Draw a hairline above this item: its effect differs in kind from the
	 * items before it (a Session's row menu separates leaving discovery from
	 * the moves that stay inside it). */
	separator?: boolean;
	/** The item ends something — a run, or the address it is reached by — and
	 * wears the surface's error hue, because the ending is what the press buys
	 * and must be readable before the press, not after. */
	danger?: boolean;
	onSelect: () => void;
}

export function AnchoredMenu({
	anchor,
	items,
	onClose,
	align = "start",
	placement = "below",
	label,
}: {
	/** The trigger element: the menu is positioned from its box. */
	anchor: HTMLElement | null;
	items: readonly MenuItem[];
	onClose: () => void;
	/** Which edge of the anchor the panel aligns to. */
	align?: "start" | "end";
	/** Which side it opens on. A host at the viewport bottom (the composer)
	 * must open above, or the panel is clipped by the edge. */
	placement?: "above" | "below";
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
		<Popover
			anchor={anchor}
			onClose={onClose}
			align={align}
			placement={placement}
			role="menu"
			label={label}
			className={styles.menu}
		>
			{/* `role="none"`: the wrapper exists to own focus/arrow handling, not to
			    stand between the menu and its items in the a11y tree. */}
			<div role="none" ref={listRef} onKeyDown={rove}>
				{items.map((item) => (
					<button
						key={item.key}
						type="button"
						role="menuitem"
						aria-disabled={item.disabled === true ? true : undefined}
						className={[
							styles.item,
							item.separator === true ? styles.itemSeparated : "",
							item.danger === true ? styles.itemDanger : "",
						]
							.filter(Boolean)
							.join(" ")}
						onClick={() => {
							if (item.disabled === true) return;
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
