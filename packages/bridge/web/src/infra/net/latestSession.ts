// resolveLatestSession — the `@latest` alias target (ADR 13, revised by the
// session locations).
//
// The scope comes from the alias's position in the URL: the root form spans
// Projects, a Project's `@latest` resolves inside that Project. Within the
// scope: the most recently active Session in the Inbox. Later is excluded,
// because its own meaning is "not next", and archived history is the fallback
// rather than the alias's target. With no Inbox row in scope, the most recent
// durable Session applies (each in-scope Project's first `listSessions` row,
// ordered by its durable sort time). The caller opens the result, which
// activates a durable Session. Returns null when nothing exists in scope.

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
	queue: SessionInfo[],
	/** The alias's scope: a Project id, or null for the cross-Project form. */
	projectId: string | null = null,
): Promise<SessionInfo | null> {
	const inScope = projectId === null ? queue : queue.filter((row) => row.projectId === projectId);
	const queued = sortByLastActivity(inScope.filter((row) => row.location === "inbox"));
	if (queued.length > 0) return queued[0];

	const ids = projectId === null ? projects.map((project) => project.id) : [projectId];
	const rows = await Promise.all(ids.map((id) => firstSession(client, id)));
	let best: SessionInfo | null = null;
	for (const row of rows) {
		if (row && (!best || Date.parse(row.timestamp) > Date.parse(best.timestamp))) best = row;
	}
	return best;
}
