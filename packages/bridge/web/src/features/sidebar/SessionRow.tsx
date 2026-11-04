// ============================================================================
// SessionRow — one sidebar leaf: liveness dot + label + relative time, plus
// the row menu. Close appears on live rows, Archive on any durable row (a
// dormant row's close is a no-op, so only the move remains). The menu's glyph
// is the overflow dots, never the hamburger: that one is the Sidebar's own
// disclosure, and this row's menu is not that menu.
// ============================================================================

import { memo, useRef, useState } from "react";
import type { SessionInfo } from "../../../../src/core/index.ts";
import { formatWhen, formatWhenFull } from "../../infra/lib/time.ts";
import { useNow } from "../../infra/lib/useNow.ts";
import { MoreIcon } from "../../render/icons.tsx";
import { Popover } from "../../render/Popover.tsx";
import styles from "./Sidebar.module.css";

export const SessionRow = memo(function SessionRow({
	session,
	dot,
	selected,
	onOpen,
	onClose,
	onArchive,
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
	 * adds Close to the row menu, which terminates it. No confirmation —
	 * the kill is the point. */
	onClose?: (session: SessionInfo) => void;
	/** Present on any row with a durable file (pinned and history): adds
	 * Archive, which closes the session then moves its file out of
	 * discovery. Also unconfirmed — the file survives. */
	onArchive?: (session: SessionInfo) => void;
}) {
	const label = (session.name || session.firstMessageText || session.stem) ?? "";
	const now = useNow();
	const menuBtnRef = useRef<HTMLButtonElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
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
					<time
						className={styles.sidebarItemTime}
						dateTime={session.timestamp}
						title={formatWhenFull(session.timestamp)}
					>
						{formatWhen(session.timestamp, now)}
					</time>
				</span>
			</button>
			{(onClose || onArchive) && (
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
