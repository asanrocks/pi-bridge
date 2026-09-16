// ============================================================================
// timeUtils — session time-bucketing + relative timestamps for the sidebar.
// Pure functions; no DOM, no React. Extracted from Sidebar so they're testable
// and reusable (the tree dialog may want them later).
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";

export type GroupLabel = "Today" | "This week" | "Earlier";

const HR12 = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: false });
const WEEKDAY_SHORT = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function sessionGroup(timestamp: string): GroupLabel {
	const d = new Date(timestamp);
	const now = new Date();
	if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
		return "Today";
	}
	const diffMs = now.getTime() - d.getTime();
	if (diffMs < 7 * 86400000) {
		return "This week";
	}
	return "Earlier";
}

export function relativeTime(iso: string): string {
	const d = new Date(iso);
	const now = new Date();
	const diffMs = now.getTime() - d.getTime();
	const group = sessionGroup(iso);
	if (group === "Today") {
		const mins = Math.round(diffMs / 60000);
		if (mins < 1) return "just now";
		if (mins < 60) return `${mins} min ago`;
		return HR12.format(d);
	}
	if (group === "This week") {
		const time = HR12.format(d);
		const yesterday = new Date(now);
		yesterday.setDate(yesterday.getDate() - 1);
		if (
			d.getFullYear() === yesterday.getFullYear() &&
			d.getMonth() === yesterday.getMonth() &&
			d.getDate() === yesterday.getDate()
		) {
			return `yesterday, ${time}`;
		}
		return `${WEEKDAY_SHORT.format(d)}, ${time}`;
	}
	return MONTH_DAY.format(d);
}

export function groupSessions(sessions: SessionInfo[]): { label: GroupLabel; items: SessionInfo[] }[] {
	const buckets = new Map<GroupLabel, SessionInfo[]>();
	for (const s of sessions) {
		const g = sessionGroup(s.timestamp);
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
