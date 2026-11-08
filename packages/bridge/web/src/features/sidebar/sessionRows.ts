// ============================================================================
// sessionRows — a Project folder's rows in the switcher's state order
// (ADR 23): notified → busy → parked (deferred) → inactive. The queue already
// carries the first three in that order (compareQueueRows), so splitting it
// preserves it; inactive rows come from the folder's history page, filtered by
// queue membership so a queued session never renders twice.
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";

export interface ProjectRows {
	/** What the folder's `working` step shows. */
	working: SessionInfo[];
	/** Shown only in the `all` step, after the working rows. */
	parked: SessionInfo[];
	/** The inactive tail: the history page minus everything the queue holds. */
	inactive: SessionInfo[];
}

/** Split one Project's queue rows and (optional) history page into the three
 * render groups. Order within each group is the input order. */
export function splitProjectRows(queueRows: readonly SessionInfo[], historyRows: readonly SessionInfo[]): ProjectRows {
	const working: SessionInfo[] = [];
	const parked: SessionInfo[] = [];
	const queued = new Set<string>();
	for (const row of queueRows) {
		queued.add(row.sessionId);
		if (row.state === "notified" || row.state === "busy") working.push(row);
		else if (row.state === "deferred") parked.push(row);
	}
	const inactive = historyRows.filter((row) => !queued.has(row.sessionId));
	return { working, parked, inactive };
}

/** The count a collapsed folder states: every row it hides. Inactive rows
 * count only once the history page has been fetched — the count never
 * triggers a fetch of its own. */
export function hiddenRowCount(fold: "collapsed" | "working" | "all", rows: ProjectRows): number {
	if (fold === "all") return 0;
	const working = fold === "working" ? 0 : rows.working.length;
	return working + rows.parked.length + rows.inactive.length;
}
