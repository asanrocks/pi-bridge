// ============================================================================
// SessionRow — one sidebar leaf: state dot + label + relative time, plus
// the row menu. Queue rows carry the session's durable state:
// notified (green), busy (streaming pulse), deferred (parked tint). History
// rows keep the muted dot. The menu's verbs: Close and Defer/Restore on
// queue rows (a queued session can be closed or parked without opening it),
// Archive on any durable row. The menu's glyph is the overflow dots, never
// the hamburger: that one is the Sidebar's own disclosure, and this row's
// menu is not that menu.
// ============================================================================

import { memo, useRef, useState } from "react";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { formatWhen, formatWhenFull } from "../../infra/lib/time.ts";
import { useNow } from "../../infra/lib/useNow.ts";
import { MoreIcon } from "../../render/icons.tsx";
import { Popover } from "../../render/Popover.tsx";
import styles from "./Sidebar.module.css";

/** The row's mark, derived from the session's durable state alone. */
export type RowMark = "notified" | "busy" | "deferred" | "idle";

export const SessionRow = memo(function SessionRow({
	session,
	mark,
	selected,
	onOpen,
	onClose,
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
	/** Present only on queue rows: adds Close to the row menu, which clears
	 * queue membership (terminating a runtime first when one exists). No
	 * confirmation — the kill is the point. */
	onClose?: (session: SessionInfo) => void;
	/** Present on any row with a durable file (queue and history): adds
	 * Archive, which closes the session then moves its file out of
	 * discovery. Also unconfirmed — the file survives. */
	onArchive?: (session: SessionInfo) => void;
	/** Present only on non-busy queue rows: adds Defer (from notified) or
	 * Restore (from deferred) — the user's parking toggle. */
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
	const deferTarget = session.state === "deferred" ? "notified" : "deferred";
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
					<time
						className={styles.sidebarItemTime}
						dateTime={session.timestamp}
						title={formatWhenFull(session.timestamp)}
					>
						{formatWhen(session.timestamp, now)}
					</time>
				</span>
			</button>
			{(onClose || onArchive || onSetState) && (
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
					{onClose && (
						<button
							type="button"
							className={[styles.sidebarMenuItem, styles.sidebarMenuClose].join(" ")}
							onClick={() => {
								setMenuOpen(false);
								onClose(session);
							}}
						>
							Close
						</button>
					)}
					{onSetState && (
						<button
							type="button"
							className={styles.sidebarMenuItem}
							onClick={() => {
								setMenuOpen(false);
								onSetState(session, deferTarget);
							}}
						>
							{deferTarget === "deferred" ? "Defer" : "Restore"}
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
