// ============================================================================
// TurnHeader — the one turn-header layout (ADR 21).
//
// Reading order is fixed and every item yields instead of painting: the date
// disclosure, an existing label, a trailing reading (context usage), the
// controls the measured column affords, and the overflow menu. Missing fields
// take no space, so a turn with no label and no reading is just a date and a
// menu rather than a row of placeholders.
//
// What is *not* here is the point: the role verb, the model and provider, the
// completed durations, the deliberation interval, and the git identity all left
// the header. Two of them were the reader's scanning signals ("You", the model
// in force) and the rest were diagnostics; diagnostics are now the date's
// disclosure, and the role survives as the tinted row versus the flat one plus
// each turn's own accessible name.
//
// Ownership is exclusive: callers derive `controls` and `menuItems` from the
// same `inlineControls(density)` answer, so a command can never appear in both
// places. This component owns the mechanics — disclosure state, the label
// editor, dismissal, and the guarantee that only one of its three surfaces
// (details, menu, label editor) is open at a time.
// ============================================================================

import { memo, type ReactNode, useCallback, useRef, useState } from "react";
import { formatWhen, formatWhenFull } from "../../infra/lib/time.ts";
import { useNow } from "../../infra/lib/useNow.ts";
import { AnchoredMenu, type MenuItem } from "../../render/AnchoredMenu.tsx";
import { ClockIcon, MoreIcon } from "../../render/icons.tsx";
import type { HeaderDensity } from "./headerDensity.ts";
import { LabelChip, LabelEditor } from "./LabelSlot.tsx";
import { type DetailSection, TurnDetailsPanel } from "./TurnDetailsPanel.tsx";
import styles from "./turns.module.css";

export interface TurnHeaderProps {
	/** The instant the header names. Callers resolve their own fallback (an
	 *  unsealed turn reports its start anchor) so the date appears with the first
	 *  frame instead of after the first entry seals. */
	timestamp: string;
	density: HeaderDensity;
	/** The date's disclosure content: hairline-separated sections of labelled
	 *  rows. The date stays a trigger even with no sections — an exact instant is
	 *  worth having — so the panel is never rendered empty. */
	details: readonly DetailSection[];
	/** Present on user turns: the label chip and, through the menu, its
	 *  creation. Absent on every other turn type. */
	label?: { entryId: string; label: string | undefined };
	/** The trailing value reading before the controls (assistant context
	 *  usage). A reading is not a control: it opens nothing. */
	reading?: { text: string; title: string };
	/** State that sits beside the label and is never revealed by hover: the
	 *  header's commands fade in, a state indicator must not (an `Editing`
	 *  message whose badge appeared only on hover would be a hidden state). */
	badge?: ReactNode;
	/** Inline controls for this density — already filtered by the caller. */
	controls?: ReactNode;
	/** Commands the menu owns at this density, in display order. */
	menuItems: readonly MenuItem[];
	/** The menu's accessible name ("Turn actions"). */
	menuLabel: string;
}

export const TurnHeader = memo(function TurnHeader({
	timestamp,
	density,
	details,
	label,
	badge,
	reading,
	controls,
	menuItems,
	menuLabel,
}: TurnHeaderProps) {
	const now = useNow();
	const dateText = formatWhen(timestamp, now);
	const fullInstant = formatWhenFull(timestamp);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [labelEditing, setLabelEditing] = useState(false);
	const dateRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLButtonElement>(null);
	const labelRef = useRef<HTMLButtonElement>(null);

	// One transient surface at a time: a menu opened while the ledger stands
	// would leave two backdrops and two Escape owners.
	const openDetails = useCallback(() => {
		setMenuOpen(false);
		setLabelEditing(false);
		setDetailsOpen((open) => !open);
	}, []);
	const openMenu = useCallback(() => {
		setDetailsOpen(false);
		setLabelEditing(false);
		setMenuOpen((open) => !open);
	}, []);

	// Creating a label is a menu command; the editor anchors to the chip when
	// there is one (editing an existing label) and to the menu trigger
	// otherwise, so the panel never opens detached from what was clicked.
	const items: MenuItem[] =
		label && label.label === undefined
			? [...menuItems, { key: "label", label: "Create label", onSelect: () => setLabelEditing(true) }]
			: [...menuItems];
	const labelAnchor = labelRef.current ?? menuRef.current ?? dateRef.current;

	return (
		<div className={styles.turnHeader} data-density={density}>
			<button
				ref={dateRef}
				type="button"
				className={styles.turnHeaderDate}
				onClick={openDetails}
				aria-haspopup="dialog"
				aria-expanded={detailsOpen}
				aria-label={fullInstant ? `Turn details — ${fullInstant}` : "Turn details"}
			>
				{/* An unknown instant is still a disclosure, so the trigger keeps its
				    shape as a mark rather than borrowing the word `Details`: the slot holds a
				    time everywhere else, and a word there reads as a verb among values. */}
				{dateText ? <time dateTime={timestamp}>{dateText}</time> : <ClockIcon size={12} />}
			</button>
			{label?.label !== undefined && (
				<LabelChip buttonRef={labelRef} label={label.label} onOpen={() => setLabelEditing(true)} />
			)}
			{badge}
			{/* The reading stays in the flow beside the date, not docked to the
			    controls: a value's position should not move when the control set changes
			    with the column's tier, and the right edge belongs to actions. It cannot
			    compete for width either — a reading is an assistant field and a label is
			    a user one, so the two never share a header. */}
			{reading && (
				<span className={styles.turnHeaderReading} title={reading.title}>
					{reading.text}
				</span>
			)}
			<div className={styles.turnHeaderRight}>
				{controls}
				{items.length > 0 && (
					<button
						ref={menuRef}
						type="button"
						className={styles.toolbarBtn}
						onClick={openMenu}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						aria-label={menuLabel}
						title={menuLabel}
					>
						<MoreIcon size={14} />
					</button>
				)}
			</div>
			{detailsOpen && (
				<TurnDetailsPanel anchor={dateRef.current} sections={details} onClose={() => setDetailsOpen(false)} />
			)}
			{menuOpen && (
				<AnchoredMenu
					anchor={menuRef.current}
					items={items}
					onClose={() => setMenuOpen(false)}
					align="end"
					label={menuLabel}
				/>
			)}
			{labelEditing && label && (
				<LabelEditor
					entryId={label.entryId}
					label={label.label}
					anchor={labelAnchor}
					onClose={() => setLabelEditing(false)}
				/>
			)}
		</div>
	);
});
