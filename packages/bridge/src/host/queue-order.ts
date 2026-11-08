// The queue's total order (Inbox, then Later) — one comparator shared by the
// Worker that orders its slice and the Daemon that aggregates the slices, so a
// multi-Worker queue interleaves by the same rule instead of concatenating
// per-registration blocks.

import type { SessionInfo } from "../core/index.ts";

/** Location rank: Inbox first (the user's attention list), Later second
 * (parked by decision). Archived Sessions are not in the queue and never
 * reach this comparator. */
const RANK: Record<SessionInfo["location"], number> = { inbox: 0, later: 1, archive: 2 };

/** A row's activity: its last entry when known, else its durable sort time
 * (an unflushed session's `timestamp` is the header creation). */
const activityOf = (row: SessionInfo): number => {
	const ms = Date.parse(row.lastActivityAt ?? "");
	return Number.isNaN(ms) ? Date.parse(row.timestamp) : ms;
};

/** The queue's total order: Inbox → Later, each group by last activity
 * descending, then the `(project, stem)` address as the tie-break — unique per
 * row, so the order is total and stable. */
export function compareQueueRows(a: SessionInfo, b: SessionInfo): number {
	return (
		RANK[a.location] - RANK[b.location] ||
		activityOf(b) - activityOf(a) ||
		(a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0) ||
		(a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)
	);
}
