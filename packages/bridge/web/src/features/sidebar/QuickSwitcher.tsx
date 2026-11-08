// ============================================================================
// QuickSwitcher — the compact session switcher for a narrow viewport (ADR 23).
// The fullscreen switcher costs two full-screen moves per skim: open it, find
// the row, then close it to get back to the session being read. This popover
// shows the work that may need the user — notified and busy rows, grouped by
// Project, in the switcher's order — and hands the full surface off through
// one `View all` row.
//
// Rows are the sidebar's rows (same order, same state control, same preview
// line) without the overflow menu: attention management belongs to the full
// switcher, and a menu inside a popover would be a second anchored panel.
// ============================================================================

import { memo, useMemo } from "react";
import type { SessionInfo } from "../../../../src/core/index.ts";
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
	onSetState,
	onViewAll,
	onClose,
}: {
	/** The TopBar menu button the panel is positioned from. */
	anchor: HTMLElement | null;
	/** The global work queue; this surface shows its working rows only. */
	queue: SessionInfo[];
	currentProjectId: string | null;
	currentStem: string | null;
	onOpen: (session: SessionInfo) => void;
	onSetState: (session: SessionInfo, state: "notified" | "deferred") => void;
	/** Hand off to the full switcher. */
	onViewAll: () => void;
	onClose: () => void;
}) {
	// The queue already carries the switcher's order (notified → busy, activity
	// desc), so grouping preserves it; rows of one Project stay together.
	const groups = useMemo(() => quickSwitcherGroups(queue), [queue]);

	return (
		<Popover
			anchor={anchor}
			onClose={onClose}
			role="dialog"
			label="Session switcher"
			className={styles.quickSwitcher}
		>
			{groups.length === 0 ? (
				<div className={styles.quickEmpty}>Nothing is waiting.</div>
			) : (
				groups.map(([projectId, rows]) => (
					<div key={projectId}>
						<div className={styles.quickGroupLabel}>{projectId}</div>
						{rows.map((session) => (
							<SessionRow
								key={`${session.projectId}/${session.stem}`}
								session={session}
								mark={session.state === "busy" ? "busy" : "notified"}
								selected={session.projectId === currentProjectId && session.stem === currentStem}
								onOpen={onOpen}
								onSetState={session.state === "busy" ? undefined : onSetState}
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
