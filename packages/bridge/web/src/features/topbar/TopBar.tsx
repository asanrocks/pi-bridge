// ============================================================================
// TopBar — spans only the middle column (between the left Sidebar and the
// right HistoryPane), so it shares the viewport width with both side panes
// instead of overlaying them. Left edge: hamburger (toggles left Sidebar).
// Right edge: history toggle (toggles right HistoryPane) — symmetric with the
// hamburger so each side pane has its toggle on its own side. Between them:
// inline-edit session name and a connection chip (down states only).
// ============================================================================

import { useEffect, useRef, useState } from "react";
import type { ConnectionState } from "../../infra/store.ts";
import styles from "./TopBar.module.css";

export function TopBar({
	name,
	connection,
	onSidebarToggle,
	onHistory,
	onRename,
	onRetry,
}: {
	name: string;
	connection: ConnectionState;
	onSidebarToggle: () => void;
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

	const chip = connectionChip(connection);

	return (
		<div className={styles.topBar}>
			<button type="button" className={styles.topBarBtn} onClick={onSidebarToggle} aria-label="Toggle sidebar">
				<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" role="img" aria-label="Menu">
					<rect x="3" y="6" width="18" height="2" />
					<rect x="3" y="11" width="18" height="2" />
					<rect x="3" y="16" width="18" height="2" />
				</svg>
			</button>
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
			{chip && (
				<button type="button" className={`${styles.connChip} ${chip.cls}`} onClick={onRetry} title={chip.title}>
					<span className={styles.connDot} aria-hidden="true" />
					{chip.label}
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

function connectionChip(c: ConnectionState): {
	label: string;
	cls: string;
	title: string;
} | null {
	switch (c.kind) {
		case "connected":
			return null;
		case "connecting":
			return { label: "Connecting…", cls: styles.connMuted, title: "Connecting to the daemon" };
		case "reconnecting":
			return {
				label: `Reconnecting (${c.attempt})`,
				cls: styles.connWarn,
				title: "Connection dropped — retrying",
			};
		case "unreachable":
			return {
				label: "Offline",
				cls: styles.connErr,
				title: "Can't reach pi-bridge — click to retry",
			};
		case "init_failed":
			return {
				label: "Error",
				cls: styles.connErr,
				title: c.error || "Daemon unresponsive",
			};
	}
}
