// The work queue's total order (durable session states) — one comparator
// shared by the Worker that orders its slice and the Daemon that aggregates
// the slices, so a multi-Worker queue interleaves by the same rule instead of
// concatenating per-registration blocks.

import type { SessionInfo, SessionState } from "../core/index.ts";

/** State rank: notified first (the work waiting on the user), busy next (it
 * demotes itself into notified when it lands), deferred last (parked by
 * decision). */
const RANK: Record<SessionState, number> = { inactive: 3, notified: 0, busy: 1, deferred: 2 };

/** A row's activity: its last entry when known, else its durable sort time
 * (an unflushed session's `timestamp` is the header creation). */
const activityOf = (row: SessionInfo): number => {
	const ms = Date.parse(row.lastActivityAt ?? "");
	return Number.isNaN(ms) ? Date.parse(row.timestamp) : ms;
};

/** The work queue's total order: notified → busy → deferred, each group by
 * last activity descending, then the `(project, stem)` address as the
 * tie-break — unique per row, so the order is total and stable. */
export function compareQueueRows(a: SessionInfo, b: SessionInfo): number {
	return (
		RANK[a.state ?? "inactive"] - RANK[b.state ?? "inactive"] ||
		activityOf(b) - activityOf(a) ||
		(a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0) ||
		(a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)
	);
}
