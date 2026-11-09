// The queue's total order (Inbox, then Later) — one comparator shared by the
// Worker that orders its slice, the Daemon that aggregates the slices, and the
// browser that orders the deltas it receives, so all three interleave by the
// same rule instead of each re-deriving an order.

import type { SessionInfo } from "./types.ts";

/** Location rank: Inbox first (the user's attention list), Later second
 * (parked by decision). Archived Sessions are not in the queue and never
 * reach this comparator. */
const RANK: Record<SessionInfo["location"], number> = { inbox: 0, later: 1, archive: 2 };

/** A row's placement stamp; `""` (older than any ISO instant) for a record
 * written before the store stamped placements. */
const placementOf = (row: SessionInfo): string => row.placedAt ?? "";

/** The queue's total order: Inbox → Later, each group by placement stamp
 * descending (most recently placed first), then the `(project, stem)` address
 * as the tie-break — unique per row, so the order is total and stable.
 *
 * The stamp is a placement event, not activity: a streaming turn advances the
 * row's last activity on every delta, so ordering by it re-sorted the whole
 * queue while the reader was reading it, and a row that merely ran moved above
 * work the user had queued ahead of it. Busy is a temporal state and cannot
 * reorder anything; only a transition (a submission promoting into Inbox, a
 * user move, a restored refusal) changes what this key reads. */
export function compareQueueRows(a: SessionInfo, b: SessionInfo): number {
	const aStamp = placementOf(a);
	const bStamp = placementOf(b);
	return (
		RANK[a.location] - RANK[b.location] ||
		(aStamp === bStamp ? 0 : aStamp < bStamp ? 1 : -1) ||
		(a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0) ||
		(a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)
	);
}
