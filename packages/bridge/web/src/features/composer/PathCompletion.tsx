// ============================================================================
// PathCompletion — dropdown overlay for file path tab-completion.
// Opens upward from the composer card top; dismisses on outside click.
// ============================================================================

import { memo, useEffect, useRef } from "react";
import styles from "./Composer.module.css";

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
		<div className={styles.completionDropdown} ref={listRef}>
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
