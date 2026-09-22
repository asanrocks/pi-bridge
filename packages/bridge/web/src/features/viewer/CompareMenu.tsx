// ============================================================================
// CompareMenu — the browser header's `Compare…` action. It replaces the two
// always-visible endpoint pickers: the header names the task, and arbitrary
// endpoint selection lives one click away. The menu offers the three common
// comparisons plus a custom From → To pair, built from the same StatePicker the
// single-state read still uses.
//
// The list reuses the state picker's portal pattern (viewport overlay + fixed
// panel). Escape closes the menu (and a nested picker first) without also
// closing the browser.
// ============================================================================

import { useEffect, useRef, useState } from "react";
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
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	// A nested state list is open; Escape must close it before the menu.
	const [nestedOpen, setNestedOpen] = useState(false);
	// Draft endpoints, seeded from the current target each time the menu opens
	// so a cancelled edit never leaks into the next open.
	const [from, setFrom] = useState(baseline ?? "head");
	const [to, setTo] = useState(state);

	const open = () => {
		setFrom(baseline ?? "head");
		setTo(state);
		setNestedOpen(false);
		setAnchor(buttonRef.current?.getBoundingClientRect() ?? null);
	};

	// Capture phase: the browser's own Escape listener is on the document in the
	// bubble phase, so stopping here closes the menu without the view. A nested
	// picker reports its open state and handles Escape itself first.
	useEffect(() => {
		if (anchor === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || nestedOpen) return;
			e.stopPropagation();
			setAnchor(null);
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [anchor, nestedOpen]);

	const apply = (nextBaseline: string, nextState: string) => {
		setAnchor(null);
		onApply(nextBaseline, nextState);
	};

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={styles.refreshBtn}
				onClick={open}
				aria-haspopup="dialog"
				aria-expanded={anchor !== null}
				title="Compare repository states"
			>
				Compare…
			</button>
			{anchor && (
				<>
					<button
						type="button"
						aria-label="Close compare menu"
						className={styles.pickerOverlay}
						onClick={() => setAnchor(null)}
					/>
					<div
						role="dialog"
						aria-label="Compare repository states"
						className={styles.compareMenu}
						style={{
							position: "fixed",
							top: anchor.bottom + 4,
							left: Math.max(8, Math.min(anchor.left, window.innerWidth - 324)),
						}}
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
					</div>
				</>
			)}
		</>
	);
}
