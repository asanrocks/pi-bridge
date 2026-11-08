// ============================================================================
// QuickSwitcher — the compact session switcher for a narrow viewport (ADR 23).
// The fullscreen switcher costs two full-screen moves per skim: open it, find
// the row, then close it to get back to the session being read. This popover
// shows the work that may need the user — the queue's Inbox rows, grouped by
// Project, in the queue's order — and hands the full surface off through one
// `View all` row.
//
// Rows are the sidebar's rows exactly (same order, same mark, same preview
// line, same menu): the compact surface is the sidebar at phone width, not a
// read-only summary, so a Session can be parked from here without opening the
// full pane first. A row menu is a second anchored panel inside this one, so
// the panel stands down from Escape while it is open — the innermost surface
// owns the key.
// ============================================================================

import { memo, useMemo, useState } from "react";
import type { SessionInfo, SessionLocation } from "../../../../src/core/index.ts";
import { Popover } from "../../render/Popover.tsx";
import { quickSwitcherGroups } from "./quickGroups.ts";
import { SessionRow } from "./SessionRow.tsx";
import styles from "./Sidebar.module.css";

export const QuickSwitcher = memo(function QuickSwitcher({
	anchor,
	queue,
	currentProjectId,
	currentStem,
	onOpen,
	onMove,
	onTrash,
	onViewAll,
	onClose,
}: {
	/** The TopBar menu button the panel is positioned from. */
	anchor: HTMLElement | null;
	/** The global queue; this surface shows its Inbox rows only. */
	queue: SessionInfo[];
	currentProjectId: string | null;
	currentStem: string | null;
	onOpen: (session: SessionInfo) => void;
	onMove: (session: SessionInfo, location: SessionLocation) => void;
	onTrash: (session: SessionInfo) => void;
	/** Hand off to the full switcher. */
	onViewAll: () => void;
	onClose: () => void;
}) {
	// The queue already carries the switcher's order (Inbox first, activity
	// desc), so grouping preserves it; rows of one Project stay together.
	const groups = useMemo(() => quickSwitcherGroups(queue), [queue]);
	const [rowMenuOpen, setRowMenuOpen] = useState(false);

	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			role="dialog"
			label="Session switcher"
			dismissOnEscape={!rowMenuOpen}
			className={styles.quickSwitcher}
		>
			{groups.length === 0 ? (
				<div className={styles.quickEmpty}>Your inbox is empty.</div>
			) : (
				groups.map(([projectId, rows]) => (
					<div key={projectId}>
						<div className={styles.quickGroupLabel}>{projectId}</div>
						{rows.map((session) => (
							<SessionRow
								key={`${session.projectId}/${session.stem}`}
								session={session}
								selected={session.projectId === currentProjectId && session.stem === currentStem}
								onOpen={onOpen}
								onMove={onMove}
								onTrash={onTrash}
								onMenuOpenChange={setRowMenuOpen}
							/>
						))}
					</div>
				))
			)}
			<button type="button" className={styles.quickViewAll} onClick={onViewAll}>
				View all sessions
			</button>
		</Popover>
	);
});
