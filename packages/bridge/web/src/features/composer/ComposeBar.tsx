// ============================================================================
// ComposeBar — the collapsed compose surface: a 44px pill inside the shared
// card shell (status dot + placeholder). Deliberately dumb: it owns no state
// and doesn't even know about "expand" — it reports clicks. All semantics
// (dormant draft, expansion, focus) live in the session container. Never
// rendered on the Project home, which is always expanded.
// ============================================================================

import { memo } from "react";
import styles from "./ComposeCard.module.css";

export type ComposeDot = "green" | "orange" | "red";

export const ComposeBar = memo(function ComposeBar({
	dot,
	placeholder,
	onClick,
	disabled,
}: {
	dot: ComposeDot;
	placeholder: string;
	onClick: () => void;
	disabled: boolean;
}) {
	const dotClass =
		dot === "green" ? styles.composerDotGreen : dot === "orange" ? styles.composerDotOrange : styles.composerDotRed;
	return (
		<div className={styles.composerCard}>
			<button type="button" className={styles.composerBar} onClick={onClick} disabled={disabled}>
				<span className={`${styles.composerDot} ${dotClass}`} />
				{placeholder}
			</button>
		</div>
	);
});
