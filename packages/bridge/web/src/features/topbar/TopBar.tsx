// ============================================================================
// TopBar — spans only the middle column (between the left Sidebar and the
// right HistoryPane), so it shares the viewport width with both side panes
// instead of overlaying them. Left edge: hamburger (toggles left Sidebar;
// mobile or desktop-with-sidebar-hidden — hover peeks the drawer there).
// Right edge: history clock (toggles right HistoryPane) — symmetric with the
// hamburger so each side pane has its toggle on its own side, including the
// hover peek and the hide-when-open rule (each pane's own surface carries
// its close affordance). Hidden on the launcher, where there is no history. Between them:
// the rendered object's name — an inline-editable Session name, or the Project
// id on its home as plain text — and the connection icon (down states only) — an
// icon-only broken-link control on the ghost spec: motion = trying, stillness
// = failed, amber pulse = version skew; click runs the one action the state
// offers (retry, or reload into the daemon's app); text lives in the
// tooltip/aria-label only.
// ============================================================================

import { memo, useEffect, useRef, useState } from "react";
import { reloadFromDaemon } from "../../infra/lib/appUpgrade.ts";
import { type ConnectionStatus, connectionStatus } from "../../infra/state/connectionStatus.ts";
import type { ConnectionState } from "../../infra/state/store.ts";
import { BrokenLinkIcon, ClockIcon, MenuIcon } from "../../render/icons.tsx";
import { RepositoryMenu } from "./RepositoryMenu.tsx";
import styles from "./TopBar.module.css";

// Memoized: App re-renders on every streaming patch (it hosts the ViewModel
// projection), so the TopBar must bail on identical props — which requires
// every prop to be stable, including the rename callback App passes
// (useCallback there). That is what keeps the RepositoryMenu from re-rendering
// per delta: its own subscriptions are primitive slices (project cwd, leafId,
// isStreaming) that hold steady while a turn streams.
export const TopBar = memo(function TopBar({
	name,
	connection,
	showSidebarToggle,
	onSidebarToggle,
	menuButtonRef,
	waitingCount,
	waitingNewCount,
	onSidebarHover,
	showHistoryToggle,
	onHistory,
	onHistoryHover,
	canRename,
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
	/** The menu button's element: the compact switcher's popover anchor.
	 * Owned by the sidebar shell because both surfaces are its policy. */
	menuButtonRef?: React.Ref<HTMLButtonElement>;
	/** Sessions other than this one waiting for a reply — Inbox rows with
	 * nothing running, minus the attached Session when it is itself waiting
	 * (see `./waitingBadge`). The badge is the passive half of the switcher:
	 * what still needs an answer is visible while the pane is closed. */
	waitingCount: number;
	/** Of those, how many finished since this page last read them: the badge's
	 *  novelty dot. A second channel, never a second count — the number keeps
	 *  meaning "an answer is owed" whether or not the answer is new. */
	waitingNewCount: number;
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
	/** A Session is rendered, so `name` is a Session name and the slot is its
	 *  rename control. False on the Project home and the Launcher: the slot is
	 *  text, because the object it names (a Project id, or the app) is not
	 *  renameable and a click would rename the Session being left. */
	canRename: boolean;
	onRename: (name: string) => Promise<void>;
	onRetry: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [editName, setEditName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	// The dot is state (something is unread); the pulse is the arrival, so it
	// replays once per new completion and stops on its own — a loop would be an
	// alarm that keeps spending attention.
	const [pulsing, setPulsing] = useState(false);
	const seenNewCount = useRef(waitingNewCount);
	useEffect(() => {
		const arrived = waitingNewCount > seenNewCount.current;
		seenNewCount.current = waitingNewCount;
		if (arrived) setPulsing(true);
		else if (waitingNewCount === 0) setPulsing(false);
	}, [waitingNewCount]);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
		}
	}, [editing]);

	// Renaming is a Session operation: when the Session closes with the edit box
	// open, the mode ends with it, so the next Session does not open into a stale
	// name. Drop the state too, not just the render, for that next Session.
	useEffect(() => {
		if (!canRename) setEditing(false);
	}, [canRename]);

	const status = connectionStatus(connection);

	return (
		<div className={styles.topBar}>
			{showSidebarToggle && (
				<button
					ref={menuButtonRef}
					type="button"
					className={styles.topBarBtn}
					onClick={onSidebarToggle}
					onMouseEnter={() => onSidebarHover?.(true)}
					onMouseLeave={() => onSidebarHover?.(false)}
					aria-label={
						waitingCount > 0
							? `Toggle sidebar — ${waitingCount} waiting elsewhere${waitingNewCount > 0 ? `, ${waitingNewCount} new` : ""}`
							: "Toggle sidebar"
					}
				>
					<MenuIcon size={20} />
					{waitingCount > 0 && (
						<span
							className={[
								styles.topBarBadge,
								waitingNewCount > 0 ? styles.topBarBadgeNew : "",
								pulsing ? styles.topBarBadgeArrival : "",
							]
								.filter(Boolean)
								.join(" ")}
							aria-hidden="true"
							onAnimationEnd={() => setPulsing(false)}
						>
							{waitingCount > 99 ? "+99" : `+${waitingCount}`}
						</span>
					)}
				</button>
			)}
			{editing && canRename ? (
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
			) : canRename ? (
				<button
					type="button"
					className={`${styles.topBarTitle} ${styles.topBarTitleEditable}`}
					onClick={() => {
						setEditName(name);
						setEditing(true);
					}}
				>
					{name || "pi-bridge"}
				</button>
			) : (
				<div className={styles.topBarTitle}>{name || "pi-bridge"}</div>
			)}
			{status && (
				<button
					type="button"
					className={`${styles.topBarBtn} ${CONN_TONE[status.tone]} ${motionClass(status)}`}
					onClick={() => {
						// The state names its own remedy (see connectionStatus.ts): only a
						// stale app can be replaced from the page.
						if (status.action === "reload-app") void reloadFromDaemon();
						else onRetry();
					}}
					title={status.detail}
					aria-label={status.label}
				>
					<BrokenLinkIcon size={20} />
				</button>
			)}
			<RepositoryMenu />
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
	warn: styles.connWarn,
} as const;

/** Motion = what the icon is doing: reaching (a retry loop), standing still, or
 * pulsing for attention because nothing retries a version mismatch. */
function motionClass(status: ConnectionStatus): string {
	if (status.blink) return styles.connAttention;
	if (status.phase !== "trying") return "";
	return status.tone === "err" ? styles.connTryingErr : styles.connTrying;
}
