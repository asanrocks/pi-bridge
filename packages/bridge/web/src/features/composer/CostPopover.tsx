// ============================================================================
// CostPopover — floating read-only session-ledger popover anchored to the
// cost button. Opens on click/tap (mobile-friendly, unlike a hover tooltip)
// and closes on outside-click or Escape. Reuses the model-picker portal
// pattern (full-screen overlay + fixed panel) but is read-only and compact.
// Renders the client-side session accounting (viewmodel sessionAccounting):
// total cost, per-model breakdown, and the billed token ledger.
// ============================================================================

import { useEffect } from "react";
import type { ModelInfo } from "../../../../src/core/index.ts";
import type { SessionAccounting } from "../../../../src/viewmodel/index.ts";
import { displayModelLabel } from "../../render/modelNames.ts";
import styles from "./ComposeCard.module.css";
import { formatCost, formatTokens } from "./formatters.ts";

export function CostPopover({
	accounting,
	models,
	anchorRect,
	onClose,
}: {
	accounting: SessionAccounting;
	models: readonly ModelInfo[];
	anchorRect: DOMRect | null;
	onClose: () => void;
}) {
	// Escape closes (overlay handles pointer-away close).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Anchored above the button (the card is bottom-anchored, so the popover
	// opens upward), left-aligned to it. The cost button sits on the left of
	// the control row, so left-alignment stays on-screen.
	return (
		<>
			<button type="button" aria-label="Close" className={styles.portalOverlay} onClick={onClose} />
			<div
				className={styles.costPopover}
				style={
					anchorRect
						? {
								position: "fixed",
								bottom: window.innerHeight - anchorRect.top + 4,
								left: anchorRect.left,
							}
						: undefined
				}
			>
				<div className={styles.costPopoverHeader}>
					<span className={styles.costPopoverLabel}>Session cost</span>
					<span className={styles.costPopoverTotal}>{formatCost(accounting.cost)}</span>
				</div>
				{accounting.byModel.length > 0 && (
					<div className={styles.costPopoverModels}>
						{accounting.byModel.map((row) => (
							<div key={row.key} className={styles.costPopoverModelRow}>
								<span className={styles.costPopoverModelKey} title={row.key}>
									{displayModelLabel(row.provider, row.modelId, models)}
								</span>
								<span className={styles.costPopoverModelCost}>{formatCost(row.cost)}</span>
							</div>
						))}
					</div>
				)}
				<div className={styles.costPopoverTokens}>
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
		</>
	);
}
