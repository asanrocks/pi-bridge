// ============================================================================
// quickGroups — the compact switcher's rows: the global queue's Inbox rows,
// kept in the queue's own order and grouped by Project in order of first
// appearance. Later and archived Sessions are the full switcher's business;
// this surface answers "what may need me now".
// ============================================================================

import type { SessionInfo } from "../../../../src/core/index.ts";

export function quickSwitcherGroups(queue: readonly SessionInfo[]): Array<[string, SessionInfo[]]> {
	const byProject = new Map<string, SessionInfo[]>();
	for (const row of queue) {
		if (row.location !== "inbox") continue;
		const rows = byProject.get(row.projectId);
		if (rows) rows.push(row);
		else byProject.set(row.projectId, [row]);
	}
	return [...byProject];
}
