// sortInstances — newest-activity-first ordering for the launcher's instance
// list. Pure presentation: the daemon sends registry (creation) order; the
// client decides what's on top. Sorting client-side keeps the daemon neutral
// (a future sort control or monitor mode stays a client decision) and needs
// no protocol change — lastActivityAt is already on the wire.

import type { InstanceInfo } from "../../../../src/core/index.ts";

/**
 * Order instances newest-activity-first. Instances without a parseable
 * `lastActivityAt` (no sealed entries yet, or an invalid timestamp) sort
 * last. Ties keep input order (Array.prototype.sort is stable), so the
 * 5s poll refresh never reorders equally-active rows.
 */
export function sortByLastActivity(instances: InstanceInfo[]): InstanceInfo[] {
	return [...instances].sort((a, b) => {
		const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : Number.NaN;
		const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : Number.NaN;
		if (Number.isNaN(at)) return Number.isNaN(bt) ? 0 : 1;
		if (Number.isNaN(bt)) return -1;
		return bt - at;
	});
}
