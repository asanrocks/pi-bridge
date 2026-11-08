// ============================================================================
// quickGroups — the compact switcher's rows: the working rows of the global
// work queue (notified and busy), kept in the queue's own order and grouped by
// Project in order of first appearance. Parked and inactive sessions are the
// full switcher's business; this surface answers "what may need me now".
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";

export function quickSwitcherGroups(queue: readonly SessionInfo[]): Array<[string, SessionInfo[]]> {
	const byProject = new Map<string, SessionInfo[]>();
	for (const row of queue) {
		if (row.state !== "notified" && row.state !== "busy") continue;
		const rows = byProject.get(row.projectId);
		if (rows) rows.push(row);
		else byProject.set(row.projectId, [row]);
	}
	return [...byProject];
}
