// ============================================================================
// Dialog — the app's small centered portal surface (blocking overlay +
// panel). Escape and the backdrop close it; one host owns the overlay,
// elevation, and dismissal so dialogs do not restyle them apiece.
//
// Escape is handled in the bubble phase, matching the external-link confirm
// that used to own this markup.
// ============================================================================

import { type ReactNode, useEffect } from "react";
import styles from "./Dialog.module.css";

export function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<>
			<button type="button" aria-label="Close dialog" className={styles.overlay} onClick={onClose} />
			<div role="dialog" aria-modal="true" aria-label={label} className={styles.panel}>
				{children}
			</div>
		</>
	);
}
