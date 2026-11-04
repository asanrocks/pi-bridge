// ============================================================================
// CompareMenu — the browser header's `Compare…` action. It replaces the two
// always-visible endpoint pickers: the header names the task, and arbitrary
// endpoint selection lives one click away. The menu offers the three common
// comparisons plus a custom From → To pair, built from the same StatePicker the
// single-state read still uses.
//
// The list is a `Popover`, so Escape closes the menu (and, because a nested
// picker's Popover stops the same event first, the nested list before the menu)
// without also closing the browser.
// ============================================================================

import { useRef, useState } from "react";
import { Popover } from "../../render/Popover.tsx";
import type { DiffStateOption } from "./diffStates.ts";
import styles from "./FileBrowser.module.css";
import { StatePicker } from "./StatePicker.tsx";

/** The three common comparisons, in the vocabulary of the pair. */
const PRESETS: { name: string; note: string; from: string; to: string }[] = [
	{ name: "Working changes", note: "HEAD → Working tree", from: "head", to: "worktree" },
	{ name: "Staged changes", note: "HEAD → Index", from: "head", to: "index" },
	{ name: "Unstaged changes", note: "Index → Working tree", from: "index", to: "worktree" },
];

export function CompareMenu({
	baseline,
	state,
	states,
	onApply,
}: {
	baseline: string | undefined;
	state: string;
	states: readonly DiffStateOption[];
	onApply: (baseline: string, state: string) => void;
}) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	// A nested state list is open. Popover's capture-phase Escape belongs to the
	// innermost panel, so the menu's own Popover handler must stand down while
	// a list is up.
	const [nestedOpen, setNestedOpen] = useState(false);
	// Draft endpoints, seeded from the current target each time the menu opens
	// so a cancelled edit never leaks into the next open.
	const [from, setFrom] = useState(baseline ?? "head");
	const [to, setTo] = useState(state);

	const openMenu = () => {
		setFrom(baseline ?? "head");
		setTo(state);
		setNestedOpen(false);
		setOpen(true);
	};

	const apply = (nextBaseline: string, nextState: string) => {
		setOpen(false);
		onApply(nextBaseline, nextState);
	};

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={styles.refreshBtn}
				onClick={openMenu}
				aria-haspopup="dialog"
				aria-expanded={open}
				title="Compare repository states"
			>
				Compare…
			</button>
			{open && (
				<Popover
					anchor={buttonRef.current}
					onClose={() => setOpen(false)}
					layer="local"
					role="dialog"
					label="Compare repository states"
					className={styles.compareMenu}
					dismissOnEscape={!nestedOpen}
				>
					<div className={styles.compareLabel}>Common</div>
					{PRESETS.map((preset) => (
						<button
							key={preset.name}
							type="button"
							className={styles.comparePreset}
							onClick={() => apply(preset.from, preset.to)}
						>
							<span className={styles.comparePresetName}>{preset.name}</span>
							<span className={styles.comparePresetNote}>{preset.note}</span>
						</button>
					))}
					<div className={styles.compareLabel}>Custom</div>
					<div className={styles.compareRow}>
						<StatePicker
							value={from}
							states={states}
							allowWorktree={false}
							onPick={setFrom}
							title="Compare from"
							onOpenChange={setNestedOpen}
						/>
						<span className={styles.compareArrow}>→</span>
						<StatePicker
							value={to}
							states={states}
							onPick={setTo}
							title="Compare to"
							onOpenChange={setNestedOpen}
						/>
					</div>
					<button
						type="button"
						className={styles.compareApply}
						disabled={from === to}
						onClick={() => apply(from, to)}
					>
						Open comparison
					</button>
				</Popover>
			)}
		</>
	);
}
