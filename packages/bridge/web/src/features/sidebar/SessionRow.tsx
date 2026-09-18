// ============================================================================
// SessionRow — one sidebar leaf: liveness dot + label + relative time, plus
// the row menu (Close) on live rows.
// ============================================================================

import { memo, useState } from "react";
import type { SessionInfo } from "../../../../src/core/index.ts";
import styles from "./Sidebar.module.css";
import { relativeTime } from "./timeUtils.ts";

export const SessionRow = memo(function SessionRow({
	session,
	dot,
	selected,
	onOpen,
	onClose,
}: {
	session: SessionInfo;
	/** Green = active, orange + pulse = streaming, muted = dormant history. */
	dot: "active" | "streaming" | "idle";
	/** Attached session ("you are here"): the one row wearing the accent
	 * tint. Matched on (projectId, stem) — rows always carry stems, so no
	 * sessionId fallback is needed. */
	selected?: boolean;
	onOpen: (session: SessionInfo) => void;
	/** Present only on rows with a live instance (the pinned active section):
	 * opens the row menu whose Close item terminates it. No confirmation —
	 * the kill is the point. */
	onClose?: (session: SessionInfo) => void;
}) {
	const label = (session.name || session.firstMessageText || session.stem) ?? "";
	const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
	const dotCls = [
		styles.sidebarLiveDot,
		dot === "streaming" ? styles.sidebarLiveDotStreaming : dot === "idle" ? styles.sidebarDotIdle : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={styles.sidebarItemWrap}>
			<button
				type="button"
				className={[styles.sidebarItem, selected ? styles.sidebarItemSelected : ""].filter(Boolean).join(" ")}
				onClick={() => onOpen(session)}
				title={label}
				aria-current={selected ? "page" : undefined}
			>
				<span className={dotCls} aria-hidden="true" />
				<span className={styles.sidebarItemRow}>
					<span className={styles.sidebarItemName}>{label.slice(0, 60)}</span>
					<span className={styles.sidebarItemTime}>{relativeTime(session.timestamp)}</span>
				</span>
			</button>
			{onClose && (
				<button
					type="button"
					className={styles.sidebarMenuBtn}
					aria-label="Session menu"
					aria-haspopup="menu"
					aria-expanded={menuAnchor !== null}
					onClick={(e) => {
						e.stopPropagation();
						setMenuAnchor(e.currentTarget.getBoundingClientRect());
					}}
				>
					<svg
						viewBox="0 0 16 16"
						width="14"
						height="14"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
					</svg>
				</button>
			)}
			{menuAnchor && (
				<>
					<button
						type="button"
						aria-label="Close menu"
						className={styles.portalOverlay}
						onClick={() => setMenuAnchor(null)}
					/>
					<div
						className={styles.cwdPopover}
						style={{
							position: "fixed",
							top: menuAnchor.bottom + 4,
							left: Math.max(8, Math.min(menuAnchor.right - 130, window.innerWidth - 130 - 8)),
							width: 130,
						}}
					>
						<button
							type="button"
							className={styles.sidebarMenuClose}
							onClick={() => {
								setMenuAnchor(null);
								onClose?.(session);
							}}
						>
							Close
						</button>
					</div>
				</>
			)}
		</div>
	);
});
