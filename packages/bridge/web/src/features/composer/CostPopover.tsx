// ============================================================================
// CostPopover — the read-only session-ledger panel anchored to the cost button.
// Opens on click/tap (mobile-friendly, unlike a hover tooltip) and closes on
// outside-click or Escape (both are `Popover`'s). It opens upward, because the
// compose card sits at the viewport bottom. Renders the client-side session
// accounting (viewmodel sessionAccounting): total cost, per-model breakdown,
// and the billed token ledger.
// ============================================================================

import { useMemo } from "react";
import { sessionAccounting } from "../../../../src/viewmodel/index.ts";
import { useStore } from "../../infra/state/store.tsx";
import { displayModelLabel } from "../../render/modelNames.ts";
import { Popover } from "../../render/Popover.tsx";
import styles from "./ComposeCard.module.css";
import { formatCost, formatTokens } from "./formatters.ts";

// Self-subscribes its accounting: the dock samples only the cost label (a
// string selector) so it stays quiet while a turn streams; the full per-model
// breakdown lives here, computed only while the popover is open (it then
// re-renders per patch — a transient surface, and live-updating is a feature).
export function CostPopover({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
	const models = useStore((s) => s.models);
	const entries = useStore((s) => s.document.entries);
	// sessionAccounting returns a fresh object, so it cannot be a useStore
	// selector: an unstable getSnapshot makes useSyncExternalStore re-render
	// forever (React error #185). Subscribe to the stable inputs and derive.
	const accounting = useMemo(() => sessionAccounting(entries, models), [entries, models]);
	return (
		<Popover anchor={anchor} onClose={onClose} placement="above" role="dialog" label="Session cost">
			{/* The panel's box is chrome (the shared overlay surface and its 4px pad);
			    this body is content, so its own padding and type live with it rather
			    than in the popover spec. */}
			<div className={styles.ledgerBody}>
				<div className={styles.ledgerHeader}>
					<span className={styles.ledgerLabel}>Session cost</span>
					<span className={styles.ledgerValue}>{formatCost(accounting.cost)}</span>
				</div>
				{accounting.byModel.length > 0 && (
					<div className={`${styles.ledgerSection} ${styles.ledgerRows}`}>
						{accounting.byModel.map((row) => (
							<div key={row.key} className={styles.ledgerRow}>
								<span className={styles.ledgerKey} title={row.key}>
									{displayModelLabel(row.provider, row.modelId, models)}
								</span>
								<span className={styles.ledgerNote}>{formatCost(row.cost)}</span>
							</div>
						))}
					</div>
				)}
				<div className={`${styles.ledgerSection} ${styles.ledgerNote}`}>
					<div>
						In {formatTokens(accounting.input)} · Out {formatTokens(accounting.output)}
					</div>
					<div>
						Cache read {formatTokens(accounting.cacheRead)} · write {formatTokens(accounting.cacheWrite)}
					</div>
					<div>
						Cache hit {accounting.hitRate.toFixed(1)}% · {accounting.requests} requests
					</div>
				</div>
			</div>
		</Popover>
	);
}
