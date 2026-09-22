// ============================================================================
// StatePicker — the FileBrowser header's endpoint selector. A chip-styled button
// opens an anchored list of the timeline's states (recorded commits with their
// subjects, plus HEAD and the working tree). Picking one rewrites the diff
// pair; the browser refetches, so the pair stays a selector, not a snapshot.
//
// The list reuses the model-picker's portal pattern (full-viewport overlay +
// fixed panel) rather than a native select, which cannot carry the subject
// line or the app's tokens. Escape closes the menu and is stopped there, so it
// does not also close the browser.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "../../render/icons.tsx";
import type { DiffStateOption } from "./diffStates.ts";
import styles from "./FileBrowser.module.css";

export function StatePicker({
	value,
	states,
	onPick,
	allowWorktree = true,
	className,
	title,
	onOpenChange,
}: {
	value: string;
	states: readonly DiffStateOption[];
	onPick: (value: string) => void;
	/** The base end cannot be the working tree (the host rejects it). */
	allowWorktree?: boolean;
	className?: string;
	title?: string;
	/** Notifies a host menu that this picker's list is open, so Escape can
	 * close the list before the host (see CompareMenu). */
	onOpenChange?: (open: boolean) => void;
}) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const options = allowWorktree ? states : states.filter((s) => s.value !== "worktree");
	const current = states.find((s) => s.value === value);
	const label = current?.label ?? value.slice(0, 8);

	useEffect(() => {
		onOpenChange?.(anchor !== null);
	}, [anchor, onOpenChange]);

	// Capture phase: the browser's own Escape listener is on the document in
	// the bubble phase, so stopping here closes the menu without the view.
	useEffect(() => {
		if (anchor === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			setAnchor(null);
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [anchor]);

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={`${styles.stateChip} ${styles.stateChipBtn}${value === "worktree" ? ` ${styles.stateChipWorktree}` : ""}${className ? ` ${className}` : ""}`}
				onClick={() => setAnchor(buttonRef.current?.getBoundingClientRect() ?? null)}
				aria-haspopup="listbox"
				aria-expanded={anchor !== null}
				title={title}
			>
				<span className={styles.stateChipLabel}>{label}</span>
				<ChevronDownIcon size={11} />
			</button>
			{anchor && (
				<>
					<button
						type="button"
						aria-label="Close state list"
						className={styles.pickerOverlay}
						onClick={() => setAnchor(null)}
					/>
					<div
						role="listbox"
						className={styles.pickerMenu}
						style={{
							position: "fixed",
							top: anchor.bottom + 4,
							left: Math.max(8, Math.min(anchor.left, window.innerWidth - 320)),
						}}
					>
						{options.map((option) => (
							<button
								key={option.value}
								type="button"
								role="option"
								aria-selected={option.value === value}
								data-active={option.value === value || undefined}
								className={styles.pickerOption}
								onClick={() => {
									setAnchor(null);
									if (option.value !== value) onPick(option.value);
								}}
							>
								<span className={styles.pickerOptionLabel}>{option.label}</span>
								{option.subject && <span className={styles.pickerOptionSubject}>{option.subject}</span>}
							</button>
						))}
					</div>
				</>
			)}
		</>
	);
}
