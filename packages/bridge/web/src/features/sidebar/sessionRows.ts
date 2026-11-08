// ============================================================================
// sessionRows — a Project folder's rows in the queue's own order (Inbox →
// Later), plus the archived tail. The queue already carries the first two in
// that order (compareQueueRows), so splitting it preserves it; archived rows
// come from the folder's history page, filtered by queue membership so a
// queued session never renders twice.
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";

export interface ProjectRows {
	/** The attention list: what the folder's `inbox` fold step shows. */
	inbox: SessionInfo[];
	/** Parked by decision: shown only in the `all` step, after the Inbox rows. */
	later: SessionInfo[];
	/** The archived tail: the history page minus everything the queue holds. */
	archived: SessionInfo[];
}

/** Split one Project's queue rows and (optional) history page into the three
 * render groups. Order within each group is the input order. */
export function splitProjectRows(queueRows: readonly SessionInfo[], historyRows: readonly SessionInfo[]): ProjectRows {
	const inbox: SessionInfo[] = [];
	const later: SessionInfo[] = [];
	const queued = new Set<string>();
	for (const row of queueRows) {
		queued.add(row.sessionId);
		if (row.location === "inbox") inbox.push(row);
		else if (row.location === "later") later.push(row);
	}
	const archived = historyRows.filter((row) => !queued.has(row.sessionId));
	return { inbox, later, archived };
}

/** The count a collapsed folder states: every row it hides. Archived rows
 * count only once the history page has been fetched — the count never
 * triggers a fetch of its own. */
export function hiddenRowCount(fold: "collapsed" | "inbox" | "all", rows: ProjectRows): number {
	if (fold === "all") return 0;
	const inbox = fold === "inbox" ? 0 : rows.inbox.length;
	return inbox + rows.later.length + rows.archived.length;
}
