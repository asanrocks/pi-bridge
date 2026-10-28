// ============================================================================
// TopBar — spans only the middle column (between the left Sidebar and the
// right HistoryPane), so it shares the viewport width with both side panes
// instead of overlaying them. Left edge: hamburger (toggles left Sidebar;
// mobile or desktop-with-sidebar-hidden — hover peeks the drawer there).
// Right edge: history clock (toggles right HistoryPane) — symmetric with the
// hamburger so each side pane has its toggle on its own side, including the
// hover peek and the hide-when-open rule (each pane's own surface carries
// its close affordance). Hidden on the launcher, where there is no history. Between them:
// inline-edit session name and the connection icon (down states only) — an
// icon-only broken-link control on the ghost spec: motion = trying, stillness
// = failed; click retries; text lives in the tooltip/aria-label only.
// ============================================================================

import { memo, useEffect, useRef, useState } from "react";
import { connectionStatus } from "../../infra/state/connectionStatus.ts";
import type { ConnectionState } from "../../infra/state/store.ts";
import { BrokenLinkIcon, ClockIcon, MenuIcon } from "../../render/icons.tsx";
import { ChangesBadge } from "./ChangesBadge.tsx";
import styles from "./TopBar.module.css";

// Memoized: App re-renders on every streaming patch (it hosts the ViewModel
// projection), so the TopBar must bail on identical props — which requires
// every prop to be stable, including the rename callback App passes
// (useCallback there). That is what keeps the ChangesBadge from re-rendering
// per delta: its own subscriptions are primitive slices (leafId, isStreaming)
// that hold steady while a turn streams.
export const TopBar = memo(function TopBar({
	name,
	connection,
	showSidebarToggle,
	onSidebarToggle,
	onSidebarHover,
	showHistoryToggle,
	onHistory,
	onHistoryHover,
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
	/** History-clock visibility — the mirrored rule: hidden on the launcher
	 *  (no session, no history) and whenever the HistoryPane has an open
	 *  surface of its own (rail/fullscreen carry their own close). */
	showHistoryToggle: boolean;
	onHistory: () => void;
	/** Hover signal for the history peek drawer, symmetric with
	 *  onSidebarHover. */
	onHistoryHover?: (inside: boolean) => void;
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
					<MenuIcon size={20} />
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
					className={`${styles.topBarBtn} ${CONN_TONE[status.tone]} ${
						status.phase === "trying" ? (status.tone === "err" ? styles.connTryingErr : styles.connTrying) : ""
					}`}
					onClick={onRetry}
					title={status.detail}
					aria-label={status.label}
				>
					<BrokenLinkIcon size={20} />
				</button>
			)}
			<ChangesBadge />
			{showHistoryToggle && (
				<button
					type="button"
					className={styles.topBarBtn}
					onClick={onHistory}
					onMouseEnter={() => onHistoryHover?.(true)}
					onMouseLeave={() => onHistoryHover?.(false)}
					aria-label="Conversation history"
					title="Conversation history"
				>
					<ClockIcon size={20} />
				</button>
			)}
		</div>
	);
});

/** Tone → icon color class; the Launcher maps phases to its own classes. */
const CONN_TONE = {
	muted: styles.connMuted,
	err: styles.connErr,
} as const;
