// resolveLatestSession — the `/@latest` alias target (ADR 13).
//
// The most recently active live Session from the global snapshot; with none
// live, the most recent durable Session across Projects (each Project's first
// `listSessions` row, ordered by its durable sort time). The caller opens the
// result, which activates a durable Session. Returns null when no Session
// exists at all.

import type { BridgeClient, ListSessionsReply, ProjectInfo, SessionInfo } from "../../../../src/core/index.ts";
import { sortByLastActivity } from "../lib/sortByLastActivity.ts";

/** A Project's most recent Session (first page row), or null. */
async function firstSession(client: BridgeClient, projectId: string): Promise<SessionInfo | null> {
	const reply = await client.listSessions(projectId, 1);
	if (!reply?.ok) return null;
	return (reply as unknown as ListSessionsReply).sessions?.[0] ?? null;
}

export async function resolveLatestSession(
	client: BridgeClient,
	projects: ProjectInfo[],
	activeSessions: SessionInfo[],
): Promise<SessionInfo | null> {
	const live = sortByLastActivity(activeSessions)[0];
	if (live) return live;

	const rows = await Promise.all(projects.map((project) => firstSession(client, project.id)));
	let best: SessionInfo | null = null;
	for (const row of rows) {
		if (row && (!best || Date.parse(row.timestamp) > Date.parse(best.timestamp))) best = row;
	}
	return best;
}
