// ============================================================================
// timeUtils — session time-bucketing for the sidebar. Pure functions; no DOM,
// no React. The labels themselves live in infra/lib/time.ts: a bucket is only
// the coarse heading, so its boundaries are read from the same classifier that
// writes each row's label. That is what keeps a "This week" header from
// containing a row that says "Nov 3", or a "Today" header from containing
// "yesterday, 23:58".
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";
import { classifyInstant, type InstantKind } from "../../infra/lib/time.ts";

export type GroupLabel = "Today" | "This week" | "Earlier";

const GROUP_OF: Record<InstantKind, GroupLabel> = {
	recent: "Today",
	today: "Today",
	yesterday: "This week",
	thisWeek: "This week",
	older: "Earlier",
};

export function sessionGroup(timestamp: string, now: number): GroupLabel | null {
	const kind = classifyInstant(timestamp, now);
	return kind === null ? null : GROUP_OF[kind];
}

/** Buckets in display order, each sorted newest-first. Unparseable timestamps
 *  are dropped: a row with no readable time has no honest place in the list. */
export function groupSessions(sessions: SessionInfo[], now: number): { label: GroupLabel; items: SessionInfo[] }[] {
	const buckets = new Map<GroupLabel, SessionInfo[]>();
	for (const s of sessions) {
		const g = sessionGroup(s.timestamp, now);
		if (g === null) continue;
		const arr = buckets.get(g) ?? [];
		arr.push(s);
		buckets.set(g, arr);
	}
	const order: GroupLabel[] = ["Today", "This week", "Earlier"];
	return order
		.map((label) => ({
			label,
			items: (buckets.get(label) ?? []).sort(
				(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
			),
		}))
		.filter((g) => g.items.length > 0);
}
