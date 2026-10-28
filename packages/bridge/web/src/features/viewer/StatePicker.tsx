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
import { useAnchorName } from "../../render/useAnchorName.ts";
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
	const [open, setOpen] = useState(false);
	// Position is CSS (see .pickerMenu): the trigger is named while the list exists.
	useAnchorName(open ? buttonRef.current : null, "--pi-state");
	const options = allowWorktree ? states : states.filter((s) => s.value !== "worktree");
	const current = states.find((s) => s.value === value);
	const label = current?.label ?? value.slice(0, 8);

	useEffect(() => {
		onOpenChange?.(open);
	}, [open, onOpenChange]);

	// Capture phase: the browser's own Escape listener is on the document in
	// the bubble phase, so stopping here closes the menu without the view.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			setOpen(false);
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open]);

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={`${styles.stateChip} ${styles.stateChipBtn}${value === "worktree" ? ` ${styles.stateChipWorktree}` : ""}${className ? ` ${className}` : ""}`}
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="listbox"
				aria-expanded={open}
				title={title}
			>
				<span className={styles.stateChipLabel}>{label}</span>
				<ChevronDownIcon size={12} />
			</button>
			{open && (
				<>
					<button
						type="button"
						aria-label="Close state list"
						className={styles.pickerOverlay}
						onClick={() => setOpen(false)}
					/>
					<div role="listbox" className={styles.pickerMenu}>
						{options.map((option) => (
							<button
								key={option.value}
								type="button"
								role="option"
								aria-selected={option.value === value}
								data-active={option.value === value || undefined}
								className={styles.pickerOption}
								onClick={() => {
									setOpen(false);
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
