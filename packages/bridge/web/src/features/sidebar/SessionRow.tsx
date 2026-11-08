// ============================================================================
// SessionRow — one sidebar leaf: state indicator + name + relative time (plus,
// for working rows, a one-line status), and the row menu. The indicator is the
// quick state control (ADR 23): inactive → notified (a click promotes old
// work), notified ↔ deferred (park it / bring it back by decision). A busy
// row's indicator is a read-only mark — the execution owns that state.
// The menu keeps the two actions that are not state toggles: Mark inactive
// (leave the work queue; terminates a runtime first when one exists) and
// Archive (history management, from the durable file). The menu's glyph is
// the overflow dots, never the hamburger: that one is the Sidebar's own
// disclosure, and this row's menu is not that menu.
// ============================================================================

import { memo, useRef, useState } from "react";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { formatWhen, formatWhenFull } from "../../infra/lib/time.ts";
import { useNow } from "../../infra/lib/useNow.ts";
import { MoreIcon } from "../../render/icons.tsx";
import { Popover } from "../../render/Popover.tsx";
import { activityLabel } from "./activityLabel.ts";
import styles from "./Sidebar.module.css";

/** The row's mark, derived from the session's durable state alone. */
export type RowMark = "notified" | "busy" | "deferred" | "idle";

/** What clicking the indicator does, or why it does nothing: the state store
 * owns the preconditions, so the row only names the gesture. */
const INDICATOR: Record<RowMark, { target: "notified" | "deferred"; label: string } | null> = {
	// A dormant session is outside the queue: one click brings it back.
	idle: { target: "notified", label: "Mark as waiting" },
	notified: { target: "deferred", label: "Park this session" },
	deferred: { target: "notified", label: "Mark as waiting" },
	// Running: the execution, not the user, owns this state.
	busy: null,
};

export const SessionRow = memo(function SessionRow({
	session,
	mark,
	selected,
	onOpen,
	onMarkInactive,
	onArchive,
	onSetState,
}: {
	session: SessionInfo;
	/** The durable state's mark: notified = awaits input, busy = execution in
	 * flight, deferred = parked, idle = dormant history. */
	mark: RowMark;
	/** Attached session ("you are here"): the one row wearing the accent
	 * tint. Matched on (projectId, stem) — rows always carry stems, so no
	 * sessionId fallback is needed. */
	selected?: boolean;
	onOpen: (session: SessionInfo) => void;
	/** Present on every row: adds Mark inactive to the row menu, which clears
	 * queue membership (terminating a runtime first when one exists). No
	 * confirmation — leaving the queue is the point. */
	onMarkInactive?: (session: SessionInfo) => void;
	/** Present on every row with a durable file: adds Archive, which closes
	 * the session then moves its file out of discovery. Also unconfirmed —
	 * the file survives. */
	onArchive?: (session: SessionInfo) => void;
	/** The indicator's quick toggle: absent on a busy row, where the mark is
	 * read-only. */
	onSetState?: (session: SessionInfo, state: "notified" | "deferred") => void;
}) {
	const label = (session.name || session.firstMessageText || session.stem) ?? "";
	const now = useNow();
	const menuBtnRef = useRef<HTMLButtonElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const dotCls = [
		styles.sidebarLiveDot,
		mark === "busy"
			? styles.sidebarLiveDotStreaming
			: mark === "deferred"
				? styles.sidebarDotDeferred
				: mark === "idle"
					? styles.sidebarDotIdle
					: "",
	]
		.filter(Boolean)
		.join(" ");
	const indicator = INDICATOR[mark];
	const canToggle = indicator !== null && onSetState !== undefined;
	// The working row's second line: what the agent is doing (busy) or what it
	// last said (notified). Parked and inactive rows stay one line.
	const status =
		mark === "busy"
			? activityLabel(session.activity, now)
			: mark === "notified"
				? (session.lastMessageText ?? "")
				: "";
	return (
		<div className={styles.sidebarItemWrap}>
			{/* The indicator sits in the row's own leading column, drawn by the
			    row (layout) and operated by this sibling button (a button inside
			    a button is invalid HTML). Its hit area is larger than the 6px
			    mark — the mark is the signal, not the target. */}
			{canToggle && (
				<button
					type="button"
					className={styles.sidebarStateBtn}
					onClick={() => onSetState(session, indicator.target)}
					title={indicator.label}
					aria-label={indicator.label}
				/>
			)}
			<button
				type="button"
				className={[styles.sidebarItem, selected ? styles.sidebarItemSelected : ""].filter(Boolean).join(" ")}
				onClick={() => onOpen(session)}
				title={label}
				aria-current={selected ? "page" : undefined}
			>
				<span className={dotCls} aria-hidden="true" />
				<span className={styles.sidebarItemText}>
					<span className={styles.sidebarItemRow}>
						<span className={styles.sidebarItemName}>{label.slice(0, 60)}</span>
						<time
							className={styles.sidebarItemTime}
							dateTime={session.timestamp}
							title={formatWhenFull(session.timestamp)}
						>
							{formatWhen(session.timestamp, now)}
						</time>
					</span>
					{status !== "" && <span className={styles.sidebarItemStatus}>{status}</span>}
				</span>
			</button>
			{(onMarkInactive || onArchive) && (
				<button
					ref={menuBtnRef}
					type="button"
					className={styles.sidebarMenuBtn}
					aria-label="Session menu"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onClick={(e) => {
						e.stopPropagation();
						setMenuOpen((v) => !v);
					}}
				>
					<MoreIcon size={14} />
				</button>
			)}
			{menuOpen && (
				<Popover
					anchor={menuBtnRef.current}
					onClose={() => setMenuOpen(false)}
					role="menu"
					label="Session menu"
					className={styles.rowMenu}
				>
					{onMarkInactive && (
						<button
							type="button"
							className={styles.sidebarMenuItem}
							onClick={() => {
								setMenuOpen(false);
								onMarkInactive(session);
							}}
						>
							Mark inactive
						</button>
					)}
					{onArchive && (
						<button
							type="button"
							className={[styles.sidebarMenuItem, styles.sidebarMenuArchive].join(" ")}
							onClick={() => {
								setMenuOpen(false);
								onArchive(session);
							}}
						>
							Archive
						</button>
					)}
				</Popover>
			)}
		</div>
	);
});
