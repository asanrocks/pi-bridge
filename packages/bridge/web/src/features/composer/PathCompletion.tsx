// ============================================================================
// PathCompletion — dropdown overlay for file path tab-completion.
// Opens upward from the composer card top; dismisses on outside click.
// ============================================================================

import { type CSSProperties, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./ComposeCard.module.css";

/** Keep in sync with `.completionDropdown`'s max-height. */
const MAX_HEIGHT = 180;

/** Position the fixed dropdown against the composer card. Opens upward from
 *  the card top (the session dock, where the card sits at the viewport
 *  bottom); flips below the card when there is no room above (the Project
 *  home, near the top), clamping the height so it never runs off the bottom.
 *  Mirrors `ModelPickerPortal.portalPosition`. */
function completionPosition(anchor: DOMRect): CSSProperties {
	const width = Math.min(anchor.width, window.innerWidth - 16);
	const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
	if (anchor.top >= MAX_HEIGHT + 8) {
		return { position: "fixed", bottom: window.innerHeight - anchor.top + 4, left, width, maxHeight: MAX_HEIGHT };
	}
	return {
		position: "fixed",
		top: anchor.bottom + 4,
		left,
		width,
		maxHeight: Math.max(96, window.innerHeight - anchor.bottom - 12),
	};
}

export const PathCompletion = memo(function PathCompletion({
	completions,
	selectedIndex,
	onSelect,
	onDismiss,
}: {
	completions: Array<{ path: string; isDirectory: boolean }>;
	selectedIndex: number;
	onSelect: (index: number) => void;
	onDismiss: () => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<CSSProperties | undefined>(undefined);

	// Rendered as a direct child of the composer card, so the parent element is
	// the anchor (the model picker gets the equivalent rect as a prop).
	// useLayoutEffect so the first paint is already positioned.
	useLayoutEffect(() => {
		const anchor = listRef.current?.parentElement;
		if (anchor) setPosition(completionPosition(anchor.getBoundingClientRect()));
	}, []);

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (listRef.current && !listRef.current.contains(e.target as Node)) {
				onDismiss();
			}
		};
		const id = setTimeout(() => document.addEventListener("click", handler), 0);
		return () => {
			clearTimeout(id);
			document.removeEventListener("click", handler);
		};
	}, [onDismiss]);

	useEffect(() => {
		const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
		el?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	return (
		<div className={styles.completionDropdown} ref={listRef} style={position}>
			{completions.map((item, i) => {
				const label = item.path.split("/").pop() ?? item.path;
				return (
					<button
						key={item.path}
						type="button"
						className={`${styles.completionItem} ${i === selectedIndex ? styles.completionItemSelected : ""}`}
						onMouseDown={(e) => {
							e.preventDefault();
							onSelect(i);
						}}
					>
						<span className={styles.completionIcon}>{item.isDirectory ? "📁" : "📄"}</span>
						<span className={styles.completionLabel}>
							{label}
							{item.isDirectory ? "/" : ""}
						</span>
					</button>
				);
			})}
		</div>
	);
});
