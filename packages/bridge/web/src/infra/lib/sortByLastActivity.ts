// sortByLastActivity — newest-activity-first ordering for the launcher's
// active-session list. Pure presentation: the daemon's snapshot order is not
// meaningful. Rows without a parseable activity time sort last; ties keep
// input order (stable sort), so a refresh never reorders equally-active rows.

import type { SessionInfo } from "../../../../src/core/index.ts";

export function sortByLastActivity(sessions: SessionInfo[]): SessionInfo[] {
	return [...sessions].sort((a, b) => {
		const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : Number.NaN;
		const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : Number.NaN;
		if (Number.isNaN(at)) return Number.isNaN(bt) ? 0 : 1;
		if (Number.isNaN(bt)) return -1;
		return bt - at;
	});
}
