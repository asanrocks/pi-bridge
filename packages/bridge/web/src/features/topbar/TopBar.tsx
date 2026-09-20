// ============================================================================
// TopBar — spans only the middle column (between the left Sidebar and the
// right HistoryPane), so it shares the viewport width with both side panes
// instead of overlaying them. Left edge: hamburger (toggles left Sidebar;
// mobile or desktop-with-sidebar-hidden — hover peeks the drawer there).
// Right edge: history toggle (toggles right HistoryPane) — symmetric with the
// hamburger so each side pane has its toggle on its own side. Between them:
// inline-edit session name and a connection chip (down states only).
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { connectionStatus } from "../../infra/state/connectionStatus.ts";
import type { ConnectionState } from "../../infra/state/store.ts";
import styles from "./TopBar.module.css";

export function TopBar({
	name,
	connection,
	showSidebarToggle,
	onSidebarToggle,
	onSidebarHover,
	onHistory,
	onRename,
	onRetry,
}: {
	name: string;
	connection: ConnectionState;
	/** Hamburger visibility: mobile, or desktop with the sidebar hidden
	 *  (the Sidebar reports its mode to the App, which owns this flag). In
	 *  desktop rail mode the rail's own edge is the close affordance. */
	showSidebarToggle: boolean;
	onSidebarToggle: () => void;
	/** Hover signal for the peek drawer (desktop, sidebar hidden):
	 *  true = pointer entered the hamburger, false = left it. Forwarded
	 *  raw to the Sidebar, which owns the peek drawer and the grace timer
	 *  bridging the hamburger → drawer gap. */
	onSidebarHover?: (inside: boolean) => void;
	onHistory: () => void;
	onRename: (name: string) => Promise<void>;
	onRetry: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [editName, setEditName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
		}
	}, [editing]);

	const status = connectionStatus(connection);

	return (
		<div className={styles.topBar}>
			{showSidebarToggle && (
				<button
					type="button"
					className={styles.topBarBtn}
					onClick={onSidebarToggle}
					onMouseEnter={() => onSidebarHover?.(true)}
					onMouseLeave={() => onSidebarHover?.(false)}
					aria-label="Toggle sidebar"
				>
					<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" role="img" aria-label="Menu">
						<rect x="3" y="6" width="18" height="2" />
						<rect x="3" y="11" width="18" height="2" />
						<rect x="3" y="16" width="18" height="2" />
					</svg>
				</button>
			)}
			{editing ? (
				<input
					ref={inputRef}
					className={styles.topBarInput}
					value={editName}
					onChange={(e) => setEditName(e.target.value)}
					onBlur={() => setEditing(false)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							onRename(editName);
							setEditing(false);
						}
						if (e.key === "Escape") setEditing(false);
					}}
				/>
			) : (
				<button
					type="button"
					className={styles.topBarTitle}
					onClick={() => {
						setEditName(name);
						setEditing(true);
					}}
				>
					{name || "pi-bridge"}
				</button>
			)}
			{status && (
				<button
					type="button"
					className={`${styles.connChip} ${CHIP_TONE[status.tone]}`}
					onClick={onRetry}
					title={status.detail}
				>
					<span className={styles.connDot} aria-hidden="true" />
					{status.label}
				</button>
			)}
			<button
				type="button"
				className={styles.topBarBtn}
				onClick={onHistory}
				aria-label="Conversation history"
				title="Conversation history"
			>
				<svg
					viewBox="0 0 24 24"
					width="18"
					height="18"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					role="img"
					aria-label="History"
				>
					<circle cx="12" cy="12" r="9" />
					<path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</button>
		</div>
	);
}

/** Severity → chip CSS class; the Launcher maps the same tones to its own. */
const CHIP_TONE = {
	muted: styles.connMuted,
	warn: styles.connWarn,
	err: styles.connErr,
} as const;
