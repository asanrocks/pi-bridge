// ============================================================================
// TurnDetailsPanel — the read-only ledger behind a turn header's date
// disclosure (ADR 21).
//
// Statistics left the header because they are diagnostic, not scanning
// information: nobody picks a turn by its tool share. They still have to be one
// tap away, including on touch, so this is an anchored information surface
// (`Popover`, role `dialog`) rather than a tooltip: a `title` is unreachable on
// a phone and unreadable on a long value.
//
// Anatomy: hairline-separated sections of labelled rows. The sections group by
// kind (who produced the turn, how full the window was, how long it took), and
// every value keeps a label because the values are heterogeneous — a model name,
// a percentage, two durations. That is the opposite of the cost popover, whose
// values are all money and therefore describe themselves; a bare "15%" here would
// be a number with no subject.
//
// Rows are computed by `turnDetails.ts` — the rules are data, so they are
// testable without a store or a DOM — and this component owns the ledger
// anatomy and nothing else. Unavailable fields are omitted by the caller rather
// than rendered as zeros: a made-up duration is worse than a missing row.
// ============================================================================

import { Popover } from "../../render/Popover.tsx";
import styles from "./turns.module.css";

export interface DetailRow {
	label: string;
	value: string;
}

/** One group of related readings. The divider is the section's own edge, so a
 *  section heading would be another name for what the values already say. */
export interface DetailSection {
	rows: readonly DetailRow[];
}

export function TurnDetailsPanel({
	anchor,
	sections,
	onClose,
}: {
	anchor: HTMLElement | null;
	sections: readonly DetailSection[];
	onClose: () => void;
}) {
	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			align="start"
			role="dialog"
			label="Turn details"
			className={styles.detailsPanel}
		>
			<div className={styles.detailsBody}>
				{sections.map((section, at) => (
					<dl key={section.rows[0]?.label ?? at} className={styles.detailsSection}>
						{section.rows.map((row) => (
							<div key={row.label} className={styles.detailsRow}>
								<dt className={styles.detailsKey}>{row.label}</dt>
								<dd className={styles.detailsValue}>{row.value}</dd>
							</div>
						))}
					</dl>
				))}
			</div>
		</Popover>
	);
}
