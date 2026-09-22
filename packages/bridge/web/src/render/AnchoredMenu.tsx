// ============================================================================
// AnchoredMenu — a small anchored action list, the shared primitive for the
// transcript's git menus and the TopBar's dirty-now badge. Same pattern as
// StatePicker / ModelPickerPortal: a full-viewport overlay plus a fixed panel,
// so the menu escapes overflow clipping and the app's stacking contexts.
// Escape closes it in the capture phase, before any host Escape handler (the
// browser portal, the composer), so one press closes only the menu.
// ============================================================================

import { useEffect } from "react";
import styles from "./AnchoredMenu.module.css";

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
	anchor: DOMRect;
	items: readonly MenuItem[];
	onClose: () => void;
	/** Which edge of the anchor the panel aligns to. */
	align?: "start" | "end";
	label?: string;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	const width = 320;
	const left =
		align === "end"
			? Math.max(8, anchor.right - width)
			: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));

	return (
		<>
			<button type="button" aria-label="Close menu" className={styles.overlay} onClick={onClose} />
			<div
				role="menu"
				aria-label={label}
				className={styles.menu}
				style={{ position: "fixed", top: anchor.bottom + 4, left, width }}
			>
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
